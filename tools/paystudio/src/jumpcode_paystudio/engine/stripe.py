# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Stripe API (v1, form-encoded) under /stripe and /v1: payment methods, payment intents (confirm, cancel,
3-D Secure), refunds, disputes, Idempotency-Key and signed events. Stripe's public test cards and test
payment methods (pm_card_visa, pm_card_chargeDeclined, ...) behave as in Stripe's test mode."""

import json
import time
from urllib.parse import parse_qsl

from . import wire
from .wire import GatewayError

NAME = "stripe"
API_VERSION = "2024-06-20"
NUMBERS = {
    "4242424242424242": ("visa", "succeed"), "5555555555554444": ("mastercard", "succeed"), "378282246310005": ("amex", "succeed"),
    "4000000000000002": ("visa", "generic"), "4000000000009995": ("visa", "insufficient_funds"), "4000000000000069": ("visa", "expired_card"),
    "4000000000000127": ("visa", "incorrect_cvc"), "4000000000000119": ("visa", "processing_error"), "4000000000000259": ("visa", "dispute"),
    "4000002500003155": ("visa", "3ds"), "4000000000003220": ("visa", "3ds"),
}
TEST_METHODS = {
    "pm_card_visa": "4242424242424242", "pm_card_mastercard": "5555555555554444", "pm_card_amex": "378282246310005",
    "pm_card_chargeDeclined": "4000000000000002", "pm_card_chargeDeclinedInsufficientFunds": "4000000000009995",
    "pm_card_chargeDeclinedExpiredCard": "4000000000000069", "pm_card_chargeDeclinedIncorrectCvc": "4000000000000127",
    "pm_card_chargeDeclinedProcessingError": "4000000000000119", "pm_card_createDispute": "4000000000000259",
    "pm_card_authenticationRequired": "4000002500003155", "pm_card_threeDSecure2Required": "4000000000003220",
}
DECLINE_TEXT = {
    "generic": ("card_declined", "generic_decline", "Your card was declined."),
    "insufficient_funds": ("card_declined", "insufficient_funds", "Your card has insufficient funds."),
    "expired_card": ("expired_card", "expired_card", "Your card has expired."),
    "incorrect_cvc": ("incorrect_cvc", "incorrect_cvc", "Your card's security code is incorrect."),
    "processing_error": ("processing_error", "processing_error", "An error occurred while processing your card. Try again in a little bit."),
    "call_for_authorize": ("card_declined", "call_issuer", "Your card was declined."),
}


def error(status, message, kind="invalid_request_error", **extra):
    return GatewayError(status, {"error": {"type": kind, "message": message, **extra}}, extra.get("code", kind), message)


def space(gw):
    return gw.state["stripe"]


def parse_form(body):
    """Stripe's bracket encoding (metadata[booking]=AG-1, payment_method_types[0]=card or [], card[number]=...) to nested values."""
    root = {}
    for key, value in parse_qsl(body.decode("utf-8", "replace"), keep_blank_values=True):
        head, _, rest = key.partition("[")
        parts = [head] + (rest[:-1].split("][") if rest.endswith("]") else ([rest] if rest else []))
        node = root
        for index, part in enumerate(parts):
            if part == "":
                part = str(len(node))
            if index == len(parts) - 1:
                node[part] = value
            else:
                child = node.setdefault(part, {})
                if not isinstance(child, dict):
                    break
                node = child
    return _lists(root)


def _lists(node):
    if isinstance(node, dict):
        node = {key: _lists(value) for key, value in node.items()}
        if node and all(key.isdigit() for key in node):
            return [node[key] for key in sorted(node, key=int)]
    return node

def _truth(value):
    return str(value).lower() in ("true", "1", "yes")


def handle(gw, request, path):
    auth = request.headers.get("authorization", "")
    key = ""
    if auth.lower().startswith("bearer "):
        key = auth[7:].strip()
    elif auth.lower().startswith("basic "):
        import base64
        try:
            key = base64.b64decode(auth[6:]).decode("utf-8").split(":", 1)[0]
        except (ValueError, UnicodeDecodeError):
            key = ""
    if not key:
        raise error(401, "You did not provide an API key. You need to provide your API key in the Authorization header, using Bearer auth "
                         "(e.g. 'Authorization: Bearer YOUR_SECRET_KEY').")
    if key.startswith(("sk_live_", "rk_live_")):
        request.flag = "chave secreta de produção (sk_live_) enviada ao PayStudio; use uma chave de teste (sk_test_)"
        raise error(401, "PayStudio only accepts Stripe test keys (sk_test_...). A live key was sent to a local fake gateway: check the app's environment.")
    if not key.startswith(("sk_test_", "rk_test_")):
        raise error(401, f"Invalid API Key provided: {key[:8]}****")
    parts = [p for p in path.split("/") if p]
    if parts[:1] == ["v1"]:
        parts = parts[1:]
    form = parse_form(request.body) if request.method in ("POST", "DELETE") else dict(request.query)
    request.note_req = form
    # Lookup, mutation and receipt form one transaction; no network I/O occurs in route.
    with gw.lock:
        replay = _idempotency_replay(gw, request, parts, form)
        if replay is not None:
            return replay
        try:
            response = route(gw, request, parts, form)
        except GatewayError as caught:
            _idempotency_store(gw, request, parts, form, wire.json_response(caught.body, caught.status))
            raise
        _idempotency_store(gw, request, parts, form, response)
    response.headers.setdefault("Request-Id", wire.token("req_", 14))
    response.headers.setdefault("Stripe-Version", API_VERSION)
    return response


def _fingerprint(request, parts, form):
    return json.dumps([request.method, parts, form], sort_keys=True)


def _idempotency_replay(gw, request, parts, form):
    key = request.headers.get("idempotency-key")
    if request.method != "POST" or not key:
        return None
    stored = gw.state["idempotency"][NAME].get(key)
    if stored is None:
        return None
    if stored["fingerprint"] != _fingerprint(request, parts, form):
        raise error(400, "Keys for idempotent requests can only be used with the same parameters they were first used with. "
                         "Try using a key other than '" + key + "' if you meant to execute a different request.", "idempotency_error")
    request.op = "repetição idempotente"
    request.ref = stored.get("ref")
    return wire.Response(stored["status"], stored["body"].encode("utf-8"), {"Content-Type": "application/json", "Idempotent-Replayed": "true"})


def _idempotency_store(gw, request, parts, form, response):
    key = request.headers.get("idempotency-key")
    if request.method == "POST" and key:
        gw.state["idempotency"][NAME][key] = {"fingerprint": _fingerprint(request, parts, form), "status": response.status,
                                               "body": response.body.decode("utf-8"), "ref": getattr(request, "ref", None)}
        gw.touch("calls")


def route(gw, request, parts, form):
    method = request.method
    if not parts:
        raise error(404, "Unrecognized request URL (GET: /v1/). Please see https://stripe.com/docs.")
    kind = parts[0]
    if kind == "payment_methods":
        if method == "POST" and len(parts) == 1:
            request.op = "criar payment_method"
            return wire.json_response(method_view(create_method(gw, form)))
        if len(parts) == 2:
            request.op = "consultar payment_method"
            return wire.json_response(method_view(resolve_method(gw, parts[1])))
    if kind == "payment_intents":
        if len(parts) == 1:
            if method == "POST":
                request.op = "criar PaymentIntent"
                return create_intent(gw, request, form)
            request.op = "listar PaymentIntents"
            items = sorted(space(gw)["intents"].values(), key=lambda i: i["created"], reverse=True)[: int(form.get("limit") or 10)]
            return wire.json_response({"object": "list", "data": [intent_view(i) for i in items], "has_more": False, "url": "/v1/payment_intents"})
        intent = space(gw)["intents"].get(parts[1])
        request.ref = parts[1]
        if intent is None:
            raise error(404, f"No such payment_intent: '{parts[1]}'", code="resource_missing", param="intent")
        if len(parts) == 2:
            if method == "GET":
                request.op = "consultar PaymentIntent"
                return wire.json_response(intent_view(intent))
            request.op = "alterar PaymentIntent"
            return update_intent(gw, intent, form)
        if parts[2] == "confirm" and method == "POST":
            request.op = "confirmar PaymentIntent"
            return confirm(gw, request, intent, form)
        if parts[2] == "cancel" and method == "POST":
            request.op = "cancelar PaymentIntent"
            return cancel(gw, intent, form)
    if kind == "refunds":
        if method == "POST" and len(parts) == 1:
            request.op = "criar refund"
            return create_refund(gw, request, form)
        if len(parts) == 2:
            request.op = "consultar refund"
            refund = space(gw)["refunds"].get(parts[1])
            if refund is None:
                raise error(404, f"No such refund: '{parts[1]}'", code="resource_missing")
            return wire.json_response(refund)
    raise error(404, f"Unrecognized request URL ({method}: /v1/{'/'.join(parts)}). PayStudio emulates payment_intents, payment_methods "
                     "and refunds of Stripe; this endpoint is not emulated yet.")


# ---------------------------------------------------------------- payment methods

def create_method(gw, form):
    card = form.get("card") or {}
    number = "".join(ch for ch in str(card.get("number", "")) if ch.isdigit())
    if form.get("type", "card") != "card" or not number:
        raise error(400, "Missing required param: card[number].", param="card[number]")
    brand, behavior = NUMBERS.get(number, ("visa", "succeed"))
    method = {"id": wire.token("pm_", 24), "object": "payment_method", "type": "card", "created": int(time.time()), "livemode": False,
              "card": {"brand": brand, "last4": number[-4:], "exp_month": int(card.get("exp_month") or 12), "exp_year": int(card.get("exp_year") or 2030),
                       "funding": "credit", "country": "US"}, "behavior": behavior, "billing_details": form.get("billing_details") or {}}
    space(gw)["methods"][method["id"]] = method
    return method


def resolve_method(gw, method_id):
    if method_id in space(gw)["methods"]:
        return space(gw)["methods"][method_id]
    if method_id in TEST_METHODS:
        number = TEST_METHODS[method_id]
        brand, behavior = NUMBERS[number]
        method = {"id": method_id, "object": "payment_method", "type": "card", "created": int(time.time()), "livemode": False,
                  "card": {"brand": brand, "last4": number[-4:], "exp_month": 12, "exp_year": 2030, "funding": "credit", "country": "US"},
                  "behavior": behavior, "billing_details": {}}
        space(gw)["methods"][method_id] = method
        return method
    raise error(404, f"No such PaymentMethod: '{method_id}'", code="resource_missing", param="payment_method")


def method_view(method):
    return {k: v for k, v in method.items() if k != "behavior"}


# ---------------------------------------------------------------- payment intents

def create_intent(gw, request, form):
    try:
        amount = int(form.get("amount", ""))
    except ValueError:
        raise error(400, "Missing required param: amount.", param="amount")
    currency = str(form.get("currency") or "").lower()
    if not currency:
        raise error(400, "Missing required param: currency.", param="currency")
    if currency == "brl" and amount < 50:
        raise error(400, "Amount must be at least R$0.50 brl", code="amount_too_small", param="amount")
    now = time.time()
    metadata = form.get("metadata") or {}
    intent = {"id": wire.token("pi_", 24), "amount": amount, "currency": currency, "created": now, "status": "requires_payment_method",
              "metadata": metadata, "description": form.get("description"), "receipt_email": form.get("receipt_email"),
              "payment_method": None, "payment_method_types": form.get("payment_method_types") or ["card"], "last_payment_error": None,
              "latest_charge": None, "next_action": None, "canceled_at": None, "cancellation_reason": None, "refunded": 0, "dispute": None,
              "idempotency": request.headers.get("idempotency-key"),
              "ps": {"booking": gw.booking_from(metadata, form.get("description")), "customer": metadata.get("customer_name") or metadata.get("cliente")
                     or form.get("receipt_email"), "events": [], "flags": []}}
    intent["client_secret"] = f"{intent['id']}_secret_{wire.token('', 24)}"
    duplicate = None if intent["idempotency"] else _possible_duplicate(gw, intent)
    space(gw)["intents"][intent["id"]] = intent
    request.ref = intent["id"]
    gw.event(intent, f"PaymentIntent criado · {wire.brl(amount) if currency == 'brl' else amount} · "
                     + ("com Idempotency-Key" if intent["idempotency"] else "sem Idempotency-Key"), "info", "app")
    if duplicate:
        intent["ps"]["flags"].append({"kind": "duplicate", "text": f"mesmo valor e mesmo agendamento de {duplicate}, sem Idempotency-Key",
                                      "other": duplicate})
        gw.event(intent, f"possível cobrança duplicada: igual a {duplicate} e sem Idempotency-Key", "bad")
    event(gw, intent, "payment_intent.created")
    if form.get("payment_method"):
        intent["payment_method"] = resolve_method(gw, form["payment_method"])["id"]
        intent["status"] = "requires_confirmation"
    if _truth(form.get("confirm", "false")):
        return confirm(gw, request, intent, {})
    return wire.json_response(intent_view(intent))


def _possible_duplicate(gw, intent):
    for other in space(gw)["intents"].values():
        if (other["amount"] == intent["amount"] and other["ps"].get("booking") and other["ps"]["booking"] == intent["ps"].get("booking")
                and intent["created"] - other["created"] < 30 and other["status"] != "canceled"):
            return other["id"]
    return None


def update_intent(gw, intent, form):
    if intent["status"] in ("succeeded", "canceled"):
        raise error(400, f"This PaymentIntent's status is {intent['status']} and it cannot be updated.", code="payment_intent_unexpected_state")
    if form.get("metadata"):
        intent["metadata"].update(form["metadata"])
    if form.get("amount"):
        intent["amount"] = int(form["amount"])
    if form.get("payment_method"):
        intent["payment_method"] = resolve_method(gw, form["payment_method"])["id"]
        intent["status"] = "requires_confirmation"
    gw.touch("charges")
    return wire.json_response(intent_view(intent))


def confirm(gw, request, intent, form):
    from . import rules
    if intent["status"] in ("succeeded", "canceled", "processing"):
        raise error(400, f"You cannot confirm this PaymentIntent because it has a status of {intent['status']}.", code="payment_intent_unexpected_state")
    if form.get("payment_method"):
        intent["payment_method"] = resolve_method(gw, form["payment_method"])["id"]
    if not intent["payment_method"]:
        raise error(400, "You cannot confirm this PaymentIntent because it's missing a payment method.", code="payment_intent_unexpected_state")
    method = resolve_method(gw, intent["payment_method"])
    behavior = method["behavior"]
    plan = rules.payment_plan(gw, NAME, ("decline",))
    if plan["decline"]:
        behavior = plan["decline"] if plan["decline"] in DECLINE_TEXT else "generic"
        gw.event(intent, f"cenário: {', '.join(plan['labels'])}", "scenario")
    card = f"{method['card']['brand']} final {method['card']['last4']}"
    if behavior == "3ds":
        intent["status"] = "requires_action"
        intent["next_action"] = {"type": "use_stripe_sdk", "use_stripe_sdk": {"type": "three_d_secure_redirect"}}
        gw.event(intent, f"{card}: o banco pede autenticação 3-D Secure (requires_action)", "warn", "app")
        event(gw, intent, "payment_intent.requires_action")
        return wire.json_response(intent_view(intent))
    if behavior in DECLINE_TEXT:
        code, decline, message = DECLINE_TEXT[behavior]
        charge_id = wire.token("ch_", 24)
        intent["latest_charge"] = charge_id
        intent["status"] = "requires_payment_method"
        intent["last_payment_error"] = {"type": "card_error", "code": code, "decline_code": decline, "message": message,
                                        "charge": charge_id, "payment_method": method_view(method)}
        gw.event(intent, f"{card} recusado · {decline}", "bad", "app")
        event(gw, intent, "payment_intent.payment_failed")
        raise GatewayError(402, {"error": {"type": "card_error", "code": code, "decline_code": decline, "message": message,
                                           "charge": charge_id, "doc_url": f"https://stripe.com/docs/error-codes/{code.replace('_', '-')}",
                                           "payment_intent": intent_view(intent), "payment_method": method_view(method)}}, code, message)
    succeed(gw, intent, card, by="app")
    if behavior == "dispute":
        gw.later(3, {"kind": "dispute", "gateway": NAME, "ref": intent["id"]}, f"abrir contestação de {intent['id'][-8:]}", intent["id"])
    return wire.json_response(intent_view(intent))


def succeed(gw, intent, card="cartão", by="PayStudio"):
    intent["status"] = "succeeded"
    intent["next_action"] = None
    intent["last_payment_error"] = None
    intent["latest_charge"] = wire.token("ch_", 24)
    intent["paid"] = time.time()
    gw.event(intent, f"{card} aprovado · {wire.brl(intent['amount'])}", "ok", by)
    event(gw, intent, "payment_intent.succeeded")


def cancel(gw, intent, form):
    if intent["status"] in ("succeeded", "canceled"):
        raise error(400, f"You cannot cancel this PaymentIntent because it has a status of {intent['status']}.", code="payment_intent_unexpected_state")
    intent["status"] = "canceled"
    intent["canceled_at"] = int(time.time())
    intent["cancellation_reason"] = form.get("cancellation_reason") or "requested_by_customer"
    gw.event(intent, "cancelado pelo app", "warn", "app")
    event(gw, intent, "payment_intent.canceled")
    return wire.json_response(intent_view(intent))


def intent_view(intent):
    return {"id": intent["id"], "object": "payment_intent", "amount": intent["amount"], "amount_capturable": 0,
            "amount_received": intent["amount"] if intent["status"] == "succeeded" else 0, "capture_method": "automatic",
            "client_secret": intent["client_secret"], "confirmation_method": "automatic", "created": int(intent["created"]),
            "currency": intent["currency"], "description": intent["description"], "last_payment_error": intent["last_payment_error"],
            "latest_charge": intent["latest_charge"], "livemode": False, "metadata": intent["metadata"], "next_action": intent["next_action"],
            "payment_method": intent["payment_method"], "payment_method_types": intent["payment_method_types"],
            "receipt_email": intent["receipt_email"], "status": intent["status"], "canceled_at": intent["canceled_at"],
            "cancellation_reason": intent["cancellation_reason"]}


# ---------------------------------------------------------------- refunds and disputes

def create_refund(gw, request, form):
    intent_id = form.get("payment_intent")
    if not intent_id and form.get("charge"):
        intent_id = next((i["id"] for i in space(gw)["intents"].values() if i["latest_charge"] == form["charge"]), None)
    intent = space(gw)["intents"].get(intent_id or "")
    if intent is None:
        raise error(400, "Must provide either charge or payment_intent.", param="payment_intent")
    request.ref = intent["id"]
    return wire.json_response(refund(gw, intent, form.get("amount"), by="app"))


def refund(gw, intent, amount=None, by="PayStudio"):
    with gw.lock:
        return _refund(gw, intent, amount, by)


def _refund(gw, intent, amount=None, by="PayStudio"):
    if intent["status"] != "succeeded":
        raise error(400, f"This PaymentIntent does not have a successful charge to refund.", code="charge_not_refundable")
    left = intent["amount"] - intent["refunded"]
    value = int(amount) if amount else left
    if value <= 0 or value > left:
        raise error(400, f"Refund amount (R${value / 100:.2f}) is greater than unrefunded amount on charge (R${left / 100:.2f})", code="amount_too_large")
    record = {"id": wire.token("re_", 24), "object": "refund", "amount": value, "charge": intent["latest_charge"], "currency": intent["currency"],
              "payment_intent": intent["id"], "status": "succeeded", "created": int(time.time()), "reason": None, "metadata": {}}
    space(gw)["refunds"][record["id"]] = record
    intent["refunded"] += value
    gw.event(intent, f"reembolso de {wire.brl(value)}", "warn", by)
    event(gw, intent, "charge.refunded", {"object": "charge", "id": intent["latest_charge"], "amount": intent["amount"],
                                          "amount_refunded": intent["refunded"], "refunded": intent["refunded"] >= intent["amount"],
                                          "payment_intent": intent["id"], "metadata": intent["metadata"]})
    return record


def dispute(gw, intent, reason="fraudulent"):
    if intent["status"] != "succeeded":
        raise ValueError("Only a successful payment can be disputed")
    record = {"id": wire.token("dp_", 24), "object": "dispute", "amount": intent["amount"], "charge": intent["latest_charge"],
              "currency": intent["currency"], "payment_intent": intent["id"], "reason": reason, "status": "needs_response",
              "created": int(time.time()), "evidence_details": {"due_by": int(time.time()) + 7 * 86400}}
    space(gw)["disputes"][record["id"]] = record
    intent["dispute"] = record["id"]
    gw.event(intent, f"contestação aberta · motivo {reason} · responder até {time.strftime('%d/%m', time.localtime(record['evidence_details']['due_by']))}", "bad")
    event(gw, intent, "charge.dispute.created", record)
    return record


def event(gw, intent, kind, obj=None):
    from . import webhooks
    payload = {"id": wire.token("evt_", 24), "object": "event", "api_version": API_VERSION, "created": int(time.time()),
               "data": {"object": obj or intent_view(intent)}, "livemode": False, "pending_webhooks": 1,
               "request": {"id": None, "idempotency_key": intent.get("idempotency")}, "type": kind}
    delivery = webhooks.enqueue(gw, NAME, kind, intent["id"], payload, booking=intent["ps"].get("booking"))
    gw.event(intent, f"evento {kind} · webhook #{delivery['id']}" + (f" · {delivery['note']}" if delivery.get("note") else ""), "webhook")


# ---------------------------------------------------------------- what PayStudio simulates

def find(gw, ref):
    intents = space(gw)["intents"]
    if ref in intents:
        return intents[ref]
    for intent in sorted(intents.values(), key=lambda i: i["created"], reverse=True):
        if (intent["ps"].get("booking") or "").lower() == str(ref).lower() or intent["id"].endswith(str(ref)):
            return intent
    return None


def authenticate(gw, intent, approve=True):
    """Finishes a 3-D Secure challenge as the cardholder would."""
    if intent["status"] != "requires_action":
        raise ValueError("This payment is not waiting for 3-D Secure")
    if approve:
        succeed(gw, intent, "cartão autenticado (3-D Secure)")
    else:
        intent["status"] = "requires_payment_method"
        intent["next_action"] = None
        intent["last_payment_error"] = {"type": "card_error", "code": "payment_intent_authentication_failure",
                                        "message": "The provided PaymentMethod has failed authentication."}
        gw.event(intent, "autenticação 3-D Secure recusada pelo titular", "bad")
        event(gw, intent, "payment_intent.payment_failed")


STATUS = {"requires_payment_method": "pendente", "requires_confirmation": "pendente", "requires_action": "pendente",
          "processing": "em_analise", "succeeded": "paga", "canceled": "cancelada"}


def charges(gw):
    result = []
    for intent in space(gw)["intents"].values():
        status = STATUS.get(intent["status"], intent["status"])
        if intent["status"] == "requires_payment_method" and intent["last_payment_error"]:
            status = "recusada"
        if intent["status"] == "succeeded":
            status = "contestada" if intent["dispute"] else "estornada" if intent["refunded"] >= intent["amount"] else \
                "estorno_parcial" if intent["refunded"] else "paga"
        method = resolve_method(gw, intent["payment_method"]) if intent["payment_method"] else None
        result.append({"gateway": NAME, "ref": intent["id"], "method": "card", "amount": intent["amount"], "status": status,
                       "gatewayStatus": intent["status"], "created": intent["created"], "expires": None, "paid": intent.get("paid"),
                       "booking": intent["ps"].get("booking"), "customer": intent["ps"].get("customer"),
                       "events": intent["ps"].get("events", []), "flags": intent["ps"].get("flags", []), "refunded": intent["refunded"],
                       "details": {"id": intent["id"], "payment_method": intent["payment_method"],
                                   "card": method["card"] if method else None, "last_payment_error": intent["last_payment_error"],
                                   "idempotency": intent["idempotency"], "dispute": intent["dispute"], "metadata": intent["metadata"]}})
    return result
