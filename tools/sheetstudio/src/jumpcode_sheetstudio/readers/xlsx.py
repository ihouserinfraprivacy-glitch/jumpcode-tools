# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""XLSX (Office Open XML) reader. Sheet order, names and state come from workbook.xml and its relationships;
cells stream from each sheet's XML; shared strings and styles (to tell dates from numbers) are loaded once.
Formulas come from <f> (shared formulas are translated to each cell)."""

import collections
import datetime
import posixpath
import re
import urllib.parse
import xml.etree.ElementTree as ElementTree

from .common import (CANCEL_EVERY, FORMULA_CAP, GENERAL, MAX_COLS, MAX_ROWS, XML_CHUNK, CellError, SheetInfo, Workbook,
                     column_index, column_letter, convert_number, corrupt, format_info, iter_xml, local, merged_warning,
                     namespace, parse_xml, place, protected_warning, raise_if_cancelled, refuse_dtd, unsupported)

_X_ESCAPE = re.compile(r"_x(?P<code>[0-9A-Fa-f]{4})_")
_DIGITS = "0123456789"
_SCAN_CHUNK = 1 << 20
_HEAD_LIMIT = 16 * 1024 * 1024
_TAIL_LIMIT = 32 * 1024 * 1024
_SHEET_DATA_OPEN = re.compile(rb"<(?:[\w.-]+:)?sheetData\b(?P<attrs>[^>]*)>")
_SHEET_DATA_CLOSE = re.compile(rb"</(?:[\w.-]+:)?sheetData\s*>")
_DIMENSION = re.compile(rb"<(?:[\w.-]+:)?dimension\b[^>]*?\bref\s*=\s*[\"'](?P<ref>[^\"']*)[\"']")
_PROTECTION = re.compile(rb"<(?:[\w.-]+:)?sheetProtection\b(?P<attrs>[^>]*)>")
_PROTECTED = re.compile(rb"(?:^|\s)sheet\s*=\s*[\"'](?:1|true)[\"']")
_MERGE = re.compile(rb"<(?:[\w.-]+:)?mergeCell\b[^>]*?\bref\s*=\s*[\"'](?P<ref>[^\"']*)[\"']")
_REF = re.compile(r"\$?(?P<col>[A-Za-z]{1,3})\$?(?P<row>\d+)")
_FORMULA_TOKEN = re.compile(r"""
      (?P<string>"(?:[^"]|"")*")
    | (?P<quoted>'(?:[^']|'')*')
    | (?P<bracket>\[[^\]]*\])
    | (?<![\w.$])(?P<colsabs1>\$?)(?P<cols1>[A-Za-z]{1,3}):(?P<colsabs2>\$?)(?P<cols2>[A-Za-z]{1,3})(?![\w(])
    | (?<![\w.$:])(?P<rowsabs1>\$?)(?P<rows1>\d+):(?P<rowsabs2>\$?)(?P<rows2>\d+)(?![\w(.])
    | (?<![\w.$])(?P<colabs>\$?)(?P<col>[A-Za-z]{1,3})(?P<rowabs>\$?)(?P<row>\d+)(?![\w(!.])
""", re.VERBOSE)


def unescape(text):
    """ST_Xstring escapes: _x000D_ is a carriage return, _x005F_ a literal underscore."""
    if "_x" not in text:
        return text
    return _X_ESCAPE.sub(lambda match: chr(int(match.group("code"), 16)), text)


def office_document(package):
    """The workbook part named by _rels/.rels, or None."""
    if not package.find("_rels/.rels"):
        return None
    for relation in parse_xml(package.read("_rels/.rels")):
        if local(relation.tag) == "Relationship" and (relation.get("Type") or "").endswith("/officeDocument"):
            return _resolve("", relation.get("Target") or "")
    return None


def _resolve(folder, target):
    target = urllib.parse.unquote(target.replace("\\", "/"))
    path = target.lstrip("/") if target.startswith("/") else posixpath.join(folder, target)
    path = posixpath.normpath(path) if path else ""
    if not path or path == "." or path.startswith("../") or path == "..":
        return None
    return path


class _Names:
    """Tag names in the namespace a part uses (transitional or strict OOXML)."""

    def __init__(self, root_tag):
        ns = namespace(root_tag)
        for name in ("sheetData", "row", "c", "v", "f", "is", "t", "r", "si"):
            setattr(self, "inline" if name == "is" else name, ns + name)


def shift_formula(text, rows, cols):
    """A shared formula's text moved by rows/cols: relative A1 references shift, $-anchored parts stay."""

    def shift(value, delta, anchored, limit):
        if anchored:
            return value
        value += delta
        return value if 1 <= value <= limit else None

    def replace(match):
        if match.group("col") is not None:
            col, row = column_index(match.group("col")), int(match.group("row"))
            if col > MAX_COLS or row > MAX_ROWS:
                return match.group(0)
            col, row = shift(col, cols, match.group("colabs"), MAX_COLS), shift(row, rows, match.group("rowabs"), MAX_ROWS)
            if col is None or row is None:
                return "#REF!"
            return f"{match.group('colabs')}{column_letter(col)}{match.group('rowabs')}{row}"
        if match.group("cols1") is not None:
            first, last = column_index(match.group("cols1")), column_index(match.group("cols2"))
            if first > MAX_COLS or last > MAX_COLS:
                return match.group(0)
            first = shift(first, cols, match.group("colsabs1"), MAX_COLS)
            last = shift(last, cols, match.group("colsabs2"), MAX_COLS)
            if first is None or last is None:
                return "#REF!"
            return f"{match.group('colsabs1')}{column_letter(first)}:{match.group('colsabs2')}{column_letter(last)}"
        if match.group("rows1") is not None:
            first = shift(int(match.group("rows1")), rows, match.group("rowsabs1"), MAX_ROWS)
            last = shift(int(match.group("rows2")), rows, match.group("rowsabs2"), MAX_ROWS)
            if first is None or last is None:
                return "#REF!"
            return f"{match.group('rowsabs1')}{first}:{match.group('rowsabs2')}{last}"
        return match.group(0)

    return _FORMULA_TOKEN.sub(replace, text)


def _iso_value(text):
    text = text.strip()
    try:
        if "T" in text or " " in text:
            return datetime.datetime.fromisoformat(text).replace(tzinfo=None)
        if ":" in text:
            return datetime.time.fromisoformat(text)
        return datetime.date.fromisoformat(text)
    except ValueError:
        return text or None


def _string_item(node, names):
    """The text of an <si> or <is>: plain <t>, or the <t> of each rich-text run; phonetic runs are left out."""
    parts = []
    for child in node:
        tag = child.tag
        if tag == names.t:
            parts.append(child.text or "")
        elif tag == names.r:
            for text in child.iter(names.t):
                parts.append(text.text or "")
    return unescape("".join(parts))


class XlsxWorkbook(Workbook):
    format = "xlsx"

    def __init__(self, path, package, cancelled=None, size=None):
        super().__init__(cancelled)
        self._package = package
        self._strings = []
        self._styles = []
        self._parts = []
        self._date1904 = False
        self._load(size)

    def _release(self):
        self._package.close()

    # ------------------------------------------------------------ opening
    def _load(self, size):
        package = self._package
        workbook = office_document(package) or "xl/workbook.xml"
        if workbook.lower().endswith(".bin"):
            raise unsupported("This is a binary Excel workbook (.xlsb). Ask the user to open it in Excel and save it "
                              "as .xlsx, then open that file.")
        if not package.find(workbook):
            raise corrupt("the workbook part is missing")
        relations = self._relationships(workbook)
        root = parse_xml(package.read(workbook))
        ns = namespace(root.tag)
        properties = root.find(ns + "workbookPr")
        if properties is not None:
            self._date1904 = (properties.get("date1904") or "").lower() in ("1", "true")
        if root.find(ns + "workbookProtection") is not None:
            self.warn("the workbook structure is protected (editing only)")
        for kind, target in relations.values():
            if kind.endswith("/sharedStrings") and package.find(target):
                self._strings = self._load_strings(target)
            elif kind.endswith("/styles") and package.find(target):
                self._styles = self._load_styles(target)
            elif kind.endswith("/externalLink"):
                self.warn("the workbook links to other files; linked cells show the values saved in this file")
        if not self._strings and package.find("xl/sharedStrings.xml") and not any(
                kind.endswith("/sharedStrings") for kind, _ in relations.values()):
            self._strings = self._load_strings("xl/sharedStrings.xml")
        if any(name.endswith("vbaproject.bin") for name in package.names):
            self.warn("the workbook has macros; they are not run")
        sheets = root.find(ns + "sheets")
        for sheet in (sheets if sheets is not None else ()):
            if local(sheet.tag) != "sheet":
                continue
            name = sheet.get("name") or f"Sheet{len(self.sheets) + 1}"
            hidden = (sheet.get("state") or "visible") in ("hidden", "veryHidden")
            relation = next((value for key, value in sheet.attrib.items() if key.endswith("}id")), None)
            kind, target = relations.get(relation, ("", None))
            if kind.endswith("/chartsheet"):
                self.warn(f"{name} is a chart sheet; it has no cells")
                self._add(name, hidden, False, 0, 0, None)
                continue
            if not target or not package.find(target):
                self.warn(f"the sheet {name} has no data in the file")
                self._add(name, hidden, False, 0, 0, None)
                continue
            info = self._scan(target)
            if info["protected"]:
                self.warn(protected_warning(name))
            if info["merges"]:
                self.warn(merged_warning(name, info["merges"]))
            self._add(name, hidden, info["protected"], info["rows"], info["cols"], target)
        self.meta.update({"date1904": self._date1904, "bytes": size})

    def _add(self, name, hidden, protected, rows, cols, part):
        self.sheets.append(SheetInfo(name, hidden, protected, rows, cols))
        self._parts.append(part)

    def _relationships(self, part):
        folder, base = posixpath.split(part)
        name = posixpath.join(folder, "_rels", base + ".rels")
        if not self._package.find(name):
            return {}
        result = {}
        for relation in parse_xml(self._package.read(name)):
            if local(relation.tag) != "Relationship" or relation.get("TargetMode") == "External":
                continue
            target = _resolve(folder, relation.get("Target") or "")
            if target:
                result[relation.get("Id")] = (relation.get("Type") or "", target)
        return result

    def _load_strings(self, part):
        strings = []
        root = names = None
        with self._package.open(part) as stream:
            for event, element in iter_xml(stream, self._cancelled):
                if event == "start":
                    if root is None:
                        root, names = element, _Names(element.tag)
                    continue
                if element.tag == names.si:
                    strings.append(_string_item(element, names))
                    del root[:]
        return strings

    def _load_styles(self, part):
        root = parse_xml(self._package.read(part))
        ns = namespace(root.tag)
        codes = {}
        formats = root.find(ns + "numFmts")
        for item in (formats if formats is not None else ()):
            try:
                codes[int(item.get("numFmtId"))] = item.get("formatCode") or "General"
            except (TypeError, ValueError):
                continue
        styles = []
        cells = root.find(ns + "cellXfs")
        for xf in (cells if cells is not None else ()):
            try:
                number = int(xf.get("numFmtId") or 0)
            except ValueError:
                number = 0
            styles.append(format_info(number, codes.get(number)))
        return styles

    def _scan(self, part):
        """Dimension, protection and merged ranges, found in the raw bytes before and after <sheetData>."""
        info = {"rows": None, "cols": None, "protected": False, "merges": []}
        head = bytearray()
        tail = bytearray()
        carry = b""
        state = "head"
        with self._package.open(part) as stream:
            while state != "done":
                raise_if_cancelled(self._cancelled)
                chunk = stream.read(_SCAN_CHUNK)
                if not chunk:
                    break
                if state == "head":
                    head += chunk
                    match = _SHEET_DATA_OPEN.search(head)
                    if match is None:
                        if len(head) > _HEAD_LIMIT:
                            # No <sheetData> in the first 16 MB: give up on the dimension, keep looking for the end.
                            refuse_dtd(head[:4096])
                            state, carry, head = "data", bytes(head[-64:]), bytearray()
                        continue
                    refuse_dtd(head[:match.start()])
                    if match.group("attrs").rstrip().endswith(b"/"):
                        info["rows"] = info["cols"] = 0
                        state = "tail"
                    else:
                        dimension = _DIMENSION.search(head, 0, match.start())
                        cell = dimension and _REF.fullmatch(dimension.group("ref").decode("ascii", "replace").split(":")[-1].strip())
                        if cell:
                            info["rows"], info["cols"] = int(cell.group("row")), column_index(cell.group("col"))
                        state = "data"
                    chunk, head = bytes(head[match.end():]), bytearray()
                if state == "data":
                    window = carry + chunk
                    match = _SHEET_DATA_CLOSE.search(window)
                    if match is None:
                        carry = window[-64:]
                        continue
                    state, chunk = "tail", window[match.end():]
                if state == "tail":
                    tail += chunk
                    if len(tail) > _TAIL_LIMIT:
                        state = "done"
        if state == "head":
            refuse_dtd(head[:4096])
        protection = _PROTECTION.search(tail)
        info["protected"] = bool(protection and _PROTECTED.search(protection.group("attrs")))
        info["merges"] = [match.group("ref").decode("utf-8", "replace") for match in _MERGE.finditer(tail)]
        return info

    # ------------------------------------------------------------ rows
    def _row_elements(self, part):
        """(row number, <row> element, names) in order. Only 'start' events are asked for: after each chunk, every
        <row> of <sheetData> but the last is complete (a later sibling started), so they are taken in bulk and
        detached, which keeps memory flat and the per-element Python work low."""
        stream = self._package.open(part)
        parser = ElementTree.XMLPullParser(("start",))
        names = sheet_data = None
        expected = 1
        tail = b""
        try:
            while True:
                raise_if_cancelled(self._cancelled)
                chunk = stream.read(XML_CHUNK)
                if chunk:
                    if names is None:
                        window = tail + chunk
                        refuse_dtd(window)
                        tail = window[-32:]
                    parser.feed(chunk)
                else:
                    parser.close()
                if sheet_data is None:
                    for _, element in parser.read_events():
                        if names is None:
                            names = _Names(element.tag)
                        elif element.tag == names.sheetData:
                            sheet_data = element
                            break
                collections.deque(parser.read_events(), maxlen=0)
                if sheet_data is not None:
                    complete = len(sheet_data) - 1 if chunk else len(sheet_data)
                    if complete > 0:
                        rows = sheet_data[:complete]
                        del sheet_data[:complete]
                        for row in rows:
                            if row.tag != names.row:
                                continue
                            number = row.get("r")
                            number = int(number) if number and number.isdigit() else expected
                            if number < expected:
                                number = expected
                            yield number, row, names
                            expected = number + 1
                if not chunk:
                    return
        except ElementTree.ParseError as error:
            raise corrupt(f"invalid XML: {error}") from None
        finally:
            stream.close()

    def _rows(self, index):
        part = self._parts[index]
        if part is None:
            return
        expected = 1
        for number, row, names in self._row_elements(part):
            while expected < number:
                yield []
                expected += 1
                if expected % CANCEL_EVERY == 0:
                    raise_if_cancelled(self._cancelled)
            yield self._values(row, names)
            expected = number + 1

    def _values(self, row, names):
        values = []
        col = 0
        cell_tag = names.c
        for cell in row:
            if cell.tag != cell_tag:
                continue
            ref = cell.get("r")
            if ref:
                letters = ref.rstrip(_DIGITS)
                col = column_index(letters) if letters else col + 1
            else:
                col += 1
            value = self._cell(cell, names)
            if value is not None:
                if col == len(values) + 1:
                    values.append(value)
                else:
                    place(values, col, value)
        return values

    def _cell(self, cell, names):
        kind = cell.get("t")
        if kind is None or kind == "n":
            text = cell.findtext(names.v)
            if not text:
                return None
            try:
                number = int(text)
            except ValueError:
                try:
                    number = float(text)
                except ValueError:
                    return text.strip() or None
            style = cell.get("s")
            info = GENERAL
            if style:
                try:
                    info = self._styles[int(style)]
                except (IndexError, ValueError):
                    info = GENERAL
            return convert_number(number, info, self._date1904)
        if kind == "s":
            try:
                return self._strings[int(cell.findtext(names.v))] or None
            except (TypeError, ValueError, IndexError):
                return None
        if kind == "inlineStr":
            node = cell.find(names.inline)
            if node is None:
                return unescape(cell.findtext(names.v) or "") or None
            return _string_item(node, names) or None
        if kind == "str":
            return unescape(cell.findtext(names.v) or "") or None
        if kind == "b":
            text = (cell.findtext(names.v) or "").strip().lower()
            return None if not text else text in ("1", "true")
        if kind == "e":
            text = (cell.findtext(names.v) or "").strip()
            return CellError(text) if text else None
        if kind == "d":
            return _iso_value(cell.findtext(names.v) or "")
        return cell.findtext(names.v) or None

    # ------------------------------------------------------------ formulas
    def _formulas(self, index):
        part = self._parts[index]
        result = {}
        if part is None:
            return result
        masters = {}
        rows = self._row_elements(part)
        try:
            for number, row, names in rows:
                col = 0
                for cell in row:
                    if cell.tag != names.c:
                        continue
                    ref = cell.get("r")
                    letters = ref.rstrip(_DIGITS) if ref else ""
                    col = column_index(letters) if letters else col + 1
                    formula = cell.find(names.f)
                    if formula is None:
                        continue
                    text = formula.text
                    if formula.get("t") == "shared":
                        group = formula.get("si")
                        if text:
                            masters[group] = (number, col, text)
                        elif group in masters:
                            first_row, first_col, master = masters[group]
                            text = shift_formula(master, number - first_row, col - first_col)
                    if text:
                        result[(number, col)] = text
                        if len(result) >= FORMULA_CAP:
                            self.warn(f"only the first {FORMULA_CAP} formulas of {self.sheets[index].name} were read")
                            return result
        finally:
            rows.close()
        return result
