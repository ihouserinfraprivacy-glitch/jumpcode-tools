# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Amazon API Gateway HTTP APIs (v2, REST-JSON): APIs, routes, Lambda and HTTP integrations, stages and CORS,
and the API itself, served at http://127.0.0.1:<port>/_api/<apiId>/<path>."""

import base64
import json
import re
import secrets
import string
import time
import urllib.error
import urllib.request
from urllib.parse import unquote

from .. import wire
from ..wire import AwsError, Response

NAME = "apigatewayv2"
LABEL = "API Gateway"
_PATH = re.compile(r"^/v2/(?P<rest>.*)$")


def handle(cloud, request):
    try:
        if request.path.startswith("/_api/") or ".execute-api." in request.host.split(":")[0]:
            return serve(cloud, request)
        match = _PATH.match(request.path)
        if not match:
            raise AwsError("NotFoundException", "CloudStudio emulates HTTP APIs (API Gateway v2). REST APIs (v1) are not emulated yet.", 404)
        return manage(cloud, request, [p for p in match.group("rest").split("/") if p])
    except AwsError as error:
        return wire.rest_json_error(error)


def apis(cloud, caller):
    return cloud.store.regional(caller.account, caller.region, NAME).setdefault("apis", {})


def _id(length=10):
    return "".join(secrets.choice(string.ascii_lowercase + string.digits) for _ in range(length))


def api_of(cloud, caller, api_id):
    api = apis(cloud, caller).get(api_id)
    if api is None:
        raise AwsError("NotFoundException", f"Invalid API identifier specified {caller.account}:{api_id}", 404)
    caller.target = api["name"]
    return api


def endpoint(cloud, api):
    return f"{cloud.endpoint}/_api/{api['id']}"


def api_view(cloud, api):
    result = {"apiId": api["id"], "name": api["name"], "protocolType": api["protocol"], "apiEndpoint": endpoint(cloud, api),
              "createdDate": wire.iso(api["created"], millis=False), "routeSelectionExpression": "$request.method $request.path",
              "apiKeySelectionExpression": "$request.header.x-api-key", "disableExecuteApiEndpoint": False, "tags": api.get("tags", {}),
              "description": api.get("description", "")}
    if api.get("cors"):
        result["corsConfiguration"] = api["cors"]
    return result


def route_view(route):
    result = {"routeId": route["id"], "routeKey": route["key"], "authorizationType": route.get("auth", "NONE"), "apiKeyRequired": False}
    if route.get("target"):
        result["target"] = route["target"]
    return result


def integration_view(integration):
    return {"integrationId": integration["id"], "integrationType": integration["type"], "integrationUri": integration["uri"],
            "integrationMethod": integration.get("method", "POST"), "payloadFormatVersion": integration.get("payload", "2.0"),
            "timeoutInMillis": integration.get("timeout", 30000), "connectionType": "INTERNET"}


def stage_view(stage):
    return {"stageName": stage["name"], "autoDeploy": stage.get("auto", True), "createdDate": wire.iso(stage["created"], millis=False),
            "lastUpdatedDate": wire.iso(stage["created"], millis=False), "stageVariables": stage.get("variables", {}),
            "defaultRouteSettings": {"DetailedMetricsEnabled": False}, "routeSettings": {}, "tags": {}}


def create_api(cloud, caller, params):
    name = params.get("name") or ""
    caller.target = name
    protocol = params.get("protocolType") or "HTTP"
    if protocol != "HTTP":
        raise AwsError("BadRequestException", "CloudStudio emulates HTTP APIs; WebSocket APIs are not emulated yet.")
    api = {"id": _id(), "name": name, "protocol": protocol, "created": time.time(), "cors": params.get("corsConfiguration"),
           "description": params.get("description", ""), "tags": params.get("tags") or {}, "routes": {}, "integrations": {}, "stages": {}}
    apis(cloud, caller)[api["id"]] = api
    if params.get("target"):
        integration = _integration(api, {"integrationType": "AWS_PROXY", "integrationUri": params["target"], "payloadFormatVersion": "2.0"})
        key = params.get("routeKey") or "$default"
        _route(api, {"routeKey": key, "target": f"integrations/{integration['id']}"})
        api["stages"]["$default"] = {"name": "$default", "created": time.time(), "auto": True}
    cloud.store.touch()
    return api


def _integration(api, params):
    kind = params.get("integrationType") or "AWS_PROXY"
    if kind not in ("AWS_PROXY", "HTTP_PROXY", "MOCK"):
        raise AwsError("BadRequestException", f"CloudStudio supports AWS_PROXY (Lambda) and HTTP_PROXY integrations; {kind} is not emulated.")
    integration = {"id": _id(7), "type": kind, "uri": params.get("integrationUri", ""), "method": params.get("integrationMethod", "POST"),
                   "payload": params.get("payloadFormatVersion") or ("2.0" if kind == "AWS_PROXY" else "1.0"),
                   "timeout": params.get("timeoutInMillis", 30000)}
    api["integrations"][integration["id"]] = integration
    return integration


def _route(api, params):
    key = params.get("routeKey") or ""
    if key != "$default" and not re.match(r"^(ANY|GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /", key):
        raise AwsError("BadRequestException", f"Unable to create route {key}. The route key must be '$default' or '<METHOD> /path'.")
    if any(r["key"] == key for r in api["routes"].values()):
        raise AwsError("ConflictException", f"Unable to complete operation due to concurrent modification. Route {key} already exists.", 409)
    route = {"id": _id(7), "key": key, "target": params.get("target"), "auth": params.get("authorizationType", "NONE")}
    api["routes"][route["id"]] = route
    return route


def manage(cloud, request, parts):
    method = request.method
    body = request.json() if request.body.strip() else {}
    if parts == ["apis"]:
        if method == "POST":
            request.op = "CreateApi"
            return wire.rest_json(api_view(cloud, create_api(cloud, request, body)), 201)
        request.op = "GetApis"
        return wire.rest_json({"items": [api_view(cloud, a) for a in apis(cloud, request).values()]})
    if parts[0] == "tags" and len(parts) > 1:
        api_id = "/".join(parts[1:]).rsplit("/", 1)[-1]
        api = api_of(cloud, request, api_id)
        if method == "GET":
            request.op = "GetTags"
            return wire.rest_json({"tags": api.get("tags", {})})
        request.op = "TagResource" if method == "POST" else "UntagResource"
        if method == "POST":
            api.setdefault("tags", {}).update(body.get("tags") or {})
        else:
            for key in [v for k, v in request.query_pairs if k == "tagKeys"]:
                api.setdefault("tags", {}).pop(key, None)
        cloud.store.touch()
        return Response(201 if method == "POST" else 204, b"")
    if parts[0] != "apis" or len(parts) < 2:
        raise AwsError("NotFoundException", "Not found", 404)
    api = api_of(cloud, request, parts[1])
    sub = parts[2] if len(parts) > 2 else ""
    item = parts[3] if len(parts) > 3 else ""
    if not sub:
        if method == "GET":
            request.op = "GetApi"
            return wire.rest_json(api_view(cloud, api))
        if method == "DELETE":
            request.op = "DeleteApi"
            del apis(cloud, request)[api["id"]]
            cloud.store.touch()
            return Response(204, b"")
        if method == "PATCH":
            request.op = "UpdateApi"
            if "name" in body:
                api["name"] = body["name"]
            if "corsConfiguration" in body:
                api["cors"] = body["corsConfiguration"]
            if "description" in body:
                api["description"] = body["description"]
            cloud.store.touch()
            return wire.rest_json(api_view(cloud, api))
    collections = {"routes": ("Route", api["routes"], route_view), "integrations": ("Integration", api["integrations"], integration_view),
                   "stages": ("Stage", api["stages"], stage_view)}
    if sub == "deployments":
        request.op = "CreateDeployment" if method == "POST" else "GetDeployments"
        deployment = {"deploymentId": _id(6), "deploymentStatus": "DEPLOYED", "createdDate": wire.iso(millis=False), "autoDeployed": False}
        return wire.rest_json(deployment, 201) if method == "POST" else wire.rest_json({"items": []})
    if sub not in collections:
        raise AwsError("NotFoundException", f"CloudStudio does not emulate API Gateway {sub} yet.", 404)
    label, collection, view = collections[sub]
    if not item:
        if method == "POST":
            request.op = f"Create{label}"
            if sub == "routes":
                created = _route(api, body)
            elif sub == "integrations":
                created = _integration(api, body)
            else:
                name = body.get("stageName") or ""
                if name in api["stages"]:
                    raise AwsError("ConflictException", f"Stage already exists: {name}", 409)
                created = api["stages"][name] = {"name": name, "created": time.time(), "auto": body.get("autoDeploy", False),
                                                 "variables": body.get("stageVariables") or {}}
            cloud.store.touch()
            return wire.rest_json(view(created), 201)
        request.op = f"Get{label}s"
        return wire.rest_json({"items": [view(v) for v in collection.values()]})
    entry = collection.get(item)
    if entry is None:
        raise AwsError("NotFoundException", f"Invalid {label} identifier specified {item}", 404)
    if method == "GET":
        request.op = f"Get{label}"
        return wire.rest_json(view(entry))
    if method == "DELETE":
        request.op = f"Delete{label}"
        del collection[item]
        cloud.store.touch()
        return Response(204, b"")
    if method == "PATCH":
        request.op = f"Update{label}"
        mapping = {"routeKey": "key", "target": "target", "integrationUri": "uri", "payloadFormatVersion": "payload",
                   "integrationType": "type", "autoDeploy": "auto", "stageVariables": "variables"}
        for field, key in mapping.items():
            if field in body:
                entry[key] = body[field]
        cloud.store.touch()
        return wire.rest_json(view(entry))
    raise AwsError("NotFoundException", "Not found", 404)


# ---------------------------------------------------------------- serving the API

def _match(template, path):
    """Path parameters when a route path like /agendamentos/{id} or /files/{proxy+} matches, else None."""
    t_parts = [p for p in template.split("/") if p]
    p_parts = [p for p in path.split("/") if p]
    params = {}
    for index, part in enumerate(t_parts):
        if part.startswith("{") and part.endswith("+}"):
            if index >= len(p_parts):
                return None
            params[part[1:-2]] = "/".join(p_parts[index:])
            return params
        if index >= len(p_parts):
            return None
        if part.startswith("{") and part.endswith("}"):
            params[part[1:-1]] = p_parts[index]
        elif part != p_parts[index]:
            return None
    return params if len(t_parts) == len(p_parts) else None


def find_route(api, method, path):
    best = None
    for route in api["routes"].values():
        if route["key"] == "$default":
            continue
        verb, template = route["key"].split(" ", 1)
        if verb not in (method, "ANY"):
            continue
        params = _match(template, path)
        if params is None:
            continue
        literal = sum(1 for p in template.split("/") if p and not p.startswith("{"))
        score = (literal, verb != "ANY", -sum(1 for p in template.split("/") if p.endswith("+}")))
        if best is None or score > best[0]:
            best = (score, route, params)
    if best:
        return best[1], best[2]
    default = next((r for r in api["routes"].values() if r["key"] == "$default"), None)
    return (default, {}) if default else (None, None)


def _cors_headers(api, request):
    cors = api.get("cors")
    if not cors:
        return {}
    origins = cors.get("allowOrigins") or []
    origin = request.headers.get("origin", "")
    headers = {}
    if "*" in origins:
        headers["Access-Control-Allow-Origin"] = "*"
    elif origin in origins:
        headers["Access-Control-Allow-Origin"] = origin
    if cors.get("allowMethods"):
        headers["Access-Control-Allow-Methods"] = ",".join(cors["allowMethods"])
    if cors.get("allowHeaders"):
        headers["Access-Control-Allow-Headers"] = ",".join(cors["allowHeaders"])
    if cors.get("allowCredentials"):
        headers["Access-Control-Allow-Credentials"] = "true"
    return headers


def serve(cloud, request):
    host = request.host.split(":")[0]
    if ".execute-api." in host:
        api_id, rest = host.split(".", 1)[0], request.raw_path
    else:
        _, _, api_id, *tail = request.raw_path.split("/", 3)
        rest = "/" + (tail[0] if tail else "")
    api = None
    for account, region, service in cloud.store.each(NAME):
        if api_id in service.get("apis", {}):
            api = service["apis"][api_id]
            request.account, request.region = account, region
            break
    request.op = "Request"
    if api is None:
        request.target = api_id
        return wire.rest_json({"message": "Not Found"}, 404, {"x-amzn-ErrorType": "NotFoundException"})
    request.target = api["name"]
    segments = [s for s in rest.split("/") if s]
    stage = "$default"
    if segments and segments[0] in api["stages"] and segments[0] != "$default":
        stage = segments[0]
        rest = "/" + "/".join(segments[1:])
    path = unquote(rest) or "/"
    cors = _cors_headers(api, request)
    if request.method == "OPTIONS" and api.get("cors"):
        request.op = f"OPTIONS {path}"
        return Response(204, b"", cors)
    route, params = find_route(api, request.method, path)
    request.op = f"{request.method} {path}"
    if route is None or not route.get("target"):
        return wire.rest_json({"message": "Not Found"}, 404, {**cors, "x-amzn-ErrorType": "NotFoundException"})
    integration = api["integrations"].get(route["target"].split("/")[-1])
    if integration is None:
        return wire.rest_json({"message": "Internal Server Error"}, 500, cors)
    request.note_req = {"route": route["key"], "path": path, "body": request.body[:1200].decode("utf-8", "replace")}
    if integration["type"] == "HTTP_PROXY":
        return _http_proxy(cloud, request, integration, path, cors)
    if integration["type"] == "MOCK":
        return Response(200, b"", cors)
    event = _event(request, api, route, stage, path, params, integration["payload"])
    target = integration["uri"]
    match = re.search(r"(arn:aws:lambda:[^/]+)", target)
    function_arn = match.group(1) if match else target
    account, region, name = _lambda_parts(function_arn, request)
    outcome = cloud.runtime.invoke(account, region, name, event, f"api:{api['name']}")
    if not outcome["ok"]:
        request.note_res = outcome["payload"]
        return wire.rest_json({"message": "Internal Server Error"}, 500, {**cors, "x-amzn-ErrorType": "InternalServerErrorException"})
    response = _response(outcome["payload"], integration["payload"])
    response.headers.update({k: v for k, v in cors.items() if k not in response.headers})
    request.note_res = {"status": response.status, "body": response.body[:1200].decode("utf-8", "replace")}
    return response


def _lambda_parts(arn, request):
    parts = arn.split(":")
    if len(parts) >= 7:
        return parts[4], parts[3], parts[6]
    return request.account, request.region, arn


def _event(request, api, route, stage, path, params, version):
    headers = {}
    for key, value in request.headers.items():
        headers[key] = value if key not in headers else headers[key] + "," + value
    query = {}
    for key, value in request.query_pairs:
        query[key] = value if key not in query else query[key] + "," + value
    body = request.body
    text_types = ("text/", "application/json", "application/xml", "application/x-www-form-urlencoded", "application/javascript")
    binary = bool(body) and not request.headers.get("content-type", "").startswith(text_types)
    encoded = base64.b64encode(body).decode() if binary else body.decode("utf-8", "replace")
    now = time.time()
    context = {"accountId": request.account, "apiId": api["id"], "domainName": request.host.split(":")[0] or "127.0.0.1",
               "domainPrefix": api["id"], "requestId": request.id, "stage": stage,
               "time": time.strftime("%d/%b/%Y:%H:%M:%S +0000", time.gmtime(now)), "timeEpoch": int(now * 1000)}
    raw_query = request.raw_query
    if version == "1.0":
        return {"version": "1.0", "resource": route["key"].split(" ", 1)[-1], "path": path, "httpMethod": request.method,
                "headers": headers, "multiValueHeaders": {k: v.split(",") for k, v in headers.items()},
                "queryStringParameters": query or None, "multiValueQueryStringParameters": {k: v.split(",") for k, v in query.items()} or None,
                "pathParameters": params or None, "stageVariables": api["stages"].get(stage, {}).get("variables") or None,
                "requestContext": {**context, "httpMethod": request.method, "path": path, "protocol": "HTTP/1.1",
                                   "resourcePath": route["key"].split(" ", 1)[-1], "identity": {"sourceIp": "127.0.0.1",
                                                                                                "userAgent": request.headers.get("user-agent", "")}},
                "body": encoded or None, "isBase64Encoded": binary}
    cookies = [c.strip() for c in request.headers.get("cookie", "").split(";") if c.strip()]
    event = {"version": "2.0", "routeKey": route["key"], "rawPath": path, "rawQueryString": raw_query, "headers": headers,
             "requestContext": {**context, "routeKey": route["key"],
                                "http": {"method": request.method, "path": path, "protocol": "HTTP/1.1", "sourceIp": "127.0.0.1",
                                         "userAgent": request.headers.get("user-agent", "")}},
             "isBase64Encoded": binary}
    if cookies:
        event["cookies"] = cookies
    if query:
        event["queryStringParameters"] = query
    if params:
        event["pathParameters"] = params
    if body:
        event["body"] = encoded
    variables = api["stages"].get(stage, {}).get("variables")
    if variables:
        event["stageVariables"] = variables
    return event


def _response(payload, version):
    if isinstance(payload, dict) and ("statusCode" in payload or version == "1.0"):
        status = int(payload.get("statusCode") or 200)
        headers = {str(k): str(v) for k, v in (payload.get("headers") or {}).items()}
        for key, values in (payload.get("multiValueHeaders") or {}).items():
            headers[key] = ",".join(str(v) for v in values)
        for cookie in payload.get("cookies") or []:
            headers["Set-Cookie"] = cookie
        body = payload.get("body")
        if body is None:
            data = b""
        elif payload.get("isBase64Encoded"):
            data = base64.b64decode(body)
        else:
            data = (body if isinstance(body, str) else json.dumps(body, ensure_ascii=False)).encode("utf-8")
        headers.setdefault("Content-Type", "application/json" if data[:1] in (b"{", b"[") else "text/plain; charset=utf-8")
        return Response(status, data, headers)
    data = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8") if not isinstance(payload, str) else payload.encode("utf-8")
    return Response(200, data, {"Content-Type": "application/json"})


def _http_proxy(cloud, request, integration, path, cors):
    from ..local_http import open_local, require_local_url
    target = integration["uri"]
    require_local_url(target)
    url = target.replace("{proxy}", path.lstrip("/")) if "{proxy}" in target else target.rstrip("/") + path
    if request.raw_query:
        url += "?" + request.raw_query
    forward = urllib.request.Request(url, request.body or None, method=request.method,
                                     headers={k: v for k, v in request.headers.items() if k not in ("host", "content-length", "connection")})
    try:
        with open_local(forward, timeout=integration.get("timeout", 30000) / 1000) as answer:
            data = answer.read()
            headers = {k: v for k, v in answer.headers.items() if k.lower() not in ("transfer-encoding", "connection", "content-length")}
            return Response(answer.status, data, {**headers, **cors})
    except urllib.error.HTTPError as error:
        return Response(error.code, error.read(), cors)
    except OSError as error:
        return wire.rest_json({"message": f"The HTTP integration did not answer: {error}"}, 502, cors)


def resources(cloud):
    result = []
    for account, region, service in cloud.store.each(NAME):
        for api in service.get("apis", {}).values():
            routes = []
            for route in api["routes"].values():
                integration = api["integrations"].get((route.get("target") or "").split("/")[-1]) or {}
                uri = integration.get("uri", "")
                match = re.search(r"function:([A-Za-z0-9_-]+)", uri)
                routes.append({"key": route["key"], "type": integration.get("type"), "function": match.group(1) if match else None,
                               "uri": None if match else uri})
            result.append({"service": NAME, "kind": "api", "name": api["name"], "id": api["id"], "arn": f"arn:aws:apigateway:{region}::/apis/{api['id']}",
                           "account": account, "region": region, "created": api["created"], "url": endpoint(cloud, api),
                           "stages": sorted(api["stages"]), "routes": sorted(routes, key=lambda r: r["key"]), "cors": bool(api.get("cors"))})
    return result
