# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

import calendar
from inspect import signature
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import jumpcode_taskstudio  # noqa: E402
from jumpcode_taskstudio import MANIFEST, TaskStudioError, run, studio_ui, validate  # noqa: E402
from jumpcode_taskstudio import common  # noqa: E402
from jumpcode_taskstudio.studio import Studio  # noqa: E402
from jumpcode_taskstudio.arguments import ACTIONS, FIELDS  # noqa: E402
from jumpcode_taskstudio.plan import LIMITS  # noqa: E402
import make_fixtures  # noqa: E402

PACKAGE = Path(jumpcode_taskstudio.__file__).resolve().parent
REPOSITORY = Path(__file__).resolve().parents[3]
START = calendar.timegm((2026, 11, 13, 14, 20, 0))


class Clock:
    """A clock that moves ten seconds on every call, so each action has its own time."""

    def __init__(self):
        self.calls = 0

    def __call__(self):
        value = START + self.calls * 10
        self.calls += 1
        return value


def chain(count):
    """Tasks 1..count where each task depends on the previous one."""
    return [{"title": f"Tarefa {number}", **({"deps": [number - 1]} if number > 1 else {})}
            for number in range(1, count + 1)]


class StudioTestCase(unittest.TestCase):
    maxDiff = None

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.folder = Path(temporary.name)
        self.studio = self.folder / "studio"
        self.studio.mkdir()
        self.source = self.folder / "source"
        self.source.mkdir()
        self.context = {"studio_root": str(self.studio), "source_root": str(self.source), "execution_id": "exec-1", "request_id": "request-1"}
        self.clock = Clock()

    def call(self, **arguments):
        return run(arguments, self.context, clock=self.clock, approve=lambda details: True)

    def refusal(self, **arguments):
        """The error message of a call that must fail, checking that it changed no file."""
        before = self.snapshot()
        with self.assertRaises(TaskStudioError) as caught:
            self.call(**arguments)
        self.assertEqual(self.snapshot(), before)
        return str(caught.exception)

    def snapshot(self):
        return {path.name: path.read_bytes() for path in self.studio.iterdir() if path.name != common.LOCK_FILE}

    def load(self, name):
        return Studio(self.studio, self.context, "")._read(name)

    def corrupt(self, name, value):
        state = json.loads((self.studio / common.STATE_FILE).read_text(encoding="utf-8"))
        state["documents"][name] = value
        (self.studio / common.STATE_FILE).write_text(json.dumps(state), encoding="utf-8")

    def task(self, identifier):
        return next(task for task in self.load("plan.json")["tasks"] if task["id"] == str(identifier))

    def states(self):
        return {task["id"]: task["state"] for task in self.load("plan.json")["tasks"]}

    def barbearia(self):
        return self.call(action="plan", title=make_fixtures.TITLE, request=make_fixtures.REQUEST,
                         tasks=make_fixtures.TASKS)

    def complete(self, *identifiers):
        for identifier in identifiers:
            self.call(action="start", id=identifier)
            self.call(action="finish", id=identifier)


class ManifestTests(unittest.TestCase):
    def test_manifest_declares_a_local_studio_tool_without_project_access(self):
        details = MANIFEST["details"]
        self.assertEqual({
            "head": {key: MANIFEST[key] for key in ("id", "name", "version", "icon")},
            "studio": {key: MANIFEST["studio"][key] for key in ("title", "description", "ui")},
            "access": details["access"], "meta": (details["execution"], details["author"], details["updatedAt"]),
            "counts": (len(details["features"]), len(details["limitations"]), len(details["examples"])),
            "actions": MANIFEST["inputSchema"]["properties"]["action"]["enum"],
            "closed": MANIFEST["inputSchema"]["additionalProperties"],
        }, {
            "head": {"id": "taskstudio", "name": "TaskStudio", "version": "1.0.1", "icon": "checklist"},
            "studio": {"title": "TaskStudio", "description": "Planeja e acompanha tarefas", "ui": True},
            "access": {"suppliedText": True, "projectFiles": False, "network": False},
            "meta": ("local", "JumpCode", "2026-11-13"), "counts": (6, 4, 4), "actions": list(ACTIONS),
            "closed": False,
        })
        self.assertIn("Crie um sistema de agendamento para a minha barbearia", details["examples"])
        self.assertLessEqual(len(MANIFEST["instructions"]), 1800)

    def test_manifest_passes_the_catalog_checks_of_the_host(self):
        # The same rules as jumpCodeAgentBridge.ts (catalog entry, details, studio) and CatalogTools (64 KB definition).
        details, studio = MANIFEST["details"], MANIFEST["studio"]
        lists = [details[key] for key in ("features", "limitations", "examples")]
        checks = {
            "id": bool(re.fullmatch(r"[a-z][a-z0-9-]{0,63}", MANIFEST["id"])),
            "icon": bool(re.fullmatch(r"[a-z][a-z0-9-]{0,63}", MANIFEST["icon"])),
            "name": 0 < len(MANIFEST["name"]) <= 120, "description": len(MANIFEST["description"]) <= 1000,
            "version": len(MANIFEST["version"]) <= 64, "about": 0 < len(details["about"].strip()) <= 2000,
            "author": 0 < len(details["author"]) <= 120, "date": bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}", details["updatedAt"])),
            "lists": all(len(items) <= 12 and all(isinstance(item, str) and 0 < len(item.strip()) <= 1000 for item in items)
                         for items in lists),
            "access": set(details["access"]) == {"suppliedText", "projectFiles", "network"},
            "studio": 0 < len(studio["title"]) <= 60 and len(studio["description"]) <= 120,
            "artwork": all(re.fullmatch(r"data:image/(?:png|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}", studio[key])
                           for key in ("mark", "cover") if key in studio),
            "definition": len(json.dumps({"description": MANIFEST["instructions"],
                                          "parameters": MANIFEST["inputSchema"]})) < 65536,
        }
        self.assertEqual(checks, dict.fromkeys(checks, True))

    def test_schema_lists_every_argument_with_types_and_the_contract_limits(self):
        properties = MANIFEST["inputSchema"]["properties"]
        task = properties["tasks"]["items"]["properties"]
        change = properties["changes"]["items"]["properties"]

        def untyped(schema, path="schema"):
            found = [] if "type" in schema else [path]
            for key, child in schema.get("properties", {}).items():
                found += untyped(child, f"{path}.{key}")
            if "items" in schema:
                found += untyped(schema["items"], f"{path}[]")
            return found

        self.assertEqual({
            "arguments": set(properties), "untyped": untyped(MANIFEST["inputSchema"]),
            "limits": (task["title"]["maxLength"], task["summary"]["maxLength"], task["detail"]["maxLength"],
                       properties["tasks"]["maxItems"], task["deps"]["maxItems"], task["gates"]["maxItems"],
                       task["criteria"]["maxItems"], properties["text"]["maxLength"],
                       change["note"]["maxLength"], change["why"]["maxLength"]),
            "closed": (properties["tasks"]["items"]["additionalProperties"],
                       properties["changes"]["items"]["additionalProperties"],
                       task["gates"]["items"]["additionalProperties"]),
        }, {
            "arguments": {"action"}.union(*FIELDS.values()), "untyped": [],
            "limits": (LIMITS["title"], LIMITS["summary"], LIMITS["detail"], 60, 12, 6, 20, LIMITS["text"],
                       LIMITS["changeNote"], LIMITS["why"]),
            "closed": (False, False, False),
        })
        try:
            from jsonschema import Draft202012Validator
        except ImportError:
            return
        Draft202012Validator.check_schema(MANIFEST["inputSchema"])
        Draft202012Validator(MANIFEST["inputSchema"]).validate({"action": "plan", "title": "X", "tasks": [{"title": "A"}]})

    def test_bundled_images_become_data_urls_within_limits(self):
        for key, name, prefix in (("mark", "mark.svg", "data:image/svg+xml;base64,"),
                                  ("cover", "cover.png", "data:image/png;base64,")):
            if (PACKAGE / "assets" / name).is_file():
                self.assertTrue(MANIFEST["studio"][key].startswith(prefix))
            else:
                self.assertNotIn(key, MANIFEST["studio"])
        self.assertIsNone(jumpcode_taskstudio._asset("missing.png", "image/png", 10))
        if (PACKAGE / "assets" / "mark.svg").is_file():
            with self.assertRaisesRegex(TaskStudioError, "larger than"):
                jumpcode_taskstudio._asset("mark.svg", "image/svg+xml", 10)

    def test_studio_ui_returns_the_interface_or_a_clear_error(self):
        if (PACKAGE / "ui" / "app.js").is_file() and (PACKAGE / "ui" / "app.css").is_file():
            self.assertEqual(sorted(studio_ui()), ["css", "js"])
        else:
            with self.assertRaisesRegex(TaskStudioError, "interface files are missing"):
                studio_ui()



class ValidationTests(unittest.TestCase):
    def test_arguments_are_normalized_without_touching_the_input(self):
        arguments = {"action": "progress", "id": " #6 ", "percent": "40%", "note": "  Calendario.tsx ", "log": "",
                     "files": ["src\\app\\page.tsx", "./src/lib/a.ts", {"path": "b.ts", "state": "done"}], "kind": None}
        self.assertEqual(validate(arguments), {"action": "progress", "id": "6", "note": "Calendario.tsx", "percent": 40,
                                               "files": [{"path": "src/app/page.tsx"}, {"path": "src/lib/a.ts"},
                                                         {"path": "b.ts", "state": "done"}]})
        self.assertEqual(arguments["id"], " #6 ")
        self.assertEqual([validate({"action": "read", "id": value})["id"] for value in (6, "6", "#6", "# 6", 6.0)],
                         ["6"] * 5)
        self.assertEqual(validate({"action": "apply", "id": "2", "note": "v2"}), {"action": "apply"})
        self.assertEqual(validate({"action": "plan", "draft": "true", "title": "T", "tasks": [{"title": "A", "deps": []}]}),
                         {"action": "plan", "title": "T", "tasks": [{"title": "A", "deps": []}], "draft": True})

    def test_texts_are_trimmed_and_cut_to_their_limits(self):
        result = validate({"action": "edit", "id": 3, "text": "a\x00b\r\nc", "title": "x" * 100, "summary": " s " * 60,
                           "detail": "linha 1\n\n\n\nlinha  2"})
        self.assertEqual({key: (len(value), value[-1]) for key, value in result.items() if key in ("title", "summary")},
                         {"title": (60, "…"), "summary": (90, "…")})
        self.assertEqual((result["text"], result["detail"]), ("ab\nc", "linha 1\n\nlinha 2"))
        self.assertEqual(len(validate({"action": "plan", "title": "y" * 500, "tasks": [{"title": "A"}]})["title"]), 80)

    def test_invalid_requests_are_refused(self):
        cases = [
            ("not an object", "Arguments must be an object"),
            ({"action": "explode"}, "action must be one of"),
            ({"action": "read", "path": "x"}, "Unknown arguments: path"),
            ({"action": "read", "note": "x"}, "note not used by read; it takes id"),
            ({"action": "start"}, "start needs id"),
            ({"action": "start", "id": "abc"}, "id must be a task number"),
            ({"action": "start", "id": 0}, "id must be a task number"),
            ({"action": "start", "id": True}, "id must be a task number"),
            ({"action": "fail", "id": 1}, "fail needs problem"),
            ({"action": "need", "id": 1, "label": "Chave", "env": "PIX_KEY=abc123"}, "env must be only a variable name"),
            ({"action": "progress", "id": 1, "files": ["/etc/passwd"]}, "relative to the project"),
            ({"action": "progress", "id": 1, "files": ["C:/x/y.ts"]}, "relative to the project"),
            ({"action": "progress", "id": 1, "files": ["src/../../x"]}, "relative to the project"),
            ({"action": "progress", "id": 1}, "progress needs note, percent, log or files"),
            ({"action": "progress", "id": 1, "note": "x", "kind": "secret"}, "kind must be one of: info, ok, error"),
            ({"action": "need", "id": 1, "label": "x", "kind": "info"}, "kind must be one of: secret"),
            ({"action": "progress", "id": 1, "percent": "muito"}, "percent must be a whole number"),
            ({"action": "focus"}, "focus needs id or mode"),
            ({"action": "focus", "mode": "galaxy"}, "mode must be one of"),
            ({"action": "plan", "tasks": [{"title": "A", "id": 1}]}, "Unknown fields in tasks: id"),
            ({"action": "plan", "tasks": [{"summary": "sem título"}]}, "Task 1 of tasks needs a title"),
            ({"action": "plan", "tasks": [{"title": "A", "gates": [{"kind": "secret"}]}]}, "Each gate needs a label"),
            ({"action": "propose", "changes": [{"task": 3, "kind": "nova"}]}, "Unknown fields in changes: kind"),
            ({"action": "plan", "tasks": "tudo"}, "Each item of tasks must be an object"),
        ]
        for arguments, message in cases:
            with self.subTest(arguments=arguments):
                with self.assertRaisesRegex(TaskStudioError, re.escape(message)):
                    validate(arguments)

    def test_list_limits_are_enforced(self):
        cases = [
            ({"action": "plan", "tasks": chain(61)}, "tasks has 61 items; at most 60"),
            ({"action": "plan", "tasks": [{"title": "A", "deps": list(range(1, 14))}]}, "at most 12"),
            ({"action": "plan", "tasks": [{"title": "A", "gates": [{"label": f"g{n}"} for n in range(7)]}]}, "at most 6"),
            ({"action": "plan", "tasks": [{"title": "A", "criteria": [f"c{n}" for n in range(21)]}]}, "at most 20"),
            ({"action": "progress", "id": 1, "files": [f"f{n}.ts" for n in range(41)]}, "at most 40"),
            ({"action": "fail", "id": 1, "problem": "x", "options": ["a", "b", "c", "d", "e"]}, "at most 4"),
            ({"action": "propose", "changes": [{"title": f"T{n}"} for n in range(61)]}, "at most 60"),
        ]
        for arguments, message in cases:
            with self.subTest(message=message):
                with self.assertRaisesRegex(TaskStudioError, message):
                    validate(arguments)

    def test_validation_is_idempotent(self):
        arguments = {"action": "plan", "title": "  Barbearia ", "request": make_fixtures.REQUEST,
                     "tasks": make_fixtures.TASKS, "draft": "false"}
        once = validate(arguments)
        self.assertEqual(validate(once), once)
        change = validate({"action": "propose", "changes": make_fixtures.PROPOSAL["changes"], "extra": "14"})
        self.assertEqual(validate(change), change)


class PlanTests(StudioTestCase):
    def test_plan_creates_version_one_with_numbered_tasks(self):
        result = self.call(action="plan", title="Barbearia", request="Agendamento",
                           tasks=[{"title": "Entender", "estimate": "10"}, {"title": "Banco", "deps": ["#1"]},
                                  {"title": "Tela", "deps": [1, 2], "gates": [{"label": "Chave", "env": "PIX_KEY"}]}])
        plan = self.load("plan.json")
        self.assertEqual({
            "result": result, "head": {key: value for key, value in plan.items() if key != "tasks"},
            "tasks": [(task["id"], task["deps"], task["state"]) for task in plan["tasks"]],
            "first": plan["tasks"][0], "gate": plan["tasks"][2]["gates"], "history": self.load("history.json"),
            "files": sorted(os.listdir(self.studio)),
        }, {
            "result": {"ok": True, "message": "Plan v1 saved with 3 tasks. Tell the user the plan in one or two sentences "
                                              "and wait until they say start.", "version": 1, "draft": False,
                       "project": True, "outline": "#1 Entender [ready]\n#2 Banco [waiting] deps #1\n"
                                                   "#3 Tela [waiting] deps #1, #2"},
            "head": {"schema": 1, "revision": 1, "plan": 1, "title": "Barbearia", "request": "Agendamento",
                     "draft": False, "started": False, "createdAt": "2026-11-13T14:20:00Z",
                     "updatedAt": "2026-11-13T14:20:00Z", "recalibrating": None, "nextId": 4},
            "tasks": [("1", [], "todo"), ("2", ["1"], "todo"), ("3", ["1", "2"], "todo")],
            "first": {"id": "1", "title": "Entender", "summary": "", "detail": "", "criteria": [], "deps": [],
                      "gates": [], "estimate": 10, "state": "todo", "problem": None, "log": [], "files": []},
            "gate": [{"id": "g1", "kind": "secret", "label": "Chave", "met": False, "env": "PIX_KEY"}],
            "history": {"schema": 1, "revision": 1, "versions": [
                {"plan": 1, "at": "2026-11-13T14:20:00Z", "reason": "Plano inicial", "cause": None, "changes": [],
                 "tasks": [{"id": "1", "title": "Entender", "summary": "", "state": "todo", "deps": []},
                           {"id": "2", "title": "Banco", "summary": "", "state": "todo", "deps": ["1"]},
                           {"id": "3", "title": "Tela", "summary": "", "state": "todo", "deps": ["1", "2"]}]}]},
            "files": [".taskstudio.lock", "state.json"],
        })

    def test_a_plan_without_dependencies_keeps_independent_tasks_and_cards_summarize_the_detail(self):
        # What a small local model sent in a real run: titles and details, no summary and no deps.
        result = self.call(action="plan", title="Lista de compras", tasks=[
            {"title": "Criar o HTML", "detail": "Criar index.html com o formulário. Depois a lista."},
            {"title": "Estilizar", "detail": "Criar style.css simples\ncom cores neutras"},
            {"title": "Testar", "summary": "Abrir no navegador", "detail": "Conferir tudo."}])
        summaries = [task["summary"] for task in self.load("plan.json")["tasks"]]
        draft = self.call(action="plan", title="Rascunho", draft=True, tasks=[{"title": "A"}, {"title": "B"}])
        self.assertEqual({
            "message": result["message"], "outline": result["outline"],
            "summaries": summaries,
            "draft": [task["deps"] for task in self.load("plan.json")["tasks"]], "draftOutline": draft["outline"],
        }, {
            "message": "Plan v1 saved with 3 tasks. "
                       "Tell the user the plan in one or two sentences and wait until they say start.",
            "outline": "#1 Criar o HTML [ready]\n#2 Estilizar [ready]\n#3 Testar [ready]",
            "summaries": ["Criar index.html com o formulário", "Criar style.css simples", "Abrir no navegador"],
            "draft": [[], []], "draftOutline": "#1 A [ready]\n#2 B [ready]",
        })

    def test_dependencies_are_checked_and_nothing_is_written_on_error(self):
        self.assertEqual([
            self.refusal(action="plan", title="T", tasks=[{"title": "A", "deps": [1]}]),
            self.refusal(action="plan", title="T", tasks=[{"title": "A"}, {"title": "B", "deps": [7]}]),
            self.refusal(action="plan", title="T", tasks=[{"title": "A", "deps": [3]}, {"title": "B", "deps": [1]},
                                                          {"title": "C", "deps": [2]}]),
        ], [
            "Task #1 'A' cannot depend on itself; remove #1 from its deps.",
            "Task #2 'B' depends on #7, which is not in the plan. Deps are task numbers: tasks are numbered 1, 2, "
            "3... in plan order.",
            "The deps make a cycle: #1, which waits for #3, which waits for #2, which waits for #1. Remove one of "
            "these deps.",
        ])
        self.assertEqual(os.listdir(self.studio), [common.LOCK_FILE])

    def test_an_unstarted_plan_is_replaced_and_a_started_one_is_kept(self):
        self.call(action="plan", title="Primeiro", tasks=chain(3))
        self.call(action="edit", id=2, text="mais simples")
        self.call(action="propose")
        self.call(action="plan", title="Segundo", tasks=chain(2))
        plan = self.load("plan.json")
        self.assertEqual((plan["title"], plan["revision"], plan["nextId"], [task["id"] for task in plan["tasks"]],
                          plan["recalibrating"], self.load("proposal.json"), len(self.load("history.json")["versions"])),
                         ("Segundo", 4, 3, ["1", "2"], None, None, 1))
        self.call(action="start", id=1)
        self.assertIn("The plan has already started, so plan cannot replace it. To change a task call edit, then "
                      "propose", self.refusal(action="plan", title="Terceiro", tasks=chain(2)))

    def test_a_draft_is_completed_by_later_calls(self):
        first = self.call(action="plan", title="Loja", draft=True, tasks=chain(3))
        self.call(action="plan", tasks=[{"title": "Tarefa 3", "summary": "atualizada", "deps": [2]},
                                        {"title": "Pagamento", "deps": [3]}, {"title": "Frete", "deps": ["#4", 1]}])
        plan = self.load("plan.json")
        self.assertEqual({"message": first["message"], "draft": plan["draft"], "nextId": plan["nextId"],
                          "tasks": [(task["id"], task["title"], task["summary"], task["deps"]) for task in plan["tasks"]]},
                         {"message": "Draft saved with 3 tasks. Call plan again with the next tasks (they will be #4 "
                                     "onward; deps use these numbers) and draft false on the last call.",
                          "draft": False, "nextId": 6,
                          "tasks": [("1", "Tarefa 1", "", []), ("2", "Tarefa 2", "", ["1"]),
                                    ("3", "Tarefa 3", "atualizada", ["2"]), ("4", "Pagamento", "", ["3"]),
                                    ("5", "Frete", "", ["4", "1"])]})
        self.call(action="plan", title="Loja", draft=True, tasks=[{"title": "Extra"}])
        self.call(action="plan", title="Outra coisa", tasks=chain(2))
        self.assertEqual([task["title"] for task in self.load("plan.json")["tasks"]], ["Tarefa 1", "Tarefa 2"])

    def test_sixty_tasks_is_the_limit(self):
        self.call(action="plan", title="Grande", draft=True, tasks=chain(40))
        self.assertEqual(self.refusal(action="plan", tasks=chain(60)[40:] + [{"title": "Uma a mais"}]),
                         "A plan can have at most 60 tasks; this one would have 61. Merge small tasks.")
        result = self.call(action="plan", tasks=[{"title": f"Tarefa {number}", "deps": [number - 1]}
                                                 for number in range(41, 61)])
        self.assertEqual((len(self.load("plan.json")["tasks"]), result["outline"].count("\n")), (60, 59))
        self.assertLess(len(json.dumps(self.call(action="read"))), 8000)

    def test_without_a_project_folder_the_model_can_only_plan(self):
        del self.context["source_root"]
        result = self.call(action="plan", title="Sem projeto", tasks=chain(2))
        read = self.call(action="read")
        self.assertEqual((result["project"], read["project"], result["message"].endswith(
            "Tell the user to open TaskStudio from a project to carry it out."), "open TaskStudio from a project" in read["message"]),
            (False, False, True, True))
        self.assertIn("There is no project folder", self.refusal(action="start", id=1))
        self.assertIn("There is no project folder", self.refusal(action="finish", id=1))


class ReadTests(StudioTestCase):
    def test_read_without_a_plan_says_what_to_do_and_whether_a_project_is_bound(self):
        self.assertEqual(self.call(action="read"), {
            "ok": True, "message": "There is no plan yet. When the user asks to build or change something sizeable, "
                                   "call plan.", "project": True})
        self.assertEqual(os.listdir(self.studio), [common.LOCK_FILE])

    def test_read_gives_one_line_per_task_and_the_pending_items(self):
        self.barbearia()
        self.complete(1, 2, 3)
        self.call(action="start", id=5)
        self.call(action="progress", id=5, percent=40, note="horarios.ts")
        self.call(action="start", id=4)
        self.call(action="fail", id=4, problem="Erro 500 no cadastro", options=["Tentar de novo"])
        self.call(action="need", id=7, label="Chave Pix de teste", env="PIX_KEY")
        result = self.call(action="read")
        self.assertEqual(result, {
            "ok": True,
            "message": "Plan v1 \"Barbearia do Zé\" (started): 11 tasks, 3 done, 1 running, 1 failed, 6 waiting. "
                       "Continue #5 (running).",
            "version": 1, "project": True,
            "counts": {"total": 11, "done": 3, "running": 1, "paused": 0, "failed": 1, "skipped": 0, "ready": 0,
                       "waiting": 6, "needsUser": 0},
            "outline": "\n".join([
                "#1 Entender o pedido [done]", "#2 Estrutura do projeto [done] deps #1",
                "#3 Modelar o banco [done] deps #2", "#4 Cadastro de serviços e barbeiros [failed: Erro 500 no cadastro] deps #3",
                "#5 Horários disponíveis [running 40%] deps #3", "#6 Tela de agendamento [waiting] deps #4, #5",
                "#7 Pagamento por Pix [waiting] deps #6", "#8 Lembrete por WhatsApp [waiting] deps #6",
                "#9 Painel do barbeiro [waiting] deps #5", "#10 Testes do fluxo completo [waiting] deps #6, #7, #8, #9",
                "#11 Publicar o site [waiting] deps #10"]),
            "nextId": 12,
            "notes": ["Problem #4: Erro 500 no cadastro (options: Tentar de novo)",
                      "Needs user #7: secret 'Chave Pix de teste' (env PIX_KEY)",
                      "Needs user #11: approval 'Publicar o site'"],
        })

    def test_read_before_the_first_start_says_which_task_to_start_when_the_user_says_start(self):
        self.barbearia()
        self.assertEqual(self.call(action="read")["message"],
                         "Plan v1 \"Barbearia do Zé\" (not started): 11 tasks, 1 ready, 10 waiting. "
                         "Not started yet. When the user says start, call start on #1.")

    def test_read_one_task_returns_the_whole_task(self):
        self.barbearia()
        result = self.call(action="read", id="#6")
        self.assertEqual((result["message"], result["task"]["detail"], result["waitsFor"], result["unlocks"]),
                         ("#6 Tela de agendamento [waiting].", make_fixtures.TASKS[5]["detail"], ["4", "5"],
                          ["7", "8", "10"]))
        self.assertEqual(self.refusal(action="read", id=99), "There is no task #99. Call read to see the task numbers.")


class ExecutionTests(StudioTestCase):
    def test_start_refuses_until_dependencies_and_conditions_are_met(self):
        self.barbearia()
        self.complete(1, 2, 3, 4)
        self.call(action="start", id=5)
        self.call(action="need", id=7, label="Chave Pix de teste", env="PIX_KEY")
        self.call(action="finish", id=5)
        self.call(action="start", id=6)
        self.assertEqual([self.refusal(action="start", id=7), self.refusal(action="start", id=8),
                          self.refusal(action="start", id=1)], [
            "#7 cannot start: it waits for #6 (running) and the condition 'Chave Pix de teste'. Work on #9 or ask the user.",
            "#8 cannot start: it waits for #6 (running). Work on #9.",
            "#1 Entender o pedido is already done. If the user wants it changed, call edit.",
        ])

    def test_start_progress_and_finish_track_a_task(self):
        self.barbearia()
        started = self.call(action="start", id=1, note="Lendo o pedido")
        again = self.call(action="start", id=1)
        self.call(action="progress", id=1, percent=60, note="serviços", files=["docs\\servicos.md"])
        self.call(action="progress", id=1, log="erro de digitação", kind="error", files=["docs/servicos.md", "b.md"])
        finished = self.call(action="finish", id=1, result="Lista pronta", files=["c.md"])
        task = self.task(1)
        self.assertEqual({
            "started": started["message"], "again": again["message"], "task": started["task"],
            "finished": finished, "times": (task["startedAt"], task["finishedAt"]),
            "state": (task["state"], task["progress"], task["result"], "now" in task, task["problem"]),
            "criteria": task["criteria"], "files": task["files"],
            "log": [(entry["text"], entry["kind"], entry["execution"]) for entry in task["log"]],
            "plan": (self.load("plan.json")["started"], self.states()["2"]),
        }, {
            "started": "#1 Entender o pedido is running. Do the work with your other tools, call progress with short "
                       "notes, then finish with the result.",
            "again": "#1 Entender o pedido is already running. Continue the work, then call progress or finish.",
            "task": {"id": "1", "title": "Entender o pedido", "summary": make_fixtures.TASKS[0]["summary"],
                     "detail": make_fixtures.TASKS[0]["detail"], "criteria": make_fixtures.TASKS[0]["criteria"]},
            "finished": {"ok": True, "message": "#1 Entender o pedido done. Ready now: #2 Estrutura do projeto. Start "
                                                "the next one.", "id": "1",
                         "ready": [{"id": "2", "title": "Estrutura do projeto"}], "needsUser": []},
            "times": ("2026-11-13T14:20:10Z", "2026-11-13T14:20:50Z"),
            "state": ("done", 100, "Lista pronta", False, None),
            "criteria": [{"text": text, "done": True} for text in make_fixtures.TASKS[0]["criteria"]],
            "files": [{"path": "docs/servicos.md", "state": "done"}, {"path": "b.md", "state": "done"},
                      {"path": "c.md", "state": "done"}],
            "log": [("Começou: Lendo o pedido", "info", "exec-1"), ("serviços", "info", "exec-1"),
                    ("erro de digitação", "error", "exec-1"), ("Concluída: Lista pronta", "ok", "exec-1")],
            "plan": (True, "todo"),
        })
        self.assertEqual(self.refusal(action="progress", id=2, note="x"),
                         "#2 Estrutura do projeto is not running (todo). Call start first.")

    def test_finish_marks_criteria_and_reports_what_became_ready(self):
        self.barbearia()
        self.complete(1, 2)
        self.call(action="start", id=3)
        self.assertIn("unmet or unknown", self.refusal(action="finish", id=3, criteria=["migração inicial aplicada", "não existe"]))
        first = self.call(action="finish", id=3, criteria=["migração inicial aplicada", "2"])
        self.complete(4)
        self.call(action="need", id=6, kind="approval", label="Aprovar o layout")
        self.call(action="start", id=5)
        self.assertIn("unmet or unknown", self.refusal(action="finish", id=5, criteria=["2"]))
        second = self.call(action="finish", id=5, criteria=["1", "2"])
        self.assertEqual({
            "first": first["message"], "criteria3": [item["done"] for item in self.task(3)["criteria"]],
            "second": (second["message"], second["ready"], second["needsUser"]),
            "criteria5": [item["done"] for item in self.task(5)["criteria"]],
            "done": self.refusal(action="finish", id=5),
        }, {
            "first": "#3 Modelar o banco done. Ready now: #4 Cadastro de serviços e barbeiros, #5 Horários disponíveis. "
                     "Start the next one.",
            "criteria3": [True, True],
            "second": ("#5 Horários disponíveis done. Ready now: #9 Painel do barbeiro. Start the next one. Now waiting "
                       "for the user: #6 'Aprovar o layout'; ask them.", [{"id": "9", "title": "Painel do barbeiro"}],
                       [{"id": "6", "title": "Tela de agendamento"}]),
            "criteria5": [True, True],
            "done": "#5 Horários disponíveis is already done. Start the next ready task: #9.",
        })

    def test_finish_without_start_works_only_on_a_ready_task(self):
        self.barbearia()
        self.assertEqual(self.refusal(action="finish", id=2),
                         "#2 cannot finish: it waits for #1 (todo). Work on #1.")
        self.call(action="finish", id=1, result="ok")
        task = self.task(1)
        self.assertEqual((task["state"], task["startedAt"], self.load("plan.json")["started"]),
                         ("done", "2026-11-13T14:20:20Z", True))

    def test_fail_need_resolve_and_try_again(self):
        self.barbearia()
        self.complete(1, 2, 3, 4, 5)
        self.call(action="start", id=6)
        failed = self.call(action="fail", id=6, problem="O calendário não abre", detail="Erro no build",
                           options=["Trocar a biblioteca", "Tentar de novo"])
        problem = self.task(6)["problem"]
        retried = self.call(action="start", id=6)
        needed = self.call(action="need", id=6, label="Chave Pix de teste", env="PIX_KEY", where="No painel",
                           alternatives=["Pagamento simulado"])
        same = self.call(action="need", id=6, label="chave pix de teste", kind="secret", env="PIX_KEY")
        other = self.call(action="need", id=6, kind="choice", label="Cor do site", alternatives=["Azul", "Preto"])
        gates = self.task(6)["gates"]
        partial = self.call(action="resolve", id=6, gate="pix")
        unknown = self.refusal(action="resolve", id=6, gate="g9")
        everything = self.call(action="resolve", id=6, note="Azul")
        self.call(action="start", id=6)
        self.call(action="fail", id=6, problem="Timeout")
        cleared = self.call(action="resolve", id=6, note="Tentar de novo")
        self.assertEqual({
            "failed": failed["message"], "problem": problem, "retried": (retried["message"], self.task(6)["problem"]),
            "needed": needed["message"], "same": same["gate"], "other": other["message"], "gates": gates,
            "partial": partial["message"], "unknown": unknown, "everything": everything["message"],
            "cleared": (cleared["message"], self.task(6)["state"], self.task(6)["problem"]),
        }, {
            "failed": "#6 Tela de agendamento is marked with a problem. Tell the user what blocks it and the options, "
                      "then wait for their answer.",
            "problem": {"title": "O calendário não abre", "detail": "Erro no build",
                        "options": ["Trocar a biblioteca", "Tentar de novo"], "at": "2026-11-13T14:22:00Z"},
            "retried": ("#6 Tela de agendamento is running. Do the work with your other tools, call progress with "
                        "short notes, then finish with the result.", None),
            "needed": "#6 now needs the user: Chave Pix de teste. Tell the user to put PIX_KEY in the project's .env "
                      "file (never in the chat) and to tell you when it is there; then call resolve. Meanwhile you "
                      "may start #9.",
            "same": "g1",
            "other": "#6 now needs the user: Cor do site. Ask the user to choose 'Cor do site' (Azul, Preto); then "
                     "call resolve with their choice as note. Meanwhile you may start #9.",
            "gates": [{"id": "g1", "kind": "secret", "label": "chave pix de teste", "met": False, "env": "PIX_KEY"},
                      {"id": "g2", "kind": "choice", "label": "Cor do site", "met": False,
                       "alternatives": ["Azul", "Preto"]}],
            "partial": "Resolved. #6 Tela de agendamento is now [needs user: Cor do site].",
            "unknown": "#6 has no condition 'g9'. Its conditions: g1 'chave pix de teste'; g2 'Cor do site'.",
            "everything": "Resolved. #6 Tela de agendamento is ready: call start.",
            "cleared": ("Resolved. #6 Tela de agendamento is ready: call start.", "todo", None),
        })

    def test_skip_counts_as_done_for_dependents(self):
        self.barbearia()
        self.complete(1, 2, 3)
        result = self.call(action="skip", id=4, note="O dono cadastra depois")
        self.complete(5)
        self.assertEqual((result["message"], self.call(action="read", id=6)["message"], self.refusal(action="skip", id=1)),
                         ("#4 Cadastro de serviços e barbeiros is left for later.", "#6 Tela de agendamento [ready].",
                          "#1 Entender o pedido is already done."))
        restarted = self.call(action="start", id=4)
        self.assertEqual((restarted["task"]["id"], self.task(4)["state"]), ("4", "running"))

    def test_pause_one_or_every_running_task(self):
        self.barbearia()
        self.complete(1, 2, 3)
        for identifier in (4, 5):
            self.call(action="start", id=identifier)
        one = self.call(action="pause", id=4)
        rest = self.call(action="pause")
        none = self.call(action="pause")
        self.assertEqual({"one": one["paused"], "rest": rest["message"], "none": none["message"],
                          "states": [self.states()[key] for key in ("4", "5")], "at": self.task(5)["pausedAt"],
                          "todo": self.refusal(action="pause", id=6)},
                         {"one": ["4"], "rest": "Paused #5 Horários disponíveis. Call start to resume when the user asks.",
                          "none": "Nothing is running.", "states": ["paused", "paused"], "at": "2026-11-13T14:21:40Z",
                          "todo": "#6 Tela de agendamento is not running (todo)."})
        self.call(action="start", id=5)
        self.assertEqual(("pausedAt" in self.task(5), self.task(5)["log"][-1]["text"]), (False, "Retomada"))

    def test_logs_and_files_keep_their_limits(self):
        self.call(action="plan", title="Longa", tasks=chain(1))
        self.call(action="start", id=1)
        for number in range(45):
            self.call(action="progress", id=1, log=f"linha {number}", files=[f"src/f{number}.ts"])
        task = self.task(1)
        self.assertEqual((len(task["log"]), task["log"][0]["text"], task["log"][-1]["text"], len(task["files"]),
                          task["files"][0]["path"]), (40, "linha 5", "linha 44", 40, "src/f5.ts"))


class RecalibrationTests(StudioTestCase):
    def setUp(self):
        super().setUp()
        self.barbearia()
        self.complete(1, 2, 3, 4, 5)
        self.call(action="start", id=6)
        self.call(action="progress", id=6, percent=40, note="Calendario.tsx", files=["src/components/Calendario.tsx"])
        self.call(action="start", id=9)

    def edit_three(self, **extra):
        return self.call(action="edit", id="#3", text="Na verdade, cada agendamento pode ter mais de um serviço",
                         detail="Tabelas com agendamento_servicos", **extra)

    def test_edit_records_the_change_pauses_running_tasks_and_lists_the_impact(self):
        result = self.edit_three(criteria=["Agendamento com vários serviços"])
        plan = self.load("plan.json")
        self.assertEqual({"result": result, "recalibrating": plan["recalibrating"],
                          "states": [self.states()[key] for key in ("3", "6", "9")],
                          "detail": self.task(3)["detail"] == make_fixtures.TASKS[2]["detail"]}, {
            "result": {"ok": True, "message": "Your next call must be propose. Do not change files or run commands "
                                              "now: nothing is redone until the user applies the proposal. "
                                              "Recalibrating #3 Modelar o banco. Check the tasks in candidates and give "
                                              "one change per task that must change, always #3; new tasks will be #12 "
                                              "onward. Example: {\"action\": \"propose\", \"changes\": [{\"task\": "
                                              "\"3\", \"note\": \"what changes in it\"}]} Until then the user sees a list that "
                                              "redoes only #3. Paused: #6, #9.",
                       "task": "3", "kind": "done", "paused": ["6", "9"],
                       "impact": {"done": ["4", "5"], "running": ["6", "9"], "todo": ["7", "8", "10", "11"]},
                       "candidates": [
                           "#4 Cadastro de serviços e barbeiros [done] - Telas simples para o dono cadastrar",
                           "#5 Horários disponíveis [done] - Calcula os horários livres de cada barbeiro",
                           "#6 Tela de agendamento [paused] - Cliente escolhe serviço, barbeiro e horário",
                           "#7 Pagamento por Pix [waiting] - QR Code Pix na confirmação do agendamento",
                           "#8 Lembrete por WhatsApp [waiting] - Mensagem no dia anterior ao horário",
                           "#9 Painel do barbeiro [paused] - Agenda do dia de cada barbeiro",
                           "#10 Testes do fluxo completo [waiting] - Do agendamento ao pagamento e ao lembrete",
                           "#11 Publicar o site [waiting] - Colocar no ar com o domínio da barbearia"]},
            "recalibrating": {
                "task": "3", "kind": "done", "text": "Na verdade, cada agendamento pode ter mais de um serviço",
                "before": {"title": "Modelar o banco", "summary": make_fixtures.TASKS[2]["summary"],
                           "detail": make_fixtures.TASKS[2]["detail"],
                           "criteria": [{"text": text, "done": True} for text in make_fixtures.TASKS[2]["criteria"]]},
                "after": {"detail": "Tabelas com agendamento_servicos",
                          "criteria": [{"text": "Agendamento com vários serviços", "done": False}]},
                "at": "2026-11-13T14:22:20Z", "paused": ["6", "9"], "requestId": "request-1",
                "impact": {"done": ["4", "5"], "running": ["6", "9"], "todo": ["7", "8", "10", "11"]}},
            "states": ["done", "paused", "paused"], "detail": True,
        })
        self.assertEqual(self.refusal(action="edit", id=5, text="outra"),
                         "A change to #3 is still being recalibrated. Call propose for it first; then edit this task.")

    def test_nothing_moves_on_while_a_change_waits_for_the_user(self):
        self.edit_three()
        pending = [self.refusal(action="start", id=6), self.refusal(action="finish", id=9)]
        self.call(action="propose")
        pending += [self.refusal(action="start", id=6), self.refusal(action="edit", id=5, text="x")]
        self.assertEqual(pending, [
            "#6 cannot start now: a change to #3 is being recalibrated; call propose first, then wait for the user to "
            "apply or discard it.",
            "#9 cannot finish now: a change to #3 is being recalibrated; call propose first, then wait for the user to "
            "apply or discard it.",
            "#6 cannot start now: the proposal for plan v2 waits for the user to apply or discard it.",
            "The proposal for plan v2 waits for the user. Ask them to apply or discard it before another change.",
        ])

    def test_edit_without_a_detail_takes_the_users_words_as_the_new_text_or_adds_a_short_remark_to_it(self):
        old = self.task(3)["detail"]
        remark = "Cada agendamento pode ter mais de um serviço"
        self.call(action="edit", id=3, text=remark)
        added = self.load("plan.json")["recalibrating"]["after"]["detail"]
        self.call(action="discard")
        rewritten = "Tabelas de clientes, barbeiros, serviços e agendamentos, com vários serviços em cada " \
                    "agendamento numa tabela agendamento_servicos e a duração somada"
        self.call(action="edit", id=3, text=rewritten)
        self.assertEqual((added, self.load("proposal.json")["changes"][0]["detail"]),
                         (f"{old}\nMudança: {remark}", rewritten))

    def test_edit_alone_leaves_a_list_that_redoes_the_edited_task_which_propose_replaces_and_apply_takes(self):
        # A small local model often stops after edit: the user still gets a list to apply or discard.
        self.edit_three()
        baseline = self.load("proposal.json")
        self.call(action="edit", id=3, text="Uma tabela só", detail="Tabela agendamento_servicos")
        again = self.load("proposal.json")
        other = self.refusal(action="edit", id=7, text="Pix por QR code")
        self.call(action="propose", changes=[{"task": "5", "note": "Soma a duração dos serviços"}])
        proposed = self.load("proposal.json")
        self.call(action="discard")
        self.edit_three()
        self.call(action="apply")
        plan = self.load("plan.json")
        self.assertEqual({
            "baseline": (baseline["baseline"], baseline["changes"], baseline["summary"]),
            "again": again["changes"][0]["detail"], "other": other,
            "proposed": ("baseline" in proposed, [change["task"] for change in proposed["changes"]]),
            "applied": (plan["plan"], plan["recalibrating"], self.task(3)["state"], self.task(3)["detail"]),
        }, {
            "baseline": (True, [{"task": "3", "kind": "refazer", "note": "Na verdade, cada agendamento pode ter mais de "
                                                                         "um serviço", "why": "sua mudança",
                                 "detail": "Tabelas com agendamento_servicos"}], "A mudança atinge 1 tarefa: 1 concluída será refeita."),
            "again": "Tabela agendamento_servicos",
            "other": "A change to #3 is still being recalibrated. Call propose for it first; then edit this task.",
            "proposed": (False, ["3", "5"]),
            "applied": (2, None, "todo", "Tabelas com agendamento_servicos"),
        })

    def test_propose_derives_each_kind_from_the_task_state_and_includes_the_edited_task(self):
        self.call(action="fail", id=9, problem="Erro 500")
        self.edit_three()
        result = self.call(action="propose", changes=[
            {"task": 5, "note": "Duração somada"}, {"task": "#6", "note": "Vários serviços", "why": "precisa"},
            {"task": 9, "note": "Painel"}, {"task": 7, "summary": "Pix por agendamento"},
            {"title": "Combos de serviços", "deps": [3], "estimate": 20, "area": "Banco"},
            {"title": "Combos no site", "deps": [12, 6]}, {"task": 8, "remove": True, "note": "Sai"}])
        proposal = self.load("proposal.json")
        plan = self.load("plan.json")
        self.assertEqual({"message": result["message"], "plan": (plan["recalibrating"], plan["revision"]),
                          "proposal": {key: value for key, value in proposal.items() if key != "changes"},
                          "changes": proposal["changes"]}, {
            "message": "Proposal for plan v2 saved (2 to redo, 1 to adjust, 2 to change, 2 new, 1 to remove). Tell "
                       "the user in one or two sentences what changes and wait for 'Aplique' (call apply) or "
                       "'Descarte' (call discard). Do not redo any work before that.",
            "plan": (None, proposal["baseRevision"]),
            "proposal": {"schema": 1, "revision": 2, "plan": 2, "base": 1, "baseRevision": plan["revision"],
                         "states": {"3": "done", "5": "done", "6": "paused", "7": "todo", "9": "failed", "8": "todo"},
                         "cause": {"task": "3", "text": "Na verdade, cada agendamento pode ter mais de um serviço"},
                         "summary": "A mudança atinge 8 tarefas: 2 concluídas serão refeitas, 1 em execução ajustada, "
                                    "2 mudam antes de começar, 2 tarefas novas e 1 sai do plano.",
                         "extra": 60, "createdAt": "2026-11-13T14:22:40Z"},
            "changes": [
                {"task": "3", "kind": "refazer", "note": "Na verdade, cada agendamento pode ter mais de um serviço",
                 "why": "sua mudança", "detail": "Tabelas com agendamento_servicos"},
                {"task": "5", "kind": "refazer", "note": "Duração somada", "why": "usa #3"},
                {"task": "6", "kind": "ajustar", "note": "Vários serviços", "why": "precisa"},
                {"task": "7", "kind": "alterar", "why": "usa #6", "summary": "Pix por agendamento"},
                {"task": "9", "kind": "alterar", "note": "Painel", "why": "usa #5"},
                {"task": "12", "kind": "nova", "why": "usa #3", "title": "Combos de serviços", "area": "Banco",
                 "estimate": 20, "deps": ["3"]},
                {"task": "13", "kind": "nova", "why": "usa #12", "title": "Combos no site", "deps": ["12", "6"]},
                {"task": "8", "kind": "remover", "note": "Sai", "why": "usa #6"},
            ],
        })

    def test_propose_refuses_what_cannot_be_applied(self):
        self.edit_three()
        cases = [
            ([{"task": 5, "remove": True}], "#5 Horários disponíveis cannot be removed: it already has work (done). "
                                            "Propose a change to it, or skip it."),
            ([{"task": 6, "remove": True}], "#6 Tela de agendamento cannot be removed: it already has work (paused)."),
            ([{"task": 7, "deps": [12]}], "#7 'Pagamento por Pix' depends on #12, which is not in the plan."),
            ([{"task": 5, "deps": [7]}], "The deps make a cycle: #5, which waits for #7, which waits for #6, which "
                                         "waits for #5. Remove one of these deps."),
            ([{"task": 8, "remove": True}, {"task": 10, "deps": [8, 9]}],
             "#10 would depend on #8, which this proposal removes."),
            ([{"task": 5, "note": "a"}, {"task": "#5", "note": "b"}], "#5 appears twice in changes"),
            ([{"task": 40}], "#40 is not in the plan. Use the number of an existing task (call read), or give a title"),
            ([{"task": 6, "deps": [6]}], "#6 'Tela de agendamento' cannot depend on itself"),
        ]
        for changes, message in cases:
            with self.subTest(message=message):
                self.assertIn(message, self.refusal(action="propose", changes=changes))

    def test_apply_makes_the_next_version_and_keeps_the_work_done(self):
        self.edit_three()
        self.call(action="propose", changes=[
            {"task": 3, "summary": "Vários serviços por agendamento", "note": "Nova tabela",
             "criteria": ["Tabela agendamento_servicos"]},
            {"task": 6, "note": "Escolher vários serviços", "gates": [{"label": "Aprovar o layout", "kind": "approval"}]},
            {"task": 7, "detail": "Pix com o total dos serviços", "deps": [6, 12]},
            {"title": "Combos", "deps": [3], "summary": "Pacotes"}, {"task": 8, "remove": True, "note": "Sai"}])
        before = self.task(6)
        result = self.call(action="apply")
        plan = self.load("plan.json")
        history = self.load("history.json")
        tasks = {task["id"]: task for task in plan["tasks"]}
        self.assertEqual({
            "message": result["message"], "files": sorted(os.listdir(self.studio)),
            "plan": (plan["plan"], plan["nextId"], plan["recalibrating"], [task["id"] for task in plan["tasks"]]),
            "three": {key: tasks["3"].get(key) for key in ("state", "summary", "detail", "criteria", "progress",
                                                            "result", "finishedAt", "startedAt", "mark")},
            "six": (tasks["6"]["state"], "progress" in tasks["6"], "now" in tasks["6"], tasks["6"]["files"] == before["files"],
                    tasks["6"]["log"][:-1] == before["log"], tasks["6"]["log"][-1]["text"], tasks["6"]["gates"]),
            "seven": (tasks["7"]["state"], tasks["7"]["deps"], tasks["7"]["detail"], tasks["7"]["mark"]["kind"]),
            "nine": (tasks["9"]["state"], "mark" in tasks["9"]),
            "ten": tasks["10"]["deps"], "twelve": (tasks["12"]["state"], tasks["12"]["deps"], tasks["12"]["mark"]),
            "history": [{key: value for key, value in version.items() if key not in ("tasks", "at")}
                        for version in history["versions"]],
            "snapshot": history["versions"][-1]["tasks"][-1],
        }, {
            "message": "Plan v2 applied (1 to redo, 1 to adjust, 1 to change, 1 new, 1 to remove). Start a ready "
                       "task: #3 Modelar o banco.",
            "files": [".taskstudio.lock", "state.json"],
            "plan": (2, 13, None, ["1", "2", "3", "4", "5", "6", "7", "9", "10", "11", "12"]),
            "three": {"state": "todo", "summary": "Vários serviços por agendamento",
                      "detail": "Tabelas com agendamento_servicos",
                      "criteria": [{"text": "Tabela agendamento_servicos", "done": False}], "progress": None,
                      "result": None, "finishedAt": None, "startedAt": None,
                      "mark": {"plan": 2, "kind": "refazer", "note": "Nova tabela"}},
            "six": ("todo", False, False, True, True, "Plano v2: ajustar - Escolher vários serviços",
                    [{"id": "g1", "kind": "approval", "label": "Aprovar o layout", "met": False}]),
            "seven": ("todo", ["6", "12"], "Pix com o total dos serviços", "alterar"),
            "nine": ("paused", False),
            "ten": ["6", "7", "9"], "twelve": ("todo", ["3"], {"plan": 2, "kind": "nova", "note": ""}),
            "history": [
                {"plan": 1, "reason": "Plano inicial", "cause": None, "changes": []},
                {"plan": 2, "reason": "Vários serviços por agendamento",
                 "cause": {"task": "3", "text": "Na verdade, cada agendamento pode ter mais de um serviço"},
                 "changes": [{"task": "3", "kind": "refazer", "note": "Nova tabela"},
                             {"task": "6", "kind": "ajustar", "note": "Escolher vários serviços"},
                             {"task": "7", "kind": "alterar", "note": ""}, {"task": "12", "kind": "nova", "note": ""},
                             {"task": "8", "kind": "remover", "note": "Sai"}], "extra": 10}],
            "snapshot": {"id": "12", "title": "Combos", "summary": "Pacotes", "state": "todo", "deps": ["3"]},
        })

    def test_apply_refuses_when_a_task_changed_state_since_the_proposal(self):
        self.edit_three()
        self.call(action="propose", changes=[{"task": 10, "note": "Testar vários serviços"}])
        self.call(action="skip", id=10)
        self.assertEqual(self.refusal(action="apply"), "#10 changed since the proposal (todo -> skipped). Call propose "
                                                       "again so the user sees the current plan.")
        replaced = self.call(action="propose", changes=[{"task": 10, "note": "Testar vários serviços"}])
        self.assertEqual(replaced["changes"], [{"task": "3", "kind": "refazer"}, {"task": "10", "kind": "alterar"}])
        self.assertEqual(self.call(action="apply")["version"], 2)

    def test_discard_leaves_the_plan_as_it_was(self):
        before = self.load("plan.json")["tasks"]
        self.edit_three()
        self.call(action="propose")
        result = self.call(action="discard")
        plan = self.load("plan.json")
        self.assertEqual({"message": result["message"], "proposal": self.load("proposal.json"),
                          "plan": (plan["plan"], plan["recalibrating"]),
                          "details": [task["detail"] for task in plan["tasks"]] == [task["detail"] for task in before],
                          "paused": [self.states()[key] for key in ("6", "9")],
                          "again": self.call(action="discard")["message"]},
                         {"message": "Discarded; plan v1 stays as it was. #6 Tela de agendamento, #9 Painel do barbeiro "
                                     "stay paused; call start to resume when the user asks.",
                          "proposal": None, "plan": (1, None), "details": True, "paused": ["paused", "paused"],
                          "again": "There is no proposal or recalibration to discard; plan v1 is unchanged."})
        self.assertEqual(self.refusal(action="apply"), "There is no proposal to apply. When the user changes a task, "
                                                       "call edit and then propose.")

    def test_task_numbers_are_never_reused(self):
        self.edit_three()
        self.call(action="propose", changes=[{"task": 8, "remove": True}, {"title": "Combos", "deps": [3]}])
        self.call(action="apply")
        refused = self.refusal(action="propose", changes=[{"task": 8, "title": "Lembrete de volta"}])
        self.call(action="propose", changes=[{"title": "Lembrete por SMS", "deps": [6]}, {"task": 14, "title": "Avaliações"}])
        changes = self.load("proposal.json")["changes"]
        self.assertEqual((refused, [(change["task"], change["title"]) for change in changes]),
                         ("#8 is not in the plan any more and its number is not reused. To add a task, leave task out "
                          "(new tasks get #13 onward).", [("13", "Lembrete por SMS"), ("14", "Avaliações")]))
        self.call(action="apply")
        self.assertEqual(self.load("plan.json")["nextId"], 15)

    def test_propose_without_edit_adds_tasks_to_a_started_plan(self):
        result = self.call(action="propose", summary="Adicionar avaliações", changes=[{"title": "Avaliações", "deps": [6]}])
        proposal = self.load("proposal.json")
        self.assertEqual((result["changes"], proposal["cause"], proposal["summary"], proposal["states"]),
                         ([{"task": "12", "kind": "nova"}], {"task": None, "text": "Adicionar avaliações"},
                          "Adicionar avaliações", {}))
        self.call(action="apply")
        self.assertEqual(self.load("history.json")["versions"][-1]["reason"], "Adicionar avaliações")
        self.assertIn("propose needs changes", self.refusal(action="propose"))

    def test_history_keeps_the_last_thirty_versions(self):
        for number in range(31):
            self.call(action="propose", changes=[{"task": 11, "note": f"versão {number}"}])
            self.call(action="apply")
        history = self.load("history.json")
        self.assertEqual((len(history["versions"]), history["versions"][0]["plan"], history["versions"][-1]["plan"],
                          self.load("plan.json")["plan"], history["revision"]), (30, 3, 32, 32, 32))


class FocusTests(StudioTestCase):
    def test_focus_writes_the_view_with_a_growing_revision(self):
        self.barbearia()
        first = self.call(action="focus", id="#6", note="Abri os detalhes à direita")
        self.call(action="focus", mode="timeline")
        self.assertEqual((first["message"], self.load("view.json")),
                         ("The Studio now shows #6 Tela de agendamento in map mode.",
                          {"schema": 1, "revision": 2, "select": None, "mode": "timeline", "note": ""}))
        self.assertEqual(self.refusal(action="focus", id=40), "There is no task #40. Call read to see the task numbers.")
        self.assertEqual(self.load("plan.json")["revision"], 1)


class FileSafetyTests(StudioTestCase):
    def test_the_studio_folder_must_be_given_by_the_host(self):
        file = self.folder / "file.txt"
        file.write_text("x", encoding="utf-8")
        cases = [None, {}, {"studio_root": ""}, {"studio_root": "relative/folder"},
                 {"studio_root": str(self.folder / "missing")}, {"studio_root": str(file)}]
        for context in cases:
            with self.subTest(context=context):
                with self.assertRaisesRegex(TaskStudioError, "Studio"):
                    run({"action": "read"}, context)

    def test_writes_stay_in_the_studio_folder_and_leave_no_temporary_files(self):
        self.barbearia()
        self.complete(1, 2, 3)
        self.call(action="edit", id=2, text="Usar PostgreSQL")
        self.call(action="propose")
        self.call(action="apply")
        self.call(action="focus", id=2)
        self.assertEqual((sorted(os.listdir(self.studio)), os.listdir(self.source), os.listdir(self.folder)),
                         ([".taskstudio.lock", "state.json"], [], ["source", "studio"]))

    def test_a_failed_write_leaves_no_temporary_file_and_the_old_plan(self):
        self.barbearia()
        before = self.snapshot()
        with patch("jumpcode_taskstudio.common.os.replace", side_effect=OSError("disk")):
            with self.assertRaisesRegex(TaskStudioError, "state.json could not be saved"):
                self.call(action="start", id=1)
        self.assertEqual((self.snapshot(), sorted(os.listdir(self.studio))),
                         (before, [".taskstudio.lock", "state.json"]))

    def test_files_over_the_size_limit_are_refused_before_writing(self):
        self.call(action="plan", title="Pequeno", tasks=chain(1))
        with patch("jumpcode_taskstudio.common.MAX_STUDIO_FILE", 1500):
            message = self.refusal(action="plan", title="Grande", tasks=[{"title": "A", "detail": "x" * 1200}])
        self.assertEqual(message, "plan.json would be larger than 1,500 bytes; nothing was saved. Keep notes and logs "
                                  "shorter.")

    def test_damaged_or_foreign_plan_files_give_a_clear_error(self):
        cases = [("{not json", "plan.json is damaged; nothing was changed. Call plan to start a new plan."),
                 ("[1, 2]", "plan.json is damaged; nothing was changed. Call plan to start a new plan."),
                 ('{"schema": 1, "tasks": "x"}', "plan.json is damaged; nothing was changed. Call plan to start a new plan."),
                 ('{"schema": 1, "tasks": [{"id": "1", "title": "A", "deps": ["2"]}, {"id": "2", "title": "B", "deps": ["1"]}]}',
                  "plan.json is damaged; nothing was changed. Call plan to start a new plan."),
                 ('{"tasks": []}', "plan.json is damaged; nothing was changed. Call plan to start a new plan."),
                 ('{"schema": 2, "tasks": []}', "plan.json was written by a newer TaskStudio; nothing was changed. "
                                                "Ask the user to update JumpCode.")]
        for text, message in cases:
            with self.subTest(text=text):
                (self.studio / "plan.json").write_text(text, encoding="utf-8")
                self.assertEqual(self.refusal(action="read"), message)
                self.assertEqual(self.refusal(action="start", id=1), message)
        self.assertIn("newer TaskStudio", self.refusal(action="plan", title="Novo", tasks=chain(1)))
        (self.studio / "plan.json").write_text("{not json", encoding="utf-8")
        replaced = self.call(action="plan", title="Novo", tasks=chain(1))
        self.corrupt("plan.json", None)
        empty = self.call(action="read")
        self.assertEqual((replaced["message"].endswith("(The damaged plan.json was replaced.)"), empty["message"][:20]),
                         (True, "There is no plan yet"))

    def test_hand_edited_plans_are_read_with_defaults(self):
        (self.studio / "plan.json").write_text(json.dumps({"schema": 1, "revision": "x", "tasks": [
            {"id": 1, "title": "A", "deps": ["#9", "1", "bad"], "criteria": ["solto", {"text": "ok"}],
             "gates": [{"label": "Chave"}], "progress": 140},
            {"id": "#2", "title": "B", "deps": [1], "state": "done", "log": "x"}]}), encoding="utf-8")
        result = self.call(action="read")
        self.call(action="resolve", id=1)
        plan = self.load("plan.json")
        self.assertEqual((result["outline"], plan["revision"], plan["nextId"], plan["tasks"][0]["criteria"],
                          plan["tasks"][0]["gates"], "progress" in plan["tasks"][0]),
                         ("#1 A [needs user: Chave]\n#2 B [done] deps #1", 1, 3, [{"text": "ok", "done": False}],
                          [{"label": "Chave", "id": "g1", "kind": "other", "met": True}], False))

    def test_damaged_secondary_files_are_treated_as_absent(self):
        self.barbearia()
        self.complete(1)
        self.call(action="edit", id=1, text="Incluir o dia de folga")
        self.call(action="propose")
        for name in ("proposal.json", "history.json", "view.json"):
            self.corrupt(name, "damaged")
        read = self.call(action="read")
        self.assertEqual(self.refusal(action="apply"), "proposal.json is damaged; nothing was changed. Call discard, "
                                                       "then propose again.")
        discarded = self.call(action="discard")
        self.call(action="focus", id=1)
        self.call(action="edit", id=1, text="Incluir o dia de folga")
        self.call(action="propose")
        self.call(action="apply")
        self.assertEqual({"notes": read["notes"][-1], "discarded": discarded["message"],
                          "view": self.load("view.json")["revision"],
                          "history": [version["plan"] for version in self.load("history.json")["versions"]]},
                         {"notes": "proposal.json is damaged: call discard",
                          "discarded": "Discarded; plan v1 stays as it was.", "view": 1, "history": [2]})

    def test_every_write_raises_the_revision(self):
        self.call(action="plan", title="Rev", tasks=chain(2))
        revisions = [self.load("plan.json")["revision"]]
        for arguments in ({"action": "start", "id": 1}, {"action": "progress", "id": 1, "note": "x"},
                          {"action": "finish", "id": 1}, {"action": "read"}, {"action": "focus", "id": 2}):
            self.call(**arguments)
            revisions.append(self.load("plan.json")["revision"])
        self.assertEqual(revisions, [1, 2, 3, 4, 4, 4])


class FixtureTests(unittest.TestCase):
    def test_the_sample_files_are_what_the_actions_write(self):
        with tempfile.TemporaryDirectory() as folder:
            built = make_fixtures.build(folder)
        stored = {name: (make_fixtures.FIXTURES / name).read_text(encoding="utf-8") for name in make_fixtures.NAMES}
        self.assertEqual({name: json.loads(text) for name, text in built.items()},
                         {name: json.loads(text) for name, text in stored.items()},
                         "Run tests/make_fixtures.py to refresh the sample files")


if __name__ == "__main__":
    unittest.main()
