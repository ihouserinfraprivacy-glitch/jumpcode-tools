# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Checks the model's arguments against the tool's input schema before anything runs. Small models often name an
action or a choice their own way (grafico, soma, mês), so the common variants are turned into the right name."""

import copy

from .common import SheetStudioError

ACTION_FIELDS = {
    "status": set(), "files": set(), "open": {"path", "sheet", "header", "separator", "encoding", "decimal", "date_order"}, "sheet": {"sheet", "path"},
    "close": set(), "rows": {"filter", "sort", "offset", "limit", "highlight", "note"}, "profile": {"column"},
    "chart": {"x", "by", "y", "agg", "group", "group_by", "filter", "kind", "top", "sort", "title", "panel"},
    "pivot": {"rows", "rows_by", "columns", "columns_by", "value", "y", "agg", "filter", "title", "top", "sort"},
    "query": {"sql", "title", "limit"}, "panel": {"title", "charts", "numbers"}, "remove": {"chart"}, "problems": set(), "fix": {"which"},
    "undo": {"step"}, "step": {"kind", "column", "old", "new", "value", "filter"}, "column": {"name", "from", "part", "expression", "type"},
    "export": {"what", "format", "chart", "folder", "filter", "style"}, "settings": {"decimal", "date_order", "style", "folder", "limit"},
    "focus": {"view", "select", "note"},
}
for _fields in ACTION_FIELDS.values():
    _fields.add("question")
ACTION_ALIASES = {"grafico": "chart", "gráfico": "chart", "graph": "chart", "plot": "chart", "bar": "chart", "abrir": "open", "load": "open",
                  "read": "open", "list": "files", "arquivos": "files", "ls": "files", "tabela": "pivot", "table": "pivot", "dinamica": "pivot",
                  "sql": "query", "consulta": "query", "dashboard": "panel", "painel": "panel", "clean": "problems", "limpeza": "problems",
                  "check": "problems", "apply": "fix", "corrigir": "fix", "desfazer": "undo", "filter": "rows", "filtrar": "rows", "show": "rows",
                  "describe": "profile", "perfil": "profile", "exportar": "export", "save": "export", "info": "status", "tab": "sheet", "aba": "sheet"}


def ignored_fields(arguments):
    """Fields that are valid in the schema but mean nothing for this action; the action runs without them."""
    return sorted(set(arguments) - {"action"} - ACTION_FIELDS[arguments["action"]])


def validate(arguments):
    if not isinstance(arguments, dict):
        raise SheetStudioError("Arguments must be an object")
    from . import MANIFEST
    arguments = copy.deepcopy(arguments)
    action = arguments.get("action")
    if isinstance(action, str):
        arguments["action"] = ACTION_ALIASES.get(action.strip().lower(), action.strip().lower())
    for key in ("x", "y", "group", "column", "rows", "columns", "value", "path", "sheet"):
        if isinstance(arguments.get(key), str):
            arguments[key] = arguments[key].strip()
    if arguments.get("action") == "chart" and arguments.get("y") and not arguments.get("x") and arguments.get("group"):
        arguments["x"] = arguments.pop("group")
    _check(arguments, MANIFEST["inputSchema"], "arguments")
    return arguments


def _check(value, schema, where):
    kind = schema.get("type")
    if isinstance(kind, list):
        if not any(_fits(value, k) for k in kind):
            raise SheetStudioError(f"{where} must be {' or '.join(kind)}")
        kind = next(k for k in kind if _fits(value, k))
    if kind == "object":
        if not isinstance(value, dict):
            raise SheetStudioError(f"{where} must be an object")
        properties = schema.get("properties") or {}
        for name in schema.get("required", []):
            if name not in value:
                raise SheetStudioError(f"{where}.{name} is required")
        for name, item in value.items():
            if name not in properties:
                if schema.get("additionalProperties") is False:
                    raise SheetStudioError(f"{where}.{name} is not a known field")
                continue
            _check(item, properties[name], f"{where}.{name}")
    elif kind == "array":
        if not isinstance(value, list):
            raise SheetStudioError(f"{where} must be a list")
        if len(value) > schema.get("maxItems", 1000):
            raise SheetStudioError(f"{where} has more than {schema['maxItems']} items")
        for index, item in enumerate(value):
            _check(item, schema.get("items", {}), f"{where}[{index}]")
    elif kind == "string":
        if not isinstance(value, str):
            raise SheetStudioError(f"{where} must be text")
        if len(value) > schema.get("maxLength", 100000):
            raise SheetStudioError(f"{where} is longer than {schema['maxLength']} characters")
    elif kind in ("integer", "number"):
        if not _fits(value, kind):
            raise SheetStudioError(f"{where} must be a {'whole ' if kind == 'integer' else ''}number")
        if value < schema.get("minimum", value) or value > schema.get("maximum", value):
            raise SheetStudioError(f"{where} must be between {schema.get('minimum')} and {schema.get('maximum')}")
    elif kind == "boolean":
        if not isinstance(value, bool):
            raise SheetStudioError(f"{where} must be true or false")
    if "enum" in schema and value not in schema["enum"]:
        raise SheetStudioError(f"{where} must be one of {', '.join(map(str, schema['enum']))}")


def _fits(value, kind):
    if kind == "string":
        return isinstance(value, str)
    if kind == "array":
        return isinstance(value, list)
    if kind == "object":
        return isinstance(value, dict)
    if kind == "boolean":
        return isinstance(value, bool)
    if kind == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if kind == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    return True
