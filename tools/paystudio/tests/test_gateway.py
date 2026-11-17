# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""The fake gateway as an app sees it: the three APIs answer in their own formats, webhooks arrive signed, and
the scenarios and failure controls change what happens. A small local app receives the webhooks."""

import json
from pathlib import Path
import sys
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from jumpcode_paystudio.engine import brcode  # noqa: E402
from support import LocalGateway, wait_for  # noqa: E402

PIX = {"Authorization": "Bearer token-de-teste"}
MP = {"Authorization": "Bearer TEST-1234567890"}
SK = {"Authorization": "Bearer sk_test_paystudio"}
COB = {"calendario": {"expiracao": 900}, "devedor": {"cpf": "12345678909", "nome": "Carlos Andrade"}, "valor": {"original": "70.00"},
       "chave": "3b8c2f71-5a4e-4d19-9c07-e2a6b15f8d43", "solicitacaoPagador": "Barbearia do Zé · AG-4830 · corte e barba"}


def lower(headers):
    return {k.lower(): v for k, v in headers.items()}


class GatewayTest(unittest.TestCase):
    def setUp(self):
        self.g = LocalGateway()

    def tearDown(self):
        self.g.close()

    def received(self, predicate, count=1, timeout=8):
        return wait_for(lambda: [r for r in self.g.app.received if predicate(r)] if len([r for r in self.g.app.received if predicate(r)]) >= count else None, timeout)


class PixTests(GatewayTest):
    def test_charge_payment_webhook_and_refund(self):
        g = self.g
        missing = g.call("PUT", "/pix/v2/cob/AG4830corteebarba0000000001", COB)
        bad = g.call("PUT", "/pix/v2/cob/AG4830corteebarba0000000001", {**COB, "valor": {"original": "70"}}, PIX)
        created = g.call("PUT", "/pix/v2/cob/AG4830corteebarba0000000001", COB, PIX)
        qr = g.call("GET", f"/pix/v2/loc/{created[1]['loc']['id']}/qrcode", None, PIX)[1]
        paid = g.admin("pay", {"ref": "AG-4830"})
        webhook = self.received(lambda r: r["path"] == "/webhooks/pix")[0]
        after = g.call("GET", "/pix/v2/cob/AG4830corteebarba0000000001", None, PIX)[1]
        e2e = webhook["body"]["pix"][0]["endToEndId"]
        devolucao = g.call("PUT", f"/pix/v2/pix/{e2e}/devolucao/D1", {"valor": "70.00"}, PIX)[1]
        refunded = self.received(lambda r: r["path"] == "/webhooks/pix" and r["body"]["pix"][0].get("devolucoes"))[0]
        self.assertEqual({
            "missing token": (missing[0], missing[1]["type"].rsplit("/", 1)[1]),
            "bad value": (bad[0], bad[1]["violacoes"][0]["propriedade"]),
            "created": (created[0], created[1]["status"], brcode.valid(created[1]["pixCopiaECola"]), qr["qrcode"] == created[1]["pixCopiaECola"],
                        qr["imagemQrcode"].startswith("data:image/png;base64,")),
            "paid": paid["booking"], "webhook": (webhook["body"]["pix"][0]["txid"], webhook["body"]["pix"][0]["valor"]),
            "after": (after["status"], after["pix"][0]["endToEndId"] == e2e),
            "refund": (devolucao["status"], refunded["body"]["pix"][0]["devolucoes"][0]["status"]),
        }, {
            "missing token": (401, "AcessoNegado"), "bad value": (400, "cob.valor.original"),
            "created": (201, "ATIVA", True, True, True), "paid": "AG-4830", "webhook": ("AG4830corteebarba0000000001", "70.00"),
            "after": ("CONCLUIDA", True), "refund": ("EM_PROCESSAMENTO", "DEVOLVIDO"),
        })

    def test_expiration_has_no_webhook_and_cannot_be_paid(self):
        g = self.g
        g.admin("rule", {"gateway": "pix", "kind": "expire_after", "params": {"seconds": 1}})
        g.call("PUT", "/pix/v2/cob/AG4828corte000000000000000001", {**COB, "solicitacaoPagador": "AG-4828"}, PIX)
        time.sleep(1.6)
        refused = g.admin("pay", {"ref": "AG-4828"})
        charges = json.loads((g.folder / "charges.json").read_text(encoding="utf-8"))["charges"] if wait_for(
            lambda: (g.folder / "charges.json").exists(), 3) else []
        status = next((c["status"] for c in charges if c["booking"] == "AG-4828"), None)
        self.assertEqual((refused["error"], "expiration" in refused["message"], status, g.app.received), ("ValueError", True, "expirada", []))

    def test_webhook_url_must_be_local(self):
        answer = self.g.call("PUT", "/pix/v2/webhook/minha-chave", {"webhookUrl": "https://exemplo.com.br/pix"}, PIX)
        self.assertEqual((answer[0], answer[1]["type"].rsplit("/", 1)[1]), (400, "WebhookOperacaoInvalida"))


class MercadoPagoTests(GatewayTest):
    def token(self, holder):
        return self.g.call("POST", "/mercadopago/v1/card_tokens", {"card_number": "5031433215406351", "security_code": "123", "expiration_month": 11,
                                                                   "expiration_year": 2030, "cardholder": {"name": holder}}, MP)[1]["id"]

    def payment(self, body, key):
        return self.g.call("POST", "/mercadopago/v1/payments", {"payer": {"email": "carlos@exemplo.com"}, **body}, {**MP, "X-Idempotency-Key": key})

    def test_cards_pix_refund_and_signed_webhooks(self):
        g = self.g
        no_key = g.call("POST", "/mercadopago/v1/payments", {"transaction_amount": 45, "payment_method_id": "pix", "payer": {"email": "a@b.com"}}, MP)
        card = self.token("APRO")
        approved = self.payment({"transaction_amount": 45, "payment_method_id": "master", "token": card, "external_reference": "AG-4831"}, "k1")
        replay = self.payment({"transaction_amount": 45, "payment_method_id": "master", "token": card, "external_reference": "AG-4831"}, "k1")
        conflict = self.payment({"transaction_amount": 99, "payment_method_id": "master", "token": card, "external_reference": "AG-4831"}, "k1")
        results = {holder: self.payment({"transaction_amount": 30, "payment_method_id": "master", "token": self.token(holder)}, f"k-{holder}")[1]["status_detail"]
                   for holder in ("FUND", "OTHE", "CONT", "SECU")}
        pix = self.payment({"transaction_amount": 20, "payment_method_id": "pix", "external_reference": "AG-4833"}, "k3")[1]
        g.admin("pay", {"ref": "AG-4833", "gateway": "mercadopago"})
        refund = g.call("POST", f"/mercadopago/v1/payments/{pix['id']}/refunds", {}, MP)
        refunded = g.call("GET", f"/mercadopago/v1/payments/{pix['id']}", None, MP)[1]
        hooks = self.received(lambda r: r["path"].startswith("/webhooks/mp"), 3)
        self.assertEqual({
            "no key": (no_key[0], no_key[1]["cause"][0]["code"]), "approved": (approved[0], approved[1]["status"], approved[1]["status_detail"]),
            "replay": (replay[1]["id"] == approved[1]["id"], conflict[0]), "results": results,
            "pix": (pix["status"], brcode.valid(pix["point_of_interaction"]["transaction_data"]["qr_code"])),
            "refund": (refund[0], refunded["status"], refunded["transaction_amount_refunded"]),
            "webhooks": ({r["body"]["action"] for r in hooks} >= {"payment.created", "payment.updated"}, all(r["valid"] for r in hooks),
                         all("data.id=" in r["path"] and "type=payment" in r["path"] for r in hooks)),
        }, {
            "no key": (400, 4292), "approved": (201, "approved", "accredited"), "replay": (True, 409),
            "results": {"FUND": "cc_rejected_insufficient_amount", "OTHE": "cc_rejected_other_reason", "CONT": "pending_contingency",
                        "SECU": "cc_rejected_bad_filled_security_code"},
            "pix": ("pending", True), "refund": (201, "refunded", 20.0), "webhooks": (True, True, True),
        })

    def test_unpaid_pix_expires_with_webhook(self):
        self.g.admin("rule", {"gateway": "mercadopago", "kind": "expire_after", "params": {"seconds": 1}})
        pix = self.payment({"transaction_amount": 20, "payment_method_id": "pix", "external_reference": "AG-4840"}, "k9")[1]
        hook = self.received(lambda r: r["path"].startswith("/webhooks/mp") and r["body"]["action"] == "payment.updated", 1, 6)
        after = self.g.call("GET", f"/mercadopago/v1/payments/{pix['id']}", None, MP)[1]
        self.assertEqual((bool(hook), after["status"], after["status_detail"]), (True, "cancelled", "expired"))


class StripeTests(GatewayTest):
    def intent(self, form, headers=None):
        return self.g.call("POST", "/v1/payment_intents", headers={**SK, **(headers or {})}, form=form)

    def test_intents_cards_refund_dispute_and_events(self):
        g = self.g
        live = self.intent({"amount": 7000, "currency": "brl"}, {"Authorization": "Bearer sk_live_123"})
        ok = self.intent({"amount": 7000, "currency": "brl", "metadata[booking]": "AG-4836", "payment_method": "pm_card_visa", "confirm": "true"})[1]
        declined = self.intent({"amount": 3000, "currency": "brl", "payment_method": "pm_card_chargeDeclinedInsufficientFunds", "confirm": "true"})
        method = g.call("POST", "/v1/payment_methods", headers=SK, form={"type": "card", "card[number]": "4000000000000002", "card[exp_month]": "12",
                                                                        "card[exp_year]": "2030", "card[cvc]": "123"})[1]
        generic = self.intent({"amount": 3000, "currency": "brl", "payment_method": method["id"], "confirm": "true"})
        three_ds = self.intent({"amount": 4500, "currency": "brl", "payment_method": "pm_card_authenticationRequired", "confirm": "true"})[1]
        g.admin("pay", {"ref": three_ds["id"]})
        authenticated = g.call("GET", f"/v1/payment_intents/{three_ds['id']}", headers=SK)[1]
        refund = g.call("POST", "/v1/refunds", headers=SK, form={"payment_intent": ok["id"], "amount": "2000"})[1]
        too_much = g.call("POST", "/v1/refunds", headers=SK, form={"payment_intent": ok["id"], "amount": "9000"})
        dispute = self.intent({"amount": 2000, "currency": "brl", "payment_method": "pm_card_createDispute", "confirm": "true"})[1]
        events = self.received(lambda r: r["path"] == "/webhooks/stripe" and r["body"]["type"] == "charge.dispute.created", 1, 8)
        types = {r["body"]["type"] for r in self.g.app.received if r["path"] == "/webhooks/stripe"}
        signed = all(r["valid"] for r in self.g.app.received if r["path"] == "/webhooks/stripe")
        self.assertEqual({
            "live key": live[0], "ok": ok["status"], "declined": (declined[0], declined[1]["error"]["decline_code"]),
            "generic": (generic[0], generic[1]["error"]["code"], "card[cvc]" in json.dumps(method)), "3ds": (three_ds["status"], authenticated["status"]),
            "refund": (refund["status"], refund["amount"], too_much[1]["error"]["code"]), "dispute": (dispute["status"], bool(events)),
            "events": types >= {"payment_intent.created", "payment_intent.succeeded", "payment_intent.payment_failed", "charge.refunded",
                                "payment_intent.requires_action", "charge.dispute.created"}, "signed": signed,
        }, {
            "live key": 401, "ok": "succeeded", "declined": (402, "insufficient_funds"), "generic": (402, "card_declined", False),
            "3ds": ("requires_action", "succeeded"), "refund": ("succeeded", 2000, "amount_too_large"), "dispute": ("succeeded", True),
            "events": True, "signed": True,
        })

    def test_idempotency_and_duplicate_charges(self):
        first = self.intent({"amount": 4500, "currency": "brl"}, {"Idempotency-Key": "abc"})
        again = self.intent({"amount": 4500, "currency": "brl"}, {"Idempotency-Key": "abc"})
        conflict = self.intent({"amount": 9900, "currency": "brl"}, {"Idempotency-Key": "abc"})
        one = self.intent({"amount": 4500, "currency": "brl", "metadata[booking]": "AG-4833"})[1]
        two = self.intent({"amount": 4500, "currency": "brl", "metadata[booking]": "AG-4833"})[1]
        status = self.g.admin("status")
        self.assertEqual((again[1]["id"] == first[1]["id"], again[2].get("Idempotent-Replayed"), conflict[1]["error"]["type"],
                          any(one["id"] in line or "AG-4833" in line for line in status["attention"]), two["id"] != one["id"]),
                         (True, "true", "idempotency_error", True, True))


class ScenarioTests(GatewayTest):
    def test_duplicated_late_and_out_of_order_webhooks(self):
        g = self.g
        g.admin("scenario", {"name": "webhook_duplicado"})
        dup = g.call("POST", "/v1/payment_intents", headers=SK, form={"amount": 2000, "currency": "brl"})[1]
        copies = self.received(lambda r: r["body"].get("data", {}).get("object", {}).get("id") == dup["id"], 2, 6)
        g.admin("rule", {"gateway": "stripe", "kind": "delay", "params": {"seconds": 2}})
        started = time.time()
        late = g.call("POST", "/v1/payment_intents", headers=SK, form={"amount": 2100, "currency": "brl"})[1]
        arrived = self.received(lambda r: r["body"].get("data", {}).get("object", {}).get("id") == late["id"], 1, 6)
        delay = time.time() - started
        g.admin("scenario", {"name": "webhook_fora_de_ordem"})
        order = g.call("POST", "/v1/payment_intents", headers=SK, form={"amount": 2200, "currency": "brl", "payment_method": "pm_card_visa", "confirm": "true"})[1]
        both = self.received(lambda r: r["body"].get("data", {}).get("object", {}).get("id") == order["id"], 2, 25)
        self.assertEqual((len(copies), bool(arrived) and delay >= 1.9, [r["body"]["type"] for r in both]),
                         (2, True, ["payment_intent.succeeded", "payment_intent.created"]))

    def test_signature_check_and_failures(self):
        g = self.g
        g.call("POST", "/v1/payment_intents", headers=SK, form={"amount": 2000, "currency": "brl"})
        self.received(lambda r: r["path"] == "/webhooks/stripe")
        strict = g.admin("check", {"gateway": "stripe"})
        g.app.strict = False
        careless = g.admin("check", {"gateway": "stripe"})
        g.admin("failure", {"gateway": "stripe", "mode": "unavailable", "calls": 1})
        down = g.call("GET", "/v1/payment_intents", headers=SK)
        back = g.call("GET", "/v1/payment_intents", headers=SK)
        g.admin("failure", {"gateway": "mercadopago", "mode": "rate_limit", "calls": 1})
        limited = g.call("GET", "/mercadopago/v1/payments/search", None, MP)
        # A forged webhook goes once, even when the app refuses it, and it is not a failing webhook to retry.
        with g.gw.lock:
            forged = [(d["state"], len(d["attempts"])) for d in g.gw.state["deliveries"] if d["signature"] == "wrong"]
        attention = [a["kind"] for a in __import__("jumpcode_paystudio.engine.views", fromlist=["pay_file"]).pay_file(g.gw)["attention"]]
        self.assertEqual((strict["ok"], careless["ok"], "aceitou" in careless["result"], down[0], back[0], limited[0], forged, attention),
                         (True, False, True, 503, 200, 429, [("delivered", 1), ("delivered", 1)], ["signature"]))

    def test_requests_must_come_from_this_computer(self):
        foreign = self.g.call("GET", "/v1/payment_intents", headers={**SK, "Host": "exemplo.com"})
        origin = self.g.call("GET", "/v1/payment_intents", headers={**SK, "Origin": "https://exemplo.com"})
        local = self.g.call("GET", "/v1/payment_intents", headers={**SK, "Origin": "http://localhost:3000"})
        self.assertEqual((foreign[0], origin[0], local[0], local[2].get("Access-Control-Allow-Origin")), (403, 403, 200, "http://localhost:3000"))


class StudioFilesTests(GatewayTest):
    def test_files_never_hold_card_numbers_or_secrets(self):
        g = self.g
        g.call("POST", "/v1/payment_methods", headers=SK, form={"type": "card", "card[number]": "4242424242424242", "card[cvc]": "987"})
        g.call("POST", "/mercadopago/v1/card_tokens", {"card_number": "5031433215406351", "security_code": "321", "cardholder": {"name": "APRO"}}, MP)
        g.call("POST", "/v1/payment_intents", headers=SK, form={"amount": 2000, "currency": "brl", "payment_method": "pm_card_visa", "confirm": "true"})
        self.received(lambda r: r["path"] == "/webhooks/stripe")
        time.sleep(0.8)
        text = "".join(p.read_text(encoding="utf-8") for p in g.folder.glob("*.json"))
        self.assertEqual(("4242424242424242" in text, "5031433215406351" in text, '"987"' in text, '"321"' in text, "whsec_test_paystudio" in text,
                          "mp_test_secret" in text, sorted(p.name for p in g.folder.glob("*.json"))),
                         (False, False, False, False, False, False, ["calls.json", "charges.json", "pay.json", "webhooks.json"]))


if __name__ == "__main__":
    unittest.main()
