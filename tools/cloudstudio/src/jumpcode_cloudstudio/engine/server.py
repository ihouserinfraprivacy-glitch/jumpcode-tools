# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""HTTP front door of the local cloud: reads each request, finds the AWS service it is meant for,
runs it, and records the call for the Studio."""

from collections import deque
from email.utils import formatdate
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import re
import threading
import time
from urllib.parse import parse_qsl, unquote, urlsplit

from . import wire
from .wire import AwsError, Response

_CREDENTIAL = re.compile(r"Credential=(?P<key>[^/,\s]+)/(?P<date>\d{8})/(?P<region>[^/]+)/(?P<service>[^/]+)/aws4_request")
_ACCOUNT_KEY = re.compile(r"^\d{12}$")

TARGET_PREFIXES = {
    "DynamoDB_20120810": "dynamodb",
    "AmazonSQS": "sqs",
    "secretsmanager": "secretsmanager",
    "AmazonSSM": "ssm",
    "AWSStepFunctions": "stepfunctions",
    "Logs_20140328": "logs",
    "AWSEvents": "events",
}
SIGNING_NAMES = {
    "s3": "s3", "sqs": "sqs", "sns": "sns", "lambda": "lambda", "scheduler": "scheduler", "sts": "sts",
    "states": "stepfunctions", "logs": "logs", "events": "events", "secretsmanager": "secretsmanager",
    "ssm": "ssm", "dynamodb": "dynamodb", "apigateway": "apigatewayv2", "execute-api": "apigatewayv2",
}
QUERY_VERSIONS = {"2010-03-31": "sns", "2011-06-15": "sts", "2012-11-05": "sqs"}
CLIENTS = (("terraform", "Terraform"), ("aws-cli", "AWS CLI"), ("boto3", "boto3"), ("botocore", "botocore"),
           ("aws-sdk-js", "SDK JavaScript"), ("aws-sdk-java", "SDK Java"), ("aws-sdk-go", "SDK Go"),
           ("aws-sdk-dotnet", "SDK .NET"), ("aws-sdk-php", "SDK PHP"), ("aws-sdk-ruby", "SDK Ruby"),
           ("aws-sdk-rust", "SDK Rust"))
MAX_BODY = 512 * 1024 * 1024
MAX_NOTE = 1600


class Request:
    """One HTTP request plus what the emulator learns about it (who calls, which account and region)."""

    def __init__(self, method, target, headers, body, default_region):
        self.method = method
        split = urlsplit(target)
        self.raw_path = split.path or "/"
        self.raw_query = split.query
        self.path = unquote(self.raw_path)
        self.query_pairs = parse_qsl(split.query, keep_blank_values=True)
        self.query = dict(self.query_pairs)
        self.headers = {key.lower(): value for key, value in headers.items()}
        self.body = body
        self.host = self.headers.get("host", "")
        auth = self.headers.get("authorization", "") or ""
        match = _CREDENTIAL.search(auth) or _CREDENTIAL.search("Credential=" + self.query.get("X-Amz-Credential", ""))
        self.access_key = match.group("key") if match else ""
        self.region = match.group("region") if match else default_region
        self.signing = match.group("service") if match else ""
        self.account = self.access_key if _ACCOUNT_KEY.match(self.access_key) else wire.DEFAULT_ACCOUNT
        token = self.headers.get("x-amz-security-token") or self.query.get("X-Amz-Security-Token", "")
        self.source = token[len("cloudstudio:"):] if token.startswith("cloudstudio:") else "app"
        agent = self.headers.get("user-agent", "").lower()
        self.client = next((label for key, label in CLIENTS if key in agent), "")
        self.service = ""
        self.op = ""
        self.target = ""
        self.note_req = None
        self.note_res = None
        self.id = wire.request_id()
        self._form = None
        self._json = None

    def json(self):
        if self._json is None:
            try:
                self._json = json.loads(self.body.decode("utf-8")) if self.body.strip() else {}
            except (UnicodeDecodeError, ValueError) as error:
                raise AwsError("SerializationException", "The request body is not valid JSON") from error
            if not isinstance(self._json, dict):
                raise AwsError("SerializationException", "The request body must be a JSON object")
        return self._json

    def form(self):
        if self._form is None:
            values = dict(self.query_pairs)
            if self.method == "POST" and self.body:
                values.update(parse_qsl(self.body.decode("utf-8", "replace"), keep_blank_values=True))
            self._form = values
        return self._form


class Cloud:
    """The running local cloud: state, services, background work, call history and the Studio files."""

    def __init__(self, studio_root, port, persistent=False, token="", region=wire.DEFAULT_REGION, python=None, node=None):
        from pathlib import Path
        from .state import Store
        from .live import Live
        from .runtime import Runtime
        self.root = Path(studio_root)
        self.port = port
        self.token = token
        self.region = region
        self.started = time.time()
        self.ready_ms = 0
        self.store = Store(self.root / "data", persistent)
        if persistent:
            self.store.load()
        else:
            self.store.forget()
        self.store.gc_blobs()
        self.calls = deque(maxlen=400)
        self.logs = deque(maxlen=1000)
        self.call_count = 0
        self.error_count = 0
        self.history_lock = threading.Lock()
        self.stopping = threading.Event()
        from .operation import Operations
        self.operations = Operations()
        self.runtime = Runtime(self, python=python, node=node)
        from .services import SERVICES
        self.services = SERVICES
        self.live = Live(self)
        self.store.listeners.append(lambda: self.live.mark("resources"))

    @property
    def endpoint(self):
        return f"http://127.0.0.1:{self.port}"

    # ------------------------------------------------------------ requests
    def handle(self, request):
        started = time.perf_counter()
        response = None
        error = None
        try:
            if request.method == "OPTIONS":
                response = Response(200, b"")
            elif request.path.startswith("/_cloudstudio/"):
                from .admin import handle_admin
                return handle_admin(self, request)
            else:
                name = self.detect(request)
                request.service = name
                module = self.services.get(name)
                if module is None:
                    error = AwsError("NotImplemented", f"CloudStudio does not emulate the {name or 'requested'} service. "
                                     f"Emulated services: {', '.join(sorted(self.services))}.", 501)
                    response = wire.json_error(error, "")
                else:
                    response = module.handle(self, request)
        except AwsError as caught:
            error = caught
            response = wire.json_error(caught, "")
        except Exception as caught:  # an emulator bug must not take the server down
            error = AwsError("InternalFailure", f"CloudStudio failed while handling this call: {type(caught).__name__}: {caught}", 500, sender=False)
            response = wire.json_error(error, "")
            self.log("/cloudstudio/engine", "errors", f"{request.method} {request.path}: {type(caught).__name__}: {caught}", "error")
        if error is None and response.status >= 400:
            error = _error_from(response)
        self.record(request, response, error, (time.perf_counter() - started) * 1000)
        return response

    def detect(self, request):
        target = request.headers.get("x-amz-target", "")
        if target:
            return TARGET_PREFIXES.get(target.split(".", 1)[0], target.split(".", 1)[0].lower())
        if request.path.startswith("/_api/"):
            return "apigatewayv2"
        host = request.host.split(":")[0].lower()
        if ".execute-api." in host:
            return "apigatewayv2"
        if request.signing:
            name = SIGNING_NAMES.get(request.signing, request.signing)
            if name == "apigatewayv2" and not request.path.startswith("/v2/"):
                return "apigateway"
            return name
        form = request.form() if request.headers.get("content-type", "").startswith("application/x-www-form-urlencoded") or "Action" in request.query else {}
        if "Action" in form:
            return QUERY_VERSIONS.get(form.get("Version", ""), "sqs" if "QueueUrl" in form else "sns")
        return "s3"

    def record(self, request, response, error, ms):
        entry = {
            "id": 0, "at": round(time.time(), 3), "ms": round(ms, 1), "service": request.service, "op": request.op or request.method,
            "target": request.target, "status": response.status, "account": request.account, "region": request.region,
            "source": request.source, "client": request.client,
            "req": _note(request.note_req), "res": _note(request.note_res),
            "error": {"code": error.code, "message": error.message[:600]} if error else None,
        }
        self.remember(entry)

    def remember(self, entry):
        with self.history_lock:
            self.call_count += 1
            entry["id"] = self.call_count
            if entry.get("error"):
                self.error_count += 1
            self.calls.append(entry)
        self.live.mark("calls")

    def internal_call(self, service, op, target, source, ms=0.0, error=None, req=None, res=None, region=None, account=None):
        """Records work the cloud did by itself (an event source invoking a function, a topic delivering to a queue)."""
        self.remember({"id": 0, "at": round(time.time(), 3), "ms": round(ms, 1), "service": service, "op": op, "target": target,
                       "status": 500 if error else 200, "account": account or wire.DEFAULT_ACCOUNT, "region": region or self.region,
                       "source": source, "client": "CloudStudio", "req": _note(req), "res": _note(res),
                       "error": {"code": error[0], "message": error[1][:600]} if error else None})

    def log(self, group, stream, text, level="info", request=None, account=None, region=None):
        with self.history_lock:
            for line in str(text).splitlines() or [""]:
                self.logs.append({"at": round(time.time(), 3), "group": group, "stream": stream, "level": level,
                                  "text": line[:2000], "request": request, "account": account or wire.DEFAULT_ACCOUNT,
                                  "region": region or self.region})
        self.live.mark("logs")

    # ------------------------------------------------------------ lifecycle
    def summary(self):
        resources = []
        for module in self.services.values():
            describe = getattr(module, "resources", None)
            if describe:
                try:
                    resources.extend(describe(self))
                except Exception as caught:  # a summary bug only hides that service's list
                    self.log("/cloudstudio/engine", "errors", f"listing {module.NAME}: {type(caught).__name__}: {caught}", "error")
        return resources

    def shutdown(self):
        self.stopping.set()
        self.runtime.stop()
        self.store.save()


def _note(value):
    if value is None:
        return None
    if not isinstance(value, str):
        value = json.dumps(value, ensure_ascii=False, default=str)
    return value if len(value) <= MAX_NOTE else value[:MAX_NOTE] + "…"


def _error_from(response):
    """The AWS error code inside an error response, whatever protocol produced it."""
    code = response.headers.get("x-amzn-ErrorType", "")
    message = ""
    text = response.body[:4000].decode("utf-8", "replace")
    if not code:
        match = re.search(r"<Code>([^<]+)</Code>", text)
        code = match.group(1) if match else ""
        match = re.search(r"<Message>([^<]*)</Message>", text)
        message = match.group(1) if match else ""
    if not message:
        try:
            body = json.loads(text)
            message = body.get("message") or body.get("Message") or ""
            code = code or str(body.get("__type", "")).split("#")[-1]
        except ValueError:
            pass
    return AwsError(code.split(":")[0] or f"HTTP{response.status}", message or f"HTTP {response.status}", response.status)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "CloudStudio"
    sys_version = ""
    cloud = None

    def log_message(self, format, *args):  # the Studio shows calls; nothing goes to stderr
        pass

    def _read_body(self):
        if "chunked" in self.headers.get("Transfer-Encoding", "").lower():
            chunks = []
            total = 0
            while True:
                line = self.rfile.readline(65537)
                size = int(line.split(b";")[0].strip() or b"0", 16)
                if size == 0:
                    while self.rfile.readline(65537) not in (b"\r\n", b"\n", b""):
                        pass
                    break
                total += size
                if total > MAX_BODY:
                    raise AwsError("EntityTooLarge", "Request body is too large", 413)
                chunks.append(self.rfile.read(size))
                self.rfile.readline(3)
            return b"".join(chunks)
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise AwsError("EntityTooLarge", "Request body is too large", 413)
        return self.rfile.read(length) if length else b""

    def _serve(self):
        from .local_http import check_request
        try:
            check_request(self.headers)
        except AwsError as error:
            self.close_connection = True
            self._send(wire.json_error(error, ""))
            return
        try:
            body = self._read_body()
        except (AwsError, ValueError):
            self.close_connection = True
            self._send(Response(413, b""))
            return
        request = Request(self.command, self.path, self.headers, body, self.cloud.region)
        response = self.cloud.handle(request)
        self._send(response, head=self.command == "HEAD")

    def _send(self, response, head=False):
        self.send_response(response.status)
        headers = {k.lower(): (k, v) for k, v in response.headers.items() if not k.lower().startswith("access-control-")}
        for _, (key, value) in headers.items():
            self.send_header(key, str(value))
        if "date" not in headers:
            self.send_header("Date", formatdate(usegmt=True))
        if "x-amzn-requestid" not in headers:
            self.send_header("x-amzn-RequestId", wire.request_id())
        from .local_http import local_url
        origin = self.headers.get("Origin")
        if origin and local_url(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, HEAD, PATCH, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", self.headers.get("Access-Control-Request-Headers") or "*")
            self.send_header("Access-Control-Expose-Headers", "*")
        if "content-length" not in headers:
            self.send_header("Content-Length", str(len(response.body)))
        self.end_headers()
        if not head and response.body:
            self.wfile.write(response.body)

    do_GET = do_PUT = do_POST = do_DELETE = do_HEAD = do_PATCH = do_OPTIONS = _serve


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False
    request_queue_size = 64

    def handle_error(self, request, client_address):
        # A client that hangs up early (SDK timeouts, browsers) is normal; nothing goes to stderr.
        pass


def serve(cloud, host="127.0.0.1"):
    handler = type("CloudHandler", (Handler,), {"cloud": cloud})
    return Server((host, cloud.port), handler)
