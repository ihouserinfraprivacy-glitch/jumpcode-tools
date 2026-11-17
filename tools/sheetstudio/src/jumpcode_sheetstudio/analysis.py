# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""What the agent asks of a sheet: filters, groups by month/weekday/hour, charts, pivot tables, column profiles,
the rows the Studio shows and read-only SQL. Everything is computed with SQLite on the Studio's copy and every
result says what was used: the columns, the filter, the rows counted and the rows left out."""

import re
import sqlite3
import statistics
import time

from . import types
from .common import SheetStudioError
from .store import fold

AGGREGATES = {"sum": "soma", "count": "contagem", "avg": "média", "min": "mínimo", "max": "máximo", "unique": "valores distintos", "median": "mediana"}
AGG_ALIASES = {"soma": "sum", "total": "sum", "somar": "sum", "contagem": "count", "contar": "count", "quantidade": "count", "qtd": "count", "n": "count",
               "media": "avg", "média": "avg", "mean": "avg", "average": "avg", "minimo": "min", "mínimo": "min", "maximo": "max", "máximo": "max",
               "distinct": "unique", "distintos": "unique", "count_distinct": "unique", "mediana": "median"}
BUCKETS = ("month", "year", "quarter", "week", "day", "weekday", "hour")
BUCKET_ALIASES = {"mes": "month", "mês": "month", "meses": "month", "monthly": "month", "ano": "year", "trimestre": "quarter", "semana": "week",
                  "dia": "day", "date": "day", "data": "day", "dia_semana": "weekday", "diadasemana": "weekday", "dow": "weekday",
                  "hora": "hour", "horario": "hour", "horário": "hour"}
KINDS = ("bar", "hbar", "line", "stacked", "stacked100", "grouped", "heatmap", "table")
KIND_ALIASES = {"barras": "bar", "barra": "bar", "column": "bar", "columns": "bar", "colunas": "bar", "horizontal": "hbar", "barh": "hbar",
                "linha": "line", "linhas": "line", "area": "line", "área": "line", "empilhado": "stacked", "stack": "stacked",
                "100": "stacked100", "percent": "stacked100", "agrupado": "grouped", "mapa": "heatmap", "calor": "heatmap", "mapa_de_calor": "heatmap",
                "tabela": "table", "pie": "hbar", "pizza": "hbar", "donut": "hbar", "rosca": "hbar"}
OPS = {"=": "=", "==": "=", "is": "=", "é": "=", "igual": "=", "!=": "!=", "<>": "!=", "≠": "!=", "not": "!=", "diferente": "!=",
       ">": ">", ">=": ">=", "≥": ">=", "<": "<", "<=": "<=", "≤": "<=", "in": "in", "em": "in", "contains": "contains", "contém": "contains",
       "contem": "contains", "like": "contains", "empty": "empty", "vazio": "empty", "not_empty": "not_empty", "preenchido": "not_empty"}
MAX_GROUPS = 60


# ------------------------------------------------------------------ filters

def _filter_items(raw):
    """Filters as a list of {column, op, value}, from a list, a dict or text like "status = concluído e valor > 50"."""
    if raw is None or raw == "" or raw == []:
        return []
    if isinstance(raw, dict):
        return [raw]
    if isinstance(raw, list):
        items = []
        for item in raw:
            items += _filter_items(item)
        return items
    text = str(raw).strip()
    chunks = re.split(r"(\s+(?:e|and|&&)\s+|\s*;\s*)", text, flags=re.I)
    parts = [chunks[0]]
    for joiner, piece in zip(chunks[1::2], chunks[2::2]):
        # "serviço = Corte e barba e status = concluído": a piece without an operator belongs to the value before it.
        if _OPERATOR.search(piece):
            parts.append(piece)
        else:
            parts[-1] += joiner + piece
    items = []
    for part in (p.strip() for p in parts):
        if not part:
            continue
        match = _CONDITION.match(part)
        if not match:
            raise SheetStudioError(f"Could not read the filter {part!r}; write it like: status = concluído (or a list of {{column, op, value}}).")
        op = match.group("op").lower()
        if any(word in op for word in ("não", "nao", "not", "preenchido")):
            op = "not_empty"
        elif "vazio" in op or "empty" in op:
            op = "empty"
        items.append({"column": match.group("col").strip().strip('"\''), "op": op, "value": match.group("val").strip().strip('"\'')})
    return items


_OPERATOR = re.compile(r">=|<=|!=|<>|==|=|>|<|≥|≤|≠|\bcont[eé]m\b|\bcontains\b|\bin\b|\bem\b|\bvazio\b|\bempty\b|\bpreenchido\b", re.I)
_CONDITION = re.compile(r"^(?P<col>.+?)\s*(?P<op>>=|<=|!=|<>|==|=|>|<|≥|≤|≠|\bn[aã]o est[aá] vazio\b|\bn[aã]o vazio\b|\bnot empty\b|\best[aá] vazio\b"
                        r"|\bis empty\b|\bvazio\b|\bempty\b|\bpreenchido\b|\bcont[eé]m\b|\bcontains\b|\bin\b|\bem\b)\s*(?P<val>.*)$", re.I)


def _value_for(store, sheet_id, basis, column, value):
    """A filter value in the column's stored form: dates as ISO, numbers as numbers, categories spelled as in the data."""
    kind = column["type"]
    if value is None:
        return None
    if isinstance(value, (int, float)) and kind in types.NUMERIC:
        return value
    text = str(value).strip()
    if kind in types.NUMERIC:
        parsed = types.number_from_text(text, column.get("decimal", "comma"))
        if parsed is None:
            raise SheetStudioError(f"{text!r} is not a number for column {column['name']}.")
        number = parsed[0]
        return number / 100 if kind == "percent" and parsed[1] != "percent" and number > 1 else number
    if kind in ("date", "datetime"):
        parsed = types.date_from_text(text, column.get("order", "dmy"))
        if parsed is not None:
            moment = parsed[0]
            return moment.strftime("%Y-%m-%d %H:%M:%S") if hasattr(moment, "hour") and kind == "datetime" else str(moment)[:10]
        month = next((i for i, name in enumerate(types.MONTH_NAMES) if fold(name) == fold(text) or fold(types.MONTHS[i]) == fold(text)), None)
        if month is not None:
            return ("month", month + 1)
        if re.fullmatch(r"\d{4}-\d{2}", text) or re.fullmatch(r"\d{4}", text):
            return ("prefix", text)
        raise SheetStudioError(f"{text!r} is not a date for column {column['name']}; use dd/mm/aaaa.")
    if kind == "time":
        moment = types.time_from_text(text)
        if moment is None:
            raise SheetStudioError(f"{text!r} is not a time for column {column['name']}; use hh:mm.")
        return moment.strftime("%H:%M:%S")
    if kind == "bool":
        parsed = types.bool_from_text(text)
        return int(parsed) if parsed is not None else text
    table = store.table(sheet_id, basis)
    rows = store.db.execute(f'SELECT DISTINCT "{column["key"]}" FROM {table} WHERE "{column["key"]}" IS NOT NULL LIMIT 5000').fetchall()
    values = [r[0] for r in rows]
    if text in values:
        return text
    match = [v for v in values if fold(v) == fold(text)]
    return match[0] if len(match) == 1 else text


def where(store, sheet_id, basis, raw):
    """(SQL condition, parameters, readable pieces) for a filter; an empty filter is all rows."""
    pieces, params, readable = [], [], []
    for item in _filter_items(raw):
        column = store.resolve(sheet_id, item.get("column") or item.get("col") or item.get("coluna"), basis)
        op = OPS.get(str(item.get("op", "=")).lower().strip(), None)
        if op is None:
            raise SheetStudioError(f"Unknown filter operator {item.get('op')!r}; use =, !=, >, >=, <, <=, in, contains, empty or not_empty.")
        key = f'"{column["key"]}"'
        value = item.get("value")
        if op == "empty":
            pieces.append(f"({key} IS NULL OR {key} = '')")
            readable.append(f"{column['name']} vazio")
            continue
        if op == "not_empty":
            pieces.append(f"({key} IS NOT NULL AND {key} <> '')")
            readable.append(f"{column['name']} preenchido")
            continue
        if op == "in":
            options = value if isinstance(value, list) else [v.strip().strip('"\'') for v in re.split(r",|\bou\b|\bor\b", str(value).strip("()[]")) if v.strip()]
            converted = [_value_for(store, sheet_id, basis, column, v) for v in options]
            pieces.append(f"{key} IN ({', '.join('?' * len(converted))})")
            params += converted
            readable.append(f"{column['name']} em {', '.join(str(v) for v in options)}")
            continue
        if op == "contains":
            pieces.append(f"LOWER({key}) LIKE ? ESCAPE '\\'")
            params.append("%" + str(value).lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%")
            readable.append(f"{column['name']} contém {value}")
            continue
        converted = _value_for(store, sheet_id, basis, column, value)
        if isinstance(converted, tuple) and converted[0] == "month":
            pieces.append(f"CAST(strftime('%m', {key}) AS INTEGER) {op} ?")
            params.append(converted[1])
            readable.append(f"mês de {column['name']} {op} {types.MONTH_NAMES[converted[1] - 1]}")
            continue
        if isinstance(converted, tuple) and converted[0] == "prefix":
            pieces.append(f"substr({key}, 1, {len(converted[1])}) {op} ?")
            params.append(converted[1])
            readable.append(f"{column['name']} {op} {converted[1]}")
            continue
        pieces.append(f"{key} {op} ?")
        params.append(converted)
        readable.append(f"{column['name']} {op} {types.show(converted, column['type']) if column['type'] in types.NUMERIC + types.TEMPORAL else converted}")
    return (" AND ".join(pieces) or "1=1"), params, readable


# ------------------------------------------------------------------ groups (x axis and series)

_BUCKET_WORDS = (("weekday", r"dia\s*da\s*semana|diadasemana|weekday|dow"), ("month", r"m[eê]s|meses|mensal|month"),
                 ("quarter", r"trimestr|quarter"), ("year", r"\bano|anos\b|anual|year"), ("week", r"semana|week"),
                 ("hour", r"\bhora|hor[aá]rio|hour"), ("day", r"\bdia\b|\bdias\b|di[aá]rio|\bday|daily"))


def bucket_word(text):
    """The grouping a free text asks for ("data day", "mês de data", "monthly" -> day, month, month), or None."""
    if not text:
        return None
    lowered = str(text).lower().strip()
    if lowered in BUCKETS:
        return lowered
    if lowered in BUCKET_ALIASES:
        return BUCKET_ALIASES[lowered]
    for name, pattern in _BUCKET_WORDS:
        if re.search(pattern, lowered):
            return name
    return None


def bucket(column, by):
    """(SQL expression, label kind) for a column grouped by month, weekday, hour..., or the column itself."""
    key = f'"{column["key"]}"'
    kind = column["type"]
    if by and str(by).lower() not in ("value", "valor", "none"):
        by = bucket_word(by) or str(by).lower()
    if by in (None, "", "value", "valor", "none"):
        if kind == "datetime":
            return f"substr({key}, 1, 10)", "day"
        if kind in ("date",):
            return key, "day"
        if kind == "time":
            return f"substr({key}, 1, 2)", "hour"
        return key, "value"
    if by not in BUCKETS:
        raise SheetStudioError(f"by must be one of {', '.join(BUCKETS)}.")
    if kind == "time":
        if by != "hour":
            raise SheetStudioError(f"{column['name']} is a time; it can only be grouped by hour.")
        return f"substr({key}, 1, 2)", "hour"
    if kind not in ("date", "datetime"):
        raise SheetStudioError(f"{column['name']} is {types.LABELS[kind]}; only dates can be grouped by {by}.")
    expression = {"month": f"strftime('%Y-%m', {key})", "year": f"strftime('%Y', {key})", "day": f"substr({key}, 1, 10)",
                  "week": f"strftime('%Y-%W', {key})", "weekday": f"CAST(strftime('%w', {key}) AS INTEGER)",
                  "quarter": f"strftime('%Y', {key}) || '-' || ((CAST(strftime('%m', {key}) AS INTEGER) + 2) / 3)",
                  "hour": f"strftime('%H', {key})"}[by]
    return expression, by


def label(value, kind, years=1):
    if value is None:
        return "(vazio)"
    if kind == "month" and isinstance(value, str) and len(value) == 7:
        name = types.MONTHS[int(value[5:7]) - 1]
        return name if years <= 1 else f"{name}/{value[2:4]}"
    if kind == "weekday":
        return types.WEEKDAYS[int(value)]
    if kind == "hour":
        return f"{int(value):02d}h"
    if kind == "day" and isinstance(value, str) and len(value) >= 10:
        return f"{value[8:10]}/{value[5:7]}" + ("" if years <= 1 else f"/{value[2:4]}")
    if kind == "quarter":
        year, quarter = str(value).split("-")
        return f"{quarter}º tri" + ("" if years <= 1 else f"/{year[2:]}")
    if kind == "week":
        return f"sem {str(value)[5:]}" + ("" if years <= 1 else f"/{str(value)[2:4]}")
    if isinstance(value, float) and value.is_integer():
        return types.number(value)
    return str(value)


def _order(keys, kind):
    if kind == "weekday":
        return sorted(keys, key=lambda k: (k is None, (int(k) + 6) % 7 if k is not None else 0))
    return sorted(keys, key=lambda k: (k is None, k if k is not None else ""))


# ------------------------------------------------------------------ charts

def _aggregate(agg, column):
    agg = AGG_ALIASES.get(str(agg or "").lower(), str(agg or "").lower()) or ("sum" if column else "count")
    if agg not in AGGREGATES:
        raise SheetStudioError(f"agg must be one of {', '.join(AGGREGATES)}.")
    if column is None and agg != "count":
        raise SheetStudioError(f"{AGGREGATES[agg]} needs a value column (y).")
    if column is not None and agg in ("sum", "avg", "median") and column["type"] not in types.NUMERIC:
        raise SheetStudioError(f"Column {column['name']} is {types.LABELS[column['type']]}; {AGGREGATES[agg]} needs a number column. Use agg count.")
    return agg


def _expression(agg, column):
    if agg == "count":
        return "COUNT(*)" if column is None else f'COUNT("{column["key"]}")'
    key = f'"{column["key"]}"'
    return {"sum": f"SUM({key})", "avg": f"AVG({key})", "min": f"MIN({key})", "max": f"MAX({key})", "unique": f"COUNT(DISTINCT {key})",
            "median": key}[agg]


def compute(store, sheet_id, spec):
    """A chart from {x, by, y, agg, group, group_by, filter, kind, top, sort, title}. Returns the chart dict."""
    basis = store.basis(sheet_id, spec.get("basis", "auto"))
    table = store.table(sheet_id, basis)
    total_rows = store.count(sheet_id, basis)
    x_col = store.resolve(sheet_id, spec["x"], basis) if spec.get("x") else None
    y_col = store.resolve(sheet_id, spec["y"], basis) if spec.get("y") else None
    g_col = store.resolve(sheet_id, spec["group"], basis) if spec.get("group") else None
    if g_col and x_col and g_col["key"] == x_col["key"] and bucket_word(spec.get("group_by")) == bucket_word(spec.get("by")):
        g_col = None  # "x serviço, group serviço" (small models do this) is just one series per serviço
    agg = _aggregate(spec.get("agg"), y_col)
    if y_col and agg in ("min", "max") and y_col["type"] not in types.NUMERIC:
        raise SheetStudioError(f"Charts need numeric values; {y_col['name']} is {types.LABELS[y_col['type']]}. "
                               f"Use query with {agg.upper()} to show this result as a table, or count to chart its occurrences.")
    condition, params, readable = where(store, sheet_id, basis, spec.get("filter"))
    x_expr, x_kind = bucket(x_col, spec.get("by")) if x_col else ("'Total'", "value")
    g_expr, g_kind = bucket(g_col, spec.get("group_by")) if g_col else (None, None)
    value_expr = _expression(agg, y_col)
    matched = store.db.execute(f"SELECT COUNT(*) FROM {table} WHERE {condition}", params).fetchone()[0]
    missing = []
    if y_col is not None:
        empty = store.db.execute(f'SELECT COUNT(*) FROM {table} WHERE ({condition}) AND "{y_col["key"]}" IS NULL', params).fetchone()[0]
        if empty:
            missing.append({"reason": f"{y_col['name']} vazio", "count": empty})
    if x_col is not None:
        empty = store.db.execute(f"SELECT COUNT(*) FROM {table} WHERE ({condition}) AND ({x_expr}) IS NULL", params).fetchone()[0]
        if empty:
            missing.append({"reason": f"{x_col['name']} vazio", "count": empty})
    groups = f"{x_expr} AS x" + (f", {g_expr} AS g" if g_expr else "")
    group_by = "x" + (", g" if g_expr else "")
    if agg == "median":
        rows = store.db.execute(f"SELECT {groups}, {value_expr} AS v FROM {table} WHERE ({condition}) AND {value_expr} IS NOT NULL ORDER BY {group_by}, v", params).fetchall()
        buckets = {}
        for row in rows:
            buckets.setdefault((row["x"], row["g"] if g_expr else None), []).append(row["v"])
        data = [(x, g, statistics.median(v)) for (x, g), v in buckets.items()]
    else:
        rows = store.db.execute(f"SELECT {groups}, {value_expr} AS v FROM {table} WHERE {condition} GROUP BY {group_by}", params).fetchall()
        data = [(row["x"], row["g"] if g_expr else None, row["v"]) for row in rows]
    if x_col is not None and y_col is not None:
        data = [d for d in data if d[0] is not None]
    x_keys = list(dict.fromkeys(d[0] for d in data))
    g_keys = list(dict.fromkeys(d[1] for d in data)) if g_expr else [None]
    values = {(d[0], d[1]): d[2] for d in data}
    years = len({str(k)[:4] for k in x_keys if k is not None}) if x_kind in ("month", "day", "quarter", "week") else 1
    totals = {x: sum((values.get((x, g)) or 0) for g in g_keys) for x in x_keys}
    sort = str(spec.get("sort") or "").lower()
    chronological = x_kind in ("month", "year", "quarter", "week", "day", "weekday", "hour")
    if sort in ("label", "nome", "name") or (chronological and sort not in ("value", "valor", "desc", "asc")):
        x_keys = _order(x_keys, x_kind)
    else:
        x_keys = sorted(x_keys, key=lambda k: (totals.get(k) or 0), reverse=sort != "asc")
    top = spec.get("top")
    other = None
    limit = int(top) if top else (MAX_GROUPS if not chronological else 400)
    if len(x_keys) > limit:
        kept, rest = x_keys[:limit], x_keys[limit:]
        other = {g: sum(values.get((x, g)) or 0 for x in rest) for g in g_keys} if agg in ("sum", "count") else None
        x_keys = kept
    if g_expr:
        g_keys = _order(g_keys, g_kind) if g_kind in ("weekday", "hour", "month", "day") else sorted(g_keys, key=lambda g: -sum(values.get((x, g)) or 0 for x in x_keys))
    labels = [label(x, x_kind, years) for x in x_keys]
    series = [{"name": label(g, g_kind, years) if g_expr else (_y_label(agg, y_col)), "key": g,
               "values": [values.get((x, g)) for x in x_keys]} for g in g_keys]
    if other:
        labels.append("Outros")
        for s in series:
            s["values"].append(other.get(s["key"]))
    kind = KIND_ALIASES.get(str(spec.get("kind") or "").lower(), str(spec.get("kind") or "").lower())
    if kind not in KINDS:
        kind = ("heatmap" if g_kind in ("hour", "weekday") and x_kind in ("hour", "weekday") else "grouped" if g_expr and len(g_keys) <= 4
                else "line" if g_expr or (chronological and x_kind in ("day", "week") and len(labels) > 24) else
                "hbar" if x_kind == "value" and (len(labels) > 8 or max((len(l) for l in labels), default=0) > 12) else "bar")
    unit = "count" if agg in ("count", "unique") else (y_col["type"] if y_col else "count")
    total = sum(v for v in (values.get((x, g)) for x in x_keys for g in g_keys) if v is not None) if agg in ("sum", "count") else None
    if agg in ("sum", "count") and other:
        total = (total or 0) + sum(v or 0 for v in other.values())
    used = matched - sum(m["count"] for m in missing if y_col is not None and m["reason"].startswith(y_col["name"]))
    title = spec.get("title") or _title(agg, y_col, x_col, x_kind, g_col)
    sql_shown = _display_sql(store.columns(sheet_id, basis), f"SELECT {groups}, {value_expr} AS v FROM dados WHERE {condition} GROUP BY {group_by}", params)
    sentence = (f"{AGGREGATES[agg].capitalize()} de {y_col['name']}" if y_col else "Contagem de linhas") + \
               (f" por {_by_text(x_kind, x_col)}" if x_col else "") + (f" e por {_by_text(g_kind, g_col)}" if g_col else "") + \
               (f", só onde {' e '.join(readable)}" if readable else "") + f": {types.number(used)} de {types.number(total_rows)} linhas."
    return {"kind": kind, "title": title, "x": {"column": x_col["name"] if x_col else None, "by": x_kind if x_col else None},
            "y": {"column": y_col["name"] if y_col else None, "agg": agg, "type": y_col["type"] if y_col else "integer"},
            "group": {"column": g_col["name"], "by": g_kind} if g_col else None, "labels": labels, "keys": [str(k) if k is not None else None for k in x_keys],
            "series": [{k: v for k, v in s.items() if k != "key"} for s in series], "unit": unit, "total": total,
            "calc": {"basis": basis, "steps": store.version(sheet_id), "rowsTotal": total_rows, "rowsMatched": matched, "rowsUsed": used,
                     "excluded": [{"reason": "fora do filtro", "count": total_rows - matched}] * bool(total_rows - matched) + missing,
                     "filter": readable, "sql": sql_shown, "readable": sentence}}


def _y_label(agg, column):
    return f"{AGGREGATES[agg]} de {column['name']}" if column else "linhas"


def _by_text(kind, column):
    if kind == "hour" and column["type"] == "time":
        return column["name"]
    return {"month": f"mês de {column['name']}", "year": f"ano de {column['name']}", "quarter": f"trimestre de {column['name']}",
            "week": f"semana de {column['name']}", "day": f"dia de {column['name']}", "weekday": f"dia da semana de {column['name']}",
            "hour": f"hora de {column['name']}"}.get(kind, column["name"])


def _title(agg, y_col, x_col, x_kind, g_col):
    what = {"sum": f"{y_col['name'].capitalize()}" if y_col else "Linhas", "count": "Quantidade", "avg": f"Média de {y_col['name']}" if y_col else "",
            "min": f"Mínimo de {y_col['name']}" if y_col else "", "max": f"Máximo de {y_col['name']}" if y_col else "",
            "unique": f"{y_col['name'].capitalize()} distintos" if y_col else "", "median": f"Mediana de {y_col['name']}" if y_col else ""}[agg]
    where_ = {"month": "por mês", "year": "por ano", "quarter": "por trimestre", "week": "por semana", "day": "por dia", "weekday": "por dia da semana",
              "hour": "por hora"}.get(x_kind, f"por {x_col['name']}" if x_col else "")
    return f"{what} {where_}".strip() + (f" e {g_col['name']}" if g_col else "")  # titles stay short; the sentence says how


def _display_sql(columns, sql, params):
    names = {c["key"]: c["name"] for c in columns}
    shown = re.sub(r'"([cx]\d+)"', lambda m: '"' + names.get(m.group(1), m.group(1)) + '"', sql)
    for value in params:
        shown = shown.replace("?", repr(value) if isinstance(value, str) else str(value), 1)
    return shown


# ------------------------------------------------------------------ pivot tables

def pivot(store, sheet_id, spec):
    """rows x columns of an aggregate, with totals: {rowLabels, colLabels, cells, rowTotals, colTotals, total}."""
    chart = compute(store, sheet_id, {"x": spec["rows"], "by": spec.get("rows_by"), "y": spec.get("value"), "agg": spec.get("agg"),
                                      "group": spec.get("columns"), "group_by": spec.get("columns_by"), "filter": spec.get("filter"),
                                      "sort": spec.get("sort") or "value", "top": spec.get("top"), "basis": spec.get("basis", "auto")})
    cells = [[s["values"][i] for s in chart["series"]] for i in range(len(chart["labels"]))]
    additive = chart["y"]["agg"] in ("sum", "count")
    chart["kind"] = "pivot"
    chart["title"] = spec.get("title") or chart["title"]
    chart["pivot"] = {"rows": chart["labels"], "columns": [s["name"] for s in chart["series"]], "cells": cells,
                      "rowTotals": [sum(v or 0 for v in row) for row in cells] if additive else None,
                      "columnTotals": [sum(row[j] or 0 for row in cells) for j in range(len(chart["series"]))] if additive else None}
    return chart


# ------------------------------------------------------------------ profile of the columns

def profile(store, sheet_id, basis="auto"):
    """Per column: filled, empty, unique, min, max, top values and a small distribution; plus the cell notes."""
    table = store.table(sheet_id, basis)
    total = store.count(sheet_id, basis)
    notes = {}
    for row in store.db.execute("SELECT col, kind, COUNT(*) AS n FROM issues WHERE sheet=? GROUP BY col, kind", (sheet_id,)):
        notes.setdefault(row["col"], {})[row["kind"]] = row["n"]
    result = []
    for column in store.columns(sheet_id, basis):
        key = f'"{column["key"]}"'
        kind = column["type"]
        filled, distinct, low, high = store.db.execute(f"SELECT COUNT({key}), COUNT(DISTINCT {key}), MIN({key}), MAX({key}) FROM {table}").fetchone()
        item = {"key": column["key"], "name": column["name"], "letter": column["letter"], "type": kind, "label": types.LABELS[kind],
                "filled": filled, "empty": total - filled, "unique": distinct, "min": low, "max": high, "notes": notes.get(column["key"], {})}
        if kind in types.NUMERIC and filled:
            item["sum"], item["avg"] = store.db.execute(f"SELECT SUM({key}), AVG({key}) FROM {table}").fetchone()
            if low is not None and high is not None and high > low:
                step = (high - low) / 12
                counts = [0] * 12
                for (index, n) in store.db.execute(f"SELECT MIN(11, CAST(({key} - ?) / ? AS INTEGER)) AS b, COUNT(*) FROM {table} WHERE {key} IS NOT NULL GROUP BY b", (low, step)):
                    counts[int(index)] = n
                item["histogram"] = {"from": low, "step": step, "counts": counts}
        elif kind in ("date", "datetime") and filled:
            item["histogram"] = {"months": [[r[0], r[1]] for r in store.db.execute(f"SELECT strftime('%Y-%m', {key}) AS m, COUNT(*) FROM {table} WHERE {key} IS NOT NULL GROUP BY m ORDER BY m LIMIT 120")]}
        elif kind == "time" and filled:
            item["histogram"] = {"hours": [[r[0], r[1]] for r in store.db.execute(f"SELECT substr({key}, 1, 2) AS h, COUNT(*) FROM {table} WHERE {key} IS NOT NULL GROUP BY h ORDER BY h")]}
        if kind in ("category", "text", "bool") and filled:
            item["top"] = [[r[0], r[1]] for r in store.db.execute(f"SELECT {key}, COUNT(*) AS n FROM {table} WHERE {key} IS NOT NULL GROUP BY {key} ORDER BY n DESC LIMIT 8")]
        result.append(item)
    return {"rows": total, "basis": store.basis(sheet_id, basis), "columns": result}


# ------------------------------------------------------------------ the rows the Studio shows

def rows(store, sheet_id, spec, limit=500):
    """{columns, rows: [[row, ...values]], matched, offset, filter} for the grid, with notes for the cells read from text."""
    basis = store.basis(sheet_id, spec.get("basis", "auto"))
    table = store.table(sheet_id, basis)
    columns = store.columns(sheet_id, basis)
    condition, params, readable = where(store, sheet_id, basis, spec.get("filter"))
    order = "_row"
    if spec.get("sort"):
        text = str(spec["sort"]).strip()
        descending = text.startswith("-") or text.lower().endswith(" desc")
        name = re.sub(r"\s+(desc|asc)$", "", text.lstrip("-+"), flags=re.I)
        column = store.resolve(sheet_id, name, basis)
        order = f'"{column["key"]}" {"DESC" if descending else "ASC"}, _row'
    offset = max(0, int(spec.get("offset") or 0))
    limit = max(1, min(2000, int(spec.get("limit") or limit)))
    matched = store.db.execute(f"SELECT COUNT(*) FROM {table} WHERE {condition}", params).fetchone()[0]
    keys = ", ".join(f'"{c["key"]}"' for c in columns)
    data = [list(r) for r in store.db.execute(f"SELECT _row, {keys} FROM {table} WHERE {condition} ORDER BY {order} LIMIT ? OFFSET ?", params + [limit, offset])]
    notes = {}
    if data:
        shown = [r[0] for r in data]
        for row in store.db.execute(f"SELECT row, col, kind, detail, raw FROM issues WHERE sheet=? AND row IN ({','.join('?' * len(shown))})", [sheet_id] + shown):
            notes.setdefault(str(row["row"]), {})[row["col"]] = [row["kind"], row["detail"], row["raw"]]
    return {"basis": basis, "columns": [{k: c[k] for k in ("key", "name", "letter", "type", "label") if k in c} | {"calculated": bool(c.get("calculated"))} for c in columns],
            "rows": data, "matched": matched, "total": store.count(sheet_id, basis), "offset": offset, "limit": limit, "filter": readable,
            "sort": spec.get("sort"), "notes": notes}


# ------------------------------------------------------------------ read-only SQL

_ALLOWED = {sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ, sqlite3.SQLITE_FUNCTION, getattr(sqlite3, "SQLITE_RECURSIVE", 33)}


def query(store, sheet_id, sql, limit=200, seconds=20, cancelled=None):
    """Runs one SELECT on the view "dados" (the sheet with its real column names). Nothing can be changed."""
    text = str(sql or "").strip().rstrip(";")
    if not re.match(r"^(select|with)\b", text, re.I) or ";" in text:
        raise SheetStudioError("query takes one SELECT on the table dados (the sheet with its column names), such as SELECT servico, SUM(valor) FROM dados GROUP BY servico.")
    basis = store.basis(sheet_id)
    columns = store.columns(sheet_id, basis)
    aliases = ", ".join(f'"{c["key"]}" AS "{c["name"].replace(chr(34), chr(39))}"' for c in columns)
    db = store.db
    db.execute("DROP VIEW IF EXISTS temp.dados")
    db.execute(f"CREATE TEMP VIEW dados AS SELECT _row AS linha, {aliases} FROM {store.table(sheet_id, basis)}")
    deadline = time.time() + seconds

    readable = {f"t_{sheet_id}", f"w_{sheet_id}", "dados"}

    def guard(action, first, *_):
        # Only the sheet itself can be read: not the notes, the steps, the Studio state or sqlite_master.
        if action == sqlite3.SQLITE_READ:
            return sqlite3.SQLITE_OK if first in readable else sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_OK if action in _ALLOWED else sqlite3.SQLITE_DENY

    def progress():
        return 1 if time.time() > deadline or (cancelled is not None and cancelled()) else 0

    db.set_authorizer(guard)
    db.set_progress_handler(progress, 20000)
    try:
        cursor = db.execute(text)
        names = [d[0] for d in cursor.description or []]
        result = cursor.fetchmany(limit + 1)
    except sqlite3.DatabaseError as error:
        message = str(error)
        if "interrupted" in message:
            raise SheetStudioError(f"The query took more than {seconds} s and was stopped; make it simpler or filter first.") from error
        if "not authorized" in message:
            raise SheetStudioError("Only SELECT on dados is allowed.") from error
        raise SheetStudioError(f"SQLite: {message}. The table is dados; its columns are: {', '.join(c['name'] for c in columns)}.") from error
    finally:
        db.set_authorizer(None)
        db.set_progress_handler(None, 0)
    return {"columns": names, "rows": [list(r) for r in result[:limit]], "truncated": len(result) > limit, "basis": basis}
