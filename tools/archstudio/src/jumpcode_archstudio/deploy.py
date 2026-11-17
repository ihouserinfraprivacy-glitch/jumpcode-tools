# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Deployment: zones and units from compose, Kubernetes, Terraform and platform files."""

import posixpath
import re

try:
    import tomllib
except ImportError:  # pragma: no cover
    tomllib = None

from . import yamlish
from .catalog import BROKER_NAMES, SCHEMES, TARGETS, image_target
from .common import slug
from .structure import CLIENT_KINDS, base_name, choose, parent_folder

_COMPOSE = re.compile(r"^(?:docker-)?compose(?:[.\-][\w.\-]+)?\.ya?ml$")
_RESOURCE = re.compile(r"""(?m)^\s*resource\s+"(\w+)"\s+"([\w\-]+)"\s*\{""")
_URL = re.compile(r"^(?P<scheme>[a-z+]+)://(?:[^@/\s]+@)?(?P<host>[A-Za-z0-9_.\-]+)(?::(?P<port>\d+))?")
_HOSTPORT = re.compile(r"^(?P<host>[a-z][a-z0-9\-]{1,62}):(?P<port>\d{2,5})$")
TERRAFORM = {
    "aws_db_instance": ("database", None), "aws_rds_cluster": ("database", None),
    "aws_elasticache_cluster": ("cache", "redis"), "aws_elasticache_replication_group": ("cache", "redis"),
    "aws_mq_broker": ("queue", "rabbitmq"), "aws_msk_cluster": ("queue", "kafka"), "aws_sqs_queue": ("queue", "sqs"),
    "aws_sns_topic": ("queue", None), "aws_lb": ("balancer", None), "aws_alb": ("balancer", None), "aws_elb": ("balancer", None),
    "aws_api_gateway_rest_api": ("balancer", None), "aws_apigatewayv2_api": ("balancer", None),
    "aws_ecs_service": ("container", None), "aws_lambda_function": ("function", None), "aws_s3_bucket": ("database", "s3"),
    "aws_dynamodb_table": ("database", "dynamodb"), "aws_instance": ("container", None),
    "google_sql_database_instance": ("database", None), "google_redis_instance": ("cache", "redis"),
    "google_pubsub_topic": ("queue", None), "google_cloud_run_service": ("container", None),
    "google_cloud_run_v2_service": ("container", None), "google_cloudfunctions_function": ("function", None),
    "google_cloudfunctions2_function": ("function", None), "google_storage_bucket": ("database", None),
    "azurerm_postgresql_flexible_server": ("database", "postgresql"), "azurerm_postgresql_server": ("database", "postgresql"),
    "azurerm_mysql_flexible_server": ("database", "mysql"), "azurerm_redis_cache": ("cache", "redis"),
    "azurerm_servicebus_namespace": ("queue", None), "azurerm_linux_web_app": ("container", None),
    "azurerm_container_app": ("container", None), "azurerm_linux_function_app": ("function", None),
}
CLUSTERS = {"aws_eks_cluster": "z:aws", "google_container_cluster": "z:gcp", "azurerm_kubernetes_cluster": "z:azure"}
CLOUDS = {"aws": ("z:aws", "AWS"), "google": ("z:gcp", "Google Cloud"), "azurerm": ("z:azure", "Azure")}


class Deploy:
    """Zones, units and links found so far, plus hints for the link resolution."""

    def __init__(self, structure, aliases, graph):
        self.zones = {}
        self.units = {}
        self.links = []
        self.hosts = {}        # host name -> node id (ingress hosts, compose names)
        self.arch_links = []   # (from node, to node, protocol, path, line)
        self.graph = graph
        self.aliases = aliases
        self.structure = structure
        self.by_path = {}
        for node in structure.systems + structure.services:
            path = node.get("path")
            if path and node.get("role") != "hardware" and not structure.service_info.get(node["id"], {}).get("unit"):
                self.by_path.setdefault("" if path == "." else path, node["id"])
        self.levels = {node["id"]: node["level"] for node in structure.systems + structure.services}

    def zone(self, zone_id, name, kind, parent=None):
        zone = self.zones.setdefault(zone_id, {"id": zone_id, "name": name, "kind": kind, "parent": parent})
        if parent and not zone.get("parent"):
            zone["parent"] = parent
        return zone

    def unit(self, zone_id, name, kind, node=None, replicas=1, image=None, ports=()):
        base = "u:" + (slug(name) or "unidade")
        unit_id = base
        if unit_id in self.units:
            unit_id = f"u:{zone_id.split(':', 1)[1]}-{slug(name) or 'unidade'}"
            counter = 2
            while unit_id in self.units:
                unit_id = f"{base}-{counter}"
                counter += 1
        unit = {"id": unit_id, "name": name, "zone": zone_id, "kind": kind, "replicas": replicas, "image": image,
                "ports": [str(port) for port in ports][:12], "node": node}
        self.units[unit_id] = unit
        return unit

    def node_for_folder(self, folder):
        while True:
            if folder in self.by_path:
                return self.by_path[folder]
            if not folder:
                return None
            folder = parent_folder(folder)

    def node_for_name(self, *names):
        for name in names:
            found = choose(self.aliases.get(slug(name or "")), self.structure)
            if found:
                return found
        return None

    def host(self, name, node):
        if node:
            self.hosts.setdefault(name.lower(), node)

    def data_node(self, key, image=None):
        if not key or key not in TARGETS:
            return None
        node_id, level, name, tech, _ = TARGETS[key]
        node = self.graph.node(node_id, level, name, level, tech)
        image_name = (image or "").lower().split("/")[-1].split(":")[0]
        if level == "queue" and image_name in BROKER_NAMES and node["name"] == TARGETS[key][2]:
            node["name"] = BROKER_NAMES[image_name]
        return node_id


def _image_name(image):
    return (image or "").split("@")[0].rsplit("/", 1)[-1].split(":")[0]


def _ports(values):
    result = []
    for value in values if isinstance(values, list) else []:
        if isinstance(value, dict):
            value = value.get("target") or value.get("containerPort") or value.get("port")
        text = str(value).split("/")[0]
        port = text.rsplit(":", 1)[-1]
        if port.isdigit() and port not in result:
            result.append(port)
    return result


def _line(text, needle):
    index = text.find(needle)
    return text.count("\n", 0, index) + 1 if index >= 0 else 1


def _compose(state, path, text):
    document = yamlish.load(text)
    services = document.get("services") if isinstance(document, dict) else None
    if not isinstance(services, dict):
        return
    zone = "z:compose"
    state.zone(zone, "Docker Compose", "host")
    folder = parent_folder(path)
    units, environments = {}, {}
    for name in sorted(services):
        spec = services[name] if isinstance(services[name], dict) else {}
        image = spec.get("image") if isinstance(spec.get("image"), str) else None
        node = None
        build = spec.get("build")
        if isinstance(build, dict):
            context, dockerfile = build.get("context") or ".", build.get("dockerfile")
        else:
            context, dockerfile = build, None
        if isinstance(context, str):
            target = posixpath.normpath(posixpath.join(folder, context.replace("\\", "/")))
            if isinstance(dockerfile, str):
                target = posixpath.normpath(posixpath.join(target, parent_folder(dockerfile.replace("\\", "/"))))
            if not target.startswith("..") and not target.startswith("/"):
                node = state.node_for_folder("" if target == "." else target)
        key, kind = image_target(image or "")
        if node is None and key:
            node = state.data_node(key, image)
        if node is None:
            node = state.node_for_name(name, _image_name(image))
            if node is None and not key:
                key, kind = image_target(name)
                node = state.data_node(key, name) if key else None
        if node is not None and node.startswith(("v:", "s:")):
            kind = "container"
        deploy = spec.get("deploy") if isinstance(spec.get("deploy"), dict) else {}
        replicas = deploy.get("replicas") if isinstance(deploy.get("replicas"), int) else 1
        unit = state.unit(zone, name, kind, node, replicas, image, _ports(spec.get("ports") or spec.get("expose")))
        units[name] = unit
        state.host(name, node)
        environment = spec.get("environment")
        if isinstance(environment, list):
            environment = dict(str(item).split("=", 1) for item in environment if "=" in str(item))
        environments[name] = environment if isinstance(environment, dict) else {}
        depends = spec.get("depends_on")
        spec["_depends"] = sorted(depends) if isinstance(depends, (list, dict)) else []
    for name in sorted(services):
        unit = units[name]
        for target in services[name].get("_depends", []) if isinstance(services[name], dict) else []:
            if target in units:
                state.links.append({"from": unit["id"], "to": units[target]["id"], "label": "depende de", "async": False})
        for key, value in sorted(environments[name].items()):
            value = str(value or "").strip()
            match = _URL.match(value)
            host = match.group("host").lower() if match else None
            scheme = match.group("scheme").lower() if match else None
            if not match:
                plain = _HOSTPORT.match(value)
                if not plain:
                    continue
                host, scheme = plain.group("host"), "grpc" if "GRPC" in key.upper() or plain.group("port") in ("9090", "50051") else "http"
            if host not in units or unit["node"] is None:
                continue
            target = units[host]["node"]
            stored = next((value for value in TARGETS.values() if value[0] == target), None)
            if stored is not None:
                protocol = stored[4]
            else:
                protocol = {"grpc": "gRPC", "http": "HTTP", "https": "HTTP", "ws": "WebSocket", "wss": "WebSocket"}.get(scheme)
                if protocol is None and scheme in SCHEMES:
                    protocol = TARGETS[SCHEMES[scheme]][4]
            if target and protocol:
                state.arch_links.append((unit["node"], target, protocol, path, _line(text, key)))


def _labels_match(selector, labels):
    return isinstance(selector, dict) and isinstance(labels, dict) and selector and all(labels.get(key) == value for key, value in selector.items())


def _kubernetes(state, documents):
    workloads, services, ingresses, namespaces = [], [], [], set()
    for document in documents:
        if not isinstance(document, dict) or not isinstance(document.get("kind"), str):
            continue
        meta = document.get("metadata") if isinstance(document.get("metadata"), dict) else {}
        name = meta.get("name")
        if not isinstance(name, str):
            continue
        namespaces.add(meta.get("namespace") or "default")
        spec = document.get("spec") if isinstance(document.get("spec"), dict) else {}
        kind = document["kind"]
        if kind in ("Deployment", "StatefulSet", "DaemonSet", "CronJob", "Job"):
            template = spec.get("template") if isinstance(spec.get("template"), dict) else {}
            if kind == "CronJob":
                job = ((spec.get("jobTemplate") or {}).get("spec") or {}) if isinstance(spec.get("jobTemplate"), dict) else {}
                template = job.get("template") if isinstance(job, dict) and isinstance(job.get("template"), dict) else {}
            pod = template.get("spec") if isinstance(template.get("spec"), dict) else {}
            containers = [item for item in pod.get("containers") or [] if isinstance(item, dict)]
            image = containers[0].get("image") if containers else None
            ports = [port.get("containerPort") for item in containers for port in item.get("ports") or [] if isinstance(port, dict)]
            labels = (template.get("metadata") or {}).get("labels") if isinstance(template.get("metadata"), dict) else {}
            replicas = spec.get("replicas") if isinstance(spec.get("replicas"), int) else (None if kind == "DaemonSet" else 1)
            workloads.append({"name": name, "kind": kind, "image": image if isinstance(image, str) else None,
                              "ports": [str(port) for port in ports if port], "labels": labels or {}, "replicas": replicas})
        elif kind == "Service":
            services.append({"name": name, "selector": spec.get("selector") or {}})
        elif kind == "Ingress":
            backends, hosts = [], []
            for rule in spec.get("rules") or []:
                if not isinstance(rule, dict):
                    continue
                if isinstance(rule.get("host"), str):
                    hosts.append(rule["host"].lower())
                for item in ((rule.get("http") or {}).get("paths") or []) if isinstance(rule.get("http"), dict) else []:
                    backend = item.get("backend") if isinstance(item, dict) else None
                    if isinstance(backend, dict):
                        target = (backend.get("service") or {}).get("name") if isinstance(backend.get("service"), dict) else backend.get("serviceName")
                        if isinstance(target, str):
                            backends.append(target)
            ingresses.append({"name": name, "backends": backends, "hosts": hosts})
    if not workloads and not ingresses:
        return
    custom = sorted(namespace for namespace in namespaces if namespace != "default")
    zone = state.zone("z:k8s", "Kubernetes · " + custom[0] if len(custom) == 1 else "Kubernetes", "cluster")
    by_name = {}
    for workload in workloads:
        key, kind = image_target(workload["image"] or "")
        node = state.node_for_name(workload["name"], _image_name(workload["image"]))
        if node is None and key:
            node = state.data_node(key, workload["image"])
        if node is not None and node.startswith(("v:", "s:")):
            kind = "function" if workload["kind"] in ("CronJob", "Job") else "container"
        unit = state.unit(zone["id"], workload["name"], kind, node, workload["replicas"], workload["image"], workload["ports"])
        by_name[workload["name"]] = unit
        for service in services:
            if _labels_match(service["selector"], workload["labels"]):
                by_name.setdefault(service["name"], unit)
                state.host(service["name"], node)
        state.host(workload["name"], node)
    for ingress in ingresses:
        unit = state.unit(zone["id"], ingress["name"], "balancer")
        for target in ingress["backends"]:
            if target in by_name:
                state.links.append({"from": unit["id"], "to": by_name[target]["id"], "label": "HTTP", "async": False})
                for host in ingress["hosts"]:
                    state.host(host, by_name[target]["node"])


def _terraform(state, path, text):
    region = re.search(r"""provider\s+"aws"\s*\{[^}]*?\bregion\s*=\s*"([^"]+)\"""", text, re.S)
    region = region.group(1) if region else None
    if region is None:
        variable = re.search(r"""variable\s+"(?:aws_)?region"\s*\{[^}]*?default\s*=\s*"([^"]+)\"""", text, re.S)
        region = variable.group(1) if variable else None
    matches = list(_RESOURCE.finditer(text))
    for index, match in enumerate(matches):
        kind_name, label = match.group(1), match.group(2)
        body = text[match.end():matches[index + 1].start() if index + 1 < len(matches) else len(text)]
        provider = kind_name.split("_", 1)[0]
        if provider not in CLOUDS:
            continue
        zone_id, cloud = CLOUDS[provider]
        if kind_name in CLUSTERS:
            state.zone(zone_id, f"{cloud} · {region}" if region and provider == "aws" else cloud, "cloud")
            if "z:k8s" in state.zones:
                state.zones["z:k8s"]["parent"] = zone_id
            else:
                state.zone("z:k8s", "Kubernetes", "cluster", zone_id)
            continue
        if kind_name not in TERRAFORM:
            continue
        unit_kind, key = TERRAFORM[kind_name]
        state.zone(zone_id, f"{cloud} · {region}" if region and provider == "aws" else cloud, "cloud")
        engine = re.search(r"""\b(?:engine|engine_type|database_version)\s*=\s*"([^"]+)\"""", body)
        engine = engine.group(1).lower() if engine else ""
        if key is None and engine:
            key = ("postgresql" if "postgres" in engine else "mysql" if "mysql" in engine or "aurora" in engine else
                   "redis" if "redis" in engine else "rabbitmq" if "rabbit" in engine else None)
        name = re.search(r"""\b(?:identifier|name|cluster_id|replication_group_id|broker_name|function_name|cluster_name)\s*=\s*"([^"$]+)\"""", body)
        name = name.group(1) if name else label
        replicas = re.search(r"\b(?:desired_count|num_cache_nodes|count|instance_count)\s*=\s*(\d+)", body)
        node = state.data_node(key) if key else None
        if node is None and unit_kind in ("container", "function"):
            node = state.node_for_name(name, label)
        state.unit(zone_id, name, unit_kind, node, int(replicas.group(1)) if replicas else 1)


def _platforms(state, path, text):
    name = base_name(path)
    folder = parent_folder(path)
    node = state.node_for_folder(folder)
    if name == "vercel.json":
        state.zone("z:vercel", "Vercel", "cloud")
        state.unit("z:vercel", base_name(folder) or "site", "function", node)
    elif name == "fly.toml" and tomllib is not None:
        try:
            data = tomllib.loads(text)
        except (tomllib.TOMLDecodeError, ValueError):
            data = {}
        service = data.get("http_service") if isinstance(data.get("http_service"), dict) else {}
        state.zone("z:fly", "Fly.io" + (f" · {data['primary_region']}" if isinstance(data.get("primary_region"), str) else ""), "cloud")
        replicas = service.get("min_machines_running") if isinstance(service.get("min_machines_running"), int) else 1
        port = service.get("internal_port")
        state.unit("z:fly", str(data.get("app") or base_name(folder) or "app"), "container", node, replicas or 1, None,
                   [port] if port else [])
    elif name in ("serverless.yml", "serverless.yaml"):
        document = yamlish.load(text)
        if not isinstance(document, dict):
            return
        provider = document.get("provider") if isinstance(document.get("provider"), dict) else {}
        cloud = str(provider.get("name") or "aws")
        zone_id, label = CLOUDS.get("google" if cloud == "google" else "azurerm" if cloud == "azure" else "aws", ("z:aws", "AWS"))
        region = provider.get("region") if isinstance(provider.get("region"), str) else None
        state.zone(zone_id, f"{label} · {region}" if region else label, "cloud")
        for function in sorted((document.get("functions") or {}) if isinstance(document.get("functions"), dict) else {}):
            state.unit(zone_id, function, "function", node)
    elif name == "Procfile":
        state.zone("z:heroku", "Heroku", "cloud")
        for line in text.splitlines():
            process = re.match(r"^([\w\-]+)\s*:", line)
            if process:
                state.unit("z:heroku", f"{base_name(folder) or 'app'}-{process.group(1)}", "container", node)


def extract(tree, structure, aliases, graph, budget):
    """Read deployment files; returns the Deploy state (zones and units may be empty)."""
    state = Deploy(structure, aliases, graph)
    kubernetes, dockerfiles, compose, terraform, platforms = [], [], [], [], []
    for path in sorted(tree.files):
        budget.check()
        name = base_name(path)
        lang = tree.langs.get(path)
        if _COMPOSE.match(name):
            compose.append(path)
        elif lang == "yaml" and name not in ("serverless.yml", "serverless.yaml", "pubspec.yaml"):
            text = tree.read(path, budget)
            if text and "apiVersion" in text and re.search(r"(?m)^kind:\s*\w+", text):
                kubernetes.extend(yamlish.load_all(text))
        elif lang == "tf":
            terraform.append(path)
        elif name in ("vercel.json", "fly.toml", "serverless.yml", "serverless.yaml", "Procfile"):
            platforms.append(path)
        elif lang == "docker" and (name.startswith("Dockerfile") or name.endswith(".Dockerfile")):
            dockerfiles.append(path)
    # Real deployments first, so their units represent the nodes; local compose comes last.
    for path in terraform:
        _terraform(state, path, tree.read(path, budget) or "")
    _kubernetes(state, kubernetes)
    for path in platforms:
        _platforms(state, path, tree.read(path, budget) or "")
    for path in compose:
        text = tree.read(path, budget)
        if text:
            _compose(state, path, text)
    deployed = {unit["node"] for unit in state.units.values() if unit["node"]}
    exposes = {}
    for path in dockerfiles:
        text = tree.read(path, budget) or ""
        node = state.node_for_folder(parent_folder(path))
        ports = re.findall(r"(?m)^\s*EXPOSE\s+(\d{2,5})", text)
        if node:
            exposes.setdefault(node, ports)
    for unit in state.units.values():
        if unit["node"] in exposes and not unit["ports"]:
            unit["ports"] = exposes[unit["node"]][:12]
    if not state.units and exposes:
        state.zone("z:docker", "Docker", "host")
        for node, ports in sorted(exposes.items()):
            if node not in deployed:
                state.unit("z:docker", node.split(":", 1)[1].rsplit("/", 1)[-1], "container", node, 1, None, ports)
    return state


def finish(state, model):
    """The `deploy` object of model.json, with clients, devices, externals and links; None when nothing was found."""
    if not state.units:
        return None
    nodes = {node["id"]: node for node in model["nodes"]}
    by_node = {}
    for unit in state.units.values():
        if unit["node"]:
            by_node.setdefault(unit["node"], unit["id"])
    for node in sorted((node for node in model["nodes"] if node["level"] == "system"), key=lambda item: item["id"]):
        if node["id"] in by_node:
            continue
        if node.get("kind") in CLIENT_KINDS:
            state.zone("z:users", "Usuários", "users")
            by_node[node["id"]] = state.unit("z:users", node["name"], "client", node["id"], None)["id"]
        elif node.get("kind") == "embedded":
            state.zone("z:devices", "Dispositivos", "devices")
            by_node[node["id"]] = state.unit("z:devices", node["name"], "device", node["id"], None)["id"]
    for node in sorted((node for node in model["nodes"] if node["level"] == "external"), key=lambda item: item["id"]):
        if node["id"] not in by_node:
            state.zone("z:external", "Serviços externos", "external")
            by_node[node["id"]] = state.unit("z:external", node["name"], "external", node["id"], None)["id"]

    def unit_of(node_id):
        while node_id:
            if node_id in by_node:
                return by_node[node_id]
            node = nodes.get(node_id)
            node_id = node.get("parent") if node else None
        return None

    links, seen = [], set()
    for link in state.links:
        key = (link["from"], link["to"], link["label"])
        if key not in seen:
            seen.add(key)
            links.append(link)
    for link in model["links"]:
        if link.get("level") == "file" or link.get("protocol") in ("import", "include"):
            continue
        source, target = unit_of(link["from"]), unit_of(link["to"])
        if source and target and source != target:
            label = link.get("protocol") or ""
            if (source, target, label) not in seen and (source, target, "depende de") not in seen:
                seen.add((source, target, label))
                links.append({"from": source, "to": target, "label": label, "async": bool(link.get("async"))})
    zones = sorted(state.zones.values(), key=lambda zone: (zone["parent"] is not None, zone["id"]))
    units = sorted(state.units.values(), key=lambda unit: (unit["zone"], unit["id"]))
    return {"zones": zones, "units": units,
            "links": sorted(links, key=lambda link: (link["from"], link["to"], link["label"]))}
