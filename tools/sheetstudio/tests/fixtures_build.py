# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Builds test spreadsheets from the published formats, since no office suite runs here: XLSX packages shaped like
Excel writes them (ECMA-376), ODS packages (ODF 1.2), OLE2 compound files (MS-CFB, 512- and 4096-byte sectors,
mini stream, extra DIFAT sectors) and BIFF8 workbook streams (MS-XLS) with an SST split across CONTINUE records."""

import struct
import zipfile

MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
RELS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PACKAGE_RELS = "http://schemas.openxmlformats.org/package/2006/relationships"
DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'


def write_zip(path, parts, stored=("mimetype",)):
    """parts: [(name, str | bytes)] in order; names in `stored` are not compressed (the ODS mimetype)."""
    with zipfile.ZipFile(path, "w") as archive:
        for name, data in parts:
            if isinstance(data, str):
                data = data.encode("utf-8")
            archive.writestr(name, data, zipfile.ZIP_STORED if name in stored else zipfile.ZIP_DEFLATED)
    return path


# ---------------------------------------------------------------- XLSX (what Excel 365 writes)

STYLES = (DECLARATION + f'<styleSheet xmlns="{MAIN}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" '
          'mc:Ignorable="x14ac x16r2 xr" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac" '
          'xmlns:x16r2="http://schemas.microsoft.com/office/spreadsheetml/2015/02/main" '
          'xmlns:xr="http://schemas.microsoft.com/office/spreadsheetml/2014/revision">'
          '<numFmts count="4">'
          '<numFmt numFmtId="164" formatCode="&quot;R$&quot;\\ #,##0.00"/>'
          '<numFmt numFmtId="165" formatCode="[$-416]dd/mm/yyyy;@"/>'
          '<numFmt numFmtId="166" formatCode="[h]:mm:ss"/>'
          '<numFmt numFmtId="167" formatCode="[$-F400]h:mm:ss\\ AM/PM"/>'
          '</numFmts>'
          '<fonts count="1" x14ac:knownFonts="1"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/>'
          '<scheme val="minor"/></font></fonts>'
          '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
          '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
          '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
          '<cellXfs count="11">'
          '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
          '<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
          '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
          '<xf numFmtId="22" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
          '<xf numFmtId="20" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
          '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
          '<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
          '<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
          '<xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
          '<xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
          '<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
          '</cellXfs>'
          '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
          '<dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>'
          '</styleSheet>')


def shared_strings(items):
    """items: plain strings, or raw <si> inner XML when they start with '<'."""
    body = []
    for item in items:
        if item.startswith("<"):
            body.append(f"<si>{item}</si>")
        else:
            space = ' xml:space="preserve"' if item != item.strip() else ""
            text = item.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            body.append(f"<si><t{space}>{text}</t></si>")
    return (DECLARATION + f'<sst xmlns="{MAIN}" count="{len(items) + 3}" uniqueCount="{len(items)}">'
            + "".join(body) + "</sst>")


def worksheet(rows_xml, dimension="A1", after="", sheet_data=None):
    """A worksheet part as Excel writes it; `after` goes after </sheetData> (protection, merges)."""
    data = sheet_data if sheet_data is not None else f"<sheetData>{rows_xml}</sheetData>"
    return (DECLARATION + f'<worksheet xmlns="{MAIN}" xmlns:r="{RELS}" '
            'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x14ac xr xr2 xr3" '
            'xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac" '
            'xmlns:xr="http://schemas.microsoft.com/office/spreadsheetml/2014/revision" '
            'xmlns:xr2="http://schemas.microsoft.com/office/spreadsheetml/2015/revision2" '
            'xmlns:xr3="http://schemas.microsoft.com/office/spreadsheetml/2016/revision3" '
            'xr:uid="{6B0D2C4A-1A51-4F2B-9C1E-2F0A5D7E8B11}">'
            f'<dimension ref="{dimension}"/><sheetViews><sheetView workbookViewId="0"/></sheetViews>'
            '<sheetFormatPr defaultRowHeight="15" x14ac:dyDescent="0.25"/>'
            f"{data}{after}"
            '<pageMargins left="0.511811024" right="0.511811024" top="0.787401575" bottom="0.787401575" header="0.31496062" '
            'footer="0.31496062"/></worksheet>')


def xlsx_package(path, sheets, strings=None, styles=STYLES, date1904=False, workbook_extra=""):
    """sheets: [{'name', 'xml', 'state': None|'hidden'|'veryHidden', 'rid': 'rIdN', 'target': 'worksheets/x.xml'}].
    Targets may be relative to xl/ or absolute (/xl/...), as the relationships allow."""
    types = ['<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
             '<Default Extension="xml" ContentType="application/xml"/>',
             '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>']
    relations = []
    entries = []
    parts = []
    for index, sheet in enumerate(sheets, 1):
        rid = sheet.get("rid", f"rId{index}")
        target = sheet.get("target", f"worksheets/sheet{index}.xml")
        part = target.lstrip("/") if target.startswith("/") else "xl/" + target
        types.append(f'<Override PartName="/{part}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>')
        relations.append(f'<Relationship Id="{rid}" Type="{RELS}/worksheet" Target="{target}"/>')
        state = f' state="{sheet["state"]}"' if sheet.get("state") else ""
        name = sheet["name"].replace("&", "&amp;").replace('"', "&quot;")
        entries.append(f'<sheet name="{name}" sheetId="{index}"{state} r:id="{rid}"/>')
        parts.append((part, sheet["xml"]))
    relations.append(f'<Relationship Id="rId90" Type="{RELS}/theme" Target="theme/theme1.xml"/>')
    relations.append(f'<Relationship Id="rId91" Type="{RELS}/styles" Target="styles.xml"/>')
    types.append('<Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>')
    types.append('<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>')
    if strings is not None:
        relations.append(f'<Relationship Id="rId92" Type="{RELS}/sharedStrings" Target="sharedStrings.xml"/>')
        types.append('<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>')
    types.append('<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>')
    types.append('<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>')
    properties = ' date1904="1"' if date1904 else ""
    workbook = (DECLARATION + f'<workbook xmlns="{MAIN}" xmlns:r="{RELS}" '
                'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x15 xr xr6 xr10 xr2" '
                'xmlns:x15="http://schemas.microsoft.com/office/spreadsheetml/2010/11/main" '
                'xmlns:xr="http://schemas.microsoft.com/office/spreadsheetml/2014/revision" '
                'xmlns:xr6="http://schemas.microsoft.com/office/spreadsheetml/2016/revision6" '
                'xmlns:xr10="http://schemas.microsoft.com/office/spreadsheetml/2016/revision10" '
                'xmlns:xr2="http://schemas.microsoft.com/office/spreadsheetml/2015/revision2">'
                '<fileVersion appName="xl" lastEdited="7" lowestEdited="7" rupBuild="27425"/>'
                f'<workbookPr{properties} defaultThemeVersion="166925"/>'
                '<xr:revisionPtr revIDLastSave="0" documentId="8_{3B9F7C1D-2E44-4B8A-A1C2-55D0E6F7A812}" '
                'xr6:coauthVersionLast="47" xr6:coauthVersionMax="47" xr10:uidLastSave="{00000000-0000-0000-0000-000000000000}"/>'
                f"{workbook_extra}"
                '<bookViews><workbookView xWindow="-120" yWindow="-120" windowWidth="29040" windowHeight="15720" '
                'xr2:uid="{A1E8B9F2-7C3D-4E5F-8A9B-0C1D2E3F4A5B}"/></bookViews>'
                f'<sheets>{"".join(entries)}</sheets><calcPr calcId="191029"/></workbook>')
    content = [("[Content_Types].xml", DECLARATION + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                + "".join(types) + "</Types>"),
               ("_rels/.rels", DECLARATION + f'<Relationships xmlns="{PACKAGE_RELS}">'
                f'<Relationship Id="rId3" Type="{RELS}/extended-properties" Target="docProps/app.xml"/>'
                '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
                f'<Relationship Id="rId1" Type="{RELS}/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
               ("xl/workbook.xml", workbook),
               ("xl/_rels/workbook.xml.rels", DECLARATION + f'<Relationships xmlns="{PACKAGE_RELS}">' + "".join(relations) + "</Relationships>")]
    content += parts
    content.append(("xl/theme/theme1.xml", DECLARATION + '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"/>'))
    content.append(("xl/styles.xml", styles))
    if strings is not None:
        content.append(("xl/sharedStrings.xml", strings))
    content.append(("docProps/core.xml", DECLARATION + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
                    'xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>Ana</dc:creator></cp:coreProperties>'))
    content.append(("docProps/app.xml", DECLARATION + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">'
                    "<Application>Microsoft Excel</Application></Properties>"))
    return write_zip(path, content)


# ---------------------------------------------------------------- ODS

ODS_NAMESPACES = ('xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" '
                  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" '
                  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" '
                  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" '
                  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" '
                  'xmlns:xlink="http://www.w3.org/1999/xlink" '
                  'xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0" '
                  'xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2" '
                  'xmlns:calcext="urn:org:documentfoundation:names:experimental:calc:xmlns:calcext:1.0"')


def ods_content(tables_xml, automatic_styles=""):
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            f'<office:document-content {ODS_NAMESPACES} office:version="1.2"><office:scripts/><office:font-face-decls/>'
            f"<office:automatic-styles>{automatic_styles}</office:automatic-styles>"
            f"<office:body><office:spreadsheet><table:calculation-settings table:automatic-find-labels=\"false\"/>"
            f"{tables_xml}<table:named-expressions/></office:spreadsheet></office:body></office:document-content>")


def ods_package(path, content, manifest_extra=""):
    manifest = ('<?xml version="1.0" encoding="UTF-8"?>\n<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" '
                'manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:version="1.2" '
                'manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/>'
                f'<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml">{manifest_extra}</manifest:file-entry>'
                '</manifest:manifest>')
    return write_zip(path, [("mimetype", "application/vnd.oasis.opendocument.spreadsheet"), ("content.xml", content),
                            ("styles.xml", f'<?xml version="1.0" encoding="UTF-8"?>\n<office:document-styles {ODS_NAMESPACES}/>'),
                            ("META-INF/manifest.xml", manifest)])


# ---------------------------------------------------------------- OLE2 compound file (MS-CFB)

FREESECT, ENDOFCHAIN, FATSECT, DIFSECT, NOSTREAM = 0xFFFFFFFF, 0xFFFFFFFE, 0xFFFFFFFD, 0xFFFFFFFC, 0xFFFFFFFF


def _directory_entry(name, kind, left, right, child, start, size):
    raw = name.encode("utf-16-le") + b"\0\0" if name else b""
    return struct.pack("<64sHBBIII16sIQQIQ", raw.ljust(64, b"\0"), len(raw), kind, 1, left, right, child,
                       b"\0" * 16, 0, 0, 0, start, size)


def cfb_bytes(streams, sector_shift=9, loop=False):
    """A compound file with `streams` ([(name, bytes)]) at the root. Streams under 4096 bytes go to the mini stream;
    with loop=True the second sector of the first big stream points back to its first (a damaged file)."""
    sector = 1 << sector_shift
    per = sector // 4
    mini = bytearray()
    mini_fat = []
    entries = []
    for name, data in streams:
        if len(data) < 4096:
            count = (len(data) + 63) // 64
            first = len(mini_fat)
            mini_fat += [first + i + 1 if i + 1 < count else ENDOFCHAIN for i in range(count)]
            mini += data + b"\0" * (count * 64 - len(data))
            entries.append([name, first if count else ENDOFCHAIN, len(data), None])
        else:
            entries.append([name, None, len(data), data])
    body = []
    chains = []

    def allocate(data):
        count = (len(data) + sector - 1) // sector
        start = sum(c for _, c in chains)
        chains.append((start, count))
        body.append(data + b"\0" * (count * sector - len(data)))
        return start

    for entry in entries:
        if entry[3] is not None:
            entry[1] = allocate(entry[3])
    mini_start = allocate(bytes(mini)) if mini else ENDOFCHAIN
    mini_fat_start = allocate(struct.pack(f"<{len(mini_fat)}I", *mini_fat)) if mini_fat else ENDOFCHAIN
    directory = [_directory_entry("Root Entry", 5, NOSTREAM, NOSTREAM, 1 if entries else NOSTREAM, mini_start, len(mini))]
    for index, (name, start, size, _) in enumerate(entries, 1):
        directory.append(_directory_entry(name, 2, NOSTREAM, index + 1 if index < len(entries) else NOSTREAM, NOSTREAM, start, size))
    while len(directory) * 128 % sector:
        directory.append(_directory_entry("", 0, NOSTREAM, NOSTREAM, NOSTREAM, 0, 0))
    directory_bytes = b"".join(directory)
    directory_start = allocate(directory_bytes)
    used = sum(c for _, c in chains)
    fat_count = 1
    while True:
        difat_count = 0 if fat_count <= 109 else (fat_count - 109 + per - 2) // (per - 1)
        if fat_count * per >= used + fat_count + difat_count:
            break
        fat_count += 1
    fat_start = used
    difat_start = used + fat_count
    table = [FREESECT] * (fat_count * per)
    for start, count in chains:
        for i in range(count):
            table[start + i] = start + i + 1 if i + 1 < count else ENDOFCHAIN
    for i in range(fat_count):
        table[fat_start + i] = FATSECT
    for i in range(difat_count):
        table[difat_start + i] = DIFSECT
    if loop:
        start, count = chains[0]
        table[start + 1] = start
    fat_numbers = list(range(fat_start, fat_start + fat_count))
    header_difat = (fat_numbers[:109] + [FREESECT] * 109)[:109]
    difat_sectors = []
    rest = fat_numbers[109:]
    for index in range(difat_count):
        chunk = rest[index * (per - 1):(index + 1) * (per - 1)]
        chunk += [FREESECT] * (per - 1 - len(chunk))
        following = difat_start + index + 1 if index + 1 < difat_count else ENDOFCHAIN
        difat_sectors.append(struct.pack(f"<{per}I", *chunk, following))
    major = 4 if sector_shift == 12 else 3
    header = (b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\0" * 16
              + struct.pack("<HHHHH", 0x003E, major, 0xFFFE, sector_shift, 6) + b"\0" * 6
              + struct.pack("<IIIIIIIII", len(directory_bytes) // sector if major == 4 else 0, fat_count, directory_start, 0,
                            4096, mini_fat_start, len(mini_fat) * 4 // sector + (1 if len(mini_fat) * 4 % sector else 0),
                            difat_start if difat_count else ENDOFCHAIN, difat_count)
              + struct.pack("<109I", *header_difat))
    header += b"\0" * (sector - len(header))
    fat_bytes = struct.pack(f"<{len(table)}I", *table)
    return header + b"".join(body) + fat_bytes + b"".join(difat_sectors)


# ---------------------------------------------------------------- BIFF8 (MS-XLS)

def record(rid, data=b""):
    return struct.pack("<HH", rid, len(data)) + data


def bof(kind):
    return record(0x0809, struct.pack("<HHHHII", 0x0600, kind, 0x0DBB, 0x07CC, 0x000100D1, 0x00000606))


def eof():
    return record(0x000A)


def unicode_string(text, length_bytes=2):
    wide = any(ord(char) > 255 for char in text)
    raw = text.encode("utf-16-le") if wide else text.encode("latin-1")
    count = struct.pack("<H", len(text)) if length_bytes == 2 else bytes([len(text)])
    return count + bytes([1 if wide else 0]) + raw


def _piece(text, room):
    count = min(len(text), room)
    if all(ord(char) < 256 for char in text[:count]):
        return text[:count], False
    return text[:min(len(text), room // 2)], True


def sst_records(items, limit=8224):
    """SST + CONTINUE records. items: str or (text, rich runs, extended bytes). Records hold at most `limit` bytes; a
    character array that does not fit continues in the next record after a one-byte 8-bit/UTF-16 flag, like Excel."""
    segments = [bytearray(struct.pack("<II", len(items) + 5, len(items)))]

    def room():
        return limit - len(segments[-1])

    def raw(data):
        while data:
            if room() == 0:
                segments.append(bytearray())
            take = data[:room()]
            segments[-1] += take
            data = data[len(take):]

    for item in items:
        text, runs, extended = (item, 0, b"") if isinstance(item, str) else item
        header_size = 3 + (2 if runs else 0) + (4 if extended else 0)
        if room() < header_size:
            segments.append(bytearray())
        piece, wide = _piece(text, room() - header_size)
        header = struct.pack("<H", len(text)) + bytes([(0x08 if runs else 0) | (0x04 if extended else 0) | (1 if wide else 0)])
        if runs:
            header += struct.pack("<H", runs)
        if extended:
            header += struct.pack("<I", len(extended))
        segments[-1] += header + (piece.encode("utf-16-le") if wide else piece.encode("latin-1"))
        rest = text[len(piece):]
        while rest:
            segments.append(bytearray())
            piece, wide = _piece(rest, limit - 1)
            segments[-1] += bytes([1 if wide else 0]) + (piece.encode("utf-16-le") if wide else piece.encode("latin-1"))
            rest = rest[len(piece):]
        raw(b"".join(struct.pack("<HH", index * 2, 1) for index in range(runs)))
        raw(extended)
    return record(0x00FC, bytes(segments[0])) + b"".join(record(0x003C, bytes(segment)) for segment in segments[1:])


def rk_int(value, hundredths=False):
    return ((value & 0x3FFFFFFF) << 2) | 2 | (1 if hundredths else 0)


def rk_float(value, hundredths=False):
    bits = struct.unpack("<Q", struct.pack("<d", value))[0]
    assert bits & 0xFFFFFFFF == 0, "RK keeps only the top 30 bits of a double"
    return ((bits >> 32) & 0xFFFFFFFC) | (1 if hundredths else 0)


def number(row, col, xf, value):
    return record(0x0203, struct.pack("<HHHd", row, col, xf, value))


def rk(row, col, xf, value):
    return record(0x027E, struct.pack("<HHHI", row, col, xf, value))


def mulrk(row, col, items):
    data = struct.pack("<HH", row, col) + b"".join(struct.pack("<HI", xf, value) for xf, value in items)
    return record(0x00BD, data + struct.pack("<H", col + len(items) - 1))


def labelsst(row, col, xf, index):
    return record(0x00FD, struct.pack("<HHHI", row, col, xf, index))


def label(row, col, xf, text):
    return record(0x0204, struct.pack("<HHH", row, col, xf) + unicode_string(text))


def boolerr(row, col, xf, value, error=False):
    return record(0x0205, struct.pack("<HHHBB", row, col, xf, value, 1 if error else 0))


def blank(row, col, xf):
    return record(0x0201, struct.pack("<HHH", row, col, xf))


def formula(row, col, xf, result):
    """FORMULA with a cached result (8 bytes) and a tiny token array (=1, ptgInt)."""
    return record(0x0006, struct.pack("<HHH", row, col, xf) + result + struct.pack("<HIH", 0, 0, 3) + b"\x1e\x01\x00")


def result_number(value):
    return struct.pack("<d", value)


def result_string():
    return bytes([0, 0, 0, 0, 0, 0, 0xFF, 0xFF])


def result_bool(value):
    return bytes([1, 0, 1 if value else 0, 0, 0, 0, 0xFF, 0xFF])


def result_error(code):
    return bytes([2, 0, code, 0, 0, 0, 0xFF, 0xFF])


def result_empty():
    return bytes([3, 0, 0, 0, 0, 0, 0xFF, 0xFF])


def string(text):
    return record(0x0207, unicode_string(text))


def dimension(rows, cols):
    return record(0x0200, struct.pack("<IIHHH", 0, rows, 0, cols, 0))


def merged(*ranges):
    return record(0x00E5, struct.pack("<H", len(ranges)) + b"".join(struct.pack("<HHHH", *item) for item in ranges))


def protect():
    return record(0x0012, struct.pack("<H", 1))


def workbook_stream(sheets, strings=(), formats=(), xf_formats=(), date1904=False, filepass=False, sst_limit=8224):
    """The 'Workbook' stream. sheets: [(name, hidden state, sheet type, records inside BOF/EOF)]; sheet type 0 is
    a worksheet and 2 a chart sheet."""
    head = [bof(0x0005)]
    if filepass:
        head.append(record(0x002F, struct.pack("<HHH", 1, 1, 1) + b"\x11" * 48))
    head.append(record(0x0042, struct.pack("<H", 1200)))
    head.append(record(0x0022, struct.pack("<H", 1 if date1904 else 0)))
    for number_id, code in formats:
        head.append(record(0x041E, struct.pack("<H", number_id) + unicode_string(code)))
    for format_id in xf_formats:
        head.append(record(0x00E0, struct.pack("<HH", 0, format_id) + b"\0" * 16))
    tail = [sst_records(list(strings), sst_limit) if strings else b"", eof()]

    def boundsheets(offsets):
        return [record(0x0085, struct.pack("<IBB", offset, state, kind) + unicode_string(name, 1))
                for offset, (name, state, kind, _) in zip(offsets, sheets)]

    size = len(b"".join(head)) + len(b"".join(boundsheets([0] * len(sheets)))) + len(b"".join(tail))
    bodies = [bof(0x0020 if kind == 2 else 0x0010) + body + eof() for _, _, kind, body in sheets]
    offsets = []
    for body in bodies:
        offsets.append(size)
        size += len(body)
    return b"".join(head) + b"".join(boundsheets(offsets)) + b"".join(tail) + b"".join(bodies)
