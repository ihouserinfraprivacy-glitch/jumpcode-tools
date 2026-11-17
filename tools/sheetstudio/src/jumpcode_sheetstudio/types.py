# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Column types: what each column holds (text, category, number, money, percent, date, time...), read the way a
Brazilian spreadsheet writes them (1.234,56, R$ 45,00, dd/mm/aaaa) and turned into values SQLite can calculate with."""

import datetime
import math
import re

TYPES = ("text", "category", "integer", "number", "currency", "percent", "date", "datetime", "time", "bool")
NUMERIC = ("integer", "number", "currency", "percent")
TEMPORAL = ("date", "datetime", "time")
LABELS = {"text": "texto", "category": "categoria", "integer": "número inteiro", "number": "número", "currency": "R$ moeda",
          "percent": "percentual", "date": "data", "datetime": "data e hora", "time": "hora", "bool": "sim/não"}
SQL_TYPES = {"integer": "INTEGER", "number": "REAL", "currency": "REAL", "percent": "REAL", "bool": "INTEGER"}
IDENTITY_NAMES = re.compile(r"cliente|nome|name|e-?mail|telefone|celular|fone|phone|cpf|cnpj|\bid\b|c[oó]digo|code|descri|observa|coment|endere|address", re.I)
MONEY_NAMES = re.compile(r"valor|pre[cç]o|total|receita|faturament|custo|comiss|pago|ticket|sal[aá]rio|r\$|despesa|lucro|desconto|frete|price|amount|revenue|cost", re.I)

_NUMBER = re.compile(r"^(?P<neg>[-−(])?\s*(?P<cur>R\$|US\$|\$|€)?\s*(?P<neg2>-)?\s*(?P<num>\d[\d.,\s  ]*\d|\d)\s*(?P<pct>%)?\s*(?P<cur2>R\$|reais)?\s*\)?$", re.I)
_ISO = re.compile(r"^(?P<y>\d{4})-(?P<m>\d{1,2})-(?P<d>\d{1,2})(?:[ T](?P<H>\d{1,2}):(?P<M>\d{2})(?::(?P<S>\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$")
_DMY = re.compile(r"^(?P<a>\d{1,2})(?P<sep>[/.-])(?P<b>\d{1,2})(?P=sep)(?P<y>\d{4}|\d{2})(?:,?\s+(?P<H>\d{1,2})[:h](?P<M>\d{2})(?::(?P<S>\d{2}))?)?$")
_TIME = re.compile(r"^(?P<H>\d{1,2})(?::|h)(?P<M>\d{2})(?::(?P<S>\d{2}))?$")
TRUE = {"sim", "true", "verdadeiro", "yes", "s", "y", "x", "1"}
FALSE = {"não", "nao", "false", "falso", "no", "n", "0"}
BOOL_WORDS = {"sim", "não", "nao", "true", "false", "verdadeiro", "falso", "yes", "no"}


def is_error(value):
    return value is not None and type(value).__name__ == "CellError"


# ------------------------------------------------------------------ reading one text value

def number_from_text(text, decimal="comma"):
    """(value, kind) for a number written as text, or None. kind: integer, number, currency or percent."""
    match = _NUMBER.match(text.strip())
    if not match:
        return None
    digits = re.sub(r"[\s  ]", "", match.group("num"))
    has_comma, has_dot = "," in digits, "." in digits
    if has_comma and has_dot:
        decimal_mark = "," if digits.rfind(",") > digits.rfind(".") else "."
    elif has_comma:
        decimal_mark = "," if (decimal != "dot" or not re.fullmatch(r"\d{1,3}(,\d{3})+", digits)) else ""
    elif has_dot:
        decimal_mark = "." if (decimal == "dot" or not re.fullmatch(r"\d{1,3}(\.\d{3})+", digits)) else ""
    else:
        decimal_mark = ""
    thousands = {",": ".", ".": ","}.get(decimal_mark, "")
    if decimal_mark:
        whole, _, fraction = digits.rpartition(decimal_mark)
        if decimal_mark in fraction or (thousands and not re.fullmatch(rf"\d{{1,3}}(\{thousands}\d{{3}})*|\d+", whole)):
            return None
        whole = whole.replace(thousands, "") if thousands else whole
    else:
        whole, fraction = digits.replace(",", "").replace(".", ""), ""
        if not re.fullmatch(r"\d{1,3}([.,]\d{3})*|\d+", digits):
            return None
    try:
        value = float(f"{whole}.{fraction}") if fraction else int(whole)
    except ValueError:
        return None
    if match.group("neg") or match.group("neg2"):
        value = -value
    if match.group("pct"):
        return value / 100, "percent"
    if match.group("cur") or match.group("cur2"):
        return float(value), "currency"
    return value, ("integer" if isinstance(value, int) else "number")


def _year(text):
    year = int(text)
    if len(text) == 2:
        year += 2000 if year < 70 else 1900
    return year


def date_from_text(text, order="dmy"):
    """(date or datetime, format label) for a date written as text, or None."""
    text = text.strip()
    match = _ISO.match(text)
    label = "aaaa-mm-dd"
    if match:
        y, m, d = int(match.group("y")), int(match.group("m")), int(match.group("d"))
    else:
        match = _DMY.match(text)
        if not match:
            return None
        a, b, y = int(match.group("a")), int(match.group("b")), _year(match.group("y"))
        d, m = (b, a) if order == "mdy" else (a, b)
        sep = match.group("sep")
        label = ("mm" if order == "mdy" else "dd") + sep + ("dd" if order == "mdy" else "mm") + sep + ("aa" if len(match.group("y")) == 2 else "aaaa")
    try:
        day = datetime.date(y, m, d)
    except ValueError:
        return None
    if match.group("H") is not None:
        try:
            moment = datetime.datetime(y, m, d, int(match.group("H")), int(match.group("M")), int(match.group("S") or 0))
        except ValueError:
            return None
        return moment, label + " hh:mm"
    return day, label


def time_from_text(text):
    match = _TIME.match(text.strip())
    if not match:
        return None
    try:
        return datetime.time(int(match.group("H")), int(match.group("M")), int(match.group("S") or 0))
    except ValueError:
        return None


def bool_from_text(text):
    lowered = text.strip().lower()
    if lowered in ("sim", "true", "verdadeiro", "yes"):
        return True
    if lowered in ("não", "nao", "false", "falso", "no"):
        return False
    return None


# ------------------------------------------------------------------ choosing a column's type

def guess_decimal(values):
    """'comma' or 'dot' from text numbers whose separator is unambiguous (45,00 vs 45.00); Brazilian comma when nothing tells."""
    comma = dot = 0
    for value in values:
        if not isinstance(value, str):
            continue
        match = re.search(r"\d([.,])(\d{1,2})(?:\D*)$", value.strip())
        if match and not re.search(r"\d[.,]\d{3}$", value.strip()):
            if match.group(1) == ",":
                comma += 1
            else:
                dot += 1
    return "dot" if dot > comma else "comma"


def guess_date_order(values):
    """'mdy' only when a text date can only be month-first (13/.. never appears as a month)."""
    dmy = mdy = 0
    for value in values:
        if isinstance(value, str):
            match = _DMY.match(value.strip())
            if match:
                a, b = int(match.group("a")), int(match.group("b"))
                if a > 12 >= b:
                    dmy += 1
                elif b > 12 >= a:
                    mdy += 1
    return "mdy" if mdy > dmy else "dmy"


def infer(name, values, decimal="auto", order="auto"):
    """The type of a column from a sample of its raw values: {type, decimal, order}."""
    decimal = guess_decimal(values) if decimal == "auto" else decimal
    order = guess_date_order(values) if order == "auto" else order
    counts = dict.fromkeys(("empty", "int", "float", "currency", "percent", "date", "datetime", "time", "bool", "error", "text"), 0)
    fractional = False
    for value in values:
        if value is None or (isinstance(value, str) and not value.strip()):
            counts["empty"] += 1
        elif isinstance(value, bool):
            counts["bool"] += 1
        elif isinstance(value, int):
            counts["int"] += 1
        elif isinstance(value, float):
            counts["float" if not value.is_integer() else "int"] += 1
            fractional = fractional or not value.is_integer()
        elif isinstance(value, datetime.datetime):
            counts["datetime" if (value.hour or value.minute or value.second) else "date"] += 1
        elif isinstance(value, datetime.date):
            counts["date"] += 1
        elif isinstance(value, datetime.time):
            counts["time"] += 1
        elif is_error(value):
            counts["error"] += 1
        else:
            text = str(value).strip()
            parsed = number_from_text(text, decimal)
            if parsed is not None and not re.fullmatch(r"0\d+", text.replace(" ", "")):
                kind = parsed[1]
                counts[{"integer": "int", "number": "float"}.get(kind, kind)] += 1
                fractional = fractional or (kind != "integer" and not float(parsed[0]).is_integer())
                continue
            day = date_from_text(text, order)
            if day is not None:
                counts["datetime" if isinstance(day[0], datetime.datetime) else "date"] += 1
                continue
            if time_from_text(text) is not None:
                counts["time"] += 1
            elif text.lower() in BOOL_WORDS:
                counts["bool"] += 1
            else:
                counts["text"] += 1
    filled = len(values) - counts["empty"] - counts["error"]
    if filled <= 0:
        return {"type": "text", "decimal": decimal, "order": order}
    share = lambda *kinds: sum(counts[k] for k in kinds) / filled
    if share("date", "datetime") >= 0.9:
        kind = "datetime" if counts["datetime"] > 0 else "date"
    elif share("time") >= 0.9:
        kind = "time"
    elif share("bool") >= 0.9:
        kind = "bool"
    elif share("int", "float", "currency", "percent") >= 0.9:
        if counts["percent"] and share("percent") >= 0.5:
            kind = "percent"
        elif counts["currency"] or MONEY_NAMES.search(name or ""):
            kind = "currency"
        elif fractional or counts["float"]:
            kind = "number"
        else:
            kind = "integer"
    else:
        kind = "text"
    return {"type": kind, "decimal": decimal, "order": order}


# ------------------------------------------------------------------ converting a cell to its column's type

def _iso(value):
    if isinstance(value, datetime.datetime):
        return value.strftime("%Y-%m-%d %H:%M:%S")
    if isinstance(value, datetime.date):
        return value.isoformat()
    if isinstance(value, datetime.time):
        return value.strftime("%H:%M:%S")
    return value


def as_text(value):
    if value is None:
        return None
    if isinstance(value, bool):
        return "VERDADEIRO" if value else "FALSO"
    if isinstance(value, float):
        return str(int(value)) if value.is_integer() and abs(value) < 1e15 else repr(value)
    if isinstance(value, (datetime.date, datetime.time)):
        return _iso(value)
    return str(value)


def converter(column):
    """A function raw value -> (stored value, issue) for a column {type, decimal, order}. issue: None,
    ('text-date', format), ('text-number', kind), ('unparsed', text) or ('error', code)."""
    kind, decimal, order = column["type"], column.get("decimal", "comma"), column.get("order", "dmy")

    def text_kind(value):
        if value is None:
            return None, None
        if is_error(value):
            return None, ("error", str(value))
        text = as_text(value)
        return (text if text.strip() else None), None

    def numeric(value):
        if value is None or isinstance(value, bool):
            return (None if value is None else int(value)), None
        if isinstance(value, (int, float)):
            if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
                return None, ("unparsed", str(value))
            return (int(value) if kind == "integer" and float(value).is_integer() else value), None
        if is_error(value):
            return None, ("error", str(value))
        if isinstance(value, (datetime.date, datetime.time)):
            return None, ("unparsed", _iso(value))
        text = str(value).strip()
        if not text:
            return None, None
        parsed = number_from_text(text, decimal)
        if parsed is None:
            return None, ("unparsed", text)
        number = parsed[0]
        if kind == "integer" and float(number).is_integer():
            number = int(number)
        return number, ("text-number", "R$" if parsed[1] == "currency" else "%" if parsed[1] == "percent" else "texto")

    def temporal(value):
        if value is None:
            return None, None
        if is_error(value):
            return None, ("error", str(value))
        if kind == "time":
            if isinstance(value, datetime.datetime):
                return value.strftime("%H:%M:%S"), None
            if isinstance(value, datetime.time):
                return value.strftime("%H:%M:%S"), None
            if isinstance(value, (int, float)) and not isinstance(value, bool) and 0 <= value < 1:
                seconds = round(value * 86400)
                return f"{seconds // 3600:02d}:{seconds % 3600 // 60:02d}:{seconds % 60:02d}", None
            text = str(value).strip()
            if not text:
                return None, None
            moment = time_from_text(text)
            return (moment.strftime("%H:%M:%S"), ("text-time", "hh:mm")) if moment else (None, ("unparsed", text))
        if isinstance(value, datetime.datetime):
            return (value.strftime("%Y-%m-%d %H:%M:%S") if kind == "datetime" else value.date().isoformat()), None
        if isinstance(value, datetime.date):
            return (value.isoformat() + (" 00:00:00" if kind == "datetime" else "")), None
        if isinstance(value, (int, float)) and not isinstance(value, bool) and 20000 < value < 80000:
            moment = datetime.datetime(1899, 12, 30) + datetime.timedelta(days=float(value))
            return (moment.strftime("%Y-%m-%d %H:%M:%S") if kind == "datetime" else moment.date().isoformat()), ("text-date", "número de série")
        text = as_text(value).strip()
        if not text:
            return None, None
        parsed = date_from_text(text, order)
        if parsed is None:
            return None, ("unparsed", text)
        moment, label = parsed
        if kind == "datetime":
            stored = moment.strftime("%Y-%m-%d %H:%M:%S") if isinstance(moment, datetime.datetime) else moment.isoformat() + " 00:00:00"
        else:
            stored = (moment.date() if isinstance(moment, datetime.datetime) else moment).isoformat()
        return stored, ("text-date", label)

    def boolean(value):
        if value is None:
            return None, None
        if isinstance(value, bool):
            return int(value), None
        if isinstance(value, (int, float)) and value in (0, 1):
            return int(value), None
        if is_error(value):
            return None, ("error", str(value))
        text = str(value).strip()
        if not text:
            return None, None
        parsed = bool_from_text(text)
        return (int(parsed), None) if parsed is not None else (None, ("unparsed", text))

    if kind in NUMERIC:
        return numeric
    if kind in TEMPORAL:
        return temporal
    if kind == "bool":
        return boolean
    return text_kind


def sql_type(kind):
    return SQL_TYPES.get(kind, "TEXT")


# ------------------------------------------------------------------ showing values in pt-BR

MONTHS = ("jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez")
MONTH_NAMES = ("janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro")
WEEKDAYS = ("dom", "seg", "ter", "qua", "qui", "sex", "sáb")


def brl(value, decimals=2):
    if value is None:
        return "—"
    if value and round(value, decimals) == 0:
        return ("-" if value < 0 else "") + "R$ " + format(abs(value), ".12g").replace(".", ",")
    text = f"{abs(value):,.{decimals}f}".replace(",", "§").replace(".", ",").replace("§", ".")
    return ("-" if value < 0 else "") + "R$ " + text


def number(value, decimals=None):
    if value is None:
        return "—"
    if decimals is None:
        decimals = 0 if float(value).is_integer() else 2
    if value and round(value, decimals) == 0:
        return format(value, ".12g").replace(".", ",")
    return f"{value:,.{decimals}f}".replace(",", "§").replace(".", ",").replace("§", ".")


def show(value, kind):
    """A stored value as a short pt-BR text (for messages and the Studio)."""
    if value is None:
        return ""
    if kind == "currency":
        return brl(value)
    if kind == "percent":
        return number(value * 100, 1) + "%"
    if kind in ("integer", "number"):
        return number(value)
    if kind == "date" and isinstance(value, str) and len(value) >= 10:
        return f"{value[8:10]}/{value[5:7]}/{value[0:4]}"
    if kind == "datetime" and isinstance(value, str) and len(value) >= 16:
        return f"{value[8:10]}/{value[5:7]}/{value[0:4]} {value[11:16]}"
    if kind == "time" and isinstance(value, str):
        return value[:5]
    if kind == "bool":
        return "sim" if value else "não"
    return str(value)
