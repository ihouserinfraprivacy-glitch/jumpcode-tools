# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for license information.

"""Dev only: runs the real ArchStudio tool on tests/fixtures/rota-certa and stores the exact Studio
files the interface receives in ui-dev/sample-real/ (plus sample-real.js for the harness).

Run from the repository root:  python -B tools/archstudio/ui-dev/make-real.py
"""

import json
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
TOOL = HERE.parent
sys.path.insert(0, str(TOOL / "src"))

import jumpcode_archstudio as tool  # noqa: E402
from jumpcode_archstudio import actions  # noqa: E402

SOURCE = TOOL / "tests" / "fixtures" / "rota-certa"
OUT = HERE / "sample-real"


def main():
    studio = Path(tempfile.mkdtemp(prefix="archstudio-real-"))
    context = {"studio_root": str(studio), "source_root": str(SOURCE)}
    snapshots = []
    original = actions.write_json

    def spy(root, name, data):
        original(root, name, data)
        if name in ("progress.json", "model.json"):
            snapshots.append((name, json.loads(json.dumps(data))))

    from jumpcode_archstudio import analyzer

    class EagerProgress(analyzer.Progress):
        def __init__(self, write=None, **_):
            super().__init__(write, interval=0)

    real_progress = actions.Progress
    actions.write_json = spy
    actions.Progress = EagerProgress
    try:
        tool.run({"action": "scan"}, context)
    finally:
        actions.write_json = original
        actions.Progress = real_progress

    # A mid-scan moment: progress while reading links, with the partial model written just before it.
    mid_progress, mid_model = None, None
    last_model = None
    for name, data in snapshots:
        if name == "model.json":
            last_model = data
        elif data.get("status") == "scanning" and data.get("phase") == "links" and data.get("total"):
            mid_progress, mid_model = data, last_model
            if data.get("done", 0) >= data["total"] * 0.6:
                break

    def run(arguments):
        result = tool.run(arguments, context)
        return result

    run({"action": "write_path", "name": "Criar pedido", "steps": [
        {"from": "s:app-cliente", "to": "v:plataforma/servicos/api-gateway", "label": "POST /pedidos", "note": "O app envia o carrinho para o gateway."},
        {"from": "v:plataforma/servicos/api-gateway", "to": "v:plataforma/servicos/auth", "label": "valida o token", "note": "O gateway confere o token do cliente."},
        {"from": "v:plataforma/servicos/auth", "to": "v:plataforma/servicos/api-gateway", "label": "ok"},
        {"from": "v:plataforma/servicos/api-gateway", "to": "v:plataforma/servicos/pedidos", "label": "CriarPedido", "note": "O gateway repassa o pedido."},
        {"from": "v:plataforma/servicos/pedidos", "to": "v:plataforma/servicos/pagamentos", "label": "Cobrar · gRPC", "note": "pedidos pede a cobrança a pagamentos."},
        {"from": "v:plataforma/servicos/pagamentos", "to": "x:pix", "label": "cria cobrança Pix", "note": "pagamentos cria a cobrança no Gateway Pix."},
        {"from": "x:pix", "to": "v:plataforma/servicos/pagamentos", "label": "QR Code"},
        {"from": "v:plataforma/servicos/pedidos", "to": "q:rabbitmq", "label": "pedido.criado", "async": True, "note": "pedidos publica o evento e não espera."},
        {"from": "q:rabbitmq", "to": "v:plataforma/servicos/notificacoes", "label": "entrega o evento", "async": True},
        {"from": "v:plataforma/servicos/notificacoes", "to": "x:whatsapp", "label": "“Recebemos seu pedido”", "note": "notificacoes avisa o cliente pelo WhatsApp."},
        {"from": "v:plataforma/servicos/pedidos", "to": "s:app-cliente", "label": "201 · QR Code Pix", "note": "O app mostra o QR Code."},
    ]})
    run({"action": "write_path", "name": "Posição do veículo", "steps": [
        {"from": "s:firmware/rastreador", "to": "q:mqtt", "label": "veiculos/+/posicao", "async": True, "note": "O rastreador publica a posição a cada 5 segundos."},
        {"from": "q:mqtt", "to": "v:plataforma/servicos/rastreamento", "label": "assina", "async": True, "note": "O serviço de rastreamento recebe a posição."},
        {"from": "v:plataforma/servicos/rastreamento", "to": "d:redis", "label": "guarda a última posição", "note": "A posição fica no Redis para consulta rápida."},
        {"from": "s:app-cliente", "to": "s:plataforma", "label": "WebSocket", "note": "O app do cliente acompanha o veículo ao vivo."},
    ]})
    run({"action": "write_proposal", "title": "Cupons de desconto",
         "summary": "Um serviço novo, cupons, com tabela própria no PostgreSQL; pedidos valida o cupom antes de cobrar.",
         "nodes": [
             {"op": "add", "level": "service", "parent": "s:plataforma", "name": "cupons", "kind": "backend", "tech": "Go", "summary": "valida e aplica descontos"},
             {"op": "change", "id": "v:plataforma/servicos/pedidos", "note": "3 arquivos mudam"},
             {"op": "change", "id": "v:plataforma/servicos/api-gateway", "note": "+1 rota: /cupons"},
             {"op": "remove", "id": "v:plataforma/pkg/logger", "note": "trocado pelo log padrão"},
         ],
         "links": [
             {"op": "add", "from": "v:plataforma/servicos/pedidos", "to": "v:plataforma/cupons", "label": "valida cupom"},
             {"op": "add", "from": "v:plataforma/cupons", "to": "d:postgresql", "label": "tabela cupons"},
             {"op": "remove", "from": "v:plataforma/servicos/pedidos", "to": "v:plataforma/servicos/pagamentos", "label": "chamada direta · sai"},
         ]})

    views = {}
    run({"action": "focus", "id": "v:plataforma/servicos/rastreamento", "ids": ["q:mqtt"], "note": "Posição a cada 5 s"})
    views["view-select"] = json.loads((studio / "view.json").read_text(encoding="utf-8"))
    run({"action": "focus", "id": "criar-pedido", "mode": "path"})
    views["view-path"] = json.loads((studio / "view.json").read_text(encoding="utf-8"))
    run({"action": "focus", "id": "criar-pedido", "mode": "present"})
    views["view-present"] = json.loads((studio / "view.json").read_text(encoding="utf-8"))
    deploy = json.loads((studio / "model.json").read_text(encoding="utf-8")).get("deploy") or {}
    unit = next((u["id"] for u in deploy.get("units", []) if "pedidos" in u["id"]), None)
    if unit:
        run({"action": "focus", "id": unit, "note": "Roda no cluster"})
        views["view-deploy"] = json.loads((studio / "view.json").read_text(encoding="utf-8"))

    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    bundle = {}
    for name in ("model.json", "paths.json", "proposal.json"):
        text = (studio / name).read_text(encoding="utf-8")
        (OUT / name).write_text(text, encoding="utf-8")
        bundle[name[:-5]] = json.loads(text)
    for name, data in views.items():
        (OUT / f"{name}.json").write_text(json.dumps(data, ensure_ascii=False, indent="\t"), encoding="utf-8")
        bundle[name] = data
    if mid_progress:
        (OUT / "progress-scanning.json").write_text(json.dumps(mid_progress, ensure_ascii=False, indent="\t"), encoding="utf-8")
        bundle["progress"] = mid_progress
    if mid_model:
        (OUT / "model-partial.json").write_text(json.dumps(mid_model, ensure_ascii=False, indent="\t"), encoding="utf-8")
        bundle["partial"] = mid_model
    done = json.loads((studio / "progress.json").read_text(encoding="utf-8"))
    failed = dict(mid_progress or done, status="failed", error="Falha na análise")
    (OUT / "progress-failed.json").write_text(json.dumps(failed, ensure_ascii=False, indent="\t"), encoding="utf-8")
    bundle["progressFailed"] = failed
    bundle["progressDone"] = done
    # The fixture's sources, so the fake host can answer readFile with the real text.
    model = bundle["model"]
    wanted = {node["path"] for node in model["nodes"] if node.get("level") == "file" and node.get("path")}
    wanted |= {node["path"] for node in model["nodes"] if node.get("level") == "service" and "." in (node.get("path") or "").rsplit("/", 1)[-1]}
    sources = {}
    for relative in sorted(wanted):
        file = SOURCE / relative
        if file.is_file() and file.stat().st_size < 200_000:
            sources[relative] = file.read_text(encoding="utf-8", errors="replace")
    bundle["sources"] = sources
    (OUT / "sample-real.js").write_text("// Generated by make-real.py from the real analyzer. Dev only.\nwindow.AS_REAL = "
                                         + json.dumps(bundle, ensure_ascii=False) + ";\n", encoding="utf-8")
    shutil.rmtree(studio, ignore_errors=True)
    print(f"wrote {OUT} ({len(snapshots)} scan writes captured; mid-scan phase: {mid_progress and mid_progress.get('phase')})")


if __name__ == "__main__":
    main()
