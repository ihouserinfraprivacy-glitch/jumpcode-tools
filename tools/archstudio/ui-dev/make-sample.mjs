/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Dev only: writes the "Rota Certa" sample Studio files (and a large synthetic model) that the
// harness feeds to the ArchStudio interface. Run: node make-sample.mjs
import { mkdirSync, writeFileSync } from 'node:fs';

const out = new URL('./sample/', import.meta.url);
mkdirSync(out, { recursive: true });

const nodes = [];
const links = [];
let linkSeq = 0;
const byId = new Map();

function add(node) {
	nodes.push(node);
	byId.set(node.id, node);
	return node;
}
function link(from, to, level, protocol, extra = {}) {
	const l = { id: extra.id ?? `l${++linkSeq}`, from, to, level, protocol, async: false, count: 1, ...extra };
	delete l.idOverride;
	links.push(l);
	return l;
}
const langOf = name => {
	const m = /\.([a-z0-9]+)$/i.exec(name);
	if (!m) { return name === 'Dockerfile' ? 'docker' : 'txt'; }
	return { yml: 'yaml', tsx: 'ts', jsx: 'js', mod: 'go' }[m[1]] ?? m[1];
};

function system(key, name, kind, tech, summary, extra = {}) {
	return add({ id: `s:${key}`, level: 'system', parent: null, name, kind, tech, path: extra.path ?? key, summary, ...extra });
}
function service(sys, rel, name, extra = {}) {
	const s = byId.get(sys);
	const path = `${s.path}/${rel}`;
	return add({ id: `v:${path}`, level: 'service', parent: sys, name, kind: extra.kind ?? s.kind, tech: extra.tech ?? s.tech, path, ...extra });
}
function files(svc, list) {
	const v = byId.get(svc);
	for (const [rel, lines, summary] of list) {
		const slash = rel.lastIndexOf('/');
		const folder = slash < 0 ? '' : rel.slice(0, slash);
		const name = rel.slice(slash + 1);
		const path = `${v.path}/${rel}`;
		add({ id: `f:${path}`, level: 'file', parent: svc, name, kind: 'file', path, lines, lang: langOf(name), folder, ...(summary ? { summary } : {}) });
	}
}
function top(id, level, name, kind, tech, summary) {
	return add({ id, level, parent: null, name, kind, tech, summary });
}
const F = (svc, rel) => `f:${byId.get(svc).path}/${rel}`;

// ---------------------------------------------------------------- systems
system('apps/cliente', 'App do Cliente', 'mobile', 'React Native', 'App de pedidos e pagamentos para quem compra.', { path: 'apps/cliente' });
system('apps/entregador', 'App do Entregador', 'mobile', 'Flutter', 'App de rotas e comprovantes para quem entrega; funciona sem internet.', { path: 'apps/entregador' });
system('web/painel', 'Painel Web', 'web', 'Next.js', 'Painel de operação, cadastros e relatórios.', { path: 'web/painel' });
system('plataforma', 'Plataforma', 'backend', 'Go', 'Serviços que recebem pedidos, cobram, calculam rotas e avisam clientes.', { path: 'plataforma' });
system('firmware/rastreador', 'Rastreador', 'embedded', 'C · ESP32-S3', 'Firmware FreeRTOS que lê o GPS e envia a posição por MQTT.', { path: 'firmware/rastreador' });
system('dados', 'Dados e Relatórios', 'data', 'BigQuery', 'Carga diária de eventos e painéis de negócio.', { path: 'dados' });

top('d:postgresql', 'data', 'PostgreSQL', 'data', 'PostgreSQL 16', 'Banco principal: pedidos, pagamentos e cadastros.');
top('d:redis', 'data', 'Redis', 'data', 'Redis 7', 'Cache e sessões.');
top('q:rabbitmq', 'queue', 'RabbitMQ', 'queue', 'AMQP', 'Eventos entre serviços.');
top('q:emqx', 'queue', 'EMQX', 'queue', 'MQTT', 'Mensagens dos rastreadores.');
top('x:gateway-pix', 'external', 'Gateway Pix', 'external', 'Externo', 'Cobranças e confirmações');
top('x:google-maps', 'external', 'Google Maps', 'external', 'Externo', 'Rotas e distâncias');
top('x:whatsapp', 'external', 'WhatsApp Business', 'external', 'Externo', 'Avisos ao cliente');

// ---------------------------------------------------------------- App do Cliente (roles)
const AC = 's:apps/cliente';
service(AC, 'src/telas/pedido', 'Pedido', { role: 'screen', summary: 'monta o carrinho e envia o pedido' });
service(AC, 'src/telas/conta', 'Conta', { role: 'screen', summary: 'perfil e endereços' });
service(AC, 'src/estado/pedidos', 'pedidosStore', { role: 'state', summary: 'estado do carrinho e do pedido' });
service(AC, 'src/repositorios/pedidos', 'PedidosRepo', { role: 'repository', summary: 'pedidos e pagamentos' });
service(AC, 'src/api', 'apiClient', { role: 'source', summary: 'HTTPS → Plataforma' });
const acv = id => `v:apps/cliente/src/${id}`;
files(acv('telas/pedido'), [['PedidoTela.tsx', 240], ['Carrinho.tsx', 180], ['PagarPix.tsx', 160], ['Avisos.tsx', 90]]);
files(acv('telas/conta'), [['ContaTela.tsx', 150], ['Enderecos.tsx', 120]]);
files(acv('estado/pedidos'), [['pedidosStore.ts', 130], ['carrinho.ts', 95]]);
files(acv('repositorios/pedidos'), [['PedidosRepo.ts', 110]]);
files(acv('api'), [['apiClient.ts', 140], ['auth.ts', 70]]);

// ---------------------------------------------------------------- App do Entregador (roles)
const AE = 's:apps/entregador';
const ae = (rel, name, role, summary, extra = {}) => service(AE, `lib/${rel}`, name, { role, summary, ...extra });
ae('telas/login', 'Login', 'screen', 'tela');
ae('telas/entregas', 'Entregas do dia', 'screen', 'tela');
ae('telas/rota', 'Rota no mapa', 'screen', 'tela');
ae('telas/comprovante', 'Comprovante', 'screen', 'foto e assinatura');
ae('telas/perfil', 'Perfil', 'screen', 'tela');
ae('estado/auth', 'AuthBloc', 'state', 'estado');
ae('estado/entregas', 'EntregasBloc', 'state', 'estado');
ae('estado/rota', 'RotaBloc', 'state', 'estado');
ae('estado/comprovante', 'ComprovanteBloc', 'state', 'estado');
ae('repositorios/auth', 'AuthRepository', 'repository', 'repositório');
ae('repositorios/entregas', 'EntregasRepository', 'repository', 'repositório');
ae('repositorios/rota', 'RotaRepository', 'repository', 'repositório');
ae('fontes/api', 'ApiCliente', 'source', 'HTTPS → Plataforma', { tech: 'dio' });
ae('fontes/banco', 'Banco local', 'source', 'Drift · SQLite', { tech: 'SQLite' });
ae('fontes/sync', 'Sincronização', 'source', 'envia quando volta a internet');
ae('fontes/gps', 'GPS', 'source', 'geolocator');
ae('fontes/camera', 'Câmera', 'source', 'foto do comprovante');
const aev = rel => `v:apps/entregador/lib/${rel}`;
for (const [rel, list] of Object.entries({
	'telas/login': [['login_tela.dart', 120], ['login_form.dart', 80]],
	'telas/entregas': [['entregas_tela.dart', 210], ['entrega_card.dart', 90]],
	'telas/rota': [['rota_tela.dart', 180], ['mapa_widget.dart', 140]],
	'telas/comprovante': [['comprovante_tela.dart', 160], ['assinatura.dart', 110]],
	'telas/perfil': [['perfil_tela.dart', 100]],
	'estado/auth': [['auth_bloc.dart', 90]],
	'estado/entregas': [['entregas_bloc.dart', 150], ['entregas_state.dart', 60]],
	'estado/rota': [['rota_bloc.dart', 120]],
	'estado/comprovante': [['comprovante_bloc.dart', 110]],
	'repositorios/auth': [['auth_repository.dart', 80]],
	'repositorios/entregas': [['entregas_repository.dart', 170]],
	'repositorios/rota': [['rota_repository.dart', 90]],
	'fontes/api': [['api_cliente.dart', 140], ['interceptors.dart', 60]],
	'fontes/banco': [['banco.dart', 120], ['tabelas.dart', 80]],
	'fontes/sync': [['sincronizacao.dart', 130]],
	'fontes/gps': [['gps.dart', 70]],
	'fontes/camera': [['camera.dart', 60]],
})) { files(aev(rel), list); }

// ---------------------------------------------------------------- Painel Web (roles)
const PW = 's:web/painel';
service(PW, 'app/operacao', 'operação', { role: 'screen', summary: 'pedidos ao vivo e entregadores' });
service(PW, 'app/relatorios', 'relatórios', { role: 'screen', summary: 'vendas e prazos' });
service(PW, 'app/cadastros', 'cadastros', { role: 'screen', summary: 'lojas, produtos e cupons' });
service(PW, 'lib/graphql', 'graphqlClient', { role: 'source', summary: 'GraphQL → Plataforma' });
files('v:web/painel/app/operacao', [['page.tsx', 220], ['mapa.tsx', 180], ['fila.tsx', 140]]);
files('v:web/painel/app/relatorios', [['page.tsx', 160], ['graficos.tsx', 200]]);
files('v:web/painel/app/cadastros', [['page.tsx', 150], ['formulario.tsx', 190]]);
files('v:web/painel/lib/graphql', [['client.ts', 90], ['queries.ts', 160]]);

// ---------------------------------------------------------------- Plataforma (services)
const PL = 's:plataforma';
const ps = name => `v:plataforma/servicos/${name}`;
service(PL, 'servicos/api-gateway', 'api-gateway', { role: 'service', summary: 'entrada de tudo', tech: 'Go 1.22' });
service(PL, 'servicos/auth', 'auth', { role: 'service', summary: 'login e tokens', tech: 'Go 1.22' });
service(PL, 'servicos/pedidos', 'pedidos', {
	role: 'service', tech: 'Go 1.22', summary: 'Recebe pedidos pelo gateway, cobra em pagamentos e avisa os outros pela fila.',
	endpoints: [
		{ method: 'POST', path: '/pedidos', file: 'plataforma/servicos/pedidos/internal/http/handlers.go', line: 41 },
		{ method: 'GET', path: '/pedidos/{id}', file: 'plataforma/servicos/pedidos/internal/http/handlers.go', line: 88 },
		{ method: 'PATCH', path: '/pedidos/{id}/status', file: 'plataforma/servicos/pedidos/internal/dominio/status.go', line: 22 },
	],
	publishes: ['pedido.criado', 'pedido.cancelado'], consumes: ['pagamento.confirmado'],
});
service(PL, 'servicos/pagamentos', 'pagamentos', {
	role: 'service', summary: 'Pix e estornos', tech: 'Go 1.22', publishes: ['pagamento.confirmado'],
	endpoints: [{ method: 'RPC', path: 'Cobrar', file: 'plataforma/servicos/pagamentos/internal/grpc/servidor.go', line: 30 }, { method: 'RPC', path: 'Estornar', file: 'plataforma/servicos/pagamentos/internal/grpc/servidor.go', line: 58 }],
});
service(PL, 'servicos/rotas', 'rotas', { role: 'service', summary: 'frete e trajeto', tech: 'Go 1.22' });
service(PL, 'servicos/notificacoes', 'notificações', { role: 'service', summary: 'WhatsApp e push', tech: 'Go 1.22', consumes: ['pedido.criado', 'pagamento.confirmado'] });
service(PL, 'servicos/rastreamento', 'rastreamento', { role: 'service', summary: 'posição dos veículos', tech: 'Go 1.22', consumes: ['rastreador/+/posicao'] });

files(ps('pedidos'), [
	['cmd/pedidos/main.go', 48, 'inicia o servidor'],
	['config/pedidos.yaml', 36, 'portas e filas'],
	['internal/http/rotas.go', 64, '6 rotas'],
	['internal/http/handlers.go', 212, 'CriarPedido, ListarPedidos, Cancelar'],
	['internal/http/middleware.go', 77, 'token e logs'],
	['internal/http/cancelar.go', 58],
	['internal/http/handlers_test.go', 160],
	['internal/dominio/pedido.go', 139, 'regras do pedido'],
	['internal/dominio/status.go', 88, '7 estados'],
	['internal/dominio/itens.go', 64],
	['internal/dominio/frete.go', 52],
	['internal/dominio/pedido_test.go', 120],
	['internal/repositorio/pedidos_pg.go', 186, 'consultas SQL'],
	['internal/repositorio/itens_pg.go', 92],
	['internal/pagamento/cliente_grpc.go', 94, 'Cobrar, Estornar'],
	['internal/pagamento/reprocessar.go', 41],
	['internal/eventos/publicador.go', 71, '3 eventos'],
	['internal/eventos/eventos.go', 45],
	['internal/eventos/consumidor.go', 66],
	['migrations/0001_init.sql', 40],
	['migrations/0002_itens.sql', 28],
	['migrations/0003_pedidos.sql', 33, 'cria 3 tabelas'],
	['go.mod', 12],
	['Dockerfile', 22],
]);
const genFiles = (svc, names) => files(svc, names.map((n, i) => [n, 30 + ((n.length * 37 + i * 53) % 230)]));
genFiles(ps('api-gateway'), ['cmd/gateway/main.go', 'internal/rotas/rotas.go', 'internal/rotas/proxy.go', 'internal/auth/token.go', 'internal/limites/limites.go', 'internal/sessao/redis.go', 'internal/graphql/schema.go', 'internal/graphql/resolvers.go', 'internal/ws/websocket.go', 'config/gateway.yaml', 'go.mod']);
genFiles(ps('auth'), ['cmd/auth/main.go', 'internal/login/login.go', 'internal/login/senha.go', 'internal/token/jwt.go', 'internal/token/renovar.go', 'internal/repositorio/usuarios_pg.go', 'internal/sessao/redis.go', 'migrations/0001_usuarios.sql', 'go.mod']);
genFiles(ps('pagamentos'), ['cmd/pagamentos/main.go', 'internal/grpc/servidor.go', 'internal/grpc/pagamentos.pb.go', 'internal/pix/cliente.go', 'internal/pix/webhook.go', 'internal/pix/qrcode.go', 'internal/estorno/estorno.go', 'internal/repositorio/cobrancas_pg.go', 'internal/eventos/publicador.go', 'migrations/0001_cobrancas.sql', 'migrations/0002_estornos.sql', 'go.mod']);
genFiles(ps('rotas'), ['cmd/rotas/main.go', 'internal/frete/frete.go', 'internal/frete/tabela.go', 'internal/trajeto/trajeto.go', 'internal/trajeto/otimizador.go', 'internal/mapas/google.go', 'internal/mapas/cache.go', 'internal/grpc/servidor.go', 'internal/repositorio/zonas_pg.go', 'go.mod']);
genFiles(ps('notificacoes'), ['cmd/notificacoes/main.go', 'internal/whatsapp/cliente.go', 'internal/whatsapp/modelos.go', 'internal/push/fcm.go', 'internal/eventos/consumidor.go', 'internal/pedidos/status.go', 'go.mod']);
genFiles(ps('rastreamento'), ['cmd/rastreamento/main.go', 'internal/mqtt/assinante.go', 'internal/mqtt/mensagem.go', 'internal/posicao/posicao.go', 'internal/posicao/filtro.go', 'internal/posicao/cache.go', 'internal/rotas/cliente_grpc.go', 'internal/alertas/alertas.go', 'go.mod']);

// ---------------------------------------------------------------- Rastreador (roles: task/module/driver/hardware)
const RS = 's:firmware/rastreador';
const rs = (rel, name, role, summary) => service(RS, rel, name, { role, summary, tech: role === 'hardware' ? undefined : 'C' });
rs('src/tarefas/gps', 'gps_task', 'task', 'prioridade 3 · a cada 5 s');
rs('src/tarefas/modem', 'modem_task', 'task', 'prioridade 4');
rs('src/tarefas/sensores', 'sensores_task', 'task', 'prioridade 2');
rs('src/tarefas/mqtt', 'mqtt_task', 'task', 'prioridade 4');
rs('src/tarefas/ota', 'ota_task', 'task', 'prioridade 1');
rs('src/modulos/fila_offline', 'fila_offline', 'module', 'guarda sem sinal');
rs('src/modulos/protocolo', 'protocolo', 'module', 'CBOR');
rs('src/modulos/energia', 'energia', 'module', 'modo econômico');
rs('src/drivers/uart_gps', 'uart_gps', 'driver', 'driver');
rs('src/drivers/uart_modem', 'uart_modem', 'driver', 'driver');
rs('src/drivers/i2c_sensores', 'i2c_sensores', 'driver', 'driver');
rs('src/drivers/spi_flash', 'spi_flash', 'driver', 'driver');
rs('src/drivers/adc_bateria', 'adc_bateria', 'driver', 'driver');
rs('hw/gps', 'GPS NEO-M8N', 'hardware', 'antena externa');
rs('hw/modem', 'Modem SIM7600', 'hardware', 'LTE Cat-1');
rs('hw/sensores', 'Porta e temperatura', 'hardware', 'SHT31 · reed');
rs('hw/flash', 'Flash W25Q128', 'hardware', '16 MB');
rs('hw/bateria', 'Bateria 3,7 V', 'hardware', '5.000 mAh');
const rv = rel => `v:firmware/rastreador/src/${rel}`;
files(rv('tarefas/gps'), [['gps_task.c', 180, 'lê frases NMEA, filtra a posição e entrega a cada 5 s'], ['nmea.c', 140], ['gps.h', 40]]);
files(rv('tarefas/modem'), [['modem_task.c', 220], ['at.c', 160], ['modem.h', 35]]);
files(rv('tarefas/sensores'), [['sensores_task.c', 110], ['sensores.h', 25]]);
files(rv('tarefas/mqtt'), [['mqtt_task.c', 240], ['mqtt.h', 30]]);
files(rv('tarefas/ota'), [['ota_task.c', 150]]);
files(rv('modulos/fila_offline'), [['fila_offline.c', 130], ['fila_offline.h', 20]]);
files(rv('modulos/protocolo'), [['cbor.c', 170], ['protocolo.h', 30]]);
files(rv('modulos/energia'), [['energia.c', 90]]);
files(rv('drivers/uart_gps'), [['uart_gps.c', 80]]);
files(rv('drivers/uart_modem'), [['uart_modem.c', 85]]);
files(rv('drivers/i2c_sensores'), [['i2c_sensores.c', 95]]);
files(rv('drivers/spi_flash'), [['spi_flash.c', 120]]);
files(rv('drivers/adc_bateria'), [['adc_bateria.c', 60]]);

// ---------------------------------------------------------------- Dados
const DA = 's:dados';
service(DA, 'etl', 'etl', { role: 'service', summary: 'carga diária dos eventos', tech: 'Python' });
service(DA, 'paineis', 'painéis', { role: 'service', summary: 'painéis de negócio', tech: 'Looker' });
genFiles('v:dados/etl', ['carga.py', 'transformar.py', 'eventos.py', 'agenda.py', 'esquema.sql', 'requirements.txt']);
genFiles('v:dados/paineis', ['vendas.lkml', 'entregas.lkml', 'modelo.lkml']);

// ---------------------------------------------------------------- links: system level
const sysLinks = [
	['s:apps/cliente', 's:plataforma', 'HTTPS', { label: 'HTTPS · REST', count: 14 }],
	['s:apps/entregador', 's:plataforma', 'HTTPS', { label: 'HTTPS + WebSocket', count: 11 }],
	['s:web/painel', 's:plataforma', 'GraphQL', { label: 'GraphQL', count: 9 }],
	['s:plataforma', 'x:gateway-pix', 'HTTPS', { label: 'HTTPS', count: 4 }],
	['s:plataforma', 'x:google-maps', 'HTTPS', { label: 'HTTPS', count: 3 }],
	['s:plataforma', 'x:whatsapp', 'HTTPS', { label: 'HTTPS', count: 2 }],
	['s:plataforma', 's:dados', 'AMQP', { label: 'eventos', async: true, count: 2 }],
	['s:firmware/rastreador', 's:plataforma', 'MQTT', { label: 'MQTT · LTE', async: true, count: 3, id: 'l-mqtt' }],
];
for (const [a, b, p, x] of sysLinks) { link(a, b, 'system', p, x); }

// ---------------------------------------------------------------- links: service level
const sv = (a, b, p, x = {}) => link(a, b, 'service', p, x);
sv(acv('api'), ps('api-gateway'), 'HTTPS', { label: 'HTTPS · REST', count: 14 });
sv(aev('fontes/api'), ps('api-gateway'), 'HTTPS', { label: 'HTTPS + WebSocket', count: 11 });
sv('v:web/painel/lib/graphql', ps('api-gateway'), 'GraphQL', { label: 'GraphQL', count: 9 });
sv(rv('tarefas/mqtt'), 'q:emqx', 'MQTT', { label: 'MQTT via LTE', async: true, count: 3 });
sv('q:emqx', ps('rastreamento'), 'MQTT', { label: 'posição', async: true, count: 2 });
sv(ps('api-gateway'), ps('auth'), 'HTTP', { label: 'valida token', count: 4, evidence: [{ path: 'plataforma/servicos/api-gateway/internal/auth/token.go', line: 18 }] });
sv(ps('api-gateway'), ps('pedidos'), 'HTTP', { label: 'REST', count: 9, evidence: [{ path: 'plataforma/servicos/api-gateway/internal/rotas/rotas.go', line: 33 }] });
sv(ps('api-gateway'), ps('rotas'), 'HTTP', { label: 'REST', count: 5 });
sv(ps('api-gateway'), ps('rastreamento'), 'HTTP', { label: 'REST', count: 3 });
sv(ps('api-gateway'), 'd:redis', 'Redis', { label: 'sessões', count: 3 });
sv(ps('auth'), 'd:redis', 'Redis', { label: 'tokens', count: 2 });
sv(ps('auth'), 'd:postgresql', 'SQL', { count: 5 });
sv(ps('pedidos'), ps('pagamentos'), 'gRPC', {
	label: 'gRPC', count: 6, evidence: [
		{ path: 'plataforma/servicos/pedidos/internal/pagamento/cliente_grpc.go', line: 24 },
		{ path: 'plataforma/servicos/pedidos/internal/pagamento/cliente_grpc.go', line: 41 },
		{ path: 'plataforma/servicos/pedidos/internal/pagamento/cliente_grpc.go', line: 58 },
		{ path: 'plataforma/servicos/pedidos/internal/http/handlers.go', line: 45 },
		{ path: 'plataforma/servicos/pedidos/internal/http/cancelar.go', line: 31 },
		{ path: 'plataforma/servicos/pedidos/internal/pagamento/reprocessar.go', line: 19 },
	],
});
sv(ps('pedidos'), 'd:postgresql', 'SQL', { label: 'lê e grava', count: 14 });
sv(ps('pedidos'), 'q:rabbitmq', 'AMQP', { label: 'pedido.criado', async: true, count: 3 });
sv(ps('pedidos'), ps('notificacoes'), 'HTTP', { label: 'avisa status', count: 2, id: 'l-ciclo-1', evidence: [{ path: 'plataforma/servicos/pedidos/internal/http/handlers.go', line: 52 }, { path: 'plataforma/servicos/pedidos/internal/http/cancelar.go', line: 40 }] });
sv(ps('notificacoes'), ps('pedidos'), 'HTTP', { label: 'lê status', count: 3, id: 'l-ciclo-2', evidence: [{ path: 'plataforma/servicos/notificacoes/internal/pedidos/status.go', line: 17 }] });
sv(ps('pagamentos'), 'd:postgresql', 'SQL', { count: 8 });
sv(ps('pagamentos'), 'q:rabbitmq', 'AMQP', { label: 'pagamento.confirmado', async: true, count: 2 });
sv(ps('pagamentos'), 'x:gateway-pix', 'HTTPS', { label: 'HTTPS', count: 4 });
sv(ps('rotas'), 'x:google-maps', 'HTTPS', { label: 'HTTPS', count: 3 });
sv(ps('rotas'), 'd:postgresql', 'SQL', { count: 6 });
sv('q:rabbitmq', ps('notificacoes'), 'AMQP', { label: 'consome', async: true, count: 4 });
sv(ps('notificacoes'), 'x:whatsapp', 'HTTPS', { label: 'HTTPS', count: 2 });
sv(ps('rastreamento'), ps('rotas'), 'gRPC', { label: 'posição', count: 7 });
sv(ps('rastreamento'), 'q:rabbitmq', 'AMQP', { label: 'veiculo.parado', async: true, count: 2 });
sv('q:rabbitmq', 'v:dados/etl', 'AMQP', { label: 'eventos', async: true, count: 2 });
sv('v:dados/etl', 'v:dados/paineis', 'SQL', { label: 'tabelas', count: 3 });
// App do Entregador inside
sv(aev('telas/login'), aev('telas/entregas'), 'import', { label: '' });
sv(aev('telas/entregas'), aev('telas/rota'), 'import');
sv(aev('telas/rota'), aev('telas/comprovante'), 'import');
sv(aev('telas/login'), aev('estado/auth'), 'import');
sv(aev('telas/entregas'), aev('estado/entregas'), 'import');
sv(aev('telas/rota'), aev('estado/rota'), 'import');
sv(aev('telas/comprovante'), aev('estado/comprovante'), 'import');
sv(aev('telas/perfil'), aev('estado/auth'), 'import');
sv(aev('estado/auth'), aev('repositorios/auth'), 'import');
sv(aev('estado/entregas'), aev('repositorios/entregas'), 'import');
sv(aev('estado/rota'), aev('repositorios/rota'), 'import');
sv(aev('estado/comprovante'), aev('repositorios/entregas'), 'import');
sv(aev('repositorios/auth'), aev('fontes/api'), 'import');
sv(aev('repositorios/entregas'), aev('fontes/banco'), 'import', { label: 'grava primeiro' });
sv(aev('repositorios/entregas'), aev('fontes/api'), 'import');
sv(aev('fontes/banco'), aev('fontes/sync'), 'import');
sv(aev('fontes/sync'), aev('fontes/api'), 'import', { label: 'com sinal', async: true });
sv(aev('repositorios/rota'), aev('fontes/gps'), 'import');
sv(aev('estado/comprovante'), aev('fontes/camera'), 'import');
// App do Cliente inside
sv(acv('telas/pedido'), acv('estado/pedidos'), 'import');
sv(acv('telas/conta'), acv('estado/pedidos'), 'import');
sv(acv('estado/pedidos'), acv('repositorios/pedidos'), 'import');
sv(acv('repositorios/pedidos'), acv('api'), 'import');
// Painel inside
sv('v:web/painel/app/operacao', 'v:web/painel/lib/graphql', 'import');
sv('v:web/painel/app/relatorios', 'v:web/painel/lib/graphql', 'import');
sv('v:web/painel/app/cadastros', 'v:web/painel/lib/graphql', 'import');
// Rastreador inside
sv(rv('tarefas/gps'), rv('drivers/uart_gps'), 'call');
sv(rv('tarefas/modem'), rv('drivers/uart_modem'), 'call');
sv(rv('tarefas/sensores'), rv('drivers/i2c_sensores'), 'call');
sv(rv('tarefas/gps'), rv('tarefas/mqtt'), 'queue', { label: 'posição', async: true });
sv(rv('tarefas/mqtt'), rv('tarefas/modem'), 'queue', { label: 'pacotes' });
sv(rv('tarefas/mqtt'), rv('modulos/fila_offline'), 'call', { label: 'sem sinal', async: true });
sv(rv('tarefas/mqtt'), rv('modulos/protocolo'), 'call');
sv(rv('tarefas/ota'), rv('tarefas/modem'), 'call');
sv(rv('modulos/fila_offline'), rv('drivers/spi_flash'), 'call');
sv(rv('modulos/energia'), rv('drivers/adc_bateria'), 'call');
sv(rv('tarefas/sensores'), rv('modulos/energia'), 'call');
sv(rv('drivers/uart_gps'), 'v:firmware/rastreador/hw/gps', 'UART', { label: 'UART1 · 9600' });
sv(rv('drivers/uart_modem'), 'v:firmware/rastreador/hw/modem', 'UART', { label: 'UART2 · AT' });
sv(rv('drivers/i2c_sensores'), 'v:firmware/rastreador/hw/sensores', 'I2C', { label: 'I²C 0x44' });
sv(rv('drivers/spi_flash'), 'v:firmware/rastreador/hw/flash', 'SPI', { label: 'SPI 20 MHz' });
sv(rv('drivers/adc_bateria'), 'v:firmware/rastreador/hw/bateria', 'ADC', { label: 'ADC' });

// ---------------------------------------------------------------- links: file level (pedidos)
const P = ps('pedidos');
const fl = (a, b, p = 'import', x = {}) => link(a, b, 'file', p, x);
const pf = rel => F(P, rel);
fl(pf('cmd/pedidos/main.go'), pf('internal/http/rotas.go'));
fl(pf('cmd/pedidos/main.go'), pf('config/pedidos.yaml'), 'config');
fl(pf('internal/http/rotas.go'), pf('internal/http/handlers.go'));
fl(pf('internal/http/rotas.go'), pf('internal/http/middleware.go'));
fl(pf('internal/http/rotas.go'), pf('internal/http/cancelar.go'));
fl(pf('internal/http/handlers.go'), pf('internal/dominio/pedido.go'), 'import', { evidence: [{ path: pf('internal/http/handlers.go').slice(2), line: 42 }] });
fl(pf('internal/http/handlers.go'), pf('internal/dominio/status.go'));
fl(pf('internal/http/handlers.go'), pf('internal/repositorio/pedidos_pg.go'), 'import', { evidence: [{ path: pf('internal/http/handlers.go').slice(2), line: 44 }] });
fl(pf('internal/http/handlers.go'), pf('internal/pagamento/cliente_grpc.go'));
fl(pf('internal/http/handlers.go'), pf('internal/eventos/publicador.go'));
fl(pf('internal/http/cancelar.go'), pf('internal/pagamento/cliente_grpc.go'));
fl(pf('internal/http/handlers_test.go'), pf('internal/http/handlers.go'));
fl(pf('internal/dominio/pedido_test.go'), pf('internal/dominio/pedido.go'));
fl(pf('internal/dominio/pedido.go'), pf('internal/dominio/itens.go'));
fl(pf('internal/dominio/pedido.go'), pf('internal/dominio/frete.go'));
fl(pf('internal/repositorio/pedidos_pg.go'), pf('internal/dominio/pedido.go'));
fl(pf('internal/repositorio/itens_pg.go'), pf('internal/dominio/itens.go'));
fl(pf('internal/pagamento/reprocessar.go'), pf('internal/pagamento/cliente_grpc.go'));
fl(pf('internal/eventos/consumidor.go'), pf('internal/dominio/status.go'));
fl(pf('internal/eventos/publicador.go'), pf('internal/eventos/eventos.go'));
fl(pf('internal/repositorio/pedidos_pg.go'), 'd:postgresql', 'SQL', { label: 'SQL', count: 9 });
fl(pf('internal/repositorio/itens_pg.go'), 'd:postgresql', 'SQL', { label: 'SQL', count: 5 });
fl(pf('migrations/0003_pedidos.sql'), 'd:postgresql', 'SQL', { label: 'migração', async: true });
fl(pf('internal/pagamento/cliente_grpc.go'), ps('pagamentos'), 'gRPC', { label: 'gRPC', count: 3, evidence: [{ path: pf('internal/pagamento/cliente_grpc.go').slice(2), line: 24 }, { path: pf('internal/pagamento/cliente_grpc.go').slice(2), line: 41 }, { path: pf('internal/pagamento/cliente_grpc.go').slice(2), line: 58 }] });
fl(pf('internal/http/handlers.go'), ps('pagamentos'), 'gRPC', { label: 'Cobrar', count: 1, evidence: [{ path: pf('internal/http/handlers.go').slice(2), line: 45 }] });
fl(pf('internal/http/handlers.go'), 'q:rabbitmq', 'AMQP', { label: 'pedido.criado', async: true, evidence: [{ path: pf('internal/http/handlers.go').slice(2), line: 47 }] });
fl(pf('internal/eventos/publicador.go'), 'q:rabbitmq', 'AMQP', { label: 'pedido.criado', async: true, count: 3 });
fl(pf('internal/http/handlers.go'), ps('notificacoes'), 'HTTP', { label: 'avisa status', evidence: [{ path: pf('internal/http/handlers.go').slice(2), line: 52 }] });
fl('q:rabbitmq', pf('internal/eventos/consumidor.go'), 'AMQP', { label: 'pagamento.confirmado', async: true });
fl(F(ps('notificacoes'), 'internal/pedidos/status.go'), pf('internal/http/handlers.go'), 'HTTP', { label: 'GET /pedidos/{id}' });

// ---------------------------------------------------------------- sizes and stats
function sumUp() {
	const kids = new Map();
	for (const n of nodes) { if (n.parent) { (kids.get(n.parent) ?? kids.set(n.parent, []).get(n.parent)).push(n); } }
	const size = n => {
		if (n.level === 'file') { return [1, n.lines ?? 0]; }
		const list = kids.get(n.id) ?? [];
		let f = 0, l = 0;
		for (const c of list) { const [a, b] = size(c); f += a; l += b; }
		if (list.length) { n.files = f; n.lines = l; }
		return [f, l];
	};
	for (const n of nodes) { if (!n.parent) { size(n); } }
}
sumUp();
const stats = m => ({
	systems: m.nodes.filter(n => n.level === 'system').length,
	services: m.nodes.filter(n => n.level === 'service').length,
	files: m.nodes.filter(n => n.level === 'file').length,
	links: m.links.filter(l => l.level === 'system').length,
	lines: m.nodes.filter(n => n.level === 'file').reduce((a, n) => a + (n.lines ?? 0), 0),
});

const deploy = {
	zones: [
		{ id: 'z:pessoas', name: 'Pessoas', kind: 'users', parent: null },
		{ id: 'z:veiculos', name: 'Veículos', kind: 'devices', parent: null },
		{ id: 'z:aws', name: 'AWS · São Paulo (sa-east-1)', kind: 'cloud', parent: null },
		{ id: 'z:k8s', name: 'Cluster Kubernetes · EKS', kind: 'cluster', parent: 'z:aws' },
		{ id: 'z:externos', name: 'Serviços externos', kind: 'external', parent: null },
	],
	units: [
		{ id: 'u:app-cliente', name: 'App do Cliente', zone: 'z:pessoas', kind: 'client', node: 's:apps/cliente', image: 'Android e iOS' },
		{ id: 'u:app-entregador', name: 'App do Entregador', zone: 'z:pessoas', kind: 'client', node: 's:apps/entregador', image: 'Android' },
		{ id: 'u:painel', name: 'Painel Web', zone: 'z:pessoas', kind: 'client', node: 's:web/painel', image: 'navegador · Vercel' },
		{ id: 'u:rastreador', name: 'Rastreador', zone: 'z:veiculos', kind: 'device', replicas: 240, node: 's:firmware/rastreador', image: 'firmware 2.4.1' },
		{ id: 'u:lb', name: 'Load balancer', zone: 'z:aws', kind: 'balancer', ports: ['443'], image: 'ALB' },
		{ id: 'u:gateway', name: 'api-gateway', zone: 'z:k8s', kind: 'container', replicas: 3, image: 'rota/gateway:2.0', ports: ['8080'], node: ps('api-gateway') },
		{ id: 'u:auth', name: 'auth', zone: 'z:k8s', kind: 'container', replicas: 2, image: 'rota/auth:1.9', ports: ['8080'], node: ps('auth') },
		{ id: 'u:pedidos', name: 'pedidos', zone: 'z:k8s', kind: 'container', replicas: 3, image: 'rota/pedidos:1.4', ports: ['8080'], node: ps('pedidos') },
		{ id: 'u:rastreamento', name: 'rastreamento', zone: 'z:k8s', kind: 'container', replicas: 2, image: 'rota/rastreamento:1.2', node: ps('rastreamento') },
		{ id: 'u:pagamentos', name: 'pagamentos', zone: 'z:k8s', kind: 'container', replicas: 2, image: 'rota/pagamentos:1.7', node: ps('pagamentos') },
		{ id: 'u:rotas', name: 'rotas', zone: 'z:k8s', kind: 'container', replicas: 2, image: 'rota/rotas:1.3', node: ps('rotas') },
		{ id: 'u:notificacoes', name: 'notificações', zone: 'z:k8s', kind: 'container', replicas: 1, image: 'rota/notificacoes:1.1', node: ps('notificacoes') },
		{ id: 'u:etl', name: 'etl', zone: 'z:k8s', kind: 'function', image: 'diário', node: 'v:dados/etl' },
		{ id: 'u:rds', name: 'RDS PostgreSQL', zone: 'z:aws', kind: 'database', image: 'Multi-AZ', node: 'd:postgresql' },
		{ id: 'u:redis', name: 'ElastiCache Redis', zone: 'z:aws', kind: 'cache', image: '2 nós', node: 'd:redis' },
		{ id: 'u:mq', name: 'Amazon MQ', zone: 'z:aws', kind: 'queue', image: 'RabbitMQ', node: 'q:rabbitmq' },
		{ id: 'u:emqx', name: 'EMQX', zone: 'z:aws', kind: 'queue', image: 'MQTT · EC2', ports: ['8883'], node: 'q:emqx' },
		{ id: 'u:pix', name: 'Gateway Pix', zone: 'z:externos', kind: 'external', node: 'x:gateway-pix' },
		{ id: 'u:maps', name: 'Google Maps', zone: 'z:externos', kind: 'external', node: 'x:google-maps' },
		{ id: 'u:whatsapp', name: 'WhatsApp', zone: 'z:externos', kind: 'external', node: 'x:whatsapp' },
		{ id: 'u:bigquery', name: 'BigQuery', zone: 'z:externos', kind: 'database', node: 's:dados' },
	],
	links: [
		{ from: 'u:app-cliente', to: 'u:lb', label: 'HTTPS', async: false },
		{ from: 'u:app-entregador', to: 'u:lb', label: 'HTTPS', async: false },
		{ from: 'u:painel', to: 'u:lb', label: 'HTTPS', async: false },
		{ from: 'u:lb', to: 'u:gateway', label: '', async: false },
		{ from: 'u:gateway', to: 'u:auth', label: '', async: false },
		{ from: 'u:gateway', to: 'u:pedidos', label: '', async: false },
		{ from: 'u:pedidos', to: 'u:pagamentos', label: 'gRPC', async: false },
		{ from: 'u:pedidos', to: 'u:rds', label: 'SQL', async: false },
		{ from: 'u:auth', to: 'u:redis', label: '', async: false },
		{ from: 'u:pedidos', to: 'u:mq', label: 'eventos', async: true },
		{ from: 'u:mq', to: 'u:notificacoes', label: '', async: true },
		{ from: 'u:rastreador', to: 'u:emqx', label: 'MQTT/TLS · 8883', async: true },
		{ from: 'u:emqx', to: 'u:rastreamento', label: 'posições', async: true },
		{ from: 'u:pagamentos', to: 'u:pix', label: '', async: false },
		{ from: 'u:rotas', to: 'u:maps', label: '', async: false },
		{ from: 'u:notificacoes', to: 'u:whatsapp', label: '', async: false },
		{ from: 'u:etl', to: 'u:bigquery', label: 'carga diária', async: true },
	],
};

const model = { version: 1, name: 'Rota Certa', source: 'rota-certa', scannedAt: new Date(Date.now() - 2 * 60000).toISOString(), stats: {}, nodes, links, deploy };
model.stats = stats(model);

const paths = {
	paths: [
		{
			id: 'criar-pedido', name: 'Criar pedido', steps: [
				{ from: 's:apps/cliente', to: ps('api-gateway'), label: 'POST /pedidos', async: false, note: 'O app envia o carrinho e o meio de pagamento para o gateway.', evidence: { path: 'apps/cliente/src/api/apiClient.ts', line: 58 } },
				{ from: ps('api-gateway'), to: ps('auth'), label: 'valida o token', async: false, note: 'O gateway confere o token do cliente antes de seguir.', evidence: { path: 'plataforma/servicos/api-gateway/internal/auth/token.go', line: 18 } },
				{ from: ps('auth'), to: ps('api-gateway'), label: 'ok', async: false, note: 'Token válido; o gateway segue com o pedido.' },
				{ from: ps('api-gateway'), to: ps('pedidos'), label: 'CriarPedido', async: false, note: 'O gateway repassa o pedido para o serviço de pedidos.', evidence: { path: 'plataforma/servicos/api-gateway/internal/rotas/rotas.go', line: 33 } },
				{ from: ps('pedidos'), to: ps('pagamentos'), label: 'Cobrar · gRPC', async: false, note: 'Chamada gRPC Cobrar(pedidoID, total). Tempo médio: 180 ms.', evidence: { path: 'plataforma/servicos/pedidos/internal/pagamento/cliente_grpc.go', line: 24 } },
				{ from: ps('pagamentos'), to: 'x:gateway-pix', label: 'cria cobrança Pix', async: false, note: 'pagamentos cria a cobrança no Gateway Pix.', evidence: { path: 'plataforma/servicos/pagamentos/internal/pix/cliente.go', line: 40 } },
				{ from: 'x:gateway-pix', to: ps('pagamentos'), label: 'QR Code', async: false, note: 'O Gateway Pix devolve o QR Code da cobrança.' },
				{ from: ps('pedidos'), to: 'q:rabbitmq', label: 'pedido.criado', async: true, note: 'pedidos publica o evento na fila e não espera resposta.', evidence: { path: 'plataforma/servicos/pedidos/internal/http/handlers.go', line: 47 } },
				{ from: 'q:rabbitmq', to: ps('notificacoes'), label: 'entrega o evento', async: true, note: 'A fila entrega o evento para notificações.' },
				{ from: ps('notificacoes'), to: 'x:whatsapp', label: '“Recebemos seu pedido”', async: false, note: 'notificações manda a mensagem pelo WhatsApp Business.' },
				{ from: ps('pedidos'), to: 's:apps/cliente', label: '201 · QR Code Pix', async: false, note: 'O app recebe o pedido criado e mostra o QR Code.' },
			],
		},
		{
			id: 'compra-no-app', name: 'Compra no app', steps: [
				{ from: 's:apps/cliente', to: 's:plataforma', label: 'HTTPS · REST', async: false, note: 'O cliente monta o carrinho e o app envia o pedido para a Plataforma.' },
				{ from: 's:plataforma', to: 'x:gateway-pix', label: 'HTTPS', async: false, note: 'O app do cliente envia o pedido para a Plataforma, que cobra pelo Gateway Pix e devolve o QR Code em menos de 1 segundo.' },
				{ from: 's:plataforma', to: 'x:whatsapp', label: 'HTTPS', async: false, note: 'Com o pagamento confirmado, a Plataforma avisa o cliente pelo WhatsApp.' },
				{ from: 's:apps/entregador', to: 's:plataforma', label: 'HTTPS + WebSocket', async: false, note: 'O entregador recebe a entrega no app e aceita a rota.' },
				{ from: 's:firmware/rastreador', to: 's:plataforma', label: 'MQTT · LTE', async: true, note: 'O rastreador do veículo envia a posição a cada 5 segundos até a entrega.' },
			],
		},
	],
};

const proposal = {
	title: 'Cupons de desconto',
	summary: 'Um serviço novo, cupons, com tabela própria no PostgreSQL; pedidos valida o cupom antes de cobrar; o gateway ganha a rota /cupons para o painel.',
	nodes: [
		{ op: 'add', id: ps('cupons'), level: 'service', parent: 's:plataforma', name: 'cupons', kind: 'backend', tech: 'Go', summary: 'valida e aplica descontos' },
		{ op: 'change', id: ps('pedidos'), note: '3 arquivos mudam' },
		{ op: 'change', id: ps('api-gateway'), note: '+1 rota: /cupons' },
		{ op: 'change', id: 'd:postgresql', note: '+ tabela cupons' },
	],
	links: [
		{ op: 'add', from: ps('pedidos'), to: ps('cupons'), label: 'valida cupom' },
		{ op: 'add', from: ps('cupons'), to: 'd:postgresql', label: 'tabela cupons' },
		{ op: 'add', from: ps('api-gateway'), to: ps('cupons'), label: '/cupons · novo', async: true },
		{ op: 'remove', from: ps('pedidos'), to: ps('notificacoes'), label: 'chamada direta · sai' },
	],
};

const progress = {
	status: 'scanning', phase: 'links', steps: [
		{ id: 'tree', label: 'Estrutura de pastas', state: 'done', note: '38 pastas' },
		{ id: 'systems', label: 'Sistemas encontrados', state: 'done', note: '6' },
		{ id: 'links', label: 'Ligações entre serviços', state: 'run', note: '812 de 1.248 arquivos' },
		{ id: 'files', label: 'Arquivos de cada serviço', state: 'todo' },
	],
	current: 'firmware/rastreador/src/tarefas/gps/gps_task.c', done: 812, total: 1248,
};
const progressFailed = { status: 'failed', phase: 'links', error: 'Não consegui ler a pasta firmware/rastreador: permissão negada.', steps: progress.steps, done: 812, total: 1248 };

const view = { select: null, highlight: ['l-mqtt', 's:firmware/rastreador', 's:plataforma'], level: 'system', scope: null, mode: 'map', note: 'Posição a cada 5 s', revision: 4 };

// Partial model while scanning: only part of the systems, some services still unknown.
const keep = new Set(['s:apps/cliente', 's:apps/entregador', 's:plataforma', 'x:gateway-pix', 'x:google-maps', 'x:whatsapp']);
const partialNodes = nodes.filter(n => keep.has(n.id) || (n.parent && keep.has(n.parent) && n.level === 'service' && !/notificacoes|rastreamento|pagamentos/.test(n.id)));
const ids = new Set(partialNodes.map(n => n.id));
const partial = { ...model, nodes: partialNodes, links: links.filter(l => ids.has(l.from) && ids.has(l.to) && l.level !== 'file'), deploy: null };
partial.stats = stats(partial);

// ---------------------------------------------------------------- large synthetic model
function big() {
	let seed = 7;
	const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
	const pick = a => a[Math.floor(rnd() * a.length)];
	const kinds = ['backend', 'backend', 'backend', 'web', 'mobile', 'backend', 'embedded', 'desktop', 'library', 'backend'];
	const words = ['conta', 'cobranca', 'catalogo', 'estoque', 'busca', 'frete', 'fiscal', 'cadastro', 'agenda', 'relatorio', 'mensagem', 'arquivo', 'auditoria', 'perfil', 'promocao', 'carrinho', 'checkout', 'loja', 'parceiro', 'suporte', 'contrato', 'fatura', 'bilhete', 'sinal', 'mapa'];
	const bn = [], bl = [];
	let id = 0;
	const L = (from, to, level, protocol, x = {}) => bl.push({ id: `b${++id}`, from, to, level, protocol, async: !!x.async, count: x.count ?? 1 + Math.floor(rnd() * 6), ...(x.label ? { label: x.label } : {}) });
	const tops = [];
	for (let i = 0; i < 6; i++) { tops.push({ id: `d:banco${i}`, level: i < 3 ? 'data' : i < 5 ? 'queue' : 'external', parent: null, name: ['Postgres', 'Mongo', 'Redis', 'Kafka', 'NATS', 'Stripe'][i], kind: i < 3 ? 'data' : i < 5 ? 'queue' : 'external', tech: '' }); }
	bn.push(...tops);
	const services = [];
	for (let s = 0; s < 20; s++) {
		const kind = kinds[s % kinds.length];
		const sid = `s:sys${s}`;
		bn.push({ id: sid, level: 'system', parent: null, name: `Sistema ${s + 1} ${pick(words)}`, kind, tech: { backend: 'Go', web: 'React', mobile: 'Kotlin', embedded: 'C', desktop: 'Electron', library: 'TypeScript' }[kind], path: `sys${s}` });
		// sys19 is a huge monolith (110 services); svc0 of sys18 has 320 files.
		const count = s === 19 ? 110 : 6 + Math.floor(rnd() * 20);
		const mine = [];
		for (let v = 0; v < count; v++) {
			const vid = `v:sys${s}/svc${v}`;
			bn.push({ id: vid, level: 'service', parent: sid, name: `${pick(words)}-${v}`, kind, path: `sys${s}/svc${v}`, role: 'service' });
			mine.push(vid);
			const nf = s === 18 && v === 0 ? 320 : 4 + Math.floor(rnd() * 16);
			const fids = [];
			for (let f = 0; f < nf; f++) {
				const folder = s === 18 && v === 0 ? `modulo${Math.floor(f / 13)}` : pick(['', 'internal', 'internal/api', 'internal/dominio', 'pkg', 'cmd']);
				const name = `${pick(words)}_${f}.go`;
				const fid = `f:sys${s}/svc${v}/${folder ? folder + '/' : ''}${name}`;
				bn.push({ id: fid, level: 'file', parent: vid, name, kind: 'file', path: fid.slice(2), lines: 20 + Math.floor(rnd() * 400), lang: 'go', folder });
				if (fids.length) { L(fid, pick(fids), 'file', 'import'); }
				fids.push(fid);
			}
		}
		for (const v of mine) {
			const k = Math.floor(rnd() * 3);
			for (let j = 0; j < k; j++) { const t = pick(mine); if (t !== v) { L(v, t, 'service', 'HTTP'); } }
			if (rnd() < 0.3) { L(v, pick(tops).id, 'service', 'SQL'); }
		}
		services.push(mine);
	}
	const sysPairs = new Set();
	for (let k = 0; k < 45; k++) {
		const a = Math.floor(rnd() * 20), b = Math.floor(rnd() * 20);
		if (a === b) { continue; }
		L(pick(services[a]), pick(services[b]), 'service', 'HTTP', { label: 'HTTP' });
		const key = `${a}>${b}`;
		if (!sysPairs.has(key)) { sysPairs.add(key); L(`s:sys${a}`, `s:sys${b}`, 'system', 'HTTP', { label: 'HTTP' }); }
	}
	for (let s = 0; s < 20; s++) { if (rnd() < 0.4) { L(`s:sys${s}`, pick(tops).id, 'system', 'SQL'); } }
	const m = { version: 1, name: 'Monorepo grande', source: 'monorepo', scannedAt: new Date().toISOString(), nodes: bn, links: bl, deploy: null };
	// sum sizes
	const kids = new Map();
	for (const n of bn) { if (n.parent) { (kids.get(n.parent) ?? kids.set(n.parent, []).get(n.parent)).push(n); } }
	const size = n => { if (n.level === 'file') { return [1, n.lines]; } let f = 0, l = 0; for (const c of kids.get(n.id) ?? []) { const [a, b] = size(c); f += a; l += b; } if (kids.has(n.id)) { n.files = f; n.lines = l; } return [f, l]; };
	for (const n of bn) { if (!n.parent) { size(n); } }
	m.stats = stats(m);
	return m;
}
const bigModel = big();

const write = (name, data) => writeFileSync(new URL(name, out), JSON.stringify(data, null, '\t') + '\n');
write('model.json', model);
write('paths.json', paths);
write('proposal.json', proposal);
write('progress.json', progress);
write('view.json', view);
const bundle = { model, paths, proposal, progress, progressFailed, view, partial, big: bigModel };
writeFileSync(new URL('sample.js', out), `// Generated by make-sample.mjs. Dev only.\nwindow.AS_SAMPLE = ${JSON.stringify(bundle)};\n`);
console.log(`model: ${model.stats.systems} sistemas, ${model.stats.services} serviços, ${model.stats.files} arquivos, ${links.length} ligações`);
console.log(`big: ${bigModel.stats.systems} sistemas, ${bigModel.stats.services} serviços, ${bigModel.stats.files} arquivos, ${bigModel.links.length} ligações`);
