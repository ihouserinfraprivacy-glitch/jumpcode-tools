# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""The actions the model calls: list and open spreadsheets of the project, show rows, make charts, pivot tables
and profiles, run read-only SQL, find and fix data problems as undoable steps, add calculated columns, build a
panel, export new files and point the Studio. Each result gives the model the numbers to quote."""

import time
from pathlib import Path

from . import analysis, cleanup, export, types, views
from .arguments import ignored_fields
from .common import SheetStudioError, find_sheets, project_file, relative_name, slug, source_root, studio_root
from .store import Store, fold

VIEWS = ("sheet", "charts", "panel", "cleanup", "history", "profile", "settings", "files")


def run(arguments, context, cancelled=None):
    if cancelled is not None and cancelled():
        raise SheetStudioError("The operation was cancelled.")
    root = studio_root(context)
    ignored = ignored_fields(arguments)
    store = Store(root)
    try:
        result = ACTIONS[arguments["action"]](root, context, store, {k: v for k, v in arguments.items() if k not in ignored}, cancelled)
    finally:
        store.close()
    if ignored:
        result["message"] = f"{result.get('message', '')} (Ignored for {arguments['action']}: {', '.join(ignored)}.)".strip()
    return result


def _active(store):
    file, sheet = store.active()
    if sheet is None or not sheet["imported"]:
        raise SheetStudioError("No spreadsheet is open. Call files to list the project's spreadsheets, then open with the path.")
    return file, sheet


def _project(context):
    return source_root(context)


def _columns_text(columns):
    return "; ".join(f"{c['name']} ({types.LABELS[c['type']]})" for c in columns)


# ---------------------------------------------------------------- what is there

def status(root, context, store, arguments, cancelled):
    file, sheet = store.active()
    project = _project(context)
    if sheet is None or not sheet["imported"]:
        found = find_sheets(project) if project else []
        views.flush(store, root, project, found=found)
        listing = ", ".join(f["path"] for f in found[:15])
        return {"ok": True, "open": False, "files": found[:30],
                "message": "No spreadsheet is open. " + (f"The project has: {listing}. Call open with the path." if found else
                                                         "The project has no CSV, TSV, XLSX, XLS or ODS file; ask the user which file to open.")}
    views.flush(store, root, project)
    steps = store.steps(sheet["id"])
    charts = [c for c in store.get("charts", []) if c.get("sheet") == sheet["id"]]
    return {"ok": True, "open": True, "file": file["path"], "sheet": sheet["name"], "rows": store.count(sheet["id"]), "basis": store.basis(sheet["id"]),
            "columns": [{"name": c["name"], "type": c["type"]} for c in store.columns(sheet["id"])], "sheets": [s["name"] for s in store.sheets(file["id"])],
            "steps": [s["text"] for s in steps], "charts": [{"id": c["id"], "title": c["title"]} for c in charts[:10]],
            "message": f"Open: {file['path']}, sheet {sheet['name']}, {types.number(store.count(sheet['id']))} rows"
                       + (" (clean view, " + str(len(steps)) + " steps)" if steps else "") + f". Columns: {_columns_text(store.columns(sheet['id']))}."}


def files(root, context, store, arguments, cancelled):
    project = source_root(context, required=True)
    found = find_sheets(project)
    views.flush(store, root, project, parts=("sheet",), found=found)
    views.focus(root, "files")
    if not found:
        return {"ok": True, "files": [], "message": "The project has no CSV, TSV, XLSX, XLS or ODS file. Ask the user to put the spreadsheet in the project folder."}
    return {"ok": True, "files": found, "message": f"{len(found)} spreadsheets: " + ", ".join(f"{f['path']} ({types.number(f['bytes'] / 1024, 0)} KB)" for f in found[:20])}


# ---------------------------------------------------------------- opening

def _workbook(path, arguments, cancelled):
    from .readers import SheetFormatError, open_workbook
    try:
        return open_workbook(path, encoding=arguments.get("encoding"), separator=arguments.get("separator"), cancelled=cancelled)
    except SheetFormatError as error:
        failure = SheetStudioError(str(error))
        failure.kind = getattr(error, "kind", None)
        raise failure from error


_READING_KEYS = {"header": "header", "decimal": "decimal", "order": "date_order", "separator": "separator", "encoding": "encoding"}


def _reading_options(root, arguments, previous=None):
    """File overrides survive reopen; only inherited options follow the Studio defaults."""
    settings = views.settings(root)
    options = {"header": None, "decimal": settings["decimal"], "order": settings["dateOrder"], "separator": None, "encoding": None}
    if previous is None:
        overrides = {}
    elif "overrides" in previous:
        overrides = dict(previous["overrides"])
    else:
        # Old imports did not record provenance. Preserve their effective choices on migration.
        overrides = {key: previous[key] for key in _READING_KEYS if previous.get(key) is not None}
    overrides.update({key: arguments[arg] for key, arg in _READING_KEYS.items() if arguments.get(arg) is not None})
    return {**options, **overrides, "overrides": overrides}


def _select_sheet(sheets, wanted):
    if wanted:
        return next((s for s in sheets if s["name"] == wanted), None) or next((s for s in sheets if fold(s["name"]) == fold(wanted)), None)
    return next((s for s in sheets if not s["hidden"]), sheets[0] if sheets else None)


def _import(root, store, file, sheet, workbook, options, cancelled):
    started = time.time()
    views.progress_file(root, file["path"], 0, sheet["rows"], started)
    imported, seconds = store.import_sheet(sheet["id"], workbook, options,
                                           progress=lambda rows, total: views.progress_file(root, file["path"], rows, total, started), cancelled=cancelled)
    return imported, seconds


def open_(root, context, store, arguments, cancelled):
    project = source_root(context, required=True)
    path = project_file(project, arguments.get("path"))
    if not path.is_file():
        found = find_sheets(project)
        near = [f["path"] for f in found if Path(f["path"]).name.lower() == path.name.lower()]
        raise SheetStudioError(f"{arguments.get('path')} was not found." + (f" Did you mean {near[0]}?" if near else
                               f" The spreadsheets are: {', '.join(f['path'] for f in found[:15])}." if found else ""))
    rel = relative_name(project, path)
    previous_file = next((f for f in store.files() if f["path"].casefold() == rel.casefold()), None)
    previous_sheet = _select_sheet(store.sheets(previous_file["id"]), arguments.get("sheet")) if previous_file else None
    reader_options = _reading_options(root, arguments, store.get(f"reading:{previous_sheet['id']}") if previous_sheet else None)
    try:
        workbook = _workbook(path, reader_options, cancelled)
    except SheetStudioError as error:
        # The Studio shows why the file could not be read (password, unknown format...), not only the chat.
        views.sheet_file(store, root, project, error={"path": rel, "kind": getattr(error, "kind", None), "message": str(error)})
        views.focus(root, "files")
        raise
    try:
        with store.atomic():
            file, kept = store.register_file(rel, path, workbook)
            sheets = store.sheets(file["id"])
            wanted = arguments.get("sheet")
            sheet = _select_sheet(sheets, wanted)
            if sheet is None:
                raise SheetStudioError(f"There is no sheet {wanted!r}; the sheets are: {', '.join(s['name'] for s in sheets)}.")
            reading_key = f"reading:{sheet['id']}"
            # close forgets the file; detached state from an earlier import is not an active preference.
            previous_options = store.get(reading_key) if previous_file else None
            options = _reading_options(root, arguments, previous_options)
            explicit_options = any(arguments.get(k) is not None for k in _READING_KEYS.values())
            if previous_options is None and sheet["imported"] and not explicit_options:
                # Older imports did not record options. Adopt them once without erasing their cleanup work.
                store.put(reading_key, options)
                previous_options = options
            reimport = explicit_options or previous_options is None or any(previous_options.get(k) != options[k] for k in _READING_KEYS)
            seconds = 0
            if not sheet["imported"] or reimport:
                sheet, seconds = _import(root, store, file, sheet, workbook, options, cancelled)
            else:
                store.put(reading_key, options)
            store.set_active(sheet["id"])
            store.put("grid", {"sheet": sheet["id"]})
    except BaseException:
        # The transaction is already rolled back, including any changed-file registration.
        views.flush(store, root, project)
        raise
    finally:
        workbook.close()
    views.flush(store, root, project)
    views.focus(root, "sheet")
    columns = store.columns(sheet["id"])
    notes = {}
    for row in store.db.execute("SELECT kind, COUNT(*) AS n FROM issues WHERE sheet=? GROUP BY kind", (sheet["id"],)):
        notes[row["kind"]] = row["n"]
    meta = file["meta"]
    how = f" Read as {workbook.format.upper()}" + (f", separator {meta.get('separator')!r}, {meta.get('encoding')}" if meta.get("separator") else "") + "."
    others = [s["name"] for s in store.sheets(file["id"]) if s["id"] != sheet["id"]]
    found_notes = []
    if notes.get("text-date"):
        found_notes.append(f"{notes['text-date']} dates written as text (read as dates)")
    if notes.get("text-number"):
        found_notes.append(f"{notes['text-number']} numbers written as text (read as numbers)")
    if notes.get("unparsed"):
        found_notes.append(f"{notes['unparsed']} cells that do not fit their column")
    if notes.get("error"):
        found_notes.append(f"{notes['error']} formula error cells")
    return {"ok": True, "file": rel, "sheet": sheet["name"], "rows": store.count(sheet["id"]), "columns": [{"name": c["name"], "type": c["type"]} for c in columns],
            "sheets": [s["name"] for s in store.sheets(file["id"])], "seconds": seconds, "notes": notes,
            "message": f"Opened {rel}" + (f", sheet {sheet['name']}" if others or arguments.get("sheet") else "") + f": {types.number(store.count(sheet['id']))} rows."
                       + how + f" Columns: {_columns_text(columns)}." + (f" Other sheets: {', '.join(others)}." if others else "")
                       + (f" Found: {'; '.join(found_notes)}; call problems to see them." if found_notes else "")
                       + " The original file is only read. Now answer the user or make the chart they asked for."}


def sheet(root, context, store, arguments, cancelled):
    file, current = store.active()
    if file is None:
        raise SheetStudioError("No spreadsheet is open; call open first.")
    if arguments.get("path"):
        return open_(root, context, store, arguments, cancelled)
    return open_(root, context, store, {"path": file["path"], "sheet": arguments.get("sheet")}, cancelled)


def close(root, context, store, arguments, cancelled):
    file, sheet = store.active()
    if file is None:
        return {"ok": True, "message": "Nothing is open."}
    store.forget_file(file["id"])
    store.put("active", {})
    store.put("charts", [c for c in store.get("charts", []) if c.get("file") != file["id"]])
    views.flush(store, root, _project(context))
    return {"ok": True, "message": f"Closed {file['path']} in the Studio (the file itself was not touched)."}


# ---------------------------------------------------------------- looking at the data

def rows(root, context, store, arguments, cancelled):
    file, sheet = _active(store)
    spec = {"sheet": sheet["id"], "filter": arguments.get("filter"), "sort": arguments.get("sort"), "offset": arguments.get("offset") or 0,
            "highlight": arguments.get("highlight")}
    data = analysis.rows(store, sheet["id"], spec, limit=min(int(arguments.get("limit") or 500), 2000))
    store.put("grid", spec)
    views.flush(store, root, _project(context), parts=("grid",))
    views.focus(root, "sheet", None, arguments.get("note") or "")
    columns = data["columns"]
    sample = [", ".join(f"{c['name']}={types.show(v, c['type'])}" for c, v in zip(columns, row[1:]) if v is not None) for row in data["rows"][:8]]
    views.remember(store, {"action": "rows", "title": "Filtrar a tabela" if arguments.get("filter") else "Mostrar linhas", "question": arguments.get("question"),
                           "result": f"{types.number(data['matched'])} linhas", "rows": data["matched"], "basis": data["basis"], "version": store.version(sheet["id"])})
    views.flush(store, root, parts=("history",))
    return {"ok": True, "matched": data["matched"], "total": data["total"], "filter": data["filter"], "first": sample,
            "message": f"The Studio shows {types.number(data['matched'])} of {types.number(data['total'])} rows"
                       + (f" where {' and '.join(data['filter'])}" if data["filter"] else "") + ". First rows: " + " | ".join(sample[:5])}


def profile(root, context, store, arguments, cancelled):
    file, sheet = _active(store)
    data = analysis.profile(store, sheet["id"])
    store.put(f"profile:{sheet['id']}:{store.version(sheet['id'])}", data)
    views.flush(store, root, _project(context), parts=("sheet",))
    views.focus(root, "profile", arguments.get("column"))
    lines = []
    for c in data["columns"]:
        if arguments.get("column") and analysis.fold(c["name"]) != analysis.fold(arguments["column"]):
            continue
        text = f"{c['name']} ({c['label']}): {types.number(c['filled'])} filled, {types.number(c['empty'])} empty, {types.number(c['unique'])} unique"
        if c["type"] in types.NUMERIC + types.TEMPORAL and c["min"] is not None:
            text += f", from {types.show(c['min'], c['type'])} to {types.show(c['max'], c['type'])}"
        if c.get("top"):
            text += ", most common: " + ", ".join(f"{v} ({n})" for v, n in c["top"][:4])
        lines.append(text)
    views.remember(store, {"action": "profile", "title": "Perfil das colunas", "question": arguments.get("question"), "result": f"{len(data['columns'])} colunas",
                           "rows": data["rows"], "basis": data["basis"], "version": store.version(sheet["id"])})
    views.flush(store, root, parts=("history",))
    return {"ok": True, "rows": data["rows"], "message": f"{types.number(data['rows'])} rows. " + " | ".join(lines)}


def chart(root, context, store, arguments, cancelled):
    file, sheet = _active(store)
    spec = {k: arguments.get(k) for k in ("x", "by", "y", "agg", "group", "group_by", "filter", "kind", "top", "sort", "title")}
    if not spec["x"] and not spec["y"]:
        raise SheetStudioError("chart needs x (the column for the groups, such as data with by month, or serviço) and usually y (the number column) with agg.")
    if spec["group_by"] and not spec["group"]:
        # Small models put the grouping of x in group_by ("data day"); without a group it can only mean by. When the
        # title or the user's question names another grouping ("por mês"), the user's words win.
        moved, spec["group_by"] = spec["group_by"], None
        named = analysis.bucket_word(arguments.get("question")) or analysis.bucket_word(spec.get("title"))
        spec["by"] = spec["by"] or (named if named and named != analysis.bucket_word(moved) else moved)
    if spec["x"] and not spec["by"]:
        column = store.resolve(sheet["id"], spec["x"])
        if column["type"] in ("date", "datetime"):
            spec["by"] = _date_grouping(store, sheet["id"], column, spec.get("title"), arguments.get("question"))
    data = analysis.compute(store, sheet["id"], spec)
    data.update({"sheet": sheet["id"], "file": file["id"], "fileName": file["path"], "sheetName": sheet["name"], "question": arguments.get("question"),
                 "spec": {k: v for k, v in spec.items() if v not in (None, "")}})
    made = views.add_chart(store, data)
    if arguments.get("panel"):
        _add_to_panel(store, made["id"])
    views.remember(store, {"action": "chart", "title": made["title"], "question": arguments.get("question"), "result": made["kind"], "chart": made["id"],
                           "rows": made["calc"]["rowsUsed"], "basis": made["calc"]["basis"], "version": made["calc"]["steps"]})
    views.flush(store, root, _project(context), parts=("charts", "history"))
    views.focus(root, "panel" if arguments.get("panel") else "charts", made["id"])
    excluded = "; ".join(f"{e['count']} {e['reason']}" for e in made["calc"]["excluded"])
    return {"ok": True, "chart": made["id"], "title": made["title"], "kind": made["kind"], "labels": made["labels"][:40],
            "series": [{"name": s["name"], "values": s["values"][:40]} for s in made["series"][:6]], "total": made["total"],
            "message": f"Chart {made['id']} '{made['title']}' is in the Studio ({made['kind']}). {made['calc']['readable']} "
                       + (f"Left out: {excluded}. " if excluded else "") + f"Numbers: {views.describe(made)}. Tell the user what stands out, quoting these numbers."}


def _date_grouping(store, sheet_id, column, *texts):
    """by for a date x left without one: the word in the title or question ("por mês"), else month when the dates
    cover more than 62 days (a bar per day would be unreadable), else day."""
    for text in texts:
        word = analysis.bucket_word(text)
        if word:
            return word
    days = store.db.execute(f'SELECT COUNT(DISTINCT substr("{column["key"]}", 1, 10)) FROM {store.table(sheet_id)}').fetchone()[0]
    return "month" if days > 62 else "day"


def pivot(root, context, store, arguments, cancelled):
    file, sheet = _active(store)
    if not arguments.get("rows"):
        raise SheetStudioError("pivot needs rows (a column), and usually columns, value and agg.")
    spec = {k: arguments.get(k) for k in ("rows", "rows_by", "columns", "columns_by", "value", "agg", "filter", "title", "top", "sort")}
    if spec["value"] is None and arguments.get("y"):
        spec["value"] = arguments["y"]
    data = analysis.pivot(store, sheet["id"], spec)
    data.update({"sheet": sheet["id"], "file": file["id"], "fileName": file["path"], "sheetName": sheet["name"], "question": arguments.get("question"),
                 "spec": {k: v for k, v in spec.items() if v not in (None, "")}})
    made = views.add_chart(store, data)
    views.remember(store, {"action": "pivot", "title": made["title"], "question": arguments.get("question"), "result": "tabela dinâmica", "chart": made["id"],
                           "rows": made["calc"]["rowsUsed"], "basis": made["calc"]["basis"], "version": made["calc"]["steps"]})
    views.flush(store, root, _project(context), parts=("charts", "history"))
    views.focus(root, "charts", made["id"])
    return {"ok": True, "chart": made["id"], "rows": made["pivot"]["rows"][:30], "columns": made["pivot"]["columns"],
            "message": f"Pivot table {made['id']} is in the Studio. {made['calc']['readable']} Numbers: {views.describe(made, 30)}."}


def query(root, context, store, arguments, cancelled):
    file, sheet = _active(store)
    result = analysis.query(store, sheet["id"], arguments.get("sql"), limit=min(int(arguments.get("limit") or 200), 1000), cancelled=cancelled)
    title = arguments.get("title") or "Consulta"
    made = views.add_chart(store, {"kind": "query", "title": title, "sheet": sheet["id"], "file": file["id"], "fileName": file["path"], "sheetName": sheet["name"],
                                   "question": arguments.get("question"), "table": result, "labels": [], "series": [], "unit": "number", "total": None,
                                   "x": {"column": None}, "y": {"agg": None},
                                   "calc": {"basis": result["basis"], "steps": store.version(sheet["id"]), "rowsTotal": store.count(sheet["id"]),
                                            "rowsUsed": len(result["rows"]), "rowsMatched": len(result["rows"]), "excluded": [], "filter": [],
                                            "sql": arguments.get("sql"), "readable": f"Consulta SQL: {len(result['rows'])} linhas de resultado."}})
    views.remember(store, {"action": "query", "title": title, "question": arguments.get("question"), "result": f"{len(result['rows'])} linhas", "chart": made["id"],
                           "rows": len(result["rows"]), "basis": result["basis"], "version": store.version(sheet["id"])})
    views.flush(store, root, _project(context), parts=("charts", "history"))
    views.focus(root, "charts", made["id"])
    preview = " | ".join(", ".join(str(v) for v in row) for row in result["rows"][:15])
    return {"ok": True, "chart": made["id"], "columns": result["columns"], "rows": result["rows"][:50], "truncated": result["truncated"],
            "message": f"{len(result['rows'])} result rows ({', '.join(result['columns'])}): {preview}"}


def _add_to_panel(store, chart_id, title=None):
    panel = store.get("dashboard") or {"title": title or "Painel", "charts": [], "numbers": [], "at": time.time()}
    if chart_id not in panel["charts"]:
        panel["charts"].append(chart_id)
    panel["at"] = time.time()
    store.put("dashboard", panel)


def panel(root, context, store, arguments, cancelled):
    """A panel: a few headline numbers and the charts the agent chose (new ones can be made with chart panel=true)."""
    file, sheet = _active(store)
    charts = store.get("charts", [])
    wanted = arguments.get("charts") or []
    if isinstance(wanted, str):
        wanted = [w.strip() for w in wanted.replace(";", ",").split(",") if w.strip()]
    ids = [c["id"] for c in charts if c["id"] in wanted] if wanted else [c["id"] for c in charts if c.get("sheet") == sheet["id"] and c["kind"] not in ("query",)][:4][::-1]
    numbers = []
    for item in arguments.get("numbers") or []:
        if not isinstance(item, dict):
            continue
        data = analysis.compute(store, sheet["id"], {"y": item.get("y"), "agg": item.get("agg"), "filter": item.get("filter")})
        value = data["series"][0]["values"][0] if data["series"] and data["series"][0]["values"] else None
        numbers.append({"title": item.get("title") or data["title"], "value": value, "unit": data["unit"], "note": item.get("note") or data["calc"]["readable"],
                        "basis": data["calc"]["basis"], "version": data["calc"]["steps"]})
    panel_value = {"title": arguments.get("title") or "Painel", "charts": ids, "numbers": numbers, "at": time.time(), "sheet": sheet["id"],
                   "basis": store.basis(sheet["id"]), "version": store.version(sheet["id"])}
    store.put("dashboard", panel_value)
    views.remember(store, {"action": "panel", "title": panel_value["title"], "question": arguments.get("question"),
                           "result": f"{len(numbers)} números, {len(ids)} gráficos", "rows": store.count(sheet["id"]), "basis": store.basis(sheet["id"]),
                           "version": store.version(sheet["id"])})
    views.flush(store, root, _project(context), parts=("charts", "history"))
    views.focus(root, "panel")
    shown = "; ".join(f"{n['title']}: {types.show(n['value'], n['unit']) if n['unit'] != 'count' else types.number(n['value'] or 0)}" for n in numbers)
    return {"ok": True, "charts": ids, "numbers": numbers,
            "message": f"The panel '{panel_value['title']}' shows {len(ids)} charts" + (f" and these numbers: {shown}" if numbers else "") + "."}


def remove(root, context, store, arguments, cancelled):
    target = arguments.get("chart") or "last"
    charts = store.get("charts", [])
    if target in ("all", "todos"):
        kept, gone = [], charts
    elif target in ("last", "último", "ultimo"):
        kept, gone = charts[1:], charts[:1]
    else:
        kept, gone = [c for c in charts if c["id"] != target], [c for c in charts if c["id"] == target]
    if not gone:
        raise SheetStudioError(f"No chart {target}; the charts are: {', '.join(c['id'] + ' ' + c['title'] for c in charts[:12])}.")
    store.put("charts", kept)
    panel_value = store.get("dashboard")
    if panel_value:
        panel_value["charts"] = [i for i in panel_value["charts"] if i in {c["id"] for c in kept}]
        store.put("dashboard", panel_value)
    views.flush(store, root, parts=("charts",))
    return {"ok": True, "message": f"Removed {len(gone)} chart(s) from the Studio."}


# ---------------------------------------------------------------- cleaning

def problems(root, context, store, arguments, cancelled):
    file, sheet = _active(store)
    store.put("scanned", sheet["id"])
    scan = cleanup.scan(store, sheet["id"])
    store.put(f"scan:{sheet['id']}:{store.version(sheet['id'])}:{len(store.steps(sheet['id']))}", scan)
    views.remember(store, {"action": "problems", "title": "Procurar problemas", "question": arguments.get("question"),
                           "result": f"{len(scan['problems'])} problemas", "rows": scan["rows"], "basis": "raw", "version": store.version(sheet["id"])})
    views.flush(store, root, _project(context), parts=("cleanup", "history"))
    views.focus(root, "cleanup")
    if not scan["problems"]:
        return {"ok": True, "problems": [], "fine": [f["text"] for f in scan["fine"]],
                "message": "No problems found in the data." + (" Not problems: " + "; ".join(f["text"] for f in scan["fine"]) if scan["fine"] else "")}
    lines = [f"{p['id']}: {p['count']} — {p['title'].lower()}" + (f" in {p['column']}" if p["column"] else "") + f" (proposal: {p['proposal']})"
             + (" [applied]" if p["applied"] else "") for p in scan["problems"]]
    return {"ok": True, "problems": [{"id": p["id"], "count": p["count"], "fixable": bool(p["fix"]), "applied": bool(p["applied"])} for p in scan["problems"]],
            "message": "Problems: " + " | ".join(lines) + ". Not problems: " + "; ".join(f["text"] for f in scan["fine"] if f.get("by")) +
                       ". Nothing was changed. Tell the user and ask before calling fix (fix which=all, or the ids)."}


def fix(root, context, store, arguments, cancelled):
    file, sheet = _active(store)
    before = store.count(sheet["id"])
    added = cleanup.fix(store, sheet["id"], arguments.get("which") or "all")
    store.put("scanned", sheet["id"])
    texts = {s["id"]: s["text"] for s in store.steps(sheet["id"])}
    views.remember(store, {"action": "fix", "title": "Aplicar correções", "question": arguments.get("question"), "result": f"{len(added)} passos",
                           "rows": store.count(sheet["id"]), "basis": "clean", "version": store.version(sheet["id"])})
    views.flush(store, root, _project(context))
    views.focus(root, "cleanup")
    stale = [c for c in store.get("charts", []) if c.get("sheet") == sheet["id"] and c["calc"]["steps"] < store.version(sheet["id"]) and c["kind"] != "query"]
    return {"ok": True, "steps": added, "rows": store.count(sheet["id"]),
            "message": "Applied as undoable steps: " + "; ".join(f"{texts.get(a['id'], a['id'])} ({a['rows']} rows)" for a in added)
                       + f". The clean view has {types.number(store.count(sheet['id']))} rows (was {types.number(before)}); the original file did not change."
                       + (f" {len(stale)} charts were made before this; offer to redo them (chart again)." if stale else "")}


def undo(root, context, store, arguments, cancelled):
    file, sheet = _active(store)
    removed = cleanup.undo(store, sheet["id"], arguments.get("step") or "last")
    views.remember(store, {"action": "undo", "title": "Desfazer", "question": arguments.get("question"), "result": ", ".join(s["text"] for s in removed),
                           "rows": store.count(sheet["id"]), "basis": store.basis(sheet["id"]), "version": store.version(sheet["id"])})
    views.flush(store, root, _project(context))
    views.focus(root, "cleanup")
    return {"ok": True, "message": "Undone: " + "; ".join(s["text"] for s in removed) + f". The view now has {types.number(store.count(sheet['id']))} rows."}


def step(root, context, store, arguments, cancelled):
    file, sheet = _active(store)
    kind = arguments.get("kind")
    result = cleanup.custom_step(store, sheet["id"], kind, arguments)
    text = next((s["text"] for s in store.steps(sheet["id"]) if s["id"] == result["id"]), kind)
    views.remember(store, {"action": "step", "title": text, "question": arguments.get("question"), "result": f"{result['rows']} linhas",
                           "rows": store.count(sheet["id"]), "basis": "clean", "version": store.version(sheet["id"])})
    views.flush(store, root, _project(context))
    views.focus(root, "cleanup")
    return {"ok": True, "step": result["id"], "message": f"Step {result['id']} '{text}' changed {result['rows']} rows in the clean view (undo removes it)."}


def column(root, context, store, arguments, cancelled):
    file, sheet = _active(store)
    result = cleanup.column_step(store, sheet["id"], arguments)
    store.put("grid", {"sheet": sheet["id"], "highlight": result["column"]["key"]})
    views.remember(store, {"action": "column", "title": f"Nova coluna {result['column']['name']}", "question": arguments.get("question"),
                           "result": result["column"]["label"], "rows": result["rows"], "basis": "clean", "version": store.version(sheet["id"])})
    views.flush(store, root, _project(context))
    views.focus(root, "sheet", result["column"]["key"])
    sample = store.db.execute(f'SELECT "{result["column"]["key"]}", COUNT(*) AS n FROM {store.table(sheet["id"])} GROUP BY 1 ORDER BY n DESC LIMIT 6').fetchall()
    return {"ok": True, "column": result["column"]["name"],
            "message": f"Added column {result['column']['name']} ({result['column']['label']}) to the clean view, computed for {types.number(result['rows'])} rows. "
                       f"Most common values: {', '.join(f'{types.show(r[0], result['column']['type'])} ({r[1]})' for r in sample)}. Use it in chart, pivot or rows."}


# ---------------------------------------------------------------- exporting

def export_(root, context, store, arguments, cancelled):
    project = source_root(context, required=True)
    file, sheet = _active(store)
    settings = views.settings(root)
    what = arguments.get("what") or ("chart" if arguments.get("chart") else "data")
    fmt = (arguments.get("format") or ("svg" if what == "chart" else "xlsx" if what == "all" else "csv")).lower().lstrip(".")
    folder_text = arguments.get("folder") or settings["exportFolder"] or (str(Path(file["path"]).parent / "saida") if str(Path(file["path"]).parent) != "." else "saida")
    folder = project_file(project, folder_text)
    if folder.exists() and not folder.is_dir():
        raise SheetStudioError(f"{folder_text} is a file, not a folder.")
    folder.mkdir(parents=True, exist_ok=True)
    stem = slug(Path(file["path"]).stem) + ("-limpo" if store.basis(sheet["id"]) == "clean" else "")
    written = []
    charts = store.get("charts", [])
    if what == "chart":
        target = arguments.get("chart") or (charts[0]["id"] if charts else None)
        chosen = next((c for c in charts if c["id"] == target), None)
        if chosen is None:
            raise SheetStudioError("There is no chart to export; make one with chart first (or give chart with its id).")
        if fmt == "svg":
            written.append(export.write_svg(folder, f"{slug(chosen['title'], 'grafico')}.svg", chosen))
        elif fmt in ("csv", "xlsx"):
            columns, table = export.chart_table(chosen)
            written.append(export.write_csv(folder, f"{slug(chosen['title'], 'grafico')}.csv", columns, table, settings["csvStyle"]) if fmt == "csv" else
                           export.write_xlsx(folder, f"{slug(chosen['title'], 'grafico')}.xlsx", columns, table, []))
        else:
            raise SheetStudioError("A chart exports as svg (image), csv or xlsx (its numbers).")
    else:
        columns = store.columns(sheet["id"])
        keys = ", ".join(f'"{c["key"]}"' for c in columns)
        condition, params, readable = analysis.where(store, sheet["id"], store.basis(sheet["id"]), arguments.get("filter"))
        cursor = store.db.execute(f"SELECT {keys} FROM {store.table(sheet['id'])} WHERE {condition} ORDER BY _row", params)
        if fmt == "csv":
            written.append(export.write_csv(folder, f"{stem}.csv", columns, cursor, arguments.get("style") or settings["csvStyle"]))
        elif fmt == "xlsx":
            chosen = [c for c in charts if c.get("sheet") == sheet["id"]][:20] if what == "all" else []
            written.append(export.write_xlsx(folder, f"{stem}.xlsx", columns, cursor, chosen))
            if what == "all":
                for chart_item in chosen[:8]:
                    if chart_item["kind"] not in ("pivot", "query"):
                        written.append(export.write_svg(folder, f"{slug(chart_item['title'], 'grafico')}.svg", chart_item))
        else:
            raise SheetStudioError("Data exports as csv or xlsx.")
    names = [relative_name(project, p) for p in written]
    views.remember(store, {"action": "export", "title": "Exportar", "question": arguments.get("question"), "result": ", ".join(names),
                           "rows": store.count(sheet["id"]), "basis": store.basis(sheet["id"]), "version": store.version(sheet["id"])})
    views.flush(store, root, project, parts=("history",))
    return {"ok": True, "files": names, "message": f"Wrote {', '.join(names)} (new files; the original {file['path']} was not changed)."}


# ---------------------------------------------------------------- the Studio

def settings_(root, context, store, arguments, cancelled):
    current = views.settings(root)
    changes = {"decimal": arguments.get("decimal"), "dateOrder": arguments.get("date_order"), "csvStyle": arguments.get("style"),
               "exportFolder": arguments.get("folder"), "gridRows": arguments.get("limit")}
    for key, value in changes.items():
        if value is not None:
            current[key] = value
    from .common import write_json
    write_json(Path(root) / "settings.json", current)
    views.focus(root, "settings")
    return {"ok": True, "settings": current, "message": "Settings saved; reading options apply the next time a file is opened (open again to reread it)."}


def focus(root, context, store, arguments, cancelled):
    view = arguments.get("view") or "sheet"
    views.focus(root, view, arguments.get("select"), arguments.get("note") or "")
    return {"ok": True, "message": f"The Studio shows {arguments.get('select') or view}."}


ACTIONS = {"status": status, "files": files, "open": open_, "sheet": sheet, "close": close, "rows": rows, "profile": profile, "chart": chart,
           "pivot": pivot, "query": query, "panel": panel, "remove": remove, "problems": problems, "fix": fix, "undo": undo, "step": step,
           "column": column, "export": export_, "settings": settings_, "focus": focus}
