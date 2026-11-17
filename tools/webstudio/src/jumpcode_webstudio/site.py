# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root.

"""A small static site, edited one section at a time inside the folder the IDE gives the Studio."""

from html import escape
import base64
import hashlib
import json
from pathlib import Path
import re
import unicodedata

from .storage import locked, commit, read_file, SaveFailed

SITE_FILE = "site.json"
STYLES_FILE = "styles.css"
HOME_PAGE = "index"
DEFAULT_STYLE = "base"

MAX_PAGES = 12
MAX_SECTIONS = 40
MAX_STYLES = 30
MAX_HTML = 20_000
MAX_CSS = 20_000
MAX_TITLE = 120
MAX_SITE = 1_000_000
# Budget the JSON-encoded response, including the JSON text inside it. This
# leaves room for the registry envelope below the agent's 128 KiB limit.
MAX_READ_BYTES = 60_000
NEXT = " Next: another call, or answer the user in one short sentence."

ACTIONS = ("write_section", "write_styles", "remove_section", "remove_page", "read")
_FIELDS = {"action", "page", "section", "html", "title", "name", "css", "cursor"}
_ID = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$")
_DOCUMENT = re.compile(r"<body[^>]*>(?P<body>.*?)</body\s*>", re.IGNORECASE | re.DOTALL)
_SHELL = re.compile(r"<!doctype[^>]*>|</?html[^>]*>|<head\b.*?</head\s*>|</?body[^>]*>", re.IGNORECASE | re.DOTALL)


class WebStudioError(ValueError):
    """Invalid request or Studio folder; nothing was written."""


def _identifier(value, kind):
    """Accept natural names such as 'Cardápio' by folding them into a safe file id."""
    if not isinstance(value, str):
        raise WebStudioError(f"The {kind} id must be text")
    folded = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii").lower()
    folded = re.sub(r"[^a-z0-9]+", "-", folded).strip("-")[:40].strip("-")
    if not _ID.match(folded):
        raise WebStudioError(f"Invalid {kind} id: use a short name with letters and numbers")
    return folded


def _text(value, kind, limit, *, allow_empty=False):
    if not isinstance(value, str):
        raise WebStudioError(f"{kind} must be text")
    value = value.strip()
    if not value and not allow_empty:
        raise WebStudioError(f"{kind} is empty")
    if len(value) > limit:
        raise WebStudioError(f"{kind} is longer than {limit} characters; split it into smaller parts")
    return value


def _section_html(value):
    value = _text(value, "html", MAX_HTML)
    document = _DOCUMENT.search(value)
    if document:
        value = document.group("body")
    value = _SHELL.sub("", value).strip()
    if not value:
        raise WebStudioError("html has no content outside <html>, <head> and <body>")
    if "<!-- studio:" in value or "<!-- /studio:" in value:
        raise WebStudioError("html cannot contain Studio markers")
    return value


def validate(arguments):
    """Return a normalized copy; never touches the disk or the caller's data."""
    if not isinstance(arguments, dict):
        raise WebStudioError("Arguments must be an object")
    unknown = set(arguments) - _FIELDS
    if unknown:
        raise WebStudioError("Unknown arguments: " + ", ".join(sorted(map(str, unknown))))
    action = arguments.get("action")
    if action not in ACTIONS:
        raise WebStudioError("action must be one of: " + ", ".join(ACTIONS))
    result = {"action": action}
    if action in ("write_section", "remove_section", "remove_page") or "page" in arguments:
        result["page"] = _identifier(arguments.get("page", HOME_PAGE), "page")
    if action == "write_section":
        result["section"] = _identifier(arguments.get("section"), "section")
        result["html"] = _section_html(arguments.get("html"))
        if arguments.get("title") is not None:
            result["title"] = _text(arguments["title"], "title", MAX_TITLE)
    elif action == "write_styles":
        result["name"] = _identifier(arguments.get("name", DEFAULT_STYLE), "style")
        result["css"] = _text(arguments.get("css"), "css", MAX_CSS)
        if "</style" in result["css"].lower():
            raise WebStudioError("css cannot contain </style>")
    elif action == "read":
        if "name" in arguments:
            if "page" in arguments or "section" in arguments:
                raise WebStudioError("Read either a page or a style block, not both")
            result["name"] = _identifier(arguments["name"], "style")
        if "section" in arguments:
            if "page" not in arguments:
                raise WebStudioError("Reading a section requires its page")
            result["section"] = _identifier(arguments["section"], "section")
        if "cursor" in arguments:
            if "page" not in result and "name" not in result:
                raise WebStudioError("A read cursor requires a page or style block")
            result["cursor"] = _text(arguments["cursor"], "cursor", 512)
    elif action == "remove_section":
        result["section"] = _identifier(arguments.get("section"), "section")
    elif action == "remove_page" and result["page"] == HOME_PAGE:
        raise WebStudioError("The home page cannot be removed")
    if action != "write_section" and arguments.get("title") is not None:
        raise WebStudioError("title is only used with write_section")
    if action != "read" and "cursor" in arguments:
        raise WebStudioError("cursor is only used with read")
    return result


def page_file(page):
    return "index.html" if page == HOME_PAGE else page + ".html"


def _root(context):
    value = context.get("studio_root") if isinstance(context, dict) else None
    if not isinstance(value, str) or not value:
        raise WebStudioError("WebStudio only works inside an open Studio")
    root = Path(value)
    try:
        if not root.is_absolute() or root.is_symlink() or not root.is_dir() or root.parent == root:
            raise WebStudioError("The Studio folder is unavailable")
    except OSError as error:
        raise WebStudioError("The Studio folder is unavailable") from error
    return root


def _empty():
    return {"version": 1, "pages": [], "styles": []}


def load(root):
    """Read the site model; a missing file is an empty site."""
    try:
        raw = read_file(Path(root), SITE_FILE)
        if raw is None:
            return _empty()
    except (OSError, UnicodeError) as error:
        raise WebStudioError("The site could not be read") from error
    try:
        site = json.loads(raw)
    except ValueError as error:
        raise WebStudioError("site.json is damaged; nothing was changed") from error
    if not isinstance(site, dict) or site.get("version") != 1 or not isinstance(site.get("pages"), list) or not isinstance(site.get("styles"), list):
        raise WebStudioError("site.json is damaged; nothing was changed")
    try:
        def entries(items, key, limit):
            if not isinstance(items, list) or len(items) > limit:
                raise ValueError()
            identifiers = set()
            for item in items:
                identity = item[key]
                if not isinstance(identity, str) or not _ID.fullmatch(identity) or identity in identifiers:
                    raise ValueError()
                identifiers.add(identity)
            return items
        if len(raw) > MAX_SITE:
            raise ValueError()
        for page in entries(site["pages"], "id", MAX_PAGES):
            _text(page["title"], "title", MAX_TITLE, allow_empty=True)
            for section in entries(page["sections"], "id", MAX_SECTIONS):
                _text(section["html"], "html", MAX_HTML)
        for block in entries(site["styles"], "name", MAX_STYLES):
            _text(block["css"], "css", MAX_CSS)
    except (ValueError, TypeError, KeyError) as error:
        raise WebStudioError("site.json is damaged; nothing was changed") from error
    return site


def render_page(page):
    title = page.get("title") or "Novo site"
    parts = [
        "<!doctype html>",
        '<html lang="pt-BR">',
        "<head>",
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        f"<title>{escape(title)}</title>",
        f'<link rel="stylesheet" href="{STYLES_FILE}">',
        "</head>",
        "<body>",
    ]
    for section in page["sections"]:
        parts += [f"<!-- studio:section {section['id']} -->", section["html"], f"<!-- /studio:section {section['id']} -->"]
    parts += ["</body>", "</html>", ""]
    return "\n".join(parts)


def render_styles(site):
    return "\n\n".join(f"/* studio:style {block['name']} */\n{block['css']}" for block in site["styles"]) + "\n"


def _page(site, page_id, *, create=False):
    for page in site["pages"]:
        if page["id"] == page_id:
            return page
    if not create:
        raise WebStudioError(f"Page '{page_id}' does not exist")
    if len(site["pages"]) >= MAX_PAGES:
        raise WebStudioError(f"A site can have at most {MAX_PAGES} pages")
    page = {"id": page_id, "title": "", "sections": []}
    if page_id == HOME_PAGE:
        site["pages"].insert(0, page)
    else:
        site["pages"].append(page)
    return page


def _outline(site):
    return [{"page": page["id"], "file": page_file(page["id"]), "title": page.get("title", ""),
             "sections": [section["id"] for section in page["sections"]]} for page in site["pages"]]


def _read(site, arguments):
    if "name" in arguments:
        block = next((block for block in site["styles"] if block["name"] == arguments["name"]), None)
        if block is None:
            raise WebStudioError(f"Style block '{arguments['name']}' does not exist")
        return _read_content(arguments, [block], {"name": block["name"]}, "css")
    if "page" not in arguments:
        styles = [{"name": block["name"], "characters": len(block["css"])} for block in site["styles"]]
        return {"text": json.dumps({"pages": _outline(site), "styles": styles}, ensure_ascii=False), "pages": _outline(site)}
    page = _page(site, arguments["page"])
    sections = page["sections"]
    if "section" in arguments:
        sections = [section for section in sections if section["id"] == arguments["section"]]
        if not sections:
            raise WebStudioError(f"Section '{arguments['section']}' does not exist on page '{page['id']}'")
    return _read_content(arguments, sections, {"page": page["id"], "title": page.get("title", "")}, "html")


def _read_content(arguments, items, metadata, field):
    """Read contiguous chunks; a cursor identifies the content version and position."""
    def encode(value):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

    selection = {key: arguments[key] for key in ("page", "section", "name") if key in arguments}
    revision = hashlib.sha256(encode([selection, metadata, items]).encode("utf-8")).hexdigest()
    index, offset = 0, 0
    if "cursor" in arguments:
        try:
            previous, index, offset = json.loads(base64.b64decode(arguments["cursor"], altchars=b"-_", validate=True))
        except (ValueError, TypeError):
            raise WebStudioError("Invalid read cursor; read the content again") from None
        if previous != revision:
            raise WebStudioError("Content changed since the previous read; read it again without a cursor")
        if type(index) is not int or type(offset) is not int or not 0 <= index < len(items) or not 0 <= offset < len(items[index][field]):
            raise WebStudioError("Invalid read cursor position")

    rows = []

    def response(rows, position):
        data = {**metadata, "sections": rows} if field == "html" else {**metadata, **rows[0]}
        if position is not None:
            cursor = base64.urlsafe_b64encode(encode([revision, *position]).encode("utf-8")).decode("ascii")
            data["next"] = {"action": "read", **selection, "cursor": cursor}
        return {"text": encode(data), **{key: metadata[key] for key in ("page", "name") if key in metadata}}

    while index < len(items):
        item, start = items[index], offset
        content = item[field]

        def candidate(end):
            row = {key: value for key, value in item.items() if key != field}
            row.update({field: content[start:end], "complete": start == 0 and end == len(content)})
            if start or end < len(content):
                row.update(offset=start, totalCharacters=len(content))
            position = (index, end) if end < len(content) else (index + 1, 0) if index + 1 < len(items) else None
            return row, response([*rows, row], position)

        row, result = candidate(len(content))
        if len(encode(result).encode("utf-8")) > MAX_READ_BYTES:
            if rows:
                return response(rows, (index, start))
            # Even one section may need chunks (Unicode or escaped characters).
            low, high = start, len(content)
            while low < high:
                middle = (low + high + 1) // 2
                if len(encode(candidate(middle)[1]).encode("utf-8")) <= MAX_READ_BYTES:
                    low = middle
                else:
                    high = middle - 1
            if low == start:
                raise WebStudioError("Read metadata exceeds the response budget")
            return candidate(low)[1]
        rows.append(row)
        index, offset = index + 1, 0
    return response(rows, None)


def apply(site, arguments):
    """Change the model in memory and describe what to write; validated arguments only."""
    action = arguments["action"]
    if action == "write_section":
        page = _page(site, arguments["page"], create=True)
        if arguments.get("title"):
            page["title"] = arguments["title"]
        elif not page["title"] and page["id"] != HOME_PAGE:
            home = next((item for item in site["pages"] if item["id"] == HOME_PAGE), None)
            page["title"] = home["title"] if home else ""
        existing = next((section for section in page["sections"] if section["id"] == arguments["section"]), None)
        if existing:
            existing["html"] = arguments["html"]
            message = f"Section '{arguments['section']}' replaced on page '{page['id']}'."
        else:
            if len(page["sections"]) >= MAX_SECTIONS:
                raise WebStudioError(f"A page can have at most {MAX_SECTIONS} sections")
            page["sections"].append({"id": arguments["section"], "html": arguments["html"]})
            message = f"Section '{arguments['section']}' added to page '{page['id']}' ({len(page['sections'])} sections)."
        return message, {page["id"]}, False, []
    if action == "write_styles":
        existing = next((block for block in site["styles"] if block["name"] == arguments["name"]), None)
        if existing:
            existing["css"] = arguments["css"]
        else:
            if len(site["styles"]) >= MAX_STYLES:
                raise WebStudioError(f"A site can have at most {MAX_STYLES} style blocks")
            site["styles"].append({"name": arguments["name"], "css": arguments["css"]})
        return f"Style block '{arguments['name']}' saved.", set(), True, []
    if action == "remove_section":
        page = _page(site, arguments["page"])
        remaining = [section for section in page["sections"] if section["id"] != arguments["section"]]
        if len(remaining) == len(page["sections"]):
            raise WebStudioError(f"Section '{arguments['section']}' does not exist on page '{page['id']}'")
        page["sections"] = remaining
        return f"Section '{arguments['section']}' removed from page '{page['id']}'.", {page["id"]}, False, []
    page = _page(site, arguments["page"])
    site["pages"].remove(page)
    return f"Page '{page['id']}' removed.", set(), False, [page_file(page["id"])]


def run(arguments, context):
    """Apply one validated change inside the Studio folder and re-render the affected files."""
    root = _root(context)
    with locked(root):
        return _run_locked(root, arguments)


def _run_locked(root, arguments):
    site = load(root)
    if arguments["action"] == "read":
        return _read(site, arguments)
    message, pages, styles, removed = apply(site, arguments)
    serialized = json.dumps(site, ensure_ascii=False, indent=1)
    if len(serialized) > MAX_SITE:
        raise WebStudioError("The site is too large; remove sections before adding more")
    changes = {page_file(page["id"]): render_page(page) for page in site["pages"] if page["id"] in pages}
    if styles or not (root / STYLES_FILE).exists():
        changes[STYLES_FILE] = render_styles(site)
    changes.update({name: None for name in removed})
    changes[SITE_FILE] = serialized
    try:
        commit(root, changes)
    except SaveFailed as error:
        raise WebStudioError(str(error)) from error
    result = {"text": message + NEXT, "action": arguments["action"], "pages": _outline(site)}
    if "page" in arguments:
        result["page"] = arguments["page"]
    if "section" in arguments:
        result["section"] = arguments["section"]
    return result
