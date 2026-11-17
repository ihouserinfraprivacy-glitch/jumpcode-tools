# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Shared helpers for the tool side: errors, the host folders, project paths and .env files."""

import json
import os
from pathlib import Path
import re
import stat
import tempfile
import time

_LINK_TAGS = {0xA000000C, 0xA0000003}
_ENV_LINE = re.compile(r"^\s*(?:export\s+)?(?P<key>[A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(?P<value>.*?)\s*$")
ENV_FILES = (".env", ".env.local", ".env.development", ".env.development.local")


class CloudStudioError(ValueError):
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
        raise CloudStudioError("CloudStudio only works inside an open Studio")
    root = Path(value)
    if not root.is_absolute() or root.parent == root or _is_link(root) or not root.is_dir():
        raise CloudStudioError("The Studio folder is unavailable")
    return root


def source_root(context, required=False):
    value = context.get("source_root") if isinstance(context, dict) else None
    if isinstance(value, str) and value.strip():
        root = Path(value)
        if root.is_absolute() and root.is_dir():
            return root
    if required:
        raise CloudStudioError("This needs the project's files. Tell the user to open CloudStudio from a project (the chat of a project), then try again.")
    return None


def project_path(context, relative, must_exist=True):
    """A folder or file inside the project, from a relative POSIX path; never outside it."""
    root = source_root(context, required=True)
    text = str(relative or "").strip().replace("\\", "/").strip("/")
    if not text or text.startswith("..") or "/../" in f"/{text}/" or re.match(r"^[A-Za-z]:", text):
        raise CloudStudioError(f"Give the path relative to the project, like src/agendar (got '{relative}')")
    target = (root / text).resolve()
    if root.resolve() not in target.parents and target != root.resolve():
        raise CloudStudioError(f"{relative} is outside the project")
    if must_exist and not target.exists():
        raise CloudStudioError(f"{relative} does not exist in the project")
    return target


def read_env(context):
    """KEY=VALUE pairs from the project's .env files (later files win), read only to fill local secrets."""
    root = source_root(context)
    values = {}
    if root is None:
        return values
    for name in ENV_FILES:
        path = root / name
        if not path.is_file() or _is_link(path):
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for line in text.splitlines():
            if line.lstrip().startswith("#"):
                continue
            match = _ENV_LINE.match(line)
            if match:
                value = match.group("value")
                if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                    value = value[1:-1]
                elif " #" in value:
                    value = value.split(" #", 1)[0].rstrip()
                values[match.group("key")] = value
    return values


def merge_env_file(path, values, header):
    """Updates KEY=VALUE lines in a .env file, keeping every other line as it was."""
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines() if path.exists() else []
    remaining = dict(values)
    result = []
    for line in lines:
        match = _ENV_LINE.match(line)
        if match and match.group("key") in values:
            if match.group("key") in remaining:
                result.append(f"{match.group('key')}={remaining.pop(match.group('key'))}")
        else:
            result.append(line)
    if remaining:
        if result and result[-1].strip():
            result.append("")
        result.append(header)
        result += [f"{key}={value}" for key, value in remaining.items()]
    write_text(path, "\n".join(result) + "\n")


def write_text(path, text):
    path = Path(path)
    handle, temporary = tempfile.mkstemp(prefix=".cloudstudio-", dir=path.parent)
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
