# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Checks the model's arguments against the tool's input schema before anything runs. Small models often
spell a gateway or a scenario their own way, so the common variants are accepted and turned into the right name."""

import copy
import re

from .common import PayStudioError

ACTION_FIELDS = {
    "status": set(), "start": {"storage"}, "stop": set(), "webhook": {"gateway", "url"}, "env": set(),
    "charges": {"status", "gateway", "limit"}, "charge": {"ref", "gateway"}, "pay": {"ref", "gateway", "delay", "duplicate"},
    "expire": {"ref", "gateway"}, "refund": {"ref", "gateway", "amount"}, "dispute": {"ref", "gateway", "reason"},
    "scenario": {"name"}, "rule": {"gateway", "kind", "seconds", "copies", "reason", "times"},
    "failure": {"gateway", "mode", "rate", "latency", "calls", "seconds"}, "clear": {"which"}, "resend": {"id"},
    "check": {"gateway"}, "calls": {"errors", "limit"}, "webhooks": {"errors", "limit"}, "reset": set(), "focus": {"view", "select", "note"},
}
_GATEWAY_ALIASES = {"mercado_pago": "mercadopago", "mercado-pago": "mercadopago", "mercado pago": "mercadopago", "mp": "mercadopago",
                    "mercadopago": "mercadopago", "pix": "pix", "api pix": "pix", "bacen": "pix", "stripe": "stripe", "any": "any",
                    "todos": "any", "all": "any"}


def ignored_fields(arguments):
    """Fields that are valid in the schema but mean nothing for this action; the action runs without them."""
    return sorted(set(arguments) - {"action"} - ACTION_FIELDS[arguments["action"]])


def validate(arguments):
    if not isinstance(arguments, dict):
        raise PayStudioError("Arguments must be an object")
    from . import MANIFEST
    arguments = copy.deepcopy(arguments)
    if isinstance(arguments.get("gateway"), str):
        arguments["gateway"] = _GATEWAY_ALIASES.get(arguments["gateway"].strip().lower(), arguments["gateway"])
    if arguments.get("action") == "scenario" and isinstance(arguments.get("name"), str):
        arguments["name"] = re.sub(r"[\s-]+", "_", arguments["name"].strip().lower())
    if isinstance(arguments.get("ref"), str):
        arguments["ref"] = arguments["ref"].strip()
    _check(arguments, MANIFEST["inputSchema"], "arguments")
    return arguments


def _check(value, schema, where):
    kind = schema.get("type")
    if kind == "object":
        if not isinstance(value, dict):
            raise PayStudioError(f"{where} must be an object")
        properties = schema.get("properties") or {}
        for name in schema.get("required", []):
            if name not in value:
                raise PayStudioError(f"{where}.{name} is required")
        for name, item in value.items():
            if name not in properties:
                if schema.get("additionalProperties") is False:
                    raise PayStudioError(f"{where}.{name} is not a known field")
                continue
            _check(item, properties[name], f"{where}.{name}")
    elif kind == "string":
        if not isinstance(value, str):
            raise PayStudioError(f"{where} must be text")
        if len(value) > schema.get("maxLength", 100000):
            raise PayStudioError(f"{where} is longer than {schema['maxLength']} characters")
    elif kind in ("integer", "number"):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or (kind == "integer" and not float(value).is_integer()):
            raise PayStudioError(f"{where} must be a {'whole ' if kind == 'integer' else ''}number")
        if value < schema.get("minimum", value) or value > schema.get("maximum", value):
            raise PayStudioError(f"{where} must be between {schema.get('minimum')} and {schema.get('maximum')}")
    elif kind == "boolean":
        if not isinstance(value, bool):
            raise PayStudioError(f"{where} must be true or false")
    if "enum" in schema and value not in schema["enum"]:
        raise PayStudioError(f"{where} must be one of {', '.join(map(str, schema['enum']))}")
