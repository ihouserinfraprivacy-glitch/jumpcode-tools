# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Scenarios: rules that change what happens to the next charges and webhooks (pay later, expire sooner,
decline, late, duplicated, out of order, wrong signature) and failure controls for the gateway itself."""

import random
import time

from . import wire

PAYMENT_KINDS = ("pay_after", "expire_after", "decline", "pending")
WEBHOOK_KINDS = ("delay", "duplicate", "out_of_order", "wrong_signature")
FAILURE_MODES = ("unavailable", "slow", "timeout", "rate_limit", "refuse")
GATEWAY_NAMES = ("pix", "mercadopago", "stripe", "any")
DECLINES = {"generic": ("card_declined", "generic_decline", "cc_rejected_other_reason"),
            "insufficient_funds": ("card_declined", "insufficient_funds", "cc_rejected_insufficient_amount"),
            "expired_card": ("expired_card", "expired_card", "cc_rejected_bad_filled_date"),
            "incorrect_cvc": ("incorrect_cvc", "incorrect_cvc", "cc_rejected_bad_filled_security_code"),
            "call_for_authorize": ("card_declined", "call_issuer", "cc_rejected_call_for_authorize")}

# Ready-made scenarios: each becomes one or more rules or failures.
PRESETS = {
    "pix_pago": ("Pix pago em 5 s", [("pix", "pay_after", {"seconds": 5})]),
    "pix_atrasado_duplicado": ("Pix pago, webhook 2 min atrasado e duplicado",
                               [("pix", "pay_after", {"seconds": 5}), ("pix", "delay", {"seconds": 120}), ("pix", "duplicate", {"copies": 2})]),
    "pix_expira": ("Pix vence em 30 s sem pagamento", [("pix", "expire_after", {"seconds": 30})]),
    "webhook_duplicado": ("Próximo webhook chega duas vezes", [("any", "duplicate", {"copies": 2})]),
    "webhook_atrasado": ("Próximo webhook chega 2 min depois", [("any", "delay", {"seconds": 120})]),
    "webhook_fora_de_ordem": ("Webhooks da próxima cobrança fora de ordem", [("any", "out_of_order", {})]),
    "assinatura_errada": ("Próximo webhook com assinatura errada", [("any", "wrong_signature", {})]),
    "cartao_recusado": ("Próximo cartão recusado", [("any", "decline", {"reason": "generic"})]),
    "sem_saldo": ("Próximo cartão sem saldo", [("any", "decline", {"reason": "insufficient_funds"})]),
    "gateway_fora_do_ar": ("Gateway responde 503 nas próximas 5 chamadas", [("any", "failure", {"mode": "unavailable", "calls": 5})]),
    "gateway_lento": ("Gateway leva 8 s nas próximas 5 chamadas", [("any", "failure", {"mode": "slow", "latency_ms": 8000, "calls": 5})]),
}


def _match(rule_gateway, gateway):
    return rule_gateway in ("any", gateway)


def add_rule(gw, gateway, kind, params=None, times=1, label=None):
    if gateway not in GATEWAY_NAMES:
        raise ValueError(f"gateway must be one of {', '.join(GATEWAY_NAMES)}")
    if kind == "failure":
        return add_failure(gw, gateway, **(params or {}))
    if kind not in PAYMENT_KINDS + WEBHOOK_KINDS:
        raise ValueError(f"Unknown rule {kind}")
    params = dict(params or {})
    if kind == "decline" and params.get("reason", "generic") not in DECLINES:
        raise ValueError(f"reason must be one of {', '.join(DECLINES)}")
    with gw.lock:
        gw.state["rules"].append({"id": wire.token("r_", 8), "gateway": gateway, "kind": kind, "params": params,
                                  "remaining": int(times) if times else 1, "created": time.time(), "label": label, "used": 0})
        rule = gw.state["rules"][-1]
    gw.touch("pay")
    return rule


def add_failure(gw, gateway, mode="unavailable", rate=100, latency_ms=8000, calls=5, seconds=None):
    if mode not in FAILURE_MODES:
        raise ValueError(f"mode must be one of {', '.join(FAILURE_MODES)}")
    failure = {"id": wire.token("f_", 8), "gateway": gateway, "mode": mode, "rate": max(0, min(100, int(rate))), "latency_ms": int(latency_ms),
               "remaining": int(calls) if calls else None, "until": time.time() + float(seconds) if seconds else None,
               "created": time.time(), "hits": 0}
    with gw.lock:
        gw.state["failures"].append(failure)
    gw.touch("pay")
    return failure


def preset(gw, name):
    if name not in PRESETS:
        raise ValueError(f"Unknown scenario {name}; ready ones: {', '.join(PRESETS)}")
    label, items = PRESETS[name]
    created = [add_rule(gw, gateway, kind, params, label=label) for gateway, kind, params in items]
    return label, created


def clear(gw, which="all"):
    with gw.lock:
        if which in ("all", "rules"):
            gw.state["rules"] = []
        if which in ("all", "failures"):
            gw.state["failures"] = []
    gw.touch("pay")


def _take(gw, gateway, kinds):
    """Consumes the oldest active rule of each kind for this gateway."""
    taken = {}
    with gw.lock:
        for rule in list(gw.state["rules"]):
            if rule["kind"] in kinds and rule["kind"] not in taken and _match(rule["gateway"], gateway):
                taken[rule["kind"]] = rule
                rule["remaining"] -= 1
                rule["used"] += 1
                if rule["remaining"] <= 0:
                    gw.state["rules"].remove(rule)
    if taken:
        gw.touch("pay")
    return taken


def payment_plan(gw, gateway, kinds=PAYMENT_KINDS):
    taken = _take(gw, gateway, kinds)
    plan = {"pay_after": None, "expire_after": None, "decline": None, "pending": False, "labels": []}
    for kind, rule in taken.items():
        plan["labels"].append(rule.get("label") or kind)
        if kind == "pay_after":
            plan["pay_after"] = float(rule["params"].get("seconds", 5))
        elif kind == "expire_after":
            plan["expire_after"] = float(rule["params"].get("seconds", 30))
        elif kind == "decline":
            plan["decline"] = rule["params"].get("reason", "generic")
        elif kind == "pending":
            plan["pending"] = True
    return plan


def webhook_plan(gw, gateway, ref):
    taken = _take(gw, gateway, WEBHOOK_KINDS)
    plan = {"copies": 1, "delay": 0.0, "gap": 1.0, "signature": "valid", "note": None, "hold": False, "check": None}
    notes = []
    if "delay" in taken:
        plan["delay"] = float(taken["delay"]["params"].get("seconds", 120))
        notes.append(f"retido {int(plan['delay'])} s pelo cenário")
    if "duplicate" in taken:
        plan["copies"] = max(2, int(taken["duplicate"]["params"].get("copies", 2)))
        plan["gap"] = float(taken["duplicate"]["params"].get("gap", 1))
        notes.append(f"enviado {plan['copies']} vezes pelo cenário")
    if "out_of_order" in taken:
        plan["hold"] = True
        notes.append("segurado até o evento seguinte chegar (fora de ordem)")
    if "wrong_signature" in taken:
        plan["signature"] = "wrong"
        plan["check"] = "signature"
        notes.append("assinatura errada de propósito")
    plan["note"] = "; ".join(notes) or None
    return plan


def failure_for(gw, gateway):
    """The failure control that applies to this call, if any (and counts it)."""
    now = time.time()
    with gw.lock:
        for failure in list(gw.state["failures"]):
            if failure["until"] and failure["until"] < now:
                gw.state["failures"].remove(failure)
                continue
            if not _match(failure["gateway"], gateway):
                continue
            if random.randint(1, 100) > failure["rate"]:
                return None
            failure["hits"] += 1
            if failure["remaining"] is not None:
                failure["remaining"] -= 1
                if failure["remaining"] <= 0:
                    gw.state["failures"].remove(failure)
            gw.touch("pay")
            return dict(failure)
    return None


def start_signature_check(gw, gateway):
    """Compare the same payload/route with a valid signature and then a forged signature."""
    from . import webhooks
    with gw.lock:
        last = next((d for d in reversed(gw.state["deliveries"]) if d["gateway"] == gateway and d["url"]), None)
        if last is None:
            raise ValueError(f"There is no {gateway} webhook to copy yet: make a payment first.")
        if gateway == "pix":
            raise ValueError("The Banco Central Pix standard authenticates webhooks with mTLS, not a signature; PayStudio does not emulate mTLS.")
        delivery = webhooks.resend(gw, last["id"], note="teste: assinatura válida (controle)")
        delivery["check"] = "signature_baseline"
        delivery["check_root"] = delivery["id"]
        return delivery


def finish_signature_check(gw, delivery, attempt):
    status = attempt.get("status")
    accepted = status is not None and 200 <= status < 300
    with gw.lock:
        if delivery.get("cancelled"):
            return
        baseline = delivery.get("check") == "signature_baseline"
        if baseline and accepted:
            from . import webhooks
            forged = webhooks.resend(gw, delivery["id"], signature="wrong", note="teste: assinatura errada")
            forged.update(check_root=delivery["id"], baseline_status=status)
            return
        verified = not baseline and status in (400, 401, 403) and 200 <= (delivery.get("baseline_status") or 0) < 300
        ok = True if verified else False if not baseline and accepted else None
        if verified:
            text = f"O app aceitou a assinatura válida e recusou a assinatura errada (respondeu {status})."
        elif not baseline and accepted:
            text = f"O app aceitou um webhook do {delivery['gateway']} com assinatura errada (respondeu {status})."
        else:
            text = f"Teste inconclusivo: resposta {status if status is not None else 'ausente'}; não foi possível confirmar a validação da assinatura."
        delivery["signature_result"] = ok
        gw.state["checks"].append({"at": time.time(), "gateway": delivery["gateway"], "kind": "signature", "ok": ok,
                                   "status": status, "text": text, "delivery": delivery.get("check_root", delivery["id"]),
                                   "baselineStatus": status if baseline else delivery.get("baseline_status")})
        del gw.state["checks"][:-50]
    gw.touch("pay")
