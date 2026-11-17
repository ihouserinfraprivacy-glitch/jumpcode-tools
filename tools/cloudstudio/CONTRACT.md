<!-- Copyright (c) Microsoft Corporation. All rights reserved. -->
<!-- Licensed under the MIT License. See LICENSE in the project root. -->

# CloudStudio contract

CloudStudio is a self-contained JumpCode tool that runs a local AWS cloud on the
user's computer and shows it in a Studio beside the chat. It has four parts that
only meet through the files and messages described here:

1. **Python package** `jumpcode_cloudstudio` (`src/jumpcode_cloudstudio/`): the
   actions the model calls (`actions.py`), argument checks (`arguments.py`) and
   the process manager (`process.py`).
2. **Engine** (`src/jumpcode_cloudstudio/engine/`): the local cloud, a separate
   process started with `python -m jumpcode_cloudstudio.engine`. Standard
   library only; no Docker.
3. **Studio interface** (`src/jumpcode_cloudstudio/ui/app.js` and `app.css`):
   plain JavaScript and CSS, no libraries, no network.
4. **JumpCode host** (outside this folder): generic Studio hosting. It knows
   nothing about clouds; it only moves Studio files and chat messages.

The interface never writes files and never reaches the cloud. Every action the
user takes in it becomes a chat message (`ask`) that the model carries out with
an action.

## Folders the tool may touch

`run(arguments, context, cancelled=None)` receives a context built by the host:

- `context["studio_root"]`: this Studio's folder. The Studio files, the engine's
  data (`data/`) and the copies (`data/snapshots/`) live here.
- `context["source_root"]` (optional): the conversation's project folder. Read
  for function code (`create` with `folder`, always inside the project) and for
  the `.env`, `.env.local`, `.env.development` and `.env.development.local`
  files (`create` of a secret with `fromEnv`). Written only by `env`, which
  merges `AWS_ENDPOINT_URL`, `AWS_REGION`, `AWS_DEFAULT_REGION`,
  `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` into `.env.local` and keeps
  every other line.

The manifest declares `access: {suppliedText: true, projectFiles: true,
network: false}`, so every call goes through the host's tool permission.

## The engine process

`start` runs `sys.executable -m jumpcode_cloudstudio.engine --studio <root>
--port <port> --storage memory|persistent --region <region>` with the parent's
`sys.path` as `PYTHONPATH`. The first stdin line is a random control token; the
pipe stays open and the engine stops when it reaches end of file (the agent's
process ended). The engine binds `127.0.0.1` only, first free port from 4566 to
4599, and answers `{"ready": true, "port": …, "readyMs": …}` on stdout.

- AWS requests: any path. The service comes from `X-Amz-Target`, the SigV4
  credential scope, the query protocol's `Version`, `/_api/<apiId>/…` (HTTP API
  invocation) or, failing everything, S3 (path-style or `bucket.localhost`).
  Signatures are not checked. A 12-digit access key selects that account; any
  other key is account `000000000000`. The region comes from the credential
  scope.
- Control requests: `/_cloudstudio/<action>` with header `X-CloudStudio-Token`.
  Only the package uses them (`status`, `calls`, `logs`, `create`, `remove`,
  `invoke`, `send`, `request`, `run-schedule`, `run-machine`, `snapshot`,
  `restore`, `forget`, `reset`, `shutdown`). `/_cloudstudio/health` needs no token.
- Lambda code downloads use the account and region in the URL returned by
  `GetFunction`. Legacy URLs with just a name work only if that name is unique
  across namespaces. Like the local SDK routes, code downloads require no
  control token and remain subject to the local Host/origin boundary.

`memory` storage keeps the state in memory; object bodies and function zips are
content-addressed blobs under `data/blobs/` (removed when nothing refers to them).
`persistent` storage also writes `data/state.json` (debounced) and loads it on
start. Copies are `data/snapshots/<id>.json` and work in both modes.

Restoration validates the snapshot envelope and state before changing anything.
In persistent mode the replacement is committed to disk before it becomes the
current in-memory state, serialized with background saves. An invalid copy or
failed write returns an error and preserves the current state. Background file
updates retain pending work after a failure and retry with a delay, logging once
per affected destination until recovery; no new user operation is required.

Unreadable/invalid persisted state or snapshots stop loading or blob collection
before deleting any body. Browser origins and Host headers must be local. SNS
HTTP delivery and API HTTP forwarding validate every destination and redirect;
external endpoints and system proxies are not allowed. Local SDK credentials
remain emulator credentials, not a production authentication boundary.

Long synchronous control calls register an authenticated operation identifier.
The host cancellation callback cancels only that operation: Lambda kills its
child process tree and Step Functions stops state transitions/waits. Completed
side effects are preserved; independently queued work and requests already
accepted by another local server are not rolled back. The engine remains alive.
Lambda execution is not an OS sandbox and still requires host authorization.

Functions run as local processes: `python` (`py -3` on Windows) or `node` from
`PATH`, or the interpreter in the settings, with `engine/runners/python_runner.py`
or `node_runner.cjs`. The environment drops the parent's `AWS_*`, `PYTHON*`,
`NODE_*` and `JUMPCODE_*` variables and adds the function's variables,
`AWS_ENDPOINT_URL`, `AWS_REGION`, test keys, `AWS_SESSION_TOKEN=cloudstudio:fn:<name>`
(how calls made by a function are attributed to it), the Lambda variables and
`TZ=UTC`. Timeouts kill the process tree.

## Studio files (UTF-8 JSON, written atomically)

| File | Written by | Purpose |
| --- | --- | --- |
| `cloud.json` | engine | `status` (`running`, `stopped`), `endpoint`, `port`, `startedAt`, `readyMs`, `storage`, `region`, `places` (account and region pairs in use), `calls`, `errors`, `services`, `runtimes` (`python`, `node` versions or null), `snapshots`. |
| `resources.json` | engine | `resources`: one entry per resource with `service`, `kind`, `name`, `arn`, `account`, `region`, `created` and the service's own fields (objects with small text and image previews, the last 200 items as plain JSON, messages, invocations, executions with their steps). Never secret values. |
| `calls.json` | engine | `calls`: the last 400 calls (`id`, `at`, `ms`, `service`, `op`, `target`, `status`, `account`, `region`, `source`, `client`, `req`, `res`, `error`), `total`, `errors`. `source` is `app`, `agent`, `fn:<name>`, `sqs:<queue>`, `sns:<topic>`, `api:<name>`, `schedule:<name>`, `rule:<name>`, `sfn:<machine>`, `s3:<bucket>` or `lambda:<name>`. Request and response notes are cut at 1,600 characters, with secret values replaced by `••••••`. |
| `logs.json` | engine | `logs`: the last 1,000 lines (`at`, `group`, `stream`, `level` = `info`, `error` or `system`, `text`, `request`). |
| `settings.json` | `start` | `storage`, `region` and optional `python`/`node` interpreters for the next start. |
| `view.json` | `create`, `invoke`, `run`, `calls`, `snapshot`, `focus` | `{schema, revision, view, select, note}`. The interface follows a new `revision` once. |

The engine rewrites at most about three times a second. When it stops it writes
`status: "stopped"`; in memory mode `resources.json` is emptied. A tool call that
finds no engine for its Studio rewrites a `cloud.json` left as running.

## Actions

`run({"action": …}, context)` returns a JSON-able dict with `ok`, a short
English `message` for the model and the data it needs. Errors raise
`CloudStudioError` with a message that says what to do instead. `create`,
`invoke`, `send`, `request`, `run`, `env` and `restore` start the cloud with the
saved settings when it is off.

Resource actions (`create`, `remove`, `invoke`, `send`, `request`, `run`, `calls`,
`logs`, `focus`) also accept `account` (12 digits) and `region`. Defaults are
account `000000000000` and the engine region. Studio selection/draft keys are
JSON arrays `[kind, account, region, name]`, with an empty region for global
resources. Legacy `kind:name` selections resolve only when unambiguous.
Logs now include account and region. DynamoDB item roots remain attribute maps;
nested `M` values are encoded as `{"$map": {...}}`, so user keys cannot collide
with the `$n`, `$b` and `$set` value markers. Numbers stay lossless text.

IANA zones use Python's `zoneinfo` when available; unavailable zones fail
explicitly instead of running in UTC. The existing fixed-offset zone fallback
remains available; no timezone database is downloaded by the tool.

| Action | Arguments | Effect |
| --- | --- | --- |
| `status` | | Running or not; endpoint, region, storage, one line per resource and the last failed calls. |
| `start` | `storage`, `region` | Starts the engine (restarts it when storage or region change) and saves the settings. |
| `stop` | | Stops the engine. |
| `create` | `service`, `name` and, by service: table `key`, `keyType`, `sort`, `sortType`, `indexes`, `ttl`, `items`; queue `dlq`, `maxReceives`, `fifo`, `visibility`; topic `subscribe`; function `folder`, `handler`, `runtime` (`python`, `node` or exact), `env`, `timeout`, `queue`, `batch`, `deadLetter`; api `routes`, `cors`; secret `fromEnv` (never a value); parameter `value`, `secure`; schedule `expression`, `timezone`, `target`, `input`; rule `pattern`, `expression`, `targets`, `bus`; statemachine `definition` | Creates the resource through the services' own operations (recorded as calls from `agent`). A function created again is updated. Targets are `function:<name>`, `queue:<name>`, `topic:<name>`, `machine:<name>`, `bus:<name>` or an ARN. |
| `remove` | `service`, `name` | Deletes the resource (a bucket with its objects). |
| `invoke` | `name`, `event` | Runs the function and returns its result, time and last log lines. |
| `request` | `api`, `method`, `path`, `body` | Calls a route of an HTTP API like the app would. |
| `send` | `queue`, `topic` or `bus`, `message` | Sends a message, publishes, or puts an event. |
| `run` | `name`, `input` | Runs a state machine and waits for its end. |
| `calls` | `errors`, `service`, `name`, `limit` | The recent calls (only failed ones with `errors`). |
| `logs` | `name`, `limit` | Log lines, of one function with `name`. |
| `env` | | Merges the endpoint and test keys into the project's `.env.local`. |
| `snapshot` | `name` | Saves a copy of the whole state. |
| `restore` | `name` | Replaces the state with a copy. |
| `reset` | | Removes every resource and the call history; copies stay. |
| `focus` | `view`, `select`, `note` | Writes `view.json`. |

## Messages between the interface and the host

Host → interface: `init`, `context`, `files`, `filesError`, `running` and
`request`, as in the generic Studio host. Interface → host: `ready` and `ask`
(with `send: true` and a `requestId` for actions that run now, `send: false` to
fill the composer). All texts are Portuguese and name resources exactly, for
example `Invoque a função agendar do CloudStudio com o evento {"id":"AG-1"}`.

## Interface

Toolbar with **Visão geral**, **Recursos**, **Mapa**, **Chamadas**, **Logs** and a
**Mais** menu (**Cópias**, **Catálogo de serviços**, **Configurações**), the
endpoint and region, and **Ligar**/**Parar**.

- **First open**: what the tool does, where to keep the data, the region and
  **Ligar a nuvem local**; while the agent starts it, "Ligando a nuvem local".
- **Visão geral**: one box per service in use, recent calls, **Conectar o seu
  código** (the variables, **Copiar**, **Criar .env.local**) and the session.
- **Recursos**: tree by service and the resource: objects with preview, items
  with a typed form and JSON, a function's configuration, callers, executions
  and **Invocar**; an API's routes and **Enviar**; a queue's messages (and the
  note when it is a dead-letter queue); a topic's subscriptions; a state
  machine's states marked by the selected execution; schedules, rules, secrets
  (size only), parameters (SecureString hidden) and log groups.
- **Mapa**: entry points, processing, messaging and data in columns; lines from
  the configuration and from observed calls, blue while a call is happening.
- **Chamadas**: filters (all, errors, from the app, from functions, from the
  agent), the call with request, response, error and a plain explanation of
  common AWS errors, and **Pedir ao agente para corrigir**.
- **Logs**: live lines by function or group.
- **Cópias**: create, return to a copy (confirmed), empty the cloud (confirmed).

The look follows the approved "dark classic" style: neutral grey panels with
square corners, colour only in small icons, solid 3 px left marks (green, blue,
rose, red) and small solid badges.
