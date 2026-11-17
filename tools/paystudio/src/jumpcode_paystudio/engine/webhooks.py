# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Webhooks to the app: each gateway's format and signature, retries with backoff, and the test variations the
scenarios ask for (late, duplicated, out of order, wrong signature). Only addresses on this computer are called."""

import hashlib
import hmac
import json
import threading
import time
import urllib.error
import urllib.request
import uuid
from urllib.parse import urlencode, urlsplit, urlunsplit

from .core import MAX_DELIVERIES
from .local_http import NotLocal, open_local, require_local_url

# Seconds after the first attempt for each try (real gateways spread this over hours or days).
RETRIES = (0, 5, 15, 30, 60, 120)
_inflight = set()
_inflight_lock = threading.Lock()


def _trim_history(gw):
    """Bound completed history, never queued work. Caller holds the gateway lock."""
    deliveries = gw.state["deliveries"]
    if len(deliveries) <= MAX_DELIVERIES:
        return
    history = 0
    retained = []
    for delivery in reversed(deliveries):
        if delivery["state"] in ("pending", "held"):
            retained.append(delivery)
        else:
            history += 1
            if history <= MAX_DELIVERIES:
                retained.append(delivery)
    deliveries[:] = reversed(retained)


def _target(gateway, url, payload):
    """The address each gateway really calls: Pix appends /pix; Mercado Pago adds data.id and type."""
    if gateway == "pix":
        return url.rstrip("/") + "/pix"
    if gateway == "mercadopago":
        parts = urlsplit(url)
        extra = urlencode({"data.id": payload.get("data", {}).get("id", ""), "type": payload.get("type", "payment")})
        query = f"{parts.query}&{extra}" if parts.query else extra
        return urlunsplit((parts.scheme, parts.netloc, parts.path, query, parts.fragment))
    return url


def enqueue(gw, gateway, event, ref, payload, url=None, booking=None, note=None):
    """Creates the delivery (or several, when a scenario rule asks) and returns the first one."""
    from . import rules
    url = url if url is not None else gw.webhook_url(gateway)
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    plan = rules.webhook_plan(gw, gateway, ref)
    created = []
    with gw.lock:
        for copy in range(plan["copies"]):
            gw.state["delivery_seq"] += 1
            delivery = {"id": gw.state["delivery_seq"], "gateway": gateway, "event": event, "ref": ref, "booking": booking,
                        "url": _target(gateway, url, payload) if url else "", "body": body, "created": round(time.time(), 3),
                        "due": time.time() + plan["delay"] + (plan["gap"] * copy), "attempts": [],
                        "state": ("held" if plan["hold"] and not copy else "pending") if url else "no_url",
                        "signature": plan["signature"], "copy_of": created[0]["id"] if copy else None,
                        "note": note or plan["note"], "check": plan.get("check")}
            if not url:
                delivery["note"] = "O app não tem endereço de webhook configurado para este gateway."
            gw.state["deliveries"].append(delivery)
            created.append(delivery)
        _trim_history(gw)
    gw.touch("webhooks", "charges")
    return created[0]


def headers(gw, delivery):
    """Signature headers computed at send time, like the real gateways (a wrong secret when a test asks for it)."""
    gateway = delivery["gateway"]
    wrong = delivery["signature"] == "wrong"
    timestamp = int(time.time())
    result = {"Content-Type": "application/json", "User-Agent": f"PayStudio/1.0 ({gateway} webhook emulator)"}
    if gateway == "stripe":
        secret = ("whsec_wrong" if wrong else gw.secret("stripe_webhook")).encode()
        signature = hmac.new(secret, f"{timestamp}.{delivery['body']}".encode(), hashlib.sha256).hexdigest()
        result["Stripe-Signature"] = f"t={timestamp},v1={signature}"
    elif gateway == "mercadopago":
        request_id = str(uuid.uuid4())
        data_id = str(json.loads(delivery["body"]).get("data", {}).get("id", "")).lower()
        manifest = f"id:{data_id};request-id:{request_id};ts:{timestamp};"
        secret = ("errado" if wrong else gw.secret("mercadopago_webhook")).encode()
        result["x-signature"] = f"ts={timestamp},v1={hmac.new(secret, manifest.encode(), hashlib.sha256).hexdigest()}"
        result["x-request-id"] = request_id
    return result


def deliver_due(gw):
    now = time.time()
    with gw.lock:
        state = gw.state
        deliveries = list(state["deliveries"])
        for delivery in deliveries:
            if delivery["state"] == "held":
                later = [d for d in deliveries if d["ref"] == delivery["ref"] and d["id"] > delivery["id"] and d["gateway"] == delivery["gateway"]]
                if any(d["state"] == "delivered" for d in later) or now - delivery["created"] > 20:
                    delivery["state"] = "pending"
                    delivery["due"] = now
                    gw.touch("webhooks")
                continue
            if delivery["state"] != "pending" or delivery["due"] > now:
                continue
            # Numeric IDs can be reused after reset; this object's identity cannot.
            key = (id(gw), id(delivery))
            with _inflight_lock:
                if key in _inflight:
                    continue
                _inflight.add(key)
            try:
                threading.Thread(target=_attempt, args=(gw, delivery, state), name="paystudio-webhook", daemon=True).start()
            except Exception:
                with _inflight_lock:
                    _inflight.discard(key)
                raise


def _attempt(gw, delivery, state):
    try:
        _send_and_record(gw, delivery, state)
    finally:
        # Keep the reservation until the result and retry deadline are committed.
        with _inflight_lock:
            _inflight.discard((id(gw), id(delivery)))


def _send_and_record(gw, delivery, state):
    with gw.lock:
        if gw.state is not state or delivery.get("cancelled"):
            return
    started = time.perf_counter()
    sent = headers(gw, delivery)
    # The headers as sent (signatures are HMACs, never the secret), so the Studio can show exactly what the app received.
    entry = {"at": round(time.time(), 3), "status": None, "ms": 0, "body": "", "error": None, "headers": sent}
    try:
        request = urllib.request.Request(delivery["url"], delivery["body"].encode("utf-8"), method="POST", headers=sent)
        with open_local(request, timeout=10) as answer:
            entry["status"] = answer.status
            entry["body"] = answer.read(600).decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        entry["status"] = error.code
        try:
            entry["body"] = error.read(600).decode("utf-8", "replace")
        except OSError:
            entry["body"] = ""
    except NotLocal as error:
        entry["error"] = str(error)
    except Exception as error:  # refused connection, timeout: the app is down or slow
        entry["error"] = f"{type(error).__name__}: {error}"[:300]
    finally:
        entry["ms"] = round((time.perf_counter() - started) * 1000, 1)
    ok = entry["status"] is not None and 200 <= entry["status"] < 300
    with gw.lock:
        if gw.state is not state:
            return
        delivery["attempts"].append(entry)
        if ok:
            delivery["state"] = "delivered"
        elif delivery.get("check") or delivery["signature"] == "wrong":
            # A forged webhook goes once: refusing it is the right answer, and no gateway retries a forgery.
            delivery["state"] = "delivered"
        elif entry["error"] and entry["error"].startswith("PayStudio only delivers"):
            delivery["state"] = "failed"
        elif len(delivery["attempts"]) >= len(RETRIES):
            delivery["state"] = "failed"
        else:
            delivery["due"] = delivery["attempts"][0]["at"] + RETRIES[len(delivery["attempts"])]
        if delivery.get("check") in ("signature", "signature_baseline"):
            from . import rules
            rules.finish_signature_check(gw, delivery, entry)
        _trim_history(gw)
        gw.touch("webhooks", "charges")


def resend(gw, delivery_id, signature="valid", note="Reenviado"):
    with gw.lock:
        original = next((d for d in gw.state["deliveries"] if d["id"] == int(delivery_id)), None)
        if original is None:
            raise KeyError(f"No webhook #{delivery_id}")
        gw.state["delivery_seq"] += 1
        copy = {**original, "id": gw.state["delivery_seq"], "created": round(time.time(), 3), "due": time.time(), "attempts": [],
                "state": "pending" if original["url"] else "no_url", "signature": signature, "copy_of": original["id"], "note": note,
                "check": "signature" if signature == "wrong" else None}
        for name in ("check_root", "baseline_status", "cancelled", "signature_result"):
            copy.pop(name, None)
        gw.state["deliveries"].append(copy)
        _trim_history(gw)
    gw.touch("webhooks")
    return copy


def check_url(url):
    """Whether an address may receive webhooks (only this computer)."""
    require_local_url(url)
    return url
