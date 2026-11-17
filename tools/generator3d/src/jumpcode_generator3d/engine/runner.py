# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Runs inside the foto-para-rig engine's own Python (never inside the agent): reads one JSON request from stdin,
answers with JSON lines on stdout (progress, then a result or an error).

Actions: info (version, animations, devices), check (background removal, the 17 body points and whether a skeleton
fits), generate (one or more images to GLB files) and thumbs (small previews of images)."""

import base64
import io
import json
import os
import sys
import time
import traceback

OUT = sys.stdout
# Anything the libraries print goes to stderr, so stdout carries only this protocol's lines.
sys.stdout = sys.stderr

STEPS = (("removendo o fundo", "background"), ("gerando o 3d", "encode"), ("montando a malha", "mesh"),
         ("limpando e simplificando", "simplify"), ("achando as juntas", "pose"), ("colocando os ossos", "rig"),
         ("criando a textura", "texture"), ("gravando o glb", "write"))


def emit(event):
    OUT.write(json.dumps(_plain(event), ensure_ascii=False) + "\n")
    OUT.flush()


def _plain(value):
    """JSON-safe copy: NumPy numbers and arrays, paths and tuples become plain values."""
    if isinstance(value, dict):
        return {str(key): _plain(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(item) for item in value]
    if isinstance(value, (str, bool)) or value is None:
        return value
    if isinstance(value, int):
        return int(value)
    if isinstance(value, float):
        return round(value, 6)
    if hasattr(value, "tolist"):
        return _plain(value.tolist())
    if hasattr(value, "__fspath__"):
        return os.fspath(value)
    try:
        return round(float(value), 6)
    except (TypeError, ValueError):
        return str(value)


def step_of(message):
    lower = str(message).lower()
    for prefix, key in STEPS:
        if lower.startswith(prefix):
            return key
    return None


def data_url(image, kind="PNG", max_side=None, quality=85):
    from PIL import Image
    if max_side and max(image.size) > max_side:
        image = image.copy()
        image.thumbnail((max_side, max_side), Image.LANCZOS)
    buffer = io.BytesIO()
    if kind == "JPEG":
        image.convert("RGB").save(buffer, "JPEG", quality=quality, optimize=True)
        mime = "image/jpeg"
    else:
        image.save(buffer, "PNG", optimize=True)
        mime = "image/png"
    return f"data:{mime};base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def picture(path, max_side):
    """A preview of an image file: PNG when it has transparency, JPEG otherwise."""
    from PIL import Image, ImageOps
    with Image.open(path) as source:
        source = ImageOps.exif_transpose(source)
        size = source.size
        transparent = source.mode in ("RGBA", "LA", "PA") or (source.mode == "P" and "transparency" in source.info)
        image = source.convert("RGBA" if transparent else "RGB")
    if transparent and image.getextrema()[3][0] == 255:
        image, transparent = image.convert("RGB"), False
    if max(image.size) > max_side:
        image.thumbnail((max_side, max_side), Image.LANCZOS)
    return data_url(image, "PNG" if transparent else "JPEG"), size


def info(request):
    import fotorig
    from fotorig import gltf
    try:
        import onnxruntime
        providers = onnxruntime.get_available_providers()
    except Exception:
        providers = []
    return {"version": getattr(fotorig, "__version__", None), "animations": gltf.list_animations(),
            "defaults": list(gltf.DEFAULT_CLIPS), "providers": providers, "python": sys.version.split()[0]}


def check(request):
    from fotorig import background, pose, rig
    started = time.perf_counter()
    path = request["image"]
    original, size = picture(path, 768)
    prepared = background.prepare(path)
    keypoints = pose.detect(prepared, device=request.get("device", "auto"))
    verdict = {"rig": True, "kind": None, "detail": None}
    try:
        rig.check_keypoints(keypoints, mask=prepared.mask)
    except rig.RigError as error:
        verdict = {"rig": False, "kind": type(error).__name__, "detail": str(error)}
    mask = prepared.mask
    filled = float((mask > 0).mean()) if mask is not None else None
    return {"size": list(size), "original": original, "prepared": data_url(prepared.image.convert("RGB"), "PNG"),
            "keypoints": [{"name": name, "u": float(u), "v": float(v), "score": float(score)}
                          for name, (u, v, score) in zip(pose.KEYPOINT_NAMES, keypoints)],
            "verdict": verdict, "filled": filled, "seconds": time.perf_counter() - started}


def generate(request):
    import fotorig
    items = request["items"]
    device = request.get("device", "auto")
    results = []
    worker = None
    if hasattr(fotorig, "Pipeline"):
        worker = fotorig.Pipeline(device=device, keep_encoder=len(items) > 1)
    try:
        for index, item in enumerate(items):
            emit({"event": "item", "index": index, "image": item["image"]})
            started = time.perf_counter()

            def progress(message, index=index):
                emit({"event": "progress", "index": index, "step": step_of(message), "message": str(message)})

            options = {"animations": item.get("animations"), "height": item.get("height", 1.7), "make_rig": item.get("rig", True),
                       "faces": item.get("faces", 20000), "resolution": item.get("resolution", 256), "progress": progress}
            if item.get("texture"):
                options["texture_resolution"] = item["texture"]
            try:
                if worker is not None:
                    result = worker.run(item["image"], item["output"], **options)
                else:
                    result = fotorig.run(item["image"], item["output"], device=device, **options)
                thumb = None
                try:
                    thumb, _ = picture(item["image"], 200)
                except Exception:
                    pass
                results.append({"index": index, "ok": True, "image": item["image"], "output": str(result.output),
                                "rigged": bool(result.rigged), "reason": result.reason, "reasonKind": result.reason_kind,
                                "clips": list(result.clips), "vertices": result.vertices, "faces": result.faces,
                                "timings": dict(result.timings), "devices": dict(result.devices),
                                "warnings": [str(w) for w in result.warnings],
                                "keypoints": None if result.keypoints is None else result.keypoints,
                                "seconds": time.perf_counter() - started, "thumb": thumb})
            except Exception as error:
                results.append({"index": index, "ok": False, "image": item["image"], "kind": type(error).__name__,
                                "message": str(error) or type(error).__name__, "seconds": time.perf_counter() - started})
            emit({"event": "done", "index": index, "ok": results[-1]["ok"]})
    finally:
        if worker is not None:
            worker.close()
    return {"items": results}


def thumbs(request):
    found = []
    for path in request.get("paths", [])[:200]:
        try:
            thumb, size = picture(path, int(request.get("size", 128)))
            found.append({"path": path, "thumb": thumb, "size": list(size)})
        except Exception as error:
            found.append({"path": path, "thumb": None, "error": type(error).__name__})
    return {"thumbs": found}


ACTIONS = {"info": info, "check": check, "generate": generate, "thumbs": thumbs}


def main():
    try:
        request = json.loads(sys.stdin.buffer.read().decode("utf-8"))
        if not isinstance(request, dict) or request.get("action") not in ACTIONS:
            raise ValueError("unknown request")
    except Exception as error:
        emit({"event": "error", "kind": "BadRequest", "message": f"The engine received a bad request ({error})."})
        return 2
    root = request.get("engine_root")
    if root and root not in sys.path:
        sys.path.insert(0, root)
    try:
        result = ACTIONS[request["action"]](request)
    except Exception as error:
        emit({"event": "error", "kind": type(error).__name__, "message": str(error) or type(error).__name__,
              "trace": traceback.format_exc()[-3000:]})
        return 1
    emit({"event": "result", **result})
    return 0


if __name__ == "__main__":
    sys.exit(main())
