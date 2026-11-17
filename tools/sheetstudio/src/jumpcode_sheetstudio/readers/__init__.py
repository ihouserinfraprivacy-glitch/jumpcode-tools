# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Spreadsheet readers in plain Python: open_workbook() tells CSV/TSV, XLSX, XLS and ODS apart by content and returns
a workbook with `format`, `sheets`, `meta`, `rows(name)`, `formulas(name)` and `close()`."""

import os

from .common import (ENCRYPTED_MESSAGE, UNSUPPORTED_MESSAGE, CellError, SheetFormatError, SheetInfo, Workbook,
                     ZipPackage, raise_if_cancelled, unsupported)
from . import cfb, delimited, ods, xls, xlsx

FORMATS = ("csv", "tsv", "xlsx", "xls", "ods")
ZIP_MAGIC = (b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08")
ODS_MIMETYPE = b"application/vnd.oasis.opendocument.spreadsheet"


def open_workbook(path, *, format=None, encoding=None, separator=None, cancelled=None):
    """Opens a spreadsheet. format None detects it from the content; 'csv', 'tsv', 'xlsx', 'xls' or 'ods' forces it.
    encoding and separator only apply to CSV/TSV; cancelled() is checked while reading."""
    path = os.fspath(path)
    magic, size = _peek(path)
    raise_if_cancelled(cancelled)
    forced = _format(format)
    if forced in ("csv", "tsv"):
        return delimited.DelimitedWorkbook(path, forced, encoding, separator, cancelled)
    if magic.startswith(cfb.SIGNATURE):
        return _open_compound(path, forced, cancelled, size)
    if magic.startswith(ZIP_MAGIC):
        return _open_zip(path, forced, cancelled, size)
    if forced:
        raise unsupported(f"The file is not a .{forced} file (its first bytes do not match). Open it without forcing "
                          "the format so SheetStudio can detect what it is.")
    return delimited.DelimitedWorkbook(path, None, encoding, separator, cancelled)


def _peek(path):
    try:
        if os.path.isdir(path):
            raise SheetFormatError("not_found", "The path is a folder, not a file. Pass the path of a spreadsheet file.")
        size = os.path.getsize(path)
        with open(path, "rb") as handle:
            magic = handle.read(8)
    except FileNotFoundError:
        raise SheetFormatError("not_found", "The file does not exist. Check the path and try again.") from None
    except OSError as error:
        raise SheetFormatError("unreadable", f"The file cannot be opened ({error.strerror or error}). It may be open in "
                                             "another program; ask the user to close it and try again.") from None
    if size == 0:
        raise SheetFormatError("empty", "The file is empty (0 bytes); there is nothing to read. Ask the user whether "
                                        "this is the right file.")
    return magic, size


def _format(value):
    if value is None or value == "":
        return None
    name = str(value).lower().lstrip(".")
    if name not in FORMATS:
        raise SheetFormatError("invalid", f"Unknown format {value!r}; use one of {', '.join(FORMATS)}, or leave it out "
                                          "to detect it.")
    return name


def _open_compound(path, forced, cancelled, size):
    with cfb.CompoundFile(path) as compound:
        names = {name.casefold() for name in compound.names()}
        if "encryptedpackage" in names:
            raise SheetFormatError("encrypted", ENCRYPTED_MESSAGE)
        if forced in ("xlsx", "ods"):
            raise unsupported(f"This is a binary Office file (OLE2, like .xls), not .{forced}. Open it without forcing "
                              "the format.")
        return xls.XlsWorkbook(path, compound, cancelled, size)


def _open_zip(path, forced, cancelled, size):
    package = ZipPackage(path)
    try:
        kind = forced or _zip_kind(package)
        if kind == "xlsx":
            return xlsx.XlsxWorkbook(path, package, cancelled, size)
        if kind == "ods":
            return ods.OdsWorkbook(path, package, cancelled, size)
        raise unsupported("This is a zip-based file (like .xlsx or .ods), not .xls. Open it without forcing the "
                          "format.")
    except BaseException:
        package.close()
        raise


def _zip_kind(package):
    if package.find("mimetype"):
        mimetype = package.read("mimetype", limit=4096).strip()
        if mimetype.startswith(ODS_MIMETYPE):
            return "ods"
        if mimetype.startswith(b"application/vnd.oasis.opendocument."):
            raise unsupported("This is an OpenDocument file but not a spreadsheet (a text document or a presentation). "
                              "Ask the user for the spreadsheet itself.")
    if package.find("xl/workbook.bin"):
        raise unsupported("This is a binary Excel workbook (.xlsb). Ask the user to open it in Excel and save it as "
                          ".xlsx, then open that file.")
    workbook = xlsx.office_document(package)
    if package.find("xl/workbook.xml") or (workbook and package.find(workbook) and "/workbook" in workbook.lower()):
        return "xlsx"
    if package.find("content.xml") and package.find("META-INF/manifest.xml"):
        return "ods"
    if package.find("word/document.xml"):
        raise unsupported("This is a Word document (.docx), not a spreadsheet. Ask the user for the spreadsheet itself.")
    if package.find("ppt/presentation.xml"):
        raise unsupported("This is a PowerPoint presentation (.pptx), not a spreadsheet. Ask the user for the "
                          "spreadsheet itself.")
    raise unsupported("This zip file is not a spreadsheet. " + UNSUPPORTED_MESSAGE)


__all__ = ["open_workbook", "SheetFormatError", "CellError", "SheetInfo", "Workbook", "FORMATS"]
