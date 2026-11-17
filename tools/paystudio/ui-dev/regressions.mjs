/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Local browser checks; the fake host records the asks without executing agent actions. The size is the Studio
// webview's, PS_SIZE=<width>x<height>@<scale> (default: the real JumpCode window, 1075x724 at 1.25).
// Run from this folder: [PS_SIZE=1344x905@1] node regressions.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'file:///C:/Projects/jumpcode/node_modules/playwright/index.mjs';
import { start } from './serve.mjs';

const VIEWS = ['overview', 'charges', 'webhooks', 'scenarios', 'timeline', 'calls', 'cards', 'catalog', 'settings'];
// The scenario makes new ids on every run (python ui-dev/scenario.py), so the charges and the webhook are found by booking.
const FIXTURES = new URL('./fixtures/barbearia/', import.meta.url);
const charges = JSON.parse(readFileSync(new URL('charges.json', FIXTURES), 'utf8')).charges;
const deliveries = JSON.parse(readFileSync(new URL('webhooks.json', FIXTURES), 'utf8')).deliveries;
const byBooking = (booking, gateway) => charges.find(c => c.booking === booking && c.gateway === gateway);
const PIX = `pix:${byBooking('AG-4830', 'pix').ref}`;
const PAID = byBooking('AG-4834', 'stripe').ref;
const DUPLICATE = charges.find(c => c.booking === 'AG-4839' && c.flags.length).ref;
const HOOK = String(deliveries.find(d => d.gateway === 'stripe' && d.attempts.some(a => a.status >= 500)).id);

const size = /^(\d+)x(\d+)(?:@([\d.]+))?$/.exec(process.env.PS_SIZE || '1075x724@1.25');
if (!size) {
	throw new Error('PS_SIZE must look like 1075x724@1.25');
}
const viewport = { width: Number(size[1]), height: Number(size[2]) };

const server = await start();
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport, deviceScaleFactor: Number(size[3] || 1) });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') { errors.push(message.text()); } });
const lastAsk = () => page.evaluate(() => window.__posted.filter(m => m.type === 'ask').at(-1));
const sendFiles = (revision, view, select) => page.evaluate(([r, v, s]) => {
	const files = {};
	const port = JSON.parse(window.PS_FILES['pay.json']).port;
	for (const [name, text] of Object.entries(window.PS_FILES)) {
		files[name] = text.split(`127.0.0.1:${port}`).join('127.0.0.1:4570');
	}
	files['view.json'] = JSON.stringify({ schema: 1, revision: r, view: v, select: s, note: '' });
	window.dispatchEvent(new MessageEvent('message', { data: { type: 'files', files } }));
}, [revision, view, select]);
const results = {};
try {
	for (const state of ['running', 'empty', 'long']) {
		for (const view of VIEWS) {
			await page.goto(`${url}/?state=${state}&view=${view}`);
			await page.waitForSelector('.ps-studio');
			assert.ok((await page.locator('.ps-body').innerText()).trim(), `${state}/${view} is empty`);
			const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
			assert.ok(wide <= 0, `${state}/${view} scrolls sideways by ${wide}px`);
			const scrollbars = await page.evaluate(() => [...document.querySelectorAll('.ps-studio *')]
				.filter(el => ['auto', 'scroll'].includes(getComputedStyle(el).overflowX) && el.scrollWidth > el.clientWidth + 1).map(el => el.className));
			assert.deepEqual(scrollbars, [], `${state}/${view} has a horizontal scrollbar`);
			const bar = await page.evaluate(() => { const el = document.querySelector('.ps-bar'); return el.scrollWidth - el.clientWidth; });
			assert.ok(bar <= 1, `${state}/${view}: the toolbar is cut by ${bar}px`);
		}
	}
	results.views = VIEWS.length * 3;

	// Off: every main view shows the first-open screen and Ligar asks the agent.
	await page.goto(`${url}/?state=off&view=charges`);
	await page.waitForSelector('.ps-hero');
	await page.locator('.ps-btn.primary[data-act="start"]').click();
	let ask = await lastAsk();
	assert.equal(ask.send, true);
	assert.match(ask.text, /^Ligue o gateway de teste do PayStudio/);
	assert.ok(ask.requestId);
	await page.waitForSelector('text=Ligando o gateway de teste');
	results.off = 'passed';

	// The agent's focus (view.json) switches the view and the selection once per revision.
	await page.goto(`${url}/?view=overview`);
	await page.waitForSelector('.ps-boxes');
	await sendFiles(2, 'charges', PIX);
	await page.waitForSelector('.ps-qr img');
	assert.match(await page.locator('.ps-strip b').first().innerText(), /AG-4830/);
	assert.ok((await page.locator('.ps-qr img').getAttribute('src')).startsWith('data:image/svg+xml;base64,'));
	await sendFiles(3, 'webhooks', HOOK);
	await page.waitForSelector('text=Tentativas');
	assert.ok((await page.locator('.ps-strip b').first().innerText()).includes(`#${HOOK} `));
	await page.locator('[data-act="resend"]').first().click();
	ask = await lastAsk();
	assert.ok(ask.text.startsWith(`Reenvie o webhook #${HOOK} `), ask.text);
	await sendFiles(4, 'timeline', 'AG-4827');
	await page.waitForSelector('.ps-seq');
	assert.equal(await page.locator('select[data-act="timeline-booking"]').inputValue(), 'AG-4827');
	await page.locator('.ps-vb[data-view="overview"]').click();
	await sendFiles(4, 'timeline', 'AG-4827');
	await page.waitForSelector('.ps-boxes');
	assert.equal(await page.locator('.ps-seq').count(), 0, 'the same revision must not move the Studio again');
	results.focus = 'passed';

	// A double click opens a charge or a webhook.
	await page.goto(`${url}/?view=charges`);
	await page.locator(`tr[data-key="${PIX}"]`).dblclick();
	await page.waitForSelector('.ps-qr img');
	await page.locator('[data-act="charge-back"]').click();
	await page.waitForSelector('.ps-tabs');
	await page.goto(`${url}/?view=webhooks`);
	await page.locator(`tr[data-act="hook"][data-id="${HOOK}"]`).dblclick();
	await page.waitForSelector('text=Reenvio rápido para testes');
	results.open = 'passed';

	// Buttons ask the agent with the booking or the ids, never touching the gateway.
	await page.goto(`${url}/?view=charges&sel=${PIX}`);
	await page.waitForSelector('.ps-qr');
	await page.locator('select[data-draft^="delay:"]').selectOption('30');
	await page.locator('[data-act="pay"]').first().click();
	ask = await lastAsk();
	assert.equal(ask.text, 'Pague o Pix do agendamento AG-4830 no PayStudio, com o webhook chegando 30 s depois.');
	await page.locator('[data-act="expire"]').first().click();
	ask = await lastAsk();
	assert.equal(ask.text, 'Deixe vencer o Pix do agendamento AG-4830 no PayStudio, sem pagamento.');
	await page.goto(`${url}/?view=charges&sel=stripe:${PAID}`);
	await page.waitForSelector('[data-act="refund"]');
	await page.locator('input[value="partial"]').check();
	await page.locator('input[data-draft^="refund-value:"]').fill('20,50');
	await page.locator('[data-act="refund"]').click();
	ask = await lastAsk();
	assert.equal(ask.text, 'Estorne R$\u00a020,50 da cobrança do agendamento AG-4834 no PayStudio.');
	await page.goto(`${url}/?view=charges&sel=stripe:${DUPLICATE}`);
	await page.waitForSelector('text=As duas chamadas');
	await page.locator('[data-act="ask-charge"]').click();
	ask = await lastAsk();
	assert.equal(ask.send, false, 'questions fill the composer');
	assert.ok(ask.text.includes(`${DUPLICATE} (AG-4839)`), 'a booking with two charges names the charge');
	await page.goto(`${url}/?view=scenarios&sel=pix_atrasado_duplicado`);
	await page.locator('[data-act="run-scenario"]').click();
	ask = await lastAsk();
	assert.match(ask.text, /^Rode o cenário "Pix pago, webhook 2 min atrasado e duplicado" do PayStudio \(pix_atrasado_duplicado\)\.$/);
	await page.locator('input[name="fail-mode"][value="slow"]').check();
	await page.locator('[data-draft="fail-latency"]').fill('3');
	await page.locator('[data-act="failure"]').click();
	ask = await lastAsk();
	assert.equal(ask.text, 'Faça todos os gateways do PayStudio demorar 3 s para responder nas próximas 5 chamadas.');
	const asks = await page.evaluate(() => window.__posted.filter(m => m.type !== 'ask' && m.type !== 'ready').length);
	assert.equal(asks, 0, 'the interface only sends ready and ask');
	results.asks = 'passed';

	// Keys never reach the page: only their names and "só no .env.local".
	await page.goto(`${url}/?view=settings`);
	const text = await page.locator('.ps-body').innerText();
	assert.match(text, /STRIPE_SECRET_KEY=•+ só no \.env\.local/);
	assert.doesNotMatch(text, /sk_test_ps_[A-Za-z0-9]|whsec_[A-Za-z0-9]{8}/);
	results.secrets = 'passed';

	// A missing/broken route must never look like a successful signature validation.
	await page.goto(`${url}/?view=scenarios`);
	await page.waitForSelector('.ps-sig');
	for (const [ok, status, label] of [[null, 500, 'inconclusivo'], [null, 404, 'inconclusivo'], [true, 400, 'recusou 400'], [false, 200, 'aceitou 200']]) {
		await page.evaluate(([ok, status]) => {
			const files = { ...window.PS_FILES };
			const pay = JSON.parse(files['pay.json']);
			pay.checks = [{ gateway: 'stripe', kind: 'signature', ok, status, at: Date.now() / 1000, text: 'Resultado da verificação' }];
			files['pay.json'] = JSON.stringify(pay);
			window.dispatchEvent(new MessageEvent('message', { data: { type: 'files', files } }));
		}, [ok, status]);
		await page.waitForFunction(label => [...document.querySelectorAll('.ps-sig')].some(el => el.textContent.includes(label)), label);
	}
	results.signature = 'passed';

	assert.deepEqual(errors, []);
	console.log(JSON.stringify({ size: process.env.PS_SIZE || '1075x724@1.25', ...results, scriptErrors: errors }));
} finally {
	await browser.close();
	await new Promise(resolve => server.close(resolve));
}
