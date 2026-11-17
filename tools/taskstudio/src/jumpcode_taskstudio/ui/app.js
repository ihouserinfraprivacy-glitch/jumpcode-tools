/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// TaskStudio Studio interface: plain JavaScript, no libraries, no network. It reads the Studio
// JSON files the host sends (plan, proposal, history, view) and draws the plan as linked task
// cards and in several other modes. It never writes files: every change the user makes becomes a
// chat message (`ask`), and the only direct effect on the agent is `stop`. All visible text is in
// Brazilian Portuguese.
(function () {
	'use strict';

	/** @type {{ postMessage(m: object): void, getState(): any, setState(s: any): void }} */
	const host = typeof acquireVsCodeApi === 'function'
		? acquireVsCodeApi()
		: { postMessage() { }, getState() { return undefined; }, setState() { } };

	// ------------------------------------------------------------------ constants

	const MODES = {
		map: { label: 'Mapa', icon: 'map', main: true },
		list: { label: 'Lista', icon: 'list', main: true },
		board: { label: 'Quadro', icon: 'board', main: true },
		timeline: { label: 'Linha do tempo', icon: 'calendar', main: true },
		lanes: { label: 'Raias', icon: 'lanes', hint: 'Colunas por área' },
		metro: { label: 'Linhas', icon: 'metro', hint: 'Uma linha por área, como num mapa de metrô' },
		focus: { label: 'Foco', icon: 'target', hint: 'Só a tarefa que está rodando, sem o chat' },
		history: { label: 'Histórico', icon: 'history', hint: 'As versões do plano e o que mudou' },
		compare: { label: 'Antes e depois', icon: 'compare', hint: 'O plano atual e o proposto lado a lado' },
	};

	/** Display states: label, icon and icon colour class. */
	const ST = {
		done: { label: 'Concluída', icon: 'passed', c: 'c-green', word: 'concluída' },
		run: { label: 'Executando', icon: 'spinner', c: 'c-bar', word: 'executando' },
		pause: { label: 'Pausada', icon: 'pause', c: 'c-rose', word: 'pausada' },
		you: { label: 'Precisa de você', icon: 'person', c: 'c-rose', word: 'precisa de você' },
		bad: { label: 'Com problema', icon: 'error', c: 'c-red', word: 'com problema' },
		wait: { label: 'Aguardando', icon: 'clock', c: 'c-grey', word: 'aguardando' },
		ready: { label: 'Pronta', icon: 'playCircle', c: 'c-bar', word: 'pronta' },
		skip: { label: 'Para depois', icon: 'skip', c: 'c-grey', word: 'para depois' },
		draft: { label: 'Definida', icon: 'pencil', c: 'c-grey', word: 'definida' },
		check: { label: 'Analisando', icon: 'spinner', c: 'c-rose', word: 'analisando' },
		changed: { label: 'Mudou', icon: 'pencil', c: 'c-rose', word: 'mudou' },
	};

	/** Recalibration kinds: badge text, group title, verb for the history. */
	const KINDS = {
		refazer: { label: 'Refazer', group: 'Refazer · já concluídas', done: 'refeita', many: 'refeitas' },
		ajustar: { label: 'Ajustar', group: 'Ajustar · estavam executando', done: 'ajustada', many: 'ajustadas' },
		alterar: { label: 'Alterar', group: 'Alterar · ainda não feitas', done: 'alterada', many: 'alteradas' },
		nova: { label: 'Nova', group: 'Nova', done: 'nova', many: 'novas' },
		remover: { label: 'Remover', group: 'Remover', done: 'removida', many: 'removidas' },
	};
	const KIND_ORDER = ['refazer', 'ajustar', 'alterar', 'nova', 'remover'];
	const METRO_COLORS = ['#E0782F', '#4C8DFF', '#2BB3C0', '#C58AF0', '#D466A8', '#5DB653', '#A0A0A0', '#E0605A'];

	const ICONS = {
		map: '<rect x="1.5" y="1.8" width="5" height="3.6"/><rect x="9.5" y="1.8" width="5" height="3.6"/><rect x="5.5" y="10.6" width="5" height="3.6"/><path d="M4 5.4v2.6h8V5.4M8 8v2.6"/>',
		list: '<path d="M6.2 4h7.8M6.2 8h7.8M6.2 12h7.8"/><path d="M2.4 2.8h.9v2.6M2.2 10.8h1.4l-1.4 2h1.5"/>',
		board: '<rect x="1.8" y="2.2" width="5.4" height="11.6"/><rect x="8.8" y="2.2" width="5.4" height="6.8"/>',
		calendar: '<rect x="1.8" y="2.8" width="12.4" height="11"/><path d="M1.8 5.8h12.4M5 1.6v2.2M11 1.6v2.2M4 8.4h1.6M7.2 8.4h1.6M10.4 8.4H12M4 11h1.6M7.2 11h1.6"/>',
		lanes: '<rect x="1.8" y="2.2" width="12.4" height="11.6"/><path d="M8 2.2v11.6"/>',
		metro: '<circle cx="4" cy="3.8" r="1.7"/><circle cx="4" cy="12.2" r="1.7"/><circle cx="12" cy="8" r="1.7"/><path d="M4 5.5v5M5.5 4.6l5 2.6"/>',
		target: '<circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="3"/><circle cx="8" cy="8" r=".7" fill="currentColor"/>',
		history: '<path d="M3 4.6A5.8 5.8 0 1 1 2.2 8"/><path d="M2.6 1.9v2.9h2.9M8 4.8V8l2.2 1.5"/>',
		clock: '<path d="M3 4.6A5.8 5.8 0 1 1 2.2 8"/><path d="M2.6 1.9v2.9h2.9M8 4.8V8l2.2 1.5"/>',
		compare: '<rect x="1.8" y="2.2" width="5.4" height="11.6"/><rect x="8.8" y="2.2" width="5.4" height="11.6"/><path d="M3.4 5.4h2.2M10.4 5.4h2.2M3.4 8h2.2M10.4 8h2.2"/>',
		search: '<circle cx="7" cy="7" r="4.6"/><path d="m10.4 10.4 3.6 3.6"/>',
		zoomIn: '<path d="M3 8h10M8 3v10"/>',
		zoomOut: '<path d="M3 8h10"/>',
		fit: '<path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/>',
		check: '<path d="m3 8.4 3.1 3.1L13 4.6"/>',
		chevD: '<path d="M3.5 6 8 10.5 12.5 6"/>',
		chevR: '<path d="m6 3.5 4.5 4.5L6 12.5"/>',
		close: '<path d="m4 4 8 8M12 4l-8 8"/>',
		more: '<circle cx="3.6" cy="8" r="1.1" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none"/><circle cx="12.4" cy="8" r="1.1" fill="currentColor" stroke="none"/>',
		pause: '<path d="M5.5 3v10M10.5 3v10"/>',
		play: '<path d="M4.6 2.8v10.4L13 8z"/>',
		playCircle: '<circle cx="8" cy="8" r="6"/><path d="M6.6 5.4v5.2L10.6 8z"/>',
		resume: '<path d="M3.4 3v10"/><path d="M6.4 3v10L13.6 8z"/>',
		spinner: '<path d="M13.6 8A5.6 5.6 0 0 1 2.4 8"/>',
		passed: '<circle cx="8" cy="8" r="6.4" fill="currentColor" stroke="none"/><path d="m5.1 8.2 2 2 3.9-4.1" stroke="#FFFFFF" stroke-width="1.6"/>',
		circle: '<circle cx="8" cy="8" r="5.6"/>',
		error: '<circle cx="8" cy="8" r="6"/><path d="m5.7 5.7 4.6 4.6M10.3 5.7l-4.6 4.6"/>',
		person: '<circle cx="8" cy="4" r="2"/><path d="M5.4 14V9.6c0-1.5 1.1-2.8 2.6-2.8s2.6 1.3 2.6 2.8V14"/>',
		lock: '<rect x="3.2" y="7" width="9.6" height="7"/><path d="M5.4 7V5.2a2.6 2.6 0 0 1 5.2 0V7M8 9.8v1.6"/>',
		unlock: '<rect x="3.2" y="7" width="9.6" height="7"/><path d="M5.4 7V5.2a2.6 2.6 0 0 1 5-1M8 9.8v1.6"/>',
		pencil: '<path d="M11 2.4 13.6 5 5.8 12.8l-3.4.8.8-3.4z"/><path d="m9.6 3.8 2.6 2.6"/>',
		skip: '<path d="M2.4 10A5.6 5.6 0 0 1 12.8 6.6"/><path d="M13.4 3.4v3.4H10"/><rect x="6.8" y="11.4" width="2.4" height="2.4"/>',
		sync: '<path d="M13.2 6.6A5.4 5.4 0 0 0 3.4 5M2.8 9.4A5.4 5.4 0 0 0 12.6 11M3.4 2.2V5h2.8M12.6 13.8V11H9.8"/>',
		info: '<circle cx="8" cy="8" r="6"/><path d="M8 7.2v4M8 4.8h.01"/>',
		warning: '<path d="M8 2 14.4 13.6H1.6z"/><path d="M8 6.4v3.4M8 11.8h.01"/>',
		shield: '<path d="M8 1.8 13 3.6v4c0 3.2-2.2 5.6-5 6.6-2.8-1-5-3.4-5-6.6v-4z"/><path d="m5.8 8 1.6 1.6 3-3.2"/>',
		key: '<circle cx="5" cy="11" r="2.8"/><path d="m7 9 6-6M11 5l1.6 1.6M9.4 6.6 11 8.2"/>',
		arrowR: '<path d="M2.6 8h10.4M9.4 4.4 13 8l-3.6 3.6"/>',
		discard: '<path d="M4 6.4h6a3.4 3.4 0 0 1 0 6.8H6.6"/><path d="M6.6 3.6 3.8 6.4l2.8 2.8"/>',
		checklist: '<path d="m2.2 4.2 1 1 1.8-2M7.4 4.2h6.4M2.2 8.6l1 1 1.8-2M7.4 8.6h6.4M7.4 13h6.4M3 13h1.4"/>',
		export: '<path d="M2.6 3v10M5 8h8.4M10.6 5.2 13.4 8l-2.8 2.8"/>',
		files: '<path d="M5.4 4.2V1.8h5l2.8 2.8v7.4h-2.4"/><path d="M2.8 4.2h5l2.8 2.8v7.2H2.8z"/>',
		comment: '<path d="M2.2 2.8h11.6v8H7.2l-3 2.6v-2.6h-2z"/>',
		library: '<path d="M2.4 2.4v11.2M5.4 2.4v11.2M8.6 2.8l3.2 10.8"/>',
		bug: '<rect x="4.6" y="5" width="6.8" height="8.4"/><path d="M6 5V3.6h4V5M4.6 8H2.2M13.8 8h-2.4M4.6 11.2H2.6M13.4 11.2h-2M8 5v8.4"/>',
		bulb: '<path d="M5.6 11.6C4.2 10.6 3.4 9.2 3.4 7.6a4.6 4.6 0 0 1 9.2 0c0 1.6-.8 3-2.2 4z"/><path d="M6 13.8h4"/>',
		database: '<ellipse cx="8" cy="3.8" rx="5" ry="1.9"/><path d="M3 3.8v8.4c0 1.05 2.24 1.9 5 1.9s5-.85 5-1.9V3.8M3 8c0 1.05 2.24 1.9 5 1.9s5-.85 5-1.9"/>',
		server: '<rect x="2.2" y="2.4" width="11.6" height="4.6"/><rect x="2.2" y="9" width="11.6" height="4.6"/><path d="M4.6 4.7h.01M4.6 11.3h.01"/>',
		window: '<rect x="1.8" y="2.6" width="12.4" height="10.8"/><path d="M1.8 5.6h12.4"/>',
		plug: '<path d="M6 1.8v3M10 1.8v3M4.2 4.8h7.6v2.6a3.8 3.8 0 0 1-7.6 0zM8 11.2v3"/>',
		rocket: '<path d="M9.6 2.2c2.4 0 4.2 1.8 4.2 4.2L8.6 11.6 4.4 7.4z"/><path d="M4.4 7.4 2 7.6l2.4-2.8h3M8.6 11.6 8.4 14l2.8-2.4v-3M4.6 11.4l-2.4 2.4"/>',
		folder: '<path d="M1.8 3.6h4.1l1.5 1.6h6.8v7.5H1.8z"/>',
		wand: '<path d="M2.4 13.6 10 6M9 3.4V1.8M12.6 7V5.4M11.4 4.6l1.2-1.2M12.6 1.8"/><path d="m9.2 5.2 1.6 1.6"/>',
		x: '<path d="m4 4 8 8M12 4l-8 8"/>',
	};

	// ------------------------------------------------------------------ small helpers

	const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' };
	const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ESC[c]);
	const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
	const r1 = v => Math.round(v * 10) / 10;
	const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
	const str = (v, max) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '').trim().slice(0, max);
	const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
	const nid = v => String(v ?? '').replace(/^#/, '').trim();

	function icon(name, cls = '') {
		const spin = name === 'spinner' ? ' spin' : '';
		return `<svg class="ts-ic${cls ? ` ${cls}` : ''}${spin}" viewBox="0 0 16 16" aria-hidden="true">${ICONS[name] ?? ICONS.circle}</svg>`;
	}

	function logo(size = 16) {
		return `<svg width="${size}" height="${size}" viewBox="0 0 100 100" aria-hidden="true"><rect width="100" height="100" rx="18" fill="#E0782F"/><path d="M30,28V72" stroke="#fff" stroke-width="5" opacity=".55"/><circle cx="30" cy="28" r="10" fill="#fff"/><path d="M25,28.5l3.5,3.5l6.5,-7" fill="none" stroke="#E0782F" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="30" cy="50" r="10" fill="#fff"/><path d="M25,50.5l3.5,3.5l6.5,-7" fill="none" stroke="#E0782F" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="30" cy="72" r="8" fill="#E0782F" stroke="#fff" stroke-width="4.5"/><rect x="49" y="23" width="36" height="10" fill="#fff"/><rect x="49" y="45" width="30" height="10" fill="#fff"/><rect x="49" y="67" width="34" height="10" fill="#fff" opacity=".55"/></svg>`;
	}

	const $ = sel => document.querySelector(sel);

	function parseTime(iso) {
		const t = Date.parse(iso ?? '');
		return Number.isFinite(t) ? t : null;
	}

	function hhmm(ms) {
		if (ms === null || ms === undefined) {
			return '';
		}
		const d = new Date(ms);
		return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
	}

	const at = iso => hhmm(parseTime(iso));

	/** "4 min", "1 h 12 min". */
	function dur(min) {
		min = Math.max(0, Math.round(min));
		if (min < 60) {
			return `${min} min`;
		}
		const h = Math.floor(min / 60), m = min % 60;
		return m ? `${h} h ${m} min` : `${h} h`;
	}

	function minutesBetween(a, b) {
		return a !== null && b !== null ? Math.max(0, (b - a) / 60000) : null;
	}

	/** Gate label without the trailing parenthesis, for the map ("Chave Pix de teste"). */
	function shortLabel(label) {
		const s = String(label ?? '').replace(/\s*\([^)]*\)\s*$/, '').trim();
		return s || String(label ?? '');
	}

	function lowerFirst(s) {
		return s && /^[A-ZÁÉÍÓÚÂÊÔÃÕÇ][a-záéíóúâêôãõç]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
	}

	function joinIds(ids) {
		const refs = ids.map(id => `#${id}`);
		return refs.length <= 1 ? refs.join('') : `${refs.slice(0, -1).join(', ')} e ${refs[refs.length - 1]}`;
	}

	// ------------------------------------------------------------------ word diff (track changes)

	/** Words, runs of spaces and single punctuation marks, so "duração." vs "duração somados." keeps "duração". */
	function tokens(s) {
		return String(s ?? '').match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
	}

	/** Word-level diff: a list of [op, text] with op 'eq', 'del' or 'ins'. */
	function wordDiff(a, b) {
		const A = tokens(a), B = tokens(b);
		let p = 0;
		while (p < A.length && p < B.length && A[p] === B[p]) {
			p++;
		}
		let s = 0;
		while (s < A.length - p && s < B.length - p && A[A.length - 1 - s] === B[B.length - 1 - s]) {
			s++;
		}
		const a2 = A.slice(p, A.length - s), b2 = B.slice(p, B.length - s);
		const n = a2.length, m = b2.length;
		const mid = [];
		if (n && m && n * m <= 160000) {
			const w = m + 1;
			const L = new Uint16Array((n + 1) * w);
			for (let i = n - 1; i >= 0; i--) {
				for (let j = m - 1; j >= 0; j--) {
					L[i * w + j] = a2[i] === b2[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
				}
			}
			let i = 0, j = 0;
			while (i < n && j < m) {
				if (a2[i] === b2[j]) {
					mid.push(['eq', a2[i++]]);
					j++;
				} else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) {
					mid.push(['del', a2[i++]]);
				} else {
					mid.push(['ins', b2[j++]]);
				}
			}
			while (i < n) {
				mid.push(['del', a2[i++]]);
			}
			while (j < m) {
				mid.push(['ins', b2[j++]]);
			}
		} else {
			if (n) {
				mid.push(['del', a2.join('')]);
			}
			if (m) {
				mid.push(['ins', b2.join('')]);
			}
		}
		const raw = [['eq', A.slice(0, p).join('')], ...mid, ['eq', A.slice(A.length - s).join('')]].filter(x => x[1]);
		// A run of changes becomes one removed block and one inserted block; whitespace between two
		// changes belongs to both, so a replaced phrase reads as one piece.
		const out = [];
		let del = '', ins = '';
		const flush = () => {
			if (del) {
				out.push(['del', del]);
			}
			if (ins) {
				out.push(['ins', ins]);
			}
			del = ins = '';
		};
		for (let k = 0; k < raw.length; k++) {
			const [op, text] = raw[k];
			if (op === 'del') {
				del += text;
			} else if (op === 'ins') {
				ins += text;
			} else if ((del || ins) && /^\s+$/.test(text) && raw[k + 1] && raw[k + 1][0] !== 'eq') {
				del += text;
				ins += text;
			} else {
				flush();
				const last = out[out.length - 1];
				if (last && last[0] === 'eq') {
					last[1] += text;
				} else {
					out.push(['eq', text]);
				}
			}
		}
		flush();
		return out;
	}

	/** Track changes: removed text struck through, inserted text underlined. `only` keeps one side. */
	function diffHtml(a, b, only) {
		return wordDiff(a, b).map(([op, text]) => {
			if (op === 'eq') {
				return esc(text);
			}
			if (op === 'del') {
				return only === 'ins' ? '' : `<del>${esc(text)}</del>`;
			}
			return only === 'del' ? '' : `<ins>${esc(text)}</ins>`;
		}).join('');
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
		bad: new Set(),
		filesError: null,
		plan: null,
		proposal: null,
		history: null,
		view: null,
		running: false,
		requests: new Set(),
		D: null,
		mode: MODES[saved.mode] ? saved.mode : 'map',
		prevMode: 'map',
		sel: typeof saved.sel === 'string' ? saved.sel : null,
		vp: saved.vp && typeof saved.vp === 'object' ? saved.vp : {},
		vpKey: null,
		opened: new Set(Array.isArray(saved.opened) ? saved.opened : []),
		closed: new Set(Array.isArray(saved.closed) ? saved.closed : []),
		edit: saved.edit && typeof saved.edit === 'object' && typeof saved.edit.id === 'string' ? saved.edit : null,
		gatePanel: null,
		keepProposal: false,
		finishedHidden: false,
		centerOn: null,
		timelineEnd: null,
		editFocus: null,
		recal: null,
		recalHidden: null,
		notes: [],
		search: { open: false, q: '', i: -1 },
		menu: null,
		histSel: typeof saved.histSel === 'number' ? saved.histSel : null,
		proposalSide: !!saved.proposalSide,
		proposalHidden: !!saved.proposalHidden,
		lastViewRev: saved.lastViewRev ?? null,
		focusOn: false,
		width: window.innerWidth,
		drawing: null,
		barLevel: 0,
	};

	let persistTimer = 0;
	function persist() {
		clearTimeout(persistTimer);
		persistTimer = setTimeout(() => {
			try {
				host.setState({
					mode: S.mode, sel: S.sel, vp: S.vp, opened: [...S.opened].slice(0, 40), closed: [...S.closed].slice(0, 40),
					edit: S.edit, histSel: S.histSel, proposalSide: S.proposalSide, proposalHidden: S.proposalHidden, lastViewRev: S.lastViewRev,
				});
			} catch {
				// The host may refuse the state; the interface keeps working without it.
			}
		}, 120);
	}

	// ------------------------------------------------------------------ plan index

	const STATES = new Set(['todo', 'running', 'paused', 'done', 'failed', 'skipped']);

	function normTask(raw, id) {
		const list = v => (Array.isArray(v) ? v : []);
		const progress = Number(raw.progress);
		const estimate = Number(raw.estimate);
		const problem = raw.problem && typeof raw.problem === 'object' ? {
			title: str(raw.problem.title, 200) || 'Problema',
			detail: str(raw.problem.detail, 2000),
			options: list(raw.problem.options).map(o => str(o, 200)).filter(Boolean).slice(0, 6),
			at: str(raw.problem.at, 40),
		} : null;
		const mark = raw.mark && typeof raw.mark === 'object' && KINDS[raw.mark.kind] ? { plan: Number(raw.mark.plan) || null, kind: raw.mark.kind, note: str(raw.mark.note, 400) } : null;
		return {
			id,
			title: str(raw.title, 120) || `Tarefa ${id}`,
			summary: str(raw.summary, 200),
			detail: str(raw.detail, 2400),
			criteria: list(raw.criteria).map(c => (typeof c === 'string' ? { text: str(c, 300), done: false } : c && typeof c === 'object' ? { text: str(c.text, 300), done: !!c.done } : null)).filter(c => c && c.text).slice(0, 30),
			rawDeps: list(raw.deps).map(nid).filter(Boolean),
			deps: [],
			gates: list(raw.gates).filter(g => g && typeof g === 'object').map((g, i) => ({
				id: str(g.id, 40) || `g${i + 1}`,
				kind: ['secret', 'approval', 'choice', 'other'].includes(g.kind) ? g.kind : 'other',
				label: str(g.label, 200) || 'Condição',
				met: !!g.met,
				where: str(g.where, 600),
				env: str(g.env, 80),
				alternatives: list(g.alternatives).map(a => str(a, 200)).filter(Boolean).slice(0, 6),
			})).slice(0, 8),
			area: str(raw.area, 60),
			phase: str(raw.phase, 80),
			estimate: Number.isFinite(estimate) && estimate > 0 ? Math.round(estimate) : null,
			state: STATES.has(raw.state) ? raw.state : 'todo',
			requestId: str(raw.requestId, 256),
			progress: Number.isFinite(progress) ? clamp(Math.round(progress), 0, 100) : null,
			now: str(raw.now, 200),
			startedAt: parseTime(raw.startedAt),
			finishedAt: parseTime(raw.finishedAt),
			pausedAt: parseTime(raw.pausedAt),
			result: str(raw.result, 1200),
			problem,
			log: list(raw.log).filter(l => l && typeof l === 'object').map(l => ({ at: parseTime(l.at), text: str(l.text, 400), kind: ['ok', 'error'].includes(l.kind) ? l.kind : 'info' })).filter(l => l.text).slice(-40),
			files: list(raw.files).map(f => (typeof f === 'string' ? { path: str(f, 300), state: 'done' } : f && typeof f === 'object' ? { path: str(f.path, 300), state: f.state === 'partial' ? 'partial' : 'done' } : null)).filter(f => f && f.path).slice(0, 60),
			mark,
		};
	}

	/** Builds the task index: tasks in plan order, dependencies, dependents, topological order and depth. */
	function buildIndex(plan) {
		const tasks = [];
		const by = new Map();
		for (const raw of Array.isArray(plan.tasks) ? plan.tasks : []) {
			if (!raw || typeof raw !== 'object') {
				continue;
			}
			const id = nid(raw.id);
			if (!id || by.has(id)) {
				continue;
			}
			const t = normTask(raw, id);
			tasks.push(t);
			by.set(id, t);
		}
		for (const t of tasks) {
			t.deps = [...new Set(t.rawDeps)].filter(d => d !== t.id && by.has(d));
		}
		const kids = new Map(tasks.map(t => [t.id, []]));
		for (const t of tasks) {
			for (const d of t.deps) {
				kids.get(d).push(t.id);
			}
		}
		const { order, depth } = topo(tasks.map(t => ({ id: t.id, deps: t.deps })));
		const idx = new Map(tasks.map((t, i) => [t.id, i]));
		return { tasks, by, kids, order, depth, idx };
	}

	/** Topological order (stable by list order) and longest-path depth; cycles are broken by list order. */
	function topo(nodes) {
		const by = new Map(nodes.map(n => [n.id, n]));
		const placed = new Set();
		const order = [];
		const depth = new Map();
		let progress = true;
		while (order.length < nodes.length && progress) {
			progress = false;
			for (const n of nodes) {
				if (placed.has(n.id) || !n.deps.every(d => placed.has(d) || !by.has(d))) {
					continue;
				}
				placed.add(n.id);
				order.push(n.id);
				depth.set(n.id, n.deps.reduce((m, d) => Math.max(m, (depth.get(d) ?? -1) + 1), 0));
				progress = true;
			}
		}
		for (const n of nodes) {
			if (!placed.has(n.id)) {
				placed.add(n.id);
				order.push(n.id);
				depth.set(n.id, n.deps.reduce((m, d) => Math.max(m, depth.has(d) ? depth.get(d) + 1 : 0), 0));
			}
		}
		return { order, depth };
	}

	const task = id => S.D?.by.get(id) ?? null;
	const satisfied = id => {
		const t = task(id);
		return !t || t.state === 'done' || t.state === 'skipped';
	};

	/** The display state of a task (contract order), without recalibration or proposal overlays. */
	function dispOf(t) {
		switch (t.state) {
			case 'done': return 'done';
			case 'failed': return 'bad';
			case 'skipped': return 'skip';
			case 'paused': return 'pause';
			case 'running': return t.requestId && S.requests.has(t.requestId) ? 'run' : 'pause';
		}
		if (t.deps.some(d => !satisfied(d))) {
			return 'wait';
		}
		if (t.gates.some(g => !g.met)) {
			return 'you';
		}
		return 'ready';
	}

	function refreshDisp() {
		const D = S.D;
		if (!D) {
			return;
		}
		D.disp = new Map(D.tasks.map(t => [t.id, dispOf(t)]));
		const c = { done: 0, run: 0, pause: 0, you: 0, bad: 0, wait: 0, ready: 0, skip: 0 };
		for (const k of D.disp.values()) {
			c[k]++;
		}
		D.counts = c;
		D.total = D.tasks.length;
		D.finished = D.total > 0 && c.done + c.skip === D.total;
		D.started = !!S.plan?.started || D.tasks.some(t => t.state !== 'todo');
	}

	const disp = t => S.D?.disp.get(t.id) ?? 'wait';
	const unmetGates = t => t.gates.filter(g => !g.met);
	const pendingDeps = t => t.deps.filter(d => !satisfied(d));
	const allDescendants = id => {
		const out = new Set();
		const stack = [...(S.D?.kids.get(id) ?? [])];
		while (stack.length) {
			const k = stack.pop();
			if (!out.has(k)) {
				out.add(k);
				stack.push(...(S.D.kids.get(k) ?? []));
			}
		}
		return [...out].sort((a, b) => S.D.idx.get(a) - S.D.idx.get(b));
	};

	function estText(t) {
		return t.estimate ? `~${dur(t.estimate)}` : '';
	}

	function tookText(t) {
		const m = minutesBetween(t.startedAt, t.finishedAt);
		return m !== null ? dur(Math.max(1, m)) : t.estimate ? dur(t.estimate) : '';
	}

	function remainingMinutes() {
		let sum = 0;
		for (const t of S.D?.tasks ?? []) {
			if (t.state === 'done' || t.state === 'skipped') {
				continue;
			}
			const e = t.estimate ?? 5;
			if (t.state === 'running' || t.state === 'paused') {
				sum += Math.max(1, e * (1 - (t.progress ?? 0) / 100));
			} else {
				sum += e;
			}
		}
		return Math.round(sum);
	}

	function totalEstimate() {
		return (S.D?.tasks ?? []).reduce((s, t) => s + (t.estimate ?? 0), 0);
	}

	/** The plan version shown in the bar: the newest history version, or plan.plan. */
	function planVersion() {
		const n = Number(S.plan?.plan);
		return Number.isFinite(n) && n > 0 ? n : 1;
	}

	// Recalibration and proposal overlays.

	function recalibrating() {
		const r = S.plan?.recalibrating;
		return r && typeof r === 'object' && task(nid(r.task)) ? r : null;
	}

	/** The recalibration dialog stays while the agent works on it; once it stops, its list (if any) is shown. */
	function recalOpen() {
		return !!recalibrating() && (recalRunning() || !S.proposal);
	}

	function recalRunning() {
		const id = recalibrating()?.requestId;
		return !!id && S.requests.has(id);
	}

	function impactSets(r) {
		const imp = r?.impact && typeof r.impact === 'object' ? r.impact : {};
		const ids = k => (Array.isArray(imp[k]) ? imp[k].map(nid).filter(id => task(id)) : []);
		return { done: ids('done'), running: ids('running'), todo: ids('todo') };
	}

	/** Proposal changes by task id (new tasks keep their package id). */
	function proposalIndex() {
		const p = S.proposal;
		if (!p) {
			return null;
		}
		const by = new Map();
		for (const c of p.changes) {
			by.set(c.task, c);
		}
		return by;
	}

	function normProposal(p) {
		if (!p || typeof p !== 'object' || !Array.isArray(p.changes)) {
			return null;
		}
		const changes = [];
		for (const raw of p.changes) {
			if (!raw || typeof raw !== 'object') {
				continue;
			}
			const kind = KINDS[raw.kind] ? raw.kind : (raw.remove ? 'remover' : 'alterar');
			const id = nid(raw.task);
			if (!id) {
				continue;
			}
			changes.push({
				task: id,
				kind,
				note: str(raw.note, 600),
				why: str(raw.why, 80),
				title: str(raw.title, 120),
				summary: str(raw.summary, 200),
				detail: str(raw.detail, 2400),
				deps: Array.isArray(raw.deps) ? raw.deps.map(nid).filter(Boolean) : null,
				estimate: Number(raw.estimate) > 0 ? Math.round(Number(raw.estimate)) : null,
			});
		}
		const plan = Number(p.plan);
		const base = Number(p.base);
		return {
			plan: Number.isFinite(plan) && plan > 0 ? plan : planVersion() + 1,
			base: Number.isFinite(base) && base > 0 ? base : planVersion(),
			baseRevision: Number(p.baseRevision) || null,
			states: p.states && typeof p.states === 'object' ? p.states : {},
			cause: p.cause && typeof p.cause === 'object' ? { task: nid(p.cause.task), text: str(p.cause.text, 600) } : null,
			summary: str(p.summary, 600),
			extra: Number.isFinite(Number(p.extra)) ? Math.round(Number(p.extra)) : null,
			// Written by edit itself: it redoes only the edited task until the agent proposes the rest.
			baseline: p.baseline === true,
			changes,
		};
	}

	function normHistory(h) {
		if (!h || typeof h !== 'object' || !Array.isArray(h.versions)) {
			return null;
		}
		const versions = h.versions.filter(v => v && typeof v === 'object' && Number(v.plan) > 0).map(v => ({
			plan: Number(v.plan),
			at: parseTime(v.at),
			reason: str(v.reason, 200),
			cause: v.cause && typeof v.cause === 'object' ? { task: nid(v.cause.task), text: str(v.cause.text, 600) } : null,
			changes: (Array.isArray(v.changes) ? v.changes : []).filter(c => c && typeof c === 'object').map(c => ({ task: nid(c.task), kind: KINDS[c.kind] ? c.kind : 'alterar', note: str(c.note, 600), title: str(c.title, 120) })),
			extra: Number.isFinite(Number(v.extra)) ? Math.round(Number(v.extra)) : null,
			tasks: (Array.isArray(v.tasks) ? v.tasks : []).filter(t => t && typeof t === 'object').map(t => ({ id: nid(t.id), title: str(t.title, 120), summary: str(t.summary, 200), state: str(t.state, 20), deps: Array.isArray(t.deps) ? t.deps.map(nid) : [], estimate: Number(t.estimate) > 0 ? Number(t.estimate) : null })),
		}));
		versions.sort((a, b) => a.plan - b.plan);
		return versions.length ? { versions } : null;
	}

	/**
	 * True when the proposal is shown as a dialog first: the user changed a task that was not done,
	 * yet the change redoes work that was already done, which deserves more attention than a side list.
	 */
	function proposalTouchesDone() {
		const p = S.proposal;
		if (!p) {
			return false;
		}
		const causeKind = p.changes.find(c => c.task === p.cause?.task)?.kind;
		return causeKind !== 'refazer' && p.changes.some(c => c.kind === 'refazer' && c.task !== p.cause?.task);
	}

	/** Tasks whose state changed since the proposal was made (apply would be refused). */
	function staleProposalTasks() {
		const p = S.proposal;
		if (!p) {
			return [];
		}
		return Object.keys(p.states).filter(id => task(id) && task(id).state !== p.states[id]);
	}

	// ------------------------------------------------------------------ shared pieces

	function numBox(t, k) {
		const cls = { done: 'n-done', run: 'n-run', pause: 'n-pause', you: 'n-you', bad: 'n-bad', check: 'n-pause', changed: 'n-pause' }[k] ?? '';
		const inner = k === 'done' ? icon('check') : k === 'run' ? icon('spinner') : k === 'bad' ? '!' : esc(t.id);
		const wide = typeof inner === 'string' && /^[\w-]+$/.test(inner) && inner.length > 2;
		return `<span class="ts-num${wide ? ' wide' : ''}${cls ? ` ${cls}` : ''}">${inner}</span>`;
	}

	function pill(k, label) {
		const s = ST[k] ?? ST.wait;
		return `<span class="ts-pill">${icon(s.icon, s.c)}${esc(label ?? s.label)}</span>`;
	}

	function progressBar(p) {
		return `<span class="ts-bar2" role="progressbar" aria-valuenow="${p}" aria-valuemin="0" aria-valuemax="100"><i style="width:${clamp(p, 0, 100)}%"></i></span>`;
	}

	function ref(id) {
		return `<span class="ts-ref" data-act="go" data-id="${esc(id)}" title="${esc(task(id)?.title ?? '')}">#${esc(id)}</span>`;
	}

	/** Escaped text with "#12" turned into task references when the task exists. */
	function refs(text) {
		return esc(text).replace(/(^|[\s(“"'])#(\d{1,4})\b/g, (m, pre, id) => (task(id) ? `${pre}${ref(id)}` : m));
	}

	function gateIcon(g) {
		return g.kind === 'approval' || g.kind === 'choice' ? 'person' : 'lock';
	}

	function waitText(t) {
		const p = pendingDeps(t);
		const bad = p.filter(d => task(d)?.state === 'failed');
		if (bad.length) {
			return { text: `parada por ${joinIds(bad)}`, bad: true };
		}
		return { text: p.length === 1 ? `espera #${p[0]}` : `espera ${p.length} tarefas`, bad: false };
	}

	/** What a card shows for a task: state class, number box, summary line and footer. */
	function cardBits(t, k) {
		const D = S.D;
		let cd = esc(t.summary || t.detail.slice(0, 120));
		let cdCls = '';
		let cdIcon = '';
		const time = k === 'done' ? tookText(t) : estText(t);
		const clock = time ? `<span>${icon('clock', 'c-grey')}${esc(time)}</span>` : '';
		let foot = pill(k);
		switch (k) {
			case 'run':
				if (t.now) {
					cd = `Agora: ${esc(t.now)}`;
				}
				foot += t.progress !== null ? `${progressBar(t.progress)}<span>${t.progress}%</span>` : clock;
				break;
			case 'pause':
				if (t.now) {
					cd = `Pausada em ${esc(t.now)}`;
				}
				foot += t.progress !== null ? `${progressBar(t.progress)}<span>${t.progress}%</span>` : clock;
				break;
			case 'you': {
				const g = unmetGates(t)[0];
				if (g) {
					cdIcon = icon(gateIcon(g), 'c-rose');
					cd = `Falta: ${esc(shortLabel(g.label))}`;
				}
				foot += clock;
				break;
			}
			case 'bad':
				cd = esc(t.problem?.title || t.summary);
				cdCls = 'bad';
				foot += clock;
				break;
			case 'wait': {
				const w = waitText(t);
				foot += `<span${w.bad ? ' class="bad"' : ''}>${esc(w.text)}</span>`;
				break;
			}
			case 'ready':
				if (!D.started && !t.deps.length && !t.summary) {
					cd = 'Começa assim que você clicar';
				}
				foot += clock;
				break;
			case 'skip':
				break;
			default:
				foot += clock;
		}
		return { cd, cdCls, cdIcon, foot };
	}

	function cardHtml(t, box, o) {
		const cls = ['ts-card', `st-${o.k}`];
		if (o.sel) {
			cls.push('sel');
		}
		if (o.dim) {
			cls.push('dim');
		}
		if (o.mark) {
			cls.push(`mark-${o.mark}`);
		}
		if (o.compact) {
			cls.push('compact');
		}
		const label = `#${t.id} ${t.title}, ${ST[o.k]?.label ?? ''}${t.progress !== null && (o.k === 'run' || o.k === 'pause') ? `, ${t.progress}%` : ''}`;
		let inner = `<div class="ch">${numBox(t, o.numK ?? o.k)}<b>${esc(o.title ?? t.title)}</b></div>`;
		if (o.compact) {
			inner += `<div class="cm">${o.line}</div>`;
		} else {
			inner += `<div class="cd${o.cdCls ? ` ${o.cdCls}` : ''}">${o.cdIcon ?? ''}<span>${o.cd}</span></div><div class="cm">${o.foot}</div>`;
		}
		if (o.badge) {
			inner += `<span class="ts-badge k-${o.badge}">${esc(KINDS[o.badge].label)}</span>`;
		}
		return `<div class="${cls.join(' ')}" data-id="${esc(t.id)}" role="button" tabindex="0" aria-label="${esc(label)}"${o.sel ? ' aria-current="true"' : ''} title="${esc(t.title)}" style="left:${r1(box.x)}px;top:${r1(box.y)}px;width:${box.w}px;height:${box.h}px">${inner}</div>`;
	}

	function ghostHtml(box, title, desc, thinking) {
		return `<div class="ts-card ghost" aria-hidden="true" style="left:${r1(box.x)}px;top:${r1(box.y)}px;width:${box.w}px;height:${box.h}px"><div class="ch"><span class="ts-num">…</span><b>${esc(title)}</b></div><div class="cd"><span>${esc(desc)}</span></div><div class="cm">${thinking ? `<span>${icon('spinner', 'c-grey')}pensando</span>` : ''}</div></div>`;
	}

	function markerDefs() {
		const m = (id, color) => `<marker id="ts-ah-${id}" viewBox="0 0 10 10" refX="8.6" refY="5" markerWidth="7" markerHeight="7" orient="auto" markerUnits="userSpaceOnUse"><path d="M2.2 1.6L8.4 5L2.2 8.4" fill="none" stroke="${color}" stroke-width="1.4" stroke-linecap="square"/></marker>`;
		return `<defs>${m('done', '#9A9A9A')}${m('wait', '#6A6A6A')}${m('live', '#3399FF')}${m('bad', '#D9534F')}${m('chg', '#C2508F')}</defs>`;
	}

	function edgePath(d, kind, dim, extra = '') {
		return `<path class="ts-e k-${kind}${extra}${dim ? ' dim' : ''}" d="${d}" marker-end="url(#ts-ah-${kind})"/>`;
	}

	function legendHtml(x, y) {
		return `<div class="ts-legend" style="left:${x}px;top:${y}px"><span><i class="sw-done"></i>concluída</span><span><i class="sw-run"></i>executando</span><span><i class="sw-you"></i>precisa de você</span><span><i class="sw-bad"></i>com problema</span><span><i class="sw-wait"></i>aguardando</span><span><i class="ln"></i>depende de</span><span><i class="ln dash"></i>ainda não liberada</span></div>`;
	}

	// ------------------------------------------------------------------ layered layout for the map

	const CW = 220, CH = 80, GX = 90, PADX = 40, PADY = 30;

	/**
	 * Lays out a dependency graph: rows by dependency depth (a chain at the start or the end of the
	 * plan sits side by side to save a row), columns ordered by barycenters and placed by a small
	 * dynamic program, orthogonal right-angle edges with tracks so parallel lines do not overlap.
	 * @param {{id: string, deps: string[]}[]} nodes in plan order
	 */
	function layoutGraph(nodes) {
		const by = new Map(nodes.map(n => [n.id, n]));
		const kids = new Map(nodes.map(n => [n.id, []]));
		for (const n of nodes) {
			for (const d of n.deps) {
				kids.get(d)?.push(n.id);
			}
		}
		const { order, depth } = topo(nodes);
		const rowCount = new Map();
		for (const id of order) {
			rowCount.set(depth.get(id), (rowCount.get(depth.get(id)) ?? 0) + 1);
		}
		const maxC = Math.max(2, ...rowCount.values());
		const side = new Map();
		const hasSide = new Set();
		for (const id of order) {
			const n = by.get(id);
			if (n.deps.length !== 1) {
				continue;
			}
			const a = n.deps[0];
			if (!by.has(a) || kids.get(a).length !== 1 || side.has(a) || hasSide.has(a)) {
				continue;
			}
			if (by.get(a).deps.length && kids.get(id).length) {
				continue;
			}
			const ra = depth.get(a), rb = depth.get(id);
			if (rowCount.get(ra) + 1 > maxC) {
				continue;
			}
			rowCount.set(rb, rowCount.get(rb) - 1);
			rowCount.set(ra, rowCount.get(ra) + 1);
			depth.set(id, ra);
			side.set(id, a);
			hasSide.add(a);
		}
		const used = [...new Set(order.map(id => depth.get(id)))].sort((a, b) => a - b);
		const rowOfDepth = new Map(used.map((d, i) => [d, i]));
		const R = used.length;
		const units = [];
		const unitOf = new Map();
		for (const id of order) {
			if (side.has(id)) {
				continue;
			}
			const u = { members: [id], row: rowOfDepth.get(depth.get(id)), col: 0 };
			units.push(u);
			unitOf.set(id, u);
		}
		for (const [b, a] of side) {
			const u = unitOf.get(a);
			u.members.push(b);
			unitOf.set(b, u);
		}
		const rows = Array.from({ length: R }, () => []);
		for (const u of units) {
			rows[u.row].push(u);
		}

		// Order inside rows: barycenter sweeps.
		const slot = new Map();
		const setSlots = r => {
			let s = 0;
			for (const u of rows[r]) {
				u.members.forEach((m, i) => slot.set(m, s + i));
				s += u.members.length;
			}
		};
		rows.forEach((_, r) => setSlots(r));
		const neighbours = (u, up, down) => {
			const out = [];
			u.members.forEach((m, i) => {
				if (up) {
					for (const d of by.get(m).deps) {
						if (unitOf.get(d) && unitOf.get(d) !== u) {
							out.push([d, i]);
						}
					}
				}
				if (down) {
					for (const k of kids.get(m) ?? []) {
						if (unitOf.get(k) !== u) {
							out.push([k, i]);
						}
					}
				}
			});
			return out;
		};
		for (let it = 0; it < 6; it++) {
			const downSweep = it % 2 === 0;
			const seq = downSweep ? [...rows.keys()].slice(1) : [...rows.keys()].reverse().slice(1);
			for (const r of seq) {
				const keyed = rows[r].map((u, i) => {
					const nb = neighbours(u, downSweep, !downSweep);
					const b = nb.length ? nb.reduce((s, [x, off]) => s + slot.get(x) - off, 0) / nb.length : slot.get(u.members[0]);
					return { u, i, b };
				});
				keyed.sort((p, q) => p.b - q.b || p.i - q.i);
				rows[r] = keyed.map(k => k.u);
				setSlots(r);
			}
		}

		// Columns: every row is placed on a shared grid, as close as possible to its neighbours.
		const C = Math.max(1, ...rows.map(r => r.reduce((s, u) => s + u.members.length, 0)));
		const col = new Map();
		const setCols = u => u.members.forEach((m, i) => col.set(m, u.col + i));
		for (const r of rows) {
			let c = Math.floor((C - r.reduce((s, u) => s + u.members.length, 0)) / 2);
			for (const u of r) {
				u.col = c;
				c += u.members.length;
				setCols(u);
			}
		}
		const place = (r, up, down) => {
			const us = rows[r];
			if (!us.length) {
				return;
			}
			const want = us.map(u => {
				const nb = neighbours(u, up, down);
				return nb.length ? nb.reduce((s, [x, off]) => s + col.get(x) - off, 0) / nb.length : null;
			});
			const n = us.length, INF = 1e9;
			const centre = i => (C - us[i].members.length) / 2;
			const cost = (i, c) => (want[i] === null ? 0.01 * Math.abs(c - centre(i)) : Math.abs(c - want[i]) + 0.001 * Math.abs(c - centre(i)));
			const best = Array.from({ length: n }, () => new Array(C + 1).fill(INF));
			const from = Array.from({ length: n }, () => new Array(C + 1).fill(-1));
			for (let c = 0; c + us[0].members.length <= C; c++) {
				best[0][c] = cost(0, c);
			}
			for (let i = 1; i < n; i++) {
				let runMin = INF, runArg = -1;
				for (let c = 0; c + us[i].members.length <= C; c++) {
					const pc = c - us[i - 1].members.length;
					if (pc >= 0 && best[i - 1][pc] < runMin) {
						runMin = best[i - 1][pc];
						runArg = pc;
					}
					if (runArg >= 0) {
						best[i][c] = runMin + cost(i, c);
						from[i][c] = runArg;
					}
				}
			}
			let bc = 0, bv = INF;
			for (let c = 0; c <= C; c++) {
				if (best[n - 1][c] < bv) {
					bv = best[n - 1][c];
					bc = c;
				}
			}
			for (let i = n - 1; i >= 0; i--) {
				us[i].col = bc;
				setCols(us[i]);
				bc = from[i][bc];
			}
		};
		for (let r = 1; r < R; r++) {
			place(r, true, false);
		}
		for (let r = R - 2; r >= 0; r--) {
			place(r, false, true);
		}
		for (let r = 1; r < R; r++) {
			place(r, true, true);
		}

		const rowIdx = id => unitOf.get(id).row;
		const colX = c => PADX + c * (CW + GX);
		const cx = id => colX(col.get(id)) + CW / 2;

		// Edges and anchors.
		const edges = [];
		for (const n of nodes) {
			for (const d of n.deps) {
				if (!by.has(d)) {
					continue;
				}
				edges.push({ from: d, to: n.id, side: side.get(n.id) === d && rowIdx(d) === rowIdx(n.id) });
			}
		}
		const outs = new Map(), ins = new Map();
		for (const e of edges) {
			if (e.side) {
				continue;
			}
			if (!outs.has(e.from)) {
				outs.set(e.from, []);
			}
			if (!ins.has(e.to)) {
				ins.set(e.to, []);
			}
			outs.get(e.from).push(e);
			ins.get(e.to).push(e);
		}
		const spread = (list, key, space) => {
			list.sort((a, b) => key(a) - key(b));
			const k = list.length;
			const step = k > 1 ? Math.min(space, (CW - 40) / (k - 1)) : 0;
			return list.map((e, i) => (i - (k - 1) / 2) * step);
		};
		for (const [id, list] of outs) {
			const offs = spread(list, e => cx(e.to) + rowIdx(e.to) * 0.001, 28);
			list.forEach((e, i) => {
				e.sx = cx(id) + offs[i];
			});
		}
		for (const [id, list] of ins) {
			const offs = spread(list, e => e.sx, 24);
			list.forEach((e, i) => {
				e.tx = cx(id) + offs[i];
			});
			// Nearly straight lines become straight when the place is free.
			for (const e of list) {
				if (Math.abs(e.sx - e.tx) > 0.5 && Math.abs(e.sx - e.tx) <= 12 && Math.abs(e.sx - cx(id)) <= CW / 2 - 12 && !list.some(o => o !== e && Math.abs(o.tx - e.sx) < 8)) {
					e.tx = e.sx;
				}
			}
		}

		const blocked = (x, r0, r1) => {
			for (let r = r0 + 1; r < r1; r++) {
				for (const u of rows[r]) {
					const x0 = colX(u.col) - 6, x1 = colX(u.col + u.members.length - 1) + CW + 6;
					if (x >= x0 && x <= x1) {
						return true;
					}
				}
			}
			return false;
		};
		// A line that ends right where another line comes down reads as one line: move its end aside.
		const passes = (o, g) => {
			const rs = rowIdx(o.from), rt = rowIdx(o.to);
			return rs <= g && g < rt && (g === rs || !blocked(o.sx, rs, rt));
		};
		for (const [id, list] of ins) {
			const g = rowIdx(id) - 1;
			const lo = colX(col.get(id)) + 12, hi = colX(col.get(id)) + CW - 12;
			const others = edges.filter(o => !o.side && o.to !== id && passes(o, g));
			const clash = x => others.some(o => Math.abs(o.sx - x) < 7);
			for (const e of list) {
				if (Math.abs(e.sx - e.tx) <= 0.5 || !clash(e.tx)) {
					continue;
				}
				const free = x => x >= lo && x <= hi && !clash(x) && !list.some(o => o !== e && Math.abs(o.tx - x) < 8);
				const next = [8, -8, 14, -14, 20, -20].map(d => e.tx + d).find(free);
				if (next !== undefined) {
					e.tx = next;
				}
			}
		}

		// Routes: straight down, or through the channel between columns when a card is in the way.
		const segs = [];
		const chans = [];
		const chanX = b => (b <= 0 ? PADX - 22 : b >= C ? colX(C - 1) + CW + 22 : colX(b) - GX / 2);
		for (const e of edges) {
			if (e.side) {
				continue;
			}
			const rs = rowIdx(e.from), rt = rowIdx(e.to);
			e.rs = rs;
			e.rt = rt;
			if (rt <= rs) {
				// Same row without being a pair (a cycle or bad data): a short hop over the cards.
				e.kind = 'up';
				continue;
			}
			if (rt === rs + 1 || !blocked(e.sx, rs, rt)) {
				e.kind = 'down';
				if (Math.abs(e.sx - e.tx) > 0.5) {
					e.seg = { gap: rt - 1, x0: Math.min(e.sx, e.tx), x1: Math.max(e.sx, e.tx) };
					segs.push(e.seg);
				}
			} else {
				e.kind = 'chan';
				let bestB = 0, bestCost = Infinity;
				for (let b = 0; b <= C; b++) {
					const x = chanX(b);
					const c = Math.abs(x - e.sx) + Math.abs(x - e.tx);
					if (c < bestCost) {
						bestCost = c;
						bestB = b;
					}
				}
				e.chan = { b: bestB, x: chanX(bestB), r0: rs, r1: rt - 1 };
				chans.push(e.chan);
				e.seg = { gap: rs, x0: Math.min(e.sx, e.chan.x), x1: Math.max(e.sx, e.chan.x) };
				e.seg2 = { gap: rt - 1, x0: Math.min(e.chan.x, e.tx), x1: Math.max(e.chan.x, e.tx) };
				segs.push(e.seg, e.seg2);
			}
		}
		const tracks = new Array(Math.max(0, R - 1)).fill(0);
		const byGap = new Map();
		for (const s of segs) {
			if (!byGap.has(s.gap)) {
				byGap.set(s.gap, []);
			}
			byGap.get(s.gap).push(s);
		}
		for (const [g, list] of byGap) {
			list.sort((a, b) => (a.x1 - a.x0) - (b.x1 - b.x0));
			const taken = [];
			for (const s of list) {
				let t = 0;
				while ((taken[t] ?? []).some(o => s.x0 < o.x1 + 5 && o.x0 < s.x1 + 5)) {
					t++;
				}
				(taken[t] ??= []).push(s);
				s.track = t;
			}
			tracks[g] = taken.length;
		}
		const chanByB = new Map();
		for (const ch of chans) {
			if (!chanByB.has(ch.b)) {
				chanByB.set(ch.b, []);
			}
			chanByB.get(ch.b).push(ch);
		}
		for (const list of chanByB.values()) {
			const taken = [];
			for (const ch of list) {
				let t = 0;
				while ((taken[t] ?? []).some(o => ch.r0 <= o.r1 && o.r0 <= ch.r1)) {
					t++;
				}
				(taken[t] ??= []).push(ch);
				ch.x += [0, -6, 6, -12, 12, -18, 18][t] ?? 0;
			}
		}

		// Rows.
		const gapH = tracks.map(t => Math.max(34, 12 * Math.ceil(Math.max(0, t - 1) / 2) + 22));
		const rowY = [PADY];
		for (let r = 1; r < R; r++) {
			rowY[r] = rowY[r - 1] + CH + gapH[r - 1];
		}
		const gapMid = g => rowY[g] + CH + gapH[g] / 2;
		const trackY = s => gapMid(s.gap) + ([0, -6, 6, -12, 12, -18, 18, -24, 24][s.track] ?? 0);
		const pos = new Map();
		for (const u of units) {
			u.members.forEach((m, i) => pos.set(m, { x: colX(u.col + i), y: rowY[u.row], w: CW, h: CH, row: u.row }));
		}
		for (const e of edges) {
			const a = pos.get(e.from), b = pos.get(e.to);
			if (e.side) {
				const y = a.y + CH / 2;
				e.d = `M${r1(a.x + CW)},${r1(y)} H${r1(b.x)}`;
				e.mid = { x: (a.x + CW + b.x) / 2, y };
				continue;
			}
			const sy = a.y + CH, ty = b.y;
			if (e.kind === 'up') {
				const y = Math.min(a.y, b.y) - 12;
				e.d = `M${r1(e.sx)},${r1(a.y)} V${r1(y)} H${r1(e.tx)} V${r1(b.y)}`;
			} else if (e.kind === 'down') {
				if (!e.seg) {
					e.d = `M${r1(e.sx)},${r1(sy)} V${r1(ty)}`;
				} else {
					const y = trackY(e.seg);
					e.d = `M${r1(e.sx)},${r1(sy)} V${r1(y)} H${r1(e.tx)} V${r1(ty)}`;
				}
			} else {
				const y1 = trackY(e.seg), y2 = trackY(e.seg2);
				e.d = `M${r1(e.sx)},${r1(sy)} V${r1(y1)} H${r1(e.chan.x)} V${r1(y2)} H${r1(e.tx)} V${r1(ty)}`;
			}
		}
		const gateAt = id => {
			const p = pos.get(id);
			const n = by.get(id);
			if (side.has(id)) {
				return { x: p.x - GX / 2, y: p.y + CH / 2, max: GX + 6, side: true };
			}
			if (n.deps.some(d => by.has(d)) && p.row > 0) {
				return { x: p.x + CW / 2, y: gapMid(p.row - 1), max: 190 };
			}
			return { x: p.x + CW / 2, y: p.y - 15, max: 190 };
		};
		const w = colX(C - 1) + CW + PADX;
		const h = rowY[R - 1] + CH + PADY;
		return { pos, edges, gateAt, w, h, rows: R };
	}

	// ------------------------------------------------------------------ map scene

	function edgeKind(from, to) {
		const a = task(from), b = task(to);
		if (!a || !b) {
			return 'wait';
		}
		const ka = disp(a), kb = disp(b);
		if (ka === 'bad') {
			return 'bad';
		}
		if (ka === 'done' || ka === 'skip') {
			return kb === 'run' ? 'live' : 'done';
		}
		return 'wait';
	}

	function searchHit(t) {
		const q = norm(S.search.q.trim());
		if (!q) {
			return true;
		}
		return norm(`#${t.id} ${t.title} ${t.summary} ${t.area} ${t.phase}`).includes(q);
	}

	/** Card options for a task on the map, with recalibration, proposal and search overlays. */
	function cardOptions(t, ov) {
		const k = disp(t);
		const o = { k, ...cardBits(t, k), sel: S.sel === t.id };
		if (ov.recal) {
			const r = ov.recal;
			if (t.id === r.task) {
				o.k = 'changed';
				o.numK = k;
				o.foot = pill('changed') + (k === 'done' ? `<span>${icon('clock', 'c-grey')}${esc(tookText(t))}</span>` : '');
				o.cd = esc(r.text || t.summary);
			} else if (r.sets.done.includes(t.id) || r.sets.running.includes(t.id) || r.sets.todo.includes(t.id) || r.paused.includes(t.id)) {
				o.k = 'check';
				o.numK = k;
				o.cd = r.sets.done.includes(t.id) ? 'Conferindo o que já foi feito' : (r.sets.running.includes(t.id) || r.paused.includes(t.id)) ? 'Pausada durante a recalibração' : 'Conferindo';
				o.cdIcon = '';
				o.cdCls = '';
				o.foot = pill('check') + (estText(t) ? `<span>${icon('clock', 'c-grey')}${esc(estText(t))}</span>` : '');
			} else {
				o.dim = true;
			}
		} else if (ov.changes) {
			const c = ov.changes.get(t.id);
			if (c) {
				o.mark = c.kind;
				o.badge = c.kind;
				if (c.note || c.summary) {
					o.cd = esc(c.summary || c.note);
					o.cdIcon = '';
					o.cdCls = '';
				}
				if (c.title && c.kind !== 'remover') {
					o.title = c.title;
				}
			} else {
				o.dim = true;
			}
		}
		if (S.plan?.draft && t.state === 'todo') {
			o.k = 'draft';
			o.foot = pill('draft') + (estText(t) ? `<span>${icon('clock', 'c-grey')}${esc(estText(t))}</span>` : '');
			o.cd = esc(t.summary);
			o.cdIcon = '';
		}
		if (S.search.q.trim() && !searchHit(t)) {
			o.dim = true;
		}
		return o;
	}

	function overlays() {
		const r = recalibrating();
		if (r) {
			return {
				recal: {
					task: nid(r.task),
					text: str(r.text, 300),
					sets: impactSets(r),
					paused: Array.isArray(r.paused) ? r.paused.map(nid) : [],
				},
			};
		}
		if (S.proposal) {
			return { changes: proposalIndex() };
		}
		return {};
	}

	function gateLabelHtml(t, spot, o = {}) {
		const unmet = unmetGates(t);
		const g = unmet[0] ?? t.gates[0];
		if (!g) {
			return '';
		}
		const k = disp(t);
		let cls = 'need', ic = gateIcon(g);
		if (!unmet.length) {
			cls = 'met';
			ic = 'passed';
		} else if (g.kind === 'approval' && k === 'wait') {
			cls = 'wait';
		}
		const more = unmet.length > 1 ? ` +${unmet.length - 1}` : '';
		const sel = S.sel === t.id && k === 'you' ? ' sel' : '';
		const style = `left:${r1(spot.x)}px;top:${r1(spot.y)}px;max-width:${spot.max}px`;
		const title = t.gates.map(x => `${x.met ? '✓' : '•'} ${x.label}`).join('\n');
		return `<div class="ts-gate ${cls}${sel}${o.dim ? ' dim' : ''}${spot.side ? ' side' : ''}" data-act="gate" data-id="${esc(t.id)}" title="${esc(title)}" style="${style}">${icon(ic)}<span>${esc(shortLabel(g.label))}${more}</span></div>`;
	}

	/** The map: cards by dependency depth with orthogonal lines; large plans by phase. */
	function mapScene() {
		const D = S.D;
		if (D.total > 16 && D.tasks.some(t => t.phase)) {
			return phasedScene();
		}
		const ov = overlays();
		const nodes = D.tasks.map(t => ({ id: t.id, deps: t.deps }));
		const virtual = new Map();
		if (ov.changes) {
			for (const c of S.proposal.changes) {
				if (c.kind === 'nova' && !task(c.task)) {
					const deps = (c.deps ?? []).filter(d => task(d));
					nodes.push({ id: c.task, deps });
					virtual.set(c.task, c);
				}
			}
		}
		const drafting = S.plan.draft && S.running;
		const last = D.tasks[D.tasks.length - 1];
		if (drafting && last) {
			nodes.push({ id: '\u0001g1', deps: [last.id] }, { id: '\u0001g2', deps: [last.id] });
		}
		const L = layoutGraph(nodes);
		const showLegend = !D.started && !S.plan.draft;
		const h = L.h + (showLegend ? 34 : 0);
		const parts = [];
		const gates = [];
		for (const n of nodes) {
			const box = L.pos.get(n.id);
			if (n.id.startsWith('\u0001')) {
				parts.push(ghostHtml(box, n.id.endsWith('1') ? 'Próxima tarefa…' : '…', 'definindo', n.id.endsWith('1')));
				continue;
			}
			const c = virtual.get(n.id);
			if (c) {
				const vt = { id: c.task, title: c.title || 'Nova tarefa', summary: c.summary, detail: c.detail, deps: n.deps, gates: [], estimate: c.estimate, progress: null, state: 'todo' };
				parts.push(cardHtml(vt, box, { k: 'wait', cd: esc(c.summary || c.note), foot: `${pill('wait', 'Nova')}${c.estimate ? `<span>${icon('clock', 'c-grey')}~${dur(c.estimate)}</span>` : ''}`, mark: 'nova', badge: 'nova', sel: S.sel === c.task }));
				continue;
			}
			const t = task(n.id);
			const o = cardOptions(t, ov);
			parts.push(cardHtml(t, box, o));
			if (t.gates.length) {
				gates.push(gateLabelHtml(t, L.gateAt(t.id), { dim: o.dim }));
			}
		}
		const paths = [];
		for (const e of L.edges) {
			let kind;
			let dim = false;
			let extra = '';
			if (e.from.startsWith('\u0001') || e.to.startsWith('\u0001')) {
				kind = 'wait';
				dim = true;
			} else if (ov.changes) {
				const a = ov.changes.get(e.from), b = ov.changes.get(e.to);
				if (b && (a || b.kind === 'nova')) {
					kind = 'chg';
					extra = b.kind === 'nova' ? ' k-new' : '';
				} else {
					kind = virtual.has(e.to) ? 'chg' : edgeKind(e.from, e.to);
					dim = !b;
				}
			} else if (ov.recal) {
				kind = edgeKind(e.from, e.to);
				const r = ov.recal;
				const hot = new Set([r.task, ...r.sets.done, ...r.sets.running, ...r.sets.todo]);
				dim = !(hot.has(e.from) && hot.has(e.to));
			} else {
				kind = edgeKind(e.from, e.to);
				if (S.plan.draft) {
					kind = 'wait';
				}
				if (S.search.q.trim()) {
					dim = !(searchHit(task(e.from)) && searchHit(task(e.to)));
				}
			}
			paths.push(edgePath(e.d, kind, dim, extra));
		}
		const legend = showLegend ? legendHtml(PADX, L.h - 4) : '';
		const html = `<div class="ts-stage" id="ts-stage" style="width:${L.w}px;height:${h}px"><svg class="ts-edges" width="${L.w}" height="${h}">${markerDefs()}${paths.join('')}</svg>${parts.join('')}${gates.join('')}${legend}</div>`;
		const rects = new Map([...L.pos].filter(([id]) => !id.startsWith('\u0001')));
		return { html, w: L.w, h, key: `map:${nodes.map(n => n.id).join(',')}`, rects };
	}

	/** Shown while the agent is writing the first plan and no plan file exists yet. */
	function buildingScene() {
		const nodes = [{ id: 'a', deps: [] }, { id: 'b', deps: ['a'] }, { id: 'c', deps: ['a'] }, { id: 'd', deps: ['b', 'c'] }, { id: 'e', deps: ['d'] }];
		const L = layoutGraph(nodes);
		const cards = nodes.map((n, i) => ghostHtml(L.pos.get(n.id), i < 2 ? 'Definindo…' : '…', i < 2 ? 'definindo' : '', i < 2)).join('');
		const paths = L.edges.map(e => edgePath(e.d, 'wait', true)).join('');
		const h = L.h + 30;
		const html = `<div class="ts-stage" id="ts-stage" style="width:${L.w}px;height:${h}px"><svg class="ts-edges" width="${L.w}" height="${h}">${markerDefs()}${paths}</svg>${cards}<div class="ts-legend" style="left:${PADX}px;top:${L.h - 2}px"><span>${icon('spinner', 'c-bar')}Montando o plano: as tarefas aparecem aqui conforme o agente define cada uma. Nada é executado antes de você começar.</span></div></div>`;
		return { html, w: L.w, h, key: 'building', rects: new Map() };
	}

	// ------------------------------------------------------------------ large plans: phase groups

	const OTHER_PHASE = 'Outras tarefas';
	const phaseOf = t => t.phase || OTHER_PHASE;

	function phaseShort(name) {
		const m = /^fase\s+(\d+)/i.exec(name);
		return m ? m[1] : null;
	}

	function phaseInfo() {
		const D = S.D;
		const names = [];
		const of = new Map();
		for (const t of D.tasks) {
			const p = phaseOf(t);
			if (!of.has(p)) {
				of.set(p, []);
				names.push(p);
			}
			of.get(p).push(t);
		}
		const deps = new Map(names.map(n => [n, new Set()]));
		for (const t of D.tasks) {
			for (const d of t.deps) {
				const a = phaseOf(task(d)), b = phaseOf(t);
				if (a !== b) {
					deps.get(b).add(a);
				}
			}
		}
		return { names, of, deps };
	}

	function phaseStatus(name, tasks, deps) {
		const c = { done: 0, run: 0, pause: 0, you: 0, bad: 0, wait: 0, ready: 0, skip: 0 };
		for (const t of tasks) {
			c[disp(t)]++;
		}
		const n = tasks.length;
		let text;
		if (c.done + c.skip === n) {
			text = 'concluída';
		} else if (c.bad) {
			text = plural(c.bad, 'com problema', 'com problema');
		} else if (c.run) {
			text = `${c.run} executando`;
		} else if (c.you) {
			text = `${c.you} ${c.you === 1 ? 'precisa' : 'precisam'} de você`;
		} else if (c.pause) {
			text = plural(c.pause, 'pausada', 'pausadas');
		} else {
			const waiting = [...deps].filter(p => S.D.tasks.some(t => phaseOf(t) === p && t.state !== 'done' && t.state !== 'skipped'));
			if (waiting.length) {
				const nums = waiting.map(phaseShort);
				text = nums.every(Boolean)
					? (nums.length === 1 ? `espera a fase ${nums[0]}` : `espera as fases ${nums.slice(0, -1).join(', ')} e ${nums[nums.length - 1]}`)
					: `espera ${waiting.length === 1 ? `“${waiting[0]}”` : `${waiting.length} fases`}`;
			} else {
				text = c.ready ? plural(c.ready, 'pronta', 'prontas') : 'aguardando';
			}
		}
		return { c, text, n };
	}

	function phaseMeter(c, n) {
		const parts = [['done', c.done + c.skip], ['run', c.run], ['you', c.you + c.pause], ['bad', c.bad], ['wait', c.wait + c.ready]];
		return parts.filter(([, v]) => v).map(([k, v]) => `<i class="m-${k}" style="width:${(v / n) * 100}%"></i>`).join('');
	}

	function phaseOpen(name, tasks) {
		if (S.opened.has(name)) {
			return true;
		}
		if (S.closed.has(name)) {
			return false;
		}
		// Open what is happening now; a task that needs the user shows its condition on the line instead.
		return tasks.some(t => ['run', 'pause', 'bad'].includes(disp(t)) || t.id === S.sel);
	}

	function phasedScene() {
		const { names, of, deps } = phaseInfo();
		const { order, depth } = topo(names.map(n => ({ id: n, deps: [...deps.get(n)] })));
		const rowsMap = new Map();
		for (const n of order) {
			const d = depth.get(n);
			if (!rowsMap.has(d)) {
				rowsMap.set(d, []);
			}
			rowsMap.get(d).push(n);
		}
		const rows = [...rowsMap.keys()].sort((a, b) => a - b).map(d => rowsMap.get(d));
		const maxN = Math.max(...rows.map(r => r.length));
		const TW = maxN > 1 ? Math.max(1060, maxN * 500 + (maxN - 1) * 40) : 660;
		const PAD = 20, MW = 190, MH = 56, MPX = 214, MPY = 76;
		const box = new Map();
		let y = PAD + 16;
		for (const r of rows) {
			const n = r.length;
			let x = PAD;
			let rowH = 0;
			for (const name of r) {
				const w = n === 1 ? (deps.get(name).size >= 2 ? TW : Math.min(TW, 660)) : (TW - (n - 1) * 40) / n;
				const tasks = of.get(name);
				const open = phaseOpen(name, tasks);
				const cols = Math.max(1, Math.floor((w - 40 + 24) / MPX));
				const h = open ? 44 + Math.ceil(tasks.length / cols) * MPY + 8 : 56;
				box.set(name, { x, y, w, h, open, cols });
				x += w + 40;
				rowH = Math.max(rowH, h);
			}
			y += rowH + 28;
		}
		const H = y + 34;
		const W = TW + PAD * 2;
		const parts = [];
		const ov = overlays();
		const mm = [];
		for (const name of names) {
			const b = box.get(name);
			const tasks = of.get(name);
			const st = phaseStatus(name, tasks, deps.get(name));
			const minis = [];
			if (b.open) {
				tasks.forEach((t, i) => {
					const k = disp(t);
					const o = cardOptions(t, ov);
					const mx = 20 + (i % b.cols) * MPX, my = 44 + Math.floor(i / b.cols) * MPY;
					const cls = `ts-mini st-${k}${S.sel === t.id ? ' sel' : ''}${o.dim ? ' dim' : ''}`;
					const line = k === 'run' && t.progress !== null ? `Executando · ${t.progress}%` : k === 'you' && unmetGates(t)[0] ? `Precisa de você · ${shortLabel(unmetGates(t)[0].label)}` : ST[k].label;
					minis.push(`<div class="${cls}" data-id="${esc(t.id)}" role="button" tabindex="0" aria-label="${esc(`#${t.id} ${t.title}, ${ST[k].label}`)}" title="${esc(t.title)}" style="left:${mx}px;top:${my}px;width:${MW}px;height:${MH}px"><b>#${esc(t.id)} ${esc(t.title)}</b><small>${esc(line)}</small></div>`);
				});
			}
			parts.push(`<div class="ts-grp${b.open ? '' : ' closed'}" style="left:${r1(b.x)}px;top:${b.y}px;width:${r1(b.w)}px;height:${b.h}px"><button class="gh" data-act="phase" data-phase="${esc(name)}" aria-expanded="${b.open}">${icon(b.open ? 'chevD' : 'chevR')}<span class="t">${esc(name)}</span><small>${esc(`${plural(st.n, 'tarefa', 'tarefas')} · ${st.text}`)}</small><span class="gm">${phaseMeter(st.c, st.n)}</span></button>${minis.join('')}</div>`);
			const fill = st.c.done + st.c.skip === st.n ? '#2E6B37' : st.c.bad ? '#5A2121' : st.c.run ? '#2F5F93' : st.c.you || st.c.pause ? '#47223D' : '#3A3A3A';
			mm.push(`<rect x="${r1(b.x)}" y="${b.y}" width="${r1(b.w)}" height="${b.h}" fill="${fill}"/>`);
		}
		// Lines between phases.
		const paths = [];
		const gates = [];
		for (const name of names) {
			const tb = box.get(name);
			const ins = [...deps.get(name)];
			const youTask = of.get(name).find(t => disp(t) === 'you' && unmetGates(t).length);
			let gatePlaced = false;
			for (const p of ins) {
				const sb = box.get(p);
				const done = of.get(p).every(t => t.state === 'done' || t.state === 'skipped');
				const kind = done ? 'done' : 'wait';
				const lo = Math.max(sb.x, tb.x) + 20, hi = Math.min(sb.x + sb.w, tb.x + tb.w) - 20;
				const tcx = tb.x + tb.w / 2;
				let d, gx, gy;
				if (lo <= hi) {
					const x = clamp(tcx, lo, hi);
					d = `M${r1(x)},${sb.y + sb.h} V${tb.y}`;
					gx = x;
					gy = (sb.y + sb.h + tb.y) / 2;
				} else {
					const right = tcx > sb.x + sb.w;
					const sx = right ? sb.x + sb.w : sb.x;
					const syy = sb.y + Math.min(sb.h / 2, 120);
					d = `M${r1(sx)},${r1(syy)} H${r1(tcx)} V${tb.y}`;
					gx = tcx;
					gy = (syy + tb.y) / 2;
				}
				paths.push(edgePath(d, kind, false));
				if (youTask && !gatePlaced) {
					gates.push(gateLabelHtml(youTask, { x: gx, y: gy, max: 220 }));
					gatePlaced = true;
				}
			}
			if (youTask && !gatePlaced) {
				gates.push(gateLabelHtml(youTask, { x: tb.x + tb.w / 2, y: tb.y - 14, max: 220 }));
			}
		}
		const html = `<div class="ts-stage" id="ts-stage" style="width:${W}px;height:${H}px"><svg class="ts-edges" width="${W}" height="${H}">${markerDefs()}${paths.join('')}</svg>${parts.join('')}${gates.join('')}${legendHtml(PAD, H - 30)}</div>`;
		const rects = new Map();
		for (const name of names) {
			const b = box.get(name);
			if (b.open) {
				of.get(name).forEach((t, i) => rects.set(t.id, { x: b.x + 20 + (i % b.cols) * MPX, y: b.y + 44 + Math.floor(i / b.cols) * MPY, w: MW, h: MH }));
			} else {
				for (const t of of.get(name)) {
					rects.set(t.id, { x: b.x, y: b.y, w: b.w, h: b.h, group: true });
				}
			}
		}
		return { html, w: W, h: H, key: `phases:${names.join('|')}:${[...box.values()].map(b => b.open ? 1 : 0).join('')}`, rects, minimap: { items: mm.join(''), w: W, h: H } };
	}

	// ------------------------------------------------------------------ lanes (swimlanes by area)

	const NO_AREA = 'Sem área';

	function areaIcon(name) {
		const n = norm(name);
		if (/plane|pedido|entend|requisit/.test(n)) {
			return 'bulb';
		}
		if (/banco|dado|data|tabela/.test(n)) {
			return 'database';
		}
		if (/servidor|api|back|serv/.test(n)) {
			return 'server';
		}
		if (/tela|site|front|interface|app|web|painel/.test(n)) {
			return 'window';
		}
		if (/integra|pagamento|whats|pix|extern/.test(n)) {
			return 'plug';
		}
		if (/teste|qualidade|publica|deploy|entrega/.test(n)) {
			return 'rocket';
		}
		return 'folder';
	}

	function areas() {
		const list = [];
		for (const t of S.D.tasks) {
			const a = t.area || NO_AREA;
			if (!list.includes(a)) {
				list.push(a);
			}
		}
		if (list.includes(NO_AREA)) {
			list.splice(list.indexOf(NO_AREA), 1);
			list.push(NO_AREA);
		}
		return list;
	}

	function compactLine(t, k) {
		if (k === 'run' || k === 'pause') {
			return `<span>${icon(k === 'run' ? 'spinner' : 'pause', k === 'run' ? 'c-bar' : 'c-rose')}${t.progress !== null ? `${t.progress}%` : ST[k].label}</span>`;
		}
		if (k === 'you') {
			const g = unmetGates(t)[0];
			return `<span>${icon(g ? gateIcon(g) : 'person', 'c-rose')}${esc(g ? lowerFirst(shortLabel(g.label)) : ST.you.label)}</span>`;
		}
		if (k === 'bad') {
			return `<span>${icon('error', 'c-red')}${esc(t.problem?.title || ST.bad.label)}</span>`;
		}
		if (k === 'skip') {
			return `<span>${icon('skip', 'c-grey')}Para depois</span>`;
		}
		const time = k === 'done' ? tookText(t) : estText(t);
		return `<span>${icon('clock', 'c-grey')}${esc(time || ST[k].label)}</span>`;
	}

	function lanesScene() {
		const list = areas();
		const LW = 174, CWV = 156, CHV = 58, TOP = 44, RH = 74;
		const laneOf = t => list.indexOf(t.area || NO_AREA);
		const row = new Map();
		const used = new Set();
		for (const id of S.D.order) {
			const t = task(id);
			let r = t.deps.reduce((m, d) => Math.max(m, (row.get(d) ?? -1) + 1), 0);
			while (used.has(`${laneOf(t)}:${r}`)) {
				r++;
			}
			used.add(`${laneOf(t)}:${r}`);
			row.set(id, r);
		}
		const rowsN = Math.max(1, ...[...row.values()].map(r => r + 1));
		const W = LW * list.length, H = TOP + rowsN * RH + 16;
		const bx = t => ({ x: laneOf(t) * LW + (LW - CWV) / 2, y: TOP + row.get(t.id) * RH + 6, w: CWV, h: CHV });
		const bg = list.map((a, i) => `<div class="ts-lane-bg${i % 2 ? ' alt' : ''}" style="left:${i * LW}px;top:0;width:${LW}px;height:${H}px"></div><div class="ts-lane-h" style="left:${i * LW + 10}px;top:13px;width:${LW - 20}px" title="${esc(a)}">${icon(areaIcon(a), 's14')}<span>${esc(a)}</span></div>`).join('');
		const ov = overlays();
		const cards = [];
		const paths = [];
		for (const t of S.D.tasks) {
			const k = disp(t);
			const o = cardOptions(t, ov);
			cards.push(cardHtml(t, bx(t), { k: o.k, numK: o.numK, sel: o.sel, dim: o.dim, mark: o.mark, badge: o.badge, compact: true, line: compactLine(t, k) }));
			for (const d of t.deps) {
				const A = bx(task(d)), B = bx(t);
				const x1 = A.x + A.w / 2, y1 = A.y + A.h, x2 = B.x + B.w / 2, y2 = B.y;
				const c = Math.max(16, (y2 - y1) * 0.5);
				paths.push(edgePath(`M${r1(x1)},${r1(y1)} C${r1(x1)},${r1(y1 + c)} ${r1(x2)},${r1(y2 - c)} ${r1(x2)},${r1(y2)}`, edgeKind(d, t.id), o.dim));
			}
		}
		const html = `<div class="ts-stage" id="ts-stage" style="width:${W}px;height:${H}px">${bg}<svg class="ts-edges" width="${W}" height="${H}">${markerDefs()}${paths.join('')}</svg>${cards.join('')}</div>`;
		const rects = new Map(S.D.tasks.map(t => [t.id, bx(t)]));
		return { html, w: W, h: H, key: `lanes:${list.join('|')}:${rowsN}`, rects, plain: true };
	}

	// ------------------------------------------------------------------ metro (one line per area)

	function metroScene() {
		const list = areas();
		const D = S.D;
		const color = new Map(list.map((a, i) => [a, METRO_COLORS[i % METRO_COLORS.length]]));
		const areaOf = t => t.area || NO_AREA;
		// The area with most stations runs through the middle; the others alternate above and below.
		const sizes = list.map(a => [a, D.tasks.filter(t => areaOf(t) === a).length]).sort((p, q) => q[1] - p[1]);
		const bands = [];
		sizes.forEach(([a], i) => (i % 2 ? bands.unshift(a) : bands.push(a)));
		// Then each line moves next to the lines it connects with, so fewer lines cross.
		for (let it = 0; it < 6; it++) {
			const pos = new Map(bands.map((a, i) => [a, i]));
			const scored = bands.map((a, i) => {
				let sum = 0, n = 0;
				for (const t of D.tasks) {
					if (areaOf(t) !== a) {
						continue;
					}
					for (const o of [...t.deps, ...(D.kids.get(t.id) ?? [])]) {
						const b = areaOf(task(o));
						if (b !== a) {
							sum += pos.get(b);
							n++;
						}
					}
				}
				return { a, i, s: n ? (sum / n + i) / 2 : i };
			});
			scored.sort((p, q) => p.s - q.s || p.i - q.i);
			bands.splice(0, bands.length, ...scored.map(x => x.a));
		}
		const XS = 170, X0 = 90;
		const stackOf = new Map();
		const cell = new Map();
		for (const id of D.order) {
			const t = task(id);
			const key = `${areaOf(t)}:${D.depth.get(id)}`;
			const n = cell.get(key) ?? 0;
			cell.set(key, n + 1);
			stackOf.set(id, n);
		}
		const bandH = new Map(bands.map(a => [a, Math.max(1, ...D.tasks.filter(t => areaOf(t) === a).map(t => cell.get(`${a}:${D.depth.get(t.id)}`)))]));
		const bandY = new Map();
		let y = 90;
		for (const a of bands) {
			const h = (bandH.get(a) - 1) * 56;
			bandY.set(a, y + h / 2);
			y += h + 120;
		}
		const p = new Map();
		for (const t of D.tasks) {
			const a = areaOf(t);
			const n = cell.get(`${a}:${D.depth.get(t.id)}`);
			p.set(t.id, { x: X0 + D.depth.get(t.id) * XS, y: bandY.get(a) + (stackOf.get(t.id) - (n - 1) / 2) * 56 });
		}
		const W = X0 * 2 + Math.max(0, ...D.depth.values()) * XS + 120;
		const H = y + 10;
		const drawn = new Set();
		const lines = [];
		const thin = [];
		for (const a of list) {
			const seq = D.tasks.filter(t => areaOf(t) === a).sort((s, u) => D.depth.get(s.id) - D.depth.get(u.id) || D.idx.get(s.id) - D.idx.get(u.id)).map(t => t.id);
			if (!seq.length) {
				continue;
			}
			const first = task(seq[0]);
			const ext = first.deps.filter(d => areaOf(task(d)) !== a).sort((s, u) => D.depth.get(u) - D.depth.get(s))[0];
			const lastId = seq[seq.length - 1];
			const extOut = (D.kids.get(lastId) ?? []).filter(k => areaOf(task(k)) !== a).sort((s, u) => D.depth.get(s) - D.depth.get(u))[0];
			const full = [...(ext ? [ext] : []), ...seq, ...(extOut ? [extOut] : [])];
			for (let i = 1; i < full.length; i++) {
				drawn.add(`${full[i - 1]}>${full[i]}`);
				drawn.add(`${full[i]}>${full[i - 1]}`);
			}
			if (full.length > 1) {
				lines.push(`<path d="${full.map((id, i) => `${i ? 'L' : 'M'}${r1(p.get(id).x)},${r1(p.get(id).y)}`).join(' ')}" fill="none" stroke="${color.get(a)}" stroke-width="7" stroke-linejoin="round" stroke-linecap="square"/>`);
			}
		}
		for (const t of D.tasks) {
			for (const d of t.deps) {
				if (!drawn.has(`${d}>${t.id}`)) {
					const A = p.get(d), B = p.get(t.id);
					thin.push(`<path d="M${r1(A.x)},${r1(A.y)} L${r1(B.x)},${r1(B.y)}" fill="none" stroke="${color.get(areaOf(t))}" stroke-width="4" stroke-linecap="square"/>`);
				}
			}
		}
		const ov = overlays();
		const stations = [];
		const labels = [];
		for (const t of D.tasks) {
			const k = disp(t);
			const o = cardOptions(t, ov);
			const q = p.get(t.id);
			const inter = t.deps.some(d => areaOf(task(d)) !== areaOf(t)) || (D.kids.get(t.id) ?? []).some(c => areaOf(task(c)) !== areaOf(t));
			const cls = ['ts-st', k === 'done' || k === 'skip' ? 'done' : k, inter ? 'x' : '', S.sel === t.id ? 'sel' : '', o.dim ? 'dim' : ''].filter(Boolean).join(' ');
			stations.push(`<div class="${cls}" data-id="${esc(t.id)}" role="button" tabindex="0" aria-label="${esc(`#${t.id} ${t.title}, ${ST[k].label}`)}" title="${esc(t.title)}" style="left:${r1(q.x)}px;top:${r1(q.y)}px;--c:${color.get(areaOf(t))}"></div>`);
			const below = D.depth.get(t.id) % 2 === 0;
			const word = k === 'run' ? 'agora' : k === 'you' && unmetGates(t)[0] ? `falta ${lowerFirst(shortLabel(unmetGates(t)[0].label))}` : ST[k].word;
			const lock = k === 'you' ? icon('lock') : '';
			labels.push(`<div class="ts-sl${o.dim ? ' dim' : ''}" style="left:${r1(q.x - 14)}px;top:${r1(below ? q.y + 16 : q.y - 46)}px">${lock}<span>#${esc(t.id)} ${esc(t.title)}<small>${esc(word)}</small></span></div>`);
		}
		const legend = `<div class="ts-legend" style="left:40px;top:${H - 14}px">${list.map(a => `<span><i style="background:${color.get(a)};width:22px;height:6px"></i>${esc(a)}</span>`).join('')}</div>`;
		const html = `<div class="ts-stage" id="ts-stage" style="width:${W}px;height:${H + 20}px"><svg class="ts-edges" width="${W}" height="${H + 20}">${thin.join('')}${lines.join('')}</svg>${stations.join('')}${labels.join('')}${legend}</div>`;
		const rects = new Map(D.tasks.map(t => [t.id, { x: p.get(t.id).x - 60, y: p.get(t.id).y - 30, w: 120, h: 60 }]));
		return { html, w: W, h: H + 20, key: `metro:${list.join('|')}`, rects, plain: true };
	}

	// ------------------------------------------------------------------ list view

	function hhmmss(ms) {
		if (ms === null || ms === undefined) {
			return '';
		}
		const d = new Date(ms);
		return `${hhmm(ms)}:${String(d.getSeconds()).padStart(2, '0')}`;
	}

	function logHtml(list) {
		if (!list.length) {
			return '';
		}
		return `<div class="ts-log">${list.map(l => `<span class="${l.kind === 'ok' ? 'ok' : l.kind === 'error' ? 'err' : ''}">${l.at ? `<span class="at">${hhmmss(l.at)}</span>` : ''}${esc(l.text)}</span>`).join('\n')}</div>`;
	}

	function timeCell(t, k) {
		if (k === 'done') {
			return tookText(t);
		}
		if ((k === 'run' || k === 'pause') && t.startedAt && t.estimate) {
			const el = Math.round(minutesBetween(t.startedAt, k === 'pause' && t.pausedAt ? t.pausedAt : Date.now()));
			return `${el} de ~${dur(t.estimate)}`;
		}
		return estText(t);
	}

	function railColor(k) {
		return k === 'done' ? '#37A93C' : k === 'run' ? '#3399FF' : k === 'you' || k === 'pause' ? '#C2508F' : k === 'bad' ? '#D9534F' : '#333337';
	}

	function gateTags(t) {
		return unmetGates(t).map(g => `<span class="ts-tag">${icon(gateIcon(g), 'c-rose')}${esc(lowerFirst(shortLabel(g.label)))}</span>`).join('');
	}

	function criteriaRows(t, k) {
		let spun = false;
		return t.criteria.map(c => {
			let ic = c.done ? icon('passed', 'c-green') : icon('circle', 'c-grey');
			if (!c.done && k === 'run' && !spun) {
				ic = icon('spinner', 'c-bar');
				spun = true;
			}
			return `<div class="ts-li">${ic}<span class="tx wrap">${esc(c.text)}</span></div>`;
		}).join('');
	}

	function taskButtons(t, small, compactAsk) {
		const k = disp(t);
		const cls = small ? 'ts-btn small' : 'ts-btn';
		const busy = !!recalibrating() || !!S.proposal;
		const out = [`<button class="${cls}" data-act="edit" data-id="${esc(t.id)}"${busy ? ' disabled title="Aplique ou descarte a recalibração antes de mudar outra tarefa."' : ''}>${icon('pencil')}<span class="lbl">Editar tarefa</span></button>`];
		if (k === 'run') {
			out.push(`<button class="${cls}" data-act="stop">${icon('pause')}<span class="lbl">Pausar</span></button>`);
		} else if (k === 'pause' && !busy) {
			out.push(`<button class="${cls}" data-act="resume" data-id="${esc(t.id)}">${icon('resume')}<span class="lbl">Retomar</span></button>`);
		}
		out.push(compactAsk
			? `<button class="${cls} ib" data-act="ask-task" data-id="${esc(t.id)}" title="Perguntar sobre esta tarefa no chat" aria-label="Perguntar sobre esta tarefa">${icon('comment')}</button>`
			: `<button class="${cls}" data-act="ask-task" data-id="${esc(t.id)}" title="Perguntar sobre esta tarefa no chat">${icon('comment')}<span class="lbl">Perguntar</span></button>`);
		return out.join('');
	}

	function listView() {
		const D = S.D;
		const rows = D.tasks.map((t, i) => {
			const k = disp(t);
			const open = S.sel === t.id;
			const dim = S.search.q.trim() && !searchHit(t);
			const deps = t.deps.length
				? `depois de ${t.deps.map(d => `<span class="ts-tag">#${esc(d)}</span>`).join('')}${gateTags(t)}`
				: `<span>começa primeiro</span>${gateTags(t)}`;
			const cls = ['ts-lr', i === 0 ? 'first' : '', i === D.tasks.length - 1 && !open ? 'last' : '', open ? 'open' : '', dim ? 'dim' : ''].filter(Boolean).join(' ');
			let html = `<div class="${cls}" data-act="row" data-id="${esc(t.id)}" role="button" tabindex="0" aria-expanded="${open}" style="--rc:${railColor(k)}"><div class="rail">${numBox(t, k)}</div><div class="t"><b>${esc(t.title)}</b><small>${esc(k === 'run' && t.now ? `Agora: ${t.now}` : k === 'bad' && t.problem ? t.problem.title : t.summary)}</small></div><div class="deps">${deps}</div><div class="time">${esc(timeCell(t, k))}</div><div class="st">${pill(k)}</div></div>`;
			if (open) {
				const kids = D.kids.get(t.id) ?? [];
				const log = t.log.slice(-3);
				html += `<div class="ts-lx" style="--rc:${railColor(k)}"><div></div>`
					+ `<div><h5>Para estar pronta</h5>${t.criteria.length ? criteriaRows(t, k) : `<div class="ts-li"><span class="tx wrap">${esc(t.detail || t.summary || 'Sem critérios.')}</span></div>`}</div>`
					+ `<div><h5>Agora</h5>${log.length ? logHtml(log) : `<div class="ts-li"><span class="tx">${esc(t.now || ST[k].label)}</span></div>`}</div>`
					+ `<div><h5>Libera</h5>${kids.length ? kids.map(c => `<div class="ts-li link" data-act="go" data-id="${esc(c)}">${icon('arrowR')}<span class="tx">#${esc(c)} ${esc(task(c).title)}</span></div>`).join('') : '<div class="ts-li"><span class="tx">Nada: é uma das últimas.</span></div>'}<div class="acts">${taskButtons(t, true)}</div></div></div>`;
			}
			return html;
		});
		return `<div class="ts-list" role="list">${rows.join('')}</div>`;
	}

	// ------------------------------------------------------------------ board view

	function boardCard(t) {
		const k = disp(t);
		let small = t.summary;
		const tags = [];
		const tag = (ic, c, text) => `<span class="ts-tag">${ic ? icon(ic, c) : ''}${esc(text)}</span>`;
		switch (k) {
			case 'run':
				if (t.now) {
					small = `Agora: ${t.now}`;
				}
				if (t.progress !== null) {
					tags.push(tag('', '', `${t.progress}%`));
				}
				if (t.estimate) {
					tags.push(tag('', '', `~${dur(Math.max(1, t.estimate * (1 - (t.progress ?? 0) / 100)))}`));
				}
				break;
			case 'pause':
				tags.push(tag('pause', 'c-rose', t.progress !== null ? `pausada · ${t.progress}%` : 'pausada'));
				break;
			case 'bad': {
				small = t.problem?.title || t.summary;
				const tries = t.log.filter(l => l.kind === 'error').length;
				if (tries) {
					tags.push(tag('error', 'c-red', plural(tries, 'tentativa', 'tentativas')));
				}
				const held = (S.D.kids.get(t.id) ?? []).filter(c => task(c).state === 'todo');
				if (held.length) {
					tags.push(tag('', '', `segura ${held.map(c => `#${c}`).join(' ')}`));
				}
				break;
			}
			case 'wait': {
				const p = pendingDeps(t);
				tags.push(tag('clock', 'c-grey', p.map(d => `#${d}`).join(' ')));
				tags.push(...unmetGates(t).map(g => tag(gateIcon(g), 'c-rose', lowerFirst(shortLabel(g.label)))));
				break;
			}
			case 'you':
				tags.push(...unmetGates(t).map(g => tag(gateIcon(g), 'c-rose', lowerFirst(shortLabel(g.label)))));
				if (t.estimate) {
					tags.push(tag('clock', 'c-grey', `~${dur(t.estimate)}`));
				}
				break;
			case 'ready':
				tags.push(tag('playCircle', 'c-bar', 'pronta'));
				if (t.estimate) {
					tags.push(tag('clock', 'c-grey', `~${dur(t.estimate)}`));
				}
				break;
			case 'skip':
				tags.push(tag('skip', 'c-grey', 'para depois'));
				break;
			default:
				if (tookText(t)) {
					tags.push(tag('clock', 'c-grey', tookText(t)));
				}
		}
		const dim = S.search.q.trim() && !searchHit(t);
		return `<button class="ts-k st-${k}${S.sel === t.id ? ' sel' : ''}${dim ? ' dim' : ''}" data-id="${esc(t.id)}" aria-label="${esc(`#${t.id} ${t.title}, ${ST[k].label}`)}"><b>#${esc(t.id)} ${esc(t.title)}</b><small>${esc(small)}</small>${tags.length ? `<div class="ft">${tags.join('')}</div>` : ''}</button>`;
	}

	function boardView() {
		const D = S.D;
		const by = k => D.tasks.filter(t => k.includes(disp(t)));
		const done = by(['done', 'skip']).sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0) || D.idx.get(b.id) - D.idx.get(a.id));
		const cols = [
			['Aguardando', '#5A5A5E', by(['wait', 'ready']), 'Nada aguardando.'],
			['Precisa de você', '#C2508F', by(['you']), 'Nada esperando você agora.'],
			['Executando', '#3399FF', by(['run', 'pause']), 'Nada executando agora.'],
		];
		if (D.counts.bad) {
			cols.push(['Com problema', '#D9534F', by(['bad']), '']);
		}
		cols.push(['Concluídas', '#37A93C', done, 'Nada concluído ainda.']);
		return `<div class="ts-board">${cols.map(([title, color, list, none]) => `<section class="ts-col" aria-label="${esc(title)}"><h4><i style="background:${color}"></i>${esc(title)}<em>${list.length}</em></h4>${list.length ? list.map(boardCard).join('') : `<div class="none">${esc(none)}</div>`}</section>`).join('')}</div>`;
	}

	// ------------------------------------------------------------------ timeline view

	function timelineModel() {
		const D = S.D;
		const now = Date.now();
		const est = t => (t.estimate ?? 5) * 60000;
		const firstStart = Math.min(...D.tasks.map(t => t.startedAt ?? Infinity));
		const info = new Map();
		for (const id of D.order) {
			const t = task(id);
			const k = disp(t);
			const depsEnd = t.deps.reduce((m, d) => Math.max(m, info.get(d)?.end ?? 0), 0);
			const segs = [];
			let start, end;
			if (t.state === 'done') {
				end = t.finishedAt ?? (t.startedAt ? t.startedAt + est(t) : Math.max(now, depsEnd) + est(t));
				start = t.startedAt ?? end - est(t);
				segs.push({ a: start, b: end, cls: 'done', text: tookText(t), bold: true });
			} else if (t.state === 'running' || t.state === 'paused') {
				start = t.startedAt ?? now;
				const stop = t.state === 'paused' && t.pausedAt ? t.pausedAt : now;
				segs.push({ a: start, b: Math.max(stop, start + 20000), cls: k === 'run' ? 'run' : 'you', text: t.progress !== null ? `${t.progress}%` : '', bold: true });
				const left = Math.max(60000, est(t) * (1 - (t.progress ?? 0) / 100));
				end = Math.max(now, stop) + left;
				segs.push({ a: Math.max(now, stop), b: end, cls: 'est', text: '' });
			} else if (t.state === 'failed') {
				const failAt = parseTime(t.problem?.at) ?? now;
				start = t.startedAt ?? failAt - 60000;
				segs.push({ a: start, b: Math.max(failAt, start + 20000), cls: 'bad', text: '' });
				end = Math.max(now, failAt) + est(t);
				segs.push({ a: Math.max(now, failAt), b: end, cls: 'est', text: `refazer · ~${dur(est(t) / 60000)}` });
			} else if (t.state === 'skipped') {
				start = end = Math.max(now, depsEnd);
				segs.push({ a: start, b: start, cls: 'skip', text: 'para depois' });
			} else {
				if (k === 'you') {
					const readyAt = t.deps.length ? depsEnd : (Number.isFinite(firstStart) ? firstStart : now);
					if (readyAt < now - 30000) {
						segs.push({ a: readyAt, b: now, cls: 'you', text: '' });
					}
				}
				start = Math.max(now, depsEnd);
				end = start + est(t);
				const g = unmetGates(t)[0];
				segs.push({ a: start, b: end, cls: 'est', text: `${g && k !== 'you' ? `${lowerFirst(shortLabel(g.label))} + ` : ''}~${dur(est(t) / 60000)}` });
			}
			info.set(id, { t, k, start: segs[0].a, end, segs });
		}
		return { info, now };
	}

	function timelineView(width) {
		const D = S.D;
		const { info, now } = timelineModel();
		const rows = [...info.values()].sort((a, b) => a.start - b.start || D.idx.get(a.t.id) - D.idx.get(b.t.id));
		const rowOf = new Map(rows.map((r, i) => [r.t.id, i]));
		let t0 = Math.min(now, ...rows.map(r => r.start));
		let t1 = Math.max(now, ...rows.map(r => r.end));
		const span = Math.max(10 * 60000, t1 - t0);
		const steps = [1, 2, 5, 10, 15, 30, 60, 120, 240, 480];
		const step = (steps.find(s => span / (s * 60000) <= 11) ?? 720) * 60000;
		t0 = Math.floor(t0 / step) * step;
		t1 = Math.ceil((t0 + Math.max(span, t1 - t0)) / step) * step;
		const LW = 250, TOP = 46, RH = 50;
		const W = Math.max(640, width);
		const plotW = W - LW - 30;
		const x = ms => LW + ((ms - t0) / (t1 - t0)) * plotW;
		const H = TOP + rows.length * RH + 48;
		const parts = [];
		parts.push(`<defs><pattern id="ts-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#232324"/><rect width="2.2" height="6" fill="#3A3A3D"/></pattern>${markerDefs()}</defs>`);
		rows.forEach((r, i) => {
			parts.push(`<rect class="bgr" x="0" y="${TOP + i * RH}" width="${W}" height="${RH}" fill="${i % 2 ? '#202021' : '#1E1E1E'}"/><line x1="0" x2="${W}" y1="${TOP + i * RH}" y2="${TOP + i * RH}" stroke="#262626"/>`);
		});
		const nowX = x(now);
		for (let m = t0; m <= t1 + 1; m += step) {
			const xx = r1(x(m));
			// The "agora" marker covers the hour labels right after it.
			const hidden = xx > nowX - 30 && xx < nowX + 96;
			parts.push(`<line x1="${xx}" x2="${xx}" y1="${TOP}" y2="${TOP + rows.length * RH}" stroke="#2A2A2B"/>${hidden ? '' : `<text class="tick" x="${xx}" y="26" text-anchor="middle">${hhmm(m)}</text>`}`);
		}
		const textW = s => s.length * 6.3 + 14;
		const outside = [];
		for (const r of rows) {
			const i = rowOf.get(r.t.id);
			const y = TOP + i * RH + 12;
			for (const s of r.segs) {
				if (s.cls === 'skip') {
					outside.push(`<text class="bo" x="${r1(x(s.a) + 4)}" y="${y + 16}">${esc(s.text)}</text>`);
					continue;
				}
				const x0 = x(s.a), w = Math.max(4, x(s.b) - x0 - 1);
				const style = {
					done: 'fill="#2F4A30" stroke="#4E7A4F"',
					run: 'fill="#1F3A57" stroke="#3399FF"',
					you: 'fill="#47223D" stroke="#B04A8E" stroke-dasharray="3 2"',
					bad: 'fill="#5A2121" stroke="#D9534F"',
					est: 'fill="url(#ts-hatch)" stroke="#6A6A6A" stroke-dasharray="3 3"',
				}[s.cls];
				parts.push(`<rect x="${r1(x0)}" y="${y}" width="${r1(w)}" height="25" ${style}/>`);
				if (s.text) {
					if (w >= textW(s.text)) {
						parts.push(`<text class="${s.bold ? 'bt' : 'bo'}" x="${r1(x0 + 8)}" y="${y + 16.5}">${esc(s.text)}</text>`);
					} else if (x0 + w + 6 + textW(s.text) <= W - 4) {
						outside.push(`<text class="bo" x="${r1(x0 + w + 6)}" y="${y + 16.5}">${esc(s.text)}</text>`);
					} else {
						outside.push(`<text class="bo" x="${r1(x0 - 6)}" y="${y + 16.5}" text-anchor="end">${esc(s.text)}</text>`);
					}
				}
			}
		}
		parts.push(...outside);
		for (const r of rows) {
			for (const d of r.t.deps) {
				const a = info.get(d);
				if (!a) {
					continue;
				}
				const x1 = x(a.end), y1 = TOP + rowOf.get(d) * RH + 37;
				const x2 = x(r.start), y2 = TOP + rowOf.get(r.t.id) * RH + 24.5;
				const kind = edgeKind(d, r.t.id);
				const dd = Math.abs(x2 - x1) < 3 ? `M${r1(x1)},${r1(y1)} V${r1(y2 - 12.5)}` : `M${r1(x1)},${r1(y1)} V${r1(y2)} H${r1(x2)}`;
				parts.push(`<path class="ts-e k-${kind}" d="${dd}" stroke-width="1" marker-end="url(#ts-ah-${kind})"/>`);
			}
		}
		const nx = r1(x(now));
		parts.push(`<line x1="${nx}" x2="${nx}" y1="10" y2="${TOP + rows.length * RH}" stroke="#E0782F" stroke-width="2"/><rect x="${nx - 1}" y="2" width="82" height="18" fill="#E0782F"/><text class="now" x="${nx + 6}" y="15">agora ${hhmm(now)}</text>`);
		const labels = rows.map((r, i) => `<div class="ts-grow${S.sel === r.t.id ? ' sel' : ''}" data-id="${esc(r.t.id)}" role="button" tabindex="0" style="top:${TOP + i * RH}px">${numBox(r.t, r.k)}<span>${esc(r.t.title)}</span></div>`).join('');
		const legend = `<div class="ts-legend" style="left:16px;top:${H - 30}px"><span><i class="sw-done"></i>feito</span><span><i class="sw-run"></i>executando</span><span><i class="sw-you"></i>esperando você</span><span><i class="sw-bad"></i>problema</span><span><i class="est"></i>estimativa</span><span><i class="ln"></i>libera a próxima</span></div>`;
		const endAt = Math.max(...rows.map(r => r.end));
		S.timelineEnd = endAt;
		return `<div class="ts-gantt" style="width:${W}px;height:${H}px"><svg width="${W}" height="${H}" aria-hidden="true">${parts.join('')}</svg>${labels}${legend}</div>`;
	}

	// ------------------------------------------------------------------ focus mode

	function focusTask() {
		const D = S.D;
		const pick = k => D.tasks.find(t => disp(t) === k);
		return (S.sel && task(S.sel)) || pick('run') || pick('pause') || pick('bad') || pick('you') || pick('ready') || null;
	}

	function focusView() {
		const D = S.D;
		const t = focusTask();
		const dots = `<div class="ts-dots">${D.tasks.map(x => {
			const k = disp(x);
			const m = k === 'done' || k === 'skip' ? 'm-done' : k === 'run' ? 'm-run' : k === 'you' || k === 'pause' ? 'm-you' : k === 'bad' ? 'm-bad' : '';
			return `<i class="${m}" title="${esc(`#${x.id} ${x.title}`)}"></i>`;
		}).join('')}<span>${D.counts.done} de ${D.total} concluídas</span></div>`;
		if (!t) {
			return `<div class="ts-focus"><div class="ts-empty"><h3>Nenhuma tarefa para acompanhar agora</h3><p>Quando uma tarefa começar, ela aparece aqui em tamanho grande.</p></div>${dots}</div>`;
		}
		const k = disp(t);
		const n = D.idx.get(t.id) + 1;
		const head = k === 'run' ? `${icon('spinner', 'c-bar')}Executando agora · tarefa ${n} de ${D.total}` : `${icon(ST[k].icon, ST[k].c)}${esc(ST[k].label)} · tarefa ${n} de ${D.total}`;
		let prog = '';
		if (t.progress !== null && (k === 'run' || k === 'pause')) {
			const left = t.estimate ? ` · ~${dur(Math.max(1, t.estimate * (1 - t.progress / 100)))}` : '';
			prog = `<div class="prog">${progressBar(t.progress)}<span>${t.progress}%${left}</span></div>`;
		}
		const steps = t.criteria.length ? `<div class="ts-steps">${criteriaRows(t, k).replace(/ts-li/g, 'ts-step')}</div>` : '';
		const log = t.log.length ? logHtml(t.log.slice(-3)) : '';
		const sideCard = (x, foot) => {
			const kx = disp(x);
			return `<button class="ts-k st-${kx}" data-act="go" data-id="${esc(x.id)}"><b>#${esc(x.id)} ${esc(x.title)}</b><small>${esc(x.result || x.summary)}</small>${foot ? `<div class="ft">${foot}</div>` : ''}</button>`;
		};
		const got = t.deps.map(d => {
			const x = task(d);
			const kx = disp(x);
			const foot = kx === 'done' ? `<span class="ts-tag">${icon('passed', 'c-green')}concluída${x.finishedAt ? ` ${hhmm(x.finishedAt)}` : ''}</span>` : `<span class="ts-tag">${icon(ST[kx].icon, ST[kx].c)}${esc(ST[kx].word)}</span>`;
			return sideCard(x, foot);
		}).join('') || '<div class="none">Começa sem depender de outra tarefa.</div>';
		const frees = (D.kids.get(t.id) ?? []).map(c => {
			const x = task(c);
			const others = x.deps.filter(d => d !== t.id && !satisfied(d));
			const tags = unmetGates(x).map(g => `<span class="ts-tag">${icon(gateIcon(g), 'c-rose')}falta ${esc(lowerFirst(shortLabel(g.label)))}</span>`);
			if (!tags.length && x.estimate) {
				tags.push(`<span class="ts-tag">${icon('clock', 'c-grey')}~${dur(x.estimate)}</span>`);
			}
			const card = sideCard(x, tags.join(''));
			return others.length ? card.replace(/<small>[^<]*<\/small>/, `<small>Também espera ${esc(joinIds(others))}</small>`) : card;
		}).join('') || '<div class="none">Nenhuma tarefa espera por esta.</div>';
		return `<div class="ts-focus"><div class="ts-fx"><div class="ts-fside"><h5>Recebeu pronto</h5>${got}</div><div class="ts-big st-${k}"><div class="bh">${head}</div><h2>${esc(t.title)}</h2><div class="lead">${refs(t.detail || t.summary)}</div>${prog}${steps}${log}<div class="acts">${taskButtons(t)}</div></div><div class="ts-fside"><h5>Vai liberar</h5>${frees}</div></div>${dots}</div>`;
	}

	// ------------------------------------------------------------------ history view

	function dayText(ms) {
		if (!ms) {
			return '';
		}
		const d = new Date(ms), n = new Date();
		const same = d.toDateString() === n.toDateString();
		return same ? `Hoje ${hhmm(ms)}` : `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${hhmm(ms)}`;
	}

	function changeCounts(changes) {
		const c = {};
		for (const x of changes) {
			c[x.kind] = (c[x.kind] ?? 0) + 1;
		}
		return KIND_ORDER.filter(k => c[k]).map(k => `${c[k]} ${c[k] === 1 ? KINDS[k].done : KINDS[k].many}`).join(' · ');
	}

	function historyView() {
		const H = S.history;
		if (!H) {
			return '<div class="ts-empty"><h3>Ainda não há histórico</h3><p>Cada vez que o plano muda, uma nova versão aparece aqui com o que mudou e por quê.</p></div>';
		}
		const versions = [...H.versions].reverse();
		const selN = versions.some(v => v.plan === S.histSel) ? S.histSel : versions[0].plan;
		const left = versions.map(v => {
			const on = v.plan === selN;
			const title = v.reason || (v.plan === versions[versions.length - 1].plan ? 'Plano inicial' : 'Mudança no plano');
			const who = v.cause?.task ? `você mudou ${task(v.cause.task) ? ref(v.cause.task) : `#${esc(v.cause.task)}`}` : v.changes.length ? '' : 'criado a partir do seu pedido';
			let box;
			if (v.changes.length) {
				box = `<div class="ts-li">${icon('sync')}<span class="tx">${esc(changeCounts(v.changes))}</span>${v.extra ? `<em>${v.extra > 0 ? '+' : ''}${v.extra} min</em>` : ''}</div>${v.cause?.text ? `<div class="ts-li">${icon('person')}<span class="tx">Pedido: “${esc(v.cause.text)}”</span></div>` : ''}`;
			} else {
				const est = v.tasks.reduce((s, t) => s + (t.estimate ?? 0), 0);
				box = `<div class="ts-li">${icon('checklist')}<span class="tx">${esc(plural(v.tasks.length, 'tarefa', 'tarefas'))}${est ? ` · ~${esc(dur(est))}` : ''}</span></div>`;
			}
			return `<div class="ts-hv${on ? ' on' : ''}" data-act="hist" data-n="${v.plan}" role="button" tabindex="0" aria-pressed="${on}"><span class="dot">${v.plan}</span><b>v${v.plan} · ${esc(title)}</b><small>${esc(dayText(v.at))}${who ? ` · ${who}` : ''}</small><div class="box">${box}</div></div>`;
		}).join('');
		const v = H.versions.find(x => x.plan === selN);
		const prev = H.versions.filter(x => x.plan < selN).pop();
		const prevBy = new Map((prev?.tasks ?? []).map(t => [t.id, t]));
		const curBy = new Map(v.tasks.map(t => [t.id, t]));
		let right;
		if (!prev || !v.changes.length) {
			const rows = v.tasks.map(t => `<tr><td class="n">#${esc(t.id)}</td><td>${esc(t.title)}</td><td>${esc(t.summary)}</td></tr>`).join('');
			right = `<h3>v${v.plan} · ${esc(v.reason || 'Plano inicial')}</h3><div class="sub">${esc(plural(v.tasks.length, 'tarefa', 'tarefas'))} quando a versão foi criada</div><table class="ts-table"><thead><tr><th></th><th>Tarefa</th><th>O que faz</th></tr></thead><tbody>${rows}</tbody></table>`;
		} else {
			const seen = new Set();
			const rows = v.changes.map(c => {
				seen.add(c.task);
				const a = prevBy.get(c.task), b = curBy.get(c.task);
				const name = a && b && a.title !== b.title ? diffHtml(a.title, b.title) : esc(b?.title || a?.title || c.title);
				const when = c.kind === 'alterar' ? ' antes de começar' : '';
				return `<tr><td class="n">#${esc(c.task)}</td><td>${name}</td><td>${c.kind === 'nova' ? `<ins>${esc(c.note || b?.summary || '')}</ins>` : esc(c.note)}</td><td><span class="kw w-${c.kind}">${esc(KINDS[c.kind].done)}</span>${when}</td></tr>`;
			});
			for (const b of v.tasks) {
				const a = prevBy.get(b.id);
				if (!seen.has(b.id) && a && a.title !== b.title) {
					rows.push(`<tr><td class="n">#${esc(b.id)}</td><td>${diffHtml(a.title, b.title)}</td><td>o título mudou</td><td class="same">—</td></tr>`);
				}
			}
			const cause = v.cause?.task ? `O que a mudança em #${esc(v.cause.task)} fez com o plano` : 'O que mudou de uma versão para a outra';
			right = `<h3>v${prev.plan} → v${v.plan}</h3><div class="sub">${cause}</div><table class="ts-table"><thead><tr><th></th><th>Tarefa</th><th>O que mudou</th><th>Situação</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
		}
		return `<div class="ts-hist"><div class="ts-hl" role="list" aria-label="Versões do plano">${left}</div><div class="ts-diff">${right}</div></div>`;
	}

	// ------------------------------------------------------------------ before and after (proposal)

	function compareView() {
		const p = S.proposal;
		const D = S.D;
		if (!p) {
			return '';
		}
		const ch = proposalIndex();
		const rows = [];
		let filesRedone = 0;
		for (const t of D.tasks) {
			const c = ch.get(t.id);
			if (!c) {
				rows.push(`<tr><td class="n">#${esc(t.id)}</td><td>${esc(t.title)}</td><td class="same">igual</td></tr>`);
				continue;
			}
			const kw = `<span class="kw w-${c.kind}">${esc(KINDS[c.kind].label)}</span>`;
			if (c.kind === 'remover') {
				rows.push(`<tr><td class="n">#${esc(t.id)}</td><td><del>${esc(t.title)}</del></td><td>${kw} · ${esc(c.note || 'sai do plano')}</td></tr>`);
				continue;
			}
			if (c.kind === 'refazer') {
				filesRedone += t.files.length;
			}
			const newTitle = c.title || t.title;
			const beforeText = c.summary ? t.summary : c.detail ? (t.detail || t.summary) : '';
			const afterText = c.summary || c.detail || '';
			const before = diffHtml(t.title, newTitle, 'del') + (afterText && beforeText ? ` · ${diffHtml(beforeText, afterText, 'del')}` : '');
			let after = kw;
			if (newTitle !== t.title) {
				after += ` · ${diffHtml(t.title, newTitle, 'ins')}`;
			}
			if (afterText) {
				after += ` · ${diffHtml(beforeText, afterText, 'ins')}`;
				if (c.note) {
					after += `<span class="note">${esc(c.note)}</span>`;
				}
			} else if (c.note) {
				after += ` · ${esc(c.note)}`;
			}
			rows.push(`<tr><td class="n">#${esc(t.id)}</td><td>${before}</td><td>${after}</td></tr>`);
		}
		for (const c of p.changes) {
			if (c.kind === 'nova' && !task(c.task)) {
				rows.push(`<tr><td class="n">#${esc(c.task)}</td><td class="same">—</td><td><span class="kw w-nova">Nova</span> · <ins>${esc(c.title || 'Nova tarefa')}</ins>${c.summary || c.note ? `<span class="note">${esc(c.summary || c.note)}</span>` : ''}</td></tr>`);
			}
		}
		const left = remainingMinutes();
		const right = left + (p.extra ?? 0);
		rows.push(`<tr class="foot"><td></td><td>Tempo restante: <b>~${esc(dur(left))}</b></td><td>Tempo restante: <b>~${esc(dur(right))}</b>${filesRedone ? ` · ${esc(plural(filesRedone, 'arquivo refeito', 'arquivos refeitos'))}` : ''}</td></tr>`);
		return `<div class="ts-compare"><table class="ts-table"><thead><tr><th style="width:46px"></th><th>Plano v${p.base} · antes</th><th>Plano v${p.plan} · depois</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
	}

	// ------------------------------------------------------------------ empty state

	const EXAMPLES = [
		{ icon: 'comment', title: 'Um site com agendamento', text: 'Crie um site de agendamento para a minha barbearia, com pagamento por Pix e lembrete no WhatsApp.' },
		{ icon: 'bug', title: 'Corrigir um problema', text: 'O login cai depois de alguns minutos. Encontre a causa, corrija e teste.' },
		{ icon: 'library', title: 'Uma automação', text: 'Toda segunda, leia as planilhas de vendas e me mande um resumo por e-mail.' },
	];

	function illustration() {
		return `<svg width="330" height="140" viewBox="0 0 330 140" aria-hidden="true"><rect x="10.5" y="40.5" width="90" height="58" fill="#2D2D30" stroke="#5A5A5E"/><rect x="10.5" y="40.5" width="90" height="15" fill="#2F4A30" stroke="#5A5A5E"/><rect x="15.5" y="43.5" width="9" height="9" fill="#1E1E1E" stroke="#8A8A8A"/><path d="M17,48l2,2l3.5,-4" stroke="#5DB653" stroke-width="1.4" fill="none"/><rect x="29" y="45" width="44" height="5" fill="#8FA88F"/><rect x="16" y="64" width="64" height="4" fill="#5A5A5E"/><rect x="16" y="74" width="48" height="4" fill="#5A5A5E"/><rect x="16.5" y="85.5" width="70" height="7" fill="#1E1E1E" stroke="#555"/><rect x="17" y="86" width="69" height="6" fill="#37A93C"/><path d="M101,69.5H123" stroke="#9A9A9A"/><path d="M119.5,66.5l3,3l-3,3" stroke="#9A9A9A" fill="none"/><rect x="124.5" y="40.5" width="90" height="58" fill="#2D2D30" stroke="#3399FF"/><rect x="124.5" y="40.5" width="90" height="15" fill="#1F3A57" stroke="#3399FF"/><rect x="129.5" y="43.5" width="9" height="9" fill="#1E1E1E" stroke="#8A8A8A"/><rect x="143" y="45" width="44" height="5" fill="#8EA6C2"/><rect x="130" y="64" width="64" height="4" fill="#5A5A5E"/><rect x="130.5" y="85.5" width="70" height="7" fill="#1E1E1E" stroke="#555"/><rect x="131" y="86" width="40" height="6" fill="#37A93C"/><path d="M215,69.5H238" stroke="#6A6A6A" stroke-dasharray="3 3"/><rect x="202.5" y="61.5" width="48" height="16" fill="#333337" stroke="#6A6A6E"/><rect x="207" y="66" width="6" height="7" fill="#D466A8"/><rect x="217" y="67" width="27" height="4" fill="#A0A0A0"/><rect x="238.5" y="40.5" width="82" height="58" fill="none" stroke="#5A5A5E" stroke-dasharray="3 3"/><rect x="239" y="41" width="81" height="14" fill="#333336"/><rect x="243.5" y="43.5" width="9" height="9" fill="#1E1E1E" stroke="#8A8A8A"/><rect x="257" y="45" width="40" height="5" fill="#5A5A5E"/><rect x="244" y="64" width="56" height="4" fill="#3F3F46"/></svg>`;
	}

	function emptyView() {
		const noProject = S.ctx && S.ctx.project === false;
		const note = noProject ? `<div class="ts-note">${icon('info', 'c-blue')}<span class="txt"><b>Aqui dá para montar o plano.</b> Para executar as tarefas, abra o TaskStudio a partir de um projeto: lá o agente tem os arquivos e o terminal do projeto.</span></div>` : '';
		return `<div class="ts-empty">${illustration()}<h3>Transforme um pedido em tarefas que se encadeiam</h3><p>O agente divide o pedido em tarefas, liga cada uma às que ela precisa e mostra tudo acontecendo: o que já foi feito, o que está rodando, o que espera algo e onde deu problema.</p><div class="ts-starts">${EXAMPLES.map((e, i) => `<button class="ts-start" data-act="example" data-i="${i}" title="Escrever este pedido no chat">${icon(e.icon)}<b>${esc(e.title)}</b><small>${esc(e.text)}</small></button>`).join('')}</div><div class="ts-how"><div><b><span>1</span>Planejar</b><small>Tarefas com detalhes, o que cada uma precisa e o que libera.</small></div><div><b><span>2</span>Acompanhar</b><small>Cores mostram o estado; problemas aparecem na própria tarefa.</small></div><div><b><span>3</span>Mudar quando quiser</b><small>Edite qualquer tarefa e veja o que muda antes de aplicar.</small></div></div>${note}</div>`;
	}

	// ------------------------------------------------------------------ right panels

	function depRows(t) {
		return t.deps.map(d => {
			const x = task(d);
			const k = disp(x);
			const ok = k === 'done' || k === 'skip';
			return `<div class="ts-li">${ok ? icon('passed', 'c-green') : icon(ST[k].icon, ST[k].c)}${ref(d)}<span class="tx">${esc(x.title)}${ok ? ` ${ST[k].word}` : ''}</span>${ok ? '' : `<em>${esc(ST[k].word)}</em>`}</div>`;
		}).join('');
	}

	function gateRows(t) {
		return t.gates.map(g => `<div class="ts-li">${g.met ? icon('passed', 'c-green') : icon(gateIcon(g), 'c-rose')}<span class="tx">${esc(g.label)}</span><em>${g.met ? 'resolvida' : 'falta'}</em></div>`).join('');
	}

	function subLine(t, k) {
		const bits = [];
		switch (k) {
			case 'run':
				if (t.startedAt) {
					bits.push(`começou ${hhmm(t.startedAt)}`);
				}
				if (t.estimate) {
					const left = t.progress !== null ? t.estimate * (1 - t.progress / 100) : t.estimate - (t.startedAt ? minutesBetween(t.startedAt, Date.now()) : 0);
					bits.push(`~${dur(Math.max(1, left))} restantes`);
				}
				break;
			case 'pause':
				if (t.progress !== null) {
					bits.push(`${t.progress}%`);
				}
				if (t.pausedAt) {
					bits.push(`desde ${hhmm(t.pausedAt)}`);
				}
				break;
			case 'done':
				if (t.finishedAt) {
					bits.push(`às ${hhmm(t.finishedAt)}`);
				}
				if (tookText(t)) {
					bits.push(`levou ${tookText(t)}`);
				}
				break;
			case 'bad': {
				const when = at(t.problem?.at);
				if (when) {
					bits.push(`parou às ${when}`);
				}
				const tries = t.log.filter(l => l.kind === 'error').length;
				if (tries > 1) {
					bits.push(`${tries} tentativas`);
				}
				break;
			}
			case 'wait':
				bits.push(waitText(t).text);
				break;
			default:
				if (estText(t)) {
					bits.push(`estimativa ${estText(t)}`);
				}
		}
		return `<div class="sub">${pill(k)}${bits.length ? `<span>${esc(bits.join(' · '))}</span>` : ''}</div>`;
	}

	function panelHead(t, k, prefix = '') {
		return `<h3>${numBox(t, k)}<span class="tt">${esc(prefix)}${esc(t.title)}</span></h3>`;
	}

	function closeBtn(label = 'Fechar painel') {
		return `<button class="ts-ib close" data-act="close-panel" title="${esc(label)}" aria-label="${esc(label)}">${icon('close')}</button>`;
	}

	function fileRows(t, max = 10) {
		const list = t.files.slice(0, max);
		const project = S.ctx?.project !== false;
		const rows = list.map(f => {
			const ic = f.state === 'partial' ? icon('pause', 'c-rose') : icon('passed', 'c-green');
			const text = `<code class="tx">${esc(f.path)}</code>`;
			const em = `<em>${f.state === 'partial' ? 'pela metade' : 'feito'}</em>`;
			return project
				? `<button class="ts-li link" data-act="open-file" data-path="${esc(f.path)}" title="Abrir no editor">${ic}${text}${em}</button>`
				: `<div class="ts-li">${ic}${text}${em}</div>`;
		}).join('');
		const more = t.files.length > max ? `<div class="ts-li"><span class="tx">+${t.files.length - max} arquivos</span></div>` : '';
		return rows + more;
	}

	function inspectorHtml(t) {
		const D = S.D;
		const k = disp(t);
		const parts = [panelHead(t, k), subLine(t, k)];
		if (t.mark) {
			parts.push(`<div class="ts-note">${icon('sync', 'c-rose')}<span class="txt">Mudou no plano v${esc(t.mark.plan ?? '')}: <b class="w-${t.mark.kind}">${esc(KINDS[t.mark.kind].label)}</b>${t.mark.note ? ` · ${esc(t.mark.note)}` : ''}</span></div>`);
		}
		if (t.detail || t.summary) {
			parts.push(`<h5>O que é</h5><p>${refs(t.detail || t.summary)}</p>`);
		}
		if (t.criteria.length) {
			parts.push(`<h5>Para estar pronta</h5>${criteriaRows(t, k)}`);
		}
		if (t.deps.length || t.gates.length) {
			const started = ['run', 'pause', 'done', 'bad'].includes(k);
			parts.push(`<h5>${started ? 'Começou porque' : 'Condições para começar'}</h5>${depRows(t)}${gateRows(t)}`);
		}
		if (k === 'done' && t.result) {
			parts.push(`<h5>Entregue</h5><p>${refs(t.result)}</p>`);
		}
		if (t.log.length) {
			const title = k === 'run' ? `Agora${t.files.length ? ` · ${plural(t.files.length, 'arquivo', 'arquivos')}` : ''}` : 'Registro';
			parts.push(`<h5>${esc(title)}</h5>${logHtml(t.log.slice(-6))}`);
		} else if (k === 'run' && t.now) {
			parts.push(`<h5>Agora</h5><p>${esc(t.now)}</p>`);
		}
		const kids = D.kids.get(t.id) ?? [];
		if (kids.length) {
			parts.push(`<h5>${k === 'done' ? 'Liberou' : 'Quando terminar, libera'}</h5>${kids.map(c => {
				const x = task(c);
				const g = unmetGates(x)[0];
				return `<div class="ts-li link" data-act="go" data-id="${esc(c)}">${icon('arrowR')}${ref(c)}<span class="tx">${esc(x.title)}</span>${g ? `<em>+ ${esc(lowerFirst(shortLabel(g.label)))}</em>` : ''}</div>`;
			}).join('')}`);
		}
		if (t.files.length) {
			parts.push(`<h5>Arquivos <em>${t.files.length}</em></h5>${fileRows(t, 8)}`);
		}
		return panel(parts.join(''), taskButtons(t, false, true), `Detalhes de #${t.id}`);
	}

	function panel(body, foot, label, wide) {
		return `<aside class="ts-panel${wide ? ' wide' : ''}" role="complementary" aria-label="${esc(label)}"><div class="scroll">${closeBtn()}${body}</div>${foot ? `<div class="foot">${foot}</div>` : ''}</aside>`;
	}

	function editKind(t) {
		return t.state === 'done' ? 'done' : t.state === 'running' || t.state === 'paused' ? 'running' : 'todo';
	}

	function editChanged(e) {
		return e.title.trim() !== e.origTitle.trim() || e.detail.trim() !== e.origDetail.trim();
	}

	function editBox(field, value, orig, multiline, label) {
		const changed = value.trim() !== orig.trim();
		const showDiff = changed && S.editFocus !== field;
		const id = `ts-edit-${field}`;
		const input = multiline
			? `<textarea id="${id}" class="ts-input raw" data-field="${field}" rows="4" spellcheck="true">${esc(value)}</textarea>`
			: `<input id="${id}" class="ts-input raw" data-field="${field}" value="${esc(value)}" spellcheck="true">`;
		const diff = `<div class="ts-input ts-diffview" data-act="edit-show" data-field="${field}" tabindex="0" role="button" aria-label="${esc(`${label}, com as mudanças marcadas. Clique para editar.`)}">${diffHtml(orig, value)}</div>`;
		return `<div class="ts-field"><label for="${id}">${esc(label)}</label><div class="ts-edit-box${showDiff ? ' show-diff' : ''}" data-field="${field}">${input}${diff}</div></div>`;
	}

	function impactRows(t) {
		const desc = allDescendants(t.id);
		if (!desc.length) {
			return '<p>Nenhuma outra tarefa depende desta.</p>';
		}
		const groups = { done: [], running: [], todo: [] };
		for (const id of desc) {
			const x = task(id);
			groups[x.state === 'done' ? 'done' : x.state === 'running' || x.state === 'paused' ? 'running' : 'todo'].push(id);
		}
		const rows = [];
		for (const id of groups.done) {
			rows.push(`<div class="ts-li">${icon('arrowR')}${ref(id)}<span class="tx">${esc(task(id).title)}</span><em>concluída</em></div>`);
		}
		for (const id of groups.running) {
			rows.push(`<div class="ts-li">${icon('arrowR')}${ref(id)}<span class="tx">${esc(task(id).title)}</span><em>${esc(ST[disp(task(id))].word)}</em></div>`);
		}
		if (groups.todo.length) {
			rows.push(`<div class="ts-li">${icon('arrowR')}<span class="tx">${groups.todo.map(ref).join(' ')}</span><em>ainda não ${groups.todo.length === 1 ? 'feita' : 'feitas'}</em></div>`);
		}
		const warn = groups.done.length
			? `<div class="ts-note">${icon('warning', 'c-rose')}<span class="txt">Pode afetar ${esc(plural(groups.done.length, 'tarefa', 'tarefas'))} <b>já ${groups.done.length === 1 ? 'concluída' : 'concluídas'}</b>. A recalibração confirma o que muda de verdade, e você vê a lista antes de aplicar.</span></div>`
			: `<div class="ts-hint">A recalibração confirma o que muda de verdade.</div>`;
		return rows.join('') + warn;
	}

	function editHtml(t) {
		const e = S.edit;
		const k = disp(t);
		const kind = editKind(t);
		const parts = [panelHead(t, k, 'Editar: ')];
		let sub = ST[k].label;
		if (k === 'done' && t.finishedAt) {
			sub = `Concluída às ${hhmm(t.finishedAt)}`;
		} else if (k === 'pause' && t.progress !== null) {
			sub = `Pausada · ${t.progress}%`;
		} else if (k === 'wait') {
			sub = `Aguardando ${pendingDeps(t).map(d => `#${d}`).join(' ')}`;
		}
		parts.push(`<div class="sub">${pill(k, sub)}</div>`);
		if (kind === 'done') {
			parts.push(`<div class="ts-note">${icon('warning', 'c-rose')}<span class="txt">Esta tarefa já foi feita. Ao salvar, o agente recalibra o plano: tarefas que usam esta podem ser refeitas ou ajustadas. Você vê a lista antes de aplicar.</span></div>`);
		}
		parts.push(editBox('title', e.title, e.origTitle, false, 'Título'));
		parts.push(editBox('detail', e.detail, e.origDetail, true, 'O que fazer'));
		if (t.criteria.length) {
			parts.push(`<div class="ts-field"><span class="lbl">Para estar pronta</span>${criteriaRows(t, k)}</div>`);
		}
		if (kind !== 'todo' && t.files.length) {
			parts.push(`<h5>Já feito nesta tarefa</h5>${fileRows(t, 8)}`);
		}
		if (kind === 'todo' && (t.deps.length || t.gates.length)) {
			parts.push(`<div class="ts-field"><span class="lbl">Condições para começar</span>${depRows(t)}${gateRows(t)}</div>`);
		}
		parts.push(`<h5>Prévia do impacto</h5>${impactRows(t)}`);
		const changed = editChanged(e);
		const dis = changed ? '' : ' disabled title="Mude o texto para recalibrar."';
		const foot = [];
		if (kind === 'done') {
			foot.push(`<button class="ts-btn warn" data-act="recal"${dis}>${icon('sync')}Recalibrar</button>`);
		} else if (kind === 'running') {
			foot.push(`<button class="ts-btn warn" data-act="recal"${dis}>${icon('sync')}Recalibrar e retomar</button>`);
			foot.push(`<button class="ts-btn" data-act="resume" data-id="${esc(t.id)}">${icon('resume')}Retomar sem mudar</button>`);
		} else {
			foot.push(`<button class="ts-btn warn" data-act="recal"${dis}>${icon('sync')}Salvar e recalibrar</button>`);
		}
		foot.push(`<button class="ts-btn" data-act="edit-cancel">Cancelar</button>`);
		return panel(parts.join(''), foot.join(''), `Editar #${t.id}`);
	}

	function gateHtml(t) {
		const k = disp(t);
		const unmet = unmetGates(t);
		const g = unmet[0] ?? t.gates[0];
		const parts = [panelHead(t, k), subLine(t, k)];
		parts.push(`<h5>Condições para começar</h5>${depRows(t)}${gateRows(t)}`);
		if (g && !g.met) {
			if (g.kind === 'secret') {
				if (g.where) {
					parts.push(`<h5>Onde encontro</h5><p>${refs(g.where)}</p>`);
				}
				if (g.env) {
					parts.push(`<h5>Onde colocar</h5><p>No arquivo de ambiente do projeto (por exemplo <code>.env</code>), nesta variável:</p><div class="ts-env"><span class="lbl">variável</span><code>${esc(g.env)}=…</code></div>`);
				}
				parts.push(`<div class="ts-note">${icon('shield', 'c-blue')}<span class="txt">O valor não passa pelo chat nem pelo TaskStudio. Coloque no projeto e clique em <b>Já resolvi</b>.</span></div>`);
			} else if (g.kind === 'approval') {
				const what = norm(g.label) === 'aprovacao' ? 'Sua aprovação para começar esta tarefa.' : `Sua aprovação para começar: ${esc(g.label)}.`;
				parts.push(`<h5>O que precisa</h5><p>${what}</p>${g.where ? `<p>${refs(g.where)}</p>` : ''}`);
			} else if (g.where) {
				parts.push(`<h5>${g.kind === 'choice' ? 'O que escolher' : 'O que falta'}</h5><p>${refs(g.where)}</p>`);
			}
			if (g.alternatives.length) {
				parts.push(`<h5>${g.kind === 'choice' ? 'Opções' : 'Se preferir'}</h5>${g.alternatives.map((a, i) => `<button class="ts-li link" data-act="option" data-src="gate" data-id="${esc(t.id)}" data-i="${i}" title="Pedir isto no chat">${icon(g.kind === 'choice' ? 'arrowR' : 'skip')}<span class="tx">${esc(a)}</span></button>`).join('')}`);
			}
		}
		const foot = [];
		if (g && !g.met) {
			foot.push(g.kind === 'approval'
				? `<button class="ts-btn primary" data-act="gate-approve" data-id="${esc(t.id)}">${icon('check')}Aprovar</button>`
				: `<button class="ts-btn primary" data-act="gate-done" data-id="${esc(t.id)}">${icon('unlock')}Já resolvi</button>`);
			foot.push(`<button class="ts-btn" data-act="gate-later" data-id="${esc(t.id)}">${icon('skip')}Deixar para depois</button>`);
		}
		return panel(parts.join(''), foot.join(''), `Condição de #${t.id}`);
	}

	function problemHtml(t) {
		const k = disp(t);
		const pb = t.problem ?? { title: 'A tarefa parou com um problema.', detail: '', options: [] };
		const parts = [panelHead(t, k), subLine(t, k)];
		parts.push(`<div class="ts-note">${icon('error', 'c-red')}<span class="txt"><b>${esc(pb.title)}</b>${pb.detail ? ` ${refs(pb.detail)}` : ''}</span></div>`);
		if (t.log.length) {
			parts.push(`<h5>Registro</h5>${logHtml(t.log.slice(-8))}`);
		}
		const held = allDescendants(t.id).filter(id => task(id).state === 'todo');
		if (held.length) {
			parts.push(`<h5>O que isso segura</h5>${held.slice(0, 6).map(id => `<div class="ts-li">${icon('pause', 'c-grey')}${ref(id)}<span class="tx">${esc(task(id).title)}</span><em>esperando</em></div>`).join('')}`);
		}
		const foot = pb.options.map((o, i) => `<button class="ts-btn${i === 0 ? ' primary' : ''}" data-act="option" data-src="problem" data-id="${esc(t.id)}" data-i="${i}">${icon(i === 0 ? 'key' : 'wand')}${esc(o)}</button>`);
		foot.push(`<button class="ts-btn" data-act="retry" data-id="${esc(t.id)}">${icon('sync')}Tentar de novo</button>`);
		foot.push(`<button class="ts-btn" data-act="gate-later" data-id="${esc(t.id)}">${icon('skip')}Deixar para depois</button>`);
		return panel(parts.join(''), foot.join(''), `Problema em #${t.id}`);
	}

	function changeTitle(c) {
		return c.title || task(c.task)?.title || 'Nova tarefa';
	}

	function changeGroups(withSame) {
		const p = S.proposal;
		const out = [];
		for (const kind of KIND_ORDER) {
			const list = p.changes.filter(c => c.kind === kind);
			if (!list.length) {
				continue;
			}
			out.push(`<h6><i class="k-${kind}"></i>${esc(KINDS[kind].group)}<em>${list.length}</em></h6>`);
			for (const c of list) {
				out.push(`<button class="ts-cr" data-act="chg" data-id="${esc(c.task)}"><span class="n k-${kind}">${esc(c.task)}</span><span class="body"><b>${esc(changeTitle(c))}</b>${c.note || c.summary ? `<small>${refs(c.note || c.summary)}</small>` : ''}</span>${c.why ? `<span class="why">${refs(c.why)}</span>` : ''}</button>`);
			}
		}
		if (withSame) {
			const changed = new Set(p.changes.map(c => c.task));
			const same = S.D.tasks.filter(t => !changed.has(t.id));
			if (same.length) {
				out.push(`<h6><i style="background:#5A5A5E"></i>Sem mudança<em>${same.length}</em></h6><div class="ts-same">${same.map(t => ref(t.id)).join(' ')}</div>`);
			}
		}
		return `<div class="ts-chg">${out.join('')}</div>`;
	}

	function staleNote() {
		const stale = staleProposalTasks();
		const p = S.proposal;
		const cause = p?.cause?.task;
		const partial = p?.baseline && recalibrating() && cause && task(cause)
			? `<div class="ts-note">${icon('info', 'c-blue')}<span class="txt">O agente ainda não conferiu as outras tarefas: esta lista só refaz ${ref(cause)} com a sua mudança. Aplique assim ou peça no chat para ele conferir o resto.</span></div>`
			: '';
		return partial + (stale.length ? `<div class="ts-note">${icon('warning', 'c-rose')}<span class="txt">${stale.map(ref).join(' ')} mudou de estado depois desta lista. Peça uma nova recalibração no chat antes de aplicar.</span></div>` : '');
	}

	function proposalButtons(modal) {
		return [
			`<button class="ts-btn primary" data-act="apply">${icon('check')}Aplicar mudanças</button>`,
			modal ? `<button class="ts-btn" data-act="proposal-side">${icon('checklist')}Revisar uma a uma</button>` : `<button class="ts-btn" data-act="mode" data-mode="compare">${icon('compare')}Comparar antes e depois</button>`,
			`<button class="ts-btn" data-act="discard">${icon('discard')}Descartar</button>`,
		].join('');
	}

	function proposalHtml() {
		const p = S.proposal;
		const cause = p.cause?.task;
		const bits = [`Plano v${p.plan}`];
		if (cause) {
			bits.push(`por causa da sua mudança em ${task(cause) ? ref(cause) : `#${esc(cause)}`}`);
		}
		if (p.extra) {
			bits.push(`cerca de ${p.extra > 0 ? '+' : ''}${p.extra} min`);
		}
		const body = `<h3>${icon('checklist')}<span class="tt">O que vai mudar</span></h3><div class="sub">${bits.join(' · ')}</div>${p.summary ? `<p>${refs(p.summary)}</p>` : ''}${staleNote()}${changeGroups(true)}`;
		return `<aside class="ts-panel wide" role="complementary" aria-label="O que vai mudar"><div class="scroll"><button class="ts-ib close" data-act="proposal-hide" title="Esconder a lista" aria-label="Esconder a lista">${icon('close')}</button>${body}</div><div class="foot">${proposalButtons(false)}</div></aside>`;
	}

	function finishedHtml() {
		const D = S.D;
		const starts = D.tasks.map(t => t.startedAt).filter(Boolean);
		const ends = D.tasks.map(t => t.finishedAt).filter(Boolean);
		const total = starts.length && ends.length ? dur(minutesBetween(Math.min(...starts), Math.max(...ends))) : '';
		const versions = S.history?.versions ?? [];
		const recal = Math.max(0, (versions.length || planVersion()) - 1);
		const extra = versions.reduce((s, v) => s + (v.extra ?? 0), 0);
		const problems = D.tasks.filter(t => t.log.some(l => l.kind === 'error')).length;
		const gates = D.tasks.reduce((s, t) => s + t.gates.length, 0);
		const files = new Set(D.tasks.flatMap(t => t.files.map(f => f.path))).size;
		const delivered = D.tasks.filter(t => t.result).slice(-6);
		const row = (ic, c, text, em) => `<div class="ts-li">${icon(ic, c)}<span class="tx">${esc(text)}</span>${em ? `<em>${esc(em)}</em>` : ''}</div>`;
		const parts = [`<h3>${icon('passed', 'c-green')}<span class="tt">Plano concluído</span></h3><div class="sub">${esc(S.plan.title || 'Plano')}${ends.length ? ` · terminou às ${hhmm(Math.max(...ends))}` : ''}</div>`];
		if (delivered.length) {
			parts.push(`<h5>Entregue</h5>${delivered.map(t => `<div class="ts-li link" data-act="go" data-id="${esc(t.id)}" title="${esc(`#${t.id} ${t.title}: ${t.result}`)}">${icon('passed', 'c-green')}<span class="tx">${esc(t.result)}</span><em>#${esc(t.id)}</em></div>`).join('')}`);
		}
		parts.push(`<h5>Como foi</h5>${total ? row('clock', 'c-grey', 'Tempo total', total) : ''}${row('sync', 'c-grey', 'Recalibrações', `${recal}${extra ? ` · ${extra > 0 ? '+' : ''}${extra} min` : ''}`)}${row('error', 'c-grey', 'Problemas resolvidos', String(problems))}${row('person', 'c-grey', 'Vezes que precisou de você', String(gates))}${files ? row('files', 'c-grey', 'Arquivos', String(files)) : ''}`);
		const secrets = D.tasks.flatMap(t => t.gates.filter(g => g.kind === 'secret' && g.env).map(g => g.env));
		if (secrets.length) {
			parts.push(`<h5>Antes de usar de verdade</h5><div class="ts-note">${icon('key', 'c-rose')}<span class="txt">Troque os valores de teste pelos de produção no arquivo de ambiente do projeto: ${secrets.map(s => `<code>${esc(s)}</code>`).join(', ')}.</span></div>`);
		}
		const foot = `<button class="ts-btn" data-act="mode" data-mode="history">${icon('history')}Ver histórico</button><button class="ts-btn primary" data-act="export">${icon('export')}Exportar</button>`;
		return `<aside class="ts-panel" role="complementary" aria-label="Plano concluído"><div class="scroll">${closeBtn()}${parts.join('')}</div><div class="foot">${foot}</div></aside>`;
	}

	// ------------------------------------------------------------------ dialogs

	function step(state, label, note) {
		const ic = state === 'done' ? icon('passed', 'c-green') : state === 'run' ? icon('spinner', 'c-bar') : icon('circle', 'c-grey');
		return `<div class="ts-step${state === 'todo' ? ' todo' : ''}">${ic}<span>${esc(label)}</span>${note ? `<span class="snote">${esc(note)}</span>` : ''}</div>`;
	}

	function recalModalHtml() {
		const r = recalibrating();
		const o = S.recal;
		if (!r && !o) {
			return '';
		}
		if (r && S.recalHidden === (r.at ?? 'x')) {
			return '';
		}
		const id = r ? nid(r.task) : o.task;
		const t = task(id);
		const text = r ? str(r.text, 400) : o.text;
		let steps;
		let extra = '';
		if (r) {
			const sets = impactSets(r);
			const paused = (Array.isArray(r.paused) ? r.paused.map(nid) : []).filter(x => task(x));
			steps = step('done', 'Entender a mudança', '')
				+ step('done', 'Conferir tarefas concluídas', sets.done.length ? plural(sets.done.length, 'tarefa', 'tarefas') : 'nenhuma')
				+ step('done', 'Conferir tarefas em execução', paused.length ? `${joinIds(paused)} ${paused.length === 1 ? 'pausada' : 'pausadas'}` : sets.running.length ? plural(sets.running.length, 'tarefa', 'tarefas') : 'nenhuma')
				+ step('done', 'Ajustar as tarefas que faltam', sets.todo.length ? plural(sets.todo.length, 'tarefa', 'tarefas') : 'nenhuma')
				+ step(recalRunning() ? 'run' : 'todo', 'Montar a lista do que vai mudar', '');
			if (!recalRunning()) {
				extra = `<div class="ts-note">${icon('warning', 'c-rose')}<span class="txt">O agente parou antes de montar a lista do que vai mudar. Peça no chat para continuar a recalibração.</span></div><div class="foot"><button class="ts-btn" data-act="recal-hide">Fechar</button></div>`;
			}
		} else {
			steps = step('run', 'Entender a mudança', '') + step('todo', 'Conferir tarefas concluídas', '') + step('todo', 'Conferir tarefas em execução', '') + step('todo', 'Ajustar as tarefas que faltam', '') + step('todo', 'Montar a lista do que vai mudar', '');
		}
		const who = t ? `${ref(id)} ${esc(t.title)}` : `#${esc(id)}`;
		const what = text ? `: «${esc(text.replace(/[\s.]+$/, ''))}»` : '';
		return `<div class="ts-scrim"></div><div class="ts-modal" role="dialog" aria-modal="true" aria-labelledby="ts-recal-title"><h3 id="ts-recal-title">${icon('spinner')}Recalibrando as tarefas</h3><div class="mb"><p>Você mudou ${who}${what}. O agente está vendo o que isso afeta no que já foi feito, no que está rodando e no que falta.</p><div class="ts-steps">${steps}</div><div class="ts-note">${icon('info', 'c-blue')}<span class="txt">Nada é refeito antes de você ver a lista e aprovar.</span></div>${extra}</div></div>`;
	}

	function proposalModalHtml() {
		const p = S.proposal;
		const cause = p.cause?.task;
		const doneN = p.changes.filter(c => c.kind === 'refazer').length;
		const running = S.D.tasks.filter(t => disp(t) === 'run' && !p.changes.some(c => c.task === t.id)).map(t => t.id);
		const text = `Sua mudança em ${cause && task(cause) ? ref(cause) : 'uma tarefa'} afeta ${plural(p.changes.length, 'tarefa', 'tarefas')}, incluindo ${doneN} já ${doneN === 1 ? 'concluída' : 'concluídas'}.${running.length ? ` ${running.map(ref).join(' e ')} ${running.length === 1 ? 'continua' : 'continuam'} executando: não ${running.length === 1 ? 'é afetada' : 'são afetadas'}.` : ''}`;
		return `<div class="ts-scrim"></div><div class="ts-modal wide" role="dialog" aria-modal="true" aria-labelledby="ts-prop-title"><h3 id="ts-prop-title">${icon('checklist')}O que vai mudar</h3><div class="mb"><p>${text}</p>${staleNote()}${changeGroups(false)}<div class="foot">${proposalButtons(true)}</div></div></div>`;
	}

	// ------------------------------------------------------------------ toolbar

	function versionText() {
		if (!S.plan) {
			return S.running ? 'montando' : 'vazio';
		}
		if (S.plan.draft) {
			return 'rascunho';
		}
		const n = planVersion();
		if (recalibrating() || S.recal) {
			return `plano v${n} → v${n + 1}`;
		}
		if (S.proposal) {
			return S.mode === 'compare' ? `v${S.proposal.base} × v${S.proposal.plan}` : `plano v${S.proposal.plan} · proposta`;
		}
		if (S.D?.finished) {
			return `plano v${n} · concluído`;
		}
		return `plano v${n}`;
	}

	function segHtml() {
		const btn = m => `<button class="${S.mode === m ? 'on' : ''}" data-act="mode" data-mode="${m}" aria-pressed="${S.mode === m}" title="${esc(MODES[m].label)}">${icon(MODES[m].icon)}<span class="lbl">${esc(MODES[m].label)}</span></button>`;
		const list = ['map', 'list', 'board', 'timeline'].map(btn);
		if (!MODES[S.mode].main) {
			list.push(btn(S.mode));
		}
		list.push(`<button class="more${S.menu === 'more' ? ' on' : ''}" data-act="menu" data-menu="more" aria-haspopup="menu" aria-expanded="${S.menu === 'more'}" title="Mais vistas" aria-label="Mais vistas">${icon('chevD', 's12')}</button>`);
		return `<div class="ts-seg" role="toolbar" aria-label="Vistas">${list.join('')}</div>`;
	}

	function searchHtml() {
		if (!S.D?.total) {
			return '';
		}
		if (!S.search.open) {
			return `<button class="ts-ib" data-act="search-open" title="Buscar tarefa (Ctrl+F)" aria-label="Buscar tarefa">${icon('search')}</button>`;
		}
		const q = S.search.q.trim();
		const hits = q ? S.D.tasks.filter(searchHit).length : null;
		return `<div class="ts-search"><input id="ts-search-input" type="text" placeholder="Buscar tarefa" value="${esc(S.search.q)}" aria-label="Buscar tarefa" autocomplete="off">${hits !== null ? `<span class="hits">${hits === 1 ? '1 tarefa' : `${hits} tarefas`}</span>` : ''}<button class="ts-ib" data-act="search-close" aria-label="Fechar busca" title="Fechar busca">${icon('close')}</button></div>`;
	}

	function actionButton() {
		const D = S.D;
		if (!D?.total || S.plan.draft) {
			return '';
		}
		if (!D.started) {
			return S.ctx?.project === false ? '' : `<button class="ts-btn primary" data-act="start">${icon('play')}<span class="lbl">Começar</span></button>`;
		}
		if (D.finished) {
			return '';
		}
		if (S.running) {
			return `<button class="ts-btn" data-act="stop" title="Parar o agente nesta conversa">${icon('pause')}<span class="lbl">Pausar</span></button>`;
		}
		if ((D.counts.pause || D.counts.ready) && S.ctx?.project !== false) {
			return `<button class="ts-btn" data-act="resume-all">${icon('resume')}<span class="lbl">Retomar tudo</span></button>`;
		}
		return '';
	}

	function meterHtml(c, total) {
		const parts = [['done', c.done + c.skip], ['run', c.run], ['you', c.you + c.pause], ['bad', c.bad]];
		return `<span class="ts-meter" role="img" aria-label="${esc(`${c.done} de ${total} concluídas`)}">${parts.filter(([, v]) => v).map(([k, v]) => `<i class="m-${k}" style="width:${(v / total) * 100}%"></i>`).join('')}</span>`;
	}

	function spinText(text) {
		return `<span class="ts-sum"><span>${icon('spinner', 'c-bar')}${esc(text)}</span></span>`;
	}

	function statusHtml() {
		if (!S.plan) {
			return S.running ? spinText('Montando o plano') : '';
		}
		const D = S.D;
		if (S.plan.draft) {
			return S.running ? spinText('Montando o plano') : `<span class="ts-sum"><span>${esc(plural(D.total, 'tarefa definida', 'tarefas definidas'))}</span></span>`;
		}
		if (!D.total) {
			return '';
		}
		if (recalibrating() || S.recal) {
			return spinText('Recalibrando');
		}
		if (S.mode === 'history') {
			const n = S.history?.versions.length ?? 1;
			return `<span class="ts-sum"><span>${esc(plural(n, 'versão', 'versões'))}</span></span>`;
		}
		if (S.proposal) {
			const p = S.proposal;
			const changed = new Set(p.changes.map(c => c.task));
			const same = D.tasks.filter(t => !changed.has(t.id)).length;
			if (S.mode === 'compare') {
				return `<span class="ts-sum"><span>${changed.size} ${changed.size === 1 ? 'muda' : 'mudam'}${p.extra ? ` · ${p.extra > 0 ? '+' : ''}${p.extra} min` : ''}</span></span><button class="ts-btn" data-act="discard">${icon('discard')}<span class="lbl">Manter v${p.base}</span></button><button class="ts-btn primary" data-act="apply">${icon('check')}<span class="lbl">Aplicar v${p.plan}</span></button>`;
			}
			const hidden = panelKind() !== 'proposal' && !(proposalTouchesDone() && !S.proposalSide);
			return `<span class="ts-sum"><span>${changed.size} ${changed.size === 1 ? 'tarefa muda' : 'tarefas mudam'} · ${same} ${same === 1 ? 'igual' : 'iguais'}</span></span>${hidden ? `<button class="ts-btn" data-act="proposal-show">${icon('checklist')}<span class="lbl">Ver mudanças</span></button>` : ''}`;
		}
		if (!D.started) {
			const tot = totalEstimate();
			return `<span class="ts-sum"><span>${esc(plural(D.total, 'tarefa', 'tarefas'))}${tot ? ` · cerca de ${esc(dur(tot))}` : ''}</span></span>${actionButton()}`;
		}
		const c = D.counts;
		if (S.mode === 'timeline' && S.timelineEnd && !D.finished) {
			return `<span class="ts-sum"><span class="muted">término previsto</span><b>${hhmm(S.timelineEnd)}</b></span>${searchHtml()}${actionButton()}`;
		}
		const flags = [];
		if (c.run) {
			flags.push(`<span class="flag" title="${esc(plural(c.run, 'executando', 'executando'))}">${icon('spinner', 'c-bar')}${c.run}</span>`);
		}
		if (c.pause) {
			flags.push(`<span class="flag" title="${esc(plural(c.pause, 'pausada', 'pausadas'))}">${icon('pause', 'c-rose')}${c.pause}</span>`);
		}
		if (c.you) {
			flags.push(`<span class="flag" title="${esc(`${c.you} ${c.you === 1 ? 'precisa' : 'precisam'} de você`)}">${icon('person', 'c-rose')}${c.you}</span>`);
		}
		if (c.bad) {
			flags.push(`<span class="flag" title="${esc(`${c.bad} com problema`)}">${icon('error', 'c-red')}${c.bad}</span>`);
		}
		const sum = `<span class="ts-sum">${meterHtml(c, D.total)}<span class="of"><b>${c.done}</b>&nbsp;de ${D.total}</span>${flags.join('')}</span>`;
		if (D.finished) {
			return `${sum}<button class="ts-btn" data-act="mode" data-mode="history">${icon('history')}<span class="lbl">Histórico</span></button><button class="ts-btn primary" data-act="export">${icon('export')}<span class="lbl">Exportar</span></button>`;
		}
		return `${sum}${searchHtml()}${actionButton()}`;
	}

	function barHtml() {
		const title = S.plan ? (str(S.plan.title, 120) || 'Plano') : 'Novo plano';
		return `${segHtml()}<div class="ts-crumb">${logo(16)}<b title="${esc(title)}">${esc(title)}</b><span class="v">${esc(versionText())}</span></div><span class="ts-sp"></span>${statusHtml()}`;
	}

	// ------------------------------------------------------------------ body

	let root = null;
	function ensureRoot() {
		if (root) {
			return;
		}
		document.body.innerHTML = '<div class="ts" id="ts"><header class="ts-bar" id="ts-bar"></header><div class="ts-body" id="ts-body"></div><div id="ts-menu"></div></div>';
		root = $('#ts');
	}

	function panelKind() {
		const D = S.D;
		if (!D || !D.total || S.mode === 'history' || S.mode === 'compare') {
			return null;
		}
		if (S.edit && task(S.edit.id)) {
			return 'edit';
		}
		if (S.proposal && S.keepProposal && !recalOpen()) {
			return 'proposal';
		}
		const t = S.sel ? task(S.sel) : null;
		if (t) {
			const k = disp(t);
			if (k === 'bad') {
				return 'problem';
			}
			if (k === 'you' || (S.gatePanel === t.id && unmetGates(t).length)) {
				return 'gate';
			}
			if (S.mode === 'list' || S.mode === 'focus') {
				return null;
			}
			return 'insp';
		}
		if (S.proposal && !S.proposalHidden && !recalOpen() && (!proposalTouchesDone() || S.proposalSide) && S.mode !== 'focus') {
			return 'proposal';
		}
		if (D.finished && S.mode === 'map' && !S.finishedHidden) {
			return 'finished';
		}
		return null;
	}

	function panelHtml(kind) {
		const t = S.edit && kind === 'edit' ? task(S.edit.id) : S.sel ? task(S.sel) : null;
		switch (kind) {
			case 'edit': return editHtml(t);
			case 'problem': return problemHtml(t);
			case 'gate': return gateHtml(t);
			case 'insp': return inspectorHtml(t);
			case 'proposal': return proposalHtml();
			case 'finished': return finishedHtml();
		}
		return '';
	}

	/** Notes above the plan: the paused execution while editing, and a plan without a project. */
	function bannersHtml(inFlow) {
		const out = [];
		const e = S.edit;
		if (e && e.stoppedAt && task(e.id)) {
			out.push(`<div class="ts-banner">${icon('pause', 'c-rose')}<span class="txt"><b>Execução de #${esc(e.id)} pausada às ${hhmm(e.stoppedAt)} para você editar.</b> Nada do que já foi feito em #${esc(e.id)} se perde.</span><button class="ts-btn" data-act="resume" data-id="${esc(e.id)}">${icon('resume')}Retomar sem mudar</button></div>`);
		}
		if (S.ctx?.project === false && S.plan) {
			out.push(`<div class="ts-banner">${icon('info', 'c-blue')}<span class="txt"><b>Este TaskStudio não está ligado a um projeto.</b> Dá para montar e revisar o plano aqui; para executar, abra o TaskStudio a partir de um projeto.</span></div>`);
		}
		return out.length ? `<div class="ts-banners${inFlow ? ' static' : ''}">${out.join('')}</div>` : '';
	}

	function notesHtml() {
		if (!S.notes.length) {
			return '<div class="ts-notes" role="status" aria-live="polite"></div>';
		}
		return `<div class="ts-notes" role="status" aria-live="polite">${S.notes.map(n => `<div class="ts-notice">${icon(n.icon, n.c)}<span class="txt">${esc(n.text)}</span><button data-act="note-close" data-key="${esc(n.key)}" aria-label="Fechar aviso" title="Fechar aviso">${icon('close', 's12')}</button></div>`).join('')}</div>`;
	}

	function setNote(key, text, ic = 'info', c = 'c-blue') {
		S.notes = S.notes.filter(n => n.key !== key);
		S.notes.push({ key, text, icon: ic, c });
		if (S.notes.length > 4) {
			S.notes.shift();
		}
	}

	function clearNote(key) {
		S.notes = S.notes.filter(n => n.key !== key);
	}

	function zoomHtml() {
		return `<div class="ts-zoom" role="group" aria-label="Zoom"><button data-act="zoom-out" title="Diminuir (−)" aria-label="Diminuir">${icon('zoomOut', 's12')}</button><span class="pct" id="ts-zoom-pct">100%</span><button data-act="zoom-in" title="Aumentar (+)" aria-label="Aumentar">${icon('zoomIn', 's12')}</button><button data-act="fit" title="Mostrar tudo (0)" aria-label="Mostrar tudo">${icon('fit', 's12')}</button></div>`;
	}

	function minimapHtml(mm) {
		const sw = Math.max(4, mm.w / 110);
		return `<div class="ts-minimap" id="ts-minimap" title="Mapa do plano: clique para ir até lá" aria-hidden="true"><svg viewBox="0 0 ${mm.w} ${mm.h}" preserveAspectRatio="xMidYMid meet">${mm.items}<rect id="ts-mm-view" x="0" y="0" width="0" height="0" fill="none" stroke="#E0782F" stroke-width="${r1(sw)}"/></svg></div>`;
	}

	/** What the body shows: a pannable stage (map, lanes, metro) or a scrolling view. */
	function bodyContent(width) {
		if (!S.plan || !S.D) {
			return S.running ? { scene: buildingScene() } : { html: emptyView(), cls: 'grid' };
		}
		if (!S.D.total) {
			return S.running || S.plan.draft ? { scene: buildingScene() } : { html: '<div class="ts-empty"><h3>O plano ainda não tem tarefas</h3><p>Peça no chat para o agente montar as tarefas.</p></div>', cls: 'plain' };
		}
		switch (S.mode) {
			case 'list': return { html: listView() };
			case 'board': return { html: boardView() };
			case 'timeline': return { html: timelineView(width - 16) };
			case 'focus': return { html: focusView() };
			case 'history': return { html: historyView() };
			case 'compare': return S.proposal ? { html: compareView() } : { scene: mapScene() };
			case 'lanes': return { scene: lanesScene() };
			case 'metro': return { scene: metroScene() };
			default: return { scene: mapScene() };
		}
	}

	function renderBody() {
		const body = $('#ts-body');
		const view = document.getElementById('ts-view');
		const scroll = document.querySelector('.ts-panel .scroll');
		const keep = {
			view: view ? [S.mode, view.scrollTop, view.scrollLeft] : null,
			panel: scroll ? [scroll.closest('.ts-panel').getAttribute('aria-label'), scroll.scrollTop] : null,
		};
		const pk = panelKind();
		const width = (S.width || window.innerWidth) - (pk ? (pk === 'proposal' ? 430 : 340) : 0);
		const c = bodyContent(width);
		S.drawing = c.scene ?? null;
		let main;
		if (c.scene) {
			main = `<div class="ts-canvas${c.scene.plain ? ' plain' : ''}" id="ts-canvas">${c.scene.html}${bannersHtml()}${c.scene.minimap ? minimapHtml(c.scene.minimap) : ''}${S.D?.total ? zoomHtml() : ''}</div>`;
		} else {
			main = `<div class="ts-view${c.cls ? ` ${c.cls}` : ''}" id="ts-view">${S.plan ? bannersHtml(true) : ''}${c.html}</div>`;
		}
		let modal = '';
		if (S.D?.total && (recalOpen() || (S.recal && !recalibrating()))) {
			modal = recalModalHtml();
		} else if (S.proposal && S.D?.total && proposalTouchesDone() && !S.proposalSide && S.mode !== 'history' && S.mode !== 'compare') {
			modal = proposalModalHtml();
		}
		body.innerHTML = `<div class="ts-main">${main}${notesHtml()}</div>${pk ? panelHtml(pk) : ''}${modal}`;
		const v2 = document.getElementById('ts-view');
		if (v2 && keep.view && keep.view[0] === S.mode) {
			v2.scrollTop = keep.view[1];
			v2.scrollLeft = keep.view[2];
		}
		const s2 = document.querySelector('.ts-panel .scroll');
		if (s2 && keep.panel && keep.panel[0] === s2.closest('.ts-panel').getAttribute('aria-label')) {
			s2.scrollTop = keep.panel[1];
		}
		afterBody();
	}

	function afterBody() {
		const d = S.drawing;
		const c = canvasEl();
		if (d && c) {
			S.vpKey = S.mode === 'compare' ? 'map' : S.mode;
			const v = S.vp[S.vpKey];
			const cw = c.clientWidth, ch = c.clientHeight;
			if (!v || v.base !== d.key.split(':')[0] + ':' + (d.key.split(':')[1] ?? '') || (v.auto && (v.w !== d.w || v.h !== d.h || v.cw !== cw || v.ch !== ch))) {
				fit();
			} else {
				applyVp();
			}
			if (S.centerOn) {
				centerOn(S.centerOn);
			}
		} else {
			S.vpKey = null;
		}
		S.centerOn = null;
		for (const ta of document.querySelectorAll('textarea.ts-input')) {
			autosize(ta);
		}
	}

	function autosize(ta) {
		ta.style.height = 'auto';
		ta.style.height = `${Math.min(320, Math.max(64, ta.scrollHeight + 2))}px`;
	}

	function focusKeyOf(el) {
		if (!el || el === document.body || !root?.contains(el)) {
			return null;
		}
		if (el.id) {
			return `#${CSS.escape(el.id)}`;
		}
		const act = el.getAttribute('data-act'), id = el.getAttribute('data-id');
		if (act) {
			let k = `[data-act="${act}"]`;
			if (id !== null) {
				k += `[data-id="${CSS.escape(id)}"]`;
			}
			for (const a of ['mode', 'i', 'n', 'menu', 'field']) {
				if (el.dataset[a] !== undefined) {
					k += `[data-${a}="${CSS.escape(el.dataset[a])}"]`;
				}
			}
			if (el.dataset.phase !== undefined) {
				k += `[data-phase="${CSS.escape(el.dataset.phase)}"]`;
			}
			return k;
		}
		if (id !== null) {
			return `.${el.classList[0]}[data-id="${CSS.escape(id)}"]`;
		}
		return null;
	}

	let rendering = false;
	function render() {
		ensureRoot();
		rendering = true;
		const active = document.activeElement;
		const key = focusKeyOf(active);
		const caret = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') ? [active.selectionStart, active.selectionEnd] : null;
		try {
			renderBody();
			renderBar();
			renderMenu();
			if (key) {
				const el = root.querySelector(key);
				if (el && typeof el.focus === 'function') {
					el.focus({ preventScroll: true });
					if (caret && el.setSelectionRange) {
						el.setSelectionRange(caret[0], caret[1]);
					}
				}
			}
		} finally {
			rendering = false;
		}
	}

	function renderBar() {
		const bar = $('#ts-bar');
		bar.innerHTML = barHtml();
		// Compact step by step (labels of other views, version, flags, all labels, meter) until
		// everything fits and the plan title keeps a readable width.
		const crumb = bar.querySelector('.ts-crumb');
		for (let level = 0; level <= 4; level++) {
			bar.className = `ts-bar${level ? ` ${Array.from({ length: level }, (_, i) => `c${i + 1}`).join(' ')}` : ''}`;
			const squeezed = crumb && crumb.clientWidth < Math.min(crumb.scrollWidth, 150);
			if (bar.scrollWidth <= bar.clientWidth + 1 && !squeezed) {
				break;
			}
		}
	}

	function renderMenu() {
		const box = $('#ts-menu');
		if (S.menu !== 'more') {
			box.innerHTML = '';
			return;
		}
		const anchor = document.querySelector('[data-act="menu"][data-menu="more"]');
		const r = anchor?.getBoundingClientRect();
		const items = ['lanes', 'metro', 'focus', 'history', ...(S.proposal ? ['compare'] : [])];
		const left = r ? Math.round(Math.min(r.left, window.innerWidth - 250)) : 12;
		box.innerHTML = `<div class="ts-menu" id="ts-menu-box" role="menu" aria-label="Mais vistas" style="left:${left}px;top:${r ? Math.round(r.bottom + 4) : 48}px">${items.map(m => `<button class="ts-mi${S.mode === m ? ' on' : ''}" role="menuitem" data-act="mode" data-mode="${m}">${icon(MODES[m].icon)}<span class="t">${esc(MODES[m].label)}<small>${esc(MODES[m].hint)}</small></span></button>`).join('')}</div>`;
	}

	// ------------------------------------------------------------------ viewport (pan and zoom)

	function canvasEl() {
		return document.getElementById('ts-canvas');
	}

	function applyVp() {
		const v = S.vp[S.vpKey];
		const stage = document.getElementById('ts-stage');
		const c = canvasEl();
		if (!v || !stage || !c) {
			return;
		}
		stage.style.transform = `translate(${r1(v.x)}px,${r1(v.y)}px) scale(${v.k.toFixed(4)})`;
		c.style.backgroundPosition = `${r1(v.x % 20)}px ${r1(v.y % 20)}px`;
		const pct = document.getElementById('ts-zoom-pct');
		if (pct) {
			pct.textContent = `${Math.round(v.k * 100)}%`;
		}
		const mm = document.getElementById('ts-mm-view');
		if (mm) {
			mm.setAttribute('x', r1(-v.x / v.k));
			mm.setAttribute('y', r1(-v.y / v.k));
			mm.setAttribute('width', r1(c.clientWidth / v.k));
			mm.setAttribute('height', r1(c.clientHeight / v.k));
		}
	}

	function fit() {
		const c = canvasEl(), d = S.drawing;
		if (!c || !d) {
			return;
		}
		const W = c.clientWidth || 800, H = c.clientHeight || 600;
		const banners = c.querySelector('.ts-banners');
		const top = banners ? banners.offsetHeight + 14 : 0;
		// The minimap sits at the bottom right: keep the plan to its left.
		const right = c.querySelector('.ts-minimap') ? 240 : 0;
		const aw = Math.max(80, W - 40 - right), ah = Math.max(80, H - 30 - top);
		const k = clamp(Math.min(1, aw / d.w, ah / d.h), 0.2, 1);
		const x = 20 + Math.max(0, (aw - d.w * k) / 2);
		const y = top + 15 + Math.max(0, (ah - d.h * k) / 2);
		const parts = d.key.split(':');
		S.vp[S.vpKey] = { k, x, y, auto: true, w: d.w, h: d.h, cw: W, ch: H, base: `${parts[0]}:${parts[1] ?? ''}` };
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
		const k2 = clamp(v.k * f, 0.2, 2.5);
		v.x = cx - (cx - v.x) * (k2 / v.k);
		v.y = cy - (cy - v.y) * (k2 / v.k);
		v.k = k2;
		v.auto = false;
		applyVp();
		persist();
	}

	/** Brings a card into view when most of it is hidden. */
	function centerOn(id) {
		const v = S.vp[S.vpKey];
		const c = canvasEl();
		const r = S.drawing?.rects.get(id);
		if (!v || !c || !r) {
			return;
		}
		const W = c.clientWidth, H = c.clientHeight;
		const sx = v.x + r.x * v.k, sy = v.y + r.y * v.k, sw = r.w * v.k, sh = r.h * v.k;
		const visW = Math.max(0, Math.min(sx + sw, W) - Math.max(sx, 0)), visH = Math.max(0, Math.min(sy + sh, H) - Math.max(sy, 0));
		if ((visW * visH) / Math.max(1, sw * sh) >= 0.9) {
			return;
		}
		v.x = W / 2 - (r.x + r.w / 2) * v.k;
		v.y = H / 2 - (r.y + r.h / 2) * v.k;
		v.auto = false;
		applyVp();
		persist();
	}

	// ------------------------------------------------------------------ actions

	function ask(text, send, requestId) {
		host.postMessage({ type: 'ask', text, send: !!send, ...(requestId ? { requestId } : {}) });
	}

	function setMode(m) {
		if (!MODES[m] || (m === 'compare' && !S.proposal)) {
			return;
		}
		if (m !== S.mode) {
			if (S.mode === 'focus') {
				host.postMessage({ type: 'focus', on: false });
			}
			if (m === 'focus') {
				host.postMessage({ type: 'focus', on: true });
			}
			if (S.mode !== 'focus' && S.mode !== 'compare') {
				S.prevMode = S.mode;
			}
			S.mode = m;
		}
		S.menu = null;
		render();
		persist();
	}

	function selectTask(id, center) {
		if (!task(id) && !S.proposal?.changes.some(c => c.task === id)) {
			return;
		}
		S.sel = S.mode === 'list' && S.sel === id ? null : id;
		S.keepProposal = false;
		S.gatePanel = null;
		const t = task(id);
		if (t && S.closed.has(phaseOf(t))) {
			S.closed.delete(phaseOf(t));
		}
		if (center) {
			S.centerOn = id;
		}
		render();
		persist();
	}

	function openEdit(id) {
		const t = task(id);
		if (!t || recalibrating() || S.proposal) {
			return;
		}
		const k = disp(t);
		let stoppedAt = null;
		if (k === 'run') {
			host.postMessage({ type: 'stop' });
			stoppedAt = Date.now();
		}
		const detail = t.detail || t.summary;
		S.edit = { id, title: t.title, detail, origTitle: t.title, origDetail: detail, stoppedAt };
		S.editFocus = null;
		S.sel = id;
		render();
		persist();
		const ta = document.getElementById('ts-edit-detail');
		if (ta) {
			S.editFocus = 'detail';
			ta.focus({ preventScroll: true });
			ta.setSelectionRange(ta.value.length, ta.value.length);
		}
	}

	/** The words that go in "Agora: «…»": the new text, with the new title first when it changed. */
	function editText(e) {
		const clean = s => s.replace(/\s*\n+\s*/g, ' ').replace(/[«»]/g, '"').trim();
		const title = clean(e.title), detail = clean(e.detail);
		const tc = title !== clean(e.origTitle), dc = detail !== clean(e.origDetail);
		if (tc && dc) {
			return `${title}: ${detail}`;
		}
		return tc ? `${title}: ${detail}` : detail;
	}

	function sendRecal() {
		const e = S.edit;
		const t = e && task(e.id);
		if (!t || !editChanged(e)) {
			return;
		}
		const requestId = [...crypto.getRandomValues(new Uint32Array(4))].join('-');
		S.recal = { task: t.id, text: editText(e), requestId };
		ask(`Mudei a tarefa #${t.id} ${t.title}. Agora: «${editText(e)}». Recalibre o plano.`, true, requestId);
		clearNote('recal');
		S.edit = null;
		S.editFocus = null;
		render();
		persist();
	}

	function failRecal(unconfirmed = false) {
		S.recal = null;
		setNote('recal', unconfirmed ? 'Não foi possível confirmar a recalibração. Confira o pedido no chat antes de continuar.' : 'O agente não recalibrou; peça de novo no chat.', 'info', 'c-blue');
		render();
	}

	function slug(s) {
		return norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'plano';
	}

	function exportPlan() {
		let plan = null, history = null;
		try {
			plan = JSON.parse(S.raw['plan.json'] ?? 'null');
			history = JSON.parse(S.raw['history.json'] ?? 'null');
		} catch {
			// Only valid files are kept in S.raw.
		}
		if (!plan) {
			return;
		}
		host.postMessage({ type: 'save', name: `${slug(plan.title)}-plano-v${planVersion()}.json`, content: JSON.stringify({ plan, history }, null, '\t') });
	}

	function setSearch(q) {
		S.search.q = q;
		S.search.i = -1;
		render();
	}

	function searchStep(delta) {
		const hits = S.D?.tasks.filter(searchHit) ?? [];
		if (!hits.length || !S.search.q.trim()) {
			return;
		}
		S.search.i = (S.search.i + delta + hits.length) % hits.length;
		const id = hits[S.search.i].id;
		S.sel = id;
		S.centerOn = id;
		render();
	}

	function openSearch() {
		S.search.open = true;
		renderBar();
		document.getElementById('ts-search-input')?.focus();
	}

	function closeSearch() {
		S.search = { open: false, q: '', i: -1 };
		render();
	}

	function editShow(field) {
		const box = document.querySelector(`.ts-edit-box[data-field="${field}"]`);
		const input = box?.querySelector('.raw');
		if (!box || !input) {
			return;
		}
		S.editFocus = field;
		box.classList.remove('show-diff');
		if (input.tagName === 'TEXTAREA') {
			autosize(input);
		}
		input.focus({ preventScroll: true });
		input.setSelectionRange(input.value.length, input.value.length);
	}

	function act(el) {
		const a = el.dataset.act;
		const id = el.getAttribute('data-id');
		const t = id ? task(id) : null;
		const name = t ? `#${t.id} ${t.title}` : '';
		switch (a) {
			case 'mode': setMode(el.dataset.mode); break;
			case 'menu':
				S.menu = S.menu === el.dataset.menu ? null : el.dataset.menu;
				renderBar();
				renderMenu();
				document.querySelector('#ts-menu-box .ts-mi')?.focus();
				break;
			case 'search-open': openSearch(); break;
			case 'search-close': closeSearch(); break;
			case 'start': ask('Pode começar.', true); break;
			case 'stop': host.postMessage({ type: 'stop' }); break;
			case 'resume-all': ask('Retome o plano de onde parou.', true); break;
			case 'resume':
				if (t) {
					ask(`Retome a tarefa ${name} sem mudar nada.`, true);
					if (S.edit?.id === t.id) {
						S.edit = null;
						render();
						persist();
					}
				}
				break;
			case 'edit': openEdit(id); break;
			case 'edit-cancel':
				S.edit = null;
				S.editFocus = null;
				render();
				persist();
				break;
			case 'edit-show': editShow(el.dataset.field); break;
			case 'recal': sendRecal(); break;
			case 'retry':
				if (t) {
					ask(`Tente a tarefa #${t.id} de novo.`, true);
				}
				break;
			case 'option': {
				if (!t) {
					break;
				}
				const i = Number(el.dataset.i);
				const list = el.dataset.src === 'problem' ? (t.problem?.options ?? []) : (unmetGates(t)[0]?.alternatives ?? []);
				if (list[i]) {
					ask(`Na tarefa #${t.id}: ${list[i]}.`, true);
				}
				break;
			}
			case 'gate-done': {
				const g = t && unmetGates(t)[0];
				if (g) {
					ask(`Já coloquei ${g.label} no projeto para a tarefa #${t.id}.`, true);
				}
				break;
			}
			case 'gate-approve':
				if (t) {
					ask(`Aprovo: ${t.title} (#${t.id}).`, true);
				}
				break;
			case 'gate-later':
				if (t) {
					ask(`Deixe a tarefa ${name} para depois.`, true);
				}
				break;
			case 'ask-task':
				if (t) {
					ask(`Sobre a tarefa ${name}: `, false);
				}
				break;
			case 'open-file':
				if (el.dataset.path) {
					host.postMessage({ type: 'openFile', path: el.dataset.path });
				}
				break;
			case 'export': exportPlan(); break;
			case 'apply':
				if (S.proposal) {
					ask(`Aplique as mudanças do plano v${S.proposal.plan}.`, true);
				}
				break;
			case 'discard':
				if (S.proposal) {
					ask(`Descarte a proposta do plano v${S.proposal.plan} e mantenha o plano v${S.proposal.base}.`, true);
				}
				break;
			case 'proposal-side':
				S.proposalSide = true;
				S.proposalHidden = false;
				S.sel = null;
				render();
				persist();
				break;
			case 'proposal-show':
				S.proposalHidden = false;
				S.proposalSide = true;
				S.sel = null;
				S.edit = null;
				if (S.mode === 'history' || S.mode === 'focus') {
					S.mode = 'map';
				}
				render();
				persist();
				break;
			case 'proposal-hide':
				S.proposalHidden = true;
				S.keepProposal = false;
				render();
				persist();
				break;
			case 'chg':
				S.sel = id;
				S.keepProposal = true;
				S.centerOn = id;
				render();
				break;
			case 'go':
				if (S.mode === 'history' || S.mode === 'compare') {
					S.mode = 'map';
				}
				selectTask(id, true);
				break;
			case 'gate':
				S.sel = id;
				S.gatePanel = id;
				S.keepProposal = false;
				render();
				persist();
				break;
			case 'row': selectTask(id); break;
			case 'close-panel':
				if (panelKind() === 'finished') {
					S.finishedHidden = true;
				}
				S.sel = null;
				S.gatePanel = null;
				S.keepProposal = false;
				render();
				persist();
				break;
			case 'zoom-in': zoomBy(1.2); break;
			case 'zoom-out': zoomBy(1 / 1.2); break;
			case 'fit': fit(); break;
			case 'phase': {
				const p = el.dataset.phase;
				const open = el.getAttribute('aria-expanded') === 'true';
				if (open) {
					S.opened.delete(p);
					S.closed.add(p);
				} else {
					S.closed.delete(p);
					S.opened.add(p);
				}
				render();
				persist();
				break;
			}
			case 'hist':
				S.histSel = Number(el.dataset.n);
				render();
				persist();
				break;
			case 'example': {
				const e = EXAMPLES[Number(el.dataset.i)];
				if (e) {
					ask(e.text, false);
				}
				break;
			}
			case 'note-close':
				clearNote(el.dataset.key);
				render();
				break;
			case 'recal-hide': {
				const r = recalibrating();
				S.recalHidden = r?.at ?? 'x';
				render();
				break;
			}
		}
	}

	// ------------------------------------------------------------------ events

	let suppressClick = false;

	function onClick(ev) {
		if (suppressClick) {
			suppressClick = false;
			return;
		}
		const t = ev.target;
		const actEl = t.closest?.('[data-act]');
		if (S.menu && !t.closest?.('#ts-menu-box') && !(actEl && actEl.dataset.act === 'menu')) {
			S.menu = null;
			renderBar();
			renderMenu();
			if (!actEl) {
				return;
			}
		}
		if (actEl && !actEl.disabled && root.contains(actEl)) {
			act(actEl);
			return;
		}
		const idEl = t.closest?.('[data-id]');
		if (idEl && t.closest('#ts-body') && !idEl.classList.contains('ghost')) {
			selectTask(idEl.getAttribute('data-id'));
			return;
		}
		if (t.closest?.('#ts-canvas') && !t.closest('.ts-zoom, .ts-banner, .ts-minimap, .ts-notice') && (S.sel || S.gatePanel)) {
			S.sel = null;
			S.gatePanel = null;
			S.keepProposal = false;
			render();
			persist();
		}
	}

	let drag = null;
	let mmDrag = false;

	function minimapTo(ev) {
		const box = document.getElementById('ts-minimap');
		const d = S.drawing;
		const v = S.vp[S.vpKey];
		const c = canvasEl();
		if (!box || !d?.minimap || !v || !c) {
			return;
		}
		const r = box.getBoundingClientRect();
		const s = Math.min(r.width / d.minimap.w, r.height / d.minimap.h);
		const ox = (r.width - d.minimap.w * s) / 2, oy = (r.height - d.minimap.h * s) / 2;
		const px = (ev.clientX - r.left - ox) / s, py = (ev.clientY - r.top - oy) / s;
		v.x = c.clientWidth / 2 - px * v.k;
		v.y = c.clientHeight / 2 - py * v.k;
		v.auto = false;
		applyVp();
	}

	function onPointerDown(ev) {
		const c = canvasEl();
		if (ev.button !== 0 || !c || !c.contains(ev.target) || !S.vpKey) {
			return;
		}
		if (ev.target.closest('#ts-minimap')) {
			mmDrag = true;
			minimapTo(ev);
			return;
		}
		if (ev.target.closest('.ts-card, .ts-gate, .ts-mini, .ts-st, button, input, .ts-zoom, .ts-banner, .ts-notice')) {
			return;
		}
		const v = S.vp[S.vpKey];
		if (v) {
			drag = { x: ev.clientX, y: ev.clientY, vx: v.x, vy: v.y, moved: false, id: ev.pointerId };
		}
	}

	function onPointerMove(ev) {
		if (mmDrag) {
			minimapTo(ev);
			return;
		}
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
		if (mmDrag) {
			mmDrag = false;
			persist();
			return;
		}
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
		if (!c || !c.contains(ev.target) || !S.vpKey || ev.target.closest('.ts-banner, .ts-notice')) {
			return;
		}
		const v = S.vp[S.vpKey];
		if (!v) {
			return;
		}
		ev.preventDefault();
		const unit = ev.deltaMode === 1 ? 16 : 1;
		if (ev.ctrlKey || ev.metaKey) {
			const r = c.getBoundingClientRect();
			zoomBy(Math.exp(-ev.deltaY * unit * 0.0015), ev.clientX - r.left, ev.clientY - r.top);
			return;
		}
		v.x -= (ev.shiftKey && !ev.deltaX ? ev.deltaY : ev.deltaX) * unit;
		v.y -= (ev.shiftKey && !ev.deltaX ? 0 : ev.deltaY) * unit;
		v.auto = false;
		applyVp();
		persist();
	}

	/** Moves the keyboard focus to the nearest card in the arrow's direction. */
	function moveFocus(from, key) {
		const items = [...document.querySelectorAll('#ts-stage [data-id][tabindex]')];
		const a = from.getBoundingClientRect();
		const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
		const dir = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] }[key];
		let best = null, bestScore = Infinity;
		for (const el of items) {
			if (el === from) {
				continue;
			}
			const b = el.getBoundingClientRect();
			const dx = b.left + b.width / 2 - ax, dy = b.top + b.height / 2 - ay;
			const along = dx * dir[0] + dy * dir[1];
			if (along <= 4) {
				continue;
			}
			const across = Math.abs(dx * dir[1] + dy * dir[0]);
			const score = along + across * 2;
			if (score < bestScore) {
				bestScore = score;
				best = el;
			}
		}
		if (best) {
			best.focus({ preventScroll: true });
			const id = best.getAttribute('data-id');
			if (id) {
				centerOn(id);
			}
		}
	}

	function onKey(ev) {
		const t = ev.target;
		const inInput = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
		if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'f' && S.D?.total) {
			ev.preventDefault();
			openSearch();
			return;
		}
		if (S.menu) {
			if (ev.key === 'Escape') {
				ev.preventDefault();
				S.menu = null;
				renderBar();
				renderMenu();
				document.querySelector('[data-act="menu"]')?.focus();
				return;
			}
			if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
				ev.preventDefault();
				const items = [...document.querySelectorAll('#ts-menu-box .ts-mi')];
				const i = items.indexOf(document.activeElement);
				items[(i + (ev.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
				return;
			}
		}
		if (inInput) {
			if (t.id === 'ts-search-input') {
				if (ev.key === 'Enter') {
					ev.preventDefault();
					searchStep(ev.shiftKey ? -1 : 1);
				} else if (ev.key === 'Escape') {
					ev.preventDefault();
					closeSearch();
				}
			} else if (t.dataset.field) {
				if (ev.key === 'Escape') {
					ev.preventDefault();
					t.blur();
				} else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
					ev.preventDefault();
					sendRecal();
				} else if (ev.key === 'Enter' && t.tagName === 'INPUT') {
					ev.preventDefault();
				}
			}
			return;
		}
		if (ev.key === 'Escape') {
			ev.preventDefault();
			if (S.recal && !recalibrating()) {
				S.recal = null;
				render();
			} else if (S.proposal && proposalTouchesDone() && !S.proposalSide && S.mode !== 'history' && S.mode !== 'compare') {
				S.proposalSide = true;
				render();
			} else if (S.edit) {
				if (!editChanged(S.edit)) {
					S.edit = null;
					render();
					persist();
				}
			} else if (S.sel || S.gatePanel || S.keepProposal) {
				S.sel = null;
				S.gatePanel = null;
				S.keepProposal = false;
				render();
				persist();
			} else if (S.search.open) {
				closeSearch();
			} else if (S.mode === 'focus' || S.mode === 'compare') {
				setMode(S.prevMode && S.prevMode !== S.mode ? S.prevMode : 'map');
			}
			return;
		}
		if ((ev.key === 'Enter' || ev.key === ' ') && t && t.getAttribute?.('role') === 'button' && t.tagName !== 'BUTTON') {
			ev.preventDefault();
			t.click();
			return;
		}
		if (ev.key.startsWith('Arrow') && t?.hasAttribute?.('data-id') && t.closest?.('#ts-stage')) {
			ev.preventDefault();
			moveFocus(t, ev.key);
			return;
		}
		if ((ev.key === 'ArrowDown' || ev.key === 'ArrowUp') && t?.classList?.contains('ts-lr')) {
			ev.preventDefault();
			const rows = [...document.querySelectorAll('.ts-lr')];
			rows[rows.indexOf(t) + (ev.key === 'ArrowDown' ? 1 : -1)]?.focus();
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
		const t = ev.target;
		if (t.id === 'ts-search-input') {
			setSearch(t.value);
			return;
		}
		if (t.dataset?.field && S.edit) {
			S.edit[t.dataset.field] = t.value;
			if (t.tagName === 'TEXTAREA') {
				autosize(t);
			}
			const changed = editChanged(S.edit);
			for (const b of document.querySelectorAll('[data-act="recal"]')) {
				b.disabled = !changed;
				b.title = changed ? '' : 'Mude o texto para recalibrar.';
			}
			persist();
		}
	}

	function onFocusIn(ev) {
		const t = ev.target;
		if (t.classList?.contains('ts-diffview')) {
			editShow(t.dataset.field);
		} else if (t.dataset?.field && t.classList.contains('raw')) {
			S.editFocus = t.dataset.field;
		}
	}

	function onFocusOut(ev) {
		const t = ev.target;
		if (rendering || !t.dataset?.field || !t.classList.contains('raw') || !S.edit) {
			return;
		}
		S.editFocus = null;
		const field = t.dataset.field;
		const box = t.closest('.ts-edit-box');
		const orig = field === 'title' ? S.edit.origTitle : S.edit.origDetail;
		if (box && S.edit[field].trim() !== orig.trim()) {
			box.querySelector('.ts-diffview').innerHTML = diffHtml(orig, S.edit[field]);
			box.classList.add('show-diff');
		}
	}

	// ------------------------------------------------------------------ host messages

	function applyView(v) {
		S.lastViewRev = v.revision;
		if (typeof v.mode === 'string' && MODES[v.mode] && !(v.mode === 'compare' && !S.proposal)) {
			if (v.mode !== S.mode) {
				if (S.mode === 'focus') {
					host.postMessage({ type: 'focus', on: false });
				}
				if (v.mode === 'focus') {
					host.postMessage({ type: 'focus', on: true });
				}
				S.mode = v.mode;
			}
		}
		const id = nid(v.select);
		if (id && task(id)) {
			S.sel = id;
			S.centerOn = id;
			S.keepProposal = false;
			const t = task(id);
			S.closed.delete(phaseOf(t));
		}
		const note = str(v.note, 300);
		if (note) {
			setNote('view', note, 'info', 'c-blue');
			// The agent's note is a hint for the moment: it fades out on its own.
			const rev = v.revision;
			setTimeout(() => {
				if (S.lastViewRev === rev && S.notes.some(n => n.key === 'view')) {
					clearNote('view');
					render();
				}
			}, 15000);
		}
	}

	const FILES = ['plan.json', 'proposal.json', 'history.json', 'view.json'];
	let lastSnapshot;

	function applyFiles(files) {
		let changed = S.notes.some(note => note.key === 'snapshot');
		if (typeof files['state.json'] === 'string') {
			if (files['state.json'] === lastSnapshot) { return; }
			try {
				const state = JSON.parse(files['state.json']);
				if (state.schema !== 1 || !state.documents || typeof state.documents !== 'object' || Array.isArray(state.documents)) { throw new Error(); }
				for (const [name, value] of Object.entries(state.documents)) {
					if (!FILES.includes(name) || !value || typeof value !== 'object' || value.schema !== 1
						|| (name === 'plan.json' && !Array.isArray(value.tasks))) { throw new Error(); }
				}
				lastSnapshot = files['state.json'];
				files = Object.fromEntries(Object.entries(state.documents).map(([name, value]) => [name, JSON.stringify(value)]));
				clearNote('snapshot');
			} catch {
				lastSnapshot = undefined;
				setNote('snapshot', 'Não foi possível atualizar o plano. A última versão foi mantida.', 'warning', 'c-rose');
				render();
				return;
			}
		} else {
			lastSnapshot = undefined;
		}
		let planChanged = false;
		let proposalArrived = false;
		for (const name of FILES) {
			const text = typeof files?.[name] === 'string' ? files[name] : null;
			if (text === (S.raw[name] ?? null) && name in S.raw) {
				continue;
			}
			let val = null;
			if (text !== null) {
				try {
					val = JSON.parse(text);
				} catch {
					val = undefined;
				}
				const ok = val && typeof val === 'object' && (name !== 'plan.json' || Array.isArray(val.tasks));
				if (!ok) {
					// A half-written or invalid file: keep the last good one and say so quietly.
					if (!S.bad.has(name)) {
						S.bad.add(name);
						setNote(`bad:${name}`, `Não consegui ler ${name}; mostrando a última versão válida.`, 'warning', 'c-rose');
						changed = true;
					}
					continue;
				}
			}
			if (S.bad.delete(name)) {
				clearNote(`bad:${name}`);
			}
			S.raw[name] = text;
			changed = true;
			if (name === 'plan.json') {
				S.plan = val;
				S.D = val ? buildIndex(val) : null;
				planChanged = true;
			} else if (name === 'proposal.json') {
				const had = !!S.proposal;
				S.proposal = normProposal(val);
				proposalArrived = !!S.proposal && !had;
			} else if (name === 'history.json') {
				S.history = normHistory(val);
			} else {
				S.view = val;
			}
		}
		if (!changed) {
			return;
		}
		reconcile(planChanged, proposalArrived);
		render();
		persist();
	}

	function reconcile(planChanged, proposalArrived) {
		refreshDisp();
		if (S.sel && !task(S.sel) && !S.proposal?.changes.some(c => c.task === S.sel)) {
			S.sel = null;
		}
		if (S.edit && (!task(S.edit.id) || recalibrating())) {
			S.edit = null;
		}
		if (S.recal && (recalibrating() || S.proposal)) {
			S.recal = null;
		}
		if (proposalArrived) {
			S.sel = null;
			S.keepProposal = false;
			S.proposalHidden = false;
			S.proposalSide = false;
			clearNote('recal');
		}
		if (!S.proposal) {
			S.proposalSide = false;
			S.proposalHidden = false;
			S.keepProposal = false;
			if (S.mode === 'compare') {
				S.mode = 'map';
			}
		}
		if (planChanged && S.D && !S.D.finished) {
			S.finishedHidden = false;
		}
		if (S.view && S.view.revision !== undefined && S.view.revision !== S.lastViewRev && S.D) {
			applyView(S.view);
		}
	}

	function onRunning(running) {
		S.running = running;
		refreshDisp();
		render();
	}

	window.addEventListener('message', ev => {
		const m = ev.data;
		if (!m || typeof m !== 'object') {
			return;
		}
		switch (m.type) {
			case 'request':
				if (S.recal?.requestId === m.requestId && ['settled', 'rejected', 'unconfirmed'].includes(m.state)) {
					failRecal(m.state === 'unconfirmed');
				}
				break;
			case 'init':
			case 'context':
				S.ctx = m.context && typeof m.context === 'object' ? m.context : null;
				render();
				break;
			case 'files':
				if (S.filesError) {
					S.filesError = null;
					clearNote('files');
				}
				applyFiles(m.files && typeof m.files === 'object' ? m.files : {});
				break;
			case 'filesError':
				S.filesError = typeof m.message === 'string' ? m.message : 'Não foi possível atualizar o plano.';
				setNote('files', S.filesError, 'warning', 'c-rose');
				render();
				break;
			case 'running':
				S.requests = new Set(Array.isArray(m.requests) ? m.requests.filter(id => typeof id === 'string') : []);
				onRunning(!!m.running);
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
		if (changed || S.mode === 'timeline') {
			render();
		} else if (S.vp[S.vpKey]?.auto) {
			fit();
		}
	}

	ensureRoot();
	document.addEventListener('click', onClick);
	document.addEventListener('keydown', onKey);
	document.addEventListener('input', onInput);
	document.addEventListener('focusin', onFocusIn);
	document.addEventListener('focusout', onFocusOut);
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
		const a = document.activeElement;
		const typing = a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA');
		if (S.D?.total && (S.running || S.mode === 'timeline') && !typing && !drag && !S.menu) {
			render();
		}
	}, 30000);
	render();
	host.postMessage({ type: 'ready' });
	if (S.mode === 'focus') {
		host.postMessage({ type: 'focus', on: true });
	}
})();
