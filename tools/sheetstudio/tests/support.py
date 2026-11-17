# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Test data: the "Barbearia do Zé" bookings as the back office exports them (CSV with ; and decimal comma, in
Windows-1252), with the problems real files have, and the expected numbers computed here, independently."""

import datetime
from pathlib import Path
import random
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

SERVICES = {"Corte": 45, "Barba": 30, "Corte e barba": 70, "Sobrancelha": 20, "Pigmentação": 60}
BARBERS = ("Zé", "Rafa", "Léo")
PAYMENTS = ("Pix", "Cartão", "Dinheiro")
ORIGINS = ("App", "Balcão", "WhatsApp")
NAMES = ("André Souza", "Luan Dias", "Guilherme Alves", "Igor Souza", "Leandro Vieira", "Rodrigo Pinto", "Jorge Cardoso", "Fernando Teixeira",
         "Paulo Barbosa", "Diego Lima", "Marcos Mendes", "Miguel Moreira", "Wagner Costa", "Daniel Mendes", "Gustavo Lima", "Bruno Oliveira")


def bookings(count=1200, seed=7):
    """A list of dicts (one per booking) from January to October 2026, before any problem is introduced."""
    rng = random.Random(seed)
    day = datetime.date(2026, 1, 2)
    rows = []
    while len(rows) < count:
        if day.weekday() != 6:
            for _ in range(rng.randint(2, 7)):
                hour = rng.choice((9, 10, 11, 13, 14, 15, 16, 17, 18))
                service = rng.choice(list(SERVICES))
                status = rng.choices(("concluído", "cancelado", "faltou"), (90, 6, 4))[0]
                rows.append({"data": day, "hora": f"{hour:02d}:{rng.choice((0, 30)):02d}", "cliente": rng.choice(NAMES), "serviço": service,
                             "barbeiro": rng.choice(BARBERS), "valor": SERVICES[service], "pagamento": rng.choice(PAYMENTS) if status == "concluído" else None,
                             "origem": rng.choice(ORIGINS), "status": status})
        day += datetime.timedelta(days=1)
        if day > datetime.date(2026, 10, 31):
            day = datetime.date(2026, 1, 2)
    return rows[:count]


def write_csv(folder, count=1200, seed=7):
    """Writes dados/atendimentos-2026.csv with the problems below and returns what the numbers must be.
    - rows 5..16: dates written as 2026-01-05 (ISO); rows 20..27: dates as 05/01/26
    - every 37th row: valor written as "R$ 45,00"
    - 6 rows copied again at the end (repeated rows)
    - 3 serviço values with a trailing space and 2 written in lower case
    - clients missing in every 50th row; pagamento empty exactly when status is not concluído"""
    rows = bookings(count, seed)
    copies = [dict(r) for r in rows[100:106]]
    lines = ["data;hora;cliente;serviço;barbeiro;valor;pagamento;origem;status"]
    iso = set(range(5, 17))
    short = set(range(20, 28))
    money = set()
    for index, row in enumerate(rows + copies):
        number = index + 2
        if index in iso:
            date = row["data"].isoformat()
        elif index in short:
            date = row["data"].strftime("%d/%m/%y")
        else:
            date = row["data"].strftime("%d/%m/%Y")
        value = f"{row['valor']:.2f}".replace(".", ",")
        if index % 37 == 3 and index < len(rows):
            value = f"R$ {value}"
            money.add(number)
        service = row["serviço"]
        if index in (40, 41, 42):
            service += " "
        if index in (60, 61):
            service = service.lower()
        client = "" if index % 50 == 9 and index < len(rows) else row["cliente"]
        if index % 50 == 9 and index < len(rows):
            row["cliente"] = None
        lines.append(";".join([date, row["hora"], client, service, row["barbeiro"], value, row["pagamento"] or "", row["origem"], row["status"]]))
    path = Path(folder) / "dados" / "atendimentos-2026.csv"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(("\r\n".join(lines) + "\r\n").encode("cp1252"))
    concluded = [r for r in rows if r["status"] == "concluído"]
    by_month = {}
    for r in concluded:
        key = r["data"].strftime("%Y-%m")
        by_month[key] = by_month.get(key, 0) + r["valor"]
    dup_concluded = [r for r in copies if r["status"] == "concluído"]
    by_month_raw = dict(by_month)
    for r in dup_concluded:
        key = r["data"].strftime("%Y-%m")
        by_month_raw[key] = by_month_raw.get(key, 0) + r["valor"]
    by_service = {}
    for r in concluded:
        name = r["serviço"]
        by_service[name] = by_service.get(name, 0) + r["valor"]
    return {"path": path, "rows": len(rows) + len(copies), "unique_rows": len(rows), "copies": len(copies), "iso_dates": len(iso), "short_dates": len(short),
            "money_text": len(money), "by_month_clean": by_month, "by_month_raw": by_month_raw, "revenue_clean": sum(by_month.values()),
            "revenue_raw": sum(by_month_raw.values()), "not_concluded": sum(1 for r in rows + copies if r["status"] != "concluído"),
            "empty_clients": sum(1 for r in rows if r["cliente"] is None), "by_service": by_service}


def write_xlsx(folder, count=4800, seed=11):
    """dados/atendimentos-2026.xlsx as Excel would hold it: typed cells, with the same problems as text cells,
    a Preços sheet and a Resumo sheet. Returns the path and the number of rows in Atendimentos."""
    from jumpcode_sheetstudio.writers.xlsx import write_xlsx as writer
    rows = bookings(count, seed)
    copies = [dict(r) for r in rows[3406:3415]]
    table = []
    for index, row in enumerate(rows + copies):
        date = row["data"]
        if index in range(5, 26):
            date = row["data"].isoformat()
        elif index in range(30, 46):
            date = row["data"].strftime("%d/%m/%y")
        value = row["valor"]
        if index % 43 == 7 and index < len(rows):
            value = "R$ " + f"{row['valor']:.2f}".replace(".", ",")
        hour, minute = (int(part) for part in row["hora"].split(":"))
        table.append([date, datetime.time(hour, minute), row["cliente"] if index % 86 != 9 else None, row["serviço"], row["barbeiro"], value,
                      row["pagamento"], row["origem"], row["status"]])
    columns = [{"name": "data", "type": "date"}, {"name": "hora", "type": "time"}, {"name": "cliente", "type": "text"}, {"name": "serviço", "type": "text"},
               {"name": "barbeiro", "type": "text"}, {"name": "valor", "type": "currency"}, {"name": "pagamento", "type": "text"},
               {"name": "origem", "type": "text"}, {"name": "status", "type": "text"}]
    prices = [[name, float(price)] for name, price in SERVICES.items()]
    path = Path(folder) / "dados" / "atendimentos-2026.xlsx"
    path.parent.mkdir(parents=True, exist_ok=True)
    writer(path, [{"name": "Atendimentos", "columns": columns, "rows": table},
                  {"name": "Preços", "columns": [{"name": "serviço", "type": "text"}, {"name": "preço", "type": "currency"}], "rows": prices},
                  {"name": "Resumo", "columns": [{"name": "barbeiro", "type": "text"}, {"name": "comissão", "type": "percent"}],
                   "rows": [["Zé", 0.4], ["Rafa", 0.4], ["Léo", 0.35]]}])
    return {"path": path, "rows": len(table)}
