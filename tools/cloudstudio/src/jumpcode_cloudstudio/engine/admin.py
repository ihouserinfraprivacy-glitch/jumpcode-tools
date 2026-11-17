# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""The control door the CloudStudio tool uses (never the app): status, creating and removing resources in plain
terms, invoking, sending, copies and shutdown. Every call needs the token the tool gave the engine at start."""

import hmac
import json
import threading
import time

from . import wire
from .services.common import Caller, run_json
from .state import StateError
from .wire import AwsError, Response

TARGET_KINDS = {"function": "lambda", "queue": "sqs", "topic": "sns", "machine": "states", "bus": "events"}


def handle_admin(cloud, request):
    name = request.path[len("/_cloudstudio/"):].strip("/")
    if name == "health":
        return _json({"ok": True, "pid": __import__("os").getpid(), "port": cloud.port, "startedAt": cloud.started})
    if name.startswith("lambda-code/"):
        return _code(cloud, name[len("lambda-code/"):].removesuffix(".zip"), request.query)
    if not cloud.token or not hmac.compare_digest(request.headers.get("x-cloudstudio-token", ""), cloud.token):
        return _json({"error": "forbidden"}, 403)
    try:
        params = request.json() if request.body.strip() else dict(request.query)
        if name in ("operation-open", "operation-cancel", "operation-close"):
            getattr(cloud.operations, name.removeprefix("operation-"))(params.get("id"))
            return _json({"ok": True})
        handler = ACTIONS.get(name)
        if handler is None:
            raise AwsError("UnknownAction", f"Unknown control action {name}")
        with cloud.operations.use(request.headers.get("x-cloudstudio-operation")):
            return _json(handler(cloud, params))
    except AwsError as error:
        return _json({"error": error.code, "message": error.message}, 400)


def _json(value, status=200):
    return Response(status, json.dumps(value, ensure_ascii=False, default=str), {"Content-Type": "application/json"})


def _code(cloud, name, scope):
    account, region = scope.get("account"), scope.get("region")
    if (account is None) != (region is None):
        return Response(404, b"")
    matches = [service["functions"][name] for owner, place, service in cloud.store.each("lambda")
               if name in service.get("functions", {}) and (account is None or (owner == account and place == region))]
    # Old links remain usable only when their name identifies exactly one function.
    if len(matches) == 1 and matches[0]["code"].get("kind") == "zip":
        return Response(200, cloud.store.get_blob(matches[0]["code"]["blob"]), {"Content-Type": "application/zip"})
    return Response(404, b"")


def caller(cloud, params, source="agent"):
    return Caller(params.get("account") or wire.DEFAULT_ACCOUNT, params.get("region") or cloud.region, source)


def target_arn(cloud, who, value):
    """'function:agendar', 'queue:lembretes', 'topic:avisos', 'machine:x', 'bus:default' or a full ARN."""
    value = str(value or "")
    if value.startswith("arn:"):
        return value
    kind, _, name = value.partition(":")
    if not name:
        raise AwsError("InvalidTarget", f"Name the target as function:<name>, queue:<name>, topic:<name>, machine:<name> or bus:<name> (got '{value}')")
    service = TARGET_KINDS.get(kind)
    if service is None:
        raise AwsError("InvalidTarget", f"Unknown target kind '{kind}'")
    resource = {"lambda": f"function:{name}", "sqs": name, "sns": name, "states": f"stateMachine:{name}", "events": f"event-bus/{name}"}[service]
    return wire.arn(service, who.region, who.account, resource)


# ---------------------------------------------------------------- reading

def status(cloud, params):
    resources = cloud.summary()
    with cloud.history_lock:
        calls = list(cloud.calls)
        totals = (cloud.call_count, cloud.error_count)
    problems = [c for c in calls if c.get("error")][-int(params.get("problems") or 8):]
    return {"running": True, "endpoint": cloud.endpoint, "region": cloud.region, "storage": "persistent" if cloud.store.persistent else "memory",
            "startedAt": cloud.started, "resources": [outline(r) for r in resources], "calls": totals[0], "errors": totals[1],
            "problems": [problem_line(c) for c in problems], "runtimes": cloud.runtime.available(), "snapshots": cloud.store.snapshots()[:10]}


def names(cloud, params):
    """Resource names by service (lets the tool fill in a name the model left out when there is only one)."""
    result = {}
    who = caller(cloud, params)
    for resource in cloud.summary():
        if resource["account"] != who.account or (resource.get("region") and resource["region"] != who.region):
            continue
        result.setdefault(resource["service"], []).append(resource["name"])
    return result


def outline(resource):
    service, name = resource["service"], resource["name"]
    detail = {
        "s3": lambda r: f"{r['count']} objects",
        "dynamodb": lambda r: f"key {r['key']['hash']}{' + ' + r['key']['range'] if r['key']['range'] else ''}, {r['count']} items",
        "sqs": lambda r: f"{r['visible']} waiting, {r['inflight']} in flight" + (f", dead-letter {r['dlq']['arn'].rsplit(':', 1)[-1]} after {r['dlq']['max']}" if r.get("dlq") else ""),
        "sns": lambda r: f"{len(r['subscriptions'])} subscriptions",
        "lambda": lambda r: f"{r['runtime']} {r['handler']}" + (f" from {r['code']['dir']}" if r['code'].get('dir') else "")
                            + (f", empty env {', '.join(r['envEmpty'])}" if r.get("envEmpty") else ""),
        "apigatewayv2": lambda r: f"{r['url']} routes " + "; ".join(f"{x['key']} -> {x['function'] or x['uri']}" for x in r["routes"]),
        "stepfunctions": lambda r: f"{len(r['states'])} states" + (f", last run {r['executions'][0]['status']}" if r["executions"] else ""),
        "scheduler": lambda r: f"{r['expression']} -> {r['target'].rsplit(':', 1)[-1]}",
        "events": lambda r: (r.get("expression") or "pattern") + f" -> {', '.join(t.rsplit(':', 1)[-1] for t in r['targets'])}",
        "secretsmanager": lambda r: "empty" if r["empty"] else f"set ({r['size']} characters)",
        "ssm": lambda r: f"{r['type']}" + (f" = {r['value']}" if r.get("value") is not None else ""),
        "logs": lambda r: f"{r['count']} lines",
    }.get(service, lambda r: "")
    try:
        text = detail(resource)
    except (KeyError, TypeError, IndexError):
        text = ""
    return f"{service} {resource['kind']} {name}" + (f" ({text})" if text else "") + f" [account {resource['account']}, {resource.get('region') or 'global'}]"


def problem_line(call):
    when = time.strftime("%H:%M:%S", time.localtime(call["at"]))
    origin = call.get("source") or "app"
    return f"{when} {call['service']} {call['op']} {call.get('target') or ''} from {origin}: {call['error']['code']}: {call['error']['message']}"


def calls(cloud, params):
    with cloud.history_lock:
        items = list(cloud.calls)
    if params.get("errors"):
        items = [c for c in items if c.get("error")]
    if params.get("service"):
        items = [c for c in items if c["service"] == params["service"]]
    if params.get("target"):
        items = [c for c in items if (c.get("target") or "").startswith(params["target"])]
    for key in ("account", "region"):
        if params.get(key):
            items = [c for c in items if c.get(key) == params[key]]
    return {"calls": items[-int(params.get("limit") or 20):]}


def logs(cloud, params):
    with cloud.history_lock:
        items = list(cloud.logs)
    if params.get("function"):
        items = [line for line in items if line["group"] == f"/aws/lambda/{params['function']}"]
    elif params.get("group"):
        items = [line for line in items if line["group"] == params["group"]]
    for key in ("account", "region"):
        if params.get(key):
            items = [line for line in items if line.get(key) == params[key]]
    return {"lines": [f"{time.strftime('%H:%M:%S', time.localtime(l['at']))} {l['group']} {l['text']}" for l in items[-int(params.get("limit") or 40):]]}


# ---------------------------------------------------------------- creating

def create(cloud, params):
    service = params.get("service")
    who = caller(cloud, params)
    builder = BUILDERS.get(service)
    if builder is None:
        raise AwsError("UnknownService", f"CloudStudio can create: {', '.join(sorted(BUILDERS))}")
    return builder(cloud, who, params)


def _run(cloud, who, module, op, payload):
    who.service = module.NAME
    return run_json(cloud, who, module.OPS, op, payload)


def _rest(cloud, who, service, method, path, payload, op):
    """Runs a REST service operation through its own HTTP handler and records it as the agent's call."""
    from .server import Request
    from .services import SERVICES
    headers = {"Content-Type": "application/json", "Authorization": f"AWS4-HMAC-SHA256 Credential={who.account}/20260101/{who.region}/{service}/aws4_request",
               "x-amz-security-token": "cloudstudio:agent"}
    request = Request(method, path, headers, json.dumps(payload).encode() if payload is not None else b"", who.region)
    request.service = service
    module = SERVICES[service]
    started = time.perf_counter()
    response = module.handle(cloud, request)
    error = None
    body = {}
    if response.body:
        try:
            body = json.loads(response.body)
        except ValueError:
            body = {}
    if response.status >= 400:
        error = (response.headers.get("x-amzn-ErrorType", "Error"), body.get("message") or body.get("Message") or f"HTTP {response.status}")
    cloud.internal_call(service, request.op or op, request.target, "agent", (time.perf_counter() - started) * 1000, error,
                        req=payload, account=who.account, region=who.region)
    if error:
        raise AwsError(error[0], error[1], response.status)
    return body


def _bucket(cloud, who, params):
    from .services import s3
    from .server import Request
    name = params["name"]
    headers = {"Authorization": f"AWS4-HMAC-SHA256 Credential={who.account}/20260101/{who.region}/s3/aws4_request", "x-amz-security-token": "cloudstudio:agent"}
    request = Request("PUT", f"/{name}", headers, b"", who.region)
    response = s3.handle(cloud, request)
    if response.status >= 400 and b"BucketAlreadyOwnedByYou" not in response.body:
        text = response.body.decode("utf-8", "replace")
        code = text.split("<Code>")[1].split("</Code>")[0] if "<Code>" in text else "Error"
        cloud.internal_call("s3", "CreateBucket", name, "agent", error=(code, text[:300]), account=who.account, region=who.region)
        raise AwsError(code, f"Could not create bucket {name}: {code}")
    cloud.internal_call("s3", "CreateBucket", name, "agent", account=who.account, region=who.region)
    return {"created": f"bucket {name}", "arn": f"arn:aws:s3:::{name}"}


def _table(cloud, who, params):
    from .services import dynamodb
    key, sort = params["key"], params.get("sort")
    types = {key: params.get("keyType") or "S"}
    schema = [{"AttributeName": key, "KeyType": "HASH"}]
    if sort:
        types[sort] = params.get("sortType") or "S"
        schema.append({"AttributeName": sort, "KeyType": "RANGE"})
    indexes = []
    for index in params.get("indexes") or []:
        types.setdefault(index["key"], index.get("keyType") or "S")
        index_schema = [{"AttributeName": index["key"], "KeyType": "HASH"}]
        if index.get("sort"):
            types.setdefault(index["sort"], index.get("sortType") or "S")
            index_schema.append({"AttributeName": index["sort"], "KeyType": "RANGE"})
        indexes.append({"IndexName": index["name"], "KeySchema": index_schema, "Projection": {"ProjectionType": "ALL"}})
    payload = {"TableName": params["name"], "KeySchema": schema, "BillingMode": "PAY_PER_REQUEST",
               "AttributeDefinitions": [{"AttributeName": k, "AttributeType": v} for k, v in types.items()]}
    if indexes:
        payload["GlobalSecondaryIndexes"] = indexes
    result = _run(cloud, who, dynamodb, "CreateTable", payload)
    if params.get("ttl"):
        _run(cloud, who, dynamodb, "UpdateTimeToLive", {"TableName": params["name"], "TimeToLiveSpecification": {"AttributeName": params["ttl"], "Enabled": True}})
    for item in params.get("items") or []:
        _run(cloud, who, dynamodb, "PutItem", {"TableName": params["name"], "Item": typed(item)})
    return {"created": f"table {params['name']}", "arn": result["TableDescription"]["TableArn"]}


def typed(value):
    """Plain JSON to DynamoDB's typed values (the agent writes items as ordinary JSON)."""
    if isinstance(value, dict):
        if len(value) == 1 and next(iter(value)) in ("S", "N", "B", "BOOL", "NULL", "M", "L", "SS", "NS", "BS"):
            return value
        return {k: _typed_value(v) for k, v in value.items()}
    raise AwsError("ValidationException", "An item must be a JSON object")


def _typed_value(value):
    if isinstance(value, bool):
        return {"BOOL": value}
    if value is None:
        return {"NULL": True}
    if isinstance(value, (int, float)):
        return {"N": str(value)}
    if isinstance(value, list):
        return {"L": [_typed_value(v) for v in value]}
    if isinstance(value, dict):
        return {"M": {k: _typed_value(v) for k, v in value.items()}}
    return {"S": str(value)}


def _queue(cloud, who, params):
    from .services import sqs
    attributes = {}
    if params.get("visibility") is not None:
        attributes["VisibilityTimeout"] = str(int(params["visibility"]))
    name = params["name"]
    if params.get("fifo") and not name.endswith(".fifo"):
        name += ".fifo"
    if params.get("fifo"):
        attributes.update({"FifoQueue": "true", "ContentBasedDeduplication": "true"})
    if params.get("dlq"):
        dlq_name = params["dlq"] + (".fifo" if params.get("fifo") and not params["dlq"].endswith(".fifo") else "")
        dlq_attributes = {"FifoQueue": "true"} if params.get("fifo") else {}
        _run(cloud, who, sqs, "CreateQueue", {"QueueName": dlq_name, "Attributes": dlq_attributes})
        attributes["RedrivePolicy"] = json.dumps({"deadLetterTargetArn": wire.arn("sqs", who.region, who.account, dlq_name),
                                                  "maxReceiveCount": int(params.get("maxReceives") or 3)})
    result = _run(cloud, who, sqs, "CreateQueue", {"QueueName": name, "Attributes": attributes})
    answer = {"created": f"queue {name}", "url": result["QueueUrl"], "arn": wire.arn("sqs", who.region, who.account, name)}
    if params.get("dlq"):
        answer.update({"dlq": dlq_name, "maxReceives": int(params.get("maxReceives") or 3)})
    return answer


def _topic(cloud, who, params):
    from .services import sns
    result = sns.create_topic(cloud, who, {"Name": params["name"]})
    cloud.internal_call("sns", "CreateTopic", params["name"], "agent", account=who.account, region=who.region)
    for subscription in params.get("subscribe") or []:
        if "queue" in subscription:
            protocol, endpoint = "sqs", target_arn(cloud, who, f"queue:{subscription['queue']}")
        elif "function" in subscription:
            protocol, endpoint = "lambda", target_arn(cloud, who, f"function:{subscription['function']}")
        elif "url" in subscription:
            protocol, endpoint = ("https" if subscription["url"].startswith("https") else "http"), subscription["url"]
        elif "email" in subscription:
            protocol, endpoint = "email", subscription["email"]
        else:
            continue
        attributes = {"RawMessageDelivery": "true"} if subscription.get("raw") else {}
        sns.subscribe(cloud, who, {"TopicArn": result["TopicArn"], "Protocol": protocol, "Endpoint": endpoint, "Attributes": attributes})
    return {"created": f"topic {params['name']}", "arn": result["TopicArn"]}


def _function(cloud, who, params):
    from .services import lambda_
    folder = params.get("folder")
    if not folder:
        raise AwsError("InvalidParameterValueException", "A function needs the folder with its code")
    code = lambda_.folder_code(folder)
    runtime = params.get("runtime") or "python3.12"
    payload = {"FunctionName": params["name"], "Runtime": runtime, "Handler": params.get("handler") or ("app.handler" if runtime.startswith("python") else "index.handler"),
               "Role": f"arn:aws:iam::{who.account}:role/cloudstudio-lambda", "Timeout": int(params.get("timeout") or 10),
               "MemorySize": int(params.get("memory") or 256), "Environment": {"Variables": {str(k): str(v) for k, v in (params.get("env") or {}).items()}},
               "Code": {"S3Bucket": "hot-reload", "S3Key": code["dir"]}}
    if params.get("deadLetter"):
        payload["DeadLetterConfig"] = {"TargetArn": target_arn(cloud, who, params["deadLetter"])}
    existing = lambda_.find(cloud, who.account, who.region, params["name"])
    if existing:
        existing["code"] = code
        lambda_.update_configuration(cloud, existing, {k: v for k, v in payload.items() if k not in ("FunctionName", "Code", "Role")})
        cloud.internal_call("lambda", "UpdateFunctionCode", params["name"], "agent", req={"folder": folder}, account=who.account, region=who.region)
        result = {"updated": f"function {params['name']}", "arn": existing["arn"]}
    else:
        body = _rest(cloud, who, "lambda", "POST", "/2015-03-31/functions", payload, "CreateFunction")
        result = {"created": f"function {params['name']}", "arn": body["FunctionArn"]}
    if params.get("queue"):
        queue_arn = target_arn(cloud, who, f"queue:{params['queue']}")
        current = [m for m in lambda_.mappings(cloud, who).values() if m["source"] == queue_arn and lambda_._name(m["function"]) == params["name"]]
        if not current:
            _rest(cloud, who, "lambda", "POST", "/2015-03-31/event-source-mappings/",
                  {"FunctionName": params["name"], "EventSourceArn": queue_arn, "BatchSize": int(params.get("batch") or 10)}, "CreateEventSourceMapping")
        result["trigger"] = f"queue {params['queue']}"
    return result


def _api(cloud, who, params):
    from .services import apigatewayv2 as api_service
    routes = params.get("routes") or []
    existing = next((a for a in api_service.apis(cloud, who).values() if a["name"] == params["name"]), None)
    if existing is None:
        body = _rest(cloud, who, "apigatewayv2", "POST", "/v2/apis",
                     {"name": params["name"], "protocolType": "HTTP",
                      **({"corsConfiguration": {"allowOrigins": ["*"], "allowMethods": ["*"], "allowHeaders": ["*"]}} if params.get("cors", True) else {})},
                     "CreateApi")
        api_id = body["apiId"]
        _rest(cloud, who, "apigatewayv2", "POST", f"/v2/apis/{api_id}/stages", {"stageName": "$default", "autoDeploy": True}, "CreateStage")
    else:
        api_id = existing["id"]
    api = api_service.apis(cloud, who)[api_id]
    for route in routes:
        key = route.get("route") or "$default"
        if any(r["key"] == key for r in api["routes"].values()):
            continue
        function_arn = target_arn(cloud, who, f"function:{route['function']}")
        integration = _rest(cloud, who, "apigatewayv2", "POST", f"/v2/apis/{api_id}/integrations",
                            {"integrationType": "AWS_PROXY", "integrationUri": function_arn, "payloadFormatVersion": "2.0"}, "CreateIntegration")
        _rest(cloud, who, "apigatewayv2", "POST", f"/v2/apis/{api_id}/routes",
              {"routeKey": key, "target": f"integrations/{integration['integrationId']}"}, "CreateRoute")
    return {"created": f"api {params['name']}", "url": api_service.endpoint(cloud, api), "id": api_id}


def _secret(cloud, who, params):
    from .services import secretsmanager
    value = params.get("value")
    payload = {"Name": params["name"], "Description": params.get("description", ""), "_source": params.get("fromEnv")}
    if value is not None:
        payload["SecretString"] = value
    existing = secretsmanager.secrets(cloud, who.account, who.region).get(params["name"])
    if existing:
        if value is not None:
            _run(cloud, who, secretsmanager, "PutSecretValue", {"SecretId": params["name"], "SecretString": value})
        existing["source"] = params.get("fromEnv")
        return {"updated": f"secret {params['name']}", "arn": existing["arn"], "size": len(value or "")}
    result = _run(cloud, who, secretsmanager, "CreateSecret", payload)
    return {"created": f"secret {params['name']}", "arn": result["ARN"], "size": len(value or "")}


def _parameter(cloud, who, params):
    from .services import ssm
    result = _run(cloud, who, ssm, "PutParameter", {"Name": params["name"], "Value": str(params.get("value", "")), "Overwrite": True,
                                                     "Type": "SecureString" if params.get("secure") else "String"})
    return {"created": f"parameter {params['name']}", "version": result["Version"]}


def _schedule(cloud, who, params):
    payload = {"ScheduleExpression": params["expression"], "ScheduleExpressionTimezone": params.get("timezone") or "UTC",
               "FlexibleTimeWindow": {"Mode": "OFF"},
               "Target": {"Arn": target_arn(cloud, who, params["target"]), "RoleArn": f"arn:aws:iam::{who.account}:role/cloudstudio-scheduler",
                          "Input": json.dumps(params.get("input") or {}, ensure_ascii=False)}}
    body = _rest(cloud, who, "scheduler", "POST", f"/schedules/{params['name']}", payload, "CreateSchedule")
    return {"created": f"schedule {params['name']}", "arn": body["ScheduleArn"]}


def _rule(cloud, who, params):
    from .services import events
    payload = {"Name": params["name"], "EventBusName": params.get("bus") or "default"}
    if params.get("pattern"):
        payload["EventPattern"] = json.dumps(params["pattern"]) if not isinstance(params["pattern"], str) else params["pattern"]
    if params.get("expression"):
        payload["ScheduleExpression"] = params["expression"]
    result = _run(cloud, who, events, "PutRule", payload)
    targets = [{"Id": f"t{index}", "Arn": target_arn(cloud, who, target)} for index, target in enumerate(params.get("targets") or [], 1)]
    if targets:
        _run(cloud, who, events, "PutTargets", {"Rule": params["name"], "EventBusName": payload["EventBusName"], "Targets": targets})
    return {"created": f"rule {params['name']}", "arn": result["RuleArn"]}


def _machine(cloud, who, params):
    from .services import stepfunctions
    definition = params.get("definition")
    text = definition if isinstance(definition, str) else json.dumps(definition, ensure_ascii=False)
    existing = stepfunctions.machines(cloud, who.account, who.region).get(params["name"])
    if existing:
        _run(cloud, who, stepfunctions, "UpdateStateMachine", {"stateMachineArn": existing["arn"], "definition": text})
        return {"updated": f"state machine {params['name']}", "arn": existing["arn"]}
    result = _run(cloud, who, stepfunctions, "CreateStateMachine", {"name": params["name"], "definition": text})
    return {"created": f"state machine {params['name']}", "arn": result["stateMachineArn"]}


BUILDERS = {"s3": _bucket, "dynamodb": _table, "sqs": _queue, "sns": _topic, "lambda": _function, "apigatewayv2": _api,
            "secretsmanager": _secret, "ssm": _parameter, "scheduler": _schedule, "events": _rule, "stepfunctions": _machine}


# ---------------------------------------------------------------- removing and using

def remove(cloud, params):
    service, name = params.get("service"), params.get("name")
    who = caller(cloud, params)
    from .services import apigatewayv2, dynamodb, events, s3, secretsmanager, sns, sqs, ssm, stepfunctions
    if service == "s3":
        bucket = s3.bucket_of(cloud, who.account, name)
        with cloud.store.lock:
            bucket["objects"].clear()
            del s3.buckets(cloud, who.account)[name]
        cloud.store.touch()
        cloud.internal_call("s3", "DeleteBucket", name, "agent", account=who.account, region=who.region)
    elif service == "dynamodb":
        _run(cloud, who, dynamodb, "DeleteTable", {"TableName": name})
    elif service == "sqs":
        _run(cloud, who, sqs, "DeleteQueue", {"QueueUrl": f"{cloud.endpoint}/{who.account}/{name}"})
    elif service == "sns":
        sns.delete_topic(cloud, who, {"TopicArn": target_arn(cloud, who, f"topic:{name}")})
        cloud.internal_call("sns", "DeleteTopic", name, "agent", account=who.account, region=who.region)
    elif service == "lambda":
        _rest(cloud, who, "lambda", "DELETE", f"/2015-03-31/functions/{name}", None, "DeleteFunction")
    elif service == "apigatewayv2":
        api = next((a for a in apigatewayv2.apis(cloud, who).values() if a["name"] == name or a["id"] == name), None)
        if api is None:
            raise AwsError("NotFoundException", f"API {name} does not exist")
        _rest(cloud, who, "apigatewayv2", "DELETE", f"/v2/apis/{api['id']}", None, "DeleteApi")
    elif service == "secretsmanager":
        _run(cloud, who, secretsmanager, "DeleteSecret", {"SecretId": name, "ForceDeleteWithoutRecovery": True})
    elif service == "ssm":
        _run(cloud, who, ssm, "DeleteParameter", {"Name": name})
    elif service == "scheduler":
        _rest(cloud, who, "scheduler", "DELETE", f"/schedules/{name}", None, "DeleteSchedule")
    elif service == "events":
        _run(cloud, who, events, "DeleteRule", {"Name": name, "Force": True})
    elif service == "stepfunctions":
        _run(cloud, who, stepfunctions, "DeleteStateMachine", {"stateMachineArn": target_arn(cloud, who, f"machine:{name}")})
    else:
        raise AwsError("UnknownService", f"Unknown service {service}")
    return {"removed": f"{service} {name}"}


def invoke(cloud, params):
    who = caller(cloud, params)
    outcome = cloud.runtime.invoke(who.account, who.region, params.get("name"), params.get("event") if params.get("event") is not None else {}, "agent")
    if outcome.get("missing"):
        raise AwsError("ResourceNotFoundException", outcome["payload"]["errorMessage"])
    return {"ok": outcome["ok"], "result": outcome["payload"], "ms": round(outcome["ms"]), "logs": outcome["logs"][-30:]}


def send(cloud, params):
    who = caller(cloud, params)
    from .services import sns, sqs
    message = params.get("message")
    text = message if isinstance(message, str) else json.dumps(message, ensure_ascii=False)
    if params.get("queue"):
        result = _run(cloud, who, sqs, "SendMessage", {"QueueUrl": f"{cloud.endpoint}/{who.account}/{params['queue']}", "MessageBody": text})
        return {"sent": f"queue {params['queue']}", "id": result["MessageId"]}
    if params.get("topic"):
        result = sns.publish(cloud, who, {"TopicArn": target_arn(cloud, who, f"topic:{params['topic']}"), "Message": text})
        cloud.internal_call("sns", "Publish", params["topic"], "agent", account=who.account, region=who.region)
        return {"sent": f"topic {params['topic']}", "id": result["MessageId"]}
    if params.get("bus"):
        from .services import events
        result = _run(cloud, who, events, "PutEvents", {"Entries": [{"Source": params.get("source") or "cloudstudio.agent", "DetailType": params.get("detailType") or "Teste",
                                                                    "Detail": text, "EventBusName": params["bus"]}]})
        return {"sent": f"bus {params['bus']}", "result": result}
    raise AwsError("ValidationException", "Name a queue, a topic or a bus")


def request(cloud, params):
    """Calls one route of a local HTTP API, like the app or a browser would."""
    from .server import Request
    from .services import apigatewayv2 as api_service
    who = caller(cloud, params)
    api = next((a for a in api_service.apis(cloud, who).values() if a["name"] == params.get("api") or a["id"] == params.get("api")), None)
    if api is None:
        raise AwsError("NotFoundException", f"API {params.get('api')} does not exist")
    body = params.get("body")
    data = b"" if body is None else (body if isinstance(body, str) else json.dumps(body, ensure_ascii=False)).encode("utf-8")
    headers = {"Content-Type": "application/json", "User-Agent": "CloudStudio", **{str(k): str(v) for k, v in (params.get("headers") or {}).items()}}
    path = "/" + str(params.get("path") or "/").lstrip("/")
    http = Request((params.get("method") or "GET").upper(), f"/_api/{api['id']}{path}", headers, data, who.region)
    http.source = "agent"
    http.service = "apigatewayv2"
    response = cloud.handle(http)
    text = response.body.decode("utf-8", "replace")
    try:
        parsed = json.loads(text)
    except ValueError:
        parsed = text[:4000]
    return {"status": response.status, "body": parsed}


def run_schedule(cloud, params):
    from .services import scheduler
    who = caller(cloud, params)
    for key, schedule in scheduler.schedules(cloud, who).items():
        if schedule["name"] == params.get("name"):
            scheduler.fire(cloud, schedule, manual=True)
            cloud.store.touch()
            return {"fired": schedule["name"], "target": schedule["target"]["Arn"]}
    raise AwsError("ResourceNotFoundException", f"Schedule {params.get('name')} does not exist")


def run_machine(cloud, params):
    from .services import stepfunctions
    who = caller(cloud, params)
    who.service = "stepfunctions"
    result = run_json(cloud, who, stepfunctions.OPS, "StartSyncExecution" if params.get("wait") else "StartExecution",
                      {"stateMachineArn": target_arn(cloud, who, f"machine:{params.get('name')}"),
                       "input": json.dumps(params.get("input") or {}, ensure_ascii=False)})
    return result


def snapshot(cloud, params):
    resources = cloud.summary()
    counts = {}
    for resource in resources:
        counts[resource["service"]] = counts.get(resource["service"], 0) + 1
    return cloud.store.snapshot(params.get("name") or time.strftime("Cópia %d/%m %H:%M"), {"resources": len(resources), "services": counts})


def restore(cloud, params):
    entry = cloud.store.find_snapshot(params.get("id") or params.get("name"))
    if entry is None:
        raise AwsError("NotFound", f"No copy named {params.get('id') or params.get('name')}")
    try:
        if not cloud.store.restore(entry["id"]):
            raise AwsError("NotFound", "No such copy")
    except StateError as error:
        raise AwsError("InvalidSnapshot", str(error)) from error
    except OSError as error:
        raise AwsError("RestoreFailed", "The restored data could not be saved. Current data was preserved.") from error
    cloud.live.mark("cloud", "resources")
    return {"restored": entry["name"]}


def forget(cloud, params):
    entry = cloud.store.find_snapshot(params.get("id") or params.get("name"))
    if entry is None or not cloud.store.delete_snapshot(entry["id"]):
        raise AwsError("NotFound", "No such copy")
    cloud.live.mark("cloud")
    return {"deleted": entry["name"]}


def reset(cloud, params):
    cloud.store.reset()
    with cloud.history_lock:
        cloud.calls.clear()
        cloud.logs.clear()
        cloud.call_count = cloud.error_count = 0
    cloud.live.mark("cloud", "calls", "logs", "resources")
    return {"reset": True}


def shutdown(cloud, params):
    threading.Thread(target=lambda: (time.sleep(0.2), cloud.stop_server()), daemon=True).start()
    return {"stopping": True}


ACTIONS = {"status": status, "names": names, "calls": calls, "logs": logs, "create": create, "remove": remove, "invoke": invoke, "send": send,
           "request": request, "run-schedule": run_schedule, "run-machine": run_machine, "snapshot": snapshot, "restore": restore,
           "forget": forget, "reset": reset, "shutdown": shutdown}
