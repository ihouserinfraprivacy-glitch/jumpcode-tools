# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Turn communication facts into data, queue and external nodes and service-level links."""

import re

from .catalog import BROKERS, LOCAL_STORES, TARGETS, external_for_host, host_target, ignored_host, plausible_api
from .comms import connection_target
from .common import slug
from .structure import CLIENT_KINDS, choose

_STATIC = re.compile(r"\.(?:png|jpe?g|gif|svg|webp|ico|css|js|mjs|woff2?|ttf|otf|mp4|mp3|wav|pdf|zip|gz|map|html?|bin|hex|apk|ipa)(?:[?#].*)?$", re.I)
_LOCAL = {"localhost", "127.0.0.1", "0.0.0.0", "host.docker.internal", "10.0.2.2"}
_CLUSTER_HOST = re.compile(r"\.svc(?:\.|$)|\.cluster\.local$|\.internal$|\.local$|\.default$")
_BASE_ENV = re.compile(r"(?:^|_)(?:API|BACKEND|SERVER|GATEWAY|BASE|APP_API|PUBLIC_API)$")
_HTTP = {"http", "https", "ws", "wss", "grpc", "grpcs"}


class Resolution:
    """Resolves the facts of one scan against the systems and services found."""

    def __init__(self, structure, facts, graph, aliases, deploy_state, source_name):
        self.structure = structure
        self.facts = facts
        self.graph = graph
        self.aliases = aliases
        self.hosts = deploy_state.hosts if deploy_state is not None else {}
        self.arch_links = deploy_state.arch_links if deploy_state is not None else []
        self.nodes = {node["id"]: node for node in structure.systems + structure.services}
        self.kinds = {system_id: info["kind"] for system_id, info in structure.system_info.items()}
        self.tokens = {token for token in [slug(source_name).replace("-", "")] +
                       [slug(node["name"]).replace("-", "") for node in structure.systems] if len(token) >= 4}
        self.protocols = set()
        self.client_calls = {}
        self.broker_uses = {}
        self._gateway = False

    def system_kind(self, service):
        return self.kinds.get(self.structure.service_system.get(service))

    def link(self, source, target, protocol, label=None, is_async=False, path=None, line=None):
        if source and target and source != target:
            self.graph.link(source, target, "service", protocol, label, is_async, path, line)
            self.protocols.add((source, target, protocol))

    def target(self, key, service):
        node_id, level, name, tech, protocol = TARGETS[key]
        if key in LOCAL_STORES and self.system_kind(service) in CLIENT_KINDS | {"embedded"}:
            system = self.nodes.get(self.structure.service_system.get(service))
            node_id = f"{node_id}-{slug(system['name']) if system else 'local'}"
            name = "SQLite local"
        self.graph.node(node_id, level, name, level, tech)
        return node_id, protocol, level

    def use(self, service, key, path, line, label=None):
        if key in BROKERS:
            self.broker_uses.setdefault((service, key), (path, line))
            return
        node_id, protocol, level = self.target(key, service)
        self.link(service, node_id, protocol, label, level == "queue", path, line)

    def entry(self, system_id):
        services = [node for node in self.structure.services if node["parent"] == system_id and node.get("role") != "hardware"]
        if not services:
            return None
        scored = sorted((self._score(node), node["id"]) for node in services if self._score(node) is not None)
        if scored:
            return scored[0][1]
        with_routes = sorted(services, key=lambda node: (-len(self.facts.endpoints.get(node["id"], [])), node["id"]))
        if self.facts.endpoints.get(with_routes[0]["id"]):
            return with_routes[0]["id"]
        root = "v:" + self.nodes[system_id]["path"]
        return root if root in self.nodes else services[0]["id"]

    @staticmethod
    def _score(node):
        name = slug(node["name"])
        if "gateway" in name:
            return 0
        if any(word in name.split("-") for word in ("bff", "edge", "proxy")):
            return 1
        if name in ("api", "backend", "web-api", "server"):
            return 2
        return None

    def gateway(self):
        if self._gateway is not False:
            return self._gateway
        backends = [node["id"] for node in self.structure.systems if node["kind"] == "backend"]
        result = None
        if len(backends) == 1:
            result = self.entry(backends[0])
        elif backends:
            scored = sorted((self._score(node), node["id"]) for node in self.structure.services
                            if node["parent"] in backends and self._score(node) is not None)
            if scored and (len(scored) == 1 or scored[0][0] < scored[1][0]):
                result = scored[0][1]
        self._gateway = result
        return result

    def as_service(self, node_id):
        node = self.nodes.get(node_id)
        if node is None:
            return node_id if node_id and node_id[:2] in ("d:", "q:", "x:") else None
        return self.entry(node_id) if node["level"] == "system" else node_id

    def by_host(self, host, caller=None):
        host = (host or "").lower()
        candidates = [host]
        if "." not in host or _CLUSTER_HOST.search(host):
            candidates.append(host.split(".")[0])
        for candidate in candidates:
            if self.hosts.get(candidate):
                return self.hosts[candidate]
            found = choose(self.aliases.get(slug(candidate)), self.structure, caller)
            if found:
                return found
        return None

    def project_host(self, host):
        flat = re.sub(r"[^a-z0-9]", "", host.lower())
        return any(token in flat for token in self.tokens)

    def client_call(self, service, target, secure, path, line):
        entry = self.client_calls.setdefault((service, target), {"secure": False, "places": []})
        entry["secure"] = entry["secure"] or secure
        entry["places"].append((path, line))

    def run(self):
        facts = self.facts
        keys = {}
        for service, key, path, line in facts.libraries:
            keys.setdefault(service, set()).add(key)
        for service, key, path, line in facts.libraries:
            if key == "aws" and keys[service] & {"s3", "dynamodb", "sqs"}:
                continue
            self.use(service, key, path, line)
        self._grpc()
        self._urls()
        self._hostports()
        self._envs()
        self._deployment()
        self._messages()
        self._queues()
        for (service, target), entry in sorted(self.client_calls.items()):
            label = "HTTPS · REST" if entry["secure"] else "HTTP · REST"
            for path, line in entry["places"]:
                self.link(service, target, "HTTP", label, False, path, line)
        for service, endpoints in facts.endpoints.items():
            node = self.nodes.get(service)
            if node is not None and endpoints:
                node["endpoints"] = sorted(endpoints, key=lambda item: (item["path"], item["method"]))

    def _grpc(self):
        facts = self.facts
        known = set(facts.proto) | set(facts.grpc_servers)
        for service, raw, name, path, line in facts.grpc_clients:
            if name not in known:
                continue
            servers = set(facts.grpc_servers.get(name, {}))
            if not servers:
                found = self.as_service(self.by_host(name, service))
                servers = {found} if found else set()
            label = facts.proto.get(name) or raw
            for server in sorted(servers):
                self.link(service, server, "gRPC", label, False, path, line)

    def _urls(self):
        facts = self.facts
        for service, scheme, host, port, url_path, path, line in facts.urls:
            key = connection_target(scheme, port)
            if key:
                self.use(service, key, path, line)
                continue
            if scheme not in _HTTP or _STATIC.search(url_path):
                continue
            protocol = "gRPC" if scheme.startswith("grpc") else "WebSocket" if scheme.startswith("ws") else "HTTP"
            client = self.system_kind(service) in CLIENT_KINDS
            if host in _LOCAL:
                owners = sorted(facts.ports.get(port or "", set()) - {service})
                target = owners[0] if len(owners) == 1 else self.gateway() if client else None
            else:
                target = self.as_service(self.by_host(host, service))
                if target is None:
                    known = host_target(host)
                    if known:
                        self.use(service, known, path, line, "HTTPS" if scheme == "https" else None)
                        continue
                    if ignored_host(host):
                        continue
                    if client or self.project_host(host):
                        target = self.gateway()
                    if target is None:
                        strict = self.system_kind(service) != "backend"
                        external = external_for_host(host) if plausible_api(host, url_path, strict) else None
                        if external:
                            self.graph.node(external[0], "external", external[1], "external")
                            self.link(service, external[0], "HTTP", "HTTPS" if scheme == "https" else None, False, path, line)
                        continue
            if not target or target == service:
                continue
            if client and protocol == "HTTP":
                self.client_call(service, target, scheme == "https", path, line)
            else:
                self.link(service, target, protocol, None, False, path, line)

    def _hostports(self):
        for service, host, port, path, line, grpc in self.facts.hostports:
            if not grpc:
                continue
            target = self.as_service(self.by_host(host, service))
            if target and target[:2] == "v:" and target != service and (service, target, "gRPC") not in self.protocols:
                self.link(service, target, "gRPC", None, False, path, line)

    def _envs(self):
        for service, name, prefix, path, line, grpc in self.facts.envs:
            target = self.as_service(self.by_host(prefix.lower().replace("_", "-"), service))
            client = self.system_kind(service) in CLIENT_KINDS
            if target is None or target[:2] != "v:":
                if client and _BASE_ENV.search(prefix):
                    gateway = self.gateway()
                    if gateway and gateway != service:
                        self.client_call(service, gateway, False, path, line)
                continue
            if target == service:
                continue
            uses_grpc = "GRPC" in name or (grpc and name.endswith(("_ADDR", "_ADDRESS", "_TARGET")))
            if uses_grpc:
                if (service, target, "gRPC") not in self.protocols:
                    self.link(service, target, "gRPC", None, False, path, line)
            elif client:
                self.client_call(service, target, False, path, line)
            elif (service, target, "gRPC") not in self.protocols:
                self.link(service, target, "HTTP", None, False, path, line)

    def _deployment(self):
        """Links read from compose environments: data stores, brokers and calls between services."""
        brokers = {value[0]: key for key, value in TARGETS.items() if key in BROKERS}
        stores = {value[0]: value[4] for key, value in TARGETS.items() if value[1] == "data"}
        for source, target, protocol, path, line in self.arch_links:
            service, target = self.as_service(source), self.as_service(target)
            if not service or not target or not service.startswith("v:") or service == target:
                continue
            if target in brokers:
                self.broker_uses.setdefault((service, brokers[target]), (path, line))
            elif target in stores:
                self.link(service, target, stores[target], None, False, path, line)
            elif not any(key[0] == service and key[1] == target for key in self.protocols):
                self.link(service, target, protocol, None, False, path, line)
            elif (service, target, protocol) in self.protocols and protocol != "gRPC":
                self.link(service, target, protocol, None, False, path, line)

    def _messages(self):
        facts = self.facts
        grouped = {}
        for service, broker, direction, topic, path, line in facts.messages:
            grouped.setdefault((service, broker, direction), []).append((topic, path, line))
        touched = set()
        for (service, broker, direction), items in sorted(grouped.items()):
            node_id, protocol, _ = self.target(broker, service)
            node = self.nodes.get(service)
            touched.add((service, broker))
            if direction == "publish":
                for topic, path, line in items:
                    self.link(service, node_id, protocol, topic, True, path, line)
                if node is not None:
                    node["publishes"] = sorted(set(node.get("publishes", [])) | {topic for topic, _, _ in items})
            elif direction == "consume" or direction == "bind":
                if direction == "consume" and (service, broker, "bind") in grouped:
                    continue
                for topic, path, line in items:
                    self.link(node_id, service, protocol, topic, True, path, line)
                if node is not None:
                    node["consumes"] = sorted(set(node.get("consumes", [])) | {topic for topic, _, _ in items})
        for (service, broker), (path, line) in sorted(self.broker_uses.items()):
            if (service, broker) not in touched and not any(key[0] == service and key[1] == broker for key in grouped):
                node_id, protocol, _ = self.target(broker, service)
                self.link(service, node_id, protocol, None, True, path, line)

    def _queues(self):
        groups = {}
        for service, handle, direction, path, line in self.facts.queues:
            system = self.structure.service_system.get(service)
            groups.setdefault((system, handle), {"send": [], "receive": []})[direction].append((service, path, line))
        for (system, handle), sides in sorted(groups.items()):
            for sender, path, line in sides["send"]:
                for receiver, _, _ in sides["receive"]:
                    if sender != receiver:
                        self.link(sender, receiver, "FreeRTOS", handle, True, path, line)
