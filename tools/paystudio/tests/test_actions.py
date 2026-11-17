# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""The tool as the model uses it: arguments, the gateway's own process, the project's .env.local with test keys
that never reach a result, the payer's actions, scenarios, the signature check and the Studio files."""

import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parent))

from support import App, SECRETS, wait_for  # noqa: E402
import jumpcode_paystudio as tool  # noqa: E402
from jumpcode_paystudio import process  # noqa: E402
from jumpcode_paystudio.common import PayStudioError, read_json  # noqa: E402

KEYS = {"stripe_secret_key": "sk_test_ps_chave123", "stripe_publishable_key": "pk_test_ps_chave123", "mercadopago_access_token": "TEST-1234-ps",
        "mercadopago_public_key": "TEST-abcd-ps", "pix_client_id": "paystudio-teste", "pix_client_secret": "segredo-do-pix-987",
        "pix_key": "3b8c2f71-5a4e-4d19-9c07-e2a6b15f8d43", **SECRETS}


class ActionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.base = Path(tempfile.mkdtemp(prefix="paystudio-actions-"))
        cls.studio = cls.base / "studio"
        cls.project = cls.base / "barbearia"
        (cls.studio / "data").mkdir(parents=True)
        cls.project.mkdir()
        (cls.studio / "data" / "secrets.json").write_text(json.dumps(KEYS), encoding="utf-8")
        (cls.project / ".env.local").write_text("# minhas coisas\nPORTA=3000\nSTRIPE_SECRET_KEY=sk_test_antiga\n", encoding="utf-8")
        cls.context = {"studio_root": str(cls.studio), "source_root": str(cls.project)}
        cls.app = App()
        cls.results = []

    @classmethod
    def tearDownClass(cls):
        process.stop(cls.studio)
        cls.app.close()
        shutil.rmtree(cls.base, ignore_errors=True)

    def call(self, **arguments):
        result = tool.run(tool.validate(arguments), self.context)
        self.results.append(result)
        return result

    def http(self, method, path, headers, body=None, form=None):
        engine = process.running(self.studio)
        data = urllib.parse.urlencode(form).encode() if form is not None else json.dumps(body).encode() if body is not None else None
        kind = "application/x-www-form-urlencoded" if form is not None else "application/json"
        request = urllib.request.Request(engine.endpoint + path, data, method=method, headers={**headers, "Content-Type": kind})
        try:
            with urllib.request.urlopen(request, timeout=30) as answer:
                return answer.status, json.loads(answer.read() or b"null")
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read() or b"null")

    def test_flow(self):
        off = self.call(action="status")
        started = self.call(action="start")
        again = self.call(action="start")
        hooked = self.call(action="webhook", gateway="stripe", url=f"{self.app.url}/webhooks/stripe")
        pix_hook = self.call(action="webhook", gateway="pix", url=f"{self.app.url}/webhooks/pix")
        env = self.call(action="env")
        written = (self.project / ".env.local").read_text(encoding="utf-8")
        values = dict(line.split("=", 1) for line in written.splitlines() if "=" in line and not line.startswith("#"))

        # The app charges with the keys PayStudio wrote, the gateway answers like Stripe and signs the webhook.
        stripe = {"Authorization": f"Bearer {values['STRIPE_SECRET_KEY']}"}
        status, intent = self.http("POST", "/v1/payment_intents", stripe, form={"amount": 7000, "currency": "brl", "metadata[booking]": "AG-4830",
                                                                                "payment_method": "pm_card_visa", "confirm": "true"})
        stripe_hooks = wait_for(lambda: [r for r in self.app.received if r["body"].get("type") == "payment_intent.succeeded"], 8)

        # A Pix charge from the app, paid by the agent as the customer.
        pix = {"Authorization": "Bearer qualquer"}
        self.http("PUT", "/pix/v2/cob/AG4831corte0000000000000001", pix, {"calendario": {"expiracao": 900}, "valor": {"original": "45.00"},
                                                                         "chave": values["PIX_CHAVE"], "solicitacaoPagador": "AG-4831 corte"})
        paid = self.call(action="pay", ref="AG-4831", gateway="pix", url="ignorada")
        pix_hooks = wait_for(lambda: [r for r in self.app.received if r["path"] == "/webhooks/pix"], 8)
        detail = self.call(action="charge", ref="AG-4831")
        listed = self.call(action="charges", gateway="pix")

        scenario = self.call(action="scenario", name="cartao recusado")
        status_declined, declined = self.http("POST", "/v1/payment_intents", stripe, form={"amount": 3000, "currency": "brl", "metadata[booking]": "AG-4832",
                                                                                          "payment_method": "pm_card_visa", "confirm": "true"})
        failed_calls = self.call(action="calls", errors=True)
        check = self.call(action="check", gateway="stripe")
        hooks = self.call(action="webhooks", limit=20)
        focus = self.call(action="focus", view="webhooks", note="assinatura")
        pay_file = read_json(self.studio / "pay.json")
        stopped = self.call(action="stop")
        after = read_json(self.studio / "pay.json")

        self.assertEqual({
            "off": off["running"], "started": (started["running"], started["endpoint"].startswith("http://127.0.0.1:45")),
            "again": again["message"].startswith("Already running"), "hooked": (hooked["url"].endswith("/webhooks/stripe"), pix_hook["url"].endswith("/webhooks")),
            "env": (env["file"], env["replaced"], "STRIPE_WEBHOOK_SECRET" in env["variables"]),
            "kept": ("# (antes do PayStudio) STRIPE_SECRET_KEY=sk_test_antiga" in written, "PORTA=3000" in written,
                     values["STRIPE_API_URL"].endswith("/stripe"), values["STRIPE_WEBHOOK_SECRET"] == SECRETS["stripe_webhook"]),
            "stripe": (status, intent["status"], [r["valid"] for r in stripe_hooks]),
            "pix": (paid["booking"], [r["body"]["pix"][0]["valor"] for r in pix_hooks], detail["status"], [c["booking"] for c in listed["charges"]]),
            "ignored": "Ignored for pay: url" in paid["message"],
            "scenario": (scenario["scenario"], status_declined, declined["error"]["code"]),
            "calls": [c["status"] for c in failed_calls["calls"]],
            "check": check["ok"], "hooks": len(hooks["webhooks"]) >= 3, "focus": read_json(self.studio / "view.json")["view"],
            "file": (pay_file["status"], sorted(pay_file["gateways"])), "stopped": (stopped["running"], after["status"]),
        }, {
            "off": False, "started": (True, True), "again": True, "hooked": (True, True),
            "env": (".env.local", ["STRIPE_SECRET_KEY"], True), "kept": (True, True, True, True),
            "stripe": (200, "succeeded", [True]),
            "pix": ("AG-4831", ["45.00"], "paga", ["AG-4831"]), "ignored": True,
            "scenario": ("Próximo cartão recusado", 402, "card_declined"), "calls": [402],
            "check": True, "hooks": True, "focus": "webhooks",
            "file": ("running", ["mercadopago", "pix", "stripe"]), "stopped": (False, "stopped"),
        })
        # The test keys went to .env.local only: no result the model sees carries them. The Pix key is public
        # (it is printed in every QR Code), so it may show up inside a charge.
        shown = json.dumps(self.results, ensure_ascii=False)
        self.assertEqual([name for name, value in KEYS.items() if value in shown and name != "pix_key"], [])

    def test_arguments(self):
        problems = []
        for arguments in ({"action": "pagar"}, {"action": "webhook", "gateway": "paypal"}, {"action": "refund", "amount": "70"},
                          {"action": "pay", "delay": True}, {"action": "status", "senha": "x"}):
            try:
                tool.validate(arguments)
            except PayStudioError as error:
                problems.append(str(error))
        self.assertEqual([tool.validate({"action": "pay", "gateway": "Mercado Pago"})["gateway"],
                          tool.validate({"action": "scenario", "name": "Webhook-Duplicado"})["name"], len(problems)],
                         ["mercadopago", "webhook_duplicado", 5])

    def test_needs_studio_and_project(self):
        errors = []
        for context in ({}, {"studio_root": str(self.base / "missing")}):
            try:
                tool.run({"action": "status"}, context)
            except PayStudioError as error:
                errors.append(str(error))
        try:
            tool.run({"action": "env"}, {"studio_root": str(self.studio)})
        except PayStudioError as error:
            errors.append(str(error).split(".")[0])
        self.assertEqual(errors, ["PayStudio only works inside an open Studio", "The Studio folder is unavailable",
                                  "This needs the project's files"])

    def test_studio_ui_and_manifest(self):
        ui = tool.studio_ui()
        self.assertEqual([tool.MANIFEST["id"], tool.MANIFEST["studio"]["ui"], tool.MANIFEST["studio"]["mark"][:19],
                          tool.MANIFEST["studio"]["cover"][:15], bool(ui["css"]), "acquireVsCodeApi" in ui["js"]],
                         ["paystudio", True, "data:image/svg+xml;", "data:image/png;", True, True])


if __name__ == "__main__":
    unittest.main()
