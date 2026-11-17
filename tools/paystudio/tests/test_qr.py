# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""QR Code encoder tests: published ISO/IEC 18004 values, symbol structure, PNG/SVG output and an independent
decoder that reads the symbols back (format information, mask, zig-zag, de-interleaving, Reed-Solomon syndromes)."""

import base64
from pathlib import Path
import random
import re
import struct
import sys
import unittest
import xml.etree.ElementTree as ElementTree
import zlib

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from jumpcode_paystudio.engine import qr  # noqa: E402
from jumpcode_paystudio.engine.qr import data_url, matrix, png, svg  # noqa: E402

LEVELS = "LMQH"

# Published total codewords per version (ISO/IEC 18004 Table 1) and remainder bits per version.
TOTAL_CODEWORDS = (26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466, 532, 581, 655, 733, 815, 901, 991,
                   1085, 1156, 1258, 1364, 1474, 1588, 1706, 1828, 1921, 2051, 2185, 2323, 2465, 2611, 2761, 2876,
                   3034, 3196, 3362, 3532, 3706)
REMAINDER_BITS = (0, 7, 7, 7, 7, 7, 0, 0, 0, 0, 0, 0, 0, 3, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4, 4, 4, 3, 3, 3, 3, 3,
                  3, 3, 0, 0, 0, 0, 0, 0)

# Published byte-mode character capacities per version (ISO/IEC 18004 Table 7).
BYTE_CAPACITY = {
    "L": (17, 32, 53, 78, 106, 134, 154, 192, 230, 271, 321, 367, 425, 458, 520, 586, 644, 718, 792, 858, 929, 1003,
          1091, 1171, 1273, 1367, 1465, 1528, 1628, 1732, 1840, 1952, 2068, 2188, 2303, 2431, 2563, 2699, 2809, 2953),
    "M": (14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362, 412, 450, 504, 560, 624, 666, 711, 779,
          857, 911, 997, 1059, 1125, 1190, 1264, 1370, 1452, 1538, 1628, 1722, 1809, 1911, 1989, 2099, 2213, 2331),
    "Q": (11, 20, 32, 46, 60, 74, 86, 108, 130, 151, 177, 203, 241, 258, 292, 322, 364, 394, 442, 482, 509, 565, 611,
          661, 715, 751, 805, 868, 908, 982, 1030, 1112, 1168, 1228, 1283, 1351, 1423, 1499, 1579, 1663),
    "H": (7, 14, 24, 34, 44, 58, 64, 84, 98, 119, 137, 155, 177, 194, 220, 250, 280, 310, 338, 382, 403, 439, 461,
          511, 535, 593, 625, 658, 698, 742, 790, 842, 898, 958, 983, 1051, 1093, 1139, 1219, 1273),
}

# The decoder's own block structure, in the other usual form: EC codewords per block and number of blocks.
# The split into short and long blocks is derived from the total codewords.
EC_PER_BLOCK = {
    "L": (7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30,
          30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30),
    "M": (10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28,
          28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28),
    "Q": (13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30,
          30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30),
    "H": (17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30,
          30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30),
}
BLOCK_COUNT = {
    "L": (1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18,
          19, 19, 20, 21, 22, 24, 25),
    "M": (1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31,
          33, 35, 37, 38, 40, 43, 45, 47, 49),
    "Q": (1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40,
          43, 45, 48, 51, 53, 56, 59, 62, 65, 68),
    "H": (1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48,
          51, 54, 57, 60, 63, 66, 70, 74, 77, 81),
}

# Published format information strings (ISO/IEC 18004 Annex C), masks 0-7.
FORMAT_INFORMATION = {
    "L": ("111011111000100", "111001011110011", "111110110101010", "111100010011101",
          "110011000101111", "110001100011000", "110110001000001", "110100101110110"),
    "M": ("101010000010010", "101000100100101", "101111001111100", "101101101001011",
          "100010111111001", "100000011001110", "100111110010111", "100101010100000"),
    "Q": ("011010101011111", "011000001101000", "011111100110001", "011101000000110",
          "010010010110100", "010000110000011", "010111011011010", "010101111101101"),
    "H": ("001011010001001", "001001110111110", "001110011100111", "001100111010000",
          "000011101100010", "000001001010101", "000110100001100", "000100000111011"),
}
FORMAT_LOOKUP = {bits: (level, mask) for level, table in FORMAT_INFORMATION.items() for mask, bits in enumerate(table)}

# Published version information strings (ISO/IEC 18004 Annex D).
VERSION_INFORMATION = {
    7: "000111110010010100", 8: "001000010110111100", 9: "001001101010011001", 10: "001010010011010011",
    11: "001011101111110110", 12: "001100011101100010", 13: "001101100001000111", 14: "001110011000001101",
    15: "001111100100101000", 16: "010000101101111000", 17: "010001010001011101", 18: "010010101000010111",
    19: "010011010100110010", 20: "010100100110100110", 21: "010101011010000011", 22: "010110100011001001",
    23: "010111011111101100", 24: "011000111011000100", 25: "011001000111100001", 26: "011010111110101011",
    27: "011011000010001110", 28: "011100110000011010", 29: "011101001100111111", 30: "011110110101110101",
    31: "011111001001010000", 32: "100000100111010101", 33: "100001011011110000", 34: "100010100010111010",
    35: "100011011110011111", 36: "100100101100001011", 37: "100101010000101110", 38: "100110101001100100",
    39: "100111010101000001", 40: "101000110001101001",
}

MASK_CONDITIONS = (
    lambda i, j: (i + j) % 2 == 0,
    lambda i, j: i % 2 == 0,
    lambda i, j: j % 3 == 0,
    lambda i, j: (i + j) % 3 == 0,
    lambda i, j: (i // 2 + j // 3) % 2 == 0,
    lambda i, j: (i * j) % 2 + (i * j) % 3 == 0,
    lambda i, j: ((i * j) % 2 + (i * j) % 3) % 2 == 0,
    lambda i, j: ((i + j) % 2 + (i * j) % 3) % 2 == 0,
)

FINDER = ("1111111", "1000001", "1011101", "1011101", "1011101", "1000001", "1111111")
ALIGNMENT = ("11111", "10001", "10101", "10001", "11111")

PIX = ("00020101021226850014br.gov.bcb.pix2563127.0.0.1:4570/pix/v2/loc/7f3a9c2e-5204-4d19-9c07-e2a6b15f8d43520400"
       "00530398654057.005802BR5915BARBEARIA DO ZE6009SAO PAULO62070503***6304ABCD")
TEXTS = (
    "A",
    "Pix de teste gerado pelo PayStudio local, sem rede",
    PIX,
    "".join(chr(32 + (index * 37) % 95) for index in range(600)),
    "Barbearia do Zé · São Paulo",
)


def _galois():
    exp = [0] * 255
    log = [0] * 256
    value = 1
    for power in range(255):
        exp[power] = value
        log[value] = power
        value = (value << 1) ^ (0x11D if value & 0x80 else 0)
    return exp, log


GF_EXP, GF_LOG = _galois()


def evaluate(codewords, power):
    """Horner evaluation of a codeword polynomial (first codeword = highest power) at a^power in GF(256)."""
    result = 0
    for codeword in codewords:
        result = (GF_EXP[(GF_LOG[result] + power) % 255] if result else 0) ^ codeword
    return result


def alignment_centers(version):
    """Alignment centers derived from the even spacing rule instead of the lookup table."""
    if version == 1:
        return []
    count = version // 7 + 2
    size = 17 + 4 * version
    step = (version * 8 + count * 3 + 5) // (count * 4 - 4) * 2
    return [6] + [size - 7 - step * index for index in range(count - 2, -1, -1)]


def function_map(version):
    """True for every module that does not carry data, built from rectangles."""
    size = 17 + 4 * version
    reserved = [[False] * size for _ in range(size)]

    def area(top, left, height, width):
        for row in range(top, top + height):
            for col in range(left, left + width):
                reserved[row][col] = True

    area(0, 0, 9, 9)                # top-left finder, separator and format information
    area(0, size - 8, 9, 8)         # top-right finder, separator and format information row
    area(size - 8, 0, 8, 9)         # bottom-left finder, separator, format column and dark module
    area(6, 0, 1, size)             # horizontal timing
    area(0, 6, size, 1)             # vertical timing
    centers = alignment_centers(version)
    for row in centers:
        for col in centers:
            if (row < 9 and col < 9) or (row < 9 and col > size - 10) or (row > size - 10 and col < 9):
                continue
            area(row - 2, col - 2, 5, 5)
    if version >= 7:
        area(0, size - 11, 6, 3)
        area(size - 11, 0, 3, 6)
    return reserved


def zigzag(reserved):
    """Data module coordinates in reading order."""
    size = len(reserved)
    order = []
    pairs = [right if right > 6 else right - 1 for right in range(size - 1, 0, -2)]
    for index, right in enumerate(pairs):
        rows = range(size - 1, -1, -1) if index % 2 == 0 else range(size)
        for row in rows:
            order.extend((row, col) for col in (right, right - 1) if not reserved[row][col])
    return order


def format_cells(size):
    """Both copies of the format information cells, most significant bit first."""
    around = [(8, col) for col in range(9) if col != 6] + [(row, 8) for row in range(7, -1, -1) if row != 6]
    split = [(row, 8) for row in range(size - 1, size - 8, -1)] + [(8, col) for col in range(size - 8, size)]
    return around, split


def version_bits(version):
    """BCH(18,6) version information with generator 0x1F25, by long division on a bit string."""
    bits = [int(bit) for bit in f"{version:06b}"] + [0] * 12
    generator = [int(bit) for bit in f"{0x1F25:013b}"]
    for index in range(6):
        if bits[index]:
            for offset, bit in enumerate(generator):
                bits[index + offset] ^= bit
    return f"{version:06b}" + "".join(str(bit) for bit in bits[6:])


class DecodeError(AssertionError):
    pass


def decode(symbol):
    """Reads a clean symbol back to (text, version, level, mask); raises DecodeError on any inconsistency."""
    size = len(symbol)
    if size < 21 or (size - 17) % 4 or any(len(row) != size for row in symbol):
        raise DecodeError(f"Not a square QR Code symbol: {size}")
    version = (size - 17) // 4

    around, split = format_cells(size)
    copies = ["".join("1" if symbol[row][col] else "0" for row, col in cells) for cells in (around, split)]
    if copies[0] != copies[1] or copies[0] not in FORMAT_LOOKUP:
        raise DecodeError(f"Bad format information {copies}")
    level, mask = FORMAT_LOOKUP[copies[0]]

    if version >= 7:
        top_right = sum(symbol[index // 3][size - 11 + index % 3] << index for index in range(18))
        bottom_left = sum(symbol[size - 11 + index % 3][index // 3] << index for index in range(18))
        expected = int(version_bits(version), 2)
        if top_right != expected or bottom_left != expected:
            raise DecodeError(f"Bad version information {top_right:018b} {bottom_left:018b}")

    condition = MASK_CONDITIONS[mask]
    bits = [int(symbol[row][col] != condition(row, col)) for row, col in zigzag(function_map(version))]
    total = len(bits) // 8
    if any(bits[total * 8:]):
        raise DecodeError("Remainder bits are not zero")
    codewords = [int("".join(map(str, bits[index:index + 8])), 2) for index in range(0, total * 8, 8)]

    blocks = BLOCK_COUNT[level][version - 1]
    ec_length = EC_PER_BLOCK[level][version - 1]
    long_blocks = total % blocks
    lengths = [total // blocks - ec_length + (index >= blocks - long_blocks) for index in range(blocks)]
    data = [[] for _ in range(blocks)]
    corrections = [[] for _ in range(blocks)]
    stream = iter(codewords)
    for index in range(max(lengths)):
        for block in range(blocks):
            if index < lengths[block]:
                data[block].append(next(stream))
    for index in range(ec_length):
        for block in range(blocks):
            corrections[block].append(next(stream))
    for block in range(blocks):
        syndromes = [evaluate(data[block] + corrections[block], power) for power in range(ec_length)]
        if any(syndromes):
            raise DecodeError(f"Block {block} has non-zero syndromes {syndromes}")

    payload = "".join(f"{codeword:08b}" for block in data for codeword in block)
    position = 0

    def read(count):
        nonlocal position
        if position + count > len(payload):
            raise DecodeError("Ran past the end of the data codewords")
        value = int(payload[position:position + count] or "0", 2)
        position += count
        return value

    if read(4) != 0b0100:
        raise DecodeError("Not a byte mode segment")
    length = read(8 if version <= 9 else 16)
    text = bytes(read(8) for _ in range(length))
    if read(min(4, len(payload) - position)) != 0 or read(-position % 8) != 0:
        raise DecodeError("Terminator or bit padding is not zero")
    padding = [read(8) for _ in range((len(payload) - position) // 8)]
    if padding != [(0xEC, 0x11)[index % 2] for index in range(len(padding))]:
        raise DecodeError(f"Pad codewords are not 0xEC/0x11: {padding}")
    return text.decode("utf-8"), version, level, mask


def penalty(grid):
    """Mask penalty by the four ISO rules, written as plain loops (finder-like patterns may use the quiet zone)."""
    size = len(grid)
    lines = [list(row) for row in grid] + [[grid[row][col] for row in range(size)] for col in range(size)]
    patterns = ([True, False, True, True, True, False, True, False, False, False, False],
                [False, False, False, False, True, False, True, True, True, False, True])
    score = 0
    for line in lines:
        run = 1
        for index in range(1, size + 1):
            if index < size and line[index] == line[index - 1]:
                run += 1
                continue
            if run >= 5:
                score += 3 + run - 5
            run = 1
        framed = [False] * 4 + line + [False] * 4
        score += 40 * sum(framed[index:index + 11] in patterns for index in range(len(framed) - 10))
    for row in range(size - 1):
        for col in range(size - 1):
            if grid[row][col] == grid[row][col + 1] == grid[row + 1][col] == grid[row + 1][col + 1]:
                score += 3
    # Deviation of the dark percentage from 50, in whole steps of 5 percentage points.
    dark = sum(sum(row) for row in grid)
    score += 10 * (abs(100 * dark - 50 * size * size) // (5 * size * size))
    return score


def expected_version(text, level):
    length = len(text.encode("utf-8"))
    return next(version for version, capacity in enumerate(BYTE_CAPACITY[level], 1) if capacity >= length)


def region(symbol, top, left, height, width):
    return tuple("".join("1" if symbol[row][col] else "0" for col in range(left, left + width))
                 for row in range(top, top + height))


def padded(symbol, border):
    size = len(symbol) + 2 * border
    grid = [[False] * size for _ in range(size)]
    for row, modules in enumerate(symbol):
        grid[row + border][border:border + len(modules)] = modules
    return grid


class ReedSolomonTest(unittest.TestCase):

    def test_generator_polynomials_match_published_exponents(self):
        exponents = {degree: [GF_LOG[coefficient] for coefficient in qr._generator(degree)] for degree in (7, 10)}
        self.assertEqual(exponents, {7: [0, 87, 229, 146, 149, 238, 102, 21],
                                     10: [0, 251, 67, 46, 61, 118, 70, 64, 94, 32, 45]})

    def test_published_error_correction_codewords(self):
        generator = qr._generator(10)
        # "HELLO WORLD" 1-M (Thonky worked example) and "01234567" 1-M (ISO/IEC 18004 Annex I).
        hello = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17]
        digits = [16, 32, 12, 86, 97, 128, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17]
        self.assertEqual([qr._reed_solomon(hello, generator), qr._reed_solomon(digits, generator)],
                         [[196, 35, 39, 119, 235, 215, 231, 226, 93, 23],
                          [165, 36, 212, 193, 237, 54, 199, 135, 44, 85]])

    def test_every_block_shape_has_zero_syndromes(self):
        shapes = {(entry[0], length) for row in qr._BLOCKS for entry in row
                  for length in (entry[2], entry[4]) if length}
        source = random.Random(18004)
        failures = []
        for ec_length, length in sorted(shapes):
            generator = qr._generator(ec_length)
            data = [source.randrange(256) for _ in range(length)]
            word = data + qr._reed_solomon(data, generator)
            if any(evaluate(word, power) for power in range(ec_length)):
                failures.append((ec_length, length))
        self.assertEqual(failures, [])


class InformationBitsTest(unittest.TestCase):

    def test_format_information_matches_published_table(self):
        computed = {level: tuple(f"{qr._format_bits(level, mask):015b}" for mask in range(8)) for level in LEVELS}
        self.assertEqual(computed, FORMAT_INFORMATION)
        self.assertEqual(FORMAT_INFORMATION["M"][0], "101010000010010")

    def test_version_information_matches_published_table(self):
        self.assertEqual({version: f"{qr._version_bits(version):018b}" for version in range(7, 41)},
                         VERSION_INFORMATION)
        self.assertEqual({version: version_bits(version) for version in range(7, 41)}, VERSION_INFORMATION)
        self.assertEqual((VERSION_INFORMATION[7], VERSION_INFORMATION[8]), ("000111110010010100", "001000010110111100"))


class TablesTest(unittest.TestCase):

    def test_block_table_matches_published_totals_capacities_and_block_counts(self):
        mismatches = []
        for version in range(1, 41):
            for column, level in enumerate(LEVELS):
                ec_length, blocks1, data1, blocks2, data2 = qr._BLOCKS[version - 1][column]
                blocks = blocks1 + blocks2
                total = blocks1 * data1 + blocks2 * data2 + blocks * ec_length
                data = blocks1 * data1 + blocks2 * data2
                count_bits = 8 if version <= 9 else 16
                derived_short = TOTAL_CODEWORDS[version - 1] // blocks - ec_length
                checks = {
                    "total": (total, TOTAL_CODEWORDS[version - 1]),
                    "capacity": ((8 * data - 4 - count_bits) // 8, BYTE_CAPACITY[level][version - 1]),
                    "ec": (ec_length, EC_PER_BLOCK[level][version - 1]),
                    "blocks": (blocks, BLOCK_COUNT[level][version - 1]),
                    "long blocks": (blocks2, TOTAL_CODEWORDS[version - 1] % blocks),
                    "short data": (data1, derived_short),
                    "long data": (data2, derived_short + 1 if blocks2 else 0),
                }
                mismatches.extend((version, level, name, pair) for name, pair in checks.items() if pair[0] != pair[1])
        self.assertEqual(mismatches, [])

    def test_data_modules_match_published_totals_and_remainder_bits(self):
        counted = []
        for version in range(1, 41):
            modules = sum(row.count(False) for row in function_map(version))
            counted.append((modules // 8, modules % 8))
        self.assertEqual(counted, list(zip(TOTAL_CODEWORDS, REMAINDER_BITS)))

    def test_alignment_table_matches_spacing_rule_and_published_rows(self):
        self.assertEqual([list(centers) for centers in qr._ALIGNMENT], [alignment_centers(v) for v in range(1, 41)])
        self.assertEqual([alignment_centers(version) for version in (2, 7, 14, 32, 36, 40)],
                         [[6, 18], [6, 22, 38], [6, 26, 46, 66], [6, 34, 60, 86, 112, 138],
                          [6, 24, 50, 76, 102, 128, 154], [6, 30, 58, 86, 114, 142, 170]])


class StructureTest(unittest.TestCase):

    def assert_structure(self, symbol, version):
        size = 17 + 4 * version
        self.assertEqual((len(symbol), {len(row) for row in symbol}), (size, {size}))
        corners = ((0, 0), (0, size - 7), (size - 7, 0))
        self.assertEqual([region(symbol, top, left, 7, 7) for top, left in corners], [FINDER] * 3)
        separators = [region(symbol, 7, 0, 1, 8), region(symbol, 0, 7, 8, 1),
                      region(symbol, 7, size - 8, 1, 8), region(symbol, 0, size - 8, 8, 1),
                      region(symbol, size - 8, 0, 1, 8), region(symbol, size - 8, 7, 8, 1)]
        self.assertEqual(separators, [("0" * 8,), ("0",) * 8] * 3)
        timing = "".join("1" if index % 2 == 0 else "0" for index in range(8, size - 8))
        self.assertEqual((region(symbol, 6, 8, 1, size - 16)[0], "".join(region(symbol, 8, 6, size - 16, 1))),
                         (timing, timing))
        self.assertTrue(symbol[4 * version + 9][8])
        centers = alignment_centers(version)
        found = [region(symbol, row - 2, col - 2, 5, 5) for row in centers for col in centers
                 if not ((row, col) in ((6, 6), (6, centers[-1]), (centers[-1], 6)))]
        self.assertEqual(found, [ALIGNMENT] * len(found))
        if version >= 7:
            expected = VERSION_INFORMATION[version][::-1]
            top_right = "".join("1" if symbol[index // 3][size - 11 + index % 3] else "0" for index in range(18))
            bottom_left = "".join("1" if symbol[size - 11 + index % 3][index // 3] else "0" for index in range(18))
            self.assertEqual((top_right, bottom_left), (expected, expected))

    def test_function_patterns_for_small_and_large_versions(self):
        for text, level in (("A", "M"), ("x" * 20, "M"), ("y" * 140, "L"), ("z" * 400, "M"), ("w" * 2331, "M")):
            version = expected_version(text, level)
            with self.subTest(version=version):
                self.assert_structure(matrix(text, level), version)

    def test_symbols_are_independent_lists(self):
        first = matrix(PIX)
        first[0][0] = False
        self.assertTrue(matrix(PIX)[0][0])


class RoundTripTest(unittest.TestCase):

    def test_texts_round_trip_at_every_level_in_the_smallest_version(self):
        results = []
        for text in TEXTS:
            for level in LEVELS:
                decoded, version, decoded_level, _ = decode(matrix(text, level))
                results.append((decoded == text, version, decoded_level))
        self.assertEqual(results, [(True, expected_version(text, level), level) for text in TEXTS for level in LEVELS])

    def test_pix_payload_uses_version_9_at_level_m(self):
        self.assertEqual(decode(matrix(PIX))[:3], (PIX, 9, "M"))

    def test_every_version_at_full_capacity(self):
        source = random.Random(4570)
        failures = []
        for level in LEVELS:
            for version, capacity in enumerate(BYTE_CAPACITY[level], 1):
                text = "".join(chr(source.randrange(32, 127)) for _ in range(capacity))
                decoded, decoded_version, decoded_level, _ = decode(matrix(text, level))
                if (decoded, decoded_version, decoded_level) != (text, version, level):
                    failures.append((level, version, "full"))
                if version < 40 and len(matrix(text + "!", level)) != 17 + 4 * (version + 1):
                    failures.append((level, version, "overflow"))
        self.assertEqual(failures, [])

    def test_chosen_mask_has_the_lowest_penalty(self):
        chosen = []
        for text in TEXTS:
            for level in "LM":
                symbol = matrix(text, level)
                _, version, _, mask = decode(symbol)
                positions = zigzag(function_map(version))
                around, split = format_cells(len(symbol))
                scores = []
                for candidate_mask in range(8):
                    grid = [row[:] for row in symbol]
                    for row, col in positions:
                        grid[row][col] = (symbol[row][col] != MASK_CONDITIONS[mask](row, col)) != \
                            MASK_CONDITIONS[candidate_mask](row, col)
                    for index, bit in enumerate(FORMAT_INFORMATION[level][candidate_mask]):
                        for row, col in (around[index], split[index]):
                            grid[row][col] = bit == "1"
                    scores.append(penalty(grid))
                chosen.append(mask == scores.index(min(scores)))
        self.assertEqual(chosen, [True] * len(chosen))

    def test_penalty_rules_match_the_independent_implementation(self):
        source = random.Random(1804)
        grids = [[[source.random() < density for _ in range(size)] for _ in range(size)]
                 for size, density in ((21, 0.5), (25, 0.8), (29, 0.2), (45, 0.65), (57, 0.35))]
        grids.append([[True] * 21 for _ in range(21)])
        grids.append([[row * 20 + col < 220 for col in range(20)] for row in range(20)])  # exactly 55% dark
        grids.extend(matrix(text, level) for text in TEXTS for level in "LH")
        computed = [qr._penalty([int("".join("1" if dark else "0" for dark in row), 2) for row in grid], len(grid))
                    for grid in grids]
        self.assertEqual(computed, [penalty(grid) for grid in grids])


class ErrorTest(unittest.TestCase):

    def test_capacity_limits_and_bad_arguments(self):
        self.assertEqual(len(matrix("a" * 2953, "L")), 177)
        self.assertEqual(len(matrix("a" * 2331, "M")), 177)
        for text, level in (("a" * 2954, "L"), ("a" * 2332, "M"), ("é" * 1166, "M")):
            with self.subTest(level=level, length=len(text)):
                with self.assertRaises(ValueError):
                    matrix(text, level)
        with self.assertRaises(ValueError):
            matrix("x", "X")
        with self.assertRaises(ValueError):
            png("x", scale=0)
        with self.assertRaises(ValueError):
            svg("x", border=-1)
        with self.assertRaises(TypeError):
            matrix(b"x")

    def test_level_is_case_insensitive(self):
        self.assertTrue(matrix(PIX, "l") == matrix(PIX, "L"))


class PngTest(unittest.TestCase):

    def read_png(self, data):
        self.assertEqual(data[:8], b"\x89PNG\r\n\x1a\n")
        chunks = []
        offset = 8
        while offset < len(data):
            length, kind = struct.unpack(">I4s", data[offset:offset + 8])
            body = data[offset + 8:offset + 8 + length]
            (crc,) = struct.unpack(">I", data[offset + 8 + length:offset + 12 + length])
            self.assertEqual(zlib.crc32(kind + body) & 0xFFFFFFFF, crc, kind)
            chunks.append((kind, body))
            offset += 12 + length
        self.assertEqual(offset, len(data))
        kinds = [kind for kind, _ in chunks]
        self.assertEqual((kinds[0], kinds[-1], set(kinds[1:-1])), (b"IHDR", b"IEND", {b"IDAT"}))
        width, height, depth, color, compression, filtering, interlace = struct.unpack(">IIBBBBB", chunks[0][1])
        self.assertEqual((color, compression, filtering, interlace), (0, 0, 0, 0))
        self.assertIn(depth, (1, 8))
        raw = zlib.decompress(b"".join(body for kind, body in chunks if kind == b"IDAT"))
        stride = (width * depth + 7) // 8
        self.assertEqual(len(raw), height * (stride + 1))
        rows = []
        for row in range(height):
            line = raw[row * (stride + 1):(row + 1) * (stride + 1)]
            self.assertEqual(line[0], 0, "only the None filter is expected")
            if depth == 1:
                bits = "".join(f"{byte:08b}" for byte in line[1:])[:width]
                rows.append([bit == "1" for bit in bits])
            else:
                rows.append([value >= 128 for value in line[1:]])
        return width, height, rows

    def test_png_pixels_match_the_matrix(self):
        for text, scale, border in ((PIX, 6, 4), ("A", 1, 0), ("Barbearia do Zé · São Paulo", 3, 2)):
            with self.subTest(text=text[:10], scale=scale, border=border):
                symbol = matrix(text)
                width, height, rows = self.read_png(png(text, scale=scale, border=border))
                side = (len(symbol) + 2 * border) * scale
                grid = padded(symbol, border)
                expected = [[not grid[row // scale][col // scale] for col in range(side)] for row in range(side)]
                mismatched = [row for row in range(height) if rows[row] != expected[row]]
                self.assertEqual(((width, height), mismatched), ((side, side), []))

    def test_data_url_wraps_the_png(self):
        url = data_url(PIX)
        prefix = "data:image/png;base64,"
        self.assertTrue(url.startswith(prefix))
        self.assertEqual(base64.b64decode(url[len(prefix):], validate=True), png(PIX))


class SvgTest(unittest.TestCase):

    def test_svg_path_covers_exactly_the_dark_modules(self):
        for text, border in ((PIX, 4), ("A", 0)):
            with self.subTest(border=border):
                symbol = matrix(text)
                side = len(symbol) + 2 * border
                root = ElementTree.fromstring(svg(text, border=border))
                namespace = "{http://www.w3.org/2000/svg}"
                self.assertEqual((root.tag, root.get("viewBox"), root.get("shape-rendering")),
                                 (namespace + "svg", f"0 0 {side} {side}", "crispEdges"))
                children = list(root)
                self.assertEqual([child.tag for child in children], [namespace + "rect", namespace + "path"])
                background, path = children
                self.assertEqual((background.get("width"), background.get("height"), background.get("fill")),
                                 (str(side), str(side), "#fff"))
                self.assertEqual(path.get("fill"), "#000")
                grid = [[False] * side for _ in range(side)]
                consumed = 0
                for match in re.finditer(r"M(?P<x>\d+) (?P<y>\d+)h(?P<width>\d+)v1h-(?P=width)z", path.get("d")):
                    self.assertEqual(match.start(), consumed)
                    consumed = match.end()
                    row, start = int(match.group("y")), int(match.group("x"))
                    for col in range(start, start + int(match.group("width"))):
                        self.assertFalse(grid[row][col], "overlapping path segments")
                        grid[row][col] = True
                expected = padded(symbol, border)
                mismatched = [row for row in range(side) if grid[row] != expected[row]]
                self.assertEqual((consumed, mismatched), (len(path.get("d")), []))


if __name__ == "__main__":
    unittest.main()
