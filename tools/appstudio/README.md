<!-- Copyright (c) Microsoft Corporation. All rights reserved. -->
<!-- Licensed under the MIT License. See LICENSE in the project root. -->

# AppStudio

AppStudio is a JumpCode tool for making phone and tablet apps in the chat. The
user asks ("faça um app para a barbearia com agenda de horários"); the agent
writes the app screen by screen and part by part, and the Studio beside the
chat shows it being built inside an iPhone, an Android phone, an iPhone or
Android foldable (open or closed) or a tablet, with or without the device
frame, standing or lying down.

## How an app is made

The app is HTML and CSS, like the WebStudio's sites, organised as screens of
parts. Navigation is declared in the HTML (`data-go`, `data-back`,
`data-close`, `data-tab`, `#/route` links), lists repeat over example data
(`data-each`) and each screen can show other states (`data-state`: carregando,
vazio, erro, sem-internet). `ui/runtime.js` gives that HTML its behaviour; the
same file runs in the Studio preview and inside the exported app, so the
preview is exactly the app.

The app lives in the project (default folder `app`, or `app-mobile` when `app`
is used by something else): `appstudio.json` is the source of truth,
`index.html` is the whole app in one file (it opens in any browser) and
`.appstudio/versoes/` keeps the last 60 versions. Nothing is downloaded and
nothing leaves the computer.

## What the agent can do

`start`, `screen` (id, title, tab/stack/modal, route, needs login, the planned
parts), `tabs`, `write_part`, `write_styles`, `data`, `theme`, `read`,
`remove`, `check` (screens without a way out, screens nobody reaches, links to
missing screens, empty screens, contrast, images without a description,
buttons without a name), `versions` and `restore`, `show` (what the Studio
shows) and `publish` (installable app files: manifest, icon and offline
worker; with `capacitor`, the files to build the Android and iPhone apps with
Capacitor, plus `PUBLICAR.md`). Unsafe HTML is refused: scripts, `on…`
attributes, `javascript:` URLs, frames and anything loaded from the internet.

## Studio

`ui/app.js` and `ui/app.css` are the interface: the device preview (each
device is an iframe of its real screen size, so the app's media queries work),
the screens strip and grid, the map of routes, the structure, the test mode,
the screen states, problems, versions, publishing and settings. Every button
that changes something becomes a chat request to the agent.

## Not yet

Building the APK or the iPhone app (Capacitor, Android Studio and Xcode run
outside JumpCode), opening the preview on a real phone over the network, and
the app's own JavaScript in the preview.

## Tests

`python -m unittest discover -s tests` from this folder, and the interface's
regressions with `node ui-dev/regressions.mjs`.
