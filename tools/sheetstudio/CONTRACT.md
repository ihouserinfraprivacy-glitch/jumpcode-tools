<!-- Copyright (c) Microsoft Corporation. All rights reserved. -->
<!-- Licensed under the MIT License. See LICENSE in the project root. -->

# SheetStudio contract

SheetStudio is a self-contained JumpCode tool that reads the project's
spreadsheets and shows the sheet, the numbers and the charts in a Studio beside
the chat. It has three parts that only meet through the files and messages
described here:

1. **Python package** `jumpcode_sheetstudio` (`src/jumpcode_sheetstudio/`): the
   actions the model calls (`actions.py`), argument checks (`arguments.py`), the
   readers (`readers/`: CSV/TSV, XLSX, XLS through `cfb.py`, ODS), the XLSX
   writer (`writers/`), the SQLite store (`store.py`), types (`types.py`),
   analysis (`analysis.py`), cleanup (`cleanup.py`), exports (`export.py`) and
   the Studio files (`views.py`). Standard library only; it runs inside the
   agent's process (no separate engine).
2. **Studio interface** (`src/jumpcode_sheetstudio/ui/app.js` and `app.css`):
   plain JavaScript and CSS, no libraries, no network.
3. **JumpCode host** (outside this folder): generic Studio hosting. It knows
   nothing about spreadsheets; it only moves Studio files and chat messages.

The interface never writes files and never reaches the tool. Every action the
user takes in it becomes a chat message (`ask`) that the model carries out.

## Folders the tool may touch

`run(arguments, context, cancelled=None)` receives a context built by the host:

- `context["studio_root"]`: this Studio's folder. The Studio files and the
  database `data/sheets.db` live here.
- `context["source_root"]`: the conversation's project folder. Spreadsheets are
  read from it by relative path (never outside it, never through a link, never
  written). `export` writes new files into it (default `saida/` next to the
  opened file); an existing name gets ` (2)`, ` (3)`… so nothing is replaced.

The manifest declares `access: {suppliedText: true, projectFiles: true,
network: false}`, so every call goes through the host's tool permission.

## Reading

`readers.open_workbook(path)` detects the format from the content. Delimited
files: encoding (BOM, UTF-8, Windows-1252), separator (`;` `,` tab `|`, the
`sep=` hint), quotes. XLSX: shared/inline strings, styles for dates, 1904 dates,
cached formula values, error cells, hidden and protected sheets. XLS: BIFF8 in a
compound file. ODS: repeated rows and columns, typed values. Password-to-open
files raise `encrypted`; the model is told never to ask for the password.

## The store

Each sheet is imported once into `t_<sheet>` (`_row` = the original row number,
then one typed column per sheet column: dates as `YYYY-MM-DD`, date-times as
`YYYY-MM-DD HH:MM:SS`, times as `HH:MM:SS`, numbers, money and percents as
numbers, sim/não as 0/1, text). A column's type comes from its first 2,000 data
rows, read the Brazilian way (`R$ 1.234,56`, `12,5%`, `dd/mm/aaaa`, `dd/mm/aa`,
ISO), with month-first and decimal dot only when the data says so. Cells read
from text in another form than the rest of their column, cells that do not fit
and formula errors are kept in `issues` and still counted where they could be
read. The file's sha256, size and time are kept; reopening an unchanged file
reuses the import when the effective reading options also match. Explicit options
are saved per sheet, separately from inherited defaults. Reopening or switching
sheets keeps these options and cleanup steps; CSV separator/encoding overrides
are restored before constructing its reader. Changing saved decimal/date defaults
only affects sheets that inherit them. Older imports with recorded options but
no provenance conservatively keep their effective options. Explicit options can
still request a reread; `close` forgets the file and its reading preferences.
File registration and import
commit together; cancellation or read failure restores the previous tables,
steps and metadata, and removes the transient importing state from the UI.

Cleanup steps (`types`, `dedupe`, `trim`, `unify`, `replace`, `fill`,
`remove_rows`, `column`) are stored in order and build `w_<sheet>` from
`t_<sheet>`; undoing a step rebuilds it. Analysis reads `w_` when there is any
step, else `t_`, and every chart records which (`calc.basis`, `calc.steps`). Step
IDs are scoped to each sheet; old databases migrate their primary key without
discarding steps. Import/add/undo advance a separate monotonic sheet `version`,
used by caches and the UI (never inferred from surviving step IDs). Old cached
profiles and scans are invalidated when this version changes.

Cleanup mutations and rebuilding the working table are one transaction. An
undo that would remove a column needed by surviving steps is refused without
changing the table or history; undo the dependents first, or all steps. Missing
SQL identifiers are errors, not string literals. Filters resolve the currently
available columns, including calculated columns; formula division uses real
arithmetic even for integer operands. Inside function calls, commas separate
arguments and dots mark decimals, regardless of whitespace. Legacy decimal
commas remain accepted outside function calls, where there is no ambiguity.
A formula must produce one value, not a list of SELECT expressions.

## Studio files (UTF-8 JSON, written atomically)

| File | Purpose |
| --- | --- |
| `sheet.json` | `status` (`empty`, `importing`, `ready`, `error`), `progress` while importing, `found` (the project's spreadsheets), `files` (opened), `file` (path, format, bytes, modified, sha256, `intact`, meta: encoding, separator, warnings), `sheet`, `sheets`, `basis`, `version` (monotonic data revision), `rowsRaw`, `rows`, `columns` (type, label, filled, empty, unique, min, max, sum, avg, top values, histogram, notes), `steps`. |
| `grid.json` | The rows the Studio shows (up to `gridRows`, default 500): `columns`, `rows` (`[original row, ...values]`), `matched`, `total`, `offset`, `filter`, `sort`, `notes` per row and column for cells read from text, `highlight`. |
| `charts.json` | `charts` (newest first, up to 60): `id` (`g1`…), `kind` (`bar`, `hbar`, `line`, `stacked`, `stacked100`, `grouped`, `heatmap`, `pivot`, `query`), `title`, `labels`, `series` [{name, values}], `unit` (`currency`, `number`, `integer`, `percent`, `count`), `total`, `x`, `y`, `group`, `calc` (`basis`, `steps`, `rowsTotal`, `rowsMatched`, `rowsUsed`, `excluded`, `filter`, `sql`, `readable`), `pivot` or `table`, `question`, `sheet`, `fileName`; and `dashboard` {title, charts, numbers}. |
| `cleanup.json` | `scanned`, `problems` (id, kind, title, column, count, examples before/after, formats, explain, proposal, fix, applied), `fine` (empty cells explained by another column), `steps`, `original` (path, sha256, bytes, modified). |
| `history.json` | `entries` (newest first, up to 200): at, action, title, question, result, rows, basis, version, chart. |
| `settings.json` | `decimal`, `dateOrder`, `csvStyle`, `exportFolder`, `gridRows`. |
| `view.json` | `{schema, revision, view, select, note}`; the interface follows a new `revision` once. Views: sheet, charts, panel, cleanup, history, profile, settings, files. |

## Actions

`run({"action": …}, context)` returns a JSON-able dict with `ok`, a short English
`message` for the model (numbers already in pt-BR form) and the data it needs.
Errors raise `SheetStudioError` with a message that says what to do instead.
Fields that exist in the schema but mean nothing for the action are ignored and
named at the end of the message. Common words for actions, aggregates, groups
and chart kinds (`grafico`, `soma`, `mês`, `barras`) are accepted.

| Action | Arguments | Effect |
| --- | --- | --- |
| `status`, `files` | | What is open, its columns, steps and charts; the project's spreadsheets. |
| `open`, `sheet`, `close` | `path`, `sheet`, `header`, `separator`, `encoding`, `decimal`, `date_order` | Read a file (or another sheet); explicit options or changed defaults trigger a new reading. `close` forgets it in the Studio. |
| `rows` | `filter`, `sort`, `offset`, `limit`, `highlight`, `note` | The rows the Studio shows. |
| `profile` | `column` | Every column described. |
| `chart` | `x`, `by`, `y`, `agg`, `group`, `group_by`, `filter`, `kind`, `top`, `sort`, `title`, `panel` | A chart with its numbers. Filters: `status = concluído e valor > 50`, or a list of `{column, op, value}` (`=`, `!=`, `>`, `>=`, `<`, `<=`, `in`, `contains`, `empty`, `not_empty`). |
| `pivot` | `rows`, `rows_by`, `columns`, `columns_by`, `value`, `agg`, `filter` | A summary table with totals. |
| `query` | `sql`, `title`, `limit` | One read-only SELECT on the view `dados` (the sheet with its column names and `linha`); 20 s limit; only the sheet can be read. |
| `panel`, `remove` | `title`, `charts`, `numbers`; `chart` | The panel; remove charts. |
| `problems`, `fix`, `undo`, `step`, `column` | `which`; `step`; `kind`, `column`, `old`, `new`, `value`, `filter`; `name`, `from`, `part`, `expression`, `type` | Find problems (changes nothing), apply proposals as steps, undo steps, custom steps, calculated columns (date parts or a small formula: column names, numbers, `+ - * /`, comparisons, `round`, `abs`, `iif`…). |
| `export` | `what`, `format`, `chart`, `folder`, `filter`, `style` | New CSV (`br`: `;`, decimal comma, dd/mm/aaaa, BOM; or `plain`), XLSX (the data, plus one sheet per chart with `what` all) or SVG charts. |
| `settings`, `focus` | `decimal`, `date_order`, `style`, `folder`, `limit`; `view`, `select`, `note` | Reading and export defaults; point the Studio. |

Chart series are not silently discarded after the twelfth series. All series
contribute to the table and totals. Numeric charts require numeric values for
min/max; text and date min/max remain available through read-only SQL tables,
with an actionable error if requested as a numeric chart. Direct query exports
use their result table, including numeric cell types, for both CSV and XLSX.

Charts, pivots, profiles and dashboard metrics keep the numeric precision returned
by the calculation; no fixed decimal rounding is applied to their stored data.
Compact labels may use scientific notation for small nonzero values rather than
reporting them as zero. Axis ticks use relative precision too.
CSV export formats the stored number without rounding it to display precision
and preserves seconds in timestamps. This does not recover precision already
lost during source parsing/storage. UI and exported SVG use a zero baseline
and signed scales; positive and negative stacks accumulate separately. A 100%
stack uses the sum of absolute values as its denominator when signs are mixed.

Legacy imports have no recorded reading options. An ordinary first reopen
adopts their existing data rather than erasing cleanup steps; explicit reading
options still request a reimport. Subsequent setting changes are compared to
the adopted options normally.
