/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Local browser checks; the fake host records the asks without executing agent actions. The size is the Studio
// webview's, SS_SIZE=<width>x<height>@<scale> (default: the real JumpCode window, 1075x724 at 1.25).
// Run from this folder: [SS_SIZE=1344x905@1] node regressions.mjs
import assert from 'node:assert/strict';
import { chromium } from 'file:///C:/Projects/jumpcode/node_modules/playwright/index.mjs';
import { start } from './serve.mjs';

const VIEWS = ['sheet', 'charts', 'panel', 'cleanup', 'history', 'profile', 'settings', 'files'];
const STATES = ['barbearia', 'limpa', 'empty', 'importing', 'long'];

const size = /^(\d+)x(\d+)(?:@([\d.]+))?$/.exec(process.env.SS_SIZE || '1075x724@1.25');
if (!size) {
	throw new Error('SS_SIZE must look like 1075x724@1.25');
}
const viewport = { width: Number(size[1]), height: Number(size[2]) };

const server = await start();
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport, deviceScaleFactor: Number(size[3] || 1) });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') { errors.push(message.text()); } });
const lastAsk = () => page.evaluate(() => window.__posted.filter(m => m.type === 'ask').at(-1));
const asksSent = () => page.evaluate(() => window.__posted.filter(m => m.type === 'ask').length);
/** The fixture files again, with a new view.json (the agent's focus) and optional edits to sheet.json. */
const sendFiles = (revision, view, select, note = '', sheet = null) => page.evaluate(([r, v, s, n, edit]) => {
	const files = window.SS_LIVE();
	files['view.json'] = JSON.stringify({ schema: 1, revision: r, view: v, select: s, note: n });
	if (edit) {
		const value = JSON.parse(files['sheet.json']);
		Object.assign(value.file, edit);
		files['sheet.json'] = JSON.stringify(value);
	}
	window.dispatchEvent(new MessageEvent('message', { data: { type: 'files', files } }));
}, [revision, view, select, note, sheet]);
const go = async query => {
	await page.goto(`${url}/?${query}`);
	await page.waitForSelector('.ss-studio');
	await page.waitForTimeout(120);
};
const results = {};
try {
	for (const state of STATES) {
		for (const view of VIEWS) {
			await go(`state=${state}&view=${view}`);
			assert.ok((await page.locator('.ss-body').innerText()).trim(), `${state}/${view} is empty`);
			const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
			assert.ok(wide <= 0, `${state}/${view} scrolls sideways by ${wide}px`);
			const scrollbars = await page.evaluate(() => [...document.querySelectorAll('.ss-studio *')]
				.filter(el => ['auto', 'scroll'].includes(getComputedStyle(el).overflowX) && el.scrollWidth > el.clientWidth + 1 && !el.matches('.ss-gridwrap.wide')).map(el => el.className));
			assert.deepEqual(scrollbars, [], `${state}/${view} has a horizontal scrollbar`);
			const bar = await page.evaluate(() => { const el = document.querySelector('.ss-bar'); return el.scrollWidth - el.clientWidth; });
			assert.ok(bar <= 1, `${state}/${view}: the toolbar is cut by ${bar}px`);
		}
	}
	results.views = VIEWS.length * STATES.length;

	// Nothing open: the project's spreadsheets; opening one and looking for them ask the agent; examples fill the chat box.
	await go('state=empty');
	await page.locator('.ss-foot-row [data-act="file-open"]').click();
	let ask = await lastAsk();
	assert.deepEqual([ask.text, ask.send, typeof ask.requestId], ['Abra a planilha dados/atendimentos-2026.xlsx', true, 'string']);
	await page.locator('.ss-file[data-path="dados/precos.csv"]').click();
	await page.locator('.ss-foot-row [data-act="file-open"]').click();
	assert.equal((await lastAsk()).text, 'Abra a planilha dados/precos.csv');
	await page.locator('[data-act="files-find"]').first().click();
	assert.equal((await lastAsk()).text, 'Liste as planilhas do projeto');
	await page.locator('.ss-example').first().click();
	ask = await lastAsk();
	assert.deepEqual([ask.text, ask.send, ask.requestId], ['qual serviço mais fatura?', false, undefined]);
	results.first = 'passed';

	// The agent's focus (view.json) switches the view and the selection once per revision: a chart id, a column.
	await go('state=barbearia&view=sheet');
	await sendFiles(20, 'charts', 'g3');
	await page.waitForSelector('.ss-tr.sel[data-id="g3"]');
	assert.match(await page.locator('.ss-main .ss-ph .t').first().innerText(), /Faturamento por barbeiro/);
	await sendFiles(21, 'profile', 'valor');
	await page.waitForSelector('tr.sel[data-key="c6"]');
	await page.locator('.ss-vb[data-view="panel"]').click();
	await page.waitForSelector('.ss-tiles');
	await sendFiles(21, 'profile', 'valor');
	await page.waitForTimeout(150);
	assert.equal(await page.locator('tr[data-act="prof"]').count(), 0, 'the same revision must not move the Studio again');
	await sendFiles(22, 'panel', 'g2', 'Painel atualizado');
	await page.waitForSelector('.ss-panel.picked');
	await page.waitForSelector('.ss-toast:has-text("Painel atualizado")');
	await go('state=limpa&view=charts');
	await sendFiles(23, 'sheet', 'x1');
	await page.waitForSelector('text=Coluna nova · dia da semana');
	assert.ok(await page.locator('th.nw .nm:has-text("dia da semana")').count(), 'the calculated column is marked in the grid');
	await page.locator('[data-act="undo"][data-step="p4"]').first().click();
	assert.equal((await lastAsk()).text, 'Desfaça o último passo');
	results.focus = 'passed';

	// Buttons ask the agent with ids and the request in words; nothing touches the files.
	await go('state=barbearia&view=cleanup');
	await page.locator('[data-act="fix-all"]').click();
	assert.equal((await lastAsk()).text, 'Aplique as 3 correções');
	await page.locator('[data-act="fix-one"][data-id="duplicates"]').click();
	assert.equal((await lastAsk()).text, 'Aplique a correção duplicates (linhas repetidas)');
	await go('state=barbearia&view=cleanup&scanned=0');
	await page.locator('[data-act="scan"]').first().click();
	assert.equal((await lastAsk()).text, 'Procure problemas nos dados');
	await go('state=limpa&view=cleanup');
	await page.locator('[data-act="undo"][data-step="p2"]').first().click();
	assert.equal((await lastAsk()).text, 'Desfaça o passo p2 (Gravar valor como R$ moeda)');
	await page.locator('[data-act="undo-all"]').click();
	assert.equal((await lastAsk()).text, 'Desfaça todos os passos da limpeza');
	await page.locator('[data-act="redo-all"]').click();
	assert.match((await lastAsk()).text, /^Refaça com a visão limpa os gráficos g7, g6, g5, g4, g3, g2 e g1: g7 \(contagem de linhas por mês de data e por origem, em colunas 100%, título "De onde vêm os agendamentos"\); /);

	await go('state=barbearia&view=charts&sel=g2');
	await page.locator('svg rect[data-act="bar"][data-i="0"]').dispatchEvent('click');
	assert.equal((await lastAsk()).text, 'Filtre a tabela: serviço = Corte e barba e status = concluído');
	await page.locator('select[data-act="kind"]').selectOption('line');
	assert.equal((await lastAsk()).text, 'Refaça o gráfico g2 como linhas: soma de valor por serviço, só onde status = concluído, com o título "Faturamento por serviço"');
	await page.locator('[data-act="chart-ask"][data-id="g2"]').click();
	ask = await lastAsk();
	assert.deepEqual([ask.text, ask.send], ['Sobre o gráfico g2 (Faturamento por serviço): ', false]);

	await go('state=barbearia&view=charts&sel=g1');
	await page.locator('[data-act="export-open"][data-id="g1"]').click();
	await page.waitForSelector('.ss-dlg');
	await page.locator('[data-act="export-go"]').click();
	assert.equal((await lastAsk()).text, 'Exporte o gráfico g1 em SVG');
	await page.locator('[data-act="export-open"][data-id="g1"]').click();
	await page.locator('input[data-key="csv"]').check();
	await page.locator('[data-act="export-go"]').click();
	assert.equal((await lastAsk()).text, 'Exporte o gráfico g1 em SVG e os dados da aba em CSV');

	await go('state=limpa&view=charts&sel=g1');
	await page.locator('.ss-strip [data-act="redo"]').click();
	assert.equal((await lastAsk()).text, 'Refaça o gráfico g1 com a visão limpa: soma de valor por mês de data, só onde status = concluído, em barras, com o título "Faturamento por mês"');

	await go('state=limpa&view=sheet');
	await page.locator('[data-act="filter-x"]').click();
	assert.equal((await lastAsk()).text, 'Mostre todas as linhas da tabela, sem filtro');
	await page.locator('[data-act="more-rows"]').click();
	assert.equal((await lastAsk()).text, 'Mostre as próximas 500 linhas da tabela, a partir da 501ª, com o filtro serviço = Corte e barba');
	await page.locator('.ss-sheets [data-act="sheet-tab"][data-name="Preços"]').click();
	assert.equal((await lastAsk()).text, 'Abra a aba Preços da planilha dados/atendimentos-2026.xlsx');

	await go('state=limpa&view=settings');
	await page.locator('select[data-key="decimal"]').selectOption('dot');
	await page.locator('select[data-key="gridRows"]').selectOption('1000');
	await page.locator('[data-act="set-save"]').click();
	assert.equal((await lastAsk()).text, 'Mude as configurações do SheetStudio: decimal . ponto (dot) e 1.000 linhas na planilha');

	await go('state=limpa&view=history');
	await page.locator('tr[data-act="hist"]:has-text("faça um gráfico do faturamento por mês")').click();
	await page.locator('.ss-panel.mk-you [data-act="redo"]').click();
	assert.match((await lastAsk()).text, /^Refaça o gráfico g1 com a visão limpa: soma de valor por mês de data/);
	const posted = await page.evaluate(() => window.__posted.filter(m => !['ask', 'ready'].includes(m.type)).map(m => m.type));
	assert.deepEqual(posted, [], 'the interface only sends ready and ask');
	results.asks = 'passed';

	// A CSV can be opened as text in the editor; while a file is read, Parar stops the agent's request.
	await go('state=barbearia&view=sheet');
	await sendFiles(30, 'sheet', null, '', { path: 'dados/atendimentos-2026.csv', name: 'atendimentos-2026.csv', format: 'csv', meta: { separator: ';', encoding: 'cp1252', warnings: [] } });
	await page.locator('[data-act="open-editor"]').click();
	assert.deepEqual(await page.evaluate(() => window.__posted.at(-1)), { type: 'openFile', path: 'dados/atendimentos-2026.csv' });
	assert.match(await page.locator('.ss-panel:has-text("Arquivo") .ss-kv').last().innerText(), /Windows-1252/);
	await page.locator('select[data-act="csv-opt"][data-key="separator"]').selectOption(',');
	await page.locator('[data-act="csv-header"]').uncheck();
	await page.locator('[data-act="csv-reopen"]').click();
	assert.equal((await lastAsk()).text, 'Abra de novo a planilha dados/atendimentos-2026.csv com separador "," e sem cabeçalho (header false)');
	await go('state=importing');
	// The compact toolbar may hide its duplicate status; the import panel keeps visible progress.
	assert.match(await page.locator('.ss-main').innerText(), /68%/);
	assert.match(await page.locator('.ss-main .ss-prog i').getAttribute('style'), /width:68%/);
	await page.locator('[data-act="stop"]').click();
	assert.deepEqual(await page.evaluate(() => window.__posted.at(-1)), { type: 'stop' });
	assert.equal(await asksSent(), 0, 'stopping is not an ask');
	results.hostMessages = 'passed';

	// Backend revisions survive undo and reimport; IDs of surviving steps are not revisions.
	await go('state=barbearia&view=charts');
	const injectChart = async (kind, chartVersion, sheetVersion, values = [20, -10]) => page.evaluate(async ([kind, chartVersion, sheetVersion, values]) => {
		const files = window.SS_LIVE();
		const sheet = JSON.parse(files['sheet.json']);
		sheet.version = sheetVersion;
		sheet.steps = [];
		sheet.basis = 'raw';
		files['sheet.json'] = JSON.stringify(sheet);
		const chart = JSON.parse(files['charts.json']).charts[0];
		Object.assign(chart, { id: 'regression', kind, labels: ['Positivo', 'Negativo'], series: [{ name: 'Saldo', values }], unit: 'number', total: values.reduce((sum, value) => sum + value, 0) });
		chart.calc.basis = 'raw';
		chart.calc.steps = chartVersion;
		files['charts.json'] = JSON.stringify({ schema: 1, charts: [chart], dashboard: null });
		files['view.json'] = JSON.stringify({ schema: 1, revision: Date.now(), view: 'charts', select: chart.id });
		window.dispatchEvent(new MessageEvent('message', { data: { type: 'files', files } }));
		// The Studio batches incoming files into the next frame; inspect the updated DOM.
		await new Promise(resolve => requestAnimationFrame(resolve));
	}, [kind, chartVersion, sheetVersion, values]);
	await injectChart('bar', 3, 3);
	assert.doesNotMatch(await page.locator('.ss-main').innerText(), /visão anterior/);
	await injectChart('bar', 2, 3);
	assert.match(await page.locator('.ss-main').innerText(), /visão anterior/);
	results.revisions = 'passed';

	// Negative bars must have visible geometry and lie on opposite sides of zero.
	for (const kind of ['hbar', 'bar', 'stacked', 'stacked100']) {
		await injectChart(kind, 3, 3);
		const marks = await page.locator('.ss-main svg rect[fill]:not([fill="transparent"])').evaluateAll(nodes => nodes.map(n => ({
			x: Number(n.getAttribute('x')), y: Number(n.getAttribute('y')),
			width: Number(n.getAttribute('width')), height: Number(n.getAttribute('height'))
		})));
		assert.equal(marks.length, 2, `${kind}: positive and negative marks`);
		assert.ok(marks.every(m => m.width > 0 && m.height > 0 && Object.values(m).every(Number.isFinite)), `${kind}: nonempty finite geometry`);
		if (kind === 'hbar') {
			assert.ok(marks[1].x < marks[0].x && Math.abs(marks[1].x + marks[1].width - marks[0].x) <= 1, 'negative bar ends at zero');
		} else {
			assert.ok(marks[1].y > marks[0].y, `${kind}: negative bar below positive bar`);
		}
	}
	results.negativeValues = 'passed';

	// Display formatting must not turn nonzero measurements into zero or collapse their axis ticks.
	await injectChart('bar', 3, 3, [0.00003, 0.00004]);
	const smallText = await page.locator('.ss-main').innerText();
	assert.match(smallText, /0,00003/);
	assert.match(smallText, /0,00004/);
	assert.match(smallText, /0,00007/);
	await injectChart('bar', 3, 3, [1e-9, -2e-9]);
	const tinyAxis = await page.locator('.ss-main svg .tk').allTextContents();
	assert.ok(tinyAxis.some(t => t.includes('e-9')), 'tiny axis retains nonzero tick labels');
	const tinyMarks = await page.locator('.ss-main svg rect[fill]:not([fill="transparent"])').evaluateAll(nodes => nodes.map(n => Number(n.getAttribute('height'))));
	assert.ok(tinyMarks.length === 2 && tinyMarks.every(h => h > 1), 'tiny signed values remain visible bars');
	results.smallValues = 'passed';

	assert.deepEqual(errors, []);
	console.log(JSON.stringify({ size: process.env.SS_SIZE || '1075x724@1.25', ...results, scriptErrors: errors }));
} finally {
	await browser.close();
	await new Promise(resolve => server.close(resolve));
}
