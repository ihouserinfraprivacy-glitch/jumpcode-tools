# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Host approval of a specific plan snapshot, independent of prompt wording."""
import hashlib
import json

from .common import TaskStudioError, locked, studio_root
from .studio import Studio


def approval(studio, args):
    action = args["action"]
    if action not in ("apply", "resolve", "start", "finish"):
        return None
    plan = studio.plan(required=False)
    if action not in ("apply", "resolve") and not (action in ("start", "finish") and plan and not plan["started"]):
        return None
    proposal = studio.proposal(strict=True) if action == "apply" else None
    if action == "apply" and not proposal:
        return None  # The handler reports the missing proposal without asking for consent.
    if not plan:
        return None
    snapshot = {"plan": plan, "proposal": proposal, "arguments": args}
    fingerprint = hashlib.sha256(json.dumps(snapshot, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()
    return {"title": {"apply": "Aplicar mudanças no plano", "resolve": "Confirmar condição da tarefa"}.get(action, "Iniciar o plano"),
            "fingerprint": fingerprint, **snapshot}


def check_effect(context):
    """A pending plan change is a host boundary, including for file/terminal/MCP effects."""
    root = studio_root(context)
    with locked(root):
        studio = Studio(root, context, "")
        plan = studio.plan(required=False)
        if plan and not plan["started"]:
            raise TaskStudioError("The initial plan awaits approval. Start it through the approval control before changing project files or running actions.")
        if plan and (plan["recalibrating"] or studio.proposal(strict=True)):
            raise TaskStudioError("A plan change awaits approval. Apply or discard it before changing project files or running actions.")
