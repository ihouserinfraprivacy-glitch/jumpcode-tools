# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""The model-facing actions: validate arguments, then read or change the Studio files."""

import re

from .analyzer import Progress, analyze
from .common import (MODEL_FILE, PARTIAL_FILE, PATHS_FILE, PREVIOUS_FILE, PROGRESS_FILE, PROPOSAL_FILE, VIEW_FILE,
                     ArchStudioError, delete_file, link_id, locked, read_json, slug, source_identity, source_root,
                     studio_root, write_json)
from .model import KINDS, PREFIX, SUMMARY_PREFIXES, _family, check, empty, finalize, merge_previous
from .reading import Index, detail, outline
from .walker import Budget, Cancelled

ACTIONS = ("scan", "read", "focus", "write_part", "write_link", "remove", "write_path", "remove_path",
           "write_proposal", "clear_proposal")
MODES = ("map", "columns", "circles", "blocks", "layers", "path", "present", "deploy", "matrix")
PART_LEVELS = ("system", "service", "data", "queue", "external")
PART_KINDS = tuple(kind for kind in KINDS if kind != "file")
MESSAGING = {"AMQP", "MQTT", "KAFKA", "NATS", "SQS", "PUB/SUB", "EVENT", "EVENTS", "QUEUE"}
NEXT_SCAN = " Next: answer the user in one or two short sentences."
NEXT = " Next: another call, or answer the user in one short sentence."
MAX_PATHS = 12
MAX_STEPS = 24
MAX_PROPOSAL_ITEMS = 40
MAX_IDS = 20

_FIELDS = {
    "scan": set(),
    "read": {"id"},
    "focus": {"id", "ids", "note", "mode"},
    "write_part": {"id", "level", "name", "kind", "parent", "tech", "summary"},
    "write_link": {"from", "to", "protocol", "label", "async"},
    "remove": {"id"},
    "write_path": {"name", "steps"},
    "remove_path": {"id", "name"},
    "write_proposal": {"title", "summary", "nodes", "links"},
    "clear_proposal": set(),
}
_ALL = {"action"} | set().union(*_FIELDS.values())
_TEXT_LIMITS = {"id": 300, "name": 80, "tech": 60, "summary": 300, "note": 300, "parent": 300, "from": 300, "to": 300,
                "protocol": 30, "label": 80, "title": 100}
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


def _text(value, field, limit=None):
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        value = str(value)
    if not isinstance(value, str):
        raise ArchStudioError(f"{field} must be text")
    value = " ".join(value.split()) if field not in ("summary", "note") else value.strip()
    limit = limit or _TEXT_LIMITS.get(field, 300)
    if len(value) > limit:
        raise ArchStudioError(f"{field} is longer than {limit} characters; shorten it")
    if _CONTROL.search(value):
        raise ArchStudioError(f"{field} contains control characters")
    return value


def _flag(value, field):
    if isinstance(value, bool):
        return value
    if isinstance(value, str) and value.strip().lower() in ("true", "false", "yes", "no", "1", "0"):
        return value.strip().lower() in ("true", "yes", "1")
    raise ArchStudioError(f"{field} must be true or false")


def _choice(value, field, choices):
    value = _text(value, field).lower()
    if value not in choices:
        raise ArchStudioError(f"{field} must be one of: {', '.join(choices)}")
    return value


def _present(arguments):
    return {key: value for key, value in arguments.items() if value is not None and value != "" and value != []}


def _object(value, field, allowed, required=()):
    if not isinstance(value, dict):
        raise ArchStudioError(f"Each item of {field} must be an object")
    value = _present(value)
    unknown = set(value) - allowed
    if unknown:
        raise ArchStudioError(f"Unknown fields in {field}: {', '.join(sorted(map(str, unknown)))}")
    for key in required:
        if key not in value:
            raise ArchStudioError(f"Each item of {field} needs {key}")
    return value


def validate(arguments):
    """Return a normalized copy of the arguments; never touches the disk or the caller's data."""
    if not isinstance(arguments, dict):
        raise ArchStudioError("Arguments must be an object")
    unknown = set(arguments) - _ALL
    if unknown:
        raise ArchStudioError("Unknown arguments: " + ", ".join(sorted(map(str, unknown))))
    action = arguments.get("action")
    if action not in ACTIONS:
        raise ArchStudioError("action must be one of: " + ", ".join(ACTIONS))
    given = _present({key: value for key, value in arguments.items() if key != "action"})
    if action in ("read", "focus", "remove") and "name" in given and "id" not in given:
        given["id"] = given.pop("name")
    extra = set(given) - _FIELDS[action]
    if extra:
        allowed = ", ".join(sorted(_FIELDS[action])) or "no other fields"
        raise ArchStudioError(f"{', '.join(sorted(extra))} not used by {action}; it takes {allowed}")
    result = {"action": action}
    for key, value in given.items():
        if key in ("id", "name", "parent", "tech", "summary", "note", "from", "to", "protocol", "label", "title"):
            result[key] = _text(value, key, 600 if key == "summary" and action == "write_proposal" else None)
            if not result[key]:
                del result[key]
        elif key == "async":
            result[key] = _flag(value, key)
        elif key == "level":
            result[key] = _choice(value, key, PART_LEVELS)
        elif key == "kind":
            result[key] = _choice(value, key, PART_KINDS)
        elif key == "mode":
            result[key] = _choice(value, key, MODES)
        elif key == "ids":
            if isinstance(value, str):
                value = [value]
            if not isinstance(value, list) or len(value) > MAX_IDS:
                raise ArchStudioError(f"ids must be a list of at most {MAX_IDS} ids")
            result[key] = [_text(item, "id") for item in value if item not in (None, "")]
        elif key == "steps":
            if not isinstance(value, list) or not value or len(value) > MAX_STEPS:
                raise ArchStudioError(f"steps must be a list of 1 to {MAX_STEPS} steps")
            steps = []
            for item in value:
                item = _object(item, "steps", {"from", "to", "label", "async", "note"}, ("from", "to"))
                step = {"from": _text(item["from"], "from"), "to": _text(item["to"], "to")}
                if "label" in item:
                    step["label"] = _text(item["label"], "label")
                step["async"] = _flag(item["async"], "async") if "async" in item else False
                if "note" in item:
                    step["note"] = _text(item["note"], "note")
                steps.append(step)
            result[key] = steps
        elif key == "nodes":
            if not isinstance(value, list) or len(value) > MAX_PROPOSAL_ITEMS:
                raise ArchStudioError(f"nodes must be a list of at most {MAX_PROPOSAL_ITEMS} items")
            items = []
            for item in value:
                item = _object(item, "nodes", {"op", "id", "level", "parent", "name", "kind", "tech", "summary", "note"}, ("op",))
                entry = {"op": _choice(item["op"], "op", ("add", "change", "remove"))}
                for field in ("id", "parent", "name", "tech", "summary", "note"):
                    if field in item:
                        entry[field] = _text(item[field], field)
                if "level" in item:
                    entry["level"] = _choice(item["level"], "level", PART_LEVELS)
                if "kind" in item:
                    entry["kind"] = _choice(item["kind"], "kind", PART_KINDS)
                if entry["op"] != "add" and "id" not in entry:
                    raise ArchStudioError(f"A '{entry['op']}' item of nodes needs the id of an existing part")
                if entry["op"] == "add" and "id" not in entry and "name" not in entry:
                    raise ArchStudioError("An 'add' item of nodes needs a name")
                items.append(entry)
            result[key] = items
        elif key == "links":
            if not isinstance(value, list) or len(value) > MAX_PROPOSAL_ITEMS:
                raise ArchStudioError(f"links must be a list of at most {MAX_PROPOSAL_ITEMS} items")
            items = []
            for item in value:
                item = _object(item, "links", {"op", "from", "to", "label"}, ("op", "from", "to"))
                entry = {"op": _choice(item["op"], "op", ("add", "remove")), "from": _text(item["from"], "from"),
                         "to": _text(item["to"], "to")}
                if "label" in item:
                    entry["label"] = _text(item["label"], "label")
                items.append(entry)
            result[key] = items
    required = {"write_link": ("from", "to"), "write_path": ("name", "steps"), "write_proposal": ("title",),
                "remove": ("id",)}
    for key in required.get(action, ()):
        if key not in result:
            raise ArchStudioError(f"{action} needs {key}")
    if action == "write_part" and "id" not in result and "name" not in result:
        raise ArchStudioError("write_part needs a name for a new part, or the id of an existing one")
    if action == "focus" and "id" not in result and not result.get("ids"):
        raise ArchStudioError("focus needs id or ids")
    if action == "remove_path" and "id" not in result and "name" not in result:
        raise ArchStudioError("remove_path needs the id or name of a path")
    return result


def run(arguments, context, cancelled=None):
    """Run one validated action inside the Studio folder given by the host."""
    root = studio_root(context)
    action = arguments["action"]
    if action == "scan":
        return _scan(root, context, cancelled)
    with locked(root):
        _recover_scan(root)
        model = _load(root, required=False)
        source = context.get("source_root")
        identity = source_identity(source) if source else None
        if model and model.get("sourceId") and identity and model["sourceId"] != identity:
            raise ArchStudioError("The source folder changed. Call scan before reading or editing this map.")
        if action == "write_part":
            return _write_part(root, arguments, identity)
        return _HANDLERS[action](root, arguments)


def _load(root, required=True):
    model = read_json(root, MODEL_FILE)
    if model is None:
        if required:
            raise ArchStudioError("There is no map yet. Call scan to analyze the project, or create parts with write_part.")
        return None
    return check(model)


def _save(root, model):
    finalize(model)
    write_json(root, MODEL_FILE, model)


def _document(root, name):
    data = read_json(root, name)
    model = _load(root, required=False)
    return data if data and data.get("sourceId") == (model or {}).get("sourceId") else None


def _write_document(root, name, data):
    model = _load(root, required=False)
    if model and model.get("sourceId"):
        data = {**data, "sourceId": model["sourceId"]}
    write_json(root, name, data)


def _paths(root):
    data = _document(root, PATHS_FILE) or {"paths": []}
    if not isinstance(data.get("paths"), list):
        raise ArchStudioError("paths.json is damaged; nothing was changed")
    return data


def _recover_scan(root):
    """Called with the process lock: an unfinished scan cannot still be writing."""
    progress = read_json(root, PROGRESS_FILE)
    if progress and progress.get("status") == "scanning":
        write_json(root, PROGRESS_FILE, {**progress, "status": "failed", "error": "A análise foi interrompida. O mapa salvo foi preservado."})
    delete_file(root, PARTIAL_FILE)


def _scan(root, context, cancelled):
    source = source_root(context)
    if source is None:
        raise ArchStudioError("No project folder to analyze. Ask the user to open a project or pick a folder in the "
                              "Studio, then call scan again. Without a folder you can still describe the system with "
                              "write_part and write_link.")
    with locked(root):
        _recover_scan(root)
        try:
            previous = read_json(root, MODEL_FILE)
            previous = check(previous) if previous is not None else None
        except ArchStudioError:
            previous = None
        identity = source_identity(source)
        same_source = previous is None or previous.get("sourceId") == identity or (
            not previous.get("sourceId") and not previous.get("source") and not previous.get("scannedAt"))
        binding = {"sourceId": identity}
        if isinstance(context.get("execution_id"), str) and context["execution_id"]:
            binding["executionId"] = context["execution_id"]
        progress = Progress(lambda data: write_json(root, PROGRESS_FILE, {**data, **binding}))
        budget = Budget(cancelled=cancelled)

        def failed(error):
            try:
                delete_file(root, PARTIAL_FILE)
            finally:
                write_json(root, PROGRESS_FILE, {**progress.snapshot("failed", error), **binding})

        try:
            result = analyze(source, budget, progress,
                             lambda model: write_json(root, PARTIAL_FILE, {**model, **binding}),
                             source_name=source.name or "projeto")
            model = merge_previous(result.model, previous if same_source else None)
            model["sourceId"] = identity
            if previous is not None and not same_source:
                # One local recovery copy; never merge edits whose source is unknown or different.
                write_json(root, PREVIOUS_FILE, previous)
            _save(root, model)
        except Cancelled:
            failed("Interrompido")
            raise ArchStudioError("The scan was stopped by the user; the previous map was kept.") from None
        except ArchStudioError as error:
            failed(str(error))
            raise
        except Exception as error:  # noqa: BLE001 - any analyzer failure must leave the previous map in place
            failed("Falha na análise")
            raise ArchStudioError("The scan failed; the previous map was kept.") from error
        write_json(root, PROGRESS_FILE, {**progress.snapshot("done"), **binding})
        delete_file(root, PARTIAL_FILE)
    return {"text": _scan_summary(model, result) + NEXT_SCAN, "action": "scan", "stats": model["stats"],
            "systems": [{"id": node["id"], "name": node["name"], "kind": node["kind"]}
                        for node in model["nodes"] if node["level"] == "system"]}


def _scan_summary(model, result):
    stats = model["stats"]
    index = Index(model)
    parts = [f"Scanned '{model['source']}' in {result.elapsed:.1f} s: {stats['systems']} systems, {stats['services']} services, "
             f"{stats['files']} files, {stats['links']} links, {stats['lines']} lines."]
    systems = []
    for node in model["nodes"]:
        if node["level"] == "system":
            count = sum(1 for child in index.children.get(node["id"], []) if child["level"] == "service")
            systems.append(f"{node['name']} ({node['kind']}{', ' + node['tech'] if node.get('tech') else ''}, {count} services)")
    if systems:
        parts.append("Systems: " + "; ".join(systems[:20]) + ("; ..." if len(systems) > 20 else "") + ".")
    for level, title in (("data", "Data"), ("queue", "Queues"), ("external", "External")):
        names = [node["name"] for node in model["nodes"] if node["level"] == level]
        if names:
            parts.append(f"{title}: {', '.join(names[:12])}.")
    if model.get("deploy"):
        parts.append("Deploy: " + ", ".join(zone["name"] for zone in model["deploy"]["zones"]) + ".")
    if result.notes:
        parts.append("Note: " + "; ".join(result.notes[:3]) + ".")
    text = " ".join(parts)
    return text if len(text) <= 1800 else text[:1797] + "..."


def _read(root, arguments):
    model = _load(root, required=False)
    if model is None:
        return {"text": "There is no map yet. Call scan to analyze the project, or create parts with write_part." + NEXT,
                "action": "read"}
    paths = _paths(root)["paths"]
    proposal = _document(root, PROPOSAL_FILE)
    if "id" not in arguments:
        return {"text": outline(model, paths, proposal), "action": "read", "stats": model.get("stats")}
    index = Index(model)
    flow = next((item for item in paths if item.get("id") in (arguments["id"], slug(arguments["id"]))), None)
    if flow is not None and arguments["id"] not in index.nodes:
        lines = [f"Path {flow['id']} \"{flow.get('name', '')}\" ({len(flow.get('steps', []))} steps):"]
        for number, step in enumerate(flow.get("steps", []), 1):
            label = f" {step['label']}" if step.get("label") else ""
            note = f" - {step['note']}" if step.get("note") else ""
            lines.append(f"{number}. {index.name(step['from'])} -> {index.name(step['to'])}{label}{note}")
        return {"text": "\n".join(lines)[:3500], "action": "read", "id": flow["id"]}
    found = index.find(arguments["id"], links=True)
    return {"text": detail(model, found), "action": "read", "id": found}


def _scope_of(index, node_id):
    node = index.nodes[node_id]
    if node["level"] == "service":
        return "service", node["parent"]
    if node["level"] == "file":
        return "file", node["parent"]
    return "system", None


def _focus(root, arguments):
    model = _load(root)
    index = Index(model)
    mode = arguments.get("mode", "map")
    paths = {item["id"]: item for item in _paths(root)["paths"]}
    units = {unit["id"] for unit in (model.get("deploy") or {}).get("units", [])}
    view = {"select": None, "highlight": [], "level": "system", "scope": None, "mode": mode}
    if "note" in arguments:
        view["note"] = arguments["note"]
    wanted = ([arguments["id"]] if "id" in arguments else []) + list(arguments.get("ids", []))
    resolved = []
    for value in wanted:
        if value in paths or slug(value) in paths:
            view["path"] = value if value in paths else slug(value)
            if mode not in ("path", "present"):
                view["mode"] = "path"
            continue
        if value in units:
            resolved.append(value)
            if mode == "map":
                view["mode"] = "deploy"
            continue
        found = index.find(value, links=True)
        if found not in resolved:
            resolved.append(found)
    view["highlight"] = resolved[:MAX_IDS]
    selected = next((item for item in resolved if item in index.nodes), None)
    if "id" in arguments and resolved and resolved[0] in index.nodes:
        selected = resolved[0]
    if selected:
        view["select"] = selected
        view["level"], view["scope"] = _scope_of(index, selected)
    elif resolved and resolved[0] in index.links:
        link = index.links[resolved[0]]
        view["level"] = link.get("level") if link.get("level") in ("system", "service", "file") else "system"
        if view["level"] != "system":
            source, target = index.nodes.get(link["from"]), index.nodes.get(link["to"])
            parents = {node.get("parent") for node in (source, target) if node and node["level"] in ("service", "file")}
            view["scope"] = parents.pop() if len(parents) == 1 else None
            if view["scope"] is None:
                view["level"] = "system"
    previous = _document(root, VIEW_FILE) or {}
    revision = previous.get("revision") if isinstance(previous.get("revision"), int) else 0
    view["revision"] = revision + 1
    _write_document(root, VIEW_FILE, view)
    target = view.get("path") or (f"{index.name(selected)} ({selected})" if selected else ", ".join(resolved))
    return {"text": f"The Studio now shows {target} in mode {view['mode']}." + NEXT, "action": "focus", "view": view}


def _derive_id(level, name, parent, index):
    key = slug(name)
    if not key:
        raise ArchStudioError("name needs letters or numbers")
    if level == "service":
        base = index.nodes[parent].get("path") or parent.split(":", 1)[1]
        base = "" if base == "." else base
        return "v:" + (f"{base}/{key}" if base else key)
    return PREFIX[level] + key


def _level_of(identifier):
    for level, prefix in PREFIX.items():
        if identifier.startswith(prefix):
            return level
    return None


def _write_part(root, arguments, identity=None):
    model = _load(root, required=False) or empty("Arquitetura", "")
    if identity and not model.get("source") and not model.get("sourceId"):
        model["sourceId"] = identity
    index = Index(model)
    identifier = arguments.get("id")
    existing = None
    if identifier is not None:
        try:
            existing = index.find(identifier)
        except ArchStudioError:
            # Not an existing part: a well-formed id names a new one; anything else needs a name.
            if _level_of(identifier) is None:
                if "name" not in arguments:
                    raise
                identifier = None
    if existing is not None:
        node = index.nodes[existing]
        if node["level"] == "file":
            if set(arguments) - {"action", "id", "summary"}:
                raise ArchStudioError("Files come from the code; only their summary can be written")
        if "level" in arguments and arguments["level"] != node["level"]:
            raise ArchStudioError(f"{existing} is a {node['level']}; its level cannot change")
        if "parent" in arguments:
            parent = index.find(arguments["parent"], kind="system")
            if node["level"] != "service" or index.nodes[parent]["level"] != "system":
                raise ArchStudioError("Only a service can move, and only to a system")
            node["parent"] = parent
        for field in ("name", "kind", "tech", "summary"):
            if field in arguments:
                if field == "kind" and node["level"] in ("data", "queue", "external") and arguments["kind"] != node["level"]:
                    raise ArchStudioError(f"kind of a {node['level']} part is always {node['level']}")
                node[field] = arguments[field]
        node["manual"] = True
        _save(root, model)
        return {"text": f"Updated {node['level']} '{node['name']}' ({existing})." + NEXT, "action": "write_part",
                "id": existing, "stats": model["stats"]}
    if "name" not in arguments:
        raise ArchStudioError(f"Unknown part '{identifier}'; give a name to create it." + index.suggest(identifier))
    level = arguments.get("level") or (_level_of(identifier) if identifier else None) or ("service" if "parent" in arguments else "system")
    if level not in PART_LEVELS:
        raise ArchStudioError("level must be one of: " + ", ".join(PART_LEVELS))
    parent = None
    if level == "service":
        if "parent" not in arguments:
            raise ArchStudioError("A service needs parent: the id of its system")
        parent = index.find(arguments["parent"], kind="system")
        if index.nodes[parent]["level"] != "system":
            raise ArchStudioError("parent of a service must be a system id (s:...)")
    elif "parent" in arguments:
        raise ArchStudioError(f"A {level} has no parent")
    if identifier is None:
        identifier = _derive_id(level, arguments["name"], parent, index)
    elif _level_of(identifier) != level:
        raise ArchStudioError(f"The id of a {level} starts with {PREFIX[level]}")
    if identifier in index.nodes:
        return _write_part(root, {**arguments, "id": identifier, "level": level}, identity)
    if level in ("data", "queue", "external"):
        kind = level
    else:
        kind = arguments.get("kind") or (index.nodes[parent]["kind"] if parent else "backend")
    node = {"id": identifier, "level": level, "parent": parent, "name": arguments["name"], "kind": kind, "manual": True}
    for field in ("tech", "summary"):
        if field in arguments:
            node[field] = arguments[field]
    model["nodes"].append(node)
    _save(root, model)
    where = f" in {index.name(parent)}" if parent else ""
    return {"text": f"Created {level} '{node['name']}' ({identifier}){where}." + NEXT, "action": "write_part",
            "id": identifier, "stats": model["stats"]}


def _link_level(first, second):
    levels = {first["level"], second["level"]}
    if "file" in levels:
        if levels != {"file"}:
            raise ArchStudioError("A file can only be linked to another file; link their services instead")
        return "file"
    if "system" in levels:
        return "system"
    if "service" in levels:
        return "service"
    return "system"


def _write_link(root, arguments):
    model = _load(root)
    index = Index(model)
    source, target = index.find(arguments["from"]), index.find(arguments["to"])
    if source == target:
        raise ArchStudioError("from and to must be different parts")
    level = _link_level(index.nodes[source], index.nodes[target])
    protocol = arguments.get("protocol") or "HTTP"
    label = arguments.get("label")
    is_async = arguments["async"] if "async" in arguments else protocol.upper() in MESSAGING
    for link in model["links"]:
        if (link["from"], link["to"], link.get("protocol"), link.get("label") or "") == (source, target, protocol, label or ""):
            link["manual"] = True
            link["async"] = is_async
            _save(root, model)
            return {"text": f"The link {index.name(source)} -> {index.name(target)} ({protocol}) already existed; kept it." + NEXT,
                    "action": "write_link", "id": link["id"]}
    link = {"id": link_id("l", source, target, protocol, label), "from": source, "to": target, "level": level,
            "protocol": protocol, "async": is_async, "count": 1, "manual": True}
    if label:
        link["label"] = label
    model["links"].append(link)
    _save(root, model)
    return {"text": f"Linked {index.name(source)} -> {index.name(target)} ({protocol}{', ' + label if label else ''})." + NEXT,
            "action": "write_link", "id": link["id"], "stats": model["stats"]}


def _remove(root, arguments):
    model = _load(root)
    index = Index(model)
    found = index.find(arguments["id"], links=True)
    if found in index.links:
        link = index.links[found]
        removed = {found}
        if found.startswith(SUMMARY_PREFIXES):
            removed |= _summarized(index, link)
        model["links"] = [item for item in model["links"] if item["id"] not in removed]
        _save(root, model)
        return {"text": f"Removed the link {index.name(link['from'])} -> {index.name(link['to'])} ({link.get('protocol')})." + NEXT,
                "action": "remove", "id": found, "stats": model["stats"]}
    gone, queue = set(), [found]
    while queue:
        current = queue.pop()
        if current not in gone:
            gone.add(current)
            queue.extend(child["id"] for child in index.children.get(current, []))
    model["nodes"] = [node for node in model["nodes"] if node["id"] not in gone]
    model["links"] = [link for link in model["links"] if link["from"] not in gone and link["to"] not in gone]
    _save(root, model)
    node = index.nodes[found]
    extra = f" and {len(gone) - 1} parts inside it" if len(gone) > 1 else ""
    return {"text": f"Removed {node['level']} '{node['name']}'{extra}." + NEXT, "action": "remove", "id": found,
            "stats": model["stats"]}


def _summarized(index, summary):
    """The base links a summary link stands for."""

    def system_of(node_id):
        node = index.nodes.get(node_id)
        if node is None:
            return None
        if node["level"] == "service":
            return node.get("parent")
        if node["level"] == "file":
            parent = index.nodes.get(node.get("parent"))
            return parent.get("parent") if parent else None
        return node_id

    def service_of(node_id):
        node = index.nodes.get(node_id)
        return node.get("parent") if node and node["level"] == "file" else node_id

    result = set()
    for link in index.links.values():
        if link["id"] == summary["id"]:
            continue
        if summary["id"].startswith("lv") and link.get("level") == "file":
            if (service_of(link["from"]), service_of(link["to"])) == (summary["from"], summary["to"]) and link.get("protocol") == summary.get("protocol"):
                result.add(link["id"])
        elif summary["id"].startswith("ls") and link.get("level") in ("service", "file"):
            if ((system_of(link["from"]), system_of(link["to"])) == (summary["from"], summary["to"])
                    and _family(link.get("protocol")) == summary.get("protocol")):
                result.add(link["id"])
    return result


def _evidence(model, source, target):
    for link in model["links"]:
        if link["from"] == source and link["to"] == target and link.get("evidence"):
            return link["evidence"][0]
    return None


def _write_path(root, arguments):
    model = _load(root)
    index = Index(model)
    identifier = slug(arguments["name"])
    if not identifier:
        raise ArchStudioError("name needs letters or numbers")
    steps = []
    for number, step in enumerate(arguments["steps"], 1):
        try:
            source, target = index.find(step["from"]), index.find(step["to"])
        except ArchStudioError as error:
            raise ArchStudioError(f"Step {number}: {error}") from None
        entry = {"from": source, "to": target}
        if step.get("label"):
            entry["label"] = step["label"]
        entry["async"] = bool(step.get("async"))
        if step.get("note"):
            entry["note"] = step["note"]
        evidence = _evidence(model, source, target)
        if evidence:
            entry["evidence"] = evidence
        steps.append(entry)
    data = _paths(root)
    paths = [item for item in data["paths"] if isinstance(item, dict) and item.get("id") != identifier]
    replaced = len(paths) != len(data["paths"])
    if len(paths) >= MAX_PATHS:
        raise ArchStudioError(f"There can be at most {MAX_PATHS} paths; remove one with remove_path first")
    paths.append({"id": identifier, "name": arguments["name"], "steps": steps})
    _write_document(root, PATHS_FILE, {"paths": paths})
    verb = "Replaced" if replaced else "Saved"
    return {"text": f"{verb} path '{arguments['name']}' ({identifier}) with {len(steps)} steps. To show it, call focus "
                    f"with id '{identifier}' and mode 'path' or 'present'." + NEXT,
            "action": "write_path", "id": identifier}


def _remove_path(root, arguments):
    data = _paths(root)
    wanted = {arguments.get("id"), slug(arguments.get("id") or ""), slug(arguments.get("name") or "")} - {None, ""}
    remaining = [item for item in data["paths"] if item.get("id") not in wanted and item.get("name") not in wanted]
    if len(remaining) == len(data["paths"]):
        names = ", ".join(item.get("id", "") for item in data["paths"]) or "none"
        raise ArchStudioError(f"No such path. Existing paths: {names}.")
    _write_document(root, PATHS_FILE, {"paths": remaining})
    return {"text": f"Path removed; {len(remaining)} left." + NEXT, "action": "remove_path"}


def _write_proposal(root, arguments):
    model = _load(root)
    index = Index(model)
    added = {}
    nodes = []
    for item in arguments.get("nodes", []):
        entry = dict(item)
        if item["op"] == "add":
            given = item.get("id")
            implied = _level_of(given) if given else None
            if given and implied not in PART_LEVELS:
                raise ArchStudioError(f"'{given}' cannot be added: a new part id starts with s:, v:, d:, q: or x:")
            level = item.get("level") or implied or ("service" if "parent" in item else "system")
            if implied and level != implied:
                raise ArchStudioError(f"'{given}' is an id of level {implied}, but level says {level}")
            parent = None
            if level == "service":
                if "parent" not in item:
                    raise ArchStudioError("A new service in the proposal needs parent: the id of its system")
                parent = item["parent"] if item["parent"] in added else index.find(item["parent"], kind="system")
            identifier = item.get("id")
            if identifier is None and level == "service" and parent in added:
                identifier = f"v:{parent.split(':', 1)[1]}/{slug(item['name'])}"
            elif identifier is None:
                identifier = _derive_id(level, item["name"], parent, index)
            # A proposal adds only what is new; an existing part is marked with op 'change' instead.
            if identifier in index.nodes:
                raise ArchStudioError(f"'{identifier}' is already in the map; to mark it as changed use op 'change' with that id")
            key = slug(item.get("name") or identifier.split(":", 1)[1].rsplit("/", 1)[-1])
            twin = next((node["id"] for node in index.nodes.values()
                         if node.get("level") == level and (node.get("parent") or None) == parent
                         and slug(node.get("name", "")) == key), None)
            if twin:
                raise ArchStudioError(f"'{item.get('name') or identifier}' is already in the map as {twin}; "
                                      "to mark it as changed use op 'change' with that id")
            entry.update({"id": identifier, "level": level, "parent": parent})
            entry.setdefault("name", identifier.split(":", 1)[1].rsplit("/", 1)[-1])
            if "kind" not in entry:
                entry["kind"] = level if level in ("data", "queue", "external") else (
                    (index.nodes.get(parent) or added.get(parent) or {}).get("kind") or "backend")
            added[identifier] = entry
        else:
            entry["id"] = index.find(item["id"])
        nodes.append(entry)
    links = []
    for item in arguments.get("links", []):
        entry = dict(item)
        for side in ("from", "to"):
            entry[side] = item[side] if item[side] in added else index.find(item[side])
        links.append(entry)
    proposal = {"title": arguments["title"], "summary": arguments.get("summary", ""), "nodes": nodes, "links": links}
    _write_document(root, PROPOSAL_FILE, proposal)
    return {"text": f"Proposal '{arguments['title']}' saved: {len(nodes)} part changes, {len(links)} link changes. The map "
                    "now offers Atual / Proposta." + NEXT, "action": "write_proposal"}


def _clear_proposal(root, arguments):
    removed = delete_file(root, PROPOSAL_FILE)
    return {"text": ("Proposal cleared." if removed else "There was no proposal.") + NEXT, "action": "clear_proposal"}


_HANDLERS = {
    "read": _read, "focus": _focus, "write_part": _write_part, "write_link": _write_link, "remove": _remove,
    "write_path": _write_path, "remove_path": _remove_path, "write_proposal": _write_proposal,
    "clear_proposal": _clear_proposal,
}
