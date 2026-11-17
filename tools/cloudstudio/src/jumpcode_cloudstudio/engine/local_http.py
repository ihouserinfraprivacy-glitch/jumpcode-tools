# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Loopback-only HTTP boundaries, shared by incoming browser requests and integrations."""

import ipaddress
import urllib.request
from urllib.parse import urlsplit

from .wire import AwsError


def local_host(host):
    host = (host or "").lower().rstrip(".")
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def local_url(url):
    try:
        parsed = urlsplit(url)
        return (parsed.scheme in ("http", "https") and local_host(parsed.hostname)
                and parsed.username is None and parsed.password is None and parsed.port != 0)
    except ValueError:
        return False


def check_request(headers):
    """Local SDKs need no browser origin; browsers must originate on this computer."""
    host = headers.get("Host", "")
    origin = headers.get("Origin")
    if not local_url("http://" + host) or (origin is not None and not local_url(origin)):
        raise AwsError("AccessDenied", "CloudStudio accepts requests only from applications on this computer.", 403)
    if headers.get("Sec-Fetch-Site") == "cross-site" and origin is None:
        raise AwsError("AccessDenied", "Cross-site requests need a local origin.", 403)


def require_local_url(url):
    host = urlsplit(url).hostname if local_url(url) else None
    # Virtual-host bucket names are accepted inbound, but never resolved for outbound HTTP.
    if host is None or (host.rstrip(".").lower() != "localhost" and not _loopback_ip(host)):
        raise AwsError("InvalidEndpoint", "CloudStudio only connects to HTTP endpoints on this computer.")
    return url


def _loopback_ip(host):
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


class LocalRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        require_local_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def open_local(request, timeout=10):
    require_local_url(request.full_url)
    # Ignore machine proxy settings: even a loopback URL must never go through an external proxy.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), LocalRedirect())
    return opener.open(request, timeout=timeout)
