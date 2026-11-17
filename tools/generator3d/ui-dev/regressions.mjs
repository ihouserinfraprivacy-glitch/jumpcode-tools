/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Dev only: behaviour checks of the 3D Generator Studio in chromium (SwiftShader WebGL): the chat request every button
// sends, that nothing bypasses the agent, the agent's running state, following state.focus, keeping one canvas while
// models change, and the textures loading under the Studio's policy. Run from this folder: node regressions.mjs
import { chromium } from 'file:///C:/Projects/jumpcode/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';
import { start } from './serve.mjs';

const server = await start();
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1075, height: 724 }, deviceScaleFactor: 1.25 });
let failures = 0;

function check(name, ok, detail = '') {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
	if (!ok) { failures++; }
}

async function open(query) {
	const page = await ctx.newPage();
	page.errors = [];
	page.on('pageerror', e => page.errors.push(e.message));
	page.on('console', msg => { if (msg.type() === 'error' || /Refused|Content Security Policy/.test(msg.text())) { page.errors.push(msg.text()); } });
	await page.goto(`${base}?${query}`);
	await page.waitForSelector('.g3-studio');
	await page.waitForFunction(() => !document.querySelector('.g3-wait .spin') || document.querySelector('[data-tick]'), null, { timeout: 30000 });
	await page.waitForTimeout(300);
	return page;
}
const asks = page => page.evaluate(() => window.__posted.filter(m => m.type === 'ask').map(m => ({ text: m.text, send: m.send, id: m.requestId })));
async function clickAndAsk(page, selector) {
	const before = (await asks(page)).length;
	await page.locator(selector).first().dispatchEvent('click');
	await page.waitForTimeout(120);
	return (await asks(page)).slice(before);
}

// Every button that does something asks the agent, with send and a request id.
const ASKS = [
	['start: Abrir', 's=start', '[data-act="open-image"]', 'Abra a imagem arte/personagens/jay.png no 3D Generator.'],
	['start: Gerar', 's=start', '[data-act="generate-image"]', 'Gere o modelo 3D de arte/personagens/jay.png.'],
	['noengine: Verificar de novo', 's=noengine', '[data-act="check-engine"]', 'Verifique se o gerador do 3D Generator está instalado neste computador.'],
	['image: Gerar o modelo', 's=image-archer', '[data-act="generate-image"]', 'Gere o modelo 3D de arte/personagens/arqueira.png.'],
	['image: Gerar com modelo existente', 's=model-jay&view=image', '[data-act="generate-image"]', 'Gere de novo o modelo 3D de arte/personagens/jay.png. Pode substituir modelos/jay.glb.'],
	['model: Gerar de novo', 's=model-archer', '[data-act="regen"]', 'Gere de novo modelos/arqueira.glb.'],
	['failed: Tentar de novo', 's=failed', '[data-act="generate-image"]', 'Gere o modelo 3D de arte/personagens/jay.png.'],
	['models: Mostrar', 's=models', '.g3-card[data-path="modelos/jay.glb"]', null],
	['settings: Verificar o gerador', 's=noengine&view=settings', '[data-act="check-engine"]', 'Verifique se o gerador do 3D Generator está instalado neste computador.'],
];
for (const [name, query, selector, expected] of ASKS) {
	const page = await open(query);
	const sent = await clickAndAsk(page, selector);
	if (expected === null) {
		check(name + ' (choosing a card asks nothing)', sent.length === 0);
		const show = await clickAndAsk(page, '[data-act="show-model"]');
		check('models: Mostrar asks to show it', show.length === 1 && show[0].text === 'Mostre o modelo modelos/jay.glb.' && show[0].send && !!show[0].id, show[0]?.text);
	} else {
		check(name, sent.length === 1 && sent[0].text === expected && sent[0].send === true && /^g3-/.test(sent[0].id || ''), sent.map(s => s.text).join(' | '));
	}
	check(`${name}: no errors`, !page.errors.length, page.errors.join(' | '));
	await page.close();
}

// Animations: choose others and ask for the model again with them (track changes first, then one request).
{
	const page = await open('s=model-archer&view=animations');
	await page.locator('[data-act="anim-row"][data-name="run-anime"]').dispatchEvent('click');
	await page.locator('input[data-act="anim-toggle"][data-name="dance-simple"]').click();
	await page.waitForTimeout(150);
	check('animations: added one underlined, removed one struck', await page.evaluate(() => !!document.querySelector('ins.g3-ins') && !!document.querySelector('del.g3-del')));
	const sent = await clickAndAsk(page, '[data-act="anim-regen"]');
	check('animations: Gerar de novo com estas', sent.length === 1 && sent[0].text === 'Gere de novo modelos/arqueira.glb só com as animações walk, greeting, jump-2 e run-anime (tire dance-simple).', sent[0]?.text);
	const played = await page.evaluate(() => document.getElementById('g3-time')?.textContent);
	await page.locator('[data-act="clip"][data-name="greeting"]').dispatchEvent('click');
	await page.waitForTimeout(400);
	check('animations: clicking a clip plays it locally, no request', (await asks(page)).length === 1 && /greeting/.test(await page.locator('.g3-head b').textContent()), played);
	await page.locator('[data-act="play"]').dispatchEvent('click');
	await page.waitForTimeout(100);
	const t1 = await page.evaluate(() => document.getElementById('g3-time').textContent);
	await page.waitForTimeout(400);
	const t2 = await page.evaluate(() => document.getElementById('g3-time').textContent);
	check('animations: pause stops the clock', t1 === t2, `${t1} / ${t2}`);
	await page.locator('#g3-scrub').evaluate(el => { el.value = '1.5'; el.dispatchEvent(new Event('input', { bubbles: true })); });
	await page.waitForTimeout(100);
	check('animations: scrubbing moves the time', /^1,50 /.test(await page.evaluate(() => document.getElementById('g3-time').textContent)));
	check('animations: no errors', !page.errors.length, page.errors.join(' | '));
	await page.close();
}

// Settings: one change asks with the change; several are joined; undo clears.
{
	const page = await open('s=settings');
	await page.locator('select[data-set="texture"]').selectOption('1024');
	await page.waitForTimeout(100);
	let sent = await clickAndAsk(page, '[data-act="set-ask"]');
	check('settings: one change', sent[0]?.text === 'Mude o padrão de textura para 1024.', sent[0]?.text);
	await page.locator('select[data-set="faces"]').selectOption('40000');
	await page.locator('select[data-set="device"]').selectOption('cpu');
	await page.locator('input[data-act="set-anim"][data-name="run-anime"]').click();
	await page.waitForTimeout(100);
	sent = await clickAndAsk(page, '[data-act="set-ask"]');
	check('settings: several changes', sent[0]?.text === 'Mude as configurações do 3D Generator: o padrão de triângulos para 40.000; o dispositivo para processador (cpu); as animações padrão para walk, greeting, dance-simple, jump-2 e run-anime.', sent[0]?.text);
	await page.locator('select[data-set="height"]').selectOption('1.8');
	await page.waitForTimeout(100);
	await page.locator('[data-act="set-undo"]').dispatchEvent('click');
	await page.waitForTimeout(100);
	check('settings: undo leaves nothing to ask', !(await page.$('[data-act="set-ask"]')));
	const fill = await clickAndAsk(page, '[data-act="set-folder"]');
	check('settings: folder only fills the chat box', fill.length === 1 && fill[0].send === false && !fill[0].id, fill[0]?.text);
	await page.close();
}

// Stop goes to the host, not to the chat.
{
	const page = await open('s=running');
	await page.locator('.g3-bar [data-act="stop"]').dispatchEvent('click');
	await page.waitForTimeout(100);
	check('running: Parar sends the host stop', await page.evaluate(() => window.__posted.some(m => m.type === 'stop') && !window.__posted.some(m => m.type === 'ask')));
	const t1 = await page.locator('.g3-bar [data-tick="elapsed"]').textContent();
	await page.waitForTimeout(1300);
	const t2 = await page.locator('.g3-bar [data-tick="elapsed"]').textContent();
	check('running: the elapsed time counts', t1 !== t2, `${t1} -> ${t2}`);
	await page.close();
}

// The agent's state: working after a request, idle when the request settles; a refusal says the agent is busy.
{
	const page = await open('s=image-archer');
	const [sent] = await clickAndAsk(page, '[data-act="generate-image"]');
	await page.waitForTimeout(100);
	check('agent: working after a request', /Agente trabalhando/.test(await page.locator('.g3-bar').textContent()));
	await page.evaluate(id => window.G3D_HOST({ type: 'request', requestId: id, state: 'settled' }), sent.id);
	await page.evaluate(() => window.G3D_HOST({ type: 'running', running: false, executions: [], requests: [] }));
	await page.waitForTimeout(100);
	check('agent: idle when it settles', !/Agente trabalhando/.test(await page.locator('.g3-bar').textContent()));
	const [again] = await clickAndAsk(page, '[data-act="generate-image"]');
	await page.evaluate(id => window.G3D_HOST({ type: 'request', requestId: id, state: 'rejected' }), again.id);
	await page.waitForTimeout(100);
	check('agent: a refused request says the agent is busy', /ocupado/.test(await page.locator('.g3-studio').textContent()));
	await page.close();
}

// Following state.focus: the view, the camera, the animation and the bone the agent pointed at, once per change.
{
	const page = await open('s=model-archer');
	const state = JSON.parse(readFileSync(new URL('./fixtures/model-archer/state.json', import.meta.url), 'utf8'));
	await page.evaluate(s => window.G3D_SEND({ 'state.json': { ...s, view: 'animations', focus: { ...s.focus, animation: 'greeting' } } }), state);
	await page.waitForTimeout(400);
	check('focus: view and animation', /greeting/.test(await page.locator('.g3-head b').textContent()) && await page.locator('.g3-vb.on').textContent() === 'Animações');
	await page.locator('[data-act="view"][data-view="models"]').first().dispatchEvent('click');
	await page.waitForTimeout(150);
	await page.evaluate(s => window.G3D_SEND({ 'state.json': { ...s, view: 'animations', focus: { ...s.focus, animation: 'greeting' }, updated: s.updated + 5 } }), state);
	await page.waitForTimeout(300);
	check('focus: the same focus again does not pull the user back', await page.locator('.g3-vb.on').textContent() === 'Modelos');
	await page.evaluate(s => window.G3D_SEND({ 'state.json': { ...s, view: 'skeleton', focus: { ...s.focus, bone: 'thigh_l' } } }), state);
	await page.waitForTimeout(400);
	check('focus: a bone opens what it moves', /thigh_l/.test(await page.locator('.g3-head').textContent()) && /Pesos/.test(await page.locator('.g3-head b').textContent()));
	check('focus: no errors', !page.errors.length, page.errors.join(' | '));
	await page.close();
}

// Models change: one canvas, the old one disposed (no error), a static model after a skinned one, then none.
{
	const page = await open('s=model-archer');
	const glb = name => readFileSync(new URL(`./fixtures/glb/${name}.glb`, import.meta.url)).toString('base64');
	for (const name of ['policial', 'jay', 'cavalo']) {
		await page.evaluate(([n, b]) => window.G3D_SEND({ 'model.json': { path: `modelos/${n}.glb`, bytes: b.length, glb: b } }), [name, glb(name)]);
		await page.waitForFunction(() => !document.querySelector('.g3-wait'), null, { timeout: 30000 });
		await page.waitForTimeout(200);
	}
	check('models: one canvas after three models', await page.evaluate(() => document.querySelectorAll('canvas').length) === 1);
	check('models: the last one is shown', /cavalo/.test(await page.locator('.g3-bar').textContent()));
	await page.evaluate(() => window.G3D_SEND({ 'model.json': {} }));
	await page.waitForTimeout(300);
	check('models: none after an empty model.json', /Nenhum modelo aberto/.test(await page.locator('.g3-studio').textContent()));
	await page.evaluate(() => window.G3D_SEND({ 'model.json': { path: 'modelos/grande.glb', bytes: 41000000, glb: null, tooLarge: true } }));
	await page.waitForTimeout(300);
	check('models: a model too large to send', /grande demais/.test(await page.locator('.g3-studio').textContent()));
	check('models: no errors', !page.errors.length, page.errors.join(' | '));
	await page.close();
}

// The texture loads under the policy: the canvas shows the archer's colours, not a grey or white model.
{
	const page = await open('s=model-archer');
	// A WebGL canvas cannot be read back after it is shown, so the check reads a screenshot of the page instead.
	const cdp = await page.context().newCDPSession(page);
	const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
	await cdp.detach();
	const coloured = await page.evaluate(async png => {
		const rect = document.querySelector('canvas').getBoundingClientRect();
		const image = new Image();
		image.src = `data:image/png;base64,${png}`;
		await image.decode();
		const k = image.width / window.innerWidth;
		const copy = document.createElement('canvas');
		copy.width = Math.round(rect.width * k);
		copy.height = Math.round(rect.height * k);
		const g = copy.getContext('2d');
		g.drawImage(image, rect.left * k, rect.top * k, copy.width, copy.height, 0, 0, copy.width, copy.height);
		const d = g.getImageData(0, 0, copy.width, copy.height).data;
		let warm = 0;
		for (let i = 0; i < d.length; i += 16) { if (d[i] > d[i + 2] + 40 && d[i] > 90) { warm++; } }
		return warm;
	}, data);
	check('texture: the model has its image colours', coloured > 500, `${coloured} warm pixels`);
	check('texture: no CSP refusal', !page.errors.length, page.errors.join(' | '));
	await page.close();
}

await browser.close();
server.close();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exitCode = failures ? 1 : 0;
