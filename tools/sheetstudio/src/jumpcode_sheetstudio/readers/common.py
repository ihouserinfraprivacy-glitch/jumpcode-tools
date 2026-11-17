# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""What every reader shares: the errors, the workbook and sheet shapes, Excel serial dates and number formats,
A1 references, cancellation, and guarded zip/XML access (no DTDs or entities, no zip bombs)."""

import collections
import datetime
import functools
import io
import posixpath
import re
import struct
import xml.etree.ElementTree as ElementTree
import zipfile
import zlib

MAX_ROWS = 1048576
MAX_COLS = 16384
FORMULA_CAP = 20000
CANCEL_EVERY = 1000
XML_CHUNK = 1 << 18
MAX_PART = 2 * 1024 ** 3
MAX_SMALL_PART = 256 * 1024 ** 2
SUSPICIOUS_PART = 100 * 1024 ** 2
MAX_RATIO = 1000

ENCRYPTED_MESSAGE = ("The file is protected by a password to open. Ask the user to open it in Excel, save a copy "
                     "without the password and try again; never ask for the password.")
UNSUPPORTED_MESSAGE = "This is not a spreadsheet SheetStudio can read (CSV, TSV, XLSX, XLS or ODS)."

ERROR_CODES = frozenset(("#NULL!", "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A", "#GETTING_DATA",
                         "#SPILL!", "#CALC!", "#FIELD!", "#BLOCKED!", "#CONNECT!", "#UNKNOWN!", "#BUSY!", "#PYTHON!"))
XLS_ERRORS = {0x00: "#NULL!", 0x07: "#DIV/0!", 0x0F: "#VALUE!", 0x17: "#REF!", 0x1D: "#NAME?", 0x24: "#NUM!",
              0x2A: "#N/A", 0x2B: "#GETTING_DATA"}


class SheetFormatError(Exception):
    """A file SheetStudio cannot read. `kind` says why ('empty', 'unsupported', 'encrypted', 'corrupt',
    'cancelled', 'not_found', 'unreadable', 'sheet', 'invalid') and the message tells the agent what to do."""

    def __init__(self, kind, message):
        super().__init__(kind, message)
        self.kind = kind
        self.code = kind
        self.message = message

    def __str__(self):
        return self.message


class CellError:
    """An error value shown in a cell, like #REF! or #DIV/0!; str() is the code and two errors are equal when
    their codes are."""

    __slots__ = ("code",)

    def __init__(self, code):
        self.code = str(code)

    def __str__(self):
        return self.code

    def __repr__(self):
        return f"CellError({self.code!r})"

    def __eq__(self, other):
        return isinstance(other, CellError) and other.code == self.code

    def __hash__(self):
        return hash(("CellError", self.code))


SheetInfo = collections.namedtuple("SheetInfo", "name hidden protected rows cols")


def corrupt(detail):
    return SheetFormatError("corrupt", f"The file is damaged ({detail}). Ask the user to open it in Excel or "
                                       "LibreOffice and save a new copy, then try again.")


def unsupported(message):
    return SheetFormatError("unsupported", message)


def raise_if_cancelled(cancelled):
    if cancelled is not None and cancelled():
        raise SheetFormatError("cancelled", "Reading the spreadsheet was cancelled.")


class Workbook:
    """Base of every reader: `format`, `sheets` (SheetInfo list), `meta` (a dict that always has 'warnings'),
    `rows(name)`, `formulas(name)` and `close()`; also a context manager."""

    format = None

    def __init__(self, cancelled=None):
        self.sheets = []
        self.meta = {"warnings": []}
        self._cancelled = cancelled
        self._closed = False

    def warn(self, text):
        if text not in self.meta["warnings"]:
            self.meta["warnings"].append(text)

    def sheet_index(self, sheet_name):
        """The position of a sheet by name (exact, then ignoring case); an int is taken as a position and None as
        the first sheet."""
        if self._closed:
            raise SheetFormatError("closed", "The workbook was closed; open the file again.")
        if sheet_name is None and self.sheets:
            return 0
        if isinstance(sheet_name, int) and not isinstance(sheet_name, bool) and 0 <= sheet_name < len(self.sheets):
            return sheet_name
        for index, sheet in enumerate(self.sheets):
            if sheet.name == sheet_name:
                return index
        folded = str(sheet_name).casefold()
        for index, sheet in enumerate(self.sheets):
            if sheet.name.casefold() == folded:
                return index
        names = ", ".join(sheet.name for sheet in self.sheets) or "none"
        raise SheetFormatError("sheet", f"There is no sheet named {sheet_name!r}. The sheets are: {names}.")

    def rows(self, sheet_name):
        """One list per row from row 1, trailing empty cells trimmed; an empty row is []."""
        return self._rows(self.sheet_index(sheet_name))

    def formulas(self, sheet_name):
        """{(row, col): formula text without '='}, 1-based; {} when the format keeps no formula text."""
        return self._formulas(self.sheet_index(sheet_name))

    def _rows(self, index):
        return iter(())

    def _formulas(self, index):
        return {}

    def close(self):
        if not self._closed:
            self._closed = True
            self._release()

    def _release(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        self.close()
        return False

    def __repr__(self):
        return f"<{type(self).__name__} {self.format} sheets={[s.name for s in self.sheets]}>"


# ---------------------------------------------------------------- A1 references

_COLUMNS = {}


def column_index(letters):
    """'A' -> 1, 'AB' -> 28."""
    index = _COLUMNS.get(letters)
    if index is None:
        index = 0
        for char in letters.upper():
            index = index * 26 + ord(char) - 64
        if len(_COLUMNS) < 20000:
            _COLUMNS[letters] = index
    return index


def column_letter(index):
    """1 -> 'A', 28 -> 'AB'."""
    letters = ""
    while index > 0:
        index, rest = divmod(index - 1, 26)
        letters = chr(65 + rest) + letters
    return letters


def cell_name(row, col):
    return f"{column_letter(col)}{row}"


def range_name(first_row, first_col, last_row, last_col):
    first = cell_name(first_row, first_col)
    last = cell_name(last_row, last_col)
    return first if first == last else f"{first}:{last}"


def merged_warning(sheet, ranges):
    shown = ", ".join(ranges[:5])
    more = f" (+{len(ranges) - 5} more)" if len(ranges) > 5 else ""
    return f"merged cells {shown}{more} in {sheet}"


def protected_warning(sheet):
    return f"sheet {sheet} is protected (editing only)"


def place(values, col, value):
    """Puts a value at a 1-based column of a row list, padding with None."""
    size = len(values)
    if col > size:
        if col - 1 > size:
            values.extend([None] * (col - 1 - size))
        values.append(value)
    elif col > 0:
        values[col - 1] = value


def trim(values):
    while values and values[-1] is None:
        values.pop()
    return values


# ---------------------------------------------------------------- Excel numbers and dates

BUILTIN_FORMATS = {
    0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 5: '"$"#,##0_);("$"#,##0)',
    6: '"$"#,##0_);[Red]("$"#,##0)', 7: '"$"#,##0.00_);("$"#,##0.00)', 8: '"$"#,##0.00_);[Red]("$"#,##0.00)',
    9: "0%", 10: "0.00%", 11: "0.00E+00", 12: "# ?/?", 13: "# ??/??", 14: "mm-dd-yy", 15: "d-mmm-yy", 16: "d-mmm",
    17: "mmm-yy", 18: "h:mm AM/PM", 19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss", 22: "m/d/yy h:mm",
    37: "#,##0 ;(#,##0)", 38: "#,##0 ;[Red](#,##0)", 39: "#,##0.00;(#,##0.00)", 40: "#,##0.00;[Red](#,##0.00)",
    41: '_(* #,##0_);_(* (#,##0);_(* "-"_);_(@_)', 42: '_("$"* #,##0_);_("$"* (#,##0);_("$"* "-"_);_(@_)',
    43: '_(* #,##0.00_);_(* (#,##0.00);_(* "-"??_);_(@_)', 44: '_("$"* #,##0.00_);_("$"* (#,##0.00);_("$"* "-"??_);_(@_)',
    45: "mm:ss", 46: "[h]:mm:ss", 47: "mmss.0", 48: "##0.0E+0", 49: "@",
}
# Ids 27-36 and 50-58 are dates in the East Asian versions of Excel; their codes are not stored in the file.
_ASIAN_DATE_IDS = frozenset(list(range(27, 37)) + list(range(50, 59)))
GENERAL = (None, True)
_LITERALS = re.compile(r'"[^"]*"|\\.|_.|\*.')
_BRACKETS = re.compile(r"\[[^\]]*\]")
_ELAPSED = re.compile(r"\[(?:h+|m+|s+)\]", re.IGNORECASE)
_AM_PM = re.compile(r"am/pm|a/p", re.IGNORECASE)
_EPOCH_1900 = datetime.date(1899, 12, 30)
_EPOCH_1904 = datetime.date(1904, 1, 1)
_DAY_MS = 86400000
_SAFE_INTEGER = 2 ** 53


def format_info(format_id, code=None):
    """(kind, integer) for a number format. kind is None, 'date', 'datetime', 'time' or 'elapsed' ([h]:mm
    durations stay numbers); integer means an integral value shows without decimals and can become an int."""
    if code is None:
        if format_id in _ASIAN_DATE_IDS:
            return ("date", False)
        code = BUILTIN_FORMATS.get(format_id, "General")
    return _classify(code)


def _first_section(code):
    out = []
    quoted = False
    for char in code:
        if char == '"':
            quoted = not quoted
        elif char == ";" and not quoted:
            break
        out.append(char)
    return "".join(out)


@functools.lru_cache(maxsize=2048)
def _classify(code):
    section = _first_section(code)
    elapsed = bool(_ELAPSED.search(section))
    plain = _AM_PM.sub("", _BRACKETS.sub("", _LITERALS.sub("", section))).lower()
    if plain.strip() in ("general", "@", ""):
        return GENERAL
    has_date = "d" in plain or "y" in plain
    has_time = "h" in plain or "s" in plain
    if elapsed and not has_date:
        return ("elapsed", False)
    if "m" in plain and not has_date and not has_time:
        has_date = True
    if has_date and has_time:
        return ("datetime", False)
    if has_date:
        return ("date", False)
    if has_time:
        return ("time", False)
    integer = not any(mark in plain for mark in (".", "%", "e+", "e-", "/", "?"))
    return (None, integer)


def excel_datetime(serial, date1904, kind):
    """An Excel serial number as date, datetime or time for a format kind; out-of-range values stay numbers."""
    limit = 2957004 if date1904 else 2958466
    if not 0 <= serial < limit:
        return serial
    days = int(serial)
    ms = round((serial - days) * _DAY_MS)
    if ms >= _DAY_MS:
        days += 1
        ms -= _DAY_MS
    clock = datetime.time(ms // 3600000, ms // 60000 % 60, ms // 1000 % 60, ms % 1000 * 1000)
    if days == 0 and (kind == "time" or (kind == "datetime" and not date1904)):
        return clock
    if date1904:
        day = _EPOCH_1904 + datetime.timedelta(days=days)
    else:
        # Excel counts a 29 Feb 1900 that never existed: serials before 60 are one day later than the epoch says.
        day = _EPOCH_1900 + datetime.timedelta(days=days + 1 if days < 60 else days)
    if kind == "date" and ms == 0:
        return day
    return datetime.datetime.combine(day, clock)


def convert_number(value, info, date1904):
    """A cell number through its format: dates become date/datetime/time, integral values in General or integer
    formats become int, the rest float."""
    kind, integer = info
    if kind is not None and kind != "elapsed":
        return excel_datetime(value, date1904, kind)
    if integer:
        if type(value) is float and value.is_integer() and -_SAFE_INTEGER < value < _SAFE_INTEGER:
            return int(value)
        return value
    return float(value)


# ---------------------------------------------------------------- zip and XML with guard rails

_DTD_MARKERS = tuple(marker.encode(encoding) for marker in ("<!DOCTYPE", "<!ENTITY")
                     for encoding in ("utf-8", "utf-16-le", "utf-16-be"))


def refuse_dtd(data):
    for marker in _DTD_MARKERS:
        if marker in data:
            raise SheetFormatError("corrupt", "The file contains an XML document type declaration (DTD/ENTITY), "
                                              "which spreadsheets never use; it was refused for safety. Ask the user "
                                              "to open it in Excel or LibreOffice and save a new copy.")


def iter_xml(stream, cancelled=None):
    """(event, element) pairs ('start'/'end') from an XML stream read in chunks. A DTD before the root element
    is refused, so entity expansion (billion laughs) never happens."""
    parser = ElementTree.XMLPullParser(("start", "end"))
    prolog = True
    tail = b""
    try:
        while True:
            raise_if_cancelled(cancelled)
            chunk = stream.read(XML_CHUNK)
            if not chunk:
                break
            if prolog:
                window = tail + chunk
                refuse_dtd(window)
                tail = window[-32:]
                parser.feed(chunk)
                events = list(parser.read_events())
                prolog = not events
                yield from events
                continue
            parser.feed(chunk)
            yield from parser.read_events()
        parser.close()
        yield from parser.read_events()
    except ElementTree.ParseError as error:
        raise corrupt(f"invalid XML: {error}") from None


def parse_xml(data):
    """The root element of a small XML part, with the same DTD guard as iter_xml."""
    root = None
    for _, element in iter_xml(io.BytesIO(data)):
        if root is None:
            root = element
    if root is None:
        raise corrupt("an XML part is empty")
    return root


def namespace(tag):
    """'{ns}name' -> '{ns}'."""
    return tag[:tag.index("}") + 1] if tag.startswith("{") else ""


def local(tag):
    return tag.rpartition("}")[2]


class _Stream:
    """A zip member stream whose decompression errors become SheetFormatError."""

    def __init__(self, raw, name):
        self._raw = raw
        self._name = name

    def read(self, size=-1):
        try:
            return self._raw.read(size)
        except (zipfile.BadZipFile, zlib.error, EOFError, struct.error, ValueError) as error:
            raise corrupt(f"the part {self._name} cannot be decompressed: {error}") from None

    def close(self):
        self._raw.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        self.close()
        return False


class ZipPackage:
    """A zip container read with guard rails: entries that would expand past 2 GB (or absurdly compressed big
    ones) are refused, names are matched ignoring case and never resolve outside the archive."""

    def __init__(self, path):
        try:
            self.zip = zipfile.ZipFile(path)
        except (zipfile.BadZipFile, zipfile.LargeZipFile, EOFError, ValueError, struct.error) as error:
            raise corrupt(f"the zip container cannot be read: {error}") from None
        self.names = {}
        try:
            for info in self.zip.infolist():
                if info.file_size > MAX_PART or (info.file_size > SUSPICIOUS_PART
                                                 and info.file_size > MAX_RATIO * max(info.compress_size, 1)):
                    raise SheetFormatError("corrupt", f"The part {info.filename} would expand to {info.file_size:,} "
                                                      "bytes, which looks like a zip bomb; it was refused. Ask the "
                                                      "user to re-save the file in Excel or LibreOffice.")
                if not info.filename.endswith("/"):
                    self.names.setdefault(info.filename.lower(), info.filename)
        except BaseException:
            self.zip.close()
            raise

    def find(self, name):
        """The archive's own spelling of a part name, or None."""
        if not name:
            return None
        name = posixpath.normpath(name.replace("\\", "/").lstrip("/"))
        if name.startswith("..") or name == ".":
            return None
        return self.names.get(name.lower())

    def open(self, name):
        actual = self.find(name)
        if actual is None:
            raise corrupt(f"the part {name} is missing")
        try:
            return _Stream(self.zip.open(actual), actual)
        except NotImplementedError:
            raise unsupported("The file uses a zip compression method SheetStudio cannot read. Ask the user to "
                              "open it in Excel or LibreOffice and save it again.") from None
        except RuntimeError:
            raise SheetFormatError("encrypted", ENCRYPTED_MESSAGE) from None
        except (zipfile.BadZipFile, zlib.error, EOFError, struct.error, ValueError) as error:
            raise corrupt(f"the part {actual} cannot be read: {error}") from None

    def read(self, name, limit=MAX_SMALL_PART):
        with self.open(name) as stream:
            data = stream.read(limit + 1)
        if len(data) > limit:
            raise corrupt(f"the part {name} is unexpectedly large")
        return data

    def close(self):
        self.zip.close()
