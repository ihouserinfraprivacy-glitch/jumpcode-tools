# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Loopback-only HTTP boundaries: requests must come from this computer, webhooks only go to it."""

import ipaddress
import urllib.request
from urllib.parse import urlsplit


class NotLocal(ValueError):
    """A request or a webhook address that is not on this computer."""


def local_host(host):
    host = (host or "").lower().rstrip(".")
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        return ipaddress.ip_address(host.strip("[]")).is_loopback
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
    """SDKs and servers send no browser origin; a browser must be on a page of this computer."""
    host = headers.get("Host", "")
    origin = headers.get("Origin")
    if not local_url("http://" + host) or (origin is not None and not local_url(origin)):
        raise NotLocal("PayStudio accepts requests only from applications on this computer.")
    if headers.get("Sec-Fetch-Site") == "cross-site" and origin is None:
        raise NotLocal("Cross-site requests need a local origin.")


def require_local_url(url):
    host = urlsplit(url).hostname if local_url(url) else None
    if host is None or (host.rstrip(".").lower() != "localhost" and not _loopback_ip(host)):
        raise NotLocal("PayStudio only delivers webhooks to addresses on this computer (localhost or 127.0.0.1).")
    return url


def _loopback_ip(host):
    try:
        return ipaddress.ip_address(host.strip("[]")).is_loopback
    except ValueError:
        return False


class LocalRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        require_local_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def open_local(request, timeout=10):
    require_local_url(request.full_url)
    # Machine proxy settings are ignored: a loopback webhook must never go through an external proxy.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), LocalRedirect())
    return opener.open(request, timeout=timeout)
