# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Shared helpers: errors, host folders, atomic Studio files, the lock, ids, texts and time."""

from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import time

PLAN_FILE = "plan.json"
PROPOSAL_FILE = "proposal.json"
HISTORY_FILE = "history.json"
VIEW_FILE = "view.json"
STATE_FILE = "state.json"
STUDIO_FILES = (PLAN_FILE, PROPOSAL_FILE, HISTORY_FILE, VIEW_FILE)
LOCK_FILE = ".taskstudio.lock"
TEMPORARY_PREFIX = ".taskstudio-"
SCHEMA = 1
MAX_STUDIO_FILE = 2_000_000
MAX_STATE_FILE = 8_100_000

# Windows reparse tags of symbolic links and junctions (mount points).
_LINK_TAGS = {0xA000000C, 0xA0000003}
_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")
_ID = re.compile(r"#?\s*(?P<number>\d{1,6})")


class TaskStudioError(ValueError):
    """Invalid request or unusable Studio files; the Studio files were left as they were."""


class DamagedFile(TaskStudioError):
    """A Studio file exists but cannot be used: unreadable, corrupt or from another schema."""

    def __init__(self, name, newer=False):
        self.name = name
        self.newer = newer
        if newer:
            super().__init__(f"{name} was written by a newer TaskStudio; nothing was changed")
        else:
            super().__init__(f"{name} is damaged; nothing was changed")


def _is_link_stat(info):
    return stat.S_ISLNK(info.st_mode) or getattr(info, "st_reparse_tag", 0) in _LINK_TAGS


def _is_link(path):
    try:
        return _is_link_stat(os.lstat(path))
    except OSError:
        return True


def studio_root(context):
    """The Studio folder given by the host; every file this tool writes lives there."""
    value = context.get("studio_root") if isinstance(context, dict) else None
    if not isinstance(value, str) or not value:
        raise TaskStudioError("TaskStudio only works inside an open Studio")
    root = Path(value)
    try:
        if not root.is_absolute() or root.parent == root or _is_link(root) or not root.is_dir():
            raise TaskStudioError("The Studio folder is unavailable")
    except OSError as error:
        raise TaskStudioError("The Studio folder is unavailable") from error
    return root


def has_project(context):
    """Whether the host bound a project folder; the package never reads it."""
    value = context.get("source_root") if isinstance(context, dict) else None
    return isinstance(value, str) and bool(value.strip())


def execution_id(context):
    """Host-issued identity of this call, kept only for traceability in task logs."""
    value = context.get("execution_id") if isinstance(context, dict) else None
    if isinstance(value, str) and value and len(value) <= 100 and not _CONTROL.search(value):
        return value
    return None


def _studio_path(root, name):
    if name not in (*STUDIO_FILES, STATE_FILE):
        raise TaskStudioError("Invalid Studio file")
    path = root / name
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return path
    except OSError as error:
        raise TaskStudioError(f"{name} is unavailable") from error
    if _is_link_stat(info) or not stat.S_ISREG(info.st_mode):
        raise TaskStudioError(f"{name} must be a regular file inside the Studio folder")
    return path


def serialize(name, data):
    """The text of one Studio file, refused before writing when it exceeds the per-file limit."""
    text = json.dumps(data, ensure_ascii=False, indent=1)
    limit = MAX_STATE_FILE if name == STATE_FILE else MAX_STUDIO_FILE
    if len(text.encode("utf-8")) > limit:
        raise TaskStudioError(f"{name} would be larger than {limit:,} bytes; nothing was saved. "
                              "Keep notes and logs shorter.")
    return text


def write_text(root, name, text):
    """Write one Studio file atomically: temporary file, then replace with retries."""
    path = _studio_path(root, name)
    try:
        descriptor, temporary = tempfile.mkstemp(prefix=TEMPORARY_PREFIX, suffix=".tmp", dir=root)
    except OSError as error:
        raise TaskStudioError(f"{name} could not be saved") from error
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
        raise TaskStudioError(f"{name} could not be saved") from error
    finally:
        try:
            os.unlink(temporary)
        except OSError:
            pass


def read_json(root, name):
    """Read one Studio file: None when missing or empty, DamagedFile when it cannot be used."""
    path = _studio_path(root, name)
    limit = MAX_STATE_FILE if name == STATE_FILE else MAX_STUDIO_FILE
    try:
        with open(path, "rb") as stream:
            data = stream.read(limit + 1)
    except FileNotFoundError:
        return None
    except OSError as error:
        raise TaskStudioError(f"{name} could not be read") from error
    if not data.strip():
        return None
    if len(data) > limit:
        raise DamagedFile(name)
    try:
        value = json.loads(data.decode("utf-8-sig"))
    except (UnicodeError, ValueError, RecursionError) as error:
        raise DamagedFile(name) from error
    if not isinstance(value, dict):
        raise DamagedFile(name)
    schema = value.get("schema")
    if isinstance(schema, int) and not isinstance(schema, bool) and schema > SCHEMA:
        raise DamagedFile(name, newer=True)
    if schema != SCHEMA:
        raise DamagedFile(name)
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
                raise TaskStudioError(f"{name} could not be removed") from error
            time.sleep(0.05 * (attempt + 1))
        except OSError as error:
            raise TaskStudioError(f"{name} could not be removed") from error
    return False


@contextmanager
def locked(root):
    """Serialize changes to one Studio folder across processes."""
    path = root / LOCK_FILE
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        info = None
    except OSError as error:
        raise TaskStudioError("The Studio folder is unavailable") from error
    if info is not None and (_is_link_stat(info) or not stat.S_ISREG(info.st_mode)):
        raise TaskStudioError("The Studio folder is unavailable")
    try:
        stream = path.open("a+b")
    except OSError as error:
        raise TaskStudioError("The Studio folder is unavailable") from error
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
            raise TaskStudioError("TaskStudio is busy with another call; try again in a moment") from error
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


def task_id(value, field="id"):
    """Normalize a task id written as 6, "6" or "#6" into "6"."""
    number = None
    if isinstance(value, int) and not isinstance(value, bool):
        number = value
    elif isinstance(value, float) and value.is_integer():
        number = int(value)
    elif isinstance(value, str):
        match = _ID.fullmatch(value.strip())
        if match:
            number = int(match["number"])
    if number is None or number < 1:
        raise TaskStudioError(f"{field} must be a task number such as 6 or \"#6\"")
    return str(number)


def clean_text(value, limit, *, lines=False):
    """Trim a text and cut it to `limit` characters; control characters are dropped."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        value = str(value)
    if not isinstance(value, str):
        return None
    value = value.replace("\r\n", "\n").replace("\r", "\n")
    if lines:
        value = "\n".join(" ".join(line.split()) for line in value.split("\n"))
        value = re.sub(r"\n{3,}", "\n\n", value)
    else:
        value = " ".join(value.split())
    value = _CONTROL.sub("", value).strip()
    if len(value) > limit:
        value = value[:limit - 1].rstrip() + "…"
    return value


def iso(seconds):
    """ISO 8601 UTC time with a Z suffix, at one-second precision."""
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(seconds))


def answer(message, **data):
    """The result of an action: ok, a short English message for the model, then its data."""
    return {"ok": True, "message": message, **data}
