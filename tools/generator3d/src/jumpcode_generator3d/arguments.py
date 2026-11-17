# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Checks the model's arguments against the tool's input schema before anything runs. Small models often name an
action or a choice their own way (gerar, abrir, gpu), so the common variants are turned into the right name."""

import copy
import json

from .common import GeneratorError

ACTION_FIELDS = {
    "status": set(), "images": set(), "open": {"path"},
    "generate": {"path", "paths", "model", "name", "folder", "animations", "add", "height", "texture", "faces", "rig", "device", "overwrite"},
    "animations": set(), "models": set(), "show": {"model", "path", "view", "animation", "camera", "bone"},
    "settings": {"height", "texture", "faces", "device", "folder", "animations"},
}
ACTION_ALIASES = {"gerar": "generate", "gera": "generate", "create": "generate", "criar": "generate", "make": "generate", "build": "generate",
                  "regenerate": "generate", "abrir": "open", "check": "open", "verificar": "open", "load": "open", "imagens": "images",
                  "list": "images", "files": "images", "ls": "images", "animacoes": "animations", "animações": "animations", "clips": "animations",
                  "modelos": "models", "history": "models", "historico": "models", "histórico": "models", "mostrar": "show", "focus": "show",
                  "view": "show", "display": "show", "config": "settings", "configuracoes": "settings", "configurações": "settings",
                  "info": "status", "engine": "status"}
DEVICE_ALIASES = {"gpu": "dml", "placa": "dml", "placa de video": "dml", "placa de vídeo": "dml", "directml": "dml", "dml": "dml",
                  "cpu": "cpu", "processador": "cpu", "auto": "auto", "automatico": "auto", "automático": "auto"}
VIEW_ALIASES = {"imagem": "image", "modelo": "model", "model 3d": "model", "esqueleto": "skeleton", "ossos": "skeleton", "bones": "skeleton",
                "weights": "skeleton", "pesos": "skeleton", "animacoes": "animations", "animações": "animations", "animation": "animations",
                "modelos": "models", "gallery": "models", "galeria": "models", "historico": "models", "configuracoes": "settings",
                "configurações": "settings", "inicio": "start", "início": "start", "home": "start"}
CAMERA_ALIASES = {"frente": "front", "lado": "side", "costas": "back", "tras": "back", "trás": "back", "cima": "top", "de cima": "top"}


def ignored_fields(arguments):
    """Fields that are valid in the schema but mean nothing for this action; the action runs without them."""
    return sorted(set(arguments) - {"action", "question"} - ACTION_FIELDS[arguments["action"]])


def _names(value):
    """Animations as a list from a list, a comma-separated text or a list written as text ('["walk", "greeting"]')."""
    if isinstance(value, str):
        text = value.strip()
        if text.startswith("["):
            try:
                parsed = json.loads(text)
                if isinstance(parsed, list):
                    return [str(item).strip() for item in parsed if str(item).strip()]
            except ValueError:
                pass
        parts = text.replace(";", ",").split(",")
        return [part.strip().strip("[]\"' ") for part in parts if part.strip().strip("[]\"' ")]
    return value


def validate(arguments):
    if not isinstance(arguments, dict):
        raise GeneratorError("Arguments must be an object")
    from . import MANIFEST
    arguments = copy.deepcopy(arguments)
    action = arguments.get("action")
    if isinstance(action, str):
        arguments["action"] = ACTION_ALIASES.get(action.strip().lower(), action.strip().lower())
    for key in ("path", "model", "name", "folder", "animation", "bone"):
        if isinstance(arguments.get(key), str):
            arguments[key] = arguments[key].strip()
    # Small models write the animations list in the singular field, often as text; for generate and settings that
    # field means nothing else, so it is the list.
    if arguments.get("action") in ("generate", "settings") and "animation" in arguments and "animations" not in arguments:
        arguments["animations"] = arguments.pop("animation")
    for key in ("animations", "add"):
        if key in arguments:
            arguments[key] = _names(arguments[key])
    if isinstance(arguments.get("paths"), str):
        arguments["paths"] = _names(arguments["paths"])
    if isinstance(arguments.get("device"), str):
        arguments["device"] = DEVICE_ALIASES.get(arguments["device"].strip().lower(), arguments["device"].strip().lower())
    if isinstance(arguments.get("view"), str):
        arguments["view"] = VIEW_ALIASES.get(arguments["view"].strip().lower(), arguments["view"].strip().lower())
    if isinstance(arguments.get("camera"), str):
        arguments["camera"] = CAMERA_ALIASES.get(arguments["camera"].strip().lower(), arguments["camera"].strip().lower())
    if isinstance(arguments.get("texture"), bool):
        arguments["texture"] = 1024 if arguments["texture"] else 0
    if isinstance(arguments.get("height"), str):
        try:
            arguments["height"] = float(arguments["height"].replace(",", ".").replace("m", "").strip())
        except ValueError:
            pass
    # An image given as model is the image: it goes to path (or is dropped when path or paths already name it).
    if arguments.get("action") == "generate" and isinstance(arguments.get("model"), str) \
            and arguments["model"].lower().endswith((".png", ".jpg", ".jpeg", ".webp", ".bmp")):
        image = arguments.pop("model")
        if not arguments.get("path") and not arguments.get("paths"):
            arguments["path"] = image
    if arguments.get("action") == "generate" and isinstance(arguments.get("path"), str) and arguments["path"].lower().endswith(".glb") \
            and "model" not in arguments:
        arguments["model"] = arguments.pop("path")
    if arguments.get("action") == "show" and isinstance(arguments.get("path"), str) and "model" not in arguments:
        arguments["model"] = arguments.pop("path")
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
            raise GeneratorError(f"{where} must be {' or '.join(kind)}")
        kind = next(k for k in kind if _fits(value, k))
    if kind and not _fits(value, kind):
        raise GeneratorError(f"{where} must be {kind}")
    if kind == "object":
        properties = schema.get("properties") or {}
        for name in schema.get("required", []):
            if name not in value:
                raise GeneratorError(f"{where}.{name} is required")
        for name, item in value.items():
            if name not in properties:
                if schema.get("additionalProperties") is False:
                    raise GeneratorError(f"{where}.{name} is not a known field")
                continue
            _check(item, properties[name], f"{where}.{name}")
    elif kind == "array":
        if len(value) > schema.get("maxItems", 1000):
            raise GeneratorError(f"{where} has more than {schema['maxItems']} items")
        for index, item in enumerate(value):
            _check(item, schema.get("items", {}), f"{where}[{index}]")
    elif kind == "string":
        if len(value) > schema.get("maxLength", 10_000):
            raise GeneratorError(f"{where} is longer than {schema['maxLength']} characters")
    elif kind in ("integer", "number"):
        if "minimum" in schema and value < schema["minimum"]:
            raise GeneratorError(f"{where} must be at least {schema['minimum']}")
        if "maximum" in schema and value > schema["maximum"]:
            raise GeneratorError(f"{where} must be at most {schema['maximum']}")
    if "enum" in schema and value not in schema["enum"]:
        raise GeneratorError(f"{where} must be one of: {', '.join(map(str, schema['enum']))}")
