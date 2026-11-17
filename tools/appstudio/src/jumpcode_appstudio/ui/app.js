/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// AppStudio Studio interface: plain JavaScript, no network, no libraries. studio_ui() joins runtime.js before this file,
// so globalThis.AppRuntime drives the app inside the preview frames. It reads the Studio files the tool writes
// (app.json and state.json; see CONTRACT.md) and shows the app being built live inside a phone, a foldable or a tablet,
// with or without the device frame, together with its screens, the map of routes, the structure, a test mode, the
// screen states, problems, versions, publishing and settings. The app document goes into same-origin iframe srcdoc
// frames sized to the device's logical screen (so the app's media queries see the device width) and the whole device
// is scaled to fit; the status bar, the camera, the fold and the home indicator are drawn over the frame. Pure viewing
// is local; every action that changes the app becomes a chat message (`ask`) the agent carries out. Text is pt-BR.
(function () {
	'use strict';

	/** @type {{ postMessage(m: object): void, getState(): any, setState(s: any): void }} */
	const host = typeof acquireVsCodeApi === 'function'
		? acquireVsCodeApi()
		: { postMessage() { }, getState() { return undefined; }, setState() { } };
	const RT = globalThis.AppRuntime && typeof globalThis.AppRuntime.start === 'function' ? globalThis.AppRuntime : null;

	// ------------------------------------------------------------------ constants

	const VIEWS = {
		preview: { label: 'Prévia', icon: 'phone' },
		screens: { label: 'Telas', icon: 'grid' },
		map: { label: 'Mapa', icon: 'map' },
		test: { label: 'Testar', icon: 'tap' },
		publish: { label: 'Publicar', icon: 'upload' },
	};
	const MORE = {
		structure: { label: 'Estrutura', icon: 'tree' },
		states: { label: 'Estados das telas', icon: 'layers' },
		problems: { label: 'Problemas', icon: 'warning' },
		versions: { label: 'Versões', icon: 'history' },
		settings: { label: 'Configurações', icon: 'gear' },
	};
	const ALL_VIEWS = ['preview', 'screens', 'map', 'structure', 'test', 'states', 'problems', 'versions', 'publish', 'settings'];
	/** Which toolbar button is lit for each view. */
	const VIEW_BUTTON = { preview: 'preview', screens: 'screens', map: 'map', structure: 'map', test: 'test', states: 'test', publish: 'publish', problems: 'more', versions: 'more', settings: 'more' };

	/**
	 * Logical screens (CSS px) and the safe areas the Studio gives the app (--as-topo, --as-baixo), with the frame drawn
	 * around them. Generic devices: no brand's exact shape.
	 */
	const DEVICES = {
		iphone: { label: 'iPhone', icon: 'phone', size: [390, 844], top: 50, bottom: 34, radius: 46, bezel: 12, cut: 'island', time: 16, home: 134 },
		android: { label: 'Android', icon: 'phone', size: [412, 915], top: 38, bottom: 24, radius: 30, bezel: 10, cut: 'hole', time: 14, home: 108 },
		'iphone-fold': { label: 'iPhone dobrável', icon: 'fold', open: [720, 790], closed: [360, 800], top: 44, bottom: 26, radius: 30, radiusClosed: 40, bezel: 11, cut: 'island', time: 15, home: 120 },
		'android-fold': { label: 'Android dobrável', icon: 'fold', open: [690, 780], closed: [344, 860], top: 38, bottom: 24, radius: 24, radiusClosed: 30, bezel: 10, cut: 'hole', time: 14, home: 116 },
		tablet: { label: 'Tablet', icon: 'tablet', size: [820, 1180], top: 24, bottom: 20, radius: 18, bezel: 22, cut: 'bezel', time: 13, home: 260 },
	};
	const DEVICE_IDS = Object.keys(DEVICES);
	const STATES = ['normal', 'carregando', 'vazio', 'erro', 'sem-internet'];
	const STATE_LABELS = { normal: 'Normal', carregando: 'Carregando', vazio: 'Vazio', erro: 'Erro', 'sem-internet': 'Sem internet' };
	const STATE_NOTES = { normal: 'com os dados de exemplo', carregando: 'enquanto os dados chegam', vazio: 'quando não há nada', erro: 'quando algo falha', 'sem-internet': 'celular sem rede' };
	const STATE_ASK = {
		carregando: 'o estado carregando (um esqueleto enquanto os dados chegam)',
		vazio: 'o estado vazio (quando não há nada para mostrar)',
		erro: 'o estado de erro (com um botão Tentar de novo)',
		'sem-internet': 'o estado sem internet (mostrando o que foi salvo)',
	};
	const KIND_LABELS = { tab: 'aba', stack: 'pilha', modal: 'modal' };
	const ZOOMS = [['fit', 'Ajustar'], ['0.5', '50%'], ['0.75', '75%'], ['1', '100%']];
	const PROBLEM_LABELS = {
		'dead-end': 'Tela sem saída', unreachable: 'Tela sem caminho', 'missing-link': 'Link para tela que não existe', contrast: 'Contraste baixo',
		'image-alt': 'Imagem sem descrição', 'button-label': 'Botão sem nome', 'empty-screen': 'Tela vazia', touch: 'Toque pequeno', overflow: 'Texto cortado',
	};
	const PROBLEM_GROUPS = { 'dead-end': 'nav', unreachable: 'nav', 'missing-link': 'nav', contrast: 'a11y', 'image-alt': 'a11y', 'button-label': 'a11y', touch: 'a11y', 'empty-screen': 'layout', overflow: 'layout' };
	const GROUP_LABELS = { all: 'Todos', a11y: 'Acessibilidade', layout: 'Layout', nav: 'Navegação' };
	const ACTIONS = { write: 'Escrevendo', screen: 'Criando a tela', tabs: 'Mudando as abas', styles: 'Mudando os estilos', data: 'Mudando os dados de exemplo', theme: 'Mudando o tema', remove: 'Tirando', restore: 'Voltando a versão', publish: 'Publicando' };
	const TEMPLATES = [
		['zero', 'Do zero', 'uma tela Início com a barra de abas', 'Crie um app de celular novo no AppStudio: comece pela tela Início, com a barra de abas.'],
		['agendamento', 'Agendamento', 'serviços, horários, pagamento e confirmação', 'Crie um app de celular de agendamento no AppStudio (serviços, horários, pagamento e confirmação), começando pela tela Início.'],
		['loja', 'Loja', 'produtos, carrinho e pedido', 'Crie um app de celular de loja no AppStudio (produtos, carrinho e pedido), começando pela tela Início.'],
		['cardapio', 'Cardápio', 'pratos, pedido e entrega', 'Crie um app de celular de cardápio no AppStudio (pratos, pedido e entrega), começando pela tela Início.'],
		['academia', 'Academia', 'treinos, aulas e presença', 'Crie um app de celular de academia no AppStudio (treinos, aulas e presença), começando pela tela Início.'],
		['tarefas', 'Lista de tarefas', 'listas, tarefas e lembretes', 'Crie um app de celular de lista de tarefas no AppStudio (listas, tarefas e lembretes), começando pela tela Início.'],
	];
	const SAMPLES = ['Faça a tela inicial com o próximo horário e os serviços com preço.', 'Crie a tela Perfil com os dados da pessoa e um botão Sair.', 'Na tela Início, aumente o botão Agendar horário.'];
	const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
	const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
	const ERROR = '#C2508F';

	const ICONS = {
		phone: '<rect x="4.4" y="1.6" width="7.2" height="12.8"/><path d="M7 12.2h2"/>',
		tablet: '<rect x="2.6" y="1.8" width="10.8" height="12.4"/><path d="M7 12.2h2"/>',
		fold: '<rect x="1.8" y="2.6" width="12.4" height="10.8"/><path d="M8 2.6v10.8"/>',
		grid: '<rect x="2" y="2" width="5" height="5"/><rect x="9" y="2" width="5" height="5"/><rect x="2" y="9" width="5" height="5"/><rect x="9" y="9" width="5" height="5"/>',
		map: '<path d="M1.8 3.6 5.6 2l4.8 1.8 3.8-1.6v10.2l-3.8 1.6-4.8-1.8-3.8 1.6z"/><path d="M5.6 2v10.2M10.4 3.8V14"/>',
		tap: '<path d="M6.4 8.6V3.4a1.2 1.2 0 0 1 2.4 0v4.4l3.1.6c.8.2 1.3.9 1.2 1.7l-.6 3.9H6.6L3.8 10.4a1.1 1.1 0 0 1 1.6-1.5z"/>',
		upload: '<path d="M8 10.6V2.4M4.8 5.4 8 2.2l3.2 3.2M2.4 10.4v3.2h11.2v-3.2"/>',
		tree: '<path d="M2.4 2.6h4.4M5 6.2h4.4M5 9.8h4.4M2.4 13.4h4.4M3.6 2.6v10.8M3.6 6.2H5M3.6 9.8H5"/><path d="M11 6.2h2.6M11 9.8h2.6"/>',
		layers: '<path d="M8 2 14 5.2 8 8.4 2 5.2z"/><path d="m2 8.2 6 3.2 6-3.2M2 11l6 3.2 6-3.2"/>',
		warning: '<path d="M8 2 14.4 13.6H1.6z"/><path d="M8 6.4v3.4M8 11.8h.01"/>',
		history: '<path d="M3 4.6A5.8 5.8 0 1 1 2.2 8"/><path d="M2.6 1.9v2.9h2.9M8 4.8V8l2.2 1.5"/>',
		gear: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.6v2M8 12.4v2M1.6 8h2M12.4 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M3.5 12.5l1.4-1.4M11.1 4.9l1.4-1.4"/>',
		folder: '<path d="M1.8 3.6h4.1l1.5 1.6h6.8v7.5H1.8z"/>',
		file: '<path d="M3.2 1.8h6l3.6 3.6v8.8H3.2z"/><path d="M9.2 1.8v3.6h3.6"/>',
		check: '<path d="m3 8.4 3.1 3.1L13 4.6"/>',
		passed: '<circle cx="8" cy="8" r="6.4" fill="currentColor" stroke="none"/><path d="m5.1 8.2 2 2 3.9-4.1" stroke="#FFFFFF" stroke-width="1.6"/>',
		alert: '<circle cx="8" cy="8" r="6.4" fill="currentColor" stroke="none"/><path d="M8 4.6v4.2M8 11.2h.01" stroke="#FFFFFF" stroke-width="1.8"/>',
		info: '<circle cx="8" cy="8" r="6"/><path d="M8 7.2v4M8 4.8h.01"/>',
		dot: '<circle cx="8" cy="8" r="3.4" fill="currentColor" stroke="none"/>',
		ring: '<circle cx="8" cy="8" r="5.6"/>',
		spinner: '<path d="M13.6 8A5.6 5.6 0 0 1 2.4 8"/>',
		comments: '<path d="M1.8 2.4h9v6.2H5.6L3.2 10.6V8.6H1.8z"/><path d="M12.6 5.6h1.6v6h-1.4v2l-2.4-2H6.8"/>',
		chip: '<rect x="4" y="4" width="8" height="8"/><path d="M6 1.8V4M10 1.8V4M6 12v2.2M10 12v2.2M1.8 6H4M1.8 10H4M12 6h2.2M12 10h2.2"/>',
		lock: '<rect x="3.2" y="7" width="9.6" height="7"/><path d="M5.4 7V5.2a2.6 2.6 0 0 1 5.2 0V7"/>',
		link: '<path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.4-2.4a2.6 2.6 0 0 0-3.7-3.7l-.8.8"/><path d="M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.1 9.2a2.6 2.6 0 0 0 3.7 3.7l.8-.8"/>',
		plus: '<path d="M8 3v10M3 8h10"/>',
		back: '<path d="M10 3.5 5.5 8l4.5 4.5"/>',
		chevR: '<path d="m6 3.5 4.5 4.5L6 12.5"/>',
		chevD: '<path d="M3.5 6 8 10.5 12.5 6"/>',
		refresh: '<path d="M13.2 6.6A5.4 5.4 0 0 0 3.4 5M2.8 9.4A5.4 5.4 0 0 0 12.6 11M3.4 2.2V5h2.8M12.6 13.8V11H9.8"/>',
		rotate: '<path d="M2.6 8a5.4 5.4 0 0 1 9.6-3.4M13.4 8a5.4 5.4 0 0 1-9.6 3.4"/><path d="M12.6 1.8v3h-3M3.4 14.2v-3h3"/>',
		zoom: '<circle cx="7" cy="7" r="4.4"/><path d="m10.2 10.2 3.6 3.6M5 7h4M7 5v4"/>',
		pointer: '<path d="M3.4 2.4 12.6 7l-4 1.2 2.6 4.6-1.8 1-2.6-4.6-3.2 2.8z"/>',
		stop: '<rect x="3.4" y="3.4" width="9.2" height="9.2"/>',
		play: '<path d="M4.6 2.8v10.4L13 8z" fill="currentColor"/>',
		close: '<path d="m4 4 8 8M12 4l-8 8"/>',
		route: '<circle cx="3.6" cy="3.6" r="1.6"/><circle cx="12.4" cy="12.4" r="1.6"/><path d="M5.2 3.6h5.2a2 2 0 0 1 0 4H5.6a2 2 0 0 0 0 4h5.2"/>',
		eye: '<path d="M1.6 8s2.4-4.4 6.4-4.4S14.4 8 14.4 8 12 12.4 8 12.4 1.6 8 1.6 8z"/><circle cx="8" cy="8" r="2"/>',
		palette: '<path d="M8 1.8a6.2 6.2 0 0 0 0 12.4c1 0 1.4-.7 1.1-1.5-.4-1 .2-1.9 1.3-1.9h1.6a2.2 2.2 0 0 0 2.2-2.2A6.2 6.2 0 0 0 8 1.8z"/><circle cx="5" cy="7" r=".8"/><circle cx="8" cy="4.8" r=".8"/><circle cx="11" cy="7" r=".8"/>',
		font: '<path d="M2.6 13.4 6.4 2.6h.8l3.8 10.8M3.8 10h6"/><path d="M11.4 9.6h2.8M12.8 8.2V13"/>',
		image: '<rect x="2" y="2.6" width="12" height="10.8"/><circle cx="5.6" cy="6" r="1.2"/><path d="m2.4 12.6 3.8-3.8 2.6 2.4 1.8-1.6 3 3"/>',
		database: '<ellipse cx="8" cy="3.6" rx="5.4" ry="1.8"/><path d="M2.6 3.6v8.8c0 1 2.4 1.8 5.4 1.8s5.4-.8 5.4-1.8V3.6M2.6 8c0 1 2.4 1.8 5.4 1.8s5.4-.8 5.4-1.8"/>',
		brush: '<path d="M14 2 7.6 8.4"/><path d="M7.6 8.4c-1.7-.4-3.1.6-3.3 2.3-.2 1.4-.8 2-2.1 2.5 2.3 1 5.7.6 6.1-1.9.2-1.1-.1-2.3-.7-2.9z"/>',
		desktop: '<rect x="1.8" y="2.4" width="12.4" height="8.4"/><path d="M5.4 13.6h5.2M8 10.8v2.8"/>',
		list: '<path d="M5.4 4h8.6M5.4 8h8.6M5.4 12h8.6M2.2 4h.01M2.2 8h.01M2.2 12h.01"/>',
		box: '<rect x="2.4" y="2.4" width="11.2" height="11.2"/>',
		ruler: '<path d="M1.8 11.2 11.2 1.8l3 3-9.4 9.4z"/><path d="m4.6 8.4 1.4 1.4M6.8 6.2l1.4 1.4M9 4l1.4 1.4"/>',
	};

	// ------------------------------------------------------------------ helpers

	const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' };
	const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ESC[c]);
	const ic = (name, cls = '') => `<svg class="as-ic ${cls}" viewBox="0 0 16 16" aria-hidden="true">${ICONS[name] || ''}</svg>`;
	const MARK = '<svg class="as-mark" viewBox="0 0 100 100" aria-hidden="true"><rect width="100" height="100" rx="24" fill="#C9483E"/><rect x="31" y="17" width="38" height="66" rx="8" fill="none" stroke="#FFFFFF" stroke-width="6"/><rect x="38" y="27" width="24" height="38" rx="2" fill="#FFFFFF" opacity=".85"/><circle cx="50" cy="73" r="3.6" fill="#FFFFFF"/></svg>';
	const parse = text => { try { return JSON.parse(text); } catch { return undefined; } };
	const obj = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
	const arr = value => Array.isArray(value) ? value : [];
	const num = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
	const str = value => typeof value === 'string' ? value : '';
	const pad = n => String(n).padStart(2, '0');
	const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

	/** A number in the Brazilian way: 1.234,56 (and a true minus sign). */
	function nf(value, decimals = 0) {
		const v = Number(value);
		if (value === null || value === undefined || !Number.isFinite(v)) { return '—'; }
		const text = Math.abs(v).toFixed(decimals);
		const [whole, fraction] = text.split('.');
		return (v < 0 && Number(text) !== 0 ? '−' : '') + whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + (fraction ? `,${fraction}` : '');
	}
	const plural = (n, one, many) => `${nf(n)} ${n === 1 ? one : many}`;
	/** Bytes in decimal units, as Windows Explorer writes them: 812 bytes, 48 KB, 1,69 MB. */
	const bytes = n => num(n) === null ? '—' : n < 1000 ? `${nf(n)} bytes` : n < 1e6 ? `${nf(n / 1e3)} KB` : `${nf(n / 1e6, n < 1e7 ? 2 : 1)} MB`;
	const joinPt = list => list.length <= 1 ? (list[0] || '') : `${list.slice(0, -1).join(', ')} e ${list[list.length - 1]}`;
	const quote = text => `“${text}”`;
	const ins = html => `<ins class="as-ins">${html}</ins>`;
	const del = html => `<del class="as-del">${html}</del>`;
	const dim = html => `<span class="as-dim">${html}</span>`;
	const mono = text => `<span class="as-m">${esc(text)}</span>`;
	const badge = (text, cls = '') => `<span class="as-badge ${cls}">${esc(text)}</span>`;
	/** Hours and minutes of a Unix time: 11:05. */
	function hm(seconds) {
		if (num(seconds) === null) { return '—'; }
		const d = new Date(seconds * 1000);
		return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
	}
	/** "hoje 11:05", "ontem 18:40" or "12/11/2026 11:05". */
	function when(seconds) {
		if (num(seconds) === null) { return '—'; }
		const d = new Date(seconds * 1000);
		const now = new Date();
		const day = x => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
		const yesterday = new Date(now.getTime() - 864e5);
		const prefix = day(d) === day(now) ? 'hoje' : day(d) === day(yesterday) ? 'ontem' : `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
		return `${prefix} ${hm(seconds)}`;
	}
	const clock = ms => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
	/** Lower-cases the first letter of a sentence that follows a colon, unless it starts a name ("Início"). */
	function lowerFirst(text) {
		const t = String(text || '').trim();
		const word = t.split(/[\s,.;:]/)[0];
		if (!word || screens().some(s => s.title === word) || /^[A-ZÀ-Ý]{2}/.test(word)) { return t; }
		return t.charAt(0).toLowerCase() + t.slice(1);
	}
	/** 32-bit FNV-1a of a string, as a short key. */
	function hash(text) {
		let h = 0x811c9dc5;
		for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
		return (h >>> 0).toString(36);
	}
	/** Relative luminance and contrast ratio (WCAG) of #RRGGBB colours. */
	function luminance(hex) {
		const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
		if (!m) { return null; }
		const [r, g, b] = [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16) / 255).map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
		return 0.2126 * r + 0.7152 * g + 0.0722 * b;
	}
	function contrast(a, b) {
		const la = luminance(a), lb = luminance(b);
		if (la === null || lb === null) { return null; }
		return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
	}
	/** Luminance of a computed CSS colour (rgb/rgba), or null when it is mostly transparent. */
	function cssLum(value) {
		const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(value || '');
		if (!m || (m[4] !== undefined && Number(m[4]) < 0.5)) { return null; }
		const hex = '#' + [m[1], m[2], m[3]].map(v => pad(Math.round(Number(v)).toString(16))).join('');
		return luminance(hex);
	}
	const cssHex = value => {
		const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(value || '');
		if (!m || (m[4] !== undefined && Number(m[4]) === 0)) { return null; }
		return ('#' + [m[1], m[2], m[3]].map(v => pad(Math.round(Number(v)).toString(16))).join('')).toUpperCase();
	};

	function btn(label, icon, cls = '', attrs = '') {
		return `<button class="as-btn ${cls}" ${attrs}>${icon ? ic(...[].concat(icon)) : ''}${label ? `<span class="t">${label}</span>` : ''}</button>`;
	}
	function panel(title, body, o = {}) {
		return `<div class="as-panel ${o.mk ? `mk mk-${o.mk}` : ''} ${o.cls || ''}" ${o.attrs || ''}><div class="as-ph">${o.icon ? ic(...[].concat(o.icon)) : ''}<span class="t">${title}</span>${o.sub ? `<em>${o.sub}</em>` : ''}${o.right ? `<span class="r">${o.right}</span>` : ''}</div><div class="as-pb ${o.pb || ''}" ${o.scroll ? `data-scroll="${o.scroll}"` : ''}>${body}</div>${o.foot ? `<div class="as-pfoot">${o.foot}</div>` : ''}</div>`;
	}
	const kv = (pairs, cls = '') => {
		const rows = pairs.filter(Boolean);
		return `<div class="as-kv ${cls}">${rows.map(([k, v, title], i) => `<span class="${i === rows.length - 1 ? 'last' : ''}">${k}</span><span class="${i === rows.length - 1 ? 'last' : ''}" ${title ? `title="${esc(title)}"` : ''}>${v}</span>`).join('')}</div>`;
	};
	const li = (icon, html, right = '', cls = '', attrs = '') => `<div class="as-li ${cls}" ${attrs}>${icon}<span class="tx">${html}</span>${right ? `<em>${right}</em>` : ''}</div>`;
	const note = (icon, cls, html) => `<div class="as-note">${ic(icon, cls)}<div>${html}</div></div>`;
	/** A table: cols are [label, width (0 = rest), class]; a row is cells or { c: cells, cls, attrs }. */
	function table(cols, rows, o = {}) {
		const headRow = `<colgroup>${cols.map(([, w]) => `<col ${w ? `style="width:${w}px"` : ''}>`).join('')}</colgroup><thead><tr>${cols.map(([label, , cls]) => `<th class="${cls || ''}">${label}</th>`).join('')}</tr></thead>`;
		const body = rows.map(r => {
			const opt = Array.isArray(r) ? {} : r;
			const cells = Array.isArray(r) ? r : r.c;
			return `<tr class="${opt.cls || ''}" ${opt.attrs || ''}>${cells.map((v, i) => `<td class="${cols[i][2] || ''}">${v}</td>`).join('')}</tr>`;
		}).join('');
		return `<table class="as-tbl ${o.cls || ''}">${headRow}<tbody>${body}</tbody></table>`;
	}
	const seg = items => `<span class="as-seg">${items.join('')}</span>`;
	const check = (label, on, attrs, title = '') => `<label class="as-chk" ${title ? `title="${esc(title)}"` : ''}><input type="checkbox" class="as-check" ${on ? 'checked' : ''} ${attrs}><span class="t">${label}</span></label>`;
	const select = (options, value, attrs, cls = '') => `<select class="as-select ${cls}" ${attrs}>${options.map(([v, label]) => `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>`;

	// ------------------------------------------------------------------ state

	const saved = obj(host.getState()) || {};
	const S = {
		ctx: null,
		st: null,
		app: null,
		appRaw: null,
		docs: null,
		view: ALL_VIEWS.includes(saved.view) ? saved.view : 'preview',
		sig: typeof saved.sig === 'string' ? saved.sig : null,
		device: DEVICES[saved.device] ? saved.device : 'iphone',
		frame: saved.frame !== false,
		fold: ['open', 'closed', 'both'].includes(saved.fold) ? saved.fold : 'open',
		landscape: !!saved.landscape,
		zoom: ZOOMS.some(([v]) => v === saved.zoom) ? saved.zoom : 'fit',
		mode: saved.mode === 'edit' ? 'edit' : 'use',
		showTaps: saved.showTaps !== false,
		place: obj(saved.place) || null,
		want: null,
		flash: null,
		sel: null,
		hist: [],
		taps: [],
		mapThumbs: saved.mapThumbs !== false,
		mapLabels: saved.mapLabels !== false,
		mapZoom: ['fit', '0.75', '1'].includes(saved.mapZoom) ? saved.mapZoom : '1',
		mapPick: null,
		gridFilter: 'all',
		gridOrder: saved.gridOrder === 'made' ? 'made' : 'path',
		gridFrame: saved.gridFrame !== false,
		statesScreen: null,
		statesPick: 'normal',
		statesAll: saved.statesAll !== false,
		structSel: null,
		probFilter: 'all',
		probSel: null,
		verSel: null,
		startPick: 'zero',
		setDraft: {},
		menu: null,
		running: false,
		pending: null,
		note: null,
		noteKind: 'info',
		noticeSeen: null,
		measured: null,
		partNames: obj(saved.partNames) || {},
	};

	function remember() {
		host.setState({
			view: S.view, sig: S.sig, device: S.device, frame: S.frame, fold: S.fold, landscape: S.landscape, zoom: S.zoom, mode: S.mode,
			showTaps: S.showTaps, place: S.place, mapThumbs: S.mapThumbs, mapLabels: S.mapLabels, mapZoom: S.mapZoom, gridOrder: S.gridOrder, gridFrame: S.gridFrame,
			statesAll: S.statesAll, partNames: S.partNames,
		});
	}

	function ask(text, send = true) {
		const requestId = send ? `as-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}` : undefined;
		host.postMessage({ type: 'ask', text, send: !!send, ...(requestId ? { requestId } : {}) });
		return requestId;
	}
	/** Sends a request to the agent; the Studio changes when the tool writes its files. */
	function act(text) {
		const requestId = ask(text, true);
		S.pending = { requestId, at: Date.now(), text };
		toast('Pedido enviado ao agente. Acompanhe na conversa.');
	}
	/** Puts a request in the chat box without sending it. */
	function fill(text) {
		ask(text, false);
		toast('O pedido está na caixa da conversa: complete e envie.');
	}

	// ------------------------------------------------------------------ derived data

	const st = () => S.st || {};
	const app = () => S.app;
	const screens = () => arr(app()?.screens).filter(s => obj(s) && typeof s.id === 'string');
	const hasApp = () => screens().length > 0;
	const screenOf = id => screens().find(s => s.id === id) || null;
	const titleOf = id => str(screenOf(id)?.title) || String(id || '');
	const kindOf = id => ['tab', 'stack', 'modal'].includes(screenOf(id)?.kind) ? screenOf(id).kind : 'stack';
	const tabs = () => arr(app()?.tabs).filter(t => obj(t) && screenOf(t.screen));
	const routes = () => obj(app()?.routes) || {};
	const edges = () => arr(routes().edges).filter(e => obj(e) && typeof e.from === 'string');
	const settings = () => obj(st().settings) || {};
	const theme = () => obj(app()?.theme) || {};
	const versions = () => arr(st().versions).filter(v => obj(v) && num(v.n) !== null).sort((a, b) => b.n - a.n);
	const versionNow = () => versions()[0]?.n ?? num(app()?.revision);
	const folder = () => str(app()?.folder) || str(settings().folder) || 'app';
	const projectName = () => S.ctx?.source || folder();
	const startId = () => screenOf(app()?.start) ? app().start : screens()[0]?.id || null;
	const building = () => obj(st().building);
	/** The last building step is fresh for a few seconds: the preview outlines its part and shows the build panel. */
	const buildFresh = (seconds = 8) => { const b = building(); return !!b && num(b.at) !== null && Date.now() / 1000 - b.at < seconds; };
	const agentBusy = () => S.running || !!S.pending;
	const enabledDevices = () => {
		const list = arr(settings().devices).filter(d => DEVICES[d]);
		return list.length ? DEVICE_IDS.filter(d => list.includes(d) || d === S.device) : DEVICE_IDS;
	};
	const partName = (screen, part) => S.partNames[`${screen}/${part}`] || part;
	const lockHtml = id => screenOf(id)?.login ? `<span class="as-lock" title="Pede login">${ic('lock', 'sm')}</span>` : '';

	/** Breadth-first order of the screens from the start (tabs first, as the tab bar shows them), then the rest. */
	function pathOrder() {
		const list = screens();
		const out = [];
		const seen = new Set();
		const queue = [startId(), ...tabs().map(t => t.screen)].filter(Boolean);
		while (queue.length) {
			const id = queue.shift();
			if (seen.has(id) || !screenOf(id)) { continue; }
			seen.add(id);
			out.push(id);
			edges().filter(e => e.from === id && e.to && screenOf(e.to)).forEach(e => queue.push(e.to));
		}
		return out.concat(list.map(s => s.id).filter(id => !seen.has(id)));
	}
	/** Shortest path of screens from the start to a screen, following taps (go, tab, link). */
	function pathTo(target) {
		const from = startId();
		if (!from || !screenOf(target)) { return null; }
		const prev = new Map([[from, null]]);
		const queue = [from];
		// The tab bar leads from any tab screen to the others.
		const next = id => {
			const out = edges().filter(e => e.from === id && e.to && screenOf(e.to)).map(e => [e.to, e]);
			if (kindOf(id) === 'tab') { tabs().forEach(t => out.push([t.screen, { from: id, to: t.screen, label: `aba ${t.label || titleOf(t.screen)}`, how: 'tab', bar: true }])); }
			return out;
		};
		while (queue.length) {
			const id = queue.shift();
			if (id === target) { break; }
			for (const [to, edge] of next(id)) {
				if (!prev.has(to)) { prev.set(to, { id, edge }); queue.push(to); }
			}
		}
		if (!prev.has(target)) { return null; }
		const steps = [];
		let at = target;
		while (prev.get(at)) { const p = prev.get(at); steps.unshift({ from: p.id, to: at, edge: p.edge }); at = p.id; }
		return { screens: [from, ...steps.map(s => s.to)], steps };
	}
	const opener = id => edges().find(e => e.to === id && e.from !== id && screenOf(e.from) && kindOf(e.from) !== 'modal')?.from || startId();

	/** Problems: the tool's checks plus the ones measured here in the current device. */
	function problems() {
		const tool = arr(st().problems).filter(p => obj(p) && typeof p.text === 'string').map(p => ({ ...p, group: PROBLEM_GROUPS[p.kind] || 'layout' }));
		const measured = S.measured && S.measured.rev === revKey() ? S.measured.list : [];
		return tool.concat(measured);
	}
	function problemAsk(p) {
		if (p.ask) { return p.ask; }
		const where = p.screen && screenOf(p.screen) ? `Na tela ${titleOf(p.screen)}${p.part ? `, parte ${p.part}` : ''}: ` : '';
		const fix = String(p.fix || '').trim();
		if (!fix) { return `${where || 'No app: '}corrija isto: ${p.text}`; }
		// A fix that already says where ("Na tela Confirmado, …") goes as it is.
		return /^na tela /i.test(fix) || !where ? fix : `${where}${lowerFirst(fix)}`;
	}

	// ------------------------------------------------------------------ the app document

	const revKey = () => (S.app ? `${S.app.revision ?? ''}:${S.docs?.hash || ''}` : '');

	/** Splits the preview into what each screen's own small document needs (thumbnails load one screen each). */
	function readDocs(preview) {
		const doc = new DOMParser().parseFromString(preview, 'text/html');
		const appEl = doc.querySelector('.as-app');
		const attrs = el => el ? [...el.attributes].filter(a => a.name !== 'data-start').map(a => `${a.name}="${esc(a.value)}"`).join(' ') : '';
		const sections = new Map();
		const order = new Map();
		for (const section of doc.querySelectorAll('.as-tela[data-screen]')) {
			const id = section.getAttribute('data-screen');
			sections.set(id, section.outerHTML);
			order.set(id, [...section.querySelectorAll('.as-parte[data-part]')].map(p => ({ id: p.getAttribute('data-part'), planned: p.classList.contains('as-planejada'), name: p.getAttribute('data-planned') || '' })));
		}
		const dados = doc.getElementById('as-dados');
		return {
			hash: hash(preview),
			head: doc.head ? doc.head.innerHTML : '',
			bodyAttrs: attrs(doc.body),
			appAttrs: attrs(appEl),
			sections,
			order,
			nav: doc.querySelector('.as-abas')?.outerHTML || '',
			dados: dados ? `<script type="application/json" id="as-dados">${dados.textContent.replace(/</g, '\\u003c')}</script>` : '',
		};
	}
	/** One screen's document (with the screen it opens over, for a modal), for a thumbnail frame. */
	function snapDoc(id) {
		const d = S.docs;
		if (!d || !d.sections.has(id)) { return ''; }
		const base = kindOf(id) === 'modal' ? opener(id) : null;
		const parts = (base && base !== id && d.sections.has(base) ? d.sections.get(base) : '') + d.sections.get(id);
		return `<!doctype html><html lang="pt-BR"><head>${d.head}</head><body ${d.bodyAttrs}><div ${d.appAttrs} data-start="${esc(base || id)}">${parts}${d.nav}</div>${d.dados}</body></html>`;
	}
	/** A key of one screen's document, so a thumbnail reloads only when its own screen (or what all share) changed. */
	function snapSig(id) {
		if (!S.docs || !S.docs.sections.has(id)) { return 'none'; }
		const cache = S.docs.sigs || (S.docs.sigs = new Map());
		if (!cache.has(id)) { cache.set(id, hash(snapDoc(id))); }
		return cache.get(id);
	}

	/** Style the Studio adds to every preview document: phone-like scrolling and the planned parts as skeleton blocks. */
	const DOC_CSS = 'html{scrollbar-width:none}html::-webkit-scrollbar,body::-webkit-scrollbar,*::-webkit-scrollbar{width:0;height:0}'
		+ '.as-planejada{position:relative;overflow:hidden;min-height:76px}'
		+ '.as-planejada::before{content:attr(data-planned);position:absolute;left:14px;top:11px;font:600 11.5px/1.2 system-ui,"Segoe UI",sans-serif;color:#8B857A;letter-spacing:.02em}'
		+ '.as-planejada::after{content:"";position:absolute;left:14px;right:40%;top:34px;height:9px;border-radius:5px;background:#D4CFC5;box-shadow:0 17px 0 #D4CFC5}'
		+ 'html.as-editar,html.as-editar *{cursor:crosshair!important}';

	function prepareDoc(doc, sp) {
		const style = doc.createElement('style');
		style.setAttribute('data-studio', '');
		style.textContent = DOC_CSS;
		(doc.head || doc.documentElement).appendChild(style);
		safeAreas(doc, sp);
	}
	function safeAreas(doc, sp) {
		doc.documentElement.style.setProperty('--as-topo', `${sp.top}px`);
		doc.documentElement.style.setProperty('--as-baixo', `${sp.bottom}px`);
	}
	/** Light or dark glyphs for the status bar, from the colour at the top of the app. */
	function topTone(doc, width) {
		try {
			const win = doc.defaultView;
			let el = doc.elementFromPoint(width / 2, 3);
			while (el) {
				const l = cssLum(win.getComputedStyle(el).backgroundColor);
				if (l !== null) { return l < 0.4 ? 'dk' : 'lt'; }
				el = el.parentElement;
			}
		} catch { /* the frame went away */ }
		return 'lt';
	}

	// ------------------------------------------------------------------ devices

	/** The device the preview shows: logical size, safe areas, frame geometry and what is drawn over it. */
	function spec(id = S.device, fold = S.fold === 'both' ? 'open' : S.fold, landscape = S.landscape, frame = S.frame) {
		const d = DEVICES[id] || DEVICES.iphone;
		const isFold = !!d.open;
		const f = isFold ? (fold === 'closed' ? 'closed' : 'open') : null;
		let [w, h] = isFold ? d[f] : d.size;
		let top = d.top, bottom = d.bottom;
		if (landscape) {
			[w, h] = [h, w];
			top = 24;
			bottom = 20;
		}
		const radius = f === 'closed' ? d.radiusClosed : d.radius;
		const bezel = frame ? d.bezel : 0;
		const name = `${d.label}${f ? (f === 'open' ? ' aberto' : ' fechado') : ''}${landscape ? ' deitado' : ''}`;
		return {
			id, label: d.label, name, fold: f, landscape, frame, w, h, top, bottom, radius, bezel, cut: d.cut, time: d.time, home: d.home,
			crease: f === 'open' ? (landscape ? 'h' : 'v') : null, W: w + 2 * bezel, H: h + 2 * bezel,
			key: `${id}|${f}|${landscape ? 1 : 0}|${frame ? 1 : 0}`,
		};
	}
	const sizeText = sp => `${sp.w} × ${sp.h}`;

	function today() {
		const d = new Date();
		return `${WEEKDAYS[d.getDay()]} ${d.getDate()} de ${MONTHS[d.getMonth()]}`;
	}
	const SB_SIGNAL = '<svg viewBox="0 0 18 12" class="sig"><rect x="0" y="8" width="3" height="4" rx=".8"/><rect x="5" y="5.5" width="3" height="6.5" rx=".8"/><rect x="10" y="3" width="3" height="9" rx=".8"/><rect x="15" y="0" width="3" height="12" rx=".8"/></svg>';
	const SB_WIFI = '<svg viewBox="0 0 16 12" class="wifi"><path d="M8 11.6 5.6 9.1a3.4 3.4 0 0 1 4.8 0z"/><path d="M3.6 7.1a6.3 6.3 0 0 1 8.8 0l-1.3 1.3a4.5 4.5 0 0 0-6.2 0z"/><path d="M1.4 4.9a9.4 9.4 0 0 1 13.2 0l-1.3 1.3a7.6 7.6 0 0 0-10.6 0z"/></svg>';
	const SB_BATTERY = '<svg viewBox="0 0 27 12" class="bat"><rect x=".6" y=".6" width="22.8" height="10.8" rx="3" fill="none" stroke-width="1.2"/><rect x="2.4" y="2.4" width="19.2" height="7.2" rx="1.6"/><path d="M25 4v4a2 2 0 0 0 0-4z"/></svg>';

	/** Status bar, camera, fold and home indicator, drawn over the app screen in its own pixels. */
	function overlayHtml(sp, tone = 'lt') {
		const parts = [];
		const islandW = sp.fold === 'closed' ? 92 : sp.fold === 'open' ? 96 : 122;
		const cutX = sp.fold === 'open' && !sp.landscape ? sp.w * 0.75 : sp.w / 2;
		const portraitCut = sp.frame && !sp.landscape && sp.cut !== 'bezel';
		// The time sits in the ear left of a centred island; elsewhere it starts at the edge.
		const centredIsland = portraitCut && sp.cut === 'island' && sp.fold !== 'open';
		const ear = (sp.w - islandW) / 2;
		const time = sp.id === 'tablet' ? `9:41 <span class="dt">${today()}</span>` : '9:41';
		const timeStyle = centredIsland ? `left:0;width:${ear}px;text-align:center` : `left:${sp.id === 'tablet' ? 20 : 22}px`;
		const iconsStyle = centredIsland ? `right:0;width:${ear}px;justify-content:center` : `right:${sp.id === 'tablet' ? 18 : 18}px`;
		const battery = sp.id === 'tablet' ? `<span class="pct">100%</span>${SB_BATTERY}` : SB_BATTERY;
		parts.push(`<div class="as-sb" style="height:${sp.top}px;font-size:${sp.time}px"><span class="tm" style="${timeStyle}">${time}</span><span class="ics" style="${iconsStyle}">${sp.id === 'tablet' ? '' : SB_SIGNAL}${SB_WIFI}${battery}</span></div>`);
		if (portraitCut && sp.cut === 'island') {
			const h = sp.fold === 'closed' ? 28 : sp.fold === 'open' ? 26 : 35;
			parts.push(`<i class="as-cut island" style="width:${islandW}px;height:${h}px;left:${cutX - islandW / 2}px;top:${Math.round((sp.top - h) / 2)}px;border-radius:${h / 2}px"></i>`);
		} else if (portraitCut && sp.cut === 'hole') {
			const dmt = 13;
			parts.push(`<i class="as-cut hole" style="width:${dmt}px;height:${dmt}px;left:${cutX - dmt / 2}px;top:${Math.round((sp.top - dmt) / 2)}px"></i>`);
		}
		if (sp.crease === 'v') {
			parts.push(`<i class="as-crease v" style="left:${sp.w / 2 - 1}px"></i>`);
		} else if (sp.crease === 'h') {
			parts.push(`<i class="as-crease h" style="top:${sp.h / 2 - 1}px"></i>`);
		}
		const homeW = sp.landscape ? Math.min(sp.home * 1.4, sp.w * 0.3) : sp.home;
		const homeH = sp.id === 'iphone' ? 5 : 4;
		parts.push(`<i class="as-home" style="width:${homeW}px;height:${homeH}px;left:${(sp.w - homeW) / 2}px;bottom:${Math.max(6, Math.round((sp.bottom - homeH) / 2) - 2)}px"></i>`);
		return `<div class="as-ov ${tone}">${parts.join('')}</div>`;
	}

	/** The device body around the screen, in the device's own pixels (W × H). */
	function frameHtml(sp) {
		if (!sp.frame) { return ''; }
		const r = sp.radius + sp.bezel;
		const parts = [`<i class="as-shell" style="border-radius:${r}px"></i>`];
		const side = (edge, at, len) => {
			const style = sp.landscape
				? `${edge === 'r' ? 'bottom' : 'top'}:-3px;left:${at * sp.W}px;width:${len * sp.W}px;height:4px`
				: `${edge === 'r' ? 'right' : 'left'}:-3px;top:${at * sp.H}px;height:${len * sp.H}px;width:4px`;
			parts.push(`<i class="as-key" style="${style}"></i>`);
		};
		if (sp.id === 'tablet') {
			side('r', 0.12, 0.06);
			const cam = 8;
			parts.push(sp.landscape
				? `<i class="as-cam" style="left:${(sp.bezel - cam) / 2}px;top:${sp.H / 2 - cam / 2}px;width:${cam}px;height:${cam}px"></i>`
				: `<i class="as-cam" style="left:${sp.W / 2 - cam / 2}px;top:${(sp.bezel - cam) / 2}px;width:${cam}px;height:${cam}px"></i>`);
		} else {
			side('r', 0.26, 0.11);
			side('l', 0.2, 0.06);
			side('l', 0.29, 0.06);
			if (sp.landscape) {
				// Lying down, the camera stays in the frame at the left, outside the app's area.
				const len = sp.cut === 'island' ? 60 : 9;
				parts.push(`<i class="as-cam ${sp.cut === 'island' ? 'pill' : ''}" style="left:${(sp.bezel - 7) / 2}px;top:${sp.H / 2 - len / 2}px;width:7px;height:${len}px"></i>`);
			}
		}
		if (sp.crease) {
			parts.push(sp.crease === 'v' ? `<i class="as-hinge v" style="left:${sp.W / 2 - 0.5}px"></i>` : `<i class="as-hinge h" style="top:${sp.H / 2 - 0.5}px"></i>`);
		}
		return parts.join('');
	}

	/** A non-interactive frame of one screen (thumbnails, grid, map, states), mounted by mountSnaps. */
	function snapHtml(id, sp, k, o = {}) {
		const state = o.state || 'normal';
		const sig = `${snapSig(id)}|${sp.key}|${state}`;
		const scr = `left:${sp.bezel}px;top:${sp.bezel}px;width:${sp.w}px;height:${sp.h}px;border-radius:${sp.radius}px`;
		return `<div class="as-snap ${sp.frame ? 'framed' : 'bare'} ${o.cls || ''}" data-snap="${esc(id)}" data-state="${state}" data-sig="${esc(sig)}" data-spec="${sp.key}" ${o.mark ? `data-mark="${esc(o.mark)}"` : ''} style="width:${Math.round(sp.W * k)}px;height:${Math.round(sp.H * k)}px"><div class="as-snap-dev" style="width:${sp.W}px;height:${sp.H}px;transform:scale(${k})">${frameHtml(sp)}<div class="as-scr" style="${scr}">${overlayHtml(sp)}</div></div></div>`;
	}
	const specFromKey = key => { const [id, f, l, fr] = String(key).split('|'); return spec(id, f === 'null' ? 'open' : f, l === '1', fr === '1'); };

	/** Loads every unmounted thumbnail frame inside root with its screen, non-interactive, in its state. */
	function mountSnaps(root) {
		if (!RT || !root) { return; }
		for (const snap of root.querySelectorAll('.as-snap:not(.m)')) {
			snap.classList.add('m');
			const id = snap.getAttribute('data-snap');
			const html = snapDoc(id);
			if (!html) { continue; }
			const sp = specFromKey(snap.getAttribute('data-spec'));
			const scr = snap.querySelector('.as-scr');
			const frame = document.createElement('iframe');
			frame.className = 'as-if on';
			frame.setAttribute('tabindex', '-1');
			frame.setAttribute('aria-hidden', 'true');
			frame.addEventListener('load', () => {
				const doc = frame.contentDocument;
				if (!doc || !doc.querySelector('.as-app')) { return; }
				prepareDoc(doc, sp);
				const state = snap.getAttribute('data-state') || 'normal';
				const base = kindOf(id) === 'modal' ? opener(id) : id;
				const ctl = RT.start(doc, { screen: base, interactive: false });
				if (!ctl) { return; }
				if (base !== id) { ctl.go(id); }
				if (state !== 'normal') { ctl.setState(state); }
				const ov = scr.querySelector('.as-ov');
				if (ov) { ov.className = `as-ov ${topTone(doc, sp.w)}`; }
				const mark = snap.getAttribute('data-mark');
				if (mark) { markSnap(snap, doc, mark, sp); }
			});
			frame.srcdoc = html;
			scr.insertBefore(frame, scr.firstChild);
		}
	}
	/** Outlines a part (or a measured element) of a thumbnail frame, for the problems view. */
	function markSnap(snap, doc, mark, sp) {
		const [kind, value] = mark.split(':');
		let el = null;
		if (kind === 'part') { el = doc.querySelector(`.as-tela:not([hidden]) [data-part="${CSS.escape(value)}"]`); }
		if (kind === 'text') { el = [...doc.querySelectorAll('.as-tela:not([hidden]) *')].find(e => e.children.length === 0 && e.textContent.trim() === value) || null; }
		if (!el) { return; }
		const win = doc.defaultView;
		const r = el.getBoundingClientRect();
		if (r.top > sp.h * 0.7) { win.scrollTo(0, r.top - sp.h * 0.3); }
		const box = el.getBoundingClientRect();
		const k = snap.getBoundingClientRect().width / sp.W || 0.4;
		const line = Math.max(2, 2 / k);
		const m = document.createElement('i');
		m.className = 'as-snapmark';
		m.style.cssText = `left:${box.left - line}px;top:${box.top - line}px;width:${box.width + line * 2}px;height:${box.height + line * 2}px;border-width:${line}px`;
		snap.querySelector('.as-ov')?.appendChild(m);
	}

	// ------------------------------------------------------------------ live preview devices

	/** The live devices on the stage (one, or two when a foldable shows closed and open side by side). */
	const E = { root: null, bar: null, sub: null, body: null, foot: null, layer: null, lives: [], measure: null, observer: null };

	function liveSpecs() {
		const d = DEVICES[S.device];
		if (d.open && S.fold === 'both') {
			return [spec(S.device, 'closed'), spec(S.device, 'open')];
		}
		return [spec()];
	}

	/** Creates a live device: two iframes (the new revision loads in the hidden one, then they swap), its overlay and marks. */
	function makeLive(row, index) {
		const box = document.createElement('div');
		box.className = 'as-live';
		box.innerHTML = '<div class="as-dev"><div class="as-dev-frame"></div><div class="as-scr"><iframe class="as-if" title="Prévia do app"></iframe><iframe class="as-if" title="Prévia do app"></iframe><div class="as-ovw"></div></div></div><div class="as-marks"></div><div class="as-live-cap"></div>';
		row.appendChild(box);
		const L = {
			index, box, dev: box.querySelector('.as-dev'), frameEl: box.querySelector('.as-dev-frame'), scr: box.querySelector('.as-scr'),
			ovw: box.querySelector('.as-ovw'), marks: box.querySelector('.as-marks'), cap: box.querySelector('.as-live-cap'),
			frames: [...box.querySelectorAll('iframe')], front: -1, token: 0, key: null, sp: null, k: 1, ctl: null, doc: null,
			restoring: false, tone: 'lt', hover: null, lastTap: null, scrollMemo: {},
		};
		L.frames.forEach(f => { f.setAttribute('tabindex', '0'); });
		return L;
	}

	function disposeLives() {
		for (const L of E.lives) {
			try { L.ctl?.dispose(); } catch { /* the frame went away */ }
			L.box.remove();
		}
		E.lives = [];
	}

	function liveSetSpec(L, sp) {
		const changed = !L.sp || L.sp.key !== sp.key;
		L.sp = sp;
		if (!changed) { return; }
		L.frameEl.innerHTML = frameHtml(sp);
		L.scr.style.cssText = `left:${sp.bezel}px;top:${sp.bezel}px;width:${sp.w}px;height:${sp.h}px;border-radius:${sp.radius}px`;
		L.scr.classList.toggle('bare', !sp.frame);
		L.dev.style.width = `${sp.W}px`;
		L.dev.style.height = `${sp.H}px`;
		if (L.doc) {
			safeAreas(L.doc, sp);
			L.tone = topTone(L.doc, sp.w);
		}
		drawOverlay(L);
	}
	function drawOverlay(L) {
		L.ovw.innerHTML = overlayHtml(L.sp, L.tone);
	}

	/** Loads a new revision of the app into the hidden frame and swaps when it is ready, keeping the place. */
	function liveLoad(L, html, key) {
		if (L.key === key || !RT) { return; }
		L.key = key;
		const token = ++L.token;
		const frame = L.frames[L.front === 0 ? 1 : 0];
		frame.onload = () => {
			if (token !== L.token) { return; }
			const doc = frame.contentDocument;
			if (!doc || doc.location.href !== 'about:srcdoc' || !doc.querySelector('.as-app')) { return; }
			liveAttach(L, frame, doc);
		};
		frame.srcdoc = html;
	}

	function liveAttach(L, frame, doc) {
		const old = L.front >= 0 ? L.frames[L.front] : null;
		const oldDoc = L.doc;
		const place = S.place && S.place.stack?.length ? S.place : null;
		const current = place ? place.modal || place.stack[place.stack.length - 1] : null;
		let scrollY = 0, modalScroll = 0;
		try {
			if (oldDoc && current) {
				scrollY = oldDoc.defaultView.scrollY;
				modalScroll = oldDoc.querySelector('.as-modal-aberta')?.scrollTop || 0;
			}
		} catch { /* the old frame went away */ }
		prepareDoc(doc, L.sp);
		doc.documentElement.classList.toggle('as-editar', S.mode === 'edit');
		L.restoring = true;
		const ctl = RT.start(doc, {
			screen: place?.stack?.[0],
			interactive: true,
			onChange: info => liveChanged(L, info),
			onMissing: id => toast(`A tela ${id} ainda não existe. Peça na conversa para criá-la.`, 'warning'),
		});
		if (!ctl) { L.restoring = false; return; }
		try { L.ctl?.dispose(); } catch { /* the old frame went away */ }
		L.ctl = ctl;
		L.doc = doc;
		if (place) { replay(ctl, place); }
		L.restoring = false;
		try {
			if (scrollY) { doc.defaultView.scrollTo(0, scrollY); }
			if (modalScroll) { const m = doc.querySelector('.as-modal-aberta'); if (m) { m.scrollTop = modalScroll; } }
		} catch { /* nothing to keep */ }
		frame.classList.add('on');
		if (old) { old.classList.remove('on'); old.onload = null; }
		L.front = L.frames.indexOf(frame);
		hookDoc(L, doc);
		L.tone = topTone(doc, L.sp.w);
		drawOverlay(L);
		if (L.index === 0 && !S.hist.length && S.place) { pushHist(S.place, 'start', 'abriu o app'); }
		applyWant(L);
		// The selected element is found again in the new document.
		if (S.sel && S.sel.live === L.index) { S.sel.el = findAgain(doc, S.sel); if (!S.sel.el) { S.sel = null; } }
		drawMarks(L);
		render();
	}

	/** Puts a runtime back at a place: the stack screen by screen, the modal over it and the screen state. */
	function replay(ctl, place) {
		const ids = new Set(ctl.screens());
		const stack = arr(place.stack).filter(id => ids.has(id));
		ctl.reset(stack[0]);
		stack.slice(1).forEach(id => ctl.go(id));
		if (place.modal && ids.has(place.modal)) { ctl.go(place.modal); }
		if (place.state && place.state !== 'normal') { ctl.setState(place.state); }
	}

	function liveChanged(L, info) {
		const place = { stack: arr(info.stack), modal: info.modal || null, state: info.state || 'normal' };
		if (L.index === 0 || S.fold === 'both') {
			const before = S.place;
			S.place = place;
			if (!L.restoring && ['go', 'tab', 'back', 'link'].includes(info.reason)) {
				const tap = L.lastTap && Date.now() - L.lastTap.at < 600 ? L.lastTap : null;
				const how = info.reason === 'back' ? (before?.modal && !place.modal ? 'fechou' : 'voltou')
					: info.reason === 'tab' ? `trocou para a aba ${titleOf(info.screen)}`
						: tap ? `tocou em ${tap.label}` : 'abriu';
				pushHist(place, info.reason, how);
				if (tap) { tap.result = info.reason === 'back' ? how : `abriu ${titleOf(info.screen)}`; }
			}
			// The page scrolls (not the screen), so a new screen starts at the top and coming back finds where it was.
			if (!L.restoring && L.doc) {
				const win = L.doc.defaultView;
				const prevId = before ? before.stack[before.stack.length - 1] : null;
				if (prevId) { L.scrollMemo[prevId] = win.scrollY; }
				if (['go', 'tab', 'link'].includes(info.reason) && !place.modal) { win.scrollTo(0, 0); }
				if (info.reason === 'back' && !before?.modal) { win.scrollTo(0, L.scrollMemo[info.base] || 0); }
			}
		}
		if (!L.restoring) {
			// The other device of a "side by side" pair follows.
			for (const other of E.lives) {
				if (other !== L && other.ctl) {
					other.restoring = true;
					replay(other.ctl, place);
					other.restoring = false;
					drawMarks(other);
				}
			}
		}
		if (L.doc) { L.tone = topTone(L.doc, L.sp.w); drawOverlay(L); }
		if (S.sel && S.sel.live === L.index && S.sel.el && !S.sel.el.isConnected) { S.sel = null; }
		drawMarks(L);
		if (!L.restoring) { render(); }
	}

	function pushHist(place, reason, how) {
		const screen = place.modal || place.stack[place.stack.length - 1];
		if (!screen) { return; }
		S.hist.push({ screen, place: { stack: [...place.stack], modal: place.modal, state: place.state }, how, at: Date.now() });
		if (S.hist.length > 60) { S.hist.shift(); }
	}

	const liveMain = () => E.lives[0] || null;
	const currentScreen = () => { const p = S.place; return p ? p.modal || p.stack[p.stack.length - 1] : null; };

	/** Shows a screen in the live preview the way the app would get there. */
	function navigateTo(id, state) {
		const L = liveMain();
		if (!L?.ctl || !screenOf(id)) { return false; }
		const place = S.place || { stack: [], modal: null };
		if (kindOf(id) === 'modal') {
			L.ctl.go(id);
		} else if (kindOf(id) === 'tab') {
			L.ctl.tab(id);
		} else if (place.stack.includes(id)) {
			replay(L.ctl, { stack: place.stack.slice(0, place.stack.indexOf(id) + 1), modal: null, state: 'normal' });
		} else {
			L.ctl.go(id);
		}
		if (state && state !== 'normal') { L.ctl.setState(state); }
		return true;
	}

	/** Follows what the agent pointed at (the screen, its state and a part) once the live frame is ready. */
	function applyWant(L) {
		if (!S.want || L.index !== 0 || !L.ctl) { return; }
		const want = S.want;
		S.want = null;
		if (want.screen && screenOf(want.screen) && currentScreen() !== want.screen) { navigateTo(want.screen); }
		if (want.state && STATES.includes(want.state) && want.state !== S.place?.state) { L.ctl.setState(want.state); }
		if (want.part) {
			S.flash = { screen: want.screen || currentScreen(), part: want.part, label: want.label || 'Aqui', until: Date.now() + 4500 };
			scrollToPart(L, want.part);
			setTimeout(() => E.lives.forEach(drawMarks), 4600);
		}
	}
	function partEl(L, part) {
		if (!L.doc || !part) { return null; }
		const id = currentScreen();
		const section = L.doc.querySelector(`.as-tela[data-screen="${CSS.escape(id || '')}"]`);
		return section?.querySelector(`[data-part="${CSS.escape(part)}"]`) || null;
	}
	function scrollToPart(L, part) {
		const el = partEl(L, part);
		if (!el) { return; }
		const win = L.doc.defaultView;
		const r = el.getBoundingClientRect();
		if (r.top < L.sp.top + 8 || r.bottom > L.sp.h - L.sp.bottom - 70) {
			win.scrollTo(0, Math.max(0, win.scrollY + r.top - L.sp.h * 0.3));
		}
	}

	/** Listens inside the app frame: edit-mode selection, taps in test mode, hovering, scrolling. */
	function hookDoc(L, doc) {
		const win = doc.defaultView;
		doc.addEventListener('click', event => {
			if (S.mode === 'edit') {
				event.preventDefault();
				event.stopImmediatePropagation();
				const el = pickable(event.target);
				if (el) { selectEl(L, el); }
				return;
			}
			const target = event.target.closest?.('[data-go],[data-back],[data-tab],[data-close],a[href],button,label,input');
			const label = target ? shortLabel(target) : 'a tela';
			let x = event.clientX, y = event.clientY;
			if (!x && !y && target) { const r = target.getBoundingClientRect(); x = r.left + r.width / 2; y = r.top + r.height / 2; }
			const tap = { at: Date.now(), x, y, label: quote(label), screen: currentScreen(), result: null };
			L.lastTap = tap;
			S.taps.push(tap);
			if (S.taps.length > 40) { S.taps.shift(); }
			if (S.showTaps && (S.view === 'test' || S.view === 'preview')) { drawTap(L, x, y); }
			setTimeout(() => {
				if (!tap.result) { tap.result = target && (target.matches('[data-go],[data-back],[data-tab],[data-close],a[href^="#/"]')) ? 'sem mudança' : 'nada acontece ainda'; }
				if (S.view === 'test') { render(); }
			}, 30);
		}, true);
		doc.addEventListener('mousemove', event => {
			if (S.mode !== 'edit') { return; }
			const el = pickable(event.target);
			if (el !== L.hover) { L.hover = el; drawMarks(L); }
		}, true);
		doc.addEventListener('mouseleave', () => { if (L.hover) { L.hover = null; drawMarks(L); } });
		win.addEventListener('scroll', () => drawMarks(L), true);
		doc.addEventListener('keydown', event => {
			if (event.key === 'Escape' && S.sel) { S.sel = null; E.lives.forEach(drawMarks); render(); }
		});
	}

	/** The element a click in edit mode means: a button, a link, a field, a title, a picture or a text. */
	function pickable(target) {
		if (!target || target.nodeType !== 1) { return null; }
		const el = target.closest('button,a,[data-go],[data-tab],[data-back],[data-close],input,select,textarea,label,img,h1,h2,h3,h4,h5,h6,p,li,dt,dd,small,b,strong,span,svg,.as-parte');
		if (!el) { return null; }
		if (el.tagName.toLowerCase() === 'svg' || el.closest('svg')) {
			return el.closest('button,a,[data-go],[data-tab]') || el.closest('svg');
		}
		const control = el.closest('button,a,[data-go],[data-tab],[data-back],[data-close],label');
		return control || el;
	}
	/** A short name for a touched element: its bold or title words, else its text cut to a few words. */
	function shortLabel(el) {
		const strong = el.querySelector?.('b, strong, h1, h2, h3, h4');
		const text = ((strong && strong.innerText.trim()) || describe(el).text || describe(el).type).replace(/\s+/g, ' ').trim();
		return text.length > 34 ? `${text.slice(0, 32).trim()}…` : text;
	}
	function describe(el) {
		const tag = el.tagName.toLowerCase();
		const text = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 60);
		let type = 'texto';
		if (el.classList.contains('as-aba')) { type = 'aba'; }
		else if (tag === 'button' || el.matches('[data-go],[data-tab],[data-back],[data-close]')) { type = 'botão'; }
		else if (tag === 'a') { type = 'link'; }
		else if (['input', 'select', 'textarea'].includes(tag)) { type = 'campo'; }
		else if (tag === 'label') { type = 'opção'; }
		else if (/^h[1-6]$/.test(tag)) { type = 'título'; }
		else if (tag === 'img' || tag === 'svg') { type = tag === 'svg' ? 'ícone' : 'imagem'; }
		else if (el.classList.contains('as-parte')) { type = 'parte'; }
		else if (tag === 'li') { type = 'item de lista'; }
		return { type, text };
	}
	function selectEl(L, el) {
		const d = describe(el);
		const section = el.closest('.as-tela');
		const part = el.closest('.as-parte')?.getAttribute('data-part') || null;
		const inTabs = !!el.closest('.as-abas');
		const scope = el.closest('.as-parte') || el.closest('.as-abas') || L.doc.body;
		const same = [...scope.querySelectorAll(el.tagName)];
		const win = L.doc.defaultView;
		const cs = win.getComputedStyle(el);
		const r = el.getBoundingClientRect();
		S.sel = {
			live: L.index, el, screen: section?.getAttribute('data-screen') || currentScreen(), part, inTabs, tag: el.tagName, index: same.indexOf(el),
			type: d.type, text: d.text, w: Math.round(r.width), h: Math.round(r.height), bg: cssHex(cs.backgroundColor), color: cssHex(cs.color),
			font: `${Math.round(parseFloat(cs.fontSize))} px${Number(cs.fontWeight) >= 600 ? ', negrito' : ''}`,
			go: el.getAttribute('data-go') || el.getAttribute('data-tab') || (el.hasAttribute('data-back') ? 'volta' : el.hasAttribute('data-close') ? 'fecha' : null),
		};
		E.lives.forEach(drawMarks);
		render();
	}
	function findAgain(doc, sel) {
		const scope = sel.inTabs ? doc.querySelector('.as-abas') : sel.part ? doc.querySelector(`.as-tela[data-screen="${CSS.escape(sel.screen || '')}"] [data-part="${CSS.escape(sel.part)}"]`) : null;
		if (!scope) { return null; }
		return scope.querySelectorAll(sel.tag)[sel.index] || null;
	}

	function drawTap(L, x, y) {
		const k = L.k;
		const off = liveOffset(L);
		const dot = document.createElement('i');
		dot.className = 'as-tap';
		dot.style.left = `${off.x + x * k}px`;
		dot.style.top = `${off.y + y * k}px`;
		L.marks.appendChild(dot);
		setTimeout(() => dot.remove(), 900);
	}
	/** Where the app screen's top-left corner is inside the live box (unscaled marks layer). */
	const liveOffset = L => ({ x: L.sp.bezel * L.k, y: L.sp.bezel * L.k });

	/** Outlines in the unscaled layer over the device: the part being built, the part pointed at, the selection, hover. */
	function drawMarks(L) {
		if (!L || !L.sp) { return; }
		const keep = [...L.marks.querySelectorAll('.as-tap')];
		const out = [];
		const k = L.k;
		const off = liveOffset(L);
		const box = (el, cls, tag) => {
			if (!el || !el.isConnected) { return; }
			const r = el.getBoundingClientRect();
			if (!r.width && !r.height) { return; }
			const x = clamp(r.left, -2, L.sp.w) * k + off.x, y = clamp(r.top, -2, L.sp.h) * k + off.y;
			const right = clamp(r.right, 0, L.sp.w + 2) * k + off.x, bottom = clamp(r.bottom, 0, L.sp.h + 2) * k + off.y;
			if (bottom - y < 2 || right - x < 2) { return; }
			const screenBottom = (L.sp.h - L.sp.bottom) * k + off.y;
			const up = cls === 'sel' ? y > off.y + 30 : bottom > screenBottom - 24;
			out.push(`<i class="as-box ${cls}" style="left:${x - 2}px;top:${y - 2}px;width:${right - x + 4}px;height:${bottom - y + 4}px">${tag ? `<b class="as-tag ${up ? 'up' : 'down'} ${cls === 'sel' ? 'l' : 'r'}">${tag}</b>` : ''}</i>`);
		};
		if (L.doc) {
			const b = building();
			if (b && b.part && buildFresh() && currentScreen() === b.screen) {
				box(partEl(L, b.part), 'build', `${esc(ACTIONS[b.action] && b.action !== 'write' ? ACTIONS[b.action] : 'JumpCode')} · ${esc(partName(b.screen, b.part))}`);
			}
			if (S.flash && S.flash.until > Date.now() && currentScreen() === S.flash.screen) {
				box(partEl(L, S.flash.part), 'flash', esc(`${S.flash.label} · ${partName(S.flash.screen, S.flash.part)}`));
			}
			if (S.mode === 'edit' && L.hover && (!S.sel || S.sel.el !== L.hover)) { box(L.hover, 'hover', ''); }
			if (S.sel && S.sel.live === L.index && S.sel.el) {
				box(S.sel.el, 'sel', esc(`${S.sel.type[0].toUpperCase()}${S.sel.type.slice(1)}${S.sel.part ? ` · ${S.sel.part}` : S.sel.inTabs ? ' · barra de abas' : ''}`));
			}
		}
		L.marks.innerHTML = out.join('');
		keep.forEach(t => L.marks.appendChild(t));
	}

	/** Places the live devices in the stage: scale to fit (or the chosen zoom), side by side, centred. */
	function layoutStage(stage) {
		const vp = stage.querySelector('.as-vp');
		const row = stage.querySelector('.as-row');
		if (!vp || !row || !E.lives.length) { return; }
		const both = E.lives.length > 1;
		const annot = !S.frame && !both;
		const gap = both ? 70 : 0;
		const capH = both ? 44 : 0;
		const totalW = E.lives.reduce((a, L) => a + L.sp.W, 0);
		const totalH = Math.max(...E.lives.map(L => L.sp.H));
		const tools = S.view === 'test' ? 0 : 1;
		const fitWith = (padX, padTop, padBottom) => clamp(Math.min((vp.clientWidth - padX * 2 - gap) / totalW, (vp.clientHeight - padTop - padBottom - capH) / totalH), 0.15, 1.5);
		let padX = annot ? 150 : 24, padTop = annot ? 30 : 14, padBottom = annot ? 18 : 14;
		let fit = fitWith(padX, padTop, padBottom);
		// A wide device would run under the Usar/Editar buttons or the caption: then it leaves their rows free.
		if (totalW * fit + gap > vp.clientWidth - 2 * (tools ? 170 : 150)) {
			padTop = Math.max(padTop, tools ? 44 : 14);
			padBottom = Math.max(padBottom, 38);
			fit = fitWith(padX, padTop, padBottom);
		}
		const k = S.zoom === 'fit' ? Math.min(fit, 1) : Number(S.zoom);
		row.style.gap = `${gap}px`;
		row.style.padding = `${padTop}px ${padX}px ${padBottom}px`;
		for (const L of E.lives) {
			L.k = k;
			L.dev.style.transform = `scale(${k})`;
			L.box.style.width = `${Math.round(L.sp.W * k)}px`;
			L.box.style.height = `${Math.round(L.sp.H * k)}px`;
			L.box.style.marginBottom = `${capH}px`;
			L.cap.innerHTML = both ? `<b>${L.sp.fold === 'open' ? 'Aberto · tela de dentro' : 'Fechado · tela de fora'}</b><span>${sizeText(L.sp)}</span>` : '';
			L.box.classList.toggle('annot', annot);
			annotate(L, annot);
			drawMarks(L);
		}
		row.classList.toggle('both', both);
		const arrow = row.querySelector('.as-open-arrow');
		if (both && !arrow) {
			const a = document.createElement('div');
			a.className = 'as-open-arrow';
			a.innerHTML = '<span>abrir</span><i></i>';
			row.insertBefore(a, E.lives[1].box);
		} else if (!both && arrow) {
			arrow.remove();
		}
		const a = row.querySelector('.as-open-arrow');
		if (a) { a.style.marginLeft = `-${gap}px`; a.style.setProperty('--g', `${gap}px`); }
		const cap = stage.querySelector('[data-r="cap"]');
		if (cap) {
			const L = E.lives[0];
			const name = both ? `${DEVICES[S.device].label} · fechado e aberto` : S.frame ? L.sp.name : `Sem moldura · ${L.sp.name}`;
			patch(cap, `<span class="as-cap">${esc(S.view === 'test' ? `${S.mode === 'edit' ? 'Editar' : 'Usar'} · ` : '')}${esc(name)} · ${both ? '' : `${sizeText(L.sp)} · `}${nf(k * 100)}%</span>`);
		}
	}
	/** Without the frame: the width and height and the safe areas, outside the screen. */
	function annotate(L, on) {
		let a = L.box.querySelector('.as-annot');
		if (!on) { a?.remove(); return; }
		if (!a) { a = document.createElement('div'); a.className = 'as-annot'; L.box.appendChild(a); }
		const k = L.k, sp = L.sp;
		const W = sp.w * k, H = sp.h * k;
		a.innerHTML = `<div class="rw" style="width:${W}px"><span>${sp.w}</span></div><div class="rh" style="height:${H}px;left:${W + 14}px"><span>${sp.h}</span></div>`
			+ `<i class="safe" style="top:${sp.top * k}px;width:${W}px"></i><i class="safe" style="top:${H - sp.bottom * k}px;width:${W}px"></i>`
			+ `<span class="sl" style="top:${sp.top * k - 21}px">área segura · ${sp.top}</span><span class="sl" style="top:${H - sp.bottom * k - 21}px">área segura · ${sp.bottom}</span>`;
	}

	// ------------------------------------------------------------------ measured problems (touch targets, cut text)

	function measure() {
		if (!RT || !hasApp() || !S.app?.preview) { return; }
		const sp = spec(S.device, S.fold === 'both' ? 'closed' : S.fold, S.landscape, true);
		const key = `${revKey()}|${sp.key}`;
		if (S.measuring === key || S.measured?.key === key) { return; }
		S.measuring = key;
		if (!E.measure) {
			E.measure = document.createElement('div');
			E.measure.className = 'as-measure';
			E.measure.setAttribute('aria-hidden', 'true');
			document.body.appendChild(E.measure);
		}
		E.measure.innerHTML = '';
		const frame = document.createElement('iframe');
		frame.setAttribute('tabindex', '-1');
		frame.style.width = `${sp.w}px`;
		frame.style.height = `${sp.h}px`;
		frame.addEventListener('load', () => {
			const doc = frame.contentDocument;
			if (S.measuring !== key || !doc || !doc.querySelector('.as-app')) { return; }
			prepareDoc(doc, sp);
			let list = [];
			try { list = measureDoc(doc, sp); } catch { list = []; }
			S.measured = { key, rev: revKey(), list, device: sp.name, width: sp.w };
			S.measuring = null;
			E.measure.innerHTML = '';
			render();
		});
		frame.srcdoc = S.app.preview;
		E.measure.appendChild(frame);
	}

	function measureDoc(doc, sp) {
		const ctl = RT.start(doc, { interactive: false });
		if (!ctl) { return []; }
		const win = doc.defaultView;
		const found = [];
		const touch = new Map();
		const cut = new Map();
		const seen = new Set();
		const visible = el => el.getClientRects().length > 0 && win.getComputedStyle(el).visibility !== 'hidden';
		const directText = el => [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
		for (const id of ctl.screens()) {
			const base = kindOf(id) === 'modal' ? opener(id) : id;
			ctl.reset(base);
			if (base !== id) { ctl.go(id); }
			const section = doc.querySelector(`.as-tela[data-screen="${CSS.escape(id)}"]`);
			if (!section) { continue; }
			const scopes = [section];
			const nav = doc.querySelector('.as-abas');
			if (nav && !nav.hidden && !seen.has('as-abas')) { seen.add('as-abas'); scopes.push(nav); }
			for (const scope of scopes) {
				const partOf = el => scope === nav ? null : el.closest('.as-parte')?.getAttribute('data-part') || null;
				for (const el of scope.querySelectorAll('button,a[href],[data-go],[data-tab],[data-back],[data-close],input:not([type="hidden"]),select,textarea')) {
					if (!visible(el) || el.closest('.as-planejada') || (el.parentElement?.closest('[data-go],[data-tab],[data-back],[data-close],button,a') && el.parentElement.closest('[data-go],[data-tab],[data-back],[data-close],button,a') !== el)) { continue; }
					if (el.tagName === 'A' && el.parentElement && directText(el.parentElement) && /^(p|span|small|li)$/i.test(el.parentElement.tagName)) { continue; }
					const target = el.closest('label') || el;
					const r = target.getBoundingClientRect();
					if (r.width >= 43.5 && r.height >= 43.5) { continue; }
					const key = `${id}|${partOf(el) || ''}`;
					if (!touch.has(key)) { touch.set(key, { screen: scope === nav ? null : id, part: partOf(el), items: [], nav: scope === nav }); }
					const d = describe(el);
					const name = d.text || d.type;
					if (!touch.get(key).items.some(i => i.name === name)) { touch.get(key).items.push({ name, w: Math.round(r.width), h: Math.round(r.height) }); }
				}
				for (const el of scope.querySelectorAll('*')) {
					if (!directText(el) || !visible(el) || el.closest('.as-planejada')) { continue; }
					const cs = win.getComputedStyle(el);
					const clipped = (cs.overflowX !== 'visible' || cs.textOverflow === 'ellipsis') && el.scrollWidth > el.clientWidth + 1;
					const r = el.getBoundingClientRect();
					const outside = r.right > sp.w + 1 && cs.position !== 'fixed';
					if (!clipped && !outside) { continue; }
					const key = `${id}|${partOf(el) || ''}`;
					if (!cut.has(key)) { cut.set(key, { screen: scope === nav ? null : id, part: partOf(el), items: [] }); }
					const text = el.textContent.replace(/\s+/g, ' ').trim();
					if (text && !cut.get(key).items.includes(text)) { cut.get(key).items.push(text); }
				}
			}
		}
		const sizeOf = i => i.w < 43.5 && i.h < 43.5 ? `${i.w} × ${i.h}` : i.h < 43.5 ? `${i.h} de altura` : `${i.w} de largura`;
		for (const [key, t] of touch) {
			// Up to three by name; more than that are counted ("A, B, C e mais 4").
			const list = items => t.items.length > 3 ? `${items.slice(0, 3).join(', ')} e mais ${t.items.length - 3}` : joinPt(items);
			const names = list(t.items.map(i => quote(i.name)));
			const where = t.nav ? 'Na barra de abas' : `Na tela ${titleOf(t.screen)}${t.part ? `, parte ${t.part}` : ''}`;
			found.push({
				id: `touch-${key}`, kind: 'touch', group: 'a11y', measured: true, screen: t.screen, part: t.part,
				text: `${list(t.items.map(i => `${quote(i.name)} (${sizeOf(i)})`))} ${t.items.length === 1 ? 'fica' : 'ficam'} abaixo de 44 × 44, o mínimo para o dedo.`,
				fix: `aumente ${names} para pelo menos 44 × 44 de área de toque.`,
				ask: `${where}: aumente ${names} para pelo menos 44 × 44 de área de toque.`,
				mark: t.items[0] ? `text:${t.items[0].name}` : null,
			});
		}
		for (const [key, c] of cut) {
			const first = c.items[0].length > 48 ? `${c.items[0].slice(0, 46)}…` : c.items[0];
			found.push({
				id: `overflow-${key}`, kind: 'overflow', group: 'layout', measured: true, screen: c.screen, part: c.part,
				text: `No ${sp.name} (${sp.w} de largura), ${c.items.length > 1 ? `${quote(first)} e mais ${c.items.length - 1} não cabem e ficam cortados.` : `${quote(first)} não cabe e fica cortado.`}`,
				fix: `faça o texto caber em ${sp.w} de largura, sem cortar.`,
				ask: `Na tela ${titleOf(c.screen)}${c.part ? `, parte ${c.part}` : ''}: faça ${quote(first)} caber em ${sp.w} de largura, sem cortar o texto.`,
				mark: `text:${c.items[0]}`,
			});
		}
		ctl.dispose();
		return found;
	}

	// ------------------------------------------------------------------ rendering machinery

	/** Replaces an element's content only when its HTML changed (iframes inside survive otherwise). */
	function patch(el, html) {
		if (!el || el.__html === html) { return false; }
		el.innerHTML = html;
		el.__html = html;
		mountSnaps(el);
		return true;
	}
	/** Keyed children: unchanged items stay (with their frames); changed ones are replaced in place. */
	function patchKeyed(el, items) {
		if (!el) { return; }
		el.__html = null;
		const existing = new Map([...el.children].filter(c => c.__k !== undefined).map(c => [c.__k, c]));
		const tpl = document.createElement('template');
		let prev = null;
		const keep = new Set();
		for (const item of items) {
			let node = existing.get(item.key);
			if (!node || node.__src !== item.html) {
				tpl.innerHTML = item.html;
				const fresh = tpl.content.firstElementChild;
				fresh.__k = item.key;
				fresh.__src = item.html;
				if (node) { node.replaceWith(fresh); }
				node = fresh;
			}
			keep.add(node);
			const want = prev ? prev.nextSibling : el.firstChild;
			if (node !== want) { el.insertBefore(node, want); }
			prev = node;
		}
		for (const child of [...el.children]) {
			if (!keep.has(child)) { child.remove(); }
		}
		mountSnaps(el);
	}

	function render() {
		if (render.queued) { return; }
		render.queued = true;
		requestAnimationFrame(() => {
			render.queued = false;
			draw();
		});
	}

	function shell() {
		if (E.root) { return; }
		E.root = document.createElement('div');
		E.root.id = 'as-root';
		E.root.innerHTML = '<div class="as-studio"><div class="as-bar"></div><div class="as-sub"></div><div class="as-body"></div><div class="as-foot"></div><div class="as-layer"></div></div>';
		document.body.appendChild(E.root);
		E.studio = E.root.firstChild;
		E.bar = E.root.querySelector('.as-bar');
		E.sub = E.root.querySelector('.as-sub');
		E.body = E.root.querySelector('.as-body');
		E.foot = E.root.querySelector('.as-foot');
		E.layer = E.root.querySelector('.as-layer');
	}

	function draw() {
		shell();
		E.studio.classList.toggle('compact', window.innerHeight < 800);
		E.studio.classList.toggle('narrow', window.innerWidth < 1100);
		const scrolls = {};
		E.body.querySelectorAll('[data-scroll]').forEach(el => { scrolls[el.dataset.scroll] = [el.scrollTop, el.scrollLeft]; });
		patch(E.bar, toolbar());
		compactBar(E.bar, ['c1', 'c2', 'c3', 'c4']);
		const view = viewModel();
		patch(E.sub, view.sub || '');
		compactBar(E.sub, ['c1', 'c2', 'c3', 'c4']);
		E.sub.classList.toggle('none', !view.sub);
		if (E.body.__key !== view.key) {
			disposeLives();
			E.body.__key = view.key;
			E.body.innerHTML = view.skeleton;
			E.body.__html = null;
		}
		for (const [name, content] of Object.entries(view.regions)) {
			const el = E.body.querySelector(`[data-region="${name}"]`);
			if (!el) { continue; }
			if (typeof content === 'function') { content(el); } else if (Array.isArray(content)) { patchKeyed(el, content); } else { patch(el, content); }
		}
		E.body.querySelectorAll('[data-scroll]').forEach(el => {
			const s = scrolls[el.dataset.scroll];
			if (s) { el.scrollTop = s[0]; el.scrollLeft = s[1]; }
		});
		decorate();
		patch(E.foot, footer());
		patch(E.layer, layer());
		placeMenu();
		if (hasApp()) { measure(); }
	}

	/** A bar that does not fit drops its less important words in steps. */
	function compactBar(bar, levels) {
		if (!bar) { return; }
		levels.forEach(l => bar.classList.remove(l));
		bar.classList.add('meas');
		const over = () => bar.scrollWidth > bar.clientWidth + 1;
		for (const level of levels) {
			if (over()) { bar.classList.add(level); }
		}
		bar.classList.remove('meas');
	}

	/** Selection state that must not rebuild frames: the current screen in the strip and grid, the map path. */
	function decorate() {
		const cur = currentScreen();
		E.body.querySelectorAll('[data-pick-screen]').forEach(el => el.classList.toggle('sel', el.getAttribute('data-pick-screen') === (S.view === 'map' ? S.mapPick : cur)));
		if (S.view === 'map') { decorateMap(); }
	}

	// ------------------------------------------------------------------ toolbar, footer, layer

	function toolbar() {
		const on = VIEW_BUTTON[S.view] || 'preview';
		const none = !hasApp();
		const buttons = Object.entries(VIEWS).map(([id, v]) => `<button class="as-vb ${on === id ? 'on' : ''} ${none && id !== 'preview' ? 'dis' : ''}" data-act="view" data-view="${id}" title="${v.label}">${ic(v.icon)}<span class="t">${v.label}</span></button>`).join('');
		const count = problems().length;
		const more = `<button class="as-vb more ${on === 'more' ? 'on' : ''} ${S.menu === 'more' ? 'open' : ''}" data-act="menu" data-menu="more" title="Mais"><span class="t">Mais</span>${count ? `<span class="as-count">${nf(count)}</span>` : ''}${ic('chevD', 'sm')}</button>`;
		const a = app();
		const name = str(a?.name) || projectName() || 'AppStudio';
		const chip = !a || !hasApp() ? 'sem telas ainda' : buildFresh(30) && agentBusy() ? 'construindo' : plural(screens().length, 'tela', 'telas');
		const crumb = `<span class="as-crumb" title="${esc(name)}">${MARK}<b>${esc(name)}</b><span class="v">${esc(chip)}</span></span>`;
		const stat = (icon, cls, text) => `<span class="as-stat">${ic(icon, cls)}<span class="t">${text}</span></span>`;
		let status;
		const b = building();
		if (agentBusy() && b && buildFresh(40)) {
			const what = b.action && b.action !== 'write' ? ACTIONS[b.action] || 'Trabalhando' : 'Escrevendo';
			const onScreen = !b.action || ['write', 'screen', 'remove'].includes(b.action);
			const where = !onScreen ? '' : b.part ? `${titleOf(b.screen)} · ${partName(b.screen, b.part)}` : b.screen ? titleOf(b.screen) : '';
			status = stat('spinner', 'spin c-run', `${esc(what)}${where ? ` ${esc(where)}` : ''}`);
		} else if (S.running) {
			status = stat('spinner', 'spin c-run', 'Agente trabalhando');
		} else if (S.pending) {
			status = stat('spinner', 'spin c-run', 'Pedido enviado');
		} else if (hasApp()) {
			status = stat('dot', 'c-ok sm', `Salvo · versão ${nf(versionNow())}`);
		} else {
			status = stat('dot', 'c-dim sm', 'Esperando o primeiro pedido');
		}
		const action = S.running ? btn('Parar', ['stop', 'c-bad'], 'as-bar-act', 'data-act="stop" title="Parar o agente"') : '';
		return `<div class="as-bar-in">${buttons}${more}<span class="as-sep"></span>${crumb}<span class="as-sp"></span>${status}${action}</div>`;
	}

	function footer() {
		const asks = `<span>${ic('comments')}botões pedem ao agente</span>`;
		const computer = `<span class="opt">${ic('chip')}neste computador</span>`;
		const index = arr(app()?.files).find(f => /index\.html$/.test(f?.path || ''));
		const where = `<span class="f">${ic('folder')}<span class="t">${esc(projectName())}/${esc(folder())}${index ? ` · index.html ${bytes(index.bytes)}` : ''}</span></span>`;
		let what;
		if (!hasApp()) {
			what = '<span>nenhuma tela ainda</span>';
		} else {
			const n = screens().length;
			what = `<span>${plural(n, 'tela', 'telas')} · versão ${nf(versionNow())}${S.view === 'problems' ? ` · ${plural(problems().length, 'problema', 'problemas')}` : ''}</span>`;
		}
		return `<div class="as-foot-in">${where}${what}${computer}${asks}</div>`;
	}

	function layer() {
		const parts = [];
		if (S.menu === 'more') {
			const count = problems().length;
			const items = Object.entries(MORE).map(([id, m]) => {
				const right = id === 'problems' && count ? `<span class="as-count">${nf(count)}</span>` : id === 'versions' && versions().length ? `<em>${nf(versions().length)}</em>` : '';
				return `<button class="as-mi ${S.view === id ? 'on' : ''} ${!hasApp() && id !== 'settings' ? 'dis' : ''}" data-act="view" data-view="${id}">${ic(m.icon)}<span class="t">${m.label}</span>${right}</button>`;
			}).join('');
			parts.push(`<div class="as-menu" data-menu-box="more">${items}</div>`);
		}
		if (S.note) {
			parts.push(`<div class="as-toast">${ic(S.noteKind === 'warning' ? 'warning' : 'info', S.noteKind === 'warning' ? 'c-you' : 'c-run')}<span>${esc(S.note)}</span></div>`);
		}
		return parts.join('');
	}
	function placeMenu() {
		const menu = E.layer.querySelector('.as-menu');
		const button = E.bar.querySelector('[data-act="menu"]');
		if (!menu || !button) { return; }
		const r = button.getBoundingClientRect();
		const root = E.studio.getBoundingClientRect();
		menu.style.left = `${Math.min(r.left - root.left, root.width - menu.offsetWidth - 8)}px`;
		menu.style.top = `${r.bottom - root.top + 3}px`;
	}

	// ------------------------------------------------------------------ views

	function viewModel() {
		if (!S.st && !S.app) {
			return { key: 'wait', skeleton: '<div class="as-empty"><div class="as-dim">Abrindo o AppStudio…</div></div>', regions: {} };
		}
		if (!RT) {
			return { key: 'nort', skeleton: `<div class="as-empty"><div>${ic('warning', 'c-you')}<b>A prévia não pôde começar</b><span>O arquivo runtime.js do AppStudio não veio junto com a interface. Feche e abra o Studio de novo.</span></div></div>`, regions: {} };
		}
		if (!hasApp() && S.view !== 'settings') {
			return { key: 'start', skeleton: '<div class="as-start" data-region="start" data-scroll="start"></div>', regions: { start: startView() } };
		}
		switch (S.view) {
			case 'screens': return screensView();
			case 'map': return mapView();
			case 'structure': return structureView();
			case 'states': return statesView();
			case 'problems': return problemsView();
			case 'versions': return versionsView();
			case 'publish': return publishView();
			case 'settings': return settingsView();
			default: return deviceView();
		}
	}

	// ---------------------------------------------------- start (no app yet)

	function startView() {
		const pick = TEMPLATES.find(t => t[0] === S.startPick) || TEMPLATES[0];
		const rows = TEMPLATES.map(([id, label, sub]) => `<div class="as-li two click ${S.startPick === id ? 'sel' : ''}" data-act="start-pick" data-id="${id}">${ic(S.startPick === id ? 'dot' : 'ring', S.startPick === id ? '' : 'c-dim')}<span class="tx"><b>${esc(label)}</b><small>${esc(sub)}</small></span></div>`).join('');
		const begin = panel('Ponto de partida', rows, { icon: 'layers', pb: 'np', foot: `<span class="as-dim">O agente escreve as telas em HTML e CSS; você acompanha aqui.</span>${btn('Começar', 'play', 'primary', 'data-act="start-go"')}` });
		const samples = panel('Experimente pedir', SAMPLES.map(t => li(ic('comments', 'c-dim'), esc(quote(t)), '', 'click', `data-act="sample" data-text="${esc(t)}"`)).join(''), { icon: 'comments', pb: 'np' });
		const devices = panel('Aparelhos da prévia', DEVICE_IDS.map(id => {
			const d = DEVICES[id];
			const size = d.open ? `aberto ${d.open[0]} × ${d.open[1]} · fechado ${d.closed[0]} × ${d.closed[1]}` : id === 'tablet' ? `${d.size[0]} × ${d.size[1]} · deitado ${d.size[1]} × ${d.size[0]}` : `${d.size[0]} × ${d.size[1]}`;
			return li(ic(d.icon), esc(d.label), esc(size), `click ${S.device === id ? 'sel' : ''}`, `data-act="device" data-device="${id}"`);
		}).join(''), { icon: 'phone', pb: 'np', right: `${nf(DEVICE_IDS.length)} aparelhos` });
		const frames = panel('Moldura', `<div class="as-choice">${[[true, 'Com moldura', 'o celular inteiro, com câmera e cantos'], [false, 'Sem moldura', 'só a tela, com as medidas']].map(([v, t, s]) => `<div class="as-li two click ${S.frame === v ? 'sel' : ''}" data-act="frame" data-on="${v ? 1 : 0}">${ic(S.frame === v ? 'dot' : 'ring', S.frame === v ? '' : 'c-dim')}<span class="tx"><b>${t}</b><small>${s}</small></span></div>`).join('')}</div>`, { icon: 'box', pb: 'np' });
		const how = panel('Como funciona', [
			['Você pede na conversa', 'uma tela, uma mudança, um teste'],
			['O agente escreve as telas, parte por parte', `em ${folder()}/appstudio.json`],
			['A tela aparece aqui enquanto ele escreve', 'o que falta fica em cinza'],
			['Você toca e testa como no celular', 'modo Usar'],
			['O mapa mostra o que leva a cada tela', 'e as telas sem saída'],
		].map(([a, b], i) => li(`<span class="as-num">${i + 1}</span>`, esc(a), esc(b))).join(''), { icon: 'list', pb: 'np' });
		const hero = `<div class="as-hero">${MARK}<div><h1>Apps de celular neste computador</h1><p>O AppStudio monta apps para iPhone e Android a partir da conversa: você pede, o agente escreve as telas e o app aparece aqui, num celular, enquanto é feito. O app fica na pasta ${mono(`${folder()}/`)} do projeto e abre em qualquer navegador.</p></div></div>`;
		const local = `<div class="as-panel"><div class="as-pb">${note('lock', 'c-dim', `<b>Neste computador.</b> Nada vai para a internet; publicar como app instalável só quando você pedir. Pedido escolhido: ${esc(pick[1])}.`)}</div></div>`;
		return `${hero}<div class="as-start-cols"><div class="as-col">${begin}${samples}${local}</div><div class="as-col">${devices}${frames}${how}</div></div>`;
	}

	// ---------------------------------------------------- preview and test (the live device)

	function deviceSeg() {
		const list = enabledDevices();
		const buttons = list.map(id => `<button class="as-btn ${S.device === id ? 'on' : ''}" data-act="device" data-device="${id}" title="${esc(DEVICES[id].label)}">${ic(DEVICES[id].icon)}<span class="t">${esc(DEVICES[id].label)}</span></button>`);
		const sel = select(list.map(id => [id, DEVICES[id].label]), S.device, 'data-set="device" title="Aparelho"', 'devsel');
		return `<span class="as-devseg">${seg(buttons)}</span>${sel}`;
	}
	function routePill() {
		const id = currentScreen();
		const route = str(screenOf(id)?.route) || '/';
		return `<span class="as-route" title="Rota da tela na prévia">${ic('phone', 'sm')}<span class="p">${esc(projectName())}</span><span class="d">·</span><span class="r">${esc(route)}</span><span class="l"><span class="d">·</span>prévia local</span><span class="live">${ic('dot', 'c-ok sm')}Ao vivo</span></span>`;
	}
	function zoomSelect() {
		return `<label class="as-zoom" title="Tamanho da prévia">${ic('zoom')}${select(ZOOMS, S.zoom, 'data-set="zoom"')}</label>`;
	}

	function deviceView() {
		const test = S.view === 'test';
		const fold = DEVICES[S.device].open;
		let sub;
		if (test) {
			sub = `<div class="as-sub-in">${seg([btn('Usar', 'tap', S.mode === 'use' ? 'on' : '', 'data-act="mode" data-mode="use"'), btn('Editar', 'pointer', S.mode === 'edit' ? 'on' : '', 'data-act="mode" data-mode="edit"')])}<span class="as-sep"></span>`
				+ `${btn('Voltar', 'back', '', `data-act="back" ${S.place && (S.place.modal || S.place.stack.length > 1) ? '' : 'disabled'}`)}${btn('Reiniciar o app', 'refresh', '', 'data-act="restart"')}${btn('Estados', 'layers', 'opt2', 'data-act="view" data-view="states"')}<span class="as-sep"></span>`
				+ `${select(enabledDevices().map(id => [id, DEVICES[id].label]), S.device, 'data-set="device" title="Aparelho"')}${check('Moldura', S.frame, 'data-set="frame"', 'Moldura do aparelho')}${check('Mostrar toques', S.showTaps, 'data-set="taps"')}<span class="as-sp"></span>${routePill()}</div>`;
		} else {
			const foldSeg = fold ? seg([['closed', 'Fechado'], ['open', 'Aberto'], ['both', 'Os dois']].map(([v, l]) => btn(l, '', S.fold === v ? 'on' : '', `data-act="fold" data-fold="${v}"`))) : '';
			sub = `<div class="as-sub-in">${deviceSeg()}${fold ? `<span class="as-sep"></span>${foldSeg}` : ''}<span class="as-sep"></span>${check('Moldura', S.frame, 'data-set="frame"', 'Moldura do aparelho')}${btn('', 'rotate', S.landscape ? 'on ib' : 'ib', `data-act="rotate" title="${S.landscape ? 'Pôr em pé' : 'Deitar'}"`)}${zoomSelect()}<span class="as-sp"></span>${routePill()}</div>`;
		}
		return {
			key: 'device',
			sub,
			skeleton: '<div class="as-cols"><div class="as-stage" data-region="stage"></div><div class="as-side" data-region="side" data-scroll="side"></div></div><div class="as-strip" data-region="strip"></div>',
			regions: { stage: stageRegion, side: test ? testSide() : previewSide(), strip: test ? [] : stripItems() },
		};
	}

	function stageRegion(el) {
		if (!el.__init) {
			el.__init = true;
			el.innerHTML = '<div class="as-vp" data-scroll="stage"><div class="as-row"></div></div><div class="as-stage-tools" data-r="tools"></div><div class="as-stage-cap" data-r="cap"></div>';
			if (typeof ResizeObserver === 'function') {
				E.observer?.disconnect();
				E.observer = new ResizeObserver(() => layoutStage(el));
				E.observer.observe(el.querySelector('.as-vp'));
			}
		}
		E.studio.classList.toggle('test', S.view === 'test');
		patch(el.querySelector('[data-r="tools"]'), S.view === 'test' ? '' : seg([btn('Usar', 'tap', S.mode === 'use' ? 'on' : '', 'data-act="mode" data-mode="use" title="Tocar no app como no celular"'), btn('Editar', 'pointer', S.mode === 'edit' ? 'on' : '', 'data-act="mode" data-mode="edit" title="Clicar num elemento para pedir uma mudança"')]));
		const specs = liveSpecs();
		const row = el.querySelector('.as-row');
		while (E.lives.length > specs.length) { const L = E.lives.pop(); try { L.ctl?.dispose(); } catch { /* gone */ } L.box.remove(); }
		while (E.lives.length < specs.length) { E.lives.push(makeLive(row, E.lives.length)); }
		E.lives.forEach((L, i) => {
			liveSetSpec(L, specs[i]);
			if (S.app?.preview) { liveLoad(L, S.app.preview, revKey()); }
			L.doc?.documentElement.classList.toggle('as-editar', S.mode === 'edit');
		});
		layoutStage(el);
	}

	function stripItems() {
		const sp = spec(S.device, S.fold === 'both' ? 'closed' : S.fold, false, true);
		const n = screens().length;
		const narrow = window.innerWidth < 1100;
		const room = window.innerWidth - 20 - 26 - 54 - (narrow ? 88 : 112) - (narrow ? 0 : 150);
		let thumbH = E.studio.classList.contains('compact') ? 66 : 80;
		// Cards are as wide as the room allows (names stay whole), never narrower than 66.
		const minCard = clamp(Math.floor(room / Math.max(n, 1)) - 8, 66, 92);
		const cardW = h => Math.max(h * sp.W / sp.H + 6, minCard) + 8;
		while (thumbH > 50 && n * cardW(thumbH) > room) { thumbH -= 2; }
		const k = thumbH / sp.H;
		const width = Math.round(cardW(thumbH) - 8);
		const items = [{ key: 'label', html: `<div class="as-strip-label"><b>Telas</b><span>${nf(screens().length)}</span></div>` }];
		for (const id of pathOrder()) {
			const s = screenOf(id);
			items.push({ key: `t:${id}`, html: `<div class="as-tcard" style="width:${width}px" data-act="pick-screen" data-id="${esc(id)}" data-pick-screen="${esc(id)}" title="${esc(`${titleOf(id)} · ${s.route || ''}`)}">${snapHtml(id, sp, k)}<span class="nm">${s.login ? ic('lock', 'sm') : ''}<span class="t">${esc(titleOf(id))}</span></span></div>` });
		}
		items.push({ key: 'new', html: `<div class="as-tcard new" data-act="new-screen" title="Pedir uma tela nova na conversa"><span class="plus">${ic('plus')}<b>Nova tela</b><small>pede ao agente</small></span></div>` });
		const nTabs = tabs().length, nLogin = screens().filter(s => s.login).length;
		items.push({ key: 'info', html: `<div class="as-strip-info"><span>${plural(nTabs, 'aba', 'abas')} · ${nf(nLogin)} ${nLogin === 1 ? 'pede' : 'pedem'} login</span><span>clique para abrir na prévia</span></div>` });
		return items;
	}

	function screenFacts(id, opts = {}) {
		const s = screenOf(id);
		if (!s) { return ''; }
		const tabIndex = tabs().findIndex(t => t.screen === id);
		const kind = s.kind === 'tab' && tabIndex >= 0 ? `aba ${tabIndex + 1} de ${tabs().length}` : KIND_LABELS[s.kind] || 'pilha';
		const outs = [...new Set(edges().filter(e => e.from === id && e.to && screenOf(e.to) && e.to !== id).map(e => titleOf(e.to)))];
		const ins_ = [...new Set(edges().filter(e => e.to === id && e.from !== id).map(e => titleOf(e.from)))];
		const backs = edges().filter(e => e.from === id && (e.how === 'back' || e.how === 'close')).length;
		const pairs = [
			['Tela', esc(titleOf(id)), `${titleOf(id)} · ${id}`],
			['Rota', mono(s.route || '/')],
			['Tipo', esc(kind)],
			['Pede login', s.login ? 'sim' : 'não'],
			['Leva para', outs.length ? esc(joinPt(outs)) : backs ? 'só volta' : dim('nenhuma tela'), joinPt(outs)],
		];
		if (opts.from) { pairs.push(['Vem de', ins_.length ? esc(joinPt(ins_)) : dim(s.kind === 'tab' ? 'barra de abas' : 'nenhuma tela'), joinPt(ins_)]); }
		pairs.push(['Arquivo', mono('appstudio.json'), `${folder()}/appstudio.json · tela ${id}`]);
		return kv(pairs);
	}

	function statesSeg(id, cls = '') {
		const s = screenOf(id);
		const defined = arr(s?.states).length ? arr(s.states) : ['normal'];
		const cur = S.place?.state || 'normal';
		return `<div class="as-states-seg ${cls}">${STATES.map(name => `<button class="as-btn sm ${cur === name ? 'on' : ''} ${defined.includes(name) ? '' : 'undef'}" data-act="set-state" data-state="${name}" title="${defined.includes(name) ? `Ver o estado ${STATE_LABELS[name].toLowerCase()}` : 'Esta tela não define este estado'}">${STATE_LABELS[name]}</button>`).join('')}</div>`;
	}

	function buildPanel() {
		const b = building();
		if (!b || !(agentBusy() || buildFresh(30)) || !screenOf(b.screen)) { return ''; }
		const order = S.docs?.order.get(b.screen) || [];
		const total = order.length;
		const done = order.filter(p => !p.planned).length;
		const rows = order.map(p => {
			const now = p.id === b.part;
			const icon = p.planned ? ic('ring', 'c-dim') : now && agentBusy() ? ic('spinner', 'spin c-run') : ic('passed', 'c-ok');
			const right = p.planned ? 'planejada' : now ? (agentBusy() ? 'escrevendo' : 'acabou de entrar') : `${bytes(arr(screenOf(b.screen).parts).find(x => x.id === p.id)?.bytes)}`;
			return li(icon, `<span class="${p.planned ? 'as-dim' : ''}">${esc(partName(b.screen, p.id))}</span>`, esc(right), now ? 'cur' : '');
		}).join('') || li(ic('spinner', 'spin c-run'), `${esc(ACTIONS[b.action] || 'Trabalhando')}`, '');
		const bar = total ? `<div class="as-pr"><i style="width:${Math.round(done / total * 100)}%"></i></div><div class="as-prtext"><span>${nf(done)} de ${plural(total, 'parte', 'partes')}</span><span>${agentBusy() ? 'escrevendo' : 'pronto'}</span></div>` : '';
		if (b.action && !['write', 'screen'].includes(b.action)) {
			const what = { publish: 'Publicando o app', theme: 'Mudando o tema', styles: 'Mudando os estilos', data: 'Mudando os dados de exemplo', tabs: 'Mudando as abas', remove: 'Tirando uma parte', restore: 'Voltando uma versão' }[b.action] || 'O agente está trabalhando';
			return panel(esc(what), li(agentBusy() ? ic('spinner', 'spin c-run') : ic('passed', 'c-ok'), `${agentBusy() ? 'em andamento' : 'feito'} · ${esc(when(b.at))}`, ''), { icon: 'layers', pb: 'np', mk: 'run' });
		}
		return panel(`Construindo a tela ${esc(titleOf(b.screen))}`, rows + bar, { icon: 'layers', pb: 'np', mk: 'run' });
	}

	function selectionPanel() {
		const s = S.sel;
		if (!s || S.mode !== 'edit') {
			return S.mode === 'edit' ? panel('Elemento selecionado', note('pointer', 'c-dim', 'Clique num elemento do app para escolher o que mudar. O pedido vai para a caixa da conversa, com a tela e a parte.'), { icon: 'pointer' }) : '';
		}
		const sw = hex => hex ? `<span class="as-sw" style="background:${hex}"></span>${esc(hex)}` : dim('transparente');
		const pairs = [
			['Tipo', esc(s.type)],
			['Texto', s.text ? esc(s.text) : dim('sem texto'), s.text],
			['Tela', esc(titleOf(s.screen))],
			['Parte', s.part ? mono(s.part) : s.inTabs ? 'barra de abas (gerada)' : dim('nenhuma')],
			['Tamanho', `${nf(s.w)} × ${nf(s.h)}${s.w < 44 || s.h < 44 ? ` ${badge('pequeno', 'you')}` : ''}`],
			['Cor de fundo', sw(s.bg)],
			['Cor do texto', sw(s.color)],
			['Letra', esc(s.font)],
			s.go ? ['Leva para', esc(s.go === 'volta' || s.go === 'fecha' ? s.go : titleOf(s.go))] : null,
		];
		return panel('Elemento selecionado', kv(pairs), { icon: 'pointer', foot: `${btn('Pedir mudança', 'comments', 'primary', 'data-act="sel-ask"')}${btn('Limpar', 'close', '', 'data-act="sel-clear"')}<span class="as-dim">vai para a caixa da conversa</span>` });
	}

	function previewSide() {
		const id = currentScreen();
		const out = [buildPanel(), selectionPanel()];
		if (id && screenOf(id)) {
			out.push(panel('Esta tela', screenFacts(id) + `<div class="as-sublabel">Estado da tela</div>${statesSeg(id)}`, { icon: 'phone' }));
			const order = S.docs?.order.get(id) || [];
			const s = screenOf(id);
			const rows = order.map(p => {
				const info = arr(s.parts).find(x => x.id === p.id);
				return li(p.planned ? ic('ring', 'c-dim') : ic('check', 'c-ok'), `<span class="${p.planned ? 'as-dim' : ''}">${esc(partName(id, p.id))}</span>`, p.planned ? 'planejada' : bytes(info?.bytes), 'click', `data-act="part" data-part="${esc(p.id)}"`);
			}).join('');
			out.push(panel('Partes da tela', rows || li(ic('info', 'c-dim'), dim('nenhuma parte ainda')), { icon: 'layers', pb: 'np', right: plural(order.filter(p => !p.planned).length, 'parte', 'partes') }));
		}
		const L = liveMain();
		if (L?.sp && !S.frame) {
			out.push(panel('Medidas', kv([
				['Largura', nf(L.sp.w)], ['Altura', nf(L.sp.h)], ['Área segura em cima', nf(L.sp.top)], ['Área segura embaixo', nf(L.sp.bottom)],
				['Cantos da tela', `arredondados, ${nf(L.sp.radius)}`], ['Escala na prévia', `${nf(L.k * 100)}%`],
			]), { icon: 'ruler' }));
		}
		if (DEVICES[S.device].open) {
			const d = DEVICES[S.device];
			out.push(panel('Ao fechar e abrir', kv([
				['Tela de fora', `${d.closed[0]} × ${d.closed[1]}`], ['Tela de dentro', `${d.open[0]} × ${d.open[1]}`], ['Dobra', S.landscape ? 'horizontal, no meio' : 'vertical, no meio'],
				['Tela atual', `mantida · ${esc(titleOf(id))}`], ['Rolagem e estado', 'mantidos'],
			]), { icon: 'fold' }));
		}
		return out.join('');
	}

	function testSide() {
		const out = [selectionPanel()];
		const hist = S.hist.slice(-12);
		const offset = S.hist.length - hist.length;
		const cur = currentScreen();
		const rows = hist.map((h, i) => {
			const last = i === hist.length - 1;
			return `<div class="as-li two click ${last ? 'sel' : ''}" data-act="hist" data-i="${offset + i}"><span class="as-num">${offset + i + 1}</span><span class="tx"><b>${esc(titleOf(h.screen))}</b> ${mono(screenOf(h.screen)?.route || '')}<small>${esc(h.how)}</small></span><em>${last ? 'agora · ' : ''}${clock(h.at)}</em></div>`;
		}).join('');
		out.push(panel('Histórico da navegação', rows || li(ic('info', 'c-dim'), dim('toque no app para começar')), { icon: 'history', pb: 'np', right: plural(new Set(S.hist.map(h => h.screen)).size, 'tela', 'telas'), foot: '<span class="as-dim full">clique numa linha para voltar àquele ponto</span>' }));
		const taps = S.taps.filter(t => t.screen === cur).slice(-5);
		out.push(panel('Toques nesta tela', taps.length ? taps.map(t => li(mono(clock(t.at)), `tocou em ${esc(t.label)}`, esc(t.result || '…'))).join('') : li(ic('tap', 'c-dim'), dim('nenhum toque ainda')), { icon: 'tap', pb: 'np' }));
		if (cur && screenOf(cur)) {
			const p = S.place || { stack: [], modal: null };
			const data = obj(app()?.data) || {};
			out.push(panel('Estado da tela', kv([
				['Tela', esc(titleOf(cur))],
				['Rota', mono(screenOf(cur).route || '/')],
				['Pilha', esc(p.stack.map(titleOf).join(' › ') || '—'), p.stack.map(titleOf).join(' › ')],
				['Modal', p.modal ? esc(titleOf(p.modal)) : dim('nenhum')],
				['Dados de exemplo', Object.keys(data).length ? esc(plural(Object.keys(data).length, 'coleção', 'coleções')) : dim('nenhum'), Object.entries(data).map(([k, v]) => `${k} (${arr(v).length})`).join(', ')],
			]) + `<div class="as-sublabel">Estado</div>${statesSeg(cur)}`, { icon: 'database' }));
		}
		return out.join('');
	}

	// ---------------------------------------------------- Telas (grid)

	function screensView() {
		const counts = { all: screens().length, tab: screens().filter(s => s.kind === 'tab').length, stack: screens().filter(s => s.kind === 'stack').length, modal: screens().filter(s => s.kind === 'modal').length };
		const filters = [['all', `Todas · ${counts.all}`], ['tab', `Abas · ${counts.tab}`], ['stack', `Pilha · ${counts.stack}`], ['modal', `Modais · ${counts.modal}`]].filter(([id]) => id === 'all' || counts[id]);
		const sub = `<div class="as-sub-in">${seg(filters.map(([id, l]) => btn(l, '', S.gridFilter === id ? 'on' : '', `data-act="grid-filter" data-filter="${id}"`)))}<span class="as-sep"></span><span class="as-lbl opt">Aparelho</span>${select(enabledDevices().map(id => [id, DEVICES[id].label]), S.device, 'data-set="device" title="Aparelho"')}<span class="as-lbl opt">Ordem</span>${select([['path', 'Caminho no app'], ['made', 'Ordem de criação']], S.gridOrder, 'data-set="grid-order" title="Ordem"')}${check('Moldura', S.gridFrame, 'data-set="grid-frame"')}<span class="as-sp"></span><span class="as-dim opt2">clique para abrir na prévia</span></div>`;
		const sp = spec(S.device, S.fold === 'both' ? 'closed' : S.fold, false, S.gridFrame);
		const boxH = E.studio?.classList.contains('compact') ? 200 : 236;
		const k = Math.min(boxH / sp.H, 150 / sp.W);
		const ids = (S.gridOrder === 'made' ? screens().map(s => s.id) : pathOrder()).filter(id => S.gridFilter === 'all' || kindOf(id) === S.gridFilter);
		const dead = new Set(arr(routes().deadEnds));
		const items = ids.map(id => {
			const s = screenOf(id);
			const states = arr(s.states).filter(n => n !== 'normal');
			const marks = dead.has(id) || arr(routes().unreachable).includes(id);
			return {
				key: `g:${id}`,
				html: `<div class="as-gcard ${marks ? 'mk mk-you' : ''}" data-act="open-screen" data-id="${esc(id)}" data-pick-screen="${esc(id)}"><div class="th">${snapHtml(id, sp, k)}</div><div class="tx1"><b>${esc(titleOf(id))}</b>${lockHtml(id)}${badge(KIND_LABELS[s.kind] || 'pilha', s.kind === 'tab' ? 'run' : s.kind === 'modal' ? 'ok' : '')}</div><div class="tx2">${mono(s.route || '/')}</div><div class="tx3">${states.length ? `${plural(states.length + 1, 'estado', 'estados')} · ` : ''}${plural(arr(s.parts).length, 'parte', 'partes')}${arr(s.planned).length ? ` · ${nf(arr(s.planned).length)} planejada${arr(s.planned).length > 1 ? 's' : ''}` : ''}${dead.has(id) ? ` · ${badge('sem saída', 'you')}` : ''}${arr(routes().unreachable).includes(id) ? ` · ${badge('sem caminho', 'you')}` : ''}</div></div>`,
			};
		});
		items.push({ key: 'new', html: '<div class="as-gcard new" data-act="new-screen"><span class="plus">' + ic('plus') + '<b>Nova tela</b><small>descreva na conversa e o agente cria</small></span></div>' });
		return { key: 'screens', sub, skeleton: '<div class="as-grid" data-region="grid" data-scroll="grid"></div>', regions: { grid: items } };
	}

	// ---------------------------------------------------- Mapa

	/**
	 * Columns by the longest path from the start over the taps (the tabs are one group, in one column), rows following
	 * their parents. An edge to the next column runs straight through the gap; any other edge climbs to its own lane
	 * above the map and comes down in the gap before its target, so no line crosses a screen.
	 */
	function mapLayout() {
		const thumbs = S.mapThumbs;
		const labels = S.mapLabels;
		const nodeW = thumbs ? 118 : 150, nodeH = thumbs ? 146 : 50;
		const gapX = labels ? 156 : 84, gapY = 26, laneGap = labels ? 17 : 10;
		const ids = screens().map(s => s.id);
		const tabIds = tabs().map(t => t.screen);
		const tabSet = new Set(tabIds);
		const start = startId();
		const group = id => tabSet.has(id) ? '#tabs' : id;
		// One edge per pair of screens, with every label that leads there; the tab bar already joins the tabs.
		const merged = new Map();
		for (const e of edges()) {
			if (!e.to || !screenOf(e.to) || e.to === e.from || e.how === 'back' || e.how === 'close' || (tabSet.has(e.from) && tabSet.has(e.to))) { continue; }
			const key = `${e.from}>${e.to}`;
			if (!merged.has(key)) { merged.set(key, { from: e.from, to: e.to, how: e.how, labels: [] }); }
			const m = merged.get(key);
			if (e.label && !m.labels.includes(e.label)) { m.labels.push(e.label); }
		}
		for (const m of arr(routes().missing)) {
			if (obj(m) && screenOf(m.from) && typeof m.to === 'string' && !screenOf(m.to)) {
				merged.set(`${m.from}>?${m.to}`, { from: m.from, to: `?${m.to}`, how: 'missing', labels: [] });
			}
		}
		const list = [...merged.values()];
		const adj = new Map();
		for (const m of list) {
			const a = group(m.from), b = group(m.to);
			if (a !== b) { (adj.get(a) || adj.set(a, []).get(a)).push(b); }
		}
		const root = start ? group(start) : null;
		const seen = new Map();
		const dag = [];
		const dfs = u => {
			seen.set(u, 1);
			for (const v of adj.get(u) || []) {
				if (!seen.has(v)) { dag.push([u, v]); dfs(v); } else if (seen.get(v) === 2) { dag.push([u, v]); }
			}
			seen.set(u, 2);
		};
		if (root) { dfs(root); }
		const col = new Map(root ? [[root, 0]] : []);
		for (let pass = 0; pass < 64; pass++) {
			let changed = false;
			for (const [u, v] of dag) {
				const c = (col.get(u) ?? 0) + 1;
				if (!col.has(v) || col.get(v) < c) { col.set(v, c); changed = true; }
			}
			if (!changed) { break; }
		}
		const placed = new Set([...col.keys()]);
		const unreached = ids.filter(id => !placed.has(group(id)));
		const lastCol = Math.max(0, ...col.values()) + 1;
		unreached.forEach(id => col.set(group(id), lastCol));
		const colOf = id => col.get(group(id)) ?? lastCol;
		const nodeIds = [...ids, ...list.filter(m => m.to.startsWith('?')).map(m => m.to)];
		const columns = [];
		for (const id of nodeIds) { (columns[colOf(id)] = columns[colOf(id)] || []).push(id); }
		// Lanes over the map for the edges that do not go to the next column.
		const far = list.filter(m => colOf(m.to) !== colOf(m.from) + 1);
		const top0 = 30 + far.length * laneGap;
		const left = 44;
		const colX = [], colW = [];
		const pos = new Map();
		let cx = left;
		columns.forEach((members, c) => {
			if (!members) { colX[c] = cx; colW[c] = 0; return; }
			const isTabs = members.some(id => tabSet.has(id));
			const isLost = members.some(id => unreached.includes(id));
			colX[c] = cx;
			colW[c] = nodeW + (isTabs ? 28 : isLost ? 20 : 0);
			const x = cx + (isTabs ? 14 : isLost ? 10 : 0);
			if (isTabs) {
				members.sort((a, b) => (tabSet.has(a) ? tabIds.indexOf(a) : 99) - (tabSet.has(b) ? tabIds.indexOf(b) : 99));
				members.forEach((id, i) => pos.set(id, { x, y: top0 + 26 + i * (nodeH + gapY) }));
			} else {
				const parentsY = id => list.filter(m => m.to === id && pos.has(m.from)).map(m => pos.get(m.from).y);
				const bary = id => { const p = parentsY(id); return p.length ? p.reduce((a, b) => a + b, 0) / p.length : 1e6; };
				members.sort((a, b) => bary(a) - bary(b) || nodeIds.indexOf(a) - nodeIds.indexOf(b));
				let cursor = top0 + (isLost ? 24 : 0);
				members.forEach(id => {
					const b = bary(id);
					const y = Math.max(cursor, b < 1e6 ? b : cursor);
					pos.set(id, { x, y });
					cursor = y + nodeH + gapY;
				});
			}
			cx += colW[c] + gapX;
		});
		const nodes = nodeIds.map(id => ({ id, ...pos.get(id), w: nodeW, h: nodeH, ghost: id.startsWith('?'), lost: unreached.includes(id) }));
		const byId = new Map(nodes.map(n => [n.id, n]));
		const frameOf = members => {
			const ns = members.map(id => byId.get(id)).filter(Boolean);
			if (!ns.length) { return null; }
			const minY = Math.min(...ns.map(n => n.y)), maxY = Math.max(...ns.map(n => n.y + n.h));
			return { minY, maxY, x: ns[0].x, ns };
		};
		const tf = tabIds.length ? frameOf(tabIds) : null;
		const tabBox = tf ? { x: tf.x - 14, y: tf.minY - 26, w: nodeW + 28, h: tf.maxY - tf.minY + 40 } : null;
		const lf = unreached.length ? frameOf(unreached) : null;
		const deadBox = lf ? { x: lf.x - 10, y: lf.minY - 24, w: nodeW + 20, h: lf.maxY - lf.minY + 34 } : null;
		// Ports: edges leave a screen's right side and arrive on the left side, spread along it.
		const outs = new Map(), ins_ = new Map();
		for (const m of list) {
			m.a = byId.get(m.from);
			m.b = byId.get(m.to);
			if (!m.a || !m.b) { continue; }
			m.far = far.includes(m);
			(outs.get(m.from) || outs.set(m.from, []).get(m.from)).push(m);
			(ins_.get(m.to) || ins_.set(m.to, []).get(m.to)).push(m);
		}
		for (const [, es] of outs) { es.sort((p, q) => (q.far - p.far) || p.b.y - q.b.y); es.forEach((m, i) => { m.sy = m.a.y + m.a.h * (i + 1) / (es.length + 1); }); }
		for (const [, es] of ins_) { es.sort((p, q) => (q.far - p.far) || p.a.y - q.a.y); es.forEach((m, i) => { m.ty = m.b.y + m.b.h * (i + 1) / (es.length + 1); }); }
		// Vertical runs share the gap between two columns, each on its own track.
		const gaps = new Map();
		const track = (gap, m, which) => { (gaps.get(gap) || gaps.set(gap, []).get(gap)).push({ m, which }); };
		far.forEach((m, i) => { m.ly = 22 + i * laneGap; });
		for (const m of list) {
			if (!m.a || !m.b) { continue; }
			track(colOf(m.from), m, 'x1');
			if (m.far) { track(colOf(m.to) - 1, m, 'x2'); }
		}
		for (const [gap, runs] of gaps) {
			const x0 = gap < 0 ? 8 : colX[gap] + colW[gap];
			const x1 = gap < 0 ? colX[0] : colX[gap + 1] ?? x0 + gapX;
			runs.sort((p, q) => (p.which === 'x2' ? p.m.ty : p.m.sy) - (q.which === 'x2' ? q.m.ty : q.m.sy));
			runs.forEach((r, i) => { r.m[r.which] = x0 + 14 + (x1 - x0 - 28) * (runs.length === 1 ? 0.5 : i / (runs.length - 1)); });
		}
		const paths = [];
		for (const m of list) {
			if (!m.a || !m.b) { continue; }
			const ax = m.a.x + m.a.w, bx = m.b.x - 2;
			if (m.far) {
				const d = `M${ax} ${m.sy} H${m.x1} V${m.ly} H${m.x2} V${m.ty} H${bx}`;
				const lw = Math.min(Math.abs(m.x2 - m.x1) - 8, 190);
				paths.push({ e: m, d, lx: (m.x1 + m.x2) / 2, ly: m.ly, lw: Math.max(60, lw), far: true });
			} else {
				const d = `M${ax} ${m.sy} H${m.x1} V${m.ty} H${bx}`;
				paths.push({ e: m, d, lx: (ax + m.b.x) / 2, ly: m.ty, lw: gapX - 18, far: false });
			}
		}
		const width = Math.max(...nodes.map(n => n.x + n.w), tabBox ? tabBox.x + tabBox.w : 0, deadBox ? deadBox.x + deadBox.w : 0) + 30;
		const height = Math.max(...nodes.map(n => n.y + n.h), tabBox ? tabBox.y + tabBox.h : 0, deadBox ? deadBox.y + deadBox.h : 0) + 34;
		return { nodes, byId, paths, tabBox, deadBox, width, height, nodeW, nodeH, gapX, list, tabIds };
	}

	function mapView() {
		const pick = S.mapPick && screenOf(S.mapPick) ? S.mapPick : null;
		const nLinks = arr(routes().links).filter(l => obj(l) && screenOf(l.screen) && l.route !== screenOf(l.screen).route).length;
		const dead = arr(routes().deadEnds).filter(id => screenOf(id));
		const lay = mapLayout();
		const nEdges = lay.list.length;
		const sub = `<div class="as-sub-in">${seg([btn('Caminhos', 'route', 'on', 'data-act="view" data-view="map"'), btn('Estrutura', 'tree', '', 'data-act="view" data-view="structure"')])}<span class="as-sep"></span><span class="as-lbl opt">Destacar</span>${select([['', 'nenhuma tela'], ...pathOrder().map(id => [id, `caminho até ${titleOf(id)}`])], pick || '', 'data-set="map-pick" title="Destacar o caminho até uma tela"')}${check('Miniaturas', S.mapThumbs, 'data-set="map-thumbs"')}${check('Toques nas setas', S.mapLabels, 'data-set="map-labels"')}<label class="as-zoom" title="Tamanho do mapa">${ic('zoom')}${select([['fit', 'Ajustar'], ['0.75', '75%'], ['1', '100%']], S.mapZoom, 'data-set="map-zoom"')}</label><span class="as-sp"></span><span class="as-mapsum opt">${ic('map')}${plural(screens().length, 'tela', 'telas')} · ${plural(nEdges, 'ligação', 'ligações')}${nLinks ? ` · ${plural(nLinks, 'link direto', 'links diretos')}` : ''}</span>${dead.length ? badge(`${nf(dead.length)} sem saída`, 'you') : ''}${pick ? btn('Percorrer na prévia', 'play', '', 'data-act="walk"') : ''}</div>`;
		return {
			key: 'map',
			sub,
			skeleton: '<div class="as-cols"><div class="as-mapwrap" data-scroll="map"><div class="as-map" data-region="map"></div></div><div class="as-side narrow" data-region="side" data-scroll="mside"></div></div>',
			regions: { map: mapItems(lay), side: mapSide(lay) },
		};
	}

	function mapItems(lay) {
		const sp = spec(S.device, 'closed', false, true);
		const thumbH = lay.nodeH - 46;
		const k = Math.min(thumbH / sp.H, (lay.nodeW - 20) / sp.W);
		const dead = new Set(arr(routes().deadEnds));
		const unreachable = new Set(arr(routes().unreachable));
		const backs = id => edges().filter(e => e.from === id && (e.how === 'back' || e.how === 'close'));
		const items = [];
		const edgeSvg = lay.paths.map(p => `<path class="e ${p.e.how === 'missing' ? 'miss' : ''} ${p.far ? 'far' : ''}" data-e="${esc(`${p.e.from}>${p.e.to}`)}" d="${p.d}"/>`).join('');
		const marker = (id, color) => `<marker id="${id}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto" markerUnits="userSpaceOnUse"><path d="M0 0 8 4 0 8z" fill="${color}"/></marker>`;
		items.push({ key: 'svg', html: `<svg class="as-edges" width="${lay.width}" height="${lay.height}" viewBox="0 0 ${lay.width} ${lay.height}" aria-hidden="true"><defs>${marker('as-arrow', '#8E8E93')}${marker('as-arrow-on', '#4DA3FF')}</defs>${edgeSvg}</svg>` });
		if (lay.tabBox) {
			const b = lay.tabBox;
			items.push({ key: 'tabs', html: `<div class="as-group" style="left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px"><span>Abas · ${nf(lay.tabIds.length)}</span></div>` });
		}
		if (lay.deadBox) {
			const b = lay.deadBox;
			items.push({ key: 'dead', html: `<div class="as-group off" style="left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px"><span>Sem caminho</span></div>` });
		}
		for (const n of lay.nodes) {
			if (n.ghost) {
				items.push({ key: `n:${n.id}`, html: `<div class="as-node ghost mk mk-you" style="left:${n.x}px;top:${n.y + (lay.nodeH - 58) / 2}px;width:${n.w}px;height:58px" title="Uma tela leva para cá, mas ela não existe"><b>${esc(n.id.slice(1))}</b><small>não existe</small>${badge('falta', 'you')}</div>` });
				continue;
			}
			const s = screenOf(n.id);
			const marks = dead.has(n.id) ? badge('sem saída', 'you') : unreachable.has(n.id) ? badge('sem caminho', 'you') : '';
			const ret = backs(n.id).map(e => e.how === 'close' ? 'fecha' : 'volta');
			const retText = [...new Set(ret)].join(' · ');
			const thumb = S.mapThumbs ? `<div class="th">${snapHtml(n.id, sp, k)}</div>` : '';
			items.push({
				key: `n:${n.id}:${S.mapThumbs ? 1 : 0}`,
				html: `<div class="as-node ${S.mapThumbs ? 'big' : ''} ${marks ? 'mk mk-you' : ''}" data-act="map-node" data-id="${esc(n.id)}" data-node="${esc(n.id)}" style="left:${n.x}px;top:${n.y}px;width:${n.w}px;height:${n.h}px">${thumb}<div class="nm"><b>${esc(titleOf(n.id))}</b>${lockHtml(n.id)}</div><div class="rt">${esc(s.route || '/')}</div>${s.kind === 'modal' ? `<span class="as-badge ok kind">modal</span>` : ''}${marks ? `<span class="flag">${marks}</span>` : ''}${retText ? `<span class="ret" title="Tem como sair por aqui">${ic('back', 'sm')}${esc(retText)}</span>` : ''}<span class="as-step"></span></div>`,
			});
		}
		if (S.mapLabels) {
			for (const p of lay.paths) {
				const text = p.e.labels.length ? `${p.e.labels[0]}${p.e.labels.length > 1 ? ` +${p.e.labels.length - 1}` : ''}` : '';
				if (!text) { continue; }
				const w = p.lw;
				items.push({ key: `l:${p.e.from}>${p.e.to}`, html: `<span class="as-elabel ${p.far ? 'far' : ''}" data-e="${esc(`${p.e.from}>${p.e.to}`)}" style="left:${Math.round(p.lx - w / 2)}px;top:${Math.round(p.ly)}px;width:${Math.round(w)}px" title="${esc(p.e.labels.join(' · '))}"><span>${esc(text)}</span></span>` });
			}
		}
		const links = arr(routes().links).filter(l => obj(l) && screenOf(l.screen) && l.route !== screenOf(l.screen).route);
		links.forEach(l => {
			const n = lay.byId.get(l.screen);
			if (n) { items.push({ key: `k:${l.route}`, html: `<span class="as-linkchip" style="left:${n.x}px;top:${n.y + n.h + 5}px;max-width:${n.w + 40}px" title="Link direto: abre o app já nesta tela">${ic('link', 'sm')}${esc(l.route)}</span>` }); }
		});
		items.push({ key: 'size', html: `<i class="as-mapsize" style="width:${lay.width}px;height:${lay.height + (links.length ? 26 : 0)}px"></i>` });
		return items;
	}

	function decorateMap() {
		const map = E.body.querySelector('.as-map');
		if (!map) { return; }
		const path = S.mapPick ? pathTo(S.mapPick) : null;
		const onEdges = new Set(path ? path.steps.filter(s => !s.edge.bar).map(s => `${s.from}>${s.to}`) : []);
		map.classList.toggle('picking', !!path);
		const wrap = map.parentElement;
		const size = map.querySelector('.as-mapsize');
		if (wrap && size) {
			const w = parseFloat(size.style.width) || 1, h = parseFloat(size.style.height) || 1;
			const fit = clamp(Math.min((wrap.clientWidth - 4) / w, (wrap.clientHeight - 4) / h), 0.35, 1);
			map.style.zoom = String(S.mapZoom === 'fit' ? fit : Number(S.mapZoom));
		}
		map.querySelectorAll('.as-node[data-node]').forEach(n => {
			const id = n.getAttribute('data-node');
			const i = path ? path.screens.indexOf(id) : -1;
			n.classList.toggle('on', i >= 0);
			n.classList.toggle('pick', id === S.mapPick);
			const step = n.querySelector('.as-step');
			if (step) { step.textContent = i >= 0 ? String(i + 1) : ''; }
		});
		map.querySelectorAll('[data-e]').forEach(el => el.classList.toggle('on', onEdges.has(el.getAttribute('data-e'))));
		map.querySelectorAll('.as-node.ghost').forEach(n => n.classList.toggle('on', false));
	}

	function mapSide(lay) {
		const out = [];
		const pick = S.mapPick && screenOf(S.mapPick) ? S.mapPick : null;
		if (pick) {
			const path = pathTo(pick);
			if (path) {
				const rows = path.screens.map((id, i) => {
					const step = path.steps[i];
					const how = step ? (step.edge.bar ? `pela aba ${titleOf(step.to)}` : `toque em ${quote(step.edge.label || titleOf(step.to))}`) : 'chegou';
					return li(`<span class="as-num">${i + 1}</span>`, `<b>${esc(titleOf(id))}</b><small>${esc(how)}</small>`, '', 'two');
				}).join('');
				out.push(panel(`Caminho até ${esc(titleOf(pick))}`, rows, { icon: 'route', pb: 'np', right: plural(path.steps.length, 'toque', 'toques'), foot: `${btn('Abrir na prévia', 'phone', '', `data-act="open-screen" data-id="${esc(pick)}"`)}${btn('Percorrer', 'play', '', 'data-act="walk"')}` }));
			} else {
				out.push(panel(`Caminho até ${esc(titleOf(pick))}`, note('warning', 'c-you', 'Nenhum caminho leva até esta tela a partir do início do app.'), { icon: 'route', mk: 'you' }));
			}
		}
		const issues = [];
		for (const id of arr(routes().deadEnds).filter(screenOf)) {
			const p = arr(st().problems).find(x => obj(x) && x.kind === 'dead-end' && x.screen === id);
			const text = p ? problemAsk({ ...p, group: 'nav' }) : `Na tela ${titleOf(id)}, coloque um jeito de sair: um botão que volte ou leve para outra tela.`;
			issues.push(`<div class="as-li two mk-row"><span class="tx"><b>${esc(titleOf(id))}</b> ${badge('sem saída', 'you')}<small>Quem chega aqui não tem botão nem jeito de voltar.</small></span>${btn('Pedir', 'comments', 'sm', `data-act="ask" data-text="${esc(text)}"`)}</div>`);
		}
		for (const id of arr(routes().unreachable).filter(screenOf)) {
			const p = arr(st().problems).find(x => obj(x) && x.kind === 'unreachable' && x.screen === id);
			const text = p ? problemAsk({ ...p, group: 'nav' }) : `Ligue a tela ${titleOf(id)} a alguma tela do app; hoje nenhuma tela leva até ela.`;
			issues.push(`<div class="as-li two mk-row"><span class="tx"><b>${esc(titleOf(id))}</b> ${badge('sem caminho', 'you')}<small>Nenhuma tela leva até aqui.</small></span>${btn('Pedir', 'comments', 'sm', `data-act="ask" data-text="${esc(text)}"`)}</div>`);
		}
		for (const m of arr(routes().missing).filter(m => obj(m) && screenOf(m.from))) {
			const text = `Crie a tela ${m.to}; a tela ${titleOf(m.from)} já leva para ela.`;
			issues.push(`<div class="as-li two mk-row"><span class="tx"><b>${esc(m.to)}</b> ${badge('falta', 'you')}<small>${esc(titleOf(m.from))} leva para esta tela, que não existe.</small></span>${btn('Criar', 'plus', 'sm', `data-act="ask" data-text="${esc(text)}"`)}</div>`);
		}
		if (issues.length) { out.push(panel('Navegação', issues.join(''), { icon: 'warning', pb: 'np', right: plural(issues.length, 'aviso', 'avisos') })); }
		const legend = [
			li('<svg class="as-leg" viewBox="0 0 30 10"><path d="M1 5h24" stroke="#9A9A9E" stroke-width="1.4"/><path d="M24 1.5 29 5l-5 3.5z" fill="#9A9A9E"/></svg>', 'o toque leva a outra tela'),
			li(`<span class="as-leg-ret">${ic('back', 'sm')}volta</span>`, 'tem como voltar ou fechar'),
			li(ic('lock'), 'pede login'),
			li(`<span class="as-leg-mk"></span>`, 'tela sem saída ou sem caminho'),
			li('<span class="as-leg-box"></span>', 'abas: troca pela barra de baixo'),
			li(`<span class="as-badge ok">modal</span>`, 'abre por cima da tela de trás'),
		].join('');
		out.push(panel('Legenda', legend, { icon: 'info', pb: 'np', right: plural(lay.list.length, 'ligação', 'ligações') }));
		return out.join('');
	}

	// ---------------------------------------------------- Estrutura

	function structureView() {
		const sub = `<div class="as-sub-in">${seg([btn('Caminhos', 'route', '', 'data-act="view" data-view="map"'), btn('Estrutura', 'tree', 'on', 'data-act="view" data-view="structure"')])}<span class="as-sep"></span><span class="as-dim">tudo fica em ${mono(`${folder()}/appstudio.json`)}; o ${mono('index.html')} é gerado de novo a cada mudança</span><span class="as-sp"></span><span class="as-route opt">${ic('folder', 'sm')}<span class="p">${esc(projectName())}/${esc(folder())}</span></span></div>`;
		const groups = [['tab', 'Abas', 'barra de baixo; cada aba guarda onde a pessoa parou'], ['stack', 'Pilha', 'uma tela por cima da outra; voltar volta um passo'], ['modal', 'Modais', 'abrem por cima, de baixo para cima; fechar volta']];
		const sel = S.structSel && screenOf(S.structSel) ? S.structSel : currentScreen() || startId();
		const tree = groups.map(([kind, label, sub_]) => {
			const list = kind === 'tab' ? tabs().map(t => t.screen) : screens().filter(s => s.kind === kind).map(s => s.id);
			if (!list.length) { return ''; }
			const rows = list.map(id => {
				const s = screenOf(id);
				const parts = arr(s.parts).length;
				return `<div class="as-tr click ${sel === id ? 'sel' : ''}" data-act="struct-pick" data-id="${esc(id)}">${ic(kind === 'modal' ? 'layers' : 'file')}${mono(id)}<span class="nm">${esc(titleOf(id))}</span>${lockHtml(id)}<span class="pp">${plural(parts, 'parte', 'partes')}</span><span class="rt">${esc(s.route || '/')}</span></div>`;
			}).join('');
			return `<div class="as-tr grp">${ic(kind === 'tab' ? 'grid' : kind === 'modal' ? 'layers' : 'list')}<b>${label}</b><span class="as-dim">${nf(list.length)} · ${sub_}</span></div>${rows}`;
		}).join('');
		const left = panel(`Telas em ${esc(folder())}/appstudio.json`, `<div class="as-tree">${tree}</div>`, { icon: 'folder', pb: 'np', right: plural(screens().length, 'tela', 'telas'), scroll: 'tree' });
		const s = screenOf(sel);
		const order = S.docs?.order.get(sel) || [];
		const detail = s ? panel(`Tela ${esc(titleOf(sel))}`, kv([
			['Identificador', mono(sel)], ['Rota', mono(s.route || '/')], ['Tipo', esc(KIND_LABELS[s.kind] || 'pilha')], ['Pede login', s.login ? 'sim' : 'não'],
			['Estados', esc(arr(s.states).map(n => STATE_LABELS[n] || n).join(', ') || 'Normal')],
			['Partes', esc(order.map(p => p.planned ? `${p.id} (planejada)` : p.id).join(', ') || '—'), order.map(p => p.id).join(', ')],
			['No index.html', mono(`section[data-screen="${sel}"]`)],
		]), { icon: 'file' }) : '';
		const routeRows = pathOrder().map(id => {
			const x = screenOf(id);
			const link = arr(routes().links).find(l => obj(l) && l.screen === id && l.route !== x.route);
			return { c: [esc(titleOf(id)), mono(x.route || '/'), badge(KIND_LABELS[x.kind] || 'pilha', x.kind === 'tab' ? 'run' : x.kind === 'modal' ? 'ok' : ''), x.login ? ic('lock', 'sm') : dim('—'), link ? mono(link.route) : ''], cls: sel === id ? 'sel' : '', attrs: `data-act="struct-pick" data-id="${esc(id)}"` };
		});
		const routesPanel = panel('Rotas', table([['Tela', 96], ['Rota', 0, 'm'], ['Tipo', 56], [ic('lock'), 34, 'c'], ['Link direto', 0, 'm']], routeRows), { icon: 'route', pb: 'np', right: plural(screens().length, 'tela', 'telas') });
		const styles = arr(app()?.styles).filter(obj);
		const stylesPanel = panel('Estilos', styles.length ? styles.map(x => li(ic('brush', 'c-dim'), mono(x.name), bytes(x.bytes))).join('') : li(ic('info', 'c-dim'), dim('nenhum bloco de estilo')), { icon: 'brush', pb: 'np', right: plural(styles.length, 'bloco', 'blocos') });
		const data = obj(app()?.data) || {};
		const usedIn = name => screens().filter(x => (S.docs?.sections.get(x.id) || '').includes(`data-each="${name}"`)).map(x => titleOf(x.id));
		const dataRows = Object.entries(data).map(([name, rows]) => {
			const fields = Object.keys(obj(arr(rows)[0]) || {});
			return { c: [mono(name), nf(arr(rows).length), esc(fields.join(', ')), esc(joinPt(usedIn(name))) || dim('nenhuma tela')] };
		});
		const dataPanel = panel('Dados de exemplo', dataRows.length ? table([['Coleção', 92], ['Linhas', 62, 'r'], ['Campos', 0], ['Usada em', 0]], dataRows) : li(ic('info', 'c-dim'), dim('nenhum dado de exemplo')), { icon: 'database', pb: 'np', right: plural(Object.keys(data).length, 'coleção', 'coleções') });
		const files = arr(app()?.files).filter(f => obj(f) && f.path);
		const filesPanel = files.length ? panel('Arquivos do app', files.map(f => li(ic('file', 'c-dim'), mono(f.path), bytes(f.bytes))).join(''), { icon: 'folder', pb: 'np' }) : '';
		return {
			key: 'structure', sub,
			skeleton: '<div class="as-cols"><div class="as-main" data-region="main" data-scroll="smain"></div><div class="as-side w2" data-region="side" data-scroll="sside"></div></div>',
			regions: { main: `${left}${detail}`, side: `${routesPanel}${dataPanel}${stylesPanel}${filesPanel}` },
		};
	}

	// ---------------------------------------------------- Estados

	function statesView() {
		const id = S.statesScreen && screenOf(S.statesScreen) ? S.statesScreen : (screens().find(s => arr(s.states).length > 1)?.id || currentScreen() || startId());
		const s = screenOf(id);
		const defined = arr(s?.states).length ? arr(s.states) : ['normal'];
		const pick = STATES.includes(S.statesPick) ? S.statesPick : 'normal';
		const sub = `<div class="as-sub-in">${btn('Usar o app', 'tap', '', 'data-act="view" data-view="test"')}<span class="as-sep"></span><span class="as-lbl">Tela</span>${select(pathOrder().map(x => [x, titleOf(x)]), id, 'data-set="states-screen"')}<span class="as-lbl opt">Estado</span>${seg(STATES.map(n => btn(STATE_LABELS[n], '', `${!S.statesAll && pick === n ? 'on' : ''} ${defined.includes(n) ? '' : 'undef'}`, `data-act="states-pick" data-state="${n}"`)))}${btn('Lado a lado', 'grid', S.statesAll ? 'on' : '', 'data-act="states-all"')}<span class="as-sp"></span>${select(enabledDevices().map(x => [x, DEVICES[x].label]), S.device, 'data-set="device" title="Aparelho"')}</div>`;
		const show = S.statesAll ? defined : [pick];
		const sp = spec(S.device, S.fold === 'both' ? 'closed' : S.fold, false, true);
		const H = clamp(window.innerHeight - 404, 200, 520);
		const k = Math.min(H / sp.H, (S.statesAll ? Math.max(150, (window.innerWidth - 60) / show.length - 26) : 520) / sp.W);
		const frames = show.map(n => {
			const ok = defined.includes(n);
			const cap = ok ? `<b>${STATE_LABELS[n]}</b><span>${esc(STATE_NOTES[n])}</span>` : `<b>${STATE_LABELS[n]}</b><span>esta tela não define</span>${btn('Pedir este estado', 'comments', 'sm', `data-act="ask" data-text="${esc(`Na tela ${titleOf(id)}, crie ${STATE_ASK[n]}.`)}"`)}`;
			return { key: `s:${id}:${n}`, html: `<div class="as-sframe ${ok ? '' : 'undef'}">${snapHtml(id, sp, k, { state: n })}<div class="cap">${cap}</div></div>` };
		});
		const rows = pathOrder().map(x => {
			const st_ = arr(screenOf(x).states);
			return { c: [esc(titleOf(x)), ...STATES.map(n => st_.includes(n) || n === 'normal' ? ic('check', 'c-ok') : dim('—'))], cls: x === id ? 'sel' : '', attrs: `data-act="states-screen" data-id="${esc(x)}"` };
		});
		const missing = STATES.filter(n => !defined.includes(n));
		const tablePanel = panel('Estados de cada tela', table([['Tela', 0], ...STATES.map(n => [STATE_LABELS[n], 96, 'c'])], rows), {
			icon: 'list', pb: 'np', right: `${esc(titleOf(id))}: ${plural(defined.length, 'estado', 'estados')}`,
			foot: missing.length ? `<span class="as-dim">Faltam em ${esc(titleOf(id))}: ${esc(joinPt(missing.map(n => STATE_LABELS[n].toLowerCase())))}.</span>${btn(`Pedir ${missing.length === 1 ? 'o estado' : 'os estados'} que faltam`, 'comments', '', `data-act="ask" data-text="${esc(`Na tela ${titleOf(id)}, crie ${joinPt(missing.map(n => STATE_ASK[n]))}.`)}"`)}` : '',
		});
		return {
			key: 'states', sub,
			skeleton: '<div class="as-sframes" data-region="frames" data-scroll="sframes"></div><div class="as-stable" data-region="table" data-scroll="stable"></div>',
			regions: { frames, table: tablePanel },
		};
	}

	// ---------------------------------------------------- Problemas

	function problemsView() {
		const all = problems();
		const count = g => all.filter(p => g === 'all' || p.group === g).length;
		const filters = ['all', 'a11y', 'layout', 'nav'].filter(g => g === 'all' || count(g));
		const filter = filters.includes(S.probFilter) ? S.probFilter : 'all';
		const list = all.filter(p => filter === 'all' || p.group === filter);
		const sub = `<div class="as-sub-in">${ic('warning', all.length ? 'c-you' : 'c-dim')}<b class="as-title">Problemas encontrados</b><span class="as-dim opt">da versão ${nf(versionNow())} · medidos no ${esc(S.measured?.device || spec().name)}</span><span class="as-sp"></span>${seg(filters.map(g => btn(`${GROUP_LABELS[g]} · ${count(g)}`, '', filter === g ? 'on' : '', `data-act="prob-filter" data-filter="${g}"`)))}</div>`;
		const sel = list.find(p => p.id === S.probSel) || list[0] || null;
		const rows = list.map((p, i) => {
			const where = [p.screen ? titleOf(p.screen) : 'barra de abas', p.part].filter(Boolean).join(' · ');
			return `<div class="as-prob mk mk-you ${sel && sel.id === p.id ? 'sel' : ''}" data-act="prob-pick" data-id="${esc(p.id)}"><div class="h"><span class="as-pnum">${i + 1}</span><b>${esc(PROBLEM_LABELS[p.kind] || 'Problema')}</b>${p.measured ? badge('medido aqui', '') : ''}<span class="w">${esc(where)}</span></div><p>${esc(p.text)}</p>${p.fix ? `<p class="fx"><span class="as-dim">Correção proposta:</span> ${ins(esc(p.fix))}</p>` : ''}<div class="a">${btn('Pedir esta correção', 'comments', 'sm', `data-act="ask" data-text="${esc(problemAsk(p))}"`)}<span class="as-dim">vira um pedido na conversa</span></div></div>`;
		}).join('');
		const empty = `<div class="as-pempty">${ic('passed', 'c-ok lg')}<div><b>Nenhum problema ${filter === 'all' ? '' : 'deste tipo '}encontrado</b><span>As verificações do AppStudio e as medidas feitas aqui no ${esc(S.measured?.device || spec().name)} estão em ordem.</span></div></div>`;
		const allText = list.length > 1 ? `Corrija estes ${nf(list.length)} problemas do app: ${list.map((p, i) => `${i + 1}) ${problemAsk(p).replace(/\.$/, '')}`).join('; ')}.` : '';
		const left = panel(plural(list.length, 'problema', 'problemas'), rows || empty, {
			icon: 'warning', pb: 'np', right: 'nada foi mudado ainda', scroll: 'probs', cls: 'fill',
			foot: `${note('info', 'c-dim', 'Cada correção vira uma versão nova; dá para voltar.')}${list.length > 1 ? btn(`Pedir as ${nf(list.length)} correções`, 'comments', 'primary', `data-act="ask" data-text="${esc(allText.slice(0, 3900))}"`) : ''}`,
		});
		let right = '';
		if (sel && sel.screen && screenOf(sel.screen)) {
			const sp = spec(S.device, S.fold === 'both' ? 'closed' : S.fold, false, true);
			const compact = E.studio?.classList.contains('compact');
			const k = Math.min((compact ? 420 : 560) / sp.H, 300 / sp.W);
			const mark = sel.mark || (sel.part ? `part:${sel.part}` : '');
			right = `<div class="as-pview"><div class="as-cap">Problema ${list.indexOf(sel) + 1} · ${esc(titleOf(sel.screen))} · ${esc(sp.name)} · ${sizeText(sp)}</div>${snapHtml(sel.screen, sp, k, { mark })}${btn('Abrir na prévia', 'phone', 'sm', `data-act="open-screen" data-id="${esc(sel.screen)}"`)}</div>`;
		} else if (sel) {
			right = `<div class="as-pview">${note('info', 'c-dim', 'Este problema não é de uma tela só.')}</div>`;
		}
		return {
			key: 'problems', sub,
			skeleton: '<div class="as-cols"><div class="as-main" data-region="list"></div><div class="as-side w2 dark" data-region="side"></div></div>',
			regions: { list: left, side: right },
		};
	}

	// ---------------------------------------------------- Versões

	function versionsView() {
		const list = versions();
		const nowN = list[0]?.n;
		const sel = list.find(v => v.n === S.verSel) || list[0] || null;
		const sub = `<div class="as-sub-in">${ic('history')}<b class="as-title">Versões</b><span class="as-dim">cada passo do agente vira uma versão · ${plural(list.length, 'salva', 'salvas')}</span><span class="as-sp"></span><span class="as-dim opt">a mais nova em cima</span></div>`;
		const rows = list.map(v => `<div class="as-ver ${sel && sel.n === v.n ? 'sel' : ''}" data-act="ver-pick" data-n="${v.n}"><span class="vn">v${v.n}</span><span class="tx"><b>${esc(v.summary || 'sem resumo')}</b><small>${esc(when(v.at))} · ${plural(num(v.screens) ?? 0, 'tela', 'telas')}</small></span>${v.n === nowN ? badge('atual', 'ok') : ''}</div>`).join('');
		const left = panel('Versões', rows || li(ic('info', 'c-dim'), dim('nenhuma versão ainda')), { icon: 'history', pb: 'np', right: 'mais nova em cima', scroll: 'vers', cls: 'fill' });
		let right = '';
		if (sel) {
			const isNow = sel.n === nowN;
			const detail = panel(`Versão ${sel.n}${isNow ? ' · atual' : ''}`, kv([
				['Número', `v${sel.n}`], ['Quando', esc(when(sel.at))], ['O que mudou', esc(sel.summary || '—')], ['Telas', nf(num(sel.screens) ?? 0)],
				['Guardada em', mono(`${folder()}/.appstudio/versoes/${sel.n}.json`)],
			]), {
				icon: 'file',
				foot: isNow ? '<span class="as-dim full">Esta é a versão que está na prévia.</span>' : `${btn(`Voltar para a versão ${sel.n}`, 'history', 'primary', `data-act="ask" data-text="${esc(`Volte o app para a versão ${sel.n}.`)}"`)}<span class="as-dim">vira um pedido ao agente</span>`,
			});
			const sp = spec(S.device, 'closed', false, true);
			const k = Math.min(clamp(window.innerHeight - 452, 180, 420) / sp.H, 220 / sp.W);
			const start = startId();
			const nowCard = start ? `<div class="as-vnow">${snapHtml(start, sp, k)}<div class="cap"><b>Versão ${nf(nowN)} · atual</b><span>${esc(titleOf(start))}, como está agora</span></div></div>` : '';
			right = `${detail}<div class="as-panel">${nowCard}<div class="as-pb">${note('comments', 'c-run', 'Voltar para uma versão é um pedido ao agente: ele cria uma versão nova com aquele conteúdo e não apaga nenhuma.')}</div></div>`;
		}
		return { key: 'versions', sub, skeleton: '<div class="as-cols"><div class="as-main" data-region="list"></div><div class="as-side w2" data-region="side" data-scroll="vside"></div></div>', regions: { list: left, side: right } };
	}

	// ---------------------------------------------------- Publicar

	function publishView() {
		const pub = obj(st().published);
		const files = new Set(arr(pub?.files).map(String));
		const skipped = arr(pub?.skipped).map(x => typeof x === 'string' ? x : obj(x)?.path || '').filter(Boolean);
		const f = folder();
		const sub = `<div class="as-sub-in">${ic('upload')}<b class="as-title">Publicar</b><span class="as-dim">${pub ? `publicado ${esc(when(pub.at))} · da versão ${nf(versionNow())}` : `ainda não publicado · versão ${nf(versionNow())}`}</span><span class="as-sp"></span><span class="as-dim opt">tudo fica em ${mono(`${f}/`)}</span></div>`;
		const row = (path, what) => {
			const full = `${f}/${path}`;
			const done = files.has(full);
			const skip = skipped.some(s => s === full || s === path);
			return li(done ? ic('passed', 'c-ok') : skip ? ic('alert', 'c-you') : ic('ring', 'c-dim'), `${mono(path)} <span class="as-dim">${esc(what)}</span>`, done ? (pub ? `gerado ${hm(pub.at)}` : 'gerado') : skip ? 'não foi gerado' : 'ainda não');
		};
		const pwa = panel('Instalar pelo navegador (PWA)', [row('index.html', 'o app inteiro, num arquivo'), row('manifest.webmanifest', 'nome, cores e ícone'), row('icone.svg', 'o ícone'), row('sw.js', 'abre sem internet')].join(''), {
			icon: 'desktop', pb: 'np',
			foot: `${btn(pub ? 'Publicar de novo' : 'Publicar como PWA', 'upload', pub ? '' : 'primary', `data-act="ask" data-text="${esc('Publique o app como PWA.')}"`)}<span class="as-dim">quem abre no celular pode instalar na tela inicial</span>`,
		});
		const known = ['index.html', 'manifest.webmanifest', 'icone.svg', 'sw.js', 'capacitor.config.json', 'package.json', 'PUBLICAR.md'].map(n => `${f}/${n}`);
		const others = [...files].filter(p => !known.includes(p));
		const www = others.filter(p => p.startsWith(`${f}/www/`));
		const extra = (www.length ? [li(ic('passed', 'c-ok'), `${mono('www/')} <span class="as-dim">cópia do app para o Capacitor</span>`, plural(www.length, 'arquivo', 'arquivos'))] : [])
			.concat(others.filter(p => !www.includes(p)).map(p => li(ic('passed', 'c-ok'), mono(p.slice(f.length + 1)), pub ? `gerado ${hm(pub.at)}` : 'gerado')));
		const cap = panel('Android e iPhone (Capacitor)', [row('capacitor.config.json', 'o app nativo'), row('package.json', 'os pacotes'), row('PUBLICAR.md', 'o passo a passo das lojas'), ...extra].join('') + note('info', 'c-dim', 'O build do Android e do iPhone é feito fora do AppStudio, seguindo o PUBLICAR.md. Contas nas lojas ficam com você.'), {
			icon: 'phone', pb: 'np',
			foot: `${btn(pub?.capacitor ? 'Preparar de novo' : 'Preparar para Android e iPhone', 'upload', '', `data-act="ask" data-text="${esc('Publique o app como PWA e prepare os arquivos do Capacitor para Android e iPhone.')}"`)}`,
		});
		const t = theme();
		const icon = `<span class="as-appicon" style="background:${esc(t.primary || '#24563F')};border-radius:${Math.round(clamp(num(t.radius) ?? 14, 4, 30) * 1.4)}px">${esc(String(t.icon || str(app()?.name).slice(0, 2) || 'AP').slice(0, 3))}</span>`;
		const all = problems();
		const planned = screens().reduce((a, s) => a + arr(s.planned).length, 0);
		const checks = [
			[!!app()?.name, 'Nome do app', esc(app()?.name || 'falta')],
			[!!t.icon, 'Ícone', t.icon ? esc(String(t.icon)) : 'falta'],
			[!!t.primary, 'Cor do tema', esc(t.primary || 'falta')],
			[!!startId(), 'Tela de abertura', esc(titleOf(startId()))],
			[!all.length, 'Problemas', all.length ? `${plural(all.length, 'aberto', 'abertos')}` : 'nenhum'],
			[!planned, 'Partes planejadas', planned ? `${nf(planned)} por escrever` : 'nenhuma'],
		].map(([ok, k, v]) => li(ok ? ic('check', 'c-ok') : ic('warning', 'c-you'), esc(k), v, ok ? '' : 'mk-row'));
		const list = panel('Antes de publicar', checks.join(''), { icon: 'list', pb: 'np', foot: all.length ? btn('Ver os problemas', 'warning', 'sm', 'data-act="view" data-view="problems"') : '' });
		const home = `<div class="as-homescr">${Array.from({ length: 11 }, () => '<i></i>').join('')}<span class="me">${icon}<small>${esc(String(app()?.name || '').slice(0, 14))}</small></span></div>`;
		const look = panel('Como aparece no celular', `<div class="as-look"><div class="big">${icon}<b>${esc(app()?.name || '')}</b><span class="as-dim">${esc(t.primary || '')} · ícone ${esc(String(t.icon || ''))}</span></div>${home}</div>`, { icon: 'image' });
		const manifest = [
			'{', `  "name": "${esc(app()?.name || '')}",`, `  "short_name": "${esc(String(app()?.name || '').slice(0, 12))}",`, `  "start_url": "./index.html",`, `  "display": "standalone",`,
			`  "background_color": "${esc(t.background || '')}",`, `  "theme_color": "${esc(t.primary || '')}",`, `  "icons": [{ "src": "icone.svg" }]`, '}',
		].map((l, i) => `<div><span class="n">${i + 1}</span>${l}</div>`).join('');
		const man = panel('manifest.webmanifest', `<div class="as-code">${manifest}</div>`, { icon: 'file', right: files.has(`${f}/manifest.webmanifest`) ? 'como foi gerado' : 'como vai ficar' });
		return {
			key: 'publish', sub,
			skeleton: '<div class="as-cols"><div class="as-main" data-region="main" data-scroll="pmain"></div><div class="as-side w2" data-region="side" data-scroll="pside"></div></div>',
			regions: { main: `${pwa}${cap}${note('lock', 'c-dim', '<b>Neste computador.</b> Publicar gera os arquivos na pasta do app; nada é enviado para a internet nem para as lojas sem você pedir.')}`, side: `${look}${list}${man}` },
		};
	}

	// ---------------------------------------------------- Configurações

	const SETTING_ASK = {
		devices: v => `os aparelhos da prévia para ${joinPt(v.map(d => DEVICES[d].label))}`,
		frame: v => `a moldura da prévia para ${v ? 'ligada' : 'desligada'}`,
	};
	function settingsAsk() {
		const s = settings();
		const parts = [];
		if (S.setDraft.devices) {
			const now = arr(s.devices).filter(d => DEVICES[d]);
			const was = now.length ? now : DEVICE_IDS;
			const next = DEVICE_IDS.filter(d => S.setDraft.devices.has(d));
			if (next.length && (next.length !== was.length || next.some(d => !was.includes(d)))) { parts.push(SETTING_ASK.devices(next)); }
		}
		if (typeof S.setDraft.frame === 'boolean' && S.setDraft.frame !== (s.frame !== false)) { parts.push(SETTING_ASK.frame(S.setDraft.frame)); }
		if (!parts.length) { return null; }
		return parts.length === 1 ? `Mude ${parts[0]}.` : `Mude as configurações do AppStudio: ${parts.join('; ')}.`;
	}

	function settingsView() {
		const s = settings();
		const sub = `<div class="as-sub-in">${ic('gear')}<b class="as-title">Configurações do AppStudio</b><span class="as-dim">valem para ${esc(projectName())} · ficam com o app</span></div>`;
		const nowDevices = arr(s.devices).filter(d => DEVICES[d]).length ? arr(s.devices).filter(d => DEVICES[d]) : DEVICE_IDS;
		const draftDevices = S.setDraft.devices || new Set(nowDevices);
		const deviceRows = DEVICE_IDS.map(id => {
			const on = draftDevices.has(id);
			const changed = on !== nowDevices.includes(id);
			const d = DEVICES[id];
			const size = d.open ? `aberto ${d.open.join(' × ')} · fechado ${d.closed.join(' × ')}` : `${d.size.join(' × ')}`;
			return `<label class="as-set">${`<input type="checkbox" class="as-check" data-set="set-device" data-device="${id}" ${on ? 'checked' : ''}>`}<span class="lb">${changed ? (on ? ins(esc(d.label)) : del(esc(d.label))) : esc(d.label)}<small>${esc(size)}</small></span></label>`;
		}).join('');
		const frameNow = s.frame !== false;
		const frameDraft = typeof S.setDraft.frame === 'boolean' ? S.setDraft.frame : frameNow;
		const preview = panel('Prévia', `${deviceRows}<label class="as-set"><input type="checkbox" class="as-check" data-set="set-frame" ${frameDraft ? 'checked' : ''}><span class="lb">${frameDraft !== frameNow ? (frameDraft ? ins('Moldura ao abrir') : del('Moldura ao abrir')) : 'Moldura ao abrir'}<small>o celular inteiro, com câmera e cantos</small></span></label>`, {
			icon: 'phone', pb: 'np', right: `${nf(draftDevices.size)} de ${nf(DEVICE_IDS.length)} aparelhos`,
			foot: settingsAsk() ? `${btn('Pedir estas mudanças', 'comments', 'primary', 'data-act="set-ask"')}${btn('Desfazer', 'close', '', 'data-act="set-undo"')}<span class="as-dim">${esc(settingsAsk())}</span>` : '<span class="as-dim full">Marque o que mudar; o pedido vai para o agente.</span>',
		});
		const project = panel('Projeto', kv([
			['Pasta do app', mono(`${folder()}/`)], ['Arquivo do app', mono('appstudio.json')], ['App gerado', mono('index.html')], ['Versões', mono('.appstudio/versoes/')],
			['Telas', nf(screens().length)], ['Versão', nf(versionNow())],
		]), { icon: 'folder', foot: btn('Mudar a pasta', 'folder', 'sm', 'data-act="set-folder"') });
		const t = theme();
		const colors = [
			['primary', 'Cor principal', 'botões, títulos e abas ativas', t.primary, contrast('#FFFFFF', t.primary), 'com branco'],
			['accent', 'Cor de destaque', 'chamadas e botão principal', t.accent, contrast('#FFFFFF', t.accent), 'com branco'],
			['background', 'Fundo', 'fundo das telas', t.background, null, ''],
			['surface', 'Superfície', 'cartões e barras', t.surface, null, ''],
			['text', 'Texto', 'textos principais', t.text, contrast(t.text, t.background), 'no fundo'],
			['muted', 'Texto de apoio', 'legendas e detalhes', t.muted, contrast(t.muted, t.background), 'no fundo'],
		].filter(c => c[3]).map(([key, label, sub_, hex, ratio, against]) => {
			const low = ratio !== null && ratio < 4.5;
			return `<div class="as-color ${low ? 'mk-row' : ''}"><span class="as-sw big" style="background:${esc(hex)}"></span><span class="lb"><b>${esc(label)}</b><small>${mono(hex)} · ${esc(sub_)}</small></span>${ratio !== null ? `<span class="ct">${nf(ratio, 1)}:1 ${esc(against)}${low ? ` ${badge('baixo', 'you')}` : ''}</span>` : '<span class="ct"></span>'}${btn('', 'brush', 'ib sm', `data-act="fill" data-text="${esc(`Mude a ${label.toLowerCase()} do app (hoje ${hex}) para `)}" title="Pedir outra cor"`)}</div>`;
		}).join('');
		const themePanel = panel('Tema do app', colors, { icon: 'palette', pb: 'np', right: 'contraste mínimo 4,5:1' });
		const fontName = !t.font || t.font === 'system' ? 'a letra do celular' : String(t.font);
		const look = panel('Letra, cantos e ícone', kv([
			['Letra', esc(fontName)], ['Cantos', `${nf(num(t.radius) ?? 0)} px`], ['Ícone', `<span class="as-appicon sm" style="background:${esc(t.primary || '#555')}">${esc(String(t.icon || '').slice(0, 3))}</span> ${esc(String(t.icon || '—'))}`],
		]), {
			icon: 'font',
			foot: `${btn('Letra', 'font', 'sm', `data-act="fill" data-text="${esc(`Mude a letra do app (hoje ${fontName}) para `)}"`)}${btn('Cantos', 'box', 'sm', `data-act="fill" data-text="${esc(`Mude o arredondamento dos cantos do app (hoje ${num(t.radius) ?? 0} px) para `)}"`)}${btn('Ícone', 'image', 'sm', `data-act="fill" data-text="${esc(`Mude o ícone do app (hoje “${t.icon || ''}”) para `)}"`)}`,
		});
		return {
			key: 'settings', sub,
			skeleton: '<div class="as-cols"><div class="as-main" data-region="main" data-scroll="setm"></div><div class="as-side w2" data-region="side" data-scroll="sets"></div></div>',
			regions: { main: `${preview}${project}`, side: hasApp() ? `${themePanel}${look}${note('comments', 'c-dim', 'Os botões do Studio viram pedidos ao agente na conversa.')}` : note('info', 'c-dim', 'O tema aparece aqui quando o app tiver a primeira tela.') },
		};
	}

	// ------------------------------------------------------------------ actions

	function toast(text, kind = 'info') {
		S.note = text;
		S.noteKind = kind;
		render();
		clearTimeout(toast.timer);
		toast.timer = setTimeout(() => { S.note = null; render(); }, 3200);
	}

	function setView(view) {
		if (!ALL_VIEWS.includes(view)) { return; }
		if (!hasApp() && view !== 'preview' && view !== 'settings') { return; }
		S.view = view;
		S.menu = null;
		remember();
		render();
	}

	/** Walks the highlighted path in the test view, one tap every 0,7 s. */
	function walk() {
		const path = S.mapPick ? pathTo(S.mapPick) : null;
		if (!path) { return; }
		setView('test');
		let i = 0;
		const stepOnce = () => {
			const L = liveMain();
			if (!L?.ctl) { setTimeout(stepOnce, 200); return; }
			if (i === 0) {
				L.ctl.reset(path.screens[0]);
				S.hist = [];
				pushHist({ stack: [path.screens[0]], modal: null, state: 'normal' }, 'start', 'percorreu o caminho do mapa');
			} else {
				const s = path.steps[i - 1];
				L.lastTap = { at: Date.now(), label: s.edge.bar ? `aba ${titleOf(s.to)}` : quote(s.edge.label || titleOf(s.to)) };
				if (s.edge.how === 'tab') { L.ctl.tab(s.to); } else { L.ctl.go(s.to); }
			}
			i++;
			if (i <= path.steps.length) { setTimeout(stepOnce, 700); }
		};
		setTimeout(stepOnce, 300);
	}

	function onClick(event) {
		if (S.menu && !event.target.closest('.as-menu') && !event.target.closest('[data-act="menu"]')) {
			S.menu = null;
			render();
		}
		if (event.target.closest('input, select')) { return; }
		const el = event.target.closest('[data-act]');
		if (!el || el.disabled || el.classList.contains('dis')) { return; }
		const d = el.dataset;
		switch (d.act) {
			case 'view':
				setView(d.view);
				break;
			case 'menu':
				S.menu = S.menu === d.menu ? null : d.menu;
				render();
				break;
			case 'stop':
				host.postMessage({ type: 'stop' });
				toast('Pedi ao agente para parar.');
				break;
			case 'device':
				S.device = d.device;
				if (!DEVICES[S.device].open && S.fold === 'both') { S.fold = 'open'; }
				remember();
				render();
				break;
			case 'fold':
				S.fold = d.fold;
				remember();
				render();
				break;
			case 'frame':
				S.frame = d.on === '1';
				remember();
				render();
				break;
			case 'rotate':
				S.landscape = !S.landscape;
				remember();
				render();
				break;
			case 'mode':
				S.mode = d.mode;
				if (S.mode !== 'edit') { S.sel = null; E.lives.forEach(L => { L.hover = null; }); }
				E.lives.forEach(L => { L.doc?.documentElement.classList.toggle('as-editar', S.mode === 'edit'); drawMarks(L); });
				remember();
				render();
				break;
			case 'back':
				liveMain()?.ctl?.back();
				break;
			case 'restart': {
				const L = liveMain();
				if (L?.ctl) {
					L.restoring = true;
					L.ctl.reset(startId());
					L.restoring = false;
					S.place = { stack: [L.ctl.current()], modal: null, state: 'normal' };
					S.hist = [];
					S.taps = [];
					pushHist(S.place, 'start', 'reiniciou o app');
					L.doc?.defaultView.scrollTo(0, 0);
					E.lives.slice(1).forEach(o => { o.restoring = true; o.ctl && replay(o.ctl, S.place); o.restoring = false; });
					render();
				}
				break;
			}
			case 'hist': {
				const h = S.hist[Number(d.i)];
				const L = liveMain();
				if (h && L?.ctl) {
					L.restoring = true;
					replay(L.ctl, h.place);
					L.restoring = false;
					S.place = h.place;
					S.hist = S.hist.slice(0, Number(d.i) + 1);
					E.lives.slice(1).forEach(o => { o.restoring = true; o.ctl && replay(o.ctl, h.place); o.restoring = false; });
					render();
				}
				break;
			}
			case 'set-state': {
				const L = liveMain();
				if (L?.ctl) { L.ctl.setState(d.state); }
				break;
			}
			case 'pick-screen':
				if (!navigateTo(d.id)) { S.want = { screen: d.id }; }
				break;
			case 'open-screen':
				S.want = { screen: d.id };
				if (S.view === 'preview' && navigateTo(d.id)) { S.want = null; }
				setView('preview');
				break;
			case 'new-screen':
				fill('Crie a tela ');
				break;
			case 'part': {
				const L = liveMain();
				if (L) {
					S.flash = { screen: currentScreen(), part: d.part, label: 'Parte', until: Date.now() + 2500 };
					scrollToPart(L, d.part);
					drawMarks(L);
					setTimeout(() => drawMarks(L), 2600);
				}
				break;
			}
			case 'sel-ask': {
				const s = S.sel;
				if (s) {
					const what = `${s.type}${s.text ? ` ${quote(s.text)}` : ''}`;
					fill(s.inTabs ? `Na barra de abas (${what}): ` : `Na tela ${titleOf(s.screen)}, parte ${s.part || 'sem nome'} (${what}): `);
				}
				break;
			}
			case 'sel-clear':
				S.sel = null;
				E.lives.forEach(drawMarks);
				render();
				break;
			case 'grid-filter':
				S.gridFilter = d.filter;
				render();
				break;
			case 'map-node':
				S.mapPick = S.mapPick === d.id ? null : d.id;
				render();
				break;
			case 'walk':
				walk();
				break;
			case 'struct-pick':
				S.structSel = d.id;
				render();
				break;
			case 'states-pick':
				S.statesPick = d.state;
				S.statesAll = false;
				remember();
				render();
				break;
			case 'states-all':
				S.statesAll = !S.statesAll;
				remember();
				render();
				break;
			case 'states-screen':
				S.statesScreen = d.id;
				render();
				break;
			case 'prob-filter':
				S.probFilter = d.filter;
				render();
				break;
			case 'prob-pick':
				if (!event.target.closest('button')) { S.probSel = d.id; render(); }
				break;
			case 'ver-pick':
				S.verSel = Number(d.n);
				render();
				break;
			case 'start-pick':
				S.startPick = d.id;
				render();
				break;
			case 'start-go': {
				const t = TEMPLATES.find(x => x[0] === S.startPick) || TEMPLATES[0];
				act(t[3]);
				break;
			}
			case 'sample':
				fill(d.text);
				break;
			case 'ask':
				act(d.text);
				break;
			case 'fill':
				fill(d.text);
				break;
			case 'set-ask': {
				const text = settingsAsk();
				if (text) { act(text); S.setDraft = {}; render(); }
				break;
			}
			case 'set-undo':
				S.setDraft = {};
				render();
				break;
			case 'set-folder':
				fill('Mude a pasta do app no AppStudio para ');
				break;
		}
	}

	function onChange(event) {
		const el = event.target;
		const set = el.dataset.set;
		if (!set) { return; }
		switch (set) {
			case 'device':
				S.device = DEVICES[el.value] ? el.value : S.device;
				if (!DEVICES[S.device].open && S.fold === 'both') { S.fold = 'open'; }
				break;
			case 'zoom': S.zoom = el.value; break;
			case 'frame': S.frame = el.checked; break;
			case 'taps': S.showTaps = el.checked; break;
			case 'grid-order': S.gridOrder = el.value; break;
			case 'grid-frame': S.gridFrame = el.checked; break;
			case 'map-thumbs': S.mapThumbs = el.checked; break;
			case 'map-labels': S.mapLabels = el.checked; break;
			case 'map-zoom': S.mapZoom = el.value; break;
			case 'map-pick': S.mapPick = el.value || null; break;
			case 'states-screen': S.statesScreen = el.value; break;
			case 'set-device': {
				const now = arr(settings().devices).filter(d => DEVICES[d]);
				const draft = S.setDraft.devices || new Set(now.length ? now : DEVICE_IDS);
				if (el.checked) { draft.add(el.dataset.device); } else { draft.delete(el.dataset.device); }
				S.setDraft.devices = draft;
				break;
			}
			case 'set-frame': S.setDraft.frame = el.checked; break;
		}
		remember();
		render();
	}

	// ------------------------------------------------------------------ host messages

	/** Follows what the agent pointed at (state.view and state.focus) and a new building step, once per change. */
	function applyFocus(state) {
		const f = obj(state.focus) || {};
		if (ALL_VIEWS.includes(state.view)) { S.view = state.view; }
		if (DEVICES[f.device]) { S.device = f.device; }
		if (typeof f.frame === 'boolean') { S.frame = f.frame; }
		if (f.fold === 'open' || f.fold === 'closed') { S.fold = f.fold; }
		if (typeof f.landscape === 'boolean') { S.landscape = f.landscape; }
		const b = obj(state.building);
		// A part just written on a screen brings that screen back; other steps (publish, theme…) keep the agent's focus.
		const fresh = b && num(b.at) !== null && Date.now() / 1000 - b.at < 20 && screenOf(b.screen) && (!b.action || ['write', 'screen'].includes(b.action));
		const screen = fresh ? b.screen : typeof f.screen === 'string' ? f.screen : null;
		const part = fresh ? null : typeof f.part === 'string' ? f.part : null;
		if (screen) {
			S.want = { screen, state: fresh ? 'normal' : STATES.includes(f.state) ? f.state : 'normal', part, label: 'Aqui' };
			S.statesScreen = screen;
			if (STATES.includes(f.state) && f.state !== 'normal') { S.statesPick = f.state; }
		}
		S.sel = null;
		const L = liveMain();
		if (L?.ctl) { applyWant(L); }
	}

	function readFiles(files) {
		const state = obj(typeof files['state.json'] === 'string' ? parse(files['state.json']) : null);
		S.st = state || S.st || {};
		const appText = typeof files['app.json'] === 'string' ? files['app.json'] : '';
		if (appText !== S.appRaw) {
			S.appRaw = appText;
			const a = obj(parse(appText));
			S.app = a && Array.isArray(a.screens) ? a : null;
			S.docs = S.app && typeof S.app.preview === 'string' ? readDocs(S.app.preview) : null;
			// Names of planned parts are kept, so a part keeps its name after it is written.
			if (S.docs) {
				for (const [id, list] of S.docs.order) {
					list.forEach(p => { if (p.planned && p.name && p.name !== p.id) { S.partNames[`${id}/${p.id}`] = p.name; } });
				}
			}
			if (S.sel) { S.sel = null; }
		}
		if (state) {
			const b = obj(state.building);
			// A new building step counts as a change, so the Studio comes back to the preview even after local changes.
			const sig = JSON.stringify([state.view ?? null, state.focus ?? null, b ? [b.screen ?? null, b.part ?? null, b.at ?? null, S.app?.revision ?? null] : null]);
			if (sig !== S.sig) {
				const first = S.sig === null && saved.sig === sig;
				S.sig = sig;
				if (!first) { applyFocus(state); }
				remember();
			}
			const notice = obj(state.notice);
			const noticeKey = notice?.text ? `${notice.kind}|${notice.text}|${notice.at ?? ''}` : null;
			if (noticeKey && noticeKey !== S.noticeSeen) { toast(String(notice.text), notice.kind === 'warning' ? 'warning' : 'info'); }
			S.noticeSeen = noticeKey;
			if (b && num(b.at) !== null) {
				// The outline of the part being written goes away by itself.
				clearTimeout(readFiles.buildTimer);
				const left = (b.at + 8) * 1000 - Date.now();
				if (left > 0) { readFiles.buildTimer = setTimeout(() => { E.lives.forEach(drawMarks); render(); }, left + 50); }
			}
		}
		if (S.pending && Date.now() - S.pending.at > 90000) { S.pending = null; }
	}

	window.addEventListener('message', event => {
		const msg = event.data;
		if (!msg || typeof msg !== 'object') { return; }
		switch (msg.type) {
			case 'init':
			case 'context':
				S.ctx = obj(msg.context);
				render();
				break;
			case 'files':
				readFiles(obj(msg.files) || {});
				render();
				break;
			case 'filesError':
				toast(typeof msg.message === 'string' ? msg.message : 'Não foi possível atualizar o AppStudio.', 'warning');
				break;
			case 'running':
				S.running = !!msg.running;
				if (!S.running) { S.pending = null; }
				render();
				break;
			case 'request':
				if (S.pending && S.pending.requestId === msg.requestId && ['settled', 'rejected', 'unconfirmed'].includes(msg.state)) {
					if (msg.state === 'rejected') { toast('O agente está ocupado. Tente de novo quando ele terminar.', 'warning'); }
					S.pending = null;
					render();
				}
				break;
		}
	});

	document.addEventListener('click', onClick);
	document.addEventListener('change', onChange);
	document.addEventListener('keydown', event => {
		if (event.key === 'Escape') {
			if (S.menu) { S.menu = null; render(); } else if (S.sel) { S.sel = null; E.lives.forEach(drawMarks); render(); } else if (S.mapPick && S.view === 'map') { S.mapPick = null; render(); }
		}
	});
	window.addEventListener('resize', () => render());

	render();
	host.postMessage({ type: 'ready' });
})();
