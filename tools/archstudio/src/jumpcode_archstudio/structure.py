# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Systems, services and files of a source tree: the three nested levels of the map."""

from collections import Counter
import os
import re

from .common import short_name, slug
from .manifests import KIND_ORDER, Manifest, detect
from .walker import CODE_LANGS

MAX_FILES_PER_SERVICE = 5_000
MAX_UNITS = 80
LANG_NAMES = {
    "go": "Go", "ts": "TypeScript", "js": "JavaScript", "py": "Python", "dart": "Dart", "kt": "Kotlin", "java": "Java",
    "swift": "Swift", "c": "C", "cpp": "C++", "h": "C", "rs": "Rust", "cs": "C#", "php": "PHP", "rb": "Ruby",
    "ex": "Elixir", "vue": "Vue", "svelte": "Svelte", "scala": "Scala", "objc": "Objective-C", "lua": "Lua",
    "zig": "Zig", "fs": "F#", "erl": "Erlang",
}
CONTAINERS = ("services", "servicos", "microservices", "apps", "packages", "modules", "cmd", "functions",
              "workers", "lambdas", "libs")
SOURCE_ROOTS = ("src/main/java", "src/main/kotlin", "src", "lib", "app", "main", "Sources", "source")
CLIENT_KINDS = {"mobile", "web", "desktop"}
ROLE_WORDS = (
    ("screen", {"screens", "screen", "pages", "page", "views", "view", "ui", "widgets", "widget", "components", "component",
                "layouts", "layout", "telas", "tela", "paginas", "routes", "presentation", "templates"}),
    ("state", {"bloc", "blocs", "cubit", "cubits", "store", "stores", "redux", "provider", "providers", "viewmodel",
               "viewmodels", "state", "states", "hooks", "contexts", "context", "slices", "notifiers", "controllers", "estado"}),
    ("repository", {"repository", "repositories", "repositorios", "repositorio", "repo", "repos", "data", "services",
                    "servicos", "domain", "dominio", "models", "model", "entities", "usecases"}),
    ("source", {"api", "apis", "client", "clients", "http", "network", "networking", "remote", "db", "database", "storage",
                "local", "sync", "gps", "location", "localizacao", "camera", "sensors", "sensor", "bluetooth", "ble",
                "notifications", "push", "cache", "persistence", "datasources", "datasource", "sources", "fontes",
                "offline", "banco"}),
)
EMBEDDED_LANGS = {"c", "cpp", "h", "rs"}
BUSES = ("uart", "i2c", "spi", "adc", "can", "gpio", "pwm", "i2s", "usb", "dac", "rmt", "twai", "onewire", "sdio")
HARDWARE = (
    (("gps", "gnss"), "gps", "GPS"),
    (("modem", "gsm", "lte", "cellular", "nbiot", "sim800", "sim7600", "sim7000"), "modem", "Modem"),
    (("flash", "eeprom", "sdcard", "fram"), "flash", "Memória flash"),
    (("sensor", "sensors", "sensores", "imu", "accel", "acelerometro", "bme280", "temperatura", "mpu6050", "temp"), "sensores", "Sensores"),
    (("bateria", "battery", "bat", "vbat", "fuel"), "bateria", "Bateria"),
    (("display", "lcd", "oled", "tft", "epaper"), "display", "Display"),
    (("lora", "sx1276", "sx127x", "sx1262"), "lora", "Rádio LoRa"),
    (("ble", "bluetooth"), "bluetooth", "Bluetooth"),
    (("camera", "cam", "ov2640"), "camera", "Câmera"),
    (("motor", "servo", "stepper"), "motor", "Motor"),
    (("led", "leds", "neopixel", "ws2812"), "led", "LEDs"),
    (("rfid", "nfc", "mfrc522"), "rfid", "Leitor RFID"),
    (("buzzer", "beeper"), "buzzer", "Buzzer"),
)


def join(*parts):
    return "/".join(part for part in parts if part)


def node_path(path):
    return path or "."


def parent_folder(path):
    return path.rsplit("/", 1)[0] if "/" in path else ""


def base_name(path):
    return path.rsplit("/", 1)[-1] if path else ""


def _under(path, folder):
    return not folder or path == folder or path.startswith(folder + "/")


class Structure:
    """Systems, services and files with the facts the link analysis needs."""

    def __init__(self):
        self.systems = []        # system node dicts
        self.services = []       # service node dicts
        self.files = []          # file node dicts
        self.links = []          # raw links found while building (driver -> hardware)
        self.file_service = {}   # file path -> service id
        self.service_system = {}  # service id -> system id
        self.system_info = {}    # system id -> {"path", "kind", "manifest", "manifests", "lang"}
        self.service_info = {}   # service id -> {"path", "manifest"}
        self.manifests = {}      # folder -> Manifest
        self.notes = []

    def nodes(self):
        return self.systems + self.services + self.files


def _counts(tree):
    counts = Counter()
    for path in tree.files:
        folder = parent_folder(path)
        counts[folder] += 1
        while folder:
            folder = parent_folder(folder)
            counts[folder] += 1
    return counts


def _majority_lang(tree, paths):
    counter = Counter(tree.langs[path] for path in paths if tree.langs.get(path) in CODE_LANGS)
    if not counter:
        return None
    if counter.get("h") and (counter.get("cpp", 0) > counter.get("c", 0)):
        counter["cpp"] += counter.pop("h")
    elif counter.get("h"):
        counter["c"] += counter.pop("h")
    return counter.most_common(1)[0][0]


def _strongest(kinds):
    for kind in KIND_ORDER:
        if kind in kinds:
            return kind
    return "library"


def find_manifests(tree, budget, progress=None):
    manifests = {}
    for index, folder in enumerate(sorted(tree.dirs)):
        if index % 64 == 0:
            budget.check()
            if budget.expired():
                budget.note("time limit reached while looking for projects")
                break
        manifest = detect(tree, folder, budget)
        if manifest is not None:
            manifests[folder] = manifest
            if progress is not None:
                progress(folder, len(manifests))
    return manifests


def _topmost(paths):
    result = []
    for path in sorted(paths):
        if not any(_under(path, top) for top in result):
            result.append(path)
    return result


def find_systems(tree, manifests, source_name, budget):
    """Top-most manifest folders are systems; loose code folders become fallback systems."""
    tops = _topmost(manifests)
    systems = []
    for path in tops:
        manifest = manifests[path]
        nested = [manifests[item] for item in sorted(manifests) if item != path and _under(item, path)]
        kind, tech = manifest.kind, manifest.tech
        if manifest.weak and nested:
            kind = _strongest({item.kind for item in nested})
            tech = next(item.tech for item in nested if item.kind == kind)
        name = short_name(manifest.name or "") or short_name(base_name(path) or source_name) or "sistema"
        if kind == "embedded" and not manifest.name:
            name = short_name(base_name(path) or source_name)
        systems.append({"path": path, "manifest": manifest, "nested": nested, "kind": kind, "tech": tech, "name": name})
    if not tops:
        systems.append({"path": "", "manifest": None, "nested": [], "kind": None, "tech": None,
                        "name": short_name(source_name) or "projeto"})
    elif "" not in tops:
        for child in tree.dirs.get("", []):
            if any(_under(top, child) for top in tops):
                continue
            if any(tree.langs.get(path) in CODE_LANGS for path in tree.under(child)):
                systems.append({"path": child, "manifest": None, "nested": [], "kind": None, "tech": None,
                                "name": short_name(base_name(child))})
    for system in systems:
        if system["kind"] is None:
            files = tree.under(system["path"])
            lang = _majority_lang(tree, files)
            embedded = lang in ("c", "cpp") and any(
                re.search(r"freertos|esp_|HAL_|stm32|arduino", tree.read(path, budget) or "", re.I)
                for path in files[:40] if tree.langs.get(path) in ("c", "cpp", "h"))
            system["kind"] = "embedded" if embedded else "library"
            system["tech"] = LANG_NAMES.get(lang, lang.upper() if lang else "")
    systems.sort(key=lambda item: item["path"])
    return systems


def _collapse(tree, counts, folder):
    while folder in tree.dirs and not tree.names.get(folder):
        children = [child for child in tree.dirs[folder] if counts.get(child)]
        if len(children) != 1:
            break
        folder = children[0]
    return folder


def _expand(tree, counts, folder):
    children = [child for child in tree.dirs.get(folder, []) if counts.get(child)]
    if not tree.names.get(folder) and len(children) >= 2:
        return children
    return [folder]


def _plan_folders(system, tree, counts):
    """Service folders of one system, in the order of the rules; leftovers go to the root service."""
    path = system["path"]
    picked = {}

    def blocked(folder):
        return any(_under(folder, other) or _under(other, folder) for other in picked)

    for manifest in system["nested"]:
        if not blocked(manifest.path) and counts.get(manifest.path):
            picked[manifest.path] = manifest
    for container in CONTAINERS:
        folder = join(path, container)
        for child in tree.dirs.get(folder, []) if folder in tree.dirs else []:
            if counts.get(child) and not blocked(child):
                picked[child] = None
    roots = set()
    if not picked:
        internal = join(path, "internal")
        if system["tech"] == "Go" and internal in tree.dirs:
            for child in tree.dirs[internal]:
                if counts.get(child) and not blocked(child):
                    picked[child] = None
        if not picked:
            for root in SOURCE_ROOTS:
                folder = join(path, root)
                if folder not in tree.dirs or not counts.get(folder) or any(_under(folder, used) or _under(used, folder) for used in roots):
                    continue
                roots.add(folder)
                base = _collapse(tree, counts, folder)
                children = [child for child in tree.dirs.get(base, []) if counts.get(child)]
                if not children and not blocked(base):
                    # A source folder without subfolders is one service (a package, a 'lib').
                    picked[base] = None
                for child in children:
                    for item in _expand(tree, counts, child):
                        if not blocked(item):
                            picked[item] = None
                if children and base != folder and any(
                        tree.langs.get(join(base, name)) in CODE_LANGS for name in tree.names.get(base, ())):
                    # A package folder (src/<package>) keeps its own files; its subfolders stay services.
                    picked[base] = None
    for child in tree.dirs.get(path, []):
        if counts.get(child) and not blocked(child) and not any(_under(root, child) for root in roots):
            for item in _expand(tree, counts, child):
                if not blocked(item):
                    picked[item] = None
    return picked


def _role(system_kind, relative, stems):
    if system_kind not in CLIENT_KINDS:
        return "service"
    segments = [segment.lower() for segment in relative.split("/") if segment]
    for segment in reversed(segments):
        if system_kind == "web" and segment in ("app", "pages") and segments and segments[-1] != segment:
            return "screen"
        for role, words in ROLE_WORDS:
            if segment in words:
                return role
    if segments and segments[0] in ("app", "pages") and system_kind == "web" and len(segments) > 1:
        return "screen"
    votes = Counter()
    for stem in stems:
        tokens = set(re.split(r"[_\-.]|(?<=[a-z])(?=[A-Z])", stem))
        tokens = {token.lower() for token in tokens}
        for role, words in ROLE_WORDS:
            if tokens & words:
                votes[role] += 1
                break
    return votes.most_common(1)[0][0] if votes else "service"


def _embedded_role(relative, stem):
    segments = {segment.lower() for segment in relative.split("/")[:-1]}
    lowered = stem.lower()
    if (segments & {"drivers", "driver", "hal", "bsp", "periph", "peripherals", "board"}
            or lowered.endswith(("_driver", "_drv")) or lowered.startswith(("drv_",) + tuple(bus + "_" for bus in BUSES))):
        return "driver"
    if (segments & {"tasks", "tarefas", "threads", "rtos"} or lowered in ("main", "app_main", "app")
            or lowered.endswith(("_task", "task")) or lowered.startswith("task_")):
        return "task"
    return "module"


def _hardware(stem):
    tokens = [token for token in re.split(r"[_\-]", stem.lower()) if token]
    bus = next((token.upper() if token != "onewire" else "1-Wire" for token in tokens if token in BUSES), None)
    for words, key, name in HARDWARE:
        if any(token in words for token in tokens):
            return key, name, (bus or "GPIO").replace("TWAI", "CAN")
    return None


def _units(system, tree):
    """Embedded systems: each C/C++/Rust module (file stem) is a service."""
    groups = {}
    for path in tree.under(system["path"]):
        if tree.langs.get(path) in EMBEDDED_LANGS:
            groups.setdefault(os.path.splitext(path)[0], []).append(path)
    if not groups or len(groups) > MAX_UNITS:
        return None
    return groups


def build(tree, manifests, systems, budget):
    """Create system, service and file nodes with stable ids and sizes."""
    structure = Structure()
    structure.manifests = manifests
    counts = _counts(tree)
    system_paths = [system["path"] for system in systems]
    for system in systems:
        budget.check()
        path = system["path"]
        system_id = "s:" + node_path(path)
        node = {"id": system_id, "level": "system", "parent": None, "name": system["name"], "kind": system["kind"],
                "path": node_path(path)}
        if system["tech"]:
            node["tech"] = system["tech"]
        structure.systems.append(node)
        files = [item for item in tree.under(path)
                 if not any(other != path and _under(other, path) and _under(item, other) for other in system_paths)]
        lang = _majority_lang(tree, files)
        structure.system_info[system_id] = {"path": path, "kind": system["kind"], "manifest": system["manifest"],
                                            "manifests": [system["manifest"], *system["nested"]] if system["manifest"] else [],
                                            "lang": lang}
        services = {}
        units = _units(system, tree) if system["kind"] == "embedded" else None
        if units:
            for key in sorted(units):
                group = sorted(units[key], key=lambda item: (tree.langs.get(item) == "h", item))
                stem = base_name(key)
                role = _embedded_role(key[len(path):].lstrip("/"), stem)
                service_id = "v:" + key
                services[service_id] = {"id": service_id, "level": "service", "parent": system_id, "name": stem,
                                        "kind": "embedded", "path": group[0], "role": role, "_files": group, "_unit": True}
                for item in group:
                    structure.file_service[item] = service_id
                if role == "driver":
                    hardware = _hardware(stem)
                    if hardware:
                        key_name, name, bus = hardware
                        hardware_id = f"v:{node_path(path)}#hw-{key_name}"
                        services.setdefault(hardware_id, {"id": hardware_id, "level": "service", "parent": system_id,
                                                          "name": name, "kind": "embedded", "tech": bus, "role": "hardware",
                                                          "manual": False, "_files": []})
                        structure.links.append({"from": service_id, "to": hardware_id, "level": "service", "protocol": bus,
                                                "async": False, "count": 1, "evidence": [{"path": group[0], "line": 1}]})
            leftovers = [item for item in files if item not in structure.file_service]
            if leftovers:
                root_id = "v:" + node_path(path)
                services[root_id] = {"id": root_id, "level": "service", "parent": system_id, "name": "raiz", "kind": "embedded",
                                     "path": node_path(path), "role": "module", "_files": leftovers}
                for item in leftovers:
                    structure.file_service[item] = root_id
        else:
            picked = _plan_folders(system, tree, counts)
            root_id = "v:" + node_path(path)
            for item in files:
                folder = parent_folder(item)
                while folder not in picked and folder and folder != path:
                    folder = parent_folder(folder)
                structure.file_service[item] = "v:" + folder if folder in picked else root_id
            for folder in sorted(picked):
                manifest = picked[folder]
                name = short_name((manifest.name if isinstance(manifest, Manifest) and manifest.name else "") or base_name(folder))
                service_id = "v:" + folder
                services[service_id] = {"id": service_id, "level": "service", "parent": system_id,
                                        "name": name or base_name(folder),
                                        "kind": manifest.kind if isinstance(manifest, Manifest) and not manifest.weak else system["kind"],
                                        "path": folder, "_manifest": manifest}
            if any(value == root_id for value in structure.file_service.values()):
                services[root_id] = {"id": root_id, "level": "service", "parent": system_id,
                                     "name": "raiz" if picked else system["name"], "kind": system["kind"],
                                     "path": node_path(path), "_manifest": system["manifest"]}
        for item in files:
            service_id = structure.file_service.get(item)
            if service_id in services:
                services[service_id].setdefault("_files", [])
                if item not in services[service_id]["_files"]:
                    services[service_id]["_files"].append(item)
        for service_id in sorted(services):
            service = services[service_id]
            service_files = service.pop("_files", [])
            manifest = service.pop("_manifest", None)
            unit = service.pop("_unit", False)
            service_dir = "" if service.get("path", ".") == "." else service["path"]
            if "role" not in service:
                relative = service_dir[len(path):].lstrip("/") if path else service_dir
                stems = [os.path.splitext(base_name(item))[0] for item in service_files if tree.langs.get(item) in CODE_LANGS]
                if system["kind"] == "embedded":
                    service["role"] = _embedded_role(relative + "/x", base_name(relative)) if relative else "module"
                else:
                    service["role"] = _role(system["kind"], relative, stems)
            if "tech" not in service:
                if isinstance(manifest, Manifest) and service["path"] != node_path(path):
                    service["tech"] = manifest.tech
                else:
                    lang_name = LANG_NAMES.get(_majority_lang(tree, service_files) or "")
                    if lang_name:
                        service["tech"] = lang_name
            if len(service_files) > MAX_FILES_PER_SERVICE:
                service_files.sort(key=lambda item: (-tree.files[item], item))
                dropped = service_files[MAX_FILES_PER_SERVICE:]
                service_files = service_files[:MAX_FILES_PER_SERVICE]
                for item in dropped:
                    structure.file_service.pop(item, None)
                structure.notes.append(f"{service['name']}: kept the {MAX_FILES_PER_SERVICE} largest of {len(service_files) + len(dropped)} files")
            for item in sorted(service_files):
                text = tree.texts.get(item)
                lines = _lines(text, tree.files[item], item in tree.partial)
                folder = parent_folder(item)
                if unit or service.get("role") == "hardware":
                    relative_folder = ""
                else:
                    relative_folder = folder[len(service_dir):].lstrip("/") if service_dir else folder
                structure.files.append({"id": "f:" + item, "level": "file", "parent": service_id, "name": base_name(item),
                                        "kind": "file", "path": item, "lang": tree.langs[item], "folder": relative_folder,
                                        "lines": lines})
            structure.service_system[service_id] = system_id
            structure.service_info[service_id] = {"path": service.get("path"), "manifest": manifest, "unit": unit}
            structure.services.append(service)
    _sizes(structure)
    return structure


def _lines(text, size, partial):
    if text is None:
        return max(1, size // 40) if size else 0
    lines = text.count("\n") + (0 if text.endswith("\n") or not text else 1)
    if partial and text:
        lines = int(lines * size / max(1, len(text.encode("utf-8", errors="ignore"))))
    return lines


def _sizes(structure):
    services = {node["id"]: node for node in structure.services}
    systems = {node["id"]: node for node in structure.systems}
    for node in list(services.values()) + list(systems.values()):
        if node.get("role") != "hardware":
            node["files"] = 0
            node["lines"] = 0
    for file in structure.files:
        service = services.get(file["parent"])
        if service is None or "files" not in service:
            continue
        service["files"] += 1
        service["lines"] += file["lines"]
        system = systems.get(service["parent"])
        if system is not None:
            system["files"] += 1
            system["lines"] += file["lines"]


def choose(candidates, structure, caller=None):
    """Pick one node among homonyms: the caller's own backend system first, then backend services."""
    candidates = sorted(candidates or ())
    if len(candidates) <= 1:
        return candidates[0] if candidates else None

    def system_of(node_id):
        return node_id if node_id.startswith("s:") else structure.service_system.get(node_id)

    def kind_of(node_id):
        return structure.system_info.get(system_of(node_id), {}).get("kind")

    services = [item for item in candidates if item.startswith("v:")]
    systems = [item for item in candidates if item.startswith("s:")]
    if len(systems) == 1 and all(system_of(item) == systems[0] for item in services):
        return systems[0]
    if caller is not None and kind_of(caller) == "backend":
        same = [item for item in services if system_of(item) == system_of(caller)]
        if len(same) == 1:
            return same[0]
    backends = [item for item in services if kind_of(item) == "backend"]
    if len(backends) == 1:
        return backends[0]
    return services[0] if len(services) == 1 else None


def service_slugs(structure):
    """Readable names of services and systems for matching hosts, env vars and deploy units."""
    aliases = {}

    def add(alias, node_id):
        alias = slug(alias)
        if alias and len(alias) >= 2:
            aliases.setdefault(alias, set()).add(node_id)

    for node in structure.systems + structure.services:
        if node.get("role") == "hardware":
            continue
        names = {node["name"], base_name(node.get("path") or "")}
        for name in list(names):
            if not name or name in (".", "raiz"):
                continue
            add(name, node["id"])
            base = slug(name)
            for affix in ("-service", "-svc", "-server", "-api", "-app", "-ms", "-worker", "-servico"):
                if base.endswith(affix) and len(base) > len(affix) + 1:
                    add(base[:-len(affix)], node["id"])
            for affix in ("service-", "svc-", "ms-", "app-", "api-"):
                if base.startswith(affix) and len(base) > len(affix) + 1:
                    add(base[len(affix):], node["id"])
            add(base.replace("-", ""), node["id"])
    return aliases
