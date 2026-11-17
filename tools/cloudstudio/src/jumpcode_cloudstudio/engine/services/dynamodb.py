# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Amazon DynamoDB (JSON 1.0): tables with secondary indexes, items, queries, scans, conditions, transactions and TTL."""

import base64
import copy
import hashlib
import json
import time
import uuid

from .. import wire
from ..wire import AwsError
from . import dynamo_expr as ex
from .common import json_service

NAME = "dynamodb"
LABEL = "DynamoDB"
NAMESPACE = "com.amazonaws.dynamodb.v20120810"
MAX_ITEM = 400 * 1024
MAX_PAGE = 1024 * 1024


def handle(cloud, request):
    return json_service(cloud, request, NAMESPACE, "1.0", OPS)


def tables(cloud, caller):
    return cloud.store.regional(caller.account, caller.region, NAME).setdefault("tables", {})


def table_of(cloud, caller, name, must=True):
    if not name:
        raise ex.invalid("1 validation error detected: Value null at 'tableName' failed to satisfy constraint: Member must not be null")
    name = name.rsplit("/", 1)[-1] if str(name).startswith("arn:") else name
    caller.target = name
    table = tables(cloud, caller).get(name)
    if table is None and must:
        raise AwsError("ResourceNotFoundException", "Requested resource not found" if not name else f"Requested resource not found: Table: {name} not found")
    return table


# ---------------------------------------------------------------- keys

def key_schema(schema):
    hash_key = next((k["AttributeName"] for k in schema if k.get("KeyType") == "HASH"), None)
    range_key = next((k["AttributeName"] for k in schema if k.get("KeyType") == "RANGE"), None)
    return hash_key, range_key


def key_string(item, hash_key, range_key):
    return json.dumps([item.get(hash_key), item.get(range_key) if range_key else None], sort_keys=True, separators=(",", ":"))


def attribute_types(table):
    return {a["AttributeName"]: a["AttributeType"] for a in table["attributes"]}


def check_key(table, key, what="key"):
    hash_key, range_key = key_schema(table["keys"])
    wanted = {hash_key} | ({range_key} if range_key else set())
    if set(key) != wanted:
        raise ex.invalid("The provided key element does not match the schema")
    types = attribute_types(table)
    for name in wanted:
        value = key[name]
        if ex.kind_of(value) != types.get(name):
            raise ex.invalid("The provided key element does not match the schema")
        if ex.kind_of(value) in ("S", "B") and value[ex.kind_of(value)] == "":
            raise ex.invalid(f"One or more parameter values are not valid. The AttributeValue for a key attribute cannot contain an empty string value. Key: {name}")
    return key_string(key, hash_key, range_key)


def check_item(table, item):
    hash_key, range_key = key_schema(table["keys"])
    types = attribute_types(table)
    for name in [hash_key] + ([range_key] if range_key else []):
        if name not in item:
            raise ex.invalid(f"One or more parameter values were invalid: Missing the key {name} in the item")
        if ex.kind_of(item[name]) != types.get(name):
            raise ex.invalid(f"One or more parameter values were invalid: Type mismatch for key {name} expected: {types.get(name)} actual: {ex.kind_of(item[name])}")
        if ex.kind_of(item[name]) in ("S", "B") and item[name][ex.kind_of(item[name])] == "":
            raise ex.invalid(f"One or more parameter values are not valid. The AttributeValue for a key attribute cannot contain an empty string value. Key: {name}")
    for index in table.get("gsis", []) + table.get("lsis", []):
        for key in index["KeySchema"]:
            name = key["AttributeName"]
            if name in item and ex.kind_of(item[name]) != types.get(name):
                raise ex.invalid(f"One or more parameter values were invalid: Type mismatch for Index Key {name} Expected: {types.get(name)} Actual: {ex.kind_of(item[name])} IndexName: {index['IndexName']}")
    if ex.item_size(item) > MAX_ITEM:
        raise ex.invalid("Item size has exceeded the maximum allowed size")
    return key_string(item, hash_key, range_key)


def clean_item(item):
    if not isinstance(item, dict):
        raise ex.invalid("1 validation error detected: Value null at 'item' failed to satisfy constraint: Member must not be null")
    return {name: ex.canonical(value) for name, value in item.items()}


def expression_args(params, *fields):
    names = params.get("ExpressionAttributeNames") or {}
    values = params.get("ExpressionAttributeValues") or {}
    used = {"names": set(), "values": set()}
    return names, values, used


def condition(params, field="ConditionExpression"):
    text = params.get(field)
    names, values, used = expression_args(params)
    if not text:
        if params.get("ExpressionAttributeValues") and field == "ConditionExpression" and not params.get("UpdateExpression"):
            raise ex.invalid("ExpressionAttributeValues can only be specified when using expressions: ConditionExpression is null")
        return None, (names, values, used)
    return ex.Condition(text, names, values, used), (names, values, used)


def returned(item, values):
    return {"Attributes": item} if item and values else {}


def describe(table):
    item_count = len(table["items"])
    size = sum(ex.item_size(item) for item in table["items"].values())
    result = {
        "TableName": table["name"], "TableStatus": "ACTIVE", "TableArn": table["arn"], "TableId": table["id"],
        "KeySchema": table["keys"], "AttributeDefinitions": table["attributes"], "CreationDateTime": table["created"],
        "ItemCount": item_count, "TableSizeBytes": size, "DeletionProtectionEnabled": table.get("protected", False),
        "ProvisionedThroughput": {"NumberOfDecreasesToday": 0, "ReadCapacityUnits": table["throughput"].get("ReadCapacityUnits", 0),
                                  "WriteCapacityUnits": table["throughput"].get("WriteCapacityUnits", 0)},
        "BillingModeSummary": {"BillingMode": table["billing"], "LastUpdateToPayPerRequestDateTime": table["created"]},
    }
    if table.get("gsis"):
        result["GlobalSecondaryIndexes"] = [{**index, "IndexStatus": "ACTIVE", "IndexArn": f"{table['arn']}/index/{index['IndexName']}",
                                             "ItemCount": _index_count(table, index), "IndexSizeBytes": 0,
                                             "ProvisionedThroughput": {"ReadCapacityUnits": 0, "WriteCapacityUnits": 0, "NumberOfDecreasesToday": 0}}
                                            for index in table["gsis"]]
    if table.get("lsis"):
        result["LocalSecondaryIndexes"] = [{**index, "IndexArn": f"{table['arn']}/index/{index['IndexName']}",
                                            "ItemCount": _index_count(table, index), "IndexSizeBytes": 0} for index in table["lsis"]]
    if table.get("stream"):
        result["StreamSpecification"] = table["stream"]
    return result


def _index_count(table, index):
    names = [k["AttributeName"] for k in index["KeySchema"]]
    return sum(1 for item in table["items"].values() if all(name in item for name in names))


# ---------------------------------------------------------------- tables

def create_table(cloud, caller, params):
    name = params.get("TableName")
    if not name or not isinstance(name, str) or not (3 <= len(name) <= 255):
        raise ex.invalid("TableName must be at least 3 characters long and at most 255 characters long")
    caller.target = name
    existing = tables(cloud, caller)
    if name in existing:
        raise AwsError("ResourceInUseException", f"Table already exists: {name}")
    schema = params.get("KeySchema") or []
    attributes = params.get("AttributeDefinitions") or []
    hash_key, range_key = key_schema(schema)
    if not hash_key:
        raise ex.invalid("1 validation error detected: Value null at 'keySchema' failed to satisfy constraint: Member must not be null")
    defined = {a.get("AttributeName") for a in attributes}
    gsis = [dict(index) for index in params.get("GlobalSecondaryIndexes") or []]
    lsis = [dict(index) for index in params.get("LocalSecondaryIndexes") or []]
    needed = {hash_key, range_key} - {None}
    for index in gsis + lsis:
        needed |= {k["AttributeName"] for k in index.get("KeySchema", [])}
        index.pop("ProvisionedThroughput", None)
        index.setdefault("Projection", {"ProjectionType": "ALL"})
    if needed - defined:
        raise ex.invalid("One or more parameter values were invalid: Some index key attributes are not defined in AttributeDefinitions. "
                         f"Keys: [{', '.join(sorted(needed - defined))}], AttributeDefinitions: [{', '.join(sorted(defined))}]")
    if defined - needed:
        raise ex.invalid("One or more parameter values were invalid: Number of attributes in KeySchema does not exactly match number of attributes defined in AttributeDefinitions")
    billing = params.get("BillingMode") or ("PROVISIONED" if params.get("ProvisionedThroughput") else "PAY_PER_REQUEST")
    table = {
        "name": name, "arn": wire.arn("dynamodb", caller.region, caller.account, f"table/{name}"), "id": str(uuid.uuid4()),
        "created": round(time.time(), 3), "keys": schema, "attributes": attributes, "billing": billing,
        "throughput": params.get("ProvisionedThroughput") or {}, "gsis": gsis, "lsis": lsis,
        "tags": {t["Key"]: t["Value"] for t in params.get("Tags") or []}, "ttl": None, "items": {},
        "stream": params.get("StreamSpecification"), "protected": bool(params.get("DeletionProtectionEnabled")),
    }
    existing[name] = table
    cloud.store.touch()
    return {"TableDescription": {**describe(table), "TableStatus": "ACTIVE"}}


def delete_table(cloud, caller, params):
    table = table_of(cloud, caller, params.get("TableName"))
    if table.get("protected"):
        raise ex.invalid(f"Resource cannot be deleted as it is currently protected against deletion. Disable deletion protection first.")
    description = describe(table)
    del tables(cloud, caller)[table["name"]]
    cloud.store.touch()
    return {"TableDescription": {**description, "TableStatus": "DELETING"}}


def describe_table(cloud, caller, params):
    return {"Table": describe(table_of(cloud, caller, params.get("TableName")))}


def list_tables(cloud, caller, params):
    names = sorted(tables(cloud, caller))
    start = params.get("ExclusiveStartTableName")
    if start:
        names = [n for n in names if n > start]
    limit = int(params.get("Limit") or 100)
    result = {"TableNames": names[:limit]}
    if len(names) > limit:
        result["LastEvaluatedTableName"] = names[limit - 1]
    return result


def update_table(cloud, caller, params):
    table = table_of(cloud, caller, params.get("TableName"))
    if params.get("AttributeDefinitions"):
        known = {a["AttributeName"]: a for a in table["attributes"]}
        for attribute in params["AttributeDefinitions"]:
            known[attribute["AttributeName"]] = attribute
        table["attributes"] = list(known.values())
    if params.get("BillingMode"):
        table["billing"] = params["BillingMode"]
    if params.get("ProvisionedThroughput"):
        table["throughput"] = params["ProvisionedThroughput"]
    if "DeletionProtectionEnabled" in params:
        table["protected"] = bool(params["DeletionProtectionEnabled"])
    if params.get("StreamSpecification"):
        table["stream"] = params["StreamSpecification"]
    for update in params.get("GlobalSecondaryIndexUpdates") or []:
        if "Create" in update:
            index = dict(update["Create"])
            index.pop("ProvisionedThroughput", None)
            if any(i["IndexName"] == index["IndexName"] for i in table["gsis"]):
                raise ex.invalid(f"One or more parameter values were invalid: Index with name {index['IndexName']} already exists")
            table["gsis"].append(index)
        elif "Delete" in update:
            table["gsis"] = [i for i in table["gsis"] if i["IndexName"] != update["Delete"]["IndexName"]]
    cloud.store.touch()
    return {"TableDescription": describe(table)}


def update_ttl(cloud, caller, params):
    table = table_of(cloud, caller, params.get("TableName"))
    spec = params.get("TimeToLiveSpecification") or {}
    table["ttl"] = {"attribute": spec.get("AttributeName"), "enabled": bool(spec.get("Enabled"))}
    cloud.store.touch()
    return {"TimeToLiveSpecification": spec}


def describe_ttl(cloud, caller, params):
    table = table_of(cloud, caller, params.get("TableName"))
    ttl = table.get("ttl")
    if not ttl or not ttl.get("enabled"):
        return {"TimeToLiveDescription": {"TimeToLiveStatus": "DISABLED"}}
    return {"TimeToLiveDescription": {"TimeToLiveStatus": "ENABLED", "AttributeName": ttl["attribute"]}}


def tag_resource(cloud, caller, params):
    table = table_of(cloud, caller, params.get("ResourceArn"))
    table.setdefault("tags", {}).update({t["Key"]: t["Value"] for t in params.get("Tags") or []})
    cloud.store.touch()
    return {}


def untag_resource(cloud, caller, params):
    table = table_of(cloud, caller, params.get("ResourceArn"))
    for key in params.get("TagKeys") or []:
        table.setdefault("tags", {}).pop(key, None)
    cloud.store.touch()
    return {}


def list_tags(cloud, caller, params):
    table = table_of(cloud, caller, params.get("ResourceArn"))
    return {"Tags": [{"Key": k, "Value": v} for k, v in table.get("tags", {}).items()]}


def describe_continuous_backups(cloud, caller, params):
    table_of(cloud, caller, params.get("TableName"))
    return {"ContinuousBackupsDescription": {"ContinuousBackupsStatus": "ENABLED",
                                             "PointInTimeRecoveryDescription": {"PointInTimeRecoveryStatus": "DISABLED"}}}


def describe_endpoints(cloud, caller, params):
    return {"Endpoints": [{"Address": f"127.0.0.1:{cloud.port}", "CachePeriodInMinutes": 1440}]}


# ---------------------------------------------------------------- items

def _check_condition(table, key, params, field="ConditionExpression"):
    test, (names, values, used) = condition(params, field)
    current = table["items"].get(key)
    if params.get("Expected"):
        test = _expected(params["Expected"], params.get("ConditionalOperator", "AND"))
    if test is not None and not test(current or {}):
        extra = {"Item": current} if current and params.get("ReturnValuesOnConditionCheckFailure") == "ALL_OLD" else {}
        raise AwsError("ConditionalCheckFailedException", "The conditional request failed", extra=extra)
    return names, values, used


def _expected(expected, operator):
    """The legacy Expected parameter (Exists / Value / ComparisonOperator)."""

    def test(item):
        results = []
        for name, rule in expected.items():
            value = item.get(name)
            if "Exists" in rule and rule["Exists"] is False:
                results.append(value is None)
            elif "Value" in rule and rule.get("Exists", True):
                results.append(ex.equal(value, rule["Value"]))
            elif "ComparisonOperator" in rule:
                results.append(_legacy_compare(value, rule["ComparisonOperator"], rule.get("AttributeValueList") or []))
            else:
                results.append(value is not None)
        return all(results) if operator == "AND" else any(results)

    return test


def _legacy_compare(value, operator, arguments):
    if operator == "NULL":
        return value is None
    if operator == "NOT_NULL":
        return value is not None
    if value is None:
        return False
    first = arguments[0] if arguments else None
    if operator == "EQ":
        return ex.equal(value, first)
    if operator == "NE":
        return not ex.equal(value, first)
    if operator in ("LT", "LE", "GT", "GE"):
        return ex.compare(value, {"LT": "<", "LE": "<=", "GT": ">", "GE": ">="}[operator], first)
    if operator == "BEGINS_WITH":
        return ex.kind_of(value) == ex.kind_of(first) and ex.comparable(value).startswith(ex.comparable(first))
    if operator == "BETWEEN":
        return ex.compare(value, ">=", arguments[0]) and ex.compare(value, "<=", arguments[1])
    if operator == "IN":
        return any(ex.equal(value, option) for option in arguments)
    if operator == "CONTAINS":
        return ex.evaluate(("fn", "contains", ["v"], ("value", first)), {"v": value})
    if operator == "NOT_CONTAINS":
        return not ex.evaluate(("fn", "contains", ["v"], ("value", first)), {"v": value})
    return False


def put_item(cloud, caller, params):
    table = table_of(cloud, caller, params.get("TableName"))
    item = clean_item(params.get("Item"))
    key = check_item(table, item)
    with cloud.store.lock:
        names, values, used = _check_condition(table, key, params)
        ex.check_unused(names, values, used)
        old = table["items"].get(key)
        table["items"][key] = item
    cloud.store.touch()
    result = returned(old, params.get("ReturnValues") == "ALL_OLD")
    return _capacity(result, table, params, 1)


def get_item(cloud, caller, params):
    table = table_of(cloud, caller, params.get("TableName"))
    key = check_key(table, params.get("Key") or {})
    names = params.get("ExpressionAttributeNames") or {}
    used = {"names": set(), "values": set()}
    paths = ex.projection(params.get("ProjectionExpression"), names, used)
    if params.get("AttributesToGet"):
        paths = [[name] for name in params["AttributesToGet"]]
    ex.check_unused(names, {}, used)
    item = table["items"].get(key)
    result = {"Item": copy.deepcopy(ex.project(item, paths))} if item is not None else {}
    return _capacity(result, table, params, 0.5)


def delete_item(cloud, caller, params):
    table = table_of(cloud, caller, params.get("TableName"))
    key = check_key(table, params.get("Key") or {})
    with cloud.store.lock:
        names, values, used = _check_condition(table, key, params)
        ex.check_unused(names, values, used)
        old = table["items"].pop(key, None)
    if old is not None:
        cloud.store.touch()
    return _capacity(returned(old, params.get("ReturnValues") == "ALL_OLD"), table, params, 1)


def update_item(cloud, caller, params):
    table = table_of(cloud, caller, params.get("TableName"))
    raw_key = params.get("Key") or {}
    key = check_key(table, raw_key)
    with cloud.store.lock:
        names, values, used = _check_condition(table, key, params)
        old = table["items"].get(key)
        base = copy.deepcopy(old) if old is not None else {name: ex.canonical(value) for name, value in raw_key.items()}
        if params.get("UpdateExpression"):
            update = ex.Update(params["UpdateExpression"], names, values, used)
            new, changed = update.apply(base)
        else:
            new, changed = _attribute_updates(base, params.get("AttributeUpdates") or {})
        ex.check_unused(names, values, used)
        hash_key, range_key = key_schema(table["keys"])
        for name in (hash_key, range_key):
            if name and name in changed:
                raise ex.invalid(f"One or more parameter values were invalid: Cannot update attribute {name}. This attribute is part of the key")
        check_item(table, new)
        table["items"][key] = new
    cloud.store.touch()
    mode = params.get("ReturnValues") or "NONE"
    attributes = None
    if mode == "ALL_NEW":
        attributes = new
    elif mode == "ALL_OLD":
        attributes = old
    elif mode == "UPDATED_NEW":
        attributes = {name: new[name] for name in changed if name in new}
    elif mode == "UPDATED_OLD":
        attributes = {name: old[name] for name in changed if old and name in old}
    return _capacity({"Attributes": attributes} if attributes else {}, table, params, 1)


def _attribute_updates(item, updates):
    new = copy.deepcopy(item)
    for name, update in updates.items():
        action = update.get("Action", "PUT")
        value = ex.canonical(update["Value"]) if "Value" in update else None
        if action == "PUT":
            new[name] = value
        elif action == "DELETE":
            if value is None:
                new.pop(name, None)
            elif name in new:
                kind = ex.kind_of(value)
                remaining = [v for v in new[name].get(kind, []) if v not in value[kind]]
                if remaining:
                    new[name] = {kind: remaining}
                else:
                    new.pop(name, None)
        elif action == "ADD":
            kind = ex.kind_of(value)
            if kind == "N":
                total = ex.number(value["N"]) + (ex.number(new[name]["N"]) if name in new else 0)
                new[name] = {"N": ex.number_text(total)}
            else:
                merged = list(new.get(name, {}).get(kind, []))
                merged += [v for v in value[kind] if v not in merged]
                new[name] = {kind: merged}
    return new, list(updates)


def _capacity(result, table, params, units):
    if params.get("ReturnConsumedCapacity") in ("TOTAL", "INDEXES"):
        result["ConsumedCapacity"] = {"TableName": table["name"], "CapacityUnits": float(units)}
    return result


# ---------------------------------------------------------------- query and scan

def _index(table, name):
    if not name:
        return None, table["keys"]
    for index in table.get("gsis", []) + table.get("lsis", []):
        if index["IndexName"] == name:
            return index, index["KeySchema"]
    raise ex.invalid(f"The table does not have the specified index: {name}")


def _project_index(table, index, item):
    if index is None:
        return item
    projection = index.get("Projection") or {"ProjectionType": "ALL"}
    if projection.get("ProjectionType") == "ALL":
        return item
    keep = {k["AttributeName"] for k in table["keys"]} | {k["AttributeName"] for k in index["KeySchema"]}
    if projection.get("ProjectionType") == "INCLUDE":
        keep |= set(projection.get("NonKeyAttributes") or [])
    return {name: value for name, value in item.items() if name in keep}


def _sort_value(item, name):
    value = item.get(name)
    if value is None:
        return (0, b"")
    kind = ex.kind_of(value)
    if kind == "N":
        return (1, ex.number(value["N"]))
    return (2, ex.comparable(value))


def _page(table, index, candidates, params, filter_test, names, values, used, sort_name=None, forward=True):
    paths = ex.projection(params.get("ProjectionExpression"), names, used)
    if params.get("AttributesToGet"):
        paths = [[name] for name in params["AttributesToGet"]]
    ex.check_unused(names, values, used)
    hash_key, range_key = key_schema(table["keys"])
    index_keys = [k["AttributeName"] for k in index["KeySchema"]] if index else []
    start = params.get("ExclusiveStartKey")
    if start:
        marker = key_string(start, hash_key, range_key)
        position = next((i for i, item in enumerate(candidates) if key_string(item, hash_key, range_key) == marker), None)
        if position is not None:
            candidates = candidates[position + 1:]
    limit = params.get("Limit")
    if limit is not None and int(limit) < 1:
        raise ex.invalid("1 validation error detected: Value '0' at 'limit' failed to satisfy constraint: Member must have value greater than or equal to 1")
    items = []
    scanned = 0
    size = 0
    last = None
    for item in candidates:
        scanned += 1
        size += ex.item_size(item)
        if filter_test is None or filter_test(item):
            items.append(ex.project(_project_index(table, index, item), paths))
        reached = (limit is not None and scanned >= int(limit)) or size >= MAX_PAGE
        if reached and scanned < len(candidates):
            last = {name: item[name] for name in {hash_key, range_key, *index_keys} if name and name in item}
            break
    result = {"Count": len(items), "ScannedCount": scanned}
    if params.get("Select") != "COUNT":
        result["Items"] = copy.deepcopy(items)
    if last:
        result["LastEvaluatedKey"] = last
    return _capacity(result, table, params, max(0.5, size / 4096 / 2))


def query(cloud, caller, params):
    table = table_of(cloud, caller, params.get("TableName"))
    index, schema = _index(table, params.get("IndexName"))
    hash_key, range_key = key_schema(schema)
    names = params.get("ExpressionAttributeNames") or {}
    values = params.get("ExpressionAttributeValues") or {}
    used = {"names": set(), "values": set()}
    if params.get("KeyConditionExpression"):
        hash_value, range_test = ex.key_condition(params["KeyConditionExpression"], names, values, used, hash_key, range_key)
    elif params.get("KeyConditions"):
        conditions = params["KeyConditions"]
        if hash_key not in conditions:
            raise ex.invalid(f"Query condition missed key schema element: {hash_key}")
        hash_value = conditions[hash_key]["AttributeValueList"][0]
        rule = conditions.get(range_key) if range_key else None
        range_test = (lambda item: True) if not rule else (lambda item: _legacy_compare(item.get(range_key), rule["ComparisonOperator"], rule.get("AttributeValueList") or []))
    else:
        raise ex.invalid("Either the KeyConditions or KeyConditionExpression parameter must be specified in the request.")
    filter_test = ex.Condition(params["FilterExpression"], names, values, used) if params.get("FilterExpression") else None
    if params.get("QueryFilter"):
        filter_test = _expected({k: {"ComparisonOperator": v["ComparisonOperator"], "AttributeValueList": v.get("AttributeValueList", [])}
                                 for k, v in params["QueryFilter"].items()}, params.get("ConditionalOperator", "AND"))
    with cloud.store.lock:
        candidates = [item for item in table["items"].values()
                      if ex.equal(item.get(hash_key), hash_value) and (not range_key or range_key in item) and range_test(item)]
    forward = params.get("ScanIndexForward", True) is not False
    table_hash, table_range = key_schema(table["keys"])
    candidates.sort(key=lambda item: (_sort_value(item, range_key) if range_key else (0, b""), _sort_value(item, table_range) if table_range else (0, b"")),
                    reverse=not forward)
    return _page(table, index, candidates, params, filter_test, names, values, used)


def scan(cloud, caller, params):
    table = table_of(cloud, caller, params.get("TableName"))
    index, schema = _index(table, params.get("IndexName"))
    names = params.get("ExpressionAttributeNames") or {}
    values = params.get("ExpressionAttributeValues") or {}
    used = {"names": set(), "values": set()}
    filter_test = ex.Condition(params["FilterExpression"], names, values, used) if params.get("FilterExpression") else None
    if params.get("ScanFilter"):
        filter_test = _expected({k: {"ComparisonOperator": v["ComparisonOperator"], "AttributeValueList": v.get("AttributeValueList", [])}
                                 for k, v in params["ScanFilter"].items()}, params.get("ConditionalOperator", "AND"))
    index_names = [k["AttributeName"] for k in schema]
    with cloud.store.lock:
        keys = sorted(table["items"])
        candidates = [table["items"][k] for k in keys]
    if index is not None:
        candidates = [item for item in candidates if all(name in item for name in index_names)]
    total = params.get("TotalSegments")
    if total:
        segment = int(params.get("Segment") or 0)
        hash_key, range_key = key_schema(table["keys"])
        candidates = [item for item in candidates
                      if int(hashlib.md5(json.dumps(item.get(hash_key), sort_keys=True).encode()).hexdigest(), 16) % int(total) == segment]
    return _page(table, index, candidates, params, filter_test, names, values, used)


# ---------------------------------------------------------------- batches and transactions

def batch_get(cloud, caller, params):
    responses = {}
    for name, request in (params.get("RequestItems") or {}).items():
        table = table_of(cloud, caller, name)
        names = request.get("ExpressionAttributeNames") or {}
        used = {"names": set(), "values": set()}
        paths = ex.projection(request.get("ProjectionExpression"), names, used)
        found = []
        for key in request.get("Keys") or []:
            item = table["items"].get(check_key(table, key))
            if item is not None:
                found.append(copy.deepcopy(ex.project(item, paths)))
        responses[table["name"]] = found
    caller.target = ", ".join(responses)
    return {"Responses": responses, "UnprocessedKeys": {}}


def batch_write(cloud, caller, params):
    requests = params.get("RequestItems") or {}
    count = sum(len(v) for v in requests.values())
    if count > 25:
        raise ex.invalid("Too many items requested for the BatchWriteItem call")
    plans = []
    for name, entries in requests.items():
        table = table_of(cloud, caller, name)
        seen = set()
        for entry in entries:
            if "PutRequest" in entry:
                item = clean_item(entry["PutRequest"].get("Item"))
                key = check_item(table, item)
                plans.append((table, key, item))
            elif "DeleteRequest" in entry:
                key = check_key(table, entry["DeleteRequest"].get("Key") or {})
                plans.append((table, key, None))
            else:
                raise ex.invalid("A write request must have PutRequest or DeleteRequest")
            if key in seen:
                raise ex.invalid("Provided list of item keys contains duplicates")
            seen.add(key)
    with cloud.store.lock:
        for table, key, item in plans:
            if item is None:
                table["items"].pop(key, None)
            else:
                table["items"][key] = item
    cloud.store.touch()
    caller.target = ", ".join(requests)
    return {"UnprocessedItems": {}}


def transact_write(cloud, caller, params):
    entries = params.get("TransactItems") or []
    if not entries or len(entries) > 100:
        raise ex.invalid("1 validation error detected: Value at 'transactItems' failed to satisfy constraint: Member must have length less than or equal to 100")
    plans = []
    reasons = []
    failed = False
    with cloud.store.lock:
        for entry in entries:
            (kind, spec), = entry.items()
            table = table_of(cloud, caller, spec.get("TableName"))
            try:
                if kind == "Put":
                    item = clean_item(spec.get("Item"))
                    key = check_item(table, item)
                    _check_condition(table, key, spec)
                    plans.append(("put", table, key, item))
                elif kind == "Delete":
                    key = check_key(table, spec.get("Key") or {})
                    _check_condition(table, key, spec)
                    plans.append(("delete", table, key, None))
                elif kind == "Update":
                    key = check_key(table, spec.get("Key") or {})
                    names, values, used = _check_condition(table, key, spec)
                    old = table["items"].get(key)
                    base = copy.deepcopy(old) if old else {n: ex.canonical(v) for n, v in spec["Key"].items()}
                    new, _ = ex.Update(spec.get("UpdateExpression", ""), names, values, used).apply(base)
                    check_item(table, new)
                    plans.append(("put", table, key, new))
                elif kind == "ConditionCheck":
                    key = check_key(table, spec.get("Key") or {})
                    _check_condition(table, key, spec)
                    plans.append(("check", table, key, None))
                reasons.append({"Code": "None"})
            except AwsError as error:
                if error.code != "ConditionalCheckFailedException":
                    raise
                failed = True
                reason = {"Code": "ConditionalCheckFailed", "Message": "The conditional request failed"}
                if error.extra.get("Item"):
                    reason["Item"] = error.extra["Item"]
                reasons.append(reason)
        if failed:
            codes = ", ".join(reason["Code"] for reason in reasons)
            raise AwsError("TransactionCanceledException", f"Transaction cancelled, please refer cancellation reasons for specific reasons [{codes}]",
                           extra={"CancellationReasons": reasons})
        for action, table, key, item in plans:
            if action == "put":
                table["items"][key] = item
            elif action == "delete":
                table["items"].pop(key, None)
    cloud.store.touch()
    caller.target = ", ".join(sorted({plan[1]["name"] for plan in plans}))
    return {}


def transact_get(cloud, caller, params):
    responses = []
    for entry in params.get("TransactItems") or []:
        spec = entry.get("Get") or {}
        table = table_of(cloud, caller, spec.get("TableName"))
        names = spec.get("ExpressionAttributeNames") or {}
        paths = ex.projection(spec.get("ProjectionExpression"), names, {"names": set(), "values": set()})
        item = table["items"].get(check_key(table, spec.get("Key") or {}))
        responses.append({"Item": copy.deepcopy(ex.project(item, paths))} if item else {})
    return {"Responses": responses}


def execute_statement(cloud, caller, params):
    raise AwsError("UnknownOperationException", "CloudStudio does not run PartiQL statements yet; use GetItem, Query or Scan.")


OPS = {
    "CreateTable": create_table, "DeleteTable": delete_table, "DescribeTable": describe_table, "ListTables": list_tables,
    "UpdateTable": update_table, "UpdateTimeToLive": update_ttl, "DescribeTimeToLive": describe_ttl,
    "TagResource": tag_resource, "UntagResource": untag_resource, "ListTagsOfResource": list_tags,
    "DescribeContinuousBackups": describe_continuous_backups, "DescribeEndpoints": describe_endpoints,
    "PutItem": put_item, "GetItem": get_item, "DeleteItem": delete_item, "UpdateItem": update_item,
    "Query": query, "Scan": scan, "BatchGetItem": batch_get, "BatchWriteItem": batch_write,
    "TransactWriteItems": transact_write, "TransactGetItems": transact_get, "ExecuteStatement": execute_statement,
}


def expire(cloud):
    """Deletes items whose TTL attribute is in the past (DynamoDB does this within minutes; here every sweep)."""
    now = time.time()
    removed = 0
    with cloud.store.lock:
        for _, _, service in cloud.store.each(NAME):
            for table in service.get("tables", {}).values():
                ttl = table.get("ttl")
                if not ttl or not ttl.get("enabled"):
                    continue
                name = ttl["attribute"]
                for key, item in list(table["items"].items()):
                    value = item.get(name)
                    if value and ex.kind_of(value) == "N" and float(value["N"]) < now:
                        del table["items"][key]
                        removed += 1
    if removed:
        cloud.store.touch()


def resources(cloud):
    result = []
    for account, region, service in cloud.store.each(NAME):
        for table in service.get("tables", {}).values():
            hash_key, range_key = key_schema(table["keys"])
            items = list(table["items"].values())
            result.append({
                "service": NAME, "kind": "table", "name": table["name"], "arn": table["arn"], "account": account, "region": region,
                "created": table["created"], "count": len(items), "bytes": sum(ex.item_size(i) for i in items),
                "key": {"hash": hash_key, "range": range_key, "types": attribute_types(table)},
                "indexes": [{"name": i["IndexName"], "kind": "global", "keys": key_schema(i["KeySchema"])} for i in table.get("gsis", [])]
                + [{"name": i["IndexName"], "kind": "local", "keys": key_schema(i["KeySchema"])} for i in table.get("lsis", [])],
                "ttl": table.get("ttl"), "billing": table["billing"],
                "items": [{key: plain(value) for key, value in item.items()} for item in items[-200:]],
            })
    return result


def plain(value):
    """A typed item as ordinary JSON for the Studio (numbers stay text so nothing is rounded)."""
    if isinstance(value, dict) and len(value) == 1 and next(iter(value)) in ("S", "N", "B", "BOOL", "NULL", "M", "L", "SS", "NS", "BS"):
        (kind, data), = value.items()
        if kind == "M":
            return {"$map": {k: plain(v) for k, v in data.items()}}
        if kind == "L":
            return [plain(v) for v in data]
        if kind == "NULL":
            return None
        if kind == "N":
            return {"$n": data}
        if kind in ("SS", "BS"):
            return {"$set": list(data)}
        if kind == "NS":
            return {"$set": [{"$n": v} for v in data]}
        if kind == "B":
            return {"$b": len(base64.b64decode(data)) if isinstance(data, str) else len(data)}
        return data
    return {k: plain(v) for k, v in value.items()}
