# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Data integrity regressions exercised through the public tool on temporary projects."""

import csv
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
from xml.etree import ElementTree as ET

import support  # noqa: F401
import jumpcode_sheetstudio as tool
from jumpcode_sheetstudio import export, types
from jumpcode_sheetstudio.common import SheetStudioError
from jumpcode_sheetstudio.readers import SheetFormatError, open_workbook
from jumpcode_sheetstudio.store import Store


class Regressions(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="sheetstudio-regressions-")
        self.addCleanup(self.temp.cleanup)
        self.project = Path(self.temp.name) / "project"
        self.studio = Path(self.temp.name) / "studio"
        self.project.mkdir()
        self.studio.mkdir()
        self.context = {"source_root": str(self.project), "studio_root": str(self.studio)}

    def call(self, **arguments):
        return tool.run(tool.validate(arguments), self.context)

    def file(self, name):
        return json.loads((self.studio / name).read_text(encoding="utf-8"))

    def open(self, text="n;q\n10;3\n20;6\n", path="data.csv", **options):
        (self.project / path).write_text(text, encoding="utf-8")
        return self.call(action="open", path=path, **options)

    def values(self):
        return [r[1:] for r in self.file("grid.json")["rows"]]

    def test_cancelled_reimport_preserves_data_steps_and_views(self):
        self.open("n;q\n" + "\n".join(f"{i};3" for i in range(12000)))
        self.call(action="column", name="dobro", expression="n*2")
        before, rows = self.file("sheet.json"), self.values()
        checks = 0

        def cancelled():
            nonlocal checks
            if self.file("sheet.json")["status"] == "importing":
                checks += 1
            return checks >= 4

        with self.assertRaises((SheetFormatError, SheetStudioError)):
            tool.run(tool.validate({"action": "open", "path": "data.csv", "header": True}), self.context, cancelled)
        self.assertGreaterEqual(checks, 4)
        self.assertTrue(self.call(action="status")["open"])
        after = self.file("sheet.json")
        self.assertEqual((after["status"], after["steps"], after["version"], self.values()),
                         ("ready", before["steps"], before["version"], rows))

    def test_changed_file_failure_rolls_back_registration_and_all_sheets(self):
        self.open()
        self.call(action="column", name="dobro", expression="n*2")
        before, rows = self.file("sheet.json"), self.values()
        (self.project / "data.csv").write_text("n;q\n100;3\n200;6\n", encoding="utf-8")
        with patch.object(Store, "import_sheet", side_effect=RuntimeError("reader failed")):
            with self.assertRaises(RuntimeError):
                self.call(action="open", path="data.csv")
        after = self.file("sheet.json")
        self.assertEqual((after["file"]["sha256"], after["steps"], after["version"], self.values()),
                         (before["file"]["sha256"], before["steps"], before["version"], rows))
        self.assertEqual(after["status"], "ready")

    def test_failed_first_import_is_not_left_importing(self):
        (self.project / "data.csv").write_text("n;q\n1;2\n", encoding="utf-8")
        with patch.object(Store, "import_sheet", side_effect=RuntimeError("reader failed")):
            with self.assertRaises(RuntimeError):
                self.call(action="open", path="data.csv")
        self.assertEqual(self.file("sheet.json")["status"], "empty")
        self.assertFalse(self.call(action="status")["open"])

    def test_undo_dependency_is_refused_atomically_and_can_be_undone_together(self):
        self.open()
        self.call(action="column", name="dobro", expression="n*2")
        self.call(action="column", name="triplo", expression="dobro*1.5")
        before = self.file("sheet.json")
        with self.assertRaisesRegex(SheetStudioError, "depends on"):
            self.call(action="undo", step="p1")
        self.call(action="status")
        self.assertEqual(self.file("sheet.json")["version"], before["version"])
        self.assertEqual([r[-2:] for r in self.values()], [[20, 30], [40, 60]])
        self.call(action="undo", step="all")
        self.assertEqual(self.values(), [[10, 3], [20, 6]])

    def test_integer_division_preserves_fractions_and_precedence(self):
        self.open()
        for name, formula, expected in [("ratio", "n/q", 10/3), ("nested", "(n+q)/(q*2)", 13/6),
                                        ("chain", "n/q/2", 5/3), ("constant", "10/3", 10/3)]:
            self.call(action="column", name=name, expression=formula)
            self.assertAlmostEqual(self.values()[0][-1], expected)

    def test_function_arguments_are_independent_of_spacing(self):
        self.open()
        cases = [
            ("iif(n>15,10,20)", [20, 10]),
            ("iif(n > 15, 10, 20)", [20, 10]),
            ("iif(n>15,1.25,-0.5)", [-0.5, 1.25]),
            ("iif(n>15,round(n/3,2),max(q,4))", [4, 6.67]),
            ("round(1,2)", [1, 1]),
            ("substr('a,b,c',2,3)", [",b,", ",b,"]),
            ("n*(0,4)", [4, 8]),
        ]
        for index, (expression, expected) in enumerate(cases):
            with self.subTest(expression=expression):
                self.call(action="column", name=f"result {index}", expression=expression,
                          type="text" if isinstance(expected[0], str) else "number")
                self.assertEqual([r[-1] for r in self.values()], expected)

    def test_invalid_formula_keeps_previous_data(self):
        self.open()
        before = self.file("sheet.json")
        for expression in ("n, q", "iif(n>15,10,)", "n); DROP TABLE dados;--"):
            with self.subTest(expression=expression), self.assertRaises(SheetStudioError):
                self.call(action="column", name="invalid", expression=expression)
        self.call(action="status")
        self.assertEqual((self.values(), self.file("sheet.json")["version"]), ([[10, 3], [20, 6]], before["version"]))

    def test_calculated_columns_can_filter_and_block_unsafe_undo(self):
        self.open()
        self.call(action="column", name="dobro", expression="n*2")
        self.call(action="step", kind="remove_rows", filter="dobro > 25")
        self.assertEqual(self.values(), [[10, 3, 20]])
        with self.assertRaises(SheetStudioError):
            self.call(action="undo", step="p1")
        self.call(action="undo", step="last")
        self.assertEqual(len(self.values()), 2)

    def test_calculated_filter_for_fill(self):
        self.open("n;nome\n10;Ana\n20;\n")
        self.call(action="column", name="dobro", expression="n*2")
        self.call(action="step", kind="fill", column="nome", value="Bia", filter="dobro > 25")
        self.assertEqual(self.values()[1][1], "Bia")

    def test_step_ids_are_scoped_to_each_file(self):
        for path in ("a.csv", "b.csv"):
            self.open(path=path)
            self.call(action="column", name="dobro", expression="n*2")
            self.assertEqual(self.file("sheet.json")["steps"][0]["id"], "p1")
        self.call(action="undo", step="p1")
        self.call(action="open", path="a.csv")
        self.assertEqual(self.file("sheet.json")["steps"][0]["id"], "p1")
        self.assertEqual(self.values()[0][-1], 20)

    def test_step_ids_are_scoped_to_each_workbook_sheet(self):
        from jumpcode_sheetstudio.writers.xlsx import write_xlsx
        write_xlsx(self.project / "book.xlsx", [
            {"name": name, "columns": [{"name": "n", "type": "integer"}], "rows": [[10], [20]]}
            for name in ("One", "Two")])
        for name in ("One", "Two"):
            self.call(action="open", path="book.xlsx", sheet=name)
            self.call(action="column", name="dobro", expression="n*2")
            self.assertEqual(self.file("sheet.json")["steps"][0]["id"], "p1")
        self.call(action="sheet", sheet="One")
        self.assertEqual(self.values(), [[10, 20], [20, 40]])

    def test_changed_date_order_is_used_on_reopen(self):
        self.open("dia;nome\n05/06/2026;Ana\n06/07/2026;Bia\n")
        self.assertEqual(self.values()[0][0], "2026-06-05")
        self.call(action="settings", date_order="mdy")
        self.call(action="open", path="data.csv")
        self.assertEqual(self.values()[0][0], "2026-05-06")

    def test_legacy_step_schema_migrates_without_losing_steps(self):
        self.open()
        self.call(action="column", name="dobro", expression="n*2")
        db = sqlite3.connect(self.studio / "data" / "sheets.db")
        with db:
            db.execute("ALTER TABLE steps RENAME TO previous_steps")
            db.execute("CREATE TABLE steps(id TEXT PRIMARY KEY, sheet TEXT, n INTEGER, kind TEXT, spec TEXT, text TEXT, rows INTEGER, at REAL)")
            db.execute("INSERT INTO steps SELECT * FROM previous_steps")
            db.execute("DROP TABLE previous_steps")
            db.execute("DELETE FROM state WHERE key LIKE 'reading:%'")
        db.close()
        self.open(path="other.csv")
        self.call(action="column", name="dobro", expression="n*2")
        self.call(action="open", path="data.csv")
        self.assertEqual(self.values()[0][-1], 20)

    def test_changed_source_refreshes_profile_scan_and_revision(self):
        self.open("nome;valor\nAna;10\nBia;20\n")
        self.call(action="problems")
        before = self.file("sheet.json")["version"]
        self.open("nome;valor\nAna;100\nBia;200\n")
        self.assertEqual(self.file("sheet.json")["columns"][1]["sum"], 300)
        self.assertGreater(self.file("sheet.json")["version"], before)
        self.assertEqual(self.call(action="chart", x="nome", y="valor")["total"], 300)
        store = Store(self.studio)
        try:
            self.assertEqual(store.db.execute("SELECT COUNT(*) FROM state WHERE key LIKE 'profile:%'").fetchone()[0], 1)
        finally:
            store.close()

    def test_reading_settings_apply_and_unchanged_open_reuses_import(self):
        self.open("medida;nome\n1.234;Ana\n2.345;Bia\n")
        self.assertEqual(self.values()[0][0], 1234)
        self.call(action="settings", decimal="dot")
        self.call(action="open", path="data.csv")
        self.assertEqual(self.values()[0][0], 1.234)
        revision = self.file("sheet.json")["version"]
        with patch.object(Store, "import_sheet", side_effect=AssertionError("must reuse")):
            self.call(action="open", path="data.csv")
        self.assertEqual(self.file("sheet.json")["version"], revision)

    def test_reopen_preserves_header_and_cleanup(self):
        self.open("Ana;Porto\nBia;Lisboa\n", header=False)
        self.call(action="column", name="Extra", expression="1")
        before, values = self.file("sheet.json"), self.values()
        self.open(path="other.csv")
        with patch.object(Store, "import_sheet", side_effect=AssertionError("must reuse")):
            self.call(action="open", path="data.csv")
            self.call(action="sheet", sheet="data")
        after = self.file("sheet.json")
        self.assertEqual((after["steps"], after["version"], self.values()), (before["steps"], before["version"], values))
        self.assertEqual((self.project / "data.csv").read_text(encoding="utf-8"), "Ana;Porto\nBia;Lisboa\n")

    def test_reopen_preserves_reader_overrides_after_source_change(self):
        path = self.project / "data.csv"
        path.write_bytes("Ana:Café\nBia:São Paulo\n".encode("cp1252"))
        self.call(action="open", path="data.csv", header=False, separator=":", encoding="cp1252")
        self.call(action="open", path="data.csv")
        self.assertEqual(self.values(), [["Ana", "Café"], ["Bia", "São Paulo"]])
        path.write_bytes("Ana:Café\nBia:São Paulo\nCaio:Belém\n".encode("cp1252"))
        self.call(action="open", path="data.csv")
        self.assertEqual(self.values(), [["Ana", "Café"], ["Bia", "São Paulo"], ["Caio", "Belém"]])
        self.assertEqual(self.file("sheet.json")["file"]["meta"]["separator"], ":")

    def test_file_overrides_survive_changes_to_defaults_and_partial_overrides(self):
        self.open("1.234;05/06/2026\n2.345;06/07/2026\n", header=False, decimal="dot", date_order="mdy")
        self.call(action="column", name="Extra", expression="1")
        self.call(action="settings", decimal="comma", date_order="dmy")
        with patch.object(Store, "import_sheet", side_effect=AssertionError("explicit file options take precedence")):
            self.call(action="open", path="data.csv")
        self.assertEqual(self.values()[0], [1.234, "2026-05-06", 1])
        self.call(action="open", path="data.csv", date_order="dmy")
        self.assertEqual(self.values()[0], [1.234, "2026-06-05"])

    def test_legacy_reading_options_are_kept_on_reopen(self):
        self.open("Ana;Porto\nBia;Lisboa\n", header=False)
        self.call(action="column", name="Extra", expression="1")
        store = Store(self.studio)
        try:
            key = f"reading:{store.active()[1]['id']}"
            options = store.get(key)
            options.pop("overrides", None)
            store.put(key, options)
        finally:
            store.close()
        with patch.object(Store, "import_sheet", side_effect=AssertionError("legacy options must not discard work")):
            self.call(action="open", path="data.csv")
        self.assertEqual(self.values(), [["Ana", "Porto", 1], ["Bia", "Lisboa", 1]])

    def test_close_forgets_reader_preferences_consistently(self):
        self.open("Ana;Porto\nBia;Lisboa\n", header=False, separator="|")
        self.assertEqual(len(self.values()[0]), 1)
        self.call(action="close")
        self.call(action="open", path="data.csv")
        self.assertEqual(self.values(), [["Bia", "Lisboa"]])

    def test_revision_remains_monotonic_after_undo_all(self):
        self.open()
        self.call(action="column", name="dobro", expression="n*2")
        previous = self.file("sheet.json")["version"]
        self.call(action="undo", step="all")
        self.call(action="chart", x="q", y="n")
        current = self.file("sheet.json")["version"]
        self.assertGreater(current, previous)
        self.assertEqual(self.file("charts.json")["charts"][0]["calc"]["steps"], current)

    def test_all_series_contribute_to_total_and_pivot(self):
        self.open("loja;grupo;valor\n" + "\n".join(f"Loja;Grupo {i};10" for i in range(13)))
        self.call(action="chart", x="loja", group="grupo", y="valor", agg="sum")
        chart = self.file("charts.json")["charts"][0]
        self.assertEqual((len(chart["series"]), chart["total"], chart["calc"]["rowsUsed"], chart["calc"]["excluded"]), (13, 130, 13, []))
        self.call(action="pivot", rows="loja", columns="grupo", value="valor", agg="sum")
        chart = self.file("charts.json")["charts"][0]
        pivot = chart["pivot"]
        self.assertEqual((len(pivot["columns"]), chart["total"], sum(pivot["cells"][0])), (13, 130, 130))

    def test_small_values_keep_precision_in_charts_pivots_and_exports(self):
        self.open("Grupo;Medida\nA;0.00001\nA;0.00002\nB;0.00004\n", decimal="dot")
        expected = {r[0]: r[1] for r in self.call(action="query", sql="SELECT Grupo,SUM(Medida) FROM dados GROUP BY Grupo")["rows"]}
        result = self.call(action="chart", x="Grupo", y="Medida", agg="sum")
        self.assertEqual(dict(zip(result["labels"], result["series"][0]["values"])), expected)
        self.assertAlmostEqual(result["total"], 0.00007, delta=1e-18)
        self.assertNotIn("Total 0,00", result["message"])
        for fmt in ("csv", "xlsx"):
            written = self.call(action="export", what="chart", chart=result["chart"], format=fmt)
            path = self.project / written["files"][0]
            if fmt == "csv":
                rows = list(csv.reader(io.StringIO(path.read_text(encoding="utf-8-sig")), delimiter=";"))[1:]
                actual = {r[0]: float(r[1].replace(",", ".")) for r in rows}
            else:
                book = open_workbook(path)
                try:
                    actual = dict(list(book.rows("Dados"))[1:])
                finally:
                    book.close()
            self.assertEqual(actual, expected)
        self.call(action="pivot", rows="Grupo", value="Medida", agg="sum")
        pivot = self.file("charts.json")["charts"][0]["pivot"]
        self.assertEqual(dict(zip(pivot["rows"], pivot["rowTotals"])), expected)
        self.assertAlmostEqual(pivot["columnTotals"][0], 0.00007, delta=1e-18)
        profile = self.file("sheet.json")["columns"][1]
        self.assertAlmostEqual(profile["sum"], 0.00007, delta=1e-18)
        self.assertGreater(profile["histogram"]["step"], 0)

    def test_small_display_values_are_not_reported_as_zero(self):
        for value in (0.00003, -0.00004, 1e-9, -1e-9):
            with self.subTest(value=value):
                for label in (types.number(value), types.brl(value), export.short(value, "number"), export.short(value, "currency")):
                    self.assertEqual(float(label.replace("R$ ", "").replace(",", ".")), value)
                self.assertAlmostEqual(float(types.show(value, "percent").rstrip("%").replace(",", ".")) / 100, value, delta=abs(value) * 1e-12)

    def test_reading_options_are_scoped_to_each_workbook_sheet(self):
        from jumpcode_sheetstudio.writers.xlsx import write_xlsx
        write_xlsx(self.project / "book.xlsx", [
            {"name": name, "columns": [{"name": "nome", "type": "text"}], "rows": [["Ana"], ["Bia"]]}
            for name in ("One", "Two")])
        self.call(action="open", path="book.xlsx", sheet="One", header=False)
        self.call(action="column", name="Extra", expression="1")
        expected = self.values()
        self.call(action="sheet", sheet="Two")
        self.assertEqual(self.values(), [["Ana"], ["Bia"]])
        with patch.object(Store, "import_sheet", side_effect=AssertionError("must reuse each sheet's options")):
            self.call(action="sheet", sheet="One")
        self.assertEqual(self.values(), expected)

    def test_min_max_text_is_actionable_and_sql_remains_available(self):
        self.open("loja;nome\nA;Ana\nA;Bia\nB;Caio\n")
        for agg in ("min", "max"):
            with self.assertRaisesRegex(SheetStudioError, "Use query"):
                self.call(action="chart", x="loja", y="nome", agg=agg)
        result = self.call(action="query", sql="SELECT MIN(nome), MAX(nome) FROM dados")
        self.assertEqual(result["rows"], [["Ana", "Caio"]])

    def test_csv_export_preserves_numbers_and_seconds(self):
        self.open("medida;instante\n1,23456;14/11/2026 12:34:56\n2,34567;14/11/2026 13:45:23\n")
        written = self.call(action="export", what="data", format="csv")
        text = (self.project / written["files"][0]).read_text(encoding="utf-8-sig")
        self.assertEqual(list(csv.reader(io.StringIO(text), delimiter=";"))[1], ["1,23456", "14/11/2026 12:34:56"])
        self.assertEqual(export._value(0.1234567, "percent", "br"), "12,3456700%")
        self.assertEqual(export._value(1.23456, "currency", "br"), "1,23456")
        self.assertEqual(export._value("12:34:56.123", "time", "br"), "12:34:56.123")

    def test_query_exports_include_values_and_typed_numbers(self):
        self.open()
        self.call(action="query", sql="SELECT SUM(n) AS total FROM dados")
        for fmt in ("csv", "xlsx"):
            written = self.call(action="export", what="chart", format=fmt)
            path = self.project / written["files"][0]
            if fmt == "csv":
                self.assertEqual(path.read_text(encoding="utf-8-sig").splitlines(), ["total", "30"])
            else:
                book = open_workbook(path)
                try:
                    self.assertEqual(list(book.rows("Dados")), [["total"], [30]])
                finally:
                    book.close()

    def test_svg_preserves_negative_marks_and_valid_geometry(self):
        self.open("nome;valor\nA;20\nB;-10\n")
        for kind in ("bar", "hbar", "grouped", "stacked", "stacked100", "heatmap", "line"):
            with self.subTest(kind=kind):
                self.call(action="chart", x="nome", y="valor", kind=kind)
                chart = self.file("charts.json")["charts"][0]
                document = ET.fromstring(export.svg(chart))
                rects = [el for el in document if el.tag.endswith("rect") and el.attrib.get("fill") != "#FFFFFF"]
                self.assertTrue(all(float(r.attrib["width"]) > 0 and float(r.attrib["height"]) > 0 for r in rects))
                if kind != "line":
                    self.assertEqual(len(rects), 2)
                self.assertNotIn("nan", export.svg(chart).lower())


if __name__ == "__main__":
    unittest.main()
