# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Short texts about the map for a small model: outline, one part, one link, and id lookups."""

import difflib

from .common import ArchStudioError
from .model import SUMMARY_PREFIXES

MAX_OUTLINE = 3000
MAX_DETAIL = 3500
MAX_LINKS_SHOWN = 25
MAX_CHILDREN = 30


def number(value):
    return f"{int(value or 0):,}"


class Index:
    """Lookups over one model: nodes, links and children by id."""

    def __init__(self, model):
        self.model = model
        self.nodes = {node["id"]: node for node in model.get("nodes", [])}
        self.links = {link["id"]: link for link in model.get("links", [])}
        self.children = {}
        for node in model.get("nodes", []):
            if node.get("parent"):
                self.children.setdefault(node["parent"], []).append(node)

    def name(self, node_id):
        node = self.nodes.get(node_id)
        return node["name"] if node else node_id

    def find(self, value, *, links=False, kind="part"):
        """Resolve an id, a path or a unique name; raise with close matches otherwise."""
        value = (value or "").strip()
        if value in self.nodes or (links and value in self.links):
            return value
        for prefix in ("s:", "v:", "f:", "d:", "q:", "x:"):
            if prefix + value in self.nodes:
                return prefix + value
        lowered = value.lower()
        matches = sorted(node["id"] for node in self.model.get("nodes", [])
                         if node.get("name", "").lower() == lowered and node["level"] != "file")
        if not matches:
            matches = sorted(node["id"] for node in self.model.get("nodes", [])
                             if node.get("name", "").lower() == lowered)
        if len(matches) == 1:
            return matches[0]
        if len(matches) > 1:
            raise ArchStudioError(f"'{value}' matches several {kind}s: {', '.join(matches[:8])}. Use one of these ids.")
        raise ArchStudioError(f"Unknown {kind} '{value}'." + self.suggest(value))

    def suggest(self, value):
        names = {}
        for node in self.model.get("nodes", []):
            names.setdefault(node["id"], node["id"])
            names.setdefault(node.get("name", ""), node["id"])
        close = difflib.get_close_matches(value, list(names), n=5, cutoff=0.5)
        if not close:
            close = [key for key in names if value.lower() in key.lower()][:5]
        ids = []
        for item in close:
            if names[item] not in ids:
                ids.append(names[item])
        return (" Close matches: " + ", ".join(ids) + ".") if ids else " Call read without id to see the outline."


def _bounded(lines, limit, tail):
    text, used = [], 0
    for line in lines:
        if used + len(line) + 1 > limit - len(tail) - 2:
            text.append("...")
            break
        text.append(line)
        used += len(line) + 1
    return "\n".join(text + [tail]).strip()


def _describe(node):
    parts = [node.get("kind") or node.get("level")]
    if node.get("tech"):
        parts.append(node["tech"])
    return ", ".join(part for part in parts if part)


def outline(model, paths=None, proposal=None):
    """Compact map for answering questions; at most about 3000 characters."""
    index = Index(model)
    stats = model.get("stats") or {}
    lines = [f"{model.get('name') or 'Map'} ({model.get('source') or 'no folder'}): {number(stats.get('systems'))} systems, "
             f"{number(stats.get('services'))} services, {number(stats.get('files'))} files, {number(stats.get('links'))} links, "
             f"{number(stats.get('lines'))} lines."]
    systems = [node for node in model["nodes"] if node["level"] == "system"]
    if systems:
        lines.append("Systems:")
    for system in systems:
        services = [child["name"] for child in index.children.get(system["id"], []) if child["level"] == "service"]
        shown = ", ".join(services[:12]) + (f", +{len(services) - 12}" if len(services) > 12 else "")
        lines.append(f"- {system['id']} {system['name']} [{_describe(system)}]" + (f": {shown}" if shown else ""))
    for level, title in (("data", "Data"), ("queue", "Queues"), ("external", "External")):
        items = []
        for node in model["nodes"]:
            if node["level"] == level:
                topics = sorted({link.get("label") for link in model["links"]
                                 if (link["from"] == node["id"] or link["to"] == node["id"]) and link.get("label")
                                 and link.get("level") == "service"})
                items.append(f"{node['id']} {node['name']}" + (f" ({', '.join(topics[:4])})" if level == "queue" and topics else ""))
        if items:
            lines.append(f"{title}: " + "; ".join(items))
    top = sorted((link for link in model["links"] if link.get("level") == "system"),
                 key=lambda link: (-int(link.get("count") or 1), link["from"], link["to"]))
    if top:
        lines.append("Main links:")
    for link in top[:15]:
        label = f' "{link["label"]}"' if link.get("label") else ""
        lines.append(f"- {index.name(link['from'])} -> {index.name(link['to'])} {link.get('protocol', '')}{label}"
                     + (" async" if link.get("async") else ""))
    deploy = model.get("deploy")
    if deploy:
        zones = [f"{zone['name']} ({sum(1 for unit in deploy['units'] if unit['zone'] == zone['id'])})" for zone in deploy["zones"]]
        lines.append("Deploy zones: " + ", ".join(zones))
    if paths:
        lines.append("Paths: " + ", ".join(f"{item['id']} ({item['name']})" for item in paths))
    if proposal:
        lines.append(f"Proposal: {proposal.get('title', '')}")
    return _bounded(lines, MAX_OUTLINE, "Use read with an id for one part.")


def _link_line(index, link, outgoing):
    other = link["to"] if outgoing else link["from"]
    arrow = "->" if outgoing else "<-"
    label = f' "{link["label"]}"' if link.get("label") else ""
    evidence = link.get("evidence") or []
    where = f" [{evidence[0]['path']}:{evidence[0]['line']}]" if evidence else ""
    count = f" x{link['count']}" if int(link.get("count") or 1) > 1 else ""
    return f"- {arrow} {other} ({index.name(other)}) {link.get('protocol', '')}{label}{' async' if link.get('async') else ''}{count}{where}"


def detail(model, node_id):
    index = Index(model)
    if node_id in index.links:
        return link_detail(index, index.links[node_id])
    node = index.nodes[node_id]
    head = f"{node['id']} \"{node['name']}\": {node['level']}"
    if node.get("parent"):
        head += f" in {node['parent']} ({index.name(node['parent'])})"
    head += f" [{_describe(node)}]"
    if node.get("role"):
        head += f", role {node['role']}"
    if node.get("files") is not None and node["level"] in ("system", "service"):
        head += f"; {number(node.get('files'))} files, {number(node.get('lines'))} lines"
    if node["level"] == "file":
        head += f"; {node.get('lang', '')}, {number(node.get('lines'))} lines, path {node.get('path', '')}"
    elif node.get("path"):
        head += f"; path {node['path']}"
    if node.get("manual"):
        head += "; written by hand"
    lines = [head + "."]
    if node.get("summary"):
        lines.append("Summary: " + node["summary"])
    if node.get("endpoints"):
        lines.append("Endpoints: " + "; ".join(f"{item['method']} {item['path']} ({item['file']}:{item['line']})"
                                               for item in node["endpoints"][:15]))
    if node.get("publishes") or node.get("consumes"):
        lines.append(f"Publishes: {', '.join(node.get('publishes') or []) or '-'}. Consumes: {', '.join(node.get('consumes') or []) or '-'}.")
    level = "file" if node["level"] == "file" else None
    outgoing = [link for link in model["links"] if link["from"] == node_id and (level is None or link.get("level") == "file")]
    incoming = [link for link in model["links"] if link["to"] == node_id and (level is None or link.get("level") == "file")]
    for title, items, direction in (("Out", outgoing, True), ("In", incoming, False)):
        if items:
            items = sorted(items, key=lambda link: (link["id"].startswith(SUMMARY_PREFIXES), -int(link.get("count") or 1), link["id"]))
            lines.append(f"{title} ({len(items)}):")
            lines.extend(_link_line(index, link, direction) for link in items[:MAX_LINKS_SHOWN])
    children = index.children.get(node_id, [])
    if children:
        names = [child["name"] for child in children[:MAX_CHILDREN]]
        lines.append(f"Children ({len(children)}): " + ", ".join(names) + (", ..." if len(children) > MAX_CHILDREN else ""))
    return _bounded(lines, MAX_DETAIL, "")


def link_detail(index, link):
    lines = [f"{link['id']}: {link['from']} ({index.name(link['from'])}) -> {link['to']} ({index.name(link['to'])}), "
             f"{link.get('protocol', '')}{' async' if link.get('async') else ''}, level {link.get('level')}, "
             f"{number(link.get('count') or 1)} places." + (f' Label "{link["label"]}".' if link.get("label") else "")]
    for item in link.get("evidence") or []:
        lines.append(f"- {item['path']}:{item['line']}")
    if link.get("manual"):
        lines.append("Written by hand.")
    return _bounded(lines, MAX_DETAIL, "")
