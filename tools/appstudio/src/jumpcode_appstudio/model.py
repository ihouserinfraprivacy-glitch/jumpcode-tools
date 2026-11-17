# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""The app in the project: appstudio.json (the source of truth), index.html (rewritten after every change) and the
last versions. Every change goes through save(), which bumps the revision, keeps a version and rewrites index.html."""

from pathlib import Path
import time

from . import render
from .common import AppStudioError, project_folder, read_json, write_json, write_text

MODEL = "appstudio.json"
VERSIONS = ".appstudio/versoes"
KEEP_VERSIONS = 60
SEARCH = ("app", "app-mobile", "mobile", "aplicativo")


def find(project, preferred=None):
    """The app folder (relative) in the project, or None. The preferred folder wins when it has an app."""
    candidates = [preferred] if preferred else []
    candidates += list(SEARCH)
    for name in candidates:
        if name and (Path(project) / name / MODEL).is_file():
            return name
    try:
        for child in sorted(Path(project).iterdir()):
            if child.is_dir() and not child.name.startswith(".") and (child / MODEL).is_file():
                return child.name
    except OSError:
        pass
    return None


def free_folder(project):
    """Where a new app goes: app, unless the project already uses app for something else."""
    for name in SEARCH:
        folder = Path(project) / name
        if not folder.exists() or (folder / MODEL).is_file():
            return name
    return "app-mobile-" + str(int(time.time()))[-4:]


def empty(name, app_id, theme):
    return {"format": 1, "revision": 0, "name": name, "id": app_id, "start": None, "theme": {**render.DEFAULT_THEME, **theme},
            "tabs": [], "screens": [], "styles": [], "data": {}, "published": False, "updated": time.time()}


def load(project, folder):
    path = project_folder(project, folder) / MODEL
    app = read_json(path)
    if not isinstance(app, dict) or app.get("format") != 1:
        raise AppStudioError(f"{folder}/{MODEL} is missing or unreadable. Call start to create the app.")
    app.setdefault("tabs", [])
    app.setdefault("screens", [])
    app.setdefault("styles", [])
    app.setdefault("data", {})
    app["theme"] = {**render.DEFAULT_THEME, **(app.get("theme") or {})}
    return app


def save(project, folder, app, summary):
    """Writes the new revision, keeps it as a version and rewrites index.html. Returns the files written."""
    root = project_folder(project, folder)
    root.mkdir(parents=True, exist_ok=True)
    app["revision"] = int(app.get("revision") or 0) + 1
    app["updated"] = time.time()
    if app.get("start") not in {screen["id"] for screen in app["screens"]}:
        app["start"] = (app["tabs"][0]["screen"] if app["tabs"] else (app["screens"][0]["id"] if app["screens"] else None))
    write_json(root / MODEL, app, pretty=True)
    versions = root / VERSIONS
    versions.mkdir(parents=True, exist_ok=True)
    write_json(versions / f"{app['revision']}.json", app)
    index = read_json(versions / "indice.json", []) or []
    index.append({"n": app["revision"], "at": app["updated"], "summary": summary, "screens": len(app["screens"])})
    for old in index[:-KEEP_VERSIONS]:
        try:
            (versions / f"{old['n']}.json").unlink()
        except OSError:
            pass
    index = index[-KEEP_VERSIONS:]
    write_json(versions / "indice.json", index)
    html = render.document(app, preview=False, published=bool(app.get("published")))
    write_text(root / "index.html", html)
    return [f"{folder}/{MODEL}", f"{folder}/index.html"]


def versions(project, folder):
    return read_json(project_folder(project, folder) / VERSIONS / "indice.json", []) or []


def version(project, folder, number):
    app = read_json(project_folder(project, folder) / VERSIONS / f"{int(number)}.json")
    if not isinstance(app, dict):
        kept = [item["n"] for item in versions(project, folder)]
        raise AppStudioError(f"Version {number} is not kept. The kept versions are {kept[0]} to {kept[-1]}." if kept else "There are no versions yet.")
    return app
