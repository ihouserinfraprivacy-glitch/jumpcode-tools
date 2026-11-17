# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""The tool as the model uses it, with a stand-in engine: listing and checking images, generating without ever
replacing a file unasked, regenerating a model with more animations, a batch with a model that gets no skeleton,
cancellation, paths that try to leave the project, argument aliases, finding the engine and the Studio files.
The last class runs the real engine when it is installed on this computer."""

import base64
import json
import os
from pathlib import Path
import shutil
import struct
import sys
import tempfile
import unittest
from unittest import mock
import zlib

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import jumpcode_generator3d as tool  # noqa: E402
from jumpcode_generator3d import actions, engine as engines, views  # noqa: E402
from jumpcode_generator3d.arguments import ACTION_FIELDS  # noqa: E402
from jumpcode_generator3d.common import Cancelled, GeneratorError, image_size, read_json  # noqa: E402

ANIMATIONS = ["clapping", "crouch-idle", "dance-charleston", "dance-simple", "death-a", "fighting-idle", "greeting", "idle-a",
              "idle-subtle", "jog", "jump-2", "kick-front", "pick-up", "punch-jab", "reject", "rest-pose", "run-anime", "run-female",
              "sitting-idle", "sprint", "victory", "walk", "walk-female", "yes"]
DEFAULTS = ["idle-a", "walk", "jog", "jump-2", "greeting", "dance-simple"]
NAMES = ["nose", "left_eye", "right_eye", "left_ear", "right_ear", "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
         "left_wrist", "right_wrist", "left_hip", "right_hip", "left_knee", "right_knee", "left_ankle", "right_ankle"]


def png(width, height):
    raw = b"".join(b"\x00" + b"\x80\x80\x80" * width for _ in range(height))
    chunk = lambda kind, data: struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def jpeg(width, height):
    sof = b"\xff\xc0" + struct.pack(">HBHHB", 11, 8, height, width, 1) + b"\x01\x11\x00"
    return b"\xff\xd8" + b"\xff\xe0" + struct.pack(">H", 16) + b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00" + sof + b"\x00" * 64 + b"\xff\xd9"


def glb(name):
    document = json.dumps({"asset": {"version": "2.0"}, "nodes": [{"name": name}]}).encode()
    document += b" " * (-len(document) % 4)
    binary = name.encode().ljust(16, b"\x00")
    chunks = struct.pack("<II", len(document), 0x4E4F534A) + document + struct.pack("<II", len(binary), 0x004E4942) + binary
    return b"glTF" + struct.pack("<II", 2, 12 + len(chunks)) + chunks


def bmp(width, height):
    return b"BM" + b"\x00" * 16 + struct.pack("<ii", width, height) + b"\x00" * 60


def webp(width, height):
    body = b"VP8X" + struct.pack("<I", 10) + b"\x00\x00\x00\x00" + (width - 1).to_bytes(3, "little") + (height - 1).to_bytes(3, "little")
    return b"RIFF" + struct.pack("<I", 4 + len(body) + 40) + b"WEBP" + body + b"\x00" * 40


class FakeEngine:
    """Answers like the runner: images named cavalo come out without a skeleton, busto is not a full body."""

    def __init__(self):
        self.requests = []
        self.cancel_after_write = False

    def last(self, action):
        return next(request for request in reversed(self.requests) if request["action"] == action)

    def locate(self):
        return engines.Engine(Path("C:/engine"), Path("C:/engine/python.exe"), "package")

    def call(self, found, request, on_event=None, cancelled=None, timeout=600):
        self.requests.append(request)
        action = request["action"]
        if action == "info":
            return {"version": "0.1.0", "animations": ANIMATIONS, "defaults": DEFAULTS, "providers": ["DmlExecutionProvider", "CPUExecutionProvider"]}
        if action == "thumbs":
            return {"thumbs": [{"path": path, "thumb": "data:image/png;base64,AAAA"} for path in request["paths"]]}
        if action == "check":
            name = Path(request["image"]).stem
            scores = [0.9] * 17 if name != "busto" else [0.9] * 7 + [0.5, 0.5] + [0.1] * 8
            kind = "NotFullBodyError" if name == "busto" else "NotHumanoidError" if name == "cavalo" else None
            return {"size": [1024, 1024], "original": "data:image/png;base64,AAAA", "prepared": "data:image/png;base64,AAAA",
                    "joints": "data:image/png;base64,AAAA", "filled": 0.12, "seconds": 1.0,
                    "keypoints": [{"name": n, "u": 200.0 + i, "v": 100.0 + i * 10, "score": s} for i, (n, s) in enumerate(zip(NAMES, scores))],
                    "verdict": {"rig": kind is None, "kind": kind, "detail": "english detail" if kind else None}}
        if action == "generate":
            results = []
            for index, item in enumerate(request["items"]):
                on_event and on_event({"event": "item", "index": index, "image": item["image"]})
                for step in ("background", "encode", "mesh", "simplify", "pose", "rig", "texture", "write"):
                    on_event and on_event({"event": "progress", "index": index, "step": step})
                Path(item["output"]).write_bytes(glb(Path(item["image"]).name))
                if self.cancel_after_write:
                    raise Cancelled("The operation was cancelled; the engine was stopped and nothing was saved.")
                static = Path(item["image"]).stem == "cavalo" or not item["rig"]
                results.append({"index": index, "ok": True, "image": item["image"], "output": item["output"], "rigged": not static,
                                "reason": "no confident human" if static and item["rig"] else None,
                                "reasonKind": "NotHumanoidError" if static and item["rig"] else None,
                                "clips": [] if static else list(item["animations"]), "vertices": 12882, "faces": 19871,
                                "timings": {"background": 0.4, "encode": 2.7, "release_encoder": 0.2, "mesh": 1.5, "simplify": 1.5,
                                            "pose": 0.4, "rig": 1.0, "load_clips": 0.1, "texture": 7.2, "write": 0.1},
                                "devices": {"encoder": "dml"}, "warnings": [], "thumb": "data:image/png;base64,AAAA", "seconds": 15.4})
            return {"items": results}
        raise AssertionError(action)


class Base(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix="generator3d-"))
        self.studio = self.base / "studio"
        self.project = self.base / "jogo"
        self.studio.mkdir()
        (self.project / "arte" / "personagens").mkdir(parents=True)
        (self.project / "arte" / "animais").mkdir(parents=True)
        (self.project / "node_modules" / "pacote").mkdir(parents=True)
        (self.project / "arte" / "personagens" / "jay.png").write_bytes(png(96, 128))
        (self.project / "arte" / "personagens" / "arqueira.jpg").write_bytes(jpeg(640, 480))
        (self.project / "arte" / "personagens" / "busto.bmp").write_bytes(bmp(300, 200))
        (self.project / "arte" / "animais" / "cavalo.webp").write_bytes(webp(512, 512))
        (self.project / "node_modules" / "pacote" / "logo.png").write_bytes(png(100, 100))
        (self.project / "arte" / "icone.png").write_bytes(png(16, 16))
        self.context = {"studio_root": str(self.studio), "source_root": str(self.project), "request_id": "r1"}
        self.fake = FakeEngine()
        patches = [mock.patch.object(actions.engines, "locate", self.fake.locate), mock.patch.object(actions.engines, "call", self.fake.call)]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    def tearDown(self):
        shutil.rmtree(self.base, ignore_errors=True)

    def call(self, **arguments):
        return tool.run(tool.validate(arguments), dict(self.context))

    def state(self):
        return read_json(self.studio / "state.json")


class Images(Base):
    def test_lists_images_with_sizes_skipping_tools_and_tiny_files(self):
        result = self.call(action="images")
        state = self.state()
        self.assertEqual({(i["path"], i["width"], i["height"], bool(i["thumb"])) for i in state["images"]}, {
            ("arte/personagens/jay.png", 96, 128, True), ("arte/personagens/arqueira.jpg", 640, 480, True),
            ("arte/personagens/busto.bmp", 300, 200, True), ("arte/animais/cavalo.webp", 512, 512, True)})
        self.assertIn("arte/personagens/jay.png (96×128)", result["message"])

    def test_open_checks_the_image_and_names_what_is_missing(self):
        good = self.call(action="open", path="arte/personagens/jay.png")
        bust = self.call(action="abrir", path="arte\\personagens\\busto.bmp")
        image = read_json(self.studio / "image.json")
        self.assertEqual((good["rig"], bust["rig"], bust["reason"], image["path"], image["verdict"]["kind"], self.state()["view"],
                          [c["ok"] for c in image["checks"]], image["keypoints"][15]["label"]), (
            True, False, views.REASONS["NotFullBodyError"], "arte/personagens/busto.bmp", "NotFullBodyError", "image",
            [True, False, False, True, True], "tornozelo esquerdo"))
        self.assertIn("Not in the image: pulso esquerdo", bust["message"])

    def test_paths_never_leave_the_project(self):
        for path in ("../fora.png", "C:/Windows/win.ini", "/etc/passwd", ""):
            with self.subTest(path=path), self.assertRaises(GeneratorError):
                self.call(action="open", path=path)


class Generate(Base):
    def test_saves_the_model_and_shows_it(self):
        result = self.call(action="generate", path="arte/personagens/jay.png", animations=["walk", "acenar"])
        state = self.state()
        model = read_json(self.studio / "model.json")
        target = self.project / "modelos" / "jay.glb"
        linked = {image["path"]: image["model"] for image in state["images"]}
        self.assertEqual((result["models"], state["models"][0]["clips"], state["models"][0]["source"], state["focus"]["model"],
                          state["view"], base64.b64decode(model["glb"]) == target.read_bytes(), state["job"]["state"],
                          [s["state"] for s in state["job"]["steps"]], linked["arte/personagens/jay.png"],
                          sorted(p.name for p in target.parent.iterdir()), self.fake.last("generate")["items"][0]["texture"]), (
            ["modelos/jay.glb"], ["walk", "greeting"], "arte/personagens/jay.png", "modelos/jay.glb", "model", True, "done",
            ["done"] * 9, "modelos/jay.glb", ["jay.glb"], 1024))
        self.assertIn("in 15,1 s", result["message"])

    def test_never_replaces_a_file_unless_the_user_agreed(self):
        self.call(action="generate", path="arte/personagens/jay.png")
        before = (self.project / "modelos" / "jay.glb").read_bytes()
        with self.assertRaises(GeneratorError) as refused:
            self.call(action="generate", path="arte/personagens/jay.png", texture=0)
        # overwrite sent on its own, in the same request that was refused, is not the user's answer
        with self.assertRaises(GeneratorError) as retried:
            self.call(action="generate", path="arte/personagens/jay.png", overwrite=True, texture=0)
        self.assertEqual((self.project / "modelos" / "jay.glb").read_bytes(), before)
        self.context["request_id"] = "r2"
        replaced = self.call(action="generate", path="arte/personagens/jay.png", overwrite=True, texture=0)
        self.assertIn("overwrite true", str(refused.exception))
        self.assertIn("agreement in a new message", str(retried.exception))
        self.assertEqual((replaced["models"], self.fake.last("generate")["items"][0]["texture"]), (["modelos/jay.glb"], 0))

    def test_overwrite_with_words_of_consent_and_never_out_of_nowhere(self):
        (self.project / "modelos").mkdir()
        (self.project / "modelos" / "jay.glb").write_bytes(b"made by hand")
        with self.assertRaises(GeneratorError):
            self.call(action="generate", path="arte/personagens/jay.png", overwrite=True)
        self.context["request_id"] = "r9"
        replaced = self.call(action="generate", path="arte/personagens/jay.png", overwrite=True, question="pode substituir o jay")
        self.assertEqual(replaced["models"], ["modelos/jay.glb"])

    def test_the_file_records_its_image_so_another_studio_can_make_it_again(self):
        self.call(action="generate", path="arte/personagens/jay.png", animations=["walk"], height=1.5)
        other = self.base / "other-studio"
        other.mkdir()
        self.context["studio_root"] = str(other)
        again = self.call(action="generate", model="modelos/jay.glb", add=["jump-2"])
        request = self.fake.last("generate")["items"][0]
        self.assertEqual((again["models"], request["animations"], request["height"], Path(request["image"]).name),
                         (["modelos/jay.glb"], ["walk", "jump-2"], 1.5, "jay.png"))
        # once someone changed the file, the same request needs the user's agreement
        data = bytearray((self.project / "modelos" / "jay.glb").read_bytes())
        data[-1] = 0x41
        (self.project / "modelos" / "jay.glb").write_bytes(bytes(data))
        with self.assertRaises(GeneratorError):
            self.call(action="generate", model="modelos/jay.glb", add=["victory"])

    def test_add_that_repeats_the_model_animations_is_the_whole_list(self):
        self.call(action="generate", path="arte/personagens/jay.png", animations=["walk", "greeting"])
        self.call(action="generate", model="modelos/jay.glb", add=["walk", "run-anime"])
        self.assertEqual(self.state()["models"][0]["clips"], ["walk", "run-anime"])

    def test_regenerating_a_model_adds_animations_and_keeps_its_options(self):
        self.call(action="generate", path="arte/personagens/jay.png", animations="walk, greeting", height=1.55, texture=0)
        result = self.call(action="gerar", path="modelos/jay.glb", add=["correr", "victory"])
        request = self.fake.last("generate")["items"][0]
        self.assertEqual((result["models"], request["animations"], request["height"], request["texture"],
                          self.state()["models"][0]["clips"], len(self.state()["models"])),
                         (["modelos/jay.glb"], ["walk", "greeting", "run-anime", "victory"], 1.55, 0,
                          ["walk", "greeting", "run-anime", "victory"], 1))

    def test_batch_with_an_animal_saves_it_without_a_skeleton(self):
        (self.project / "modelos").mkdir()
        (self.project / "modelos" / "arqueira.glb").write_bytes(b"old")
        result = self.call(action="generate", paths=["arte/animais/cavalo.webp", "arte/personagens/arqueira.jpg", "arte/personagens/jay.png"])
        state = self.state()
        self.assertEqual((result["models"], [r["state"] for r in state["job"]["results"]], state["models"][1]["reason"],
                          (self.project / "modelos" / "arqueira.glb").read_bytes()), (
            ["modelos/cavalo.glb", "modelos/jay.glb"], ["static", "done"], views.REASONS["NotHumanoidError"], b"old"))
        self.assertIn("Not generated because the file exists: modelos/arqueira.glb", result["message"])
        self.assertIn("WITHOUT a skeleton", result["message"])

    def test_cancel_leaves_no_partial_file(self):
        self.fake.cancel_after_write = True
        with self.assertRaises(Cancelled):
            self.call(action="generate", path="arte/personagens/jay.png")
        self.assertEqual((list((self.project / "modelos").iterdir()), self.state()["job"]["state"]), ([], "cancelled"))

    def test_small_model_slips_still_make_the_right_model(self):
        """What qwen3.5:4b sent in the window test: the list in the singular field as text, and a model name that does
        not exist yet next to the image."""
        result = self.call(action="generate", path="arte/personagens/jay.png", model="heroi.glb", animation='["walk", "greeting"]')
        request = self.fake.last("generate")["items"][0]
        self.assertEqual((result["models"], request["animations"], self.state()["job"]["outputs"]),
                         (["modelos/heroi.glb"], ["walk", "greeting"], ["modelos/heroi.glb"]))

    def test_without_bones_on_request_keeps_the_reason_the_check_found(self):
        self.call(action="open", path="arte/personagens/busto.bmp")
        self.call(action="generate", rig=False)
        model = self.state()["models"][0]
        self.assertEqual((model["rigged"], model["reasonKind"], model["reason"]), (False, "NotFullBodyError", views.REASONS["NotFullBodyError"]))

    def test_a_refusal_to_replace_shows_in_the_studio(self):
        self.call(action="generate", path="arte/personagens/jay.png")
        with self.assertRaises(GeneratorError):
            self.call(action="generate", path="arte/personagens/jay.png")
        notice = self.state()["notice"]
        self.assertEqual((notice["kind"], notice["text"]), ("warning", "modelos/jay.glb já existe: responda na conversa se pode substituir."))

    def test_what_the_model_sent_in_the_second_window_test(self):
        """An image path as model with add on a new model; add of a name the model already has; a path that replaces a
        tool-made file after consent keeps that file's animations."""
        first = self.call(action="generate", add=["andar", "acenar"], model="arte/personagens/jay.png",
                          paths=["arte/personagens/jay.png"])
        self.assertEqual((first["models"], self.fake.last("generate")["items"][0]["animations"]), (["modelos/jay.glb"], ["walk", "greeting"]))
        calls = len([r for r in self.fake.requests if r["action"] == "generate"])
        same = self.call(action="generate", model="modelos/jay.glb", add=["walk"], overwrite=True)
        self.assertEqual((same["models"], len([r for r in self.fake.requests if r["action"] == "generate"])), ([], calls))
        self.assertIn("nothing was generated", same["message"])
        self.context["request_id"] = "r2"
        replaced = self.call(action="generate", path="arte/personagens/jay.png", name="jay", overwrite=True, texture=0,
                             question="sim, pode substituir")
        request = self.fake.last("generate")["items"][0]
        self.assertEqual((replaced["models"], request["animations"], request["texture"]), (["modelos/jay.glb"], ["walk", "greeting"], 0))

    def test_unknown_animation_suggests_names(self):
        with self.assertRaises(GeneratorError) as error:
            self.call(action="generate", path="arte/personagens/jay.png", animations=["walkk"])
        self.assertIn("Did you mean walk", str(error.exception))

    def test_show_and_settings(self):
        self.call(action="generate", path="arte/personagens/jay.png", animations=["walk"])
        self.call(action="show", view="pesos", bone="upperarm_l", camera="costas")
        shown = self.call(action="show", model="jay.glb", animation="jump-2")
        changed = self.call(action="settings", texture=0, device="gpu", animations=["default"])
        state = self.state()
        self.assertEqual((state["focus"]["bone"], state["focus"]["camera"], state["settings"]["texture"], state["settings"]["device"],
                          state["settings"]["animations"], state["view"]), ("upperarm_l", "back", 0, "dml", DEFAULTS, "settings"))
        self.assertIn("has no animation jump-2", shown["message"])
        self.assertIn("Changed animations, texture, device", changed["message"])


class Engine(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix="generator3d-engine-"))
        self.addCleanup(shutil.rmtree, self.base, True)
        patch = mock.patch.dict(os.environ, {"JUMPCODE_GENERATOR3D_ENGINE": str(self.base), "LOCALAPPDATA": str(self.base / "local")})
        patch.start()
        self.addCleanup(patch.stop)

    def test_says_what_is_missing(self):
        with self.assertRaises(engines.EngineMissing) as no_program:
            engines.locate()
        (self.base / "fotorig").mkdir()
        (self.base / "fotorig" / "pipeline.py").write_text("")
        with self.assertRaises(engines.EngineMissing) as no_models:
            engines.locate()
        (self.base / "models").mkdir()
        for name in engines.REQUIRED_MODELS:
            (self.base / "models" / name).write_bytes(b"x")
        (self.base / "assets" / "human").mkdir(parents=True)
        with self.assertRaises(engines.EngineMissing) as no_python:
            engines.locate()
        (self.base / "python.exe").write_bytes(b"")
        found = engines.locate()
        self.assertEqual(("fotorig" in no_program.exception.problem, "triposr-encoder.onnx" in no_models.exception.problem,
                          "interpreter" in no_python.exception.problem, found.layout, found.python.name), (True, True, True, "package", "python.exe"))

    def test_status_without_engine_still_lists_images(self):
        os.environ["JUMPCODE_GENERATOR3D_ENGINE"] = str(self.base / "nada")
        studio, project = self.base / "studio", self.base / "jogo"
        studio.mkdir()
        project.mkdir()
        (project / "heroi.png").write_bytes(png(128, 128))
        context = {"studio_root": str(studio), "source_root": str(project)}
        result = tool.run(tool.validate({"action": "status"}), dict(context))
        state = read_json(studio / "state.json")
        with self.assertRaises(GeneratorError) as refused:
            tool.run(tool.validate({"action": "generate", "path": "heroi.png"}), dict(context))
        self.assertEqual((result["ready"], result["images"], state["engine"]["ready"], bool(state["engine"]["fix"])), (False, 1, False, True))
        self.assertIn("nothing was generated", str(refused.exception))


class Package(unittest.TestCase):
    def test_manifest_and_arguments_agree(self):
        schema = tool.MANIFEST["inputSchema"]
        fields = set().union(*ACTION_FIELDS.values()) | {"action", "question"}
        self.assertEqual((tool.MANIFEST["id"], tool.MANIFEST["name"], tool.MANIFEST["studio"]["ui"], set(schema["properties"]["action"]["enum"]),
                          set(schema["properties"]), tool.MANIFEST["studio"]["mark"].startswith("data:image/svg+xml;base64,")),
                         ("generator3d", "3D Generator", True, set(ACTION_FIELDS), fields, True))

    def test_aliases(self):
        cases = [({"action": "gerar", "path": "a.png", "device": "gpu", "texture": True}, {"action": "generate", "path": "a.png", "device": "dml", "texture": 1024}),
                 ({"action": "generate", "path": "modelos/a.glb"}, {"action": "generate", "model": "modelos/a.glb"}),
                 ({"action": "mostrar", "path": "modelos/a.glb", "view": "esqueleto", "camera": "lado"}, {"action": "show", "model": "modelos/a.glb", "view": "skeleton", "camera": "side"}),
                 ({"action": "settings", "height": "1,55 m", "animations": "walk; jog"}, {"action": "settings", "height": 1.55, "animations": ["walk", "jog"]})]
        self.assertEqual([tool.validate(given) for given, _ in cases], [expected for _, expected in cases])
        with self.assertRaises(GeneratorError):
            tool.validate({"action": "generate", "texture": 333})

    def test_image_headers(self):
        folder = Path(tempfile.mkdtemp(prefix="generator3d-img-"))
        self.addCleanup(shutil.rmtree, folder, True)
        sizes = []
        for name, data in (("a.png", png(33, 44)), ("b.jpg", jpeg(640, 480)), ("c.bmp", bmp(300, 200)), ("d.webp", webp(512, 256)), ("e.txt", b"hello world")):
            (folder / name).write_bytes(data)
            sizes.append(image_size(folder / name))
        self.assertEqual(sizes, [(33, 44), (640, 480), (300, 200), (512, 256), None])

    def test_studio_interface_starts_with_three(self):
        ui = tool.studio_ui()
        self.assertTrue(ui["js"].lstrip().startswith("/**\n * three.js 0.187.0") and "G3D_THREE" in ui["js"] and ui["css"])


ENGINE_ROOT = os.environ.get("JUMPCODE_GENERATOR3D_ENGINE") or r"C:\Projects\foto-para-rig"
SAMPLE = Path(ENGINE_ROOT) / "saida" / "teste-sintel" / "entrada-sintel.png"


@unittest.skipUnless(SAMPLE.is_file() and (Path(ENGINE_ROOT) / "models" / "triposr-encoder.onnx").is_file(), "the 3D engine is not installed")
class RealEngine(unittest.TestCase):
    """The real foto-para-rig engine: check and generate a rigged model from a full-body image."""

    def test_check_and_generate(self):
        base = Path(tempfile.mkdtemp(prefix="generator3d-real-"))
        self.addCleanup(shutil.rmtree, base, True)
        (base / "studio").mkdir()
        (base / "jogo" / "arte").mkdir(parents=True)
        shutil.copyfile(SAMPLE, base / "jogo" / "arte" / "arqueira.png")
        context = {"studio_root": str(base / "studio"), "source_root": str(base / "jogo")}
        with mock.patch.dict(os.environ, {"JUMPCODE_GENERATOR3D_ENGINE": ENGINE_ROOT}):
            opened = tool.run(tool.validate({"action": "open", "path": "arte/arqueira.png"}), dict(context))
            made = tool.run(tool.validate({"action": "generate", "animations": ["walk"], "texture": 0}), dict(context))
        glb = (base / "jogo" / "modelos" / "arqueira.glb").read_bytes()
        header = json.loads(glb[20:20 + struct.unpack("<I", glb[12:16])[0]])
        self.assertEqual((opened["rig"], made["models"], glb[:4], len(header["skins"][0]["joints"]) >= 60,
                          [a["name"] for a in header["animations"]]), (True, ["modelos/arqueira.glb"], b"glTF", True, ["walk"]))


if __name__ == "__main__":
    unittest.main()
