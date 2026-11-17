/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ArchStudio Studio interface: plain JavaScript, no libraries, no network. It reads the Studio
// JSON files the host sends (model, progress, view, paths, proposal) and draws them in several
// modes. Everything the user sees is in Brazilian Portuguese.
(function () {
	'use strict';

	/** @type {{ postMessage(m: object): void, getState(): any, setState(s: any): void }} */
	const host = typeof acquireVsCodeApi === 'function'
		? acquireVsCodeApi()
		: { postMessage() { }, getState() { return undefined; }, setState() { } };

	// ------------------------------------------------------------------ constants

	const KINDS = {
		backend: { c: '#4C8DFF', icon: 'service', label: 'Backend', word: 'backend' },
		web: { c: '#2FB383', icon: 'web', label: 'Web', word: 'web' },
		mobile: { c: '#E8A93A', icon: 'mobile', label: 'Mobile', word: 'mobile' },
		embedded: { c: '#E9604A', icon: 'chip', label: 'Embarcado', word: 'embarcado' },
		desktop: { c: '#8E7CC3', icon: 'desktop', label: 'Desktop', word: 'desktop' },
		library: { c: '#B08D5B', icon: 'library', label: 'Biblioteca', word: 'biblioteca' },
		data: { c: '#2BB3C0', icon: 'database', label: 'Dados', word: 'dados' },
		queue: { c: '#2BB3C0', icon: 'queue', label: 'Fila', word: 'fila' },
		external: { c: '#8B93A0', icon: 'globe', label: 'Externo', word: 'externo' },
		file: { c: '#9DA5B4', icon: 'file', label: 'Arquivo', word: 'arquivo' },
	};
	const ROLES = {
		screen: { c: '#E8A93A', icon: 'window', band: 'Telas', one: 'tela' },
		state: { c: '#C58AF0', icon: 'bolt', band: 'Estado', one: 'estado' },
		repository: { c: '#4C8DFF', icon: 'cube', band: 'Repositórios', one: 'repositório' },
		source: { c: '#2BB3C0', icon: 'plug', band: 'Fontes de dados', one: 'fonte de dados' },
		task: { c: '#E9604A', icon: 'clock', band: 'Tarefas', one: 'tarefa' },
		module: { c: '#A3A9F7', icon: 'braces', band: 'Módulos', one: 'módulo' },
		driver: { c: '#7FA7D9', icon: 'plug', band: 'Drivers', one: 'driver' },
		hardware: { c: '#C7A46B', icon: 'chip', band: 'Hardware', one: 'hardware' },
	};
	const CLIENT_BANDS = ['screen', 'state', 'repository', 'source'];
	const EMBEDDED_BANDS = ['task', 'module', 'driver', 'hardware'];
	const LANG_COLORS = {
		go: '#3FB6D6', ts: '#3178C6', tsx: '#3178C6', js: '#E8C547', jsx: '#E8C547', py: '#4B8BBE', dart: '#40C4FF', kt: '#A97BFF',
		java: '#E76F00', swift: '#F05138', c: '#A3A9F7', cpp: '#A3A9F7', h: '#A3A9F7', hpp: '#A3A9F7', rs: '#DEA584', cs: '#9B6BD6',
		sql: '#D8A657', yaml: '#D16969', yml: '#D16969', json: '#CBCB41', toml: '#D16969', rb: '#E0503D', php: '#8892BF',
		html: '#E44D26', css: '#563D7C', scss: '#C6538C', md: '#9DA5B4', proto: '#5FA8D3', tf: '#7B42BC', docker: '#2496ED', sh: '#89E051',
	};
	const LEVEL_RANK = { system: 0, service: 1, file: 2 };
	const MODES = {
		map: { label: 'Mapa', icon: 'map', main: true },
		columns: { label: 'Colunas', icon: 'columns', main: true },
		circles: { label: 'Círculos', icon: 'circles', main: true },
		blocks: { label: 'Blocos', icon: 'blocks', main: true },
		layers: { label: 'Camadas', icon: 'layers', hint: 'Os três níveis empilhados' },
		path: { label: 'Caminho', icon: 'path', hint: 'Um fluxo passo a passo' },
		present: { label: 'Apresentar', icon: 'present', hint: 'Narra um caminho no mapa' },
		deploy: { label: 'Implantação', icon: 'cloud', hint: 'Onde cada parte roda' },
		matrix: { label: 'Matriz', icon: 'matrix', hint: 'Quem depende de quem' },
	};
	const QUIET_PROTOCOLS = new Set(['import', 'include', 'call', 'config', 'require', 'use', 'queue', '']);

	const ICONS = {
		system: '<rect x="5" y="1.8" width="6" height="4" rx="1"/><rect x="1.8" y="10.2" width="5" height="4" rx="1"/><rect x="9.2" y="10.2" width="5" height="4" rx="1"/><path d="M8 5.8v2.2M4.3 10.2V8h7.4v2.2"/>',
		service: '<rect x="2.2" y="2.5" width="11.6" height="4.6" rx="1.2"/><rect x="2.2" y="8.9" width="11.6" height="4.6" rx="1.2"/><path d="M4.8 4.8h.01M4.8 11.2h.01M7.2 4.8h4.2M7.2 11.2h4.2"/>',
		file: '<path d="M4 1.8h5.2l2.9 2.9v9.5H4z"/><path d="M9 1.8v3h3"/><path d="M6.6 8.4 5.3 9.8l1.3 1.4M9.5 8.4l1.3 1.4-1.3 1.4"/>',
		folder: '<path d="M1.8 3.6h4.1l1.5 1.6h6.8v7.5H1.8z"/>',
		folderOpen: '<path d="M1.8 12.6V3.6h4.1l1.5 1.6h5.4v1.6"/><path d="M1.8 12.6l1.9-5.3h10.6l-1.9 5.3z"/>',
		database: '<ellipse cx="8" cy="3.8" rx="5" ry="1.9"/><path d="M3 3.8v8.4c0 1.05 2.24 1.9 5 1.9s5-.85 5-1.9V3.8"/><path d="M3 8c0 1.05 2.24 1.9 5 1.9s5-.85 5-1.9"/>',
		cache: '<ellipse cx="8" cy="3.8" rx="5" ry="1.9"/><path d="M3 3.8v8.4c0 1.05 2.24 1.9 5 1.9s5-.85 5-1.9V3.8"/><path d="m8.7 6.6-1.9 2.7h2.5l-1.9 2.7"/>',
		queue: '<path d="M2 9.2 3.9 3.2h8.2L14 9.2v3.6H2z"/><path d="M2 9.2h3.4l.9 1.6h3.4l.9-1.6H14"/>',
		globe: '<circle cx="8" cy="8" r="5.8"/><path d="M2.2 8h11.6M8 2.2c1.6 1.7 2.4 3.6 2.4 5.8S9.6 12.1 8 13.8M8 2.2C6.4 3.9 5.6 5.8 5.6 8s.8 4.1 2.4 5.8"/>',
		mobile: '<rect x="4.2" y="1.6" width="7.6" height="12.8" rx="1.4"/><path d="M7.2 12.2h1.6"/>',
		web: '<rect x="1.8" y="2.6" width="12.4" height="10.8" rx="1.3"/><path d="M1.8 5.6h12.4M4 4.1h.01M5.6 4.1h.01"/>',
		window: '<rect x="1.8" y="2.6" width="12.4" height="10.8" rx="1.3"/><path d="M1.8 5.6h12.4"/>',
		chip: '<rect x="4.3" y="4.3" width="7.4" height="7.4" rx="1"/><rect x="6.4" y="6.4" width="3.2" height="3.2" rx=".4"/><path d="M6.2 1.8v2.5M9.8 1.8v2.5M6.2 11.7v2.5M9.8 11.7v2.5M1.8 6.2h2.5M1.8 9.8h2.5M11.7 6.2h2.5M11.7 9.8h2.5"/>',
		desktop: '<rect x="1.8" y="2.4" width="12.4" height="8.4" rx="1.2"/><path d="M5.6 13.8h4.8M8 10.8v3"/>',
		library: '<path d="M3.2 2.2h7.6a1.2 1.2 0 0 1 1.2 1.2v10.4H4.4a1.2 1.2 0 0 1-1.2-1.2z"/><path d="M3.2 12.6a1.2 1.2 0 0 1 1.2-1.2H12M5.8 5h3.6"/>',
		search: '<circle cx="7" cy="7" r="4.6"/><path d="m10.4 10.4 3.6 3.6"/>',
		zoomIn: '<circle cx="7" cy="7" r="4.6"/><path d="m10.4 10.4 3.6 3.6M5 7h4M7 5v4"/>',
		zoomOut: '<circle cx="7" cy="7" r="4.6"/><path d="m10.4 10.4 3.6 3.6M5 7h4"/>',
		fit: '<path d="M2 6V2.6c0-.33.27-.6.6-.6H6M10 2h3.4c.33 0 .6.27.6.6V6M14 10v3.4c0 .33-.27.6-.6.6H10M6 14H2.6a.6.6 0 0 1-.6-.6V10"/>',
		export: '<path d="M2.6 3v10M5 8h8.4M10.6 5.2 13.4 8l-2.8 2.8"/>',
		check: '<path d="m3 8.4 3.1 3.1L13 4.6"/>',
		chevR: '<path d="m6 3.5 4.5 4.5L6 12.5"/>',
		chevL: '<path d="M10 3.5 5.5 8l4.5 4.5"/>',
		chevD: '<path d="M3.5 6 8 10.5 12.5 6"/>',
		play: '<path d="M5 3.2v9.6L12.6 8z"/>',
		pause: '<path d="M5.6 3.4v9.2M10.4 3.4v9.2"/>',
		close: '<path d="m4 4 8 8M12 4l-8 8"/>',
		expand: '<path d="M2.4 6V2.4H6M10 2.4h3.6V6M13.6 10v3.6H10M6 13.6H2.4V10"/>',
		collapse: '<path d="M6 2.4V6H2.4M13.6 6H10V2.4M10 13.6V10h3.6M2.4 10H6v3.6"/>',
		goFile: '<path d="M8.6 14H3.8V2h5.4l3 3v3.4"/><path d="M9 2v3h3.2M9.6 12h4.4M12 9.8l2.2 2.2-2.2 2.2"/>',
		warning: '<path d="M7.1 2.6a1 1 0 0 1 1.8 0l5.4 10a1 1 0 0 1-.9 1.4H2.6a1 1 0 0 1-.9-1.4z"/><path d="M8 6.4v3.4M8 11.9h.01"/>',
		info: '<circle cx="8" cy="8" r="5.8"/><path d="M8 7.4v4M8 5h.01"/>',
		pin: '<path d="M8 14.2s4.6-4.1 4.6-7.8a4.6 4.6 0 0 0-9.2 0c0 3.7 4.6 7.8 4.6 7.8z"/><circle cx="8" cy="6.4" r="1.6"/>',
		more: '<circle cx="3.6" cy="8" r="1.1" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none"/><circle cx="12.4" cy="8" r="1.1" fill="currentColor" stroke="none"/>',
		map: '<rect x="1.8" y="2.4" width="4.6" height="3.6" rx=".8"/><rect x="9.6" y="2.4" width="4.6" height="3.6" rx=".8"/><rect x="5.7" y="10" width="4.6" height="3.6" rx=".8"/><path d="M6.4 4.2h3.2M4.1 6v1.6c0 .9.7 1.6 1.6 1.6H8V10M11.9 6v1.6c0 .9-.7 1.6-1.6 1.6H8"/>',
		columns: '<rect x="1.8" y="2.4" width="12.4" height="11.2" rx="1.2"/><path d="M6 2.4v11.2M10 2.4v11.2"/>',
		circles: '<circle cx="8" cy="8" r="6"/><circle cx="6.4" cy="9.2" r="2.4"/><circle cx="10.2" cy="6.2" r="1.6"/>',
		blocks: '<rect x="1.8" y="2.4" width="12.4" height="11.2" rx="1.2"/><path d="M8.6 2.4v11.2M8.6 7.6h5.6M1.8 9.6h6.8"/>',
		layers: '<path d="m8 2 6 3.1L8 8.2 2 5.1z"/><path d="m2 8 6 3.1L14 8M2 10.9 8 14l6-3.1"/>',
		path: '<circle cx="3.6" cy="3.6" r="1.6"/><circle cx="12.4" cy="12.4" r="1.6"/><path d="M5.2 3.6h5a2.2 2.2 0 0 1 0 4.4H5.8a2.2 2.2 0 0 0 0 4.4h5"/>',
		present: '<rect x="1.8" y="2.4" width="12.4" height="8.6" rx="1.2"/><path d="M8 11v2.8M5.6 13.8h4.8M6.8 4.8v3.8L10 6.7z"/>',
		cloud: '<path d="M4.6 12.6a3.1 3.1 0 0 1-.4-6.2 4.1 4.1 0 0 1 7.8-.9 3.6 3.6 0 0 1-.4 7.1z"/>',
		matrix: '<rect x="1.8" y="1.8" width="12.4" height="12.4" rx="1.2"/><path d="M1.8 6h12.4M1.8 10h12.4M6 1.8v12.4M10 1.8v12.4"/>',
		discard: '<path d="M4 6.4h6a3.4 3.4 0 0 1 0 6.8H6.6"/><path d="M6.6 3.6 3.8 6.4l2.8 2.8"/>',
		checklist: '<path d="m2.4 4.2 1 1 2-2M7.6 4.4h6M2.4 8.6l1 1 2-2M7.6 8.8h6M7.6 13h6M3.2 13h1.2"/>',
		edit: '<path d="M10.6 2.6a1.5 1.5 0 0 1 2.1 0l.7.7a1.5 1.5 0 0 1 0 2.1L6 12.8l-3.4.8.8-3.4z"/><path d="m9.4 3.8 2.8 2.8"/>',
		bolt: '<path d="M9 1.8 3.8 9h4l-.9 5.2L12.2 7h-4z"/>',
		cube: '<path d="M8 1.8 13.6 4.6v6.8L8 14.2 2.4 11.4V4.6z"/><path d="M2.4 4.6 8 7.4l5.6-2.8M8 7.4v6.8"/>',
		plug: '<path d="M6 1.8v3M10 1.8v3M4.2 4.8h7.6v2.6a3.8 3.8 0 0 1-7.6 0zM8 11.2v3"/>',
		clock: '<circle cx="8" cy="8" r="5.8"/><path d="M8 4.6V8l2.4 1.6"/>',
		braces: '<path d="M5.6 2.4c-1.4 0-2 .6-2 1.9v1.4c0 1.1-.5 1.9-1.6 2.3 1.1.4 1.6 1.2 1.6 2.3v1.4c0 1.3.6 1.9 2 1.9M10.4 2.4c1.4 0 2 .6 2 1.9v1.4c0 1.1.5 1.9 1.6 2.3-1.1.4-1.6 1.2-1.6 2.3v1.4c0 1.3-.6 1.9-2 1.9"/>',
		lambda: '<path d="M4 2.6h1.2c.8 0 1.4.4 1.7 1.2L11 13.4h1.4M7.6 7.4 4.6 13.4"/>',
		balancer: '<path d="M2 8h12M4.6 5.4 2 8l2.6 2.6M11.4 5.4 14 8l-2.6 2.6"/>',
		person: '<circle cx="8" cy="5" r="2.6"/><path d="M2.8 14c0-2.9 2.3-4.6 5.2-4.6s5.2 1.7 5.2 4.6"/>',
		hexagon: '<path d="M8 1.6 13.6 4.8v6.4L8 14.4 2.4 11.2V4.8z"/>',
		spinner: '<path d="M8 2.2a5.8 5.8 0 1 1-5.8 5.8"/>',
		circle: '<circle cx="8" cy="8" r="5.6"/>',
		passed: '<circle cx="8" cy="8" r="6.2" fill="currentColor" stroke="none"/><path d="m5.3 8.2 1.8 1.8 3.6-3.7" stroke="#FFFFFF" stroke-width="1.5"/>',
		sync: '<path d="M13.2 6.6A5.4 5.4 0 0 0 3.4 5M2.8 9.4A5.4 5.4 0 0 0 12.6 11M3.4 2.2V5h2.8M12.6 13.8V11H9.8"/>',
		camera: '<path d="M2 5.2h2.9l1.2-1.8h3.8l1.2 1.8H14v8H2z"/><circle cx="8" cy="9" r="2.3"/>',
		arrowR: '<path d="M2.6 8h10.4M9.4 4.4 13 8l-3.6 3.6"/>',
		arrowL: '<path d="M13.4 8H3M6.6 4.4 3 8l3.6 3.6"/>',
		comment: '<path d="M2.4 3h11.2v7.8H7l-3 2.6v-2.6H2.4z"/>',
		plus: '<path d="M8 3v10M3 8h10"/>',
		json: '<path d="M5.6 2.4c-1.4 0-2 .6-2 1.9v1.4c0 1.1-.5 1.9-1.6 2.3 1.1.4 1.6 1.2 1.6 2.3v1.4c0 1.3.6 1.9 2 1.9M10.4 2.4c1.4 0 2 .6 2 1.9v1.4c0 1.1.5 1.9 1.6 2.3-1.1.4-1.6 1.2-1.6 2.3v1.4c0 1.3-.6 1.9-2 1.9"/>',
		image: '<rect x="1.8" y="2.6" width="12.4" height="10.8" rx="1.3"/><circle cx="5.6" cy="6.2" r="1.3"/><path d="m2.4 12.4 3.9-3.8 2.6 2.4 2-1.8 3.1 3"/>',
		refresh: '<path d="M13.2 7.4A5.3 5.3 0 1 1 11.6 3.6M13.4 2.4v3.4H10"/>',
	};
	const UNIT_ICONS = { container: 'cube', function: 'lambda', database: 'database', cache: 'cache', queue: 'queue', device: 'chip', client: 'person', external: 'globe', balancer: 'balancer' };
	const UNIT_KINDS = { container: 'backend', function: 'backend', database: 'data', cache: 'data', queue: 'queue', device: 'embedded', client: 'mobile', external: 'external', balancer: 'backend' };
	const ZONE_ICONS = { cloud: 'cloud', cluster: 'hexagon', host: 'service', users: 'person', devices: 'pin', external: 'globe' };

	// ------------------------------------------------------------------ small helpers

	const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' };
	const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ESC[c]);
	const NF = new Intl.NumberFormat('pt-BR');
	const num = n => NF.format(Math.round(n ?? 0));
	const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : many}`;
	const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
	const r1 = v => Math.round(v * 10) / 10;
	const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
	const byName = (a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), 'pt-BR', { numeric: true, sensitivity: 'base' });

	/** Compact line counts: 212, 4.210, 9,8 mil, 61 mil, 1,2 mi. */
	function compact(n) {
		n = n ?? 0;
		if (n < 10000) {
			return num(n);
		}
		if (n < 1e6) {
			const v = n / 1000;
			return `${v < 100 ? String(Math.round(v * 10) / 10).replace('.', ',') : Math.round(v)} mil`;
		}
		return `${String(Math.round(n / 1e5) / 10).replace('.', ',')} mi`;
	}

	function icon(name, cls = '') {
		return `<svg class="as-ic ${cls}" viewBox="0 0 16 16" aria-hidden="true">${ICONS[name] ?? ICONS.circle}</svg>`;
	}

	/** Icon placed inside an SVG drawing (presentation attributes so exports keep it). */
	function iconAt(name, x, y, size = 15, cls = '') {
		const spin = /spin/.test(cls);
		const paths = ICONS[name] ?? ICONS.circle;
		return `<g class="${cls.replace(/spin/, '').trim()}" transform="translate(${r1(x)},${r1(y)}) scale(${(size / 16).toFixed(4)})" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${spin ? `<g class="spin">${paths}</g>` : paths}</g>`;
	}

	// Text measurement with a canvas, so SVG text can be clipped exactly.
	const measureCtx = document.createElement('canvas').getContext('2d');
	let fontFamily = '"Segoe WPC", "Segoe UI", sans-serif';
	const widthCache = new Map();
	function textW(text, size = 13, weight = 400) {
		const key = `${weight}|${size}|${text}`;
		let w = widthCache.get(key);
		if (w === undefined) {
			if (widthCache.size > 30000) {
				widthCache.clear();
			}
			measureCtx.font = `${weight} ${size}px ${fontFamily}`;
			w = measureCtx.measureText(String(text)).width;
			widthCache.set(key, w);
		}
		return w;
	}
	function clip(text, maxW, size = 13, weight = 400) {
		text = String(text ?? '');
		if (maxW <= 8) {
			return '';
		}
		if (textW(text, size, weight) <= maxW) {
			return text;
		}
		let lo = 0, hi = text.length;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (textW(text.slice(0, mid) + '…', size, weight) <= maxW) {
				lo = mid;
			} else {
				hi = mid - 1;
			}
		}
		return lo > 0 ? text.slice(0, lo).trimEnd() + '…' : '';
	}

	function relTime(iso) {
		const t = Date.parse(iso ?? '');
		if (!t) {
			return 'Atualizado';
		}
		const min = Math.floor((Date.now() - t) / 60000);
		if (min < 1) {
			return 'Atualizado agora';
		}
		if (min < 60) {
			return `Atualizado há ${min} min`;
		}
		const h = Math.floor(min / 60);
		if (h < 24) {
			return `Atualizado há ${h} h`;
		}
		const d = new Date(t);
		return `Atualizado em ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
	}

	// ------------------------------------------------------------------ state

	const saved = (() => {
		try {
			return host.getState() || {};
		} catch {
			return {};
		}
	})();

	const S = {
		ctx: null,
		raw: {},
		files: {},
		filesError: null,
		model: null,
		idx: null,
		progress: null,
		view: null,
		paths: null,
		proposal: null,
		running: false,
		executions: new Set(),
		partialText: null,
		partialModel: null,
		mode: MODES[saved.mode] ? saved.mode : 'map',
		prevMode: MODES[saved.prevMode] && saved.prevMode !== 'present' ? saved.prevMode : 'map',
		scope: saved.scope ?? null,
		sel: saved.sel ?? null,
		open: new Set(Array.isArray(saved.open) ? saved.open : []),
		highlight: new Set(Array.isArray(saved.highlight) ? saved.highlight : []),
		note: typeof saved.note === 'string' ? saved.note : null,
		lastViewRev: saved.lastViewRev ?? null,
		vp: saved.vp && typeof saved.vp === 'object' ? saved.vp : {},
		insp: saved.insp !== false,
		proposalOn: !!saved.proposalOn,
		pathId: saved.pathId ?? null,
		step: saved.step ?? 0,
		playing: false,
		matrixCell: null,
		cols: saved.cols ?? null,
		layers: saved.layers ?? {},
		search: { open: false, q: '', hits: [], i: -1 },
		menu: null,
		code: { path: null, text: null, error: null, loading: false, truncated: false, req: null },
		drawing: null,
		barLevel: 0,
	};

	let persistTimer = 0;
	function persist() {
		clearTimeout(persistTimer);
		persistTimer = setTimeout(() => {
			const vp = {};
			const keys = Object.keys(S.vp).slice(-24);
			for (const k of keys) {
				vp[k] = S.vp[k];
			}
			try {
				host.setState({
					mode: S.mode, prevMode: S.prevMode, scope: S.scope, sel: S.sel, open: [...S.open].slice(0, 40),
					lastViewRev: S.lastViewRev, insp: S.insp, proposalOn: S.proposalOn, pathId: S.pathId, step: S.step,
					cols: S.cols, layers: S.layers, vp, highlight: [...S.highlight].slice(0, 40), note: S.note,
				});
			} catch {
				// The host may refuse oversized state; the interface keeps working without it.
			}
		}, 120);
	}

	// ------------------------------------------------------------------ model index

	function buildIndex(model) {
		const nodes = Array.isArray(model?.nodes) ? model.nodes.filter(n => n && typeof n.id === 'string') : [];
		const links = Array.isArray(model?.links) ? model.links.filter(l => l && typeof l.from === 'string' && typeof l.to === 'string') : [];
		const byId = new Map();
		const byPath = new Map();
		for (const n of nodes) {
			if (typeof n.name !== 'string' || !n.name.trim()) {
				n.name = n.id.replace(/^[a-z]:/, '').split('/').pop() || n.id;
			}
			if (!['system', 'service', 'file', 'data', 'queue', 'external'].includes(n.level)) {
				n.level = n.id.startsWith('f:') ? 'file' : n.id.startsWith('v:') ? 'service' : n.id.startsWith('d:') ? 'data' : n.id.startsWith('q:') ? 'queue' : n.id.startsWith('x:') ? 'external' : 'system';
			}
			byId.set(n.id, n);
			if (n.level === 'file' && typeof n.path === 'string') {
				byPath.set(n.path, n);
			}
		}
		const kids = new Map();
		const tops = [];
		for (const n of nodes) {
			if (n.parent && byId.has(n.parent) && n.parent !== n.id) {
				let list = kids.get(n.parent);
				if (!list) {
					kids.set(n.parent, list = []);
				}
				list.push(n);
			} else {
				tops.push(n);
			}
		}
		const linkById = new Map();
		const out = new Map(), inc = new Map();
		const evidence = new Map();
		let seq = 0;
		for (const l of links) {
			if (!l.id) {
				l.id = `_l${++seq}`;
			}
			if (!LEVEL_RANK.hasOwnProperty(l.level)) {
				l.level = 'service';
			}
			linkById.set(l.id, l);
			(out.get(l.from) ?? out.set(l.from, []).get(l.from)).push(l);
			(inc.get(l.to) ?? inc.set(l.to, []).get(l.to)).push(l);
			if (Array.isArray(l.evidence)) {
				for (const e of l.evidence) {
					if (e && typeof e.path === 'string') {
						(evidence.get(e.path) ?? evidence.set(e.path, []).get(e.path)).push({ line: e.line | 0, link: l });
					}
				}
			}
		}
		const topCache = new Map();
		const idx = {
			byId, byPath, kids, tops, links, linkById, out, inc, evidence,
			topOf(id) {
				let hit = topCache.get(id);
				if (hit !== undefined) {
					return hit;
				}
				let cur = byId.get(id), guard = 0;
				while (cur && cur.parent && byId.has(cur.parent) && guard++ < 8) {
					cur = byId.get(cur.parent);
				}
				hit = cur ? cur.id : null;
				topCache.set(id, hit);
				return hit;
			},
			chain(id) {
				const list = [];
				let cur = byId.get(id), guard = 0;
				while (cur && guard++ < 8) {
					list.push(cur.id);
					cur = cur.parent ? byId.get(cur.parent) : null;
				}
				return list;
			},
			children(id) {
				return kids.get(id) ?? [];
			},
		};
		// Systems with no recorded size get it from their files.
		const size = n => {
			const list = kids.get(n.id);
			if (!list || !list.length) {
				return [n.level === 'file' ? 1 : (n.files ?? 0), n.lines ?? 0];
			}
			let f = 0, ln = 0;
			for (const c of list) {
				const [a, b] = size(c);
				f += a;
				ln += b;
			}
			if (!n.files) {
				n.files = f;
			}
			if (!n.lines) {
				n.lines = ln;
			}
			return [n.files, n.lines];
		};
		for (const t of tops) {
			size(t);
		}
		idx.systems = tops.filter(n => n.level === 'system');
		idx.stats = {
			systems: idx.systems.length,
			services: nodes.filter(n => n.level === 'service').length,
			files: nodes.filter(n => n.level === 'file').length,
			links: links.length,
		};
		return idx;
	}

	const node = id => (id && S.idx ? S.idx.byId.get(id) : null) ?? null;
	const kidsOf = id => (S.idx ? S.idx.children(id) : []);
	const hasKids = n => !!n && kidsOf(n.id).length > 0;
	const isTopLevelLeaf = n => n && (n.level === 'data' || n.level === 'queue' || n.level === 'external');
	const isClientKind = kind => kind === 'mobile' || kind === 'web' || kind === 'desktop' || kind === 'embedded';

	function colorOf(n) {
		if (!n) {
			return KINDS.backend.c;
		}
		if (n.level === 'file') {
			return LANG_COLORS[n.lang] ?? KINDS.file.c;
		}
		if (n.role && ROLES[n.role]) {
			return ROLES[n.role].c;
		}
		return (KINDS[n.kind] ?? KINDS.backend).c;
	}
	function iconOf(n) {
		if (!n) {
			return 'circle';
		}
		if (n.level === 'file') {
			return /^(sql)$/.test(n.lang) ? 'database' : /^(yaml|yml|json|toml)$/.test(n.lang) ? 'braces' : 'file';
		}
		if (n.role && ROLES[n.role] && n.level !== 'system') {
			return ROLES[n.role].icon;
		}
		if (n.level === 'service' && (n.kind === 'backend' || !n.kind)) {
			return 'service';
		}
		return (KINDS[n.kind] ?? KINDS.backend).icon;
	}
	function childWords(n) {
		if (!n) {
			return ['item', 'itens'];
		}
		if (n.level === 'system') {
			const list = kidsOf(n.id);
			const roles = list.filter(c => c.role && c.role !== 'service').length;
			return roles * 2 >= list.length && list.length ? ['módulo', 'módulos'] : isClientKind(n.kind) && !list.length ? ['módulo', 'módulos'] : ['serviço', 'serviços'];
		}
		return ['arquivo', 'arquivos'];
	}
	function levelWord(n) {
		if (!n) {
			return '';
		}
		if (n.level === 'system') {
			return 'sistema';
		}
		if (n.level === 'service') {
			if (n.role && ROLES[n.role] && n.role !== 'service') {
				return ROLES[n.role].one;
			}
			const sys = node(n.parent);
			return sys && childWords(sys)[0] === 'módulo' ? 'módulo' : 'serviço';
		}
		if (n.level === 'file') {
			return 'arquivo';
		}
		return { data: 'dados', queue: 'fila', external: 'externo' }[n.level] ?? '';
	}
	function sizeText(n) {
		if (!n) {
			return '';
		}
		if (n.level === 'file') {
			return n.lines ? plural(n.lines, 'linha', 'linhas') : '';
		}
		const k = kidsOf(n.id).length;
		const [one, many] = childWords(n);
		const parts = [];
		if (k && n.level === 'system') {
			parts.push(plural(k, one, many));
		}
		if (n.files) {
			parts.push(plural(n.files, 'arquivo', 'arquivos'));
		}
		return parts.join(' · ');
	}

	// ------------------------------------------------------------------ scopes and the visible graph

	/** Top-level items drawn at the root: systems plus data, queues and externals that have system links. */
	function rootItems() {
		const idx = S.idx;
		const sysLinked = new Set();
		const anyLinked = new Set();
		for (const l of idx.links) {
			anyLinked.add(l.from);
			anyLinked.add(l.to);
			if (l.level === 'system') {
				sysLinked.add(l.from);
				sysLinked.add(l.to);
			}
		}
		return idx.tops.filter(n => n.level === 'system' || n.level === 'service' || n.level === 'file' || sysLinked.has(n.id) || (!anyLinked.has(n.id) && isTopLevelLeaf(n)));
	}

	function scopeOf(id) {
		// The scope that shows a node: root for top-level, its parent otherwise.
		const n = node(id);
		if (!n) {
			return null;
		}
		return n.parent && node(n.parent) ? n.parent : null;
	}

	function validScope(id) {
		const n = node(id);
		return n && hasKids(n) && (n.level === 'system' || n.level === 'service') ? id : null;
	}

	/**
	 * Builds the drawable graph of a scope: inside items (with nodes opened in place), outside
	 * representatives for links that leave the scope, and merged edges between representatives.
	 */
	function sceneGraph(scopeId, opts = {}) {
		const idx = S.idx;
		const open = opts.open ?? S.open;
		const prop = opts.proposal ?? null;
		const scopeNode = node(scopeId);
		const scopeSystem = scopeNode ? idx.topOf(scopeNode.id) : null;
		const inside = new Map(); // id -> { n, box: parent box id or null, depth }
		const hidden = new Map(); // id of a child not shown -> box id
		const items = scopeNode ? kidsOf(scopeNode.id).slice() : rootItems();
		const added = [];
		if (prop) {
			for (const p of prop.nodes) {
				if (p.op === 'add' && !idx.byId.has(p.id)) {
					added.push(p);
				}
			}
		}
		const addInside = (n, box, depth) => {
			inside.set(n.id, { n, box, depth });
			if (depth < 2 && open.has(n.id) && hasKids(n) && n.level !== 'file') {
				let list = kidsOf(n.id).slice();
				if (n.level === 'service') {
					list = pickFilesForBox(n, list);
					for (const c of kidsOf(n.id)) {
						if (!list.includes(c)) {
							hidden.set(c.id, n.id);
						}
					}
				}
				for (const c of list) {
					addInside(c, n.id, depth + 1);
				}
				for (const p of added) {
					if (p.parent === n.id) {
						addInside(p, n.id, depth + 1);
					}
				}
			}
		};
		for (const n of items) {
			addInside(n, null, 0);
		}
		for (const p of added) {
			if ((p.parent ?? null) === (scopeId ?? null) || (!scopeId && !p.parent)) {
				addInside(p, null, 0);
			}
		}
		const outside = new Map();
		const rankOf = id => {
			const n = node(id) ?? inside.get(id)?.n;
			const r = n ? LEVEL_RANK[n.level] : undefined;
			return r === undefined ? -1 : r;
		};
		let boxIds = null;
		const isOpenBox = id => {
			if (!boxIds) {
				boxIds = new Set();
				for (const v of inside.values()) {
					if (v.box) {
						boxIds.add(v.box);
					}
				}
			}
			return boxIds.has(id);
		};
		const rep = id => {
			if (inside.has(id)) {
				return id;
			}
			const chain = idx.byId.has(id) ? idx.chain(id) : [id];
			for (const a of chain) {
				if (inside.has(a)) {
					return a;
				}
			}
			if (!idx.byId.has(id)) {
				return null;
			}
			// Outside the scope.
			if (scopeNode && chain.includes(scopeNode.id)) {
				return null; // the scope itself or one of its hidden descendants
			}
			if (scopeNode && scopeNode.level === 'service' && chain.includes(scopeSystem)) {
				const sib = chain.find(a => node(a)?.level === 'service');
				return sib && sib !== scopeNode.id ? sib : null;
			}
			const topId = chain[chain.length - 1];
			if (scopeNode && topId === scopeSystem) {
				return null;
			}
			return topId;
		};
		const groups = new Map();
		const coarse = [];
		const consider = (l, extra) => {
			const ra = rep(l.from), rb = rep(l.to);
			if (!ra || !rb || ra === rb) {
				return;
			}
			if (!inside.has(ra) && !inside.has(rb)) {
				return;
			}
			const ca = idx.byId.has(ra) ? idx.chain(ra) : [ra], cb = idx.byId.has(rb) ? idx.chain(rb) : [rb];
			if (ca.includes(rb) || cb.includes(ra)) {
				return; // containment
			}
			if (!extra) {
				const need = Math.max(0, rankOf(ra) + (isOpenBox(ra) ? 1 : 0), rankOf(rb) + (isOpenBox(rb) ? 1 : 0));
				if (LEVEL_RANK[l.level] !== need) {
					if (LEVEL_RANK[l.level] < need && (isOpenBox(ra) || isOpenBox(rb))) {
						coarse.push({ l, ra, rb });
					}
					return;
				}
			}
			const key = `${ra}>${rb}`;
			let g = groups.get(key);
			if (!g) {
				groups.set(key, g = { id: key, from: ra, to: rb, links: [], extra: [] });
			}
			if (extra) {
				g.extra.push(extra);
			} else {
				g.links.push(l);
			}
			for (const r of [ra, rb]) {
				if (!inside.has(r) && !outside.has(r)) {
					outside.set(r, node(r));
				}
			}
		};
		// Only links that can touch the scope.
		for (const l of idx.links) {
			if (scopeNode) {
				const fa = idx.chain(l.from), fb = idx.chain(l.to);
				const key = scopeNode.level === 'system' ? scopeSystem : scopeNode.id;
				if (!fa.includes(key) && !fb.includes(key)) {
					continue;
				}
			}
			consider(l, null);
		}
		// A summary link to an opened box stays when no finer link already connects the same parts.
		for (const c of coarse) {
			const box = isOpenBox(c.rb) ? c.rb : c.ra;
			const other = box === c.rb ? c.ra : c.rb;
			const within = id => idx.byId.has(id) && idx.chain(id).includes(box);
			let finer = false;
			for (const g of groups.values()) {
				if ((g.from === other && within(g.to)) || (g.to === other && within(g.from))) {
					finer = true;
					break;
				}
			}
			if (!finer) {
				const key = `${c.ra}>${c.rb}`;
				const g = groups.get(key) ?? groups.set(key, { id: key, from: c.ra, to: c.rb, links: [], extra: [] }).get(key);
				g.links.push(c.l);
			}
		}
		if (prop) {
			for (const pl of prop.links) {
				if (pl.op === 'add' || pl.op === 'remove' || pl.op === 'change') {
					consider({ from: pl.from, to: pl.to, level: 'service' }, pl);
				}
			}
		}
		const edges = [];
		for (const g of groups.values()) {
			const ls = g.links;
			const labels = [...new Set(ls.map(l => l.label || (QUIET_PROTOCOLS.has(String(l.protocol ?? '').toLowerCase()) ? '' : l.protocol)).filter(Boolean))];
			let label = labels.length === 1 ? labels[0] : labels.length === 2 && (labels[0].length + labels[1].length) < 24 ? `${labels[0]} · ${labels[1]}` : labels.length > 1 ? `${ls.length} ligações` : '';
			const count = ls.reduce((a, l) => a + (Number(l.count) || 1), 0);
			const edge = {
				id: g.id, from: g.from, to: g.to, links: ls, linkIds: new Set(ls.map(l => l.id)), count,
				async: ls.length > 0 && ls.every(l => !!l.async), label, op: null,
			};
			for (const x of g.extra) {
				if (x.op === 'add') {
					if (!ls.length) {
						edge.op = 'add';
						edge.label = x.label ?? '';
						edge.async = !!x.async;
					}
				} else if (x.op === 'remove') {
					edge.op = 'del';
					edge.label = x.label ?? edge.label;
				} else if (x.op === 'change') {
					edge.op = 'chg';
					edge.label = x.label ?? edge.label;
				}
			}
			if (!ls.length && !edge.op) {
				continue;
			}
			edges.push(edge);
		}
		return { scopeId, scopeNode, inside, outside, hidden, edges, rep, open };
	}

	/** Files shown when a service is opened in place: the most connected and largest, up to 12. */
	function pickFilesForBox(service, files) {
		if (files.length <= 12) {
			return files.slice().sort(byName);
		}
		const deg = f => (S.idx.out.get(f.id)?.length ?? 0) + (S.idx.inc.get(f.id)?.length ?? 0);
		return files.slice().sort((a, b) => (deg(b) - deg(a)) || ((b.lines ?? 0) - (a.lines ?? 0))).slice(0, 11).sort(byName);
	}

	/** Role bands apply when most items of a scope carry client or embedded roles. */
	function bandKind(list) {
		let client = 0, emb = 0;
		for (const n of list) {
			if (CLIENT_BANDS.includes(n.role)) {
				client++;
			} else if (EMBEDDED_BANDS.includes(n.role)) {
				emb++;
			}
		}
		if (list.length < 2) {
			return null;
		}
		if (emb >= client && emb * 2 >= list.length) {
			return 'embedded';
		}
		if (client * 2 >= list.length) {
			return 'client';
		}
		return null;
	}

	// ------------------------------------------------------------------ layered layout

	/** Weighted isotonic regression (pool adjacent violators): non-decreasing fit of vals. */
	function isotonic(vals, weights) {
		const blocks = [];
		for (let i = 0; i < vals.length; i++) {
			blocks.push({ v: vals[i], w: weights[i], n: 1 });
			while (blocks.length > 1 && blocks[blocks.length - 2].v > blocks[blocks.length - 1].v) {
				const b = blocks.pop(), a = blocks[blocks.length - 1];
				a.v = (a.v * a.w + b.v * b.w) / (a.w + b.w);
				a.w += b.w;
				a.n += b.n;
			}
		}
		const res = [];
		for (const b of blocks) {
			for (let k = 0; k < b.n; k++) {
				res.push(b.v);
			}
		}
		return res;
	}

	/**
	 * Layered (Sugiyama-style) layout. Items: { id, w, h, band?, pinEnd?, sink? }. Edges: { id, from, to }.
	 * opts.dir 'h' flows left to right (layers are columns), 'v' top to bottom (layers are rows).
	 * Long edges get waypoints through virtual items so they pass between nodes.
	 */
	function layered(items, edges, opts = {}) {
		const H = (opts.dir ?? 'h') === 'h';
		const gapMain = opts.gapMain ?? 120;
		const gapCross = opts.gapCross ?? 28;
		const byId = new Map(items.map(it => [it.id, it]));
		const E = [];
		const seen = new Set();
		for (const e of edges) {
			if (!byId.has(e.from) || !byId.has(e.to) || e.from === e.to) {
				continue;
			}
			E.push(e);
			seen.add(e.from);
			seen.add(e.to);
		}
		const bandsMode = !!opts.bands;
		const loose = bandsMode ? [] : items.filter(it => !seen.has(it.id));
		const core = bandsMode ? items : items.filter(it => seen.has(it.id));
		const layer = new Map();
		const rev = new Set();
		const dOut = new Map(), dIn = new Map();
		for (const it of core) {
			dOut.set(it.id, []);
			dIn.set(it.id, []);
		}
		if (bandsMode) {
			for (const it of core) {
				layer.set(it.id, it.band ?? 0);
			}
			for (const e of E) {
				if (layer.get(e.from) > layer.get(e.to)) {
					rev.add(e.id);
				}
			}
		} else {
			const outs = new Map(core.map(it => [it.id, []]));
			const insCount = new Map(core.map(it => [it.id, 0]));
			for (const e of E) {
				outs.get(e.from).push(e);
				insCount.set(e.to, insCount.get(e.to) + 1);
			}
			const state = new Map();
			const order = core.map(it => it.id).sort((a, b) => insCount.get(a) - insCount.get(b));
			const visit = v => {
				state.set(v, 1);
				for (const e of outs.get(v)) {
					const s = state.get(e.to) ?? 0;
					if (s === 1) {
						rev.add(e.id);
					} else if (s === 0) {
						visit(e.to);
					}
				}
				state.set(v, 2);
			};
			for (const v of order) {
				if (!state.get(v)) {
					visit(v);
				}
			}
		}
		for (const e of E) {
			const [a, b] = rev.has(e.id) ? [e.to, e.from] : [e.from, e.to];
			dOut.get(a).push(b);
			dIn.get(b).push(a);
		}
		if (!bandsMode) {
			const indeg = new Map(core.map(it => [it.id, dIn.get(it.id).length]));
			const queue = core.filter(it => !indeg.get(it.id)).map(it => it.id);
			const topo = [];
			while (queue.length) {
				const v = queue.shift();
				topo.push(v);
				for (const w of dOut.get(v)) {
					indeg.set(w, indeg.get(w) - 1);
					if (!indeg.get(w)) {
						queue.push(w);
					}
				}
			}
			for (const it of core) {
				if (!topo.includes(it.id)) {
					topo.push(it.id);
				}
			}
			for (const v of topo) {
				let l = 0;
				for (const u of dIn.get(v)) {
					l = Math.max(l, (layer.get(u) ?? 0) + 1);
				}
				layer.set(v, l);
			}
			for (let i = topo.length - 1; i >= 0; i--) {
				const v = topo[i];
				const succ = dOut.get(v);
				if (succ.length) {
					const m = Math.min(...succ.map(w => layer.get(w))) - 1;
					if (m > layer.get(v)) {
						layer.set(v, m);
					}
				}
			}
			let maxL = 0;
			for (const it of core) {
				if (!(it.sink && !dOut.get(it.id).length)) {
					maxL = Math.max(maxL, layer.get(it.id));
				}
			}
			// Data, queues and externals that only receive go right after their callers, and into the last
			// column while it still has room, so they gather on the far side without overflowing it.
			const sinks = core.filter(it => it.sink && !dOut.get(it.id).length && dIn.get(it.id).length);
			let lastL = maxL;
			for (const it of sinks) {
				let l = maxL;
				for (const u of dIn.get(it.id)) {
					l = Math.max(l, layer.get(u) + 1);
				}
				layer.set(it.id, l);
				lastL = Math.max(lastL, l);
			}
			const room = (opts.cap || Infinity) - core.filter(it => layer.get(it.id) === lastL).length;
			sinks.filter(it => layer.get(it.id) < lastL).sort((x, y) => layer.get(y.id) - layer.get(x.id)).slice(0, Math.max(0, room)).forEach(it => layer.set(it.id, lastL));
			// Wrap very long layers into neighbouring sub-columns.
			const cap = opts.cap ?? 0;
			if (cap) {
				const per = new Map();
				for (const it of core) {
					const l = layer.get(it.id);
					(per.get(l) ?? per.set(l, []).get(l)).push(it.id);
				}
				const levels = [...per.keys()].sort((a, b) => a - b);
				let shift = 0;
				for (const l of levels) {
					const list = per.get(l);
					const k = Math.max(1, Math.ceil(list.length / cap));
					list.forEach((id, i) => layer.set(id, l + shift + (i % k)));
					shift += k - 1;
				}
			}
		}
		// Virtual items for edges that span several layers.
		const all = new Map(core.map(it => [it.id, it]));
		const chain = new Map();
		const up = new Map(), down = new Map();
		for (const id of all.keys()) {
			up.set(id, []);
			down.set(id, []);
		}
		const link = (u, v) => {
			down.get(u).push(v);
			up.get(v).push(u);
		};
		const same = [];
		for (const e of E) {
			const [a, b] = rev.has(e.id) ? [e.to, e.from] : [e.from, e.to];
			const la = layer.get(a), lb = layer.get(b);
			if (la === lb) {
				same.push(e);
				continue;
			}
			let prev = a;
			const ids = [];
			for (let k = la + 1; k < lb; k++) {
				const id = `~${e.id}~${k}`;
				all.set(id, { id, w: H ? 0 : 12, h: H ? 12 : 0, dummy: true });
				layer.set(id, k);
				up.set(id, []);
				down.set(id, []);
				link(prev, id);
				ids.push(id);
				prev = id;
			}
			link(prev, b);
			chain.set(e.id, ids);
		}
		let maxLayer = 0;
		for (const id of all.keys()) {
			maxLayer = Math.max(maxLayer, layer.get(id));
		}
		const layers = Array.from({ length: maxLayer + 1 }, () => []);
		for (const id of all.keys()) {
			layers[layer.get(id)].push(id);
		}
		const pos = new Map();
		const reindex = () => layers.forEach(list => list.forEach((id, i) => pos.set(id, i)));
		reindex();
		const crossings = () => {
			let c = 0;
			for (let l = 0; l < maxLayer; l++) {
				const segs = [];
				for (const u of layers[l]) {
					for (const v of down.get(u)) {
						segs.push([pos.get(u), pos.get(v)]);
					}
				}
				for (let i = 0; i < segs.length; i++) {
					for (let j = i + 1; j < segs.length; j++) {
						if ((segs[i][0] - segs[j][0]) * (segs[i][1] - segs[j][1]) < 0) {
							c++;
						}
					}
				}
			}
			return c;
		};
		const sameNb = new Map();
		for (const e of same) {
			(sameNb.get(e.from) ?? sameNb.set(e.from, []).get(e.from)).push(e.to);
			(sameNb.get(e.to) ?? sameNb.set(e.to, []).get(e.to)).push(e.from);
		}
		const crossingsAll = () => {
			let c = crossings();
			for (const e of same) {
				c += Math.max(0, Math.abs(pos.get(e.from) - pos.get(e.to)) - 1);
			}
			return c;
		};
		let best = layers.map(l => l.slice());
		let bestC = crossingsAll();
		for (let it = 0; it < 10 && bestC > 0; it++) {
			const forward = it % 2 === 0;
			const seq = forward ? layers.map((_, i) => i).slice(1) : layers.map((_, i) => i).reverse().slice(1);
			for (const l of seq) {
				const list = layers[l];
				const key = new Map();
				for (const id of list) {
					const nb = (forward ? up.get(id) : down.get(id)).map(n => pos.get(n));
					for (const n of sameNb.get(id) ?? []) {
						nb.push(pos.get(n));
					}
					key.set(id, nb.length ? nb.reduce((a, v) => a + v, 0) / nb.length : pos.get(id));
				}
				list.sort((a, b) => {
					const pa = all.get(a).pinEnd ? 1 : 0, pb = all.get(b).pinEnd ? 1 : 0;
					return (pa - pb) || (key.get(a) - key.get(b));
				});
				list.forEach((id, i) => pos.set(id, i));
			}
			const c = crossingsAll();
			if (c < bestC) {
				bestC = c;
				best = layers.map(x => x.slice());
			}
		}
		for (let l = 0; l <= maxLayer; l++) {
			layers[l] = best[l];
		}
		reindex();
		// Cross-axis coordinates.
		const sz = id => {
			const it = all.get(id);
			return H ? it.h : it.w;
		};
		const gapOf = (a, b) => {
			const da = all.get(a).dummy, db = all.get(b).dummy;
			let g = da && db ? 8 : da || db ? 14 : gapCross;
			if (all.get(b).pinEnd && !all.get(a).pinEnd) {
				g += 50;
			}
			return g;
		};
		const c = new Map();
		for (const list of layers) {
			let y = 0;
			list.forEach((id, i) => {
				c.set(id, y);
				y += sz(id) + (i < list.length - 1 ? gapOf(id, list[i + 1]) : 0);
			});
			for (const id of list) {
				c.set(id, c.get(id) - y / 2);
			}
		}
		const center = id => c.get(id) + sz(id) / 2;
		for (let it = 0; it < 12; it++) {
			const mode = it < 8 ? (it % 2 === 0 ? 'up' : 'down') : 'both';
			const seq = mode === 'down' ? layers.map((_, i) => i).reverse() : layers.map((_, i) => i);
			for (const l of seq) {
				const list = layers[l];
				if (!list.length) {
					continue;
				}
				const vals = [], weights = [];
				let acc = 0;
				list.forEach((id, i) => {
					const nb = mode === 'up' ? up.get(id) : mode === 'down' ? down.get(id) : up.get(id).concat(down.get(id));
					let t, w;
					if (nb.length) {
						t = nb.reduce((a, n) => a + center(n), 0) / nb.length - sz(id) / 2;
						w = nb.length * (all.get(id).dummy ? 2 : 1);
					} else {
						t = c.get(id);
						w = 0.05;
					}
					vals.push(t - acc);
					weights.push(w);
					acc += sz(id) + (i < list.length - 1 ? gapOf(id, list[i + 1]) : 0);
				});
				const fit = isotonic(vals, weights);
				acc = 0;
				list.forEach((id, i) => {
					c.set(id, fit[i] + acc);
					acc += sz(id) + (i < list.length - 1 ? gapOf(id, list[i + 1]) : 0);
				});
			}
		}
		// Main-axis coordinates.
		const layerSize = layers.map(list => list.reduce((m, id) => Math.max(m, H ? all.get(id).w : all.get(id).h), 0));
		const mainPos = [];
		let acc = 0;
		for (let l = 0; l <= maxLayer; l++) {
			mainPos.push(acc);
			acc += (layerSize[l] || 24) + (l < maxLayer ? gapMain : 0);
		}
		let minC = Infinity, maxC = -Infinity;
		for (const id of all.keys()) {
			minC = Math.min(minC, c.get(id));
			maxC = Math.max(maxC, c.get(id) + sz(id));
		}
		if (!all.size) {
			minC = maxC = 0;
		}
		const out = new Map();
		const centerMain = opts.alignMain !== 'start';
		for (const [id, it] of all) {
			const l = layer.get(id);
			const mainSize = H ? it.w : it.h;
			const m = mainPos[l] + (centerMain ? (layerSize[l] - mainSize) / 2 : 0);
			const cc = c.get(id) - minC;
			out.set(id, H ? { x: m, y: cc, w: it.w, h: it.h } : { x: cc, y: m, w: it.w, h: it.h });
		}
		let W = H ? acc : maxC - minC, HH = H ? maxC - minC : acc;
		if (!core.length) {
			W = HH = 0;
		}
		// Loose items (no edges) go in a row below the graph.
		const looseHead = [];
		if (loose.length) {
			const side = core.length && W < HH * 1.25;
			if (side) {
				// Tall graph: unlinked items go in a column to its right.
				const left = W + 90;
				let x = left, y = 0, colW = 0;
				const maxH = Math.max(HH, 420);
				for (const it of loose) {
					if (y > 0 && y + it.h > maxH) {
						x += colW + 24;
						y = 0;
						colW = 0;
					}
					out.set(it.id, { x, y, w: it.w, h: it.h });
					y += it.h + 22;
					colW = Math.max(colW, it.w);
					HH = Math.max(HH, y - 22);
				}
				W = x + colW;
				looseHead.push({ text: 'Sem ligações', x: left, y: -14, muted: true });
			} else {
				const top = core.length ? HH + 70 : 0;
				const maxW = Math.max(W, 760);
				let x = 0, y = top, rowH = 0;
				for (const it of loose) {
					if (x > 0 && x + it.w > maxW) {
						x = 0;
						y += rowH + 22;
						rowH = 0;
					}
					out.set(it.id, { x, y, w: it.w, h: it.h });
					x += it.w + 24;
					rowH = Math.max(rowH, it.h);
					W = Math.max(W, x - 24);
				}
				HH = y + rowH;
				if (core.length) {
					looseHead.push({ text: 'Sem ligações', x: 0, y: top - 14, muted: true });
				}
			}
		}
		const way = new Map();
		for (const [eid, ids] of chain) {
			if (!ids.length) {
				continue;
			}
			const pts = ids.map(id => {
				const p = out.get(id);
				return { x: p.x + p.w / 2, y: p.y + p.h / 2 };
			});
			way.set(eid, rev.has(eid) ? pts.reverse() : pts);
		}
		for (const id of [...out.keys()]) {
			if (all.get(id)?.dummy) {
				out.delete(id);
			}
		}
		const bandAt = layers.map((list, l) => ({ main: mainPos[l], size: layerSize[l], band: core.find(it => layer.get(it.id) === l)?.band }));
		return { pos: out, way, layer, rev, w: W, h: HH, dir: H ? 'h' : 'v', bandAt, heads: looseHead, same };
	}

	// ------------------------------------------------------------------ edge geometry

	const SIDE = { l: [-1, 0], r: [1, 0], t: [0, -1], b: [0, 1] };

	function anchorOf(r, side, off) {
		switch (side) {
			case 'l': return { x: r.x, y: r.y + r.h / 2 + off };
			case 'r': return { x: r.x + r.w, y: r.y + r.h / 2 + off };
			case 't': return { x: r.x + r.w / 2 + off, y: r.y };
			default: return { x: r.x + r.w / 2 + off, y: r.y + r.h };
		}
	}

	/** Picks the sides of a free (unlayered) edge from the relative position of the two rectangles. */
	function freeSides(a, b) {
		const acx = a.x + a.w / 2, bcx = b.x + b.w / 2, acy = a.y + a.h / 2, bcy = b.y + b.h / 2;
		const gapX = bcx > acx ? b.x - (a.x + a.w) : a.x - (b.x + b.w);
		const gapY = bcy > acy ? b.y - (a.y + a.h) : a.y - (b.y + b.h);
		if (gapX > 16 && (gapX * 1.6 >= gapY || gapY < 24)) {
			return bcx > acx ? ['r', 'l'] : ['l', 'r'];
		}
		if (gapY > 8) {
			return bcy > acy ? ['b', 't'] : ['t', 'b'];
		}
		return bcx > acx ? ['r', 'l'] : ['l', 'r'];
	}

	function cubicAt(s, t) {
		const u = 1 - t;
		const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
		return { x: a * s[0].x + b * s[1].x + c * s[2].x + d * s[3].x, y: a * s[0].y + b * s[1].y + c * s[2].y + d * s[3].y };
	}

	/** Smooth path through anchor points with tangents leaving and entering along the given directions. */
	function buildPath(p0, s0, mids, p1, s1, H) {
		const pts = [p0, ...mids, p1];
		const dirs = [SIDE[s0]];
		for (let i = 1; i < pts.length - 1; i++) {
			const dx = pts[i + 1].x - pts[i - 1].x, dy = pts[i + 1].y - pts[i - 1].y;
			dirs.push(H ? [Math.sign(dx) || 1, 0] : [0, Math.sign(dy) || 1]);
		}
		const e = SIDE[s1];
		dirs.push([-e[0], -e[1]]);
		const segs = [];
		for (let i = 0; i < pts.length - 1; i++) {
			const p = pts[i], q = pts[i + 1], tp = dirs[i], tq = dirs[i + 1];
			const dist = Math.hypot(q.x - p.x, q.y - p.y);
			const proj = Math.abs((q.x - p.x) * tp[0] + (q.y - p.y) * tp[1]);
			let h = clamp(proj * 0.5, 18, 220);
			if (proj < 12 || (tp[0] === -tq[0] && tp[1] === -tq[1] && (tp[0] || tp[1]))) {
				h = clamp(28 + dist * 0.22, 28, 110);
			}
			segs.push([p, { x: p.x + tp[0] * h, y: p.y + tp[1] * h }, { x: q.x - tq[0] * h, y: q.y - tq[1] * h }, q]);
		}
		let d = `M${r1(p0.x)},${r1(p0.y)}`;
		for (const s of segs) {
			d += ` C${r1(s[1].x)},${r1(s[1].y)} ${r1(s[2].x)},${r1(s[2].y)} ${r1(s[3].x)},${r1(s[3].y)}`;
		}
		return { d, segs };
	}

	const overlaps = (a, b, pad = 0) => a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;

	/**
	 * Routes edges between positioned rectangles. Each edge: { id, a, b (rects), sides?, way?, label }.
	 * Spreads ports along node sides and places label pills where they do not cover nodes or other pills.
	 */
	function routeEdges(list, obstacles) {
		// Sides and far points.
		for (const e of list) {
			if (!e.sides) {
				e.sides = freeSides(e.a, e.b);
			}
			const firstFar = e.way?.length ? e.way[0] : { x: e.b.x + e.b.w / 2, y: e.b.y + e.b.h / 2 };
			const lastFar = e.way?.length ? e.way[e.way.length - 1] : { x: e.a.x + e.a.w / 2, y: e.a.y + e.a.h / 2 };
			e.farA = firstFar;
			e.farB = lastFar;
		}
		// Ports.
		const ports = new Map();
		const addPort = (rect, side, e, end, far) => {
			const key = `${rect.key}|${side}`;
			let p = ports.get(key);
			if (!p) {
				ports.set(key, p = { rect, side, list: [] });
			}
			p.list.push({ e, end, far });
		};
		for (const e of list) {
			addPort(e.a, e.sides[0], e, 'a', e.farA);
			addPort(e.b, e.sides[1], e, 'b', e.farB);
		}
		for (const p of ports.values()) {
			const vertical = p.side === 'l' || p.side === 'r';
			const len = vertical ? p.rect.h : p.rect.w;
			const n = p.list.length;
			p.list.sort((u, v) => vertical ? (u.far.y - v.far.y) : (u.far.x - v.far.x));
			const step = n > 1 ? Math.min(vertical ? 20 : 26, (len - 16) / (n - 1)) : 0;
			p.list.forEach((it, i) => {
				const off = (i - (n - 1) / 2) * step;
				it.e[it.end === 'a' ? 'offA' : 'offB'] = off;
			});
		}
		// Curves and labels.
		const placed = [];
		const obs = obstacles.map(r => ({ x: r.x - 3, y: r.y - 3, w: r.w + 6, h: r.h + 6 }));
		for (const e of list) {
			const p0 = anchorOf(e.a, e.sides[0], e.offA ?? 0), p1 = anchorOf(e.b, e.sides[1], e.offB ?? 0);
			const H = e.dir ? e.dir === 'h' : (e.sides[0] === 'l' || e.sides[0] === 'r');
			const g = buildPath(p0, e.sides[0], e.way ?? [], p1, e.sides[1], H);
			e.d = g.d;
			e.segs = g.segs;
			if (e.label) {
				const lw = Math.ceil(textW(e.label, 10.5, 400)) + 14, lh = 17;
				const segIdx = e.segs.length > 1 ? Math.floor(e.segs.length / 2) : 0;
				const order = [0.5, 0.4, 0.6, 0.3, 0.7, 0.22, 0.78];
				let best = null;
				for (const sIdx of [segIdx, ...e.segs.map((_, i) => i).filter(i => i !== segIdx)]) {
					for (const t of order) {
						const p = cubicAt(e.segs[sIdx], t);
						const box = { x: p.x - lw / 2, y: p.y - lh / 2, w: lw, h: lh };
						if (!obs.some(o => overlaps(o, box)) && !placed.some(o => overlaps(o, box, 2))) {
							best = box;
							break;
						}
					}
					if (best) {
						break;
					}
				}
				if (!best) {
					const p = cubicAt(e.segs[segIdx], 0.5);
					best = { x: p.x - lw / 2, y: p.y - lh / 2, w: lw, h: lh, crowded: true };
					if (obs.some(o => overlaps(o, best))) {
						best.onNode = true;
					}
				}
				placed.push(best);
				e.lab = best;
			}
		}
		return list;
	}

	// ------------------------------------------------------------------ map scene composition

	const STYLE_SIZE = { top: [240, 64], svc: [204, 58], band: [200, 56], file: [178, 46], inner: [172, 54], chip: [156, 32], more: [156, 32] };

	/** Child-name chips for a system node (backend-style systems only). */
	function chipsFor(n, width) {
		if (!n || n.level !== 'system') {
			return null;
		}
		const list = kidsOf(n.id);
		if (!list.length || list.length > 16 || childWords(n)[0] !== 'serviço') {
			return null;
		}
		const maxW = width - 24;
		const rows = [[]];
		let x = 0, shown = 0;
		for (const c of list) {
			const w = Math.min(maxW, Math.ceil(textW(c.name, 11)) + 14);
			if (x + w > maxW) {
				if (rows.length === 2) {
					break;
				}
				rows.push([]);
				x = 0;
			}
			rows[rows.length - 1].push({ text: c.name, w, x, id: c.id });
			x += w + 5;
			shown++;
		}
		let rest = list.length - shown;
		if (rest > 0) {
			const row = rows[rows.length - 1];
			let w = Math.ceil(textW(`+${rest}`, 11)) + 14;
			while (row.length && row[row.length - 1].x + row[row.length - 1].w + 5 + w > maxW) {
				row.pop();
				rest++;
				w = Math.ceil(textW(`+${rest}`, 11)) + 14;
			}
			const last = row[row.length - 1];
			row.push({ text: `+${rest}`, w, x: last ? last.x + last.w + 5 : 0, more: true });
		}
		return { rows };
	}

	function sizeItem(it) {
		if (it.kind === 'box') {
			return;
		}
		const [w, h] = STYLE_SIZE[it.style] ?? STYLE_SIZE.svc;
		it.w = w;
		it.h = h;
		if (it.style === 'top' && !it.ghost && !it.outside) {
			const chips = chipsFor(it.n, w);
			if (chips) {
				it.chips = chips;
				it.h = 52 + chips.rows.length * 23 + 26;
			}
		}
	}

	/** Lays out a scene graph: returns absolute rectangles for nodes and boxes, routed edges and headers. */
	function layoutScene(g, extra = {}) {
		const sc = g.scopeNode;
		const lvl = sc ? sc.level : 'root';
		const items = new Map();
		for (const [id, v] of g.inside) {
			items.set(id, { id, n: v.n, box: v.box, depth: v.depth, outside: false, kind: 'node' });
		}
		for (const [id, n] of g.outside) {
			items.set(id, { id, n, box: null, depth: 0, outside: true, kind: 'node' });
		}
		let folderMode = false;
		if (lvl === 'service') {
			const folders = new Map();
			for (const it of items.values()) {
				if (!it.outside && !it.box && it.n.level === 'file') {
					const f = it.n.folder ?? '';
					(folders.get(f) ?? folders.set(f, []).get(f)).push(it);
				}
			}
			if (folders.size >= 2) {
				folderMode = true;
				for (const [f, list] of folders) {
					const id = `folder:${f}`;
					items.set(id, { id, n: { id, name: f || '(raiz)', level: 'folder', kind: 'file' }, box: null, depth: 0, kind: 'box', boxType: 'folder' });
					for (const it of list) {
						it.box = id;
					}
				}
			}
		}
		const boxKids = new Map();
		for (const it of items.values()) {
			if (it.box) {
				(boxKids.get(it.box) ?? boxKids.set(it.box, []).get(it.box)).push(it.id);
			}
		}
		for (const [id] of boxKids) {
			const it = items.get(id);
			if (it && it.kind !== 'box') {
				it.kind = 'box';
				it.boxType = 'open';
			}
		}
		// "+N arquivos" cell for services opened with hidden files.
		for (const [boxId, list] of boxKids) {
			const box = items.get(boxId);
			if (box?.boxType === 'open' && box.n.level === 'service') {
				const hiddenCount = kidsOf(boxId).length - list.length;
				if (hiddenCount > 0) {
					const id = `more:${boxId}`;
					const more = { id, n: { id, name: `+${hiddenCount} arquivos`, level: 'more' }, box: boxId, kind: 'node', style: 'more', more: boxId };
					sizeItem(more);
					items.set(id, more);
					list.push(id);
				}
			}
		}
		const topBands = lvl === 'system' ? bandKind(kidsOf(sc.id)) : null;
		for (const it of items.values()) {
			if (it.kind === 'box' || it.style) {
				continue;
			}
			const parentBox = it.box ? items.get(it.box) : null;
			if (parentBox && parentBox.boxType === 'open') {
				it.style = it.n.level === 'file' ? 'chip' : 'inner';
			} else if (parentBox && parentBox.boxType === 'folder') {
				it.style = 'file';
			} else if (lvl === 'root') {
				it.style = 'top';
			} else if (lvl === 'service') {
				it.style = it.n.level === 'file' ? 'file' : 'svc';
			} else {
				it.style = topBands ? 'band' : 'svc';
			}
			sizeItem(it);
		}
		const boxChain = id => {
			const list = [];
			let cur = items.get(id)?.box ?? null, guard = 0;
			while (guard++ < 6) {
				list.push(cur);
				if (cur === null) {
					break;
				}
				cur = items.get(cur)?.box ?? null;
			}
			return list;
		};
		const memberIn = (id, container) => {
			let cur = id, guard = 0;
			while (cur && (items.get(cur)?.box ?? null) !== container && guard++ < 6) {
				cur = items.get(cur)?.box ?? null;
			}
			return cur;
		};
		const containerEdges = new Map();
		const edgeInfo = new Map();
		for (const e of g.edges) {
			if (!items.has(e.from) || !items.has(e.to)) {
				continue;
			}
			const ca = boxChain(e.from), cb = boxChain(e.to);
			const C = ca.find(x => cb.includes(x)) ?? null;
			const ma = memberIn(e.from, C), mb = memberIn(e.to, C);
			edgeInfo.set(e.id, { C, ma, mb });
			if (ma && mb && ma !== mb) {
				(containerEdges.get(C) ?? containerEdges.set(C, []).get(C)).push({ id: e.id, from: ma, to: mb, label: e.label });
			}
		}
		const labelGap = list => clamp(Math.max(0, ...list.map(e => (e.label ? textW(e.label, 10.5) + 40 : 0))), 96, 180);
		const results = new Map();
		const layoutContainer = (C, members) => {
			for (const m of members) {
				const it = items.get(m);
				if (it.kind === 'box') {
					layoutContainer(m, boxKids.get(m) ?? []);
				}
			}
			const its = members.map(m => items.get(m));
			const edgesC = containerEdges.get(C) ?? [];
			const owner = C ? items.get(C) : null;
			let res;
			if (owner && owner.boxType === 'folder') {
				res = gridLayout(its, its.length > 30 ? 3 : its.length > 9 ? 2 : 1, 12, 8);
			} else if (owner && owner.boxType === 'open' && owner.n.level === 'service') {
				res = gridLayout(its, its.length > 4 ? 2 : 1, 12, 8);
			} else {
				const bandsKind = owner ? bandKind(its.filter(i => !i.outside).map(i => i.n)) : topBands;
				if (bandsKind) {
					res = bandLayout(its, edgesC, bandsKind, !!owner);
				} else {
					const litems = its.map(i => ({ id: i.id, w: i.w, h: i.h, sink: i.outside || isTopLevelLeaf(i.n) }));
					const cap = Math.max(7, Math.ceil(Math.sqrt(its.length) * 1.5));
					res = layered(litems, edgesC, { dir: 'h', gapMain: labelGap(edgesC), gapCross: owner ? 22 : 30, cap });
					if (!owner && its.length > 3) {
						// Deep graphs read better top to bottom when that fits the canvas much better.
						const view = canvasSize();
						const aw = Math.max(400, view.w - 40), ah = Math.max(300, view.h - 80);
						const scoreOf = r => Math.min(1, aw / Math.max(1, r.w), ah / Math.max(1, r.h));
						const resV = layered(litems, edgesC, { dir: 'v', gapMain: 92, gapCross: 34, cap: Math.max(5, Math.ceil(Math.sqrt(its.length) * 1.2)) });
						if (scoreOf(resV) > scoreOf(res) * 1.18) {
							res = resV;
						}
					}
				}
			}
			results.set(C, res);
			if (owner) {
				const head = owner.boxType === 'folder' ? 32 : 44;
				const pad = owner.boxType === 'folder' ? 12 : 16;
				const minW = Math.ceil(textW(owner.n.name, 12.5, 600) + 110);
				owner.inner = { dx: pad - (res.minX ?? 0), dy: head - (res.minY ?? 0) };
				owner.w = Math.max(minW, res.w + pad * 2);
				owner.h = res.h + head + pad;
				if (owner.w > res.w + pad * 2) {
					owner.inner.dx += (owner.w - res.w - pad * 2) / 2;
				}
			}
		};
		const topMembers = [...items.values()].filter(it => !it.box).map(it => it.id);
		layoutContainer(null, topMembers);
		// Absolute positions.
		const rects = new Map();
		const place = (C, ox, oy) => {
			const res = results.get(C);
			for (const [id, p] of res.pos) {
				const it = items.get(id);
				if (!it) {
					continue;
				}
				it.x = ox + p.x;
				it.y = oy + p.y;
				rects.set(id, { x: it.x, y: it.y, w: it.w, h: it.h, key: id });
				if (it.kind === 'box') {
					place(id, it.x + it.inner.dx, it.y + it.inner.dy);
				}
			}
			res.ox = ox;
			res.oy = oy;
		};
		place(null, 0, 0);
		// Embedded frame around tasks, modules and drivers.
		const frames = [];
		const top = results.get(null);
		if (lvl === 'system' && topBands === 'embedded') {
			const inner = [...items.values()].filter(it => !it.box && !it.outside && ['task', 'module', 'driver'].includes(it.n.role));
			if (inner.length) {
				const x0 = Math.min(...inner.map(i => i.x)) - 20, y0 = Math.min(...inner.map(i => i.y)) - 48;
				const x1 = Math.max(...inner.map(i => i.x + i.w)) + 20, y1 = Math.max(...inner.map(i => i.y + i.h)) + 20;
				frames.push({ id: sc.id, n: sc, x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
				for (const it of items.values()) {
					if (!it.box && it.outside && it.x < x1 + 40 && it.y < y1 && it.y + it.h > y0) {
						it.x = x1 + 50;
						rects.set(it.id, { x: it.x, y: it.y, w: it.w, h: it.h, key: it.id });
					}
				}
			}
		}
		// Ghost items (scanning) in a row under the graph.
		if (extra.ghosts?.length) {
			let maxY = 0, x = 0;
			for (const r of rects.values()) {
				maxY = Math.max(maxY, r.y + r.h);
			}
			const y = rects.size ? maxY + 60 : 0;
			for (const gh of extra.ghosts) {
				const it = { id: gh.id, n: gh, box: null, kind: 'node', style: 'top', ghost: true, w: 240, h: 64, x, y };
				items.set(gh.id, it);
				rects.set(gh.id, { x, y, w: 240, h: 64, key: gh.id });
				x += 270;
			}
		}
		// Edges.
		const routes = [];
		for (const e of g.edges) {
			const info = edgeInfo.get(e.id);
			const a = rects.get(e.from), b = rects.get(e.to);
			if (!info || !a || !b) {
				continue;
			}
			const res = results.get(info.C);
			const route = { id: e.id, edge: e, a, b, label: e.label, dir: res?.dir };
			const owner = info.C ? items.get(info.C) : null;
			if (owner && (owner.boxType === 'folder' || (owner.boxType === 'open' && owner.n.level === 'service')) && info.ma === e.from && info.mb === e.to) {
				const sameCol = Math.abs(a.x - b.x) < 4;
				const gap = b.y > a.y ? b.y - a.y - a.h : a.y - b.y - b.h;
				if (sameCol && gap < 16) {
					route.sides = b.y > a.y ? ['b', 't'] : ['t', 'b'];
				} else if (sameCol) {
					route.sides = ['l', 'l'];
				}
				route.dir = sameCol && gap >= 16 ? 'v' : route.dir;
				routes.push(route);
				continue;
			}
			const w = res?.way?.get(e.id);
			const H = (res?.dir ?? 'h') === 'h';
			if (w && w.length) {
				route.way = w.map(p => ({ x: p.x + res.ox, y: p.y + res.oy }));
				const f = route.way[0], l = route.way[route.way.length - 1];
				route.sides = H
					? [f.x >= a.x + a.w / 2 ? 'r' : 'l', l.x <= b.x + b.w / 2 ? 'l' : 'r']
					: [f.y >= a.y + a.h / 2 ? 'b' : 't', l.y <= b.y + b.h / 2 ? 't' : 'b'];
			} else if (res?.layer && info.ma && info.mb && res.layer.has(info.ma) && res.layer.has(info.mb)) {
				const la = res.layer.get(info.ma), lb = res.layer.get(info.mb);
				if (la !== lb) {
					route.sides = H ? (la < lb ? ['r', 'l'] : ['l', 'r']) : (la < lb ? ['b', 't'] : ['t', 'b']);
				} else {
					const ra = rects.get(info.ma), rb = rects.get(info.mb);
					const lo = H ? Math.min(ra.y, rb.y) : Math.min(ra.x, rb.x), hi = H ? Math.max(ra.y + ra.h, rb.y + rb.h) : Math.max(ra.x + ra.w, rb.x + rb.w);
					const blocked = [...res.pos.keys()].some(id => {
						if (id === info.ma || id === info.mb || res.layer.get(id) !== la) {
							return false;
						}
						const r = rects.get(id);
						return r && (H ? r.y > lo && r.y + r.h < hi : r.x > lo && r.x + r.w < hi);
					});
					if (H) {
						route.sides = blocked ? ['r', 'r'] : (b.y > a.y ? ['b', 't'] : ['t', 'b']);
					} else {
						route.sides = blocked ? ['t', 't'] : (b.x > a.x ? ['r', 'l'] : ['l', 'r']);
					}
				}
			}
			routes.push(route);
		}
		const obstacles = [];
		for (const it of items.values()) {
			if (it.kind === 'node' && rects.has(it.id)) {
				obstacles.push(rects.get(it.id));
			} else if (it.kind === 'box' && rects.has(it.id)) {
				const r = rects.get(it.id);
				obstacles.push({ x: r.x, y: r.y, w: r.w, h: 34 });
			}
		}
		routeEdges(routes, obstacles);
		// Headers (band names, loose row).
		const heads = [];
		if (top) {
			for (const h of top.heads ?? []) {
				heads.push({ ...h, x: h.x + top.ox, y: h.y + top.oy });
			}
		}
		// Bounds and shift to a margin.
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		const grow = (x, y, w, h) => {
			minX = Math.min(minX, x);
			minY = Math.min(minY, y);
			maxX = Math.max(maxX, x + w);
			maxY = Math.max(maxY, y + h);
		};
		for (const r of rects.values()) {
			grow(r.x, r.y, r.w, r.h);
		}
		for (const f of frames) {
			grow(f.x, f.y, f.w, f.h);
		}
		for (const h of heads) {
			const tw = textW(h.text, 11.5, 600) + 4;
			grow(h.anchor === 'end' ? h.x - tw : h.x, h.y - 12, tw, 16);
		}
		for (const r of routes) {
			for (const s of r.segs ?? []) {
				for (const p of s) {
					grow(p.x, p.y, 0, 0);
				}
			}
			if (r.lab) {
				grow(r.lab.x, r.lab.y, r.lab.w, r.lab.h);
			}
		}
		if (!isFinite(minX)) {
			minX = minY = maxX = maxY = 0;
		}
		const M = 40;
		const dx = M - minX, dy = M - minY;
		const shiftRect = r => {
			r.x += dx;
			r.y += dy;
		};
		for (const r of rects.values()) {
			shiftRect(r);
		}
		for (const f of frames) {
			shiftRect(f);
		}
		for (const h of heads) {
			shiftRect(h);
		}
		for (const r of routes) {
			if (r.lab) {
				shiftRect(r.lab);
			}
			r.segs = r.segs.map(s => s.map(p => ({ x: p.x + dx, y: p.y + dy })));
			r.d = r.segs.length ? `M${r1(r.segs[0][0].x)},${r1(r.segs[0][0].y)}` + r.segs.map(s => ` C${r1(s[1].x)},${r1(s[1].y)} ${r1(s[2].x)},${r1(s[2].y)} ${r1(s[3].x)},${r1(s[3].y)}`).join('') : '';
		}
		const nodes = [], boxes = [];
		for (const it of items.values()) {
			const r = rects.get(it.id);
			if (!r) {
				continue;
			}
			const out = { ...it, x: r.x, y: r.y, w: r.w, h: r.h };
			(it.kind === 'box' ? boxes : nodes).push(out);
		}
		// Parents before children so nested boxes stack correctly.
		const depthOf = b => boxChain(b.id).length;
		boxes.sort((p, q) => depthOf(p) - depthOf(q));
		return { w: maxX - minX + M * 2, h: maxY - minY + M * 2, nodes, boxes, edges: routes, heads, frames, rects, folderMode, bands: topBands, lvl, dir: top?.dir ?? 'h' };
	}

	function gridLayout(its, cols, gapX, gapY) {
		const pos = new Map();
		const cw = Math.max(...its.map(i => i.w), 0), ch = Math.max(...its.map(i => i.h), 0);
		const rows = Math.ceil(its.length / cols);
		its.forEach((it, i) => {
			const col = Math.floor(i / rows), row = i % rows;
			pos.set(it.id, { x: col * (cw + gapX), y: row * (ch + gapY) });
		});
		const usedCols = Math.min(cols, Math.ceil(its.length / Math.max(1, rows)));
		return { pos, w: usedCols * cw + (usedCols - 1) * gapX, h: rows * ch + (rows - 1) * gapY, dir: null };
	}

	/** Role bands: client roles as columns (left to right), embedded roles as rows (top to bottom). */
	function bandLayout(its, edgesC, kind, nested) {
		const order = kind === 'embedded' ? EMBEDDED_BANDS : CLIENT_BANDS;
		const H = kind !== 'embedded';
		const used = order.filter(r => its.some(i => !i.outside && i.n.role === r));
		const hasOther = its.some(i => !i.outside && !used.includes(i.n.role));
		const bands = used.slice();
		if (hasOther) {
			bands.push('outros');
		}
		const hasOutside = its.some(i => i.outside);
		if (H && hasOutside) {
			bands.push('fora');
		}
		const bandOf = new Map();
		for (const it of its) {
			if (!it.outside) {
				bandOf.set(it.id, used.includes(it.n.role) ? used.indexOf(it.n.role) : bands.indexOf('outros'));
			}
		}
		const layoutItems = its.map(it => {
			let band = bandOf.get(it.id);
			let pinEnd = false;
			if (it.outside) {
				if (H) {
					band = bands.indexOf('fora');
				} else {
					const e = edgesC.find(x => x.from === it.id || x.to === it.id);
					const other = e ? (e.from === it.id ? e.to : e.from) : null;
					band = other !== null && bandOf.has(other) ? bandOf.get(other) : 0;
					pinEnd = true;
				}
			}
			return { id: it.id, w: it.w, h: it.h, band, pinEnd };
		});
		const res = layered(layoutItems, edgesC, {
			bands: true, dir: H ? 'h' : 'v', gapMain: H ? clamp(Math.max(0, ...edgesC.map(e => (e.label ? textW(e.label, 10.5) + 50 : 0))), 110, 170) : 100, gapCross: H ? 34 : 24,
		});
		const heads = [];
		const label = b => b === 'outros' ? 'Outros' : b === 'fora' ? (kind === 'embedded' ? 'Fora do aparelho' : 'Fora') : ROLES[b].band;
		res.bandAt.forEach((ba, l) => {
			const b = bands[l];
			if (!b) {
				return;
			}
			if (H) {
				heads.push({ text: label(b).toUpperCase(), x: ba.main, y: -26, band: true });
			} else {
				heads.push({ text: label(b), x: -34, y: ba.main + ba.size / 2 + 4, anchor: 'end', band: true });
			}
		});
		if (nested) {
			return res;
		}
		res.heads = heads.concat(res.heads ?? []);
		return res;
	}

	// ------------------------------------------------------------------ SVG primitives

	function leftBar(h, rx = 8) {
		const k = rx - Math.sqrt(rx * rx - (rx - 3) * (rx - 3));
		return `M3,${r1(k)} A${rx},${rx} 0 0 0 0,${rx} V${r1(h - rx)} A${rx},${rx} 0 0 0 3,${r1(h - k)} Z`;
	}

	function markerDefs() {
		const m = id => `<marker id="${id}" class="ah" viewBox="0 0 10 10" refX="8.4" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse"><path d="M2.2 1.6L8.2 5L2.2 8.4" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></marker>`;
		return ['ah-n', 'ah-h', 'ah-a', 'ah-d', 'ah-c'].map(m).join('');
	}

	function svgOpen(w, h, extraDefs = '') {
		return `<svg class="as-svg" xmlns="http://www.w3.org/2000/svg" data-w="${Math.ceil(w)}" data-h="${Math.ceil(h)}"><defs>${markerDefs()}${extraDefs}</defs><g class="vp">`;
	}

	function subtitleOf(it, n) {
		if (it.ghost) {
			return n.note ?? 'analisando…';
		}
		if (it.change?.note) {
			return it.change.note;
		}
		if (it.outside) {
			if (S.idx && n.level === 'service' && it.scopeLevel === 'service') {
				const w = levelWord(n) || 'serviço';
				return w[0].toUpperCase() + w.slice(1);
			}
			if (it.scopeLevel === 'service' && n.level !== 'system') {
				return n.summary && n.summary.length < 28 ? n.summary : 'fora do serviço';
			}
		}
		if (n.level === 'system') {
			return sizeText(n) || n.summary || '';
		}
		if (n.level === 'file') {
			return n.summary || sizeText(n);
		}
		if (n.level === 'service') {
			return n.summary || sizeText(n) || (n.role && ROLES[n.role] ? ROLES[n.role].one : '');
		}
		if (isTopLevelLeaf(n)) {
			return n.summary || { data: 'dados', queue: 'fila de mensagens', external: 'serviço externo' }[n.level];
		}
		return n.summary || n.tech || '';
	}

	function tagOf(it, n) {
		if (it.style === 'chip' || it.style === 'file' || it.ghost) {
			return '';
		}
		if (n.level === 'external') {
			return 'Externo';
		}
		const t = String(n.tech ?? '');
		return t.length <= 16 && norm(t) !== norm(n.name) ? t : '';
	}

	/** A node card in SVG. `it` carries the position, style and flags; `cls` adds state classes. */
	function svgNode(it, cls = '') {
		const n = it.n;
		const w = it.w, h = it.h, st = it.style;
		if (st === 'more') {
			return `<g class="bx-more" data-act="enter" data-id="${esc(it.more)}" transform="translate(${r1(it.x)},${r1(it.y)})" tabindex="0" role="button" aria-label="${esc(n.name)}"><rect x=".5" y=".5" width="${w - 1}" height="${h - 1}" rx="6"/><text x="${w / 2}" y="${h / 2 + 4}" text-anchor="middle">${esc(n.name)}</text></g>`;
		}
		const color = it.ghost ? '#8B93A0' : colorOf(n);
		const small = st === 'chip' || st === 'file';
		const nameSize = st === 'chip' || st === 'file' ? 12 : st === 'top' ? 13 : 12.5;
		const nameWeight = st === 'chip' || st === 'file' ? 500 : 600;
		const ix = small ? 11 : 13;
		const iconSize = small ? 14 : 15;
		const twoLines = st !== 'chip';
		const nameY = twoLines ? (it.chips ? 24 : Math.round(h / 2 - 5)) : Math.round(h / 2 + 4.5);
		const subY = nameY + (st === 'file' ? 16 : 19);
		const tag = it.noTag ? '' : tagOf(it, n);
		const tagW = tag ? Math.ceil(textW(tag, 10.5, 500)) + 12 : 0;
		const nameX = ix + iconSize + 7;
		const nameMax = w - nameX - (tagW ? tagW + 16 : 12);
		const container = !it.ghost && !it.outside && !it.noOpen && S.mode !== 'present' && hasKids(n) && st !== 'chip' && (it.style === 'top' || it.style === 'svc' || it.style === 'band' || it.style === 'inner');
		const openLabel = container ? (it.chips ? `Abrir ${plural(kidsOf(n.id).length, ...childWords(n))}` : 'Abrir') : '';
		const openW = openLabel ? Math.ceil(textW(openLabel, 11)) + 24 : 0;
		const sub = twoLines ? (it.sub ?? subtitleOf(it, n)) : '';
		const subMax = w - ix - 10 - (openLabel && !it.chips ? openW + 6 : 0);
		const classes = ['nd', st, cls];
		if (n.level === 'external' || (it.outside && (n.level === 'system' || n.level === 'service' || n.level === 'file'))) {
			classes.push('ext');
		}
		if (it.ghost) {
			classes.push('ghost');
		}
		const label = `${n.name}${levelWord(n) ? `, ${levelWord(n)}` : ''}`;
		let s = `<g class="${classes.join(' ')}" data-id="${esc(n.id)}" transform="translate(${r1(it.x)},${r1(it.y)})" style="--c:${color}"${it.ghost ? '' : ` tabindex="0" role="button" aria-label="${esc(label)}"`}>`;
		s += `<title>${esc(n.name)}${n.summary ? ` — ${esc(n.summary)}` : ''}</title>`;
		s += `<rect class="nd-bg" x=".5" y=".5" width="${w - 1}" height="${h - 1}" rx="${small ? 6 : 8}"/>`;
		s += `<path class="nd-bar" d="${leftBar(h, small ? 6 : 8)}"/>`;
		const iconName = it.iconName ?? (it.ghost ? (n.queued ? 'circle' : 'spinner') : iconOf(n));
		s += iconAt(iconName, ix, nameY - (small ? 11 : 12), iconSize, `nd-icon${it.ghost && !n.queued ? ' spin' : ''}`);
		s += `<text class="nd-name" x="${nameX}" y="${nameY}">${esc(clip(n.name, nameMax, nameSize, nameWeight))}</text>`;
		if (tag) {
			s += `<rect class="nd-tagbg" x="${w - 10 - tagW}" y="${nameY - 12}" width="${tagW}" height="17" rx="4"/><text class="nd-tag" x="${w - 10 - tagW / 2}" y="${nameY}" text-anchor="middle">${esc(tag)}</text>`;
		}
		if (sub) {
			s += `<text class="nd-sub" x="${ix}" y="${subY}">${esc(clip(sub, subMax, st === 'file' ? 11 : 11.5))}</text>`;
		}
		if (it.chips) {
			it.chips.rows.forEach((row, ri) => {
				const cy = subY + 9 + ri * 23;
				for (const c of row) {
					s += `<rect class="nd-chipbg" x="${ix + c.x}" y="${cy}" width="${c.w}" height="18" rx="4"/><text class="nd-chip${c.more ? ' more' : ''}" x="${ix + c.x + 7}" y="${cy + 13}">${esc(clip(c.text, c.w - 12, 11))}</text>`;
				}
			});
		}
		if (openLabel) {
			const oy = it.chips ? h - 22 : subY - 13;
			const ox = w - 8 - openW;
			s += `<g class="nd-open" data-act="open" data-id="${esc(n.id)}"><title>Abrir aqui dentro (clique duas vezes no cartão para entrar)</title><rect class="hit" x="${ox}" y="${oy - 1}" width="${openW}" height="19" rx="4"/>${iconAt('expand', ox + 5, oy + 2, 13)}<text x="${ox + 21}" y="${oy + 12.5}">${esc(openLabel)}</text></g>`;
		}
		if (it.badge) {
			const bw = Math.ceil(textW(it.badge.text, 10.5, 600)) + 14;
			s += `<g class="nd-badge ${it.badge.cls}"><rect x="${w - bw - 8}" y="-9" width="${bw}" height="17" rx="8.5"/><text x="${w - 8 - bw / 2}" y="3.5" text-anchor="middle">${esc(it.badge.text)}</text></g>`;
		}
		return s + '</g>';
	}

	function svgBox(b, cls = '') {
		const n = b.n;
		const folder = b.boxType === 'folder';
		const frame = b.boxType === 'frame';
		const color = folder ? KINDS.file.c : colorOf(n);
		const rx = folder ? 8 : 12;
		const classes = ['bx', folder ? 'folder' : frame ? 'frame' : 'sub', cls];
		let sub = '';
		if (folder) {
			sub = plural(kidsCount(b), 'arquivo', 'arquivos');
		} else if (frame) {
			sub = [n.tech, n.summary && n.summary.length < 40 ? n.summary : ''].filter(Boolean).join(' · ');
		} else {
			const k = kidsOf(n.id).length;
			const shown = b.shownCount ?? k;
			sub = [n.tech, plural(k, ...childWords(n)), shown < k ? `${num(shown)} à mostra` : ''].filter(Boolean).join(' · ');
		}
		const nameX = folder ? 32 : 36;
		const nameY = folder ? 21 : 26;
		const name = clip(n.name, b.w - nameX - 60, folder ? 12 : 12.5, folder ? 500 : 600);
		const nameW = textW(name, folder ? 12 : 12.5, folder ? 500 : 600);
		let s = `<g class="${classes.join(' ')}" style="--c:${color}">`;
		s += `<rect class="bx-bg" x="${r1(b.x + .5)}" y="${r1(b.y + .5)}" width="${r1(b.w - 1)}" height="${r1(b.h - 1)}" rx="${rx}"/>`;
		const headAttrs = folder || frame ? '' : ` data-id="${esc(n.id)}"`;
		s += `<g class="bx-head"${headAttrs}>${iconAt(folder ? 'folder' : iconOf(n), b.x + (folder ? 12 : 14), b.y + nameY - 12, folder ? 14 : 15, 'bx-icon')}`;
		s += `<text class="bx-name" x="${r1(b.x + nameX)}" y="${r1(b.y + nameY)}">${esc(name)}</text>`;
		if (sub) {
			s += `<text class="bx-sub" x="${r1(b.x + nameX + nameW + 8)}" y="${r1(b.y + nameY)}">${esc(clip(sub, b.w - nameX - nameW - 52, 11.5))}</text>`;
		}
		s += '</g>';
		if (b.boxType === 'open') {
			s += `<g class="bx-close" data-act="close-box" data-id="${esc(n.id)}" tabindex="0" role="button" aria-label="Fechar ${esc(n.name)}"><title>Fechar</title><rect class="hit" x="${r1(b.x + b.w - 34)}" y="${r1(b.y + 8)}" width="24" height="24" rx="5"/>${iconAt('collapse', b.x + b.w - 30, b.y + 12, 16)}</g>`;
		}
		return s + '</g>';
	}

	function kidsCount(b) {
		return b._count ?? 0;
	}

	function svgLabel(lab, text, cls = '') {
		return `<g class="el ${cls}"><rect x="${r1(lab.x)}" y="${r1(lab.y)}" width="${r1(lab.w)}" height="${r1(lab.h)}" rx="4"/><text x="${r1(lab.x + lab.w / 2)}" y="${r1(lab.y + lab.h / 2 + 3.7)}" text-anchor="middle">${esc(text)}</text></g>`;
	}

	function markerFor(cls) {
		return /\bdel\b/.test(cls) ? 'ah-d' : /\badd\b/.test(cls) ? 'ah-a' : /\bchg\b/.test(cls) ? 'ah-c' : /\b(hot|step)\b/.test(cls) ? 'ah-h' : 'ah-n';
	}

	function svgHint(x, y, text, ic = 'pin') {
		const w = Math.ceil(textW(text, 12)) + 38;
		return `<g class="hint" transform="translate(${r1(x)},${r1(y)})"><rect width="${w}" height="26" rx="6"/>${iconAt(ic, 10, 5, 15)}<text x="30" y="17">${esc(text)}</text></g>`;
	}

	// ------------------------------------------------------------------ map mode

	const sceneCache = { key: null, scene: null };

	function currentProposal() {
		return S.proposalOn && S.proposal && S.mode === 'map' ? S.proposal : null;
	}

	/** Scope where the proposal lives: the parent of its first added node, or of its first changed node. */
	function proposalScope(p) {
		if (!p) {
			return null;
		}
		const add = p.nodes.find(x => x.op === 'add' && x.parent);
		if (add && node(add.parent)) {
			return validScope(add.parent);
		}
		const chg = p.nodes.find(x => x.op === 'change' && node(x.id));
		if (chg) {
			return validScope(scopeOf(chg.id));
		}
		return null;
	}

	function scanGhosts() {
		const p = S.progress;
		if (!p || p.status !== 'scanning' || S.scope) {
			return [];
		}
		const ghosts = [];
		const cur = typeof p.current === 'string' ? p.current : '';
		const top = cur.includes('/') ? cur.split('/')[0] : '';
		if (top && S.idx && !S.idx.systems.some(n => n.path === '.')) {
			const known = S.idx.tops.some(n => typeof n.path === 'string' && (n.path === top || n.path.startsWith(top + '/')));
			if (!known) {
				ghosts.push({ id: `ghost:${top}`, name: `${top}/`, level: 'ghost', kind: 'external', note: 'analisando…' });
			}
		}
		return ghosts;
	}

	function mapScene(scopeId, opts = {}) {
		const prop = opts.proposal ?? null;
		const open = opts.open ?? S.open;
		const ghosts = opts.ghosts ?? [];
		const key = JSON.stringify([S.modelRev, scopeId, [...open].sort(), prop ? S.proposalRev : 0, ghosts.map(g => g.id), opts.tag ?? '']);
		if (sceneCache.key === key) {
			return sceneCache.scene;
		}
		const g = sceneGraph(scopeId, { open, proposal: prop });
		const scene = layoutScene(g, { ghosts });
		scene.graph = g;
		const lvl = g.scopeNode ? g.scopeNode.level : 'root';
		for (const it of scene.nodes) {
			it.scopeLevel = lvl;
		}
		for (const b of scene.boxes) {
			if (b.boxType === 'folder') {
				b._count = scene.nodes.filter(x => x.box === b.id).length;
			} else if (b.boxType === 'open') {
				b.shownCount = scene.nodes.filter(x => x.box === b.id && x.style !== 'more').length;
			}
		}
		for (const f of scene.frames) {
			f.boxType = 'frame';
		}
		if (prop) {
			for (const p of prop.nodes) {
				const it = scene.nodes.find(x => x.id === p.id);
				if (!it) {
					continue;
				}
				if (p.op === 'add') {
					it.added = true;
					it.badge = { text: 'novo', cls: 'new' };
				} else if (p.op === 'change') {
					it.change = p;
					it.badge = { text: 'alterado', cls: 'chg' };
				} else if (p.op === 'remove') {
					it.removed = true;
					it.change = p.note ? p : null;
					it.badge = { text: 'sai', cls: 'del' };
				}
			}
		}
		sceneCache.key = key;
		sceneCache.scene = scene;
		return scene;
	}

	/** Nearest rendered representative of a node id in a scene. */
	function renderedIn(scene, id) {
		if (!id) {
			return null;
		}
		if (scene.rects.has(id)) {
			return id;
		}
		if (S.idx?.byId.has(id)) {
			for (const a of S.idx.chain(id)) {
				if (scene.rects.has(a)) {
					return a;
				}
			}
		}
		return null;
	}

	function searchMatches(n) {
		const q = norm(S.search.q.trim());
		return !!q && norm(n.name).includes(q);
	}

	function mapDecor(scene, present) {
		const nodeCls = new Map(), edgeCls = new Map();
		const add = (m, id, c) => m.set(id, ((m.get(id) ?? '') + ' ' + c).trim());
		const gone = new Set(scene.nodes.filter(it => it.removed).map(it => it.id));
		for (const e of scene.edges) {
			const ed = e.edge;
			if (ed.async) {
				add(edgeCls, e.id, 'async');
			}
			if (ed.op) {
				add(edgeCls, e.id, ed.op);
			} else if (gone.has(ed.from) || gone.has(ed.to)) {
				add(edgeCls, e.id, 'del');
			}
		}
		for (const it of scene.nodes) {
			if (it.added) {
				add(nodeCls, it.id, 'add');
			}
			if (it.removed) {
				add(nodeCls, it.id, 'rem');
			} else if (it.change) {
				add(nodeCls, it.id, 'chg');
			}
			if (S.search.q.trim() && searchMatches(it.n)) {
				add(nodeCls, it.id, 'match');
			}
		}
		if (present) {
			const a = renderedIn(scene, present.from), b = renderedIn(scene, present.to);
			for (const it of scene.nodes) {
				add(nodeCls, it.id, it.id === a || it.id === b ? 'sel pres' : 'dim');
			}
			for (const e of scene.edges) {
				add(edgeCls, e.id, e.edge.from === a && e.edge.to === b ? 'hot' : 'dim');
			}
			return { nodeCls, edgeCls, hot: null };
		}
		const sel = renderedIn(scene, S.sel);
		const searching = !!S.search.q.trim();
		if (sel) {
			const near = new Set([sel]);
			for (const e of scene.edges) {
				if (e.edge.from === sel || e.edge.to === sel) {
					add(edgeCls, e.id, 'hot');
					near.add(e.edge.from);
					near.add(e.edge.to);
				} else {
					add(edgeCls, e.id, 'dim');
				}
			}
			for (const it of scene.nodes) {
				if (it.id === sel) {
					add(nodeCls, it.id, 'sel');
				} else if (!near.has(it.id) && !(it.box && (it.box === sel || near.has(it.box)))) {
					add(nodeCls, it.id, 'dim');
				}
			}
		} else if (searching) {
			for (const it of scene.nodes) {
				if (!searchMatches(it.n)) {
					add(nodeCls, it.id, 'dim');
				}
			}
			for (const e of scene.edges) {
				add(edgeCls, e.id, 'dim');
			}
		}
		let hot = null;
		if (S.selEdge && scene.edges.some(e => e.id === S.selEdge)) {
			edgeCls.set(S.selEdge, (edgeCls.get(S.selEdge) ?? '').replace(/dim/g, '') + ' hot');
		}
		if (S.highlight.size) {
			for (const id of S.highlight) {
				const r = renderedIn(scene, id);
				if (r && scene.nodes.some(x => x.id === r)) {
					add(nodeCls, r, 'sel');
				}
			}
			for (const e of scene.edges) {
				const ids = e.edge.linkIds;
				if ([...S.highlight].some(h => ids.has(h))) {
					edgeCls.set(e.id, (edgeCls.get(e.id) ?? '').replace(/\bdim\b/g, '') + ' hot');
					hot = hot ?? e;
				}
			}
		}
		return { nodeCls, edgeCls, hot, sel };
	}

	function renderMapSvg(scene, decor, extra = {}) {
		let s = svgOpen(scene.w, scene.h);
		for (const f of scene.frames) {
			s += svgBox(f, '');
		}
		for (const b of scene.boxes) {
			const c = decor.nodeCls.get(b.id) ?? '';
			s += svgBox(b, /\bsel\b/.test(c) ? 'sel' : /\bdim\b/.test(c) ? '' : '');
		}
		for (const h of scene.heads) {
			s += `<text class="band-head${h.muted ? ' muted' : ''}" x="${r1(h.x)}" y="${r1(h.y)}"${h.anchor === 'end' ? ' text-anchor="end"' : ''}>${esc(h.text)}</text>`;
		}
		const manyEdges = scene.edges.length > 70;
		const edgeOrder = scene.edges.slice().sort((a, b) => {
			const ca = decor.edgeCls.get(a.id) ?? '', cb = decor.edgeCls.get(b.id) ?? '';
			return (/hot|step/.test(ca) ? 1 : 0) - (/hot|step/.test(cb) ? 1 : 0);
		});
		for (const e of edgeOrder) {
			const c = decor.edgeCls.get(e.id) ?? '';
			const faint = manyEdges && !/(hot|dim|add|del|chg)/.test(c) ? ' faint' : '';
			s += `<path class="ed ${c}${faint}" d="${e.d}" marker-end="url(#${markerFor(c)})"/>`;
		}
		for (const e of extra.tempEdges ?? []) {
			s += `<path class="ed step${e.async ? ' async' : ''}" d="${e.d}" marker-end="url(#ah-h)"/>`;
		}
		for (const e of scene.edges) {
			s += `<path class="ed-hit" data-edge="${esc(e.id)}" d="${e.d}"/>`;
		}
		for (const it of scene.nodes) {
			s += svgNode(it, decor.nodeCls.get(it.id) ?? '');
		}
		for (const e of edgeOrder) {
			const c = decor.edgeCls.get(e.id) ?? '';
			const text = extra.labelFor?.(e) ?? e.edge.label;
			if (e.lab && text && (!manyEdges || /hot/.test(c)) && (!e.lab.onNode || /hot/.test(c))) {
				s += svgLabel(e.lab, clip(text, 220, 10.5), c.replace(/\basync\b/, ''));
			}
		}
		for (const e of extra.tempEdges ?? []) {
			if (e.lab && e.label) {
				s += svgLabel(e.lab, e.label, 'hot');
			}
		}
		if (extra.hint) {
			s += svgHint(extra.hint.x, extra.hint.y, extra.hint.text);
		}
		return s + '</g></svg>';
	}

	function hintPosition(scene, decor) {
		if (!S.note) {
			return null;
		}
		if (decor.hot?.lab) {
			return { x: decor.hot.lab.x + decor.hot.lab.w + 16, y: decor.hot.lab.y + decor.hot.lab.h + 22, text: S.note };
		}
		const id = decor.sel ?? [...S.highlight].map(h => renderedIn(scene, h)).find(Boolean);
		const r = id ? scene.rects.get(id) : null;
		if (r) {
			return { x: r.x + 12, y: r.y + r.h + 14, text: S.note };
		}
		return null;
	}

	function legendHtml(kinds, opts = {}) {
		let s = `<div class="as-legend${opts.top ? ' top' : ''}">`;
		for (const k of kinds) {
			s += `<span><i style="background:${k.c}"></i>${esc(k.label)}</span>`;
		}
		if (opts.lines !== false) {
			s += '<span><i class="ln"></i>chamada</span><span><i class="ln dash"></i>mensagem ou evento</span>';
		}
		return s + '</div>';
	}

	function sceneKinds(list) {
		const seen = new Map();
		for (const n of list) {
			if (!n || n.level === 'folder' || n.level === 'more' || n.level === 'ghost') {
				continue;
			}
			if (n.role && ROLES[n.role] && n.level === 'service') {
				seen.set(`r:${n.role}`, { c: ROLES[n.role].c, label: ROLES[n.role].band });
			} else if (n.level === 'file') {
				seen.set('file', { c: KINDS.file.c, label: 'Arquivo' });
			} else {
				const k = KINDS[n.kind] ?? KINDS.backend;
				const label = n.kind === 'data' || n.kind === 'queue' ? 'Dados' : k.label;
				seen.set(label, { c: k.c, label });
			}
		}
		return [...seen.values()];
	}

	function mapView() {
		const prop = currentProposal();
		const scopeId = S.scope;
		const ghosts = scanGhosts();
		const scene = mapScene(scopeId, { proposal: prop, ghosts });
		if (!scene.nodes.length) {
			return { html: emptyScopeHtml(), plain: true };
		}
		const decor = mapDecor(scene, null);
		const hint = hintPosition(scene, decor);
		const svg = renderMapSvg(scene, decor, { hint });
		S.drawing = { w: scene.w, h: scene.h, key: `map|${scopeId ?? ''}` };
		let overlay = '';
		if (prop) {
			overlay += '<div class="as-legend"><span><i style="background:var(--as-add)"></i>novo</span><span><i style="background:var(--as-chg)"></i>alterado</span><span><i style="background:var(--as-del)"></i>removido</span><span><i class="ln"></i>como está hoje</span></div>';
			overlay += `<div class="as-card" style="left:16px;top:14px;width:min(400px,calc(100% - 32px))"><h4>${icon('edit')}Proposta: ${esc(prop.title ?? '')}</h4>${prop.summary ? `<p>${esc(prop.summary)}</p>` : ''}<div class="acts"><button class="as-btn small" data-act="discard">${icon('discard')}Descartar</button><button class="as-btn small primary" data-act="tasks">${icon('checklist')}Gerar tarefas</button></div></div>`;
		} else if (S.progress?.status !== 'scanning' && S.progress?.status !== 'failed') {
			overlay += legendHtml(sceneKinds(scene.nodes.map(x => x.n)));
		}
		if (S.selEdge) {
			overlay += edgeCardHtml(scene);
		}
		if (S.progress?.status === 'scanning') {
			overlay += scanCardHtml();
		} else if (S.progress?.status === 'failed') {
			overlay += failedHtml(true);
		}
		return { html: svg + overlay };
	}

	function emptyScopeHtml() {
		const sc = node(S.scope);
		return `<div class="as-empty"><h3 class="small">${sc ? `${esc(sc.name)} ainda não tem partes mapeadas` : 'Nada para desenhar aqui'}</h3><p>Peça no chat para mapear este nível ou volte um nível.</p>${sc ? `<button class="as-btn" data-act="up">${icon('arrowL')}Voltar</button>` : ''}</div>`;
	}

	function edgeCardHtml(scene) {
		const e = scene.edges.find(x => x.id === S.selEdge)?.edge;
		if (!e) {
			return '';
		}
		const a = node(e.from) ?? scene.nodes.find(x => x.id === e.from)?.n, b = node(e.to) ?? scene.nodes.find(x => x.id === e.to)?.n;
		const ev = [];
		for (const l of e.links) {
			for (const x of l.evidence ?? []) {
				if (ev.length < 8) {
					ev.push(x);
				}
			}
		}
		const protos = [...new Set(e.links.map(l => l.protocol).filter(Boolean))].join(', ');
		return `<div class="as-card" style="right:16px;bottom:44px;width:340px"><h4>${icon('arrowR')}${esc(a?.name ?? '')} → ${esc(b?.name ?? '')}</h4>`
			+ `<div class="row">Tipo<b>${esc(protos || '—')}${e.async ? ' · assíncrono' : ''}</b></div><div class="row">Lugares no código<b>${num(e.count)}</b></div>`
			+ (ev.length ? `<div style="margin-top:6px">${ev.map(x => evidenceButton(x)).join('')}</div>` : '')
			+ `<div class="acts"><button class="as-btn small" data-act="close-edge">${icon('close')}Fechar</button></div></div>`;
	}

	function evidenceButton(x, right = '') {
		const base = String(x.path).split('/').pop();
		return `<button class="as-ev" data-act="open-editor" data-path="${esc(x.path)}" data-line="${x.line | 0}" title="${esc(x.path)}"><span>${icon('file')}${esc(base)}:${x.line | 0}</span>${right ? `<em>${esc(right)}</em>` : ''}</button>`;
	}

	function scanCardHtml() {
		const p = S.progress;
		const total = p.total | 0, done = p.done | 0;
		const pct = total ? clamp(done / total * 100, 0, 100) : 0;
		const run = Array.isArray(p.steps) ? p.steps.find(x => x.state === 'run') : null;
		return `<div class="as-card as-scan"><div class="row"><span class="file">${icon('file')}<span>${esc(p.current ?? 'Lendo o projeto…')}</span></span><span>${total ? `${num(done)} de ${num(total)}` : ''}</span></div>`
			+ `<div class="as-progress"><i style="width:${pct.toFixed(1)}%"></i></div>${run ? `<div class="step">${esc(run.label)}${run.note ? ` · ${esc(run.note)}` : ''}</div>` : ''}</div>`;
	}

	// ------------------------------------------------------------------ inspector

	const isFilePath = path => typeof path === 'string' && path !== '.' && /\.[A-Za-z0-9]+$/.test(path.split('/').pop());

	function editorTarget(n) {
		if (!n) {
			return null;
		}
		if ((n.level === 'file' || isFilePath(n.path)) && n.path) {
			return { path: n.path, line: 0 };
		}
		const ep = Array.isArray(n.endpoints) ? n.endpoints.find(e => e && e.file) : null;
		if (ep) {
			return { path: ep.file, line: ep.line | 0 };
		}
		const files = kidsOf(n.id).filter(c => c.level === 'file' && c.path);
		if (files.length) {
			const main = files.find(f => /^(main|index|app)\./i.test(f.name)) ?? files.slice().sort((a, b) => (b.lines ?? 0) - (a.lines ?? 0))[0];
			return { path: main.path, line: 0 };
		}
		return null;
	}

	function linkRows(list, pick) {
		const groups = new Map();
		for (const l of list) {
			const other = pick(l);
			if (!other) {
				continue;
			}
			let g = groups.get(other);
			if (!g) {
				groups.set(other, g = { id: other, protos: new Set(), count: 0 });
			}
			g.protos.add(l.label && l.label.length < 16 ? l.label : l.protocol);
			g.count += Number(l.count) || 1;
		}
		return [...groups.values()];
	}

	function inspectorHtml(id) {
		const n = node(id) ?? currentProposal()?.nodes.find(p => p.id === id && p.op === 'add');
		if (!n) {
			return '';
		}
		const color = colorOf(n);
		const parent = node(n.parent);
		const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;
		const subParts = [cap(levelWord(n)) || KINDS[n.kind]?.label];
		if (parent) {
			subParts.push(parent.name);
		}
		if (n.tech && n.level !== 'external') {
			subParts.push(n.tech);
		}
		if (n.level === 'file' && n.lang && !n.tech) {
			subParts.push(n.lang);
		}
		const size = n.level === 'file' ? sizeText(n) : n.files ? plural(n.files, 'arquivo', 'arquivos') : '';
		if (size) {
			subParts.push(size);
		}
		let s = `<aside class="as-insp" style="--c:${color}" aria-label="Detalhes">`;
		s += `<button class="as-ib close" data-act="close-insp" title="Fechar detalhes" aria-label="Fechar detalhes">${icon('close')}</button>`;
		s += `<h3>${icon(iconOf(n))}<span>${esc(n.name)}</span></h3><div class="sub">${esc(subParts.filter(Boolean).join(' · '))}</div>`;
		if (n.summary) {
			s += `<div class="sum">${esc(n.summary)}</div>`;
		}
		const prop = currentProposal();
		const pc = prop?.nodes.find(p => p.id === n.id);
		if (pc?.op === 'change' && pc.note) {
			s += `<div class="note">${esc(pc.note)}</div>`;
		} else if (pc?.op === 'remove') {
			s += `<div class="note del">Sai na proposta${pc.note ? `: ${esc(pc.note)}` : '.'}</div>`;
		} else if (pc?.op === 'add') {
			s += '<div class="note add">Parte nova proposta; ainda não existe no código.</div>';
		}
		if (Array.isArray(n.endpoints) && n.endpoints.length) {
			s += '<h5>Recebe</h5>';
			for (const ep of n.endpoints.slice(0, 12)) {
				const m = String(ep.method ?? '').toUpperCase();
				const vc = { GET: 'get', PATCH: 'patch', PUT: 'put', DELETE: 'delete', POST: '' }[m] ?? 'other';
				const file = ep.file ? String(ep.file).split('/').pop() : '';
				const tag = ep.file ? 'button' : 'div';
				s += `<${tag} class="li"${ep.file ? ` data-act="open-editor" data-path="${esc(ep.file)}" data-line="${ep.line | 0}"` : ''}><span class="verb ${vc}">${esc(m || '·')}</span><span>${esc(ep.path ?? '')}</span>${file ? `<em>${esc(file)}</em>` : ''}</${tag}>`;
			}
		}
		if (S.idx && S.idx.byId.has(n.id)) {
			const outL = (S.idx.out.get(n.id) ?? []).filter(l => l.level === (LEVEL_RANK[n.level] !== undefined ? n.level : l.level));
			const inL = (S.idx.inc.get(n.id) ?? []).filter(l => l.level === (LEVEL_RANK[n.level] !== undefined ? n.level : l.level));
			const row = g => {
				const t = node(g.id);
				if (!t) {
					return '';
				}
				const right = [...g.protos].filter(Boolean).slice(0, 2).join(', ');
				return `<button class="li" data-act="focus" data-id="${esc(t.id)}" style="--c:${colorOf(t)}">${icon(iconOf(t))}<span>${esc(t.name)}</span>${right ? `<em>${esc(right)}</em>` : ''}</button>`;
			};
			const calls = linkRows(outL, l => l.to);
			const used = linkRows(inL, l => l.from);
			if (calls.length) {
				s += `<h5>${n.level === 'file' ? 'Usa' : 'Chama'}</h5>` + calls.slice(0, 12).map(row).join('') + (calls.length > 12 ? `<div class="li"><span>+${calls.length - 12}</span></div>` : '');
			}
			if (used.length) {
				s += '<h5>Usado por</h5>' + used.slice(0, 10).map(row).join('') + (used.length > 10 ? `<div class="li"><span>+${used.length - 10}</span></div>` : '');
			}
		}
		const topicRows = (list, dir) => list.slice(0, 10).map(t => {
			const q = (dir === 'out' ? S.idx?.out.get(n.id) : S.idx?.inc.get(n.id))?.find(l => l.label === t && node(dir === 'out' ? l.to : l.from)?.level === 'queue');
			const qn = q ? node(dir === 'out' ? q.to : q.from)?.name : '';
			return `<div class="li">${icon('bolt')}<span>${esc(t)}</span>${qn ? `<em>${esc(qn)}</em>` : ''}</div>`;
		}).join('');
		if (Array.isArray(n.publishes) && n.publishes.length) {
			s += '<h5>Publica</h5>' + topicRows(n.publishes, 'out');
		}
		if (Array.isArray(n.consumes) && n.consumes.length) {
			s += '<h5>Consome</h5>' + topicRows(n.consumes, 'in');
		}
		const kids = kidsOf(n.id);
		if (kids.length && n.level === 'system') {
			const [, many] = childWords(n);
			s += `<h5>${cap(many)} (${num(kids.length)})</h5>` + kids.slice().sort(byName).slice(0, 10).map(c => `<button class="li" data-act="focus" data-id="${esc(c.id)}" style="--c:${colorOf(c)}">${icon(iconOf(c))}<span>${esc(c.name)}</span><em>${esc(c.files ? plural(c.files, 'arquivo', 'arquivos') : '')}</em></button>`).join('') + (kids.length > 10 ? `<div class="li"><span>+${kids.length - 10}</span></div>` : '');
		}
		if (n.path && n.level !== 'file' && isFilePath(n.path)) {
			s += `<h5>Arquivo principal</h5><button class="li" data-act="open-editor" data-path="${esc(n.path)}" data-line="0" title="${esc(n.path)}">${icon('file')}<span>${esc(n.path)}</span></button>`;
		} else if (n.path) {
			s += `<h5>${n.level === 'file' ? 'Caminho' : 'Pasta'}</h5><div class="li">${icon('folder')}<span title="${esc(n.path)}">${esc(n.path === '.' ? '(raiz do projeto)' : n.path)}</span></div>`;
		}
		if (n.manual === true) {
			s += '<div class="note">Desenhado pelo agente; não veio da leitura do código.</div>';
		}
		const acts = [];
		if (kids.length) {
			const [, many] = childWords(n);
			acts.push(`<button class="as-btn primary" data-act="enter" data-id="${esc(n.id)}">${icon('expand')}Abrir ${esc(many)}</button>`);
			if (S.mode === 'map' && n.level !== 'file') {
				const opened = S.open.has(n.id);
				acts.push(`<button class="as-btn" data-act="${opened ? 'close-box' : 'open'}" data-id="${esc(n.id)}">${icon(opened ? 'collapse' : 'layers')}${opened ? 'Fechar aqui' : 'Abrir aqui'}</button>`);
			}
		}
		const tgt = editorTarget(n);
		if (tgt) {
			acts.push(`<button class="as-btn" data-act="open-editor" data-path="${esc(tgt.path)}" data-line="${tgt.line}">${icon('goFile')}Abrir no editor</button>`);
		}
		if (acts.length) {
			s += `<div class="actions">${acts.join('')}</div>`;
		}
		return s + '</aside>';
	}

	// ------------------------------------------------------------------ code panel

	const KW = {
		go: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false',
		c: 'auto break case char const continue default do double else enum extern float for goto if inline int long register return short signed sizeof static struct switch typedef union unsigned void volatile while bool true false NULL',
		js: 'as async await break case catch class const continue debugger default delete do else enum export extends false finally for from function if implements import in instanceof interface let new null of private protected public readonly return static super switch this throw true try type typeof undefined var void while yield',
		py: 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self',
		dart: 'abstract as async await break case catch class const continue default else enum extends false final for if implements import in is late new null on required return static super switch this throw true try var void while with',
		java: 'abstract boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long new null package private protected public return short static super switch this throw throws true false try void while val var fun when object data sealed override suspend',
		swift: 'as break case catch class continue default defer do else enum extension false for func guard if import in init inout let nil private protocol public return self static struct switch throw throws true try var where while',
		rs: 'as async await break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while',
		cs: 'abstract as async await base bool break case catch class const continue default do else enum false finally for foreach if in interface internal is namespace new null object override private protected public readonly return sealed static string struct switch this throw true try using var virtual void while',
		sql: 'select from where insert into values update set delete create table index primary key foreign references not null unique default alter add drop join left right inner outer on group by order having limit as and or in is exists returning begin commit text integer bigint varchar timestamp boolean numeric serial',
	};
	const KW_SETS = {};
	for (const [k, v] of Object.entries(KW)) {
		KW_SETS[k] = new Set(v.split(' '));
	}
	const LANG_FAMILY = { go: 'go', c: 'c', h: 'c', cpp: 'c', hpp: 'c', cc: 'c', js: 'js', jsx: 'js', ts: 'js', tsx: 'js', mjs: 'js', py: 'py', dart: 'dart', java: 'java', kt: 'java', kts: 'java', scala: 'java', swift: 'swift', rs: 'rs', cs: 'cs', sql: 'sql', yaml: 'yaml', yml: 'yaml', toml: 'yaml', json: 'json', sh: 'sh', rb: 'py', docker: 'sh' };
	const TOKEN = /(\/\*)|(\/\/.*)|(#.*)|(--.*)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b\d[\w.]*)|([A-Za-z_$][\w$]*)|(\s+)|([\s\S])/y;

	function highlightLine(line, fam, st) {
		let out = '', i = 0;
		const span = (c, t) => `<span class="t-${c}">${esc(t)}</span>`;
		const slashComments = fam !== 'py' && fam !== 'yaml' && fam !== 'sh' && fam !== 'json';
		const hashComments = fam === 'py' || fam === 'yaml' || fam === 'sh';
		const kws = KW_SETS[fam] ?? null;
		while (i < line.length) {
			if (st.block) {
				const end = line.indexOf('*/', i);
				if (end < 0) {
					return out + span('cm', line.slice(i));
				}
				out += span('cm', line.slice(i, end + 2));
				i = end + 2;
				st.block = false;
				continue;
			}
			TOKEN.lastIndex = i;
			const m = TOKEN.exec(line);
			if (!m) {
				out += esc(line.slice(i));
				break;
			}
			const t = m[0];
			if (m[1] && slashComments) {
				st.block = true;
				out += span('cm', '/*');
			} else if (m[2] && slashComments) {
				out += span('cm', t);
			} else if (m[3] && (hashComments || fam === 'c')) {
				out += fam === 'c' ? span('kw', t) : span('cm', t);
			} else if (m[4] && fam === 'sql') {
				out += span('cm', t);
			} else if (m[5]) {
				const isKey = fam === 'yaml' || fam === 'json' ? /^\s*:/.test(line.slice(i + t.length)) : false;
				out += span(isKey ? 'ty' : 'str', t);
			} else if (m[6]) {
				out += span('num', t);
			} else if (m[7]) {
				const next = line.slice(i + t.length).match(/^\s*(.)/)?.[1];
				if (fam === 'yaml' && next === ':') {
					out += span('ty', t);
				} else if (kws && (kws.has(t) || (fam === 'sql' && kws.has(t.toLowerCase())))) {
					out += span('kw', t);
				} else if (next === '(') {
					out += span('fn', t);
				} else if (/^[A-Z][a-z]/.test(t) && fam !== 'sql') {
					out += span('ty', t);
				} else {
					out += esc(t);
				}
			} else if (m[1] || m[2] || m[3] || m[4]) {
				// Comment markers that do not apply to this language: emit the first character only.
				out += esc(t[0]);
				TOKEN.lastIndex = i + 1;
				i += 1;
				continue;
			} else {
				out += esc(t);
			}
			i += t.length;
		}
		return out;
	}

	function codeTarget() {
		if (S.mode !== 'map') {
			return null;
		}
		const sc = node(S.scope);
		const sel = node(S.sel);
		if (!sel || sel.level !== 'file' || !sel.path) {
			return null;
		}
		if (sc && sc.level === 'service' && sel.parent === sc.id) {
			return sel;
		}
		if (S.open.has(sel.parent)) {
			return sel;
		}
		return null;
	}

	function requestCode(n) {
		if (S.code.path === n.path) {
			return;
		}
		const req = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		S.code = { path: n.path, text: null, error: null, loading: true, truncated: false, req };
		host.postMessage({ type: 'readFile', requestId: req, path: n.path });
	}

	function invalidateCode() {
		S.code = { path: null, text: null, error: null, loading: false, truncated: false, req: null };
	}

	/** Chip for an evidence line: names the end of the link that is not this file (or one of its parents). */
	function chipFor(l, fileId) {
		const mine = fileId ? S.idx.chain(fileId) : [];
		const fromMine = mine.includes(l.from), toMine = mine.includes(l.to);
		const otherId = toMine && !fromMine ? l.from : l.to;
		const other = node(otherId);
		if (!other || mine.includes(otherId)) {
			return null;
		}
		const lw = other.level === 'system' || other.level === 'service' ? `${levelWord(other)} ` : '';
		const sameService = mine[1] && S.idx.chain(other.id).includes(mine[1]);
		return { id: other.id, text: `${lw}${other.name}`, dir: toMine && !fromMine ? '←' : '→', far: !sameService };
	}

	function codeHtml(n) {
		const color = colorOf(n);
		const folder = n.path.includes('/') ? n.path.slice(0, n.path.lastIndexOf('/')) : '';
		let s = `<section class="as-code" style="--c:${color}" aria-label="Código de ${esc(n.name)}"><div class="as-codehead">${icon('file')}<b>${esc(n.name)}</b><small title="${esc(n.path)}">${esc(folder)}</small><span class="as-sp"></span>`;
		s += `<button class="as-btn small" data-act="open-editor" data-path="${esc(n.path)}" data-line="${firstEvidenceLine(n.path)}">${icon('goFile')}Abrir no editor</button>`;
		s += `<button class="as-ib" data-act="close-code" title="Fechar código" aria-label="Fechar código">${icon('close')}</button></div><div class="as-lines" id="as-lines">`;
		s += codeLinesHtml(n);
		return s + '</div></section>';
	}

	/** The line to show first: the first evidence that leaves the service, else the first evidence. */
	function firstEvidenceLine(path) {
		const ev = S.idx?.evidence.get(path);
		if (!ev || !ev.length) {
			return 0;
		}
		const file = S.idx.byPath.get(path);
		const far = file ? ev.filter(x => chipFor(x.link, file.id)?.far) : [];
		return Math.min(...(far.length ? far : ev).map(x => x.line));
	}

	function codeLinesHtml(n) {
		const c = S.code;
		if (c.path !== n.path || c.loading) {
			return '<div class="msg">Abrindo o arquivo…</div>';
		}
		if (c.error) {
			return `<div class="msg">Não consegui ler este arquivo: ${esc(c.error)}</div>`;
		}
		const text = String(c.text ?? '');
		const lines = text.split(/\r?\n/);
		const fam = LANG_FAMILY[n.lang] ?? LANG_FAMILY[String(n.name).split('.').pop()] ?? 'js';
		const ev = new Map();
		const focusLine = firstEvidenceLine(n.path);
		for (const x of S.idx?.evidence.get(n.path) ?? []) {
			const chip = chipFor(x.link, n.id);
			if (chip) {
				const list = ev.get(x.line) ?? ev.set(x.line, []).get(x.line);
				if (!list.some(y => y.text === chip.text)) {
					list.push(chip);
				}
			}
		}
		for (const [line, list] of ev) {
			const services = new Set(list.map(ch => ch.id));
			ev.set(line, list.filter(ch => !(node(ch.id)?.level === 'file' && services.has(node(ch.id).parent))));
		}
		const max = Math.min(lines.length, 5000);
		const st = { block: false };
		let s = '';
		for (let i = 0; i < max; i++) {
			const no = i + 1;
			const chips = ev.get(no);
			s += `<div class="ln${no === focusLine ? ' cur' : ''}" data-line="${no}"><span class="no">${no}</span><span>${highlightLine(lines[i], fam, st)}</span>`;
			if (chips) {
				s += chips.map(ch => `<button class="lnk" data-act="focus" data-id="${esc(ch.id)}">${icon(ch.dir === '←' ? 'arrowL' : 'arrowR')}${esc(ch.text)}</button>`).join('');
			}
			s += '</div>';
		}
		if (lines.length > max || c.truncated) {
			s += '<div class="msg">O arquivo é grande; mostrei só o começo. Abra no editor para ver tudo.</div>';
		}
		return s;
	}

	function scrollCodeToEvidence(n) {
		const box = document.getElementById('as-lines');
		if (!box || S.code.path !== n.path || S.code.loading) {
			return;
		}
		const first = firstEvidenceLine(n.path);
		box.scrollTop = first > 4 ? (first - 4) * 20 : 0;
	}

	// ------------------------------------------------------------------ columns mode

	/** Resolves the system / service / file chosen in the three columns. */
	function colsState() {
		const c = { sys: null, svc: null, file: null };
		const from = S.cols ?? {};
		const pick = id => node(id);
		let sys = pick(from.sys), svc = pick(from.svc), file = pick(from.file);
		if (!sys) {
			const chain = S.idx.chain(S.sel ?? S.scope ?? '');
			sys = node(chain[chain.length - 1]) ?? null;
			svc = chain.length >= 2 ? node(chain[chain.length - 2]) : null;
			file = chain.length >= 3 ? node(chain[chain.length - 3]) : null;
		}
		if (!sys) {
			sys = S.idx.systems.find(hasKids) ?? rootItems()[0] ?? null;
		}
		c.sys = sys?.id ?? null;
		if (svc && svc.parent === c.sys) {
			c.svc = svc.id;
		}
		if (file && c.svc && file.parent === c.svc) {
			c.file = file.id;
		}
		return c;
	}

	function columnsView() {
		const st = colsState();
		const q = norm(S.search.q.trim());
		const filt = list => q ? list.filter(n => norm(n.name).includes(q) || n.id === st.sys || n.id === st.svc || n.id === st.file) : list;
		const item = (n, on, colIdx, meta) => {
			const chev = hasKids(n) && colIdx < 2 ? icon('chevR', 'chev') : '';
			const m = q && norm(n.name).includes(q) ? ' match' : '';
			return `<button class="as-it${on ? ' on' : ''}${m}" data-act="col" data-col="${colIdx}" data-id="${esc(n.id)}" style="--c:${colorOf(n)}" title="${esc(n.name)}">${icon(iconOf(n))}<span class="n">${esc(n.name)}</span><em>${esc(meta)}</em>${chev}</button>`;
		};
		const tops = rootItems();
		const systems = filt(tops.filter(n => n.level === 'system'));
		const others = filt(tops.filter(n => n.level !== 'system'));
		let c1 = systems.map(n => item(n, n.id === st.sys, 0, n.files ? num(n.files) : '')).join('');
		if (others.length) {
			c1 += `<div class="sep">Dados e externos</div>` + others.map(n => item(n, n.id === st.sys, 0, '')).join('');
		}
		const sys = node(st.sys);
		const svcs = sys ? filt(kidsOf(sys.id)) : [];
		const svc = node(st.svc);
		const files = svc ? filt(kidsOf(svc.id)) : [];
		const [, many] = sys ? childWords(sys) : ['', 'serviços'];
		const head2 = sys ? `${many} de ${sys.name}` : 'Serviços';
		const head3 = svc ? `Arquivos de ${svc.name}` : 'Arquivos';
		const c2 = sys ? (svcs.length ? svcs.map(n => item(n, n.id === st.svc, 1, n.files ? num(n.files) : '')).join('') : `<div class="none">${esc(sys.name)} não tem partes de dentro.</div>`) : '';
		const c3 = svc ? (files.length ? files.map((n, i) => item(n, n.id === st.file, 2, n.lines ? (i === 0 ? plural(n.lines, 'linha', 'linhas') : num(n.lines)) : '')).join('') : '<div class="none">Sem arquivos mapeados.</div>') : '<div class="none">Escolha um serviço.</div>';
		const lists = `<div class="as-cols"><div class="as-col"><h5>Sistemas<em>${num(S.idx.systems.length)}</em></h5><div class="list" role="listbox" aria-label="Sistemas">${c1}</div></div>`
			+ `<div class="as-col"><h5>${esc(head2)}<em>${sys ? num(kidsOf(sys.id).length) : ''}</em></h5><div class="list" role="listbox">${c2}</div></div>`
			+ `<div class="as-col"><h5>${esc(head3)}<em>${svc ? num(kidsOf(svc.id).length) : ''}</em></h5><div class="list" role="listbox">${c3}</div></div></div>`;
		const focus = node(st.file ?? st.svc ?? st.sys);
		const flow = focus ? flowScene(focus) : null;
		let canvas;
		if (flow && flow.nodes.length > 1) {
			canvas = renderFlowSvg(flow);
			S.drawing = { w: flow.w, h: flow.h, key: `columns|${focus.id}` };
		} else {
			canvas = `<div class="as-empty"><p>${focus ? `${esc(focus.name)} não tem ligações registradas neste nível.` : 'Escolha um item nas colunas.'}</p></div>`;
			S.drawing = null;
		}
		return { lists, canvas, plain: !flow || flow.nodes.length <= 1 };
	}

	/** "usado por ← item → usa" diagram for one node. */
	function flowScene(n) {
		const lvl = LEVEL_RANK[n.level] !== undefined ? n.level : null;
		const outs = (S.idx.out.get(n.id) ?? []).filter(l => !lvl || l.level === lvl);
		const ins = (S.idx.inc.get(n.id) ?? []).filter(l => !lvl || l.level === lvl);
		const side = (list, pick) => {
			const g = new Map();
			for (const l of list) {
				const o = node(pick(l));
				if (!o || o.id === n.id) {
					continue;
				}
				const e = g.get(o.id) ?? g.set(o.id, { n: o, links: [] }).get(o.id);
				e.links.push(l);
			}
			return [...g.values()];
		};
		const left = side(ins, l => l.from), right = side(outs, l => l.to);
		const cap = 7;
		const sw = 220, sh = 52, cw = 300, ch = 70, gap = 170;
		const nodes = [];
		const rects = new Map();
		const leftShown = left.slice(0, cap), rightShown = right.slice(0, cap);
		const rows = Math.max(leftShown.length, rightShown.length, 1);
		const step = 86;
		const totalH = (rows - 1) * step + sh;
		const cx = sw + gap, rx = cx + cw + gap;
		const subFor = o => {
			if (o.level === 'file') {
				const svc = node(o.parent);
				return o.parent !== n.parent && n.level === 'file' && svc ? [svc.name, o.folder].filter(Boolean).join(' · ') : (o.folder || svc?.name || '');
			}
			return o.level === 'service' ? (node(o.parent)?.name ?? o.summary ?? '') : (o.summary || o.tech || '');
		};
		const place = (list, x) => {
			const h = (list.length - 1) * step + sh;
			const y0 = (totalH - h) / 2;
			list.forEach((e, i) => {
				const it = { id: e.n.id, n: e.n, x, y: y0 + i * step, w: sw, h: sh, style: 'file', sub: subFor(e.n), links: e.links };
				nodes.push(it);
				rects.set(it.id + (x === 0 ? '|in' : '|out'), { x: it.x, y: it.y, w: sw, h: sh, key: it.id + x });
			});
		};
		place(leftShown, 0);
		place(rightShown, rx);
		const center = { id: n.id, n, x: cx, y: (totalH - ch) / 2, w: cw, h: ch, style: 'top', center: true };
		nodes.push(center);
		const cRect = { x: center.x, y: center.y, w: cw, h: ch, key: 'center' };
		const routes = [];
		for (const it of nodes) {
			if (it.center) {
				continue;
			}
			const isIn = it.x === 0;
			const r = rects.get(it.id + (isIn ? '|in' : '|out'));
			const labels = [...new Set(it.links.map(l => l.label || (QUIET_PROTOCOLS.has(String(l.protocol).toLowerCase()) ? '' : l.protocol)).filter(Boolean))];
			routes.push({ id: it.id + (isIn ? '|in' : '|out'), a: isIn ? r : cRect, b: isIn ? cRect : r, sides: ['r', 'l'], label: labels.length === 1 ? labels[0] : labels.length > 1 ? `${it.links.length} ligações` : '', async: it.links.every(l => l.async), dir: 'h' });
		}
		routeEdges(routes, [...rects.values(), cRect]);
		const more = { left: left.length - leftShown.length, right: right.length - rightShown.length };
		const pad = 40;
		for (const it of nodes) {
			it.x += pad;
			it.y += pad + 30;
		}
		for (const r of routes) {
			r.segs = r.segs.map(s => s.map(p => ({ x: p.x + pad, y: p.y + pad + 30 })));
			r.d = `M${r1(r.segs[0][0].x)},${r1(r.segs[0][0].y)}` + r.segs.map(s => ` C${r1(s[1].x)},${r1(s[1].y)} ${r1(s[2].x)},${r1(s[2].y)} ${r1(s[3].x)},${r1(s[3].y)}`).join('');
			if (r.lab) {
				r.lab.x += pad;
				r.lab.y += pad + 30;
			}
		}
		return { nodes, edges: routes, w: rx + sw + pad * 2, h: totalH + pad * 2 + 30 + (more.left || more.right ? 30 : 0), more, hasLeft: left.length > 0, hasRight: right.length > 0, cx: cx + pad, rx: rx + pad, totalH };
	}

	function renderFlowSvg(f) {
		let s = svgOpen(f.w, f.h);
		const pad = 40;
		if (f.hasLeft) {
			s += `${iconAt('arrowL', pad + 220 + 30, pad + 2, 14, 'as-flowhead-ic')}<text class="as-flowhead" x="${pad + 220 + 50}" y="${pad + 13}">usado por</text>`;
		}
		if (f.hasRight) {
			s += `<text class="as-flowhead" x="${f.rx - 50}" y="${pad + 13}" text-anchor="end">usa</text>${iconAt('arrowR', f.rx - 44, pad + 2, 14, 'as-flowhead-ic')}`;
		}
		for (const e of f.edges) {
			s += `<path class="ed hot${e.async ? ' async' : ''}" d="${e.d}" marker-end="url(#ah-h)"/>`;
		}
		for (const it of f.nodes) {
			const view = { ...it, noOpen: !it.center, n: it.center ? it.n : { ...it.n, summary: it.sub || it.n.summary } };
			s += svgNode(view, it.center ? 'sel' : '');
		}
		for (const e of f.edges) {
			if (e.lab && e.label) {
				s += svgLabel(e.lab, e.label, 'hot');
			}
		}
		if (f.more.left) {
			s += `<text class="nd-sub" x="${pad}" y="${f.h - 16}">+${plural(f.more.left, 'outro', 'outros')}</text>`;
		}
		if (f.more.right) {
			s += `<text class="nd-sub" x="${f.rx}" y="${f.h - 16}">+${plural(f.more.right, 'outro', 'outros')}</text>`;
		}
		return s + '</g></svg>';
	}

	// ------------------------------------------------------------------ circles mode

	function tangentPoints(a, b, r) {
		const da = a.r + r, db = b.r + r;
		const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
		if (!d || d > da + db || d < Math.abs(da - db)) {
			return [];
		}
		const x = (da * da - db * db + d * d) / (2 * d);
		const h = Math.sqrt(Math.max(0, da * da - x * x));
		const mx = a.x + dx * x / d, my = a.y + dy * x / d;
		return [{ x: mx - dy * h / d, y: my + dx * h / d }, { x: mx + dy * h / d, y: my - dx * h / d }];
	}

	/** Packs circles (each with .r, plus optional .pad) tightly around the origin; returns the enclosing circle. */
	function packCircles(list) {
		const cs = list.slice().sort((a, b) => b.r - a.r);
		const placed = [];
		const rr = c => c.r + (c.pad ?? 0);
		for (const c of cs) {
			const r = rr(c);
			if (!placed.length) {
				c.x = 0;
				c.y = 0;
			} else if (placed.length === 1) {
				c.x = rr(placed[0]) + r;
				c.y = 0;
			} else {
				let best = null, bestD = Infinity;
				let cxm = 0, cym = 0, wsum = 0;
				for (const p of placed) {
					const w = rr(p) * rr(p);
					cxm += p.x * w;
					cym += p.y * w;
					wsum += w;
				}
				cxm /= wsum;
				cym /= wsum;
				const recent = placed.length > 60 ? placed.slice(-60) : placed;
				for (let i = 0; i < recent.length; i++) {
					for (let j = i + 1; j < recent.length; j++) {
						const a = { x: recent[i].x, y: recent[i].y, r: rr(recent[i]) }, b = { x: recent[j].x, y: recent[j].y, r: rr(recent[j]) };
						if (Math.hypot(a.x - b.x, a.y - b.y) > a.r + b.r + 2 * r) {
							continue;
						}
						for (const p of tangentPoints(a, b, r)) {
							const d = Math.hypot(p.x - cxm, p.y - cym);
							if (d >= bestD) {
								continue;
							}
							let ok = true;
							for (const q of placed) {
								if (Math.hypot(p.x - q.x, p.y - q.y) < rr(q) + r - 0.01) {
									ok = false;
									break;
								}
							}
							if (ok) {
								best = p;
								bestD = d;
							}
						}
					}
				}
				if (!best) {
					let ang = 0, rad = 0;
					for (const p of placed) {
						rad = Math.max(rad, Math.hypot(p.x, p.y) + rr(p));
					}
					best = { x: Math.cos(ang) * (rad + r), y: Math.sin(ang) * (rad + r) };
					ang += 1;
				}
				c.x = best.x;
				c.y = best.y;
			}
			placed.push(c);
		}
		const enc = enclose(placed.map(c => ({ x: c.x, y: c.y, r: rr(c) })));
		for (const c of placed) {
			c.x -= enc.x;
			c.y -= enc.y;
		}
		return enc.r;
	}

	function enclose(cs) {
		if (!cs.length) {
			return { x: 0, y: 0, r: 0 };
		}
		let cx = 0, cy = 0;
		for (const c of cs) {
			cx += c.x;
			cy += c.y;
		}
		cx /= cs.length;
		cy /= cs.length;
		for (let it = 0; it < 80; it++) {
			let far = cs[0], fd = -1;
			for (const c of cs) {
				const d = Math.hypot(c.x - cx, c.y - cy) + c.r;
				if (d > fd) {
					fd = d;
					far = c;
				}
			}
			const dx = far.x - cx, dy = far.y - cy, dl = Math.hypot(dx, dy) || 1;
			const px = far.x + dx / dl * far.r, py = far.y + dy / dl * far.r;
			cx += (px - cx) / (it + 2);
			cy += (py - cy) / (it + 2);
		}
		let R = 0;
		for (const c of cs) {
			R = Math.max(R, Math.hypot(c.x - cx, c.y - cy) + c.r);
		}
		return { x: cx, y: cy, r: R };
	}

	function focusService() {
		const sel = node(S.sel);
		if (!sel) {
			return null;
		}
		if (sel.level === 'service') {
			return sel;
		}
		if (sel.level === 'file') {
			return node(sel.parent);
		}
		return null;
	}

	function circlesScene() {
		const sc = node(S.scope);
		const focus = focusService();
		const top = sc ? kidsOf(sc.id) : rootItems();
		const leafLines = n => Math.max(n.lines ?? 0, 1);
		const total = top.reduce((a, n) => a + (isTopLevelLeaf(n) ? 0 : leafLines(n)), 0) || 1;
		const k = Math.sqrt((1200 * 760 * 0.24) / (Math.PI * total));
		const circles = [];
		const makeKids = (n, depth) => {
			let list = kidsOf(n.id);
			if (!list.length) {
				return null;
			}
			if (list.length > 70) {
				list = list.slice().sort((a, b) => leafLines(b) - leafLines(a)).slice(0, 70);
			}
			const kids = list.map(c => ({ n: c, r: Math.max(depth === 1 ? 14 : 5, k * Math.sqrt(leafLines(c))), pad: depth === 1 ? 4 : 2 }));
			for (const c of kids) {
				if (depth === 1 && (c.n.id === focus?.id || (sc && sc.level !== 'root')) && hasKids(c.n)) {
					const files = kidsOf(c.n.id);
					if (sc && files.length <= 60) {
						c.kids = files.map(f => ({ n: f, r: Math.max(4, k * Math.sqrt(leafLines(f))), pad: 1.5 }));
						const R = packCircles(c.kids);
						c.r = Math.max(c.r, R + 12);
					} else if (c.n.id === focus?.id) {
						c.dots = files;
						c.r = Math.max(c.r, Math.sqrt(files.length) * 7.5 + 26);
					}
				}
			}
			return kids;
		};
		for (const n of top) {
			const c = { n, top: true, r: isTopLevelLeaf(n) ? 26 : Math.max(26, k * Math.sqrt(leafLines(n))) };
			const kids = makeKids(n, 1);
			if (kids) {
				c.kids = kids;
				const R = packCircles(kids);
				c.r = Math.max(c.r * 0.9, R + 10);
			}
			c.pad = 38;
			circles.push(c);
		}
		packCircles(circles);
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const c of circles) {
			minX = Math.min(minX, c.x - c.r - 20);
			maxX = Math.max(maxX, c.x + c.r + 20);
			minY = Math.min(minY, c.y - c.r - 40);
			maxY = Math.max(maxY, c.y + c.r + 12);
		}
		const M = 30;
		for (const c of circles) {
			c.x += M - minX;
			c.y += M - minY + 24;
		}
		// Links between top-level circles at their own level.
		const ids = new Map(circles.map(c => [c.n.id, c]));
		const level = sc ? (sc.level === 'system' ? 'service' : 'file') : 'system';
		const links = [];
		const seen = new Set();
		for (const l of S.idx.links) {
			if (l.level !== level) {
				continue;
			}
			const a = ids.get(l.from), b = ids.get(l.to);
			if (!a || !b || a === b) {
				continue;
			}
			const key = `${a.n.id}>${b.n.id}`;
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			links.push({ a, b, async: !!l.async });
		}
		return { circles, links, w: maxX - minX + M * 2, h: maxY - minY + M * 2 + 24 };
	}

	function circlesView() {
		const sc = circlesScene();
		const sel = S.sel;
		const selTop = sc.circles.find(c => c.n.id === sel || (sel && S.idx.chain(sel).includes(c.n.id)));
		let s = svgOpen(sc.w, sc.h);
		for (const l of sc.links) {
			const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y, d = Math.hypot(dx, dy) || 1;
			const p0 = { x: l.a.x + dx / d * l.a.r, y: l.a.y + dy / d * l.a.r };
			const p1 = { x: l.b.x - dx / d * (l.b.r + 2), y: l.b.y - dy / d * (l.b.r + 2) };
			const mx = (p0.x + p1.x) / 2 - dy * 0.12, my = (p0.y + p1.y) / 2 + dx * 0.12;
			const hot = selTop && (l.a === selTop || l.b === selTop);
			const cls = `ci-link${l.async ? ' async' : ''}${hot ? ' hot' : selTop ? ' dim' : ''}`;
			s += `<path class="${cls}" d="M${r1(p0.x)},${r1(p0.y)} Q${r1(mx)},${r1(my)} ${r1(p1.x)},${r1(p1.y)}" marker-end="url(#${hot ? 'ah-h' : 'ah-n'})"/>`;
		}
		const q = S.search.q.trim();
		const circ = (c, ox, oy, depth) => {
			const x = ox + c.x, y = oy + c.y;
			const n = c.n;
			const color = depth === 0 ? (KINDS[n.kind] ?? KINDS.backend).c : colorOf(n);
			const cls = ['ci', depth ? 'child' : '', isTopLevelLeaf(n) ? 'ext' : '', n.id === sel ? 'sel' : '', q && searchMatches(n) ? 'match' : ''];
			let out = `<g class="${cls.join(' ')}" data-id="${esc(n.id)}" style="--c:${color}" tabindex="0" role="button" aria-label="${esc(n.name)}"><title>${esc(n.name)}${n.files ? ` · ${plural(n.files, 'arquivo', 'arquivos')}` : ''}${n.lines ? ` · ${compact(n.lines)} linhas` : ''}</title>`;
			out += `<circle class="ci-c" cx="${r1(x)}" cy="${r1(y)}" r="${r1(c.r)}"/>`;
			if (depth === 0) {
				const sub = isTopLevelLeaf(n) ? '' : [n.files ? plural(n.files, 'arquivo', 'arquivos') : '', n.lines >= 10000 ? `${compact(n.lines)} linhas` : ''].filter(Boolean).join(' · ');
				const ly = y - c.r - (sub ? 22 : 10);
				out += `<text class="ci-name" x="${r1(x)}" y="${r1(ly)}" text-anchor="middle">${esc(clip(n.name, Math.max(120, c.r * 2), 13, 600))}</text>`;
				if (sub) {
					out += `<text class="ci-sub" x="${r1(x)}" y="${r1(ly + 14)}" text-anchor="middle">${esc(sub)}</text>`;
				}
			} else if (c.r >= 20 && !c.kids?.length) {
				const hasDots = !!c.dots;
				const ty = hasDots ? y - c.r + 26 : y + (c.r >= 30 ? -1 : 4);
				out += `<text class="ci-name" x="${r1(x)}" y="${r1(ty)}" text-anchor="middle">${esc(clip(n.name, c.r * 2 - 10, 11.5, 600))}</text>`;
				if (c.r >= 30 || hasDots) {
					const sub = n.level === 'file' ? (n.lines ? `${num(n.lines)} l.` : '') : n.files ? (c.r >= 44 ? plural(n.files, 'arquivo', 'arquivos') : `${num(n.files)} arq.`) : '';
					if (sub) {
						out += `<text class="ci-sub" x="${r1(x)}" y="${r1(ty + 14)}" text-anchor="middle">${esc(sub)}</text>`;
					}
				}
			} else if (c.kids?.length && c.r >= 26) {
				out += `<text class="ci-name" x="${r1(x)}" y="${r1(y - c.r + 15)}" text-anchor="middle">${esc(clip(n.name, c.r * 1.4, 11, 600))}</text>`;
			}
			out += '</g>';
			if (c.kids) {
				for (const k of c.kids) {
					out += circ(k, x, y + (depth === 1 ? 4 : 0), depth + 1);
				}
			}
			if (c.dots) {
				const rad = c.r - 18;
				c.dots.forEach((f, i) => {
					const a = i * 2.39996, d = rad * Math.sqrt((i + 0.5) / c.dots.length);
					const dx = x + Math.cos(a) * d, dy = y + 10 + Math.sin(a) * d * 0.8;
					const on = f.id === sel;
					out += `<circle class="ci-dot${on ? ' sel' : ''}" data-id="${esc(f.id)}" style="--c:${colorOf(f)}" cx="${r1(dx)}" cy="${r1(dy)}" r="${on ? 5.5 : 3.6}"><title>${esc(f.name)}${f.lines ? ` · ${num(f.lines)} linhas` : ''}</title></circle>`;
				});
			}
			return out;
		};
		for (const c of sc.circles) {
			s += circ(c, 0, 0, 0);
		}
		s += '</g></svg>';
		S.drawing = { w: sc.w, h: sc.h, key: `circles|${S.scope ?? ''}` };
		const kinds = sceneKinds(sc.circles.map(c => c.n)).filter(k => k.label !== 'Arquivo');
		let overlay = legendHtml(kinds, { top: true, lines: false });
		const n = node(sel);
		if (n) {
			const deg = (S.idx.out.get(n.id)?.length ?? 0) + (S.idx.inc.get(n.id)?.length ?? 0);
			overlay += `<div class="as-card" style="right:16px;bottom:16px;width:250px;--c:${colorOf(n)}"><h4>${icon(iconOf(n))}${esc(clip(n.name, 150, 13, 600))} · selecionado</h4>`
				+ (n.files ? `<div class="row">Arquivos<b>${num(n.files)}</b></div>` : '')
				+ (n.lines ? `<div class="row">Linhas<b>${num(n.lines)}</b></div>` : '')
				+ `<div class="row">Ligações<b>${num(deg)}</b></div>`
				+ (hasKids(n) ? `<div class="acts"><button class="link" data-act="enter" data-id="${esc(n.id)}">${icon('expand')}Clique duas vezes para abrir</button></div>` : n.path ? `<div class="acts"><button class="link" data-act="open-editor" data-path="${esc(n.path)}" data-line="0">${icon('goFile')}Abrir no editor</button></div>` : '')
				+ '</div>';
		}
		return { html: s + overlay };
	}

	// ------------------------------------------------------------------ blocks mode (squarified treemap)

	function squarify(items, x, y, w, h) {
		const list = items.filter(i => i.value > 0).sort((a, b) => b.value - a.value);
		const total = list.reduce((a, i) => a + i.value, 0);
		if (!total || w <= 0 || h <= 0) {
			return;
		}
		const scale = (w * h) / total;
		for (const i of list) {
			i.area = i.value * scale;
		}
		let rx = x, ry = y, rw = w, rh = h;
		let rest = list;
		const worst = (row, s) => {
			let sum = 0, mx = 0, mn = Infinity;
			for (const i of row) {
				sum += i.area;
				mx = Math.max(mx, i.area);
				mn = Math.min(mn, i.area);
			}
			return Math.max((s * s * mx) / (sum * sum), (sum * sum) / (s * s * mn));
		};
		while (rest.length) {
			const short = Math.min(rw, rh);
			const row = [rest[0]];
			let i = 1;
			while (i < rest.length && worst(row.concat(rest[i]), short) <= worst(row, short)) {
				row.push(rest[i]);
				i++;
			}
			const sum = row.reduce((a, it) => a + it.area, 0);
			if (rw >= rh) {
				const cw = sum / rh;
				let yy = ry;
				for (const it of row) {
					const hh = it.area / cw;
					it.rect = { x: rx, y: yy, w: cw, h: hh };
					yy += hh;
				}
				rx += cw;
				rw -= cw;
			} else {
				const chh = sum / rw;
				let xx = rx;
				for (const it of row) {
					const ww = it.area / chh;
					it.rect = { x: xx, y: ry, w: ww, h: chh };
					xx += ww;
				}
				ry += chh;
				rh -= chh;
			}
			rest = rest.slice(row.length);
		}
	}

	function blocksView() {
		const sc = node(S.scope);
		const size = canvasSize();
		const W = Math.max(720, size.w - 24), H = Math.max(480, size.h - 24);
		const focus = focusService();
		const q = S.search.q.trim();
		const sel = S.sel;
		let groups;
		if (!sc) {
			groups = rootItems().filter(n => (n.lines ?? 0) > 0);
		} else if (sc.level === 'system') {
			groups = kidsOf(sc.id).filter(n => (n.lines ?? 0) > 0);
		} else {
			const folders = new Map();
			for (const f of kidsOf(sc.id)) {
				const k = f.folder ?? '';
				(folders.get(k) ?? folders.set(k, []).get(k)).push(f);
			}
			groups = [...folders].map(([name, files]) => ({ id: `folder:${name}`, name: name || '(raiz)', level: 'folder', kind: sc.kind, lines: files.reduce((a, f) => a + (f.lines ?? 0), 0), files: files.length, _kids: files }));
		}
		const items = groups.map(n => ({ n, value: Math.max(1, n.lines ?? 0) }));
		squarify(items, 0, 0, W, H);
		let s = svgOpen(W, H);
		const G = 3;
		const rect = (r, inset) => ({ x: r.x + inset, y: r.y + inset, w: Math.max(0, r.w - inset * 2), h: Math.max(0, r.h - inset * 2) });
		const block = (n, r, cls, mix, depth) => {
			const color = n.level === 'file' ? colorOf(n) : (KINDS[n.kind] ?? KINDS.backend).c;
			const isSel = n.id === sel;
			const classes = ['bk', cls, isSel ? 'sel' : '', q && n.name && searchMatches(n) ? 'match' : ''];
			const id = n.level === 'folder' ? '' : ` data-id="${esc(n.id)}" tabindex="0" role="button" aria-label="${esc(n.name)}"`;
			let out = `<g class="${classes.join(' ')}"${id} style="--c:${color};--mix:${mix}%"><title>${esc(n.name)}${n.files ? ` · ${plural(n.files, 'arquivo', 'arquivos')}` : ''}${n.lines ? ` · ${num(n.lines)} linhas` : ''}</title>`;
			out += `<rect class="bk-r" x="${r1(r.x)}" y="${r1(r.y)}" width="${r1(r.w)}" height="${r1(r.h)}" rx="${depth === 0 ? 6 : 4}"/>`;
			return out;
		};
		const label = (n, r, fs, sub) => {
			let out = '';
			if (r.w > 36 && r.h > 22) {
				out += `<text class="bk-name" x="${r1(r.x + 8)}" y="${r1(r.y + 17)}">${esc(clip(n.name, r.w - 14, fs, 600))}</text>`;
				if (sub && r.h > 40) {
					out += `<text class="bk-sub" x="${r1(r.x + 8)}" y="${r1(r.y + 32)}">${esc(clip(sub, r.w - 14, 11))}</text>`;
				}
			}
			return out;
		};
		for (const it of items) {
			const n = it.n;
			if (!it.rect) {
				continue;
			}
			const gr = rect(it.rect, G);
			s += block(n, gr, 'group', 7, 0);
			const head = 30;
			const headSub = n.files ? `${plural(n.files, 'arquivo', 'arquivos')}${n.lines >= 1000 ? ` · ${compact(n.lines)} linhas` : ''}` : '';
			if (gr.w > 50) {
				s += iconAt(n.level === 'folder' ? 'folder' : iconOf(n), gr.x + 10, gr.y + 8, 15, 'bk-icon');
				const nameT = clip(n.name, gr.w - 40, 13, 700);
				s += `<text class="bk-head" x="${r1(gr.x + 31)}" y="${r1(gr.y + 20)}">${esc(nameT)}</text>`;
				const used = textW(nameT, 13, 700);
				if (headSub && gr.w - 48 - used > 40) {
					s += `<text class="bk-headsub" x="${r1(gr.x + 39 + used)}" y="${r1(gr.y + 20)}">${esc(clip(headSub, gr.w - 48 - used, 11.5))}</text>`;
				}
			}
			s += '</g>';
			const inner = { x: gr.x + 6, y: gr.y + head + 2, w: gr.w - 12, h: gr.h - head - 8 };
			const kids = (n._kids ?? kidsOf(n.id)).filter(c => (c.lines ?? 0) > 0);
			if (!kids.length || inner.w < 20 || inner.h < 20) {
				continue;
			}
			const kitems = kids.map(c => ({ n: c, value: Math.max(1, c.lines ?? 0) }));
			squarify(kitems, inner.x, inner.y, inner.w, inner.h);
			for (const ki of kitems) {
				if (!ki.rect) {
					continue;
				}
				const c = ki.n;
				const kr = rect(ki.rect, 1.5);
				const drill = c.level !== 'file' && (sc ? true : c.id === focus?.id) && hasKids(c);
				const sub = c.level === 'file' ? (c.lines ? num(c.lines) : '') : c.files ? (c.lines >= 1000 ? `${plural(c.files, 'arquivo', 'arquivos')} · ${compact(c.lines)} linhas` : plural(c.files, 'arquivo', 'arquivos')) : '';
				s += block(c, kr, c.level === 'file' ? 'file' : '', drill ? 12 : c.level === 'file' ? 26 : 18, 1);
				s += label(c, kr, c.level === 'file' ? 11.5 : 12.5, sub) + '</g>';
				if (drill) {
					const fin = { x: kr.x + 5, y: kr.y + 38, w: kr.w - 10, h: kr.h - 44 };
					if (fin.w < 24 || fin.h < 20) {
						continue;
					}
					let files = kidsOf(c.id).filter(f => (f.lines ?? 0) > 0).sort((a, b) => b.lines - a.lines);
					const maxFiles = Math.max(4, Math.floor((fin.w * fin.h) / 2600));
					let restCount = 0, restLines = 0;
					if (files.length > maxFiles) {
						for (const f of files.slice(maxFiles - 1)) {
							restCount++;
							restLines += f.lines ?? 0;
						}
						files = files.slice(0, maxFiles - 1);
					}
					const fitems = files.map(f => ({ n: f, value: f.lines }));
					if (restCount) {
						fitems.push({ n: { id: `rest:${c.id}`, name: `+${num(restCount)}`, level: 'file', kind: 'file', lines: restLines, rest: c.id }, value: restLines });
					}
					squarify(fitems, fin.x, fin.y, fin.w, fin.h);
					for (const fi of fitems) {
						if (!fi.rect) {
							continue;
						}
						const f = fi.n;
						const fr = rect(fi.rect, 1);
						if (f.rest) {
							s += `<g class="bk file" data-act="enter" data-id="${esc(f.rest)}" style="--c:${KINDS.file.c};--mix:16%"><title>Abrir ${esc(c.name)}</title><rect class="bk-r" x="${r1(fr.x)}" y="${r1(fr.y)}" width="${r1(fr.w)}" height="${r1(fr.h)}" rx="3"/>${label(f, fr, 11.5, '')}</g>`;
						} else {
							s += block(f, fr, 'file', f.id === sel ? 40 : 30, 2) + label(f, fr, 11.5, f.lines ? `${num(f.lines)} linhas` : '') + '</g>';
						}
					}
				}
			}
		}
		s += '</g></svg>';
		S.drawing = { w: W, h: H, key: `blocks|${S.scope ?? ''}`, fill: true };
		return { html: s };
	}

	// ------------------------------------------------------------------ layers mode (isometric plates)

	function layersState() {
		const st = { sys: null, svc: null };
		const saved = S.layers ?? {};
		const sel = node(S.sel);
		const chain = sel ? S.idx.chain(sel.id) : S.scope ? S.idx.chain(S.scope) : [];
		const topId = chain[chain.length - 1];
		let sys = node(saved.sys);
		if (topId && hasKids(node(topId))) {
			sys = node(topId);
		}
		if (!sys || !hasKids(sys)) {
			sys = S.idx.systems.filter(hasKids).sort((a, b) => kidsOf(b.id).length - kidsOf(a.id).length)[0] ?? null;
		}
		st.sys = sys?.id ?? null;
		let svc = chain.length >= 2 ? node(chain[chain.length - 2]) : node(saved.svc);
		if (!svc || svc.parent !== st.sys || !hasKids(svc)) {
			svc = sys ? kidsOf(sys.id).filter(hasKids).sort((a, b) => (b.files ?? 0) - (a.files ?? 0))[0] ?? null : null;
		}
		st.svc = svc?.id ?? null;
		return st;
	}

	function layersView() {
		const st = layersState();
		const sel = S.sel;
		const COS = Math.cos(Math.PI / 6), SIN = 0.5;
		const A = 88;
		const plates = [];
		const capList = (list, max) => list.length <= max ? list : list.slice().sort((a, b) => (b.lines ?? 0) - (a.lines ?? 0)).slice(0, max);
		const sysN = node(st.sys), svcN = node(st.svc);
		plates.push({ items: capList(rootItems(), 36), name: 'Sistemas', sub: S.model?.name ?? '', c: '#6E56CF', level: 'system', open: st.sys });
		if (sysN) {
			plates.push({ items: capList(kidsOf(sysN.id), 49), name: childWords(sysN)[1].replace(/^./, ch => ch.toUpperCase()), sub: `dentro de ${sysN.name}`, c: (KINDS[sysN.kind] ?? KINDS.backend).c, level: 'service', open: st.svc, total: kidsOf(sysN.id).length });
		}
		if (svcN) {
			plates.push({ items: capList(kidsOf(svcN.id), 49), name: 'Arquivos', sub: `dentro de ${svcN.name}`, c: KINDS.file.c, level: 'file', open: null, total: kidsOf(svcN.id).length });
		}
		const P = (o, u, v, z = 0) => [o[0] + (u - v) * COS, o[1] + (u + v) * SIN - z];
		const pts = list => list.map(p => `${r1(p[0])},${r1(p[1])}`).join(' ');
		let ox = 0, oy = 0;
		for (const pl of plates) {
			const n = pl.items.length;
			pl.cols = Math.max(2, Math.ceil(Math.sqrt(n)));
			pl.rows = Math.max(2, Math.ceil(n / pl.cols));
			pl.L = Math.max(pl.cols, pl.rows) * A + A * 0.3;
			pl.o = [ox, oy];
			pl.grid = new Map();
			pl.items.forEach((it, i) => {
				pl.grid.set(it.id, { u: A * 0.15 + (i % pl.cols) * A + A * 0.27, v: A * 0.15 + Math.floor(i / pl.cols) * A + A * 0.27 });
			});
			ox += pl.L * COS * 0.92 + 30;
			oy += pl.L * SIN * 1.28 + 54;
		}
		// Degrees for heights.
		const deg = id => (S.idx.out.get(id)?.length ?? 0) + (S.idx.inc.get(id)?.length ?? 0);
		for (const pl of plates) {
			pl.maxDeg = Math.max(1, ...pl.items.map(it => deg(it.id)));
		}
		const B = A * 0.46;
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const pl of plates) {
			const v = [P(pl.o, 0, 0), P(pl.o, pl.L, 0), P(pl.o, pl.L, pl.L), P(pl.o, 0, pl.L)];
			for (const p of v) {
				minX = Math.min(minX, p[0]);
				maxX = Math.max(maxX, p[0]);
				minY = Math.min(minY, p[1] - 60);
				maxY = Math.max(maxY, p[1]);
			}
			minX = Math.min(minX, v[3][0] - 200);
		}
		const M = 30;
		const shift = [M - minX, M - minY];
		for (const pl of plates) {
			pl.o = [pl.o[0] + shift[0], pl.o[1] + shift[1]];
		}
		const W = maxX - minX + M * 2, H = maxY - minY + M * 2;
		let s = svgOpen(W, H);
		const q = S.search.q.trim();
		const funnel = (plA, plB) => {
			const it = plA.items.find(x => x.id === plA.open);
			if (!it) {
				return '';
			}
			const g = plA.grid.get(it.id);
			const z = 10 + 26 * Math.min(1, deg(it.id) / plA.maxDeg);
			const top = [P(plA.o, g.u, g.v, z), P(plA.o, g.u + B, g.v, z), P(plA.o, g.u + B, g.v + B, z), P(plA.o, g.u, g.v + B, z)];
			const corners = [P(plB.o, 0, 0), P(plB.o, plB.L, 0), P(plB.o, plB.L, plB.L), P(plB.o, 0, plB.L)];
			return top.map((p, i) => `<path class="ly-funnel" style="--c:${plB.c}" d="M${r1(p[0])},${r1(p[1])} L${r1(corners[i][0])},${r1(corners[i][1])}"/>`).join('');
		};
		const drawPlate = pl => {
			const v = [P(pl.o, 0, 0), P(pl.o, pl.L, 0), P(pl.o, pl.L, pl.L), P(pl.o, 0, pl.L)];
			let out = `<polygon class="ly-plate" style="--c:${pl.c}" points="${pts(v)}"/>`;
			out += `<text class="ly-name" x="${r1(v[3][0] - 14)}" y="${r1(v[3][1] + 4)}" text-anchor="end">${esc(pl.name)}</text>`;
			const sub = pl.total && pl.total > pl.items.length ? `${pl.sub} · ${num(pl.items.length)} de ${num(pl.total)}` : pl.sub;
			out += `<text class="ly-sub" x="${r1(v[3][0] - 14)}" y="${r1(v[3][1] + 21)}" text-anchor="end">${esc(clip(sub, 220, 11.5))}</text>`;
			const ids = new Set(pl.items.map(i => i.id));
			const seen = new Set();
			for (const l of S.idx.links) {
				if (l.level !== (pl.level === 'system' ? 'system' : pl.level) || !ids.has(l.from) || !ids.has(l.to) || l.from === l.to) {
					continue;
				}
				const key = `${l.from}>${l.to}`;
				if (seen.has(key)) {
					continue;
				}
				seen.add(key);
				const a = pl.grid.get(l.from), b = pl.grid.get(l.to);
				const pa = P(pl.o, a.u + B / 2, a.v + B / 2), pb = P(pl.o, b.u + B / 2, b.v + B / 2);
				out += `<path class="ly-edge${l.async ? ' async' : ''}" d="M${r1(pa[0])},${r1(pa[1])} L${r1(pb[0])},${r1(pb[1])}"/>`;
			}
			const order = pl.items.slice().sort((a, b) => (pl.grid.get(a.id).u + pl.grid.get(a.id).v) - (pl.grid.get(b.id).u + pl.grid.get(b.id).v));
			let labels = '';
			for (const it of order) {
				const g = pl.grid.get(it.id);
				const z = 10 + 26 * Math.min(1, deg(it.id) / pl.maxDeg);
				const c = pl.level === 'system' ? (KINDS[it.kind] ?? KINDS.backend).c : colorOf(it);
				const topF = [P(pl.o, g.u, g.v, z), P(pl.o, g.u + B, g.v, z), P(pl.o, g.u + B, g.v + B, z), P(pl.o, g.u, g.v + B, z)];
				const right = [P(pl.o, g.u + B, g.v, z), P(pl.o, g.u + B, g.v + B, z), P(pl.o, g.u + B, g.v + B, 0), P(pl.o, g.u + B, g.v, 0)];
				const left = [P(pl.o, g.u, g.v + B, z), P(pl.o, g.u + B, g.v + B, z), P(pl.o, g.u + B, g.v + B, 0), P(pl.o, g.u, g.v + B, 0)];
				const on = it.id === sel || it.id === pl.open;
				const cls = ['ly-blk', on ? 'sel' : '', q && searchMatches(it) ? 'match' : ''];
				out += `<g class="${cls.join(' ')}" data-id="${esc(it.id)}" data-plate="${pl.level}" style="--c:${c}" tabindex="0" role="button" aria-label="${esc(it.name)}"><title>${esc(it.name)} · ${plural(deg(it.id), 'ligação', 'ligações')}</title>`;
				out += `<polygon class="ly-left" points="${pts(left)}"/><polygon class="ly-right" points="${pts(right)}"/><polygon class="ly-top" points="${pts(topF)}"/></g>`;
				const lp = P(pl.o, g.u + B / 2, g.v + B / 2, z);
				labels += `<text class="ly-label" x="${r1(lp[0])}" y="${r1(lp[1] - B * SIN - 8)}" text-anchor="middle">${esc(clip(it.name, A * 1.5, 11.5, 600))}</text>`;
			}
			return out + labels;
		};
		for (let i = plates.length - 1; i >= 0; i--) {
			s += drawPlate(plates[i]);
			if (i > 0) {
				s += funnel(plates[i - 1], plates[i]);
			}
		}
		// Funnels must sit under the upper plate: redraw order already places plate i-1 after its funnel.
		s += '</g></svg>';
		S.drawing = { w: W, h: H, key: `layers|${st.sys ?? ''}|${st.svc ?? ''}` };
		const hint = `<div class="as-card" style="right:16px;top:14px;padding:6px 10px;display:flex;align-items:center;gap:6px;color:var(--as-fg)">${icon('info')}<span>Altura = número de ligações</span></div>`;
		return { html: s + hint };
	}

	// ------------------------------------------------------------------ paths: shared

	function pathList() {
		const list = Array.isArray(S.paths?.paths) ? S.paths.paths : [];
		return list.filter(p => p && Array.isArray(p.steps) && p.steps.length).slice(0, 12);
	}

	function currentPath() {
		const list = pathList();
		return list.find(p => p.id === S.pathId) ?? list[0] ?? null;
	}

	function stepNode(id) {
		return node(id) ?? { id, name: String(id).replace(/^[a-z]:/, ''), level: 'external', kind: 'external' };
	}

	// ------------------------------------------------------------------ path mode (sequence diagram)

	function pathView() {
		const p = currentPath();
		if (!p) {
			S.drawing = null;
			return {
				html: `<div class="as-empty">${icon('path')}<h3 class="small">Nenhum caminho desenhado ainda</h3><p>Um caminho mostra, passo a passo, por onde passa uma ação: do app até o banco, a fila e os serviços externos.</p><p>Peça no chat: <b>mostre o caminho de …</b> (por exemplo, criar um pedido).</p><div class="as-chips" style="margin-top:12px"><button class="as-btn" data-act="ask" data-text="Mostre o caminho de " data-send="0">${icon('comment')}Pedir um caminho</button></div></div>`,
				plain: true,
			};
		}
		const steps = p.steps.slice(0, 24);
		const step = clamp(S.step | 0, 0, steps.length - 1);
		const lanes = [];
		const laneOf = new Map();
		for (const st of steps) {
			for (const id of [st.from, st.to]) {
				if (!laneOf.has(id)) {
					laneOf.set(id, lanes.length);
					lanes.push(stepNode(id));
				}
			}
		}
		const maxName = Math.max(...lanes.map(n => textW(n.name, 12, 600)));
		const laneW = clamp(Math.ceil(maxName) + 46, 128, 176);
		const gap = 16;
		const X = i => 40 + i * (laneW + gap) + laneW / 2;
		const top = 24, headH = 52;
		const Y = k => top + headH + 56 + k * 56;
		const W = 40 * 2 + lanes.length * (laneW + gap) - gap;
		const H = Y(steps.length - 1) + 60;
		// Returns and activations.
		const active = [];
		const bars = [];
		const isReturn = [];
		steps.forEach((st, k) => {
			const a = laneOf.get(st.from), b = laneOf.get(st.to);
			let ret = false;
			for (let i = active.length - 1; i >= 0; i--) {
				const act = active[i];
				if (act.lane === a && active.slice(0, i + 1).some(x => x.caller === b) && !st.async) {
					ret = true;
					while (active.length > i) {
						const x = active.pop();
						if (x === act) {
							x.end = k;
						}
						bars.push(x);
					}
					break;
				}
			}
			isReturn.push(ret);
			if (!ret && !st.async && a !== b) {
				active.push({ lane: b, caller: a, start: k, end: k });
			}
			for (const act of active) {
				if (act.lane === a || (act.lane === b && ret)) {
					act.end = Math.max(act.end, k);
				}
			}
		});
		for (const act of active) {
			bars.push(act);
		}
		let s = svgOpen(W, H);
		lanes.forEach((n, i) => {
			s += `<path class="sq-life" d="M${r1(X(i))},${top + headH} V${H - 10}"/>`;
		});
		for (const b of bars) {
			if (b.end > b.start) {
				s += `<rect class="sq-act" x="${r1(X(b.lane) - 6)}" y="${r1(Y(b.start) - 8)}" width="12" height="${r1(Y(b.end) - Y(b.start) + 16)}" rx="3"/>`;
			}
		}
		lanes.forEach((n, i) => {
			const it = { id: n.id, n, sub: levelWord(n), x: X(i) - laneW / 2, y: top, w: laneW, h: headH, style: 'svc', noOpen: true, noTag: true };
			s += svgNode(it, '');
		});
		const labels = [];
		steps.forEach((st, k) => {
			const a = laneOf.get(st.from), b = laneOf.get(st.to);
			const state = k < step ? 'past' : k === step ? 'cur' : 'future';
			const dash = st.async || isReturn[k];
			const y = Y(k);
			let d, lx, nx;
			if (a === b) {
				const x = X(a) + 6;
				d = `M${x},${y - 8} h30 v16 h-28`;
				lx = x + 40;
				nx = X(a) - 20;
			} else {
				const right = b > a;
				const x1 = X(a) + (right ? 7 : -7), x2 = X(b) + (right ? -8 : 8);
				d = `M${r1(x1)},${y} H${r1(x2)}`;
				lx = (x1 + x2) / 2;
				nx = right ? x1 - 18 : x1 + 18;
			}
			s += `<g class="sq-row${state === 'future' ? ' sq-future' : ''}" data-act="step" data-step="${k}"><rect class="hit" x="${r1(Math.min(X(a), X(b)) - 30)}" y="${y - 22}" width="${r1(Math.abs(X(a) - X(b)) + 60)}" height="34" rx="6"/>`;
			s += `<path class="sq-msg ${state}${dash ? ' dash' : ''}" d="${d}" marker-end="url(#${state === 'future' ? 'ah-n' : 'ah-h'})"/>`;
			s += `<g class="sq-num ${state}"><circle cx="${r1(nx)}" cy="${y}" r="10"/><text x="${r1(nx)}" y="${y + 3.8}" text-anchor="middle">${k + 1}</text></g></g>`;
			if (st.label) {
				const t = clip(st.label, Math.max(110, Math.abs(X(a) - X(b)) - 24), 10.5);
				const lw = textW(t, 10.5) + 14;
				labels.push(svgLabel({ x: (a === b ? lx : lx - lw / 2), y: y - 22, w: lw, h: 16 }, t, state === 'cur' ? 'hot' : state === 'future' ? 'dim' : ''));
			}
		});
		s += labels.join('') + '</g></svg>';
		S.drawing = { w: W, h: H, key: `path|${p.id}`, reserveBottom: 120 };
		const st = steps[step];
		const fa = stepNode(st.from), ta = stepNode(st.to);
		const ev = st.evidence && st.evidence.path ? evidenceButton(st.evidence) : '';
		const card = `<div class="as-card" style="left:16px;bottom:16px;width:min(460px,calc(100% - 32px))"><h4>${icon('arrowR')}Passo ${step + 1} · ${esc(fa.name)} → ${esc(ta.name)}</h4>${st.note ? `<p>${esc(st.note)}</p>` : ''}${ev}</div>`;
		return { html: s + card };
	}

	// ------------------------------------------------------------------ present mode

	function presentSetup(p) {
		const steps = p.steps.slice(0, 24);
		const ids = steps.flatMap(st => [st.from, st.to]).filter(id => S.idx.byId.has(id));
		const tops = new Set(ids.map(id => S.idx.topOf(id)));
		let scope = null;
		if (tops.size === 1) {
			const t = [...tops][0];
			const svcs = new Set(ids.map(id => S.idx.chain(id).find(a => node(a)?.level === 'service')).filter(Boolean));
			scope = svcs.size === 1 && ids.every(id => S.idx.chain(id).includes([...svcs][0]) && id !== [...svcs][0]) ? [...svcs][0] : validScope(t);
		}
		const open = new Set();
		if (!scope) {
			const inner = new Map();
			for (const id of ids) {
				const chain = S.idx.chain(id);
				if (chain.length >= 2) {
					const t = chain[chain.length - 1];
					(inner.get(t) ?? inner.set(t, new Set()).get(t)).add(chain[chain.length - 2]);
				}
			}
			for (const [t, set] of inner) {
				if (set.size >= 1 && kidsOf(t).length <= 40) {
					open.add(t);
				}
			}
		}
		return { scope, open, steps };
	}

	function presentView() {
		const p = currentPath();
		if (!p) {
			return pathView();
		}
		const setup = presentSetup(p);
		const step = clamp(S.step | 0, 0, setup.steps.length - 1);
		const st = setup.steps[step];
		const scene = mapScene(setup.scope, { open: setup.open, tag: 'present' });
		const decor = mapDecor(scene, st);
		const a = renderedIn(scene, st.from), b = renderedIn(scene, st.to);
		const temp = [];
		let labelEdge = null;
		const match = scene.edges.find(e => e.edge.from === a && e.edge.to === b);
		if (match) {
			labelEdge = match.id;
		} else if (a && b && a !== b) {
			const ra = scene.rects.get(a), rb = scene.rects.get(b);
			const route = { id: 'step', a: ra, b: rb, label: st.label ?? '', async: !!st.async };
			routeEdges([route], scene.nodes.map(x => scene.rects.get(x.id)));
			temp.push(route);
		}
		const svg = renderMapSvg(scene, decor, {
			tempEdges: temp,
			labelFor: e => e.id === labelEdge ? (st.label || e.edge.label) : e.edge.label,
		});
		S.drawing = { w: scene.w, h: scene.h, key: `present|${p.id}`, reserveBottom: 130 };
		const note = esc(st.note ?? st.label ?? '');
		const bolded = [stepNode(st.from).name, stepNode(st.to).name].filter(x => x && x.length > 2).reduce((acc, name) => acc.split(esc(name)).join(`<b>${esc(name)}</b>`), note);
		const caption = `<div class="as-caption" role="status"><span class="num">${step + 1}</span><div><small>${esc(p.name)} · passo ${step + 1} de ${setup.steps.length}</small>${bolded || esc(`${stepNode(st.from).name} → ${stepNode(st.to).name}`)}</div></div>`;
		return { html: svg + caption };
	}

	// ------------------------------------------------------------------ deploy mode

	const UNIT_WORDS = { container: 'contêiner', function: 'função', database: 'banco', cache: 'cache', queue: 'fila', device: 'aparelho', client: 'cliente', external: 'externo', balancer: 'balanceador' };

	function unitSubtitle(u) {
		const ports = Array.isArray(u.ports) && u.ports.length ? `porta ${u.ports.join(', ')}` : '';
		return [u.image, ports].filter(Boolean).join(' · ') || UNIT_WORDS[u.kind] || '';
	}

	function deployScene(dep) {
		const zones = new Map((dep.zones ?? []).filter(z => z && z.id).map(z => [z.id, z]));
		const units = (dep.units ?? []).filter(u => u && u.id);
		const unitW = 200, unitH = 50;
		const zoneUnits = new Map(), zoneKids = new Map();
		for (const z of zones.values()) {
			if (z.parent && zones.has(z.parent)) {
				(zoneKids.get(z.parent) ?? zoneKids.set(z.parent, []).get(z.parent)).push(z);
			}
		}
		const orphan = { id: 'z:~outros', name: 'Outros', kind: 'host', parent: null };
		for (const u of units) {
			const zid = zones.has(u.zone) ? u.zone : orphan.id;
			(zoneUnits.get(zid) ?? zoneUnits.set(zid, []).get(zid)).push(u);
		}
		if (zoneUnits.has(orphan.id)) {
			zones.set(orphan.id, orphan);
		}
		const tops = [...zones.values()].filter(z => !z.parent || !zones.has(z.parent));
		const colA = tops.filter(z => z.kind === 'users' || z.kind === 'devices');
		const colC = tops.filter(z => z.kind === 'external');
		const colB = tops.filter(z => !colA.includes(z) && !colC.includes(z));
		const boxes = [], nodes = [];
		const HEAD = 40, PAD = 16, GAP = 18;
		const stackZone = (z, x, y, cols = 1) => {
			const list = zoneUnits.get(z.id) ?? [];
			const rows = Math.ceil(list.length / cols) || 1;
			list.forEach((u, i) => {
				const c = Math.floor(i / rows), r = i % rows;
				nodes.push({ u, x: x + PAD + c * (unitW + 16), y: y + HEAD + r * (unitH + GAP), w: unitW, h: unitH });
			});
			const w = PAD * 2 + cols * unitW + (cols - 1) * 16;
			const h = HEAD + rows * (unitH + GAP) - GAP + PAD;
			boxes.push({ z, x, y, w, h });
			return { w, h };
		};
		let ax = 0, ay = 0, aw = 0;
		for (const z of colA) {
			const r = stackZone(z, ax, ay);
			ay += r.h + 30;
			aw = Math.max(aw, r.w);
		}
		const bx = colA.length ? aw + 90 : 0;
		let by = 0, bw = 0;
		for (const z of colB) {
			const own = zoneUnits.get(z.id) ?? [];
			const entry = own.filter(u => u.kind === 'balancer');
			const fromLeft = new Set((dep.links ?? []).filter(l => colA.some(z => (zoneUnits.get(z.id) ?? []).some(u => u.id === l.from))).map(l => l.to));
			const dataU = own.filter(u => ['database', 'cache', 'queue'].includes(u.kind)).sort((a, b) => (fromLeft.has(b.id) ? 1 : 0) - (fromLeft.has(a.id) ? 1 : 0));
			const other = own.filter(u => !entry.includes(u) && !dataU.includes(u));
			const kids = zoneKids.get(z.id) ?? [];
			let x = bx + PAD, y = by + HEAD;
			let colH = 0;
			if (entry.length) {
				entry.forEach((u, i) => nodes.push({ u, x, y: y + 40 + i * (unitH + GAP), w: unitW - 30, h: unitH }));
				colH = 40 + entry.length * (unitH + GAP);
				x += unitW - 30 + 60;
			}
			let kx = x, ky = y, kidW = 0;
			for (const k of kids) {
				const n = (zoneUnits.get(k.id) ?? []).length;
				const r = stackZone(k, kx, ky, n > 5 ? 2 : 1);
				ky += r.h + 24;
				kidW = Math.max(kidW, r.w);
				for (const kk of zoneKids.get(k.id) ?? []) {
					const rr = stackZone(kk, kx, ky);
					ky += rr.h + 24;
					kidW = Math.max(kidW, rr.w);
				}
			}
			colH = Math.max(colH, ky - y);
			x = kids.length ? kx + kidW + 50 : kx;
			const ocols = other.length > 5 ? 2 : 1, orows = Math.ceil(other.length / ocols);
			other.forEach((u, i) => nodes.push({ u, x: x + Math.floor(i / orows) * (unitW + 16), y: y + (i % orows) * (unitH + GAP), w: unitW, h: unitH }));
			colH = Math.max(colH, orows * (unitH + GAP));
			const innerW = (other.length ? x + ocols * unitW + (ocols - 1) * 16 : x - 50) - bx - PAD;
			let dy = y + colH + 30;
			const dcols = Math.max(1, Math.min(dataU.length, 4));
			dataU.forEach((u, i) => nodes.push({ u, x: bx + PAD + (i % dcols) * (unitW - 20 + 16), y: dy + Math.floor(i / dcols) * (unitH + GAP), w: unitW - 20, h: unitH }));
			const dRows = Math.ceil(dataU.length / dcols);
			const h = (dataU.length ? dy + dRows * (unitH + GAP) - GAP : y + colH) - by + PAD;
			const w = Math.max(innerW + PAD * 2, dcols * (unitW - 4) + PAD * 2, 260);
			boxes.unshift({ z, x: bx, y: by, w, h });
			by += h + 30;
			bw = Math.max(bw, w);
		}
		const cx = bx + bw + (colB.length ? 90 : 0);
		let cy = 0;
		for (const z of colC) {
			const r = stackZone(z, cx, cy);
			cy += r.h + 30;
		}
		// Spread column A and C vertically to match the middle column height.
		const rects = new Map();
		for (const nd of nodes) {
			rects.set(nd.u.id, { x: nd.x, y: nd.y, w: nd.w, h: nd.h, key: nd.u.id });
		}
		const routes = [];
		const zoneOf = new Map(units.map(u => [u.id, u.zone]));
		(dep.links ?? []).forEach((l, i) => {
			const a = rects.get(l.from), b = rects.get(l.to);
			if (a && b && a !== b) {
				const inner = zoneOf.get(l.from) && zoneOf.get(l.from) === zoneOf.get(l.to);
				routes.push({ id: `d${i}`, a, b, label: inner ? '' : (l.label ?? ''), async: !!l.async, inner });
			}
		});
		routeEdges(routes, [...rects.values()].concat(boxes.map(b => ({ x: b.x, y: b.y, w: b.w, h: 34 }))));
		let maxX = 0, maxY = 0, minY = 0;
		for (const b of boxes) {
			maxX = Math.max(maxX, b.x + b.w);
			maxY = Math.max(maxY, b.y + b.h);
		}
		for (const r of routes) {
			for (const sg of r.segs) {
				for (const p of sg) {
					maxY = Math.max(maxY, p.y);
					minY = Math.min(minY, p.y);
				}
			}
			if (r.lab) {
				maxY = Math.max(maxY, r.lab.y + r.lab.h);
			}
		}
		const M = 30;
		const off = { x: M, y: M - minY };
		const mv = r => {
			r.x += off.x;
			r.y += off.y;
		};
		boxes.forEach(mv);
		nodes.forEach(mv);
		for (const r of routes) {
			r.segs = r.segs.map(sg => sg.map(p => ({ x: p.x + off.x, y: p.y + off.y })));
			r.d = `M${r1(r.segs[0][0].x)},${r1(r.segs[0][0].y)}` + r.segs.map(sg => ` C${r1(sg[1].x)},${r1(sg[1].y)} ${r1(sg[2].x)},${r1(sg[2].y)} ${r1(sg[3].x)},${r1(sg[3].y)}`).join('');
			if (r.lab) {
				mv(r.lab);
			}
		}
		return { boxes, nodes, routes, w: maxX + M * 2, h: maxY - minY + M * 2 };
	}

	function deployView() {
		const dep = S.model?.deploy;
		if (!dep || !Array.isArray(dep.units) || !dep.units.length) {
			S.drawing = null;
			return {
				html: `<div class="as-empty">${icon('cloud')}<h3 class="small">Não encontrei arquivos de implantação</h3><p>Procurei Docker, Kubernetes, Terraform, Compose e similares e não achei nada que diga onde cada parte roda.</p><p>Se a implantação estiver em outro repositório, peça no chat para descrevê-la.</p><div class="as-chips" style="margin-top:12px"><button class="as-btn" data-act="ask" data-text="Vou descrever onde o sistema roda: " data-send="0">${icon('comment')}Descrever a implantação</button></div></div>`,
				plain: true,
			};
		}
		const sc = deployScene(dep);
		let s = svgOpen(sc.w, sc.h);
		for (const b of sc.boxes) {
			const z = b.z;
			const kind = z.kind === 'cluster' ? 'cluster' : '';
			const color = z.kind === 'cluster' || z.kind === 'cloud' || z.kind === 'host' ? KINDS.backend.c : KINDS.external.c;
			const count = sc.nodes.filter(nd => nd.u.zone === z.id).length;
			s += `<g class="bx zone ${kind}" style="--c:${color}"><rect class="bx-bg" x="${r1(b.x + .5)}" y="${r1(b.y + .5)}" width="${r1(b.w - 1)}" height="${r1(b.h - 1)}" rx="12"/>`;
			s += iconAt(ZONE_ICONS[z.kind] ?? 'cloud', b.x + 14, b.y + 12, 15, 'bx-icon');
			const name = clip(z.name, b.w - 120, 12.5, 600);
			s += `<text class="bx-name" x="${r1(b.x + 36)}" y="${r1(b.y + 24)}">${esc(name)}</text>`;
			if (count) {
				s += `<text class="bx-sub" x="${r1(b.x + 44 + textW(name, 12.5, 600))}" y="${r1(b.y + 24)}">${esc(plural(count, 'unidade', 'unidades'))}</text>`;
			}
			s += '</g>';
		}
		for (const r of sc.routes) {
			s += `<path class="ed${r.async ? ' async' : ''}${r.inner ? ' thin' : ''}"${r.inner ? ' opacity=".55"' : ''} d="${r.d}" marker-end="url(#ah-n)"/>`;
		}
		const sel = S.sel;
		const isOn = u => u.id === S.selUnit || S.highlight.has(u.id) || (!!u.node && (u.node === sel || S.highlight.has(u.node)));
		let hint = null;
		for (const nd of sc.nodes) {
			const u = nd.u;
			const linked = node(u.node);
			const kind = linked && linked.level !== 'file' ? linked.kind : UNIT_KINDS[u.kind] ?? 'backend';
			const fake = { id: u.id, name: u.name, level: 'service', kind, summary: unitSubtitle(u), tech: u.replicas > 1 ? `×${num(u.replicas)}` : '' };
			const it = { id: u.id, n: fake, x: nd.x, y: nd.y, w: nd.w, h: nd.h, style: 'svc', iconName: UNIT_ICONS[u.kind] ?? 'cube', noOpen: true };
			const on = isOn(u);
			s += svgNode(it, on ? 'sel' : '').replace(' data-id="', ' data-unit="');
			if (on && !hint) {
				hint = nd;
			}
		}
		for (const r of sc.routes) {
			if (r.lab && r.label && !r.lab.onNode) {
				s += svgLabel(r.lab, r.label);
			}
		}
		if (hint && S.note) {
			s += svgHint(hint.x + 10, hint.y + hint.h + 12, S.note);
		}
		s += '</g></svg>';
		S.drawing = { w: sc.w, h: sc.h, key: 'deploy' };
		const unit = dep.units.find(u => u.id === S.selUnit);
		if (unit) {
			const zone = (dep.zones ?? []).find(z => z.id === unit.zone);
			const linked = node(unit.node);
			const card = `<div class="as-card" style="right:16px;bottom:16px;width:300px"><h4>${icon(UNIT_ICONS[unit.kind] ?? 'cube')}${esc(unit.name)}</h4>`
				+ `<div class="row">Tipo<b>${esc(UNIT_WORDS[unit.kind] ?? unit.kind ?? '—')}</b></div>`
				+ (zone ? `<div class="row">Onde<b>${esc(zone.name)}</b></div>` : '')
				+ (unit.image ? `<div class="row">Imagem<b>${esc(unit.image)}</b></div>` : '')
				+ (Array.isArray(unit.ports) && unit.ports.length ? `<div class="row">Portas<b>${esc(unit.ports.join(', '))}</b></div>` : '')
				+ (unit.replicas ? `<div class="row">Réplicas<b>${num(unit.replicas)}</b></div>` : '')
				+ (linked ? `<div class="acts"><button class="as-btn small" data-act="focus-map" data-id="${esc(linked.id)}">${icon('map')}Ver ${esc(linked.name)} no mapa</button></div>` : '')
				+ '</div>';
			return { html: s + card };
		}
		return { html: s };
		return { html: s };
	}

	// ------------------------------------------------------------------ matrix mode

	function matrixData(scopeId) {
		const g = sceneGraph(scopeId, { open: new Set() });
		let inside = [...g.inside.values()].map(v => v.n);
		const outside = [...g.outside.values()].filter(Boolean);
		let edges = g.edges;
		let grouped = false;
		const sc = g.scopeNode;
		if (sc && sc.level === 'service' && inside.length > 40) {
			grouped = true;
			const folderOf = new Map(inside.map(f => [f.id, `folder:${f.folder ?? ''}`]));
			const folders = new Map();
			for (const f of inside) {
				const id = folderOf.get(f.id);
				if (!folders.has(id)) {
					folders.set(id, { id, name: f.folder || '(raiz)', level: 'folder', kind: 'file' });
				}
			}
			inside = [...folders.values()];
			const merged = new Map();
			for (const e of edges) {
				const a = folderOf.get(e.from) ?? e.from, b = folderOf.get(e.to) ?? e.to;
				if (a === b) {
					continue;
				}
				const key = `${a}>${b}`;
				const m = merged.get(key) ?? merged.set(key, { id: key, from: a, to: b, count: 0, links: [] }).get(key);
				m.count += e.count;
				m.links.push(...e.links);
			}
			edges = [...merged.values()];
		}
		// Order inside items like the map reads (columns left to right).
		let order = inside;
		if (!grouped) {
			try {
				const scene = mapScene(scopeId, { open: new Set(), tag: 'matrix' });
				const pos = new Map(scene.nodes.map(it => [it.id, it]));
				const vertical = scene.dir === 'v';
				order = inside.slice().sort((a, b) => {
					const pa = pos.get(a.id), pb = pos.get(b.id);
					if (!pa || !pb) {
						return byName(a, b);
					}
					return vertical ? (Math.round(pa.y / 40) - Math.round(pb.y / 40)) || (pa.x - pb.x) : (Math.round(pa.x / 40) - Math.round(pb.x / 40)) || (pa.y - pb.y);
				});
			} catch {
				order = inside.slice().sort(byName);
			}
		} else {
			order = inside.slice().sort(byName);
		}
		const linked = new Set();
		for (const e of edges) {
			linked.add(e.from);
			linked.add(e.to);
		}
		order = order.filter(n => linked.has(n.id)).concat(order.filter(n => !linked.has(n.id)));
		const items = order.concat(outside.sort((a, b) => (a.level === b.level ? byName(a, b) : String(a.level).localeCompare(String(b.level)))));
		const index = new Map(items.map((n, i) => [n.id, i]));
		const cells = new Map();
		for (const e of edges) {
			const i = index.get(e.from), j = index.get(e.to);
			if (i === undefined || j === undefined || i === j) {
				continue;
			}
			cells.set(`${i},${j}`, { count: e.count, edge: e });
		}
		// Strongly connected components (Tarjan).
		const adj = items.map(() => []);
		const insideN = order.length;
		for (const [key, c] of cells) {
			const [i, j] = key.split(',').map(Number);
			const sync = c.edge.links ? c.edge.links.some(l => !l.async) : true;
			if (i < insideN && j < insideN && sync && !isTopLevelLeaf(items[i]) && !isTopLevelLeaf(items[j])) {
				adj[i].push(j);
			}
		}
		let counter = 0;
		const idxOf = new Array(items.length).fill(-1), low = new Array(items.length).fill(0), onStack = new Array(items.length).fill(false);
		const stack = [], comps = [];
		const strong = v => {
			idxOf[v] = low[v] = counter++;
			stack.push(v);
			onStack[v] = true;
			for (const w of adj[v]) {
				if (idxOf[w] < 0) {
					strong(w);
					low[v] = Math.min(low[v], low[w]);
				} else if (onStack[w]) {
					low[v] = Math.min(low[v], idxOf[w]);
				}
			}
			if (low[v] === idxOf[v]) {
				const comp = [];
				let w;
				do {
					w = stack.pop();
					onStack[w] = false;
					comp.push(w);
				} while (w !== v);
				if (comp.length > 1) {
					comps.push(comp.sort((a, b) => a - b));
				}
			}
		};
		for (let v = 0; v < items.length; v++) {
			if (idxOf[v] < 0) {
				strong(v);
			}
		}
		const compOf = new Map();
		comps.forEach((c, k) => c.forEach(v => compOf.set(v, k)));
		const insideCount = order.length;
		return { items, cells, comps, compOf, insideCount, grouped };
	}

	function matrixView() {
		const md = matrixData(S.scope);
		const n = md.items.length;
		if (n < 2) {
			S.drawing = null;
			return { html: '<div class="as-empty"><h3 class="small">Poucas partes para montar uma matriz</h3><p>Escolha um nível com mais partes ligadas entre si.</p></div>', plain: true };
		}
		const size = canvasSize();
		const avail = Math.max(320, Math.min(size.h - 200, size.w - 640));
		const cs = clamp(Math.floor(avail / n), 20, 54);
		const labelW = Math.min(170, Math.ceil(Math.max(...md.items.map(it => textW(it.name, 12)))) + 16);
		const rotate = n > 7 || md.items.some(it => textW(it.name, 11.5) > cs - 6);
		const headH = rotate ? Math.min(130, Math.ceil(Math.max(...md.items.map(it => textW(clip(it.name, 120, 11.5), 11.5)))) * 0.72 + 24) : 28;
		const x0 = 20 + labelW, y0 = 20 + headH;
		const W = x0 + n * cs + 20, H = y0 + n * cs + 46;
		const sel = S.matrixCell;
		const maxCount = Math.max(1, ...[...md.cells.values()].map(c => c.count));
		let s = svgOpen(W, H, '<pattern id="mx-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect class="mx-hatch-b" width="6" height="6"/><rect class="mx-hatch-a" width="3" height="6"/></pattern>');
		const hiRow = sel ? sel[0] : -1, hiCol = sel ? sel[1] : -1;
		md.items.forEach((it, i) => {
			const out = i >= md.insideCount ? ' out' : '';
			s += `<text class="mx-head${i === hiRow ? ' on' : ''}${out}" x="${x0 - 10}" y="${r1(y0 + i * cs + cs / 2 + 4)}" text-anchor="end">${esc(clip(it.name, labelW - 14, 12))}<title>${esc(it.name)}</title></text>`;
			if (rotate) {
				const cx = x0 + i * cs + cs / 2 + 4, cy = y0 - 8;
				s += `<text class="mx-head${i === hiCol ? ' on' : ''}${out}" x="${r1(cx)}" y="${r1(cy)}" transform="rotate(-45 ${r1(cx)} ${r1(cy)})">${esc(clip(it.name, 120, 11.5))}<title>${esc(it.name)}</title></text>`;
			} else {
				s += `<text class="mx-head${i === hiCol ? ' on' : ''}${out}" x="${r1(x0 + i * cs + cs / 2)}" y="${y0 - 10}" text-anchor="middle">${esc(clip(it.name, cs - 4, 11.5))}<title>${esc(it.name)}</title></text>`;
			}
		});
		for (let i = 0; i < n; i++) {
			for (let j = 0; j < n; j++) {
				const x = x0 + j * cs + 1, y = y0 + i * cs + 1, w = cs - 2;
				if (i === j) {
					s += `<rect class="mx-cell diag" x="${x}" y="${y}" width="${w}" height="${w}" rx="3"/>`;
					continue;
				}
				const c = md.cells.get(`${i},${j}`);
				if (!c) {
					s += `<rect class="mx-cell" x="${x}" y="${y}" width="${w}" height="${w}" rx="3"/>`;
					continue;
				}
				const cyc = md.compOf.has(i) && md.compOf.get(i) === md.compOf.get(j);
				const on = sel && sel[0] === i && sel[1] === j;
				const t = Math.log2(1 + c.count) / Math.log2(1 + maxCount);
				const alpha = (0.2 + 0.6 * t).toFixed(2);
				const fill = cyc ? '' : ` style="fill:rgba(76,141,255,${alpha})"`;
				s += `<rect class="mx-cell v${cyc ? ' cyc' : ''}${on ? ' sel' : ''}" data-act="cell" data-i="${i}" data-j="${j}" x="${x}" y="${y}" width="${w}" height="${w}" rx="3"${fill}><title>${esc(md.items[i].name)} → ${esc(md.items[j].name)}: ${plural(c.count, 'chamada', 'chamadas')}</title></rect>`;
				if (cs >= 24) {
					s += `<text class="mx-num${t < 0.35 && !cyc ? ' low' : ''}" x="${r1(x + w / 2)}" y="${r1(y + w / 2 + 4.3)}" text-anchor="middle">${c.count}</text>`;
				}
			}
		}
		s += `<text class="mx-foot" x="${x0}" y="${y0 + n * cs + 26}">Linha chama coluna · número de chamadas no código${md.grouped ? ' · arquivos agrupados por pasta' : ''}</text>`;
		s += '</g></svg>';
		S.drawing = { w: W, h: H, key: `matrix|${S.scope ?? ''}`, reserveRight: 440 };
		// Side cards.
		let cards = '<div style="position:absolute;right:16px;top:14px;width:min(420px,calc(100% - 32px));display:grid;gap:14px;z-index:3">';
		if (sel && md.cells.get(`${sel[0]},${sel[1]}`)) {
			const c = md.cells.get(`${sel[0]},${sel[1]}`);
			const a = md.items[sel[0]], b = md.items[sel[1]];
			const ev = [];
			for (const l of c.edge.links) {
				for (const x of l.evidence ?? []) {
					if (ev.length < 8) {
						ev.push({ x, right: l.label || l.protocol || '' });
					}
				}
			}
			cards += `<div class="as-card" style="position:relative"><h4>${icon('arrowR')}${esc(a.name)} chama ${esc(b.name)} · ${plural(c.count, 'vez', 'vezes')}</h4>`
				+ (ev.length ? ev.map(e => evidenceButton(e.x, e.right)).join('') : '<p>Sem trechos de código registrados para esta ligação.</p>')
				+ `<div class="acts"><button class="as-btn small" data-act="matrix-map" data-a="${esc(a.id)}" data-b="${esc(b.id)}">${icon('map')}Ver no mapa</button></div></div>`;
		}
		for (const comp of md.comps.slice(0, 3)) {
			const names = comp.map(i => md.items[i].name);
			const pairs = [];
			for (const i of comp) {
				for (const j of comp) {
					const c = md.cells.get(`${i},${j}`);
					if (c) {
						pairs.push(`<b>${esc(md.items[i].name)} → ${esc(md.items[j].name)}</b> (${plural(c.count, 'chamada', 'chamadas')})`);
					}
				}
			}
			const ids = comp.map(i => md.items[i].id);
			cards += `<div class="as-card warn" style="position:relative"><h4>${icon('warning')}Dependência circular</h4><p>${pairs.slice(0, 4).join(' e ')}.</p><p>Se uma dessas partes cair, as outras também param. Uma fila ou um evento pode trocar uma das chamadas diretas.</p>`
				+ `<div class="acts"><button class="as-btn small" data-act="cycle-map" data-ids="${esc(ids.join('|'))}">${icon('map')}Ver no mapa</button><button class="as-btn small" data-act="ask" data-send="0" data-text="${esc(`Como desfazer a dependência circular entre ${names.join(', ')}?`)}">${icon('comment')}Perguntar como corrigir</button></div></div>`;
		}
		cards += '</div>';
		const legend = '<div class="as-legend"><span><i style="background:rgba(76,141,255,.3)"></i>poucas chamadas</span><span><i style="background:rgba(76,141,255,.55)"></i>várias</span><span><i style="background:rgba(76,141,255,.8)"></i>muitas</span><span><i style="background:rgba(248,81,73,.55)"></i>ciclo</span></div>';
		S.matrixInfo = { cycles: md.comps.length };
		return { html: s + cards + legend };
	}

	// ------------------------------------------------------------------ empty, scanning and failed states

	function emptyView() {
		const ctx = S.ctx ?? {};
		const project = ctx.project !== false && ctx.project !== undefined ? true : !!ctx.project;
		const picked = ctx.sourceKind === 'folder' && ctx.source;
		const illus = `<svg class="illus" width="300" height="170" viewBox="0 0 300 170" aria-hidden="true"><rect class="r1" x="10" y="8" width="280" height="154" rx="16"/><text class="t1" x="26" y="32" font-size="12">Sistemas</text><rect class="r2" x="56" y="44" width="196" height="106" rx="12"/><text class="t2" x="70" y="66" font-size="12">Serviços</text><rect class="r3" x="98" y="80" width="112" height="56" rx="9"/><text class="t3" x="112" y="101" font-size="12">Arquivos</text><rect class="r4" x="112" y="110" width="22" height="14" rx="3"/><rect class="r4" x="140" y="110" width="22" height="14" rx="3"/><rect class="r4" x="168" y="110" width="22" height="14" rx="3"/></svg>`;
		let s = `<div class="as-empty">${illus}<h3>Desenhe a arquitetura de qualquer sistema</h3><p>O agente lê o código e monta o mapa: primeiro os sistemas, depois os serviços de cada sistema e, dentro de cada serviço, os arquivos e como se ligam.</p><div class="as-starts">`;
		const projSource = ctx.sourceKind === 'project' && ctx.source ? `<code>${esc(ctx.source)}</code>` : '';
		s += `<button class="as-start${project && !picked ? ' on' : ''}" data-act="ask" data-text="Desenhe a arquitetura deste projeto." data-send="1"${project ? '' : ' disabled'}>${icon('folderOpen')}<b>Este projeto</b><small>${project ? 'Usa a pasta aberta nesta conversa.' : 'Esta conversa não tem uma pasta aberta.'}</small>${projSource}</button>`;
		if (picked) {
			s += `<div class="as-start on" role="group" aria-label="Pasta escolhida">${icon('folder')}<b>${esc(ctx.source)}</b><small>Pasta escolhida para desenhar.</small><span class="go"><button class="as-btn primary small" data-act="ask" data-text="${esc(`Desenhe a arquitetura da pasta ${ctx.source}.`)}" data-send="1">${icon('arrowR')}Desenhar esta pasta</button> <button class="as-btn small" data-act="pick">Trocar</button></span></div>`;
		} else {
			s += `<button class="as-start" data-act="pick">${icon('folder')}<b>Escolher outra pasta</b><small>Um repositório ou vários, lado a lado no mesmo mapa.</small></button>`;
		}
		s += `<button class="as-start" data-act="ask" data-text="Vou descrever o sistema: " data-send="0">${icon('edit')}<b>Descrever em texto</b><small>Para sistemas sem código aqui: conte as partes e o agente desenha.</small></button></div>`;
		s += `<div class="as-kinds">Funciona com<span>${icon('service')}Backend</span><span>${icon('web')}Web</span><span>${icon('mobile')}Mobile</span><span>${icon('chip')}Embarcado</span><span>${icon('cloud')}Infraestrutura</span></div></div>`;
		return { html: s, plain: true };
	}

	function scanningEmptyView() {
		const p = S.progress;
		const steps = Array.isArray(p.steps) ? p.steps : [];
		let s = `<div class="as-empty">${icon('spinner', 'spin')}<h3 class="small">Mapeando o projeto</h3><p>Os sistemas aparecem aqui assim que forem encontrados.</p><div class="as-steps">`;
		for (const st of steps) {
			const ic = st.state === 'done' ? icon('passed') : st.state === 'run' ? icon('spinner', 'spin') : icon('circle');
			s += `<div class="as-step ${esc(st.state)}">${ic}<span>${esc(st.label)}</span>${st.note ? `<span class="note">${esc(st.note)}</span>` : ''}</div>`;
		}
		s += '</div></div>';
		return { html: s + scanCardHtml(), plain: true };
	}

	function failedHtml(inline) {
		const p = S.progress;
		const card = `<div class="as-card warn" style="${inline ? 'left:16px;bottom:16px;' : 'position:relative;'}width:min(480px,calc(100% - 32px))"><h4>${icon('warning')}O mapeamento parou</h4><p>${esc(p.error ?? 'Algo deu errado ao ler o projeto.')}</p><div class="acts"><button class="as-btn small" data-act="ask" data-text="Mapeie a arquitetura de novo." data-send="1">${icon('refresh')}Tentar de novo</button></div></div>`;
		return inline ? card : `<div class="as-empty">${card}</div>`;
	}

	// ------------------------------------------------------------------ toolbar

	const $ = sel => document.querySelector(sel);

	function levelContext() {
		let sys = null, svc = null, depth = 0;
		if (S.mode === 'columns') {
			const c = colsState();
			sys = node(c.sys);
			svc = node(c.svc);
			depth = c.file || c.svc ? 2 : 1;
		} else if (S.mode === 'layers') {
			const st = layersState();
			sys = node(st.sys);
			svc = node(st.svc);
			depth = 2;
		} else {
			const sc = node(S.scope);
			if (sc) {
				const chain = S.idx.chain(sc.id);
				sys = node(chain[chain.length - 1]);
				svc = sc.level === 'service' ? sc : null;
				depth = sc.level === 'service' ? 2 : 1;
			}
		}
		return { sys, svc, depth };
	}

	function levelsHtml() {
		const m = S.idx;
		if (!m) {
			return `<div class="as-seg levels" role="group" aria-label="Níveis"><button disabled>Sistemas</button><button disabled>Serviços</button><button disabled>Arquivos</button></div>`;
		}
		const ctx = levelContext();
		const words = ctx.sys ? childWords(ctx.sys) : ['serviço', 'serviços'];
		const svcCount = ctx.sys ? kidsOf(ctx.sys.id).length : m.stats.services;
		const fileCount = ctx.svc ? kidsOf(ctx.svc.id).length : ctx.sys ? (ctx.sys.files ?? 0) : m.stats.files;
		const b = (lvl, label, count) => `<button class="${ctx.depth === lvl ? 'on' : ''}" data-act="level" data-level="${lvl}" aria-pressed="${ctx.depth === lvl}">${label}<em>${num(count)}</em></button>`;
		return `<div class="as-seg levels" role="group" aria-label="Níveis">${b(0, 'Sistemas', m.stats.systems)}${b(1, words[1][0].toUpperCase() + words[1].slice(1), svcCount)}${b(2, 'Arquivos', fileCount)}</div>`;
	}

	function crumbChain() {
		if (S.mode === 'columns') {
			const c = colsState();
			return [c.sys, c.svc, c.file].filter(Boolean);
		}
		if (S.mode === 'layers') {
			const st = layersState();
			const list = [st.sys, st.svc].filter(Boolean);
			const sel = node(S.sel);
			if (sel && sel.level === 'file' && sel.parent === st.svc) {
				list.push(sel.id);
			}
			return list;
		}
		const list = S.scope ? S.idx.chain(S.scope).reverse() : [];
		const sel = node(S.sel);
		if (sel) {
			const chain = S.idx.chain(sel.id).reverse();
			const depth = chain.length - list.length;
			// On the map a direct child of the scope stays out of the breadcrumb (it is just selected);
			// deeper selections (inside parts opened in place) and drill-downs in the other modes show their path.
			const show = S.mode === 'map' ? depth >= 2 : depth >= 1;
			if (show && ((!S.scope && chain.length > 1) || (S.scope && chain.includes(S.scope)))) {
				for (const id of chain) {
					if (!list.includes(id) && (S.mode !== 'map' || node(id).level !== 'data')) {
						list.push(id);
					}
				}
			}
		}
		return list;
	}

	function crumbsHtml() {
		if (!S.model) {
			return `<nav class="as-crumbs" aria-label="Local"><span class="as-crumb on">${icon('system')}<span>${S.progress?.status === 'scanning' ? 'Mapeando…' : 'Novo mapa'}</span></span></nav>`;
		}
		const parts = [{ label: S.model.name || S.model.source || 'Projeto', icon: 'system', act: 'crumb', id: '' }];
		if (S.mode === 'path' || S.mode === 'present') {
			const p = currentPath();
			if (p) {
				parts.push({ label: `${S.mode === 'path' ? 'Caminho' : 'Apresentação'}: ${p.name}`, icon: S.mode === 'path' ? 'path' : 'present', act: 'menu', menu: 'paths', chev: pathList().length > 1 });
			}
		} else if (S.mode === 'deploy') {
			parts.push({ label: 'Implantação', icon: 'cloud' });
		} else {
			for (const id of crumbChain()) {
				const n = node(id);
				if (n) {
					parts.push({ label: n.name, icon: iconOf(n), act: 'crumb', id: n.id });
				}
			}
		}
		let s = '<nav class="as-crumbs" aria-label="Local">';
		parts.forEach((p, i) => {
			const last = i === parts.length - 1;
			if (i) {
				s += `<svg class="as-ic sep" viewBox="0 0 16 16" aria-hidden="true">${ICONS.chevR}</svg>`;
			}
			const attrs = p.act ? ` data-act="${p.act}"${p.id !== undefined ? ` data-id="${esc(p.id)}"` : ''}${p.menu ? ` data-menu="${p.menu}"` : ''}` : '';
			s += `<button class="as-crumb${last ? ' on' : ''}"${attrs} title="${esc(p.label)}"${last ? ' aria-current="location"' : ''}>${icon(p.icon)}<span>${esc(p.label)}</span>${p.chev ? icon('chevD') : ''}</button>`;
		});
		return s + '</nav>';
	}

	function statusHtml() {
		if (S.filesError) {
			return `<span class="as-status bad" role="alert" title="${esc(S.filesError)}">${icon('warning')}Não foi possível atualizar o mapa</span>`;
		}
		const p = S.progress;
		if (p?.status === 'scanning') {
			return '<span class="as-status live" role="status">Mapeando</span>';
		}
		if (p?.status === 'failed') {
			return `<span class="as-status bad" role="status">${icon('warning')}Mapeamento parou</span>`;
		}
		if (!S.model) {
			return `<span class="as-status">${S.running ? `${icon('spinner', 'spin')}Trabalhando…` : 'Nada desenhado ainda'}</span>`;
		}
		if (S.running) {
			return `<span class="as-status">${icon('spinner', 'spin')}Trabalhando…</span>`;
		}
		switch (S.mode) {
			case 'circles': return '<span class="as-status">Tamanho = linhas de código</span>';
			case 'blocks': return '<span class="as-status">Área = linhas de código</span>';
			case 'layers': return '<span class="as-status">3 níveis visíveis</span>';
			case 'matrix': {
				const c = S.matrixInfo?.cycles ?? 0;
				return c ? `<span class="as-status bad">${icon('warning')}${plural(c, 'ciclo encontrado', 'ciclos encontrados')}</span>` : `<span class="as-status">${icon('check')}Sem ciclos</span>`;
			}
			case 'deploy': {
				const u = S.model.deploy?.units?.length ?? 0;
				return u ? `<span class="as-status">${plural(u, 'unidade', 'unidades')}</span>` : '';
			}
			case 'path':
			case 'present': {
				const cp = currentPath();
				return cp ? `<span class="as-status keep">Passo ${clamp(S.step | 0, 0, cp.steps.length - 1) + 1} de ${cp.steps.length}</span>` : '';
			}
		}
		if (currentProposal()) {
			const pr = S.proposal;
			const add = pr.nodes.filter(x => x.op === 'add').length, chg = pr.nodes.filter(x => x.op === 'change').length, rem = pr.nodes.filter(x => x.op === 'remove').length;
			const links = pr.links.length;
			return `<span class="as-status">${[add ? plural(add, 'novo', 'novos') : '', chg ? plural(chg, 'alterado', 'alterados') : '', rem ? plural(rem, 'sai', 'saem') : '', links ? plural(links, 'ligação', 'ligações') : ''].filter(Boolean).join(' · ')}</span>`;
		}
		return `<span class="as-status" title="${esc(S.model.scannedAt ?? '')}">${icon('check')}${esc(relTime(S.model.scannedAt))}</span>`;
	}

	function modesHtml() {
		const disabled = !S.model ? ' disabled' : '';
		const extra = ['layers', 'path', 'present', 'deploy', 'matrix'];
		if (S.barLevel >= 2) {
			const m = MODES[S.mode];
			return `<div class="as-seg" role="group" aria-label="Modo"><button class="on" data-act="menu" data-menu="allmodes"${disabled} aria-haspopup="menu">${icon(m.icon)}${esc(m.label)}${icon('chevD')}</button></div>`;
		}
		let s = '<div class="as-seg modes" role="group" aria-label="Modo de desenho">';
		for (const [id, m] of Object.entries(MODES)) {
			if (m.main) {
				s += `<button class="${S.mode === id ? 'on' : ''}" data-act="mode" data-mode="${id}"${disabled} aria-pressed="${S.mode === id}" title="${esc(m.label)}">${esc(m.label)}</button>`;
			}
		}
		const ex = extra.includes(S.mode) ? MODES[S.mode] : null;
		s += `<button class="${ex ? 'on' : ''}" data-act="menu" data-menu="modes"${disabled} aria-haspopup="menu" title="Mais modos">${ex ? esc(ex.label) : 'Mais'}${icon('chevD')}</button>`;
		return s + '</div>';
	}

	function zoomHtml() {
		const v = S.vp[S.vpKey];
		const has = !!S.drawing;
		const pct = v ? `${Math.round(v.k * 100)}%` : '100%';
		return `<div class="as-zoom" role="group" aria-label="Zoom"><button class="as-ib" data-act="zoom-out" title="Diminuir" aria-label="Diminuir"${has ? '' : ' disabled'}>${icon('zoomOut')}</button><button class="pct" id="as-zoom-pct" data-act="fit" title="Ajustar à tela"${has ? '' : ' disabled'}>${pct}</button><button class="as-ib" data-act="zoom-in" title="Aumentar" aria-label="Aumentar"${has ? '' : ' disabled'}>${icon('zoomIn')}</button></div>`;
	}

	function searchHtml() {
		if (!S.search.open) {
			return `<button class="as-ib" data-act="search-open" title="Procurar (Ctrl+F)" aria-label="Procurar"${S.model ? '' : ' disabled'}>${icon('search')}</button>`;
		}
		const hits = S.search.hits.length;
		const count = S.search.q.trim() ? (hits ? `${S.search.i >= 0 ? S.search.i + 1 : 0} de ${num(hits)}` : 'nada') : '';
		return `<div class="as-search">${icon('search')}<input id="as-search-input" type="text" value="${esc(S.search.q)}" placeholder="Procurar por nome" aria-label="Procurar por nome" spellcheck="false"><span class="count" id="as-search-count">${count}</span><button class="as-ib" data-act="search-close" title="Fechar busca" aria-label="Fechar busca">${icon('close')}</button></div>`;
	}

	function barHtml() {
		let s = '';
		const present = S.mode === 'present';
		const scopeModes = ['map', 'columns', 'circles', 'blocks', 'layers', 'matrix'];
		if (!present && (!S.model || scopeModes.includes(S.mode)) && S.barLevel < 4) {
			s += levelsHtml();
		}
		s += crumbsHtml();
		s += '<span class="as-sp"></span>';
		if (S.model && S.mode === 'map' && S.proposal && !present) {
			s += `<div class="as-seg" role="group" aria-label="Proposta"><button class="${S.proposalOn ? '' : 'on'}" data-act="proposal" data-on="0" aria-pressed="${!S.proposalOn}">Atual</button><button class="${S.proposalOn ? 'on' : ''}" data-act="proposal" data-on="1" aria-pressed="${S.proposalOn}">Proposta</button></div>`;
		}
		if (S.filesError || !(S.mode === 'map' && S.proposal) || S.running || S.progress?.status === 'scanning' || S.progress?.status === 'failed') {
			s += statusHtml();
		}
		if (S.mode === 'path' || present) {
			const p = currentPath();
			if (p) {
				s += `<button class="as-ib" data-act="step-prev" title="Passo anterior (←)" aria-label="Passo anterior">${icon('chevL')}</button>`;
				if (!present) {
					s += `<button class="as-ib${S.playing ? ' on' : ''}" data-act="play" title="${S.playing ? 'Pausar' : 'Tocar'}" aria-label="${S.playing ? 'Pausar' : 'Tocar'}">${icon(S.playing ? 'pause' : 'play')}</button>`;
				}
				s += `<button class="as-ib" data-act="step-next" title="Próximo passo (→)" aria-label="Próximo passo">${icon('chevR')}</button>`;
			}
		}
		if (present) {
			s += `<button class="as-btn" data-act="exit-present">${icon('close')}Sair da apresentação</button>`;
			return s;
		}
		if (S.model) {
			s += modesHtml();
			s += '<span class="as-divider"></span>';
		}
		s += searchHtml();
		if (S.model) {
			s += zoomHtml();
		}
		s += `<button class="as-btn export" data-act="menu" data-menu="export" aria-haspopup="menu"${S.model ? '' : ' disabled'}>${icon('export')}<span>Exportar</span></button>`;
		return s;
	}

	function menuHtml() {
		const m = S.menu;
		if (!m) {
			return '';
		}
		let items = '';
		if (m.kind === 'modes' || m.kind === 'allmodes') {
			for (const [id, md] of Object.entries(MODES)) {
				if (m.kind === 'modes' && md.main) {
					continue;
				}
				const dis = (id === 'path' || id === 'present') && !pathList().length && id === 'present' ? ' disabled' : '';
				items += `<button class="as-mi${S.mode === id ? ' on' : ''}" role="menuitem" data-act="mode" data-mode="${id}"${dis}>${icon(md.icon)}<span class="t"><span>${esc(md.label)}</span>${md.hint ? `<small>${esc(md.hint)}</small>` : ''}</span></button>`;
			}
		} else if (m.kind === 'export') {
			items += `<button class="as-mi" role="menuitem" data-act="export-svg"${S.drawing ? '' : ' disabled'}>${icon('image')}<span class="t"><span>Imagem SVG</span><small>O desenho que está na tela</small></span></button>`;
			items += `<button class="as-mi" role="menuitem" data-act="export-json">${icon('json')}<span class="t"><span>Modelo em JSON</span><small>Sistemas, serviços, arquivos e ligações</small></span></button>`;
		} else if (m.kind === 'paths') {
			const cur = currentPath();
			for (const p of pathList()) {
				items += `<button class="as-mi${cur && p.id === cur.id ? ' on' : ''}" role="menuitem" data-act="path-pick" data-id="${esc(p.id)}">${icon('path')}<span class="t"><span>${esc(p.name)}</span><small>${plural(p.steps.length, 'passo', 'passos')}</small></span></button>`;
			}
		}
		const left = clamp(m.x, 8, window.innerWidth - 260);
		return `<div class="as-menu" role="menu" id="as-menu-box" style="left:${left}px;top:${m.y}px">${items}</div>`;
	}

	// ------------------------------------------------------------------ rendering

	let root = null;
	function ensureRoot() {
		if (root) {
			return;
		}
		document.body.innerHTML = '<div class="as" id="as"><header class="as-bar" id="as-bar"></header><div class="as-body" id="as-body"></div><div id="as-menu"></div></div>';
		root = $('#as');
		fontFamily = getComputedStyle(document.body).fontFamily || fontFamily;
	}

	function canvasSize() {
		const insp = inspectorVisible() && (S.width || window.innerWidth) >= 900;
		const w = (S.width || window.innerWidth) - (insp ? 300 : 0);
		const h = window.innerHeight - 44 - (S.mode === 'columns' ? 300 : 0);
		return { w, h };
	}

	function inspectorVisible() {
		if (!S.insp || !S.sel || !S.model || (S.mode !== 'map' && S.mode !== 'blocks')) {
			return false;
		}
		if (S.mode === 'map' && codeTarget()) {
			return false;
		}
		return !!(node(S.sel) ?? currentProposal()?.nodes.find(p => p.id === S.sel && p.op === 'add'));
	}

	function bodyContent() {
		S.drawing = null;
		if (!S.model) {
			if (S.progress?.status === 'scanning') {
				return scanningEmptyView();
			}
			if (S.progress?.status === 'failed') {
				return { html: failedHtml(false), plain: true };
			}
			return emptyView();
		}
		if (!S.idx.byId.size) {
			return { html: '<div class="as-empty"><h3 class="small">O mapa ainda está vazio</h3><p>O arquivo do modelo existe, mas ainda não tem partes. Peça no chat para mapear o projeto.</p></div>', plain: true };
		}
		switch (S.mode) {
			case 'columns': return columnsView();
			case 'circles': return circlesView();
			case 'blocks': return blocksView();
			case 'layers': return layersView();
			case 'path': return pathView();
			case 'present': return presentView();
			case 'deploy': return deployView();
			case 'matrix': return matrixView();
			default: return mapView();
		}
	}

	function focusKeyOf(el) {
		if (!el || el === document.body) {
			return null;
		}
		if (el.id === 'as-search-input') {
			return '#as-search-input';
		}
		const id = el.getAttribute?.('data-id'), act = el.getAttribute?.('data-act');
		if (act) {
			return `[data-act="${act}"]${id !== null ? `[data-id="${CSS.escape(id)}"]` : ''}${el.dataset.mode ? `[data-mode="${el.dataset.mode}"]` : ''}${el.dataset.level ? `[data-level="${el.dataset.level}"]` : ''}`;
		}
		if (id !== null) {
			return `[data-id="${CSS.escape(id)}"]`;
		}
		const unit = el.getAttribute?.('data-unit');
		if (unit) {
			return `[data-unit="${CSS.escape(unit)}"]`;
		}
		return null;
	}

	function render() {
		ensureRoot();
		const active = document.activeElement;
		const key = focusKeyOf(active);
		const caret = active?.id === 'as-search-input' ? active.selectionStart : null;
		renderBody();
		renderBar();
		renderMenu();
		if (key) {
			const el = root.querySelector(key);
			if (el && typeof el.focus === 'function') {
				el.focus({ preventScroll: true });
				if (caret !== null && el.setSelectionRange) {
					el.setSelectionRange(caret, caret);
				}
			}
		}
	}

	function renderBar() {
		ensureRoot();
		const bar = $('#as-bar');
		// Compact the bar step by step until the breadcrumb fits: hide the status, fold the modes
		// into one menu, drop counts and labels, and finally the level switch.
		const tight = () => {
			const nav = bar.querySelector('.as-crumbs');
			const navShort = nav && nav.scrollWidth > nav.clientWidth + 1 && nav.clientWidth < 260;
			return navShort || bar.scrollWidth > bar.clientWidth + 1;
		};
		for (let level = 0; level <= 4; level++) {
			S.barLevel = level;
			bar.innerHTML = barHtml();
			root.classList.toggle('narrow', level >= 3);
			const status = bar.querySelector('.as-status');
			if (status && level >= 1 && !S.filesError) {
				status.style.display = 'none';
			}
			if (!tight()) {
				break;
			}
		}
	}

	function renderMenu() {
		$('#as-menu').innerHTML = menuHtml();
	}

	/** Scroll positions that survive a re-render when the same content is shown again. */
	function keepScroll() {
		const saved = [];
		document.querySelectorAll('.as-col .list').forEach((el, i) => saved.push([`.as-col:nth-child(${i + 1}) .list`, el.scrollTop, el.parentElement.querySelector('h5')?.textContent]));
		const lines = document.getElementById('as-lines');
		if (lines) {
			saved.push(['#as-lines', lines.scrollTop, S.code.path]);
		}
		const insp = document.querySelector('.as-insp');
		if (insp) {
			saved.push(['.as-insp', insp.scrollTop, insp.querySelector('h3')?.textContent]);
		}
		return () => {
			for (const [sel, top, tag] of saved) {
				const el = document.querySelector(sel);
				const now = sel === '#as-lines' ? S.code.path : sel === '.as-insp' ? el?.querySelector('h3')?.textContent : el?.parentElement.querySelector('h5')?.textContent;
				if (el && now === tag) {
					el.scrollTop = top;
				}
			}
			document.querySelectorAll('.as-col .as-it.on').forEach(el => {
				const list = el.parentElement;
				if (el.offsetTop < list.scrollTop || el.offsetTop + el.offsetHeight > list.scrollTop + list.clientHeight) {
					list.scrollTop = el.offsetTop - list.clientHeight / 2;
				}
			});
		};
	}

	function renderBody() {
		ensureRoot();
		const restore = keepScroll();
		const c = bodyContent();
		let html;
		if (S.mode === 'columns' && c.lists) {
			html = `<div class="as-main">${c.lists}<div class="as-canvas${c.plain ? ' plain' : ''}" id="as-canvas">${c.canvas}</div></div>`;
		} else {
			const code = S.model ? codeTarget() : null;
			if (code) {
				requestCode(code);
			}
			html = `<div class="as-main"><div class="as-canvas${c.plain ? ' plain' : ''}" id="as-canvas">${c.html}</div>${code ? codeHtml(code) : ''}</div>`;
			if (inspectorVisible()) {
				html += inspectorHtml(S.sel);
			}
		}
		$('#as-body').innerHTML = html;
		restore();
		afterBody();
	}

	function afterBody() {
		const d = S.drawing;
		if (d) {
			S.vpKey = `${S.mode}|${d.key}`;
			const v = S.vp[S.vpKey];
			if (!v || (v.auto && (v.w !== Math.ceil(d.w) || v.h !== Math.ceil(d.h)))) {
				fit();
			} else {
				applyVp();
			}
			const code = S.mode === 'map' ? codeTarget() : null;
			if (code && S.zoomedFor !== code.id) {
				S.zoomedFor = code.id;
				zoomToNode(code.id, 0.85);
			} else if (S.centerOn) {
				centerOn(S.centerOn);
			}
			if (!code) {
				S.zoomedFor = null;
				S.code.scrollPending = null;
			}
		} else {
			S.vpKey = null;
		}
		S.centerOn = null;
		const code = codeTarget();
		if (code && S.code.scrollPending !== code.path && !S.code.loading) {
			S.code.scrollPending = code.path;
			scrollCodeToEvidence(code);
		}
	}

	function updateCodePanel() {
		const n = codeTarget();
		const box = document.getElementById('as-lines');
		if (!n || !box) {
			return;
		}
		box.innerHTML = codeLinesHtml(n);
		if (S.code.scrollPending !== n.path) {
			S.code.scrollPending = n.path;
			scrollCodeToEvidence(n);
		}
	}

	// ------------------------------------------------------------------ viewport (pan and zoom)

	function canvasEl() {
		return document.getElementById('as-canvas');
	}

	function applyVp() {
		const v = S.vp[S.vpKey];
		const g = document.querySelector('#as-canvas svg.as-svg > g.vp');
		if (g && v) {
			g.setAttribute('transform', `translate(${r1(v.x)},${r1(v.y)}) scale(${v.k.toFixed(4)})`);
		}
		const pct = document.getElementById('as-zoom-pct');
		if (pct && v) {
			pct.textContent = `${Math.round(v.k * 100)}%`;
		}
	}

	function fit() {
		const c = canvasEl(), d = S.drawing;
		if (!c || !d) {
			return;
		}
		const W = c.clientWidth || canvasSize().w, H = c.clientHeight || canvasSize().h;
		const hasLegend = !!c.querySelector('.as-legend:not(.top)');
		const topLegend = !!c.querySelector('.as-legend.top');
		const reserveB = (hasLegend ? 34 : 0) + (d.reserveBottom ?? 0) + (S.progress?.status === 'scanning' && S.mode === 'map' ? 74 : 0);
		const reserveT = (topLegend ? 26 : 0) + (currentProposal() ? 60 : 0);
		const reserveR = d.reserveRight ?? 0;
		const aw = Math.max(80, W - 32 - reserveR), ah = Math.max(80, H - 24 - reserveB - reserveT);
		const k = clamp(Math.min(1, aw / d.w, ah / d.h), 0.12, 1);
		const x = 16 + Math.max(0, (aw - d.w * k) / 2);
		const y = 12 + reserveT + Math.max(0, (ah - d.h * k) / 2);
		S.vp[S.vpKey] = { k, x, y, auto: true, w: Math.ceil(d.w), h: Math.ceil(d.h) };
		applyVp();
		persist();
	}

	function zoomBy(f, cx, cy) {
		const v = S.vp[S.vpKey];
		const c = canvasEl();
		if (!v || !c) {
			return;
		}
		if (cx === undefined) {
			cx = c.clientWidth / 2;
			cy = c.clientHeight / 2;
		}
		const k2 = clamp(v.k * f, 0.12, 3);
		v.x = cx - (cx - v.x) * (k2 / v.k);
		v.y = cy - (cy - v.y) * (k2 / v.k);
		v.k = k2;
		v.auto = false;
		applyVp();
		persist();
	}

	/** Brings a node to the middle of the canvas at a readable zoom (never zooming out). */
	function zoomToNode(id, k) {
		const v = S.vp[S.vpKey];
		const c = canvasEl();
		const r = sceneCache.scene?.rects.get(id);
		if (!v || !c || !r) {
			return;
		}
		v.k = Math.max(v.k, k);
		v.x = c.clientWidth / 2 - (r.x + r.w / 2) * v.k;
		v.y = c.clientHeight / 2 - (r.y + r.h / 2) * v.k;
		v.auto = false;
		applyVp();
	}

	function centerOn(id) {
		const v = S.vp[S.vpKey];
		const c = canvasEl();
		const el = c?.querySelector(`[data-id="${CSS.escape(id)}"]`);
		if (!v || !c || !el || typeof el.getBBox !== 'function') {
			return;
		}
		let b;
		try {
			b = el.getBBox();
		} catch {
			return;
		}
		const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(el.getAttribute('transform') ?? '');
		const bx = b.x + (m ? +m[1] : 0), by = b.y + (m ? +m[2] : 0);
		const sx = v.x + bx * v.k, sy = v.y + by * v.k, sw = b.width * v.k, sh = b.height * v.k;
		const W = c.clientWidth, H = c.clientHeight;
		// Only move when most of the element is out of sight, and never for elements as big as the view.
		const visW = Math.max(0, Math.min(sx + sw, W) - Math.max(sx, 0)), visH = Math.max(0, Math.min(sy + sh, H - 40) - Math.max(sy, 0));
		if (sw > W * 0.6 || sh > H * 0.6 || (visW * visH) / Math.max(1, sw * sh) >= 0.6) {
			return;
		}
		v.x = W / 2 - (bx + b.width / 2) * v.k;
		v.y = H / 2 - (by + b.height / 2) * v.k;
		v.auto = false;
		applyVp();
	}

	// ------------------------------------------------------------------ actions

	function ask(text, send) {
		host.postMessage({ type: 'ask', text, send: !!send });
	}

	function openEditor(path, line) {
		if (path) {
			host.postMessage({ type: 'openFile', path, ...(line ? { line } : {}) });
		}
	}

	function clearTransient() {
		S.highlight.clear();
		S.note = null;
		S.selEdge = null;
	}

	function setMode(mode) {
		if (!MODES[mode] || !S.model) {
			return;
		}
		S.menu = null;
		if (mode === S.mode) {
			render();
			return;
		}
		if (S.mode === 'present') {
			host.postMessage({ type: 'focus', on: false });
		}
		stopPlay();
		if (mode === 'present') {
			S.prevMode = S.mode;
			if (!currentPath()) {
				return;
			}
			host.postMessage({ type: 'focus', on: true });
		}
		S.mode = mode;
		S.selEdge = null;
		S.matrixCell = null;
		if (mode === 'columns') {
			S.cols = null;
		}
		if (mode === 'layers') {
			S.layers = {};
		}
		render();
		persist();
	}

	function select(id, opts = {}) {
		const n = node(id) ?? currentProposal()?.nodes.find(p => p.id === id);
		if (!n) {
			return;
		}
		S.sel = id;
		S.centerOn = id;
		clearTransient();
		if (opts.insp !== false) {
			S.insp = true;
		}
		if (S.mode === 'layers') {
			if (node(id)?.level === 'system' && hasKids(node(id))) {
				S.layers = { sys: id };
			} else if (node(id)?.level === 'service') {
				S.layers = { sys: node(id).parent, svc: id };
			}
		}
		render();
		persist();
	}

	function enter(id) {
		const n = node(id);
		if (!n) {
			return;
		}
		if (!hasKids(n)) {
			if (n.level === 'file' && n.path) {
				focusNode(id);
			}
			return;
		}
		S.scope = validScope(id);
		S.sel = null;
		S.open.delete(id);
		clearTransient();
		S.cols = null;
		S.layers = {};
		S.matrixCell = null;
		if (!['map', 'circles', 'blocks', 'matrix'].includes(S.mode)) {
			if (S.mode === 'present') {
				host.postMessage({ type: 'focus', on: false });
			}
			S.mode = 'map';
		}
		render();
		persist();
	}

	function goUp() {
		const sc = node(S.scope);
		if (!sc) {
			return false;
		}
		S.sel = sc.id;
		S.scope = sc.parent ? validScope(sc.parent) : null;
		clearTransient();
		render();
		persist();
		return true;
	}

	function focusNode(id) {
		const n = node(id);
		if (!n) {
			return;
		}
		clearTransient();
		if (S.mode === 'columns') {
			const ch = S.idx.chain(id).reverse();
			S.cols = { sys: ch[0] ?? null, svc: ch[1] ?? null, file: ch[2] ?? null };
			S.sel = id;
		} else if (S.mode === 'layers') {
			S.sel = id;
			S.layers = {};
		} else {
			if (!['map', 'circles', 'blocks', 'matrix'].includes(S.mode)) {
				if (S.mode === 'present') {
					host.postMessage({ type: 'focus', on: false });
				}
				S.mode = 'map';
			}
			let visible = false;
			if (S.mode === 'map') {
				const scene = mapScene(S.scope, { proposal: currentProposal(), ghosts: scanGhosts() });
				visible = scene.rects.has(id);
			}
			if (!visible) {
				S.scope = n.level === 'file' ? validScope(n.parent) : n.parent ? validScope(n.parent) : null;
			}
			S.sel = id;
			S.centerOn = id;
		}
		S.insp = true;
		render();
		persist();
	}

	function toggleOpen(id, on) {
		const n = node(id);
		if (!n || !hasKids(n)) {
			return;
		}
		if (on) {
			S.open.add(id);
		} else {
			S.open.delete(id);
			for (const c of kidsOf(id)) {
				S.open.delete(c.id);
			}
		}
		if (S.vpKey) {
			delete S.vp[S.vpKey];
		}
		render();
		persist();
	}

	let playTimer = 0;
	function stopPlay() {
		S.playing = false;
		clearInterval(playTimer);
		playTimer = 0;
	}

	function stepBy(delta) {
		const p = currentPath();
		if (!p) {
			return;
		}
		S.step = clamp((S.step | 0) + delta, 0, p.steps.length - 1);
		render();
		persist();
	}

	function togglePlay() {
		const p = currentPath();
		if (!p) {
			return;
		}
		if (S.playing) {
			stopPlay();
			renderBar();
			return;
		}
		if (S.step >= p.steps.length - 1) {
			S.step = 0;
		}
		S.playing = true;
		playTimer = setInterval(() => {
			const cp = currentPath();
			if (!cp || S.mode !== 'path' || S.step >= cp.steps.length - 1) {
				stopPlay();
				renderBar();
				return;
			}
			S.step++;
			render();
		}, 1700);
		render();
	}

	function setSearch(q) {
		S.search.q = q;
		const nq = norm(q.trim());
		S.search.hits = nq && S.idx ? [...S.idx.byId.values()].filter(n => norm(n.name).includes(nq)).sort((a, b) => ((LEVEL_RANK[a.level] ?? -1) - (LEVEL_RANK[b.level] ?? -1)) || byName(a, b)).slice(0, 500) : [];
		S.search.i = -1;
		renderBody();
		const cnt = document.getElementById('as-search-count');
		if (cnt) {
			cnt.textContent = nq ? (S.search.hits.length ? `0 de ${num(S.search.hits.length)}` : 'nada') : '';
		}
	}

	function searchStep(delta) {
		const hits = S.search.hits;
		if (!hits.length) {
			return;
		}
		S.search.i = (S.search.i + delta + hits.length) % hits.length;
		focusNode(hits[S.search.i].id);
		const input = document.getElementById('as-search-input');
		if (input) {
			input.focus({ preventScroll: true });
			input.setSelectionRange(input.value.length, input.value.length);
		}
	}

	function openMenu(kind, anchor) {
		if (S.menu?.kind === kind) {
			S.menu = null;
		} else {
			const r = anchor.getBoundingClientRect();
			S.menu = { kind, x: kind === 'export' ? r.right - 250 : r.left, y: r.bottom + 4 };
		}
		renderMenu();
		document.querySelector('#as-menu-box .as-mi:not(:disabled)')?.focus({ preventScroll: true });
	}

	function closeMenu() {
		if (S.menu) {
			S.menu = null;
			renderMenu();
			return true;
		}
		return false;
	}

	function levelClick(level) {
		const ctx = levelContext();
		clearTransient();
		S.cols = null;
		S.layers = {};
		if (level === 0) {
			S.scope = null;
		} else {
			const sel = node(S.sel);
			let sys = ctx.sys ?? (sel ? node(S.idx.topOf(sel.id)) : null);
			if (!sys || !hasKids(sys)) {
				sys = S.idx.systems.filter(hasKids).sort((a, b) => (b.files ?? 0) - (a.files ?? 0))[0];
			}
			if (!sys) {
				return;
			}
			if (level === 1) {
				S.scope = sys.id;
			} else {
				let svc = ctx.svc ?? (sel && sel.level === 'service' && sel.parent === sys.id ? sel : sel && sel.level === 'file' ? node(sel.parent) : null);
				if (!svc || !hasKids(svc)) {
					svc = kidsOf(sys.id).filter(hasKids).sort((a, b) => (b.files ?? 0) - (a.files ?? 0))[0];
				}
				S.scope = svc ? svc.id : sys.id;
			}
		}
		if (S.mode === 'columns' || S.mode === 'layers') {
			S.sel = S.scope;
		}
		render();
		persist();
	}

	// ------------------------------------------------------------------ export

	function cssColor(v) {
		const m = /^color\(srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)(?:\s*\/\s*([\d.e-]+))?\)$/.exec(v);
		if (!m) {
			return v;
		}
		const c = x => Math.round(clamp(parseFloat(x), 0, 1) * 255);
		const a = m[4] !== undefined ? parseFloat(m[4]) : 1;
		return a >= 1 ? `rgb(${c(m[1])}, ${c(m[2])}, ${c(m[3])})` : `rgba(${c(m[1])}, ${c(m[2])}, ${c(m[3])}, ${a})`;
	}

	function exportSvg() {
		const svg = document.querySelector('#as-canvas svg.as-svg');
		const d = S.drawing;
		if (!svg || !d) {
			return;
		}
		const clone = svg.cloneNode(true);
		const props = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'opacity', 'font-size', 'font-weight', 'font-family', 'letter-spacing', 'paint-order', 'display'];
		const src = [svg, ...svg.querySelectorAll('*')], dst = [clone, ...clone.querySelectorAll('*')];
		const drop = [];
		for (let i = 0; i < src.length; i++) {
			if (src[i].matches?.('.nd-open, .bx-close, .ed-hit, title')) {
				drop.push(dst[i]);
			}
		}
		for (let i = 0; i < src.length; i++) {
			const el = src[i], out = dst[i];
			const cs = getComputedStyle(el);
			const tag = el.tagName.toLowerCase();
			const shape = /^(path|rect|circle|ellipse|polygon|polyline|line|text)$/.test(tag);
			for (const p of props) {
				if (!shape && !(p === 'opacity' || p === 'display') && tag !== 'g' && tag !== 'svg') {
					continue;
				}
				if ((p.startsWith('font') || p === 'letter-spacing' || p === 'paint-order') && tag !== 'text') {
					continue;
				}
				const v = cs.getPropertyValue(p);
				if (!v || (p === 'opacity' && v === '1') || (p === 'display' && v !== 'none') || (p === 'stroke-dasharray' && v === 'none') || (p === 'letter-spacing' && v === 'normal') || (p === 'paint-order' && v === 'normal')) {
					continue;
				}
				out.setAttribute(p, cssColor(v));
			}
			for (const a of [...out.attributes]) {
				if (a.name === 'class' || a.name === 'style' || a.name === 'tabindex' || a.name === 'role' || a.name.startsWith('data-') || a.name.startsWith('aria-')) {
					out.removeAttribute(a.name);
				}
			}
		}
		for (const el of drop) {
			el.remove();
		}
		const pad = 24;
		const W = Math.ceil(d.w + pad * 2), H = Math.ceil(d.h + pad * 2);
		clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
		clone.setAttribute('width', W);
		clone.setAttribute('height', H);
		clone.setAttribute('viewBox', `0 0 ${W} ${H}`);
		clone.setAttribute('font-family', getComputedStyle(svg).fontFamily);
		const vp = clone.querySelector('g');
		const g = [...clone.children].find(x => x.tagName.toLowerCase() === 'g') ?? vp;
		g?.setAttribute('transform', `translate(${pad},${pad})`);
		const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
		bg.setAttribute('width', W);
		bg.setAttribute('height', H);
		bg.setAttribute('fill', cssColor(getComputedStyle(canvasEl()).backgroundColor));
		clone.insertBefore(bg, clone.firstChild);
		const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone);
		const base = String(S.model?.source || S.model?.name || 'arquitetura').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'arquitetura';
		host.postMessage({ type: 'save', name: `${base}-${MODES[S.mode].label.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')}.svg`, content: xml, mime: 'image/svg+xml' });
	}

	function exportJson() {
		const text = S.raw['model.json'];
		if (!text) {
			return;
		}
		const base = String(S.model?.source || S.model?.name || 'arquitetura').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'arquitetura';
		host.postMessage({ type: 'save', name: `${base}-modelo.json`, content: text, mime: 'application/json' });
	}

	// ------------------------------------------------------------------ events

	let suppressClick = false;
	let lastClick = { key: null, t: 0 };

	/** The first click re-renders, so the browser never sees a double click: detect it here. */
	function isSecondClick(key) {
		const now = performance.now();
		const second = lastClick.key === key && now - lastClick.t < 450;
		lastClick = second ? { key: null, t: 0 } : { key, t: now };
		return second;
	}

	function activate(id) {
		const n = node(id);
		if (!n) {
			return;
		}
		if (hasKids(n)) {
			if (S.mode === 'columns' || S.mode === 'layers') {
				S.mode = 'map';
			}
			enter(id);
		} else if (n.level === 'file' && n.path) {
			openEditor(n.path, firstEvidenceLine(n.path));
		}
	}

	function onClick(ev) {
		if (suppressClick) {
			suppressClick = false;
			return;
		}
		const t = ev.target;
		const actEl = t.closest?.('[data-act]');
		if (S.menu && !t.closest?.('#as-menu-box') && !(actEl && actEl.dataset.act === 'menu')) {
			closeMenu();
			if (!actEl) {
				return;
			}
		}
		if (actEl && !actEl.disabled) {
			if (actEl.dataset.act === 'col' && isSecondClick(`col:${actEl.getAttribute('data-id')}`)) {
				activate(actEl.getAttribute('data-id'));
				return;
			}
			act(actEl, ev);
			return;
		}
		const unitEl = t.closest?.('[data-unit]');
		if (unitEl && t.closest('#as-canvas')) {
			const id = unitEl.getAttribute('data-unit');
			S.selUnit = S.selUnit === id ? null : id;
			clearTransient();
			render();
			return;
		}
		const edgeEl = t.closest?.('[data-edge]');
		if (edgeEl && S.mode === 'map') {
			S.selEdge = edgeEl.getAttribute('data-edge');
			render();
			return;
		}
		const idEl = t.closest?.('[data-id]');
		if (idEl && t.closest('#as-canvas')) {
			const id = idEl.getAttribute('data-id');
			if (isSecondClick(`node:${id}`)) {
				activate(id);
				return;
			}
			select(id);
			return;
		}
		if (t.closest?.('#as-canvas') && !t.closest('.as-card') && !t.closest('.as-caption')) {
			if (S.sel || S.selEdge || S.highlight.size || S.matrixCell || S.selUnit) {
				S.sel = null;
				S.selUnit = null;
				S.matrixCell = null;
				clearTransient();
				render();
				persist();
			}
		}
	}

	function act(el, ev) {
		const a = el.dataset.act;
		const id = el.getAttribute('data-id');
		switch (a) {
			case 'level': levelClick(Number(el.dataset.level)); break;
			case 'crumb':
				if (!id) {
					S.scope = null;
					S.sel = null;
					clearTransient();
					if (S.mode === 'columns' || S.mode === 'layers') {
						S.cols = null;
						S.layers = {};
					}
					render();
					persist();
				} else if (S.mode === 'columns' || S.mode === 'layers') {
					focusNode(id);
				} else if (hasKids(node(id))) {
					enter(id);
				} else {
					focusNode(id);
				}
				break;
			case 'menu': openMenu(el.dataset.menu, el); break;
			case 'mode': setMode(el.dataset.mode); break;
			case 'zoom-in': zoomBy(1.2); break;
			case 'zoom-out': zoomBy(1 / 1.2); break;
			case 'fit': fit(); break;
			case 'search-open':
				S.search.open = true;
				renderBar();
				document.getElementById('as-search-input')?.focus();
				break;
			case 'search-close':
				S.search = { open: false, q: '', hits: [], i: -1 };
				render();
				break;
			case 'export-svg': closeMenu(); exportSvg(); break;
			case 'export-json': closeMenu(); exportJson(); break;
			case 'proposal':
				S.proposalOn = el.dataset.on === '1';
				if (S.proposalOn) {
					const sc = proposalScope(S.proposal);
					if (sc !== undefined) {
						S.scope = sc;
					}
					S.sel = null;
				}
				clearTransient();
				render();
				persist();
				break;
			case 'discard': ask('Descarte a proposta.', true); break;
			case 'tasks': ask(`Crie as tarefas para implementar a proposta "${S.proposal?.title ?? ''}".`, false); break;
			case 'step-prev': stopPlay(); stepBy(-1); break;
			case 'step-next': stopPlay(); stepBy(1); break;
			case 'step': stopPlay(); S.step = Number(el.dataset.step) | 0; render(); persist(); break;
			case 'play': togglePlay(); break;
			case 'exit-present': setMode(S.prevMode && S.prevMode !== 'present' ? S.prevMode : 'map'); break;
			case 'path-pick': S.pathId = id; S.step = 0; S.menu = null; stopPlay(); render(); persist(); break;
			case 'ask': ask(el.dataset.text ?? '', el.dataset.send === '1'); break;
			case 'pick': host.postMessage({ type: 'pickSource' }); break;
			case 'open': toggleOpen(id, true); break;
			case 'close-box': toggleOpen(id, false); break;
			case 'enter': enter(id); break;
			case 'focus': focusNode(id); break;
			case 'focus-map':
				S.selUnit = null;
				S.mode = 'map';
				focusNode(id);
				break;
			case 'open-editor': openEditor(el.dataset.path, Number(el.dataset.line) || 0); break;
			case 'close-insp': S.insp = false; render(); persist(); break;
			case 'close-code': S.sel = null; render(); persist(); break;
			case 'close-edge': S.selEdge = null; render(); break;
			case 'up': goUp(); break;
			case 'col': {
				const col = Number(el.dataset.col);
				const c = colsState();
				if (col === 0) {
					S.cols = { sys: id, svc: null, file: null };
				} else if (col === 1) {
					S.cols = { sys: c.sys, svc: id, file: null };
				} else {
					S.cols = { sys: c.sys, svc: c.svc, file: id };
				}
				S.sel = id;
				clearTransient();
				render();
				persist();
				document.querySelector(`.as-it[data-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
				break;
			}
			case 'cell': {
				const i = Number(el.dataset.i), j = Number(el.dataset.j);
				S.matrixCell = S.matrixCell && S.matrixCell[0] === i && S.matrixCell[1] === j ? null : [i, j];
				render();
				break;
			}
			case 'matrix-map': {
				const ida = el.dataset.a, idb = el.dataset.b;
				S.mode = 'map';
				S.sel = null;
				S.highlight = new Set([ida, idb]);
				const ea = (S.idx.out.get(ida) ?? []).filter(l => l.to === idb || S.idx.chain(l.to).includes(idb));
				for (const l of ea) {
					S.highlight.add(l.id);
				}
				S.note = null;
				render();
				persist();
				break;
			}
			case 'cycle-map': {
				const ids = (el.dataset.ids ?? '').split('|').filter(Boolean);
				S.mode = 'map';
				S.sel = null;
				S.highlight = new Set(ids);
				for (const a of ids) {
					for (const l of S.idx.out.get(a) ?? []) {
						if (ids.includes(l.to)) {
							S.highlight.add(l.id);
						}
					}
				}
				S.note = 'Dependência circular';
				render();
				persist();
				break;
			}
		}
	}

	function onDblClick(ev) {
		// Nodes and list items handle their own double clicks (see isSecondClick); the empty canvas goes up.
		const t = ev.target;
		if (!t.closest?.('[data-act], [data-id], .as-card, .as-caption') && t.closest?.('#as-canvas') && S.mode === 'map') {
			goUp();
		}
	}

	let drag = null;
	function onPointerDown(ev) {
		const c = canvasEl();
		if (ev.button !== 0 || !c || !c.contains(ev.target) || !S.vpKey) {
			return;
		}
		if (ev.target.closest('.as-card, .as-caption, .as-legend, button, input, .as-lines')) {
			return;
		}
		const v = S.vp[S.vpKey];
		if (!v) {
			return;
		}
		drag = { x: ev.clientX, y: ev.clientY, vx: v.x, vy: v.y, moved: false, id: ev.pointerId };
	}
	function onPointerMove(ev) {
		if (!drag || ev.pointerId !== drag.id) {
			return;
		}
		const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
		if (!drag.moved && Math.hypot(dx, dy) > 4) {
			drag.moved = true;
			canvasEl()?.classList.add('panning');
			try {
				canvasEl()?.setPointerCapture(ev.pointerId);
			} catch {
				// Capture is optional.
			}
		}
		if (drag.moved) {
			const v = S.vp[S.vpKey];
			if (v) {
				v.x = drag.vx + dx;
				v.y = drag.vy + dy;
				v.auto = false;
				applyVp();
			}
		}
	}
	function onPointerUp(ev) {
		if (!drag || ev.pointerId !== drag.id) {
			return;
		}
		if (drag.moved) {
			suppressClick = true;
			setTimeout(() => {
				suppressClick = false;
			}, 0);
			persist();
		}
		canvasEl()?.classList.remove('panning');
		drag = null;
	}
	function onWheel(ev) {
		const c = canvasEl();
		if (!c || !c.contains(ev.target) || !S.vpKey || ev.target.closest('.as-card, .as-lines')) {
			return;
		}
		ev.preventDefault();
		const r = c.getBoundingClientRect();
		const dy = ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaY;
		zoomBy(Math.exp(-dy * 0.0015), ev.clientX - r.left, ev.clientY - r.top);
	}

	function onKey(ev) {
		const t = ev.target;
		const inInput = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
		if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'f' && S.model) {
			ev.preventDefault();
			S.search.open = true;
			renderBar();
			document.getElementById('as-search-input')?.focus();
			return;
		}
		if (S.menu) {
			if (ev.key === 'Escape') {
				ev.preventDefault();
				closeMenu();
				return;
			}
			if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
				ev.preventDefault();
				const items = [...document.querySelectorAll('#as-menu-box .as-mi:not(:disabled)')];
				const i = items.indexOf(document.activeElement);
				items[(i + (ev.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
				return;
			}
		}
		if (inInput) {
			if (t.id === 'as-search-input') {
				if (ev.key === 'Enter') {
					ev.preventDefault();
					searchStep(ev.shiftKey ? -1 : 1);
				} else if (ev.key === 'Escape') {
					ev.preventDefault();
					S.search = { open: false, q: '', hits: [], i: -1 };
					render();
				}
			}
			return;
		}
		if (ev.key === 'Escape') {
			ev.preventDefault();
			if (S.mode === 'present') {
				setMode(S.prevMode && S.prevMode !== 'present' ? S.prevMode : 'map');
			} else if (S.selEdge) {
				S.selEdge = null;
				render();
			} else if (S.matrixCell) {
				S.matrixCell = null;
				render();
			} else if (S.sel || S.selUnit || S.highlight.size || S.note) {
				S.sel = null;
				S.selUnit = null;
				clearTransient();
				render();
				persist();
			} else if (['map', 'circles', 'blocks', 'matrix'].includes(S.mode)) {
				goUp();
			}
			return;
		}
		if (S.mode === 'path' || S.mode === 'present') {
			if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown' || ev.key === 'PageDown') {
				ev.preventDefault();
				stopPlay();
				stepBy(1);
				return;
			}
			if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp' || ev.key === 'PageUp') {
				ev.preventDefault();
				stopPlay();
				stepBy(-1);
				return;
			}
			if (ev.key === ' ' && S.mode === 'path' && !(t && t.tagName === 'BUTTON')) {
				ev.preventDefault();
				togglePlay();
				return;
			}
		}
		if (t && t.classList?.contains('as-it') && (ev.key === 'ArrowDown' || ev.key === 'ArrowUp' || ev.key === 'ArrowRight' || ev.key === 'ArrowLeft')) {
			ev.preventDefault();
			const col = Number(t.dataset.col);
			if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
				const list = [...t.parentElement.querySelectorAll('.as-it')];
				const next = list[list.indexOf(t) + (ev.key === 'ArrowDown' ? 1 : -1)];
				if (next) {
					next.click();
				}
			} else if (ev.key === 'ArrowRight') {
				const next = document.querySelector(`.as-it[data-col="${col + 1}"]`);
				next?.click();
			} else {
				const c = colsState();
				const prevId = col === 2 ? c.svc : col === 1 ? c.sys : null;
				if (prevId) {
					document.querySelector(`.as-it[data-id="${CSS.escape(prevId)}"]`)?.focus();
				}
			}
			return;
		}
		if (t && t.hasAttribute?.('data-unit') && (ev.key === 'Enter' || ev.key === ' ')) {
			ev.preventDefault();
			const id = t.getAttribute('data-unit');
			S.selUnit = S.selUnit === id ? null : id;
			render();
			return;
		}
		const isNode = t && t.getAttribute && t.getAttribute('role') === 'button' && t.hasAttribute('data-id') && !t.closest('button');
		if (isNode && (ev.key === 'Enter' || ev.key === ' ')) {
			ev.preventDefault();
			const id = t.getAttribute('data-id');
			if (t.dataset.act) {
				act(t, ev);
			} else if (ev.key === ' ' && S.mode === 'map' && hasKids(node(id))) {
				toggleOpen(id, !S.open.has(id));
			} else if (S.sel === id && hasKids(node(id))) {
				enter(id);
			} else {
				select(id);
			}
			return;
		}
		if (S.vpKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
			if (ev.key === '+' || ev.key === '=') {
				zoomBy(1.2);
			} else if (ev.key === '-') {
				zoomBy(1 / 1.2);
			} else if (ev.key === '0') {
				fit();
			}
		}
	}

	function onInput(ev) {
		if (ev.target.id === 'as-search-input') {
			setSearch(ev.target.value);
		}
	}

	// ------------------------------------------------------------------ host messages

	function normalizeProposal(p) {
		if (!p || typeof p !== 'object') {
			return null;
		}
		const nodes = Array.isArray(p.nodes) ? p.nodes.filter(x => x && typeof x.id === 'string') : [];
		const links = Array.isArray(p.links) ? p.links.filter(x => x && typeof x.from === 'string' && typeof x.to === 'string') : [];
		if (!nodes.length && !links.length) {
			return null;
		}
		for (const x of nodes) {
			if (x.op === 'add') {
				x.name = x.name ?? x.id;
				x.level = x.level ?? 'service';
				x.kind = x.kind ?? 'backend';
			}
		}
		return { title: String(p.title ?? 'Proposta'), summary: typeof p.summary === 'string' ? p.summary : '', sourceId: p.sourceId, nodes, links };
	}

	function applyView(v) {
		S.lastViewRev = v.revision;
		if (typeof v.path === 'string' && pathList().some(p => p.id === v.path)) {
			// focus on a path: show it from the first step in path or present mode
			S.pathId = v.path;
			S.step = 0;
			stopPlay();
		}
		S.selUnit = null;
		if (v.mode && MODES[v.mode] && S.model && !(v.mode === 'present' && !currentPath())) {
			if (v.mode === 'present' && S.mode !== 'present') {
				S.prevMode = S.mode;
				host.postMessage({ type: 'focus', on: true });
			} else if (S.mode === 'present' && v.mode !== 'present') {
				host.postMessage({ type: 'focus', on: false });
			}
			S.mode = v.mode;
		}
		if ('scope' in v) {
			const sc = node(v.scope);
			S.scope = sc ? (validScope(sc.id) ?? validScope(scopeOf(sc.id))) : null;
		}
		S.sel = v.select && node(v.select) ? v.select : null;
		if (S.sel) {
			S.centerOn = S.sel;
		}
		const units = S.model?.deploy?.units ?? [];
		if (typeof v.select === 'string' && units.some(u => u.id === v.select)) {
			S.selUnit = v.select;
		}
		S.highlight = new Set(Array.isArray(v.highlight) ? v.highlight.filter(x => typeof x === 'string') : []);
		S.note = typeof v.note === 'string' && v.note.trim() ? v.note.trim() : null;
		S.selEdge = null;
		S.cols = null;
		S.layers = {};
		S.matrixCell = null;
	}

	function applyFiles(files) {
		S.files = files;
		let progress;
		try { progress = JSON.parse(files?.['progress.json'] ?? 'null'); } catch { /* Keep the last valid progress below. */ }
		// A busy conversation is not proof that this scan is running. Match the
		// host's active receipt, including after reopening the interface mid-scan.
		const live = S.running && typeof progress?.executionId === 'string' && S.executions.has(progress.executionId);
		const partialText = live && progress?.status === 'scanning' ? files?.['model-partial.json'] ?? null : null;
		if (partialText !== S.partialText) {
			S.partialText = partialText;
			S.partialModel = null;
			try { S.partialModel = JSON.parse(partialText ?? 'null'); } catch { /* Keep the committed map. */ }
		}
		const partial = S.partialModel;
		const showPartial = partial && partial.executionId === progress.executionId && partial.sourceId === progress.sourceId;
		const modelText = showPartial ? partialText : files?.['model.json'];
		files = { ...files, 'model.json': modelText };
		if (!live && progress?.status === 'scanning') {
			files['progress.json'] = JSON.stringify({ ...progress, status: 'failed', error: 'A análise foi interrompida. O mapa salvo foi preservado.' });
		}
		let changed = false;
		for (const name of ['model.json', 'progress.json', 'view.json', 'paths.json', 'proposal.json']) {
			const text = typeof files?.[name] === 'string' ? files[name] : null;
			if (text === (S.raw[name] ?? null)) {
				continue;
			}
			let val = null;
			if (text !== null) {
				try {
					val = name === 'model.json' && showPartial ? partial : JSON.parse(text);
				} catch {
					continue; // A half-written file: keep the previous one.
				}
			}
			S.raw[name] = text;
			changed = true;
			if (name === 'model.json') {
				const sourceChanged = S.model?.sourceId !== val?.sourceId;
				S.model = val && Array.isArray(val.nodes) ? val : null;
				S.idx = S.model ? buildIndex(S.model) : null;
				S.modelRev = (S.modelRev ?? 0) + 1;
				sceneCache.key = null;
				invalidateCode();
				if (sourceChanged) {
					S.lastViewRev = null;
					for (const document of ['view.json', 'paths.json', 'proposal.json']) { delete S.raw[document]; }
				}
			} else if (name === 'progress.json') {
				S.progress = val && typeof val === 'object' ? val : null;
			} else if (name === 'view.json') {
				S.view = val && typeof val === 'object' ? val : null;
			} else if (name === 'paths.json') {
				S.paths = val && typeof val === 'object' ? val : null;
			} else {
				S.proposal = normalizeProposal(val);
				S.proposalRev = (S.proposalRev ?? 0) + 1;
				sceneCache.key = null;
			}
		}
		if (!changed) {
			return;
		}
		// A view, flow or proposal belongs to the source that produced it, even if node ids overlap.
		for (const key of ['view', 'paths', 'proposal']) {
			if (S[key]?.sourceId !== S.model?.sourceId) { S[key] = null; }
		}
		if (S.idx) {
			S.scope = validScope(S.scope);
			if (S.sel && !node(S.sel) && !S.proposal?.nodes.some(p => p.id === S.sel)) {
				S.sel = null;
			}
			S.open = new Set([...S.open].filter(id => hasKids(node(id))));
		}
		if (!S.proposal) {
			S.proposalOn = false;
		}
		if (S.mode === 'present' && !currentPath()) {
			host.postMessage({ type: 'focus', on: false });
			S.mode = 'map';
		}
		if (S.view && S.view.revision !== undefined && S.view.revision !== S.lastViewRev && S.model) {
			applyView(S.view);
		}
		render();
		persist();
	}

	window.addEventListener('message', ev => {
		const m = ev.data;
		if (!m || typeof m !== 'object') {
			return;
		}
		switch (m.type) {
			case 'init':
			case 'context':
				if (S.ctx && (S.ctx.sourceRevision !== m.context?.sourceRevision || S.ctx.source !== m.context?.source || S.ctx.sourceKind !== m.context?.sourceKind)) {
					invalidateCode();
				}
				S.ctx = m.context && typeof m.context === 'object' ? m.context : null;
				render();
				break;
			case 'files':
				S.filesError = null;
				applyFiles(m.files ?? {});
				renderBar();
				break;
			case 'filesError':
				S.filesError = typeof m.message === 'string' ? m.message : 'Não foi possível atualizar o mapa.';
				renderBar();
				break;
			case 'running':
				S.running = !!m.running;
				S.executions = new Set(Array.isArray(m.executions) ? m.executions.filter(id => typeof id === 'string') : []);
				applyFiles(S.files);
				renderBar();
				break;
			case 'file':
				if (m.requestId && m.requestId === S.code.req) {
					S.code.loading = false;
					S.code.text = typeof m.text === 'string' ? m.text : null;
					S.code.error = typeof m.error === 'string' ? m.error : (typeof m.text === 'string' ? null : 'sem conteúdo');
					S.code.truncated = !!m.truncated;
					updateCodePanel();
				}
				break;
		}
	});

	// ------------------------------------------------------------------ boot

	function onResize() {
		const w = window.innerWidth;
		const changed = Math.abs((S.width ?? 0) - w) > 1;
		S.width = w;
		if (!root) {
			return;
		}
		if (changed) {
			render();
		} else {
			const v = S.vp[S.vpKey];
			if (v?.auto) {
				fit();
			}
		}
	}

	S.width = window.innerWidth;
	ensureRoot();
	document.addEventListener('click', onClick);
	document.addEventListener('dblclick', onDblClick);
	document.addEventListener('keydown', onKey);
	document.addEventListener('input', onInput);
	document.addEventListener('pointerdown', onPointerDown);
	document.addEventListener('pointermove', onPointerMove);
	document.addEventListener('pointerup', onPointerUp);
	document.addEventListener('pointercancel', onPointerUp);
	document.addEventListener('wheel', onWheel, { passive: false });
	let resizeTimer = 0;
	window.addEventListener('resize', () => {
		clearTimeout(resizeTimer);
		resizeTimer = setTimeout(onResize, 60);
	});
	setInterval(() => {
		if (S.model && S.mode === 'map' && !S.running && S.progress?.status !== 'scanning' && !S.search.open) {
			renderBar();
		}
	}, 60000);
	render();
	host.postMessage({ type: 'ready' });
	if (S.mode === 'present') {
		host.postMessage({ type: 'focus', on: true });
	}
})();
