# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""The Studio's own copy of each opened sheet: a SQLite database in the Studio's data folder. The original file is
only read (and its hash kept, to show it never changes). Each sheet becomes a typed table (t_<id>) with the
original row numbers; cells read from text, cells that could not be read and error cells are kept as issues;
cleanup steps build a second table (w_<id>) so the original reading always stays available."""

import hashlib
from contextlib import contextmanager
from functools import wraps
import json
from pathlib import Path
import re
import sqlite3
import time
import unicodedata

from . import types
from .common import Cancelled, SheetStudioError

SAMPLE_ROWS = 2000
BATCH = 5000
MAX_COLUMNS = 400
MAX_ISSUES = 300_000


def transactional(method):
    @wraps(method)
    def wrapped(self, *args, **kwargs):
        with self.atomic():
            return method(self, *args, **kwargs)
    return wrapped


def letter(index):
    """1 -> A, 27 -> AA."""
    text = ""
    while index:
        index, rest = divmod(index - 1, 26)
        text = chr(65 + rest) + text
    return text


def fold(text):
    plain = unicodedata.normalize("NFKD", str(text)).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-z0-9]+", "", plain.lower())


def file_digest(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


class Store:
    def __init__(self, studio_root):
        folder = Path(studio_root) / "data"
        folder.mkdir(parents=True, exist_ok=True)
        self.path = folder / "sheets.db"
        self.db = sqlite3.connect(self.path, timeout=15, isolation_level=None, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self._savepoint = 0
        # A missing quoted column must fail, never become a string literal.
        self.db.setconfig(sqlite3.SQLITE_DBCONFIG_DQS_DML, False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=NORMAL")
        self.db.execute("PRAGMA temp_store=MEMORY")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY, path TEXT, format TEXT, bytes INTEGER, modified REAL, sha256 TEXT,
                opened REAL, meta TEXT);
            CREATE TABLE IF NOT EXISTS sheets(id TEXT PRIMARY KEY, file TEXT, name TEXT, position INTEGER, hidden INTEGER, protected INTEGER,
                rows INTEGER, cols INTEGER, imported REAL, header INTEGER, columns TEXT, warnings TEXT, formulas TEXT);
            CREATE TABLE IF NOT EXISTS issues(sheet TEXT, row INTEGER, col TEXT, kind TEXT, detail TEXT, raw TEXT);
            CREATE INDEX IF NOT EXISTS issues_sheet ON issues(sheet, kind, col);
            CREATE TABLE IF NOT EXISTS steps(id TEXT, sheet TEXT, n INTEGER, kind TEXT, spec TEXT, text TEXT, rows INTEGER, at REAL, PRIMARY KEY(sheet, id));
            CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY, value TEXT);
        """)
        if sum(bool(row["pk"]) for row in self.db.execute("PRAGMA table_info(steps)")) == 1:
            with self.atomic():
                self.db.execute("ALTER TABLE steps RENAME TO steps_legacy")
                self.db.execute("CREATE TABLE steps(id TEXT, sheet TEXT, n INTEGER, kind TEXT, spec TEXT, text TEXT, rows INTEGER, at REAL, PRIMARY KEY(sheet, id))")
                self.db.execute("INSERT INTO steps SELECT * FROM steps_legacy")
                self.db.execute("DROP TABLE steps_legacy")

    @contextmanager
    def atomic(self):
        """Nestable transactions, including schema changes, leave the previous view intact on failure."""
        self._savepoint += 1
        name = f"sheet_{self._savepoint}"
        self.db.execute(f"SAVEPOINT {name}")
        try:
            yield
        except BaseException:
            self.db.execute(f"ROLLBACK TO {name}")
            raise
        finally:
            self.db.execute(f"RELEASE {name}")

    def close(self):
        try:
            self.db.close()
        except sqlite3.Error:
            pass

    # ------------------------------------------------------------ state
    def get(self, key, default=None):
        row = self.db.execute("SELECT value FROM state WHERE key=?", (key,)).fetchone()
        return json.loads(row["value"]) if row else default

    def put(self, key, value):
        self.db.execute("INSERT OR REPLACE INTO state(key, value) VALUES(?, ?)", (key, json.dumps(value, ensure_ascii=False, default=str)))

    # ------------------------------------------------------------ files and sheets
    def files(self):
        return [dict(row) | {"meta": json.loads(row["meta"] or "{}")} for row in self.db.execute("SELECT * FROM files ORDER BY opened DESC")]

    def file(self, file_id):
        row = self.db.execute("SELECT * FROM files WHERE id=?", (file_id,)).fetchone()
        return dict(row) | {"meta": json.loads(row["meta"] or "{}")} if row else None

    def sheets(self, file_id=None):
        query = "SELECT * FROM sheets" + (" WHERE file=?" if file_id else "") + " ORDER BY file, position"
        return [self._sheet(row) for row in self.db.execute(query, (file_id,) if file_id else ())]

    def sheet(self, sheet_id):
        row = self.db.execute("SELECT * FROM sheets WHERE id=?", (sheet_id,)).fetchone()
        return self._sheet(row) if row else None

    @staticmethod
    def _sheet(row):
        value = dict(row)
        value["columns"] = json.loads(value["columns"] or "[]")
        value["warnings"] = json.loads(value["warnings"] or "[]")
        value["formulas"] = json.loads(value["formulas"] or "{}")
        return value

    def active(self):
        """(file, sheet) the Studio shows, or (None, None)."""
        current = self.get("active") or {}
        sheet = self.sheet(current.get("sheet")) if current.get("sheet") else None
        if sheet is None:
            return None, None
        return self.file(sheet["file"]), sheet

    def set_active(self, sheet_id):
        self.put("active", {"sheet": sheet_id})

    def forget_file(self, file_id):
        for sheet in self.sheets(file_id):
            self.drop_sheet_tables(sheet["id"])
            self.db.execute("DELETE FROM issues WHERE sheet=?", (sheet["id"],))
            self.db.execute("DELETE FROM steps WHERE sheet=?", (sheet["id"],))
        self.db.execute("DELETE FROM sheets WHERE file=?", (file_id,))
        self.db.execute("DELETE FROM files WHERE id=?", (file_id,))

    def drop_sheet_tables(self, sheet_id):
        self.db.execute(f'DROP TABLE IF EXISTS "t_{sheet_id}"')
        self.db.execute(f'DROP TABLE IF EXISTS "w_{sheet_id}"')

    def register_file(self, rel, path, workbook):
        """Records the file (hash, size, sheets); keeps imported sheets when the file did not change."""
        info = Path(path).stat()
        digest = file_digest(path)
        file_id = hashlib.sha1(rel.lower().encode("utf-8")).hexdigest()[:10]
        old = self.file(file_id)
        if old and old["sha256"] != digest:
            self.forget_file(file_id)
            old = None
        meta = {k: v for k, v in (workbook.meta or {}).items() if k in ("encoding", "separator", "quote", "lineEnding", "date1904", "warnings")}
        self.db.execute("INSERT OR REPLACE INTO files(id, path, format, bytes, modified, sha256, opened, meta) VALUES(?,?,?,?,?,?,?,?)",
                        (file_id, rel, workbook.format, info.st_size, info.st_mtime, digest, time.time(), json.dumps(meta, ensure_ascii=False, default=str)))
        for position, sheet in enumerate(workbook.sheets):
            sheet_id = hashlib.sha1(f"{file_id}:{sheet.name}".encode("utf-8")).hexdigest()[:10]
            if not self.sheet(sheet_id):
                self.db.execute("INSERT INTO sheets(id, file, name, position, hidden, protected, rows, cols, imported, header, columns, warnings, formulas)"
                                " VALUES(?,?,?,?,?,?,?,?,NULL,NULL,'[]','[]','{}')",
                                (sheet_id, file_id, sheet.name, position, int(bool(sheet.hidden)), int(bool(sheet.protected)), sheet.rows, sheet.cols))
        return self.file(file_id), bool(old)

    # ------------------------------------------------------------ importing one sheet
    @transactional
    def import_sheet(self, sheet_id, workbook, options=None, progress=None, cancelled=None):
        """Reads the sheet into t_<id> with a type per column. options: header (None = detect), decimal, order."""
        options = options or {}
        sheet = self.sheet(sheet_id)
        rows = workbook.rows(sheet["name"])
        number = 0
        head = None
        buffer = []
        for values in rows:
            number += 1
            if head is None:
                if not any(v is not None and str(v).strip() for v in values):
                    continue
                head = (number, values)
                continue
            buffer.append((number, values))
            if len(buffer) >= SAMPLE_ROWS:
                break
        if head is None:
            raise SheetStudioError(f"The sheet {sheet['name']} is empty.")
        first_row, first = head
        header = options.get("header")
        if header is None:
            header = self._looks_like_header(first, [v for _, v in buffer[:200]])
        data = buffer if header else [head] + buffer
        width = min(MAX_COLUMNS, max([len(first)] + [len(v) for _, v in data] or [1]))
        names = self._names(first if header else [], width)
        columns = []
        for index in range(width):
            sample = [v[index] if index < len(v) else None for _, v in data]
            guess = types.infer(names[index], sample, options.get("decimal", "auto"), options.get("order", "auto"))
            columns.append({"key": f"c{index + 1}", "name": names[index], "letter": letter(index + 1), **guess})
        self.drop_sheet_tables(sheet_id)
        self.db.execute("DELETE FROM issues WHERE sheet=?", (sheet_id,))
        self.db.execute("DELETE FROM steps WHERE sheet=?", (sheet_id,))
        definition = ", ".join(f'"{c["key"]}" {types.sql_type(c["type"])}' for c in columns)
        self.db.execute(f'CREATE TABLE "t_{sheet_id}" (_row INTEGER PRIMARY KEY, {definition})')
        convert = [types.converter(c) for c in columns]
        # In CSV and TSV every cell is text: the format most cells of a column use is its normal form, and only
        # cells written another way (R$ 45,00 among 45,00; 2026-01-05 among 05/01/2026) are notes.
        if workbook.format in ("csv", "tsv"):
            for index, column in enumerate(columns):
                labels = {}
                for _, values in data:
                    raw = values[index] if index < len(values) else None
                    issue = convert[index](raw)[1]
                    if issue is not None and issue[0] in ("text-date", "text-number", "text-time"):
                        labels[issue[1]] = labels.get(issue[1], 0) + 1
                if labels:
                    column["native"] = max(labels, key=labels.get)
        natives = [c.get("native") for c in columns]
        insert = f'INSERT INTO "t_{sheet_id}" VALUES ({", ".join("?" * (width + 1))})'
        issues = []
        issue_count = 0
        extra = 0
        batch = []
        started = time.time()
        last_report = started
        total = sheet["rows"]

        def flush():
            nonlocal batch, issues
            if batch:
                self.db.executemany(insert, batch)
            if issues:
                self.db.executemany("INSERT INTO issues(sheet, row, col, kind, detail, raw) VALUES(?,?,?,?,?,?)", issues)
            batch, issues = [], []

        def add(row_number, values):
            nonlocal issue_count, extra
            record = [row_number]
            empty = True
            for index in range(width):
                raw = values[index] if index < len(values) else None
                stored, issue = convert[index](raw)
                if stored is not None:
                    empty = False
                if issue is not None and issue[0] in ("text-date", "text-number", "text-time") and issue[1] == natives[index]:
                    issue = None
                if issue is not None:
                    empty = False
                    if issue_count < MAX_ISSUES:
                        issues.append((sheet_id, row_number, columns[index]["key"], issue[0], issue[1], types.as_text(raw)))
                    issue_count += 1
                record.append(stored)
            if len(values) > width and any(v is not None for v in values[width:]):
                extra += 1
            if not empty:
                batch.append(record)

        for row_number, values in data:
            add(row_number, values)
        count = len(data)
        for values in rows:
            number += 1
            add(number, values)
            count += 1
            if len(batch) >= BATCH:
                flush()
                now = time.time()
                if cancelled is not None and cancelled():
                    raise Cancelled("The import was cancelled; the previous reading was preserved.")
                if progress is not None and now - last_report > 0.8:
                    last_report = now
                    progress(count, total)
        flush()
        if cancelled is not None and cancelled():
            raise Cancelled("The import was cancelled; the previous reading was preserved.")
        rows_total = self.db.execute(f'SELECT COUNT(*) FROM "t_{sheet_id}"').fetchone()[0]
        for column in columns:
            if column["type"] == "text" and not types.IDENTITY_NAMES.search(column["name"]):
                distinct, filled = self.db.execute(f'SELECT COUNT(DISTINCT "{column["key"]}"), COUNT("{column["key"]}") FROM "t_{sheet_id}"').fetchone()
                if filled >= 20 and distinct <= max(12, min(60, filled * 0.02)):
                    column["type"] = "category"
            column["label"] = types.LABELS[column["type"]]
        warnings = list(sheet["warnings"])
        if extra:
            warnings.append(f"{extra} rows have more cells than the header; the extra cells were ignored")
        if issue_count > MAX_ISSUES:
            warnings.append(f"only the first {MAX_ISSUES} cell notes were kept")
        try:
            formulas = {f"{letter(c)}{r}": text for (r, c), text in list(workbook.formulas(sheet["name"]).items())[:5000]}
        except Exception:  # formulas are a bonus; a reader that cannot list them must not stop the import
            formulas = {}
        self.db.execute("UPDATE sheets SET imported=?, header=?, columns=?, warnings=?, formulas=?, rows=? WHERE id=?",
                        (time.time(), first_row if header else 0, json.dumps(columns, ensure_ascii=False), json.dumps(warnings, ensure_ascii=False),
                         json.dumps(formulas, ensure_ascii=False), rows_total, sheet_id))
        self.put(f"reading:{sheet_id}", options)
        self._revision(sheet_id)
        if progress is not None:
            progress(rows_total, rows_total)
        return self.sheet(sheet_id), round(time.time() - started, 2)

    @staticmethod
    def _looks_like_header(first, sample):
        cells = [v for v in first if v is not None and str(v).strip()]
        if not cells or any(not isinstance(v, str) for v in cells):
            return False
        if len(set(fold(v) for v in cells)) < len(cells):
            return False
        for value in cells:
            if types.number_from_text(value) is not None or types.date_from_text(value) is not None or len(value) > 60:
                return False
        # Unique short labels with no number or date among them: a header (the header option overrides it).
        return True

    @staticmethod
    def _names(first, width):
        names, seen = [], set()
        for index in range(width):
            raw = first[index] if index < len(first) else None
            name = re.sub(r"\s+", " ", types.as_text(raw)).strip() if raw is not None else ""
            name = name or f"coluna {letter(index + 1)}"
            base, counter = name, 2
            while fold(name) in seen:
                name = f"{base} ({counter})"
                counter += 1
            seen.add(fold(name))
            names.append(name)
        return names

    # ------------------------------------------------------------ columns and the table to read
    def columns(self, sheet_id, basis="auto"):
        sheet = self.sheet(sheet_id)
        columns = list(sheet["columns"])
        if self.basis(sheet_id, basis) == "clean":
            for step in self.steps(sheet_id):
                if step["kind"] == "column":
                    columns.append(step["spec"]["column"])
        return columns

    def basis(self, sheet_id, basis="auto"):
        if basis == "raw":
            return "raw"
        has_steps = self.db.execute("SELECT 1 FROM steps WHERE sheet=? LIMIT 1", (sheet_id,)).fetchone() is not None
        return "clean" if has_steps else "raw"

    def table(self, sheet_id, basis="auto"):
        return f'"w_{sheet_id}"' if self.basis(sheet_id, basis) == "clean" else f'"t_{sheet_id}"'

    def count(self, sheet_id, basis="auto"):
        return self.db.execute(f"SELECT COUNT(*) FROM {self.table(sheet_id, basis)}").fetchone()[0]

    def resolve(self, sheet_id, name, basis="auto", kinds=None):
        """The column a name means: exact, then without case and accents, then its letter, then a unique prefix."""
        columns = self.columns(sheet_id, basis)
        if not isinstance(name, str) or not name.strip():
            raise SheetStudioError("A column name is missing.")
        text = name.strip().strip('"').strip("'")
        wanted = fold(text)
        found = [c for c in columns if c["name"] == text] or [c for c in columns if fold(c["name"]) == wanted]
        if not found and re.fullmatch(r"[A-Za-z]{1,3}", text):
            found = [c for c in columns if c["letter"] == text.upper()]
        if not found and wanted:
            found = [c for c in columns if fold(c["name"]).startswith(wanted)] or [c for c in columns if wanted in fold(c["name"])]
        if len(found) != 1:
            names = ", ".join(c["name"] for c in columns)
            raise SheetStudioError(f"No single column matches {text!r}. The columns are: {names}.")
        column = found[0]
        if kinds and column["type"] not in kinds:
            raise SheetStudioError(f"Column {column['name']} is {types.LABELS[column['type']]}; this needs {' or '.join(types.LABELS[k] for k in kinds)}.")
        return column

    # ------------------------------------------------------------ cleanup steps
    def steps(self, sheet_id):
        return [dict(row) | {"spec": json.loads(row["spec"])} for row in self.db.execute("SELECT * FROM steps WHERE sheet=? ORDER BY n", (sheet_id,))]

    def _bump(self, sheet_id):
        number = int(self.get(f"stepseq:{sheet_id}", 0)) + 1
        self.put(f"stepseq:{sheet_id}", number)
        self._revision(sheet_id)
        return number

    def _revision(self, sheet_id):
        self.put(f"revision:{sheet_id}", self.version(sheet_id) + 1)
        # Retain only the current cached profile/scan, not every historical generation.
        for prefix in (f"profile:{sheet_id}:", f"scan:{sheet_id}:"):
            self.db.execute("DELETE FROM state WHERE key LIKE ?", (prefix + "%",))

    def add_step(self, sheet_id, kind, spec, text):
        n = self._bump(sheet_id)
        step_id = f"p{n}"
        self.db.execute("INSERT INTO steps(id, sheet, n, kind, spec, text, rows, at) VALUES(?,?,?,?,?,?,0,?)",
                        (step_id, sheet_id, n, kind, json.dumps(spec, ensure_ascii=False, default=str), text, time.time()))
        return step_id

    def remove_steps(self, sheet_id, step_ids):
        for step_id in step_ids:
            self.db.execute("DELETE FROM steps WHERE sheet=? AND id=?", (sheet_id, step_id))
        if step_ids:
            self._bump(sheet_id)

    @transactional
    def rebuild(self, sheet_id, apply_step):
        """Builds w_<id> from t_<id> by applying every step in order; apply_step(db, table, step) returns rows affected."""
        self.db.execute(f'DROP TABLE IF EXISTS "w_{sheet_id}"')
        steps = self.steps(sheet_id)
        if not steps:
            return []
        self.db.execute(f'CREATE TABLE "w_{sheet_id}" AS SELECT * FROM "t_{sheet_id}"')
        results = []
        for step in steps:
            try:
                affected = apply_step(self.db, f'"w_{sheet_id}"', step)
            except sqlite3.OperationalError as error:
                raise SheetStudioError(f"Cannot apply step {step['id']} ({step['text']}). Keep the columns it depends on, or undo the dependent steps together.") from error
            self.db.execute("UPDATE steps SET rows=? WHERE id=? AND sheet=?", (affected, step["id"], sheet_id))
            results.append((step["id"], affected))
        return results

    def version(self, sheet_id):
        """Grows on import, add and undo; independent of the IDs of surviving steps."""
        return int(self.get(f"revision:{sheet_id}", self.get(f"stepseq:{sheet_id}", 0)))
