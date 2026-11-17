/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { page as document } from './serve.mjs';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
let cases = 0;
const errors = [];
async function open(state = 'edit-done') {
	const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
	page.on('pageerror', error => errors.push(error.message));
	await page.clock.install();
	await page.setContent(document().html.replaceAll('new URLSearchParams(location.search)', `new URLSearchParams('sim=0&state=${state}')`));
	await page.waitForSelector('#ts-body');
	await page.clock.runFor(100);
	return page;
}
async function send(page, message) {
	await page.evaluate(message => window.__send(message), message);
	await page.clock.runFor(10);
}
async function begin(page) {
	await page.click('[data-act="recal"]');
	await page.clock.runFor(10);
	return page.evaluate(() => window.__posted.findLast(m => m.type === 'ask').requestId);
}
try {
	for (const state of ['settled', 'rejected', 'unconfirmed']) {
		for (const otherRunning of [false, true]) {
			const page = await open();
			const requestId = await begin(page);
			// A long queue is valid; the old one-shot timeout must not end it.
			await page.clock.fastForward(3600000);
			await send(page, { type: 'running', running: otherRunning, requests: otherRunning ? ['unrelated'] : [] });
			await send(page, { type: 'request', requestId: 'unrelated', state: 'settled' });
			assert.equal(await page.locator('.ts-modal').count(), 1);
			await send(page, { type: 'request', requestId, state });
			assert.equal(await page.locator('.ts-modal').count(), 0);
			assert.match(await page.locator('body').innerText(), state === 'unconfirmed' ? /Confira o pedido no chat/ : /O agente não recalibrou/);
			assert.equal(await page.evaluate(() => window.__posted.filter(m => m.type === 'ask').length), 1);
			cases++;
			await page.close();
		}
	}
	// Consecutive requests need no idle transition. A slow running request is valid too.
	const page = await open();
	const requestId = await begin(page);
	await send(page, { type: 'request', requestId, state: 'running' });
	await send(page, { type: 'running', running: true, requests: ['recal-request'] });
	await page.clock.fastForward(3600000);
	assert.equal(await page.locator('.ts-modal').count(), 1);
	await send(page, { type: 'running', running: true, requests: ['next-request'] });
	await send(page, { type: 'request', requestId, state: 'settled' });
	assert.equal(await page.locator('.ts-modal').count(), 0);
	cases++;
	await page.close();
	// A proposal committed just before completion wins over the terminal notification.
	const successful = await open();
	const successfulId = await begin(successful);
	await successful.evaluate(() => window.__send({ type: 'files', files: window.TS_SAMPLE.build('proposal').files }));
	await successful.clock.runFor(10);
	await send(successful, { type: 'request', requestId: successfulId, state: 'settled' });
	assert.doesNotMatch(await successful.locator('body').innerText(), /O agente não recalibrou/);
	assert.equal(await successful.locator('#ts-recal-title').count(), 0);
	cases++;
	await successful.close();
	// Reopening a persisted recalibration must not borrow another request's activity.
	for (const legacy of [false, true]) {
		const page = await open('recalibrating');
		assert.equal(await page.locator('#ts-recal-title').count(), 1);
		if (legacy) {
			await page.evaluate(() => {
				const files = { ...window.__files };
				const plan = JSON.parse(files['plan.json']);
				delete plan.recalibrating.requestId;
				files['plan.json'] = JSON.stringify(plan);
				window.__send({ type: 'files', files });
			});
		}
		await send(page, { type: 'running', running: true, requests: ['other-request'] });
		assert.match(await page.locator('.ts-modal').innerText(), /O agente parou/);
		await page.click('[data-act="recal-hide"]');
		assert.equal(await page.locator('.ts-modal').count(), 0);
		cases++;
		await page.close();
	}
	assert.deepEqual(errors, []);
	console.log(`${cases} recalibration browser scenarios passed; no polling, extra requests or page errors.`);
} finally {
	await browser.close();
}
