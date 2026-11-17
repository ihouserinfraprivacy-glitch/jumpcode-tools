# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""The tool as the model uses it, on the barbershop's CSV: opening with types and notes, charts whose numbers
match the ones computed independently, pivot, profile, rows, read-only SQL, problems and undoable fixes,
calculated columns, the panel, exports that never touch the original, and the Studio files."""

import hashlib
import json
from pathlib import Path
import shutil
import tempfile
import time
import unittest

from support import write_csv
import jumpcode_sheetstudio as tool
from jumpcode_sheetstudio import types
from jumpcode_sheetstudio.common import SheetStudioError, read_json


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class Base(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix="sheetstudio-"))
        self.studio = self.base / "studio"
        self.project = self.base / "barbearia"
        self.studio.mkdir()
        self.project.mkdir()
        self.expected = write_csv(self.project)
        self.original = digest(self.expected["path"])
        self.context = {"studio_root": str(self.studio), "source_root": str(self.project)}
        self.results = []

    def tearDown(self):
        shutil.rmtree(self.base, ignore_errors=True)

    def call(self, **arguments):
        result = tool.run(tool.validate(arguments), self.context)
        self.results.append(result)
        return result

    def file(self, name):
        return read_json(self.studio / name)


class OpenAndAnswer(Base):
    def test_open_types_and_notes(self):
        off = self.call(action="status")
        listed = self.call(action="files")
        opened = self.call(action="open", path="dados/atendimentos-2026.csv")
        sheet = self.file("sheet.json")
        grid = self.file("grid.json")
        kinds = {c["name"]: c["type"] for c in opened["columns"]}
        self.assertEqual({
            "off": off["open"], "listed": [f["path"] for f in listed["files"]], "rows": opened["rows"],
            "kinds": kinds, "notes": opened["notes"], "separator": sheet["file"]["meta"]["separator"], "encoding": sheet["file"]["meta"]["encoding"],
            "intact": sheet["file"]["intact"], "grid": (len(grid["rows"]), grid["matched"]), "status": sheet["status"],
        }, {
            "off": False, "listed": ["dados/atendimentos-2026.csv"], "rows": self.expected["rows"],
            "kinds": {"data": "date", "hora": "time", "cliente": "text", "serviço": "category", "barbeiro": "category", "valor": "currency",
                      "pagamento": "category", "origem": "category", "status": "category"},
            "notes": {"text-date": self.expected["iso_dates"] + self.expected["short_dates"], "text-number": self.expected["money_text"]},
            "separator": ";", "encoding": "cp1252", "intact": True, "grid": (500, self.expected["rows"]), "status": "ready",
        })

    def test_charts_match_the_numbers(self):
        self.call(action="open", path="dados/atendimentos-2026.csv")
        monthly = self.call(action="chart", x="data", by="mês", y="valor", agg="soma", filter="status = concluido", question="faturamento por mês")
        expected = self.expected["by_month_raw"]
        chart = self.file("charts.json")["charts"][0]
        heat = self.call(action="chart", x="hora", group="data", group_by="weekday", kind="heatmap")
        counted = self.call(action="chart", x="serviço", agg="count")
        pivot = self.call(action="pivot", rows="serviço", columns="barbeiro", value="valor", agg="sum", filter="status = concluído")
        table = self.file("charts.json")["charts"][0]["pivot"]
        self.assertEqual({
            "labels": monthly["labels"], "values": monthly["series"][0]["values"], "total": monthly["total"],
            "kind": chart["kind"], "used": chart["calc"]["rowsUsed"] == chart["calc"]["rowsMatched"], "excluded": chart["calc"]["excluded"][0]["reason"],
            "heat": (heat["kind"], heat["labels"][0]), "count": sum(counted["series"][0]["values"]),
            "pivot": round(sum(table["rowTotals"]), 2), "history": len(self.file("history.json")["entries"]),
        }, {
            "labels": [types.MONTHS[int(k[5:]) - 1] for k in sorted(expected)], "values": [expected[k] for k in sorted(expected)],
            "total": self.expected["revenue_raw"], "kind": "bar", "used": True,
            "excluded": "fora do filtro", "heat": ("heatmap", "09h"), "count": self.expected["rows"],
            "pivot": self.expected["revenue_raw"], "history": 4,
        })

    def test_small_model_groupings(self):
        self.call(action="open", path="dados/atendimentos-2026.csv")
        misplaced = self.call(action="chart", x="data", y="valor", group_by="data day", title="Faturamento por Mês - Atendimentos Concluídos")
        default = self.call(action="chart", x="data", y="valor", agg="sum")
        daily = self.call(action="chart", x="data", by="dia", y="valor", filter="data <= 10/01/2026")
        same = self.call(action="chart", x="serviço", group="serviço", y="valor", agg="sum")
        self.assertEqual((misplaced["labels"][:2], default["labels"][:2], daily["labels"][:2], len(same["series"])),
                         (["jan", "fev"], ["jan", "fev"], ["02/01", "03/01"], 1))

    def test_rows_profile_and_query(self):
        self.call(action="open", path="dados/atendimentos-2026.csv")
        shown = self.call(action="rows", filter="serviço = Corte e barba e status = concluído", sort="-valor")
        profile = self.call(action="profile", column="valor")
        answer = self.call(action="query", sql="SELECT status, COUNT(*) AS n FROM dados GROUP BY status ORDER BY n DESC")
        refused = []
        for sql in ("DELETE FROM dados", "SELECT 1; DROP TABLE dados", "SELECT * FROM sqlite_master", "ATTACH 'x.db' AS y"):
            try:
                self.call(action="query", sql=sql)
            except SheetStudioError as error:
                refused.append(str(error)[:20])
        self.assertEqual({
            "shown": shown["matched"] > 0 and shown["matched"] < self.expected["rows"], "grid": self.file("grid.json")["filter"],
            "profile": "valor (R$ moeda)" in profile["message"], "query": answer["columns"], "statuses": sorted(r[0] for r in answer["rows"]),
            "refused": len(refused),
        }, {
            "shown": True, "grid": ["serviço = Corte e barba", "status = concluído"], "profile": True, "query": ["status", "n"],
            "statuses": ["cancelado", "concluído", "faltou"], "refused": 4,
        })


class Clean(Base):
    def test_problems_fix_undo_and_columns(self):
        self.call(action="open", path="dados/atendimentos-2026.csv")
        found = self.call(action="problems")
        ids = sorted(p["id"] for p in found["problems"])
        cleanup = self.file("cleanup.json")
        fine = [f["text"] for f in cleanup["fine"]]
        fixed = self.call(action="fix", which="all")
        clean_rows = fixed["rows"]
        after = self.call(action="chart", x="data", by="month", y="valor", agg="sum", filter="status = concluído")
        weekday = self.call(action="column", name="dia da semana", **{"from": "data"}, part="weekday")
        commission = self.call(action="column", name="comissão", expression="valor * 0.4")
        grid = self.file("grid.json")
        undone = self.call(action="undo", step="all")
        self.assertEqual({
            "ids": ids, "duplicates": next(p["count"] for p in found["problems"] if p["id"] == "duplicates"),
            "fine": any("pagamento vazios são exatamente as linhas com status" in t for t in fine),
            "clean_rows": clean_rows, "after_total": after["total"], "after_basis": self.file("charts.json")["charts"][0]["calc"]["basis"],
            "columns": [c["name"] for c in grid["columns"]][-2:], "weekday": "seg" in weekday["message"] or "ter" in weekday["message"],
            "commission": commission["column"], "undone": self.file("sheet.json")["rows"], "steps": self.file("sheet.json")["steps"],
            "original": digest(self.expected["path"]) == self.original,
        }, {
            "ids": sorted(["duplicates", "spaces:serviço", "spelling:serviço", "text-date:data", "text-number:valor"]), "duplicates": self.expected["copies"],
            "fine": True, "clean_rows": self.expected["unique_rows"], "after_total": self.expected["revenue_clean"], "after_basis": "clean",
            "columns": ["dia da semana", "comissão"], "weekday": True, "commission": "comissão", "undone": self.expected["rows"], "steps": [],
            "original": True,
        })

    def test_custom_steps(self):
        self.call(action="open", path="dados/atendimentos-2026.csv")
        removed = self.call(action="step", kind="remove_rows", filter="status = cancelado")
        filled = self.call(action="step", kind="fill", column="cliente", value="Balcão")
        replaced = self.call(action="step", kind="replace", column="barbeiro", old="Zé", new="José")
        counts = self.call(action="chart", x="barbeiro", agg="count")
        self.assertEqual({"removed": removed["step"], "filled": filled["step"], "replaced": replaced["step"], "names": sorted(counts["labels"]),
                          "rows": self.file("sheet.json")["rows"] < self.expected["rows"]},
                         {"removed": "p1", "filled": "p2", "replaced": "p3", "names": ["José", "Léo", "Rafa"], "rows": True})


class Export(Base):
    def test_exports_are_new_files(self):
        self.call(action="open", path="dados/atendimentos-2026.csv")
        self.call(action="fix", which="duplicates")
        self.call(action="chart", x="serviço", y="valor", agg="sum", filter="status = concluído")
        data = self.call(action="export", what="data", format="csv")
        again = self.call(action="export", what="data", format="csv")
        image = self.call(action="export", what="chart", format="svg")
        files = sorted(p.relative_to(self.project).as_posix() for p in (self.project / "dados" / "saida").iterdir())
        text = (self.project / data["files"][0]).read_text(encoding="utf-8-sig").splitlines()
        svg = (self.project / image["files"][0]).read_text(encoding="utf-8")
        self.assertEqual({"files": files, "header": text[0], "rows": len(text) - 1, "svg": svg.startswith("<svg") and "Corte e barba" in svg,
                          "original": digest(self.expected["path"]) == self.original},
                         {"files": ["dados/saida/atendimentos-2026-limpo (2).csv", "dados/saida/atendimentos-2026-limpo.csv", "dados/saida/valor-por-servico.svg"],
                          "header": "data;hora;cliente;serviço;barbeiro;valor;pagamento;origem;status", "rows": self.expected["unique_rows"], "svg": True,
                          "original": True})

    def test_xlsx_round_trip(self):
        from jumpcode_sheetstudio.readers import open_workbook
        self.call(action="open", path="dados/atendimentos-2026.csv")
        self.call(action="chart", x="data", by="month", y="valor", agg="sum")
        written = self.call(action="export", what="all", format="xlsx")
        book = open_workbook(self.project / written["files"][0])
        names = [s.name for s in book.sheets]
        first = list(book.rows("Dados"))[:2]
        book.close()
        self.assertEqual((names[0], len(names), first[0][:3], type(first[1][0]).__name__), ("Dados", 2, ["data", "hora", "cliente"], "date"))


class Arguments(Base):
    def test_validation_and_context(self):
        problems = []
        for arguments in ({"action": "nada"}, {"action": "chart", "top": "5"}, {"action": "export", "format": "pdf"}, {"action": "status", "senha": "x"}):
            try:
                tool.validate(arguments)
            except SheetStudioError as error:
                problems.append(str(error))
        errors = []
        for context in ({}, {"studio_root": str(self.base / "missing")}):
            try:
                tool.run({"action": "status"}, context)
            except SheetStudioError as error:
                errors.append(str(error)[:30])
        try:
            tool.run({"action": "open", "path": "../fora.csv"}, self.context)
        except SheetStudioError as error:
            errors.append(str(error)[:30])
        ignored = self.call(action="files", x="data")
        self.assertEqual({"aliases": tool.validate({"action": "grafico", "x": "data"})["action"], "problems": len(problems), "errors": errors,
                          "ignored": "Ignored for files: x" in ignored["message"]},
                         {"aliases": "chart", "problems": 4, "errors": ["SheetStudio only works inside ", "The Studio folder is unavailab",
                                                                         "The path must be relative to t"], "ignored": True})


class Types(unittest.TestCase):
    def test_brazilian_values(self):
        numbers = [types.number_from_text(t) for t in ("R$ 1.234,56", "45,00", "-12,5%", "1.234", "(70,00)", "12a")]
        dates = [types.date_from_text(t) for t in ("05/01/2026", "2026-01-05", "05/01/26", "31/02/2026", "05/01/2026 09:30")]
        self.assertEqual({"numbers": numbers, "dates": [d[1] if d else None for d in dates]},
                         {"numbers": [(1234.56, "currency"), (45.0, "number"), (-0.125, "percent"), (1234, "integer"), (-70.0, "number"), None],
                          "dates": ["dd/mm/aaaa", "aaaa-mm-dd", "dd/mm/aa", None, "dd/mm/aaaa hh:mm"]})


class Large(Base):
    def test_large_csv(self):
        lines = ["data;loja;valor"] + [f"{1 + i % 28:02d}/{1 + i % 12:02d}/2026;Loja {i % 9};{i % 500},50" for i in range(200_000)]
        (self.project / "grande.csv").write_text("\n".join(lines), encoding="utf-8")
        started = time.time()
        opened = self.call(action="open", path="grande.csv")
        seconds = time.time() - started
        totals = self.call(action="chart", x="loja", y="valor", agg="sum")
        print(f"\n200,000-row CSV opened in {seconds:.1f} s")
        self.assertEqual((opened["rows"], len(totals["labels"]), seconds < 60), (200_000, 9, True))


if __name__ == "__main__":
    unittest.main()
