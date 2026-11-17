/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CloudStudio Studio interface: plain JavaScript, no libraries, no network. It reads the Studio files the local
// cloud writes (cloud, resources, calls, logs, settings, view) and shows the cloud by service, as a map, as the
// calls the app made and as live logs. It never writes files and never reaches the cloud: every action becomes
// a chat message (`ask`) the agent carries out with the CloudStudio tool. All visible text is in Brazilian Portuguese.
(function () {
	'use strict';

	/** @type {{ postMessage(m: object): void, getState(): any, setState(s: any): void }} */
	const host = typeof acquireVsCodeApi === 'function'
		? acquireVsCodeApi()
		: { postMessage() { }, getState() { return undefined; }, setState() { } };

	// ------------------------------------------------------------------ constants

	const VIEWS = {
		overview: { label: 'Visão geral', icon: 'dashboard' },
		resources: { label: 'Recursos', icon: 'tree' },
		map: { label: 'Mapa', icon: 'map' },
		calls: { label: 'Chamadas', icon: 'swap' },
		logs: { label: 'Logs', icon: 'output' },
		copies: { label: 'Cópias', icon: 'history', more: true },
		catalog: { label: 'Catálogo de serviços', icon: 'library', more: true },
		settings: { label: 'Configurações', icon: 'gear', more: true },
	};

	/** Resource kinds by engine service: label for one, many, tree group, icon and the tool's word. */
	const KINDS = {
		apigatewayv2: { kind: 'api', one: 'API', many: 'APIs', group: 'API Gateway', icon: 'globe' },
		lambda: { kind: 'function', one: 'função', many: 'funções', group: 'Lambda', icon: 'lambda' },
		dynamodb: { kind: 'table', one: 'tabela', many: 'tabelas', group: 'DynamoDB', icon: 'database' },
		s3: { kind: 'bucket', one: 'bucket', many: 'buckets', group: 'S3', icon: 'bucket' },
		sqs: { kind: 'queue', one: 'fila', many: 'filas', group: 'SQS', icon: 'inbox' },
		sns: { kind: 'topic', one: 'tópico', many: 'tópicos', group: 'SNS', icon: 'broadcast' },
		stepfunctions: { kind: 'statemachine', one: 'máquina de estados', many: 'máquinas de estados', group: 'Step Functions', icon: 'flow' },
		scheduler: { kind: 'schedule', one: 'agendamento', many: 'agendamentos', group: 'EventBridge Scheduler', icon: 'clock' },
		events: { kind: 'rule', one: 'regra', many: 'regras', group: 'EventBridge', icon: 'bolt' },
		secretsmanager: { kind: 'secret', one: 'segredo', many: 'segredos', group: 'Secrets Manager', icon: 'key' },
		ssm: { kind: 'parameter', one: 'parâmetro', many: 'parâmetros', group: 'Parameter Store', icon: 'sliders' },
		logs: { kind: 'logs', one: 'grupo de logs', many: 'grupos de logs', group: 'CloudWatch Logs', icon: 'output' },
	};
	const ORDER = ['apigatewayv2', 'lambda', 'dynamodb', 's3', 'sqs', 'sns', 'stepfunctions', 'scheduler', 'events', 'secretsmanager', 'ssm', 'logs'];
	const SERVICE_LABEL = { ...Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, v.group])), sts: 'STS', apigateway: 'API Gateway (REST)' };

	const REGIONS = ['us-east-1', 'us-east-2', 'us-west-2', 'sa-east-1', 'eu-west-1', 'eu-central-1', 'ap-southeast-1', 'ap-northeast-1'];

	/** The AWS catalog: emulated services first; the rest are listed honestly as not available yet. */
	const CATALOG = [
		['Computação', [['Lambda', 'lambda'], ['EC2', ''], ['ECS', ''], ['EKS', ''], ['App Runner', ''], ['Batch', ''], ['Elastic Beanstalk', ''], ['Lightsail', '']]],
		['Armazenamento', [['S3', 's3'], ['EBS', ''], ['EFS', ''], ['FSx', ''], ['Glacier', ''], ['Storage Gateway', ''], ['Backup', '']]],
		['Bancos de dados', [['DynamoDB', 'dynamodb'], ['RDS', ''], ['Aurora', ''], ['ElastiCache', ''], ['DocumentDB', ''], ['Neptune', ''], ['Keyspaces', ''], ['MemoryDB', ''], ['Timestream', ''], ['Redshift', '']]],
		['Integração', [['SQS', 'sqs'], ['SNS', 'sns'], ['EventBridge', 'events'], ['EventBridge Scheduler', 'scheduler'], ['Step Functions', 'stepfunctions'], ['API Gateway (HTTP)', 'apigatewayv2'], ['API Gateway (REST)', ''], ['AppSync', ''], ['MQ', ''], ['MSK (Kafka)', ''], ['Kinesis', ''], ['Firehose', ''], ['Pipes', '']]],
		['Segurança', [['Secrets Manager', 'secretsmanager'], ['STS', 'sts'], ['IAM', ''], ['KMS', ''], ['Cognito', ''], ['ACM', ''], ['WAF', ''], ['GuardDuty', ''], ['Security Hub', '']]],
		['Gerenciamento', [['Parameter Store (SSM)', 'ssm'], ['CloudWatch Logs', 'logs'], ['CloudWatch', ''], ['CloudFormation', ''], ['CloudTrail', ''], ['Config', ''], ['Organizations', ''], ['X-Ray', '']]],
		['Rede e entrega', [['Route 53', ''], ['CloudFront', ''], ['VPC', ''], ['ELB', ''], ['Global Accelerator', '']]],
		['Mensagens e mídia', [['SES', ''], ['Pinpoint', ''], ['Chime SDK', ''], ['IVS', ''], ['MediaConvert', '']]],
		['Análise e IA', [['Athena', ''], ['Glue', ''], ['EMR', ''], ['OpenSearch', ''], ['QuickSight', ''], ['Bedrock', ''], ['SageMaker', ''], ['Textract', ''], ['Transcribe', ''], ['Rekognition', ''], ['Comprehend', ''], ['Translate', ''], ['Polly', '']]],
		['Ferramentas', [['CodeBuild', ''], ['CodePipeline', ''], ['CodeDeploy', ''], ['ECR', ''], ['Amplify', ''], ['Cost Explorer', '']]],
	];

	const ICONS = {
		dashboard: '<rect x="1.8" y="1.8" width="5.4" height="5.4"/><rect x="8.8" y="1.8" width="5.4" height="5.4"/><rect x="1.8" y="8.8" width="5.4" height="5.4"/><rect x="8.8" y="8.8" width="5.4" height="5.4"/>',
		tree: '<path d="M2 3h3M2 8h3M2 13h3M7.4 3h6.6M7.4 8h6.6M7.4 13h6.6"/>',
		map: '<rect x="1.5" y="1.8" width="5" height="3.6"/><rect x="9.5" y="1.8" width="5" height="3.6"/><rect x="5.5" y="10.6" width="5" height="3.6"/><path d="M4 5.4v2.6h8V5.4M8 8v2.6"/>',
		swap: '<path d="M2.4 5h10.4M10 2.4 12.8 5 10 7.6M13.6 11H3.2M6 8.4 3.2 11 6 13.6"/>',
		output: '<rect x="2" y="1.8" width="12" height="12.4"/><path d="M4.4 5h7.2M4.4 8h7.2M4.4 11h4.4"/>',
		history: '<path d="M3 4.6A5.8 5.8 0 1 1 2.2 8"/><path d="M2.6 1.9v2.9h2.9M8 4.8V8l2.2 1.5"/>',
		library: '<path d="M2.4 2.4v11.2M5.4 2.4v11.2M8.6 2.8l3.2 10.8"/>',
		gear: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.6v2M8 12.4v2M1.6 8h2M12.4 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M3.5 12.5l1.4-1.4M11.1 4.9l1.4-1.4"/>',
		globe: '<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c1.8 1.7 2.6 3.7 2.6 6S9.8 12.3 8 14C6.2 12.3 5.4 10.3 5.4 8S6.2 3.7 8 2z"/>',
		lambda: '<path d="M3.4 2.2h2.4l5.6 11.6h2.2M7.4 6.6 3.2 13.8"/>',
		database: '<ellipse cx="8" cy="3.8" rx="5" ry="1.9"/><path d="M3 3.8v8.4c0 1.05 2.24 1.9 5 1.9s5-.85 5-1.9V3.8M3 8c0 1.05 2.24 1.9 5 1.9s5-.85 5-1.9"/>',
		bucket: '<path d="M2.2 3.6h11.6l-1.4 10.2H3.6z"/><path d="M2.2 3.6c0-1 2.6-1.6 5.8-1.6s5.8.6 5.8 1.6"/>',
		inbox: '<path d="M1.8 9.2 3.6 2.6h8.8l1.8 6.6v4.2H1.8z"/><path d="M1.8 9.2h3.6l.8 1.6h3.6l.8-1.6h3.6"/>',
		broadcast: '<circle cx="8" cy="8" r="1.4"/><path d="M5.2 5.2a4 4 0 0 0 0 5.6M10.8 5.2a4 4 0 0 1 0 5.6M3.2 3.2a6.8 6.8 0 0 0 0 9.6M12.8 3.2a6.8 6.8 0 0 1 0 9.6"/>',
		flow: '<rect x="5.4" y="1.6" width="5.2" height="3.4"/><rect x="1.6" y="11" width="5.2" height="3.4"/><rect x="9.2" y="11" width="5.2" height="3.4"/><path d="M8 5v3M4.2 11V8h7.6v3"/>',
		clock: '<circle cx="8" cy="8" r="6"/><path d="M8 4.4V8l2.4 1.6"/>',
		bolt: '<path d="M9.2 1.6 3.4 9h4.2l-.8 5.4L12.6 7H8.4z"/>',
		key: '<circle cx="5" cy="11" r="2.8"/><path d="m7 9 6-6M11 5l1.6 1.6M9.4 6.6 11 8.2"/>',
		sliders: '<path d="M2 4h12M2 8h12M2 12h12"/><rect x="4" y="2.6" width="2" height="2.8" fill="currentColor"/><rect x="9.6" y="6.6" width="2" height="2.8" fill="currentColor"/><rect x="6" y="10.6" width="2" height="2.8" fill="currentColor"/>',
		cloud: '<path d="M4.4 12.4h7.4a2.8 2.8 0 0 0 .4-5.6 4.2 4.2 0 0 0-8.2-.6 3.1 3.1 0 0 0 .4 6.2z"/>',
		play: '<path d="M4.6 2.8v10.4L13 8z"/>',
		stop: '<rect x="3.4" y="3.4" width="9.2" height="9.2"/>',
		power: '<path d="M8 1.8v6M4.4 4.2a5 5 0 1 0 7.2 0"/>',
		copy: '<rect x="5" y="5" width="8.6" height="8.6"/><path d="M3 10.6H2.4V2.4h8.2V3"/>',
		file: '<path d="M3.2 1.8h6l3.6 3.6v8.8H3.2z"/><path d="M9.2 1.8v3.6h3.6"/>',
		fileAdd: '<path d="M3.2 1.8h6l3.6 3.6v8.8H3.2z"/><path d="M9.2 1.8v3.6h3.6M8 7.6v4.4M5.8 9.8h4.4"/>',
		search: '<circle cx="7" cy="7" r="4.6"/><path d="m10.4 10.4 3.6 3.6"/>',
		chevD: '<path d="M3.5 6 8 10.5 12.5 6"/>',
		chevR: '<path d="m6 3.5 4.5 4.5L6 12.5"/>',
		close: '<path d="m4 4 8 8M12 4l-8 8"/>',
		check: '<path d="m3 8.4 3.1 3.1L13 4.6"/>',
		passed: '<circle cx="8" cy="8" r="6.4" fill="currentColor" stroke="none"/><path d="m5.1 8.2 2 2 3.9-4.1" stroke="#FFFFFF" stroke-width="1.6"/>',
		error: '<circle cx="8" cy="8" r="6"/><path d="m5.7 5.7 4.6 4.6M10.3 5.7l-4.6 4.6"/>',
		warning: '<path d="M8 2 14.4 13.6H1.6z"/><path d="M8 6.4v3.4M8 11.8h.01"/>',
		info: '<circle cx="8" cy="8" r="6"/><path d="M8 7.2v4M8 4.8h.01"/>',
		dot: '<circle cx="8" cy="8" r="3.4" fill="currentColor" stroke="none"/>',
		ring: '<circle cx="8" cy="8" r="3.6"/>',
		spinner: '<path d="M13.6 8A5.6 5.6 0 0 1 2.4 8"/>',
		comment: '<path d="M2.2 2.8h11.6v8H7.2l-3 2.6v-2.6h-2z"/>',
		send: '<path d="M2 8 14 2l-3 12-3.2-4.4z"/><path d="M7.8 9.6 14 2"/>',
		folder: '<path d="M1.8 3.6h4.1l1.5 1.6h6.8v7.5H1.8z"/>',
		trash: '<path d="M2.6 4h10.8M6 4V2.4h4V4M3.8 4l.8 9.8h6.8l.8-9.8"/>',
		lock: '<rect x="3.2" y="7" width="9.6" height="7"/><path d="M5.4 7V5.2a2.6 2.6 0 0 1 5.2 0V7"/>',
		app: '<rect x="1.8" y="2.6" width="12.4" height="10.8"/><path d="M1.8 5.6h12.4M4 4.1h.01M5.8 4.1h.01"/>',
		agent: '<rect x="3" y="5" width="10" height="8"/><path d="M8 2v3M6 9h.01M10 9h.01M5.6 11.2h4.8"/>',
		refresh: '<path d="M13.2 6.6A5.4 5.4 0 0 0 3.4 5M2.8 9.4A5.4 5.4 0 0 0 12.6 11M3.4 2.2V5h2.8M12.6 13.8V11H9.8"/>',
		restore: '<path d="M4 6.4h6a3.4 3.4 0 0 1 0 6.8H6.6"/><path d="M6.6 3.6 3.8 6.4l2.8 2.8"/>',
		plus: '<path d="M8 3v10M3 8h10"/>',
	};

	// ------------------------------------------------------------------ helpers

	const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' };
	const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ESC[c]);
	const ic = (name, cls = '') => `<svg class="cs-ic ${cls}" viewBox="0 0 16 16" aria-hidden="true">${ICONS[name] || ''}</svg>`;
	const MARK = `<svg class="cs-mark" viewBox="0 0 100 100" aria-hidden="true"><rect width="100" height="100" rx="24" fill="#2B8C82"/><g fill="#fff"><circle cx="35" cy="40" r="11"/><circle cx="52" cy="31" r="15"/><circle cx="67" cy="41" r="10"/><rect x="35" y="38" width="32" height="13"/></g><rect x="24" y="58" width="52" height="11" rx="3" fill="#fff"/><rect x="24" y="73" width="52" height="11" rx="3" fill="#fff" opacity=".82"/><circle cx="31.5" cy="63.5" r="2.7" fill="#2B8C82"/><circle cx="31.5" cy="78.5" r="2.7" fill="#2B8C82"/></svg>`;
	const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
	const pad = n => String(n).padStart(2, '0');
	const clock = (seconds, ms) => {
		if (!seconds) { return '—'; }
		const d = new Date(seconds * 1000);
		return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${ms ? '.' + String(d.getMilliseconds()).padStart(3, '0') : ''}`;
	};
	const dateTime = seconds => {
		if (!seconds) { return '—'; }
		const d = new Date(seconds * 1000);
		return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
	};
	const bytes = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1).replace('.', ',')} KB` : `${(n / 1048576).toFixed(1).replace('.', ',')} MB`;
	const since = seconds => {
		const m = Math.max(0, Math.round((Date.now() / 1000 - seconds) / 60));
		return m < 1 ? 'agora' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
	};
	const pretty = text => {
		if (text === null || text === undefined || text === '') { return ''; }
		if (typeof text !== 'string') { return JSON.stringify(text, null, 2); }
		try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
	};
	const highlight = text => esc(text).replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false|null)\b|(-?\b\d+(?:\.\d+)?\b)/g,
		(m, str, colon, kw, num) => str ? (colon ? `<span class="k">${str}</span>${colon}` : `<span class="s">${str}</span>`) : kw ? `<span class="b">${kw}</span>` : `<span class="n">${num}</span>`);
	const code = (text, cls = '') => `<pre class="cs-code ${cls}">${highlight(pretty(text))}</pre>`;
	const keyOf = r => JSON.stringify([KINDS[r.service]?.kind || r.service, r.account || '000000000000', r.region || '', r.name]);
	const sameNamespace = (a, b) => (a.account || '000000000000') === (b.account || '000000000000') && (a.region || '') === (b.region || '');
	const namespaceText = r => `na conta ${r.account || '000000000000'}${r.region ? `, região ${r.region}` : ''}`;
	function selectedResource(key) {
		const exact = S.resources.find(r => keyOf(r) === key);
		if (exact) { return exact; }
		const legacy = S.resources.filter(r => `${KINDS[r.service]?.kind || r.service}:${r.name}` === key);
		return legacy.length === 1 ? legacy[0] : undefined;
	}
	const parse = text => { try { return JSON.parse(text); } catch { return undefined; } };
	const tail = arn => String(arn || '').split(':').pop().replace(/^function:|^stateMachine:/, '');

	// ------------------------------------------------------------------ state

	const saved = host.getState() || {};
	const S = {
		ctx: null,
		cloud: null,
		resources: [],
		calls: [],
		callTotal: 0,
		errorTotal: 0,
		logs: [],
		settings: {},
		view: VIEWS[saved.view] ? saved.view : 'overview',
		viewRevision: 0,
		sel: saved.sel || null,
		open: new Set(saved.open || ORDER),
		filter: '',
		callFilter: saved.callFilter || 'all',
		callSel: null,
		logGroup: saved.logGroup || '',
		itemSel: {},
		drafts: {},
		pending: null,
		menu: false,
		confirm: null,
		running: false,
		note: null,
		firstStorage: 'memory',
		firstRegion: 'us-east-1',
	};

	function remember() {
		host.setState({ view: S.view, sel: S.sel, open: [...S.open], callFilter: S.callFilter, logGroup: S.logGroup, viewRevision: S.viewRevision });
	}

	function cloudOn() {
		return S.cloud?.status === 'running';
	}

	function ask(text, send = true) {
		const requestId = send ? `cs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}` : undefined;
		host.postMessage({ type: 'ask', text, send: !!send, ...(requestId ? { requestId } : {}) });
		return requestId;
	}

	function act(kind, text) {
		const requestId = ask(text, true);
		S.pending = { kind, requestId, at: Date.now() };
		render();
	}

	// ------------------------------------------------------------------ toolbar and frame

	function toolbar() {
		const main = Object.entries(VIEWS).filter(([, v]) => !v.more);
		const moreOn = VIEWS[S.view].more;
		const buttons = main.map(([id, v]) => `<button class="cs-vb ${S.view === id ? 'on' : ''}" data-act="view" data-view="${id}">${ic(v.icon)}${v.label}</button>`).join('');
		const more = `<button class="cs-vb ${moreOn ? 'on' : ''}" data-act="menu">${moreOn ? ic(VIEWS[S.view].icon) + VIEWS[S.view].label : 'Mais'}${ic('chevD', 'chev')}</button>`;
		const endpoint = S.cloud?.endpoint ? S.cloud.endpoint.replace('http://', '') : '127.0.0.1:4566';
		const region = S.cloud?.region || S.settings.region || 'us-east-1';
		let status;
		let power;
		const starting = S.pending?.kind === 'start';
		const stopping = S.pending?.kind === 'stop';
		if (cloudOn() && !stopping) {
			status = `<span class="cs-stat">${ic('dot', 'c-ok sm')}Rodando${S.cloud.readyMs ? ` · ligou em ${S.cloud.readyMs} ms` : ''}</span>`;
			power = `<button class="cs-btn" data-act="stop-cloud">${ic('stop', 'c-bad')}Parar</button>`;
		} else if (starting || stopping) {
			status = `<span class="cs-stat">${ic('spinner', 'spin c-run sm')}${starting ? 'Ligando…' : 'Desligando…'}</span>`;
			power = `<button class="cs-btn dis" disabled>${ic('power')}${starting ? 'Ligar' : 'Parar'}</button>`;
		} else {
			status = `<span class="cs-stat">${ic('ring', 'c-dim sm')}Desligada</span>`;
			power = `<button class="cs-btn primary" data-act="start-cloud">${ic('power')}Ligar</button>`;
		}
		return `<div class="cs-bar">${buttons}${more}<span class="cs-sep"></span>`
			+ `<span class="cs-crumb">${MARK}<b>Nuvem local</b><span class="v">${esc(endpoint)} · ${esc(region)}</span></span>`
			+ `<span class="cs-sp"></span>${status}${power}</div>`;
	}

	function menu() {
		if (!S.menu) { return ''; }
		const items = Object.entries(VIEWS).filter(([, v]) => v.more)
			.map(([id, v]) => `<div class="mi ${S.view === id ? 'sel' : ''}" data-act="view" data-view="${id}">${ic(v.icon)}${v.label}</div>`).join('');
		return `<div class="cs-menu" style="left:${S.menuX || 300}px;top:36px">${items}</div>`;
	}

	function footer() {
		const counts = S.resources.filter(r => r.service !== 'logs');
		const services = new Set(counts.map(r => r.service)).size;
		const storage = (S.cloud?.storage || S.settings.storage) === 'persistent' ? 'Guardada entre sessões' : 'Só na memória';
		const parts = [
			`${ic('dot', cloudOn() ? 'c-ok sm' : 'c-dim sm')}${plural(counts.length, 'recurso', 'recursos')} em ${plural(services, 'serviço', 'serviços')}`,
			storage,
			`Conta ${esc(S.cloud?.account || '000000000000')}`,
			esc(S.cloud?.region || S.settings.region || 'us-east-1'),
		];
		if (S.errorTotal) {
			parts.push(`${ic('error', 'c-bad')}${plural(S.errorTotal, 'chamada com erro', 'chamadas com erro')}`);
		}
		return `<div class="cs-foot">${parts.map(p => `<span>${p}</span>`).join('')}</div>`;
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
		const root = document.getElementById('cs-root') || (() => {
			const el = document.createElement('div');
			el.id = 'cs-root';
			document.body.appendChild(el);
			return el;
		})();
		const scrolls = {};
		root.querySelectorAll('[data-scroll]').forEach(el => { scrolls[el.dataset.scroll] = [el.scrollTop, el.scrollLeft]; });
		const active = document.activeElement;
		const focus = active && active.dataset && active.dataset.draft ? { key: active.dataset.draft, start: active.selectionStart, end: active.selectionEnd } : null;
		let body;
		const empty = !S.cloud || (!cloudOn() && !S.resources.length);
		if (S.pending?.kind === 'start' && !cloudOn()) {
			body = startingView();
		} else if (empty && !['catalog', 'settings', 'copies'].includes(S.view)) {
			body = firstView();
		} else {
			body = ({ overview: overviewView, resources: resourcesView, map: mapView, calls: callsView, logs: logsView, copies: copiesView, catalog: catalogView, settings: settingsView })[S.view]();
		}
		const banner = !cloudOn() && !empty && S.pending?.kind !== 'start'
			? `<div class="cs-banner">${ic('info', 'c-dim')}<span>A nuvem local está desligada. ${S.cloud?.storage === 'persistent' ? 'Os recursos abaixo voltam quando você ligar de novo.' : 'O que estava na memória foi apagado ao desligar.'}</span><button class="cs-btn sm" data-act="start-cloud">${ic('power')}Ligar</button></div>`
			: '';
		root.innerHTML = `<div class="cs-studio">${toolbar()}${banner}<div class="cs-body">${body}</div>${footer()}${menu()}${confirmDialog()}${S.note ? `<div class="cs-toast">${ic('info', 'c-run')}${esc(S.note)}</div>` : ''}</div>`;
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
		if (S.view === 'map') { fitMap(); }
	}

	// ------------------------------------------------------------------ first open and starting

	function firstView() {
		const project = S.ctx?.project;
		const storage = S.firstStorage;
		const region = S.firstRegion;
		const options = REGIONS.map(r => `<option value="${r}" ${r === region ? 'selected' : ''}>${r}</option>`).join('');
		return `<div class="cs-first" data-scroll="first"><div class="cs-first-in">
			<div class="cs-hero">${MARK}<div><h1>Uma nuvem AWS de mentira, só neste computador</h1>
			<p>O CloudStudio responde como a AWS em <code>127.0.0.1:4566</code>. O seu app e os testes usam o SDK de sempre, só trocando o endereço: nada vai para a internet e nada é cobrado.</p></div></div>
			<div class="cs-grid2">
				<div class="cs-panel"><div class="cs-ph">${ic('gear')}Antes de ligar</div><div class="cs-pb cs-form">
					<div class="cs-fl">Onde guardar os dados</div>
					<label class="cs-opt"><input type="radio" name="storage" value="memory" ${storage === 'memory' ? 'checked' : ''} data-act="first-storage"><span><b>Só na memória</b><small>Começa vazia toda vez. Bom para testes.</small></span></label>
					<label class="cs-opt"><input type="radio" name="storage" value="persistent" ${storage === 'persistent' ? 'checked' : ''} data-act="first-storage"><span><b>Guardar entre sessões</b><small>Tabelas, arquivos e filas continuam lá quando você voltar.</small></span></label>
					<div class="cs-fl">Região</div>
					<select class="cs-in" data-act="first-region">${options}</select>
					<div class="cs-actions"><button class="cs-btn primary big" data-act="start-cloud">${ic('power')}Ligar a nuvem local</button></div>
				</div></div>
				<div class="cs-panel"><div class="cs-ph">${ic('info')}O que você pode fazer</div><div class="cs-pb">
					<div class="cs-li">${ic('database', 'c-dim')}<span>S3, DynamoDB, SQS, SNS, Lambda, API Gateway, Step Functions, EventBridge, segredos e parâmetros</span></div>
					<div class="cs-li">${ic('lambda', 'c-dim')}<span>Funções em Python e Node.js rodando o código da pasta do projeto</span></div>
					<div class="cs-li">${ic('swap', 'c-dim')}<span>Ver cada chamada do app, com o erro do jeito que a AWS devolve</span></div>
					<div class="cs-li">${ic('history', 'c-dim')}<span>Guardar cópias do estado e voltar atrás</span></div>
					<div class="cs-fl gap">Peça ao agente, por exemplo</div>
					${['Ligue a nuvem local e crie a tabela de agendamentos', 'Rode o backend do projeto na nuvem local', 'Por que o app recebeu erro ao salvar?']
						.map(text => `<button class="cs-example" data-act="example" data-text="${esc(text)}">${ic('comment', 'c-dim')}${esc(text)}</button>`).join('')}
					${project ? '' : `<div class="cs-note">${ic('warning', 'c-you')}<div>Este Studio não está ligado a um projeto. Dá para criar tabelas, filas e buckets, mas funções e o <code>.env.local</code> precisam dos arquivos do projeto: abra o CloudStudio a partir do chat de um projeto.</div></div>`}
				</div></div>
			</div></div></div>`;
	}

	function startingView() {
		const elapsed = Math.round((Date.now() - S.pending.at) / 1000);
		const steps = [
			['Pedido enviado ao agente', true],
			['O agente chama o CloudStudio', elapsed > 1],
			['A nuvem abre a porta 4566 e responde', false],
		];
		return `<div class="cs-first"><div class="cs-first-in narrow"><div class="cs-panel"><div class="cs-ph">${ic('spinner', 'spin c-run')}Ligando a nuvem local</div><div class="cs-pb">
			${steps.map(([label, done]) => `<div class="cs-li">${done ? ic('passed', 'c-ok') : ic('spinner', 'spin c-run')}<span>${label}</span></div>`).join('')}
			<p class="cs-dim">Se o JumpCode pedir autorização para usar o CloudStudio, aprove na conversa.</p>
		</div></div></div></div>`;
	}

	// ------------------------------------------------------------------ overview

	function byService() {
		const groups = {};
		for (const r of S.resources) { (groups[r.service] = groups[r.service] || []).push(r); }
		return groups;
	}

	function lastCall(service, names) {
		const list = S.calls.filter(c => c.service === service && (!names || names.some(n => (c.target || '').startsWith(n))));
		return list.length ? list[list.length - 1].at : null;
	}

	function serviceBox(service, items) {
		const k = KINDS[service];
		const lines = items.slice(0, 2).map(r => `<div class="bl"><span class="nm">${esc(r.name)}</span><em>${boxDetail(r)}</em></div>`).join('');
		const more = items.length > 2 ? `<div class="bl cs-dim">e mais ${items.length - 2}</div>` : '';
		const warn = items.some(r => resourceMark(r) === 'bad') ? 'bad' : items.some(r => resourceMark(r) === 'you') ? 'you' : '';
		const last = lastCall(service, items.map(r => r.name));
		return `<div class="cs-box ${warn ? `mk mk-${warn}` : ''}" data-act="select" data-key="${esc(keyOf(items[0]))}">
			<div class="cs-ph">${ic(k.icon)}${k.group}<span class="r cs-dim">${plural(items.length, k.one, k.many)}</span></div>
			<div class="bb">${lines}${more}</div>
			<div class="bf">${ic('history', 'c-dim')}${last ? `última chamada ${clock(last)}` : 'nenhuma chamada ainda'}</div></div>`;
	}

	function boxDetail(r) {
		switch (r.service) {
			case 's3': return plural(r.count, 'objeto', 'objetos');
			case 'dynamodb': return plural(r.count, 'item', 'itens');
			case 'sqs': return r.dlq && dlqCount(r) ? `${ic('warning', 'c-you')}${dlqCount(r)} com falha` : `${r.visible} na fila`;
			case 'sns': return plural(r.subscriptions.length, 'inscrição', 'inscrições');
			case 'lambda': {
				const errors = (r.invocations || []).filter(i => !i.ok).length;
				return errors ? `${ic('error', 'c-bad')}${plural(errors, 'erro', 'erros')}` : plural((r.invocations || []).length, 'execução', 'execuções');
			}
			case 'apigatewayv2': return plural(r.routes.length, 'rota', 'rotas');
			case 'stepfunctions': return r.executions[0] ? statusWord(r.executions[0].status) : 'sem execuções';
			case 'scheduler': return r.next ? `próxima ${clock(r.next)}` : r.state === 'ENABLED' ? '' : 'desligado';
			case 'events': return plural(r.matched || 0, 'evento', 'eventos');
			case 'secretsmanager': return r.empty ? `${ic('warning', 'c-you')}vazio` : 'definido';
			case 'ssm': return r.type === 'SecureString' ? 'protegido' : esc(String(r.value ?? '').slice(0, 18));
			case 'logs': return plural(r.count, 'linha', 'linhas');
		}
		return '';
	}

	function dlqCount(queue) {
		if (!queue.dlq) { return 0; }
		const target = S.resources.find(r => r.service === 'sqs' && r.arn === queue.dlq.arn);
		return target ? target.count : 0;
	}

	function resourceMark(r) {
		if (r.service === 'lambda') {
			const last = (r.invocations || [])[0];
			if (last && !last.ok) { return 'bad'; }
			if ((r.envEmpty || []).length) { return 'you'; }
		}
		if (r.service === 'sqs' && r.count && S.resources.some(q => q.service === 'sqs' && q.dlq && q.dlq.arn === r.arn)) { return 'you'; }
		if (r.service === 'secretsmanager' && r.empty) { return 'you'; }
		if (r.service === 'stepfunctions' && r.executions[0] && ['FAILED', 'TIMED_OUT'].includes(r.executions[0].status)) { return 'bad'; }
		return '';
	}

	function statusWord(status) {
		return { RUNNING: 'rodando', SUCCEEDED: 'concluída', FAILED: 'falhou', TIMED_OUT: 'tempo esgotado', ABORTED: 'interrompida' }[status] || status;
	}

	function envLines() {
		const endpoint = S.cloud?.endpoint || 'http://127.0.0.1:4566';
		const region = S.cloud?.region || 'us-east-1';
		return [`AWS_ENDPOINT_URL=${endpoint}`, `AWS_REGION=${region}`, `AWS_DEFAULT_REGION=${region}`, 'AWS_ACCESS_KEY_ID=test', 'AWS_SECRET_ACCESS_KEY=test'];
	}

	function overviewView() {
		const groups = byService();
		const services = ORDER.filter(s => groups[s] && s !== 'logs');
		const boxes = services.length
			? `<div class="cs-boxes">${services.map(s => serviceBox(s, groups[s])).join('')}</div>`
			: `<div class="cs-note">${ic('info', 'c-run')}<div>A nuvem está ligada e vazia. Peça ao agente para criar o que o seu app usa, por exemplo <b>"crie uma tabela de agendamentos com chave id"</b>, ou rode o seu código: o que ele criar aparece aqui.</div></div>`;
		const recent = S.calls.slice(-14).reverse();
		const env = envLines();
		const project = S.ctx?.project;
		const runtimes = S.cloud?.runtimes || {};
		return `<div class="cs-main cs-pad cs-over" data-scroll="overview">
			<div class="cs-col cs-grow">
				<div class="cs-panel"><div class="cs-ph">${ic('cloud')}Serviços em uso <em>${plural(services.length, 'serviço', 'serviços')} · ${plural(S.resources.filter(r => r.service !== 'logs').length, 'recurso', 'recursos')}</em><span class="r"><button class="cs-btn sm" data-act="view" data-view="catalog">${ic('library')}Ver catálogo</button></span></div>
				<div class="cs-pb">${boxes}</div></div>
				<div class="cs-panel cs-grow"><div class="cs-ph">${ic('swap')}Chamadas recentes<span class="r"><button class="cs-btn sm" data-act="view" data-view="calls">Ver todas</button></span></div>
				<div class="cs-pb np">${recent.length ? callsTable(recent, false) : `<div class="cs-empty">Nenhuma chamada ainda. Quando o app, os testes ou o agente falarem com a nuvem local, as chamadas aparecem aqui.</div>`}</div></div>
			</div>
			<div class="cs-col cs-side">
				<div class="cs-panel"><div class="cs-ph">${ic('fileAdd')}Conectar o seu código</div><div class="cs-pb">
					<div class="cs-kv"><span>Endereço</span><span class="m">${esc(S.cloud?.endpoint || '')}</span><span>Região</span><span class="m">${esc(S.cloud?.region || '')}</span><span>Conta</span><span class="m">000000000000</span><span>Chaves</span><span>qualquer valor, por exemplo test</span></div>
					<pre class="cs-code nl">${env.map((line, i) => `<span class="ln">${i + 1}</span>${esc(line)}`).join('\n')}</pre>
					<p class="cs-dim small">O boto3 1.28+ e o SDK para JavaScript v3 leem <code>AWS_ENDPOINT_URL</code> sozinhos. Com o arquivo, o seu código fala com a nuvem local sem mudar nenhuma linha.</p>
					<div class="cs-actions"><button class="cs-btn" data-act="copy-env">${ic('copy')}Copiar</button><button class="cs-btn primary" data-act="env" ${project ? '' : 'disabled title="Abra o CloudStudio a partir de um projeto"'}>${ic('fileAdd')}Criar .env.local</button></div>
				</div></div>
				<div class="cs-panel"><div class="cs-ph">${ic('history')}Esta sessão</div><div class="cs-pb">
					<div class="cs-kv"><span>Ligada desde</span><span>${clock(S.cloud?.startedAt)} · ${since(S.cloud?.startedAt || Date.now() / 1000)}</span>
					<span>Partida</span><span>${S.cloud?.readyMs ? `${S.cloud.readyMs} ms` : '—'}</span>
					<span>Dados</span><span>${S.cloud?.storage === 'persistent' ? 'guardados entre sessões' : 'só na memória'}</span>
					<span>Python</span><span>${runtimes.python ? esc(runtimes.python) : '<span class="cs-dim">não encontrado</span>'}</span>
					<span>Node.js</span><span>${runtimes.node ? esc(runtimes.node) : '<span class="cs-dim">não encontrado</span>'}</span>
					<span>Chamadas</span><span>${S.callTotal}${S.errorTotal ? ` · ${ic('error', 'c-bad')}${plural(S.errorTotal, 'erro', 'erros')}` : ''}</span></div>
				</div></div>
			</div></div>`;
	}

	// ------------------------------------------------------------------ calls

	function sourceLabel(call) {
		const source = call.source || 'app';
		const [kind, ...rest] = source.split(':');
		const name = rest.join(':');
		const words = { fn: 'função', lambda: 'função', sqs: 'fila', sns: 'tópico', api: 'API', schedule: 'agendamento', rule: 'regra', sfn: 'fluxo', s3: 'bucket' };
		if (source === 'app') { return `${ic('app', 'c-dim')}App${call.client && call.client !== 'CloudStudio' ? ` <span class="cs-dim">${esc(call.client)}</span>` : ''}`; }
		if (source === 'agent') { return `${ic('agent', 'c-dim')}Agente`; }
		if (words[kind]) { return `${ic(kind === 'fn' || kind === 'lambda' ? 'lambda' : kind === 'sqs' ? 'inbox' : kind === 'sns' ? 'broadcast' : kind === 'api' ? 'globe' : kind === 'sfn' ? 'flow' : kind === 'schedule' ? 'clock' : kind === 's3' ? 'bucket' : 'bolt', 'c-dim')}${esc(name)}`; }
		return esc(source);
	}

	function callsTable(list, selectable) {
		const rows = list.map(c => {
			const bad = !!c.error;
			const sel = selectable && S.callSel === c.id;
			return `<tr class="${bad ? 'mk-bad' : ''} ${sel ? 'sel' : ''}" data-act="call" data-id="${c.id}">
				<td class="m">${clock(c.at, true)}</td><td>${sourceLabel(c)}</td><td>${esc(SERVICE_LABEL[c.service] || c.service)}</td><td>${esc(c.op)}</td>
				<td class="d">${esc(c.target || '')}</td><td class="r">${bad ? ic('error', 'c-bad') : ''}${c.status}</td><td class="r d">${Math.round(c.ms)}</td></tr>`;
		}).join('');
		return `<div class="cs-scroll" data-scroll="calls-${selectable ? 'all' : 'recent'}"><table class="cs-tbl"><colgroup><col style="width:104px"><col style="width:20%"><col style="width:16%"><col style="width:18%"><col><col style="width:68px"><col style="width:52px"></colgroup>
			<thead><tr><th>Hora</th><th>Origem</th><th>Serviço</th><th>Operação</th><th>Recurso</th><th class="r">Status</th><th class="r">ms</th></tr></thead><tbody>${rows}</tbody></table></div>`;
	}

	function explain(call) {
		const error = call.error;
		if (!error) { return ''; }
		const message = error.message || '';
		let match;
		if ((match = /Missing the key (\S+) in the item/.exec(message))) {
			return `O item enviado não tem o atributo <code>${esc(match[1])}</code>, que é a chave da tabela. Confira o nome do campo no código: ele precisa ser exatamente <code>${esc(match[1])}</code>.`;
		}
		if (/provided key element does not match the schema/.test(message)) {
			return 'A chave usada na busca não bate com a chave da tabela: faltou um atributo da chave, sobrou outro, ou o tipo é diferente (texto e número não se misturam).';
		}
		if (/Type mismatch for (Index )?Key/.test(message)) {
			return 'Um atributo de chave foi enviado com o tipo errado (por exemplo número em vez de texto).';
		}
		if (error.code === 'ConditionalCheckFailedException') {
			return 'A gravação tinha uma condição (por exemplo "só se ainda não existir") e a condição não foi atendida.';
		}
		if (['ResourceNotFoundException', 'NoSuchBucket', 'QueueDoesNotExist', 'AWS.SimpleQueueService.NonExistentQueue', 'NotFound', 'ParameterNotFound', 'StateMachineDoesNotExist'].includes(error.code)) {
			return `O recurso não existe nesta conta e região da nuvem local (${esc(call.account)} · ${esc(call.region)}). Ele pode ter outro nome, outra região, ou ainda não ter sido criado.`;
		}
		if (error.code === 'NoSuchKey') {
			return 'O bucket existe, mas não tem um arquivo com esse nome.';
		}
		if (error.code === 'NotImplemented' || error.code === 'UnknownOperationException') {
			return 'Esse serviço ou operação ainda não é emulado pelo CloudStudio. Veja o catálogo de serviços.';
		}
		if (/No module named '(boto3|botocore)'/.test(message)) {
			return 'A função usa o boto3, que a AWS já traz mas o Python deste computador não tem. Instale com <code>py -m pip install boto3</code>.';
		}
		if (call.service === 'lambda') {
			return `A função terminou com erro: <code>${esc(error.code)}</code>. Os logs da função mostram onde.`;
		}
		return '';
	}

	function callDetail(call) {
		if (!call) {
			return `<div class="cs-empty">Escolha uma chamada para ver o pedido, a resposta e o erro.</div>`;
		}
		const why = explain(call);
		const error = call.error ? `<div class="cs-note mk mk-bad">${ic('error', 'c-bad')}<div><b>${esc(call.error.code)}</b><div class="cs-m wrap">${esc(call.error.message)}</div>${why ? `<div class="gap">${why}</div>` : ''}</div></div>` : '';
		return `<div class="cs-pb" data-scroll="call-detail">
			<div class="cs-kv"><span>Hora</span><span class="m">${clock(call.at, true)}</span><span>Origem</span><span>${sourceLabel(call)}</span>
			<span>Serviço</span><span>${esc(SERVICE_LABEL[call.service] || call.service)}</span><span>Operação</span><span class="m">${esc(call.op)}</span>
			<span>Recurso</span><span class="m">${esc(call.target || '—')}</span><span>Conta · região</span><span class="m">${esc(call.account)} · ${esc(call.region)}</span>
			<span>Resultado</span><span>${call.error ? ic('error', 'c-bad') : ic('passed', 'c-ok')}${call.status} · ${Math.round(call.ms)} ms</span></div>
			${error}
			${call.req ? `<div class="cs-h">Pedido</div>${code(call.req)}` : ''}
			${call.res ? `<div class="cs-h">Resposta</div>${code(call.res)}` : ''}
			${call.error ? `<div class="cs-actions"><button class="cs-btn primary" data-act="explain" data-id="${call.id}">${ic('comment')}Pedir ao agente para corrigir</button></div>` : ''}
		</div>`;
	}

	function callsView() {
		const filters = [['all', 'Todas'], ['errors', 'Com erro'], ['app', 'Do app'], ['functions', 'Das funções'], ['agent', 'Do agente']];
		let list = S.calls;
		if (S.callFilter === 'errors') { list = list.filter(c => c.error); }
		if (S.callFilter === 'app') { list = list.filter(c => c.source === 'app'); }
		if (S.callFilter === 'functions') { list = list.filter(c => (c.source || '').startsWith('fn:')); }
		if (S.callFilter === 'agent') { list = list.filter(c => c.source === 'agent'); }
		list = list.slice(-300).reverse();
		const selected = S.calls.find(c => c.id === S.callSel) || null;
		return `<div class="cs-main cs-split">
			<div class="cs-col cs-grow"><div class="cs-filters">${filters.map(([id, label]) => `<button class="cs-chip ${S.callFilter === id ? 'on' : ''}" data-act="call-filter" data-id="${id}">${label}${id === 'errors' && S.errorTotal ? ` <em>${S.errorTotal}</em>` : ''}</button>`).join('')}
				<span class="cs-sp"></span><span class="cs-dim">${plural(S.callTotal, 'chamada', 'chamadas')} desde que ligou</span></div>
				<div class="cs-panel cs-grow flat">${list.length ? callsTable(list, true) : `<div class="cs-empty">Nenhuma chamada ${S.callFilter === 'errors' ? 'com erro' : 'ainda'}.</div>`}</div></div>
			<div class="cs-panel cs-detail"><div class="cs-ph">${ic('swap')}Chamada${selected ? ` <em>${esc(selected.op)}</em>` : ''}</div>${callDetail(selected)}</div>
		</div>`;
	}

	// ------------------------------------------------------------------ logs

	function logsView() {
		const logKey = l => JSON.stringify([l.account || '000000000000', l.region || S.cloud?.region || '', l.group]);
		const groups = [...new Set(S.logs.map(logKey))].sort();
		const logLabel = g => { const [account, region, name] = JSON.parse(g); return `${name.replace('/aws/lambda/', 'λ ')} · ${account} · ${region}`; };
		const group = S.logGroup && groups.includes(S.logGroup) ? S.logGroup : '';
		const lines = S.logs.filter(l => !group || logKey(l) === group).slice(-500);
		const level = l => l.level === 'error' ? ic('error', 'c-bad') : l.level === 'system' ? ic('dot', 'c-dim sm') : ic('info', 'c-run');
		const body = lines.map(l => `<div class="ll ${l.level === 'system' ? 'sys' : ''}"><span class="t">${clock(l.at, true)}</span>${level(l)}${group ? '' : `<span class="g">${esc(l.group.replace('/aws/lambda/', 'λ '))}</span>`}<span class="x">${esc(l.text)}</span></div>`).join('');
		return `<div class="cs-main cs-pad">
			<div class="cs-filters"><button class="cs-chip ${!group ? 'on' : ''}" data-act="log-group" data-id="">Todos</button>
			${groups.map(g => `<button class="cs-chip ${group === g ? 'on' : ''}" data-act="log-group" data-id="${esc(g)}">${esc(logLabel(g))}</button>`).join('')}
			<span class="cs-sp"></span><span class="cs-dim">${ic('dot', cloudOn() ? 'c-ok sm' : 'c-dim sm')}${cloudOn() ? 'ao vivo' : 'desligada'}</span></div>
			<div class="cs-log cs-grow" data-scroll="logs" data-stick="1">${body || '<div class="cs-empty">Sem logs ainda. As funções escrevem aqui o que imprimem (print, console.log) e o resumo de cada execução.</div>'}</div></div>`;
	}

	// ------------------------------------------------------------------ resources tree and detail

	function resourcesView() {
		const groups = byService();
		const filter = S.filter.toLowerCase();
		let sel = selectedResource(S.sel);
		if (!sel && !S.sel && S.resources.length) {
			sel = S.resources.find(r => r.service !== 'logs') || S.resources[0];
			S.sel = keyOf(sel);
		}
		if (sel) { S.sel = keyOf(sel); }
		const tree = ORDER.filter(s => groups[s]).map(service => {
			const k = KINDS[service];
			const items = groups[service].filter(r => !filter || r.name.toLowerCase().includes(filter));
			if (!items.length) { return ''; }
			const open = S.open.has(service) || !!filter;
			const rows = open ? items.map(r => {
				const mark = resourceMark(r);
				return `<div class="cs-tr ${S.sel === keyOf(r) ? 'sel' : ''} ${mark ? `mk mk-${mark}` : ''}" data-act="select" data-key="${esc(keyOf(r))}" style="padding-left:30px"><span class="nm" title="${esc(namespaceText(r))}">${esc(r.name)}</span><em>${treeCount(r)}</em></div>`;
			}).join('') : '';
			return `<div class="cs-tr g" data-act="toggle" data-service="${service}"><span class="tw">${ic(open ? 'chevD' : 'chevR')}</span>${ic(k.icon, 'si')}<span class="nm">${k.group}</span><em>${items.length}</em></div>${rows}`;
		}).join('');
		return `<div class="cs-main cs-row-main">
			<div class="cs-tree"><div class="cs-th">${ic('tree')}Recursos <em>· ${S.resources.length}</em></div>
				<div class="cs-tsearch"><span class="cs-in">${ic('search')}<input data-act="filter" data-draft="tree-filter" placeholder="Filtrar recursos" value="${esc(S.filter)}"></span></div>
				<div class="cs-tbody" data-scroll="tree">${tree || '<div class="cs-empty">Nada ainda.</div>'}</div></div>
			<div class="cs-col cs-grow">${sel ? detail(sel) : '<div class="cs-empty">Escolha um recurso à esquerda.</div>'}</div>
		</div>`;
	}

	function treeCount(r) {
		switch (r.service) {
			case 's3': case 'dynamodb': case 'logs': return r.count;
			case 'sqs': return r.count;
			case 'lambda': return (r.invocations || []).length || '';
			case 'stepfunctions': return r.executions.length || '';
		}
		return '';
	}

	function header(r, extra) {
		const k = KINDS[r.service];
		return `<div class="cs-dh">${ic(k.icon)}<b>${esc(r.name)}</b><span class="cs-badge emu">Emulado</span><span class="cs-dim">${esc(namespaceText(r))} · ${extra || ''}</span>
			<span class="cs-sp"></span><button class="cs-btn sm" data-act="ask-about" data-key="${esc(keyOf(r))}">${ic('comment')}Perguntar ao agente</button></div>`;
	}

	function detail(r) {
		switch (r.service) {
			case 's3': return bucketDetail(r);
			case 'dynamodb': return tableDetail(r);
			case 'lambda': return functionDetail(r);
			case 'apigatewayv2': return apiDetail(r);
			case 'sqs': return queueDetail(r);
			case 'sns': return topicDetail(r);
			case 'stepfunctions': return machineDetail(r);
			case 'scheduler': return scheduleDetail(r);
			case 'events': return ruleDetail(r);
			case 'secretsmanager': return secretDetail(r);
			case 'ssm': return parameterDetail(r);
			case 'logs': return logGroupDetail(r);
		}
		return '';
	}

	function draft(key, fallback) {
		return S.drafts[key] !== undefined ? S.drafts[key] : fallback;
	}

	function bucketDetail(r) {
		const selKey = S.itemSel[keyOf(r)];
		const selected = r.objects.find(o => o.key === selKey) || r.objects[0];
		const rows = r.objects.map(o => `<tr class="${selected && o.key === selected.key ? 'sel' : ''}" data-act="item" data-key="${esc(keyOf(r))}" data-item="${esc(o.key)}">
			<td class="m">${ic('file', 'c-dim')} ${esc(o.key)}</td><td class="r">${bytes(o.size)}</td><td class="d">${esc(o.type)}</td><td class="d">${dateTime(o.modified)}</td></tr>`).join('');
		let preview = '<div class="cs-empty">Sem arquivos.</div>';
		if (selected) {
			const body = selected.image ? `<div class="cs-img"><img src="${selected.image}" alt=""></div>`
				: selected.text !== undefined ? code(selected.text)
					: `<div class="cs-empty">Prévia só para textos até 4 KB e imagens até 96 KB.</div>`;
			preview = `<div class="cs-kv"><span>Arquivo</span><span class="m">${esc(selected.key)}</span><span>Tamanho</span><span>${bytes(selected.size)}</span><span>Tipo</span><span class="m">${esc(selected.type)}</span><span>ETag</span><span class="m">${esc(selected.etag)}</span>
				${Object.entries(selected.meta || {}).map(([k, v]) => `<span>x-amz-meta-${esc(k)}</span><span class="m">${esc(v)}</span>`).join('')}</div>${body}`;
		}
		const events = r.notifications.length ? `<div class="cs-h">Eventos do bucket</div>${r.notifications.map(n => `<div class="cs-li">${ic('bolt', 'c-dim')}${esc(n.events.join(', '))} → ${esc(tail(n.target))}</div>`).join('')}` : '';
		return `${header(r, `${plural(r.count, 'objeto', 'objetos')} · ${bytes(r.bytes)} · ${esc(r.region)}`)}
			<div class="cs-split cs-grow"><div class="cs-panel cs-grow flat"><div class="cs-scroll" data-scroll="objects"><table class="cs-tbl"><colgroup><col><col style="width:80px"><col style="width:26%"><col style="width:96px"></colgroup>
			<thead><tr><th>Chave</th><th class="r">Tamanho</th><th>Tipo</th><th>Alterado</th></tr></thead><tbody>${rows}</tbody></table></div></div>
			<div class="cs-panel cs-detail"><div class="cs-ph">${ic('file')}Prévia</div><div class="cs-pb" data-scroll="object">${preview}${events}</div></div></div>`;
	}

	function marker(value, key, type) {
		return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1
			&& Object.hasOwn(value, key) && type(value[key]);
	}
	const numberValue = value => marker(value, '$n', v => typeof v === 'string');
	const setValue = value => marker(value, '$set', Array.isArray);
	const binaryValue = value => marker(value, '$b', v => Number.isFinite(v) && v >= 0);
	const mapValue = value => marker(value, '$map', v => v !== null && typeof v === 'object' && !Array.isArray(v));
	const plainMap = value => Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plainJson(v)]));
	function itemValue(value) {
		if (value === null) { return '<span class="cs-dim">null</span>'; }
		if (typeof value === 'object') {
			if (numberValue(value)) { return esc(value.$n); }
			if (setValue(value)) { return esc(value.$set.map(v => numberValue(v) ? v.$n : String(v)).join(', ')); }
			if (binaryValue(value)) { return `<span class="cs-dim">${esc(value.$b)} bytes</span>`; }
			return esc(JSON.stringify(plainJson(value)));
		}
		return esc(String(value));
	}

	function plainJson(value) {
		if (value === null || typeof value !== 'object') { return value; }
		if (Array.isArray(value)) { return value.map(plainJson); }
		if (mapValue(value)) { return plainMap(value.$map); }
		if (numberValue(value)) { return value.$n; }
		if (setValue(value)) { return value.$set.map(plainJson); }
		if (binaryValue(value)) { return `<${value.$b} bytes>`; }
		return plainMap(value);
	}

	function kindLetter(value) {
		if (value === null) { return 'NULL'; }
		if (typeof value === 'string') { return 'S'; }
		if (typeof value === 'boolean') { return 'BOOL'; }
		if (Array.isArray(value)) { return 'L'; }
		if (numberValue(value)) { return 'N'; }
		if (setValue(value)) { return 'SS'; }
		if (binaryValue(value)) { return 'B'; }
		return 'M';
	}

	function tableDetail(r) {
		const keys = [r.key.hash, r.key.range].filter(Boolean);
		const attributes = new Set(keys);
		r.items.forEach(item => Object.keys(item).forEach(a => attributes.add(a)));
		const columns = [...attributes].slice(0, 8);
		const id = item => keys.map(k => itemValue(item[k])).join(' · ');
		const selected = r.items.find(item => id(item) === S.itemSel[keyOf(r)]) || r.items[r.items.length - 1];
		const rows = r.items.slice().reverse().map(item => `<tr class="${selected === item ? 'sel' : ''}" data-act="item" data-key="${esc(keyOf(r))}" data-item="${esc(id(item))}">${columns.map(c => `<td class="${keys.includes(c) ? 'm' : ''}">${item[c] === undefined ? '' : itemValue(item[c])}</td>`).join('')}</tr>`).join('');
		const form = selected ? `<table class="cs-tbl"><colgroup><col style="width:34%"><col style="width:44px"><col></colgroup><thead><tr><th>Atributo</th><th>Tipo</th><th>Valor</th></tr></thead><tbody>
			${Object.entries(selected).map(([k, v]) => `<tr><td class="m">${keys.includes(k) ? ic('key', 'c-dim') + ' ' : ''}${esc(k)}</td><td class="c d">${kindLetter(v)}</td><td class="m">${itemValue(v)}</td></tr>`).join('')}</tbody></table>
			${code(JSON.stringify(plainMap(selected)))}` : '<div class="cs-empty">A tabela está vazia.</div>';
		const indexes = r.indexes.length ? r.indexes.map(i => `${esc(i.name)} (${esc(i.keys.filter(Boolean).join(' + '))})`).join(', ') : 'nenhum';
		const ttl = r.ttl && r.ttl.enabled ? ` · expira por ${esc(r.ttl.attribute)}` : '';
		return `${header(r, `${plural(r.count, 'item', 'itens')} · ${bytes(r.bytes)} · chave ${esc(keys.join(' + '))} · índices: ${indexes}${ttl}`)}
			<div class="cs-split cs-grow"><div class="cs-panel cs-grow flat"><div class="cs-scroll" data-scroll="items"><table class="cs-tbl"><thead><tr>${columns.map(c => `<th>${keys.includes(c) ? ic('key', 'c-dim') + ' ' : ''}${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>
			${r.count > r.items.length ? `<div class="cs-empty">Mostrando os últimos ${r.items.length} de ${r.count} itens.</div>` : ''}</div></div>
			<div class="cs-panel cs-detail"><div class="cs-ph">${ic('database')}Item${selected ? ` <em>${id(selected)}</em>` : ''}</div><div class="cs-pb" data-scroll="item">${form}</div></div></div>`;
	}

	function functionDetail(r) {
		const invocations = r.invocations || [];
		const selected = invocations.find(i => i.request === S.itemSel[keyOf(r)]) || invocations[0];
		const env = r.env.length ? r.env.map(name => `<span class="cs-tag ${r.envEmpty.includes(name) ? 'mk mk-you' : ''}">${esc(name)}${r.envEmpty.includes(name) ? ' · vazia' : ''}</span>`).join(' ') : '<span class="cs-dim">nenhuma</span>';
		const triggers = r.triggers.length ? r.triggers.map(t => `<div class="cs-li">${ic('inbox', 'c-dim')}fila ${esc(tail(t.source))}<em>${t.batch} por vez${t.last ? ` · ${esc(t.last === 'OK' ? 'último lote ok' : 'último lote falhou')}` : ''}</em></div>`).join('') : '';
		const apis = S.resources.filter(a => a.service === 'apigatewayv2' && sameNamespace(a, r) && a.routes.some(route => route.function === r.name))
			.map(a => a.routes.filter(route => route.function === r.name).map(route => `<div class="cs-li">${ic('globe', 'c-dim')}${esc(a.name)} <span class="cs-m">${esc(route.key)}</span></div>`).join('')).join('');
		const rows = invocations.map(i => `<tr class="${selected === i ? 'sel' : ''} ${i.ok ? '' : 'mk-bad'}" data-act="item" data-key="${esc(keyOf(r))}" data-item="${esc(i.request)}">
			<td class="m">${clock(i.at, true)}</td><td>${sourceLabel({ source: i.source })}</td><td>${i.ok ? ic('passed', 'c-ok') + 'ok' : ic('error', 'c-bad') + esc(i.error || 'erro')}</td><td class="r d">${Math.round(i.ms)}</td></tr>`).join('');
		const event = draft(`event:${keyOf(r)}`, '{\n  \n}');
		return `${header(r, `${esc(r.runtime)} · ${esc(r.handler)} · ${r.timeout} s · ${r.memory} MB`)}
			<div class="cs-split cs-grow"><div class="cs-col cs-grow">
				<div class="cs-panel"><div class="cs-ph">${ic('gear')}Configuração</div><div class="cs-pb">
					<div class="cs-kv"><span>Código</span><span class="m">${r.code.dir ? `${ic('folder', 'c-dim')}${esc(r.code.dir)}` : `zip · ${bytes(r.code.size)}`}</span>
					<span>Variáveis</span><span class="wrap">${env}</span></div>
					${r.code.dir ? '<p class="cs-dim small">O código é lido da pasta a cada execução: salve o arquivo e chame de novo.</p>' : ''}
					${triggers || apis ? `<div class="cs-h">Quem chama esta função</div>${apis}${triggers}` : ''}
				</div></div>
				<div class="cs-panel cs-grow"><div class="cs-ph">${ic('history')}Execuções <em>${invocations.length}</em></div><div class="cs-scroll" data-scroll="invocations">
					${rows ? `<table class="cs-tbl"><colgroup><col style="width:104px"><col><col style="width:38%"><col style="width:60px"></colgroup><thead><tr><th>Hora</th><th>Quem chamou</th><th>Resultado</th><th class="r">ms</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="cs-empty">Ainda não rodou.</div>'}</div></div>
			</div>
			<div class="cs-panel cs-detail"><div class="cs-ph">${ic('play')}Testar</div><div class="cs-pb" data-scroll="fn-detail">
				<div class="cs-fl">Evento (JSON)</div><textarea class="cs-ta" rows="6" data-draft="event:${esc(keyOf(r))}" spellcheck="false">${esc(event)}</textarea>
				<div class="cs-actions"><button class="cs-btn primary" data-act="invoke" data-name="${esc(r.name)}" data-key="${esc(keyOf(r))}" ${cloudOn() ? '' : 'disabled'}>${ic('play')}Invocar</button></div>
				${selected ? `<div class="cs-h">${selected.ok ? ic('passed', 'c-ok') : ic('error', 'c-bad')}Execução das ${clock(selected.at)}<span class="r cs-dim">${Math.round(selected.ms)} ms</span></div>
				${selected.ok ? '' : `<div class="cs-note mk mk-bad">${ic('error', 'c-bad')}<div><b>${esc(selected.error)}</b><div class="cs-m wrap">${esc(selected.message || '')}</div></div></div>`}
				<div class="cs-fl">Evento</div>${code(selected.event)}<div class="cs-fl">Resposta</div>${code(selected.result)}
				<div class="cs-actions"><button class="cs-btn" data-act="logs-of" data-name="${esc(r.name)}" data-key="${esc(keyOf(r))}">${ic('output')}Ver logs</button></div>` : ''}
			</div></div></div>`;
	}

	/** The method and path the test form starts with: the API's first route. */
	function apiDefaults(r) {
		const key = r.routes.find(route => route.key !== '$default')?.key || 'GET /';
		const [verb, path] = key.split(' ');
		return { method: verb === 'ANY' ? 'GET' : verb, path: (path || '/').replace(/\{[^}]+\}/g, '1') };
	}

	function apiDetail(r) {
		const defaults = apiDefaults(r);
		const method = draft(`method:${keyOf(r)}`, defaults.method);
		const path = draft(`path:${keyOf(r)}`, defaults.path);
		const body = draft(`body:${keyOf(r)}`, '');
		const calls = S.calls.filter(c => c.service === 'apigatewayv2' && sameNamespace(c, r) && c.target === r.name && /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /.test(c.op)).slice(-30).reverse();
		const routes = r.routes.map(route => `<tr><td class="m">${esc(route.key)}</td><td>${route.function ? `${ic('lambda', 'c-dim')}<a class="cs-link" data-act="select" data-key="${esc(keyOf({ ...r, service: 'lambda', name: route.function }))}">${esc(route.function)}</a>` : esc(route.uri || route.type || '')}</td></tr>`).join('');
		return `${header(r, `${plural(r.routes.length, 'rota', 'rotas')}${r.cors ? ' · CORS liberado' : ''}`)}
			<div class="cs-split cs-grow"><div class="cs-col cs-grow">
				<div class="cs-panel"><div class="cs-ph">${ic('globe')}Endereço</div><div class="cs-pb"><div class="cs-in m">${esc(r.url)}</div><p class="cs-dim small">O app, o navegador ou o curl chamam as rotas a partir deste endereço.</p></div></div>
				<div class="cs-panel"><div class="cs-ph">${ic('tree')}Rotas</div><div class="cs-pb np"><table class="cs-tbl"><colgroup><col style="width:50%"><col></colgroup><thead><tr><th>Rota</th><th>Chama</th></tr></thead><tbody>${routes}</tbody></table></div></div>
				<div class="cs-panel cs-grow"><div class="cs-ph">${ic('swap')}Pedidos recebidos</div><div class="cs-pb np">${calls.length ? callsTable(calls, false) : '<div class="cs-empty">Nenhum pedido ainda.</div>'}</div></div>
			</div>
			<div class="cs-panel cs-detail"><div class="cs-ph">${ic('play')}Testar uma rota</div><div class="cs-pb">
				<div class="cs-row"><select class="cs-in" data-draft="method:${esc(keyOf(r))}">${['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map(m => `<option ${m === method ? 'selected' : ''}>${m}</option>`).join('')}</select>
				<input class="cs-in m cs-grow" data-draft="path:${esc(keyOf(r))}" value="${esc(path)}" spellcheck="false"></div>
				<div class="cs-fl">Corpo (JSON, opcional)</div><textarea class="cs-ta" rows="6" data-draft="body:${esc(keyOf(r))}" spellcheck="false">${esc(body)}</textarea>
				<div class="cs-actions"><button class="cs-btn primary" data-act="request" data-name="${esc(r.name)}" data-key="${esc(keyOf(r))}" ${cloudOn() ? '' : 'disabled'}>${ic('send')}Enviar</button></div>
			</div></div></div>`;
	}

	function queueDetail(r) {
		const dlq = r.dlq ? S.resources.find(q => q.service === 'sqs' && q.arn === r.dlq.arn) : null;
		const sources = S.resources.filter(q => q.service === 'sqs' && q.dlq && q.dlq.arn === r.arn);
		const state = { visible: 'na fila', inflight: 'em processamento', delayed: 'atrasada' };
		const rows = r.messages.map(m => `<tr><td class="m">${esc(m.body.slice(0, 160))}</td><td>${state[m.state]}</td><td class="r">${m.receives}</td><td class="d">${clock(m.sent)}</td></tr>`).join('');
		const message = draft(`message:${keyOf(r)}`, '');
		return `${header(r, `${r.fifo ? 'FIFO · ' : ''}${r.visible} na fila · ${r.inflight} em processamento${r.delayed ? ` · ${r.delayed} atrasadas` : ''}`)}
			<div class="cs-split cs-grow"><div class="cs-col cs-grow">
				${sources.length && r.count ? `<div class="cs-note mk mk-you">${ic('warning', 'c-you')}<div>Esta é a fila de falhas de <b>${sources.map(q => esc(q.name)).join(', ')}</b>: as ${plural(r.count, 'mensagem chegou', 'mensagens chegaram')} aqui depois de falhar ${sources[0].dlq.max} vezes. Veja os logs da função que lê a fila original.</div></div>` : ''}
				<div class="cs-panel"><div class="cs-ph">${ic('gear')}Configuração</div><div class="cs-pb"><div class="cs-kv"><span>URL</span><span class="m">${esc(r.url)}</span>
					<span>Visibilidade</span><span>${r.visibility} s</span><span>Fila de falhas</span><span>${r.dlq ? `${esc(tail(r.dlq.arn))} depois de ${r.dlq.max} tentativas${dlq ? ` · ${plural(dlq.count, 'mensagem', 'mensagens')}` : ''}` : '<span class="cs-dim">nenhuma</span>'}</span></div></div></div>
				<div class="cs-panel cs-grow"><div class="cs-ph">${ic('inbox')}Mensagens <em>${r.count}</em></div><div class="cs-scroll" data-scroll="messages">
					${rows ? `<table class="cs-tbl"><colgroup><col><col style="width:130px"><col style="width:76px"><col style="width:70px"></colgroup><thead><tr><th>Corpo</th><th>Estado</th><th class="r">Leituras</th><th>Enviada</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="cs-empty">A fila está vazia.</div>'}</div></div>
			</div>
			<div class="cs-panel cs-detail"><div class="cs-ph">${ic('send')}Enviar mensagem</div><div class="cs-pb">
				<textarea class="cs-ta" rows="6" data-draft="message:${esc(keyOf(r))}" spellcheck="false" placeholder='{"agendamento": "AG-1"}'>${esc(message)}</textarea>
				<div class="cs-actions"><button class="cs-btn primary" data-act="send" data-kind="fila" data-name="${esc(r.name)}" data-key="${esc(keyOf(r))}" ${cloudOn() ? '' : 'disabled'}>${ic('send')}Enviar</button></div>
			</div></div></div>`;
	}

	function topicDetail(r) {
		const rows = r.subscriptions.map(s => `<tr><td>${esc(s.protocol)}</td><td class="m">${esc(tail(s.endpoint) || s.endpoint)}</td><td>${s.confirmed ? ic('passed', 'c-ok') + 'confirmada' : ic('warning', 'c-you') + 'pendente'}</td><td class="d">${s.raw ? 'sem envelope' : ''}${s.filter ? ' · com filtro' : ''}</td></tr>`).join('');
		const message = draft(`message:${keyOf(r)}`, '');
		return `${header(r, `${plural(r.subscriptions.length, 'inscrição', 'inscrições')} · ${plural(r.published, 'publicação', 'publicações')}`)}
			<div class="cs-split cs-grow"><div class="cs-panel cs-grow"><div class="cs-ph">${ic('broadcast')}Inscrições</div><div class="cs-pb np">
				${rows ? `<table class="cs-tbl"><thead><tr><th>Tipo</th><th>Destino</th><th>Estado</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="cs-empty">Ninguém inscrito.</div>'}
				<p class="cs-dim small pad">E-mails e SMS não são enviados de verdade: a mensagem aparece nos logs.</p></div></div>
			<div class="cs-panel cs-detail"><div class="cs-ph">${ic('send')}Publicar</div><div class="cs-pb">
				<textarea class="cs-ta" rows="6" data-draft="message:${esc(keyOf(r))}" spellcheck="false">${esc(message)}</textarea>
				<div class="cs-actions"><button class="cs-btn primary" data-act="send" data-kind="tópico" data-name="${esc(r.name)}" data-key="${esc(keyOf(r))}" ${cloudOn() ? '' : 'disabled'}>${ic('send')}Publicar</button></div>
			</div></div></div>`;
	}

	function machineDetail(r) {
		const execution = r.executions.find(e => e.name === S.itemSel[keyOf(r)]) || r.executions[0];
		const status = {};
		if (execution) {
			for (const step of execution.steps) {
				const name = step.name.split(' › ').pop().replace(/^\d+: |^\[\d+\] /, '');
				status[name] = step.status;
			}
		}
		const states = r.states.map(s => {
			const st = status[s.name];
			const mark = st === 'failed' ? 'bad' : st === 'ok' ? 'ok' : st === 'running' ? 'run' : '';
			const next = [s.next, ...s.choices].filter(Boolean);
			return `<div class="cs-state ${mark ? `mk mk-${mark}` : ''}"><div class="nh">${st === 'failed' ? ic('error', 'c-bad') : st === 'ok' ? ic('passed', 'c-ok') : st === 'running' ? ic('spinner', 'spin c-run') : ic('ring', 'c-dim')}<b>${esc(s.name)}</b><span class="cs-dim">${esc(s.type)}</span></div>
				<div class="nb">${s.function ? `${ic('lambda', 'c-dim')}${esc(tail(s.function))}` : s.resource ? esc(s.resource.replace('arn:aws:states:::', '')) : ''}${next.length ? `<span class="cs-dim"> → ${esc(next.join(', '))}</span>` : s.end ? '<span class="cs-dim"> → fim</span>' : ''}${s.catch.length ? `<span class="cs-dim"> · em erro → ${esc(s.catch.join(', '))}</span>` : ''}</div></div>`;
		}).join('');
		const rows = r.executions.map(e => `<tr class="${execution === e ? 'sel' : ''} ${['FAILED', 'TIMED_OUT'].includes(e.status) ? 'mk-bad' : ''}" data-act="item" data-key="${esc(keyOf(r))}" data-item="${esc(e.name)}"><td class="m">${clock(e.started)}</td><td>${statusWord(e.status)}</td><td class="r d">${e.stopped ? Math.round((e.stopped - e.started) * 1000) : '…'}</td></tr>`).join('');
		const input = draft(`input:${keyOf(r)}`, '{\n  \n}');
		const failed = execution && execution.error ? `<div class="cs-note mk mk-bad">${ic('error', 'c-bad')}<div><b>${esc(execution.error)}</b><div class="cs-m wrap">${esc(execution.cause)}</div></div></div>` : '';
		return `${header(r, `${r.type === 'EXPRESS' ? 'Expressa' : 'Padrão'} · ${plural(r.states.length, 'estado', 'estados')} · começa em ${esc(r.start || '')}`)}
			<div class="cs-split cs-grow"><div class="cs-col cs-grow">
				<div class="cs-panel cs-grow"><div class="cs-ph">${ic('flow')}Fluxo${execution ? ` <em>execução das ${clock(execution.started)}</em>` : ''}</div><div class="cs-pb cs-states" data-scroll="states">${states}</div></div>
				<div class="cs-panel"><div class="cs-ph">${ic('history')}Execuções</div><div class="cs-scroll short" data-scroll="executions">${rows ? `<table class="cs-tbl"><thead><tr><th>Início</th><th>Estado</th><th class="r">ms</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="cs-empty">Ainda não rodou.</div>'}</div></div>
			</div>
			<div class="cs-panel cs-detail"><div class="cs-ph">${ic('play')}Executar</div><div class="cs-pb" data-scroll="sfn-detail">
				<div class="cs-fl">Entrada (JSON)</div><textarea class="cs-ta" rows="5" data-draft="input:${esc(keyOf(r))}" spellcheck="false">${esc(input)}</textarea>
				<div class="cs-actions"><button class="cs-btn primary" data-act="run" data-name="${esc(r.name)}" data-key="${esc(keyOf(r))}" ${cloudOn() ? '' : 'disabled'}>${ic('play')}Executar</button></div>
				${failed}${execution ? `<div class="cs-fl">Entrada</div>${code(execution.input)}${execution.output ? `<div class="cs-fl">Saída</div>${code(execution.output)}` : ''}` : ''}
			</div></div></div>`;
	}

	function scheduleDetail(r) {
		const runs = (r.runs || []).slice().reverse().map(run => `<div class="cs-li">${ic('passed', 'c-ok')}${dateTime(run.at)}${run.manual ? ' <span class="cs-dim">manual</span>' : ''}</div>`).join('');
		return `${header(r, `${esc(r.expression)} · ${esc(r.timezone)}`)}
			<div class="cs-pad cs-col cs-grow"><div class="cs-panel"><div class="cs-ph">${ic('clock')}Agendamento</div><div class="cs-pb"><div class="cs-kv">
				<span>Expressão</span><span class="m">${esc(r.expression)}</span><span>Fuso</span><span>${esc(r.timezone)}</span>
				<span>Próxima vez</span><span>${r.next ? `${dateTime(r.next)} (horário deste computador)` : '—'}</span><span>Estado</span><span>${r.state === 'ENABLED' ? 'ligado' : 'desligado'}</span>
				<span>Destino</span><span class="m">${esc(tail(r.target))}</span><span>Grupo</span><span>${esc(r.group)}</span></div>
				${r.input && r.input !== '{}' ? `<div class="cs-fl">Entrada enviada</div>${code(r.input)}` : ''}
				<p class="cs-dim small">Os agendamentos só disparam enquanto a nuvem local está ligada.</p></div></div>
			<div class="cs-panel"><div class="cs-ph">${ic('history')}Últimas vezes</div><div class="cs-pb">${runs || '<span class="cs-dim">Ainda não disparou.</span>'}</div></div></div>`;
	}

	function ruleDetail(r) {
		return `${header(r, `${r.expression ? esc(r.expression) : 'por padrão de evento'} · barramento ${esc(r.bus)}`)}
			<div class="cs-pad cs-col cs-grow"><div class="cs-panel"><div class="cs-ph">${ic('bolt')}Regra</div><div class="cs-pb"><div class="cs-kv">
				<span>Estado</span><span>${r.state === 'ENABLED' ? 'ligada' : 'desligada'}</span><span>Eventos aceitos</span><span>${r.matched || 0}</span>
				<span>Destinos</span><span class="m">${r.targets.map(t => esc(tail(t))).join(', ') || '—'}</span>${r.next ? `<span>Próxima vez</span><span>${dateTime(r.next)}</span>` : ''}</div>
				${r.pattern ? `<div class="cs-fl">Padrão</div>${code(r.pattern)}` : ''}</div></div></div>`;
	}

	function secretDetail(r) {
		return `${header(r, `${plural(r.versions, 'versão', 'versões')}${r.deleted ? ' · marcado para apagar' : ''}`)}
			<div class="cs-pad cs-col cs-grow">
				${r.empty ? `<div class="cs-note mk mk-you">${ic('warning', 'c-you')}<div>Este segredo está <b>vazio</b>.${r.source ? ` Ele vem da variável <code>${esc(r.source)}</code> do <code>.env</code> do projeto: preencha o valor lá e peça ao agente para atualizar o segredo.` : ''} Quem ler o segredo recebe um valor vazio.</div></div>` : ''}
				<div class="cs-panel"><div class="cs-ph">${ic('lock')}Segredo</div><div class="cs-pb"><div class="cs-kv">
					<span>Valor</span><span>${r.empty ? '<span class="cs-dim">vazio</span>' : `${ic('lock', 'c-dim')}•••••• <span class="cs-dim">${plural(r.size, 'caractere', 'caracteres')}</span>`}</span>
					${r.keys ? `<span>Campos</span><span class="m">${esc(r.keys.join(', '))}</span>` : ''}
					<span>Origem</span><span>${r.source ? `variável <code>${esc(r.source)}</code> do .env` : 'criado pelo app'}</span>
					<span>Alterado</span><span>${dateTime(r.changed)}</span><span>Última leitura</span><span>${r.accessed ? dateTime(r.accessed) : '—'}</span></div>
					<p class="cs-dim small">O valor fica só neste computador. Ele nunca aparece no Studio, nas chamadas nem no chat.</p></div></div></div>`;
	}

	function parameterDetail(r) {
		return `${header(r, `${esc(r.type)} · versão ${r.version}`)}
			<div class="cs-pad cs-col cs-grow"><div class="cs-panel"><div class="cs-ph">${ic('sliders')}Parâmetro</div><div class="cs-pb"><div class="cs-kv">
				<span>Valor</span><span class="m">${r.value === null ? `${ic('lock', 'c-dim')}•••••• <span class="cs-dim">protegido</span>` : esc(r.value)}</span>
				<span>Tipo</span><span>${esc(r.type)}</span><span>Versão</span><span>${r.version}</span><span>Alterado</span><span>${dateTime(r.created)}</span></div></div></div></div>`;
	}

	function logGroupDetail(r) {
		return `${header(r, `${plural(r.streams, 'fluxo', 'fluxos')} · ${plural(r.count, 'linha', 'linhas')}`)}
			<div class="cs-pad"><button class="cs-btn" data-act="logs-group" data-id="${esc(JSON.stringify([r.account || '000000000000', r.region || '', r.name]))}">${ic('output')}Abrir nos logs</button></div>`;
	}

	// ------------------------------------------------------------------ map

	const LAYERS = { apigatewayv2: 0, scheduler: 0, events: 0, lambda: 1, stepfunctions: 1, sns: 2, sqs: 2, dynamodb: 3, s3: 3, secretsmanager: 3, ssm: 3 };

	function mapGraph() {
		const nodes = S.resources.filter(r => r.service in LAYERS).map(r => ({ r, key: keyOf(r), layer: LAYERS[r.service] }));
		const byArn = new Map(nodes.map(n => [n.r.arn, n]));
		const byKey = new Map(nodes.map(n => [n.key, n]));
		const find = (service, name, scope) => byKey.get(keyOf({ ...scope, service, name }));
		const edges = [];
		const add = (from, to, label) => {
			if (from && to && from !== to && !edges.some(e => e.from === from && e.to === to)) { edges.push({ from, to, label }); }
		};
		const target = arn => byArn.get(arn);
		for (const n of nodes) {
			const r = n.r;
			if (r.service === 'apigatewayv2') { r.routes.forEach(route => add(n, route.function && find('lambda', route.function, r), route.key)); }
			if (r.service === 'lambda') { r.triggers.forEach(t => add(byArn.get(t.source), n, 'gatilho')); }
			if (r.service === 'sns') { r.subscriptions.forEach(s => add(n, target(s.endpoint))); }
			if (r.service === 'scheduler') { add(n, target(r.target)); }
			if (r.service === 'events') { r.targets.forEach(t => add(n, target(t))); }
			if (r.service === 's3') { r.notifications.forEach(t => add(n, target(t.target), 'evento')); }
			if (r.service === 'stepfunctions') { r.states.forEach(s => s.function && add(n, (target(s.function) || find('lambda', tail(s.function), r)))); }
			if (r.service === 'sqs' && r.dlq) { add(n, byArn.get(r.dlq.arn), 'falhas'); }
		}
		const now = Date.now() / 1000;
		const live = new Set();
		let app = false;
		for (const c of S.calls) {
			const service = c.service;
			if (!(service in KINDS)) { continue; }
			let name = c.target || '';
			if (service === 's3') { name = name.split('/')[0]; }
			const to = KINDS[service] && find(service, name, c);
			if (!to) { continue; }
			const source = c.source || 'app';
			let from = null;
			if (source.startsWith('fn:')) { from = find('lambda', source.slice(3), c); }
			else if (source.startsWith('sfn:')) { from = find('stepfunctions', source.slice(4), c); }
			else if (source.startsWith('api:')) { from = find('apigatewayv2', source.slice(4), c); }
			else if (source === 'app') { from = 'app'; app = true; }
			if (from === 'app') {
				// The app's own calls only draw a line to the doors it comes in by; the rest would cross the whole map.
				if (['apigatewayv2', 'stepfunctions', 'sqs', 'sns', 'events'].includes(to.r.service)) { add('app', to); }
			} else if (from) {
				add(from, to);
			}
			if (now - c.at < 4) { live.add(`${from === 'app' ? 'app' : from?.key}>${to.key}`); }
		}
		return { nodes, edges, live, app };
	}

	function nodeLines(r) {
		switch (r.service) {
			case 'lambda': return [`${r.runtime} · ${r.handler}`, boxDetail(r).replace(/<[^>]+>/g, '')];
			case 'dynamodb': return [`chave ${[r.key.hash, r.key.range].filter(Boolean).join(' + ')}`, plural(r.count, 'item', 'itens')];
			case 's3': return [plural(r.count, 'objeto', 'objetos'), bytes(r.bytes)];
			case 'sqs': return [`${r.visible} na fila · ${r.inflight} lendo`, r.dlq ? `falhas → ${tail(r.dlq.arn)}` : ''];
			case 'sns': return [plural(r.subscriptions.length, 'inscrição', 'inscrições')];
			case 'apigatewayv2': return r.routes.slice(0, 3).map(route => route.key);
			case 'stepfunctions': return [plural(r.states.length, 'estado', 'estados'), r.executions[0] ? statusWord(r.executions[0].status) : ''];
			case 'scheduler': return [r.expression];
			case 'events': return [r.expression || 'padrão de evento'];
			case 'secretsmanager': return [r.empty ? 'vazio' : 'definido'];
			case 'ssm': return [r.type];
		}
		return [];
	}

	function mapView() {
		const { nodes, edges, live, app } = mapGraph();
		if (!nodes.length) {
			return '<div class="cs-main"><div class="cs-empty">O mapa aparece quando houver recursos.</div></div>';
		}
		const W = 210;
		const GAP_X = 90;
		const GAP_Y = 22;
		const columns = [[], [], [], []];
		nodes.forEach(n => columns[n.layer].push(n));
		orderColumns(columns, edges);
		const offset = app ? 1 : 0;
		const placed = new Map();
		let height = 0;
		const heightOf = n => 30 + Math.max(1, nodeLines(n.r).filter(Boolean).length) * 16;
		columns.forEach((column, index) => {
			let y = 40;
			column.forEach(n => {
				n.x = 20 + (index + offset) * (W + GAP_X);
				n.y = y;
				n.h = heightOf(n);
				y += n.h + GAP_Y;
				placed.set(n.key, n);
			});
			height = Math.max(height, y);
		});
		const appNode = app ? { key: 'app', x: 20, y: Math.max(40, height / 2 - 30), h: 46 } : null;
		const width = 20 + (4 + offset) * (W + GAP_X);
		const paths = edges.map(e => {
			const a = e.from === 'app' ? appNode : e.from;
			const b = e.to;
			if (!a || !b) { return ''; }
			const forward = b.x > a.x;
			const x1 = forward ? a.x + W : a.x;
			const x2 = forward ? b.x : b.x + W;
			const y1 = a.y + a.h / 2;
			const y2 = b.y + b.h / 2;
			const bend = forward ? Math.max(30, (x2 - x1) / 2) : 60;
			const d = forward ? `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}` : `M${x1},${y1} C${x1 - bend},${y1} ${x2 + bend},${y2} ${x2},${y2}`;
			const isLive = live.has(`${e.from === 'app' ? 'app' : e.from.key}>${e.to.key}`);
			return `<path class="cs-e ${isLive ? 'live' : ''} ${e.label === 'falhas' ? 'dash' : ''}" d="${d}" marker-end="url(#cs-ah-${isLive ? 'live' : 'norm'})"/>`;
		}).join('');
		const cards = nodes.map(n => {
			const k = KINDS[n.r.service];
			const mark = resourceMark(n.r);
			const lines = nodeLines(n.r).filter(Boolean);
			return `<div class="cs-n ${S.sel === n.key ? 'sel' : ''}" style="left:${n.x}px;top:${n.y}px;width:${W}px;height:${n.h}px;${mark ? `--mk:var(--cs-m-${mark})` : ''}" data-act="select" data-key="${esc(n.key)}">
				<div class="nh">${ic(k.icon)}<span>${esc(n.r.name)}</span></div><div class="nb">${lines.map(l => `<span>${esc(l)}</span>`).join('')}</div></div>`;
		}).join('');
		const appCard = appNode ? `<div class="cs-n app" style="left:${appNode.x}px;top:${appNode.y}px;width:${W}px;height:${appNode.h}px"><div class="nh">${ic('app')}<span>Seu app</span></div><div class="nb"><span>SDK, testes, navegador</span></div></div>` : '';
		const titles = ['Entrada', 'Processamento', 'Mensagens', 'Dados'].map((t, i) => `<div class="cs-lane" style="left:${20 + (i + offset) * (W + GAP_X)}px;width:${W}px">${t}</div>`).join('');
		return `<div class="cs-main"><div class="cs-fit" id="cs-fit"><div class="cs-stage" id="cs-stage" style="width:${width}px;height:${height + 20}px">${titles}
			<svg class="cs-edges" width="${width}" height="${height + 20}"><defs><marker id="cs-ah-norm" viewBox="0 0 10 10" refX="8.6" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M2,1.5L8.6,5L2,8.5" fill="none" stroke="#8A8A8A" stroke-width="1.6"/></marker>
			<marker id="cs-ah-live" viewBox="0 0 10 10" refX="8.6" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M2,1.5L8.6,5L2,8.5" fill="none" stroke="#3399FF" stroke-width="1.6"/></marker></defs>${paths}</svg>
			${appCard}${cards}</div>
			<div class="cs-legend"><span><i class="ln"></i>ligação</span><span><i class="ln live"></i>chamada agora</span><span><i class="ln dash"></i>fila de falhas</span></div></div></div>`;
	}

	/** Orders each column by the mean position of the nodes it links to (fewer crossing lines), a few passes. */
	function orderColumns(columns, edges) {
		const neighbours = new Map();
		for (const e of edges) {
			if (e.from === 'app') { continue; }
			for (const [a, b] of [[e.from, e.to], [e.to, e.from]]) {
				if (!neighbours.has(a.key)) { neighbours.set(a.key, []); }
				neighbours.get(a.key).push(b);
			}
		}
		const index = new Map();
		const number = () => columns.forEach(column => column.forEach((n, i) => index.set(n.key, i)));
		number();
		for (let pass = 0; pass < 4; pass++) {
			for (const column of pass % 2 ? [...columns].reverse() : columns) {
				const weight = n => {
					const linked = (neighbours.get(n.key) || []).filter(m => m.layer !== n.layer);
					return linked.length ? linked.reduce((sum, m) => sum + index.get(m.key), 0) / linked.length : index.get(n.key) + 0.5;
				};
				const weights = new Map(column.map(n => [n.key, weight(n)]));
				column.sort((a, b) => weights.get(a.key) - weights.get(b.key));
				number();
			}
		}
	}

	function fitMap() {
		const fit = document.getElementById('cs-fit');
		const stage = document.getElementById('cs-stage');
		if (!fit || !stage) { return; }
		const scale = Math.min(1, (fit.clientWidth - 20) / stage.offsetWidth, (fit.clientHeight - 40) / stage.offsetHeight);
		stage.style.transform = `scale(${Math.max(0.45, scale)})`;
	}

	// ------------------------------------------------------------------ copies, catalog, settings

	function copiesView() {
		const copies = S.cloud?.snapshots || [];
		const name = draft('copy-name', '');
		const rows = copies.map(c => `<tr><td><b>${esc(c.name)}</b></td><td>${dateTime(c.at)}</td><td class="r">${c.summary?.resources ?? '—'}</td><td class="r d">${bytes(c.bytes)}</td>
			<td class="r"><button class="cs-btn sm" data-act="restore" data-name="${esc(c.name)}" ${cloudOn() ? '' : 'disabled'}>${ic('restore')}Voltar para esta</button></td></tr>`).join('');
		return `<div class="cs-main cs-pad">
			<div class="cs-panel"><div class="cs-ph">${ic('history')}Cópias do estado</div><div class="cs-pb">
				<p class="cs-dim">Uma cópia guarda todas as tabelas, arquivos, filas e funções como estão agora. Voltar para uma cópia troca a nuvem local inteira por ela.</p>
				<div class="cs-row"><input class="cs-in cs-grow" data-draft="copy-name" placeholder="Nome da cópia, por exemplo: antes de mudar o cadastro" value="${esc(name)}">
				<button class="cs-btn primary" data-act="snapshot" ${cloudOn() ? '' : 'disabled'}>${ic('plus')}Criar cópia</button></div></div></div>
			<div class="cs-panel cs-grow"><div class="cs-ph">${ic('folder')}Guardadas <em>${copies.length}</em></div><div class="cs-pb np">
				${rows ? `<table class="cs-tbl tall"><colgroup><col><col style="width:110px"><col style="width:90px"><col style="width:80px"><col style="width:150px"></colgroup><thead><tr><th>Nome</th><th>Quando</th><th class="r">Recursos</th><th class="r">Tamanho</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="cs-empty">Nenhuma cópia ainda.</div>'}</div></div>
			<div class="cs-panel"><div class="cs-ph">${ic('trash')}Esvaziar</div><div class="cs-pb cs-row"><span class="cs-dim cs-grow">Apaga todos os recursos e dados da nuvem local. As cópias continuam guardadas.</span>
				<button class="cs-btn" data-act="reset" ${cloudOn() ? '' : 'disabled'}>${ic('trash', 'c-bad')}Esvaziar a nuvem</button></div></div></div>`;
	}

	function catalogView() {
		const used = new Set(S.resources.map(r => r.service));
		const emulated = new Set(S.cloud?.services || Object.keys(KINDS).concat('sts'));
		const groups = CATALOG.map(([group, items]) => `<div class="cs-panel"><div class="cs-ph">${esc(group)}</div><div class="cs-pb">
			${items.map(([label, id]) => `<div class="cs-li">${id && emulated.has(id) ? ic('passed', 'c-ok') : ic('ring', 'c-dim')}<span class="${id ? '' : 'cs-dim'}">${esc(label)}</span>
			<em>${id && emulated.has(id) ? `<span class="cs-badge emu">Emulado</span>${used.has(id) ? ' <span class="cs-badge grey">Em uso</span>' : ''}` : '<span class="cs-dim">ainda não</span>'}</em></div>`).join('')}</div></div>`).join('');
		const total = CATALOG.reduce((n, [, items]) => n + items.length, 0);
		const count = CATALOG.reduce((n, [, items]) => n + items.filter(([, id]) => id && emulated.has(id)).length, 0);
		return `<div class="cs-main cs-pad" data-scroll="catalog"><div class="cs-note">${ic('info', 'c-run')}<div>O CloudStudio emula <b>${count} dos ${total}</b> serviços listados, sem Docker. Os outros respondem com um erro claro dizendo que ainda não são emulados.</div></div>
			<div class="cs-cat">${groups}</div></div>`;
	}

	function settingsView() {
		const storage = S.cloud?.storage || S.settings.storage || 'memory';
		const region = S.cloud?.region || S.settings.region || 'us-east-1';
		const runtimes = S.cloud?.runtimes || {};
		return `<div class="cs-main cs-pad" data-scroll="settings">
			<div class="cs-panel"><div class="cs-ph">${ic('gear')}Nuvem local</div><div class="cs-pb"><div class="cs-kv wide">
				<span>Dados</span><span>${storage === 'persistent' ? 'guardados entre sessões' : 'só na memória'} <button class="cs-btn sm" data-act="set-storage" data-id="${storage === 'persistent' ? 'memory' : 'persistent'}">${storage === 'persistent' ? 'Passar a guardar só na memória' : 'Passar a guardar entre sessões'}</button></span>
				<span>Região</span><span><select class="cs-in" data-act="set-region">${REGIONS.map(r => `<option ${r === region ? 'selected' : ''}>${r}</option>`).join('')}</select></span>
				<span>Endereço</span><span class="m">${esc(S.cloud?.endpoint || 'http://127.0.0.1:4566')}</span>
				<span>Escuta em</span><span>só neste computador (127.0.0.1)</span>
				<span>Conta padrão</span><span class="m">000000000000 <span class="cs-dim">· uma chave de acesso com 12 dígitos usa outra conta</span></span></div>
				<p class="cs-dim small">Mudar onde os dados ficam ou a região religa a nuvem local.</p></div></div>
			<div class="cs-panel"><div class="cs-ph">${ic('lambda')}Funções</div><div class="cs-pb"><div class="cs-kv wide">
				<span>Python</span><span>${runtimes.python ? esc(runtimes.python) : '<span class="cs-dim">não encontrado neste computador</span>'}</span>
				<span>Node.js</span><span>${runtimes.node ? esc(runtimes.node) : '<span class="cs-dim">não encontrado neste computador</span>'}</span>
				<span>Fuso das funções</span><span>UTC, como na AWS</span></div>
				<p class="cs-dim small">As funções rodam com o Python e o Node.js instalados aqui. Pacotes como o boto3 precisam estar instalados no Python do projeto.</p></div></div>
			<div class="cs-panel"><div class="cs-ph">${ic('lock')}Privacidade</div><div class="cs-pb"><div class="cs-li">${ic('check', 'c-ok')}Nada sai deste computador: a nuvem não acessa a internet.</div>
				<div class="cs-li">${ic('check', 'c-ok')}Valores de segredos nunca aparecem no Studio, nas chamadas nem no chat.</div></div></div></div>`;
	}

	function confirmDialog() {
		if (!S.confirm) { return ''; }
		return `<div class="cs-scrim"></div><div class="cs-dlg"><div class="dt">${ic('warning', 'c-you')}${esc(S.confirm.title)}</div>
			<div class="cs-pb">${esc(S.confirm.text)}</div><div class="cs-actions pad"><button class="cs-btn" data-act="confirm-no">Cancelar</button><button class="cs-btn primary" data-act="confirm-yes">${esc(S.confirm.yes)}</button></div></div>`;
	}

	// ------------------------------------------------------------------ actions

	function compact(text) {
		const value = parse(text);
		return value === undefined ? String(text).trim() : JSON.stringify(value);
	}

	function startText(storage, region) {
		return `Ligue a nuvem local do CloudStudio${storage === 'persistent' ? ' guardando os dados entre sessões' : ' com os dados só na memória'}${region && region !== 'us-east-1' ? `, na região ${region}` : ''}.`;
	}

	function toast(text) {
		S.note = text;
		render();
		clearTimeout(toast.timer);
		toast.timer = setTimeout(() => { S.note = null; render(); }, 2600);
	}

	function onClick(event) {
		const el = event.target.closest('[data-act]');
		if (S.menu && !event.target.closest('.cs-menu') && !(el && el.dataset.act === 'menu')) {
			S.menu = false;
			render();
		}
		if (!el || el.disabled || el.tagName === 'INPUT' && el.type !== 'radio' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') { return; }
		const d = el.dataset;
		const resource = selectedResource(d.key);
		const scope = resource ? namespaceText(resource) : '';
		if (['invoke', 'request', 'send', 'run', 'logs-of'].includes(d.act) && !resource) { return; }
		switch (d.act) {
			case 'view':
				S.view = d.view;
				S.menu = false;
				remember();
				render();
				break;
			case 'menu': {
				S.menu = !S.menu;
				S.menuX = el.getBoundingClientRect().left;
				render();
				break;
			}
			case 'start-cloud':
				act('start', startText(S.cloud ? (S.settings.storage || 'memory') : S.firstStorage, S.cloud ? S.settings.region : S.firstRegion));
				break;
			case 'stop-cloud':
				act('stop', 'Desligue a nuvem local do CloudStudio.');
				break;
			case 'first-storage':
				S.firstStorage = el.value;
				break;
			case 'example':
				ask(d.text, false);
				break;
			case 'env':
				act('env', 'Crie o .env.local do projeto para o código usar a nuvem local do CloudStudio.');
				break;
			case 'copy-env': {
				const text = envLines().join('\n');
				try {
					navigator.clipboard.writeText(text).then(() => toast('Variáveis copiadas.'), () => toast('Não foi possível copiar. Use Criar .env.local.'));
				} catch {
					toast('Não foi possível copiar. Use Criar .env.local.');
				}
				break;
			}
			case 'select':
				S.sel = d.key;
				if (S.view !== 'map') { S.view = 'resources'; }
				if (S.view === 'map' && event.detail === 2) { S.view = 'resources'; }
				remember();
				render();
				break;
			case 'toggle':
				if (S.open.has(d.service)) { S.open.delete(d.service); } else { S.open.add(d.service); }
				remember();
				render();
				break;
			case 'item':
				S.itemSel[d.key] = d.item;
				render();
				break;
			case 'call':
				S.callSel = Number(d.id);
				if (S.view !== 'calls') { S.view = 'calls'; remember(); }
				render();
				break;
			case 'call-filter':
				S.callFilter = d.id;
				remember();
				render();
				break;
			case 'log-group':
				S.logGroup = d.id;
				remember();
				render();
				break;
			case 'logs-of':
				S.logGroup = JSON.stringify([resource.account || '000000000000', resource.region || '', `/aws/lambda/${d.name}`]);
				S.view = 'logs';
				remember();
				render();
				break;
			case 'logs-group':
				S.logGroup = d.id;
				S.view = 'logs';
				remember();
				render();
				break;
			case 'explain': {
				const call = S.calls.find(c => c.id === Number(d.id));
				if (call) {
					ask(`No CloudStudio, a chamada ${call.op} em ${call.target || SERVICE_LABEL[call.service]} das ${clock(call.at)} falhou com ${call.error.code}: "${call.error.message.slice(0, 240)}". Descubra no código do projeto por que isso acontece e corrija.`, true);
				}
				break;
			}
			case 'ask-about': {
				const r = S.resources.find(x => keyOf(x) === d.key);
				if (r) { ask(`Sobre ${KINDS[r.service].one} ${r.name} no CloudStudio ${namespaceText(r)}: `, false); }
				break;
			}
			case 'invoke': {
				const text = draft(`event:${d.key}`, '{}');
				if (parse(text) === undefined) { toast('O evento precisa ser um JSON válido.'); break; }
				act('invoke', `Invoque a função ${d.name} do CloudStudio ${scope} com o evento ${compact(text)}`);
				break;
			}
			case 'request': {
				const api = resource;
				const defaults = api ? apiDefaults(api) : { method: 'GET', path: '/' };
				const method = draft(`method:${d.key}`, defaults.method);
				const path = draft(`path:${d.key}`, defaults.path);
				const body = draft(`body:${d.key}`, '').trim();
				if (body && parse(body) === undefined) { toast('O corpo precisa ser um JSON válido.'); break; }
				act('request', `Chame a API ${d.name} do CloudStudio ${scope}: ${method} ${path}${body ? ` com o corpo ${compact(body)}` : ''}`);
				break;
			}
			case 'send': {
				const text = draft(`message:${d.key}`, '').trim();
				if (!text) { toast('Escreva a mensagem.'); break; }
				if (/^[[{]/.test(text) && parse(text) === undefined) { toast('A mensagem parece JSON, mas não é um JSON válido.'); break; }
				act('send', d.kind === 'fila' ? `Envie para a fila ${d.name} do CloudStudio ${scope} a mensagem ${compact(text)}` : `Publique no tópico ${d.name} do CloudStudio ${scope} a mensagem ${compact(text)}`);
				break;
			}
			case 'run': {
				const text = draft(`input:${d.key}`, '{}');
				if (parse(text) === undefined) { toast('A entrada precisa ser um JSON válido.'); break; }
				act('run', `Execute a máquina de estados ${d.name} do CloudStudio ${scope} com a entrada ${compact(text)}`);
				break;
			}
			case 'snapshot': {
				const name = draft('copy-name', '').trim();
				act('snapshot', name ? `Salve uma cópia da nuvem local do CloudStudio chamada "${name}".` : 'Salve uma cópia da nuvem local do CloudStudio.');
				S.drafts['copy-name'] = '';
				break;
			}
			case 'restore':
				S.confirm = { title: 'Voltar para a cópia', text: `A nuvem local inteira volta a ser como estava na cópia "${d.name}". O que foi criado depois some.`, yes: 'Voltar', ask: `Volte a nuvem local do CloudStudio para a cópia "${d.name}".` };
				render();
				break;
			case 'reset':
				S.confirm = { title: 'Esvaziar a nuvem local', text: 'Todos os recursos e dados da nuvem local serão apagados. As cópias continuam guardadas.', yes: 'Esvaziar', ask: 'Esvazie a nuvem local do CloudStudio: apague todos os recursos.' };
				render();
				break;
			case 'confirm-yes': {
				const text = S.confirm?.ask;
				S.confirm = null;
				if (text) { act('confirm', text); }
				break;
			}
			case 'confirm-no':
				S.confirm = null;
				render();
				break;
			case 'set-storage':
				act('start', `Religue a nuvem local do CloudStudio ${d.id === 'persistent' ? 'guardando os dados entre sessões' : 'com os dados só na memória'}.`);
				break;
		}
	}

	function onInput(event) {
		const el = event.target;
		if (el.dataset.draft) {
			S.drafts[el.dataset.draft] = el.value;
		}
		if (el.dataset.act === 'filter') {
			S.filter = el.value;
			render();
		}
	}

	function onChange(event) {
		const el = event.target;
		if (el.dataset.act === 'first-region') {
			S.firstRegion = el.value;
		}
		if (el.dataset.act === 'set-region' && el.value !== (S.cloud?.region || S.settings.region)) {
			act('start', `Religue a nuvem local do CloudStudio na região ${el.value}.`);
		}
		if (el.dataset.draft) {
			S.drafts[el.dataset.draft] = el.value;
		}
	}

	// ------------------------------------------------------------------ host messages

	function readFiles(files) {
		const json = name => (typeof files[name] === 'string' ? parse(files[name]) : undefined);
		const cloud = json('cloud.json');
		S.cloud = cloud && typeof cloud === 'object' ? cloud : null;
		const resources = json('resources.json');
		S.resources = Array.isArray(resources?.resources) ? resources.resources.filter(r => r && KINDS[r.service]) : [];
		const calls = json('calls.json');
		S.calls = Array.isArray(calls?.calls) ? calls.calls : [];
		S.callTotal = calls?.total || S.calls.length;
		S.errorTotal = calls?.errors || S.calls.filter(c => c.error).length;
		const logs = json('logs.json');
		S.logs = Array.isArray(logs?.logs) ? logs.logs : [];
		const settings = json('settings.json');
		S.settings = settings && typeof settings === 'object' ? settings : {};
		const view = json('view.json');
		if (view && typeof view.revision === 'number' && view.revision !== S.viewRevision) {
			const first = S.viewRevision === 0 && saved.viewRevision === view.revision;
			S.viewRevision = view.revision;
			if (!first) {
				if (VIEWS[view.view]) { S.view = view.view; }
				if (view.select) { S.sel = view.select; }
				remember();
			}
		}
		if (S.pending) {
			const age = Date.now() - S.pending.at;
			if ((S.pending.kind === 'start' && cloudOn()) || (S.pending.kind === 'stop' && !cloudOn()) || age > 90000) {
				S.pending = null;
			}
		}
		const log = document.querySelector('[data-stick]');
		S.stick = log ? log.scrollHeight - log.scrollTop - log.clientHeight < 30 : true;
	}

	window.addEventListener('message', event => {
		const m = event.data;
		if (!m || typeof m !== 'object') { return; }
		switch (m.type) {
			case 'init':
			case 'context':
				S.ctx = m.context && typeof m.context === 'object' ? m.context : null;
				render();
				break;
			case 'files':
				readFiles(m.files || {});
				render();
				if (S.stick) {
					requestAnimationFrame(() => requestAnimationFrame(() => {
						const log = document.querySelector('[data-stick]');
						if (log) { log.scrollTop = log.scrollHeight; }
					}));
				}
				break;
			case 'filesError':
				toast(typeof m.message === 'string' ? m.message : 'Não foi possível atualizar o CloudStudio.');
				break;
			case 'running':
				S.running = !!m.running;
				break;
			case 'request':
				if (S.pending && S.pending.requestId === m.requestId && ['settled', 'rejected', 'unconfirmed'].includes(m.state)) {
					if (m.state === 'rejected') { toast('O agente está ocupado. Tente de novo quando ele terminar.'); }
					S.pending = null;
					render();
				}
				break;
		}
	});

	document.addEventListener('click', onClick);
	document.addEventListener('input', onInput);
	document.addEventListener('change', onChange);
	window.addEventListener('resize', () => { if (S.view === 'map') { fitMap(); } });
	setInterval(() => { if (S.view === 'map' || S.pending) { render(); } }, 2000);

	render();
	host.postMessage({ type: 'ready' });
})();
