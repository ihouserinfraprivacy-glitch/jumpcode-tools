# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""What the three emulated gateways share: the unified list of charges and the expiration sweep."""

import time

from . import mercadopago, pix, stripe

MODULES = {"pix": pix, "mercadopago": mercadopago, "stripe": stripe}
LABELS = {"pix": "API Pix", "mercadopago": "Mercado Pago", "stripe": "Stripe"}


def charges(gw):
    with gw.lock:
        result = pix.charges(gw) + mercadopago.charges(gw) + stripe.charges(gw)
    return sorted(result, key=lambda c: c["created"], reverse=True)


def find(gw, ref, gateway=None):
    """A charge by its gateway id, txid, booking (AG-4830) or the end of its id, in the given gateway or any."""
    for name in ([gateway] if gateway else ["pix", "mercadopago", "stripe"]):
        found = MODULES[name].find(gw, str(ref))
        if found is not None:
            return name, found
    return None, None


def expire(gw):
    """Mercado Pago cancels unpaid Pix at expiration and tells the app; the Pix standard only lets the cob lapse."""
    now = time.time()
    for payment in list(gw.state["mercadopago"]["payments"].values()):
        if payment["status"] == "pending" and payment.get("expires") and payment["expires"] < now:
            mercadopago.expire(gw, payment)
    for cob in list(gw.state["pix"]["cobs"].values()):
        if pix.expired(cob, now) and not cob.get("expired_seen"):
            cob["expired_seen"] = True
            gw.event(cob, "venceu sem pagamento · nenhum webhook é enviado no padrão do Banco Central", "warn")
