# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""QR Code encoder (ISO/IEC 18004) in byte mode, with PNG, SVG and data URL output.

Pure standard library, used to draw the Pix BR Code ("copia e cola") payloads that the local gateway returns.
The text is encoded as UTF-8 bytes in a single byte-mode segment, in the smallest version 1-40 that holds it.
"""

import base64
import re
import struct
import zlib

# Error correction level -> its two format information bits (ISO/IEC 18004 Table 12) and its column in _BLOCKS.
_LEVEL_BITS = {"L": 0b01, "M": 0b00, "Q": 0b11, "H": 0b10}
_LEVEL_COLUMN = {"L": 0, "M": 1, "Q": 2, "H": 3}

# ISO/IEC 18004 Table 9, one row per version and one entry per level (L, M, Q, H):
# (EC codewords per block, blocks in group 1, data codewords per group 1 block,
#  blocks in group 2, data codewords per group 2 block).
_BLOCKS = (
    ((7, 1, 19, 0, 0), (10, 1, 16, 0, 0), (13, 1, 13, 0, 0), (17, 1, 9, 0, 0)),                  # 1
    ((10, 1, 34, 0, 0), (16, 1, 28, 0, 0), (22, 1, 22, 0, 0), (28, 1, 16, 0, 0)),                # 2
    ((15, 1, 55, 0, 0), (26, 1, 44, 0, 0), (18, 2, 17, 0, 0), (22, 2, 13, 0, 0)),                # 3
    ((20, 1, 80, 0, 0), (18, 2, 32, 0, 0), (26, 2, 24, 0, 0), (16, 4, 9, 0, 0)),                 # 4
    ((26, 1, 108, 0, 0), (24, 2, 43, 0, 0), (18, 2, 15, 2, 16), (22, 2, 11, 2, 12)),             # 5
    ((18, 2, 68, 0, 0), (16, 4, 27, 0, 0), (24, 4, 19, 0, 0), (28, 4, 15, 0, 0)),                # 6
    ((20, 2, 78, 0, 0), (18, 4, 31, 0, 0), (18, 2, 14, 4, 15), (26, 4, 13, 1, 14)),              # 7
    ((24, 2, 97, 0, 0), (22, 2, 38, 2, 39), (22, 4, 18, 2, 19), (26, 4, 14, 2, 15)),             # 8
    ((30, 2, 116, 0, 0), (22, 3, 36, 2, 37), (20, 4, 16, 4, 17), (24, 4, 12, 4, 13)),            # 9
    ((18, 2, 68, 2, 69), (26, 4, 43, 1, 44), (24, 6, 19, 2, 20), (28, 6, 15, 2, 16)),            # 10
    ((20, 4, 81, 0, 0), (30, 1, 50, 4, 51), (28, 4, 22, 4, 23), (24, 3, 12, 8, 13)),             # 11
    ((24, 2, 92, 2, 93), (22, 6, 36, 2, 37), (26, 4, 20, 6, 21), (28, 7, 14, 4, 15)),            # 12
    ((26, 4, 107, 0, 0), (22, 8, 37, 1, 38), (24, 8, 20, 4, 21), (22, 12, 11, 4, 12)),           # 13
    ((30, 3, 115, 1, 116), (24, 4, 40, 5, 41), (20, 11, 16, 5, 17), (24, 11, 12, 5, 13)),        # 14
    ((22, 5, 87, 1, 88), (24, 5, 41, 5, 42), (30, 5, 24, 7, 25), (24, 11, 12, 7, 13)),           # 15
    ((24, 5, 98, 1, 99), (28, 7, 45, 3, 46), (24, 15, 19, 2, 20), (30, 3, 15, 13, 16)),          # 16
    ((28, 1, 107, 5, 108), (28, 10, 46, 1, 47), (28, 1, 22, 15, 23), (28, 2, 14, 17, 15)),       # 17
    ((30, 5, 120, 1, 121), (26, 9, 43, 4, 44), (28, 17, 22, 1, 23), (28, 2, 14, 19, 15)),        # 18
    ((28, 3, 113, 4, 114), (26, 3, 44, 11, 45), (26, 17, 21, 4, 22), (26, 9, 13, 16, 14)),       # 19
    ((28, 3, 107, 5, 108), (26, 3, 41, 13, 42), (30, 15, 24, 5, 25), (28, 15, 15, 10, 16)),      # 20
    ((28, 4, 116, 4, 117), (26, 17, 42, 0, 0), (28, 17, 22, 6, 23), (30, 19, 16, 6, 17)),        # 21
    ((28, 2, 111, 7, 112), (28, 17, 46, 0, 0), (30, 7, 24, 16, 25), (24, 34, 13, 0, 0)),         # 22
    ((30, 4, 121, 5, 122), (28, 4, 47, 14, 48), (30, 11, 24, 14, 25), (30, 16, 15, 14, 16)),     # 23
    ((30, 6, 117, 4, 118), (28, 6, 45, 14, 46), (30, 11, 24, 16, 25), (30, 30, 16, 2, 17)),      # 24
    ((26, 8, 106, 4, 107), (28, 8, 47, 13, 48), (30, 7, 24, 22, 25), (30, 22, 15, 13, 16)),      # 25
    ((28, 10, 114, 2, 115), (28, 19, 46, 4, 47), (28, 28, 22, 6, 23), (30, 33, 16, 4, 17)),      # 26
    ((30, 8, 122, 4, 123), (28, 22, 45, 3, 46), (30, 8, 23, 26, 24), (30, 12, 15, 28, 16)),      # 27
    ((30, 3, 117, 10, 118), (28, 3, 45, 23, 46), (30, 4, 24, 31, 25), (30, 11, 15, 31, 16)),     # 28
    ((30, 7, 116, 7, 117), (28, 21, 45, 7, 46), (30, 1, 23, 37, 24), (30, 19, 15, 26, 16)),      # 29
    ((30, 5, 115, 10, 116), (28, 19, 47, 10, 48), (30, 15, 24, 25, 25), (30, 23, 15, 25, 16)),   # 30
    ((30, 13, 115, 3, 116), (28, 2, 46, 29, 47), (30, 42, 24, 1, 25), (30, 23, 15, 28, 16)),     # 31
    ((30, 17, 115, 0, 0), (28, 10, 46, 23, 47), (30, 10, 24, 35, 25), (30, 19, 15, 35, 16)),     # 32
    ((30, 17, 115, 1, 116), (28, 14, 46, 21, 47), (30, 29, 24, 19, 25), (30, 11, 15, 46, 16)),   # 33
    ((30, 13, 115, 6, 116), (28, 14, 46, 23, 47), (30, 44, 24, 7, 25), (30, 59, 16, 1, 17)),     # 34
    ((30, 12, 121, 7, 122), (28, 12, 47, 26, 48), (30, 39, 24, 14, 25), (30, 22, 15, 41, 16)),   # 35
    ((30, 6, 121, 14, 122), (28, 6, 47, 34, 48), (30, 46, 24, 10, 25), (30, 2, 15, 64, 16)),     # 36
    ((30, 17, 122, 4, 123), (28, 29, 46, 14, 47), (30, 49, 24, 10, 25), (30, 24, 15, 46, 16)),   # 37
    ((30, 4, 122, 18, 123), (28, 13, 46, 32, 47), (30, 48, 24, 14, 25), (30, 42, 15, 32, 16)),   # 38
    ((30, 20, 117, 4, 118), (28, 40, 47, 7, 48), (30, 43, 24, 22, 25), (30, 10, 15, 67, 16)),    # 39
    ((30, 19, 118, 6, 119), (28, 18, 47, 31, 48), (30, 34, 24, 34, 25), (30, 20, 15, 61, 16)),   # 40
)

# ISO/IEC 18004 Annex E: row/column coordinates of the alignment pattern centers per version.
_ALIGNMENT = (
    (), (6, 18), (6, 22), (6, 26), (6, 30), (6, 34),
    (6, 22, 38), (6, 24, 42), (6, 26, 46), (6, 28, 50), (6, 30, 54), (6, 32, 58), (6, 34, 62),
    (6, 26, 46, 66), (6, 26, 48, 70), (6, 26, 50, 74), (6, 30, 54, 78), (6, 30, 56, 82), (6, 30, 58, 86),
    (6, 34, 62, 90),
    (6, 28, 50, 72, 94), (6, 26, 50, 74, 98), (6, 30, 54, 78, 102), (6, 28, 54, 80, 106),
    (6, 32, 58, 84, 110), (6, 30, 58, 86, 114), (6, 34, 62, 90, 118),
    (6, 26, 50, 74, 98, 122), (6, 30, 54, 78, 102, 126), (6, 26, 52, 78, 104, 130),
    (6, 30, 56, 82, 108, 134), (6, 34, 60, 86, 112, 138), (6, 30, 58, 86, 114, 142),
    (6, 34, 62, 90, 118, 146),
    (6, 30, 54, 78, 102, 126, 150), (6, 24, 50, 76, 102, 128, 154), (6, 28, 54, 80, 106, 132, 158),
    (6, 32, 58, 84, 110, 136, 162), (6, 26, 54, 82, 110, 138, 166), (6, 30, 58, 86, 114, 142, 170),
)

# The eight data mask conditions (ISO/IEC 18004 Table 10); a module is inverted where the condition holds.
# Every condition repeats every 12 rows and every 12 columns (_MASK_PERIOD).
_MASK_PERIOD = 12
_MASKS = (
    lambda row, col: (row + col) % 2 == 0,
    lambda row, col: row % 2 == 0,
    lambda row, col: col % 3 == 0,
    lambda row, col: (row + col) % 3 == 0,
    lambda row, col: (row // 2 + col // 3) % 2 == 0,
    lambda row, col: (row * col) % 2 + (row * col) % 3 == 0,
    lambda row, col: ((row * col) % 2 + (row * col) % 3) % 2 == 0,
    lambda row, col: ((row + col) % 2 + (row * col) % 3) % 2 == 0,
)

_RUNS = re.compile(r"0{5,}|1{5,}")
_DARK_RUNS = re.compile(r"1+")
# bytes(list of bools) -> b"0"/b"1" digits, for turning a row of modules into a bit mask.
_DIGITS = bytes.maketrans(b"\x00\x01", b"01")
_INVERTED_DIGITS = bytes.maketrans(b"\x00\x01", b"10")
# A 1:1:3:1:1 finder-like pattern with four light modules on one side (penalty rule 3).
_FINDER_LIKE = ("10111010000", "00001011101")


def _galois_tables():
    """Exponent and logarithm tables of GF(256) with the primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11D)."""
    exp = [0] * 510
    log = [0] * 256
    value = 1
    for power in range(255):
        exp[power] = exp[power + 255] = value
        log[value] = power
        value <<= 1
        if value & 0x100:
            value ^= 0x11D
    return tuple(exp), tuple(log)


_EXP, _LOG = _galois_tables()


def _multiply(a, b):
    """Product of two GF(256) elements."""
    if a == 0 or b == 0:
        return 0
    return _EXP[_LOG[a] + _LOG[b]]


def _generator(degree):
    """Coefficients, highest power first, of the generator polynomial (x - a^0)(x - a^1)...(x - a^(degree-1))."""
    polynomial = [1]
    for power in range(degree):
        product = polynomial + [0]
        for index, coefficient in enumerate(polynomial):
            product[index + 1] ^= _multiply(coefficient, _EXP[power])
        polynomial = product
    return polynomial


def _reed_solomon(data, generator):
    """Error correction codewords of a block: the remainder of data(x) * x^n divided by the generator."""
    degree = len(generator) - 1
    logs = [(index, _LOG[coefficient]) for index, coefficient in enumerate(generator[1:]) if coefficient]
    remainder = [0] * degree
    for codeword in data:
        factor = codeword ^ remainder[0]
        remainder = remainder[1:] + [0]
        if factor:
            shift = _LOG[factor]
            for index, log in logs:
                remainder[index] ^= _EXP[log + shift]
    return remainder


def _format_bits(level, mask):
    """The 15 format information bits: level and mask, BCH(15,5) with generator 0x537, XOR 0x5412."""
    data = _LEVEL_BITS[level] << 3 | mask
    remainder = data << 10
    for shift in range(4, -1, -1):
        if remainder >> (shift + 10) & 1:
            remainder ^= 0x537 << shift
    return (data << 10 | remainder) ^ 0x5412


def _version_bits(version):
    """The 18 version information bits: version number and its BCH(18,6) remainder with generator 0x1F25."""
    remainder = version << 12
    for shift in range(5, -1, -1):
        if remainder >> (shift + 12) & 1:
            remainder ^= 0x1F25 << shift
    return version << 12 | remainder


def _data_capacity(version, level):
    """Number of data codewords of a version at a level."""
    _, blocks1, data1, blocks2, data2 = _BLOCKS[version - 1][_LEVEL_COLUMN[level]]
    return blocks1 * data1 + blocks2 * data2


def _choose_version(length, level):
    """Smallest version whose data codewords hold a byte-mode segment of `length` bytes."""
    for version in range(1, 41):
        count_bits = 8 if version <= 9 else 16
        if length < 1 << count_bits and 4 + count_bits + 8 * length <= 8 * _data_capacity(version, level):
            return version
    capacity = (8 * _data_capacity(40, level) - 20) // 8
    raise ValueError(f"The text takes {length} UTF-8 bytes; a QR Code at level {level} holds at most {capacity}")


def _codewords(data, version, level):
    """The final interleaved sequence of data and error correction codewords for `data` bytes."""
    ec_length, blocks1, data1, blocks2, data2 = _BLOCKS[version - 1][_LEVEL_COLUMN[level]]
    capacity = blocks1 * data1 + blocks2 * data2
    count_bits = 8 if version <= 9 else 16

    # Mode indicator 0100, character count, the bytes, up to four terminator bits, zero bits to a byte boundary.
    stream = ((0b0100 << count_bits | len(data)) << 8 * len(data)) | int.from_bytes(data, "big")
    length = 4 + count_bits + 8 * len(data)
    terminator = min(4, 8 * capacity - length)
    length += terminator
    stream <<= terminator
    alignment = -length % 8
    length += alignment
    stream <<= alignment
    codewords = list(stream.to_bytes(length // 8, "big"))
    for index in range(capacity - len(codewords)):
        codewords.append(0xEC if index % 2 == 0 else 0x11)

    blocks = []
    offset = 0
    for count, block_length in ((blocks1, data1), (blocks2, data2)):
        for _ in range(count):
            blocks.append(codewords[offset:offset + block_length])
            offset += block_length
    generator = _generator(ec_length)
    corrections = [_reed_solomon(block, generator) for block in blocks]

    result = []
    for index in range(max(data1, data2)):
        result.extend(block[index] for block in blocks if index < len(block))
    for index in range(ec_length):
        result.extend(correction[index] for correction in corrections)
    return result


def _format_positions(size):
    """(row, column) of the two copies of the format information, most significant bit first."""
    first = [(8, col) for col in (0, 1, 2, 3, 4, 5, 7, 8)] + [(row, 8) for row in (7, 5, 4, 3, 2, 1, 0)]
    second = [(size - 1 - index, 8) for index in range(7)] + [(8, size - 8 + index) for index in range(8)]
    return first, second


def _function_patterns(version):
    """The modules of the function patterns and the map of every module that is not a data module."""
    size = 17 + 4 * version
    modules = [[False] * size for _ in range(size)]
    reserved = [[False] * size for _ in range(size)]

    def put(row, col, dark):
        modules[row][col] = dark
        reserved[row][col] = True

    # Finder patterns with their light separators.
    for top, left in ((0, 0), (0, size - 7), (size - 7, 0)):
        for row in range(top - 1, top + 8):
            for col in range(left - 1, left + 8):
                if 0 <= row < size and 0 <= col < size:
                    ring = max(abs(row - top - 3), abs(col - left - 3))
                    put(row, col, ring not in (2, 4))

    # Timing patterns.
    for index in range(8, size - 8):
        put(6, index, index % 2 == 0)
        put(index, 6, index % 2 == 0)

    # Alignment patterns, except the three that would overlap the finder patterns.
    centers = _ALIGNMENT[version - 1]
    corners = {(centers[0], centers[0]), (centers[0], centers[-1]), (centers[-1], centers[0])} if centers else set()
    for center_row in centers:
        for center_col in centers:
            if (center_row, center_col) in corners:
                continue
            for row in range(center_row - 2, center_row + 3):
                for col in range(center_col - 2, center_col + 3):
                    put(row, col, max(abs(row - center_row), abs(col - center_col)) != 1)

    # Format information areas (drawn per mask later) and the dark module at (4 * version + 9, 8).
    first, second = _format_positions(size)
    for row, col in first + second:
        put(row, col, False)
    put(size - 8, 8, True)

    # Version information blocks for versions 7 and up.
    if version >= 7:
        bits = _version_bits(version)
        for index in range(18):
            dark = bool(bits >> index & 1)
            put(index // 3, size - 11 + index % 3, dark)
            put(size - 11 + index % 3, index // 3, dark)
    return modules, reserved


def _data_positions(reserved):
    """Data module coordinates in placement order: two-column strips from the right, alternating up and down."""
    size = len(reserved)
    positions = []
    upward = True
    right = size - 1
    while right > 0:
        if right == 6:
            right = 5  # The vertical timing pattern column is skipped entirely.
        rows = range(size - 1, -1, -1) if upward else range(size)
        for row in rows:
            for col in (right, right - 1):
                if not reserved[row][col]:
                    positions.append((row, col))
        upward = not upward
        right -= 2
    return positions


def _penalty(rows, size):
    """Penalty score by the four rules of ISO/IEC 18004 7.8.3 of a masked symbol given as one bit mask per row
    (column 0 is the most significant bit, 1 = dark)."""
    lines = [format(row, f"0{size}b") for row in rows]
    columns = ["".join(column) for column in zip(*lines)]
    score = 0
    for line in lines + columns:
        # Rule 1: runs of five or more same-colored modules score 3 plus 1 per module beyond five.
        runs = _RUNS.findall(line)
        score += sum(map(len, runs)) - 2 * len(runs)
        # Rule 3: finder-like patterns; the light quiet zone around the symbol counts as light modules.
        framed = "0000" + line + "0000"
        score += 40 * (framed.count(_FINDER_LIKE[0]) + framed.count(_FINDER_LIKE[1]))
    # Rule 2: every 2x2 block of one color scores 3.
    full = (1 << size) - 1
    for upper, lower in zip(rows, rows[1:]):
        same = ~(upper ^ lower) & full
        blocks = same & (same >> 1) & ~(upper ^ (upper >> 1)) & (full >> 1)
        score += 3 * bin(blocks).count("1")
    # Rule 4: 10 points per full 5% that the dark proportion deviates from 50%.
    dark = sum(line.count("1") for line in lines)
    total = size * size
    score += 10 * (abs(20 * dark - 10 * total) // total)
    return score


def matrix(text, level="M"):
    """The QR Code modules of `text` (True = dark), without quiet zone, in the smallest version that fits."""
    if not isinstance(text, str):
        raise TypeError("The QR Code text must be a str")
    level = level.upper() if isinstance(level, str) else level
    if level not in _LEVEL_BITS:
        raise ValueError(f"Unknown error correction level {level!r}; use L, M, Q or H")
    data = text.encode("utf-8")
    version = _choose_version(len(data), level)
    modules, reserved = _function_patterns(version)
    positions = _data_positions(reserved)
    codewords = _codewords(data, version, level)
    # Remainder bits beyond the last codeword stay light (zero).
    for index, (row, col) in enumerate(positions[:8 * len(codewords)]):
        modules[row][col] = bool(codewords[index >> 3] >> (7 - (index & 7)) & 1)

    # Masks are applied to whole rows as bit masks (column 0 = most significant bit), only on data modules.
    size = len(modules)
    base = [int(bytes(row).translate(_DIGITS), 2) for row in modules]
    data_area = [int(bytes(row).translate(_INVERTED_DIGITS), 2) for row in reserved]
    first, second = _format_positions(size)
    repeats = size // _MASK_PERIOD + 1
    best_score = best = None
    for mask, condition in enumerate(_MASKS):
        tiles = ["".join("1" if condition(row, col) else "0" for col in range(_MASK_PERIOD)) * repeats
                 for row in range(_MASK_PERIOD)]
        patterns = [int(tile[:size], 2) for tile in tiles]
        rows = [line ^ (patterns[row % _MASK_PERIOD] & data_area[row]) for row, line in enumerate(base)]
        bits = _format_bits(level, mask)
        for index in range(15):
            dark = bits >> (14 - index) & 1
            for row, col in (first[index], second[index]):
                shift = size - 1 - col
                rows[row] = (rows[row] & ~(1 << shift)) | (dark << shift)
        score = _penalty(rows, size)
        if best_score is None or score < best_score:
            best_score, best = score, rows
    return [[bit == "1" for bit in format(row, f"0{size}b")] for row in best]


def _chunk(kind, data):
    """A PNG chunk: length, type, data and the CRC-32 of type and data."""
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def _check_layout(scale, border):
    """Rejects scales and borders that are not whole numbers in range."""
    if not isinstance(scale, int) or isinstance(scale, bool) or scale < 1:
        raise ValueError("The QR Code scale must be a whole number of pixels per module, at least 1")
    if not isinstance(border, int) or isinstance(border, bool) or border < 0:
        raise ValueError("The QR Code border must be a whole number of modules, at least 0")


def png(text, scale=6, border=4, level="M"):
    """A 1-bit grayscale PNG of the QR Code, black on white, with a quiet zone of `border` modules."""
    _check_layout(scale, border)
    symbol = matrix(text, level)
    size = len(symbol)
    side = (size + 2 * border) * scale
    padding = "1" * (-side % 8)
    raw = bytearray()
    for row in range(-border, size + border):
        # In 1-bit grayscale 0 is black and 1 is white.
        pixels = "".join(("0" if 0 <= row < size and 0 <= col < size and symbol[row][col] else "1") * scale
                         for col in range(-border, size + border)) + padding
        raw += (b"\x00" + int(pixels, 2).to_bytes(len(pixels) // 8, "big")) * scale
    header = struct.pack(">IIBBBBB", side, side, 1, 0, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", header) + _chunk(b"IDAT", zlib.compress(bytes(raw), 9))
            + _chunk(b"IEND", b""))


def svg(text, border=4, level="M"):
    """A compact SVG of the QR Code: a white background and one path of dark modules, in module units."""
    _check_layout(1, border)
    symbol = matrix(text, level)
    side = len(symbol) + 2 * border
    path = []
    for row, modules in enumerate(symbol):
        line = "".join("1" if dark else "0" for dark in modules)
        for run in _DARK_RUNS.finditer(line):
            width = run.end() - run.start()
            path.append(f"M{run.start() + border} {row + border}h{width}v1h-{width}z")
    d = "".join(path)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {side} {side}" shape-rendering="crispEdges">'
            f'<rect width="{side}" height="{side}" fill="#fff"/><path fill="#000" d="{d}"/></svg>')


def data_url(text):
    """The PNG of the QR Code as a "data:image/png;base64," URL."""
    return "data:image/png;base64," + base64.b64encode(png(text)).decode("ascii")
