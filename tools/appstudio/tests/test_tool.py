# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""The tool as the model uses it: building an app part by part with the planned parts as placeholders, what the app's
HTML may not contain, the map and the problems, tabs, reading, removing and going back to a version, the aliases small
models use, publishing without replacing other people's files, and where a new app goes."""

import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import jumpcode_appstudio as tool  # noqa: E402
from jumpcode_appstudio import checks  # noqa: E402
from jumpcode_appstudio.arguments import ACTION_FIELDS  # noqa: E402
from jumpcode_appstudio.common import AppStudioError, read_json  # noqa: E402

BUTTON = '<button class="botao" data-go="{0}">{1}</button>'


class Base(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix="appstudio-"))
        self.studio = self.base / "studio"
        self.project = self.base / "barbearia"
        self.studio.mkdir()
        self.project.mkdir()
        self.context = {"studio_root": str(self.studio), "source_root": str(self.project)}

    def tearDown(self):
        shutil.rmtree(self.base, ignore_errors=True)

    def call(self, **arguments):
        return tool.run(tool.validate(arguments), dict(self.context))

    def app(self):
        return read_json(self.studio / "app.json")

    def state(self):
        return read_json(self.studio / "state.json")

    def source(self, folder="app"):
        return read_json(self.project / folder / "appstudio.json")

    def build(self):
        self.call(action="start", name="Barbearia do Zé", primary="#24563F", accent="#B4502A")
        self.call(action="write_styles", name="base", css=".botao{min-height:48px}")
        self.call(action="screen", screen="inicio", title="Início", kind="tab", route="/", plan=["topo", "agendar"])
        self.call(action="tabs", items=[{"screen": "inicio", "label": "Início", "icon": "home"}, {"screen": "perfil", "label": "Perfil", "icon": "user"}])
        self.call(action="write_part", screen="inicio", part="topo", html='<header data-state="sempre"><h1>Barbearia do Zé</h1></header>')
        self.call(action="write_part", screen="inicio", part="agendar", html=BUTTON.format("horario", "Agendar horário"))
        self.call(action="screen", screen="horario", title="Horário", route="/agendar", login=True, plan=["voltar", "horas"])
        self.call(action="write_part", screen="horario", part="voltar", html="<button data-back>Voltar</button>")
        self.call(action="write_part", screen="horario", part="horas", html=BUTTON.format("pagamento", "10:30"))
        self.call(action="screen", screen="pagamento", kind="modal", route="/agendar/pagamento")
        self.call(action="write_part", screen="pagamento", part="pix", html=BUTTON.format("confirmado", "Já paguei") + "<button data-close>Cancelar</button>")
        self.call(action="write_part", screen="confirmado", part="ok", html="<h2>Confirmado</h2>")
        self.call(action="write_part", screen="perfil", part="dados", html="<h2>Marina</h2>")


class Building(Base):
    def test_without_an_app_status_says_so(self):
        result = self.call(action="status")
        self.assertEqual((result["app"], self.app()), (None, {}))
        with self.assertRaises(AppStudioError):
            self.call(action="write_part", screen="inicio", part="topo", html="<h1>Oi</h1>")

    def test_the_app_grows_part_by_part_with_placeholders(self):
        self.call(action="start", name="Barbearia do Zé")
        self.call(action="screen", screen="inicio", title="Início", plan=["topo", "proximo", "servicos"])
        self.call(action="write_part", screen="inicio", part="topo", html="<header><h1>Barbearia</h1></header>")
        app, state = self.app(), self.state()
        index = (self.project / "app" / "index.html").read_text(encoding="utf-8")
        self.assertEqual((app["screens"][0]["planned"], state["building"]["part"], state["focus"]["screen"], app["revision"],
                          app["preview"].count('class="as-parte as-planejada"'), "as-planejada" in index, "AppRuntime.start(document" in index,
                          [v["n"] for v in state["versions"]][:3]),
                         (["proximo", "servicos"], "topo", "inicio", 3, 2, False, True, [3, 2, 1]))

    def test_unsafe_html_and_css_are_refused(self):
        self.call(action="start", name="App")
        for html in ("<script>alert(1)</script>", '<button onclick="x()">x</button>', '<img src="https://x.com/a.png" alt="a">',
                     '<a href="javascript:alert(1)">x</a>', "<html><body>x</body></html>", '<iframe src="x"></iframe>'):
            with self.subTest(html=html), self.assertRaises(AppStudioError):
                self.call(action="write_part", screen="inicio", part="topo", html=html)
        for css in ("@import url(x.css);", "a{background:url(https://x.com/a.png)}"):
            with self.subTest(css=css), self.assertRaises(AppStudioError):
                self.call(action="write_styles", name="base", css=css)
        self.call(action="write_part", screen="inicio", part="topo", html='<img src="data:image/png;base64,AAAA" alt="logo"><a href="tel:+5581">Ligar</a>')

    def test_map_and_problems(self):
        self.build()
        self.call(action="theme", primary="#9ED3B0")
        self.call(action="write_part", screen="perfil", part="foto", html='<img src="data:image/png;base64,AAAA"><button><svg viewBox="0 0 2 2"></svg></button>')
        self.call(action="write_part", screen="horario", part="ajuda", html=BUTTON.format("ajuda", "Ajuda"))
        self.call(action="screen", screen="sobre", plan=["texto"])
        result = self.call(action="check")
        routes = self.app()["routes"]
        kinds = sorted({item["kind"] for item in self.state()["problems"]})
        self.assertEqual((routes["deadEnds"], sorted(routes["unreachable"]), routes["missing"], kinds,
                          sorted((e["from"], e["to"], e["how"]) for e in routes["edges"] if e["to"])),
                         (["confirmado"], ["sobre"], [{"from": "horario", "to": "ajuda"}],
                          ["button-label", "contrast", "dead-end", "empty-screen", "idle-button", "image-alt", "missing-link", "unreachable"],
                          [("horario", "pagamento", "go"), ("inicio", "horario", "go"), ("pagamento", "confirmado", "go")]))
        self.assertIn("Confirmado não tem saída", result["message"])

    def test_tabs_set_the_screen_kinds(self):
        self.build()
        kinds = {s["id"]: s["kind"] for s in self.source()["screens"]}
        self.call(action="remove", tab="perfil")
        after = {s["id"]: s["kind"] for s in self.source()["screens"]}
        self.assertEqual((kinds["inicio"], kinds["perfil"], kinds["pagamento"], after["perfil"], [t["screen"] for t in self.source()["tabs"]]),
                         ("tab", "tab", "modal", "stack", ["inicio"]))

    def test_read_remove_and_go_back(self):
        self.build()
        part = self.call(action="read", screen="horario", part="horas")
        before = self.source()["revision"]
        self.call(action="remove", screen="horario", part="horas")
        removed = [p["id"] for s in self.source()["screens"] if s["id"] == "horario" for p in s["parts"]]
        self.call(action="restore", version=before)
        back = [p["id"] for s in self.source()["screens"] if s["id"] == "horario" for p in s["parts"]]
        self.assertEqual((part["html"], removed, back, self.source()["revision"]),
                         (BUTTON.format("pagamento", "10:30"), ["voltar"], ["voltar", "horas"], before + 2))

    def test_states_and_example_data(self):
        self.build()
        hint = self.call(action="data", collection="servicos", rows=[{"nome": "Corte"}, {"nome": "Barba"}])
        self.call(action="write_part", screen="perfil", part="lista",
                  html='<ul data-each="servicos"><li>{{nome}}</li></ul><p data-state="vazio">Nada ainda</p><p data-state="carregando">…</p>')
        screens = {s["id"]: s for s in self.app()["screens"]}
        self.assertEqual((screens["perfil"]["states"], '"servicos":[{"nome":"Corte"}' in self.app()["preview"].replace(" ", "")),
                         (["normal", "carregando", "vazio"], True))
        self.assertIn('data-each="servicos"', hint["message"])


class WindowTest(Base):
    """What qwen3.5:4b did in the isolated window: lists without data and {{field.x}} placeholders, a tab turned into a
    stack screen, a start without a name, theme colours redefined in CSS, a Sair button without action, and restore."""

    def test_lists_need_their_data_and_real_fields(self):
        self.call(action="start", name="Barbearia")
        for html in ('<ul data-each="servicos"><li>{{nome}}</li></ul>', '<p>{{nome}}</p>'):
            with self.subTest(html=html), self.assertRaises(AppStudioError):
                self.call(action="write_part", screen="inicio", part="lista", html=html)
        self.call(action="data", collection="servicos", rows=[{"nome": "Corte", "preco": "R$ 45"}])
        for html in ('<ul data-each="servicos"><li>{{field.nome}}</li></ul>', '<ul data-each="servicos"><li>{{field.nome.charAt(0)}}</li></ul>',
                     '<ul data-each="servicos"><li>{{valor}}</li></ul>'):
            with self.subTest(html=html), self.assertRaises(AppStudioError) as refused:
                self.call(action="write_part", screen="inicio", part="lista", html=html)
        self.assertIn("nome, preco", str(refused.exception))
        self.call(action="write_part", screen="inicio", part="lista", html='<ul data-each="servicos"><li data-go="inicio">{{nome}} {{preco}}</li></ul>')

    def test_tabs_stay_tabs_and_take_their_label(self):
        self.call(action="start", name="Barbearia")
        self.call(action="tabs", items=[{"screen": "inicio", "label": "Início"}, {"screen": "horarios", "label": "Meus horários"}])
        with self.assertRaises(AppStudioError) as refused:
            self.call(action="screen", screen="horarios", kind="stack")
        titles = {s["id"]: (s["title"], s["kind"]) for s in self.source()["screens"]}
        self.assertEqual(titles["horarios"], ("Meus horários", "tab"))
        self.assertIn("remove its tab first", str(refused.exception))

    def test_a_start_without_name_uses_the_project_and_theme_stays_in_theme(self):
        result = self.call(action="start", primary="#1A5C30")
        with self.assertRaises(AppStudioError):
            self.call(action="write_styles", name="base", css=":root{--cor-primaria:#123456}body{color:var(--cor-texto)}")
        self.assertEqual(self.source()["name"], "Barbearia")
        self.assertIn("Barbearia", result["message"])

    def test_an_idle_button_is_named_and_restore_undoes_the_last_change(self):
        self.call(action="start", name="Barbearia")
        reply = self.call(action="write_part", screen="perfil", part="sair", html='<button class="botao">Sair</button>')
        before = self.source()["revision"]
        self.call(action="write_part", screen="perfil", part="sair", html='<button class="botao" data-go="perfil">Sair</button>')
        self.call(action="restore")
        html = [p["html"] for s in self.source()["screens"] for p in s["parts"]][0]
        self.assertEqual((html, self.source()["revision"]), ('<button class="botao">Sair</button>', before + 2))
        self.assertIn("Buttons without an action: Sair", reply["message"])


class Aliases(Base):
    def test_webstudio_words_and_loose_values(self):
        cases = [({"action": "write_section", "page": "inicio", "section": "topo", "content": "<h1>x</h1>"},
                  {"action": "write_part", "screen": "inicio", "part": "topo", "html": "<h1>x</h1>"}),
                 ({"action": "tela", "id": "inicio", "type": "aba", "parts": "topo, lista"},
                  {"action": "screen", "screen": "inicio", "kind": "tab", "plan": ["topo", "lista"]}),
                 ({"action": "mostrar", "view": "mapa", "device": "Android dobrável", "fold": "fechado"},
                  {"action": "show", "view": "map", "device": "android-fold", "fold": "closed"}),
                 ({"action": "desfazer", "version": "3"}, {"action": "restore", "version": 3})]
        self.assertEqual([tool.validate(given) for given, _ in cases], [expected for _, expected in cases])


class Publishing(Base):
    def test_pwa_and_capacitor_without_replacing_other_files(self):
        self.build()
        (self.project / "app" / "package.json").write_text('{"name": "meu"}', encoding="utf-8")
        result = self.call(action="publish", capacitor=True, app_id="com.barbearia.app")
        folder = self.project / "app"
        manifest = json.loads((folder / "manifest.webmanifest").read_text(encoding="utf-8"))
        config = json.loads((folder / "capacitor.config.json").read_text(encoding="utf-8"))
        index = (folder / "index.html").read_text(encoding="utf-8")
        self.assertEqual((manifest["start_url"], config["appId"], config["webDir"], (folder / "www" / "index.html").is_file(),
                          'rel="manifest"' in index, "serviceWorker" in index, (folder / "package.json").read_text(encoding="utf-8"),
                          self.state()["published"]["skipped"]),
                         ("./index.html", "com.barbearia.app", "www", True, True, True, '{"name": "meu"}', ["app/package.json"]))
        self.assertIn("Not replaced", result["message"])

    def test_a_new_app_does_not_take_a_folder_in_use(self):
        (self.project / "app").mkdir()
        (self.project / "app" / "page.tsx").write_text("export default 1", encoding="utf-8")
        result = self.call(action="start", name="Loja")
        again = self.call(action="status")
        self.assertEqual((result["folder"], again["folder"], (self.project / "app" / "page.tsx").read_text(encoding="utf-8")),
                         ("app-mobile", "app-mobile", "export default 1"))


class Package(unittest.TestCase):
    def test_manifest_and_arguments_agree(self):
        schema = tool.MANIFEST["inputSchema"]
        fields = set().union(*ACTION_FIELDS.values()) | {"action", "question"}
        self.assertEqual((tool.MANIFEST["id"], tool.MANIFEST["studio"]["ui"], set(schema["properties"]["action"]["enum"]),
                          set(schema["properties"]), tool.MANIFEST["studio"]["mark"].startswith("data:image/svg+xml;base64,")),
                         ("appstudio", True, set(ACTION_FIELDS), fields, True))

    def test_contrast(self):
        self.assertEqual((checks.contrast("#FFFFFF", "#000000"), checks.contrast("#777777", "#FFFFFF") < 4.5, checks.contrast("bad", "#FFF")),
                         (21.0, True, None))

    def test_studio_interface_starts_with_the_runtime(self):
        from jumpcode_appstudio import render
        ui = tool.studio_ui()
        self.assertTrue(ui["js"].startswith(render.runtime_js()) and "root.AppRuntime" in ui["js"] and ui["css"])


if __name__ == "__main__":
    unittest.main()
