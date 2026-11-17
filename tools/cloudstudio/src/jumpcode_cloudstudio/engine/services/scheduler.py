# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Amazon EventBridge Scheduler (REST-JSON): schedules with rate, cron and one-time expressions that fire
their target on time while the local cloud is running."""

import re
import time

from .. import wire
from ..wire import AwsError, Response
from . import timing

NAME = "scheduler"
LABEL = "EventBridge Scheduler"
_PATH = re.compile(r"^/(?P<kind>schedules|schedule-groups|tags)/?(?P<name>[^/]*)$")


def handle(cloud, request):
    try:
        match = _PATH.match(request.path)
        if not match:
            raise AwsError("ResourceNotFoundException", f"CloudStudio does not emulate Scheduler {request.method} {request.path}.", 404)
        kind, name = match.group("kind"), match.group("name")
        body = request.json() if request.body.strip() else {}
        if kind == "schedule-groups":
            return groups_call(cloud, request, name, body)
        if kind == "tags":
            request.op = "ListTagsForResource"
            return wire.rest_json({"Tags": []})
        if not name:
            request.op = "ListSchedules"
            group = request.query.get("ScheduleGroup")
            prefix = request.query.get("NamePrefix", "")
            items = [summary(s) for s in schedules(cloud, request).values()
                     if (not group or s["group"] == group) and s["name"].startswith(prefix)]
            return wire.rest_json({"Schedules": items})
        group = request.query.get("groupName") or body.get("GroupName") or "default"
        request.target = name
        key = f"{group}/{name}"
        existing = schedules(cloud, request)
        if request.method == "POST":
            request.op = "CreateSchedule"
            if key in existing:
                raise AwsError("ConflictException", f"Schedule {name} already exists.", 409)
            schedule = build(cloud, request, name, group, body)
            existing[key] = schedule
            cloud.store.touch()
            return wire.rest_json({"ScheduleArn": schedule["arn"]})
        schedule = existing.get(key)
        if schedule is None:
            raise AwsError("ResourceNotFoundException", f"Schedule {name} does not exist.", 404)
        if request.method == "PUT":
            request.op = "UpdateSchedule"
            updated = build(cloud, request, name, group, body)
            updated["created"] = schedule["created"]
            existing[key] = updated
            cloud.store.touch()
            return wire.rest_json({"ScheduleArn": updated["arn"]})
        if request.method == "DELETE":
            request.op = "DeleteSchedule"
            del existing[key]
            cloud.store.touch()
            return wire.rest_json({})
        request.op = "GetSchedule"
        return wire.rest_json(view(schedule))
    except AwsError as error:
        return wire.rest_json_error(error)


def schedules(cloud, caller):
    return cloud.store.regional(caller.account, caller.region, NAME).setdefault("schedules", {})


def build(cloud, caller, name, group, body):
    expression = timing.validate(body.get("ScheduleExpression"))
    target = body.get("Target") or {}
    if not target.get("Arn"):
        raise AwsError("ValidationException", "1 validation error detected: Value null at 'target.arn' failed to satisfy constraint: Member must not be null")
    now = time.time()
    schedule = {"name": name, "group": group, "arn": wire.arn("scheduler", caller.region, caller.account, f"schedule/{group}/{name}"),
                "expression": expression, "timezone": body.get("ScheduleExpressionTimezone") or "UTC", "state": body.get("State") or "ENABLED",
                "target": target, "description": body.get("Description", ""), "created": now, "modified": now,
                "window": body.get("FlexibleTimeWindow") or {"Mode": "OFF"}, "after": body.get("ActionAfterCompletion") or "NONE",
                "account": caller.account, "region": caller.region, "runs": []}
    schedule["next"] = timing.next_run(expression, now, schedule["timezone"], now)
    return schedule


def view(schedule):
    return {"Arn": schedule["arn"], "Name": schedule["name"], "GroupName": schedule["group"], "ScheduleExpression": schedule["expression"],
            "ScheduleExpressionTimezone": schedule["timezone"], "State": schedule["state"], "Target": schedule["target"],
            "Description": schedule["description"], "FlexibleTimeWindow": schedule["window"], "ActionAfterCompletion": schedule["after"],
            "CreationDate": schedule["created"], "LastModificationDate": schedule["modified"]}


def summary(schedule):
    return {"Arn": schedule["arn"], "Name": schedule["name"], "GroupName": schedule["group"], "State": schedule["state"],
            "CreationDate": schedule["created"], "LastModificationDate": schedule["modified"], "Target": {"Arn": schedule["target"]["Arn"]}}


def groups_call(cloud, request, name, body):
    service = cloud.store.regional(request.account, request.region, NAME)
    groups = service.setdefault("groups", {})
    if not name:
        request.op = "ListScheduleGroups"
        names = ["default"] + sorted(groups)
        return wire.rest_json({"ScheduleGroups": [{"Name": n, "Arn": wire.arn("scheduler", request.region, request.account, f"schedule-group/{n}"),
                                                   "State": "ACTIVE"} for n in names]})
    arn = wire.arn("scheduler", request.region, request.account, f"schedule-group/{name}")
    if request.method == "POST":
        request.op = "CreateScheduleGroup"
        groups[name] = {"created": time.time()}
        cloud.store.touch()
        return wire.rest_json({"ScheduleGroupArn": arn})
    if request.method == "DELETE":
        request.op = "DeleteScheduleGroup"
        groups.pop(name, None)
        cloud.store.touch()
        return Response(200, b"{}", {"Content-Type": "application/json"})
    request.op = "GetScheduleGroup"
    return wire.rest_json({"Name": name, "Arn": arn, "State": "ACTIVE"})


def fire(cloud, schedule, now=None, manual=False):
    target = schedule["target"]
    payload = target.get("Input") or "{}"
    group = (target.get("SqsParameters") or {}).get("MessageGroupId")
    timing.deliver(cloud, target["Arn"], payload, f"schedule:{schedule['name']}", group)
    schedule.setdefault("runs", []).append({"at": now or time.time(), "manual": manual})
    del schedule["runs"][:-20]


def tick(cloud):
    now = time.time()
    changed = False
    for _, _, service in list(cloud.store.each(NAME)):
        for key, schedule in list(service.get("schedules", {}).items()):
            if schedule["state"] != "ENABLED" or not schedule.get("next") or schedule["next"] > now:
                continue
            fire(cloud, schedule, now)
            schedule["next"] = timing.next_run(schedule["expression"], now, schedule["timezone"], schedule["created"])
            if schedule["next"] is None and schedule.get("after") == "DELETE":
                del service["schedules"][key]
            changed = True
    if changed:
        cloud.store.touch()


def resources(cloud):
    result = []
    for account, region, service in cloud.store.each(NAME):
        for schedule in service.get("schedules", {}).values():
            result.append({"service": NAME, "kind": "schedule", "name": schedule["name"], "arn": schedule["arn"], "account": account,
                           "region": region, "created": schedule["created"], "group": schedule["group"], "expression": schedule["expression"],
                           "timezone": schedule["timezone"], "state": schedule["state"], "target": schedule["target"].get("Arn"),
                           "input": schedule["target"].get("Input"), "next": schedule.get("next"), "runs": schedule.get("runs", [])[-10:]})
    return result
