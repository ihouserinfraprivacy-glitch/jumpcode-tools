# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""3D Generator: an image of a character becomes a 3D model (GLB) with a skeleton and animations, made on this computer
by the foto-para-rig engine and shown inside a JumpCode Studio."""

import base64
from importlib.resources import files
import json

from .common import GeneratorError

MAX_MARK_BYTES = 16 * 1024
MAX_COVER_BYTES = 300 * 1024


def _asset(name, mime, limit):
    """A bundled image as a data URL, or None when the file is not shipped."""
    resource = files(__package__).joinpath("assets").joinpath(name)
    if not resource.is_file():
        return None
    data = resource.read_bytes()
    if len(data) > limit:
        raise GeneratorError(f"assets/{name} is larger than {limit // 1024} KB")
    return f"data:{mime};base64," + base64.b64encode(data).decode("ascii")


MANIFEST = json.loads(files(__package__).joinpath("tool.json").read_text(encoding="utf-8"))
for _key, _name, _mime, _limit in (("mark", "mark.svg", "image/svg+xml", MAX_MARK_BYTES),
                                   ("cover", "cover.png", "image/png", MAX_COVER_BYTES)):
    _value = _asset(_name, _mime, _limit)
    if _value:
        MANIFEST["studio"][_key] = _value
del _key, _name, _mime, _limit, _value

from .actions import run  # noqa: E402  (the actions read MANIFEST through arguments)
from .arguments import validate  # noqa: E402


def studio_ui():
    """The Studio interface that JumpCode loads into its webview: three.js first, then the tool's own script."""
    try:
        folder = files(__package__).joinpath("ui")
        three = folder.joinpath("three.min.js").read_text(encoding="utf-8")
        script = folder.joinpath("app.js").read_text(encoding="utf-8")
        return {"css": folder.joinpath("app.css").read_text(encoding="utf-8"), "js": three + "\n;\n" + script}
    except (OSError, UnicodeError) as error:
        raise GeneratorError("The 3D Generator interface files are missing") from error


__all__ = ["MANIFEST", "GeneratorError", "validate", "run", "studio_ui"]
