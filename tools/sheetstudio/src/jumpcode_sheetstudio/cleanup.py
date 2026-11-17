# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Data problems and their fixes. scan finds dates and numbers written as text, cells that could not be read,
formula errors, repeated rows, extra spaces and spellings of the same category; it also explains empty cells that
only look like a problem. Accepted fixes become steps that build the clean table; each step can be undone and
the original file and the original reading never change."""

import re

from . import analysis, types
from .common import SheetStudioError
from .store import fold, letter

ERRORS = {"#REF!": "a fórmula aponta para uma célula ou aba que foi apagada", "#DIV/0!": "a conta divide por zero ou por uma célula vazia",
          "#N/A": "uma busca (PROCV, PROCX, CORRESP) não achou o valor", "#VALUE!": "a conta usa texto onde devia haver número",
          "#NAME?": "a fórmula usa um nome de função ou intervalo que não existe", "#NUM!": "o resultado não é um número válido",
          "#NULL!": "a fórmula cruza intervalos que não se encontram", "#SPILL!": "o resultado não cabe nas células ao lado",
          "#CALC!": "a fórmula não conseguiu calcular"}
STEP_TEXT = {"types": "Gravar {column} como {type}", "dedupe": "Remover {count} linhas repetidas", "trim": "Tirar espaços sobrando em {column}",
             "unify": "Juntar grafias em {column}", "replace": "Trocar {old} por {new} em {column}", "fill": "Preencher {column} vazio com {value}",
             "remove_rows": "Remover linhas onde {filter}", "column": "Nova coluna {column}"}
PARTS = {"weekday": ("dia da semana", "category"), "month": ("mês", "category"), "year": ("ano", "integer"), "day": ("dia", "integer"),
         "hour": ("hora", "integer"), "quarter": ("trimestre", "category"), "week": ("semana", "integer")}


def scan(store, sheet_id, limit=6):
    """{problems: [...], fine: [...]} for the sheet as originally read (fixes already applied are marked)."""
    sheet = store.sheet(sheet_id)
    columns = {c["key"]: c for c in sheet["columns"]}
    table = f'"t_{sheet_id}"'
    applied = {(s["kind"], s["spec"].get("column", {}).get("key") if isinstance(s["spec"].get("column"), dict) else s["spec"].get("column")): s["id"]
               for s in store.steps(sheet_id)}
    problems, fine = [], []
    for kind, title, proposal in (("text-date", "Datas escritas como texto", "ler como {order} e gravar como data"),
                                  ("text-number", "Números escritos como texto", "tirar R$, pontos e espaços e gravar como número"),
                                  ("text-time", "Horas escritas como texto", "gravar como hora")):
        for row in store.db.execute("SELECT col, COUNT(*) AS n FROM issues WHERE sheet=? AND kind=? GROUP BY col", (sheet_id, kind)):
            column = columns.get(row["col"])
            if column is None:
                continue
            formats = [[r["detail"], r["n"]] for r in store.db.execute("SELECT detail, COUNT(*) AS n FROM issues WHERE sheet=? AND kind=? AND col=? GROUP BY detail ORDER BY n DESC",
                                                                         (sheet_id, kind, row["col"]))]
            # A number read from "R$ 45,00" is shown as the plain number it became, so before and after differ.
            shown = (lambda v: types.number(v, 2)) if kind == "text-number" else (lambda v: types.show(v, column["type"]))
            examples = [{"row": r["row"], "before": r["raw"], "after": shown(_stored(store, table, r["row"], column))}
                        for r in store.db.execute("SELECT row, raw FROM issues WHERE sheet=? AND kind=? AND col=? ORDER BY row LIMIT ?", (sheet_id, kind, row["col"], limit))]
            order = "dia/mês/ano" if column.get("order", "dmy") == "dmy" else "mês/dia/ano"
            problems.append({"id": f"{kind}:{column['name']}", "kind": kind, "title": title, "column": column["name"], "count": row["n"],
                             "formats": formats, "examples": examples, "proposal": proposal.format(order=order),
                             "fix": {"kind": "types", "column": column["key"], "issue": kind}, "applied": applied.get(("types", column["key"]))})
    for row in store.db.execute("SELECT col, COUNT(*) AS n FROM issues WHERE sheet=? AND kind='unparsed' GROUP BY col", (sheet_id,)):
        column = columns.get(row["col"])
        if column is None:
            continue
        examples = [{"row": r["row"], "before": r["raw"], "after": ""} for r in store.db.execute(
            "SELECT row, raw FROM issues WHERE sheet=? AND kind='unparsed' AND col=? ORDER BY row LIMIT ?", (sheet_id, row["col"], limit))]
        problems.append({"id": f"unparsed:{column['name']}", "kind": "unparsed", "title": f"Valores que não são {types.LABELS[column['type']]}",
                         "column": column["name"], "count": row["n"], "examples": examples, "proposal": "ficam vazios nas contas; troque ou preencha se souber o valor",
                         "fix": None, "applied": None})
    formulas = sheet.get("formulas") or {}
    for row in store.db.execute("SELECT col, detail, COUNT(*) AS n FROM issues WHERE sheet=? AND kind='error' GROUP BY col, detail", (sheet_id,)):
        column = columns.get(row["col"])
        if column is None:
            continue
        cells = [r["row"] for r in store.db.execute("SELECT row FROM issues WHERE sheet=? AND kind='error' AND col=? AND detail=? ORDER BY row LIMIT ?",
                                                     (sheet_id, row["col"], row["detail"], limit))]
        examples = [{"row": r, "before": row["detail"], "formula": formulas.get(f"{column['letter']}{r}")} for r in cells]
        problems.append({"id": f"error:{column['name']}:{row['detail']}", "kind": "error", "title": f"Células com {row['detail']}", "column": column["name"],
                         "count": row["n"], "examples": examples, "explain": ERRORS.get(row["detail"], "a fórmula deu erro no Excel"),
                         "proposal": "ficam vazias nas contas; o certo é corrigir a fórmula no arquivo original", "fix": None, "applied": None})
    duplicates = _duplicates(store, sheet_id, table, sheet["columns"])
    if duplicates:
        examples = [{"row": r, "same": first} for r, first in duplicates[:limit]]
        problems.append({"id": "duplicates", "kind": "duplicates", "title": "Linhas repetidas", "column": None, "count": len(duplicates),
                         "examples": examples, "proposal": f"remover as {len(duplicates)} cópias e manter a primeira de cada",
                         "fix": {"kind": "dedupe", "rows": [r for r, _ in duplicates]}, "applied": applied.get(("dedupe", None))})
    for column in sheet["columns"]:
        if column["type"] not in ("text", "category"):
            continue
        key = f'"{column["key"]}"'
        spaced = store.db.execute(f"SELECT COUNT(*) FROM {table} WHERE {key} <> TRIM({key}) OR {key} LIKE '%  %'").fetchone()[0]
        if spaced:
            examples = [{"row": r[0], "before": r[1], "after": re.sub(r"\s+", " ", r[1]).strip()} for r in store.db.execute(
                f"SELECT _row, {key} FROM {table} WHERE {key} <> TRIM({key}) OR {key} LIKE '%  %' ORDER BY _row LIMIT ?", (limit,))]
            problems.append({"id": f"spaces:{column['name']}", "kind": "spaces", "title": "Espaços sobrando", "column": column["name"], "count": spaced,
                             "examples": examples, "proposal": "tirar os espaços do começo, do fim e os duplicados",
                             "fix": {"kind": "trim", "column": column["key"]}, "applied": applied.get(("trim", column["key"]))})
        if column["type"] == "category":
            counts = store.db.execute(f"SELECT {key}, COUNT(*) FROM {table} WHERE {key} IS NOT NULL GROUP BY {key}").fetchall()
            groups = {}
            for value, n in counts:
                groups.setdefault(fold(value), []).append((value, n))
            mapping = {}
            for variants in groups.values():
                if len(variants) > 1:
                    canonical = max(variants, key=lambda v: v[1])[0].strip()
                    for value, _ in variants:
                        if value != canonical:
                            mapping[value] = canonical
            if mapping:
                total = sum(n for value, n in counts if value in mapping)
                examples = [{"before": k, "after": v} for k, v in list(mapping.items())[:limit]]
                problems.append({"id": f"spelling:{column['name']}", "kind": "spelling", "title": "O mesmo valor escrito de jeitos diferentes",
                                 "column": column["name"], "count": total, "examples": examples, "proposal": "usar a grafia mais comum de cada um",
                                 "fix": {"kind": "unify", "column": column["key"], "map": mapping}, "applied": applied.get(("unify", column["key"]))})
    fine = _empty_explained(store, table, sheet["columns"])
    return {"problems": problems, "fine": fine, "rows": store.count(sheet_id, "raw")}


def _stored(store, table, row, column):
    found = store.db.execute(f'SELECT "{column["key"]}" FROM {table} WHERE _row=?', (row,)).fetchone()
    return found[0] if found else None


def _duplicates(store, sheet_id, table, columns):
    keys = ", ".join(f'"{c["key"]}"' for c in columns)
    rows = store.db.execute(f"SELECT _row, first FROM (SELECT _row, MIN(_row) OVER (PARTITION BY {keys}) AS first FROM {table}) WHERE _row <> first ORDER BY _row").fetchall()
    return [(r[0], r[1]) for r in rows]


def _empty_explained(store, table, columns):
    """Empty cells that follow another column: "487 pagamento vazios são os status cancelado e faltou"."""
    notes = []
    categories = [c for c in columns if c["type"] == "category"]
    for column in columns:
        key = f'"{column["key"]}"'
        empty = store.db.execute(f"SELECT COUNT(*) FROM {table} WHERE {key} IS NULL").fetchone()[0]
        total = store.db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        if not empty or empty == total:
            continue
        explained = None
        for other in categories:
            if other["key"] == column["key"]:
                continue
            okey = f'"{other["key"]}"'
            values = store.db.execute(f"SELECT {okey}, COUNT(*) FROM {table} WHERE {key} IS NULL GROUP BY {okey} ORDER BY COUNT(*) DESC").fetchall()
            if not values or len(values) > 3 or any(v[0] is None for v in values):
                continue
            names = [v[0] for v in values]
            together = store.db.execute(f"SELECT COUNT(*) FROM {table} WHERE {okey} IN ({','.join('?' * len(names))})", names).fetchone()[0]
            parts = " e ".join(f"{n} {v}" for v, n in values)
            if together == empty:
                explained = {"column": column["name"], "count": empty, "text": f"{empty} {column['name']} vazios são exatamente as linhas com {other['name']} {parts}",
                             "by": other["name"], "exact": True}
                break
            if explained is None and len(values) == 1:
                explained = {"column": column["name"], "count": empty, "text": f"{empty} {column['name']} vazios, todos com {other['name']} = {names[0]}",
                             "by": other["name"], "exact": False}
        notes.append(explained or {"column": column["name"], "count": empty, "text": f"{empty} {column['name']} vazios", "by": None, "exact": False})
    return notes


# ------------------------------------------------------------------ steps

def step_text(kind, spec, columns):
    name = (spec.get("column") or {}).get("name") if isinstance(spec.get("column"), dict) else next((c["name"] for c in columns if c["key"] == spec.get("column")), spec.get("column"))
    column_type = next((types.LABELS[c["type"]] for c in columns if c["key"] == spec.get("column")), "")
    return STEP_TEXT[kind].format(column=name, type=column_type, count=len(spec.get("rows", [])), old=spec.get("old"), new=spec.get("new"),
                                  value=spec.get("value"), filter=" e ".join(spec.get("readable", [])))


def apply_step(db, table, step):
    """Applies one step to the clean table; returns how many rows it touched."""
    spec = step["spec"]
    kind = step["kind"]
    if kind == "types":
        return db.execute("SELECT COUNT(*) FROM issues WHERE sheet=? AND col=? AND kind=?", (step["sheet"], spec["column"], spec.get("issue", "text-date"))).fetchone()[0]
    if kind == "dedupe":
        rows = spec["rows"]
        changed = 0
        for start in range(0, len(rows), 500):
            part = rows[start:start + 500]
            changed += db.execute(f"DELETE FROM {table} WHERE _row IN ({','.join('?' * len(part))})", part).rowcount
        return changed
    if kind == "trim":
        key = f'"{spec["column"]}"'
        collapse = f"TRIM({key})"
        for _ in range(4):
            collapse = f"REPLACE({collapse}, '  ', ' ')"
        return db.execute(f"UPDATE {table} SET {key} = {collapse} WHERE {key} <> TRIM({key}) OR {key} LIKE '%  %'").rowcount
    if kind == "unify":
        key = f'"{spec["column"]}"'
        return sum(db.execute(f"UPDATE {table} SET {key} = ? WHERE {key} = ?", (new, old)).rowcount for old, new in spec["map"].items())
    if kind == "replace":
        key = f'"{spec["column"]}"'
        return db.execute(f"UPDATE {table} SET {key} = ? WHERE {key} = ?", (spec["new_value"], spec["old_value"])).rowcount
    if kind == "fill":
        key = f'"{spec["column"]}"'
        return db.execute(f"UPDATE {table} SET {key} = ? WHERE {key} IS NULL AND ({spec.get('sql') or '1=1'})", [spec["stored"]] + spec.get("params", [])).rowcount
    if kind == "remove_rows":
        return db.execute(f"DELETE FROM {table} WHERE {spec['sql']}", spec["params"]).rowcount
    if kind == "column":
        column = spec["column"]
        db.execute(f'ALTER TABLE {table} ADD COLUMN "{column["key"]}" {types.sql_type(column["type"])}')
        return db.execute(f'UPDATE {table} SET "{column["key"]}" = {spec["sql"]}').rowcount
    raise SheetStudioError(f"Unknown step {kind}")


def rebuild(store, sheet_id):
    return store.rebuild(sheet_id, apply_step)


def fix(store, sheet_id, which):
    """Turns proposals into steps. which: 'all' or a list of problem ids (or kinds, or column names)."""
    found = scan(store, sheet_id)
    columns = store.sheet(sheet_id)["columns"]
    chosen = []
    wanted = ["all"] if which in (None, "", "all", "todas", "tudo") else ([which] if isinstance(which, str) else list(which))
    for problem in found["problems"]:
        if not problem["fix"] or problem["applied"]:
            continue
        tags = {fold(problem["id"]), fold(problem["kind"]), fold(problem["column"] or "")}
        if "all" in wanted or any(fold(w) in tags or fold(w) == fold(problem["id"]) for w in wanted):
            chosen.append(problem)
    if not chosen:
        open_fixes = [p["id"] for p in found["problems"] if p["fix"] and not p["applied"]]
        raise SheetStudioError("Nothing to fix" + (f" with that name; the open proposals are: {', '.join(open_fixes)}." if open_fixes else ": there are no open proposals (call problems first)."))
    added = []
    with store.atomic():
        for problem in chosen:
            spec = dict(problem["fix"])
            kind = spec.pop("kind")
            added.append(store.add_step(sheet_id, kind, spec, step_text(kind, spec, columns)))
        results = dict(rebuild(store, sheet_id))
    return [{"id": step_id, "rows": results.get(step_id, 0)} for step_id in added]


def undo(store, sheet_id, which):
    steps = store.steps(sheet_id)
    if not steps:
        raise SheetStudioError("There is no step to undo.")
    if which in (None, "", "last", "último", "ultimo"):
        chosen = [steps[-1]["id"]]
    elif which in ("all", "tudo", "todos"):
        chosen = [s["id"] for s in steps]
    else:
        wanted = [which] if isinstance(which, str) else list(which)
        chosen = [s["id"] for s in steps if s["id"] in wanted or fold(s["text"]) in [fold(w) for w in wanted]]
        if not chosen:
            raise SheetStudioError(f"No step matches; the steps are: {', '.join(s['id'] + ' ' + s['text'] for s in steps)}.")
    removed = [s for s in steps if s["id"] in chosen]
    with store.atomic():
        store.remove_steps(sheet_id, chosen)
        rebuild(store, sheet_id)
    return removed


def custom_step(store, sheet_id, kind, arguments):
    """Steps the agent asks for directly: replace, fill, remove_rows."""
    basis = "clean"
    columns = store.columns(sheet_id, "clean")
    if kind == "remove_rows":
        condition, params, readable = analysis.where(store, sheet_id, basis, arguments.get("filter"))
        if condition == "1=1":
            raise SheetStudioError("remove_rows needs a filter (which rows to leave out of the clean view).")
        spec = {"sql": condition, "params": params, "readable": readable}
    else:
        column = store.resolve(sheet_id, arguments.get("column"), "clean")
        if kind == "replace":
            old, new = arguments.get("old"), arguments.get("new")
            if old is None or new is None:
                raise SheetStudioError("replace needs old and new.")
            spec = {"column": column["key"], "old": old, "new": new, "old_value": _typed(column, old), "new_value": _typed(column, new)}
        elif kind == "fill":
            if arguments.get("value") is None:
                raise SheetStudioError("fill needs value.")
            condition, params, readable = analysis.where(store, sheet_id, basis, arguments.get("filter"))
            spec = {"column": column["key"], "value": arguments["value"], "stored": _typed(column, arguments["value"]), "sql": condition,
                    "params": params, "readable": readable}
        else:
            raise SheetStudioError(f"Unknown step {kind}")
    with store.atomic():
        step_id = store.add_step(sheet_id, kind, spec, step_text(kind, spec, columns))
        results = dict(rebuild(store, sheet_id))
    return {"id": step_id, "rows": results.get(step_id, 0)}


def _typed(column, value):
    stored, issue = types.converter(column)(value)
    if issue is not None and issue[0] == "unparsed":
        raise SheetStudioError(f"{value!r} does not fit column {column['name']} ({types.LABELS[column['type']]}).")
    return stored


# ------------------------------------------------------------------ calculated columns

_TOKEN = re.compile(r"\s*(?:(?P<num>\d+(?:\.\d+)?)|(?P<str>'(?:[^']|'')*')|(?P<quoted>\"[^\"]+\")|(?P<name>[A-Za-zÀ-ÿ_][\wÀ-ÿ ]*?)(?=\s*(?:[-+*/(),<>=!]|$))|(?P<op><=|>=|<>|!=|[-+*/(),<>=]))", re.U)
FUNCTIONS = {"round": "ROUND", "arred": "ROUND", "abs": "ABS", "upper": "UPPER", "maiuscula": "UPPER", "lower": "LOWER", "minuscula": "LOWER",
             "trim": "TRIM", "length": "LENGTH", "coalesce": "COALESCE", "ifnull": "IFNULL", "iif": "IIF", "se": "IIF", "if": "IIF",
             "min": "MIN", "max": "MAX", "substr": "SUBSTR"}


def expression_sql(store, sheet_id, text):
    """A small formula (column names, numbers, + - * /, comparisons and round/abs/iif...) as SQL; nothing else passes."""
    out, position, uses_money = [], 0, False
    depth, function_depths, pending_function = 0, [], False
    source = str(text or "").strip().lstrip("=")
    if not source:
        raise SheetStudioError("expression is empty.")
    while position < len(source):
        match = _TOKEN.match(source, position)
        if not match or match.end() == position:
            raise SheetStudioError(f"Could not read the formula near {source[position:position + 15]!r}; use column names, numbers, + - * / and round, abs, iif.")
        position = match.end()
        if match.group("num"):
            number = match.group("num")
            # Function calls use SQL syntax: comma separates arguments, dot is decimal.
            # Keep legacy decimal commas only outside calls, where they are unambiguous.
            fraction = re.match(r",\d+", source[position:]) if not function_depths and "." not in number else None
            if fraction:
                number += "." + fraction.group()[1:]
                position += fraction.end()
            out.append(number)
        elif match.group("str"):
            out.append(match.group("str"))
        elif match.group("op"):
            op = match.group("op")
            if op == "(":
                depth += 1
                if pending_function:
                    function_depths.append(depth)
                pending_function = False
            elif op == ")":
                if function_depths and function_depths[-1] == depth:
                    function_depths.pop()
                depth -= 1
            # Promote the numerator before division; preserve SQL operator precedence.
            out.append({"!=": "<>", "/": "* 1.0 /"}.get(op, op))
        else:
            name = (match.group("quoted") or match.group("name")).strip().strip('"')
            following = source[position:].lstrip()
            if following.startswith("(") and fold(name) in FUNCTIONS:
                out.append(FUNCTIONS[fold(name)])
                pending_function = True
                continue
            column = store.resolve(sheet_id, name, "clean")
            uses_money = uses_money or column["type"] == "currency"
            out.append(f'"{column["key"]}"')
    sql = " ".join(out)
    try:
        cursor = store.db.execute(f"SELECT {sql} FROM {store.table(sheet_id, 'clean')} LIMIT 0")
        if len(cursor.description) != 1:
            raise SheetStudioError("A formula must produce one value. In function calls, use decimal dots and commas between arguments.")
    except Exception as error:
        raise SheetStudioError(f"The formula is not valid: {error}.") from error
    return sql, uses_money


def column_step(store, sheet_id, arguments):
    name = str(arguments.get("name") or "").strip()
    columns = store.columns(sheet_id, "clean")
    if arguments.get("derive") or arguments.get("part"):
        source = store.resolve(sheet_id, arguments.get("from") or arguments.get("derive"), "clean", kinds=("date", "datetime", "time"))
        part = analysis.BUCKET_ALIASES.get(str(arguments.get("part") or "").lower(), str(arguments.get("part") or "").lower())
        if part not in PARTS:
            raise SheetStudioError(f"part must be one of {', '.join(PARTS)}.")
        key = f'"{source["key"]}"'
        if part == "weekday":
            sql = "CASE CAST(strftime('%w', " + key + ") AS INTEGER) " + " ".join(f"WHEN {i} THEN '{d}'" for i, d in enumerate(types.WEEKDAYS)) + " END"
        elif part == "month":
            sql = "CASE CAST(strftime('%m', " + key + ") AS INTEGER) " + " ".join(f"WHEN {i + 1} THEN '{m}'" for i, m in enumerate(types.MONTHS)) + " END"
        elif part == "quarter":
            sql = f"((CAST(strftime('%m', {key}) AS INTEGER) + 2) / 3) || 'º tri'"
        elif part == "hour":
            sql = f"CAST(substr({key}, {1 if source['type'] == 'time' else 12}, 2) AS INTEGER)"
        else:
            pattern = {"year": "%Y", "day": "%d", "week": "%W"}[part]
            sql = f"CAST(strftime('{pattern}', {key}) AS INTEGER)"
        kind = PARTS[part][1]
        name = name or f"{PARTS[part][0]} de {source['name']}"
        readable = f"{PARTS[part][0]} de {source['name']}"
    else:
        sql, money = expression_sql(store, sheet_id, arguments.get("expression"))
        kind = arguments.get("type") or ("currency" if money else "number")
        if kind not in types.TYPES:
            raise SheetStudioError(f"type must be one of {', '.join(types.TYPES)}.")
        name = name or "nova coluna"
        readable = str(arguments.get("expression")).strip()
    if any(fold(c["name"]) == fold(name) for c in columns):
        raise SheetStudioError(f"There is already a column named {name}; choose another name.")
    index = len(columns) + 1
    number = max([int(c["key"][1:]) for c in columns if c["key"].startswith("x")] + [0]) + 1
    column = {"key": f"x{number}", "name": name, "letter": letter(index), "type": kind, "label": types.LABELS[kind], "calculated": True, "formula": readable}
    spec = {"column": column, "sql": sql}
    with store.atomic():
        step_id = store.add_step(sheet_id, "column", spec, step_text("column", spec, columns))
        results = dict(rebuild(store, sheet_id))
    return {"id": step_id, "rows": results.get(step_id, 0), "column": column}
