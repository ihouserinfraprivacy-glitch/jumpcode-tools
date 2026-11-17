# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Regressions from the TaskStudio review; no model, network or user data."""
import json
from unittest.mock import patch

from test_actions import StudioTestCase
from jumpcode_taskstudio import run, TaskStudioError
from jumpcode_taskstudio.authorization import check_effect
from jumpcode_taskstudio.plan import make_gates


class ReviewRegressions(StudioTestCase):
    def test_recalibration_keeps_the_host_request_identity(self):
        self.plan()
        self.call(action="start", id=1)
        self.call(action="edit", id=1, text="Alterar o contrato")
        self.assertEqual(self.load("plan.json")["recalibrating"]["requestId"], "request-1")
        self.context["request_id"] = "request-2"
        self.call(action="read")
        self.assertEqual(self.load("plan.json")["recalibrating"]["requestId"], "request-1")

    def plan(self):
        self.call(action="plan", title="Projeto", tasks=[{"title": "A", "criteria": ["C1", "C2"]},
                                                       {"title": "B", "deps": [1]}])

    def proposal(self):
        self.plan()
        self.call(action="start", id=1)
        self.call(action="edit", id=1, text="Mudar o contrato")
        self.call(action="propose", changes=[{"task": 1, "detail": "Contrato novo"}])

    def test_initial_start_and_finish_require_host_approval(self):
        self.plan()
        before = self.snapshot()
        for action in ("start", "finish"):
            for approve in (None, lambda details: False):
                with self.subTest(action=action, approve=approve):
                    with self.assertRaisesRegex(TaskStudioError, "approval control"):
                        run({"action": action, "id": 1}, self.context, approve=approve)
                    self.assertEqual(self.snapshot(), before)
        seen = []
        run({"action": "start", "id": 1}, self.context, approve=lambda d: seen.append(d) or True)
        self.assertEqual(seen[0]["plan"]["tasks"][0]["criteria"][0]["text"], "C1")
        self.assertEqual(self.task(1)["requestId"], "request-1")

    def test_apply_and_resolve_cannot_self_authorize(self):
        self.proposal()
        before = self.snapshot()
        for args in ({"action": "apply"}, {"action": "resolve", "id": 1}):
            with self.assertRaisesRegex(TaskStudioError, "approval control"):
                run(args, self.context)
            self.assertEqual(self.snapshot(), before)
        seen = []
        run({"action": "apply"}, self.context, approve=lambda d: seen.append(d) or True)
        self.assertEqual(seen[0]["proposal"]["changes"][0]["detail"], "Contrato novo")
        self.assertEqual(self.load("plan.json")["plan"], 2)

    def test_approval_cannot_be_reused_after_proposal_changes(self):
        self.proposal()
        def approve(details):
            self.call(action="propose", changes=[{"task": 1, "detail": "Outro contrato"}])
            return True
        with self.assertRaisesRegex(TaskStudioError, "changed while waiting"):
            run({"action": "apply"}, self.context, approve=approve)
        self.assertEqual(self.load("plan.json")["plan"], 1)
        self.assertEqual(self.load("proposal.json")["changes"][0]["detail"], "Outro contrato")

    def test_cancellation_after_consent_writes_nothing(self):
        self.proposal()
        before = self.snapshot()
        with self.assertRaisesRegex(TaskStudioError, "cancelled"):
            run({"action": "apply"}, self.context, approve=lambda _: True, cancelled=lambda: True)
        self.assertEqual(self.snapshot(), before)

    def test_pending_proposal_blocks_effects_until_discarded_or_applied(self):
        self.proposal()
        with self.assertRaisesRegex(TaskStudioError, "awaits approval"):
            check_effect(self.context)
        self.call(action="read")
        self.call(action="discard")
        check_effect(self.context)
        self.call(action="edit", id=1, text="Outro contrato")
        with self.assertRaises(TaskStudioError):
            check_effect(self.context)
        self.call(action="apply")
        check_effect(self.context)

    def test_atomic_apply_failure_keeps_plan_proposal_and_history(self):
        self.proposal()
        before = self.snapshot()
        with patch("jumpcode_taskstudio.common.os.replace", side_effect=OSError("disk")):
            self.assertIn("could not be saved", self.refusal(action="apply"))
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.load("plan.json")["plan"], 1)
        self.assertIsNotNone(self.load("proposal.json"))
        self.assertEqual(len(self.load("history.json")["versions"]), 1)
        self.call(action="apply")
        self.assertEqual(self.load("plan.json")["plan"], 2)
        self.assertIsNone(self.load("proposal.json"))
        self.assertEqual(len(self.load("history.json")["versions"]), 2)

    def test_legacy_documents_migrate_without_deleting_or_reusing_stale_versions(self):
        self.plan()
        documents = json.loads((self.studio / "state.json").read_text(encoding="utf-8"))["documents"]
        (self.studio / "state.json").unlink()
        for name, data in documents.items():
            (self.studio / name).write_text(json.dumps(data), encoding="utf-8")
        self.call(action="start", id=1)
        self.assertTrue((self.studio / "plan.json").exists())
        self.assertEqual(self.task(1)["state"], "running")
        (self.studio / "plan.json").write_text("broken legacy", encoding="utf-8")
        self.assertEqual(self.task(1)["state"], "running")

    def test_partial_or_unknown_criteria_do_not_complete_or_unlock_dependents(self):
        self.plan()
        self.call(action="start", id=1)
        for criteria in ([], ["1"], ["C1", "C2", "unknown"]):
            self.assertIn("unmet or unknown", self.refusal(action="finish", id=1, criteria=criteria))
            self.assertEqual(self.task(1)["state"], "running")
            self.assertIn("waits for #1", self.refusal(action="start", id=2))
        self.call(action="finish", id=1, criteria=["C1", "C2"])
        self.call(action="start", id=2)
        self.assertEqual(self.task(2)["state"], "running")

    def test_gate_identity_includes_conditions_beyond_label(self):
        gate = {"label": "Acesso", "kind": "secret", "env": "TEST_KEY", "where": ".env", "alternatives": ["Local"]}
        old = make_gates([gate]); old[0]["met"] = True
        self.assertTrue(make_gates([dict(gate)], old)[0]["met"])
        for change in ({"env": "PROD_KEY"}, {"kind": "approval"}, {"where": "other.env"}, {"alternatives": ["Remoto"]}):
            with self.subTest(change=change):
                self.assertFalse(make_gates([{**gate, **change}], old)[0]["met"])

    def test_explicit_and_omitted_empty_dependencies_allow_parallel_work(self):
        self.call(action="plan", title="Paralelo", tasks=[{"title": "A", "deps": []}, {"title": "B"}])
        self.assertEqual([t["deps"] for t in self.load("plan.json")["tasks"]], [[], []])
        self.call(action="start", id=2)
        self.assertEqual(self.task(1)["state"], "todo")

    def test_proposal_can_remove_dependencies_gates_and_criteria(self):
        self.call(action="plan", title="Projeto", tasks=[{"title": "A"}, {"title": "B", "deps": [1],
                  "criteria": ["C1"], "gates": [{"label": "Acesso", "kind": "approval"}]}])
        self.call(action="propose", changes=[{"task": 2, "deps": [], "gates": [], "criteria": []}])
        self.call(action="apply")
        self.assertEqual([self.task(2)[k] for k in ("deps", "gates", "criteria")], [[], [], []])
        self.call(action="start", id=2)

    def test_request_identity_changes_only_on_explicit_activity(self):
        self.plan()
        self.call(action="start", id=1)
        self.context["request_id"] = "request-2"
        self.call(action="read")
        self.call(action="focus", id=1)
        self.assertEqual(self.task(1)["requestId"], "request-1")
        self.call(action="start", id=1)
        self.assertEqual(self.task(1)["requestId"], "request-2")
