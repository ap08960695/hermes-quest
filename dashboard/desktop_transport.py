"""Read-only JSON transport that lets Hermes Desktop load the original Quest game.

Desktop's plugin REST bridge (``ctx.rest``) only returns JSON, so the unchanged
static game (HTML, JS, PNG) is delivered as two small JSON envelopes:

* ``GET /desktop-bootstrap`` -> ``{version, nonce, html, source}``: one HTML
  document composed from the package's own ``index.html`` and its allowlisted
  scripts, with a locked-down CSP first and ``desktop/guest-bridge.js`` before
  the game scripts.
* ``GET /desktop-asset?path=<png>`` -> ``{mime, base64, sha256}`` for one public
  PNG under ``assets/px``.

This module only defines an ``APIRouter``; it is not mounted by itself. The
host's authentication applies once ``plugin_api.py`` includes it, exactly as for
``/replay``, ``/events`` and ``/static``. Nothing here reads replay data, private
previews, raw art or any file outside the allowlists, and every failure is a
fixed message without internal paths or payload content.
"""
from __future__ import annotations

import base64
import hashlib
import html.parser
import logging
import os
from pathlib import Path
import re
import secrets
import stat

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

router = APIRouter()
ROOT = Path(__file__).resolve().parent.parent
_log = logging.getLogger("hermes_quest.desktop_transport")

VERSION = 1
# Contract: probe/MOUNT-CONTRACT.md "Wire / isolation contract". The guest realm
# is opaque-origin with no network; only inline code and data: images may run.
GUEST_CSP = ("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
             "img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'")
NONCE_META = "quest-nonce"      # <meta name="quest-nonce" content="..."> read by guest-bridge.js
BRIDGE = "desktop/guest-bridge.js"
INDEX = "index.html"
# Scripts index.html may reference, in their required relative order. A script
# that is not listed here makes the bootstrap fail closed: add it deliberately.
SCRIPT_ORDER = ("font.js", "ui-glyphs.js", "ui-panels.js", "npcs.js", "quest/c-ui.js",
                "quest/geometry.js", "quest/appearance.js", "quest/state.js", "game.js")
MAX_SOURCE_BYTES = 1024 * 1024          # per package source file
MAX_BOOTSTRAP_BYTES = 2 * 1024 * 1024   # composed document
MAX_ASSET_BYTES = 4 * 1024 * 1024       # ground.png is ~1.9 MB
MAX_ASSET_PATH = 256
_NO_STORE = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}
_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
_ASSET_PATH_RE = re.compile(r"assets/px/[A-Za-z0-9_./-]+\.png\Z")
_SCRIPT_TAG_RE = re.compile(r'<script\s+src="([^"]*)"\s*></script>', re.IGNORECASE)
_URL_ATTRS = {"src", "href", "srcset", "data", "action", "formaction", "poster", "background",
              "ping", "manifest", "codebase", "xlink:href", "imagesrcset"}
_FORBIDDEN_TAGS = {"base", "iframe", "frame", "frameset", "object", "embed", "form", "portal",
                   "audio", "video", "source", "track", "applet"}
_CSS_URL_RE = re.compile(r"url\(\s*(['\"]?)\s*(?!data:)", re.IGNORECASE)
_CSS_IMPORT_RE = re.compile(r"@import", re.IGNORECASE)


class _BootstrapError(Exception):
    """Carries a fixed, safe reason code; never a path or file content."""


def _fail(code: str):
    raise _BootstrapError(code)


def _no_store(payload: dict, status: int = 200) -> JSONResponse:
    return JSONResponse(payload, status_code=status, headers=_NO_STORE)


_DESCRIPTOR_SAFE = (os.open in os.supports_dir_fd and hasattr(os, "O_NOFOLLOW")
                    and hasattr(os, "O_DIRECTORY"))


def _safe_file(relative: str, *, limit: int) -> tuple[bytes, str]:
    """Read one package file by exact relative POSIX path, descriptor-safe.

    The path is walked from ROOT one component at a time with ``dir_fd``: each
    directory is opened O_DIRECTORY|O_NOFOLLOW relative to the already-open
    parent, so swapping any ancestor (or the leaf) for a symlink after a check
    cannot redirect the read outside ROOT. The leaf is opened O_NONBLOCK so a
    FIFO or device cannot block the worker, then rejected unless ``fstat`` says
    regular file, and size-capped. Raises OSError/ValueError on any problem.
    Fails closed where dir_fd/O_NOFOLLOW/O_DIRECTORY are unavailable."""
    parts = relative.split("/")
    if not relative or "\\" in relative or "\0" in relative or any(p in ("", ".", "..") for p in parts):
        raise ValueError("bad path")
    if any(p.startswith(".") for p in parts):
        raise ValueError("hidden path")
    if not _DESCRIPTOR_SAFE:
        raise ValueError("descriptor-safe open unsupported")
    base = os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
    held = os.open(ROOT, os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_CLOEXEC", 0))
    try:
        for part in parts[:-1]:
            child = os.open(part, base | os.O_DIRECTORY, dir_fd=held)
            os.close(held)
            held = child
        fd = os.open(parts[-1], base | getattr(os, "O_NONBLOCK", 0), dir_fd=held)
    finally:
        os.close(held)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError("not a regular file")
        with os.fdopen(fd, "rb", closefd=False) as handle:
            data = handle.read(limit + 1)
    finally:
        os.close(fd)
    if len(data) > limit:
        raise ValueError("too large")
    return data, hashlib.sha256(data).hexdigest()


def _text(relative: str, missing: str) -> tuple[str, str]:
    try:
        data, digest = _safe_file(relative, limit=MAX_SOURCE_BYTES)
        text = data.decode("utf-8")
    except (OSError, ValueError, UnicodeDecodeError):
        raise _BootstrapError(missing) from None
    if "\0" in text:
        raise _BootstrapError("invalid_source")
    return text, digest


_HEAD_TAGS = {"meta", "title", "link", "style"}
_STRUCTURE_TAGS = {"html", "head", "body"}
# Tags whose content the HTML tokenizer treats as text/foreign content: refuse
# them so this audit and the browser cannot disagree about where tags are.
_FORBIDDEN_TAGS |= {"template", "noscript", "svg", "math", "textarea", "plaintext", "xmp",
                    "noembed", "noframes", "select", "frameset"}


class _Audit(html.parser.HTMLParser):
    """Fail closed on anything index.html could use to reach outside the bundle,
    and require the one canonical shape a browser parses the same way:

        <!doctype html><html><head>...</head><body>...</body></html>

    in that order, with no comments, processing instructions or CDATA, nothing
    but metadata tags inside <head>, and no stray structural tags. The position
    of the opening <head> tag is recorded from the tokenizer, so the CSP is
    inserted where the browser itself starts the head, not where a regex finds
    the text "<head"."""

    def __init__(self, page: str):
        super().__init__(convert_charrefs=True)
        self.scripts = []
        self.head_end = None        # absolute offset just after the opening <head ...>
        self._style = False
        self._title = False
        self._state = "doctype"     # doctype -> html -> head -> inhead -> afterhead -> body -> afterbody -> end
        self._starts = [0]
        for line in page.split("\n"):
            self._starts.append(self._starts[-1] + len(line) + 1)
        self._page = page

    def _offset(self) -> int:
        line, col = self.getpos()
        return self._starts[line - 1] + col

    def handle_decl(self, decl):
        if self._state != "doctype" or decl.strip().lower() != "doctype html":
            _fail("unexpected_reference")
        self._state = "html"

    def handle_comment(self, data):
        _fail("unexpected_reference")

    def handle_pi(self, data):
        _fail("unexpected_reference")

    def unknown_decl(self, data):
        _fail("unexpected_reference")

    def handle_startendtag(self, tag, attrs):
        if tag in _STRUCTURE_TAGS | {"script", "style", "title"}:
            _fail("unexpected_reference")
        self.handle_starttag(tag, attrs)

    def _structure(self, tag):
        state = self._state
        if state == "html" and tag == "html":
            self._state = "head"
        elif state == "head" and tag == "head":
            raw = self.get_starttag_text()
            start = self._offset()
            if self._page[start:start + len(raw)] != raw:
                _fail("unexpected_reference")
            self.head_end = start + len(raw)
            self._state = "inhead"
        elif state == "afterhead" and tag == "body":
            self._state = "body"
        elif state == "inhead":
            if tag not in _HEAD_TAGS:
                _fail("unexpected_reference")
        elif state == "body":
            if tag in _STRUCTURE_TAGS:
                _fail("unexpected_reference")
        else:
            _fail("unexpected_reference")

    def handle_starttag(self, tag, attrs):
        names = {name.lower(): (value or "") for name, value in attrs}
        self._structure(tag)
        if tag in _FORBIDDEN_TAGS:
            _fail("unexpected_reference")
        if any(name.startswith("on") for name in names):
            _fail("unexpected_reference")
        if "style" in names and (_CSS_URL_RE.search(names["style"]) or _CSS_IMPORT_RE.search(names["style"])):
            _fail("unexpected_reference")
        if tag == "meta" and ("http-equiv" in names or names.get("name", "").lower() == NONCE_META):
            _fail("unexpected_reference")
        if tag == "script":
            if self._state != "body" or set(names) != {"src"}:
                _fail("unexpected_script")
            self.scripts.append(names["src"])
            return
        if tag == "link":
            # Only the inline data: favicon is acceptable; it must not fetch anything.
            if not (set(names) <= {"rel", "href"} and names.get("rel", "").lower() == "icon"
                    and names.get("href", "").lower().startswith("data:")):
                _fail("unexpected_reference")
            return
        if tag == "style":
            self._style = True
        if tag == "title":
            self._title = True
        if _URL_ATTRS & set(names):
            _fail("unexpected_reference")

    def handle_endtag(self, tag):
        state = self._state
        if tag == "style":
            self._style = False
        elif tag == "title":
            self._title = False
        elif tag == "head" and state == "inhead":
            self._state = "afterhead"
        elif tag == "body" and state == "body":
            self._state = "afterbody"
        elif tag == "html" and state == "afterbody":
            self._state = "end"
        elif tag in _STRUCTURE_TAGS:
            _fail("unexpected_reference")

    def handle_data(self, data):
        if self._style and (_CSS_URL_RE.search(data) or _CSS_IMPORT_RE.search(data)):
            _fail("unexpected_reference")
        if self._title and "<" in data:
            _fail("unexpected_reference")
        if data.strip() and self._state not in ("body",) and not (self._style or self._title):
            _fail("unexpected_reference")

    def finish(self):
        self.close()
        if self._state != "end" or self.head_end is None:
            _fail("unexpected_reference")


def _inline(source: str) -> str:
    # Raw bytes must be preserved, so unsafe sequences are refused, not rewritten.
    lowered = source.lower()
    if "</script" in lowered or "<!--" in lowered:
        _fail("unsafe_script")
    return f"<script>{source}</script>"


def compose_bootstrap(nonce: str) -> dict:
    """Return the bootstrap envelope or raise _BootstrapError(reason)."""
    page, index_digest = _text(INDEX, "missing_index")
    audit = _Audit(page)
    try:
        audit.feed(page)
        audit.finish()
    except _BootstrapError:
        raise
    except Exception:  # noqa: BLE001 -- malformed markup is the same as an unexpected one
        _fail("unexpected_reference")
    matches = list(_SCRIPT_TAG_RE.finditer(page))
    if len(audit.scripts) != len(matches) or len(re.findall(r"<script", page, re.IGNORECASE)) != len(matches):
        _fail("unexpected_script")
    names = [m.group(1) for m in matches]
    if any(name not in SCRIPT_ORDER for name in names) or len(set(names)) != len(names):
        _fail("unexpected_script")
    positions = [SCRIPT_ORDER.index(name) for name in names]
    if positions != sorted(positions) or "game.js" not in names:
        _fail("script_order")

    sources = {INDEX: index_digest}
    bridge, sources[BRIDGE] = _text(BRIDGE, "missing_bridge")
    inlined = {}
    for name in names:
        script, sources[name] = _text(name, "missing_script")
        inlined[name] = _inline(script)
    bridge_tag = _inline(bridge)

    out, cursor = [], 0
    for position, match in enumerate(matches):
        out.append(page[cursor:match.start()])
        out.append((bridge_tag if position == 0 else "") + inlined[match.group(1)])
        cursor = match.end()
    out.append(page[cursor:])
    composed = "".join(out)
    # Scripts live in <body>, strictly after <head>, so head_end is unchanged by inlining.
    prefix_end = audit.head_end
    csp = f'<meta http-equiv="Content-Security-Policy" content="{GUEST_CSP}">'
    nonce_meta = f'<meta name="{NONCE_META}" content="{nonce}">'
    composed = composed[:prefix_end] + csp + nonce_meta + composed[prefix_end:]
    if len(composed.encode("utf-8")) > MAX_BOOTSTRAP_BYTES:
        _fail("too_large")
    return {"version": VERSION, "nonce": nonce, "html": composed, "source": sources}


@router.get("/desktop-bootstrap")
def desktop_bootstrap():
    try:
        payload = compose_bootstrap(secrets.token_urlsafe(18))
    except _BootstrapError as exc:
        _log.warning("desktop bootstrap refused: %s", exc)
        return _no_store({"detail": f"Desktop bootstrap unavailable ({exc})"}, 503)
    return _no_store(payload)


def _asset_not_found() -> JSONResponse:
    return _no_store({"detail": "Not found"}, 404)


@router.get("/desktop-asset")
def desktop_asset(path: str = Query(default="")):
    # Validate by hand: framework validation errors would echo the supplied value.
    if (not path or len(path) > MAX_ASSET_PATH or not _ASSET_PATH_RE.match(path)
            or any(p.startswith(".") for p in path.split("/"))):
        return _asset_not_found()
    try:
        data, digest = _safe_file(path, limit=MAX_ASSET_BYTES)
    except (OSError, ValueError):
        return _asset_not_found()
    # MIME is decided from content, not the extension: signature + IHDR chunk.
    if not data.startswith(_PNG_MAGIC) or data[12:16] != b"IHDR":
        return _asset_not_found()
    return _no_store({"mime": "image/png", "base64": base64.b64encode(data).decode("ascii"),
                      "sha256": digest})
