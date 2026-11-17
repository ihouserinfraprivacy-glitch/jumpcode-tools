# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""The Studio files the interface reads (top-level JSON in the Studio folder): sheet.json, grid.json, charts.json,
cleanup.json, history.json and view.json. Nothing secret goes in them; the original file is only described."""

import os
from pathlib import Path
import time

from . import analysis, cleanup, types
from .common import read_json, write_json

SCHEMA = 1
MAX_CHARTS = 60
MAX_HISTORY = 200


def settings(root):
    value = read_json(Path(root) / "settings.json", {}) or {}
    return {"schema": SCHEMA, "decimal": value.get("decimal", "auto"), "dateOrder": value.get("dateOrder", "auto"), "csvStyle": value.get("csvStyle", "br"),
            "exportFolder": value.get("exportFolder", ""), "gridRows": int(value.get("gridRows", 500)), "palette": value.get("palette", "padrão")}


def focus(root, view, select=None, note=""):
    current = read_json(Path(root) / "view.json", {}) or {}
    write_json(Path(root) / "view.json", {"schema": SCHEMA, "revision": int(current.get("revision", 0)) + 1, "view": view, "select": select, "note": note})


def progress_file(root, path, rows, total, started):
    write_json(Path(root) / "sheet.json", {**(read_json(Path(root) / "sheet.json", {}) or {}), "schema": SCHEMA, "status": "importing",
                                           "progress": {"path": path, "rows": rows, "total": total, "seconds": round(time.time() - started, 1)},
                                           "updatedAt": time.time()})


def _intact(file, project):
    if not file or project is None:
        return None
    path = Path(project) / file["path"]
    try:
        info = path.stat()
    except OSError:
        return False
    return info.st_size == file["bytes"] and abs(info.st_mtime - file["modified"]) < 0.001


def sheet_file(store, root, project=None, found=None, error=None):
    file, sheet = store.active()
    value = {"schema": SCHEMA, "status": "error" if error else ("ready" if sheet and sheet["imported"] else "empty"), "error": error,
             "files": [{"id": f["id"], "path": f["path"], "format": f["format"], "bytes": f["bytes"]} for f in store.files()],
             "found": found if found is not None else (read_json(Path(root) / "sheet.json", {}) or {}).get("found", []), "updatedAt": time.time()}
    if sheet:
        version = store.version(sheet["id"])
        cache_key = f"profile:{sheet['id']}:{version}"
        profile = store.get(cache_key)
        if profile is None and sheet["imported"]:
            profile = analysis.profile(store, sheet["id"])
            store.put(cache_key, profile)
        value.update({
            "file": {"id": file["id"], "path": file["path"], "name": os.path.basename(file["path"]), "format": file["format"], "bytes": file["bytes"],
                     "modified": file["modified"], "sha256": file["sha256"], "intact": _intact(file, project), "meta": file["meta"]},
            "sheet": {"id": sheet["id"], "name": sheet["name"], "rows": sheet["rows"], "header": sheet["header"], "hidden": bool(sheet["hidden"]),
                      "protected": bool(sheet["protected"]), "warnings": sheet["warnings"], "formulas": len(sheet["formulas"])},
            "sheets": [{"id": s["id"], "name": s["name"], "rows": s["rows"], "cols": s["cols"], "imported": bool(s["imported"]), "hidden": bool(s["hidden"]),
                        "protected": bool(s["protected"])} for s in store.sheets(file["id"])],
            "version": version, "basis": store.basis(sheet["id"]), "rowsRaw": store.count(sheet["id"], "raw") if sheet["imported"] else 0,
            "rows": store.count(sheet["id"]) if sheet["imported"] else 0,
            "columns": profile["columns"] if profile else [],
            "steps": [step_view(s) for s in store.steps(sheet["id"])],
        })
    write_json(Path(root) / "sheet.json", value)
    return value


def step_view(step):
    """A step for the Studio, with the details that say what it did (never more than a short list of rows)."""
    spec = step["spec"]
    detail = {}
    if step["kind"] == "column":
        detail = {"column": spec["column"]["name"], "formula": spec["column"].get("formula"), "type": spec["column"]["type"]}
    elif step["kind"] == "dedupe":
        detail = {"rows": spec["rows"][:50], "count": len(spec["rows"])}
    elif step["kind"] == "replace":
        detail = {"old": spec.get("old"), "new": spec.get("new")}
    elif step["kind"] == "fill":
        detail = {"value": spec.get("value"), "filter": spec.get("readable", [])}
    elif step["kind"] == "remove_rows":
        detail = {"filter": spec.get("readable", [])}
    elif step["kind"] == "unify":
        detail = {"map": dict(list(spec.get("map", {}).items())[:20])}
    elif step["kind"] == "types":
        detail = {"issue": spec.get("issue")}
    return {"id": step["id"], "kind": step["kind"], "text": step["text"], "rows": step["rows"], "at": step["at"], "detail": detail}


def grid_file(store, root):
    file, sheet = store.active()
    if not sheet or not sheet["imported"]:
        write_json(Path(root) / "grid.json", {"schema": SCHEMA, "rows": [], "columns": []})
        return
    state = store.get("grid") or {}
    if state.get("sheet") != sheet["id"]:
        state = {"sheet": sheet["id"]}
    try:
        data = analysis.rows(store, sheet["id"], state, limit=settings(root)["gridRows"])
    except Exception:  # a filter that no longer fits (a column was undone) falls back to all rows
        state = {"sheet": sheet["id"]}
        store.put("grid", state)
        data = analysis.rows(store, sheet["id"], state, limit=settings(root)["gridRows"])
    write_json(Path(root) / "grid.json", {"schema": SCHEMA, "sheet": sheet["id"], "sheetName": sheet["name"], "file": file["path"],
                                          "highlight": state.get("highlight"), **data, "updatedAt": time.time()})


def charts_file(store, root):
    write_json(Path(root) / "charts.json", {"schema": SCHEMA, "charts": store.get("charts", [])[:MAX_CHARTS], "dashboard": store.get("dashboard"),
                                            "updatedAt": time.time()})


def cleanup_file(store, root):
    file, sheet = store.active()
    if not sheet or not sheet["imported"]:
        write_json(Path(root) / "cleanup.json", {"schema": SCHEMA, "scanned": False, "problems": [], "fine": [], "steps": []})
        return None
    cache_key = f"scan:{sheet['id']}:{store.version(sheet['id'])}:{len(store.steps(sheet['id']))}"
    scan = store.get(cache_key) if store.get("scanned") == sheet["id"] else None
    if scan is None and store.get("scanned") == sheet["id"]:
        scan = cleanup.scan(store, sheet["id"])
        store.put(cache_key, scan)
    steps = [step_view(s) for s in store.steps(sheet["id"])]
    write_json(Path(root) / "cleanup.json", {"schema": SCHEMA, "scanned": scan is not None, "sheet": sheet["id"], **(scan or {"problems": [], "fine": []}),
                                             "steps": steps, "original": {"path": file["path"], "sha256": file["sha256"], "bytes": file["bytes"],
                                                                          "modified": file["modified"]}, "updatedAt": time.time()})
    return scan


def history_file(store, root):
    write_json(Path(root) / "history.json", {"schema": SCHEMA, "entries": store.get("history", [])[:MAX_HISTORY], "updatedAt": time.time()})


def remember(store, entry):
    history = store.get("history", [])
    current = (store.get("active") or {}).get("sheet")
    history.insert(0, {"at": time.time(), "sheet": current, **entry})
    store.put("history", history[:MAX_HISTORY])


def add_chart(store, chart):
    charts = store.get("charts", [])
    number = int(store.get("chartSeq", 0)) + 1
    store.put("chartSeq", number)
    chart = {"id": f"g{number}", "created": time.time(), **chart}
    charts.insert(0, chart)
    store.put("charts", charts[:MAX_CHARTS])
    return chart


def flush(store, root, project=None, parts=("sheet", "grid", "charts", "cleanup", "history"), found=None):
    if "sheet" in parts:
        sheet_file(store, root, project, found)
    if "grid" in parts:
        grid_file(store, root)
    if "charts" in parts:
        charts_file(store, root)
    if "cleanup" in parts:
        cleanup_file(store, root)
    if "history" in parts:
        history_file(store, root)


def describe(chart, limit=40):
    """The chart's numbers as one short pt-BR line for the model to quote."""
    unit = chart["unit"]
    show = (lambda v: types.brl(v) if unit == "currency" else types.number(v * 100, 1) + "%" if unit == "percent" else types.number(v))
    if len(chart["series"]) == 1:
        pairs = [f"{label}: {show(v) if v is not None else '—'}" for label, v in zip(chart["labels"], chart["series"][0]["values"])]
    else:
        pairs = [f"{label}: " + ", ".join(f"{s['name']} {show(s['values'][i]) if s['values'][i] is not None else '—'}" for s in chart["series"])
                 for i, label in enumerate(chart["labels"])]
    text = "; ".join(pairs[:limit]) + (f"; … ({len(pairs) - limit} more)" if len(pairs) > limit else "")
    if chart.get("total") is not None:
        text += f". Total {show(chart['total'])}"
    return text
