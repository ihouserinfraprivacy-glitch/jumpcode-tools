/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Dev only: captures every 3D Generator screen into ./shots/<width>x<height>/ and reports script errors, CSP refusals,
// content that spills out of its box and horizontal scrollbars (these fail the run), side columns that need a vertical
// scrollbar and text cut with an ellipsis (listed for review), and the chat requests each scripted click sent.
// WebGL runs on SwiftShader; screenshots go through CDP (Page.captureScreenshot), which does not wait for the animation
// loop to idle. The size is the Studio webview's: G3_SIZE=<width>x<height>@<scale>, by default the real JumpCode window
// (1075x724 CSS px at devicePixelRatio 1.25); the mockups are 1344x905@1 and a smaller window gives 960x700.
// Run from this folder: [G3_SIZE=1344x905@1] node shoot.mjs [name,name,...]
import { chromium } from 'file:///C:/Projects/jumpcode/node_modules/playwright/index.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { start } from './serve.mjs';

const only = process.argv[2] ? new Set(process.argv[2].split(',')) : null;
const size = /^(\d+)x(\d+)(?:@([\d.]+))?$/.exec(process.env.G3_SIZE || '1075x724@1.25');
if (!size) {
	throw new Error('G3_SIZE must look like 1075x724@1.25');
}
const [width, height, scale] = [Number(size[1]), Number(size[2]), Number(size[3] || 1)];
const out = new URL(`./shots/${width}x${height}/`, import.meta.url);
mkdirSync(out, { recursive: true });

const click = (sel, wait = 250) => async page => {
	await page.locator(sel).first().dispatchEvent('click');
	await page.waitForTimeout(wait);
};
const choose = (sel, value) => async page => {
	await page.locator(sel).first().selectOption(String(value));
	await page.waitForTimeout(200);
};
const check = sel => async page => {
	await page.locator(sel).first().click();
	await page.waitForTimeout(200);
};
const all = (...steps) => async page => { for (const step of steps) { await step(page); } };

/** [name, query, optional async action(page)] */
export const SHOTS = [
	['00-blank', 's=blank'],
	['01-noengine', 's=noengine'],
	['02-start', 's=start'],
	['02b-start-pick', 's=start', click('.g3-img[data-path="arte/personagens/policial.png"]')],
	['03-image-archer', 's=image-archer'],
	['03b-image-archer-point', 's=image-archer', click('tr[data-key="shoulders"]')],
	['04-image-jay', 's=image-jay'],
	['05-image-bust', 's=image-bust'],
	['06-image-horse', 's=image-horse'],
	['07-running', 's=running'],
	['08-running-regen', 's=running-regen'],
	['09-queue', 's=queue'],
	['10-model-jay', 's=model-jay'],
	['11-model-archer', 's=model-archer'],
	['11b-model-archer-side', 's=model-archer&camera=side'],
	['11c-model-archer-back', 's=model-archer&camera=back'],
	['11d-model-archer-top', 's=model-archer&camera=top'],
	['11e-model-archer-bones', 's=model-archer', click('[data-tool="bones"]')],
	['12-model-tiger', 's=model-tiger'],
	['13-static-police', 's=static-police'],
	['14-static-horse', 's=static-horse'],
	['15-skeleton', 's=model-archer&view=skeleton'],
	['16-weights', 's=model-archer&view=skeleton&bone=upperarm_l'],
	['16b-weights-thigh', 's=model-jay&view=skeleton&bone=thigh_r'],
	['16c-weights-fingers', 's=model-archer&view=skeleton&bone=index_02_l'],
	['17-animations', 's=model-archer&view=animations&animation=walk'],
	['17b-animations-greeting', 's=model-jay&view=animations&animation=greeting'],
	['17c-animations-draft', 's=model-archer&view=animations&animation=walk', all(click('[data-act="anim-row"][data-name="run-anime"]'), click('[data-act="anim-row"][data-name="victory"]'), check('input[data-act="anim-toggle"][data-name="jump-2"]'))],
	['17d-animations-paused', 's=model-archer&view=animations&animation=dance-simple', click('[data-act="play"]', 600)],
	['18-animations-static', 's=static-police&view=animations'],
	['19-models', 's=models'],
	['19b-models-list', 's=models', click('[data-act="gallery"][data-mode="list"]')],
	['19c-models-police', 's=models', click('.g3-card[data-path="modelos/policial.glb"]')],
	['20-settings', 's=settings'],
	['20b-settings-changed', 's=settings', all(choose('select[data-set="texture"]', 1024), choose('select[data-set="faces"]', 40000), check('input[data-act="set-anim"][data-name="run-anime"]'))],
	['21-failed', 's=failed'],
	['22-skeleton-static', 's=static-horse&view=skeleton'],
	['23-empty-model', 's=start&view=model'],
	['24-python-real', 's=python-real'],
	['24b-python-real-model', 's=python-real&view=model'],
	['24c-python-real-image', 's=python-real&view=image'],
	['24d-python-real-models', 's=python-real&view=models'],
	['25-agent-working', 's=image-archer', click('[data-act="generate-image"]', 150)],
];

/** Visible elements that stick out of the nearest box that clips them (text cut with an ellipsis is fine). */
function spills() {
	const found = [];
	const studio = document.querySelector('.g3-studio');
	for (const el of studio.querySelectorAll('*')) {
		const r = el.getBoundingClientRect();
		if (!r.width || !r.height || el.closest('td, th, select, option, canvas, .g3-toast') || el.tagName === 'canvas') { continue; }
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
		if (['auto', 'scroll'].includes(style.overflowX) && el.scrollWidth > el.clientWidth + 1) {
			found.push(`hscroll ${el.tagName.toLowerCase()}.${String(el.className).trim().replace(/\s+/g, '.')} +${el.scrollWidth - el.clientWidth}px`);
		}
	}
	return [...new Set(found)].slice(0, 8);
}

/** Scroll boxes that need their vertical scrollbar, and text cut with an ellipsis, to look at. */
function review() {
	const scrolls = [];
	for (const el of document.querySelectorAll('.g3-side, .g3-pb')) {
		if (el.scrollHeight > el.clientHeight + 1 && getComputedStyle(el).overflowY !== 'visible') {
			scrolls.push(`${String(el.className).trim().replace(/\s+/g, '.')}${el.dataset.scroll ? `[${el.dataset.scroll}]` : ''} +${el.scrollHeight - el.clientHeight}px`);
		}
	}
	const cut = [];
	for (const el of document.querySelectorAll('.g3-studio *')) {
		if (el.closest('select') || !el.clientWidth) { continue; }
		const style = getComputedStyle(el);
		if (style.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1) {
			cut.push(`"${(el.textContent || '').trim().slice(0, 50)}"`);
		}
	}
	return { scrolls: [...new Set(scrolls)].slice(0, 6), cut: [...new Set(cut)].slice(0, 10) };
}

if (process.argv[1]?.endsWith('shoot.mjs')) {
	const server = await start();
	const base = `http://127.0.0.1:${server.address().port}/`;
	const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
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
				errors.push(`console: ${msg.text().slice(0, 200)}`);
			}
		});
		await page.goto(base + (query ? `?${query}` : ''));
		await page.waitForSelector('.g3-studio');
		await page.waitForFunction(() => !document.querySelector('.g3-wait .spin') || document.querySelector('[data-tick]'), null, { timeout: 30000 }).catch(() => errors.push('timeout: the model did not load'));
		await page.waitForTimeout(500);
		await page.mouse.move(1, 1);
		if (action) {
			await action(page);
		}
		await page.waitForTimeout(250);
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
