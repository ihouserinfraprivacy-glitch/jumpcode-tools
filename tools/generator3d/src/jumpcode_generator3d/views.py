# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""The Studio files: state.json (engine, settings, images, models, the running job and what to show), image.json (the
checked image) and model.json (the model shown, as base64). See CONTRACT.md."""

import base64
import time

from .common import read_json, write_json

STATE = "state.json"
IMAGE = "image.json"
MODEL = "model.json"
MAX_MODEL_BYTES = 30_000_000
VIEWS = ("start", "image", "model", "skeleton", "animations", "models", "settings")
DEFAULT_SETTINGS = {"height": 1.7, "texture": 1024, "faces": 20000, "device": "auto", "folder": "modelos", "animations": None}

STEPS = (("background", "Remover o fundo"), ("encode", "Forma 3D (TripoSR)"), ("mesh", "Montar a malha"), ("simplify", "Simplificar"),
         ("pose", "Achar as juntas"), ("rig", "Ossos e pesos"), ("clips", "Copiar animações"), ("texture", "Textura"),
         ("write", "Gravar o GLB"))
# fotorig's timing names, folded into the Studio's steps.
TIMING_STEPS = {"background": "background", "encode": "encode", "release_encoder": "encode", "mesh": "mesh", "simplify": "simplify",
                "pose": "pose", "rig": "rig", "load_clips": "clips", "texture": "texture", "write": "write"}

ANIMATION_LABELS = {
    "walk": "andar", "walk-female": "andar 2", "jog": "trotar", "run-anime": "correr", "run-female": "correr 2", "sprint": "disparar",
    "idle-a": "parado", "idle-subtle": "parado, leve", "greeting": "acenar", "dance-simple": "dançar", "dance-charleston": "charleston",
    "jump-2": "pular", "victory": "comemorar", "clapping": "bater palmas", "yes": "dizer sim", "reject": "dizer não", "punch-jab": "soco",
    "kick-front": "chute", "fighting-idle": "em guarda", "crouch-idle": "agachado", "sitting-idle": "sentado", "pick-up": "pegar do chão",
    "death-a": "cair", "rest-pose": "pose de descanso",
}
KEYPOINT_LABELS = {
    "nose": "nariz", "left_eye": "olho esquerdo", "right_eye": "olho direito", "left_ear": "orelha esquerda", "right_ear": "orelha direita",
    "left_shoulder": "ombro esquerdo", "right_shoulder": "ombro direito", "left_elbow": "cotovelo esquerdo", "right_elbow": "cotovelo direito",
    "left_wrist": "pulso esquerdo", "right_wrist": "pulso direito", "left_hip": "quadril esquerdo", "right_hip": "quadril direito",
    "left_knee": "joelho esquerdo", "right_knee": "joelho direito", "left_ankle": "tornozelo esquerdo", "right_ankle": "tornozelo direito",
}
REASONS = {
    "NotFullBodyError": "a imagem não mostra um corpo inteiro (quadris, joelhos e pés precisam aparecer)",
    "NotHumanoidError": "não encontrei uma pessoa ou personagem humanoide (animais ficam para outra versão)",
}


def load(root):
    state = read_json(root / STATE, {}) or {}
    state.setdefault("version", 1)
    state.setdefault("engine", {"ready": False, "problem": None, "fix": None, "animations": []})
    settings = {**DEFAULT_SETTINGS, **(state.get("settings") or {})}
    state["settings"] = settings
    if state.get("view") not in VIEWS:
        state["view"] = "start"
    state.setdefault("focus", {"image": None, "model": None, "animation": None, "bone": None, "camera": "front"})
    state.setdefault("images", [])
    state.setdefault("imagesMore", 0)
    state.setdefault("models", [])
    state.setdefault("job", None)
    state.setdefault("notice", None)
    return state


def save(root, state):
    state["updated"] = time.time()
    write_json(root / STATE, {**state, "job": public_job(state.get("job"))})


def engine_view(info=None, problem=None, fix=None, device="auto"):
    if problem:
        return {"ready": False, "problem": problem, "fix": fix, "animations": [], "device": device, "devices": None, "version": None}
    providers = (info or {}).get("providers") or []
    gpu = "DmlExecutionProvider" in providers or "CUDAExecutionProvider" in providers
    return {"ready": True, "problem": None, "fix": None, "version": (info or {}).get("version"), "device": device,
            "devices": "placa de vídeo (DirectML) ou processador" if gpu else "processador",
            "animations": [{"id": name, "label": ANIMATION_LABELS.get(name, name)} for name in (info or {}).get("animations", [])],
            "defaults": list((info or {}).get("defaults") or [])}


def job_start(state, images):
    now = time.time()
    state["job"] = {"id": f"{int(now * 1000):x}", "state": "running", "images": list(images), "index": 0, "total": len(images),
                    "current": images[0] if images else None, "started": now, "itemStarted": now, "elapsed": 0.0, "steps": [],
                    "results": [], "message": None}
    return state["job"]


def job_steps(rig, texture):
    skipped = set()
    if not rig:
        skipped |= {"pose", "rig", "clips"}
    if not texture:
        skipped.add("texture")
    return [{"key": key, "label": label, "state": "skipped" if key in skipped else "waiting", "seconds": None} for key, label in STEPS]


def job_progress(job, key, now):
    """Marks ``key`` as running and every earlier step as done, with the time each took."""
    steps = job["steps"]
    keys = [step["key"] for step in steps]
    if key not in keys:
        return
    position = keys.index(key)
    for step in steps[:position]:
        if step["state"] == "running":
            step["state"] = "done"
            step["seconds"] = round(now - step.pop("_since", now), 2)
        elif step["state"] == "waiting":
            step["state"] = "done"
    current = steps[position]
    if current["state"] != "running":
        current["state"] = "running"
        current["_since"] = now
    job["elapsed"] = round(now - job["started"], 2)


def job_finish_item(job, timings):
    """The real times from the engine, once an image is done."""
    totals = {}
    for name, seconds in (timings or {}).items():
        step = TIMING_STEPS.get(name)
        if step:
            totals[step] = totals.get(step, 0.0) + float(seconds)
    for step in job["steps"]:
        step.pop("_since", None)
        if step["key"] in totals:
            step["state"] = "done"
            step["seconds"] = round(totals[step["key"]], 2)
        else:
            step["state"] = "skipped"
            step["seconds"] = None


def public_job(job):
    """The job without the private timing marks."""
    if not job:
        return job
    copy = dict(job)
    copy["steps"] = [{k: v for k, v in step.items() if not k.startswith("_")} for step in job.get("steps", [])]
    return copy


def write_image(root, data):
    write_json(root / IMAGE, data or {})


def write_model(root, project, relative, path):
    """The model the Studio shows: the GLB as base64, or a note that it is too large."""
    try:
        size = path.stat().st_size
    except OSError:
        write_json(root / MODEL, {})
        return False
    if size > MAX_MODEL_BYTES:
        write_json(root / MODEL, {"path": relative, "bytes": size, "glb": None, "tooLarge": True})
        return False
    data = path.read_bytes()
    write_json(root / MODEL, {"path": relative, "bytes": size, "glb": base64.b64encode(data).decode("ascii")})
    return True


def clear_model(root):
    write_json(root / MODEL, {})
