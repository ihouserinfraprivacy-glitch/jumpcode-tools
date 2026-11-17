# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Regression tests at the persistence, source identity and transport boundaries."""

import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

PACKAGE = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(PACKAGE))
from jumpcode_archstudio import actions, run, validate
from jumpcode_archstudio.common import ArchStudioError, MAX_STUDIO_FILE, write_json

FIXTURE = Path(__file__).parent / "fixtures" / "rota-certa"
SERVICE = "v:plataforma/servicos/pedidos"


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.studio = self.root / "studio"
        self.studio.mkdir()
        self.context = {"studio_root": str(self.studio), "source_root": str(FIXTURE.resolve())}

    def call(self, **args):
        return run(validate(args), self.context)

    def model(self):
        return json.loads((self.studio / "model.json").read_text(encoding="utf-8"))

    def crash_scan(self):
        # A separate process exits without exception cleanup or finally blocks.
        script = '''
import json, os, sys
sys.path.insert(0, sys.argv[1])
from jumpcode_archstudio import actions, run, validate
original = actions.write_json
def write(root, name, data):
    original(root, name, data)
    if name == "model-partial.json":
        os._exit(73)
actions.write_json = write
run(validate({"action": "scan"}), json.loads(sys.argv[2]))
'''
        child = subprocess.run([sys.executable, "-B", "-c", script, str(PACKAGE), json.dumps(self.context)],
                               capture_output=True, timeout=30)
        self.assertEqual(child.returncode, 73, child.stderr.decode(errors="replace"))

    def test_process_exit_preserves_committed_map_and_recovers_on_read(self):
        self.call(action="scan")
        self.call(action="write_part", name="Manual importante")
        committed = (self.studio / "model.json").read_bytes()
        self.crash_scan()
        self.assertEqual((self.studio / "model.json").read_bytes(), committed)
        self.assertTrue((self.studio / "model-partial.json").is_file())
        self.assertIn("Manual importante", self.call(action="read")["text"])
        self.assertFalse((self.studio / "model-partial.json").exists())
        self.assertEqual(json.loads((self.studio / "progress.json").read_text())["status"], "failed")
        self.call(action="scan")
        self.assertIn("s:manual-importante", {n["id"] for n in self.model()["nodes"]})

    def test_first_scan_process_exit_does_not_promote_a_partial_map(self):
        self.crash_scan()
        self.assertIn("There is no map yet", self.call(action="read")["text"])
        self.assertFalse((self.studio / "model.json").exists())

    def test_scan_snapshots_share_the_host_execution_identity(self):
        self.context["execution_id"] = "interrupted-execution"
        self.crash_scan()
        snapshots = [json.loads((self.studio / name).read_text(encoding="utf-8"))
                     for name in ("progress.json", "model-partial.json")]
        self.assertEqual([item["executionId"] for item in snapshots], ["interrupted-execution"] * 2)
        self.context["execution_id"] = "new-execution"
        self.call(action="scan")
        progress = json.loads((self.studio / "progress.json").read_text(encoding="utf-8"))
        self.assertEqual((progress["executionId"], progress["status"]), ("new-execution", "done"))
        self.assertNotIn("executionId", self.model())
        self.assertFalse((self.studio / "model-partial.json").exists())
        with self.assertRaises(ArchStudioError):
            validate({"action": "scan", "execution_id": "model-cannot-choose-this"})

    def test_manual_link_setting_survives_rescan_with_fresh_evidence(self):
        source = self.root / "source"
        shutil.copytree(FIXTURE, source)
        self.context["source_root"] = str(source)
        self.call(action="scan")
        for protocol, desired in (("HTTP", True), ("MQTT", False)):
            with self.subTest(protocol=protocol):
                link = next(item for item in self.model()["links"]
                            if item["protocol"] == protocol and not item["id"].startswith(("ls", "lv")))
                args = {key: link[key] for key in ("from", "to", "protocol", "label") if key in link}
                self.call(action="write_link", **args, **{"async": desired})
                evidence = link["evidence"][0]
                file = source / evidence["path"]
                file.write_text("\n\n\n\n" + file.read_text(encoding="utf-8"), encoding="utf-8")
                self.call(action="scan")
                matches = [item for item in self.model()["links"] if item["id"] == link["id"]]
                self.assertEqual(len(matches), 1)
                updated = matches[0]
                self.assertEqual((updated["manual"], updated["async"], updated["count"]), (True, desired, link["count"]))
                self.assertIn({**evidence, "line": evidence["line"] + 4}, updated["evidence"])

    def test_failed_commit_keeps_previous_map(self):
        self.call(action="scan")
        committed = (self.studio / "model.json").read_bytes()
        original = actions.write_json

        def failing_write(root, name, data):
            if name == "model.json":
                raise ArchStudioError("Disk unavailable")
            original(root, name, data)

        with patch.object(actions, "write_json", side_effect=failing_write):
            with self.assertRaisesRegex(ArchStudioError, "Disk unavailable"):
                self.call(action="scan")
        self.assertEqual((self.studio / "model.json").read_bytes(), committed)
        self.assertFalse((self.studio / "model-partial.json").exists())

    def test_service_move_survives_scan_including_a_manual_destination(self):
        self.call(action="scan")
        for destination in ("s:app-cliente", self.call(action="write_part", name="Destino manual")["id"]):
            self.call(action="write_part", id=SERVICE, parent=destination)
            self.call(action="scan")
            nodes = {n["id"]: n for n in self.model()["nodes"]}
            self.assertEqual((nodes[SERVICE]["parent"], nodes[destination]["level"]), (destination, "system"))
            self.assertTrue(any(n.get("parent") == SERVICE for n in nodes.values()))

    def test_same_named_source_folders_do_not_share_edits_flows_or_proposals(self):
        sources = [self.root / name / "repo" for name in ("one", "two")]
        for source in sources:
            source.mkdir(parents=True)
            (source / "package.json").write_text('{"name":"repo"}')
            (source / "main.js").write_text('export const x=1;')
        self.context["source_root"] = str(sources[0])
        self.call(action="scan")
        system = next(n["id"] for n in self.model()["nodes"] if n["level"] == "system")
        self.call(action="write_part", id=system, name="Somente primeiro")
        other = self.call(action="write_part", name="Outro sistema")["id"]
        self.call(action="write_path", name="Fluxo antigo", steps=[{"from": system, "to": other}])
        self.call(action="write_proposal", title="Proposta antiga", nodes=[{"op": "change", "id": system}])
        self.call(action="focus", id=system)
        previous = self.model()
        self.context["source_root"] = str(sources[1])
        with self.assertRaisesRegex(ArchStudioError, "source folder changed"):
            self.call(action="read")
        self.call(action="scan")
        current = self.model()
        self.assertNotEqual(current["sourceId"], previous["sourceId"])
        self.assertNotIn("Somente primeiro", {n["name"] for n in current["nodes"]})
        self.assertEqual(actions._paths(self.studio), {"paths": []})
        self.assertIsNone(actions._document(self.studio, "proposal.json"))
        self.assertEqual(json.loads((self.studio / ".archstudio-previous-model").read_text(encoding="utf-8")), previous)

    def test_legacy_map_with_unknown_source_is_preserved_but_not_merged(self):
        self.call(action="scan")
        self.call(action="write_part", name="Legado")
        old = self.model()
        del old["sourceId"]
        write_json(self.studio, "model.json", old)
        self.call(action="scan")
        self.assertNotIn("s:legado", {n["id"] for n in self.model()["nodes"]})
        self.assertEqual(json.loads((self.studio / ".archstudio-previous-model").read_text(encoding="utf-8")), old)

    def test_file_limit_counts_utf8_bytes_and_keeps_existing_content(self):
        write_json(self.studio, "model.json", {"x": 1})
        with patch("jumpcode_archstudio.common.MAX_STUDIO_FILE", 20):
            with self.assertRaisesRegex(ArchStudioError, "too large"):
                write_json(self.studio, "model.json", {"x": "😀" * 5})
        self.assertEqual(self.model(), {"x": 1})

    def test_valid_scan_can_deliver_a_map_above_eight_mb(self):
        source = self.root / "large"
        source.mkdir()
        (source / "package.json").write_text('{"name":"large","type":"module"}')
        for i in range(1000):
            (source / f"module_{i:04}.js").write_text("\n".join(
                f'import {{ x as x{j} }} from "./module_{(i+j+1)%1000:04}.js";' for j in range(45)) + '\nexport const x=1;')
        self.context["source_root"] = str(source)
        self.call(action="scan")
        size = (self.studio / "model.json").stat().st_size
        self.assertGreater(size, 8_000_000)
        self.assertLessEqual(size, MAX_STUDIO_FILE)
        self.assertEqual(len(self.model()["links"]), 45_000)


if __name__ == "__main__":
    unittest.main()
