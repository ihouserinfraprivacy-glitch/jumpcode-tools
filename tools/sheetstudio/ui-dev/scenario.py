# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Dev only: runs the "Barbearia do Zé" questions through the real tool (open the workbook, charts, pivot, profile,
panel, problems, fixes, a calculated column, a filter) and saves the Studio files it produced in
ui-dev/fixtures/<state>/ for the harness: empty (nothing open), barbearia (charts and problems found, nothing
fixed) and limpa (after the fixes). Run from anywhere: python scenario.py"""

import json
from pathlib import Path
import shutil
import sys
import tempfile

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "src"))
sys.path.insert(0, str(HERE.parent / "tests"))
from support import write_csv, write_xlsx  # noqa: E402
import jumpcode_sheetstudio as tool  # noqa: E402

STUDIO_FILES = ("sheet.json", "grid.json", "charts.json", "cleanup.json", "history.json", "view.json", "settings.json")


def save(studio, state):
    target = HERE / "fixtures" / state
    shutil.rmtree(target, ignore_errors=True)
    target.mkdir(parents=True)
    for name in STUDIO_FILES:
        source = studio / name
        if source.exists():
            data = json.loads(source.read_text(encoding="utf-8"))
            (target / name).write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    print(state, sorted(p.name for p in target.iterdir()))


def main():
    base = Path(tempfile.mkdtemp(prefix="sheetstudio-scenario-"))
    studio, project = base / "studio", base / "barbearia-do-ze"
    studio.mkdir()
    project.mkdir()
    write_xlsx(project)
    write_csv(project, count=900)
    (project / "dados" / "precos.csv").write_text("serviço;preço\nCorte;45,00\nBarba;30,00\nCorte e barba;70,00\n", encoding="utf-8")
    context = {"studio_root": str(studio), "source_root": str(project)}

    def call(**arguments):
        result = tool.run(tool.validate(arguments), context)
        print(" ", arguments["action"], "->", result["message"][:110].replace("\n", " "))
        return result

    try:
        call(action="status")
        save(studio, "empty")
        call(action="open", path="dados/atendimentos-2026.xlsx")
        call(action="chart", x="data", by="month", y="valor", agg="sum", filter="status = concluído", title="Faturamento por mês",
             question="faça um gráfico do faturamento por mês")
        call(action="chart", x="serviço", y="valor", agg="sum", filter="status = concluído", kind="hbar", title="Faturamento por serviço",
             question="qual serviço mais fatura?")
        call(action="chart", x="data", by="month", y="valor", agg="sum", group="barbeiro", filter="status = concluído", kind="line",
             title="Faturamento por barbeiro", question="compara os três barbeiros")
        call(action="chart", x="hora", group="data", group_by="weekday", filter="status = concluído", kind="heatmap", title="Horários de pico",
             question="quais são os horários de pico?")
        call(action="chart", x="data", by="month", group="pagamento", filter="status = concluído", kind="stacked100", title="Forma de pagamento por mês",
             question="e a forma de pagamento, mudou ao longo do ano?")
        call(action="pivot", rows="serviço", columns="barbeiro", value="valor", agg="sum", filter="status = concluído", title="Serviço por barbeiro",
             question="faz uma tabela dinâmica de serviço por barbeiro")
        call(action="chart", x="data", by="month", group="origem", kind="stacked100", title="De onde vêm os agendamentos")
        charts = json.loads((studio / "charts.json").read_text(encoding="utf-8"))["charts"]
        ids = {c["title"]: c["id"] for c in charts}
        call(action="panel", title="Painel para o Zé", charts=[ids["Faturamento por mês"], ids["Faturamento por serviço"], ids["Faturamento por barbeiro"],
                                                               ids["De onde vêm os agendamentos"]],
             numbers=[{"title": "Faturamento", "y": "valor", "agg": "sum", "filter": "status = concluído"},
                      {"title": "Atendimentos concluídos", "agg": "count", "filter": "status = concluído"},
                      {"title": "Ticket médio", "y": "valor", "agg": "avg", "filter": "status = concluído"},
                      {"title": "Faltas", "agg": "count", "filter": "status = faltou"}],
             question="monta um painel com o principal pra eu mostrar pro Zé")
        call(action="profile", question="me mostra um resumo das colunas")
        call(action="problems", question="tem algo errado nos dados?")
        call(action="focus", view="charts", select=ids["Faturamento por mês"])
        save(studio, "barbearia")
        call(action="fix", which="all", question="pode aplicar")
        call(action="column", name="dia da semana", part="weekday", question="cria uma coluna com o dia da semana", **{"from": "data"})
        call(action="chart", x="dia da semana", y="valor", agg="avg", filter="status = concluído", title="Ticket médio por dia da semana")
        call(action="rows", filter="serviço = Corte e barba", question="filtrar a tabela: serviço = Corte e barba")
        call(action="export", what="all", format="xlsx", question="exporta o gráfico do mês e uma planilha nova")
        save(studio, "limpa")
    finally:
        shutil.rmtree(base, ignore_errors=True)


if __name__ == "__main__":
    main()
