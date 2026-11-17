/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Dev only: stands in for the JumpCode host. It feeds the interface the Studio files of one fixture scenario
// (window.AS_FIXTURES, inlined by serve.mjs) and records what the interface posts in window.__posted. The scenario's
// times are moved so state.updated is now (a building step stays fresh). Query: s=<scenario>, and to point the Studio
// somewhere else, as the agent's show would: view=, screen=, state=, device=, frame=0|1, fold=open|closed,
// landscape=0|1. running=1 starts with the agent working; agent=0 keeps it idle after a request (by default it starts
// working 30 ms later).
(function () {
	'use strict';
	const query = new URLSearchParams(location.search);
	const config = window.AS_HOST_CONFIG || {};
	window.__posted = [];
	const send = message => window.dispatchEvent(new MessageEvent('message', { data: message }));
	let revision = 0;

	function retime(value, shift) {
		if (Array.isArray(value)) {
			return value.map(item => retime(item, shift));
		}
		if (value && typeof value === 'object') {
			return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, retime(item, shift)]));
		}
		return typeof value === 'number' && value > 1.7e9 && value < 1.9e9 ? value + shift : value;
	}

	function files() {
		const source = window.AS_FIXTURES || {};
		const out = { ...source };
		let state = source['state.json'] ? JSON.parse(source['state.json']) : null;
		if (state) {
			state = retime(state, Date.now() / 1000 - (state.updated || Date.now() / 1000));
			const focus = { ...(state.focus || {}) };
			for (const key of ['screen', 'state', 'device', 'fold']) {
				if (query.get(key)) { focus[key] = query.get(key); }
			}
			for (const key of ['frame', 'landscape']) {
				if (query.get(key)) { focus[key] = query.get(key) === '1'; }
			}
			if (query.get('view')) { state.view = query.get('view'); }
			state.focus = focus;
			out['state.json'] = JSON.stringify(state);
		}
		return out;
	}

	/** Sends the scenario's files again with changes, as the host does when the tool writes (for regressions). */
	window.AS_SEND = change => {
		const current = files();
		for (const [name, value] of Object.entries(change || {})) {
			if (value === null) {
				delete current[name];
			} else {
				current[name] = typeof value === 'string' ? value : JSON.stringify(value);
			}
		}
		send({ type: 'files', files: current, revision: ++revision });
	};
	window.AS_HOST = send;

	window.acquireVsCodeApi = () => ({
		postMessage(message) {
			window.__posted.push(message);
			if (message.type === 'ready') {
				setTimeout(() => {
					const running = !!config.running || query.get('running') === '1';
					send({ type: 'init', context: { tool: 'appstudio', project: true, source: 'barbearia-do-ze', sourceKind: 'project', sourceRevision: 1 } });
					send({ type: 'files', files: files(), revision: ++revision });
					send({ type: 'running', running, executions: running ? ['op-1'] : [], requests: running ? ['req-1'] : [] });
				}, 0);
			}
			if (message.type === 'ask' && message.send && query.get('agent') !== '0') {
				setTimeout(() => send({ type: 'running', running: true, executions: [], requests: [message.requestId] }), 30);
			}
		},
		getState() { return undefined; },
		setState() { },
	});
})();
