<!-- Copyright (c) Microsoft Corporation. All rights reserved. -->
<!-- Licensed under the MIT License. See LICENSE in the project root. -->

# 3D Generator

The 3D Generator is a JumpCode tool that turns an image of a character into a
3D model (GLB) with a 66-bone skeleton and animations, on the user's computer,
and shows it in a Studio beside the chat. The user asks in the chat ("transforme
o desenho do herói em 3D com animação de andar"); the agent checks the image,
generates the model and the Studio shows it turning, its skeleton, what each
bone moves and the animations playing.

## The engine

The heavy work is done by **foto-para-rig**, a separate program installed on
the computer (about 1.1 GB with its models): background removal (u2netp),
TripoSR exported to ONNX, RTMPose-m for the 17 body points, the Mesh2Motion
human skeleton and animations (CC0) and Pinocchio-style skin weights. It needs
NumPy, SciPy and ONNX Runtime (DirectML on Windows), which the agent's Python
does not have, so the tool never imports it: `engine/runner.py` is started with
the engine's own interpreter for each call and answers in JSON lines. A turn
cancelled in the chat stops the process tree, and nothing half-written is left
in the project (the GLB is written under a hidden name and renamed at the end).

Where the engine is looked for is in [CONTRACT.md](CONTRACT.md): the
`JUMPCODE_GENERATOR3D_ENGINE` variable, a pointer file
`%LOCALAPPDATA%\JumpCode\tools\generator3d\engine.json`, or the extracted
Windows package in `%LOCALAPPDATA%\JumpCode\tools\generator3d\engine\`. Without
it, the Studio and the agent say what is missing; listing images still works.

## What the agent can do

- `images` and `open`: the project's images, and the check of one (body points
  with their scores, full body, humanoid), before spending time generating.
- `generate`: one image or several in a row (the engine keeps its models
  loaded between them), with animations, height, texture (1024 copies the
  image's colours; 0 is faster), triangle count, with or without bones, on the
  graphics card or the processor. An existing file is never replaced unless the
  user agreed: `overwrite` counts only after the user was asked in an earlier
  message or with words of consent in the request. `model` makes an existing
  model again with new animations or options; it replaces the file without
  asking only when the file is still exactly what the tool wrote. Each GLB keeps
  its source image and options in `asset.extras.jumpcode`, so any conversation
  of the project can make it again.
- `show`, `models`, `animations` and `settings` for the Studio.

Busts, animals and objects are saved as a 3D model without bones, with the
reason. Times on a Ryzen 7 with an RTX 2050: 7 to 10 s without texture, 15 to
18 s with a 1024 texture; about 20 to 25 s on the processor only.

## Studio

`ui/app.js` and `ui/app.css` are the interface; `ui/three.min.js` is three.js
0.187.0 (MIT, license in the file's header) with GLTFLoader and OrbitControls,
rebuilt with `node ui-dev/build-three.mjs <folder with node_modules/three>`.
The webview has no network and accepts images only as `data:` URLs, so the GLB
travels as base64 inside `model.json` and its texture is loaded by a small
GLTFLoader plugin. Every button in the Studio becomes a chat request that the
agent carries out.

## Tests

`python -m unittest discover -s tests` from this folder. The tests use a
stand-in engine; the last class runs the real foto-para-rig when it is
installed (`JUMPCODE_GENERATOR3D_ENGINE`, or `C:\Projects\foto-para-rig`).
