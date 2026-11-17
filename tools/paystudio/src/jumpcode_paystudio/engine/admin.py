# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""The control door the PayStudio tool uses (never the app): status, charges, simulated payer actions,
scenarios, failure controls, webhook settings and checks. Every call needs the tool's token."""

import hmac
import json
import os
import threading
import time

from . import gateways, mercadopago, operation, pix, rules, stripe, webhooks, wire
from .core import empty_state
from .local_http import NotLocal
from .wire import GatewayError, Response


class ControlError(Exception):
    pass


def handle_admin(gw, request):
    name = request.path[len("/_paystudio/"):].strip("/")
    if name == "health":
        return _json({"ok": True, "pid": os.getpid(), "port": gw.port})
    if not gw.token or not hmac.compare_digest(request.headers.get("x-paystudio-token", ""), gw.token):
        return _json({"error": "forbidden"}, 403)
    try:
        params = json.loads(request.body.decode("utf-8") or "{}") if request.body else {}
        controls = {"operation-open": gw.operations.open, "operation-cancel": gw.operations.cancel, "operation-close": gw.operations.close}
        if name in controls:
            controls[name](params.get("id"))
            return _json({"ok": True})
        action = ACTIONS.get(name)
        if action is None:
            raise ControlError(f"Unknown control action {name}")
        with gw.operations.use(request.headers.get("x-paystudio-operation")):
            return _json(action(gw, params))
    except (ControlError, ValueError, KeyError, NotLocal) as error:
        return _json({"error": type(error).__name__, "message": str(error).strip("'\"")}, 400)
    except GatewayError as error:
        return _json({"error": error.code, "message": error.message}, 400)


def _json(value, status=200):
    return Response(status, json.dumps(value, ensure_ascii=False, default=str), {"Content-Type": "application/json"})


def _summary(charge):
    return {"gateway": charge["gateway"], "ref": charge["ref"], "booking": charge["booking"], "customer": charge["customer"],
            "method": charge["method"], "amount": wire.brl(charge["amount"]), "status": charge["status"], "gatewayStatus": charge["gatewayStatus"],
            "created": time.strftime("%H:%M:%S", time.localtime(charge["created"])), "flags": [f["text"] for f in charge["flags"]]}


def status(gw, params):
    from .views import pay_file
    data = pay_file(gw)
    charges = gateways.charges(gw)
    return {"running": True, "endpoint": gw.endpoint, "storage": data["storage"],
            "gateways": {name: {"base": info["base"], "webhook": info["url"] or None, "charges": info["charges"], "failingWebhooks": info["failing"]}
                         for name, info in data["gateways"].items()},
            "totals": {k: {"count": v["count"], "amount": wire.brl(v["amount"])} for k, v in data["totals"].items()},
            "attention": [f"{a['gateway']} {a.get('booking') or a.get('ref') or ''}: {a['text']}" for a in data["attention"]],
            "rules": [r["text"] for r in data["rules"]], "failures": [f["text"] for f in data["failures"]],
            "checks": [c["text"] for c in data["checks"][-5:]], "recent": [_summary(c) for c in charges[:8]]}


def charges(gw, params):
    items = gateways.charges(gw)
    if params.get("gateway"):
        items = [c for c in items if c["gateway"] == params["gateway"]]
    if params.get("status"):
        items = [c for c in items if c["status"] == params["status"]]
    return {"charges": [_summary(c) for c in items[: int(params.get("limit") or 20)]]}


def _find(gw, params):
    ref = params.get("ref")
    if not ref:
        items = gateways.charges(gw)
        if params.get("gateway"):
            items = [c for c in items if c["gateway"] == params["gateway"]]
        if len(items) != 1:
            raise ControlError("Give the charge (its booking such as AG-4830, the txid or the payment id)"
                               + (f": recent ones are {', '.join((c['booking'] or c['ref']) for c in items[:6])}" if items else "; there is no charge yet"))
        return items[0]["gateway"], gateways.MODULES[items[0]["gateway"]].find(gw, items[0]["ref"])
    gateway, obj = gateways.find(gw, ref, params.get("gateway"))
    if obj is None:
        raise ControlError(f"No charge matches {ref}")
    return gateway, obj


def charge(gw, params):
    gateway, obj = _find(gw, params)
    ref = obj.get("txid") or obj.get("id")
    detail = next(c for c in gateways.charges(gw) if c["gateway"] == gateway and c["ref"] == ref)
    with gw.lock:
        deliveries = [d for d in gw.state["deliveries"] if d["gateway"] == gateway and d["ref"] == ref]
    return {**_summary(detail), "details": detail["details"],
            "events": [f"{time.strftime('%H:%M:%S', time.localtime(e['at']))} {e['by']}: {e['text']}" for e in detail["events"]],
            "webhooks": [{"id": d["id"], "event": d["event"], "state": d["state"], "attempts": len(d["attempts"]),
                          "lastStatus": d["attempts"][-1]["status"] if d["attempts"] else None, "note": d.get("note")} for d in deliveries]}


def pay(gw, params):
    """The payer pays (Pix), the card is authenticated (3-D Secure) or a pending Mercado Pago payment is approved."""
    if params.get("delay"):
        rules.add_rule(gw, "any", "delay", {"seconds": float(params["delay"])}, label="pedido do agente")
    if params.get("duplicate"):
        rules.add_rule(gw, "any", "duplicate", {"copies": 2}, label="pedido do agente")
    gateway, obj = _find(gw, params)
    if gateway == "pix":
        record = pix.pay(gw, obj["txid"], by="agente")
        return {"paid": obj["txid"], "endToEndId": record["endToEndId"], "booking": obj["ps"].get("booking")}
    if gateway == "mercadopago":
        mercadopago.pay(gw, obj["id"], by="agente")
        return {"paid": obj["id"], "booking": obj["ps"].get("booking")}
    if obj["status"] == "requires_action":
        stripe.authenticate(gw, obj, approve=params.get("approve", True) is not False)
        return {"authenticated": obj["id"], "status": obj["status"]}
    raise ControlError("A Stripe card payment is confirmed by the app (confirm); PayStudio can only finish a 3-D Secure challenge.")


def expire(gw, params):
    gateway, obj = _find(gw, params)
    if gateway == "pix":
        pix.expire_now(gw, obj["txid"])
    elif gateway == "mercadopago":
        if obj["status"] != "pending" or obj["method"] != "pix":
            raise ControlError("Only a pending Mercado Pago Pix can expire")
        mercadopago.expire(gw, obj)
    else:
        raise ControlError("Stripe card payments do not expire; cancel them instead")
    return {"expired": obj.get("txid") or obj.get("id")}


def refund(gw, params):
    gateway, obj = _find(gw, params)
    amount = params.get("amount")
    if gateway == "pix":
        with gw.lock:
            record = next((gw.state["pix"]["pix"][e] for e in obj["pix"]), None)
            if record is None:
                raise ControlError("This Pix charge was not paid")
            # Pending refunds already reserve their amount, just like completed refunds.
            returned = sum(wire.cents(d["valor"]) for d in record["devolucoes"])
            value = wire.cents(amount) if amount is not None else wire.cents(record["valor"]) - returned
            if value <= 0:
                raise ControlError("Give a positive refund amount within the remaining Pix balance.")
            pix.refund(gw, None, record, wire.token("dev", 10), wire.reais(value))
    elif gateway == "mercadopago":
        mercadopago.refund(gw, obj, amount, by="agente")
    else:
        stripe.refund(gw, obj, wire.cents(amount) if amount else None, by="agente")
    return {"refunded": obj.get("txid") or obj.get("id")}


def dispute(gw, params):
    gateway, obj = _find(gw, params)
    if gateway == "stripe":
        stripe.dispute(gw, obj, params.get("reason") or "fraudulent")
    elif gateway == "mercadopago":
        mercadopago.chargeback(gw, obj)
    else:
        raise ControlError("Pix has no chargeback; the payer asks for a MED (mecanismo especial de devolução) at the bank instead")
    return {"disputed": obj.get("id")}


def scenario(gw, params):
    label, created = rules.preset(gw, params.get("name", ""))
    return {"scenario": label, "rules": len(created)}


def rule(gw, params):
    created = rules.add_rule(gw, params.get("gateway") or "any", params.get("kind", ""), params.get("params") or {}, params.get("times") or 1)
    return {"rule": created["id"]}


def failure(gw, params):
    created = rules.add_failure(gw, params.get("gateway") or "any", params.get("mode") or "unavailable", params.get("rate", 100),
                                params.get("latency_ms", 8000), params.get("calls", 5), params.get("seconds"))
    return {"failure": created["id"]}


def clear(gw, params):
    rules.clear(gw, params.get("which") or "all")
    return {"cleared": params.get("which") or "all"}


def webhook(gw, params):
    gateway = params.get("gateway")
    if gateway not in gateways.MODULES:
        raise ControlError("gateway must be pix, mercadopago or stripe")
    url = params.get("url") or ""
    if url:
        webhooks.check_url(url)
    gw.settings.setdefault("webhooks", {})[gateway] = url
    gw.touch("pay")
    return {"gateway": gateway, "url": url}


def resend(gw, params):
    delivery = webhooks.resend(gw, params.get("id"))
    return {"resent": delivery["id"], "copy_of": delivery["copy_of"]}


def check(gw, params):
    with gw.lock:
        state = gw.state
        delivery = rules.start_signature_check(gw, params.get("gateway") or "stripe")
    deadline = time.monotonic() + 25
    result = None
    interrupted = False
    try:
        while time.monotonic() < deadline:
            operation.checkpoint()
            with gw.lock:
                if gw.state is not state:
                    interrupted = True
                    break
                result = next((c for c in gw.state["checks"] if c.get("delivery") == delivery["id"]), None)
            if result:
                break
            operation.wait(0.05)
    finally:
        if not result:
            with gw.lock:
                # Clean up only the original operation, never a new check reusing its ID.
                for item in state["deliveries"]:
                    if item.get("check_root") == delivery["id"]:
                        item["cancelled"] = True
                        if item["state"] in ("pending", "held"):
                            item["state"] = "failed"
                if gw.state is state:
                    gw.touch("webhooks")
    message = "Teste interrompido: os dados do PayStudio foram limpos." if interrupted else "Teste inconclusivo: o app não respondeu no prazo."
    return {"check": "signature", "delivery": delivery["id"], "result": result["text"] if result else message,
            "ok": result["ok"] if result else None}


def calls(gw, params):
    with gw.lock:
        items = list(gw.calls)
    if params.get("errors"):
        items = [c for c in items if c.get("error") or (c.get("status") or 0) >= 400]
    return {"calls": items[-int(params.get("limit") or 15):]}


def deliveries(gw, params):
    with gw.lock:
        items = [d for d in gw.state["deliveries"] if not params.get("failed") or d["state"] == "failed"]
    return {"webhooks": [{"id": d["id"], "gateway": d["gateway"], "event": d["event"], "booking": d["booking"], "ref": d["ref"],
                          "state": d["state"], "url": d["url"], "attempts": [{"status": a["status"], "ms": a["ms"], "error": a["error"],
                                                                                "body": (a["body"] or "")[:200]} for a in d["attempts"]],
                          "note": d.get("note")} for d in items[-int(params.get("limit") or 10):]]}


def reset(gw, params):
    with gw.lock:
        gw.state = empty_state()
        gw.calls.clear()
        gw.call_seq = 0
    gw.touch("pay", "charges", "webhooks", "calls")
    return {"reset": True}


def shutdown(gw, params):
    threading.Thread(target=lambda: (time.sleep(0.2), gw.stop_server()), daemon=True).start()
    return {"stopping": True}


ACTIONS = {"status": status, "charges": charges, "charge": charge, "pay": pay, "expire": expire, "refund": refund, "dispute": dispute,
           "scenario": scenario, "rule": rule, "failure": failure, "clear": clear, "webhook": webhook, "resend": resend, "check": check,
           "calls": calls, "webhooks": deliveries, "reset": reset, "shutdown": shutdown}
