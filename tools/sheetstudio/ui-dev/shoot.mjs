/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Dev only: captures every SheetStudio screen into ./shots/<width>x<height>/ and reports script errors, content
// that spills out of its box and horizontal scrollbars (both fail the run), and text cut with an ellipsis outside
// tables (listed for review). The size is the Studio webview's: SS_SIZE=<width>x<height>@<scale>, by default the
// real JumpCode window (1075x724 CSS px at devicePixelRatio 1.25); the approved mockups are 1344x905@1 and a smaller
// window gives about 960x700. Run from this folder: [SS_SIZE=960x700@1.25] node shoot.mjs [name,name,...]
import { chromium } from 'file:///C:/Projects/jumpcode/node_modules/playwright/index.mjs';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { start } from './serve.mjs';

const only = process.argv[2] ? new Set(process.argv[2].split(',')) : null;
const size = /^(\d+)x(\d+)(?:@([\d.]+))?$/.exec(process.env.SS_SIZE || '1075x724@1.25');
if (!size) {
	throw new Error('SS_SIZE must look like 1075x724@1.25');
}
const [width, height, scale] = [Number(size[1]), Number(size[2]), Number(size[3] || 1)];
const out = new URL(`./shots/${width}x${height}/`, import.meta.url);
mkdirSync(out, { recursive: true });
const click = (sel, detail = 1) => async page => {
	await page.locator(sel).first().dispatchEvent('click', { detail });
	await page.waitForTimeout(150);
};
const hover = sel => async page => {
	const box = await page.locator(sel).first().boundingBox();
	if (box) {
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await page.waitForTimeout(120);
	}
};

/** [name, query, optional async action(page), keep the mouse where the action left it] */
const SHOTS = [
	['01-empty', 'state=empty'],
	['01b-empty-noproject', 'state=empty&project=0'],
	['02-files-open', 'state=barbearia&view=files'],
	['03-importing', 'state=importing'],
	['04-sheet', 'state=barbearia&view=sheet'],
	['04b-sheet-cell', 'state=barbearia&view=sheet', click('td[data-act="cell"][data-r="7"][data-c="5"]')],
	['04c-sheet-csv', 'state=barbearia&view=sheet&csv=1', async page => { await page.locator('.ss-scroll[data-scroll="sheet-side"]').evaluate(el => { el.scrollTop = el.scrollHeight; }); await page.locator('select[data-key="separator"]').selectOption(','); await page.waitForTimeout(150); }],
	['05-sheet-filter', 'state=limpa&view=sheet'],
	['06-sheet-column', 'state=limpa&view=sheet&sel=x1'],
	['07-charts-bar', 'state=barbearia&view=charts&sel=g1'],
	['07b-charts-bar-tip', 'state=barbearia&view=charts&sel=g1', hover('svg rect[data-tt]'), true],
	['08-charts-calc', 'state=barbearia&view=charts&sel=g1', click('[data-act="calc-toggle"]')],
	['09-charts-hbar', 'state=barbearia&view=charts&sel=g2'],
	['10-charts-line', 'state=barbearia&view=charts&sel=g3'],
	['11-charts-heatmap', 'state=barbearia&view=charts&sel=g4'],
	['12-charts-stacked100', 'state=barbearia&view=charts&sel=g5'],
	['13-charts-pivot', 'state=barbearia&view=charts&sel=g6'],
	['14-charts-origin', 'state=barbearia&view=charts&sel=g7'],
	['15-charts-clean', 'state=limpa&view=charts&sel=g8'],
	['16-charts-stale', 'state=limpa&view=charts&sel=g1'],
	['16b-charts-stale-calc', 'state=limpa&view=charts&sel=g4', click('[data-act="calc-toggle"]')],
	['17-charts-none', 'state=barbearia&view=charts&charts=0'],
	['18-panel', 'state=barbearia&view=panel'],
	['19-panel-limpa', 'state=limpa&view=panel'],
	['19b-panel-none', 'state=barbearia&view=panel&charts=0'],
	['20-cleanup', 'state=barbearia&view=cleanup'],
	['21-cleanup-applied', 'state=limpa&view=cleanup'],
	['22-cleanup-unscanned', 'state=barbearia&view=cleanup&scanned=0'],
	['23-history', 'state=barbearia&view=history'],
	['24-history-limpa', 'state=limpa&view=history'],
	['25-profile', 'state=barbearia&view=profile&sel=valor'],
	['26-profile-data', 'state=limpa&view=profile&sel=data'],
	['27-settings', 'state=limpa&view=settings'],
	['27b-settings-changed', 'state=limpa&view=settings', async page => { await page.locator('select[data-key="decimal"]').selectOption('dot'); await page.waitForTimeout(150); }],
	['28-export-panel', 'state=limpa&view=panel', click('[data-act="export-open"]')],
	['29-export-chart', 'state=barbearia&view=charts&sel=g1', click('[data-act="export-open"][data-id="g1"]')],
	['30-menu', 'state=barbearia&view=sheet', click('[data-act="menu"]')],
	['31-note', 'state=barbearia&view=charts&sel=g2&note=Este é o faturamento por serviço, só dos concluídos'],
	['40-long-sheet', 'state=long&view=sheet'],
	['41-long-charts', 'state=long&view=charts&sel=g2'],
	['42-long-query', 'state=long&view=charts&sel=g99'],
	['43-long-panel', 'state=long&view=panel'],
	['44-long-cleanup', 'state=long&view=cleanup'],
	['45-long-history', 'state=long&view=history'],
	['46-long-files', 'state=long&view=files'],
	['47-long-profile', 'state=long&view=profile'],
	['48-long-export', 'state=long&view=charts&sel=g2', click('[data-act="export-open"][data-id="g2"]')],
	['49-long-settings', 'state=long&view=settings'],
];

/** Visible elements that stick out of the nearest box that clips them (text cut with an ellipsis is fine). */
function spills() {
	const found = [];
	const studio = document.querySelector('.ss-studio');
	for (const el of studio.querySelectorAll('*')) {
		const r = el.getBoundingClientRect();
		if (!r.width || !r.height || el.closest('td, th, svg, select, option, .ss-tt')) { continue; }
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
	// A horizontal scrollbar hides part of a panel (cut buttons, cut columns); a sheet wider than the Studio may scroll.
	for (const el of studio.querySelectorAll('*')) {
		const style = getComputedStyle(el);
		if (['auto', 'scroll'].includes(style.overflowX) && el.scrollWidth > el.clientWidth + 1 && !el.matches('.ss-gridwrap.wide')) {
			found.push(`hscroll ${el.tagName.toLowerCase()}.${String(el.className).trim().replace(/\s+/g, '.')} +${el.scrollWidth - el.clientWidth}px`);
		}
	}
	return [...new Set(found)].slice(0, 8);
}

/** Text cut with an ellipsis outside tables, to look at (paths and long names may be cut on purpose). */
function truncated() {
	const found = [];
	for (const el of document.querySelectorAll('.ss-studio *')) {
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
for (const [name, query, action, keepMouse] of SHOTS) {
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
	await page.waitForSelector('.ss-studio');
	await page.waitForTimeout(300);
	if (!keepMouse) {
		await page.mouse.move(1, 1);
	}
	if (action) {
		await action(page);
	}
	if (!keepMouse) {
		await page.mouse.move(1, 1);
	}
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
