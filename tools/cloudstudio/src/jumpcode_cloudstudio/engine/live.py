# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Keeps the Studio files current while the cloud runs: status, resources, calls and logs.
JumpCode watches the Studio folder and hands these files to the interface."""

import json
import os
import threading
import time

from .state import write_atomic

CLOUD_FILE = "cloud.json"
RESOURCES_FILE = "resources.json"
CALLS_FILE = "calls.json"
LOGS_FILE = "logs.json"
MIN_INTERVAL = 0.35
RETRY_INTERVAL = 5.0
MAX_RESOURCES_BYTES = 6_000_000
SCHEMA = 1


class Live(threading.Thread):
    def __init__(self, cloud):
        super().__init__(name="cloudstudio-live", daemon=True)
        self.cloud = cloud
        self.dirty = set()
        self.wake = threading.Event()
        self.lock = threading.Lock()
        self.status = "starting"
        self.last_write = 0.0

    def mark(self, *names):
        with self.lock:
            self.dirty.update(names)
        self.wake.set()

    def run(self):
        failures = set()
        retry_at = 0.0
        while True:
            self.wake.wait(RETRY_INTERVAL)
            if self.cloud.stopping.is_set():
                return
            pause = max(self.last_write + MIN_INTERVAL, retry_at) - time.monotonic()
            if pause > 0 and self.cloud.stopping.wait(pause):
                return
            self.wake.clear()
            with self.lock:
                names, self.dirty = self.dirty, set()
            writes = [("saved state", self.cloud.store.save)]
            if names:
                writes.insert(0, ("Studio files", lambda: self.flush(names)))
            for target, write_pending in writes:
                try:
                    write_pending()
                except Exception as error:  # a failed write must not stop updates or discard pending work
                    if target == "Studio files":
                        with self.lock:
                            self.dirty.update(names)
                    if target not in failures:
                        self.cloud.log("/cloudstudio/engine", "studio", f"could not update the {target}: {error}", "error")
                    failures.add(target)
                else:
                    failures.discard(target)
            retry_at = time.monotonic() + RETRY_INTERVAL if failures else 0.0

    def flush(self, names):
        self.last_write = time.monotonic()
        if "resources" in names:
            self.write_resources()
            names = names | {"cloud"}
        if "calls" in names:
            with self.cloud.history_lock:
                calls = list(self.cloud.calls)
                total, errors = self.cloud.call_count, self.cloud.error_count
            write(self.cloud.root / CALLS_FILE, {"schema": SCHEMA, "calls": calls, "total": total, "errors": errors})
            names = names | {"cloud"}
        if "logs" in names:
            with self.cloud.history_lock:
                logs = list(self.cloud.logs)
            write(self.cloud.root / LOGS_FILE, {"schema": SCHEMA, "logs": logs})
        if "cloud" in names:
            write(self.cloud.root / CLOUD_FILE, self.cloud_file())

    def write_resources(self):
        resources = self.cloud.summary()
        value = {"schema": SCHEMA, "version": self.cloud.store.version, "resources": resources}
        text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        if len(text) > MAX_RESOURCES_BYTES:
            # Keep every resource but drop the heaviest detail first (previews and item lists).
            for resource in resources:
                resource.pop("preview", None)
                for key in ("items", "objects", "messages", "invocations", "executions"):
                    if isinstance(resource.get(key), list):
                        resource[key] = resource[key][:20]
            text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        write_atomic(self.cloud.root / RESOURCES_FILE, text)

    def cloud_file(self, status=None):
        cloud = self.cloud
        with cloud.history_lock:
            calls, errors = cloud.call_count, cloud.error_count
        regions = sorted({(account, region) for account, data in cloud.store.state["accounts"].items() for region in data["regions"]})
        return {
            "schema": SCHEMA,
            "status": status or self.status,
            "endpoint": cloud.endpoint,
            "port": cloud.port,
            "pid": os.getpid(),
            "startedAt": cloud.started,
            "readyMs": cloud.ready_ms,
            "storage": "persistent" if cloud.store.persistent else "memory",
            "region": cloud.region,
            "account": "000000000000",
            "places": [{"account": account, "region": region} for account, region in regions],
            "calls": calls,
            "errors": errors,
            "services": sorted(cloud.services),
            "runtimes": cloud.runtime.available(),
            "snapshots": cloud.store.snapshots(),
            "version": cloud.store.version,
            "updatedAt": time.time(),
        }

    def final(self, status):
        """The last word of a stopping cloud."""
        self.status = status
        self.flush({"cloud", "calls", "logs"} | ({"resources"} if self.cloud.store.persistent else set()))
        if not self.cloud.store.persistent:
            write(self.cloud.root / RESOURCES_FILE, {"schema": SCHEMA, "version": 0, "resources": []})


def write(path, value):
    write_atomic(path, json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str))
