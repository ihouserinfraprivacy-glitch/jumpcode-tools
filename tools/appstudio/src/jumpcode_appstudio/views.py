# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""The Studio files: app.json (the app, its preview document and its map) and state.json (what to show, the part being
built, problems, versions, publishing and settings). See CONTRACT.md."""

import time

from . import checks, render
from .common import read_json, write_json

APP = "app.json"
STATE = "state.json"
VIEWS = ("preview", "screens", "map", "structure", "test", "states", "problems", "versions", "publish", "settings")
DEVICES = ("iphone", "android", "iphone-fold", "android-fold", "tablet")


def load_state(root):
    state = read_json(root / STATE, {}) or {}
    state.setdefault("version", 1)
    if state.get("view") not in VIEWS:
        state["view"] = "preview"
    focus = state.setdefault("focus", {})
    focus.setdefault("screen", None)
    focus.setdefault("part", None)
    focus.setdefault("state", "normal")
    if focus.get("device") not in DEVICES:
        focus["device"] = "iphone"
    focus.setdefault("frame", True)
    focus.setdefault("fold", "open")
    focus.setdefault("landscape", False)
    state.setdefault("building", None)
    state.setdefault("problems", [])
    state.setdefault("versions", [])
    state.setdefault("published", None)
    state.setdefault("notice", None)
    state.setdefault("settings", {"folder": None, "frame": True})
    return state


def save_state(root, state):
    state["updated"] = time.time()
    write_json(root / STATE, state)


def write_app(root, app, folder, files=None):
    """app.json for the interface; None clears it (no app yet)."""
    if app is None:
        write_json(root / APP, {})
        return None
    mapped = checks.routes(app)
    screens = []
    for screen in app.get("screens", []):
        written = [part["id"] for part in screen.get("parts", [])]
        screens.append({"id": screen["id"], "title": screen.get("title") or screen["id"], "route": screen.get("route") or "/" + screen["id"],
                        "kind": screen.get("kind", "stack"), "login": bool(screen.get("login")),
                        "parts": [{"id": part["id"], "bytes": len(part["html"].encode("utf-8"))} for part in render.ordered_parts(screen)],
                        "planned": [pid for pid in screen.get("plan", []) if pid not in written],
                        "states": ["normal"] + mapped["states"].get(screen["id"], [])})
    write_json(root / APP, {"revision": app.get("revision"), "name": app.get("name"), "id": app.get("id"), "folder": folder,
                            "start": app.get("start"), "theme": app.get("theme"), "tabs": app.get("tabs"), "screens": screens,
                            "styles": [{"name": block["name"], "bytes": len(block["css"].encode("utf-8"))} for block in app.get("styles", [])],
                            "data": app.get("data") or {}, "preview": render.document(app, preview=True),
                            "routes": {key: mapped[key] for key in ("edges", "deadEnds", "unreachable", "missing", "links")},
                            "files": files or []})
    return mapped
