# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Amazon SQS (JSON protocol, plus the older query protocol): standard and FIFO queues, visibility,
long polling, delays, batches and dead-letter queues."""

import hashlib
import json
import struct
import threading
import time
import uuid

from .. import wire
from ..wire import AwsError
from .common import json_service

NAME = "sqs"
LABEL = "SQS"
NAMESPACE = "com.amazonaws.sqs"
QUERY_NS = "http://queue.amazonaws.com/doc/2012-11-05/"
DEFAULTS = {"VisibilityTimeout": "30", "MaximumMessageSize": "262144", "MessageRetentionPeriod": "345600",
            "DelaySeconds": "0", "ReceiveMessageWaitTimeSeconds": "0"}
SYSTEM = ("SenderId", "SentTimestamp", "ApproximateReceiveCount", "ApproximateFirstReceiveTimestamp",
          "MessageGroupId", "MessageDeduplicationId", "SequenceNumber", "AWSTraceHeader", "DeadLetterQueueSourceArn")
_signals = {}


def signal(cloud):
    return _signals.setdefault(id(cloud), threading.Condition())


def nonexistent(name=""):
    return AwsError("QueueDoesNotExist", "The specified queue does not exist." if not name else f"The specified queue {name} does not exist.",
                    query_code="AWS.SimpleQueueService.NonExistentQueue")


def handle(cloud, request):
    if request.headers.get("x-amz-target", "").startswith("AmazonSQS."):
        return json_service(cloud, request, NAMESPACE, "1.0", OPS)
    return query(cloud, request)


def queues(cloud, account, region):
    return cloud.store.regional(account, region, NAME).setdefault("queues", {})


def queue_url(cloud, queue):
    return f"{cloud.endpoint}/{queue['account']}/{queue['name']}"


def find_queue(cloud, caller, params):
    url = params.get("QueueUrl") or ""
    if not url:
        raise AwsError("MissingParameter", "The request must contain the parameter QueueUrl.")
    parts = url.rstrip("/").split("/")
    name = parts[-1]
    account = parts[-2] if len(parts) >= 2 and parts[-2].isdigit() else caller.account
    caller.target = name
    queue = queues(cloud, account, caller.region).get(name)
    if queue is None:
        for _, _, service in cloud.store.each(NAME):
            queue = service.get("queues", {}).get(name)
            if queue is not None and queue["account"] == account:
                break
        else:
            queue = None
    if queue is None:
        raise nonexistent(name)
    return queue


def by_arn(cloud, arn):
    try:
        _, _, _, region, account, name = arn.split(":", 5)
    except ValueError:
        return None
    return queues(cloud, account, region).get(name)


# ---------------------------------------------------------------- queues

def create_queue(cloud, caller, params):
    name = params.get("QueueName") or ""
    caller.target = name
    if not name or len(name) > 80 or not all(ch.isalnum() or ch in "-_" for ch in name.removesuffix(".fifo")):
        raise AwsError("InvalidParameterValue", "Can only include alphanumeric characters, hyphens, or underscores. 1 to 80 in length")
    attributes = {k: str(v) for k, v in (params.get("Attributes") or {}).items()}
    fifo = name.endswith(".fifo")
    if attributes.get("FifoQueue", "false").lower() == "true" and not fifo:
        raise AwsError("InvalidParameterValue", "The name of a FIFO queue can only include alphanumeric characters, hyphens, or underscores, must end with .fifo suffix and be 1 to 80 in length.")
    existing = queues(cloud, caller.account, caller.region)
    if name in existing:
        current = existing[name]["attributes"]
        if any(current.get(k) != v for k, v in attributes.items() if k in DEFAULTS or k in ("FifoQueue", "ContentBasedDeduplication")):
            raise AwsError("QueueAlreadyExists", f"A queue already exists with the same name and a different value for attribute(s) {', '.join(attributes)}",
                           query_code="QueueAlreadyExists")
        return {"QueueUrl": queue_url(cloud, existing[name])}
    now = time.time()
    queue = {"name": name, "account": caller.account, "region": caller.region, "arn": wire.arn("sqs", caller.region, caller.account, name),
             "created": now, "modified": now, "attributes": {**DEFAULTS, **({"FifoQueue": "true"} if fifo else {}), **attributes},
             "tags": dict(params.get("tags") or params.get("Tags") or {}), "messages": [], "sequence": 0, "dedup": {}}
    _check_redrive(cloud, queue)
    existing[name] = queue
    cloud.store.touch()
    return {"QueueUrl": queue_url(cloud, queue)}


def _check_redrive(cloud, queue):
    policy = queue["attributes"].get("RedrivePolicy")
    if not policy:
        return
    try:
        value = json.loads(policy)
        int(value["maxReceiveCount"])
        value["deadLetterTargetArn"]
    except (ValueError, KeyError, TypeError) as error:
        raise AwsError("InvalidParameterValue", "Value for parameter RedrivePolicy is invalid. Reason: Redrive policy is not a valid JSON map.") from error


def get_queue_url(cloud, caller, params):
    name = params.get("QueueName") or ""
    caller.target = name
    account = params.get("QueueOwnerAWSAccountId") or caller.account
    queue = queues(cloud, account, caller.region).get(name)
    if queue is None:
        raise nonexistent(name)
    return {"QueueUrl": queue_url(cloud, queue)}


def list_queues(cloud, caller, params):
    prefix = params.get("QueueNamePrefix") or ""
    urls = [queue_url(cloud, q) for n, q in sorted(queues(cloud, caller.account, caller.region).items()) if n.startswith(prefix)]
    limit = int(params.get("MaxResults") or 1000)
    return {"QueueUrls": urls[:limit]} if urls else {}


def delete_queue(cloud, caller, params):
    queue = find_queue(cloud, caller, params)
    del queues(cloud, queue["account"], queue["region"])[queue["name"]]
    cloud.store.touch()
    return {}


def purge_queue(cloud, caller, params):
    queue = find_queue(cloud, caller, params)
    with cloud.store.lock:
        queue["messages"] = []
    cloud.store.touch()
    return {}


def counts(queue, now=None):
    now = now or time.time()
    visible = delayed = flight = 0
    for message in queue["messages"]:
        if message.get("delay_until", 0) > now:
            delayed += 1
        elif message.get("visible_at", 0) > now:
            flight += 1
        else:
            visible += 1
    return visible, flight, delayed


def get_attributes(cloud, caller, params):
    queue = find_queue(cloud, caller, params)
    names = params.get("AttributeNames") or ["All"]
    visible, flight, delayed = counts(queue)
    values = {**queue["attributes"], "QueueArn": queue["arn"], "ApproximateNumberOfMessages": str(visible),
              "ApproximateNumberOfMessagesNotVisible": str(flight), "ApproximateNumberOfMessagesDelayed": str(delayed),
              "CreatedTimestamp": str(int(queue["created"])), "LastModifiedTimestamp": str(int(queue["modified"])),
              "SqsManagedSseEnabled": queue["attributes"].get("SqsManagedSseEnabled", "true")}
    if "All" not in names:
        values = {k: v for k, v in values.items() if k in names}
    return {"Attributes": values}


def set_attributes(cloud, caller, params):
    queue = find_queue(cloud, caller, params)
    queue["attributes"].update({k: str(v) for k, v in (params.get("Attributes") or {}).items()})
    queue["modified"] = time.time()
    _check_redrive(cloud, queue)
    cloud.store.touch()
    return {}


def tag_queue(cloud, caller, params):
    queue = find_queue(cloud, caller, params)
    queue["tags"].update(params.get("Tags") or {})
    cloud.store.touch()
    return {}


def untag_queue(cloud, caller, params):
    queue = find_queue(cloud, caller, params)
    for key in params.get("TagKeys") or []:
        queue["tags"].pop(key, None)
    cloud.store.touch()
    return {}


def list_tags(cloud, caller, params):
    return {"Tags": find_queue(cloud, caller, params)["tags"]}


def list_dead_letter_sources(cloud, caller, params):
    queue = find_queue(cloud, caller, params)
    urls = []
    for _, _, service in cloud.store.each(NAME):
        for other in service.get("queues", {}).values():
            policy = other["attributes"].get("RedrivePolicy")
            if policy and json.loads(policy).get("deadLetterTargetArn") == queue["arn"]:
                urls.append(queue_url(cloud, other))
    return {"queueUrls": urls}


# ---------------------------------------------------------------- messages

def attributes_md5(attributes):
    """MD5OfMessageAttributes as SQS computes it (SDKs check it)."""
    if not attributes:
        return None
    data = b""
    for name in sorted(attributes):
        value = attributes[name]
        kind = value.get("DataType", "String")
        data += struct.pack(">I", len(name.encode())) + name.encode()
        data += struct.pack(">I", len(kind.encode())) + kind.encode()
        if kind.startswith("Binary"):
            raw = value.get("BinaryValue", b"")
            raw = __import__("base64").b64decode(raw) if isinstance(raw, str) else raw
            data += b"\x02" + struct.pack(">I", len(raw)) + raw
        else:
            text = str(value.get("StringValue", "")).encode()
            data += b"\x01" + struct.pack(">I", len(text)) + text
    return hashlib.md5(data, usedforsecurity=False).hexdigest()


def enqueue(cloud, queue, body, attributes=None, delay=None, group=None, dedup=None, sender="000000000000", system=None):
    if not isinstance(body, str) or body == "":
        raise AwsError("MissingParameter", "The request must contain the parameter MessageBody.", query_code="MissingParameter")
    if len(body.encode("utf-8")) > int(queue["attributes"].get("MaximumMessageSize", "262144")):
        raise AwsError("InvalidParameterValue", "One or more parameters are invalid. Reason: Message must be shorter than 262144 bytes.")
    now = time.time()
    fifo = queue["attributes"].get("FifoQueue") == "true"
    if fifo:
        if not group:
            raise AwsError("MissingParameter", "The request must contain the parameter MessageGroupId.")
        if not dedup:
            if queue["attributes"].get("ContentBasedDeduplication") == "true":
                dedup = hashlib.sha256(body.encode()).hexdigest()
            else:
                raise AwsError("InvalidParameterValue", "The queue should either have ContentBasedDeduplication enabled or MessageDeduplicationId provided explicitly")
        queue["dedup"] = {k: v for k, v in queue.get("dedup", {}).items() if v[1] > now - 300}
        if dedup in queue["dedup"]:
            return queue["dedup"][dedup][0], None
    delay = int(queue["attributes"].get("DelaySeconds", "0") if delay is None else delay)
    queue["sequence"] = queue.get("sequence", 0) + 1
    message = {"id": str(uuid.uuid4()), "body": body, "md5": wire.md5_hex(body.encode("utf-8")), "attributes": attributes or {},
               "sent": now, "delay_until": now + delay if delay and not fifo else 0, "visible_at": 0, "receives": 0,
               "first_receive": None, "receipt": None, "group": group, "dedup": dedup,
               "sequence": f"{queue['sequence']:020d}" if fifo else None, "sender": sender, "system": system or {}}
    with cloud.store.lock:
        queue["messages"].append(message)
        if fifo:
            queue["dedup"][dedup] = (message["id"], now)
    cloud.store.touch()
    with signal(cloud):
        signal(cloud).notify_all()
    return message["id"], message


def _message_attributes(params):
    values = params.get("MessageAttributes") or {}
    for name, value in values.items():
        if not value.get("DataType"):
            raise AwsError("InvalidParameterValue", f"The message attribute '{name}' must contain non-empty message attribute type.")
    return values


def send_message(cloud, caller, params):
    queue = find_queue(cloud, caller, params)
    attributes = _message_attributes(params)
    message_id, message = enqueue(cloud, queue, params.get("MessageBody"), attributes, params.get("DelaySeconds"),
                                  params.get("MessageGroupId"), params.get("MessageDeduplicationId"), caller.account,
                                  {k: v.get("StringValue") for k, v in (params.get("MessageSystemAttributes") or {}).items()})
    result = {"MessageId": message_id, "MD5OfMessageBody": wire.md5_hex(params["MessageBody"].encode("utf-8"))}
    if attributes:
        result["MD5OfMessageAttributes"] = attributes_md5(attributes)
    if message and message.get("sequence"):
        result["SequenceNumber"] = message["sequence"]
    return result


def send_batch(cloud, caller, params):
    queue = find_queue(cloud, caller, params)
    entries = params.get("Entries") or []
    if not entries:
        raise AwsError("EmptyBatchRequest", "There should be at least one SendMessageBatchRequestEntry in the request.",
                       query_code="AWS.SimpleQueueService.EmptyBatchRequest")
    if len(entries) > 10:
        raise AwsError("TooManyEntriesInBatchRequest", "Maximum number of entries per request are 10.",
                       query_code="AWS.SimpleQueueService.TooManyEntriesInBatchRequest")
    if len({e.get("Id") for e in entries}) != len(entries):
        raise AwsError("BatchEntryIdsNotDistinct", "Two or more batch entries in the request have the same Id.",
                       query_code="AWS.SimpleQueueService.BatchEntryIdsNotDistinct")
    successful, failed = [], []
    for entry in entries:
        try:
            attributes = _message_attributes(entry)
            message_id, message = enqueue(cloud, queue, entry.get("MessageBody"), attributes, entry.get("DelaySeconds"),
                                          entry.get("MessageGroupId"), entry.get("MessageDeduplicationId"), caller.account)
            item = {"Id": entry["Id"], "MessageId": message_id, "MD5OfMessageBody": wire.md5_hex(entry["MessageBody"].encode("utf-8"))}
            if attributes:
                item["MD5OfMessageAttributes"] = attributes_md5(attributes)
            if message and message.get("sequence"):
                item["SequenceNumber"] = message["sequence"]
            successful.append(item)
        except AwsError as error:
            failed.append({"Id": entry.get("Id"), "SenderFault": True, "Code": error.code, "Message": error.message})
    return {"Successful": successful, "Failed": failed}


def take(cloud, queue, count, visibility=None, now=None):
    """Takes up to `count` visible messages, moving over-received ones to the dead-letter queue."""
    now = now or time.time()
    visibility = int(queue["attributes"].get("VisibilityTimeout", "30") if visibility is None else visibility)
    policy = queue["attributes"].get("RedrivePolicy")
    limit = dlq = None
    if policy:
        try:
            value = json.loads(policy)
            limit, dlq = int(value["maxReceiveCount"]), by_arn(cloud, value["deadLetterTargetArn"])
        except (ValueError, KeyError, TypeError):
            limit = None
    fifo = queue["attributes"].get("FifoQueue") == "true"
    busy_groups = {m["group"] for m in queue["messages"] if fifo and m.get("visible_at", 0) > now}
    chosen = []
    moved = False
    with cloud.store.lock:
        for message in list(queue["messages"]):
            if len(chosen) >= count:
                break
            if message.get("delay_until", 0) > now or message.get("visible_at", 0) > now:
                continue
            if fifo and message["group"] in busy_groups:
                continue
            if limit is not None and message["receives"] >= limit and dlq is not None:
                queue["messages"].remove(message)
                message.update({"visible_at": 0, "receipt": None, "system": {**message.get("system", {}), "DeadLetterQueueSourceArn": queue["arn"]}})
                dlq["messages"].append(message)
                moved = True
                continue
            message["receives"] += 1
            message["first_receive"] = message["first_receive"] or now
            message["visible_at"] = now + visibility
            message["receipt"] = f"{uuid.uuid4().hex}{uuid.uuid4().hex}"
            # A FIFO group stays blocked only by messages taken in earlier receives; one receive may take several in order.
            chosen.append(message)
    if chosen or moved:
        cloud.store.touch()
    return chosen


def view(message, names, attribute_names):
    result = {"MessageId": message["id"], "ReceiptHandle": message["receipt"], "MD5OfBody": message["md5"], "Body": message["body"]}
    system = {"SenderId": message.get("sender", "000000000000"), "SentTimestamp": str(int(message["sent"] * 1000)),
              "ApproximateReceiveCount": str(message["receives"]),
              "ApproximateFirstReceiveTimestamp": str(int((message["first_receive"] or message["sent"]) * 1000))}
    if message.get("group"):
        system.update({"MessageGroupId": message["group"], "MessageDeduplicationId": message.get("dedup") or "", "SequenceNumber": message.get("sequence") or ""})
    system.update({k: v for k, v in (message.get("system") or {}).items() if v})
    wanted = set(names or [])
    if wanted:
        result["Attributes"] = system if "All" in wanted else {k: v for k, v in system.items() if k in wanted}
    if attribute_names and message.get("attributes"):
        chosen = message["attributes"] if ("All" in attribute_names or ".*" in attribute_names) else {
            k: v for k, v in message["attributes"].items() if k in attribute_names or any(n.endswith(".*") and k.startswith(n[:-2]) for n in attribute_names)}
        if chosen:
            result["MessageAttributes"] = chosen
            result["MD5OfMessageAttributes"] = attributes_md5(chosen)
    return result


def receive_message(cloud, caller, params):
    queue = find_queue(cloud, caller, params)
    count = int(params.get("MaxNumberOfMessages") or 1)
    if not 1 <= count <= 10:
        raise AwsError("InvalidParameterValue", f"Value {count} for parameter MaxNumberOfMessages is invalid. Reason: Must be between 1 and 10, if provided.")
    wait = params.get("WaitTimeSeconds")
    wait = int(queue["attributes"].get("ReceiveMessageWaitTimeSeconds", "0") if wait is None else wait)
    deadline = time.time() + min(wait, 20)
    while True:
        messages = take(cloud, queue, count, params.get("VisibilityTimeout"))
        if messages or time.time() >= deadline or cloud.stopping.is_set():
            break
        with signal(cloud):
            signal(cloud).wait(min(0.5, max(0.05, deadline - time.time())))
    names = (params.get("AttributeNames") or []) + (params.get("MessageSystemAttributeNames") or [])
    result = [view(message, names, params.get("MessageAttributeNames") or []) for message in messages]
    caller.note_res = {"messages": len(result)}
    return {"Messages": result} if result else {}


def _by_receipt(queue, receipt):
    if not receipt or len(receipt) < 8:
        raise AwsError("ReceiptHandleIsInvalid", f'The input receipt handle "{receipt}" is not a valid receipt handle.',
                       query_code="ReceiptHandleIsInvalid")
    return next((m for m in queue["messages"] if m.get("receipt") == receipt), None)


def delete_message(cloud, caller, params):
    queue = find_queue(cloud, caller, params)
    with cloud.store.lock:
        message = _by_receipt(queue, params.get("ReceiptHandle"))
        if message is not None:
            queue["messages"].remove(message)
    if message is not None:
        cloud.store.touch()
    return {}


def delete_batch(cloud, caller, params):
    queue = find_queue(cloud, caller, params)
    successful, failed = [], []
    for entry in params.get("Entries") or []:
        try:
            with cloud.store.lock:
                message = _by_receipt(queue, entry.get("ReceiptHandle"))
                if message is not None:
                    queue["messages"].remove(message)
            successful.append({"Id": entry["Id"]})
        except AwsError as error:
            failed.append({"Id": entry.get("Id"), "SenderFault": True, "Code": error.code, "Message": error.message})
    cloud.store.touch()
    return {"Successful": successful, "Failed": failed}


def change_visibility(cloud, caller, params):
    queue = find_queue(cloud, caller, params)
    with cloud.store.lock:
        message = _by_receipt(queue, params.get("ReceiptHandle"))
        if message is None:
            raise AwsError("MessageNotInflight", "Message does not exist or is not available for visibility timeout change.",
                           query_code="AWS.SimpleQueueService.MessageNotInflight")
        message["visible_at"] = time.time() + int(params.get("VisibilityTimeout") or 0)
    cloud.store.touch()
    with signal(cloud):
        signal(cloud).notify_all()
    return {}


def change_visibility_batch(cloud, caller, params):
    successful, failed = [], []
    for entry in params.get("Entries") or []:
        try:
            change_visibility(cloud, caller, {"QueueUrl": params.get("QueueUrl"), **entry})
            successful.append({"Id": entry["Id"]})
        except AwsError as error:
            failed.append({"Id": entry.get("Id"), "SenderFault": True, "Code": error.code, "Message": error.message})
    return {"Successful": successful, "Failed": failed}


OPS = {
    "CreateQueue": create_queue, "GetQueueUrl": get_queue_url, "ListQueues": list_queues, "DeleteQueue": delete_queue,
    "PurgeQueue": purge_queue, "GetQueueAttributes": get_attributes, "SetQueueAttributes": set_attributes,
    "TagQueue": tag_queue, "UntagQueue": untag_queue, "ListQueueTags": list_tags, "ListDeadLetterSourceQueues": list_dead_letter_sources,
    "SendMessage": send_message, "SendMessageBatch": send_batch, "ReceiveMessage": receive_message,
    "DeleteMessage": delete_message, "DeleteMessageBatch": delete_batch,
    "ChangeMessageVisibility": change_visibility, "ChangeMessageVisibilityBatch": change_visibility_batch,
}


# ---------------------------------------------------------------- the older query protocol

def query(cloud, request):
    form = request.form()
    action = form.get("Action", "")
    request.op = action
    rid = request.id
    try:
        if action not in OPS:
            raise AwsError("InvalidAction", f"The action {action} is not valid for this endpoint.")
        params = _query_params(form)
        if "QueueUrl" not in params and request.path.count("/") >= 2 and action not in ("CreateQueue", "ListQueues", "GetQueueUrl"):
            params["QueueUrl"] = f"{cloud.endpoint}{request.path}"
        request.note_req = params
        result = OPS[action](cloud, request, params)
        request.note_res = result
        return wire.query_response(action, _query_result(result), QUERY_NS, rid)
    except AwsError as error:
        if error.query_code:
            error = AwsError(error.query_code, error.message, error.status, error.sender)
        return wire.query_error(error, QUERY_NS, rid)


def _query_params(form):
    params = {}
    attributes, message_attributes, names, attribute_names, entries = {}, {}, [], [], {}
    for key, value in form.items():
        parts = key.split(".")
        if parts[0] == "Attribute" and len(parts) == 3:
            attributes.setdefault(parts[1], {})[parts[2]] = value
        elif parts[0] == "MessageAttribute" and len(parts) >= 3:
            entry = message_attributes.setdefault(parts[1], {})
            if parts[2] == "Name":
                entry["Name"] = value
            elif parts[2] == "Value" and len(parts) == 4:
                entry.setdefault("Value", {})[parts[3]] = value
        elif parts[0] == "AttributeName":
            names.append(value)
        elif parts[0] == "MessageAttributeName":
            attribute_names.append(value)
        elif len(parts) >= 3 and parts[0].endswith("Entry"):
            entries.setdefault(parts[1], {})[parts[2]] = value
        elif parts[0] == "Tag" and len(parts) == 3:
            attributes.setdefault("tag" + parts[1], {})[parts[2]] = value
        elif len(parts) == 1:
            params[key] = value
    if attributes:
        params["Attributes"] = {v["Name"]: v.get("Value", "") for k, v in attributes.items() if "Name" in v and not k.startswith("tag")}
    if message_attributes:
        params["MessageAttributes"] = {v["Name"]: v.get("Value", {}) for v in message_attributes.values() if "Name" in v}
    if names:
        params["AttributeNames"] = names
    if attribute_names:
        params["MessageAttributeNames"] = attribute_names
    if entries:
        params["Entries"] = [entries[k] for k in sorted(entries, key=int)]
    for key in ("MaxNumberOfMessages", "WaitTimeSeconds", "VisibilityTimeout", "DelaySeconds"):
        if key in params:
            params[key] = int(params[key])
    return params


def _query_result(result):
    out = {}
    for key, value in result.items():
        if key == "Messages":
            out["Message"] = [_query_message(m) for m in value]
        elif key == "QueueUrls":
            out["QueueUrl"] = value
        elif key == "Attributes":
            out["Attribute"] = [{"Name": k, "Value": v} for k, v in value.items()]
        elif key == "Successful":
            out["Successful"] = value
        else:
            out[key] = value
    return out


def _query_message(message):
    out = {k: v for k, v in message.items() if k not in ("Attributes", "MessageAttributes")}
    if message.get("Attributes"):
        out["Attribute"] = [{"Name": k, "Value": v} for k, v in message["Attributes"].items()]
    if message.get("MessageAttributes"):
        out["MessageAttribute"] = [{"Name": k, "Value": v} for k, v in message["MessageAttributes"].items()]
    return out


# ---------------------------------------------------------------- deliveries from other services

def deliver_arn(cloud, arn, message, source, attributes=None, group=None):
    """Puts a message from another service (topic, bucket, rule, schedule) into a queue named by its ARN."""
    queue = by_arn(cloud, arn)
    name = arn.rsplit(":", 1)[-1]
    if queue is None:
        cloud.internal_call(NAME, "SendMessage", name, source, error=("QueueDoesNotExist", f"The queue {arn} does not exist"))
        return False
    body = message if isinstance(message, str) else json.dumps(message, ensure_ascii=False)
    try:
        fifo = queue["attributes"].get("FifoQueue") == "true"
        enqueue(cloud, queue, body, attributes, None, group or ("cloudstudio" if fifo else None),
                hashlib.sha256(body.encode()).hexdigest() if fifo else None)
    except AwsError as error:
        cloud.internal_call(NAME, "SendMessage", name, source, error=(error.code, error.message), account=queue["account"], region=queue["region"])
        return False
    cloud.internal_call(NAME, "SendMessage", name, source, req=body[:600], account=queue["account"], region=queue["region"])
    return True


def resources(cloud):
    result = []
    now = time.time()
    for account, region, service in cloud.store.each(NAME):
        for queue in service.get("queues", {}).values():
            visible, flight, delayed = counts(queue, now)
            policy = queue["attributes"].get("RedrivePolicy")
            dlq = None
            if policy:
                try:
                    value = json.loads(policy)
                    dlq = {"arn": value.get("deadLetterTargetArn"), "max": int(value.get("maxReceiveCount", 0))}
                except (ValueError, TypeError):
                    dlq = None
            result.append({
                "service": NAME, "kind": "queue", "name": queue["name"], "arn": queue["arn"], "account": account, "region": region,
                "created": queue["created"], "url": queue_url(cloud, queue), "fifo": queue["attributes"].get("FifoQueue") == "true",
                "visible": visible, "inflight": flight, "delayed": delayed, "count": len(queue["messages"]),
                "visibility": int(queue["attributes"].get("VisibilityTimeout", "30")), "dlq": dlq,
                "messages": [{"id": m["id"], "body": m["body"][:2000], "sent": m["sent"], "receives": m["receives"],
                              "state": "delayed" if m.get("delay_until", 0) > now else "inflight" if m.get("visible_at", 0) > now else "visible",
                              "attributes": {k: v.get("StringValue", "") for k, v in (m.get("attributes") or {}).items()},
                              "from": (m.get("system") or {}).get("DeadLetterQueueSourceArn")}
                             for m in queue["messages"][:100]],
            })
    return result
