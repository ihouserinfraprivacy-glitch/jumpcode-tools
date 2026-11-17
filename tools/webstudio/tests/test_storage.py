import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from jumpcode_webstudio import run, validate, WebStudioError
from jumpcode_webstudio import storage


class TransactionTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        self.call(action="write_section", section="hero", html="<h1>Before</h1>")
        self.call(action="write_section", page="contact", section="body", html="<p>Contact</p>")
        self.call(action="write_styles", css="body { color: red; }")
        self.before = self.snapshot()

    def call(self, **args):
        return run(validate(args), {"studio_root": str(self.root)})

    def snapshot(self):
        return {p.name: p.read_bytes() for p in self.root.iterdir() if p.name != storage.LOCK}

    def fail_once(self, name, error=OSError("disk unavailable")):
        original = storage.atomic_write
        failed = False
        def write(path, content):
            nonlocal failed
            if path.name == name and not failed:
                failed = True
                raise error
            return original(path, content)
        return patch.object(storage, "atomic_write", write)

    def test_failures_before_during_and_at_commit_restore_exact_files(self):
        for target in (storage.JOURNAL, "index.html", "site.json"):
            with self.subTest(target=target), self.fail_once(target):
                with self.assertRaises(WebStudioError):
                    self.call(action="write_section", section="hero", html="<h1>After</h1>")
            self.assertEqual(self.snapshot(), self.before)
        with self.fail_once("site.json"):
            with self.assertRaises(WebStudioError):
                self.call(action="write_styles", css="body{color:blue}")
        self.assertEqual(self.snapshot(), self.before)

    def test_failed_deletion_and_failed_creation_are_rolled_back(self):
        for args in ({"action": "remove_page", "page": "contact"},
                     {"action": "write_section", "page": "new", "section": "a", "html": "<p>New</p>"}):
            with self.subTest(args=args), self.fail_once("site.json"):
                with self.assertRaises(WebStudioError):
                    self.call(**args)
            self.assertEqual(self.snapshot(), self.before)

    def test_interrupted_save_recovers_on_next_read_without_replaying_the_change(self):
        with self.fail_once("site.json", SystemExit("process stopped")):
            with self.assertRaises(SystemExit):
                self.call(action="write_section", section="hero", html="<h1>After</h1>")
        self.assertTrue((self.root / storage.JOURNAL).exists())
        self.assertIn("After", (self.root / "index.html").read_text())
        recovered = self.call(action="read", page="index")
        self.assertIn("Before", recovered["text"])
        self.assertEqual(self.snapshot(), self.before)

    def test_unconfirmed_rollback_retains_recovery_record(self):
        original = storage.atomic_write
        def fail(path, text):
            if path.name == "site.json":
                raise OSError("disk still unavailable")
            return original(path, text)
        with patch.object(storage, "atomic_write", fail):
            with self.assertRaisesRegex(RuntimeError, "recovery is not yet confirmed"):
                self.call(action="write_section", section="hero", html="<h1>After</h1>")
            with self.assertRaisesRegex(RuntimeError, "recovery could not be confirmed"):
                self.call(action="read")
        self.call(action="read")
        self.assertEqual(self.snapshot(), self.before)

    def test_committed_change_survives_cleanup_failure(self):
        original = Path.unlink
        def unlink(path, *args, **kwargs):
            if path.name == storage.JOURNAL:
                raise PermissionError("reader holds file")
            return original(path, *args, **kwargs)
        with patch.object(Path, "unlink", unlink):
            self.call(action="write_section", section="hero", html="<h1>After</h1>")
        self.assertTrue((self.root / storage.JOURNAL).exists())
        self.assertIn("After", self.call(action="read", page="index")["text"])
        self.assertFalse((self.root / storage.JOURNAL).exists())
        self.assertIn("After", (self.root / "index.html").read_text())

    def test_corrupt_or_escaping_recovery_record_never_writes_outside_studio(self):
        (self.root / storage.JOURNAL).write_text(json.dumps({"version": 1, "commit": "x", "before": {
            "site.json": None, "../outside.html": "bad"}}))
        with self.assertRaisesRegex(RuntimeError, "recovery could not be confirmed"):
            self.call(action="read")
        self.assertEqual((self.root / "site.json").read_bytes(), self.before["site.json"])

    def test_atomic_write_cleans_temporary_files_when_replace_fails(self):
        with patch.object(storage.os, "replace", side_effect=OSError("disk error")):
            with self.assertRaises(OSError):
                storage.atomic_write(self.root / "index.html", "new")
        self.assertEqual(self.snapshot(), self.before)

    def test_unreadable_recovery_record_is_uncertain_not_a_new_request_error(self):
        (self.root / storage.JOURNAL).write_bytes(b"\xff\xfe")
        with self.assertRaisesRegex(RuntimeError, "recovery could not be confirmed"):
            self.call(action="read")
        self.assertEqual((self.root / "site.json").read_bytes(), self.before["site.json"])

    def test_windows_device_names_cannot_be_opened_as_pages(self):
        with self.assertRaises(WebStudioError):
            self.call(action="write_section", page="nul", section="hero", html="<h1>No</h1>")
        self.assertEqual(self.snapshot(), self.before)

    def test_two_processes_do_not_lose_each_others_sections(self):
        source = str(Path(__file__).resolve().parents[1] / "src")
        script = """import sys
sys.path.insert(0,sys.argv[1])
from jumpcode_webstudio import run,validate
for i in range(5):
 run(validate({'action':'write_section','section':sys.argv[3]+str(i),'html':'<p>Concurrent</p>'}),{'studio_root':sys.argv[2]})
"""
        processes = [subprocess.Popen([sys.executable, "-B", "-c", script, source, str(self.root), prefix],
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE) for prefix in ("left", "right")]
        try:
            for process in processes:
                _, error = process.communicate(timeout=30)
                self.assertEqual(process.returncode, 0, error.decode())
        finally:
            for process in processes:
                if process.poll() is None:
                    process.kill()
                    process.communicate()
        page = json.loads(self.call(action="read", page="index")["text"])
        self.assertEqual(len(page["sections"]), 11)


if __name__ == "__main__":
    unittest.main()
