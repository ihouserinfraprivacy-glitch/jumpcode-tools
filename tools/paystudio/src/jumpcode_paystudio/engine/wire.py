# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""HTTP answers, errors and small helpers shared by the emulated gateways."""

from datetime import datetime, timedelta, timezone
import json
import secrets
import string
import time


class Response:
    __slots__ = ("status", "headers", "body")

    def __init__(self, status=200, body=b"", headers=None):
        self.status = status
        self.body = body if isinstance(body, bytes) else body.encode("utf-8")
        self.headers = dict(headers or {})


class GatewayError(Exception):
    """An error answered in the shape of the gateway the app is calling."""

    def __init__(self, status, body, code="", message=""):
        super().__init__(message or code)
        self.status = status
        self.body = body
        self.code = code
        self.message = message


def json_response(value, status=200, headers=None, content_type="application/json"):
    body = json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)
    return Response(status, body, {"Content-Type": f"{content_type}; charset=utf-8", **(headers or {})})


def now():
    return time.time()


def iso(ts=None, millis=True):
    value = datetime.fromtimestamp(ts if ts is not None else time.time(), tz=timezone.utc)
    text = value.strftime("%Y-%m-%dT%H:%M:%S")
    return text + (f".{value.microsecond // 1000:03d}Z" if millis else "Z")


def iso_local(ts=None, offset_hours=-3):
    """Mercado Pago writes dates with the account's offset, like 2026-11-14T14:41:05.214-03:00."""
    zone = timezone(timedelta(hours=offset_hours))
    value = datetime.fromtimestamp(ts if ts is not None else time.time(), tz=zone)
    sign = "-" if offset_hours < 0 else "+"
    return value.strftime("%Y-%m-%dT%H:%M:%S") + f".{value.microsecond // 1000:03d}{sign}{abs(offset_hours):02d}:00"


def token(prefix="", length=24, alphabet=string.ascii_letters + string.digits):
    return prefix + "".join(secrets.choice(alphabet) for _ in range(length))


def cents(value):
    """Decimal text or number of reais to integer cents (rounding half up)."""
    from decimal import Decimal, ROUND_HALF_UP
    return int((Decimal(str(value)) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def reais(amount_cents):
    return f"{amount_cents // 100}.{amount_cents % 100:02d}"


def brl(amount_cents):
    whole = f"{amount_cents // 100:,}".replace(",", ".")
    return f"R$ {whole},{amount_cents % 100:02d}"
