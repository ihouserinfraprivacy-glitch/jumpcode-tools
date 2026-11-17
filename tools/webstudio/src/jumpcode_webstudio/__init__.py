# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""WebStudio: builds a static site live inside a JumpCode Studio."""

from importlib.resources import files
import json

from .site import WebStudioError, validate, run

MANIFEST = json.loads(files(__package__).joinpath("tool.json").read_text(encoding="utf-8"))

__all__ = ["MANIFEST", "WebStudioError", "validate", "run"]
