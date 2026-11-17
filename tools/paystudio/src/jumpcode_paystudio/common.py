# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Shared helpers for the tool side: errors, the host folders, Studio files and the project's .env.local."""

import json
import os
from pathlib import Path
import re
import stat
import tempfile
import time

_LINK_TAGS = {0xA000000C, 0xA0000003}
_ENV_LINE = re.compile(r"^\s*(?:export\s+)?(?P<key>[A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(?P<value>.*?)\s*$")


class PayStudioError(ValueError):
    """The request could not be done; the message tells the model what to do instead."""


def _is_link(path):
    try:
        info = os.lstat(path)
    except OSError:
        return True
    return stat.S_ISLNK(info.st_mode) or getattr(info, "st_reparse_tag", 0) in _LINK_TAGS


def studio_root(context):
    value = context.get("studio_root") if isinstance(context, dict) else None
    if not isinstance(value, str) or not value:
        raise PayStudioError("PayStudio only works inside an open Studio")
    root = Path(value)
    if not root.is_absolute() or root.parent == root or _is_link(root) or not root.is_dir():
        raise PayStudioError("The Studio folder is unavailable")
    return root


def source_root(context, required=False):
    value = context.get("source_root") if isinstance(context, dict) else None
    if isinstance(value, str) and value.strip():
        root = Path(value)
        if root.is_absolute() and root.is_dir() and not _is_link(root):
            return root
    if required:
        raise PayStudioError("This needs the project's files. Tell the user to open PayStudio from a project (the chat of a project), then try again.")
    return None


def merge_env_file(path, values, header):
    """Sets KEY=VALUE lines in .env.local. A line PayStudio replaces is kept commented out, so the user's own value is never lost."""
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines() if path.exists() else []
    remaining = dict(values)
    replaced = []
    result = []
    for line in lines:
        match = _ENV_LINE.match(line)
        key = match.group("key") if match else None
        if key in values and not line.lstrip().startswith("#"):
            if match.group("value").strip("\"'") != values[key]:
                result.append(f"# (antes do PayStudio) {line.strip()}")
                if key not in replaced:
                    replaced.append(key)
            if key in remaining:
                result.append(f"{key}={remaining.pop(key)}")
        else:
            result.append(line)
    if remaining:
        if result and result[-1].strip():
            result.append("")
        result.append(header)
        result += [f"{key}={value}" for key, value in remaining.items()]
    write_text(path, "\n".join(result) + "\n")
    return replaced


def write_text(path, text):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix=".paystudio-", dir=path.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(text)
        for attempt in range(40):
            try:
                os.replace(temporary, path)
                return
            except PermissionError:
                if attempt == 39:
                    raise
                time.sleep(0.025)
    finally:
        if os.path.exists(temporary):
            os.remove(temporary)


def read_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as stream:
            return json.load(stream)
    except (OSError, ValueError):
        return default


def write_json(path, value):
    write_text(path, json.dumps(value, ensure_ascii=False, separators=(",", ":")))
