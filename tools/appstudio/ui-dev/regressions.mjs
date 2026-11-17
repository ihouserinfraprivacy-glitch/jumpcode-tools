/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Dev only: behaviour checks of the AppStudio Studio in chromium: the preview loads and navigates (data-go, back, tab,
// modal), screen states switch, data-each fills, a new revision keeps the screen, the building outline, foldable and
// rotation sizes, the map's edges, the chat request every button sends (and that nothing bypasses the agent), the
// agent's running state, following state.focus, and no console errors or CSP refusals anywhere.
// Run from this folder: node regressions.mjs
import { chromium } from 'file:///C:/Projects/jumpcode/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';
import { start } from './serve.mjs';
import { openPage } from './shoot.mjs';

const server = await start();
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1075, height: 724 }, deviceScaleFactor: 1.25 });
let failures = 0;
const fixture = (scenario, name) => JSON.parse(readFileSync(new URL(`./fixtures/${scenario}/${name}`, import.meta.url), 'utf8'));

function check(name, ok, detail = '') {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
	if (!ok) { failures++; }
}

async function open(query) {
	const errors = [];
	const page = await openPage(ctx, base, query, errors);
	page.errors = errors;
	return page;
}
const wait = (page, ms = 250) => page.waitForTimeout(ms);
const asks = page => page.evaluate(() => window.__posted.filter(m => m.type === 'ask').map(m => ({ text: m.text, send: m.send, id: m.requestId })));
async function clickAndAsk(page, selector) {
	const before = (await asks(page)).length;
	await page.locator(selector).first().dispatchEvent('click');
	await wait(page, 150);
	return (await asks(page)).slice(before);
}
/** The app inside the visible live frame: which screen shows, the modal, the state, its size. */
const live = page => page.evaluate(() => {
	const frame = document.querySelector('.as-live iframe.as-if.on');
	const doc = frame?.contentDocument;
	if (!doc) { return null; }
	const shown = [...doc.querySelectorAll('.as-tela')].filter(s => !s.hidden).map(s => s.getAttribute('data-screen'));
	return {
		shown, modal: doc.querySelector('.as-modal-aberta')?.getAttribute('data-screen') || null, state: doc.body.getAttribute('data-estado'),
		w: frame.contentWindow.innerWidth, h: frame.contentWindow.innerHeight, tabs: !doc.querySelector('.as-abas')?.hidden,
		topo: doc.documentElement.style.getPropertyValue('--as-topo'), baixo: doc.documentElement.style.getPropertyValue('--as-baixo'),
	};
});
/** Clicks an element of the app inside the live frame, as a person would. */
const tap = (page, selector) => page.evaluate(s => {
	const doc = document.querySelector('.as-live iframe.as-if.on')?.contentDocument;
	const el = doc?.querySelector(s);
	if (!el) { return false; }
	el.click();
	return true;
}, selector);
const liveCount = page => page.evaluate(() => document.querySelectorAll('.as-live').length);

// ------------------------------------------------------------------ the preview loads and navigates
{
	const page = await open('s=ready');
	let l = await live(page);
	check('preview: the app shows Início with the tab bar', l && l.shown.join() === 'inicio' && l.tabs, JSON.stringify(l));
	check('preview: the iPhone screen is 390 × 844 with its safe areas', l && l.w === 390 && l.h === 844 && l.topo === '50px' && l.baixo === '34px', JSON.stringify(l));
	await tap(page, '[data-part="botao-agendar"] [data-go]');
	await wait(page);
	l = await live(page);
	check('navigate: data-go opens Serviços', l.shown.join() === 'servicos', l.shown.join());
	await tap(page, '.linha-servico');
	await wait(page);
	check('navigate: a data-each row with data-go opens Barbeiro', (await live(page)).shown.join() === 'barbeiro');
	check('navigate: the route pill follows', /\/agendar\/barbeiro/.test(await page.locator('.as-route').first().textContent()));
	await tap(page, '[data-back]');
	await wait(page);
	check('navigate: data-back goes back to Serviços', (await live(page)).shown.join() === 'servicos');
	await tap(page, '.as-aba[data-tab="perfil"]');
	await wait(page);
	l = await live(page);
	check('navigate: the tab bar switches to Perfil', l.shown.join() === 'perfil' && l.tabs);
	await page.locator('.as-tcard[data-id="horario"]').dispatchEvent('click');
	await wait(page);
	await tap(page, '[data-part="rodape"] [data-go="pagamento"]');
	await wait(page);
	l = await live(page);
	check('navigate: the modal opens over Horário', l.modal === 'pagamento' && l.shown.includes('horario') && l.shown.includes('pagamento'), JSON.stringify(l));
	check('navigate: the strip marks the modal screen', await page.evaluate(() => document.querySelector('.as-tcard.sel')?.dataset.id) === 'pagamento');
	await tap(page, '[data-close]');
	await wait(page);
	l = await live(page);
	check('navigate: data-close closes the modal', !l.modal && l.shown.join() === 'horario', JSON.stringify(l));
	check('preview: no errors', !page.errors.length, page.errors.join(' | '));
	await page.close();
}

// ------------------------------------------------------------------ data-each, states
{
	const page = await open('s=ready&screen=servicos');
	const rows = await page.evaluate(() => {
		const doc = document.querySelector('.as-live iframe.as-if.on').contentDocument;
		const list = [...doc.querySelectorAll('[data-screen="servicos"] .linha-servico')];
		return { n: list.length, names: list.map(r => r.querySelector('b').textContent), raw: doc.body.innerHTML.includes('{{') };
	});
	check('data-each: Serviços lists the 5 example services', rows.n === 5 && rows.names[2] === 'Corte e barba' && !rows.raw, JSON.stringify(rows));
	await page.locator('.as-tcard[data-id="horarios"]').dispatchEvent('click');
	await wait(page);
	await page.locator('[data-act="set-state"][data-state="vazio"]').first().dispatchEvent('click');
	await wait(page);
	const l = await live(page);
	check('states: the Estado buttons set the screen state', l.state === 'vazio' && await page.locator('[data-act="set-state"].on').first().getAttribute('data-state') === 'vazio', JSON.stringify(l));
	await page.locator('[data-act="set-state"][data-state="normal"]').first().dispatchEvent('click');
	await wait(page);
	check('states: back to normal', (await live(page)).state === 'normal');
	await page.close();
}
{
	const page = await open('s=states');
	const frames = await page.evaluate(() => [...document.querySelectorAll('.as-sframe .as-snap')].map(s => s.querySelector('iframe')?.contentDocument?.body.getAttribute('data-estado')));
	check('states view: one frame per state of Meus horários, each in its state', frames.join() === 'normal,carregando,vazio,erro,sem-internet', frames.join());
	await page.locator('select[data-set="states-screen"]').selectOption('inicio');
	await wait(page, 600);
	const sent = await clickAndAsk(page, '[data-act="states-pick"][data-state="vazio"]');
	check('states view: picking a state asks nothing', sent.length === 0);
	await wait(page, 500);
	const ask = await clickAndAsk(page, '.as-sframe [data-act="ask"]');
	check('states view: a missing state asks the agent for it', ask[0]?.text === 'Na tela Início, crie o estado vazio (quando não há nada para mostrar).' && ask[0].send && /^as-/.test(ask[0].id), ask[0]?.text);
	check('states view: no errors', !page.errors.length, page.errors.join(' | '));
	await page.close();
}

// ------------------------------------------------------------------ a new revision keeps the place; building outline
{
	const page = await open('s=ready');
	const appJson = fixture('ready', 'app.json');
	const state = fixture('ready', 'state.json');
	await page.locator('.as-tcard[data-id="servicos"]').dispatchEvent('click');
	await wait(page);
	await tap(page, '.linha-servico');
	await wait(page);
	await page.evaluate(() => document.querySelector('.as-live iframe.as-if.on').contentWindow.scrollTo(0, 120));
	const next = { ...appJson, revision: appJson.revision + 1, preview: appJson.preview.replace('Quem vai atender', 'Quem vai cortar') };
	await page.evaluate(([a, s]) => window.AS_SEND({ 'app.json': a, 'state.json': s }), [next, state]);
	await page.waitForFunction(() => /Quem vai cortar/.test(document.querySelector('.as-live iframe.as-if.on')?.contentDocument?.body.innerHTML || ''), null, { timeout: 5000 }).catch(() => { });
	const l = await live(page);
	const text = await page.evaluate(() => document.querySelector('.as-live iframe.as-if.on').contentDocument.querySelector('[data-screen="barbeiro"] .secao')?.textContent);
	check('revision: the new document is shown', text === 'Quem vai cortar', text);
	check('revision: the screen stays Barbeiro', l.shown.join() === 'barbeiro', l.shown.join());
	await tap(page, '[data-back]');
	await wait(page);
	check('revision: the stack is kept (back returns to Serviços)', (await live(page)).shown.join() === 'servicos');
	check('revision: two frames at most, one live device', await page.evaluate(() => document.querySelectorAll('.as-live iframe').length) === 2 && await liveCount(page) === 1);
	// A building step: the Studio comes back to the preview, on the screen, with the part outlined and named.
	await page.locator('[data-act="view"][data-view="map"]').first().dispatchEvent('click');
	await wait(page);
	const building = { ...state, building: { screen: 'inicio', part: 'servicos', at: Date.now() / 1000, action: 'write' } };
	await page.evaluate(([a, s]) => window.AS_SEND({ 'app.json': a, 'state.json': s }), [{ ...next, revision: next.revision + 1 }, building]);
	await page.waitForSelector('.as-box.build', { timeout: 5000 }).catch(() => { });
	const tag = await page.evaluate(() => document.querySelector('.as-box.build .as-tag')?.textContent || '');
	check('building: back to the preview on Início', await page.locator('.as-vb.on').first().textContent() === 'Prévia' && (await live(page)).shown.join() === 'inicio');
	check('building: the part being written is outlined with its name', /JumpCode · servicos/.test(tag), tag);
	check('revision: no errors', !page.errors.length, page.errors.join(' | '));
	await page.close();
}
{
	const page = await open('s=building');
	await page.waitForSelector('.as-box.build', { timeout: 5000 }).catch(() => { });
	check('building: the outline shows on arrival', await page.locator('.as-box.build').count() === 1);
	const planned = await page.evaluate(() => [...document.querySelector('.as-live iframe.as-if.on').contentDocument.querySelectorAll('.as-planejada')].map(p => getComputedStyle(p, '::before').content));
	check('building: the planned parts are skeletons with their names', planned.length === 3 && planned[0] === '"botao agendar"', planned.join());
	check('building: the build panel lists the parts', /Construindo a tela Início/.test(await page.locator('.as-side').textContent()) && /2 de 5 partes/.test(await page.locator('.as-side').textContent()));
	check('building: the agent works and Parar is there', /Escrevendo Início/.test(await page.locator('.as-bar').textContent()) && await page.locator('[data-act="stop"]').count() === 1);
	await page.locator('[data-act="stop"]').dispatchEvent('click');
	await wait(page, 100);
	check('building: Parar sends the host stop, no chat message', await page.evaluate(() => window.__posted.some(m => m.type === 'stop') && !window.__posted.some(m => m.type === 'ask')));
	await page.close();
}

// ------------------------------------------------------------------ devices: foldables, rotation, tablet, frame
{
	const page = await open('s=ready');
	const sizes = {};
	const pick = async (sel, wait_ = 500) => { await page.locator(sel).first().dispatchEvent('click'); await wait(page, wait_); };
	await pick('[data-act="device"][data-device="android-fold"]');
	await pick('[data-act="fold"][data-fold="open"]');
	let l = await live(page);
	sizes.open = `${l.w}x${l.h}`;
	const twoColumns = await page.evaluate(() => getComputedStyle(document.querySelector('.as-live iframe.as-if.on').contentDocument.querySelector('[data-screen="inicio"]')).display);
	await pick('[data-act="fold"][data-fold="closed"]');
	l = await live(page);
	sizes.closed = `${l.w}x${l.h}`;
	const oneColumn = await page.evaluate(() => getComputedStyle(document.querySelector('.as-live iframe.as-if.on').contentDocument.querySelector('[data-screen="inicio"]')).display);
	await pick('[data-act="fold"][data-fold="open"]');
	await pick('[data-act="rotate"]');
	l = await live(page);
	sizes.openLandscape = `${l.w}x${l.h}`;
	await pick('[data-act="rotate"]');
	await pick('[data-act="device"][data-device="iphone-fold"]');
	l = await live(page);
	sizes.iphoneFoldOpen = `${l.w}x${l.h}`;
	await pick('[data-act="fold"][data-fold="closed"]');
	l = await live(page);
	sizes.iphoneFoldClosed = `${l.w}x${l.h}`;
	await pick('[data-act="device"][data-device="tablet"]');
	l = await live(page);
	sizes.tablet = `${l.w}x${l.h}`;
	await pick('[data-act="rotate"]');
	l = await live(page);
	sizes.tabletLandscape = `${l.w}x${l.h}`;
	await pick('[data-act="device"][data-device="android"]');
	l = await live(page);
	sizes.androidLandscape = `${l.w}x${l.h}`;
	await pick('[data-act="rotate"]');
	l = await live(page);
	sizes.android = `${l.w}x${l.h}`;
	check('devices: foldable open 690 × 780, closed 344 × 860', sizes.open === '690x780' && sizes.closed === '344x860', JSON.stringify(sizes));
	check('devices: the app\'s media queries see the device width', twoColumns === 'grid' && oneColumn === 'block', `${twoColumns}/${oneColumn}`);
	check('devices: rotation swaps the sizes', sizes.openLandscape === '780x690' && sizes.tabletLandscape === '1180x820' && sizes.androidLandscape === '915x412', JSON.stringify(sizes));
	check('devices: iPhone foldable 720 × 790 / 360 × 800, tablet 820 × 1180, Android 412 × 915', sizes.iphoneFoldOpen === '720x790' && sizes.iphoneFoldClosed === '360x800' && sizes.tablet === '820x1180' && sizes.android === '412x915', JSON.stringify(sizes));
	await pick('[data-act="device"][data-device="android-fold"]');
	await pick('[data-act="fold"][data-fold="both"]', 1200);
	const both = await page.evaluate(() => [...document.querySelectorAll('.as-live iframe.as-if.on')].map(f => `${f.contentWindow.innerWidth}x${f.contentWindow.innerHeight}`));
	check('devices: "Os dois" shows closed and open side by side', both.join() === '344x860,690x780', both.join());
	await tap(page, '[data-part="botao-agendar"] [data-go]');
	await wait(page, 300);
	const followed = await page.evaluate(() => [...document.querySelectorAll('.as-live iframe.as-if.on')].map(f => [...f.contentDocument.querySelectorAll('.as-tela')].filter(s => !s.hidden).map(s => s.dataset.screen).join()));
	check('devices: the other device follows the navigation', followed.join('|') === 'servicos|servicos', followed.join('|'));
	const framed = await page.locator('.as-live .as-shell').count();
	await page.locator('input[data-set="frame"]').first().click();
	await wait(page, 400);
	const bare = await page.evaluate(() => ({ shells: document.querySelectorAll('.as-live .as-shell').length, outlined: [...document.querySelectorAll('.as-live .as-scr')].every(s => s.classList.contains('bare')) }));
	check('devices: with the frame a device body each; without it the screen alone, outlined', framed === 2 && bare.shells === 0 && bare.outlined, `${framed} / ${JSON.stringify(bare)}`);
	check('devices: no errors', !page.errors.length, page.errors.join(' | '));
	await page.close();
}
{
	const page = await open('s=no-frame');
	check('no frame: no device body, width and safe areas annotated', await page.locator('.as-live .as-shell').count() === 0 && /390/.test(await page.locator('.as-annot .rw').textContent()) && await page.locator('.as-annot .safe').count() === 2);
	await page.close();
}

// ------------------------------------------------------------------ the map
{
	const page = await open('s=map');
	const map = await page.evaluate(() => ({ edges: document.querySelectorAll('.as-edges path.e').length, nodes: document.querySelectorAll('.as-node[data-node]').length, ghost: document.querySelectorAll('.as-node.ghost').length, labels: [...document.querySelectorAll('.as-elabel')].map(l => l.textContent), dead: !!document.querySelector('.as-node[data-node="confirmado"].mk'), group: document.querySelector('.as-group')?.textContent }));
	check('map: every screen is a node, the missing one a ghost', map.nodes === 10 && map.ghost === 1, JSON.stringify(map));
	check('map: the edges are drawn with their taps', map.edges >= 10 && map.labels.includes('Pagar R$ 45,00 com Pix') && map.labels.includes('Remarcar'), `${map.edges} edges`);
	check('map: the tabs group and the dead end mark', /Abas · 4/i.test(map.group || '') && map.dead, map.group);
	await page.locator('.as-node[data-node="confirmado"]').dispatchEvent('click');
	await wait(page);
	const path = await page.evaluate(() => ({ on: [...document.querySelectorAll('.as-edges path.e.on')].map(p => p.dataset.e), steps: [...document.querySelectorAll('.as-node.on .as-step')].map(s => s.textContent).sort() }));
	check('map: picking a screen highlights the path from the start', path.on.length === 3 && path.on.includes('pagamento>confirmado') && path.steps.join() === '1,2,3,4', JSON.stringify(path));
	const create = await clickAndAsk(page, '.as-side [data-act="ask"][data-text^="Crie a tela ajuda"]');
	check('map: the missing screen asks to be created', create[0]?.text === 'Crie a tela ajuda; a tela Perfil já leva para ela.' && create[0].send, create[0]?.text);
	check('map: no errors', !page.errors.length, page.errors.join(' | '));
	await page.close();
}
{
	const page = await open('s=python-real&view=map');
	const real = await page.evaluate(() => ({ edges: [...document.querySelectorAll('.as-edges path.e')].map(p => p.dataset.e), back: [...document.querySelectorAll('.as-node .ret')].map(r => r.textContent) }));
	check('map (real files): back and close are notes on the node, not arrows', !real.edges.some(e => /null/.test(e)) && real.back.includes('volta') && real.back.includes('fecha'), JSON.stringify(real));
	check('map (real files): no errors', !page.errors.length, page.errors.join(' | '));
	await page.close();
}

// ------------------------------------------------------------------ asks: every button that changes the app
const ASKS = [
	['problems: Pedir esta correção', 's=problems', '.as-prob [data-act="ask"]', 'Na tela Confirmado: ponha um botão para Meus horários e outro para voltar ao Início.', true],
	['versions: Voltar para a versão 10', 's=versions', null, 'Volte o app para a versão 10.', true],
	['publish: Publicar como PWA', 's=publish', '[data-act="ask"][data-text="Publique o app como PWA."]', 'Publique o app como PWA.', true],
	['publish: Android e iPhone', 's=publish', '[data-act="ask"][data-text^="Publique o app como PWA e prepare"]', 'Publique o app como PWA e prepare os arquivos do Capacitor para Android e iPhone.', true],
	['strip: Nova tela', 's=ready', '[data-act="new-screen"]', 'Crie a tela ', false],
	['start: Começar', 's=empty', '[data-act="start-go"]', 'Crie um app de celular novo no AppStudio: comece pela tela Início, com a barra de abas.', true],
	['start: Experimente pedir', 's=empty', '[data-act="sample"]', 'Faça a tela inicial com o próximo horário e os serviços com preço.', false],
	['settings: Mudar a pasta', 's=settings', '[data-act="set-folder"]', 'Mude a pasta do app no AppStudio para ', false],
	['settings: cor principal', 's=settings', '.as-color [data-act="fill"]', 'Mude a cor principal do app (hoje #24563F) para ', false],
];
for (const [name, query, selector, expected, send] of ASKS) {
	const page = await open(query);
	let sent;
	if (!selector) {
		await page.locator('.as-ver[data-n="10"]').dispatchEvent('click');
		await wait(page);
		sent = await clickAndAsk(page, '.as-side [data-act="ask"]');
	} else {
		sent = await clickAndAsk(page, selector);
	}
	const ok = sent.length === 1 && sent[0].text === expected && sent[0].send === send && (send ? /^as-/.test(sent[0].id || '') : !sent[0].id);
	check(`asks: ${name}`, ok, sent.map(s => `${s.send ? 'send' : 'fill'}: ${s.text}`).join(' | '));
	check(`asks: ${name}: no errors`, !page.errors.length, page.errors.join(' | '));
	await page.close();
}
{
	const page = await open('s=settings');
	await page.locator('input[data-set="set-device"][data-device="tablet"]').click();
	await page.locator('input[data-set="set-frame"]').click();
	await wait(page);
	check('settings: the changes show struck', await page.locator('.as-set del.as-del').count() === 2);
	const sent = await clickAndAsk(page, '[data-act="set-ask"]');
	check('settings: several changes in one request', sent[0]?.text === 'Mude as configurações do AppStudio: os aparelhos da prévia para iPhone, Android, iPhone dobrável e Android dobrável; a moldura da prévia para desligada.', sent[0]?.text);
	await page.locator('input[data-set="set-frame"]').click();
	await wait(page);
	await page.locator('[data-act="set-undo"]').dispatchEvent('click');
	await wait(page);
	check('settings: undo leaves nothing to ask', await page.locator('[data-act="set-ask"]').count() === 0);
	await page.close();
}
{
	const page = await open('s=ready');
	await page.locator('[data-act="mode"][data-mode="edit"]').first().dispatchEvent('click');
	await wait(page);
	await tap(page, '[data-part="proximo-horario"] .botao-claro');
	await wait(page);
	const navigated = (await live(page)).shown.join();
	check('edit: a click selects instead of navigating', navigated === 'inicio' && await page.locator('.as-box.sel').count() === 1, navigated);
	const sent = await clickAndAsk(page, '[data-act="sel-ask"]');
	check('edit: Pedir mudança fills the chat with the screen, part and element', sent[0]?.text === 'Na tela Início, parte proximo-horario (botão “Remarcar”): ' && sent[0].send === false, sent[0]?.text);
	check('edit: no errors', !page.errors.length, page.errors.join(' | '));
	await page.close();
}
{
	const page = await open('s=problems');
	await page.waitForFunction(() => /Toque pequeno/.test(document.querySelector('.as-main')?.textContent || ''), null, { timeout: 5000 }).catch(() => { });
	const text = await page.locator('.as-main').textContent();
	check('problems: touch targets measured here (Remarcar 36 de altura)', /Toque pequeno/.test(text) && /“Remarcar” \(36 de altura\)/.test(text), '');
	const all = await clickAndAsk(page, '.as-pfoot [data-act="ask"]');
	check('problems: Pedir as correções sends one numbered request', /^Corrija estes \d+ problemas do app: 1\) Na tela Confirmado: ponha/.test(all[0]?.text || '') && all[0].send, (all[0]?.text || '').slice(0, 120));
	await page.close();
}

// ------------------------------------------------------------------ agent state and focus
{
	const page = await open('s=versions&agent=0');
	await page.locator('.as-ver[data-n="9"]').dispatchEvent('click');
	await wait(page);
	const [sent] = await clickAndAsk(page, '.as-side [data-act="ask"]');
	await wait(page, 100);
	check('agent: pending after a request', /Pedido enviado/.test(await page.locator('.as-bar').textContent()));
	await page.evaluate(() => window.AS_HOST({ type: 'running', running: true, executions: [], requests: ['x'] }));
	await wait(page, 100);
	check('agent: working while it runs', /Agente trabalhando/.test(await page.locator('.as-bar').textContent()));
	await page.evaluate(id => window.AS_HOST({ type: 'request', requestId: id, state: 'settled' }), sent.id);
	await page.evaluate(() => window.AS_HOST({ type: 'running', running: false, executions: [], requests: [] }));
	await wait(page, 100);
	check('agent: saved again when it settles', /Salvo · versão 12/.test(await page.locator('.as-bar').textContent()));
	const [again] = await clickAndAsk(page, '.as-side [data-act="ask"]');
	await page.evaluate(id => window.AS_HOST({ type: 'request', requestId: id, state: 'rejected' }), again.id);
	await wait(page, 100);
	check('agent: a refused request says the agent is busy', /ocupado/.test(await page.locator('.as-studio').textContent()));
	await page.close();
}
{
	const page = await open('s=ready');
	const state = fixture('ready', 'state.json');
	await page.evaluate(s => window.AS_SEND({ 'state.json': { ...s, view: 'map' } }), state);
	await wait(page, 400);
	check('focus: the view the agent shows', await page.locator('.as-vb.on').first().textContent() === 'Mapa');
	await page.locator('[data-act="view"][data-view="screens"]').first().dispatchEvent('click');
	await wait(page);
	await page.evaluate(s => window.AS_SEND({ 'state.json': { ...s, view: 'map', updated: s.updated + 5 } }), state);
	await wait(page, 400);
	check('focus: the same focus again does not pull the user back', await page.locator('.as-vb.on').first().textContent() === 'Telas');
	await page.evaluate(s => window.AS_SEND({ 'state.json': { ...s, view: 'preview', focus: { ...s.focus, screen: 'perfil', device: 'android', part: 'menu' } } }), state);
	await page.waitForFunction(() => [...(document.querySelector('.as-live iframe.as-if.on')?.contentDocument?.querySelectorAll('.as-tela') || [])].some(s => !s.hidden && s.dataset.screen === 'perfil'), null, { timeout: 5000 }).catch(() => { });
	const l = await live(page);
	check('focus: screen, device and part', l?.shown.join() === 'perfil' && l.w === 412 && await page.locator('.as-box.flash').count() === 1, JSON.stringify(l));
	await page.evaluate(s => window.AS_SEND({ 'state.json': { ...s, notice: { kind: 'warning', text: 'A parte topo foi recusada.', at: s.updated } } }), state);
	await wait(page, 300);
	check('focus: a notice shows as a toast', /A parte topo foi recusada/.test(await page.locator('.as-layer').textContent()));
	check('focus: no errors', !page.errors.length, page.errors.join(' | '));
	await page.close();
}
{
	const page = await open('s=test');
	await tap(page, '.linha-servico');
	await wait(page);
	await tap(page, '.linha-barbeiro:not(.livre)');
	await wait(page);
	const hist = await page.evaluate(() => [...document.querySelectorAll('[data-act="hist"] b')].map(b => b.textContent));
	check('test: the navigation history', hist.join() === 'Início,Serviços,Barbeiro,Horário', hist.join());
	await page.locator('[data-act="hist"][data-i="1"]').dispatchEvent('click');
	await wait(page);
	check('test: a history row goes back to that point', (await live(page)).shown.join() === 'servicos' && await page.locator('[data-act="hist"]').count() === 2);
	await page.locator('[data-act="restart"]').dispatchEvent('click');
	await wait(page);
	check('test: Reiniciar o app opens the start', (await live(page)).shown.join() === 'inicio');
	check('test: nothing in test mode asks the agent', (await asks(page)).length === 0);
	await page.close();
}

// ------------------------------------------------------------------ every view: no errors, no CSP refusals
for (const query of ['s=empty', 's=screens', 's=structure', 's=versions', 's=publish', 's=settings', 's=tablet-landscape', 's=python-real', 's=python-real&view=preview', 's=python-real&view=states&screen=horarios']) {
	const page = await open(query);
	await wait(page, 400);
	check(`views: ${query} has no console errors or CSP refusals`, !page.errors.length, page.errors.join(' | '));
	await page.close();
}

await browser.close();
server.close();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exitCode = failures ? 1 : 0;
