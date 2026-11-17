<!-- Copyright (c) Microsoft Corporation. All rights reserved. -->
<!-- Licensed under the MIT License. See LICENSE in the project root. -->

# 3D Generator contract

The 3D Generator is a self-contained JumpCode tool: one image of a character
becomes a 3D model (GLB) with a skeleton and animations, shown in a Studio
beside the chat. It has four parts that only meet through the files and
messages described here:

1. **Python package** `jumpcode_generator3d` (`src/jumpcode_generator3d/`): the
   actions the model calls (`actions.py`), argument checks (`arguments.py`),
   the engine adapter (`engine/`) and the Studio files (`views.py`). Standard
   library only; it runs inside the agent's process.
2. **Engine**: the foto-para-rig program (TripoSR in ONNX, background removal,
   RTMPose, the Mesh2Motion skeleton and animations), installed on this
   computer outside JumpCode with its own Python, NumPy, SciPy and ONNX Runtime.
   The package never imports it. `engine/runner.py` is started with the
   engine's own interpreter, one process per call, and talks JSON lines.
3. **Studio interface** (`src/jumpcode_generator3d/ui/`): `three.min.js`
   (three.js with GLTFLoader and OrbitControls, built by
   `ui-dev/build-three.mjs`), `app.js` and `app.css`. No network.
4. **JumpCode host** (outside this folder): generic Studio hosting. It knows
   nothing about 3D; it only moves Studio files and chat messages.

The interface never writes files and never reaches the tool. Every action the
user takes in it becomes a chat message (`ask`) that the model carries out.

## Folders the tool may touch

`run(arguments, context, cancelled=None)` receives:

- `context["studio_root"]`: this Studio's folder. The Studio files, the job log
  and the image cache live here.
- `context["source_root"]`: the conversation's project folder. Images are read
  from it by relative path (never outside it, never through a link). Models are
  written into it (default `modelos/<image name>.glb`). An existing file is
  replaced only with `overwrite: true`, which the model sends only after the
  user agreed.

## Finding the engine

In order, the first that has `fotorig/`, the models and an interpreter:

1. the folder in the environment variable `JUMPCODE_GENERATOR3D_ENGINE`;
2. `%LOCALAPPDATA%\JumpCode\tools\generator3d\engine.json` with
   `{"root": "<folder>"}`;
3. `%LOCALAPPDATA%\JumpCode\tools\generator3d\engine\` (the extracted Windows
   package of foto-para-rig, `foto-para-rig\` inside it is also accepted).

The interpreter is `python.exe` in the root (Windows package) or
`.venv\Scripts\python.exe` (development folder). Without an engine every
action that needs it answers with what is missing; `status` and `images` still
work.

## Runner protocol

`python -B -s runner.py` with one JSON object on stdin:
`{"action": "info"|"check"|"generate"|"thumbs", ...}`. Each stdout line is
one JSON object: `{"event": "progress", "step": key, "image": index}`,
`{"event": "result", ...}` or `{"event": "error", "kind": ..., "message": ...}`.
The adapter kills the process tree when the turn is cancelled or the time limit
passes.

## Replacing a file

`generate` never replaces a file on its own. `overwrite: true` counts only with
the user's agreement: words of consent in `question` ("pode substituir",
"sobrescrever", "replace"), or a refusal of that same file in an earlier
request (`context["request_id"]` differs), which means the user was asked and
answered. Making a model again with `model` replaces it without asking only
when the file is still exactly what the tool wrote.

Each GLB records where it came from in `asset.extras.jumpcode`: the tool, the
source image, the options (`rig`, `animations`, `height`, `texture`, `faces`),
the reason it has no skeleton and the SHA-256 of its binary chunk. Any Studio of
the project can make it again from that record, and the hash tells whether the
file was changed since.

## Studio files

All JSON, written atomically into the Studio folder.

### `state.json`

```json
{
  "version": 1,
  "updated": 1763140000.0,
  "engine": {"ready": true, "device": "auto", "devices": "placa de vídeo (DirectML)", "version": "0.1.0",
             "problem": null, "fix": null,
             "animations": [{"id": "walk", "label": "andar"}],
             "defaults": ["idle-a", "walk", "jog", "jump-2", "greeting", "dance-simple"]},
  "settings": {"height": 1.7, "texture": 1024, "faces": 20000, "device": "auto", "folder": "modelos",
               "animations": ["walk", "greeting", "dance-simple", "jump-2"]},
  "view": "start | image | model | skeleton | animations | models | settings",
  "focus": {"image": "arte/jay.png", "model": "modelos/jay.glb", "animation": "walk", "bone": null, "camera": "front"},
  "images": [{"path": "arte/jay.png", "bytes": 139013, "width": 1024, "height": 1024,
              "thumb": "data:image/png;base64,...", "model": "modelos/jay.glb"}],
  "imagesMore": 0,
  "models": [{"path": "modelos/jay.glb", "name": "jay", "source": "arte/jay.png", "rigged": true,
              "reason": null, "reasonKind": null, "clips": ["walk"], "vertices": 12882, "faces": 19871,
              "bytes": 1690664, "texture": 1024, "height": 1.7, "seconds": 15.1,
              "timings": {"background": 0.4}, "devices": {"encoder": "dml"},
              "created": "2026-11-14T17:19:00", "warnings": [], "thumb": "data:...", "missing": false}],
  "job": {"id": "a1b2", "state": "running | done | failed | cancelled", "images": ["arte/jay.png"],
          "index": 0, "total": 1, "current": "arte/jay.png", "started": 1763140000.0,
          "itemStarted": 1763140007.2, "elapsed": 11.9, "outputs": ["modelos/jay.glb"],
          "steps": [{"key": "background", "label": "Remover o fundo", "state": "done | running | waiting | skipped", "seconds": 0.4}],
          "results": [{"image": "arte/jay.png", "model": "modelos/jay.glb", "state": "done | failed | static", "seconds": 7.2, "message": null}],
          "message": null},
  "notice": {"kind": "info | warning", "text": "...", "at": 1763140000.0}
}
```

- `engine.problem` is a pt-BR sentence when the engine is missing or broken;
  `engine.fix` says what to do.
- `reasonKind` is `NotFullBodyError` or `NotHumanoidError` when a model was
  saved without a skeleton; `reason` is the sentence to show.
- `settings.animations` is `null` while the user keeps the engine's defaults
  (`engine.defaults`).
- A GLB found in the models folder that this Studio did not make has
  `"external": true`, `rigged: null` and no `source`.
- `updated` is written on every save, so the interface can count the seconds
  of a running job from `elapsed` and `updated`; `itemStarted` is when the
  current image of a queue began.
- `job` is `null` when nothing ran in this Studio yet. `steps` keys, in order:
  `background`, `encode`, `mesh`, `simplify`, `pose`, `rig`, `clips`,
  `texture`, `write`.

### `image.json`

The image being prepared (written by `open`; `{}` when none):

```json
{"path": "arte/jay.png", "size": [1024, 1024], "seconds": 1.4,
 "original": "data:image/png;base64,...", "prepared": "data:image/png;base64,...",
 "keypoints": [{"name": "nose", "label": "nariz", "u": 256, "v": 196, "score": 0.59}],
 "verdict": {"rig": true, "kind": null, "reason": null},
 "checks": [{"key": "humanoid", "label": "Personagem humanoide", "ok": true, "detail": "..."}]}
```

Keypoint coordinates are in the 512 × 512 prepared image. A score under 0.3,
or a point outside the 512 × 512 square, means the point is not in the image;
under 0.5 it is doubtful. The interface draws the points itself.

### `model.json`

The model shown in the Studio: `{"path": "modelos/jay.glb", "bytes": 1690664,
"glb": "<base64 of the GLB>"}`, or `{}` when none. Models above 30 MB are not
sent (`"glb": null, "tooLarge": true`).

The GLB is glTF 2.0: one skinned mesh (POSITION, NORMAL, COLOR_0 or TEXCOORD_0
with an embedded PNG texture, JOINTS_0, WEIGHTS_0), the 66-bone Mesh2Motion
human skeleton (names such as `pelvis`, `spine_01`, `upperarm_l`), the
animations by name, Y up, metres. Static models have no skin and no
animations. The webview's policy allows images only from `data:` URLs, so the
interface loads embedded textures through a GLTFLoader plugin that turns the
PNG bytes into a data URL.

## Messages

The interface uses the host's generic messages (`ready`, `ask`, `stop`,
`focus`; it receives `init`, `files`, `running`, `request`, `context`,
`filesError`). Its buttons only fill or send chat requests in pt-BR, such as
"Gere o modelo 3D de arte/jay.png com as animações walk e greeting."
