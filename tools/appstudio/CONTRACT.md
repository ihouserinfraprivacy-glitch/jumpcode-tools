<!-- Copyright (c) Microsoft Corporation. All rights reserved. -->
<!-- Licensed under the MIT License. See LICENSE in the project root. -->

# AppStudio contract

AppStudio is a self-contained JumpCode tool for making phone and tablet apps in
the chat. The agent writes the app screen by screen, part by part, in HTML and
CSS; the Studio beside the chat shows it live inside a phone, a foldable or a
tablet, with or without the device frame, together with the screens, the map
of routes, a test mode, the screen states, problems, versions and publishing.
It has four parts that only meet through the files and messages described here:

1. **Python package** `jumpcode_appstudio` (`src/jumpcode_appstudio/`): the
   actions the model calls (`actions.py`), argument checks (`arguments.py`),
   the app model and its rendering (`model.py`, `render.py`), the checks
   (`checks.py`) and the Studio files (`views.py`). Standard library only.
2. **Runtime** `ui/runtime.js`: the app's behaviour (navigation, tabs, modals,
   screen states, example data). The same file is inlined into the exported
   app and runs in the Studio preview on the preview frame's document.
3. **Studio interface** `ui/app.js` and `ui/app.css`. `studio_ui()` returns
   `js = runtime.js + "\n" + app.js`. No network.
4. **JumpCode host** (outside this folder): generic Studio hosting.

The interface never writes files and never reaches the tool. Every action that
changes something becomes a chat message (`ask`) the model carries out. Pure
viewing (device, frame, fold, rotation, zoom, which screen, test mode, screen
state) is local to the interface.

## Where the app lives

`context["source_root"]` is the project. The app lives in one folder of it
(default `app`, or `app-mobile` when `app` exists and is not an AppStudio app):

- `appstudio.json`: the source of truth (below).
- `index.html`: the whole app in one file, rewritten after every change: the
  styles, every screen, the generated tab bar, the example data and the
  runtime. It opens in any browser, also from the file system.
- `.appstudio/versoes/<n>.json`: the last 60 versions of `appstudio.json`.
- On `publish`: `manifest.webmanifest`, `icone.svg`, `sw.js` (installable,
  works offline) and, when asked, `capacitor.config.json`, `package.json` and
  `PUBLICAR.md` to build the Android and iPhone apps with Capacitor.

`context["studio_root"]` holds the Studio files only.

## `appstudio.json`

```json
{"format": 1, "revision": 12, "name": "Barbearia do Zé", "id": "barbearia-do-ze", "start": "inicio",
 "theme": {"primary": "#24563F", "accent": "#D9643A", "background": "#F7F5F0", "surface": "#FFFFFF",
           "text": "#1C1C1C", "muted": "#6B6B6B", "font": "system", "radius": 14, "icon": "BZ"},
 "tabs": [{"screen": "inicio", "label": "Início", "icon": "inicio"}],
 "screens": [{"id": "inicio", "title": "Início", "route": "/", "kind": "tab | stack | modal", "login": false,
              "plan": ["cabecalho", "proximo-horario", "servicos"],
              "parts": [{"id": "cabecalho", "html": "<header>…</header>", "updated": 1763140000.0}]}],
 "styles": [{"name": "base", "css": "…"}],
 "data": {"servicos": [{"nome": "Corte", "preco": "R$ 45"}]},
 "updated": 1763140000.0}
```

Screen and part ids: lowercase letters, digits and hyphens. A screen's parts
show in `plan` order, then the parts not in the plan in creation order.

## The app document (`render.py`)

```html
<!doctype html><html lang="pt-BR"><head>… <style>runtime base</style><style>:root{--cor-primaria:…}</style>
<style>/* styles blocks in order */</style></head>
<body data-estado="normal"><div class="as-app" data-start="inicio">
  <section class="as-tela" data-screen="inicio" data-kind="tab" data-route="/" data-title="Início" hidden>
    <div class="as-parte" data-part="cabecalho">…</div>
    <div class="as-parte as-planejada" data-part="servicos" data-planned="Serviços"></div>   (preview only)
  </section>
  <nav class="as-abas" hidden><button class="as-aba" data-tab="inicio"><svg>…</svg><span>Início</span></button></nav>
</div><script type="application/json" id="as-dados">{…}</script>
<script>/* runtime.js */ AppRuntime.start(document, {hash: true});</script>   (exported index.html only)
</body></html>
```

CSS variables from the theme: `--cor-primaria`, `--cor-destaque`, `--cor-fundo`,
`--cor-superficie`, `--cor-texto`, `--cor-texto-suave`, `--raio`, `--fonte`.
Safe areas: the runtime base pads `.as-tela` with `var(--as-topo,
env(safe-area-inset-top))` and the tab bar with `var(--as-baixo,
env(safe-area-inset-bottom))`; the Studio sets `--as-topo` and `--as-baixo` on
the preview document for each device (it draws the status bar and the home
indicator itself).

App HTML rules (enforced when writing): no `<script>`, `<iframe>`, `<object>`,
`<embed>`, `<link>`, `<meta>`, `<base>`, no `on…` attributes, no `javascript:`
URLs, no external `http(s)` images, fonts or styles (images are inline SVG or
`data:`), no CSS `@import` or remote `url()`. Navigation is declarative: see
the header of `runtime.js`.

## Studio files

### `app.json`

```json
{"revision": 12, "name": "Barbearia do Zé", "folder": "app", "start": "inicio", "theme": {…}, "tabs": […],
 "screens": [{"id": "inicio", "title": "Início", "route": "/", "kind": "tab", "login": false,
              "parts": [{"id": "cabecalho", "bytes": 812}], "planned": ["servicos"],
              "states": ["normal", "vazio"]}],
 "styles": [{"name": "base", "bytes": 2048}],
 "data": {"servicos": [{"nome": "Corte"}]},
 "preview": "<!doctype html>…",
 "routes": {"edges": [{"from": "inicio", "to": "horario", "label": "Agendar horário", "how": "go | tab | back | close | link"}],
            "deadEnds": ["confirmado"], "unreachable": [], "missing": [{"from": "perfil", "to": "ajuda"}],
            "links": [{"route": "/agendar", "screen": "horario"}]},
 "files": [{"path": "app/index.html", "bytes": 48211}]}
```

Edges with `how` `back` or `close` have `to: null` (the screen has a way back).
Switching between tab screens through the tab bar is not an edge: the map shows
the tabs as a group; a part's own `data-tab` link is an edge with `how: "tab"`.
`links` lists every screen's route (a direct link opens the app on it).

`preview` is the app document for the Studio: like `index.html` but without
the runtime script and with the planned parts as `.as-planejada` blocks. The
interface puts it into a same-origin `iframe srcdoc` sized to the device
screen, so CSS media queries see the device width, and calls
`AppRuntime.start(iframe.contentDocument, {...})` from its own script.

### `state.json`

```json
{"version": 1, "updated": 1763140000.0,
 "view": "preview | screens | map | structure | test | states | problems | versions | publish | settings",
 "focus": {"screen": "inicio", "part": null, "state": "normal",
           "device": "iphone | android | iphone-fold | android-fold | tablet", "frame": true, "fold": "open | closed",
           "landscape": false},
 "building": {"screen": "inicio", "part": "proximo-horario", "at": 1763140000.0, "action": "write"},
 "problems": [{"id": "dead-end-confirmado", "kind": "dead-end | unreachable | missing-link | contrast | image-alt |
               button-label | empty-screen", "screen": "confirmado", "part": null, "text": "…", "fix": "…"}],
 "versions": [{"n": 12, "at": 1763140000.0, "summary": "Início: parte proximo-horario", "screens": 6}],
 "published": {"at": 1763140000.0, "files": ["app/manifest.webmanifest"], "capacitor": false},
 "notice": {"kind": "info | warning", "text": "…", "at": 1763140000.0},
 "settings": {"folder": "app", "devices": ["iphone", "android"], "frame": true}}
```

`building` is the last part written; the interface outlines it in the preview
for a few seconds and shows skeleton blocks for the planned parts. `problems`
are the tool's checks; the interface may add its own measured ones (touch
targets under 44 px, text overflowing at the device width) without sending
them anywhere.

## Messages

The interface uses the host's generic messages (`ready`, `ask`, `stop`,
`focus`; it receives `init`, `files`, `running`, `request`, `context`,
`filesError`). Requests are pt-BR chat text, for example "Crie a tela Perfil
com os dados da pessoa e um botão Sair.", "Na tela Início, aumente o botão
Agendar horário.", "Volte o app para a versão 9.", "Publique o app como PWA."
