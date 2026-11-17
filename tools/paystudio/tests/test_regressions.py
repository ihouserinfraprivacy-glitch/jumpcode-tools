# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Regression evidence for logging, atomic requests, webhook queues, refunds, recovery and cancellation."""

from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import stat
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.parse import urlencode

from support import App, LocalGateway, SECRETS, wait_for
from test_gateway import COB, MP, PIX, SK
from jumpcode_paystudio import process, run, validate
from jumpcode_paystudio.common import PayStudioError, merge_env_file
from jumpcode_paystudio.engine import admin, mercadopago, pix, rules, stripe, webhooks, wire
from jumpcode_paystudio.engine.core import Gateway, MAX_DELIVERIES, empty_state
from jumpcode_paystudio.engine.server import Request, handle


class StateRegressionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="paystudio-regression-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.gw = Gateway(self.root, 4570, persistent=True)

    def request(self, method, path, body=None, headers=None, form=None, raw=None):
        headers = dict(headers or {})
        if form is not None:
            raw = urlencode(form).encode()
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        elif raw is None:
            raw = json.dumps(body).encode() if body is not None else b""
            headers["Content-Type"] = "application/json"
        response = handle(self.gw, Request(method, path, headers, raw))
        return response.status, json.loads(response.body or b"null")

    def intent(self, **form):
        return self.request("POST", "/stripe/v1/payment_intents", headers=SK,
                            form={"amount": 1000, "currency": "brl", **form})

    def cob(self, txid="REVIEW000000000000000000001", key=None):
        status, data = self.request("PUT", f"/pix/v2/cob/{txid}", {**COB, "chave": key or COB["chave"]}, PIX)
        self.assertEqual(status, 201)
        return data

    def reload(self):
        self.gw.touch()
        self.gw.save()
        self.gw = Gateway(self.root, 4570, persistent=True)

    def test_form_errors_and_oauth_never_log_sensitive_values(self):
        status, _ = self.request("POST", "/stripe/v1/payment_methods", headers={"Authorization": "Bearer sk_live_dummy"},
                                 form={"card[number]": "4242424242424242", "card[cvc]": "SECRET-CVC"})
        self.assertEqual(status, 401)
        self.request("POST", "/oauth/token", form={"client_secret": "SECRET-OAUTH", "grant_type": "client_credentials"})
        self.request("POST", "/mercadopago/v1/payments", headers=MP, raw=b'{"card_number":"SECRET-BROKEN"')
        self.gw.flush()
        text = (self.root / "calls.json").read_text(encoding="utf-8")
        for sensitive in ("4242424242424242", "SECRET-CVC", "SECRET-OAUTH", "SECRET-BROKEN"):
            self.assertNotIn(sensitive, text)
        self.assertIn("401", text)

    def test_webhook_studio_payload_masks_client_secret(self):
        self.intent(confirm="true", payment_method="pm_card_visa")
        secret = next(iter(self.gw.state["stripe"]["intents"].values()))["client_secret"]
        self.gw.flush()
        self.assertNotIn(secret, (self.root / "webhooks.json").read_text(encoding="utf-8"))

    def test_declined_stripe_retries_replay_after_restart_and_reject_changed_body(self):
        headers = {**SK, "Idempotency-Key": "decline-once"}
        form = {"amount": 1000, "currency": "brl", "confirm": "true", "payment_method": "pm_card_chargeDeclinedInsufficientFunds"}
        first = self.request("POST", "/stripe/v1/payment_intents", headers=headers, form=form)
        self.assertEqual(first[0], 402)
        self.reload()
        self.assertEqual(self.request("POST", "/stripe/v1/payment_intents", headers=headers, form=form), first)
        self.assertEqual(len(self.gw.state["stripe"]["intents"]), 1)
        self.assertEqual(self.request("POST", "/stripe/v1/payment_intents", headers=headers, form={**form, "amount": 2000})[0], 400)

    def test_concurrent_idempotent_calls_create_one_payment_per_gateway(self):
        for gateway in ("stripe", "mercadopago"):
            with self.subTest(gateway=gateway):
                barrier = threading.Barrier(4)
                module, member = (stripe, "route") if gateway == "stripe" else (mercadopago, "_idempotency")
                original = getattr(module, member)

                def delayed(*args):
                    result = original(*args)
                    time.sleep(.03)  # widen the old read/mutate race without changing the answer
                    return result

                def submit(_):
                    barrier.wait(timeout=3)
                    if gateway == "stripe":
                        return self.request("POST", "/stripe/v1/payment_intents", headers={**SK, "Idempotency-Key": "parallel"},
                                            form={"amount": 1000, "currency": "brl"})
                    return self.request("POST", "/mercadopago/v1/payments", {"transaction_amount": 10, "payment_method_id": "pix", "payer": {"email": "test@example.invalid"}},
                                        {**MP, "X-Idempotency-Key": "parallel"})

                with patch.object(module, member, side_effect=delayed), ThreadPoolExecutor(max_workers=4) as pool:
                    results = list(pool.map(submit, range(4)))
                self.assertTrue(all(r[0] in (200, 201) for r in results), results)
                self.assertEqual(len({str(r[1]["id"]) for r in results}), 1)
                space = self.gw.state[gateway]["intents" if gateway == "stripe" else "payments"]
                self.assertEqual(len(space), 1)

    def test_mercadopago_production_credentials_are_rejected_without_mutation(self):
        for path, headers in (("/mercadopago/v1/payments", {"Authorization": "Bearer APP_USR-fake"}),
                              ("/mercadopago/v1/card_tokens?public_key=APP_USR-fake", {})):
            self.assertEqual(self.request("POST", path, {}, headers)[0], 401)
        self.assertEqual(self.gw.state["mercadopago"]["payments"], {})
        self.assertEqual(self.gw.state["mercadopago"]["tokens"], {})

    def test_invalid_persistent_state_is_preserved(self):
        self.gw.state_file.parent.mkdir()
        for value in ('{"schema":', json.dumps({**empty_state(), "schema": 999}), json.dumps({**empty_state(), "pix": []})):
            self.gw.state_file.write_text(value, encoding="utf-8")
            with self.assertRaises(ValueError):
                Gateway(self.root, 4570, persistent=True)
            self.assertEqual(self.gw.state_file.read_text(encoding="utf-8"), value)

    def test_persistent_refund_finishes_once_after_restart(self):
        cob = self.cob()
        record = pix.pay(self.gw, cob["txid"])
        pix.refund(self.gw, None, record, "refund1", "10.00")
        self.assertEqual(record["devolucoes"][0]["status"], "EM_PROCESSAMENTO")
        self.gw.state["scheduled"][0]["due"] = time.time() - 1
        self.reload()
        self.gw.tick()
        refund = self.gw.state["pix"]["pix"][record["endToEndId"]]["devolucoes"][0]
        self.assertEqual(refund["status"], "DEVOLVIDO")
        delivered = len(self.gw.state["deliveries"])
        self.reload()
        self.gw.tick()
        self.assertEqual(len(self.gw.state["deliveries"]), delivered)
        self.assertEqual(self.gw.pending_work(), [])

    def test_default_pix_refund_uses_remaining_balance_after_restart(self):
        for completed, partial, remaining in ((False, "10.01", "59.99"), (True, "10.00", "60.00")):
            with self.subTest(completed=completed):
                cob = self.cob(f"REVIEW00000000000000000000{int(completed)}")
                record = pix.pay(self.gw, cob["txid"])
                pix.refund(self.gw, None, record, "partial", partial)
                if completed:
                    pix.finish_refund(self.gw, record["endToEndId"], "partial")
                self.reload()
                self.gw.token = "refund-control"
                params = {"gateway": "pix", "ref": cob["txid"]}
                headers = {"X-PayStudio-Token": self.gw.token}
                self.assertEqual(self.request("POST", "/_paystudio/refund", params)[0], 403)
                self.assertEqual(self.request("POST", "/_paystudio/refund", {**params, "amount": 0}, headers)[0], 400)
                self.assertEqual(self.request("POST", "/_paystudio/refund", params, headers)[0], 200)
                record = self.gw.state["pix"]["pix"][record["endToEndId"]]
                self.assertEqual([d["valor"] for d in record["devolucoes"]], [partial, remaining])
                self.assertEqual(self.request("POST", "/_paystudio/refund", params, headers)[0], 400)
                for refund in record["devolucoes"]:
                    pix.finish_refund(self.gw, record["endToEndId"], refund["id"])
                self.assertEqual(self.request("POST", "/_paystudio/refund", params, headers)[0], 400)
                self.assertEqual(len(record["devolucoes"]), 2)

    def test_concurrent_default_pix_refunds_reserve_remaining_balance_once(self):
        cob = self.cob()
        record = pix.pay(self.gw, cob["txid"])
        pix.refund(self.gw, None, record, "partial", "10.00")
        self.gw.token = "refund-control"
        barrier = threading.Barrier(4)

        def submit(_):
            barrier.wait(timeout=3)
            return self.request("POST", "/_paystudio/refund", {"gateway": "pix", "ref": cob["txid"]},
                                {"X-PayStudio-Token": self.gw.token})[0]

        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(submit, range(4)))
        self.assertEqual(sorted(results), [200, 400, 400, 400])
        self.assertEqual([d["valor"] for d in record["devolucoes"]], ["10.00", "60.00"])

    def test_card_refund_balance_is_atomic_across_control_and_app_requests(self):
        self.gw.token = "refund-control"
        for gateway in ("stripe", "mercadopago"):
            for channels in (("control", "control"), ("control", "app"), ("app", "control"), ("app", "app")):
                for amounts in ((None, None), (6, 6), (4, 6)):
                    with self.subTest(gateway=gateway, channels=channels, amounts=amounts):
                        if gateway == "stripe":
                            _, charge = self.intent(confirm="true", payment_method="pm_card_visa")
                        else:
                            _, charge = self.request("POST", "/mercadopago/v1/payments",
                                                     {"transaction_amount": 10, "payment_method_id": "pix", "payer": {"email": "test@example.invalid"}},
                                                     {**MP, "X-Idempotency-Key": wire.token("refund-test")})
                            mercadopago.pay(self.gw, charge["id"])
                        ref = str(charge["id"])
                        entered, release, contending = threading.Event(), threading.Event(), threading.Event()
                        original_lock = self.gw.lock
                        member = "token" if gateway == "stripe" else "iso_local"
                        original = getattr(wire, member)

                        class ObservedLock:
                            def __enter__(self):
                                if threading.current_thread().name == "refund-contender":
                                    contending.set()
                                return original_lock.__enter__()

                            def __exit__(self, *args):
                                return original_lock.__exit__(*args)

                        def pause_after_validation(*args, **kwargs):
                            if (threading.current_thread().name == "refund-first" and not entered.is_set()
                                    and (member == "iso_local" or args[0] == "re_")):
                                entered.set()
                                if not release.wait(5):
                                    raise TimeoutError("Refund test did not release its first request")
                            return original(*args, **kwargs)

                        def submit(index):
                            threading.current_thread().name = "refund-first" if index == 0 else "refund-contender"
                            amount = {} if amounts[index] is None else {"amount": amounts[index]}
                            if channels[index] == "control":
                                return self.request("POST", "/_paystudio/refund", {"gateway": gateway, "ref": ref, **amount},
                                                    {"X-PayStudio-Token": self.gw.token})[0]
                            if gateway == "stripe":
                                form = {"payment_intent": ref}
                                if amount:
                                    form["amount"] = amount["amount"] * 100
                                return self.request("POST", "/stripe/v1/refunds", headers=SK, form=form)[0]
                            return self.request("POST", f"/mercadopago/v1/payments/{ref}/refunds", amount, MP)[0]

                        with patch.object(self.gw, "lock", ObservedLock()), patch.object(wire, member, side_effect=pause_after_validation):
                            with ThreadPoolExecutor(max_workers=2) as pool:
                                first = pool.submit(submit, 0)
                                try:
                                    self.assertTrue(entered.wait(3))
                                    second = pool.submit(submit, 1)
                                    self.assertTrue(contending.wait(3))
                                finally:
                                    release.set()
                                statuses = [first.result(timeout=3), second.result(timeout=3)]
                        successful = [status in (200, 201) for status in statuses]
                        self.assertEqual(successful, [True, amounts == (4, 6)])
                        if gateway == "stripe":
                            total = self.gw.state["stripe"]["intents"][ref]["refunded"]
                            refunds = [r for r in self.gw.state["stripe"]["refunds"].values() if r["payment_intent"] == ref]
                        else:
                            refunds = self.gw.state["mercadopago"]["payments"][ref]["refunds"]
                            total = sum(r["amount"] for r in refunds)
                        self.assertEqual((total, len(refunds)), (600, 1) if amounts == (6, 6) else (1000, 2 if amounts == (4, 6) else 1))

    def test_legacy_pending_refund_is_recovered_without_duplicate_jobs(self):
        cob = self.cob()
        record = pix.pay(self.gw, cob["txid"])
        pix.refund(self.gw, None, record, "legacy", "10.00")
        self.gw.state.pop("scheduled")
        self.reload()
        self.assertEqual(len(self.gw.pending_work()), 1)
        self.gw.tick()
        self.assertEqual(self.gw.state["pix"]["pix"][record["endToEndId"]]["devolucoes"][0]["status"], "DEVOLVIDO")

    def test_pending_pix_and_mercadopago_payments_survive_restart(self):
        rules.add_rule(self.gw, "any", "pay_after", {"seconds": 100}, times=2)
        cob = self.cob()
        code, mp = self.request("POST", "/mercadopago/v1/payments", {"transaction_amount": 10, "payment_method_id": "pix", "payer": {"email": "test@example.invalid"}},
                                {**MP, "X-Idempotency-Key": "delayed"})
        self.assertEqual(code, 201)
        self.assertEqual(len(self.gw.pending_work()), 2)
        for item in self.gw.state["scheduled"]:
            item["due"] = time.time() - 1
        self.reload()
        self.gw.tick()
        self.assertEqual(self.gw.state["pix"]["cobs"][cob["txid"]]["status"], "CONCLUIDA")
        self.assertEqual(self.gw.state["mercadopago"]["payments"][str(mp["id"])]["status"], "approved")

    def test_scheduled_stripe_dispute_preserves_due_time_and_runs_once(self):
        code, method = self.request("POST", "/stripe/v1/payment_methods", headers=SK,
                                    form={"type": "card", "card[number]": "4000000000000259"})
        self.assertEqual(code, 200)
        code, intent = self.intent(confirm="true", payment_method=method["id"])
        self.assertEqual(code, 200)
        due = self.gw.pending_work()[0]["due"]
        self.reload()
        self.assertEqual(self.gw.pending_work()[0]["due"], due)
        self.gw.tick()
        self.assertFalse(self.gw.state["stripe"]["disputes"])
        self.gw.state["scheduled"][0]["due"] = time.time() - 1
        self.gw.tick()
        self.reload()
        self.gw.tick()
        self.assertEqual(len(self.gw.state["stripe"]["disputes"]), 1)
        self.assertTrue(self.gw.state["stripe"]["intents"][intent["id"]]["dispute"])

    def test_public_start_preserves_corrupt_state_and_does_not_register_engine(self):
        self.gw.state_file.parent.mkdir()
        broken = '{"schema":1,'
        self.gw.state_file.write_text(broken, encoding="utf-8")
        with self.assertRaisesRegex(PayStudioError, "could not start"):
            process.start(self.root, "persistent", {})
        self.assertIsNone(process.running(self.root))
        self.assertEqual(self.gw.state_file.read_text(encoding="utf-8"), broken)

    def test_unreadable_saved_state_does_not_start_empty(self):
        with patch.object(Path, "read_text", side_effect=PermissionError("locked")), self.assertRaisesRegex(ValueError, "preserved"):
            Gateway(self.root, 4570, persistent=True)

    def test_deleted_pix_hook_stays_deleted_and_other_keys_keep_their_route(self):
        self.gw.settings["webhooks"] = {"pix": "http://127.0.0.1:12345/fallback"}
        for key in ("key-a", "key-b"):
            self.assertEqual(self.request("PUT", f"/pix/v2/webhook/{key}", {"webhookUrl": f"http://127.0.0.1:12345/{key}"}, PIX)[0], 200)
        self.assertEqual(self.request("DELETE", "/pix/v2/webhook/key-a", headers=PIX)[0], 204)
        self.reload()
        self.gw.settings["webhooks"] = {"pix": "http://127.0.0.1:12345/fallback"}
        self.assertEqual(self.request("GET", "/pix/v2/webhook/key-a", headers=PIX)[0], 404)
        for i, key in enumerate(("key-a", "key-b")):
            cob = self.cob(f"REVIEW00000000000000000000{i}", key)
            pix.pay(self.gw, cob["txid"])
        a, b = self.gw.state["deliveries"]
        self.assertEqual((a["state"], a["url"]), ("no_url", ""))
        self.assertEqual(b["url"], "http://127.0.0.1:12345/key-b/pix")

    def test_studio_flush_retries_after_windows_readonly_file_is_released(self):
        path = self.root / "pay.json"
        path.write_text('{"before":true}', encoding="utf-8")
        path.chmod(stat.S_IREAD)
        try:
            self.gw.touch("pay")
            with self.assertRaises(PermissionError):
                self.gw.flush()
            self.assertIn("pay", self.gw.dirty)
        finally:
            path.chmod(stat.S_IWRITE | stat.S_IREAD)
        self.gw.flush()
        self.assertNotIn("before", json.loads(path.read_text(encoding="utf-8")))
        self.assertFalse(self.gw.dirty)

    def test_env_duplicates_are_removed_without_losing_other_settings(self):
        path = self.root / ".env.local"
        path.write_text("KEEP=1\nSTRIPE_API_URL=old-a\nexport STRIPE_API_URL=old-b\n", encoding="utf-8")
        values = {"STRIPE_API_URL": "http://127.0.0.1:4570/stripe"}
        merge_env_file(path, values, "# PayStudio")
        once = path.read_text(encoding="utf-8")
        self.assertEqual([s for s in once.splitlines() if not s.startswith("#")], ["KEEP=1", "STRIPE_API_URL=" + values["STRIPE_API_URL"]])
        self.assertIn("old-a", once)
        self.assertIn("old-b", once)
        merge_env_file(path, values, "# PayStudio")
        self.assertEqual(path.read_text(encoding="utf-8"), once)


class WebhookQueueRegressionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="paystudio-webhook-regression-")
        self.addCleanup(self.tmp.cleanup)
        self.app = App()
        self.addCleanup(self.app.close)
        self.gw = Gateway(Path(self.tmp.name), 4570, persistent=True,
                          settings={"secrets": dict(SECRETS), "webhooks": {"stripe": self.app.url + "/hook"}})

    def enqueue(self, ref="payment", **kwargs):
        return webhooks.enqueue(self.gw, "stripe", "payment_intent.succeeded", ref, {"id": ref}, **kwargs)

    def settled(self, delivery):
        with self.gw.lock, webhooks._inflight_lock:
            return bool(delivery["attempts"]) and (id(self.gw), id(delivery)) not in webhooks._inflight

    def test_pending_and_held_deliveries_survive_history_limit_and_restart(self):
        rules.add_rule(self.gw, "stripe", "out_of_order", {})
        first = self.enqueue()
        for i in range(MAX_DELIVERIES):
            self.enqueue(str(i))
        copy = webhooks.resend(self.gw, first["id"])
        self.gw.save()
        restored = Gateway(self.gw.root, 4570, persistent=True)
        self.assertEqual([d["id"] for d in restored.state["deliveries"]], list(range(1, MAX_DELIVERIES + 3)))
        self.assertEqual([d["state"] for d in restored.state["deliveries"]], ["held"] + ["pending"] * (MAX_DELIVERIES + 1))
        self.assertEqual(restored.state["deliveries"][-1]["copy_of"], first["id"])
        self.assertEqual(copy["id"], restored.state["delivery_seq"])

    def test_only_completed_history_is_trimmed_on_enqueue_resend_and_completion(self):
        rules.add_rule(self.gw, "stripe", "out_of_order", {})
        held = self.enqueue("held")
        pending = self.enqueue("pending")
        for i in range(MAX_DELIVERIES + 2):
            terminal = self.enqueue(str(i), url="")
        webhooks.resend(self.gw, terminal["id"])
        self.assertEqual(len(self.gw.state["deliveries"]), MAX_DELIVERIES + 2)
        webhooks.deliver_due(self.gw)
        self.assertTrue(wait_for(lambda: self.settled(pending)))
        self.assertEqual((held["state"], pending["state"], len(self.app.received)), ("held", "delivered", 1))
        self.assertIn(held, self.gw.state["deliveries"])
        self.assertEqual(len(self.gw.state["deliveries"]), MAX_DELIVERIES + 1)
        self.gw.save()
        restored = Gateway(self.gw.root, 4570, persistent=True)
        self.assertEqual(len(restored.state["deliveries"]), MAX_DELIVERIES + 1)
        self.assertEqual(restored.state["deliveries"][0]["id"], held["id"])

    def test_parallel_dispatch_keeps_reservation_until_result_is_committed(self):
        entered, release, committing = threading.Event(), threading.Event(), threading.Event()
        self.addCleanup(release.set)
        verify = self.app.verify
        original_lock = self.gw.lock

        def slow(headers, body, path):
            entered.set()
            release.wait(3)
            return verify(headers, body, path)

        class ObservedLock:
            def __enter__(self):
                if threading.current_thread().name == "paystudio-webhook":
                    committing.set()
                return original_lock.__enter__()

            def __exit__(self, *args):
                return original_lock.__exit__(*args)

        self.app.verify = slow
        delivery = self.enqueue()
        with patch.object(self.gw, "lock", ObservedLock()):
            with ThreadPoolExecutor(max_workers=8) as pool:
                list(pool.map(lambda _: webhooks.deliver_due(self.gw), range(8)))
            self.assertTrue(entered.wait(3))
            with self.gw.lock:
                release.set()
                self.assertTrue(committing.wait(3))
                # The receiver has answered, but recording the result is blocked by this lock.
                with webhooks._inflight_lock:
                    self.assertIn((id(self.gw), id(delivery)), webhooks._inflight)
                for _ in range(8):
                    webhooks.deliver_due(self.gw)
            self.assertTrue(wait_for(lambda: self.settled(delivery)))
        webhooks.deliver_due(self.gw)
        self.assertEqual((delivery["state"], len(delivery["attempts"]), len(self.app.received)), ("delivered", 1, 1))

    def test_failed_attempt_keeps_backoff_and_can_retry_successfully(self):
        self.app.answer = 500
        delivery = self.enqueue()
        webhooks.deliver_due(self.gw)
        self.assertTrue(wait_for(lambda: self.settled(delivery)))
        self.assertEqual(delivery["state"], "pending")
        self.assertEqual(delivery["due"], delivery["attempts"][0]["at"] + webhooks.RETRIES[1])
        for _ in range(8):
            webhooks.deliver_due(self.gw)
        self.assertEqual(len(self.app.received), 1)
        with self.gw.lock:
            delivery["due"] = time.time() - 1
        self.app.answer = 200
        webhooks.deliver_due(self.gw)
        self.assertTrue(wait_for(lambda: self.settled(delivery)))
        self.assertEqual([entry["status"] for entry in delivery["attempts"]], [500, 200])
        self.assertEqual((delivery["state"], len(self.app.received)), ("delivered", 2))

    def test_reset_before_worker_starts_skips_old_delivery_without_blocking_reused_id(self):
        old = self.enqueue("before-reset")
        entered, release, finished = threading.Event(), threading.Event(), threading.Event()
        self.addCleanup(release.set)
        attempt = webhooks._attempt

        def delayed(gw, delivery, state):
            if delivery is old:
                entered.set()
                release.wait(4)
                try:
                    return attempt(gw, delivery, state)
                finally:
                    finished.set()
            return attempt(gw, delivery, state)

        with patch.object(webhooks, "_attempt", side_effect=delayed):
            webhooks.deliver_due(self.gw)
            try:
                self.assertTrue(entered.wait(3))
                admin.reset(self.gw, {})
                new = self.enqueue("after-reset")
                self.assertEqual(old["id"], new["id"])
                webhooks.deliver_due(self.gw)
                self.assertTrue(wait_for(lambda: self.settled(new), timeout=2))
            finally:
                release.set()
                self.assertTrue(finished.wait(3))
        self.assertEqual([item["body"]["id"] for item in self.app.received], ["after-reset"])
        self.assertEqual(old["attempts"], [])
        self.gw.save()
        restored = Gateway(self.gw.root, 4570, persistent=True)
        self.assertEqual([(d["ref"], d["state"]) for d in restored.state["deliveries"]], [("after-reset", "delivered")])

    def test_failed_signature_response_after_reset_does_not_restore_old_check(self):
        original = self.enqueue("before-reset")
        # The seed does not need dispatch: the check copies its payload and route.
        original["state"] = "delivered"
        baseline = rules.start_signature_check(self.gw, "stripe")
        entered, release, finished = threading.Event(), threading.Event(), threading.Event()
        self.addCleanup(release.set)
        verify = self.app.verify
        attempt = webhooks._attempt

        def slow(headers, body, path):
            entered.set()
            release.wait(4)
            return verify(headers, body, path)

        def observed(*args):
            try:
                return attempt(*args)
            finally:
                finished.set()

        self.app.verify = slow
        self.app.answer = 500
        with patch.object(webhooks, "_attempt", side_effect=observed):
            webhooks.deliver_due(self.gw)
            try:
                self.assertTrue(entered.wait(3))
                admin.reset(self.gw, {})
            finally:
                release.set()
                self.assertTrue(finished.wait(3))
        self.assertEqual((self.gw.state["checks"], self.gw.state["deliveries"], baseline["attempts"]), ([], [], []))


class LocalControlRegressionTests(unittest.TestCase):
    def setUp(self):
        self.g = LocalGateway()
        self.addCleanup(self.g.close)
        self.g.call("POST", "/stripe/v1/payment_intents", headers=SK, form={"amount": 1000, "currency": "brl"})
        self.assertTrue(wait_for(lambda: self.g.app.received))

    def test_signature_check_needs_accepted_control_and_rejected_forgery(self):
        for status in (404, 500, 400, 401, 403):
            with self.subTest(status=status):
                self.g.app.strict = False
                self.g.app.answer = status
                result = self.g.admin("check", {"gateway": "stripe"})
                self.assertIsNone(result["ok"])
                self.assertIn("inconclusivo", result["result"])
        self.g.app.answer = 200
        self.g.app.strict = True
        self.assertIs(self.g.admin("check", {"gateway": "stripe"})["ok"], True)
        self.g.app.strict = False
        self.assertIs(self.g.admin("check", {"gateway": "stripe"})["ok"], False)

    def test_failed_forgery_with_good_control_is_still_inconclusive(self):
        verify = self.g.app.verify
        def answer(headers, body, path):
            valid = verify(headers, body, path)
            self.g.app.answer = 200 if valid else 500
            return valid
        self.g.app.strict = False
        self.g.app.verify = answer
        result = self.g.admin("check", {"gateway": "stripe"})
        self.assertIsNone(result["ok"])
        self.assertEqual(self.g.gw.state["checks"][-1]["baselineStatus"], 200)

    def test_cancellation_interrupts_wait_without_stopping_gateway_or_followup_forgery(self):
        entered = threading.Event()
        release = threading.Event()
        self.addCleanup(release.set)
        verify = self.g.app.verify
        def slow(headers, body, path):
            entered.set()
            release.wait(3)
            return verify(headers, body, path)
        self.g.app.verify = slow
        engine = process.Engine(self.g.folder, None, self.g.gw.port, "test-token", "memory")
        context = {"studio_root": str(self.g.folder)}
        started = time.monotonic()
        with patch.object(process, "running", return_value=engine), self.assertRaisesRegex(PayStudioError, "cancelled"):
            run(validate({"action": "check", "gateway": "stripe"}), context, cancelled=entered.is_set)
        self.assertLess(time.monotonic() - started, 1.5)
        self.assertFalse(self.g.gw.operations.pending)
        before = len(self.g.gw.state["deliveries"])
        release.set()
        self.assertTrue(wait_for(lambda: self.g.gw.state["deliveries"][-1]["attempts"]))
        self.assertEqual(len(self.g.gw.state["deliveries"]), before)
        self.assertEqual(self.g.gw.state["checks"], [])
        self.assertTrue(self.g.admin("status")["running"])

    def test_control_cancellation_still_requires_token(self):
        code, _, _ = self.g.call("POST", "/_paystudio/operation-cancel", {"id": "a" * 24})
        self.assertEqual(code, 403)

    def test_reset_interrupts_old_check_and_preserves_new_check_with_reused_id(self):
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        verify = self.g.app.verify
        old_payload = self.g.app.received[0]["body"]

        def slow_old(headers, body, path):
            if json.loads(body) == old_payload:
                entered.set()
                release.wait(6)
            return verify(headers, body, path)

        self.g.app.verify = slow_old
        with ThreadPoolExecutor(max_workers=2) as pool:
            old_check = pool.submit(self.g.admin, "check", {"gateway": "stripe"})
            try:
                self.assertTrue(entered.wait(3))
                old_state = self.g.gw.state
                old_baseline = old_state["deliveries"][-1]
                self.assertEqual(self.g.admin("reset"), {"reset": True})
                code, _, _ = self.g.call("POST", "/stripe/v1/payment_intents", headers=SK, form={"amount": 2000, "currency": "brl"})
                self.assertEqual(code, 200)
                new_check = pool.submit(self.g.admin, "check", {"gateway": "stripe"})
                new_result = new_check.result(timeout=3)
                old_result = old_check.result(timeout=3)
                self.assertEqual(new_result["delivery"], old_baseline["id"])
                self.assertIs(new_result["ok"], True)
                self.assertIsNone(old_result["ok"])
                self.assertIn("limpos", old_result["result"])
                with self.g.gw.lock:
                    snapshot = json.dumps(self.g.gw.state, sort_keys=True)
            finally:
                release.set()
        def old_finished():
            with webhooks._inflight_lock:
                return (id(self.g.gw), id(old_baseline)) not in webhooks._inflight
        self.assertTrue(wait_for(old_finished, timeout=3))
        with self.g.gw.lock:
            self.assertEqual(json.dumps(self.g.gw.state, sort_keys=True), snapshot)
            self.assertEqual(len(self.g.gw.state["deliveries"]), 3)
            self.assertEqual(len(self.g.gw.state["checks"]), 1)
        self.assertEqual(old_baseline["attempts"], [])

    def test_reset_requires_token_and_preserves_settings(self):
        before = self.g.gw.state
        settings = dict(self.g.gw.settings)
        code, _, _ = self.g.call("POST", "/_paystudio/reset", {})
        self.assertEqual(code, 403)
        self.assertIs(self.g.gw.state, before)
        self.assertEqual(self.g.admin("reset"), {"reset": True})
        self.assertEqual(self.g.gw.settings, settings)


if __name__ == "__main__":
    unittest.main()
