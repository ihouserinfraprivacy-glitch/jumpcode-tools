# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""ODS (OpenDocument spreadsheet) reader. Sheet names, protection, hidden state and merged cells come from a fast
scan of content.xml; rows stream from it with repeated rows and columns expanded, except the trailing empty ones
that office suites repeat up to the last row and column of the grid."""

import datetime
import html
import re

from .common import (CANCEL_EVERY, ENCRYPTED_MESSAGE, ERROR_CODES, FORMULA_CAP, MAX_COLS, MAX_ROWS, CellError,
                     SheetFormatError, SheetInfo, Workbook, corrupt, iter_xml, protected_warning, raise_if_cancelled,
                     refuse_dtd)

_OFFICE = "{urn:oasis:names:tc:opendocument:xmlns:office:1.0}"
_TABLE = "{urn:oasis:names:tc:opendocument:xmlns:table:1.0}"
_TEXT = "{urn:oasis:names:tc:opendocument:xmlns:text:1.0}"
_CALCEXT = "{urn:org:documentfoundation:names:experimental:calc:xmlns:calcext:1.0}"
TABLE = _TABLE + "table"
ROW = _TABLE + "table-row"
CELL = _TABLE + "table-cell"
COVERED = _TABLE + "covered-table-cell"
ROWS_REPEATED = _TABLE + "number-rows-repeated"
COLUMNS_REPEATED = _TABLE + "number-columns-repeated"
FORMULA = _TABLE + "formula"
VALUE_TYPE = _OFFICE + "value-type"
VALUE = _OFFICE + "value"
DATE_VALUE = _OFFICE + "date-value"
TIME_VALUE = _OFFICE + "time-value"
BOOLEAN_VALUE = _OFFICE + "boolean-value"
STRING_VALUE = _OFFICE + "string-value"
EXTENDED_TYPE = _CALCEXT + "value-type"
PARAGRAPH = _TEXT + "p"
HEADING = _TEXT + "h"
SPACE = _TEXT + "s"
SPACE_COUNT = _TEXT + "c"
TAB = _TEXT + "tab"
LINE_BREAK = _TEXT + "line-break"
SKIPPED_TEXT = frozenset((_TEXT + "note", _OFFICE + "annotation", _TEXT + "ruby-text"))
NUMBER_TYPES = frozenset(("float", "percentage", "currency"))
# LibreOffice shows some errors as Err:NNN; these are the ones with an Excel code.
LIBREOFFICE_ERRORS = {"Err:502": "#VALUE!", "Err:503": "#NUM!", "Err:504": "#VALUE!", "Err:519": "#VALUE!",
                      "Err:524": "#REF!", "Err:525": "#NAME?", "Err:532": "#DIV/0!", "Err:511": "#VALUE!"}

_SCAN_CHUNK = 1 << 20
_HEAD_LIMIT = 64 * 1024 * 1024
_TAG_LIMIT = 16 * 1024 * 1024
_BODY = re.compile(rb"<[\w.-]+:body[\s>]")
_STYLE_START = re.compile(rb"<[\w.-]+:style\s(?P<attrs>[^>]*?)(?P<empty>/?)>")
_STYLE_END = re.compile(rb"</[\w.-]+:style\s*>")
_BODY_TOKEN = re.compile(rb"<[\w.-]+:table(?P<attrs>\s[^>]*)?>"
                         rb"|<[\w.-]+:table-cell\s[^>]*?number-(?:columns|rows)-spanned\s*=\s*[\"'](?:[2-9]|[1-9]\d+)[\"']")
_DATE = re.compile(r"(?P<year>-?\d{4,})-(?P<month>\d\d)-(?P<day>\d\d)"
                   r"(?:T(?P<hour>\d\d):(?P<minute>\d\d)(?::(?P<second>\d\d)(?:[.,](?P<fraction>\d+))?)?)?")
_DURATION = re.compile(r"(?P<sign>-)?P(?:(?P<days>\d+)D)?(?:T(?:(?P<hours>\d+)H)?(?:(?P<minutes>\d+)M)?"
                       r"(?:(?P<seconds>\d+(?:[.,]\d+)?)S)?)?")
_ODF_REFERENCE = re.compile(r'(?P<string>"(?:[^"]|"")*")|\[(?P<reference>[^\]]*)\]')
_ODF_SEPARATOR = re.compile(r'(?P<string>"(?:[^"]|"")*")|;')


def _attribute(name):
    return re.compile(rb"(?:^|\s)[\w.-]+:" + name + rb"\s*=\s*(?:\"(?P<double>[^\"]*)\"|'(?P<single>[^']*)')")


_NAME = _attribute(rb"name")
_STYLE_NAME = _attribute(rb"style-name")
_PROTECTED = _attribute(rb"protected")
_FAMILY = _attribute(rb"family")
_DISPLAY = _attribute(rb"display")


def _value_of(pattern, data):
    match = pattern.search(data)
    if not match:
        return None
    raw = match.group("double") if match.group("double") is not None else match.group("single")
    return html.unescape(raw.decode("utf-8", "replace"))


def odf_formula(text):
    """'of:=SUM([.A1:.B2])' -> 'SUM(A1:B2)'; references to other sheets become Sheet!A1, ; becomes ,."""
    if text.startswith(("of:", "oooc:", "msoxl:")):
        text = text.partition(":")[2]
    if text.startswith("="):
        text = text[1:]

    def reference(match):
        if match.group("string") is not None:
            return match.group(0)
        parts = []
        previous = None
        for part in match.group("reference").split(":"):
            sheet, dot, cell = part.rpartition(".")
            if not dot:
                parts.append(part)
                continue
            sheet = sheet.lstrip("$")
            if sheet and sheet != previous:
                parts.append(f"{sheet}!{cell}")
                previous = sheet
            else:
                parts.append(cell)
        return ":".join(parts)

    text = _ODF_REFERENCE.sub(reference, text)
    return _ODF_SEPARATOR.sub(lambda match: match.group(0) if match.group("string") is not None else ",", text)


def _number(text):
    try:
        value = float(text)
    except (TypeError, ValueError):
        return None
    if value.is_integer() and abs(value) < 2 ** 53:
        return int(value)
    return value


def _date(text):
    match = _DATE.match((text or "").strip())
    if not match:
        return text or None
    try:
        day = (int(match.group("year")), int(match.group("month")), int(match.group("day")))
        if match.group("hour") is None:
            return datetime.date(*day)
        fraction = match.group("fraction") or ""
        return datetime.datetime(*day, int(match.group("hour")), int(match.group("minute")),
                                 int(match.group("second") or 0), int((fraction + "000000")[:6]))
    except ValueError:
        return text


def _time(text):
    """PT18H30M00S -> time(18, 30); a duration of a day or more stays a number of days."""
    match = _DURATION.fullmatch((text or "").strip())
    if not match:
        return text or None
    seconds = (int(match.group("days") or 0) * 86400 + int(match.group("hours") or 0) * 3600
               + int(match.group("minutes") or 0) * 60 + float((match.group("seconds") or "0").replace(",", ".")))
    if match.group("sign"):
        seconds = -seconds
    micros = round(seconds * 1000000)
    if 0 <= micros < 86400 * 1000000:
        return datetime.time(micros // 3600000000, micros // 60000000 % 60, micros // 1000000 % 60, micros % 1000000)
    return seconds / 86400


def _text(element):
    parts = [element.text or ""]
    for child in element:
        tag = child.tag
        if tag == SPACE:
            try:
                count = int(child.get(SPACE_COUNT) or 1)
            except ValueError:
                count = 1
            parts.append(" " * max(1, min(count, 10000)))
        elif tag == TAB:
            parts.append("\t")
        elif tag == LINE_BREAK:
            parts.append("\n")
        elif tag not in SKIPPED_TEXT:
            parts.append(_text(child))
        parts.append(child.tail or "")
    return "".join(parts)


def _paragraphs(cell):
    texts = [_text(child) for child in cell if child.tag == PARAGRAPH or child.tag == HEADING]
    return "\n".join(texts) if texts else None


def _error(text):
    text = (text or "").strip()
    if text in ERROR_CODES:
        return CellError(text)
    if text.startswith("Err:"):
        return CellError(LIBREOFFICE_ERRORS.get(text, text))
    return None


def cell_value(cell):
    kind = cell.get(VALUE_TYPE)
    formula = cell.get(FORMULA)
    if formula is not None and cell.get(EXTENDED_TYPE) == "error":
        return _error(_paragraphs(cell)) or CellError("#VALUE!")
    if kind in NUMBER_TYPES:
        return _number(cell.get(VALUE))
    if kind == "date":
        return _date(cell.get(DATE_VALUE))
    if kind == "time":
        return _time(cell.get(TIME_VALUE))
    if kind == "boolean":
        value = (cell.get(BOOLEAN_VALUE) or "").strip().lower()
        return None if not value else value in ("true", "1")
    text = _paragraphs(cell)
    if text is None:
        text = cell.get(STRING_VALUE)
    if formula is not None:
        error = _error(text)
        if error is not None:
            return error
    return text or None


class OdsWorkbook(Workbook):
    format = "ods"

    def __init__(self, path, package, cancelled=None, size=None):
        super().__init__(cancelled)
        self._package = package
        manifest = package.find("META-INF/manifest.xml")
        if manifest and b"encryption-data" in package.read(manifest):
            raise SheetFormatError("encrypted", ENCRYPTED_MESSAGE)
        if not package.find("content.xml"):
            raise corrupt("content.xml is missing")
        for name, hidden, protected, merges in self._scan():
            if protected:
                self.warn(protected_warning(name))
            if merges:
                self.warn(f"merged cells in {name} ({merges} {'range' if merges == 1 else 'ranges'})")
            self.sheets.append(SheetInfo(name, hidden, protected, None, None))
        self.meta.update({"date1904": False, "bytes": size})

    def _release(self):
        self._package.close()

    # ------------------------------------------------------------ opening
    def _scan(self):
        """[(name, hidden, protected, merged ranges)] from the raw bytes of content.xml."""
        head = bytearray()
        hidden_styles = set()
        tables = []
        buffer = b""
        in_body = False
        with self._package.open("content.xml") as stream:
            while True:
                raise_if_cancelled(self._cancelled)
                chunk = stream.read(_SCAN_CHUNK)
                if not in_body:
                    head += chunk
                    match = _BODY.search(head)
                    if match is None:
                        if not chunk:
                            break
                        if len(head) > _HEAD_LIMIT:
                            raise corrupt("content.xml has no body")
                        continue
                    refuse_dtd(head[:match.start()])
                    hidden_styles = self._hidden_styles(bytes(head[:match.start()]))
                    chunk, head, in_body = bytes(head[match.start():]), None, True
                data = buffer + chunk if buffer else chunk
                if chunk:
                    cut = data.rfind(b"<")
                    if cut != -1 and data.find(b">", cut) == -1:
                        data, buffer = data[:cut], data[cut:]
                        if len(buffer) > _TAG_LIMIT:
                            raise corrupt("content.xml has a tag that never ends")
                    else:
                        buffer = b""
                for match in _BODY_TOKEN.finditer(data):
                    if match.group(0)[1:].split(b":", 1)[1].startswith(b"table-cell"):
                        if tables:
                            tables[-1][3] += 1
                        continue
                    attrs = match.group("attrs") or b""
                    name = _value_of(_NAME, attrs) or f"Sheet{len(tables) + 1}"
                    style = _value_of(_STYLE_NAME, attrs)
                    protected = (_value_of(_PROTECTED, attrs) or "").lower() == "true"
                    tables.append([name, style in hidden_styles, protected, 0])
                if not chunk:
                    break
        if not in_body:
            refuse_dtd(bytes(head[:4096]))
        return [tuple(table) for table in tables]

    def _hidden_styles(self, head):
        hidden = set()
        for match in _STYLE_START.finditer(head):
            attrs = match.group("attrs")
            if match.group("empty") or (_value_of(_FAMILY, attrs) or "") != "table":
                continue
            end = _STYLE_END.search(head, match.end())
            inner = head[match.end():end.start() if end else len(head)]
            if (_value_of(_DISPLAY, inner) or "").lower() == "false":
                hidden.add(_value_of(_NAME, attrs))
        return hidden

    # ------------------------------------------------------------ rows
    def _table_rows(self, index):
        """(<table-row> element, repeat) for the rows of one table, in order; rows are detached once used."""
        stream = self._package.open("content.xml")
        try:
            stack = []
            tables = -1
            inside = False
            for event, element in iter_xml(stream, self._cancelled):
                if event == "start":
                    stack.append(element)
                    if element.tag == TABLE:
                        tables += 1
                        inside = tables == index
                    continue
                stack.pop()
                tag = element.tag
                if tag == ROW:
                    if inside:
                        try:
                            repeat = max(1, int(element.get(ROWS_REPEATED) or 1))
                        except ValueError:
                            repeat = 1
                        yield element, repeat
                    if stack:
                        stack[-1].remove(element)
                elif tag == TABLE:
                    if inside:
                        return
                    if stack:
                        stack[-1].remove(element)
        finally:
            stream.close()

    def _rows(self, index):
        pending = 0
        emitted = 0
        for row, repeat in self._table_rows(index):
            values = _row_values(row)
            if not values:
                pending += repeat
                continue
            if emitted + pending >= MAX_ROWS:
                break
            for _ in range(pending):
                yield []
                emitted += 1
                if emitted % CANCEL_EVERY == 0:
                    raise_if_cancelled(self._cancelled)
            pending = 0
            for _ in range(min(repeat, MAX_ROWS - emitted)):
                yield list(values)
                emitted += 1
                if emitted % CANCEL_EVERY == 0:
                    raise_if_cancelled(self._cancelled)

    def _formulas(self, index):
        result = {}
        number = 0
        rows = self._table_rows(index)
        try:
            for row, repeat in rows:
                col = 0
                for cell in row:
                    if cell.tag != CELL and cell.tag != COVERED:
                        continue
                    span = _repeat(cell)
                    formula = cell.get(FORMULA)
                    if formula:
                        text = odf_formula(formula)
                        for row_offset in range(min(repeat, FORMULA_CAP)):
                            for col_offset in range(min(span, FORMULA_CAP)):
                                result[(number + row_offset + 1, col + col_offset + 1)] = text
                                if len(result) >= FORMULA_CAP:
                                    self.warn(f"only the first {FORMULA_CAP} formulas of {self.sheets[index].name} were read")
                                    return result
                    col += span
                number += repeat
        finally:
            rows.close()
        return result


def _repeat(cell):
    try:
        return max(1, int(cell.get(COLUMNS_REPEATED) or 1))
    except ValueError:
        return 1


def _row_values(row):
    """The values of a row with repeated cells expanded; trailing empty cells (often repeated to the last column of
    the grid) are never expanded. Cells covered by a merge read as empty, even when LibreOffice kept hidden content."""
    values = []
    pending = 0
    for cell in row:
        tag = cell.tag
        if tag != CELL and tag != COVERED:
            continue
        repeat = _repeat(cell)
        value = cell_value(cell) if tag == CELL else None
        if value is None:
            pending += repeat
            continue
        if len(values) + pending >= MAX_COLS:
            break
        if pending:
            values.extend([None] * pending)
            pending = 0
        values.extend([value] * min(repeat, MAX_COLS - len(values)))
    return values
