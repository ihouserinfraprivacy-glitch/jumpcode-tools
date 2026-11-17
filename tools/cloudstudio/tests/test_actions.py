# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""The tool as the model uses it: arguments, the cloud's own process, resources in plain terms, the project's
.env.local, secrets read from .env without reaching any result, copies and the Studio files."""

import json
from pathlib import Path
import shutil
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import jumpcode_cloudstudio as tool  # noqa: E402
from jumpcode_cloudstudio import process  # noqa: E402
from jumpcode_cloudstudio.common import CloudStudioError  # noqa: E402

SECRET = "token-de-verdade-987654"


class ActionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.base = Path(tempfile.mkdtemp(prefix="cloudstudio-actions-"))
        cls.studio = cls.base / "studio"
        cls.project = cls.base / "barbearia"
        cls.studio.mkdir()
        (cls.project / "backend" / "agendar").mkdir(parents=True)
        (cls.project / "backend" / "agendar" / "app.py").write_text(
            "import json\ndef handler(event, context):\n    print('pedido', json.dumps(event))\n"
            "    body = json.loads(event.get('body') or '{}') if isinstance(event, dict) else {}\n"
            "    return {'statusCode': 201, 'body': json.dumps({'cliente': body.get('cliente', '?')})}\n", encoding="utf-8")
        (cls.project / ".env").write_text(f"WHATSAPP_TOKEN={SECRET}\nVAZIO=\nOUTRA=1\n", encoding="utf-8")
        (cls.project / ".env.local").write_text("# minhas coisas\nPORTA=3000\nAWS_REGION=us-west-2\n", encoding="utf-8")
        cls.context = {"studio_root": str(cls.studio), "source_root": str(cls.project)}

    @classmethod
    def tearDownClass(cls):
        process.stop(cls.studio)
        shutil.rmtree(cls.base, ignore_errors=True)

    def call(self, **arguments):
        return tool.run(tool.validate(arguments), self.context)

    def test_flow(self):
        off = self.call(action="status")
        started = self.call(action="start", region="sa-east-1")
        again = self.call(action="start", region="sa-east-1")
        table = self.call(action="create", service="table", name="agendamentos", key="id", items=[{"id": "AG-1", "valor": 35}])
        queue = self.call(action="create", service="queue", name="lembretes", deadLetter="lembretes-dlq", maxReceives=3, handler="ignorado")
        function = self.call(action="create", service="function", name="agendar", folder="backend/agendar", handler="app.handler", env={"TABELA": "agendamentos"})
        api = self.call(action="create", service="api", name="barbearia-api", routes=[{"route": "POST /agendamentos", "function": "agendar"}])
        secret = self.call(action="create", service="secret", name="whatsapp/token", fromEnv="WHATSAPP_TOKEN")
        empty = self.call(action="create", service="secret", name="vazio", fromEnv="VAZIO")
        invoked = self.call(action="invoke", name="agendar", event='{"body": "{\\"cliente\\": \\"Zé\\"}"}')
        answered = self.call(action="request", api="barbearia-api", method="POST", path="/agendamentos", body={"cliente": "Ana"})
        sent = self.call(action="send", queue="lembretes", message={"agendamento": "AG-1"})
        written = self.call(action="env")
        status = self.call(action="status")
        copy = self.call(action="snapshot", name="inicio")
        self.call(action="reset")
        after_reset = self.call(action="status")
        restored = self.call(action="restore", name="inicio")
        after_restore = self.call(action="status")
        time.sleep(0.6)
        studio = "".join((self.studio / name).read_text(encoding="utf-8") for name in ("cloud.json", "resources.json", "calls.json", "logs.json"))
        results = json.dumps([table, queue, function, api, secret, empty, invoked, answered, sent, written, status], ensure_ascii=False)
        env_local = (self.project / ".env.local").read_text(encoding="utf-8")
        stopped = self.call(action="stop")
        cloud = json.loads((self.studio / "cloud.json").read_text(encoding="utf-8"))
        self.assertEqual({
            "off": off["running"], "started": (started["running"], started["endpoint"].startswith("http://127.0.0.1:"), started["region"]),
            "again": again["message"].startswith("Already running"), "table": table["created"],
            "queue": (queue["created"], queue["url"].endswith("/lembretes"), queue["dlq"], "Ignored for a queue: handler." in queue["message"],
                      "go to the dead-letter queue lembretes-dlq" in queue["message"]),
            "function": function["created"], "api": (api["created"], "/_api/" in api["url"]),
            "secret": (secret["created"], "6 characters" in secret["message"] or "23 characters" in secret["message"], "empty" in empty["message"]),
            "invoked": (invoked["succeeded"], json.loads(invoked["result"]["body"])), "answered": (answered["status"], answered["body"]),
            "sent": sent["sent"], "resources": len(status["resources"]),
            "secret leaked": SECRET in studio or SECRET in results,
            "env": [line for line in env_local.splitlines() if line.startswith(("PORTA", "AWS_REGION", "AWS_ENDPOINT_URL", "# minhas"))],
            "copy": (copy["copy"]["name"], after_reset["resources"], restored["restored"], len(after_restore["resources"]) == len(status["resources"])),
            "stopped": (stopped["running"], cloud["status"]),
        }, {
            "off": False, "started": (True, True, "sa-east-1"), "again": True, "table": "table agendamentos",
            "queue": ("queue lembretes", True, "lembretes-dlq", True, True),
            "function": "function agendar", "api": ("api barbearia-api", True), "secret": ("secret whatsapp/token", True, True),
            "invoked": (True, {"cliente": "Zé"}), "answered": (201, {"cliente": "Ana"}), "sent": "queue lembretes", "resources": 8,
            "secret leaked": False,
            "env": ["# minhas coisas", "PORTA=3000", "AWS_REGION=sa-east-1", f"AWS_ENDPOINT_URL={started['endpoint']}"],
            "copy": ("inicio", [], "inicio", True), "stopped": (False, "stopped"),
        })

    def test_refusals(self):
        refused = []
        for arguments in ({"action": "nada"}, {"action": "create", "service": "secret", "name": "x", "value": "abc"},
                          {"action": "create", "service": "function", "name": "f", "folder": "../fora"},
                          {"action": "create", "service": "table", "name": "t"}, {"action": "invoke", "event": {}},
                          {"action": "status", "name": "extra"}, {"action": "create", "service": "bucket", "name": "b", "timeout": "10"}):
            try:
                tool.run(tool.validate(arguments), self.context)
                refused.append(None)
            except CloudStudioError as error:
                refused.append(str(error).split(":")[0].split(".")[0])
        process.stop(self.studio)
        self.assertEqual(refused, ["arguments", "Never pass a secret's value", "Give the path relative to the project, like src/agendar (got '",
                                   "A table needs key (the partition key attribute, such as id)", "Give the function name; there is no function yet",
                                   "status does not take name",
                                   "arguments"])

    def test_fills_what_a_small_model_leaves_out(self):
        studio = self.base / "lacunas"
        studio.mkdir()
        context = {**self.context, "studio_root": str(studio)}
        run = lambda **arguments: tool.run(tool.validate(arguments), context)
        try:
            function = run(action="create", name="agendar", folder="backend/agendar", handler="app.handler", routes=[{"route": "POST /a", "function": "agendar"}])
            api = run(action="create", name="barbearia-api", routes=[{"route": "POST /agendamentos", "function": "agendar"}])
            invoked = run(action="invoke", event={"body": '{"cliente": "Zé"}'})
            answered = run(action="request", path="/agendamentos", body='{"cliente": "Ana"}')
            with self.assertRaises(CloudStudioError) as missing:
                run(action="run")
        finally:
            process.stop(studio)
        self.assertEqual((function["created"], "Ignored for a function: routes." in function["message"], api["created"], invoked["succeeded"],
                          answered["status"], answered["body"], str(missing.exception)),
                         ("function agendar", True, "api barbearia-api", True, 201, {"cliente": "Ana"}, "Give the statemachine name; there is no statemachine yet"))

    def test_without_project(self):
        studio = self.base / "sem-projeto"
        studio.mkdir()
        context = {"studio_root": str(studio)}
        try:
            with self.assertRaises(CloudStudioError) as caught:
                tool.run(tool.validate({"action": "env"}), context)
            self.assertIn("open CloudStudio from a project", str(caught.exception))
        finally:
            process.stop(studio)

    def test_manifest_and_interface(self):
        ui = tool.studio_ui()
        self.assertEqual((tool.MANIFEST["id"], tool.MANIFEST["studio"]["ui"], tool.MANIFEST["studio"]["mark"].startswith("data:image/svg+xml;base64,"),
                          tool.MANIFEST["studio"]["cover"].startswith("data:image/png;base64,"), "acquireVsCodeApi" in ui["js"], ".cs-studio" in ui["css"],
                          tool.MANIFEST["details"]["access"]),
                         ("cloudstudio", True, True, True, True, True, {"suppliedText": True, "projectFiles": True, "network": False}))


if __name__ == "__main__":
    unittest.main()
