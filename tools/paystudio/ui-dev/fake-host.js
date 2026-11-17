/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Dev only: stands in for the JumpCode host. It feeds the interface the real files scenario.py saved
// (window.PS_FILES) and records what the interface posts in window.__posted. The scenario's times are moved
// so the newest event happened a couple of minutes ago, and its random test ports read as the usual ones.
// Query: state=running|off|first|empty|long, view=overview|charges|webhooks|scenarios|timeline|cards|calls|settings|catalog,
// sel=pix:<txid>, note=text, project=0.
(function () {
	'use strict';
	const query = new URLSearchParams(location.search);
	const state = query.get('state') || 'running';
	window.__posted = [];
	const send = message => window.dispatchEvent(new MessageEvent('message', { data: message }));

	/** Moves every epoch-seconds number by `offset` (amounts, ids and counters are far from that range). */
	function shift(value, offset) {
		if (Array.isArray(value)) {
			return value.map(item => shift(item, offset));
		}
		if (value && typeof value === 'object') {
			return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shift(item, offset)]));
		}
		if (typeof value === 'number' && value > 1.7e9 && value < 1.9e9) {
			return Number.isInteger(value) ? Math.round(value + offset) : value + offset;
		}
		return value;
	}

	function longValues(files) {
		const charges = JSON.parse(files['charges.json']);
		const first = charges.charges[0];
		first.customer = 'Maria Aparecida dos Santos Oliveira Cavalcanti de Albuquerque Figueiredo';
		first.booking = 'AG-48400000-REAGENDADO-PELO-CLIENTE';
		const pix = charges.charges.find(c => c.gateway === 'pix' && c.status === 'pendente');
		if (pix) {
			pix.details.solicitacaoPagador = 'Barbearia do Zé · ' + pix.booking + ' · corte degradê com navalha, barba completa com toalha quente e sobrancelha';
			pix.details.devedor.nome = 'Ana Beatriz Costa de Vasconcelos Pereira Nogueira Sampaio';
		}
		const more = [];
		for (let i = 0; i < 160; i++) {
			const copy = JSON.parse(JSON.stringify(charges.charges[i % charges.charges.length]));
			copy.ref = `${copy.ref}${i}`;
			copy.created -= 60 * (i + 1);
			more.push(copy);
		}
		charges.charges = charges.charges.concat(more);
		files['charges.json'] = JSON.stringify(charges);
		const pay = JSON.parse(files['pay.json']);
		pay.gateways.mercadopago.url = 'http://localhost:3000/api/v2/integracoes/pagamentos/webhooks/mercadopago/notificacoes?origem=paystudio&ambiente=teste';
		pay.attention.push({ ref: first.ref, gateway: first.gateway, booking: first.booking, kind: 'duplicate', text: 'mesmo valor e mesmo agendamento de outra cobrança criada 1 s antes, sem Idempotency-Key, pelo segundo clique no botão Pagar da tela de agendamento' });
		pay.charges = charges.charges.length;
		files['pay.json'] = JSON.stringify(pay);
		const calls = JSON.parse(files['calls.json']);
		calls.calls.push({ ...calls.calls[calls.calls.length - 1], id: 999, path: '/v1/payment_intents/pi_otZfNdFWNPSPOw1FbGL86EfR/confirm?expand[]=latest_charge&expand[]=payment_method&expand[]=customer', status: 400, error: { code: 'parameter_invalid_empty', message: 'You passed an empty string for \'payment_method_data[billing_details][address][line1]\'. We assume empty values are an attempt to unset a parameter; however \'payment_method_data[billing_details][address][line1]\' cannot be unset.' } });
		files['calls.json'] = JSON.stringify(calls);
	}

	function empty(files, pay) {
		pay.charges = 0;
		pay.webhooks = 0;
		pay.calls = 0;
		pay.totals = {};
		pay.attention = [];
		pay.rules = [];
		pay.failures = [];
		pay.checks = [];
		pay.scheduled = [];
		for (const info of Object.values(pay.gateways)) {
			info.charges = 0;
			info.webhooks = 0;
			info.failing = 0;
			info.url = '';
		}
		files['charges.json'] = JSON.stringify({ schema: 1, charges: [] });
		files['webhooks.json'] = JSON.stringify({ schema: 1, deliveries: [] });
		files['calls.json'] = JSON.stringify({ schema: 1, calls: [], total: 0 });
		files['settings.json'] = JSON.stringify({ schema: 1, storage: 'memory', gateways: ['pix', 'mercadopago', 'stripe'], webhooks: { pix: '', mercadopago: '', stripe: '' }, merchant: 'BARBEARIA DO ZE', city: 'SAO PAULO' });
	}

	function files() {
		const out = {};
		if (state === 'first') {
			return out;
		}
		const source = window.PS_FILES || {};
		const pay0 = JSON.parse(source['pay.json'] || '{}');
		const offset = Date.now() / 1000 - 150 - (pay0.updatedAt || Date.now() / 1000);
		// scenario.py runs the gateway and the stand-in app on free ports; show them as the usual 4570 and localhost:3000.
		const appPort = (/http:\/\/127\.0\.0\.1:(\d+)\//.exec(source['settings.json'] || '') || [])[1];
		for (const [name, text] of Object.entries(source)) {
			let ports = text.split(`127.0.0.1:${pay0.port}`).join('127.0.0.1:4570');
			if (appPort) {
				ports = ports.split(`http://127.0.0.1:${appPort}`).join('http://localhost:3000').split(`127.0.0.1:${appPort}`).join('localhost:3000');
			}
			out[name] = JSON.stringify(shift(JSON.parse(ports), offset));
		}
		const pay = JSON.parse(out['pay.json']);
		pay.port = 4570;
		pay.status = state === 'off' ? 'stopped' : 'running';
		pay.startedAt = Date.now() / 1000 - 59 * 60;
		if (state === 'empty') {
			empty(out, pay);
		}
		out['pay.json'] = JSON.stringify(pay);
		if (state === 'long') {
			longValues(out);
		}
		const view = { schema: 1, revision: 1, view: query.get('view') || 'overview', select: query.get('sel') || null, note: query.get('note') || '' };
		out['view.json'] = JSON.stringify(view);
		return out;
	}

	window.acquireVsCodeApi = () => ({
		postMessage(message) {
			window.__posted.push(message);
			if (message.type === 'ready') {
				setTimeout(() => {
					send({ type: 'init', context: { tool: 'paystudio', project: query.get('project') !== '0', source: 'barbearia', sourceKind: 'project', sourceRevision: 1 } });
					send({ type: 'files', files: files(), revision: 1 });
					send({ type: 'running', running: false, executions: [], requests: [] });
				}, 0);
			}
		},
		getState() { return undefined; },
		setState() { },
	});
})();
