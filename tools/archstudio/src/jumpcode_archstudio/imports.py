# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""File-level imports: read import statements and resolve them to files of the tree."""

import bisect
import os
import posixpath
import re

from .structure import base_name, join, parent_folder

JS_EXTENSIONS = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".mts", ".cts")
MAX_TARGETS = 8


class LineIndex:
    """Line numbers of positions in a text, computed once."""

    def __init__(self, text):
        self.text = text
        self._ends = None

    def line(self, position):
        if self._ends is None:
            self._ends = [match.start() for match in re.finditer("\n", self.text)]
        return bisect.bisect_left(self._ends, position) + 1


class Import:
    __slots__ = ("spec", "line", "style", "names")

    def __init__(self, spec, line, style, names=()):
        self.spec = spec
        self.line = line
        self.style = style
        self.names = names


_JS = (
    re.compile(r"""\bfrom\s*["']([^"'\n]{1,300})["']"""),
    re.compile(r"""(?m)^\s*import\s*["']([^"'\n]{1,300})["']"""),
    re.compile(r"""\brequire\s*\(\s*["']([^"'\n]{1,300})["']\s*\)"""),
    re.compile(r"""\bimport\s*\(\s*["']([^"'\n]{1,300})["']\s*\)"""),
)
_PY_FROM = re.compile(r"(?m)^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(\([^)]{0,2000}\)|[^\n#;]{1,2000})")
_PY_IMPORT = re.compile(r"(?m)^[ \t]*import[ \t]+([\w.]+(?:[ \t]*,[ \t]*[\w.]+)*)")
_GO_SINGLE = re.compile(r"""(?m)^\s*import\s+(?:[\w.]+\s+)?"([^"\n]+)\"""")
_GO_BLOCK = re.compile(r"(?ms)^\s*import\s*\((.*?)\)")
_GO_ITEM = re.compile(r"""(?m)^\s*(?:[\w.]+\s+)?"([^"\n]+)\"""")
_DART = re.compile(r"""(?m)^\s*(?:import|export|part)\s+['"]([^'"\n]+)['"]""")
_C_LOCAL = re.compile(r"""(?m)^[ \t]*#[ \t]*include[ \t]*"([^"\n]+)\"""")
_C_SYSTEM = re.compile(r"(?m)^[ \t]*#[ \t]*include[ \t]*<([^>\n]+)>")
_JAVA = re.compile(r"(?m)^\s*import\s+(?:static\s+)?([\w.]+(?:\.\*)?)\s*;?")
_CS = re.compile(r"(?m)^\s*(?:global\s+)?using\s+(?:static\s+)?([\w.]+)\s*;")
_RUST_MOD = re.compile(r"(?m)^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;")
_RUST_USE = re.compile(r"(?m)^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([\w:]+)")
_RUBY = re.compile(r"""(?m)^\s*(require_relative|require)\s*\(?\s*['"]([^'"\n]+)['"]""")
_PHP = re.compile(r"(?m)^\s*use\s+([\w\\]+)")
_SWIFT = re.compile(r"(?m)^\s*import\s+(\w+)")
_PACKAGE = re.compile(r"(?m)^\s*package\s+([\w.]+)")
_NAMESPACE = re.compile(r"(?m)^\s*namespace\s+([\w.]+)")


def extract(lang, text, lines):
    """Import statements of one file as Import records."""
    found = []
    if lang in ("ts", "js", "vue", "svelte"):
        for pattern in _JS:
            for match in pattern.finditer(text):
                found.append(Import(match.group(1), lines.line(match.start(1)), "js"))
    elif lang == "py":
        for match in _PY_FROM.finditer(text):
            names = tuple(name.split(" as ")[0].strip() for name in match.group(2).strip("() \t").replace("\n", " ").split(",")
                          if re.fullmatch(r"\s*\w+(?:\s+as\s+\w+)?\s*", name))
            found.append(Import(match.group(1), lines.line(match.start(1)), "py", names))
        for match in _PY_IMPORT.finditer(text):
            for spec in match.group(1).split(","):
                found.append(Import(spec.strip(), lines.line(match.start(1)), "py"))
    elif lang == "go":
        for match in _GO_SINGLE.finditer(text):
            found.append(Import(match.group(1), lines.line(match.start(1)), "go"))
        for block in _GO_BLOCK.finditer(text):
            for match in _GO_ITEM.finditer(block.group(1)):
                found.append(Import(match.group(1), lines.line(block.start(1) + match.start(1)), "go"))
    elif lang == "dart":
        for match in _DART.finditer(text):
            found.append(Import(match.group(1), lines.line(match.start(1)), "dart"))
    elif lang in ("c", "cpp", "h", "objc"):
        for match in _C_LOCAL.finditer(text):
            found.append(Import(match.group(1), lines.line(match.start(1)), "c"))
        for match in _C_SYSTEM.finditer(text):
            found.append(Import(match.group(1), lines.line(match.start(1)), "csys"))
    elif lang in ("java", "kt", "scala"):
        for match in _JAVA.finditer(text):
            found.append(Import(match.group(1), lines.line(match.start(1)), "java"))
    elif lang == "cs":
        for match in _CS.finditer(text):
            found.append(Import(match.group(1), lines.line(match.start(1)), "cs"))
    elif lang == "rs":
        for match in _RUST_MOD.finditer(text):
            found.append(Import(match.group(1), lines.line(match.start(1)), "rsmod"))
        for match in _RUST_USE.finditer(text):
            found.append(Import(match.group(1), lines.line(match.start(1)), "rs"))
    elif lang == "rb":
        for match in _RUBY.finditer(text):
            found.append(Import(match.group(2), lines.line(match.start(2)), "rbrel" if match.group(1) == "require_relative" else "rb"))
    elif lang == "php":
        for match in _PHP.finditer(text):
            found.append(Import(match.group(1), lines.line(match.start(1)), "php"))
    elif lang == "swift":
        for match in _SWIFT.finditer(text):
            found.append(Import(match.group(1), lines.line(match.start(1)), "swift"))
    return found


def _normal(folder, spec):
    """Join a relative import to a folder; None when it leaves the tree."""
    joined = posixpath.normpath(posixpath.join(folder, spec)) if folder else posixpath.normpath(spec)
    if joined.startswith("../") or joined == ".." or joined.startswith("/") or joined == ".":
        return None
    return joined


class Resolver:
    """Maps import statements to files of the source tree; unknown ones are libraries."""

    def __init__(self, tree, structure):
        self.files = tree.files
        self.by_dir = {}
        self.by_name = {}
        for path in tree.files:
            self.by_dir.setdefault(parent_folder(path), []).append(path)
            self.by_name.setdefault(base_name(path), []).append(path)
        self.go_modules, self.dart_packages, self.npm_packages, self.rust_crates = [], {}, {}, []
        for folder, manifest in structure.manifests.items():
            if manifest.file == "go.mod" and manifest.module:
                self.go_modules.append((manifest.module, folder))
            elif manifest.file == "pubspec.yaml" and manifest.module:
                self.dart_packages[manifest.module] = folder
            elif manifest.file == "package.json" and manifest.module:
                self.npm_packages[manifest.module] = folder
            elif manifest.file == "Cargo.toml":
                self.rust_crates.append(folder)
        self.go_modules.sort(key=lambda item: -len(item[0]))
        self.rust_crates.sort(key=lambda item: -len(item))
        self.system_paths = sorted((info["path"] for info in structure.system_info.values()), key=lambda item: -len(item))
        self.java_classes, self.java_packages, self.cs_namespaces = {}, {}, {}
        for path, lang in tree.langs.items():
            text = tree.texts.get(path)
            if not text:
                continue
            if lang in ("java", "kt", "scala"):
                match = _PACKAGE.search(text[:4000])
                if match:
                    stem = os.path.splitext(base_name(path))[0]
                    self.java_classes[f"{match.group(1)}.{stem}"] = path
                    self.java_packages.setdefault(match.group(1), []).append(path)
            elif lang == "cs":
                for match in _NAMESPACE.finditer(text[:20000]):
                    self.cs_namespaces.setdefault(match.group(1), []).append(path)

    def _system_of(self, path):
        for system in self.system_paths:
            if not system or path == system or path.startswith(system + "/"):
                return system
        return ""

    def _js_candidates(self, base):
        if base is None:
            return []
        if base in self.files:
            return [base]
        stem = base[:-3] if base.endswith((".js", ".jsx")) and not base.endswith(".json") else None
        for extension in JS_EXTENSIONS:
            if base + extension in self.files:
                return [base + extension]
            if stem and stem + extension in self.files:
                return [stem + extension]
        for extension in JS_EXTENSIONS:
            if f"{base}/index{extension}" in self.files:
                return [f"{base}/index{extension}"]
        return []

    def resolve(self, path, item):
        """Return (target files, library name or None) for one import of a file."""
        folder = parent_folder(path)
        spec, style = item.spec, item.style
        if style == "js":
            if spec.startswith("."):
                return self._js_candidates(_normal(folder, spec)), None
            if spec.startswith(("@/", "~/", "#/")):
                system = self._system_of(path)
                for root in (join(system, "src"), system):
                    targets = self._js_candidates(_normal(root, spec[2:]) if root else _normal("", spec[2:]))
                    if targets:
                        return targets, None
                return [], None
            for name, package in self.npm_packages.items():
                if spec == name or spec.startswith(name + "/"):
                    rest = spec[len(name):].lstrip("/")
                    for base in ([join(package, rest), join(package, "src", rest)] if rest else
                                 [join(package, "src", "index"), join(package, "index"), join(package, "src", "main")]):
                        targets = self._js_candidates(base)
                        if targets:
                            return targets, None
                    return [], None
            if spec.startswith(("node:", "http:", "https:", "data:")):
                return [], spec
            parts = spec.split("/")
            return [], "/".join(parts[:2]) if spec.startswith("@") else parts[0]
        if style == "py":
            return self._python(path, folder, spec, item.names)
        if style == "go":
            for module, root in self.go_modules:
                if spec == module or spec.startswith(module + "/"):
                    target = join(root, spec[len(module):].lstrip("/"))
                    return [file for file in self.by_dir.get(target, []) if file.endswith(".go")][:MAX_TARGETS], None
            return [], spec
        if style == "dart":
            if spec.startswith("dart:"):
                return [], None
            if spec.startswith("package:"):
                name, _, rest = spec[8:].partition("/")
                if name in self.dart_packages:
                    target = join(self.dart_packages[name], "lib", rest)
                    return ([target] if target in self.files else []), None
                return [], name
            target = _normal(folder, spec)
            return ([target] if target in self.files else []), None
        if style in ("c", "csys"):
            if style == "c":
                target = _normal(folder, spec)
                if target in self.files:
                    return [target], None
            candidates = [file for file in self.by_name.get(base_name(spec), [])
                          if file == spec or file.endswith("/" + spec)]
            system = self._system_of(path)
            candidates = [file for file in candidates if not system or file.startswith(system + "/")]
            if candidates:
                return [max(candidates, key=lambda file: (len(os.path.commonprefix([file, path])), -len(file)))], None
            return [], spec if style == "csys" else None
        if style == "java":
            if spec.endswith(".*"):
                files = self.java_packages.get(spec[:-2])
                return (files[:MAX_TARGETS], None) if files else ([], spec[:-2])
            parts = spec.split(".")
            for size in range(len(parts), 1, -1):
                target = self.java_classes.get(".".join(parts[:size]))
                if target:
                    return [target], None
            return [], spec
        if style == "cs":
            files = self.cs_namespaces.get(spec)
            return (files[:MAX_TARGETS], None) if files else ([], spec)
        if style == "rsmod":
            stem = os.path.splitext(base_name(path))[0]
            base = folder if stem in ("main", "lib", "mod") else join(folder, stem)
            for target in (join(base, spec + ".rs"), join(base, spec, "mod.rs")):
                if target in self.files:
                    return [target], None
            return [], None
        if style == "rs":
            parts = [part for part in spec.split("::") if part]
            if not parts:
                return [], None
            if parts[0] in ("crate", "super", "self"):
                if parts[0] == "crate":
                    crate = next((root for root in self.rust_crates if not root or path.startswith(root + "/")), None)
                    base = join(crate or "", "src")
                else:
                    base = folder if parts[0] == "self" else parent_folder(folder) if base_name(path) == "mod.rs" else folder
                rest = parts[1:]
                for size in range(len(rest), 0, -1):
                    for target in (join(base, *rest[:size]) + ".rs", join(base, *rest[:size], "mod.rs")):
                        if target in self.files:
                            return [target], None
                return [], None
            return [], parts[0]
        if style == "rbrel":
            target = _normal(folder, spec if spec.endswith(".rb") else spec + ".rb")
            return ([target] if target in self.files else []), None
        if style == "rb":
            return [], spec.split("/")[0]
        if style == "php":
            parts = spec.split("\\")
            if len(parts) > 1:
                suffix = "/".join(parts[1:]) + ".php"
                candidates = [file for file in self.by_name.get(parts[-1] + ".php", []) if file.endswith(suffix)]
                if candidates:
                    return [candidates[0]], None
            return [], spec.split("\\")[0].lower()
        if style == "swift":
            return [], spec
        return [], None

    def _python(self, path, folder, spec, names):
        if spec.startswith("."):
            dots = len(spec) - len(spec.lstrip("."))
            base = folder
            for _ in range(dots - 1):
                base = parent_folder(base)
            parts = [part for part in spec[dots:].split(".") if part]
            roots = [base]
        else:
            parts = spec.split(".")
            system = self._system_of(path)
            roots = []
            for root in (system, join(system, "src"), folder):
                if root not in roots:
                    roots.append(root)
        targets = []
        for root in roots:
            for name in names or ():
                target = self._python_module(join(root, *parts, name))
                if target and target not in targets:
                    targets.append(target)
            if not targets and parts:
                target = self._python_module(join(root, *parts))
                if target:
                    targets.append(target)
            if targets:
                return targets[:MAX_TARGETS], None
        if spec.startswith("."):
            return [], None
        return [], parts[0] if parts else None

    def _python_module(self, base):
        for target in (base + ".py", base + "/__init__.py"):
            if target in self.files:
                return target
        return None
