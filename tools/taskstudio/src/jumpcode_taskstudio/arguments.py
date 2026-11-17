# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Validation of the model's arguments: a normalized copy, without touching the disk or the input."""

import math
import re

from .common import TaskStudioError, clean_text, task_id
from .plan import (FILE_STATES, GATE_KINDS, LIMITS, LOG_KINDS, MAX_CRITERIA, MAX_DEPS, MAX_ESTIMATE, MAX_FILES,
                   MAX_GATES, MAX_OPTIONS, MAX_TASKS, MODES)

ACTIONS = ("plan", "read", "start", "progress", "finish", "fail", "need", "resolve", "skip", "pause", "edit",
           "propose", "apply", "discard", "focus")
FIELDS = {
    "plan": ("title", "request", "tasks", "draft"),
    "read": ("id",),
    "start": ("id", "note"),
    "progress": ("id", "note", "percent", "log", "kind", "files"),
    "finish": ("id", "result", "criteria", "files"),
    "fail": ("id", "problem", "detail", "options"),
    "need": ("id", "kind", "label", "where", "env", "alternatives"),
    "resolve": ("id", "gate", "note"),
    "skip": ("id", "note"),
    "pause": ("id",),
    "edit": ("id", "text", "title", "summary", "detail", "criteria"),
    "propose": ("summary", "changes", "extra"),
    "apply": (),
    "discard": (),
    "focus": ("id", "mode", "note"),
}
REQUIRED = {"start": ("id",), "progress": ("id",), "finish": ("id",), "fail": ("id", "problem"),
            "need": ("id", "label"), "resolve": ("id",), "skip": ("id",), "edit": ("id", "text")}
TASK_FIELDS = ("title", "summary", "detail", "deps", "area", "phase", "estimate", "criteria", "gates")
CHANGE_FIELDS = ("task", "note", "why", "title", "summary", "detail", "deps", "area", "phase", "estimate", "criteria",
                 "gates", "remove")
GATE_FIELDS = ("kind", "label", "where", "env", "alternatives")
MAX_CHANGES = MAX_TASKS
_ALL = {"action"}.union(*FIELDS.values())
_ENV = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,63}")
_DRIVE = re.compile(r"[A-Za-z]:")
# Multi-line texts keep their line breaks; the others become one line.
_LINES = {"request", "detail", "problemDetail", "result", "text", "proposalSummary", "changeNote"}


def _present(value):
    """Omitted/null means unchanged; an explicit list, including [], is a replacement."""
    return {key: item for key, item in value.items() if item is not None and item != "" and item != {}}


def _text(value, field, limit_key):
    text = clean_text(value, LIMITS[limit_key], lines=limit_key in _LINES)
    if text is None:
        raise TaskStudioError(f"{field} must be text")
    return text


def _flag(value, field):
    if isinstance(value, bool):
        return value
    if isinstance(value, str) and value.strip().lower() in ("true", "false", "yes", "no", "1", "0"):
        return value.strip().lower() in ("true", "yes", "1")
    raise TaskStudioError(f"{field} must be true or false")


def _integer(value, field, minimum, maximum):
    """A whole number such as 40, 40.0, "40" or "40%", kept inside [minimum, maximum]."""
    number = None
    if isinstance(value, bool):
        number = None
    elif isinstance(value, int):
        number = value
    elif isinstance(value, float) and math.isfinite(value):
        number = round(value)
    elif isinstance(value, str):
        match = re.fullmatch(r"\s*(-?\d{1,7})(?:[.,]\d+)?\s*%?\s*", value)
        number = int(match.group(1)) if match else None
    if number is None:
        raise TaskStudioError(f"{field} must be a whole number")
    return min(max(number, minimum), maximum)


def _choice(value, field, choices):
    if not isinstance(value, str) or value.strip().lower() not in choices:
        raise TaskStudioError(f"{field} must be one of: {', '.join(choices)}")
    return value.strip().lower()


def _list(value, field, limit):
    if isinstance(value, (str, int, dict)) and not isinstance(value, bool):
        value = [value]
    if not isinstance(value, list):
        raise TaskStudioError(f"{field} must be a list")
    value = [item for item in value if item is not None and item != ""]
    if len(value) > limit:
        raise TaskStudioError(f"{field} has {len(value)} items; at most {limit} are allowed")
    return value


def _texts(value, field, limit, limit_key):
    result = []
    for item in _list(value, field, limit):
        if isinstance(item, dict) and "text" in item:
            item = item["text"]
        text = _text(item, field, limit_key)
        if text and text not in result:
            result.append(text)
    return result


def _deps(value, field="deps"):
    result = []
    for item in _list(value, field, MAX_DEPS):
        dep = task_id(item, field)
        if dep not in result:
            result.append(dep)
    return result


def _object(value, field, allowed):
    if not isinstance(value, dict):
        raise TaskStudioError(f"Each item of {field} must be an object")
    value = _present(value)
    unknown = set(value) - set(allowed)
    if unknown:
        raise TaskStudioError(f"Unknown fields in {field}: {', '.join(sorted(map(str, unknown)))}. "
                              f"Each item takes {', '.join(allowed)}.")
    return value


def _path(value):
    state = None
    if isinstance(value, dict):
        state = value.get("state")
        value = value.get("path")
    path = clean_text(value, 1000)
    if not path:
        raise TaskStudioError("files must be project paths such as src/app.ts")
    path = re.sub(r"/{2,}", "/", path.replace("\\", "/")).rstrip("/")
    while path.startswith("./"):
        path = path[2:]
    if (not path or path.startswith("/") or _DRIVE.match(path) or ".." in path.split("/")
            or len(path) > LIMITS["path"]):
        raise TaskStudioError(f"files must be paths relative to the project, such as src/app.ts (got '{path[:80]}')")
    entry = {"path": path}
    if state is not None:
        entry["state"] = _choice(state, "files state", FILE_STATES)
    return entry


def _files(value):
    result = {}
    for item in _list(value, "files", MAX_FILES):
        entry = _path(item)
        result[entry["path"]] = entry
    return list(result.values())


def _gate(value):
    item = _object(value, "gates", GATE_FIELDS)
    if "label" not in item:
        raise TaskStudioError("Each gate needs a label, such as 'Chave Pix de teste'")
    gate = {"label": _text(item["label"], "label", "label")}
    if "env" in item:
        gate["env"] = _env(item["env"])
    gate["kind"] = _choice(item["kind"], "kind", GATE_KINDS) if "kind" in item else (
        "secret" if "env" in gate else "other")
    if "where" in item:
        gate["where"] = _text(item["where"], "where", "where")
    if "alternatives" in item:
        gate["alternatives"] = _texts(item["alternatives"], "alternatives", MAX_OPTIONS, "option")
    return _present(gate)


def _env(value):
    if not isinstance(value, str) or not _ENV.fullmatch(value.strip()):
        raise TaskStudioError("env must be only a variable name such as PIX_KEY, never its value")
    return value.strip()


def _gates(value):
    gates = [_gate(item) for item in _list(value, "gates", MAX_GATES)]
    labels = [gate["label"].casefold() for gate in gates]
    if len(set(labels)) != len(labels):
        raise TaskStudioError("Two gates of the same task have the same label")
    return gates


def _common(item, spec, where):
    """Fields shared by the tasks of `plan` and the changes of `propose`."""
    for key, limit_key in (("title", "title"), ("summary", "summary"), ("detail", "detail"), ("area", "area"),
                           ("phase", "phase")):
        if key in item:
            spec[key] = _text(item[key], key, limit_key)
    if "deps" in item:
        spec["deps"] = _deps(item["deps"], f"deps of {where}")
    if "estimate" in item:
        spec["estimate"] = _integer(item["estimate"], "estimate", 0, MAX_ESTIMATE)
    if "criteria" in item:
        spec["criteria"] = _texts(item["criteria"], "criteria", MAX_CRITERIA, "criterion")
    if "gates" in item:
        spec["gates"] = _gates(item["gates"])
    return _present(spec)


def _task(value, position):
    item = _object(value, "tasks", TASK_FIELDS)
    spec = _common(item, {}, f"task {position}")
    if not spec.get("title"):
        raise TaskStudioError(f"Task {position} of tasks needs a title")
    return spec


def _change(value):
    item = _object(value, "changes", CHANGE_FIELDS)
    spec = {}
    if "task" in item:
        spec["task"] = task_id(item["task"], "task")
    where = f"#{spec['task']}" if "task" in spec else "a new task"
    if "note" in item:
        spec["note"] = _text(item["note"], "note", "changeNote")
    if "why" in item:
        spec["why"] = _text(item["why"], "why", "why")
    if "remove" in item:
        spec["remove"] = _flag(item["remove"], "remove")
        if not spec["remove"]:
            del spec["remove"]
    return _common({key: item[key] for key in item if key in TASK_FIELDS}, spec, where)


def _field(action, key, value):
    if key == "id":
        return task_id(value)
    if key == "title":
        return _text(value, key, "planTitle" if action == "plan" else "title")
    if key == "summary":
        return _text(value, key, "proposalSummary" if action == "propose" else "summary")
    if key == "detail":
        return _text(value, key, "problemDetail" if action == "fail" else "detail")
    if key in ("request", "note", "log", "result", "problem", "label", "where", "gate", "text"):
        return _text(value, key, key)
    if key == "env":
        return _env(value)
    if key == "draft":
        return _flag(value, key)
    if key == "percent":
        return _integer(value, key, 0, 100)
    if key == "extra":
        return _integer(value, key, -MAX_ESTIMATE, MAX_ESTIMATE)
    if key == "kind":
        return _choice(value, key, LOG_KINDS if action == "progress" else GATE_KINDS)
    if key == "mode":
        return _choice(value, key, MODES)
    if key == "files":
        return _files(value)
    if key == "criteria":
        return _texts(value, key, MAX_CRITERIA, "criterion")
    if key in ("options", "alternatives"):
        return _texts(value, key, MAX_OPTIONS, "option")
    if key == "tasks":
        return [_task(item, position) for position, item in enumerate(_list(value, key, MAX_TASKS), 1)]
    if key == "changes":
        return [_change(item) for item in _list(value, key, MAX_CHANGES)]
    raise TaskStudioError(f"Unknown argument {key}")


def validate(arguments):
    """Return a normalized copy of the arguments; never touches the disk or the caller's data."""
    if not isinstance(arguments, dict):
        raise TaskStudioError("Arguments must be an object")
    unknown = set(arguments) - _ALL
    if unknown:
        raise TaskStudioError("Unknown arguments: " + ", ".join(sorted(map(str, unknown))))
    action = arguments.get("action")
    action = action.strip().lower() if isinstance(action, str) else action
    if action not in ACTIONS:
        raise TaskStudioError("action must be one of: " + ", ".join(ACTIONS))
    given = _present({key: value for key, value in arguments.items() if key != "action"})
    if action in ("apply", "discard"):
        # These take nothing; a stray id or note does no harm.
        given = {}
    extra = set(given) - set(FIELDS[action])
    if extra:
        allowed = ", ".join(FIELDS[action]) or "no other fields"
        raise TaskStudioError(f"{', '.join(sorted(extra))} not used by {action}; it takes {allowed}")
    result = {"action": action}
    for key in FIELDS[action]:
        if key in given:
            value = _field(action, key, given[key])
            if value != "":
                result[key] = value
    for key in REQUIRED.get(action, ()):
        if key not in result:
            raise TaskStudioError(f"{action} needs {key}")
    if action == "focus" and "id" not in result and "mode" not in result:
        raise TaskStudioError("focus needs id or mode")
    if action == "progress" and not {"note", "percent", "log", "files"} & set(result):
        raise TaskStudioError("progress needs note, percent, log or files")
    if action == "progress" and "kind" in result and "log" not in result and "note" not in result:
        del result["kind"]
    return result
