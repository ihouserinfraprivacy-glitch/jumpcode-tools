/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Dev only: captures every ArchStudio mode and state at 1344×905 into ./shots/.
// Run from this folder: node shoot.mjs [name,name,...|real]   (real = every shot of the real analyzer output)
import { chromium } from 'file:///C:/Projects/jumpcode/node_modules/playwright/index.mjs';
import { mkdirSync } from 'node:fs';
import { start } from './serve.mjs';

const only = process.argv[2] ? new Set(process.argv[2].split(',')) : null;
const prefix = process.argv[3] || '';
const out = new URL('./shots/', import.meta.url);
mkdirSync(out, { recursive: true });

const P = 'v:plataforma/servicos/pedidos';
const H = 'f:plataforma/servicos/pedidos/internal/http/handlers.go';
const RP = 'v:plataforma/servicos/pedidos';
const RH = 'f:plataforma/servicos/pedidos/handlers.go';
const enc = encodeURIComponent;

/** [name, query, optional async actions(page)] */
const SHOTS = [
	['02-empty', 'state=empty'],
	['02b-empty-folder', 'state=empty', async page => { await page.click('[data-act="pick"]'); await page.waitForTimeout(150); }],
	['02c-empty-noproject', 'state=empty&project=0'],
	['03-scanning', 'state=scanning'],
	['03b-scanning-empty', 'state=scanning-empty'],
	['03c-failed', 'state=failed'],
	['03d-failed-model', 'state=failed-model'],
	['04-systems', 'view=1'],
	['04b-systems-select', `sel=${enc('s:plataforma')}`],
	['05-nested', `open=${enc(`s:plataforma,${P}`)}&sel=${enc(H)}`],
	['05b-nested-one', `open=${enc('s:plataforma')}`],
	['06-services', `scope=${enc('s:plataforma')}&sel=${enc(P)}`],
	['06b-services-plain', `scope=${enc('s:plataforma')}`],
	['07-files', `scope=${enc(P)}&sel=${enc(H)}`],
	['07b-files-plain', `scope=${enc(P)}`],
	['08-columns', `mode=columns&sel=${enc(H)}`],
	['09-circles', `mode=circles&sel=${enc(P)}`],
	['09b-circles-system', `mode=circles&scope=${enc('s:plataforma')}`],
	['10-blocks', `mode=blocks&sel=${enc(H)}`],
	['10b-blocks-system', `mode=blocks&scope=${enc('s:plataforma')}`],
	['11-path', 'mode=path&step=4'],
	['11b-path-empty', 'mode=path&paths=0'],
	['12-layers', `mode=layers&sel=${enc(P)}`],
	['13-embedded', `scope=${enc('s:firmware/rastreador')}&sel=${enc('v:firmware/rastreador/src/tarefas/gps')}`],
	['14-mobile', `scope=${enc('s:apps/entregador')}`],
	['14b-mobile-cliente', `scope=${enc('s:apps/cliente')}`],
	['15-deploy', 'mode=deploy'],
	['15b-deploy-empty', 'mode=deploy&nodeploy=1'],
	['16-matrix', `mode=matrix&scope=${enc('s:plataforma')}`, async page => { await clickCell(page, 'pedidos', 'pagamentos'); }],
	['16b-matrix-root', 'mode=matrix'],
	['16c-matrix-files', `mode=matrix&scope=${enc(P)}`],
	['17-proposal', `proposalOn=1&scope=${enc('s:plataforma')}`],
	['18-present', 'mode=present&path=compra-no-app&step=1'],
	['18b-present-criar', 'mode=present&path=criar-pedido&step=4'],
	['19-menu-mais', '', async page => { await page.click('[data-act="menu"][data-menu="modes"]'); await page.waitForTimeout(100); }],
	['19b-menu-export', '', async page => { await page.click('[data-act="menu"][data-menu="export"]'); await page.waitForTimeout(100); }],
	['20-search', '', async page => { await page.click('[data-act="search-open"]'); await page.keyboard.type('pedi'); await page.keyboard.press('Enter'); await page.waitForTimeout(150); }],
	['21-edge-card', `scope=${enc('s:plataforma')}`, async page => { await page.locator('[data-edge]').nth(6).dispatchEvent('click'); await page.waitForTimeout(100); }],
	['30-big-root', 'big=1'],
	['31-big-system', `big=1&scope=${enc('s:sys0')}`],
	['32-big-service', `big=1&scope=${enc('v:sys3/svc2')}`],
	['33-big-matrix', `big=1&mode=matrix&scope=${enc('s:sys0')}`],
	['34-big-circles', 'big=1&mode=circles'],
	['35-big-blocks', 'big=1&mode=blocks'],
	['36-big-layers', 'big=1&mode=layers'],
	['37-big-columns', 'big=1&mode=columns'],
	['40-light-systems', 'theme=light&view=1'],
	['41-light-files', `theme=light&scope=${enc(P)}&sel=${enc(H)}`],
	['42-light-circles', `theme=light&mode=circles&sel=${enc(P)}`],
	['43-light-blocks', `theme=light&mode=blocks&sel=${enc(H)}`],
	['44-light-matrix', `theme=light&mode=matrix&scope=${enc('s:plataforma')}`],
	['45-light-empty', 'theme=light&state=empty'],
	['46-light-path', 'theme=light&mode=path&step=4'],
	['47-light-layers', `theme=light&mode=layers&sel=${enc(P)}`],
	['48-light-deploy', 'theme=light&mode=deploy'],
	['49-light-proposal', `theme=light&proposalOn=1&scope=${enc('s:plataforma')}`],
	['50-narrow-1000', `scope=${enc('s:plataforma')}`, null, { width: 1000, height: 760 }],
	['51-narrow-760', `scope=${enc('s:plataforma')}&sel=${enc(P)}`, null, { width: 760, height: 700 }],
	['52-narrow-760-columns', `mode=columns&sel=${enc(H)}`, null, { width: 760, height: 700 }],
	// Real analyzer output (sample-real/, made by make-real.py from tests/fixtures/rota-certa).
	['r03-scanning', 'data=real&state=scanning'],
	['r03b-scanning-empty', 'data=real&state=scanning-empty'],
	['r03c-failed', 'data=real&state=failed-model'],
	['r04-root', 'data=real'],
	['r04b-view-select', 'data=real&view=select'],
	['r05-nested', `data=real&open=${enc(`s:plataforma,${RP}`)}&sel=${enc(RH)}`],
	['r06-plataforma', `data=real&scope=${enc('s:plataforma')}`],
	['r06b-plataforma-select', `data=real&scope=${enc('s:plataforma')}&sel=${enc(RP)}`],
	['r07-files', `data=real&scope=${enc(RP)}&sel=${enc(RH)}`],
	['r07b-files-plain', `data=real&scope=${enc(RP)}`],
	['r08-columns', `data=real&mode=columns&sel=${enc(RH)}`],
	['r09-circles', `data=real&mode=circles&sel=${enc(RP)}`],
	['r10-blocks', `data=real&mode=blocks&sel=${enc(RH)}`],
	['r11-path', 'data=real&view=path'],
	['r11b-path-step5', 'data=real&view=path', async page => { for (let i = 0; i < 4; i++) { await page.keyboard.press('ArrowRight'); } await page.waitForTimeout(100); }],
	['r12-layers', `data=real&mode=layers&sel=${enc(RP)}`],
	['r13-embedded', `data=real&scope=${enc('s:firmware/rastreador')}`],
	['r13b-embedded-hw', `data=real&scope=${enc('s:firmware/rastreador')}&sel=${enc('v:firmware/rastreador#hw-gps')}`],
	['r13c-embedded-module', `data=real&scope=${enc('s:firmware/rastreador')}&sel=${enc('v:firmware/rastreador/main/tasks/gps_task')}`],
	['r13d-firmware-files', `data=real&scope=${enc('v:firmware/rastreador/main/tasks/gps_task')}&sel=${enc('f:firmware/rastreador/main/tasks/gps_task.c')}`],
	['r14-mobile', `data=real&scope=${enc('s:app-entregador')}`],
	['r14b-cliente', `data=real&scope=${enc('s:app-cliente')}`],
	['r14c-painel', `data=real&scope=${enc('s:painel-web')}`],
	['r14d-analytics', `data=real&scope=${enc('s:analytics')}`],
	['r15-deploy', 'data=real&view=deploy'],
	['r15b-deploy-unit', 'data=real&mode=deploy', async page => { await page.locator('[data-unit="u:pedidos"]').dispatchEvent('click'); await page.waitForTimeout(100); }],
	['r16-matrix', `data=real&mode=matrix&scope=${enc('s:plataforma')}`],
	['r16b-matrix-root', 'data=real&mode=matrix'],
	['r17-proposal', `data=real&proposalOn=1&scope=${enc('s:plataforma')}`],
	['r18-present', 'data=real&view=present'],
	['r18b-present-step5', 'data=real&view=present', async page => { for (let i = 0; i < 4; i++) { await page.keyboard.press('ArrowRight'); } await page.waitForTimeout(100); }],
	['r18c-present-posicao', 'data=real&mode=present&path=posicao-do-veiculo&step=1'],
	['r40-light-root', 'data=real&theme=light'],
	['r41-light-embedded', `data=real&theme=light&scope=${enc('s:firmware/rastreador')}`],
	['r42-light-deploy', 'data=real&theme=light&mode=deploy'],
];

async function clickCell(page, rowName, colName) {
	const pos = await page.evaluate(([r, c]) => {
		const heads = [...document.querySelectorAll('text.mx-head')];
		const rows = heads.filter(t => t.getAttribute('text-anchor') === 'end');
		const i = rows.findIndex(t => t.textContent.startsWith(r));
		const cols = heads.filter(t => t.getAttribute('text-anchor') !== 'end');
		const j = cols.findIndex(t => t.textContent.startsWith(c));
		return [i, j];
	}, [rowName, colName]);
	const cell = page.locator(`[data-act="cell"][data-i="${pos[0]}"][data-j="${pos[1]}"]`);
	if (await cell.count()) {
		await cell.dispatchEvent('click');
		await page.waitForTimeout(100);
	}
}

const server = await start();
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1344, height: 905 }, deviceScaleFactor: 1 });
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
		if (m.type() === 'error' || /Content Security Policy|Refused/.test(m.text())) {
			errors.push(`console: ${m.text()}`);
		}
	});
	const t0 = Date.now();
	await page.goto(base + (query ? `?${query}` : ''));
	await page.waitForSelector('#as-body');
	await page.waitForTimeout(250);
	if (action) {
		await action(page);
	}
	await page.mouse.move(1, 1);
	await page.waitForTimeout(80);
	const ms = Date.now() - t0;
	await page.screenshot({ path: new URL(`${name}.png`, out).pathname.slice(1) });
	const posted = await page.evaluate(() => window.__posted.map(m => m.type).join(','));
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
