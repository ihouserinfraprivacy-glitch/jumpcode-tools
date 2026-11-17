# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""The plan model: new tasks and gates, checks of loaded files, the dependency graph and outlines."""

import re

from .common import PLAN_FILE, PROPOSAL_FILE, DamagedFile, TaskStudioError, clean_text, task_id

STATES = ("todo", "running", "paused", "done", "failed", "skipped")
GATE_KINDS = ("secret", "approval", "choice", "other")
LOG_KINDS = ("info", "ok", "error")
FILE_STATES = ("done", "partial")
CHANGE_KINDS = ("refazer", "ajustar", "alterar", "nova", "remover")
MODES = ("map", "list", "board", "timeline", "lanes", "metro", "focus", "history")
SATISFIED = ("done", "skipped")

MAX_TASKS = 60
MAX_DEPS = 12
MAX_GATES = 6
MAX_CRITERIA = 20
MAX_LOG = 40
MAX_FILES = 40
MAX_VERSIONS = 30
MAX_OPTIONS = 4

# Characters kept for each text; longer texts are cut (see CONTRACT.md).
LIMITS = {
    "planTitle": 80, "request": 2000, "title": 60, "summary": 90, "detail": 1200, "criterion": 160,
    "area": 40, "phase": 60, "note": 200, "log": 200, "result": 600, "problem": 120, "problemDetail": 600,
    "option": 80, "label": 80, "where": 300, "env": 64, "text": 600, "proposalSummary": 300,
    "changeNote": 300, "why": 40, "path": 240, "gate": 80,
}
MAX_ESTIMATE = 10_000


# --- Building tasks -------------------------------------------------------------------------------

def make_gates(specs, previous=()):
    """Keep satisfaction only for the same complete requirement, never just its display label."""
    def identity(gate):
        return (gate.get("label", "").casefold(), gate.get("kind") or ("secret" if gate.get("env") else "other"),
                gate.get("env", ""), gate.get("where", ""), tuple(gate.get("alternatives", [])))
    met = {identity(gate): gate.get("met") is True for gate in previous}
    gates = []
    for number, spec in enumerate(specs, 1):
        gate = {"id": f"g{number}", "kind": spec.get("kind") or ("secret" if spec.get("env") else "other"),
                "label": spec["label"], "met": met.get(identity(spec), False)}
        for key in ("where", "env", "alternatives"):
            if spec.get(key):
                gate[key] = list(spec[key]) if key == "alternatives" else spec[key]
        gates.append(gate)
    return gates


def next_gate_id(task):
    numbers = [int(gate["id"][1:]) for gate in task["gates"]
               if isinstance(gate.get("id"), str) and gate["id"][1:].isdigit()]
    return f"g{max(numbers, default=0) + 1}"


def criteria_list(texts):
    return [{"text": text, "done": False} for text in texts]


def summary_from(detail):
    """The card line of a task the model gave no summary: the first sentence of its detail."""
    first = re.split(r"(?<=[.!?])\s|\n", detail.strip(), maxsplit=1)[0] if detail else ""
    return clean_text(first.rstrip("."), LIMITS["summary"]) or ""


def new_task(identifier, spec):
    """A task in state todo from a validated task specification."""
    task = {"id": identifier, "title": spec["title"], "summary": spec.get("summary") or summary_from(spec.get("detail", "")),
            "detail": spec.get("detail", ""), "criteria": criteria_list(spec.get("criteria", [])),
            "deps": list(spec.get("deps", [])), "gates": make_gates(spec.get("gates", []))}
    for key in ("area", "phase", "estimate"):
        if key in spec:
            task[key] = spec[key]
    task.update({"state": "todo", "problem": None, "log": [], "files": []})
    return task


def update_task(task, spec):
    """Take the fields a specification carries; empty fields were dropped by validation."""
    for key in ("title", "summary", "detail", "area", "phase", "estimate"):
        if key in spec:
            task[key] = spec[key]
    if not task.get("summary"):
        task["summary"] = summary_from(task.get("detail", ""))
    if "deps" in spec:
        task["deps"] = list(spec["deps"])
    if "criteria" in spec:
        task["criteria"] = criteria_list(spec["criteria"])
    if "gates" in spec:
        task["gates"] = make_gates(spec["gates"], task["gates"])


# --- Checking files read from disk ----------------------------------------------------------------

def _list_of(value, check):
    return [item for item in value if check(item)] if isinstance(value, list) else []


def _is_text_item(key):
    return lambda item: isinstance(item, dict) and isinstance(item.get(key), str)


def _int(value, minimum, default):
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= minimum else default


def _check_task(item):
    if not isinstance(item, dict) or not isinstance(item.get("title"), str):
        raise DamagedFile(PLAN_FILE)
    try:
        identifier = task_id(item.get("id"))
    except TaskStudioError:
        raise DamagedFile(PLAN_FILE) from None
    task = dict(item)
    task["id"] = identifier
    task["state"] = item.get("state", "todo")
    if task["state"] not in STATES:
        raise DamagedFile(PLAN_FILE)
    for key in ("summary", "detail"):
        if not isinstance(task.get(key), str):
            task[key] = ""
    task["criteria"] = [{"text": entry["text"], "done": entry.get("done") is True}
                        for entry in _list_of(item.get("criteria"), _is_text_item("text"))]
    deps = []
    for value in item.get("deps") if isinstance(item.get("deps"), list) else []:
        try:
            dep = task_id(value)
        except TaskStudioError:
            continue
        if dep not in deps:
            deps.append(dep)
    task["deps"] = deps
    gates = []
    for number, gate in enumerate(_list_of(item.get("gates"), _is_text_item("label")), 1):
        gate = dict(gate)
        gate["id"] = gate["id"] if isinstance(gate.get("id"), str) and gate["id"] else f"g{number}"
        gate["kind"] = gate["kind"] if gate.get("kind") in GATE_KINDS else "other"
        gate["met"] = gate.get("met") is True
        gates.append(gate)
    task["gates"] = gates
    task["log"] = _list_of(item.get("log"), _is_text_item("text"))[-MAX_LOG:]
    task["files"] = _list_of(item.get("files"), _is_text_item("path"))
    task["problem"] = item["problem"] if isinstance(item.get("problem"), dict) else None
    if "progress" in task and not (isinstance(task["progress"], int) and 0 <= task["progress"] <= 100):
        del task["progress"]
    return task


def check_plan(data):
    """Validate a plan read from disk and fill defaults; DamagedFile when it cannot be used."""
    tasks = data.get("tasks")
    if not isinstance(tasks, list) or len(tasks) > MAX_TASKS * 4:
        raise DamagedFile(PLAN_FILE)
    checked = [_check_task(item) for item in tasks]
    known = {task["id"] for task in checked}
    if len(known) != len(checked):
        raise DamagedFile(PLAN_FILE)
    for task in checked:
        task["deps"] = [dep for dep in task["deps"] if dep in known and dep != task["id"]]
    if find_cycle({task["id"]: task["deps"] for task in checked}):
        raise DamagedFile(PLAN_FILE)
    plan = dict(data)
    plan["tasks"] = checked
    plan["revision"] = _int(data.get("revision"), 0, 0)
    plan["plan"] = _int(data.get("plan"), 1, 1)
    for key in ("title", "request", "createdAt", "updatedAt"):
        if not isinstance(plan.get(key), str):
            plan[key] = ""
    plan["draft"] = data.get("draft") is True
    plan["started"] = data.get("started") is True
    highest = max((int(identifier) for identifier in known), default=0)
    plan["nextId"] = max(_int(data.get("nextId"), 1, 1), highest + 1)
    recalibrating = data.get("recalibrating")
    if not (isinstance(recalibrating, dict) and recalibrating.get("task") in known):
        recalibrating = None
    plan["recalibrating"] = recalibrating
    return plan


def check_proposal(data):
    """Validate a proposal read from disk; DamagedFile when apply cannot trust it."""
    def need(condition):
        if not condition:
            raise DamagedFile(PROPOSAL_FILE)
    need(isinstance(data.get("changes"), list) and data["changes"])
    need(_int(data.get("plan"), 2, None) is not None and _int(data.get("base"), 1, None) is not None)
    need(isinstance(data.get("states"), dict))
    seen = set()
    for change in data["changes"]:
        need(isinstance(change, dict) and change.get("kind") in CHANGE_KINDS and isinstance(change.get("task"), str))
        need(change["task"] not in seen)
        seen.add(change["task"])
        if change["kind"] == "nova":
            need(isinstance(change.get("title"), str) and change["title"])
        else:
            need(data["states"].get(change["task"]) in STATES)
        need(all(isinstance(change[key], str) for key in ("title", "summary", "detail", "area", "phase", "note", "why")
                 if key in change))
        need("estimate" not in change or _int(change["estimate"], 0, None) is not None)
        deps = change.get("deps", [])
        need(isinstance(deps, list) and all(isinstance(dep, str) for dep in deps))
        need(isinstance(change.get("criteria", []), list) and isinstance(change.get("gates", []), list))
        need(all(_is_text_item("text")(item) for item in change.get("criteria", [])))
        need(all(_is_text_item("label")(item) for item in change.get("gates", [])))
    return data


# --- The dependency graph -------------------------------------------------------------------------

def index(plan):
    return {task["id"]: task for task in plan["tasks"]}


def waiting_for(tasks, task):
    """Dependencies of `task` that are neither done nor skipped."""
    return [dep for dep in task["deps"] if dep in tasks and tasks[dep]["state"] not in SATISFIED]


def unmet_gates(task):
    return [gate for gate in task["gates"] if not gate.get("met")]


def is_ready(tasks, task):
    return task["state"] == "todo" and not waiting_for(tasks, task) and not unmet_gates(task)


def ready_ids(plan):
    tasks = index(plan)
    return [task["id"] for task in plan["tasks"] if is_ready(tasks, task)]


def dependents(plan, identifier):
    """Tasks that list `identifier` among their dependencies."""
    return [task["id"] for task in plan["tasks"] if identifier in task["deps"]]


def downstream(plan, identifier):
    """Every task that depends on `identifier`, directly or not, in plan order."""
    found, pending = set(), [identifier]
    while pending:
        current = pending.pop()
        for task in plan["tasks"]:
            if current in task["deps"] and task["id"] not in found and task["id"] != identifier:
                found.add(task["id"])
                pending.append(task["id"])
    return [task["id"] for task in plan["tasks"] if task["id"] in found]


def find_cycle(graph):
    """A dependency cycle as a list of ids that starts and ends with the same id, or None."""
    marks = {}
    for start in graph:
        if marks.get(start):
            continue
        marks[start] = 1
        path, stack = [start], [iter(graph[start])]
        while stack:
            for child in stack[-1]:
                if child not in graph:
                    continue
                if marks.get(child) == 1:
                    return path[path.index(child):] + [child]
                if not marks.get(child):
                    marks[child] = 1
                    path.append(child)
                    stack.append(iter(graph[child]))
                    break
            else:
                marks[path.pop()] = 2
                stack.pop()
    return None


def check_graph(graph, labels):
    """Refuse unknown, self and too many dependencies, and cycles, naming the tasks involved."""
    for identifier, deps in graph.items():
        if len(deps) > MAX_DEPS:
            raise TaskStudioError(f"{labels(identifier)} has {len(deps)} dependencies; a task can have at most "
                                  f"{MAX_DEPS}.")
        for dep in deps:
            if dep == identifier:
                raise TaskStudioError(f"{labels(identifier)} cannot depend on itself; remove #{dep} from its deps.")
            if dep not in graph:
                raise TaskStudioError(f"{labels(identifier)} depends on #{dep}, which is not in the plan. Deps are "
                                      "task numbers: tasks are numbered 1, 2, 3... in plan order.")
    cycle = find_cycle(graph)
    if cycle:
        chain = ", which waits for ".join(f"#{identifier}" for identifier in cycle)
        raise TaskStudioError(f"The deps make a cycle: {chain}. Remove one of these deps.")


# --- Words for the model --------------------------------------------------------------------------

def group(task):
    """The display group used by recalibrations: done, running (or paused) and todo."""
    if task["state"] == "done":
        return "done"
    return "running" if task["state"] in ("running", "paused") else "todo"


def change_kind(task):
    """The kind of a change, derived from the state of the task (never from the model)."""
    return {"done": "refazer", "running": "ajustar", "paused": "ajustar"}.get(task["state"], "alterar")


def not_started(task):
    """True when removing the task loses no work."""
    return task["state"] in ("todo", "skipped") and not task.get("startedAt") and not task.get("files")


def status(tasks, task):
    """A short English status for outlines: done, running 40%, waiting, needs user, ready..."""
    state = task["state"]
    if state == "running":
        return f"running {task['progress']}%" if isinstance(task.get("progress"), int) else "running"
    if state == "failed":
        problem = task.get("problem") or {}
        return f"failed: {problem['title']}" if isinstance(problem.get("title"), str) and problem["title"] else "failed"
    if state != "todo":
        return state
    if waiting_for(tasks, task):
        return "waiting"
    gates = unmet_gates(task)
    if gates:
        more = f" +{len(gates) - 1}" if len(gates) > 1 else ""
        return f"needs user: {gates[0]['label']}{more}"
    return "ready"


def brief(task):
    return f"#{task['id']} {task['title']}"


def names(tasks, identifiers, limit=6):
    """'#6 Tela de agendamento, #7 Pagamento' for at most `limit` tasks."""
    parts = [brief(tasks[identifier]) for identifier in identifiers[:limit] if identifier in tasks]
    if len(identifiers) > limit:
        parts.append(f"and {len(identifiers) - limit} more")
    return ", ".join(parts)


def counts(plan):
    tasks = index(plan)
    result = {"total": len(plan["tasks"]), "done": 0, "running": 0, "paused": 0, "failed": 0, "skipped": 0,
              "ready": 0, "waiting": 0, "needsUser": 0}
    for task in plan["tasks"]:
        if task["state"] != "todo":
            result[task["state"]] += 1
        elif waiting_for(tasks, task):
            result["waiting"] += 1
        elif unmet_gates(task):
            result["needsUser"] += 1
        else:
            result["ready"] += 1
    return result


def task_line(tasks, task):
    line = f"#{task['id']} {task['title']} [{status(tasks, task)}]"
    if task["deps"]:
        line += " deps " + ", ".join(f"#{dep}" for dep in task["deps"])
    return line


def outline(plan):
    """One line per task, such as '#3 Modelar o banco [done] deps #2'."""
    tasks = index(plan)
    return "\n".join(task_line(tasks, task) for task in plan["tasks"])


def snapshot(plan):
    """The light copy of the tasks kept in each history version."""
    return [{"id": task["id"], "title": task["title"], "summary": task["summary"], "state": task["state"],
             "deps": list(task["deps"])} for task in plan["tasks"]]


def find_task(plan, identifier):
    """The task with this id, or an error that tells the model how to find the right one."""
    for task in plan["tasks"]:
        if task["id"] == identifier:
            return task
    if not plan["tasks"]:
        raise TaskStudioError(f"There is no task #{identifier}: the plan has no tasks yet.")
    raise TaskStudioError(f"There is no task #{identifier}. Call read to see the task numbers.")
