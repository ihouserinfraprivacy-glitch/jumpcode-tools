# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""The architecture model: link building, summaries, sizes, merges and validation."""

from .common import ArchStudioError, link_id

LEVELS = ("system", "service", "file", "data", "queue", "external")
KINDS = ("backend", "web", "mobile", "embedded", "desktop", "library", "data", "queue", "external", "file")
PREFIX = {"system": "s:", "service": "v:", "file": "f:", "data": "d:", "queue": "q:", "external": "x:"}
LEVEL_ORDER = {"system": 0, "service": 1, "data": 2, "queue": 3, "external": 4, "file": 5}
LINK_LEVEL_ORDER = {"system": 0, "service": 1, "file": 2}
MAX_EVIDENCE = 8
SUMMARY_PREFIXES = ("ls", "lv")


class Graph:
    """Collects nodes outside systems (data, queues, externals) and deduplicated links."""

    def __init__(self):
        self.nodes = {}
        self.links = {}
        self._places = {}

    def node(self, node_id, level, name, kind, tech=None):
        node = self.nodes.get(node_id)
        if node is None:
            node = {"id": node_id, "level": level, "parent": None, "name": name, "kind": kind}
            if tech:
                node["tech"] = tech
            self.nodes[node_id] = node
        return node

    def link(self, source, target, level, protocol, label=None, is_async=False, path=None, line=None):
        if not source or not target or source == target:
            return None
        key = (source, target, protocol, label or "")
        link = self.links.get(key)
        if link is None:
            link = {"id": link_id("l", source, target, protocol, label), "from": source, "to": target, "level": level,
                    "protocol": protocol, "async": bool(is_async), "count": 0, "evidence": []}
            if label:
                link["label"] = label
            self.links[key] = link
            self._places[key] = set()
        if path is None:
            link["count"] = max(link["count"], 1)
            return link
        place = (path, line or 1)
        if place not in self._places[key]:
            self._places[key].add(place)
            link["count"] += 1
            if len(link["evidence"]) < MAX_EVIDENCE:
                link["evidence"].append({"path": path, "line": line or 1})
        return link

    def all_links(self):
        return list(self.links.values())


def _family(protocol):
    upper = (protocol or "").upper()
    if upper in ("HTTP", "HTTPS", "REST"):
        return "HTTP"
    return protocol or "?"


def _merge_evidence(target, items):
    for item in items or ():
        if len(target) >= MAX_EVIDENCE:
            break
        if item not in target:
            target.append(item)


def summarize(model):
    """Rebuild derived links: cross-service imports at service level, cross-system links at system level."""
    nodes = {node["id"]: node for node in model["nodes"]}
    base = [link for link in model["links"] if not link["id"].startswith(SUMMARY_PREFIXES)
            and link.get("from") in nodes and link.get("to") in nodes]

    def service_of(node_id):
        node = nodes.get(node_id)
        if node is None:
            return None
        if node["level"] == "file":
            return node.get("parent")
        return node_id if node["level"] in ("service", "data", "queue", "external") else None

    def system_of(node_id):
        node = nodes.get(node_id)
        if node is None:
            return None
        if node["level"] in ("system", "data", "queue", "external"):
            return node_id
        if node["level"] == "service":
            return node.get("parent")
        if node["level"] == "file":
            parent = nodes.get(node.get("parent"))
            return parent.get("parent") if parent else None
        return None

    def aggregate(groups, prefix, level, key, link):
        entry = groups.get(key)
        if entry is None:
            entry = {"from": key[0], "to": key[1], "level": level, "protocol": key[2], "labels": set(), "async": True,
                     "count": 0, "evidence": [], "manual": False}
            groups[key] = entry
        entry["labels"].add(link.get("label") or "")
        entry["async"] = entry["async"] and bool(link.get("async"))
        entry["count"] += max(1, int(link.get("count") or 1))
        _merge_evidence(entry["evidence"], link.get("evidence"))
        entry["manual"] = entry["manual"] or bool(link.get("manual"))

    def finish(groups, prefix):
        result = []
        for entry in groups.values():
            labels = entry.pop("labels")
            label = next(iter(labels)) if len(labels) == 1 else ""
            manual = entry.pop("manual")
            link = {"id": link_id(prefix, entry["from"], entry["to"], entry["protocol"], label), **entry}
            if label:
                link["label"] = label
            if not link["evidence"]:
                del link["evidence"]
            if manual:
                link["manual"] = True
            result.append(link)
        return result

    service_groups = {}
    for link in base:
        if link.get("level") != "file":
            continue
        source, target = service_of(link["from"]), service_of(link["to"])
        if source and target and source != target:
            aggregate(service_groups, "lv", "service", (source, target, link.get("protocol") or "import"), link)
    service_summaries = finish(service_groups, "lv")
    for link in service_summaries:
        link["async"] = False
    system_groups = {}
    for link in [item for item in base if item.get("level") == "service"] + service_summaries:
        source, target = system_of(link["from"]), system_of(link["to"])
        if source and target and source != target:
            aggregate(system_groups, "ls", "system", (source, target, _family(link.get("protocol"))), link)
    model["links"] = sort_links(base + service_summaries + finish(system_groups, "ls"))
    return model


def sort_nodes(nodes):
    return sorted(nodes, key=lambda node: (LEVEL_ORDER.get(node.get("level"), 9), node["id"]))


def sort_links(links):
    return sorted(links, key=lambda link: (LINK_LEVEL_ORDER.get(link.get("level"), 9), link["from"], link["to"],
                                           link.get("protocol") or "", link.get("label") or "", link["id"]))


def resize(model):
    """Sum files and lines of files into services and systems that have files."""
    nodes = {node["id"]: node for node in model["nodes"]}
    sizes = {}
    for node in model["nodes"]:
        if node["level"] != "file":
            continue
        service = nodes.get(node.get("parent"))
        chain = [service, nodes.get(service.get("parent")) if service else None]
        for owner in chain:
            if owner is not None:
                files, lines = sizes.get(owner["id"], (0, 0))
                sizes[owner["id"]] = (files + 1, lines + int(node.get("lines") or 0))
    for node in model["nodes"]:
        if node["level"] in ("system", "service") and (node["id"] in sizes or "files" in node):
            node["files"], node["lines"] = sizes.get(node["id"], (0, 0))


def stats(model):
    counts = {"systems": 0, "services": 0, "files": 0, "links": 0, "lines": 0}
    for node in model["nodes"]:
        if node["level"] == "system":
            counts["systems"] += 1
        elif node["level"] == "service":
            counts["services"] += 1
        elif node["level"] == "file":
            counts["files"] += 1
            counts["lines"] += int(node.get("lines") or 0)
    if not counts["files"]:
        counts["lines"] = sum(int(node.get("lines") or 0) for node in model["nodes"] if node["level"] == "system")
    counts["links"] = sum(1 for link in model["links"] if link.get("level") != "file")
    model["stats"] = counts
    return counts


def finalize(model):
    """Derived links, sizes, order and stats, after any change."""
    resize(model)
    model["nodes"] = sort_nodes(model["nodes"])
    summarize(model)
    stats(model)
    return model


def empty(name, source):
    return {"version": 1, "name": name, "source": source, "scannedAt": None,
            "stats": {"systems": 0, "services": 0, "files": 0, "links": 0, "lines": 0},
            "nodes": [], "links": [], "deploy": None}


def check(model):
    """Shape check of a model read from disk; raises when it cannot be used safely."""
    try:
        if model.get("version") != 1 or not isinstance(model.get("nodes"), list) or not isinstance(model.get("links"), list):
            raise ValueError()
        identifiers = set()
        for node in model["nodes"]:
            if not isinstance(node, dict) or not isinstance(node.get("id"), str) or node.get("level") not in LEVELS:
                raise ValueError()
            if node["id"] in identifiers:
                raise ValueError()
            identifiers.add(node["id"])
        for link in model["links"]:
            if not isinstance(link, dict) or not all(isinstance(link.get(key), str) for key in ("id", "from", "to")):
                raise ValueError()
        if model.get("deploy") is not None and not isinstance(model["deploy"], dict):
            raise ValueError()
    except (ValueError, TypeError, AttributeError) as error:
        raise ArchStudioError("model.json is damaged; nothing was changed") from error
    return model


_MANUAL_FIELDS = ("name", "kind", "tech", "summary", "role")


def merge_previous(model, previous):
    """Keep what the model wrote by hand across rescans: created parts, edits, summaries and links."""
    if not previous:
        return model
    nodes = {node["id"]: node for node in model["nodes"]}
    old_nodes = [node for node in previous.get("nodes", []) if isinstance(node, dict) and isinstance(node.get("id"), str)]
    for old in sorted(old_nodes, key=lambda node: LEVEL_ORDER.get(node.get("level"), 9)):
        current = nodes.get(old["id"])
        if current is not None:
            if old.get("manual"):
                for field in _MANUAL_FIELDS:
                    if field in old:
                        current[field] = old[field]
                # Systems are merged first, including manually created destinations.
                parent = nodes.get(old.get("parent"))
                if current["level"] == "service" and parent and parent.get("level") == "system":
                    current["parent"] = parent["id"]
                current["manual"] = True
            elif old.get("summary") and "summary" not in current:
                current["summary"] = old["summary"]
            continue
        if not old.get("manual") or old.get("level") == "file":
            continue
        parent = old.get("parent")
        if parent is not None and parent not in nodes:
            continue
        kept = {key: value for key, value in old.items() if key not in ("files", "lines")}
        model["nodes"].append(kept)
        nodes[kept["id"]] = kept
    keys = {(link["from"], link["to"], link.get("protocol"), link.get("label") or ""): link for link in model["links"]}
    for old in previous.get("links", []):
        if not isinstance(old, dict) or not old.get("manual") or str(old.get("id", "")).startswith(SUMMARY_PREFIXES):
            continue
        if old.get("from") not in nodes or old.get("to") not in nodes:
            continue
        key = (old["from"], old["to"], old.get("protocol"), old.get("label") or "")
        if key in keys:
            keys[key]["manual"] = True
            # Endpoints, protocol and label form the key; preserve the remaining
            # editable setting without replacing newly scanned evidence/counts.
            if isinstance(old.get("async"), bool):
                keys[key]["async"] = old["async"]
        else:
            model["links"].append(dict(old))
    return model
