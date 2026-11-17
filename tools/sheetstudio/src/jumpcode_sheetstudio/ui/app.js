/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// SheetStudio Studio interface: plain JavaScript, no libraries, no network. It reads the Studio files the tool
// writes (sheet, grid, charts, cleanup, history, settings, view) and shows the open spreadsheet like Excel does, the
// charts the agent made with what was calculated, the panel, the data problems with their fixes, the questions asked
// and the column profile. Charts are inline SVG built here. It never writes files and never calls the tool: every
// action becomes a chat message (`ask`) the agent carries out. All visible text is in Brazilian Portuguese.
(function () {
	'use strict';

	/** @type {{ postMessage(m: object): void, getState(): any, setState(s: any): void }} */
	const host = typeof acquireVsCodeApi === 'function'
		? acquireVsCodeApi()
		: { postMessage() { }, getState() { return undefined; }, setState() { } };

	// ------------------------------------------------------------------ constants

	const VIEWS = {
		sheet: { label: 'Planilha', icon: 'table' },
		charts: { label: 'Gráficos', icon: 'graph' },
		panel: { label: 'Painel', icon: 'dashboard' },
		cleanup: { label: 'Limpeza', icon: 'checklist' },
		history: { label: 'Perguntas', icon: 'history', offline: true },
		profile: { label: 'Perfil das colunas', short: 'Perfil', icon: 'list', more: true },
		files: { label: 'Arquivos do projeto', short: 'Arquivos', icon: 'folder', more: true, offline: true },
		settings: { label: 'Configurações', icon: 'gear', more: true, offline: true },
	};

	const TYPES = {
		text: { label: 'texto', ty: 'abc' }, category: { label: 'categoria', icon: 'tag' }, integer: { label: 'número inteiro', ty: '123' },
		number: { label: 'número', ty: '1,5' }, currency: { label: 'moeda', ty: 'R$' }, percent: { label: 'percentual', ty: '%' },
		date: { label: 'data', icon: 'calendar' }, datetime: { label: 'data e hora', icon: 'calendar' }, time: { label: 'hora', icon: 'clock' },
		bool: { label: 'sim/não', icon: 'checkbox' },
	};
	const NUMERIC = ['integer', 'number', 'currency', 'percent'];
	const RIGHT = ['integer', 'number', 'currency', 'percent', 'time'];

	const KINDS = {
		bar: { label: 'Barras', icon: 'graph', phrase: 'barras' },
		hbar: { label: 'Barras deitadas', icon: 'hbar', phrase: 'barras deitadas' },
		line: { label: 'Linhas', icon: 'graphLine', phrase: 'linhas' },
		stacked: { label: 'Colunas empilhadas', icon: 'stacked', phrase: 'colunas empilhadas' },
		stacked100: { label: 'Colunas 100%', icon: 'stacked', phrase: 'colunas 100%' },
		grouped: { label: 'Colunas lado a lado', icon: 'graph', phrase: 'colunas lado a lado' },
		heatmap: { label: 'Mapa de calor', icon: 'heat', phrase: 'mapa de calor' },
		table: { label: 'Tabela', icon: 'table', phrase: 'tabela' },
		pivot: { label: 'Tabela dinâmica', icon: 'pivot', phrase: 'tabela dinâmica' },
		query: { label: 'Consulta SQL', icon: 'database', phrase: 'consulta' },
	};
	const SINGLE_KINDS = ['bar', 'hbar', 'line', 'table'];
	const MULTI_KINDS = ['line', 'stacked', 'stacked100', 'grouped', 'heatmap', 'table'];

	const AGG = { sum: 'soma', count: 'contagem', avg: 'média', min: 'mínimo', max: 'máximo', unique: 'valores distintos', median: 'mediana' };
	const AGG_VERB = { sum: 'some', count: 'conte', avg: 'tire a média de', min: 'pegue o menor', max: 'pegue o maior', unique: 'conte os distintos de', median: 'tire a mediana de' };
	const BY = { month: 'mês', year: 'ano', quarter: 'trimestre', week: 'semana', day: 'dia', weekday: 'dia da semana', hour: 'hora' };
	const BY_EACH = { month: 'mês', year: 'ano', quarter: 'trimestre', week: 'semana', day: 'dia', weekday: 'dia da semana', hour: 'hora' };
	const WEEKDAY_FULL = { dom: 'domingo', seg: 'segunda', ter: 'terça', qua: 'quarta', qui: 'quinta', sex: 'sexta', 'sáb': 'sábado' };
	const MONTH_FULL = { jan: 'janeiro', fev: 'fevereiro', mar: 'março', abr: 'abril', mai: 'maio', jun: 'junho', jul: 'julho', ago: 'agosto', set: 'setembro', out: 'outubro', nov: 'novembro', dez: 'dezembro' };
	const FORMATS = {
		csv: ['CSV', 'texto separado'], tsv: ['TSV', 'texto com tab'], txt: ['TXT', 'texto separado'],
		xlsx: ['XLSX', 'Excel'], xlsm: ['XLSM', 'Excel com macros'], xls: ['XLS', 'Excel antigo'], ods: ['ODS', 'LibreOffice Calc'],
	};
	const SEPARATORS = { ';': '; ponto e vírgula', ',': ', vírgula', '\t': 'tab', '|': '| barra' };
	const SETTINGS = { decimal: 'auto', dateOrder: 'auto', csvStyle: 'br', exportFolder: '', gridRows: 500, palette: 'padrão' };
	const SET_OPTIONS = {
		decimal: [['auto', 'automático'], ['comma', ', vírgula'], ['dot', '. ponto']],
		dateOrder: [['auto', 'automática'], ['dmy', 'dia/mês/ano'], ['mdy', 'mês/dia/ano']],
		csvStyle: [['br', '; e vírgula decimal'], ['plain', ', e ponto decimal']],
		gridRows: [[100, '100 linhas'], [200, '200 linhas'], [500, '500 linhas'], [1000, '1.000 linhas'], [2000, '2.000 linhas']],
	};

	// Chart colours: the validated categorical palette on the dark surface, and one blue ramp for heat maps.
	const PAL = ['#4E86C8', '#CF7356', '#2F9F86', '#9282D9', '#6E9E4F', '#D17FA6', '#7C8DA6', '#5AAFC4'];
	const SEQ = ['#283747', '#2F4762', '#35577E', '#3B699B', '#467AB3', '#588DC7', '#75A2D5', '#97BBE4', '#BAD4F2'];
	const GRID = '#3A3A3E', AXIS = '#6A6A6E', MUTED = '#55555A';

	const ICONS = {
		table: '<rect x="1.8" y="2.4" width="12.4" height="11.2"/><path d="M1.8 6h12.4M1.8 9.8h12.4M6 6v7.6M10.2 6v7.6"/>',
		graph: '<path d="M2 14h12"/><rect x="3" y="8" width="2.4" height="6"/><rect x="6.8" y="4" width="2.4" height="10"/><rect x="10.6" y="6.4" width="2.4" height="7.6"/>',
		hbar: '<path d="M2.4 2v12"/><rect x="2.4" y="3" width="8.6" height="2.4"/><rect x="2.4" y="6.8" width="11.4" height="2.4"/><rect x="2.4" y="10.6" width="5.6" height="2.4"/>',
		graphLine: '<path d="M2 14h12M2 2v12"/><path d="m3.6 10.6 3-3.4 2.6 2 4.2-5"/>',
		stacked: '<path d="M2 14h12"/><rect x="3" y="4" width="3.6" height="10"/><rect x="9.4" y="2.4" width="3.6" height="11.6"/><path d="M3 8.6h3.6M9.4 7.4h3.6"/>',
		heat: '<path d="M5.8 2.2 4.6 13.8M11.4 2.2l-1.2 11.6M2.4 5.8h11.4M2 10.2h11.4"/>',
		pivot: '<rect x="1.8" y="2.4" width="12.4" height="11.2"/><path d="M1.8 6h12.4M5.6 2.4v11.2"/><path d="M8 8.6h4M8 11h4"/>',
		database: '<ellipse cx="8" cy="3.8" rx="5.4" ry="1.8"/><path d="M2.6 3.8v8.4c0 1 2.4 1.8 5.4 1.8s5.4-.8 5.4-1.8V3.8M2.6 8c0 1 2.4 1.8 5.4 1.8s5.4-.8 5.4-1.8"/>',
		dashboard: '<path d="M2.2 12a5.8 5.8 0 1 1 11.6 0"/><path d="M8 11.6 10.8 6.8"/><path d="M4 12h1.2M10.8 12H12M8 4.4v1.2"/>',
		checklist: '<path d="m1.8 4 1.4 1.4L5.6 3M1.8 10l1.4 1.4L5.6 9M7.6 4.4h6.6M7.6 10.4h6.6"/>',
		history: '<path d="M3 4.6A5.8 5.8 0 1 1 2.2 8"/><path d="M2.6 1.9v2.9h2.9M8 4.8V8l2.2 1.5"/>',
		list: '<path d="M5.4 4h8.6M5.4 8h8.6M5.4 12h8.6M2.2 4h.01M2.2 8h.01M2.2 12h.01"/>',
		listOrdered: '<path d="M6.4 4h7.6M6.4 8h7.6M6.4 12h7.6"/><path d="M2.2 3.2 3 2.6v3M2.2 10.2c.3-.6 1.6-.6 1.6.2 0 .6-1.6 1.4-1.6 2h1.6"/>',
		folder: '<path d="M1.8 3.6h4.1l1.5 1.6h6.8v7.5H1.8z"/>',
		folderOpen: '<path d="M1.8 12.8V3.6h4.1l1.5 1.6h5.4v1.8"/><path d="M1.8 12.8 4 7h10.2L12 12.8z"/>',
		file: '<path d="M3.2 1.8h6l3.6 3.6v8.8H3.2z"/><path d="M9.2 1.8v3.6h3.6"/>',
		fileAdd: '<path d="M3.2 1.8h6l3.6 3.6v8.8H3.2z"/><path d="M9.2 1.8v3.6h3.6M8 7.6v4.4M5.8 9.8h4.4"/>',
		gear: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.6v2M8 12.4v2M1.6 8h2M12.4 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M3.5 12.5l1.4-1.4M11.1 4.9l1.4-1.4"/>',
		filter: '<path d="M2 2.6h12L9.4 8.4v4.8l-2.8 1.2V8.4z"/>',
		filterOn: '<path d="M2 2.6h12L9.4 8.4v4.8l-2.8 1.2V8.4z" fill="currentColor"/>',
		close: '<path d="m4 4 8 8M12 4l-8 8"/>',
		chevD: '<path d="M3.5 6 8 10.5 12.5 6"/>',
		check: '<path d="m3 8.4 3.1 3.1L13 4.6"/>',
		passed: '<circle cx="8" cy="8" r="6.4" fill="currentColor" stroke="none"/><path d="m5.1 8.2 2 2 3.9-4.1" stroke="#FFFFFF" stroke-width="1.6"/>',
		error: '<circle cx="8" cy="8" r="6"/><path d="m5.7 5.7 4.6 4.6M10.3 5.7l-4.6 4.6"/>',
		warning: '<path d="M8 2 14.4 13.6H1.6z"/><path d="M8 6.4v3.4M8 11.8h.01"/>',
		info: '<circle cx="8" cy="8" r="6"/><path d="M8 7.2v4M8 4.8h.01"/>',
		dot: '<circle cx="8" cy="8" r="3.4" fill="currentColor" stroke="none"/>',
		ring: '<circle cx="8" cy="8" r="5.6"/>',
		spinner: '<path d="M13.6 8A5.6 5.6 0 0 1 2.4 8"/>',
		comment: '<path d="M2.2 2.8h11.6v8H7.2l-3 2.6v-2.6h-2z"/>',
		comments: '<path d="M1.8 2.4h9v6.2H5.6L3.2 10.6V8.6H1.8z"/><path d="M12.6 5.6h1.6v6h-1.4v2l-2.4-2H6.8"/>',
		lock: '<rect x="3.2" y="7" width="9.6" height="7"/><path d="M5.4 7V5.2a2.6 2.6 0 0 1 5.2 0V7"/>',
		export: '<path d="M9.6 3.6 13.2 7.2 9.6 10.8M13.2 7.2H5"/><path d="M2.4 2.4v9.6"/>',
		eye: '<path d="M1.6 8s2.4-4.4 6.4-4.4S14.4 8 14.4 8 12 12.4 8 12.4 1.6 8 1.6 8z"/><circle cx="8" cy="8" r="2"/>',
		search: '<circle cx="7" cy="7" r="4.4"/><path d="m10.2 10.2 3.8 3.8"/>',
		tag: '<path d="M8.4 2H14v5.6l-6.4 6.4L2 8.4z"/><circle cx="11" cy="5" r=".9"/>',
		calendar: '<rect x="2" y="3" width="12" height="11"/><path d="M2 6.4h12M5 1.6v2.8M11 1.6v2.8"/>',
		clock: '<circle cx="8" cy="8" r="6"/><path d="M8 4.4V8l2.4 1.6"/>',
		checkbox: '<rect x="2.4" y="2.4" width="11.2" height="11.2"/><path d="m5 8.2 2 2 4-4.2"/>',
		sum: '<path d="M12 3H4.2l4 5-4 5H12"/>',
		person: '<circle cx="8" cy="5" r="2.8"/><path d="M2.6 14c.6-3 2.8-4.6 5.4-4.6s4.8 1.6 5.4 4.6"/>',
		flame: '<path d="M8 1.8c.4 2.6 3.6 3.8 3.6 7.4a3.6 3.6 0 0 1-7.2 0c0-1.6.8-2.6 1.6-3.4.2 1.2.8 1.8 1.6 2C7 6 7.4 3.8 8 1.8z"/>',
		diff: '<rect x="1.8" y="2.4" width="5.4" height="11.2"/><rect x="8.8" y="2.4" width="5.4" height="11.2"/><path d="M3.4 8h2.2M10.4 8h2.2M11.5 6.9v2.2"/>',
		columns: '<rect x="2" y="3" width="12" height="10"/><path d="M6 3v10M10 3v10"/>',
		swap: '<path d="M2.4 5h10.4M10 2.4 12.8 5 10 7.6M13.6 11H3.2M6 8.4 3.2 11 6 13.6"/>',
		pulse: '<path d="M1.6 8.4h3l1.6-4.2 3 8 1.8-3.8h3.4"/>',
		refresh: '<path d="M13.2 6.6A5.4 5.4 0 0 0 3.4 5M2.8 9.4A5.4 5.4 0 0 0 12.6 11M3.4 2.2V5h2.8M12.6 13.8V11H9.8"/>',
		undo: '<path d="M4 6.4h6a3.4 3.4 0 0 1 0 6.8H6.6"/><path d="M6.6 3.6 3.8 6.4l2.8 2.8"/>',
		trash: '<path d="M2.6 4h10.8M6 4V2.4h4V4M3.8 4l.8 9.8h6.8l.8-9.8"/>',
		copy: '<rect x="5" y="5" width="8.6" height="8.6"/><path d="M3 10.6H2.4V2.4h8.2V3"/>',
		play: '<path d="M4.6 2.8v10.4L13 8z"/>',
		stop: '<rect x="3.4" y="3.4" width="9.2" height="9.2"/>',
		desktop: '<rect x="1.8" y="2.4" width="12.4" height="8.4"/><path d="M5.4 13.6h5.2M8 10.8v2.8"/>',
		bulb: '<path d="M5.8 11.2c0-1.6-2.4-2.6-2.4-5.2a4.6 4.6 0 0 1 9.2 0c0 2.6-2.4 3.6-2.4 5.2zM6 13.6h4"/>',
		question: '<circle cx="8" cy="8" r="6"/><path d="M6.2 6.2a1.8 1.8 0 1 1 2.6 1.6c-.6.3-.8.7-.8 1.4M8 11.4h.01"/>',
		arrowR: '<path d="M3 8h10M9 4l4 4-4 4"/>',
		fold: '<path d="M2 8h12M5.6 4.6 8 2.2l2.4 2.4M5.6 11.4 8 13.8l2.4-2.4"/>',
		edit: '<path d="m10.6 2.4 3 3-8 8H2.6v-3z"/>',
		percent: '<path d="m3 13 10-10"/><circle cx="4.4" cy="4.4" r="1.6"/><circle cx="11.6" cy="11.6" r="1.6"/>',
	};

	// ------------------------------------------------------------------ helpers

	const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' };
	const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ESC[c]);
	const ic = (name, cls = '') => `<svg class="ss-ic ${cls}" viewBox="0 0 16 16" aria-hidden="true">${ICONS[name] || ''}</svg>`;
	const MARK = '<svg class="ss-mark" viewBox="0 0 100 100" aria-hidden="true"><rect width="100" height="100" rx="24" fill="#3E8E5A"/><rect x="18" y="18" width="64" height="64" rx="6" fill="#fff"/><path d="M18 34.5H82M37.5 34.5V82M18 50H37.5M18 66H37.5" fill="none" stroke="#3E8E5A" stroke-width="3.5" opacity=".5"/><rect x="45" y="60" width="8" height="15" fill="#3E8E5A"/><rect x="57" y="51" width="8" height="24" fill="#3E8E5A"/><rect x="69" y="42" width="8" height="33" fill="#3E8E5A"/></svg>';
	const parse = text => { try { return JSON.parse(text); } catch { return undefined; } };
	const obj = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
	const arr = value => Array.isArray(value) ? value : [];
	const num = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
	const fold = text => String(text ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
	const pad = n => String(n).padStart(2, '0');
	const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
	const sumOf = list => list.reduce((a, v) => a + (num(v) || 0), 0);

	/** A number in the Brazilian way: 1.234,56 (and a true minus sign). */
	function nf(value, decimals = 0) {
		const v = Number(value);
		if (value === null || value === undefined || !Number.isFinite(v)) { return '—'; }
		const text = Math.abs(v).toFixed(decimals);
		if (v !== 0 && Number(text) === 0) {
			return (v < 0 ? '−' : '') + String(Number(Math.abs(v).toPrecision(12))).replace('.', ',');
		}
		const [whole, fraction] = text.split('.');
		return (v < 0 && Number(text) !== 0 ? '−' : '') + whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + (fraction ? `,${fraction}` : '');
	}
	/** Decimals a value needs (0, 1 or 2), for ticks and plain numbers. */
	const decimals = v => { const a = Math.abs(v); return Math.abs(a - Math.round(a)) < 1e-9 ? 0 : Math.abs(a * 10 - Math.round(a * 10)) < 1e-9 ? 1 : 2; };
	const nfa = v => nf(v, decimals(v));
	const plural = (n, one, many) => `${nf(n)} ${n === 1 ? one : many}`;
	const brl = v => `R$ ${nf(v, 2)}`;
	/** R$ 21,7 mil, R$ 1,2 mi, R$ 45,23. */
	function short(v, unit) {
		if (num(v) === null) { return '—'; }
		const a = Math.abs(v);
		if (unit === 'percent') { return `${nf(v * 100, a >= 0.1 ? 0 : 1)}%`; }
		const prefix = unit === 'currency' ? 'R$ ' : '';
		if (a >= 1e6) { return `${prefix}${nf(v / 1e6, 1)} mi`; }
		if (a >= 1e4 || (unit === 'currency' && a >= 1e3)) { return `${prefix}${nf(v / 1e3, decimals(Math.round(v / 100) / 10) ? 1 : 0)} mil`; }
		return `${prefix}${unit === 'currency' ? nf(v, decimals(v) ? 2 : 0) : nfa(v)}`;
	}
	/** A value with its unit, in full: R$ 1.234,56, 12,5%, 4.317. */
	function full(v, unit) {
		if (num(v) === null) { return '—'; }
		if (unit === 'currency') { return brl(v); }
		if (unit === 'percent') { return `${nf(v * 100, 1)}%`; }
		return nfa(v);
	}
	/** A value for a numbers table whose header says the unit (no R$ in every cell). */
	function plain(v, unit) {
		if (num(v) === null) { return '<span class="ss-dim">—</span>'; }
		if (unit === 'currency') { return nf(v, 2); }
		if (unit === 'percent') { return `${nf(v * 100, 1)}%`; }
		return nfa(v);
	}
	function tickText(v, unit) {
		if (v === 0) { return unit === 'currency' ? 'R$ 0' : unit === 'percent' ? '0%' : '0'; }
		const a = Math.abs(v);
		if (unit === 'percent') { return `${nf(v * 100, decimals(Math.round(v * 1000) / 10))}%`; }
		const prefix = unit === 'currency' ? 'R$ ' : '';
		if (a >= 1e6) { return `${prefix}${nf(v / 1e6, decimals(v / 1e6))} mi`; }
		if (a >= 1e3 && unit === 'currency') { return `${prefix}${nf(v / 1e3, decimals(v / 1e3))} mil`; }
		return `${prefix}${nf(v, decimals(v))}`;
	}
	const unitNote = unit => unit === 'currency' ? 'valores em R$' : unit === 'percent' ? 'valores em %' : unit === 'count' ? 'em linhas' : '';
	const bytes = n => n < 1024 ? `${nf(n)} bytes` : n < 1048576 ? `${nf(n / 1024, 0)} KB` : `${nf(n / 1048576, 1)} MB`;
	const isoDate = text => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(text || '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : String(text ?? ''); };
	const isoShort = text => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(text || '')); return m ? `${m[3]}/${m[2]}` : String(text ?? ''); };
	const hm = seconds => { const d = new Date(seconds * 1000); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
	const dmy = seconds => { const d = new Date(seconds * 1000); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`; };
	const sameDay = (a, b) => new Date(a * 1000).toDateString() === new Date(b * 1000).toDateString();
	const when = seconds => !seconds ? '—' : sameDay(seconds, Date.now() / 1000) ? `hoje às ${hm(seconds)}` : `${dmy(seconds)} ${hm(seconds)}`;
	const secs = s => s < 60 ? `${nf(s, s < 10 ? 1 : 0)} s` : `${Math.floor(s / 60)} min ${pad(Math.round(s % 60))} s`;
	const basename = path => String(path || '').split('/').pop();
	const dirname = path => { const parts = String(path || '').split('/'); parts.pop(); return parts.join('/'); };
	const extension = path => (/\.([a-z0-9]+)$/i.exec(String(path || '')) || [])[1]?.toLowerCase() || '';
	/** The same file name the tool makes (common.slug): plain ASCII, lower case, dashes. */
	const slug = (text, fallback = 'planilha') => (String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\x00-\x7F]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)) || fallback;
	const cap = text => String(text || '').charAt(0).toUpperCase() + String(text || '').slice(1);
	const joinPt = list => list.length <= 1 ? (list[0] || '') : `${list.slice(0, -1).join(', ')} e ${list[list.length - 1]}`;
	const m = text => `<span class="ss-m">${esc(text)}</span>`;
	const dim = html => `<span class="ss-dim">${html}</span>`;
	const tx = html => `<span class="tx">${html}</span>`;
	const pill = (text, cls = '') => `<span class="ss-pill ${cls}">${esc(text)}</span>`;
	const ins = html => `<ins class="ss-ins">${html}</ins>`;
	const del = html => `<del class="ss-del">${html}</del>`;
	/** Estimated width of a text in px (Tahoma, about 0.56 em per character). */
	const tw = (text, size = 11) => String(text ?? '').length * size * 0.56;
	/** Width of a number in px: digits are about 0.55 em, dots and commas much narrower. */
	const twNum = (text, size = 11.5) => [...String(text ?? '')].reduce((a, ch) => a + (/[.,:]/.test(ch) ? 0.3 : /\d/.test(ch) ? 0.56 : 0.6) * size, 0);
	/** Cuts a text with … so it fits a width in px. */
	const fit = (text, width, size = 11) => { const t = String(text ?? ''); if (tw(t, size) <= width) { return t; } const n = Math.max(1, Math.floor(width / (size * 0.56)) - 1); return `${t.slice(0, n)}…`; };

	function btn(label, icon, cls = '', attrs = '') {
		return `<button class="ss-btn ${cls}" ${attrs}>${icon ? ic(...[].concat(icon)) : ''}${label ? `<span class="t">${label}</span>` : ''}</button>`;
	}

	function panel(title, body, o = {}) {
		return `<div class="ss-panel ${o.mk ? `mk mk-${o.mk}` : ''} ${o.cls || ''}" ${o.style ? `style="${o.style}"` : ''} ${o.attrs || ''}><div class="ss-ph ${o.click ? 'click' : ''}" ${o.click || ''}>${o.icon ? ic(...[].concat(o.icon)) : ''}<span class="t">${title}</span>${o.sub ? `<em>${o.sub}</em>` : ''}${o.right ? `<span class="r">${o.right}</span>` : ''}</div>${o.before || ''}<div class="ss-pb ${o.pb || ''}">${body}</div>${o.foot ? `<div class="ss-pfoot">${o.foot}</div>` : ''}</div>`;
	}

	const kv = (pairs, width) => `<div class="ss-kv" ${width ? `style="grid-template-columns:${width}px minmax(0,1fr)"` : ''}>${pairs.filter(Boolean).map(([k, v]) => `<span>${tx(k)}</span><span>${tx(v)}</span>`).join('')}</div>`;
	const note = (icon, cls, html, extra = '') => `<div class="ss-note ${extra}">${ic(icon, cls)}<div>${html}</div></div>`;
	const li = (icon, html, right = '', cls = '', attrs = '') => `<div class="ss-li ${cls}" ${attrs}>${icon}${tx(html)}${right ? `<em>${right}</em>` : ''}</div>`;
	const chip = (icon, text, extra = '') => `<span class="ss-chip">${icon.startsWith('<') ? icon : ic(icon)}<span class="t">${esc(text)}</span>${extra}</span>`;

	/** A table: cols are [label, width (0 = rest), class]; a row is cells or { c: cells, cls, attrs }. */
	function table(cols, rows, o = {}) {
		const head = `<colgroup>${cols.map(([, w]) => `<col ${w ? `style="width:${w}px"` : ''}>`).join('')}</colgroup><thead><tr>${cols.map(([label, , cls]) => `<th class="${cls || ''}">${label}</th>`).join('')}</tr></thead>`;
		const body = rows.map(r => {
			const opt = Array.isArray(r) ? {} : r;
			const cells = Array.isArray(r) ? r : r.c;
			return `<tr class="${opt.cls || ''}" ${opt.attrs || ''}>${cells.map((v, i) => `<td class="${cols[i][2] || ''}">${v}</td>`).join('')}</tr>`;
		}).join('');
		return `<table class="ss-tbl ${o.cls || ''}">${head}<tbody>${body}</tbody></table>`;
	}

	/** Drops the columns given as null, and their cells, so a narrow Studio keeps the ones that matter. */
	function columnsFor(cols, rows) {
		const keep = cols.map((col, i) => col ? i : -1).filter(i => i >= 0);
		return [keep.map(i => cols[i]), rows.map(r => Array.isArray(r) ? keep.map(i => r[i]) : { ...r, c: keep.map(i => r.c[i]) })];
	}

	/** The type of a column as a small icon or letters, as in the mockups (R$, abc, 123). */
	function typeIcon(type, calculated) {
		if (calculated) { return '<span class="ss-ty">fx</span>'; }
		const t = TYPES[type] || TYPES.text;
		return t.icon ? ic(t.icon) : `<span class="ss-ty">${t.ty}</span>`;
	}
	const typeLabel = type => (TYPES[type] || TYPES.text).label;

	// ------------------------------------------------------------------ state

	const saved = host.getState() || {};
	const S = {
		ctx: null,
		sheet: null,
		grid: null,
		charts: [],
		dashboard: null,
		cleanup: null,
		history: [],
		settings: { ...SETTINGS },
		view: VIEWS[saved.view] ? saved.view : 'sheet',
		viewRevision: 0,
		chartSel: saved.chartSel || null,
		colSel: saved.colSel || null,
		profSel: saved.profSel || null,
		panelPick: null,
		probSel: null,
		cell: null,
		fileSel: null,
		histSel: null,
		histText: '',
		histFilter: 'all',
		showCalc: false,
		setDraft: {},
		setSection: 'read',
		setPicked: false,
		csvDraft: {},
		exporting: null,
		menu: false,
		menuX: 0,
		running: false,
		pending: null,
		note: null,
	};

	function remember() {
		host.setState({ view: S.view, chartSel: S.chartSel, colSel: S.colSel, profSel: S.profSel, viewRevision: S.viewRevision });
	}

	const narrow = () => window.innerWidth < 1200;
	const tight = () => window.innerWidth < 1000;

	function ask(text, send = true) {
		const requestId = send ? `ss-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}` : undefined;
		host.postMessage({ type: 'ask', text, send: !!send, ...(requestId ? { requestId } : {}) });
		return requestId;
	}

	/** Sends a request to the agent; the Studio changes when the tool writes its files. */
	function act(text) {
		const requestId = ask(text, true);
		S.pending = { requestId, at: Date.now(), text };
		toast('Pedido enviado ao agente. Acompanhe na conversa.');
	}

	/** Puts a question in the chat box without sending it. */
	function fill(text) {
		ask(text, false);
		toast('A pergunta está na caixa da conversa: complete e envie.');
	}

	// ------------------------------------------------------------------ derived data

	const isOpen = () => S.sheet?.status === 'ready' && !!obj(S.sheet.sheet) && !!obj(S.sheet.file);
	const importing = () => S.sheet?.status === 'importing';
	const fileInfo = () => obj(S.sheet?.file) || {};
	const sheetInfo = () => obj(S.sheet?.sheet) || {};
	const steps = () => arr(S.sheet?.steps);
	const version = () => num(S.sheet?.version);
	const basis = () => S.sheet?.basis === 'clean' ? 'clean' : 'raw';
	const profileColumns = () => arr(S.sheet?.columns).filter(c => obj(c) && c.key);
	const gridColumns = () => arr(S.grid?.columns).filter(c => obj(c) && c.key);
	const isCalc = col => !!col && (col.calculated || /^x\d+$/.test(String(col.key)));
	const colByKey = key => profileColumns().find(c => c.key === key) || gridColumns().find(c => c.key === key);
	function findColumn(select) {
		if (!select) { return undefined; }
		const f = fold(select);
		const all = gridColumns().concat(profileColumns());
		return all.find(c => c.key === select) || all.find(c => fold(c.name) === f) || all.find(c => fold(c.letter) === f);
	}
	const found = () => arr(S.sheet?.found).filter(f => obj(f) && f.path);
	const settings = () => ({ ...SETTINGS, ...S.settings });
	const rowsNow = () => num(S.sheet?.rows) ?? 0;
	const rowsRaw = () => num(S.sheet?.rowsRaw) ?? rowsNow();
	const activeSheetMeta = () => arr(S.sheet?.sheets).find(s => s.id === sheetInfo().id) || {};

	/** The period of the first date column, like 02/01 a 31/10/2026. */
	function period() {
		const col = profileColumns().find(c => (c.type === 'date' || c.type === 'datetime') && c.min && c.max);
		if (!col) { return ''; }
		const a = String(col.min), b = String(col.max);
		return a.slice(0, 4) === b.slice(0, 4) ? `${isoShort(a)} a ${isoDate(b)}` : `${isoDate(a)} a ${isoDate(b)}`;
	}

	/** Where a chart belongs: this sheet, another sheet of the open file, or another file. */
	function scopeOf(c) {
		if (!isOpen() || !c.sheet) { return 'here'; }
		if (c.sheet === sheetInfo().id) { return 'here'; }
		return c.file === fileInfo().id ? 'sheet' : 'file';
	}
	/** [label, pill class, stale] for data made on a basis and version, against the open sheet now. */
	function dataState(basisValue, versionValue, scope = 'here') {
		if (scope === 'file') { return ['outro arquivo', '', false]; }
		if (scope === 'sheet') { return ['outra aba', '', false]; }
		if (!isOpen()) { return null; }
		if (basisValue === 'raw' && basis() === 'clean') { return ['antes da limpeza', 'you', true]; }
		if (num(versionValue) !== null && version() !== null && versionValue !== version()) { return ['visão anterior', 'you', true]; }
		if (basisValue === 'clean') { return ['visão limpa', 'ok', false]; }
		return null;
	}
	const chartState = c => dataState(c.calc?.basis, c.calc?.steps, scopeOf(c));
	const isStale = c => !!chartState(c)?.[2];
	const chartById = id => S.charts.find(c => c.id === id);
	const selectedChart = () => chartById(S.chartSel) || S.charts[0];
	const panelStale = () => {
		const d = S.dashboard;
		return !!d && !!dataState(d.basis, d.version, scopeOf(d))?.[2];
	};
	const additive = c => ['sum', 'count'].includes(c.y?.agg);

	/** A column of the sheet, by name, to show its type next to it. */
	const typeOfName = name => (findColumn(name) || {}).type;

	/** "por mês de data", "por serviço" for a column and its grouping. */
	function byText(by, column) {
		if (!column) { return ''; }
		if (!by || by === 'value') { return column; }
		const word = BY[by] || by;
		return fold(word) === fold(column) ? column : `${word} de ${column}`;
	}

	/** The chart's request in words, precise enough for the agent to make it again with the chart action. */
	function specText(c) {
		const spec = obj(c.spec) || {};
		if (c.kind === 'query') { return `SQL ${c.calc?.sql || ''}`.trim(); }
		const filter = typeof spec.filter === 'string' ? spec.filter : arr(c.calc?.filter).join(' e ');
		if (c.kind === 'pivot') {
			const parts = [`linhas ${byText(spec.rows_by, spec.rows || c.x?.column)}`];
			if (spec.columns || c.group?.column) { parts.push(`colunas ${byText(spec.columns_by, spec.columns || c.group?.column)}`); }
			parts.push(spec.value || c.y?.column ? `${AGG[c.y?.agg] || 'soma'} de ${spec.value || c.y.column}` : 'contagem de linhas');
			if (filter) { parts.push(`só onde ${filter}`); }
			return parts.join(', ');
		}
		const y = spec.y || c.y?.column;
		const agg = c.y?.agg || spec.agg || (y ? 'sum' : 'count');
		let text = y ? `${AGG[agg] || agg} de ${y}` : 'contagem de linhas';
		const x = spec.x || c.x?.column;
		if (x) { text += ` por ${byText(spec.by || c.x?.by, x)}`; }
		const group = spec.group || c.group?.column;
		if (group) { text += ` e por ${byText(spec.group_by || c.group?.by, group)}`; }
		if (filter) { text += `, só onde ${filter}`; }
		if (spec.top) { text += `, só os ${spec.top} maiores`; }
		return text;
	}
	const redoText = c => c.kind === 'query'
		? `Rode de novo a consulta ${c.id} com a visão limpa: ${c.calc?.sql || ''}`
		: `Refaça o gráfico ${c.id} com a visão limpa: ${specText(c)}${KINDS[c.kind] && c.kind !== 'pivot' ? `, em ${KINDS[c.kind].phrase}` : ''}${c.title ? `, com o título "${c.title}"` : ''}`;

	/** Several charts to redo, each with its request; long lists keep the first ones whole and name the rest. */
	function redoAllText(list) {
		const head = `Refaça com a visão limpa os gráficos ${joinPt(list.map(c => c.id))}: `;
		const parts = [];
		let length = head.length;
		for (const c of list) {
			const part = `${c.id} (${c.kind === 'query' ? `SQL ${c.calc?.sql || ''}` : `${specText(c)}, em ${KINDS[c.kind]?.phrase || c.kind}, título "${c.title}"`})`;
			if (length + part.length + 2 > 3600) { parts.push(`os outros como estão no Studio`); break; }
			parts.push(part);
			length += part.length + 2;
		}
		return head + parts.join('; ');
	}

	/** "serviço = Corte e barba" reads back as the column name, to mark the filtered grid column. */
	const filterColumn = text => (/^(.+?)\s*(?:>=|<=|!=|<>|=|>|<|\bcont[eé]m\b|\bem\b|\bvazio\b|\bpreenchido\b)/i.exec(String(text)) || [])[1]?.trim();

	// ------------------------------------------------------------------ charts (inline SVG)

	let svgSeq = 0;
	let SLOTS = [];
	/** A place for a chart that is drawn after layout, at the size its box got. */
	function slot(fn, style = '', cls = '') {
		SLOTS.push(fn);
		return `<div class="ss-slot ${cls}" data-slot="${SLOTS.length - 1}" ${style ? `style="${style}"` : ''}></div>`;
	}
	const px = v => Math.round(v) + 0.5;
	const tt = (title, rows) => `data-tt="${esc(JSON.stringify({ t: title, r: rows }))}"`;

	function niceScale(min, max, count = 4) {
		if (!(max > min)) { max = min + 1; }
		const raw = (max - min) / count;
		const mag = 10 ** Math.floor(Math.log10(raw));
		const n = raw / mag;
		const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
		const lo = Math.floor(min / step + 1e-9) * step;
		const hi = Math.ceil(max / step - 1e-9) * step;
		const ticks = [];
		for (let k = 0; lo + k * step <= hi + step / 2; k++) {
			ticks.push(Number((lo + k * step).toPrecision(12)));
		}
		return { lo, hi: hi > lo ? hi : lo + step, ticks };
	}

	/** Gridlines and tick labels; returns [svg, left margin]. */
	function yAxis(sc, unit, w, R, y) {
		const texts = sc.ticks.map(t => tickText(t, unit));
		const L = Math.ceil(Math.max(...texts.map(t => tw(t)))) + 14;
		let s = '';
		sc.ticks.forEach((t, i) => {
			s += `<line x1="${L}" x2="${w - R}" y1="${px(y(t))}" y2="${px(y(t))}" stroke="${t === 0 ? AXIS : GRID}"/><text x="${L - 8}" y="${Math.round(y(t)) + 4}" text-anchor="end" class="tk">${esc(texts[i])}</text>`;
		});
		return [s, L];
	}
	const leftOf = (sc, unit) => Math.ceil(Math.max(...sc.ticks.map(t => tw(tickText(t, unit))))) + 14;

	/** X labels that fit: every k-th one when they would touch. */
	function xLabels(labels, x, band, yText) {
		const widest = Math.max(...labels.map(l => tw(l))) + 8;
		const step = Math.max(1, Math.ceil(widest / Math.max(1, band)));
		return labels.map((label, i) => i % step ? '' : `<text x="${x(i).toFixed(1)}" y="${yText}" text-anchor="middle" class="xl">${esc(fit(label, band * step - 4))}</text>`).join('');
	}

	const emptySvg = (w, h, text) => `<svg class="ss-svg" width="${w}" height="${h}"><text x="${w / 2}" y="${h / 2}" text-anchor="middle" class="tk">${esc(text)}</text></svg>`;

	/** Vertical bars of one series. o: { values, labels, unit, colors, click, chart, labelAll } */
	function vbars(c, w, h, mode, o = {}) {
		const values = (o.values || c.series[0].values).map(num);
		const labels = (o.labels || c.labels).map(String);
		const unit = o.unit || c.unit;
		const nums = values.filter(v => v !== null);
		if (!nums.length) { return emptySvg(w, h, 'Sem valores'); }
		const thumb = mode === 'thumb';
		const sc = niceScale(Math.min(0, ...nums), Math.max(0, ...nums), h < 170 ? 3 : 4);
		const R = 8, B = thumb ? 2 : 22, T = thumb ? 2 : 20;
		const L = thumb ? 2 : leftOf(sc, unit);
		const ph = Math.max(10, h - T - B), pw = Math.max(10, w - L - R);
		const y = v => T + ph - (v - sc.lo) / (sc.hi - sc.lo) * ph;
		const n = values.length, band = pw / n, bw = Math.max(1, Math.round(Math.min(band * 0.64, 64)));
		let s = `<svg class="ss-svg" width="${w}" height="${h}">`;
		if (!thumb) { s += yAxis(sc, unit, w, R, y)[0]; }
		const max = Math.max(...nums), min = Math.min(...nums);
		const valW = Math.max(...nums.map(v => tw(short(v, unit)) + 6));
		const labelAll = o.labelAll !== false && n <= 8 && band >= valW;
		const iMin = values.indexOf(min);
		const marked = new Set(labelAll ? values.map((_, i) => i) : [values.indexOf(max)].concat(tw(short(min, unit)) + 4 <= band ? [iMin] : []));
		const total = additive(c) && o.share !== false ? sumOf(values) : 0;
		values.forEach((v, i) => {
			if (v === null) { return; }
			const x = Math.round(L + band * i + (band - bw) / 2);
			const top = Math.round(Math.min(y(v), y(0))), bottom = Math.round(Math.max(y(v), y(0)));
			const fill = o.colors?.[i] || o.color || PAL[0];
			const rows = [[o.name || c.series[0]?.name || '', full(v, unit)]];
			if (total) { rows.push(['parte do total', `${nf(v / total * 100, 1)}%`]); }
			const click = o.click ? `data-act="bar" data-chart="${esc(c.id)}" data-i="${i}"` : '';
			s += `<rect x="${x}" y="${top}" width="${bw}" height="${Math.max(1, bottom - top)}" fill="${fill}" ${thumb ? '' : tt(labels[i], rows)} ${click}/>`;
			if (!thumb && marked.has(i) && mode !== 'tiny') {
				s += `<text x="${x + bw / 2}" y="${v >= 0 ? top - 6 : bottom + 13}" text-anchor="middle" class="vl">${esc(short(v, unit))}</text>`;
			}
		});
		if (!thumb) {
			s += `<line x1="${L}" x2="${w - R}" y1="${px(y(0))}" y2="${px(y(0))}" stroke="${AXIS}"/>`;
			s += xLabels(labels, i => L + band * i + band / 2, band, h - 6);
		}
		return `${s}</svg>`;
	}

	/** Horizontal bars of one series, with the value and its share written at the end of each bar. */
	function hbars(c, w, h, mode, o = {}) {
		const values = (o.values || c.series[0].values).map(num);
		const labels = (o.labels || c.labels).map(String);
		const unit = o.unit || c.unit;
		const nums = values.filter(v => v !== null);
		if (!nums.length) { return emptySvg(w, h, 'Sem valores'); }
		const T = 4, B = 4, n = values.length;
		const fits = Math.max(1, Math.floor((h - T - B) / 17));
		const shown = n > fits ? Math.max(1, fits - 1) : n;
		const rowH = Math.min(mode === 'main' ? 34 : 30, (h - T - B) / (shown + (shown < n ? 1 : 0)));
		const bh = Math.max(3, Math.round(rowH * 0.58));
		const total = additive(c) ? sumOf(values) : 0;
		const notes = values.map(v => o.notes ? '' : total && v !== null ? `${nf(v / total * 100, 1)}%` : '');
		const vtexts = values.map(v => mode === 'main' ? full(v, unit) : short(v, unit));
		const labelW = clamp(Math.max(...labels.slice(0, shown).map(l => tw(l))) + 12, 40, Math.round(w * (mode === 'main' ? 0.3 : 0.34)));
		const valW = Math.max(...vtexts.slice(0, shown).map((t, i) => tw(t) * 1.08 + (notes[i] ? tw(notes[i]) + 6 : 0))) + 12;
		const x0 = labelW + 1;
		const pw = Math.max(10, w - x0 - valW - 4);
		const lo = Math.min(...nums, 0), hi = Math.max(...nums, 0);
		const x = v => x0 + (v - lo) / (hi - lo || 1) * pw;
		const zero = x(0);
		let s = `<svg class="ss-svg" width="${w}" height="${h}"><line x1="${px(zero)}" x2="${px(zero)}" y1="${T}" y2="${Math.round(T + rowH * shown)}" stroke="${AXIS}"/>`;
		for (let i = 0; i < shown; i++) {
			const v = values[i];
			const y0 = Math.round(T + rowH * i + (rowH - bh) / 2);
			const bw = v === null || v === 0 ? 0 : Math.max(1, Math.round(Math.abs(x(v) - zero)));
			const bx = v === null ? zero : Math.min(zero, x(v));
			const sel = o.sel !== undefined && o.sel !== null;
			const fill = sel ? (o.sel === i ? PAL[0] : MUTED) : PAL[0];
			const click = o.click ? `data-act="bar" data-chart="${esc(c.id)}" data-i="${i}"` : '';
			s += `<text x="${labelW - 8}" y="${y0 + bh / 2 + 4}" text-anchor="end" class="cat">${esc(fit(labels[i], labelW - 12))}</text>`;
			if (bw) {
				const rows = [[c.series[0]?.name || '', full(v, unit)]];
				if (total) { rows.push(['parte do total', notes[i]]); }
				s += `<rect x="${bx}" y="${y0}" width="${bw}" height="${bh}" fill="${fill}" ${tt(labels[i], rows)} ${click}/>`;
			}
			s += `<text x="${Math.max(zero, x(v || 0)) + 8}" y="${y0 + bh / 2 + 4}" class="${sel && o.sel !== i ? 'vs' : 'vl'}">${esc(vtexts[i])}${notes[i] ? `<tspan class="tk" dx="6">${esc(notes[i])}</tspan>` : ''}</text>`;
		}
		if (shown < n) {
			s += `<text x="${x0}" y="${Math.round(T + rowH * shown + rowH / 2 + 4)}" class="tk">+ ${esc(plural(n - shown, 'grupo', 'grupos'))} na tabela</text>`;
		}
		return `${s}</svg>`;
	}

	/** Lines, one per series, with the name and the last value written at the end of each line. */
	function lines(c, w, h, mode) {
		const series = c.series;
		const labels = c.labels.map(String);
		const unit = c.unit;
		const all = series.flatMap(s => s.values.map(num)).filter(v => v !== null);
		if (!all.length) { return emptySvg(w, h, 'Sem valores'); }
		const sc = niceScale(Math.min(0, ...all), Math.max(...all), h < 170 ? 3 : 4);
		const ends = mode !== 'thumb' && series.length <= 6 && w > 260;
		const endW = ends ? Math.max(...series.map(s => Math.max(tw(s.name) * 1.1, tw(short(s.values.map(num).filter(v => v !== null).at(-1), unit))))) + 18 : 0;
		const R = ends ? Math.min(Math.round(w * 0.3), endW) : 10;
		const T = 10, B = 22;
		const L = leftOf(sc, unit);
		const ph = Math.max(10, h - T - B), pw = Math.max(10, w - L - R);
		const n = labels.length, band = pw / n;
		const x = i => L + band * i + band / 2;
		const y = v => T + ph - (v - sc.lo) / (sc.hi - sc.lo) * ph;
		let s = `<svg class="ss-svg" width="${w}" height="${h}">${yAxis(sc, unit, w, R, y)[0]}`;
		s += xLabels(labels, x, band, h - 6);
		const tips = [];
		const end = [];
		series.forEach((se, k) => {
			const color = PAL[k % PAL.length];
			const pts = se.values.map((v, i) => num(v) === null ? null : [x(i), y(v)]);
			let d = '';
			let pen = false;
			pts.forEach(p => { if (!p) { pen = false; return; } d += `${pen ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`; pen = true; });
			s += `<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>`;
			if (band >= 9) {
				pts.forEach(p => { if (p) { s += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${mode === 'main' ? 3.4 : 2.6}" fill="${color}" stroke="#252526" stroke-width="1.4"/>`; } });
			}
			const last = pts.filter(Boolean).at(-1);
			if (last) { end.push({ y: last[1], name: se.name, v: se.values.map(num).filter(v => v !== null).at(-1), color }); }
		});
		// One invisible column per label carries the tooltip with every series.
		labels.forEach((label, i) => {
			tips.push(`<rect x="${(L + band * i).toFixed(1)}" y="${T}" width="${band.toFixed(1)}" height="${ph}" fill="transparent" ${tt(label, series.map((se, k) => [se.name, full(num(se.values[i]), unit), PAL[k % PAL.length]]))}/>`);
		});
		s += tips.join('');
		if (ends) {
			end.sort((a, b) => a.y - b.y);
			const gap = mode === 'main' ? 30 : 28;
			for (let i = 1; i < end.length; i++) { if (end[i].y - end[i - 1].y < gap) { end[i].y = end[i - 1].y + gap; } }
			const over = end.length ? end.at(-1).y + 14 - (h - B) : 0;
			if (over > 0) { end.forEach(e => { e.y -= over; }); }
			end.forEach(e => {
				const yy = Math.max(T + 8, e.y);
				s += `<text x="${w - R + 10}" y="${(yy + 1).toFixed(1)}" class="cat b">${esc(fit(e.name, R - 14))}</text><text x="${w - R + 10}" y="${(yy + 14).toFixed(1)}" class="tk">${esc(short(e.v, unit))}</text>`;
			});
		}
		return `${s}</svg>`;
	}

	/** Stacked columns, in values or as a share of each column (100%). */
	function stacks(c, w, h, mode, percent) {
		const labels = c.labels.map(String);
		const series = c.series;
		const unit = c.unit;
		const n = labels.length;
		const positives = labels.map((_, i) => sumOf(series.map(se => Math.max(0, num(se.values[i]) || 0))));
		const negatives = labels.map((_, i) => sumOf(series.map(se => Math.min(0, num(se.values[i]) || 0))));
		const totals = positives.map((v, i) => v + negatives[i]);
		const magnitude = positives.map((v, i) => v - negatives[i] || 1);
		const lows = negatives.map((v, i) => percent ? v / magnitude[i] : v);
		const highs = positives.map((v, i) => percent ? v / magnitude[i] : v);
		const sc = niceScale(Math.min(0, ...lows), Math.max(0, ...highs), h < 170 ? 3 : 4);
		const tunit = percent ? 'percent' : unit;
		const R = 8, B = 22, T = percent ? 8 : 20;
		const L = leftOf(sc, tunit);
		const ph = Math.max(10, h - T - B), pw = Math.max(10, w - L - R);
		const y = v => T + ph - (v - sc.lo) / (sc.hi - sc.lo) * ph;
		const band = pw / n, bw = Math.max(1, Math.round(Math.min(band * 0.7, 62)));
		let s = `<svg class="ss-svg" width="${w}" height="${h}">${yAxis(sc, tunit, w, R, y)[0]}`;
		const iMax = totals.indexOf(Math.max(...totals));
		labels.forEach((label, i) => {
			const x = Math.round(L + band * i + (band - bw) / 2);
			const total = totals[i];
			let positive = 0, negative = 0;
			const rows = series.map((se, k) => [se.name, `${full(num(se.values[i]), unit)} · ${nf((num(se.values[i]) || 0) / magnitude[i] * 100, 0)}%`, PAL[k % PAL.length]]);
			series.forEach((se, k) => {
				const v = num(se.values[i]) || 0;
				const part = percent ? v / magnitude[i] : v;
				const acc = part >= 0 ? positive : negative;
				const y1 = Math.round(y(acc)), y2 = Math.round(y(acc + part));
				const height = Math.abs(y1 - y2);
				const gap = k < series.length - 1 && height > 3 ? 1 : 0;
				if (height > 0) {
					s += `<rect x="${x}" y="${Math.min(y1, y2) + gap}" width="${bw}" height="${Math.max(1, height - gap)}" fill="${PAL[k % PAL.length]}" ${tt(label, rows)}/>`;
					const show = percent && mode !== 'thumb' && (n <= 6 || i === 0 || i === n - 1) && height >= 16 && bw >= 28;
					if (show) { s += `<text x="${x + bw / 2}" y="${(y1 + y2) / 2 + 4}" text-anchor="middle" class="il">${nf(part * 100, 0)}%</text>`; }
				}
				if (part >= 0) { positive += part; } else { negative += part; }
			});
			if (!percent && i === iMax && mode !== 'thumb') { s += `<text x="${x + bw / 2}" y="${Math.round(y(total)) - 6}" text-anchor="middle" class="vl">${esc(short(total, unit))}</text>`; }
		});
		s += xLabels(labels, i => L + band * i + band / 2, band, h - 6);
		return `${s}</svg>`;
	}

	/** Columns side by side, one per series. */
	function grouped(c, w, h, mode) {
		const labels = c.labels.map(String);
		const series = c.series;
		const unit = c.unit;
		const all = series.flatMap(s => s.values.map(num)).filter(v => v !== null);
		if (!all.length) { return emptySvg(w, h, 'Sem valores'); }
		const sc = niceScale(Math.min(0, ...all), Math.max(0, ...all), h < 170 ? 3 : 4);
		const R = 8, B = 22, T = 10;
		const L = leftOf(sc, unit);
		const ph = Math.max(10, h - T - B), pw = Math.max(10, w - L - R);
		const y = v => T + ph - (v - sc.lo) / (sc.hi - sc.lo) * ph;
		const n = labels.length, k = series.length, band = pw / n;
		const bw = clamp(Math.floor((band * 0.8 - (k - 1) * 2) / k), 1, 26);
		let s = `<svg class="ss-svg" width="${w}" height="${h}">${yAxis(sc, unit, w, R, y)[0]}`;
		labels.forEach((label, i) => {
			const gx = L + band * i + (band - (bw * k + 2 * (k - 1))) / 2;
			const rows = series.map((se, j) => [se.name, full(num(se.values[i]), unit), PAL[j % PAL.length]]);
			series.forEach((se, j) => {
				const v = num(se.values[i]);
				if (v === null || v === 0) { return; }
				const x = Math.round(gx + j * (bw + 2));
				const top = Math.round(Math.min(y(v), y(0))), bottom = Math.round(Math.max(y(v), y(0)));
				s += `<rect x="${x}" y="${top}" width="${bw}" height="${Math.max(1, bottom - top)}" fill="${PAL[j % PAL.length]}" ${tt(label, rows)}/>`;
			});
		});
		s += `<line x1="${L}" x2="${w - R}" y1="${px(y(0))}" y2="${px(y(0))}" stroke="${AXIS}"/>`;
		s += xLabels(labels, i => L + band * i + band / 2, band, h - 6);
		return `${s}</svg>`;
	}

	/** A heat map: the series are the rows (weekdays), the labels the columns (hours); one blue ramp. */
	function heat(c, w, h, mode) {
		const rows = c.series.map(s => String(s.name));
		const cols = c.labels.map(String);
		const values = c.series.map(s => cols.map((_, j) => num(s.values[j])));
		const all = values.flat().filter(v => v !== null);
		if (!all.length) { return emptySvg(w, h, 'Sem valores'); }
		const max = Math.max(...all) || 1;
		const min = all.length > 1 ? Math.min(...all) : 0;
		const id = `ss-hatch-${++svgSeq}`;
		const L = Math.ceil(Math.max(...rows.map(r => tw(r)))) + 14, T = 2, B = 22, R = 4;
		const cw = (w - L - R) / cols.length, chh = (h - T - B) / rows.length;
		const step = v => Math.min(SEQ.length - 1, Math.max(0, Math.floor((v - min) / Math.max(1e-9, max - min) * (SEQ.length - 0.0001))));
		let best = [-1, -1, -Infinity];
		values.forEach((r, i) => r.forEach((v, j) => { if (v !== null && v > best[2]) { best = [i, j, v]; } }));
		let s = `<svg class="ss-svg" width="${w}" height="${h}"><defs><pattern id="${id}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#262628"/><line x1="0" y1="0" x2="0" y2="6" stroke="#3A3A3E" stroke-width="2"/></pattern></defs>`;
		rows.forEach((r, i) => {
			s += `<text x="${L - 8}" y="${(T + chh * i + chh / 2 + 4).toFixed(1)}" text-anchor="end" class="cat">${esc(r)}</text>`;
			cols.forEach((col, j) => {
				const v = values[i][j];
				const x0 = Math.round(L + cw * j) + 1, y0 = Math.round(T + chh * i) + 1;
				const ww = Math.round(L + cw * (j + 1)) - x0 - 1, hh = Math.round(T + chh * (i + 1)) - y0 - 1;
				if (ww < 1 || hh < 1) { return; }
				const title = `${WEEKDAY_FULL[r] || r}, ${col}`;
				if (v === null || v === 0) {
					s += `<rect x="${x0}" y="${y0}" width="${ww}" height="${hh}" fill="url(#${id})" ${tt(title, [['sem dados', '—']])}/>`;
					return;
				}
				const k = step(v);
				s += `<rect x="${x0}" y="${y0}" width="${ww}" height="${hh}" fill="${SEQ[k]}" ${tt(title, [[c.y?.column ? `${AGG[c.y.agg] || ''} de ${c.y.column}` : 'linhas', full(v, c.unit)]])}/>`;
				if (mode === 'main' && i === best[0] && j === best[1] && ww > 6 && hh > 6) { s += `<rect x="${x0 + 1}" y="${y0 + 1}" width="${ww - 2}" height="${hh - 2}" fill="none" stroke="#F1F1F1" stroke-width="2"/>`; }
				const text = short(v, c.unit);
				if (ww >= tw(text) + 6 && hh >= 14) { s += `<text x="${x0 + ww / 2}" y="${y0 + hh / 2 + 4}" text-anchor="middle" class="${k >= 6 ? 'id2' : 'il2'}" style="${k >= 7 ? 'font-weight:700' : ''}">${esc(text)}</text>`; }
			});
		});
		s += xLabels(cols, j => L + cw * j + cw / 2, cw, h - 6);
		return `${s}</svg>`;
	}

	/** Small bars without axes, for the profile table and the questions list. */
	function spark(values, w, h, colors) {
		const nums = values.map(v => Math.max(0, num(v) || 0));
		const max = Math.max(...nums, 0) || 1;
		const bw = (w - 4) / Math.max(1, nums.length);
		return `<svg class="ss-svg" width="${w}" height="${h}">${nums.map((v, i) => { const bh = Math.max(v ? 1 : 0, (h - 3) * v / max); return `<rect x="${(2 + bw * i + bw * 0.14).toFixed(1)}" y="${(h - 2 - bh).toFixed(1)}" width="${Math.max(1, bw * 0.72).toFixed(1)}" height="${bh.toFixed(1)}" fill="${colors?.[i] || PAL[0]}"/>`; }).join('')}<line x1="1" x2="${w - 1}" y1="${h - 1.5}" y2="${h - 1.5}" stroke="${AXIS}"/></svg>`;
	}

	/** The SVG of a chart at w × h. mode: main (the Gráficos view), mini (panel, history), thumb. */
	function chartSvg(c, w, h, mode = 'main', o = {}) {
		if (!arr(c.series).length || !arr(c.labels).length) { return emptySvg(w, h, 'Sem números para desenhar'); }
		if (mode === 'thumb') { return spark(c.series.length > 1 ? c.labels.map((_, i) => sumOf(c.series.map(s => s.values[i]))) : c.series[0].values, w, h); }
		const kind =c.kind === 'pivot' || c.kind === 'table' ? (c.series.length > 1 ? 'grouped' : 'bar') : c.kind;
		switch (kind) {
			case 'hbar': return hbars(c, w, h, mode, o);
			case 'line': return lines(c, w, h, mode);
			case 'stacked': return stacks(c, w, h, mode, false);
			case 'stacked100': return stacks(c, w, h, mode, true);
			case 'grouped': return grouped(c, w, h, mode);
			case 'heatmap': return heat(c, w, h, mode);
			default: return c.series.length > 1 ? grouped(c, w, h, mode) : vbars(c, w, h, mode, o);
		}
	}

	const legend = (c, line) => c.series.length > 1 && c.kind !== 'heatmap'
		? `<div class="ss-legend">${c.series.map((s, k) => `<span><i class="${line ? 'ln' : ''}" style="${line ? `border-color:${PAL[k % PAL.length]}` : `background:${PAL[k % PAL.length]}`}"></i><span class="t">${esc(s.name)}</span></span>`).join('')}</div>`
		: '';
	const heatLegend = c => {
		const all = c.series.flatMap(s => s.values.map(num)).filter(v => v !== null);
		const max = all.length ? Math.max(...all) : 0;
		const min = all.length > 1 ? Math.min(...all) : 0;
		return `<div class="ss-legend" style="padding:4px 10px 6px"><span>${esc(c.y?.column ? `${AGG[c.y.agg] || ''} de ${c.y.column}` : 'Linhas')}</span><span>${esc(short(min, c.unit))} <span class="ramp">${SEQ.map(col => `<i style="background:${col}"></i>`).join('')}</span> ${esc(short(max, c.unit))}</span><span><svg width="16" height="10"><rect width="16" height="10" fill="#262628"/><path d="M0 10 10 0M6 10 16 0" stroke="#3A3A3E" stroke-width="2"/></svg>sem dados</span></div>`;
	};

	// ------------------------------------------------------------------ toolbar and frame

	function toolbar() {
		const open = isOpen();
		const main = Object.entries(VIEWS).filter(([, v]) => !v.more);
		const moreOn = VIEWS[S.view]?.more;
		const buttons = main.map(([id, v]) => `<button class="ss-vb ${S.view === id && (open || v.offline) && !(importing() && !['history', 'settings'].includes(id)) ? 'on' : ''} ${open || v.offline ? '' : 'dis'}" data-act="view" data-view="${id}">${ic(v.icon)}${v.label}</button>`).join('');
		const more = `<button class="ss-vb ${moreOn ? 'on' : ''}" data-act="menu">${moreOn ? ic(VIEWS[S.view].icon) + (narrow() && VIEWS[S.view].short || VIEWS[S.view].label) : 'Mais'}${ic('chevD', 'chev')}</button>`;
		let crumb;
		if (importing()) {
			crumb = `<span class="ss-crumb">${MARK}<b>${esc(basename(S.sheet.progress?.path) || 'Abrindo planilha')}</b></span>`;
		} else if (open) {
			const chipText = basis() === 'clean' ? `visão limpa · ${nf(rowsNow())} linhas` : `${nf(rowsNow())} linhas`;
			crumb = `<span class="ss-crumb" title="${esc(fileInfo().path)}">${MARK}<b>${esc(fileInfo().name || basename(fileInfo().path))}</b><span class="v">${esc(chipText)}</span></span>`;
		} else {
			crumb = `<span class="ss-crumb">${MARK}<b>Nenhum arquivo aberto</b></span>`;
		}
		let status;
		let action = btn('Abrir arquivo', 'folderOpen', `ss-bar-open ${open || importing() ? '' : 'primary'}`, 'data-act="view" data-view="files"');
		if (importing()) {
			const p = obj(S.sheet.progress) || {};
			const share = num(p.total) ? ` · ${nf(Math.min(100, (p.rows || 0) / p.total * 100), 0)}%` : '';
			status = `<span class="ss-stat">${ic('spinner', 'spin c-run')}<span class="t">Abrindo${share}</span></span>`;
			action = btn('Parar', ['stop', 'c-bad'], '', 'data-act="stop"');
		} else if (S.running && S.pending) {
			status = `<span class="ss-stat">${ic('spinner', 'spin c-run')}<span class="t">Agente trabalhando</span></span>`;
		} else if (!open) {
			status = `<span class="ss-stat">${ic('dot', 'c-dim sm')}<span class="t">Esperando um arquivo</span></span>`;
		} else if (fileInfo().intact === false) {
			status = `<span class="ss-stat" title="O arquivo mudou no disco depois de lido. Abra de novo para ler a versão nova.">${ic('warning', 'c-you')}<span class="t">Original mudou</span></span>`;
		} else {
			status = `<span class="ss-stat">${ic('lock', 'c-dim')}<span class="t">${fileInfo().intact ? 'Original intacto' : 'Só leitura'}</span></span>`;
		}
		return `<div class="ss-bar">${buttons}${more}<span class="ss-sep"></span>${crumb}<span class="ss-sp"></span>${status}${action}</div>`;
	}

	function menu() {
		if (!S.menu) { return ''; }
		const items = Object.entries(VIEWS).filter(([, v]) => v.more)
			.map(([id, v]) => `<div class="mi ${S.view === id ? 'sel' : ''}" data-act="view" data-view="${id}">${ic(v.icon)}${v.label}</div>`).join('');
		const exportItem = isOpen() ? `<div class="mi" data-act="export-open">${ic('export')}Exportar…</div>` : `<div class="mi off">${ic('export')}Exportar…</div>`;
		return `<div class="ss-menu" style="left:${Math.round(S.menuX || 480)}px;top:36px">${items}<div class="msep"></div>${exportItem}</div>`;
	}

	function footer() {
		const ask_ = `${ic('comments')}botões pedem ao agente`;
		if (!isOpen()) {
			const n = found().length;
			const parts = [`<span class="f">${ic('dot', 'c-dim sm')}<span class="t">${importing() ? 'Abrindo uma planilha' : 'Nenhum arquivo aberto'}</span></span>`, `<span>${n ? plural(n, 'planilha no projeto', 'planilhas no projeto') : 'nenhuma planilha encontrada'}</span>`, `<span>${ic('desktop')}neste computador</span>`, `<span>${ask_}</span>`];
			return `<div class="ss-foot">${parts.join('')}</div>`;
		}
		const file = fileInfo();
		const ncols = gridColumns().length || profileColumns().length;
		const rowsText = basis() === 'clean' ? `${nf(rowsNow())} linhas · visão limpa · ${plural(steps().length, 'passo', 'passos')}` : `${nf(rowsNow())} linhas · ${plural(ncols, 'coluna', 'colunas')}`;
		const intact = file.intact === false ? `${ic('warning', 'c-you')}o original mudou no disco` : `${ic('lock')}original sem alterações`;
		const parts = [`<span class="f">${ic('file')}<span class="t">${esc(file.name || basename(file.path))} · ${esc(sheetInfo().name || '')}</span></span>`, `<span>${rowsText}</span>`, `<span>${intact}</span>`];
		if (!tight()) { parts.push(`<span>${ic('desktop')}neste computador</span>`); }
		parts.push(`<span>${ask_}</span>`);
		return `<div class="ss-foot">${parts.join('')}</div>`;
	}

	function render() {
		if (render.queued) { return; }
		render.queued = true;
		requestAnimationFrame(() => {
			render.queued = false;
			draw();
		});
	}

	function draw() {
		const root = document.getElementById('ss-root') || (() => {
			const el = document.createElement('div');
			el.id = 'ss-root';
			document.body.appendChild(el);
			return el;
		})();
		const scrolls = {};
		root.querySelectorAll('[data-scroll]').forEach(el => { scrolls[el.dataset.scroll] = [el.scrollTop, el.scrollLeft]; });
		const active = document.activeElement;
		const focus = active && active.dataset && active.dataset.draft ? { key: active.dataset.draft, start: active.selectionStart, end: active.selectionEnd } : null;
		SLOTS = [];
		let body;
		if (importing() && !['settings', 'history'].includes(S.view)) {
			body = importingView();
		} else if (S.view === 'files') {
			body = firstView(true);
		} else if (!isOpen() && !VIEWS[S.view]?.offline) {
			body = firstView(false);
		} else {
			body = ({ sheet: sheetView, charts: chartsView, panel: panelView, cleanup: cleanupView, history: historyView, profile: profileView, settings: settingsView })[S.view]();
		}
		root.innerHTML = `<div class="ss-studio">${toolbar()}<div class="ss-body">${body}</div>${footer()}${menu()}${exportDialog()}${S.note ? `<div class="ss-toast">${ic('info', 'c-run')}${esc(S.note)}</div>` : ''}</div>`;
		root.querySelectorAll('[data-scroll]').forEach(el => {
			const value = scrolls[el.dataset.scroll];
			if (value) { el.scrollTop = value[0]; el.scrollLeft = value[1]; }
		});
		if (focus) {
			const el = root.querySelector(`[data-draft="${CSS.escape(focus.key)}"]`);
			if (el) {
				el.focus();
				try { el.setSelectionRange(focus.start, focus.end); } catch { /* not a text field */ }
			}
		}
		// A narrow toolbar first shortens "Abrir arquivo" to its icon, then hides the line count, the view icons and the
		// status words; only then the file name is cut.
		const bar = root.querySelector('.ss-bar');
		if (bar) {
			const crumb = bar.querySelector('.ss-crumb');
			const name = crumb?.querySelector('b');
			if (crumb) { crumb.style.flex = 'none'; name.style.maxWidth = '300px'; }
			// The last button's right edge, not scrollWidth: a fraction of a pixel too much already cuts the file name.
			const over = () => bar.lastElementChild.getBoundingClientRect().right > bar.getBoundingClientRect().right - 10 + 0.25;
			for (const level of ['c1', 'c2', 'c3', 'c4']) {
				if (over()) { bar.classList.add(level); }
			}
			if (crumb) { crumb.style.flex = ''; name.style.maxWidth = ''; }
		}
		fitGrids(root);
		root.querySelectorAll('.ss-slot').forEach(el => {
			const fn = SLOTS[Number(el.dataset.slot)];
			const w = Math.floor(el.clientWidth), h = Math.floor(el.clientHeight);
			if (fn && w > 8 && h > 8) {
				try { el.innerHTML = fn(w, h); } catch (error) { el.innerHTML = emptySvg(w, h, 'Não foi possível desenhar este gráfico'); }
			}
		});
	}

	/** The sheet grid fills its box: columns grow up to 1,6× their natural width or shrink to a minimum; wider sheets scroll. */
	function fitGrids(root) {
		root.querySelectorAll('table.ss-grid[data-fit]').forEach(table => {
			const wrap = table.parentElement;
			const cols = [...table.querySelectorAll('col')];
			const natural = cols.map(c => Number(c.dataset.w) || 60);
			const fixed = natural[0];
			const avail = wrap.clientWidth - fixed - 1;
			const want = natural.slice(1);
			const total = want.reduce((a, b) => a + b, 0);
			let widths;
			if (total <= avail) {
				const grow = Math.min(1.6, avail / Math.max(1, total));
				widths = want.map(w => Math.floor(w * grow));
			} else {
				// Texts and categories give way first (their cells end with …); dates and numbers keep their width.
				const flex = cols.slice(1).map(c => c.dataset.flex === '1');
				const mins = want.map((w, i) => Math.min(w, flex[i] ? 64 : 52));
				const firm = want.reduce((a, w, i) => a + (flex[i] ? 0 : w), 0);
				const flexWant = want.reduce((a, w, i) => a + (flex[i] ? w : 0), 0);
				const flexMin = mins.reduce((a, w, i) => a + (flex[i] ? w : 0), 0);
				if (firm + flexMin <= avail) {
					const k = (avail - firm - flexMin) / Math.max(1, flexWant - flexMin);
					widths = want.map((w, i) => flex[i] ? Math.floor(mins[i] + (w - mins[i]) * Math.min(1, k)) : w);
				} else {
					const minTotal = mins.reduce((a, b) => a + b, 0);
					if (minTotal > avail) {
						widths = mins;
						wrap.classList.add('wide');
					} else {
						const k = (avail - minTotal) / Math.max(1, total - minTotal);
						widths = want.map((w, i) => Math.floor(mins[i] + (w - mins[i]) * k));
					}
				}
			}
			cols.forEach((col, i) => { col.style.width = `${i ? widths[i - 1] : fixed}px`; });
			table.style.width = `${fixed + widths.reduce((a, b) => a + b, 0)}px`;
		});
	}

	// ------------------------------------------------------------------ first open, files and importing

	function fileFormat(path) {
		const ext = extension(path);
		return FORMATS[ext] || [ext.toUpperCase() || 'ARQUIVO', 'planilha'];
	}

	function fileRows(list, selected) {
		const groups = new Map();
		for (const f of list) {
			const folder = dirname(f.path);
			if (!groups.has(folder)) { groups.set(folder, []); }
			groups.get(folder).push(f);
		}
		const open = isOpen() ? fileInfo().path : null;
		const loading = importing() ? S.sheet.progress?.path : null;
		let html = '';
		for (const [folder, files] of groups) {
			if (folder) { html += `<div class="ss-folder">${ic('folderOpen')}<b>${esc(folder)}/</b></div>`; }
			for (const f of files) {
				const [fmt, what] = fileFormat(f.path);
				const sheetish = ['xlsx', 'xlsm', 'xls', 'ods'].includes(extension(f.path));
				const state = f.path === open ? pill('aberto', 'ok') : f.path === loading ? pill('abrindo', 'run') : '';
				const kind = sheetish ? what : fmt;
				html += `<div class="ss-file ${f.path === selected ? 'sel' : ''}" data-act="file" data-path="${esc(f.path)}" ${folder ? '' : 'style="padding-left:10px"'} title="${esc(f.path)}">${sheetish ? MARK : ic('file')}<span class="nm">${esc(basename(f.path))}</span><small>${esc(kind)}${f.modified ? ` · modificado ${esc(when(f.modified))}` : ''}</small>${state}<em>${esc(bytes(f.bytes || 0))}</em></div>`;
			}
		}
		return html;
	}

	function firstView(filesMode) {
		const list = found();
		const open = isOpen();
		if (!S.fileSel || !list.some(f => f.path === S.fileSel)) {
			S.fileSel = (open && list.find(f => f.path === fileInfo().path)?.path) || (list.find(f => ['xlsx', 'xls', 'ods', 'xlsm'].includes(extension(f.path))) || list[0])?.path || null;
		}
		const source = S.ctx?.source;
		const noProject = S.ctx && !S.ctx.project && !source;
		const filesBody = list.length
			? fileRows(list, S.fileSel) + `<div class="ss-li" style="padding:6px 10px;color:#A8A8A8;white-space:normal;line-height:1.4">${ic('info', 'c-dim')}<span class="tx">Procurei .csv, .tsv, .xlsx, .xls e .ods${source ? ` em ${esc(source)}/` : ' na pasta do projeto'}, fora de node_modules e das pastas ocultas.</span></div>`
			: `<div class="ss-empty">${noProject ? 'Este Studio não está ligado a um projeto. Abra o SheetStudio a partir do chat de um projeto para ler as planilhas dele.' : 'Ainda não procurei, ou não há planilhas na pasta do projeto. Coloque o arquivo na pasta e peça para procurar de novo.'}</div>`;
		const fmt = [['CSV', 'separador , ; tab ou |'], ['TSV', 'separado por tab'], ['XLSX', 'Excel 2007 em diante, com abas'], ['XLS', 'Excel antigo'], ['ODS', 'LibreOffice Calc']]
			.map(([f, d]) => `<div class="ss-li line"><span class="ss-pill fmt">${f}</span>${tx(d)}</div>`).join('');
		const how = [['Abro o arquivo só para leitura', 'reconheço abas e tipos'], ['Você pergunta na conversa', 'em português, como falaria'], ['O agente calcula e o gráfico aparece aqui', 'com colunas, filtros e linhas'], ['Limpezas viram passos', 'dá para desfazer cada um'], ['Exportar cria arquivos novos', 'o original continua igual']]
			.map(([t, d], i) => `<div class="ss-li line" style="min-height:26px"><span class="ss-num">${i + 1}</span>${tx(t)}${narrow() ? '' : `<em>${d}</em>`}</div>`).join('');
		const examples = ['qual serviço mais fatura?', 'faça um gráfico do faturamento por mês', 'quais são os horários de pico?', 'compara os três barbeiros', 'tem algo errado nos dados?', 'monte um painel com o principal']
			.map(q => `<button class="ss-example" data-act="example" data-text="${esc(q)}">${ic('comment', 'c-dim')}<span>${esc(q)}</span></button>`).join('');
		const selected = list.find(f => f.path === S.fileSel);
		const main = selected && open && selected.path === fileInfo().path
			? btn('Esta planilha já está aberta', 'check', 'dis', 'disabled')
			: selected
				? btn(`Abrir ${esc(basename(selected.path))}`, 'folderOpen', 'primary', `data-act="file-open" data-path="${esc(selected.path)}"`)
				: btn('Procurar planilhas', 'search', 'primary', 'data-act="files-find"');
		const hero = filesMode && open
			? `<div class="ss-hero">${MARK}<div><h1>Planilhas do projeto</h1><p>Aberta agora: <span class="ss-m">${esc(fileInfo().path)}</span>, aba ${esc(sheetInfo().name || '')}. Escolha outra para o agente abrir; a atual continua com os gráficos e os passos.</p></div></div>`
			: `<div class="ss-hero">${MARK}<div><h1>Planilhas e gráficos neste computador</h1><p>O SheetStudio abre CSV e Excel da pasta do projeto. Você pergunta na conversa e o agente calcula: o gráfico aparece aqui, junto com o que foi usado no cálculo. O arquivo original nunca é alterado.</p></div></div>`;
		const right = `<div class="ss-col" style="flex:1">
				${panel('Como funciona', how, { icon: 'listOrdered', pb: 'fit', style: 'flex:none' })}
				${panel('Exemplos de perguntas', examples, { icon: 'comments', style: 'flex:1 1 auto;min-height:150px', foot: `<span class="ss-dim">Clique: a pergunta vai para a caixa da conversa, para você completar.</span>` })}
				${note('lock', 'c-dim', '<b>Neste computador.</b> Nada é enviado para a internet. Arquivos com senha não são abertos, e o agente não pede senha na conversa.')}
			</div>`;
		const failure = S.sheet?.status === 'error' ? (S.sheet.error && typeof S.sheet.error === 'object' ? S.sheet.error : {}) : null;
		const why = failure && ({
			encrypted: 'ela tem senha para abrir. Salve uma cópia sem senha no Excel e peça de novo; o agente nunca pede a senha',
			unsupported: 'o formato não é uma planilha que o SheetStudio lê (CSV, TSV, XLSX, XLS ou ODS)',
			corrupt: 'o arquivo está danificado ou incompleto',
			empty: 'o arquivo está vazio',
			not_found: 'o arquivo não foi encontrado no projeto',
		})[failure.kind];
		const failed = failure ? note('error', 'c-bad', `<b>${failure.path ? `${esc(failure.path)} não abriu` : 'A última planilha não abriu'}</b>${why ? `: ${why}.` : '. O motivo está na conversa; escolha outra ou peça ao agente para tentar com outras opções.'}`) : '';
		return `<div class="ss-first" data-scroll="first">${hero}${failed}
			<div class="ss-row top" style="gap:12px;flex:1 0 auto">
				<div class="ss-col" style="flex:1.45">
					${panel('Arquivos de dados no projeto', filesBody, { icon: 'folder', right: `<em>${list.length ? plural(list.length, 'arquivo', 'arquivos') : ''}</em>${btn('', 'refresh', 'sm ib', 'data-act="files-find" title="Procurar de novo"')}`, pb: 'np', style: 'flex:1 1 auto;min-height:150px' })}
					${panel('Formatos que abro', fmt, { icon: 'file', pb: 'fit', style: 'flex:none' })}
				</div>
				${right}
			</div>
			<div class="ss-row ss-foot-row"><span class="ss-dim">${ic('comments', 'c-dim')} Os botões do Studio viram pedidos ao agente na conversa.</span><span class="ss-sp"></span>${main}</div>
		</div>`;
	}

	function importingView() {
		const p = obj(S.sheet.progress) || {};
		const total = num(p.total);
		const rows = num(p.rows) || 0;
		const share = total ? Math.min(1, rows / total) : null;
		const left = share && share > 0.02 && num(p.seconds) ? (p.seconds / share) - p.seconds : null;
		const info = kv([
			['Arquivo', m(p.path || '')],
			['Formato', `${esc(fileFormat(p.path)[0])} · ${esc(fileFormat(p.path)[1])}`],
			['Linhas lidas', total ? `${nf(rows)} de ${nf(total)}` : nf(rows)],
			['Tempo', num(p.seconds) !== null ? secs(p.seconds) : '—'],
			['Falta', left !== null ? `cerca de ${secs(left)}` : dim('calculando')],
		], 96);
		const progress = `<div style="display:grid;gap:10px">
			<div><div class="ss-row" style="margin-bottom:4px">${ic('spinner', 'spin c-run')}<span>Lendo as linhas${total ? `: ${nf(rows)} de ${nf(total)}` : `: ${nf(rows)}`}</span><span class="ss-sp"></span><span class="ss-dim">${share !== null ? `${nf(share * 100, 0)}%` : ''}</span></div><div class="ss-prog"><i style="width:${share !== null ? Math.round(share * 100) : 30}%"></i></div></div>
			${li(ic('ring', 'c-dim'), 'Reconhecer o tipo de cada coluna, em todas as linhas')}
			${li(ic('ring', 'c-dim'), 'Mostrar a planilha aqui')}
		</div>`;
		const list = found();
		return `<div class="ss-main"><div class="ss-row top ss-grow ss-pad">
			<div class="ss-col" style="flex:0 0 ${tight() ? 300 : 330}px">
				${panel(`Abrindo ${esc(basename(p.path) || 'a planilha')}`, info, { icon: 'file', pb: 'fit', style: 'flex:none' })}
				${panel('Progresso', progress, { icon: 'pulse', mk: 'run', pb: 'fit', style: 'flex:none' })}
				${note('info', 'c-dim', 'O arquivo é só lido. As linhas vão para uma cópia de trabalho neste computador; o original não muda. Arquivos muito grandes levam alguns segundos por milhão de linhas.', 'fill')}
			</div>
			<div class="ss-col ss-grow">
				${panel('Planilhas do projeto', list.length ? fileRows(list, p.path) : '<div class="ss-empty">Nenhuma outra planilha encontrada.</div>', { icon: 'folder', pb: 'np', style: 'flex:0 1 auto;min-height:80px' })}
				${panel('Quando abrir, pergunte por exemplo', ['tem algo errado nos dados?', 'quantas linhas tem cada mês?', 'quais colunas tem e de que tipo?', 'monte um painel com o principal'].map(q => `<button class="ss-example" data-act="example" data-text="${esc(q)}">${ic('comment', 'c-dim')}<span>${esc(q)}</span></button>`).join(''), { icon: 'comments', style: 'flex:1 1 auto;min-height:80px', foot: '<span class="ss-dim">Clique: a pergunta vai para a caixa da conversa.</span>' })}
				<div class="ss-hint">${ic('stop', 'c-dim')}<span>Parar interrompe a leitura pelo agente. Nada muda no arquivo; dá para abrir de novo depois.</span></div>
			</div>
		</div></div>`;
	}

	// ------------------------------------------------------------------ the sheet (Planilha)

	/** A stored value as the grid shows it: dates dd/mm/aaaa, money 1.234,56, 12,5%. */
	function cellText(value, type) {
		if (value === null || value === undefined || value === '') { return ''; }
		switch (type) {
			case 'date': return isoDate(value);
			case 'datetime': return `${isoDate(value)} ${String(value).slice(11, 16)}`;
			case 'time': return String(value).slice(0, 5);
			case 'currency': return typeof value === 'number' ? nf(value, 2) : String(value);
			case 'percent': return typeof value === 'number' ? `${nf(value * 100, decimals(Math.round(value * 1000) / 10))}%` : String(value);
			case 'integer': return typeof value === 'number' ? nf(value, 0) : String(value);
			case 'number': return typeof value === 'number' ? nf(value, Math.min(4, decimals(value) === 2 ? (Math.abs(value * 100 - Math.round(value * 100)) < 1e-9 ? 2 : 4) : decimals(value))) : String(value);
			case 'bool': return value === 1 || value === true ? 'sim' : value === 0 || value === false ? 'não' : String(value);
			default: return String(value);
		}
	}
	/** Min and max of a profile in the column's own format (texts have none). */
	function profileValue(value, type) {
		if (value === null || value === undefined) { return '<span class="ss-dim">—</span>'; }
		if (!NUMERIC.includes(type) && !['date', 'datetime', 'time'].includes(type)) { return '<span class="ss-dim">—</span>'; }
		if (type === 'currency') { return esc(brl(value)); }
		return esc(cellText(value, type));
	}

	const NOTE_TEXT = {
		'text-date': (col, raw, shown) => `texto · lido como data ${shown} · o arquivo não muda`,
		'text-number': (col, raw, shown) => `texto · lido como número ${shown} · o arquivo não muda`,
		'text-time': (col, raw, shown) => `texto · lido como hora ${shown} · o arquivo não muda`,
		unparsed: col => `não é ${typeLabel(col.type)}: fica vazio nas contas`,
		error: (col, raw) => `erro de fórmula do Excel (${raw}): fica vazio nas contas`,
	};

	function naturalWidth(col, rows, index) {
		const base = { date: 84, datetime: 124, time: 54, currency: 78, number: 72, integer: 62, percent: 64, bool: 52 }[col.type];
		const head = Math.max(tw(col.name, 12) * 1.08, tw(typeLabel(col.type), 11) + 20) + 16;
		if (base) { return Math.round(Math.max(base, head)); }
		const sample = rows.slice(0, 60).map(r => String(r[index + 1] ?? ''));
		const longest = Math.max(0, ...sample.map(s => s.length));
		return Math.round(clamp(Math.max(head, longest * 6.4 + 16), 64, 190));
	}

	/** The grid like Excel shows it. o.rows: only these rows (no selection, no letters), for the Limpeza examples. */
	function gridTable(o = {}) {
		const g = S.grid || {};
		const cols = gridColumns();
		const rows = o.rows || arr(g.rows);
		const live = !o.rows;
		const notes = obj(g.notes) || {};
		const filtered = new Set(live || o.filters ? arr(g.filter).map(f => fold(filterColumn(f))) : []);
		const filterText = key => arr(g.filter).filter(f => fold(filterColumn(f)) === fold(cols.find(c => c.key === key)?.name)).map(f => f.slice(filterColumn(f).length).trim()).join(' e ');
		const hl = S.colSel || g.highlight;
		const cur = live ? currentCell() : null;
		const head = `<colgroup><col data-w="${rows.length && rows.at(-1)[0] >= 10000 ? 56 : 46}">${cols.map((c, i) => `<col data-w="${naturalWidth(c, rows, i)}" ${['text', 'category'].includes(c.type) ? 'data-flex="1"' : ''}>`).join('')}</colgroup>`;
		const cls = c => `${isCalc(c) ? 'nw' : ''} ${c.key === hl && !isCalc(c) ? 'hl' : ''}`;
		const letters = `<tr class="lt"><th class="rn"></th>${cols.map(c => `<th class="${cls(c)}">${esc(c.letter || '')}</th>`).join('')}</tr>`;
		const header = `<tr class="hd"><th class="rn">${esc(num(sheetInfo().header) || '')}</th>${cols.map(c => {
			const flt = filtered.has(fold(c.name));
			const sub = flt ? `${ic('filterOn')}${esc(filterText(c.key))}` : isCalc(c) ? `${typeIcon(c.type, true)}calculada` : `${typeIcon(c.type)}${esc(typeLabel(c.type))}`;
			return `<th class="${cls(c)} ${flt ? 'flt' : ''}" ${live ? `data-act="col" data-key="${esc(c.key)}"` : ''} title="${esc(c.name)}"><span class="nm">${esc(c.name)}</span><small>${sub}</small></th>`;
		}).join('')}</tr>`;
		const body = rows.map((r, ri) => {
			const rowNotes = obj(notes[String(r[0])]) || {};
			return `<tr><td class="rn">${nf(r[0])}</td>${cols.map((c, ci) => {
				const value = r[ci + 1];
				const nt = rowNotes[c.key];
				let klass = `${cls(c)} ${RIGHT.includes(c.type) ? 'r' : ''}`;
				let text = esc(cellText(value, c.type));
				if (Array.isArray(nt)) {
					if (nt[0] === 'error') { klass += ' err'; text = esc(nt[2] || nt[1]); } else if (nt[0] === 'unparsed') { klass += ' tx e'; text = esc(nt[2] || ''); } else { klass += ' tx'; }
				}
				if (cur && cur.row === r[0] && cur.key === c.key) { klass += ' cur'; }
				return `<td class="${klass}" ${live ? `data-act="cell" data-r="${ri}" data-c="${ci}"` : `title="${esc(Array.isArray(nt) ? `${nt[2] ?? ''} → ${cellText(value, c.type) || 'vazio'}` : '')}"`}>${text}</td>`;
			}).join('')}</tr>`;
		}).join('');
		const more = live && num(g.matched) !== null && g.matched > (num(g.offset) || 0) + rows.length
			? `<tr class="more"><td class="rn"></td><td colspan="${cols.length}">${ic('fold', 'c-dim')} mostrando ${nf((num(g.offset) || 0) + 1)}ª a ${nf((num(g.offset) || 0) + rows.length)}ª de ${nf(g.matched)} linhas · <span class="ss-link" data-act="more-rows">mostrar as próximas</span></td></tr>`
			: '';
		return `<table class="ss-grid ${live ? '' : 'noletters'}" data-fit="1">${head}<thead>${live ? letters : ''}${header}</thead><tbody>${body}${more}</tbody></table>`;
	}

	/** The selected cell, or the first cell with a note so the bar explains the corner marks. */
	function currentCell() {
		const rows = arr(S.grid?.rows);
		const notes = obj(S.grid?.notes) || {};
		if (S.cell && rows.some(r => r[0] === S.cell.row) && gridColumns().some(c => c.key === S.cell.key)) { return S.cell; }
		for (const r of rows.slice(0, 40)) {
			const n = obj(notes[String(r[0])]);
			if (n) {
				const key = Object.keys(n).find(k => gridColumns().some(c => c.key === k));
				if (key) { return { row: r[0], key }; }
			}
		}
		return rows.length && gridColumns().length ? { row: rows[0][0], key: gridColumns()[0].key } : null;
	}

	function fxBar() {
		const cur = currentCell();
		if (!cur) { return `<div class="ss-fx"><span class="cell">—</span><span class="fx">fx</span><span class="val"><span class="n">sem linhas para mostrar</span></span></div>`; }
		const cols = gridColumns();
		const index = cols.findIndex(c => c.key === cur.key);
		const col = cols[index];
		const row = arr(S.grid.rows).find(r => r[0] === cur.row) || [];
		const nt = (obj(S.grid.notes) || {})[String(cur.row)]?.[cur.key];
		const shown = cellText(row[index + 1], col.type);
		let value = esc(shown);
		let text = '';
		if (Array.isArray(nt)) {
			value = esc(nt[2] ?? '');
			const make = NOTE_TEXT[nt[0]];
			text = `${ic('warning', 'c-you')}${esc(make ? make(col, nt[2] ?? nt[1], shown) : nt[1])}`;
			const formula = nt[0] === 'error' ? arr(S.cleanup?.problems).flatMap(p => arr(p.examples)).find(e => e.row === cur.row && e.formula)?.formula : null;
			if (formula) { value = `<span class="ss-m">${esc(formula)}</span>`; }
		} else if (isCalc(col)) {
			text = `${ic('info', 'c-dim')}coluna calculada nesta visão · não existe no arquivo`;
		} else if (!shown) {
			text = 'vazia';
		}
		return `<div class="ss-fx"><span class="cell">${esc(col.letter || '')}${esc(cur.row)}</span><span class="fx">fx</span><span class="val"><span class="v">${value || '&nbsp;'}</span>${text ? `<span class="n">${text}</span>` : ''}</span></div>`;
	}

	function filterBar() {
		const g = S.grid || {};
		const filters = arr(g.filter);
		if (!filters.length) { return ''; }
		const chips = filters.map((f, i) => chip('filterOn', f, `<span class="x" data-act="filter-x" data-i="${i}" title="Tirar este filtro">${ic('close')}</span>`)).join('');
		return `<div class="ss-filters"><span class="ss-dim">Filtros</span>${chips}<span class="r"><span>${nf(g.matched)} de ${nf(g.total)} linhas</span>${btn('Limpar filtros', 'close', 'sm', 'data-act="filter-clear"')}</span></div>`;
	}

	function sheetTabs() {
		const g = S.grid || {};
		const tabs = arr(S.sheet?.sheets).map(s => {
			const on = s.id === sheetInfo().id;
			const extra = s.protected ? `${ic('lock')}` : '';
			const em = s.protected ? '<em>com senha</em>' : s.hidden ? '<em>oculta</em>' : '';
			return `<span class="tb ${on ? 'on' : ''}" ${on ? '' : `data-act="sheet-tab" data-name="${esc(s.name)}"`} title="${esc(s.name)}">${extra}<span class="t">${esc(s.name)}</span>${em}</span>`;
		}).join('');
		const rows = arr(g.rows);
		const shownMore = num(g.matched) !== null && g.matched > rows.length ? ` · ${nf(rows.length)} de ${nf(g.matched)}` : '';
		const range = rows.length ? `linhas ${nf(rows[0][0])} a ${nf(rows.at(-1)[0])}${shownMore}` : '';
		return `<div class="ss-sheets">${tabs}<span class="rt">${tight() ? '' : esc(range)}</span></div>`;
	}

	/** One line per column: letter, name, type and what stands out (texts read as numbers, empties, values). */
	function columnNote(c) {
		const notes = obj(c.notes) || {};
		const asText = (notes['text-date'] || 0) + (notes['text-number'] || 0) + (notes['text-time'] || 0);
		if (asText) { return `${ic('warning', 'c-you')}<span>${nf(asText)} em texto</span>`; }
		if (notes.error) { return `${ic('error', 'c-bad')}<span>${nf(notes.error)} com erro</span>`; }
		if (notes.unparsed) { return `${ic('warning', 'c-you')}<span>${nf(notes.unparsed)} ilegíveis</span>`; }
		if (c.type === 'time' && c.min && c.max) { return `<span>${esc(String(c.min).slice(0, 5))} a ${esc(String(c.max).slice(0, 5))}</span>`; }
		if (c.empty) { return `<span>${nf(c.empty)} vazios</span>`; }
		const few = arr(c.top).map(t => t[0]).join(', ');
		if (['category', 'bool'].includes(c.type) && arr(c.top).length && c.unique <= 3 && few.length <= 16) { return `<span>${esc(few)}</span>`; }
		return `<span>${nf(c.unique)} valores</span>`;
	}

	function sideTypes() {
		const cols = profileColumns().length ? profileColumns() : gridColumns();
		const sel = S.colSel || S.grid?.highlight;
		const rows = cols.map(c => `<div class="ss-ct ${c.key === sel ? 'sel' : ''}" data-act="col" data-key="${esc(c.key)}" title="${esc(c.name)} · ${esc(isCalc(c) ? 'calculada' : typeLabel(c.type))}"><span class="l">${esc(c.letter || '')}</span><b>${esc(c.name)}</b><span class="ty">${typeIcon(c.type, isCalc(c))}${narrow() ? '' : `<span>${esc(isCalc(c) ? 'calculada' : typeLabel(c.type))}</span>`}</span><em>${columnNote(c)}</em></div>`).join('');
		return panel('Tipos das colunas', rows + `<div class="ss-dim small" style="padding:6px 0 2px">Reconhecidos por todas as ${nf(rowsRaw())} linhas, não só pelas primeiras.</div>`, { icon: 'columns', pb: 'fit', style: 'flex:none' });
	}

	function sideSheets() {
		const sheets = arr(S.sheet?.sheets);
		if (!sheets.length) { return ''; }
		const pairs = sheets.map(s => [esc(s.name), s.protected ? `${ic('lock', 'c-dim')}com senha` : `${nf(s.rows)} × ${nf(s.cols)}${s.id === sheetInfo().id ? dim(' · aberta') : s.hidden ? dim(' · oculta') : ''}`]);
		return panel('Abas', kv(pairs, narrow() ? 96 : 116), { icon: 'columns', pb: 'fit', style: 'flex:none', sub: '· linhas × colunas' });
	}

	const WARNINGS = [
		[/^the first line 'sep=(.)' is an Excel hint and was skipped$/, mm => `a primeira linha sep=${mm[1]} é uma dica do Excel e foi pulada`],
		[/bytes are not valid UTF-8/, () => 'alguns bytes não eram UTF-8 válido e viraram �'],
		[/^the file is not valid/, () => 'a codificação escolhida não serve para todo o arquivo; alguns caracteres viraram �'],
		[/different number of fields/, () => 'algumas das primeiras linhas têm um número diferente de campos'],
		[/^sheet (.+) is protected \(editing only\)$/, mm => `a aba ${mm[1]} é protegida para edição (dá para ler)`],
		[/^merged cells (.+) in (.+)$/, mm => `células mescladas em ${mm[2]}: ${mm[1].replace(/ \(\+(\d+) more\)$/, ' e mais $1')}`],
		[/formula text is not available/, () => 'arquivos .xls não guardam o texto das fórmulas; vale o valor salvo'],
		[/workbook structure is protected/, () => 'a estrutura da pasta de trabalho é protegida (só edição)'],
		[/^(.+) is a chart sheet/, mm => `${mm[1]} é uma aba de gráfico, sem células`],
		[/shared string table/, () => 'a tabela de textos deste .xls está cortada; alguns textos podem vir vazios'],
		[/^the sheet (.+) is damaged/, mm => `a aba ${mm[1]} está danificada; só parte dela pode ser lida`],
		[/links to other files/, () => 'a planilha aponta para outros arquivos; valem os valores salvos nela'],
		[/has macros/, () => 'a planilha tem macros; elas não são executadas'],
		[/^the sheet (.+) has no data/, mm => `a aba ${mm[1]} não tem dados no arquivo`],
		[/^only the first (\d+) formulas of (.+) were read$/, mm => `só as primeiras ${mm[1]} fórmulas de ${mm[2]} foram lidas`],
		[/^(\d+) rows have more cells than the header/, mm => `${mm[1]} linhas têm mais células que o cabeçalho; as sobras ficaram de fora`],
		[/^only the first (\d+) cell notes were kept$/, mm => `só as primeiras ${mm[1]} marcas de células foram guardadas`],
	];
	/** The reader's warnings are in English in the files; the known ones are said in Portuguese. */
	function warningText(text) {
		for (const [pattern, make] of WARNINGS) {
			const match = pattern.exec(String(text));
			if (match) { return make(match); }
		}
		return 'um aviso da leitura (pergunte ao agente)';
	}

	function sideFile() {
		const f = fileInfo();
		const meta = obj(f.meta) || {};
		const [fmt, what] = fileFormat(f.path);
		const pairs = [
			['Formato', `${esc(fmt)} · ${esc(what)}`],
			meta.separator ? ['Separador', esc(SEPARATORS[meta.separator] || meta.separator)] : null,
			meta.encoding ? ['Codificação', esc(String(meta.encoding).replace(/^cp1252$/, 'Windows-1252').replace(/^utf-8-sig$/, 'UTF-8 com BOM').replace(/^utf-8$/, 'UTF-8').replace(/^utf-16/, 'UTF-16'))] : null,
			['Tamanho', esc(bytes(f.bytes || 0))],
			f.modified ? ['Modificado', esc(when(f.modified))] : null,
			['Original', f.intact === false ? `${ic('warning', 'c-you')}mudou no disco` : f.intact ? `${ic('passed', 'c-ok')}intacto` : 'só leitura'],
			f.sha256 ? ['Conteúdo', `<span class="ss-m">sha256 ${esc(String(f.sha256).slice(0, 4))}…${esc(String(f.sha256).slice(-4))}</span>`] : null,
			num(sheetInfo().formulas) ? ['Fórmulas', `${nf(sheetInfo().formulas)} · vale o valor salvo`] : null,
		];
		const warnings = arr(meta.warnings).concat(arr(sheetInfo().warnings)).map(w => li(ic('warning', 'c-you'), esc(warningText(w)), '', 'multi')).join('');
		const editor = ['csv', 'tsv', 'txt'].includes(extension(f.path)) ? `<div style="margin-top:6px">${btn('Ver o arquivo como texto', 'file', 'sm', `data-act="open-editor" data-path="${esc(f.path)}"`)}</div>` : '';
		return panel('Arquivo', kv(pairs, 92) + warnings + editor, { icon: 'file', pb: 'fit', style: 'flex:none' });
	}

	const ENCODINGS = [['utf-8', 'UTF-8'], ['cp1252', 'Windows-1252'], ['utf-16', 'UTF-16'], ['latin-1', 'Latin-1']];
	const CSV_SEPARATORS = [[';', '; ponto e vírgula'], [',', ', vírgula'], ['\t', 'tab'], ['|', '| barra']];
	/** How the open CSV was read; the file is read again with other options through the agent (open with options). */
	function csvReading() {
		const f = fileInfo();
		const meta = obj(f.meta) || {};
		const encoding = String(meta.encoding || 'utf-8').replace(/^utf-8-sig$/, 'utf-8').replace(/^utf-16.*$/, 'utf-16');
		return { separator: meta.separator || ';', encoding, decimal: String(settings().decimal || 'auto'), header: (num(sheetInfo().header) || 0) > 0 };
	}
	const csvChanged = () => { const now = csvReading(); return Object.keys(S.csvDraft).filter(k => String(S.csvDraft[k]) !== String(now[k])); };

	function sideCsv() {
		if (!['csv', 'tsv', 'txt'].includes(extension(fileInfo().path))) { return ''; }
		const now = csvReading();
		const value = key => S.csvDraft[key] !== undefined ? S.csvDraft[key] : now[key];
		const select = (key, options) => {
			const list = options.some(([v]) => v === String(value(key))) ? options : [[String(value(key)), String(value(key))]].concat(options);
			return `<select class="ss-in ${String(value(key)) !== String(now[key]) ? 'changed' : ''}" data-act="csv-opt" data-key="${key}" style="width:100%">${list.map(([v, l]) => `<option value="${esc(v)}" ${v === String(value(key)) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
		};
		const row = (label, control) => `<div class="ss-set" style="grid-template-columns:78px minmax(0,1fr);column-gap:8px;padding:3px 0"><span class="k">${label}</span><div>${control}</div></div>`;
		const changed = csvChanged().length;
		const body = row('Separador', select('separator', CSV_SEPARATORS)) + row('Codificação', select('encoding', ENCODINGS)) + row('Decimal', select('decimal', SET_OPTIONS.decimal.map(([v, l]) => [String(v), l])))
			+ row('Cabeçalho', `<label class="ss-check"><input type="checkbox" data-act="csv-header" ${value('header') ? 'checked' : ''}>a linha 1 tem os nomes</label>`)
			+ `<div style="margin-top:6px">${btn('Reabrir com estas opções', 'refresh', `sm ${changed ? 'primary' : 'dis'}`, changed ? 'data-act="csv-reopen"' : 'disabled')}</div>`;
		return panel('Leitura do CSV', body, { icon: 'gear', pb: 'fit', style: 'flex:none', right: changed ? '' : `<em>${ic('passed', 'c-ok')} detectado</em>` });
	}

	/** The calculated column the agent pointed at: what it is, its most common values and a chart that uses it. */
	function columnPanel(col) {
		const step = steps().find(s => s.kind === 'column' && String(s.text || '').endsWith(col.name));
		const profile = profileColumns().find(c => c.key === col.key) || col;
		const isLast = step && steps().at(-1)?.id === step.id;
		const values = arr(profile.top).map(t => t[0]).join(', ');
		const body = `<div class="ss-q" style="padding-bottom:2px"><span class="c">-- coluna nova, só nesta visão${step ? ` (passo ${esc(step.id)})` : ''}</span></div><div class="ss-qkv" style="padding-top:2px"><span class="kw">${esc(col.name)}</span><span>${esc(typeLabel(col.type))}, coluna ${esc(col.letter || '')}</span>${values ? `<span class="kw">valores</span><span>${esc(values)}</span>` : ''}<span class="kw">linhas</span><span>${esc(nf(num(step?.rows) ?? rowsNow()))} calculadas</span></div><div class="ss-dim small" style="padding:6px 12px">Fica na visão limpa, como coluna ${esc(col.letter || '')}. O arquivo original continua sem ela; para levar a um arquivo, use Exportar.</div>`;
		const left = panel(`Coluna nova · ${esc(col.name)}`, body, { icon: 'edit', mk: 'ok', pb: 'np', style: `flex:0 0 ${tight() ? 280 : 330}px`, right: step ? btn('Remover', 'trash', 'sm', `data-act="undo" data-step="${esc(step.id)}" data-last="${isLast ? 1 : 0}"`) : '' });
		const uses = S.charts.find(c => c.x?.column === col.name && c.kind !== 'query' && scopeOf(c) === 'here');
		let right;
		if (uses) {
			right = `<div class="ss-panel flat" style="flex:1"><div class="ss-ph click" data-act="chart-open" data-id="${esc(uses.id)}">${ic(KINDS[uses.kind]?.icon || 'graph')}<span class="t">${esc(uses.title)}</span><em>· ${esc(arr(uses.calc?.filter).join(' e ') || 'todas as linhas')}</em></div><div class="ss-col ss-grow" style="padding:4px 10px 2px">${slot((w, h) => chartSvg(uses, w, h, 'mini'))}</div></div>`;
		} else if (arr(profile.top).length) {
			const fake = { id: '', kind: 'hbar', labels: profile.top.map(t => String(t[0])), series: [{ name: 'linhas', values: profile.top.map(t => t[1]) }], unit: 'count', y: { agg: 'count' } };
			right = `<div class="ss-panel flat" style="flex:1"><div class="ss-ph">${ic('hbar')}<span class="t">${esc(col.name)} · valores mais comuns</span></div><div class="ss-col ss-grow" style="padding:6px 10px 2px">${slot((w, h) => hbars(fake, w, h, 'mini'))}</div></div>`;
		} else {
			right = '';
		}
		return `<div class="ss-row top" style="flex:0 0 200px;gap:10px;padding:10px 10px 0">${left}${right}</div>`;
	}

	function sheetView() {
		const col = colByKey(S.colSel) || colByKey(S.grid?.highlight);
		const calcPanel = col && isCalc(col) && S.colSel === col.key ? columnPanel(col) : '';
		const side = `<div class="ss-col ss-scroll" data-scroll="sheet-side" style="flex:0 0 ${tight() ? 220 : narrow() ? 238 : 270}px;border-left:1px solid #3F3F46;padding:8px;gap:8px;background:#252526">${sideTypes()}${sideSheets()}${sideFile()}${sideCsv()}${note('info', 'c-dim', 'A marca <span style="display:inline-block;width:0;height:0;border-top:7px solid #C2508F;border-right:7px solid transparent;vertical-align:1px"></span> no canto indica número ou data escritos como texto: o SheetStudio lê o valor certo e o arquivo não muda.')}</div>`;
		const grid = gridColumns().length
			? `<div class="ss-gridwrap" data-scroll="grid">${gridTable()}</div>`
			: '<div class="ss-gridwrap"><div class="ss-empty">A aba não tem linhas para mostrar.</div></div>';
		return `<div class="ss-main">${calcPanel}${calcPanel ? '<div style="height:10px;flex:none"></div>' : ''}${fxBar()}${filterBar()}<div class="ss-row top ss-grow" style="gap:0"><div class="ss-col ss-grow" style="gap:0">${grid}${sheetTabs()}</div>${side}</div></div>`;
	}

	// ------------------------------------------------------------------ charts (Gráficos)

	function chartTree() {
		const items = S.charts.map(c => {
			const st = chartState(c);
			const mark = st?.[2] ? `<em title="${esc(st[0])}">${ic('history', 'c-you')}</em>` : scopeOf(c) !== 'here' ? `<em title="${esc(st?.[0] || '')}">${ic('file', 'c-dim')}</em>` : '';
			return `<div class="ss-tr ${c.id === selectedChart()?.id ? 'sel' : ''}" data-act="chart" data-id="${esc(c.id)}" title="${esc(c.title)}">${ic(KINDS[c.kind]?.icon || 'graph')}<span class="nm">${esc(c.title)}</span>${mark}</div>`;
		}).join('');
		const f = fileInfo();
		const info = isOpen() ? `<div class="ss-tinfo"><div class="nm">${MARK}<span>${esc(f.name || basename(f.path))}</span></div><div class="ss-dim">aba ${esc(sheetInfo().name || '')} · ${nf(rowsNow())} linhas</div>${period() ? `<div class="ss-dim">${esc(period())}</div>` : ''}<div class="ss-dim">${ic('lock', 'c-dim')} aberto só para leitura</div></div>` : '';
		return `<div class="ss-tree"><div class="ss-th">${ic('graph')}Nesta conversa<em>${S.charts.length}</em></div><div class="ss-tlist" data-scroll="chart-list">${items || '<div class="ss-empty">Nenhum gráfico ainda.</div>'}</div><div class="ss-th">${ic('file')}Arquivo</div>${info}<div class="ss-tfoot">Peça um gráfico na conversa. Ele aparece aqui com o que foi usado no cálculo.</div></div>`;
	}

	/** Questions that fit the open sheet's columns, to put in the chat box. */
	function suggestions() {
		const cols = profileColumns();
		const date = cols.find(c => c.type === 'date' || c.type === 'datetime');
		const money = cols.find(c => c.type === 'currency') || cols.find(c => NUMERIC.includes(c.type));
		const cat = cols.find(c => c.type === 'category');
		const out = [];
		if (date && money) { out.push(`Faça um gráfico de barras da soma de ${money.name} por mês de ${date.name}`); }
		if (cat && money) { out.push(`Qual ${cat.name} tem a maior soma de ${money.name}?`); }
		if (cat) { out.push(`Quantas linhas tem cada ${cat.name}?`); }
		if (date) { out.push(`Em que dia da semana há mais movimento, pela coluna ${date.name}?`); }
		out.push('Tem algo errado nos dados?');
		return out.slice(0, 5);
	}

	function chartsView() {
		const c = selectedChart();
		if (!c) {
			const asks = suggestions().map(q => `<button class="ss-example" data-act="example" data-text="${esc(q)}">${ic('comment', 'c-dim')}<span>${esc(q)}</span></button>`).join('');
			return `${chartTree()}<div class="ss-main"><div class="ss-col ss-grow ss-pad">${panel('Nenhum gráfico ainda', `<div class="ss-text" style="margin-bottom:8px">Peça na conversa e o agente faz o gráfico com os dados de ${esc(sheetInfo().name || 'aba aberta')}. Ele aparece aqui, com o filtro, as colunas e as linhas usadas.</div>${asks}`, { icon: 'graph', style: 'flex:none;max-width:640px', foot: `<span class="ss-dim">Clique numa pergunta para colocá-la na caixa da conversa.</span>` })}</div></div>`;
		}
		return `${chartTree()}<div class="ss-main"><div class="ss-col ss-grow ss-pad" data-scroll="chart-main">${chartDetail(c)}</div></div>`;
	}

	function chartSub(c) {
		const parts = [];
		const filter = arr(c.calc?.filter);
		parts.push(filter.length ? filter.join(' e ') : 'todas as linhas');
		if (['month', 'day', 'week', 'quarter', 'year'].includes(c.x?.by) && c.labels?.length > 1) { parts.push(`${c.labels[0]} a ${c.labels.at(-1)}`); }
		if (c.calc?.basis === 'clean') { parts.push('visão limpa'); }
		return `· ${esc(parts.join(' · '))}`;
	}

	function staleStrip(c) {
		const st = chartState(c);
		if (!st?.[2]) { return ''; }
		const later = steps().filter(s => num(s.at) !== null && s.at > (num(c.created) || 0)).length;
		const why = st[0] === 'antes da limpeza'
			? `Feito antes da limpeza${later ? `: ${plural(later, 'passo veio', 'passos vieram')} depois` : ''}. Os números podem ter mudado.`
			: 'Feito com outra versão da visão limpa (algum passo foi desfeito ou refeito).';
		return `<div class="ss-strip mk mk-you">${pill(st[0], 'you')}<span class="tx" style="flex:1 1 200px;min-width:0">${esc(why)}</span>${btn('Refazer com a visão limpa', 'refresh', 'sm primary', `data-act="redo" data-id="${esc(c.id)}"`)}</div>`;
	}

	/** What the chart was calculated with, under it. */
	function calcStrip(c) {
		const chips = [];
		if (c.kind === 'query') {
			chips.push(chip('database', 'consulta SQL de leitura'));
		} else {
			chips.push(chip('sum', c.y?.column ? `${AGG[c.y.agg] || c.y.agg} de ${c.y.column}` : 'contagem de linhas'));
			for (const f of arr(c.calc?.filter)) { chips.push(chip('filter', f)); }
			const by = c.kind === 'pivot' ? `${c.x?.column || ''} × ${c.group?.column || ''}` : `por ${byText(c.x?.by, c.x?.column)}${c.group ? ` e ${byText(c.group.by, c.group.column)}` : ''}`;
			if (c.x?.column) { chips.push(chip(['month', 'day', 'week', 'quarter', 'year', 'weekday'].includes(c.x?.by) ? 'calendar' : c.x?.by === 'hour' ? 'clock' : 'tag', by)); }
		}
		chips.push(chip('list', `${nf(c.calc?.rowsUsed)} de ${nf(c.calc?.rowsTotal)} linhas`));
		return `<div class="ss-calc">${narrow() ? '' : '<span class="lb">Calculado com</span>'}${chips.join('')}<span class="r">${btn(S.showCalc ? 'Ver os números' : 'Ver o cálculo', S.showCalc ? 'table' : 'eye', 'sm', 'data-act="calc-toggle"')}</span></div>`;
	}

	function kindSelect(c) {
		if (!KINDS[c.kind] || ['pivot', 'query'].includes(c.kind)) { return ''; }
		const options = [...(c.series.length > 1 ? MULTI_KINDS : SINGLE_KINDS)];
		if (!options.includes(c.kind)) { options.unshift(c.kind); }
		return `<select class="ss-in" data-act="kind" data-id="${esc(c.id)}" style="height:21px;width:${tight() ? 108 : 132}px" title="Pedir o gráfico em outro formato">${options.map(k => `<option value="${k}" ${k === c.kind ? 'selected' : ''}>${esc(KINDS[k].label)}</option>`).join('')}</select>`;
	}

	/** The chart's numbers as a table: series in rows and labels in columns, or the other way when there are many labels. */
	function numbersTable(c) {
		const unit = c.unit;
		const add = additive(c);
		const n = c.labels.length, k = c.series.length;
		const avail = window.innerWidth - (tight() ? 168 : narrow() ? 184 : 200) - 24;
		const widest = Math.max(...c.series.flatMap(s => s.values.map(v => twNum(plain(v, unit).replace(/<[^>]+>/g, '')))), ...c.labels.map(l => tw(l, 11.5) * 1.05)) + 12;
		const nameW = clamp(Math.max(...c.series.map(s => tw(s.name, 11.5))) + (k > 1 ? 30 : 14), 70, 130);
		const totalW = add ? Math.ceil(twNum(plain(sumOf(c.series.flatMap(s => s.values)), unit)) * 1.1) + 14 : 0;
		const fitsTotal = nameW + n * widest + totalW <= avail;
		const across = n <= 14 && nameW + n * widest <= avail;
		const withTotal = add && fitsTotal;
		const totalCell = v => `<b>${plain(v, unit)}</b>`;
		if (across) {
			const cols = [['', nameW]].concat(c.labels.map(l => [esc(l), 0, 'r'])).concat(withTotal ? [['Total', totalW, 'r']] : []);
			const rows = c.series.map((s, j) => [`${k > 1 ? `<i class="ss-sw" style="background:${PAL[j % PAL.length]}"></i>` : ''}${esc(s.name)}`].concat(s.values.map(v => plain(v, unit))).concat(withTotal ? [totalCell(sumOf(s.values))] : []));
			if (add && k > 1) { rows.push({ c: ['Total'].concat(c.labels.map((_, i) => plain(sumOf(c.series.map(s => s.values[i])), unit))).concat(withTotal ? [totalCell(sumOf(c.series.flatMap(s => s.values)))] : []), cls: 'tot' }); }
			return table(cols, rows, { cls: 'tight' });
		}
		const cols = [[esc(c.x?.column || 'Grupo'), 0]].concat(c.series.map((s, j) => [`${k > 1 ? `<i class="ss-sw" style="background:${PAL[j % PAL.length]}"></i>` : ''}${esc(s.name)}`, k > 3 ? 0 : 120, 'r'])).concat(add && k > 1 ? [['Total', 100, 'r']] : []);
		const rows = c.labels.map((l, i) => [esc(l)].concat(c.series.map(s => plain(s.values[i], unit))).concat(add && k > 1 ? [totalCell(sumOf(c.series.map(s => s.values[i])))] : []));
		if (add) { rows.push({ c: ['Total'].concat(c.series.map(s => plain(sumOf(s.values), unit))).concat(k > 1 ? [totalCell(sumOf(c.series.flatMap(s => s.values)))] : []), cls: 'tot' }); }
		return table(cols, rows, { cls: 'tight' });
	}

	function sqlHtml(sql) {
		const text = esc(String(sql || ''));
		return text.replace(/('(?:[^']|'')*')|\b(SELECT|FROM|WHERE|GROUP BY|ORDER BY|AS|AND|OR|LIMIT|DESC|ASC|IN|IS|NOT|NULL|CAST|CASE|WHEN|THEN|ELSE|END|WITH|HAVING|ON|JOIN|LEFT|BY|DISTINCT)\b|\b(SUM|COUNT|AVG|MIN|MAX|ROUND|strftime|substr|LOWER|TRIM|COALESCE)\b/gi,
			(match, str, kw, fn) => str ? `<span class="s">${str}</span>` : kw ? `<span class="kw">${kw}</span>` : `<span class="f">${fn}</span>`);
	}

	/** "O que foi calculado": the request in words, the SQL, the rows counted and left out, the columns and the check. */
	function calcPanels(c) {
		const calc = obj(c.calc) || {};
		const filter = arr(calc.filter);
		const verb = c.y?.column ? `${AGG_VERB[c.y.agg] || AGG[c.y.agg] || ''} ${c.y.column}` : 'conte as linhas';
		const chronological = ['month', 'day', 'week', 'quarter', 'year', 'weekday', 'hour'].includes(c.x?.by);
		const lines_ = [
			['arquivo', esc(c.fileName || fileInfo().path || '')],
			['aba', esc(c.sheetName || sheetInfo().name || '')],
			['só onde', filter.length ? filter.map(f => esc(f).replace(/= (.+)$/, '= <span class="s">"$1"</span>')).join(' e ') : 'todas as linhas'],
			c.x?.column ? ['agrupe', esc(`por ${byText(c.x.by, c.x.column)}${c.group ? ` e por ${byText(c.group.by, c.group.column)}` : ''}`)] : null,
			[c.y?.agg === 'count' && !c.y?.column ? 'conte' : (AGG_VERB[c.y?.agg] || 'some').split(' ')[0], esc(c.y?.column ? verb.split(' ').slice(1).join(' ') || c.y.column : 'linhas')],
			c.x?.column ? ['ordene', chronological ? `por ${esc(BY_EACH[c.x.by] || c.x.by)}, do primeiro ao último` : 'do maior para o menor'] : null,
			['base', calc.basis === 'clean' ? `visão limpa (${plural(num(calc.steps) || 0, 'passo', 'passos')})` : 'a planilha como foi lida'],
		].filter(Boolean);
		const readable = `<div class="ss-qkv">${lines_.map(([k, v]) => `<span class="kw">${esc(k)}</span><span>${v}</span>`).join('')}</div>`;
		const sql = `<pre class="ss-q"><span class="c">-- rodou neste computador, na cópia de trabalho</span>\n${sqlHtml(calc.sql)}</pre>`;
		const excluded = arr(calc.excluded).map(e => [`${ic('close', 'c-dim')}${esc(e.reason)}`, `−${nf(e.count)}`]);
		const rowsTable = table([['', 0], ['', 76, 'r']], [['Lidas da planilha', nf(calc.rowsTotal)]].concat(excluded).concat([{ c: [`${ic('passed', 'c-ok')}<b>Usadas no gráfico</b>`, `<b>${nf(calc.rowsUsed)}</b>`], cls: '' }]), { cls: 'nohead' });
		const used = [...new Set([c.x?.column, c.y?.column, c.group?.column].concat(filter.map(filterColumn)).filter(Boolean))];
		const usedChips = `<div class="ss-row" style="gap:6px;flex-wrap:wrap">${used.map(name => { const col = findColumn(name); return chip(col ? typeIcon(col.type, isCalc(col)) : ic('columns'), name, col ? `<span class="ss-dim">${esc(isCalc(col) ? 'calculada' : typeLabel(col.type))}</span>` : ''); }).join('')}</div>`;
		const conv = [];
		for (const name of used) {
			const col = profileColumns().find(cc => cc.name === name);
			const n = obj(col?.notes) || {};
			if (n['text-number']) { conv.push(li(ic('passed', 'c-ok'), `${nf(n['text-number'])} valores de ${esc(name)} escritos como texto → número`, '', 'multi')); }
			if (n['text-date']) { conv.push(li(ic('passed', 'c-ok'), `${nf(n['text-date'])} datas de ${esc(name)} escritas como texto → data`, '', 'multi')); }
			if (n['text-time']) { conv.push(li(ic('passed', 'c-ok'), `${nf(n['text-time'])} horas de ${esc(name)} escritas como texto → hora`, '', 'multi')); }
			if (n.unparsed) { conv.push(li(ic('warning', 'c-you'), `${nf(n.unparsed)} células de ${esc(name)} ilegíveis ficaram vazias`, '', 'multi')); }
			if (n.error) { conv.push(li(ic('error', 'c-bad'), `${nf(n.error)} células de ${esc(name)} com erro de fórmula ficaram vazias`, '', 'multi')); }
		}
		conv.push(li(ic('lock', 'c-dim'), 'Só na leitura: o arquivo não mudou', '', 'multi'));
		const values = arr(c.series).flatMap(s => arr(s.values));
		const check = c.kind === 'query' ? kv([['Linhas de resultado', nf(arr(c.table?.rows).length)], ['Cortada', c.table?.truncated ? 'sim, há mais linhas' : 'não']], 130) : kv([
			['Grupos', `${nf(arr(c.labels).length)}${arr(c.series).length > 1 ? ` × ${nf(c.series.length)} séries` : ''}`],
			additive(c) ? ['Soma dos grupos', esc(full(sumOf(values), c.unit))] : ['Maior valor', esc(full(Math.max(...values.map(num).filter(v => v !== null)), c.unit))],
			additive(c) && num(c.total) !== null ? ['Total', `${Math.abs(sumOf(values) - c.total) < 0.01 ? ic('passed', 'c-ok') : ic('warning', 'c-you')}${esc(full(c.total, c.unit))}`] : null,
			['Fora da conta', plural((num(calc.rowsTotal) || 0) - (num(calc.rowsUsed) || 0), 'linha', 'linhas')],
		], tight() ? 96 : 108);
		const st = chartState(c);
		const caveat = st?.[2] ? panel('Ressalva', `<div class="ss-text">${esc(st[0] === 'antes da limpeza' ? 'Este gráfico foi feito antes da limpeza: os passos de agora (datas, valores, linhas repetidas) não estavam na conta.' : 'Este gráfico foi feito com outra versão da visão limpa.')}</div><div style="margin-top:8px">${btn('Refazer com a visão limpa', 'refresh', 'sm primary', `data-act="redo" data-id="${esc(c.id)}"`)}</div>`, { icon: 'warning', mk: 'you', pb: 'fit', style: 'flex:none' }) : '';
		const cleanupLink = !st?.[2] && S.cleanup?.scanned && arr(S.cleanup.problems).some(p => !p.applied) ? panel('Ressalva', `<div class="ss-text">A Limpeza achou problemas ainda sem correção nesta aba. Os números podem mudar depois de corrigir.</div><div style="margin-top:8px">${btn('Ver na Limpeza', 'checklist', 'sm', 'data-act="view" data-view="cleanup"')}</div>`, { icon: 'warning', mk: 'you', pb: 'fit', style: 'flex:none' }) : '';
		return `<div class="ss-row top" style="flex:1 1 auto;gap:10px;min-height:0">
			<div class="ss-col" style="flex:1.1">${panel('Consulta, em português', readable, { icon: 'comment', pb: 'np fit', style: 'flex:none' })}${panel('A mesma consulta em SQL', sql, { icon: 'database', pb: 'np', style: 'flex:1 1 auto;min-height:90px', right: btn('Copiar', 'copy', 'sm', 'data-act="copy-sql"') })}</div>
			<div class="ss-col" style="flex:1">${panel('Linhas', rowsTable, { icon: 'list', pb: 'np fit', style: 'flex:none' })}${panel('Colunas usadas', usedChips, { icon: 'columns', pb: 'fit', style: 'flex:none' })}${panel('Conversões na leitura', conv.join(''), { icon: 'swap', style: 'flex:1 1 auto;min-height:60px' })}</div>
			<div class="ss-col" style="flex:0 0 ${tight() ? 200 : 236}px">${panel('Conferência', check, { icon: 'checkbox', pb: 'fit', style: 'flex:none' })}${caveat}${cleanupLink}</div>
		</div>`;
	}

	/** The chart panel itself: title strip, legend, the drawing and the calculation strip. */
	function chartPanel(c, o = {}) {
		const st = chartState(c);
		const right = `${o.noKind ? '' : kindSelect(c)}${btn(tight() ? '' : 'Exportar', 'export', `sm ${tight() ? 'ib' : ''}`, `data-act="export-open" data-id="${esc(c.id)}" title="Exportar"`)}${btn('', 'comment', 'sm ib', `data-act="chart-ask" data-id="${esc(c.id)}" title="Perguntar sobre este gráfico"`)}`;
		const single = c.series.length === 1 && additive(c) && num(c.total) !== null && !['stacked100', 'heatmap'].includes(c.kind) && c.labels.length > 1;
		const each = BY_EACH[c.x?.by] || (c.x?.column ? c.x.column : 'grupo');
		const big = single ? `<div class="ss-big"><b>${esc(full(c.total, c.unit))}</b><em>no total · média de ${esc(full(c.total / c.labels.length, c.unit))} por ${esc(each)}</em></div>` : '';
		const clickable = canFilter(c);
		const hint = clickable && !tight() ? ' · clique numa barra para filtrar a tabela' : '';
		return `<div class="ss-panel flat" style="${o.style || 'flex:1 1 0;min-height:200px'}"><div class="ss-ph">${ic(KINDS[c.kind]?.icon || 'graph')}<span class="t">${esc(c.title)}</span><em>${chartSub(c)}${hint}</em><span class="r">${st && !st[2] ? pill(st[0], st[1]) : ''}${right}</span></div>${legend(c, c.kind === 'line')}${big}<div class="ss-col ss-grow" style="padding:${c.kind === 'hbar' ? '10px 10px 6px' : '4px 10px 4px'}">${slot((w, h) => chartSvg(c, w, h, 'main', { click: clickable }), o.height ? `flex:none;height:${o.height}px` : '')}</div>${c.kind === 'heatmap' ? heatLegend(c) : ''}${calcStrip(c)}</div>`;
	}

	/** A bar of this chart can become a filter of the table: one series of plain values of this sheet. */
	const canFilter = c => ['bar', 'hbar'].includes(c.kind) && c.series.length === 1 && (c.x?.by === 'value' || !c.x?.by) && !!c.x?.column && scopeOf(c) === 'here';

	/** The open sheet under a chart whose bars filter it (mockup 15): the filter chips and the first rows. */
	function sheetUnder() {
		const g = S.grid || {};
		const filtered = arr(g.filter).length;
		const rows = arr(g.rows).slice(0, 80);
		return `<div class="ss-panel" style="flex:1 1 0;min-height:140px"><div class="ss-ph">${ic('table')}<span class="t">Aba ${esc(sheetInfo().name || '')}${filtered ? ', filtrada' : ''}</span><em>· ${filtered ? `${nf(g.matched)} de ${nf(g.total)} linhas` : `${nf(g.total)} linhas, sem filtro`}</em><span class="r">${btn(tight() ? '' : 'Abrir na Planilha', 'table', `sm ${tight() ? 'ib' : ''}`, 'data-act="view" data-view="sheet" title="Abrir na Planilha"')}</span></div>${filterBar()}<div class="ss-gridwrap" data-scroll="grid-under">${rows.length ? gridTable({ rows, filters: true }) : '<div class="ss-empty">Nenhuma linha com este filtro.</div>'}</div></div>`;
	}

	function chartDetail(c) {
		const stale = staleStrip(c);
		if (c.kind === 'query') { return stale + queryDetail(c); }
		if (c.kind === 'pivot') { return stale + pivotDetail(c); }
		const numbersPanel = () => panel('Os números do gráfico', numbersTable(c), { icon: 'table', sub: unitNote(c.unit) ? `· ${esc(unitNote(c.unit))}` : '', pb: 'np', style: 'flex:0 1 auto;max-height:42%;min-height:80px' });
		const bottom = () => S.showCalc ? calcPanels(c) : numbersPanel();
		if (c.kind === 'heatmap') {
			const cells = [];
			c.series.forEach(s => c.labels.forEach((l, j) => { const v = num(s.values[j]); if (v !== null) { cells.push([s.name, l, v]); } }));
			cells.sort((a, b) => b[2] - a[2]);
			const hourText = l => /^\d\dh$/.test(l) ? `${Number(l.slice(0, 2))}h às ${Number(l.slice(0, 2)) + 1}h` : l;
			const top = table([['Onde', 0], [c.y?.column ? 'Valor' : 'Linhas', 64, 'r']], cells.slice(0, 6).map(([r, l, v]) => [`${esc(WEEKDAY_FULL[r] || r)}, ${esc(hourText(l))}`, esc(short(v, c.unit))]));
			const byRow = { id: c.id, kind: 'bar', labels: c.series.map(s => s.name), series: [{ name: 'total', values: c.series.map(s => sumOf(s.values)) }], unit: c.unit, y: c.y };
			const side = `<div class="ss-col" style="flex:0 0 ${tight() ? 210 : 250}px">${panel('Mais cheios', top, { icon: 'flame', pb: 'np fit', style: 'flex:none' })}${additive(c) ? panel(`Por ${esc(byText(c.group?.by, c.group?.column) || 'série')}`, `<div class="ss-col" style="height:100%">${slot((w, h) => vbars(byRow, w, h, 'mini', { share: false }))}</div>`, { icon: 'calendar', pb: '', style: 'flex:1 1 auto;min-height:120px' }) : ''}</div>`;
			return `${stale}<div class="ss-row top" style="flex:1 1 0;gap:10px;min-height:200px">${chartPanel(c, { style: 'flex:1;min-height:0' })}${S.showCalc ? '' : side}</div>${S.showCalc ? calcPanels(c) : ''}`;
		}
		if (c.kind === 'hbar' && canFilter(c) && !S.showCalc && gridColumns().length) {
			const rowsShown = Math.min(c.labels.length, 12);
			return `${stale}${chartPanel(c, { style: 'flex:0 1 auto;min-height:150px', height: rowsShown * 31 + 14 })}${sheetUnder()}`;
		}
		if (c.kind === 'stacked100' && !S.showCalc) {
			const n = c.labels.length;
			const totals = c.labels.map((_, i) => sumOf(c.series.map(s => s.values[i])));
			const grand = sumOf(totals);
			const avail = window.innerWidth - (tight() ? 168 : narrow() ? 184 : 200) - (tight() ? 220 : 270) - 40;
			const across = 96 + n * Math.max(40, Math.max(...c.labels.map(l => tw(l, 11.5))) + 14) + 64 <= avail;
			const share = across
				? table([['', 96]].concat(c.labels.map(l => [esc(l), 0, 'r'])).concat([['no total', 64, 'r']]), c.series.map((s, k) => [`<i class="ss-sw" style="background:${PAL[k % PAL.length]}"></i>${esc(s.name)}`].concat(s.values.map((v, i) => totals[i] ? `${nf((num(v) || 0) / totals[i] * 100, 0)}%` : '—')).concat([`<b>${grand ? nf(sumOf(s.values) / grand * 100, 0) : '—'}%</b>`])), { cls: 'tight' })
				: table([[esc(c.x?.column || ''), 0]].concat(c.series.map((s, k) => [`<i class="ss-sw" style="background:${PAL[k % PAL.length]}"></i>${esc(s.name)}`, 0, 'r'])), c.labels.map((l, i) => [esc(l)].concat(c.series.map(s => totals[i] ? `${nf((num(s.values[i]) || 0) / totals[i] * 100, 0)}%` : '—'))), { cls: 'tight' });
			const year = table([[esc(c.group?.column ? cap(c.group.column) : 'Série'), 0], [c.y?.column ? cap(AGG[c.y.agg] || '') : 'Linhas', 96, 'r']], c.series.map(s => [esc(s.name), esc(full(sumOf(s.values), c.unit))]).concat([{ c: ['<b>Total</b>', `<b>${esc(full(grand, c.unit))}</b>`], cls: 'tot' }]));
			return `${stale}${chartPanel(c)}<div class="ss-row top" style="flex:0 1 auto;gap:10px;max-height:40%;min-height:90px">${panel('Parte de cada um, por ' + esc(BY_EACH[c.x?.by] || c.x?.column || 'grupo'), share, { icon: 'table', pb: 'np', style: 'flex:1' })}${panel('No total', year, { icon: 'sum', pb: 'np', style: `flex:0 0 ${tight() ? 210 : 260}px` })}</div>`;
		}
		return `${stale}${chartPanel(c, S.showCalc ? { style: 'flex:0 0 38%;min-height:190px' } : {})}${bottom()}`;
	}

	function pivotDetail(c) {
		const p = obj(c.pivot) || {};
		const rows = arr(p.rows), cols = arr(p.columns), cells = arr(p.cells);
		const unit = c.unit;
		const rowTotals = arr(p.rowTotals), colTotals = arr(p.columnTotals);
		const grand = rowTotals.length ? sumOf(rowTotals) : null;
		const money = unit === 'currency';
		const head = [[esc(cap(c.x?.column || 'Linhas')), tight() ? 110 : 140]].concat(cols.map(col => [esc(col), 0, 'r'])).concat(rowTotals.length ? [['Total', 0, 'r'], ['% do total', 84, 'r']] : []);
		const body = rows.map((r, i) => [esc(r)].concat(arr(cells[i]).map(v => num(v) === null || v === 0 ? '<span class="ss-dim">—</span>' : plain(v, unit))).concat(rowTotals.length ? [`<b>${plain(rowTotals[i], unit)}</b>`, grand ? `${nf(rowTotals[i] / grand * 100, 1)}%` : '—'] : []));
		if (colTotals.length) { body.push({ c: ['<b>Total</b>'].concat(colTotals.map(v => `<b>${plain(v, unit)}</b>`)).concat(rowTotals.length ? [`<b>${plain(grand, unit)}</b>`, '<b>100,0%</b>'] : []), cls: 'tot' }); }
		const title = `${esc(c.title)}${money ? ' <span style="font-weight:400;color:#A8A8A8">(R$)</span>' : ''}`;
		const tablePanel = panel(title, table(head, body, { cls: 'tall' }), { icon: 'pivot', pb: 'np', style: 'flex:0 1 auto;min-height:120px', right: `${btn(tight() ? '' : 'Exportar', 'export', `sm ${tight() ? 'ib' : ''}`, `data-act="export-open" data-id="${esc(c.id)}" title="Exportar"`)}${btn('', 'comment', 'sm ib', `data-act="chart-ask" data-id="${esc(c.id)}" title="Perguntar sobre esta tabela"`)}` });
		const spec = obj(c.spec) || {};
		const setup = [
			['Linhas', chip('tag', byText(spec.rows_by || c.x?.by, c.x?.column || spec.rows || '—'))],
			['Colunas', c.group?.column ? chip('tag', byText(c.group.by, c.group.column)) : dim('—')],
			['Valores', chip(c.y?.column ? typeIcon(typeOfName(c.y.column)) : 'sum', c.y?.column ? `${AGG[c.y.agg] || ''} de ${c.y.column}` : 'contagem de linhas')],
			['Filtro', arr(c.calc?.filter).length ? arr(c.calc.filter).map(f => chip('filter', f)).join(' ') : dim('todas as linhas')],
			['Ordem', esc(spec.sort === 'label' ? 'pelo nome' : 'maior total primeiro')],
		].map(([k, v]) => `<div class="ss-set" style="grid-template-columns:62px minmax(0,1fr);border-bottom:1px solid #38383C"><span class="k">${k}</span><div class="ss-row" style="gap:4px;flex-wrap:wrap">${v}</div></div>`).join('');
		const fields = profileColumns().map(col => `<div class="ss-li" style="gap:7px">${typeIcon(col.type, isCalc(col))}${tx(esc(col.name))}<em>${esc(isCalc(col) ? 'calculada' : typeLabel(col.type))}</em></div>`).join('');
		const side = `<div class="ss-col" style="flex:0 0 ${tight() ? 210 : 250}px">${panel('Montagem', setup, { icon: 'gear', pb: 'fit', style: 'flex:none' })}${panel('Colunas da aba', fields, { icon: 'columns', style: 'flex:1 1 auto;min-height:60px' })}<div class="ss-hint">${ic('comments', 'c-dim')}<span>Para mudar a montagem, peça na conversa: o pedido vai para o agente.</span></div></div>`;
		const chart = S.showCalc ? calcPanels(c) : `<div class="ss-panel flat" style="flex:1 1 0;min-height:150px"><div class="ss-ph">${ic('graph')}<span class="t">A mesma tabela em gráfico</span></div>${legend(c)}<div class="ss-col ss-grow" style="padding:4px 10px 4px">${slot((w, h) => grouped(c, w, h, 'main'))}</div>${calcStrip(c)}</div>`;
		return `<div class="ss-row top" style="flex:1 1 auto;gap:10px;min-height:0"><div class="ss-col ss-grow">${tablePanel}${chart}</div>${side}</div>`;
	}

	function queryDetail(c) {
		const t = obj(c.table) || {};
		const columns = arr(t.columns);
		const cell = v => v === null || v === undefined ? '<span class="ss-dim">—</span>' : typeof v === 'number' ? nfa(Math.round(v * 100) / 100) : esc(v);
		const result = table(columns.map((name, i) => [esc(name), 0, arr(t.rows).some(r => typeof r[i] === 'number') ? 'r' : '']), arr(t.rows).map(r => columns.map((_, i) => cell(r[i]))));
		const sql = `<pre class="ss-q">${sqlHtml(c.calc?.sql)}</pre>`;
		return `${panel(esc(c.title), result, { icon: 'database', sub: `· ${plural(arr(t.rows).length, 'linha', 'linhas')} de resultado${t.truncated ? ', há mais' : ''}`, pb: 'np', style: 'flex:1 1 0;min-height:150px', right: btn('', 'comment', 'sm ib', `data-act="chart-ask" data-id="${esc(c.id)}" title="Perguntar sobre esta consulta"`) })}${panel('A consulta em SQL', sql, { icon: 'database', pb: 'np', style: 'flex:0 1 auto;max-height:40%', right: btn('Copiar', 'copy', 'sm', 'data-act="copy-sql"') })}<div class="ss-hint">${ic('lock', 'c-dim')}<span>Só leitura: a consulta lê a tabela dados e não muda nada, nem a cópia de trabalho nem o arquivo.</span></div>`;
	}

	// ------------------------------------------------------------------ panel (Painel)

	/** "Soma de valor, só onde status = concluído: 4.317 de 4.809 linhas." said shortly: the filter and the rows. */
	function tileNote(text) {
		const match = /^(.*?)(?:, só onde (.*?))?: ([\d.]+) de ([\d.]+) linhas\.?$/.exec(String(text || ''));
		if (!match) { return String(text || ''); }
		return `${match[2] ? `só onde ${match[2]}` : 'todas as linhas'} · ${match[3]} linhas`;
	}
	function tile(n, stale) {
		const icon = n.unit === 'currency' ? 'sum' : n.unit === 'percent' ? 'percent' : 'list';
		return `<div class="ss-tile" style="--mk:${stale ? '#C2508F' : '#4E86C8'}" title="${esc(n.note || '')}"><div class="t">${ic(icon)}<span>${esc(n.title)}</span></div><div class="v">${esc(full(num(n.value), n.unit === 'count' ? 'integer' : n.unit))}</div><div class="s">${esc(tileNote(n.note))}</div></div>`;
	}

	function miniChart(c) {
		const st = chartState(c);
		const body = c.kind === 'query'
			? table(arr(c.table?.columns).map(name => [esc(name), 0]), arr(c.table?.rows).slice(0, 8).map(r => r.map(v => esc(v ?? '—'))), { cls: 'tight' })
			: `<div class="ss-col" style="height:100%">${legend(c, c.kind === 'line')}${slot((w, h) => chartSvg(c.kind === 'pivot' ? { ...c, kind: 'grouped' } : c, w, h, 'mini'))}</div>`;
		return panel(esc(c.title), body, { icon: KINDS[c.kind]?.icon || 'graph', pb: c.kind === 'query' ? 'np' : '', cls: S.panelPick === c.id ? 'picked' : '', style: 'min-height:0', right: st ? pill(st[0], st[1]) : '', click: `data-act="chart-open" data-id="${esc(c.id)}" title="Abrir em Gráficos"` });
	}

	function panelView() {
		const d = S.dashboard;
		if (!d) {
			const list = S.charts.filter(c => scopeOf(c) === 'here').slice(0, 4);
			return `<div class="ss-main"><div class="ss-col ss-grow ss-pad">${panel('Nenhum painel ainda', `<div class="ss-text">O painel junta alguns números principais e os gráficos que você escolher. Peça na conversa, por exemplo:</div><button class="ss-example" data-act="example" data-text="Monte um painel com o principal">${ic('comment', 'c-dim')}<span>Monte um painel com o principal</span></button>${list.length ? `<button class="ss-example" data-act="example" data-text="${esc(`Monte um painel com os gráficos ${list.map(c => c.id).join(', ')}`)}">${ic('comment', 'c-dim')}<span>${esc(`Monte um painel com os gráficos ${list.map(c => c.id).join(', ')}`)}</span></button>` : ''}`, { icon: 'dashboard', pb: 'fit', style: 'flex:none;max-width:640px' })}</div></div>`;
		}
		const stale = panelStale();
		const numbers = arr(d.numbers).filter(obj);
		const columns = Math.min(numbers.length, narrow() ? (numbers.length > 4 ? 3 : 4) : Math.min(6, numbers.length)) || 1;
		const tiles = numbers.length ? `<div class="ss-tiles" style="grid-template-columns:repeat(${columns},minmax(0,1fr))">${numbers.map(n => tile(n, stale)).join('')}</div>` : '';
		const charts = arr(d.charts).map(chartById).filter(Boolean);
		const rows = Math.ceil(charts.length / 2);
		const grid = charts.length ? `<div class="ss-dash" style="grid-template-rows:repeat(${rows},minmax(${rows > 2 ? 210 : 160}px,1fr))">${charts.map(miniChart).join('')}</div>` : '<div class="ss-empty">O painel ainda não tem gráficos.</div>';
		const sub = [fileInfo().name || '', period(), d.at ? `montado ${when(d.at)}` : ''].filter(Boolean).join(' · ');
		const staleNote = stale ? `<div class="ss-strip mk mk-you">${pill('antes da limpeza', 'you')}<span class="tx" style="flex:1 1 200px;min-width:0">Os números do painel foram calculados antes dos passos da limpeza.</span>${btn('Pedir o painel de novo', 'refresh', 'sm', `data-act="panel-redo"`)}</div>` : '';
		return `<div class="ss-main"><div class="ss-col ss-grow ss-pad ${rows > 2 ? 'ss-scroll' : ''}" data-scroll="panel">
			<div class="ss-h">${ic('dashboard', 'c-txt')}<b>${esc(d.title || 'Painel')}</b><em>${esc(sub)}</em><span class="r">${btn('Exportar', 'export', 'sm', 'data-act="export-open"')}</span></div>
			${staleNote}${tiles}${grid}
		</div></div>`;
	}

	// ------------------------------------------------------------------ cleanup (Limpeza)

	const exampleRows = p => arr(p.examples).slice(0, 4);
	function problemBody(p) {
		const fmts = arr(p.formats);
		switch (p.kind) {
			case 'text-date': return `${fmts.map(([f, n]) => `${nf(n)} no formato ${m(f)}`).join(' e ')}${fmts.length ? '. ' : ''}Nas contas, o SheetStudio já lê como data.`;
			case 'text-number': return `${fmts.map(([f, n]) => `${nf(n)} com ${m(f)}`).join(' e ')}${fmts.length ? '. ' : ''}O Excel guardou como texto; nas contas, já leio como número.`;
			case 'text-time': return 'Horas guardadas como texto. Nas contas, já leio como hora.';
			case 'unparsed': return `Não são ${esc(typeLabel(findColumn(p.column)?.type))}: ficam vazias nas contas.`;
			case 'error': return `${esc(cap(p.explain || 'a fórmula deu erro no Excel'))}. As células ficam vazias nas contas.`;
			case 'duplicates': return `Iguais em todas as colunas a uma linha anterior${arr(p.examples).length ? `, como a ${nf(p.examples[0].row)}, que repete a ${nf(p.examples[0].same)}` : ''}.`;
			case 'spaces': return 'Espaços no começo, no fim ou dobrados. Contam como valores diferentes.';
			case 'spelling': return 'Grafias diferentes do mesmo valor, que contam como grupos separados.';
			default: return '';
		}
	}
	function problemTable(p) {
		const ex = exampleRows(p);
		if (!ex.length) { return ''; }
		const quote = v => `"${v}"`;
		switch (p.kind) {
			case 'duplicates': return table([['Cópia', 0, 'r'], ['Igual à', 0, 'r']], ex.map(e => [del(nf(e.row)), nf(e.same)]));
			case 'spelling': return table([['Agora', 0], ['Fica', 0]], ex.map(e => [del(esc(e.before)), ins(esc(e.after))]));
			case 'spaces': return table([['Linha', 56, 'r'], ['Agora', 0], ['Fica', 0]], ex.map(e => [nf(e.row), del(esc(quote(e.before))), ins(esc(e.after))]));
			case 'error': return table([['Linha', 56, 'r'], ['Célula', 64], ['Fórmula', 0]], ex.map(e => [nf(e.row), `<span class="ss-m" style="color:#E0605A">${esc(e.before)}</span>`, e.formula ? `<span class="ss-m">${esc(e.formula)}</span>` : dim('—')]));
			case 'unparsed': return table([['Linha', 56, 'r'], ['Agora', 0], ['Fica', 0]], ex.map(e => [nf(e.row), del(esc(e.before)), dim('vazio')]));
			default: return table([['Linha', 56, 'r'], ['Coluna', tight() ? 0 : 66], ['Agora', 0], ['Fica', 0]], ex.map(e => [nf(e.row), esc(p.column || ''), del(esc(p.kind === 'text-number' ? quote(e.before) : e.before)), ins(esc(e.after))]));
		}
	}
	const fixText = p => `Aplique a correção ${p.id} (${String(p.title || '').toLowerCase()}${p.column ? ` em ${p.column}` : ''})`;

	function problemCard(p, i) {
		const applied = p.applied;
		const count = `${nf(p.count)} ${p.kind === 'spelling' ? (p.count === 1 ? 'célula' : 'células') : p.count === 1 ? 'linha' : 'linhas'}`;
		let action;
		if (applied) {
			action = `${pill(`aplicada · ${applied}`, 'ok')}${btn('Desfazer', 'undo', 'sm', `data-act="undo" data-step="${esc(applied)}" data-last="${steps().at(-1)?.id === applied ? 1 : 0}"`)}`;
		} else if (p.fix) {
			action = btn('Corrigir', 'check', 'sm', `data-act="fix-one" data-id="${esc(p.id)}"`);
		} else {
			action = `<span class="ss-dim" style="flex:none">sem correção automática</span>`;
		}
		return `<div class="ss-card mk ${applied ? 'mk-ok' : 'mk-you'} ${S.probSel === p.id ? 'picked' : ''}"><div class="ss-ph">${applied ? ic('passed', 'c-ok') : ic('warning', 'c-you')}<span class="t">${i + 1}. ${esc(p.title)}</span>${p.column ? `<em>· ${esc(p.column)}</em>` : ''}<span class="r"><em>${count}</em></span></div><div class="bd">${problemBody(p)}</div>${problemTable(p)}<div class="ft"><span class="ss-dim">Proposta: ${esc(p.proposal || '')}.</span>${action}</div></div>`;
	}

	function stepsPanel() {
		const list = steps();
		const f = fileInfo();
		const first = `<div class="ss-step" style="--mk:#6A6A6E"><span class="ss-num">0</span><div class="tx2"><b>Ler ${esc(f.name || basename(f.path))}</b><small>original · ${nf(rowsRaw())} linhas · só leitura</small></div>${ic('lock', 'c-dim')}</div>`;
		const items = list.map((s, i) => `<div class="ss-step" style="--mk:#37A93C"><span class="ss-num">${i + 1}</span><div class="tx2"><b title="${esc(s.text)}">${esc(s.text)}</b><small>${esc(s.id)} · ${nf(s.rows)} ${s.rows === 1 ? 'linha' : 'linhas'}${num(s.at) ? ` · ${hm(s.at)}` : ''}</small></div>${btn('Desfazer', 'undo', 'sm', `data-act="undo" data-step="${esc(s.id)}" data-last="${i === list.length - 1 ? 1 : 0}"`)}</div>`).join('');
		const foot = list.length ? `<div class="ss-row" style="padding:7px 10px;gap:8px;flex:none"><span>Resultado: <b>${nf(rowsNow())} linhas</b></span><span class="ss-sp"></span>${btn('Desfazer tudo', 'undo', 'sm', 'data-act="undo-all"')}</div>` : '';
		return `<div class="ss-panel" style="flex:none"><div class="ss-ph">${ic('listOrdered')}<span class="t">Passos da visão limpa</span><span class="r"><em>${plural(list.length, 'passo', 'passos')}</em></span></div>${first}${items}${foot}</div>`;
	}

	function originalPanel() {
		const o = obj(S.cleanup?.original) || fileInfo();
		const intact = fileInfo().intact;
		const pairs = [
			['Arquivo', m(o.path || '')],
			['Tamanho', `${esc(bytes(o.bytes || 0))}${intact ? dim(' · igual') : ''}`],
			o.modified ? ['Modificado', `${esc(when(o.modified))}${intact ? dim(' · igual') : ''}`] : null,
			o.sha256 ? ['Conteúdo', `<span class="ss-m">sha256 ${esc(String(o.sha256).slice(0, 8))}…${esc(String(o.sha256).slice(-4))}</span> ${intact ? ic('passed', 'c-ok') : ''}`] : null,
			['Passos em', 'pasta do Studio, fora do projeto'],
		];
		const changed = intact === false ? `<div style="margin-top:6px">${note('warning', 'c-you', `O arquivo mudou no disco depois de lido. ${btn('Abrir de novo', 'refresh', 'sm', `data-act="file-open" data-path="${esc(o.path || '')}"`)}`)}</div>` : '';
		return panel(intact === false ? 'Original mudou' : 'Original intacto', kv(pairs, 90) + changed, { icon: 'lock', mk: intact === false ? 'you' : 'ok', pb: 'fit', style: 'flex:none' });
	}

	/** The first rows of the grid with cells read from text, that could not be read or with formula errors. */
	function notedPanel() {
		const notes = obj(S.grid?.notes) || {};
		const rows = arr(S.grid?.rows).filter(r => obj(notes[String(r[0])])).slice(0, 14);
		if (!rows.length || !gridColumns().length) { return ''; }
		return `<div class="ss-panel" style="flex:1 1 auto;min-height:150px"><div class="ss-ph">${ic('table')}<span class="t">Onde aparecem, nas primeiras linhas</span><em>· a marca no canto é um valor lido de texto; o arquivo não muda</em></div><div class="ss-gridwrap" data-scroll="noted">${gridTable({ rows })}</div></div>`;
	}

	function finePanel(style = 'flex:none') {
		const fine = arr(S.cleanup?.fine);
		if (!fine.length) { return ''; }
		const body = fine.map(f => `<div class="ss-fine">${f.by ? ic('passed', 'c-ok') : ic('info', 'c-dim')}<div><div>${esc(f.text)}</div><div class="sub">${f.by ? (f.exact ? `explicados pela coluna ${esc(f.by)}` : `todos com o mesmo ${esc(f.by)}`) : 'células vazias, sem um motivo achado'}</div></div></div>`).join('');
		return panel('Parece problema, mas não é', body, { icon: 'checkbox', style });
	}

	function beforeAfter() {
		const problems = arr(S.cleanup?.problems).filter(p => p.applied);
		const rawCols = num(activeSheetMeta().cols) ?? profileColumns().filter(c => !isCalc(c)).length;
		const nowCols = profileColumns().length || gridColumns().length;
		const diff = (a, b) => b - a === 0 ? dim('—') : `${b - a > 0 ? '+' : '−'}${nf(Math.abs(b - a))}`;
		const rows = [
			['Linhas', del(nf(rowsRaw())), ins(nf(rowsNow())), diff(rowsRaw(), rowsNow())],
			['Colunas', rawCols === nowCols ? nf(rawCols) : del(nf(rawCols)), rawCols === nowCols ? nf(nowCols) : ins(nf(nowCols)), diff(rawCols, nowCols)],
		].concat(problems.map(p => ({ c: [esc(`${p.title}${p.column ? ` (${p.column})` : ''}`), del(nf(p.count)), ins('0'), `−${nf(p.count)}`], cls: 'mk-ok' })));
		return panel('Antes e depois', table([['Medida', 0], ['Antes', tight() ? 70 : 96, 'r'], ['Depois', tight() ? 70 : 96, 'r'], ['Diferença', tight() ? 70 : 90, 'r']], rows, { cls: 'tall' }), { icon: 'diff', pb: 'np fit', style: 'flex:none' });
	}

	function chartsAfterCleanup() {
		const here = S.charts.filter(c => scopeOf(c) === 'here');
		const items = here.map(c => {
			const st = chartState(c);
			return `<div class="ss-li line click" data-act="chart-open" data-id="${esc(c.id)}">${ic(st?.[2] ? 'history' : 'passed', st?.[2] ? 'c-you' : 'c-ok')}${tx(esc(c.title))}<span class="ss-sp"></span>${st ? pill(st[0], st[1]) : ''}</div>`;
		});
		if (S.dashboard) { items.unshift(`<div class="ss-li line click" data-act="view" data-view="panel">${ic(panelStale() ? 'history' : 'passed', panelStale() ? 'c-you' : 'c-ok')}${tx(`Painel: ${esc(S.dashboard.title || 'Painel')}`)}<span class="ss-sp"></span>${panelStale() ? pill('antes da limpeza', 'you') : pill('visão limpa', 'ok')}</div>`); }
		const stale = here.filter(isStale);
		return panel('Gráficos desta conversa', items.join('') || '<div class="ss-empty">Nenhum gráfico ainda.</div>', { icon: 'graph', style: 'flex:1 1 0;min-height:120px', foot: stale.length ? `<span class="ss-dim">${plural(stale.length, 'gráfico feito', 'gráficos feitos')} antes da limpeza.</span><span class="ss-sp"></span>${btn(`Refazer ${stale.length === 1 ? 'com' : `os ${stale.length} com`} a visão limpa`, 'refresh', 'sm', 'data-act="redo-all"')}` : '' });
	}

	function cleanupView() {
		const cl = S.cleanup || {};
		const problems = arr(cl.problems);
		const open = problems.filter(p => !p.applied);
		const fixable = open.filter(p => p.fix);
		const list = steps();
		let sub;
		let right = '';
		if (!cl.scanned) {
			sub = list.length ? `· ${plural(list.length, 'passo aplicado', 'passos aplicados')} numa visão limpa` : '· ainda não procurei problemas nesta aba';
			right = btn('Procurar problemas', 'search', 'sm primary', 'data-act="scan"');
		} else if (fixable.length) {
			sub = list.length ? `· ${plural(list.length, 'passo aplicado', 'passos aplicados')}; as propostas que faltam aparecem riscadas e sublinhadas` : '· nada foi mudado ainda: as propostas aparecem riscadas e sublinhadas';
			right = btn(fixable.length === 1 ? 'Aplicar a correção' : `Aplicar as ${fixable.length} correções`, 'check', 'sm primary', 'data-act="fix-all"');
		} else if (list.length) {
			const at = list.at(-1)?.at;
			sub = `· ${plural(list.length, 'passo aplicado', 'passos aplicados')}${num(at) ? ` às ${hm(at)}` : ''} numa visão limpa`;
			right = btn('Exportar a visão limpa', 'export', 'sm', 'data-act="export-open"');
		} else {
			sub = problems.length ? '· sem propostas abertas' : '· nenhum problema achado nesta aba';
			right = btn('Procurar de novo', 'search', 'sm', 'data-act="scan"');
		}
		const head = `<div class="ss-head">${ic('checklist', 'c-txt')}<b>Limpeza</b><span class="sub">${esc(sub)}</span><span class="r">${right}</span></div>`;
		if (!cl.scanned && !list.length) {
			const body = `<div class="ss-text">A Limpeza procura datas e números escritos como texto, células que não puderam ser lidas, erros de fórmula, linhas repetidas, espaços sobrando e o mesmo valor escrito de jeitos diferentes. Procurar não muda nada: as correções só entram quando você aceitar, como passos que dá para desfazer.</div><div style="margin-top:10px">${btn('Procurar problemas', 'search', 'primary', 'data-act="scan"')}</div>`;
			return `<div class="ss-main">${head}<div class="ss-row top ss-grow ss-pad"><div class="ss-col ss-grow">${panel('Ainda não procurei problemas', body, { icon: 'search', pb: 'fit', style: 'flex:none;max-width:680px' })}</div><div class="ss-col" style="flex:0 0 ${tight() ? 280 : 320}px">${originalPanel()}${note('lock', 'c-dim', '<b>O original não muda.</b> As correções viram passos de uma visão limpa. Cada passo dá para desfazer.')}</div></div></div>`;
		}
		const cards = open.length ? `<div class="ss-cards">${open.map((p, i) => problemCard(p, i)).join('')}</div>` : '';
		let lower;
		if (list.length) {
			lower = `<div class="ss-row top" style="flex:1 0 auto;gap:10px;min-height:${open.length ? 0 : 300}px">
				<div class="ss-col" style="flex:0 0 ${tight() ? 300 : narrow() ? 330 : 360}px">${stepsPanel()}${originalPanel()}${note('info', 'c-dim', 'Para mudar o arquivo de verdade, use Exportar: ele cria um arquivo novo e deixa este como está.', 'fill')}</div>
				<div class="ss-col ss-grow">${beforeAfter()}<div class="ss-row top" style="flex:1 1 auto;gap:10px;min-height:120px">${chartsAfterCleanup()}${finePanel('flex:1 1 0;min-height:120px')}</div></div>
			</div>`;
		} else {
			const noted = notedPanel();
			lower = `<div class="ss-row top" style="flex:1 0 auto;gap:10px;min-height:${noted ? 230 : 160}px">
				<div class="ss-col ss-grow">${noted || finePanel('flex:1 1 auto') || '<div></div>'}</div>
				<div class="ss-col" style="flex:0 0 ${tight() ? 280 : 320}px">${noted ? finePanel() : ''}${originalPanel()}${note('lock', 'c-dim', '<b>O original não muda.</b> As correções viram passos de uma visão limpa. Cada passo dá para desfazer.', 'fill')}</div>
			</div>`;
		}
		return `<div class="ss-main">${head}<div class="ss-col ss-grow ss-pad ss-scroll" data-scroll="cleanup">${cards}${lower}</div></div>`;
	}

	// ------------------------------------------------------------------ questions (Perguntas)

	const RESULT = { bar: 'Barras', hbar: 'Barras deitadas', line: 'Linhas', stacked: 'Colunas empilhadas', stacked100: 'Colunas 100%', grouped: 'Colunas lado a lado', heatmap: 'Mapa de calor', table: 'Tabela' };
	function resultText(e) {
		if (e.action === 'chart') { return RESULT[e.result] || e.result || 'Gráfico'; }
		if (e.action === 'pivot') { return 'Tabela dinâmica'; }
		if (e.action === 'export') { const n = String(e.result || '').split(',').filter(Boolean).length; return plural(n, 'arquivo novo', 'arquivos novos'); }
		if (e.action === 'column') { return `Coluna ${e.result || ''}`.trim(); }
		if (e.action === 'fix') { return `${e.result || ''} de limpeza`.trim(); }
		if (e.action === 'query') { return `Consulta: ${e.result || ''}`; }
		if (e.action === 'undo') { return 'Desfeito'; }
		return cap(e.result || e.title || '');
	}
	/** The fixes themselves make the version; the scan reads the original. Everything else may be older than the steps. */
	const entryState = e => e.action === 'problems' ? null
		: ['fix', 'step', 'column', 'undo', 'export'].includes(e.action) ? (e.basis === 'clean' && isOpen() ? ['visão limpa', 'ok', false] : null)
			: dataState(e.basis, e.version, e.chart && chartById(e.chart) ? scopeOf(chartById(e.chart)) : 'here');

	function historyRows() {
		const text = fold(S.histText);
		return S.history.map((e, i) => ({ e, i })).filter(({ e }) => {
			if (text && !fold(`${e.question || ''} ${e.title || ''} ${e.result || ''}`).includes(text)) { return false; }
			const st = entryState(e);
			if (S.histFilter === 'before') { return !!st?.[2]; }
			if (S.histFilter === 'clean') { return e.basis === 'clean' && !st?.[2]; }
			if (S.histFilter === 'charts') { return !!e.chart; }
			return true;
		});
	}

	function historyThumb(e) {
		const c = e.chart && chartById(e.chart);
		if (!c || !arr(c.series).length) { return '<span class="ss-dim">—</span>'; }
		if (c.series.length > 1 && !['line', 'heatmap'].includes(c.kind)) { return slot((w, h) => spark(c.series.map(s => sumOf(s.values)), w, h, PAL), 'height:20px;flex:none;width:100%'); }
		if (c.kind === 'heatmap') { return slot((w, h) => spark(c.series.map(s => sumOf(s.values)), w, h), 'height:20px;flex:none;width:100%'); }
		return slot((w, h) => spark(c.series[0].values, w, h), 'height:20px;flex:none;width:100%');
	}

	function historyView() {
		const rows = historyRows();
		const all = S.history;
		if (S.histSel === null || !all[S.histSel]) {
			const withChart = all.findIndex(e => e.chart && chartById(e.chart));
			S.histSel = withChart >= 0 ? withChart : all.length ? 0 : null;
		}
		const before = all.filter(e => entryState(e)?.[2]);
		const staleCharts = [...new Set(before.map(e => e.chart).filter(Boolean))].map(chartById).filter(c => c && isStale(c));
		const top = `<div class="ss-head"><span class="ss-in" style="width:${tight() ? 180 : 230}px">${ic('search')}<input data-draft="hist-text" data-act="hist-text" placeholder="Procurar nas perguntas" value="${esc(S.histText)}"></span><select class="ss-in" data-act="hist-filter" style="width:${tight() ? 130 : 160}px">${[['all', 'Todas'], ['charts', 'Só gráficos'], ['before', 'Antes da limpeza'], ['clean', 'Visão limpa']].map(([v, l]) => `<option value="${v}" ${S.histFilter === v ? 'selected' : ''}>${l}</option>`).join('')}</select><span class="r">${tight() ? '' : `<span class="ss-dim">${plural(all.length, 'pergunta', 'perguntas')}${before.length ? ` · ${nf(before.length)} antes da limpeza` : ''}</span>`}${staleCharts.length ? btn(`Refazer ${staleCharts.length === 1 ? '1' : `as ${staleCharts.length}`} com a visão limpa`, 'refresh', 'sm', 'data-act="redo-all"') : ''}</span></div>`;
		const thumbs = !tight();
		const [cols, body] = columnsFor([
			['Hora', 50, 'm'], ['Pergunta', 0], ['Resultado', tight() ? 104 : 124], thumbs ? ['', 82] : null, ['Linhas', 62, 'r'], ['Dados', tight() ? 112 : 124],
		], rows.map(({ e, i }) => {
			const st = entryState(e);
			const q = e.question ? esc(e.question) : `<span class="ss-dim">${esc(e.title || '')}</span>`;
			return { c: [esc(num(e.at) ? hm(e.at) : ''), q, esc(resultText(e)), thumbs ? historyThumb(e) : '', num(e.rows) !== null ? nf(e.rows) : '—', st ? pill(st[0], st[1]) : '<span class="ss-dim">—</span>'], cls: i === S.histSel ? 'sel' : '', attrs: `data-act="hist" data-i="${i}"` };
		}));
		const list = rows.length ? table(cols, body, { cls: 'tall' }) : `<div class="ss-empty">${all.length ? 'Nenhuma pergunta com esse filtro.' : 'Nenhuma pergunta ainda. O que você pedir ao SheetStudio na conversa aparece aqui, com o resultado e os dados usados.'}</div>`;
		return `<div class="ss-main">${top}<div class="ss-row top ss-grow ss-pad">${panel('Perguntas e resultados desta conversa', list, { icon: 'history', pb: 'np', style: 'flex:1' })}${historyDetail()}</div></div>`;
	}

	function historyDetail() {
		const e = S.history[S.histSel];
		const width = tight() ? 260 : narrow() ? 290 : 320;
		if (!e) { return ''; }
		const c = e.chart && chartById(e.chart);
		const st = entryState(e);
		const title = c ? c.title : e.title || 'Pergunta';
		const facts = kv([
			e.question ? ['Pergunta', esc(e.question)] : null,
			['Resultado', esc(resultText(e))],
			num(e.rows) !== null ? ['Linhas', nf(e.rows)] : null,
			['Base', e.basis === 'clean' ? `visão limpa${num(e.version) ? ` (${plural(e.version, 'passo', 'passos')})` : ''}` : 'a planilha como foi lida'],
			e.action === 'export' ? ['Arquivos', String(e.result || '').split(',').map(p => m(p.trim())).join('<br>')] : null,
		], 78);
		const chartBox = c && c.kind !== 'query' ? `<div class="ss-col" style="flex:none;height:${tight() ? 150 : 178}px;padding:4px 6px 2px">${slot((w, h) => chartSvg(c, w, h, 'mini'))}</div>` : '';
		const why = st?.[2] ? `<div class="ss-text" style="padding:6px 10px 0">${esc(st[0] === 'antes da limpeza' ? 'Feito antes da limpeza: os passos de agora não estavam na conta. Refazer pede o mesmo gráfico com a visão limpa.' : 'Feito com outra versão da visão limpa.')}</div>` : '';
		const buttons = `<div class="ss-row" style="margin-top:auto;padding:8px 10px;gap:6px;border-top:1px solid #3F3F46;flex:none;flex-wrap:wrap;row-gap:6px"><span class="ss-sp"></span>${c ? btn('Abrir', 'arrowR', 'sm', `data-act="chart-open" data-id="${esc(c.id)}"`) : ''}${e.question ? btn('Perguntar de novo', 'comment', 'sm', `data-act="example" data-text="${esc(e.question)}"`) : ''}${c && st?.[2] ? btn('Refazer', 'refresh', 'sm primary', `data-act="redo" data-id="${esc(c.id)}"`) : ''}</div>`;
		return `<div class="ss-panel ${st?.[2] ? 'mk mk-you' : ''}" style="flex:0 0 ${width}px"><div class="ss-ph">${ic(c ? KINDS[c.kind]?.icon || 'graph' : 'history')}<span class="t">${esc(title)}</span><em>· ${esc(num(e.at) ? hm(e.at) : '')}</em></div><div class="ss-pb np" style="display:flex;flex-direction:column">${st ? `<div class="ss-row" style="padding:7px 10px 0;gap:6px">${pill(st[0], st[1])}</div>` : ''}${chartBox}${why}<div style="padding:6px 10px">${facts}</div>${buttons}</div></div>`;
	}

	// ------------------------------------------------------------------ profile (Perfil das colunas)

	function distribution(c, w, h) {
		const hist = obj(c.histogram) || {};
		if (arr(hist.counts).length) { return spark(hist.counts, w, h); }
		if (arr(hist.months).length) { return spark(hist.months.map(x => x[1]), w, h); }
		if (arr(hist.hours).length) { return spark(hist.hours.map(x => x[1]), w, h); }
		if (arr(c.top).length) { return spark(c.top.map(x => x[1]), w, h); }
		return '';
	}

	function profileObservation(c) {
		const notes = obj(c.notes) || {};
		const parts = [];
		const asText = (notes['text-date'] || 0) + (notes['text-number'] || 0) + (notes['text-time'] || 0);
		if (asText) { parts.push(`${ic('warning', 'c-you')}${nf(asText)} em texto`); }
		if (notes.error) { parts.push(`${ic('error', 'c-bad')}${nf(notes.error)} com erro`); }
		if (notes.unparsed) { parts.push(`${ic('warning', 'c-you')}${nf(notes.unparsed)} ilegíveis`); }
		const fine = arr(S.cleanup?.fine).find(f => f.column === c.name && f.by);
		if (fine) { parts.push(`vazios: ${esc(fine.by)}`); }
		if (isCalc(c)) { parts.push('calculada'); }
		return parts.join(' · ');
	}

	/** The selected column's distribution: values by bin, month, hour or the most common ones. */
	function columnChart(c) {
		const hist = obj(c.histogram) || {};
		if (arr(hist.counts).length && num(hist.from) !== null) {
			const nonEmpty = hist.counts.map((n, i) => [n, i]).filter(([n]) => n > 0);
			if (nonEmpty.length <= 8) {
				const edge = v => c.type === 'percent' ? `${nf(v * 100, 0)}%` : nf(v, hist.step < 1 ? 2 : 0);
				const last = hist.counts.length - 1;
				const labels = nonEmpty.map(([, i]) => { const lo = hist.from + hist.step * i, hi = i === last ? num(c.max) ?? lo + hist.step : hist.from + hist.step * (i + 1); return `${c.type === 'currency' ? 'R$ ' : ''}${edge(lo)}–${edge(hi)}`; });
				return { kind: 'hbar', title: 'quantas linhas por valor', chart: { id: '', kind: 'hbar', labels, series: [{ name: 'linhas', values: nonEmpty.map(([n]) => n) }], unit: 'count', y: { agg: 'count' } } };
			}
			const labels = hist.counts.map((_, i) => short(hist.from + hist.step * i, c.type === 'currency' ? 'currency' : 'number'));
			return { kind: 'bar', title: 'distribuição dos valores', chart: { id: '', kind: 'bar', labels, series: [{ name: 'linhas', values: hist.counts }], unit: 'count', y: { agg: 'count' } } };
		}
		if (arr(hist.months).length) {
			const years = new Set(hist.months.map(x => String(x[0]).slice(0, 4))).size;
			const labels = hist.months.map(x => { const k = Number(String(x[0]).slice(5, 7)); const name = Object.keys(MONTH_FULL)[k - 1] || x[0]; return years > 1 ? `${name}/${String(x[0]).slice(2, 4)}` : name; });
			return { kind: 'bar', title: 'linhas por mês', chart: { id: '', kind: 'bar', labels, series: [{ name: 'linhas', values: hist.months.map(x => x[1]) }], unit: 'count', y: { agg: 'count' } } };
		}
		if (arr(hist.hours).length) {
			return { kind: 'bar', title: 'linhas por hora', chart: { id: '', kind: 'bar', labels: hist.hours.map(x => `${x[0]}h`), series: [{ name: 'linhas', values: hist.hours.map(x => x[1]) }], unit: 'count', y: { agg: 'count' } } };
		}
		if (arr(c.top).length) {
			return { kind: 'hbar', title: 'valores mais comuns', chart: { id: '', kind: 'hbar', labels: c.top.map(x => String(x[0])), series: [{ name: 'linhas', values: c.top.map(x => x[1]) }], unit: 'count', y: { agg: 'count' } } };
		}
		return null;
	}

	function profileView() {
		const cols = profileColumns();
		const sel = cols.find(c => c.key === S.profSel) || cols.find(c => NUMERIC.includes(c.type)) || cols[0];
		if (!sel) { return `<div class="ss-main"><div class="ss-empty">Sem colunas para mostrar.</div></div>`; }
		const total = rowsNow();
		const [tcols, rows] = columnsFor([
			['Coluna', tight() ? 120 : 134], tight() ? null : ['Tipo', 84], ['Preench.', 72, 'r'], ['Vazios', 58, 'r'], ['Únicos', 58, 'r'], ['Mínimo', 84, 'r'], ['Máximo', 84, 'r'], narrow() ? null : ['Distribuição', 100], ['Observação', 0],
		], cols.map(c => ({
			c: [`${typeIcon(c.type, isCalc(c))} <b>${esc(c.name)}</b>`, esc(isCalc(c) ? 'calculada' : typeLabel(c.type)), nf(c.filled), c.empty ? nf(c.empty) : dim('0'), nf(c.unique), profileValue(c.min, c.type), profileValue(c.max, c.type), slot((w, h) => distribution(c, w, h), 'height:16px;flex:none;width:100%'), profileObservation(c)],
			cls: `${c.key === sel.key ? 'sel' : ''} ${obj(c.notes) && Object.keys(c.notes).length ? 'mk-you' : ''}`,
			attrs: `data-act="prof" data-key="${esc(c.key)}"`,
		})));
		const tbl = table(tcols, rows, { cls: 'tall' });
		const view = columnChart(sel);
		const dateCol = cols.find(c => arr(c.histogram?.months).length && c.key !== sel.key) || cols.find(c => arr(c.histogram?.hours).length && c.key !== sel.key);
		const textCol = cols.find(c => ['text', 'category'].includes(c.type) && arr(c.top).length && c.key !== sel.key) || cols.find(c => arr(c.top).length);
		const lowerLeft = dateCol ? (() => { const v = columnChart(dateCol); return panel(`${esc(dateCol.name)} · ${esc(v.title)}`, `<div class="ss-col" style="height:100%">${slot((w, h) => vbars(v.chart, w, h, 'mini', { share: false }))}</div>`, { icon: dateCol.type === 'time' ? 'clock' : 'calendar', style: 'flex:1.3 1 0;min-height:0', click: `data-act="prof" data-key="${esc(dateCol.key)}"` }); })() : '';
		const lowerRight = textCol ? panel(`${esc(textCol.name)} · mais comuns`, table([[esc(cap(textCol.name)), 0], ['Linhas', 64, 'r']], arr(textCol.top).slice(0, 6).map(t => [esc(t[0]), nf(t[1])]).concat(textCol.unique > 6 ? [[dim(`e mais ${nf(textCol.unique - Math.min(6, arr(textCol.top).length))} valores`), '']] : []).concat(textCol.empty ? [[dim('vazios'), nf(textCol.empty)]] : [])), { icon: 'person', pb: 'np', style: 'flex:1 1 0;min-height:0', click: `data-act="prof" data-key="${esc(textCol.key)}"` }) : '';
		const notes = obj(sel.notes) || {};
		const detail = kv([
			['Preenchidos', `${nf(sel.filled)} de ${nf(total)}`],
			['Vazios', nf(sel.empty)],
			['Únicos', nf(sel.unique)],
			NUMERIC.includes(sel.type) && num(sel.sum) !== null ? ['Soma de tudo', esc(full(sel.sum, sel.type === 'currency' ? 'currency' : sel.type === 'percent' ? 'percent' : 'number'))] : null,
			NUMERIC.includes(sel.type) && num(sel.avg) !== null ? ['Média', esc(full(sel.avg, sel.type === 'currency' ? 'currency' : sel.type === 'percent' ? 'percent' : 'number'))] : null,
			['Mínimo', profileValue(sel.min, sel.type)],
			['Máximo', profileValue(sel.max, sel.type)],
			notes['text-number'] || notes['text-date'] || notes['text-time'] ? ['Em texto', `${nf((notes['text-number'] || 0) + (notes['text-date'] || 0) + (notes['text-time'] || 0))} ${dim('· lidos certo')}`] : null,
		], 96);
		const right = `<div class="ss-col" style="flex:0 0 ${tight() ? 240 : 268}px">
			${view ? panel(`${esc(sel.name)} · ${esc(view.title)}`, `<div class="ss-col" style="height:100%">${slot((w, h) => view.kind === 'hbar' ? hbars(view.chart, w, h, 'mini') : vbars(view.chart, w, h, 'mini', { share: false }))}</div>`, { icon: 'graph', mk: 'run', style: 'flex:0 0 200px' }) : ''}
			${panel(`${esc(sel.name)} · resumo`, detail, { icon: 'sum', pb: 'fit', style: 'flex:none', right: btn('', 'comment', 'sm ib', `data-act="prof-ask" data-key="${esc(sel.key)}" title="Perguntar sobre esta coluna"`) })}
			${note('info', 'c-dim', NUMERIC.includes(sel.type) ? 'A soma e a média contam todas as linhas, sem filtro (inclusive cancelados). Para somar só uma parte, peça um gráfico com filtro.' : 'Mínimo e máximo só para datas, horas e números.', 'fill')}
		</div>`;
		const sheetName = sheetInfo().name ? `· aba ${esc(sheetInfo().name)} · ${nf(total)} linhas` : '';
		return `<div class="ss-main"><div class="ss-row top ss-grow ss-pad">
			<div class="ss-col ss-grow">${panel(`Perfil das ${plural(cols.length, 'coluna', 'colunas')}`, tbl, { icon: 'list', sub: sheetName, pb: 'np', style: 'flex:0 1 auto;min-height:120px' })}
				${lowerLeft || lowerRight ? `<div class="ss-row top" style="flex:1 1 0;gap:10px;min-height:150px">${lowerLeft}${lowerRight}</div>` : ''}
				<div class="ss-hint">${ic('info', 'c-dim')}<span>Distribuição: quantas linhas tem cada faixa ou valor, sem escala. Clique numa coluna para ver os detalhes.</span></div>
			</div>${right}
		</div></div>`;
	}

	// ------------------------------------------------------------------ settings (Configurações)

	const draft = key => S.setDraft[key] !== undefined ? S.setDraft[key] : settings()[key];
	const changedKeys = () => Object.keys(S.setDraft).filter(k => String(S.setDraft[k]) !== String(settings()[k]));

	function setSelect(key, width = 170) {
		const value = String(draft(key));
		const changed = String(value) !== String(settings()[key]);
		const options = SET_OPTIONS[key].some(([v]) => String(v) === value) ? SET_OPTIONS[key] : [[value, key === 'gridRows' ? `${nf(Number(value))} linhas` : value]].concat(SET_OPTIONS[key]);
		return `<select class="ss-in ${changed ? 'changed' : ''}" data-act="set" data-key="${key}" style="width:${width}px">${options.map(([v, l]) => `<option value="${v}" ${String(v) === value ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
	}
	const setRow = (label, control, hint = '') => `<div class="ss-set"><span class="k">${label}</span><div><div class="ss-row" style="gap:6px;flex-wrap:wrap">${control}</div>${hint ? `<div class="h">${hint}</div>` : ''}</div></div>`;

	function settingsView() {
		const sections = [['read', 'Leitura de arquivos', 'file'], ['grid', 'Planilha no Studio', 'table'], ['export', 'Exportar', 'export'], ['charts', 'Gráficos', 'graph'], ['store', 'Onde guardar', 'folder']];
		const side = `<div class="ss-tree" style="flex:0 0 ${tight() ? 160 : 184}px"><div class="ss-th">${ic('gear')}Configurações</div>${sections.map(([id, label, icon]) => `<div class="ss-tr ${S.setSection === id ? 'sel' : ''}" data-act="set-nav" data-id="${id}">${ic(icon)}<span class="nm">${label}</span></div>`).join('')}<div class="ss-tfoot">Mudar uma configuração manda o pedido ao agente, que salva.</div></div>`;
		const folderValue = draft('exportFolder');
		const defaultFolder = isOpen() && dirname(fileInfo().path) ? `${dirname(fileInfo().path)}/saida` : 'saida';
		const read = setRow('Decimal', setSelect('decimal'), 'como ler números escritos como texto: 1.234,56 ou 1,234.56') + setRow('Datas', setSelect('dateOrder'), '26/01/26 vira 26/01/2026; 02/03 é 2 de março no padrão dia/mês') + setRow('Separador e codificação', `<span>detectados em cada CSV</span>`, 'vírgula, ponto e vírgula, tab ou barra; UTF-8, UTF-16 ou Windows-1252');
		const grid = setRow('Linhas mostradas', setSelect('gridRows', 140), 'quantas linhas a Planilha mostra de uma vez; o resto vem com "mostrar as próximas"');
		const exp = setRow('CSV', setSelect('csvStyle'), 'com ; e vírgula decimal o Excel em português abre direto') + setRow('Pasta', `<span class="ss-in m ${String(folderValue) !== String(settings().exportFolder) ? 'changed' : ''}" style="width:220px"><input data-draft="set-folder" data-act="set-folder" placeholder="${esc(defaultFolder)}" value="${esc(folderValue)}"></span>`, `vazia: ${esc(defaultFolder)}, ao lado da planilha · sempre arquivos novos`);
		const charts = setRow('Cores das séries', `<span style="display:inline-flex;gap:3px">${PAL.slice(0, 4).map(c => `<i class="ss-swatch" style="background:${c}"></i>`).join('')}</span>`, `${ic('passed', 'c-ok')} conferidas para daltonismo, nesta ordem`) + setRow('Mapa de calor', `<span class="ss-ramp">${SEQ.map(c => `<i style="background:${c}"></i>`).join('')}</span>`, 'uma cor só, do escuro ao claro') + setRow('Rótulos', '<span>o maior e o menor; todos quando cabem</span>', 'e o que foi calculado embaixo de cada gráfico');
		const store = setRow('Passos e histórico', '<span>na pasta do Studio deste chat</span>', 'fora do projeto e do Git · a cópia de trabalho é um SQLite (data/sheets.db)') + setRow('Arquivo original', '<span>nunca é gravado</span>', 'exportar sempre cria arquivos novos');
		const changes = changedKeys();
		const bottom = `<div class="ss-row" style="flex:none;padding:8px 10px;border-top:1px solid #3F3F46;background:#2D2D30;gap:6px;flex-wrap:wrap;row-gap:6px">${changes.length ? `<span class="ss-dim">${ic('dot', 'c-run sm')} ${plural(changes.length, 'mudança não salva', 'mudanças não salvas')} · a leitura vale na próxima vez que um arquivo for aberto</span>` : `<span class="ss-dim">${S.hasSettings ? 'Configurações salvas.' : 'Usando as configurações padrão.'}</span>`}<span class="ss-sp"></span>${btn('Restaurar padrões', '', 'sm', 'data-act="set-reset"')}${btn('Cancelar', '', `sm ${changes.length ? '' : 'dis'}`, changes.length ? 'data-act="set-cancel"' : 'disabled')}${btn('Salvar', 'check', `sm primary ${changes.length ? '' : 'dis'}`, changes.length ? 'data-act="set-save"' : 'disabled')}</div>`;
		const p = (id, title, icon, body, style = 'flex:none') => panel(title, body, { icon, pb: 'fit', style, cls: S.setPicked && S.setSection === id ? 'picked' : '', attrs: `data-section="${id}"` });
		return `${side}<div class="ss-main"><div class="ss-row top ss-grow ss-pad ss-scroll" data-scroll="settings">
			<div class="ss-col" style="flex:1">${p('read', 'Leitura de CSV e Excel', 'file', read)}${p('grid', 'Planilha no Studio', 'table', grid)}${p('export', 'Exportar', 'export', exp, 'flex:1 0 auto')}</div>
			<div class="ss-col" style="flex:1">${p('charts', 'Gráficos', 'graph', charts)}${p('store', 'Onde guardar', 'folder', store, 'flex:1 0 auto')}</div>
		</div>${bottom}</div>`;
	}

	// ------------------------------------------------------------------ export dialog

	function exportFolder() {
		const folder = settings().exportFolder;
		if (folder) { return String(folder).replace(/\\/g, '/').replace(/\/+$/, ''); }
		const dir = dirname(fileInfo().path);
		return dir ? `${dir}/saida` : 'saida';
	}

	function exportOptions() {
		const x = S.exporting;
		const c = x.chart ? chartById(x.chart) : null;
		const stem = slug(basename(fileInfo().path).replace(/\.[^.]+$/, '')) + (basis() === 'clean' ? '-limpo' : '');
		const folder = exportFolder();
		const style = settings().csvStyle;
		const here = S.charts.filter(ch => scopeOf(ch) === 'here').slice(0, 20);
		const svgs = here.filter(ch => !['pivot', 'query'].includes(ch.kind)).slice(0, 8);
		const options = [];
		if (c && !['pivot', 'query'].includes(c.kind)) {
			options.push({ key: 'svg', fmt: 'SVG', title: `Gráfico ${c.title}`, sub: 'fundo claro, para documentos e slides', paths: [`${folder}/${slug(c.title, 'grafico')}.svg`], files: 1, ask: `o gráfico ${c.id} em SVG` });
		}
		if (c && c.kind === 'pivot') {
			options.push({ key: 'svg', fmt: 'XLSX', title: `Números de ${c.title}`, sub: 'a tabela dinâmica numa planilha nova', paths: [`${folder}/${slug(c.title, 'grafico')}.xlsx`], files: 1, ask: `os números da tabela dinâmica ${c.id} em XLSX` });
		}
		options.push({ key: 'csv', fmt: 'CSV', title: basis() === 'clean' ? 'Dados limpos' : `Dados da aba ${sheetInfo().name || ''}`, sub: `${nf(rowsNow())} linhas · ${style === 'br' ? 'separador ; · vírgula decimal' : 'separador , · ponto decimal'} · UTF-8`, paths: [`${folder}/${stem}.csv`], files: 1, ask: basis() === 'clean' ? 'os dados limpos em CSV' : 'os dados da aba em CSV' });
		options.push({ key: 'xlsx', fmt: 'XLSX', title: 'Planilha nova com os gráficos', sub: `os dados e uma aba com os números de cada gráfico${svgs.length ? `; ${plural(svgs.length, 'gráfico vai', 'gráficos vão')} também em SVG ao lado` : ''}`, paths: [`${folder}/${stem}.xlsx`], tabs: ['Dados'].concat(here.map(ch => String(ch.title).slice(0, 31))), files: 1 + svgs.length, ask: 'uma planilha XLSX nova com os dados e os números de todos os gráficos' });
		return options;
	}

	function exportDialog() {
		const x = S.exporting;
		if (!x || !isOpen()) { return ''; }
		const options = exportOptions();
		const c = x.chart ? chartById(x.chart) : null;
		const chosen = options.filter(o => x[o.key]);
		const files = chosen.reduce((a, o) => a + o.files, 0);
		const thumb = c && arr(c.series).length ? `<div class="ss-row top" style="padding:10px 12px;gap:12px;border-bottom:1px solid #3F3F46"><div class="ss-thumb">${slot((w, h) => chartSvg(c, w, h, 'thumb'))}</div><div style="line-height:1.5;min-width:0;overflow-wrap:anywhere"><b>${esc(c.title)}</b><div class="ss-dim">${esc(c.calc?.basis === 'clean' ? 'feito com a visão limpa' : 'feito com a planilha como foi lida')}${num(c.total) !== null && additive(c) ? ` · ${esc(full(c.total, c.unit))}` : ''}</div>${isStale(c) ? `<div>${pill('antes da limpeza', 'you')} <span class="ss-dim">o arquivo sai com os números deste gráfico</span></div>` : ''}</div></div>` : '';
		const rows = options.map(o => `<label class="ss-opt ${x[o.key] ? '' : 'off'}"><input type="checkbox" data-act="export-opt" data-key="${o.key}" ${x[o.key] ? 'checked' : ''}><span class="ss-pill fmt">${o.fmt}</span><div><b>${esc(o.title)}</b><div class="ss-dim small">${esc(o.sub)}</div>${o.paths.map(p => `<div class="path">${ic('fileAdd', 'c-dim')}<span class="ss-m">${esc(p)}</span></div>`).join('')}${o.tabs ? `<div class="tabs">${o.tabs.slice(0, 7).map((t, i) => `<span style="${i ? '' : 'background:#1E1E1E'}">${esc(t)}</span>`).join('')}${o.tabs.length > 7 ? `<span class="ss-dim">+ ${nf(o.tabs.length - 7)} abas</span>` : ''}</div>` : ''}</div></label>`).join('');
		const notes = `<div style="padding:9px 12px;display:grid;gap:5px;line-height:1.45;color:#C8C8C8">${li(ic('lock', 'c-dim'), `O ${m(fileInfo().name || basename(fileInfo().path))} não muda.`, '', 'multi')}${li(ic('folder', 'c-dim'), `Os arquivos vão para ${m(`${exportFolder()}/`)}, criada se ainda não existir. Um nome que já existe ganha um número no fim.`, '', 'multi')}${li(ic('comments', 'c-dim'), 'Exportar manda o pedido ao agente, que grava e responde na conversa.', '', 'multi')}</div>`;
		return `<div class="ss-scrim" data-act="export-close"></div><div class="ss-dlg"><div class="dt">${ic('export')}Exportar<span class="x" data-act="export-close" title="Fechar">${ic('close')}</span></div><div class="bd">${thumb}${rows}${notes}</div><div class="df"><span class="ss-dim">${files ? plural(files, 'arquivo novo', 'arquivos novos') : 'Escolha o que exportar'}</span><span class="ss-sp"></span>${btn('Cancelar', '', '', 'data-act="export-close"')}${btn(files ? `Exportar ${plural(files, 'arquivo', 'arquivos')}` : 'Exportar', 'export', `primary ${files ? '' : 'dis'}`, files ? 'data-act="export-go"' : 'disabled')}</div></div>`;
	}

	// ------------------------------------------------------------------ actions

	function toast(text) {
		S.note = text;
		render();
		clearTimeout(toast.timer);
		toast.timer = setTimeout(() => { S.note = null; render(); }, 2800);
	}

	function copy(text, done) {
		const fallback = () => {
			const area = document.createElement('textarea');
			area.value = text;
			area.style.position = 'fixed';
			area.style.opacity = '0';
			document.body.appendChild(area);
			area.select();
			let ok = false;
			try { ok = document.execCommand('copy'); } catch { ok = false; }
			area.remove();
			toast(ok ? done : 'Não foi possível copiar.');
		};
		try {
			navigator.clipboard.writeText(text).then(() => toast(done), fallback);
		} catch {
			fallback();
		}
	}

	function setView(view) {
		S.view = view;
		S.menu = false;
		remember();
		render();
	}

	function openChart(id) {
		if (!chartById(id)) { return; }
		S.chartSel = id;
		S.showCalc = false;
		setView('charts');
	}

	function undoText(stepId, last) {
		if (last) { return 'Desfaça o último passo'; }
		const s = steps().find(x => x.id === stepId);
		return `Desfaça o passo ${stepId}${s?.text ? ` (${s.text})` : ''}`;
	}

	/** The filter of a chart bar: the bar's group and the chart's own filters (when they read back as filters). */
	function barFilter(c, i) {
		const label = c.labels[i];
		if (!c.x?.column || label === undefined || ['Outros', '(vazio)'].includes(label)) { return null; }
		const own = arr(c.calc?.filter).filter(f => /^[^=<>!]+?\s(=|!=|>|>=|<|<=)\s.+$/.test(f) && !/^(mês|dia|hora|semana|ano|trimestre) de /.test(f));
		return [`${c.x.column} = ${label}`].concat(own).join(' e ');
	}

	function onClick(event) {
		const el = event.target.closest('[data-act]');
		if (S.menu && !event.target.closest('.ss-menu') && !(el && el.dataset.act === 'menu')) {
			S.menu = false;
			render();
		}
		if (!el || el.disabled || (el.tagName === 'INPUT' && !['radio', 'checkbox'].includes(el.type)) || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') { return; }
		const d = el.dataset;
		switch (d.act) {
			case 'view':
				if (d.view === 'charts') { S.showCalc = false; }
				setView(d.view);
				break;
			case 'menu':
				S.menu = !S.menu;
				S.menuX = el.getBoundingClientRect().left;
				render();
				break;
			case 'stop':
				host.postMessage({ type: 'stop' });
				toast('Pedi ao agente para parar a leitura.');
				break;
			case 'file':
				S.fileSel = d.path;
				render();
				break;
			case 'file-open':
				act(`Abra a planilha ${d.path}`);
				break;
			case 'files-find':
				act('Liste as planilhas do projeto');
				break;
			case 'example':
				fill(d.text || '');
				break;
			case 'open-editor':
				host.postMessage({ type: 'openFile', path: d.path });
				break;
			case 'sheet-tab':
				act(`Abra a aba ${d.name} da planilha ${fileInfo().path}`);
				break;
			case 'cell': {
				const row = arr(S.grid?.rows)[Number(d.r)];
				const col = gridColumns()[Number(d.c)];
				if (row && col) { S.cell = { row: row[0], key: col.key }; render(); }
				break;
			}
			case 'col':
				S.colSel = S.colSel === d.key ? null : d.key;
				remember();
				render();
				break;
			case 'filter-x': {
				const rest = arr(S.grid?.filter).filter((_, i) => i !== Number(d.i));
				act(rest.length ? `Filtre a tabela: ${rest.join(' e ')}` : 'Mostre todas as linhas da tabela, sem filtro');
				break;
			}
			case 'filter-clear':
				act('Mostre todas as linhas da tabela, sem filtro');
				break;
			case 'more-rows': {
				const g = S.grid || {};
				const next = (num(g.offset) || 0) + arr(g.rows).length;
				act(`Mostre as próximas ${nf(num(g.limit) || 500)} linhas da tabela, a partir da ${nf(next + 1)}ª${arr(g.filter).length ? `, com o filtro ${arr(g.filter).join(' e ')}` : ''}`);
				break;
			}
			case 'chart':
				S.chartSel = d.id;
				S.showCalc = false;
				remember();
				render();
				break;
			case 'chart-open':
				openChart(d.id);
				break;
			case 'calc-toggle':
				S.showCalc = !S.showCalc;
				render();
				break;
			case 'copy-sql': {
				const c = selectedChart();
				if (c?.calc?.sql) { copy(c.calc.sql, 'SQL copiado.'); }
				break;
			}
			case 'chart-ask': {
				const c = chartById(d.id);
				if (c) { fill(`Sobre o gráfico ${c.id} (${c.title}): `); }
				break;
			}
			case 'redo': {
				const c = chartById(d.id);
				if (c) { act(redoText(c)); }
				break;
			}
			case 'redo-all': {
				const stale = S.charts.filter(c => scopeOf(c) === 'here' && isStale(c));
				if (stale.length === 1) { act(redoText(stale[0])); } else if (stale.length) { act(redoAllText(stale)); }
				break;
			}
			case 'panel-redo': {
				const dash = S.dashboard || {};
				act(`Monte de novo o painel "${dash.title || 'Painel'}" com a visão limpa: os números ${arr(dash.numbers).map(n => `"${n.title}" (${String(n.note || '').replace(/:.*$/, '').toLowerCase()})`).join(', ')} e os gráficos ${arr(dash.charts).join(', ')}`);
				break;
			}
			case 'bar': {
				const c = chartById(d.id || d.chart);
				const text = c ? barFilter(c, Number(d.i)) : null;
				if (text) { act(`Filtre a tabela: ${text}`); }
				break;
			}
			case 'scan':
				act('Procure problemas nos dados');
				break;
			case 'fix-all': {
				const n = arr(S.cleanup?.problems).filter(p => !p.applied && p.fix).length;
				act(n === 1 ? fixText(arr(S.cleanup.problems).find(p => !p.applied && p.fix)) : `Aplique as ${n} correções`);
				break;
			}
			case 'fix-one': {
				const p = arr(S.cleanup?.problems).find(x => x.id === d.id);
				if (p) { act(fixText(p)); }
				break;
			}
			case 'undo':
				act(undoText(d.step, d.last === '1'));
				break;
			case 'undo-all':
				act('Desfaça todos os passos da limpeza');
				break;
			case 'hist':
				S.histSel = Number(d.i);
				render();
				break;
			case 'prof':
				S.profSel = d.key;
				remember();
				render();
				break;
			case 'prof-ask': {
				const c = colByKey(d.key);
				if (c) { fill(`Sobre a coluna ${c.name}: `); }
				break;
			}
			case 'set-nav': {
				S.setSection = d.id;
				S.setPicked = true;
				render();
				requestAnimationFrame(() => document.querySelector(`[data-section="${d.id}"]`)?.scrollIntoView({ block: 'nearest' }));
				break;
			}
			case 'set-cancel':
				S.setDraft = {};
				render();
				break;
			case 'set-reset':
				act('Volte as configurações do SheetStudio para o padrão: decimal automático (auto), datas automáticas (auto), CSV com ; e vírgula decimal (br), pasta de exportação padrão, 500 linhas na planilha');
				break;
			case 'set-save': {
				const parts = changedKeys().map(key => {
					const value = S.setDraft[key];
					const label = (SET_OPTIONS[key] || []).find(([v]) => String(v) === String(value))?.[1];
					return key === 'decimal' ? `decimal ${label} (${value})` : key === 'dateOrder' ? `datas ${label} (${value})` : key === 'csvStyle' ? `CSV com ${label} (${value})` : key === 'gridRows' ? `${nf(Number(value))} linhas na planilha` : `pasta de exportação ${value || 'padrão'}`;
				});
				if (parts.length) {
					act(`Mude as configurações do SheetStudio: ${joinPt(parts)}`);
					S.setDraft = {};
				}
				break;
			}
			case 'csv-reopen': {
				const parts = csvChanged().map(key => {
					const v = S.csvDraft[key];
					if (key === 'separator') { return `separador ${v === '\t' ? 'tab' : `"${v}"`}`; }
					if (key === 'encoding') { return `codificação ${v}`; }
					if (key === 'decimal') { return `decimal ${(SET_OPTIONS.decimal.find(([x]) => x === v) || [])[1] || v} (${v})`; }
					return v ? 'a linha 1 como cabeçalho (header true)' : 'sem cabeçalho (header false)';
				});
				if (parts.length) { act(`Abra de novo a planilha ${fileInfo().path} com ${joinPt(parts)}`); S.csvDraft = {}; }
				break;
			}
			case 'export-open':
				S.menu = false;
				if (!isOpen()) { break; }
				S.exporting = d.id && chartById(d.id) ? { chart: d.id, svg: true, csv: false, xlsx: false } : { chart: null, svg: false, csv: basis() === 'clean', xlsx: true };
				render();
				break;
			case 'export-opt':
				if (S.exporting) { S.exporting[d.key] = el.checked; render(); }
				break;
			case 'export-close':
				S.exporting = null;
				render();
				break;
			case 'export-go': {
				const parts = exportOptions().filter(o => S.exporting?.[o.key]).map(o => o.ask);
				S.exporting = null;
				if (parts.length) { act(`Exporte ${joinPt(parts)}`); } else { render(); }
				break;
			}
		}
	}

	function onInput(event) {
		const el = event.target;
		if (el.dataset.act === 'hist-text') { S.histText = el.value; render(); }
		if (el.dataset.act === 'set-folder') { S.setDraft.exportFolder = el.value; render(); }
	}

	function onChange(event) {
		const el = event.target;
		switch (el.dataset.act) {
			case 'kind': {
				const c = chartById(el.dataset.id);
				if (c && el.value !== c.kind && KINDS[el.value]) {
					act(`Refaça o gráfico ${c.id} como ${KINDS[el.value].phrase}: ${specText(c)}${c.title ? `, com o título "${c.title}"` : ''}`);
				}
				break;
			}
			case 'hist-filter': S.histFilter = el.value; render(); break;
			case 'set': S.setDraft[el.dataset.key] = el.dataset.key === 'gridRows' ? Number(el.value) : el.value; render(); break;
			case 'csv-opt': S.csvDraft[el.dataset.key] = el.value; render(); break;
			case 'csv-header': S.csvDraft.header = el.checked; render(); break;
		}
	}

	/** Tooltips for chart marks: one floating box, moved with the mouse; it never changes the page's layout. */
	function onMove(event) {
		const studio = document.querySelector('.ss-studio');
		let tip = document.getElementById('ss-tip');
		const target = event.target.closest && event.target.closest('[data-tt]');
		if (!target || !studio) {
			if (tip) { tip.remove(); }
			return;
		}
		const data = parse(target.getAttribute('data-tt'));
		if (!data) { return; }
		if (!tip) {
			tip = document.createElement('div');
			tip.id = 'ss-tip';
			tip.className = 'ss-tt';
			studio.appendChild(tip);
		}
		tip.innerHTML = `<b>${esc(data.t)}</b>${arr(data.r).map(([k, v, color]) => `<div><span>${color ? `<i style="background:${esc(color)}"></i>` : ''}${esc(k)}</span><span>${esc(v)}</span></div>`).join('')}`;
		const box = studio.getBoundingClientRect();
		const w = tip.offsetWidth, h = tip.offsetHeight;
		let x = event.clientX - box.left + 14, y = event.clientY - box.top + 14;
		if (x + w > box.width - 4) { x = event.clientX - box.left - w - 14; }
		if (y + h > box.height - 4) { y = event.clientY - box.top - h - 14; }
		tip.style.left = `${Math.max(4, x)}px`;
		tip.style.top = `${Math.max(4, y)}px`;
	}

	// ------------------------------------------------------------------ host messages

	/** Follows a selection the agent pointed at with focus (view.json): a chart id, a column or a problem. */
	function applySelect(view, select) {
		if (!select) { return; }
		const text = String(select);
		const chart = S.charts.find(c => fold(c.id) === fold(text));
		if ((view === 'charts' || view === 'panel' || view === 'history') && chart) {
			S.chartSel = chart.id;
			S.showCalc = false;
			if (view === 'panel') { S.panelPick = chart.id; }
			if (view === 'history') { const i = S.history.findIndex(e => e.chart === chart.id); if (i >= 0) { S.histSel = i; } }
		}
		const column = findColumn(text);
		if (view === 'sheet' && column) { S.colSel = column.key; S.cell = null; }
		if (view === 'profile' && column) { S.profSel = column.key; }
		if (view === 'cleanup') { S.probSel = arr(S.cleanup?.problems).find(p => fold(p.id) === fold(text))?.id || null; }
		if (view === 'files') { S.fileSel = found().find(f => f.path === text)?.path || S.fileSel; }
	}

	function readFiles(files) {
		const json = name => (typeof files[name] === 'string' ? parse(files[name]) : undefined);
		const sheet = obj(json('sheet.json'));
		const sheetChanged = sheet?.sheet?.id !== S.sheet?.sheet?.id;
		S.sheet = sheet;
		S.grid = obj(json('grid.json'));
		const charts = obj(json('charts.json'));
		S.charts = arr(charts?.charts).filter(c => obj(c) && c.id).map(c => ({ ...c, labels: arr(c.labels).map(l => l === null ? '(vazio)' : String(l)), series: arr(c.series).filter(obj).map(s => ({ ...s, name: String(s.name ?? ''), values: arr(s.values) })), calc: obj(c.calc) || {} }));
		S.dashboard = obj(charts?.dashboard);
		S.cleanup = obj(json('cleanup.json'));
		S.history = arr(json('history.json')?.entries).filter(obj);
		const st = obj(json('settings.json'));
		S.settings = { ...SETTINGS, ...(st || {}) };
		S.hasSettings = !!st;
		if (sheetChanged || fileInfo().path !== S.csvPath) { S.cell = null; S.csvDraft = {}; S.csvPath = fileInfo().path; }
		if (S.histSel !== null && !S.history[S.histSel]) { S.histSel = null; }
		const view = obj(json('view.json'));
		if (view && typeof view.revision === 'number' && view.revision !== S.viewRevision) {
			const first = S.viewRevision === 0 && saved.viewRevision === view.revision;
			S.viewRevision = view.revision;
			if (!first) {
				if (VIEWS[view.view]) {
					S.view = view.view;
					S.menu = false;
					S.exporting = null;
					if (view.view === 'charts') { S.showCalc = false; }
					if (view.view === 'sheet') { S.colSel = null; }
				}
				applySelect(view.view, view.select);
				if (typeof view.note === 'string' && view.note.trim()) { toast(view.note.trim()); }
				remember();
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
				toast(typeof msg.message === 'string' ? msg.message : 'Não foi possível atualizar o SheetStudio.');
				break;
			case 'running':
				S.running = !!msg.running;
				if (!S.running) { S.pending = null; }
				render();
				break;
			case 'request':
				if (S.pending && S.pending.requestId === msg.requestId && ['settled', 'rejected', 'unconfirmed'].includes(msg.state)) {
					if (msg.state === 'rejected') { toast('O agente está ocupado. Tente de novo quando ele terminar.'); }
					S.pending = null;
					render();
				}
				break;
		}
	});

	document.addEventListener('click', onClick);
	// A double click on a file in the list asks the agent to open it.
	document.addEventListener('dblclick', event => {
		const row = event.target.closest('.ss-file[data-path]');
		if (row) { act(`Abra a planilha ${row.dataset.path}`); }
	});
	document.addEventListener('input', onInput);
	document.addEventListener('change', onChange);
	document.addEventListener('mousemove', onMove);
	document.addEventListener('mouseleave', () => document.getElementById('ss-tip')?.remove());
	document.addEventListener('keydown', event => {
		if (event.key === 'Escape' && (S.exporting || S.menu)) { S.exporting = null; S.menu = false; render(); }
	});
	window.addEventListener('resize', () => render());

	render();
	host.postMessage({ type: 'ready' });
})();
