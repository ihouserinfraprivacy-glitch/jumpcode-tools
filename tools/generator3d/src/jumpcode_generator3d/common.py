# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Shared helpers for the 3D Generator: errors, the host folders, paths inside the project, image headers and
atomic Studio files."""

import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import struct
import tempfile
import time
import unicodedata

_LINK_TAGS = {0xA000000C, 0xA0000003}
IMAGE_EXTENSIONS = (".png", ".jpg", ".jpeg", ".webp", ".bmp")
SKIP_FOLDERS = {".git", "node_modules", ".venv", "venv", "__pycache__", ".next", "dist", "build", "out", ".cache", ".idea", ".vscode"}
MAX_IMAGE_BYTES = 40_000_000


class GeneratorError(ValueError):
    """The request could not be done; the message tells the model what to do instead."""


class Cancelled(GeneratorError):
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
        raise GeneratorError("The 3D Generator only works inside an open Studio")
    root = Path(value)
    if not root.is_absolute() or root.parent == root or _is_link(root) or not root.is_dir():
        raise GeneratorError("The Studio folder is unavailable")
    return root


def source_root(context, required=False):
    value = context.get("source_root") if isinstance(context, dict) else None
    if isinstance(value, str) and value.strip():
        root = Path(value)
        if root.is_absolute() and root.is_dir() and not _is_link(root):
            return root
    if required:
        raise GeneratorError("This needs the project's files. Tell the user to open the 3D Generator from a project's chat, then try again.")
    return None


def clean_relative(relative, what="file"):
    text = str(relative or "").strip().strip('"').strip("'").replace("\\", "/")
    while text.startswith("./"):
        text = text[2:]
    if not text:
        raise GeneratorError(f"Give the {what}'s path inside the project, such as arte/personagem.png (call images to list them).")
    pure = PurePosixPath(text)
    if pure.is_absolute() or ":" in pure.parts[0] or any(part in ("..", "") for part in pure.parts):
        raise GeneratorError("The path must be relative to the project, without .. (call images to list the project's images).")
    return pure


def project_path(root, relative, what="file"):
    """A path inside the project named by a relative path; never outside it, never through a link."""
    pure = clean_relative(relative, what)
    target = Path(root)
    for part in pure.parts:
        target = target / part
        if target.exists() and _is_link(target):
            raise GeneratorError(f"{pure.as_posix()} goes through a link; the 3D Generator only uses files inside the project.")
    resolved = target.resolve()
    if not resolved.is_relative_to(Path(root).resolve()):
        raise GeneratorError(f"{pure.as_posix()} is outside the project.")
    return target


def relative_name(root, path):
    return Path(path).resolve().relative_to(Path(root).resolve()).as_posix()


def image_size(path):
    """(width, height) read from the PNG, JPEG, WebP or BMP header, or None."""
    try:
        with open(path, "rb") as stream:
            head = stream.read(32)
            if head.startswith(b"\x89PNG\r\n\x1a\n") and head[12:16] == b"IHDR":
                return struct.unpack(">II", head[16:24])
            if head[:2] == b"BM" and len(head) >= 26:
                width, height = struct.unpack("<ii", head[18:26])
                return abs(width), abs(height)
            if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
                kind = head[12:16]
                if kind == b"VP8X":
                    return 1 + int.from_bytes(head[24:27], "little"), 1 + int.from_bytes(head[27:30], "little")
                stream.seek(0)
                data = stream.read(40)
                if kind == b"VP8 " and len(data) >= 30:
                    return struct.unpack("<HH", data[26:30])[0] & 0x3FFF, struct.unpack("<HH", data[26:30])[1] & 0x3FFF
                if kind == b"VP8L" and len(data) >= 25:
                    bits = int.from_bytes(data[21:25], "little")
                    return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
                return None
            if head[:2] == b"\xff\xd8":
                stream.seek(2)
                while True:
                    marker = stream.read(2)
                    if len(marker) < 2 or marker[0] != 0xFF:
                        return None
                    while marker[1] == 0xFF:
                        marker = marker[:1] + stream.read(1)
                    if marker[1] in (0xD8, 0x01) or 0xD0 <= marker[1] <= 0xD7:
                        continue
                    length = struct.unpack(">H", stream.read(2))[0]
                    if 0xC0 <= marker[1] <= 0xCF and marker[1] not in (0xC4, 0xC8, 0xCC):
                        data = stream.read(5)
                        height, width = struct.unpack(">HH", data[1:5])
                        return width, height
                    stream.seek(length - 2, 1)
    except (OSError, struct.error):
        return None
    return None


def find_images(root, limit=200):
    """Images in the project (PNG, JPEG, WebP, BMP), skipping tool and dependency folders and the models folder's
    own previews. Returns (images, more)."""
    found, more = [], 0
    root = Path(root)
    for folder, folders, files in os.walk(root):
        folders[:] = sorted(f for f in folders if f not in SKIP_FOLDERS and not f.startswith(".") and not _is_link(Path(folder) / f))
        for name in sorted(files):
            if not name.lower().endswith(IMAGE_EXTENSIONS) or name.startswith("."):
                continue
            path = Path(folder) / name
            try:
                info = path.stat()
            except OSError:
                continue
            if info.st_size > MAX_IMAGE_BYTES or info.st_size < 64:
                continue
            size = image_size(path)
            if size is None or min(size) < 64:
                continue
            if len(found) >= limit:
                more += 1
                continue
            found.append({"path": relative_name(root, path), "bytes": info.st_size, "width": size[0], "height": size[1],
                          "modified": info.st_mtime})
    return found, more


def write_text(path, text, encoding="utf-8"):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix=".generator3d-", dir=path.parent)
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


def slug(text, fallback="modelo"):
    plain = unicodedata.normalize("NFKD", str(text)).encode("ascii", "ignore").decode("ascii").lower()
    plain = re.sub(r"[^a-z0-9]+", "-", plain).strip("-")
    return plain[:60] or fallback


def seconds_text(value):
    """15.1 -> '15,1 s' for messages the user may read."""
    return f"{value:.1f}".replace(".", ",") + " s"


def size_text(value):
    if value >= 1_000_000:
        return f"{value / 1_000_000:.2f}".replace(".", ",") + " MB"
    return f"{max(1, round(value / 1000))} KB"
