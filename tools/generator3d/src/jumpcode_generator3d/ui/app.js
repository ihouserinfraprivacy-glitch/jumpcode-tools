/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// 3D Generator Studio interface: plain JavaScript and three.js (globalThis.G3D_THREE, inlined before this file), no
// network. It reads the Studio files the tool writes (state.json, image.json, model.json; see CONTRACT.md) and shows the
// project's images, the checked image with its 17 body points, the generated model in a 3D viewer, its skeleton and
// what each bone moves, the animations inside the GLB, the project's models and the settings. It never writes files
// and never calls the tool: every action becomes a chat message (`ask`) the agent carries out. Text is pt-BR.
(function () {
	'use strict';

	/** @type {{ postMessage(m: object): void, getState(): any, setState(s: any): void }} */
	const host = typeof acquireVsCodeApi === 'function'
		? acquireVsCodeApi()
		: { postMessage() { }, getState() { return undefined; }, setState() { } };
	const G = globalThis.G3D_THREE && globalThis.G3D_THREE.THREE ? globalThis.G3D_THREE : null;

	// ------------------------------------------------------------------ constants

	const VIEWS = {
		image: { label: 'Imagem', icon: 'image' },
		model: { label: 'Modelo 3D', icon: 'cube' },
		skeleton: { label: 'Esqueleto', icon: 'person' },
		animations: { label: 'Animações', icon: 'film' },
		models: { label: 'Modelos', icon: 'grid' },
		settings: { label: 'Configurações', icon: 'gear' },
	};
	const ALL_VIEWS = ['start', ...Object.keys(VIEWS)];
	const MODEL_VIEWS = ['model', 'skeleton', 'animations'];

	const STEP_LABELS = {
		background: 'Remover o fundo', encode: 'Forma 3D (TripoSR)', mesh: 'Montar a malha', simplify: 'Simplificar', pose: 'Achar as juntas',
		rig: 'Ossos e pesos', clips: 'Copiar animações', texture: 'Textura', write: 'Gravar o GLB',
	};
	const STEP_ORDER = Object.keys(STEP_LABELS);
	/** The engine's timing names folded into the Studio's steps (the same folding the tool does for the job). */
	const TIMING_STEPS = {
		background: 'background', encode: 'encode', release_encoder: 'encode', release: 'encode', mesh: 'mesh', simplify: 'simplify', pose: 'pose',
		rig: 'rig', load_clips: 'clips', clips: 'clips', texture: 'texture', write: 'write',
	};
	/** Typical seconds of each step on a graphics card (jay, texture 1024): only the shape of the progress bar. */
	const STEP_WEIGHT = { background: 0.4, encode: 2.9, mesh: 1.5, simplify: 1.5, pose: 0.4, rig: 1.0, clips: 0.1, texture: 7.2, write: 0.1 };

	const ANIMATION_LABELS = {
		walk: 'andar', 'walk-female': 'andar 2', jog: 'trotar', 'run-anime': 'correr', 'run-female': 'correr 2', sprint: 'disparar',
		'idle-a': 'parado', 'idle-subtle': 'parado, leve', greeting: 'acenar', 'dance-simple': 'dançar', 'dance-charleston': 'charleston',
		'jump-2': 'pular', victory: 'comemorar', clapping: 'bater palmas', yes: 'dizer sim', reject: 'dizer não', 'punch-jab': 'soco',
		'kick-front': 'chute', 'fighting-idle': 'em guarda', 'crouch-idle': 'agachado', 'sitting-idle': 'sentado', 'pick-up': 'pegar do chão',
		'death-a': 'cair', 'rest-pose': 'pose de descanso',
	};
	const DEFAULT_ANIMATIONS = ['walk', 'greeting', 'dance-simple', 'jump-2'];

	/** The 17 COCO body points in groups, as the table shows them, and the lines drawn between them. */
	const KP_GROUPS = [
		['nose', 'nariz', ['nose']], ['eyes', 'olhos', ['left_eye', 'right_eye']], ['ears', 'orelhas', ['left_ear', 'right_ear']],
		['shoulders', 'ombros', ['left_shoulder', 'right_shoulder']], ['elbows', 'cotovelos', ['left_elbow', 'right_elbow']],
		['wrists', 'pulsos', ['left_wrist', 'right_wrist']], ['hips', 'quadris', ['left_hip', 'right_hip']],
		['knees', 'joelhos', ['left_knee', 'right_knee']], ['ankles', 'tornozelos', ['left_ankle', 'right_ankle']],
	];
	const KP_LINES = [['left_shoulder', 'right_shoulder'], ['left_shoulder', 'left_elbow'], ['left_elbow', 'left_wrist'], ['right_shoulder', 'right_elbow'],
		['right_elbow', 'right_wrist'], ['left_shoulder', 'left_hip'], ['right_shoulder', 'right_hip'], ['left_hip', 'right_hip'], ['left_hip', 'left_knee'],
		['left_knee', 'left_ankle'], ['right_hip', 'right_knee'], ['right_knee', 'right_ankle']];

	const DEVICES = [['auto', 'automático'], ['dml', 'placa de vídeo'], ['cpu', 'processador']];
	const DEVICE_LABELS = { auto: 'automático', dml: 'placa de vídeo', gpu: 'placa de vídeo', cuda: 'placa de vídeo (CUDA)', cpu: 'processador' };
	const PROVIDER_LABELS = { dml: 'placa de vídeo (DirectML)', cuda: 'placa de vídeo (CUDA)', cpu: 'processador' };
	const TEXTURES = [[0, 'cores nos vértices'], [512, 'textura 512'], [1024, 'textura 1024'], [2048, 'textura 2048']];
	const FACES = [5000, 10000, 20000, 40000, 80000];
	const HEIGHTS = [1.2, 1.5, 1.6, 1.7, 1.8, 1.9, 2.0];
	const CAMERAS = { front: 'Frente', side: 'Lado', back: 'Costas', top: 'Cima' };
	/** Skin weight shown in five solid steps on the model: nothing, up to 25 %, 50 %, 75 %, more. */
	const WEIGHT_STEPS = ['#8A8A8E', '#3D5878', '#3A6EA6', '#4A8CD0', '#7DBDFF'];
	const FINGER = /^(thumb|index|middle|ring|pinky)_/;
	const CREDITS = [['TripoSR', 'forma 3D a partir da imagem', 'MIT'], ['u2netp', 'tirar o fundo', 'Apache-2.0'], ['RTMPose-m', 'achar as juntas', 'Apache-2.0'], ['Mesh2Motion', 'esqueleto e animações', 'CC0']];

	const ICONS = {
		image: '<rect x="2" y="2.6" width="12" height="10.8"/><circle cx="5.6" cy="6" r="1.2"/><path d="m2.4 12.6 3.8-3.8 2.6 2.4 1.8-1.6 3 3"/>',
		cube: '<path d="M8 1.8 13.6 5v6.2L8 14.2 2.4 11.2V5z"/><path d="M2.4 5 8 8.2 13.6 5M8 8.2v6"/>',
		person: '<circle cx="8" cy="2.9" r="1.4"/><path d="M8 4.8v4.8M3.8 6.4h8.4M8 9.6l-2.6 4.6M8 9.6l2.6 4.6"/>',
		film: '<rect x="2" y="2.4" width="12" height="11.2"/><path d="M5 2.4v11.2M11 2.4v11.2M2 5.6h3M2 8h3M2 10.4h3M11 5.6h3M11 8h3M11 10.4h3"/>',
		grid: '<rect x="2" y="2" width="5" height="5"/><rect x="9" y="2" width="5" height="5"/><rect x="2" y="9" width="5" height="5"/><rect x="9" y="9" width="5" height="5"/>',
		gear: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.6v2M8 12.4v2M1.6 8h2M12.4 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M3.5 12.5l1.4-1.4M11.1 4.9l1.4-1.4"/>',
		folder: '<path d="M1.8 3.6h4.1l1.5 1.6h6.8v7.5H1.8z"/>',
		file: '<path d="M3.2 1.8h6l3.6 3.6v8.8H3.2z"/><path d="M9.2 1.8v3.6h3.6"/>',
		check: '<path d="m3 8.4 3.1 3.1L13 4.6"/>',
		passed: '<circle cx="8" cy="8" r="6.4" fill="currentColor" stroke="none"/><path d="m5.1 8.2 2 2 3.9-4.1" stroke="#FFFFFF" stroke-width="1.6"/>',
		alert: '<circle cx="8" cy="8" r="6.4" fill="currentColor" stroke="none"/><path d="M8 4.6v4.2M8 11.2h.01" stroke="#FFFFFF" stroke-width="1.8"/>',
		failed: '<circle cx="8" cy="8" r="6.4" fill="currentColor" stroke="none"/><path d="m5.7 5.7 4.6 4.6M10.3 5.7l-4.6 4.6" stroke="#FFFFFF" stroke-width="1.6"/>',
		warning: '<path d="M8 2 14.4 13.6H1.6z"/><path d="M8 6.4v3.4M8 11.8h.01"/>',
		info: '<circle cx="8" cy="8" r="6"/><path d="M8 7.2v4M8 4.8h.01"/>',
		dot: '<circle cx="8" cy="8" r="3.4" fill="currentColor" stroke="none"/>',
		ring: '<circle cx="8" cy="8" r="5.6"/>',
		dash: '<path d="M4.6 8h6.8"/>',
		spinner: '<path d="M13.6 8A5.6 5.6 0 0 1 2.4 8"/>',
		comments: '<path d="M1.8 2.4h9v6.2H5.6L3.2 10.6V8.6H1.8z"/><path d="M12.6 5.6h1.6v6h-1.4v2l-2.4-2H6.8"/>',
		desktop: '<rect x="1.8" y="2.4" width="12.4" height="8.4"/><path d="M5.4 13.6h5.2M8 10.8v2.8"/>',
		chip: '<rect x="4" y="4" width="8" height="8"/><path d="M6 1.8V4M10 1.8V4M6 12v2.2M10 12v2.2M1.8 6H4M1.8 10H4M12 6h2.2M12 10h2.2"/>',
		lock: '<rect x="3.2" y="7" width="9.6" height="7"/><path d="M5.4 7V5.2a2.6 2.6 0 0 1 5.2 0V7"/>',
		list: '<path d="M5.4 4h8.6M5.4 8h8.6M5.4 12h8.6M2.2 4h.01M2.2 8h.01M2.2 12h.01"/>',
		eye: '<path d="M1.6 8s2.4-4.4 6.4-4.4S14.4 8 14.4 8 12 12.4 8 12.4 1.6 8 1.6 8z"/><circle cx="8" cy="8" r="2"/>',
		refresh: '<path d="M13.2 6.6A5.4 5.4 0 0 0 3.4 5M2.8 9.4A5.4 5.4 0 0 0 12.6 11M3.4 2.2V5h2.8M12.6 13.8V11H9.8"/>',
		play: '<path d="M4.6 2.8v10.4L13 8z" fill="currentColor"/>',
		pause: '<path d="M5.2 3v10M10.8 3v10" stroke-width="2"/>',
		loop: '<path d="M2.6 7.2V6.4a2.4 2.4 0 0 1 2.4-2.4h8"/><path d="m10.8 1.8 2.2 2.2-2.2 2.2M13.4 8.8v.8a2.4 2.4 0 0 1-2.4 2.4H3"/><path d="M5.2 14.2 3 12l2.2-2.2"/>',
		stop: '<rect x="3.4" y="3.4" width="9.2" height="9.2"/>',
		frame: '<circle cx="8" cy="8" r="2"/><path d="M2 5.4V2h3.4M10.6 2H14v3.4M14 10.6V14h-3.4M5.4 14H2v-3.4"/>',
		floor: '<path d="M1.4 12.6h13.2M3 9.8h10M4.4 7.2h7.2M4.4 7.2 2.4 12.6M8 7.2v5.4M11.6 7.2l2 5.4M5.2 4.8 8 2.6l2.8 2.2"/>',
		wire: '<path d="M8 1.8 14 13.6H2z"/><path d="M5 7.7h6M8 13.6 5 7.7M8 13.6l3-5.9"/>',
		spin: '<path d="M13.2 8.4a5.2 5.2 0 1 1-1.6-4"/><path d="M12 1.6v2.9H9.1"/>',
		ruler: '<path d="M1.8 11.2 11.2 1.8l3 3-9.4 9.4z"/><path d="m4.6 8.4 1.4 1.4M6.8 6.2l1.4 1.4M9 4l1.4 1.4"/>',
		brush: '<path d="M14 2 7.6 8.4"/><path d="M7.6 8.4c-1.7-.4-3.1.6-3.3 2.3-.2 1.4-.8 2-2.1 2.5 2.3 1 5.7.6 6.1-1.9.2-1.1-.1-2.3-.7-2.9z"/>',
		layers: '<path d="M8 2 14 5.2 8 8.4 2 5.2z"/><path d="m2 8.2 6 3.2 6-3.2M2 11l6 3.2 6-3.2"/>',
		target: '<circle cx="8" cy="8" r="4.6"/><circle cx="8" cy="8" r="1.4"/><path d="M8 1.4v2M8 12.6v2M1.4 8h2M12.6 8h2"/>',
		history: '<path d="M3 4.6A5.8 5.8 0 1 1 2.2 8"/><path d="M2.6 1.9v2.9h2.9M8 4.8V8l2.2 1.5"/>',
		clock: '<circle cx="8" cy="8" r="6"/><path d="M8 4.4V8l2.4 1.6"/>',
		chevR: '<path d="m6 3.5 4.5 4.5L6 12.5"/>',
		chevD: '<path d="M3.5 6 8 10.5 12.5 6"/>',
		close: '<path d="m4 4 8 8M12 4l-8 8"/>',
		edit: '<path d="m10.6 2.4 3 3-8 8H2.6v-3z"/>',
		box: '<rect x="2.4" y="2.4" width="11.2" height="11.2"/>',
	};

	// ------------------------------------------------------------------ helpers

	const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' };
	const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ESC[c]);
	const ic = (name, cls = '') => `<svg class="g3-ic ${cls}" viewBox="0 0 16 16" aria-hidden="true">${ICONS[name] || ''}</svg>`;
	const MARK = '<svg class="g3-mark" viewBox="0 0 100 100" aria-hidden="true"><rect width="100" height="100" rx="24" fill="#1F86B3"/><path d="M50 19 L77 34.5 L50 50 L23 34.5 Z" fill="#fff"/><path d="M23 34.5 L50 50 L50 81 L23 65.5 Z" fill="#fff" opacity=".8"/><path d="M77 34.5 L50 50 L50 81 L77 65.5 Z" fill="#fff" opacity=".58"/></svg>';
	const parse = text => { try { return JSON.parse(text); } catch { return undefined; } };
	const obj = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
	const arr = value => Array.isArray(value) ? value : [];
	const num = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
	const pad = n => String(n).padStart(2, '0');
	const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
	const dataImage = value => typeof value === 'string' && /^data:image\/(png|jpe?g|webp|gif);base64,/i.test(value) ? value : null;

	/** A number in the Brazilian way: 1.234,56 (and a true minus sign). */
	function nf(value, decimals = 0) {
		const v = Number(value);
		if (value === null || value === undefined || !Number.isFinite(v)) { return '—'; }
		const text = Math.abs(v).toFixed(decimals);
		const [whole, fraction] = text.split('.');
		return (v < 0 && Number(text) !== 0 ? '−' : '') + whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + (fraction ? `,${fraction}` : '');
	}
	const plural = (n, one, many) => `${nf(n)} ${n === 1 ? one : many}`;
	/** Seconds: 0,4 s, 15,1 s, 1 min 05 s. */
	const secs = s => num(s) === null ? '—' : s > 0 && s < 0.05 ? '< 0,1 s' : s < 60 ? `${nf(s, 1)} s` : `${Math.floor(s / 60)} min ${pad(Math.round(s % 60))} s`;
	/** Bytes in decimal units, as Windows Explorer's neighbours write them: 139 KB, 1,69 MB. */
	const bytes = n => num(n) === null ? '—' : n < 1000 ? `${nf(n)} bytes` : n < 1e6 ? `${nf(n / 1e3)} KB` : `${nf(n / 1e6, n < 1e7 ? 2 : 1)} MB`;
	const metres = m => num(m) === null ? '—' : `${nf(m, 2)} m`;
	const basename = path => String(path || '').split('/').pop();
	const dirname = path => { const parts = String(path || '').split('/'); parts.pop(); return parts.join('/'); };
	const stem = path => basename(path).replace(/\.[^.]+$/, '');
	const cap = text => String(text || '').charAt(0).toUpperCase() + String(text || '').slice(1);
	const joinPt = list => list.length <= 1 ? (list[0] || '') : `${list.slice(0, -1).join(', ')} e ${list[list.length - 1]}`;
	const ins = html => `<ins class="g3-ins">${html}</ins>`;
	const del = html => `<del class="g3-del">${html}</del>`;
	const dim = html => `<span class="g3-dim">${html}</span>`;
	const mono = text => `<span class="g3-m">${esc(text)}</span>`;
	const badge = (text, cls = '') => `<span class="g3-badge ${cls}">${esc(text)}</span>`;
	const median = list => { const v = list.filter(x => num(x) !== null).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
	/** "hoje 17:19" or "14/11/2026 17:19", from the ISO local time the tool writes. */
	function when(iso) {
		const m = /^(?<y>\d{4})-(?<mo>\d{2})-(?<d>\d{2})T(?<h>\d{2}):(?<mi>\d{2})/.exec(String(iso || ''));
		if (!m) { return '—'; }
		const g = m.groups;
		const now = new Date();
		const today = now.getFullYear() === Number(g.y) && now.getMonth() + 1 === Number(g.mo) && now.getDate() === Number(g.d);
		return today ? `hoje ${g.h}:${g.mi}` : `${g.d}/${g.mo}/${g.y} ${g.h}:${g.mi}`;
	}
	/** Pixel sizes are written without the thousands dot, as image editors show them: 1024 × 1024. */
	const px = n => String(Math.round(Number(n) || 0));
	const texText = t => num(t) ? `${px(t)} × ${px(t)}` : 'cores nos vértices';

	function btn(label, icon, cls = '', attrs = '') {
		return `<button class="g3-btn ${cls}" ${attrs}>${icon ? ic(...[].concat(icon)) : ''}${label ? `<span class="t">${label}</span>` : ''}</button>`;
	}
	function panel(title, body, o = {}) {
		return `<div class="g3-panel ${o.mk ? `mk mk-${o.mk}` : ''} ${o.cls || ''}" ${o.style ? `style="${o.style}"` : ''}><div class="g3-ph">${o.icon ? ic(...[].concat(o.icon)) : ''}<span class="t">${title}</span>${o.sub ? `<em>${o.sub}</em>` : ''}${o.right ? `<span class="r">${o.right}</span>` : ''}</div>${o.before || ''}<div class="g3-pb ${o.pb || ''}" ${o.scroll ? `data-scroll="${o.scroll}"` : ''}>${body}</div>${o.foot ? `<div class="g3-pfoot">${o.foot}</div>` : ''}</div>`;
	}
	function head(icon, title, sub, right = '', mk = '') {
		return `<div class="g3-head ${mk ? `mk mk-${mk}` : ''}">${icon ? ic(...[].concat(icon)) : ''}<b>${title}</b><span class="sub">${sub}</span>${right ? `<span class="r">${right}</span>` : ''}</div>`;
	}
	/** Key and value rows; a pair may carry a third item, the full value shown on hover when the cell cuts it. */
	const kv = (pairs, cls = '') => {
		const rows = pairs.filter(Boolean);
		// In two columns the last row is the last pair, or the last two pairs.
		const lastFrom = cls.includes('two') ? rows.length - (rows.length % 2 || 2) : rows.length - 1;
		return `<div class="g3-kv ${cls}">${rows.map(([k, v, title], i) => `<span class="${i >= lastFrom ? 'last' : ''}">${k}</span><span class="${i >= lastFrom ? 'last' : ''}" ${title ? `title="${esc(title)}"` : ''}>${v}</span>`).join('')}</div>`;
	};
	const li = (icon, html, right = '', cls = '', attrs = '') => `<div class="g3-li ${cls}" ${attrs}>${icon}<span class="tx">${html}</span>${right ? `<em>${right}</em>` : ''}</div>`;
	const note = (icon, cls, html) => `<div class="g3-note">${ic(icon, cls)}<div>${html}</div></div>`;
	/** A table: cols are [label, width (0 = rest), class]; a row is cells or { c: cells, cls, attrs }. */
	function table(cols, rows, o = {}) {
		const headRow = `<colgroup>${cols.map(([, w]) => `<col ${w ? `style="width:${w}px"` : ''}>`).join('')}</colgroup><thead><tr>${cols.map(([label, , cls]) => `<th class="${cls || ''}">${label}</th>`).join('')}</tr></thead>`;
		const body = rows.map(r => {
			const opt = Array.isArray(r) ? {} : r;
			const cells = Array.isArray(r) ? r : r.c;
			return `<tr class="${opt.cls || ''}" ${opt.attrs || ''}>${cells.map((v, i) => `<td class="${cols[i][2] || ''}">${v}</td>`).join('')}</tr>`;
		}).join('');
		return `<table class="g3-tbl ${o.cls || ''}">${headRow}<tbody>${body}</tbody></table>`;
	}

	// ------------------------------------------------------------------ state

	const saved = host.getState() || {};
	const S = {
		ctx: null,
		st: null,
		img: null,
		mdl: null,
		mdlRaw: undefined,
		view: ALL_VIEWS.includes(saved.view) ? saved.view : 'start',
		sig: null,
		imageSel: null,
		kpSel: null,
		points: saved.points !== false,
		camera: 'front',
		tools: { grid: true, bones: false, wire: false, spin: false, ...(obj(saved.tools) || {}) },
		skelMode: saved.skelMode === 'weights' ? 'weights' : 'bones',
		bone: typeof saved.bone === 'string' ? saved.bone : 'upperarm_l',
		fingers: false,
		anim: typeof saved.anim === 'string' ? saved.anim : null,
		playing: true,
		loop: true,
		speed: 1,
		animDraft: null,
		modelSel: null,
		gallery: saved.gallery === 'list' ? 'list' : 'grid',
		setDraft: {},
		animSetDraft: null,
		running: false,
		pending: null,
		note: null,
		noteKind: 'info',
		noticeSeen: null,
	};

	function remember() {
		host.setState({ view: S.view, sig: S.sig, points: S.points, tools: S.tools, skelMode: S.skelMode, bone: S.bone, anim: S.anim, gallery: S.gallery });
	}

	const narrow = () => window.innerWidth < 1200;
	const tight = () => window.innerWidth < 1000;

	function ask(text, send = true) {
		const requestId = send ? `g3-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}` : undefined;
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

	const st = () => S.st || {};
	const engine = () => obj(st().engine) || {};
	/** Before the tool first writes state.json nothing is known about the engine; the buttons still ask the agent. */
	const engineKnown = () => !!obj(st().engine);
	const engineReady = () => !engineKnown() || engine().ready === true;
	const settings = () => obj(st().settings) || {};
	const job = () => obj(st().job);
	const jobRunning = () => job()?.state === 'running';
	const images = () => arr(st().images).filter(i => obj(i) && typeof i.path === 'string');
	const models = () => arr(st().models).filter(m => obj(m) && typeof m.path === 'string');
	const imageOpen = () => !!(S.img && typeof S.img.path === 'string');
	const modelEntry = path => models().find(m => m.path === path) || null;
	const imageEntry = path => images().find(i => i.path === path) || null;
	const folder = () => String(settings().folder || 'modelos').replace(/\/+$/, '');
	const library = () => {
		const list = arr(engine().animations).filter(a => obj(a) && a.id).map(a => ({ id: String(a.id), label: String(a.label || ANIMATION_LABELS[a.id] || '') }));
		return list.length ? list : Object.keys(ANIMATION_LABELS).sort().map(id => ({ id, label: ANIMATION_LABELS[id] }));
	};
	const animLabel = id => library().find(a => a.id === id)?.label || ANIMATION_LABELS[id] || '';
	const defaultAnims = () => Array.isArray(settings().animations) ? settings().animations.map(String) : arr(engine().defaults).length ? arr(engine().defaults).map(String) : DEFAULT_ANIMATIONS;
	const deviceShort = () => !engineKnown() ? 'placa de vídeo ou processador' : !engineReady() ? 'gerador não encontrado' : engine().device === 'cpu' || !/placa/.test(String(engine().devices || '')) ? 'processador' : 'placa de vídeo';

	/** Elapsed seconds of the running job, moved forward since the tool last wrote state.json. */
	function elapsedNow() {
		const j = job();
		if (!j) { return 0; }
		const base = num(j.elapsed) || 0;
		if (j.state !== 'running') { return base; }
		const since = num(st().updated) ? Date.now() / 1000 - st().updated : 0;
		return base + clamp(since, 0, 3600);
	}
	/** The model a running job is making (the folder and the image's name, or the model being made again). */
	function jobTarget() {
		const j = job();
		if (!j) { return null; }
		if (Array.isArray(j.outputs) && typeof j.outputs[j.index] === 'string') { return j.outputs[j.index]; }
		if (S.mdl && j.current && (stem(S.mdl.path) === stem(j.current) || modelEntry(S.mdl.path)?.source === j.current)) { return S.mdl.path; }
		return j.current ? `${folder()}/${stem(j.current)}.glb` : null;
	}
	/** Seconds this computer usually takes, from the models already made with or without texture. */
	function estimate(textured) {
		const list = models().filter(m => num(m.seconds) && (textured === undefined || !!num(m.texture) === textured));
		return median(list.map(m => m.seconds));
	}
	/** Everything known about the loaded model: the tool's entry in state.models and what the viewer read from the GLB. */
	function facts() {
		const path = S.mdl?.path || null;
		const e = modelEntry(path) || {};
		const i = V.info || {};
		const ready = V.ready;
		const rigged = ready ? i.rigged : typeof e.rigged === 'boolean' ? e.rigged : null;
		return {
			path, entry: e, name: e.name || stem(path), source: typeof e.source === 'string' ? e.source : null, external: !!e.external,
			rigged, reason: e.reason || null, reasonKind: e.reasonKind || null,
			clips: ready ? i.clips.map(c => c.name) : arr(e.clips).map(String),
			vertices: num(e.vertices) ?? i.vertices ?? null, faces: num(e.faces) ?? i.faces ?? null,
			bones: ready ? i.bones : rigged ? 66 : 0, texture: ready ? i.texture : num(e.texture), bytes: num(S.mdl?.bytes) ?? num(e.bytes),
			height: ready ? i.height : num(e.height), seconds: num(e.seconds), timings: obj(e.timings), devices: obj(e.devices), created: e.created,
			warnings: arr(e.warnings).map(w => typeof w === 'string' ? w : obj(w)?.text).filter(Boolean),
		};
	}
	/** The steps of a model's timings, in the Studio's order, with the engine's names folded in. */
	function timingSteps(timings) {
		const totals = {};
		for (const [name, seconds] of Object.entries(timings || {})) {
			const step = TIMING_STEPS[name];
			if (step && num(seconds) !== null) { totals[step] = (totals[step] || 0) + seconds; }
		}
		return STEP_ORDER.filter(key => key in totals && !(key === 'rig' && totals[key] === 0 && !totals.clips)).map(key => ({ key, seconds: totals[key] }));
	}
	function modelChip(f) {
		if (V.loading) { return 'abrindo'; }
		if (f.rigged === false) { return 'sem ossos'; }
		if (f.rigged === null && !V.ready) { return null; }
		return `${plural(f.bones, 'osso', 'ossos')} · ${plural(f.clips.length, 'animação', 'animações')}`;
	}
	function staticKind(m) {
		return m.reasonKind === 'NotFullBodyError' ? 'busto ou meio corpo' : m.reasonKind === 'NotHumanoidError' ? 'animal ou objeto' : 'sem esqueleto';
	}
	function selectedImage() {
		const list = images();
		const pick = list.find(i => i.path === S.imageSel) || list.find(i => i.path === S.img?.path) || list.find(i => !i.model) || list[0];
		return pick || null;
	}

	// ------------------------------------------------------------------ the 3D viewer

	const V = {
		renderer: null, canvas: null, scene: null, camera: null, controls: null, grid: null, ro: null, vp: null, w: 0, h: 0, dpr: 0,
		failed: null, raf: 0, loop: false, last: 0, token: 0, loading: false, ready: false, error: null,
		root: null, meshes: [], skinned: null, skeleton: null, bones: new Map(), clips: [], mixer: null, action: null, box: null,
		helper: null, dots: null, dotBones: [], selDot: null, dotTexture: null, weights: null, weightBone: null, weightStats: null, info: null,
		down: null,
	};

	/** Creates the one renderer the Studio keeps; returns false (with V.failed) where WebGL is not available. */
	function viewerSetup() {
		if (V.renderer) { return true; }
		if (V.failed) { return false; }
		if (!G) {
			V.failed = 'O visualizador 3D não carregou nesta janela.';
			return false;
		}
		const { THREE, OrbitControls } = G;
		try {
			V.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'default' });
		} catch {
			V.failed = 'Esta janela não conseguiu abrir o 3D (WebGL indisponível). O arquivo GLB continua na pasta do projeto.';
			return false;
		}
		const r = V.renderer;
		r.setClearColor(0x1e1e1e, 1);
		r.outputColorSpace = THREE.SRGBColorSpace;
		V.canvas = r.domElement;
		V.scene = new THREE.Scene();
		V.camera = new THREE.PerspectiveCamera(32, 1, 0.01, 100);
		V.scene.add(V.camera);
		V.scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3a3c, 1.5));
		// The key light follows the camera, so every side of the model is lit the same way.
		const key = new THREE.DirectionalLight(0xffffff, 1.7);
		key.position.set(1.2, 1.4, 0.6);
		const aim = new THREE.Object3D();
		aim.position.set(0, 0, -6);
		V.camera.add(aim);
		V.camera.add(key);
		key.target = aim;
		V.grid = new THREE.GridHelper(8, 32, 0x3c3c40, 0x323235);
		V.scene.add(V.grid);
		V.controls = new OrbitControls(V.camera, V.canvas);
		V.controls.enableDamping = false;
		V.controls.screenSpacePanning = true;
		V.controls.minDistance = 0.15;
		V.controls.maxDistance = 30;
		V.controls.autoRotateSpeed = 1.6;
		V.controls.addEventListener('change', invalidate);
		// An empty stage until a model arrives: the floor seen from a person's height.
		V.camera.position.set(0, 1.4, 4.2);
		V.controls.target.set(0, 0.85, 0);
		V.controls.update();
		V.ro = new ResizeObserver(() => resize());
		V.canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); });
		V.canvas.addEventListener('webglcontextrestored', () => invalidate());
		V.canvas.addEventListener('pointerdown', event => { V.down = [event.clientX, event.clientY]; });
		V.canvas.addEventListener('pointerup', event => {
			const down = V.down;
			V.down = null;
			if (down && Math.hypot(event.clientX - down[0], event.clientY - down[1]) < 4 && S.view === 'skeleton') { pickBone(event.clientX, event.clientY); }
		});
		return true;
	}

	/** Base64 to bytes, and bytes to base64 (chunked: a texture is about a megabyte). */
	function fromBase64(text) {
		const binary = atob(text);
		const out = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) { out[i] = binary.charCodeAt(i); }
		return out.buffer;
	}
	function toBase64(bytesIn) {
		let text = '';
		for (let i = 0; i < bytesIn.length; i += 0x8000) { text += String.fromCharCode(...bytesIn.subarray(i, i + 0x8000)); }
		return btoa(text);
	}

	/**
	 * GLTFLoader plugin for the Studio's policy: images load only from data: URLs (blob: is blocked), so an embedded
	 * PNG or JPEG becomes a data: URL, an Image and a texture with the glTF sampler's filters and wrapping.
	 */
	function dataTextures(parser) {
		const { THREE } = G;
		const FILTERS = { 9728: THREE.NearestFilter, 9729: THREE.LinearFilter, 9984: THREE.NearestMipmapNearestFilter, 9985: THREE.LinearMipmapNearestFilter, 9986: THREE.NearestMipmapLinearFilter, 9987: THREE.LinearMipmapLinearFilter };
		const WRAPS = { 33071: THREE.ClampToEdgeWrapping, 33648: THREE.MirroredRepeatWrapping, 10497: THREE.RepeatWrapping };
		return {
			name: 'G3D_data_textures',
			loadTexture(index) {
				const json = parser.json;
				const def = json.textures?.[index];
				const source = def ? json.images?.[def.source] : null;
				if (!source) { return null; }
				let url;
				if (typeof source.uri === 'string' && source.uri.startsWith('data:')) {
					url = Promise.resolve(source.uri);
				} else if (source.bufferView !== undefined) {
					url = parser.getDependency('bufferView', source.bufferView).then(buffer => `data:${source.mimeType || 'image/png'};base64,${toBase64(new Uint8Array(buffer))}`);
				} else {
					return null;
				}
				return url.then(src => new Promise((resolve, reject) => {
					const image = new Image();
					image.onload = () => resolve(image);
					image.onerror = () => reject(new Error('texture image'));
					image.src = src;
				})).then(image => {
					const texture = new THREE.Texture(image);
					const sampler = json.samplers?.[def.sampler] || {};
					texture.flipY = false;
					texture.name = def.name || source.name || '';
					texture.magFilter = FILTERS[sampler.magFilter] ?? THREE.LinearFilter;
					texture.minFilter = FILTERS[sampler.minFilter] ?? THREE.LinearMipmapLinearFilter;
					texture.wrapS = WRAPS[sampler.wrapS] ?? THREE.RepeatWrapping;
					texture.wrapT = WRAPS[sampler.wrapT] ?? THREE.RepeatWrapping;
					texture.generateMipmaps = texture.minFilter !== THREE.NearestFilter && texture.minFilter !== THREE.LinearFilter;
					texture.needsUpdate = true;
					parser.associations.set(texture, { textures: index });
					return texture;
				});
			},
		};
	}

	function viewerLoad(base64) {
		viewerClear();
		if (!viewerSetup()) { return; }
		const token = V.token;
		let buffer;
		try {
			buffer = fromBase64(base64);
		} catch {
			V.error = 'O arquivo do modelo chegou incompleto ao Studio.';
			return;
		}
		V.loading = true;
		const loader = new G.GLTFLoader();
		loader.register(dataTextures);
		loader.parse(buffer, '', gltf => {
			if (token !== V.token) { disposeTree(gltf.scene); return; }
			try {
				viewerModel(gltf);
			} catch {
				V.error = 'Não foi possível mostrar este modelo.';
			}
			V.loading = false;
			render();
		}, () => {
			if (token !== V.token) { return; }
			V.loading = false;
			V.error = 'Não foi possível abrir este arquivo GLB.';
			render();
		});
	}

	function disposeTree(rootObject) {
		rootObject.traverse(o => {
			o.geometry?.dispose();
			for (const material of [].concat(o.material || [])) {
				for (const value of Object.values(material)) {
					if (value && value.isTexture) { value.dispose(); }
				}
				material.dispose();
			}
		});
	}

	/** Drops the shown model and everything made for it (geometry, materials, textures, helpers, the mixer). */
	function viewerClear() {
		V.token++;
		V.loading = false;
		V.ready = false;
		V.error = null;
		V.info = null;
		if (!V.scene) { return; }
		setWeights(null);
		if (V.mixer) { V.mixer.stopAllAction(); if (V.root) { V.mixer.uncacheRoot(V.root); } }
		if (V.root) { V.scene.remove(V.root); disposeTree(V.root); }
		if (V.weights) { V.weights.geometry.dispose(); V.weights.material.dispose(); }
		for (const extra of [V.helper, V.dots, V.selDot]) {
			if (extra) { V.scene.remove(extra); extra.geometry.dispose(); extra.material.dispose(); }
		}
		Object.assign(V, { root: null, meshes: [], skinned: null, skeleton: null, bones: new Map(), clips: [], mixer: null, action: null, box: null, helper: null, dots: null, dotBones: [], selDot: null, weights: null, weightBone: null, weightStats: null });
		invalidate();
	}

	/** Puts every bone back in the pose the mesh was bound in: the pose of the image. */
	function poseBind() {
		if (V.mixer) { V.mixer.stopAllAction(); }
		V.action = null;
		if (V.skeleton) { V.skeleton.pose(); }
		V.root?.updateMatrixWorld(true);
	}

	function viewerModel(gltf) {
		const { THREE } = G;
		V.root = gltf.scene;
		V.scene.add(V.root);
		V.clips = arr(gltf.animations);
		V.root.traverse(o => {
			if (o.isMesh) { V.meshes.push(o); }
			if (o.isSkinnedMesh) {
				o.frustumCulled = false;
				if (!V.skinned) { V.skinned = o; }
			}
		});
		if (V.skinned) {
			V.skeleton = V.skinned.skeleton;
			for (const bone of V.skeleton.bones) { V.bones.set(bone.name, bone); }
		}
		V.mixer = new THREE.AnimationMixer(V.root);
		V.mixer.addEventListener('finished', () => { S.playing = false; render(); });
		poseBind();
		V.box = new THREE.Box3().setFromObject(V.root);
		let vertices = 0, faces = 0, texture = null;
		for (const mesh of V.meshes) {
			const position = mesh.geometry.attributes.position;
			vertices += position ? position.count : 0;
			faces += mesh.geometry.index ? mesh.geometry.index.count / 3 : (position ? position.count / 3 : 0);
			const map = [].concat(mesh.material || []).find(m => m.map)?.map;
			if (map?.image && !texture) { texture = map.image.width || map.image.naturalWidth || null; }
		}
		if (V.skeleton) {
			const helper = new THREE.SkeletonHelper(V.root);
			if (typeof helper.setColors === 'function') { helper.setColors(new THREE.Color(0xe6e6e6), new THREE.Color(0xe6e6e6)); }
			helper.material.depthTest = false;
			helper.material.depthWrite = false;
			helper.material.toneMapped = false;
			helper.renderOrder = 10;
			V.helper = helper;
			V.scene.add(helper);
			makeDots();
		}
		const size = V.box.getSize(new THREE.Vector3());
		V.info = {
			rigged: !!V.skeleton, bones: V.skeleton ? V.skeleton.bones.length : 0, clips: V.clips.map(c => ({ name: c.name, duration: c.duration, fps: clipFps(c) })),
			vertices, faces: Math.round(faces), texture: texture || 0, vertexColors: V.meshes.some(m => !!m.geometry.attributes.color), height: size.y, measures: measures(),
		};
		V.ready = true;
		frame(S.camera);
	}

	function clipFps(clip) {
		// The track with the most keys tells the frame rate; some tracks only hold their first and last values.
		const times = (clip.tracks || []).reduce((best, track) => (track.times?.length || 0) > (best?.length || 0) ? track.times : best, null);
		return times && times.length > 1 && clip.duration > 0 ? Math.round((times.length - 1) / clip.duration) : 30;
	}

	/** Measures of the character from the bind pose (the pose of the image), in metres. */
	function measures() {
		const { THREE } = G;
		const at = name => { const bone = V.bones.get(name); return bone ? bone.getWorldPosition(new THREE.Vector3()) : null; };
		const dist = (a, b) => { const pa = at(a), pb = at(b); return pa && pb ? pa.distanceTo(pb) : null; };
		const chain = (...names) => { let total = 0; for (let i = 0; i + 1 < names.length; i++) { const d = dist(names[i], names[i + 1]); if (d === null) { return null; } total += d; } return total; };
		const avg = (...values) => { const v = values.filter(x => x !== null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
		return {
			shoulders: dist('upperarm_l', 'upperarm_r'),
			arm: avg(chain('upperarm_l', 'lowerarm_l', 'hand_l'), chain('upperarm_r', 'lowerarm_r', 'hand_r')),
			leg: avg(chain('thigh_l', 'calf_l', 'foot_l'), chain('thigh_r', 'calf_r', 'foot_r')),
			torso: dist('pelvis', 'neck_01'),
			// From the head bone (the base of the skull) to the top of the model, hat or hair included.
			head: at('head') && V.box ? V.box.max.y - at('head').y : null,
			hips: dist('thigh_l', 'thigh_r'),
			foot: avg(chain('foot_l', 'ball_l', 'ball_leaf_l'), chain('foot_r', 'ball_r', 'ball_leaf_r')),
		};
	}

	/** Round dots on the main joints (not the fingers or the leaf ends), drawn over the model. */
	function makeDots() {
		const { THREE } = G;
		if (!V.dotTexture) {
			const canvas = document.createElement('canvas');
			canvas.width = canvas.height = 32;
			const g = canvas.getContext('2d');
			g.beginPath();
			g.arc(16, 16, 12, 0, Math.PI * 2);
			g.fillStyle = '#ffffff';
			g.fill();
			g.lineWidth = 5;
			g.strokeStyle = '#1e1e1e';
			g.stroke();
			V.dotTexture = new THREE.CanvasTexture(canvas);
			V.dotTexture.colorSpace = THREE.SRGBColorSpace;
		}
		V.dotBones = V.skeleton.bones.filter(b => !/_leaf/.test(b.name) && !FINGER.test(b.name) && b.name !== 'root');
		const points = (count, size, color) => {
			const geometry = new THREE.BufferGeometry();
			geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
			const material = new THREE.PointsMaterial({ size, sizeAttenuation: false, map: V.dotTexture, color, transparent: true, alphaTest: 0.5, depthTest: false, depthWrite: false, toneMapped: false });
			const p = new THREE.Points(geometry, material);
			p.frustumCulled = false;
			p.renderOrder = 11;
			V.scene.add(p);
			return p;
		};
		V.dots = points(V.dotBones.length, 8, 0xffffff);
		V.selDot = points(1, 13, 0x7dbdff);
		V.selDot.renderOrder = 12;
	}

	function updateDots() {
		if (!V.dots) { return; }
		const { THREE } = G;
		const v = new THREE.Vector3();
		if (V.dots.visible) {
			const position = V.dots.geometry.attributes.position;
			V.dotBones.forEach((bone, i) => { bone.getWorldPosition(v); position.setXYZ(i, v.x, v.y, v.z); });
			position.needsUpdate = true;
		}
		const sel = V.bones.get(S.bone);
		if (V.selDot.visible && sel) {
			sel.getWorldPosition(v);
			V.selDot.geometry.attributes.position.setXYZ(0, v.x, v.y, v.z);
			V.selDot.geometry.attributes.position.needsUpdate = true;
		}
	}

	/** Colours the skinned mesh by one bone's weight (or puts the model's own material back with null). */
	function setWeights(boneName) {
		const mesh = V.skinned;
		if (!mesh) { return; }
		if (!boneName || !paintWeights(boneName)) {
			if (V.weights && mesh.geometry === V.weights.geometry) {
				mesh.geometry = V.weights.original.geometry;
				mesh.material = V.weights.original.material;
				invalidate();
			}
			return;
		}
		V.weights.material.wireframe = !!S.tools.wire;
		mesh.geometry = V.weights.geometry;
		mesh.material = V.weights.material;
		invalidate();
	}

	/**
	 * Fills the weight colours of one bone on a copy of the mesh's geometry that shares every attribute but the colour,
	 * and counts the vertices that follow it and the bones it shares them with. False when the bone is not in the skin.
	 */
	function paintWeights(boneName) {
		const mesh = V.skinned;
		if (!mesh) { return false; }
		const { THREE } = G;
		const index = V.skeleton.bones.findIndex(b => b.name === boneName);
		if (index < 0) { return false; }
		if (!V.weights) {
			const source = mesh.geometry;
			const geometry = new THREE.BufferGeometry();
			geometry.setIndex(source.index);
			for (const [name, attribute] of Object.entries(source.attributes)) {
				if (name !== 'color') { geometry.setAttribute(name, attribute); }
			}
			geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(source.attributes.position.count * 3), 3));
			const material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
			V.weights = { geometry, material, original: { geometry: mesh.geometry, material: mesh.material } };
		}
		if (V.weightBone !== boneName) {
			const skinIndex = V.weights.geometry.attributes.skinIndex;
			const skinWeight = V.weights.geometry.attributes.skinWeight;
			const colors = V.weights.geometry.attributes.color;
			const steps = WEIGHT_STEPS.map(hex => new THREE.Color(hex));
			let follows = 0, whole = 0;
			const shares = new Map();
			for (let i = 0; i < colors.count; i++) {
				let w = 0;
				for (let k = 0; k < 4; k++) {
					if (skinIndex.getComponent(i, k) === index) { w += skinWeight.getComponent(i, k); }
				}
				const step = w <= 0.005 ? 0 : w <= 0.25 ? 1 : w <= 0.5 ? 2 : w <= 0.75 ? 3 : 4;
				colors.setXYZ(i, steps[step].r, steps[step].g, steps[step].b);
				if (w > 0.01) {
					follows++;
					if (w >= 0.9) { whole++; }
					for (let k = 0; k < 4; k++) {
						const other = skinIndex.getComponent(i, k);
						const ow = skinWeight.getComponent(i, k);
						if (other !== index && ow > 0.01) { shares.set(other, (shares.get(other) || 0) + ow); }
					}
				}
			}
			colors.needsUpdate = true;
			const shared = [...shares.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([i]) => V.skeleton.bones[i]?.name).filter(Boolean);
			V.weightBone = boneName;
			V.weightStats = { follows, whole, partial: follows - whole, shared };
		}
		return true;
	}

	/** Points the camera at the model from the front, a side, the back or above, framing its whole height. */
	function frame(preset) {
		if (!V.root || !V.box) { return; }
		const { THREE } = G;
		const size = V.box.getSize(new THREE.Vector3());
		const center = V.box.getCenter(new THREE.Vector3());
		const fov = V.camera.fov * Math.PI / 180;
		const aspect = V.w && V.h ? V.w / V.h : 1;
		const across = Math.max(size.x, size.z);
		const fitHeight = size.y / 2 / Math.tan(fov / 2);
		const fitWidth = across / 2 / Math.tan(fov / 2) / aspect;
		const distance = Math.max(fitHeight, fitWidth) * 1.18 + across / 2;
		const dirs = { front: [0, 0.1, 1], side: [1, 0.1, 0], back: [0, 0.1, -1], top: [0.3, 1.5, 0.8] };
		const dir = new THREE.Vector3(...(dirs[preset] || dirs.front)).normalize();
		V.camera.position.copy(center).addScaledVector(dir, distance);
		V.camera.near = Math.max(0.005, distance / 200);
		V.camera.far = distance * 30;
		V.camera.updateProjectionMatrix();
		V.controls.target.copy(center);
		V.controls.update();
		invalidate();
	}

	function resize() {
		if (!V.vp || !V.renderer) { return; }
		const w = Math.floor(V.vp.clientWidth), h = Math.floor(V.vp.clientHeight);
		const dpr = Math.min(2, window.devicePixelRatio || 1);
		if (w < 2 || h < 2) { return; }
		if (w !== V.w || h !== V.h || dpr !== V.dpr) {
			const first = !V.w;
			V.renderer.setPixelRatio(dpr);
			V.renderer.setSize(w, h, false);
			V.camera.aspect = w / h;
			V.camera.updateProjectionMatrix();
			V.w = w;
			V.h = h;
			V.dpr = dpr;
			if (first) { frame(S.camera); }
		}
		invalidate();
	}

	/** Renders on demand: one frame after a change, continuously only while an animation plays or the model spins. */
	function invalidate() {
		if (V.raf || !V.renderer || !V.vp || document.hidden) { return; }
		V.raf = requestAnimationFrame(tick);
	}

	function tick() {
		V.raf = 0;
		if (!V.vp || !V.w) { V.loop = false; return; }
		const now = performance.now();
		const dt = V.loop ? Math.min(0.1, (now - V.last) / 1000) : 0;
		V.last = now;
		V.loop = true;
		let again = false;
		if (V.action && !V.action.paused && V.mixer) {
			V.mixer.update(dt);
			again = true;
			updatePlayer();
		}
		if (V.controls.autoRotate) {
			V.controls.update(dt);
			again = true;
		}
		updateDots();
		V.renderer.render(V.scene, V.camera);
		if (again) {
			invalidate();
		} else {
			V.loop = false;
		}
	}

	/** What the viewer shows for the current view: pose or animation, bones, weights, grid, wireframe, spinning. */
	function applyMode() {
		if (!V.renderer) { return; }
		V.grid.visible = !!S.tools.grid;
		if (!V.root) { invalidate(); return; }
		const { THREE } = G;
		const f = facts();
		const waiting = jobRunning() && !(S.mdl && jobTarget() === S.mdl.path);
		V.root.visible = !(S.view === 'model' && waiting);
		const animate = S.view === 'animations' && V.clips.length > 0;
		if (animate) {
			const clip = V.clips.find(c => c.name === S.anim) || V.clips[0];
			S.anim = clip.name;
			if (!V.action || V.action.getClip() !== clip) {
				poseBind();
				V.action = V.mixer.clipAction(clip);
				V.action.reset();
				V.action.play();
			}
			V.action.setLoop(S.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
			V.action.clampWhenFinished = !S.loop;
			V.action.paused = !S.playing;
			V.action.setEffectiveTimeScale(S.speed);
			if (!S.playing) { V.mixer.update(0); }
		} else if (V.action) {
			poseBind();
		}
		setWeights(S.view === 'skeleton' && S.skelMode === 'weights' && f.rigged ? S.bone : null);
		const bonesOn = !!V.skeleton && (S.view === 'skeleton' ? S.skelMode === 'bones' : (S.view === 'model' || S.view === 'animations') && S.tools.bones);
		if (V.helper) { V.helper.visible = bonesOn; }
		if (V.dots) { V.dots.visible = bonesOn; }
		if (V.selDot) { V.selDot.visible = S.view === 'skeleton' && V.bones.has(S.bone); }
		for (const mesh of V.meshes) {
			for (const material of [].concat(mesh.material || [])) { material.wireframe = !!S.tools.wire; }
		}
		V.controls.autoRotate = !!S.tools.spin && S.view !== 'skeleton';
		invalidate();
	}

	/** Moves the one canvas into the viewer box of the view just drawn (or keeps it aside when the view has none). */
	function viewerAttach() {
		const vp = document.querySelector('.g3-vp[data-viewer]');
		if (!vp || !viewerSetup()) {
			if (V.vp) { V.ro?.disconnect(); V.vp = null; }
			return;
		}
		if (V.canvas.parentElement !== vp) { vp.prepend(V.canvas); }
		if (V.vp !== vp) {
			V.ro.disconnect();
			V.ro.observe(vp);
			V.vp = vp;
		}
		applyMode();
		resize();
	}

	function pickBone(x, y) {
		if (!V.skeleton) { return; }
		const { THREE } = G;
		const rect = V.canvas.getBoundingClientRect();
		const v = new THREE.Vector3();
		let best = null, bestDistance = 16;
		const candidates = S.skelMode === 'weights' ? V.skeleton.bones.filter(b => !/_leaf/.test(b.name)) : V.dotBones;
		for (const bone of candidates) {
			bone.getWorldPosition(v).project(V.camera);
			if (v.z > 1) { continue; }
			const px = rect.left + (v.x + 1) / 2 * rect.width, py = rect.top + (1 - v.y) / 2 * rect.height;
			const d = Math.hypot(px - x, py - y);
			if (d < bestDistance) { bestDistance = d; best = bone.name; }
		}
		if (best) {
			S.bone = best;
			S.skelMode = 'weights';
			if (FINGER.test(best)) { S.fingers = true; }
			remember();
			render();
		}
	}

	// ------------------------------------------------------------------ bones

	const BONE_NAMES = { pelvis: 'pélvis', spine_01: 'coluna, embaixo', spine_02: 'coluna, meio', spine_03: 'coluna, em cima', neck_01: 'pescoço', head: 'cabeça', head_leaf: 'topo da cabeça', root: 'raiz, no chão' };
	const SIDED = { clavicle: ['clavícula', 'a', ''], upperarm: ['braço', 'o', ', parte de cima'], lowerarm: ['antebraço', 'o', ''], hand: ['mão', 'a', ''], thigh: ['coxa', 'a', ''], calf: ['canela', 'a', ''], foot: ['pé', 'o', ''], ball: ['ponta do pé', 'o', ''], ball_leaf: ['fim do pé', 'o', ''] };
	const FINGER_NAMES = { thumb: 'polegar', index: 'indicador', middle: 'dedo médio', ring: 'anelar', pinky: 'mínimo' };
	/** A bone's name in Portuguese: upperarm_l is "braço esquerdo, parte de cima". */
	function boneLabel(name) {
		if (BONE_NAMES[name]) { return BONE_NAMES[name]; }
		let m = /^(?<finger>thumb|index|middle|ring|pinky)_0(?<n>\d)(?<leaf>_leaf)?_(?<side>[lr])$/.exec(name);
		if (m) {
			const g = m.groups;
			return `${FINGER_NAMES[g.finger]} ${g.side === 'l' ? 'esquerdo' : 'direito'}${g.leaf ? ', ponta' : `, parte ${g.n}`}`;
		}
		m = /^(?<base>.+)_(?<side>[lr])$/.exec(name);
		if (m && SIDED[m.groups.base]) {
			const [base, gender, extra] = SIDED[m.groups.base];
			const left = m.groups.side === 'l';
			return `${base} ${gender === 'a' ? (left ? 'esquerda' : 'direita') : (left ? 'esquerdo' : 'direito')}${extra}`;
		}
		return name;
	}
	const PARTS = [
		['Tronco e cabeça', n => /^(pelvis|spine_\d+|neck_\d+|head|head_leaf)$/.test(n)],
		['Braço esquerdo', n => /^(clavicle|upperarm|lowerarm|hand)_l$/.test(n)],
		['Braço direito', n => /^(clavicle|upperarm|lowerarm|hand)_r$/.test(n)],
		['Dedos', n => FINGER.test(n)],
		['Pernas e pés', n => /^(thigh|calf|foot|ball|ball_leaf)_[lr]$/.test(n)],
		['Raiz', n => n === 'root'],
		['Outros', () => true],
	];
	/** spine_01, spine_02, spine_03 read as "spine_01 a 03". */
	function boneNames(names) {
		const out = [];
		for (const name of names) {
			const m = /^(?<base>.+_)(?<n>\d+)$/.exec(name);
			const last = out[out.length - 1];
			if (m && last && last.base === m.groups.base) {
				last.to = m.groups.n;
			} else {
				out.push(m ? { base: m.groups.base, from: m.groups.n, to: null } : { text: name });
			}
		}
		return out.map(o => o.text ?? `${o.base}${o.from}${o.to ? ` a ${o.to}` : ''}`).join(', ');
	}
	function boneParts() {
		const left = V.skeleton ? V.skeleton.bones.map(b => b.name) : [];
		const parts = [];
		for (const [label, test] of PARTS) {
			const names = left.filter(n => test(n));
			for (const n of names) { left.splice(left.indexOf(n), 1); }
			if (!names.length) { continue; }
			let text = boneNames(names);
			if (label === 'Dedos') {
				const fingers = new Set(names.map(n => n.replace(/_0\d(_leaf)?_/, '_')));
				const perHand = fingers.size / 2;
				text = Number.isInteger(perHand) && names.length % fingers.size === 0 ? `${perHand} por mão, ${names.length / fingers.size} ossos cada` : text;
			} else if (label === 'Raiz') {
				text = 'root, no chão, entre os pés';
			}
			parts.push([label, text, names.length]);
		}
		return parts;
	}
	/** The bone tree without the leaf ends; the fingers fold into one row under each hand. */
	function boneRows() {
		if (!V.skeleton) { return []; }
		const depth = bone => { let d = 0, p = bone.parent; while (p && p.isBone) { d++; p = p.parent; } return d; };
		const rows = [];
		const visit = bone => {
			if (/_leaf/.test(bone.name) || bone.name === 'root') {
				if (bone.name === 'root') { bone.children.filter(c => c.isBone).forEach(visit); }
				return;
			}
			if (FINGER.test(bone.name)) {
				if (S.fingers) { rows.push({ name: bone.name, depth: depth(bone) - 1 }); bone.children.filter(c => c.isBone).forEach(visit); }
				return;
			}
			rows.push({ name: bone.name, depth: depth(bone) - 1 });
			if (/^hand_/.test(bone.name) && !S.fingers) {
				const count = V.skeleton.bones.filter(b => FINGER.test(b.name) && b.name.endsWith(bone.name.slice(-2))).length;
				if (count) { rows.push({ fingers: count, depth: depth(bone), side: bone.name.slice(-1) }); }
				return;
			}
			bone.children.filter(c => c.isBone).forEach(visit);
		};
		const roots = V.skeleton.bones.filter(b => !b.parent || !b.parent.isBone);
		roots.forEach(visit);
		return rows;
	}

	// ------------------------------------------------------------------ toolbar, footer and frame

	function toolbar() {
		const onView = S.view === 'start' ? 'image' : S.view;
		const hasModel = !!S.mdl || jobRunning();
		const buttons = Object.entries(VIEWS).map(([id, v]) => `<button class="g3-vb ${onView === id ? 'on' : ''} ${MODEL_VIEWS.includes(id) && !hasModel ? 'dis' : ''}" data-act="view" data-view="${id}" title="${v.label}">${ic(v.icon)}<span class="t">${v.label}</span></button>`).join('');
		let name, chip = null;
		if (S.view === 'models') {
			name = plural(models().length, 'modelo', 'modelos');
			chip = `${folder()}/`;
		} else if (S.view === 'settings') {
			name = 'Configurações';
			chip = S.ctx?.source || null;
		} else if (S.view === 'model' && jobRunning() && (!S.mdl || jobTarget() !== S.mdl.path)) {
			name = job().total > 1 ? plural(job().total, 'imagem', 'imagens') : basename(jobTarget());
			chip = job().total > 1 ? 'na fila' : 'gerando';
		} else if (MODEL_VIEWS.includes(S.view) && S.mdl) {
			name = basename(S.mdl.path);
			chip = jobRunning() ? 'gerando de novo' : modelChip(facts());
		} else if (imageOpen() && S.view !== 'start') {
			name = basename(S.img.path);
			const size = arr(S.img.size);
			chip = size.length === 2 ? `${size[0]} × ${size[1]}` : null;
		} else if (S.view === 'start') {
			name = imageOpen() ? basename(S.img.path) : 'Nenhuma imagem aberta';
			chip = imageOpen() ? 'aberta' : null;
		} else {
			name = MODEL_VIEWS.includes(S.view) ? 'Nenhum modelo aberto' : 'Nenhuma imagem aberta';
		}
		const crumb = `<span class="g3-crumb" title="${esc(name)}">${MARK}<b>${esc(name)}</b>${chip ? `<span class="v">${esc(chip)}</span>` : ''}</span>`;
		const stat = (icon, cls, text) => `<span class="g3-stat">${ic(icon, cls)}<span class="t">${text}</span></span>`;
		let status;
		const j = job();
		if (jobRunning()) {
			const queue = j.total > 1 ? `${nf(j.index + 1)} de ${nf(j.total)} · ` : '';
			status = stat('spinner', 'spin c-run', `Gerando · ${queue}<span data-tick="elapsed">${secs(elapsedNow())}</span>`);
		} else if (S.running && S.pending) {
			status = stat('spinner', 'spin c-run', 'Agente trabalhando');
		} else if (S.view === 'model' && j?.state === 'failed' && (!S.mdl || jobTarget() !== S.mdl.path)) {
			status = stat('failed', 'c-bad', 'A geração falhou');
		} else if (S.st && !engineReady()) {
			status = stat('warning', 'c-you', 'Gerador não encontrado');
		} else if (MODEL_VIEWS.includes(S.view) && S.mdl) {
			const f = facts();
			status = f.seconds ? stat('dot', 'c-ok sm', `Pronto em ${secs(f.seconds)}`) : stat('dot', 'c-ok sm', 'Modelo aberto');
		} else if (S.view === 'image' && imageOpen()) {
			status = obj(S.img.verdict)?.rig === false ? stat('dot', 'c-you sm', 'Sai sem ossos') : stat('dot', 'c-run sm', 'Pronta para gerar');
		} else {
			status = stat('dot', 'c-dim sm', imageOpen() ? 'Imagem aberta' : 'Esperando uma imagem');
		}
		const nothing = !imageOpen() && !S.mdl && !models().length;
		const action = jobRunning()
			? btn('Parar', ['stop', 'c-bad'], 'g3-bar-act', 'data-act="stop" title="Parar a geração"')
			: btn('Abrir imagem', 'image', `g3-bar-act ${nothing ? 'primary' : ''}`, 'data-act="view" data-view="start" title="Imagens do projeto"');
		return `<div class="g3-bar">${buttons}<span class="g3-sep"></span>${crumb}<span class="g3-sp"></span>${status}${action}</div>`;
	}

	function footer() {
		const asks = `<span>${ic('comments')}botões pedem ao agente</span>`;
		const computer = tight() ? '' : `<span>${ic('chip')}neste computador · ${esc(deviceShort())}</span>`;
		let parts;
		const j = job();
		if (S.view === 'model' && jobRunning() && (j.total > 1 || !S.mdl || jobTarget() !== S.mdl.path)) {
			parts = j.total > 1
				? [`<span class="f">${ic('folder')}<span class="t">${esc(folder())}/ · ${nf(arr(j.results).length)} de ${nf(j.total)} prontas</span></span>`, `<span><span data-tick="elapsed">${secs(elapsedNow())}</span> até agora</span>`]
				: [`<span class="f">${ic('file')}<span class="t">${esc(jobTarget())} · ainda não gravado</span></span>`, `<span>${num(settings().texture) ? `textura ${px(settings().texture)}` : 'cores nos vértices'}</span>`];
		} else if (MODEL_VIEWS.includes(S.view) && S.mdl) {
			const f = facts();
			parts = [`<span class="f">${ic('file')}<span class="t">${esc(S.mdl.path)} · ${bytes(f.bytes)}</span></span>`, `<span>${nf(f.vertices)} vértices · ${nf(f.faces)} triângulos</span>`];
		} else if (S.view === 'models') {
			const list = models();
			parts = [`<span class="f">${ic('folder')}<span class="t">${esc(folder())}/ · ${plural(list.length, 'modelo', 'modelos')}</span></span>`, `<span>${bytes(list.reduce((a, m) => a + (num(m.bytes) || 0), 0))}</span>`];
		} else if (S.view === 'settings') {
			const changes = Object.keys(S.setDraft).length + (S.animSetDraft ? 1 : 0);
			parts = [`<span class="f">${ic('gear')}<span class="t">configurações de ${esc(S.ctx?.source || 'este projeto')}</span></span>`, `<span>${changes ? `${plural(changes, 'mudança', 'mudanças')} por pedir` : 'sem mudanças'}</span>`];
		} else if (S.view === 'image' && imageOpen()) {
			parts = [`<span class="f">${ic('file')}<span class="t">${esc(S.img.path)} · ${bytes(imageEntry(S.img.path)?.bytes)}</span></span>`, '<span>imagem não alterada</span>'];
		} else {
			const n = images().length + (num(st().imagesMore) || 0);
			parts = [`<span class="f">${ic('folder')}<span class="t">${esc(S.ctx?.source || 'projeto')}</span></span>`, `<span>${!Array.isArray(st().images) ? 'imagens ainda não listadas' : n ? plural(n, 'imagem encontrada', 'imagens encontradas') : 'nenhuma imagem encontrada'}</span>`];
		}
		return `<div class="g3-foot">${parts.join('')}${computer}${asks}</div>`;
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
		const root = document.getElementById('g3-root') || (() => {
			const el = document.createElement('div');
			el.id = 'g3-root';
			document.body.appendChild(el);
			return el;
		})();
		const scrolls = {};
		root.querySelectorAll('[data-scroll]').forEach(el => { scrolls[el.dataset.scroll] = el.scrollTop; });
		let body;
		if (!S.st) {
			body = '<div class="g3-empty"><div class="g3-dim">Abrindo o 3D Generator…</div></div>';
		} else if (S.view === 'start' || (S.view === 'image' && !imageOpen())) {
			body = startView();
		} else {
			body = ({ image: imageView, model: modelView, skeleton: skeletonView, animations: animationsView, models: modelsView, settings: settingsView })[S.view]();
		}
		const toastHtml = S.note ? `<div class="g3-toast">${ic(S.noteKind === 'warning' ? 'warning' : 'info', S.noteKind === 'warning' ? 'c-you' : 'c-run')}<span>${esc(S.note)}</span></div>` : '';
		root.innerHTML = `<div class="g3-studio ${window.innerHeight < 800 ? 'compact' : ''}">${toolbar()}<div class="g3-body">${body}</div>${footer()}${toastHtml}</div>`;
		root.querySelectorAll('[data-scroll]').forEach(el => {
			if (scrolls[el.dataset.scroll]) { el.scrollTop = scrolls[el.dataset.scroll]; }
		});
		// A narrow toolbar first shortens "Abrir imagem" and Configurações to their icons, then hides the chip, the view
		// icons and the status words; only then the name is cut.
		const bar = root.querySelector('.g3-bar');
		if (bar) {
			const crumb = bar.querySelector('.g3-crumb');
			const name = crumb?.querySelector('b');
			if (crumb) { crumb.style.flex = 'none'; name.style.maxWidth = '220px'; }
			const over = () => bar.lastElementChild.getBoundingClientRect().right > bar.getBoundingClientRect().right - 10 + 0.25;
			for (const level of ['c1', 'c2', 'c3', 'c4']) {
				if (over()) { bar.classList.add(level); }
			}
			if (crumb) { crumb.style.flex = ''; name.style.maxWidth = ''; }
		}
		viewerAttach();
		updatePlayer();
	}

	// ------------------------------------------------------------------ start: the project's images

	function startView() {
		const list = images();
		const e = engine();
		const sel = selectedImage();
		const groups = new Map();
		for (const image of list) {
			const dir = dirname(image.path);
			if (!groups.has(dir)) { groups.set(dir, []); }
			groups.get(dir).push(image);
		}
		let rows = '';
		for (const [dir, items] of groups) {
			rows += `<div class="g3-folder">${ic('folder')}<span>${esc(dir ? `${dir}/` : 'na pasta do projeto')}</span></div>`;
			rows += items.map(i => {
				const thumb = dataImage(i.thumb);
				const dims = num(i.width) && num(i.height) ? `${px(i.width)} × ${px(i.height)}` : '';
				const made = i.model ? `${dims ? ' · ' : ''}virou ${esc(i.model)}` : '';
				return `<div class="g3-img ${sel?.path === i.path ? 'sel' : ''}" data-act="pick-image" data-path="${esc(i.path)}" title="${esc(i.path)}"><span class="th">${thumb ? `<img src="${esc(thumb)}" alt="">` : ic('image', 'c-dim')}</span><span class="nm">${esc(basename(i.path))}</span><span class="dt">${dims}${made}</span><span class="sz">${bytes(i.bytes)}</span></div>`;
			}).join('');
		}
		const more = num(st().imagesMore) ? `<div class="g3-li dim">${ic('list', 'c-dim')}<span class="tx">e mais ${plural(st().imagesMore, 'imagem', 'imagens')}: peça na conversa pelo nome ou pela pasta</span></div>` : '';
		const listed = Array.isArray(st().images);
		const imagesPanel = !listed
			? panel('Imagens no projeto', `${note('info', 'c-run', '<p>As imagens aparecem aqui quando o agente olhar o projeto.</p><p class="g3-dim">Ele procura PNG e JPG nas pastas do projeto, só para leitura.</p>')}<div style="padding:0 10px 10px 32px">${btn('Listar as imagens', 'list', '', 'data-act="list-images"')}</div>`, { icon: 'image', cls: 'g3-grow' })
			: list.length
			? panel('Imagens no projeto', rows + more, { icon: 'image', right: plural(list.length + (num(st().imagesMore) || 0), 'imagem', 'imagens'), pb: 'np', scroll: 'images', cls: 'g3-grow' })
			: panel('Imagens no projeto', note('info', 'c-run', '<p>Nenhuma imagem PNG ou JPG no projeto.</p><p class="g3-dim">Coloque a imagem do personagem numa pasta do projeto (por exemplo <span class="g3-m">arte/</span>) e peça na conversa.</p>'), { icon: 'image', cls: 'g3-grow' });

		// What comes out, with the times this computer took when there are models to learn from.
		const rigged = models().filter(m => m.rigged === true && num(m.seconds));
		const still = models().filter(m => m.rigged === false && num(m.seconds));
		const range = list2 => { if (!list2.length) { return '—'; } const v = list2.map(m => m.seconds); const lo = Math.min(...v), hi = Math.max(...v); return Math.round(lo) === Math.round(hi) ? `≈ ${nf(Math.round(lo))} s` : `${nf(Math.floor(lo))} a ${nf(Math.ceil(hi))} s`; };
		const textureTimes = models().map(m => num(obj(m.timings)?.texture)).filter(v => v);
		const withTimes = rigged.length || still.length;
		const outcome = [
			['Corpo inteiro, de frente', `${badge('com ossos', 'ok')} modelo, 66 ossos e animações`, range(rigged)],
			['Busto ou meio corpo', `${badge('sem ossos')} só o modelo 3D`, range(still)],
			['Animal ou objeto', `${badge('sem ossos')} só o modelo 3D`, range(still)],
			['Com textura', 'cores mais fiéis à imagem, arquivo maior', textureTimes.length ? `+ ${secs(median(textureTimes))}` : '—'],
		];
		const outcomeTable = table(withTimes ? [['Imagem', 170], ['Resultado', 0], ['Nesta máquina', 110, 'r']] : [['Imagem', 170], ['Resultado', 0]],
			outcome.map(([a, b, c]) => withTimes ? [esc(a), b, c] : [esc(a), b]));

		const how = [
			['Abro a imagem só para leitura', 'e tiro o fundo'], ['Gero a forma 3D', 'TripoSR, neste computador'], ['Acho 17 juntas na imagem', 'ombros, cotovelos, joelhos…'],
			['Coloco 66 ossos e os pesos', 'cada parte segue o osso certo'], ['Copio as animações', 'andar, acenar, pular…'], ['Gravo um GLB no projeto', 'a imagem continua igual'],
		].map(([a, b], i) => tight() || !engineReady()
			? li(`<span class="g3-num">${i + 1}</span>`, esc(a))
			: narrow()
				? `<div class="g3-li two"><span class="g3-num">${i + 1}</span><span class="tx">${esc(a)}<small>${esc(b)}</small></span></div>`
				: li(`<span class="g3-num">${i + 1}</span>`, esc(a), esc(b))).join('');
		const best = [
			['check', 'c-ok', 'Corpo inteiro: cabeça, quadris, joelhos e pés'], ['check', 'c-ok', 'De frente, com os braços um pouco afastados'],
			['check', 'c-ok', 'Fundo simples ou já removido'], ['check', 'c-ok', 'Um personagem só na imagem'],
			['warning', 'c-you', 'Mão encostada no corpo vira uma peça só'], ['warning', 'c-you', 'Óculos e chapéu podem esconder o rosto'],
		].map(([icon, cls, text]) => li(ic(icon, cls), esc(text), '', 'two')).join('');
		const enginePanel = engineReady()
			? `<div class="g3-panel fit">${note('lock', 'c-txt', `<p><b>Neste computador.</b> Nada é enviado para a internet. ${e.devices ? `${esc(cap(e.devices))}.` : 'Usa a placa de vídeo quando há uma; se não, o processador.'}</p>`)}</div>`
			: panel('Gerador não encontrado', note('warning', 'c-you', `<p>${esc(e.problem || 'O gerador do 3D Generator não respondeu.')}</p>${e.fix ? `<p class="g3-dim">${esc(e.fix)}</p>` : ''}`), { icon: 'chip', mk: 'you', pb: 'np fit', cls: 'fit', foot: btn('Verificar de novo', 'refresh', 'sm', 'data-act="check-engine"') });

		const ready = engineReady();
		const actions = `<div class="g3-actions"><span class="g3-dim">${ic('comments')} Os botões do Studio viram pedidos ao agente na conversa.</span>${sel ? btn('Abrir', 'eye', '', `data-act="open-image" data-path="${esc(sel.path)}" ${ready ? '' : 'disabled title="O gerador não está instalado"'}`) + btn(`Gerar ${esc(basename(sel.path))}`, 'cube', 'primary', `data-act="generate-image" data-path="${esc(sel.path)}" ${ready ? '' : 'disabled title="O gerador não está instalado"'}`) : ''}</div>`;

		const hero = `<div class="g3-hero">${MARK}<div><h1>Personagens em 3D neste computador</h1><p>O 3D Generator transforma a imagem de um personagem num modelo 3D, coloca os ossos e copia animações prontas.${narrow() ? ' ' : '<br>'}Você pede na conversa e o agente gera; o GLB vai para a pasta do projeto. A imagem original nunca é alterada.</p></div></div>`;
		// Without the engine nothing else works, so its panel comes first and the steps drop their notes.
		const guide = panel('Como funciona', how, { icon: 'list', pb: 'np fit', cls: 'fit' }) + panel('O que funciona melhor', best, { icon: 'person', pb: 'np fit', cls: 'fit' });
		const side = `<div class="g3-side" data-scroll="start-side">${engineReady() ? guide + enginePanel : enginePanel + guide}</div>`;
		return `${hero}<div class="g3-cols"><div class="g3-main">${imagesPanel}${panel('O que sai em cada caso', outcomeTable, { icon: 'cube', pb: 'np fit', cls: 'fit' })}${actions}</div>${side}</div>`;
	}

	// ------------------------------------------------------------------ image: the checked image

	function keypointGroups(points) {
		const by = new Map(points.map(p => [p.name, p]));
		const used = new Set();
		const groups = [];
		for (const [key, label, names] of KP_GROUPS) {
			const pts = names.map(n => by.get(n)).filter(Boolean);
			pts.forEach(p => used.add(p.name));
			if (pts.length) { groups.push({ key, label, pts }); }
		}
		for (const p of points) {
			if (!used.has(p.name)) { groups.push({ key: p.name, label: p.label || p.name, pts: [p] }); }
		}
		return groups;
	}
	/** Inside the prepared 512 × 512 image (the detector also guesses points beyond its edges). */
	const inside = p => num(p.u) !== null && num(p.v) !== null && p.u >= 0 && p.u <= 512 && p.v >= 0 && p.v <= 512;
	/** A point is found from a score of 0.5, doubtful from 0.3, and not in the image below that or outside the image. */
	const kpState = p => !inside(p) || !(num(p.score) >= 0.3) ? 'out' : p.score >= 0.5 ? 'ok' : 'doubt';

	function pointsSvg(points) {
		const by = new Map(points.map(p => [p.name, p]));
		const shown = p => p && kpState(p) !== 'out';
		const selected = new Set(KP_GROUPS.find(g => g[0] === S.kpSel)?.[2] || (S.kpSel ? [S.kpSel] : []));
		const lines = KP_LINES.filter(([a, b]) => shown(by.get(a)) && shown(by.get(b)))
			.map(([a, b]) => `<line x1="${by.get(a).u}" y1="${by.get(a).v}" x2="${by.get(b).u}" y2="${by.get(b).v}" stroke="#D0D0D0" stroke-width="1.2" vector-effect="non-scaling-stroke"/>`).join('');
		const dots = points.filter(shown).map(p => {
			const sel = selected.has(p.name);
			const colour = sel ? '#7DBDFF' : kpState(p) === 'ok' ? '#5DD15F' : '#E070B4';
			return `<circle cx="${p.u}" cy="${p.v}" r="${sel ? 8 : 6}" fill="none" stroke="${colour}" stroke-width="${sel ? 2.6 : 2}" vector-effect="non-scaling-stroke"><title>${esc(p.label || p.name)}: ${nf(p.score, 2)}</title></circle>`;
		}).join('');
		return `<svg viewBox="0 0 512 512" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${lines}${dots}</svg>`;
	}

	function imageView() {
		const im = S.img;
		const verdict = obj(im.verdict) || {};
		const checks = arr(im.checks).filter(obj);
		const points = arr(im.keypoints).filter(p => obj(p) && p.name);
		const size = arr(im.size);
		const entry = imageEntry(im.path);
		const sub = [esc(im.path), entry ? bytes(entry.bytes) : null, 'aberta só para leitura', num(im.seconds) ? `preparada em ${secs(im.seconds)}` : null].filter(Boolean).join(' · ');
		const top = head('image', esc(basename(im.path)), sub, btn('Outra imagem', 'refresh', 'sm', 'data-act="view" data-view="start"'));

		const original = dataImage(im.original);
		const prepared = dataImage(im.prepared) || dataImage(im.joints);
		const pic = (src, overlay = '') => `<div class="g3-pic">${src ? `<img src="${esc(src)}" alt="">` : ''}${overlay}</div>`;
		const goodCount = points.filter(p => kpState(p) === 'ok').length;
		const pics = `<div class="g3-row g3-grow">${panel('Imagem original', pic(original), { icon: 'image', right: size.length === 2 ? `${px(size[0])} × ${px(size[1])}` : '', pb: 'np pic' })}${panel('Como o gerador vê', pic(prepared, S.points && points.length ? pointsSvg(points) : ''), { icon: 'eye', sub: narrow() ? '' : 'fundo removido · 512 × 512', right: points.length ? btn('Juntas', 'target', `sm ${S.points ? 'on' : ''}`, 'data-act="toggle-points" title="Mostrar os pontos achados"') : '', pb: 'np pic' })}</div>`;

		const okChecks = checks.filter(c => c.ok === true).length;
		const checkItem = c => {
			const icon = c.ok === true ? ic('passed', 'c-ok') : c.ok === false ? ic('alert', 'c-you') : ic('dash', 'c-dim');
			return `<div class="g3-li two" title="${esc(c.detail || '')}">${icon}<span class="tx">${esc(c.label || c.key)}${c.detail ? `<small>${esc(c.detail)}</small>` : ''}</span></div>`;
		};
		const verdictRow = verdict.rig === false
			? `<div class="g3-li two mk-row">${ic('alert', 'c-you')}<span class="tx"><b>Sai sem ossos:</b> ${esc(verdict.reason || 'a imagem não serve para o esqueleto')}<small>o modelo 3D é gravado assim mesmo, sem animações</small></span></div>`
			: '';
		const half = Math.ceil(checks.length / 2);
		const checksBody = `${verdictRow}<div class="g3-row" style="gap:0">${[checks.slice(0, half), checks.slice(half)].map((part, i) => `<div style="${i ? 'border-left:1px solid var(--g3-line)' : ''}">${part.map(checkItem).join('')}</div>`).join('')}</div>`;
		const checksPanel = panel('Verificação da imagem', checksBody, { icon: 'check', right: checks.length ? `${okChecks} de ${checks.length}` : '', pb: 'np fit', cls: 'fit', mk: verdict.rig === false ? 'you' : '' });

		// The points, by body part, with what the score means.
		const groups = keypointGroups(points);
		const pos = p => num(p.u) !== null ? `${nf(Math.round(p.u))}, ${nf(Math.round(p.v))}` : '—';
		const scoreText = pts => { const v = pts.map(p => p.score).filter(s => num(s) !== null); if (!v.length) { return '—'; } const lo = Math.min(...v), hi = Math.max(...v); return nf(lo, 2) === nf(hi, 2) ? nf(lo, 2) : `${nf(lo, 2)} a ${nf(hi, 2)}`; };
		const rows = groups.map(g => {
			const states = g.pts.map(kpState);
			const state = states.includes('out') ? 'out' : states.includes('doubt') ? 'doubt' : 'ok';
			const tag = state === 'ok' ? badge('achado', 'ok') : state === 'doubt' ? badge('duvidoso', 'you') : badge(narrow() ? 'fora' : 'fora da imagem');
			return { c: [esc(g.label), `<span title="${esc(g.pts.map(p => `${p.label || p.name}: ${pos(p)}`).join('; '))}">${g.pts.map(pos).join(' · ')}</span>`, scoreText(g.pts), tag], cls: `${S.kpSel === g.key ? 'sel' : ''} ${state === 'doubt' ? 'mk-you' : ''}`, attrs: `data-act="kp" data-key="${esc(g.key)}"` };
		});
		const pointsPanel = points.length
			? panel('Pontos e notas', table([['Ponto', 76], ['Posição', 0, 'd'], ['Nota', 80, 'r'], ['', narrow() ? 64 : 112]], rows, { cls: 'tight' }), { icon: 'target', right: `${goodCount} de ${points.length}`, pb: 'np', scroll: 'points', cls: 'g3-grow', foot: `<span class="g3-dim">Nota 0,5 ou mais: achado. De 0,3 a 0,5: duvidoso. Abaixo de 0,3, ou fora dos 512 × 512: o ponto não está na imagem.</span>` })
			: panel('Pontos e notas', note('info', 'c-run', 'O detector de pose ainda não olhou esta imagem.'), { icon: 'target', cls: 'g3-grow' });

		// What the next generation will use (the project's settings) and the button that asks for it.
		const s = settings();
		const rig = verdict.rig !== false;
		const target = `${folder()}/${stem(im.path)}.glb`;
		const existing = imageEntry(im.path)?.model || (modelEntry(target) ? target : null);
		const combined = kv([
			['Altura', metres(num(s.height) ?? 1.7)],
			['Ossos', rig ? 'sim, 66' : 'não'],
			['Textura', texText(num(s.texture))],
			['Triângulos', `até ${nf(num(s.faces) ?? 20000)}`],
			['Destino', esc(existing || target), existing || target],
		]);
		const anims = rig ? `<div class="g3-sub">Animações</div><div class="g3-chips" style="padding:0 10px 9px">${defaultAnims().map(a => `<span class="g3-chip" title="${esc(animLabel(a))}">${esc(a)}</span>`).join('') || dim('nenhuma')}</div>` : '';
		const est = estimate(!!num(s.texture));
		const ready = engineReady();
		const foot = `${est ? `<span class="g3-dim full">Nesta máquina leva cerca de ${secs(est)}.${existing ? ' Substitui o modelo que já existe.' : ''}</span>` : existing ? '<span class="g3-dim full">Substitui o modelo que já existe.</span>' : ''}${btn(existing ? 'Gerar de novo' : rig ? 'Gerar o modelo' : 'Gerar só o modelo 3D', 'cube', 'primary wide', `data-act="generate-image" data-path="${esc(im.path)}" ${ready ? '' : 'disabled title="O gerador não está instalado"'}`)}`;
		const combinedPanel = panel('Combinado na conversa', combined + anims, { icon: 'gear', right: btn('Mudar', 'edit', 'sm', 'data-act="view" data-view="settings"'), pb: 'np fit', cls: 'fit', foot });

		return `${top}<div class="g3-cols"><div class="g3-main">${pics}${checksPanel}</div><div class="g3-side w2" data-scroll="image-side">${pointsPanel}${combinedPanel}</div></div>`;
	}

	// ------------------------------------------------------------------ the viewer panel

	function viewerPanel(o = {}) {
		const f = facts();
		const tool = (name, icon, title) => `<button class="g3-tool ${name && S.tools[name] ? 'on' : ''}" ${name ? `data-act="tool" data-tool="${name}"` : 'data-act="frame"'} title="${title}">${ic(icon)}</button>`;
		const tools = `<div class="g3-tools">${tool('', 'frame', 'Enquadrar de novo')}${tool('grid', 'floor', 'Chão')}${f.rigged && S.view !== 'skeleton' ? tool('bones', 'person', 'Ossos por cima do modelo') : ''}${tool('wire', 'wire', 'Malha')}${S.view !== 'skeleton' ? tool('spin', 'spin', 'Girar sozinho') : ''}</div>`;
		const cams = o.cams === false ? '' : `<div class="g3-cams g3-seg">${Object.entries(CAMERAS).map(([id, label]) => `<button class="g3-btn ${S.camera === id ? 'on' : ''}" data-act="camera" data-camera="${id}">${label}</button>`).join('')}</div>`;
		let overlay = '';
		const wait = (icon, cls, title, text, mk = '') => `<div class="g3-wait"><div class="${mk ? `mk mk-${mk}` : ''}">${ic(icon, cls)}<span><b>${title}</b>${text}</span></div></div>`;
		if (V.failed) {
			overlay = wait('warning', 'c-you', 'Sem 3D nesta janela', esc(V.failed), 'you');
		} else if (o.waiting) {
			overlay = wait('spinner', 'spin c-run', o.waiting[0], esc(o.waiting[1]));
		} else if (S.mdl?.tooLarge) {
			overlay = wait('info', 'c-run', 'Modelo grande demais para o Studio', `${esc(S.mdl.path)} tem ${bytes(S.mdl.bytes)}; o Studio mostra modelos de até 30 MB. O arquivo está na pasta do projeto.`);
		} else if (V.error) {
			overlay = wait('warning', 'c-you', 'Não deu para mostrar', esc(V.error), 'you');
		} else if (V.loading) {
			overlay = wait('spinner', 'spin c-run', 'Abrindo o modelo', `${esc(S.mdl?.path || '')} · ${bytes(S.mdl?.bytes)}`);
		} else if (S.mdl && !S.mdl.hasGlb) {
			overlay = wait('info', 'c-run', 'Modelo ainda não chegou', 'O arquivo do modelo não veio junto. Peça para mostrar o modelo de novo.');
		}
		const caption = o.caption ? `<div class="g3-vcap">${o.caption}</div>` : '';
		const body = `<div class="g3-vp" data-viewer="1">${overlay ? '' : tools}${overlay ? '' : caption}${overlay ? '' : cams}${overlay}</div>${o.below || ''}`;
		return panel(o.title || 'Visualização', body, { icon: 'eye', right: o.right || '', pb: 'np pic', cls: 'g3-grow' });
	}

	function emptyModel(text) {
		const sel = selectedImage();
		const acts = `${models().length ? btn('Ver modelos do projeto', 'grid', '', 'data-act="view" data-view="models"') : ''}${imageOpen() ? btn(`Gerar ${esc(basename(S.img.path))}`, 'cube', 'primary', `data-act="generate-image" data-path="${esc(S.img.path)}" ${engineReady() ? '' : 'disabled'}`) : sel ? btn('Escolher uma imagem', 'image', 'primary', 'data-act="view" data-view="start"') : ''}`;
		return `<div class="g3-empty"><div>${ic('cube', 'lg c-dim')}<b>Nenhum modelo aberto</b><span>${text || 'Escolha uma imagem do projeto e peça o modelo 3D na conversa, ou abra um dos modelos já gerados.'}</span><span class="acts">${acts}</span></div></div>`;
	}

	// ------------------------------------------------------------------ model: the viewer, summary and timings

	function stepsPanel(j) {
		const steps = arr(j.steps).filter(obj);
		const running = j.state === 'running';
		const rows = steps.map(step => {
			const icon = step.state === 'done' ? ic('passed', 'c-ok') : step.state === 'running' ? (running ? ic('spinner', 'spin c-run') : j.state === 'failed' ? ic('failed', 'c-bad') : ic('stop', 'c-dim')) : step.state === 'skipped' ? ic('dash', 'c-dim') : ic('ring', 'c-dim');
			const label = step.label || STEP_LABELS[step.key] || step.key;
			const right = step.state === 'skipped' ? 'pulada' : num(step.seconds) !== null ? secs(step.seconds) : '';
			return li(icon, esc(label), right, step.state === 'waiting' || step.state === 'skipped' ? 'dim' : '');
		}).join('');
		const active = steps.filter(s => s.state !== 'skipped');
		const doneCount = active.filter(s => s.state === 'done').length;
		const runningIndex = active.findIndex(s => s.state === 'running');
		// In a queue the job's time covers the images already made; this image started when the last one ended.
		const before = j.total > 1 ? arr(j.results).reduce((a, r) => a + (num(obj(r)?.seconds) || 0), 0) : 0;
		const elapsed = Math.max(0, elapsedNow() - before);
		const totalWeight = active.reduce((a, s) => a + (STEP_WEIGHT[s.key] || 0.5), 0) || 1;
		const doneWeight = active.filter(s => s.state === 'done').reduce((a, s) => a + (STEP_WEIGHT[s.key] || 0.5), 0);
		const doneSeconds = active.filter(s => s.state === 'done').reduce((a, s) => a + (num(s.seconds) || 0), 0);
		const runStep = active[runningIndex];
		const runWeight = runStep ? (STEP_WEIGHT[runStep.key] || 0.5) : 0;
		const share = !running ? (j.state === 'done' ? 1 : doneWeight / totalWeight) : (doneWeight + Math.min(runWeight * 0.95, Math.max(0, elapsed - doneSeconds))) / totalWeight;
		// In a queue the images after the first take about the mean of the ones already made (the engine stays loaded).
		const est = (j.total > 1 ? queueMean(j) : null) ?? estimate(steps.some(s => s.key === 'texture' && s.state !== 'skipped'));
		const left = running ? `<span data-tick="elapsed" data-minus="${before}">${secs(elapsed)}</span>${est ? ` de cerca de ${secs(est)}` : ''}` : j.state === 'done' ? `pronto em ${secs(num(j.elapsed))}` : j.state === 'failed' ? 'falhou' : 'parado';
		const stepText = running && runningIndex >= 0 ? `etapa ${nf(runningIndex + 1)} de ${nf(active.length)}` : `${nf(doneCount)} de ${nf(active.length)} etapas`;
		const bar = `<div class="g3-bar-pr"><i data-tick="share" style="width:${(clamp(share, 0, 1) * 100).toFixed(1)}%"></i></div><div class="g3-prtext"><span>${left}</span><span>${stepText}</span></div>`;
		const title = j.total > 1 ? `Etapas de ${esc(basename(j.current))}` : 'Etapas';
		const foot = running ? `<span class="g3-dim">Dá para continuar conversando. Parar descarta esta geração; a imagem não muda.</span>${btn('Parar', ['stop', 'c-bad'], 'sm', 'data-act="stop"')}` : '';
		return panel(title, rows + bar, { icon: 'list', pb: 'np fit', cls: 'fit', foot });
	}

	function queuePanel(j) {
		const results = arr(j.results).filter(obj);
		const list = arr(j.images).map(String);
		const rows = list.map((path, i) => {
			const r = results.find(x => x.image === path);
			const thumb = dataImage(imageEntry(path)?.thumb);
			const entry = r?.model ? modelEntry(r.model) : null;
			let result;
			if (r?.state === 'done') {
				const clips = entry ? arr(entry.clips).length : null;
				result = r.message ? `${ic('alert', 'c-you')} com ossos · aviso: ${esc(r.message)}` : `${ic('passed', 'c-ok')} com ossos${clips !== null ? ` · ${plural(clips, 'animação', 'animações')}` : ''}`;
			} else if (r?.state === 'static') {
				result = `${ic('passed', 'c-dim')} sem ossos: ${esc(entry ? staticKind(entry) : r.message || 'sem esqueleto')}`;
			} else if (r?.state === 'failed') {
				result = `${ic('failed', 'c-bad')} ${esc(r.message || 'falhou')}`;
			} else if (j.state === 'running' && i === j.index) {
				const step = arr(j.steps).find(s => s.state === 'running');
				result = `${ic('spinner', 'spin c-run')} ${step ? `etapa: ${esc(step.label || STEP_LABELS[step.key] || step.key)}` : 'gerando'}…`;
			} else {
				result = `${ic('ring', 'c-dim')} ${j.state === 'running' ? 'na fila' : 'não feita'}`;
			}
			const cells = [`<span class="g3-qimg"><span class="th">${thumb ? `<img src="${esc(thumb)}" alt="">` : ic('image', 'c-dim')}</span><span class="tx">${esc(basename(path))}</span></span>`, `<span class="g3-qres">${result}</span>`, r ? secs(r.seconds) : ''];
			if (!narrow()) { cells.push(r?.model ? esc(r.model) : ''); }
			return { c: cells, cls: r?.state === 'failed' ? 'mk-bad' : r?.message && r.state === 'done' ? 'mk-you' : '' };
		});
		const done = results.length;
		const cols = [['Imagem', narrow() ? 150 : 180], ['Resultado', 0], ['Tempo', 62, 'r']];
		if (!narrow()) { cols.push(['Arquivo', 190, 'd']); }
		const tableHtml = table(cols, rows, { cls: 'tall' });
		const elapsed = elapsedNow();
		const foot = `<span class="g3-dim">${nf(done)} de ${nf(list.length)} prontas · <span data-tick="elapsed">${secs(elapsed)}</span> até agora</span>`;
		return panel('Imagens', tableHtml, { icon: 'list', sub: `${plural(list.length, 'imagem', 'imagens')} uma depois da outra`, pb: 'np', scroll: 'queue', cls: 'g3-grow', foot });
	}

	/** The image being made, as the generator sees it, while its model is not there yet. */
	function sourcePanel(j) {
		const entry = imageEntry(j.current);
		const src = S.img?.path === j.current ? dataImage(S.img.prepared) || dataImage(S.img.original) : dataImage(entry?.thumb);
		if (!src) { return ''; }
		return panel('Imagem', `<div class="g3-pic"><img src="${esc(src)}" alt=""></div>`, { icon: 'image', sub: esc(basename(j.current)), pb: 'np pic', cls: 'g3-grow', style: 'min-height:140px' });
	}

	/** Mean seconds of the queue's images after the first (which also loads the engine), or null before any is done. */
	function queueMean(j) {
		const times = arr(j.results).map(r => num(obj(r)?.seconds)).filter(v => v !== null);
		const later = times.length > 1 ? times.slice(1) : times;
		return later.length ? later.reduce((a, b) => a + b, 0) / later.length : null;
	}

	/** What the queue made so far and about how long the rest takes. */
	function queueSummary(j) {
		const results = arr(j.results).filter(obj);
		const count = state => results.filter(r => r.state === state).length;
		const mean = queueMean(j);
		const left = Math.max(0, (num(j.total) || 0) - results.length);
		const rows = [
			['Com ossos', nf(count('done'))],
			['Sem ossos', nf(count('static'))],
			['Com aviso', nf(results.filter(r => r.state === 'done' && r.message).length)],
			count('failed') ? ['Falharam', nf(count('failed'))] : null,
			['Tempo médio depois da 1ª', mean !== null ? secs(mean) : '—'],
			['Falta cerca de', mean !== null && left ? secs(mean * left) : '—'],
		];
		return panel('Resumo da fila', kv(rows), { icon: 'list', pb: 'np fit', cls: 'fit' });
	}

	function summaryPanel(f) {
		const rows = [
			['Vértices', nf(f.vertices)], ['Triângulos', nf(f.faces)],
			['Ossos', f.rigged ? nf(f.bones) : 'nenhum'], ['Animações', f.clips.length ? nf(f.clips.length) : 'nenhuma'],
			['Textura', texText(f.texture)], ['Altura', metres(f.height)], ['Arquivo', bytes(f.bytes)],
		];
		return panel(f.rigged === false ? 'Modelo gravado' : 'Resumo', kv(rows), { icon: 'list', pb: 'np fit', cls: 'fit' });
	}

	function timingsPanel(f) {
		const steps = timingSteps(f.timings);
		if (!steps.length) {
			return f.external ? panel('Origem', note('info', 'c-run', 'Este modelo foi feito fora do 3D Generator: não há tempos de geração nem imagem de origem.'), { icon: 'clock', pb: 'np fit', cls: 'fit' }) : '';
		}
		const label = key => key === 'texture' && f.texture ? `Textura ${px(f.texture)}` : key === 'simplify' && f.faces ? `Simplificar para ${nf(f.faces)} triângulos` : STEP_LABELS[key];
		const rows = steps.map(s => li(ic('check', 'c-ok'), esc(label(s.key)), secs(s.seconds))).join('');
		const provider = Object.values(f.devices || {}).map(String);
		const device = provider.length ? PROVIDER_LABELS[provider.includes('dml') ? 'dml' : provider.includes('cuda') ? 'cuda' : 'cpu'] : null;
		const total = `<div class="g3-li" style="font-weight:700;border-bottom:0"><span class="tx">Total, com gravação</span><em style="color:inherit">${secs(f.seconds)}</em></div>`;
		return panel('Como foi gerado', rows + total, { icon: 'clock', right: device ? esc(narrow() ? device.replace(/ \(.*\)$/, '') : device) : '', pb: 'np fit', cls: 'fit' });
	}

	function warningsPanel(f) {
		if (!f.warnings.length) { return ''; }
		const rows = f.warnings.map(w => `<div class="g3-li two">${ic('alert', 'c-you')}<span class="tx">${esc(cap(w))}</span></div>`).join('');
		return panel(f.warnings.length === 1 ? 'Aviso' : 'Avisos', rows, { icon: 'warning', mk: 'you', pb: 'np fit', cls: 'fit', right: btn('Perguntar ao agente', 'comments', 'sm', 'data-act="ask-warning" title="Escreve a pergunta na caixa da conversa"') });
	}

	function staticPanels(f) {
		const notFull = f.reasonKind === 'NotFullBodyError';
		const text = notFull
			? '<p class="g3-p">Uma imagem do personagem de corpo inteiro, de frente, com as mãos afastadas das coxas.</p><p class="g3-p dim">Não invento pernas que a imagem não mostra: o resultado seria um corpo que ninguém desenhou.</p>'
			: '<p class="g3-p">O esqueleto e as animações daqui são de corpo humano. Este modelo serve parado, como cenário, ou movido inteiro pelo código do jogo.</p><p class="g3-p dim">Animais e objetos com ossos ficam para uma próxima versão do gerador.</p>';
		return panel(notFull ? 'Para ter ossos' : 'Usar no jogo', `<div style="padding:9px 10px">${text}</div>`, { icon: notFull ? 'person' : 'cube', pb: 'np fit', cls: 'fit', foot: btn('Escolher outra imagem', 'image', 'wide', 'data-act="view" data-view="start"') });
	}

	function modelView() {
		const j = job();
		const running = jobRunning();
		const failed = j && (j.state === 'failed' || j.state === 'cancelled') && (!S.mdl || jobTarget() !== S.mdl.path);
		if (!S.mdl && !running && !failed) { return emptyModel(); }
		const f = facts();
		const target = jobTarget();
		const regen = running && S.mdl && target === S.mdl.path;
		let top;
		if (running && (!regen || j.total > 1)) {
			const steps = arr(j.steps);
			const active = steps.filter(s => s.state !== 'skipped');
			const k = active.findIndex(s => s.state === 'running');
			const step = active[k];
			const queue = j.total > 1 ? ` · imagem ${nf(j.index + 1)} de ${nf(j.total)}` : '';
			const dirs = [...new Set(arr(j.images).map(p => dirname(String(p))))];
			top = j.total > 1
				? head('list', 'Fila', `${plural(j.total, 'imagem', 'imagens')}${dirs.length === 1 && dirs[0] ? ` de ${esc(dirs[0])}/` : ''} · ${num(settings().texture) ? 'com textura' : 'sem textura'} · gravando em ${esc(folder())}/`)
				: head('cube', esc(cap(stem(j.current))), `de ${esc(j.current)}${queue}${step ? ` · etapa ${nf(k + 1)} de ${nf(active.length)} · ${esc(step.label || STEP_LABELS[step.key] || '')}` : ''}`);
		} else if (failed && !running) {
			top = head(j.state === 'failed' ? ['failed', 'c-bad'] : 'stop', j.state === 'failed' ? 'A geração falhou' : 'Geração parada', esc(j.message || (j.state === 'failed' ? 'o gerador parou com um erro' : 'parada antes de terminar; nenhum arquivo foi trocado')), j.current ? btn('Tentar de novo', 'refresh', 'sm', `data-act="generate-image" data-path="${esc(j.current)}"`) : '', j.state === 'failed' ? 'bad' : 'off');
		} else if (f.rigged === false) {
			top = head(['info', 'c-you'], 'Sem esqueleto', `${esc(f.reason || 'o modelo não tem ossos')} · o modelo 3D foi gravado assim mesmo`, '', 'you');
		} else {
			const parts = [f.source ? `de ${esc(f.source)}` : f.external ? 'feito fora do 3D Generator' : null, `gravado em ${esc(f.path)}`, f.created ? `gerado ${when(f.created)}` : null].filter(Boolean);
			const right = f.source && !regen ? btn('Gerar de novo', 'refresh', 'sm', 'data-act="regen"') : '';
			top = head('cube', esc(cap(f.name)), regen ? `gerando de novo · o modelo atual continua aqui até terminar` : parts.join(' · '), right, regen ? 'run' : f.warnings.length ? 'you' : '');
		}

		if (running && j.total > 1) {
			return `${top}<div class="g3-cols"><div class="g3-main">${queuePanel(j)}</div><div class="g3-side" data-scroll="model-side">${stepsPanel(j)}${queueSummary(j)}</div></div>`;
		}
		const waiting = running && !regen ? ['Gerando o modelo', 'Ele aparece aqui ao terminar. As etapas e os tempos ficam à direita; dá para continuar conversando.'] : null;
		let caption = '';
		if (!running && f.rigged !== false && !failed) { caption = `<span class="g3-cap">Pose da imagem · arraste para girar, role para aproximar</span>`; }
		if (f.rigged === false) { caption = `<span class="g3-cap">Modelo parado, sem ossos · arraste para girar</span>`; }
		const right = running ? (regen ? 'a versão nova aparece ao terminar' : 'o modelo aparece ao terminar') : f.clips.length ? btn('Ver animação', 'play', 'sm', 'data-act="view" data-view="animations"') : '';
		const viewer = failed && !S.mdl
			? panel('Visualização', `<div class="g3-empty"><div class="mk mk-bad">${ic('failed', 'lg c-bad')}<b>Nenhum modelo foi gravado</b><span>${esc(j.message || 'A geração parou antes do fim.')} A imagem original não mudou.</span></div></div>`, { icon: 'eye', pb: 'np pic', cls: 'g3-grow' })
			: viewerPanel({ caption, right, waiting });
		let side;
		if (running) {
			side = stepsPanel(j) + (regen ? summaryPanel(f) : sourcePanel(j));
		} else if (failed) {
			side = stepsPanel(j) + panel('O que fazer', `<div style="padding:9px 10px"><p class="g3-p">Peça na conversa para tentar de novo. Se a placa de vídeo ficar sem memória, o processador também serve, só que mais devagar.</p></div>`, { icon: 'info', pb: 'np fit', cls: 'fit' });
		} else if (f.rigged === false) {
			side = summaryPanel(f) + staticPanels(f) + timingsPanel(f);
		} else {
			side = summaryPanel(f) + warningsPanel(f) + timingsPanel(f);
		}
		return `${top}<div class="g3-cols"><div class="g3-main">${viewer}</div><div class="g3-side" data-scroll="model-side">${side}</div></div>`;
	}

	// ------------------------------------------------------------------ skeleton: bones, measures and weights

	function skeletonView() {
		if (!S.mdl) { return emptyModel(); }
		const f = facts();
		if (f.rigged === false) {
			const top = head(['info', 'c-you'], 'Sem esqueleto', `${esc(f.reason || 'este modelo não tem ossos')} · o modelo 3D foi gravado assim mesmo`, '', 'you');
			return `${top}<div class="g3-cols"><div class="g3-main">${viewerPanel({ caption: '<span class="g3-cap">Modelo parado, sem ossos</span>' })}</div><div class="g3-side">${summaryPanel(f)}${staticPanels(f)}</div></div>`;
		}
		const seg = `<span class="g3-seg">${btn('Ossos', 'person', `sm ${S.skelMode === 'bones' ? 'on' : ''}`, 'data-act="skel-mode" data-mode="bones"')}${btn('Pesos', 'brush', `sm ${S.skelMode === 'weights' ? 'on' : ''}`, 'data-act="skel-mode" data-mode="weights"')}</span>`;
		if (!V.ready) {
			const top = head('person', 'Esqueleto', f.rigged ? `${nf(66)} ossos · esqueleto humano do Mesh2Motion` : 'abrindo o modelo', seg);
			return `${top}<div class="g3-cols"><div class="g3-main">${viewerPanel({})}</div><div class="g3-side">${panel('Ossos', note('spinner', 'spin c-run', 'Abrindo o modelo…'), { icon: 'person', pb: 'np fit', cls: 'fit' })}</div></div>`;
		}
		if (S.skelMode === 'weights') {
			if (!V.bones.has(S.bone)) { S.bone = V.bones.has('upperarm_l') ? 'upperarm_l' : V.skeleton.bones[0].name; }
			paintWeights(S.bone);
			const top = head('brush', 'Pesos', `${esc(S.bone)} · ${esc(boneLabel(S.bone))} · cada vértice segue até 4 ossos`, seg);
			const rows = boneRows().map(r => r.fingers
				? `<div class="g3-li click" data-act="fingers" style="padding-left:${10 + r.depth * 12}px">${ic('chevR', 'sm')}<span class="tx">dedos (${nf(r.fingers)})</span></div>`
				: `<div class="g3-li click ${S.bone === r.name ? 'sel' : ''}" data-act="bone" data-bone="${esc(r.name)}" style="padding-left:${10 + r.depth * 12}px" title="${esc(boneLabel(r.name))}">${ic('person', 'sm')}<span class="tx">${esc(r.name)}</span></div>`).join('');
			const bonesPanel = panel('Ossos', rows, { icon: 'person', right: S.fingers ? btn('Esconder dedos', '', 'sm', 'data-act="fingers"') : '', pb: 'np g3-bones', scroll: 'bones', cls: 'g3-grow' });
			const w = V.weightStats || { follows: 0, whole: 0, partial: 0, shared: [] };
			const info = kv([['Vértices que segue', nf(w.follows)], ['Quase por inteiro', nf(w.whole)], ['Em parte', nf(w.partial)],
				['Divide com', w.shared.length ? esc(boneLabel(w.shared[0])) : 'nenhum osso', w.shared[0]], w.shared[1] ? ['e com', esc(boneLabel(w.shared[1])), w.shared[1]] : null]);
			const infoPanel = panel(esc(S.bone), info, { icon: 'info', sub: narrow() ? '' : esc(boneLabel(S.bone)), pb: 'np fit', cls: 'fit', foot: `<span class="g3-dim">${w.follows ? '' : FINGER.test(S.bone) ? 'Nenhuma parte do modelo segue este osso: as mãos saem fechadas, então os dedos não movem nada. ' : 'Nenhuma parte do modelo segue este osso. '}Os pesos não são editados aqui. Para mudar, peça para gerar de novo com outra imagem ou opção.</span>` });
			const caption = `<span class="g3-legend">nada <span class="ramp">${WEIGHT_STEPS.map(c => `<i style="background:${c}"></i>`).join('')}</span> move por inteiro</span>`;
			return `${top}<div class="g3-cols"><div class="g3-main">${viewerPanel({ caption, right: 'clique no modelo para escolher o osso' })}</div><div class="g3-side" data-scroll="skel-side">${infoPanel}${bonesPanel}</div></div>`;
		}
		const top = head('person', 'Esqueleto', `${plural(V.info.bones, 'osso', 'ossos')} · esqueleto humano do Mesh2Motion (CC0) com as medidas ${f.name ? `de ${esc(f.name)}` : 'do personagem'}`, seg);
		const parts = boneParts();
		const partsTable = table([['Parte', narrow() ? 104 : 124], ['Ossos', 0, 'd'], ['Quantos', 72, 'r']], parts.map(([label, text, count]) => [esc(label), `<span title="${esc(text)}">${esc(text)}</span>`, nf(count)]).concat([{ c: ['Total', '', nf(V.info.bones)], cls: 'tot' }]));
		const m = V.info.measures;
		const measureRows = [['Altura', metres(V.info.height)], ['Ombro a ombro', metres(m.shoulders)], ['Braço', metres(m.arm)], ['Perna', metres(m.leg)], ['Tronco', metres(m.torso)], ['Cabeça', metres(m.head)], ['Quadril', metres(m.hips)], ['Pé', metres(m.foot)]];
		const two = window.innerWidth >= 1250;
		const measuresHtml = two
			? `<div class="g3-kv two">${measureRows.reduce((out, row, i) => (i % 2 ? out[out.length - 1].push(row) : out.push([row]), out), []).map((pair, i, all) => pair.map(([k, v]) => `<span class="${i === all.length - 1 ? 'last' : ''}">${k}</span><span class="${i === all.length - 1 ? 'last' : ''}">${v}</span>`).join('')).join('')}</div>`
			: kv(measureRows);
		const measuresPanel = panel(`Medidas ${f.name ? `de ${esc(f.name)}` : ''}`, measuresHtml, { icon: 'ruler', pb: 'np fit', cls: 'fit', foot: '<span class="g3-dim">Tiradas da pose da imagem. As animações usam essas medidas e não esticam o corpo.</span>' });
		const compat = window.innerHeight >= 800
			? panel('Compatível com', `<div class="g3-li two"><span class="tx">Nomes dos ossos<small>os do manequim da Unreal: pelvis, spine_01, upperarm_l…</small></span></div><div class="g3-li two"><span class="tx">Arquivo<small>GLB com pele e ossos: three.js, Godot, Unity, Blender</small></span></div>`, { icon: 'layers', pb: 'np fit', cls: 'fit' })
			: '';
		const caption = '<span class="g3-cap">Pose da imagem · ossos por cima do modelo · clique num ponto</span>';
		return `${top}<div class="g3-cols"><div class="g3-main">${viewerPanel({ caption })}</div><div class="g3-side" data-scroll="skel-side">${panel('Ossos por parte do corpo', partsTable, { icon: 'list', pb: 'np fit', cls: 'fit' })}${measuresPanel}${compat}</div></div>`;
	}

	// ------------------------------------------------------------------ animations

	function playerHtml(clip) {
		const duration = clip.duration || 0;
		const ticks = [0, 0.25, 0.5, 0.75, 1].map(k => `<span>${nf(duration * k, 2)} s</span>`).join('');
		return `<div class="g3-player"><div class="ctl">${btn('', S.playing ? 'pause' : 'play', 'ib', `data-act="play" title="${S.playing ? 'Pausar' : 'Tocar'}"`)}${btn('', 'loop', `ib ${S.loop ? 'on' : ''}`, 'data-act="loop" title="Repetir"')}<span class="g3-time" id="g3-time">0,00 / ${nf(duration, 2)} s</span><em id="g3-frame"></em></div><div class="g3-scrub"><input class="g3-range" id="g3-scrub" type="range" min="0" max="${duration}" step="0.001" value="0" aria-label="Tempo da animação"></div><div class="g3-ticks">${ticks}</div></div>`;
	}

	/** Keeps the time, the frame and the slider in step with the animation, without drawing the whole Studio again. */
	function updatePlayer() {
		if (S.view !== 'animations' || !V.action) { return; }
		const clip = V.action.getClip();
		const time = V.action.time % (clip.duration || 1);
		const fps = clipFps(clip);
		const timeEl = document.getElementById('g3-time');
		if (timeEl) { timeEl.textContent = `${nf(time, 2)} / ${nf(clip.duration, 2)} s`; }
		const frameEl = document.getElementById('g3-frame');
		if (frameEl) { frameEl.textContent = `quadro ${nf(Math.min(Math.round(clip.duration * fps), Math.floor(time * fps)) + 1)} de ${nf(Math.round(clip.duration * fps) + 1)}`; }
		const scrub = document.getElementById('g3-scrub');
		if (scrub && document.activeElement !== scrub) { scrub.value = String(time); }
		scrub?.parentElement.style.setProperty('--at', `${(time / (clip.duration || 1) * 100).toFixed(2)}%`);
	}

	function animationsView() {
		if (!S.mdl) { return emptyModel(); }
		const f = facts();
		if (f.rigged === false) {
			const top = head(['info', 'c-you'], 'Sem animações', `${esc(f.reason || 'o modelo não tem esqueleto')} · animações precisam de ossos`, '', 'you');
			return `${top}<div class="g3-cols"><div class="g3-main">${viewerPanel({ caption: '<span class="g3-cap">Modelo parado, sem ossos</span>' })}</div><div class="g3-side">${staticPanels(f)}</div></div>`;
		}
		const clips = V.ready ? V.info.clips : f.clips.map(name => ({ name, duration: null, fps: 30 }));
		const clip = clips.find(c => c.name === S.anim) || clips[0] || null;
		const lib = library();
		const inFile = clips.map(c => c.name);
		const draft = S.animDraft || new Set(inFile);
		const ordered = inFile.concat(lib.map(a => a.id).filter(id => !inFile.includes(id)));
		const rows = ordered.map(id => {
			const c = clips.find(x => x.name === id);
			const checked = draft.has(id);
			const added = checked && !c, removed = !checked && !!c;
			const idHtml = added ? ins(esc(id)) : removed ? del(esc(id)) : esc(id);
			const sel = clip && c && clip.name === id;
			return `<div class="g3-li click ${sel ? 'sel' : ''} ${c ? '' : 'out'}" data-act="${c ? 'clip' : 'anim-row'}" data-name="${esc(id)}" title="${c ? 'Tocar no Studio' : 'Marcar para gerar de novo com esta animação'}"><input class="g3-check" type="checkbox" data-act="anim-toggle" data-name="${esc(id)}" ${checked ? 'checked' : ''} aria-label="${esc(id)}"><span class="id">${idHtml}</span><span class="lb">${esc(animLabel(id))}</span>${c && num(c.duration) ? `<em>${nf(c.duration, 2)} s</em>` : ''}</div>`;
		}).join('');
		const added = [...draft].filter(id => !inFile.includes(id));
		const removed = inFile.filter(id => !draft.has(id));
		const changed = added.length || removed.length;
		const foot = changed
			? `<span class="g3-dim">${[added.length ? `${ins(esc(added.join(', ')))}` : '', removed.length ? `${del(esc(removed.join(', ')))}` : ''].filter(Boolean).join(' · ')}</span>${btn('Desfazer', 'close', 'sm', 'data-act="anim-undo"')}${btn('Gerar de novo com estas', 'refresh', 'sm primary', `data-act="anim-regen" ${f.source && engineReady() ? '' : 'disabled title="Este modelo não tem imagem de origem"'}`)}`
			: `<span class="g3-dim">${plural(inFile.length, 'no arquivo', 'no arquivo')} · ${nf(lib.length)} no total · marque outras para gerar de novo</span>`;
		const listPanel = panel('Animações', rows, { icon: 'film', right: `${nf(inFile.length)} no arquivo`, pb: 'np g3-alist', scroll: 'anims', cls: 'g3-grow', foot });
		if (!clip) {
			const top = head('film', 'Nenhuma animação no arquivo', `${esc(f.path)} tem ossos, mas nenhuma animação · marque as que quiser e peça para gerar de novo`);
			return `${top}<div class="g3-cols"><div class="g3-main">${viewerPanel({ caption: '<span class="g3-cap">Pose da imagem</span>' })}</div><div class="g3-side">${listPanel}</div></div>`;
		}
		const label = animLabel(clip.name);
		const top = head('film', `${esc(clip.name)}${label ? ` · ${esc(label)}` : ''}`, [num(clip.duration) ? `${nf(clip.duration, 2)} s` : null, S.loop ? 'repetindo' : 'uma vez', `${nf(clip.fps || 30)} quadros por segundo`, 'copiada do Mesh2Motion (CC0)'].filter(Boolean).join(' · '));
		const speed = `<label class="g3-dim" style="display:inline-flex;gap:5px;align-items:center">velocidade <select class="g3-select" data-act="speed">${[0.25, 0.5, 1, 1.5, 2].map(v => `<option value="${v}" ${S.speed === v ? 'selected' : ''}>${nf(v, v % 1 ? (v * 100 % 10 ? 2 : 1) : 0)}×</option>`).join('')}</select></label>`;
		return `${top}<div class="g3-cols"><div class="g3-main">${viewerPanel({ right: speed, below: V.ready ? playerHtml(clip) : '' })}</div><div class="g3-side" data-scroll="anim-side">${listPanel}</div></div>`;
	}

	// ------------------------------------------------------------------ models: the project's gallery

	function modelsView() {
		const list = models().slice().sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')));
		const total = list.reduce((a, m) => a + (num(m.bytes) || 0), 0);
		const seg = `<span class="g3-seg">${btn('Grade', 'grid', `sm ${S.gallery === 'grid' ? 'on' : ''}`, 'data-act="gallery" data-mode="grid"')}${btn('Lista', 'list', `sm ${S.gallery === 'list' ? 'on' : ''}`, 'data-act="gallery" data-mode="list"')}</span>`;
		const top = head('history', 'Modelos do projeto', `${nf(list.length)} em ${esc(folder())}/ · ${bytes(total)} · cada um lembra a imagem e as opções usadas`, seg);
		if (!list.length) {
			return `${top}<div class="g3-empty"><div>${ic('grid', 'lg c-dim')}<b>Nenhum modelo gerado ainda</b><span>Os modelos que o 3D Generator gravar em ${esc(folder())}/ aparecem aqui, com a imagem de origem e o tempo de cada um.</span><span class="acts">${btn('Ver imagens do projeto', 'image', 'primary', 'data-act="view" data-view="start"')}</span></div></div>`;
		}
		const sel = list.find(m => m.path === S.modelSel) || list.find(m => m.path === S.mdl?.path) || list[0];
		const tag = m => m.missing ? badge('não encontrado', 'bad') : m.rigged === true ? badge('com ossos', 'ok') : m.rigged === false ? badge('sem ossos') : badge('de fora');
		const line2 = m => esc(m.rigged === true ? `${plural(arr(m.clips).length, 'animação', 'animações')} · ${num(m.texture) ? 'textura' : 'sem textura'}` : m.rigged === false ? staticKind(m) : 'feito fora do 3D Generator');
		const thumbOf = m => dataImage(m.thumb) || dataImage(imageEntry(m.source)?.thumb);
		let body;
		if (S.gallery === 'list') {
			const rows = list.map(m => ({ c: [`<b>${esc(basename(m.path))}</b>`, tag(m), esc(m.rigged === true ? nf(arr(m.clips).length) : '—'), bytes(m.bytes), when(m.created)], cls: m.path === sel.path ? 'sel' : '', attrs: `data-act="pick-model" data-path="${esc(m.path)}"` }));
			body = table([['Modelo', 0], ['Esqueleto', 104], ['Animações', 80, 'r'], ['Tamanho', 80, 'r'], ['Gerado', narrow() ? 124 : 136, 'r']], rows);
		} else {
			body = `<div class="g3-gallery">${list.map(m => {
				const thumb = thumbOf(m);
				return `<div class="g3-card ${m.path === sel.path ? 'sel' : ''}" data-act="pick-model" data-path="${esc(m.path)}" title="${esc(m.path)}"><div class="th">${thumb ? `<img src="${esc(thumb)}" alt="">` : ic('cube')}</div><div class="tx1"><b>${esc(basename(m.path))}</b>${arr(m.warnings).length ? `<span title="${plural(arr(m.warnings).length, 'aviso', 'avisos')}">${ic('alert', 'c-you')}</span>` : ''}${tag(m)}</div><div class="tx2">${line2(m)}</div><div class="tx3">${when(m.created)} · ${bytes(m.bytes)}</div></div>`;
			}).join('')}</div>`;
		}
		const gallery = panel('Modelos', body, { icon: 'grid', right: 'mais novos primeiro', pb: 'np', scroll: 'gallery', cls: 'g3-grow' });

		const source = sel.source ? imageEntry(sel.source) : null;
		const thumbs = `<div class="g3-thumbs">${dataImage(source?.thumb) ? `<div class="light" title="${esc(sel.source)}"><img src="${esc(source.thumb)}" alt=""></div>` : ''}${dataImage(sel.thumb) ? `<div title="${esc(sel.path)}"><img src="${esc(sel.thumb)}" alt=""></div>` : ''}</div>`;
		const hasThumbs = dataImage(source?.thumb) || dataImage(sel.thumb);
		const rows = [
			['Imagem', sel.source ? esc(sel.source) : 'feito fora', sel.source],
			['Gerado', sel.created ? when(sel.created) : '—'],
			['Esqueleto', sel.rigged === true ? `${nf(66)} ossos` : sel.rigged === false ? esc(staticKind(sel)) : 'não verificado'],
			['Textura', texText(num(sel.texture))],
			['Triângulos', nf(sel.faces)],
			['Animações', sel.rigged === true ? nf(arr(sel.clips).length) : 'nenhuma'],
			['Tempo', secs(sel.seconds)],
			['Avisos', arr(sel.warnings).length ? nf(arr(sel.warnings).length) : 'nenhum'],
		];
		const warnings = arr(sel.warnings).map(w => `<div class="g3-li two">${ic('alert', 'c-you')}<span class="tx">${esc(cap(typeof w === 'string' ? w : obj(w)?.text || ''))}</span></div>`).join('');
		const loaded = S.mdl?.path === sel.path;
		const foot = `${btn(loaded ? 'Ver no Studio' : 'Mostrar', 'eye', 'wide primary', `data-act="show-model" data-path="${esc(sel.path)}" ${sel.missing ? 'disabled' : ''}`)}${sel.source ? btn('Gerar de novo', 'refresh', 'wide', `data-act="regen" data-path="${esc(sel.path)}" ${engineReady() ? '' : 'disabled'}`) : ''}`;
		const detail = panel(esc(basename(sel.path)), (hasThumbs ? thumbs : '') + kv(rows) + warnings, { icon: 'info', pb: 'np', cls: 'g3-grow', mk: sel.missing ? 'bad' : arr(sel.warnings).length ? 'you' : '', foot });
		return `${top}<div class="g3-cols"><div class="g3-main">${gallery}</div><div class="g3-side" data-scroll="models-side">${detail}</div></div>`;
	}

	// ------------------------------------------------------------------ settings

	const SETTING_TEXT = {
		texture: v => num(v) ? `textura ${px(v)}` : 'cores nos vértices',
		faces: v => nf(v),
		height: v => metres(v),
		device: v => DEVICE_LABELS[v] || String(v),
	};
	const SETTING_ASK = {
		texture: v => `o padrão de textura para ${num(v) ? String(v) : '0 (cores nos vértices)'}`,
		faces: v => `o padrão de triângulos para ${nf(v)}`,
		height: v => `a altura padrão para ${metres(v)}`,
		device: v => `o dispositivo para ${DEVICE_LABELS[v] || v} (${v})`,
	};

	function settingsView() {
		const s = settings();
		const d = S.setDraft;
		const value = key => key in d ? d[key] : s[key];
		const select = (key, options) => {
			const current = s[key];
			const list = options.some(([v]) => String(v) === String(current)) || current === undefined || current === null ? options : options.concat([[current, SETTING_TEXT[key](current)]]);
			return `<select data-set="${key}" class="${key in d ? 'chg' : ''}">${list.map(([v, label]) => `<option value="${esc(v)}" ${String(v) === String(value(key)) ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
		};
		const row = (key, label, sub, options) => `<div class="g3-set"><span class="lb">${label}<small>${sub}</small></span>${key in d ? `<span class="was">${esc(SETTING_TEXT[key](s[key]))}</span>` : ''}${select(key, options)}</div>`;
		const quality = [
			row('texture', 'Cores', 'textura copia as cores da imagem; cores nos vértices é mais rápido', TEXTURES),
			row('faces', 'Triângulos', 'depois de simplificar a malha', FACES.map(v => [v, nf(v)])),
			row('height', 'Altura padrão', 'escala do arquivo, em metros', HEIGHTS.map(v => [v, metres(v)])),
			row('device', 'Dispositivo', 'placa de vídeo, ou processador se ela falhar', DEVICES),
		].join('');
		const qualityPanel = panel('Qualidade', quality, { icon: 'cube', pb: 'np fit', cls: 'fit' });

		const current = defaultAnims();
		const draft = S.animSetDraft || new Set(current);
		const checks = library().map(a => {
			const on = draft.has(a.id);
			const was = current.includes(a.id);
			const name = on && !was ? ins(esc(a.id)) : !on && was ? del(esc(a.id)) : esc(a.id);
			return `<label title="${esc(a.label)}"><input class="g3-check" type="checkbox" data-act="set-anim" data-name="${esc(a.id)}" ${on ? 'checked' : ''}><span class="t">${name} <em>${esc(a.label)}</em></span></label>`;
		}).join('');
		const animsPanel = panel('Animações padrão', `<div class="g3-anims">${checks}</div>`, { icon: 'film', right: `${nf(draft.size)} de ${nf(library().length)}`, pb: '', scroll: 'set-anims', cls: 'g3-grow', foot: '<span class="g3-dim">Usadas quando o pedido não diz quais.</span>' });

		const changes = Object.keys(d).filter(key => String(d[key]) !== String(s[key]));
		const addedAnims = [...draft].filter(a => !current.includes(a));
		const removedAnims = current.filter(a => !draft.has(a));
		const animChanged = addedAnims.length || removedAnims.length;
		let changesPanel = '';
		if (changes.length || animChanged) {
			const labels = { texture: 'Cores', faces: 'Triângulos', height: 'Altura padrão', device: 'Dispositivo' };
			const rows = changes.map(key => [labels[key], `${del(esc(SETTING_TEXT[key](s[key])))} ${ins(esc(SETTING_TEXT[key](d[key])))}`]);
			if (animChanged) { rows.push(['Animações padrão', [addedAnims.length ? ins(esc(addedAnims.join(', '))) : '', removedAnims.length ? del(esc(removedAnims.join(', '))) : ''].filter(Boolean).join(' ')]); }
			changesPanel = panel('O que muda', table([['Item', 140], ['Mudança', 0]], rows), { icon: 'edit', pb: 'np fit', cls: 'fit', mk: 'run', foot: `<span class="g3-dim">Os modelos já gerados não mudam.</span>${btn('Desfazer', 'close', 'sm', 'data-act="set-undo"')}${btn('Pedir ao agente', 'comments', 'sm primary', 'data-act="set-ask"')}` });
		}

		const e = engine();
		const engineRows = engineReady()
			? kv([['Estado', `${ic('dot', 'c-ok sm')} pronto`], ['Versão', esc(e.version || '—')], ['Em uso', esc(DEVICE_LABELS[e.device] || e.device || '—')], ['Animações', nf(library().length)]]) + `<div class="g3-li two" style="border-top:1px solid var(--g3-line)"><span class="tx">Disponível<small>${esc(e.devices || '—')}</small></span></div>`
			: note('warning', 'c-you', `<p>${esc(e.problem || 'O gerador não respondeu.')}</p>${e.fix ? `<p class="g3-dim">${esc(e.fix)}</p>` : ''}`);
		const enginePanel = panel(engineReady() ? 'Computador' : 'Gerador não encontrado', engineRows, { icon: 'chip', pb: 'np fit', cls: 'fit', mk: engineReady() ? '' : 'you', foot: engineReady() ? '' : btn('Verificar de novo', 'refresh', 'sm', 'data-act="check-engine"') });
		const folders = kv([['Modelos', `<span class="g3-chip">${esc(folder())}/</span>`], ['Imagens', 'só leitura'], ['Ao repetir um nome', 'pergunto antes']]);
		const foldersPanel = panel('Pastas', folders, { icon: 'folder', right: btn('Mudar', 'edit', 'sm', 'data-act="set-folder"'), pb: 'np fit', cls: 'fit' });
		const credits = CREDITS.map(([name, what, license]) => li('', `${esc(name)} ${dim(esc(what))}`, `<span class="g3-chip">${esc(license)}</span>`)).join('');
		const creditsPanel = panel('Modelos usados', credits, { icon: 'info', sub: 'todos neste computador', pb: 'np fit', cls: 'fit' });
		const top = head('gear', 'Configurações do 3D Generator', 'valem para este projeto · mudar uma pede ao agente');
		return `${top}<div class="g3-cols"><div class="g3-main">${qualityPanel}${animsPanel}${changesPanel}</div><div class="g3-side" data-scroll="set-side">${enginePanel}${foldersPanel}${creditsPanel}</div></div>`;
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
		S.view = view;
		remember();
		render();
	}

	function generateText(path) {
		const existing = imageEntry(path)?.model || (modelEntry(`${folder()}/${stem(path)}.glb`) ? `${folder()}/${stem(path)}.glb` : null);
		return existing ? `Gere de novo o modelo 3D de ${path}. Pode substituir ${existing}.` : `Gere o modelo 3D de ${path}.`;
	}

	function settingsAsk() {
		const s = settings();
		const parts = Object.keys(S.setDraft).filter(key => String(S.setDraft[key]) !== String(s[key])).map(key => SETTING_ASK[key](S.setDraft[key]));
		if (S.animSetDraft) {
			const current = defaultAnims();
			// The ones kept in their order, then the ones added in the library's order.
			const list = current.filter(id => S.animSetDraft.has(id)).concat(library().map(a => a.id).filter(id => S.animSetDraft.has(id) && !current.includes(id)));
			if (list.length !== current.length || list.some(id => !current.includes(id))) {
				parts.push(list.length ? `as animações padrão para ${joinPt(list)}` : 'as animações padrão para nenhuma ([])');
			}
		}
		if (!parts.length) { return null; }
		return parts.length === 1 ? `Mude ${parts[0]}.` : `Mude as configurações do 3D Generator: ${parts.join('; ')}.`;
	}

	function onClick(event) {
		if (event.target.closest('input, select, label')) { return; }
		const el = event.target.closest('[data-act]');
		if (!el || el.disabled) { return; }
		const d = el.dataset;
		switch (d.act) {
			case 'view':
				setView(d.view);
				break;
			case 'stop':
				host.postMessage({ type: 'stop' });
				toast('Pedi ao agente para parar a geração.');
				break;
			case 'pick-image':
				S.imageSel = d.path;
				render();
				break;
			case 'open-image':
				act(`Abra a imagem ${d.path} no 3D Generator.`);
				break;
			case 'generate-image':
				act(generateText(d.path));
				break;
			case 'list-images':
				act('Liste as imagens do projeto que dá para usar no 3D Generator.');
				break;
			case 'check-engine':
				act('Verifique se o gerador do 3D Generator está instalado neste computador.');
				break;
			case 'toggle-points':
				S.points = !S.points;
				remember();
				render();
				break;
			case 'kp':
				S.kpSel = S.kpSel === d.key ? null : d.key;
				S.points = true;
				render();
				break;
			case 'frame':
				frame(S.camera);
				break;
			case 'camera':
				S.camera = d.camera;
				frame(S.camera);
				render();
				break;
			case 'tool':
				S.tools[d.tool] = !S.tools[d.tool];
				remember();
				render();
				break;
			case 'regen': {
				const path = d.path || S.mdl?.path;
				if (path) { act(`Gere de novo ${path}.`); }
				break;
			}
			case 'ask-warning': {
				const f = facts();
				fill(`Como corrijo o aviso de ${f.path}: ${f.warnings[0] || ''}?`);
				break;
			}
			case 'skel-mode':
				S.skelMode = d.mode;
				remember();
				render();
				break;
			case 'bone':
				S.bone = d.bone;
				remember();
				render();
				break;
			case 'fingers':
				S.fingers = !S.fingers;
				render();
				break;
			case 'clip':
				S.anim = d.name;
				S.playing = true;
				remember();
				render();
				break;
			case 'anim-row': {
				const draft = S.animDraft || new Set(V.ready ? V.info.clips.map(c => c.name) : facts().clips);
				if (draft.has(d.name)) { draft.delete(d.name); } else { draft.add(d.name); }
				S.animDraft = draft;
				render();
				break;
			}
			case 'anim-undo':
				S.animDraft = null;
				render();
				break;
			case 'anim-regen': {
				const f = facts();
				const kept = f.clips.filter(id => S.animDraft?.has(id));
				const list = kept.concat(library().map(a => a.id).filter(id => S.animDraft?.has(id) && !kept.includes(id)));
				const removed = f.clips.filter(id => !S.animDraft?.has(id));
				act(!list.length ? `Gere de novo ${f.path} sem animações.`
					: removed.length ? `Gere de novo ${f.path} só com as animações ${joinPt(list)} (tire ${joinPt(removed)}).`
						: `Gere de novo ${f.path} com as animações ${joinPt(list)}.`);
				S.animDraft = null;
				break;
			}
			case 'play':
				S.playing = !S.playing;
				if (V.action && S.playing && !S.loop && V.action.time >= V.action.getClip().duration - 0.001) { V.action.reset(); }
				render();
				break;
			case 'loop':
				S.loop = !S.loop;
				render();
				break;
			case 'gallery':
				S.gallery = d.mode;
				remember();
				render();
				break;
			case 'pick-model':
				S.modelSel = d.path;
				render();
				break;
			case 'show-model':
				if (S.mdl?.path === d.path) { setView('model'); } else { act(`Mostre o modelo ${d.path}.`); }
				break;
			case 'set-undo':
				S.setDraft = {};
				S.animSetDraft = null;
				render();
				break;
			case 'set-ask': {
				const text = settingsAsk();
				if (text) { act(text); }
				S.setDraft = {};
				S.animSetDraft = null;
				break;
			}
			case 'set-folder':
				fill('Mude a pasta dos modelos do 3D Generator para ');
				break;
		}
	}

	function onChange(event) {
		const el = event.target;
		if (el.dataset.set) {
			const key = el.dataset.set;
			const value = key === 'device' ? el.value : Number(el.value);
			if (String(value) === String(settings()[key])) { delete S.setDraft[key]; } else { S.setDraft[key] = value; }
			render();
		} else if (el.dataset.act === 'set-anim') {
			const draft = S.animSetDraft || new Set(defaultAnims());
			if (el.checked) { draft.add(el.dataset.name); } else { draft.delete(el.dataset.name); }
			S.animSetDraft = draft;
			render();
		} else if (el.dataset.act === 'anim-toggle') {
			const draft = S.animDraft || new Set(V.ready ? V.info.clips.map(c => c.name) : facts().clips);
			if (el.checked) { draft.add(el.dataset.name); } else { draft.delete(el.dataset.name); }
			S.animDraft = draft;
			render();
		} else if (el.dataset.act === 'speed') {
			S.speed = Number(el.value) || 1;
			applyMode();
		}
	}

	function onInput(event) {
		const el = event.target;
		if (el.id === 'g3-scrub' && V.action) {
			S.playing = false;
			V.action.paused = true;
			V.action.time = Number(el.value);
			V.mixer.update(0);
			const playButton = document.querySelector('[data-act="play"]');
			if (playButton) { playButton.outerHTML = btn('', 'play', 'ib', 'data-act="play" title="Tocar"'); }
			updatePlayer();
			invalidate();
		}
	}

	// ------------------------------------------------------------------ host messages

	/** Follows what the agent pointed at with show (state.view and state.focus), once per change. */
	function applyFocus(state) {
		const f = obj(state.focus) || {};
		if (ALL_VIEWS.includes(state.view)) { S.view = state.view; }
		if (CAMERAS[f.camera] && f.camera !== S.camera) {
			S.camera = f.camera;
			frame(S.camera);
		}
		if (typeof f.animation === 'string' && f.animation) { S.anim = f.animation; S.playing = true; S.animDraft = null; }
		if (typeof f.bone === 'string' && f.bone) {
			S.bone = f.bone;
			if (FINGER.test(f.bone)) { S.fingers = true; }
			if (state.view === 'skeleton') { S.skelMode = 'weights'; }
		} else if (state.view === 'skeleton') {
			S.skelMode = 'bones';
		}
		if (typeof f.model === 'string') { S.modelSel = f.model; }
		if (typeof f.image === 'string') { S.imageSel = f.image; }
	}

	function readFiles(files) {
		const state = obj(typeof files['state.json'] === 'string' ? parse(files['state.json']) : null);
		S.st = state || S.st || {};
		const image = obj(typeof files['image.json'] === 'string' ? parse(files['image.json']) : null);
		S.img = image && typeof image.path === 'string' ? image : null;
		const modelText = typeof files['model.json'] === 'string' ? files['model.json'] : '';
		if (modelText !== S.mdlRaw) {
			S.mdlRaw = modelText;
			const model = obj(parse(modelText)) || {};
			const glb = typeof model.glb === 'string' && model.glb.length ? model.glb : null;
			S.mdl = typeof model.path === 'string' ? { path: model.path, bytes: num(model.bytes), tooLarge: !!model.tooLarge, hasGlb: !!glb } : null;
			S.animDraft = null;
			if (glb) { viewerLoad(glb); } else { viewerClear(); }
		}
		if (state) {
			// A new running job counts as a change, so the Studio returns to its progress even after local view changes.
			const sig = JSON.stringify([state.view ?? null, state.focus ?? null, state.job?.state === 'running' ? state.job.id ?? null : null]);
			if (sig !== S.sig) {
				const first = S.sig === null && saved.sig === sig;
				S.sig = sig;
				if (!first) { applyFocus(state); }
				remember();
			}
			const notice = obj(state.notice);
			// The time makes a repeated warning (the same file refused again) show again.
			const noticeKey = notice?.text ? `${notice.kind}|${notice.text}|${notice.at ?? ''}` : null;
			if (noticeKey && noticeKey !== S.noticeSeen) { toast(String(notice.text), notice.kind === 'warning' ? 'warning' : 'info'); }
			S.noticeSeen = noticeKey;
		}
		if (S.pending && Date.now() - S.pending.at > 90000) { S.pending = null; }
		ticking();
	}

	/** While a job runs, the elapsed time and the bar move every second without drawing the whole Studio again. */
	function ticking() {
		if (jobRunning() && !ticking.timer) {
			ticking.timer = setInterval(() => {
				if (!jobRunning()) { clearInterval(ticking.timer); ticking.timer = 0; return; }
				const text = secs(elapsedNow());
				document.querySelectorAll('[data-tick="elapsed"]').forEach(el => { el.textContent = el.dataset.minus ? secs(Math.max(0, elapsedNow() - Number(el.dataset.minus))) : text; });
			}, 1000);
		}
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
				toast(typeof msg.message === 'string' ? msg.message : 'Não foi possível atualizar o 3D Generator.', 'warning');
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
	// A double click on an image of the project asks the agent to open it.
	document.addEventListener('dblclick', event => {
		const row = event.target.closest('.g3-img[data-path]');
		if (row && engineReady()) { act(`Abra a imagem ${row.dataset.path} no 3D Generator.`); }
	});
	document.addEventListener('change', onChange);
	document.addEventListener('input', onInput);
	document.addEventListener('visibilitychange', () => { if (!document.hidden) { invalidate(); } });
	window.addEventListener('resize', () => render());

	render();
	host.postMessage({ type: 'ready' });
})();
