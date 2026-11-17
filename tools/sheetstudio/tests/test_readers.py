# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Reader and writer tests: CSV/TSV (Brazilian Excel exports, BOMs, quotes), XLSX, ODS and XLS built from their
published formats by fixtures_build, encrypted and damaged files, cancellation, an XLSX round trip with every
column type and a 200,000-row CSV timing."""

import datetime
from pathlib import Path
import random
import shutil
import struct
import sys
import tempfile
import time
import types
import unittest
import xml.etree.ElementTree as ElementTree
import zipfile

SOURCE = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SOURCE))
sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    import jumpcode_sheetstudio  # noqa: F401,E402
except Exception:  # the rest of the package may be mid-change; the readers do not depend on it
    _stub = types.ModuleType("jumpcode_sheetstudio")
    _stub.__path__ = [str(SOURCE / "jumpcode_sheetstudio")]
    sys.modules["jumpcode_sheetstudio"] = _stub

import fixtures_build as build  # noqa: E402
from jumpcode_sheetstudio.readers import CellError, SheetFormatError, SheetInfo, open_workbook  # noqa: E402
from jumpcode_sheetstudio.readers import cfb, xls  # noqa: E402
from jumpcode_sheetstudio.readers.common import excel_datetime, format_info  # noqa: E402
from jumpcode_sheetstudio.readers.xlsx import shift_formula  # noqa: E402
from jumpcode_sheetstudio.readers.ods import odf_formula  # noqa: E402
from jumpcode_sheetstudio.writers.xlsx import write_xlsx  # noqa: E402

D = datetime.date
DT = datetime.datetime
T = datetime.time


class Folder(unittest.TestCase):
    def setUp(self):
        self.folder = Path(tempfile.mkdtemp(prefix="sheetstudio-test-"))

    def tearDown(self):
        shutil.rmtree(self.folder, ignore_errors=True)

    def file(self, name, data):
        path = self.folder / name
        path.write_bytes(data.encode("utf-8") if isinstance(data, str) else data)
        return path

    def read(self, path, sheet=None, **options):
        with open_workbook(path, **options) as book:
            return list(book.rows(sheet if sheet is not None else book.sheets[0].name))

    def assertFails(self, kind, path, **options):
        with self.assertRaises(SheetFormatError) as caught:
            with open_workbook(path, **options) as book:
                for sheet in book.sheets:
                    list(book.rows(sheet.name))
        self.assertEqual(caught.exception.kind, kind, str(caught.exception))
        return caught.exception


# ---------------------------------------------------------------- CSV / TSV

class DelimitedTests(Folder):
    BRAZIL = ('sep=;\r\nNome;Valor;Data;Obs\r\nZé;1.234,56;15/01/2024;"com ; ponto e vírgula"\r\n'
              'Conceição;"45,00";16/01/2024;"aspas ""duplas"""\r\n;R$ 45,00;;\r\n')

    def test_brazilian_excel_export_in_cp1252_with_sep_hint(self):
        path = self.file("vendas.csv", self.BRAZIL.encode("cp1252"))
        with open_workbook(path) as book:
            rows = list(book.rows("vendas"))
            self.assertEqual((book.format, book.sheets, {k: v for k, v in book.meta.items() if k != "warnings"}),
                             ("csv", [SheetInfo("vendas", False, False, None, None)],
                              {"encoding": "cp1252", "separator": ";", "quote": '"', "lineEnding": "\r\n", "bytes": path.stat().st_size}))
            self.assertEqual(book.meta["warnings"], ["the first line 'sep=;' is an Excel hint and was skipped"])
            self.assertEqual(book.formulas("vendas"), {})
        self.assertEqual(rows, [["Nome", "Valor", "Data", "Obs"], ["Zé", "1.234,56", "15/01/2024", "com ; ponto e vírgula"],
                                ["Conceição", "45,00", "16/01/2024", 'aspas "duplas"'], [None, "R$ 45,00"]])

    def test_semicolon_detected_despite_decimal_commas(self):
        path = self.file("sem_dica.csv", self.BRAZIL.split("\r\n", 1)[1].encode("cp1252"))
        with open_workbook(path) as book:
            self.assertEqual((book.meta["separator"], book.meta["warnings"]), (";", []))
            self.assertEqual(list(book.rows("sem_dica"))[2], ["Conceição", "45,00", "16/01/2024", 'aspas "duplas"'])

    def test_utf8_bom_and_comma(self):
        path = self.file("bom.csv", "﻿nome,valor,cidade\nZé,\"45,00\",São Paulo\nAna,\"1.234,50\",\n".encode("utf-8"))
        with open_workbook(path) as book:
            self.assertEqual((book.format, book.meta["encoding"], book.meta["separator"], book.meta["lineEnding"]),
                             ("csv", "utf-8-sig", ",", "\n"))
            self.assertEqual(list(book.rows("bom")), [["nome", "valor", "cidade"], ["Zé", "45,00", "São Paulo"], ["Ana", "1.234,50"]])

    def test_plain_utf8_without_bom(self):
        path = self.file("utf8.csv", "a;b\nJoão;Ação\n".encode("utf-8"))
        with open_workbook(path) as book:
            self.assertEqual((book.meta["encoding"], list(book.rows("utf8"))), ("utf-8", [["a", "b"], ["João", "Ação"]]))

    def test_tsv_and_utf16(self):
        tsv = self.file("dados.tsv", "a\tb\tc\n1\t2,5\t\n")
        self.assertEqual(self.read(tsv), [["a", "b", "c"], ["1", "2,5"]])
        with open_workbook(tsv) as book:
            self.assertEqual((book.format, book.meta["separator"]), ("tsv", "\t"))
        unicode_text = self.file("excel_unicode.txt", "﻿Nome\tValor\r\nZé\t45\r\n".encode("utf-16-le"))
        with open_workbook(unicode_text) as book:
            self.assertEqual((book.format, book.meta["encoding"], list(book.rows(0))), ("tsv", "utf-16", [["Nome", "Valor"], ["Zé", "45"]]))

    def test_quoted_newlines_cr_line_endings_and_empty_rows(self):
        path = self.file("notas.csv", 'id;texto\r1;"linha 1\nlinha 2"\r\r2;"x;y"\r3;;\r')
        with open_workbook(path) as book:
            self.assertEqual(book.meta["lineEnding"], "\r")
            self.assertEqual(list(book.rows("notas")), [["id", "texto"], ["1", "linha 1\nlinha 2"], [], ["2", "x;y"], ["3"]])

    def test_overrides_and_pipe(self):
        path = self.file("pipe.csv", "a|b|c\n1|2|3\n")
        self.assertEqual(self.read(path), [["a", "b", "c"], ["1", "2", "3"]])
        semicolons = self.file("forced.csv", "a;b,c\n1;2,3\n".encode("latin-1"))
        self.assertEqual(self.read(semicolons, separator=",", encoding="latin-1"), [["a;b", "c"], ["1;2", "3"]])
        self.assertEqual(self.read(semicolons, separator="tab", format="tsv"), [["a;b,c"], ["1;2,3"]])
        self.assertFails("invalid", semicolons, separator=";;")
        self.assertFails("invalid", semicolons, encoding="klingon")

    def test_html_disguised_as_spreadsheet(self):
        page = self.file("extrato.xls", "<html><body><table><tr><td>Saldo</td></tr></table></body></html>")
        self.assertIn("HTML", str(self.assertFails("unsupported", page)))

    def test_performance_200k_rows(self):
        line = "{0};Cliente {0} São Paulo;{1},{2:02d};{3:02d}/01/2024;\"obs; {0}\";R$ {1},00\r\n"
        text = "id;cliente;valor;data;obs;total\r\n" + "".join(line.format(i, i % 9000, i % 100, i % 28 + 1) for i in range(200000))
        path = self.file("grande.csv", text.encode("utf-8"))
        started = time.perf_counter()
        with open_workbook(path) as book:
            count = 0
            last = None
            for last in book.rows("grande"):
                count += 1
        elapsed = time.perf_counter() - started
        print(f"\n200,000-row CSV ({path.stat().st_size / 1e6:.1f} MB) read in {elapsed:.2f} s", file=sys.stderr)
        i = 199999
        self.assertEqual((count, last), (200001, [str(i), f"Cliente {i} São Paulo", f"{i % 9000},{i % 100:02d}", f"{i % 28 + 1:02d}/01/2024",
                                                  f"obs; {i}", f"R$ {i % 9000},00"]))
        self.assertLess(elapsed, 30)


# ---------------------------------------------------------------- XLSX

STRINGS = ["Data", "Cliente", "Valor", "Zé", "Conceição",
           '<r><t xml:space="preserve">Olá </t></r><r><rPr><b/><sz val="11"/><color theme="1"/><rFont val="Calibri"/>'
           '<family val="2"/><scheme val="minor"/></rPr><t>mundo</t></r>',
           "linha1_x000D_\nlinha2",
           '<t>東京</t><rPh sb="0" eb="2"><t>トウキョウ</t></rPh><phoneticPr fontId="1"/>',
           "_x005F_x0041_", "Resumo geral", "<t/>"]
VENDAS = (
    '<row r="1" spans="1:14" x14ac:dyDescent="0.25"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c>'
    '<c r="C1" t="s"><v>2</v></c><c r="D1" t="inlineStr"><is><t>Dobro</t></is></c>'
    '<c r="E1" t="inlineStr"><is><r><t>Er</t></r><r><t>ro</t></r></is></c></row>'
    '<row r="2" spans="1:14" x14ac:dyDescent="0.25"><c r="A2" s="1"><v>45306</v></c><c r="B2" t="s"><v>3</v></c>'
    '<c r="C2" s="2"><v>1234.5</v></c><c r="D2" s="2"><f>C2*2</f><v>2469</v></c><c r="E2" t="e"><f>#REF!+1</f><v>#REF!</v></c>'
    '<c r="F2" t="str"><f>B2&amp;"!"</f><v>Zé!</v></c><c r="G2" t="b"><v>1</v></c><c r="H2" s="3"><v>45306.5</v></c>'
    '<c r="I2" s="4"><v>0.75</v></c><c r="J2" s="7"><v>3.5</v></c><c r="K2" s="8"><v>0.15</v></c><c r="L2"><v>42</v></c>'
    '<c r="M2"><v>1E-3</v></c><c r="N2"><f t="shared" ref="N2:N4" si="0">C2+$C$2</f><v>2469</v></c></row>'
    '<row r="3"><c r="A3" s="5"><v>45307</v></c><c r="B3" t="s"><v>4</v></c><c r="C3" s="2"><v>45</v></c>'
    '<c r="D3" t="e"><v>#DIV/0!</v></c><c r="N3"><f t="shared" si="0"/><v>1279.5</v></c></row>'
    '<row><c t="s"><v>5</v></c><c t="s"><v>6</v></c><c s="9"><v>0.5</v></c><c r="N4"><f t="shared" si="0"/><v>1234.5</v></c></row>'
    '<row r="6"><c r="A6" t="s"><v>7</v></c><c r="B6" t="s"><v>8</v></c><c r="C6" s="6"><v>1.5</v></c><c r="D6" t="s"><v>10</v></c></row>'
    '<row r="7"><c r="A7" s="10"><v>1234567</v></c><c r="B7" s="1"/><c r="C7" t="d"><v>2024-02-03T04:05:06</v></c>'
    '<c r="D7" s="1"><v>60</v></c><c r="E7" s="1"><v>61</v></c></row>')
PROTECTION = ('<sheetProtection algorithmName="SHA-512" hashValue="dGVzdA==" saltValue="c2FsdA==" spinCount="100000" '
              'sheet="1" objects="1" scenarios="1"/>')
EXPECTED_VENDAS = [
    ["Data", "Cliente", "Valor", "Dobro", "Erro"],
    [D(2024, 1, 15), "Zé", 1234.5, 2469.0, CellError("#REF!"), "Zé!", True, DT(2024, 1, 15, 12), T(18), 3.5, 0.15, 42, 0.001, 2469],
    [D(2024, 1, 16), "Conceição", 45.0, CellError("#DIV/0!")] + [None] * 9 + [1279.5],
    ["Olá mundo", "linha1\r\nlinha2", T(12)] + [None] * 10 + [1234.5],
    [],
    ["東京", "_x0041_", 1.5],
    [1234567, None, DT(2024, 2, 3, 4, 5, 6), D(1900, 2, 28), D(1900, 3, 1)],
]


def typed(rows):
    return [[(type(value).__name__, value) for value in row] for row in rows]


class XlsxTests(Folder):
    def workbook(self, name="vendas.xlsx", **options):
        sheets = [{"name": "Vendas", "rid": "rId2", "xml": build.worksheet(VENDAS, "A1:N7", '<mergeCells count="2"><mergeCell ref="A9:C9"/>'
                                                                                         '<mergeCell ref="E9:F9"/></mergeCells>')},
                  {"name": "Preços", "rid": "rId7", "target": "/xl/worksheets/precos.xml",
                   "xml": build.worksheet('<row r="1"><c r="A1" t="s"><v>9</v></c><c r="B1"><v>10</v></c></row>', "A1:B1", PROTECTION)},
                  {"name": "Oculta", "rid": "rId3", "state": "hidden", "xml": build.worksheet('<row r="2"><c r="B2"><v>5</v></c></row>', "B2")},
                  {"name": "Escondida", "rid": "rId4", "state": "veryHidden", "xml": build.worksheet("", "A1", sheet_data="<sheetData/>")}]
        return build.xlsx_package(self.folder / name, sheets, build.shared_strings(STRINGS), **options)

    def test_sheets_meta_and_warnings(self):
        path = self.workbook(workbook_extra='<workbookProtection lockStructure="1"/>')
        with open_workbook(path) as book:
            self.assertEqual((book.format, book.sheets), ("xlsx", [SheetInfo("Vendas", False, False, 7, 14), SheetInfo("Preços", False, True, 1, 2),
                                                                   SheetInfo("Oculta", True, False, 2, 2), SheetInfo("Escondida", True, False, 0, 0)]))
            self.assertEqual(book.meta, {"date1904": False, "bytes": path.stat().st_size,
                                         "warnings": ["the workbook structure is protected (editing only)", "merged cells A9:C9, E9:F9 in Vendas",
                                                      "sheet Preços is protected (editing only)"]})

    def test_values_types_and_positions(self):
        path = self.workbook()
        self.assertEqual(typed(self.read(path, "Vendas")), typed(EXPECTED_VENDAS))
        self.assertEqual(self.read(path, "preços"), [["Resumo geral", 10]])
        self.assertEqual(self.read(path, "Oculta"), [[], [None, 5]])
        self.assertEqual(self.read(path, "Escondida"), [])

    def test_formulas_with_shared_ones_translated(self):
        with open_workbook(self.workbook()) as book:
            self.assertEqual(book.formulas("Vendas"), {(2, 4): "C2*2", (2, 5): "#REF!+1", (2, 6): 'B2&"!"', (2, 14): "C2+$C$2",
                                                        (3, 14): "C3+$C$2", (4, 14): "C4+$C$2"})
            self.assertEqual(book.formulas("Preços"), {})

    def test_date1904(self):
        sheet = build.worksheet('<row r="1"><c r="A1" s="1"><v>43844</v></c><c r="B1" s="3"><v>0.5</v></c><c r="C1" s="4"><v>0.25</v></c></row>', "A1:C1")
        path = build.xlsx_package(self.folder / "mac.xlsx", [{"name": "Mac", "xml": sheet}], date1904=True)
        with open_workbook(path) as book:
            self.assertEqual((book.meta["date1904"], list(book.rows("Mac"))), (True, [[D(2024, 1, 15), DT(1904, 1, 1, 12), T(6)]]))

    def test_shift_formula(self):
        text = "SUM(A1:B2)+$C$1+C$1+Plan2!D4+'Minha Aba'!E5+LOG10(A1)+\"A1\"+Tabela[Col1]+COUNT(A:A)+SUM(3:3)+AB1!C1"
        self.assertEqual(shift_formula(text, 1, 2), "SUM(C2:D3)+$C$1+E$1+Plan2!F5+'Minha Aba'!G6+LOG10(C2)+\"A1\"+Tabela[Col1]"
                                                    "+COUNT(C:C)+SUM(4:4)+AB1!E2")
        self.assertEqual(shift_formula("A1+B2", -1, 0), "#REF!+B1")

    def test_number_formats(self):
        cases = {"General": (None, True), "0": (None, True), "#,##0": (None, True), "0.00": (None, False), "0%": (None, False),
                 '"R$"\\ #,##0.00': (None, False), "dd/mm/yyyy": ("date", False), "[$-416]mmmm\\-yy;@": ("date", False),
                 "h:mm AM/PM": ("time", False), "dd/mm/yyyy hh:mm": ("datetime", False), "[h]:mm:ss": ("elapsed", False),
                 '0 "dias"': (None, True), "[Red]#,##0;[Blue]-#,##0": (None, True), "@": (None, True), "mm:ss": ("time", False)}
        self.assertEqual({code: format_info(200, code) for code in cases}, cases)
        self.assertEqual((format_info(14), format_info(31), format_info(46)), (("date", False), ("date", False), ("elapsed", False)))
        self.assertEqual([excel_datetime(1, False, "date"), excel_datetime(0.5, False, "time"), excel_datetime(45306.999999995, False, "datetime"),
                          excel_datetime(-1, False, "date")], [D(1900, 1, 1), T(12), DT(2024, 1, 16), -1])


# ---------------------------------------------------------------- ODS

ODS_STYLES = ('<style:style style:name="co1" style:family="table-column"><style:table-column-properties fo:break-before="auto" '
              'style:column-width="0.889in"/></style:style>'
              '<style:style style:name="ro1" style:family="table-row"><style:table-row-properties style:row-height="0.178in" '
              'fo:break-before="auto" style:use-optimal-row-height="true"/></style:style>'
              '<style:style style:name="ta1" style:family="table" style:master-page-name="Default"><style:table-properties '
              'table:display="true" style:writing-mode="lr-tb"/></style:style>'
              '<style:style style:name="ta2" style:family="table" style:master-page-name="Default"><style:table-properties '
              'table:display="false" style:writing-mode="lr-tb"/></style:style>'
              '<number:date-style style:name="N36" number:automatic-order="true"><number:day number:style="long"/><number:text>/</number:text>'
              '<number:month number:style="long"/><number:text>/</number:text><number:year/></number:date-style>'
              '<style:style style:name="ce1" style:family="table-cell" style:parent-style-name="Default" style:data-style-name="N36"/>')


def text_cell(text, extra=""):
    return f'<table:table-cell office:value-type="string" calcext:value-type="string"{extra}><text:p>{text}</text:p></table:table-cell>'


ODS_TABLES = (
    '<table:table table:name="Vendas" table:style-name="ta1">'
    '<table:table-column table:style-name="co1" table:number-columns-repeated="5" table:default-cell-style-name="Default"/>'
    '<table:table-row table:style-name="ro1">' + text_cell("Data") + text_cell("Cliente") + text_cell("Valor") + text_cell("Hora")
    + '<table:table-cell table:number-columns-repeated="1020"/></table:table-row>'
    '<table:table-row table:style-name="ro1">'
    '<table:table-cell table:style-name="ce1" office:value-type="date" office:date-value="2024-01-15" calcext:value-type="date"><text:p>15/01/2024</text:p></table:table-cell>'
    + text_cell('Zé<text:s text:c="3"/>da<text:s/>Silva')
    + '<table:table-cell office:value-type="currency" office:currency="BRL" office:value="1234.5" calcext:value-type="currency"><text:p>R$ 1.234,50</text:p></table:table-cell>'
    '<table:table-cell office:value-type="time" office:time-value="PT18H30M00S" calcext:value-type="time"><text:p>18:30</text:p></table:table-cell>'
    '<table:table-cell office:value-type="percentage" office:value="0.15" calcext:value-type="percentage"><text:p>15%</text:p></table:table-cell>'
    '<table:table-cell office:value-type="boolean" office:boolean-value="true" calcext:value-type="boolean"><text:p>VERDADEIRO</text:p></table:table-cell>'
    '<table:table-cell table:number-columns-repeated="1018"/></table:table-row>'
    '<table:table-row table:style-name="ro1">'
    '<table:table-cell office:value-type="date" office:date-value="2024-01-16T10:30:15.5" calcext:value-type="date"><text:p>16/01/2024 10:30</text:p></table:table-cell>'
    '<table:table-cell office:value-type="string" calcext:value-type="string"><text:p>linha 1</text:p><text:p>linha <text:span text:style-name="T1">2</text:span>'
    '<text:tab/>fim<text:line-break/><text:a xlink:href="https://exemplo.test/" xlink:type="simple">link</text:a></text:p></table:table-cell>'
    '<table:table-cell office:value-type="currency" office:currency="BRL" office:value="45" calcext:value-type="currency"><text:p>R$ 45,00</text:p></table:table-cell>'
    '<table:table-cell office:value-type="time" office:time-value="PT36H00M00S" calcext:value-type="time"><text:p>36:00:00</text:p></table:table-cell>'
    '<table:table-cell table:formula="of:=1/0" office:value-type="string" office:string-value="" calcext:value-type="error"><text:p>#DIV/0!</text:p></table:table-cell>'
    '<table:table-cell table:formula="of:=[.Z99]+#REF!" office:value-type="string" office:string-value=""><text:p>#REF!</text:p></table:table-cell>'
    '<table:table-cell table:formula="of:=SQRT(-1)"><text:p>Err:502</text:p></table:table-cell>'
    + text_cell("#REF!") + '</table:table-row>'
    '<table:table-row table:style-name="ro1" table:number-rows-repeated="2"><table:table-cell table:number-columns-repeated="1024"/></table:table-row>'
    '<table:table-row table:style-name="ro1" table:number-rows-repeated="2">'
    '<table:table-cell office:value-type="float" office:value="7" table:number-columns-repeated="3" calcext:value-type="float"><text:p>7</text:p></table:table-cell>'
    '<table:table-cell table:number-columns-repeated="2"/>'
    '<table:table-cell table:formula="of:=7*3" office:value-type="float" office:value="21" calcext:value-type="float"><text:p>21</text:p></table:table-cell>'
    '<table:table-cell table:number-columns-repeated="1018"/></table:table-row>'
    '<table:table-row table:style-name="ro1">'
    '<table:table-cell table:number-columns-spanned="2" table:number-rows-spanned="1" office:value-type="string" calcext:value-type="string"><text:p>Mesclado</text:p></table:table-cell>'
    '<table:covered-table-cell office:value-type="string" calcext:value-type="string"><text:p>escondido</text:p></table:covered-table-cell>'
    '<table:table-cell office:value-type="float" office:value="2.5" calcext:value-type="float"><text:p>2,5</text:p></table:table-cell>'
    '<table:table-cell table:formula="of:=IF([.C8]&gt;1;&quot;a;b&quot;;[$Outra.A1])" office:value-type="string" office:string-value="a;b" '
    'calcext:value-type="string"><text:p>a;b</text:p></table:table-cell>'
    '<table:table-cell table:number-columns-repeated="1020"/></table:table-row>'
    '<table:table-row table:style-name="ro1" table:number-rows-repeated="1048567"><table:table-cell table:number-columns-repeated="1024"/></table:table-row>'
    '</table:table>'
    '<table:table table:name="Oculta" table:style-name="ta2" table:protected="true" table:protection-key="dGVzdA==" '
    'table:protection-key-digest-algorithm="http://www.w3.org/2000/09/xmldsig#sha256">'
    '<table:table-column table:number-columns-repeated="1024"/><table:table-row>'
    '<table:table-cell office:value-type="float" office:value="1"><text:p>1</text:p></table:table-cell>'
    '<table:table-cell office:value-type="string"><office:annotation office:display="false"><text:p>nota</text:p></office:annotation>'
    '<text:p>valor</text:p></table:table-cell></table:table-row></table:table>'
    '<table:table table:name="P&amp;D" table:style-name="ta1"><table:table-row><table:table-cell/></table:table-row></table:table>')
EXPECTED_ODS = [
    ["Data", "Cliente", "Valor", "Hora"],
    [D(2024, 1, 15), "Zé   da Silva", 1234.5, T(18, 30), 0.15, True],
    [DT(2024, 1, 16, 10, 30, 15, 500000), "linha 1\nlinha 2\tfim\nlink", 45, 1.5, CellError("#DIV/0!"), CellError("#REF!"),
     CellError("#VALUE!"), "#REF!"],
    [], [],
    [7, 7, 7, None, None, 21], [7, 7, 7, None, None, 21],
    ["Mesclado", None, 2.5, "a;b"],
]


class OdsTests(Folder):
    def workbook(self):
        return build.ods_package(self.folder / "vendas.ods", build.ods_content(ODS_TABLES, ODS_STYLES))

    def test_sheets_and_warnings(self):
        path = self.workbook()
        with open_workbook(path) as book:
            self.assertEqual((book.format, book.sheets), ("ods", [SheetInfo("Vendas", False, False, None, None), SheetInfo("Oculta", True, True, None, None),
                                                                  SheetInfo("P&D", False, False, None, None)]))
            self.assertEqual(book.meta, {"date1904": False, "bytes": path.stat().st_size,
                                         "warnings": ["merged cells in Vendas (1 range)", "sheet Oculta is protected (editing only)"]})

    def test_values_with_repeats_and_huge_trailing_rows(self):
        path = self.workbook()
        started = time.perf_counter()
        self.assertEqual(typed(self.read(path, "Vendas")), typed(EXPECTED_ODS))
        self.assertLess(time.perf_counter() - started, 2)
        self.assertEqual(self.read(path, "Oculta"), [[1, "valor"]])
        self.assertEqual(self.read(path, "P&D"), [])

    def test_formulas(self):
        with open_workbook(self.workbook()) as book:
            self.assertEqual(book.formulas("Vendas"), {(3, 5): "1/0", (3, 6): "Z99+#REF!", (3, 7): "SQRT(-1)", (6, 6): "7*3", (7, 6): "7*3",
                                                        (8, 4): 'IF(C8>1,"a;b",Outra!A1)'})
        self.assertEqual(odf_formula("of:=SUM([Plan2.A1:Plan2.B2];[.$C$3])"), "SUM(Plan2!A1:B2,$C$3)")

    def test_encrypted_ods(self):
        content = build.ods_content(ODS_TABLES, ODS_STYLES)
        path = build.ods_package(self.folder / "senha.ods", content, '<manifest:encryption-data manifest:checksum-type="SHA1/1K"/>')
        self.assertFails("encrypted", path)


# ---------------------------------------------------------------- XLS

SST_ITEMS = ["Zé", "Conceição", "Relatório anual – região Sul e Sudeste do Brasil", ("Negrito e normal", 2, b""),
             ("Tóquio", 0, b"\x01\x00\x02\x00" + b"\x07" * 14), "Zé" * 30, "Ação", "x"]
XF_FORMATS = [0] * 16 + [14, 164, 165, 20, 2, 3]
FORMATS = [(164, "dd/mm/yyyy hh:mm"), (165, '"R$" #,##0.00')]
EXPECTED_DADOS = [
    ["Zé", "Conceição", "Rótulo – direto"],
    [1234.5, 42, 123.45, 1.5, 12.5, -7],
    [D(2024, 1, 15), T(18), 45.0],
    [True, CellError("#DIV/0!"), CellError("#N/A"), None, 2469, "calculado"],
    [],
    [True, CellError("#REF!"), None, DT(2024, 1, 15, 12), SST_ITEMS[2], "Negrito e normal", "Tóquio", "Zé" * 30, "Ação"],
]


def xls_stream(**options):
    b = build
    dados = (b.dimension(6, 9) + b.labelsst(0, 0, 15, 0) + b.labelsst(0, 1, 15, 1) + b.label(0, 2, 15, "Rótulo – direto")
             + b.number(1, 0, 15, 1234.5) + b.rk(1, 1, 15, b.rk_int(42)) + b.rk(1, 2, 15, b.rk_int(12345, True))
             + b.rk(1, 3, 15, b.rk_float(1.5)) + b.rk(1, 4, 15, b.rk_float(1250.0, True)) + b.rk(1, 5, 21, b.rk_int(-7))
             + b.mulrk(2, 0, [(16, b.rk_int(45306)), (19, b.rk_float(0.75)), (18, b.rk_int(45))])
             + b.bof(0x0020) + b.number(9, 0, 15, 99.0) + b.eof()
             + b.boolerr(3, 0, 15, 1) + b.boolerr(3, 1, 15, 0x07, True) + b.boolerr(3, 2, 15, 0x2A, True) + b.blank(3, 3, 15)
             + b.formula(3, 4, 15, b.result_number(2469.0)) + b.formula(3, 5, 15, b.result_string()) + b.string("calculado")
             + b.formula(5, 0, 15, b.result_bool(True)) + b.formula(5, 1, 15, b.result_error(0x17)) + b.formula(5, 2, 15, b.result_empty())
             + b.number(5, 3, 17, 45306.5) + b.labelsst(5, 4, 15, 2) + b.labelsst(5, 5, 15, 3) + b.labelsst(5, 6, 15, 4)
             + b.labelsst(5, 7, 15, 5) + b.labelsst(5, 8, 15, 6) + b.merged((0, 0, 0, 1)))
    protegida = b.protect() + b.dimension(1, 1) + b.number(0, 0, 15, 1.0)
    desordem = b.dimension(3, 2) + b.label(2, 0, 15, "c") + b.label(0, 0, 15, "a") + b.label(1, 1, 15, "b")
    grande = b.dimension(600, 2) + b"".join(b.number(i, 0, 15, float(i)) + b.label(i, 1, 15, f"linha {i}") for i in range(600))
    sheets = [("Dados", 0, 0, dados), ("Protegida", 1, 0, protegida), ("Gráfico", 0, 2, b""), ("Desordem", 0, 0, desordem),
              ("Grande", 0, 0, grande)]
    return b.workbook_stream(sheets, SST_ITEMS, FORMATS, XF_FORMATS, sst_limit=40, **options)


class XlsTests(Folder):
    def check(self, path):
        with open_workbook(path) as book:
            self.assertEqual((book.format, book.sheets), ("xls", [SheetInfo("Dados", False, False, 6, 9), SheetInfo("Protegida", True, True, 1, 1),
                                                                  SheetInfo("Gráfico", False, False, 0, 0), SheetInfo("Desordem", False, False, 3, 2),
                                                                  SheetInfo("Grande", False, False, 600, 2)]))
            self.assertEqual(book.meta, {"date1904": False, "bytes": path.stat().st_size, "warnings": [
                "Gráfico is a chart sheet; it has no cells", "merged cells A1:B1 in Dados", "sheet Protegida is protected (editing only)",
                "formula text is not available for .xls files; cells hold the values Excel saved"]})
            self.assertEqual(typed(list(book.rows("Dados"))), typed(EXPECTED_DADOS))
            self.assertEqual(list(book.rows("Protegida")), [[1]])
            self.assertEqual(list(book.rows("Gráfico")), [])
            self.assertEqual(list(book.rows("Desordem")), [["a"], [None, "b"], ["c"]])
            grande = list(book.rows("Grande"))
            self.assertEqual((len(grande), grande[0], grande[599]), (600, [0, "linha 0"], [599, "linha 599"]))
            self.assertEqual(book.formulas("Dados"), {})

    def test_biff8_in_512_byte_sectors(self):
        stream = xls_stream()
        self.assertGreater(len(stream), 4096)
        self.check(self.file("antigo.xls", build.cfb_bytes([("Workbook", stream), ("\x05SummaryInformation", b"\0" * 200)])))

    def test_biff8_in_4096_byte_sectors(self):
        self.check(self.file("antigo4k.xls", build.cfb_bytes([("\x05DocumentSummaryInformation", b"\0" * 300), ("Workbook", xls_stream())],
                                                             sector_shift=12)))

    def test_datemode_1904(self):
        body = build.dimension(1, 2) + build.number(0, 0, 16, 43844.0) + build.rk(0, 1, 17, build.rk_int(1))
        stream = build.workbook_stream([("Mac", 0, 0, body)], (), FORMATS, XF_FORMATS, date1904=True)
        with open_workbook(self.file("mac.xls", build.cfb_bytes([("Workbook", stream)]))) as book:
            self.assertEqual((book.meta["date1904"], list(book.rows("Mac"))), (True, [[D(2024, 1, 15), DT(1904, 1, 2)]]))

    def test_filepass_and_biff5(self):
        self.assertIn("password", str(self.assertFails("encrypted", self.file("senha.xls", build.cfb_bytes([("Workbook", xls_stream(filepass=True))])))))
        old = build.bof(0x0005)[:4] + b"\x00\x05" + build.bof(0x0005)[6:] + build.eof()
        self.assertIn("5/95", str(self.assertFails("unsupported", self.file("velho.xls", build.cfb_bytes([("Book", old)])))))

    def test_segments_switch_encoding_at_continue(self):
        first = b"\x0a\x00\x0c" + b"\x02\x00" + b"\x04\x00\x00\x00" + b"abcde"
        second = b"\x01" + "fgh–j".encode("utf-16-le") + b"\x00\x00\x01\x00\x02"
        third = b"\x00\x01\x00" + b"\x09\x09\x09\x09" + b"\x02\x00\x00ok"
        reader = xls._Segments([first, second, third])
        self.assertEqual((reader.string(), reader.string()), ("abcdefgh–j", "ok"))
        self.assertEqual([xls.decode_rk(build.rk_int(-7)), xls.decode_rk(build.rk_int(12345, True)), xls.decode_rk(build.rk_float(1250.0, True)),
                          xls.decode_rk(build.rk_float(1.5))], [-7, 123.45, 12.5, 1.5])


# ---------------------------------------------------------------- OLE2, encryption, detection and damage

class ContainerTests(Folder):
    def test_cfb_with_extra_difat_sectors_and_mini_stream(self):
        big = bytes(range(256)) * 30000
        data = build.cfb_bytes([("Grande", big), ("Pequeno", b"ol\xc3\xa1" * 10)])
        self.assertGreater(struct.unpack_from("<I", data, 72)[0], 0)
        with cfb.CompoundFile(self.file("difat.bin", data)) as compound:
            self.assertEqual((compound.names(), compound.read("Grande") == big, compound.read("pequeno")), (["Grande", "Pequeno"], True, b"ol\xc3\xa1" * 10))

    def test_cfb_loop_is_an_error_not_a_hang(self):
        path = self.file("loop.bin", build.cfb_bytes([("Workbook", b"\x09" * 10000)], loop=True))
        started = time.perf_counter()
        with cfb.CompoundFile(path) as compound:
            with self.assertRaises(SheetFormatError) as caught:
                compound.read("Workbook")
        self.assertEqual(caught.exception.kind, "corrupt")
        self.assertLess(time.perf_counter() - started, 1)
        self.assertFails("corrupt", path)

    def test_password_protected_xlsx(self):
        data = build.cfb_bytes([("EncryptionInfo", b"\x04\x00\x04\x00\x40\x00\x00\x00" + b"\0" * 200),
                                ("EncryptedPackage", b"\x00\x10\x00\x00\x00\x00\x00\x00" + bytes(range(256)) * 20)])
        path = self.file("senha.xlsx", data)
        error = self.assertFails("encrypted", path)
        self.assertEqual(str(error), "The file is protected by a password to open. Ask the user to open it in Excel, save a copy without "
                                     "the password and try again; never ask for the password.")
        self.assertFails("encrypted", path, format="xlsx")

    def test_detection_errors(self):
        self.assertFails("empty", self.file("vazio.csv", b""))
        self.assertFails("unsupported", self.file("lixo.bin", random.Random(5).randbytes(4096)))
        self.assertFails("corrupt", self.file("quebrado.xlsx", b"PK\x03\x04" + b"\x00" * 200))
        whole = (XlsxTests.workbook(self, "inteiro.xlsx")).read_bytes()
        self.assertFails("corrupt", self.file("cortado.xlsx", whole[:len(whole) * 2 // 3]))
        self.assertFails("not_found", self.folder / "nao_existe.csv")
        word = build.write_zip(self.folder / "carta.docx", [("[Content_Types].xml", "<Types/>"), ("word/document.xml", "<w:document/>")])
        self.assertIn("Word", str(self.assertFails("unsupported", word)))
        self.assertFails("unsupported", self.file("texto.csv", "a;b\n"), format="xlsx")
        self.assertFails("invalid", self.file("ok.csv", "a;b\n"), format="xlsb")
        with open_workbook(self.file("ok2.csv", "a;b\n")) as book:
            with self.assertRaises(SheetFormatError) as caught:
                book.rows("Outra")
            self.assertEqual(caught.exception.kind, "sheet")

    def test_bad_xml_and_billion_laughs(self):
        sheet = build.worksheet('<row r="1"><c r="A1" t="s"><v>0</v></c></row>', "A1")
        laughs = ('<?xml version="1.0"?>\n<!DOCTYPE lolz [<!ENTITY lol "lol">'
                  + "".join(f'<!ENTITY lol{i} "{("&lol" + str(i - 1 if i > 1 else "") + ";") * 10}">' for i in range(1, 10))
                  + f']>\n<sst xmlns="{build.MAIN}"><si><t>&lol9;</t></si></sst>')
        path = build.xlsx_package(self.folder / "risos.xlsx", [{"name": "A", "xml": sheet}], laughs)
        self.assertIn("DTD", str(self.assertFails("corrupt", path)))
        ods = build.ods_package(self.folder / "risos.ods", build.ods_content("").replace("?>\n", '?>\n<!DOCTYPE x [<!ENTITY a "aaaa">]>\n', 1))
        self.assertFails("corrupt", ods)
        broken = build.xlsx_package(self.folder / "xml.xlsx", [{"name": "A", "xml": sheet.replace("</sheetData>", "")}], build.shared_strings(["a"]))
        self.assertFails("corrupt", broken)

    def test_cancelled(self):
        stop = []
        text = "a;b\n" + "".join(f"{i};{i}\n" for i in range(5000))
        csv_path = self.file("muitas.csv", text)
        self.assertFails("cancelled", csv_path, cancelled=lambda: True)
        with open_workbook(csv_path, cancelled=lambda: bool(stop)) as book:
            rows = book.rows("muitas")
            next(rows)
            stop.append(True)
            with self.assertRaises(SheetFormatError) as caught:
                list(rows)
            self.assertEqual(caught.exception.kind, "cancelled")
        stop.clear()
        xlsx_path = self.folder / "muitas.xlsx"
        write_xlsx(xlsx_path, [{"name": "Dados", "columns": [{"name": "n", "type": "integer"}], "rows": ([i] for i in range(5000))}])
        with open_workbook(xlsx_path, cancelled=lambda: bool(stop)) as book:
            stop.append(True)
            with self.assertRaises(SheetFormatError) as caught:
                list(book.rows("Dados"))
            self.assertEqual(caught.exception.kind, "cancelled")


# ---------------------------------------------------------------- XLSX writer

class WriterTests(Folder):
    COLUMNS = [{"name": "Texto", "type": "text"}, {"name": "Número", "type": "number"}, {"name": "Inteiro", "type": "integer"},
               {"name": "Valor", "type": "currency"}, {"name": "Taxa", "type": "percent"}, {"name": "Dia", "type": "date"},
               {"name": "Quando", "type": "datetime"}, {"name": "Hora", "type": "time"}, {"name": "Pago", "type": "bool"}]
    ROWS = [["Zé", 1234.5, 42, 45.0, 0.15, D(2024, 1, 15), DT(2024, 1, 15, 10, 30), T(18, 30), True],
            [" com espaço ", -0.25, -7, 1234.56, 1.0, D(1900, 1, 1), DT(2024, 2, 29, 23, 59, 59), T(0, 0, 1), False],
            ["linha1\nlinha2_x000D_ & <tag> \x01", None, None, None, None, None, None, None, None],
            [],
            ["Conceição", 3, 5, 10, 0.5, D(1899, 12, 31), None, None, None, "extra"]]

    def test_round_trip_every_column_type(self):
        path = self.folder / "export.xlsx"
        written = write_xlsx(path, [{"name": "Vendas/2024", "columns": self.COLUMNS, "rows": (row for row in self.ROWS)},
                                    {"name": "Vendas/2024", "columns": [], "rows": [["a"]]},
                                    {"name": "x" * 40, "columns": [{"name": "A", "type": "text"}], "rows": []},
                                    {"name": "Longa", "columns": [{"name": "n", "type": "integer"}], "rows": ([i, f"v{i}"] for i in range(20000))}])
        self.assertEqual(written, [{"name": "Vendas_2024", "rows": 5}, {"name": "Vendas_2024 (2)", "rows": 1}, {"name": "x" * 31, "rows": 0},
                                   {"name": "Longa", "rows": 20000}])
        self.assertEqual(sorted(p.name for p in self.folder.iterdir()), ["export.xlsx"])
        with open_workbook(path) as book:
            self.assertEqual(book.sheets, [SheetInfo("Vendas_2024", False, False, 6, 10), SheetInfo("Vendas_2024 (2)", False, False, 1, 1),
                                           SheetInfo("x" * 31, False, False, 1, 1), SheetInfo("Longa", False, False, 20001, 2)])
            self.assertEqual(typed(list(book.rows("Vendas_2024"))), typed([
                [c["name"] for c in self.COLUMNS],
                ["Zé", 1234.5, 42, 45.0, 0.15, D(2024, 1, 15), DT(2024, 1, 15, 10, 30), T(18, 30), True],
                [" com espaço ", -0.25, -7, 1234.56, 1.0, D(1900, 1, 1), DT(2024, 2, 29, 23, 59, 59), T(0, 0, 1), False],
                ["linha1\nlinha2_x000D_ & <tag> "],
                [],
                ["Conceição", 3.0, 5, 10.0, 0.5, "1899-12-31", None, None, None, "extra"]]))
            self.assertEqual((list(book.rows(1)), list(book.rows(2))), ([["a"]], [["A"]]))
            longa = list(book.rows("Longa"))
            self.assertEqual((len(longa), longa[-1]), (20001, [19999, "v19999"]))
        with zipfile.ZipFile(path) as archive:
            for name in archive.namelist():
                ElementTree.fromstring(archive.read(name))
            sheet = archive.read("xl/worksheets/sheet1.xml").decode("utf-8")
            workbook = archive.read("xl/workbook.xml").decode("utf-8")
        for part in ('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>', '<autoFilter ref="A1:I6"/>',
                     '<dimension ref="A1:J6"/>', '<c r="A1" s="1" t="s">', "<cols>"):
            self.assertIn(part, sheet)
        self.assertIn("'Vendas_2024'!$A$1:$I$6</definedName>", workbook)

    def test_rejects_unknown_type_and_keeps_target(self):
        path = self.file("antigo.xlsx", b"original")
        with self.assertRaises(ValueError):
            write_xlsx(path, [{"name": "A", "columns": [{"name": "x", "type": "money"}], "rows": []}])
        self.assertEqual((path.read_bytes(), sorted(p.name for p in self.folder.iterdir())), (b"original", ["antigo.xlsx"]))


if __name__ == "__main__":
    unittest.main()
