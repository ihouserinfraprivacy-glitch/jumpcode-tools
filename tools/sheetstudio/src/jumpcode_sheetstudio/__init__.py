# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""SheetStudio: the project's spreadsheets (CSV, TSV, XLSX, XLS, ODS) read on this computer, with the numbers and
charts the agent makes shown inside a JumpCode Studio."""

import base64
from importlib.resources import files
import json

from .common import SheetStudioError

MAX_MARK_BYTES = 16 * 1024
MAX_COVER_BYTES = 300 * 1024


def _asset(name, mime, limit):
    """A bundled image as a data URL, or None when the file is not shipped."""
    resource = files(__package__).joinpath("assets").joinpath(name)
    if not resource.is_file():
        return None
    data = resource.read_bytes()
    if len(data) > limit:
        raise SheetStudioError(f"assets/{name} is larger than {limit // 1024} KB")
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
    """The Studio interface (plain CSS and JavaScript) that JumpCode loads into its webview."""
    try:
        folder = files(__package__).joinpath("ui")
        return {"css": folder.joinpath("app.css").read_text(encoding="utf-8"),
                "js": folder.joinpath("app.js").read_text(encoding="utf-8")}
    except (OSError, UnicodeError) as error:
        raise SheetStudioError("The SheetStudio interface files are missing") from error


__all__ = ["MANIFEST", "SheetStudioError", "validate", "run", "studio_ui"]
