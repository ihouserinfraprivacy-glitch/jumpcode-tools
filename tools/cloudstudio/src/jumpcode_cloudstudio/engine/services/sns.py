# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Amazon SNS (query protocol): topics, subscriptions with filter policies, and delivery to queues,
functions and local HTTP endpoints. E-mail and SMS deliveries are only recorded, never sent."""

import json
import threading
import time
import urllib.request
import uuid

from .. import wire
from ..wire import AwsError
from . import patterns

NAME = "sns"
LABEL = "SNS"
NS = "http://sns.amazonaws.com/doc/2010-03-31/"


def handle(cloud, request):
    form = request.form()
    action = form.get("Action", "")
    request.op = action
    try:
        if action not in OPS:
            raise AwsError("InvalidAction", f"CloudStudio does not emulate SNS {action or 'this operation'} yet.")
        params = wire.flatten_query({k: v for k, v in form.items() if k not in ("Action", "Version")})
        request.note_req = params
        result = OPS[action](cloud, request, params)
        request.note_res = result
        return wire.query_response(action, _xml(result), NS, request.id)
    except AwsError as error:
        return wire.query_error(error, NS, request.id)


def _xml(value):
    """Query-protocol XML shapes: lists become <member>, string maps become <entry><key/><value/>."""
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            if key in ("Attributes", "Tags") and isinstance(item, dict):
                out[key] = {"entry": [{"key": k, "value": v} for k, v in item.items()]}
            else:
                out[key] = _xml(item)
        return out
    if isinstance(value, list):
        return {"member": [_xml(v) for v in value]}
    return value


def topics(cloud, account, region):
    return cloud.store.regional(account, region, NAME).setdefault("topics", {})


def topic_of(cloud, caller, arn):
    if not arn:
        raise AwsError("InvalidParameter", "Invalid parameter: TopicArn")
    try:
        _, _, _, region, account, name = arn.split(":", 5)
    except ValueError as error:
        raise AwsError("InvalidParameter", "Invalid parameter: TopicArn") from error
    caller.target = name
    topic = topics(cloud, account, region).get(name)
    if topic is None:
        raise AwsError("NotFound", "Topic does not exist", 404)
    return topic


def create_topic(cloud, caller, params):
    name = params.get("Name") or ""
    caller.target = name
    if not name or len(name) > 256 or not all(ch.isalnum() or ch in "-_" for ch in name.removesuffix(".fifo")):
        raise AwsError("InvalidParameter", "Invalid parameter: Topic Name")
    existing = topics(cloud, caller.account, caller.region)
    if name not in existing:
        attributes = {k: str(v) for k, v in (params.get("Attributes") or {}).items()}
        if name.endswith(".fifo"):
            attributes.setdefault("FifoTopic", "true")
        existing[name] = {"name": name, "arn": wire.arn("sns", caller.region, caller.account, name), "account": caller.account,
                          "region": caller.region, "created": time.time(), "attributes": attributes,
                          "tags": {t["Key"]: t["Value"] for t in params.get("Tags") or [] if isinstance(t, dict)},
                          "subscriptions": {}, "published": 0}
        cloud.store.touch()
    return {"TopicArn": existing[name]["arn"]}


def delete_topic(cloud, caller, params):
    try:
        topic = topic_of(cloud, caller, params.get("TopicArn"))
    except AwsError:
        return None
    del topics(cloud, topic["account"], topic["region"])[topic["name"]]
    cloud.store.touch()
    return None


def list_topics(cloud, caller, params):
    return {"Topics": [{"TopicArn": t["arn"]} for _, t in sorted(topics(cloud, caller.account, caller.region).items())]}


def get_topic_attributes(cloud, caller, params):
    topic = topic_of(cloud, caller, params.get("TopicArn"))
    subs = list(topic["subscriptions"].values())
    attributes = {"TopicArn": topic["arn"], "Owner": topic["account"], "DisplayName": "", "EffectiveDeliveryPolicy": "{}",
                  "SubscriptionsConfirmed": str(sum(1 for s in subs if s["confirmed"])),
                  "SubscriptionsPending": str(sum(1 for s in subs if not s["confirmed"])), "SubscriptionsDeleted": "0",
                  "Policy": json.dumps({"Version": "2008-10-17", "Statement": []}), **topic["attributes"]}
    return {"Attributes": attributes}


def set_topic_attributes(cloud, caller, params):
    topic = topic_of(cloud, caller, params.get("TopicArn"))
    topic["attributes"][params.get("AttributeName", "")] = params.get("AttributeValue", "")
    cloud.store.touch()
    return None


def subscribe(cloud, caller, params):
    topic = topic_of(cloud, caller, params.get("TopicArn"))
    protocol = (params.get("Protocol") or "").lower()
    endpoint = params.get("Endpoint") or ""
    if protocol in ("http", "https"):
        from ..local_http import require_local_url
        require_local_url(endpoint)
    if protocol not in ("sqs", "lambda", "http", "https", "email", "email-json", "sms", "application", "firehose"):
        raise AwsError("InvalidParameter", f"Invalid parameter: Amazon SNS does not support this protocol string: {protocol}")
    for existing in topic["subscriptions"].values():
        if existing["protocol"] == protocol and existing["endpoint"] == endpoint:
            return {"SubscriptionArn": existing["arn"]}
    arn = f"{topic['arn']}:{uuid.uuid4()}"
    topic["subscriptions"][arn] = {"arn": arn, "protocol": protocol, "endpoint": endpoint, "owner": caller.account,
                                   "attributes": {k: str(v) for k, v in (params.get("Attributes") or {}).items()},
                                   "confirmed": protocol in ("sqs", "lambda", "firehose", "application", "http", "https"),
                                   "created": time.time()}
    cloud.store.touch()
    confirmed = topic["subscriptions"][arn]["confirmed"]
    return {"SubscriptionArn": arn if confirmed or params.get("ReturnSubscriptionArn") in (True, "true") else "pending confirmation"}


def _subscription(cloud, caller, arn):
    for _, _, service in cloud.store.each(NAME):
        for topic in service.get("topics", {}).values():
            if arn in topic["subscriptions"]:
                caller.target = topic["name"]
                return topic, topic["subscriptions"][arn]
    raise AwsError("NotFound", "Subscription does not exist", 404)


def unsubscribe(cloud, caller, params):
    topic, sub = _subscription(cloud, caller, params.get("SubscriptionArn"))
    del topic["subscriptions"][sub["arn"]]
    cloud.store.touch()
    return None


def confirm_subscription(cloud, caller, params):
    topic = topic_of(cloud, caller, params.get("TopicArn"))
    pending = next((s for s in topic["subscriptions"].values() if not s["confirmed"]), None)
    if pending:
        if pending["protocol"] in ("http", "https"):
            from ..local_http import require_local_url
            require_local_url(pending["endpoint"])
        pending["confirmed"] = True
        cloud.store.touch()
        return {"SubscriptionArn": pending["arn"]}
    raise AwsError("InvalidParameter", "Invalid token")


def _sub_view(topic, sub):
    return {"SubscriptionArn": sub["arn"] if sub["confirmed"] else "PendingConfirmation", "Owner": sub["owner"],
            "Protocol": sub["protocol"], "Endpoint": sub["endpoint"], "TopicArn": topic["arn"]}


def list_subscriptions(cloud, caller, params):
    result = []
    for topic in topics(cloud, caller.account, caller.region).values():
        result += [_sub_view(topic, s) for s in topic["subscriptions"].values()]
    return {"Subscriptions": result}


def list_subscriptions_by_topic(cloud, caller, params):
    topic = topic_of(cloud, caller, params.get("TopicArn"))
    return {"Subscriptions": [_sub_view(topic, s) for s in topic["subscriptions"].values()]}


def get_subscription_attributes(cloud, caller, params):
    topic, sub = _subscription(cloud, caller, params.get("SubscriptionArn"))
    return {"Attributes": {"SubscriptionArn": sub["arn"], "TopicArn": topic["arn"], "Protocol": sub["protocol"], "Endpoint": sub["endpoint"],
                           "Owner": sub["owner"], "ConfirmationWasAuthenticated": "true", "PendingConfirmation": str(not sub["confirmed"]).lower(),
                           "RawMessageDelivery": "false", **sub["attributes"]}}


def set_subscription_attributes(cloud, caller, params):
    _, sub = _subscription(cloud, caller, params.get("SubscriptionArn"))
    sub["attributes"][params.get("AttributeName", "")] = params.get("AttributeValue", "")
    cloud.store.touch()
    return None


def tag_resource(cloud, caller, params):
    topic = topic_of(cloud, caller, params.get("ResourceArn"))
    topic["tags"].update({t["Key"]: t["Value"] for t in params.get("Tags") or [] if isinstance(t, dict)})
    cloud.store.touch()
    return None


def list_tags(cloud, caller, params):
    topic = topic_of(cloud, caller, params.get("ResourceArn"))
    return {"Tags": [{"Key": k, "Value": v} for k, v in topic["tags"].items()]}


def publish(cloud, caller, params):
    arn = params.get("TopicArn") or params.get("TargetArn")
    if params.get("PhoneNumber"):
        cloud.log("/cloudstudio/sns", "sms", f"SMS para {params['PhoneNumber']} (não enviado): {str(params.get('Message', ''))[:300]}")
        return {"MessageId": str(uuid.uuid4())}
    topic = topic_of(cloud, caller, arn)
    if params.get("Message") in (None, ""):
        raise AwsError("InvalidParameter", "Invalid parameter: Empty message")
    if topic["attributes"].get("FifoTopic") == "true" and not params.get("MessageGroupId"):
        raise AwsError("InvalidParameter", "Invalid parameter: The MessageGroupId parameter is required for FIFO topics")
    message_id = fan_out(cloud, topic, params.get("Message"), params.get("Subject"), _attributes(params.get("MessageAttributes")),
                         params.get("MessageStructure"), params.get("MessageGroupId"), caller.source)
    result = {"MessageId": message_id}
    if topic["attributes"].get("FifoTopic") == "true":
        result["SequenceNumber"] = f"{topic['published']:020d}"
    return result


def publish_batch(cloud, caller, params):
    topic = topic_of(cloud, caller, params.get("TopicArn"))
    entries = params.get("PublishBatchRequestEntries") or []
    if len(entries) > 10:
        raise AwsError("TooManyEntriesInBatchRequest", "The batch request contains more entries than permissible.")
    successful = []
    for entry in entries:
        message_id = fan_out(cloud, topic, entry.get("Message"), entry.get("Subject"), _attributes(entry.get("MessageAttributes")),
                             entry.get("MessageStructure"), entry.get("MessageGroupId"), caller.source)
        successful.append({"Id": entry.get("Id"), "MessageId": message_id})
    return {"Successful": successful, "Failed": []}


def _attributes(raw):
    """MessageAttributes from the query protocol ({name: {DataType, StringValue}})."""
    result = {}
    for name, value in (raw or {}).items():
        if isinstance(value, dict):
            result[name] = {"DataType": value.get("DataType", "String"), "StringValue": value.get("StringValue", value.get("BinaryValue", ""))}
    return result


def fan_out(cloud, topic, message, subject, attributes, structure, group, source):
    """Delivers one published message to every confirmed subscription whose filter accepts it."""
    message_id = str(uuid.uuid4())
    topic["published"] = topic.get("published", 0) + 1
    by_protocol = None
    if structure == "json":
        try:
            by_protocol = json.loads(message)
            if "default" not in by_protocol:
                raise AwsError("InvalidParameter", "Invalid parameter: Message Structure - No default entry in JSON message body")
        except ValueError as error:
            raise AwsError("InvalidParameter", "Invalid parameter: Message Structure - JSON message body failed to parse") from error
    for sub in list(topic["subscriptions"].values()):
        if not sub["confirmed"]:
            continue
        text = by_protocol.get(sub["protocol"], by_protocol["default"]) if by_protocol else message
        policy = sub["attributes"].get("FilterPolicy")
        if policy:
            try:
                rules = json.loads(policy)
                body = None
                if sub["attributes"].get("FilterPolicyScope") == "MessageBody":
                    body = json.loads(text)
                if not patterns.filter_policy(rules, attributes, body):
                    continue
            except ValueError:
                continue
        envelope = {"Type": "Notification", "MessageId": message_id, "TopicArn": topic["arn"], **({"Subject": subject} if subject else {}),
                    "Message": text, "Timestamp": wire.iso(), "SignatureVersion": "1", "Signature": "CLOUDSTUDIO",
                    "SigningCertURL": f"{cloud.endpoint}/_cloudstudio/sns.pem",
                    "UnsubscribeURL": f"{cloud.endpoint}/?Action=Unsubscribe&SubscriptionArn={sub['arn']}"}
        if attributes:
            envelope["MessageAttributes"] = {k: {"Type": v["DataType"], "Value": v["StringValue"]} for k, v in attributes.items()}
        origin = f"sns:{topic['name']}"
        raw = sub["attributes"].get("RawMessageDelivery") == "true"
        if sub["protocol"] == "sqs":
            from . import sqs
            sqs.deliver_arn(cloud, sub["endpoint"], text if raw else envelope, origin, attributes if raw else None, group)
        elif sub["protocol"] == "lambda":
            event = {"Records": [{"EventSource": "aws:sns", "EventVersion": "1.0", "EventSubscriptionArn": sub["arn"],
                                  "Sns": {**envelope, "SigningCertUrl": envelope["SigningCertURL"], "UnsubscribeUrl": envelope["UnsubscribeURL"]}}]}
            cloud.runtime.invoke_arn_async(sub["endpoint"], event, origin)
        elif sub["protocol"] in ("http", "https"):
            threading.Thread(target=_post, args=(cloud, sub, envelope, origin), daemon=True).start()
        else:
            cloud.log("/cloudstudio/sns", topic["name"], f"{sub['protocol']} para {sub['endpoint']} (não enviado): {str(text)[:300]}")
            cloud.internal_call(NAME, "Deliver", topic["name"], origin, req={"to": sub["endpoint"], "protocol": sub["protocol"]})
    cloud.store.touch()
    return message_id


def _post(cloud, sub, envelope, origin):
    from ..local_http import open_local
    started = time.perf_counter()
    try:
        request = urllib.request.Request(sub["endpoint"], json.dumps(envelope).encode(), method="POST",
                                         headers={"Content-Type": "text/plain; charset=UTF-8", "x-amz-sns-message-type": "Notification",
                                                  "x-amz-sns-message-id": envelope["MessageId"], "x-amz-sns-topic-arn": envelope["TopicArn"],
                                                  "x-amz-sns-subscription-arn": sub["arn"]})
        with open_local(request, timeout=10) as response:
            status = response.status
        cloud.internal_call(NAME, "Deliver", sub["endpoint"], origin, (time.perf_counter() - started) * 1000, None if status < 400 else ("HttpError", f"HTTP {status}"))
    except Exception as error:  # an unreachable endpoint is only reported
        cloud.internal_call(NAME, "Deliver", sub["endpoint"], origin, (time.perf_counter() - started) * 1000, ("DeliveryFailed", str(error)))


def publish_arn(cloud, arn, message, subject, source):
    """Publishes a message from another service (bucket events, rules, schedules)."""
    try:
        _, _, _, region, account, name = arn.split(":", 5)
    except ValueError:
        return False
    topic = topics(cloud, account, region).get(name)
    if topic is None:
        cloud.internal_call(NAME, "Publish", name, source, error=("NotFound", f"Topic {arn} does not exist"))
        return False
    text = message if isinstance(message, str) else json.dumps(message, ensure_ascii=False)
    fan_out(cloud, topic, text, subject, {}, None, None, source)
    cloud.internal_call(NAME, "Publish", name, source, req=text[:600], account=account, region=region)
    return True


OPS = {
    "CreateTopic": create_topic, "DeleteTopic": delete_topic, "ListTopics": list_topics,
    "GetTopicAttributes": get_topic_attributes, "SetTopicAttributes": set_topic_attributes,
    "Subscribe": subscribe, "Unsubscribe": unsubscribe, "ConfirmSubscription": confirm_subscription,
    "ListSubscriptions": list_subscriptions, "ListSubscriptionsByTopic": list_subscriptions_by_topic,
    "GetSubscriptionAttributes": get_subscription_attributes, "SetSubscriptionAttributes": set_subscription_attributes,
    "TagResource": tag_resource, "ListTagsForResource": list_tags, "Publish": publish, "PublishBatch": publish_batch,
}


def resources(cloud):
    result = []
    for account, region, service in cloud.store.each(NAME):
        for topic in service.get("topics", {}).values():
            result.append({"service": NAME, "kind": "topic", "name": topic["name"], "arn": topic["arn"], "account": account, "region": region,
                           "created": topic["created"], "published": topic.get("published", 0),
                           "subscriptions": [{"protocol": s["protocol"], "endpoint": s["endpoint"], "confirmed": s["confirmed"],
                                              "raw": s["attributes"].get("RawMessageDelivery") == "true",
                                              "filter": s["attributes"].get("FilterPolicy")} for s in topic["subscriptions"].values()]})
    return result
