# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Where a model came from, kept inside the GLB itself (``asset.extras.jumpcode``): the source image, the options and a
hash of the binary data. Any Studio of the project can then make the model again, and tell whether the file is still
exactly what the tool wrote (so replacing it loses nothing) or was changed since."""

import hashlib
import json
from pathlib import Path
import struct

MAGIC = b"glTF"
JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942
TOOL = "generator3d"


def _split(data):
    if len(data) < 20 or data[:4] != MAGIC:
        raise ValueError("not a GLB file")
    length, kind = struct.unpack_from("<II", data, 12)
    if kind != JSON_CHUNK or 20 + length > len(data):
        raise ValueError("the GLB has no JSON chunk first")
    document = json.loads(data[20:20 + length].decode("utf-8"))
    rest = data[20 + length:]
    binary = b""
    if len(rest) >= 8:
        bin_length, bin_kind = struct.unpack_from("<II", rest, 0)
        if bin_kind == BIN_CHUNK:
            binary = rest[8:8 + bin_length]
    return document, binary


def stamp(path, info):
    """Writes ``info`` and the hash of the binary chunk into the GLB at ``path`` (rewritten in place)."""
    path = Path(path)
    document, binary = _split(path.read_bytes())
    asset = document.setdefault("asset", {"version": "2.0"})
    extras = asset.setdefault("extras", {})
    extras["jumpcode"] = {"tool": TOOL, **info, "bin": hashlib.sha256(binary).hexdigest()}
    text = json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    text += b" " * (-len(text) % 4)
    chunks = struct.pack("<II", len(text), JSON_CHUNK) + text
    if binary:
        padded = binary + b"\x00" * (-len(binary) % 4)
        chunks += struct.pack("<II", len(padded), BIN_CHUNK) + padded
    path.write_bytes(MAGIC + struct.pack("<II", 2, 12 + len(chunks)) + chunks)


def read(path):
    """(info, pristine): what the tool recorded in the file (or None) and whether its binary data is unchanged."""
    try:
        document, binary = _split(Path(path).read_bytes())
    except (OSError, ValueError, UnicodeError):
        return None, False
    info = ((document.get("asset") or {}).get("extras") or {}).get("jumpcode")
    if not isinstance(info, dict) or info.get("tool") != TOOL:
        return None, False
    return info, info.get("bin") == hashlib.sha256(binary).hexdigest()
