# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""AWS Lambda (REST-JSON): functions from a zip, an S3 object or a folder of this computer (read on every call),
synchronous and asynchronous invocations, queue triggers, permissions, tags and dead-letter targets."""

import base64
import hashlib
import io
import json
from pathlib import Path
import re
import time
import uuid
import zipfile
from urllib.parse import urlencode

from .. import wire
from ..wire import AwsError, Response

NAME = "lambda"
LABEL = "Lambda"
RUNTIMES = ("python3.9", "python3.10", "python3.11", "python3.12", "python3.13", "python3.14",
            "nodejs18.x", "nodejs20.x", "nodejs22.x", "nodejs24.x")
_PATH = re.compile(r"^/(?P<version>\d{4}-\d{2}-\d{2})/(?P<kind>functions|event-source-mappings|tags|account-settings)/?(?P<rest>.*)$")
_FUNCTION = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def handle(cloud, request):
    try:
        return route(cloud, request)
    except AwsError as error:
        return wire.rest_json_error(error)


def route(cloud, request):
    match = _PATH.match(request.path)
    if not match:
        raise AwsError("UnknownOperationException", f"CloudStudio does not emulate Lambda {request.method} {request.path} yet.", 404)
    kind, rest, method = match.group("kind"), match.group("rest").strip("/"), request.method
    parts = rest.split("/") if rest else []
    if kind == "account-settings":
        request.op = "GetAccountSettings"
        return wire.rest_json({"AccountLimit": {"TotalCodeSize": 80530636800, "CodeSizeUnzipped": 262144000, "CodeSizeZipped": 52428800,
                                                "ConcurrentExecutions": 1000, "UnreservedConcurrentExecutions": 1000},
                               "AccountUsage": {"TotalCodeSize": 0, "FunctionCount": len(functions(cloud, request))}})
    if kind == "tags":
        return tags_call(cloud, request, rest)
    if kind == "event-source-mappings":
        return mappings_call(cloud, request, parts)
    if not parts:
        if method == "POST":
            return create_function(cloud, request, _body(request))
        request.op = "ListFunctions"
        return wire.rest_json({"Functions": [configuration(fn) for fn in sorted(functions(cloud, request).values(), key=lambda f: f["name"])]})
    name = parts[0]
    sub = parts[1] if len(parts) > 1 else ""
    if sub == "" and method == "GET":
        request.op = "GetFunction"
        fn = function_of(cloud, request, name)
        return wire.rest_json({"Configuration": configuration(fn), "Code": _code_location(cloud, fn), "Tags": fn.get("tags", {})})
    if sub == "" and method == "DELETE":
        request.op = "DeleteFunction"
        fn = function_of(cloud, request, name)
        del functions(cloud, request)[fn["name"]]
        cloud.store.touch()
        return Response(204, b"")
    if sub == "configuration":
        fn = function_of(cloud, request, name)
        if method == "PUT":
            request.op = "UpdateFunctionConfiguration"
            update_configuration(cloud, fn, _body(request))
        else:
            request.op = "GetFunctionConfiguration"
        return wire.rest_json(configuration(fn))
    if sub == "code" and method == "PUT":
        request.op = "UpdateFunctionCode"
        fn = function_of(cloud, request, name)
        params = _body(request)
        fn["code"] = _code(cloud, request, params)
        fn["modified"] = time.time()
        cloud.store.touch()
        return wire.rest_json(configuration(fn))
    if sub == "invocations" and method == "POST":
        return invoke(cloud, request, name)
    if sub == "policy":
        return policy_call(cloud, request, name, parts[2] if len(parts) > 2 else None)
    if sub == "versions":
        request.op = "ListVersionsByFunction" if method == "GET" else "PublishVersion"
        fn = function_of(cloud, request, name)
        if method == "POST":
            return wire.rest_json({**configuration(fn), "Version": "1"}, 201)
        return wire.rest_json({"Versions": [configuration(fn)]})
    if sub == "concurrency":
        request.op = "PutFunctionConcurrency"
        fn = function_of(cloud, request, name)
        if method == "PUT":
            fn["concurrency"] = _body(request).get("ReservedConcurrentExecutions")
            cloud.store.touch()
        return wire.rest_json({"ReservedConcurrentExecutions": fn.get("concurrency")})
    if sub == "event-invoke-config":
        request.op = "PutFunctionEventInvokeConfig" if method in ("PUT", "POST") else "GetFunctionEventInvokeConfig"
        fn = function_of(cloud, request, name)
        if method in ("PUT", "POST"):
            fn["eventConfig"] = _body(request)
            cloud.store.touch()
        return wire.rest_json({"FunctionArn": fn["arn"], **(fn.get("eventConfig") or {})})
    raise AwsError("UnknownOperationException", f"CloudStudio does not emulate Lambda {method} {request.path} yet.", 404)


def _body(request):
    return request.json() if request.body else {}


def functions(cloud, caller):
    return cloud.store.regional(caller.account, caller.region, NAME).setdefault("functions", {})


def _name(value):
    """A function name from a name, a full ARN or a partial ARN, without its qualifier."""
    value = str(value or "")
    if value.startswith("arn:"):
        parts = value.split(":")
        return parts[6] if len(parts) > 6 else value
    if ":" in value:
        return value.split(":")[0] if not value.split(":")[0].isdigit() else value.split(":")[2] if len(value.split(":")) > 2 else value
    return value


def function_of(cloud, caller, name):
    plain = _name(name)
    caller.target = plain
    fn = functions(cloud, caller).get(plain)
    if fn is None:
        raise AwsError("ResourceNotFoundException", f"Function not found: {wire.arn('lambda', caller.region, caller.account, 'function:' + plain)}", 404)
    return fn


def find(cloud, account, region, name):
    plain = _name(name)
    if str(name).startswith("arn:"):
        parts = str(name).split(":")
        region, account = parts[3], parts[4]
    return cloud.store.regional(account, region, NAME).setdefault("functions", {}).get(plain)


def configuration(fn):
    result = {
        "FunctionName": fn["name"], "FunctionArn": fn["arn"], "Runtime": fn["runtime"], "Role": fn["role"], "Handler": fn["handler"],
        "CodeSize": fn["code"].get("size", 0), "Description": fn.get("description", ""), "Timeout": fn["timeout"], "MemorySize": fn["memory"],
        "LastModified": time.strftime("%Y-%m-%dT%H:%M:%S.000+0000", time.gmtime(fn["modified"])), "CodeSha256": fn["code"].get("sha", ""),
        "Version": "$LATEST", "TracingConfig": {"Mode": "PassThrough"}, "RevisionId": fn.get("revision", ""),
        "State": "Active", "LastUpdateStatus": "Successful", "PackageType": "Zip", "Architectures": fn.get("architectures", ["x86_64"]),
        "EphemeralStorage": {"Size": 512}, "SnapStart": {"ApplyOn": "None", "OptimizationStatus": "Off"},
        "LoggingConfig": {"LogFormat": "Text", "LogGroup": f"/aws/lambda/{fn['name']}"},
    }
    if fn.get("environment"):
        result["Environment"] = {"Variables": fn["environment"]}
    if fn.get("deadLetter"):
        result["DeadLetterConfig"] = {"TargetArn": fn["deadLetter"]}
    return result


def _code_location(cloud, fn):
    code = fn["code"]
    if code.get("kind") == "dir":
        return {"RepositoryType": "Local", "Location": code["dir"]}
    scope = urlencode({"account": fn["account"], "region": fn["region"]})
    return {"RepositoryType": "S3", "Location": f"{cloud.endpoint}/_cloudstudio/lambda-code/{fn['name']}.zip?{scope}"}


def _code(cloud, caller, params):
    code = params.get("Code", params)
    if code.get("ZipFile"):
        data = base64.b64decode(code["ZipFile"]) if isinstance(code["ZipFile"], str) else code["ZipFile"]
        return _zip_code(cloud, data)
    if code.get("S3Bucket") == "hot-reload" and code.get("S3Key"):
        return folder_code(code["S3Key"])
    if code.get("S3Bucket") and code.get("S3Key"):
        from . import s3
        bucket = s3.buckets(cloud, caller.account).get(code["S3Bucket"])
        obj = bucket["objects"].get(code["S3Key"]) if bucket else None
        if obj is None:
            raise AwsError("InvalidParameterValueException", f"Error occurred while GetObject. S3 Error Code: NoSuchKey. S3 Error Message: The specified key does not exist.")
        return _zip_code(cloud, cloud.store.get_blob(obj["blob"]))
    if code.get("ImageUri"):
        raise AwsError("InvalidParameterValueException", "CloudStudio runs zip and folder functions; container images need Docker, which CloudStudio does not use.")
    raise AwsError("InvalidParameterValueException", "Please provide a source for function code.")


def _zip_code(cloud, data):
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            archive.namelist()
    except zipfile.BadZipFile as error:
        raise AwsError("InvalidParameterValueException", "Could not unzip uploaded file. Please check your file, then try to upload again.") from error
    digest = cloud.store.put_blob(data)
    return {"kind": "zip", "blob": digest, "size": len(data), "sha": base64.b64encode(hashlib.sha256(data).digest()).decode()}


def folder_code(folder):
    path = Path(folder)
    size = 0
    digest = hashlib.sha256(str(path).encode())
    if path.is_dir():
        for item in sorted(path.rglob("*"))[:2000]:
            if item.is_file() and "node_modules" not in item.parts and "__pycache__" not in item.parts:
                stat = item.stat()
                size += stat.st_size
                digest.update(f"{item.relative_to(path)}:{stat.st_size}:{int(stat.st_mtime)}".encode())
    return {"kind": "dir", "dir": str(path), "size": size, "sha": base64.b64encode(digest.digest()).decode()}


def code_dir(cloud, fn):
    """The folder a function runs from: its own folder, or its zip unpacked once under the cloud's data."""
    code = fn.get("code") or {}
    if code.get("kind") == "dir":
        return Path(code["dir"])
    if code.get("kind") != "zip":
        return None
    target = cloud.root / "data" / "lambda" / code["blob"][:24]
    if not (target / ".unpacked").exists():
        target.mkdir(parents=True, exist_ok=True)
        root = target.resolve()
        with zipfile.ZipFile(io.BytesIO(cloud.store.get_blob(code["blob"]))) as archive:
            for member in archive.infolist():
                destination = (target / member.filename).resolve()
                if root not in destination.parents and destination != root:
                    continue
                if member.is_dir():
                    destination.mkdir(parents=True, exist_ok=True)
                else:
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_bytes(archive.read(member))
        (target / ".unpacked").write_text("ok", encoding="utf-8")
    return target


def create_function(cloud, caller, params):
    caller.op = "CreateFunction"
    name = params.get("FunctionName") or ""
    caller.target = name
    if not _FUNCTION.match(name):
        raise AwsError("ValidationException", f"1 validation error detected: Value '{name}' at 'functionName' failed to satisfy constraint: "
                       "Member must satisfy regular expression pattern: (arn:(aws[a-zA-Z-]*)?:lambda:)?([a-z]{2}(-gov)?-[a-z]+-\\d{1}:)?(\\d{12}:)?(function:)?([a-zA-Z0-9-_]+)(:(\\$LATEST|[a-zA-Z0-9-_]+))?")
    runtime = params.get("Runtime") or ""
    if not runtime.startswith(("python", "nodejs")):
        raise AwsError("InvalidParameterValueException", f"CloudStudio runs Python and Node.js functions; the runtime parameter of {runtime or 'none'} is not supported here.")
    if not params.get("Handler"):
        raise AwsError("InvalidParameterValueException", "The handler is required for a zip or folder function.")
    existing = functions(cloud, caller)
    if name in existing:
        raise AwsError("ResourceConflictException", f"Function already exist: {name}", 409)
    fn = {"name": name, "arn": wire.arn("lambda", caller.region, caller.account, f"function:{name}"), "account": caller.account,
          "region": caller.region, "runtime": runtime, "handler": params["Handler"],
          "role": params.get("Role") or f"arn:aws:iam::{caller.account}:role/cloudstudio-lambda", "description": params.get("Description", ""),
          "timeout": int(params.get("Timeout") or 3), "memory": int(params.get("MemorySize") or 128),
          "environment": dict((params.get("Environment") or {}).get("Variables") or {}), "code": _code(cloud, caller, params),
          "tags": dict(params.get("Tags") or {}), "created": time.time(), "modified": time.time(), "revision": str(uuid.uuid4()),
          "deadLetter": (params.get("DeadLetterConfig") or {}).get("TargetArn"), "policy": [], "invocations": [],
          "architectures": params.get("Architectures") or ["x86_64"]}
    existing[name] = fn
    cloud.store.touch()
    return wire.rest_json(configuration(fn), 201)


def update_configuration(cloud, fn, params):
    if "Environment" in params:
        fn["environment"] = dict((params.get("Environment") or {}).get("Variables") or {})
    for field, key, cast in (("Timeout", "timeout", int), ("MemorySize", "memory", int), ("Handler", "handler", str),
                             ("Runtime", "runtime", str), ("Description", "description", str), ("Role", "role", str)):
        if params.get(field) is not None:
            fn[key] = cast(params[field])
    if "DeadLetterConfig" in params:
        fn["deadLetter"] = (params.get("DeadLetterConfig") or {}).get("TargetArn")
    fn["modified"] = time.time()
    fn["revision"] = str(uuid.uuid4())
    cloud.store.touch()


def invoke(cloud, request, name):
    request.op = "Invoke"
    fn = function_of(cloud, request, name)
    kind = request.headers.get("x-amz-invocation-type", "RequestResponse")
    try:
        event = json.loads(request.body.decode("utf-8")) if request.body.strip() else {}
    except (UnicodeDecodeError, ValueError) as error:
        raise AwsError("InvalidRequestContentException", "Could not parse request body into json: Could not parse payload into json") from error
    request.note_req = event
    if kind == "DryRun":
        return Response(204, b"")
    if kind == "Event":
        cloud.runtime.invoke_async(fn["account"], fn["region"], fn["name"], event, request.source)
        return Response(202, b"")
    outcome = cloud.runtime.invoke(fn["account"], fn["region"], fn["name"], event, request.source)
    payload = outcome["payload"]
    headers = {"X-Amz-Executed-Version": "$LATEST", "Content-Type": "application/json"}
    if not outcome["ok"]:
        headers["X-Amz-Function-Error"] = "Unhandled"
    if request.headers.get("x-amz-log-type") == "Tail":
        headers["X-Amz-Log-Result"] = base64.b64encode("\n".join(outcome["logs"]).encode("utf-8")[-4096:]).decode()
    request.note_res = payload
    body = json.dumps(payload, ensure_ascii=False, default=str) if payload is not None else "null"
    return Response(200, body, headers)


def policy_call(cloud, request, name, statement):
    fn = function_of(cloud, request, name)
    if request.method == "POST":
        request.op = "AddPermission"
        params = _body(request)
        sid = params.get("StatementId")
        if any(s["Sid"] == sid for s in fn["policy"]):
            raise AwsError("ResourceConflictException", f"The statement id ({sid}) provided already exists. Please provide a new statement id, or remove the existing statement.", 409)
        entry = {"Sid": sid, "Effect": "Allow", "Principal": {"Service": params.get("Principal")}, "Action": params.get("Action"), "Resource": fn["arn"]}
        if params.get("SourceArn"):
            entry["Condition"] = {"ArnLike": {"AWS:SourceArn": params["SourceArn"]}}
        fn["policy"].append(entry)
        cloud.store.touch()
        return wire.rest_json({"Statement": json.dumps(entry)}, 201)
    if request.method == "DELETE":
        request.op = "RemovePermission"
        fn["policy"] = [s for s in fn["policy"] if s["Sid"] != statement]
        cloud.store.touch()
        return Response(204, b"")
    request.op = "GetPolicy"
    if not fn["policy"]:
        raise AwsError("ResourceNotFoundException", "The resource you requested does not exist.", 404)
    return wire.rest_json({"Policy": json.dumps({"Version": "2012-10-17", "Id": "default", "Statement": fn["policy"]}), "RevisionId": fn["revision"]})


def tags_call(cloud, request, arn):
    arn = arn.strip("/")
    fn = function_of(cloud, request, arn)
    if request.method == "GET":
        request.op = "ListTags"
        return wire.rest_json({"Tags": fn.get("tags", {})})
    if request.method == "POST":
        request.op = "TagResource"
        fn.setdefault("tags", {}).update(_body(request).get("Tags") or {})
    else:
        request.op = "UntagResource"
        for key in [value for name, value in request.query_pairs if name == "tagKeys"]:
            fn.setdefault("tags", {}).pop(key, None)
    cloud.store.touch()
    return Response(204, b"")


# ---------------------------------------------------------------- event source mappings

def mappings(cloud, caller):
    return cloud.store.regional(caller.account, caller.region, NAME).setdefault("mappings", {})


def mapping_view(cloud, mapping):
    return {"UUID": mapping["uuid"], "BatchSize": mapping["batch"], "MaximumBatchingWindowInSeconds": 0, "EventSourceArn": mapping["source"],
            "FunctionArn": mapping["function"], "LastModified": mapping["modified"], "State": "Enabled" if mapping["enabled"] else "Disabled",
            "StateTransitionReason": "USER_INITIATED", "LastProcessingResult": mapping.get("last", "No records processed"),
            "FunctionResponseTypes": mapping.get("responseTypes") or []}


def mappings_call(cloud, request, parts):
    if not parts:
        if request.method == "POST":
            request.op = "CreateEventSourceMapping"
            params = _body(request)
            fn = function_of(cloud, request, params.get("FunctionName"))
            source = params.get("EventSourceArn") or ""
            if ":sqs:" not in source:
                raise AwsError("InvalidParameterValueException", "CloudStudio triggers functions from SQS queues; other event sources are not emulated yet.")
            mapping = {"uuid": str(uuid.uuid4()), "batch": int(params.get("BatchSize") or 10), "source": source, "function": fn["arn"],
                       "enabled": params.get("Enabled", True) is not False, "modified": time.time(),
                       "responseTypes": params.get("FunctionResponseTypes") or []}
            mappings(cloud, request)[mapping["uuid"]] = mapping
            cloud.store.touch()
            return wire.rest_json(mapping_view(cloud, mapping), 202)
        request.op = "ListEventSourceMappings"
        wanted_fn = request.query.get("FunctionName")
        wanted_source = request.query.get("EventSourceArn")
        result = [mapping_view(cloud, m) for m in mappings(cloud, request).values()
                  if (not wanted_fn or _name(wanted_fn) == _name(m["function"])) and (not wanted_source or wanted_source == m["source"])]
        return wire.rest_json({"EventSourceMappings": result})
    mapping = mappings(cloud, request).get(parts[0])
    if mapping is None:
        raise AwsError("ResourceNotFoundException", "The resource you requested does not exist.", 404)
    request.target = _name(mapping["function"])
    if request.method == "DELETE":
        request.op = "DeleteEventSourceMapping"
        del mappings(cloud, request)[parts[0]]
        cloud.store.touch()
        return wire.rest_json({**mapping_view(cloud, mapping), "State": "Deleting"}, 202)
    if request.method == "PUT":
        request.op = "UpdateEventSourceMapping"
        params = _body(request)
        if "Enabled" in params:
            mapping["enabled"] = bool(params["Enabled"])
        if params.get("BatchSize"):
            mapping["batch"] = int(params["BatchSize"])
        if "FunctionResponseTypes" in params:
            mapping["responseTypes"] = params["FunctionResponseTypes"] or []
        mapping["modified"] = time.time()
        cloud.store.touch()
        return wire.rest_json(mapping_view(cloud, mapping), 202)
    request.op = "GetEventSourceMapping"
    return wire.rest_json(mapping_view(cloud, mapping))


def queue_mappings(cloud):
    """(mapping, function) for every enabled queue trigger."""
    result = []
    for account, region, service in cloud.store.each(NAME):
        for mapping in list(service.get("mappings", {}).values()):
            if mapping["enabled"] and ":sqs:" in mapping["source"]:
                fn = service.get("functions", {}).get(_name(mapping["function"]))
                if fn is not None:
                    result.append((mapping, fn))
    return result


def dead_letter(cloud, account, region, name, event, outcome):
    fn = find(cloud, account, region, name)
    target = (fn or {}).get("deadLetter")
    if not target:
        return
    body = json.dumps(event, ensure_ascii=False)
    attributes = {"RequestID": {"DataType": "String", "StringValue": outcome.get("request", "")},
                  "ErrorCode": {"DataType": "Number", "StringValue": "200"},
                  "ErrorMessage": {"DataType": "String", "StringValue": str((outcome.get("payload") or {}).get("errorMessage", ""))[:200]}}
    if ":sqs:" in target:
        from . import sqs
        sqs.deliver_arn(cloud, target, body, f"lambda:{fn['name']}", attributes)
    elif ":sns:" in target:
        from . import sns
        sns.publish_arn(cloud, target, body, None, f"lambda:{fn['name']}")


def resources(cloud):
    result = []
    for account, region, service in cloud.store.each(NAME):
        maps = list(service.get("mappings", {}).values())
        for fn in service.get("functions", {}).values():
            code = fn.get("code") or {}
            result.append({
                "service": NAME, "kind": "function", "name": fn["name"], "arn": fn["arn"], "account": account, "region": region,
                "created": fn["created"], "runtime": fn["runtime"], "handler": fn["handler"], "timeout": fn["timeout"], "memory": fn["memory"],
                "code": {"kind": code.get("kind"), "dir": code.get("dir"), "size": code.get("size", 0)},
                "env": sorted((fn.get("environment") or {}).keys()),
                "envEmpty": sorted(k for k, v in (fn.get("environment") or {}).items() if str(v) == ""),
                "deadLetter": fn.get("deadLetter"),
                "triggers": [{"source": m["source"], "batch": m["batch"], "enabled": m["enabled"], "last": m.get("last")}
                             for m in maps if _name(m["function"]) == fn["name"]],
                "invocations": list(reversed(fn.get("invocations", [])))[:25],
            })
    return result


