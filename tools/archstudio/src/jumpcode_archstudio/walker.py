# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Bounded, read-only listing of a source tree that never follows links."""

import fnmatch
import os
import re
import stat
import time

from .common import is_link_stat

MAX_FILES = 20_000
MAX_FILE_BYTES = 256 * 1024
MAX_TOTAL_BYTES = 64 * 1024 * 1024
TIME_BUDGET = 90.0

SKIP_DIRS = {
    "node_modules", "vendor", "build", "dist", "out", "target", "bin", "obj", "venv",
    "__pycache__", "Pods", "coverage", "DerivedData", "site-packages", "bower_components",
    "jspm_packages", "elm-stuff", "_build", "deps", "cmake-build-debug", "cmake-build-release",
    "managed_components", "generated", "__generated__",
}
# Tests, docs and samples are left out of the architecture on purpose.
TEST_DIRS = {
    "test", "tests", "__tests__", "spec", "specs", "e2e", "testdata", "test-data", "fixtures",
    "__mocks__", "mocks", "docs", "doc", "examples", "example", "samples", "sample",
    "benchmarks", "benchmark", "integration_test", "androidTest", "testing",
}
SKIP_DIR_SUFFIXES = (".xcodeproj", ".xcworkspace", ".xcassets", ".egg-info", ".app", ".framework", ".bundle", ".lproj")

LANGS = {
    ".go": "go", ".ts": "ts", ".tsx": "ts", ".mts": "ts", ".cts": "ts", ".js": "js", ".jsx": "js",
    ".mjs": "js", ".cjs": "js", ".vue": "vue", ".svelte": "svelte", ".py": "py", ".dart": "dart",
    ".kt": "kt", ".kts": "kt", ".java": "java", ".scala": "scala", ".swift": "swift",
    ".m": "objc", ".mm": "objc", ".c": "c", ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp",
    ".ino": "cpp", ".h": "h", ".hh": "h", ".hpp": "h", ".hxx": "h", ".rs": "rs", ".cs": "cs",
    ".fs": "fs", ".php": "php", ".rb": "rb", ".ex": "ex", ".exs": "ex", ".erl": "erl",
    ".lua": "lua", ".zig": "zig", ".sql": "sql", ".proto": "proto", ".graphql": "graphql",
    ".gql": "graphql", ".yaml": "yaml", ".yml": "yaml", ".json": "json", ".toml": "toml",
    ".tf": "tf", ".gradle": "gradle", ".csproj": "xml", ".fsproj": "xml", ".properties": "properties",
    ".sh": "sh", ".ps1": "ps1", ".html": "html", ".css": "css", ".scss": "scss",
}
SPECIAL_FILES = {
    "Dockerfile": "docker", "Containerfile": "docker", "Makefile": "make", "makefile": "make",
    "CMakeLists.txt": "cmake", "Procfile": "procfile", "Gemfile": "rb", "go.mod": "gomod",
    "sdkconfig": "config", "sdkconfig.defaults": "config", "platformio.ini": "ini",
    "requirements.txt": "txt", "pom.xml": "xml", "AndroidManifest.xml": "xml", "Kconfig": "config",
    "Kconfig.projbuild": "config", "setup.cfg": "ini", "Podfile": "rb", "Jenkinsfile": "groovy",
}
CODE_LANGS = {
    "go", "ts", "js", "vue", "svelte", "py", "dart", "kt", "java", "scala", "swift", "objc", "c",
    "cpp", "h", "rs", "cs", "fs", "php", "rb", "ex", "erl", "lua", "zig",
}
LOCK_FILES = {
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "go.sum", "Cargo.lock", "pubspec.lock",
    "composer.lock", "Podfile.lock", "poetry.lock", "Gemfile.lock", "mix.lock", "packages.lock.json",
    "uv.lock", "npm-shrinkwrap.json", "bun.lockb", "tsconfig.tsbuildinfo",
}
_GENERATED = re.compile(
    r"(?:\.min\.(?:js|css)|\.pb\.go|\.pb\.gw\.go|_pb2(?:_grpc)?\.py|\.g\.dart|\.freezed\.dart|\.gr\.dart"
    r"|\.d\.ts|\.map|_test\.go|_test\.py|_test\.dart|\.(?:test|spec)\.[cm]?[jt]sx?|(?:Test|Tests|Spec)\.(?:java|kt|cs|swift))$"
    r"|^test_.*\.py$|^conftest\.py$")


class Cancelled(Exception):
    """The user stopped the scan."""


class Budget:
    """Limits of one scan: files listed, bytes read, wall time and cancellation."""

    def __init__(self, *, max_files=MAX_FILES, max_file_bytes=MAX_FILE_BYTES, max_total_bytes=MAX_TOTAL_BYTES,
                 seconds=TIME_BUDGET, cancelled=None, clock=time.monotonic):
        self.max_files = max_files
        self.max_file_bytes = max_file_bytes
        self.max_total_bytes = max_total_bytes
        self.clock = clock
        self.started = clock()
        self.deadline = self.started + seconds
        self.cancelled = cancelled
        self.read_bytes = 0
        self.notes = []
        self._calls = 0

    def check(self):
        self._calls += 1
        if self.cancelled is not None and self.cancelled():
            raise Cancelled()

    def expired(self):
        return self.clock() >= self.deadline

    def note(self, text):
        if text not in self.notes:
            self.notes.append(text)

    def elapsed(self):
        return self.clock() - self.started


def file_lang(name):
    if name in LOCK_FILES or _GENERATED.search(name):
        return None
    if name in SPECIAL_FILES:
        return SPECIAL_FILES[name]
    if name.startswith("Dockerfile") or name.endswith(".Dockerfile") or name.startswith("docker-compose"):
        return "docker" if "Dockerfile" in name else "yaml"
    if name.startswith("requirements") and name.endswith(".txt"):
        return "txt"
    if name.startswith("sdkconfig"):
        return "config"
    extension = os.path.splitext(name)[1].lower()
    if extension == ".xml" and name not in SPECIAL_FILES:
        return None
    return LANGS.get(extension)


class Tree:
    """Folders and relevant files of the source tree, as POSIX paths relative to its root."""

    def __init__(self, root):
        self.root = root
        self.dirs = {}      # folder -> child folders
        self.names = {}     # folder -> relevant file names
        self.markers = {}   # folder -> skipped project folders such as App.xcodeproj
        self.files = {}     # file -> size in bytes
        self.langs = {}     # file -> language
        self.texts = {}     # file -> text, once read
        self.partial = set()
        self.truncated = False

    def read(self, path, budget):
        """Read up to the per-file limit; binary or unreadable files are None."""
        if path in self.texts:
            return self.texts[path]
        text = None
        remaining = budget.max_total_bytes - budget.read_bytes
        if remaining <= 0:
            budget.note("read limit reached; some files were not read")
        else:
            limit = min(budget.max_file_bytes, remaining)
            try:
                full = os.path.join(self.root, *path.split("/"))
                info = os.lstat(full)
                if is_link_stat(info) or not stat.S_ISREG(info.st_mode):
                    raise OSError("not a regular file")
                with open(full, "rb") as stream:
                    data = stream.read(limit)
                budget.read_bytes += len(data)
                if b"\0" not in data[:8192]:
                    text = data.decode("utf-8", errors="replace")
                    if info.st_size > len(data):
                        self.partial.add(path)
            except OSError:
                text = None
        self.texts[path] = text
        return text

    def under(self, folder):
        """Relevant files at or below a folder ('' is the root)."""
        if not folder:
            return list(self.files)
        prefix = folder + "/"
        return [path for path in self.files if path.startswith(prefix)]


def _gitignore(root):
    patterns = []
    try:
        with open(os.path.join(root, ".gitignore"), "r", encoding="utf-8", errors="replace") as stream:
            lines = stream.read(64 * 1024).splitlines()
    except OSError:
        return patterns
    for line in lines:
        line = line.strip()
        if not line or line.startswith(("#", "!")):
            continue
        anchored = line.startswith("/")
        line = line.strip("/")
        if not line or "**" in line:
            continue
        if "/" in line:
            patterns.append(("path", line))
        else:
            patterns.append(("root" if anchored else "name", line))
    return patterns


def _ignored(patterns, relative, name):
    for kind, pattern in patterns:
        if kind == "name" and fnmatch.fnmatchcase(name, pattern):
            return True
        if kind == "root" and "/" not in relative and fnmatch.fnmatchcase(name, pattern):
            return True
        if kind == "path" and fnmatch.fnmatchcase(relative, pattern):
            return True
    return False


def walk(root, budget, progress=None):
    """List folders and relevant files depth first, in name order, within the budget."""
    tree = Tree(str(root))
    patterns = _gitignore(root)
    stack = [""]
    folders = 0
    while stack:
        budget.check()
        if budget.expired():
            budget.note("time limit reached while listing folders")
            tree.truncated = True
            break
        relative = stack.pop()
        folders += 1
        try:
            with os.scandir(os.path.join(tree.root, *relative.split("/")) if relative else tree.root) as iterator:
                entries = sorted(iterator, key=lambda entry: entry.name)
        except OSError:
            continue
        children, names, markers = [], [], []
        for entry in entries:
            name = entry.name
            try:
                info = entry.stat(follow_symlinks=False)
            except OSError:
                continue
            if is_link_stat(info):
                continue
            child = f"{relative}/{name}" if relative else name
            if stat.S_ISDIR(info.st_mode):
                if name.endswith(SKIP_DIR_SUFFIXES):
                    markers.append(name)
                    continue
                if (name.startswith(".") or name in SKIP_DIRS or name in TEST_DIRS
                        or _ignored(patterns, child, name)):
                    continue
                children.append(child)
            elif stat.S_ISREG(info.st_mode):
                if name.startswith(".") or _ignored(patterns, child, name):
                    continue
                lang = file_lang(name)
                if lang is None:
                    continue
                if len(tree.files) >= budget.max_files:
                    if not tree.truncated:
                        budget.note(f"file limit reached; only the first {budget.max_files} files were listed")
                    tree.truncated = True
                    continue
                tree.files[child] = info.st_size
                tree.langs[child] = lang
                names.append(name)
        tree.dirs[relative] = children
        tree.names[relative] = names
        if markers:
            tree.markers[relative] = markers
        stack.extend(reversed(children))
        if progress is not None:
            progress(relative, folders)
    return tree
