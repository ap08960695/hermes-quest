"""Run: python3 -m unittest dashboard.test_desktop_transport -v  (needs fastapi + httpx).

Synthetic fixtures only: a temporary package root is built per test from the real
index.html/scripts/PNG shapes. No replay, preview or raw-art file is read, and
the guest bridge is a stand-in fixture because desktop/guest-bridge.js lives in a
sibling branch.
"""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
from urllib.parse import quote

from fastapi import FastAPI
from fastapi.testclient import TestClient

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
spec = importlib.util.spec_from_file_location("quest_test_desktop_transport", HERE / "desktop_transport.py")
transport = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transport)

PREFIX = "/api/plugins/hermes-quest"
BRIDGE_FIXTURE = "/* fixture guest bridge */\nwindow.__questBridge = true;\n"
# Smallest well-formed PNG signature + IHDR + IEND shape (1x1); contents are synthetic.
PNG = (b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00"
       b"\x1f\x15\xc4\x89\x00\x00\x00\x00IEND\xaeB`\x82")
SECRET = b"REAL-DATA-MARKER-must-never-be-served"
TOKEN = "synthetic-host-token"


def make_app(root_dir):
    """Mimic the host: every plugin route sits behind the dashboard's auth gate."""
    app = FastAPI()

    @app.middleware("http")
    async def auth(request, call_next):
        if request.headers.get("x-hermes-session-token") != TOKEN:
            from fastapi.responses import JSONResponse
            return JSONResponse({"detail": "Unauthorized"}, status_code=401)
        return await call_next(request)

    app.include_router(transport.router, prefix=PREFIX)
    return app


class Base(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="quest-transport-test-")
        self.root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)
        for name in ("index.html", *transport.SCRIPT_ORDER):
            (self.root / name).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(REPO / name, self.root / name)
        (self.root / "desktop").mkdir()
        (self.root / "desktop" / "guest-bridge.js").write_text(BRIDGE_FIXTURE, encoding="utf-8")
        for rel, data in {"assets/px/ground.png": PNG, "assets/px/heroes/warrior-Model.png": PNG,
                          "assets/px/data.json": b"{}"}.items():
            self.write(rel, data)
        # Things that must never leave through this transport.
        self.write("data/replay.json", SECRET)
        self.write("preview/shot.png", PNG + SECRET)
        self.write("assets/raw/sheet.png", PNG + SECRET)
        self.write("config.yaml", SECRET)
        patcher = patch.object(transport, "ROOT", self.root)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.client = TestClient(make_app(self.root), headers={"x-hermes-session-token": TOKEN})

    def write(self, rel, data):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data if isinstance(data, bytes) else data.encode("utf-8"))

    def set_index(self, text):
        self.write("index.html", text)

    def index_text(self):
        return (self.root / "index.html").read_text(encoding="utf-8")

    def bootstrap(self):
        return self.client.get(f"{PREFIX}/desktop-bootstrap")

    def asset(self, path):
        return self.client.get(f"{PREFIX}/desktop-asset", params={"path": path})

    def assert_closed(self, response, reason=None):
        self.assertEqual(response.status_code, 503, response.text)
        self.assertNotIn("html", response.json())
        if reason:
            self.assertIn(reason, response.json()["detail"])
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertNotIn(str(self.root), response.text)


class RouterShapeTests(unittest.TestCase):
    def test_only_get_routes_and_expected_paths(self):
        app = FastAPI()
        app.include_router(transport.router)
        paths = app.openapi()["paths"]
        self.assertEqual({k: sorted(v) for k, v in paths.items()},
                         {"/desktop-bootstrap": ["get"], "/desktop-asset": ["get"]})

    def test_router_is_includable_later_without_side_effects(self):
        app = FastAPI()
        app.include_router(transport.router, prefix=PREFIX)
        paths = set(app.openapi()["paths"])
        self.assertEqual(paths, {f"{PREFIX}/desktop-bootstrap", f"{PREFIX}/desktop-asset"})


class AuthAndMethodTests(Base):
    def test_unauthenticated_requests_are_rejected_by_host_gate(self):
        anonymous = TestClient(make_app(self.root))
        for url in (f"{PREFIX}/desktop-bootstrap", f"{PREFIX}/desktop-asset?path=assets/px/ground.png"):
            response = anonymous.get(url)
            self.assertEqual(response.status_code, 401)
            self.assertNotIn("html", response.text)
            self.assertNotIn("base64", response.text)

    def test_only_get_is_allowed(self):
        for method in ("post", "put", "patch", "delete"):
            for url in (f"{PREFIX}/desktop-bootstrap", f"{PREFIX}/desktop-asset?path=assets/px/ground.png"):
                response = getattr(self.client, method)(url)
                self.assertEqual(response.status_code, 405, (method, url))
        self.assertEqual(self.client.options(f"{PREFIX}/desktop-bootstrap").status_code, 405)


class BootstrapTests(Base):
    def test_shape_no_store_and_digests(self):
        response = self.bootstrap()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertEqual(response.headers["x-content-type-options"], "nosniff")
        body = response.json()
        self.assertEqual(set(body), {"version", "nonce", "html", "source"})
        self.assertEqual(body["version"], 1)
        self.assertRegex(body["nonce"], r"^[A-Za-z0-9_-]{20,}$")
        expected = {"index.html", "desktop/guest-bridge.js", *transport.SCRIPT_ORDER}
        self.assertEqual(set(body["source"]), expected)
        for name, digest in body["source"].items():
            data = (self.root / name).read_bytes()
            self.assertEqual(digest, hashlib.sha256(data).hexdigest(), name)

    def test_nonce_is_fresh_per_request_and_in_document(self):
        first, second = self.bootstrap().json(), self.bootstrap().json()
        self.assertNotEqual(first["nonce"], second["nonce"])
        self.assertIn(f'<meta name="quest-nonce" content="{first["nonce"]}">', first["html"])

    def test_csp_is_first_thing_in_head(self):
        html = self.bootstrap().json()["html"]
        head = html.index("<head>") + len("<head>")
        csp = f'<meta http-equiv="Content-Security-Policy" content="{transport.GUEST_CSP}">'
        self.assertTrue(html[head:].startswith(csp))
        for fragment in ("default-src 'none'", "connect-src 'none'", "img-src data:",
                         "base-uri 'none'", "form-action 'none'", "script-src 'unsafe-inline'"):
            self.assertIn(fragment, transport.GUEST_CSP)
        # The policy precedes every script and every other element of the document.
        self.assertLess(html.index("Content-Security-Policy"), html.index("<meta charset"))
        self.assertLess(html.index("Content-Security-Policy"), html.index("<script>"))

    def test_scripts_are_inlined_in_original_order_with_bridge_first(self):
        html = self.bootstrap().json()["html"]
        self.assertNotRegex(html, r"<script\s+src=")
        markers = [BRIDGE_FIXTURE.strip()] + [(self.root / n).read_text(encoding="utf-8") for n in transport.SCRIPT_ORDER]
        positions = [html.index(m) for m in markers]
        self.assertEqual(positions, sorted(positions))
        self.assertEqual(html.count("<script>"), len(markers))
        # Script bytes are preserved verbatim.
        for name in transport.SCRIPT_ORDER:
            self.assertIn(f"<script>{(self.root / name).read_text(encoding='utf-8')}</script>", html)

    def test_body_markup_outside_scripts_is_unchanged(self):
        html = self.bootstrap().json()["html"]
        stripped = re.sub(r"<script>.*?</script>", "", html, flags=re.S)
        stripped = re.sub(r'<meta http-equiv="Content-Security-Policy"[^>]*><meta name="quest-nonce"[^>]*>', "", stripped)
        original = re.sub(r'<script src="[^"]*"></script>', "", self.index_text())
        self.assertEqual(stripped, original)

    def test_real_package_index_is_accepted(self):
        # The shipped index.html and script list must compose (no unexpected asset).
        with patch.object(transport, "ROOT", REPO) as _:
            if not (REPO / transport.BRIDGE).is_file():
                self.skipTest("desktop/guest-bridge.js is not in this branch")
            self.assertEqual(self.client.get(f"{PREFIX}/desktop-bootstrap").status_code, 200)

    def test_scripts_listed_in_order_constant_match_real_index(self):
        names = re.findall(r'<script src="([^"]+)"></script>', (REPO / "index.html").read_text(encoding="utf-8"))
        self.assertEqual(names, list(transport.SCRIPT_ORDER))

    def test_unknown_script_fails_closed(self):
        for injected in ('<script src="evil.js"></script>',
                         '<script src="https://example.invalid/x.js"></script>',
                         '<script src="../config.yaml"></script>',
                         '<script src="data:text/javascript,alert(1)"></script>'):
            self.set_index(self.index_text().replace('<script src="game.js"></script>', injected + '<script src="game.js"></script>'))
            self.assert_closed(self.bootstrap(), "unexpected_script")
            shutil.copyfile(REPO / "index.html", self.root / "index.html")

    def test_inline_and_attribute_scripts_fail_closed(self):
        base = self.index_text()
        cases = {
            "inline script": base.replace("</body>", "<script>alert(1)</script></body>"),
            "typed script": base.replace('<script src="game.js">', '<script type="module" src="game.js">'),
            "onload handler": base.replace("<body>", '<body onload="x()">'),
            "onclick": base.replace('id="play"', 'id="play" onclick="x()"'),
        }
        for label, text in cases.items():
            with self.subTest(label):
                self.set_index(text)
                self.assertEqual(self.bootstrap().status_code, 503)

    def test_script_order_violation_and_duplicates_fail_closed(self):
        base = self.index_text()
        swapped = base.replace('<script src="npcs.js"></script>', '<script src="__swap__.js"></script>')
        swapped = swapped.replace('<script src="game.js"></script>', '<script src="npcs.js"></script>')
        swapped = swapped.replace('<script src="__swap__.js"></script>', '<script src="game.js"></script>')
        self.assertNotEqual(swapped, base)
        self.set_index(swapped)
        self.assert_closed(self.bootstrap(), "script_order")
        self.set_index(base.replace("</body>", '<script src="game.js"></script></body>'))
        self.assert_closed(self.bootstrap(), "unexpected_script")

    def test_missing_game_script_reference_fails_closed(self):
        self.set_index(self.index_text().replace('<script src="game.js"></script>', ""))
        self.assert_closed(self.bootstrap(), "script_order")

    def test_external_references_fail_closed(self):
        base = self.index_text()
        cases = {
            "stylesheet": base.replace("</head>", '<link rel="stylesheet" href="x.css"></head>'),
            "remote icon": base.replace('href="data:,"', 'href="https://example.invalid/i.ico"'),
            "image": base.replace("</body>", '<img src="x.png"></body>'),
            "iframe": base.replace("</body>", '<iframe src="x"></iframe></body>'),
            "base": base.replace("</head>", '<base href="https://example.invalid/"></head>'),
            "form": base.replace("</body>", '<form action="x"></form></body>'),
            "css import": base.replace("<style>", "<style>@import url(x.css);"),
            "css url": base.replace("<style>", "<style>body{background:url(x.png)}"),
            "inline style url": base.replace('id="play"', 'id="play" style="background:url(x)"'),
            "meta csp": base.replace("</head>", '<meta http-equiv="Content-Security-Policy" content="default-src *"></head>'),
            "forged nonce": base.replace("</head>", '<meta name="quest-nonce" content="forged"></head>'),
        }
        for label, text in cases.items():
            with self.subTest(label):
                self.assertNotEqual(text, base)
                self.set_index(text)
                self.assert_closed(self.bootstrap(), "unexpected_reference")

    def test_unsafe_script_content_is_refused_not_rewritten(self):
        for payload in ("var s='</script><script>evil()</script>';", "var s='</SCRIPT >';", "var s='<!--';"):
            self.write("npcs.js", payload)
            self.assert_closed(self.bootstrap(), "unsafe_script")

    def test_missing_files_fail_closed_without_paths(self):
        for rel, reason in (("desktop/guest-bridge.js", "missing_bridge"), ("game.js", "missing_script"),
                            ("index.html", "missing_index")):
            with self.subTest(rel):
                backup = (self.root / rel).read_bytes()
                (self.root / rel).unlink()
                self.assert_closed(self.bootstrap(), reason)
                self.write(rel, backup)
        self.assertEqual(self.bootstrap().status_code, 200)

    def test_symlinked_source_is_refused(self):
        outside = self.root / "outside.js"
        outside.write_text("window.leak=1", encoding="utf-8")
        (self.root / "npcs.js").unlink()
        os.symlink(outside, self.root / "npcs.js")
        self.assert_closed(self.bootstrap(), "missing_script")
        (self.root / "npcs.js").unlink()
        shutil.copyfile(REPO / "npcs.js", self.root / "npcs.js")
        (self.root / "desktop" / "guest-bridge.js").unlink()
        os.symlink(outside, self.root / "desktop" / "guest-bridge.js")
        self.assert_closed(self.bootstrap(), "missing_bridge")

    def test_oversized_source_and_document_fail_closed(self):
        with patch.object(transport, "MAX_SOURCE_BYTES", 100):
            self.assert_closed(self.bootstrap())
        with patch.object(transport, "MAX_BOOTSTRAP_BYTES", 1000):
            self.assert_closed(self.bootstrap(), "too_large")

    def test_non_utf8_source_fails_closed(self):
        self.write("game.js", b"\xff\xfe\x00bad")
        self.assert_closed(self.bootstrap(), "missing_script")

    def test_no_real_data_files_leak_into_document(self):
        text = self.bootstrap().text
        self.assertNotIn(SECRET.decode(), text)
        self.assertNotIn("replay.json\"", text.split("<script>")[0])


class MalformedHeadTests(Base):
    """The CSP must land where a browser starts <head>. Markup whose head the
    browser would place elsewhere is refused before composing, never patched."""

    def swap(self, old, new):
        base = self.index_text()
        self.assertIn(old, base)
        self.set_index(base.replace(old, new, 1))

    def test_noncanonical_documents_fail_closed(self):
        base = self.index_text()
        body_open = base.index("<body>")
        head_open = base.index("<head>")
        head_block = base[head_open:body_open]
        cases = {
            "comment containing <head> before real head": base.replace("<head>", "<!-- <head> --><head>", 1),
            "comment before doctype": "<!-- <head> -->" + base,
            "comment inside body": base.replace("<body>", "<body><!-- x -->", 1),
            "body before head": base[:head_open] + base[body_open:].replace("<body>", "<body>" + head_block.replace("\n", ""), 1),
            "no head at all": base.replace(head_block, "", 1),
            "duplicate head": base.replace("</head>", "</head><head></head>", 1),
            "second head in body": base.replace("<body>", "<body><head></head>", 1),
            "div inside head": base.replace("</head>", "<div></div></head>", 1),
            "text inside head": base.replace("</head>", "text</head>", 1),
            "text before html": "text" + base,
            "no doctype": base.replace("<!doctype html>", "", 1),
            "legacy doctype": base.replace("<!doctype html>", '<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN">', 1),
            "second body": base.replace("</body>", "</body><body></body>", 1),
            "script before head": base.replace("<head>", '<script src="font.js"></script><head>', 1),
            "script inside head": base.replace("<head>", '<head><script src="font.js"></script>', 1).replace(
                '<script src="font.js"></script>\n<script src="ui-glyphs.js">', '<script src="ui-glyphs.js">', 1),
            "cdata": base.replace("<body>", "<body><![CDATA[ x ]]>", 1),
            "processing instruction": base.replace("<body>", "<body><?x y?>", 1),
            "template": base.replace("<body>", "<body><template></template>", 1),
            "svg": base.replace("<body>", "<body><svg></svg>", 1),
            "noscript": base.replace("<body>", "<body><noscript></noscript>", 1),
            "html missing": base.replace("<html lang=\"th\">", "", 1).replace("</html>", "", 1),
            "unterminated head": base.replace("</head>", "", 1),
            "truncated document": base[:base.index("<script")],
            "title with markup": base.replace("<title>Hermes Quest</title>", "<title><head></title>", 1),
        }
        for label, text in cases.items():
            with self.subTest(label):
                self.assertNotEqual(text, base, label)
                self.set_index(text)
                response = self.bootstrap()
                self.assertEqual(response.status_code, 503, label)
                self.assertNotIn("html", response.json())
                self.assertEqual(response.headers["cache-control"], "no-store")

    def test_head_with_attributes_and_case_gets_csp_first(self):
        base = self.index_text()
        for opening in ('<head lang="th">', "<HEAD>", '<head\n  data-x="a>b">'):
            with self.subTest(opening=opening):
                self.set_index(base.replace("<head>", opening, 1))
                response = self.bootstrap()
                self.assertEqual(response.status_code, 200, response.text)
                html = response.json()["html"]
                csp = f'<meta http-equiv="Content-Security-Policy" content="{transport.GUEST_CSP}">'
                at = html.index(opening) + len(opening)
                self.assertTrue(html[at:].startswith(csp))
                # Nothing executable or active precedes the policy.
                self.assertNotIn("<script", html[:at].lower())

    def test_csp_precedes_every_script_and_is_inside_head(self):
        html = self.bootstrap().json()["html"]
        csp = html.index("Content-Security-Policy")
        self.assertLess(html.index("<head>"), csp)
        self.assertLess(csp, html.index("</head>"))
        self.assertLess(csp, html.index("<script"))
        self.assertEqual(html.count("Content-Security-Policy"), 1)


def _chrome():
    return shutil.which("google-chrome") or shutil.which("chromium") or shutil.which("chromium-browser")


@unittest.skipUnless(_chrome(), "Chromium/Chrome is not installed")
class BrowserCspTests(Base):
    """A real browser parses each accepted bootstrap in an opaque-origin sandbox
    and its game script tries a synthetic loopback request: the effective CSP
    must block it. Loopback only; nothing real is read."""

    def run_case(self, index_text):
        hits = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                hits.append(self.path)
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"synthetic")

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 5)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        port = server.server_address[1]
        self.write("game.js", "fetch('http://127.0.0.1:%d/probe',{mode:'no-cors'}).then(()=>parent.postMessage('NETWORK_ALLOWED','*'),"
                              "()=>parent.postMessage('NETWORK_BLOCKED','*'));"
                              "parent.postMessage('NONCE_'+!!document.querySelector('meta[name=quest-nonce]'),'*');" % port)
        self.set_index(index_text)
        response = self.bootstrap()
        self.assertEqual(response.status_code, 200, response.text)
        guest = "data:text/html;charset=utf-8," + quote(response.json()["html"], safe="") + "?live=1"
        outer = ('<!doctype html><html><body><pre id="result"></pre><script>addEventListener("message",'
                 'e=>document.getElementById("result").textContent+=e.data+";")</script>'
                 '<iframe sandbox="allow-scripts" src="%s"></iframe></body></html>' % guest)
        fixture = self.root / "outer.html"
        fixture.write_text(outer, encoding="utf-8")
        profile = tempfile.mkdtemp(prefix="quest-chrome-", dir=self.root)
        done = subprocess.run([_chrome(), "--headless", "--disable-gpu", "--no-sandbox", "--no-first-run",
                               "--no-default-browser-check", "--user-data-dir=" + profile,
                               "--virtual-time-budget=3000", "--dump-dom", fixture.as_uri()],
                              capture_output=True, text=True, timeout=45)
        self.assertEqual(done.returncode, 0, done.stderr[:500])
        match = re.search(r'<pre id="result">(.*?)</pre>', done.stdout, re.S)
        return (match.group(1) if match else ""), len(hits)

    def test_effective_csp_blocks_network_for_every_accepted_head_shape(self):
        base = self.index_text()
        for label, text in {"canonical": base,
                            "head attributes": base.replace("<head>", '<head lang="th">', 1),
                            "uppercase head": base.replace("<head>", "<HEAD>", 1).replace("</head>", "</HEAD>", 1)}.items():
            with self.subTest(label):
                messages, requests = self.run_case(text)
                self.assertIn("NETWORK_BLOCKED", messages)
                self.assertNotIn("NETWORK_ALLOWED", messages)
                self.assertIn("NONCE_true", messages)
                self.assertEqual(requests, 0)

    def test_head_confused_documents_never_reach_the_browser(self):
        base = self.index_text()
        for label, text in {"comment head": base.replace("<head>", "<!-- <head> --><head>", 1),
                            "body before head": "<!doctype html><html><body><head></head>"
                                                '<script src="game.js"></script></body></html>'}.items():
            with self.subTest(label):
                self.set_index(text)
                self.assertEqual(self.bootstrap().status_code, 503)


class AssetTests(Base):
    def test_returns_png_envelope_with_hash_and_no_store(self):
        response = self.asset("assets/px/ground.png")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.headers["cache-control"], "no-store")
        body = response.json()
        self.assertEqual(set(body), {"mime", "base64", "sha256"})
        self.assertEqual(body["mime"], "image/png")
        self.assertEqual(base64.b64decode(body["base64"], validate=True), PNG)
        self.assertEqual(body["sha256"], hashlib.sha256(PNG).hexdigest())
        self.assertEqual(self.asset("assets/px/heroes/warrior-Model.png").status_code, 200)

    def test_real_shipped_ground_png_fits_the_limit(self):
        ground = REPO / "assets" / "px" / "ground.png"
        self.assertLessEqual(ground.stat().st_size, transport.MAX_ASSET_BYTES)
        shutil.copyfile(ground, self.root / "assets" / "px" / "ground.png")
        body = self.asset("assets/px/ground.png").json()
        self.assertEqual(body["sha256"], hashlib.sha256(ground.read_bytes()).hexdigest())

    def test_traversal_encoded_and_unusual_paths_are_404(self):
        bad = ["", "assets/px/../../data/replay.json", "../config.yaml", "assets/px/%2e%2e/ground.png",
               "assets%2fpx%2fground.png", "assets/px/./ground.png", "/assets/px/ground.png",
               "assets//px/ground.png", "assets/px/ground.png/", "assets\\px\\ground.png",
               "assets/px/ground.png\x00.txt", "assets/px/ground.PNG", "assets/px/ground.png ",
               "assets/px/.hidden.png", "assets/px/.dir/ground.png", "file:///etc/passwd",
               "http://example.invalid/assets/px/ground.png", "assets/px/" + "a" * 300 + ".png"]
        for path in bad:
            with self.subTest(path=path):
                response = self.asset(path)
                self.assertEqual(response.status_code, 404)
                self.assertEqual(response.json(), {"detail": "Not found"})
        for raw in ("assets/px/%2e%2e/%2e%2e/data/replay.json", "..%2f..%2fconfig.yaml",
                    "assets%2Fpx%2F..%2F..%2Fdata%2Freplay.json", "%252e%252e/config.yaml"):
            response = self.client.get(f"{PREFIX}/desktop-asset?path={raw}")
            self.assertEqual(response.status_code, 404, raw)

    def test_private_and_non_allowlisted_files_are_refused(self):
        for path in ("data/replay.json", "preview/shot.png", "assets/raw/sheet.png", "config.yaml",
                     "assets/px/data.json", "assets/road-mask.png", "game.js", "index.html",
                     "assets/fonts/NotoSansThai-Regular.otf", "assets/buildings/castle.png"):
            with self.subTest(path=path):
                response = self.asset(path)
                self.assertEqual(response.status_code, 404)
                self.assertNotIn(SECRET.decode(), response.text)

    def test_missing_param_and_duplicates_never_leak(self):
        self.assertEqual(self.client.get(f"{PREFIX}/desktop-asset").status_code, 404)
        response = self.client.get(f"{PREFIX}/desktop-asset?path=assets/px/ground.png&path=data/replay.json")
        # FastAPI keeps the last value; it must still be gated.
        self.assertEqual(response.status_code, 404)
        self.assertNotIn(SECRET.decode(), response.text)

    def test_symlinks_are_refused_at_every_level(self):
        outside = self.root / "outside.png"
        outside.write_bytes(PNG)
        os.symlink(outside, self.root / "assets" / "px" / "link.png")
        self.assertEqual(self.asset("assets/px/link.png").status_code, 404)
        os.symlink(self.root / "data" / "replay.json", self.root / "assets" / "px" / "replay.png")
        response = self.asset("assets/px/replay.png")
        self.assertEqual(response.status_code, 404)
        self.assertNotIn(SECRET.decode(), response.text)
        # A symlinked directory inside assets/px, and a symlinked assets/px itself.
        real = self.root / "assets" / "px" / "heroes"
        os.symlink(real, self.root / "assets" / "px" / "heroes-link")
        self.assertEqual(self.asset("assets/px/heroes-link/warrior-Model.png").status_code, 404)
        os.symlink(self.root / "preview", self.root / "assets" / "px" / "previewdir")
        self.assertEqual(self.asset("assets/px/previewdir/shot.png").status_code, 404)

    def test_ancestor_swap_between_checks_and_open_cannot_escape_root(self):
        # A writer swaps assets/px for a symlink to an outside directory at each
        # syscall seam in turn (before every os.open of the walk). Whatever the
        # timing, the outside marker must never be served.
        outside_marker = b"SYNTHETIC-OUTSIDE-MARKER"
        outside_png = PNG + outside_marker
        calls = []
        real_open = os.open
        for seam in range(0, 6):
            with self.subTest(seam=seam):
                px = self.root / "assets" / "px"
                outside = Path(tempfile.mkdtemp(prefix="quest-outside-"))
                self.addCleanup(shutil.rmtree, outside, True)
                (outside / "probe.png").write_bytes(outside_png)
                self.write("assets/px/probe.png", PNG)
                state = {"n": 0, "swapped": False}

                def hook(path, flags, *args, **kwargs):
                    if state["n"] == seam and not state["swapped"]:
                        state["swapped"] = True
                        px.rename(self.root / "assets" / "px-original")
                        px.symlink_to(outside, target_is_directory=True)
                    state["n"] += 1
                    return real_open(path, flags, *args, **kwargs)

                try:
                    with patch.object(transport.os, "open", hook):
                        response = self.asset("assets/px/probe.png")
                finally:
                    calls.append(state["n"])
                    if px.is_symlink():
                        px.unlink()
                    original = self.root / "assets" / "px-original"
                    if original.exists():
                        original.rename(px)
                self.assertNotIn(outside_marker.decode(), response.text)
                if response.status_code == 200:
                    self.assertEqual(base64.b64decode(response.json()["base64"]), PNG)
        self.assertGreaterEqual(max(calls), 4)  # root, assets, px, leaf were all walked via os.open

    def test_directory_swap_after_pinning_reads_pinned_original(self):
        # Once assets/px is open, replacing it by a symlink must not redirect the leaf open.
        outside = Path(tempfile.mkdtemp(prefix="quest-outside-"))
        self.addCleanup(shutil.rmtree, outside, True)
        (outside / "probe.png").write_bytes(PNG + b"SYNTHETIC-OUTSIDE-MARKER")
        self.write("assets/px/probe.png", PNG)
        px = self.root / "assets" / "px"
        real_open = os.open

        def hook(path, flags, *args, **kwargs):
            if path == "probe.png":
                px.rename(self.root / "assets" / "px-original")
                px.symlink_to(outside, target_is_directory=True)
            return real_open(path, flags, *args, **kwargs)

        with patch.object(transport.os, "open", hook):
            response = self.asset("assets/px/probe.png")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(base64.b64decode(response.json()["base64"]), PNG)

    def test_walk_uses_descriptors_not_paths(self):
        real_open = os.open
        seen = []

        def hook(path, flags, *args, **kwargs):
            seen.append((os.fspath(path), kwargs.get("dir_fd") is not None, bool(flags & os.O_NOFOLLOW)))
            return real_open(path, flags, *args, **kwargs)

        with patch.object(transport.os, "open", hook):
            self.assertEqual(self.asset("assets/px/heroes/warrior-Model.png").status_code, 200)
        self.assertEqual([name for name, _, _ in seen[1:]], ["assets", "px", "heroes", "warrior-Model.png"])
        self.assertTrue(all(has_dir_fd and nofollow for _, has_dir_fd, nofollow in seen[1:]))

    @unittest.skipUnless(hasattr(os, "mkfifo"), "mkfifo unavailable")
    def test_fifo_without_writer_is_rejected_promptly(self):
        os.mkfifo(self.root / "assets" / "px" / "fifo.png")
        result = {}

        def call():
            result["response"] = self.asset("assets/px/fifo.png")

        worker = threading.Thread(target=call, daemon=True)
        worker.start()
        worker.join(5)
        if worker.is_alive():
            # Unblock a regressed blocking open so the suite can finish, then fail.
            release = os.open(self.root / "assets" / "px" / "fifo.png", os.O_RDWR)
            worker.join(5)
            os.close(release)
            self.fail("FIFO request blocked in open before the regular-file check")
        self.assertEqual(result["response"].status_code, 404)
        self.assertEqual(result["response"].json(), {"detail": "Not found"})
        self.assertEqual(result["response"].headers["cache-control"], "no-store")

    @unittest.skipUnless(hasattr(os, "mkfifo"), "mkfifo unavailable")
    def test_fifo_as_bootstrap_source_is_refused_promptly(self):
        (self.root / "npcs.js").unlink()
        os.mkfifo(self.root / "npcs.js")
        result = {}
        worker = threading.Thread(target=lambda: result.setdefault("r", self.bootstrap()), daemon=True)
        worker.start()
        worker.join(5)
        if worker.is_alive():
            release = os.open(self.root / "npcs.js", os.O_RDWR)
            worker.join(5)
            os.close(release)
            self.fail("FIFO source blocked the bootstrap")
        self.assert_closed(result["r"], "missing_script")

    def test_directory_and_missing_file_are_404(self):
        (self.root / "assets" / "px" / "dir.png").mkdir()
        self.assertEqual(self.asset("assets/px/dir.png").status_code, 404)
        self.assertEqual(self.asset("assets/px/nope.png").status_code, 404)

    def test_mime_is_verified_from_content_not_extension(self):
        self.write("assets/px/fake.png", b"<html>not a png</html>" + b"\x00" * 40)
        self.write("assets/px/short.png", b"\x89PNG")
        self.write("assets/px/svg.png", b"<svg xmlns='http://www.w3.org/2000/svg'/>")
        self.write("assets/px/nosig.png", b"\x89PNG\r\n\x1a\n" + b"\x00" * 40)
        for name in ("fake", "short", "svg", "nosig"):
            with self.subTest(name):
                response = self.asset(f"assets/px/{name}.png")
                self.assertEqual(response.status_code, 404)
                self.assertNotIn("html", response.text.lower())

    def test_size_limit_is_enforced(self):
        with patch.object(transport, "MAX_ASSET_BYTES", len(PNG) - 1):
            self.assertEqual(self.asset("assets/px/ground.png").status_code, 404)
        with patch.object(transport, "MAX_ASSET_BYTES", len(PNG)):
            self.assertEqual(self.asset("assets/px/ground.png").status_code, 200)

    def test_errors_do_not_expose_internal_paths_or_payload(self):
        for path in ("assets/px/nope.png", "../x", "data/replay.json", "assets/px/fake.png"):
            self.write("assets/px/fake.png", b"<html>" + SECRET + b"</html>")
            response = self.asset(path)
            text = response.text
            self.assertNotIn(str(self.root), text)
            self.assertNotIn(self.root.name, text)
            self.assertNotIn(SECRET.decode(), text)
            self.assertNotIn("Traceback", text)


class NoDataLeakTests(unittest.TestCase):
    def test_module_never_references_private_inputs(self):
        source = (HERE / "desktop_transport.py").read_text(encoding="utf-8")
        for forbidden in ("replay.json", "preview/", "assets/raw", "subprocess", "extract.py"):
            self.assertNotIn(forbidden, source)

    def test_asset_pattern_only_admits_assets_px_png(self):
        pattern = transport._ASSET_PATH_RE
        for ok in ("assets/px/ground.png", "assets/px/heroes/warrior-Model.png", "assets/px/npcs/a_b.png"):
            self.assertTrue(pattern.match(ok), ok)
        for bad in ("data/replay.json", "preview/a.png", "assets/raw/a.png", "assets/px/a.json",
                    "assets/px/a.png\n", "assets/px/é.png", "assets/props/a.png"):
            self.assertFalse(pattern.match(bad), bad)


if __name__ == "__main__":
    unittest.main()
