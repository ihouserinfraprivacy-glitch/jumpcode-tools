# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""AWS Systems Manager Parameter Store (JSON 1.1): String, StringList and SecureString parameters with
versions and paths. SecureString values are hidden from the call history and the Studio."""

import base64
import time

from .. import wire
from ..wire import AwsError
from .common import json_service

NAME = "ssm"
LABEL = "Parameter Store"
HIDDEN = "••••••"


def handle(cloud, request):
    def redact_call(op, value, direction):
        current = parameters(cloud, request.account, request.region).get(_name(value.get("Name"))) if isinstance(value, dict) else None
        secure = bool(current and current["type"] == "SecureString")
        return redact(op, value, direction, secure)
    return json_service(cloud, request, "", "1.1", OPS, redact_call)


def redact(op, value, direction, secure=False):
    if not isinstance(value, dict):
        return value
    result = dict(value)
    if op == "PutParameter" and direction == "in" and (secure or result.get("Type") == "SecureString"):
        result["Value"] = HIDDEN
    for key in ("Parameter",):
        if isinstance(result.get(key), dict) and result[key].get("Type") == "SecureString":
            result[key] = {**result[key], "Value": HIDDEN}
    if isinstance(result.get("Parameters"), list):
        result["Parameters"] = [{**p, "Value": HIDDEN} if p.get("Type") == "SecureString" else p for p in result["Parameters"]]
    return result


def parameters(cloud, account, region):
    return cloud.store.regional(account, region, NAME).setdefault("parameters", {})


def _arn(caller_region, account, name):
    return wire.arn("ssm", caller_region, account, f"parameter{name if name.startswith('/') else '/' + name}")


def _name(value):
    value = str(value or "")
    if value.startswith("arn:"):
        value = value.split(":parameter", 1)[-1]
    return value


def put_parameter(cloud, caller, params):
    name = _name(params.get("Name"))
    caller.target = name
    if not name or len(name) > 2048:
        raise AwsError("ValidationException", "Parameter name must not be empty.")
    if params.get("Value") in (None, ""):
        raise AwsError("ValidationException", "1 validation error detected: Value '' at 'value' failed to satisfy constraint: Member must have length greater than or equal to 1")
    existing = parameters(cloud, caller.account, caller.region)
    current = existing.get(name)
    if current and not params.get("Overwrite"):
        raise AwsError("ParameterAlreadyExists", "The parameter already exists. To overwrite this value, set the overwrite option in the request to true.")
    kind = params.get("Type") or (current["type"] if current else "String")
    if kind not in ("String", "StringList", "SecureString"):
        raise AwsError("ValidationException", f"1 validation error detected: Value '{kind}' at 'type' failed to satisfy constraint: Member must satisfy enum value set: [SecureString, StringList, String]")
    version = (current["version"] + 1) if current else 1
    history = (current.get("history", []) + [{k: current[k] for k in ("value", "version", "modified", "type")}])[-20:] if current else []
    existing[name] = {"name": name, "type": kind, "value": params["Value"], "version": version, "modified": time.time(),
                      "description": params.get("Description", current.get("description", "") if current else ""),
                      "arn": _arn(caller.region, caller.account, name), "tier": params.get("Tier") or "Standard",
                      "dataType": params.get("DataType") or "text", "tags": current.get("tags", {}) if current else
                      {t["Key"]: t["Value"] for t in params.get("Tags") or []}, "history": history}
    cloud.store.touch()
    return {"Version": version, "Tier": existing[name]["tier"]}


def _view(parameter, decrypt):
    value = parameter["value"]
    if parameter["type"] == "SecureString" and not decrypt:
        value = base64.b64encode(f"cloudstudio-kms:{len(value)}".encode()).decode()
    return {"Name": parameter["name"], "Type": parameter["type"], "Value": value, "Version": parameter["version"],
            "LastModifiedDate": parameter["modified"], "ARN": parameter["arn"], "DataType": parameter["dataType"]}


def _find(cloud, caller, name):
    plain = _name(name).split(":")[0]
    caller.target = plain
    found = parameters(cloud, caller.account, caller.region).get(plain)
    if found is None:
        raise AwsError("ParameterNotFound", f"Parameter {plain} not found.")
    return found


def get_parameter(cloud, caller, params):
    return {"Parameter": _view(_find(cloud, caller, params.get("Name")), params.get("WithDecryption"))}


def get_parameters(cloud, caller, params):
    found, invalid = [], []
    for name in params.get("Names") or []:
        try:
            found.append(_view(_find(cloud, caller, name), params.get("WithDecryption")))
        except AwsError:
            invalid.append(name)
    caller.target = ", ".join(params.get("Names") or [])[:120]
    return {"Parameters": found, "InvalidParameters": invalid}


def get_parameters_by_path(cloud, caller, params):
    path = params.get("Path") or "/"
    caller.target = path
    prefix = path if path.endswith("/") else path + "/"
    found = []
    for name, parameter in sorted(parameters(cloud, caller.account, caller.region).items()):
        if not name.startswith(prefix):
            continue
        if not params.get("Recursive") and "/" in name[len(prefix):]:
            continue
        found.append(_view(parameter, params.get("WithDecryption")))
    return {"Parameters": found[: int(params.get("MaxResults") or 10)] if params.get("MaxResults") else found}


def delete_parameter(cloud, caller, params):
    parameter = _find(cloud, caller, params.get("Name"))
    del parameters(cloud, caller.account, caller.region)[parameter["name"]]
    cloud.store.touch()
    return {}


def delete_parameters(cloud, caller, params):
    deleted, invalid = [], []
    for name in params.get("Names") or []:
        if parameters(cloud, caller.account, caller.region).pop(_name(name), None) is not None:
            deleted.append(name)
        else:
            invalid.append(name)
    cloud.store.touch()
    return {"DeletedParameters": deleted, "InvalidParameters": invalid}


def describe_parameters(cloud, caller, params):
    found = []
    for name, parameter in sorted(parameters(cloud, caller.account, caller.region).items()):
        keep = True
        for rule in (params.get("ParameterFilters") or []) + (params.get("Filters") or []):
            key, values = rule.get("Key"), rule.get("Values") or []
            option = rule.get("Option", "Equals")
            if key == "Name":
                keep &= any(name.startswith(v) if option == "BeginsWith" else name == v for v in values)
            elif key == "Path":
                keep &= any(name.startswith(v.rstrip("/") + "/") for v in values)
            elif key == "Type":
                keep &= parameter["type"] in values
        if keep:
            found.append({"Name": name, "Type": parameter["type"], "LastModifiedDate": parameter["modified"], "Version": parameter["version"],
                          "Description": parameter.get("description", ""), "Tier": parameter["tier"], "DataType": parameter["dataType"],
                          "ARN": parameter["arn"], "Policies": []})
    return {"Parameters": found}


def get_parameter_history(cloud, caller, params):
    parameter = _find(cloud, caller, params.get("Name"))
    entries = parameter.get("history", []) + [{k: parameter[k] for k in ("value", "version", "modified", "type")}]
    return {"Parameters": [{"Name": parameter["name"], "Type": e["type"], "Value": e["value"] if e["type"] != "SecureString" or params.get("WithDecryption") else HIDDEN,
                            "Version": e["version"], "LastModifiedDate": e["modified"], "Tier": parameter["tier"], "DataType": parameter["dataType"]}
                           for e in entries]}


def add_tags(cloud, caller, params):
    parameter = _find(cloud, caller, params.get("ResourceId"))
    parameter.setdefault("tags", {}).update({t["Key"]: t["Value"] for t in params.get("Tags") or []})
    cloud.store.touch()
    return {}


def list_tags(cloud, caller, params):
    parameter = _find(cloud, caller, params.get("ResourceId"))
    return {"TagList": [{"Key": k, "Value": v} for k, v in parameter.get("tags", {}).items()]}


def remove_tags(cloud, caller, params):
    parameter = _find(cloud, caller, params.get("ResourceId"))
    for key in params.get("TagKeys") or []:
        parameter.setdefault("tags", {}).pop(key, None)
    cloud.store.touch()
    return {}


OPS = {
    "PutParameter": put_parameter, "GetParameter": get_parameter, "GetParameters": get_parameters,
    "GetParametersByPath": get_parameters_by_path, "DeleteParameter": delete_parameter, "DeleteParameters": delete_parameters,
    "DescribeParameters": describe_parameters, "GetParameterHistory": get_parameter_history,
    "AddTagsToResource": add_tags, "ListTagsForResource": list_tags, "RemoveTagsFromResource": remove_tags,
}


def resources(cloud):
    result = []
    for account, region, service in cloud.store.each(NAME):
        for parameter in service.get("parameters", {}).values():
            secure = parameter["type"] == "SecureString"
            result.append({"service": NAME, "kind": "parameter", "name": parameter["name"], "arn": parameter["arn"], "account": account,
                           "region": region, "created": parameter["modified"], "type": parameter["type"], "version": parameter["version"],
                           "value": None if secure else parameter["value"][:500], "size": len(parameter["value"]),
                           "description": parameter.get("description", "")})
    return result
