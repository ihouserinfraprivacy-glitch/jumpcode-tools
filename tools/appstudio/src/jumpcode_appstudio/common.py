# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Shared helpers for AppStudio: errors, the host folders, paths inside the project and atomic files."""

import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import tempfile
import time
import unicodedata

_LINK_TAGS = {0xA000000C, 0xA0000003}
ID = re.compile(r"[a-z][a-z0-9-]{0,39}")


class AppStudioError(ValueError):
    """The request could not be done; the message tells the model what to do instead."""


def _is_link(path):
    try:
        info = os.lstat(path)
    except OSError:
        return False
    return stat.S_ISLNK(info.st_mode) or getattr(info, "st_reparse_tag", 0) in _LINK_TAGS


def studio_root(context):
    value = context.get("studio_root") if isinstance(context, dict) else None
    if not isinstance(value, str) or not value:
        raise AppStudioError("AppStudio only works inside an open Studio")
    root = Path(value)
    if not root.is_absolute() or root.parent == root or _is_link(root) or not root.is_dir():
        raise AppStudioError("The Studio folder is unavailable")
    return root


def source_root(context, required=False):
    value = context.get("source_root") if isinstance(context, dict) else None
    if isinstance(value, str) and value.strip():
        root = Path(value)
        if root.is_absolute() and root.is_dir() and not _is_link(root):
            return root
    if required:
        raise AppStudioError("AppStudio keeps the app in the project's folder. Tell the user to open AppStudio from a project's chat, then try again.")
    return None


def project_folder(root, relative):
    """A folder inside the project named by a relative path; never outside it, never through a link."""
    text = str(relative or "").strip().strip("/\\").replace("\\", "/")
    pure = PurePosixPath(text)
    if not text or pure.is_absolute() or ":" in pure.parts[0] or any(part in ("..", "", ".") for part in pure.parts):
        raise AppStudioError("The app folder must be a relative path inside the project, such as app.")
    target = Path(root)
    for part in pure.parts:
        target = target / part
        if _is_link(target):
            raise AppStudioError(f"{text} goes through a link; AppStudio only writes inside the project.")
    if target.exists() and not target.is_dir():
        raise AppStudioError(f"{text} exists and is not a folder.")
    if not target.resolve().is_relative_to(Path(root).resolve()):
        raise AppStudioError(f"{text} is outside the project.")
    return target


def check_id(value, what):
    text = str(value or "").strip().lower()
    if not ID.fullmatch(text):
        raise AppStudioError(f"{what} must be a short id with lowercase letters, digits and hyphens (such as inicio or proximo-horario), not {value!r}.")
    return text


def slug(text, fallback="app"):
    plain = unicodedata.normalize("NFKD", str(text)).encode("ascii", "ignore").decode("ascii").lower()
    plain = re.sub(r"[^a-z0-9]+", "-", plain).strip("-")
    plain = plain[:40].strip("-")
    return plain if plain and plain[0].isalpha() else (fallback + "-" + plain if plain else fallback)


def write_text(path, text):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix=".appstudio-", dir=path.parent)
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


def write_json(path, value, pretty=False):
    write_text(path, json.dumps(value, ensure_ascii=False, indent=1 if pretty else None, separators=None if pretty else (",", ":")))
