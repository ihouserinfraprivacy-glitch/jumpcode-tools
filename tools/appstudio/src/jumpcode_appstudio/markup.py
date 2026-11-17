# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""Reading the app's HTML and CSS: what is not allowed in an app part, the navigation it declares (data-go, data-tab,
data-back, data-close, #/route links) with the words the person taps, and simple accessibility facts."""

from html.parser import HTMLParser
import re

FORBIDDEN_TAGS = {"script", "iframe", "object", "embed", "link", "meta", "base", "frame", "frameset", "applet", "noscript", "template"}
VOID = {"area", "br", "col", "hr", "img", "input", "source", "track", "wbr", "path", "circle", "rect", "line", "polyline", "polygon",
        "ellipse", "use", "stop"}
NAVIGATION = ("data-go", "data-tab", "data-back", "data-close")
EXTERNAL = re.compile(r"^\s*(?:https?:)?//", re.I)
PLACEHOLDER = re.compile(r"\{\{\s*([^{}]*?)\s*\}\}")
FIELD = re.compile(r"[A-Za-z_\u00C0-\u024F][\w\u00C0-\u024F-]{0,39}")
STATES = ("normal", "carregando", "vazio", "erro", "sem-internet", "sempre")


class _Reader(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.problems = []
        self.links = []
        self.states = set()
        self.images_without_alt = 0
        self.unlabelled_buttons = 0
        self.idle_buttons = []
        self.each = {}
        self.orphans = set()
        self.bad_placeholders = set()
        self._open = []

    def handle_starttag(self, tag, attrs):
        self._start(tag, attrs, closed=tag in VOID)

    def handle_startendtag(self, tag, attrs):
        self._start(tag, attrs, closed=True)

    def _start(self, tag, attrs, closed):
        tag = tag.lower()
        for item in self._open:
            item["text"].append(" ")
        values = {name.lower(): (value or "") for name, value in attrs}
        if tag in FORBIDDEN_TAGS:
            self.problems.append(f"<{tag}> is not allowed (the app's behaviour comes from data-go, data-back, data-tab and the runtime)")
        for name, value in values.items():
            if name.startswith("on"):
                self.problems.append(f"the {name} attribute is not allowed; use data-go, data-back or data-tab")
            if name in ("href", "src", "action", "formaction", "xlink:href", "poster") and value:
                if value.strip().lower().startswith("javascript:"):
                    self.problems.append(f"{name}=javascript: is not allowed")
                elif name != "href" and EXTERNAL.match(value):
                    self.problems.append(f"{name} points to the internet ({value[:60]}); draw images with inline SVG or use a data: URL")
            if name == "style" and ("url(" in value.lower() and EXTERNAL.search(value.lower().split("url(", 1)[1])):
                self.problems.append("a style points to the internet; keep everything inside the app")
        if "data-state" in values:
            for state in values["data-state"].split():
                if state not in STATES:
                    self.problems.append(f"data-state={state} is unknown; use {', '.join(STATES)}")
                elif state not in ("normal", "sempre"):
                    self.states.add(state)
        if tag == "img" and "alt" not in values:
            self.images_without_alt += 1
        collection = values.get("data-each", "").strip() or None
        if collection is not None:
            self.each.setdefault(collection, set())
        for value in values.values():
            self._placeholders(value)
        idle = tag == "button" and not any(name in values for name in NAVIGATION) and values.get("type", "").lower() != "submit"
        entry = None
        for name in NAVIGATION:
            if name in values:
                entry = {"how": name[5:], "to": values[name].strip() or None, "label": values.get("aria-label") or values.get("title") or ""}
                break
        if entry is None and tag == "a" and values.get("href", "").startswith("#/"):
            entry = {"how": "link", "route": values["href"][1:], "label": values.get("aria-label") or values.get("title") or ""}
        if entry is not None:
            self.links.append(entry)
        if not closed:
            self._open.append({"tag": tag, "entry": entry, "text": [], "button": tag == "button", "idle": idle, "each": collection,
                               "labelled": bool(values.get("aria-label") or values.get("title"))})

    def handle_endtag(self, tag):
        tag = tag.lower()
        for index in range(len(self._open) - 1, -1, -1):
            if self._open[index]["tag"] == tag:
                for item in self._open[index:][::-1]:
                    self._close(item)
                del self._open[index:]
                break

    def _close(self, item):
        text = " ".join("".join(item["text"]).split())
        if "{{" in text:
            # A repeated item (data-each): its words come from the example data, one per row.
            text = "toca num item da lista"
        if item["entry"] is not None and not item["entry"]["label"]:
            item["entry"]["label"] = text[:48]
        if item["button"] and not text and not item["labelled"]:
            self.unlabelled_buttons += 1
        if item.get("idle"):
            self.idle_buttons.append(text[:40] or "(sem texto)")

    def _placeholders(self, text):
        """{{field}} inside a data-each element names a field of its rows; anywhere else it is shown as is."""
        collection = next((item["each"] for item in reversed(self._open) if item.get("each")), None)
        for match in PLACEHOLDER.finditer(text):
            name = match.group(1)
            if not FIELD.fullmatch(name):
                self.bad_placeholders.add(name)
            elif collection is None:
                self.orphans.add(name)
            else:
                self.each[collection].add(name)

    def handle_data(self, data):
        self._placeholders(data)
        for item in self._open:
            item["text"].append(data)

    def close(self):
        super().close()
        for item in self._open[::-1]:
            self._close(item)
        self._open = []


def read_html(html):
    reader = _Reader()
    reader.feed(html)
    reader.close()
    return reader


def check_html(html):
    """The reasons a part's HTML cannot be saved, or an empty list."""
    lowered = html.lower()
    problems = list(dict.fromkeys(read_html(html).problems))
    if re.search(r"<\s*(html|head|body)\b", lowered):
        problems.append("send only the part's elements, without <html>, <head> or <body>")
    return problems


def check_css(css):
    lowered = css.lower()
    problems = []
    if "@import" in lowered:
        problems.append("@import is not allowed; put the rules in this block")
    for match in re.finditer(r"url\(\s*['\"]?([^'\")]*)", lowered):
        if EXTERNAL.match(match.group(1)):
            problems.append(f"url({match.group(1)[:50]}) points to the internet; use inline SVG or data: URLs")
    if "expression(" in lowered or "javascript:" in lowered or "</style" in lowered:
        problems.append("the CSS has something that is not CSS")
    return problems
