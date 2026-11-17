# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""The app document: one HTML file with the styles, every screen, the generated tab bar and the example data. The
exported index.html adds the runtime; the Studio preview adds the planned parts as skeletons instead."""

from html import escape
from importlib.resources import files
import json

FONTS = {
    "system": 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    "serif": 'Georgia, "Times New Roman", serif',
    "rounded": '"SF Pro Rounded", "Nunito", system-ui, -apple-system, "Segoe UI", sans-serif',
    "mono": 'ui-monospace, "SF Mono", Consolas, monospace',
}

BASE_CSS = """*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0;height:100%}
body{font-family:var(--fonte);background:var(--cor-fundo);color:var(--cor-texto);-webkit-font-smoothing:antialiased;-webkit-tap-highlight-color:transparent;line-height:1.4}
[hidden]{display:none!important}
img,svg,video{max-width:100%}
button,input,select,textarea{font:inherit;color:inherit}
.as-app{position:relative;min-height:100%}
.as-tela{min-height:100vh;padding-top:var(--as-topo,env(safe-area-inset-top,0px));padding-bottom:calc(var(--as-baixo,env(safe-area-inset-bottom,0px)) + var(--as-abas,0px));overflow-x:hidden}
.as-tem-abas .as-tela[data-kind="tab"]{--as-abas:64px}
.as-tela.as-modal-aberta{position:fixed;left:0;right:0;bottom:0;top:calc(var(--as-topo,env(safe-area-inset-top,0px)) + 12px);min-height:0;overflow:auto;z-index:30;background:var(--cor-fundo);border-radius:18px 18px 0 0;padding-top:8px;box-shadow:0 -6px 24px rgba(0,0,0,.18)}
.as-app.as-com-modal::after{content:"";position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:25}
.as-abas{position:fixed;left:0;right:0;bottom:0;z-index:20;display:flex;background:var(--cor-superficie);border-top:1px solid rgba(0,0,0,.08);padding-bottom:var(--as-baixo,env(safe-area-inset-bottom,0px))}
.as-aba{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;min-height:56px;padding:9px 0 7px;border:0;background:none;color:var(--cor-texto-suave);font-size:11px;cursor:pointer}
.as-aba svg{width:22px;height:22px}
.as-aba.as-ativa{color:var(--cor-primaria);font-weight:600}"""
PREVIEW_CSS = ".as-planejada{margin:12px 16px;min-height:76px;border-radius:12px;background:#E6E3DD}"

ICONS = {
    "inicio": '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h5v-6h4v6h5V10"/>',
    "lista": '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
    "agenda": '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    "perfil": '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>',
    "busca": '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
    "favoritos": '<path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10z"/>',
    "carrinho": '<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l2.5 12h12l2-8H6"/>',
    "sino": '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
    "ajustes": '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
    "mapa": '<path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/>',
    "chat": '<path d="M4 5h16v11H9l-5 4z"/>',
    "estrela": '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
    "tesoura": '<circle cx="6" cy="7" r="3"/><circle cx="6" cy="17" r="3"/><path d="M8.5 8.5L20 19M8.5 15.5L20 5"/>',
    "mais": '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
    "pedidos": '<path d="M5 8h14l-1 13H6z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
    "camera": '<path d="M3 8h4l2-3h6l2 3h4v12H3z"/><circle cx="12" cy="13" r="4"/>',
    "casa": '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>',
    "grafico": '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
}
ICON_ALIASES = {"home": "inicio", "list": "lista", "calendar": "agenda", "user": "perfil", "profile": "perfil", "search": "busca",
                "heart": "favoritos", "cart": "carrinho", "bell": "sino", "settings": "ajustes", "map": "mapa", "star": "estrela",
                "scissors": "tesoura", "plus": "mais", "bag": "pedidos", "orders": "pedidos", "chart": "grafico", "messages": "chat"}

DEFAULT_THEME = {"primary": "#24563F", "accent": "#D9643A", "background": "#F7F5F0", "surface": "#FFFFFF", "text": "#1C1C1C",
                 "muted": "#6B6B6B", "font": "system", "radius": 14, "icon": ""}


def icon_name(value):
    key = str(value or "").strip().lower()
    key = ICON_ALIASES.get(key, key)
    return key if key in ICONS else "inicio"


def icon_svg(name, size=22):
    return (f'<svg viewBox="0 0 24 24" width="{size}" height="{size}" fill="none" stroke="currentColor" stroke-width="1.8" '
            f'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{ICONS[icon_name(name)]}</svg>')


def theme_css(theme):
    theme = {**DEFAULT_THEME, **(theme or {})}
    font = FONTS.get(str(theme["font"]).lower(), str(theme["font"]))
    return (":root{" + f"--cor-primaria:{theme['primary']};--cor-destaque:{theme['accent']};--cor-fundo:{theme['background']};"
            f"--cor-superficie:{theme['surface']};--cor-texto:{theme['text']};--cor-texto-suave:{theme['muted']};"
            f"--raio:{int(theme['radius'])}px;--fonte:{font}" + "}")


def ordered_parts(screen):
    parts = {part["id"]: part for part in screen.get("parts", [])}
    order = [pid for pid in screen.get("plan", []) if pid in parts]
    order += [part["id"] for part in screen.get("parts", []) if part["id"] not in order]
    return [parts[pid] for pid in order]


def runtime_js():
    return files(__package__).joinpath("ui").joinpath("runtime.js").read_text(encoding="utf-8")


def document(app, preview=False, published=False):
    """The app as one HTML document. preview: planned parts as skeletons, no script. Otherwise the exported index.html
    with the runtime (and, once published, the manifest and the offline worker)."""
    name = escape(app.get("name") or "App")
    head = [f'<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
            f"<title>{name}</title>", f'<meta name="theme-color" content="{escape((app.get("theme") or {}).get("primary") or DEFAULT_THEME["primary"])}">']
    if published and not preview:
        head.append('<link rel="manifest" href="manifest.webmanifest"><link rel="icon" href="icone.svg">')
    head.append(f"<style>{BASE_CSS}{PREVIEW_CSS if preview else ''}</style><style>{theme_css(app.get('theme'))}</style>")
    for block in app.get("styles", []):
        head.append(f'<style data-styles="{escape(block["name"])}">{block["css"]}</style>')
    tabs = app.get("tabs") or []
    body = [f'<div class="as-app{" as-tem-abas" if tabs else ""}" data-start="{escape(app.get("start") or "")}">']
    for screen in app.get("screens", []):
        attrs = (f'class="as-tela" data-screen="{screen["id"]}" data-kind="{screen.get("kind", "stack")}" '
                 f'data-route="{escape(screen.get("route") or "/" + screen["id"])}" data-title="{escape(screen.get("title") or screen["id"])}"')
        if screen.get("login"):
            attrs += ' data-login="sim"'
        body.append(f"<section {attrs} hidden>")
        written = {part["id"] for part in screen.get("parts", [])}
        for part in ordered_parts(screen):
            body.append(f'<div class="as-parte" data-part="{part["id"]}">{part["html"]}</div>')
        if preview:
            for pid in screen.get("plan", []):
                if pid not in written:
                    body.append(f'<div class="as-parte as-planejada" data-part="{pid}" data-planned="{escape(pid.replace("-", " "))}"></div>')
        body.append("</section>")
    if tabs:
        body.append('<nav class="as-abas" hidden>' + "".join(
            f'<button class="as-aba" type="button" data-tab="{tab["screen"]}">{icon_svg(tab.get("icon"))}<span>{escape(tab.get("label") or tab["screen"])}</span></button>'
            for tab in tabs) + "</nav>")
    body.append("</div>")
    data = json.dumps(app.get("data") or {}, ensure_ascii=False).replace("</", "<\\/")
    body.append(f'<script type="application/json" id="as-dados">{data}</script>')
    if not preview:
        script = runtime_js().replace("</script", "<\\/script")
        start = "AppRuntime.start(document,{hash:true});"
        if published:
            start += "if('serviceWorker' in navigator&&location.protocol!=='file:'){navigator.serviceWorker.register('sw.js').catch(function(){});}"
        body.append(f"<script>{script}\n{start}</script>")
    return f'<!doctype html><html lang="pt-BR"><head>{"".join(head)}</head><body data-estado="normal">{"".join(body)}</body></html>'


def icon_file(app):
    theme = {**DEFAULT_THEME, **(app.get("theme") or {})}
    letters = escape((theme.get("icon") or "".join(word[0] for word in str(app.get("name") or "App").split()[:2])).upper()[:3])
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="{theme["primary"]}"/>'
            f'<text x="256" y="300" text-anchor="middle" font-family="Georgia, serif" font-size="{200 if len(letters) < 3 else 150}" '
            f'font-weight="700" fill="{theme["surface"]}">{letters}</text></svg>')


def manifest(app):
    theme = {**DEFAULT_THEME, **(app.get("theme") or {})}
    return json.dumps({"name": app.get("name") or "App", "short_name": (app.get("name") or "App")[:12], "start_url": "./index.html",
                       "scope": "./", "display": "standalone", "orientation": "any", "background_color": theme["background"],
                       "theme_color": theme["primary"], "lang": "pt-BR",
                       "icons": [{"src": "icone.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any maskable"}]},
                      ensure_ascii=False, indent=1)


def service_worker(app):
    version = int(app.get("revision") or 1)
    return f"""// Made by AppStudio: keeps the app working offline. A new version replaces the old cache.
const CACHE = 'app-v{version}';
const FILES = ['./', './index.html', './manifest.webmanifest', './icone.svg'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => event.respondWith(caches.match(event.request).then(hit => hit || fetch(event.request))));
"""
