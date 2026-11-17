/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Dev only: captures every AppStudio screen into ./shots/<width>x<height>/ and reports script errors, CSP refusals,
// content that spills out of its box and horizontal scrollbars (these fail the run), side columns that need a vertical
// scrollbar and text cut with an ellipsis (listed for review), and the chat requests each scripted click sent.
// Screenshots go through CDP (Page.captureScreenshot). The size is the Studio webview's: AS_SIZE=<w>x<h>@<scale>, by
// default the real JumpCode window (1075x724 CSS px at devicePixelRatio 1.25); the mockups are 1344x905@1 and a
// smaller window gives 960x700. Run from this folder: [AS_SIZE=1344x905@1] node shoot.mjs [name,name,...]
import { chromium } from 'file:///C:/Projects/jumpcode/node_modules/playwright/index.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { start } from './serve.mjs';

const only = process.argv[2] ? new Set(process.argv[2].split(',')) : null;
const size = /^(\d+)x(\d+)(?:@([\d.]+))?$/.exec(process.env.AS_SIZE || '1075x724@1.25');
if (!size) {
	throw new Error('AS_SIZE must look like 1075x724@1.25');
}
const [width, height, scale] = [Number(size[1]), Number(size[2]), Number(size[3] || 1)];
const out = new URL(`./shots/${width}x${height}/`, import.meta.url);
mkdirSync(out, { recursive: true });

const click = (sel, wait = 300) => async page => {
	await page.locator(sel).first().dispatchEvent('click');
	await page.waitForTimeout(wait);
};
/** Clicks inside the live preview frame, on the element the selector finds in the app document. */
const tapApp = (sel, wait = 400) => async page => {
	await page.evaluate(s => {
		const frame = [...document.querySelectorAll('.as-live iframe.as-if.on')][0];
		const el = frame?.contentDocument?.querySelector(s);
		el?.click();
	}, sel);
	await page.waitForTimeout(wait);
};
const choose = (sel, value) => async page => {
	await page.locator(sel).first().selectOption(String(value));
	await page.waitForTimeout(300);
};
const all = (...steps) => async page => { for (const step of steps) { await step(page); } };

/** [name, query, optional async action(page)] */
export const SHOTS = [
	['00-empty', 's=empty'],
	['01-building', 's=building'],
	['02-ready', 's=ready'],
	['02b-ready-servicos', 's=ready', click('.as-tcard[data-id="servicos"]')],
	['02c-ready-modal', 's=modal'],
	['03-android', 's=android'],
	['04-no-frame', 's=no-frame'],
	['05-fold-open', 's=fold-open'],
	['05b-fold-closed', 's=fold-closed'],
	['05c-fold-both', 's=fold-open', click('[data-act="fold"][data-fold="both"]', 900)],
	['05d-iphone-fold', 's=iphone-fold'],
	['06-tablet-landscape', 's=tablet-landscape'],
	['06b-tablet', 's=ready&device=tablet'],
	['06c-iphone-landscape', 's=ready', click('[data-act="rotate"]', 600)],
	['07-edit', 's=ready', all(click('[data-act="mode"][data-mode="edit"]'), tapApp('[data-part="proximo-horario"] .botao-claro'))],
	['08-screens', 's=screens'],
	['09-map', 's=map'],
	['09b-map-path', 's=map', click('.as-node[data-node="confirmado"]')],
	['09c-map-plain', 's=map', all(click('input[data-set="map-thumbs"]'))],
	['10-structure', 's=structure'],
	['11-test', 's=test', all(tapApp('.linha-servico'), tapApp('.linha-barbeiro:not(.livre)'))],
	['12-states', 's=states'],
	['12b-states-one', 's=states', click('[data-act="states-pick"][data-state="carregando"]', 900)],
	['13-problems', 's=problems'],
	['14-versions', 's=versions'],
	['15-publish', 's=publish'],
	['16-settings', 's=settings'],
	['16b-settings-changed', 's=settings', all(click('input[data-set="set-device"][data-device="tablet"]'), click('input[data-set="set-frame"]'))],
	['17-more-menu', 's=ready', click('[data-act="menu"]')],
	['18-python-real', 's=python-real'],
	['18b-python-real-preview', 's=python-real&view=preview'],
	['18c-python-real-map', 's=python-real&view=map'],
	['18d-python-real-states', 's=python-real&view=states&screen=horarios'],
	['18e-python-real-problems', 's=python-real&view=problems'],
	['19-agent-working', 's=problems', click('.as-prob [data-act="ask"]', 150)],
];

/** Visible elements that stick out of the nearest box that clips them (text cut with an ellipsis is fine). */
function spills() {
	const found = [];
	const studio = document.querySelector('.as-studio');
	for (const el of studio.querySelectorAll('*')) {
		const r = el.getBoundingClientRect();
		if (!r.width || !r.height || el.closest('td, th, select, option, .as-toast, .as-snap, .as-live, .as-map, .as-menu, .as-row') || el.tagName === 'IFRAME') { continue; }
		let box = el.parentElement;
		while (box && box !== studio) {
			const style = getComputedStyle(box);
			if (style.overflowX !== 'visible' || style.overflowY !== 'visible') { break; }
			box = box.parentElement;
		}
		if (!box) { continue; }
		const style = getComputedStyle(box);
		const b = box.getBoundingClientRect();
		const right = !['auto', 'scroll'].includes(style.overflowX) && r.right > b.right + 1.5;
		const bottom = !['auto', 'scroll'].includes(style.overflowY) && r.bottom > b.bottom + 1.5;
		if (right || bottom) {
			found.push(`${el.tagName.toLowerCase()}.${String(el.className.baseVal ?? el.className).trim().replace(/\s+/g, '.')} "${(el.textContent || '').trim().slice(0, 40)}" ${Math.round(r.right - b.right)}x${Math.round(r.bottom - b.bottom)}`);
		}
	}
	for (const el of studio.querySelectorAll('*')) {
		const style = getComputedStyle(el);
		if (['auto', 'scroll'].includes(style.overflowX) && el.scrollWidth > el.clientWidth + 1 && !el.matches('.as-strip, .as-mapwrap, .as-vp, .as-sframes')) {
			found.push(`hscroll ${el.tagName.toLowerCase()}.${String(el.className).trim().replace(/\s+/g, '.')} +${el.scrollWidth - el.clientWidth}px`);
		}
	}
	return [...new Set(found)].slice(0, 8);
}

/** Scroll boxes that need their vertical scrollbar, and text cut with an ellipsis, to look at. */
function review() {
	const scrolls = [];
	for (const el of document.querySelectorAll('.as-side, .as-main, .as-strip, .as-grid')) {
		if (el.scrollHeight > el.clientHeight + 1 && getComputedStyle(el).overflowY !== 'visible' && getComputedStyle(el).overflowY !== 'hidden') {
			scrolls.push(`${String(el.className).trim().replace(/\s+/g, '.')} +${el.scrollHeight - el.clientHeight}px`);
		}
	}
	for (const el of document.querySelectorAll('.as-strip')) {
		if (el.scrollWidth > el.clientWidth + 1) { scrolls.push(`strip +${el.scrollWidth - el.clientWidth}px wide`); }
	}
	const cut = [];
	for (const el of document.querySelectorAll('.as-studio *')) {
		if (el.closest('select, .as-snap, .as-live') || !el.clientWidth) { continue; }
		const style = getComputedStyle(el);
		if (style.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1) {
			cut.push(`"${(el.textContent || '').trim().slice(0, 50)}"`);
		}
	}
	return { scrolls: [...new Set(scrolls)].slice(0, 6), cut: [...new Set(cut)].slice(0, 10) };
}

export async function openPage(ctx, base, query, errors) {
	const page = await ctx.newPage();
	page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
	page.on('console', msg => {
		if (msg.type() === 'error' || msg.type() === 'warning' || /Content Security Policy|Refused/.test(msg.text())) {
			errors.push(`console: ${msg.text().slice(0, 200)}`);
		}
	});
	await page.goto(base + (query ? `?${query}` : ''));
	await page.waitForSelector('.as-studio');
	// The live preview is ready when its frame shows the app (or when there is no app).
	await page.waitForFunction(() => !document.querySelector('.as-live') || document.querySelector('.as-live iframe.as-if.on'), null, { timeout: 15000 }).catch(() => errors.push('timeout: the preview did not load'));
	await page.waitForTimeout(700);
	return page;
}

if (process.argv[1]?.endsWith('shoot.mjs')) {
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
		const errors = [];
		const page = await openPage(ctx, base, query, errors);
		await page.mouse.move(1, 1);
		if (action) {
			await action(page);
		}
		await page.waitForTimeout(350);
		const cdp = await page.context().newCDPSession(page);
		const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
		writeFileSync(fileURLToPath(new URL(`${name}.png`, out)), Buffer.from(data, 'base64'));
		await cdp.detach();
		const spilled = await page.evaluate(spills);
		const { scrolls, cut } = await page.evaluate(review);
		const posted = await page.evaluate(() => window.__posted.filter(m => m.type === 'ask' || m.type === 'stop').map(m => m.type === 'stop' ? 'stop' : `${m.send ? 'send' : 'fill'}: ${m.text}`).join(' | '));
		console.log(`${name}${posted ? `  asks=[${posted}]` : ''}${errors.length ? '  ERRORS: ' + errors.join(' | ') : ''}${spilled.length ? '  SPILLS: ' + spilled.join(' ; ') : ''}${scrolls.length ? '  scroll: ' + scrolls.join(' ; ') : ''}${cut.length ? '  cut: ' + cut.join(' ') : ''}`);
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
}
