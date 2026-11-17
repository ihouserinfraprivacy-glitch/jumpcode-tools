# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""The app's map (which screen leads to which, by what the person taps) and its problems: screens without a way out,
screens nobody reaches, links to screens that do not exist, empty screens, low contrast, images without a description
and buttons without a name."""

import re

from .markup import read_html
from .render import DEFAULT_THEME, ordered_parts


def routes(app):
    screens = {screen["id"]: screen for screen in app.get("screens", [])}
    by_route = {(screen.get("route") or "/" + screen["id"]): screen["id"] for screen in screens.values()}
    edges, missing, states = [], [], {}
    leaves = {sid: False for sid in screens}
    for sid, screen in screens.items():
        found = set()
        for part in ordered_parts(screen):
            reader = read_html(part["html"])
            found |= reader.states
            for link in reader.links:
                how = link["how"]
                if how in ("back", "close"):
                    leaves[sid] = True
                    edges.append({"from": sid, "to": None, "label": link["label"] or ("Voltar" if how == "back" else "Fechar"), "how": how})
                    continue
                target = by_route.get(link.get("route")) if how == "link" else link["to"]
                if target in screens:
                    leaves[sid] = True
                    edges.append({"from": sid, "to": target, "label": link["label"], "how": "go" if how == "link" else how})
                else:
                    missing.append({"from": sid, "to": link.get("route") if how == "link" else link["to"]})
        states[sid] = sorted(found)
    # The tab bar links every tab screen to the others; the map shows that as the tabs group, not as edges.
    tabs = [tab["screen"] for tab in app.get("tabs") or [] if tab["screen"] in screens]
    reached = {app.get("start")} | set(tabs) | {edge["to"] for edge in edges if edge["to"]}
    dead = [sid for sid, screen in screens.items() if not leaves[sid] and sid not in tabs and sid != app.get("start")
            and screen.get("parts")]
    unreachable = [sid for sid in screens if sid not in reached]
    links = [{"route": screen.get("route") or "/" + sid, "screen": sid} for sid, screen in screens.items()]
    unique = []
    for edge in edges:
        key = (edge["from"], edge["to"], edge["how"], edge["label"])
        if key not in {(e["from"], e["to"], e["how"], e["label"]) for e in unique}:
            unique.append(edge)
    return {"edges": unique, "deadEnds": dead, "unreachable": unreachable, "missing": missing, "links": links, "states": states}


def _luminance(color):
    match = re.fullmatch(r"#?([0-9a-fA-F]{6})", str(color or "").strip())
    if not match:
        return None
    channels = [int(match.group(1)[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    linear = [c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4 for c in channels]
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]


def contrast(first, second):
    a, b = _luminance(first), _luminance(second)
    if a is None or b is None:
        return None
    light, dark = max(a, b), min(a, b)
    return round((light + 0.05) / (dark + 0.05), 2)


def problems(app, mapped=None):
    mapped = mapped or routes(app)
    titles = {screen["id"]: screen.get("title") or screen["id"] for screen in app.get("screens", [])}
    found = []
    for sid in mapped["deadEnds"]:
        found.append({"id": f"dead-end-{sid}", "kind": "dead-end", "screen": sid, "part": None,
                      "text": f"{titles[sid]} não tem saída: nenhum botão volta ou leva a outra tela.",
                      "fix": f"Na tela {titles[sid]}, coloque um botão que volte (data-back) ou leve para o Início."})
    for sid in mapped["unreachable"]:
        found.append({"id": f"unreachable-{sid}", "kind": "unreachable", "screen": sid, "part": None,
                      "text": f"Nenhuma tela leva a {titles[sid]}.",
                      "fix": f"Coloque um botão que abra {titles[sid]} (data-go=\"{sid}\") ou ponha a tela nas abas."})
    for item in mapped["missing"]:
        found.append({"id": f"missing-{item['from']}-{item['to']}", "kind": "missing-link", "screen": item["from"], "part": None,
                      "text": f"{titles[item['from']]} leva para {item['to']}, que não existe.",
                      "fix": f"Crie a tela {item['to']} ou troque o destino do botão em {titles[item['from']]}."})
    for screen in app.get("screens", []):
        if not screen.get("parts"):
            found.append({"id": f"empty-{screen['id']}", "kind": "empty-screen", "screen": screen["id"], "part": None,
                          "text": f"{titles[screen['id']]} ainda não tem nenhuma parte.", "fix": f"Escreva as partes da tela {titles[screen['id']]}."})
        for part in screen.get("parts", []):
            reader = read_html(part["html"])
            if reader.images_without_alt:
                found.append({"id": f"image-alt-{screen['id']}-{part['id']}", "kind": "image-alt", "screen": screen["id"], "part": part["id"],
                              "text": f"{reader.images_without_alt} imagem(ns) sem descrição em {titles[screen['id']]}, parte {part['id']}.",
                              "fix": "Coloque alt com uma descrição curta em cada imagem."})
            if reader.unlabelled_buttons:
                found.append({"id": f"button-label-{screen['id']}-{part['id']}", "kind": "button-label", "screen": screen["id"], "part": part["id"],
                              "text": f"{reader.unlabelled_buttons} botão(ões) só com ícone e sem nome em {titles[screen['id']]}, parte {part['id']}.",
                              "fix": "Coloque aria-label nos botões que só têm ícone, para leitores de tela."})
    data = app.get("data") or {}
    tabs = {tab["screen"] for tab in app.get("tabs") or []}
    for screen in app.get("screens", []):
        if screen["id"] in tabs and screen.get("kind") != "tab":
            found.append({"id": f"tab-kind-{screen['id']}", "kind": "tab-kind", "screen": screen["id"], "part": None,
                          "text": f"{titles[screen['id']]} está nas abas mas abre como tela empilhada: a barra de abas some nela.",
                          "fix": f"Deixe {titles[screen['id']]} como aba (kind tab) ou tire a aba dela."})
        for part in screen.get("parts", []):
            reader = read_html(part["html"])
            where = f"{titles[screen['id']]}, parte {part['id']}"
            for collection, fields in reader.each.items():
                rows = data.get(collection)
                if rows is None:
                    found.append({"id": f"no-data-{screen['id']}-{part['id']}-{collection}", "kind": "missing-data", "screen": screen["id"],
                                  "part": part["id"], "text": f"A lista {collection} em {where} não tem dados de exemplo: aparece vazia.",
                                  "fix": f"Crie os dados de exemplo {collection} ou troque data-each por uma coleção que existe."})
                    continue
                keys = {key for row in rows if isinstance(row, dict) for key in row}
                unknown = sorted(fields - keys)
                if unknown:
                    found.append({"id": f"fields-{screen['id']}-{part['id']}-{collection}", "kind": "missing-field", "screen": screen["id"],
                                  "part": part["id"], "text": f"Em {where}, {', '.join('{{' + f + '}}' for f in unknown)} não existe nos dados {collection}.",
                                  "fix": f"Use os campos de {collection}: {', '.join(sorted(keys)) or 'nenhum'}."})
            if reader.idle_buttons:
                found.append({"id": f"idle-button-{screen['id']}-{part['id']}", "kind": "idle-button", "screen": screen["id"], "part": part["id"],
                              "text": f"Botão sem ação em {where}: {', '.join(reader.idle_buttons[:3])}.",
                              "fix": "Diga para onde o botão leva (data-go), ou se ele volta (data-back) ou fecha (data-close)."})
    theme = {**DEFAULT_THEME, **(app.get("theme") or {})}
    for first, second, label, minimum in ((theme["text"], theme["background"], "o texto sobre o fundo", 4.5),
                                          (theme["muted"], theme["background"], "o texto suave sobre o fundo", 4.5),
                                          ("#FFFFFF", theme["primary"], "o texto branco sobre a cor principal", 4.5),
                                          ("#FFFFFF", theme["accent"], "o texto branco sobre a cor de destaque", 3.0)):
        ratio = contrast(first, second)
        if ratio is not None and ratio < minimum:
            found.append({"id": f"contrast-{label}", "kind": "contrast", "screen": None, "part": None,
                          "text": f"Contraste baixo: {label} tem {str(ratio).replace('.', ',')}:1 (o mínimo é {str(minimum).replace('.', ',')}:1).",
                          "fix": "Escureça a cor de fundo do botão ou do texto até passar do mínimo."})
    return found
