# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Shared helpers for SheetStudio: errors, the host folders, paths inside the project and atomic Studio files."""

import json
import os
from pathlib import Path, PurePosixPath
import stat
import tempfile
import time

_LINK_TAGS = {0xA000000C, 0xA0000003}
SHEET_EXTENSIONS = (".csv", ".tsv", ".txt", ".xlsx", ".xlsm", ".xls", ".ods")
SKIP_FOLDERS = {".git", "node_modules", ".venv", "venv", "__pycache__", ".next", "dist", "build", "out", ".cache", ".idea", ".vscode"}


class SheetStudioError(ValueError):
    """The request could not be done; the message tells the model what to do instead."""


class Cancelled(SheetStudioError):
    pass


def _is_link(path):
    try:
        info = os.lstat(path)
    except OSError:
        return True
    return stat.S_ISLNK(info.st_mode) or getattr(info, "st_reparse_tag", 0) in _LINK_TAGS


def studio_root(context):
    value = context.get("studio_root") if isinstance(context, dict) else None
    if not isinstance(value, str) or not value:
        raise SheetStudioError("SheetStudio only works inside an open Studio")
    root = Path(value)
    if not root.is_absolute() or root.parent == root or _is_link(root) or not root.is_dir():
        raise SheetStudioError("The Studio folder is unavailable")
    return root


def source_root(context, required=False):
    value = context.get("source_root") if isinstance(context, dict) else None
    if isinstance(value, str) and value.strip():
        root = Path(value)
        if root.is_absolute() and root.is_dir() and not _is_link(root):
            return root
    if required:
        raise SheetStudioError("This needs the project's files. Tell the user to open SheetStudio from a project (the chat of a project), then try again.")
    return None


def project_file(root, relative):
    """A file inside the project named by a relative path; never outside it, never through a link."""
    text = str(relative or "").strip().strip('"').replace("\\", "/")
    if not text:
        raise SheetStudioError("Give the file's path inside the project, such as dados/vendas.xlsx (call files to list them).")
    pure = PurePosixPath(text)
    if pure.is_absolute() or ":" in pure.parts[0] or any(part in ("..", "") for part in pure.parts):
        raise SheetStudioError("The path must be relative to the project, without .. (call files to list the spreadsheets).")
    target = Path(root)
    for part in pure.parts:
        target = target / part
        if _is_link(target) and target.exists():
            raise SheetStudioError(f"{text} goes through a link; SheetStudio only reads files inside the project.")
    resolved = target.resolve()
    if not resolved.is_relative_to(Path(root).resolve()):
        raise SheetStudioError(f"{text} is outside the project.")
    return target


def relative_name(root, path):
    return Path(path).resolve().relative_to(Path(root).resolve()).as_posix()


def find_sheets(root, limit=200):
    """Spreadsheet files in the project (CSV, TSV, TXT, XLSX, XLS, ODS), skipping tool and dependency folders."""
    found = []
    root = Path(root)
    for folder, folders, files in os.walk(root):
        folders[:] = sorted(f for f in folders if f not in SKIP_FOLDERS and not f.startswith(".") and not _is_link(Path(folder) / f))
        for name in sorted(files):
            if name.lower().endswith(SHEET_EXTENSIONS) and not name.startswith("~$"):
                path = Path(folder) / name
                try:
                    info = path.stat()
                except OSError:
                    continue
                if name.lower().endswith(".txt") and info.st_size > 50_000_000:
                    continue
                found.append({"path": relative_name(root, path), "bytes": info.st_size, "modified": info.st_mtime})
                if len(found) >= limit:
                    return found
    return found


def write_text(path, text, encoding="utf-8"):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix=".sheetstudio-", dir=path.parent)
    try:
        with os.fdopen(handle, "w", encoding=encoding, newline="") as stream:
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
    write_text(path, json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str))


def free_name(folder, name):
    """name, or name (2), name (3)... so an export never replaces a file."""
    folder = Path(folder)
    target = folder / name
    stem, suffix = Path(name).stem, Path(name).suffix
    counter = 2
    while target.exists():
        target = folder / f"{stem} ({counter}){suffix}"
        counter += 1
    return target


def slug(text, fallback="planilha"):
    import re
    import unicodedata
    plain = unicodedata.normalize("NFKD", str(text)).encode("ascii", "ignore").decode("ascii").lower()
    plain = re.sub(r"[^a-z0-9]+", "-", plain).strip("-")
    return plain[:60] or fallback
