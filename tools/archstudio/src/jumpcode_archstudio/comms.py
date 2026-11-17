# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Facts about communication found in files: URLs, env vars, gRPC, routes, topics and device queues."""

import re

from .catalog import BROKERS, SCHEMES

ARG = r"""(?:"[^"\n]{1,160}"|'[^'\n]{1,160}'|`[^`\n]{1,160}`|[A-Za-z_][\w.]{0,80})"""
CONFIG_LANGS = {"yaml", "json", "toml", "properties", "ini", "docker", "config", "txt", "procfile", "tf", "gradle"}
_URL_BODY = (r"(?:jdbc:)?(?P<scheme>https?|wss?|grpcs?|amqps?|mqtts?|tcp|ssl|nats|rediss?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|kafka)"
             r"://(?:[^@\s\"'`/]{1,200}@)?(?P<host>[A-Za-z0-9_.\-]{1,253})(?::(?P<port>\d{1,5}))?(?P<path>/[^\s\"'`]{0,200})?")
_URL_QUOTED = re.compile(r"[\"'`]" + _URL_BODY)
_URL_CONFIG = re.compile(r"(?:^|(?<=[\s=:(,\[\"'`]))" + _URL_BODY, re.M)
_HOSTPORT = re.compile(r"""["'](?P<host>[a-z][a-z0-9\-]{1,62}):(?P<port>\d{2,5})["']""")
_HOSTPORT_CONFIG = re.compile(r"(?:^|(?<=[\s=:\"']))(?P<host>[a-z][a-z0-9\-]{1,62}):(?P<port>\d{2,5})\b", re.M)
_ENV = re.compile(r"\b(?P<prefix>[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*?)_(?P<suffix>(?:SERVICE_)?(?:GRPC_)?(?:BASE_)?(?:URL|URI|ADDR|ADDRESS|HOST|ENDPOINT|TARGET))\b")
_PROTO_SERVICE = re.compile(r"(?m)^\s*service\s+(\w+)\s*\{")
_GRPC_SERVER = re.compile(r"\bRegister(\w+?)Server\s*\(|\badd_(\w+?)Servicer_to_server\b|\b(\w+?)Grpc\.\w+?ImplBase\b|\bMapGrpcService<(\w+?)>")
_GRPC_CLIENT = re.compile(r"(?<!func )\bNew(\w+?)Client\s*\(|\b(\w+?)Stub\s*\(|\b(\w+?)Grpc\.new(?:Blocking|Future)?Stub\s*\(|\bnew\s+(\w+?)Client\s*\(")
_ROUTE = re.compile(
    r"""\.(?P<method>get|post|put|patch|delete|all|GET|POST|PUT|PATCH|DELETE|Any|Get|Post|Put|Patch|Delete|HandleFunc|Handle|route|Route"""
    r"""|MapGet|MapPost|MapPut|MapDelete|MapPatch|api_route|add_api_route)\s*\(\s*["'`](?P<path>(?:(?:GET|POST|PUT|PATCH|DELETE)\s+)?/[^"'`\s]{0,200})["'`]""")
_ANNOTATION = re.compile(r"""@(?P<method>Get|Post|Put|Patch|Delete|Request)(?:Mapping)?\b(?:\s*\(\s*(?:(?:value|path)\s*=\s*)?\{?\s*["'](?P<path>[^"']*)["'])?""")
_CONTROLLER = re.compile(r"""@(?:Controller|RequestMapping|RestController)\s*\(\s*(?:(?:value|path)\s*=\s*)?["'](?P<path>[^"']*)["']""")
_ASPNET = re.compile(r"""\[Http(?P<method>Get|Post|Put|Patch|Delete)\s*\(\s*"(?P<path>[^"]*)"\s*\)\]""")
_METHODS = re.compile(r"methods\s*=\s*\[([^\]]*)\]")
_NEXT_HANDLER = re.compile(r"export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b")
_LISTEN = re.compile(r"""ListenAndServe(?:TLS)?\(\s*"[\w.]*:(\d{2,5})"|Listen\(\s*"tcp"\s*,\s*"[\w.]*:(\d{2,5})"|\.listen\(\s*(\d{2,5})\b"""
                     r"""|\.Run\(\s*"[\w.]*:(\d{2,5})"|\bport\s*=\s*(\d{2,5})\b|server\.port\s*[=:]\s*(\d{2,5})|EXPOSE\s+(\d{2,5})""")
_CONSTANTS = (
    re.compile(r"""(?m)^[ \t]*#[ \t]*define[ \t]+(\w+)[ \t]+"([^"\n]{1,160})\""""),
    re.compile(r"""\b(\w+)\s*(?::=|=)\s*(?:fmt\.Sprintf\s*\(\s*|String\.format\s*\(\s*|f)?["'`]([^"'`\n]{1,160})["'`]"""),
    re.compile(r"""\bs?n?printf\s*\(\s*(\w+)\s*,\s*(?:[^,"\n]{1,60},\s*)?"([^"\n]{1,160})\""""),
)
_BOTO3 = re.compile(r"""boto3\.(?:client|resource)\(\s*["'](s3|dynamodb|sqs)["']""")
_QUEUE_SEND = re.compile(r"\bxQueue(?:Send(?:ToBack|ToFront)?|Overwrite)(?:FromISR)?\s*\(\s*(\w+)")
_QUEUE_RECEIVE = re.compile(r"\bxQueue(?:Receive|Peek)(?:FromISR)?\s*\(\s*(\w+)")
_TOPIC = re.compile(r"^[\w.+#*/\-:%{}$<>]{1,160}$")
_PLACEHOLDER = re.compile(r"%[-+ 0#]*\d*(?:\.\d+)?(?:l{0,2}|h{0,2}|z)?[sdiuxXfcvq]|\$?\{[^}]{0,40}\}|<\w{1,30}>")


def _messaging_rules():
    publish, consume, bind = "publish", "consume", "bind"
    return {
        "rabbitmq": (
            (re.compile(r"\.Publish(?:WithContext|WithDeferredConfirmWithContext)?\s*\(\s*(?:ctx\s*,\s*|context\.\w+\(\)\s*,\s*)?(?P<a>" + ARG + r")\s*,\s*(?P<b>" + ARG + ")"), publish),
            (re.compile(r"\.publish\s*\(\s*(?P<a>" + ARG + r")\s*,\s*(?P<b>" + ARG + ")"), publish),
            (re.compile(r"\.sendToQueue\s*\(\s*(?P<b>" + ARG + ")"), publish),
            (re.compile(r"basic_publish\s*\((?P<pre>[^)]{0,300}?)routing_key\s*=\s*(?P<b>" + ARG + ")"), publish),
            (re.compile(r"convertAndSend\s*\(\s*(?P<a>" + ARG + r")\s*,\s*(?P<b>" + ARG + ")"), publish),
            (re.compile(r"\.Consume\s*\(\s*(?:ctx\s*,\s*)?(?P<b>" + ARG + ")"), consume),
            (re.compile(r"\.consume\s*\(\s*(?P<b>" + ARG + ")"), consume),
            (re.compile(r"basic_consume\s*\([^)]{0,300}?queue\s*=\s*(?P<b>" + ARG + ")"), consume),
            (re.compile(r"@RabbitListener\s*\(\s*queues\s*=\s*\{?\s*(?P<b>" + ARG + ")"), consume),
            (re.compile(r"\.QueueBind\s*\(\s*(?P<q>" + ARG + r")\s*,\s*(?P<b>" + ARG + ")"), bind),
            (re.compile(r"\.bindQueue\s*\(\s*(?P<q>" + ARG + r")\s*,\s*(?P<a>" + ARG + r")\s*,\s*(?P<b>" + ARG + ")"), bind),
            (re.compile(r"queue_bind\s*\([^)]{0,300}?routing_key\s*=\s*(?P<b>" + ARG + ")"), bind),
        ),
        "mqtt": (
            (re.compile(r"\.(?:Publish|publish|publishMessage)\s*\(\s*(?P<b>" + ARG + ")"), publish),
            (re.compile(r"\besp_mqtt_client_(?:publish|enqueue)\s*\(\s*\w+\s*,\s*(?P<b>" + ARG + ")"), publish),
            (re.compile(r"\.(?:Subscribe|subscribe|SubscribeMultiple)\s*\(\s*(?P<b>" + ARG + ")"), consume),
            (re.compile(r"\besp_mqtt_client_subscribe(?:_single)?\s*\(\s*\w+\s*,\s*(?P<b>" + ARG + ")"), consume),
        ),
        "kafka": (
            (re.compile(r"\bTopic\s*:\s*(?P<b>" + ARG + ")"), "kafka-go"),
            (re.compile(r"\.send\s*\(\s*\{\s*topic\s*:\s*(?P<b>" + ARG + ")"), publish),
            (re.compile(r"\.subscribe\s*\(\s*\{\s*topics?\s*:\s*\[?\s*(?P<b>" + ARG + ")"), consume),
            (re.compile(r"\.(?:send|send_and_wait|produce|Produce)\s*\(\s*(?P<b>" + ARG + ")"), publish),
            (re.compile(r"KafkaConsumer\s*\(\s*(?P<b>" + ARG + ")"), consume),
            (re.compile(r"\.subscribe\s*\(\s*\[\s*(?P<b>" + ARG + ")"), consume),
            (re.compile(r"@KafkaListener\s*\([^)]{0,200}?topics\s*=\s*\{?\s*(?P<b>" + ARG + ")"), consume),
        ),
        "nats": (
            (re.compile(r"\.(?:Publish|publish|PublishMsg)\s*\(\s*(?P<b>" + ARG + ")"), publish),
            (re.compile(r"\.(?:Subscribe|QueueSubscribe|ChanSubscribe|subscribe)\s*\(\s*(?P<b>" + ARG + ")"), consume),
        ),
        "redis-pubsub": (
            (re.compile(r"\.Publish\s*\(\s*ctx\s*,\s*(?P<b>" + ARG + ")"), publish),
            (re.compile(r"\.P?Subscribe\s*\(\s*ctx\s*,\s*(?P<b>" + ARG + ")"), consume),
            (re.compile(r"\.publish\s*\(\s*(?P<b>" + ARG + ")"), publish),
            (re.compile(r"\.p?subscribe\s*\(\s*(?P<b>" + ARG + ")"), consume),
        ),
        "sqs": (
            (re.compile(r"QueueUrl\s*:\s*(?P<b>" + ARG + ")"), "sqs"),
        ),
    }


MESSAGING = _messaging_rules()


class Facts:
    """Everything the link resolution needs, collected file by file."""

    def __init__(self):
        self.libraries = []      # (service, target key, path, line)
        self.urls = []           # (service, scheme, host, port, url path, path, line)
        self.hostports = []      # (service, host, port, path, line, grpc)
        self.envs = []           # (service, name, prefix, path, line, grpc)
        self.grpc_servers = {}   # normalized name -> {service: (path, line)}
        self.grpc_clients = []   # (service, raw name, normalized, path, line)
        self.proto = {}          # normalized -> declared name
        self.endpoints = {}      # service -> [endpoint]
        self.messages = []       # (service, broker, direction, topic, path, line)
        self.queues = []         # (service, handle, direction, path, line)
        self.ports = {}          # port -> {service}
        self.constants = {}      # service -> {name: value}


def grpc_name(name):
    name = name or ""
    for suffix in ("ServiceClient", "Service", "Servicer", "Client", "Grpc", "API", "Api"):
        if name.endswith(suffix) and len(name) > len(suffix):
            name = name[:-len(suffix)]
            break
    return name.lower()


def collect(facts, service, system_kind, path, lang, text, lines):
    """First pass over one file: everything except messaging."""
    config = lang in CONFIG_LANGS
    for match in (_URL_CONFIG if config else _URL_QUOTED).finditer(text):
        facts.urls.append((service, match.group("scheme").lower(), match.group("host").lower(), match.group("port"),
                           match.group("path") or "", path, lines.line(match.start("scheme"))))
    grpc = "grpc" in text.lower()
    for match in (_HOSTPORT_CONFIG if config else _HOSTPORT).finditer(text):
        facts.hostports.append((service, match.group("host"), match.group("port"), path, lines.line(match.start("host")), grpc))
    if lang not in ("json",):
        for match in _ENV.finditer(text):
            facts.envs.append((service, match.group(0), match.group("prefix"), path, lines.line(match.start()), grpc or "GRPC" in match.group(0)))
    if lang == "proto":
        for match in _PROTO_SERVICE.finditer(text):
            facts.proto.setdefault(grpc_name(match.group(1)), match.group(1))
        return
    if config and lang != "docker":
        _listen(facts, service, text)
        return
    for match in _BOTO3.finditer(text):
        facts.libraries.append((service, match.group(1).lower(), path, lines.line(match.start())))
    if "Server" in text or "Servicer" in text or "ImplBase" in text:
        for match in _GRPC_SERVER.finditer(text):
            raw = next(group for group in match.groups() if group)
            facts.grpc_servers.setdefault(grpc_name(raw), {}).setdefault(service, (path, lines.line(match.start())))
    if "Client" in text or "Stub" in text:
        for match in _GRPC_CLIENT.finditer(text):
            raw = next(group for group in match.groups() if group)
            facts.grpc_clients.append((service, raw, grpc_name(raw), path, lines.line(match.start())))
    if system_kind == "backend":
        _routes(facts, service, path, text, lines)
    elif system_kind == "web":
        _next_routes(facts, service, path, text, lines)
    _listen(facts, service, text)
    table = facts.constants.setdefault(service, {})
    for pattern in _CONSTANTS:
        for match in pattern.finditer(text):
            table.setdefault(match.group(1), match.group(2))
    if lang in ("c", "cpp", "h") and "xQueue" in text:
        for pattern, direction in ((_QUEUE_SEND, "send"), (_QUEUE_RECEIVE, "receive")):
            for match in pattern.finditer(text):
                facts.queues.append((service, match.group(1), direction, path, lines.line(match.start())))


def _listen(facts, service, text):
    for match in _LISTEN.finditer(text):
        port = next(group for group in match.groups() if group)
        facts.ports.setdefault(port, set()).add(service)


def _endpoint(facts, service, method, route, path, line):
    entries = facts.endpoints.setdefault(service, [])
    if len(entries) >= 40 or any(item["method"] == method and item["path"] == route for item in entries):
        return
    entries.append({"method": method, "path": route, "file": path, "line": line})


def _routes(facts, service, path, text, lines):
    for match in _ROUTE.finditer(text):
        method, route = match.group("method"), match.group("path")
        pattern = re.match(r"(GET|POST|PUT|PATCH|DELETE)\s+(/.*)", route)
        if pattern:
            method, route = pattern.group(1), pattern.group(2)
        elif method.lower() in ("route", "api_route", "add_api_route"):
            methods = _METHODS.search(text, match.end(), match.end() + 200)
            found = re.findall(r"[A-Za-z]+", methods.group(1)) if methods else []
            method = found[0].upper() if found else "GET"
        elif method.startswith("Map"):
            method = method[3:].upper()
        elif method in ("HandleFunc", "Handle", "Any", "all"):
            method = "ANY"
        else:
            method = method.upper()
        _endpoint(facts, service, method, route, path, lines.line(match.start()))
    prefix = _CONTROLLER.search(text)
    base = "/" + prefix.group("path").strip("/") if prefix and prefix.group("path").strip("/") else ""
    for match in _ANNOTATION.finditer(text):
        if match.group("method") == "Request" and match.group("path") is not None and prefix and match.start() == prefix.start():
            continue
        if match.group("method") == "Request":
            continue
        route = (match.group("path") or "").strip("/")
        _endpoint(facts, service, match.group("method").upper(), (base + "/" + route).rstrip("/") or "/", path, lines.line(match.start()))
    for match in _ASPNET.finditer(text):
        _endpoint(facts, service, match.group("method").upper(), "/" + match.group("path").strip("/"), path, lines.line(match.start()))


def _next_routes(facts, service, path, text, lines):
    parts = path.split("/")
    if "api" not in parts:
        return
    index = parts.index("api")
    stem = parts[-1].rsplit(".", 1)[0]
    segments = parts[index:-1] if stem in ("route", "index") else parts[index:-1] + [stem]
    route = "/" + "/".join(re.sub(r"^\[(?:\.\.\.)?(\w+)\]$", r":\1", segment) for segment in segments)
    methods = [match.group(1) for match in _NEXT_HANDLER.finditer(text)] or (["ANY"] if "pages" in parts[:index] else [])
    for method in methods:
        _endpoint(facts, service, method, route, path, 1)


def _value(token, constants):
    token = token.strip()
    if token[:1] in "\"'`":
        return token[1:-1]
    name = token.rsplit(".", 1)[-1]
    return constants.get(name)


def normalize_topic(value):
    if not value:
        return None
    value = _PLACEHOLDER.sub("+", value.strip())
    if not _TOPIC.match(value) or value in ("+", "#", "*"):
        return None
    return value


def collect_messages(facts, service, path, lang, text, lines, brokers, constants):
    """Second pass: publish and subscribe calls, once the brokers of each service are known."""
    if lang in CONFIG_LANGS or lang == "proto":
        return
    for broker in BROKERS:
        if broker not in brokers:
            continue
        for pattern, direction in MESSAGING.get(broker, ()):
            for match in pattern.finditer(text):
                groups = match.groupdict()
                topic = _value(groups["b"], constants) if groups.get("b") else None
                if broker == "rabbitmq" and direction == "publish" and groups.get("a") is not None and not topic:
                    topic = _value(groups["a"], constants)
                if direction == "kafka-go":
                    window = text[max(0, match.start() - 300):match.start()]
                    reader, writer = window.rfind("Reader"), window.rfind("Writer")
                    if reader < 0 and writer < 0:
                        continue
                    direction = "consume" if reader > writer else "publish"
                if direction == "sqs":
                    continue
                topic = normalize_topic(topic)
                if topic:
                    facts.messages.append((service, broker, direction, topic, path, lines.line(match.start())))


def connection_target(scheme, port):
    """TARGETS key for a connection string scheme, or None."""
    if scheme in SCHEMES:
        return SCHEMES[scheme]
    if scheme in ("tcp", "ssl") and port in ("1883", "8883"):
        return "mqtt"
    if scheme in ("ws", "wss") and port in ("8083", "8084", "9001"):
        return "mqtt"
    return None
