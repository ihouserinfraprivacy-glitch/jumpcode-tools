/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Dev only: feeds odd and partial Studio files through every mode and fails on any page error.
// Run: node robust.mjs
import { chromium } from 'file:///C:/Projects/jumpcode/node_modules/playwright/index.mjs';
import { start } from './serve.mjs';

const server = await start();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1344, height: 905 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => {
	if (m.type() === 'error') {
		errors.push(m.text());
	}
});
await page.goto(`http://127.0.0.1:${server.address().port}/?state=empty`);
await page.waitForTimeout(200);

const cases = {
	'modelo vazio': { 'model.json': '{"version":1,"nodes":[],"links":[]}' },
	'json quebrado': { 'model.json': '{"version":1,"nodes":[' },
	'campos faltando': {
		'model.json': JSON.stringify({
			nodes: [
				{ id: 's:a' }, { id: 'v:a/x', parent: 's:a' }, { id: 'f:a/x/m.go', parent: 'v:a/x', level: 'file' },
				{ id: 'v:solto', level: 'service' }, { id: 'f:orfao.go', level: 'file', parent: 'v:nao-existe' }, { id: 'x:ext', level: 'external', name: '' },
			],
			links: [{ from: 's:a', to: 'x:ext' }, { from: 'v:a/x', to: 'nada' }, { from: 'f:a/x/m.go', to: 'v:solto', level: 'esquisito' }, { id: 'dup', from: 's:a', to: 's:a', level: 'system' }],
			deploy: { zones: [{ id: 'z:1', parent: 'z:sumiu', kind: 'cloud', name: 'Nuvem' }], units: [{ id: 'u:1', zone: 'z:1', kind: 'container', name: 'a' }, { id: 'u:2', name: 'sem zona' }], links: [{ from: 'u:1', to: 'u:404' }] },
		}),
		'paths.json': JSON.stringify({ paths: [{ id: 'p', name: 'Estranho', steps: [{ from: 's:a', to: 'x:nenhum' }, { from: 'q:fantasma', to: 's:a', async: true }, { from: 's:a', to: 's:a' }] }, { id: 'vazio', steps: [] }] }),
		'proposal.json': JSON.stringify({ title: 'Mudança', nodes: [{ op: 'add', id: 'v:a/novo', parent: 's:a' }, { op: 'change', id: 'nao-existe' }, { op: 'xx' }], links: [{ op: 'add', from: 'v:a/novo', to: 'v:a/x' }, { op: 'remove', from: 'q:1', to: 'q:2' }] }),
		'view.json': JSON.stringify({ revision: 1, scope: 'v:sumiu', select: 'f:nada', highlight: ['l404', 7, null], mode: 'present' }),
		'progress.json': JSON.stringify({ status: 'scanning', current: 42, steps: 'não é lista' }),
	},
	'progresso só': { 'progress.json': '{"status":"failed"}' },
};

const modes = ['map', 'columns', 'circles', 'blocks', 'layers', 'path', 'present', 'deploy', 'matrix'];
let rev = 10;
for (const [name, files] of Object.entries(cases)) {
	await page.evaluate(f => window.__send({ type: 'files', files: f }), files);
	await page.waitForTimeout(80);
	for (const mode of modes) {
		const view = { revision: ++rev, mode, scope: mode === 'matrix' ? 's:a' : null, highlight: [] };
		await page.evaluate(f => window.__send({ type: 'files', files: f }), { ...files, 'view.json': JSON.stringify(view) });
		await page.waitForTimeout(40);
		// click around a little
		const nodes = await page.locator('#as-canvas [data-id]').count();
		if (nodes) {
			await page.locator('#as-canvas [data-id]').first().dispatchEvent('click').catch(() => { });
			await page.waitForTimeout(20);
		}
		await page.keyboard.press('Escape');
	}
	console.log(`${errors.length ? 'FAIL' : 'ok  '} ${name}${errors.length ? `: ${errors.join(' | ')}` : ''}`);
	errors.length = 0;
}
await browser.close();
server.close();
