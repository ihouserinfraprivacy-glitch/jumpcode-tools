# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""The actions the model calls. Every change goes to the app in the project (appstudio.json, index.html and a version)
and to the Studio files, so the Studio shows it at once."""

import json
from pathlib import Path
import re
import time

from . import checks, model, render, views
from .arguments import ignored_fields
from .common import AppStudioError, check_id, project_folder, read_json, slug, source_root, studio_root, write_text
from .markup import check_css, check_html, read_html

COLOR = re.compile(r"#[0-9a-fA-F]{6}")
MAX_PART = 8000
MAX_TEXT_RESULT = 16000
CAPACITOR_MARK = "made by AppStudio"


def run(arguments, context, cancelled=None):
    if cancelled is not None and cancelled():
        raise AppStudioError("The operation was cancelled.")
    root = studio_root(context)
    state = views.load_state(root)
    ignored = ignored_fields(arguments)
    try:
        result = ACTIONS[arguments["action"]](root, context, state, {k: v for k, v in arguments.items() if k not in ignored})
    finally:
        views.save_state(root, state)
    if ignored:
        result["message"] = f"{result.get('message', '')} (Ignored for {arguments['action']}: {', '.join(ignored)}.)".strip()
    return result


# ---------------------------------------------------------------- helpers

def _project(context):
    return source_root(context, required=True)


def _open(root, context, state, required=True):
    project = _project(context)
    folder = model.find(project, (state.get("settings") or {}).get("folder"))
    if folder is None:
        if required:
            raise AppStudioError("This project has no app yet. Call start with the app's name (and colours if the user said them).")
        return project, None, None
    state["settings"]["folder"] = folder
    return project, folder, model.load(project, folder)


def _commit(root, state, project, folder, app, summary, building=None):
    files = model.save(project, folder, app, summary)
    mapped = views.write_app(root, app, folder, files)
    state["problems"] = checks.problems(app, mapped)
    state["versions"] = model.versions(project, folder)[-30:][::-1]
    state["building"] = {**building, "at": time.time()} if building else None
    state["settings"]["folder"] = folder
    return mapped


def _screen(app, sid, create_kind=None):
    for screen in app["screens"]:
        if screen["id"] == sid:
            return screen
    if create_kind is None:
        known = ", ".join(s["id"] for s in app["screens"]) or "none yet"
        raise AppStudioError(f"There is no screen {sid}. Screens: {known}. Call screen to create it.")
    screen = {"id": sid, "title": sid.replace("-", " ").capitalize(), "route": "/" if not app["screens"] else "/" + sid,
              "kind": create_kind, "login": False, "plan": [], "parts": []}
    app["screens"].append(screen)
    return screen


def _outline(app):
    lines = []
    tabs = {tab["screen"] for tab in app["tabs"]}
    for screen in app["screens"]:
        written = [part["id"] for part in render.ordered_parts(screen)]
        planned = [pid for pid in screen.get("plan", []) if pid not in written]
        text = f"{screen['id']} ({screen.get('kind')}{', tab' if screen['id'] in tabs and screen.get('kind') != 'tab' else ''}, {screen.get('route')})"
        text += f": parts {', '.join(written) or 'none'}"
        if planned:
            text += f"; still planned {', '.join(planned)}"
        lines.append(text)
    styles = ", ".join(block["name"] for block in app["styles"]) or "none"
    data = ", ".join(f"{name} ({len(rows)})" for name, rows in app["data"].items()) or "none"
    tabs_text = ", ".join(tab["screen"] for tab in app["tabs"]) or "none"
    return f"Screens: {'; '.join(lines) or 'none'}. Tabs: {tabs_text}. Styles: {styles}. Example data: {data}."


def _problems_text(state, limit=6):
    found = state["problems"]
    if not found:
        return "No problems found."
    return f"{len(found)} problem(s): " + " ".join(f"{item['text']}" for item in found[:limit])


# ---------------------------------------------------------------- actions

def status(root, context, state, arguments):
    project, folder, app = _open(root, context, state, required=False)
    if app is None:
        views.write_app(root, None, None)
        return {"ok": True, "app": None, "message": "This project has no app yet. Call start with the app's name."}
    mapped = views.write_app(root, app, folder)
    state["problems"] = checks.problems(app, mapped)
    state["versions"] = model.versions(project, folder)[-30:][::-1]
    return {"ok": True, "app": app["name"], "folder": folder, "revision": app["revision"],
            "message": f"App {app['name']} in {folder}/ (version {app['revision']}). {_outline(app)} {_problems_text(state, 3)}"}


def start(root, context, state, arguments):
    project = _project(context)
    existing = model.find(project, (state.get("settings") or {}).get("folder"))
    if existing and not arguments.get("folder"):
        app = model.load(project, existing)
        raise AppStudioError(f"The project already has the app {app['name']} in {existing}/. Keep building it with screen and write_part, "
                             "or give another folder to start a second app.")
    folder = arguments.get("folder") or model.free_folder(project)
    target = project_folder(project, folder)
    if (target / model.MODEL).exists():
        raise AppStudioError(f"{folder}/ already has an app. Call status to see it.")
    name = (arguments.get("name") or Path(project).name.replace("-", " ").replace("_", " ").strip().title() or "Meu app").strip()
    theme = _theme_values(arguments)
    app = model.empty(name, slug(name), theme)
    state["settings"]["folder"] = folder
    state["view"] = "preview"
    _commit(root, state, project, folder, app, f"Criou o app {name}")
    return {"ok": True, "folder": folder, "message": f"Created the app {name} in {folder}/ (index.html opens in any browser). "
                                                     "Next: write_styles base, then screen and write_part for the first screen."}


def _theme_values(arguments):
    theme = {}
    for key in ("primary", "accent", "background", "surface", "text", "muted"):
        if key in arguments:
            value = str(arguments[key]).strip()
            if not COLOR.fullmatch(value):
                raise AppStudioError(f"{key} must be a colour like #24563F, not {value}.")
            theme[key] = value.upper()
    if "font" in arguments:
        font = str(arguments["font"]).strip()
        if re.search(r"[;{}<>]", font) or "url(" in font.lower():
            raise AppStudioError("font must be system, serif, rounded, mono or a font family name.")
        theme["font"] = font
    if "radius" in arguments:
        theme["radius"] = int(arguments["radius"])
    if "icon" in arguments:
        theme["icon"] = str(arguments["icon"]).strip()[:3]
    return theme


def screen(root, context, state, arguments):
    project, folder, app = _open(root, context, state)
    sid = check_id(arguments.get("screen"), "screen")
    known = any(s["id"] == sid for s in app["screens"])
    item = _screen(app, sid, create_kind=arguments.get("kind") or ("tab" if any(t["screen"] == sid for t in app["tabs"]) else "stack"))
    in_tabs = any(t["screen"] == sid for t in app["tabs"])
    if in_tabs and arguments.get("kind") and arguments["kind"] != "tab":
        raise AppStudioError(f"{sid} is one of the bottom tabs, so it stays kind tab (with the tab bar). Leave kind out, or remove its tab "
                             f"first (remove with tab {sid}) if it should open over another screen.")
    for key in ("title", "kind", "login"):
        if key in arguments:
            item[key] = arguments[key]
    if "route" in arguments:
        route = "/" + str(arguments["route"]).strip().strip("/")
        if not re.fullmatch(r"/[a-z0-9/_-]{0,78}", route.lower()):
            raise AppStudioError("route must look like /agendar or /agendar/horario.")
        clash = next((s["id"] for s in app["screens"] if s is not item and (s.get("route") or "/" + s["id"]) == route.lower()), None)
        if clash:
            raise AppStudioError(f"The route {route} already belongs to {clash}.")
        item["route"] = route.lower()
    if "plan" in arguments:
        item["plan"] = list(dict.fromkeys(check_id(pid, "part") for pid in arguments["plan"]))
    if arguments.get("first"):
        app["start"] = sid
    _commit(root, state, project, folder, app, f"{'Mudou' if known else 'Criou'} a tela {item['title']}",
            {"screen": sid, "part": None, "action": "screen"})
    state["focus"]["screen"] = sid
    if state["view"] not in ("preview", "test", "states"):
        state["view"] = "preview"
    planned = f" Planned parts: {', '.join(item['plan'])}; write each with write_part." if item.get("plan") and not item["parts"] else ""
    return {"ok": True, "screen": sid, "message": f"{'Updated' if known else 'Created'} the screen {sid} ({item['kind']}, {item['route']}).{planned}"}


def tabs(root, context, state, arguments):
    project, folder, app = _open(root, context, state)
    items = arguments.get("items") or []
    if not items:
        raise AppStudioError("Give items: up to 5 tabs like [{\"screen\": \"inicio\", \"label\": \"Início\", \"icon\": \"inicio\"}].")
    result, created = [], []
    for entry in items:
        sid = check_id(entry.get("screen"), "tab screen")
        if not any(s["id"] == sid for s in app["screens"]):
            created.append(sid)
        target = _screen(app, sid, create_kind="tab")
        target["kind"] = "tab"
        if sid in created and entry.get("label"):
            target["title"] = entry["label"][:60]
        result.append({"screen": sid, "label": (entry.get("label") or target.get("title") or sid)[:24], "icon": render.icon_name(entry.get("icon"))})
    chosen = {entry["screen"] for entry in result}
    for item in app["screens"]:
        if item["kind"] == "tab" and item["id"] not in chosen:
            item["kind"] = "stack"
    app["tabs"] = result
    if app.get("start") not in chosen:
        app["start"] = result[0]["screen"]
    _commit(root, state, project, folder, app, "Mudou as abas", {"screen": result[0]["screen"], "part": None, "action": "tabs"})
    note = f" Created the screens {', '.join(created)} (still empty)." if created else ""
    return {"ok": True, "message": f"Tabs: {', '.join(entry['label'] for entry in result)}.{note}"}


def write_part(root, context, state, arguments):
    project, folder, app = _open(root, context, state)
    sid = check_id(arguments.get("screen"), "screen")
    pid = check_id(arguments.get("part"), "part")
    html = str(arguments.get("html") or "").strip()
    if not html:
        raise AppStudioError("html is empty. Send the part's HTML, one complete element such as <section>…</section>.")
    if len(html) > MAX_PART:
        raise AppStudioError(f"The part has {len(html)} characters; keep each part under {MAX_PART} and split it into more parts.")
    problems = check_html(html)
    problems += _data_problems(app, html)
    if problems:
        raise AppStudioError("Not saved: " + "; ".join(problems) + ".")
    created_screen = not any(s["id"] == sid for s in app["screens"])
    target = _screen(app, sid, create_kind="stack")
    existing = next((part for part in target["parts"] if part["id"] == pid), None)
    if existing:
        existing["html"] = html
        existing["updated"] = time.time()
    else:
        target["parts"].append({"id": pid, "html": html, "updated": time.time()})
        if pid not in target["plan"]:
            target["plan"].append(pid)
    _commit(root, state, project, folder, app, f"{target['title']}: parte {pid}", {"screen": sid, "part": pid, "action": "write"})
    state["focus"]["screen"] = sid
    state["focus"]["part"] = pid
    if state["view"] not in ("preview", "test", "states"):
        state["view"] = "preview"
    written = {part["id"] for part in target["parts"]}
    left = [p for p in target["plan"] if p not in written]
    note = f" Created the screen {sid} for it." if created_screen else ""
    if left:
        plan_note = f" Still planned on {sid}: {', '.join(left)}."
    elif len(target["plan"]) > 1:
        plan_note = f" {sid} has all its planned parts."
    else:
        plan_note = f" {sid} has no plan; declare its parts with screen and plan to show the rest as placeholders."
    idle = read_html(html).idle_buttons
    idle_note = f" Buttons without an action: {', '.join(idle)} (add data-go, data-back or data-close)." if idle else ""
    return {"ok": True, "message": f"{'Replaced' if existing else 'Wrote'} {sid}/{pid}.{note}{plan_note}{idle_note}"}


def _data_problems(app, html):
    """Lists (data-each) must name example data that exists, and {{field}} must be one of its rows' keys."""
    reader = read_html(html)
    data = app.get("data") or {}
    problems = []
    if reader.bad_placeholders:
        problems.append(f"{', '.join('{{' + p + '}}' for p in sorted(reader.bad_placeholders))} is not a field: write the row's key itself, such as {{{{nome}}}}")
    if reader.orphans:
        problems.append(f"{', '.join('{{' + p + '}}' for p in sorted(reader.orphans))} only works inside an element with data-each")
    for collection, fields in reader.each.items():
        if collection not in data:
            names = ", ".join(data) or "none yet"
            problems.append(f"data-each=\"{collection}\" has no example data (collections: {names}); call data with collection {collection} and rows first")
            continue
        keys = {key for row in data[collection] if isinstance(row, dict) for key in row}
        unknown = sorted(fields - keys)
        if unknown:
            problems.append(f"{', '.join('{{' + f + '}}' for f in unknown)} is not in {collection}; its fields are {', '.join(sorted(keys))}")
    return problems


def write_styles(root, context, state, arguments):
    project, folder, app = _open(root, context, state)
    name = check_id(arguments.get("name") or "base", "styles name")
    css = str(arguments.get("css") or "").strip()
    if not css:
        raise AppStudioError("css is empty.")
    if len(css) > MAX_PART:
        raise AppStudioError(f"The block has {len(css)} characters; keep each block under {MAX_PART} and split it.")
    problems = check_css(css)
    if re.search(r"--(cor-[a-z-]+|raio|fonte)\s*:", css):
        problems.append("the theme variables (--cor-..., --raio, --fonte) are set with the theme action, not in CSS; use them with var()")
    if problems:
        raise AppStudioError("Not saved: " + "; ".join(problems) + ".")
    block = next((b for b in app["styles"] if b["name"] == name), None)
    if block:
        block["css"] = css
    else:
        app["styles"].append({"name": name, "css": css})
    _commit(root, state, project, folder, app, f"Estilos {name}", {"screen": state["focus"].get("screen"), "part": None, "action": "styles"})
    return {"ok": True, "message": f"{'Replaced' if block else 'Wrote'} the styles block {name}."}


def data(root, context, state, arguments):
    project, folder, app = _open(root, context, state)
    name = check_id(arguments.get("collection"), "collection")
    rows = arguments.get("rows")
    if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
        raise AppStudioError("rows must be a list of objects, such as [{\"nome\": \"Corte\", \"preco\": \"R$ 45\"}].")
    if len(json.dumps(rows, ensure_ascii=False)) > 60000:
        raise AppStudioError("The example data is too large; keep it under 60 KB.")
    app["data"][name] = rows
    _commit(root, state, project, folder, app, f"Dados de exemplo {name}", {"screen": state["focus"].get("screen"), "part": None, "action": "data"})
    used = any(f'data-each="{name}"' in part["html"] for screen_ in app["screens"] for part in screen_["parts"])
    keys = sorted({key for row in rows for key in row})[:4]
    example = " ".join("{{" + key + "}}" for key in keys)
    hint = "" if used else f" No part uses it yet: put data-each=\"{name}\" on the element to repeat, with {example} inside."
    return {"ok": True, "message": f"Example data {name}: {len(rows)} row(s).{hint}"}


def theme(root, context, state, arguments):
    project, folder, app = _open(root, context, state)
    values = _theme_values(arguments)
    if arguments.get("name"):
        app["name"] = arguments["name"].strip()
    app["theme"].update(values)
    _commit(root, state, project, folder, app, "Mudou o tema", {"screen": state["focus"].get("screen"), "part": None, "action": "theme"})
    ratio = checks.contrast(app["theme"]["text"], app["theme"]["background"])
    return {"ok": True, "message": f"Theme: {', '.join(f'{k} {v}' for k, v in values.items()) or 'name only'}. Text contrast {ratio}:1."}


def read(root, context, state, arguments):
    project, folder, app = _open(root, context, state)
    if arguments.get("name"):
        block = next((b for b in app["styles"] if b["name"] == arguments["name"].strip().lower()), None)
        if not block:
            raise AppStudioError(f"There is no styles block {arguments['name']}. Blocks: {', '.join(b['name'] for b in app['styles']) or 'none'}.")
        return {"ok": True, "css": block["css"], "message": f"Styles {block['name']}:\n{block['css'][:MAX_TEXT_RESULT]}"}
    if not arguments.get("screen"):
        return {"ok": True, "message": _outline(app)}
    target = _screen(app, check_id(arguments["screen"], "screen"))
    parts = render.ordered_parts(target)
    if arguments.get("part"):
        pid = check_id(arguments["part"], "part")
        part = next((p for p in parts if p["id"] == pid), None)
        if not part:
            raise AppStudioError(f"{target['id']} has no part {pid}. Parts: {', '.join(p['id'] for p in parts) or 'none'}.")
        return {"ok": True, "html": part["html"], "message": f"{target['id']}/{pid}:\n{part['html']}"}
    text = "\n\n".join(f"<!-- part {p['id']} -->\n{p['html']}" for p in parts)
    if len(text) > MAX_TEXT_RESULT:
        return {"ok": True, "message": f"{target['id']} has parts {', '.join(p['id'] for p in parts)}; read them one at a time with part."}
    return {"ok": True, "message": f"{target['id']} ({target.get('kind')}, {target.get('route')}):\n{text or '(no parts yet)'}"}


def remove(root, context, state, arguments):
    project, folder, app = _open(root, context, state)
    if arguments.get("collection"):
        name = arguments["collection"].strip().lower()
        if name not in app["data"]:
            raise AppStudioError(f"There is no example data {name}.")
        del app["data"][name]
        summary = f"Tirou os dados {name}"
    elif arguments.get("name") and not arguments.get("screen"):
        name = arguments["name"].strip().lower()
        if not any(b["name"] == name for b in app["styles"]):
            raise AppStudioError(f"There is no styles block {name}.")
        app["styles"] = [b for b in app["styles"] if b["name"] != name]
        summary = f"Tirou os estilos {name}"
    elif arguments.get("tab"):
        sid = arguments["tab"].strip().lower()
        if not any(t["screen"] == sid for t in app["tabs"]):
            raise AppStudioError(f"{sid} is not a tab.")
        app["tabs"] = [t for t in app["tabs"] if t["screen"] != sid]
        _screen(app, sid)["kind"] = "stack"
        summary = f"Tirou a aba {sid}"
    elif arguments.get("screen") and arguments.get("part"):
        target = _screen(app, check_id(arguments["screen"], "screen"))
        pid = check_id(arguments["part"], "part")
        if not any(p["id"] == pid for p in target["parts"]) and pid not in target["plan"]:
            raise AppStudioError(f"{target['id']} has no part {pid}.")
        target["parts"] = [p for p in target["parts"] if p["id"] != pid]
        target["plan"] = [p for p in target["plan"] if p != pid]
        summary = f"{target['title']}: tirou a parte {pid}"
    elif arguments.get("screen"):
        target = _screen(app, check_id(arguments["screen"], "screen"))
        app["screens"] = [s for s in app["screens"] if s is not target]
        app["tabs"] = [t for t in app["tabs"] if t["screen"] != target["id"]]
        summary = f"Tirou a tela {target['title']}"
    else:
        raise AppStudioError("Say what to remove: screen (and part), name (styles), tab or collection.")
    _commit(root, state, project, folder, app, summary, {"screen": state["focus"].get("screen"), "part": None, "action": "remove"})
    return {"ok": True, "message": summary.replace("Tirou", "Removed") + ". The previous version is kept (restore goes back)."}


def check(root, context, state, arguments):
    project, folder, app = _open(root, context, state)
    mapped = views.write_app(root, app, folder)
    state["problems"] = checks.problems(app, mapped)
    state["view"] = "problems"
    if not state["problems"]:
        return {"ok": True, "problems": [], "message": "No problems found in the screens, the routes or the colours."}
    lines = [f"{item['text']} Fix: {item['fix']}" for item in state["problems"][:12]]
    return {"ok": True, "problems": [item["id"] for item in state["problems"]],
            "message": f"{len(state['problems'])} problem(s). " + " ".join(lines) + " Tell the user and fix only what they agree to."}


def versions(root, context, state, arguments):
    project, folder, app = _open(root, context, state)
    kept = model.versions(project, folder)
    state["versions"] = kept[-30:][::-1]
    state["view"] = "versions"
    listing = "; ".join(f"{item['n']}: {item['summary']}" for item in kept[-12:][::-1])
    return {"ok": True, "message": f"Current version {app['revision']}. Last versions: {listing}. restore with version goes back to one."}


def restore(root, context, state, arguments):
    project, folder, app = _open(root, context, state)
    number = arguments.get("version") or max(1, int(app["revision"]) - 1)
    old = model.version(project, folder, number)
    old["revision"] = app["revision"]
    _commit(root, state, project, folder, old, f"Voltou para a versão {number}", {"screen": state["focus"].get("screen"), "part": None, "action": "restore"})
    return {"ok": True, "message": f"Back to version {number}; it is saved as version {old['revision']}, so this can be undone too."}


def show(root, context, state, arguments):
    project, folder, app = _open(root, context, state, required=False)
    focus = state["focus"]
    if arguments.get("view"):
        state["view"] = arguments["view"]
    if arguments.get("screen"):
        sid = check_id(arguments["screen"], "screen")
        if app is not None:
            _screen(app, sid)
        focus["screen"] = sid
        if not arguments.get("view") and state["view"] not in ("preview", "test", "states"):
            state["view"] = "preview"
    for key in ("part", "state", "device", "frame", "fold", "landscape"):
        if key in arguments:
            focus[key] = arguments[key]
    if arguments.get("state") and not arguments.get("view"):
        state["view"] = "states" if arguments["state"] != "normal" else state["view"]
    if app is not None:
        views.write_app(root, app, folder)
    shown = f"{focus['device']}{'' if focus['frame'] else ', no frame'}{', landscape' if focus['landscape'] else ''}"
    if focus["device"].endswith("fold"):
        shown += f", {focus['fold']}"
    return {"ok": True, "message": f"The Studio shows the {state['view']} view" + (f" of {focus['screen']}" if focus.get("screen") else "") + f" on {shown}."}


def publish(root, context, state, arguments):
    project, folder, app = _open(root, context, state)
    if not app["screens"]:
        raise AppStudioError("The app has no screens yet; there is nothing to publish.")
    base = project_folder(project, folder)
    app["published"] = True
    _commit(root, state, project, folder, app, "Publicou como PWA", {"screen": state["focus"].get("screen"), "part": None, "action": "publish"})
    written = [f"{folder}/index.html"]
    for name, content in (("manifest.webmanifest", render.manifest(app)), ("icone.svg", render.icon_file(app)),
                          ("sw.js", render.service_worker(app))):
        write_text(base / name, content)
        written.append(f"{folder}/{name}")
    skipped = []
    if arguments.get("capacitor"):
        app_id = (arguments.get("app_id") or f"com.{slug(app['name']).replace('-', '')}.app").strip()
        if not re.fullmatch(r"[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,4}", app_id):
            raise AppStudioError("app_id must look like com.barbearia.app (lowercase letters and dots).")
        www = base / "www"
        www.mkdir(exist_ok=True)
        for name in ("index.html", "manifest.webmanifest", "icone.svg", "sw.js"):
            write_text(www / name, (base / name).read_text(encoding="utf-8"))
            written.append(f"{folder}/www/{name}")
        generated = {
            "capacitor.config.json": json.dumps({"appId": app_id, "appName": app["name"], "webDir": "www", "_comment": CAPACITOR_MARK}, ensure_ascii=False, indent=1),
            "package.json": json.dumps({"name": slug(app["name"]), "private": True, "version": "1.0.0", "description": CAPACITOR_MARK,
                                        "scripts": {"android": "npx cap add android && npx cap sync android && npx cap open android",
                                                    "ios": "npx cap add ios && npx cap sync ios && npx cap open ios",
                                                    "sync": "npx cap sync"},
                                        "dependencies": {"@capacitor/core": "latest", "@capacitor/android": "latest", "@capacitor/ios": "latest"},
                                        "devDependencies": {"@capacitor/cli": "latest"}}, ensure_ascii=False, indent=1),
            "PUBLICAR.md": _publish_guide(app, app_id, folder),
        }
        for name, content in generated.items():
            path = base / name
            if path.exists() and CAPACITOR_MARK not in path.read_text(encoding="utf-8", errors="replace"):
                skipped.append(f"{folder}/{name}")
                continue
            write_text(path, content)
            written.append(f"{folder}/{name}")
    state["published"] = {"at": time.time(), "files": written, "capacitor": bool(arguments.get("capacitor")), "skipped": skipped}
    state["view"] = "publish"
    note = f" Not replaced because someone else wrote them: {', '.join(skipped)}." if skipped else ""
    cap = " Capacitor files are ready: PUBLICAR.md says how to build the Android app (Android Studio) and the iPhone app (a Mac with Xcode)." \
        if arguments.get("capacitor") else ""
    return {"ok": True, "files": written, "message": f"Published {app['name']} as an installable app (PWA): {', '.join(written)}.{cap}{note} "
                                                     "To install from a phone it must be served over HTTPS (any static hosting)."}


def _publish_guide(app, app_id, folder):
    return f"""# Publicar {app['name']}

Feito pelo AppStudio ({CAPACITOR_MARK}). O app está em `www/` (uma cópia de `index.html`, do manifesto e do ícone).

## Como app instalável (PWA)
Publique a pasta `{folder}/` em qualquer hospedagem estática com HTTPS. No celular, abra o endereço e
use "Adicionar à tela inicial". O app funciona sem internet depois da primeira visita.

## Android (Google Play)
1. Instale o Node.js 18 ou mais novo e o Android Studio.
2. Nesta pasta: `npm install` e depois `npm run android`.
3. No Android Studio: Build > Generate Signed App Bundle. A conta de desenvolvedor do Google Play custa US$ 25, uma vez.

## iPhone (App Store)
Precisa de um Mac com o Xcode: `npm install` e `npm run ios`; no Xcode, Product > Archive.
A conta de desenvolvedor da Apple custa US$ 99 por ano.

Identificador do app: `{app_id}`. Sempre que mudar o app no AppStudio, publique de novo e rode `npm run sync`.
"""


ACTIONS = {"status": status, "start": start, "screen": screen, "tabs": tabs, "write_part": write_part, "write_styles": write_styles,
           "data": data, "theme": theme, "read": read, "remove": remove, "check": check, "versions": versions, "restore": restore,
           "show": show, "publish": publish}
