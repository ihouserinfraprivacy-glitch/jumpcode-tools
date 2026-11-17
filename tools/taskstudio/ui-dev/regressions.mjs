/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Browser regressions against the packaged interface, without a network server or model.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { page as document } from './serve.mjs';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
let checks = 0;
try {
	for (const mode of ['map', 'list', 'board', 'timeline', 'lanes', 'metro', 'focus', 'history']) {
		const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
		const errors = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.setContent(document().html.replaceAll('new URLSearchParams(location.search)', `new URLSearchParams('sim=0&state=running&mode=${mode}')`));
		await page.waitForSelector('#ts-body');
		const legacy = await page.evaluate(() => window.__files);
		const documents = Object.fromEntries(Object.entries(legacy).map(([name, text]) => [name, JSON.parse(text)]));
		const send = files => page.evaluate(files => window.__send({ type: 'files', files }), files);
		const state = () => ({ 'state.json': JSON.stringify({ schema: 1, revision: 1, documents }) });
		// Atomic state must take precedence over stale legacy files.
		documents['plan.json'].title = 'Plano atômico';
		await send({ ...legacy, ...state() });
		assert.match(await page.locator('body').innerText(), /Plano atômico/);
		const before = await page.locator('#ts-body').innerHTML();
		await send(state());
		assert.equal(await page.locator('#ts-body').innerHTML(), before);
		// A malformed snapshot does not partially replace the plan with an unrelated history.
		await send({ 'state.json': '{broken', ...legacy });
		assert.match(await page.locator('body').innerText(), /Plano atômico/);
		assert.match(await page.locator('body').innerText(), /última versão foi mantida/);
		await send(state());
		assert.doesNotMatch(await page.locator('body').innerText(), /última versão foi mantida/);
		assert.deepEqual(errors, []);
		checks += 6;
		await page.close();
	}
	const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
	await page.setContent(document().html.replaceAll('new URLSearchParams(location.search)', "new URLSearchParams('sim=0&state=running')"));
	await page.waitForSelector('.ts-card[data-id="6"]');
	const status = () => page.locator('.ts-card[data-id="6"] .cm .ts-pill').innerText();
	const active = requests => page.evaluate(requests => window.__send({ type: 'running', running: requests.length > 0, requests }), requests);
	const running = await status();
	await active(['unrelated-request']);
	assert.match(await status(), /Pausada/); checks++;
	await active(['dev-request']);
	assert.equal(await status(), running); checks++;
	await active([]);
	assert.match(await status(), /Pausada/); checks++;
	// A legacy running task without an identity cannot attach itself to any active request.
	await page.evaluate(() => {
		const files = { ...window.__files };
		const plan = JSON.parse(files['plan.json']);
		for (const task of plan.tasks) { delete task.requestId; }
		files['plan.json'] = JSON.stringify(plan);
		window.__send({ type: 'files', files });
	});
	await active(['dev-request']);
	assert.match(await status(), /Pausada/); checks++;
	await page.close();
	console.log(`${checks} browser regression checks passed; 8 modes, atomic snapshots and request identity.`);
} finally {
	await browser.close();
}
