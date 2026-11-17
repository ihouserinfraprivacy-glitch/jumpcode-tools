# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Amazon CloudWatch Logs (JSON 1.1): log groups and streams, written by the app or by Lambda functions."""

import time

from .. import wire
from ..wire import AwsError
from .common import json_service

NAME = "logs"
LABEL = "CloudWatch Logs"
MAX_EVENTS = 2000
MAX_STREAMS = 60


def handle(cloud, request):
    return json_service(cloud, request, "", "1.1", OPS)


def groups(cloud, account, region):
    return cloud.store.regional(account, region, NAME).setdefault("groups", {})


def group_of(cloud, caller, name, create=False):
    caller.target = name or ""
    found = groups(cloud, caller.account, caller.region).get(name)
    if found is None:
        if create:
            return _new_group(cloud, caller.account, caller.region, name)
        raise AwsError("ResourceNotFoundException", "The specified log group does not exist.")
    return found


def _new_group(cloud, account, region, name):
    group = {"name": name, "created": int(time.time() * 1000), "retention": None, "tags": {}, "streams": {},
             "arn": wire.arn("logs", region, account, f"log-group:{name}")}
    groups(cloud, account, region)[name] = group
    return group


def append(cloud, account, region, group_name, stream_name, lines):
    """Adds lines to a stream, creating the group and stream when needed (how Lambda writes its logs)."""
    now = int(time.time() * 1000)
    with cloud.store.lock:
        group = groups(cloud, account, region).get(group_name) or _new_group(cloud, account, region, group_name)
        stream = group["streams"].get(stream_name)
        if stream is None:
            stream = group["streams"][stream_name] = {"name": stream_name, "created": now, "events": []}
            if len(group["streams"]) > MAX_STREAMS:
                oldest = min(group["streams"].values(), key=lambda s: s["created"])
                del group["streams"][oldest["name"]]
        stream["events"].extend({"timestamp": now, "message": line, "ingestionTime": now} for line in lines)
        del stream["events"][:-MAX_EVENTS]
    cloud.store.touch()


def create_log_group(cloud, caller, params):
    name = params.get("logGroupName") or ""
    caller.target = name
    if name in groups(cloud, caller.account, caller.region):
        raise AwsError("ResourceAlreadyExistsException", "The specified log group already exists")
    _new_group(cloud, caller.account, caller.region, name)["tags"] = params.get("tags") or {}
    cloud.store.touch()
    return {}


def delete_log_group(cloud, caller, params):
    group = group_of(cloud, caller, params.get("logGroupName"))
    del groups(cloud, caller.account, caller.region)[group["name"]]
    cloud.store.touch()
    return {}


def describe_log_groups(cloud, caller, params):
    prefix = params.get("logGroupNamePrefix") or ""
    result = []
    for name, group in sorted(groups(cloud, caller.account, caller.region).items()):
        if name.startswith(prefix):
            stored = sum(len(e["message"]) for s in group["streams"].values() for e in s["events"])
            entry = {"logGroupName": name, "creationTime": group["created"], "metricFilterCount": 0, "arn": group["arn"] + ":*",
                     "logGroupArn": group["arn"], "storedBytes": stored, "logGroupClass": "STANDARD"}
            if group.get("retention"):
                entry["retentionInDays"] = group["retention"]
            result.append(entry)
    return {"logGroups": result[: int(params.get("limit") or 50)]}


def create_log_stream(cloud, caller, params):
    group = group_of(cloud, caller, params.get("logGroupName"))
    name = params.get("logStreamName") or ""
    if name in group["streams"]:
        raise AwsError("ResourceAlreadyExistsException", "The specified log stream already exists")
    group["streams"][name] = {"name": name, "created": int(time.time() * 1000), "events": []}
    cloud.store.touch()
    return {}


def delete_log_stream(cloud, caller, params):
    group = group_of(cloud, caller, params.get("logGroupName"))
    if group["streams"].pop(params.get("logStreamName"), None) is None:
        raise AwsError("ResourceNotFoundException", "The specified log stream does not exist.")
    cloud.store.touch()
    return {}


def describe_log_streams(cloud, caller, params):
    group = group_of(cloud, caller, params.get("logGroupName"))
    prefix = params.get("logStreamNamePrefix") or ""
    streams = [s for s in group["streams"].values() if s["name"].startswith(prefix)]
    if params.get("orderBy") == "LastEventTime":
        streams.sort(key=lambda s: s["events"][-1]["timestamp"] if s["events"] else 0, reverse=params.get("descending", False) is True)
    else:
        streams.sort(key=lambda s: s["name"], reverse=params.get("descending", False) is True)
    result = []
    for stream in streams[: int(params.get("limit") or 50)]:
        entry = {"logStreamName": stream["name"], "creationTime": stream["created"], "arn": f"{group['arn']}:log-stream:{stream['name']}", "storedBytes": 0}
        if stream["events"]:
            entry.update({"firstEventTimestamp": stream["events"][0]["timestamp"], "lastEventTimestamp": stream["events"][-1]["timestamp"],
                          "lastIngestionTime": stream["events"][-1]["ingestionTime"]})
        result.append(entry)
    return {"logStreams": result}


def put_log_events(cloud, caller, params):
    group = group_of(cloud, caller, params.get("logGroupName"))
    stream = group["streams"].get(params.get("logStreamName"))
    if stream is None:
        raise AwsError("ResourceNotFoundException", "The specified log stream does not exist.")
    now = int(time.time() * 1000)
    events = sorted(params.get("logEvents") or [], key=lambda e: e.get("timestamp", 0))
    with cloud.store.lock:
        stream["events"].extend({"timestamp": int(e.get("timestamp", now)), "message": str(e.get("message", "")), "ingestionTime": now} for e in events)
        del stream["events"][:-MAX_EVENTS]
    for event in events:
        cloud.log(group["name"], stream["name"], str(event.get("message", "")), account=caller.account, region=caller.region)
    cloud.store.touch()
    return {"nextSequenceToken": str(now)}


def _events(stream, params):
    start, end = params.get("startTime"), params.get("endTime")
    return [e for e in stream["events"] if (start is None or e["timestamp"] >= start) and (end is None or e["timestamp"] < end)]


def get_log_events(cloud, caller, params):
    group = group_of(cloud, caller, params.get("logGroupName"))
    stream = group["streams"].get(params.get("logStreamName"))
    if stream is None:
        raise AwsError("ResourceNotFoundException", "The specified log stream does not exist.")
    events = _events(stream, params)
    limit = int(params.get("limit") or 10000)
    events = events[:limit] if params.get("startFromHead") else events[-limit:]
    token = f"f/{len(stream['events']):056d}"
    return {"events": [{k: e[k] for k in ("timestamp", "message", "ingestionTime")} for e in events],
            "nextForwardToken": token, "nextBackwardToken": f"b/{0:056d}"}


def filter_log_events(cloud, caller, params):
    group = group_of(cloud, caller, params.get("logGroupName"))
    names = params.get("logStreamNames") or []
    pattern = (params.get("filterPattern") or "").strip().strip('"')
    terms = [term.strip('"') for term in pattern.split()] if pattern else []
    found = []
    for stream in group["streams"].values():
        if names and stream["name"] not in names:
            continue
        for event in _events(stream, params):
            if all(term in event["message"] for term in terms):
                found.append({"logStreamName": stream["name"], "timestamp": event["timestamp"], "message": event["message"],
                              "ingestionTime": event["ingestionTime"], "eventId": f"{event['timestamp']}{len(found)}"})
    found.sort(key=lambda e: e["timestamp"])
    return {"events": found[: int(params.get("limit") or 10000)], "searchedLogStreams": []}


def put_retention(cloud, caller, params):
    group_of(cloud, caller, params.get("logGroupName"))["retention"] = params.get("retentionInDays")
    cloud.store.touch()
    return {}


def delete_retention(cloud, caller, params):
    group_of(cloud, caller, params.get("logGroupName"))["retention"] = None
    cloud.store.touch()
    return {}


def tag_group(cloud, caller, params):
    group_of(cloud, caller, params.get("logGroupName"))["tags"].update(params.get("tags") or {})
    cloud.store.touch()
    return {}


def list_tags_group(cloud, caller, params):
    return {"tags": group_of(cloud, caller, params.get("logGroupName"))["tags"]}


def _group_by_arn(cloud, caller, arn):
    name = str(arn or "").split(":log-group:", 1)[-1].removesuffix(":*")
    return group_of(cloud, caller, name)


def tag_resource(cloud, caller, params):
    _group_by_arn(cloud, caller, params.get("resourceArn"))["tags"].update(params.get("tags") or {})
    cloud.store.touch()
    return {}


def list_tags_resource(cloud, caller, params):
    return {"tags": _group_by_arn(cloud, caller, params.get("resourceArn"))["tags"]}


OPS = {
    "CreateLogGroup": create_log_group, "DeleteLogGroup": delete_log_group, "DescribeLogGroups": describe_log_groups,
    "CreateLogStream": create_log_stream, "DeleteLogStream": delete_log_stream, "DescribeLogStreams": describe_log_streams,
    "PutLogEvents": put_log_events, "GetLogEvents": get_log_events, "FilterLogEvents": filter_log_events,
    "PutRetentionPolicy": put_retention, "DeleteRetentionPolicy": delete_retention, "TagLogGroup": tag_group,
    "ListTagsLogGroup": list_tags_group, "TagResource": tag_resource, "ListTagsForResource": list_tags_resource,
}


def resources(cloud):
    result = []
    for account, region, service in cloud.store.each(NAME):
        for group in service.get("groups", {}).values():
            events = sum(len(s["events"]) for s in group["streams"].values())
            result.append({"service": NAME, "kind": "log-group", "name": group["name"], "arn": group["arn"], "account": account,
                           "region": region, "created": group["created"] / 1000, "streams": len(group["streams"]), "count": events})
    return result
