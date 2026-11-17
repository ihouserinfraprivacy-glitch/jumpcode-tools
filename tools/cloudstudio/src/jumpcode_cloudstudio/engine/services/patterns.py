# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Content matching shared by EventBridge event patterns and SNS filter policies."""

import ipaddress
import re


def matches(pattern, event):
    """Whether a JSON event matches an EventBridge-style pattern (every key must match; arrays mean any of)."""
    if not isinstance(pattern, dict):
        return False
    for key, rule in pattern.items():
        if key == "$or":
            if not any(matches(option, event) for option in rule):
                return False
            continue
        present = isinstance(event, dict) and key in event
        value = event.get(key) if isinstance(event, dict) else None
        if isinstance(rule, dict):
            if not present or not isinstance(value, dict) or not matches(rule, value):
                return False
            continue
        if not isinstance(rule, list):
            return False
        if not _any_rule(rule, value, present):
            return False
    return True


def _any_rule(rules, value, present):
    values = value if isinstance(value, list) else [value]
    for rule in rules:
        if isinstance(rule, dict):
            if "exists" in rule:
                if bool(rule["exists"]) == present:
                    return True
                continue
            if not present:
                continue
            if any(_operator(rule, item) for item in values):
                return True
        elif present and any(item == rule or (isinstance(item, (int, float)) and isinstance(rule, (int, float)) and float(item) == float(rule))
                             for item in values):
            return True
    return False


def _operator(rule, value):
    if "prefix" in rule:
        prefix = rule["prefix"]
        if isinstance(prefix, dict) and "equals-ignore-case" in prefix:
            return isinstance(value, str) and value.lower().startswith(prefix["equals-ignore-case"].lower())
        return isinstance(value, str) and value.startswith(prefix)
    if "suffix" in rule:
        suffix = rule["suffix"]
        if isinstance(suffix, dict) and "equals-ignore-case" in suffix:
            return isinstance(value, str) and value.lower().endswith(suffix["equals-ignore-case"].lower())
        return isinstance(value, str) and value.endswith(suffix)
    if "equals-ignore-case" in rule:
        return isinstance(value, str) and value.lower() == str(rule["equals-ignore-case"]).lower()
    if "wildcard" in rule:
        expression = "^" + ".*".join(re.escape(part) for part in str(rule["wildcard"]).split("*")) + "$"
        return isinstance(value, str) and re.match(expression, value) is not None
    if "anything-but" in rule:
        excluded = rule["anything-but"]
        if isinstance(excluded, dict):
            if "prefix" in excluded:
                return isinstance(value, str) and not value.startswith(excluded["prefix"])
            if "suffix" in excluded:
                return isinstance(value, str) and not value.endswith(excluded["suffix"])
            return True
        excluded = excluded if isinstance(excluded, list) else [excluded]
        return value not in excluded
    if "numeric" in rule:
        try:
            number = float(value)
        except (TypeError, ValueError):
            return False
        terms = rule["numeric"]
        for index in range(0, len(terms) - 1, 2):
            op, limit = terms[index], float(terms[index + 1])
            if not {"=": number == limit, "<": number < limit, "<=": number <= limit, ">": number > limit, ">=": number >= limit}.get(op, False):
                return False
        return True
    if "cidr" in rule:
        try:
            return ipaddress.ip_address(value) in ipaddress.ip_network(rule["cidr"], strict=False)
        except ValueError:
            return False
    return False


def filter_policy(policy, attributes, body=None):
    """An SNS filter policy over message attributes (or over the JSON body when its scope is MessageBody)."""
    if body is not None:
        return matches(policy, body)
    flat = {}
    for name, value in (attributes or {}).items():
        kind = value.get("DataType", value.get("Type", "String"))
        text = value.get("StringValue", value.get("Value"))
        if kind.startswith("Number"):
            try:
                flat[name] = float(text)
            except (TypeError, ValueError):
                flat[name] = text
        elif kind.startswith("String.Array"):
            try:
                import json
                flat[name] = json.loads(text)
            except ValueError:
                flat[name] = text
        else:
            flat[name] = text
    return matches(policy, flat)
