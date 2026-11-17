# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""OLE2 / Compound File Binary (MS-CFB) reader: enough to list the streams at the root and read one, for .xls
workbooks and password-protected Office files. 512- and 4096-byte sectors, extra DIFAT sectors, the mini stream;
every sector chain is bounded, so loops in a damaged file end in an error instead of hanging."""

import array
import struct
import sys

from .common import corrupt

SIGNATURE = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
MAXREGSECT = 0xFFFFFFFA
DIFSECT = 0xFFFFFFFC
FATSECT = 0xFFFFFFFD
ENDOFCHAIN = 0xFFFFFFFE
FREESECT = 0xFFFFFFFF
NOSTREAM = 0xFFFFFFFF
STORAGE = 1
STREAM = 2
ROOT = 5


def _uint32_array(data):
    values = array.array("I")
    if values.itemsize != 4:
        values = array.array("L")
    values.frombytes(data[:len(data) - len(data) % 4])
    if sys.byteorder == "big":
        values.byteswap()
    return values


class _Entry:
    __slots__ = ("name", "kind", "left", "right", "child", "start", "size")


class CompoundFile:
    """Usage: with CompoundFile(path) as cf: cf.names(); cf.read('Workbook')."""

    def __init__(self, path):
        self._file = open(path, "rb")
        try:
            self._load()
        except BaseException:
            self._file.close()
            raise

    def close(self):
        self._file.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        self.close()
        return False

    # ------------------------------------------------------------ structure
    def _load(self):
        handle = self._file
        handle.seek(0, 2)
        self._size = handle.tell()
        handle.seek(0)
        header = handle.read(512)
        if len(header) < 512 or header[:8] != SIGNATURE:
            raise corrupt("the OLE2 header is incomplete")
        major, byte_order, sector_shift, mini_shift = struct.unpack_from("<HHHH", header, 26)
        if byte_order != 0xFFFE or sector_shift not in (9, 12) or not 2 <= mini_shift < sector_shift:
            raise corrupt("the OLE2 header is invalid")
        self._sector = 1 << sector_shift
        self._mini = 1 << mini_shift
        self._version = major
        (_, fat_count, first_directory, _, self._cutoff, first_mini_fat, _, first_difat,
         difat_count) = struct.unpack_from("<IIIIIIIII", header, 40)
        self._sectors = max(0, (self._size - self._sector + self._sector - 1) // self._sector)
        if fat_count > self._sectors + 1:
            raise corrupt("the OLE2 sector table is larger than the file")
        fat_sectors = [s for s in struct.unpack_from("<109I", header, 76)[:min(fat_count, 109)]]
        per_difat = self._sector // 4 - 1
        sector = first_difat
        visited = 0
        while len(fat_sectors) < fat_count and sector <= MAXREGSECT:
            visited += 1
            if visited > difat_count + 1 or visited > self._sectors:
                raise corrupt("the OLE2 DIFAT chain loops")
            entries = struct.unpack_from(f"<{per_difat + 1}I", self._read_sector(sector))
            fat_sectors.extend(entries[:per_difat])
            sector = entries[per_difat]
        fat_sectors = fat_sectors[:fat_count]
        if any(s > MAXREGSECT for s in fat_sectors) or len(fat_sectors) < fat_count:
            raise corrupt("the OLE2 sector table is incomplete")
        self._fat = _uint32_array(b"".join(self._read_sector(s) for s in fat_sectors))
        directory = self._read_chain(first_directory, self._fat, self._sector, None, self._read_sector)
        self._entries = []
        for offset in range(0, len(directory) - 127, 128):
            self._entries.append(self._entry(directory, offset))
        if not self._entries or self._entries[0].kind != ROOT:
            raise corrupt("the OLE2 directory has no root")
        root = self._entries[0]
        self._mini_stream = None
        self._mini_fat = None
        self._first_mini_fat = first_mini_fat
        self._root_size = root.size

    def _entry(self, data, offset):
        entry = _Entry()
        length = struct.unpack_from("<H", data, offset + 64)[0]
        length = min(max(length - 2, 0), 62)
        entry.name = data[offset:offset + length].decode("utf-16-le", "replace")
        entry.kind = data[offset + 66]
        entry.left, entry.right, entry.child = struct.unpack_from("<III", data, offset + 68)
        entry.start = struct.unpack_from("<I", data, offset + 116)[0]
        entry.size = struct.unpack_from("<Q", data, offset + 120)[0]
        if self._version == 3:
            entry.size &= 0xFFFFFFFF
        return entry

    def _read_sector(self, number):
        if number >= self._sectors:
            raise corrupt("an OLE2 sector is past the end of the file")
        self._file.seek((number + 1) * self._sector)
        data = self._file.read(self._sector)
        if len(data) < self._sector:
            data += b"\0" * (self._sector - len(data))
        return data

    def _chain(self, start, table, needed):
        """Sector numbers of a chain; stops after `needed` sectors and never follows more links than the table has."""
        chain = []
        seen = bytearray(len(table))
        sector = start
        limit = len(table)
        while sector != ENDOFCHAIN and (needed is None or len(chain) < needed):
            if sector >= limit:
                raise corrupt("an OLE2 sector chain is broken")
            if seen[sector]:
                raise corrupt("an OLE2 sector chain loops")
            seen[sector] = 1
            chain.append(sector)
            sector = table[sector]
        if needed is not None and len(chain) < needed:
            raise corrupt("an OLE2 stream is shorter than its size")
        return chain

    def _read_chain(self, start, table, unit, size, reader):
        needed = None if size is None else (size + unit - 1) // unit
        if needed == 0:
            return b""
        chain = self._chain(start, table, needed)
        if reader is self._read_sector:
            data = self._read_runs(chain)
        else:
            data = b"".join(reader(sector) for sector in chain)
        return data if size is None else data[:size]

    def _read_runs(self, chain):
        """Reads consecutive sectors in one call."""
        parts = []
        index = 0
        while index < len(chain):
            first = chain[index]
            last = first
            while index + 1 < len(chain) and chain[index + 1] == last + 1:
                index += 1
                last += 1
            if last >= self._sectors:
                raise corrupt("an OLE2 sector is past the end of the file")
            self._file.seek((first + 1) * self._sector)
            data = self._file.read((last - first + 1) * self._sector)
            parts.append(data + b"\0" * ((last - first + 1) * self._sector - len(data)))
            index += 1
        return b"".join(parts)

    def _read_mini_sector(self, number):
        offset = number * self._mini
        if offset + self._mini > len(self._mini_stream):
            raise corrupt("an OLE2 mini sector is past the end of the mini stream")
        return self._mini_stream[offset:offset + self._mini]

    # ------------------------------------------------------------ streams
    def _root_children(self):
        root = self._entries[0]
        result = []
        pending = [root.child]
        seen = set()
        while pending:
            index = pending.pop()
            if index == NOSTREAM or index in seen or index >= len(self._entries):
                continue
            seen.add(index)
            entry = self._entries[index]
            pending.extend((entry.left, entry.right))
            if entry.kind in (STORAGE, STREAM):
                result.append(entry)
        return result

    def names(self):
        """Names of the streams and storages at the root."""
        return [entry.name for entry in self._root_children()]

    def has(self, name):
        return self._find(name) is not None

    def _find(self, name):
        folded = name.casefold()
        for entry in self._root_children():
            if entry.kind == STREAM and entry.name.casefold() == folded:
                return entry
        return None

    def read(self, name):
        """The bytes of a stream at the root."""
        entry = self._find(name)
        if entry is None:
            raise corrupt(f"the stream {name} is missing")
        if entry.size > self._size * 2 + 65536:
            raise corrupt(f"the stream {name} is larger than the file")
        if entry.size < self._cutoff:
            if self._mini_stream is None:
                root = self._entries[0]
                self._mini_stream = self._read_chain(root.start, self._fat, self._sector, root.size, self._read_sector)
                mini_sectors = (len(self._mini_stream) + self._mini - 1) // self._mini
                table = self._read_chain(self._first_mini_fat, self._fat, self._sector, None, self._read_sector) \
                    if self._first_mini_fat <= MAXREGSECT else b""
                self._mini_fat = _uint32_array(table)[:max(mini_sectors, 0)] if table else array.array("I")
            return self._read_chain(entry.start, self._mini_fat, self._mini, entry.size, self._read_mini_sector)
        return self._read_chain(entry.start, self._fat, self._sector, entry.size, self._read_sector)
