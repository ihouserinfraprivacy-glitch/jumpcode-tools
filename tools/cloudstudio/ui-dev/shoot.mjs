/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Dev only: captures every CloudStudio screen into ./shots/ at the size of the Studio area in the approved
// mockups (a 1344×905 webview). Run from this folder: node shoot.mjs [name,name,...]
import { chromium } from 'file:///C:/Projects/jumpcode/node_modules/playwright/index.mjs';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { start } from './serve.mjs';

const only = process.argv[2] ? new Set(process.argv[2].split(',')) : null;
const out = new URL('./shots/', import.meta.url);
mkdirSync(out, { recursive: true });
const click = sel => async page => {
	await page.locator(sel).first().dispatchEvent('click');
	await page.waitForTimeout(150);
};

/** [name, query, optional async action(page)] */
const SHOTS = [
	['01-first', 'state=first'],
	['01b-first-noproject', 'state=first&project=0'],
	['02-starting', 'state=first', click('[data-act="start-cloud"]')],
	['03-overview', 'view=overview'],
	['04-resources-table', 'view=resources&sel=table:agendamentos'],
	['05-resources-bucket', 'view=resources&sel=bucket:barbearia-fotos', click('[data-item="tabela-de-precos.json"]')],
	['06-resources-function', 'view=resources&sel=function:enviar-lembrete'],
	['07-resources-api', 'view=resources&sel=api:barbearia-api'],
	['08-resources-dlq', 'view=resources&sel=queue:lembretes-dlq'],
	['09-resources-machine', 'view=resources&sel=statemachine:confirmar-pagamento'],
	['10-resources-secret', 'view=resources&sel=secret:whatsapp/token'],
	['11-resources-schedule', 'view=resources&sel=schedule:lembrete-diario'],
	['12-map', 'view=map'],
	['13-calls-error', 'view=calls', async page => { await page.locator('[data-act="call-filter"][data-id="errors"]').dispatchEvent('click'); await page.waitForTimeout(100); await page.locator('tr[data-act="call"]').last().dispatchEvent('click'); await page.waitForTimeout(150); }],
	['14-logs', 'view=logs'],
	['15-copies', 'view=copies'],
	['16-catalog', 'view=catalog'],
	['17-settings', 'view=settings'],
	['18-stopped', 'state=stopped&view=overview'],
	['19-menu', 'view=overview', click('[data-act="menu"]')],
	['20-confirm-reset', 'view=copies', click('[data-act="reset"]')],
	['21-api-send', 'view=resources&sel=api:barbearia-api', async page => {
		await page.locator('textarea[data-draft^="body:"]').fill('{"cliente": "Zé", "servico": "corte"}');
		await page.locator('[data-act="request"]').dispatchEvent('click');
		await page.waitForTimeout(150);
	}],
	['22-api-bad-body', 'view=resources&sel=api:barbearia-api', async page => {
		await page.locator('textarea[data-draft^="body:"]').fill('{cliente: Zé}');
		await page.locator('[data-act="request"]').dispatchEvent('click');
		await page.waitForTimeout(150);
	}],
];

const server = await start();
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1344, height: 905 }, deviceScaleFactor: 1 });
const problems = [];
for (const [name, query, action] of SHOTS) {
	if (only && !only.has(name)) {
		continue;
	}
	const page = await ctx.newPage();
	const errors = [];
	page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
	page.on('console', m => {
		if (m.type() === 'error' || m.type() === 'warning' || /Content Security Policy|Refused/.test(m.text())) {
			errors.push(`console: ${m.text()}`);
		}
	});
	await page.goto(base + (query ? `?${query}` : ''));
	await page.waitForSelector('.cs-studio');
	await page.waitForTimeout(300);
	if (action) {
		await action(page);
	}
	await page.mouse.move(1, 1);
	await page.waitForTimeout(80);
	await page.screenshot({ path: fileURLToPath(new URL(`${name}.png`, out)) });
	const posted = await page.evaluate(() => window.__posted.map(m => m.type + (m.type === 'ask' ? `(${m.text.slice(0, 120)})` : '')).join(','));
	console.log(`${name}  posted=[${posted}]${errors.length ? '  ERRORS: ' + errors.join(' | ') : ''}`);
	if (errors.length) {
		problems.push(name);
	}
	await page.close();
}
await browser.close();
server.close();
if (problems.length) {
	console.log(`\nProblems in: ${problems.join(', ')}`);
	process.exitCode = 1;
}
