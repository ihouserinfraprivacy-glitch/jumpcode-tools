<!-- Copyright (c) Microsoft Corporation. All rights reserved. -->
<!-- Licensed under the MIT License. See LICENSE in the project root. -->

# ArchStudio contract

ArchStudio is a self-contained JumpCode tool. It has three parts that only meet
through the files and messages described here:

1. **Python package** `jumpcode_archstudio` (`src/jumpcode_archstudio/`): the
   analyzer and the actions the model calls. It writes JSON files into the
   Studio folder and never writes anywhere else.
2. **Studio interface** (`src/jumpcode_archstudio/ui/app.js` and `app.css`):
   plain JavaScript and CSS, no libraries, no network. JumpCode loads them into
   a sandboxed webview beside the chat and feeds it the Studio files.
3. **JumpCode host** (outside this folder): generic Studio hosting. It knows
   nothing about architecture; it only moves files and messages.

## Folders the tool may touch

The model-facing `run(arguments, context)` receives a context built by the host,
never by prompts or tool arguments:

- `context["studio_root"]`: absolute path of this Studio's own folder. All
  output files live here.
- `context["source_root"]` (optional): absolute path of the folder to analyze
  (the conversation's project folder, or a folder the user picked in the
  Studio). The analyzer only reads inside it, never follows links out of it and
  never executes anything. Without it, `scan` fails with a clear message and the
  model can still describe a system by hand.

## Studio files (all UTF-8 JSON, written atomically)

The per-file limit is **48,000,000 UTF-8 bytes**, enforced before writing and
while reading, and the host snapshot limit is **104,000,000 bytes**. The host
delivers valid large files intact. If it cannot deliver a complete snapshot it
sends `filesError` and retains the last snapshot; it never silently omits a file.

`model.json` is the last committed map. Analysis writes its live previews to
`model-partial.json` and only replaces `model.json` after analysis and merging
succeed. Cancellation or a process exit cannot promote a partial map. Under the
Studio process lock, the next action removes abandoned previews and reports the
interrupted analysis. Progress and partials include `executionId`, supplied only
by the host as `context["execution_id"]`: the same identity as the catalog's
durable usage receipt. The interface only shows a partial when its execution and
source match the scanning progress and the host reports that execution as live
for this tool and an active request in this conversation. Otherwise it shows the
committed map, including for legacy snapshots without a receipt. A busy agent
alone cannot reactivate an abandoned preview. The identity is observation
metadata, not a permission, and adds no polling. Standalone calls may omit it.

Maps include `sourceId`, a SHA-256 of the normalized real source path (case-folded
on Windows). It identifies an origin, not a permission grant. Source paths still
come exclusively from the host and all read/write permissions remain unchanged.
Manually created maps without a source can be bound on their first scan. Previously
scanned maps without this identity, or maps with a different identity, are never
merged. One previous map is retained locally in `.archstudio-previous-model`,
excluded from webview delivery. `view.json`, `paths.json` and `proposal.json` carry
the map's `sourceId`; actions and UI ignore documents from a different origin.

| File | Written by | Purpose |
| --- | --- | --- |
| `model.json` | `scan`, `write_part`, `write_link`, `remove` | The architecture. |
| `progress.json` | `scan` | Live progress while scanning. |
| `view.json` | `focus` | What the interface should select and highlight. |
| `paths.json` | `write_path`, `remove_path` | Step-by-step flows (sequence and presentation). |
| `proposal.json` | `write_proposal`, `clear_proposal` | A proposed change shown over the current map. |

### `model.json`

```json
{
  "version": 1,
  "name": "Rota Certa",
  "source": "rota-certa",
  "scannedAt": "2026-11-13T09:30:00Z",
  "stats": { "systems": 6, "services": 19, "files": 1248, "links": 27, "lines": 98000 },
  "nodes": [ ... ],
  "links": [ ... ],
  "deploy": null
}
```

`source` is only the folder's display name; absolute paths never go to the UI.

**Node** (`id` is unique and stable across rescans of the same tree):

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | `s:<path>` system, `v:<path>` service, `f:<path>` file, `d:<name>` data store, `q:<name>` queue/broker, `x:<name>` external service. |
| `level` | `"system" \| "service" \| "file" \| "data" \| "queue" \| "external"` | |
| `parent` | string or null | system for a service, service for a file; null otherwise. |
| `name` | string | Display name. |
| `kind` | `"backend" \| "web" \| "mobile" \| "embedded" \| "desktop" \| "library" \| "data" \| "queue" \| "external" \| "file"` | Drives color and icon. |
| `tech` | string, optional | e.g. `"Go"`, `"Flutter"`, `"Next.js"`, `"C · ESP32"`, `"PostgreSQL"`. |
| `path` | string, optional | POSIX path relative to the source root (systems, services, files). |
| `files`, `lines` | integers, optional | Size; services and systems sum their files. |
| `lang` | string, optional | Files only: `go`, `ts`, `js`, `py`, `dart`, `kt`, `java`, `swift`, `c`, `cpp`, `h`, `rs`, `cs`, `sql`, `yaml`, `json`, ... |
| `folder` | string, optional | Files only: folder relative to the service path (`""` at its root). |
| `role` | string, optional | Services/modules: `screen`, `state`, `repository`, `source` (mobile/web clients); `task`, `module`, `driver`, `hardware` (embedded); `service` otherwise. The interface groups nodes in bands by role when a scope has roles. |
| `summary` | string, optional | One short sentence written by the model (Portuguese). |
| `endpoints` | list, optional | `{ "method": "POST", "path": "/pedidos", "file": "<path>", "line": 41 }`. |
| `publishes`, `consumes` | string lists, optional | Topic or queue names. |
| `manual` | boolean, optional | Created or edited by the model rather than found in code. |

**Link**:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Unique. |
| `from`, `to` | node ids | Direction of the call or of the message. |
| `level` | `"system" \| "service" \| "file"` | The level where the link is drawn. Data/queue/external links take the level of their caller. |
| `protocol` | string | `HTTP`, `gRPC`, `GraphQL`, `WebSocket`, `MQTT`, `AMQP`, `Kafka`, `SQL`, `Redis`, `import`, `include`, ... |
| `label` | string, optional | Short text drawn on the line (`"HTTPS · REST"`, `"pedido.criado"`). |
| `async` | boolean | Messages and events are drawn dashed. |
| `count` | integer | How many places in the code produce it. |
| `evidence` | list, optional | Up to 8 `{ "path": "<file>", "line": 41 }` entries. |

Every service-level link between two systems is also summarized by one
system-level link (same protocol family); every cross-service import or call is
also summarized at service level. The interface never has to infer links.

**`deploy`** (null when no deployment files were found):

```json
{
  "zones": [ { "id": "z:aws", "name": "AWS · sa-east-1", "kind": "cloud", "parent": null } ],
  "units": [ { "id": "u:pedidos", "name": "pedidos", "zone": "z:k8s", "kind": "container", "replicas": 3,
               "image": "rota/pedidos:1.4", "ports": ["8080"], "node": "v:plataforma/servicos/pedidos" } ],
  "links": [ { "from": "u:gateway", "to": "u:pedidos", "label": "HTTP", "async": false } ]
}
```

Zone kinds: `cloud`, `cluster`, `host`, `users`, `devices`, `external`. Unit
kinds: `container`, `function`, `database`, `cache`, `queue`, `device`,
`client`, `external`, `balancer`.

### `progress.json`

```json
{ "status": "scanning", "phase": "links", "steps": [
    { "id": "tree", "label": "Estrutura de pastas", "state": "done", "note": "38 pastas" },
    { "id": "systems", "label": "Sistemas encontrados", "state": "done", "note": "6" },
    { "id": "links", "label": "Ligações entre serviços", "state": "run", "note": "812 de 1.248 arquivos" },
    { "id": "files", "label": "Arquivos de cada serviço", "state": "todo" } ],
  "current": "firmware/rastreador/src/gps_task.c", "done": 812, "total": 1248 }
```

`status` is `scanning`, `done` or `failed` (with `"error"`). While scanning,
`model.json` may be rewritten with the parts already found so the map grows.

### `view.json`

```json
{ "select": "v:plataforma/servicos/pedidos", "highlight": ["l12", "s:rastreador"], "level": "service",
  "scope": "s:plataforma", "mode": "map", "note": "Posição a cada 5 s", "revision": 4 }
```

`mode` is one of the interface modes below; `scope` is the node whose inside is
shown. The interface follows a new `revision` once, then the user is free to
navigate.

### `paths.json`

```json
{ "paths": [ { "id": "criar-pedido", "name": "Criar pedido", "steps": [
    { "from": "s:app-cliente", "to": "v:plataforma/servicos/api-gateway", "label": "POST /pedidos", "async": false,
      "note": "O app envia o pedido.", "evidence": { "path": "...", "line": 12 } } ] } ] }
```

At most 12 paths of at most 24 steps. Steps use node ids of any level.

### `proposal.json`

```json
{ "title": "Cupons de desconto", "summary": "...",
  "nodes": [ { "op": "add", "id": "v:plataforma/servicos/cupons", "level": "service", "parent": "s:plataforma",
               "name": "cupons", "kind": "backend", "tech": "Go", "summary": "valida e aplica descontos" },
             { "op": "change", "id": "v:plataforma/servicos/pedidos", "note": "3 arquivos mudam" } ],
  "links": [ { "op": "add", "from": "v:...pedidos", "to": "v:...cupons", "label": "valida cupom" },
             { "op": "remove", "from": "v:...pedidos", "to": "v:...notificacoes", "label": "chamada direta" } ] }
```

## Messages between the interface and the host

The interface runs inside a webview with no network and a strict Content
Security Policy. It talks to the host with `acquireVsCodeApi().postMessage(...)`
and receives `message` events on `window`.

Host → interface:

| `type` | Fields | Meaning |
| --- | --- | --- |
| `init` | `context` | Sent once after `ready`. |
| `context` | `context` | The context changed (for example after a folder was picked). |
| `files` | `files` (object `name → text`), `revision` | Current contents of the Studio JSON files. A missing name means the file does not exist. Sent after `ready` and after every change. |
| `filesError` | `message` | Friendly update failure; keep the last map until a successful `files` snapshot. |
| `running` | `running` (boolean), `executions` (string array) | Agent activity plus the active usage receipt IDs for this Studio tool, filtered to active requests in this conversation. Replayed on `ready`; updated when receipts or requests change. |
| `file` | `requestId`, `path`, `text` or `error`, `truncated` | Reply to `readFile`. |

`context` is `{ "tool": "archstudio", "project": true, "source": "rota-certa", "sourceKind": "project" | "folder" | null, "sourceRevision": 1 }`.
`sourceRevision` changes when the selected URI changes, even between identically
named folders, without disclosing the path. It invalidates source-code previews;
new maps also invalidate them, but progress-only updates do not. Replies from
older requests are ignored using their existing `requestId`.

Interface → host:

| `type` | Fields | Meaning |
| --- | --- | --- |
| `ready` | | The interface is listening. |
| `ask` | `text`, `send` | Put `text` in the chat composer; send it when `send` is true and the chat is idle. |
| `pickSource` | | Ask the host to let the user choose a folder to analyze. |
| `readFile` | `requestId`, `path` | Read a source file (POSIX path relative to the source root, up to 512 KB). |
| `openFile` | `path`, `line` (optional) | Open the file in the JumpCode editor. |
| `save` | `name`, `content`, `mime` | Let the user save an export (SVG or JSON). |
| `focus` | `on` (boolean) | Hide (`true`) or show the chat column, for the presentation mode. |

## Interface modes

All modes read the same files. The toolbar switches between them:

| Mode | What it shows |
| --- | --- |
| `map` | Boxes and links of the current scope (systems → services → files). A node can open in place (its children drawn inside it) or be entered (double click), with a breadcrumb back. Scopes whose nodes have roles are laid out in role bands (mobile: screens → state → repositories → sources; embedded: tasks → modules → drivers → hardware). A side panel shows details of the selected node; at file level a bottom panel shows the file's code. |
| `columns` | Three columns (systems, services, files) plus the links of the selected item. |
| `circles` | Nested circles sized by lines of code. |
| `blocks` | Nested squarified blocks sized by lines of code. |
| `layers` | The three levels as stacked isometric plates. |
| `path` | Sequence diagram of one path from `paths.json`, step by step. |
| `present` | The map with one path narrated step by step, chat hidden. |
| `deploy` | Zones and units from `model.deploy`. |
| `matrix` | Dependency matrix of the current scope with cycle detection. |

`proposal.json`, when present, adds an "Atual / Proposta" switch to `map`.
