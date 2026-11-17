# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""XLSX writer for exports: sheets with a bold, frozen and filtered header row, typed columns (dd/mm/yyyy dates,
R$ currency, percentages...) and shared strings. Each sheet's rows stream through a temporary file (so the
dimension and column widths are known before <sheetData>), and the workbook replaces the target atomically."""

import datetime
import decimal
import math
import os
import re
import shutil
import tempfile
import zipfile

from ..readers.common import MAX_COLS, MAX_ROWS, CellError, column_letter

COLUMN_TYPES = ("text", "number", "integer", "currency", "percent", "date", "datetime", "time", "bool")
_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
_RELATIONSHIPS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_PACKAGE_RELATIONSHIPS = "http://schemas.openxmlformats.org/package/2006/relationships"
_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
_ILLEGAL = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f￾￿\ud800-\udfff]")
_X_ESCAPE = re.compile(r"_(?=x[0-9A-Fa-f]{4}_)")
_BAD_NAME = re.compile(r"[\[\]:*?/\\]")
_MAX_TEXT = 32767
_EPOCH = datetime.datetime(1899, 12, 30)
_FLUSH_ROWS = 500

HEADER, DATE, DATETIME, TIME, CURRENCY, PERCENT, INTEGER, NUMBER = range(1, 9)
_NUMBER_STYLES = {"currency": CURRENCY, "percent": PERCENT, "integer": INTEGER, "number": NUMBER}
_WIDTHS = {"date": 11, "datetime": 17, "time": 7, "bool": 7, "currency": 14, "percent": 9, "integer": 10, "number": 12}
_STYLES = (
    _DECLARATION + f'<styleSheet xmlns="{_MAIN}">'
    '<numFmts count="5">'
    '<numFmt numFmtId="164" formatCode="dd/mm/yyyy"/>'
    '<numFmt numFmtId="165" formatCode="dd/mm/yyyy hh:mm"/>'
    '<numFmt numFmtId="166" formatCode="hh:mm"/>'
    '<numFmt numFmtId="167" formatCode="&quot;R$&quot; #,##0.00"/>'
    '<numFmt numFmtId="168" formatCode="0.0%"/>'
    '</numFmts>'
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font>'
    '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>'
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    '<cellXfs count="9">'
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
    '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
    '<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
    '<xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
    '<xf numFmtId="168" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
    '<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
    '<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
    '</cellXfs>'
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
    '<dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>'
    '</styleSheet>')


def write_xlsx(path, sheets):
    """Writes sheets = [{'name', 'columns': [{'name', 'type'}], 'rows': iterable of lists}] to path. Percent values
    are fractions (0.15 shows 15.0%). Returns [{'name': final sheet name, 'rows': data rows written}]."""
    path = os.fspath(path)
    sheets = list(sheets) or [{"name": "Planilha1", "columns": [], "rows": []}]
    names = sheet_names([sheet.get("name") for sheet in sheets])
    folder = os.path.dirname(os.path.abspath(path))
    handle, temporary = tempfile.mkstemp(prefix=".sheetstudio-", suffix=".xlsx", dir=folder)
    os.close(handle)
    try:
        strings = _SharedStrings()
        written = []
        with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            archive.writestr("[Content_Types].xml", _content_types(len(sheets)))
            archive.writestr("_rels/.rels", _DECLARATION + f'<Relationships xmlns="{_PACKAGE_RELATIONSHIPS}">'
                             '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
                             'relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
            filters = []
            for number, (sheet, name) in enumerate(zip(sheets, names), 1):
                rows, filter_ref = _write_sheet(archive, number, sheet, name, strings)
                written.append({"name": name, "rows": rows})
                filters.append(filter_ref)
            archive.writestr("xl/workbook.xml", _workbook(names, filters))
            archive.writestr("xl/_rels/workbook.xml.rels", _workbook_relationships(len(sheets)))
            archive.writestr("xl/styles.xml", _STYLES)
            with archive.open("xl/sharedStrings.xml", "w") as out:
                strings.write(out)
        os.replace(temporary, path)
    except BaseException:
        try:
            os.remove(temporary)
        except OSError:
            pass
        raise
    return written


def sheet_names(raw_names):
    """Excel-safe, unique sheet names: no []:*?/\\, at most 31 characters, not the reserved 'History'."""
    used = set()
    result = []
    for number, raw in enumerate(raw_names, 1):
        name = _ILLEGAL.sub("", _BAD_NAME.sub("_", str(raw or ""))).strip().strip("'").strip()
        name = name[:31].strip() or f"Planilha{number}"
        if name.casefold() == "history":
            name = "History_"
        base = name
        counter = 2
        while name.casefold() in used:
            suffix = f" ({counter})"
            name = base[:31 - len(suffix)] + suffix
            counter += 1
        used.add(name.casefold())
        result.append(name)
    return result


def clean_text(value):
    """Text that XML and Excel accept: no illegal control characters, at most 32,767 characters."""
    value = _ILLEGAL.sub("", value)
    return value[:_MAX_TEXT] if len(value) > _MAX_TEXT else value


def _escape(value):
    if "_x" in value:
        value = _X_ESCAPE.sub("_x005F_", value)
    return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _attribute(value):
    return _escape(value).replace('"', "&quot;")


def excel_serial(value):
    """date, datetime or time as an Excel serial (1900 system); None before 1900-01-01."""
    if isinstance(value, datetime.datetime):
        delta = value.replace(tzinfo=None) - _EPOCH
        serial = delta.days + (delta.seconds + delta.microseconds / 1000000) / 86400
    elif isinstance(value, datetime.date):
        serial = (value - _EPOCH.date()).days
    else:
        return (value.hour * 3600 + value.minute * 60 + value.second + value.microsecond / 1000000) / 86400
    if serial < 2:
        return None
    # Excel counts a 29 Feb 1900 that never existed, so dates before March 1900 are one lower.
    return serial - 1 if serial < 61 else serial


class _SharedStrings:
    def __init__(self):
        self.index = {}
        self.count = 0

    def add(self, text):
        self.count += 1
        position = self.index.get(text)
        if position is None:
            position = self.index[text] = len(self.index)
        return position

    def write(self, out):
        out.write((_DECLARATION + f'<sst xmlns="{_MAIN}" count="{self.count}" uniqueCount="{len(self.index)}">').encode("utf-8"))
        buffer = []
        for text in self.index:
            space = ' xml:space="preserve"' if text != text.strip() else ""
            buffer.append(f"<si><t{space}>{_escape(text)}</t></si>")
            if len(buffer) >= 2000:
                out.write("".join(buffer).encode("utf-8"))
                buffer.clear()
        buffer.append("</sst>")
        out.write("".join(buffer).encode("utf-8"))


def _number_text(value):
    if isinstance(value, int):
        return str(value)
    return repr(float(value))


def _cell(ref, value, kind, strings):
    """(cell XML, display width) of one value; ('', 0) for an empty one."""
    if value is None:
        return "", 0
    if isinstance(value, bool):
        return f'<c r="{ref}" t="b"><v>{int(value)}</v></c>', 5
    if isinstance(value, CellError):
        return f'<c r="{ref}" t="e"><v>{_escape(value.code)}</v></c>', len(value.code)
    if isinstance(value, (datetime.date, datetime.time)):
        serial = excel_serial(value)
        if serial is not None:
            if isinstance(value, datetime.time):
                style, width = TIME, 6
            elif isinstance(value, datetime.datetime) and kind != "date":
                style, width = DATETIME, 16
            else:
                style, width = DATE, 10
            return f'<c r="{ref}" s="{style}"><v>{_number_text(serial)}</v></c>', width
        value = value.isoformat()
    if isinstance(value, decimal.Decimal):
        value = float(value)
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            return f'<c r="{ref}" t="e"><v>#NUM!</v></c>', 5
        style = _NUMBER_STYLES.get(kind)
        attribute = f' s="{style}"' if style else ""
        width = len(f"{value:,.2f}") + (3 if kind == "currency" else 0) if abs(value) < 1e15 else 12
        return f'<c r="{ref}"{attribute}><v>{_number_text(value)}</v></c>', width
    text = clean_text(value if isinstance(value, str) else str(value))
    if not text:
        return "", 0
    width = max(len(line) for line in text.split("\n")) if "\n" in text else len(text)
    return f'<c r="{ref}" t="s"><v>{strings.add(text)}</v></c>', width


def _write_sheet(archive, number, sheet, name, strings):
    """Writes xl/worksheets/sheet<number>.xml; returns (data rows, autofilter range or None)."""
    columns = list(sheet.get("columns") or [])
    titles = []
    kinds = []
    for column in columns:
        column = column if isinstance(column, dict) else {"name": column}
        kind = column.get("type") or "text"
        if kind not in COLUMN_TYPES:
            raise ValueError(f"Unknown column type {kind!r} in sheet {name}; use one of {', '.join(COLUMN_TYPES)}.")
        titles.append(clean_text(str(column.get("name") if column.get("name") is not None else "")))
        kinds.append(kind)
    if len(columns) > MAX_COLS:
        raise ValueError(f"Sheet {name} has more than {MAX_COLS} columns, Excel's limit.")
    widths = [max(len(title) + 2, _WIDTHS.get(kind, 8)) for title, kind in zip(titles, kinds)]
    count = 0
    used = len(columns)
    with tempfile.TemporaryFile() as body:
        buffer = []
        row_number = 0
        if columns:
            row_number = 1
            cells = []
            for index, title in enumerate(titles):
                if title:
                    cells.append(f'<c r="{column_letter(index + 1)}1" s="{HEADER}" t="s"><v>{strings.add(title)}</v></c>')
            buffer.append('<row r="1">' + "".join(cells) + "</row>")
        for values in sheet.get("rows") or ():
            row_number += 1
            count += 1
            if row_number > MAX_ROWS:
                raise ValueError(f"Sheet {name} has more than {MAX_ROWS:,} rows, Excel's limit; split the export.")
            cells = []
            for index, value in enumerate(values):
                if value is None:
                    continue
                if index >= MAX_COLS:
                    raise ValueError(f"Sheet {name} has more than {MAX_COLS} columns, Excel's limit.")
                kind = kinds[index] if index < len(kinds) else "text"
                xml, shown = _cell(f"{column_letter(index + 1)}{row_number}", value, kind, strings)
                if not xml:
                    continue
                cells.append(xml)
                if index >= len(widths):
                    widths.extend([8] * (index + 1 - len(widths)))
                if shown + 2 > widths[index]:
                    widths[index] = shown + 2
                if index + 1 > used:
                    used = index + 1
            if cells:
                buffer.append(f'<row r="{row_number}">' + "".join(cells) + "</row>")
            if len(buffer) >= _FLUSH_ROWS:
                body.write("".join(buffer).encode("utf-8"))
                buffer.clear()
        body.write("".join(buffer).encode("utf-8"))
        size = body.tell()
        body.seek(0)
        last = f"{column_letter(max(used, 1))}{max(row_number, 1)}"
        dimension = "A1" if last == "A1" else f"A1:{last}"
        selected = ' tabSelected="1"' if number == 1 else ""
        pane = ('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
                '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>') if columns else ""
        cols = "".join(f'<col min="{index}" max="{index}" width="{min(value, 60) * 1.1 + 1:.2f}" customWidth="1"/>'
                       for index, value in enumerate(widths[:used], 1))
        filter_ref = f"A1:{column_letter(len(columns))}{max(row_number, 1)}" if columns else None
        head = (_DECLARATION + f'<worksheet xmlns="{_MAIN}" xmlns:r="{_RELATIONSHIPS}">'
                f'<dimension ref="{dimension}"/>'
                f'<sheetViews><sheetView workbookViewId="0"{selected}>{pane}</sheetView></sheetViews>'
                '<sheetFormatPr defaultRowHeight="15"/>'
                + (f"<cols>{cols}</cols>" if cols else "") + "<sheetData>")
        tail = ("</sheetData>" + (f'<autoFilter ref="{filter_ref}"/>' if filter_ref else "")
                + '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>')
        with archive.open(f"xl/worksheets/sheet{number}.xml", "w", force_zip64=size > (1 << 30)) as out:
            out.write(head.encode("utf-8"))
            shutil.copyfileobj(body, out, 1 << 20)
            out.write(tail.encode("utf-8"))
    return count, filter_ref


def _content_types(sheets):
    parts = [_DECLARATION, '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
             '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
             '<Default Extension="xml" ContentType="application/xml"/>',
             '<Override PartName="/xl/workbook.xml" '
             'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>']
    for number in range(1, sheets + 1):
        parts.append(f'<Override PartName="/xl/worksheets/sheet{number}.xml" '
                     'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>')
    parts.append('<Override PartName="/xl/styles.xml" '
                 'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>')
    parts.append('<Override PartName="/xl/sharedStrings.xml" '
                 'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>')
    parts.append("</Types>")
    return "".join(parts)


def _absolute(ref):
    """'A1:D10' -> '$A$1:$D$10'."""
    parts = []
    for part in ref.split(":"):
        letters = part.rstrip("0123456789")
        parts.append(f"${letters}${part[len(letters):]}")
    return ":".join(parts)


def _workbook(names, filters):
    sheets = "".join(f'<sheet name="{_attribute(name)}" sheetId="{number}" r:id="rId{number}"/>'
                     for number, name in enumerate(names, 1))
    defined = []
    for index, (name, ref) in enumerate(zip(names, filters)):
        if ref:
            target = _escape("'" + name.replace("'", "''") + "'!" + _absolute(ref))
            defined.append(f'<definedName name="_xlnm._FilterDatabase" localSheetId="{index}" hidden="1">{target}</definedName>')
    names_xml = "<definedNames>" + "".join(defined) + "</definedNames>" if defined else ""
    return (_DECLARATION + f'<workbook xmlns="{_MAIN}" xmlns:r="{_RELATIONSHIPS}">'
            '<workbookPr/><bookViews><workbookView activeTab="0"/></bookViews>'
            f"<sheets>{sheets}</sheets>{names_xml}" '<calcPr calcId="191029"/></workbook>')


def _workbook_relationships(sheets):
    base = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    parts = [_DECLARATION, f'<Relationships xmlns="{_PACKAGE_RELATIONSHIPS}">']
    for number in range(1, sheets + 1):
        parts.append(f'<Relationship Id="rId{number}" Type="{base}/worksheet" Target="worksheets/sheet{number}.xml"/>')
    parts.append(f'<Relationship Id="rId{sheets + 1}" Type="{base}/styles" Target="styles.xml"/>')
    parts.append(f'<Relationship Id="rId{sheets + 2}" Type="{base}/sharedStrings" Target="sharedStrings.xml"/>')
    parts.append("</Relationships>")
    return "".join(parts)
