# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Dev only: runs the "Barbearia do Zé" app's payments on a real fake gateway (Pix, Mercado Pago and Stripe
charges, the customer paying, webhooks the app fails, scenarios, a signature check and a few real bugs) and
saves the Studio files it produced in ui-dev/fixtures/barbearia, for the harness. Run from anywhere: python scenario.py"""

import json
from pathlib import Path
import shutil
import sys
import time

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "src"))
sys.path.insert(0, str(HERE.parent / "tests"))
from support import App, LocalGateway, wait_for  # noqa: E402

PIX = {"Authorization": "Bearer token-do-app"}
MP = {"Authorization": "Bearer TEST-1234-ps", "User-Agent": "MercadoPago Node.js SDK v2.0.15"}
STRIPE = {"Authorization": "Bearer sk_test_ps_barbearia", "User-Agent": "Stripe/v1 NodeBindings/16.2.0"}
CLIENTES = ["Carlos Andrade", "Marina Lopes", "João Pedro Silva", "Ana Beatriz Costa", "Rafael Souza", "Lucas Ferreira"]


def pix_charge(gateway, booking, amount, name, service, expires=900):
    txid = (booking.replace("-", "") + service.replace(" ", "") + "0" * 26)[:26]
    gateway.call("PUT", f"/pix/v2/cob/{txid}", {"calendario": {"expiracao": expires}, "devedor": {"cpf": "12345678909", "nome": name},
                                                "valor": {"original": f"{amount:.2f}"}, "chave": "3b8c2f71-5a4e-4d19-9c07-e2a6b15f8d43",
                                                "solicitacaoPagador": f"Barbearia do Zé · {booking} · {service}"},
                 {**PIX, "User-Agent": "axios/1.7.2"})
    return txid


def main():
    app = App()
    folder = HERE / ".scenario-studio"
    shutil.rmtree(folder, ignore_errors=True)
    folder.mkdir()
    g = LocalGateway(app=app, folder=folder)
    try:
        g.gw.settings["merchant"] = "BARBEARIA DO ZE"
        # Pix: paid, paid twice by the webhook (duplicate scenario), pending and expired.
        pix_charge(g, "AG-4826", 45, CLIENTES[0], "corte")
        g.admin("pay", {"ref": "AG-4826"})
        pix_charge(g, "AG-4827", 70, CLIENTES[1], "corte e barba")
        g.admin("scenario", {"name": "webhook_duplicado"})
        g.admin("pay", {"ref": "AG-4827"})
        pix_charge(g, "AG-4828", 35, CLIENTES[2], "barba", expires=1)
        time.sleep(1.5)
        g.admin("expire", {"ref": "AG-4828"})
        pix_charge(g, "AG-4830", 70, CLIENTES[3], "corte e barba")

        # Mercado Pago: card approved, card refused (no funds), Pix pending.
        token = g.call("POST", "/mercadopago/v1/card_tokens", {"card_number": "5031433215406351", "security_code": "123",
                                                                "expiration_month": 11, "expiration_year": 2030, "cardholder": {"name": "APRO"}}, MP)[1]["id"]
        g.call("POST", "/mercadopago/v1/payments", {"transaction_amount": 45, "payment_method_id": "master", "token": token,
                                                    "payer": {"email": "rafael@exemplo.com.br"}, "external_reference": "AG-4831",
                                                    "description": "Corte · AG-4831"}, {**MP, "X-Idempotency-Key": "ag-4831"})
        token = g.call("POST", "/mercadopago/v1/card_tokens", {"card_number": "4235647728025682", "security_code": "123",
                                                                "cardholder": {"name": "FUND"}}, MP)[1]["id"]
        g.call("POST", "/mercadopago/v1/payments", {"transaction_amount": 70, "payment_method_id": "visa", "token": token,
                                                    "payer": {"email": "lucas@exemplo.com.br"}, "external_reference": "AG-4832"},
               {**MP, "X-Idempotency-Key": "ag-4832"})
        g.call("POST", "/mercadopago/v1/payments", {"transaction_amount": 35, "payment_method_id": "pix", "payer": {"email": "a@exemplo.com.br"},
                                                    "external_reference": "AG-4833"}, MP)  # forgot the idempotency key: 400

        # Stripe: paid, refused, 3-D Secure waiting, refunded and disputed; the app's webhook route fails for a while.
        def intent(booking, amount, method, confirm=True):
            form = {"amount": amount, "currency": "brl", "metadata[booking]": booking, "description": f"Barbearia do Zé · {booking}"}
            if method:
                form.update({"payment_method": method, "confirm": "true" if confirm else "false"})
            return g.call("POST", "/v1/payment_intents", headers=STRIPE, form=form)[1]

        paid = intent("AG-4834", 7000, "pm_card_visa")
        intent("AG-4835", 4500, "pm_card_chargeDeclinedInsufficientFunds")
        intent("AG-4836", 3500, "pm_card_authenticationRequired")
        refunded = intent("AG-4837", 4500, "pm_card_mastercard")
        g.call("POST", "/v1/refunds", headers=STRIPE, form={"payment_intent": refunded["id"]})
        intent("AG-4838", 7000, "pm_card_createDispute")
        intent("AG-4839", 4500, None)
        intent("AG-4839", 4500, None)  # double click on "Pagar": possible duplicate
        g.call("GET", "/v1/customers/cus_123", headers=STRIPE)  # not emulated
        app.answer = 500
        intent("AG-4840", 3500, "pm_card_visa")
        time.sleep(0.4)
        app.answer = 200
        g.admin("check", {"gateway": "stripe"})
        app.strict = False
        g.admin("check", {"gateway": "stripe"})
        app.strict = True
        g.admin("scenario", {"name": "pix_atrasado_duplicado"})
        g.admin("failure", {"gateway": "mercadopago", "mode": "slow", "latency_ms": 6000, "calls": 3})
        wait_for(lambda: g.gw.state["stripe"]["disputes"] or None, 8)
        time.sleep(1.2)
        g.gw.flush()
        target = HERE / "fixtures" / "barbearia"
        target.mkdir(parents=True, exist_ok=True)
        for name in ("pay.json", "charges.json", "webhooks.json", "calls.json"):
            data = json.loads((folder / name).read_text(encoding="utf-8"))
            (target / name).write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        (target / "settings.json").write_text(json.dumps({"schema": 1, "storage": "memory", "gateways": ["pix", "mercadopago", "stripe"],
                                                          "webhooks": {"pix": f"{app.url}/webhooks", "mercadopago": f"{app.url}/webhooks/mp",
                                                                       "stripe": f"{app.url}/webhooks/stripe"},
                                                          "merchant": "BARBEARIA DO ZE", "city": "SAO PAULO"}, indent=1), encoding="utf-8")
        print("saved", sorted(p.name for p in target.iterdir()), "paid", paid["id"])
    finally:
        g.close()
        shutil.rmtree(folder, ignore_errors=True)


if __name__ == "__main__":
    main()
