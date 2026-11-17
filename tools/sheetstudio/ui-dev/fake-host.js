/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Dev only: stands in for the JumpCode host. It feeds the interface the real files scenario.py saved
// (window.SS_FIXTURES[state]) and records what the interface posts in window.__posted. The scenario runs in about a
// second, so its times are spread (×1500, order kept) and moved so the newest file was written a minute ago.
// Query: state=empty|barbearia|limpa|importing|long, view=sheet|charts|panel|cleanup|history|profile|settings|files,
// sel=<chart id or column>, note=text, project=0, scanned=0 (problems not looked for yet), charts=0 (no charts),
// csv=1 (the open file is the back office's CSV, read with ; and Windows-1252).
(function () {
	'use strict';
	const query = new URLSearchParams(location.search);
	const state = query.get('state') || 'barbearia';
	window.__posted = [];
	const send = message => window.dispatchEvent(new MessageEvent('message', { data: message }));
	const parse = text => JSON.parse(text);

	/** Spreads and moves every epoch-seconds number (row numbers, amounts and byte counts are far from that range). */
	function retime(value, latest, now) {
		if (Array.isArray(value)) {
			return value.map(item => retime(item, latest, now));
		}
		if (value && typeof value === 'object') {
			return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, retime(item, latest, now)]));
		}
		if (typeof value === 'number' && value > 1.7e9 && value < 1.9e9) {
			return now - 60 - (latest - value) * 1500;
		}
		return value;
	}

	function base(name) {
		const source = (window.SS_FIXTURES || {})[name] || {};
		const files = {};
		for (const [file, text] of Object.entries(source)) {
			files[file] = parse(text);
		}
		return files;
	}

	/** An open file being imported: what views.progress_file writes while the rows come in. */
	function importing(files) {
		files['sheet.json'].status = 'importing';
		files['sheet.json'].progress = { path: 'dados/eventos-app-2026.csv', rows: 826000, total: 1214388, seconds: 9.4 };
	}

	/** Long names, paths, labels and numbers, many charts and questions, a protected tab and formula errors. */
	function longValues(files) {
		const sheet = files['sheet.json'];
		const grid = files['grid.json'];
		const charts = files['charts.json'];
		const cleanup = files['cleanup.json'];
		const history = files['history.json'];
		const longPath = 'dados/exportações do sistema antigo/atendimentos-consolidados-janeiro-a-dezembro-2026-versão-final-revisada.xlsx';
		sheet.file.path = longPath;
		sheet.file.name = longPath.split('/').pop();
		sheet.files[0].path = longPath;
		sheet.sheet.name = 'Atendimentos consolidados 2026 (versão final)';
		sheet.sheets[0].name = sheet.sheet.name;
		sheet.sheets.push({ id: 'p1', name: 'Comissões por barbeiro', rows: 13, cols: 5, imported: false, hidden: false, protected: true });
		sheet.sheets.push({ id: 'h1', name: 'Aba escondida com cálculos auxiliares', rows: 40, cols: 3, imported: false, hidden: true, protected: false });
		sheet.file.meta.warnings = ['the workbook has macros; they are not run', 'merged cells A1:C1, D1:F1 in Resumo'];
		const longName = 'nome completo do cliente como está no cadastro';
		for (const column of sheet.columns.concat(grid.columns)) {
			if (column.key === 'c3') { column.name = longName; }
		}
		sheet.found = [];
		for (let i = 0; i < 40; i++) {
			sheet.found.push({ path: `${i % 3 ? 'dados/arquivos recebidos do contador em 2026' : 'financeiro'}/planilha-de-conferência-mensal-número-${i + 1}-com-nome-bem-comprido.${['xlsx', 'csv', 'ods', 'xls', 'tsv'][i % 5]}`, bytes: 1000 * (i + 1) * 977, modified: sheet.updatedAt - i * 0.01 });
		}
		sheet.found.unshift({ path: longPath, bytes: 179012, modified: sheet.updatedAt });
		grid.file = longPath;
		grid.sheetName = sheet.sheet.name;
		grid.filter = ['serviço = Corte degradê com navalha e barba completa com toalha quente', 'status = concluído', 'valor > 50'];
		grid.matched = 12;
		grid.rows = grid.rows.slice(0, 12);
		grid.rows[0][3] = 'Maria Aparecida dos Santos Oliveira Cavalcanti de Albuquerque Figueiredo';
		grid.rows[0][4] = 'Corte degradê com navalha e barba completa com toalha quente';
		for (const row of grid.rows.slice(1, 4)) {
			row[6] = null;
			grid.notes[String(row[0])] = { ...(grid.notes[String(row[0])] || {}), c6: ['error', '#REF!', '#REF!'] };
		}
		const g2 = charts.charts.find(c => c.id === 'g2');
		g2.labels = g2.labels.map((label, i) => i === 0 ? 'Corte degradê com navalha e barba completa com toalha quente' : label);
		g2.title = 'Faturamento por serviço, só dos atendimentos concluídos de janeiro a outubro de 2026';
		const copies = [];
		for (let i = 0; i < 14; i++) {
			const copy = JSON.parse(JSON.stringify(charts.charts[i % 7]));
			copy.id = `g${30 + i}`;
			copy.title = `${copy.title} — refeito com outra pergunta bem mais comprida, número ${i + 1}`;
			copies.push(copy);
		}
		charts.charts.unshift({
			id: 'g99', created: charts.updatedAt, kind: 'query', title: 'Clientes que mais gastaram em corte e barba com o Zé no segundo semestre',
			x: { column: null }, y: { agg: null }, labels: [], series: [], unit: 'number', total: null, question: 'quem são os clientes que mais gastaram com o Zé no segundo semestre, só corte e barba?',
			table: { columns: ['nome completo do cliente como está no cadastro', 'atendimentos', 'total gasto', 'ticket médio'], rows: [['Maria Aparecida dos Santos Oliveira Cavalcanti de Albuquerque Figueiredo', 18, 1260.0, 70.0], ['Rodrigo Pinto', 15, 1050.0, 70.0], ['Igor Souza', 14, 980.0, 70.0], ['Guilherme Alves', 12, 840.0, 70.0], [null, 9, 630.0, 70.0]], truncated: true, basis: 'raw' },
			calc: { basis: 'raw', steps: 0, rowsTotal: 4809, rowsUsed: 5, rowsMatched: 5, excluded: [], filter: [], sql: 'SELECT "nome completo do cliente como está no cadastro", COUNT(*) AS atendimentos, SUM(valor) AS "total gasto", ROUND(AVG(valor), 2) AS "ticket médio" FROM dados WHERE barbeiro = \'Zé\' AND serviço = \'Corte e barba\' AND data >= \'2026-07-01\' GROUP BY 1 ORDER BY 3 DESC LIMIT 5', readable: 'Consulta SQL: 5 linhas de resultado.' },
			sheet: sheet.sheet.id, file: sheet.file.id, fileName: longPath, sheetName: sheet.sheet.name, spec: {},
		});
		charts.charts = charts.charts.concat(copies);
		charts.dashboard.title = 'Painel para o Zé mostrar ao contador e aos sócios na reunião de fim de ano';
		charts.dashboard.numbers = charts.dashboard.numbers.concat([
			{ title: 'Faturamento projetado para o ano inteiro de 2026', value: 12345678.9, unit: 'currency', note: 'Soma de valor, só onde status = concluído e origem = App e pagamento = Pix: 4.317 de 4.809 linhas.' },
			{ title: 'Parte do Pix', value: 0.3356, unit: 'percent', note: 'Média de parte do pix por mês.' },
		]);
		cleanup.problems.push({ id: 'error:valor:#REF!', kind: 'error', title: 'Células com #REF!', column: 'valor', count: 3, examples: [{ row: 3, before: '#REF!', formula: '=SOMA(#REF!F2:F212)*0,4' }, { row: 4, before: '#REF!', formula: null }], explain: 'a fórmula aponta para uma célula ou aba que foi apagada', proposal: 'ficam vazias nas contas; o certo é corrigir a fórmula no arquivo original', fix: null, applied: null });
		cleanup.problems.push({ id: 'spelling:serviço', kind: 'spelling', title: 'O mesmo valor escrito de jeitos diferentes', column: 'serviço', count: 31, examples: [{ before: 'corte e barba ', after: 'Corte e barba' }, { before: 'Corte degradê com navalha e barba completa com toalha quente', after: 'Corte degradê com navalha e barba completa' }], proposal: 'usar a grafia mais comum de cada um', fix: { kind: 'unify' }, applied: null });
		cleanup.fine.push({ column: longName, count: 1234, text: `1234 ${longName} vazios são exatamente as linhas com origem 1000 Balcão e 234 WhatsApp sem cadastro no aplicativo`, by: 'origem', exact: true });
		const extra = [];
		for (let i = 0; i < 24; i++) {
			extra.push({ ...history.entries[i % history.entries.length], question: i % 2 ? `pergunta longa número ${i + 1}: quanto o Zé faturou com corte degradê com navalha e barba completa nas sextas à tarde, comparando com o mesmo período do ano passado?` : null, at: history.entries[i % history.entries.length].at - 1 - i * 0.01 });
		}
		history.entries = history.entries.concat(extra);
	}

	function files() {
		const name = state === 'importing' ? 'empty' : state === 'long' ? 'barbearia' : state;
		const out = base(name);
		if (state === 'importing') {
			importing(out);
		}
		if (state === 'long') {
			longValues(out);
		}
		if (query.get('csv') === '1' && out['sheet.json']?.file) {
			// The same sheet as if the back office's CSV had been opened (what the CSV reader records in meta).
			const sheet = out['sheet.json'];
			Object.assign(sheet.file, { path: 'dados/atendimentos-2026.csv', name: 'atendimentos-2026.csv', format: 'csv', bytes: 67160, meta: { encoding: 'cp1252', separator: ';', quote: '"', lineEnding: '\r\n', warnings: ["the first line 'sep=;' is an Excel hint and was skipped"] } });
			sheet.sheets = [{ ...sheet.sheets[0], name: 'atendimentos-2026' }];
			sheet.sheet.name = 'atendimentos-2026';
			out['grid.json'].file = sheet.file.path;
		}
		if (query.get('scanned') === '0' && out['cleanup.json']) {
			Object.assign(out['cleanup.json'], { scanned: false, problems: [], fine: [] });
		}
		if (query.get('charts') === '0' && out['charts.json']) {
			Object.assign(out['charts.json'], { charts: [], dashboard: null });
		}
		const latest = Math.max(...Object.values(out).map(f => f.updatedAt || 0));
		const now = Date.now() / 1000;
		const moved = {};
		for (const [file, value] of Object.entries(out)) {
			moved[file] = JSON.stringify(latest ? retime(value, latest, now) : value);
		}
		const view = out['view.json'] || {};
		const wanted = query.get('view');
		moved['view.json'] = JSON.stringify({ schema: 1, revision: 1, view: wanted || view.view || 'sheet', select: query.get('sel') || (wanted ? null : view.select || null), note: query.get('note') || '' });
		return moved;
	}

	window.SS_LIVE = files;
	window.acquireVsCodeApi = () => ({
		postMessage(message) {
			window.__posted.push(message);
			if (message.type === 'ready') {
				setTimeout(() => {
					send({ type: 'init', context: { tool: 'sheetstudio', project: query.get('project') !== '0', source: query.get('project') === '0' ? null : 'barbearia-do-ze', sourceKind: query.get('project') === '0' ? null : 'project', sourceRevision: 1 } });
					send({ type: 'files', files: files(), revision: 1 });
					send({ type: 'running', running: false, executions: [], requests: [] });
				}, 0);
			}
		},
		getState() { return undefined; },
		setState() { },
	});
})();
