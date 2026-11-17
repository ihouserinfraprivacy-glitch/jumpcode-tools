# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Checks the model's arguments against the tool's input schema before anything runs."""

import copy

from .common import CloudStudioError

ACTION_FIELDS = {
    "status": set(), "start": {"storage", "region"}, "stop": set(),
    "create": {"service", "name", "key", "keyType", "sort", "sortType", "indexes", "ttl", "items", "folder", "handler", "runtime", "env",
               "timeout", "queue", "batch", "deadLetter", "routes", "cors", "dlq", "maxReceives", "fifo", "visibility", "subscribe",
               "fromEnv", "value", "secure", "expression", "timezone", "target", "input", "pattern", "targets", "bus", "definition"},
    "remove": {"service", "name"}, "invoke": {"name", "event"}, "send": {"queue", "topic", "bus", "message"},
    "request": {"api", "method", "path", "body"}, "calls": {"errors", "service", "name", "limit"}, "logs": {"name", "limit"},
    "env": set(), "snapshot": {"name"}, "restore": {"name"}, "reset": set(), "run": {"name", "input"}, "focus": {"view", "select", "note"},
}
for _action in ("create", "remove", "invoke", "send", "request", "run", "calls", "logs", "focus"):
    ACTION_FIELDS[_action].update(("account", "region"))


def validate(arguments):
    if not isinstance(arguments, dict):
        raise CloudStudioError("Arguments must be an object")
    from . import MANIFEST
    schema = MANIFEST["inputSchema"]
    _check(arguments, schema, "arguments")
    action = arguments["action"]
    if "account" in arguments and (len(arguments["account"]) != 12 or not arguments["account"].isascii() or not arguments["account"].isdigit()):
        raise CloudStudioError("account must contain 12 digits")
    extra = set(arguments) - {"action"} - ACTION_FIELDS[action]
    if extra:
        raise CloudStudioError(f"{action} does not take {', '.join(sorted(extra))}")
    return copy.deepcopy(arguments)


def _check(value, schema, where):
    kind = schema.get("type")
    if kind == "object":
        if not isinstance(value, dict):
            raise CloudStudioError(f"{where} must be an object")
        properties = schema.get("properties")
        for name in schema.get("required", []):
            if name not in value:
                raise CloudStudioError(f"{where}.{name} is required")
        if properties is not None:
            for name, item in value.items():
                if name not in properties:
                    if schema.get("additionalProperties") is False:
                        raise CloudStudioError(f"{where}.{name} is not a known field")
                    continue
                _check(item, properties[name], f"{where}.{name}")
        elif isinstance(schema.get("additionalProperties"), dict):
            for name, item in value.items():
                _check(item, schema["additionalProperties"], f"{where}.{name}")
    elif kind == "array":
        if not isinstance(value, list):
            raise CloudStudioError(f"{where} must be a list")
        if len(value) > schema.get("maxItems", 1000):
            raise CloudStudioError(f"{where} has more than {schema['maxItems']} items")
        for index, item in enumerate(value):
            _check(item, schema.get("items", {}), f"{where}[{index}]")
    elif kind == "string":
        if not isinstance(value, str):
            raise CloudStudioError(f"{where} must be text")
        if len(value) > schema.get("maxLength", 100000):
            raise CloudStudioError(f"{where} is longer than {schema['maxLength']} characters")
    elif kind == "integer":
        if not isinstance(value, int) or isinstance(value, bool):
            raise CloudStudioError(f"{where} must be a whole number")
        if value < schema.get("minimum", value) or value > schema.get("maximum", value):
            raise CloudStudioError(f"{where} must be between {schema.get('minimum')} and {schema.get('maximum')}")
    elif kind == "boolean":
        if not isinstance(value, bool):
            raise CloudStudioError(f"{where} must be true or false")
    if "enum" in schema and value not in schema["enum"]:
        raise CloudStudioError(f"{where} must be one of {', '.join(map(str, schema['enum']))}")
