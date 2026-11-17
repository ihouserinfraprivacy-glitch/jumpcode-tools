# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""The model-facing actions: validate arguments, then read or change the Studio files."""

import time

from .arguments import validate
from .common import PLAN_FILE, PROPOSAL_FILE, TaskStudioError, answer, iso, locked, studio_root
from .plan import (MAX_FILES, MAX_GATES, MAX_TASKS, SATISFIED, brief, check_graph, counts, dependents, find_task,
                   index, is_ready, names, new_task, next_gate_id, outline, ready_ids, snapshot, status, unmet_gates,
                   update_task, waiting_for)
from .recalibrate import apply, discard, edit, propose
from .studio import Studio
from .authorization import approval

NO_PROJECT = ("There is no project folder, so the plan can be made here but not carried out. Tell the user to open "
              "TaskStudio from a project to carry it out.")


def run(arguments, context, *, clock=None, approve=None, cancelled=None):
    """Run one action inside the Studio folder given by the host.

    `clock` returns seconds since the epoch; tests pass a fixed one.
    """
    arguments = validate(arguments)
    root = studio_root(context)
    now = iso((clock or time.time)())
    with locked(root):
        studio = Studio(root, context, now)
        required = approval(studio, arguments)
        if required is None:
            if cancelled and cancelled():
                raise TaskStudioError("Tool execution cancelled")
            return _HANDLERS[arguments["action"]](studio, arguments)
    if required is not None:
        if not callable(approve) or approve(required) is not True:
            raise TaskStudioError("This action requires confirmation from the JumpCode approval control.")
    with locked(root):
        if cancelled and cancelled():
            raise TaskStudioError("Tool execution cancelled")
        studio = Studio(root, context, now)
        if approval(studio, arguments) != required:
            raise TaskStudioError("The plan changed while waiting for approval. Review the current proposal again.")
        return _HANDLERS[arguments["action"]](studio, arguments)


# --- Helpers --------------------------------------------------------------------------------------

def _work(task):
    """What the model needs to carry out a task."""
    return {"id": task["id"], "title": task["title"], "summary": task["summary"], "detail": task["detail"],
            "criteria": [item["text"] for item in task["criteria"]]}


def _pending(studio, plan):
    """Why the plan cannot move now, or None."""
    if plan["recalibrating"]:
        return (f"a change to #{plan['recalibrating']['task']} is being recalibrated; call propose first, then wait "
                "for the user to apply or discard it")
    proposal = studio.proposal()
    if proposal:
        return f"the proposal for plan v{proposal['plan']} waits for the user to apply or discard it"
    return None


def _check_free(plan, task, verb):
    """Refuse when a dependency is not done or skipped, or a condition is unmet, saying what to do instead."""
    tasks = index(plan)
    waits = waiting_for(tasks, task)
    gates = unmet_gates(task)
    if not waits and not gates:
        return
    parts = []
    if waits:
        parts.append("it waits for " + ", ".join(f"#{dep} ({tasks[dep]['state']})" for dep in waits))
    if gates:
        word = "the condition" if len(gates) == 1 else "the conditions"
        parts.append(f"{word} " + ", ".join(f"'{gate['label']}'" for gate in gates))
    others = [identifier for identifier in ready_ids(plan) if identifier != task["id"]]
    if others:
        hint = f"Work on #{others[0]}" + (" or ask the user." if gates else ".")
    elif gates:
        hint = "Ask the user."
    else:
        hint = f"Finish #{waits[0]} first."
    raise TaskStudioError(f"#{task['id']} cannot {verb}: {' and '.join(parts)}. {hint}")


def _merge_files(task, entries, default_state):
    files = {entry["path"]: entry for entry in task["files"]}
    for entry in entries:
        files.pop(entry["path"], None)
        files[entry["path"]] = {"path": entry["path"], "state": entry.get("state", default_state)}
    task["files"] = list(files.values())[-MAX_FILES:]


def _listed(tasks, identifiers):
    return [{"id": identifier, "title": tasks[identifier]["title"]} for identifier in identifiers]


def _leave(task):
    """Clear what only a running task carries."""
    for key in ("now", "pausedAt"):
        task.pop(key, None)


# --- plan and read --------------------------------------------------------------------------------

def _plan(studio, args):
    current = studio.plan_to_replace()
    if current and current["started"]:
        raise TaskStudioError("The plan has already started, so plan cannot replace it. To change a task call edit, "
                              "then propose; to add tasks call propose with changes that have no task.")
    continuing = bool(current and current["draft"]
                      and ("title" not in args or args["title"].casefold() == current["title"].casefold()))
    if continuing:
        plan = current
        if "request" in args:
            plan["request"] = args["request"]
    else:
        if "title" not in args:
            raise TaskStudioError("plan needs a title for the plan")
        if "tasks" not in args:
            raise TaskStudioError("plan needs tasks: 4 to 15 small tasks with title, summary, detail and deps")
        plan = {"schema": 1, "revision": 0, "plan": 1, "title": args["title"], "request": args.get("request", ""),
                "draft": False, "started": False, "createdAt": studio.now, "updatedAt": studio.now, "tasks": [],
                "recalibrating": None, "nextId": 1}
    # Resending a task of the draft (same title) updates it instead of adding it twice.
    existing = {task["title"].casefold(): task for task in plan["tasks"]} if continuing else {}
    for spec in args.get("tasks", []):
        if spec["title"].casefold() in existing:
            update_task(existing[spec["title"].casefold()], spec)
            continue
        plan["tasks"].append(new_task(str(plan["nextId"]), spec))
        plan["nextId"] += 1
    if len(plan["tasks"]) > MAX_TASKS:
        raise TaskStudioError(f"A plan can have at most {MAX_TASKS} tasks; this one would have {len(plan['tasks'])}. "
                              "Merge small tasks.")
    plan["draft"] = args.get("draft", False)
    tasks = index(plan)
    check_graph({task["id"]: task["deps"] for task in plan["tasks"]},
                lambda identifier: f"Task #{identifier} '{tasks[identifier]['title']}'")
    # A new plan starts the history again; completing a draft refreshes the snapshot of its version.
    history = studio.history() if continuing else {"versions": []}
    versions = history["versions"]
    position = next((number for number, item in enumerate(versions) if item.get("plan") == plan["plan"]), None)
    if position is None:
        versions.append({"plan": plan["plan"], "at": studio.now, "reason": "Plano inicial", "cause": None,
                         "changes": [], "tasks": snapshot(plan)})
    else:
        versions[position] = {**versions[position], "tasks": snapshot(plan)}
    studio.commit(plan=plan, history=history, delete=() if continuing else (PROPOSAL_FILE,))
    count = len(plan["tasks"])
    if plan["draft"]:
        message = (f"Draft saved with {count} tasks. Call plan again with the next tasks (they will be "
                   f"#{plan['nextId']} onward; deps use these numbers) and draft false on the last call.")
    else:
        message = f"Plan v{plan['plan']} saved with {count} tasks. "
        message += "Tell the user the plan in one or two sentences and wait until they say start."
        if not studio.project:
            message += " " + NO_PROJECT
    if PLAN_FILE in studio.damaged:
        message += " (The damaged plan.json was replaced.)"
    return answer(message, version=plan["plan"], draft=plan["draft"], project=studio.project, outline=outline(plan))


def _next_step(studio, plan, proposal):
    if plan["recalibrating"]:
        return f"Call propose for the change to #{plan['recalibrating']['task']}."
    if proposal:
        return (f"The proposal for plan v{proposal['plan']} waits for the user: call apply when they say 'Aplique', "
                "discard when they say 'Descarte'.")
    if plan["draft"]:
        return "The plan is a draft: call plan with the remaining tasks and draft false."
    if not studio.project:
        return NO_PROJECT
    if not plan["started"]:
        ready = ready_ids(plan)
        first = f"#{ready[0]}" if ready else "a ready task"
        return f"Not started yet. When the user says start, call start on {first}."
    if all(task["state"] in SATISFIED for task in plan["tasks"]):
        return "All tasks are finished."
    running = [task["id"] for task in plan["tasks"] if task["state"] == "running"]
    if running:
        return f"Continue #{running[0]} (running)."
    ready = ready_ids(plan)
    if ready:
        return "Start a ready task: " + ", ".join(f"#{identifier}" for identifier in ready[:6]) + "."
    return "Nothing is ready: ask the user about the conditions or problems below, or resume a paused task."


def _notes(studio, plan, proposal):
    """Problems, unmet conditions and pending changes, one short line each."""
    lines = []
    for task in plan["tasks"]:
        problem = task.get("problem")
        if task["state"] == "failed" and problem:
            options = "; ".join(problem.get("options") or [])
            choices = f" (options: {options})" if options else ""
            lines.append(f"Problem #{task['id']}: {problem.get('title', '')}{choices}")
        if task["state"] not in SATISFIED:
            for gate in unmet_gates(task):
                env = f" (env {gate['env']})" if gate.get("env") else ""
                lines.append(f"Needs user #{task['id']}: {gate['kind']} '{gate['label']}'{env}")
    if plan["recalibrating"]:
        recalibrating = plan["recalibrating"]
        lines.append(f"Recalibrating #{recalibrating['task']}: \"{recalibrating.get('text', '')}\"")
    if proposal:
        lines.append(f"Proposal v{proposal['plan']}: {len(proposal['changes'])} changes waiting for the user")
    elif PROPOSAL_FILE in studio.damaged:
        lines.append("proposal.json is damaged: call discard")
    return lines[:20]


def _read(studio, args):
    plan = studio.plan(required=False)
    if plan is None:
        message = "There is no plan yet. When the user asks to build or change something sizeable, call plan."
        if not studio.project:
            message += " " + NO_PROJECT
        return answer(message, project=studio.project)
    tasks = index(plan)
    if "id" in args:
        task = find_task(plan, args["id"])
        return answer(f"{brief(task)} [{status(tasks, task)}].", project=studio.project, task=task,
                      waitsFor=waiting_for(tasks, task), unlocks=dependents(plan, task["id"]))
    proposal = studio.proposal()
    numbers = counts(plan)
    shown = ", ".join(f"{value} {key}" for key, value in numbers.items() if value and key != "total")
    state = "draft" if plan["draft"] else ("started" if plan["started"] else "not started")
    message = (f"Plan v{plan['plan']} \"{plan['title']}\" ({state}): {numbers['total']} tasks"
               + (f", {shown}" if shown else "") + ". " + _next_step(studio, plan, proposal))
    result = answer(message, version=plan["plan"], project=studio.project, counts=numbers, outline=outline(plan),
                    nextId=plan["nextId"])
    notes = _notes(studio, plan, proposal)
    if notes:
        result["notes"] = notes
    return result


# --- Carrying out tasks ---------------------------------------------------------------------------

def _start(studio, args):
    plan = studio.plan()
    task = find_task(plan, args["id"])
    if task["state"] == "done":
        raise TaskStudioError(f"{brief(task)} is already done. If the user wants it changed, call edit.")
    if not studio.project:
        raise TaskStudioError(NO_PROJECT)
    pending = _pending(studio, plan)
    if pending:
        raise TaskStudioError(f"#{task['id']} cannot start now: {pending}.")
    _check_free(plan, task, "start")
    if task["state"] == "running" and task.get("requestId") == studio.request_id:
        return answer(f"{brief(task)} is already running. Continue the work, then call progress or finish.", task=_work(task))
    resumed = task["state"] in ("paused", "failed")
    task["state"] = "running"
    task["requestId"] = studio.request_id
    task.setdefault("startedAt", studio.now)
    task.pop("pausedAt", None)
    task["problem"] = None
    if "note" in args:
        task["now"] = args["note"]
    plan["started"] = True
    plan["draft"] = False
    studio.log(task, ("Retomada" if resumed else "Começou") + (f": {args['note']}" if "note" in args else ""))
    studio.commit(plan=plan)
    return answer(f"{brief(task)} is running. Do the work with your other tools, call progress with short notes, "
                  "then finish with the result.", task=_work(task))


def _progress(studio, args):
    plan = studio.plan()
    task = find_task(plan, args["id"])
    if _pending(studio, plan):
        raise TaskStudioError("A plan change awaits approval; progress cannot resume it.")
    if task["state"] != "running":
        hint = {"paused": "Call start to resume it first.", "done": "It is already done.",
                "failed": "Call start to try it again first."}.get(task["state"], "Call start first.")
        raise TaskStudioError(f"{brief(task)} is not running ({task['state']}). {hint}")
    if "note" in args:
        task["now"] = args["note"]
    task["requestId"] = studio.request_id
    if "percent" in args:
        task["progress"] = args["percent"]
    line = args.get("log") or args.get("note")
    if line:
        studio.log(task, line, args.get("kind", "info"))
    if "files" in args:
        _merge_files(task, args["files"], "partial")
    studio.commit(plan=plan)
    return answer(f"Progress saved for #{task['id']}. Call finish with the result when it is done.", id=task["id"],
                  progress=task.get("progress"))


def _mark_criteria(task, texts):
    """Mark the criteria met (all when `texts` is None); returns texts that matched none."""
    if texts is None:
        for item in task["criteria"]:
            item["done"] = True
        return []
    unmatched = []
    for text in texts:
        match = None
        if text.isdigit() and 1 <= int(text) <= len(task["criteria"]):
            match = task["criteria"][int(text) - 1]
        else:
            match = next((item for item in task["criteria"] if item["text"].casefold() == text.casefold()), None)
        if match is None:
            unmatched.append(text)
        else:
            match["done"] = True
    return unmatched


def _finish(studio, args):
    plan = studio.plan()
    task = find_task(plan, args["id"])
    tasks = index(plan)
    if task["state"] == "done":
        ready = ready_ids(plan)
        hint = f" Start the next ready task: #{ready[0]}." if ready else ""
        raise TaskStudioError(f"{brief(task)} is already done.{hint}")
    pending = _pending(studio, plan)
    if pending:
        raise TaskStudioError(f"#{task['id']} cannot finish now: {pending}.")
    if task["state"] not in ("running", "paused"):
        if not studio.project:
            raise TaskStudioError(NO_PROJECT)
        _check_free(plan, task, "finish")
        task.setdefault("startedAt", studio.now)
        plan["started"] = True
        plan["draft"] = False
    before = set(ready_ids(plan))
    unmatched = _mark_criteria(task, args.get("criteria"))
    if unmatched or any(not item["done"] for item in task["criteria"]):
        raise TaskStudioError("The task still has unmet or unknown completion criteria. Complete them before finish.")
    task["state"] = "done"
    task["progress"] = 100
    task["finishedAt"] = studio.now
    task["problem"] = None
    _leave(task)
    if "result" in args:
        task["result"] = args["result"]
    _merge_files(task, args.get("files", []), "done")
    for entry in task["files"]:
        entry["state"] = "done"
    studio.log(task, "Concluída" + (f": {args['result']}" if "result" in args else ""), "ok")
    ready = [identifier for identifier in ready_ids(plan) if identifier not in before]
    needs_user = [identifier for identifier in dependents(plan, task["id"])
                  if tasks[identifier]["state"] == "todo" and not waiting_for(tasks, tasks[identifier])
                  and unmet_gates(tasks[identifier])]
    studio.commit(plan=plan)
    if all(item["state"] in SATISFIED for item in plan["tasks"]):
        message = f"{brief(task)} done. All tasks are finished: tell the user the plan is complete."
    elif ready:
        message = f"{brief(task)} done. Ready now: {names(tasks, ready)}. Start the next one."
    else:
        others = ready_ids(plan)
        follow = f"Next ready: {names(tasks, others)}." if others else "Nothing else is ready."
        message = f"{brief(task)} done. {follow}"
    if needs_user:
        labels = "; ".join(f"#{identifier} '{unmet_gates(tasks[identifier])[0]['label']}'" for identifier in needs_user)
        message += f" Now waiting for the user: {labels}; ask them."
    if unmatched:
        message += " Criteria not found: " + "; ".join(unmatched)[:200] + "."
    return answer(message, id=task["id"], ready=_listed(tasks, ready), needsUser=_listed(tasks, needs_user))


def _fail(studio, args):
    plan = studio.plan()
    task = find_task(plan, args["id"])
    if task["state"] in SATISFIED:
        raise TaskStudioError(f"{brief(task)} is {task['state']}; only a task in progress or not started can fail.")
    task["state"] = "failed"
    task["problem"] = {"title": args["problem"], "detail": args.get("detail", ""), "options": args.get("options", []),
                       "at": studio.now}
    _leave(task)
    studio.log(task, f"Problema: {args['problem']}", "error")
    studio.commit(plan=plan)
    options = " and the options" if args.get("options") else ""
    return answer(f"{brief(task)} is marked with a problem. Tell the user what blocks it{options}, then wait for "
                  "their answer.", id=task["id"])


def _need(studio, args):
    plan = studio.plan()
    task = find_task(plan, args["id"])
    if task["state"] == "done":
        raise TaskStudioError(f"{brief(task)} is already done; it needs nothing more.")
    label = args["label"]
    gate = next((item for item in task["gates"] if item["label"].casefold() == label.casefold()), None)
    if gate is None:
        if len(task["gates"]) >= MAX_GATES:
            raise TaskStudioError(f"{brief(task)} already has {MAX_GATES} conditions; resolve one or reuse its label.")
        gate = {"id": next_gate_id(task)}
        task["gates"].append(gate)
    kind = args.get("kind") or ("secret" if "env" in args else "other")
    for key in ("where", "env", "alternatives"):
        gate.pop(key, None)
    gate.update({"kind": kind, "label": label, "met": False})
    for key in ("where", "env", "alternatives"):
        if key in args:
            gate[key] = args[key]
    if task["state"] in ("running", "paused", "failed"):
        task["state"] = "todo"
        task["problem"] = None
        _leave(task)
    studio.log(task, f"Precisa de você: {label}")
    studio.commit(plan=plan)
    if kind == "secret":
        variable = args.get("env", "the variable")
        ask = (f"Tell the user to put {variable} in the project's .env file (never in the chat) and to tell you when "
               "it is there; then call resolve.")
    elif kind == "approval":
        ask = f"Ask the user to approve '{label}'; when they say yes, call resolve."
    elif kind == "choice":
        choices = ", ".join(args.get("alternatives", []))
        listed = f" ({choices})" if choices else ""
        ask = f"Ask the user to choose '{label}'{listed}; then call resolve with their choice as note."
    else:
        ask = f"Ask the user for '{label}'; then call resolve."
    others = [identifier for identifier in ready_ids(plan) if identifier != task["id"]]
    meanwhile = f" Meanwhile you may start #{others[0]}." if others and studio.project else ""
    return answer(f"#{task['id']} now needs the user: {label}. {ask}{meanwhile}", id=task["id"], gate=gate["id"])


def _resolve(studio, args):
    plan = studio.plan()
    task = find_task(plan, args["id"])
    tasks = index(plan)
    resolved, cleared = [], False
    if "gate" in args:
        key = args["gate"].casefold()
        gate = next((item for item in task["gates"] if key in (item["id"].casefold(), item["label"].casefold())), None)
        if gate is None:
            matches = [item for item in task["gates"] if key in item["label"].casefold()]
            gate = matches[0] if len(matches) == 1 else None
        if gate is None:
            known = "; ".join(f"{item['id']} '{item['label']}'" for item in task["gates"]) or "none"
            raise TaskStudioError(f"#{task['id']} has no condition '{args['gate']}'. Its conditions: {known}.")
        if not gate["met"]:
            resolved.append(gate)
    else:
        resolved = unmet_gates(task)
        if task["state"] == "failed":
            task["state"] = "todo"
            task["problem"] = None
            cleared = True
    if not resolved and not cleared:
        return answer(f"{brief(task)} has nothing pending to resolve [{status(tasks, task)}].", id=task["id"])
    for gate in resolved:
        gate["met"] = True
        note = f" ({args['note']})" if "note" in args else ""
        studio.log(task, f"Condição resolvida: {gate['label']}{note}", "ok")
    if cleared:
        studio.log(task, "Problema resolvido" + (f": {args['note']}" if "note" in args else ""), "ok")
    studio.commit(plan=plan)
    if is_ready(tasks, task):
        follow = f"{brief(task)} is ready: call start."
    elif task["state"] in ("paused", "failed"):
        follow = f"{brief(task)} is {task['state']}: call start to resume it."
    else:
        follow = f"{brief(task)} is now [{status(tasks, task)}]."
    return answer(f"Resolved. {follow}", id=task["id"], status=status(tasks, task))


def _skip(studio, args):
    plan = studio.plan()
    task = find_task(plan, args["id"])
    tasks = index(plan)
    if task["state"] == "done":
        raise TaskStudioError(f"{brief(task)} is already done.")
    if task["state"] == "skipped":
        return answer(f"{brief(task)} is already left for later.", id=task["id"])
    before = set(ready_ids(plan))
    task["state"] = "skipped"
    task["problem"] = None
    _leave(task)
    studio.log(task, "Para depois" + (f": {args['note']}" if "note" in args else ""))
    ready = [identifier for identifier in ready_ids(plan) if identifier not in before]
    studio.commit(plan=plan)
    follow = f" Ready now: {names(tasks, ready)}." if ready else ""
    return answer(f"{brief(task)} is left for later.{follow}", id=task["id"], ready=_listed(tasks, ready))


def _pause(studio, args):
    plan = studio.plan()
    if "id" in args:
        task = find_task(plan, args["id"])
        if task["state"] == "paused":
            return answer(f"{brief(task)} is already paused.", paused=[])
        if task["state"] != "running":
            raise TaskStudioError(f"{brief(task)} is not running ({task['state']}).")
        targets = [task]
    else:
        targets = [task for task in plan["tasks"] if task["state"] == "running"]
        if not targets:
            return answer("Nothing is running.", paused=[])
    for task in targets:
        task["state"] = "paused"
        task["pausedAt"] = studio.now
        studio.log(task, "Pausada")
    studio.commit(plan=plan)
    tasks = index(plan)
    identifiers = [task["id"] for task in targets]
    return answer(f"Paused {names(tasks, identifiers)}. Call start to resume when the user asks.", paused=identifiers)


def _focus(studio, args):
    task = None
    if "id" in args:
        task = find_task(studio.plan(), args["id"])
    view = {"select": task["id"] if task else None, "mode": args.get("mode", "map"), "note": args.get("note", "")}
    studio.commit(view=view)
    target = brief(task) if task else "the plan"
    return answer(f"The Studio now shows {target} in {view['mode']} mode.", view=view)


_HANDLERS = {
    "plan": _plan, "read": _read, "start": _start, "progress": _progress, "finish": _finish, "fail": _fail,
    "need": _need, "resolve": _resolve, "skip": _skip, "pause": _pause, "edit": edit, "propose": propose,
    "apply": apply, "discard": discard, "focus": _focus,
}
