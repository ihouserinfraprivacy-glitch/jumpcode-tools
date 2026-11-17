# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""The local cloud's state: one JSON tree per account and region, object bodies as content-addressed blobs,
saved between sessions in persistent mode, and named copies (snapshots) to go back to."""

import copy
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import threading
import time

SCHEMA = 1
_SNAPSHOT_ID = re.compile(r"^[a-z0-9]{8,32}$")


class StateError(ValueError):
    """The persisted data cannot be read safely; preserve it for recovery."""


def load_state_file(path):
    try:
        with open(path, encoding="utf-8") as stream:
            return json.load(stream)
    except (OSError, ValueError) as error:
        raise StateError(f"Cannot read {Path(path).name}. The local cloud was not opened; its data was preserved for recovery.") from error


def valid_state(data):
    return (isinstance(data, dict) and data.get("schema") == SCHEMA and isinstance(data.get("accounts"), dict)
            and all(isinstance(account, dict) and isinstance(account.get("global"), dict)
                    and isinstance(account.get("regions"), dict) for account in data["accounts"].values()))


def write_atomic(path, text):
    """Writes a file so readers see the old or the new content, never half of it (retrying while Windows holds it open)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = text.encode("utf-8") if isinstance(text, str) else text
    handle, temporary = tempfile.mkstemp(prefix=".cs-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(handle, "wb") as stream:
            stream.write(data)
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
            try:
                os.remove(temporary)
            except OSError:
                pass


def read_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as stream:
            return json.load(stream)
    except (OSError, ValueError):
        return default


class Store:
    """Thread-safe state. Services mutate `state` in place while holding `lock` and call `touch()`."""

    def __init__(self, folder, persistent=False):
        self.folder = Path(folder)
        self.blob_dir = self.folder / "blobs"
        self.snap_dir = self.folder / "snapshots"
        self.state_file = self.folder / "state.json"
        self.persistent = persistent
        self.lock = threading.RLock()
        self.state = self._empty()
        self.version = 0
        self.saved_version = 0
        self.listeners = []
        self.blob_dir.mkdir(parents=True, exist_ok=True)
        self.snap_dir.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _empty():
        return {"schema": SCHEMA, "accounts": {}}

    # ------------------------------------------------------------ namespaces
    def account(self, account):
        return self.state["accounts"].setdefault(account, {"global": {}, "regions": {}})

    def regional(self, account, region, service):
        """The dict of one service in one account and region, created on first use."""
        regions = self.account(account)["regions"]
        return regions.setdefault(region, {}).setdefault(service, {})

    def global_(self, account, service):
        return self.account(account)["global"].setdefault(service, {})

    def each(self, service, scope="regional"):
        """Yields (account, region, service dict) for every namespace that has the service (region is None for global ones)."""
        for account, data in self.state["accounts"].items():
            if scope == "global":
                if service in data["global"]:
                    yield account, None, data["global"][service]
            else:
                for region, services in data["regions"].items():
                    if service in services:
                        yield account, region, services[service]

    def touch(self):
        with self.lock:
            self.version += 1
        for listener in list(self.listeners):
            listener()

    # ------------------------------------------------------------ blobs
    def put_blob(self, data):
        digest = hashlib.sha256(data).hexdigest()
        path = self.blob_dir / digest[:2] / digest
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            write_atomic(path, data)
        return digest

    def blob_path(self, digest):
        return self.blob_dir / digest[:2] / digest

    def get_blob(self, digest):
        try:
            return self.blob_path(digest).read_bytes()
        except OSError:
            return b""

    def _referenced(self, tree, found):
        if isinstance(tree, dict):
            for key, value in tree.items():
                if key == "blob" and isinstance(value, str):
                    found.add(value)
                else:
                    self._referenced(value, found)
        elif isinstance(tree, list):
            for value in tree:
                self._referenced(value, found)
        return found

    def gc_blobs(self):
        """Removes blobs no state or copy refers to."""
        with self.lock:
            keep = self._referenced(self.state, set())
        for item in self.snap_dir.glob("*.json"):
            snapshot = load_state_file(item)
            if not isinstance(snapshot, dict) or not valid_state(snapshot.get("state")):
                raise StateError("A saved copy cannot be read safely. No object data was removed.")
            self._referenced(snapshot, keep)
        for folder in self.blob_dir.glob("*"):
            if folder.is_dir():
                for blob in folder.iterdir():
                    if blob.name not in keep and not blob.name.startswith(".cs-"):
                        try:
                            blob.unlink()
                        except OSError:
                            pass

    # ------------------------------------------------------------ persistence
    def load(self):
        if not self.state_file.exists():
            return False
        data = load_state_file(self.state_file)
        if valid_state(data):
            with self.lock:
                self.state = data
                self.version += 1
                self.saved_version = self.version
            return True
        raise StateError("The saved state has an unsupported format. Its data was preserved for recovery.")

    def save(self, force=False):
        with self.lock:
            if not self.persistent or (self.saved_version == self.version and not force):
                return False
            text = json.dumps(self.state, ensure_ascii=False, separators=(",", ":"))
            version = self.version
            # Serialize disk commits too: a pending save must not overwrite a restored state.
            write_atomic(self.state_file, text)
            self.saved_version = version
        return True

    def forget(self):
        """Drops the saved state file (memory mode keeps nothing between sessions)."""
        try:
            self.state_file.unlink()
        except OSError:
            pass

    def reset(self):
        with self.lock:
            self.state = self._empty()
        self.touch()
        self.save(force=True)
        self.gc_blobs()

    # ------------------------------------------------------------ copies
    def snapshot(self, name, summary=None):
        with self.lock:
            text = json.dumps({"schema": SCHEMA, "name": name, "at": time.time(), "summary": summary or {},
                               "state": self.state}, ensure_ascii=False, separators=(",", ":"))
        snapshot_id = hashlib.sha1(f"{name}{time.time()}".encode()).hexdigest()[:12]
        write_atomic(self.snap_dir / f"{snapshot_id}.json", text)
        return {"id": snapshot_id, "name": name, "at": time.time(), "bytes": len(text.encode("utf-8")), "summary": summary or {}}

    def snapshots(self):
        result = []
        for item in self.snap_dir.glob("*.json"):
            if not _SNAPSHOT_ID.match(item.stem):
                continue
            data = read_json(item, {})
            if isinstance(data, dict) and data.get("schema") == SCHEMA:
                result.append({"id": item.stem, "name": data.get("name", item.stem), "at": data.get("at", 0),
                               "bytes": item.stat().st_size, "summary": data.get("summary", {})})
        return sorted(result, key=lambda entry: entry["at"], reverse=True)

    def find_snapshot(self, key):
        key = (key or "").strip()
        for entry in self.snapshots():
            if entry["id"] == key or entry["name"].lower() == key.lower():
                return entry
        return None

    def restore(self, snapshot_id):
        if not _SNAPSHOT_ID.match(snapshot_id or ""):
            return False
        try:
            data = load_state_file(self.snap_dir / f"{snapshot_id}.json")
        except StateError as error:
            raise StateError("The saved copy could not be read. Current data was preserved.") from error
        if not isinstance(data, dict) or data.get("schema") != SCHEMA or not valid_state(data.get("state")):
            raise StateError("The saved copy has an unsupported format. Current data was preserved.")
        restored = copy.deepcopy(data["state"])
        with self.lock:
            if self.persistent:
                write_atomic(self.state_file, json.dumps(restored, ensure_ascii=False, separators=(",", ":")))
            self.state = restored
            self.touch()
            if self.persistent:
                self.saved_version = self.version
        return True

    def delete_snapshot(self, snapshot_id):
        if not _SNAPSHOT_ID.match(snapshot_id or ""):
            return False
        try:
            (self.snap_dir / f"{snapshot_id}.json").unlink()
        except OSError:
            return False
        self.gc_blobs()
        return True
