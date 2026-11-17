# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""The actions the model calls: turn the local cloud on and off, create and use resources, read what the app did,
write the project's .env.local, keep copies of the state, and point the Studio at something."""

import json
import time

from . import process
from .common import (CloudStudioError, merge_env_file, project_path, read_env, read_json, source_root, studio_root, write_json)

SERVICES = {"bucket": "s3", "table": "dynamodb", "queue": "sqs", "topic": "sns", "function": "lambda", "api": "apigatewayv2",
            "secret": "secretsmanager", "parameter": "ssm", "schedule": "scheduler", "rule": "events", "statemachine": "stepfunctions"}
LABELS = {value: key for key, value in SERVICES.items()}
FIELDS = {
    "s3": set(), "dynamodb": {"key", "keyType", "sort", "sortType", "indexes", "ttl", "items"},
    "sqs": {"dlq", "maxReceives", "fifo", "visibility"}, "sns": {"subscribe"},
    "lambda": {"folder", "handler", "runtime", "env", "timeout", "queue", "batch", "deadLetter"}, "apigatewayv2": {"routes", "cors"},
    "secretsmanager": {"fromEnv", "value"}, "ssm": {"value", "secure"}, "scheduler": {"expression", "timezone", "target", "input"},
    "events": {"pattern", "expression", "targets", "bus"}, "stepfunctions": {"definition"},
}
ALIASES = {"sqs": {"deadLetter": "dlq"}, "lambda": {"dlq": "deadLetter"}}
SETTINGS_FILE = "settings.json"
VIEW_FILE = "view.json"
CLOUD_FILE = "cloud.json"
VIEWS = ("overview", "resources", "map", "calls", "logs", "copies", "catalog", "settings")
ENV_HEADER = "# Nuvem local do CloudStudio (sem custo, só neste computador)"


def run(arguments, context, cancelled=None):
    if cancelled is not None and cancelled():
        raise CloudStudioError("The operation was cancelled.")
    root = studio_root(context)
    action = arguments["action"]
    handler = ACTIONS[action]
    namespace = {key: arguments[key] for key in ("account", "region") if arguments.get(key)}
    with process.call_context(namespace, cancelled):
        return handler(root, context, arguments)


def settings(root):
    value = read_json(root / SETTINGS_FILE, {}) or {}
    return {"storage": value.get("storage", "memory"), "region": value.get("region", "us-east-1"),
            "python": value.get("python"), "node": value.get("node")}


def _engine(root, context, auto=True):
    engine = process.running(root)
    if engine is None and auto:
        engine, _ = _start(root, settings(root))
    if engine is None:
        raise CloudStudioError("The local cloud is off. Call start first.")
    return engine


def _start(root, chosen):
    engine, started = process.start(root, chosen["storage"], chosen["region"], python=chosen.get("python"), node=chosen.get("node"))
    return engine, started


def _stale_file(root):
    """A cloud.json left as running by a process that no longer exists is set to stopped."""
    data = read_json(root / CLOUD_FILE)
    if isinstance(data, dict) and data.get("status") in ("running", "starting"):
        data["status"] = "stopped"
        data["updatedAt"] = time.time()
        write_json(root / CLOUD_FILE, data)


# ---------------------------------------------------------------- on and off

def status(root, context, arguments):
    engine = process.running(root)
    if engine is None:
        _stale_file(root)
        chosen = settings(root)
        return {"ok": True, "running": False, "storage": chosen["storage"], "region": chosen["region"],
                "message": "The local cloud is off. Call start when the user wants to use it (create, invoke and the others start it too)."}
    value = engine.call("status")
    lines = value.get("resources") or []
    message = (f"The local cloud is running at {engine.endpoint} (region {value['region']}, {'saved between sessions' if value['storage'] == 'persistent' else 'memory only'}). "
               f"{len(lines)} resources, {value['calls']} calls, {value['errors']} with errors.")
    return {"ok": True, "running": True, "endpoint": engine.endpoint, "region": value["region"], "storage": value["storage"],
            "resources": lines, "problems": value.get("problems") or [], "runtimes": value.get("runtimes"), "message": message}


def start(root, context, arguments):
    chosen = settings(root)
    for key in ("storage", "region"):
        if arguments.get(key):
            chosen[key] = arguments[key]
    write_json(root / SETTINGS_FILE, {"schema": 1, **{k: v for k, v in chosen.items() if v is not None}})
    current = process.running(root)
    if current is not None and (current.storage != chosen["storage"] or current.region != chosen["region"]):
        process.stop(root)
    engine, started = _start(root, chosen)
    keep = "kept between sessions" if chosen["storage"] == "persistent" else "kept in memory (lost when it stops)"
    message = (f"{'Started' if started else 'Already running'}: local AWS at {engine.endpoint}, region {chosen['region']}, data {keep}. "
               f"Apps reach it with AWS_ENDPOINT_URL={engine.endpoint} and any access key (env writes them to .env.local, only when the user asks). "
               "Now tell the user in one short sentence.")
    return {"ok": True, "running": True, "endpoint": engine.endpoint, "region": chosen["region"], "storage": chosen["storage"],
            "readyMs": getattr(engine, "ready_ms", None), "message": message}


def stop(root, context, arguments):
    stopped = process.stop(root)
    if not stopped:
        _stale_file(root)
    chosen = settings(root)
    note = "Saved data comes back on the next start." if chosen["storage"] == "persistent" else "Its data was in memory and is gone."
    return {"ok": True, "running": False, "message": ("The local cloud stopped. " + note) if stopped else "The local cloud was already off."}


# ---------------------------------------------------------------- resources

def _guess_service(arguments):
    """The kind of resource the fields point to, when the model left service out."""
    for fields, kind in ((("folder", "handler", "runtime"), "function"), (("key", "sort", "indexes"), "table"), (("routes",), "api"),
                         (("dlq", "fifo", "maxReceives", "visibility"), "queue"), (("subscribe",), "topic"), (("fromEnv",), "secret"),
                         (("definition",), "statemachine"), (("pattern", "targets"), "rule"), (("expression", "target"), "schedule"),
                         (("value", "secure"), "parameter")):
        if any(field in arguments for field in fields):
            return kind
    return None


def _only(root, context, service, given, word):
    """The name the model gave, or the only resource of that kind when it gave none."""
    if given:
        return given
    names = _engine(root, context).call("names").get(service, [])
    if len(names) == 1:
        return names[0]
    raise CloudStudioError(f"Give the {word} name" + (f": one of {', '.join(names)}" if names else f"; there is no {word} yet"))


def create(root, context, arguments):
    service = SERVICES.get(arguments.get("service") or _guess_service(arguments))
    if service is None:
        raise CloudStudioError(f"service must be one of {', '.join(SERVICES)}")
    name = (arguments.get("name") or "").strip()
    if not name:
        raise CloudStudioError("Give the resource a name")
    spec = {key: value for key, value in arguments.items() if key not in ("action", "service", "name", "account", "region")}
    # Small models mix up the fields of similar resources: accept the obvious synonyms, say what was left out.
    for wrong, right in ALIASES.get(service, {}).items():
        if wrong in spec and right not in spec:
            spec[right] = spec.pop(wrong)
    ignored = sorted(key for key in spec if key not in FIELDS[service])
    for key in ignored:
        spec.pop(key)
    spec["service"] = service
    spec["name"] = name
    note = f" Ignored for a {LABELS[service]}: {', '.join(ignored)}." if ignored else ""
    if service == "dynamodb" and not spec.get("key"):
        raise CloudStudioError("A table needs key (the partition key attribute, such as id)")
    if service == "lambda":
        if not spec.get("folder"):
            raise CloudStudioError("A function needs folder: the project folder with its code, such as src/agendar")
        spec["folder"] = str(project_path(context, spec["folder"]))
        runtime = spec.get("runtime") or "python3.12"
        spec["runtime"] = {"python": "python3.12", "node": "nodejs20.x", "nodejs": "nodejs20.x"}.get(runtime, runtime)
    if service == "secretsmanager":
        if "value" in spec:
            raise CloudStudioError("Never pass a secret's value. Use fromEnv with the name of the variable in the project's .env file.")
        variable = spec.pop("fromEnv", None)
        if variable:
            values = read_env(context)
            value = values.get(variable)
            spec["value"] = value if value is not None else ""
            spec["fromEnv"] = variable
            note += (f" Its value came from {variable} in the project's .env ({len(value)} characters)." if value else
                     f" {variable} is {'empty' if value == '' else 'not set'} in the project's .env, so the secret is empty; tell the user to fill it and call create again.")
        else:
            spec["value"] = ""
            note += " The secret is empty; ask the user to put the value in the project's .env and call create again with fromEnv."
    if service == "scheduler" and not (spec.get("expression") and spec.get("target")):
        raise CloudStudioError("A schedule needs expression (rate(1 hour), cron(0 12 * * ? *) or at(2026-12-01T09:00:00)) and target (function:name, queue:name or topic:name)")
    if service == "stepfunctions" and not spec.get("definition"):
        raise CloudStudioError("A state machine needs definition (Amazon States Language)")
    engine = _engine(root, context)
    result = engine.call("create", spec)
    _focus(root, f"{LABELS[service]}:{name}", "resources", "")
    what = result.get("created") or result.get("updated")
    extra = ""
    if result.get("url"):
        extra = f" URL: {result['url']}."
    if result.get("trigger"):
        extra += f" Runs for each message in {result['trigger']}."
    if service == "sqs":
        extra += (f" Messages that fail {result['maxReceives']} times go to the dead-letter queue {result['dlq']}." if result.get("dlq")
                  else " It has no dead-letter queue (give dlq to add one).")
    return {"ok": True, **{k: v for k, v in result.items() if k != "size"},
            "message": f"{'Created' if result.get('created') else 'Updated'} {what} in the local cloud.{extra}{note}"}


def remove(root, context, arguments):
    service = SERVICES.get(arguments.get("service"))
    if service is None or not arguments.get("name"):
        raise CloudStudioError(f"Give service ({', '.join(SERVICES)}) and name")
    result = _engine(root, context, auto=False).call("remove", {"service": service, "name": arguments["name"]})
    return {"ok": True, **result, "message": f"Removed {LABELS[service]} {arguments['name']} from the local cloud."}


# ---------------------------------------------------------------- using

def invoke(root, context, arguments):
    name = _only(root, context, "lambda", arguments.get("name"), "function")
    event = arguments.get("event")
    if isinstance(event, str):
        try:
            event = json.loads(event)
        except ValueError:
            pass
    result = _engine(root, context).call("invoke", {"name": name, "event": event if event is not None else {}}, timeout=330)
    _focus(root, f"function:{name}", "resources", "")
    arguments = {**arguments, "name": name}
    state = "returned" if result["ok"] else "failed"
    hint = ""
    text = json.dumps(result.get("result"), ensure_ascii=False)
    if not result["ok"] and "No module named" in text and ("boto3" in text or "aws-sdk" in text):
        hint = (" The function imports the AWS SDK, which Lambda includes but this computer does not: tell the user to install it"
                " (py -m pip install boto3, or npm install @aws-sdk/client-... in the project).")
    return {"ok": True, "succeeded": result["ok"], "result": result["result"], "ms": result["ms"], "logs": result["logs"][-15:],
            "message": f"The function {arguments['name']} {state} in {result['ms']} ms.{hint}"}


def send(root, context, arguments):
    payload = {key: arguments[key] for key in ("queue", "topic", "bus", "message") if key in arguments}
    if not any(key in payload for key in ("queue", "topic", "bus")):
        raise CloudStudioError("Say where to send: queue, topic or bus")
    result = _engine(root, context).call("send", payload)
    return {"ok": True, **result, "message": f"Sent to {result.get('sent')}."}


def request(root, context, arguments):
    api = _only(root, context, "apigatewayv2", arguments.get("api"), "api")
    body = arguments.get("body")
    if isinstance(body, str):
        try:
            body = json.loads(body)
        except ValueError:
            pass
    payload = {"api": api, "method": arguments.get("method") or ("POST" if body is not None else "GET"), "path": arguments.get("path") or "/", "body": body}
    result = _engine(root, context).call("request", payload, timeout=330)
    _focus(root, f"api:{api}", "resources", "")
    return {"ok": True, **result, "message": f"{payload['method']} {payload['path']} on {api} answered {result['status']}."}


def run_machine(root, context, arguments):
    name = _only(root, context, "stepfunctions", arguments.get("name"), "statemachine")
    result = _engine(root, context).call("run-machine", {"name": name, "input": arguments.get("input") or {}, "wait": True}, timeout=330)
    _focus(root, f"statemachine:{name}", "resources", "")
    return {"ok": True, "status": result.get("status"), "output": result.get("output"), "error": result.get("error"), "cause": result.get("cause"),
            "message": f"The state machine {name} finished with {result.get('status')}."}


def calls(root, context, arguments):
    payload = {"errors": bool(arguments.get("errors")), "limit": arguments.get("limit") or 15}
    if arguments.get("service"):
        payload["service"] = SERVICES.get(arguments["service"], arguments["service"])
    if arguments.get("name"):
        payload["target"] = arguments["name"]
    result = _engine(root, context, auto=False).call("calls", payload)
    items = [{"at": time.strftime("%H:%M:%S", time.localtime(c["at"])), "service": c["service"], "op": c["op"], "target": c.get("target"),
              "from": c.get("source"), "status": c["status"], "error": c.get("error"), "request": c.get("req"), "response": c.get("res")}
             for c in result["calls"]]
    if arguments.get("errors"):
        _focus(root, None, "calls", "")
    return {"ok": True, "calls": items, "message": f"{len(items)} calls."}


def logs(root, context, arguments):
    payload = {"limit": arguments.get("limit") or 40}
    if arguments.get("name"):
        payload["function"] = arguments["name"]
    result = _engine(root, context, auto=False).call("logs", payload)
    return {"ok": True, "lines": result["lines"], "message": f"{len(result['lines'])} log lines."}


def env(root, context, arguments):
    project = source_root(context, required=True)
    engine = _engine(root, context)
    chosen = settings(root)
    values = {"AWS_ENDPOINT_URL": engine.endpoint, "AWS_REGION": chosen["region"], "AWS_DEFAULT_REGION": chosen["region"],
              "AWS_ACCESS_KEY_ID": "test", "AWS_SECRET_ACCESS_KEY": "test"}
    path = project / ".env.local"
    merge_env_file(path, values, ENV_HEADER)
    return {"ok": True, "file": ".env.local", "variables": values,
            "message": "Wrote .env.local with AWS_ENDPOINT_URL, AWS_REGION and test keys. Code that reads these variables (boto3 1.28+, AWS SDK for JavaScript v3) now talks to the local cloud."}


def snapshot(root, context, arguments):
    result = _engine(root, context, auto=False).call("snapshot", {"name": arguments.get("name")})
    _focus(root, None, "copies", "")
    return {"ok": True, "copy": result, "message": f"Saved a copy named '{result['name']}'. restore with that name brings it back."}


def restore(root, context, arguments):
    result = _engine(root, context).call("restore", {"name": arguments.get("name")})
    return {"ok": True, **result, "message": f"The local cloud is back to the copy '{result['restored']}'."}


def reset(root, context, arguments):
    _engine(root, context, auto=False).call("reset")
    return {"ok": True, "message": "Every resource and its data was removed from the local cloud. Copies were kept."}


def _focus(root, select, view, note):
    if select and not select.startswith("["):
        kind, separator, name = select.partition(":")
        namespace = process.call_namespace()
        engine = process.running(root)
        if separator:
            select = json.dumps([kind, namespace.get("account", "000000000000"),
                                 "" if kind == "bucket" else namespace.get("region", engine.region if engine else settings(root)["region"]), name], ensure_ascii=False, separators=(",", ":"))
    current = read_json(root / VIEW_FILE, {}) or {}
    write_json(root / VIEW_FILE, {"schema": 1, "revision": int(current.get("revision", 0)) + 1, "view": view, "select": select, "note": note})


def focus(root, context, arguments):
    view = arguments.get("view") or "resources"
    select = arguments.get("select")
    _focus(root, select, view, arguments.get("note") or "")
    return {"ok": True, "message": f"The Studio shows {select or view}."}


ACTIONS = {"status": status, "start": start, "stop": stop, "create": create, "remove": remove, "invoke": invoke, "send": send,
           "request": request, "run": run_machine, "calls": calls, "logs": logs, "env": env, "snapshot": snapshot, "restore": restore,
           "reset": reset, "focus": focus}
