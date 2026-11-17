# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Exports as new files in the project (never over the original): the clean data as CSV or XLSX (with one sheet
per chart's numbers) and a chart as SVG on a light background, ready for a document or a slide."""

import csv
import io
import math
from decimal import Decimal
from xml.sax.saxutils import escape

from . import types
from .common import SheetStudioError, free_name, write_text

PALETTE = ("#3F76B8", "#C9643F", "#24876F", "#7D6CC9", "#8A6F2E", "#B0477F", "#5F6B7A", "#3E8E5A")
HEAT = ("#EEF3FA", "#D3E0F1", "#AFC6E6", "#86A8D8", "#5E89C6", "#3F6FAE", "#2C568C", "#1E3F69")


def _value(value, kind, style):
    if value is None:
        return ""
    if style == "br":
        if kind in ("integer", "number", "currency", "percent"):
            number = Decimal(str(value)) * 100 if kind == "percent" else Decimal(str(value))
            text = format(number, "f")
            return text.replace(".", ",") + ("%" if kind == "percent" else "")
        if kind == "date" and isinstance(value, str):
            return f"{value[8:10]}/{value[5:7]}/{value[0:4]}"
        if kind == "datetime" and isinstance(value, str):
            return f"{value[8:10]}/{value[5:7]}/{value[0:4]} {value[11:]}"
        if kind == "time" and isinstance(value, str):
            return value
        if kind == "bool":
            return "sim" if value else "não"
    return value


def data_csv(columns, rows, style="br"):
    """The rows as CSV text: Brazilian Excel style (; and decimal comma, dd/mm/aaaa, with BOM) or plain (, . ISO)."""
    buffer = io.StringIO()
    writer = csv.writer(buffer, delimiter=";" if style == "br" else ",", lineterminator="\r\n")
    writer.writerow([c["name"] for c in columns])
    for row in rows:
        writer.writerow([_value(v, c["type"], style) for v, c in zip(row, columns)])
    return ("﻿" if style == "br" else "") + buffer.getvalue()


def write_csv(folder, name, columns, rows, style="br"):
    target = free_name(folder, name)
    write_text(target, data_csv(columns, rows, style), encoding="utf-8")
    return target


XLSX_TYPES = {"text": "text", "category": "text", "integer": "integer", "number": "number", "currency": "currency", "percent": "percent",
              "date": "date", "datetime": "datetime", "time": "time", "bool": "bool"}


def _python(value, kind):
    import datetime
    if value is None:
        return None
    try:
        if kind == "date" and isinstance(value, str):
            return datetime.date.fromisoformat(value[:10])
        if kind == "datetime" and isinstance(value, str):
            return datetime.datetime.fromisoformat(value)
        if kind == "time" and isinstance(value, str):
            return datetime.time.fromisoformat(value)
    except ValueError:
        return value
    if kind == "bool":
        return bool(value)
    return value


def chart_table(chart):
    """The same complete data for both direct chart exports and workbook sheets."""
    if chart.get("kind") == "query":
        table = chart["table"]
        columns = []
        for index, name in enumerate(table["columns"]):
            values = [row[index] for row in table["rows"] if row[index] is not None]
            kind = "number" if values and all(isinstance(v, (int, float)) for v in values) else "text"
            columns.append({"name": name, "type": kind})
        return columns, table["rows"]
    unit = "integer" if chart["unit"] == "count" else XLSX_TYPES.get(chart["unit"], "number")
    columns = [{"name": chart["x"]["column"] or "Grupo", "type": "text"}] + [{"name": s["name"], "type": unit} for s in chart["series"]]
    rows = [[label] + [s["values"][i] for s in chart["series"]] for i, label in enumerate(chart["labels"])]
    return columns, rows


def write_xlsx(folder, name, data_columns, rows, charts):
    try:
        from .writers.xlsx import write_xlsx as writer
    except ImportError as error:
        raise SheetStudioError("The XLSX writer is not available; export as csv instead.") from error
    sheets = [{"name": "Dados", "columns": [{"name": c["name"], "type": XLSX_TYPES.get(c["type"], "text")} for c in data_columns],
               "rows": ([_python(v, c["type"]) for v, c in zip(row, data_columns)] for row in rows)}]
    for chart in charts:
        columns, table = chart_table(chart)
        sheets.append({"name": chart["title"][:31], "columns": columns, "rows": table})
    target = free_name(folder, name)
    writer(target, sheets)
    return target


# ------------------------------------------------------------------ SVG charts (light, for documents)

def short(value, unit):
    if value is None:
        return ""
    magnitude = abs(value)
    if unit == "percent":
        return types.number(value * 100, 0 if magnitude >= 0.1 else 1) + "%"
    prefix = "R$ " if unit == "currency" else ""
    if magnitude >= 1_000_000:
        return prefix + types.number(value / 1_000_000, 1) + " mi"
    if magnitude >= 10_000:
        return prefix + types.number(value / 1000, 0 if magnitude >= 100_000 else 1) + " mil"
    if unit == "currency":
        return types.brl(value, 0 if float(value).is_integer() else 2)
    return types.number(value, 0 if float(value).is_integer() else 1)


def _ticks(high):
    if high <= 0:
        return [0, 1]
    raw = high / 4
    power = 10 ** math.floor(math.log10(raw))
    step = min((s * power for s in (1, 2, 2.5, 5, 10) if s * power >= raw), default=raw)
    return [step * i for i in range(int(math.ceil(high / step)) + 1)]


def _scale(low, high):
    positive = _ticks(max(abs(low), abs(high)))
    step = positive[1]
    start, end = math.floor(min(0, low) / step), math.ceil(max(0, high) / step)
    return [i * step for i in range(start, max(start + 1, end) + 1)]


def svg(chart, width=960, height=540):
    kind = chart["kind"]
    unit = chart["unit"]
    labels = chart["labels"]
    series = chart["series"]
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" font-family="Segoe UI, Tahoma, Arial, sans-serif">',
           f'<rect width="{width}" height="{height}" fill="#FFFFFF"/>',
           f'<text x="32" y="40" font-size="20" font-weight="600" fill="#1F2328">{escape(chart["title"])}</text>',
           f'<text x="32" y="64" font-size="13" fill="#5F6B7A">{escape(chart["calc"]["readable"])}</text>']
    left, top, right, bottom = 96, 92, width - 32, height - 64
    if kind in ("stacked100",):
        totals = [sum(abs(s["values"][i] or 0) for s in series) or 1 for i in range(len(labels))]
        series = [{"name": s["name"], "values": [(s["values"][i] or 0) / totals[i] for i in range(len(labels))]} for s in series]
        unit = "percent"
    if kind == "heatmap":
        out += _heat(chart, left, top, right, bottom)
    elif kind == "hbar":
        out += _hbar(labels, series[0]["values"] if series else [], unit, 200, top, right, bottom)
    else:
        stacked = kind in ("stacked", "stacked100")
        if stacked:
            high = max((sum(max(0, s["values"][i] or 0) for s in series) for i in range(len(labels))), default=0)
            low = min((sum(min(0, s["values"][i] or 0) for s in series) for i in range(len(labels))), default=0)
        else:
            high = max((v or 0 for s in series for v in s["values"]), default=0)
            low = min((v or 0 for s in series for v in s["values"]), default=0)
        ticks = _scale(low, high)
        y = lambda v: bottom - (bottom - top) * ((v or 0) - ticks[0]) / (ticks[-1] - ticks[0])
        for tick in ticks:
            out.append(f'<line x1="{left}" x2="{right}" y1="{y(tick):.1f}" y2="{y(tick):.1f}" stroke="#E4E7EB"/>')
            out.append(f'<text x="{left - 10}" y="{y(tick) + 4:.1f}" font-size="12" fill="#5F6B7A" text-anchor="end">{escape(short(tick, unit))}</text>')
        slot = (right - left) / max(1, len(labels))
        for i, name in enumerate(labels):
            out.append(f'<text x="{left + slot * (i + 0.5):.1f}" y="{bottom + 20}" font-size="12" fill="#3B434C" text-anchor="middle">{escape(str(name))}</text>')
        if kind == "line":
            for index, s in enumerate(series):
                points = " ".join(f"{left + slot * (i + 0.5):.1f},{y(v):.1f}" for i, v in enumerate(s["values"]) if v is not None)
                out.append(f'<polyline points="{points}" fill="none" stroke="{PALETTE[index % len(PALETTE)]}" stroke-width="2.5"/>')
        else:
            groups = len(series) if kind == "grouped" else 1
            bar = slot * 0.62 / groups
            for i in range(len(labels)):
                positive, negative = 0, 0
                for index, s in enumerate(series):
                    value = s["values"][i] or 0
                    x = left + slot * i + slot * 0.19 + (bar * index if kind == "grouped" else 0)
                    if stacked:
                        base = positive if value >= 0 else negative
                        out.append(f'<rect x="{x:.1f}" y="{min(y(base), y(base + value)):.1f}" width="{bar:.1f}" height="{abs(y(base) - y(base + value)):.1f}" fill="{PALETTE[index % len(PALETTE)]}"/>')
                        if value >= 0:
                            positive += value
                        else:
                            negative += value
                    else:
                        out.append(f'<rect x="{x:.1f}" y="{min(y(0), y(value)):.1f}" width="{bar:.1f}" height="{abs(y(0) - y(value)):.1f}" fill="{PALETTE[index % len(PALETTE)]}"/>')
                if len(series) == 1 and len(labels) <= 16:
                    value = series[0]["values"][i]
                    out.append(f'<text x="{left + slot * (i + 0.5):.1f}" y="{y(value) - 6:.1f}" font-size="11" fill="#3B434C" text-anchor="middle">{escape(short(value, unit))}</text>')
        out.append(f'<line x1="{left}" x2="{right}" y1="{y(0):.1f}" y2="{y(0):.1f}" stroke="#9AA3AD"/>')
    if len(series) > 1 and kind != "heatmap":
        x = left
        for index, s in enumerate(series):
            out.append(f'<rect x="{x}" y="{height - 26}" width="12" height="12" fill="{PALETTE[index % len(PALETTE)]}"/>')
            out.append(f'<text x="{x + 18}" y="{height - 16}" font-size="12" fill="#3B434C">{escape(str(s["name"]))}</text>')
            x += 32 + 7 * len(str(s["name"]))
    out.append("</svg>")
    return "\n".join(out)


def _hbar(labels, values, unit, left, top, right, bottom):
    out = []
    low = min([0] + [v for v in values if v is not None])
    high = max([0] + [v for v in values if v is not None])
    x = lambda v: left + (right - left - 120) * ((v or 0) - low) / (high - low or 1)
    zero = x(0)
    out.append(f'<line x1="{zero:.1f}" x2="{zero:.1f}" y1="{top}" y2="{bottom}" stroke="#9AA3AD"/>')
    row = (bottom - top) / max(1, len(labels))
    size = min(28, row * 0.66)
    for i, (name, value) in enumerate(zip(labels, values)):
        y = top + row * i + (row - size) / 2
        width = abs(x(value) - zero)
        out.append(f'<text x="{left - 10}" y="{y + size / 2 + 4:.1f}" font-size="12" fill="#3B434C" text-anchor="end">{escape(str(name))}</text>')
        out.append(f'<rect x="{min(zero, x(value)):.1f}" y="{y:.1f}" width="{width:.1f}" height="{size:.1f}" fill="{PALETTE[0]}"/>')
        out.append(f'<text x="{max(zero, x(value)) + 8:.1f}" y="{y + size / 2 + 4:.1f}" font-size="12" fill="#1F2328">{escape(short(value, unit))}</text>')
    return out


def _heat(chart, left, top, right, bottom):
    out = []
    labels, series = chart["labels"], chart["series"]
    values = [v for s in series for v in s["values"] if v is not None]
    low, high = min([0] + values), max([0] + values)
    cell_w = (right - left) / max(1, len(labels))
    cell_h = (bottom - top) / max(1, len(series))
    for r, s in enumerate(series):
        out.append(f'<text x="{left - 10}" y="{top + cell_h * (r + 0.5) + 4:.1f}" font-size="12" fill="#3B434C" text-anchor="end">{escape(str(s["name"]))}</text>')
        for c, value in enumerate(s["values"]):
            ratio = ((value or 0) - low) / (high - low or 1)
            shade = HEAT[max(0, min(len(HEAT) - 1, round(ratio * (len(HEAT) - 1))))] if value is not None else "#F6F7F9"
            out.append(f'<rect x="{left + cell_w * c + 1:.1f}" y="{top + cell_h * r + 1:.1f}" width="{cell_w - 2:.1f}" height="{cell_h - 2:.1f}" fill="{shade}"/>')
            if value is not None and cell_w > 30:
                color = "#FFFFFF" if ratio > 0.55 else "#1F2328"
                out.append(f'<text x="{left + cell_w * (c + 0.5):.1f}" y="{top + cell_h * (r + 0.5) + 4:.1f}" font-size="11" fill="{color}" text-anchor="middle">{escape(short(value, chart["unit"]))}</text>')
    for c, name in enumerate(labels):
        out.append(f'<text x="{left + cell_w * (c + 0.5):.1f}" y="{bottom + 18}" font-size="12" fill="#3B434C" text-anchor="middle">{escape(str(name))}</text>')
    return out


def write_svg(folder, name, chart):
    if chart.get("kind") in ("pivot", "query", "table"):
        raise SheetStudioError("Tables export as xlsx or csv; svg is for charts.")
    target = free_name(folder, name)
    write_text(target, svg(chart))
    return target
