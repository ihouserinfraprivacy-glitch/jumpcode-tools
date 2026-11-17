# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""XLS (Excel 97-2003, BIFF8) reader over the "Workbook" stream of an OLE2 file: sheets from BOUNDSHEET8, strings
from the SST (split across CONTINUE records), numbers, RK/MULRK, labels, booleans and errors, cached formula
results, and XF/FORMAT to tell dates from numbers. Formula text is not decoded (formulas() returns {})."""

import struct

from .common import (CANCEL_EVERY, ENCRYPTED_MESSAGE, GENERAL, XLS_ERRORS, CellError, SheetFormatError, SheetInfo,
                     Workbook, convert_number, corrupt, format_info, merged_warning, place, protected_warning,
                     raise_if_cancelled, range_name, trim, unsupported)

BOF = 0x0809
EOF = 0x000A
FILEPASS = 0x002F
DATEMODE = 0x0022
FORMAT = 0x041E
XF = 0x00E0
BOUNDSHEET = 0x0085
SST = 0x00FC
CONTINUE = 0x003C
PROTECT = 0x0012
DIMENSION = 0x0200
MERGEDCELLS = 0x00E5
LABELSST = 0x00FD
LABEL = 0x0204
RSTRING = 0x00D6
NUMBER = 0x0203
RK = 0x027E
MULRK = 0x00BD
BLANK = 0x0201
MULBLANK = 0x00BE
BOOLERR = 0x0205
FORMULA = 0x0006
STRING = 0x0207
CELLS = frozenset((LABELSST, LABEL, RSTRING, NUMBER, RK, MULRK, BLANK, MULBLANK, BOOLERR, FORMULA))
BIFF5_MESSAGE = "This is an old Excel 5/95 file; ask the user to open it in Excel and save it as .xlsx."
_HEADER = struct.Struct("<HH")
_CELL = struct.Struct("<HHH")
_DOUBLE = struct.Struct("<d")


def decode_rk(rk):
    """RK number: bit 1 says integer (30-bit signed) or the top 30 bits of a double; bit 0 says divide by 100."""
    if rk & 2:
        value = rk >> 2
        if rk & 0x80000000:
            value -= 1 << 30
    else:
        value = _DOUBLE.unpack(struct.pack("<Q", (rk & 0xFFFFFFFC) << 32))[0]
    if rk & 1:
        return value / 100
    return value


class _Segments:
    """Reads across a record and its CONTINUE records. A character array split between records restarts with a
    one-byte flag that says whether the rest is 8-bit or UTF-16; other data continues without a flag."""

    def __init__(self, segments):
        self._segments = segments
        self._index = 0
        self._data = segments[0] if segments else b""
        self._pos = 0

    def _next(self):
        self._index += 1
        if self._index >= len(self._segments):
            raise corrupt("a string in the .xls is cut short")
        self._data = self._segments[self._index]
        self._pos = 0

    def read(self, size):
        parts = []
        while size > 0:
            if self._pos >= len(self._data):
                self._next()
            piece = self._data[self._pos:self._pos + size]
            self._pos += len(piece)
            size -= len(piece)
            parts.append(piece)
        return b"".join(parts)

    def skip(self, size):
        while size > 0:
            if self._pos >= len(self._data):
                self._next()
            step = min(size, len(self._data) - self._pos)
            self._pos += step
            size -= step

    def string(self, length_bytes=2):
        """XLUnicodeRichExtendedString: the text, with rich-text runs and phonetic data skipped."""
        count = struct.unpack("<H", self.read(2))[0] if length_bytes == 2 else self.read(1)[0]
        flags = self.read(1)[0]
        runs = struct.unpack("<H", self.read(2))[0] if flags & 0x08 else 0
        extra = struct.unpack("<I", self.read(4))[0] if flags & 0x04 else 0
        wide = flags & 0x01
        parts = []
        got = 0
        while True:
            available = len(self._data) - self._pos
            take = min(count - got, available // 2 if wide else available)
            raw = self._data[self._pos:self._pos + (take * 2 if wide else take)]
            self._pos += len(raw)
            parts.append(raw.decode("utf-16-le", "replace") if wide else raw.decode("latin-1"))
            got += take
            if got >= count:
                break
            self._next()
            wide = self._data[0] & 0x01
            self._pos = 1
        self.skip(runs * 4 + extra)
        return "".join(parts)


def _short_string(data, pos, length_bytes):
    """XLUnicodeString / ShortXLUnicodeString inside one record: (text, next position)."""
    if length_bytes == 2:
        count = struct.unpack_from("<H", data, pos)[0]
        pos += 2
    else:
        count = data[pos]
        pos += 1
    flags = data[pos]
    pos += 1
    runs = extra = 0
    if flags & 0x08:
        runs = struct.unpack_from("<H", data, pos)[0]
        pos += 2
    if flags & 0x04:
        extra = struct.unpack_from("<I", data, pos)[0]
        pos += 4
    if flags & 0x01:
        text = data[pos:pos + count * 2].decode("utf-16-le", "replace")
        pos += count * 2
    else:
        text = data[pos:pos + count].decode("latin-1")
        pos += count
    return text, pos + runs * 4 + extra


class _Sheet:
    __slots__ = ("name", "offset", "kind", "hidden", "protected", "rows", "cols", "merges", "formulas", "ordered")


class XlsWorkbook(Workbook):
    format = "xls"

    def __init__(self, path, compound, cancelled=None, size=None):
        super().__init__(cancelled)
        names = {name.casefold(): name for name in compound.names()}
        if "encryptedpackage" in names:
            raise SheetFormatError("encrypted", ENCRYPTED_MESSAGE)
        if "workbook" not in names:
            if "book" in names:
                raise unsupported(BIFF5_MESSAGE)
            raise unsupported("This is an Office binary file (OLE2) but not an Excel workbook, maybe a .doc or .ppt. "
                              "Ask the user for the spreadsheet itself.")
        self._data = compound.read(names["workbook"])
        self._date1904 = False
        self._strings = []
        self._styles = []
        self._sheets = []
        self._globals()
        for sheet in self._sheets:
            raise_if_cancelled(self._cancelled)
            if sheet.kind == "worksheet":
                self._scan(sheet)
            if sheet.protected:
                self.warn(protected_warning(sheet.name))
            if sheet.merges:
                self.warn(merged_warning(sheet.name, sheet.merges))
            self.sheets.append(SheetInfo(sheet.name, sheet.hidden, sheet.protected, sheet.rows, sheet.cols))
        if any(sheet.formulas for sheet in self._sheets):
            self.warn("formula text is not available for .xls files; cells hold the values Excel saved")
        self.meta.update({"date1904": self._date1904, "bytes": size})

    def _release(self):
        self._data = b""

    def _records(self, pos):
        data = self._data
        end = len(data)
        while pos + 4 <= end:
            rid, size = _HEADER.unpack_from(data, pos)
            start = pos + 4
            pos = start + size
            if pos > end:
                raise corrupt("an .xls record is cut short")
            yield rid, start, pos

    # ------------------------------------------------------------ workbook globals
    def _globals(self):
        data = self._data
        if len(data) < 8 or _HEADER.unpack_from(data, 0)[0] != BOF:
            raise corrupt("the .xls workbook stream does not start with BOF")
        version = struct.unpack_from("<H", data, 4)[0]
        if version == 0x0500:
            raise unsupported(BIFF5_MESSAGE)
        if version != 0x0600:
            raise unsupported("This is a very old Excel file (2.x to 4.x); ask the user to open it in Excel and save "
                              "it as .xlsx.")
        formats = {}
        xf_formats = []
        records = self._records(0)
        next(records)
        sst = None
        collecting = False
        for rid, start, end in records:
            if rid == FILEPASS:
                raise SheetFormatError("encrypted", ENCRYPTED_MESSAGE)
            if rid == EOF:
                break
            if rid == CONTINUE:
                if collecting:
                    sst.append(data[start:end])
                continue
            collecting = rid == SST
            if rid == DATEMODE and end - start >= 2:
                self._date1904 = struct.unpack_from("<H", data, start)[0] == 1
            elif rid == FORMAT and end - start >= 5:
                formats[struct.unpack_from("<H", data, start)[0]] = _short_string(data, start + 2, 2)[0]
            elif rid == XF and end - start >= 4:
                xf_formats.append(struct.unpack_from("<H", data, start + 2)[0])
            elif rid == BOUNDSHEET and end - start >= 8:
                self._boundsheet(start)
            elif rid == SST:
                sst = [data[start:end]]
            elif rid == PROTECT and end - start >= 2 and struct.unpack_from("<H", data, start)[0]:
                self.warn("the workbook structure is protected (editing only)")
        if sst:
            self._strings = self._read_sst(sst)
        cache = {}
        for number in xf_formats:
            if number not in cache:
                cache[number] = format_info(number, formats.get(number))
            self._styles.append(cache[number])

    def _boundsheet(self, start):
        data = self._data
        offset, state, kind = struct.unpack_from("<IBB", data, start)
        if kind == 6:
            return
        sheet = _Sheet()
        sheet.name = _short_string(data, start + 6, 1)[0] or f"Sheet{len(self._sheets) + 1}"
        sheet.offset = offset
        sheet.kind = "chart" if kind == 2 else "worksheet"
        sheet.hidden = (state & 0x03) != 0
        sheet.protected = False
        sheet.rows = sheet.cols = 0 if kind == 2 else None
        sheet.merges = []
        sheet.formulas = False
        sheet.ordered = True
        if kind == 2:
            self.warn(f"{sheet.name} is a chart sheet; it has no cells")
        self._sheets.append(sheet)

    def _read_sst(self, segments):
        reader = _Segments(segments)
        unique = struct.unpack("<I", reader.read(8)[4:])[0]
        strings = []
        try:
            for index in range(unique):
                strings.append(reader.string())
                if index % 10000 == 9999:
                    raise_if_cancelled(self._cancelled)
        except SheetFormatError as error:
            if error.kind != "corrupt" or not strings:
                raise
            self.warn("the shared string table of this .xls is cut short; some text cells may be empty")
        return strings

    # ------------------------------------------------------------ sheets
    def _substream(self, offset):
        """Records of one sheet, without the charts embedded in it."""
        data = self._data
        if offset + 4 > len(data) or _HEADER.unpack_from(data, offset)[0] != BOF:
            raise corrupt("a sheet of the .xls does not start where the workbook says")
        depth = 0
        for record in self._records(offset):
            rid = record[0]
            if rid == BOF:
                depth += 1
                continue
            if rid == EOF:
                depth -= 1
                if depth == 0:
                    return
                continue
            if depth == 1:
                yield record

    def _scan(self, sheet):
        data = self._data
        last = -1
        try:
            for rid, start, end in self._substream(sheet.offset):
                if rid in CELLS:
                    if end - start >= 2:
                        row = struct.unpack_from("<H", data, start)[0]
                        if row < last:
                            sheet.ordered = False
                        last = row
                    if rid == FORMULA:
                        sheet.formulas = True
                elif rid == DIMENSION and end - start >= 12:
                    sheet.rows = struct.unpack_from("<I", data, start + 4)[0]
                    sheet.cols = struct.unpack_from("<H", data, start + 10)[0]
                    if not sheet.rows or not sheet.cols:
                        sheet.rows = sheet.cols = 0
                elif rid == PROTECT and end - start >= 2:
                    sheet.protected = bool(struct.unpack_from("<H", data, start)[0])
                elif rid == MERGEDCELLS and end - start >= 2:
                    count = min(struct.unpack_from("<H", data, start)[0], (end - start - 2) // 8)
                    for index in range(count):
                        first_row, last_row, first_col, last_col = struct.unpack_from("<HHHH", data, start + 2 + index * 8)
                        sheet.merges.append(range_name(first_row + 1, first_col + 1, last_row + 1, last_col + 1))
        except SheetFormatError as error:
            if error.kind != "corrupt":
                raise
            self.warn(f"the sheet {sheet.name} is damaged; only part of it may be read")

    def _style(self, index):
        try:
            return self._styles[index]
        except IndexError:
            return GENERAL

    def _cells(self, sheet):
        """(row, col, value) for every non-empty cell, 0-based, in file order."""
        data = self._data
        date1904 = self._date1904
        pending = None
        string = None
        for rid, start, end in self._substream(sheet.offset):
            if string is not None:
                # A STRING record (the text a formula returned) may go on in CONTINUE records.
                if rid == CONTINUE:
                    string.append(data[start:end])
                    continue
                text = _Segments(string).string()
                if text:
                    yield pending[0], pending[1], text
                string = pending = None
            if rid == LABELSST:
                row, col, _, index = struct.unpack_from("<HHHI", data, start)
                text = self._strings[index] if index < len(self._strings) else None
                if text:
                    yield row, col, text
            elif rid == NUMBER:
                row, col, xf = _CELL.unpack_from(data, start)
                yield row, col, convert_number(_DOUBLE.unpack_from(data, start + 6)[0], self._style(xf), date1904)
            elif rid == RK:
                row, col, xf, rk = struct.unpack_from("<HHHI", data, start)
                yield row, col, convert_number(decode_rk(rk), self._style(xf), date1904)
            elif rid == MULRK:
                row, first = struct.unpack_from("<HH", data, start)
                for index in range((end - start - 6) // 6):
                    xf, rk = struct.unpack_from("<HI", data, start + 4 + index * 6)
                    yield row, first + index, convert_number(decode_rk(rk), self._style(xf), date1904)
            elif rid == LABEL or rid == RSTRING:
                row, col, _ = _CELL.unpack_from(data, start)
                text = _short_string(data, start + 6, 2)[0]
                if text:
                    yield row, col, text
            elif rid == BOOLERR:
                row, col, _, value, error = struct.unpack_from("<HHHBB", data, start)
                yield row, col, CellError(XLS_ERRORS.get(value, "#VALUE!")) if error else bool(value)
            elif rid == FORMULA:
                row, col, xf = _CELL.unpack_from(data, start)
                result = data[start + 6:start + 14]
                if result[6:8] != b"\xff\xff":
                    yield row, col, convert_number(_DOUBLE.unpack_from(result)[0], self._style(xf), date1904)
                elif result[0] == 0:
                    pending = (row, col)
                elif result[0] == 1:
                    yield row, col, bool(result[2])
                elif result[0] == 2:
                    yield row, col, CellError(XLS_ERRORS.get(result[2], "#VALUE!"))
            elif rid == STRING and pending is not None:
                string = [data[start:end]]
        if string is not None:
            text = _Segments(string).string()
            if text:
                yield pending[0], pending[1], text

    def _rows(self, index):
        sheet = self._sheets[index]
        if sheet.kind != "worksheet":
            return
        cells = self._cells(sheet)
        if not sheet.ordered:
            table = {}
            for row, col, value in cells:
                table.setdefault(row, {})[col] = value
            cells = ((row, col, value) for row in sorted(table) for col, value in sorted(table[row].items()))
        expected = 0
        current = None
        values = []
        for row, col, value in cells:
            if row != current:
                if current is not None:
                    yield trim(values)
                    expected = current + 1
                while expected < row:
                    yield []
                    expected += 1
                    if expected % CANCEL_EVERY == 0:
                        raise_if_cancelled(self._cancelled)
                if expected % CANCEL_EVERY == 0:
                    raise_if_cancelled(self._cancelled)
                current = row
                values = []
            place(values, col + 1, value)
        if current is not None:
            yield trim(values)
