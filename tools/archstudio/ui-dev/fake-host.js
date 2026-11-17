/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Dev only: a fake JumpCode host for the ArchStudio interface. It answers like the real host
// (init, context, files, running, file) using window.AS_SAMPLE and the page's query string:
//   state=done|empty|scanning|scanning-empty|failed   big=1   theme=light   view=1
//   mode=…  scope=…  sel=…  open=a,b  step=N  path=id  proposalOn=1  paths=0  proposal=0  nodeploy=1  project=0
(function () {
	const q = new URLSearchParams(location.search);
	// data=real uses the files the real analyzer wrote for tests/fixtures/rota-certa (see make-real.py).
	const real = q.get('data') === 'real' && window.AS_REAL;
	const D = real ? Object.assign({}, window.AS_REAL, { big: window.AS_REAL.model, view: window.AS_REAL['view-select'] }) : window.AS_SAMPLE;
	const state = q.get('state') || 'done';
	const big = q.get('big') === '1';
	const model = JSON.parse(JSON.stringify(big ? D.big : D.model));
	if (q.get('nodeploy') === '1') {
		model.deploy = null;
	}
	const files = {};
	if (state === 'done') {
		files['model.json'] = JSON.stringify(model, null, '\t');
	} else if (state === 'scanning') {
		files['model.json'] = JSON.stringify(model);
		files['model-partial.json'] = JSON.stringify({ ...D.partial, executionId: 'dev-scan' });
		files['progress.json'] = JSON.stringify({ ...D.progress, executionId: 'dev-scan' });
	} else if (state === 'scanning-empty') {
		files['progress.json'] = JSON.stringify({ ...D.progress, executionId: 'dev-scan' });
	} else if (state === 'failed') {
		files['progress.json'] = JSON.stringify(D.progressFailed);
	} else if (state === 'failed-model') {
		files['model.json'] = JSON.stringify(model);
		files['progress.json'] = JSON.stringify(D.progressFailed);
	}
	if (!big && state === 'done' && q.get('paths') !== '0') {
		files['paths.json'] = JSON.stringify(D.paths);
	}
	if (!big && state === 'done' && q.get('proposal') !== '0') {
		files['proposal.json'] = JSON.stringify(D.proposal);
	}
	if (q.get('view') === '1') {
		files['view.json'] = JSON.stringify(D.view);
	} else if (real && q.get('view') && D[`view-${q.get('view')}`]) {
		files['view.json'] = JSON.stringify(D[`view-${q.get('view')}`]);
	}

	const saved = {};
	if (q.get('mode')) {
		saved.mode = q.get('mode');
	}
	if (q.has('scope')) {
		saved.scope = q.get('scope') || null;
	}
	if (q.get('sel')) {
		saved.sel = q.get('sel');
	}
	if (q.get('open')) {
		saved.open = q.get('open').split(',');
	}
	if (q.get('step')) {
		saved.step = Number(q.get('step'));
	}
	if (q.get('path')) {
		saved.pathId = q.get('path');
	}
	if (q.get('proposalOn') === '1') {
		saved.proposalOn = true;
	}
	saved.lastViewRev = q.get('view') ? null : D.view.revision;

	let ctx = { tool: 'archstudio', project: q.get('project') !== '0', source: 'rota-certa', sourceKind: q.get('project') === '0' ? null : 'project' };
	if (real && q.get('nodeploy') !== '1') {
		model.deploy = window.AS_REAL.model.deploy;
	}
	const reply = (msg, delay) => setTimeout(() => window.postMessage(msg, '*'), delay || 0);
	window.__posted = [];
	window.__state = saved;

	function fakeFile(path) {
		if (/handlers\.go$/.test(path)) {
			const head = [
				'package http',
				'',
				'import (',
				'\t"encoding/json"',
				'\t"net/http"',
				'',
				'\t"rota/pedidos/internal/dominio"',
				'\t"rota/pedidos/internal/eventos"',
				'\t"rota/pedidos/internal/pagamento"',
				'\t"rota/pedidos/internal/repositorio"',
				')',
				'',
				'// Handlers reúne as rotas HTTP do serviço de pedidos.',
				'type Handlers struct {',
				'\trepo       repositorio.Pedidos',
				'\tpagamentos pagamento.Cliente',
				'\teventos    eventos.Publicador',
				'\tnotificar  func(id string, status string) error',
				'}',
				'',
				'func NovoHandlers(r repositorio.Pedidos, p pagamento.Cliente, e eventos.Publicador) *Handlers {',
				'\treturn &Handlers{repo: r, pagamentos: p, eventos: e}',
				'}',
				'',
				'func lerPedido(r *http.Request) (dominio.Pedido, error) {',
				'\tvar p dominio.Pedido',
				'\terr := json.NewDecoder(r.Body).Decode(&p)',
				'\treturn p, err',
				'}',
				'',
				'func responderJSON(w http.ResponseWriter, status int, v any) {',
				'\tw.Header().Set("Content-Type", "application/json")',
				'\tw.WriteHeader(status)',
				'\t_ = json.NewEncoder(w).Encode(v)',
				'}',
				'',
				'func responderErro(w http.ResponseWriter, status int, err error) {',
				'\tresponderJSON(w, status, map[string]string{"erro": err.Error()})',
				'}',
				'',
			];
			const body = [
				'func (h *Handlers) CriarPedido(w http.ResponseWriter, r *http.Request) {',
				'\tpedido, err := lerPedido(r)',
				'\tif err != nil { responderErro(w, http.StatusBadRequest, err); return }',
				'\tif err := h.repo.Salvar(r.Context(), pedido); err != nil { … }',
				'\tcobranca, err := h.pagamentos.Cobrar(r.Context(), pedido.ID, pedido.Total)',
				'\tif err != nil { responderErro(w, http.StatusBadGateway, err); return }',
				'\th.eventos.Publicar("pedido.criado", pedido)',
				'\tresponderJSON(w, http.StatusCreated, cobranca)',
				'}',
				'',
				'// avisa o cliente sobre a mudança de status (chamada direta).',
				'func (h *Handlers) avisar(id string) { _ = h.notificar(id, "criado") }',
				'',
				'func (h *Handlers) ListarPedidos(w http.ResponseWriter, r *http.Request) {',
				'\tlista, err := h.repo.Listar(r.Context(), r.URL.Query().Get("cliente"))',
				'\tif err != nil { responderErro(w, http.StatusInternalServerError, err); return }',
				'\tresponderJSON(w, http.StatusOK, lista)',
				'}',
			];
			return head.concat(body).join('\n');
		}
		const ext = (path.split('.').pop() || '').toLowerCase();
		const name = path.split('/').pop();
		const lines = [];
		if (ext === 'go') {
			lines.push('package main', '', 'import "fmt"', '', `// ${name}: arquivo de exemplo do harness.`, 'func main() {');
			for (let i = 0; i < 40; i++) {
				lines.push(`\tfmt.Println("linha ${i + 1}", ${i * 3})`);
			}
			lines.push('}');
		} else if (ext === 'sql') {
			lines.push('-- migração de exemplo', 'CREATE TABLE pedidos (', '  id BIGSERIAL PRIMARY KEY,', '  cliente_id BIGINT NOT NULL,', '  total NUMERIC(10, 2) NOT NULL,', '  status TEXT NOT NULL DEFAULT \'novo\'', ');');
		} else if (ext === 'yaml' || ext === 'yml') {
			lines.push('# configuração de exemplo', 'porta: 8080', 'filas:', '  pedidos: "pedido.criado"', '  pagamentos: "pagamento.confirmado"');
		} else if (ext === 'c' || ext === 'h') {
			lines.push('#include <stdio.h>', '#include "gps.h"', '', '/* tarefa de exemplo */', 'void gps_task(void *arg) {', '    for (;;) {', '        ler_nmea();', '        vTaskDelay(pdMS_TO_TICKS(5000));', '    }', '}');
		} else {
			lines.push(`// ${name}`, 'export function exemplo(valor: number): string {', '\treturn `valor: ${valor}`;', '}');
		}
		return lines.join('\n');
	}

	window.acquireVsCodeApi = function () {
		return {
			postMessage(m) {
				window.__posted.push(m);
				console.log('[host] <-', JSON.stringify(m).slice(0, 240));
				if (m.type === 'ready') {
					reply({ type: 'init', context: ctx });
					reply({ type: 'files', files, revision: 1 }, 5);
					const scanning = state === 'scanning' || state === 'scanning-empty';
					reply({ type: 'running', running: scanning, executions: scanning ? ['dev-scan'] : [] }, 10);
				} else if (m.type === 'readFile') {
					if (real) {
						const text = window.AS_REAL.sources && window.AS_REAL.sources[m.path];
						reply(typeof text === 'string' ? { type: 'file', requestId: m.requestId, path: m.path, text, truncated: false } : { type: 'file', requestId: m.requestId, path: m.path, error: 'arquivo não encontrado' }, 30);
					} else if (q.get('readfail') === '1') {
						reply({ type: 'file', requestId: m.requestId, path: m.path, error: 'arquivo não encontrado' }, 30);
					} else {
						reply({ type: 'file', requestId: m.requestId, path: m.path, text: fakeFile(m.path), truncated: false }, 30);
					}
				} else if (m.type === 'pickSource') {
					ctx = Object.assign({}, ctx, { sourceKind: 'folder', source: 'outro-repo' });
					reply({ type: 'context', context: ctx }, 30);
				}
			},
			getState() {
				return window.__state;
			},
			setState(s) {
				window.__state = s;
			},
		};
	};
	// Lets scripts push new Studio files: __send({ type: 'files', files: {...} }).
	window.__send = msg => window.postMessage(msg, '*');
	window.__files = files;
})();
