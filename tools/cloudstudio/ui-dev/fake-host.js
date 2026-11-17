/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Dev only: stands in for the JumpCode host. It feeds the interface the real files scenario.py saved
// (window.CS_FILES) and records what the interface posts in window.__posted.
// Query: state=running|off|first|stopped, view=overview|resources|map|calls|logs|copies|catalog|settings,
// sel=table:agendamentos, project=0.
(function () {
	'use strict';
	const query = new URLSearchParams(location.search);
	const state = query.get('state') || 'running';
	window.__posted = [];
	const send = message => window.dispatchEvent(new MessageEvent('message', { data: message }));

	function files() {
		const source = window.CS_FILES || {};
		const out = {};
		if (state === 'first') {
			return out;
		}
		for (const [name, text] of Object.entries(source)) {
			out[name] = text;
		}
		const cloud = JSON.parse(out['cloud.json'] || '{}');
		cloud.status = state === 'off' || state === 'stopped' ? 'stopped' : 'running';
		cloud.startedAt = Date.now() / 1000 - 17 * 60;
		cloud.readyMs = cloud.readyMs || 186;
		if (state === 'off') {
			out['resources.json'] = JSON.stringify({ schema: 1, version: 0, resources: [] });
		}
		const view = { schema: 1, revision: 1, view: query.get('view') || 'overview', select: query.get('sel') || null, note: '' };
		out['view.json'] = JSON.stringify(view);
		out['cloud.json'] = JSON.stringify(cloud);
		return out;
	}

	window.acquireVsCodeApi = () => ({
		postMessage(message) {
			window.__posted.push(message);
			if (message.type === 'ready') {
				setTimeout(() => {
					send({ type: 'init', context: { tool: 'cloudstudio', project: query.get('project') !== '0', source: 'barbearia', sourceKind: 'project', sourceRevision: 1 } });
					send({ type: 'files', files: files(), revision: 1 });
					send({ type: 'running', running: false, executions: [], requests: [] });
				}, 0);
			}
		},
		getState() { return undefined; },
		setState() { },
	});
})();
