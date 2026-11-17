# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from jumpcode_webstudio import MANIFEST, WebStudioError, run, validate
from jumpcode_webstudio.site import MAX_READ_BYTES


class ManifestTests(unittest.TestCase):
    def test_manifest_declares_a_local_studio_tool_without_project_or_network_access(self):
        self.assertEqual({key: MANIFEST[key] for key in ("id", "name", "version", "icon")},
                         {"id": "webstudio", "name": "WebStudio", "version": "1.0.1", "icon": "globe"})
        self.assertEqual(MANIFEST["studio"]["title"], "WebStudio")
        self.assertEqual(MANIFEST["details"]["access"], {"suppliedText": True, "projectFiles": False, "network": False})
        self.assertEqual(MANIFEST["details"]["execution"], "local")
        self.assertEqual(MANIFEST["inputSchema"]["properties"]["action"]["enum"],
                         ["write_section", "write_styles", "remove_section", "remove_page", "read"])
        self.assertLessEqual(len(MANIFEST["description"]), 1000)


class ValidationTests(unittest.TestCase):
    def test_names_are_folded_into_safe_ids_without_touching_the_input(self):
        arguments = {"action": "write_section", "page": " Cardápio do Dia ", "section": "Hero_Principal", "html": "<section>Oi</section>"}
        self.assertEqual(validate(arguments), {"action": "write_section", "page": "cardapio-do-dia", "section": "hero-principal", "html": "<section>Oi</section>"})
        self.assertEqual(arguments["page"], " Cardápio do Dia ")

    def test_a_full_document_keeps_only_its_body(self):
        document = "<!doctype html><html><head><title>x</title></head><body><header>Topo</header></body></html>"
        self.assertEqual(validate({"action": "write_section", "section": "topo", "html": document})["html"], "<header>Topo</header>")

    def test_invalid_requests_are_refused(self):
        cases = [
            ("not an object", "Arguments must be an object"),
            ({"action": "delete_everything"}, "action must be one of"),
            ({"action": "read", "path": "../x"}, "Unknown arguments"),
            ({"action": "write_section", "section": "a", "html": "x" * 20_001}, "longer than"),
            ({"action": "write_section", "section": "!!!", "html": "<p>x</p>"}, "Invalid section id"),
            ({"action": "write_section", "section": "a", "html": "<html><head></head></html>"}, "no content"),
            ({"action": "write_section", "section": "a", "html": "<!-- studio:section b -->"}, "markers"),
            ({"action": "write_styles", "css": "</style><script>"}, "</style>"),
            ({"action": "remove_page", "page": "index"}, "home page"),
            ({"action": "write_styles", "css": "a{}", "title": "x"}, "title is only used"),
        ]
        for arguments, message in cases:
            with self.subTest(arguments=arguments):
                with self.assertRaisesRegex(WebStudioError, message):
                    validate(arguments)


class SiteTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        self.context = {"studio_root": str(self.root)}

    def call(self, **arguments):
        return run(validate(arguments), self.context)

    def test_sections_build_pages_one_step_at_a_time(self):
        self.call(action="write_styles", css="body { margin: 0; }")
        first = self.call(action="write_section", section="header", html="<header>Café Aurora</header>", title="Café Aurora")
        self.call(action="write_section", section="hero", html="<section>Café fresco</section>")
        self.call(action="write_section", page="Cardápio", section="menu", html="<section>Espresso</section>")

        self.assertEqual(first["text"], "Section 'header' added to page 'index' (1 sections). Next: another call, or answer the user in one short sentence.")
        self.assertEqual(sorted(path.name for path in self.root.iterdir() if not path.name.startswith(".studio")), ["cardapio.html", "index.html", "site.json", "styles.css"])
        index = (self.root / "index.html").read_text(encoding="utf-8")
        self.assertIn("<title>Café Aurora</title>", index)
        self.assertIn('<link rel="stylesheet" href="styles.css">', index)
        self.assertLess(index.index("<header>Café Aurora</header>"), index.index("<section>Café fresco</section>"))
        self.assertIn("<!-- studio:section hero -->\n<section>Café fresco</section>\n<!-- /studio:section hero -->", index)
        self.assertIn("<title>Café Aurora</title>", (self.root / "cardapio.html").read_text(encoding="utf-8"))
        self.assertEqual((self.root / "styles.css").read_text(encoding="utf-8"), "/* studio:style base */\nbody { margin: 0; }\n")
        site = json.loads((self.root / "site.json").read_text(encoding="utf-8"))
        self.assertEqual([(page["id"], [section["id"] for section in page["sections"]]) for page in site["pages"]],
                         [("index", ["header", "hero"]), ("cardapio", ["menu"])])

    def test_replacing_and_removing_keep_the_order_and_files_in_sync(self):
        self.call(action="write_section", section="hero", html="<section>Antes</section>")
        self.call(action="write_section", section="footer", html="<footer>Rodapé</footer>")
        replaced = self.call(action="write_section", section="hero", html="<section>Depois</section>")
        self.call(action="write_section", page="contato", section="mapa", html="<section>Mapa</section>")
        self.call(action="remove_section", section="footer")
        removed = self.call(action="remove_page", page="contato")

        self.assertTrue(replaced["text"].startswith("Section 'hero' replaced on page 'index'."))
        index = (self.root / "index.html").read_text(encoding="utf-8")
        self.assertIn("Depois", index)
        self.assertNotIn("Antes", index)
        self.assertNotIn("Rodapé", index)
        self.assertFalse((self.root / "contato.html").exists())
        self.assertEqual(removed["pages"], [{"page": "index", "file": "index.html", "title": "", "sections": ["hero"]}])

    def test_read_returns_the_outline_or_one_page(self):
        self.call(action="write_styles", name="Cores", css=":root { --cor: #c4683f; }")
        self.call(action="write_section", section="hero", html="<section>Oi</section>", title="Início")
        outline = json.loads(self.call(action="read")["text"])
        page = json.loads(self.call(action="read", page="index")["text"])

        self.assertEqual(outline, {"pages": [{"page": "index", "file": "index.html", "title": "Início", "sections": ["hero"]}],
                                   "styles": [{"name": "cores", "characters": len(":root { --cor: #c4683f; }")}]})
        self.assertEqual(page, {"page": "index", "title": "Início", "sections": [{"id": "hero", "html": "<section>Oi</section>", "complete": True}]})

    def test_missing_pages_or_sections_are_reported_without_writing(self):
        with self.assertRaisesRegex(WebStudioError, "does not exist"):
            self.call(action="remove_section", section="hero")
        with self.assertRaisesRegex(WebStudioError, "does not exist"):
            self.call(action="read", page="contato")
        self.assertEqual([p for p in self.root.iterdir() if p.name != ".studio.lock"], [])

    def test_every_section_of_a_large_page_can_be_read_without_omissions(self):
        expected = {f"s{i}": "<p>" + str(i) * 19993 + "</p>" for i in range(4)}
        for section, html in expected.items():
            self.call(action="write_section", section=section, html=html)
        received = {}
        request = {"action": "read", "page": "index"}
        while request:
            result = self.call(**request)
            self.assertLessEqual(len(json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8")), MAX_READ_BYTES)
            data = json.loads(result["text"])
            for section in data["sections"]:
                before = received.get(section["id"], "")
                self.assertEqual(section.get("offset", 0), len(before))
                received[section["id"]] = before + section["html"]
            request = data.get("next")
        self.assertEqual(received, expected)
        selected = json.loads(self.call(action="read", page="index", section="s3")["text"])
        self.assertEqual(selected["sections"], [{"id": "s3", "html": expected["s3"], "complete": True}])

    def test_unicode_and_json_escaping_are_budgeted_in_bytes_for_html_and_css(self):
        for field, text in (("html", "<p>" + "界🙂\\\"\u0001" * 3998 + "</p>"), ("css", 'a::after{content:"' + "\\\u0001🙂" * 6000 + '"}')):
            with self.subTest(field=field):
                selection = {"page": "index", "section": "text"} if field == "html" else {"name": "base"}
                self.call(action="write_section" if field == "html" else "write_styles", **selection, **{field: text})
                request, received, count = {"action": "read", **selection}, "", 0
                while request:
                    result = self.call(**request)
                    self.assertLessEqual(len(json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8")), MAX_READ_BYTES)
                    data = json.loads(result["text"])
                    part = data["sections"][0] if field == "html" else data
                    self.assertEqual(part.get("offset", 0), len(received))
                    received += part[field]
                    request = data.get("next")
                    count += 1
                    self.assertLess(count, 10)
                self.assertGreater(count, 1)
                self.assertEqual(received, text)

    def test_read_cursor_cannot_mix_versions_or_different_selections(self):
        self.call(action="write_section", section="large", html="<p>" + "🙂" * 19993 + "</p>")
        first = json.loads(self.call(action="read", page="index")["text"])
        with self.assertRaisesRegex(WebStudioError, "Content changed"):
            self.call(**{**first["next"], "section": "large"})
        self.call(action="write_section", section="large", html="<p>Changed</p>")
        with self.assertRaisesRegex(WebStudioError, "Content changed"):
            self.call(**first["next"])
        with self.assertRaisesRegex(WebStudioError, "Invalid read cursor"):
            self.call(action="read", page="index", cursor="invalid!")
        with self.assertRaisesRegex(WebStudioError, "does not exist"):
            self.call(action="read", page="index", section="missing")

    def test_styles_can_be_read_and_legitimately_replaced_with_much_shorter_css(self):
        base = "body { margin: 0; }\n" * 40
        self.call(action="write_styles", css=base)
        read = json.loads(self.call(action="read", name="base")["text"])
        self.assertEqual(read, {"name": "base", "css": base.strip(), "complete": True})
        self.call(action="write_styles", name="hero", css=".hero { color: red; }")
        self.call(action="write_styles", css="body{margin:0}")
        read = json.loads(self.call(action="read", name="base")["text"])
        self.assertEqual(read["css"], "body{margin:0}")
        self.assertIn(".hero { color: red; }", (self.root / "styles.css").read_text())
        with self.assertRaisesRegex(WebStudioError, "does not exist"):
            self.call(action="read", name="missing")
        with self.assertRaisesRegex(WebStudioError, "not both"):
            self.call(action="read", page="index", name="base")

    def test_limits_protect_the_site(self):
        for index in range(12):
            self.call(action="write_section", page=f"pagina-{index}", section="a", html="<p>x</p>")
        with self.assertRaisesRegex(WebStudioError, "at most 12 pages"):
            self.call(action="write_section", page="extra", section="a", html="<p>x</p>")

    def test_a_damaged_site_file_is_not_overwritten(self):
        (self.root / "site.json").write_text("{not json", encoding="utf-8")
        with self.assertRaisesRegex(WebStudioError, "damaged"):
            self.call(action="write_section", section="a", html="<p>x</p>")
        self.assertEqual((self.root / "site.json").read_text(encoding="utf-8"), "{not json")

    def test_without_a_studio_folder_nothing_is_written(self):
        for context in (None, {}, {"studio_root": ""}, {"studio_root": "relative/folder"},
                        {"studio_root": str(self.root / "missing")}, {"studio_root": str(Path(self.root.anchor))}):
            with self.subTest(context=context):
                with self.assertRaisesRegex(WebStudioError, "Studio"):
                    run(validate({"action": "write_section", "section": "a", "html": "<p>x</p>"}), context)
        self.assertEqual([p for p in self.root.iterdir() if p.name != ".studio.lock"], [])


if __name__ == "__main__":
    unittest.main()
