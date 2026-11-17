/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Dev only: sample Studio files for the TaskStudio interface, built relative to the current time
// so the timeline "now" line and the relative times look right. window.TS_SAMPLE.build(state)
// returns { files, running, saved } for one screen of the approved mockups.
(function () {
	const NOW = Date.now();
	/** Minute m of a 14:00 clock where "now" is 14:38 (as in the mockups). */
	const T = (m, now = 38) => new Date(NOW - (now - m) * 60000).toISOString().replace(/\.\d+Z$/, 'Z');
	const clone = v => JSON.parse(JSON.stringify(v));

	const PIX = {
		id: 'g1', kind: 'secret', label: 'Chave Pix de teste (sandbox)', met: false, env: 'PIX_KEY',
		where: 'No painel do seu banco ou do gateway (Mercado Pago, Efí, Asaas), em Integrações › Pix › Credenciais de teste.',
		alternatives: ['Deixar o Pix para depois e testar sem pagamento', 'Usar um pagamento simulado'],
	};
	const WHATS = {
		id: 'g1', kind: 'secret', label: 'Token do WhatsApp', met: false, env: 'WHATSAPP_TOKEN',
		where: 'No Meta for Developers, em WhatsApp › Configuração da API › Token de acesso temporário.',
		alternatives: ['Mandar o lembrete por e-mail por enquanto'],
	};
	const OK = { id: 'g1', kind: 'approval', label: 'Aprovação', met: false, where: 'Confira o site de testes antes de aprovar a publicação.', alternatives: [] };

	const BASE = [
		{ id: '1', title: 'Entender o pedido', summary: 'Telas, regras de horário e pagamento', detail: 'Ler o pedido e listar as telas, as regras de horário (funcionamento, pausas e duração de cada serviço) e como o pagamento funciona.', deps: [], area: 'Planejamento', estimate: 2, criteria: ['Lista de telas', 'Regras de horário escritas', 'Forma de pagamento definida'] },
		{ id: '2', title: 'Criar o projeto', summary: 'Next.js, API em Node e PostgreSQL', detail: 'Criar o projeto Next.js com TypeScript, a API em Node e o banco PostgreSQL local, com o servidor de desenvolvimento rodando.', deps: ['1'], area: 'Planejamento', estimate: 3, criteria: ['npm run dev abre a página inicial'] },
		{ id: '3', title: 'Modelar o banco', summary: 'Clientes, barbeiros, serviços, horários', detail: 'Criar as tabelas de clientes, barbeiros, serviços e horários. Cada agendamento tem um serviço, com preço e duração.', deps: ['2'], area: 'Banco de dados', estimate: 4, criteria: ['Tabelas criadas com chaves e índices', 'Migração inicial aplicada'] },
		{ id: '4', title: 'Login de clientes', summary: 'Cadastro e entrada por e-mail', detail: 'Cadastro com nome, telefone e e-mail, entrada por link mágico no e-mail e sessão de 30 dias.', deps: ['2'], area: 'Servidor', estimate: 6, criteria: ['Cadastro e entrada funcionam', 'Sessão expira em 30 dias'] },
		{ id: '5', title: 'API de horários', summary: 'Horários livres de cada barbeiro', detail: 'Rota GET /horarios-livres que recebe o barbeiro, o dia e o serviço e devolve os horários livres, respeitando pausas e agendamentos existentes.', deps: ['3'], area: 'Servidor', estimate: 5, criteria: ['Não oferece horário já ocupado', 'Respeita o horário de funcionamento'] },
		{ id: '6', title: 'Tela de agendamento', summary: 'Escolher serviço, dia e horário', detail: 'O cliente escolhe o serviço, o barbeiro, o dia e um horário livre, e confirma. Só aparecem horários que a #5 API diz estarem livres.', deps: ['4', '5'], area: 'Telas', estimate: 6, criteria: ['Mostra só horários livres', 'Bloqueia dias e horas que já passaram', 'Funciona bem no celular'] },
		{ id: '7', title: 'Pagamento por Pix', summary: 'Cobrança e confirmação automática', detail: 'Gerar a cobrança Pix no ambiente de testes do gateway e confirmar o agendamento quando o pagamento chegar.', deps: ['5'], area: 'Integrações', estimate: 5, criteria: ['Cobrança de teste criada', 'Agendamento confirmado após o pagamento'], gates: [PIX] },
		{ id: '8', title: 'Lembrete no WhatsApp', summary: 'Aviso 2 horas antes do horário', detail: 'Enviar um aviso pelo WhatsApp 2 horas antes do horário, com link para remarcar.', deps: ['6'], area: 'Integrações', estimate: 4, criteria: ['Mensagem enviada 2 horas antes'], gates: [WHATS] },
		{ id: '9', title: 'Painel do barbeiro', summary: 'Agenda do dia e bloqueio de horários', detail: 'Página com a agenda do dia de cada barbeiro, com os clientes e os serviços de cada horário, e um botão para bloquear horários.', deps: ['4', '5'], area: 'Telas', estimate: 7, criteria: ['Mostra a agenda do dia', 'Bloqueia um horário'] },
		{ id: '10', title: 'Testes de ponta a ponta', summary: 'Agendar, pagar e receber o lembrete', detail: 'Testes automáticos do fluxo: agendar, pagar, receber o lembrete e ver no painel. 8 cenários.', deps: ['7', '8', '9'], area: 'Qualidade e publicação', estimate: 6, criteria: ['Os 8 cenários passam'] },
		{ id: '11', title: 'Publicar o site', summary: 'Deploy na Vercel com o seu domínio', detail: 'Publicar o site e o banco em produção na Vercel e apontar o domínio da barbearia.', deps: ['10'], area: 'Qualidade e publicação', estimate: 3, criteria: ['Site no ar com HTTPS'], gates: [OK] },
	];

	function task(base) {
		const t = clone(base);
		t.criteria = (t.criteria ?? []).map(text => ({ text, done: false }));
		t.gates = t.gates ?? [];
		t.state = 'todo';
		t.log = [];
		t.files = [];
		t.problem = null;
		return t;
	}

	function done(t, from, to, result, files) {
		t.state = 'done';
		t.progress = 100;
		t.startedAt = T(from);
		t.finishedAt = T(to);
		t.result = result;
		t.criteria.forEach(c => (c.done = true));
		t.files = (files ?? []).map(path => ({ path, state: 'done' }));
		t.log = [{ at: T(from), text: 'começou', kind: 'info' }, { at: T(to), text: result, kind: 'ok' }];
		return t;
	}

	const DONE_INFO = {
		1: [18, 20, '12 requisitos levantados', []],
		2: [20, 23, 'projeto criado e rodando', ['package.json', 'next.config.js', 'api/server.ts', 'docker-compose.yml']],
		3: [23, 27, '5 tabelas criadas', ['db/migrations/0001_inicial.sql', 'db/schema.ts']],
		4: [23, 29, 'cadastro e entrada por e-mail', ['api/auth.ts', 'app/entrar/page.tsx', 'app/cadastro/page.tsx']],
		5: [27, 32, 'GET /horarios-livres com testes', ['api/horarios.ts', 'api/horarios.test.ts']],
	};

	/** The plan while #6 and #9 run, #7 needs the Pix key and the rest waits (mockup 05). */
	function runningPlan() {
		const tasks = BASE.map(task);
		for (const [id, [a, b, r, f]] of Object.entries(DONE_INFO)) {
			done(tasks[Number(id) - 1], a, b, r, f);
		}
		const t6 = tasks[5];
		Object.assign(t6, { state: 'running', requestId: 'dev-request', progress: 60, now: 'Calendario.tsx', startedAt: T(32) });
		t6.criteria[0].done = true;
		t6.log = [
			{ at: T(32), text: 'começou: ServicoPicker.tsx', kind: 'info' },
			{ at: T(34.5), text: 'criou BarbeiroPicker.tsx', kind: 'info' },
			{ at: T(35.2), text: 'teste: horários livres ✓', kind: 'ok' },
			{ at: T(35.5), text: 'escrevendo Calendario.tsx…', kind: 'info' },
		];
		t6.files = [
			{ path: 'components/ServicoPicker.tsx', state: 'done' },
			{ path: 'components/BarbeiroPicker.tsx', state: 'done' },
			{ path: 'app/agendar/page.tsx', state: 'done' },
			{ path: 'components/Calendario.tsx', state: 'partial' },
		];
		const t9 = tasks[8];
		Object.assign(t9, { state: 'running', requestId: 'dev-request', progress: 25, now: 'tabela da agenda', startedAt: T(33) });
		t9.log = [{ at: T(33), text: 'começou: AgendaDoDia.tsx', kind: 'info' }, { at: T(36), text: 'escrevendo a tabela da agenda…', kind: 'info' }];
		t9.files = [{ path: 'app/painel/page.tsx', state: 'partial' }];
		return plan(tasks, { started: true });
	}

	function plan(tasks, extra = {}) {
		return Object.assign({
			schema: 1, revision: 37, plan: 1, title: 'Barbearia do Zé',
			request: 'Crie um sistema de agendamento para a minha barbearia: site para o cliente marcar horário, pagamento por Pix, lembrete no WhatsApp e um painel para os barbeiros.',
			draft: false, started: false, createdAt: T(17), updatedAt: T(37), tasks, recalibrating: null,
		}, extra);
	}

	function problemPlan() {
		const p = runningPlan();
		const t7 = p.tasks[6];
		t7.gates[0].met = true;
		Object.assign(t7, {
			state: 'failed', startedAt: T(36), progress: 20,
			problem: { title: 'O gateway recusou a chave Pix.', detail: 'A cobrança de teste voltou com erro 401 (não autorizado). Parece ser a chave de produção no lugar da de teste: no ambiente de testes o gateway só aceita a credencial de sandbox.', options: ['Trocar a chave', 'Deixar o agente resolver'], at: T(38) },
			log: [
				{ at: T(36), text: 'começou: criar cobrança de teste', kind: 'info' },
				{ at: T(36.6), text: 'POST /v2/cob → 401 Unauthorized', kind: 'error' },
				{ at: T(37.4), text: 'de novo, com o certificado .p12 → 401', kind: 'error' },
				{ at: T(37.5), text: '{"error":"invalid_client","description":"credencial de produção usada no ambiente sandbox"}', kind: 'error' },
			],
			files: [{ path: 'api/pix.ts', state: 'partial' }],
		});
		return p;
	}

	const RECAL_TEXT = 'Na verdade, cada agendamento pode ter mais de um serviço, tipo corte e barba juntos.';

	function pausedForRecal(p) {
		for (const i of [5, 8]) {
			p.tasks[i].state = 'paused';
			p.tasks[i].pausedAt = T(37);
			p.tasks[i].log.push({ at: T(37), text: 'pausada para recalibrar o plano', kind: 'info' });
		}
		return p;
	}

	function recalPlan() {
		const p = pausedForRecal(runningPlan());
		p.recalibrating = {
			task: '3', kind: 'done', text: RECAL_TEXT, requestId: 'dev-request',
			before: { title: 'Modelar o banco', summary: p.tasks[2].summary, detail: p.tasks[2].detail },
			after: { detail: 'Criar as tabelas de clientes, barbeiros, serviços e horários. Cada agendamento tem um ou mais serviços (ex.: corte + barba), com preço e duração somados.' },
			at: T(37), paused: ['6', '9'],
			impact: { done: ['5'], running: ['6', '9'], todo: ['7', '8', '10', '11'] },
		};
		return p;
	}

	function proposalFor3() {
		return {
			schema: 1, revision: 3, plan: 2, base: 1, baseRevision: 37,
			states: { 3: 'done', 5: 'done', 6: 'paused', 9: 'paused', 7: 'todo', 8: 'todo', 10: 'todo' },
			cause: { task: '3', text: RECAL_TEXT },
			summary: 'A mudança atinge 7 tarefas: 2 concluídas serão refeitas, 2 que estavam executando serão ajustadas e 3 mudam antes de começar.',
			extra: 14,
			changes: [
				{ task: '3', kind: 'refazer', summary: 'Nova tabela agendamento_servicos', note: 'Nova tabela agendamento_servicos; a coluna servico_id sai de agendamentos.', why: 'sua mudança', detail: 'Criar as tabelas de clientes, barbeiros, serviços e horários. Cada agendamento tem um ou mais serviços (ex.: corte + barba), com preço e duração somados.' },
				{ task: '5', kind: 'refazer', summary: 'Duração = soma dos serviços', note: 'A duração do horário passa a ser a soma dos serviços escolhidos.', why: 'usa #3' },
				{ task: '6', kind: 'ajustar', summary: 'Escolher vários serviços', note: 'Permitir escolher mais de um serviço. 3 dos 4 arquivos já feitos mudam.', why: 'pausada' },
				{ task: '9', kind: 'ajustar', summary: 'Mostrar todos os serviços', note: 'Mostrar todos os serviços de cada horário.', why: 'pausada' },
				{ task: '7', kind: 'alterar', summary: 'Cobrar o total dos serviços', note: 'Cobrar o valor total dos serviços.', why: 'usa #5' },
				{ task: '8', kind: 'alterar', summary: 'Lembrete lista os serviços', note: 'A mensagem lista os serviços marcados.', why: 'usa #6' },
				{ task: '10', kind: 'alterar', summary: '+2 cenários com vários serviços', note: '+2 cenários: corte + barba e troca de serviço.', why: 'usa #6' },
			],
			createdAt: T(38),
		};
	}

	function proposalFor8() {
		return {
			schema: 1, revision: 4, plan: 2, base: 1, baseRevision: 40,
			states: { 3: 'done', 4: 'done', 8: 'todo', 10: 'todo' },
			cause: { task: '8', text: 'O lembrete também deveria ir por SMS, não só WhatsApp.' },
			summary: 'A mudança atinge 4 tarefas, incluindo 2 já concluídas.',
			extra: 5,
			changes: [
				{ task: '3', kind: 'refazer', summary: 'Coluna canal_lembrete', note: 'Nova coluna canal_lembrete em clientes.', why: '~2 min' },
				{ task: '4', kind: 'refazer', summary: 'Opção de canal no cadastro', note: 'Cadastro pergunta por onde o cliente quer ser lembrado.', why: '~3 min' },
				{ task: '8', kind: 'alterar', title: 'Lembrete por WhatsApp e SMS', summary: 'Envia pelo canal escolhido', note: 'Envia pelo canal escolhido. Nova condição: conta de SMS.', why: 'sua mudança' },
				{ task: '10', kind: 'alterar', summary: '+1 cenário de SMS', note: '+1 cenário: lembrete por SMS.', why: 'usa #8' },
			],
			createdAt: T(38),
		};
	}

	function snapshot(tasks, titles = {}) {
		return tasks.map(t => ({ id: t.id, title: titles[t.id] ?? t.title, summary: t.summary, state: 'todo', deps: t.deps, estimate: t.estimate }));
	}

	function history(n = 3) {
		const v = [
			{ plan: 1, at: T(18), reason: 'Plano inicial', cause: null, changes: [], tasks: snapshot(BASE) },
			{
				plan: 2, at: T(41, 55), reason: 'Vários serviços por agendamento', cause: { task: '3', text: RECAL_TEXT }, extra: 14,
				changes: proposalFor3().changes.map(c => ({ task: c.task, kind: c.kind, note: c.note })), tasks: snapshot(BASE),
			},
			{
				plan: 3, at: T(52, 55), reason: 'Lembrete por SMS', cause: { task: '8', text: 'O lembrete também deveria ir por SMS, não só WhatsApp.' }, extra: 5,
				changes: [
					{ task: '3', kind: 'refazer', note: 'coluna canal_lembrete em clientes' },
					{ task: '4', kind: 'refazer', note: 'cadastro pergunta o canal preferido' },
					{ task: '8', kind: 'alterar', note: 'envia pelo canal escolhido; nova condição: conta de SMS' },
					{ task: '10', kind: 'alterar', note: '+1 cenário de SMS' },
				],
				tasks: snapshot(BASE, { 8: 'Lembrete por WhatsApp e SMS' }),
			},
		];
		return { schema: 1, revision: n, versions: v.slice(0, n) };
	}

	function finishedPlan() {
		const tasks = BASE.map(task);
		const times = { 1: [5, 7], 2: [7, 10], 3: [10, 14], 4: [10, 16], 5: [14, 19], 6: [19, 27], 9: [20, 29], 7: [27, 34], 8: [27, 32], 10: [34, 41], 11: [41, 44] };
		const results = { 1: '12 requisitos levantados', 2: 'Projeto criado e rodando', 3: 'Banco com vários serviços por agendamento', 4: 'Cadastro com o canal de lembrete', 5: 'Horários livres com a soma dos serviços', 6: 'Site de agendamento', 7: 'Pagamento por Pix (sandbox)', 8: 'Lembrete por WhatsApp e SMS', 9: 'Painel do barbeiro', 10: '11 cenários de teste passando', 11: 'Site no ar em barbeariadoze.com.br' };
		for (const t of tasks) {
			const [a, b] = times[t.id];
			done(t, a, b, results[t.id], [`src/tarefa-${t.id}.ts`, `src/tarefa-${t.id}.test.ts`]);
			t.startedAt = T(a, 48);
			t.finishedAt = T(b, 48);
			t.gates.forEach(g => (g.met = true));
		}
		tasks[7].title = 'Lembrete por WhatsApp e SMS';
		tasks[7].mark = { plan: 3, kind: 'alterar', note: 'Envia pelo canal escolhido.' };
		tasks[2].mark = { plan: 3, kind: 'refazer', note: 'Coluna canal_lembrete.' };
		tasks[6].log.push({ at: T(31, 48), text: 'POST /v2/cob → 401 (chave de produção)', kind: 'error' });
		return plan(tasks, { started: true, plan: 3, revision: 71 });
	}

	function draftPlan() {
		const tasks = BASE.slice(0, 7).map(task);
		return plan(tasks, { draft: true, revision: 6 });
	}

	// A 38-task plan for a network of barbershops, grouped by phase (mockup 24).
	function bigPlan() {
		const phases = [
			['Fase 1 · Base da rede', ['Entender a rede', 'Conta da rede', 'Cadastro de donos', 'Papéis e permissões', 'Banco multiunidade', 'Login único', 'Logs e auditoria', 'Backup diário']],
			['Fase 2 · Várias unidades', ['Tabela de unidades', 'Barbeiro por unidade', 'Escolher a unidade', 'Horários por unidade', 'Preço por unidade', 'Migrar a barbearia atual', 'Endereço e mapa', 'Fotos da unidade', 'Feriados por unidade']],
			['Fase 3 · Relatórios para o dono', ['Painel do dono', 'Faturamento por unidade', 'Ocupação dos barbeiros', 'Clientes que voltam', 'Exportar planilha', 'Relatório semanal', 'Metas por unidade']],
			['Fase 4 · App do cliente', ['Contas nas lojas', 'App: entrar', 'App: agendar', 'App: pagar', 'App: lembretes', 'App: histórico', 'App: favoritos', 'Notificações', 'Publicar nas lojas']],
			['Fase 5 · Testes e publicação', ['Testes da rede', 'Testes do app', 'Carga de dados', 'Treinar os donos', 'Publicar a rede']],
		];
		const tasks = [];
		let id = 1;
		const first = [];
		phases.forEach(([phase, titles], pi) => {
			first[pi] = id;
			titles.forEach((title, i) => {
				const t = task({ id: String(id), title, summary: `${title} da rede de barbearias`, detail: `${title}: parte da ${phase.toLowerCase()}.`, deps: [], area: ['Planejamento', 'Banco de dados', 'Servidor', 'Telas', 'Qualidade e publicação'][pi], estimate: 4 + ((id * 7) % 9) });
				t.phase = phase;
				tasks.push(t);
				id++;
			});
		});
		const dep = (a, b) => tasks[b - 1].deps.push(String(a));
		for (let i = 2; i <= 8; i++) {
			dep(i - 1 > 1 ? 1 : 1, i);
		}
		for (let i = 9; i <= 17; i++) {
			dep(i <= 11 ? 5 : 9, i);
		}
		dep(10, 13);
		dep(11, 14);
		for (let i = 18; i <= 24; i++) {
			dep(i === 18 ? 13 : 18, i);
		}
		dep(9, 25);
		for (let i = 26; i <= 33; i++) {
			dep(i === 26 ? 13 : 26, i);
		}
		dep(25, 33);
		for (let i = 34; i <= 38; i++) {
			dep(i < 36 ? 24 : 33, i);
		}
		dep(34, 38);
		for (let i = 1; i <= 8; i++) {
			done(tasks[i - 1], 1 + i, 3 + i, 'feito');
		}
		for (const i of [9, 10, 15, 16]) {
			done(tasks[i - 1], 12, 16, 'feito');
		}
		Object.assign(tasks[10], { state: 'running', requestId: 'dev-request', progress: 40, now: 'seletor de unidade', startedAt: T(30) });
		Object.assign(tasks[11], { state: 'running', requestId: 'dev-request', progress: 15, now: 'regras por unidade', startedAt: T(34) });
		tasks[24].gates = [{ id: 'g1', kind: 'secret', label: 'Conta da Apple e do Google', met: false, env: 'APP_STORE_KEY', where: 'Crie as contas de desenvolvedor na App Store Connect e no Google Play Console.', alternatives: [] }];
		tasks[24].deps = ['9'];
		return Object.assign(plan(tasks, { started: true, revision: 120 }), { title: 'Rede de barbearias' });
	}

	const EDIT_3 = { id: '3', title: 'Modelar o banco', origTitle: 'Modelar o banco', origDetail: BASE[2].detail, detail: 'Criar as tabelas de clientes, barbeiros, serviços e horários. Cada agendamento tem um ou mais serviços (ex.: corte + barba), com preço e duração somados.', stoppedAt: null };
	const EDIT_6 = { id: '6', title: 'Tela de agendamento', origTitle: 'Tela de agendamento', origDetail: BASE[5].detail, detail: 'O cliente escolhe o serviço, o barbeiro, o dia e um horário livre, e confirma. Se escolher “qualquer barbeiro”, mostrar o primeiro horário livre de todos. Só aparecem horários que a #5 API diz estarem livres.', stoppedAt: NOW - 2 * 60000 };
	const EDIT_8 = { id: '8', title: 'Lembrete por WhatsApp e SMS', origTitle: 'Lembrete no WhatsApp', origDetail: BASE[7].detail, detail: 'Enviar um aviso 2 horas antes do horário, pelo canal que o cliente escolheu no cadastro (WhatsApp, SMS ou os dois), com link para remarcar.', stoppedAt: null };

	const STATES = {
		empty: () => ({ files: {}, running: false }),
		planning: () => ({ files: { 'plan.json': draftPlan() }, running: true }),
		building: () => ({ files: {}, running: true }),
		ready: () => ({ files: { 'plan.json': plan(BASE.map(task)), 'history.json': history(1) }, running: false }),
		running: () => ({ files: { 'plan.json': runningPlan(), 'history.json': history(1) }, running: true }),
		details: () => ({ files: { 'plan.json': runningPlan(), 'history.json': history(1) }, running: true, saved: { sel: '6' } }),
		view: () => ({ files: { 'plan.json': runningPlan(), 'history.json': history(1), 'view.json': { schema: 1, revision: 4, select: '6', mode: 'map', note: 'Abri os detalhes da tarefa #6 à direita.' } }, running: true }),
		gate: () => ({ files: { 'plan.json': runningPlan(), 'history.json': history(1) }, running: true, saved: { sel: '7' } }),
		problem: () => ({ files: { 'plan.json': problemPlan(), 'history.json': history(1) }, running: true, saved: { sel: '7' } }),
		'edit-done': () => ({ files: { 'plan.json': runningPlan(), 'history.json': history(1) }, running: true, saved: { sel: '3', edit: EDIT_3 } }),
		recalibrating: () => ({ files: { 'plan.json': recalPlan(), 'history.json': history(1) }, running: true }),
		proposal: () => ({ files: { 'plan.json': pausedForRecal(runningPlan()), 'history.json': history(1), 'proposal.json': proposalFor3() }, running: false }),
		compare: () => ({ files: { 'plan.json': pausedForRecal(runningPlan()), 'history.json': history(1), 'proposal.json': proposalFor3() }, running: false, saved: { mode: 'compare' } }),
		'edit-running': () => ({ files: { 'plan.json': runningPlan(), 'history.json': history(1) }, running: false, saved: { sel: '6', edit: EDIT_6 } }),
		'edit-todo': () => ({ files: { 'plan.json': runningPlan(), 'history.json': history(1) }, running: true, saved: { sel: '8', edit: EDIT_8 } }),
		'proposal-done': () => ({ files: { 'plan.json': runningPlan(), 'history.json': history(1), 'proposal.json': proposalFor8() }, running: true }),
		finished: () => ({ files: { 'plan.json': finishedPlan(), 'history.json': history(3) }, running: false }),
		list: () => ({ files: { 'plan.json': runningPlan(), 'history.json': history(1) }, running: true, saved: { mode: 'list', sel: '6' } }),
		board: () => ({ files: { 'plan.json': problemPlan(), 'history.json': history(1) }, running: true, saved: { mode: 'board' } }),
		timeline: () => ({ files: { 'plan.json': problemPlan(), 'history.json': history(1) }, running: true, saved: { mode: 'timeline' } }),
		lanes: () => ({ files: { 'plan.json': runningPlan(), 'history.json': history(1) }, running: true, saved: { mode: 'lanes' } }),
		metro: () => ({ files: { 'plan.json': runningPlan(), 'history.json': history(1) }, running: true, saved: { mode: 'metro' } }),
		focus: () => ({ files: { 'plan.json': runningPlan(), 'history.json': history(1) }, running: true, saved: { mode: 'focus' } }),
		history: () => ({ files: { 'plan.json': Object.assign(runningPlan(), { plan: 3 }), 'history.json': history(3) }, running: true, saved: { mode: 'history' } }),
		big: () => ({ files: { 'plan.json': bigPlan() }, running: true }),
		'big-list': () => ({ files: { 'plan.json': bigPlan() }, running: true, saved: { mode: 'list' } }),
		'big-board': () => ({ files: { 'plan.json': bigPlan() }, running: true, saved: { mode: 'board' } }),
		'big-timeline': () => ({ files: { 'plan.json': bigPlan() }, running: true, saved: { mode: 'timeline' } }),
		'big-lanes': () => ({ files: { 'plan.json': bigPlan() }, running: true, saved: { mode: 'lanes' } }),
		paused: () => ({ files: { 'plan.json': runningPlan(), 'history.json': history(1) }, running: false }),
	};

	window.TS_SAMPLE = {
		states: Object.keys(STATES),
		build(state) {
			const make = STATES[state] ?? STATES.running;
			const out = make();
			const files = {};
			for (const [name, value] of Object.entries(out.files)) {
				files[name] = JSON.stringify(value, null, '\t');
			}
			return { files, running: out.running, saved: out.saved ?? {} };
		},
	};
})();
