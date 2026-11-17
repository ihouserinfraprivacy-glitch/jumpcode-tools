# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Workflow deadlines, including real local function execution and host cancellation."""

from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from jumpcode_cloudstudio import process, run, validate
from jumpcode_cloudstudio.engine import operation
from jumpcode_cloudstudio.engine.server import Cloud
from jumpcode_cloudstudio.engine.services import stepfunctions as sfn
from jumpcode_cloudstudio.engine.services.common import Caller


def flow(state, timeout=1):
    return {"StartAt": "Work", "TimeoutSeconds": timeout, "States": {"Work": state}}


class WorkflowDeadlineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.cloud = Cloud(Path(self.temp.name), 0)
        self.caller = Caller()
        self.sequence = 0

    def tearDown(self):
        self.cloud.shutdown()
        self.temp.cleanup()

    def execute(self, definition):
        self.sequence += 1
        arn = sfn.create_machine(self.cloud, self.caller, {
            "name": f"deadline-{self.sequence}", "definition": json.dumps(definition),
        })["stateMachineArn"]
        started = time.monotonic()
        result = sfn.start_sync(self.cloud, self.caller, {"stateMachineArn": arn})
        elapsed = time.monotonic() - started
        machine = sfn.machine_of(self.cloud, self.caller, arn)
        execution = machine["executions"][result["name"]]
        return result, execution, elapsed

    def assert_timed_out(self, result, execution):
        self.assertEqual(result["status"], "TIMED_OUT")
        self.assertEqual(result["error"], "States.Timeout")
        self.assertNotIn("output", result)
        self.assertFalse(any(step["status"] == "running" for step in execution["steps"]))
        self.assertTrue(all(step["ended"] is not None for step in execution["steps"]))
        events = [event["type"] for event in execution["history"]]
        self.assertEqual(events[-1], "ExecutionTimedOut")
        self.assertNotIn("ExecutionSucceeded", events)

    def test_final_wait_times_out_instead_of_reporting_success(self):
        result, execution, elapsed = self.execute(flow({"Type": "Wait", "Seconds": 3, "End": True}))
        self.assert_timed_out(result, execution)
        self.assertGreaterEqual(elapsed, 0.95)
        self.assertLess(elapsed, 2)

    def test_completed_flow_succeeds_after_a_previous_timeout(self):
        self.execute(flow({"Type": "Wait", "Seconds": 3, "End": True}))
        result, _, elapsed = self.execute(flow({"Type": "Wait", "Seconds": 0, "End": True}))
        self.assertEqual(result["status"], "SUCCEEDED")
        self.assertLess(elapsed, 0.5)
        operation.check()

    def test_nested_states_share_the_workflow_deadline(self):
        branch = {"StartAt": "Wait", "States": {"Wait": {"Type": "Wait", "Seconds": 3, "End": True}}}
        states = [
            {"Type": "Parallel", "Branches": [branch], "End": True},
            {"Type": "Map", "Parameters": {"items": [1]}, "ItemsPath": "$.items", "Iterator": branch, "End": True},
        ]
        for state in states:
            with self.subTest(kind=state["Type"]):
                result, execution, elapsed = self.execute(flow(state))
                self.assert_timed_out(result, execution)
                self.assertEqual(len(execution["steps"]), 2)
                self.assertLess(elapsed, 2)

    def test_retry_backoff_cannot_outlive_the_workflow(self):
        task = {"Type": "Task", "Resource": "arn:aws:lambda:us-east-1:000000000000:function:missing", "End": True,
                "Retry": [{"ErrorEquals": ["States.ALL"], "IntervalSeconds": 10, "MaxAttempts": 3}]}
        with patch.object(sfn.Runner, "task", side_effect=sfn.StatesError("Example.Error", "fixture")) as action:
            result, execution, elapsed = self.execute(flow(task))
        self.assert_timed_out(result, execution)
        self.assertEqual(action.call_count, 1)
        self.assertLess(elapsed, 2)

    def test_post_state_check_rejects_late_results(self):
        # A synchronous operation may finish just after its budget, even without a wait hook.
        with patch.object(sfn.Runner, "step", side_effect=lambda *args: (time.sleep(1.05), None)):
            result, execution, _ = self.execute(flow({"Type": "Pass", "End": True}))
        self.assert_timed_out(result, execution)

    def test_late_service_error_cannot_replace_workflow_timeout(self):
        def late_error(*args):
            time.sleep(1.05)
            raise sfn.StatesError("Example.Error", "fixture")
        with patch.object(sfn.Runner, "step", side_effect=late_error):
            result, execution, _ = self.execute(flow({"Type": "Pass", "End": True}))
        self.assert_timed_out(result, execution)

    def test_state_error_catch_and_retry_still_work_within_budget(self):
        task = {"Type": "Task", "Resource": "arn:aws:lambda:us-east-1:000000000000:function:fixture", "End": True,
                "Retry": [{"ErrorEquals": ["Example.Error"], "IntervalSeconds": 1, "MaxAttempts": 1}],
                "Catch": [{"ErrorEquals": ["States.ALL"], "Next": "Recover"}]}
        definition = flow(task, timeout=5)
        definition["States"]["Recover"] = {"Type": "Pass", "Result": "recovered", "End": True}
        with patch.object(sfn.Runner, "task", side_effect=sfn.StatesError("Example.Error", "fixture")) as action:
            result, _, _ = self.execute(definition)
        self.assertEqual(action.call_count, 2)
        self.assertEqual(result["status"], "SUCCEEDED")
        self.assertEqual(json.loads(result["output"]), "recovered")

    def test_nested_deadlines_do_not_extend_parent_and_restore_context(self):
        with operation.deadline(time.monotonic() + 0.05):
            with self.assertRaises(operation.DeadlineExceeded):
                with operation.deadline(time.monotonic() + 10):
                    operation.wait(1, self.cloud.stopping)
        operation.check()
        with operation.deadline(time.monotonic() + 1):
            operation.check()

    def test_deadline_is_local_to_its_execution_thread(self):
        def expiring():
            with self.assertRaises(operation.DeadlineExceeded):
                with operation.deadline(time.monotonic() + 0.05):
                    operation.wait(1, self.cloud.stopping)
        with ThreadPoolExecutor(max_workers=2) as pool:
            expired = pool.submit(expiring)
            independent = pool.submit(operation.wait, 0.15, self.cloud.stopping)
            expired.result(timeout=2)
            self.assertFalse(independent.result(timeout=2))


class WorkflowDeadlineActionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.studio = self.base / "studio"
        self.project = self.base / "project"
        self.studio.mkdir()
        self.project.mkdir()
        self.context = {"studio_root": str(self.studio), "source_root": str(self.project)}

    def tearDown(self):
        process.stop(self.studio)
        self.temp.cleanup()

    def call(self, **params):
        return run(validate(params), self.context)

    def test_real_function_stops_at_workflow_deadline_and_keeps_completed_effects(self):
        (self.project / "app.py").write_text(
            'from pathlib import Path\nimport time\ndef handler(event, context):\n'
            '    Path("started.txt").write_text("started")\n'
            '    time.sleep(event.get("delay", 0))\n'
            '    Path("finished.txt").write_text("finished")\n    return {"done": True}\n', encoding="utf-8")
        self.call(action="create", service="function", name="slow", folder=".", handler="app.handler", timeout=10)
        self.call(action="create", service="table", name="KeepMe", key="id")
        task = {"Type": "Task", "Resource": "arn:aws:lambda:us-east-1:000000000000:function:slow",
                "Parameters": {"delay": 2}, "End": True,
                "Retry": [{"ErrorEquals": ["States.ALL"], "IntervalSeconds": 1, "MaxAttempts": 2}],
                "Catch": [{"ErrorEquals": ["States.ALL"], "Next": "Recover"}]}
        definition = flow(task)
        definition["States"]["Recover"] = {"Type": "Succeed"}
        self.call(action="create", service="statemachine", name="deadline", definition=definition)
        started = time.monotonic()
        result = self.call(action="run", name="deadline")
        elapsed = time.monotonic() - started
        self.assertEqual(result["status"], "TIMED_OUT")
        self.assertEqual(result["error"], "States.Timeout")
        self.assertGreaterEqual(elapsed, 0.95)
        self.assertLess(elapsed, 2)
        self.assertTrue((self.project / "started.txt").exists())
        time.sleep(max(0, 2.2 - elapsed))
        self.assertFalse((self.project / "finished.txt").exists())
        self.assertFalse(list((self.studio / "data" / "tmp").glob("fn-*.json")))
        status = self.call(action="status")
        self.assertTrue(status["running"])
        self.assertTrue(any("KeepMe" in item for item in status["resources"]))
        # The same function still works independently after the workflow expires.
        self.call(action="invoke", name="slow", event={"delay": 0})
        self.assertTrue((self.project / "finished.txt").exists())
        self.call(action="create", service="statemachine", name="quick", definition=flow({
            "Type": "Task", "Resource": task["Resource"], "End": True,
        }, timeout=2))
        self.assertEqual(self.call(action="run", name="quick")["status"], "SUCCEEDED")
        print(f"\nWorkflow Lambda: TIMED_OUT in {elapsed:.3f}s; no late write; independent invocation succeeded", flush=True)

    def test_wait_action_obeys_deadline_and_successful_workflow_still_runs(self):
        self.call(action="create", service="statemachine", name="waiter",
                  definition=flow({"Type": "Wait", "Seconds": 3, "End": True}))
        started = time.monotonic()
        result = self.call(action="run", name="waiter")
        elapsed = time.monotonic() - started
        self.assertEqual(result["status"], "TIMED_OUT")
        self.assertLess(elapsed, 2)
        self.call(action="create", service="statemachine", name="ready",
                  definition=flow({"Type": "Wait", "Seconds": 0, "End": True}, timeout=2))
        self.assertEqual(self.call(action="run", name="ready")["status"], "SUCCEEDED")
        print(f"\nWorkflow Wait: TIMED_OUT in {elapsed:.3f}s; subsequent workflow succeeded", flush=True)


if __name__ == "__main__":
    unittest.main()
