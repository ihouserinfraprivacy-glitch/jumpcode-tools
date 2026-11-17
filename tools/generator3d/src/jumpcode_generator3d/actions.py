# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""The actions the model calls. Each one reads and writes the Studio files; the engine runs in its own process."""

from datetime import datetime
import difflib
import os
from pathlib import Path
import time

from . import engine as engines
from . import provenance, views
from .arguments import ignored_fields
from .common import (Cancelled, GeneratorError, clean_relative, find_images, image_size, project_path, read_json, relative_name,
                     seconds_text, size_text, slug, source_root, studio_root, write_json, IMAGE_EXTENSIONS)

ENGINE_CACHE = "engine-cache.json"
CONSENT_WORDS = ("substitu", "sobrescrev", "sobreescrev", "pode trocar", "pode apagar", "replace", "overwrite")
THUMB_CACHE = "thumbs-cache.json"
MAX_THUMBS = 60
DOUBTFUL = 0.5
ABSENT = 0.3


def run(arguments, context, cancelled=None):
    if cancelled is not None and cancelled():
        raise GeneratorError("The operation was cancelled.")
    root = studio_root(context)
    ignored = ignored_fields(arguments)
    state = views.load(root)
    try:
        result = ACTIONS[arguments["action"]](root, context, state, {k: v for k, v in arguments.items() if k not in ignored}, cancelled)
    finally:
        views.save(root, state)
    if ignored:
        result["message"] = f"{result.get('message', '')} (Ignored for {arguments['action']}: {', '.join(ignored)}.)".strip()
    return result


# ---------------------------------------------------------------- engine

def _engine(root, state, required=True):
    """The located engine and its facts (cached until the engine changes), keeping state.engine current."""
    try:
        found = engines.locate()
    except engines.EngineMissing as missing:
        state["engine"] = views.engine_view(problem=missing.problem, fix=missing.fix, device=state["settings"]["device"])
        if required:
            raise GeneratorError(f"{missing.problem} {missing.fix} Tell the user this; nothing was generated.") from None
        return None, None
    cache = read_json(root / ENGINE_CACHE, {}) or {}
    info = cache.get("info") if cache.get("key") == found.key() else None
    if info is None:
        try:
            info = engines.call(found, {"action": "info"}, timeout=120)
        except engines.EngineFailed as error:
            problem = f"The 3D engine in {found.root} does not start: {error}"
            state["engine"] = views.engine_view(problem=problem, fix="Reinstall foto-para-rig or run its tools\\setup-env.cmd.",
                                                device=state["settings"]["device"])
            if required:
                raise GeneratorError(problem + " Tell the user; nothing was generated.") from None
            return None, None
        info = {key: info.get(key) for key in ("version", "animations", "defaults", "providers", "python")}
        write_json(root / ENGINE_CACHE, {"key": found.key(), "info": info})
    state["engine"] = views.engine_view(info, device=state["settings"]["device"])
    return found, info


def _thumbs(root, project, found, images):
    """Small previews of the listed images, made by the engine once and kept while the file stays the same."""
    cache = read_json(root / THUMB_CACHE, {}) or {}
    wanted, keys = [], {}
    for item in images[:MAX_THUMBS]:
        key = f"{item['path']}|{item['bytes']}|{int(item['modified'])}"
        keys[item["path"]] = key
        if key not in cache:
            wanted.append(item["path"])
    if wanted and found is not None:
        try:
            answer = engines.call(found, {"action": "thumbs", "size": 128,
                                          "paths": [str(project_path(project, path, "image")) for path in wanted]}, timeout=120)
            for path, made in zip(wanted, answer.get("thumbs", [])):
                if made.get("thumb"):
                    cache[keys[path]] = made["thumb"]
        except (engines.EngineFailed, GeneratorError):
            pass
        live = set(keys.values())
        cache = {key: value for key, value in cache.items() if key in live or len(cache) < 400}
        write_json(root / THUMB_CACHE, cache)
    for item in images:
        item["thumb"] = cache.get(keys.get(item["path"], ""))


def _refresh_images(root, project, state, found):
    images, more = find_images(project) if project else ([], 0)
    _thumbs(root, project, found, images)
    by_source = {}
    for model in state["models"]:
        if model.get("source") and not model.get("missing"):
            by_source.setdefault(model["source"], model["path"])
    for item in images:
        item["model"] = by_source.get(item["path"])
        item.pop("modified", None)
    state["images"] = images
    state["imagesMore"] = more
    return images, more


# ---------------------------------------------------------------- what is there

def status(root, context, state, arguments, cancelled):
    project = source_root(context)
    found, info = _engine(root, state, required=False)
    images, more = _refresh_images(root, project, state, found)
    _check_models(project, state)
    lines = []
    if found is None:
        lines.append(f"The 3D engine is not ready: {state['engine']['problem']} {state['engine']['fix']}")
    else:
        lines.append(f"The 3D engine is ready (foto-para-rig {info.get('version')}, {state['engine']['devices']}).")
    lines.append(f"The project has {len(images) + more} image(s)" + (f": {', '.join(i['path'] for i in images[:12])}." if images else "."))
    models = [m for m in state["models"] if not m.get("missing")]
    if models:
        lines.append(f"Models made here: {', '.join(m['path'] for m in models[:12])}.")
    if state["focus"].get("model"):
        lines.append(f"The Studio shows {state['focus']['model']}.")
    if not project:
        lines.append("No project folder is open; the user must open the 3D Generator from a project's chat.")
    return {"ok": True, "ready": found is not None, "images": len(images) + more, "models": len(models), "message": " ".join(lines)}


def images(root, context, state, arguments, cancelled):
    project = source_root(context, required=True)
    found, _ = _engine(root, state, required=False)
    found_images, more = _refresh_images(root, project, state, found)
    if not state["focus"].get("image"):
        state["view"] = "start"
    if not found_images:
        return {"ok": True, "images": [], "message": "The project has no PNG, JPEG, WebP or BMP image. Ask the user to put the character's image in the project folder."}
    listing = "; ".join(f"{i['path']} ({i['width']}×{i['height']}{', model ' + i['model'] if i.get('model') else ''})" for i in found_images[:40])
    extra = f" And {more} more." if more else ""
    note = "" if found is not None else f" The 3D engine is not ready: {state['engine']['problem']}"
    return {"ok": True, "images": [{k: i[k] for k in ("path", "width", "height", "bytes")} for i in found_images[:40]],
            "message": f"{len(found_images) + more} image(s): {listing}.{extra} Whether each one can get a skeleton is unknown until open checks it. Call open with a path to check one.{note}"}


def _keypoints(points):
    return [{**point, "label": views.KEYPOINT_LABELS.get(point["name"], point["name"]), "u": round(point["u"], 1),
             "v": round(point["v"], 1), "score": round(min(point["score"], 1.0), 3)} for point in points]


def _absent(point):
    """A point under the minimum score, or outside the 512 x 512 prepared image, is not in the image."""
    return point["score"] < ABSENT or not (0 <= point["u"] <= 512 and 0 <= point["v"] <= 512)


def _checks(answer):
    verdict = answer.get("verdict") or {}
    points = answer.get("keypoints") or []
    absent = [p for p in points if _absent(p)]
    sure = [p for p in points if p["score"] >= DOUBTFUL and not _absent(p)]
    doubtful = [p for p in points if ABSENT <= p["score"] < DOUBTFUL and not _absent(p)]
    kind = verdict.get("kind")
    width, height = (answer.get("size") or [0, 0])[:2]
    filled = answer.get("filled")
    return [
        {"key": "humanoid", "label": "Personagem humanoide", "ok": kind != "NotHumanoidError",
         "detail": "cabeça, tronco, dois braços e duas pernas" if kind != "NotHumanoidError" else views.REASONS["NotHumanoidError"]},
        {"key": "body", "label": "Corpo inteiro", "ok": kind not in ("NotFullBodyError", "NotHumanoidError"),
         "detail": "cabeça, quadris, joelhos e pés aparecem" if kind is None else views.REASONS.get(kind, "")},
        {"key": "points", "label": "Pontos do corpo", "ok": not absent and len(doubtful) <= 2,
         "detail": f"{len(sure)} certos, {len(doubtful)} duvidosos, {len(absent)} fora da imagem, de 17"},
        {"key": "background", "label": "Fundo removido", "ok": filled is None or 0.02 <= filled <= 0.9,
         "detail": "silhueta separada do fundo" if filled is None or 0.02 <= filled <= 0.9 else "a silhueta ocupa quase nada ou quase tudo"},
        {"key": "size", "label": "Tamanho da imagem", "ok": min(width, height) >= 256,
         "detail": f"{width} × {height}; o gerador usa 512 × 512"},
    ]


def open_(root, context, state, arguments, cancelled):
    project = source_root(context, required=True)
    path = project_path(project, arguments.get("path") or state["focus"].get("image"), "image")
    if not path.is_file() or not path.name.lower().endswith(IMAGE_EXTENSIONS):
        raise GeneratorError(f"{arguments.get('path')} is not an image in the project. Call images to list them.")
    if image_size(path) is None:
        raise GeneratorError(f"{arguments.get('path')} is not a PNG, JPEG, WebP or BMP image that can be read.")
    relative = relative_name(project, path)
    found, _ = _engine(root, state)
    try:
        answer = engines.call(found, {"action": "check", "image": str(path), "device": state["settings"]["device"]},
                              cancelled=cancelled, timeout=240)
    except engines.EngineFailed as error:
        raise GeneratorError(f"The engine could not read {relative}: {error}") from None
    points = _keypoints(answer.get("keypoints") or [])
    verdict = answer.get("verdict") or {}
    kind = verdict.get("kind")
    data = {"path": relative, "size": answer.get("size"), "seconds": round(answer.get("seconds") or 0, 2),
            "original": answer.get("original"), "prepared": answer.get("prepared"),
            "keypoints": points, "verdict": {"rig": bool(verdict.get("rig")), "kind": kind, "reason": views.REASONS.get(kind),
                                             "detail": verdict.get("detail")},
            "checks": _checks({**answer, "keypoints": points})}
    views.write_image(root, data)
    _refresh_images(root, project, state, found)
    state["focus"]["image"] = relative
    state["view"] = "image"
    doubtful = [p["label"] for p in points if ABSENT <= p["score"] < DOUBTFUL and not _absent(p)]
    absent = [p["label"] for p in points if _absent(p)]
    if kind:
        verdict_text = f"No skeleton is possible: {views.REASONS.get(kind, kind)}. generate would save the 3D model without bones."
    else:
        verdict_text = "It is a full-body humanoid: generate will add the 66-bone skeleton and the animations."
    notes = []
    if doubtful:
        notes.append(f"Doubtful points: {', '.join(doubtful)}.")
    if absent:
        notes.append(f"Not in the image: {', '.join(absent)}.")
    return {"ok": True, "image": relative, "rig": not kind, "reason": views.REASONS.get(kind),
            "message": f"Checked {relative} ({answer['size'][0]}×{answer['size'][1]}). {verdict_text} {' '.join(notes)} "
                       "Tell the user this and wait: call generate only when the user asks for the model.".replace("  ", " ")}


def animations(root, context, state, arguments, cancelled):
    found, info = _engine(root, state)
    names = info.get("animations") or []
    defaults = state["settings"]["animations"] or info.get("defaults") or []
    listing = ", ".join(f"{name} ({views.ANIMATION_LABELS.get(name, name)})" for name in names)
    return {"ok": True, "animations": names, "defaults": defaults,
            "message": f"{len(names)} animations: {listing}. Default: {', '.join(defaults)}."}


def _check_models(project, state):
    """Marks models whose file is gone and adds GLB files found in the models folder that this Studio did not make."""
    if not project:
        return
    known = {m["path"] for m in state["models"]}
    for model in state["models"]:
        try:
            model["missing"] = not project_path(project, model["path"], "model").is_file()
        except GeneratorError:
            model["missing"] = True
    try:
        folder = project_path(project, state["settings"]["folder"], "folder")
    except GeneratorError:
        return
    if folder.is_dir():
        for path in sorted(folder.glob("*.glb")):
            relative = relative_name(project, path)
            if relative not in known and not path.name.startswith("."):
                state["models"].append(_recorded(project, path) or {
                    "path": relative, "name": path.stem, "source": None, "rigged": None, "clips": [], "bytes": path.stat().st_size,
                    "created": datetime.fromtimestamp(path.stat().st_mtime).isoformat(timespec="seconds"), "external": True,
                    "missing": False, "warnings": []})


def _recorded(project, path):
    """A registry entry rebuilt from what the tool wrote inside a GLB, so another Studio of the project knows it."""
    info, _ = provenance.read(path)
    if not info or not isinstance(info.get("source"), str):
        return None
    return {"path": relative_name(project, path), "name": path.stem, "source": info["source"], "rigged": bool(info.get("rig")),
            "reason": views.REASONS.get(info.get("reasonKind")) if info.get("reasonKind") else None,
            "reasonKind": info.get("reasonKind"), "clips": list(info.get("animations") or []), "height": info.get("height"),
            "texture": info.get("texture"), "faces_target": info.get("faces"), "bytes": path.stat().st_size,
            "created": info.get("created") or datetime.fromtimestamp(path.stat().st_mtime).isoformat(timespec="seconds"),
            "warnings": [], "missing": False, "recorded": True}


def models(root, context, state, arguments, cancelled):
    project = source_root(context, required=True)
    _check_models(project, state)
    state["view"] = "models"
    present = [m for m in state["models"] if not m.get("missing")]
    if not present:
        return {"ok": True, "models": [], "message": "No model yet. Call images, then generate with an image's path."}
    def describe(m):
        if m.get("external"):
            return f"{m['path']} (made outside this Studio)"
        bones = f"{len(m.get('clips') or [])} animations" if m.get("rigged") else "no skeleton"
        return f"{m['path']} (from {m.get('source')}, {bones}, {size_text(m.get('bytes') or 0)})"
    return {"ok": True, "models": [m["path"] for m in present], "message": "Models: " + "; ".join(describe(m) for m in present) + "."}


def _find_model(project, state, value):
    pure = clean_relative(value, "model")
    text = pure.as_posix()
    for model in state["models"]:
        if model["path"] == text:
            return model
    for model in state["models"]:
        if Path(model["path"]).name == pure.name or model.get("name") == pure.stem:
            return model
    path = project_path(project, text, "model")
    if path.is_file() and path.suffix.lower() == ".glb":
        found = _recorded(project, path)
        if found:
            state["models"].insert(0, found)
            return found
        return {"path": relative_name(project, path), "name": path.stem, "source": None, "external": True, "clips": []}
    raise GeneratorError(f"{text} is not a model in the project. Call models to list them.")


def show(root, context, state, arguments, cancelled):
    project = source_root(context, required=True)
    focus = state["focus"]
    shown = None
    if arguments.get("model"):
        model = _find_model(project, state, arguments["model"])
        path = project_path(project, model["path"], "model")
        if not path.is_file():
            raise GeneratorError(f"{model['path']} no longer exists in the project.")
        views.write_model(root, project, model["path"], path)
        focus["model"] = model["path"]
        shown = model
        if not arguments.get("view"):
            state["view"] = "model"
    if arguments.get("view"):
        state["view"] = arguments["view"]
    if arguments.get("camera"):
        focus["camera"] = arguments["camera"]
    if "bone" in arguments:
        focus["bone"] = arguments["bone"] or None
        if arguments["bone"] and not arguments.get("view"):
            state["view"] = "skeleton"
    note = ""
    if arguments.get("animation"):
        current = shown or next((m for m in state["models"] if m["path"] == focus.get("model")), None)
        clips = (current or {}).get("clips") or []
        if current and clips and arguments["animation"] not in clips:
            note = f" {focus.get('model')} has no animation {arguments['animation']}; it has {', '.join(clips)}."
        else:
            focus["animation"] = arguments["animation"]
            if not arguments.get("view"):
                state["view"] = "animations"
    return {"ok": True, "message": f"The Studio shows the {state['view']} view" + (f" of {focus['model']}" if focus.get("model") else "") + "." + note}


def settings(root, context, state, arguments, cancelled):
    changed = []
    current = state["settings"]
    if "animations" in arguments:
        found, info = _engine(root, state)
        current["animations"] = _animation_names(arguments["animations"], info)
        changed.append("animations")
    for key in ("height", "texture", "faces", "device"):
        if key in arguments:
            current[key] = arguments[key]
            changed.append(key)
    if "folder" in arguments:
        current["folder"] = clean_relative(arguments["folder"], "folder").as_posix()
        changed.append("folder")
    state["view"] = "settings"
    if "device" in arguments:
        state["engine"]["device"] = current["device"]
    summary = (f"height {current['height']} m, texture {current['texture'] or 'off (vertex colours)'}, faces {current['faces']}, "
               f"device {current['device']}, folder {current['folder']}, animations "
               f"{', '.join(current['animations']) if current['animations'] is not None else 'the engine defaults'}")
    return {"ok": True, "settings": current, "message": (f"Changed {', '.join(changed)}. " if changed else "") + f"Defaults now: {summary}."}


# ---------------------------------------------------------------- generate

def _animation_names(names, info):
    available = info.get("animations") or []
    chosen = []
    for name in names or []:
        key = str(name).strip().lower()
        if key in ("default", "padrao", "padrão"):
            chosen += [n for n in info.get("defaults") or [] if n not in chosen]
            continue
        if key in ("none", "nenhuma"):
            continue
        match = key if key in available else next((n for n, label in views.ANIMATION_LABELS.items() if label == key and n in available), None)
        if match is None:
            close = difflib.get_close_matches(key, available, n=3)
            raise GeneratorError(f"There is no animation {name}." + (f" Did you mean {', '.join(close)}?" if close else "") +
                                 " Call animations to list the 24.")
        if match not in chosen:
            chosen.append(match)
    return chosen


def _consented(state, output, arguments, request):
    """overwrite counts only with the user's agreement: words of consent in the request, or a refusal of this same
    file in an earlier request (the user answered it), never a retry inside the request that was refused."""
    question = str(arguments.get("question") or "").lower()
    if any(word in question for word in CONSENT_WORDS):
        return True
    refused = (state.get("refused") or {}).get(output)
    return bool(refused) and (request is None or refused.get("request") != request)


def _plan(project, state, arguments, info, request=None):
    """The images to make, each with its output path and options. Returns (items, blocked, options) where blocked lists
    the files that exist and may not be replaced without asking."""
    settings_ = state["settings"]
    base = {"height": settings_["height"], "texture": settings_["texture"], "faces": settings_["faces"], "rig": True,
            "animations": settings_["animations"] if settings_["animations"] is not None else list(info.get("defaults") or [])}
    replace = False
    model = None
    existing = None
    if arguments.get("model"):
        try:
            model = _find_model(project, state, arguments["model"])
        except GeneratorError:
            if not (arguments.get("path") or arguments.get("paths")):
                raise
            # A model name for a new model, given together with the image: it names the new file.
            arguments = {**arguments, "name": arguments.get("name") or Path(clean_relative(arguments["model"], "model").as_posix()).stem}
    if model is not None:
        if not model.get("source"):
            raise GeneratorError(f"{model['path']} was not made by the 3D Generator, so its image is unknown. Nothing was generated. "
                                 "Ask the user which image to use and whether to replace this file or save under another name.")
        options = {**base, **{k: model[k] for k in ("height", "texture") if model.get(k) is not None}}
        if model.get("faces_target"):
            options["faces"] = model["faces_target"]
        options["animations"] = list(model.get("clips") or []) if model.get("rigged") else options["animations"]
        options["rig"] = model.get("rigged") is not False or arguments.get("rig") is True
        sources = [(model["source"], model["path"])]
        # Making a model again replaces it when the file is exactly what the tool wrote; a file changed since needs consent.
        recorded, pristine = provenance.read(project_path(project, model["path"], "model"))
        existing = recorded
        # Files from before the record existed: one this Studio made, still with the size it had.
        replace = pristine if recorded else (not model.get("external") and _same_bytes(project, model))
    else:
        paths = arguments.get("paths") or ([arguments["path"]] if arguments.get("path") else [])
        if not paths and state["focus"].get("image"):
            paths = [state["focus"]["image"]]
        if not paths:
            raise GeneratorError("Give the image: path (such as arte/heroi.png) or paths. Call images to list the project's images.")
        if arguments.get("name") and len(paths) > 1:
            raise GeneratorError("name works with one image; leave it out when giving several paths.")
        folder = clean_relative(arguments.get("folder") or settings_["folder"], "folder").as_posix()
        sources = []
        for path in paths:
            stem = slug(arguments.get("name") or Path(clean_relative(path, "image").as_posix()).stem)
            sources.append((path, f"{folder}/{stem}.glb"))
        options = dict(base)
        if len(sources) == 1:
            # Making again a file the tool wrote from this same image keeps its options unless new ones are given.
            target = project_path(project, sources[0][1], "model")
            recorded, _ = provenance.read(target) if target.is_file() else (None, False)
            if recorded and recorded.get("source") == relative_name(project, project_path(project, sources[0][0], "image")):
                options.update({key: recorded[key] for key in ("height", "texture", "faces", "rig") if recorded.get(key) is not None})
                if recorded.get("rig"):
                    options["animations"] = list(recorded.get("animations") or [])
                existing = recorded
    if "animations" in arguments:
        options["animations"] = _animation_names(arguments["animations"], info)
    if arguments.get("add"):
        added = _animation_names(arguments["add"], info)
        current = options["animations"]
        have, new = [n for n in added if n in current], [n for n in added if n not in current]
        if "animations" in arguments:
            options["animations"] = current + new
        elif model is None and existing is None:
            # A new model has nothing to add to: the names are its list.
            options["animations"] = added
        elif have and new:
            # Names the model already has mixed with new ones: the whole new list (the Studio's checkboxes).
            options["animations"] = added
        else:
            # Only new names are added; names it already has change nothing.
            options["animations"] = current + new
    for key in ("height", "texture", "faces", "rig"):
        if key in arguments:
            options[key] = arguments[key]
    items, blocked = [], []
    seen = set()
    for source, output in sources:
        image = project_path(project, source, "image")
        if not image.is_file() or image_size(image) is None:
            raise GeneratorError(f"{source} is not a readable image in the project. Call images to list them.")
        target = project_path(project, output, "model")
        relative_output = Path(output).as_posix()
        if relative_output in seen:
            raise GeneratorError(f"Two images would be saved as {relative_output}; give the images different names.")
        seen.add(relative_output)
        if target.exists() and not (replace or (arguments.get("overwrite") and _consented(state, relative_output, arguments, request))):
            blocked.append(relative_output)
            continue
        items.append({"source": relative_name(project, image), "image": image, "output": relative_output, "target": target})
    unchanged = None
    if existing and len(items) == 1 and existing.get("source") == items[0]["source"] and _same_options(existing, options):
        unchanged = items[0]["output"]
    return items, blocked, options, unchanged


def _same_options(recorded, options):
    """Whether making the model again would use exactly the options it was made with."""
    same = all(recorded.get(key) == options[key] for key in ("height", "texture", "faces")) and bool(recorded.get("rig")) == bool(options["rig"])
    return same and (not options["rig"] or list(recorded.get("animations") or []) == list(options["animations"]))


def generate(root, context, state, arguments, cancelled):
    project = source_root(context, required=True)
    found, info = _engine(root, state)
    request = context.get("request_id") if isinstance(context, dict) else None
    items, blocked, options, unchanged = _plan(project, state, arguments, info, request)
    # The same image with the same options gives the same model: no 20 s spent and no file replaced for nothing.
    if unchanged:
        clips = ", ".join(options["animations"]) if options["rig"] else "no skeleton"
        return {"ok": True, "models": [], "message": f"{unchanged} already has exactly these options ({clips}); nothing was generated. "
                                                      "Tell the user, or ask what to change."}
    refused = state.setdefault("refused", {})
    for output in blocked:
        refused[output] = {"request": request, "at": time.time()}
    for item in items:
        refused.pop(item["output"], None)
    if not items:
        state["notice"] = {"kind": "warning", "text": f"{', '.join(blocked)} já existe: responda na conversa se pode substituir.",
                           "at": time.time()}
        asked = " (overwrite needs the user's agreement in a new message; it was not given yet)" if arguments.get("overwrite") else ""
        raise GeneratorError(f"{', '.join(blocked)} already exist{'s' if len(blocked) == 1 else ''}{asked}. Nothing was generated. "
                             "Ask the user whether to replace it or to save under another name, and wait for the answer; when the user agrees, "
                             "call generate again with overwrite true (or with another name).")
    device = arguments.get("device") or state["settings"]["device"]
    job = views.job_start(state, [item["source"] for item in items])
    job["outputs"] = [item["output"] for item in items]
    state["notice"] = None
    checked = read_json(root / views.IMAGE, {}) or {}
    temporaries = []
    requests = []
    for item in items:
        item["target"].parent.mkdir(parents=True, exist_ok=True)
        temporary = item["target"].with_name(f".{item['target'].stem}.generating{os.getpid()}.glb")
        temporaries.append(temporary)
        requests.append({"image": str(item["image"]), "output": str(temporary), "animations": options["animations"] if options["rig"] else [],
                         "height": options["height"], "rig": options["rig"], "faces": options["faces"], "texture": options["texture"]})
    job["steps"] = views.job_steps(options["rig"], options["texture"])
    state["view"] = "model"
    views.save(root, state)
    def on_event(event):
        # A handful of events per image; each one is a step the Studio must show at once, so every one is saved.
        now = time.time()
        if event.get("event") == "item":
            index = int(event.get("index", 0))
            job["index"] = index
            job["current"] = items[index]["source"] if index < len(items) else None
            job["itemStarted"] = now
            job["steps"] = views.job_steps(options["rig"], options["texture"])
        elif event.get("event") == "progress" and event.get("step"):
            views.job_progress(job, event["step"], now)
        job["elapsed"] = round(now - job["started"], 2)
        views.save(root, state)

    timeout = 600 + 300 * (len(items) - 1)
    try:
        answer = engines.call(found, {"action": "generate", "device": device, "items": requests}, on_event=on_event,
                              cancelled=cancelled, timeout=timeout)
    except Cancelled:
        job["state"] = "cancelled"
        job["message"] = "Parado: nada foi salvo."
        _remove(temporaries)
        raise
    except engines.EngineFailed as error:
        job["state"] = "failed"
        job["message"] = str(error)
        _remove(temporaries)
        raise GeneratorError(f"The engine failed: {error} Nothing was saved.") from None
    results = answer.get("items") or []
    lines, saved = [], []
    for item, temporary, result in zip(items, temporaries, results):
        if not result.get("ok"):
            _remove([temporary])
            message = result.get("message") or result.get("kind") or "unknown error"
            job["results"].append({"image": item["source"], "model": None, "state": "failed", "seconds": round(result.get("seconds") or 0, 1),
                                   "message": message})
            lines.append(f"{item['source']}: failed ({message}); nothing saved.")
            continue
        try:
            provenance.stamp(temporary, {"source": item["source"], "rig": bool(result.get("rigged")), "reasonKind": result.get("reasonKind"),
                                         "animations": list(result.get("clips") or []), "height": options["height"],
                                         "texture": options["texture"], "faces": options["faces"],
                                         "created": datetime.now().isoformat(timespec="seconds")})
        except (OSError, ValueError):
            pass
        try:
            os.replace(temporary, item["target"])
        except OSError as error:
            _remove([temporary])
            lines.append(f"{item['source']}: could not save {item['output']} ({error}).")
            continue
        views.job_finish_item(job, result.get("timings"))
        verdict = (checked.get("verdict") or {}) if checked.get("path") == item["source"] else {}
        entry = _register(state, item, result, options, verdict)
        saved.append(entry)
        job["results"].append({"image": item["source"], "model": item["output"], "state": "done" if entry["rigged"] else "static",
                               "seconds": entry["seconds"], "message": entry["reason"]})
        if entry["rigged"]:
            clips = ", ".join(entry["clips"]) or "none"
            text = (f"{item['source']}: saved {item['output']} ({size_text(entry['bytes'])}, {entry['vertices']} vertices, 66 bones, "
                    f"animations {clips}) in {seconds_text(entry['seconds'])}.")
        else:
            reason = entry["reason"] or "without bones, as asked"
            text = f"{item['source']}: saved {item['output']} as a 3D model WITHOUT a skeleton ({reason}) in {seconds_text(entry['seconds'])}."
        if entry["warnings"]:
            text += " Warnings: " + "; ".join(entry["warnings"]) + "."
        lines.append(text)
    job["state"] = "done" if saved else "failed"
    job["elapsed"] = round(time.time() - job["started"], 2)
    if blocked:
        lines.append(f"Not generated because the file exists: {', '.join(blocked)} (ask the user before using overwrite true).")
    if saved:
        last = saved[-1]
        views.write_model(root, project, last["path"], project_path(project, last["path"], "model"))
        state["focus"]["model"] = last["path"]
        state["focus"]["animation"] = (last["clips"] or [None])[0]
        state["view"] = "model"
    _refresh_images(root, project, state, found)
    return {"ok": bool(saved), "models": [entry["path"] for entry in saved], "message": " ".join(lines)}


def _register(state, item, result, options, verdict=None):
    path = item["target"]
    kind = result.get("reasonKind")
    if not kind and not options["rig"]:
        # Made without bones on request: keep the reason the image check found, when there was one.
        kind = (verdict or {}).get("kind")
    reason = views.REASONS.get(kind) if kind else (None if options["rig"] else "sem ossos, como pedido")
    entry = {"path": item["output"], "name": path.stem, "source": item["source"], "rigged": bool(result.get("rigged")),
             "reason": reason, "reasonKind": kind, "clips": list(result.get("clips") or []), "vertices": result.get("vertices"),
             "faces": result.get("faces"), "bytes": path.stat().st_size, "texture": options["texture"], "height": options["height"],
             "faces_target": options["faces"], "seconds": round(float(sum((result.get("timings") or {}).values()) or result.get("seconds") or 0), 1),
             "timings": {k: round(float(v), 2) for k, v in (result.get("timings") or {}).items()}, "devices": result.get("devices") or {},
             "created": datetime.now().isoformat(timespec="seconds"), "warnings": list(result.get("warnings") or []),
             "thumb": result.get("thumb"), "missing": False}
    state["models"] = [m for m in state["models"] if m["path"] != entry["path"]]
    state["models"].insert(0, entry)
    return entry


def _same_bytes(project, model):
    """A model this Studio made and registered before provenance existed counts as unchanged when its size matches."""
    try:
        return project_path(project, model["path"], "model").stat().st_size == model.get("bytes")
    except (OSError, GeneratorError):
        return False


def _remove(paths):
    for path in paths:
        try:
            Path(path).unlink()
        except OSError:
            pass


ACTIONS = {"status": status, "images": images, "open": open_, "generate": generate, "animations": animations, "models": models,
           "show": show, "settings": settings}
