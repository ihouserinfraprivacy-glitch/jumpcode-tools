# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""HTTP front door of the fake gateway: finds which API the app is calling (Pix, Mercado Pago, Stripe), applies
the failure controls, answers in that API's own format and records the call for the Studio."""

from email.utils import formatdate
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import time
from urllib.parse import parse_qsl, unquote, urlsplit

from . import mercadopago, pix, rules, stripe, wire
from .core import clip, redact
from .local_http import NotLocal, check_request, local_url
from .wire import GatewayError, Response

MAX_BODY = 2 * 1024 * 1024


class Request:
    def __init__(self, method, target, headers, body):
        split = urlsplit(target)
        self.method = method
        self.path = unquote(split.path or "/")
        self.query = dict(parse_qsl(split.query, keep_blank_values=True))
        self.headers = {key.lower(): value for key, value in headers.items()}
        self.body = body
        self.op = ""
        self.ref = None
        self.flag = None
        self.note_req = None
        self.note_res = None


class Closed(Exception):
    """The failure control asked to drop the connection without an answer."""


def route(path, headers):
    """(gateway, path inside it) for a request path."""
    for prefix in ("pix", "mercadopago", "stripe"):
        if path == f"/{prefix}" or path.startswith(f"/{prefix}/"):
            return prefix, path[len(prefix) + 1:] or "/"
    if path.startswith("/v1/"):
        auth = headers.get("authorization", "")
        return ("stripe" if "sk_" in auth or "rk_" in auth or auth.lower().startswith("basic ") else "mercadopago"), path
    if path.startswith("/v2/") or path.startswith("/oauth/"):
        return "pix", path
    return None, path


def error_body(gateway, status, code, message):
    if gateway == "stripe":
        return {"error": {"type": "api_error", "code": code, "message": message}}
    if gateway == "mercadopago":
        return {"message": message, "error": code, "status": status, "cause": []}
    return {"type": pix.ERRORS + code, "title": message, "status": status, "detail": message}


def handle(gw, request):
    if request.path.startswith("/_paystudio/"):
        from .admin import handle_admin
        return handle_admin(gw, request)
    gateway, inner = route(request.path, request.headers)
    started = time.perf_counter()
    response = None
    error = None
    try:
        if gateway is None:
            raise GatewayError(404, {"message": f"PayStudio emulates /pix (API Pix), /mercadopago and /stripe; {request.path} is none of them."},
                               "not_found", "Unknown path")
        failure = rules.failure_for(gw, gateway)
        if failure:
            request.flag = f"falha simulada: {failure['mode']}"
            if failure["mode"] == "slow":
                gw.stopping.wait(failure["latency_ms"] / 1000)
            elif failure["mode"] == "timeout":
                gw.stopping.wait(60)
                raise GatewayError(504, error_body(gateway, 504, "timeout", "Simulated timeout (PayStudio failure control)."), "timeout", "timeout")
            elif failure["mode"] == "unavailable":
                raise GatewayError(503, error_body(gateway, 503, "service_unavailable", "Simulated outage (PayStudio failure control)."),
                                   "service_unavailable", "Simulated outage")
            elif failure["mode"] == "rate_limit":
                raise GatewayError(429, error_body(gateway, 429, "rate_limit", "Too many requests (PayStudio failure control)."),
                                   "rate_limit", "Too many requests")
            elif failure["mode"] == "refuse":
                raise Closed()
        module = {"pix": pix, "mercadopago": mercadopago, "stripe": stripe}[gateway]
        response = module.handle(gw, request, inner)
    except GatewayError as caught:
        error = caught
        response = wire.json_response(caught.body, caught.status,
                                      content_type="application/problem+json" if gateway == "pix" else "application/json")
    except Closed:
        _record(gw, request, gateway, None, (time.perf_counter() - started) * 1000, ("connection_refused", "Simulated: connection dropped"))
        raise
    except Exception as caught:  # an emulator bug answers 500 instead of hanging the app
        error = GatewayError(500, {}, "internal_error", f"{type(caught).__name__}: {caught}")
        response = wire.json_response(error_body(gateway or "stripe", 500, "internal_error", f"PayStudio failed: {type(caught).__name__}: {caught}"), 500)
    _record(gw, request, gateway, response, (time.perf_counter() - started) * 1000,
            (error.code, error.message) if error else None)
    return response


def _record(gw, request, gateway, response, ms, error):
    body = request.note_req
    if body is None and request.body:
        try:
            text = request.body.decode("utf-8")
            if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() == "application/x-www-form-urlencoded":
                body = stripe.parse_form(request.body)
            else:
                body = json.loads(text)
            if not isinstance(body, (dict, list)):
                body = "(conteúdo não estruturado omitido)"
        except (UnicodeDecodeError, ValueError):
            body = "(conteúdo inválido omitido)"
    result = request.note_res
    if result is None and response is not None and response.body:
        try:
            result = json.loads(response.body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            result = None
    gw.record({"at": round(time.time(), 3), "ms": round(ms, 1), "gateway": gateway or "?", "method": request.method, "path": request.path,
               "op": request.op or request.path, "status": response.status if response is not None else 0, "ref": request.ref,
               "idempotency": request.headers.get("idempotency-key") or request.headers.get("x-idempotency-key"),
               "client": _client(request.headers.get("user-agent", "")), "flag": request.flag,
               "req": clip(redact(body)) if body else None, "res": clip(redact(result), 3000) if result else None,
               "error": {"code": error[0], "message": str(error[1])[:600]} if error else None})


def _client(agent):
    agent = agent.lower()
    for key, label in (("stripe/v1 nodebindings", "stripe-node"), ("stripe/v1 pythonbindings", "stripe-python"), ("stripe", "Stripe SDK"),
                       ("mercadopago", "SDK Mercado Pago"), ("axios", "axios"), ("node-fetch", "node-fetch"), ("undici", "fetch (Node)"),
                       ("python-requests", "requests"), ("python-urllib", "urllib"), ("curl", "curl"), ("mozilla", "navegador")):
        if key in agent:
            return label
    return ""


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "PayStudio"
    sys_version = ""
    gateway = None

    def log_message(self, format, *args):
        pass

    def _serve(self):
        try:
            check_request(self.headers)
        except NotLocal as caught:
            self._send(wire.json_response({"error": "forbidden", "message": str(caught)}, 403))
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            self.close_connection = True
            self._send(wire.json_response({"error": "payload_too_large"}, 413))
            return
        body = self.rfile.read(length) if length else b""
        request = Request(self.command, self.path, self.headers, body)
        if self.command == "OPTIONS":
            self._send(Response(204, b""))
            return
        try:
            response = handle(self.gateway, request)
        except Closed:
            self.close_connection = True
            return
        self._send(response)

    def _send(self, response):
        self.send_response(response.status)
        for key, value in response.headers.items():
            self.send_header(key, str(value))
        self.send_header("Date", formatdate(usegmt=True))
        origin = self.headers.get("Origin")
        if origin and local_url(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, PUT, POST, PATCH, DELETE, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", self.headers.get("Access-Control-Request-Headers") or "Authorization, Content-Type")
        self.send_header("Content-Length", str(len(response.body)))
        self.end_headers()
        if self.command != "HEAD" and response.body:
            self.wfile.write(response.body)

    do_GET = do_PUT = do_POST = do_PATCH = do_DELETE = do_HEAD = do_OPTIONS = _serve


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False
    request_queue_size = 64

    def handle_error(self, request, client_address):
        pass


def serve(gw, host="127.0.0.1"):
    handler = type("PayHandler", (Handler,), {"gateway": gw})
    return Server((host, gw.port), handler)
