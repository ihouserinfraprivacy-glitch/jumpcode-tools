# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Pix "copia e cola" (BR Code, EMV QRCPS-MPM) for dynamic charges: the location URL, amount, merchant and the
CRC16-CCITT check digits."""

import unicodedata


def _field(tag, value):
    value = str(value)
    if len(value) > 99:
        raise ValueError(f"BR Code field {tag} is longer than 99 characters")
    return f"{tag}{len(value):02d}{value}"


def _plain(text, limit):
    """Merchant name and city: ASCII upper case, as banks expect."""
    value = unicodedata.normalize("NFKD", str(text or "")).encode("ascii", "ignore").decode("ascii").upper()
    return " ".join(value.split())[:limit] or "-"


def crc16(text):
    crc = 0xFFFF
    for byte in text.encode("utf-8"):
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) if crc & 0x8000 else crc << 1
            crc &= 0xFFFF
    return f"{crc:04X}"


def dynamic(location, merchant, city, amount=None):
    """The payload of a dynamic Pix: banks read the charge from `location` (host and path, without https://)."""
    account = _field("00", "br.gov.bcb.pix") + _field("25", location)
    payload = (_field("00", "01") + _field("01", "12") + _field("26", account) + _field("52", "0000") + _field("53", "986")
               + (_field("54", amount) if amount else "") + _field("58", "BR") + _field("59", _plain(merchant, 25))
               + _field("60", _plain(city, 15)) + _field("62", _field("05", "***")) + "6304")
    return payload + crc16(payload)


def valid(payload):
    return len(payload) > 8 and payload[-8:-4] == "6304" and crc16(payload[:-4]) == payload[-4:]
