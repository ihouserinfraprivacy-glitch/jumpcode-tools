# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Serializable scheduled operations, resolved against the current gateway state."""

import math
import time


def validate(items):
    for item in items:
        action = item.get("action") if isinstance(item, dict) else None
        if (not isinstance(action, dict) or action.get("kind") not in ("pay", "refund", "dispute")
                or action.get("gateway") not in ("pix", "mercadopago", "stripe") or not isinstance(action.get("ref"), str)
                or not isinstance(item.get("due"), (float, int)) or not math.isfinite(item["due"])
                or not isinstance(item.get("label"), str)
                or (action["kind"] == "refund" and not isinstance(action.get("refund_id"), str))):
            raise ValueError("Invalid saved PayStudio operation. The original state was preserved.")


def recover_refunds(state):
    """Recover old persistent states whose pending Pix refunds had only an in-memory callback."""
    for record in state["pix"]["pix"].values():
        for refund in record.get("devolucoes", []):
            action = {"kind": "refund", "gateway": "pix", "ref": record["endToEndId"], "refund_id": refund["id"]}
            if refund.get("status") == "EM_PROCESSAMENTO" and not any(j["action"] == action for j in state["scheduled"]):
                state["scheduled"].append({"action": action, "due": time.time(), "label": f"concluir devolução {refund['id']}", "ref": record["txid"]})


def execute(gw, action):
    from . import mercadopago, pix, stripe
    gateway, kind, ref = action["gateway"], action["kind"], action["ref"]
    if kind == "pay" and gateway in ("pix", "mercadopago"):
        module = pix if gateway == "pix" else mercadopago
        payment = module.find(gw, ref)
        if payment and payment["status"] in ("ATIVA", "pending", "in_process"):
            module.pay(gw, ref, by="cenário")
    elif kind == "refund" and gateway == "pix":
        pix.finish_refund(gw, ref, action["refund_id"])
    elif kind == "dispute" and gateway == "stripe":
        intent = stripe.space(gw)["intents"].get(ref)
        if intent and intent["status"] == "succeeded" and not intent.get("dispute"):
            stripe.dispute(gw, intent)
    else:
        raise ValueError("Unsupported scheduled operation")
