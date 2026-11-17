<!-- Copyright (c) Microsoft Corporation. All rights reserved. -->
<!-- Licensed under the MIT License. See LICENSE in the project root. -->

# PayStudio contract

PayStudio is a self-contained JumpCode tool that runs a fake payment gateway on
the user's computer and shows it in a Studio beside the chat. It has four parts
that only meet through the files and messages described here:

1. **Python package** `jumpcode_paystudio` (`src/jumpcode_paystudio/`): the
   actions the model calls (`actions.py`), argument checks (`arguments.py`) and
   the process manager (`process.py`).
2. **Engine** (`src/jumpcode_paystudio/engine/`): the gateway, a separate process
   started with `python -m jumpcode_paystudio.engine`. Standard library only
   (its own BR Code and QR Code encoders).
3. **Studio interface** (`src/jumpcode_paystudio/ui/app.js` and `app.css`):
   plain JavaScript and CSS, no libraries, no network.
4. **JumpCode host** (outside this folder): generic Studio hosting. It knows
   nothing about payments; it only moves Studio files and chat messages.

The interface never writes files and never reaches the gateway. Every action the
user takes in it becomes a chat message (`ask`) that the model carries out with
an action.

## Folders the tool may touch

`run(arguments, context, cancelled=None)` receives a context built by the host:

- `context["studio_root"]`: this Studio's folder. The Studio files and the
  engine's data (`data/`) live here.
- `context["source_root"]` (optional): the conversation's project folder. Written
  only by `env`, which merges the gateway addresses and test keys into
  `.env.local` (`PIX_API_URL`, `PIX_CLIENT_ID`, `PIX_CLIENT_SECRET`, `PIX_CHAVE`,
  `MERCADOPAGO_API_URL`, `MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_PUBLIC_KEY`,
  `MERCADOPAGO_WEBHOOK_SECRET`, `STRIPE_API_URL`, `STRIPE_SECRET_KEY`,
  `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`). Every other line is kept;
  a line PayStudio replaces stays above as `# (antes do PayStudio) …`.

The manifest declares `access: {suppliedText: true, projectFiles: true,
network: false}`, so every call goes through the host's tool permission.

## Test keys

The first start creates `data/secrets.json` in the Studio folder: Stripe
`sk_test_…`, `pk_test_…` and `whsec_…`, Mercado Pago `TEST-…` token, public key
and webhook secret, Pix client id, client secret and key. They only work against
this gateway. They reach the engine through its stdin, the project only through
`env`, and never a tool result, a Studio file or the chat. The host feeds only
top-level `*.json` files to the interface, so `data/` is never shown.

## The engine process

`start` runs `sys.executable -m jumpcode_paystudio.engine --studio <root>
--port <port> --storage memory|persistent --spawned <time>` with the parent's
`sys.path` as `PYTHONPATH`. The first stdin line is a random control token and
the second the settings (`webhooks`, `secrets`, `merchant`, `city`) as JSON; the
pipe stays open and the engine stops when it reaches end of file (the agent's
process ended). The engine binds `127.0.0.1` only, first free port from 4570 to
4599, and answers `{"ready": true, "port": …, "readyMs": …}` on stdout. Errors go
to `data/engine.log`.

- Gateway requests: `/pix/…`, `/v2/…` and `/oauth/…` are the API Pix;
  `/mercadopago/…` is Mercado Pago; `/stripe/…` is Stripe. `/v1/…` is Stripe
  when the credential is `sk_`/`rk_` or Basic, otherwise Mercado Pago. Stripe
  `sk_live_` keys and Mercado Pago `APP_USR-` tokens are refused and flagged.
- Browser origins and `Host` headers must be local; CORS answers only local
  origins.
- Control requests: `/_paystudio/<action>` with header `X-PayStudio-Token`.
  Only the package uses them (`status`, `charges`, `charge`, `pay`, `expire`,
  `refund`, `dispute`, `scenario`, `rule`, `failure`, `clear`, `webhook`,
  `resend`, `check`, `calls`, `webhooks`, `reset`, `shutdown`).
  `/_paystudio/health` needs no token.
- Webhooks go only to local addresses (no proxy, local-only redirects).

`memory` storage keeps the state in memory and empties `charges.json` when the
engine stops. `persistent` storage also writes `data/state.json` and loads it on
start. Unreadable, invalid or unsupported state prevents startup and is preserved;
it never silently becomes an empty state. Scheduled payments, Pix refunds and
Stripe disputes are stored as typed operations with their due times, alongside
the payment data. Old pending Pix refunds are recovered when loading older state.

Control cancellation is authenticated and scoped to one operation. The signature
check stops waiting when cancelled and does not queue its next probe. An HTTP
request already received by the local application cannot be undone; unrelated
payments and the gateway keep running. Completed effects are preserved.

Idempotent creation serializes lookup, mutation and receipt under the gateway's
state lock. Stripe error receipts are replayed too. Pix webhooks registered by
key take precedence over the Studio default; deleting one explicitly disables
that key, including after restart. Other keys retain their own destination.

Webhook retention limits completed history to 300 entries; pending and held
deliveries remain queued and survive persistent restarts regardless of that
limit. An in-flight reservation lasts through recording the result and retry
deadline, so concurrent dispatch cannot send the same attempt twice. Explicit
resends, scenario duplicates and scheduled retries remain available.

The Pix control refund without an amount uses the remaining balance, excluding
both completed and pending refunds. Calculation and reservation are atomic;
an exhausted balance or a nonpositive amount is rejected without another refund.
Stripe and Mercado Pago refund validation, balance mutation and event creation
also share the state lock, for both app API requests and tool control calls.

Reset replaces the state to which webhook workers and signature checks belong.
Queued workers skip work from that previous state; responses to HTTP already
sent cannot add results, retries or forged probes to the new state. Signature
checks interrupted by reset return an inconclusive result promptly and clean up
only their original deliveries. In-flight reservations use delivery identity,
so reused numeric IDs do not block or cancel new deliveries. HTTP already sent
to the application cannot be undone by reset.

## Studio files (UTF-8 JSON, written atomically)

| File | Written by | Purpose |
| --- | --- | --- |
| `pay.json` | engine | `status` (`running`, `stopped`), `endpoint`, `port`, `startedAt`, `readyMs`, `storage`, `currency`, `gateways` (per gateway: `charges`, `webhooks`, `failing`, `url`, `base`), `totals` by status (`count`, `amount` in cents), `charges`, `webhooks`, `calls` (counts), `rules` and `failures` with `text`, `checks`, `attention`, `scheduled`, `presets`, `merchant`. |
| `charges.json` | engine | `charges`: one entry per charge of every gateway (`gateway`, `ref`, `method`, `amount`, `status` = `pendente`, `em_analise`, `paga`, `expirada`, `recusada`, `estornada`, `estorno_parcial`, `cancelada`, `contestada`, `gatewayStatus`, `created`, `expires`, `paid`, `booking`, `customer`, `events`, `flags`, `refunded`, `details`). A Pix waiting for payment also has `qr` (SVG data URL). Card numbers appear only as brand and last four digits. |
| `webhooks.json` | engine | `deliveries`: the last 300 webhooks, newest first (`id`, `gateway`, `event`, `ref`, `booking`, `url`, `created`, `due`, `attempts` with `status`, `ms`, `body`, `error`, `state` = `pending`, `held`, `delivered`, `failed`, `no_url`, `signature`, `copy_of`, `note`, `check`, `payload`). |
| `calls.json` | engine | `calls`: the last 400 calls from the app (`at`, `ms`, `gateway`, `method`, `path`, `op`, `status`, `ref`, `idempotency`, `client`, `flag`, `req`, `res`, `error`), `total`. Card numbers and CVCs are removed. |
| `settings.json` | `start`, `webhook` | `storage`, `gateways`, `webhooks` per gateway, `merchant`, `city`. No secrets. |
| `view.json` | `webhook`, `env`, `charges`, `charge`, `pay`, `scenario`, `rule`, `failure`, `check`, `calls`, `webhooks`, `focus` | `{schema, revision, view, select, note}`. The interface follows a new `revision` once. |

## Actions

`run({"action": …}, context)` returns a JSON-able dict with `ok`, a short
English `message` for the model and the data it needs. Errors raise
`PayStudioError` with a message that says what to do instead. Most actions
start the gateway with the saved settings when it is off; `charges`, `charge`,
`calls`, `webhooks`, `resend`, `check`, `clear` and `reset` need it running.
Fields that exist in the schema but mean nothing for the action are ignored and
named at the end of the message. Common spellings of gateways (`mercado pago`,
`mp`) and scenario names (`webhook duplicado`) are accepted.

| Action | Arguments | Effect |
| --- | --- | --- |
| `status` | | What runs, webhook addresses, totals, what needs attention. |
| `start`, `stop` | `storage` | Turn the gateway on or off. |
| `webhook` | `gateway`, `url` | Where that gateway posts its webhooks (local only; empty turns them off). |
| `env` | | Writes `.env.local` (see above). |
| `charges`, `charge` | `status`, `gateway`, `limit`; `ref` | List charges; one charge with its events and webhooks. |
| `pay` | `ref`, `gateway`, `delay`, `duplicate` | The customer pays the Pix, a pending Mercado Pago payment is approved or 3-D Secure is finished. |
| `expire`, `refund`, `dispute` | `ref`, `gateway`, `amount`, `reason` | The charge expires, is refunded (all or part) or disputed (no chargeback for Pix). |
| `scenario`, `rule`, `failure`, `clear` | `name`; `gateway`, `kind`, `seconds`, `copies`, `reason`, `times`; `mode`, `rate`, `latency`, `calls`; `which` | Change the next charges, webhooks or gateway answers. |
| `check` | `gateway` | Compares the same route and payload with valid and forged signatures. A successful control followed by 400/401/403 confirms rejection in this test; a successful forgery fails it. Other responses are inconclusive (`ok: null`), never proof of validation. |
| `calls`, `webhooks` | `errors`, `limit` | The app's calls and the webhooks, optionally only failures. |
| `resend`, `reset` | `id` | Send a webhook again; empty all charges, webhooks, scenarios and calls. |
| `focus` | `view`, `select`, `note` | Point the Studio at a view or a charge (`gateway:ref`). |

The signature check sends a valid control before the forged copy. This is local
test evidence, not certification of all signature-validation behavior. Without
an accepted control, even a 400/401/403 is inconclusive. HTTP 404, 500 and missing
responses are also inconclusive. The Studio reflects all three outcomes.

Call logging parses JSON and forms before masking sensitive fields, including
authentication failures; malformed/unstructured request bodies are omitted.
Webhook payloads presented in Studio files also mask secrets. Failed Studio-file
writes stay pending for retry, without repeating payment actions. Updating the
project's `.env.local` leaves one active occurrence of each updated key and keeps
replaced values commented out.
