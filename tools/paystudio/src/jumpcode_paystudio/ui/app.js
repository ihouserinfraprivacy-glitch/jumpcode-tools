/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PayStudio Studio interface: plain JavaScript, no libraries, no network. It reads the Studio files the fake
// payment gateway writes (pay, charges, webhooks, calls, settings, view) and shows the charges, the webhooks the
// app received, the scenarios, a sequence per booking, the calls and the test cards. It never writes files and
// never reaches the gateway: every action becomes a chat message (`ask`) the agent carries out with the PayStudio
// tool. All visible text is in Brazilian Portuguese; amounts in reais and times in this computer's time zone.
(function () {
	'use strict';

	/** @type {{ postMessage(m: object): void, getState(): any, setState(s: any): void }} */
	const host = typeof acquireVsCodeApi === 'function'
		? acquireVsCodeApi()
		: { postMessage() { }, getState() { return undefined; }, setState() { } };

	// ------------------------------------------------------------------ constants

	const VIEWS = {
		overview: { label: 'Visão geral', icon: 'dashboard' },
		charges: { label: 'Cobranças', icon: 'card' },
		webhooks: { label: 'Webhooks', icon: 'send' },
		scenarios: { label: 'Cenários', icon: 'beaker' },
		timeline: { label: 'Linha do tempo', icon: 'commit' },
		calls: { label: 'Chamadas', icon: 'swap', more: true },
		cards: { label: 'Cartões de teste', short: 'Cartões', icon: 'card', more: true, offline: true },
		catalog: { label: 'Catálogo de gateways', short: 'Catálogo', icon: 'library', more: true, offline: true },
		settings: { label: 'Configurações', icon: 'gear', more: true, offline: true },
	};

	const GATEWAYS = ['pix', 'mercadopago', 'stripe'];
	const GW = {
		pix: { label: 'Pix', api: 'API Pix', the: 'a API Pix', of: 'da API Pix', path: '/pix' },
		mercadopago: { label: 'Mercado Pago', api: 'Mercado Pago', the: 'o Mercado Pago', of: 'do Mercado Pago', path: '/mercadopago' },
		stripe: { label: 'Stripe', api: 'Stripe', the: 'o Stripe', of: 'do Stripe', path: '/stripe' },
	};
	const GATEWAY_PHRASE = { any: 'todos os gateways', pix: 'a API Pix', mercadopago: 'o Mercado Pago', stripe: 'o Stripe' };

	const STATUS = { paga: 'paga', pendente: 'pendente', em_analise: 'em análise', expirada: 'expirada', recusada: 'recusada', estornada: 'estornada', estorno_parcial: 'estorno parcial', cancelada: 'cancelada', contestada: 'contestada' };
	const TABS = [['paga', 'Pagas'], ['pendente', 'Pendentes'], ['em_analise', 'Em análise'], ['expirada', 'Expiradas'], ['recusada', 'Recusadas'], ['estornada', 'Estornadas'], ['estorno_parcial', 'Estorno parcial'], ['cancelada', 'Canceladas'], ['contestada', 'Contestadas']];

	/** The ready scenarios as the engine builds them (rules.PRESETS): which rules each one arms. */
	const PRESETS = {
		pix_pago: { gateway: 'pix', rules: [['pay_after', { seconds: 5 }]], expect: ['A cobrança fica <span class="ps-m">CONCLUIDA</span> no PayStudio', 'O app responde 2xx ao webhook <span class="ps-m">pix</span>', 'O agendamento fica confirmado'] },
		pix_atrasado_duplicado: { gateway: 'pix', rules: [['pay_after', { seconds: 5 }], ['delay', { seconds: 120 }], ['duplicate', { copies: 2 }]], expect: ['A cobrança fica <span class="ps-m">CONCLUIDA</span> antes de o webhook chegar', 'Enquanto o webhook não chega, o app mostra o agendamento como pendente', 'O app responde 2xx às duas entregas', 'O agendamento é confirmado <b>uma vez só</b> (mesmo <span class="ps-m">endToEndId</span>)'] },
		pix_expira: { gateway: 'pix', rules: [['expire_after', { seconds: 30 }]], expect: ['Nenhum webhook chega: no padrão do Banco Central o vencimento não avisa ninguém', 'O app percebe sozinho que o Pix venceu e libera o horário'] },
		webhook_duplicado: { gateway: 'any', rules: [['duplicate', { copies: 2 }]], expect: ['O app responde 2xx às duas entregas', 'O app processa o evento <b>uma vez só</b>'] },
		webhook_atrasado: { gateway: 'any', rules: [['delay', { seconds: 120 }]], expect: ['O app mostra o pagamento como pendente até o webhook chegar', 'Quando o webhook chega, o app confirma sem erro'] },
		webhook_fora_de_ordem: { gateway: 'any', rules: [['out_of_order', {}]], expect: ['O app não volta um pagamento confirmado para pendente', 'O app usa o status atual do gateway, não a ordem de chegada'] },
		assinatura_errada: { gateway: 'any', rules: [['wrong_signature', {}]], expect: ['O app recusa o webhook (400 ou 401)', 'Nada muda no agendamento'] },
		cartao_recusado: { gateway: 'any', rules: [['decline', { reason: 'generic' }]], expect: ['O app mostra ao cliente que o cartão foi recusado', 'O agendamento não fica confirmado', 'O cliente pode tentar de novo com outro cartão ou com Pix'] },
		sem_saldo: { gateway: 'any', rules: [['decline', { reason: 'insufficient_funds' }]], expect: ['O app mostra "saldo insuficiente" ao cliente', 'O agendamento não fica confirmado'] },
		gateway_fora_do_ar: { gateway: 'any', rules: [['failure', { mode: 'unavailable', calls: 5 }]], expect: ['O app mostra uma mensagem clara e um botão <b>Tentar de novo</b>', 'Nenhum agendamento fica pago sem resposta do gateway'] },
		gateway_lento: { gateway: 'any', rules: [['failure', { mode: 'slow', latency_ms: 8000, calls: 5 }]], expect: ['O app desiste depois de alguns segundos em vez de esperar para sempre', 'O cliente não paga duas vezes ao clicar de novo'] },
	};
	const PRESET_GROUPS = [['Pix', ['pix_pago', 'pix_atrasado_duplicado', 'pix_expira']], ['Webhooks', ['webhook_duplicado', 'webhook_atrasado', 'webhook_fora_de_ordem', 'assinatura_errada']], ['Cartão', ['cartao_recusado', 'sem_saldo']], ['Gateway', ['gateway_fora_do_ar', 'gateway_lento']]];
	const DECLINES = { generic: ['generic_decline', 'cc_rejected_other_reason'], insufficient_funds: ['insufficient_funds', 'cc_rejected_insufficient_amount'] };

	const FAIL_MODES = [['unavailable', 'Responder <b>503</b> Service Unavailable'], ['slow', 'Demorar para responder'], ['timeout', 'Não responder (a conexão fica aberta)'], ['refuse', 'Recusar a conexão (fora do ar)'], ['rate_limit', 'Responder <b>429</b> Too Many Requests']];

	/** Why a card was refused, by Mercado Pago status_detail or Stripe decline_code. */
	const REASONS = {
		cc_rejected_insufficient_amount: 'saldo insuficiente', insufficient_funds: 'saldo insuficiente',
		cc_rejected_other_reason: 'recusado pelo banco, sem motivo específico', generic_decline: 'recusado pelo banco, sem motivo específico',
		cc_rejected_call_for_authorize: 'o banco pede que o cliente autorize o pagamento', call_issuer: 'o banco pede que o cliente ligue para ele',
		cc_rejected_bad_filled_security_code: 'código de segurança errado', incorrect_cvc: 'código de segurança errado',
		cc_rejected_bad_filled_date: 'data de validade errada', expired_card: 'cartão vencido',
		cc_rejected_bad_filled_other: 'algum dado do cartão está errado', processing_error: 'erro ao processar o cartão; dá para tentar de novo',
		pending_contingency: 'em análise: ainda pode ser aprovado ou recusado',
	};

	/** Mercado Pago test cards: any test number works, the cardholder name decides the result. */
	const MP_CARDS = [
		['5031 4332 1540 6351', 'Mastercard', 'APRO', 'ok', 'approved · accredited'],
		['5031 4332 1540 6351', 'Mastercard', 'CONT', 'pend', 'in_process · pending_contingency'],
		['5031 4332 1540 6351', 'Mastercard', 'FUND', 'rec', 'rejected · cc_rejected_insufficient_amount'],
		['4235 6477 2802 5682', 'Visa', 'OTHE', 'rec', 'rejected · cc_rejected_other_reason'],
		['4235 6477 2802 5682', 'Visa', 'SECU', 'rec', 'rejected · cc_rejected_bad_filled_security_code'],
		['4235 6477 2802 5682', 'Visa', 'EXPI', 'rec', 'rejected · cc_rejected_bad_filled_date'],
		['4235 6477 2802 5682', 'Visa', 'CALL', 'rec', 'rejected · cc_rejected_call_for_authorize'],
		['3753 651535 56885', 'Amex', 'FORM', 'rec', 'rejected · cc_rejected_bad_filled_other'],
	];
	/** Stripe test cards (stripe.NUMBERS and TEST_METHODS): the number decides the result. */
	const STRIPE_CARDS = [
		['4242 4242 4242 4242', 'pm_card_visa', 'ok', 'payment_intent.succeeded'],
		['5555 5555 5555 4444', 'pm_card_mastercard', 'ok', 'payment_intent.succeeded'],
		['3782 822463 10005', 'pm_card_amex', 'ok', 'payment_intent.succeeded'],
		['4000 0000 0000 0002', 'pm_card_chargeDeclined', 'rec', 'card_declined · generic_decline'],
		['4000 0000 0000 9995', 'pm_card_chargeDeclinedInsufficientFunds', 'rec', 'card_declined · insufficient_funds'],
		['4000 0000 0000 0069', 'pm_card_chargeDeclinedExpiredCard', 'rec', 'expired_card'],
		['4000 0000 0000 0127', 'pm_card_chargeDeclinedIncorrectCvc', 'rec', 'incorrect_cvc'],
		['4000 0000 0000 0119', 'pm_card_chargeDeclinedProcessingError', 'rec', 'processing_error'],
		['4000 0025 0000 3155', 'pm_card_authenticationRequired', 'pend', 'requires_action (3-D Secure)'],
		['4000 0000 0000 3220', 'pm_card_threeDSecure2Required', 'pend', 'requires_action (3-D Secure 2)'],
		['4000 0000 0000 0259', 'pm_card_createDispute', 'you', 'succeeded, depois charge.dispute.created'],
	];
	const CARD_RESULT = { ok: ['s-paga', 'aprovado'], pend: ['s-pendente', 'pendente'], rec: ['s-recusada', 'recusado'], you: ['s-contestada', 'contestado'] };

	/** What each emulated gateway answers (the engine's routes). */
	const CATALOG = {
		pix: { what: 'cob, QR Code, Pix recebido, devolução, webhook', version: 'API Pix v2', routes: [
			['POST /oauth/token', 'token OAuth'], ['PUT /v2/cob/{txid}', 'criar cobrança'], ['GET /v2/cob/{txid}', 'consultar e revisar (PATCH)'],
			['GET /v2/loc/{id}/qrcode', 'QR Code e copia e cola'], ['GET /v2/pix/{e2eid}', 'Pix recebido'], ['PUT /v2/pix/{e2eid}/devolucao/{id}', 'devolução'],
			['PUT /v2/webhook/{chave}', 'configurar webhook'], ['POST {webhook}/pix', 'aviso de Pix pago'],
		], missing: [['mTLS do webhook', 'não simulado'], ['cobrança com vencimento (cobv)', 'ainda não']] },
		mercadopago: { what: 'payments (cartão e Pix), card_tokens, refunds, webhook', version: 'v1', routes: [
			['POST /v1/card_tokens', 'cartão de teste'], ['POST /v1/payments', 'cartão e Pix do MP'], ['GET /v1/payments/{id}', 'consultar e buscar'],
			['POST /v1/payments/{id}/refunds', 'total e parcial'], ['webhook payment com x-signature', ''], ['X-Idempotency-Key', 'obrigatório'],
			['chargebacks', 'só os eventos'],
		], missing: [['Checkout Pro (preferences)', 'ainda não'], ['assinaturas (preapproval)', 'ainda não']] },
		stripe: { what: 'PaymentIntents, payment_methods, refunds, disputas, eventos', version: '2024-06-20', routes: [
			['POST /v1/payment_intents', 'criar e listar'], ['POST /v1/payment_intents/{id}/confirm', 'confirmar, 3-D Secure'], ['POST /v1/payment_intents/{id}/cancel', 'cancelar'],
			['POST /v1/payment_methods', 'pm_card_* de teste'], ['POST /v1/refunds', 'total e parcial'], ['Idempotency-Key', 'repete a resposta'],
			['eventos com Stripe-Signature', 'charge.dispute.*, charge.refunded'],
		], missing: [['customers, Checkout Sessions', 'ainda não'], ['assinaturas (subscriptions)', 'ainda não']] },
	};
	const NOT_YET = ['PagSeguro', 'Asaas', 'Cielo', 'Adyen', 'Pagar.me', 'Iugu', 'PayPal'];

	const HTTP = { 200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found', 400: 'Bad Request', 401: 'Unauthorized', 402: 'Payment Required', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict', 422: 'Unprocessable Entity', 429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' };

	const ICONS = {
		dashboard: '<rect x="1.8" y="1.8" width="5.4" height="5.4"/><rect x="8.8" y="1.8" width="5.4" height="5.4"/><rect x="1.8" y="8.8" width="5.4" height="5.4"/><rect x="8.8" y="8.8" width="5.4" height="5.4"/>',
		card: '<rect x="1.6" y="3.4" width="12.8" height="9.2"/><path d="M1.6 6.4h12.8M4 10h3"/>',
		send: '<path d="M2 8 14 2l-3 12-3.2-4.4z"/><path d="M7.8 9.6 14 2"/>',
		beaker: '<path d="M6 1.8v4.6L2.7 12.9a.9.9 0 0 0 .8 1.3h9a.9.9 0 0 0 .8-1.3L10 6.4V1.8M5 1.8h6M4.4 10h7.2"/>',
		commit: '<circle cx="8" cy="8" r="2.6"/><path d="M8 1.6v3.8M8 10.6v3.8"/>',
		swap: '<path d="M2.4 5h10.4M10 2.4 12.8 5 10 7.6M13.6 11H3.2M6 8.4 3.2 11 6 13.6"/>',
		library: '<path d="M2.4 2.4v11.2M5.4 2.4v11.2M8.6 2.8l3.2 10.8"/>',
		gear: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.6v2M8 12.4v2M1.6 8h2M12.4 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M3.5 12.5l1.4-1.4M11.1 4.9l1.4-1.4"/>',
		play: '<path d="M4.6 2.8v10.4L13 8z"/>',
		stop: '<rect x="3.4" y="3.4" width="9.2" height="9.2"/>',
		copy: '<rect x="5" y="5" width="8.6" height="8.6"/><path d="M3 10.6H2.4V2.4h8.2V3"/>',
		file: '<path d="M3.2 1.8h6l3.6 3.6v8.8H3.2z"/><path d="M9.2 1.8v3.6h3.6"/>',
		fileAdd: '<path d="M3.2 1.8h6l3.6 3.6v8.8H3.2z"/><path d="M9.2 1.8v3.6h3.6M8 7.6v4.4M5.8 9.8h4.4"/>',
		filter: '<path d="M2 2.6h12L9.4 8.4v4.8l-2.8 1.2V8.4z"/>',
		chevD: '<path d="M3.5 6 8 10.5 12.5 6"/>',
		check: '<path d="m3 8.4 3.1 3.1L13 4.6"/>',
		passed: '<circle cx="8" cy="8" r="6.4" fill="currentColor" stroke="none"/><path d="m5.1 8.2 2 2 3.9-4.1" stroke="#FFFFFF" stroke-width="1.6"/>',
		error: '<circle cx="8" cy="8" r="6"/><path d="m5.7 5.7 4.6 4.6M10.3 5.7l-4.6 4.6"/>',
		warning: '<path d="M8 2 14.4 13.6H1.6z"/><path d="M8 6.4v3.4M8 11.8h.01"/>',
		info: '<circle cx="8" cy="8" r="6"/><path d="M8 7.2v4M8 4.8h.01"/>',
		dot: '<circle cx="8" cy="8" r="3.4" fill="currentColor" stroke="none"/>',
		ring: '<circle cx="8" cy="8" r="5.6"/>',
		spinner: '<path d="M13.6 8A5.6 5.6 0 0 1 2.4 8"/>',
		comment: '<path d="M2.2 2.8h11.6v8H7.2l-3 2.6v-2.6h-2z"/>',
		history: '<path d="M3 4.6A5.8 5.8 0 1 1 2.2 8"/><path d="M2.6 1.9v2.9h2.9M8 4.8V8l2.2 1.5"/>',
		lock: '<rect x="3.2" y="7" width="9.6" height="7"/><path d="M5.4 7V5.2a2.6 2.6 0 0 1 5.2 0V7"/>',
		key: '<circle cx="5" cy="11" r="2.8"/><path d="m7 9 6-6M11 5l1.6 1.6M9.4 6.6 11 8.2"/>',
		shield: '<path d="M8 1.8 13 3.8v4c0 3-2.2 5.2-5 6.4-2.8-1.2-5-3.4-5-6.4v-4z"/>',
		globe: '<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c1.8 1.7 2.6 3.7 2.6 6S9.8 12.3 8 14C6.2 12.3 5.4 10.3 5.4 8S6.2 3.7 8 2z"/>',
		clock: '<circle cx="8" cy="8" r="6"/><path d="M8 4.4V8l2.4 1.6"/>',
		bolt: '<path d="M9.2 1.6 3.4 9h4.2l-.8 5.4L12.6 7H8.4z"/>',
		refresh: '<path d="M13.2 6.6A5.4 5.4 0 0 0 3.4 5M2.8 9.4A5.4 5.4 0 0 0 12.6 11M3.4 2.2V5h2.8M12.6 13.8V11H9.8"/>',
		undo: '<path d="M4 6.4h6a3.4 3.4 0 0 1 0 6.8H6.6"/><path d="M6.6 3.6 3.8 6.4l2.8 2.8"/>',
		trash: '<path d="M2.6 4h10.8M6 4V2.4h4V4M3.8 4l.8 9.8h6.8l.8-9.8"/>',
		pulse: '<path d="M1.6 8.4h3l1.6-4.2 3 8 1.8-3.8h3.4"/>',
		graph: '<path d="M2 14h12"/><rect x="3" y="8" width="2.4" height="6"/><rect x="6.8" y="4" width="2.4" height="10"/><rect x="10.6" y="10" width="2.4" height="4"/>',
		calendar: '<rect x="2" y="3" width="12" height="11"/><path d="M2 6.4h12M5 1.6v2.8M11 1.6v2.8"/>',
		server: '<rect x="2.2" y="2" width="11.6" height="5"/><rect x="2.2" y="9" width="11.6" height="5"/><path d="M4.6 4.5h.01M4.6 11.5h.01"/>',
		mobile: '<rect x="4.4" y="1.6" width="7.2" height="12.8"/><path d="M7.2 12h1.6"/>',
		arrowL: '<path d="M13 8H3M7 4 3 8l4 4"/>',
		arrowR: '<path d="M3 8h10M9 4l4 4-4 4"/>',
		receipt: '<path d="M3.4 1.8h9.2v12.4l-2.3-1.4-2.3 1.4-2.3-1.4-2.3 1.4z"/><path d="M5.6 5.4h4.8M5.6 8.2h4.8"/>',
		list: '<path d="M5.4 4h8.6M5.4 8h8.6M5.4 12h8.6M2.2 4h.01M2.2 8h.01M2.2 12h.01"/>',
		checklist: '<path d="m1.8 4 1.4 1.4L5.6 3M1.8 10l1.4 1.4L5.6 9M7.6 4.4h6.6M7.6 10.4h6.6"/>',
		plug: '<path d="M5.4 1.8v3.4M10.6 1.8v3.4M3.6 5.2h8.8v2.6a4.4 4.4 0 0 1-8.8 0zM8 12.2v2"/>',
		slash: '<circle cx="8" cy="8" r="6"/><path d="m3.8 12.2 8.4-8.4"/>',
		edit: '<path d="m10.6 2.4 3 3-8 8H2.6v-3z"/>',
		bulb: '<path d="M5.8 11.2c0-1.6-2.4-2.6-2.4-5.2a4.6 4.6 0 0 1 9.2 0c0 2.6-2.4 3.6-2.4 5.2zM6 13.6h4"/>',
		output: '<rect x="2" y="1.8" width="12" height="12.4"/><path d="M4.4 5h7.2M4.4 8h7.2M4.4 11h4.4"/>',
		agent: '<rect x="3" y="5" width="10" height="8"/><path d="M8 2v3M6 9h.01M10 9h.01M5.6 11.2h4.8"/>',
		folder: '<path d="M1.8 3.6h4.1l1.5 1.6h6.8v7.5H1.8z"/>',
	};

	// ------------------------------------------------------------------ helpers

	const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' };
	const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ESC[c]);
	const ic = (name, cls = '') => `<svg class="ps-ic ${cls}" viewBox="0 0 16 16" aria-hidden="true">${ICONS[name] || ''}</svg>`;
	const MARK = '<svg class="ps-mark" viewBox="0 0 100 100" aria-hidden="true"><rect width="100" height="100" rx="24" fill="#6B57C8"/><path d="M26 15H74V83L66 77L58 83L50 77L42 83L34 77L26 83Z" fill="#fff"/><path d="M36.5 38.5L45.5 47.5L63.5 29.5" fill="none" stroke="#6B57C8" stroke-width="7.5" stroke-linecap="round" stroke-linejoin="round"/><rect x="36" y="57" width="28" height="5.5" rx="2.75" fill="#6B57C8" opacity=".5"/><rect x="36" y="66" width="18" height="5.5" rx="2.75" fill="#6B57C8" opacity=".5"/></svg>';
	const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
	const pad = n => String(n).padStart(2, '0');
	const nowSec = () => Date.now() / 1000;
	const clock = (seconds, ms) => {
		if (!seconds) { return '—'; }
		const d = new Date(seconds * 1000);
		return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${ms ? '.' + String(d.getMilliseconds()).padStart(3, '0') : ''}`;
	};
	const hm = seconds => { const d = new Date(seconds * 1000); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
	const sameDay = (a, b) => new Date(a * 1000).toDateString() === new Date(b * 1000).toDateString();
	const date = seconds => { const d = new Date(seconds * 1000); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`; };
	const when = seconds => sameDay(seconds, nowSec()) ? clock(seconds) : `${date(seconds).slice(0, 5)} ${clock(seconds)}`;
	const iso = seconds => new Date(seconds * 1000).toISOString().replace(/\.(\d{3})Z$/, '.$1Z');
	const duration = seconds => {
		const s = Math.max(0, Math.round(seconds));
		if (s < 60) { return `${s} s`; }
		if (s < 3600) { return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`; }
		return `${Math.floor(s / 3600)} h ${Math.floor(s % 3600 / 60)} min`;
	};
	const mmss = seconds => { const s = Math.max(0, Math.round(seconds)); return `${Math.floor(s / 60)}:${pad(s % 60)}`; };
	const since = seconds => seconds ? duration(nowSec() - seconds).replace(/ \d+ s$/, '') : '—';
	const MONEY = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
	const brl = cents => MONEY.format((Number(cents) || 0) / 100);
	const reais = cents => ((Number(cents) || 0) / 100).toFixed(2);
	const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'horário local'; } catch { return 'horário local'; } })();
	const parse = text => { try { return JSON.parse(text); } catch { return undefined; } };
	const m = text => `<span class="ps-m">${esc(text)}</span>`;
	const dim = html => `<span class="ps-dim">${html}</span>`;
	const tx = html => `<span class="tx">${html}</span>`;
	const gwBadge = (gateway, cls = '') => `<span class="ps-badge g-${GW[gateway] ? gateway : 'other'} ${cls}">${esc(GW[gateway]?.label || gateway)}</span>`;
	const stBadge = (status, cls = 'w') => `<span class="ps-badge s-${STATUS[status] ? status : 'cancelada'} ${cls}">${esc(STATUS[status] || status)}</span>`;
	const sum = (list, field = 'amount') => list.reduce((n, item) => n + (Number(item[field]) || 0), 0);
	const host_ = url => String(url || '').replace(/^https?:\/\//, '');
	const pathOf = url => { try { const u = new URL(url); return u.pathname + u.search; } catch { return String(url || ''); } };
	const maskCpf = cpf => { const d = String(cpf || '').replace(/\D/g, ''); return d.length === 11 ? `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**` : '—'; };
	const brand = name => ({ visa: 'Visa', master: 'Mastercard', mastercard: 'Mastercard', amex: 'Amex', elo: 'Elo' })[String(name || '').toLowerCase()] || String(name || 'cartão');
	const gap = seconds => seconds < 1 ? `${Math.round(seconds * 1000)} ms` : `${seconds.toFixed(1).replace('.', ',')} s`;
	const ms = value => `${Number(value) < 10 ? String(Math.round(Number(value) * 10) / 10).replace('.', ',') : Math.round(Number(value))} ms`;
	/** Text that may wrap after / _ . or between joined words (camelCase), for long identifiers in narrow columns. */
	const soft = text => esc(text).replace(/([/_.])/g, '$1<wbr>').replace(/([a-z])([A-Z])/g, '$1<wbr>$2');
	const ms_ = text => `<span class="ps-m">${soft(text)}</span>`;
	const shortPath = path => String(path || '').split('/').map(part => part.length > 20 ? `${part.slice(0, 16)}…` : part).join('/');
	const shortRef = ref => String(ref || '').length > 18 ? `${String(ref).slice(0, 16)}…` : String(ref || '');

	function btn(label, icon, cls = '', attrs = '') {
		return `<button class="ps-btn ${cls}" ${attrs}>${icon ? ic(...[].concat(icon)) : ''}${label}</button>`;
	}

	function panel(title, body, o = {}) {
		return `<div class="ps-panel ${o.mk ? `mk mk-${o.mk}` : ''} ${o.cls || ''}" ${o.style ? `style="${o.style}"` : ''}><div class="ps-ph">${o.icon ? ic(o.icon) : ''}<span class="t">${title}</span>${o.right ? `<span class="r">${o.right}</span>` : ''}</div>${o.tabs || ''}<div class="ps-pb ${o.pb || ''}" ${o.scroll ? `data-scroll="${o.scroll}"` : ''}>${body}</div>${o.foot ? `<div class="ps-pfoot">${o.foot}</div>` : ''}</div>`;
	}

	const kv = (pairs, width) => `<div class="ps-kv" ${width ? `style="grid-template-columns:${width}px minmax(0,1fr)"` : ''}>${pairs.filter(Boolean).map(([k, v]) => `<span>${tx(k)}</span><span>${tx(v)}</span>`).join('')}</div>`;
	const note = (icon, cls, html, extra = '') => `<div class="ps-note ${extra}">${ic(icon, cls)}<div>${html}</div></div>`;
	const li = (icon, html, right = '', cls = '') => `<div class="ps-li ${cls}">${icon}${tx(html)}${right ? `<em>${right}</em>` : ''}</div>`;

	/** A table: cols are [label, width (0 = rest), class]; a row is cells or { c: cells, cls, attrs }. */
	function table(cols, rows, o = {}) {
		const head = `<colgroup>${cols.map(([, w]) => `<col ${w ? `style="width:${w}px"` : ''}>`).join('')}</colgroup><thead><tr>${cols.map(([label, , cls]) => `<th class="${cls || ''}">${label}</th>`).join('')}</tr></thead>`;
		const body = rows.map(r => {
			const opt = Array.isArray(r) ? {} : r;
			const cells = Array.isArray(r) ? r : r.c;
			return `<tr class="${opt.cls || ''}" ${opt.attrs || ''}>${cells.map((v, i) => `<td class="${cols[i][2] || ''}">${v}</td>`).join('')}</tr>`;
		}).join('');
		return `<table class="ps-tbl ${o.cls || ''}">${head}<tbody>${body}</tbody></table>`;
	}

	const pretty = text => {
		if (text === null || text === undefined || text === '') { return ''; }
		if (typeof text !== 'string') { return JSON.stringify(text, null, 2); }
		try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
	};
	const highlight = text => esc(text).replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false|null)\b|(-?\b\d+(?:\.\d+)?\b)/g,
		(match, str, colon, kw, num) => str ? (colon ? `<span class="k">${str}</span>${colon}` : `<span class="s">${str}</span>`) : kw ? `<span class="b">${kw}</span>` : `<span class="n">${num}</span>`);
	/** JSON (or text) with line numbers; `raw` lines are already HTML. */
	function code(text, o = {}) {
		const lines = o.raw ? text : pretty(text).split('\n').map(highlight);
		const body = lines.map((line, i) => `<div class="cl">${o.numbers === false ? '' : `<span class="ln">${i + 1}</span>`}<span class="lt">${line || ' '}</span></div>`).join('');
		return `<div class="ps-code ${o.numbers === false ? 'nl' : ''} ${o.cls || ''}" ${o.scroll ? `data-scroll="${o.scroll}"` : ''}>${body || '<div class="cl"> </div>'}</div>`;
	}

	// ------------------------------------------------------------------ state

	const saved = host.getState() || {};
	const S = {
		ctx: null,
		pay: null,
		charges: [],
		deliveries: [],
		calls: [],
		callTotal: 0,
		settings: {},
		view: VIEWS[saved.view] ? saved.view : 'overview',
		viewRevision: 0,
		sel: saved.sel || null,
		chargeOpen: !!saved.chargeOpen,
		chargeTab: 'all',
		chargeText: '',
		chargeGw: 'all',
		hookSel: saved.hookSel || null,
		hookOpen: !!saved.hookOpen,
		hookTab: 'body',
		hookText: '',
		hookGw: 'all',
		hookProblem: false,
		attemptSel: null,
		callSel: saved.callSel || null,
		callFilter: 'all',
		scenSel: saved.scenSel || 'pix_atrasado_duplicado',
		tlBooking: saved.tlBooking || null,
		cardSel: null,
		cardText: '',
		cardGw: 'all',
		catalogSel: 'mercadopago',
		drafts: {},
		pending: null,
		menu: false,
		menuX: 0,
		confirm: null,
		running: false,
		note: null,
		firstStorage: 'memory',
	};

	function remember() {
		host.setState({ view: S.view, sel: S.sel, chargeOpen: S.chargeOpen, hookSel: S.hookSel, hookOpen: S.hookOpen, callSel: S.callSel, scenSel: S.scenSel, tlBooking: S.tlBooking, viewRevision: S.viewRevision });
	}

	const payOn = () => S.pay?.status === 'running';
	/** The Studio panel is narrower than the mockups in the real window (about 1075 CSS px, less in small windows). */
	const narrow = () => window.innerWidth < 1200;
	const tight = () => window.innerWidth < 1000;
	/** Drops the columns given as null, and their cells, so a narrow Studio keeps the ones that matter. */
	function columns(cols, rows) {
		const keep = cols.map((col, i) => col ? i : -1).filter(i => i >= 0);
		return [keep.map(i => cols[i]), rows.map(r => Array.isArray(r) ? keep.map(i => r[i]) : { ...r, c: keep.map(i => r.c[i]) })];
	}
	const firstStorage = () => S.firstStorageTouched ? S.firstStorage : (S.settings.storage || S.pay?.storage || 'memory');
	const draft = (key, fallback) => S.drafts[key] !== undefined ? S.drafts[key] : fallback;

	function ask(text, send = true) {
		const requestId = send ? `ps-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}` : undefined;
		host.postMessage({ type: 'ask', text, send: !!send, ...(requestId ? { requestId } : {}) });
		return requestId;
	}

	function act(kind, text) {
		const requestId = ask(text, true);
		S.pending = { kind, requestId, at: Date.now() };
		if (kind === 'start' || kind === 'stop') {
			render();
		} else {
			toast('Pedido enviado ao agente. Acompanhe na conversa.');
		}
	}

	// ------------------------------------------------------------------ derived data

	const chargeKey = c => `${c.gateway}:${c.ref}`;

	/** A charge by `gateway:ref`, its ref, its booking (the newest one) or the end of its id. */
	function findCharge(select) {
		if (!select) { return undefined; }
		const text = String(select);
		const exact = S.charges.find(c => chargeKey(c) === text);
		if (exact) { return exact; }
		const [head, ...rest] = text.split(':');
		const scoped = rest.length && GW[head];
		const ref = scoped ? rest.join(':') : text;
		const pool = scoped ? S.charges.filter(c => c.gateway === head) : S.charges;
		return pool.find(c => c.ref === ref) || pool.find(c => c.booking === ref) || pool.find(c => ref.length >= 6 && String(c.ref).endsWith(ref));
	}

	function findHook(select) {
		const match = /^(?:webhook:|#)?(\d+)$/.exec(String(select ?? '').trim());
		return match ? S.deliveries.find(d => d.id === Number(match[1])) : undefined;
	}

	const chargeOf = ref => S.charges.find(c => c.ref === ref);
	const lastAttempt = d => d.attempts[d.attempts.length - 1];
	const attemptOk = a => !!a && a.status !== null && a.status !== undefined && a.status >= 200 && a.status < 300;
	/** The app answered a webhook with an error (wrong-signature tests excepted: there 4xx is right). */
	const hookFailing = d => d.signature !== 'wrong' && d.attempts.length > 0 && !attemptOk(lastAttempt(d)) && d.state !== 'delivered';
	/** The app accepted a webhook whose signature was wrong on purpose. */
	const hookForged = d => d.signature === 'wrong' && d.attempts.some(attemptOk);
	const hookProblem = d => hookFailing(d) || hookForged(d) || d.state === 'failed' || d.state === 'no_url';
	const failingHooks = () => S.deliveries.filter(hookFailing);

	/** How many charges share a booking: the asks name the charge's id when the booking is not enough. */
	function chargeText(c) {
		const same = c.booking ? S.charges.filter(x => x.booking === c.booking).length : 0;
		if (c.booking && same === 1) { return `do agendamento ${c.booking}`; }
		return `${GW[c.gateway].of} ${c.ref}${c.booking ? ` (${c.booking})` : ''}`;
	}

	function meio(c) {
		const d = c.details || {};
		if (c.method === 'pix') { return c.gateway === 'pix' ? 'Pix · QR Code' : 'Pix do Mercado Pago'; }
		const card = d.card;
		if (!card) { return dim('aguardando cartão'); }
		return `${esc(brand(card.brand))} •••• ${esc(card.last4 || card.last_four_digits || '')}`;
	}

	function service(c) {
		const text = c.details?.solicitacaoPagador;
		if (!text) { return ''; }
		const parts = String(text).split(' · ');
		return parts.length > 2 ? parts.slice(2).join(' · ') : '';
	}

	const canPay = c => (c.gateway === 'pix' && c.status === 'pendente') || (c.gateway === 'mercadopago' && ['pendente', 'em_analise'].includes(c.status)) || (c.gateway === 'stripe' && c.gatewayStatus === 'requires_action');
	const canExpire = c => c.status === 'pendente' && (c.gateway === 'pix' || (c.gateway === 'mercadopago' && c.method === 'pix'));
	const canRefund = c => ['paga', 'estorno_parcial'].includes(c.status);
	const canDispute = c => c.method === 'card' && c.status === 'paga' && c.gateway !== 'pix';
	const declineCode = c => c.details?.last_payment_error?.decline_code || c.details?.last_payment_error?.code || c.details?.status_detail || '';

	/** Calls, webhook attempts and payer actions of one charge, oldest first. */
	function chargeRows(c) {
		const rows = [];
		for (const call of S.calls.filter(k => k.ref === c.ref)) {
			rows.push({ at: call.at, who: 'app → PayStudio', what: m(`${call.method} ${call.path}`), res: callStatus(call), mk: call.status >= 500 ? 'bad' : '' });
		}
		for (const d of S.deliveries.filter(x => x.ref === c.ref && x.gateway === c.gateway)) {
			const label = `${m(d.event)} ${dim(`· webhook #${d.id}${d.copy_of ? ` · cópia de #${d.copy_of}` : ''}${d.signature === 'wrong' ? ' · assinatura errada' : ''}`)}`;
			if (!d.attempts.length) {
				rows.push({ at: d.due || d.created, who: 'PayStudio → app', what: `${label} ${dim(d.state === 'held' ? '· segurado' : d.state === 'no_url' ? '· sem endereço' : `· sai às ${clock(d.due)}`)}`, res: dim('—'), mk: 'run', hook: d.id });
			}
			for (const a of d.attempts) {
				rows.push({ at: a.at, who: 'PayStudio → app', what: label, res: attemptStatus(d, a), mk: hookFailing(d) && a === lastAttempt(d) || hookForged(d) && attemptOk(a) ? 'bad' : '', hook: d.id });
			}
		}
		for (const e of c.events || []) {
			if (e.kind === 'webhook' || e.by === 'app') { continue; }
			rows.push({ at: e.at, who: e.by === 'agente' ? 'Pagador de teste' : e.by === 'cenário' ? 'Cenário' : 'PayStudio', what: `${eventIcon(e.kind)}${esc(e.text)}`, res: dim('—'), mk: e.kind === 'bad' ? 'you' : '' });
		}
		return rows.sort((a, b) => a.at - b.at);
	}

	const eventIcon = kind => ({ ok: ic('passed', 'c-ok'), bad: ic('error', 'c-bad'), warn: ic('warning', 'c-you'), scenario: ic('beaker', 'c-run'), webhook: ic('send', 'c-dim') })[kind] || ic('info', 'c-run');
	const eventMark = kind => ({ ok: 'ok', bad: 'bad', warn: 'you', scenario: 'run' })[kind] || '';

	function callStatus(call) {
		const bad = call.status >= 500 || (call.status >= 400 && call.status !== 402);
		return `${bad ? ic('error', 'c-bad') : call.status === 402 ? ic('warning', 'c-you') : ''}${call.status}`;
	}

	function attemptStatus(d, a) {
		if (!a) { return dim('—'); }
		if (a.status === null || a.status === undefined) { return `${ic('error', 'c-bad')}sem resposta`; }
		const ok = attemptOk(a);
		const bad = d.signature === 'wrong' ? ok : !ok;
		return `${bad ? ic('error', 'c-bad') : ''}${a.status}`;
	}

	// ------------------------------------------------------------------ toolbar and frame

	function toolbar() {
		const on = payOn();
		const main = Object.entries(VIEWS).filter(([, v]) => !v.more);
		const moreOn = VIEWS[S.view].more;
		const buttons = main.map(([id, v]) => `<button class="ps-vb ${S.view === id && on ? 'on' : ''} ${on ? '' : 'dis'}" data-act="view" data-view="${id}">${ic(v.icon)}${v.label}</button>`).join('');
		const more = `<button class="ps-vb ${moreOn ? 'on' : ''}" data-act="menu">${moreOn ? ic(VIEWS[S.view].icon) + (narrow() && VIEWS[S.view].short || VIEWS[S.view].label) : 'Mais'}${ic('chevD', 'chev')}</button>`;
		const endpoint = host_(S.pay?.endpoint || 'http://127.0.0.1:4570');
		const starting = S.pending?.kind === 'start' || S.pay?.status === 'starting';
		const stopping = S.pending?.kind === 'stop';
		let status;
		let power;
		if (on && !stopping) {
			const failures = (S.pay.failures || []).length;
			const rules = (S.pay.rules || []).length;
			status = failures ? `<span class="ps-stat">${ic('warning', 'c-you')}Falhas ligadas</span>`
				: rules ? `<span class="ps-stat">${ic('beaker', 'c-run')}Cenário armado</span>`
					: `<span class="ps-stat">${ic('dot', 'c-ok sm')}Rodando</span>`;
			power = btn('Parar', ['stop', 'c-bad'], '', 'data-act="stop"');
		} else if (starting || stopping) {
			status = `<span class="ps-stat">${ic('spinner', 'spin c-run')}${starting ? 'Ligando…' : 'Desligando…'}</span>`;
			power = btn(starting ? 'Ligar' : 'Parar', 'play', 'dis', 'disabled');
		} else {
			status = `<span class="ps-stat">${ic('dot', 'c-dim sm')}Desligado</span>`;
			power = btn('Ligar', ['play', 'c-ok'], '', 'data-act="start"');
		}
		return `<div class="ps-bar">${buttons}${more}<span class="ps-sep"></span>`
			+ `<span class="ps-crumb">${MARK}<b>Gateway local</b><span class="v">${esc(endpoint)}</span></span>`
			+ `<span class="ps-sp"></span>${status}${power}</div>`;
	}

	function menu() {
		if (!S.menu) { return ''; }
		const items = Object.entries(VIEWS).filter(([, v]) => v.more)
			.map(([id, v]) => `<div class="mi ${S.view === id ? 'sel' : ''}" data-act="view" data-view="${id}">${ic(v.icon)}${v.label}</div>`).join('');
		return `<div class="ps-menu" style="left:${S.menuX || 560}px;top:36px">${items}</div>`;
	}

	function footer() {
		if (!payOn()) {
			const storage = (S.pay?.storage || S.settings.storage) === 'persistent' ? 'guarda as cobranças entre sessões' : 'só na memória';
			return `<div class="ps-foot"><span>${ic('dot', 'c-dim sm')}Desligado</span><span>${storage}</span><span>${ic('lock')}só cartões e Pix de teste</span><span>${esc(TZ)} · BRL</span></div>`;
		}
		const failing = failingHooks().length;
		const parts = [
			`${ic('dot', 'c-ok sm')}${plural(Object.keys(S.pay.gateways || GW).length, 'gateway emulado', 'gateways emulados')}`,
			plural(S.charges.length, 'cobrança', 'cobranças'),
			`${plural(S.deliveries.length, 'webhook', 'webhooks')}${failing ? ` · ${ic('error', 'c-bad')} ${failing} falhando` : ''}`,
		];
		if ((S.pay.failures || []).length) {
			parts.push(`${ic('warning', 'c-you')}falhas ligadas`);
		}
		parts.push(`${ic('lock')}só cartões e Pix de teste`, `${esc(TZ)} · BRL`);
		return `<div class="ps-foot">${parts.map(p => `<span>${p}</span>`).join('')}</div>`;
	}

	function render() {
		if (render.queued) { return; }
		render.queued = true;
		requestAnimationFrame(() => {
			render.queued = false;
			draw();
		});
	}

	function draw() {
		const root = document.getElementById('ps-root') || (() => {
			const el = document.createElement('div');
			el.id = 'ps-root';
			document.body.appendChild(el);
			return el;
		})();
		const scrolls = {};
		root.querySelectorAll('[data-scroll]').forEach(el => { scrolls[el.dataset.scroll] = [el.scrollTop, el.scrollLeft]; });
		const active = document.activeElement;
		const focus = active && active.dataset && active.dataset.draft ? { key: active.dataset.draft, start: active.selectionStart, end: active.selectionEnd } : null;
		let body;
		if (S.pending?.kind === 'start' && !payOn()) {
			body = startingView();
		} else if (!payOn() && !VIEWS[S.view].offline) {
			body = firstView();
		} else {
			body = ({ overview: overviewView, charges: chargesView, webhooks: webhooksView, scenarios: scenariosView, timeline: timelineView, calls: callsView, cards: cardsView, catalog: catalogView, settings: settingsView })[S.view]();
		}
		root.innerHTML = `<div class="ps-studio">${toolbar()}<div class="ps-body">${body}</div>${footer()}${menu()}${confirmDialog()}${S.note ? `<div class="ps-toast">${ic('info', 'c-run')}${esc(S.note)}</div>` : ''}</div>`;
		root.querySelectorAll('[data-scroll]').forEach(el => {
			const value = scrolls[el.dataset.scroll];
			if (value) { el.scrollTop = value[0]; el.scrollLeft = value[1]; }
		});
		if (focus) {
			const el = root.querySelector(`[data-draft="${CSS.escape(focus.key)}"]`);
			if (el) {
				el.focus();
				try { el.setSelectionRange(focus.start, focus.end); } catch { /* not a text field */ }
			}
		}
		// A narrow toolbar first hides the words "Gateway local", then the view icons; Ligar/Parar never get cut.
		const bar = root.querySelector('.ps-bar');
		for (const level of ['c1', 'c2']) {
			if (bar && bar.scrollWidth > bar.clientWidth + 1) { bar.classList.add(level); }
		}
		const seq = root.querySelector('.ps-seq');
		if (seq && Math.abs(seq.clientWidth - (S.seqWidth || 0)) > 4 && !draw.again) {
			S.seqWidth = seq.clientWidth;
			draw.again = true;
			draw();
			draw.again = false;
		}
	}

	// ------------------------------------------------------------------ first open and starting

	function firstView() {
		const project = S.ctx?.project;
		const endpoint = S.pay?.endpoint || 'http://127.0.0.1:4570';
		const storage = firstStorage();
		const hooks = S.settings.webhooks || {};
		const gateways = table(narrow() ? [['Gateway', 200], ['O que responde', 0], ['Partes emuladas', 170]] : [['Gateway', 220], ['O que responde', 0], ['Partes emuladas', 230]], [
			[`${gwBadge('pix')} ${dim('padrão do Banco Central')}`, 'cobrança imediata, QR Code, Pix recebido', 'cob, loc, webhook, devolução'],
			[`${gwBadge('mercadopago')} ${dim('cartão e Pix')}`, 'pagamentos, cartões de teste, estorno', 'payments, refunds, webhook'],
			[`${gwBadge('stripe')} ${dim('cartão, 3-D Secure')}`, 'PaymentIntents, estorno, contestação', 'payment_intents, eventos'],
			{ c: [`<span class="ps-badge grey">PagSeguro</span> ${dim('e outros')}`, dim('ainda não emulados'), '<span class="ps-badge grey">ainda não</span>'], cls: 'dim' },
		], { cls: 'tall panelbg wrap' });
		const hookRows = GATEWAYS.map(g => [gwBadge(g), hooks[g] ? m(host_(hooks[g])) : dim('o agente procura a rota no código do app e configura')]);
		const options = [['memory', 'Só na memória', 'Começa vazio toda vez. Bom para testes.'], ['persistent', 'Guardar entre sessões', 'As cobranças e os webhooks continuam lá quando você voltar.']]
			.map(([value, title, text]) => `<label class="ps-opt"><input type="radio" name="storage" value="${value}" ${storage === value ? 'checked' : ''} data-act="first-storage"><span><b>${title}</b><small>${text}</small></span></label>`).join('');
		const examples = ['Ligue o gateway de teste e conecte o meu app', 'Pague o Pix do agendamento AG-4830', 'E se o webhook chegar duas vezes?', 'Por que o pagamento com cartão foi recusado?']
			.map(text => `<button class="ps-example" data-act="example" data-text="${esc(text)}">${ic('comment', 'c-dim')}${esc(text)}</button>`).join('');
		const projectNote = project
			? `<div class="ps-text">O agente lê o código do projeto para achar onde o app chama o gateway e as rotas de webhook. Nada é mudado sem você pedir.</div>`
			: note('warning', 'c-you', 'Este Studio não está ligado a um projeto. O gateway funciona, mas o <span class="ps-m">.env.local</span> e as rotas de webhook precisam dos arquivos do projeto: abra o PayStudio a partir do chat de um projeto.');
		return `<div class="ps-first" data-scroll="first">
			<div class="ps-hero">${MARK}<div><h1>Um gateway de pagamento de teste neste computador</h1>
			<p>O PayStudio responde como a API Pix do Banco Central, o Mercado Pago e o Stripe em <span class="ps-m">${esc(endpoint)}</span>. Sem conta, sem internet e sem dinheiro de verdade: só cartões e Pix de teste.<br>O seu código não muda: o endereço da API e as chaves de teste vêm do <span class="ps-m">.env.local</span>.</p></div></div>
			<div class="ps-row top ps-fill" style="gap:12px">
				<div class="ps-col ns" style="flex:1.55">
					${panel('Gateways que o PayStudio emula', gateways, { icon: 'card', right: '<em>3 gateways</em>', pb: 'np', foot: `${ic('info', 'c-dim')}<span class="ps-dim">Cada API é emulada uma a uma, só nas partes que os apps costumam usar.</span>` })}
					${panel('Para onde mandar os webhooks', table([['Gateway', 120], ['Endereço do webhook do app', 0]], hookRows, { cls: 'panelbg wrap' }), { icon: 'send', pb: 'np', foot: `${ic('info', 'c-dim')}<span class="ps-dim">O app precisa estar rodando para receber. O Pix recebe no endereço + <span class="ps-m">/pix</span>, como manda o padrão do Banco Central.</span>` })}
					${panel('Como vai rodar', `${kv([['Endereço', `${m(endpoint)} ${dim('· só este computador')}`], ['Moeda e fuso', `BRL · ${esc(TZ)}`]], 110)}<div class="ps-fl">Onde guardar as cobranças</div>${options}`, { icon: 'gear', style: 'flex:1', pb: '' })}
					${note('slash', 'c-dim', '<b>O que o PayStudio não faz:</b> não fala com nenhum banco nem gateway de verdade, e não substitui a homologação do gateway antes de ir para produção.')}
				</div>
				<div class="ps-col ns" style="flex:1">
					${panel('De onde vêm as chaves de teste', `<div class="ps-text">O PayStudio cria chaves de teste próprias (<span class="ps-m">TEST-</span>, <span class="ps-m">sk_test_</span>, <span class="ps-m">whsec_</span>) que só funcionam aqui. Quando você pedir, o agente grava todas no <span class="ps-m">.env.local</span> do projeto.</div><div class="ps-text small" style="margin-top:8px">${ic('lock', 'c-dim')} As chaves ficam só no <span class="ps-m">.env.local</span>, fora do Git. Não aparecem na conversa.</div>`, { icon: 'key', pb: '' })}
					${panel('Peça ao agente, por exemplo', examples, { icon: 'comment', pb: '' })}
					${panel('Projeto', projectNote, { icon: 'folder', style: 'flex:1', pb: '' })}
				</div>
			</div>
			<div class="ps-row ps-foot-row"><span class="ps-dim">${ic('info', 'c-dim')} Dá para mudar tudo depois em Mais › Configurações.</span><span class="ps-sp"></span>${btn('Ligar o PayStudio', 'play', 'primary', 'data-act="start"')}</div>
		</div>`;
	}

	function startingView() {
		const elapsed = Math.round((Date.now() - S.pending.at) / 1000);
		const steps = [
			['Pedido enviado ao agente', true],
			['O agente chama o PayStudio', elapsed > 1],
			['O gateway abre a porta e responde', false],
		];
		return `<div class="ps-first"><div class="ps-first-in"><div class="ps-panel"><div class="ps-ph">${ic('spinner', 'spin c-run')}Ligando o gateway de teste</div><div class="ps-pb">
			${steps.map(([label, done]) => li(done ? ic('passed', 'c-ok') : ic('spinner', 'spin c-run'), label)).join('')}
			<p class="ps-dim small">Se o JumpCode pedir autorização para usar o PayStudio, aprove na conversa.</p>
		</div></div></div></div>`;
	}

	// ------------------------------------------------------------------ overview

	function overviewView() {
		const pay = S.pay;
		const now = nowSec();
		const started = pay.startedAt || now;
		const charges = S.charges;
		const pix = charges.filter(c => c.method === 'pix').length;
		const paid = charges.filter(c => c.status === 'paga');
		const pending = charges.filter(c => ['pendente', 'em_analise'].includes(c.status));
		const lastCreated = Math.max(0, ...charges.map(c => c.created || 0));
		const lastPaid = Math.max(0, ...charges.map(c => c.paid || 0));
		const hooks = S.deliveries;
		const answered = hooks.filter(d => d.attempts.some(attemptOk) && d.signature !== 'wrong').length;
		const failing = failingHooks();
		const waiting = hooks.filter(d => !d.attempts.length && ['pending', 'held'].includes(d.state)).length;
		const lastHook = Math.max(0, ...hooks.map(d => lastAttempt(d)?.at || d.created || 0));
		const box = (view, icon, title, right, lines, foot, mk) => `<div class="ps-box mk mk-${mk}" data-act="view" data-view="${view}"><div class="ps-ph">${ic(icon)}<span class="t">${title}</span><span class="r"><em>${right}</em></span></div><div class="bb">${lines.map(([a, b]) => `<div class="bl"><span>${a}</span>${b ? `<em>${b}</em>` : ''}</div>`).join('')}</div><div class="bf">${ic('history')}${foot}</div></div>`;
		const flagged = charges.some(c => c.flags.length);
		const boxes = [
			box('charges', 'card', 'Cobranças', String(charges.length), [[`${brl(sum(charges))} no total`, ''], [`Pix ${pix} · cartão ${charges.length - pix}`, '']], lastCreated ? `última às ${clock(lastCreated)}` : 'nenhuma ainda', flagged ? 'you' : 'ok'),
			box('charges', 'passed', 'Recebido', tight() ? '' : brl(sum(paid)), [[plural(paid.length, 'paga', 'pagas'), brl(sum(paid))], [plural(pending.length, 'pendente', 'pendentes'), brl(sum(pending))]], lastPaid ? `último pago às ${clock(lastPaid)}` : 'nenhum pagamento ainda', 'ok'),
			box('webhooks', 'send', 'Webhooks', String(hooks.length), [[`${answered} com resposta 2xx`, ''], [failing.length ? `${ic('error', 'c-bad')} ${failing.length} falhando` : waiting ? `${ic('clock', 'c-run')} ${waiting} esperando para sair` : `${ic('passed', 'c-ok')} nenhum falhando`, '']], lastHook ? `último às ${clock(lastHook)}` : 'nenhum ainda', failing.length ? 'bad' : 'ok'),
			box('catalog', 'server', 'Gateways ativos', String(Object.keys(pay.gateways || {}).length), [[tight() ? 'Pix, Mercado Pago, Stripe' : 'Pix · Mercado Pago · Stripe', ''], [esc(host_(pay.endpoint)), 'BRL']], `ligado às ${clock(pay.startedAt)}`, 'ok'),
		].join('');
		const order = Object.keys(STATUS).filter(s => pay.totals?.[s]);
		const maxAmount = Math.max(1, ...order.map(s => pay.totals[s].amount || 0));
		const statusRows = order.map(s => [stBadge(s), String(pay.totals[s].count), brl(pay.totals[s].amount), `<div class="ps-bar8"><i style="width:${Math.round(100 * (pay.totals[s].amount || 0) / maxAmount)}%"></i></div>`]);
		statusRows.push({ c: ['<b>Total</b>', `<b>${charges.length}</b>`, `<b>${brl(sum(charges))}</b>`, ''] });
		const statusTable = order.length ? table([['Status', 98], ['Qtd.', 46, 'r'], ['Valor', 92, 'r'], ['', 0]], statusRows, { cls: 'panelbg' }) : '<div class="ps-empty">Nenhuma cobrança ainda.</div>';
		const attention = attentionItems();
		const attentionList = attention.length
			? attention.map((a, i) => `<div class="ps-li att" style="--mk:var(--ps-m-${a.mk})">${ic(a.mk === 'bad' ? 'error' : 'warning', a.mk === 'bad' ? 'c-bad' : 'c-you')}<b class="ps-m" title="${esc(a.label)}">${esc(a.label)}</b>${tx(esc(a.text))}<span class="ps-sp"></span>${btn('Abrir', '', 'sm', `data-act="attention" data-i="${i}"`)}</div>`).join('')
			: `<div class="ps-empty">${ic('passed', 'c-ok')} Nada pedindo atenção agora.</div>`;
		const events = recentEvents().slice(0, 40);
		const eventRows = events.map((e, i) => ({ c: [clock(e.at), gwBadge(e.gateway), `${esc(e.text)}`, esc(e.booking || '—'), e.amount !== null ? brl(e.amount) : dim('—'), e.app === null ? dim('—') : e.app], cls: `${e.mk ? `mk-${e.mk}` : ''}`, attrs: `data-act="event" data-i="${i}"` }));
		const connected = GATEWAYS.some(g => pay.gateways?.[g]?.url);
		const eventTable = events.length ? table([['Hora', 76, 'm'], ['Gateway', 108], ['Evento', 0], ['Agend.', 92, 'm'], ['Valor', 84, 'r'], ['App', 70, 'r']], eventRows, { cls: 'wrap' })
			: `<div class="ps-empty">Nada aconteceu ainda. Quando o app criar uma cobrança, ela aparece aqui com os webhooks que o PayStudio mandar.${connected ? '' : `<div class="ps-row" style="margin-top:10px">${btn('Conectar o app', 'plug', 'primary', 'data-act="connect"')}<span class="ps-dim">O agente acha as rotas de webhook no código e configura o PayStudio.</span></div>`}</div>`;
		S.eventCache = events;
		const gatewayRows = GATEWAYS.filter(g => pay.gateways?.[g]).map(g => {
			const info = pay.gateways[g];
			const bad = S.deliveries.filter(d => d.gateway === g && hookFailing(d)).length;
			return { c: [gwBadge(g), String(info.charges), `${info.webhooks}${bad ? ` · ${ic('error', 'c-bad')}${bad}` : ''}`], attrs: `data-act="catalog-gw" data-id="${g}"` };
		});
		const appHosts = [...new Set(GATEWAYS.map(g => pay.gateways?.[g]?.url).filter(Boolean).map(url => { try { return new URL(url).host; } catch { return ''; } }).filter(Boolean))];
		const session = kv([
			['Ligado desde', `${clock(pay.startedAt)} · ${since(pay.startedAt)}`],
			['Endereço', m(host_(pay.endpoint))],
			['Webhooks vão para', appHosts.length ? m(appHosts.join(', ')) : dim('nenhum endereço ainda')],
			['Chamadas', `${pay.calls ?? S.callTotal} do app aos gateways`],
			['Dados', pay.storage === 'persistent' ? 'guardados entre sessões' : 'só na memória'],
			['Dinheiro real', 'nenhum · R$ 0,00'],
			['Fuso', esc(TZ)],
		], 110);
		const today = `${sameDay(started, now) ? `Hoje, ${date(now)}` : `Desde ${date(started)}`}<em>${sameDay(started, now) ? `desde ${hm(started)}` : `às ${hm(started)}`} · agora ${hm(now)}</em>`;
		return `<div class="ps-main"><div class="ps-row top ps-grow" style="padding:10px;gap:10px">
			<div class="ps-col ps-grow">
				<div class="ps-h">${ic('calendar', 'c-txt')}${today}<span class="r">${btn('Cobranças', 'card', 'sm', 'data-act="view" data-view="charges"')}${btn('Webhooks', 'send', 'sm', 'data-act="view" data-view="webhooks"')}</span></div>
				<div class="ps-boxes">${boxes}</div>
				<div class="ps-row top" style="gap:10px">${panel('Valores por status', statusTable, { icon: 'graph', pb: 'np', style: `flex:0 0 ${narrow() ? 300 : 340}px` })}${panel('Precisa de atenção', attentionList, { icon: 'warning', pb: 'np', right: `<em>${attention.length}</em>`, style: 'flex:1;max-height:250px', scroll: 'attention' })}</div>
				${panel('Eventos recentes', eventTable, { icon: 'pulse', pb: 'np', right: btn('Ver todos', '', 'sm', 'data-act="timeline-all"'), style: 'flex:1', scroll: 'events' })}
			</div>
			<div class="ps-col" style="flex:0 0 ${tight() ? 256 : 278}px">
				${panel('Gateways ativos', table([['Gateway', 0], ['Cobranças', tight() ? 78 : 84, 'r'], ['Webhooks', tight() ? 78 : 86, 'r']], gatewayRows, { cls: `panelbg ${tight() ? 'compact' : ''}` }), { icon: 'server', pb: 'np' })}
				${panel('Esta sessão', session, { icon: 'pulse', pb: 'tight' })}
				${panel('Limites', '<div class="ps-text">Cada gateway é emulado um a um, só nas partes que os apps costumam usar.</div><div class="ps-text">Antes de ir para produção, faça a homologação no sandbox de cada gateway. O PayStudio não substitui essa etapa.</div>', { icon: 'info', style: 'flex:1' })}
			</div>
		</div></div>`;
	}

	/** What needs attention, from pay.json, with where "Abrir" goes. */
	function attentionItems() {
		const seen = new Set();
		const items = [];
		for (const a of S.pay?.attention || []) {
			const key = `${a.kind}|${a.ref}|${a.text}`;
			if (seen.has(key)) { continue; }
			seen.add(key);
			const mk = ['webhook', 'signature'].includes(a.kind) ? 'bad' : 'you';
			items.push({ ...a, mk, label: a.booking || GW[a.gateway]?.label || a.gateway || '' });
		}
		// Webhooks the app is answering with errors while the gateway still retries (pay.json lists only the ones that gave up).
		const failing = {};
		for (const d of failingHooks()) { const key = `${d.gateway}|${d.booking || d.ref}`; (failing[key] = failing[key] || []).push(d); }
		for (const list of Object.values(failing)) {
			const d = list[0];
			if (items.some(a => a.kind === 'webhook' && list.some(x => x.ref === a.ref))) { continue; }
			const statuses = [...new Set(list.map(x => lastAttempt(x).status ?? 'sem resposta'))].join(', ');
			items.push({ kind: 'webhook', ref: d.ref, gateway: d.gateway, booking: d.booking, mk: 'bad', label: d.booking || GW[d.gateway].label, text: `app respondeu ${statuses} a ${plural(list.length, 'webhook', 'webhooks')} ${GW[d.gateway].of}; o PayStudio tenta de novo` });
		}
		S.attentionCache = items;
		return items;
	}

	function recentEvents() {
		const rows = [];
		for (const c of S.charges) {
			for (const e of c.events || []) {
				if (e.kind === 'webhook') { continue; }
				rows.push({ at: e.at, gateway: c.gateway, text: e.text, booking: c.booking, amount: c.amount, app: null, mk: e.kind === 'bad' ? 'you' : '', charge: chargeKey(c) });
			}
		}
		for (const d of S.deliveries) {
			const a = lastAttempt(d);
			const c = chargeOf(d.ref);
			const text = `${d.event}${d.attempts.length > 1 ? ` · tentativa ${d.attempts.length}` : ''}${d.signature === 'wrong' ? ' · assinatura errada' : d.copy_of ? ` · cópia de #${d.copy_of}` : ''}${!a ? ` · ${d.state === 'held' ? 'segurado' : `sai às ${clock(d.due)}`}` : ''}`;
			rows.push({ at: a ? a.at : d.created, gateway: d.gateway, text, booking: d.booking, amount: c ? c.amount : null, app: a ? attemptStatus(d, a) : null, mk: hookFailing(d) || hookForged(d) ? 'bad' : '', hook: d.id });
		}
		return rows.sort((a, b) => b.at - a.at);
	}

	// ------------------------------------------------------------------ charges

	function chargesView() {
		if (S.chargeOpen) {
			const open = findCharge(S.sel);
			if (open) { return chargeDetail(open); }
			S.chargeOpen = false;
		}
		const text = S.chargeText.trim().toLowerCase();
		const base = S.charges.filter(c => (S.chargeGw === 'all' || c.gateway === S.chargeGw)
			&& (!text || [c.booking, c.customer, c.ref, c.gatewayStatus, STATUS[c.status]].some(v => String(v || '').toLowerCase().includes(text))));
		const counts = {};
		base.forEach(c => { counts[c.status] = (counts[c.status] || 0) + 1; });
		const tab = S.chargeTab === 'all' || counts[S.chargeTab] ? S.chargeTab : 'all';
		const list = tab === 'all' ? base : base.filter(c => c.status === tab);
		let sel = findCharge(S.sel);
		if (!sel || !list.includes(sel)) {
			sel = list.find(c => c.flags.length) || list[0];
		}
		const tabs = `<div class="ps-tabs">${[['all', 'Todas']].concat(TABS.filter(([id]) => counts[id])).map(([id, label]) => `<button class="ps-tab ${tab === id ? 'on' : ''}" data-act="charge-tab" data-id="${id}">${label} <em>${id === 'all' ? base.length : counts[id]}</em></button>`).join('')}</div>`;
		const rows = list.slice(0, 400).map(c => {
			const hookBad = S.deliveries.some(d => d.ref === c.ref && hookProblem(d));
			const mk = hookBad ? 'mk-bad' : c.flags.length || (c.status === 'expirada') ? 'mk-you' : '';
			const flag = c.flags.length ? `${ic('warning', 'c-you')}` : '';
			return { c: [clock(c.created), `${flag}${esc(c.booking || '—')}`, `<span title="${esc(c.customer || '')}">${esc(c.customer || '—')}</span>`, brl(c.amount), gwBadge(c.gateway), meio(c), stBadge(c.status), `<span title="${esc(c.gatewayStatus || '')}">${esc(c.gatewayStatus || '')}</span>`, `<span title="${esc(c.ref)}">${esc(c.ref)}</span>`], cls: `${mk} ${sel === c ? 'sel' : ''}`, attrs: `data-act="charge" data-key="${esc(chargeKey(c))}"` };
		});
		const grid = rows.length
			? table(...columns(narrow()
				? [['Hora', 68, 'm'], ['Agend.', 92, 'm'], ['Cliente', 140], ['Valor', 76, 'r'], ['Gateway', 104], ['Meio', 136], ['Status', 90], tight() ? null : ['No gateway', 0], ['ID no gateway', tight() ? 0 : 200, 'm']]
				: [['Hora', 72, 'm'], ['Agend.', 96, 'm'], ['Cliente', 168], ['Valor', 80, 'r'], ['Gateway', 104], ['Meio', 134], ['Status', 90], ['No gateway', 210], ['ID no gateway', 0, 'm']], rows))
			: `<div class="ps-empty">${S.charges.length ? 'Nenhuma cobrança com esses filtros.' : 'Nenhuma cobrança ainda. Conecte o app (Mais › Configurações) e faça um agendamento de teste: cada cobrança que o app criar aparece aqui.'}</div>`;
		const gwOptions = [['all', 'Gateway: todos']].concat(GATEWAYS.map(g => [g, GW[g].label])).map(([value, label]) => `<option value="${value}" ${S.chargeGw === value ? 'selected' : ''}>${label}</option>`).join('');
		const strip = `<div class="ps-strip"><span class="ps-in" style="width:280px">${ic('filter')}<input data-act="charge-text" data-draft="charge-text" placeholder="Filtrar por agendamento, cliente ou id" value="${esc(S.chargeText)}"></span>
			<select class="ps-in" data-act="charge-gw" style="width:140px">${gwOptions}</select><span class="ps-sp"></span>
			<span class="ps-count">${plural(list.length, 'cobrança', 'cobranças')} · ${brl(sum(list))}</span></div>`;
		return `<div class="ps-main">${strip}${tabs}<div class="ps-scroll" data-scroll="charges">${grid}</div>
			${sel ? `<div class="ps-row top" style="flex:0 0 auto;min-height:182px;max-height:48%;gap:10px;padding:10px;border-top:1px solid #3F3F46">${chargeSummary(sel)}</div>` : ''}</div>`;
	}

	function chargeSummary(c) {
		const key = esc(chargeKey(c));
		const left = panel(`Cobrança ${esc(shortRef(c.ref))} · ${esc(c.booking || 'sem agendamento')}${c.customer ? ` · ${esc(c.customer)}` : ''}`, kv([
			['ID no gateway', `${m(c.ref)} ${gwBadge(c.gateway)}`],
			['Situação', `${m(c.gatewayStatus || '—')} ${dim(`· ${esc(STATUS[c.status] || c.status)}`)}`],
			['Valor', `${brl(c.amount)}${c.refunded ? dim(` · estornado ${brl(c.refunded)}`) : ''}`],
			['Meio', meio(c)],
			['Criada', `${clock(c.created)}${c.paid ? dim(` · paga às ${clock(c.paid)}`) : c.expires && c.status === 'pendente' ? dim(` · vence ${clock(c.expires)}`) : ''}`],
		], 118), { icon: 'card', mk: c.flags.length ? 'you' : '', pb: 'tight', style: 'flex:1.1', right: btn('Abrir', '', 'sm', `data-act="charge-open" data-key="${key}"`) });
		const flags = c.flags.map(f => note('warning', 'c-you', esc(f.text))).join('');
		const hooks = S.deliveries.filter(d => d.ref === c.ref && hookProblem(d));
		const why = c.status === 'recusada' && declineCode(c) ? note('info', 'c-run', `Recusado: <b>${esc(REASONS[declineCode(c)] || declineCode(c))}</b> (<span class="ps-m">${esc(declineCode(c))}</span>).`) : '';
		const hookNote = hooks.length ? note('error', 'c-bad', `${plural(hooks.length, 'webhook desta cobrança tem', 'webhooks desta cobrança têm')} problema: ${esc(hookStateText(hooks[0]))}.`) : '';
		const notes = flags + hookNote + why || `<div class="ps-text">${chargeHint(c)}</div>`;
		const actions = quickActions(c);
		const title = c.flags.some(f => f.kind === 'duplicate') ? 'Cobrança duplicada' : hooks.length ? 'Webhooks com problema' : 'O que dá para fazer';
		const right = panel(title, `<div class="ps-col" style="gap:8px">${notes}<div class="ps-row" style="gap:6px;flex-wrap:wrap">${actions}</div></div>`, { icon: c.flags.length || hooks.length ? 'warning' : 'play', style: 'flex:1' });
		return left + right;
	}

	function chargeHint(c) {
		if (canPay(c) && c.method === 'pix') { return 'Ninguém pagou ainda. Dá para pagar como o cliente, com o webhook na hora, atrasado ou duplicado, ou deixar vencer.'; }
		if (c.gateway === 'stripe' && c.gatewayStatus === 'requires_action') { return 'O banco pediu autenticação 3-D Secure. O agente pode concluir o desafio como o cliente.'; }
		if (c.gateway === 'stripe' && c.status === 'pendente') { return 'O PaymentIntent ainda espera o cartão. Quem confirma um pagamento com cartão no Stripe é o app (confirm).'; }
		if (canRefund(c)) { return `Paga às ${clock(c.paid)}. Dá para estornar${canDispute(c) ? ' ou simular uma contestação do titular' : ''}.`; }
		if (c.status === 'expirada') { return 'O Pix venceu sem pagamento. No padrão do Banco Central nenhum webhook avisa: o app precisa perceber sozinho.'; }
		if (c.status === 'contestada') { return 'O titular contestou a compra. O gateway avisou o app com um webhook.'; }
		if (c.status === 'estornada') { return `Estornada: ${brl(c.refunded)} voltaram para o cliente.`; }
		return 'Abra a cobrança para ver a linha do tempo, as chamadas do app e os webhooks.';
	}

	/** Buttons for the charge strip; each one asks the agent. */
	function quickActions(c) {
		const key = esc(chargeKey(c));
		const out = [];
		if (canPay(c)) {
			out.push(btn(c.method === 'pix' ? 'Pagar o Pix' : c.gateway === 'stripe' ? 'Autenticar 3-D Secure' : 'Aprovar o pagamento', 'check', 'sm primary', `data-act="pay" data-key="${key}"`));
		}
		if (canExpire(c)) { out.push(btn('Deixar vencer', 'clock', 'sm', `data-act="expire" data-key="${key}"`)); }
		if (canRefund(c)) { out.push(btn('Estornar', 'undo', 'sm', `data-act="refund-all" data-key="${key}"`)); }
		if (c.status === 'recusada') { out.push(btn('Por que foi recusado?', 'comment', 'sm', `data-act="why" data-key="${key}"`)); }
		if (c.status === 'expirada') { out.push(btn('O app liberou o horário?', 'comment', 'sm', `data-act="expired-check" data-key="${key}"`)); }
		if (S.deliveries.some(d => d.ref === c.ref)) { out.push(btn('Webhooks', 'send', 'sm', `data-act="hooks-of" data-key="${key}"`)); }
		if (c.booking) { out.push(btn('Linha do tempo', 'commit', 'sm', `data-act="timeline-of" data-key="${key}"`)); }
		out.push('<span class="ps-sp"></span>', btn('Abrir', 'arrowR', 'sm', `data-act="charge-open" data-key="${key}"`));
		return out.join('');
	}

	function chargeHead(c) {
		const duplicate = c.flags.some(f => f.kind === 'duplicate');
		return `<div class="ps-strip">${btn('', 'arrowL', 'sm ib', 'data-act="charge-back" title="Voltar para a lista"')}<span class="ps-dim">Cobranças ›</span><b>${esc(c.booking || shortRef(c.ref))}${c.customer ? ` · ${esc(c.customer)}` : ''}</b>${gwBadge(c.gateway)}${stBadge(c.status, '')}${duplicate ? '<span class="ps-badge you">duplicada</span>' : ''}
			<span class="ps-sp"></span><span title="${esc(service(c))}">${brl(c.amount)}${service(c) ? ` · ${esc(service(c))}` : ''}</span>${c.status === 'pendente' && c.expires ? dim(`· vence ${clock(c.expires)}`) : ''}</div>`;
	}

	function chargeFields(c) {
		const d = c.details || {};
		const now = nowSec();
		if (c.gateway === 'pix') {
			const word = c.status === 'pendente' ? 'esperando pagamento' : c.status === 'paga' ? `paga às ${clock(c.paid)}` : c.status === 'expirada' ? 'venceu; no padrão do Banco Central continua ATIVA' : STATUS[c.status];
			const expiry = c.expires ? (c.status === 'pendente' ? `vence ${clock(c.expires)} · faltam <span data-left="${c.expires}">${mmss(c.expires - now)}</span>` : c.expires < now ? `venceu ${clock(c.expires)}, há ${since(c.expires)}` : `vencia ${clock(c.expires)}`) : '';
			return [
				['txid', m(d.txid || c.ref)],
				['status', `${m(c.gatewayStatus)} ${dim(`· ${esc(word)}`)}`],
				['calendario.criacao', `${m(iso(c.created))} ${dim(`· ${clock(c.created)}`)}`],
				['calendario.expiracao', c.expires ? `${m(Math.round(c.expires - c.created))} ${dim(`· ${expiry}`)}` : dim('—')],
				['devedor', `${esc(d.devedor?.nome || '—')} ${dim(`· CPF ${maskCpf(d.devedor?.cpf)}`)}`],
				['valor.original', m(`"${reais(c.amount)}"`)],
				['chave', m(d.chave || '—')],
				['solicitacaoPagador', esc(d.solicitacaoPagador || '—')],
				['loc.location', m(d.location || '—')],
				d.e2eids?.length ? ['endToEndId', m(d.e2eids.join(', '))] : null,
				d.devolucoes?.length ? ['devoluções', `${plural(d.devolucoes.length, 'devolução', 'devoluções')}${c.refunded ? ` · ${brl(c.refunded)}` : ''}`] : null,
			];
		}
		if (c.gateway === 'mercadopago') {
			return [
				['id', m(d.id || c.ref)],
				['status · status_detail', m(c.gatewayStatus || '—')],
				['transaction_amount', `${m(reais(c.amount))} ${dim(`· ${brl(c.amount)}`)}`],
				['payment_method_id', m(d.payment_method_id || '—')],
				d.card ? ['cartão', `${esc(brand(d.card.brand))} •••• ${esc(d.card.last_four_digits || '')} ${dim(`· titular ${esc(d.card.cardholder?.name || '—')}`)}`] : null,
				['external_reference', m(d.external_reference || '—')],
				['X-Idempotency-Key', d.idempotency ? m(d.idempotency) : `${ic('error', 'c-bad')}não enviada`],
				['payer.email', esc(c.customer || '—')],
				['notification_url', d.notification_url ? m(d.notification_url) : dim('não enviada · vale a do PayStudio')],
				c.refunded ? ['estornado', brl(c.refunded)] : null,
			];
		}
		const error = d.last_payment_error;
		return [
			['id', m(d.id || c.ref)],
			['status', m(c.gatewayStatus || '—')],
			['amount', `${m(c.amount)} ${dim(`· ${brl(c.amount)}`)}`],
			['payment_method', m(d.payment_method || '—')],
			d.card ? ['cartão', `${esc(brand(d.card.brand))} •••• ${esc(d.card.last4 || '')} ${dim(`· validade ${pad(d.card.exp_month)}/${String(d.card.exp_year || '').slice(-2)}`)}`] : null,
			['Idempotency-Key', d.idempotency ? m(d.idempotency) : dim('não enviada')],
			error ? ['last_payment_error', `${m(error.code || '')} ${error.decline_code ? m(`· ${error.decline_code}`) : ''} ${dim(esc(error.message || ''))}`] : null,
			d.dispute ? ['dispute', m(d.dispute)] : null,
			['metadata.booking', m(d.metadata?.booking || c.booking || '—')],
			c.refunded ? ['estornado', brl(c.refunded)] : null,
		];
	}

	function chargeTimeline(c, pendingRow) {
		const rows = chargeRows(c).map(r => ({ c: [clock(r.at, true), esc(r.who), r.what, r.res], cls: r.mk ? `mk-${r.mk}` : '', attrs: r.hook ? `data-act="hook" data-id="${r.hook}"` : '' }));
		if (pendingRow) {
			rows.push({ c: ['agora', 'PayStudio', `${ic('spinner', 'spin c-run')}esperando o pagador${c.expires ? ` · vence ${clock(c.expires)}` : ''}`, dim('—')], cls: 'mk-run' });
		}
		return rows.length ? table([['Hora', 104, 'm'], ['Quem', 132], ['O quê', 0], ['Resposta', 92, 'r']], rows, { cls: 'panelbg' }) : '<div class="ps-empty">Nenhuma chamada do app para esta cobrança ainda.</div>';
	}

	function chargeDetail(c) {
		const key = esc(chargeKey(c));
		const pendingPix = c.status === 'pendente' && c.qr;
		const fields = panel(c.gateway === 'pix' ? 'Cobrança imediata (cob) · API Pix' : c.gateway === 'mercadopago' ? 'Pagamento · Mercado Pago' : 'PaymentIntent · Stripe', kv(chargeFields(c), 150), { icon: 'receipt', mk: c.status === 'pendente' ? 'run' : c.flags.length ? 'you' : '', pb: 'tight' });
		if (pendingPix) {
			const copia = c.details?.pixCopiaECola || '';
			const qr = `<div class="ps-panel" style="flex:0 0 250px"><div class="ps-ph">${ic('mobile')}<span class="t">QR Code</span><span class="r"><em>só vale aqui</em></span></div><div class="ps-pb" style="padding:12px;display:flex;flex-direction:column;gap:10px">
				<div class="ps-qr"><img src="${esc(c.qr)}" alt="QR Code do Pix"></div>
				<div><div class="ps-row" style="margin-bottom:4px"><b>Pix Copia e Cola</b><span class="ps-sp"></span>${btn('Copiar', 'copy', 'sm', `data-act="copy" data-text="${esc(copia)}"`)}</div><div class="ps-emv">${esc(copia)}</div></div>
				<div class="ps-dim small">Nenhum banco reconhece este QR Code: o endereço é deste computador. Para pagar, use <b>Simular pagamento</b>.</div></div></div>`;
			return `<div class="ps-main">${chargeHead(c)}<div class="ps-row top ps-grow ps-pad">${qr}
				<div class="ps-col ns ps-grow ps-scrollv" data-scroll="charge-pix">${fields}${panel('Linha do tempo desta cobrança', chargeTimeline(c, true), { icon: 'commit', pb: 'np', style: 'flex:0 1 auto', scroll: 'charge-tl' })}${panel('Simular', simulate(c), { icon: 'play', style: 'flex:1;min-height:150px' })}</div></div></div>`;
		}
		const top = duplicateCompare(c) || happened(c);
		const side = `<div class="ps-col" style="flex:1">${panel(c.flags.length ? 'Atenção' : 'O que conferir', explainCharge(c), { icon: c.flags.length ? 'warning' : 'info', pb: '', style: 'flex:1' })}${panel('Ações do cliente', simulate(c), { icon: 'play', pb: '' })}</div>`;
		return `<div class="ps-main">${chargeHead(c)}<div class="ps-col ns ps-grow ps-pad ps-scrollv" data-scroll="charge-detail">${top}
			<div class="ps-row top" style="gap:10px">${`<div class="ps-col" style="flex:1.25">${fields}</div>`}${side}</div>
			${panel('Chamadas e webhooks desta cobrança', chargeTimeline(c, false), { icon: 'swap', pb: 'np', style: 'flex:1;min-height:110px', scroll: 'charge-tl', right: btn('Linha do tempo', 'commit', 'sm', `data-act="timeline-of" data-key="${key}"`) })}
		</div></div>`;
	}

	/** "O que aconteceu": the charge's events on a horizontal line. */
	function happened(c) {
		let events = (c.events || []).filter(e => e.kind !== 'webhook');
		if (events.length > 6) { events = events.slice(0, 2).concat(events.slice(-4)); }
		const points = events.map(e => ({ at: e.at, text: e.text, mk: eventMark(e.kind) }));
		points.push({ at: nowSec(), text: `agora: ${STATUS[c.status]}`, mk: '', now: true });
		const n = points.length;
		const width = 100 / n;
		const marks = points.map((p, i) => {
			const x = n === 1 ? 50 : i * 100 / (n - 1);
			const left = Math.min(100 - width, Math.max(0, x - width / 2));
			const align = i === 0 ? 'left' : i === n - 1 ? 'right' : 'center';
			return `<span class="pt ${p.mk}" style="left:${x}%"></span><span class="lb" style="left:${left}%;width:${width}%;text-align:${align}" title="${esc(p.text)}"><b>${p.now ? 'agora' : clock(p.at)}</b>${esc(p.now ? STATUS[c.status] : p.text)}</span>`;
		}).join('');
		const mk = c.status === 'expirada' || c.status === 'contestada' ? 'you' : c.status === 'recusada' ? 'bad' : c.status === 'paga' ? 'ok' : '';
		return panel('O que aconteceu', `<div class="ps-tl"><span class="ln"></span>${marks}</div>`, { icon: 'commit', mk, pb: 'np' });
	}

	/** Two charges made by the same purchase: their create calls side by side. */
	function duplicateCompare(c) {
		const flag = c.flags.find(f => f.kind === 'duplicate');
		const other = flag && S.charges.find(x => x.gateway === c.gateway && x.ref === flag.other);
		if (!other) { return ''; }
		const create = x => S.calls.filter(k => k.ref === x.ref && k.method === 'POST').sort((a, b) => a.at - b.at)[0];
		const a = create(other);
		const b = create(c);
		if (!a || !b) { return ''; }
		const flat = (value, prefix = '') => Object.entries(value || {}).flatMap(([k, v]) => v && typeof v === 'object' && !Array.isArray(v) ? flat(v, `${prefix}${k}.`) : [[`${prefix}${k}`, v]]);
		const fa = Object.fromEntries(flat(parse(a.req)));
		const fb = Object.fromEntries(flat(parse(b.req)));
		const fields = [...new Set(Object.keys(fa).concat(Object.keys(fb)))].filter(k => k !== 'description').slice(0, 6);
		const header = c.gateway === 'mercadopago' ? 'X-Idempotency-Key' : 'Idempotency-Key';
		const key = k => k.idempotency ? m(k.idempotency) : `${ic('error', 'c-bad')}não enviada`;
		const rows = [
			['Enviada', m(clock(a.at, true)), `${m(clock(b.at, true))} ${dim(`· ${gap(b.at - a.at)} depois`)}`],
			{ c: [m(header), key(a), key(b)], cls: !a.idempotency || !b.idempotency ? 'mk-you' : '' },
			...fields.map(f => [m(f), m(fa[f] ?? '—'), m(fb[f] ?? '—')]),
			['Resposta', `${a.status} · ${m(other.ref)}`, `${b.status} · ${m(c.ref)}`],
			['Tempo', ms(a.ms), ms(b.ms)],
		];
		return panel(`As duas chamadas · ${m(`${b.method} ${b.path}`)}`, table([['Campo', 210], ['1ª chamada', 0], ['2ª chamada', 0]], rows, { cls: 'panelbg' }), { icon: 'swap', mk: 'you', pb: 'np' });
	}

	function explainCharge(c) {
		const out = [];
		for (const f of c.flags) {
			out.push(note('warning', 'c-you', f.kind === 'duplicate'
				? `${esc(f.text)}. Sem a chave de idempotência, o gateway não tem como saber que é a mesma compra. Com a mesma chave nas duas chamadas, ele devolve a primeira cobrança em vez de cobrar de novo.`
				: esc(f.text)));
		}
		const hooks = S.deliveries.filter(d => d.ref === c.ref && hookProblem(d));
		if (hooks.length) {
			out.push(note('error', 'c-bad', `${hooks.map(d => `Webhook #${d.id} (${esc(d.event)}): ${esc(hookStateText(d))}`).join('<br>')}`));
		}
		if (c.status === 'expirada' && c.gateway === 'pix') {
			out.push(note('info', 'c-run', 'No padrão do Banco Central, a cobrança vencida continua <span class="ps-m">ATIVA</span> e não avisa ninguém: quem percebe o vencimento é o app. Confira se ele liberou o horário.'));
		}
		if (c.status === 'recusada' && declineCode(c)) {
			out.push(note('info', 'c-run', `O cartão foi recusado: <b>${esc(REASONS[declineCode(c)] || declineCode(c))}</b> (<span class="ps-m">${esc(declineCode(c))}</span>). É o esperado com este cartão de teste; confira se o app mostra a mensagem certa ao cliente.`));
		}
		if (c.status === 'contestada') {
			const hook = S.deliveries.find(d => d.ref === c.ref && /dispute|chargeback/.test(d.event));
			const due = hook?.payload?.data?.object?.evidence_details?.due_by;
			const reason = hook?.payload?.data?.object?.reason;
			out.push(note('warning', 'c-you', `O titular contestou a compra${reason ? ` (motivo <span class="ps-m">${esc(reason)}</span>)` : ''}. ${hook ? `O gateway avisou o app com <span class="ps-m">${esc(hook.event)}</span>.` : ''}${due ? ` Prazo simulado para responder: ${date(due)}.` : ''}`));
		}
		if (c.status === 'estornada' || c.status === 'estorno_parcial') {
			out.push(note('info', 'c-run', `${brl(c.refunded)} voltaram para o cliente. O gateway avisa o app; confira se o horário foi liberado.`));
		}
		if (c.gateway === 'stripe' && c.gatewayStatus === 'requires_action') {
			out.push(note('info', 'c-run', 'O banco pediu autenticação 3-D Secure (<span class="ps-m">requires_action</span>). O app deve levar o cliente ao desafio; aqui o agente conclui como o cliente.'));
		}
		return out.length ? `<div class="ps-col" style="gap:8px">${out.join('')}</div>` : `<div class="ps-text">${chargeHint(c)}</div>`;
	}

	/** The payer's side: pay (with a late or doubled webhook), let it expire, refund, dispute. */
	function simulate(c) {
		const key = chargeKey(c);
		const k = esc(key);
		const blocks = [];
		if (canPay(c) && c.method === 'pix') {
			const delay = draft(`delay:${key}`, '0');
			const twice = draft(`dup:${key}`, false);
			const options = [['0', 'na hora'], ['30', '30 s depois'], ['120', '2 min depois'], ['600', '10 min depois']].map(([v, l]) => `<option value="${v}" ${delay === v ? 'selected' : ''}>${l}</option>`).join('');
			const url = S.pay?.gateways?.[c.gateway]?.url;
			blocks.push(`<div class="ps-kv" style="grid-template-columns:118px minmax(0,1fr)"><span>Valor</span><span>${brl(c.amount)} ${dim('· o valor da cobrança')}</span>
				<span>Webhook</span><span><select class="ps-in" data-draft="delay:${k}" style="width:170px">${options}</select>${url ? dim(`· para ${esc(host_(url))}${c.gateway === 'pix' ? '/pix' : ''}`) : dim('· o app ainda não tem endereço de webhook')}</span>
				<span></span><span><label class="ps-check"><input type="checkbox" data-draft="dup:${k}" ${twice ? 'checked' : ''}>Mandar o webhook duas vezes</label></span></div>
				<div class="ps-actions" style="justify-content:flex-start">${btn('Simular pagamento', 'check', 'primary', `data-act="pay" data-key="${k}"`)}${canExpire(c) ? btn('Deixar vencer', 'clock', '', `data-act="expire" data-key="${k}"`) : ''}<span class="ps-sp"></span><span class="ps-dim small">O agente paga como o cliente; o PayStudio manda o webhook.</span></div>`);
		} else if (canPay(c)) {
			blocks.push(`<div class="ps-row" style="flex-wrap:wrap">${btn(c.gateway === 'stripe' ? 'Autenticar 3-D Secure' : 'Aprovar o pagamento', 'check', 'primary', `data-act="pay" data-key="${k}"`)}<span class="ps-dim small">${c.gateway === 'stripe' ? 'O cliente confirma o desafio do banco; o Stripe manda payment_intent.succeeded.' : 'O pagamento em análise é aprovado; o Mercado Pago avisa o app.'}</span></div>`);
		}
		if (canRefund(c)) {
			const mode = draft(`refund:${key}`, 'total');
			blocks.push(`<div class="ps-row" style="flex-wrap:wrap"><span class="ps-dim" style="width:66px">Estorno</span><label class="ps-check"><input type="radio" name="refund-${k}" value="total" data-draft="refund:${k}" ${mode === 'total' ? 'checked' : ''}>Total</label>
				<label class="ps-check"><input type="radio" name="refund-${k}" value="partial" data-draft="refund:${k}" ${mode === 'partial' ? 'checked' : ''}>Parcial</label>
				<span class="ps-in m" style="width:96px">R$<input data-draft="refund-value:${k}" value="${esc(draft(`refund-value:${key}`, ''))}" placeholder="0,00"></span><span class="ps-sp"></span>${btn('Estornar', 'undo', '', `data-act="refund" data-key="${k}"`)}</div>`);
		}
		if (canDispute(c)) {
			const reason = draft(`reason:${key}`, 'fraudulent');
			const reasons = c.gateway === 'stripe' ? `<select class="ps-in" data-draft="reason:${k}" style="width:190px">${[['fraudulent', 'fraude (fraudulent)'], ['product_not_received', 'não recebido'], ['duplicate', 'cobrança duplicada']].map(([v, l]) => `<option value="${v}" ${reason === v ? 'selected' : ''}>${l}</option>`).join('')}</select>` : dim('chargeback do titular');
			blocks.push(`<div class="ps-row" style="flex-wrap:wrap"><span class="ps-dim" style="width:66px">Contestar</span>${reasons}<span class="ps-sp"></span>${btn('Abrir contestação', 'warning', '', `data-act="dispute" data-key="${k}"`)}</div>`);
		}
		if (c.status === 'recusada') {
			blocks.push(`<div class="ps-row">${btn('Por que foi recusado?', 'comment', '', `data-act="why" data-key="${k}"`)}<span class="ps-dim small">O agente explica pelo código do app e pela resposta do gateway.</span></div>`);
		}
		if (c.gateway === 'stripe' && c.status === 'pendente' && c.gatewayStatus !== 'requires_action') {
			blocks.push(`<div class="ps-text small">Quem confirma um pagamento com cartão no Stripe é o app (<span class="ps-m">confirm</span>). O PayStudio só conclui o desafio 3-D Secure.</div>`);
		}
		if (c.status === 'expirada') {
			blocks.push(`<div class="ps-row">${btn('O app liberou o horário?', 'comment', '', `data-act="expired-check" data-key="${k}"`)}<span class="ps-dim small">O agente confere no código do app.</span></div>`);
		}
		if (!blocks.length) {
			blocks.push('<div class="ps-text">Nada a simular nesta cobrança agora.</div>');
		}
		blocks.push(`<div class="ps-row">${btn('Perguntar ao agente', 'comment', 'sm', `data-act="ask-charge" data-key="${k}"`)}</div>`);
		return `<div class="ps-col" style="gap:9px">${blocks.join('')}</div>`;
	}

	// ------------------------------------------------------------------ webhooks

	function hookStateText(d) {
		const a = lastAttempt(d);
		if (d.state === 'no_url') { return 'o app não tem endereço de webhook para este gateway'; }
		if (hookForged(d)) { return `o app aceitou a assinatura errada (respondeu ${a.status})`; }
		if (d.state === 'failed') { return `desisti depois de ${plural(d.attempts.length, 'tentativa', 'tentativas')}${a ? ` (${a.status ?? a.error})` : ''}`; }
		if (hookFailing(d)) { return `o app respondeu ${a.status ?? 'sem resposta'}; ${d.due ? `nova tentativa às ${clock(d.due)}` : 'tentando de novo'}`; }
		return 'entregue';
	}

	function hookBadge(d) {
		const a = lastAttempt(d);
		if (d.state === 'no_url') { return '<span class="ps-badge grey">sem endereço</span>'; }
		if (hookForged(d)) { return '<span class="ps-badge err">assinatura aceita</span>'; }
		if (d.state === 'failed') { return '<span class="ps-badge err">falhou</span>'; }
		if (hookFailing(d)) { return '<span class="ps-badge err">falhando</span>'; }
		if (d.state === 'held') { return '<span class="ps-badge you">segurado</span>'; }
		if (!a) { return '<span class="ps-badge run">retido</span>'; }
		if (d.signature === 'wrong') { return d.signature_result === true ? '<span class="ps-badge okb">recusa confirmada</span>' : '<span class="ps-badge you">inconclusivo</span>'; }
		return '<span class="ps-badge okb">entregue</span>';
	}

	function signatureCell(d) {
		if (d.gateway === 'pix') { return dim('sem assinatura (mTLS)'); }
		if (d.signature === 'wrong') {
			if (hookForged(d)) { return `${ic('error', 'c-bad')}errada · aceita`; }
			return d.signature_result === true ? `${ic('passed', 'c-ok')}errada · recusada` : `${ic('warning', 'c-you')}errada · inconclusivo`;
		}
		return `${ic('check', 'c-dim')}${dim('válida')}`;
	}

	function triesCell(d) {
		const n = d.attempts.length;
		if (!n) { return d.state === 'held' ? dim('segurado') : d.state === 'no_url' ? dim('sem endereço') : `${ic('clock', 'c-run')}${dim(`sai às ${clock(d.due)}`)}`; }
		return `${n}${d.state === 'pending' && d.due && !attemptOk(lastAttempt(d)) ? ` ${dim(`· próx. ${clock(d.due)}`)}` : ''}`;
	}

	function webhooksView() {
		if (S.hookOpen) {
			const open = S.deliveries.find(d => d.id === S.hookSel);
			if (open) { return hookDetail(open); }
			S.hookOpen = false;
		}
		const text = S.hookText.trim().toLowerCase();
		const list = S.deliveries.filter(d => (S.hookGw === 'all' || d.gateway === S.hookGw) && (!S.hookProblem || hookProblem(d))
			&& (!text || [d.event, d.booking, d.ref, String(d.id), d.note].some(v => String(v || '').toLowerCase().includes(text))));
		let sel = S.deliveries.find(d => d.id === S.hookSel);
		if (!sel || !list.includes(sel)) { sel = list.find(hookProblem) || list[0]; }
		const rows = list.map(d => {
			const a = lastAttempt(d);
			const mk = hookFailing(d) || hookForged(d) || d.state === 'failed' ? 'mk-bad' : d.copy_of && d.signature !== 'wrong' || d.state === 'held' ? 'mk-you' : '';
			const extra = d.signature === 'wrong' ? ' · teste de assinatura' : d.copy_of ? ` · cópia de #${d.copy_of}` : d.note ? ` · ${d.note}` : '';
			return { c: [clock(a ? a.at : d.created), gwBadge(d.gateway), `${m(d.event)}${dim(esc(extra))}`, esc(d.booking || '—'), attemptStatus(d, a), a ? String(Math.round(a.ms)) : dim('—'), triesCell(d), signatureCell(d)], cls: `${mk} ${sel === d ? 'sel' : ''}`, attrs: `data-act="hook" data-id="${d.id}"` };
		});
		const grid = rows.length
			? table(...columns([['Hora', 76, 'm'], ['Gateway', 108], ['Evento', 0], ['Agend.', narrow() ? 84 : 92, 'm'], ['Resposta', narrow() ? 80 : 92, 'r'], tight() ? null : ['ms', 46, 'r'], ['Tentativas', narrow() ? 128 : 150], ['Assinatura', narrow() ? 150 : 196]], rows))
			: `<div class="ps-empty">${S.deliveries.length ? 'Nenhum webhook com esses filtros.' : 'Nenhum webhook ainda. Quando uma cobrança mudar (paga, recusada, estornada), o PayStudio manda o aviso para a rota de webhook do app e ele aparece aqui.'}</div>`;
		const failing = failingHooks().length;
		const gwOptions = [['all', 'Gateway: todos']].concat(GATEWAYS.map(g => [g, GW[g].label])).map(([value, label]) => `<option value="${value}" ${S.hookGw === value ? 'selected' : ''}>${label}</option>`).join('');
		const strip = `<div class="ps-strip"><span class="ps-in" style="width:260px">${ic('filter')}<input data-act="hook-text" data-draft="hook-text" placeholder="Filtrar por evento ou agendamento" value="${esc(S.hookText)}"></span>
			<select class="ps-in" data-act="hook-gw" style="width:140px">${gwOptions}</select>
			<label class="ps-check" style="margin-left:6px"><input type="checkbox" data-act="hook-problem" ${S.hookProblem ? 'checked' : ''}>Só com problema</label><span class="ps-sp"></span>
			<span class="ps-count">${plural(S.deliveries.length, 'webhook', 'webhooks')}${failing ? ` · ${ic('error', 'c-bad')} ${failing} falhando` : ''}</span></div>`;
		return `<div class="ps-main">${signatureBanner()}${strip}<div class="ps-scroll" data-scroll="hooks">${grid}</div>
			${sel ? `<div class="ps-row top" style="flex:0 0 236px;gap:10px;padding:10px;border-top:1px solid #3F3F46">${hookBottom(sel)}</div>` : ''}</div>`;
	}

	/** The newest signature check per gateway that the app failed. */
	function failedChecks() {
		const last = {};
		for (const check of S.pay?.checks || []) {
			if (!last[check.gateway] || last[check.gateway].at <= check.at) { last[check.gateway] = check; }
		}
		return Object.values(last).filter(check => check.ok === false && check.status);
	}

	function signatureBanner() {
		const bad = failedChecks();
		if (!bad.length) { return ''; }
		const names = bad.map(check => GW[check.gateway]?.label || check.gateway);
		return `<div class="ps-banner mk mk-bad">${ic('error', 'c-bad')}<div><b>A rota de webhook ${names.length === 1 ? `${GW[bad[0].gateway]?.of || ''}` : `de ${names.join(' e ')}`} aceitou um aviso com assinatura errada</b> (respondeu ${bad.map(c => c.status).join(', ')}). Qualquer pessoa que souber a URL pode confirmar um agendamento sem pagar.</div>
			${btn('Testar de novo', 'refresh', '', `data-act="check" data-id="${bad[0].gateway}"`)}${btn('Pedir correção', 'comment', 'primary', `data-act="fix-signature" data-id="${bad[0].gateway}"`)}</div>`;
	}

	/** The headers of this attempt as sent (the engine records them); before any attempt, how they will be built. */
	function requestHeaders(d, a) {
		let lines;
		if (a?.headers && typeof a.headers === 'object') {
			lines = Object.entries(a.headers).map(([k, v]) => [k, String(v)]);
		} else {
			lines = [['Content-Type', 'application/json'], ['User-Agent', `PayStudio/1.0 (${d.gateway} webhook emulator)`]];
			const how = d.signature === 'wrong' ? 'segredo errado de propósito' : 'calculada no envio';
			if (d.gateway === 'stripe') { lines.push(['Stripe-Signature', `t=<hora do envio>,v1=<HMAC SHA-256, ${how}>`]); }
			if (d.gateway === 'mercadopago') { lines.push(['x-signature', `ts=<hora do envio>,v1=<HMAC SHA-256, ${how}>`], ['x-request-id', '<um id novo a cada envio>']); }
		}
		const out = lines.map(([k, v]) => `<span class="k">${esc(k)}</span>: ${esc(v)}`);
		if (a?.headers && d.signature === 'wrong') { out.push('<span class="cm"># assinatura feita com um segredo errado, de propósito</span>'); }
		if (d.gateway === 'pix') { out.push('<span class="cm"># sem assinatura: no banco, o webhook do Pix é autenticado por mTLS</span>'); }
		return out;
	}

	function requestPanel(d, a, o = {}) {
		const tabs = `<div class="ps-tabs small">${[['body', 'Corpo'], ['headers', `Cabeçalhos <em>${requestHeaders(d, a).filter(l => !l.startsWith('<span class="cm">')).length}</em>`]].map(([id, label]) => `<button class="ps-tab ${S.hookTab === id ? 'on' : ''}" data-act="hook-tab" data-id="${id}">${label}</button>`).join('')}</div>`;
		const body = S.hookTab === 'headers' ? code(requestHeaders(d, a), { raw: true, numbers: false, cls: 'flat', scroll: 'hook-req' }) : code(d.payload ?? '', { cls: 'flat', scroll: 'hook-req' });
		return panel(`${o.title || 'Pedido'} · ${m(`POST ${pathOf(d.url) || '(sem endereço)'}`)}`, body, { icon: 'arrowR', pb: 'np', tabs, style: o.style || 'flex:1.15', right: a && o.time !== false ? `<em>${clock(a.at, true)}</em>` : '' });
	}

	function responsePanel(d, a, style = '') {
		if (!a) {
			return panel('Resposta do app', `<div class="ps-empty">${d.state === 'no_url' ? 'Não foi enviado: o app não tem endereço de webhook para este gateway.' : d.state === 'held' ? 'Segurado de propósito até o evento seguinte desta cobrança chegar (fora de ordem).' : `Ainda não saiu: sai às ${clock(d.due)}.`}</div>`, { icon: 'arrowL', pb: 'np', style });
		}
		const bad = d.signature === 'wrong' ? attemptOk(a) : !attemptOk(a);
		const lines = a.status
			? [`<span class="b">HTTP/1.1 ${a.status} ${esc(HTTP[a.status] || '')}</span>`, '', ...String(a.body || '').split('\n').map(l => esc(l))]
			: [`<span class="s">${esc(a.error || 'sem resposta')}</span>`];
		return panel(`Resposta do app · ${a.status ?? 'sem resposta'} · ${Math.round(a.ms)} ms`, code(lines, { raw: true, numbers: false, cls: 'flat', scroll: 'hook-res' }), { icon: 'arrowL', pb: 'np', mk: bad ? 'bad' : '', style });
	}

	function hookExplain(d) {
		const a = lastAttempt(d);
		if (d.state === 'no_url') { return note('warning', 'c-you', esc(d.note || 'O app não tem endereço de webhook para este gateway.')); }
		if (d.signature === 'wrong') {
			return hookForged(d)
				? note('error', 'c-bad', `Teste de assinatura: cópia do webhook #${d.copy_of} com a assinatura errada de propósito, e o app respondeu <b>${a.status}</b>. A rota precisa conferir ${d.gateway === 'stripe' ? 'o <span class="ps-m">Stripe-Signature</span> (constructEvent)' : 'o <span class="ps-m">x-signature</span>'} e responder 400.`)
				: d.signature_result === true
					? note('passed', 'c-ok', `O app aceitou a assinatura válida e recusou a errada (${a?.status ?? '—'}).`)
					: note('warning', 'c-you', 'Teste inconclusivo: a resposta não confirma a validação da assinatura.');
		}
		if (a && !a.status) { return note('error', 'c-bad', `O PayStudio não conseguiu falar com o app: <span class="ps-m">${esc(a.error)}</span>. O app está rodando?`); }
		if (a && a.status >= 500) { return note('error', 'c-bad', `O app respondeu <b>${a.status}</b>: o erro está na rota de webhook do app. ${d.state === 'failed' ? `Desisti depois de ${d.attempts.length} tentativas.` : `O PayStudio tenta de novo às ${clock(d.due)}.`}`); }
		if (a && [400, 401, 403].includes(a.status)) { return note('warning', 'c-you', `O app recusou um webhook com assinatura válida (${a.status}). Confira se a rota usa o segredo do <span class="ps-m">.env.local</span> (${d.gateway === 'stripe' ? 'STRIPE_WEBHOOK_SECRET' : 'MERCADOPAGO_WEBHOOK_SECRET'}).`); }
		if (d.copy_of) { return note('warning', 'c-you', `Cópia do webhook #${d.copy_of}, com o mesmo corpo${d.note ? ` (${esc(d.note)})` : ''}. É o que acontece quando o gateway manda o mesmo aviso duas vezes: o app deve processar uma vez só.`); }
		if (d.state === 'held') { return note('warning', 'c-you', 'Segurado de propósito: o evento seguinte desta cobrança chega antes (fora de ordem).'); }
		if (!a) { return note('info', 'c-run', `Retido${d.note ? ` (${esc(d.note)})` : ''}: sai às ${clock(d.due)}.`); }
		return d.note ? note('info', 'c-run', esc(d.note)) : '';
	}

	function hookBottom(d) {
		const a = lastAttempt(d);
		const problem = hookProblem(d);
		const c = chargeOf(d.ref);
		const actions = `<div class="ps-row" style="gap:6px;flex-wrap:wrap">${c?.booking ? btn('Linha do tempo', 'commit', 'sm', `data-act="timeline-of" data-key="${esc(chargeKey(c))}"`) : ''}${btn('Tentativas', 'history', 'sm', `data-act="hook-open" data-id="${d.id}"`)}${btn('Reenviar', 'refresh', 'sm', `data-act="resend" data-id="${d.id}"`)}<span class="ps-sp"></span>${problem ? btn('Pedir correção', 'comment', 'sm primary', `data-act="fix-hook" data-id="${d.id}"`) : ''}</div>`;
		return `${requestPanel(d, a)}<div class="ps-col" style="flex:1;gap:8px">${responsePanel(d, a, 'flex:1')}${hookExplain(d)}${actions}</div>`;
	}

	function hookDetail(d) {
		const c = chargeOf(d.ref);
		const attempt = d.attempts.find(x => x.at === S.attemptSel) || lastAttempt(d);
		const first = d.attempts[0]?.at;
		const rows = d.attempts.map((a, i) => {
			const bad = d.signature === 'wrong' ? attemptOk(a) : !attemptOk(a);
			return { c: [String(i + 1), clock(a.at, !tight()), i ? `${Math.round(a.at - first)} s` : dim('—'), attemptStatus(d, a), String(Math.round(a.ms))], cls: `${bad ? 'mk-bad' : ''} ${a === attempt ? 'sel' : ''}`, attrs: `data-act="attempt" data-at="${a.at}"` };
		});
		if (d.state === 'pending' || d.state === 'held') {
			rows.push({ c: [String(d.attempts.length + 1), d.state === 'held' ? dim('—') : clock(d.due), d.attempts.length && first ? `${Math.round(d.due - first)} s` : dim('—'), `${ic('ring', 'c-dim')}${d.state === 'held' ? 'segurado' : 'agendada'}`, dim('—')], cls: 'mk-run' });
		}
		const tries = rows.length ? table(narrow() ? [['#', 28, 'r'], ['Hora', tight() ? 70 : 94, 'm'], ['Espera', 60, 'r'], ['Resposta', 0], ['ms', 38, 'r']] : [['#', 28, 'r'], ['Hora', 104, 'm'], ['Espera', 62, 'r'], ['Resposta', 0], ['ms', 44, 'r']], rows, { cls: 'panelbg' }) : '<div class="ps-empty">Nenhuma tentativa.</div>';
		const checks = (S.pay?.checks || []).filter(check => check.gateway === d.gateway).slice(-3).reverse();
		const signature = d.gateway === 'pix'
			? `<div class="ps-text">No padrão do Banco Central, o webhook do Pix é autenticado por mTLS entre o banco e o app. O PayStudio não simula o certificado: o aviso chega sem assinatura.</div>`
			: `${li(d.signature === 'wrong' ? ic('warning', 'c-you') : ic('passed', 'c-ok'), `${m(d.gateway === 'stripe' ? 'Stripe-Signature' : 'x-signature')} ${d.signature === 'wrong' ? 'errada de propósito' : 'válida, com o segredo do .env.local'}`, '', 'multi')}
				${d.gateway === 'mercadopago' ? li(ic('passed', 'c-ok'), `${m('x-request-id')} presente`) : ''}
				${checks.length ? checks.map(check => li(check.ok === true ? ic('passed', 'c-ok') : check.ok === false ? ic('error', 'c-bad') : ic('warning', 'c-you'), esc(check.text), clock(check.at), 'multi')).join('') : `<div class="ps-dim small">A rota ainda não foi testada com assinatura errada.</div>`}`;
		const calls = S.calls.filter(k => k.ref === d.ref && k.at >= (d.created - 1)).slice(-8).map(k => ({ c: [clock(k.at, true), m(`${k.method} ${k.path}`), callStatus(k)], cls: k.status >= 500 ? 'mk-bad' : '' }));
		const head = `<div class="ps-strip">${btn('', 'arrowL', 'sm ib', 'data-act="hook-back" title="Voltar para a lista"')}<span class="ps-dim">Webhooks ›</span><b>${m(d.event)} · #${d.id}${d.booking ? ` · ${esc(d.booking)}` : ''}${c?.customer ? ` · ${esc(c.customer)}` : ''}</b>${gwBadge(d.gateway)}${hookBadge(d)}<span class="ps-sp"></span>
			${c ? btn('Ver a cobrança', 'card', 'sm', `data-act="charge-open" data-key="${esc(chargeKey(c))}"`) : ''}${btn('Reenviar agora', 'refresh', 'sm primary', `data-act="resend" data-id="${d.id}"`)}</div>`;
		return `<div class="ps-main">${head}<div class="ps-row top ps-grow ps-pad">
			<div class="ps-col" style="flex:0 0 ${narrow() ? 300 : 340}px">${panel('Tentativas', tries, { icon: 'history', pb: 'np', right: `<em>${plural(d.attempts.length, 'tentativa', 'tentativas')}</em>` })}
				${note('info', 'c-run', 'Reenvio rápido para testes: 5 s, 15 s, 30 s, 1 min e 2 min depois da primeira tentativa. O gateway real espera bem mais entre uma e outra.')}
				${panel('Assinatura', signature, { icon: 'shield', style: 'flex:1' })}</div>
			<div class="ps-col ps-grow">
				<div class="ps-row top" style="gap:10px;flex:0 0 300px">${requestPanel(d, attempt, { title: d.attempts.length > 1 && attempt ? `Pedido ${d.attempts.indexOf(attempt) + 1}` : 'Pedido', style: 'flex:1', time: !tight() })}${responsePanel(d, attempt, 'flex:1')}</div>
				${hookExplain(d)}
				${panel('O que o app chamou desta cobrança', calls.length ? table([['Hora', 104, 'm'], ['Chamada do app', 0], ['Resposta', 90, 'r']], calls, { cls: 'panelbg' }) : '<div class="ps-empty">O app não chamou o gateway sobre esta cobrança depois deste webhook.</div>', { icon: 'swap', pb: 'np', style: 'flex:1' })}
				<div class="ps-row">${hookProblem(d) ? btn('Pedir correção', 'comment', 'primary', `data-act="fix-hook" data-id="${d.id}"`) : ''}<span class="ps-sp"></span>${btn('Perguntar ao agente', 'comment', '', `data-act="ask-hook" data-id="${d.id}"`)}</div>
			</div></div></div>`;
	}

	// ------------------------------------------------------------------ scenarios

	function presetSteps(name) {
		const preset = PRESETS[name];
		if (!preset) { return []; }
		const steps = [];
		const kinds = preset.rules.map(([kind]) => kind);
		const webhookUrl = gw => S.pay?.gateways?.[gw]?.url;
		if (kinds.includes('pay_after') || kinds.includes('expire_after')) {
			steps.push(['O app cria a cobrança Pix', m('PUT /pix/v2/cob/{txid}'), dim('—')]);
		} else if (kinds.includes('decline')) {
			steps.push(['O app cria o pagamento com cartão', `${m('POST /v1/payments')} ou ${m('/v1/payment_intents')}`, dim('—')]);
		} else if (kinds.includes('failure')) {
			steps.push(['O app chama o gateway', 'qualquer chamada, de qualquer gateway', dim('—')]);
		} else {
			steps.push(['O app cria uma cobrança e ela muda', 'o cliente paga, o cartão é aprovado ou recusado', dim('—')]);
		}
		for (const [kind, params] of preset.rules) {
			if (kind === 'pay_after') { steps.push(['O pagador paga o Pix', 'o PayStudio paga sozinho, como o cliente', `${params.seconds} s`]); }
			if (kind === 'expire_after') { steps.push(['A cobrança vence sem pagamento', 'ninguém paga; nenhum webhook é mandado', `${params.seconds} s`]); }
			if (kind === 'delay') { steps.push(['Segurar o webhook', 'como um banco que atrasou o aviso', `<b>${duration(params.seconds)}</b>`]); }
			if (kind === 'duplicate') { steps.push(['Mandar de novo, igual', `mesmo corpo, ${params.copies} entregas no total`, '1 s']); }
			if (kind === 'out_of_order') { steps.push(['Segurar o primeiro evento', 'o evento seguinte chega antes (até 20 s)', dim('—')]); }
			if (kind === 'wrong_signature') { steps.push(['Assinar com o segredo errado', `${m('Stripe-Signature')} e ${m('x-signature')} não batem`, dim('—')]); }
			if (kind === 'decline') { steps.push(['O cartão é recusado', m(DECLINES[params.reason].join(' · ')), dim('—')]); }
			if (kind === 'failure') {
				steps.push([params.mode === 'slow' ? `O gateway demora ${params.latency_ms / 1000} s` : 'O gateway responde 503', `nas próximas ${params.calls} chamadas`, params.mode === 'slow' ? `${params.latency_ms / 1000} s` : dim('—')]);
			}
		}
		if (kinds.some(k => ['pay_after', 'delay', 'duplicate', 'out_of_order', 'wrong_signature'].includes(k))) {
			const g = preset.gateway === 'any' ? null : preset.gateway;
			const url = g ? webhookUrl(g) : null;
			steps.splice(kinds.includes('duplicate') ? steps.length - 1 : steps.length, 0, [`Mandar o webhook${g === 'pix' ? ' <span class="ps-m">pix</span>' : ''}`, url ? m(`POST ${pathOf(url)}${g === 'pix' ? '/pix' : ''}`) : 'para a rota de webhook do app', dim('—')]);
		}
		return steps;
	}

	function scenariosView() {
		const presets = S.pay?.presets || {};
		const names = Object.keys(presets);
		const sel = presets[S.scenSel] ? S.scenSel : names[0];
		const armed = new Set((S.pay?.rules || []).map(r => r.label).filter(Boolean));
		const row = name => `<div class="ps-tr multi ${name === sel ? 'sel' : ''}" data-act="scenario" data-id="${esc(name)}">${armed.has(presets[name]) ? ic('beaker', 'c-run') : ic('ring', 'c-dim')}<span class="nm" title="${esc(presets[name])}">${esc(presets[name])}</span>${armed.has(presets[name]) ? '<em>armado</em>' : ''}</div>`;
		const grouped = new Set(PRESET_GROUPS.flatMap(([, list]) => list));
		const groups = PRESET_GROUPS.concat([['Outros', names.filter(n => !grouped.has(n))]])
			.map(([title, list]) => list.filter(n => presets[n]).length ? `<div class="ps-th">${esc(title)}</div>${list.filter(n => presets[n]).map(row).join('')}` : '').join('');
		const tree = `<div class="ps-tree"><div class="ps-th">${ic('beaker')}Cenários prontos<em>· ${names.length}</em></div><div class="ps-tbody" data-scroll="scen-list">${groups || '<div class="ps-empty">Nenhum cenário.</div>'}</div>
			<div style="padding:10px 8px">${note('info', 'c-dim', 'Um cenário vale para a próxima cobrança ou o próximo webhook. Depois de rodar, faça o app pagar.')}</div></div>`;
		if (!sel) { return `${tree}<div class="ps-main"><div class="ps-empty">O PayStudio não mandou a lista de cenários.</div></div>`; }
		const preset = PRESETS[sel];
		const gateway = preset ? preset.gateway : 'any';
		const steps = presetSteps(sel);
		const stepsTable = steps.length ? table([['#', 28, 'r'], ['Passo', narrow() ? 170 : 250], ['Detalhe', 0], ['Espera', narrow() ? 64 : 84]], steps.map((s, i) => [String(i + 1), s[0], s[1], s[2]]), { cls: 'panelbg wrap' }) : `<div class="ps-empty">${esc(presets[sel])}</div>`;
		const expect = (preset?.expect || ['O app trata o caso sem erro']).map(t => li(ic('ring', 'c-dim'), t, '', 'multi')).join('');
		const strip = `<div class="ps-strip wrap">${ic('beaker', 'c-txt')}<b>${esc(presets[sel])}</b>${gateway === 'any' ? '<span class="ps-badge grey">qualquer gateway</span>' : gwBadge(gateway)}<span class="ps-sp"></span>
			${armed.has(presets[sel]) ? `<span class="ps-count">${ic('beaker', 'c-run')}armado, esperando a próxima cobrança</span>` : ''}${btn('Rodar', 'play', 'primary', `data-act="run-scenario" data-id="${esc(sel)}"`)}</div>`;
		return `${tree}<div class="ps-main">${strip}<div class="ps-scrollv ps-grow" style="display:flex;flex-direction:column" data-scroll="scen-main"><div class="ps-row top ps-fill ps-pad">
			<div class="ps-col ns" style="flex:1.3">
				${panel('Passos', stepsTable, { icon: 'list', pb: 'np', mk: armed.has(presets[sel]) ? 'run' : '', right: `<em>${esc(sel)}</em>` })}
				${panel('O que conferir no app', expect + '<div class="ps-dim small" style="margin-top:6px">O PayStudio mostra o que mandou e o que o app respondeu; o agente confere o resto no código e no app.</div>', { icon: 'checklist' })}
				${failurePanel()}
			</div>
			<div class="ps-col ns" style="flex:1">${armedPanel()}${signaturePanel()}</div>
		</div></div></div>`;
	}

	function armedPanel() {
		const pay = S.pay || {};
		const now = nowSec();
		const rows = [];
		const labels = [];
		for (const r of pay.rules || []) {
			if (r.label && !labels.includes(r.label)) { labels.push(r.label); }
		}
		for (const label of [null, ...labels]) {
			const list = (pay.rules || []).filter(r => (r.label || null) === label);
			if (!list.length) { continue; }
			if (label) { rows.push(`<div class="ps-fl" style="margin-top:${rows.length ? 8 : 0}px">${ic('beaker', 'c-run')} ${esc(label)}</div>`); }
			for (const r of list) { rows.push(li(label ? ic('dot', 'c-dim sm') : ic('beaker', 'c-run'), esc(r.text), r.remaining > 1 ? `mais ${r.remaining} vezes` : '', 'line multi')); }
		}
		for (const f of pay.failures || []) { rows.push(li(ic('warning', 'c-you'), esc(f.text), f.hits ? plural(f.hits, 'chamada afetada', 'chamadas afetadas') : '', 'line multi')); }
		for (const s of pay.scheduled || []) { rows.push(li(ic('clock', 'c-run'), esc(s.label), s.due > now ? `em <span data-left-dur="${s.due}">${duration(s.due - now)}</span>` : 'agora', 'line multi')); }
		const body = rows.length ? rows.join('') : '<div class="ps-text">Nenhum cenário armado e nenhuma falha ligada. O próximo pagamento acontece normalmente.</div>';
		return panel('Agora no PayStudio', body, { icon: 'pulse', right: rows.length ? btn('Limpar tudo', 'trash', 'sm', 'data-act="clear"') : '' });
	}

	function failurePanel() {
		const gateway = draft('fail-gw', 'any');
		const mode = draft('fail-mode', 'unavailable');
		const calls = draft('fail-calls', '5');
		const rate = draft('fail-rate', '100');
		const latency = draft('fail-latency', '8');
		const options = [['any', 'Todos os gateways']].concat(GATEWAYS.map(g => [g, GW[g].api])).map(([v, l]) => `<option value="${v}" ${gateway === v ? 'selected' : ''}>${l}</option>`).join('');
		const modes = FAIL_MODES.map(([v, l]) => `<label class="ps-check" style="display:flex;height:22px"><input type="radio" name="fail-mode" value="${v}" data-draft="fail-mode" ${mode === v ? 'checked' : ''}>${l}${v === 'slow' ? `<span class="ps-in m" style="width:62px;margin-left:8px"><input data-draft="fail-latency" value="${esc(latency)}">s</span>` : ''}</label>`).join('');
		const active = (S.pay?.failures || []).length;
		const body = `<div class="ps-kv" style="grid-template-columns:118px minmax(0,1fr)"><span>Gateway</span><span><select class="ps-in" data-draft="fail-gw" style="width:200px">${options}</select></span></div>
			<div class="ps-fl">O que o gateway faz</div>${modes}
			<div class="ps-row" style="margin-top:8px;flex-wrap:wrap;row-gap:4px"><span class="ps-dim">Nas próximas</span><span class="ps-in m" style="width:56px"><input data-draft="fail-calls" value="${esc(calls)}"></span><span class="ps-dim">chamadas, em</span><span class="ps-in m" style="width:56px"><input data-draft="fail-rate" value="${esc(rate)}">%</span><span class="ps-dim">delas</span></div>
			<div class="ps-actions">${active ? btn('Voltar ao normal', 'undo', '', 'data-act="clear-failures"') : ''}${btn('Ligar a falha', 'bolt', 'primary', 'data-act="failure"')}</div>`;
		return panel('Falhas do gateway', body, { icon: 'bolt', style: 'flex:1', mk: active ? 'you' : '' });
	}

	function signaturePanel() {
		const pay = S.pay || {};
		const rows = GATEWAYS.map(g => {
			const url = pay.gateways?.[g]?.url;
			const check = (pay.checks || []).filter(x => x.gateway === g).slice(-1)[0];
			const path = url ? esc(`${pathOf(url)}${g === 'pix' ? '/pix' : ''}`) : 'sem endereço';
			if (g === 'pix') { return `<div class="ps-sig"><div class="ps-row">${gwBadge(g)}<span class="tx ps-dim">não se aplica: no banco é mTLS</span></div><div class="path">${path}</div></div>`; }
			const result = check ? (check.ok === true ? `${ic('passed', 'c-ok')}recusou ${check.status}` : check.ok === false ? `${ic('error', 'c-bad')}aceitou ${check.status}` : `${ic('warning', 'c-you')}inconclusivo`) + dim(` · ${clock(check.at)}`) : dim('ainda não testado');
			const can = S.deliveries.some(d => d.gateway === g && d.url);
			return `<div class="ps-sig ${check?.ok === false ? 'mk mk-bad' : ''}"><div class="ps-row">${gwBadge(g)}<span class="tx">${result}</span><span class="ps-sp"></span>${btn('Testar', '', 'sm', can ? `data-act="check" data-id="${g}"` : 'disabled title="Precisa de pelo menos um webhook deste gateway"')}</div><div class="path">${path}</div></div>`;
		});
		return panel('Teste de assinatura por rota', `${rows.join('')}<div class="ps-text small" style="padding:7px 10px">Compara o mesmo webhook com assinatura válida e errada. Sem uma resposta válida de controle, o resultado é inconclusivo.</div>`, { icon: 'shield', pb: 'np' });
	}

	// ------------------------------------------------------------------ timeline

	function bookings() {
		const list = [];
		for (const c of S.charges) {
			if (c.booking && !list.includes(c.booking)) { list.push(c.booking); }
		}
		return list;
	}

	function timelineView() {
		const list = bookings();
		if (!list.length && !S.deliveries.length && !S.calls.length) {
			return '<div class="ps-main"><div class="ps-empty">A linha do tempo aparece quando o app criar a primeira cobrança.</div></div>';
		}
		const booking = S.tlBooking === '*' || !list.length ? '*' : list.includes(S.tlBooking) ? S.tlBooking : list[0];
		const charges = S.charges.filter(c => c.booking === booking);
		const options = list.map(b => {
			const c = S.charges.find(x => x.booking === b);
			return `<option value="${esc(b)}" ${b === booking ? 'selected' : ''}>${esc(b)}${c?.customer ? ` · ${esc(c.customer)}` : ''}</option>`;
		}).join('') + `<option value="*" ${booking === '*' ? 'selected' : ''}>Todos os agendamentos</option>`;
		const checks = booking === '*' ? [] : bookingChecks(booking, charges);
		const bad = checks.filter(x => x.mk === 'bad').length;
		const look = checks.filter(x => x.mk === 'you').length;
		const strip = `<div class="ps-strip wrap"><span class="ps-dim">Agendamento</span><select class="ps-in" data-act="timeline-booking" style="width:${narrow() ? 230 : 270}px">${options}</select>
			${charges.map(c => `${gwBadge(c.gateway)}${stBadge(c.status, '')}<span>${brl(c.amount)}</span>`).join('<span class="ps-dim">·</span>')}<span class="ps-sp"></span>
			${booking === '*' ? '' : bad ? `<span class="ps-count">${ic('error', 'c-bad')}${bad} de ${checks.length} verificações com problema</span>` : look ? `<span class="ps-count">${ic('warning', 'c-you')}${plural(look, 'ponto para conferir', 'pontos para conferir')}</span>` : `<span class="ps-count">${ic('passed', 'c-ok')}${plural(checks.length, 'verificação', 'verificações')} sem problema</span>`}</div>`;
		if (booking === '*') {
			return `<div class="ps-main">${strip}<div class="ps-scroll" data-scroll="tl-all">${allEvents()}</div></div>`;
		}
		const log = charges.flatMap(c => (c.events || []).map(e => ({ ...e, gateway: c.gateway }))).sort((a, b) => a.at - b.at)
			.map(e => `<div class="ll"><span class="t">${clock(e.at)}</span>${eventIcon(e.kind)}<span title="${esc(e.text)}">${esc(e.text)}</span></div>`).join('');
		return `<div class="ps-main">${strip}<div class="ps-row top ps-grow">
			<div class="ps-col ps-grow" style="border-right:1px solid #3F3F46;gap:0">${sequence(booking, charges)}</div>
			<div class="ps-col" style="flex:0 0 ${narrow() ? 300 : 360}px;padding:10px">
				${panel('Verificações', checks.map(x => li(x.icon, x.text, '', 'multi')).join('') || '<div class="ps-text">Nada para verificar ainda.</div>', { icon: 'checklist', mk: bad ? 'bad' : '' })}
				${panel('Registro do PayStudio', `<div class="ps-log" style="height:100%">${log || '<span class="ps-dim">Sem eventos.</span>'}</div>`, { icon: 'output', pb: 'np', style: 'flex:1', scroll: 'tl-log' })}
				<div class="ps-row">${btn('Perguntar ao agente', 'comment', '', `data-act="ask-booking" data-id="${esc(booking)}"`)}<span class="ps-sp"></span>${bad ? btn('Pedir correção', 'comment', 'primary', `data-act="fix-booking" data-id="${esc(booking)}"`) : ''}</div>
			</div></div></div>`;
	}

	/** What went right or wrong for one booking, from the charges, the webhooks and the calls. */
	function bookingChecks(booking, charges) {
		const out = [];
		const refs = new Set(charges.map(c => c.ref));
		for (const c of charges) {
			const st = { paga: ['passed', 'c-ok', 'ok'], pendente: ['spinner', 'c-run', ''], em_analise: ['spinner', 'c-run', ''], expirada: ['warning', 'c-you', 'you'], contestada: ['warning', 'c-you', 'you'], recusada: ['info', 'c-run', ''] }[c.status] || ['info', 'c-run', ''];
			out.push({ icon: ic(st[0], st[1]), mk: st[2], text: `${GW[c.gateway].label}: cobrança ${esc(STATUS[c.status])} ${dim(`(${esc(c.gatewayStatus)})`)}` });
			for (const f of c.flags) { out.push({ icon: ic('error', 'c-bad'), mk: 'bad', text: esc(f.text) }); }
		}
		const hooks = S.deliveries.filter(d => refs.has(d.ref));
		const normal = hooks.filter(d => d.signature !== 'wrong' && d.attempts.length);
		const failing = normal.filter(hookFailing);
		if (failing.length) {
			out.push({ icon: ic('error', 'c-bad'), mk: 'bad', text: `app respondeu ${[...new Set(failing.map(d => lastAttempt(d).status ?? 'sem resposta'))].join(', ')} a ${plural(failing.length, 'entrega', 'entregas')}` });
		} else if (normal.length) {
			out.push({ icon: ic('passed', 'c-ok'), mk: 'ok', text: `app respondeu 2xx ${normal.length === 1 ? 'à entrega' : `às ${normal.length} entregas`}` });
		}
		const copies = hooks.filter(d => d.copy_of && d.signature !== 'wrong');
		if (copies.length) {
			out.push({ icon: ic('warning', 'c-you'), mk: 'you', text: `${plural(copies.length, 'webhook repetido', 'webhooks repetidos')} (${copies.map(d => `#${d.id} = #${d.copy_of}`).join(', ')}): o app deve processar uma vez só` });
		}
		for (const d of hooks.filter(x => x.signature === 'wrong' && x.attempts.length)) {
			out.push(hookForged(d)
				? { icon: ic('error', 'c-bad'), mk: 'bad', text: `app aceitou assinatura errada (${lastAttempt(d).status})` }
				: d.signature_result === true
					? { icon: ic('passed', 'c-ok'), mk: 'ok', text: `app recusou assinatura errada (${d.attempts.find(a => a.status)?.status ?? '—'})` }
					: { icon: ic('warning', 'c-you'), mk: 'you', text: 'verificação de assinatura inconclusiva' });
		}
		for (const d of hooks.filter(x => !x.attempts.length && ['pending', 'held'].includes(x.state))) {
			out.push({ icon: ic('clock', 'c-run'), mk: '', text: `webhook #${d.id} ${d.state === 'held' ? 'segurado (fora de ordem)' : `retido até ${clock(d.due)}`}` });
		}
		for (const call of S.calls.filter(k => refs.has(k.ref) && k.status >= 500)) {
			out.push({ icon: ic('error', 'c-bad'), mk: 'bad', text: `${esc(call.method)} ${esc(call.path)} respondeu ${call.status}` });
		}
		return out;
	}

	/** The booking's sequence: app, PayStudio, the test payer and the app's webhook route. */
	function sequence(booking, charges) {
		const refs = new Set(charges.map(c => c.ref));
		const items = [];
		for (const call of S.calls.filter(k => refs.has(k.ref))) {
			items.push({ at: call.at, type: 'call', call });
		}
		for (const c of charges) {
			for (const e of c.events || []) {
				if (e.kind === 'webhook') { continue; }
				items.push({ at: e.at + 0.0005, type: e.by === 'agente' || e.by === 'cenário' ? 'payer' : 'note', e });
			}
		}
		for (const d of S.deliveries.filter(x => refs.has(x.ref))) {
			if (!d.attempts.length) {
				items.push({ at: d.due || d.created, type: 'wait', d });
			}
			for (const a of d.attempts) { items.push({ at: a.at, type: 'hook', d, a }); }
		}
		items.sort((a, b) => a.at - b.at);
		const W = Math.max(540, Math.min(900, (S.seqWidth || 900) - 16));
		const X = { app: Math.round(W * 0.11), ps: Math.round(W * 0.37), payer: Math.round(W * 0.62), wh: Math.round(W * 0.87) };
		const svg = [];
		const html = [];
		let y = 82;
		const arrow = (from, to, yy, cls) => {
			const dir = X[to] > X[from] ? 1 : -1;
			svg.push(`<path d="M${X[from] + dir * 4},${yy} H${X[to] - dir * 6}" class="a ${cls}" marker-end="url(#ps-ah-${cls.includes('bad') ? 'bad' : 'norm'})"/>`);
		};
		// A label may be wider than its arrow (centred on it), so short diagrams still show the whole call.
		const label = (from, to, yy, inner, title) => {
			const center = (X[from] + X[to]) / 2;
			const width = Math.min(2 * Math.min(center, W - center), Math.max(Math.abs(X[to] - X[from]), 420));
			html.push(`<div class="ps-seq-m" style="left:${Math.round(center - width / 2)}px;width:${Math.round(width)}px;top:${yy - 17}px" title="${esc(title)}"><span class="in">${inner}</span></div>`);
		};
		const noteAt = (lane, yy, text, mk) => html.push(`<div class="ps-seq-note ${mk ? `mk mk-${mk}` : ''}" style="left:${X[lane] + 12}px;top:${yy - 11}px;max-width:${W - X[lane] - 20}px" title="${esc(text)}">${esc(text)}</div>`);
		for (const item of items) {
			if (item.type === 'call') {
				const k = item.call;
				const bad = k.status >= 500;
				const text = `${k.method} ${k.path}`;
				arrow('app', 'ps', y, bad ? 'bad' : '');
				label('app', 'ps', y, `<span class="t">${clock(k.at)}</span><span class="m">${esc(`${k.method} ${shortPath(k.path)}`)}</span>`, text);
				y += 28;
				arrow('ps', 'app', y, `ret ${bad || (k.status >= 400 && k.status !== 402) ? 'bad' : ''}`);
				label('app', 'ps', y, `${k.status} · ${Math.round(k.ms)} ms`, String(k.status));
				y += 30;
			} else if (item.type === 'payer') {
				arrow('payer', 'ps', y, '');
				label('ps', 'payer', y, `<span class="t">${clock(item.e.at)}</span>${esc(item.e.text)}`, item.e.text);
				y += 34;
			} else if (item.type === 'note') {
				noteAt('ps', y - 6, `${clock(item.e.at)} · ${item.e.text}`, eventMark(item.e.kind));
				y += 30;
			} else if (item.type === 'wait') {
				noteAt('ps', y - 6, `webhook #${item.d.id} ${item.d.state === 'held' ? 'segurado (fora de ordem)' : `retido até ${clock(item.d.due)}`}`, 'run');
				y += 30;
			} else {
				const { d, a } = item;
				const bad = d.signature === 'wrong' ? attemptOk(a) : !attemptOk(a);
				const text = `${d.event} · #${d.id}${d.copy_of && d.signature !== 'wrong' ? ` · cópia de #${d.copy_of}` : ''}${d.signature === 'wrong' ? ' · assinatura errada' : ''}`;
				arrow('ps', 'wh', y, bad ? 'bad' : '');
				label('ps', 'wh', y, `<span class="t">${clock(a.at)}</span><span class="m">${esc(text)}</span>`, text);
				y += 28;
				arrow('wh', 'ps', y, `ret ${bad ? 'bad' : ''}`);
				label('ps', 'wh', y, a.status ? `${a.status} · ${Math.round(a.ms)} ms` : esc(a.error || 'sem resposta'), String(a.status ?? a.error));
				y += 30;
			}
		}
		const height = Math.max(y + 10, 200);
		const c = charges[0];
		const heads = [['app', 'App · checkout', 'chamadas ao gateway'], ['ps', 'PayStudio', charges.map(x => GW[x.gateway].api).filter((v, i, a) => a.indexOf(v) === i).join(' · ')], ['payer', 'Pagador de teste', c?.customer || 'o agente, como o cliente'], ['wh', 'App · webhook', S.pay?.gateways?.[c?.gateway]?.url ? `${pathOf(S.pay.gateways[c.gateway].url)}${c.gateway === 'pix' ? '/pix' : ''}` : 'rota do app']];
		const lanes = Object.values(X).map(x => `<div class="ps-seq-l" style="left:${x}px;top:0;height:${height}px"></div>`).join('');
		const headHtml = heads.map(([lane, title, sub]) => `<div class="ps-seq-h" style="left:${X[lane]}px;top:8px">${esc(title)}<small>${esc(sub)}</small></div>`).join('');
		const defs = '<defs><marker id="ps-ah-norm" viewBox="0 0 10 10" refX="8.6" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M2,1.5L8.6,5L2,8.5" fill="none" stroke="#9A9A9A" stroke-width="1.6"/></marker><marker id="ps-ah-bad" viewBox="0 0 10 10" refX="8.6" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M2,1.5L8.6,5L2,8.5" fill="none" stroke="#D9534F" stroke-width="1.6"/></marker></defs>';
		const empty = items.length ? '' : '<div class="ps-empty" style="position:absolute;top:70px;left:20px">Nada aconteceu com este agendamento ainda.</div>';
		return `<div class="ps-seq" data-scroll="seq"><div class="ps-seq-stage" style="width:${W}px;height:${height}px;margin:0 auto">${lanes}<div class="ps-seq-head" style="width:${W}px">${headHtml}</div>
			<svg width="${W}" height="${height}">${defs}${svg.join('')}</svg>${html.join('')}${empty}</div></div>
			<div class="ps-legend"><span><i class="ln"></i>chamada ou webhook</span><span><i class="ln dash"></i>resposta</span><span><i class="ln bad"></i>o que não devia acontecer</span></div>`;
	}

	function allEvents() {
		const rows = [];
		for (const call of S.calls) {
			rows.push({ at: call.at, gateway: call.gateway, booking: chargeOf(call.ref)?.booking, who: 'app → PayStudio', what: m(`${call.method} ${call.path}`), res: callStatus(call), mk: call.status >= 500 || (call.status >= 400 && call.status !== 402) ? 'bad' : '' });
		}
		for (const d of S.deliveries) {
			for (const a of d.attempts) {
				rows.push({ at: a.at, gateway: d.gateway, booking: d.booking, who: 'PayStudio → app', what: `${m(d.event)} ${dim(`· #${d.id}`)}`, res: attemptStatus(d, a), mk: (d.signature === 'wrong' ? attemptOk(a) : !attemptOk(a)) ? 'bad' : '', hook: d.id });
			}
		}
		for (const c of S.charges) {
			for (const e of c.events || []) {
				if (e.kind === 'webhook' || e.by === 'app') { continue; }
				rows.push({ at: e.at, gateway: c.gateway, booking: c.booking, who: e.by === 'agente' ? 'Pagador de teste' : e.by === 'cenário' ? 'Cenário' : 'PayStudio', what: `${eventIcon(e.kind)}${esc(e.text)}`, res: dim('—'), mk: '' });
			}
		}
		rows.sort((a, b) => b.at - a.at);
		return rows.length ? table([['Hora', 104, 'm'], ['Gateway', 108], ['Agend.', 92, 'm'], ['Quem', 132], ['O quê', 0], ['Resposta', 92, 'r']], rows.slice(0, 400).map(r => ({ c: [clock(r.at, true), gwBadge(r.gateway), esc(r.booking || '—'), esc(r.who), r.what, r.res], cls: r.mk ? `mk-${r.mk}` : '', attrs: r.hook ? `data-act="hook" data-id="${r.hook}"` : '' }))) : '<div class="ps-empty">Nada ainda.</div>';
	}

	// ------------------------------------------------------------------ calls

	function explainCall(call) {
		const res = parse(call.res);
		const error = call.error || res?.error && { code: res.error.code || res.error.type, message: res.error.message };
		const message = error?.message || '';
		if (/X-Idempotency-Key/i.test(message)) {
			return 'O Mercado Pago exige o cabeçalho <code>X-Idempotency-Key</code> ao criar um pagamento. Gere uma chave quando a tela de pagamento abre (por exemplo com o id do agendamento) e mande a mesma chave em cada clique: assim o gateway não cobra duas vezes.';
		}
		if (/not emulated|Unrecognized request URL/i.test(message)) {
			return 'Essa rota ainda não é emulada pelo PayStudio. Veja em Mais › Catálogo de gateways o que cada gateway responde.';
		}
		if (res?.error?.type === 'card_error' || call.status === 402) {
			const code = res?.error?.decline_code || res?.error?.code || '';
			return `O cartão foi recusado${code ? `: <b>${esc(REASONS[code] || code)}</b>` : ''}. É o esperado com este cartão de teste; confira se o app mostra a mensagem certa ao cliente.`;
		}
		if (call.status === 401) { return 'Faltou o cabeçalho <code>Authorization</code> ou a chave não é de teste. As chaves certas estão no <code>.env.local</code>.'; }
		if (call.status === 404) { return 'O id não existe neste PayStudio: pode ser de outra sessão (os dados só na memória somem ao desligar) ou de um gateway de verdade.'; }
		if (call.status === 503 || call.status === 429 || /falha simulada/.test(call.flag || '')) { return 'Falha simulada pelo PayStudio (Cenários › Falhas do gateway). Confira se o app mostra uma mensagem clara e deixa tentar de novo.'; }
		return '';
	}

	function callsView() {
		const filters = [['all', 'Todas'], ['errors', 'Com erro'], ['nokey', 'Sem chave de idempotência'], ...GATEWAYS.map(g => [g, GW[g].label])];
		const needsKey = k => k.method === 'POST' && !k.idempotency && k.gateway !== 'pix' && !/card_tokens|oauth/.test(k.path);
		let list = S.calls;
		if (S.callFilter === 'errors') { list = list.filter(k => k.status >= 400); }
		if (S.callFilter === 'nokey') { list = list.filter(needsKey); }
		if (GW[S.callFilter]) { list = list.filter(k => k.gateway === S.callFilter); }
		list = list.slice(-400).reverse();
		const errors = S.calls.filter(k => k.status >= 400).length;
		let sel = S.calls.find(k => k.id === S.callSel);
		if (!sel || !list.includes(sel)) { sel = list.find(k => k.error) || list[0]; }
		const rows = list.map(k => ({ c: [clock(k.at, true), GW[k.gateway] ? gwBadge(k.gateway) : esc(k.gateway), m(`${k.method} ${k.path}`), esc(k.op || ''), k.idempotency ? m(k.idempotency) : needsKey(k) ? `${ic('warning', 'c-you')}${dim('sem chave')}` : dim('—'), callStatus(k), String(Math.round(k.ms))], cls: `${k.status >= 500 || (k.status >= 400 && k.status !== 402) ? 'mk-bad' : k.flag ? 'mk-you' : ''} ${sel === k ? 'sel' : ''}`, attrs: `data-act="call" data-id="${k.id}"` }));
		const grid = rows.length ? table(...columns([['Hora', 104, 'm'], ['Gateway', 108], ['Chamada', 0], narrow() ? null : ['Operação', 140], ['Idempotência', 108], ['Status', 62, 'r'], tight() ? null : ['ms', 44, 'r']], rows)) : `<div class="ps-empty">Nenhuma chamada ${S.callFilter === 'errors' ? 'com erro' : 'ainda'}.</div>`;
		return `<div class="ps-main"><div class="ps-strip"><div class="ps-filters">${filters.map(([id, label]) => `<button class="ps-chip ${S.callFilter === id ? 'on' : ''}" data-act="call-filter" data-id="${id}">${label}${id === 'errors' && errors ? ` <em class="bad">${errors}</em>` : ''}</button>`).join('')}</div><span class="ps-sp"></span><span class="ps-count">${plural(S.callTotal, 'chamada', 'chamadas')} desde que ligou</span></div>
			<div class="ps-row top ps-grow ps-pad"><div class="ps-panel flat ps-grow"><div class="ps-scroll" data-scroll="calls">${grid}</div></div>
			<div class="ps-panel" style="flex:0 0 36%;max-width:500px;min-width:320px"><div class="ps-ph">${ic('swap')}<span class="t">Chamada${sel ? ` <em>${esc(sel.op || sel.path)}</em>` : ''}</span></div>${callDetail(sel)}</div></div></div>`;
	}

	function callDetail(k) {
		if (!k) { return '<div class="ps-empty">Escolha uma chamada para ver o pedido, a resposta e o erro.</div>'; }
		const c = k.ref ? chargeOf(k.ref) : null;
		const why = explainCall(k);
		const res = parse(k.res);
		const failed = k.status >= 400;
		const error = k.error || res?.error && { code: res.error.code || res.error.type, message: res.error.message };
		const errorNote = failed && error ? note(k.status === 402 ? 'warning' : 'error', k.status === 402 ? 'c-you' : 'c-bad', `<b>${esc(error.code || k.status)}</b><div class="ps-m wrap">${esc(error.message || '')}</div>${why ? `<div style="margin-top:6px">${why}</div>` : ''}`) : '';
		return `<div class="ps-pb" data-scroll="call-detail"><div class="ps-col" style="gap:8px">
			${kv([
			['Hora', m(clock(k.at, true))],
			['Gateway', GW[k.gateway] ? gwBadge(k.gateway) : esc(k.gateway)],
			['Chamada', m(`${k.method} ${k.path}`)],
			['Operação', esc(k.op || '—')],
			['Cobrança', c ? `<a class="ps-link" data-act="charge-open" data-key="${esc(chargeKey(c))}">${esc(c.booking || shortRef(c.ref))}</a> ${dim(esc(shortRef(c.ref)))}` : k.ref ? m(k.ref) : dim('—')],
			['Cliente', esc(k.client || '—')],
			['Idempotência', k.idempotency ? m(k.idempotency) : dim('sem chave')],
			['Resultado', `${failed ? ic(k.status === 402 ? 'warning' : 'error', k.status === 402 ? 'c-you' : 'c-bad') : ic('passed', 'c-ok')}${k.status} · ${ms(k.ms)}`],
		], 104)}
			${k.flag ? note('warning', 'c-you', esc(k.flag)) : ''}${errorNote}
			${k.req ? `<div class="ps-fl">Pedido</div>${code(k.req)}` : ''}
			${k.res ? `<div class="ps-fl">Resposta</div>${code(k.res)}` : `<div class="ps-dim small">A resposta não foi guardada (grande demais ou sem corpo).</div>`}
			<div class="ps-actions">${c ? btn('Ver a cobrança', 'card', '', `data-act="charge-open" data-key="${esc(chargeKey(c))}"`) : ''}${failed && k.status !== 402 ? btn('Pedir ao agente para corrigir', 'comment', 'primary', `data-act="fix-call" data-id="${k.id}"`) : ''}</div>
		</div></div>`;
	}

	// ------------------------------------------------------------------ test cards

	function cardsView() {
		const text = S.cardText.trim().toLowerCase().replace(/\s/g, '');
		const result = draft('card-result', 'all');
		const match = (number, ...words) => (!text || number.replace(/\s/g, '').includes(text) || words.some(w => String(w).toLowerCase().includes(text))) && (result === 'all' || words.includes(result));
		const today = (gateway, test) => S.charges.filter(c => c.gateway === gateway && test(c)).length;
		const resultBadge = kind => `<span class="ps-badge ${CARD_RESULT[kind][0]} w">${kind === 'pend' ? '3-D Secure' : CARD_RESULT[kind][1]}</span>`;
		const mpRows = MP_CARDS.filter(([number, brandName, holder, kind, detail]) => (S.cardGw === 'all' || S.cardGw === 'mercadopago') && match(number, brandName, holder, kind, detail)).map(([number, brandName, holder, kind, detail]) => {
			const n = today('mercadopago', c => c.details?.card?.cardholder?.name === holder);
			const id = `mp:${holder}`;
			return { c: [m(number), esc(brandName), m(holder), `<span class="ps-badge ${CARD_RESULT[kind][0]} w">${kind === 'pend' ? 'em análise' : CARD_RESULT[kind][1]}</span>`, ms_(detail), n ? String(n) : dim('—')], cls: S.cardSel === id ? 'sel' : '', attrs: `data-act="card" data-id="${id}" data-number="${esc(number)}"` };
		});
		const stRows = STRIPE_CARDS.filter(([number, pm, kind, detail]) => (S.cardGw === 'all' || S.cardGw === 'stripe') && match(number, pm, kind, detail)).map(([number, pm, kind, detail]) => {
			const last4 = number.replace(/\s/g, '').slice(-4);
			const n = today('stripe', c => c.details?.payment_method === pm || (!String(c.details?.payment_method || '').startsWith('pm_card_') && c.details?.card?.last4 === last4));
			const id = `st:${pm}`;
			return { c: [m(number), ms_(pm), resultBadge(kind), ms_(detail), n ? String(n) : dim('—')], cls: S.cardSel === id ? 'sel' : '', attrs: `data-act="card" data-id="${id}" data-number="${esc(number)}"` };
		});
		const gwOptions = [['all', 'Todos os gateways'], ['mercadopago', 'Mercado Pago'], ['stripe', 'Stripe']].map(([v, l]) => `<option value="${v}" ${S.cardGw === v ? 'selected' : ''}>${l}</option>`).join('');
		const resultOptions = [['all', 'Resultado: todos'], ['ok', 'aprovado'], ['rec', 'recusado'], ['pend', 'pendente ou 3-D Secure'], ['you', 'contestado']].map(([v, l]) => `<option value="${v}" ${result === v ? 'selected' : ''}>${l}</option>`).join('');
		const strip = `<div class="ps-strip"><span class="ps-in" style="width:250px">${ic('filter')}<input data-act="card-text" data-draft="card-text" placeholder="Filtrar por número ou resultado" value="${esc(S.cardText)}"></span>
			<select class="ps-in" data-act="card-gw" style="width:160px">${gwOptions}</select><select class="ps-in" data-act="card-result" style="width:180px">${resultOptions}</select><span class="ps-sp"></span>
			<span class="ps-count">${plural(MP_CARDS.length + STRIPE_CARDS.length, 'cartão de teste', 'cartões de teste')}</span>${btn('Copiar número', 'copy', 'sm', S.cardSel ? 'data-act="copy-card"' : 'disabled title="Escolha um cartão na lista"')}</div>`;
		const howTo = kv([['Validade', `${m('11/30')} ${dim('· qualquer data futura')}`], ['CVV', `${m('123')} ${dim('· Amex 1234')}`], ['CPF', m('123.456.789-09')], ['Titular', `${m('APRO')}, ${m('FUND')}, ${m('OTHE')}…`]], 74);
		const pix = kv([['Quem paga', 'o agente, como o cliente'], ['Como pagar', 'Simular pagamento'], ['Webhook', 'na hora ou atrasado']], 92);
		return `<div class="ps-main">${strip}<div class="ps-row top ps-grow ps-pad">
			<div class="ps-col ps-grow ps-scrollv" data-scroll="cards">
				${S.cardGw !== 'stripe' ? panel(`${gwBadge('mercadopago')} o nome do titular decide o resultado`, mpRows.length ? table([['Cartão', narrow() ? 142 : 150, 'm'], ['Bandeira', narrow() ? 84 : 90], ['Titular', 62, 'm'], ['Resultado', 92], ['status · status_detail', 0, 'm'], ['Hoje', 46, 'r']], mpRows, { cls: 'wrap soft' }) : '<div class="ps-empty">Nenhum cartão com esses filtros.</div>', { icon: 'card', pb: 'np', right: `<em>${plural(MP_CARDS.length, 'combinação', 'combinações')}</em>`, style: 'flex:none' }) : ''}
				${S.cardGw !== 'mercadopago' ? panel(`${gwBadge('stripe')} o número do cartão decide o resultado`, stRows.length ? table([['Cartão', narrow() ? 142 : 150, 'm'], ['payment_method de teste', narrow() ? 220 : 250, 'm'], ['Resultado', 92], ['O que o app recebe', 0, 'm'], ['Hoje', 46, 'r']], stRows, { cls: 'wrap soft' }) : '<div class="ps-empty">Nenhum cartão com esses filtros.</div>', { icon: 'card', pb: 'np', right: `<em>${plural(STRIPE_CARDS.length, 'cartão', 'cartões')}</em>`, style: 'flex:none' }) : ''}
			</div>
			<div class="ps-col" style="flex:0 0 ${narrow() ? 240 : 270}px">${panel('Mercado Pago · como preencher', howTo, { icon: 'edit', pb: 'tight' })}${panel('Pix de teste', pix, { icon: 'mobile', pb: 'tight' })}
				${panel('Bom saber', `<div class="ps-col" style="gap:8px"><div class="ps-text">${ic('lock', 'c-dim')} Use só os números de teste publicados pelos gateways; nunca um cartão de verdade.</div><div class="ps-text">${ic('info', 'c-dim')} No Stripe, o app também pode mandar o <span class="ps-m">payment_method</span> de teste direto (<span class="ps-m">pm_card_visa</span>).</div><div class="ps-text">${ic('bolt', 'c-dim')} Gateway fora do ar ou lento não depende do cartão: fica em Cenários › Falhas do gateway.</div></div>`, { icon: 'bulb', style: 'flex:1' })}</div>
		</div></div>`;
	}

	// ------------------------------------------------------------------ catalog

	function catalogView() {
		const pay = S.pay || {};
		const sel = CATALOG[S.catalogSel] ? S.catalogSel : 'mercadopago';
		const rows = GATEWAYS.map(g => ({ c: [gwBadge(g), esc(CATALOG[g].what), m(CATALOG[g].version), '<span class="ps-badge okb w">ligado</span>', pay.gateways?.[g] ? plural(pay.gateways[g].charges, 'cobrança', 'cobranças') : dim('—')], cls: sel === g ? 'sel' : '', attrs: `data-act="catalog-gw" data-id="${g}"` }));
		rows.push({ c: ['<span class="ps-badge grey">Efí</span> <span class="ps-badge grey">Inter</span> <span class="ps-badge grey">Itaú</span>', 'seguem a API Pix do Banco Central: só a parte padrão', m('API Pix v2'), '<span class="ps-badge run w">parcial</span>', dim('—')] });
		for (const name of NOT_YET) { rows.push({ c: [`<span class="ps-badge grey">${esc(name)}</span>`, dim('—'), dim('—'), '<span class="ps-badge grey w">ainda não</span>', dim('—')], cls: 'dim' }); }
		const info = CATALOG[sel];
		const route = (icon, name, detail) => narrow()
			? li(icon, `${name}${detail ? `<div class="sub">${esc(detail)}</div>` : ''}`, '', 'multi')
			: li(icon, name, esc(detail), 'multi');
		const routes = info.routes.map(([path, detail]) => route(ic('passed', 'c-ok'), ms_(path), detail)).join('') + info.missing.map(([path, detail]) => route(ic('slash', 'c-dim'), esc(path), detail)).join('');
		const missingCall = S.calls.filter(k => k.gateway === sel && /not emulated|Unrecognized request URL/i.test(k.error?.message || '')).slice(-1)[0];
		const missing = missingCall
			? `<div class="ps-text small" style="padding:6px 10px">O app chamou <span class="ps-m">${esc(missingCall.method)} ${esc(missingCall.path)}</span> às ${clock(missingCall.at)}, e o PayStudio respondeu:</div>${code(missingCall.res || missingCall.error, { cls: 'flat' })}`
			: '<div class="ps-text" style="padding:8px 10px">Se o app chamar uma rota que não é emulada, o PayStudio responde com um erro claro dizendo isso, em vez de fingir que deu certo.</div>';
		const enabled = (S.settings.gateways && S.settings.gateways.length ? S.settings.gateways : GATEWAYS).filter(g => GW[g]);
		const linked = GATEWAYS.map(g => li(`<span class="ps-cb ${enabled.includes(g) ? 'on' : ''}"></span>`, esc(GW[g].api), m(GW[g].path))).join('');
		const emulated = GATEWAYS.length;
		return `<div class="ps-main"><div class="ps-strip"><span class="ps-dim">O PayStudio emula cada gateway um a um, só nas partes listadas.</span><span class="ps-sp"></span><span class="ps-count">${emulated} ligados · 1 parcial · ${NOT_YET.length} ainda não</span></div>
			<div class="ps-row top ps-grow ps-pad">
				<div class="ps-col ps-grow">${panel('Catálogo de gateways', table(narrow() ? [['Gateway', 150], ['O que emula', 0], ['Versão', 92], ['Estado', 92], ['Neste projeto', 104]] : [['Gateway', 170], ['O que emula', 0], ['Versão', 110], ['Estado', 98], ['Neste projeto', 120]], rows, { cls: 'wrap' }), { icon: 'library', pb: 'np', style: 'flex:1', scroll: 'catalog' })}
					${note('info', 'c-run', '<b>Limites.</b> Não substitui a homologação no gateway real: taxas, prazos de repasse, antifraude e regras de cada banco não são simulados. Checkout Pro, assinaturas, boleto e split de pagamento ainda não são emulados.')}
					<div class="ps-row"><button class="ps-example" style="width:auto;margin:0" data-act="example" data-text="${esc('No PayStudio, eu precisaria testar com o gateway ')}">${ic('comment', 'c-dim')}Falta algum? Peça na conversa.</button></div></div>
				<div class="ps-col ns ps-scrollv" style="flex:0 0 ${tight() ? 300 : narrow() ? 340 : 420}px" data-scroll="catalog-side">${panel(`${gwBadge(sel)} o que responde`, routes, { icon: 'checklist', mk: 'run' })}
					${panel('Para o que ainda falta', missing, { icon: 'slash', pb: 'np' })}
					${panel('Ligados neste projeto', linked + '<div class="ps-dim small" style="margin-top:6px">O <span class="ps-m">.env.local</span> recebe os endereços e as chaves de teste dos gateways marcados.</div>', { icon: 'plug', style: 'flex:1' })}</div>
			</div></div>`;
	}

	// ------------------------------------------------------------------ settings

	function envLines(endpoint) {
		const gateways = (S.settings.gateways && S.settings.gateways.length ? S.settings.gateways : GATEWAYS).filter(g => GW[g]);
		const secret = '<span class="x">•••••••• só no .env.local</span>';
		const lines = ['<span class="cm"># Gateway de pagamento de teste do PayStudio (só neste computador, sem dinheiro de verdade)</span>'];
		const plain = [];
		const add = (name, value) => {
			lines.push(`<span class="k">${name}</span>=${value === null ? secret : esc(value)}`);
			if (value !== null) { plain.push(`${name}=${value}`); }
		};
		if (gateways.includes('pix')) { add('PIX_API_URL', `${endpoint}/pix`); add('PIX_CLIENT_ID', null); add('PIX_CLIENT_SECRET', null); add('PIX_CHAVE', null); }
		if (gateways.includes('mercadopago')) { add('MERCADOPAGO_API_URL', `${endpoint}/mercadopago`); add('MERCADOPAGO_ACCESS_TOKEN', null); add('MERCADOPAGO_PUBLIC_KEY', null); add('MERCADOPAGO_WEBHOOK_SECRET', null); }
		if (gateways.includes('stripe')) { add('STRIPE_API_URL', `${endpoint}/stripe`); add('STRIPE_SECRET_KEY', null); add('STRIPE_PUBLISHABLE_KEY', null); add('STRIPE_WEBHOOK_SECRET', null); }
		return { lines, plain, secrets: lines.length - 1 - plain.length };
	}

	function settingsView() {
		const pay = S.pay || {};
		const on = payOn();
		const endpoint = pay.endpoint || 'http://127.0.0.1:4570';
		const port = (/:(\d+)$/.exec(endpoint) || [])[1] || '4570';
		const project = S.ctx?.project;
		const env = envLines(endpoint);
		const envPanel = panel(`Variáveis para o ${m('.env.local')}`, code(env.lines, { raw: true, cls: 'flat' }), { icon: 'file', pb: 'np', right: `<em>${plural(env.lines.length - 1, 'variável', 'variáveis')} · ${env.secrets} chaves escondidas</em>`,
			foot: `<span class="ps-dim">${ic('lock', 'c-dim')} As chaves vão direto para o arquivo, sem passar pela conversa.</span><span class="ps-sp"></span>${btn('Copiar endereços', 'copy', 'sm', `data-act="copy" data-text="${esc(env.plain.join('\n'))}"`)}${btn('Criar .env.local', 'fileAdd', 'sm primary', project ? 'data-act="env"' : 'disabled title="Abra o PayStudio a partir de um projeto"')}` });
		const usage = code([
			'<span class="cm"># Python: o SDK do Stripe usa o endereço do PayStudio</span>',
			'stripe.api_base = os.environ[<span class="s">"STRIPE_API_URL"</span>]',
			'<span class="cm">// Node: o stripe-node aceita host, porta e protocolo</span>',
			`<span class="b">new</span> Stripe(process.env.STRIPE_SECRET_KEY, { host: <span class="s">'127.0.0.1'</span>, port: <span class="n">${esc(port)}</span>, protocol: <span class="s">'http'</span> })`,
			'<span class="cm">// Pix e Mercado Pago: use *_API_URL como endereço base das chamadas</span>',
			'axios.create({ baseURL: process.env.PIX_API_URL })',
		], { raw: true, cls: 'flat' });
		const hooks = GATEWAYS.map(g => {
			const url = pay.gateways?.[g]?.url ?? S.settings.webhooks?.[g] ?? '';
			const last = S.deliveries.find(d => d.gateway === g && d.attempts.length && d.signature !== 'wrong');
			const a = last && lastAttempt(last);
			const result = a ? `${attemptOk(a) ? ic('passed', 'c-ok') : ic('error', 'c-bad')}${a.status ?? 'erro'} · ${Math.round(a.ms)} ms` : dim('—');
			return { c: [gwBadge(g), url ? ms_(`${host_(url)}${g === 'pix' ? '/pix' : ''}`) : `${ic('warning', 'c-you')}${dim('não configurado')}`, result, btn('Mudar', '', 'sm', `data-act="set-webhook" data-id="${g}"`)], cls: url ? '' : 'mk-you' };
		});
		const signature = kv([
			[gwBadge('mercadopago'), `${m('x-signature')} ${dim('· HMAC com MERCADOPAGO_WEBHOOK_SECRET')}`],
			[gwBadge('stripe'), `${m('Stripe-Signature')} ${dim('· HMAC com STRIPE_WEBHOOK_SECRET (whsec_)')}`],
			[gwBadge('pix'), dim('sem assinatura: no banco é mTLS, não simulado')],
		], 110);
		const storage = pay.storage || S.settings.storage || 'memory';
		const gatewayKv = kv([
			['Endereço', `${m(endpoint)} ${dim('· só este computador')}`],
			...GATEWAYS.map(g => [GW[g].api, `${m(pay.gateways?.[g]?.base || `${endpoint}${GW[g].path}`)}${g === 'stripe' ? dim(' · também em /v1') : ''}`]),
			['Dados', `${storage === 'persistent' ? 'guardados entre sessões' : 'só na memória'} ${btn(storage === 'persistent' ? 'Guardar só na memória' : 'Guardar entre sessões', '', 'sm', `data-act="set-storage" data-id="${storage === 'persistent' ? 'memory' : 'persistent'}"`)}`],
			['Recebedor', esc([pay.merchant || S.settings.merchant, S.settings.city].filter(Boolean).join(' · ') || '—')],
			['Moeda e fuso', `BRL · ${esc(TZ)} ${dim('· os campos do protocolo seguem em UTC')}`],
		], 118);
		const rules = [
			[ic('passed', 'c-ok'), 'Só chaves de teste: chave de produção é marcada na chamada', `${m('APP_USR-')} ${m('sk_live_')}`],
			[ic('passed', 'c-ok'), `As chaves ficam no ${m('.env.local')}, fora do Git`, ''],
			[ic('passed', 'c-ok'), 'O agente vê o nome das variáveis, nunca o valor', ''],
			[ic('passed', 'c-ok'), 'Os webhooks só vão para endereços deste computador', ''],
		].map(([icon, text, right]) => li(icon, text, right, 'multi')).join('');
		return `<div class="ps-main"><div class="ps-scrollv ps-grow" style="display:flex;flex-direction:column" data-scroll="settings"><div class="ps-row top ps-fill ps-pad">
			<div class="ps-col ns" style="flex:1.1">${envPanel}${panel('Como o app usa estas variáveis', usage, { icon: 'edit', pb: 'np', foot: '<span class="ps-dim">Sem as variáveis, o app continua falando com o gateway de verdade.</span>' })}${panel('Regras das chaves', rules, { icon: 'key', style: 'flex:1' })}</div>
			<div class="ps-col ns" style="flex:1">${panel('Webhooks do app', table([['Gateway', 108], ['Endereço do app', 0], ['Último', 110], ['', 64, 'r']], hooks, { cls: 'panelbg wrap soft' }), { icon: 'send', pb: 'np', foot: '<span class="ps-dim">O Pix recebe no endereço + <span class="ps-m">/pix</span>, como manda o padrão do Banco Central.</span>' })}
				${panel('Assinatura dos webhooks', signature, { icon: 'shield', pb: 'tight' })}
				${panel('Gateway local', gatewayKv, { icon: 'server', pb: 'tight' })}
				${panel('Apagar', `<div class="ps-row"><span class="ps-dim ps-grow" style="white-space:normal">Apaga as cobranças, os webhooks, os cenários e as chamadas. As configurações e as chaves de teste continuam.</span>${btn('Apagar tudo', ['trash', 'c-bad'], '', on ? 'data-act="reset"' : 'disabled')}</div>`, { icon: 'trash', style: 'flex:1' })}</div>
		</div></div></div>`;
	}

	function confirmDialog() {
		if (!S.confirm) { return ''; }
		return `<div class="ps-scrim"></div><div class="ps-dlg"><div class="dt">${ic('warning', 'c-you')}${esc(S.confirm.title)}</div>
			<div class="ps-pb">${esc(S.confirm.text)}</div><div class="ps-actions pad">${btn('Cancelar', '', '', 'data-act="confirm-no"')}${btn(esc(S.confirm.yes), '', 'primary', 'data-act="confirm-yes"')}</div></div>`;
	}

	// ------------------------------------------------------------------ actions

	function toast(text) {
		S.note = text;
		render();
		clearTimeout(toast.timer);
		toast.timer = setTimeout(() => { S.note = null; render(); }, 2800);
	}

	function copy(text, done) {
		const fallback = () => {
			const area = document.createElement('textarea');
			area.value = text;
			area.style.position = 'fixed';
			area.style.opacity = '0';
			document.body.appendChild(area);
			area.select();
			let ok = false;
			try { ok = document.execCommand('copy'); } catch { ok = false; }
			area.remove();
			toast(ok ? done : 'Não foi possível copiar.');
		};
		try {
			navigator.clipboard.writeText(text).then(() => toast(done), fallback);
		} catch {
			fallback();
		}
	}

	/** "20,50" or "20.50" in reais. */
	function money(text) {
		const value = String(text || '').trim().replace(/^R\$\s*/, '');
		const number = Number(value.includes(',') ? value.replace(/\./g, '').replace(',', '.') : value);
		return Number.isFinite(number) && number > 0 ? Math.round(number * 100) / 100 : null;
	}

	function openCharge(key) {
		S.sel = key;
		S.chargeOpen = true;
		S.view = 'charges';
		S.menu = false;
		remember();
		render();
	}

	function onClick(event) {
		const el = event.target.closest('[data-act]');
		if (S.menu && !event.target.closest('.ps-menu') && !(el && el.dataset.act === 'menu')) {
			S.menu = false;
			render();
		}
		if (!el || el.disabled || (el.tagName === 'INPUT' && !['radio', 'checkbox'].includes(el.type)) || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') { return; }
		const d = el.dataset;
		const c = d.key ? findCharge(d.key) : undefined;
		const hook = d.id && /^\d+$/.test(d.id) ? S.deliveries.find(x => x.id === Number(d.id)) : undefined;
		switch (d.act) {
			case 'view':
				S.view = d.view;
				S.menu = false;
				if (d.view === 'charges') { S.chargeOpen = false; }
				if (d.view === 'webhooks') { S.hookOpen = false; }
				remember();
				render();
				break;
			case 'menu':
				S.menu = !S.menu;
				S.menuX = el.getBoundingClientRect().left;
				render();
				break;
			case 'start': {
				const storage = firstStorage();
				act('start', `Ligue o gateway de teste do PayStudio${storage === 'persistent' ? ', guardando as cobranças entre sessões' : ''}.`);
				break;
			}
			case 'stop':
				act('stop', 'Desligue o gateway de teste do PayStudio.');
				break;
			case 'first-storage':
				S.firstStorage = el.value;
				S.firstStorageTouched = true;
				break;
			case 'example':
				ask(d.text, false);
				break;
			case 'attention': {
				const a = (S.attentionCache || [])[Number(d.i)];
				if (!a) { break; }
				if (a.kind === 'signature') {
					const forged = S.deliveries.find(x => x.gateway === a.gateway && hookForged(x));
					S.view = 'webhooks';
					S.hookOpen = false;
					if (forged) { S.hookSel = forged.id; }
					remember();
					render();
					break;
				}
				if (a.kind === 'webhook') {
					const failed = S.deliveries.find(x => x.ref === a.ref && x.gateway === a.gateway && hookProblem(x)) || S.deliveries.find(x => a.booking && x.booking === a.booking && x.gateway === a.gateway && hookProblem(x));
					S.view = 'webhooks';
					S.hookSel = failed ? failed.id : S.hookSel;
					S.hookOpen = !!failed;
					remember();
					render();
					break;
				}
				const target = S.charges.find(x => x.ref === a.ref && x.gateway === a.gateway);
				if (target) { openCharge(chargeKey(target)); }
				break;
			}
			case 'event': {
				const e = (S.eventCache || [])[Number(d.i)];
				if (e?.hook) { S.view = 'webhooks'; S.hookSel = e.hook; S.hookOpen = false; remember(); render(); } else if (e?.charge) { openCharge(e.charge); }
				break;
			}
			case 'timeline-all':
				S.view = 'timeline';
				S.tlBooking = '*';
				remember();
				render();
				break;
			case 'charge':
				if (c) {
					S.sel = chargeKey(c);
					if (event.detail === 2) { S.chargeOpen = true; }
					remember();
					render();
				}
				break;
			case 'charge-open':
				if (c) { openCharge(chargeKey(c)); }
				break;
			case 'charge-back':
				S.chargeOpen = false;
				remember();
				render();
				break;
			case 'charge-tab':
				S.chargeTab = d.id;
				render();
				break;
			case 'pay':
				if (c) {
					const pix = c.method === 'pix';
					const delay = Number(draft(`delay:${chargeKey(c)}`, '0')) || 0;
					const twice = !!draft(`dup:${chargeKey(c)}`, false);
					const extra = !pix || !(delay || twice) ? '' : `, com o webhook chegando ${[delay ? `${duration(delay)} depois` : '', twice ? 'duas vezes' : ''].filter(Boolean).join(' e ')}`;
					act('pay', pix ? `Pague o Pix ${chargeText(c)} no PayStudio${extra}.`
						: c.gateway === 'stripe' ? `Conclua o 3-D Secure do pagamento ${chargeText(c)} no PayStudio, como o cliente.`
							: `Aprove o pagamento em análise ${chargeText(c)} no PayStudio.`);
				}
				break;
			case 'expire':
				if (c) { act('expire', `Deixe vencer o Pix ${chargeText(c)} no PayStudio, sem pagamento.`); }
				break;
			case 'refund-all':
				if (c) { act('refund', `Estorne a cobrança ${chargeText(c)} no PayStudio, o valor inteiro (${brl(c.amount - (c.refunded || 0))}).`); }
				break;
			case 'refund':
				if (c) {
					const key = chargeKey(c);
					if (draft(`refund:${key}`, 'total') === 'partial') {
						const value = money(draft(`refund-value:${key}`, ''));
						if (value === null || value * 100 > c.amount - (c.refunded || 0)) { toast(`Escreva um valor entre R$ 0,01 e ${brl(c.amount - (c.refunded || 0))}.`); break; }
						act('refund', `Estorne ${brl(Math.round(value * 100))} da cobrança ${chargeText(c)} no PayStudio.`);
					} else {
						act('refund', `Estorne a cobrança ${chargeText(c)} no PayStudio, o valor inteiro (${brl(c.amount - (c.refunded || 0))}).`);
					}
				}
				break;
			case 'dispute':
				if (c) {
					const reason = draft(`reason:${chargeKey(c)}`, 'fraudulent');
					act('dispute', c.gateway === 'stripe' ? `Abra uma contestação do titular (motivo ${reason}) na cobrança ${chargeText(c)} no PayStudio.` : `Abra um chargeback do titular na cobrança ${chargeText(c)} no PayStudio.`);
				}
				break;
			case 'why':
				if (c) { ask(`Por que o pagamento ${c.booking ? `do agendamento ${c.booking}` : c.ref} foi recusado no PayStudio${declineCode(c) ? ` (${declineCode(c)})` : ''}? O app mostra a mensagem certa ao cliente?`, true); }
				break;
			case 'expired-check':
				if (c) { ask(`No PayStudio, o Pix ${chargeText(c)} venceu sem pagamento. Confira no código do app se ele libera o horário quando o Pix vence.`, true); }
				break;
			case 'ask-charge':
				if (c) { ask(`Sobre a cobrança ${chargeText(c)} no PayStudio (${STATUS[c.status]}, ${brl(c.amount)}): `, false); }
				break;
			case 'hooks-of':
				if (c) {
					S.view = 'webhooks';
					S.hookOpen = false;
					S.hookText = c.booking || c.ref;
					S.drafts['hook-text'] = S.hookText;
					remember();
					render();
				}
				break;
			case 'timeline-of':
				if (c?.booking) {
					S.view = 'timeline';
					S.tlBooking = c.booking;
					remember();
					render();
				}
				break;
			case 'copy':
				copy(d.text || '', 'Copiado.');
				break;
			case 'hook':
				if (hook) {
					if (S.view !== 'webhooks') { S.view = 'webhooks'; S.hookOpen = false; }
					S.hookSel = hook.id;
					if (event.detail === 2) { S.hookOpen = true; S.attemptSel = null; }
					remember();
					render();
				}
				break;
			case 'hook-open':
				if (hook) { S.hookSel = hook.id; S.hookOpen = true; S.attemptSel = null; remember(); render(); }
				break;
			case 'hook-back':
				S.hookOpen = false;
				remember();
				render();
				break;
			case 'hook-tab':
				S.hookTab = d.id;
				render();
				break;
			case 'attempt':
				S.attemptSel = Number(d.at);
				render();
				break;
			case 'hook-problem':
				S.hookProblem = el.checked;
				render();
				break;
			case 'resend':
				if (hook) { act('resend', `Reenvie o webhook #${hook.id} (${hook.event}${hook.booking ? `, ${hook.booking}` : ''}) do PayStudio.`); }
				break;
			case 'fix-hook':
				if (hook) {
					const a = lastAttempt(hook);
					ask(`No PayStudio, o webhook #${hook.id} (${hook.event}${hook.booking ? `, agendamento ${hook.booking}` : ''}) ${hookForged(hook) ? `tinha assinatura errada e o app respondeu ${a.status}` : `${hookStateText(hook)}${a?.body ? `. O app respondeu: "${String(a.body).slice(0, 200)}"` : ''}`}. Descubra no código da rota de webhook do app por que isso acontece e corrija.`, true);
				}
				break;
			case 'ask-hook':
				if (hook) { ask(`Sobre o webhook #${hook.id} (${hook.event}${hook.booking ? `, ${hook.booking}` : ''}) do PayStudio: `, false); }
				break;
			case 'check':
				act('check', `Teste se a rota de webhook ${GW[d.id]?.of || ''} recusa uma assinatura errada (check do PayStudio).`);
				break;
			case 'fix-signature':
				ask(`No PayStudio, a rota de webhook ${GW[d.id]?.of || ''} aceitou um aviso com assinatura errada. Corrija a rota para conferir ${d.id === 'stripe' ? 'o Stripe-Signature com o STRIPE_WEBHOOK_SECRET (constructEvent)' : 'o x-signature com o MERCADOPAGO_WEBHOOK_SECRET'} e responder 400 quando não bater; depois rode o teste de assinatura de novo.`, true);
				break;
			case 'scenario':
				S.scenSel = d.id;
				remember();
				render();
				break;
			case 'run-scenario': {
				const label = S.pay?.presets?.[d.id] || d.id;
				act('scenario', `Rode o cenário "${label}" do PayStudio (${d.id}).`);
				break;
			}
			case 'clear':
				act('clear', 'Limpe as regras de cenário e as falhas do PayStudio.');
				break;
			case 'clear-failures':
				act('clear', 'Desligue as falhas do gateway no PayStudio: volte ao normal.');
				break;
			case 'failure': {
				const gateway = draft('fail-gw', 'any');
				const mode = draft('fail-mode', 'unavailable');
				const calls = Math.round(Number(draft('fail-calls', '5')));
				const rate = Math.round(Number(draft('fail-rate', '100')));
				const latency = Number(String(draft('fail-latency', '8')).replace(',', '.'));
				if (!(calls >= 1 && calls <= 1000)) { toast('O número de chamadas vai de 1 a 1.000.'); break; }
				if (!(rate >= 1 && rate <= 100)) { toast('A porcentagem vai de 1 a 100.'); break; }
				if (mode === 'slow' && !(latency >= 0.1 && latency <= 60)) { toast('A demora vai de 0,1 a 60 segundos.'); break; }
				const what = { unavailable: 'responder 503', slow: `demorar ${String(latency).replace('.', ',')} s para responder`, timeout: 'não responder (timeout)', refuse: 'recusar a conexão', rate_limit: 'responder 429 (limite de chamadas)' }[mode];
				act('failure', `Faça ${GATEWAY_PHRASE[gateway]} do PayStudio ${what} nas próximas ${calls} chamadas${rate < 100 ? `, em ${rate}% delas` : ''}.`);
				break;
			}
			case 'ask-booking':
				ask(`Sobre o agendamento ${d.id} no PayStudio: `, false);
				break;
			case 'fix-booking': {
				const charges = S.charges.filter(x => x.booking === d.id);
				const problems = bookingChecks(d.id, charges).filter(x => x.mk === 'bad').map(x => x.text.replace(/<[^>]+>/g, ''));
				ask(`No PayStudio, o agendamento ${d.id} teve problemas: ${problems.join('; ')}. Descubra no código do app por que isso acontece e corrija.`, true);
				break;
			}
			case 'call':
				S.callSel = Number(d.id);
				remember();
				render();
				break;
			case 'call-filter':
				S.callFilter = d.id;
				render();
				break;
			case 'fix-call': {
				const call = S.calls.find(k => k.id === Number(d.id));
				if (call) {
					const message = call.error?.message || parse(call.res)?.error?.message || '';
					ask(`No PayStudio, a chamada ${call.method} ${call.path} do app às ${clock(call.at)} respondeu ${call.status}${message ? `: "${message.slice(0, 240)}"` : ''}. Descubra no código do projeto por que isso acontece e corrija.`, true);
				}
				break;
			}
			case 'card':
				S.cardSel = d.id;
				S.cardNumber = d.number;
				render();
				break;
			case 'copy-card':
				if (S.cardNumber) { copy(S.cardNumber.replace(/\s/g, ''), `Número ${S.cardNumber} copiado.`); }
				break;
			case 'catalog-gw':
				S.catalogSel = d.id;
				S.view = 'catalog';
				remember();
				render();
				break;
			case 'connect':
				act('connect', 'Conecte o meu app ao PayStudio: ache no código as rotas de webhook do Pix, do Mercado Pago e do Stripe e configure cada uma.');
				break;
			case 'env':
				act('env', 'Crie o .env.local do projeto com os endereços e as chaves de teste do PayStudio.');
				break;
			case 'set-webhook':
				ask(`Configure no PayStudio o webhook ${GW[d.id]?.of || ''} para a rota do app: `, false);
				break;
			case 'set-storage':
				S.confirm = d.id === 'persistent'
					? { title: 'Guardar entre sessões', text: 'O PayStudio religa e passa a guardar as cobranças, os webhooks e as chamadas quando for desligado.', yes: 'Religar', ask: 'Religue o PayStudio guardando as cobranças entre sessões.' }
					: { title: 'Guardar só na memória', text: 'O PayStudio religa e o que está guardado deixa de voltar na próxima vez.', yes: 'Religar', ask: 'Religue o PayStudio com as cobranças só na memória.' };
				render();
				break;
			case 'reset':
				S.confirm = { title: 'Apagar tudo', text: 'As cobranças, os webhooks, os cenários e as chamadas do PayStudio serão apagados. As configurações e as chaves de teste continuam.', yes: 'Apagar', ask: 'Apague todas as cobranças, webhooks, cenários e chamadas do PayStudio.' };
				render();
				break;
			case 'confirm-yes': {
				const text = S.confirm?.ask;
				const kind = S.confirm?.title === 'Apagar tudo' ? 'reset' : 'start';
				S.confirm = null;
				if (text) { act(kind, text); }
				break;
			}
			case 'confirm-no':
				S.confirm = null;
				render();
				break;
		}
	}

	function onInput(event) {
		const el = event.target;
		if (el.dataset.draft) {
			S.drafts[el.dataset.draft] = el.type === 'checkbox' ? el.checked : el.value;
		}
		if (el.dataset.act === 'charge-text') { S.chargeText = el.value; render(); }
		if (el.dataset.act === 'hook-text') { S.hookText = el.value; render(); }
		if (el.dataset.act === 'card-text') { S.cardText = el.value; render(); }
	}

	function onChange(event) {
		const el = event.target;
		if (el.dataset.draft) {
			S.drafts[el.dataset.draft] = el.type === 'checkbox' ? el.checked : el.value;
		}
		switch (el.dataset.act) {
			case 'charge-gw': S.chargeGw = el.value; render(); break;
			case 'hook-gw': S.hookGw = el.value; render(); break;
			case 'card-gw': S.cardGw = el.value; render(); break;
			case 'card-result': S.drafts['card-result'] = el.value; render(); break;
			case 'timeline-booking': S.tlBooking = el.value; remember(); render(); break;
		}
	}

	// ------------------------------------------------------------------ host messages

	/** Follows a selection the agent pointed at with focus (view.json). */
	function applySelect(view, select) {
		if (!select) { return; }
		const c = findCharge(select);
		const hook = findHook(select);
		if (view === 'charges' && c) { S.sel = chargeKey(c); S.chargeOpen = true; }
		if (view === 'webhooks') {
			const target = hook || (c && S.deliveries.find(d => d.ref === c.ref && d.gateway === c.gateway));
			if (target) { S.hookSel = target.id; S.hookOpen = !!hook; }
		}
		if (view === 'timeline') { S.tlBooking = c?.booking || String(select); }
		if (view === 'calls') {
			const call = /^\d+$/.test(String(select)) ? S.calls.find(k => k.id === Number(select)) : c && S.calls.filter(k => k.ref === c.ref).slice(-1)[0];
			if (call) { S.callSel = call.id; }
		}
		if (view === 'scenarios' && S.pay?.presets?.[select]) { S.scenSel = select; }
		if (view === 'catalog' && CATALOG[select]) { S.catalogSel = select; }
	}

	function readFiles(files) {
		const json = name => (typeof files[name] === 'string' ? parse(files[name]) : undefined);
		const pay = json('pay.json');
		S.pay = pay && typeof pay === 'object' ? pay : null;
		const charges = json('charges.json');
		S.charges = Array.isArray(charges?.charges) ? charges.charges.filter(c => c && GW[c.gateway]).map(c => ({ ...c, events: Array.isArray(c.events) ? c.events : [], flags: Array.isArray(c.flags) ? c.flags : [], details: c.details && typeof c.details === 'object' ? c.details : {} })) : [];
		const hooks = json('webhooks.json');
		S.deliveries = Array.isArray(hooks?.deliveries) ? hooks.deliveries.filter(d => d && typeof d === 'object').map(d => ({ ...d, attempts: Array.isArray(d.attempts) ? d.attempts : [] })) : [];
		const calls = json('calls.json');
		S.calls = Array.isArray(calls?.calls) ? calls.calls.filter(k => k && typeof k === 'object') : [];
		S.callTotal = calls?.total || S.calls.length;
		const settings = json('settings.json');
		S.settings = settings && typeof settings === 'object' ? settings : {};
		const view = json('view.json');
		if (view && typeof view.revision === 'number' && view.revision !== S.viewRevision) {
			const first = S.viewRevision === 0 && saved.viewRevision === view.revision;
			S.viewRevision = view.revision;
			if (!first) {
				if (VIEWS[view.view]) {
					S.view = view.view;
					S.menu = false;
					if (view.view === 'charges') { S.chargeOpen = false; }
					if (view.view === 'webhooks') { S.hookOpen = false; }
				}
				applySelect(view.view, view.select);
				if (typeof view.note === 'string' && view.note.trim()) { toast(view.note.trim()); }
				remember();
			}
		}
		if (S.pending) {
			const age = Date.now() - S.pending.at;
			if ((S.pending.kind === 'start' && payOn()) || (S.pending.kind === 'stop' && !payOn()) || age > 90000) {
				S.pending = null;
			}
		}
	}

	window.addEventListener('message', event => {
		const msg = event.data;
		if (!msg || typeof msg !== 'object') { return; }
		switch (msg.type) {
			case 'init':
			case 'context':
				S.ctx = msg.context && typeof msg.context === 'object' ? msg.context : null;
				render();
				break;
			case 'files':
				readFiles(msg.files || {});
				render();
				break;
			case 'filesError':
				toast(typeof msg.message === 'string' ? msg.message : 'Não foi possível atualizar o PayStudio.');
				break;
			case 'running':
				S.running = !!msg.running;
				break;
			case 'request':
				if (S.pending && S.pending.requestId === msg.requestId && ['settled', 'rejected', 'unconfirmed'].includes(msg.state)) {
					if (msg.state === 'rejected') { toast('O agente está ocupado. Tente de novo quando ele terminar.'); }
					S.pending = null;
					render();
				}
				break;
		}
	});

	document.addEventListener('click', onClick);
	// A double click on a charge or a webhook opens it (the first click already re-rendered the list).
	document.addEventListener('dblclick', event => {
		const row = event.target.closest('tr[data-act="charge"], tr[data-act="hook"]');
		if (!row) { return; }
		if (row.dataset.act === 'charge') {
			const c = findCharge(row.dataset.key);
			if (c) { openCharge(chargeKey(c)); }
		} else if (S.deliveries.some(d => d.id === Number(row.dataset.id))) {
			S.view = 'webhooks';
			S.hookSel = Number(row.dataset.id);
			S.hookOpen = true;
			S.attemptSel = null;
			remember();
			render();
		}
	});
	document.addEventListener('input', onInput);
	window.addEventListener('resize', () => render());
	document.addEventListener('change', onChange);
	// The countdown of a pending Pix and the "Ligando…" steps move with the clock; never while a list is open.
	setInterval(() => {
		document.querySelectorAll('[data-left]').forEach(el => { el.textContent = mmss(Number(el.dataset.left) - nowSec()); });
		document.querySelectorAll('[data-left-dur]').forEach(el => { el.textContent = duration(Number(el.dataset.leftDur) - nowSec()); });
		if (S.pending && !payOn()) { render(); }
	}, 1000);

	render();
	host.postMessage({ type: 'ready' });
})();
