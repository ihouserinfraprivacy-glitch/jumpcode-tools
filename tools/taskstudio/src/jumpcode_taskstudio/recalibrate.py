# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Changing a plan that is under way: edit records the change, propose lists what it touches,
apply turns the proposal into a new plan version, discard leaves the plan as it was."""

import json

from .common import PLAN_FILE, PROPOSAL_FILE, TaskStudioError, answer, clean_text
from .plan import (CHANGE_KINDS, LIMITS, MAX_TASKS, brief, change_kind, check_graph, criteria_list, downstream,
                   find_task, group, index, make_gates, names, new_task, not_started, outline, ready_ids, snapshot,
                   status)

_KIND_ORDER = {kind: position for position, kind in enumerate(CHANGE_KINDS)}
_FIELDS = ("title", "summary", "detail", "area", "phase", "estimate")
# Portuguese words of the proposal summary shown to the user: (one, many).
_SUMMARY_WORDS = {
    "refazer": ("{n} concluída será refeita", "{n} concluídas serão refeitas"),
    "ajustar": ("{n} em execução ajustada", "{n} em execução ajustadas"),
    "alterar": ("{n} muda antes de começar", "{n} mudam antes de começar"),
    "nova": ("{n} tarefa nova", "{n} tarefas novas"),
    "remover": ("{n} sai do plano", "{n} saem do plano"),
}
_ENGLISH = {"refazer": "to redo", "ajustar": "to adjust", "alterar": "to change", "nova": "new", "remover": "to remove"}


# --- edit -----------------------------------------------------------------------------------------

def edit(studio, args):
    """Record the user's change as `recalibrating`, pause running tasks and list the tasks it may touch."""
    plan = studio.plan()
    proposal = studio.proposal()
    task = find_task(plan, args["id"])
    previous = plan["recalibrating"]
    if previous and previous["task"] != task["id"]:
        raise TaskStudioError(f"A change to #{previous['task']} is still being recalibrated. Call propose for it "
                              "first; then edit this task.")
    if proposal and not (proposal.get("baseline") and previous):
        raise TaskStudioError(f"The proposal for plan v{proposal['plan']} waits for the user. Ask them to apply or "
                              "discard it before another change.")
    tasks = index(plan)
    kind = group(task)
    paused = [identifier for identifier in (previous or {}).get("paused", []) if identifier in tasks]
    for other in plan["tasks"]:
        if other["state"] == "running":
            other["state"] = "paused"
            other["pausedAt"] = studio.now
            studio.log(other, "Pausada para recalibrar o plano")
            paused.append(other["id"])
    after = {key: args[key] for key in ("title", "summary", "detail") if key in args}
    if "detail" not in after:
        # The model often passes only the user's words. A full description replaces the task's text; a short
        # remark is added to it, so redoing the task still sees both.
        words = args["text"]
        if not task["detail"] or len(words) >= 0.6 * len(task["detail"]):
            after["detail"] = words
        else:
            after["detail"] = clean_text(f"{task['detail']}\nMudança: {words}", LIMITS["detail"], lines=True)
    before = {"title": task["title"], "summary": task["summary"], "detail": task["detail"]}
    if "criteria" in args:
        after["criteria"] = criteria_list(args["criteria"])
        before["criteria"] = [dict(item) for item in task["criteria"]]
    impact = {"done": [], "running": [], "todo": []}
    affected = downstream(plan, task["id"])
    for identifier in affected:
        impact[group(tasks[identifier])].append(identifier)
    plan["recalibrating"] = {"task": task["id"], "kind": kind, "text": args["text"], "before": before, "after": after,
                             "at": studio.now, "paused": paused, "impact": impact, "requestId": studio.request_id}
    # The user gets a list to apply or discard even if the model never calls propose: redo only this task.
    baseline = _build(studio, plan, [], _origin(plan, None), None, None)
    baseline["baseline"] = True
    studio.commit(plan=plan, proposal=baseline)
    example = json.dumps({"action": "propose", "changes": [{"task": task["id"], "note": "what changes in it"}]})
    message = (f"Your next call must be propose. Do not change files or run commands now: nothing is redone until the "
               f"user applies the proposal. Recalibrating {brief(task)}. Check the tasks in candidates and give one "
               f"change per task that must change, always #{task['id']}; new tasks will be #{plan['nextId']} onward. "
               f"Example: {example} Until then the user sees a list that redoes only #{task['id']}.")
    if not affected:
        message = (f"Your next call must be propose. Do not change files or run commands now. Recalibrating "
                   f"{brief(task)}; no other task depends on it, so propose only the change to #{task['id']} "
                   f"(new tasks will be #{plan['nextId']} onward). Example: {example}")
    if paused:
        message += f" Paused: {', '.join('#' + identifier for identifier in paused)}."
    candidates = [f"#{identifier} {tasks[identifier]['title']} [{status(tasks, tasks[identifier])}] - "
                  f"{tasks[identifier]['summary']}".rstrip(" -") for identifier in affected]
    return answer(message, task=task["id"], kind=kind, impact=impact, paused=paused, candidates=candidates)


# --- propose --------------------------------------------------------------------------------------

def _origin(plan, previous):
    """The edited task this proposal answers: the pending recalibration, or the cause of the proposal it replaces."""
    recalibrating = plan["recalibrating"]
    if recalibrating:
        return {"task": recalibrating["task"], "text": recalibrating["text"], "after": recalibrating["after"],
                "paused": recalibrating.get("paused", [])}
    cause = (previous or {}).get("cause") or {}
    if cause.get("task") in index(plan):
        change = next((item for item in previous["changes"] if item["task"] == cause["task"]), {})
        after = {key: change[key] for key in _FIELDS + ("criteria",) if key in change}
        return {"task": cause["task"], "text": str(cause.get("text", "")), "after": after, "paused": []}
    return None


def _new_ids(plan, specs):
    """Ids of new tasks: a `task` number not used yet is kept, the others take the next free numbers in order."""
    tasks = index(plan)
    claimed = set()
    for spec in specs:
        identifier = spec.get("task")
        if identifier is None or identifier in tasks:
            continue
        if int(identifier) < plan["nextId"]:
            raise TaskStudioError(f"#{identifier} is not in the plan any more and its number is not reused. To add a "
                                  f"task, leave task out (new tasks get #{plan['nextId']} onward).")
        if spec.get("remove"):
            raise TaskStudioError(f"#{identifier} is not in the plan, so it cannot be removed.")
        claimed.add(identifier)
    number = plan["nextId"]
    result = []
    for spec in specs:
        identifier = spec.get("task")
        if identifier is None:
            while str(number) in claimed or str(number) in tasks:
                number += 1
            identifier = str(number)
            claimed.add(identifier)
        result.append(identifier)
    return result


def _change(plan, spec, identifier):
    tasks = index(plan)
    task = tasks.get(identifier)
    if task is None:
        if spec.get("remove"):
            raise TaskStudioError("remove needs the number of the task to remove")
        if not spec.get("title") and "task" in spec:
            raise TaskStudioError(f"#{identifier} is not in the plan. Use the number of an existing task (call read), "
                                  "or give a title to add a new task.")
        if not spec.get("title"):
            raise TaskStudioError("A new task needs a title.")
        kind = "nova"
    elif spec.get("remove"):
        if not not_started(task):
            raise TaskStudioError(f"{brief(task)} cannot be removed: it already has work ({task['state']}). Propose a "
                                  "change to it, or skip it.")
        kind = "remover"
    else:
        kind = change_kind(task)
    change = {"task": identifier, "kind": kind}
    if spec.get("note"):
        change["note"] = spec["note"]
    if spec.get("why"):
        change["why"] = spec["why"]
    if kind == "remover":
        return change
    for key in _FIELDS:
        if key in spec:
            change[key] = spec[key]
    if "deps" in spec:
        change["deps"] = list(spec["deps"])
    if "criteria" in spec:
        change["criteria"] = criteria_list(spec["criteria"])
    if "gates" in spec:
        change["gates"] = make_gates(spec["gates"], task["gates"] if task else ())
    return change


def _final_graph(plan, changes):
    """The dependency graph the plan would have after the changes; refuses deps on removed tasks."""
    removed = {change["task"] for change in changes if change["kind"] == "remover"}
    by_task = {change["task"]: change for change in changes}
    graph = {}
    for task in plan["tasks"]:
        if task["id"] in removed:
            continue
        change = by_task.get(task["id"], {})
        deps = change["deps"] if "deps" in change else task["deps"]
        graph[task["id"]] = [dep for dep in deps if "deps" in change or dep not in removed]
    for change in changes:
        if change["kind"] == "nova":
            graph[change["task"]] = list(change.get("deps", []))
    for change in changes:
        for dep in change.get("deps", []):
            if dep in removed:
                raise TaskStudioError(f"#{change['task']} would depend on #{dep}, which this proposal removes.")
    if len(graph) > MAX_TASKS:
        raise TaskStudioError(f"The plan would have {len(graph)} tasks; at most {MAX_TASKS} are allowed.")
    titles = {task["id"]: task["title"] for task in plan["tasks"]}
    titles.update({change["task"]: change["title"] for change in changes if change["kind"] == "nova"})
    check_graph(graph, lambda identifier: f"#{identifier} '{titles.get(identifier, '')}'")
    return graph


def _why(change, origin, tasks, changed):
    if origin and change["task"] == origin["task"]:
        return "sua mudança"
    if origin and change["task"] in origin["paused"]:
        return "pausada"
    deps = change.get("deps", tasks[change["task"]]["deps"] if change["task"] in tasks else [])
    if origin and origin["task"] in deps:
        return f"usa #{origin['task']}"
    used = next((dep for dep in deps if dep in changed), None)
    return f"usa #{used}" if used else ""


def _summary(changes):
    """'A mudança atinge 7 tarefas: 2 concluídas serão refeitas, ...' in the user's language (Portuguese)."""
    parts = []
    for kind in CHANGE_KINDS:
        count = sum(1 for change in changes if change["kind"] == kind)
        if count:
            parts.append(_SUMMARY_WORDS[kind][0 if count == 1 else 1].format(n=count))
    joined = parts[0] if len(parts) == 1 else ", ".join(parts[:-1]) + " e " + parts[-1]
    total = len(changes)
    return f"A mudança atinge {total} {'tarefa' if total == 1 else 'tarefas'}: {joined}."


def _counted(changes):
    """'2 to redo, 1 new' for the model."""
    found = [(kind, sum(1 for change in changes if change["kind"] == kind)) for kind in CHANGE_KINDS]
    return ", ".join(f"{count} {_ENGLISH[kind]}" for kind, count in found if count)


def _extra(changes, tasks):
    """Estimated extra minutes: redone and new work in full, adjusted work by half, removed work subtracted."""
    total = 0
    for change in changes:
        old = tasks.get(change["task"], {}).get("estimate") or 0
        new = change.get("estimate", old) or 0
        if change["kind"] in ("refazer", "nova"):
            total += new
        elif change["kind"] == "ajustar":
            total += new // 2
        elif change["kind"] == "alterar":
            total += new - old
        else:
            total -= old
    return total


def propose(studio, args):
    """Validate the changes, derive each kind from the task state and write proposal.json."""
    plan = studio.plan()
    previous = studio.proposal()
    origin = _origin(plan, previous)
    specs = args.get("changes", [])
    if not specs and not origin:
        raise TaskStudioError("propose needs changes: one per task that must change ({task, note, ...}), or a new "
                              "task without task.")
    proposal = _build(studio, plan, specs, origin, args.get("summary"), args.get("extra"))
    plan["recalibrating"] = None
    studio.commit(plan=plan, proposal=proposal)
    changes = proposal["changes"]
    return answer(f"Proposal for plan v{proposal['plan']} saved ({_counted(changes)}). Tell the user in one or two "
                  "sentences what changes and wait for 'Aplique' (call apply) or 'Descarte' (call discard). Do not "
                  "redo any work before that.", version=proposal["plan"],
                  changes=[{"task": change["task"], "kind": change["kind"]} for change in changes])


def _build(studio, plan, specs, origin, summary, extra):
    """The proposal document for these changes plus the edited task of `origin`, validated against the plan."""
    tasks = index(plan)
    seen = set()
    for spec in specs:
        if spec.get("task") in seen:
            raise TaskStudioError(f"#{spec['task']} appears twice in changes; merge them into one change.")
        if "task" in spec:
            seen.add(spec["task"])
    changes = [_change(plan, spec, identifier) for spec, identifier in zip(specs, _new_ids(plan, specs))]
    if origin:
        change = next((item for item in changes if item["task"] == origin["task"]), None)
        if change is None:
            change = _change(plan, {}, origin["task"])
            changes.append(change)
        if change["kind"] != "remover":
            for key, value in origin["after"].items():
                change.setdefault(key, value)
        if not change.get("note") and origin["text"]:
            change["note"] = clean_text(origin["text"], LIMITS["changeNote"])
    _final_graph(plan, changes)
    changed = {change["task"] for change in changes}
    for position, change in enumerate(changes):
        why = change.get("why") or _why(change, origin, tasks, changed)
        head = {key: change[key] for key in ("task", "kind", "note") if key in change}
        if why:
            head["why"] = why
        rest = {key: value for key, value in change.items() if key not in head and key != "why"}
        changes[position] = {**head, **rest}
    order = {task["id"]: position for position, task in enumerate(plan["tasks"])}
    changes.sort(key=lambda item: (not (origin and item["task"] == origin["task"]), _KIND_ORDER[item["kind"]],
                                   order.get(item["task"], len(order) + int(item["task"]))))
    summary = summary or _summary(changes)
    cause = {"task": origin["task"], "text": origin["text"]} if origin else {"task": None, "text": summary}
    return {"plan": plan["plan"] + 1, "base": plan["plan"],
            "baseRevision": studio.next_revision(PLAN_FILE),
            "states": {change["task"]: tasks[change["task"]]["state"] for change in changes
                       if change["kind"] != "nova"},
            "cause": cause, "summary": summary,
            "extra": extra if extra is not None else _extra(changes, tasks),
            "changes": changes, "createdAt": studio.now}


# --- apply and discard ----------------------------------------------------------------------------

def _take(task, change):
    """Copy the fields a change carries into the task; gates keep `met` when their label is unchanged."""
    for key in _FIELDS:
        if key in change:
            task[key] = change[key]
    if "deps" in change:
        task["deps"] = list(change["deps"])
    if "criteria" in change:
        task["criteria"] = [{"text": item["text"], "done": False} for item in change["criteria"]]
    if "gates" in change:
        task["gates"] = make_gates(change["gates"], task["gates"])


def _reset(task):
    """Back to todo for redoing or adjusting; the files and the log stay."""
    task["state"] = "todo"
    task["problem"] = None
    for key in ("progress", "now", "startedAt", "finishedAt", "pausedAt", "result"):
        task.pop(key, None)
    for item in task["criteria"]:
        item["done"] = False


def _reason(proposal):
    cause = proposal.get("cause") or {}
    change = next((item for item in proposal["changes"] if item["task"] == cause.get("task")), {})
    reason = change.get("summary") or cause.get("text") or proposal.get("summary") or f"Plano v{proposal['plan']}"
    return clean_text(str(reason), LIMITS["summary"])


def apply(studio, args):
    """Turn the pending proposal into the next plan version and record it in the history."""
    proposal = studio.proposal(strict=True)
    if proposal is None:
        raise TaskStudioError("There is no proposal to apply. When the user changes a task, call edit and then "
                              "propose.")
    plan = studio.plan()
    if proposal["base"] != plan["plan"]:
        raise TaskStudioError(f"The proposal was made for plan v{proposal['base']}, but the plan is now "
                              f"v{plan['plan']}. Call discard, then edit and propose again.")
    tasks = index(plan)
    for identifier, state in proposal["states"].items():
        if identifier not in tasks:
            raise TaskStudioError(f"#{identifier} is no longer in the plan. Call propose again.")
        if tasks[identifier]["state"] != state:
            raise TaskStudioError(f"#{identifier} changed since the proposal ({state} -> "
                                  f"{tasks[identifier]['state']}). Call propose again so the user sees the current plan.")
    for change in proposal["changes"]:
        if change["kind"] == "nova":
            if change["task"] in tasks or not change["task"].isdigit() or int(change["task"]) < plan["nextId"]:
                raise TaskStudioError(f"#{change['task']} is already used. Call propose again.")
        elif change["task"] not in proposal["states"]:
            raise TaskStudioError(f"The proposal does not record the state of #{change['task']}. Call propose again.")
    _final_graph(plan, proposal["changes"])
    version = plan["plan"] + 1
    removed = {change["task"] for change in proposal["changes"] if change["kind"] == "remover"}
    added = []
    for change in proposal["changes"]:
        kind = change["kind"]
        if kind == "remover":
            continue
        if kind == "nova":
            task = new_task(change["task"], {"title": change["title"]})
            added.append(task)
        else:
            task = tasks[change["task"]]
            if kind in ("refazer", "ajustar"):
                _reset(task)
        _take(task, change)
        task["mark"] = {"plan": version, "kind": kind, "note": change.get("note", "")}
        studio.log(task, f"Plano v{version}: {kind}" + (f" - {change['note']}" if change.get("note") else ""))
    plan["tasks"] = [task for task in plan["tasks"] if task["id"] not in removed]
    for task in plan["tasks"]:
        task["deps"] = [dep for dep in task["deps"] if dep not in removed]
    # New tasks go to the end, so plan order keeps growing ids.
    plan["tasks"].extend(sorted(added, key=lambda item: int(item["id"])))
    plan["plan"] = version
    plan["nextId"] = max([plan["nextId"]] + [int(task["id"]) + 1 for task in added])
    plan["recalibrating"] = None
    history = studio.history()
    history["versions"].append({
        "plan": version, "at": studio.now, "reason": _reason(proposal), "cause": proposal.get("cause"),
        "changes": [{"task": change["task"], "kind": change["kind"], "note": change.get("note", "")}
                    for change in proposal["changes"]],
        "extra": proposal.get("extra", 0), "tasks": snapshot(plan)})
    studio.commit(plan=plan, history=history, delete=(PROPOSAL_FILE,))
    tasks = index(plan)
    ready = ready_ids(plan)
    follow = f"Start a ready task: {names(tasks, ready, 4)}." if ready else "Call read to see what is next."
    return answer(f"Plan v{version} applied ({_counted(proposal['changes'])}). {follow}", version=version,
                  outline=outline(plan))


def discard(studio, args):
    """Drop the proposal and the pending recalibration; the plan stays as it was."""
    plan = studio.plan(required=False)
    proposal = studio.proposal()
    had_proposal = proposal is not None or PROPOSAL_FILE in studio.damaged
    if plan is None:
        if had_proposal:
            studio.commit(delete=(PROPOSAL_FILE,))
        return answer("There is no plan; nothing else to discard.")
    if not had_proposal and not plan["recalibrating"]:
        return answer(f"There is no proposal or recalibration to discard; plan v{plan['plan']} is unchanged.")
    plan["recalibrating"] = None
    studio.commit(plan=plan, delete=(PROPOSAL_FILE,))
    paused = [task["id"] for task in plan["tasks"] if task["state"] == "paused"]
    follow = f" {names(index(plan), paused)} stay paused; call start to resume when the user asks." if paused else ""
    return answer(f"Discarded; plan v{plan['plan']} stays as it was.{follow}", version=plan["plan"])
