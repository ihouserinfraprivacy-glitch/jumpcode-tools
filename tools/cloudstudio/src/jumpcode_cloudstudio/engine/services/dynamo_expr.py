# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""DynamoDB expressions: conditions and filters, key conditions, updates and projections, on typed items
({"S": "x"}, {"N": "1"}, {"M": {...}}, ...)."""

import base64
import copy
from decimal import Context, Decimal, InvalidOperation
import re

from ..wire import AwsError

NUMBERS = Context(prec=38)
_TOKEN = re.compile(r"\s*(?:(?P<name>#[A-Za-z0-9_]+)|(?P<value>:[A-Za-z0-9_]+)|(?P<index>\[\s*\d+\s*\])"
                    r"|(?P<op><>|<=|>=|=|<|>|\(|\)|,|\.|\+|-)|(?P<word>[A-Za-z_][A-Za-z0-9_]*))")
KEYWORDS = {"AND", "OR", "NOT", "BETWEEN", "IN", "SET", "REMOVE", "ADD", "DELETE"}
FUNCTIONS = {"attribute_exists", "attribute_not_exists", "attribute_type", "begins_with", "contains", "size",
             "if_not_exists", "list_append"}


def invalid(message):
    return AwsError("ValidationException", message)


# ---------------------------------------------------------------- typed values

def number(text):
    try:
        value = NUMBERS.create_decimal(str(text))
    except (InvalidOperation, ValueError) as error:
        raise invalid("A value provided cannot be converted into a number") from error
    if not value.is_finite():
        raise invalid("A value provided cannot be converted into a number")
    return value


def number_text(value):
    if value == 0:
        return "0"
    text = format(value.normalize(NUMBERS), "f")
    return text


def canonical(value):
    """Normalizes numbers and checks the shape of one typed value (raising AWS's messages on bad input)."""
    if not isinstance(value, dict) or len(value) != 1:
        raise invalid("Supplied AttributeValue has more than one datatypes set, must contain exactly one of the supported datatypes")
    (kind, data), = value.items()
    if kind == "S":
        if not isinstance(data, str):
            raise invalid("Invalid type for S")
        return value
    if kind == "N":
        return {"N": number_text(number(data))}
    if kind == "B":
        return value
    if kind == "BOOL":
        return {"BOOL": bool(data)}
    if kind == "NULL":
        if data is not True:
            raise invalid("One or more parameter values were invalid: Null attribute value types must have the value of true")
        return value
    if kind == "M":
        return {"M": {k: canonical(v) for k, v in (data or {}).items()}}
    if kind == "L":
        return {"L": [canonical(v) for v in (data or [])]}
    if kind in ("SS", "NS", "BS"):
        if not data:
            raise invalid(f"One or more parameter values were invalid: An {'string' if kind == 'SS' else 'number' if kind == 'NS' else 'binary'} set  may not be empty")
        items = [number_text(number(v)) for v in data] if kind == "NS" else list(data)
        if len(set(items)) != len(items):
            raise invalid(f"Input collection {data} contains duplicates.")
        return {kind: items}
    raise invalid(f"Supplied AttributeValue has an unsupported datatype {kind}")


def kind_of(value):
    return next(iter(value)) if isinstance(value, dict) and value else None


def comparable(value):
    kind = kind_of(value)
    data = value[kind]
    if kind == "N":
        return number(data)
    if kind == "B":
        return base64.b64decode(data) if isinstance(data, str) else data
    if kind == "S":
        return data.encode("utf-8")
    return None


def equal(a, b):
    if a is None or b is None:
        return False
    ka, kb = kind_of(a), kind_of(b)
    if ka != kb:
        return False
    if ka == "N":
        return number(a["N"]) == number(b["N"])
    if ka in ("SS", "BS"):
        return set(a[ka]) == set(b[kb])
    if ka == "NS":
        return {number(x) for x in a[ka]} == {number(x) for x in b[kb]}
    if ka == "M":
        return a["M"].keys() == b["M"].keys() and all(equal(a["M"][k], b["M"][k]) for k in a["M"])
    if ka == "L":
        return len(a["L"]) == len(b["L"]) and all(equal(x, y) for x, y in zip(a["L"], b["L"]))
    return a[ka] == b[kb]


def compare(a, op, b):
    if op == "=":
        return equal(a, b)
    if op == "<>":
        return a is not None and b is not None and not equal(a, b)
    if a is None or b is None or kind_of(a) != kind_of(b) or kind_of(a) not in ("S", "N", "B"):
        return False
    x, y = comparable(a), comparable(b)
    return {"<": x < y, "<=": x <= y, ">": x > y, ">=": x >= y}[op]


def size_of(value):
    kind = kind_of(value)
    data = value[kind]
    if kind == "S":
        return len(data.encode("utf-8"))
    if kind == "B":
        return len(base64.b64decode(data)) if isinstance(data, str) else len(data)
    if kind in ("SS", "NS", "BS", "L"):
        return len(data)
    if kind == "M":
        return len(data)
    raise invalid(f"Invalid function operand type for size: {kind}")


def item_size(item):
    total = 0
    for name, value in item.items():
        total += len(name.encode("utf-8")) + _value_size(value)
    return total


def _value_size(value):
    kind = kind_of(value)
    data = value[kind]
    if kind == "S":
        return len(data.encode("utf-8"))
    if kind == "N":
        return (len(data) + 1) // 2 + 1
    if kind == "B":
        return len(data) * 3 // 4
    if kind in ("BOOL", "NULL"):
        return 1
    if kind == "M":
        return 3 + sum(len(k.encode("utf-8")) + _value_size(v) + 1 for k, v in data.items())
    if kind == "L":
        return 3 + sum(_value_size(v) + 1 for v in data)
    return sum(len(str(v)) for v in data)


# ---------------------------------------------------------------- tokens and paths

class Tokens:
    def __init__(self, text, names, values, used):
        self.items = []
        self.pos = 0
        self.names = names or {}
        self.values = values or {}
        self.used = used
        position = 0
        text = text or ""
        while position < len(text):
            if text[position:].strip() == "":
                break
            match = _TOKEN.match(text, position)
            if not match:
                raise invalid(f'Invalid expression: Syntax error; token: "{text[position:position + 10].strip()}", near: "{text[max(0, position - 10):position + 10].strip()}"')
            kind = match.lastgroup
            value = match.group(kind)
            if kind == "index":
                value = int(value.strip("[] "))
            self.items.append((kind, value))
            position = match.end()

    def peek(self, offset=0):
        index = self.pos + offset
        return self.items[index] if index < len(self.items) else (None, None)

    def take(self):
        token = self.peek()
        self.pos += 1
        return token

    def word(self, text):
        kind, value = self.peek()
        return kind == "word" and value.upper() == text

    def expect(self, text):
        kind, value = self.take()
        if value != text and not (kind == "word" and str(value).upper() == text):
            raise invalid(f'Invalid expression: Syntax error; token: "{value}", expected "{text}"')

    def done(self):
        return self.pos >= len(self.items)

    def name(self, token):
        if token.startswith("#"):
            if token not in self.names:
                raise invalid(f"An expression attribute name used in the document path is not defined; attribute name: {token}")
            self.used["names"].add(token)
            return self.names[token]
        if token.upper() in KEYWORDS or token.lower() in RESERVED:
            raise invalid(f"Invalid expression: Attribute name is a reserved keyword; reserved keyword: {token}")
        return token

    def value(self, token):
        if token not in self.values:
            raise invalid(f"An expression attribute value used in expression is not defined; attribute value: {token}")
        self.used["values"].add(token)
        return canonical(self.values[token])


# A small part of DynamoDB's reserved words: the ones apps hit most often without '#' placeholders.
RESERVED = {"name", "status", "date", "data", "count", "size", "type", "user", "value", "values", "time", "timestamp",
            "year", "month", "day", "hour", "minute", "second", "key", "keys", "order", "comment", "level", "location",
            "role", "state", "table", "source", "group", "items", "item", "list", "map", "number", "string", "zone",
            "action", "region", "connection", "condition", "end", "start", "from", "to", "by", "at", "all", "any",
            "first", "last", "limit", "path", "percent", "range", "replace", "result", "return", "select",
            "session", "set", "sort", "total", "update", "view", "with", "owner", "hash", "index", "language"}


def parse_path(tokens):
    kind, value = tokens.take()
    if kind not in ("name", "word"):
        raise invalid(f'Invalid expression: Syntax error; token: "{value}", near a document path')
    path = [tokens.name(value)]
    while True:
        kind, value = tokens.peek()
        if kind == "op" and value == ".":
            tokens.take()
            kind, value = tokens.take()
            if kind not in ("name", "word"):
                raise invalid("Invalid expression: Syntax error in document path")
            path.append(tokens.name(value))
        elif kind == "index":
            tokens.take()
            path.append(value)
        else:
            return path


def resolve(item, path):
    if not path or path[0] not in item:
        return None
    value = item[path[0]]
    for step in path[1:]:
        kind = kind_of(value)
        if isinstance(step, int):
            if kind != "L" or step >= len(value["L"]):
                return None
            value = value["L"][step]
        else:
            if kind != "M" or step not in value["M"]:
                return None
            value = value["M"][step]
    return value


def path_text(path):
    text = ""
    for step in path:
        text += f"[{step}]" if isinstance(step, int) else (("." if text else "") + step)
    return text


# ---------------------------------------------------------------- conditions

class Condition:
    """Parses a ConditionExpression, FilterExpression or KeyConditionExpression into a callable tree."""

    def __init__(self, text, names, values, used):
        self.tokens = Tokens(text, names, values, used)
        self.tree = self.parse_or()
        if not self.tokens.done():
            raise invalid(f'Invalid expression: Syntax error; token: "{self.tokens.peek()[1]}"')

    def parse_or(self):
        node = self.parse_and()
        while self.tokens.word("OR"):
            self.tokens.take()
            node = ("or", node, self.parse_and())
        return node

    def parse_and(self):
        node = self.parse_not()
        while self.tokens.word("AND"):
            self.tokens.take()
            node = ("and", node, self.parse_not())
        return node

    def parse_not(self):
        if self.tokens.word("NOT"):
            self.tokens.take()
            return ("not", self.parse_not())
        return self.parse_comparison()

    def parse_comparison(self):
        kind, value = self.tokens.peek()
        if kind == "op" and value == "(":
            # A parenthesis opens a nested condition unless it belongs to an operand.
            self.tokens.take()
            node = self.parse_or()
            self.tokens.expect(")")
            return node
        if kind == "word" and value in ("attribute_exists", "attribute_not_exists", "attribute_type", "begins_with", "contains"):
            return self.parse_function()
        left = self.parse_operand()
        kind, value = self.tokens.peek()
        if kind == "op" and value in ("=", "<>", "<", "<=", ">", ">="):
            self.tokens.take()
            return ("cmp", value, left, self.parse_operand())
        if self.tokens.word("BETWEEN"):
            self.tokens.take()
            low = self.parse_operand()
            self.tokens.expect("AND")
            return ("between", left, low, self.parse_operand())
        if self.tokens.word("IN"):
            self.tokens.take()
            self.tokens.expect("(")
            options = [self.parse_operand()]
            while self.tokens.peek() == ("op", ","):
                self.tokens.take()
                options.append(self.parse_operand())
            self.tokens.expect(")")
            return ("in", left, options)
        raise invalid(f'Invalid ConditionExpression: Syntax error; token: "{value}"')

    def parse_function(self):
        _, name = self.tokens.take()
        self.tokens.expect("(")
        path = parse_path(self.tokens)
        argument = None
        if name in ("attribute_type", "begins_with", "contains"):
            self.tokens.expect(",")
            argument = self.parse_operand()
        self.tokens.expect(")")
        return ("fn", name, path, argument)

    def parse_operand(self):
        kind, value = self.tokens.peek()
        if kind == "value":
            self.tokens.take()
            return ("value", self.tokens.value(value))
        if kind == "word" and value == "size" and self.tokens.peek(1) == ("op", "("):
            self.tokens.take()
            self.tokens.expect("(")
            path = parse_path(self.tokens)
            self.tokens.expect(")")
            return ("size", path)
        return ("path", parse_path(self.tokens))

    # -------------------------------------------------------- evaluation
    def __call__(self, item):
        return evaluate(self.tree, item)


def operand(node, item):
    if node[0] == "value":
        return node[1]
    if node[0] == "size":
        value = resolve(item, node[1])
        return None if value is None else {"N": str(size_of(value))}
    return resolve(item, node[1])


def evaluate(node, item):
    kind = node[0]
    if kind == "or":
        return evaluate(node[1], item) or evaluate(node[2], item)
    if kind == "and":
        return evaluate(node[1], item) and evaluate(node[2], item)
    if kind == "not":
        return not evaluate(node[1], item)
    if kind == "cmp":
        return compare(operand(node[2], item), node[1], operand(node[3], item))
    if kind == "between":
        value, low, high = (operand(n, item) for n in node[1:])
        return compare(value, ">=", low) and compare(value, "<=", high)
    if kind == "in":
        value = operand(node[1], item)
        return any(equal(value, operand(option, item)) for option in node[2])
    if kind == "fn":
        _, name, path, argument = node
        value = resolve(item, path)
        if name == "attribute_exists":
            return value is not None
        if name == "attribute_not_exists":
            return value is None
        other = operand(argument, item)
        if value is None or other is None:
            return False
        if name == "attribute_type":
            return kind_of(value) == other.get("S")
        if name == "begins_with":
            vk, ok = kind_of(value), kind_of(other)
            if vk != ok or vk not in ("S", "B"):
                return False
            return comparable(value).startswith(comparable(other))
        if name == "contains":
            vk, ok = kind_of(value), kind_of(other)
            if vk == "S" and ok == "S":
                return other["S"] in value["S"]
            if vk == "B" and ok == "B":
                return comparable(other) in comparable(value)
            if vk in ("SS", "NS", "BS") and ok == vk[0]:
                return any(equal({ok: element}, other) for element in value[vk])
            if vk == "L":
                return any(equal(element, other) for element in value["L"])
            return False
    raise invalid("Invalid expression")


def key_condition(text, names, values, used, hash_key, range_key):
    """Splits a KeyConditionExpression into the partition value and a sort-key test, checking DynamoDB's rules."""
    condition = Condition(text, names, values, used)
    parts = []

    def collect(node):
        if node[0] == "and":
            collect(node[1])
            collect(node[2])
        else:
            parts.append(node)

    collect(condition.tree)
    hash_value = None
    range_test = None
    for node in parts:
        part = _key_part(node)
        if part is None:
            raise invalid("Invalid operator used in KeyConditionExpression: " + str(node[0]).upper())
        attribute, op, value = part
        if attribute == [hash_key] and hash_value is None:
            if op != "=":
                raise invalid("Query key condition not supported")
            hash_value = value
        elif range_key and attribute == [range_key] and range_test is None:
            if op == "<>":
                raise invalid("Unsupported operator in KeyConditionExpression: <>")
            range_test = node
        elif hash_value is None and attribute != [hash_key]:
            raise invalid(f"Query condition missed key schema element: {hash_key}")
        else:
            raise invalid("Query key condition not supported")
    if hash_value is None:
        raise invalid(f"Query condition missed key schema element: {hash_key}")
    return hash_value, (lambda item: True) if range_test is None else (lambda item: evaluate(range_test, item))


def _key_part(node):
    """(attribute path, operator, value) of one key condition, whatever side the attribute is written on."""
    if node[0] == "cmp":
        left, right = node[2], node[3]
        if left[0] == "path" and right[0] == "value":
            return left[1], node[1], right[1]
        if right[0] == "path" and left[0] == "value":
            return right[1], node[1], left[1]
        return None
    if node[0] == "between" and node[1][0] == "path":
        return node[1][1], "between", None
    if node[0] == "fn" and node[1] == "begins_with":
        return node[2], "begins_with", None
    return None


# ---------------------------------------------------------------- updates

class Update:
    """Parses an UpdateExpression; apply() returns the new item (the old one is left untouched)."""

    def __init__(self, text, names, values, used):
        self.tokens = Tokens(text, names, values, used)
        self.actions = []
        seen = set()
        while not self.tokens.done():
            kind, word = self.tokens.take()
            clause = str(word).upper()
            if kind != "word" or clause not in ("SET", "REMOVE", "ADD", "DELETE"):
                raise invalid(f'Invalid UpdateExpression: Syntax error; token: "{word}"')
            if clause in seen:
                raise invalid(f'Invalid UpdateExpression: The "{clause}" section can only be used once in an update expression;')
            seen.add(clause)
            while True:
                path = parse_path(self.tokens)
                if clause == "SET":
                    self.tokens.expect("=")
                    self.actions.append(("SET", path, self.parse_value()))
                elif clause == "REMOVE":
                    self.actions.append(("REMOVE", path, None))
                else:
                    kind, token = self.tokens.take()
                    if kind != "value":
                        raise invalid(f"Invalid UpdateExpression: Syntax error; {clause} needs a value")
                    self.actions.append((clause, path, self.tokens.value(token)))
                if self.tokens.peek() == ("op", ","):
                    self.tokens.take()
                    continue
                break
        paths = [path_text(action[1]) for action in self.actions]
        for index, first in enumerate(paths):
            for second in paths[index + 1:]:
                if first == second or second.startswith(first + ".") or second.startswith(first + "[") or first.startswith(second + ".") or first.startswith(second + "["):
                    raise invalid(f"Invalid UpdateExpression: Two document paths overlap with each other; must remove or rewrite one of these paths; path one: [{first}], path two: [{second}]")

    def parse_value(self):
        left = self.parse_term()
        kind, value = self.tokens.peek()
        if kind == "op" and value in ("+", "-"):
            self.tokens.take()
            return ("arith", value, left, self.parse_term())
        return left

    def parse_term(self):
        kind, value = self.tokens.peek()
        if kind == "value":
            self.tokens.take()
            return ("value", self.tokens.value(value))
        if kind == "word" and value in ("if_not_exists", "list_append") and self.tokens.peek(1) == ("op", "("):
            self.tokens.take()
            self.tokens.expect("(")
            if value == "if_not_exists":
                path = parse_path(self.tokens)
                self.tokens.expect(",")
                other = self.parse_term()
                self.tokens.expect(")")
                return ("if_not_exists", path, other)
            first = self.parse_term()
            self.tokens.expect(",")
            second = self.parse_term()
            self.tokens.expect(")")
            return ("list_append", first, second)
        return ("path", parse_path(self.tokens))

    def value(self, node, item):
        kind = node[0]
        if kind == "value":
            return node[1]
        if kind == "path":
            value = resolve(item, node[1])
            if value is None:
                raise invalid("The provided expression refers to an attribute that does not exist in the item")
            return value
        if kind == "if_not_exists":
            value = resolve(item, node[1])
            return value if value is not None else self.value(node[2], item)
        if kind == "list_append":
            first, second = self.value(node[1], item), self.value(node[2], item)
            if kind_of(first) != "L" or kind_of(second) != "L":
                raise invalid("An operand in the update expression has an incorrect data type")
            return {"L": copy.deepcopy(first["L"]) + copy.deepcopy(second["L"])}
        if kind == "arith":
            first, second = self.value(node[2], item), self.value(node[3], item)
            if kind_of(first) != "N" or kind_of(second) != "N":
                raise invalid("An operand in the update expression has an incorrect data type")
            result = number(first["N"]) + number(second["N"]) if node[1] == "+" else number(first["N"]) - number(second["N"])
            return {"N": number_text(result)}
        raise invalid("Invalid UpdateExpression")

    def apply(self, item):
        new = copy.deepcopy(item)
        changed = []
        for clause, path, node in self.actions:
            if clause == "SET":
                value = copy.deepcopy(self.value(node, item))
                _set(new, path, value)
            elif clause == "REMOVE":
                _remove(new, path)
            elif clause == "ADD":
                current = resolve(new, path)
                kind = kind_of(node)
                if kind == "N":
                    if current is not None and kind_of(current) != "N":
                        raise invalid("An operand in the update expression has an incorrect data type")
                    total = number(node["N"]) + (number(current["N"]) if current is not None else 0)
                    _set(new, path, {"N": number_text(total)})
                elif kind in ("SS", "NS", "BS"):
                    if current is not None and kind_of(current) != kind:
                        raise invalid("An operand in the update expression has an incorrect data type")
                    merged = list(current[kind]) if current else []
                    for element in node[kind]:
                        if element not in merged:
                            merged.append(element)
                    _set(new, path, {kind: merged})
                else:
                    raise invalid("Incorrect operand type for operator or function; operator: ADD, operand type: " + str(kind))
            elif clause == "DELETE":
                current = resolve(new, path)
                kind = kind_of(node)
                if kind not in ("SS", "NS", "BS"):
                    raise invalid("Incorrect operand type for operator or function; operator: DELETE, operand type: " + str(kind))
                if current is not None:
                    if kind_of(current) != kind:
                        raise invalid("An operand in the update expression has an incorrect data type")
                    remaining = [element for element in current[kind] if element not in node[kind]]
                    if remaining:
                        _set(new, path, {kind: remaining})
                    else:
                        _remove(new, path)
            changed.append(path[0])
        return new, changed


def _parent(item, path):
    if len(path) == 1:
        return item, path[0]
    node = resolve(item, path[:-1])
    if node is None:
        raise invalid("The document path provided in the update expression is invalid for update")
    step = path[-1]
    kind = kind_of(node)
    if isinstance(step, int) and kind == "L":
        return node["L"], step
    if not isinstance(step, int) and kind == "M":
        return node["M"], step
    raise invalid("The document path provided in the update expression is invalid for update")


def _set(item, path, value):
    container, step = _parent(item, path)
    if isinstance(container, list):
        if step >= len(container):
            container.append(value)
        else:
            container[step] = value
    else:
        container[step] = value


def _remove(item, path):
    try:
        container, step = _parent(item, path)
    except AwsError:
        return
    if isinstance(container, list):
        if step < len(container):
            container.pop(step)
    else:
        container.pop(step, None)


# ---------------------------------------------------------------- projections

def projection(text, names, used):
    if not text:
        return None
    tokens = Tokens(text, names, {}, used)
    paths = [parse_path(tokens)]
    while tokens.peek() == ("op", ","):
        tokens.take()
        paths.append(parse_path(tokens))
    if not tokens.done():
        raise invalid("Invalid ProjectionExpression: Syntax error")
    return paths


def project(item, paths):
    if not paths:
        return item
    result = {}
    for path in paths:
        value = resolve(item, path)
        if value is None:
            continue
        if len(path) == 1:
            result[path[0]] = copy.deepcopy(value)
            continue
        # Nested projections keep the structure that leads to the value (lists shrink to the chosen elements).
        node = result
        source = item
        for depth, step in enumerate(path):
            last = depth == len(path) - 1
            if depth == 0:
                source = item[step]
                kind = kind_of(source)
                node = result.setdefault(step, {kind: {} if kind == "M" else []})
                continue
            kind = kind_of(source)
            if kind == "M":
                source = source["M"][step]
                child_kind = kind_of(source)
                if last:
                    node["M"][step] = copy.deepcopy(source)
                else:
                    node = node["M"].setdefault(step, {child_kind: {} if child_kind == "M" else []})
            else:
                source = source["L"][step]
                child_kind = kind_of(source)
                if last:
                    node["L"].append(copy.deepcopy(source))
                else:
                    child = {child_kind: {} if child_kind == "M" else []}
                    node["L"].append(child)
                    node = child
    return result


def check_unused(names, values, used):
    unused_names = set(names or {}) - used["names"]
    if unused_names:
        raise invalid(f"Value provided in ExpressionAttributeNames unused in expressions: keys: {{{', '.join(sorted(unused_names))}}}")
    unused_values = set(values or {}) - used["values"]
    if unused_values:
        raise invalid(f"Value provided in ExpressionAttributeValues unused in expressions: keys: {{{', '.join(sorted(unused_values))}}}")
