# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""A small, tolerant YAML reader for compose, Kubernetes, pubspec and serverless files.

It understands block mappings and sequences, quoted and plain scalars, simple
flow collections, comments, block scalars and multiple documents. Anchors,
tags and complex keys are read as plain text. It never raises on bad input.
"""

import re

_KEY = re.compile(r"""^(?P<key>"[^"]*"|'[^']*'|[^\s#'"\-\[\]{}][^:#]*?|-[^\s:#][^:#]*?)\s*:(?:\s+(?P<rest>.*))?$""")
MAX_LINES = 20_000


def _strip_comment(text):
    quote = None
    for index, char in enumerate(text):
        if quote:
            if char == quote:
                quote = None
        elif char in "\"'" and (index == 0 or text[index - 1] in " \t:[{,-"):
            quote = char
        elif char == "#" and (index == 0 or text[index - 1] in " \t"):
            return text[:index].rstrip()
    return text.rstrip()


def _split_flow(text):
    parts, depth, quote, current = [], 0, None, ""
    for char in text:
        if quote:
            current += char
            if char == quote:
                quote = None
            continue
        if char in "\"'":
            quote = char
        elif char in "[{":
            depth += 1
        elif char in "]}":
            depth -= 1
        elif char == "," and depth == 0:
            parts.append(current.strip())
            current = ""
            continue
        current += char
    if current.strip():
        parts.append(current.strip())
    return parts


def scalar(text):
    text = text.strip()
    if text.startswith(("&", "!")) and " " in text:
        text = text.split(" ", 1)[1].strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "\"'":
        return text[1:-1]
    if text.startswith("[") and text.endswith("]"):
        return [scalar(part) for part in _split_flow(text[1:-1])]
    if text.startswith("{") and text.endswith("}"):
        result = {}
        for part in _split_flow(text[1:-1]):
            key, _, value = part.partition(":")
            result[scalar(key)] = scalar(value) if value.strip() else None
        return result
    lowered = text.lower()
    if lowered in ("", "~", "null"):
        return None
    if lowered in ("true", "yes", "on"):
        return True
    if lowered in ("false", "no", "off"):
        return False
    if re.fullmatch(r"-?\d{1,18}", text):
        return int(text)
    return text


class _Reader:
    def __init__(self, lines):
        self.lines = lines
        self.index = 0

    def block(self, indent):
        if self.index >= len(self.lines):
            return None
        line_indent, text = self.lines[self.index]
        if line_indent < indent:
            return None
        if text == "-" or text.startswith("- "):
            return self.sequence(line_indent)
        return self.mapping(line_indent)

    def _block_scalar(self, indent):
        parts = []
        while self.index < len(self.lines) and self.lines[self.index][0] > indent:
            parts.append(self.lines[self.index][1])
            self.index += 1
        return "\n".join(parts)

    def _value(self, rest, indent):
        if rest is None or rest == "":
            if self.index < len(self.lines):
                next_indent, next_text = self.lines[self.index]
                if next_indent > indent:
                    return self.block(next_indent)
                if next_indent == indent and (next_text == "-" or next_text.startswith("- ")):
                    return self.sequence(indent)
            return None
        if rest[0] in "|>":
            return self._block_scalar(indent)
        return scalar(rest)

    def sequence(self, indent):
        items = []
        while self.index < len(self.lines):
            line_indent, text = self.lines[self.index]
            if line_indent != indent or not (text == "-" or text.startswith("- ")):
                break
            rest = text[1:].lstrip()
            offset = indent + len(text) - len(rest)
            self.index += 1
            if not rest:
                items.append(self._value(None, indent))
            elif _KEY.match(rest):
                # "- key: value" starts a mapping whose keys align with "key".
                self.index -= 1
                self.lines[self.index] = (offset, rest)
                items.append(self.mapping(offset))
            else:
                items.append(self._value(rest, indent))
        return items

    def mapping(self, indent):
        result = {}
        while self.index < len(self.lines):
            line_indent, text = self.lines[self.index]
            if line_indent < indent:
                break
            if line_indent > indent:
                self.index += 1
                continue
            if text == "-" or text.startswith("- "):
                break
            match = _KEY.match(text)
            self.index += 1
            if not match:
                continue
            key = scalar(match.group("key"))
            result[key if isinstance(key, str) else str(key)] = self._value(match.group("rest"), indent)
        return result


def _documents(text):
    current = []
    for raw in text.splitlines()[:MAX_LINES]:
        if raw.startswith("---") or raw.startswith("..."):
            yield current
            current = []
            remainder = raw[3:].strip()
            if remainder and not remainder.startswith("#"):
                current.append(remainder)
            continue
        current.append(raw)
    yield current


def load_all(text):
    """Return every document of a YAML text as plain Python values."""
    documents = []
    for raw_lines in _documents(text or ""):
        lines = []
        block_indent = None
        for raw in raw_lines:
            expanded = raw.replace("\t", "  ")
            stripped = expanded.strip()
            indent = len(expanded) - len(expanded.lstrip(" "))
            if block_indent is not None:
                if not stripped or indent > block_indent:
                    lines.append((indent, stripped))
                    continue
                block_indent = None
            if not stripped or stripped.startswith("#") or stripped.startswith("%"):
                continue
            content = _strip_comment(stripped)
            if not content:
                continue
            lines.append((indent, content))
            if re.search(r"(?::|^-)\s*[|>][-+0-9]*$", content):
                block_indent = indent
        if lines:
            try:
                documents.append(_Reader(lines).block(lines[0][0]))
            except (RecursionError, IndexError, ValueError):
                documents.append(None)
    return [document for document in documents if document is not None]


def load(text):
    documents = load_all(text)
    return documents[0] if documents else None
