/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Real packaged interface, isolated Chrome and simulated host; no network or user profile.
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

(async () => {
	const { page: fixture } = await import(pathToFileURL(path.resolve(__dirname, '../ui-dev/serve.mjs')).href);
	const browser = await chromium.launch({ channel: 'chrome', headless: true });
	try {
		const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
		const requests = [], errors = [];
		await context.route(/^https?:/, route => { requests.push(route.request().url()); return route.abort(); });
		const page = await context.newPage();
		page.setDefaultTimeout(5000);
		page.on('pageerror', error => errors.push(error.message));
		const query = 'data=real&paths=0&proposal=0&mode=map&scope=v%3Aplataforma%2Fservicos%2Fpedidos&sel=f%3Aplataforma%2Fservicos%2Fpedidos%2Fhandlers.go';
		// Only the development harness query is supplied in memory; app.js runs unmodified with its CSP.
		await page.setContent(fixture().html.replaceAll('new URLSearchParams(location.search)', `new URLSearchParams(${JSON.stringify(query)})`));
		await page.locator('#as-lines').filter({ hasText: 'package' }).waitFor();
		const reads = () => page.evaluate(() => __posted.filter(x => x.type === 'readFile').length);
		assert.equal(await reads(), 1);
		await page.evaluate(() => {
			const file = __posted.find(x => x.type === 'readFile').path;
			AS_REAL.sources[file] = '// SOURCE_VERSION_TWO\npackage http';
			const model = JSON.parse(__files['model.json']);
			model.scannedAt = '2030-01-01T00:00:00Z';
			__files['model.json'] = JSON.stringify(model);
			__send({ type: 'files', files: __files });
		});
		await page.locator('#as-lines').filter({ hasText: 'SOURCE_VERSION_TWO' }).waitFor();
		assert.equal(await reads(), 2);
		await page.evaluate(() => {
			__files['progress.json'] = JSON.stringify({ status: 'done', total: 123 });
			__send({ type: 'files', files: __files });
		});
		await page.waitForTimeout(80);
		assert.equal(await reads(), 2, 'Progress alone must not read the source again');
		console.log('PASS: refreshed code after rescan, no reread on progress');

		await page.evaluate(() => __send({ type: 'context', context: { source: 'repo', sourceKind: 'folder', sourceRevision: 1 } }));
		await page.waitForTimeout(80);
		const beforeSource = await reads();
		await page.evaluate(() => {
			const file = __posted.find(x => x.type === 'readFile').path;
			AS_REAL.sources[file] = '// OTHER_REPO_SAME_PATH\npackage http';
			window.__staleRequest = __posted.filter(x => x.type === 'readFile').at(-1).requestId;
			__send({ type: 'context', context: { source: 'repo', sourceKind: 'folder', sourceRevision: 2 } });
		});
		await page.locator('#as-lines').filter({ hasText: 'OTHER_REPO_SAME_PATH' }).waitFor();
		assert.equal(await reads(), beforeSource + 1);
		await page.evaluate(() => __send({ type: 'file', requestId: __staleRequest, text: 'STALE_REPLY' }));
		await page.waitForTimeout(80);
		assert.ok((await page.locator('#as-lines').innerText()).includes('OTHER_REPO_SAME_PATH'));
		console.log('PASS: same-named source switch invalidates code and ignores old replies');

		const committed = { version: 1, sourceId: 'source-one', nodes: [{ id: 's:one', level: 'system', name: 'COMMITTED_MAP', kind: 'backend' }], links: [] };
		const partial = { ...committed, executionId: 'scan-old', nodes: [{ id: 's:partial', level: 'system', name: 'PARTIAL_MAP', kind: 'backend' }] };
		const files = { 'model.json': JSON.stringify(committed), 'model-partial.json': JSON.stringify(partial),
			'progress.json': JSON.stringify({ status: 'scanning', sourceId: committed.sourceId, executionId: partial.executionId }) };
		await page.evaluate(files => __send({ type: 'files', files }), files);
		await page.locator('#as-body').filter({ hasText: 'COMMITTED_MAP' }).waitFor();
		for (const executions of [[], ['unrelated-operation']]) {
			await page.evaluate(executions => __send({ type: 'running', running: true, executions }), executions);
			await page.waitForTimeout(50);
			assert.ok((await page.locator('#as-body').innerText()).includes('COMMITTED_MAP'));
			assert.ok(!(await page.locator('#as-body').innerText()).includes('PARTIAL_MAP'));
			assert.ok((await page.locator('.as-status').innerText()).includes('Mapeamento parou'));
		}
		console.log('PASS: abandoned preview stays hidden during unrelated requests');

		// The interface can be reopened in the middle of an actual scan: no need
		// to witness its start, only a matching live receipt and snapshot.
		await page.evaluate(() => __send({ type: 'running', running: true, executions: ['scan-old'] }));
		await page.locator('#as-body').filter({ hasText: 'PARTIAL_MAP' }).waitFor();
		await page.evaluate(() => __send({ type: 'running', running: true, executions: [] }));
		await page.locator('#as-body').filter({ hasText: 'COMMITTED_MAP' }).waitFor();
		console.log('PASS: live receipt shows preview; tool completion hides it even while the agent is busy');

		await page.evaluate(() => __send({ type: 'running', running: true, executions: ['scan-new'] }));
		const nextFiles = { ...files, 'progress.json': JSON.stringify({ status: 'scanning', sourceId: committed.sourceId, executionId: 'scan-new' }) };
		await page.evaluate(files => __send({ type: 'files', files }), nextFiles);
		await page.waitForTimeout(50);
		assert.ok(!(await page.locator('#as-body').innerText()).includes('PARTIAL_MAP'), 'A new scan cannot reuse a previous scan snapshot');
		nextFiles['model-partial.json'] = JSON.stringify({ ...partial, executionId: 'scan-new', sourceId: 'other-source' });
		await page.evaluate(files => __send({ type: 'files', files }), nextFiles);
		await page.waitForTimeout(50);
		assert.ok(!(await page.locator('#as-body').innerText()).includes('PARTIAL_MAP'), 'Snapshots must also match the scan source');
		nextFiles['model-partial.json'] = JSON.stringify({ ...partial, executionId: 'scan-new' });
		await page.evaluate(files => __send({ type: 'files', files }), nextFiles);
		await page.locator('#as-body').filter({ hasText: 'PARTIAL_MAP' }).waitFor();
		await page.evaluate(() => __send({ type: 'running', running: false, executions: [] }));
		await page.locator('#as-body').filter({ hasText: 'COMMITTED_MAP' }).waitFor();
		console.log('PASS: receipt before files, mismatched scan/source rejected, cancellation restores saved map');

		await page.evaluate(files => __send({ type: 'files', files }), { ...files, 'progress.json': JSON.stringify({ status: 'scanning' }) });
		await page.evaluate(() => __send({ type: 'running', running: true, executions: ['scan-old'] }));
		await page.waitForTimeout(50);
		assert.ok(!(await page.locator('#as-body').innerText()).includes('PARTIAL_MAP'), 'Legacy interrupted previews have no live receipt');
		await page.evaluate(() => __send({ type: 'running', running: false, executions: [] }));
		console.log('PASS: legacy snapshots cannot reactivate');

		await page.evaluate(files => __send({ type: 'files', files }), {
			'model.json': JSON.stringify({ ...committed, sourceId: 'source-two' }),
			'view.json': JSON.stringify({ sourceId: 'source-one', revision: 1, note: 'WRONG_SOURCE_NOTE', select: 's:one' }),
			'proposal.json': JSON.stringify({ sourceId: 'source-one', title: 'WRONG_SOURCE_PROPOSAL', nodes: [{ op: 'add', id: 's:wrong', name: 'OLD_PROPOSAL', level: 'system' }] }),
		});
		await page.waitForTimeout(80);
		assert.ok(!(await page.locator('body').innerText()).includes('WRONG_SOURCE_NOTE'));
		assert.equal(await page.getByText('Proposta', { exact: true }).count(), 0);
		console.log('PASS: old source focus and proposal do not leak into the new map');

		await page.evaluate(() => __send({ type: 'filesError', message: 'O mapa salvo foi mantido.' }));
		await page.getByRole('alert').waitFor();
		assert.ok((await page.locator('#as-body').innerText()).includes('COMMITTED_MAP'));
		await page.evaluate(files => __send({ type: 'files', files }), { 'model.json': JSON.stringify({ ...committed, sourceId: 'source-two' }) });
		await page.getByRole('alert').waitFor({ state: 'detached' });
		console.log('PASS: transport failure retains the map and clears the warning on recovery');

		for (const mode of ['map', 'columns', 'circles', 'blocks', 'layers', 'deploy', 'matrix']) {
			await page.evaluate(mode => __send({ type: 'files', files: { 'model.json': JSON.stringify(AS_REAL.model), 'view.json': JSON.stringify({ mode, revision: mode }) } }), mode);
			await page.waitForTimeout(50);
		}
		assert.deepEqual({ errors, requests }, { errors: [], requests: [] });
		console.log('PASS: seven display modes, no browser errors or external requests');
	} finally {
		await browser.close();
	}
})().catch(error => { console.error(error); process.exitCode = 1; });
