# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import jumpcode_archstudio
from jumpcode_archstudio import MANIFEST, ArchStudioError, run, studio_ui, validate

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "rota-certa"
PACKAGE = Path(jumpcode_archstudio.__file__).resolve().parent
PEDIDOS = "v:plataforma/servicos/pedidos"


def snapshot(folder):
    result = {}
    for base, folders, names in os.walk(folder):
        for name in names:
            path = os.path.join(base, name)
            result[os.path.relpath(path, folder)] = (os.path.getsize(path), os.path.getmtime(path))
    return result


class ManifestTests(unittest.TestCase):
    def test_manifest_declares_a_local_studio_tool_with_project_access(self):
        self.assertEqual({key: MANIFEST[key] for key in ("id", "name", "version", "icon")},
                         {"id": "archstudio", "name": "ArchStudio", "version": "1.0.1", "icon": "type-hierarchy"})
        self.assertEqual({key: MANIFEST["studio"][key] for key in ("title", "description", "ui")},
                         {"title": "ArchStudio", "description": "Desenha a arquitetura", "ui": True})
        self.assertEqual(MANIFEST["details"]["access"], {"suppliedText": True, "projectFiles": True, "network": False})
        self.assertEqual((MANIFEST["details"]["execution"], MANIFEST["details"]["author"], MANIFEST["details"]["updatedAt"]),
                         ("local", "JumpCode", "2026-11-13"))
        schema = MANIFEST["inputSchema"]
        self.assertFalse(schema["additionalProperties"])
        self.assertEqual(schema["properties"]["action"]["enum"],
                         ["scan", "read", "focus", "write_part", "write_link", "remove", "write_path", "remove_path",
                          "write_proposal", "clear_proposal"])
        self.assertLess(len(json.dumps(schema)), 6000)
        self.assertLess(len(MANIFEST["instructions"]), 2500)

    def test_bundled_images_become_data_urls_within_limits(self):
        for key, name, prefix in (("mark", "mark.svg", "data:image/svg+xml;base64,"), ("cover", "cover.png", "data:image/png;base64,")):
            if (PACKAGE / "assets" / name).is_file():
                self.assertTrue(MANIFEST["studio"][key].startswith(prefix))
            else:
                self.assertNotIn(key, MANIFEST["studio"])
        if (PACKAGE / "assets" / "mark.svg").is_file():
            with self.assertRaisesRegex(ArchStudioError, "larger than"):
                jumpcode_archstudio._asset("mark.svg", "image/svg+xml", 10)
        self.assertIsNone(jumpcode_archstudio._asset("missing.png", "image/png", 10))

    def test_studio_ui_returns_the_interface_or_a_clear_error(self):
        if (PACKAGE / "ui" / "app.js").is_file() and (PACKAGE / "ui" / "app.css").is_file():
            ui = studio_ui()
            self.assertEqual(sorted(ui), ["css", "js"])
            self.assertTrue(ui["js"] and ui["css"])
        else:
            with self.assertRaisesRegex(ArchStudioError, "interface files are missing"):
                studio_ui()


class ValidationTests(unittest.TestCase):
    def test_arguments_are_normalized_without_touching_the_input(self):
        arguments = {"action": "write_link", "from": " pedidos ", "to": "pagamentos", "async": "true", "label": None}
        self.assertEqual(validate(arguments), {"action": "write_link", "from": "pedidos", "to": "pagamentos", "async": True})
        self.assertEqual(arguments["from"], " pedidos ")
        self.assertEqual(validate({"action": "read", "name": "pedidos"}), {"action": "read", "id": "pedidos"})
        self.assertEqual(validate({"action": "focus", "ids": "s:x", "mode": "MAP"}), {"action": "focus", "ids": ["s:x"], "mode": "map"})
        self.assertEqual(validate({"action": "scan", "id": ""}), {"action": "scan"})

    def test_invalid_requests_are_refused(self):
        cases = [
            ("not an object", "Arguments must be an object"),
            ({"action": "explode"}, "action must be one of"),
            ({"action": "read", "path": "../x"}, "Unknown arguments"),
            ({"action": "scan", "id": "s:x"}, "not used by scan"),
            ({"action": "write_part", "name": "x" * 81}, "longer than 80"),
            ({"action": "write_part", "name": "a", "level": "file"}, "level must be one of"),
            ({"action": "write_part", "name": "a", "kind": "rocket"}, "kind must be one of"),
            ({"action": "write_part", "tech": "Go"}, "needs a name"),
            ({"action": "write_link", "from": "a"}, "needs to"),
            ({"action": "write_link", "from": "a", "to": "b", "async": "maybe"}, "true or false"),
            ({"action": "focus"}, "needs id or ids"),
            ({"action": "focus", "id": "a", "mode": "3d"}, "mode must be one of"),
            ({"action": "focus", "ids": ["a"] * 21}, "at most 20"),
            ({"action": "remove"}, "needs id"),
            ({"action": "write_path", "name": "x", "steps": []}, "needs steps"),
            ({"action": "write_path", "name": "x", "steps": [{"from": "a", "to": "b"}] * 25}, "1 to 24"),
            ({"action": "write_path", "name": "x", "steps": [{"from": "a"}]}, "needs to"),
            ({"action": "write_path", "name": "x", "steps": [{"from": "a", "to": "b", "color": "red"}]}, "Unknown fields"),
            ({"action": "write_proposal", "title": "x", "nodes": [{"op": "move", "id": "a"}]}, "op must be one of"),
            ({"action": "write_proposal", "title": "x", "nodes": [{"op": "change"}]}, "needs the id"),
            ({"action": "write_proposal", "title": "x", "links": [{"op": "add", "from": "a"}]}, "needs to"),
            ({"action": "write_proposal", "summary": "x"}, "needs title"),
            ({"action": "remove_path"}, "needs the id or name"),
            ({"action": "read", "id": "a\u0000b"}, "control characters"),
        ]
        for arguments, message in cases:
            with self.subTest(arguments=arguments):
                with self.assertRaisesRegex(ArchStudioError, message):
                    validate(arguments)


class StudioTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.parent = Path(folder.name)
        self.root = self.parent / "studio"
        self.root.mkdir()
        self.context = {"studio_root": str(self.root), "source_root": str(FIXTURE)}

    def call(self, **arguments):
        return run(validate(arguments), self.context)

    def read(self, name):
        return json.loads((self.root / name).read_text(encoding="utf-8"))

    def test_scan_writes_the_model_and_progress_and_nothing_else(self):
        before = snapshot(FIXTURE)
        result = self.call(action="scan")
        self.assertTrue(result["text"].startswith("Scanned 'rota-certa'"))
        self.assertTrue(result["text"].endswith("Next: answer the user in one or two short sentences."))
        self.assertIn("plataforma (backend, Go", result["text"])
        self.assertEqual(result["stats"]["systems"], 6)
        self.assertEqual(sorted(path.name for path in self.root.iterdir()), [".archstudio.lock", "model.json", "progress.json"])
        self.assertEqual([path.name for path in self.parent.iterdir()], ["studio"])
        self.assertEqual(snapshot(FIXTURE), before)
        progress = self.read("progress.json")
        self.assertEqual((progress["status"], [step["state"] for step in progress["steps"]]), ("done", ["done"] * 6))
        model = self.read("model.json")
        self.assertEqual(model["source"], "rota-certa")
        self.assertNotIn(str(FIXTURE), json.dumps(model, ensure_ascii=False))

    def test_scan_without_a_project_folder_fails_clearly(self):
        for context in ({"studio_root": str(self.root)}, {"studio_root": str(self.root), "source_root": ""}):
            with self.assertRaisesRegex(ArchStudioError, "Ask the user to open a project or pick a folder"):
                run(validate({"action": "scan"}), context)
        with self.assertRaisesRegex(ArchStudioError, "project folder is unavailable"):
            run(validate({"action": "scan"}), {"studio_root": str(self.root), "source_root": "relative/folder"})
        self.assertEqual([path.name for path in self.root.iterdir()], [])

    def test_without_a_studio_folder_nothing_is_written(self):
        for context in (None, {}, {"studio_root": ""}, {"studio_root": "relative"}, {"studio_root": str(self.root / "missing")},
                        {"studio_root": str(Path(self.root.anchor))}):
            with self.subTest(context=context):
                with self.assertRaisesRegex(ArchStudioError, "Studio"):
                    run(validate({"action": "write_part", "name": "Loja"}), context)
        self.assertEqual([path.name for path in self.root.iterdir()], [])

    def test_linked_folders_are_refused(self):
        target = self.parent / "link"
        try:
            if os.name == "nt":
                import _winapi
                _winapi.CreateJunction(str(self.root), str(target))
            else:
                os.symlink(self.root, target, target_is_directory=True)
        except (OSError, AttributeError, ImportError):
            self.skipTest("links cannot be created here")
        with self.assertRaisesRegex(ArchStudioError, "Studio folder is unavailable"):
            run(validate({"action": "read"}), {"studio_root": str(target)})
        with self.assertRaisesRegex(ArchStudioError, "is a link"):
            run(validate({"action": "scan"}), {"studio_root": str(self.root), "source_root": str(target)})

    def test_cancelled_scan_keeps_the_previous_map(self):
        self.call(action="scan")
        previous = (self.root / "model.json").read_text(encoding="utf-8")
        calls = []
        with self.assertRaisesRegex(ArchStudioError, "stopped by the user"):
            run(validate({"action": "scan"}), self.context, lambda: calls.append(1) or len(calls) > 5)
        self.assertEqual(json.loads((self.root / "model.json").read_text(encoding="utf-8")), json.loads(previous))
        progress = self.read("progress.json")
        self.assertEqual((progress["status"], progress["error"]), ("failed", "Interrompido"))
        fresh = self.root / "fresh"
        fresh.mkdir()
        with self.assertRaisesRegex(ArchStudioError, "stopped"):
            run(validate({"action": "scan"}), {**self.context, "studio_root": str(fresh)}, lambda: True)
        self.assertEqual(sorted(path.name for path in fresh.iterdir()), [".archstudio.lock", "progress.json"])

    def test_read_outline_and_details(self):
        empty = self.call(action="read")
        self.assertIn("There is no map yet", empty["text"])
        self.call(action="scan")
        outline = self.call(action="read")["text"]
        self.assertLessEqual(len(outline), 3000)
        self.assertIn("- s:plataforma plataforma [backend, Go]:", outline)
        self.assertIn("Queues: q:mqtt Mosquitto (veiculos/+/posicao); q:rabbitmq RabbitMQ (pedido.criado)", outline)
        pedidos = self.call(action="read", id=PEDIDOS)
        self.assertEqual(pedidos["id"], PEDIDOS)
        for expected in ("POST /pedidos", "Publishes: pedido.criado", '-> v:plataforma/servicos/pagamentos (pagamentos) gRPC "Pagamentos"',
                         "<- v:plataforma/servicos/api-gateway (api-gateway) HTTP", "Children (6): Dockerfile, eventos.go"):
            self.assertIn(expected, pedidos["text"])
        self.assertLessEqual(len(pedidos["text"]), 3500)
        self.assertEqual(self.call(action="read", id="api-gateway")["id"], "v:plataforma/servicos/api-gateway")
        self.assertEqual(self.call(action="read", id="plataforma/servicos/rotas")["id"], "v:plataforma/servicos/rotas")
        link = next(item for item in self.read("model.json")["links"] if item["protocol"] == "gRPC")
        self.assertIn("handlers.go:24", self.call(action="read", id=link["id"])["text"])
        with self.assertRaisesRegex(ArchStudioError, r"Unknown part 'pagamento'\. Close matches: .*v:plataforma/servicos/pagamentos"):
            self.call(action="read", id="pagamento")
        with self.assertRaisesRegex(ArchStudioError, "matches several parts"):
            self.call(action="read", id="pedidos")

    def test_focus_writes_view_with_revisions(self):
        with self.assertRaisesRegex(ArchStudioError, "There is no map yet"):
            self.call(action="focus", id="s:plataforma")
        self.call(action="scan")
        self.call(action="focus", id=PEDIDOS, note="Recebe pedidos")
        self.assertEqual(self.read("view.json"), {"select": PEDIDOS, "highlight": [PEDIDOS], "level": "service",
                                                 "scope": "s:plataforma", "mode": "map", "note": "Recebe pedidos", "revision": 1,
                                                 "sourceId": self.read("model.json")["sourceId"]})
        link = next(item for item in self.read("model.json")["links"] if item["protocol"] == "gRPC")
        self.call(action="focus", ids=[link["id"], "s:firmware/rastreador"], mode="layers")
        view = self.read("view.json")
        self.assertEqual((view["select"], view["highlight"], view["level"], view["scope"], view["mode"], view["revision"]),
                         ("s:firmware/rastreador", [link["id"], "s:firmware/rastreador"], "system", None, "layers", 2))
        self.call(action="focus", id="f:plataforma/servicos/pedidos/handlers.go")
        self.assertEqual((self.read("view.json")["level"], self.read("view.json")["scope"]), ("file", PEDIDOS))
        self.call(action="focus", id="u:pedidos")
        self.assertEqual(self.read("view.json")["mode"], "deploy")
        with self.assertRaisesRegex(ArchStudioError, "Unknown part"):
            self.call(action="focus", id="v:nada")

    def test_parts_and_links_by_hand_survive_a_rescan(self):
        created = self.call(action="write_part", name="Loja Online", kind="web", tech="Next.js")
        self.assertEqual(created["id"], "s:loja-online")
        self.call(action="write_part", name="Catálogo", parent="s:loja-online")
        self.call(action="write_part", name="Banco", level="data", tech="PostgreSQL")
        self.call(action="write_link", **{"from": "v:loja-online/catalogo", "to": "d:banco", "protocol": "SQL"})
        model = self.read("model.json")
        nodes = {node["id"]: node for node in model["nodes"]}
        self.assertEqual(nodes["v:loja-online/catalogo"], {"id": "v:loja-online/catalogo", "level": "service", "parent": "s:loja-online",
                                                          "name": "Catálogo", "kind": "web", "manual": True})
        self.assertEqual(nodes["d:banco"]["kind"], "data")
        self.assertEqual(model["stats"], {"systems": 1, "services": 1, "files": 0, "links": 2, "lines": 0})
        self.assertEqual({(link["level"], link["from"], link["to"]) for link in model["links"]},
                         {("service", "v:loja-online/catalogo", "d:banco"), ("system", "s:loja-online", "d:banco")})
        self.call(action="scan")
        self.call(action="write_part", id=PEDIDOS, summary="Recebe e guarda os pedidos.")
        self.call(action="scan")
        nodes = {node["id"]: node for node in self.read("model.json")["nodes"]}
        self.assertIn("v:loja-online/catalogo", nodes)
        self.assertEqual((nodes[PEDIDOS]["summary"], nodes[PEDIDOS]["manual"], nodes[PEDIDOS]["files"]), ("Recebe e guarda os pedidos.", True, 6))
        self.assertTrue(any(link["from"] == "v:loja-online/catalogo" for link in self.read("model.json")["links"]))

    def test_write_part_and_link_errors(self):
        self.call(action="scan")
        cases = [
            ({"action": "write_part", "name": "Cupons", "level": "service"}, "needs parent"),
            ({"action": "write_part", "name": "Cupons", "parent": PEDIDOS}, "must be a system id"),
            ({"action": "write_part", "id": "f:plataforma/go.mod", "name": "x"}, "only their summary"),
            ({"action": "write_part", "id": "d:postgresql", "kind": "web"}, "always data"),
            ({"action": "write_part", "id": "v:nova", "name": "Nova", "level": "system"}, "starts with s:"),
            ({"action": "write_link", "from": PEDIDOS, "to": PEDIDOS}, "must be different"),
            ({"action": "write_link", "from": "f:plataforma/go.mod", "to": PEDIDOS}, "only be linked to another file"),
            ({"action": "write_link", "from": PEDIDOS, "to": "v:nada"}, "Unknown part"),
        ]
        for arguments, message in cases:
            with self.subTest(arguments=arguments):
                with self.assertRaisesRegex(ArchStudioError, message):
                    run(validate(arguments), self.context)
        updated = self.call(action="write_part", id="pagamentos", tech="Go · gRPC")
        self.assertEqual(updated["id"], "v:plataforma/servicos/pagamentos")
        linked = self.call(action="write_link", **{"from": "v:plataforma/servicos/notificacoes", "to": "s:app-cliente",
                                                   "protocol": "FCM", "label": "push"})
        link = next(item for item in self.read("model.json")["links"] if item["id"] == linked["id"])
        self.assertEqual((link["level"], link["async"], link["manual"]), ("system", False, True))
        mqtt = self.call(action="write_link", **{"from": "s:analytics", "to": "q:mqtt", "protocol": "MQTT"})
        self.assertTrue(next(item for item in self.read("model.json")["links"] if item["id"] == mqtt["id"])["async"])

    def test_remove_parts_and_links(self):
        self.call(action="scan")
        removed = self.call(action="remove", id=PEDIDOS)
        self.assertIn("and 6 parts inside it", removed["text"])
        model = self.read("model.json")
        self.assertFalse([node for node in model["nodes"] if node["id"] == PEDIDOS or node.get("parent") == PEDIDOS])
        self.assertFalse([link for link in model["links"] if PEDIDOS in (link["from"], link["to"])])
        self.assertFalse([link for link in model["links"] if link["from"] == "f:plataforma/servicos/pedidos/handlers.go"])
        summary = next(link for link in model["links"] if link["level"] == "system" and link["from"] == "s:app-cliente"
                       and link["to"] == "s:plataforma" and link["protocol"] == "HTTP")
        self.call(action="remove", id=summary["id"])
        model = self.read("model.json")
        self.assertFalse([link for link in model["links"] if link["from"].startswith("v:app-cliente") and link["to"].startswith("v:plataforma")
                          and link["protocol"] == "HTTP"])
        with self.assertRaisesRegex(ArchStudioError, "Unknown part"):
            self.call(action="remove", id=PEDIDOS)

    def test_paths(self):
        self.call(action="scan")
        steps = [{"from": "s:app-cliente", "to": "v:plataforma/servicos/api-gateway", "label": "POST /pedidos", "note": "O app envia."},
                 {"from": "api-gateway", "to": PEDIDOS},
                 {"from": PEDIDOS, "to": "v:plataforma/servicos/pagamentos", "label": "Cobrar"},
                 {"from": PEDIDOS, "to": "q:rabbitmq", "label": "pedido.criado", "async": True}]
        saved = self.call(action="write_path", name="Criar pedido", steps=steps)
        self.assertEqual(saved["id"], "criar-pedido")
        path = self.read("paths.json")["paths"][0]
        self.assertEqual(path["steps"][0], {"from": "s:app-cliente", "to": "v:plataforma/servicos/api-gateway",
                                            "label": "POST /pedidos", "async": False, "note": "O app envia."})
        self.assertEqual(path["steps"][1]["from"], "v:plataforma/servicos/api-gateway")
        self.assertEqual(path["steps"][2]["evidence"], {"path": "plataforma/servicos/pedidos/handlers.go", "line": 24})
        self.assertTrue(path["steps"][3]["async"])
        self.assertIn("1. app-cliente -> api-gateway POST /pedidos - O app envia.", self.call(action="read", id="criar-pedido")["text"])
        replaced = self.call(action="write_path", name="criar pedido", steps=steps[:1])
        self.assertTrue(replaced["text"].startswith("Replaced"))
        self.assertEqual(len(self.read("paths.json")["paths"]), 1)
        self.call(action="focus", id="criar-pedido", mode="present")
        view = self.read("view.json")
        self.assertEqual((view["path"], view["mode"], view["select"]), ("criar-pedido", "present", None))
        with self.assertRaisesRegex(ArchStudioError, "Step 1: Unknown part"):
            self.call(action="write_path", name="x", steps=[{"from": "nada", "to": PEDIDOS}])
        for index in range(11):
            self.call(action="write_path", name=f"fluxo {index}", steps=steps[:1])
        with self.assertRaisesRegex(ArchStudioError, "at most 12 paths"):
            self.call(action="write_path", name="extra", steps=steps[:1])
        self.call(action="remove_path", name="Criar pedido")
        self.assertEqual(len(self.read("paths.json")["paths"]), 11)
        with self.assertRaisesRegex(ArchStudioError, "No such path"):
            self.call(action="remove_path", id="criar-pedido")
        self.assertIn("Paths: fluxo-0", self.call(action="read")["text"])

    def test_proposals(self):
        self.call(action="scan")
        self.call(action="write_proposal", title="Cupons de desconto", summary="Valida e aplica descontos.",
                  nodes=[{"op": "add", "name": "Cupons", "parent": "s:plataforma", "tech": "Go"},
                         {"op": "change", "id": PEDIDOS, "note": "3 arquivos mudam"},
                         {"op": "remove", "id": "v:plataforma/servicos/rotas"}],
                  links=[{"op": "add", "from": PEDIDOS, "to": "v:plataforma/cupons", "label": "valida cupom"},
                         {"op": "remove", "from": "v:plataforma/servicos/api-gateway", "to": "v:plataforma/servicos/rotas"}])
        proposal = self.read("proposal.json")
        self.assertEqual(proposal["nodes"][0], {"op": "add", "name": "Cupons", "parent": "s:plataforma", "tech": "Go",
                                                "id": "v:plataforma/cupons", "level": "service", "kind": "backend"})
        self.assertEqual(proposal["links"][0], {"op": "add", "from": PEDIDOS, "to": "v:plataforma/cupons", "label": "valida cupom"})
        self.assertIn("Proposal: Cupons de desconto", self.call(action="read")["text"])
        with self.assertRaisesRegex(ArchStudioError, "Unknown part"):
            self.call(action="write_proposal", title="x", links=[{"op": "add", "from": PEDIDOS, "to": "v:inexistente"}])
        # A small model once "added" parts that already exist; each case explains the right op and keeps the proposal.
        refusals = []
        for item in ({"op": "add", "id": "s:app-cliente"}, {"op": "add", "id": "x:whatsapp-business"},
                     {"op": "add", "name": "Pedidos", "parent": "s:plataforma"}, {"op": "add", "id": "x:novo", "level": "system"},
                     {"op": "add", "id": "f:plataforma/servicos/pedidos/main.go"}):
            with self.assertRaises(ArchStudioError) as raised:
                self.call(action="write_proposal", title="x", nodes=[item])
            refusals.append(str(raised.exception))
        self.assertEqual(refusals, [
            "'s:app-cliente' is already in the map; to mark it as changed use op 'change' with that id",
            "'x:whatsapp-business' is already in the map as x:whatsapp; to mark it as changed use op 'change' with that id",
            f"'Pedidos' is already in the map as {PEDIDOS}; to mark it as changed use op 'change' with that id",
            "'x:novo' is an id of level external, but level says system",
            "'f:plataforma/servicos/pedidos/main.go' cannot be added: a new part id starts with s:, v:, d:, q: or x:",
        ])
        self.assertEqual(self.read("proposal.json")["title"], "Cupons de desconto")
        self.assertEqual(self.call(action="clear_proposal")["text"].split(" Next")[0], "Proposal cleared.")
        self.assertFalse((self.root / "proposal.json").exists())
        self.assertEqual(self.call(action="clear_proposal")["text"].split(" Next")[0], "There was no proposal.")

    def test_damaged_files_are_not_overwritten(self):
        (self.root / "model.json").write_text("{not json", encoding="utf-8")
        with self.assertRaisesRegex(ArchStudioError, "damaged"):
            self.call(action="write_part", name="Loja")
        self.assertEqual((self.root / "model.json").read_text(encoding="utf-8"), "{not json")
        self.call(action="scan")
        self.assertEqual(self.read("model.json")["version"], 1)


if __name__ == "__main__":
    unittest.main()
