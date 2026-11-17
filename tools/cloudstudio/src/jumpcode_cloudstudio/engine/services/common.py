# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""What every emulated service shares: callers, the JSON-protocol dispatcher and name checks."""

import json
import re

from .. import wire
from ..wire import AwsError


class Caller:
    """Who is calling, for work the cloud does by itself or on behalf of the agent (no HTTP request)."""

    def __init__(self, account=wire.DEFAULT_ACCOUNT, region=wire.DEFAULT_REGION, source="cloudstudio"):
        self.account = account
        self.region = region
        self.source = source
        self.client = "CloudStudio"
        self.service = ""
        self.op = ""
        self.target = ""
        self.note_req = None
        self.note_res = None
        self.id = wire.request_id()
        self.headers = {}


def json_service(cloud, request, namespace, version, ops, redact=None):
    """Runs one call of a JSON-protocol service (X-Amz-Target: Prefix.Operation)."""
    target = request.headers.get("x-amz-target", "")
    op = target.split(".", 1)[1] if "." in target else ""
    request.op = op
    try:
        handler = ops.get(op)
        if handler is None:
            raise AwsError("UnknownOperationException", f"CloudStudio does not emulate {request.service} {op or 'this operation'} yet.")
        params = request.json()
        request.note_req = redact(op, params, "in") if redact else params
        result = handler(cloud, request, params)
        request.note_res = redact(op, result, "out") if redact else result
        return wire.json_response(result, version)
    except AwsError as error:
        return wire.json_error(error, namespace, version)


def run_json(cloud, caller, ops, op, params):
    """Runs one operation directly (for the agent's actions and the cloud's own work), recording it like a call."""
    import time
    started = time.perf_counter()
    caller.op = op
    error = None
    try:
        return ops[op](cloud, caller, params)
    except AwsError as caught:
        error = caught
        raise
    finally:
        cloud.internal_call(caller.service, op, caller.target, caller.source, (time.perf_counter() - started) * 1000,
                            (error.code, error.message) if error else None, region=caller.region, account=caller.account)


def need(params, *names):
    for name in names:
        if params.get(name) in (None, ""):
            raise AwsError("ValidationException", f"1 validation error detected: Value null at '{_lower(name)}' failed to satisfy constraint: Member must not be null")


def _lower(name):
    return name[:1].lower() + name[1:]


_NAME = re.compile(r"^[A-Za-z0-9_.-]{3,255}$")


def check_name(value, what, pattern=_NAME):
    if not isinstance(value, str) or not pattern.match(value):
        raise AwsError("ValidationException", f"1 validation error detected: Value '{value}' at '{what}' failed to satisfy constraint: "
                       f"Member must satisfy regular expression pattern: {pattern.pattern}")


def short(value, limit=400):
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
    return text if len(text) <= limit else text[:limit] + "…"


def tags_dict(tags):
    """Tags given as [{Key, Value}] or {k: v}."""
    if isinstance(tags, dict):
        return {str(k): str(v) for k, v in tags.items()}
    return {str(tag.get("Key")): str(tag.get("Value", "")) for tag in tags or [] if isinstance(tag, dict) and "Key" in tag}
