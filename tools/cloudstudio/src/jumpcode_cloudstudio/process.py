# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Starts, finds and stops the local cloud's process for one Studio. The process lives as long as this one:
it holds the other end of a pipe, and when this process ends the pipe closes and the cloud stops."""

import json
from contextlib import contextmanager
from contextvars import ContextVar
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

from .common import CloudStudioError

NO_WINDOW = 0x08000000 if os.name == "nt" else 0
FIRST_PORT = 4566
LAST_PORT = 4599
_lock = threading.Lock()
_engines = {}
_call_context = ContextVar("cloudstudio_call_context", default=({}, None))


@contextmanager
def call_context(namespace, cancelled):
    token = _call_context.set((namespace, cancelled))
    try:
        yield
    finally:
        _call_context.reset(token)


def call_namespace():
    return dict(_call_context.get()[0])


class Engine:
    def __init__(self, root, process, port, token, storage, region):
        self.root = root
        self.process = process
        self.port = port
        self.token = token
        self.storage = storage
        self.region = region
        self.started = time.time()

    @property
    def endpoint(self):
        return f"http://127.0.0.1:{self.port}"

    def alive(self):
        return self.process.poll() is None

    def call(self, action, payload=None, timeout=60):
        namespace, cancelled = _call_context.get()
        payload = {**namespace, **(payload or {})}
        if cancelled is None or action not in ("invoke", "request", "run-machine"):
            return self._call(action, payload, timeout)
        key = secrets.token_hex(24)
        self._call("operation-open", {"id": key}, 5)
        done = threading.Event()
        outcome = []

        def dispatch():
            try:
                outcome.append((True, self._call(action, payload, timeout, key)))
            except Exception as error:
                outcome.append((False, error))
            finally:
                done.set()

        worker = threading.Thread(target=dispatch, daemon=True)
        worker.start()
        try:
            while not done.wait(0.05):
                try:
                    if cancelled():
                        raise CloudStudioError("The operation was cancelled. Changes already completed are kept.")
                except Exception:
                    self._call("operation-cancel", {"id": key}, 5)
                    done.wait(5)
                    raise
            ok, result = outcome[0]
            if not ok:
                raise result
            return result
        finally:
            self._call("operation-close", {"id": key}, 5)

    def _call(self, action, payload=None, timeout=60, operation=None):
        """One control call to the cloud; raises CloudStudioError with the cloud's own message."""
        data = json.dumps(payload or {}, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(f"{self.endpoint}/_cloudstudio/{action}", data, method="POST",
                                         headers={"Content-Type": "application/json", "X-CloudStudio-Token": self.token})
        if operation:
            request.add_header("X-CloudStudio-Operation", operation)
        try:
            from .engine.local_http import open_local
            with open_local(request, timeout=timeout) as answer:
                return json.loads(answer.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            try:
                body = json.loads(error.read().decode("utf-8"))
            except ValueError:
                body = {}
            raise CloudStudioError(f"{body.get('error', 'Error')}: {body.get('message', error.reason)}") from error
        except (OSError, ValueError) as error:
            raise CloudStudioError(f"The local cloud did not answer ({error}). Call start again.") from error


def _key(root):
    return os.path.normcase(str(Path(root).resolve()))


def running(root):
    with _lock:
        engine = _engines.get(_key(root))
    if engine is not None and not engine.alive():
        with _lock:
            _engines.pop(_key(root), None)
        return None
    return engine


def _port_free(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        if os.name == "nt":
            probe.setsockopt(socket.SOL_SOCKET, getattr(socket, "SO_EXCLUSIVEADDRUSE", 0) or socket.SO_REUSEADDR, 1)
        try:
            probe.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def _ports(preferred):
    taken = {engine.port for engine in _engines.values()}
    order = ([preferred] if preferred else []) + list(range(FIRST_PORT, LAST_PORT + 1))
    seen = set()
    for port in order:
        if port in seen or port in taken:
            continue
        seen.add(port)
        if _port_free(port):
            yield port


# The engine must run this very copy of the package. Its import path is handed over on the command
# line because an embedded interpreter ignores PYTHONPATH and would import another copy, or none.
_ENGINE_START = ("import os,runpy,sys;sys.path[:0]=[entry for entry in sys.argv.pop(1).split(os.pathsep) if entry];"
                 "runpy.run_module('jumpcode_cloudstudio.engine',run_name='__main__')")


def _python_path():
    """The child runs this very interpreter and must import this package the same way."""
    entries = [entry for entry in sys.path if entry and os.path.isdir(entry)]
    package_parent = str(Path(__file__).resolve().parent.parent)
    if package_parent not in entries:
        entries.insert(0, package_parent)
    return os.pathsep.join(entries)


def start(root, storage="memory", region="us-east-1", port=None, python=None, node=None):
    existing = running(root)
    if existing is not None:
        return existing, False
    data = Path(root) / "data"
    data.mkdir(parents=True, exist_ok=True)
    last_error = "no free port between 4566 and 4599"
    for candidate in _ports(port):
        token = secrets.token_hex(24)
        command = [sys.executable, "-c", _ENGINE_START, _python_path(), "--studio", str(root), "--port", str(candidate),
                   "--storage", storage, "--region", region, "--spawned", repr(time.time())]
        if python:
            command += ["--python", python]
        if node:
            command += ["--node", node]
        environment = {k: v for k, v in os.environ.items() if k.upper() not in ("PYTHONSTARTUP", "PYTHONINSPECT")}
        environment["PYTHONPATH"] = _python_path()
        environment["PYTHONIOENCODING"] = "utf-8"
        environment["PYTHONDONTWRITEBYTECODE"] = "1"
        log = open(data / "engine.log", "ab")
        try:
            process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, env=environment,
                                       creationflags=NO_WINDOW, close_fds=True)
        finally:
            log.close()
        process.stdin.write((token + "\n").encode())
        process.stdin.flush()
        line = _first_line(process, 20)
        try:
            answer = json.loads(line or "{}")
        except ValueError:
            answer = {}
        if answer.get("ready"):
            engine = Engine(Path(root), process, candidate, token, storage, region)
            engine.ready_ms = answer.get("readyMs")
            with _lock:
                _engines[_key(root)] = engine
            return engine, True
        _stop_process(process)
        if answer.get("error") == "port":
            last_error = answer.get("message", last_error)
            continue
        if answer.get("error") == "state":
            raise CloudStudioError(answer["message"])
        tail = (data / "engine.log").read_text(encoding="utf-8", errors="replace")[-1500:] if (data / "engine.log").exists() else ""
        raise CloudStudioError("The local cloud could not start." + (f" Engine log: {tail}" if tail else ""))
    raise CloudStudioError(f"The local cloud could not start: {last_error}")


def _first_line(process, timeout):
    result = []
    reader = threading.Thread(target=lambda: result.append(process.stdout.readline().decode("utf-8", "replace")), daemon=True)
    reader.start()
    reader.join(timeout)
    return result[0] if result else ""


def stop(root):
    engine = running(root)
    if engine is None:
        return False
    try:
        engine.call("shutdown", timeout=5)
    except CloudStudioError:
        pass
    try:
        engine.process.wait(6)
    except subprocess.TimeoutExpired:
        pass
    _stop_process(engine.process)
    with _lock:
        _engines.pop(_key(root), None)
    return True


def _stop_process(process):
    try:
        if process.stdin:
            process.stdin.close()
    except OSError:
        pass
    try:
        process.wait(3)
    except subprocess.TimeoutExpired:
        if os.name == "nt":
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(process.pid)], capture_output=True, creationflags=NO_WINDOW)
        else:
            process.kill()
        process.wait(3)
    if process.stdout:
        process.stdout.close()
