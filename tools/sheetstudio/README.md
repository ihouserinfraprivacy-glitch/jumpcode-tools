<!-- Copyright (c) Microsoft Corporation. All rights reserved. -->
<!-- Licensed under the MIT License. See LICENSE in the project root. -->

# SheetStudio

SheetStudio is a JumpCode tool that reads the project's spreadsheets on the
user's computer and shows the sheet and the charts in a Studio beside the chat.
The user asks in the chat ("qual serviço mais fatura?", "faça um gráfico do
faturamento por mês"); the agent calls the tool, and the numbers and the chart
appear in the Studio with what was computed: the columns, the filter, the rows
used and the rows left out.

## Files it reads

CSV and TSV (separator, quotes, encoding and the `sep=;` hint detected; UTF-8,
UTF-16 and Windows-1252), XLSX/XLSM, XLS (BIFF8) and ODS, with their sheets.
Everything is read with the Python standard library; nothing is downloaded or
sent anywhere. Password-protected files are refused with a message (the agent
never asks for the password). Formulas are not recalculated: the value Excel
saved is used, and error cells (`#REF!`, `#DIV/0!`…) are explained.

## How the data is kept

Each sheet is imported once into the Studio's own SQLite database
(`data/sheets.db` in the Studio folder) with one type per column, read the
Brazilian way (`R$ 1.234,56`, `12,5%`, `dd/mm/aaaa`, `dd/mm/aa`, ISO dates). The
original file is only read, and its hash is kept. Cells written differently
from the rest of their column are recorded as notes and still counted.

Cleanup never edits the original reading: fixes (dates and numbers written as
text, repeated rows, extra spaces, spellings of a category, replacements,
filled cells, removed rows, calculated columns) are steps that build a clean
table, and any step can be undone.

## What the agent can do

`files`, `open`, `sheet`, `close`, `status`; `chart` (bar, hbar, line, stacked,
stacked100, grouped, heatmap; dates grouped by month, weekday, hour, day, week,
quarter or year), `pivot`, `profile`, `rows`, `query` (one read-only SELECT on
the table `dados`); `problems`, `fix`, `undo`, `step`, `column`; `panel`,
`remove`, `export` (CSV, XLSX with the numbers of each chart, SVG charts; always
new files), `settings` and `focus`.

## Development

```
python -m unittest discover -s tests      # readers, writer, types and actions
python ui-dev/scenario.py                 # regenerate ui-dev/fixtures/barbearia
node ui-dev/serve.mjs                     # the Studio in a browser with a fake host
```

See [CONTRACT.md](CONTRACT.md) for the files, the actions and the limits.
