<!-- Copyright (c) Microsoft Corporation. All rights reserved. -->
<!-- Licensed under the MIT License. See LICENSE in the project root. -->

# TaskStudio contract

TaskStudio is a self-contained JumpCode tool that turns a user request into a
plan of linked tasks, shows the plan while the agent carries it out, and lets
the user change any task, which recalibrates the rest of the plan. It has three
parts that only meet through the files and messages described here:

1. **Python package** `jumpcode_taskstudio` (`src/jumpcode_taskstudio/`): the
   actions the model calls. It keeps the plan in JSON files in the Studio folder
   and never reads or writes anywhere else. It does not do the work of a task;
   the agent does that with its other tools and reports each step here.
2. **Studio interface** (`src/jumpcode_taskstudio/ui/app.js` and `app.css`):
   plain JavaScript and CSS, no libraries, no network. JumpCode loads them into a
   sandboxed webview beside the chat and feeds it the Studio files.
3. **JumpCode host** (outside this folder): generic Studio hosting. It knows
   nothing about tasks; it only moves files and messages.

The interface never writes files. Every change the user makes (start, edit,
approve, apply a recalibration) becomes a chat message (`ask`), and the model
records it with an action. The only direct effect the interface has on the agent
is `stop`, the same as the chat's stop button.

## Folders the tool may touch

`run(arguments, context)` receives a context built by the host, never by prompts
or tool arguments:

- `context["studio_root"]`: absolute path of this Studio's own folder. All files
  below live here.
- `context["source_root"]` (optional): the conversation's project folder. The
  package never reads it; it only reports whether the plan can be carried out
  (`project: true`) in `read` results.
- `context["execution_id"]` (optional): host-issued identity of this call,
  stored in the task log for traceability. Never a permission.
- `context["request_id"]` (optional): host-issued request identity, persisted
  by `start`, `progress` and `edit` and matched against the IDE's active requests.

An `ask` with `send: true` may include a client `requestId` used only for
correlation. The host replies with `request` messages carrying the same id and
the accepted submission's state: `queued`, `running`, `settled`, `unconfirmed`
or `rejected` (not admitted). It reuses the normal queue and journal; this is
not a new dispatch or approval channel. Final Studio files are refreshed before
reporting settlement. Recalibration waits for its own attempt, never a global
busy/idle transition or an execution timeout. An unconfirmed result is shown
for inspection in chat without resending. Persisted recalibration uses its
host `requestId`; legacy records without identity cannot borrow other activity.

A TaskStudio opened inside a project can plan and carry out the work, because the
agent there has the project's file and terminal tools. A TaskStudio opened from
the Home screen has no project: it can still plan, and the interface says that
to carry the plan out the user should open TaskStudio from a project.

## Studio files (all UTF-8 JSON, written atomically)

`state.json` is the authoritative snapshot: `{schema:1, revision, documents}`.
`documents` maps the four names below to their JSON values. A temporary file,
fsync and one `os.replace` under `.taskstudio.lock` commit the entire snapshot.
An apply either updates plan/history and removes the proposal together, or
leaves all of them unchanged. Each document retains its own revision and
2,000,000-byte limit; the snapshot limit is 8,100,000 bytes. Legacy separate
files are read only until the first successful snapshot write, then ignored.
An invalid snapshot cannot fall back to stale legacy files.

| File | Written by | Purpose |
| --- | --- | --- |
| `plan.json` | every action except `focus` and `read` | The current plan and the state of each task. |
| `proposal.json` | `propose`; removed by `apply` and `discard` | A recalibration waiting for the user. |
| `history.json` | `plan` (version 1), `apply` | Every plan version with what changed and why. |
| `view.json` | `focus` | What the interface should show and select. |

## Host approval and effects

`run` accepts a host callback `approve(details)`. Initial `start` (or `finish`
before a start), `apply` and `resolve` require it to return exactly `True`.
Details contain the concrete plan, proposal, arguments and their fingerprint.
The lock is released during user interaction; the snapshot is compared again
under the lock before writing. Missing/denied/stale approvals change nothing.
The callback is never supplied by model arguments. The registry and agent
adapter use the existing explicit `tool` approval channel.

`check_effect(context)` blocks other effectful tools while an initial plan or
recalibration awaits approval. Reads and the TaskStudio actions needed to
review/apply/discard remain available. File and command permissions are still
required independently. No prompt keywords determine these boundaries.

An explicit `[]` replaces lists with an empty list. Omitted lists remain
unchanged when updating. No dependency is invented for independent tasks.
`finish(criteria=[...])` must cover every criterion and contain no unknown one;
omitting criteria is the agent's explicit assertion that all were met.
Gate approvals are retained only for unchanged label, kind, environment name,
location and alternatives.

Limits: 60 tasks per plan, 12 dependencies and 6 conditions per task, 20 criteria
per task, 40 log lines per task (oldest dropped), 30 versions in history (oldest
dropped, version numbers keep growing). Text fields are trimmed and cut (ending
in "…") to: plan title 80, request 2000, task title 60, summary 90, detail 1200,
criterion 160, area 40, phase 60, note and log line 200, result 600, problem 120
and its detail 600, option and alternative 80, gate label 80, where 300, env 64,
the user's words (`text`) 600, proposal summary 300, change note 300, why 40,
file path 240. Null and empty text mean "not given"; an explicit empty list is a replacement.

A missing or empty file counts as absent. A damaged `plan.json` makes the
actions fail with a clear message (`plan` may replace it); a file written with a
newer `schema` is never overwritten. A damaged `proposal.json`, `history.json`
or `view.json` counts as absent (`apply` refuses a damaged proposal and
`discard` removes it).

### `plan.json`

```json
{
  "schema": 1,
  "revision": 37,
  "plan": 1,
  "title": "Barbearia do Zé",
  "request": "Crie um sistema de agendamento para a minha barbearia: ...",
  "draft": false,
  "started": true,
  "createdAt": "2026-11-13T14:20:00Z",
  "updatedAt": "2026-11-13T14:36:10Z",
  "tasks": [ ... ],
  "recalibrating": null,
  "nextId": 12
}
```

`draft` is true while the model is still writing the plan (the interface shows
"rascunho"). `started` turns true on the first `start` (before that the
interface offers **Começar**). `nextId` is the number the next new task gets:
numbers are never reused, and it restarts at 1 only when `plan` creates a plan or
replaces one that has not started.

**Task**:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | `"1"`, `"2"`, ... assigned by the package in plan order and never reused; shown as `#id`. |
| `title` | string | Up to 60 characters. |
| `summary` | string | One line on the card, up to 90 characters. |
| `detail` | string | "O que é": what the task does, up to 1200 characters. |
| `criteria` | list | "Para estar pronta": `{ "text": "...", "done": false }`. |
| `deps` | id list | Tasks that must be done (or skipped) first. Never a cycle. |
| `gates` | list | Conditions that need the user (below). |
| `area` | string, optional | Lane in the lanes and metro views (`"Banco"`, `"Site"`, `"Integrações"`). |
| `phase` | string, optional | Group for large plans (`"Fase 2 · Várias unidades"`). |
| `estimate` | integer, optional | Minutes the model expects the task to take. |
| `state` | `"todo" \| "running" \| "paused" \| "done" \| "failed" \| "skipped"` | Stored state. Display states are derived (below). |
| `progress` | integer 0-100, optional | Set by `progress`; 100 on `finish`. |
| `now` | string, optional | What the agent is doing right now (`"Calendario.tsx"`). |
| `startedAt`, `finishedAt`, `pausedAt` | ISO 8601 UTC, optional | |
| `result` | string, optional | What was delivered, set by `finish`. |
| `problem` | object or null | `{ "title": "...", "detail": "...", "options": ["..."], "at": "..." }`, set by `fail`. |
| `log` | list | `{ "at": "...", "text": "criou BarbeiroPicker.tsx", "kind": "info" \| "ok" \| "error" }`, plus `execution` (the host's `execution_id`) when given. |
| `files` | list, optional | Project files the task touched (POSIX, relative), up to 40, with `"state": "done" \| "partial"`. |
| `mark` | object, optional | Last recalibration that touched this task: `{ "plan": 2, "kind": "refazer" \| "ajustar" \| "alterar" \| "nova", "note": "..." }`. |

**Gate** (a condition to start that needs the user):

```json
{ "id": "g1", "kind": "secret", "label": "Chave Pix de teste (sandbox)", "met": false,
  "where": "No painel do banco ou do gateway, em Integrações › Pix › Credenciais de teste.",
  "env": "PIX_KEY", "alternatives": ["Deixar o Pix para depois", "Usar um pagamento simulado"] }
```

`kind` is `secret` (a key or token the user puts in the project, never in the
chat), `approval` (the user must say yes), `choice` (the user must pick an
option) or `other`. `env` is only the variable name; values never pass through
TaskStudio. The interface draws the gate on the task's incoming line (or above
the card when it has no dependency) as a grey label with a rose lock.

**Display state** (the interface derives it, in this order):

1. `done` → **Concluída** (green check).
2. `failed` → **Problema** (red), with `problem`.
3. `skipped` → **Para depois** (grey).
4. `paused` → **Pausada** (rose).
5. `running` → **Executando** (blue, with `progress` and `now`) while the host
   reports the agent running; **Pausada** when the agent is idle (the user
   stopped it or the turn ended mid-task).
6. `todo` with a dependency not done or skipped → **Aguardando** ("espera #6",
   or "espera 4 tarefas").
7. `todo` with an unmet gate → **Precisa de você** (rose).
8. `todo` otherwise → **Pronta**.

While `recalibrating` is set, every task in its impact lists shows **Analisando**
with a dashed border, and the rest are dimmed.

### `recalibrating`

Set by `edit`, cleared by `propose`, `apply` and `discard`:

```json
{ "task": "3", "kind": "done", "text": "Na verdade, cada agendamento pode ter mais de um serviço",
  "before": { "title": "Modelar o banco", "summary": "...", "detail": "..." },
  "after": { "detail": "..." },
  "at": "2026-11-13T14:40:00Z",
  "paused": ["6", "9"],
  "impact": { "done": ["5"], "running": ["6", "9"], "todo": ["7", "8", "10", "11"] } }
```

`kind` is the display group of the edited task when it was edited (`done`,
`running` or `todo`). `paused` lists the tasks `edit` paused so nothing is built
on a plan that may change. `impact` is every task that depends, directly or not,
on the edited one, grouped by state: the candidates the model checks. The
interface shows the recalibration dialog from this object (steps: understand the
change; check done tasks; check running tasks; adjust the remaining tasks; build
the list of changes; the last one spins while the agent works).

`edit` also writes a **baseline** `proposal.json` (`"baseline": true`) that only
redoes the edited task with the user's words as its note, so the user always gets
a list to apply or discard even when the model never calls `propose` (small local
models often stop or start changing files instead). `propose` replaces it with the
model's full list and clears `recalibrating`. The interface shows the
recalibration dialog while `recalibrating` is set and the agent is running; once
the agent stops it shows the proposal, and while it is still the baseline it says
that the agent has not checked the other tasks yet.

### `proposal.json`

```json
{
  "schema": 1, "revision": 3,
  "plan": 2, "base": 1, "baseRevision": 37, "states": { "3": "done", "5": "done", "6": "paused" },
  "cause": { "task": "3", "text": "Na verdade, cada agendamento pode ter mais de um serviço" },
  "summary": "A mudança atinge 7 tarefas: 2 concluídas serão refeitas, 2 em execução ajustadas e 3 mudam antes de começar.",
  "extra": 14,
  "changes": [
    { "task": "3", "kind": "refazer", "note": "Nova tabela agendamento_servicos; a coluna servico_id sai de agendamentos.",
      "why": "sua mudança", "summary": "Vários serviços por agendamento" },
    { "task": "5", "kind": "refazer", "note": "A duração do horário passa a ser a soma dos serviços escolhidos.", "why": "usa #3" },
    { "task": "6", "kind": "ajustar", "note": "Permitir escolher mais de um serviço.", "why": "pausada" },
    { "task": "12", "kind": "nova", "title": "Combos de serviços", "summary": "...", "deps": ["3"], "note": "..." },
    { "task": "8", "kind": "remover", "note": "O lembrete sai deste plano." }
  ],
  "createdAt": "2026-11-13T14:41:00Z"
}
```

`kind` is derived by the package from the task's state, never trusted from the
model: `refazer` for a done task, `ajustar` for a running or paused task,
`alterar` for a task not started (or failed or skipped), `nova` for a new task
(its id is assigned by the package), `remover` only for a task not started
(`todo` or `skipped`, never started and with no files). A
change may carry the new `title`, `summary`, `detail`, `deps`, `area`, `phase`,
`criteria` (as `{ "text", "done": false }`), `gates` (as gate objects) and
`estimate`; `note` says what changes and `why` is a short reason
shown at the right ("sua mudança", "usa #3", "pausada"). `extra` is the
estimated extra minutes. `baseRevision` is the `plan.json` revision the proposal
was made from, and `states` (object `id → state`) records the state of every
task in `changes` at that moment; `apply` refuses when one of them changed state
in between.

Every task of the plan that is not in `changes` is "Sem mudança".

### `history.json`

```json
{ "schema": 1, "revision": 2, "versions": [
  { "plan": 1, "at": "...", "reason": "Plano inicial", "cause": null, "changes": [],
    "tasks": [ { "id": "1", "title": "Entender o pedido", "summary": "...", "state": "todo", "deps": [] } ] },
  { "plan": 2, "at": "...", "reason": "Vários serviços por agendamento", "cause": { "task": "3", "text": "..." },
    "changes": [ { "task": "3", "kind": "refazer", "note": "..." } ], "extra": 14,
    "tasks": [ ... ] } ] }
```

`tasks` is a light snapshot of the plan right after the version was made.

### `view.json`

```json
{ "schema": 1, "revision": 4, "select": "6", "mode": "map", "note": "Abri os detalhes à direita" }
```

`mode` is one of the interface modes below. The interface follows a new
`revision` once, then the user is free to navigate.

## Actions

`run({"action": ..., ...}, context)` returns a JSON-able dict with `ok`, a short
English `message` for the model and the data it needs (the outline or the task).
Errors raise `TaskStudioError` with a message that tells the model what to do
instead (for example "#7 cannot start: it waits for #5 (running) and the
condition 'Chave Pix de teste'. Work on #6 or ask the user.").

| Action | Arguments | Effect |
| --- | --- | --- |
| `plan` | `title`, `request`, `tasks` (list of `{title, summary, detail, deps, area, phase, estimate, criteria, gates}`; `deps` are task numbers: tasks are numbered in plan order, so in a new plan they are the 1-based positions in this list), `draft` | Creates the plan (version 1). When a plan exists and has not started it is replaced (numbering and history restart, `proposal.json` is deleted); once started, refuse and point to `edit`/`propose`. `draft: true` keeps the "rascunho" badge so the model may call `plan` again to complete it: while the stored plan is an unstarted draft, `plan` without a title (or with the same title) adds the tasks after the existing ones, whose numbers continue (a task with the title of an existing one updates it); a different title replaces the draft. A task without `summary` gets the first sentence of its `detail`. Only explicitly declared dependencies are used; independent tasks stay independent. |
| `read` | `id` (optional) | Without `id`: title, version, counts and one line per task (`#3 Modelar o banco [done] deps #2`), plus any problem, unmet condition, pending recalibration or proposal and whether a project folder is bound (`project`, `counts`, `outline`, `nextId`, `notes`). With `id`: the whole task, `waitsFor` and `unlocks`. |
| `start` | `id`, `note` | `todo`/`paused`/`failed`/`skipped` → `running`. Refuses while a dependency is not done or skipped, a gate is unmet, a recalibration or proposal is pending (the user applies or discards it first), or there is no project folder. Sets `started`, `startedAt` (first time), clears `draft`, `pausedAt` and `problem`. |
| `progress` | `id`, `note` (→ `now`), `percent`, `log` (one line; `kind` `info`/`ok`/`error`), `files` (relative paths) | Updates `now`, `progress`, appends a log line (`log`, else `note`), merges touched files as `partial`. Only for a running task. |
| `finish` | `id`, `result`, `criteria` (texts or 1-based numbers met; default all), `files` | → `done`, `progress` 100, `finishedAt`; every file of the task becomes `done`. A ready `todo` task may be finished without `start`. Refuses while a recalibration or proposal is pending. Returns the tasks that became ready. |
| `fail` | `id`, `problem`, `detail`, `options` | → `failed` with `problem`; the interface flags the card in red. |
| `need` | `id`, `kind` (default `secret` with `env`, else `other`), `label`, `where`, `env`, `alternatives` | Adds an unmet gate (the task needs the user); a gate with the same label is updated. A running, paused or failed task goes back to `todo`. |
| `resolve` | `id`, `gate` (gate id or label; default all), `note` | Marks gates met. On a failed task with no gate given, clears the problem (back to `todo`). |
| `skip` | `id`, `note` | → `skipped` ("Para depois"); dependents treat it as satisfied. |
| `pause` | `id` (optional, default all running) | `running` → `paused`, `pausedAt`. |
| `edit` | `id`, `text` (the user's words), and the new `title`, `summary`, `detail`, `criteria` | Records the change as `recalibrating` (does not change the task yet), pauses running tasks, writes the baseline proposal and returns the impact lists. Without `detail`, the user's words become the new detail when they are a full description (at least 60% of the old text's length), or are added to it as "Mudança: …" when they are a short remark. Refuses while a change to another task is still being recalibrated, or a proposal other than the baseline of this change is pending (editing the same task again replaces it). |
| `propose` | `summary`, `changes` (list of `{task, note, why, title, summary, detail, deps, area, phase, criteria, gates, estimate, remove}`; `task` omitted for a new task), `extra` | Validates (ids exist, no cycle, no removal of done work, limits), derives each `kind`, writes `proposal.json`, clears `recalibrating`. The edited task is always included (with the fields given to `edit`). New tasks take the next free numbers from `nextId` in list order (a `task` number at or above `nextId` that is not used yet is kept), so `deps` may name them, also from another new task of the same proposal. `summary` and `extra` are computed when omitted. Without a pending recalibration it proposes changes on its own (`cause.task` null), for example to add tasks to a started plan; a new `propose` replaces a pending proposal. |
| `apply` | | Applies the proposal: the plan version grows; `refazer`/`ajustar`/`alterar` tasks take their new fields, `refazer` and `ajustar` go back to `todo` (keeping `files` and `log`; `progress`, `now`, `result`, the times and the criteria checks reset), `alterar` keeps the state, new tasks are added at the end, removed tasks are dropped (and from every `deps`); every changed task gets `mark`. Adds a history version (`reason`: the edited task's new summary, else the user's words), deletes `proposal.json`. Refuses if a task in `changes` changed state since the proposal or the plan is no longer version `base` (asks for a new `propose`). |
| `discard` | | Deletes `proposal.json` and clears `recalibrating`; the plan stays as it was. Paused tasks stay paused until `start`. |
| `focus` | `id`, `mode`, `note` | Writes `view.json` (`select` is null without `id`, `mode` defaults to `map`, `note` to `""`). |

The package also accepts task ids written as `"#6"` or `6`.

## Messages between the interface and the host

The interface runs inside a webview with no network and a strict Content
Security Policy. It talks to the host with `acquireVsCodeApi().postMessage(...)`
and receives `message` events on `window`.

Host → interface:

| `type` | Fields | Meaning |
| --- | --- | --- |
| `init` | `context` | Sent once after `ready`. |
| `context` | `context` | The context changed. |
| `files` | `files` (object `name → text`), `revision` | Current contents of the Studio JSON files. A missing name means the file does not exist. |
| `filesError` | `message` | Friendly update failure; keep the last plan. |
| `running` | `running` (boolean), `executions` (string array), `requests` (active host request IDs) | Conversation activity; a task is visually running only if its stored `requestId` is active. Legacy tasks without an ID appear paused until explicitly resumed. |
| `file` | `requestId`, `path`, `text` or `error`, `truncated` | Reply to `readFile` (unused by TaskStudio). |

`context` is `{ "tool": "taskstudio", "project": true, "source": "barbearia", "sourceKind": "project" | "folder" | null, "sourceRevision": 1 }`.

Interface → host:

| `type` | Fields | Meaning |
| --- | --- | --- |
| `ready` | | The interface is listening. |
| `ask` | `text`, `send` | Put `text` in the chat composer; send it when `send` is true and the chat is idle. |
| `stop` | | Stop the agent's active request in this conversation, exactly like the chat's stop button. Ignored when nothing is running. |
| `openFile` | `path`, `line` (optional) | Open a project file (POSIX path relative to the project) in the JumpCode editor. |
| `save` | `name`, `content` | Let the user save an export (`.json`). |
| `focus` | `on` (boolean) | Hide (`true`) or show the chat column, for the focus mode. |

### What the interface sends

All texts are Portuguese and name tasks as `#id` with their title, so the model
can act without guessing:

| User action | Messages |
| --- | --- |
| **Começar** (plan ready) | `ask("Pode começar.", send)` |
| **Pausar** (toolbar or task) | `stop` |
| **Retomar tudo** / **Retomar sem mudar** | `ask("Retome o plano de onde parou." / "Retome a tarefa #6 Tela de agendamento sem mudar nada.", send)` |
| **Editar tarefa** on a running task | `stop` first, then the edit panel opens. |
| **Recalibrar** / **Recalibrar e retomar** (edit panel) | `ask("Mudei a tarefa #3 Modelar o banco. Agora: «<new text>». Recalibre o plano.", send)` |
| **Aplicar mudanças** / **Descartar** (proposal) | `ask("Aplique as mudanças do plano v2.", send)` / `ask("Descarte a proposta do plano v2 e mantenha o plano v1.", send)` |
| **Já resolvi** / **Aprovar** / **Deixar para depois** (gate) | `ask("Já coloquei Chave Pix de teste no projeto para a tarefa #7.", send)` / `ask("Aprovo: Publicar o site (#11).", send)` / `ask("Deixe a tarefa #7 Pagamento por Pix para depois.", send)` |
| **Tentar de novo** / an option of a problem | `ask("Tente a tarefa #8 de novo.", send)` / `ask("Na tarefa #8: <option>.", send)` |
| **Perguntar sobre esta tarefa** | `ask("Sobre a tarefa #6 Tela de agendamento: ", false)` |

Secrets are never typed into the interface: a `secret` gate shows where to find
the value and the variable name to put in the project's environment file, and
the user tells the agent when it is there.

## Interface modes

All modes read the same files. The toolbar has **Mapa**, **Lista**, **Quadro**,
**Linha do tempo** and a "Mais vistas" menu with the rest.

| Mode | What it shows |
| --- | --- |
| `map` | Task cards laid out by dependency depth (rows) with orthogonal lines; live lines in blue, lines to tasks not yet released dashed. Gate labels on the lines. Selecting a card opens the inspector at the right. Plans with phases and more than 16 tasks show one collapsible group per phase, with progress and a minimap. |
| `list` | One row per task in plan order: number box, title, summary, state, dependencies, time. |
| `board` | Columns by display state: Aguardando, Precisa de você, Executando, Concluída (plus Problema when any). |
| `timeline` | Horizontal time bars: real time for done and running tasks, estimates (hatched) for the rest, a "now" line. |
| `lanes` | Swimlanes by `area`, cards placed by depth. |
| `metro` | One line per `area`, stations are tasks, interchanges where a dependency crosses areas. |
| `focus` | The current running task (or the selected one) full size, chat hidden (`focus` message), with its log, criteria and what it unlocks. |
| `history` | Versions from `history.json`; selecting one shows its changes and a before/after of task titles. |

Overlays and panels, in any mode:

- **Inspector** (right): title, display state with time, "O que é", "Para estar
  pronta" (criteria), "Começou porque" / "Condições para começar"
  (dependencies and gates), "Agora" (log), "Quando terminar, libera"
  (dependents); buttons **Editar tarefa**, **Pausar** / **Retomar**.
- **Edit panel** (right): the text with changes marked like track changes
  (inserted text underlined in green, removed text struck through), "Já feito
  nesta tarefa" (its files), "Prévia do impacto" (dependents computed from the
  graph), buttons by state: done → **Recalibrar** / **Cancelar**; running or
  paused → **Recalibrar e retomar** / **Retomar sem mudar** / **Cancelar**;
  todo → **Salvar e recalibrar** / **Cancelar**. A banner says the execution
  was paused for the edit and nothing done is lost.
- **Gate panel** (right): what is missing, where to find it, the variable name,
  alternatives, **Já resolvi** / **Aprovar** / **Deixar para depois**.
- **Problem panel** (right): the problem, the log, options as buttons,
  **Tentar de novo**.
- **Recalibrating dialog** (center, plan dimmed): from `recalibrating`, with
  "Nada é refeito antes de você ver a lista e aprovar."
- **O que vai mudar** (right, from `proposal.json`): groups Refazer · já
  concluídas, Ajustar · estavam executando, Alterar · ainda não feitas, Nova,
  Remover, Sem mudança; cards marked on the map with a small solid badge; buttons
  **Aplicar mudanças**, **Comparar antes e depois**, **Descartar**.
- **Antes e depois**: two columns, the current plan and the proposed one, with
  changed texts marked like track changes.
- **Plano concluído**: summary of time, tasks, versions and files, with
  **Ver histórico** and **Exportar**.
- **Empty**: what TaskStudio does, three example requests (each fills the
  composer), and when there is no project, how to open TaskStudio from a project
  to carry the plan out. While the agent is running and there is no plan yet:
  "Montando o plano" with placeholder cards.
