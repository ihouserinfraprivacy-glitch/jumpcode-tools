# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""CSV and TSV reader. Encoding: BOM (UTF-8, UTF-16), else UTF-8 when the whole file is valid, else Windows-1252.
Separator: ; , tab or | by how consistent the field counts are over the first lines, outside quotes; Excel's
"sep=;" first line is honoured and skipped. Values are the strings exactly as written; empty fields are None."""

import codecs
import collections
import csv
import io
import os
import re

from .common import SheetFormatError, SheetInfo, Workbook, CANCEL_EVERY, UNSUPPORTED_MESSAGE, raise_if_cancelled, unsupported

SEPARATORS = ("\t", ";", ",", "|")
SEPARATOR_NAMES = {"tab": "\t", "\\t": "\t", "semicolon": ";", "comma": ",", "pipe": "|"}
_SAMPLE = 1 << 18
_SCAN_CHUNK = 1 << 20
_DETECT_ROWS = 50
_FIELD_LIMIT = 64 * 1024 * 1024
_HINT = re.compile(r'"?sep=(?P<separator>[^\r\n"])"?[ \t]*(?:\r\n|\n|\r|$)', re.IGNORECASE)
_CONTROL = re.compile("[\x00-\x08\x0b\x0e-\x19\x1b-\x1f\x7f]")
_HIGH_BYTES = bytes(range(128, 256))
_BREAK_OR_QUOTE = re.compile('\r\n|\r|\n|"')


class DelimitedWorkbook(Workbook):
    """One sheet named after the file; rows stream through the csv module."""

    format = "csv"

    def __init__(self, path, forced=None, encoding=None, separator=None, cancelled=None):
        super().__init__(cancelled)
        self._path = path
        size = os.path.getsize(path)
        with open(path, "rb") as handle:
            sample = handle.read(_SAMPLE)
        complete = len(sample) >= size
        if encoding:
            self._encoding = self._forced_encoding(encoding, sample)
        else:
            self._encoding = self._detect_encoding(sample)
        text = _decode(sample, self._encoding, complete)
        _refuse_binary(text)
        hint = _HINT.match(text.lstrip("﻿"))
        self._skip_hint = bool(hint)
        if hint:
            text = text.lstrip("﻿")[hint.end():]
        stem = os.path.splitext(os.path.basename(path))[0] or "Sheet1"
        tab_first = forced == "tsv" or path.lower().endswith((".tsv", ".tab"))
        if separator:
            chosen = _separator_argument(separator)
        elif hint:
            chosen = hint.group("separator")
            self.warn(f"the first line 'sep={chosen}' is an Excel hint and was skipped")
        elif forced == "tsv":
            chosen = "\t"
        else:
            chosen = self._detect_separator(text, complete, tab_first)
        self._separator = chosen
        self.format = "tsv" if chosen == "\t" else "csv"
        self.sheets = [SheetInfo(stem, False, False, None, None)]
        self.meta.update({"encoding": self._encoding, "separator": chosen, "quote": '"',
                          "lineEnding": _line_ending(text), "bytes": size})

    # ------------------------------------------------------------ encoding
    def _forced_encoding(self, encoding, sample):
        try:
            name = codecs.lookup(encoding).name
        except LookupError:
            raise SheetFormatError("invalid", f"Unknown encoding {encoding!r}. Use utf-8, utf-16, cp1252 or "
                                              "latin-1, or leave it out to detect it.") from None
        if name == "utf-8" and sample.startswith(codecs.BOM_UTF8):
            name = "utf-8-sig"
        try:
            codecs.getincrementaldecoder(name)("strict").decode(sample, final=False)
        except UnicodeDecodeError:
            self.warn(f"the file is not valid {encoding}; the bytes that are not were replaced by �")
        return name

    def _detect_encoding(self, sample):
        if sample.startswith(codecs.BOM_UTF8):
            return "utf-8-sig"
        if sample.startswith(codecs.BOM_UTF16_LE) or sample.startswith(codecs.BOM_UTF16_BE):
            return "utf-16"
        bomless = _utf16_without_bom(sample)
        if bomless:
            return bomless
        return self._utf8_or_cp1252()

    def _utf8_or_cp1252(self):
        """UTF-8 when the whole file decodes (or almost: a few stray bytes among many valid accents), else cp1252."""
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        bad = high = 0
        with open(self._path, "rb") as handle:
            while True:
                chunk = handle.read(_SCAN_CHUNK)
                if not chunk:
                    break
                raise_if_cancelled(self._cancelled)
                if chunk.isascii() and not decoder.getstate()[0]:
                    continue
                bad += decoder.decode(chunk).count("�")
                high += len(chunk) - len(chunk.translate(None, _HIGH_BYTES))
        bad += decoder.decode(b"", final=True).count("�")
        if not bad:
            return "utf-8"
        if bad * 20 <= high:
            self.warn(f"{bad} bytes are not valid UTF-8 and were replaced by �")
            return "utf-8"
        return "cp1252"

    # ------------------------------------------------------------ separator
    def _detect_separator(self, text, complete, tab_first):
        if not complete:
            cut = max(text.rfind("\n"), text.rfind("\r"))
            if cut > 0:
                text = text[:cut]
        order = SEPARATORS if tab_first else (";", ",", "\t", "|")
        best = None
        for priority, separator in enumerate(order):
            counts = []
            try:
                for row in csv.reader(io.StringIO(text, newline=""), delimiter=separator, quotechar='"', strict=False):
                    if row:
                        counts.append(len(row))
                        if len(counts) >= _DETECT_ROWS:
                            break
            except csv.Error:
                continue
            consistency, modal = _score(counts)
            key = (consistency, -priority)
            if consistency and (best is None or key > best[0]):
                best = (key, separator, modal)
        if best is None:
            return "\t" if tab_first else ","
        (consistency, _), separator, modal = best
        if consistency < 1:
            self.warn(f"some of the first rows have a different number of fields (most have {modal})")
        return separator

    # ------------------------------------------------------------ rows
    def _rows(self, index):
        if csv.field_size_limit() < _FIELD_LIMIT:
            csv.field_size_limit(_FIELD_LIMIT)
        with open(self._path, "r", encoding=self._encoding, errors="replace", newline="") as handle:
            if self._skip_hint:
                handle.readline()
            reader = csv.reader(handle, delimiter=self._separator, quotechar='"', strict=False)
            count = 0
            try:
                for row in reader:
                    count += 1
                    if count % CANCEL_EVERY == 0:
                        raise_if_cancelled(self._cancelled)
                    values = [value or None for value in row]
                    while values and values[-1] is None:
                        values.pop()
                    if count == 1 and values and values[0] and values[0].startswith("﻿"):
                        values[0] = values[0][1:] or None
                    yield values
            except csv.Error as error:
                raise SheetFormatError("corrupt", f"Line {reader.line_num} cannot be read ({error}); a quote (\") "
                                                  "is probably not closed. Ask the user to check the file, or try "
                                                  "another separator.") from None


def _separator_argument(separator):
    value = SEPARATOR_NAMES.get(separator.lower(), separator) if isinstance(separator, str) else None
    if not value or len(value) != 1 or value in "\r\n\"":
        raise SheetFormatError("invalid", f"The separator must be one character such as ; , | or tab, not "
                                          f"{separator!r}.")
    return value


def _decode(sample, encoding, complete):
    try:
        decoder = codecs.getincrementaldecoder(encoding)("replace")
    except LookupError:
        decoder = codecs.getincrementaldecoder("cp1252")("replace")
    return decoder.decode(sample, final=complete)


def _utf16_without_bom(sample):
    head = sample[:4096]
    half = len(head) // 2
    if half < 2:
        return None
    even = head[0::2].count(0)
    odd = head[1::2].count(0)
    if odd > half * 0.4 and even < half * 0.05:
        return "utf-16-le"
    if even > half * 0.4 and odd < half * 0.05:
        return "utf-16-be"
    return None


def _refuse_binary(text):
    probe = text[:65536]
    if len(_CONTROL.findall(probe)) > max(4, len(probe) // 100):
        raise unsupported(UNSUPPORTED_MESSAGE)
    start = probe.lstrip("﻿ \t\r\n")[:4096].lower()
    if start.startswith("<"):
        lowered = probe.lower()
        if "urn:schemas-microsoft-com:office:spreadsheet" in lowered:
            raise unsupported("This is an Excel 2003 XML spreadsheet. Ask the user to open it in Excel and save it as "
                              ".xlsx, then open that file.")
        if "<html" in lowered or "<table" in lowered or start.startswith("<!doctype html"):
            raise unsupported("This file is a web page (HTML) saved with a spreadsheet name, as many banks and systems "
                              "export. Ask the user to open it in Excel and save it as .xlsx or .csv.")


def _score(counts):
    """(share of rows with the most common field count, that count); 0 when rows would have a single field."""
    if not counts:
        return 0.0, 0
    modal, hits = max(collections.Counter(counts).items(), key=lambda item: (item[1], item[0]))
    if modal < 2:
        return 0.0, 0
    return round(hits / len(counts), 3), modal


def _line_ending(text):
    """The first line break outside quotes."""
    quoted = False
    for match in _BREAK_OR_QUOTE.finditer(text, 0, 65536):
        token = match.group(0)
        if token == '"':
            quoted = not quoted
        elif not quoted:
            return token
    return "\n"
