/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Dev only: captures every PayStudio screen into ./shots/<width>x<height>/ and reports script errors, content
// that spills out of its box and horizontal scrollbars (both fail the run), and text cut with an ellipsis outside
// tables (listed for review). The size is the Studio webview's: PS_SIZE=<width>x<height>@<scale>, by default the
// real JumpCode window (1075x724 CSS px at devicePixelRatio 1.25); the approved mockups are 1344x905@1 and a smaller
// window gives about 960x700. Run from this folder: [PS_SIZE=960x700] node shoot.mjs [name,name,...]
import { chromium } from 'file:///C:/Projects/jumpcode/node_modules/playwright/index.mjs';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { start } from './serve.mjs';

const only = process.argv[2] ? new Set(process.argv[2].split(',')) : null;
const size = /^(\d+)x(\d+)(?:@([\d.]+))?$/.exec(process.env.PS_SIZE || '1075x724@1.25');
if (!size) {
	throw new Error('PS_SIZE must look like 1075x724@1.25');
}
const [width, height, scale] = [Number(size[1]), Number(size[2]), Number(size[3] || 1)];
const out = new URL(`./shots/${width}x${height}/`, import.meta.url);
mkdirSync(out, { recursive: true });
const click = (sel, detail = 1) => async page => {
	await page.locator(sel).first().dispatchEvent('click', { detail });
	await page.waitForTimeout(150);
};

// The scenario makes new ids on every run (python scenario.py), so the charges are found by booking.
const charges = JSON.parse(readFileSync(new URL('./fixtures/barbearia/charges.json', import.meta.url), 'utf8')).charges;
const key = (booking, gateway, test = () => true) => { const c = charges.find(x => x.booking === booking && x.gateway === gateway && test(x)); return `${gateway}:${c.ref}`; };
const PIX = key('AG-4830', 'pix');
const EXPIRED = key('AG-4828', 'pix');
const DUPLICATE = key('AG-4839', 'stripe', c => c.flags.length);
const REFUNDED = key('AG-4837', 'stripe');
const DISPUTED = key('AG-4838', 'stripe');
const DECLINED = key('AG-4832', 'mercadopago');
const deliveries = JSON.parse(readFileSync(new URL('./fixtures/barbearia/webhooks.json', import.meta.url), 'utf8')).deliveries;
const calls = JSON.parse(readFileSync(new URL('./fixtures/barbearia/calls.json', import.meta.url), 'utf8')).calls;
const COPY = deliveries.find(d => d.gateway === 'pix' && d.copy_of).id;
const FAILING = deliveries.find(d => d.signature === 'valid' && d.attempts.some(a => a.status >= 500)).id;
const FORGED = deliveries.find(d => d.signature === 'wrong' && d.attempts.some(a => a.status >= 200 && a.status < 300)).id;
const NO_KEY = calls.find(k => /Idempotency/.test(k.error?.message || '')).id;

/** [name, query, optional async action(page)] */
const SHOTS = [
	['02-first', 'state=first'],
	['02b-first-noproject', 'state=first&project=0'],
	['02c-off', 'state=off&view=charges'],
	['02d-starting', 'state=first', click('[data-act="start"]')],
	['03-settings', 'view=settings'],
	['04-overview', 'view=overview'],
	['05-charges', `view=charges`, click(`tr[data-key="${DUPLICATE}"]`)],
	['05b-charges-pix-row', 'view=charges', click(`tr[data-key="${PIX}"]`)],
	['06-charge-pix', `view=charges&sel=${PIX}`],
	['06b-charge-pix-twice', `view=charges&sel=${PIX}`, async page => {
		await page.locator('select[data-draft^="delay:"]').selectOption('120');
		await page.locator('input[data-draft^="dup:"]').check();
		await page.locator('[data-act="pay"]').first().dispatchEvent('click');
		await page.waitForTimeout(150);
	}],
	['07-cards', 'view=cards', click('tr[data-id="mp:FUND"]')],
	['08-webhooks', 'view=webhooks', click(`tr[data-act="hook"][data-id="${COPY}"]`)],
	['09-webhook-failing', `view=webhooks&sel=${FAILING}`],
	['10-scenarios', 'view=scenarios&sel=pix_atrasado_duplicado'],
	['11-scenarios-failures', 'view=scenarios&sel=gateway_fora_do_ar'],
	['12-timeline', 'view=timeline&sel=AG-4840'],
	['12b-timeline-pix', 'view=timeline&sel=AG-4827'],
	['12c-timeline-all', 'view=timeline', async page => { await page.locator('select[data-act="timeline-booking"]').selectOption('*'); await page.waitForTimeout(150); }],
	['13-charge-refunded', `view=charges&sel=${REFUNDED}`],
	['13b-charge-disputed', `view=charges&sel=${DISPUTED}`],
	['13c-charge-declined', `view=charges&sel=${DECLINED}`],
	['14-webhooks-signature', 'view=webhooks', click(`tr[data-act="hook"][data-id="${FORGED}"]`)],
	['14b-webhook-signature-detail', `view=webhooks&sel=${FORGED}`],
	['16-charge-duplicate', `view=charges&sel=${DUPLICATE}`],
	['16b-calls', 'view=calls', click(`tr[data-act="call"][data-id="${NO_KEY}"]`)],
	['17-charge-expired', `view=charges&sel=${EXPIRED}`],
	['18-catalog', 'view=catalog'],
	['19-menu', 'view=overview', click('[data-act="menu"]')],
	['20-confirm-reset', 'view=settings', click('[data-act="reset"]')],
	['21-focus-note', `view=charges&sel=${PIX}&note=Este é o Pix da Ana, ainda sem pagamento`],
	['30-empty-overview', 'state=empty&view=overview'],
	['31-empty-charges', 'state=empty&view=charges'],
	['32-empty-webhooks', 'state=empty&view=webhooks'],
	['33-empty-timeline', 'state=empty&view=timeline'],
	['34-empty-settings', 'state=empty&view=settings'],
	['40-long-overview', 'state=long&view=overview'],
	['41-long-charges', 'state=long&view=charges'],
	['42-long-pix', `state=long&view=charges&sel=${PIX}`],
	['43-long-calls', 'state=long&view=calls', click('tr[data-act="call"][data-id="999"]')],
	['44-long-settings', 'state=long&view=settings'],
	['45-off-cards', 'state=off&view=cards'],
	['46-off-settings', 'state=off&view=settings'],
	['47-scenarios-cards', 'view=scenarios&sel=sem_saldo'],
	['48-catalog-stripe', 'view=catalog&sel=stripe'],
	['49-menu-catalog', 'view=catalog', click('[data-act="menu"]')],
];

/** Visible elements that stick out of the nearest box that clips them (text cut with an ellipsis is fine). */
function spills() {
	const found = [];
	const studio = document.querySelector('.ps-studio');
	for (const el of studio.querySelectorAll('*')) {
		const r = el.getBoundingClientRect();
		if (!r.width || !r.height || el.closest('td, th, .tx, .t, .ps-tl, .ps-seq, svg, .ps-emv, .ps-code, .ps-log, select, option')) { continue; }
		let box = el.parentElement;
		while (box && box !== studio) {
			const style = getComputedStyle(box);
			if (style.overflowX !== 'visible' || style.overflowY !== 'visible') { break; }
			box = box.parentElement;
		}
		if (!box) { continue; }
		const style = getComputedStyle(box);
		if (['auto', 'scroll'].includes(style.overflowX) || ['auto', 'scroll'].includes(style.overflowY)) { continue; }
		const b = box.getBoundingClientRect();
		if (r.right > b.right + 1.5 || r.bottom > b.bottom + 1.5) {
			found.push(`${el.tagName.toLowerCase()}.${String(el.className.baseVal ?? el.className).trim().replace(/\s+/g, '.')} "${(el.textContent || '').trim().slice(0, 40)}" ${Math.round(r.right - b.right)}x${Math.round(r.bottom - b.bottom)}`);
		}
	}
	// A horizontal scrollbar hides part of a panel (cut buttons, cut columns).
	for (const el of studio.querySelectorAll('*')) {
		const style = getComputedStyle(el);
		if (['auto', 'scroll'].includes(style.overflowX) && el.scrollWidth > el.clientWidth + 1) {
			found.push(`hscroll ${el.tagName.toLowerCase()}.${String(el.className).trim().replace(/\s+/g, '.')} +${el.scrollWidth - el.clientWidth}px`);
		}
	}
	return [...new Set(found)].slice(0, 8);
}

/** Text cut with an ellipsis outside tables, to look at (ids and paths may be cut on purpose). */
function truncated() {
	const found = [];
	for (const el of document.querySelectorAll('.ps-studio *')) {
		if (el.closest('td, th, select') || !el.clientWidth) { continue; }
		const style = getComputedStyle(el);
		if (style.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1) {
			found.push(`"${(el.textContent || '').trim().slice(0, 60)}"`);
		}
	}
	return [...new Set(found)].slice(0, 10);
}

const server = await start();
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale });
console.log(`${width}x${height}@${scale} -> ${fileURLToPath(out)}`);
const problems = [];
for (const [name, query, action] of SHOTS) {
	if (only && !only.has(name)) {
		continue;
	}
	const page = await ctx.newPage();
	const errors = [];
	page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
	page.on('console', msg => {
		if (msg.type() === 'error' || msg.type() === 'warning' || /Content Security Policy|Refused/.test(msg.text())) {
			errors.push(`console: ${msg.text()}`);
		}
	});
	await page.goto(base + (query ? `?${query}` : ''));
	await page.waitForSelector('.ps-studio');
	await page.waitForTimeout(300);
	if (action) {
		await action(page);
	}
	await page.mouse.move(1, 1);
	await page.waitForTimeout(80);
	await page.screenshot({ path: fileURLToPath(new URL(`${name}.png`, out)) });
	const spilled = await page.evaluate(spills);
	const cut = await page.evaluate(truncated);
	const posted = await page.evaluate(() => window.__posted.filter(m => m.type === 'ask').map(m => `${m.send ? 'send' : 'fill'}: ${m.text.slice(0, 150)}`).join(' | '));
	console.log(`${name}${posted ? `  asks=[${posted}]` : ''}${errors.length ? '  ERRORS: ' + errors.join(' | ') : ''}${spilled.length ? '  SPILLS: ' + spilled.join(' ; ') : ''}${cut.length ? '  cut: ' + cut.join(' ') : ''}`);
	if (errors.length || spilled.length) {
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
