# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from jumpcode_archstudio import yamlish
from jumpcode_archstudio.analyzer import Progress, analyze
from jumpcode_archstudio.walker import Budget, Cancelled

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "rota-certa"
P = "v:plataforma/servicos/"
FW = "v:firmware/rastreador/main/"


def links_of(model, **match):
    return [link for link in model["links"] if all(link.get(key) == value for key, value in match.items())]


def one(model, **match):
    found = links_of(model, **match)
    if len(found) != 1:
        raise AssertionError(f"expected one link for {match}, found {len(found)}")
    return found[0]


class FixtureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.result = analyze(FIXTURE)
        cls.model = cls.result.model
        cls.nodes = {node["id"]: node for node in cls.model["nodes"]}

    def kinds(self, level):
        return {node["id"]: node.get("kind") for node in self.model["nodes"] if node["level"] == level}

    def test_systems_with_kind_tech_and_name(self):
        systems = {node["id"]: (node["name"], node["kind"], node.get("tech")) for node in self.model["nodes"] if node["level"] == "system"}
        self.assertEqual(systems, {
            "s:analytics": ("analytics", "backend", "Python"),
            "s:app-cliente": ("app-cliente", "mobile", "React Native"),
            "s:app-entregador": ("app-entregador", "mobile", "Flutter"),
            "s:firmware/rastreador": ("rastreador", "embedded", "C · ESP32-S3"),
            "s:painel-web": ("painel-web", "web", "Next.js"),
            "s:plataforma": ("plataforma", "backend", "Go"),
        })
        self.assertEqual((self.model["name"], self.model["source"], self.model["version"]), ("Rota Certa", "rota-certa", 1))
        self.assertEqual(self.result.notes, [])

    def test_services_and_roles(self):
        roles = {node["id"]: node.get("role") for node in self.model["nodes"] if node["level"] == "service"}
        for name in ("api-gateway", "auth", "pedidos", "pagamentos", "rotas", "notificacoes", "rastreamento"):
            self.assertEqual((roles[P + name], self.nodes[P + name]["parent"], self.nodes[P + name]["tech"]), ("service", "s:plataforma", "Go"))
        expected = {
            "v:app-entregador/lib/screens": "screen", "v:app-entregador/lib/blocs": "state",
            "v:app-entregador/lib/repositories": "repository", "v:app-entregador/lib/data/api": "source",
            "v:app-entregador/lib/data/db": "source", "v:app-entregador/lib/data/sync": "source",
            "v:app-entregador/lib/data/gps": "source", "v:app-entregador/lib/data/camera": "source",
            "v:app-cliente/src/screens": "screen", "v:app-cliente/src/store": "state", "v:app-cliente/src/api": "source",
            "v:painel-web/app/pedidos": "screen", "v:painel-web/components": "screen",
            FW + "tasks/gps_task": "task", FW + "tasks/mqtt_task": "task", FW + "main": "task",
            FW + "drivers/uart_gps": "driver", FW + "drivers/spi_flash": "driver",
            FW + "modules/protocolo": "module", FW + "modules/fila_offline": "module", FW + "modules/energia": "module",
            "v:firmware/rastreador#hw-gps": "hardware", "v:firmware/rastreador#hw-modem": "hardware",
            "v:firmware/rastreador#hw-sensores": "hardware", "v:firmware/rastreador#hw-flash": "hardware",
            "v:firmware/rastreador#hw-bateria": "hardware",
        }
        self.assertEqual({key: roles.get(key) for key in expected}, expected)
        hardware = self.nodes["v:firmware/rastreador#hw-gps"]
        self.assertEqual((hardware["name"], hardware["tech"], hardware["kind"], hardware["manual"]), ("GPS", "UART", "embedded", False))

    def test_files_have_language_folder_and_size(self):
        handlers = self.nodes["f:plataforma/servicos/pedidos/handlers.go"]
        self.assertEqual({key: handlers[key] for key in ("level", "parent", "kind", "lang", "folder")},
                         {"level": "file", "parent": P + "pedidos", "kind": "file", "lang": "go", "folder": ""})
        self.assertGreater(handlers["lines"], 30)
        self.assertEqual(self.nodes["f:app-entregador/lib/data/api/api_client.dart"]["folder"], "")
        self.assertEqual(self.nodes["f:app-entregador/lib/main.dart"]["folder"], "lib")
        self.assertNotIn("f:tmp/ignorado.go", self.nodes)
        self.assertNotIn("f:plataforma/proto/pagamentospb/pagamentos_grpc.pb.go", self.nodes)
        service = self.nodes[P + "pedidos"]
        files = [node for node in self.model["nodes"] if node.get("parent") == P + "pedidos"]
        self.assertEqual((service["files"], service["lines"]), (len(files), sum(node["lines"] for node in files)))
        self.assertEqual(self.model["stats"]["files"], sum(1 for node in self.model["nodes"] if node["level"] == "file"))

    def test_file_level_imports(self):
        imports = {(link["from"], link["to"], link["protocol"]) for link in self.model["links"] if link["level"] == "file"}
        for source, target, protocol in (
            ("plataforma/servicos/pedidos/handlers.go", "plataforma/pkg/eventos/eventos.go", "import"),
            ("app-entregador/lib/main.dart", "app-entregador/lib/screens/login_screen.dart", "import"),
            ("app-entregador/lib/screens/login_screen.dart", "app-entregador/lib/blocs/auth_bloc.dart", "import"),
            ("app-cliente/src/screens/HomeScreen.tsx", "app-cliente/src/components/CartaoPedido.tsx", "import"),
            ("painel-web/app/pedidos/page.tsx", "painel-web/components/TabelaPedidos.tsx", "import"),
            ("firmware/rastreador/main/tasks/gps_task.c", "firmware/rastreador/main/drivers/uart_gps.h", "include"),
            ("analytics/jobs/pedidos_diarios.py", "analytics/fontes/postgres.py", "import"),
        ):
            self.assertIn(("f:" + source, "f:" + target, protocol), imports)
        summary = one(self.model, **{"from": P + "pedidos", "to": "v:plataforma/pkg/eventos", "level": "service"})
        self.assertEqual((summary["protocol"], summary["count"]), ("import", 2))

    def test_grpc_http_amqp_and_mqtt_links_with_evidence(self):
        grpc = one(self.model, **{"from": P + "pedidos", "to": P + "pagamentos", "protocol": "gRPC"})
        self.assertEqual((grpc["label"], grpc["async"], grpc["evidence"]),
                         ("Pagamentos", False, [{"path": "plataforma/servicos/pedidos/handlers.go", "line": 24}]))
        http = one(self.model, **{"from": P + "api-gateway", "to": P + "auth", "protocol": "HTTP"})
        self.assertIn({"path": "plataforma/servicos/api-gateway/middleware.go", "line": 9}, http["evidence"])
        published = one(self.model, **{"from": P + "pedidos", "to": "q:rabbitmq"})
        consumed = one(self.model, **{"from": "q:rabbitmq", "to": P + "notificacoes"})
        self.assertEqual([(link["protocol"], link["label"], link["async"]) for link in (published, consumed)],
                         [("AMQP", "pedido.criado", True)] * 2)
        self.assertEqual(published["evidence"], [{"path": "plataforma/servicos/pedidos/eventos.go", "line": 23}])
        self.assertEqual((self.nodes[P + "pedidos"]["publishes"], self.nodes[P + "notificacoes"]["consumes"]),
                         (["pedido.criado"], ["pedido.criado"]))
        device = one(self.model, **{"from": FW + "tasks/mqtt_task", "to": "q:mqtt"})
        backend = one(self.model, **{"from": "q:mqtt", "to": P + "rastreamento"})
        self.assertEqual([(link["protocol"], link["label"], link["async"]) for link in (device, backend)],
                         [("MQTT", "veiculos/+/posicao", True)] * 2)
        self.assertEqual(self.nodes["q:mqtt"]["name"], "Mosquitto")
        queue = one(self.model, **{"from": FW + "tasks/gps_task", "to": FW + "tasks/mqtt_task"})
        self.assertEqual((queue["protocol"], queue["label"], queue["async"]), ("FreeRTOS", "fila_posicoes", True))
        self.assertEqual(one(self.model, **{"from": FW + "drivers/uart_gps", "to": "v:firmware/rastreador#hw-gps"})["protocol"], "UART")

    def test_clients_reach_the_gateway(self):
        for source in ("v:app-entregador/lib/data/api", "v:app-cliente/src/api", "v:painel-web/lib"):
            link = one(self.model, **{"from": source, "to": P + "api-gateway", "protocol": "HTTP"})
            self.assertEqual(link["label"], "HTTPS · REST")
        self.assertEqual(one(self.model, **{"from": "v:app-cliente/src/hooks", "to": P + "api-gateway"})["protocol"], "WebSocket")

    def test_system_summaries(self):
        summaries = {(link["from"], link["to"], link["protocol"]): link for link in self.model["links"] if link["level"] == "system"}
        self.assertIn(("s:app-cliente", "s:plataforma", "HTTP"), summaries)
        self.assertIn(("s:firmware/rastreador", "q:mqtt", "MQTT"), summaries)
        self.assertIn(("q:mqtt", "s:plataforma", "MQTT"), summaries)
        self.assertIn(("s:plataforma", "d:postgresql", "SQL"), summaries)
        self.assertTrue(all(source != target for source, target, _ in summaries))
        self.assertFalse(any(link["level"] == "system" and link["from"] == link["to"] for link in self.model["links"]))
        self.assertTrue(all(link["id"].startswith("ls") for link in summaries.values()))
        self.assertEqual(self.model["stats"]["links"], sum(1 for link in self.model["links"] if link["level"] != "file"))

    def test_endpoints(self):
        endpoints = {(item["method"], item["path"]) for item in self.nodes[P + "pedidos"]["endpoints"]}
        self.assertEqual(endpoints, {("POST", "/pedidos"), ("GET", "/pedidos/{id}")})
        self.assertEqual(self.nodes[P + "pedidos"]["endpoints"][0]["file"], "plataforma/servicos/pedidos/main.go")
        self.assertIn(("GET", "/api/relatorios"), {(item["method"], item["path"]) for item in self.nodes["v:painel-web/app/api"]["endpoints"]})

    def test_data_and_external_nodes(self):
        self.assertEqual(self.kinds("data"), {"d:postgresql": "data", "d:redis": "data", "d:s3": "data", "d:sqlite-app-entregador": "data"})
        self.assertEqual(self.kinds("queue"), {"q:mqtt": "queue", "q:rabbitmq": "queue"})
        self.assertEqual(self.kinds("external"), {"x:firebase": "external", "x:google-maps": "external", "x:pix": "external",
                                                 "x:whatsapp": "external"})
        self.assertEqual(one(self.model, **{"from": P + "pedidos", "to": "d:postgresql"})["protocol"], "SQL")
        self.assertEqual(one(self.model, **{"from": P + "rotas", "to": "x:google-maps"})["evidence"],
                         [{"path": "plataforma/servicos/rotas/google.go", "line": 11}])
        self.assertTrue(links_of(self.model, **{"from": P + "pagamentos", "to": "x:pix"}))
        self.assertTrue(links_of(self.model, **{"from": "v:analytics/destinos", "to": "d:s3"}))
        self.assertTrue(links_of(self.model, **{"from": "v:app-entregador/lib/data/db", "to": "d:sqlite-app-entregador"}))

    def test_deploy_zones_and_units(self):
        deploy = self.model["deploy"]
        zones = {zone["id"]: (zone["kind"], zone["parent"]) for zone in deploy["zones"]}
        self.assertEqual(zones["z:aws"], ("cloud", None))
        self.assertEqual(zones["z:k8s"], ("cluster", "z:aws"))
        self.assertEqual(zones["z:compose"], ("host", None))
        self.assertEqual({zone: zones[zone][0] for zone in ("z:users", "z:devices", "z:external", "z:vercel")},
                         {"z:users": "users", "z:devices": "devices", "z:external": "external", "z:vercel": "cloud"})
        units = {unit["id"]: unit for unit in deploy["units"]}
        self.assertEqual({key: units["u:pedidos"][key] for key in ("zone", "kind", "replicas", "image", "ports", "node")},
                         {"zone": "z:k8s", "kind": "container", "replicas": 3, "image": "rotacerta/pedidos:1.4.0",
                          "ports": ["8081"], "node": P + "pedidos"})
        self.assertEqual((units["u:rota-certa-pedidos"]["kind"], units["u:rota-certa-pedidos"]["node"]), ("database", "d:postgresql"))
        self.assertEqual(units["u:rota-certa-eventos"]["node"], "q:rabbitmq")
        self.assertEqual((units["u:entrada"]["kind"], units["u:rastreador"]["kind"]), ("balancer", "device"))
        self.assertEqual(units["u:compose-pedidos"]["replicas"], 2)
        deploy_links = {(link["from"], link["to"], link["label"]) for link in deploy["links"]}
        self.assertIn(("u:entrada", "u:api-gateway", "HTTP"), deploy_links)
        self.assertIn(("u:pedidos", "u:pagamentos", "gRPC"), deploy_links)
        self.assertIn(("u:rastreador", "u:mosquitto", "MQTT"), deploy_links)
        self.assertFalse(any(label in ("import", "include") for _, _, label in deploy_links))

    def test_ids_are_stable_and_output_is_deterministic(self):
        second = analyze(FIXTURE).model
        first = dict(self.model, scannedAt=None)
        second = dict(second, scannedAt=None)
        self.assertEqual(json.dumps(first, sort_keys=True), json.dumps(second, sort_keys=True))
        identifiers = [node["id"] for node in self.model["nodes"]] + [link["id"] for link in self.model["links"]]
        self.assertEqual(len(identifiers), len(set(identifiers)))
        self.assertTrue(all(":" in node["id"] and "\\" not in node.get("path", "") for node in self.model["nodes"]))


class BoundsTests(unittest.TestCase):
    def test_file_time_and_read_limits_finish_with_a_note(self):
        limited = analyze(FIXTURE, Budget(max_files=10))
        self.assertLessEqual(limited.model["stats"]["files"], 10)
        self.assertTrue(any("file limit" in note for note in limited.notes))
        reading = analyze(FIXTURE, Budget(max_total_bytes=2000))
        self.assertTrue(any("read limit" in note for note in reading.notes))
        clock = iter(range(0, 10_000, 5))
        timed = analyze(FIXTURE, Budget(seconds=20, clock=lambda: next(clock)))
        self.assertTrue(any("time limit" in note for note in timed.notes))

    def test_cancellation_stops_the_scan(self):
        calls = []

        def cancelled():
            calls.append(1)
            return len(calls) > 3

        with self.assertRaises(Cancelled):
            analyze(FIXTURE, Budget(cancelled=cancelled))

    def test_progress_is_throttled(self):
        now = [0.0]
        written = []
        progress = Progress(written.append, clock=lambda: now[0])
        progress.start("tree")
        for step in range(10):
            now[0] += 0.05
            progress.tick(current=str(step), done=step)
        self.assertEqual(len(written), 2)
        now[0] += 0.3
        progress.tick(current="x")
        self.assertEqual(written[-1]["current"], "x")
        self.assertEqual(written[-1]["steps"][0], {"id": "tree", "label": "Estrutura de pastas", "state": "run"})

    def test_links_and_escaping_imports_are_never_followed(self):
        with tempfile.TemporaryDirectory() as outside, tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "projeto"
            (root / "src").mkdir(parents=True)
            (root / "package.json").write_text('{"name": "web", "dependencies": {"react": "18"}}', encoding="utf-8")
            (root / "src" / "a.ts").write_text("import x from '../../../../../segredo';\nexport const a = 1;\n", encoding="utf-8")
            (Path(outside) / "secreto.go").write_text('package x\nconst u = "https://api.stripe.com/v1"\n', encoding="utf-8")
            linked = root / "externo"
            try:
                if os.name == "nt":
                    import _winapi
                    _winapi.CreateJunction(outside, str(linked))
                else:
                    os.symlink(outside, linked, target_is_directory=True)
            except (OSError, AttributeError, ImportError):
                self.skipTest("links cannot be created here")
            model = analyze(root).model
            self.assertEqual(sorted(node["path"] for node in model["nodes"] if node["level"] == "file"),
                             ["package.json", "src/a.ts"])
            self.assertFalse([link for link in model["links"] if link["level"] == "file"])
            self.assertFalse([node for node in model["nodes"] if node["level"] == "external"])


class YamlTests(unittest.TestCase):
    def test_compose_and_kubernetes_shapes(self):
        documents = yamlish.load_all(
            "services:\n  api:\n    image: x/api:1 # comment\n    ports:\n      - \"8080:8080\"\n"
            "    environment:\n      - A=1\n    depends_on: [db, 'mq']\n  db:\n    command: |\n      a\n      b\n"
            "---\nkind: Deployment\nspec:\n  replicas: 2\n  template:\n    spec:\n      containers:\n"
            "      - name: api\n        ports:\n        - containerPort: 80\n")
        self.assertEqual(documents, [
            {"services": {"api": {"image": "x/api:1", "ports": ["8080:8080"], "environment": ["A=1"], "depends_on": ["db", "mq"]},
                          "db": {"command": "a\nb"}}},
            {"kind": "Deployment", "spec": {"replicas": 2, "template": {"spec": {"containers": [{"name": "api", "ports": [{"containerPort": 80}]}]}}}},
        ])
        self.assertEqual(yamlish.load_all(": : :\n- [\n\t{"), yamlish.load_all(": : :\n- [\n\t{"))


if __name__ == "__main__":
    unittest.main()
