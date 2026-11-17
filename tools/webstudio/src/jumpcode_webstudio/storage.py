"""Serialized Studio transactions with a durable rollback record.

site.json is the commit marker. An interrupted transaction is recovered before the
next operation; a failure to recover remains uncertain rather than claiming success.
"""

from contextlib import contextmanager
from hashlib import sha256
import json
import os
from pathlib import Path, PureWindowsPath
import re
import tempfile
import time

JOURNAL = ".studio-transaction.json"
LOCK = ".studio.lock"
MODEL = "site.json"
_FILE = re.compile(r"(?:site\.json|styles\.css|[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\.html)\Z")
MAX_FILE_BYTES = 8_000_000
MAX_JOURNAL_BYTES = 32_000_000


class SaveFailed(ValueError):
    """No changes remain after a failed transaction."""


def _path(root, name):
    path = root / name
    if (os.path.isreserved(name) if hasattr(os.path, "isreserved") else PureWindowsPath(name).is_reserved()):
        raise OSError("Reserved Windows file name")
    if path.is_symlink() or (path.exists() and (not path.is_file() or path.stat().st_nlink != 1)):
        raise OSError("Studio files must be regular, unshared files")
    return path


def _read(path, limit=MAX_FILE_BYTES):
    try:
        with path.open("rb") as stream:
            data = stream.read(limit + 1)
    except FileNotFoundError:
        return None
    if len(data) > limit:
        raise OSError("Studio file exceeds the recovery limit")
    return data.decode("utf-8")


def read_file(root, name):
    if not _FILE.fullmatch(name):
        raise ValueError("Invalid Studio file")
    return _read(_path(root, name))


def atomic_write(path, content):
    descriptor, temporary = tempfile.mkstemp(prefix=".studio-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        for attempt in range(5):
            try:
                os.replace(temporary, path)
                return
            except PermissionError:
                if attempt == 4:
                    raise
                time.sleep(0.05 * (attempt + 1))
    finally:
        Path(temporary).unlink(missing_ok=True)


@contextmanager
def locked(root):
    # Keep the lock file: unlinking it lets two processes lock different inodes.
    with _path(root, LOCK).open("a+b") as stream:
        if stream.tell() == 0:
            stream.write(b"\0")
            stream.flush()
        stream.seek(0)
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(stream.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
        try:
            recover(root)
            yield
        finally:
            stream.seek(0)
            if os.name == "nt":
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def _digest(content):
    return sha256(content.encode("utf-8")).hexdigest() if content is not None else None


def _restore(root, before):
    # Restore the model last, just as for commit. The UI ignores a pending journal.
    for name in [key for key in before if key != MODEL] + [MODEL]:
        path = _path(root, name)
        if before[name] is None:
            path.unlink(missing_ok=True)
        else:
            atomic_write(path, before[name])


def recover(root):
    try:
        raw = _read(_path(root, JOURNAL), MAX_JOURNAL_BYTES)
        if raw is None:
            return
        record = json.loads(raw)
        if not isinstance(record, dict):
            raise ValueError("Invalid Studio recovery record")
        before = record["before"]
        if (record.get("version") != 1 or not isinstance(before, dict) or MODEL not in before
                or len(before) > 14 or not isinstance(record.get("commit"), str)
                or any(not _FILE.fullmatch(name) or (value is not None and not isinstance(value, str))
                       for name, value in before.items())):
            raise ValueError("Invalid Studio recovery record")
        if _digest(_read(_path(root, MODEL))) != record["commit"]:
            _restore(root, before)
        _path(root, JOURNAL).unlink()
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise RuntimeError("Studio recovery could not be confirmed") from error


def commit(root, changes):
    if MODEL not in changes or any(not _FILE.fullmatch(name) for name in changes):
        raise ValueError("Invalid Studio transaction")
    try:
        before = {name: _read(_path(root, name)) for name in changes}
        record = json.dumps({"version": 1, "commit": _digest(changes[MODEL]), "before": before}, ensure_ascii=False)
        if len(record.encode("utf-8")) > MAX_JOURNAL_BYTES:
            raise OSError("Studio transaction exceeds the recovery limit")
        atomic_write(_path(root, JOURNAL), record)
    except (OSError, UnicodeError) as error:
        raise SaveFailed("The site could not be saved; no changes were made") from error
    try:
        for name in [key for key in changes if key != MODEL] + [MODEL]:
            path = _path(root, name)
            if changes[name] is None:
                path.unlink(missing_ok=True)
            else:
                atomic_write(path, changes[name])
    except OSError as error:
        try:
            _restore(root, before)
            _path(root, JOURNAL).unlink()
        except OSError as recovery_error:
            raise RuntimeError("Studio save failed and recovery is not yet confirmed") from recovery_error
        raise SaveFailed("The site could not be saved; previous files were restored") from error
    # The commit is already durable. Failure to clear this record must not undo it
    # or report 'not executed'; the next operation can safely clear it.
    try:
        _path(root, JOURNAL).unlink()
    except OSError:
        pass
