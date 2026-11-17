# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""The actions the model calls: turn the fake gateway on and off, connect the app (.env.local and webhook
addresses), act as the payer, run scenarios and failures, read charges, webhooks and calls, and point the Studio."""

import secrets
import string
import time

from . import process
from .arguments import ignored_fields
from .common import PayStudioError, merge_env_file, read_json, source_root, studio_root, write_json

SETTINGS_FILE = "settings.json"
SECRETS_FILE = ("data", "secrets.json")
VIEW_FILE = "view.json"
PAY_FILE = "pay.json"
GATEWAYS = ("pix", "mercadopago", "stripe")
VIEWS = ("overview", "charges", "webhooks", "scenarios", "timeline", "cards", "calls", "settings", "catalog")
ENV_HEADER = "# Gateway de pagamento de teste do PayStudio (só neste computador, sem dinheiro de verdade)"


def run(arguments, context, cancelled=None):
    if cancelled is not None and cancelled():
        raise PayStudioError("The operation was cancelled.")
    root = studio_root(context)
    ignored = ignored_fields(arguments)
    with process.call_context(cancelled):
        result = ACTIONS[arguments["action"]](root, context, {k: v for k, v in arguments.items() if k not in ignored})
    if ignored:
        result["message"] = f"{result.get('message', '')} (Ignored for {arguments['action']}: {', '.join(ignored)}.)".strip()
    return result


# ---------------------------------------------------------------- settings and test secrets

def settings(root):
    value = read_json(root / SETTINGS_FILE, {}) or {}
    return {"schema": 1, "storage": value.get("storage", "memory"), "gateways": value.get("gateways") or list(GATEWAYS),
            "webhooks": {name: (value.get("webhooks") or {}).get(name, "") for name in GATEWAYS},
            "merchant": value.get("merchant") or "BARBEARIA DO ZE", "city": value.get("city") or "SAO PAULO"}


def _random(length, alphabet=string.ascii_letters + string.digits):
    return "".join(secrets.choice(alphabet) for _ in range(length))


def test_secrets(root):
    """Test credentials made once per Studio; they only work against this fake gateway."""
    path = root.joinpath(*SECRETS_FILE)
    value = read_json(path, None)
    if not isinstance(value, dict) or "stripe_webhook" not in value:
        value = {"stripe_secret_key": "sk_test_ps_" + _random(24), "stripe_publishable_key": "pk_test_ps_" + _random(24),
                 "stripe_webhook": "whsec_" + _random(32), "mercadopago_access_token": "TEST-" + _random(16, string.digits) + "-ps",
                 "mercadopago_public_key": "TEST-" + _random(8, "0123456789abcdef") + "-ps", "mercadopago_webhook": _random(40, "0123456789abcdef"),
                 "pix_client_id": "paystudio-" + _random(8, string.ascii_lowercase), "pix_client_secret": _random(32),
                 "pix_key": f"{_random(8, '0123456789abcdef')}-{_random(4, '0123456789abcdef')}-4{_random(3, '0123456789abcdef')}-a{_random(3, '0123456789abcdef')}-{_random(12, '0123456789abcdef')}"}
        write_json(path, value)
    return value


def _engine_settings(root):
    chosen = settings(root)
    return {"webhooks": chosen["webhooks"], "secrets": test_secrets(root), "merchant": chosen["merchant"], "city": chosen["city"]}


def _engine(root, auto=True):
    engine = process.running(root)
    if engine is None and auto:
        engine, _ = process.start(root, settings(root)["storage"], _engine_settings(root))
    if engine is None:
        raise PayStudioError("The payment gateway is off. Call start first.")
    return engine


def _stale_file(root):
    data = read_json(root / PAY_FILE)
    if isinstance(data, dict) and data.get("status") in ("running", "starting"):
        data["status"] = "stopped"
        data["updatedAt"] = time.time()
        write_json(root / PAY_FILE, data)


def _focus(root, view, select=None, note=""):
    current = read_json(root / VIEW_FILE, {}) or {}
    write_json(root / VIEW_FILE, {"schema": 1, "revision": int(current.get("revision", 0)) + 1, "view": view, "select": select, "note": note})


# ---------------------------------------------------------------- on and off

def status(root, context, arguments):
    engine = process.running(root)
    if engine is None:
        _stale_file(root)
        return {"ok": True, "running": False, "message": "The payment gateway is off. Call start when the user wants to test payments "
                                                         "(the other actions start it too)."}
    value = engine.call("status")
    missing = [name for name in GATEWAYS if not (value["gateways"].get(name) or {}).get("webhook")]
    message = (f"The fake gateway is running at {engine.endpoint}. "
               + (f"No webhook address yet for {', '.join(missing)}; call webhook with the app's local route. " if missing else "")
               + (f"{len(value['attention'])} things need attention." if value["attention"] else "Nothing needs attention."))
    return {"ok": True, **value, "message": message}


def start(root, context, arguments):
    chosen = settings(root)
    if arguments.get("storage"):
        chosen["storage"] = arguments["storage"]
    write_json(root / SETTINGS_FILE, chosen)
    current = process.running(root)
    if current is not None and current.storage != chosen["storage"]:
        process.stop(root)
    engine, started = process.start(root, chosen["storage"], _engine_settings(root))
    hooks = chosen["webhooks"]
    set_hooks = [f"{name} → {hooks[name]}" for name in GATEWAYS if hooks.get(name)]
    missing = [name for name in GATEWAYS if not hooks.get(name)]
    return {"ok": True, "running": True, "endpoint": engine.endpoint, "readyMs": engine.ready_ms, "webhooks": {name: hooks.get(name) or None for name in GATEWAYS},
            "message": f"{'Started' if started else 'Already running'}: fake gateway at {engine.endpoint} (API Pix at /pix, Mercado Pago at "
                       "/mercadopago, Stripe at /stripe and /v1). Only test keys work and no real money moves. "
                       + (f"Webhooks go to: {'; '.join(set_hooks)}. " if set_hooks else "")
                       + (f"No webhook address for {', '.join(missing)}. " if missing else "")
                       + "env writes the addresses and test keys to .env.local when the user asks. Now tell the user in one short sentence."}


def stop(root, context, arguments):
    stopped = process.stop(root)
    if not stopped:
        _stale_file(root)
    return {"ok": True, "running": False, "message": "The payment gateway stopped." if stopped else "The payment gateway was already off."}


# ---------------------------------------------------------------- connecting the app

def webhook(root, context, arguments):
    gateway = arguments.get("gateway")
    url = (arguments.get("url") or "").strip()
    if gateway not in GATEWAYS:
        raise PayStudioError("gateway must be pix, mercadopago or stripe")
    # The Banco Central standard appends /pix to the registered address, so a route that already ends in /pix
    # is registered without it (otherwise the webhook would arrive at .../pix/pix).
    trimmed = gateway == "pix" and url.rstrip("/").endswith("/pix")
    if trimmed:
        url = url.rstrip("/")[:-len("/pix")]
    chosen = settings(root)
    engine = _engine(root)
    engine.call("webhook", {"gateway": gateway, "url": url})
    chosen["webhooks"][gateway] = url
    write_json(root / SETTINGS_FILE, chosen)
    _focus(root, "settings")
    extra = (f"/pix (registered as {url}; Pix posts to the registered address + /pix, as the Banco Central standard says)" if trimmed
             else " (Pix posts to this address + /pix, as the Banco Central standard says)") if gateway == "pix" and url else ""
    return {"ok": True, "gateway": gateway, "url": url,
            "message": f"Webhooks of {gateway} now go to {url}{extra}." if url else f"Webhooks of {gateway} are off."}


def env(root, context, arguments):
    project = source_root(context, required=True)
    engine = _engine(root)
    secret = test_secrets(root)
    base = engine.endpoint
    chosen = settings(root)["gateways"]
    values = {}
    if "pix" in chosen:
        values.update({"PIX_API_URL": f"{base}/pix", "PIX_CLIENT_ID": secret["pix_client_id"], "PIX_CLIENT_SECRET": secret["pix_client_secret"],
                       "PIX_CHAVE": secret["pix_key"]})
    if "mercadopago" in chosen:
        values.update({"MERCADOPAGO_API_URL": f"{base}/mercadopago", "MERCADOPAGO_ACCESS_TOKEN": secret["mercadopago_access_token"],
                       "MERCADOPAGO_PUBLIC_KEY": secret["mercadopago_public_key"], "MERCADOPAGO_WEBHOOK_SECRET": secret["mercadopago_webhook"]})
    if "stripe" in chosen:
        values.update({"STRIPE_API_URL": f"{base}/stripe", "STRIPE_SECRET_KEY": secret["stripe_secret_key"],
                       "STRIPE_PUBLISHABLE_KEY": secret["stripe_publishable_key"], "STRIPE_WEBHOOK_SECRET": secret["stripe_webhook"]})
    replaced = merge_env_file(project / ".env.local", values, ENV_HEADER)
    _focus(root, "settings")
    note = (f" The previous values of {', '.join(replaced)} were kept as commented lines." if replaced else "")
    return {"ok": True, "file": ".env.local", "variables": sorted(values), "replaced": replaced,
            "message": "Wrote .env.local with the fake gateway's addresses and test keys (values are not shown here)." + note
                       + " The app must read *_API_URL as its base URL; with the Stripe SDK use stripe.api_base (Python) or the host/port/protocol "
                         "options (Node). The webhook secrets are the ones PayStudio signs with."}


# ---------------------------------------------------------------- charges and payer actions

def charges(root, context, arguments):
    payload = {key: arguments[key] for key in ("status", "gateway", "limit") if arguments.get(key)}
    result = _engine(root, auto=False).call("charges", payload)
    _focus(root, "charges")
    return {"ok": True, **result, "message": f"{len(result['charges'])} charges."}


def charge(root, context, arguments):
    result = _engine(root, auto=False).call("charge", {"ref": arguments.get("ref"), "gateway": arguments.get("gateway")})
    _focus(root, "charges", f"{result['gateway']}:{result['ref']}")
    return {"ok": True, **result, "message": f"{result['gateway']} charge {result['booking'] or result['ref']} is {result['status']}."}


def pay(root, context, arguments):
    payload = {key: arguments[key] for key in ("ref", "gateway", "delay", "duplicate") if key in arguments}
    result = _engine(root).call("pay", payload)
    _focus(root, "charges")
    extra = (f" The webhook will wait {arguments['delay']} s." if arguments.get("delay") else "") + (" The webhook will arrive twice." if arguments.get("duplicate") else "")
    return {"ok": True, **result, "message": f"Paid as the customer would.{extra} Check with charge or webhooks what the app did."}


def expire(root, context, arguments):
    result = _engine(root).call("expire", {"ref": arguments.get("ref"), "gateway": arguments.get("gateway")})
    return {"ok": True, **result, "message": "The charge expired without payment. Check that the app released the booking."}


def refund(root, context, arguments):
    result = _engine(root).call("refund", {key: arguments[key] for key in ("ref", "gateway", "amount") if key in arguments})
    return {"ok": True, **result, "message": "Refund made; the gateway notifies the app."}


def dispute(root, context, arguments):
    result = _engine(root).call("dispute", {key: arguments[key] for key in ("ref", "gateway", "reason") if key in arguments})
    return {"ok": True, **result, "message": "The cardholder opened a dispute; the gateway notifies the app."}


# ---------------------------------------------------------------- scenarios, failures and checks

def scenario(root, context, arguments):
    result = _engine(root).call("scenario", {"name": arguments.get("name")})
    _focus(root, "scenarios")
    return {"ok": True, **result, "message": f"Scenario ready: {result['scenario']}. It applies to the next charge or webhook; now make the app pay."}


def rule(root, context, arguments):
    params = {key: arguments[key] for key in ("seconds", "copies", "reason") if key in arguments}
    result = _engine(root).call("rule", {"gateway": arguments.get("gateway") or "any", "kind": arguments.get("kind"), "params": params,
                                         "times": arguments.get("times") or 1})
    _focus(root, "scenarios")
    return {"ok": True, **result, "message": "Rule added; it applies to the next charges or webhooks."}


def failure(root, context, arguments):
    payload = {"gateway": arguments.get("gateway") or "any", "mode": arguments.get("mode") or "unavailable"}
    for key, field in (("rate", "rate"), ("latency", "latency_ms"), ("calls", "calls"), ("seconds", "seconds")):
        if key in arguments:
            payload[field] = arguments[key]
    result = _engine(root).call("failure", payload)
    _focus(root, "scenarios")
    return {"ok": True, **result, "message": f"The gateway now fails ({payload['mode']}) on the next calls; see how the app reacts."}


def clear(root, context, arguments):
    _engine(root, auto=False).call("clear", {"which": arguments.get("which") or "all"})
    return {"ok": True, "message": "Scenario rules and failure controls cleared."}


def resend(root, context, arguments):
    result = _engine(root, auto=False).call("resend", {"id": arguments.get("id")})
    return {"ok": True, **result, "message": f"Webhook #{result['copy_of']} sent again as #{result['resent']}."}


def check(root, context, arguments):
    result = _engine(root, auto=False).call("check", {"gateway": arguments.get("gateway") or "stripe"}, timeout=40)
    _focus(root, "webhooks")
    return {"ok": True, **result, "message": result["result"]}


def calls(root, context, arguments):
    result = _engine(root, auto=False).call("calls", {"errors": bool(arguments.get("errors")), "limit": arguments.get("limit") or 15})
    _focus(root, "calls")
    return {"ok": True, **result, "message": f"{len(result['calls'])} calls from the app."}


def webhooks(root, context, arguments):
    result = _engine(root, auto=False).call("webhooks", {"failed": bool(arguments.get("errors")), "limit": arguments.get("limit") or 10})
    _focus(root, "webhooks")
    return {"ok": True, **result, "message": f"{len(result['webhooks'])} webhooks."}


def reset(root, context, arguments):
    _engine(root, auto=False).call("reset")
    return {"ok": True, "message": "All charges, webhooks, scenarios and calls were removed. Settings and test keys were kept."}


def focus(root, context, arguments):
    view = arguments.get("view") or "overview"
    _focus(root, view, arguments.get("select"), arguments.get("note") or "")
    return {"ok": True, "message": f"The Studio shows {arguments.get('select') or view}."}


ACTIONS = {"status": status, "start": start, "stop": stop, "webhook": webhook, "env": env, "charges": charges, "charge": charge, "pay": pay,
           "expire": expire, "refund": refund, "dispute": dispute, "scenario": scenario, "rule": rule, "failure": failure, "clear": clear,
           "resend": resend, "check": check, "calls": calls, "webhooks": webhooks, "reset": reset, "focus": focus}
