# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Regression checks for CloudStudio review findings; only disposable local data."""

from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request
from zoneinfo import ZoneInfoNotFoundError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from support import LocalCloud, wait_for
from jumpcode_cloudstudio import process, run, validate
from jumpcode_cloudstudio.common import CloudStudioError, merge_env_file
from jumpcode_cloudstudio.engine import admin
from jumpcode_cloudstudio.engine.local_http import LocalRedirect, open_local
from jumpcode_cloudstudio.engine.server import Cloud, Request
from jumpcode_cloudstudio.engine.services import dynamodb, sns, ssm, timing
from jumpcode_cloudstudio.engine.services.common import Caller
from jumpcode_cloudstudio.engine.state import StateError, Store, read_json, write_atomic
from jumpcode_cloudstudio.engine.wire import AwsError


class HTTPBoundaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.local = LocalCloud()

    @classmethod
    def tearDownClass(cls):
        cls.local.close()

    def test_external_origins_and_hosts_cannot_reach_operations(self):
        for method in ("OPTIONS", "POST"):
            for extra in ({"Origin": "https://external.invalid"}, {"Origin": "null"},
                          {"Host": "rebound.external.invalid"}, {"Sec-Fetch-Site": "cross-site"}):
                with self.subTest(method=method, headers=extra):
                    request = urllib.request.Request(self.local.endpoint + "/2015-03-31/functions",
                                                     b"{}", method=method, headers=extra)
                    with self.assertRaises(urllib.error.HTTPError) as caught:
                        open_local(request)
                    self.assertEqual(caught.exception.code, 403)
                    self.assertIsNone(caught.exception.headers.get("Access-Control-Allow-Origin"))
        self.assertEqual(self.local.cloud.summary(), [])

    def test_local_browser_and_sdk_still_work_admin_still_requires_token(self):
        for headers in ({}, {"Origin": "http://localhost:3000"}):
            with open_local(urllib.request.Request(self.local.endpoint + "/_cloudstudio/health", headers=headers)) as reply:
                self.assertEqual(reply.status, 200)
                self.assertEqual(reply.headers.get("Access-Control-Allow-Origin"), headers.get("Origin"))
        for action in ("reset", "operation-open", "operation-cancel"):
            with self.assertRaises(urllib.error.HTTPError) as caught:
                open_local(urllib.request.Request(self.local.endpoint + "/_cloudstudio/" + action, b'{}'))
            self.assertEqual(caught.exception.code, 403)

    def test_external_sns_endpoints_are_rejected_before_network(self):
        cloud, who = self.local.cloud, Caller()
        topic = sns.create_topic(cloud, who, {"Name": "boundary"})["TopicArn"]
        with patch("urllib.request.build_opener") as opener:
            with self.assertRaises(AwsError):
                sns.subscribe(cloud, who, {"TopicArn": topic, "Protocol": "https", "Endpoint": "https://external.invalid"})
            with self.assertRaises(AwsError):
                open_local(urllib.request.Request("https://external.invalid"))
            # Also reject an external endpoint left in a snapshot from an older version.
            saved_topic = sns.topic_of(cloud, who, topic)
            saved_topic["subscriptions"]["legacy"] = {"protocol": "https", "endpoint": "https://external.invalid", "confirmed": False, "arn": "legacy", "raw": False, "attributes": {}}
            with self.assertRaises(AwsError):
                sns.confirm_subscription(cloud, who, {"TopicArn": topic, "Token": "unused"})
            self.assertFalse(saved_topic["subscriptions"]["legacy"]["confirmed"])
            sns._post(cloud, saved_topic["subscriptions"]["legacy"], {"MessageId": "test", "TopicArn": topic, "Message": "fixture"}, "agent")
            opener.assert_not_called()

    def test_redirects_revalidated_and_machine_proxy_ignored(self):
        external = "https://external.invalid/collect"
        class Redirect(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(302)
                self.send_header("Location", external)
                self.end_headers()
            def log_message(self, *args):
                pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), Redirect)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with patch.dict("os.environ", {"HTTP_PROXY": "http://external.invalid:1234", "HTTPS_PROXY": "http://external.invalid:1234", "NO_PROXY": ""}):
                with self.assertRaisesRegex(AwsError, "this computer"):
                    open_local(urllib.request.Request(f"http://127.0.0.1:{server.server_port}/"))
            handler = LocalRedirect()
            with self.assertRaises(AwsError):
                handler.redirect_request(urllib.request.Request(self.local.endpoint), None, 302, "", {}, external)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


class StateAndValueTests(unittest.TestCase):
    def test_corrupt_state_never_deletes_blob_or_overwrites_state(self):
        for content in ("{invalid", json.dumps({"schema": 999, "accounts": {}}), json.dumps({"schema": 1, "accounts": []})):
            with self.subTest(content=content), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                store = Store(root / "data", True)
                digest = store.put_blob(b"keep this body")
                store.state_file.write_text(content, encoding="utf-8")
                with self.assertRaises(StateError):
                    Cloud(root, 0, persistent=True)
                self.assertEqual(store.get_blob(digest), b"keep this body")
                self.assertEqual(store.state_file.read_text(encoding="utf-8"), content)

    def test_corrupt_snapshot_prevents_garbage_collection(self):
        with tempfile.TemporaryDirectory() as folder:
            store = Store(Path(folder), True)
            digest = store.put_blob(b"snapshot-only body")
            (store.snap_dir / "broken.json").write_text("{broken", encoding="utf-8")
            with self.assertRaises(StateError):
                store.gc_blobs()
            self.assertEqual(store.get_blob(digest), b"snapshot-only body")

    def test_secure_parameter_updates_do_not_leak_without_explicit_type(self):
        with tempfile.TemporaryDirectory() as folder:
            cloud = Cloud(Path(folder), 0)
            try:
                for value, extra in (("fake-initial-private", {"Type": "SecureString"}), ("fake-updated-private", {"Overwrite": True})):
                    request = Request("POST", "/", {"X-Amz-Target": "AmazonSSM.PutParameter"},
                                      json.dumps({"Name": "/token", "Value": value, **extra}).encode(), "us-east-1")
                    self.assertEqual(cloud.handle(request).status, 200)
                cloud.live.flush({"calls", "resources"})
                for value in ("fake-initial-private", "fake-updated-private"):
                    self.assertNotIn(value, json.dumps(admin.calls(cloud, {})))
                    self.assertNotIn(value, (Path(folder) / "calls.json").read_text(encoding="utf-8"))
                    self.assertNotIn(value, (Path(folder) / "resources.json").read_text(encoding="utf-8"))
            finally:
                cloud.shutdown()

    def test_missing_timezone_is_an_error_instead_of_silent_utc(self):
        sentinel = object()
        with patch("zoneinfo.ZoneInfo", return_value=sentinel):
            self.assertIs(timing.zone("America/Sao_Paulo"), sentinel)
        with patch("zoneinfo.ZoneInfo", side_effect=ZoneInfoNotFoundError("missing IANA database")):
            with self.assertRaisesRegex(AwsError, "Time zone"):
                timing.next_run("at(2026-12-01T09:00:00)", 0, "America/New_York")
        with self.assertRaises(AwsError):
            timing.zone("Not/A_Zone")
        due = timing.next_run("at(2026-12-01T09:00:00)", 0, "UTC")
        self.assertEqual(datetime.fromtimestamp(due, timezone.utc).hour, 9)

    def test_env_replaces_all_target_duplicates_preserving_unrelated_lines(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / ".env.local"
            path.write_text("# keep\nOTHER=1\nAWS_ENDPOINT_URL=old1\nAWS_ENDPOINT_URL=old2\nAWS_REGION=old\nAWS_REGION=old3\n", encoding="utf-8")
            values = {"AWS_ENDPOINT_URL": "http://127.0.0.1:4566", "AWS_REGION": "sa-east-1"}
            merge_env_file(path, values, "# cloud")
            first = path.read_text(encoding="utf-8")
            merge_env_file(path, values, "# cloud")
            self.assertEqual(path.read_text(encoding="utf-8"), first)
            self.assertIn("# keep\nOTHER=1", first)
            for key, value in values.items():
                self.assertEqual([line for line in first.splitlines() if line.startswith(key + "=")], [key + "=" + value])

    def test_dynamo_maps_cannot_collide_with_type_markers(self):
        for key, value in (("$set", {"S": "ordinary"}), ("$n", {"S": "not-a-number"}),
                           ("$b", {"N": "123"}), ("$map", {"M": {"$set": {"S": "nested"}}})):
            with self.subTest(key=key):
                result = dynamodb.plain({"M": {key: value}})
                self.assertEqual(set(result), {"$map"})
                self.assertIn(key, result["$map"])
        with tempfile.TemporaryDirectory() as folder:
            cloud = Cloud(Path(folder), 0)
            try:
                who = Caller()
                dynamodb.OPS["CreateTable"](cloud, who, {"TableName": "TypedNames", "KeySchema": [{"AttributeName": "N", "KeyType": "HASH"}],
                                                     "AttributeDefinitions": [{"AttributeName": "N", "AttributeType": "S"}]})
                dynamodb.OPS["PutItem"](cloud, who, {"TableName": "TypedNames", "Item": {"N": {"S": "ordinary-attribute"}}})
                self.assertEqual(dynamodb.resources(cloud)[0]["items"], [{"N": "ordinary-attribute"}])
            finally:
                cloud.shutdown()


class StoreRecoveryTests(unittest.TestCase):
    def test_invalid_restore_never_changes_current_state_or_reports_success(self):
        invalid = ["{broken", {"schema": 1}, {"schema": 1, "state": {}},
                   {"schema": 1, "state": {"schema": 1, "accounts": []}},
                   {"schema": 1, "state": {"schema": 1, "accounts": {"test": {}}}},
                   {"schema": 999, "state": Store._empty()}]
        for value in invalid:
            with self.subTest(copy=value), tempfile.TemporaryDirectory() as folder:
                cloud = Cloud(Path(folder), 0, True, "test-token")
                try:
                    store = cloud.store
                    digest = store.put_blob(b"preserve object body")
                    store.regional("000000000000", "us-east-1", "fixture")["item"] = {"blob": digest}
                    store.touch()
                    store.save()
                    before = (store.state_file.read_bytes(), json.dumps(store.state), store.version, store.saved_version)
                    (store.snap_dir / "abcdef123456.json").write_text(value if isinstance(value, str) else json.dumps(value), encoding="utf-8")
                    with self.assertRaises(StateError):
                        store.restore("abcdef123456")
                    reply = cloud.handle(Request("POST", "/_cloudstudio/restore", {"X-CloudStudio-Token": "test-token"},
                                                 b'{"id":"abcdef123456"}', "us-east-1"))
                    self.assertGreaterEqual(reply.status, 400)
                    self.assertNotIn("restored", json.loads(reply.body))
                    self.assertEqual((store.state_file.read_bytes(), json.dumps(store.state), store.version, store.saved_version), before)
                    self.assertEqual(store.get_blob(digest), b"preserve object body")
                finally:
                    cloud.shutdown()

    def test_restore_failed_write_keeps_state_and_can_be_retried(self):
        with tempfile.TemporaryDirectory() as folder:
            cloud = Cloud(Path(folder), 0, True, "test-token")
            try:
                store = cloud.store
                store.regional("000000000000", "us-east-1", "fixture")["value"] = "snapshot"
                store.touch()
                snapshot = store.snapshot("Before")
                store.regional("000000000000", "us-east-1", "fixture")["value"] = "current"
                store.touch()
                store.save()
                before = (store.state_file.read_bytes(), json.dumps(store.state), store.version, store.saved_version)
                with patch("jumpcode_cloudstudio.engine.state.write_atomic", side_effect=PermissionError("blocked test file")):
                    with self.assertRaises(AwsError) as caught:
                        admin.restore(cloud, {"id": snapshot["id"]})
                self.assertEqual(caught.exception.code, "RestoreFailed")
                self.assertEqual((store.state_file.read_bytes(), json.dumps(store.state), store.version, store.saved_version), before)
                self.assertEqual(admin.restore(cloud, {"id": snapshot["id"]}), {"restored": "Before"})
                reloaded = Store(store.folder, True)
                reloaded.load()
                self.assertEqual(reloaded.regional("000000000000", "us-east-1", "fixture")["value"], "snapshot")
            finally:
                cloud.shutdown()

    def test_memory_restore_does_not_create_a_persistent_state_file(self):
        with tempfile.TemporaryDirectory() as folder:
            store = Store(Path(folder))
            store.regional("000000000000", "us-east-1", "fixture")["value"] = "snapshot"
            store.touch()
            snapshot = store.snapshot("Before")
            store.reset()
            self.assertTrue(store.restore(snapshot["id"]))
            self.assertEqual(store.regional("000000000000", "us-east-1", "fixture")["value"], "snapshot")
            self.assertFalse(store.state_file.exists())

    def test_pending_save_cannot_overwrite_a_restore(self):
        with tempfile.TemporaryDirectory() as folder:
            store = Store(Path(folder), True)
            store.regional("000000000000", "us-east-1", "fixture")["value"] = "snapshot"
            store.touch()
            snapshot = store.snapshot("Before")
            expected = json.dumps(store.state)
            store.regional("000000000000", "us-east-1", "fixture")["value"] = "current"
            store.touch()
            entered, release, restored = threading.Event(), threading.Event(), threading.Event()
            errors = []
            def delayed_write(path, text):
                if '"current"' in text:
                    entered.set()
                    if not release.wait(3):
                        raise TimeoutError("save not released by test")
                write_atomic(path, text)
            def save():
                try:
                    store.save()
                except Exception as error:
                    errors.append(error)
            def restore():
                try:
                    store.restore(snapshot["id"])
                except Exception as error:
                    errors.append(error)
                finally:
                    restored.set()
            first, second = threading.Thread(target=save), threading.Thread(target=restore)
            with patch("jumpcode_cloudstudio.engine.state.write_atomic", side_effect=delayed_write):
                first.start()
                try:
                    self.assertTrue(entered.wait(2))
                    second.start()
                    restored.wait(0.1)
                finally:
                    release.set()
                    first.join(3)
                    if second.ident is not None:
                        second.join(3)
            self.assertEqual(errors, [])
            self.assertFalse(first.is_alive() or second.is_alive())
            self.assertEqual((json.dumps(store.state), json.dumps(read_json(store.state_file))), (expected, expected))


@unittest.skipUnless(os.name == "nt", "Exercises real Windows read-only file errors")
class LiveRecoveryTests(unittest.TestCase):
    def test_state_save_resumes_after_disk_write_is_unblocked(self):
        self.check_recovery("state")

    def test_studio_files_retry_without_another_resource_change(self):
        self.check_recovery("studio")

    def check_recovery(self, target):
        with tempfile.TemporaryDirectory() as folder:
            cloud = Cloud(Path(folder), 0, True)
            blocked = cloud.store.state_file if target == "state" else cloud.root / "resources.json"
            try:
                ssm.OPS["PutParameter"](cloud, Caller(), {"Name": "before", "Value": "one", "Type": "String"})
                cloud.store.save()
                cloud.live.flush({"resources", "cloud"})
                blocked.chmod(stat.S_IREAD)
                ssm.OPS["PutParameter"](cloud, Caller(), {"Name": "after", "Value": "two", "Type": "String"})
                with patch("jumpcode_cloudstudio.engine.live.RETRY_INTERVAL", 0.1):
                    cloud.live.start()
                    self.assertTrue(wait_for(lambda: any("could not update" in entry["text"] for entry in cloud.logs), 5))
                    self.assertTrue(cloud.live.is_alive())
                    blocked.chmod(stat.S_IREAD | stat.S_IWRITE)
                    # Recovery must not depend on a new action or another touch().
                    def recovered():
                        state = read_json(cloud.store.state_file, {})
                        resources = read_json(cloud.root / "resources.json", {}).get("resources", [])
                        return ('"after"' in json.dumps(state) and any(r["name"] == "after" for r in resources)
                                and cloud.store.saved_version == cloud.store.version)
                    self.assertTrue(wait_for(recovered, 5))
                    self.assertTrue(cloud.live.is_alive())
                    cloud.stopping.set()
                    cloud.live.wake.set()
                    cloud.live.join(2)
                self.assertEqual(len([entry for entry in cloud.logs if "could not update" in entry["text"]]), 1)
            finally:
                if blocked.exists():
                    blocked.chmod(stat.S_IREAD | stat.S_IWRITE)
                cloud.stopping.set()
                cloud.live.wake.set()
                if cloud.live.ident is not None:
                    cloud.live.join(3)
                cloud.shutdown()


class ActionRegressionTests(unittest.TestCase):
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

    def call(self, cancelled=None, **params):
        return run(validate(params), self.context, cancelled=cancelled)

    def test_resources_with_same_name_stay_in_their_namespace(self):
        scopes = [{"account": "111111111111", "region": "us-east-1"}, {"account": "222222222222", "region": "sa-east-1"}]
        for i, scope in enumerate(scopes):
            self.call(action="create", service="table", name="SameName", key="id", items=[{"id": str(i)}], **scope)
        engine = process.running(self.studio)
        with process.call_context(scopes[1], None):
            self.assertEqual(engine.call("names")["dynamodb"], ["SameName"])
        view = json.loads((self.studio / "view.json").read_text(encoding="utf-8"))
        self.assertEqual(json.loads(view["select"]), ["table", "222222222222", "sa-east-1", "SameName"])
        self.call(action="remove", service="table", name="SameName", **scopes[1])
        self.assertEqual(len(engine.call("status")["resources"]), 1)
        self.assertIn("111111111111", engine.call("status")["resources"][0])

    def test_api_and_logs_use_selected_function_namespace(self):
        (self.project / "app.py").write_text('import os\ndef handler(event, context):\n    print(os.environ["LABEL"])\n    return {"statusCode": 200, "body": os.environ["LABEL"]}\n', encoding="utf-8")
        for account, region, label in (("111111111111", "us-east-1", "FIRST"), ("222222222222", "sa-east-1", "SECOND")):
            scope = {"account": account, "region": region}
            self.call(action="create", service="function", name="same-function", folder=".", handler="app.handler", env={"LABEL": label}, **scope)
            self.call(action="create", service="api", name="same-api", routes=[{"route": "GET /", "function": "same-function"}], **scope)
            result = self.call(action="request", api="same-api", **scope)
            self.assertEqual(result["body"], label)
        lines = self.call(action="logs", name="same-function", account="222222222222", region="sa-east-1")["lines"]
        self.assertTrue(any("SECOND" in line for line in lines))
        self.assertFalse(any("FIRST" in line for line in lines))

    def test_cancel_stops_only_the_active_function_with_no_late_write(self):
        (self.project / "app.py").write_text(
            'from pathlib import Path\nimport time\ndef handler(event, context):\n'
            '    Path("started.txt").write_text("started")\n    time.sleep(2)\n'
            '    Path("finished.txt").write_text("finished")\n    return True\n', encoding="utf-8")
        self.call(action="create", service="function", name="cancel-me", folder=".", handler="app.handler", timeout=10)
        self.call(action="create", service="table", name="KeepMe", key="id")
        cancelled = threading.Event()
        def cancel_after_start():
            if wait_for(lambda: (self.project / "started.txt").exists(), timeout=5):
                cancelled.set()
        thread = threading.Thread(target=cancel_after_start)
        thread.start()
        try:
            with self.assertRaisesRegex(CloudStudioError, "cancelled"):
                self.call(action="invoke", name="cancel-me", cancelled=cancelled.is_set)
        finally:
            thread.join(6)
        self.assertTrue(cancelled.is_set())
        self.assertFalse((self.project / "finished.txt").exists())
        status = self.call(action="status")
        self.assertTrue(status["running"])
        self.assertTrue(any("KeepMe" in r for r in status["resources"]))
        self.assertFalse(list((self.studio / "data" / "tmp").glob("fn-*.json")))

    def test_cancel_exception_stops_workflow_wait(self):
        self.call(action="create", service="statemachine", name="waiter", definition={"StartAt": "Wait", "States": {"Wait": {"Type": "Wait", "Seconds": 20, "End": True}}})
        started = time.monotonic()
        class HostCancelled(Exception):
            pass
        def check():
            if time.monotonic() - started > 0.3:
                raise HostCancelled("host cancelled")
        with self.assertRaises(HostCancelled):
            self.call(action="run", name="waiter", cancelled=check)
        self.assertLess(time.monotonic() - started, 3)
        self.assertTrue(self.call(action="status")["running"])
        engine = process.running(self.studio)
        result = engine.call("status")
        self.assertTrue(any("ABORTED" in resource for resource in result["resources"]))


if __name__ == "__main__":
    unittest.main()
