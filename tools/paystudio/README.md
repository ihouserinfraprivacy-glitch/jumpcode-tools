<!-- Copyright (c) Microsoft Corporation. All rights reserved. -->
<!-- Licensed under the MIT License. See LICENSE in the project root. -->

# PayStudio

PayStudio is a JumpCode tool that runs a fake payment gateway on the user's
computer and shows it in a Studio beside the chat. It answers like the
**API Pix** of Banco Central (v2), **Mercado Pago** and **Stripe**, so an app
that charges its customers can be tested end to end without an account, real
keys or real money: the app creates the charge, the agent plays the customer
(pays the Pix, finishes 3-D Secure, lets the charge expire, refunds, disputes),
and PayStudio sends the signed webhook to the app's route.

Everything runs on `127.0.0.1`. Nothing goes to the internet; live keys are
refused.

## What it emulates

| Gateway | Base URL | Endpoints |
| --- | --- | --- |
| API Pix (Bacen v2) | `http://127.0.0.1:4570/pix` | `oauth/token`, `v2/cob` (PUT, POST, GET, PATCH, list), `v2/loc/{id}/qrcode`, `v2/pix` and `devolucao`, `v2/webhook/{chave}` |
| Mercado Pago | `http://127.0.0.1:4570/mercadopago` | `v1/card_tokens`, `v1/payments` (create, search, get, update, refunds), `v1/payment_methods` |
| Stripe | `http://127.0.0.1:4570/stripe` (also `/v1`) | `v1/payment_methods`, `v1/payment_intents` (create, list, get, update, confirm, cancel), `v1/refunds` |

The Pix charge carries a valid BR Code (copia e cola with CRC16) and a real QR
Code. Stripe test payment methods and card numbers (`pm_card_visa`,
`4000000000009995`, `pm_card_authenticationRequired`, …) and Mercado Pago test
cardholder names (`APRO`, `FUND`, `CALL`, …) behave as in the gateways' test
modes. Mercado Pago requires `X-Idempotency-Key` on payments; Stripe replays
`Idempotency-Key` and refuses the same key with different parameters.

## Webhooks

Webhooks are signed as the real gateways sign them (`Stripe-Signature` with the
`whsec_` secret; Mercado Pago `x-signature` and `x-request-id`). Pix webhooks go
to the configured address plus `/pix`, without a signature (the mTLS certificate
is not emulated). A failed delivery is retried after 5, 15, 30, 60 and 120
seconds. Webhook addresses must be local.

## Scenarios

Ready scenarios (`pix_pago`, `pix_atrasado_duplicado`, `pix_expira`,
`webhook_duplicado`, `webhook_atrasado`, `webhook_fora_de_ordem`,
`assinatura_errada`, `cartao_recusado`, `sem_saldo`, `gateway_fora_do_ar`,
`gateway_lento`) and single rules (pay after, expire after, decline, pending,
delay, duplicate, out of order, wrong signature) change what happens to the
next charges and webhooks. Failure controls make the gateway answer 503, slowly,
never, 429 or refuse connections. `check` sends a webhook with a wrong signature
and reports whether the app refused it.

## Development

```
python -m unittest discover -s tests      # engine, QR Code and actions
python ui-dev/scenario.py                 # regenerate ui-dev/fixtures/barbearia
node ui-dev/serve.mjs                     # the Studio in a browser with a fake host
```

See [CONTRACT.md](CONTRACT.md) for the files, messages and process rules.
