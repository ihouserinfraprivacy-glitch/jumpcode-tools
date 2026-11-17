# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""AWS wire formats the emulator speaks: errors, JSON, query/XML and REST helpers."""

import base64
from datetime import datetime, timezone
import hashlib
import json
import time
import uuid
from xml.sax.saxutils import escape

DEFAULT_ACCOUNT = "000000000000"
DEFAULT_REGION = "us-east-1"


class AwsError(Exception):
    """An error returned to the caller exactly as AWS would name it."""

    def __init__(self, code, message, status=400, sender=True, query_code=None, extra=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.sender = sender
        # SQS's JSON protocol also reports the legacy query error code that SDKs match on.
        self.query_code = query_code
        self.extra = extra or {}


def not_found(code, message):
    return AwsError(code, message, 404 if code.startswith("NoSuch") else 400)


def validation(message):
    return AwsError("ValidationException", message)


class Response:
    __slots__ = ("status", "headers", "body")

    def __init__(self, status=200, body=b"", headers=None):
        self.status = status
        self.body = body if isinstance(body, bytes) else body.encode("utf-8")
        self.headers = dict(headers or {})


def request_id():
    return str(uuid.uuid4())


def now():
    return time.time()


def iso(ts=None, millis=True):
    value = datetime.fromtimestamp(ts if ts is not None else time.time(), tz=timezone.utc)
    text = value.strftime("%Y-%m-%dT%H:%M:%S")
    return text + (f".{value.microsecond // 1000:03d}Z" if millis else "Z")


def http_date(ts=None):
    value = datetime.fromtimestamp(ts if ts is not None else time.time(), tz=timezone.utc)
    return value.strftime("%a, %d %b %Y %H:%M:%S GMT")


def md5_hex(data):
    return hashlib.md5(data, usedforsecurity=False).hexdigest()


def arn(service, region, account, resource):
    return f"arn:aws:{service}:{region}:{account}:{resource}"


def b64(data):
    return base64.b64encode(data).decode("ascii")


# ---------------------------------------------------------------- JSON protocol (DynamoDB, SQS, SSM, ...)

def json_response(value, version="1.0", status=200, headers=None):
    body = json.dumps(value, separators=(",", ":"), ensure_ascii=False, default=_json_default)
    return Response(status, body, {"Content-Type": f"application/x-amz-json-{version}", **(headers or {})})


def json_error(error, namespace, version="1.0"):
    headers = {"x-amzn-ErrorType": error.code}
    if error.query_code:
        headers["x-amzn-query-error"] = f"{error.query_code};{'Sender' if error.sender else 'Receiver'}"
    body = {"__type": f"{namespace}#{error.code}" if namespace else error.code, "message": error.message, **error.extra}
    return json_response(body, version, error.status, headers)


def rest_json(value, status=200, headers=None):
    body = b"" if value is None else json.dumps(value, separators=(",", ":"), ensure_ascii=False, default=_json_default)
    return Response(status, body, {"Content-Type": "application/json", **(headers or {})})


def rest_json_error(error):
    return rest_json({"message": error.message, "Message": error.message, "Type": "User" if error.sender else "Service", **error.extra},
                     error.status, {"x-amzn-ErrorType": error.code})


def _json_default(value):
    if isinstance(value, bytes):
        return b64(value)
    if isinstance(value, set):
        return sorted(value)
    raise TypeError(f"Not JSON serializable: {type(value).__name__}")


# ---------------------------------------------------------------- XML (S3 REST-XML and the query protocol)

def xml_value(value):
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return escape(str(value))


def xml(tag, content, attrs=""):
    """Builds XML from nested dicts and lists: a list repeats the tag, a dict nests elements."""
    if content is None:
        return ""
    if isinstance(content, list):
        return "".join(xml(tag, item, attrs) for item in content)
    head = f"<{tag}{(' ' + attrs) if attrs else ''}>"
    if isinstance(content, dict):
        return head + "".join(xml(k, v) for k, v in content.items()) + f"</{tag}>"
    if isinstance(content, Raw):
        return head + content.text + f"</{tag}>"
    return head + xml_value(content) + f"</{tag}>"


class Raw:
    """Already-serialized XML inside a builder value."""

    __slots__ = ("text",)

    def __init__(self, text):
        self.text = text


def xml_response(tag, content, namespace=None, status=200, headers=None):
    body = '<?xml version="1.0" encoding="UTF-8"?>' + xml(tag, content, f'xmlns="{namespace}"' if namespace else "")
    return Response(status, body, {"Content-Type": "application/xml", **(headers or {})})


def query_response(action, result, namespace, rid):
    """A query-protocol answer: <ActionResponse><ActionResult>..</ActionResult><ResponseMetadata/></ActionResponse>."""
    inner = {} if result is None else {f"{action}Result": result}
    inner["ResponseMetadata"] = {"RequestId": rid}
    return xml_response(f"{action}Response", inner, namespace)


def query_error(error, namespace, rid):
    body = {"Error": {"Type": "Sender" if error.sender else "Receiver", "Code": error.code, "Message": error.message}, "RequestId": rid}
    return xml_response("ErrorResponse", body, namespace, error.status)


def flatten_query(form):
    """Turns query-protocol keys (Attributes.entry.1.key) into nested values: lists for .N and .member.N, dicts for .entry.N."""
    root = {}
    for key, value in form.items():
        parts = key.split(".")
        node = root
        for index, part in enumerate(parts):
            last = index == len(parts) - 1
            if last:
                node[part] = value
            else:
                node = node.setdefault(part, {})
                if not isinstance(node, dict):
                    break
    return _shape_query(root)


def _shape_query(node):
    if not isinstance(node, dict):
        return node
    if "member" in node and isinstance(node["member"], dict) and len(node) == 1:
        return [_shape_query(v) for _, v in sorted(node["member"].items(), key=lambda kv: _int(kv[0]))]
    if "entry" in node and isinstance(node["entry"], dict) and len(node) == 1:
        result = {}
        for _, entry in sorted(node["entry"].items(), key=lambda kv: _int(kv[0])):
            if isinstance(entry, dict):
                key = entry.get("key", entry.get("Name"))
                value = entry.get("value", entry.get("Value"))
                if key is not None:
                    result[key] = _shape_query(value)
        return result
    if node and all(k.isdigit() for k in node):
        return [_shape_query(v) for _, v in sorted(node.items(), key=lambda kv: _int(kv[0]))]
    return {k: _shape_query(v) for k, v in node.items()}


def _int(text):
    try:
        return int(text)
    except ValueError:
        return 0
