# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Shared helpers: errors, host folders, atomic Studio files and stable ids."""

from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import time
import unicodedata

MODEL_FILE = "model.json"
PARTIAL_FILE = "model-partial.json"
PREVIOUS_FILE = ".archstudio-previous-model"
PROGRESS_FILE = "progress.json"
VIEW_FILE = "view.json"
PATHS_FILE = "paths.json"
PROPOSAL_FILE = "proposal.json"
STUDIO_FILES = (MODEL_FILE, PARTIAL_FILE, PREVIOUS_FILE, PROGRESS_FILE, VIEW_FILE, PATHS_FILE, PROPOSAL_FILE)
LOCK_FILE = ".archstudio.lock"
MAX_STUDIO_FILE = 48_000_000

# Windows reparse tags of symbolic links and junctions (mount points). Other
# reparse points, such as cloud placeholders, are ordinary files and folders.
_LINK_TAGS = {0xA000000C, 0xA0000003}


class ArchStudioError(ValueError):
    """Invalid request or folder; the Studio files were left as they were."""


def is_link_stat(info):
    return stat.S_ISLNK(info.st_mode) or getattr(info, "st_reparse_tag", 0) in _LINK_TAGS


def is_link(path):
    try:
        return is_link_stat(os.lstat(path))
    except OSError:
        return True


def _folder(value, missing, unavailable, *, allow_drive_root=False):
    if not isinstance(value, str) or not value:
        raise ArchStudioError(missing)
    root = Path(value)
    try:
        if (not root.is_absolute() or is_link(root) or not root.is_dir()
                or (root.parent == root and not allow_drive_root)):
            raise ArchStudioError(unavailable)
    except OSError as error:
        raise ArchStudioError(unavailable) from error
    return root


def studio_root(context):
    """The Studio folder given by the host; every file this tool writes lives there."""
    value = context.get("studio_root") if isinstance(context, dict) else None
    return _folder(value, "ArchStudio only works inside an open Studio", "The Studio folder is unavailable")


def source_root(context):
    """The folder to analyze, or None when the host did not give one."""
    value = context.get("source_root") if isinstance(context, dict) else None
    if value is None or value == "":
        return None
    return _folder(value, "The project folder is unavailable",
                   "The project folder is unavailable, is a link, or is not a folder", allow_drive_root=True)


def source_identity(source):
    """Bind persisted edits to a folder without exposing its absolute path in the map."""
    return hashlib.sha256(os.path.normcase(os.path.realpath(source)).encode("utf-8")).hexdigest()


def _studio_path(root, name):
    if name not in STUDIO_FILES:
        raise ArchStudioError("Invalid Studio file")
    path = root / name
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return path
    except OSError as error:
        raise ArchStudioError(f"{name} is unavailable") from error
    if is_link_stat(info) or not stat.S_ISREG(info.st_mode):
        raise ArchStudioError(f"{name} must be a regular file inside the Studio folder")
    return path


def write_text(root, name, text):
    """Write one Studio file atomically: temporary file, then replace with retries."""
    path = _studio_path(root, name)
    try:
        descriptor, temporary = tempfile.mkstemp(prefix=".archstudio-", suffix=".tmp", dir=root)
    except OSError as error:
        raise ArchStudioError(f"{name} could not be saved") from error
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        for attempt in range(8):
            try:
                os.replace(temporary, path)
                return
            except PermissionError:
                # Windows refuses the replace while a reader holds the file open.
                if attempt == 7:
                    raise
                time.sleep(0.05 * (attempt + 1))
    except OSError as error:
        raise ArchStudioError(f"{name} could not be saved") from error
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        except OSError:
            pass


def write_json(root, name, data, *, indent=None):
    separators = (",", ": ") if indent is not None else (",", ":")
    text = json.dumps(data, ensure_ascii=False, indent=indent, separators=separators)
    if len(text.encode("utf-8")) > MAX_STUDIO_FILE:
        raise ArchStudioError(f"{name} would be too large; nothing was saved")
    write_text(root, name, text)


def read_json(root, name):
    """Read one Studio file; a missing file is None, a damaged one is an error."""
    path = _studio_path(root, name)
    try:
        with open(path, "rb") as stream:
            data = stream.read(MAX_STUDIO_FILE + 1)
    except FileNotFoundError:
        return None
    except OSError as error:
        raise ArchStudioError(f"{name} could not be read") from error
    if len(data) > MAX_STUDIO_FILE:
        raise ArchStudioError(f"{name} is too large; nothing was changed")
    try:
        value = json.loads(data.decode("utf-8"))
    except (UnicodeError, ValueError) as error:
        raise ArchStudioError(f"{name} is damaged; nothing was changed") from error
    if not isinstance(value, dict):
        raise ArchStudioError(f"{name} is damaged; nothing was changed")
    return value


def delete_file(root, name):
    """Remove one Studio file; returns False when it did not exist."""
    path = _studio_path(root, name)
    for attempt in range(8):
        try:
            os.unlink(path)
            return True
        except FileNotFoundError:
            return False
        except PermissionError as error:
            if attempt == 7:
                raise ArchStudioError(f"{name} could not be removed") from error
            time.sleep(0.05 * (attempt + 1))
        except OSError as error:
            raise ArchStudioError(f"{name} could not be removed") from error
    return False


@contextmanager
def locked(root):
    """Serialize changes to one Studio folder across processes."""
    path = root / LOCK_FILE
    if path.is_symlink():
        raise ArchStudioError("The Studio folder is unavailable")
    try:
        stream = path.open("a+b")
    except OSError as error:
        raise ArchStudioError("The Studio folder is unavailable") from error
    with stream:
        if stream.tell() == 0:
            stream.write(b"\0")
            stream.flush()
        stream.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_LOCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
        except OSError as error:
            raise ArchStudioError("ArchStudio is busy with another operation; try again in a moment") from error
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def slug(text, limit=40):
    """Fold a natural name such as 'Notificações' into 'notificacoes'."""
    folded = unicodedata.normalize("NFKD", str(text)).encode("ascii", "ignore").decode("ascii").lower()
    folded = re.sub(r"[^a-z0-9]+", "-", folded).strip("-")
    return folded[:limit].strip("-")


def short_name(name, limit=40):
    """Lightly humanize package names: drop scopes and module prefixes, keep it short."""
    name = str(name).strip().strip("/")
    if name.startswith("@") and "/" in name:
        name = name.split("/", 1)[1]
    name = name.rsplit("/", 1)[-1].rsplit(":", 1)[-1]
    if re.fullmatch(r"v\d+", name):
        name = ""
    name = name.replace("_", "-").strip("-. ")
    return name[:limit].rstrip("-. ")


def link_id(prefix, source, target, protocol, label):
    digest = hashlib.sha1(f"{source}\u0000{target}\u0000{protocol}\u0000{label or ''}".encode("utf-8")).hexdigest()
    return prefix + digest[:12]


def utc_now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
