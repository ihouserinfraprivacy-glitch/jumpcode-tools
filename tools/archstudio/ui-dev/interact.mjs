/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Dev only: drives the interface like a user and checks the messages it sends to the host,
// then times the heavy scopes of the large synthetic model. Run: node interact.mjs
import { chromium } from 'file:///C:/Projects/jumpcode/node_modules/playwright/index.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { start } from './serve.mjs';

const out = new URL('./shots/', import.meta.url);
mkdirSync(out, { recursive: true });
const file = name => new URL(name, out).pathname.slice(1);
const server = await start();
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1344, height: 905 } });
let failures = 0;
const check = (ok, what, extra = '') => {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${extra ? `  (${extra})` : ''}`);
	if (!ok) {
		failures++;
	}
};
async function open(query) {
	const page = await ctx.newPage();
	page.on('pageerror', e => check(false, `page error: ${e.message}`));
	await page.goto(base + (query ? `?${query}` : ''));
	await page.waitForSelector('#as-body');
	await page.waitForTimeout(200);
	return page;
}
const posted = page => page.evaluate(() => window.__posted);
const last = async (page, type) => (await posted(page)).filter(m => m.type === type).pop();
const crumbs = page => page.evaluate(() => [...document.querySelectorAll('.as-crumb')].map(b => b.textContent.trim()).join(' > '));

// ---------------------------------------------------------------- empty state
{
	const page = await open('state=empty');
	await page.click('.as-start[data-text^="Desenhe a arquitetura deste"]');
	let m = await last(page, 'ask');
	check(m && m.text === 'Desenhe a arquitetura deste projeto.' && m.send === true, 'empty: "Este projeto" asks and sends');
	await page.click('.as-start[data-text^="Vou descrever"]');
	m = await last(page, 'ask');
	check(m && m.text === 'Vou descrever o sistema: ' && m.send === false, 'empty: "Descrever em texto" fills without sending');
	await page.click('[data-act="pick"]');
	await page.waitForTimeout(100);
	check(!!(await last(page, 'pickSource')), 'empty: "Escolher outra pasta" posts pickSource');
	await page.click('[data-text^="Desenhe a arquitetura da pasta"]');
	m = await last(page, 'ask');
	check(m && m.text === 'Desenhe a arquitetura da pasta outro-repo.' && m.send === true, 'empty: picked folder asks with its name', m?.text);
	await page.close();
}

// ---------------------------------------------------------------- map interactions
{
	const page = await open('');
	await page.locator('.nd[data-id="s:plataforma"] .nd-bg').click();
	await page.waitForTimeout(80);
	check(await page.isVisible('.as-insp'), 'map: click selects and opens the inspector');
	check((await page.locator('.ed.hot').count()) >= 5, 'map: selection highlights its links');
	await page.keyboard.press('Escape');
	await page.waitForTimeout(80);
	check(!(await page.isVisible('.as-insp')), 'map: Escape clears the selection');
	await page.locator('.nd[data-id="s:plataforma"] .nd-open').click();
	await page.waitForTimeout(120);
	check((await page.locator('.bx.sub').count()) === 1 && (await page.locator('.nd[data-id="v:plataforma/servicos/pedidos"]').count()) === 1, 'map: "Abrir 7 serviços" opens the system in place');
	await page.screenshot({ path: file('i1-open-in-place.png') });
	await page.locator('.bx-close').click();
	await page.waitForTimeout(100);
	check((await page.locator('.bx.sub').count()) === 0, 'map: close button collapses the box');
	await page.locator('.nd[data-id="s:plataforma"] .nd-name').dblclick();
	await page.waitForTimeout(120);
	check((await crumbs(page)).includes('Plataforma'), 'map: double click enters the system', await crumbs(page));
	await page.locator('.nd[data-id="v:plataforma/servicos/pedidos"] .nd-name').dblclick();
	await page.waitForTimeout(120);
	check((await crumbs(page)).endsWith('pedidos'), 'map: double click enters the service', await crumbs(page));
	await page.locator('.nd[data-id="f:plataforma/servicos/pedidos/internal/http/handlers.go"] .nd-name').click();
	await page.waitForTimeout(200);
	check(await page.isVisible('.as-code'), 'map: selecting a file opens the code panel');
	const lines = await page.locator('.as-lines .ln').count();
	check(lines > 40, 'map: code panel shows numbered lines', `${lines} linhas`);
	check((await page.locator('.as-lines .lnk').count()) >= 3, 'map: evidence lines carry link chips');
	await page.click('.as-codehead [data-act="open-editor"]');
	let m = await last(page, 'openFile');
	check(m && m.path === 'plataforma/servicos/pedidos/internal/http/handlers.go' && m.line === 45, 'map: "Abrir no editor" posts openFile with the evidence line', JSON.stringify(m));
	await page.screenshot({ path: file('i2-code-panel.png') });
	await page.keyboard.press('Escape');
	await page.waitForTimeout(80);
	await page.keyboard.press('Escape');
	await page.waitForTimeout(80);
	check((await crumbs(page)).endsWith('Plataforma') && await page.isVisible('.as-insp h3:has-text("pedidos")'), 'map: Escape goes up one scope and keeps the part selected', await crumbs(page));
	// keyboard on nodes
	await page.locator('.nd[data-id="v:plataforma/servicos/auth"]').focus();
	await page.keyboard.press('Enter');
	await page.waitForTimeout(100);
	check(await page.isVisible('.as-insp h3:has-text("auth")'), 'keyboard: Enter on a focused node selects it');
	await page.keyboard.press('Enter');
	await page.waitForTimeout(120);
	check((await crumbs(page)).endsWith('auth'), 'keyboard: Enter again enters it', await crumbs(page));
	// zoom and pan
	await page.click('.as-crumb[data-id=""]');
	await page.waitForTimeout(120);
	const before = await page.getAttribute('svg.as-svg > g.vp', 'transform');
	await page.mouse.move(600, 400);
	await page.mouse.wheel(0, -300);
	await page.waitForTimeout(60);
	const afterWheel = await page.getAttribute('svg.as-svg > g.vp', 'transform');
	check(before !== afterWheel, 'zoom: wheel changes the zoom', afterWheel);
	await page.mouse.move(300, 700);
	await page.mouse.down();
	await page.mouse.move(380, 640, { steps: 4 });
	await page.mouse.up();
	const afterPan = await page.getAttribute('svg.as-svg > g.vp', 'transform');
	check(afterPan !== afterWheel, 'pan: dragging the canvas moves the drawing');
	check(!(await page.isVisible('.as-insp')), 'pan: a drag does not select');
	await page.click('#as-zoom-pct');
	await page.waitForTimeout(60);
	check((await page.textContent('#as-zoom-pct')) === '100%', 'zoom: clicking the percentage fits the drawing');
	// export
	await page.click('[data-menu="export"]');
	await page.click('[data-act="export-svg"]');
	m = await last(page, 'save');
	check(m && m.mime === 'image/svg+xml' && m.content.startsWith('<?xml') && m.content.includes('<svg') && !m.content.includes('var(--'), 'export: SVG of the drawing', m?.name);
	if (m) {
		writeFileSync(file('export-map.svg'), m.content);
	}
	await page.click('[data-menu="export"]');
	await page.click('[data-act="export-json"]');
	m = await last(page, 'save');
	check(m && m.mime === 'application/json' && JSON.parse(m.content).nodes.length > 10, 'export: model JSON', m?.name);
	// search
	await page.keyboard.press('Control+f');
	await page.keyboard.type('notif');
	await page.keyboard.press('Enter');
	await page.waitForTimeout(150);
	check((await crumbs(page)).includes('Plataforma') && await page.isVisible('.as-insp h3:has-text("notificações")'), 'search: Enter jumps to the first match and selects it', await crumbs(page));
	await page.keyboard.press('Escape');
	await page.waitForTimeout(60);
	check(!(await page.isVisible('#as-search-input')), 'search: Escape closes it');
	// proposal
	await page.click('[data-act="proposal"][data-on="1"]');
	await page.waitForTimeout(120);
	check((await page.locator('.nd.add').count()) === 1 && (await page.locator('.ed.del').count()) === 1, 'proposal: new node and removed link drawn');
	await page.click('[data-act="discard"]');
	m = await last(page, 'ask');
	check(m && m.text === 'Descarte a proposta.' && m.send === true, 'proposal: Descartar asks and sends');
	await page.click('[data-act="tasks"]');
	m = await last(page, 'ask');
	check(m && m.text === 'Crie as tarefas para implementar a proposta "Cupons de desconto".' && m.send === false, 'proposal: Gerar tarefas fills the composer');
	await page.close();
}

// ---------------------------------------------------------------- modes and messages
{
	const page = await open('');
	await page.click('[data-menu="modes"]');
	await page.click('.as-mi[data-mode="present"]');
	await page.waitForTimeout(120);
	let m = await last(page, 'focus');
	check(m && m.on === true, 'present: entering posts focus on');
	await page.keyboard.press('ArrowRight');
	await page.waitForTimeout(80);
	check((await page.textContent('.as-caption small')).includes('passo 2'), 'present: arrow key advances the step');
	await page.keyboard.press('Escape');
	await page.waitForTimeout(80);
	m = await last(page, 'focus');
	check(m && m.on === false, 'present: Escape leaves and posts focus off');
	await page.click('[data-menu="modes"]');
	await page.click('.as-mi[data-mode="path"]');
	await page.waitForTimeout(80);
	const stepBefore = await page.textContent('.as-status');
	await page.click('[data-act="play"]');
	await page.waitForTimeout(1900);
	const stepAfter = await page.textContent('.as-status');
	check(stepBefore !== stepAfter, 'path: play advances by itself', `${stepBefore} -> ${stepAfter}`);
	await page.click('[data-act="play"]');
	await page.click('.as-crumb[data-menu="paths"]');
	await page.click('.as-mi[data-id="compra-no-app"]');
	await page.waitForTimeout(80);
	check((await crumbs(page)).includes('Compra no app'), 'path: picker switches the path');
	await page.click('[data-mode="columns"]');
	await page.click('.as-it[data-id="s:plataforma"]');
	await page.click('.as-it[data-id="v:plataforma/servicos/rotas"]');
	await page.waitForTimeout(80);
	check((await page.locator('.as-col h5').nth(2).textContent()).includes('rotas'), 'columns: selection drives the next column');
	await page.keyboard.press('ArrowDown');
	await page.waitForTimeout(80);
	check((await crumbs(page)).includes('notificações'), 'columns: arrow keys move in the list', await crumbs(page));
	await page.click('[data-mode="blocks"]');
	const head = await page.locator('.bk[data-id="s:plataforma"] .bk-r').first().boundingBox();
	await page.mouse.dblclick(head.x + 60, head.y + 12);
	await page.waitForTimeout(100);
	check((await crumbs(page)).endsWith('Plataforma'), 'blocks: double click enters');
	await page.click('[data-menu="modes"]');
	await page.click('.as-mi[data-mode="matrix"]');
	await page.waitForTimeout(100);
	check((await page.locator('.mx-cell.cyc').count()) === 2, 'matrix: cycle cells outlined');
	await page.click('[data-act="cycle-map"]');
	await page.waitForTimeout(100);
	check((await page.locator('.ed.hot').count()) >= 2, 'matrix: "Ver no mapa" highlights the cycle on the map');
	// live updates from the host
	const v = { select: 'v:plataforma/servicos/rotas', highlight: [], scope: 's:plataforma', mode: 'map', note: 'Aqui calcula o frete', revision: 9 };
	await page.evaluate(view => window.__send({ type: 'files', files: Object.assign({}, window.__files, { 'view.json': JSON.stringify(view) }) }), v);
	await page.waitForTimeout(120);
	check(await page.isVisible('.as-insp h3:has-text("rotas")') && (await page.locator('.hint').count()) === 1, 'view.json: new revision selects and shows the note');
	await page.keyboard.press('Escape');
	await page.evaluate(view => window.__send({ type: 'files', files: Object.assign({}, window.__files, { 'view.json': JSON.stringify(view), 'paths.json': '{"paths":[]}' }) }), v);
	await page.waitForTimeout(120);
	check(!(await page.isVisible('.as-insp')), 'view.json: the same revision is not applied twice');
	await page.evaluate(() => {
		const m = JSON.parse(window.__files['model.json']);
		m.nodes.push({ id: 's:novo', level: 'system', parent: null, name: 'Sistema Novo', kind: 'web', tech: 'Vue' });
		m.links.push({ id: 'lnovo', from: 's:novo', to: 's:plataforma', level: 'system', protocol: 'HTTP', label: 'REST', async: false, count: 1 });
		window.__send({ type: 'files', files: Object.assign({}, window.__files, { 'model.json': JSON.stringify(m) }) });
	});
	await page.waitForTimeout(100);
	await page.click('.as-crumb[data-id=""]');
	await page.waitForTimeout(100);
	check((await page.locator('.nd[data-id="s:novo"]').count()) === 1, 'files: a rewritten model.json updates the map');
	await page.evaluate(() => window.__send({ type: 'running', running: true }));
	await page.waitForTimeout(60);
	check((await page.textContent('#as-bar')).includes('Trabalhando'), 'running: status shows the agent is working');
	await page.evaluate(() => window.__send({ type: 'files', files: {} }));
	await page.waitForTimeout(80);
	check(await page.isVisible('.as-start'), 'files: model.json removed shows the empty state again');
	await page.close();
}

// ---------------------------------------------------------------- real analyzer output
{
	let page = await open('data=real&view=path');
	check((await crumbs(page)).includes('Criar pedido') && (await page.textContent('.as-status')).includes('Passo 1'), 'real: view.json "path" opens the path from step 1', await crumbs(page));
	await page.close();
	page = await open('data=real&view=present');
	let m = await last(page, 'focus');
	check(m && m.on === true && (await page.isVisible('.as-caption')), 'real: view.json "path" with present narrates and hides the chat');
	await page.close();
	page = await open('data=real&view=deploy');
	check((await page.locator('[data-unit="u:rota-certa-pedidos"].sel').count()) === 1 && (await page.locator('.hint').count()) === 1, 'real: focus on a deploy unit highlights it with the note');
	await page.locator('[data-unit="u:pedidos"]').dispatchEvent('click');
	await page.waitForTimeout(80);
	check((await page.textContent('.as-card')).includes('rotacerta/pedidos:1.4.0'), 'real: clicking a unit shows its card');
	await page.click('[data-act="focus-map"]');
	await page.waitForTimeout(100);
	check((await crumbs(page)).includes('plataforma') && await page.isVisible('.as-insp h3:has-text("pedidos")'), 'real: "Ver no mapa" from a unit selects its service', await crumbs(page));
	await page.close();
	page = await open(`data=real&scope=${encodeURIComponent('s:firmware/rastreador')}&sel=${encodeURIComponent('v:firmware/rastreador#hw-gps')}`);
	check(await page.isVisible('.as-insp h3:has-text("GPS")') && !(await page.isVisible('.as-insp [data-act="open-editor"]')), 'real: hardware part has no editor button');
	await page.close();
	page = await open(`data=real&scope=${encodeURIComponent('s:firmware/rastreador')}&sel=${encodeURIComponent('v:firmware/rastreador/main/tasks/gps_task')}`);
	await page.click('.as-insp .li[data-act="open-editor"]');
	m = await last(page, 'openFile');
	check(m && m.path === 'firmware/rastreador/main/tasks/gps_task.c', 'real: firmware module opens its main file', JSON.stringify(m));
	await page.close();
	page = await open(`data=real&scope=${encodeURIComponent('v:plataforma/servicos/pedidos')}&sel=${encodeURIComponent('f:plataforma/servicos/pedidos/handlers.go')}`);
	await page.waitForTimeout(150);
	check((await page.locator('.as-lines .ln').count()) > 30 && (await page.textContent('.as-lines')).includes('package'), 'real: code panel shows the real source file');
	await page.close();
}

// ---------------------------------------------------------------- performance on the large model
{
	const page = await open('big=1');
	const timeView = view => page.evaluate(v => new Promise(res => {
		const body = document.getElementById('as-body');
		const t0 = performance.now();
		const mo = new MutationObserver(() => {
			mo.disconnect();
			res(Math.round(performance.now() - t0));
		});
		mo.observe(body, { childList: true });
		window.__send({ type: 'files', files: Object.assign({}, window.__files, { 'view.json': JSON.stringify(v) }) });
	}), view);
	let rev = 100;
	const cases = [
		['map raiz', { mode: 'map', scope: null }],
		['map sistema com 110 serviços', { mode: 'map', scope: 's:sys19' }],
		['map serviço com 320 arquivos', { mode: 'map', scope: 'v:sys18/svc0' }],
		['colunas', { mode: 'columns', scope: 's:sys19', select: 'v:sys19/svc3' }],
		['círculos raiz', { mode: 'circles', scope: null }],
		['círculos sistema 110', { mode: 'circles', scope: 's:sys19' }],
		['blocos raiz', { mode: 'blocks', scope: null }],
		['camadas', { mode: 'layers', scope: null, select: 'v:sys18/svc0' }],
		['matriz sistema 110', { mode: 'matrix', scope: 's:sys19' }],
		['matriz serviço 320', { mode: 'matrix', scope: 'v:sys18/svc0' }],
	];
	for (const [name, v] of cases) {
		const ms = await timeView({ highlight: [], revision: ++rev, ...v });
		console.log(`perf ${name}: ${ms} ms`);
		await page.screenshot({ path: file(`p-${name.replace(/[^a-z0-9]+/gi, '-')}.png`) });
		check(ms < 1500, `perf: ${name} under 1,5 s`, `${ms} ms`);
	}
	await page.close();
}

// ---------------------------------------------------------------- exported SVG renders on its own
{
	const page = await ctx.newPage();
	await page.goto(new URL('export-map.svg', out).href);
	await page.waitForTimeout(150);
	await page.screenshot({ path: file('i3-export-render.png') });
	await page.close();
}

await browser.close();
server.close();
console.log(failures ? `\n${failures} falha(s)` : '\ntudo certo');
process.exitCode = failures ? 1 : 0;
