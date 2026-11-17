# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Build the sample Studio files in tests/fixtures/barbearia by calling the real actions.

Run from tools/taskstudio: `python tests/make_fixtures.py` (add --print to show the files).
The clock and execution ids are fixed, so the output is the same on every run.
"""

import calendar
import json
from pathlib import Path
import shutil
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from jumpcode_taskstudio import run  # noqa: E402
from jumpcode_taskstudio.studio import Studio  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "barbearia"
START = calendar.timegm((2026, 11, 13, 14, 20, 0))
STEP = 40
SOURCE = "C:/Projetos/barbearia"
# The four Studio files, plus two moments of plan.json that pair with the recalibration dialog and the proposal.
NAMES = ("plan.json", "proposal.json", "history.json", "view.json", "plan-recalibrating.json", "plan-proposed.json")

TITLE = "Barbearia do Zé"
REQUEST = ("Crie um sistema de agendamento para a minha barbearia: o cliente escolhe o serviço, o barbeiro e o "
           "horário, paga por Pix e recebe um lembrete no WhatsApp. Eu quero ver a agenda do dia num painel.")
TASKS = [
    {"title": "Entender o pedido", "summary": "Serviços, barbeiros, horários e regras da barbearia",
     "detail": "Listar os serviços com preço e duração, os barbeiros, o horário de funcionamento e as regras de "
               "cancelamento.", "area": "Projeto", "estimate": 10,
     "criteria": ["Lista de serviços com preço e duração", "Horário de funcionamento"]},
    {"title": "Estrutura do projeto", "summary": "Next.js com TypeScript, Prisma e SQLite", "deps": [1],
     "detail": "Criar o projeto Next.js com TypeScript, configurar o Prisma com SQLite e deixar o servidor de "
               "desenvolvimento rodando.", "area": "Projeto", "estimate": 15,
     "criteria": ["npm run dev abre a página inicial"]},
    {"title": "Modelar o banco", "summary": "Tabelas de serviços, barbeiros, clientes e agendamentos", "deps": [2],
     "detail": "Criar as tabelas servicos, barbeiros, clientes e agendamentos, com a migração inicial e índices por "
               "barbeiro e data.", "area": "Banco", "estimate": 20,
     "criteria": ["Migração inicial aplicada", "Agendamento ligado a cliente, barbeiro e serviço"]},
    {"title": "Cadastro de serviços e barbeiros", "summary": "Telas simples para o dono cadastrar", "deps": [3],
     "detail": "Páginas de administração para criar, editar e desativar serviços e barbeiros.", "area": "Site",
     "estimate": 25},
    {"title": "Horários disponíveis", "summary": "Calcula os horários livres de cada barbeiro", "deps": [3],
     "detail": "Função que recebe o barbeiro, o dia e o serviço e devolve os horários livres a cada 30 minutos, "
               "respeitando pausas e agendamentos existentes.", "area": "Banco", "estimate": 30,
     "criteria": ["Não oferece horário já ocupado", "Respeita o horário de funcionamento"]},
    {"title": "Tela de agendamento", "summary": "Cliente escolhe serviço, barbeiro e horário", "deps": [4, 5],
     "detail": "Página pública em três passos: serviço, barbeiro e horário, com o resumo antes de confirmar.",
     "area": "Site", "estimate": 40, "criteria": ["Funciona no celular", "Mostra o resumo antes de confirmar"]},
    {"title": "Pagamento por Pix", "summary": "QR Code Pix na confirmação do agendamento", "deps": [6],
     "detail": "Gerar a cobrança Pix no ambiente de testes do gateway e confirmar o agendamento quando o pagamento "
               "chegar.", "area": "Integrações", "estimate": 35},
    {"title": "Lembrete por WhatsApp", "summary": "Mensagem no dia anterior ao horário", "deps": [6],
     "detail": "Enviar um lembrete pelo WhatsApp um dia antes, com link para remarcar.", "area": "Integrações",
     "estimate": 30},
    {"title": "Painel do barbeiro", "summary": "Agenda do dia de cada barbeiro", "deps": [5],
     "detail": "Página com a agenda do dia por barbeiro, com os clientes e os serviços de cada horário.",
     "area": "Site", "estimate": 30},
    {"title": "Testes do fluxo completo", "summary": "Do agendamento ao pagamento e ao lembrete",
     "deps": [6, 7, 8, 9], "detail": "Testes automáticos do fluxo: agendar, pagar, receber o lembrete e ver no "
                                     "painel.", "area": "Projeto", "estimate": 30,
     "criteria": ["Fluxo completo passa nos testes"]},
    {"title": "Publicar o site", "summary": "Colocar no ar com o domínio da barbearia", "deps": [10],
     "detail": "Publicar o site e o banco em produção e apontar o domínio.", "area": "Projeto", "estimate": 20,
     "gates": [{"kind": "approval", "label": "Publicar o site",
                "where": "Confira o site de testes antes de aprovar."}]},
]
EDIT = {"action": "edit", "id": "#3", "text": "Na verdade, cada agendamento pode ter mais de um serviço",
        "detail": "Criar as tabelas servicos, barbeiros, clientes e agendamentos, e a tabela agendamento_servicos "
                  "para que um agendamento tenha vários serviços; migração e índices por barbeiro e data."}
PROPOSAL = {"action": "propose", "changes": [
    {"task": 3, "summary": "Vários serviços por agendamento",
     "note": "Nova tabela agendamento_servicos; a coluna servico_id sai de agendamentos."},
    {"task": 5, "note": "A duração do horário passa a ser a soma dos serviços escolhidos."},
    {"task": 6, "note": "Permitir escolher mais de um serviço."},
    {"task": 9, "note": "O painel mostra todos os serviços de cada horário."},
    {"task": 10, "note": "Testar agendamentos com vários serviços.",
     "criteria": ["Fluxo completo passa nos testes", "Agendamento com dois serviços"]},
    {"title": "Combos de serviços", "summary": "Pacotes com preço especial, como corte + barba", "deps": [3],
     "detail": "Cadastrar combos de serviços com preço próprio e oferecê-los na tela de agendamento.",
     "area": "Banco", "estimate": 20, "note": "Combos aparecem na tela de agendamento."},
    {"task": 8, "remove": True, "note": "O lembrete sai deste plano."},
]}


def steps():
    """The calls of a realistic session, with the moments to copy marked by name."""
    yield {"action": "plan", "title": TITLE, "request": REQUEST, "tasks": TASKS}
    yield {"action": "start", "id": 1, "note": "Lendo o pedido"}
    yield {"action": "progress", "id": 1, "percent": 60, "note": "Lista de serviços e preços"}
    yield {"action": "finish", "id": 1, "result": "Corte, barba e sobrancelha; 2 barbeiros; seg. a sáb., 9h às 19h."}
    yield {"action": "start", "id": 2}
    yield {"action": "progress", "id": 2, "percent": 70, "note": "criou o projeto Next.js",
           "files": ["package.json", "src/app/layout.tsx", "src/app/page.tsx"]}
    yield {"action": "finish", "id": 2, "result": "Projeto Next.js com TypeScript, Prisma e SQLite."}
    yield {"action": "start", "id": 3}
    yield {"action": "progress", "id": 3, "log": "criou as tabelas servicos, barbeiros, clientes e agendamentos",
           "files": ["prisma/schema.prisma", "prisma/migrations/0001_init/migration.sql"], "percent": 80}
    yield {"action": "finish", "id": 3, "result": "4 tabelas com índices por barbeiro e data."}
    yield {"action": "start", "id": 4}
    yield {"action": "progress", "id": 4, "note": "páginas de administração",
           "files": ["src/app/admin/servicos/page.tsx", "src/app/admin/barbeiros/page.tsx"]}
    yield {"action": "finish", "id": 4, "result": "Cadastro de serviços e barbeiros no /admin."}
    yield {"action": "start", "id": 5}
    yield {"action": "progress", "id": 5, "percent": 80, "note": "horarios.ts", "files": ["src/lib/horarios.ts"]}
    yield {"action": "finish", "id": 5, "result": "Horários livres a cada 30 minutos, respeitando pausas.",
           "criteria": ["Não oferece horário já ocupado", "2"]}
    yield {"action": "start", "id": "#6", "note": "Calendario.tsx"}
    yield {"action": "progress", "id": 6, "percent": 40, "note": "Calendario.tsx", "log": "criou BarbeiroPicker.tsx",
           "kind": "ok", "files": ["src/app/agendar/page.tsx", "src/components/BarbeiroPicker.tsx",
                                   "src/components/Calendario.tsx"]}
    yield {"action": "start", "id": 9}
    yield {"action": "progress", "id": 9, "percent": 30, "note": "agenda do dia", "files": ["src/app/painel/page.tsx"]}
    yield {"action": "fail", "id": 9, "problem": "O painel não carrega a agenda do dia",
           "detail": "A consulta de agendamentos por barbeiro devolve erro 500: falta o índice por data.",
           "options": ["Criar o índice e tentar de novo", "Mostrar só a semana atual"]}
    yield {"action": "need", "id": 7, "kind": "secret", "label": "Chave Pix de teste (sandbox)",
           "where": "No painel do banco ou do gateway, em Integrações › Pix › Credenciais de teste.",
           "env": "PIX_KEY", "alternatives": ["Deixar o Pix para depois", "Usar um pagamento simulado"]}
    yield EDIT
    yield "plan-recalibrating.json"
    yield PROPOSAL
    yield "plan-proposed.json"
    yield "proposal.json"
    yield {"action": "apply"}
    yield {"action": "start", "id": 3, "note": "agendamento_servicos"}
    yield {"action": "progress", "id": 3, "percent": 50, "note": "migração 0002_varios_servicos",
           "files": ["prisma/schema.prisma", "prisma/migrations/0002_varios_servicos/migration.sql"]}
    yield {"action": "focus", "id": 3, "mode": "map", "note": "Refazendo o banco com vários serviços por agendamento"}


def build(studio):
    """Run the session in the Studio folder `studio`; returns {name: text} of the sample files."""
    studio = Path(studio)
    copies = {}
    calls = 0
    context = {"studio_root": str(studio), "source_root": SOURCE, "request_id": "fixture-request"}
    def text(name):
        return json.dumps(Studio(studio, context, "")._read(name), ensure_ascii=False, indent=1)
    for step in steps():
        if isinstance(step, str):
            source = "plan.json" if step.startswith("plan") else step
            copies[step] = text(source)
            continue
        context["execution_id"] = f"fixture-{calls + 1:03d}"
        run(step, context, clock=lambda calls=calls: START + calls * STEP, approve=lambda details: True)
        calls += 1
    for name in ("plan.json", "history.json", "view.json"):
        copies[name] = text(name)
    return {name: copies[name] for name in NAMES}


def main():
    folder = tempfile.mkdtemp(prefix="taskstudio-fixtures-")
    try:
        files = build(folder)
    finally:
        shutil.rmtree(folder, ignore_errors=True)
    FIXTURES.mkdir(parents=True, exist_ok=True)
    for name, text in files.items():
        (FIXTURES / name).write_text(text + "\n", encoding="utf-8", newline="\n")
        if "--print" in sys.argv:
            print(f"--- {name}\n{text}")
    print(f"Wrote {len(files)} files to {FIXTURES}")


if __name__ == "__main__":
    main()
