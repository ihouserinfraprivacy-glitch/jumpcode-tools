# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""The running fake gateway: state of the three emulated APIs, the app's calls, scheduled work (payments,
expirations, webhook attempts) and the Studio files JumpCode shows."""

from collections import deque
import json
import os
from pathlib import Path
import re
import tempfile
import threading
import time

from . import wire

SCHEMA = 1
GATEWAYS = ("pix", "mercadopago", "stripe")
STUDIO_FILES = {"pay": "pay.json", "charges": "charges.json", "webhooks": "webhooks.json", "calls": "calls.json"}
MAX_EVENTS = 60
MAX_DELIVERIES = 300
_BOOKING = re.compile(r"\b([A-Z]{2,5}-\d{2,8})\b")


def write_atomic(path, text):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = text.encode("utf-8") if isinstance(text, str) else text
    handle, temporary = tempfile.mkstemp(prefix=".ps-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(handle, "wb") as stream:
            stream.write(data)
        for attempt in range(40):
            try:
                os.replace(temporary, path)
                return
            except PermissionError:
                if attempt == 39:
                    raise
                time.sleep(0.025)
    finally:
        if os.path.exists(temporary):
            try:
                os.remove(temporary)
            except OSError:
                pass


def empty_state():
    return {"schema": SCHEMA,
            "pix": {"cobs": {}, "locs": {}, "pix": {}, "webhooks": {}, "loc_seq": 0},
            "mercadopago": {"payments": {}, "tokens": {}, "seq": 1325000000},
            "stripe": {"intents": {}, "methods": {}, "refunds": {}, "disputes": {}},
            "idempotency": {"mercadopago": {}, "stripe": {}},
            "deliveries": [], "delivery_seq": 0, "rules": [], "failures": [], "checks": [], "scheduled": []}


class Gateway:
    def __init__(self, studio_root, port, persistent=False, token="", settings=None):
        self.root = Path(studio_root)
        self.port = port
        self.token = token
        self.persistent = persistent
        self.settings = settings or {}
        self.started = time.time()
        self.ready_ms = 0
        self.lock = threading.RLock()
        from .operation import Operations
        self.operations = Operations()
        self.stopping = threading.Event()
        self.state_file = self.root / "data" / "state.json"
        self.state = empty_state()
        if persistent:
            self._load()
        else:
            try:
                self.state_file.unlink()
            except OSError:
                pass
        self.calls = deque(maxlen=400)
        self.call_seq = 0
        self.dirty = set()
        self.wake = threading.Event()
        self.status = "starting"
        self.version = 0
        self.saved = 0

    @property
    def endpoint(self):
        return f"http://127.0.0.1:{self.port}"

    def secret(self, name):
        return self.settings.get("secrets", {}).get(name, "")

    def webhook_url(self, gateway):
        return (self.settings.get("webhooks") or {}).get(gateway) or ""

    # ------------------------------------------------------------ persistence
    def _load(self):
        try:
            data = json.loads(self.state_file.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return
        except (OSError, ValueError) as error:
            raise ValueError("Cannot read the saved PayStudio state. The original file was preserved.") from error
        base = empty_state()
        if not isinstance(data, dict) or data.get("schema") != SCHEMA:
            raise ValueError("Invalid PayStudio state schema. The original file was preserved.")
        for key, expected in base.items():
            if key == "scheduled" and key not in data:  # older states did not store pending work
                continue
            if key not in data or type(data[key]) is not type(expected):
                raise ValueError(f"Invalid PayStudio state field: {key}. The original file was preserved.")
            if isinstance(expected, dict):
                for member, value in expected.items():
                    if member not in data[key] or type(data[key][member]) is not type(value):
                        raise ValueError(f"Invalid PayStudio state field: {key}.{member}. The original file was preserved.")
        base.update(data)
        from . import jobs
        jobs.validate(base["scheduled"])
        jobs.recover_refunds(base)
        self.state = base

    def touch(self, *files):
        with self.lock:
            self.version += 1
            self.dirty.update(files or ("charges", "pay"))
        self.wake.set()

    def save(self):
        if not self.persistent or self.saved == self.version:
            return
        with self.lock:
            text = json.dumps(self.state, ensure_ascii=False, separators=(",", ":"))
            version = self.version
        write_atomic(self.state_file, text)
        self.saved = version

    # ------------------------------------------------------------ charge timeline
    def event(self, obj, text, kind="info", by="PayStudio"):
        info = obj.setdefault("ps", {})
        events = info.setdefault("events", [])
        events.append({"at": round(time.time(), 3), "text": text, "kind": kind, "by": by})
        del events[:-MAX_EVENTS]
        self.touch("charges")

    @staticmethod
    def booking_from(*values):
        for value in values:
            if isinstance(value, dict):
                for key in ("booking", "agendamento", "order_id", "pedido", "reference"):
                    if value.get(key):
                        return str(value[key])[:40]
                value = " ".join(str(v) for v in value.values())
            if value:
                match = _BOOKING.search(str(value))
                if match:
                    return match.group(1)
        return None

    # ------------------------------------------------------------ calls
    def record(self, entry):
        with self.lock:
            self.call_seq += 1
            entry["id"] = self.call_seq
            self.calls.append(entry)
        self.touch("calls", "pay")

    # ------------------------------------------------------------ scheduled work
    def later(self, seconds, action, label, ref=None):
        """Persist a typed operation with its due time, in the same state as its payment."""
        from . import jobs
        item = {"due": time.time() + max(0.0, seconds), "action": action, "label": label, "ref": ref}
        jobs.validate([item])
        with self.lock:
            self.state["scheduled"].append(item)
        self.touch("pay")

    def pending_work(self):
        with self.lock:
            return [{"due": item["due"], "label": item["label"], "ref": item["ref"]} for item in sorted(self.state["scheduled"], key=lambda i: i["due"])]

    def tick(self):
        now = time.time()
        from . import jobs
        with self.lock:
            due = [item for item in self.state["scheduled"] if item["due"] <= now]
            for item in due:
                try:
                    jobs.execute(self, item["action"])
                except Exception as error:  # one broken job must not stop the gateway
                    self.record({"at": round(time.time(), 3), "ms": 0, "gateway": "paystudio", "method": "-", "path": item["label"],
                                 "op": item["label"], "status": 500, "ref": item.get("ref"), "error": {"code": type(error).__name__, "message": str(error)[:400]}})
                self.state["scheduled"].remove(item)
            if due:
                self.touch("pay", "charges")
        from . import gateways
        gateways.expire(self)
        from . import webhooks
        webhooks.deliver_due(self)

    # ------------------------------------------------------------ Studio files
    def flush(self):
        with self.lock:
            names, self.dirty = self.dirty, set()
        try:
            self._flush(names)
        except Exception:
            with self.lock:
                self.dirty.update(names)
            raise

    def _flush(self, names):
        if not names:
            return
        from . import views
        if "charges" in names:
            write_json(self.root / STUDIO_FILES["charges"], views.charges_file(self))
            names = names | {"pay"}
        if "webhooks" in names:
            write_json(self.root / STUDIO_FILES["webhooks"], views.webhooks_file(self))
            names = names | {"pay"}
        if "calls" in names:
            with self.lock:
                calls = list(self.calls)
            write_json(self.root / STUDIO_FILES["calls"], {"schema": SCHEMA, "calls": calls, "total": self.call_seq})
        if "pay" in names:
            write_json(self.root / STUDIO_FILES["pay"], views.pay_file(self))

    def final(self):
        self.status = "stopped"
        with self.lock:
            self.dirty.update(("pay", "charges", "webhooks", "calls"))
        self.flush()
        if not self.persistent:
            write_json(self.root / STUDIO_FILES["charges"], {"schema": SCHEMA, "charges": []})
            write_json(self.root / STUDIO_FILES["webhooks"], {"schema": SCHEMA, "deliveries": []})

    def run_background(self):
        last = 0.0
        while not self.stopping.is_set():
            self.wake.wait(0.25)
            self.wake.clear()
            try:
                self.tick()
                if time.monotonic() - last > 0.3:
                    last = time.monotonic()
                    self.flush()
                    self.save()
            except Exception:  # the Studio files are best effort; the gateway keeps answering
                pass


def write_json(path, value):
    write_atomic(path, json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str))


def mask_card(number):
    digits = re.sub(r"\D", "", str(number or ""))
    return f"{digits[:6]}******{digits[-4:]}" if len(digits) >= 10 else "****"


def redact(value):
    """Removes card numbers, security codes and secrets from what the call history keeps."""
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            lowered = str(key).lower()
            if lowered in ("security_code", "cvc", "cvv", "card[cvc]", "client_secret", "access_token", "token_secret",
                           "authorization", "secret_key", "api_key", "password", "webhook_secret"):
                out[key] = "•••"
            elif lowered in ("card_number", "number", "card[number]"):
                out[key] = mask_card(item)
            elif lowered in ("qr_code_base64", "imagemqrcode") and isinstance(item, str):
                out[key] = "(imagem do QR Code)"
            else:
                out[key] = redact(item)
        return out
    if isinstance(value, list):
        return [redact(item) for item in value]
    return value


def clip(value, limit=1600):
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
    return text if len(text) <= limit else text[:limit] + "…"


__all__ = ["Gateway", "GATEWAYS", "wire", "redact", "clip", "mask_card", "write_json", "write_atomic"]
