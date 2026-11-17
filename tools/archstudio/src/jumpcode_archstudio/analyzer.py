# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""The deterministic analyzer: reads a source tree (never runs it) and builds the architecture model.

Phases: folders, projects (systems), file reading, services and files, links, deployment.
"""

import re
import time

from . import deploy as deployment
from .catalog import BROKERS, library_target
from .comms import Facts, collect, collect_messages
from .common import utc_now
from .imports import LineIndex, Resolver, extract
from .model import Graph, finalize
from .resolve import Resolution
from .structure import build, find_manifests, find_systems, service_slugs
from .walker import Budget, walk

STEPS = (
    ("tree", "Estrutura de pastas"),
    ("systems", "Sistemas encontrados"),
    ("read", "Leitura dos arquivos"),
    ("services", "Serviços e arquivos"),
    ("links", "Ligações entre serviços"),
    ("deploy", "Implantação"),
)


def number(value):
    return f"{value:,}".replace(",", ".")


class Progress:
    """progress.json while scanning, written at most every `interval` seconds."""

    def __init__(self, write=None, clock=time.monotonic, interval=0.3):
        self.write = write
        self.clock = clock
        self.interval = interval
        self.steps = [{"id": step, "label": label, "state": "todo"} for step, label in STEPS]
        self.phase = None
        self.current = None
        self.done = 0
        self.total = 0
        self.last = None

    def _step(self, step_id):
        return next(step for step in self.steps if step["id"] == step_id)

    def start(self, step_id, total=0):
        self._step(step_id)["state"] = "run"
        self.phase, self.done, self.total, self.current = step_id, 0, total, None
        self.flush(True)

    def finish(self, step_id, note=None):
        step = self._step(step_id)
        step["state"] = "done"
        if note is not None:
            step["note"] = note
        self.flush(True)

    def tick(self, current=None, done=None, total=None, note=None):
        if current is not None:
            self.current = current
        if done is not None:
            self.done = done
        if total is not None:
            self.total = total
        if note is not None and self.phase:
            self._step(self.phase)["note"] = note
        self.flush()

    def snapshot(self, status="scanning", error=None):
        data = {"status": status, "phase": self.phase, "steps": [dict(step) for step in self.steps],
                "current": self.current, "done": self.done, "total": self.total}
        if error:
            data["error"] = error
        return data

    def flush(self, force=False):
        if self.write is None:
            return
        now = self.clock()
        if not force and self.last is not None and now - self.last < self.interval:
            return
        self.last = now
        self.write(self.snapshot())


def display_name(source_name):
    words = [word for word in re.split(r"[-_\s]+", source_name or "") if word]
    return " ".join(word[:1].upper() + word[1:] for word in words)[:80] or "Projeto"


class Result:
    """The model and what the summary for the model needs."""

    def __init__(self, model, notes, elapsed):
        self.model = model
        self.notes = notes
        self.elapsed = elapsed


def analyze(source, budget=None, progress=None, partial=None, source_name=None):
    """Analyze a folder. `partial(model)` receives the map as it grows; Cancelled propagates."""
    budget = budget or Budget()
    progress = progress or Progress()
    source_name = source_name or source.name or "projeto"
    base = {"version": 1, "name": display_name(source_name), "source": source_name, "scannedAt": None,
            "stats": {}, "nodes": [], "links": [], "deploy": None}

    progress.start("tree")
    tree = walk(source, budget, lambda folder, count: progress.tick(current=folder or ".", note=f"{number(count)} pastas"))
    progress.finish("tree", f"{number(len(tree.dirs))} pastas")

    progress.start("systems")
    manifests = find_manifests(tree, budget, lambda folder, count: progress.tick(current=folder or ".", note=str(count)))
    systems = find_systems(tree, manifests, source_name, budget)
    progress.finish("systems", str(len(systems)))
    if partial is not None:
        nodes = [{"id": "s:" + (system["path"] or "."), "level": "system", "parent": None, "name": system["name"],
                  "kind": system["kind"], "path": system["path"] or ".", **({"tech": system["tech"]} if system["tech"] else {})}
                 for system in systems]
        partial(finalize({**base, "nodes": nodes, "links": []}))

    paths = sorted(tree.files)
    progress.start("read", len(paths))
    for index, path in enumerate(paths):
        if index % 32 == 0:
            budget.check()
            if budget.expired():
                budget.note("time limit reached while reading files; sizes of unread files are estimates")
                break
        tree.read(path, budget)
        progress.tick(current=path, done=index + 1)
    progress.finish("read", f"{number(len(paths))} arquivos")

    progress.start("services")
    structure = build(tree, manifests, systems, budget)
    progress.finish("services", str(len(structure.services)))
    graph = Graph()
    for link in structure.links:
        evidence = link["evidence"][0]
        graph.link(link["from"], link["to"], "service", link["protocol"], None, False, evidence["path"], evidence["line"])
    if partial is not None:
        partial(finalize({**base, "nodes": structure.nodes(), "links": graph.all_links()}))

    progress.start("links", len(structure.files))
    facts = Facts()
    file_ids = {node["id"] for node in structure.files}
    resolver = Resolver(tree, structure)
    file_keys, service_keys = {}, {}
    stopped = False
    for index, node in enumerate(structure.files):
        if index % 16 == 0:
            budget.check()
            if budget.expired():
                budget.note("time limit reached while finding links; some links may be missing")
                stopped = True
                break
        path = node["path"]
        text = tree.texts.get(path)
        progress.tick(current=path, done=index + 1, note=f"{number(index + 1)} de {number(len(structure.files))} arquivos")
        if not text:
            continue
        service = node["parent"]
        system_kind = structure.system_info[structure.service_system[service]]["kind"]
        lines = LineIndex(text)
        for item in extract(node["lang"], text, lines):
            targets, library = resolver.resolve(path, item)
            for target in targets:
                if target != path and "f:" + target in file_ids:
                    graph.link("f:" + path, "f:" + target, "file", "include" if item.style in ("c", "csys") else "import",
                               None, False, path, item.line)
            key = library_target(library, exact=item.style == "csys") if library else None
            if key:
                facts.libraries.append((service, key, path, item.line))
                file_keys.setdefault(path, set()).add(key)
                service_keys.setdefault(service, set()).add(key)
        collect(facts, service, system_kind, path, node["lang"], text, lines)
    system_constants = {}
    for service, table in facts.constants.items():
        merged = system_constants.setdefault(structure.service_system[service], {})
        for name, value in table.items():
            merged.setdefault(name, value)
    if not stopped:
        for node in structure.files:
            text = tree.texts.get(node["path"])
            if not text:
                continue
            service = node["parent"]
            brokers = {("redis-pubsub" if key == "redis" else key) for key in file_keys.get(node["path"], ())}
            brokers &= set(BROKERS)
            if not brokers:
                brokers = {key for key in service_keys.get(service, ()) if key in BROKERS}
            if "esp_mqtt_client_" in text:
                brokers.add("mqtt")
            if not brokers:
                continue
            constants = dict(system_constants.get(structure.service_system[service], {}))
            constants.update(facts.constants.get(service, {}))
            collect_messages(facts, service, node["path"], node["lang"], text, LineIndex(text), brokers, constants)
    aliases = service_slugs(structure)
    state = deployment.extract(tree, structure, aliases, graph, budget)
    resolution = Resolution(structure, facts, graph, aliases, state, source_name)
    resolution.run()
    progress.finish("links", f"{number(sum(1 for link in graph.all_links() if link['level'] != 'file'))} ligações")

    progress.start("deploy")
    model = {**base, "scannedAt": utc_now(), "nodes": structure.nodes() + list(graph.nodes.values()),
             "links": graph.all_links()}
    finalize(model)
    model["deploy"] = deployment.finish(state, model)
    zones = len(model["deploy"]["zones"]) if model["deploy"] else 0
    progress.finish("deploy", f"{zones} zonas" if zones else "nada encontrado")
    notes = list(budget.notes) + list(structure.notes)
    return Result(model, notes, budget.elapsed())
