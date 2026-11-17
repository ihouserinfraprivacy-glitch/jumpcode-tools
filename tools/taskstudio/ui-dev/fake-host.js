/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Dev only: a fake JumpCode host for the TaskStudio interface. It answers like the real host
// (init, files, running) using window.TS_SAMPLE and the page's query string, and logs every
// message the interface sends:
//   state=empty|planning|building|ready|running|details|view|gate|problem|edit-done|recalibrating|
//         proposal|compare|edit-running|edit-todo|proposal-done|finished|list|board|timeline|lanes|
//         metro|focus|history|big|big-list|big-board|big-timeline|big-lanes|paused
//   mode=…  sel=…  project=0  sim=0 (no simulated agent)  bad=1 (send a broken plan.json after load)
//   data=real (the files the Python package wrote in tests/fixtures/barbearia, see make-real.mjs)
//   with data=real: real=plan|recalibrating|proposal
(function () {
	const q = new URLSearchParams(location.search);
	const state = q.get('state') || 'running';
	const real = q.get('data') === 'real' && window.TS_REAL;
	const sim = q.get('sim') !== '0';
	let built;
	if (real) {
		const which = q.get('real') || 'plan';
		const files = { 'history.json': real['history.json'], 'view.json': real['view.json'] };
		if (which === 'recalibrating') {
			files['plan.json'] = real['plan-recalibrating.json'];
		} else if (which === 'proposal') {
			files['plan.json'] = real['plan-proposed.json'];
			files['proposal.json'] = real['proposal.json'];
		} else {
			files['plan.json'] = real['plan.json'];
		}
		built = { files, running: which === 'recalibrating', saved: {} };
	} else {
		built = window.TS_SAMPLE.build(state);
	}
	const files = Object.assign({}, built.files);
	let running = built.running;
	let revision = 1;

	const saved = Object.assign({ lastViewRev: q.get('view') === '1' ? null : undefined }, built.saved);
	if (q.get('mode')) {
		saved.mode = q.get('mode');
	}
	if (q.get('sel')) {
		saved.sel = q.get('sel');
	}
	if (q.get('mode') || q.get('sel')) {
		// An explicit mode or selection wins over the fixture's view.json (as if it had been followed already).
		try {
			saved.lastViewRev = JSON.parse(files['view.json'] ?? 'null')?.revision;
		} catch {
			// No view file.
		}
	}
	const ctx = { tool: 'taskstudio', project: q.get('project') !== '0', source: q.get('project') === '0' ? null : 'barbearia', sourceKind: q.get('project') === '0' ? null : 'project', sourceRevision: 1 };

	const post = (msg, delay) => setTimeout(() => window.postMessage(msg, '*'), delay || 0);
	const sendFiles = delay => post({ type: 'files', files: Object.assign({}, files), revision: ++revision }, delay);
	const setRunning = (on, delay) => setTimeout(() => {
		running = on;
		window.postMessage({ type: 'running', running: on, executions: on ? ['dev-exec'] : [], requests: on ? ['dev-request', 'fixture-request'] : [] }, '*');
	}, delay || 0);
	const readPlan = () => JSON.parse(files['plan.json']);
	const writePlan = p => {
		p.revision = (p.revision || 0) + 1;
		files['plan.json'] = JSON.stringify(p, null, '\t');
	};

	window.__posted = [];
	window.__state = saved;

	/** A tiny simulated agent, so the buttons can be tried by hand. */
	function simulate(m) {
		if (!sim || !files['plan.json']) {
			return;
		}
		if (m.type === 'stop') {
			setRunning(false, 60);
			return;
		}
		if (m.type !== 'ask' || !m.send) {
			return;
		}
		const text = m.text;
		if (/^Mudei a tarefa #(\d+)/.test(text)) {
			const id = /^Mudei a tarefa #(\d+)/.exec(text)[1];
			setRunning(true, 400);
			setTimeout(() => {
				const p = readPlan();
				const t = p.tasks.find(x => x.id === id);
				const kids = new Map(p.tasks.map(x => [x.id, []]));
				p.tasks.forEach(x => x.deps.forEach(d => kids.get(d)?.push(x.id)));
				const all = new Set();
				const stack = [...(kids.get(id) || [])];
				while (stack.length) {
					const k = stack.pop();
					if (!all.has(k)) {
						all.add(k);
						stack.push(...kids.get(k));
					}
				}
				const by = st => [...all].filter(k => st.includes(p.tasks.find(x => x.id === k).state));
				const paused = by(['running']);
				for (const k of paused) {
					const x = p.tasks.find(y => y.id === k);
					x.state = 'paused';
					x.pausedAt = new Date().toISOString();
				}
				p.recalibrating = {
					requestId: 'dev-request',
					task: id, kind: t.state === 'done' ? 'done' : t.state === 'todo' ? 'todo' : 'running', text: (/«(.*)»/.exec(text) || [])[1] || '',
					before: { title: t.title }, after: {}, at: new Date().toISOString(), paused,
					impact: { done: by(['done']), running: by(['running', 'paused']), todo: by(['todo', 'failed', 'skipped']) },
				};
				writePlan(p);
				sendFiles();
			}, 1600);
			setTimeout(() => {
				const p = readPlan();
				const r = p.recalibrating;
				if (!r) {
					return;
				}
				const states = {};
				const changes = [{ task: r.task, kind: r.kind === 'done' ? 'refazer' : r.kind === 'todo' ? 'alterar' : 'ajustar', note: r.text, why: 'sua mudança' }];
				for (const k of [...r.impact.done, ...r.impact.running, ...r.impact.todo].slice(0, 5)) {
					const x = p.tasks.find(y => y.id === k);
					changes.push({ task: k, kind: x.state === 'done' ? 'refazer' : x.state === 'running' || x.state === 'paused' ? 'ajustar' : 'alterar', note: 'Ajustar ao que mudou.', why: `usa #${r.task}` });
				}
				for (const c of changes) {
					states[c.task] = p.tasks.find(y => y.id === c.task).state;
				}
				p.recalibrating = null;
				writePlan(p);
				files['proposal.json'] = JSON.stringify({ schema: 1, revision: 1, plan: (p.plan || 1) + 1, base: p.plan || 1, baseRevision: p.revision, states, cause: { task: r.task, text: r.text }, summary: `A mudança atinge ${changes.length} tarefas.`, extra: 8, changes, createdAt: new Date().toISOString() });
				sendFiles();
				setRunning(false, 50);
			}, 4200);
			return;
		}
		if (/^Aplique as mudanças/.test(text) || /^Descarte a proposta/.test(text)) {
			setRunning(true, 200);
			setTimeout(() => {
				const p = readPlan();
				if (/^Aplique/.test(text)) {
					p.plan = (p.plan || 1) + 1;
				}
				delete files['proposal.json'];
				writePlan(p);
				sendFiles();
				setRunning(false, 50);
			}, 900);
			return;
		}
		if (text === 'Pode começar.') {
			setRunning(true, 200);
			setTimeout(() => {
				const p = readPlan();
				p.started = true;
				const first = p.tasks.find(t => t.state === 'todo' && !t.deps.length);
				if (first) {
					Object.assign(first, { state: 'running', requestId: 'dev-request', startedAt: new Date().toISOString(), progress: 10, now: 'lendo o pedido' });
				}
				writePlan(p);
				sendFiles();
			}, 700);
			return;
		}
		setRunning(true, 200);
		setRunning(false, 1500);
	}

	window.acquireVsCodeApi = function () {
		return {
			postMessage(m) {
				window.__posted.push(m);
				console.log('[host] <-', JSON.stringify(m).slice(0, 300));
				if (m.type === 'ready') {
					post({ type: 'init', context: ctx });
					sendFiles(5);
					post({ type: 'running', running, executions: running ? ['dev-exec'] : [], requests: running ? ['dev-request', 'fixture-request'] : [] }, 10);
					if (q.get('bad') === '1') {
						setTimeout(() => {
							window.postMessage({ type: 'files', files: Object.assign({}, files, { 'plan.json': '{"schema":1,"tasks":[' }), revision: ++revision }, '*');
						}, 60);
					}
				} else {
					if (m.type === 'ask' && m.send && m.requestId) {
						post({ type: 'request', requestId: m.requestId, state: 'queued' });
						if (sim) { post({ type: 'request', requestId: m.requestId, state: 'settled' }, 5000); }
					}
					simulate(m);
				}
			},
			getState() {
				return window.__state;
			},
			setState(s) {
				window.__state = s;
			},
		};
	};
	// Lets scripts push messages: __send({ type: 'running', running: false }).
	window.__send = msg => window.postMessage(msg, '*');
	window.__files = files;
})();
