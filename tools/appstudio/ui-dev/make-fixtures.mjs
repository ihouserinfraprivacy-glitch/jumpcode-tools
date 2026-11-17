/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Dev only: writes the AppStudio fixture scenarios (fixtures/<scenario>/app.json and state.json, see CONTRACT.md) for
// the Studio harness. The app is "Barbearia do Zé" (10 screens, plain HTML/CSS parts, example data with data-each,
// states on Meus horários, a modal, a dead end, an unreachable screen and a missing link). The app document follows
// what the Python side's render.py writes (the base CSS is copied from its real output), so the Studio meets the same
// markup it will get from the tool. A scenario's "_host.json" (not a Studio file) tells the fake host how to behave.
// Run from this folder: node make-fixtures.mjs
import { mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';

const NOW = 1794700000; // 14/11/2026 ~ 18:06 (Brasília); the fake host moves every time so state.updated is now

// ------------------------------------------------------------------ render.py, as the Python side writes it

const BASE_CSS = `*,*::before,*::after{box-sizing:border-box}
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
.as-aba.as-ativa{color:var(--cor-primaria);font-weight:600}.as-planejada{margin:12px 16px;min-height:76px;border-radius:12px;background:#E6E3DD}`;

const TAB_ICONS = {
	inicio: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h5v-6h4v6h5V10"/>',
	tesoura: '<circle cx="6" cy="7" r="3"/><circle cx="6" cy="17" r="3"/><path d="M8.5 8.5L20 19M8.5 15.5L20 5"/>',
	agenda: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
	perfil: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>',
};
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const attr = value => String(value).replace(/[&<>"]/g, c => ESC[c]);

function themeCss(t) {
	const font = t.font === 'system' ? 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif' : t.font;
	return `:root{--cor-primaria:${t.primary};--cor-destaque:${t.accent};--cor-fundo:${t.background};--cor-superficie:${t.surface};--cor-texto:${t.text};--cor-texto-suave:${t.muted};--raio:${t.radius}px;--fonte:${font}}`;
}

/** As render.py: the written parts in plan order, then the others; the planned ones still missing come last. */
function orderedParts(screen) {
	const byId = new Map(screen.parts.map(p => [p.id, p]));
	const out = [];
	for (const id of screen.plan || []) {
		if (byId.has(id)) { out.push(byId.get(id)); byId.delete(id); }
	}
	const planned = (screen.plan || []).filter(id => !screen.parts.some(p => p.id === id)).map(id => ({ id, planned: true }));
	return out.concat([...byId.values()], planned);
}

function renderDoc(model) {
	const sections = model.screens.map(s => {
		const parts = orderedParts(s).map(p => p.planned
			? `<div class="as-parte as-planejada" data-part="${p.id}" data-planned="${attr(p.id.replace(/-/g, ' '))}"></div>`
			: `<div class="as-parte" data-part="${p.id}">${p.html}</div>`).join('');
		return `<section class="as-tela" data-screen="${s.id}" data-kind="${s.kind}" data-route="${attr(s.route)}" data-title="${attr(s.title)}"${s.login ? ' data-login="sim"' : ''} hidden>${parts}</section>`;
	}).join('');
	const nav = model.tabs.length ? `<nav class="as-abas" hidden>${model.tabs.map(t => `<button class="as-aba" type="button" data-tab="${t.screen}"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TAB_ICONS[t.icon] || TAB_ICONS.inicio}</svg><span>${attr(t.label)}</span></button>`).join('')}</nav>` : '';
	const styles = model.styles.map(s => `<style data-styles="${attr(s.name)}">${s.css}</style>`).join('');
	return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>${attr(model.name)}</title><meta name="theme-color" content="${model.theme.primary}"><style>${BASE_CSS}</style><style>${themeCss(model.theme)}</style>${styles}</head><body data-estado="normal"><div class="as-app${model.tabs.length ? ' as-tem-abas' : ''}" data-start="${model.start}">${sections}${nav}</div><script type="application/json" id="as-dados">${JSON.stringify(model.data).replace(/</g, '\\u003c')}</script></body></html>`;
}

/** Routes found in the parts' HTML: data-go, data-tab (explicit links only), data-back, data-close and #/ links. */
function routesOf(model) {
	const ids = new Set(model.screens.map(s => s.id));
	const byRoute = new Map(model.screens.map(s => [s.route, s.id]));
	const edges = [];
	const missing = [];
	for (const s of model.screens) {
		for (const p of s.parts) {
			const re = /<(\w+)\b([^>]*\b(?:data-go|data-tab|data-back|data-close|href)\b[^>]*)>/g;
			let m;
			while ((m = re.exec(p.html))) {
				const attrs = m[2];
				const start = m.index + m[0].length;
				const end = p.html.indexOf(`</${m[1]}>`, start);
				const inner = p.html.slice(start, end < 0 ? start : end);
				const text = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || /aria-label="([^"]+)"/.exec(attrs)?.[1] || '';
				const label = /\{\{/.test(text) ? 'toca num item da lista' : text || 'botão sem texto';
				let to = null, how = null;
				if ((to = /data-go="([^"]+)"/.exec(attrs)?.[1])) { how = 'go'; }
				else if ((to = /data-tab="([^"]+)"/.exec(attrs)?.[1])) { how = 'tab'; }
				else if (/data-back\b/.test(attrs)) { how = 'back'; }
				else if (/data-close\b/.test(attrs)) { how = 'close'; }
				else if ((to = /href="#(\/[^"]*)"/.exec(attrs)?.[1])) { how = 'link'; to = byRoute.get(to) || to; }
				if (!how) { continue; }
				if (to && !ids.has(to)) {
					if (!missing.some(x => x.from === s.id && x.to === to)) { missing.push({ from: s.id, to }); }
					continue;
				}
				if (!edges.some(e => e.from === s.id && e.to === (to || null) && e.how === how && e.label === label)) {
					edges.push({ from: s.id, to: to || null, label, how });
				}
			}
		}
	}
	// Tab screens can always leave through the tab bar; the others need an edge.
	const deadEnds = model.screens.filter(s => s.kind !== 'tab' && !edges.some(e => e.from === s.id)).map(s => s.id);
	const reach = new Set([model.start]);
	if (model.tabs.length) { model.tabs.forEach(t => reach.add(t.screen)); }
	let grew = true;
	while (grew) {
		grew = false;
		for (const e of edges) {
			if (e.to && reach.has(e.from) && !reach.has(e.to)) { reach.add(e.to); grew = true; }
		}
	}
	const unreachable = model.screens.filter(s => !reach.has(s.id)).map(s => s.id);
	const links = model.screens.map(s => ({ route: s.route, screen: s.id })).concat(model.links || []);
	return { edges, deadEnds, unreachable, missing, links };
}

function statesOf(screen) {
	const found = new Set();
	for (const p of screen.parts) {
		for (const m of p.html.matchAll(/data-state="([^"]+)"/g)) {
			m[1].split(/\s+/).forEach(name => { if (name !== 'sempre') { found.add(name); } });
		}
	}
	const order = ['normal', 'carregando', 'vazio', 'erro', 'sem-internet'];
	return ['normal', ...order.filter(n => n !== 'normal' && found.has(n))];
}

function appJson(model, revision) {
	return {
		revision, name: model.name, folder: 'app', start: model.start, theme: model.theme, tabs: model.tabs,
		screens: model.screens.map(s => ({
			id: s.id, title: s.title, route: s.route, kind: s.kind, login: !!s.login,
			parts: s.parts.map(p => ({ id: p.id, bytes: Buffer.byteLength(p.html) })),
			planned: (s.plan || []).filter(id => !s.parts.some(p => p.id === id)),
			states: statesOf(s),
		})),
		styles: model.styles.map(s => ({ name: s.name, bytes: Buffer.byteLength(s.css) })),
		data: model.data,
		preview: renderDoc(model),
		routes: routesOf(model),
		files: [
			{ path: 'app/appstudio.json', bytes: 41230 },
			{ path: 'app/index.html', bytes: Buffer.byteLength(renderDoc(model)) + 10400 },
		],
	};
}

// ------------------------------------------------------------------ the app: Barbearia do Zé

const I = {
	bell: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>',
	pin: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-6-5.6-6-11a6 6 0 0 1 12 0c0 5.4-6 11-6 11z"/><circle cx="12" cy="10" r="2.2"/></svg>',
	plus: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
	star: '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path fill="#D9643A" d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z"/></svg>',
	chevR: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
	chevL: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
	close: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
	clock: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
	check: '<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
	cal: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
	calBig: '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
	alert: '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.4v.1"/></svg>',
	refresh: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M19 8a7.5 7.5 0 1 0 .8 6"/><path d="M19.5 3.5V8H15"/></svg>',
	wifiOff: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M3 3l18 18M8.5 16a5 5 0 0 1 7 0M5 12.5a10 10 0 0 1 5-2.6M14.5 10a10 10 0 0 1 4.5 2.5M2 9a15 15 0 0 1 4.6-2.9M11 5.1A15 15 0 0 1 22 9"/><circle cx="12" cy="19.5" r=".6"/></svg>',
	user: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4.5 20.5c1.2-3.8 4-5.5 7.5-5.5s6.3 1.7 7.5 5.5"/></svg>',
	card: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="M3 10h18M7 15h3"/></svg>',
	help: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.7M12 17v.1"/></svg>',
	exit: '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/><path d="M10 16l-4-4 4-4M6 12h10"/></svg>',
	mail: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="M3.5 7l8.5 6 8.5-6"/></svg>',
	scissors: '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="7" r="3"/><circle cx="6" cy="17" r="3"/><path d="M8.5 8.5L20 19M8.5 15.5L20 5"/></svg>',
	starBig: '<svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true"><path fill="#D9643A" d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z"/></svg>',
	starOff: '<svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true"><path fill="#E2DDD3" d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z"/></svg>',
};
// Service icons as CSS data images (the app's images are inline SVG or data:, never remote).
const svcIcon = path => `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='#D9643A' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'>${path}</svg>`)}")`;

const STYLES = [
	{
		name: 'base', css: `body{background:var(--cor-fundo)}
h1,h2,h3,p{margin:0}
button{border:0;background:none;padding:0;cursor:pointer;text-align:left}
.topo{display:flex;align-items:center;gap:10px;padding:10px 18px 4px}
.saudacao{flex:1;min-width:0}
.saudacao small{display:block;font-size:12.5px;color:var(--cor-texto-suave)}
.saudacao h1{font:700 23px/1.15 Georgia,'Times New Roman',serif;color:var(--cor-primaria);letter-spacing:-.01em}
.icone-botao{width:44px;height:44px;border-radius:50%;background:var(--cor-superficie);display:grid;place-items:center;color:var(--cor-texto);box-shadow:0 1px 2px rgba(0,0,0,.06),0 0 0 1px #ECE8E1}
.avatar{width:44px;height:44px;border-radius:50%;background:var(--cor-destaque);color:#fff;font-weight:700;display:grid;place-items:center;flex:none}
.cartao-proximo{margin:10px 16px 0;padding:16px;border-radius:calc(var(--raio) + 4px);background:var(--cor-primaria);color:#fff}
.rotulo{display:block;font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;color:#BFD6C9;font-weight:600}
.quando{display:block;font-size:19px;margin:4px 0 12px;letter-spacing:-.01em}
.com-barbeiro{display:flex;align-items:center;gap:10px}
.com-barbeiro b{display:block;font-size:14px}
.com-barbeiro small{display:block;font-size:12px;color:#D3E3DA}
.mini-avatar{width:32px;height:32px;border-radius:50%;background:#fff;color:var(--cor-primaria);display:grid;place-items:center;font-weight:700;font-size:13px;flex:none}
.acoes{display:flex;gap:8px;margin-top:14px}
.pequeno{height:36px;padding:0 14px;border-radius:10px;font-size:13px;font-weight:600;display:inline-flex;align-items:center;gap:6px}
.botao-claro{background:#2F6A4F;color:#fff;box-shadow:inset 0 0 0 1px #4D8569}
.botao-branco{background:#fff;color:var(--cor-primaria)}
.botao-principal{display:flex;align-items:center;justify-content:center;gap:8px;width:calc(100% - 32px);min-height:52px;margin:12px 16px 4px;border-radius:var(--raio);background:var(--cor-destaque);color:#fff;font-size:15.5px;font-weight:700;text-align:center}
.botao-principal.verde{background:var(--cor-primaria)}
.botao-contorno{display:flex;align-items:center;justify-content:center;gap:8px;width:calc(100% - 32px);min-height:50px;margin:10px 16px;border-radius:var(--raio);background:var(--cor-superficie);color:var(--cor-texto);font-weight:600;box-shadow:inset 0 0 0 1px #DCD7CD;text-align:center}
.bloco{margin-top:18px}
.bloco-titulo{display:flex;align-items:center;justify-content:space-between;padding:0 6px 0 18px}
.bloco-titulo h2{font-size:16.5px;letter-spacing:-.01em}
.ver-todos{min-height:44px;padding:0 12px;display:inline-flex;align-items:center;color:var(--cor-destaque);font-size:13px;font-weight:600;text-decoration:none}
.svc-icone{width:40px;height:40px;border-radius:12px;background:#FBEDE6 center/22px no-repeat;flex:none}
.svc-icone[data-tipo="corte"]{background-image:${svcIcon('<circle cx="6" cy="7" r="3"/><circle cx="6" cy="17" r="3"/><path d="M8.5 8.5L20 19M8.5 15.5L20 5"/>')}}
.svc-icone[data-tipo="barba"]{background-image:${svcIcon('<path d="M5 9c0 6 3 11 7 11s7-5 7-11"/><path d="M8 13c1.5 1 6.5 1 8 0"/><path d="M5 9V6M19 9V6"/>')}}
.svc-icone[data-tipo="combo"]{background-image:${svcIcon('<path d="M4 20l9-9"/><path d="M13 11l3-7 4 4-7 3z"/><path d="M4 14h5M4 17h3"/>')}}
.svc-icone[data-tipo="sobrancelha"]{background-image:${svcIcon('<path d="M3 13c3-4 7-5 9-5s6 1 9 5"/><circle cx="12" cy="15.5" r="2.5"/>')}}
.svc-icone[data-tipo="pigmentacao"]{background-image:${svcIcon('<path d="M14 4l6 6-9 9H5v-6z"/><path d="M12 6l6 6"/>')}}
.foto{width:46px;height:46px;border-radius:50%;color:#fff;display:grid;place-items:center;font-weight:700;font-size:17px;flex:none}
.secao{font-size:11.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--cor-texto-suave);font-weight:700;margin:20px 18px 8px}
.lista{display:flex;flex-direction:column;gap:10px;padding:0 16px}
.cartao{background:var(--cor-superficie);border-radius:var(--raio);box-shadow:0 0 0 1px #ECE8E1}
.titulo-tela{padding:12px 18px 6px}
.titulo-tela h1{font-size:26px;letter-spacing:-.02em}
.titulo-tela p{margin-top:4px;font-size:13.5px;color:var(--cor-texto-suave);line-height:1.45}
.barra-voltar{display:flex;align-items:center;gap:4px;padding:2px 10px}
.barra-voltar h1{flex:1;text-align:center;font-size:16.5px;margin-right:44px}
.voltar{width:44px;height:44px;border-radius:50%;display:grid;place-items:center;color:var(--cor-texto)}
.passos{display:flex;align-items:center;gap:6px;padding:6px 18px 0}
.passos i{flex:1;height:4px;border-radius:2px;background:#E4DFD6}
.passos i.feito{background:var(--cor-primaria)}
.passos small{flex:none;font-size:11.5px;color:var(--cor-texto-suave);margin-left:4px}
.resumo{display:flex;align-items:center;gap:12px;margin:14px 16px 0;padding:12px 6px 12px 14px;background:var(--cor-superficie);border-radius:var(--raio);box-shadow:0 0 0 1px #ECE8E1}
.resumo > span:nth-child(2){flex:1;min-width:0}
.resumo b{display:block;font-size:14.5px}
.resumo small{display:block;font-size:12.5px;color:var(--cor-texto-suave)}
.link-acao{min-height:44px;padding:0 12px;color:var(--cor-destaque);font-weight:600;font-size:13.5px}
.rodape-fixo{position:sticky;bottom:0;margin-top:16px;padding:8px 0 calc(8px + var(--as-baixo,0px));background:var(--cor-superficie);box-shadow:0 -1px 0 #ECE8E1}
.rodape-fixo .botao-principal{margin-top:4px}
.chave{width:44px;height:26px;border-radius:13px;background:#D7D2C8;position:relative;flex:none}
.chave::after{content:'';position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2)}
.chave.on{background:var(--cor-primaria)}
.chave.on::after{left:21px}`,
	},
	{
		name: 'telas', css: `.grade-servicos{display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:2px 16px 0}
.grade-servicos > :nth-child(n+5){display:none}
.servico-card{display:flex;align-items:center;gap:10px;min-height:64px;padding:10px;background:var(--cor-superficie);border-radius:var(--raio);box-shadow:0 0 0 1px #ECE8E1;min-width:0}
.servico-card > span:last-child{min-width:0}
.servico-card b{display:block;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.servico-card small{display:block;font-size:11.5px;color:var(--cor-texto-suave);white-space:nowrap}
.grade-barbeiros{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;padding:2px 16px 0}
.barbeiro-card{display:flex;flex-direction:column;align-items:center;gap:4px;padding:14px 6px 12px;background:var(--cor-superficie);border-radius:var(--raio);box-shadow:0 0 0 1px #ECE8E1;text-align:center}
.barbeiro-card .foto{margin-bottom:4px}
.barbeiro-card b{font-size:14px}
.barbeiro-card small{display:inline-flex;align-items:center;gap:3px;font-size:12px;color:var(--cor-texto-suave)}
.linha-servico{display:flex;align-items:center;gap:12px;padding:12px 8px 12px 12px;background:var(--cor-superficie);border-radius:var(--raio);box-shadow:0 0 0 1px #ECE8E1;min-height:68px}
.ls-texto{flex:1;min-width:0}
.ls-texto b{display:block;font-size:14.5px}
.ls-texto small{display:block;font-size:12.5px;color:var(--cor-texto-suave);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ls-preco{text-align:right;flex:none}
.ls-preco b{display:block;font-size:14.5px}
.ls-preco small{display:block;font-size:11.5px;color:#A8A39A}
.linha-servico > svg{color:#B5AFA4;flex:none}
.aviso-verde{display:flex;align-items:center;gap:12px;margin:16px 16px 0;padding:14px;border-radius:var(--raio);background:#E5EFE9;color:var(--cor-primaria)}
.aviso-verde b{display:block;font-size:13.5px}
.aviso-verde small{display:block;font-size:12.5px;color:#3F6E58}
.linha-barbeiro{display:flex;align-items:center;gap:12px;padding:12px 14px;background:var(--cor-superficie);border-radius:var(--raio);box-shadow:0 0 0 1px #ECE8E1;width:100%}
.linha-barbeiro.escolhido{box-shadow:0 0 0 2px var(--cor-primaria)}
.lb-texto{flex:1;min-width:0}
.lb-texto b{display:block;font-size:15px}
.lb-texto small{display:block;font-size:12.5px;color:var(--cor-texto-suave)}
.nota{display:inline-flex;align-items:center;gap:3px;font-size:13px;font-weight:600}
.livre .foto{background:#E5EFE9;color:var(--cor-primaria)}
.mes{display:flex;align-items:center;justify-content:space-between;padding:18px 8px 0 18px}
.mes b{font-size:15.5px}
.mes button{width:44px;height:44px;display:inline-grid;place-items:center;color:var(--cor-texto-suave)}
.dias{display:grid;grid-template-columns:repeat(7,1fr);gap:6px;padding:6px 16px 0}
.dia{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;min-height:58px;border-radius:12px;background:var(--cor-superficie);box-shadow:0 0 0 1px #ECE8E1;text-align:center}
.dia small{font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--cor-texto-suave)}
.dia b{font-size:16px}
.dia.escolhido{background:var(--cor-primaria);color:#fff;box-shadow:none}
.dia.escolhido small{color:#C9DDD2}
.dia.fechado{opacity:.45}
.horas{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:0 16px}
.hora{min-height:44px;border-radius:11px;background:var(--cor-superficie);box-shadow:0 0 0 1px #ECE8E1;text-align:center;font-size:14px;font-weight:600}
.hora.ocupado{color:#B9B3A8;text-decoration:line-through;font-weight:400;background:#F1EEE8;box-shadow:none}
.hora.escolhido{background:var(--cor-primaria);color:#fff;box-shadow:none}
.resumo-baixo{display:flex;align-items:center;gap:10px;padding-left:16px;padding-right:16px}
.resumo-baixo > span{flex:1;min-width:0}
.resumo-baixo b{display:block;font-size:14px}
.resumo-baixo small{display:block;font-size:12px;color:var(--cor-texto-suave)}
.resumo-baixo .botao-principal{width:auto;margin:0;padding:0 26px;min-height:48px}
.folha{padding:4px 0 calc(16px + var(--as-baixo,0px))}
.folha-topo{display:flex;align-items:center;padding:0 8px 0 18px}
.folha-topo h1{flex:1;font-size:19px}
.fechar{width:44px;height:44px;border-radius:50%;display:grid;place-items:center;color:var(--cor-texto-suave)}
.opcao{display:flex;align-items:center;gap:12px;margin:0 16px 10px;padding:14px;background:var(--cor-superficie);border-radius:var(--raio);box-shadow:0 0 0 1px #ECE8E1}
.opcao.escolhida{box-shadow:0 0 0 2px var(--cor-primaria)}
.opcao b{display:block;font-size:14.5px}
.opcao small{display:block;font-size:12.5px;color:var(--cor-texto-suave)}
.radio{width:22px;height:22px;border-radius:50%;box-shadow:inset 0 0 0 2px #CFC9BE;flex:none}
.radio.on{box-shadow:inset 0 0 0 7px var(--cor-primaria)}
.total{display:flex;justify-content:space-between;align-items:baseline;margin:16px 18px 2px;font-size:15px}
.total b{font-size:20px}
.nota-teste{margin:0 18px;font-size:12px;color:var(--cor-texto-suave)}
.confirmado{display:flex;flex-direction:column;align-items:center;text-align:center;padding:36px 20px 8px}
.selo-ok{width:76px;height:76px;border-radius:50%;background:var(--cor-primaria);display:grid;place-items:center;margin-bottom:18px}
.confirmado h1{font-size:24px;letter-spacing:-.02em}
.confirmado p{margin-top:8px;font-size:14px;color:var(--cor-texto-suave);max-width:300px}
.detalhes{margin:22px 0 4px;width:100%;background:var(--cor-superficie);border-radius:var(--raio);box-shadow:0 0 0 1px #ECE8E1;padding:4px 16px;text-align:left}
.detalhes div{display:flex;justify-content:space-between;gap:12px;padding:11px 0;border-bottom:1px solid #F0ECE5;font-size:14px}
.detalhes div:last-child{border-bottom:0}
.detalhes dt{color:var(--cor-texto-suave)}
.detalhes dd{margin:0;font-weight:600;text-align:right}
.confirmado .botao-contorno{width:100%;margin:12px 0 0}
.segmento{display:flex;margin:8px 16px 4px;padding:3px;border-radius:12px;background:#ECE8E1}
.segmento button{flex:1;height:36px;border-radius:9px;text-align:center;font-size:13.5px;font-weight:600;color:var(--cor-texto-suave)}
.segmento button.ativo{background:var(--cor-superficie);color:var(--cor-texto);box-shadow:0 1px 2px rgba(0,0,0,.08)}
.agendado{margin:10px 16px 0;padding:14px;background:var(--cor-superficie);border-radius:var(--raio);box-shadow:0 0 0 1px #ECE8E1}
.agendado-topo{display:flex;gap:12px;align-items:center}
.data-caixa{width:50px;height:54px;border-radius:12px;background:var(--cor-primaria);color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;flex:none}
.data-caixa small{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#C9DDD2}
.data-caixa b{font-size:19px;line-height:1.1}
.agendado-topo b{display:block;font-size:15px}
.agendado-topo small{display:block;font-size:12.5px;color:var(--cor-texto-suave)}
.selo{display:inline-block;margin-top:5px;padding:2px 8px;border-radius:999px;background:#E5EFE9;color:var(--cor-primaria);font-size:11.5px;font-weight:600}
.agendado .acoes{margin-top:12px}
.agendado .acoes button{flex:1;min-height:44px;border-radius:11px;text-align:center;font-weight:600;font-size:13.5px;box-shadow:inset 0 0 0 1px #DCD7CD}
.agendado .acoes .cancelar{color:#B4442F}
.anterior{display:flex;align-items:center;gap:12px;padding:10px 6px 10px 12px;background:var(--cor-superficie);border-radius:var(--raio);box-shadow:0 0 0 1px #ECE8E1}
.anterior .data-caixa{background:#F1EEE8;color:var(--cor-texto);width:44px;height:48px}
.anterior .data-caixa small{color:var(--cor-texto-suave)}
.anterior > span:nth-child(2){flex:1;min-width:0}
.anterior b{display:block;font-size:14px}
.anterior small{display:block;font-size:12px;color:var(--cor-texto-suave)}
.anterior .link-acao{font-size:13px}
.esqueleto{margin:10px 16px 0;padding:14px;display:flex;gap:12px;background:var(--cor-superficie);border-radius:var(--raio);box-shadow:0 0 0 1px #ECE8E1}
.esqueleto i{display:block;border-radius:6px;background:#ECE8E1}
.esqueleto .q{width:50px;height:54px;border-radius:12px;flex:none}
.esqueleto .l{flex:1;display:flex;flex-direction:column;gap:9px;padding-top:6px}
.esqueleto .l i:nth-child(1){height:12px;width:70%}
.esqueleto .l i:nth-child(2){height:10px;width:45%}
.esqueleto .l i:nth-child(3){height:10px;width:55%}
.vazio{display:flex;flex-direction:column;align-items:center;text-align:center;padding:64px 28px 0}
.vazio .circulo{width:72px;height:72px;border-radius:50%;display:grid;place-items:center;margin-bottom:16px;background:#E5EFE9;color:var(--cor-primaria)}
.vazio.erro .circulo{background:#FBE6DF;color:#B4442F}
.vazio b{font-size:16.5px}
.vazio p{margin-top:6px;font-size:13.5px;color:var(--cor-texto-suave);max-width:270px}
.vazio .botao-principal{width:auto;padding:0 22px;min-height:48px;margin-top:20px}
.offline{display:flex;gap:10px;align-items:center;margin:8px 16px 0;padding:11px 14px;border-radius:12px;background:#2B2B2B;color:#fff}
.offline b{display:block;font-size:13px}
.offline small{display:block;font-size:12px;color:#CFCFCF}
.perfil-topo{display:flex;flex-direction:column;align-items:center;padding:22px 16px 6px;text-align:center}
.avatar.grande{width:76px;height:76px;font-size:30px;margin-bottom:10px}
.perfil-topo h1{font-size:21px}
.perfil-topo small{font-size:13px;color:var(--cor-texto-suave)}
.numeros{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:14px 16px 0}
.numeros div{padding:12px 6px;text-align:center;background:var(--cor-superficie);border-radius:var(--raio);box-shadow:0 0 0 1px #ECE8E1}
.numeros b{display:block;font-size:17px}
.numeros small{font-size:11.5px;color:var(--cor-texto-suave)}
.menu{margin:16px 16px 0;background:var(--cor-superficie);border-radius:var(--raio);box-shadow:0 0 0 1px #ECE8E1;overflow:hidden}
.item{display:flex;align-items:center;gap:12px;width:100%;min-height:52px;padding:0 12px 0 16px;border-bottom:1px solid #F0ECE5;font-size:14.5px}
.item:last-child{border-bottom:0}
.item > span{flex:1}
.item small{color:var(--cor-texto-suave);font-size:13px}
.item > svg:first-child{color:var(--cor-primaria)}
.item > svg:last-child{color:#B5AFA4}
.item.sair{color:#B4442F}
.item.sair > svg:first-child{color:#B4442F}
.entrar{padding:30px 20px 0}
.marca{display:flex;align-items:center;gap:10px;margin-bottom:36px}
.marca span{width:44px;height:44px;border-radius:12px;background:var(--cor-primaria);display:grid;place-items:center}
.marca b{font:700 19px Georgia,'Times New Roman',serif;color:var(--cor-primaria)}
.entrar h1{font-size:28px;letter-spacing:-.02em}
.entrar > p{margin-top:6px;color:var(--cor-texto-suave);font-size:14px}
.campo{display:block;margin:24px 0 2px}
.campo > span{display:block;font-size:12.5px;font-weight:600;margin-bottom:6px}
.campo-tel{display:flex;align-items:center;gap:10px;height:52px;padding:0 14px;background:var(--cor-superficie);border-radius:var(--raio);box-shadow:0 0 0 1px #DCD7CD}
.campo-tel b{color:var(--cor-texto-suave);font-weight:600}
.campo-tel input{flex:1;min-width:0;border:0;outline:0;background:none;font-size:15px}
.entrar .botao-principal,.entrar .botao-contorno{width:100%;margin-left:0;margin-right:0}
.ou{display:flex;align-items:center;gap:12px;margin:14px 0 4px;color:var(--cor-texto-suave);font-size:12.5px}
.ou::before,.ou::after{content:'';flex:1;height:1px;background:#E2DDD3}
.termos{margin-top:18px;font-size:12px;color:var(--cor-texto-suave);text-align:center;line-height:1.5}
.avaliar{padding:12px 20px 0;text-align:center}
.avaliar h1{font-size:23px;margin-top:10px}
.avaliar > p{margin-top:6px;color:var(--cor-texto-suave);font-size:14px}
.estrelas{display:flex;justify-content:center;gap:6px;margin:20px 0 6px}
.avaliar textarea{width:100%;min-height:110px;margin-top:16px;padding:12px 14px;border:0;border-radius:var(--raio);background:var(--cor-superficie);box-shadow:0 0 0 1px #DCD7CD;resize:none;font-size:14px}
.avaliar .botao-principal{width:100%;margin:14px 0 0}`,
	},
	{
		name: 'colunas', css: `@media (min-width:600px){
.as-tela[data-screen="inicio"]{display:grid;grid-template-columns:1fr 1fr;column-gap:4px;align-content:start;grid-template-areas:"topo topo" "prox serv" "agen serv" "barb serv" "barb ."}
.as-tela[data-screen="inicio"] > [data-part="cabecalho"]{grid-area:topo}
.as-tela[data-screen="inicio"] > [data-part="proximo-horario"]{grid-area:prox}
.as-tela[data-screen="inicio"] > [data-part="botao-agendar"]{grid-area:agen}
.as-tela[data-screen="inicio"] > [data-part="servicos"]{grid-area:serv}
.as-tela[data-screen="inicio"] > [data-part="barbeiros"]{grid-area:barb}
.as-tela[data-screen="inicio"] > [data-part="servicos"] .bloco{margin-top:10px}
.grade-servicos > :nth-child(n+5){display:flex}
.lista{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.horas{grid-template-columns:repeat(4,1fr)}
}
@media (min-width:800px){
.as-tela[data-screen="inicio"]{grid-template-columns:1.05fr 1fr;column-gap:8px}
.grade-servicos{grid-template-columns:1fr 1fr 1fr}
.horas{grid-template-columns:repeat(6,1fr)}
.titulo-tela h1{font-size:30px}
}`,
	},
];

const DATA = {
	servicos: [
		{ tipo: 'corte', nome: 'Corte', descricao: 'Tesoura e máquina, com lavagem', duracao: '30 min', preco: 'R$ 45' },
		{ tipo: 'barba', nome: 'Barba', descricao: 'Toalha quente e navalha', duracao: '30 min', preco: 'R$ 35' },
		{ tipo: 'combo', nome: 'Corte e barba', descricao: 'O combo completo da casa, com lavagem e toalha quente', duracao: '60 min', preco: 'R$ 70' },
		{ tipo: 'sobrancelha', nome: 'Sobrancelha', descricao: 'Na navalha ou na pinça', duracao: '15 min', preco: 'R$ 20' },
		{ tipo: 'pigmentacao', nome: 'Pigmentação', descricao: 'Barba ou cabelo', duracao: '45 min', preco: 'R$ 60' },
	],
	barbeiros: [
		{ nome: 'Zé', inicial: 'Z', cor: '#24563F', nota: '4,9', descricao: 'Dono, desde 2009 · 1.673 cortes' },
		{ nome: 'Rafa', inicial: 'R', cor: '#D9643A', nota: '4,8', descricao: 'Degradê e navalha · 1.508 cortes' },
		{ nome: 'Léo', inicial: 'L', cor: '#5B6F8C', nota: '4,7', descricao: 'Barba e pigmentação · 902 cortes' },
	],
	dias: [
		{ semana: 'Seg', numero: '16', classe: '' }, { semana: 'Ter', numero: '17', classe: '' }, { semana: 'Qua', numero: '18', classe: '' },
		{ semana: 'Qui', numero: '19', classe: '' }, { semana: 'Sex', numero: '20', classe: '' }, { semana: 'Sáb', numero: '21', classe: 'escolhido' },
		{ semana: 'Dom', numero: '22', classe: 'fechado' },
	],
	manha: [{ hora: '09:00', classe: '' }, { hora: '09:30', classe: 'ocupado' }, { hora: '10:00', classe: 'ocupado' }, { hora: '10:30', classe: 'escolhido' }, { hora: '11:00', classe: '' }, { hora: '11:30', classe: '' }],
	tarde: [{ hora: '13:00', classe: '' }, { hora: '13:30', classe: '' }, { hora: '14:00', classe: 'ocupado' }, { hora: '14:30', classe: '' }, { hora: '15:00', classe: '' }, { hora: '15:30', classe: '' }, { hora: '16:00', classe: '' }, { hora: '16:30', classe: 'ocupado' }, { hora: '17:00', classe: '' }],
	anteriores: [
		{ mes: 'Out', dia: '24', servico: 'Corte e barba com Zé', valor: 'R$ 70,00 · Pix' },
		{ mes: 'Set', dia: '26', servico: 'Corte com Rafa', valor: 'R$ 45,00 · Pix' },
		{ mes: 'Ago', dia: '29', servico: 'Corte com Rafa', valor: 'R$ 45,00 · cartão' },
	],
};

const P = {
	cabecalho: `<header class="topo" data-state="sempre"><div class="saudacao"><small>Boa tarde, Marina</small><h1>Barbearia do Zé</h1></div><button class="icone-botao">${I.bell}</button><span class="avatar">M</span></header>`,
	proximo: `<section class="cartao-proximo"><span class="rotulo">Próximo horário</span><strong class="quando">Sáb, 21 de nov · 10:30</strong><div class="com-barbeiro"><span class="mini-avatar">R</span><div><b>Corte com Rafa</b><small>30 min · R$ 45,00</small></div></div><div class="acoes"><button class="pequeno botao-claro" data-go="horario">Remarcar</button><button class="pequeno botao-branco">${I.pin}Como chegar</button></div></section>`,
	agendar: `<button class="botao-principal" data-go="servicos">${I.plus}Agendar horário</button>`,
	servicosInicio: `<section class="bloco"><div class="bloco-titulo"><h2>Serviços</h2><button class="ver-todos" data-tab="servicos">Ver todos</button></div><div class="grade-servicos" data-each="servicos"><button class="servico-card" data-go="barbeiro"><span class="svc-icone" data-tipo="{{tipo}}"></span><span><b>{{nome}}</b><small>{{duracao}} · {{preco}}</small></span></button></div></section>`,
	barbeiros: `<section class="bloco"><div class="bloco-titulo"><h2>Barbeiros</h2><button class="ver-todos" data-go="barbeiro">Ver todos</button></div><div class="grade-barbeiros" data-each="barbeiros"><button class="barbeiro-card" data-go="barbeiro"><span class="foto" style="background:{{cor}}">{{inicial}}</span><b>{{nome}}</b><small>${I.star}{{nota}}</small></button></div></section>`,
	servicosTopo: `<header class="titulo-tela" data-state="sempre"><h1>Serviços</h1><p>Escolha o que vai fazer. Os preços valem para todos os barbeiros.</p></header>`,
	servicosLista: `<div class="lista" data-each="servicos"><button class="linha-servico" data-go="barbeiro"><span class="svc-icone" data-tipo="{{tipo}}"></span><span class="ls-texto"><b>{{nome}}</b><small>{{descricao}}</small></span><span class="ls-preco"><b>{{preco}}</b><small>{{duracao}}</small></span>${I.chevR}</button></div>`,
	hoje: `<div class="aviso-verde">${I.clock}<span><b>Hoje ainda tem horário</b><small>Léo às 15:30 · Zé às 17:00</small></span></div>`,
	barbeiroTopo: `<header class="barra-voltar"><button class="voltar" data-back aria-label="Voltar">${I.chevL}</button><h1>Escolha o barbeiro</h1></header><div class="passos"><i class="feito"></i><i></i><i></i><small>Passo 1 de 3</small></div><div class="resumo"><span class="svc-icone" data-tipo="corte"></span><span><b>Corte</b><small>30 min · R$ 45,00</small></span><button class="link-acao" data-back>Trocar</button></div>`,
	barbeiroLista: `<h2 class="secao">Quem vai atender</h2><div class="lista"><button class="linha-barbeiro livre" data-go="horario"><span class="foto">${I.clock}</span><span class="lb-texto"><b>Primeiro livre</b><small>Hoje, às 15:30</small></span></button></div><div class="lista" data-each="barbeiros" style="margin-top:10px"><button class="linha-barbeiro" data-go="horario"><span class="foto" style="background:{{cor}}">{{inicial}}</span><span class="lb-texto"><b>{{nome}}</b><small>{{descricao}}</small></span><span class="nota">${I.star}{{nota}}</span></button></div>`,
	horarioTopo: `<header class="barra-voltar"><button class="voltar" data-back aria-label="Voltar">${I.chevL}</button><h1>Escolha o horário</h1></header><div class="passos"><i class="feito"></i><i class="feito"></i><i></i><small>Passo 2 de 3</small></div><div class="resumo"><span class="foto" style="background:#D9643A;width:40px;height:40px;font-size:15px">R</span><span><b>Corte com Rafa</b><small>30 min · R$ 45,00</small></span><button class="link-acao" data-back>Trocar</button></div>`,
	horarioDias: `<div class="mes"><b>Novembro de 2026</b><span><button aria-label="Semana anterior">${I.chevL}</button><button aria-label="Próxima semana">${I.chevR}</button></span></div><div class="dias" data-each="dias"><button class="dia {{classe}}"><small>{{semana}}</small><b>{{numero}}</b></button></div>`,
	horarioHoras: `<h2 class="secao">Manhã</h2><div class="horas" data-each="manha"><button class="hora {{classe}}">{{hora}}</button></div><h2 class="secao">Tarde</h2><div class="horas" data-each="tarde"><button class="hora {{classe}}">{{hora}}</button></div>`,
	horarioRodape: `<div class="rodape-fixo resumo-baixo"><span><b>Sáb, 21 de nov · 10:30</b><small>Corte com Rafa</small></span><button class="botao-principal verde" data-go="pagamento">Continuar</button></div>`,
	pagamento: `<div class="folha"><div class="folha-topo"><h1>Pagamento</h1><button class="fechar" data-close aria-label="Fechar">${I.close}</button></div><div class="resumo"><span class="foto" style="background:#D9643A;width:40px;height:40px;font-size:15px">R</span><span><b>Corte com Rafa</b><small>Sáb, 21 de nov · 10:30</small></span><b style="padding-right:10px">R$ 45,00</b></div><h2 class="secao">Como quer pagar</h2><label class="opcao escolhida"><span class="radio on"></span><span><b>Pix</b><small>Aprovado na hora</small></span></label><label class="opcao"><span class="radio"></span><span><b>Cartão de crédito ou débito</b><small>Paga na barbearia, na maquininha</small></span></label><div class="total"><span>Total</span><b>R$ 45,00</b></div><p class="nota-teste">Modo de teste: nada é cobrado.</p><button class="botao-principal verde" data-go="confirmado">Pagar R$ 45,00 com Pix</button></div>`,
	confirmado: `<div class="confirmado"><span class="selo-ok">${I.check}</span><h1>Horário confirmado!</h1><p>Mandamos os detalhes por SMS para (81) 9 8765-4321.</p><dl class="detalhes"><div><dt>Serviço</dt><dd>Corte</dd></div><div><dt>Barbeiro</dt><dd>Rafa</dd></div><div><dt>Dia</dt><dd>Sáb, 21 de nov</dd></div><div><dt>Horário</dt><dd>10:30</dd></div><div><dt>Pago</dt><dd>R$ 45,00 com Pix</dd></div><div><dt>Endereço</dt><dd>Rua do Hospício, 315</dd></div></dl><button class="botao-contorno">${I.cal}Adicionar à agenda</button></div>`,
	horariosTopo: `<header class="titulo-tela" data-state="sempre"><h1>Meus horários</h1></header><div class="segmento" data-state="sempre"><button class="ativo">Próximos</button><button>Anteriores</button></div>`,
	horariosLista: `<div data-state="normal sem-internet"><div class="offline" data-state="sem-internet">${I.wifiOff}<span><b>Sem internet</b><small>Mostrando o que foi salvo às 10:12.</small></span></div><div class="agendado"><div class="agendado-topo"><span class="data-caixa"><small>Nov</small><b>21</b></span><span><b>Corte com Rafa</b><small>Sáb · 10:30 · 30 min · R$ 45,00</small><span class="selo">Confirmado</span></span></div><div class="acoes"><button data-go="horario">Remarcar</button><button class="cancelar">Cancelar</button></div></div><h2 class="secao">Anteriores</h2><div class="lista" data-each="anteriores"><div class="anterior"><span class="data-caixa"><small>{{mes}}</small><b>{{dia}}</b></span><span><b>{{servico}}</b><small>{{valor}}</small></span><button class="link-acao" data-go="barbeiro">Repetir</button></div></div></div>`,
	horariosCarregando: `<div data-state="carregando"><div class="esqueleto"><i class="q"></i><span class="l"><i></i><i></i><i></i></span></div><div class="esqueleto"><i class="q"></i><span class="l"><i></i><i></i><i></i></span></div><div class="esqueleto"><i class="q"></i><span class="l"><i></i><i></i><i></i></span></div></div>`,
	horariosVazio: `<div class="vazio" data-state="vazio"><span class="circulo">${I.calBig}</span><b>Nenhum horário marcado</b><p>Quando você agendar um corte, ele aparece aqui.</p><button class="botao-principal" data-go="servicos">${I.plus}Agendar horário</button></div>`,
	horariosErro: `<div class="vazio erro" data-state="erro"><span class="circulo">${I.alert}</span><b>Não deu para carregar</b><p>Seus horários estão salvos. Confira a conexão e tente de novo.</p><button class="botao-principal verde">${I.refresh}Tentar de novo</button></div>`,
	perfilTopo: `<div class="perfil-topo"><span class="avatar grande">M</span><h1>Marina Alves</h1><small>(81) 9 8765-4321</small></div><div class="numeros"><div><b>12</b><small>cortes</small></div><div><b>Rafa</b><small>preferido</small></div><div><b>2024</b><small>cliente desde</small></div></div>`,
	perfilMenu: `<div class="menu"><button class="item">${I.user}<span>Dados pessoais</span>${I.chevR}</button><button class="item">${I.card}<span>Formas de pagamento</span><small>Pix</small>${I.chevR}</button><div class="item">${I.bell}<span>Lembrete 1 h antes</span><i class="chave on"></i></div><button class="item" data-go="ajuda">${I.help}<span>Ajuda</span>${I.chevR}</button><button class="item sair" data-go="entrar">${I.exit}<span>Sair da conta</span></button></div>`,
	entrar: `<div class="entrar"><div class="marca"><span>${I.scissors}</span><b>Barbearia do Zé</b></div><h1>Entrar</h1><p>Use seu celular para marcar e acompanhar seus horários.</p><label class="campo"><span>Celular</span><div class="campo-tel"><b>+55</b><input type="tel" placeholder="(81) 9 0000-0000"></div></label><button class="botao-principal verde" data-tab="inicio">Receber código por SMS</button><div class="ou">ou</div><button class="botao-contorno" data-tab="inicio">${I.mail}Continuar com e-mail</button><p class="termos">Ao continuar, você aceita os Termos de uso e a Política de privacidade da barbearia.</p></div>`,
	avaliar: `<header class="barra-voltar"><button class="voltar" data-tab="inicio" aria-label="Fechar">${I.close}</button><h1>Avaliar</h1></header><div class="avaliar"><span class="foto" style="background:#D9643A;margin:8px auto 0;width:64px;height:64px;font-size:24px">R</span><h1>Como foi seu corte com Rafa?</h1><p>Sáb, 21 de nov · Corte</p><div class="estrelas">${I.starBig}${I.starBig}${I.starBig}${I.starBig}${I.starOff}</div><textarea placeholder="Conte o que achou (opcional)"></textarea><button class="botao-principal verde" data-tab="inicio">Enviar avaliação</button></div>`,
};

const THEME = { primary: '#24563F', accent: '#D9643A', background: '#F7F5F0', surface: '#FFFFFF', text: '#1C1C1C', muted: '#6B6B6B', font: 'system', radius: 14, icon: 'BZ' };
const TABS = [
	{ screen: 'inicio', label: 'Início', icon: 'inicio' },
	{ screen: 'servicos', label: 'Serviços', icon: 'tesoura' },
	{ screen: 'horarios', label: 'Meus horários', icon: 'agenda' },
	{ screen: 'perfil', label: 'Perfil', icon: 'perfil' },
];
const part = (id, html) => ({ id, html, updated: NOW - 600 });

function fullModel() {
	return {
		name: 'Barbearia do Zé', start: 'inicio', theme: THEME, tabs: TABS, styles: STYLES, data: DATA,
		links: [{ route: '/agendar/corte', screen: 'barbeiro' }],
		screens: [
			{ id: 'inicio', title: 'Início', route: '/', kind: 'tab', plan: ['cabecalho', 'proximo-horario', 'botao-agendar', 'servicos', 'barbeiros'], parts: [part('cabecalho', P.cabecalho), part('proximo-horario', P.proximo), part('botao-agendar', P.agendar), part('servicos', P.servicosInicio), part('barbeiros', P.barbeiros)] },
			{ id: 'servicos', title: 'Serviços', route: '/servicos', kind: 'tab', plan: ['topo', 'lista', 'hoje'], parts: [part('topo', P.servicosTopo), part('lista', P.servicosLista), part('hoje', P.hoje)] },
			{ id: 'barbeiro', title: 'Barbeiro', route: '/agendar/barbeiro', kind: 'stack', plan: ['topo', 'lista'], parts: [part('topo', P.barbeiroTopo), part('lista', P.barbeiroLista)] },
			{ id: 'horario', title: 'Horário', route: '/agendar/horario', kind: 'stack', login: true, plan: ['topo', 'dias', 'horas', 'rodape'], parts: [part('topo', P.horarioTopo), part('dias', P.horarioDias), part('horas', P.horarioHoras), part('rodape', P.horarioRodape)] },
			{ id: 'pagamento', title: 'Pagamento', route: '/agendar/pagamento', kind: 'modal', login: true, plan: ['pagamento'], parts: [part('pagamento', P.pagamento)] },
			{ id: 'confirmado', title: 'Confirmado', route: '/agendar/confirmado', kind: 'stack', login: true, plan: ['confirmacao'], parts: [part('confirmacao', P.confirmado)] },
			{ id: 'horarios', title: 'Meus horários', route: '/horarios', kind: 'tab', login: true, plan: ['topo', 'lista', 'carregando', 'vazio', 'erro'], parts: [part('topo', P.horariosTopo), part('lista', P.horariosLista), part('carregando', P.horariosCarregando), part('vazio', P.horariosVazio), part('erro', P.horariosErro)] },
			{ id: 'perfil', title: 'Perfil', route: '/perfil', kind: 'tab', login: true, plan: ['topo', 'menu'], parts: [part('topo', P.perfilTopo), part('menu', P.perfilMenu)] },
			{ id: 'entrar', title: 'Entrar', route: '/entrar', kind: 'stack', plan: ['entrar'], parts: [part('entrar', P.entrar)] },
			{ id: 'avaliar', title: 'Avaliar', route: '/avaliar', kind: 'stack', login: true, plan: ['avaliacao'], parts: [part('avaliacao', P.avaliar)] },
		],
	};
}

/** The app while the agent writes Início: two parts written, three planned. */
function buildingModel() {
	const m = fullModel();
	const inicio = m.screens[0];
	inicio.parts = inicio.parts.slice(0, 2);
	m.screens = [inicio];
	m.links = [];
	return m;
}

// ------------------------------------------------------------------ state.json

const PROBLEMS = [
	{ id: 'dead-end-confirmado', kind: 'dead-end', screen: 'confirmado', part: null, text: 'Depois de pagar, a tela Confirmado não tem botão nem jeito de voltar.', fix: 'Ponha um botão para Meus horários e outro para voltar ao Início.' },
	{ id: 'unreachable-avaliar', kind: 'unreachable', screen: 'avaliar', part: null, text: 'Nenhuma tela leva até Avaliar.', fix: 'Ligue a tela Avaliar a partir de Meus horários, num horário que já passou.' },
	{ id: 'missing-link-perfil-ajuda', kind: 'missing-link', screen: 'perfil', part: 'menu', text: 'O item Ajuda abre a tela ajuda, que não existe.', fix: 'Crie a tela Ajuda com as perguntas mais comuns e o telefone da barbearia.' },
	{ id: 'contrast-servicos-lista', kind: 'contrast', screen: 'servicos', part: 'lista', text: 'A duração, em cinza claro #A8A39A sobre branco, tem contraste de 2,4:1; o mínimo é 4,5:1.', fix: 'Escureça a duração para #6B716C (contraste de 5,0:1).' },
	{ id: 'button-label-inicio-cabecalho', kind: 'button-label', screen: 'inicio', part: 'cabecalho', text: 'O botão do sino só tem ícone; quem usa leitor de tela não sabe o que ele faz.', fix: 'Dê ao botão do sino o nome Avisos.' },
];

const VERSIONS = [
	['Criou o app Barbearia do Zé', 0], ['Estilos base e tema', 0], ['Criou a tela Início', 1], ['Início: cabeçalho e próximo horário', 1],
	['Início: serviços e barbeiros', 1], ['Serviços e Barbeiro', 3], ['Horário e Pagamento', 5], ['Confirmado', 6], ['Meus horários com estados', 7],
	['Perfil e Entrar', 9], ['Duas colunas no dobrável e no tablet', 9], ['Avaliar o corte', 10],
].map(([summary, screens], i) => ({ n: i + 1, at: NOW - (12 - i) * 290 - 200, summary, screens })).reverse();

function state(over = {}) {
	return {
		version: 1, updated: NOW,
		view: 'preview',
		focus: { screen: 'inicio', part: null, state: 'normal', device: 'iphone', frame: true, fold: 'open', landscape: false },
		building: null,
		problems: PROBLEMS,
		versions: VERSIONS,
		published: null,
		notice: null,
		settings: { folder: 'app', frame: true },
		...over,
	};
}
const focus = over => ({ screen: 'inicio', part: null, state: 'normal', device: 'iphone', frame: true, fold: 'open', landscape: false, ...over });

const full = appJson(fullModel(), 31);
const SCENARIOS = {
	empty: { app: null, state: { version: 1, updated: NOW, view: 'preview', focus: focus({}), building: null, problems: [], versions: [], published: null, notice: null, settings: { folder: 'app', frame: true } } },
	building: {
		app: appJson(buildingModel(), 4),
		state: state({ problems: [], versions: VERSIONS.slice(-3).map((v, i) => ({ ...v, n: i + 1, screens: 1 })).reverse(), building: { screen: 'inicio', part: 'proximo-horario', at: NOW - 1, action: 'write' } }),
		host: { running: true },
	},
	ready: { app: full, state: state() },
	android: { app: full, state: state({ focus: focus({ device: 'android' }) }) },
	'no-frame': { app: full, state: state({ focus: focus({ frame: false }) }) },
	'fold-open': { app: full, state: state({ focus: focus({ device: 'android-fold', fold: 'open' }) }) },
	'fold-closed': { app: full, state: state({ focus: focus({ device: 'android-fold', fold: 'closed' }) }) },
	'iphone-fold': { app: full, state: state({ focus: focus({ device: 'iphone-fold', fold: 'open' }) }) },
	'tablet-landscape': { app: full, state: state({ focus: focus({ device: 'tablet', landscape: true, screen: 'horario' }) }) },
	screens: { app: full, state: state({ view: 'screens' }) },
	map: { app: full, state: state({ view: 'map' }) },
	structure: { app: full, state: state({ view: 'structure' }) },
	test: { app: full, state: state({ view: 'test', focus: focus({ screen: 'servicos' }) }) },
	states: { app: full, state: state({ view: 'states', focus: focus({ screen: 'horarios', state: 'vazio' }) }) },
	problems: { app: full, state: state({ view: 'problems' }) },
	versions: { app: full, state: state({ view: 'versions' }) },
	publish: { app: full, state: state({ view: 'publish', published: { at: NOW - 120, files: ['app/index.html', 'app/manifest.webmanifest', 'app/icone.svg', 'app/sw.js'], capacitor: false, skipped: [] } }) },
	settings: { app: full, state: state({ view: 'settings' }) },
	modal: { app: full, state: state({ focus: focus({ screen: 'pagamento' }) }) },
};

const root = new URL('./fixtures/', import.meta.url);
for (const name of existsSync(root) ? readdirSync(root) : []) {
	if (name !== 'python-real' && SCENARIOS[name] === undefined) {
		rmSync(new URL(`${name}/`, root), { recursive: true, force: true });
	}
}
for (const [name, s] of Object.entries(SCENARIOS)) {
	const dir = new URL(`${name}/`, root);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	if (s.app) { writeFileSync(new URL('app.json', dir), JSON.stringify(s.app)); }
	writeFileSync(new URL('state.json', dir), JSON.stringify(s.state, null, 1));
	if (s.host) { writeFileSync(new URL('_host.json', dir), JSON.stringify(s.host)); }
}
console.log(`${Object.keys(SCENARIOS).length} scenarios in ${root.pathname}; full app: ${full.screens.length} screens, ${full.routes.edges.length} edges, preview ${full.preview.length} bytes`);
console.log('deadEnds', full.routes.deadEnds, 'unreachable', full.routes.unreachable, 'missing', JSON.stringify(full.routes.missing));
