/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Dev only: captures every TaskStudio screen into ./shots/ as 1344×905 images, the size of the
// Studio area in the approved mockups (a 1075×724 webview at 125% scale, like the mockups).
// Run from this folder: node shoot.mjs [name,name,...|real] [prefix] [--dpr1]
//   --dpr1 captures a 1344×905 webview at 100% instead.
import { chromium } from 'file:///C:/Projects/jumpcode/node_modules/playwright/index.mjs';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { start } from './serve.mjs';

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const dpr1 = process.argv.includes('--dpr1');
const only = args[0] ? new Set(args[0].split(',')) : null;
const prefix = args[1] || '';
const out = new URL('./shots/', import.meta.url);
mkdirSync(out, { recursive: true });

const click = sel => async page => {
	await page.locator(sel).first().dispatchEvent('click');
	await page.waitForTimeout(150);
};

/** [name, query, optional async action(page), optional viewport] */
const SHOTS = [
	['02-empty', 'state=empty'],
	['02b-empty-noproject', 'state=empty&project=0'],
	['03-planning', 'state=planning'],
	['03b-building', 'state=building'],
	['04-ready', 'state=ready'],
	['04b-ready-noproject', 'state=ready&project=0'],
	['05-running', 'state=running'],
	['05b-paused', 'state=paused'],
	['06-details', 'state=details'],
	['06b-view-json', 'state=view'],
	['07-gate', 'state=gate'],
	['07b-gate-approval', 'state=running', click('[data-act="gate"][data-id="11"]')],
	['08-problem', 'state=problem'],
	['09-edit-done', 'state=edit-done'],
	['09b-edit-typing', 'state=edit-done', async page => { await page.locator('.ts-diffview[data-field="detail"]').click(); await page.keyboard.type(' Tem combos.'); await page.waitForTimeout(100); }],
	['10-recalibrating', 'state=recalibrating'],
	['10b-recal-sent', 'state=running&sim=0&sel=3', async page => {
		await page.locator('[data-act="edit"][data-id="3"]').click();
		await page.locator('#ts-edit-detail').fill('Criar as tabelas de clientes, barbeiros, serviços e horários. Cada agendamento tem um ou mais serviços.');
		await page.locator('[data-act="recal"]').click();
		await page.waitForTimeout(150);
	}],
	['11-proposal', 'state=proposal'],
	['12-compare', 'state=compare'],
	['13-edit-running', 'state=edit-running'],
	['14-edit-todo', 'state=edit-todo'],
	['15-proposal-done', 'state=proposal-done'],
	['16-finished', 'state=finished'],
	['17-list', 'state=list'],
	['18-board', 'state=board'],
	['19-timeline', 'state=timeline'],
	['20-lanes', 'state=lanes'],
	['21-metro', 'state=metro'],
	['22-focus', 'state=focus'],
	['23-history', 'state=history'],
	['24-big', 'state=big'],
	['24b-big-list', 'state=big-list'],
	['24c-big-board', 'state=big-board'],
	['24d-big-timeline', 'state=big-timeline'],
	['24e-big-lanes', 'state=big-lanes'],
	['24f-big-open', 'state=big', click('[data-act="phase"][data-phase="Fase 4 · App do cliente"]')],
	['30-menu', 'state=running', click('[data-act="menu"]')],
	['31-search', 'state=running', async page => { await page.locator('[data-act="search-open"]').click(); await page.keyboard.type('pix'); await page.waitForTimeout(120); }],
	['32-bad-json', 'state=running&bad=1'],
	['33-history-v2', 'state=history', click('[data-act="hist"][data-n="2"]')],
	['34-proposal-side', 'state=proposal-done', click('[data-act="proposal-side"]')],
	['40-narrow', 'state=details', null, { width: 760, height: 700 }],
	['41-narrow-list', 'state=list', null, { width: 760, height: 700 }],
	// The real files the Python package wrote in tests/fixtures/barbearia.
	['r01-plan', 'data=real'],
	['r02-recalibrating', 'data=real&real=recalibrating'],
	['r03-proposal', 'data=real&real=proposal'],
	['r04-compare', 'data=real&real=proposal&mode=compare'],
	['r05-list', 'data=real&mode=list'],
	['r06-board', 'data=real&mode=board'],
	['r07-timeline', 'data=real&mode=timeline'],
	['r08-lanes', 'data=real&mode=lanes'],
	['r09-metro', 'data=real&mode=metro'],
	['r10-focus', 'data=real&mode=focus'],
	['r11-history', 'data=real&mode=history'],
	['r12-problem', 'data=real&sel=9'],
];

async function capture(page, path) {
	const shot = page.screenshot({ path, timeout: 15000 });
	try {
		await shot;
	} catch {
		// Fall back to a raw CDP capture when Playwright's screenshot hangs.
		const cdp = await page.context().newCDPSession(page);
		const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
		const { writeFileSync } = await import('node:fs');
		writeFileSync(path, Buffer.from(data, 'base64'));
		await cdp.detach();
	}
}

const server = await start();
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch();
const view = dpr1 ? { width: 1344, height: 905 } : { width: 1075, height: 724 };
const ctx = await browser.newContext({ viewport: view, deviceScaleFactor: dpr1 ? 1 : 1.25 });
const problems = [];
for (const [name, query, action, size] of SHOTS) {
	if ((only && !only.has(name) && !(only.has('real') && name.startsWith('r'))) || (prefix && !name.startsWith(prefix))) {
		continue;
	}
	const page = await ctx.newPage();
	if (size) {
		await page.setViewportSize(size);
	}
	const errors = [];
	page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
	page.on('console', m => {
		if (m.type() === 'error' || m.type() === 'warning' || /Content Security Policy|Refused/.test(m.text())) {
			errors.push(`console: ${m.text()}`);
		}
	});
	const t0 = Date.now();
	await page.goto(base + (query ? `?${query}` : ''));
	await page.waitForSelector('#ts-body');
	await page.waitForTimeout(250);
	if (action) {
		await action(page);
	}
	await page.mouse.move(1, 1);
	await page.waitForTimeout(80);
	const ms = Date.now() - t0;
	await capture(page, fileURLToPath(new URL(`${name}.png`, out)));
	const posted = await page.evaluate(() => window.__posted.map(m => m.type + (m.type === 'ask' ? `(${m.text.slice(0, 40)})` : '')).join(','));
	console.log(`${name}  ${ms} ms  posted=[${posted}]${errors.length ? '  ERRORS: ' + errors.join(' | ') : ''}`);
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
