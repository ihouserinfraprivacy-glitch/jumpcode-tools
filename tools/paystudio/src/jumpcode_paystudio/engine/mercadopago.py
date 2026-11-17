# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Mercado Pago payments API (v1) under /mercadopago: card tokens, payments by card and by Pix, search, cancel,
refunds and chargebacks, X-Idempotency-Key, and the signed webhooks. Test cards decide by the cardholder name
(APRO, OTHE, CONT, CALL, FUND, SECU, EXPI, FORM) as in Mercado Pago's own test environment."""

import json
import re
import time

from . import brcode, wire
from .wire import GatewayError

NAME = "mercadopago"
RESULTS = {
    "APRO": ("approved", "accredited"), "OTHE": ("rejected", "cc_rejected_other_reason"), "CONT": ("in_process", "pending_contingency"),
    "CALL": ("rejected", "cc_rejected_call_for_authorize"), "FUND": ("rejected", "cc_rejected_insufficient_amount"),
    "SECU": ("rejected", "cc_rejected_bad_filled_security_code"), "EXPI": ("rejected", "cc_rejected_bad_filled_date"),
    "FORM": ("rejected", "cc_rejected_bad_filled_other"),
}
BRANDS = {"4": "visa", "5": "master", "3": "amex", "6": "elo"}
_KEY = re.compile(r"^(TEST|APP_USR)-")


def error(status, message, code="bad_request", causes=None):
    return GatewayError(status, {"message": message, "error": code, "status": status,
                                 "cause": [{"code": c[0], "description": c[1], "data": None} for c in (causes or [])]}, code, message)


def space(gw):
    return gw.state["mercadopago"]


def handle(gw, request, path):
    auth = request.headers.get("authorization", "")
    access = auth[7:].strip() if auth.lower().startswith("bearer ") else request.query.get("access_token", "")
    parts = [p for p in path.split("/") if p]
    if parts[:1] == ["v1"]:
        parts = parts[1:]
    public = parts[:1] == ["card_tokens"] and request.query.get("public_key")
    if not access and not public:
        raise error(401, "unauthorized", "unauthorized", [(2002, "Header Authorization: Bearer <access token> is missing")])
    if access.startswith("APP_USR-") or str(public or "").startswith("APP_USR-"):
        request.flag = "chave de produção (APP_USR-) enviada ao PayStudio; use as credenciais de teste (TEST-)"
        raise error(401, "PayStudio only accepts test credentials (TEST-). Check the app's environment.", "unauthorized")
    if not parts:
        raise error(404, "resource not found", "not_found")
    if parts[0] == "card_tokens" and request.method == "POST":
        request.op = "criar token de cartão"
        return card_token(gw, request)
    if parts[0] == "payments":
        return payments_call(gw, request, parts[1:])
    if parts[0] == "payment_methods":
        request.op = "meios de pagamento"
        return wire.json_response([{"id": i, "name": n, "payment_type_id": t, "status": "active"} for i, n, t in
                                   (("pix", "PIX", "bank_transfer"), ("visa", "Visa", "credit_card"), ("master", "Mastercard", "credit_card"),
                                    ("amex", "American Express", "credit_card"), ("elo", "Elo", "credit_card"))])
    raise error(404, f"PayStudio emulates payments, card_tokens and payment_methods of Mercado Pago; /v1/{'/'.join(parts)} is not emulated yet.", "not_found")


def _body(request):
    try:
        value = json.loads(request.body.decode("utf-8") or "{}")
    except (UnicodeDecodeError, ValueError):
        raise error(400, "Invalid JSON body", "bad_request")
    if not isinstance(value, dict):
        raise error(400, "The body must be a JSON object", "bad_request")
    return value


def card_token(gw, request):
    body = _body(request)
    number = re.sub(r"\D", "", str(body.get("card_number", "")))
    holder = (body.get("cardholder") or {}).get("name", "")
    if len(number) < 13:
        raise error(400, "invalid card_number", "bad_request", [("E205", "parameter cardNumber can not be null/empty")])
    if not body.get("security_code"):
        raise error(400, "invalid security_code", "bad_request", [("E302", "invalid parameter securityCode")])
    token = wire.token("", 32, "0123456789abcdef")
    record = {"id": token, "first_six_digits": number[:6], "last_four_digits": number[-4:], "cardholder": {"name": holder},
              "expiration_month": body.get("expiration_month"), "expiration_year": body.get("expiration_year"), "status": "active",
              "date_created": wire.iso_local(), "brand": BRANDS.get(number[0], "visa"), "created": time.time()}
    space(gw)["tokens"][token] = record
    request.note_res = {"id": token, "last_four_digits": number[-4:], "cardholder": holder}
    return wire.json_response({k: v for k, v in record.items() if k not in ("brand", "created")}, 201)


def payments_call(gw, request, parts):
    if not parts:
        if request.method != "POST":
            raise error(405, "method not allowed", "method_not_allowed")
        request.op = "criar pagamento"
        return create(gw, request)
    if parts[0] == "search":
        request.op = "buscar pagamentos"
        return search(gw, request)
    payment = space(gw)["payments"].get(parts[0])
    request.ref = parts[0]
    if payment is None:
        raise error(404, f"Payment not found", "not_found", [(2000, "Payment not found")])
    if len(parts) == 1:
        if request.method == "GET":
            request.op = "consultar pagamento"
            return wire.json_response(view(payment))
        if request.method == "PUT":
            request.op = "alterar pagamento"
            return update(gw, request, payment)
    if len(parts) >= 2 and parts[1] == "refunds":
        if request.method == "POST":
            request.op = "estornar"
            body = _body(request)
            return wire.json_response(refund(gw, payment, body.get("amount"), by="app"), 201)
        request.op = "listar estornos"
        return wire.json_response([{**r, "amount": r["amount"] / 100} for r in payment["refunds"]])
    raise error(404, "resource not found", "not_found")


def _idempotency(gw, request, body):
    key = request.headers.get("x-idempotency-key")
    if not key:
        raise error(400, "Header X-Idempotency-Key can't be null", "bad_request",
                    [(4292, "Header X-Idempotency-Key can't be null")])
    store = gw.state["idempotency"][NAME]
    fingerprint = json.dumps(body, sort_keys=True)
    if key in store:
        if store[key]["fingerprint"] != fingerprint:
            raise error(409, "The X-Idempotency-Key was already used with a different body", "conflict")
        return key, store[key]["payment"]
    return key, None


def create(gw, request):
    with gw.lock:
        return _create(gw, request)


def _create(gw, request):
    body = _body(request)
    key, previous = _idempotency(gw, request, body)
    if previous:
        request.ref = previous
        request.note_res = {"id": previous, "replayed": True}
        return wire.json_response(view(space(gw)["payments"][previous]), 201, {"X-Idempotency-Replayed": "true"})
    amount = body.get("transaction_amount")
    method = body.get("payment_method_id")
    causes = []
    if not isinstance(amount, (int, float)) or amount <= 0:
        causes.append((4037, "transaction_amount must be positive"))
    if not method:
        causes.append((4020, "payment_method_id attribute can't be null"))
    if not (body.get("payer") or {}).get("email"):
        causes.append((4050, "payer.email must be a valid email"))
    if method != "pix" and not body.get("token"):
        causes.append((2006, "Card Token not found"))
    if causes:
        raise error(400, causes[0][1], "bad_request", causes)
    from . import rules
    is_pix = method == "pix"
    plan = rules.payment_plan(gw, NAME, ("pay_after", "expire_after") if is_pix else ("decline", "pending"))
    with gw.lock:
        space(gw)["seq"] += 1
        payment_id = str(space(gw)["seq"])
    now = time.time()
    payer = body.get("payer") or {}
    customer = " ".join(filter(None, [payer.get("first_name"), payer.get("last_name")])) or payer.get("email")
    payment = {"id": payment_id, "created": now, "updated": now, "approved_at": None, "amount": wire.cents(amount), "method": method,
               "type": "bank_transfer" if is_pix else "credit_card", "description": body.get("description"),
               "external_reference": body.get("external_reference"), "notification_url": body.get("notification_url"),
               "payer": payer, "metadata": body.get("metadata") or {}, "installments": body.get("installments", 1), "refunds": [],
               "status": "pending", "status_detail": "pending_waiting_transfer" if is_pix else "pending", "idempotency": key,
               "expires": None, "card": None,
               "ps": {"booking": gw.booking_from(body.get("external_reference"), body.get("metadata"), body.get("description")),
                      "customer": customer, "events": [], "flags": []}}
    if is_pix:
        minutes = 30
        payment["expires"] = now + (plan["expire_after"] if plan["expire_after"] else minutes * 60)
        location = f"127.0.0.1:{gw.port}/mercadopago/pix/{payment_id}"
        payment["qr_code"] = brcode.dynamic(location, gw.settings.get("merchant", "BARBEARIA DO ZE"), gw.settings.get("city", "SAO PAULO"),
                                            wire.reais(payment["amount"]))
    else:
        token = space(gw)["tokens"].get(body.get("token"))
        if token is None:
            raise error(400, "Card Token not found", "bad_request", [(2006, "Card Token not found")])
        payment["card"] = {"first_six_digits": token["first_six_digits"], "last_four_digits": token["last_four_digits"],
                           "cardholder": token["cardholder"], "brand": token["brand"]}
        holder = (token["cardholder"].get("name") or "").strip().upper()[:4]
        status, detail = RESULTS.get(holder, ("approved", "accredited"))
        if plan["decline"]:
            status, detail = "rejected", rules.DECLINES[plan["decline"]][2]
        elif plan["pending"]:
            status, detail = "in_process", "pending_contingency"
        payment["status"], payment["status_detail"] = status, detail
        if status == "approved":
            payment["approved_at"] = now
    duplicate = _possible_duplicate(gw, payment)
    with gw.lock:
        space(gw)["payments"][payment_id] = payment
        gw.state["idempotency"][NAME][key] = {"fingerprint": json.dumps(body, sort_keys=True), "payment": payment_id}
    gw.event(payment, f"pagamento criado · {method} · {wire.brl(payment['amount'])} · {payment['status']}"
             + (f" ({payment['status_detail']})" if payment["status"] != "pending" else ""), "ok" if payment["status"] == "approved" else
             "bad" if payment["status"] == "rejected" else "info", "app")
    if duplicate:
        payment["ps"]["flags"].append({"kind": "duplicate", "text": f"mesmo valor e mesma referência do pagamento {duplicate} criado há pouco",
                                       "other": duplicate})
        gw.event(payment, f"possível cobrança duplicada: igual ao pagamento {duplicate}", "bad")
    if plan["labels"]:
        gw.event(payment, f"cenário: {', '.join(plan['labels'])}", "scenario")
    notify(gw, payment, "payment.created")
    if is_pix and plan["pay_after"] is not None:
        gw.later(plan["pay_after"], {"kind": "pay", "gateway": NAME, "ref": payment_id}, f"pagar Pix {payment_id}", payment_id)
    request.ref = payment_id
    request.note_res = {"id": payment_id, "status": payment["status"], "status_detail": payment["status_detail"]}
    return wire.json_response(view(payment), 201)


def _possible_duplicate(gw, payment):
    for other in space(gw)["payments"].values():
        if (other["amount"] == payment["amount"] and other["ps"].get("booking") and other["ps"]["booking"] == payment["ps"].get("booking")
                and payment["created"] - other["created"] < 30 and other["status"] in ("pending", "approved", "in_process")):
            return other["id"]
    return None


def view(payment):
    result = {
        "id": int(payment["id"]), "date_created": wire.iso_local(payment["created"]), "date_last_updated": wire.iso_local(payment["updated"]),
        "date_approved": wire.iso_local(payment["approved_at"]) if payment["approved_at"] else None,
        "money_release_date": None, "operation_type": "regular_payment", "payment_method_id": payment["method"],
        "payment_type_id": payment["type"], "status": payment["status"], "status_detail": payment["status_detail"], "currency_id": "BRL",
        "description": payment["description"], "live_mode": False, "external_reference": payment["external_reference"],
        "transaction_amount": payment["amount"] / 100, "transaction_amount_refunded": sum(r["amount"] for r in payment["refunds"]) / 100,
        "installments": payment["installments"], "notification_url": payment["notification_url"], "metadata": payment["metadata"],
        "payer": {k: v for k, v in payment["payer"].items() if k in ("email", "first_name", "last_name", "identification", "type")},
        "transaction_details": {"net_received_amount": round(payment["amount"] * 0.9501) / 100 if payment["status"] == "approved" else 0,
                                "total_paid_amount": payment["amount"] / 100, "installment_amount": payment["amount"] / 100},
        "refunds": [{**r, "amount": r["amount"] / 100} for r in payment["refunds"]], "captured": True,
    }
    if payment["card"]:
        result["card"] = {"first_six_digits": payment["card"]["first_six_digits"], "last_four_digits": payment["card"]["last_four_digits"],
                          "cardholder": payment["card"]["cardholder"]}
        result["payment_method_id"] = payment["card"]["brand"] if payment["method"] in ("", None) else payment["method"]
    if payment.get("qr_code"):
        from . import qr
        result["date_of_expiration"] = wire.iso_local(payment["expires"])
        result["point_of_interaction"] = {"type": "OPENPLATFORM", "transaction_data": {
            "qr_code": payment["qr_code"], "qr_code_base64": qr.data_url(payment["qr_code"]).split(",", 1)[1],
            "ticket_url": f"http://127.0.0.1/mercadopago/pix/{payment['id']}"}}
    return result


def search(gw, request):
    query = request.query
    results = [view(p) for p in sorted(space(gw)["payments"].values(), key=lambda p: p["created"], reverse=query.get("criteria") != "asc")
               if (not query.get("external_reference") or p["external_reference"] == query["external_reference"])
               and (not query.get("status") or p["status"] == query["status"])]
    limit = int(query.get("limit") or 30)
    offset = int(query.get("offset") or 0)
    return wire.json_response({"paging": {"total": len(results), "limit": limit, "offset": offset}, "results": results[offset:offset + limit]})


def update(gw, request, payment):
    body = _body(request)
    if body.get("status") == "cancelled":
        if payment["status"] not in ("pending", "in_process"):
            raise error(400, f"Payment can't be cancelled: status {payment['status']}", "bad_request")
        payment["status"], payment["status_detail"] = "cancelled", "by_collector"
        payment["updated"] = time.time()
        gw.event(payment, "cancelado pelo app", "warn", "app")
        notify(gw, payment, "payment.updated")
    return wire.json_response(view(payment))


# ---------------------------------------------------------------- what PayStudio simulates

def find(gw, ref):
    payments = space(gw)["payments"]
    if str(ref) in payments:
        return payments[str(ref)]
    for payment in sorted(payments.values(), key=lambda p: p["created"], reverse=True):
        if (payment["ps"].get("booking") or "").lower() == str(ref).lower() or str(payment["external_reference"] or "").lower() == str(ref).lower():
            return payment
    return None


def pay(gw, payment_id, by="PayStudio"):
    payment = space(gw)["payments"][str(payment_id)]
    if payment["status"] not in ("pending", "in_process"):
        raise ValueError(f"The payment is {payment['status']}")
    if payment["expires"] and time.time() > payment["expires"]:
        raise ValueError("The Pix of this payment expired")
    payment["status"], payment["status_detail"] = "approved", "accredited"
    payment["approved_at"] = payment["updated"] = time.time()
    gw.event(payment, f"aprovado · {wire.brl(payment['amount'])}", "ok", by)
    notify(gw, payment, "payment.updated")
    return payment


def refund(gw, payment, amount=None, by="PayStudio"):
    with gw.lock:
        return _refund(gw, payment, amount, by)


def _refund(gw, payment, amount=None, by="PayStudio"):
    if payment["status"] != "approved":
        raise error(400, f"Payment not approved: {payment['status']}", "bad_request")
    left = payment["amount"] - sum(r["amount"] for r in payment["refunds"])
    value = wire.cents(amount) if amount else left
    if value <= 0 or value > left:
        raise error(400, "Invalid refund amount", "bad_request", [(4206, "amount exceeds the available balance")])
    record = {"id": len(payment["refunds"]) + 2190000000, "payment_id": int(payment["id"]), "amount": value, "status": "approved",
              "date_created": wire.iso_local(), "source": {"type": "collector"}}
    payment["refunds"].append(record)
    if value == left:
        payment["status"], payment["status_detail"] = "refunded", "refunded"
    payment["updated"] = time.time()
    gw.event(payment, f"estorno de {wire.brl(value)}", "warn", by)
    notify(gw, payment, "payment.updated")
    return {**record, "amount": value / 100}


def chargeback(gw, payment):
    if payment["status"] != "approved":
        raise ValueError("Only an approved payment can have a chargeback")
    payment["status"], payment["status_detail"] = "charged_back", "in_process"
    payment["updated"] = time.time()
    gw.event(payment, "contestação aberta pelo titular do cartão (chargeback)", "bad")
    notify(gw, payment, "payment.updated")


def expire(gw, payment):
    payment["status"], payment["status_detail"] = "cancelled", "expired"
    payment["updated"] = time.time()
    gw.event(payment, "Pix venceu sem pagamento: Mercado Pago cancela e avisa por webhook", "warn")
    notify(gw, payment, "payment.updated")


def notify(gw, payment, action):
    from . import webhooks
    url = payment["notification_url"] or gw.webhook_url(NAME)
    payload = {"action": action, "api_version": "v1", "data": {"id": payment["id"]}, "date_created": wire.iso(),
               "id": int(time.time() * 1000) % 10_000_000_000, "live_mode": False, "type": "payment", "user_id": "1234567890"}
    delivery = webhooks.enqueue(gw, NAME, action, payment["id"], payload, url, booking=payment["ps"].get("booking"))
    gw.event(payment, f"webhook #{delivery['id']} {action}" + (f" · {delivery['note']}" if delivery.get("note") else ""), "webhook")


STATUS = {"pending": "pendente", "in_process": "em_analise", "approved": "paga", "rejected": "recusada", "cancelled": "cancelada",
          "refunded": "estornada", "charged_back": "contestada"}


def charges(gw):
    result = []
    for payment in space(gw)["payments"].values():
        status = STATUS.get(payment["status"], payment["status"])
        if payment["status"] == "cancelled" and payment["status_detail"] == "expired":
            status = "expirada"
        result.append({"gateway": NAME, "ref": payment["id"], "method": "pix" if payment["method"] == "pix" else "card",
                       "amount": payment["amount"], "status": status, "gatewayStatus": f"{payment['status']} · {payment['status_detail']}",
                       "created": payment["created"], "expires": payment["expires"], "paid": payment["approved_at"],
                       "booking": payment["ps"].get("booking"), "customer": payment["ps"].get("customer"),
                       "events": payment["ps"].get("events", []), "flags": payment["ps"].get("flags", []),
                       "refunded": sum(r["amount"] for r in payment["refunds"]),
                       "details": {"id": payment["id"], "payment_method_id": payment["method"], "status_detail": payment["status_detail"],
                                   "external_reference": payment["external_reference"], "idempotency": payment["idempotency"],
                                   "card": payment["card"], "pixCopiaECola": payment.get("qr_code"),
                                   "notification_url": payment["notification_url"]}})
    return result
