# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Project manifests: which folders are projects, of which kind, technology and name."""

import json
import os
import re

try:
    import tomllib
except ImportError:  # pragma: no cover - Python 3.10 is not supported by the runtime
    tomllib = None

from . import yamlish
from .common import short_name

MANIFEST_NAMES = {
    "package.json", "pubspec.yaml", "go.mod", "Cargo.toml", "pyproject.toml", "requirements.txt", "setup.py",
    "pom.xml", "build.gradle", "build.gradle.kts", "Package.swift", "platformio.ini", "CMakeLists.txt",
    "composer.json", "Gemfile", "mix.exs", "Makefile",
}
KIND_ORDER = ("mobile", "web", "desktop", "embedded", "backend", "library")


class Manifest:
    """One project folder found by its manifest file."""

    __slots__ = ("path", "file", "kind", "tech", "name", "deps", "module", "weak", "lang")

    def __init__(self, path, file, kind, tech, name=None, deps=(), module=None, weak=False, lang=None):
        self.path = path
        self.file = file
        self.kind = kind
        self.tech = tech
        self.name = name
        self.deps = frozenset(deps)
        self.module = module
        self.weak = weak
        self.lang = lang


def _json(text):
    try:
        return json.loads(text)
    except ValueError:
        pass
    cleaned = re.sub(r"(?m)^\s*//.*$|/\*.*?\*/", "", text, flags=re.S)
    cleaned = re.sub(r",(\s*[}\]])", r"\1", cleaned)
    try:
        return json.loads(cleaned)
    except ValueError:
        return None


def _toml(text):
    if tomllib is None:
        return {}
    try:
        return tomllib.loads(text)
    except (tomllib.TOMLDecodeError, ValueError, TypeError):
        return {}


def _requirement(text):
    match = re.match(r"\s*([A-Za-z0-9][A-Za-z0-9_.\-]*)", text or "")
    return match.group(1).lower().replace("_", "-") if match else None


def _first(deps, table):
    for key, value in table:
        if key in deps:
            return value
    return None


def _package_json(folder, text, names):
    data = _json(text)
    data = data if isinstance(data, dict) else {}
    deps = set()
    for key in ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies"):
        if isinstance(data.get(key), dict):
            deps.update(str(name).lower() for name in data[key])
    name = data.get("name") if isinstance(data.get("name"), str) else None
    lang = "TypeScript" if "typescript" in deps or "tsconfig.json" in names else "JavaScript"
    if "react-native" in deps or "expo" in deps:
        return Manifest(folder, "package.json", "mobile", "React Native · Expo" if "expo" in deps else "React Native", name, deps, name, lang="ts")
    if "electron" in deps:
        return Manifest(folder, "package.json", "desktop", "Electron", name, deps, name, lang="ts")
    web = _first(deps, (("next", "Next.js"), ("nuxt", "Nuxt"), ("@angular/core", "Angular"), ("@sveltejs/kit", "SvelteKit"),
                        ("svelte", "Svelte"), ("@remix-run/react", "Remix"), ("vue", "Vue"), ("react", "React"),
                        ("react-dom", "React"), ("solid-js", "Solid"), ("astro", "Astro"), ("vite", "Vite")))
    if web:
        return Manifest(folder, "package.json", "web", web, name, deps, name, lang="ts")
    backend = _first(deps, (("@nestjs/core", "NestJS"), ("express", "Express"), ("fastify", "Fastify"), ("koa", "Koa"),
                            ("hono", "Hono"), ("@hapi/hapi", "hapi"), ("restify", "Restify"), ("@adonisjs/core", "AdonisJS")))
    if backend:
        return Manifest(folder, "package.json", "backend", backend, name, deps, name, lang="ts")
    if deps & {"amqplib", "kafkajs", "mqtt", "nats", "socket.io", "ws", "bullmq", "pg", "mongoose", "ioredis"}:
        return Manifest(folder, "package.json", "backend", "Node.js", name, deps, name, lang="ts")
    weak = bool(data.get("workspaces")) or (not deps and not data.get("main"))
    return Manifest(folder, "package.json", "library", lang, name, deps, name, weak=weak, lang="ts")


def _pubspec(folder, text):
    data = yamlish.load(text)
    data = data if isinstance(data, dict) else {}
    deps = set()
    for key in ("dependencies", "dev_dependencies"):
        if isinstance(data.get(key), dict):
            deps.update(str(name).lower() for name in data[key])
    name = data.get("name") if isinstance(data.get("name"), str) else None
    if "flutter" in deps or "flutter" in data:
        return Manifest(folder, "pubspec.yaml", "mobile", "Flutter", name, deps, name, lang="dart")
    if deps & {"shelf", "dart_frog", "serverpod", "conduit"}:
        return Manifest(folder, "pubspec.yaml", "backend", "Dart", name, deps, name, lang="dart")
    return Manifest(folder, "pubspec.yaml", "library", "Dart", name, deps, name, lang="dart")


def _go_mod(folder, text):
    module = re.search(r"(?m)^\s*module\s+(\S+)", text)
    module = module.group(1).strip('"') if module else None
    deps = set(match.lower() for match in re.findall(r"(?m)^\s*(?:require\s+)?([a-z0-9.\-]+\.[a-z]{2,}/[\w.\-/~]+)\s+v[\w.\-+]+", text))
    return Manifest(folder, "go.mod", "backend", "Go", short_name(module or "") or None, deps, module, lang="go")


_EMBEDDED_CRATES = ("embedded-hal", "cortex-m", "esp-hal", "esp-idf-hal", "esp-idf-svc", "esp-idf-sys", "embassy",
                    "rp2040-hal", "rp-pico", "stm32", "nrf52", "nrf-hal", "avr-device", "riscv-rt", "defmt")


def _cargo(folder, text, read):
    data = _toml(text)
    deps = set()
    for key in ("dependencies", "dev-dependencies", "build-dependencies"):
        if isinstance(data.get(key), dict):
            deps.update(str(name).lower() for name in data[key])
    for target in (data.get("target") or {}).values() if isinstance(data.get("target"), dict) else ():
        if isinstance(target, dict) and isinstance(target.get("dependencies"), dict):
            deps.update(str(name).lower() for name in target["dependencies"])
    package = data.get("package") if isinstance(data.get("package"), dict) else {}
    name = package.get("name") if isinstance(package.get("name"), str) else None
    main = read("src/main.rs") or ""
    if any(dep.startswith(_EMBEDDED_CRATES) or dep.startswith("esp-") for dep in deps) or "#![no_std]" in main:
        chip = "ESP32" if any(dep.startswith("esp") for dep in deps) else "STM32" if any(dep.startswith("stm32") for dep in deps) else None
        return Manifest(folder, "Cargo.toml", "embedded", "Rust · " + chip if chip else "Rust", name, deps, name, lang="rs")
    if deps & {"tauri", "egui", "eframe", "iced", "gtk", "slint"}:
        return Manifest(folder, "Cargo.toml", "desktop", "Rust", name, deps, name, lang="rs")
    if deps & {"axum", "actix-web", "rocket", "warp", "tonic", "poem", "hyper", "tide", "salvo", "lapin", "rumqttc"} or main:
        return Manifest(folder, "Cargo.toml", "backend", "Rust", name, deps, name, lang="rs")
    return Manifest(folder, "Cargo.toml", "library", "Rust", name, deps, name, weak="workspace" in data and not package, lang="rs")


_PY_WEB = (("django", "Django"), ("fastapi", "FastAPI"), ("flask", "Flask"), ("starlette", "Starlette"), ("aiohttp", "aiohttp"),
           ("tornado", "Tornado"), ("sanic", "Sanic"), ("litestar", "Litestar"), ("falcon", "Falcon"), ("pyramid", "Pyramid"))
_PY_WORKER = {"celery", "apscheduler", "apache-airflow", "prefect", "dagster", "pika", "aio-pika", "kafka-python", "confluent-kafka",
              "aiokafka", "paho-mqtt", "schedule", "rq", "dramatiq", "nats-py", "grpcio", "psycopg", "psycopg2", "psycopg2-binary",
              "asyncpg", "pymongo", "boto3", "sqlalchemy"}


def _python(folder, names, read):
    deps, name = set(), None
    if "pyproject.toml" in names:
        data = _toml(read("pyproject.toml") or "")
        project = data.get("project") if isinstance(data.get("project"), dict) else {}
        poetry = ((data.get("tool") or {}).get("poetry") or {}) if isinstance(data.get("tool"), dict) else {}
        name = project.get("name") or (poetry.get("name") if isinstance(poetry, dict) else None)
        for item in project.get("dependencies") or []:
            deps.add(_requirement(item) if isinstance(item, str) else None)
        for group in (project.get("optional-dependencies") or {}).values() if isinstance(project.get("optional-dependencies"), dict) else ():
            for item in group if isinstance(group, list) else ():
                deps.add(_requirement(item) if isinstance(item, str) else None)
        if isinstance(poetry, dict) and isinstance(poetry.get("dependencies"), dict):
            deps.update(str(key).lower() for key in poetry["dependencies"])
    for file in sorted(names):
        if file.startswith("requirements") and file.endswith(".txt"):
            for line in (read(file) or "").splitlines():
                if not line.strip().startswith(("#", "-")):
                    deps.add(_requirement(line))
    if "setup.py" in names:
        text = read("setup.py") or ""
        found = re.search(r"""\bname\s*=\s*["']([^"']+)["']""", text)
        name = name or (found.group(1) if found else None)
        requires = re.search(r"install_requires\s*=\s*\[(.*?)\]", text, re.S)
        if requires:
            deps.update(_requirement(item) for item in re.findall(r"""["']([^"']+)["']""", requires.group(1)))
    deps.discard(None)
    file = next((item for item in ("pyproject.toml", "setup.py", "requirements.txt") if item in names), "requirements.txt")
    name = name if isinstance(name, str) else None
    web = _first(deps, _PY_WEB)
    if web:
        return Manifest(folder, file, "backend", web, name, deps, name, lang="py")
    if deps & {"pyqt5", "pyqt6", "pyside2", "pyside6", "kivy", "toga", "flet", "wxpython", "customtkinter"}:
        return Manifest(folder, file, "desktop", "Python", name, deps, name, lang="py")
    if deps & _PY_WORKER:
        return Manifest(folder, file, "backend", "Python", name, deps, name, lang="py")
    return Manifest(folder, file, "library", "Python", name, deps, name, lang="py")


def _pom(folder, text):
    own = re.sub(r"<parent>.*?</parent>|<dependencies>.*?</dependencies>|<build>.*?</build>", "", text, flags=re.S)
    artifact = re.search(r"<artifactId>\s*([^<\s]+)\s*</artifactId>", own)
    deps = {item.lower() for item in re.findall(r"<artifactId>\s*([^<\s]+)\s*</artifactId>", text)}
    deps |= {item.lower() for item in re.findall(r"<groupId>\s*([^<\s]+)\s*</groupId>", text)}
    tech = "Spring Boot" if any("spring-boot" in dep for dep in deps) else "Quarkus" if any("quarkus" in dep for dep in deps) else "Java"
    weak = "<modules>" in text and "<packaging>pom</packaging>" in text
    return Manifest(folder, "pom.xml", "backend", tech, artifact.group(1) if artifact else None, deps, weak=weak, lang="java")


def _gradle(folder, file, text, read):
    settings = read("settings.gradle.kts") or read("settings.gradle") or ""
    found = re.search(r"""rootProject\.name\s*=\s*["']([^"']+)["']""", settings)
    name = found.group(1) if found else None
    deps = set()
    for group, artifact in re.findall(r"""(?:implementation|api|compileOnly|runtimeOnly|kapt|ksp)\s*\(?\s*["']([^:"']+):([^:"']+)""", text):
        deps.update((f"{group}:{artifact}".lower(), artifact.lower(), group.lower()))
    kotlin = "kotlin" in text.lower()
    lang = "kt" if kotlin else "java"
    if re.search(r"com\.android\.application|android\.application|com\.android\.library|android\.library", text):
        return Manifest(folder, file, "mobile", "Android · Kotlin" if kotlin else "Android", name, deps, lang=lang)
    if "org.springframework.boot" in text:
        return Manifest(folder, file, "backend", "Spring Boot", name, deps, lang=lang)
    if "io.ktor" in text:
        return Manifest(folder, file, "backend", "Ktor", name, deps, lang=lang)
    if "org.jetbrains.compose" in text:
        return Manifest(folder, file, "desktop", "Compose", name, deps, lang=lang)
    weak = not re.search(r"(?m)^\s*(?:plugins\s*\{[^}]*\b(?:id|kotlin|java|application)\b|apply\s+plugin)", text)
    return Manifest(folder, file, "backend", "Kotlin" if kotlin else "Java", name, deps, weak=weak, lang=lang)


def _csproj(folder, file, text):
    deps = {item.lower() for item in re.findall(r"""<PackageReference\s+Include\s*=\s*["']([^"']+)""", text)}
    name = file[:-len(".csproj")] if file.endswith(".csproj") else file.rsplit(".", 1)[0]
    if re.search(r"<UseMaui>\s*true", text, re.I) or any(dep.startswith("microsoft.maui") for dep in deps):
        return Manifest(folder, file, "mobile", ".NET MAUI", name, deps, lang="cs")
    if any(dep.startswith("xamarin") for dep in deps):
        return Manifest(folder, file, "mobile", "Xamarin", name, deps, lang="cs")
    if "BlazorWebAssembly" in text or any("components.webassembly" in dep for dep in deps):
        return Manifest(folder, file, "web", "Blazor", name, deps, lang="cs")
    if re.search(r"<Use(?:WPF|WindowsForms)>\s*true", text, re.I):
        return Manifest(folder, file, "desktop", ".NET", name, deps, lang="cs")
    tech = "ASP.NET" if "Microsoft.NET.Sdk.Web" in text else ".NET"
    return Manifest(folder, file, "backend", tech, name, deps, lang="cs")


def _chip(text):
    lowered = (text or "").lower()
    for needle, chip in (("esp32s3", "ESP32-S3"), ("esp32-s3", "ESP32-S3"), ("esp32c3", "ESP32-C3"), ("esp32-c3", "ESP32-C3"),
                         ("esp32c6", "ESP32-C6"), ("esp32s2", "ESP32-S2"), ("esp32", "ESP32"), ("esp8266", "ESP8266"),
                         ("stm32", "STM32"), ("nrf52", "nRF52"), ("nrf53", "nRF53"), ("rp2040", "RP2040"),
                         ("raspberrypi", "RP2040"), ("atmelavr", "AVR"), ("atmega", "AVR"), ("samd", "SAMD")):
        if needle in lowered:
            return chip
    return None


def detect(tree, folder, budget):
    """Return the Manifest of a folder, or None when the folder is not a project."""
    names = set(tree.names.get(folder, ()))
    markers = tree.markers.get(folder, ())
    csproj = sorted(name for name in names if name.endswith((".csproj", ".fsproj")))
    sketches = sorted(name for name in names if name.endswith(".ino"))
    if not (names & MANIFEST_NAMES or csproj or sketches or markers or any(name.startswith("sdkconfig") for name in names)):
        return None

    def read(name):
        path = f"{folder}/{name}" if folder else name
        return tree.read(path, budget) if path in tree.files else None

    if "pubspec.yaml" in names:
        return _pubspec(folder, read("pubspec.yaml") or "")
    xcode = [name for name in markers if name.endswith(".xcodeproj")]
    if "Package.swift" in names or xcode:
        text = read("Package.swift") or ""
        found = re.search(r"""name\s*:\s*"([^"]+)\"""", text)
        name = found.group(1) if found else (xcode[0].rsplit(".", 1)[0] if xcode else None)
        return Manifest(folder, "Package.swift" if "Package.swift" in names else xcode[0], "mobile", "Swift · iOS", name, lang="swift")
    if "platformio.ini" in names:
        text = read("platformio.ini") or ""
        chip = _chip(" ".join(re.findall(r"(?m)^\s*(?:board|platform)\s*=\s*(\S+)", text)))
        arduino = re.search(r"(?m)^\s*framework\s*=.*arduino", text)
        lang = "C++" if arduino or sketches else "C"
        return Manifest(folder, "platformio.ini", "embedded", f"{lang} · {chip}" if chip else lang, None, lang="c")
    cmake = read("CMakeLists.txt") if "CMakeLists.txt" in names else None
    sdkconfig = "".join(read(name) or "" for name in sorted(names) if name.startswith("sdkconfig"))
    if cmake is not None and re.search(r"project\s*\(", cmake, re.I):
        found = re.search(r"project\s*\(\s*([\w\-]+)", cmake, re.I)
        name = found.group(1) if found else None
        if "project.cmake" in cmake or "IDF_PATH" in cmake:
            target = re.search(r"""CONFIG_IDF_TARGET\s*=\s*"?(\w+)""", sdkconfig)
            chip = _chip(target.group(1)) if target else _chip(sdkconfig) or "ESP32"
            return Manifest(folder, "CMakeLists.txt", "embedded", f"C · {chip}", name, lang="c")
        if re.search(r"find_package\s*\(\s*Zephyr", cmake):
            return Manifest(folder, "CMakeLists.txt", "embedded", "C · Zephyr", name, lang="c")
        if re.search(r"arm-none-eabi|CMAKE_SYSTEM_NAME\s+Generic|STM32|cortex-m", cmake, re.I):
            chip = _chip(cmake)
            return Manifest(folder, "CMakeLists.txt", "embedded", f"C · {chip}" if chip else "C · ARM", name, lang="c")
    if "Cargo.toml" in names:
        return _cargo(folder, read("Cargo.toml") or "", read)
    if "go.mod" in names:
        return _go_mod(folder, read("go.mod") or "")
    if csproj:
        return _csproj(folder, csproj[0], read(csproj[0]) or "")
    if "pom.xml" in names:
        return _pom(folder, read("pom.xml") or "")
    for file in ("build.gradle.kts", "build.gradle"):
        if file in names:
            return _gradle(folder, file, read(file) or "", read)
    if "package.json" in names:
        return _package_json(folder, read("package.json") or "", names)
    if names & {"pyproject.toml", "setup.py"} or any(name.startswith("requirements") and name.endswith(".txt") for name in names):
        return _python(folder, names, read)
    if "composer.json" in names:
        data = _json(read("composer.json") or "")
        data = data if isinstance(data, dict) else {}
        deps = {str(key).lower() for key in data.get("require", {})} if isinstance(data.get("require"), dict) else set()
        tech = "Laravel" if "laravel/framework" in deps else "Symfony" if any(dep.startswith("symfony/") for dep in deps) else "PHP"
        name = data.get("name") if isinstance(data.get("name"), str) else None
        return Manifest(folder, "composer.json", "backend", tech, short_name(name) if name else None, deps, lang="php")
    if "Gemfile" in names:
        text = read("Gemfile") or ""
        deps = {item.lower() for item in re.findall(r"""(?m)^\s*gem\s+["']([^"']+)""", text)}
        tech = _first(deps, (("rails", "Rails"), ("sinatra", "Sinatra"), ("hanami", "Hanami"), ("grape", "Grape")))
        return Manifest(folder, "Gemfile", "backend" if tech else "library", tech or "Ruby", None, deps, lang="rb")
    if "mix.exs" in names:
        text = read("mix.exs") or ""
        found = re.search(r"app:\s*:(\w+)", text)
        kind, tech = ("embedded", "Elixir · Nerves") if ":nerves" in text else ("backend", "Phoenix") if ":phoenix" in text else ("library", "Elixir")
        return Manifest(folder, "mix.exs", kind, tech, found.group(1) if found else None, lang="ex")
    if sketches:
        return Manifest(folder, sketches[0], "embedded", "Arduino", os.path.splitext(sketches[0])[0], lang="cpp")
    if "Makefile" in names:
        text = read("Makefile") or ""
        if "arm-none-eabi" in text:
            chip = _chip(text)
            return Manifest(folder, "Makefile", "embedded", f"C · {chip}" if chip else "C · ARM", None, lang="c")
    if cmake is not None and re.search(r"(?m)^\s*project\s*\(", cmake, re.I):
        found = re.search(r"project\s*\(\s*([\w\-]+)", cmake, re.I)
        return Manifest(folder, "CMakeLists.txt", "library", "C++" if re.search(r"CXX|\.cpp", cmake) else "C",
                        found.group(1) if found else None, lang="cpp")
    return None
