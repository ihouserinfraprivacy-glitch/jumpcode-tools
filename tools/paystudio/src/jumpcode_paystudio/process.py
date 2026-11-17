# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Starts, finds and stops the fake gateway's process for one Studio. The process lives as long as this one: it
holds the other end of a pipe, and when this process ends the pipe closes and the gateway stops."""

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

from .common import PayStudioError

NO_WINDOW = 0x08000000 if os.name == "nt" else 0
FIRST_PORT = 4570
LAST_PORT = 4599
_lock = threading.Lock()
_engines = {}
_cancelled = ContextVar("paystudio_cancelled", default=None)


def checkpoint():
    callback = _cancelled.get()
    if callback is not None and callback():
        raise PayStudioError("The operation was cancelled. Changes already completed are kept.")


@contextmanager
def call_context(cancelled):
    token = _cancelled.set(cancelled)
    try:
        checkpoint()
        yield
        checkpoint()
    finally:
        _cancelled.reset(token)


class Engine:
    def __init__(self, root, process, port, token, storage):
        self.root = root
        self.process = process
        self.port = port
        self.token = token
        self.storage = storage
        self.ready_ms = None

    @property
    def endpoint(self):
        return f"http://127.0.0.1:{self.port}"

    def alive(self):
        return self.process.poll() is None

    def call(self, action, payload=None, timeout=60):
        checkpoint()
        if _cancelled.get() is None or action != "check":
            result = self._call(action, payload, timeout)
            checkpoint()
            return result
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

        threading.Thread(target=dispatch, daemon=True).start()
        try:
            try:
                while not done.wait(0.05):
                    checkpoint()
                checkpoint()
            except Exception:
                try:
                    self._call("operation-cancel", {"id": key}, 5)
                    done.wait(2)
                except PayStudioError:
                    pass
                raise
            ok, result = outcome[0]
            if not ok:
                raise result
            return result
        finally:
            try:
                self._call("operation-close", {"id": key}, 5)
            except PayStudioError:
                pass

    def _call(self, action, payload=None, timeout=60, operation=None):
        data = json.dumps(payload or {}, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(f"{self.endpoint}/_paystudio/{action}", data, method="POST",
                                         headers={"Content-Type": "application/json", "X-PayStudio-Token": self.token})
        if operation:
            request.add_header("X-PayStudio-Operation", operation)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with opener.open(request, timeout=timeout) as answer:
                return json.loads(answer.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            try:
                body = json.loads(error.read().decode("utf-8"))
            except ValueError:
                body = {}
            raise PayStudioError(body.get("message") or body.get("error") or str(error.reason)) from error
        except (OSError, ValueError) as error:
            raise PayStudioError(f"The payment gateway did not answer ({error}). Call start again.") from error


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


# The engine must run this very copy of the package. Its import path is handed over on the command
# line because an embedded interpreter ignores PYTHONPATH and would import another copy, or none.
_ENGINE_START = ("import os,runpy,sys;sys.path[:0]=[entry for entry in sys.argv.pop(1).split(os.pathsep) if entry];"
                 "runpy.run_module('jumpcode_paystudio.engine',run_name='__main__')")


def _python_path():
    entries = [entry for entry in sys.path if entry and os.path.isdir(entry)]
    parent = str(Path(__file__).resolve().parent.parent)
    if parent not in entries:
        entries.insert(0, parent)
    return os.pathsep.join(entries)


def start(root, storage, settings):
    existing = running(root)
    if existing is not None:
        return existing, False
    data = Path(root) / "data"
    data.mkdir(parents=True, exist_ok=True)
    taken = {engine.port for engine in _engines.values()}
    last_error = "no free port between 4570 and 4599"
    for port in range(FIRST_PORT, LAST_PORT + 1):
        if port in taken or not _port_free(port):
            continue
        token = secrets.token_hex(24)
        command = [sys.executable, "-c", _ENGINE_START, _python_path(), "--studio", str(root), "--port", str(port), "--storage", storage,
                   "--spawned", repr(time.time())]
        environment = {k: v for k, v in os.environ.items() if k.upper() not in ("PYTHONSTARTUP", "PYTHONINSPECT")}
        environment.update({"PYTHONPATH": _python_path(), "PYTHONIOENCODING": "utf-8", "PYTHONDONTWRITEBYTECODE": "1"})
        with open(data / "engine.log", "ab") as log:
            process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, env=environment,
                                       creationflags=NO_WINDOW, close_fds=True)
        # The token and the settings (with the test secrets) go through the pipe, never the command line.
        process.stdin.write((token + "\n" + json.dumps(settings, ensure_ascii=False) + "\n").encode("utf-8"))
        process.stdin.flush()
        try:
            line = _first_line(process, 20)
        except Exception:
            _stop_process(process)
            raise
        try:
            answer = json.loads(line or "{}")
        except ValueError:
            answer = {}
        if answer.get("ready"):
            engine = Engine(Path(root), process, port, token, storage)
            engine.ready_ms = answer.get("readyMs")
            with _lock:
                _engines[_key(root)] = engine
            return engine, True
        _stop_process(process)
        if answer.get("error") == "port":
            last_error = answer.get("message", last_error)
            continue
        tail = (data / "engine.log").read_text(encoding="utf-8", errors="replace")[-1200:] if (data / "engine.log").exists() else ""
        raise PayStudioError("The payment gateway could not start." + (f" Engine log: {tail}" if tail else ""))
    raise PayStudioError(f"The payment gateway could not start: {last_error}")


def _first_line(process, timeout):
    result = []
    reader = threading.Thread(target=lambda: result.append(process.stdout.readline().decode("utf-8", "replace")), daemon=True)
    reader.start()
    deadline = time.monotonic() + timeout
    while reader.is_alive() and time.monotonic() < deadline:
        checkpoint()
        reader.join(0.05)
    checkpoint()
    return result[0] if result else ""


def stop(root):
    engine = running(root)
    if engine is None:
        return False
    try:
        engine.call("shutdown", timeout=5)
    except PayStudioError:
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
