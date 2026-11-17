/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Dev only: drives the TaskStudio interface through the fake host and checks that every user
// action sends exactly the messages of CONTRACT.md ("What the interface sends"), plus keyboard,
// pan and zoom, view.json revisions and the recalibration dialog. Run: node interact.mjs
import { chromium } from 'file:///C:/Projects/jumpcode/node_modules/playwright/index.mjs';
import { start } from './serve.mjs';

const server = await start();
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1075, height: 724 }, deviceScaleFactor: 1.25 });
let failures = 0;
let checks = 0;

function check(name, ok, detail = '') {
	checks++;
	if (!ok) {
		failures++;
	}
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `  -> ${detail}` : ''}`);
}

async function open(query) {
	const page = await ctx.newPage();
	const errors = [];
	page.on('pageerror', e => errors.push(e.message));
	page.on('console', m => {
		if (m.type() === 'error') {
			errors.push(m.text());
		}
	});
	await page.goto(`${base}?sim=0&${query}`);
	await page.waitForSelector('#ts-body');
	await page.waitForTimeout(150);
	page.errors = errors;
	return page;
}

const posted = page => page.evaluate(() => window.__posted.filter(m => m.type !== 'ready'));
const clear = page => page.evaluate(() => {
	window.__posted.length = 0;
});
const asks = async page => (await posted(page)).filter(m => m.type === 'ask').map(m => `${m.send ? 'send' : 'fill'}:${m.text}`);
const send = (page, msg) => page.evaluate(m => window.__send(m), msg);
const files = page => page.evaluate(() => Object.assign({}, window.__files));

// Começar
{
	const page = await open('state=ready');
	await page.click('[data-act="start"]');
	check('Começar sends "Pode começar."', JSON.stringify(await asks(page)) === JSON.stringify(['send:Pode começar.']), JSON.stringify(await asks(page)));
	await page.close();
}

// Pausar and Retomar tudo
{
	const page = await open('state=running');
	await page.click('[data-act="stop"]');
	check('Pausar sends stop', JSON.stringify((await posted(page)).map(m => m.type)) === '["stop"]');
	await clear(page);
	await send(page, { type: 'running', running: false });
	await page.waitForTimeout(80);
	const label = await page.locator('.ts-card[data-id="6"] .cm .ts-pill').textContent();
	check('a running task shows Pausada when the agent is idle', label.includes('Pausada'), label);
	await page.click('[data-act="resume-all"]');
	check('Retomar tudo sends the resume text', JSON.stringify(await asks(page)) === JSON.stringify(['send:Retome o plano de onde parou.']), JSON.stringify(await asks(page)));
	await page.close();
}

// Editing a running task: stop first, then the panel; recalibrate; optimistic dialog; agent goes idle.
{
	const page = await open('state=details');
	await page.click('.ts-panel [data-act="edit"][data-id="6"]');
	await page.waitForTimeout(80);
	const types = (await posted(page)).map(m => m.type);
	check('Editar tarefa on a running task sends stop first', types[0] === 'stop', JSON.stringify(types));
	check('the edit panel opens with the text focused', await page.evaluate(() => document.activeElement?.id === 'ts-edit-detail'));
	check('Recalibrar is disabled until the text changes', await page.locator('[data-act="recal"]').isDisabled());
	// The host answers the stop: the agent is idle now.
	await send(page, { type: 'running', running: false });
	await page.waitForTimeout(50);
	check('the stopped task shows Pausada in the edit panel', (await page.locator('.ts-panel .sub').textContent()).includes('Pausada'));
	check('a banner says the execution was paused for the edit', (await page.locator('.ts-banner').first().textContent()).includes('pausada'));
	await page.fill('#ts-edit-detail', 'O cliente escolhe o serviço, o barbeiro, o dia e um horário livre.');
	await page.click('[data-act="recal"]');
	const a = await asks(page);
	check('Recalibrar e retomar sends the exact text', a.length === 1 && a[0] === 'send:Mudei a tarefa #6 Tela de agendamento. Agora: «O cliente escolhe o serviço, o barbeiro, o dia e um horário livre.». Recalibre o plano.', JSON.stringify(a));
	check('the recalibrating dialog shows at once', await page.locator('.ts-modal').count() === 1);
	check('only the first step runs before data arrives', await page.locator('.ts-modal .ts-step .spin').count() === 1 && await page.locator('.ts-modal .ts-step.todo').count() === 4);
	await send(page, { type: 'running', running: true });
	await send(page, { type: 'running', running: false });
	await page.waitForTimeout(80);
	check('the dialog closes when the agent goes idle without recalibrating', await page.locator('.ts-modal').count() === 0);
	const note = await page.locator('.ts-notice').allTextContents();
	check('a neutral note says the agent did not recalibrate', note.some(n => n.includes('O agente não recalibrou; peça de novo no chat.')), JSON.stringify(note));
	await page.close();
}

// The optimistic dialog gives way to plan.recalibrating, then to the proposal.
{
	const page = await open('state=edit-done');
	await page.click('[data-act="recal"]');
	check('a done task uses Recalibrar', (await asks(page))[0]?.startsWith('send:Mudei a tarefa #3 Modelar o banco. Agora: «'));
	const f = await files(page);
	const plan = JSON.parse(f['plan.json']);
	plan.recalibrating = { task: '3', kind: 'done', text: 'vários serviços', at: '2026-11-13T14:40:00Z', paused: ['6', '9'], impact: { done: ['5'], running: ['6', '9'], todo: ['7', '8', '10', '11'] } };
	await send(page, { type: 'running', running: true });
	await send(page, { type: 'files', files: Object.assign({}, f, { 'plan.json': JSON.stringify(plan) }) });
	await page.waitForTimeout(80);
	check('with recalibrating, four steps are done and the last one spins', await page.locator('.ts-modal .ts-step .c-green').count() === 4 && await page.locator('.ts-modal .ts-step .spin').count() === 1);
	check('impacted cards show Analisando', (await page.locator('.ts-card[data-id="7"] .ts-pill').textContent()).includes('Analisando'));
	check('other cards are dimmed', await page.locator('.ts-card[data-id="1"].dim').count() === 1);
	plan.recalibrating = null;
	const proposal = { schema: 1, revision: 1, plan: 2, base: 1, states: { 3: 'done' }, cause: { task: '3', text: 'vários serviços' }, summary: 'Muda 1 tarefa.', extra: 4, changes: [{ task: '3', kind: 'refazer', note: 'Nova tabela.', why: 'sua mudança' }] };
	await send(page, { type: 'files', files: Object.assign({}, f, { 'plan.json': JSON.stringify(plan), 'proposal.json': JSON.stringify(proposal) }) });
	await page.waitForTimeout(80);
	check('the proposal replaces the dialog with the side list', await page.locator('.ts-modal').count() === 0 && await page.locator('.ts-panel[aria-label="O que vai mudar"]').count() === 1);
	check('changed cards get a solid badge', (await page.locator('.ts-card[data-id="3"] .ts-badge').textContent()) === 'Refazer');
	await page.close();
}

// Retomar sem mudar (banner and panel)
{
	const page = await open('state=edit-running');
	await page.click('.ts-banner [data-act="resume"]');
	check('Retomar sem mudar sends the task text', JSON.stringify(await asks(page)) === JSON.stringify(['send:Retome a tarefa #6 Tela de agendamento sem mudar nada.']), JSON.stringify(await asks(page)));
	await page.close();
}

// Proposal: apply, discard, compare
{
	const page = await open('state=proposal');
	await page.click('.ts-panel [data-act="apply"]');
	await page.click('.ts-panel [data-act="discard"]');
	check('Aplicar and Descartar send the plan versions', JSON.stringify(await asks(page)) === JSON.stringify(['send:Aplique as mudanças do plano v2.', 'send:Descarte a proposta do plano v2 e mantenha o plano v1.']), JSON.stringify(await asks(page)));
	await page.click('.ts-panel [data-act="mode"][data-mode="compare"]');
	check('Comparar antes e depois opens the two columns', await page.locator('.ts-compare table').count() === 1);
	check('the before column strikes removed text', await page.locator('.ts-compare del').count() > 0);
	check('the after column underlines inserted text', await page.locator('.ts-compare ins').count() > 0);
	await page.keyboard.press('Escape');
	check('Escape leaves the comparison', await page.locator('.ts-compare').count() === 0);
	await page.close();
}

// Proposal that redoes done work after editing a task not done: dialog first, then the side list.
{
	const page = await open('state=proposal-done');
	check('the proposal touching done tasks opens as a dialog', await page.locator('.ts-modal[aria-labelledby="ts-prop-title"]').count() === 1);
	await page.click('[data-act="proposal-side"]');
	check('Revisar uma a uma moves it to the side list', await page.locator('.ts-modal').count() === 0 && await page.locator('.ts-panel[aria-label="O que vai mudar"]').count() === 1);
	await page.close();
}

// Gates
{
	const page = await open('state=gate');
	check('a secret gate has no input field', await page.locator('.ts-panel input, .ts-panel textarea').count() === 0);
	check('a secret gate shows the variable name', (await page.locator('.ts-env code').textContent()).includes('PIX_KEY'));
	await page.click('[data-act="gate-done"]');
	await page.click('.ts-panel [data-act="gate-later"]');
	await page.click('.ts-panel [data-act="option"][data-i="1"]');
	check('Já resolvi, Deixar para depois and an alternative send their texts', JSON.stringify(await asks(page)) === JSON.stringify([
		'send:Já coloquei Chave Pix de teste (sandbox) no projeto para a tarefa #7.',
		'send:Deixe a tarefa #7 Pagamento por Pix para depois.',
		'send:Na tarefa #7: Usar um pagamento simulado.',
	]), JSON.stringify(await asks(page)));
	await page.close();
}
{
	const page = await open('state=running');
	await page.locator('[data-act="gate"][data-id="11"]').dispatchEvent('click');
	await page.waitForTimeout(60);
	await page.click('[data-act="gate-approve"]');
	check('Aprovar sends the approval text', JSON.stringify(await asks(page)) === JSON.stringify(['send:Aprovo: Publicar o site (#11).']), JSON.stringify(await asks(page)));
	await page.close();
}

// Problem
{
	const page = await open('state=problem');
	await page.click('[data-act="retry"]');
	await page.click('.ts-panel [data-act="option"][data-i="0"]');
	check('Tentar de novo and an option send their texts', JSON.stringify(await asks(page)) === JSON.stringify(['send:Tente a tarefa #7 de novo.', 'send:Na tarefa #7: Trocar a chave.']), JSON.stringify(await asks(page)));
	await page.close();
}

// Ask about a task, open a file, export, focus mode
{
	const page = await open('state=details');
	await page.click('.ts-panel [data-act="ask-task"]');
	check('Perguntar fills the composer without sending', JSON.stringify(await asks(page)) === JSON.stringify(['fill:Sobre a tarefa #6 Tela de agendamento: ']), JSON.stringify(await asks(page)));
	await clear(page);
	await page.click('.ts-panel [data-act="open-file"]');
	const p1 = await posted(page);
	check('a file opens in the editor', p1[0]?.type === 'openFile' && p1[0].path === 'components/ServicoPicker.tsx', JSON.stringify(p1));
	await page.keyboard.press('Escape');
	check('Escape closes the panel', await page.locator('.ts-panel').count() === 0);
	await clear(page);
	await page.click('[data-act="menu"]');
	await page.click('#ts-menu-box [data-mode="focus"]');
	await page.keyboard.press('Escape');
	const p2 = (await posted(page)).filter(m => m.type === 'focus').map(m => m.on);
	check('focus mode hides and shows the chat', JSON.stringify(p2) === '[true,false]', JSON.stringify(p2));
	await page.close();
}
{
	const page = await open('state=finished');
	await page.click('.ts-panel [data-act="export"]');
	const p = await posted(page);
	check('Exportar sends save with the plan', p[0]?.type === 'save' && p[0].name.endsWith('.json') && JSON.parse(p[0].content).plan.title === 'Barbearia do Zé', JSON.stringify(p).slice(0, 200));
	await page.close();
}

// Keyboard on the map, pan and zoom
{
	const page = await open('state=running');
	await page.focus('.ts-card[data-id="1"]');
	await page.keyboard.press('ArrowRight');
	check('ArrowRight moves to the card on the right', await page.evaluate(() => document.activeElement?.getAttribute('data-id')) === '2');
	await page.keyboard.press('ArrowDown');
	const below = await page.evaluate(() => document.activeElement?.getAttribute('data-id'));
	check('ArrowDown moves to a card below', ['3', '4'].includes(below), below);
	await page.keyboard.press('Enter');
	check('Enter opens the details', await page.locator(`.ts-panel[aria-label="Detalhes de #${below}"]`).count() === 1);
	const before = await page.locator('#ts-zoom-pct').textContent();
	await page.mouse.move(300, 300);
	await page.keyboard.down('Control');
	await page.mouse.wheel(0, -300);
	await page.keyboard.up('Control');
	await page.waitForTimeout(50);
	check('Ctrl+wheel zooms', (await page.locator('#ts-zoom-pct').textContent()) !== before);
	const t0 = await page.locator('#ts-stage').evaluate(el => el.style.transform);
	await page.mouse.move(40, 300);
	await page.mouse.down();
	await page.mouse.move(140, 340, { steps: 4 });
	await page.mouse.up();
	const t1 = await page.locator('#ts-stage').evaluate(el => el.style.transform);
	check('dragging the canvas pans', t0 !== t1, `${t0} / ${t1}`);
	await page.click('[data-act="fit"]');
	await page.close();
}

// view.json is followed once per revision; a broken file keeps the last good plan.
{
	const page = await open('state=view');
	check('view.json selects its task', await page.locator('.ts-card[data-id="6"].sel').count() === 1);
	await page.keyboard.press('Escape');
	const f = await files(page);
	await send(page, { type: 'files', files: Object.assign({}, f, { 'plan.json': f['plan.json'].replace('"revision": 37', '"revision": 38') }) });
	await page.waitForTimeout(60);
	check('the same view revision is not followed again', await page.locator('.ts-card.sel').count() === 0);
	const view = JSON.parse(f['view.json']);
	view.revision = 5;
	view.select = '9';
	await send(page, { type: 'files', files: Object.assign({}, f, { 'view.json': JSON.stringify(view) }) });
	await page.waitForTimeout(60);
	check('a new view revision is followed', await page.locator('.ts-card[data-id="9"].sel').count() === 1);
	await send(page, { type: 'files', files: Object.assign({}, f, { 'plan.json': '{"tasks": [' }) });
	await page.waitForTimeout(60);
	check('a broken plan keeps the cards', await page.locator('.ts-card').count() === 11);
	check('and shows a neutral notice', (await page.locator('.ts-notice').allTextContents()).some(t => t.includes('plan.json')));
	await send(page, { type: 'filesError', message: 'Não foi possível ler a pasta do Studio.' });
	await page.waitForTimeout(40);
	check('filesError shows a notice and keeps the plan', (await page.locator('.ts-notice').allTextContents()).some(t => t.includes('pasta do Studio')) && await page.locator('.ts-card').count() === 11);
	check('no console errors', page.errors.length === 0, page.errors.join(' | '));
	await page.close();
}

// No project: no Começar, a banner explains.
{
	const page = await open('state=ready&project=0');
	check('without a project there is no Começar', await page.locator('[data-act="start"]').count() === 0);
	check('a banner says how to carry the plan out', (await page.locator('.ts-banner').textContent()).includes('abra o TaskStudio a partir de um projeto'));
	await page.close();
}
{
	const page = await open('state=empty');
	await page.click('[data-act="example"][data-i="0"]');
	check('an example request fills the composer', (await asks(page))[0]?.startsWith('fill:Crie um site de agendamento'));
	await page.close();
}

// Re-render cost: 60 tasks, 30 files messages.
{
	const page = await open('state=big');
	const ms = await page.evaluate(async () => {
		const f = Object.assign({}, window.__files);
		const plan = JSON.parse(f['plan.json']);
		const t0 = performance.now();
		for (let i = 0; i < 30; i++) {
			plan.revision++;
			plan.tasks[10].progress = (i * 3) % 100;
			window.postMessage({ type: 'files', files: Object.assign({}, f, { 'plan.json': JSON.stringify(plan) }) }, '*');
			await new Promise(r => setTimeout(r, 0));
		}
		return performance.now() - t0;
	});
	check(`30 updates of a 38-task plan take ${Math.round(ms)} ms`, ms < 3000);
	await page.close();
}

await browser.close();
server.close();
console.log(`\n${checks - failures} of ${checks} checks passed`);
if (failures) {
	process.exitCode = 1;
}
