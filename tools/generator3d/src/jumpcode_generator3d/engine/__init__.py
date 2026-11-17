# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Finds the foto-para-rig engine on this computer and runs ``runner.py`` with the engine's own interpreter.

The engine (TripoSR in ONNX, background removal, RTMPose, the Mesh2Motion skeleton and animations) needs NumPy,
SciPy and ONNX Runtime, which the agent's Python does not have, so every call is a separate process that talks one
JSON object per line. The package never imports the engine."""

from dataclasses import dataclass
import json
import os
from pathlib import Path
import queue
import subprocess
import threading
import time

from ..common import Cancelled, GeneratorError, read_json

RUNNER = Path(__file__).with_name("runner.py")
NO_WINDOW = 0x08000000 if os.name == "nt" else 0
ENV_ROOT = "JUMPCODE_GENERATOR3D_ENGINE"
REQUIRED_MODELS = ("triposr-encoder.onnx", "triposr-decoder.onnx", "triposr-grid.onnx", "u2netp.onnx", "rtmpose-m-body7-256x192.onnx")
STRIPPED = ("PYTHONHOME", "PYTHONPATH", "PYTHONSTARTUP", "PYTHONSAFEPATH", "PYTHONINSPECT", "VIRTUAL_ENV", "CONDA_PREFIX",
            "FOTORIG_", "JUMPCODE_", "_OLD_VIRTUAL")
MAX_STDERR = 64 * 1024


class EngineMissing(GeneratorError):
    """The engine is not installed or is incomplete; ``fix`` says what to do."""

    def __init__(self, problem, fix):
        super().__init__(problem + " " + fix)
        self.problem = problem
        self.fix = fix


class EngineFailed(GeneratorError):
    """The engine ran and reported an error (``kind`` is the engine's error class name when it gave one)."""

    def __init__(self, message, kind=None):
        super().__init__(message)
        self.kind = kind


@dataclass(frozen=True)
class Engine:
    root: Path
    python: Path
    layout: str

    def key(self):
        """Changes when the engine or its interpreter changes, to refresh cached facts."""
        stamps = []
        for path in (self.python, self.root / "fotorig" / "__init__.py", self.root / "fotorig" / "pipeline.py"):
            try:
                stamps.append(int(path.stat().st_mtime))
            except OSError:
                stamps.append(0)
        return f"{self.root}|{self.layout}|{'-'.join(map(str, stamps))}"


def _home():
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    return Path(base) / "JumpCode" / "tools" / "generator3d"


def _candidates():
    configured = os.environ.get(ENV_ROOT, "").strip()
    if configured:
        yield Path(configured), f"the folder in {ENV_ROOT}"
    home = _home()
    pointer = read_json(home / "engine.json")
    if isinstance(pointer, dict) and isinstance(pointer.get("root"), str) and pointer["root"].strip():
        yield Path(pointer["root"].strip()), str(home / "engine.json")
    yield home / "engine", str(home / "engine")
    yield home / "engine" / "foto-para-rig", str(home / "engine" / "foto-para-rig")


def _interpreter(root):
    for layout, python in (("package", root / "python.exe"), ("development", root / ".venv" / "Scripts" / "python.exe"),
                           ("development", root / ".venv" / "bin" / "python")):
        if python.is_file():
            return layout, python
    return None, None


def locate():
    """The first complete engine, or EngineMissing saying what is missing where."""
    checked = []
    for root, origin in _candidates():
        if not root.is_dir():
            checked.append(origin)
            continue
        if not (root / "fotorig" / "pipeline.py").is_file():
            raise EngineMissing(f"The engine folder {root} ({origin}) has no fotorig program.",
                                "Point it at the foto-para-rig folder or extract the foto-para-rig Windows package there.")
        missing = [name for name in REQUIRED_MODELS if not (root / "models" / name).is_file()]
        if missing:
            raise EngineMissing(f"The engine in {root} is missing the models {', '.join(missing)}.",
                                "Run foto-para-rig's tools\\fetch_models.py, fetch_pose_model.py and export_triposr.py, or reinstall its package.")
        if not (root / "assets" / "human").is_dir():
            raise EngineMissing(f"The engine in {root} is missing assets\\human (skeleton and animations).",
                                "Run foto-para-rig's tools\\import_animations.py or reinstall its package.")
        layout, python = _interpreter(root)
        if python is None:
            raise EngineMissing(f"The engine in {root} has no Python interpreter (python.exe or .venv).",
                                "Run foto-para-rig's tools\\setup-env.cmd or reinstall its package.")
        return Engine(root, python, layout)
    raise EngineMissing("The 3D engine (foto-para-rig) is not installed on this computer.",
                        f"Extract the foto-para-rig Windows package into {_home() / 'engine'}, or write "
                        f"{_home() / 'engine.json'} with {{\"root\": \"<foto-para-rig folder>\"}}.")


def _environment():
    environment = {key: value for key, value in os.environ.items() if not key.upper().startswith(STRIPPED)}
    environment.update({"PYTHONIOENCODING": "utf-8", "PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUTF8": "1"})
    return environment


def _kill(process):
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(process.pid)], capture_output=True, creationflags=NO_WINDOW)
    else:
        process.kill()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        pass


def call(engine, request, on_event=None, cancelled=None, timeout=600):
    """Runs one request in a new engine process and returns the ``result`` event. ``on_event`` sees progress events;
    ``cancelled`` is polled and stops the process tree."""
    payload = json.dumps({**request, "engine_root": str(engine.root)}, ensure_ascii=False)
    try:
        process = subprocess.Popen([str(engine.python), "-B", "-s", str(RUNNER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, cwd=str(engine.root), env=_environment(), creationflags=NO_WINDOW,
                                   close_fds=True)
    except OSError as error:
        raise EngineFailed(f"The 3D engine could not start ({error}).") from error
    lines = queue.Queue()
    errors = bytearray()

    def read_stdout():
        for raw in process.stdout:
            lines.put(raw)
        lines.put(None)

    def read_stderr():
        for raw in process.stderr:
            if len(errors) < MAX_STDERR:
                errors.extend(raw[: MAX_STDERR - len(errors)])

    threads = [threading.Thread(target=read_stdout, daemon=True), threading.Thread(target=read_stderr, daemon=True)]
    for thread in threads:
        thread.start()
    try:
        process.stdin.write(payload.encode("utf-8"))
        process.stdin.close()
    except OSError:
        pass
    deadline = time.monotonic() + timeout
    result = failure = None
    try:
        while True:
            if cancelled is not None and cancelled():
                _kill(process)
                raise Cancelled("The operation was cancelled; the engine was stopped and nothing was saved.")
            if time.monotonic() > deadline:
                _kill(process)
                raise EngineFailed(f"The 3D engine did not finish in {timeout} s and was stopped.")
            try:
                raw = lines.get(timeout=0.2)
            except queue.Empty:
                continue
            if raw is None:
                break
            try:
                event = json.loads(raw.decode("utf-8", "replace"))
            except ValueError:
                continue
            if not isinstance(event, dict):
                continue
            kind = event.get("event")
            if kind == "result":
                result = event
            elif kind == "error":
                failure = event
            elif on_event is not None:
                on_event(event)
        try:
            process.wait(timeout=30)
        except subprocess.TimeoutExpired:
            _kill(process)
    finally:
        if process.poll() is None:
            _kill(process)
        for thread in threads:
            thread.join(timeout=2)
        for stream in (process.stdout, process.stderr):
            try:
                stream.close()
            except OSError:
                pass
    if failure is not None:
        raise EngineFailed(str(failure.get("message") or "The 3D engine failed."), failure.get("kind"))
    if result is None:
        tail = errors.decode("utf-8", "replace").strip().splitlines()[-6:]
        detail = (" Last lines: " + " | ".join(tail)) if tail else ""
        raise EngineFailed(f"The 3D engine stopped without an answer (exit code {process.returncode}).{detail}")
    return result
