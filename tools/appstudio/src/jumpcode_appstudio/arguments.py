# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Checks the model's arguments against the tool's input schema before anything runs. Small models often name an
action or a field their own way (or the WebStudio way: write_section, page, section), so the common variants are
turned into the right name."""

import copy
import json

from .common import AppStudioError

THEME = {"primary", "accent", "background", "surface", "text", "muted", "font", "radius", "icon"}
ACTION_FIELDS = {
    "status": set(), "start": {"name", "folder"} | THEME, "screen": {"screen", "title", "kind", "route", "login", "plan", "first"},
    "tabs": {"items"}, "write_part": {"screen", "part", "html"}, "write_styles": {"name", "css"}, "data": {"collection", "rows"},
    "theme": {"name"} | THEME, "read": {"screen", "part", "name"}, "remove": {"screen", "part", "name", "tab", "collection"},
    "check": set(), "versions": set(), "restore": {"version"},
    "show": {"view", "screen", "part", "state", "device", "frame", "fold", "landscape"}, "publish": {"capacitor", "app_id"},
}
ACTION_ALIASES = {"create": "start", "new": "start", "criar": "start", "init": "start", "add_screen": "screen", "new_screen": "screen",
                  "tela": "screen", "page": "screen", "write_section": "write_part", "write": "write_part", "section": "write_part",
                  "part": "write_part", "add_part": "write_part", "parte": "write_part", "styles": "write_styles", "css": "write_styles",
                  "style": "write_styles", "estilos": "write_styles", "remove_section": "remove", "remove_page": "remove",
                  "delete": "remove", "apagar": "remove", "undo": "restore", "desfazer": "restore", "voltar": "restore",
                  "focus": "show", "preview": "show", "view": "show", "mostrar": "show", "export": "publish", "build": "publish",
                  "publicar": "publish", "list": "status", "info": "status", "outline": "status", "problems": "check",
                  "verificar": "check", "history": "versions", "historico": "versions", "colors": "theme", "cores": "theme",
                  "tema": "theme", "dados": "data", "abas": "tabs"}
FIELD_ALIASES = {"page": "screen", "tela": "screen", "section": "part", "parte": "part", "content": "html", "markup": "html",
                 "styles": "css", "id": None, "label": "title", "type": "kind", "parts": "plan", "colecao": "collection",
                 "tabs": "items", "dispositivo": "device", "aparelho": "device"}
VIEW_ALIASES = {"previa": "preview", "prévia": "preview", "telas": "screens", "mapa": "map", "rotas": "map", "estrutura": "structure",
                "testar": "test", "usar": "test", "estados": "states", "problemas": "problems", "versoes": "versions",
                "versões": "versions", "publicar": "publish", "configuracoes": "settings", "configurações": "settings"}
DEVICE_ALIASES = {"ios": "iphone", "apple": "iphone", "celular": "iphone", "phone": "iphone", "pixel": "android", "samsung": "android",
                  "ipad": "tablet", "tab": "tablet", "fold": "android-fold", "dobravel": "android-fold", "dobrável": "android-fold",
                  "iphone dobravel": "iphone-fold", "iphone dobrável": "iphone-fold", "android dobravel": "android-fold",
                  "android dobrável": "android-fold", "iphone_fold": "iphone-fold", "android_fold": "android-fold"}
KIND_ALIASES = {"aba": "tab", "tabs": "tab", "pilha": "stack", "page": "stack", "screen": "stack", "push": "stack", "sheet": "modal",
                "dialog": "modal", "janela": "modal"}


def ignored_fields(arguments):
    """Fields that are valid in the schema but mean nothing for this action; the action runs without them."""
    return sorted(set(arguments) - {"action", "question"} - ACTION_FIELDS[arguments["action"]])


def _list(value):
    if isinstance(value, str):
        text = value.strip()
        if text.startswith("["):
            try:
                parsed = json.loads(text)
                if isinstance(parsed, list):
                    return parsed
            except ValueError:
                pass
        return [part.strip().strip("[]\"' ") for part in text.replace(";", ",").split(",") if part.strip().strip("[]\"' ")]
    return value


def validate(arguments):
    if not isinstance(arguments, dict):
        raise AppStudioError("Arguments must be an object")
    from . import MANIFEST
    arguments = copy.deepcopy(arguments)
    action = arguments.get("action")
    if isinstance(action, str):
        arguments["action"] = ACTION_ALIASES.get(action.strip().lower(), action.strip().lower())
    for alias, field in FIELD_ALIASES.items():
        if alias in arguments and field and field not in arguments:
            arguments[field] = arguments.pop(alias)
    if "id" in arguments:
        value = arguments.pop("id")
        target = "part" if arguments.get("action") == "write_part" else "screen"
        arguments.setdefault(target, value)
    for key in ("screen", "part", "name", "collection", "tab"):
        if isinstance(arguments.get(key), str):
            arguments[key] = arguments[key].strip()
    if "plan" in arguments:
        arguments["plan"] = _list(arguments["plan"])
    if isinstance(arguments.get("items"), str):
        try:
            arguments["items"] = json.loads(arguments["items"])
        except ValueError:
            arguments["items"] = [{"screen": name} for name in _list(arguments["items"])]
    if isinstance(arguments.get("rows"), str):
        try:
            arguments["rows"] = json.loads(arguments["rows"])
        except ValueError:
            pass
    if isinstance(arguments.get("view"), str):
        arguments["view"] = VIEW_ALIASES.get(arguments["view"].strip().lower(), arguments["view"].strip().lower())
    if isinstance(arguments.get("device"), str):
        key = arguments["device"].strip().lower()
        arguments["device"] = DEVICE_ALIASES.get(key, key)
    if isinstance(arguments.get("kind"), str):
        key = arguments["kind"].strip().lower()
        arguments["kind"] = KIND_ALIASES.get(key, key)
    if isinstance(arguments.get("fold"), str):
        arguments["fold"] = {"aberto": "open", "fechado": "closed"}.get(arguments["fold"].strip().lower(), arguments["fold"].strip().lower())
    if isinstance(arguments.get("version"), str) and arguments["version"].strip().isdigit():
        arguments["version"] = int(arguments["version"])
    _check(arguments, MANIFEST["inputSchema"], "arguments")
    return arguments


def _fits(value, kind):
    return {"object": isinstance(value, dict), "array": isinstance(value, list), "string": isinstance(value, str),
            "boolean": isinstance(value, bool), "integer": isinstance(value, int) and not isinstance(value, bool),
            "number": isinstance(value, (int, float)) and not isinstance(value, bool), "null": value is None}.get(kind, True)


def _check(value, schema, where):
    kind = schema.get("type")
    if isinstance(kind, list):
        if not any(_fits(value, k) for k in kind):
            raise AppStudioError(f"{where} must be {' or '.join(kind)}")
        kind = next(k for k in kind if _fits(value, k))
    if kind and not _fits(value, kind):
        raise AppStudioError(f"{where} must be {kind}")
    if kind == "object":
        properties = schema.get("properties") or {}
        for name in schema.get("required", []):
            if name not in value:
                raise AppStudioError(f"{where}.{name} is required")
        for name, item in value.items():
            if name not in properties:
                if schema.get("additionalProperties") is False:
                    raise AppStudioError(f"{where}.{name} is not a known field")
                continue
            _check(item, properties[name], f"{where}.{name}")
    elif kind == "array":
        if len(value) > schema.get("maxItems", 1000):
            raise AppStudioError(f"{where} has more than {schema['maxItems']} items")
        for index, item in enumerate(value):
            _check(item, schema.get("items", {}), f"{where}[{index}]")
    elif kind == "string":
        if len(value) > schema.get("maxLength", 100_000):
            raise AppStudioError(f"{where} is longer than {schema['maxLength']} characters; split it into smaller parts")
    elif kind in ("integer", "number"):
        if "minimum" in schema and value < schema["minimum"]:
            raise AppStudioError(f"{where} must be at least {schema['minimum']}")
        if "maximum" in schema and value > schema["maximum"]:
            raise AppStudioError(f"{where} must be at most {schema['maximum']}")
    if "enum" in schema and value not in schema["enum"]:
        raise AppStudioError(f"{where} must be one of: {', '.join(map(str, schema['enum']))}")
