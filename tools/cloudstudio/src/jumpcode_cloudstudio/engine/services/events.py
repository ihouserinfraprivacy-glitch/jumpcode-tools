# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Amazon EventBridge (JSON 1.1): event buses, rules with event patterns or schedules, targets with
input, input path and input transformer, and PutEvents delivery."""

import json
import re
import time
import uuid

from .. import wire
from ..wire import AwsError
from . import patterns, timing
from .common import json_service

NAME = "events"
LABEL = "EventBridge"


def handle(cloud, request):
    return json_service(cloud, request, "", "1.1", OPS)


def space(cloud, account, region):
    service = cloud.store.regional(account, region, NAME)
    buses = service.setdefault("buses", {})
    if "default" not in buses:
        buses["default"] = {"name": "default", "arn": wire.arn("events", region, account, "event-bus/default"), "created": time.time(), "rules": {}}
    return buses


def bus_of(cloud, caller, name):
    name = (name or "default").split("/")[-1]
    bus = space(cloud, caller.account, caller.region).get(name)
    if bus is None:
        raise AwsError("ResourceNotFoundException", f"Event bus {name} does not exist.")
    return bus


def rule_of(cloud, caller, params):
    bus = bus_of(cloud, caller, params.get("EventBusName"))
    name = params.get("Name") or params.get("Rule") or ""
    caller.target = name
    rule = bus["rules"].get(name)
    if rule is None:
        raise AwsError("ResourceNotFoundException", f"Rule {name} does not exist on EventBus {bus['name']}.")
    return bus, rule


def create_bus(cloud, caller, params):
    name = params.get("Name") or ""
    caller.target = name
    buses = space(cloud, caller.account, caller.region)
    if name in buses:
        raise AwsError("ResourceAlreadyExistsException", f"Event bus {name} already exists.")
    buses[name] = {"name": name, "arn": wire.arn("events", caller.region, caller.account, f"event-bus/{name}"), "created": time.time(), "rules": {}}
    cloud.store.touch()
    return {"EventBusArn": buses[name]["arn"]}


def delete_bus(cloud, caller, params):
    name = params.get("Name") or ""
    if name == "default":
        raise AwsError("ValidationException", "Cannot delete event bus default.")
    space(cloud, caller.account, caller.region).pop(name, None)
    cloud.store.touch()
    return {}


def list_buses(cloud, caller, params):
    prefix = params.get("NamePrefix") or ""
    return {"EventBuses": [{"Name": b["name"], "Arn": b["arn"]} for b in space(cloud, caller.account, caller.region).values() if b["name"].startswith(prefix)]}


def describe_bus(cloud, caller, params):
    bus = bus_of(cloud, caller, params.get("Name"))
    return {"Name": bus["name"], "Arn": bus["arn"], "CreationTime": bus["created"]}


def put_rule(cloud, caller, params):
    bus = bus_of(cloud, caller, params.get("EventBusName"))
    name = params.get("Name") or ""
    caller.target = name
    if not re.match(r"^[\.\-_A-Za-z0-9]{1,64}$", name):
        raise AwsError("ValidationException", f"1 validation error detected: Value '{name}' at 'name' failed to satisfy constraint")
    pattern = params.get("EventPattern")
    expression = params.get("ScheduleExpression")
    if not pattern and not expression:
        raise AwsError("ValidationException", "Parameter(s) EventPattern or ScheduleExpression must be specified.")
    if pattern:
        try:
            parsed = json.loads(pattern)
            if not isinstance(parsed, dict):
                raise ValueError
        except ValueError as error:
            raise AwsError("InvalidEventPatternException", "Event pattern is not valid. Reason: Filter is not an object") from error
    if expression:
        timing.validate(expression)
    existing = bus["rules"].get(name, {})
    suffix = f"rule/{name}" if bus["name"] == "default" else f"rule/{bus['name']}/{name}"
    rule = {"name": name, "arn": wire.arn("events", caller.region, caller.account, suffix), "pattern": pattern, "expression": expression,
            "state": params.get("State") or "ENABLED", "description": params.get("Description", ""), "targets": existing.get("targets", {}),
            "created": existing.get("created", time.time()), "account": caller.account, "region": caller.region, "matched": existing.get("matched", 0)}
    if expression:
        rule["next"] = timing.next_run(expression, time.time(), None, rule["created"])
    bus["rules"][name] = rule
    cloud.store.touch()
    return {"RuleArn": rule["arn"]}


def _rule_view(bus, rule):
    result = {"Name": rule["name"], "Arn": rule["arn"], "State": rule["state"], "Description": rule.get("description", ""), "EventBusName": bus["name"]}
    if rule.get("pattern"):
        result["EventPattern"] = rule["pattern"]
    if rule.get("expression"):
        result["ScheduleExpression"] = rule["expression"]
    return result


def describe_rule(cloud, caller, params):
    bus, rule = rule_of(cloud, caller, params)
    return {**_rule_view(bus, rule), "CreatedBy": caller.account}


def list_rules(cloud, caller, params):
    bus = bus_of(cloud, caller, params.get("EventBusName"))
    prefix = params.get("NamePrefix") or ""
    return {"Rules": [_rule_view(bus, r) for n, r in sorted(bus["rules"].items()) if n.startswith(prefix)]}


def delete_rule(cloud, caller, params):
    bus, rule = rule_of(cloud, caller, params)
    if rule["targets"] and not params.get("Force"):
        raise AwsError("ValidationException", "Rule can't be deleted since it has targets.")
    del bus["rules"][rule["name"]]
    cloud.store.touch()
    return {}


def set_state(state):
    def change(cloud, caller, params):
        _, rule = rule_of(cloud, caller, params)
        rule["state"] = state
        cloud.store.touch()
        return {}
    return change


def put_targets(cloud, caller, params):
    _, rule = rule_of(cloud, caller, params)
    for target in params.get("Targets") or []:
        if not target.get("Id") or not target.get("Arn"):
            raise AwsError("ValidationException", "Targets need Id and Arn.")
        rule["targets"][target["Id"]] = target
    cloud.store.touch()
    return {"FailedEntryCount": 0, "FailedEntries": []}


def remove_targets(cloud, caller, params):
    _, rule = rule_of(cloud, caller, params)
    for target_id in params.get("Ids") or []:
        rule["targets"].pop(target_id, None)
    cloud.store.touch()
    return {"FailedEntryCount": 0, "FailedEntries": []}


def list_targets(cloud, caller, params):
    _, rule = rule_of(cloud, caller, params)
    return {"Targets": list(rule["targets"].values())}


def list_rule_names_by_target(cloud, caller, params):
    bus = bus_of(cloud, caller, params.get("EventBusName"))
    arn = params.get("TargetArn")
    return {"RuleNames": [r["name"] for r in bus["rules"].values() if any(t["Arn"] == arn for t in r["targets"].values())]}


def put_events(cloud, caller, params):
    entries = params.get("Entries") or []
    if not entries or len(entries) > 10:
        raise AwsError("ValidationException", "1 validation error detected: Value at 'entries' failed to satisfy constraint: Member must have length less than or equal to 10")
    results = []
    failed = 0
    for entry in entries:
        if not entry.get("Source") or not entry.get("DetailType") or entry.get("Detail") is None:
            failed += 1
            results.append({"ErrorCode": "InvalidArgument", "ErrorMessage": "Parameters Source, DetailType and Detail are required."})
            continue
        try:
            detail = json.loads(entry["Detail"])
        except ValueError:
            failed += 1
            results.append({"ErrorCode": "MalformedDetail", "ErrorMessage": "Detail is malformed."})
            continue
        bus = bus_of(cloud, caller, entry.get("EventBusName"))
        event_id = str(uuid.uuid4())
        event = {"version": "0", "id": event_id, "detail-type": entry["DetailType"], "source": entry["Source"], "account": caller.account,
                 "time": wire.iso(entry.get("Time") if isinstance(entry.get("Time"), (int, float)) else None, millis=False),
                 "region": caller.region, "resources": entry.get("Resources") or [], "detail": detail}
        caller.target = entry["Source"]
        route(cloud, bus, event, caller.source)
        results.append({"EventId": event_id})
    return {"FailedEntryCount": failed, "Entries": results}


def route(cloud, bus, event, source):
    for rule in list(bus["rules"].values()):
        if rule["state"] != "ENABLED" or not rule.get("pattern"):
            continue
        if patterns.matches(json.loads(rule["pattern"]), event):
            rule["matched"] = rule.get("matched", 0) + 1
            for target in rule["targets"].values():
                timing.deliver(cloud, target["Arn"], transform(target, event), f"rule:{rule['name']}",
                               (target.get("SqsParameters") or {}).get("MessageGroupId"))
    cloud.store.touch()


def transform(target, event):
    if target.get("Input"):
        return target["Input"]
    if target.get("InputPath"):
        from .stepfunctions import json_path
        return json.dumps(json_path(event, target["InputPath"]), ensure_ascii=False)
    transformer = target.get("InputTransformer")
    if transformer:
        from .stepfunctions import json_path
        values = {}
        for key, path in (transformer.get("InputPathsMap") or {}).items():
            try:
                values[key] = json_path(event, path)
            except Exception:
                values[key] = None
        template = transformer.get("InputTemplate", "")

        def fill(match):
            value = values.get(match.group(1))
            return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
        return re.sub(r"<([A-Za-z0-9_.-]+)>", fill, template)
    return json.dumps(event, ensure_ascii=False)


def put_internal(cloud, bus_arn, text, source):
    parts = bus_arn.split(":")
    account, region, name = parts[4], parts[3], parts[5].split("/", 1)[-1]
    bus = space(cloud, account, region).get(name)
    if bus is None:
        cloud.internal_call(NAME, "PutEvents", name, source, error=("ResourceNotFoundException", f"Event bus {name} does not exist."))
        return
    try:
        event = json.loads(text)
    except ValueError:
        event = {"detail": text}
    if not isinstance(event, dict) or "detail-type" not in event:
        event = {"version": "0", "id": str(uuid.uuid4()), "detail-type": "Scheduled Event", "source": "aws.scheduler", "account": account,
                 "time": wire.iso(millis=False), "region": region, "resources": [], "detail": event}
    route(cloud, bus, event, source)
    cloud.internal_call(NAME, "PutEvents", name, source, account=account, region=region)


def tick(cloud):
    now = time.time()
    for account, region, service in list(cloud.store.each(NAME)):
        for bus in service.get("buses", {}).values():
            for rule in bus["rules"].values():
                if rule["state"] != "ENABLED" or not rule.get("expression") or not rule.get("next") or rule["next"] > now:
                    continue
                event = {"version": "0", "id": str(uuid.uuid4()), "detail-type": "Scheduled Event", "source": "aws.events", "account": account,
                         "time": wire.iso(millis=False), "region": region, "resources": [rule["arn"]], "detail": {}}
                for target in rule["targets"].values():
                    timing.deliver(cloud, target["Arn"], transform(target, event), f"rule:{rule['name']}")
                rule["matched"] = rule.get("matched", 0) + 1
                rule["next"] = timing.next_run(rule["expression"], now, None, rule["created"])
                cloud.store.touch()


OPS = {
    "CreateEventBus": create_bus, "DeleteEventBus": delete_bus, "ListEventBuses": list_buses, "DescribeEventBus": describe_bus,
    "PutRule": put_rule, "DescribeRule": describe_rule, "ListRules": list_rules, "DeleteRule": delete_rule,
    "EnableRule": set_state("ENABLED"), "DisableRule": set_state("DISABLED"), "PutTargets": put_targets, "RemoveTargets": remove_targets,
    "ListTargetsByRule": list_targets, "ListRuleNamesByTarget": list_rule_names_by_target, "PutEvents": put_events,
    "TagResource": lambda cloud, caller, params: {}, "ListTagsForResource": lambda cloud, caller, params: {"Tags": []},
}


def resources(cloud):
    result = []
    for account, region, service in cloud.store.each(NAME):
        for bus in service.get("buses", {}).values():
            for rule in bus["rules"].values():
                result.append({"service": NAME, "kind": "rule", "name": rule["name"], "arn": rule["arn"], "account": account, "region": region,
                               "created": rule["created"], "bus": bus["name"], "pattern": rule.get("pattern"), "expression": rule.get("expression"),
                               "state": rule["state"], "next": rule.get("next"), "matched": rule.get("matched", 0),
                               "targets": [t["Arn"] for t in rule["targets"].values()]})
    return result
