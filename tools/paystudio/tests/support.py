# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Runs a fake gateway inside the test process and a small "app" that receives its webhooks, checks their
signatures like a careful app would, and answers what each test asks."""

import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from jumpcode_paystudio.engine.core import Gateway  # noqa: E402
from jumpcode_paystudio.engine.server import serve  # noqa: E402

SECRETS = {"stripe_webhook": "whsec_test_paystudio", "mercadopago_webhook": "mp_test_secret"}


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class App:
    """A local app: records every webhook, verifies Stripe and Mercado Pago signatures when `strict` is set."""

    def __init__(self, strict=True):
        self.received = []
        self.strict = strict
        self.answer = 200
        app = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                valid = app.verify(self.headers, body, self.path)
                app.received.append({"path": self.path, "headers": dict(self.headers), "body": json.loads(body or b"{}"), "valid": valid})
                status = 400 if app.strict and valid is False else app.answer
                self.send_response(status)
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"ok")

        self.server = ThreadingHTTPServer(("127.0.0.1", free_port()), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def verify(self, headers, body, path):
        if "Stripe-Signature" in headers:
            parts = dict(item.split("=", 1) for item in headers["Stripe-Signature"].split(","))
            expected = hmac.new(SECRETS["stripe_webhook"].encode(), f"{parts['t']}.{body.decode()}".encode(), hashlib.sha256).hexdigest()
            return hmac.compare_digest(expected, parts.get("v1", ""))
        if "x-signature" in headers:
            parts = dict(item.split("=", 1) for item in headers["x-signature"].split(","))
            data_id = path.split("data.id=")[1].split("&")[0] if "data.id=" in path else ""
            manifest = f"id:{data_id.lower()};request-id:{headers['x-request-id']};ts:{parts['ts']};"
            expected = hmac.new(SECRETS["mercadopago_webhook"].encode(), manifest.encode(), hashlib.sha256).hexdigest()
            return hmac.compare_digest(expected, parts.get("v1", ""))
        return None

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class LocalGateway:
    def __init__(self, app=None, persistent=False, folder=None):
        self.temporary = None if folder else tempfile.TemporaryDirectory(prefix="paystudio-test-")
        self.folder = Path(folder or self.temporary.name)
        self.app = app or App()
        settings = {"secrets": dict(SECRETS), "webhooks": {"pix": f"{self.app.url}/webhooks", "mercadopago": f"{self.app.url}/webhooks/mp",
                                                           "stripe": f"{self.app.url}/webhooks/stripe"}}
        self.gw = Gateway(self.folder, free_port(), persistent, "test-token", settings)
        self.server = serve(self.gw)
        self.gw.stop_server = self.server.shutdown
        self.gw.status = "running"
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True).start()
        threading.Thread(target=self.gw.run_background, daemon=True).start()

    @property
    def base(self):
        return self.gw.endpoint

    def call(self, method, path, body=None, headers=None, form=None):
        data = None
        headers = dict(headers or {})
        if form is not None:
            from urllib.parse import urlencode
            data = urlencode(form).encode()
            headers.setdefault("Content-Type", "application/x-www-form-urlencoded")
        elif body is not None:
            data = json.dumps(body).encode()
            headers.setdefault("Content-Type", "application/json")
        request = urllib.request.Request(self.base + path, data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=30) as answer:
                text = answer.read().decode()
                return answer.status, (json.loads(text) if text else None), dict(answer.headers)
        except urllib.error.HTTPError as error:
            text = error.read().decode()
            return error.code, (json.loads(text) if text else None), dict(error.headers)

    def admin(self, action, params=None):
        request = urllib.request.Request(f"{self.base}/_paystudio/{action}", json.dumps(params or {}).encode(), method="POST",
                                         headers={"Content-Type": "application/json", "X-PayStudio-Token": "test-token"})
        try:
            with urllib.request.urlopen(request, timeout=30) as answer:
                return json.loads(answer.read())
        except urllib.error.HTTPError as error:
            return json.loads(error.read())

    def close(self):
        self.server.shutdown()
        self.gw.stopping.set()
        self.server.server_close()
        self.gw.final()
        self.app.close()
        if self.temporary:
            time.sleep(0.05)
            try:
                self.temporary.cleanup()
            except OSError:
                pass


def wait_for(check, timeout=10.0, interval=0.05):
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = check()
        if value:
            return value
        time.sleep(interval)
    return check()
