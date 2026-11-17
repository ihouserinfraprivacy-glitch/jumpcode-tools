# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""The Studio files the interface reads: pay.json (status, gateways, scenarios, checks), charges.json and
webhooks.json. Card numbers and webhook secrets never appear in them."""

import base64
from functools import lru_cache
import json
import time

from . import gateways, qr, rules
from .core import SCHEMA


def pay_file(gw):
    charges = gateways.charges(gw)
    with gw.lock:
        deliveries = list(gw.state["deliveries"])
        active_rules = [dict(r) for r in gw.state["rules"]]
        failures = [dict(f) for f in gw.state["failures"]]
        checks = list(gw.state["checks"])[-20:]
    totals = {}
    for charge in charges:
        entry = totals.setdefault(charge["status"], {"count": 0, "amount": 0})
        entry["count"] += 1
        entry["amount"] += charge["amount"]
    by_gateway = {}
    for name in gateways.MODULES:
        by_gateway[name] = {"charges": sum(1 for c in charges if c["gateway"] == name),
                            "webhooks": sum(1 for d in deliveries if d["gateway"] == name),
                            "failing": sum(1 for d in deliveries if d["gateway"] == name and d["state"] == "failed"),
                            "url": gw.webhook_url(name), "base": f"{gw.endpoint}/{name}"}
    attention = []
    for charge in charges:
        for flag in charge["flags"]:
            attention.append({"ref": charge["ref"], "gateway": charge["gateway"], "booking": charge["booking"], "kind": flag["kind"], "text": flag["text"]})
        if charge["status"] == "expirada" and charge["gateway"] == "pix":
            attention.append({"ref": charge["ref"], "gateway": "pix", "booking": charge["booking"], "kind": "expired",
                              "text": "Pix venceu sem pagamento; confira se o app liberou o horário"})
    retrying = {}
    for delivery in deliveries:
        last = delivery["attempts"][-1] if delivery["attempts"] else {}
        if delivery["state"] == "failed":
            attention.append({"ref": delivery["ref"], "gateway": delivery["gateway"], "booking": delivery["booking"], "kind": "webhook",
                              "text": f"webhook #{delivery['id']} falhou {len(delivery['attempts'])} vezes"
                                      + (f" (app respondeu {last.get('status')})" if last.get("status") else f" ({last.get('error')})")})
        elif delivery["state"] == "pending" and delivery["signature"] != "wrong" and last and not (last.get("status") and 200 <= last["status"] < 300):
            retrying.setdefault((delivery["gateway"], delivery["booking"] or delivery["ref"]), []).append((delivery, last))
    # Webhooks the app is answering with errors while PayStudio still retries, one line per charge.
    for (gateway, _), items in retrying.items():
        delivery = items[0][0]
        statuses = ", ".join(dict.fromkeys(str(last.get("status") or "sem resposta") for _, last in items))
        count = f"{len(items)} webhook" + ("s" if len(items) > 1 else "")
        attention.append({"ref": delivery["ref"], "gateway": gateway, "booking": delivery["booking"], "kind": "webhook",
                          "text": f"app respondeu {statuses} a {count} {_OF[gateway]}; o PayStudio tenta de novo"})
    for check in checks:
        if check["ok"] is False:
            attention.append({"ref": None, "gateway": check["gateway"], "booking": None, "kind": "signature", "text": check["text"]})
    return {"schema": SCHEMA, "status": gw.status, "endpoint": gw.endpoint, "port": gw.port, "startedAt": gw.started, "readyMs": gw.ready_ms,
            "storage": "persistent" if gw.persistent else "memory", "currency": "BRL", "gateways": by_gateway, "totals": totals,
            "charges": len(charges), "webhooks": len(deliveries), "calls": gw.call_seq,
            "rules": [{k: v for k, v in r.items() if k != "created"} | {"text": rule_text(r)} for r in active_rules],
            "failures": [f | {"text": failure_text(f)} for f in failures], "checks": checks, "attention": attention[-20:],
            "scheduled": gw.pending_work()[:20], "presets": {name: label for name, (label, _) in rules.PRESETS.items()},
            "merchant": gw.settings.get("merchant"), "updatedAt": time.time()}


def rule_text(rule):
    params = rule["params"]
    where = {"any": "qualquer gateway", "pix": "API Pix", "mercadopago": "Mercado Pago", "stripe": "Stripe"}[rule["gateway"]]
    text = {"pay_after": f"próxima cobrança Pix é paga {int(params.get('seconds', 5))} s depois",
            "expire_after": f"próxima cobrança Pix vence em {int(params.get('seconds', 30))} s",
            "decline": f"próximo cartão é recusado ({params.get('reason', 'generic')})",
            "pending": "próximo cartão fica em análise",
            "delay": f"próximo webhook atrasa {int(params.get('seconds', 120))} s",
            "duplicate": f"próximo webhook chega {int(params.get('copies', 2))} vezes",
            "out_of_order": "próximos webhooks chegam fora de ordem",
            "wrong_signature": "próximo webhook com assinatura errada"}.get(rule["kind"], rule["kind"])
    return f"{text} · {where}" + (f" · mais {rule['remaining']} vezes" if rule["remaining"] > 1 else "")


def failure_text(failure):
    mode = {"unavailable": "responde 503", "slow": f"demora {failure['latency_ms'] / 1000:g} s", "timeout": "não responde (timeout)",
            "rate_limit": "responde 429 (limite de chamadas)", "refuse": "recusa a conexão"}[failure["mode"]]
    where = {"any": "Todos os gateways", "pix": "API Pix", "mercadopago": "Mercado Pago", "stripe": "Stripe"}[failure["gateway"]]
    left = f" · nas próximas {failure['remaining']} chamadas" if failure["remaining"] else ""
    return f"{where} {mode}" + (f" em {failure['rate']}% das chamadas" if failure["rate"] < 100 else "") + left


_OF = {"pix": "da API Pix", "mercadopago": "do Mercado Pago", "stripe": "do Stripe"}


@lru_cache(maxsize=64)
def _qr(text):
    return "data:image/svg+xml;base64," + base64.b64encode(qr.svg(text).encode("ascii")).decode("ascii")


def charges_file(gw):
    """Every charge; a Pix still waiting for payment also carries its QR Code, so the Studio can show it."""
    items = gateways.charges(gw)[:300]
    for charge in items:
        copia = (charge.get("details") or {}).get("pixCopiaECola")
        if charge["status"] == "pendente" and copia:
            charge["qr"] = _qr(copia)
    return {"schema": SCHEMA, "charges": items}


def webhooks_file(gw):
    with gw.lock:
        deliveries = [dict(d) for d in gw.state["deliveries"]][-300:]
    for delivery in deliveries:
        try:
            from .core import redact
            delivery["payload"] = redact(json.loads(delivery.pop("body")))
        except (ValueError, KeyError):
            delivery["payload"] = None
    return {"schema": SCHEMA, "deliveries": list(reversed(deliveries))}
