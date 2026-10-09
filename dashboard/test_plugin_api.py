"""Run: <Hermes Python> -m unittest discover -s dashboard -p 'test_*.py' -v.

Only synthetic fixtures are extracted; no live Hermes DB or replay is opened.
"""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import urlencode

from fastapi import FastAPI
from fastapi.testclient import TestClient

spec = importlib.util.spec_from_file_location("quest_test_api", Path(__file__).with_name("plugin_api.py"))
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)
PREFIX = "/api/plugins/hermes-quest"

LEGACY = '''
import json, sys
OUT = "data/replay.json"
HOURS = float(sys.argv[1]) if len(sys.argv) > 1 else 12
T0 = 0

def main():
    print("legacy diagnostic")
    with open(OUT, "w") as f:
        json.dump({"meta": {"hours": HOURS, "from_": T0},
                   "bots": [], "tasks": [], "events": []}, f)
'''
MODERN = '''
from dataclasses import dataclass
@dataclass
class Config:
    path: str | None

def load_config(path=None):
    print("config diagnostic")
    return Config(path)

def build_replay(cfg, hours):
    return {"meta": {"source": "synthetic", "config": cfg.path, "hours": hours},
            "bots": [], "tasks": [], "events": [], "cursor": "replay-cursor"}

def collect_since(cfg, cursor):
    return {"events": [{"t": 1, "kind": "tool"}], "cursor": "next-cursor",
            "received": cursor, "meta": {"source": "synthetic"}}
'''


class QuestAPItests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="quest-api-test-")
        self.root = Path(self.temp.name)
        self.root_patch = patch.object(api, "ROOT", self.root)
        self.root_patch.start()
        self.env_patch = patch.dict(os.environ, {"HERMES_QUEST_CONFIG": "synthetic-config.json"})
        self.env_patch.start()
        self.put("tools/extract.py", MODERN)
        for path in ["index.html", "game.js", "npcs.js", "data/world.json", "assets/px/heroes/warrior.png",
                     "assets/px/heroes.json", "assets/sprites/monsters.json"]:
            self.put(path, "{}")
        self.put("data/replay.json", "PRIVATE REPLAY SENTINEL")
        self.put("assets/raw/private.png", "PRIVATE RAW SENTINEL")
        self.app = FastAPI()
        self.app.include_router(api.router, prefix=PREFIX)
        self.client = TestClient(self.app)

    def tearDown(self):
        self.client.close()
        self.env_patch.stop()
        self.root_patch.stop()
        self.temp.cleanup()

    def put(self, path, text):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
        return target

    def test_modern_replay_config_and_hours(self):
        response = self.client.get(PREFIX + "/replay?hours=2.5")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["meta"], {
            "source": "synthetic", "config": "synthetic-config.json", "hours": 2.5})
        self.assertEqual(response.json()["cursor"], "replay-cursor")
        self.assertEqual(response.headers["cache-control"], "no-store")

    def test_modern_events_opaque_cursor(self):
        cursor = 'opaque:1/"β"'
        response = self.client.get(PREFIX + "/events", params={"since": cursor})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["received"], cursor)
        self.assertEqual(response.json()["cursor"], "next-cursor")
        self.assertEqual(len(response.json()["events"]), 1)
        self.assertEqual(response.headers["cache-control"], "no-store")

    def test_initial_events_pass_none(self):
        self.assertIsNone(self.client.get(PREFIX + "/events").json()["received"])

    def test_legacy_replay_only_writes_temporary_output(self):
        self.put("tools/extract.py", LEGACY)
        response = self.client.get(PREFIX + "/replay?hours=3")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["state"], "legacy-fallback")
        self.assertEqual(payload["meta"]["hours"], 3)
        self.assertGreater(payload["meta"]["from_"], 0)
        self.assertFalse(payload["meta"]["incremental"])
        self.assertIn("privacy", payload["warning"])
        self.assertEqual((self.root / "data/replay.json").read_text(), "PRIVATE REPLAY SENTINEL")

    def test_legacy_events_do_not_call_main(self):
        self.put("tools/extract.py", LEGACY + '\ndef main():\n    raise RuntimeError("must not run")\n')
        response = self.client.get(PREFIX + "/events?since=keep-me")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["events"], [])
        self.assertEqual(payload["cursor"], "keep-me")
        self.assertEqual(payload["state"], "legacy-fallback")

    def test_extraction_failure_is_sanitized(self):
        self.put("tools/extract.py", 'raise RuntimeError("/private/path/secret")')
        response = self.client.get(PREFIX + "/replay")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"detail": "Quest data is unavailable"})

    def test_invalid_payload_and_timeout_are_sanitized(self):
        self.put("tools/extract.py", MODERN + '\ndef build_replay(cfg, hours):\n    return []\n')
        self.assertEqual(self.client.get(PREFIX + "/replay").status_code, 503)
        with patch.object(api.subprocess, "run", side_effect=subprocess.TimeoutExpired("private", 30)):
            self.assertEqual(self.client.get(PREFIX + "/events").status_code, 503)

    def test_parameter_bounds(self):
        for hours in ["0", "-1", "169", "nan", "inf", "invalid"]:
            with self.subTest(hours=hours):
                self.assertEqual(self.client.get(PREFIX + "/replay", params={"hours": hours}).status_code, 422)
        self.assertEqual(self.client.get(PREFIX + "/events", params={"since": "x" * 20000}).status_code, 200)
        self.assertEqual(self.client.get(PREFIX + "/events", params={"since": "x" * 32769}).status_code, 422)

    def test_decoded_cursor_utf8_byte_bounds(self):
        # Exercise FastAPI itself: percent-encoding a 32 KiB UTF-8 cursor can
        # exceed the test client's own URL cap before it reaches the route.
        def request(cursor):
            async def invoke():
                messages = []
                async def receive():
                    return {"type": "http.request", "body": b"", "more_body": False}
                async def send(message):
                    messages.append(message)
                await self.app({"type": "http", "http_version": "1.1", "method": "GET",
                    "scheme": "http", "path": PREFIX + "/events", "headers": [],
                    "query_string": urlencode({"since": cursor}).encode()}, receive, send)
                status = next(m["status"] for m in messages if m["type"] == "http.response.start")
                body = b"".join(m.get("body", b"") for m in messages if m["type"] == "http.response.body")
                return status, json.loads(body)
            return asyncio.run(invoke())
        for cursor in ["x" * 32768, "β" * 16384, "😀" * 8192, "β" * 16383 + "x"]:
            with self.subTest(bytes=len(cursor.encode("utf-8"))):
                status, payload = request(cursor)
                self.assertEqual(status, 200)
                self.assertEqual(payload["received"], cursor)
        with patch.object(api, "_extract") as extract:
            for cursor in ["x" * 32769, "β" * 16384 + "x", "β" * 16385, "😀" * 8192 + "x"]:
                with self.subTest(bytes=len(cursor.encode("utf-8"))):
                    self.assertEqual(request(cursor)[0], 422)
            extract.assert_not_called()

    def test_allowed_static_paths(self):
        for path in ["index.html", "game.js", "npcs.js", "data/world.json", "assets/px/heroes/warrior.png",
                     "assets/px/heroes.json", "assets/sprites/monsters.json"]:
            with self.subTest(path=path):
                response = self.client.get(PREFIX + "/static/" + path)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.headers["x-content-type-options"], "nosniff")
        self.assertIn("application/javascript", self.client.get(PREFIX + "/static/game.js").headers["content-type"])
        npc = self.client.get(PREFIX + "/static/npcs.js")
        self.assertIn("application/javascript", npc.headers["content-type"])
        self.assertEqual(npc.headers["cache-control"], "no-store")

    def test_private_static_paths_and_traversal_denied(self):
        paths = ["data/replay.json", "data/demo.json", "assets/raw/private.png", "tools/extract.py",
                 "dashboard/plugin_api.py", ".git/config", "assets/sprites/heroes.json",
                 "assets/px/foo.py", "assets/px/.private.json", "assets/px/../raw/private.png",
                 "../index.html", "/index.html", "assets//px/heroes.json", "assets\\px\\heroes.json"]
        for path in paths:
            with self.subTest(path=path):
                with self.assertRaises(api.HTTPException) as caught:
                    api._static_target(path)
                self.assertEqual(caught.exception.status_code, 404)
        for path in ["data/replay.json", "assets/raw/private.png", "tools/extract.py",
                     "assets/px/%2e%2e/raw/private.png", "assets/px/%252e%252e/raw/private.png"]:
            self.assertEqual(self.client.get(PREFIX + "/static/" + path).status_code, 404)

    def test_symlinks_to_private_files_and_directories_denied(self):
        (self.root / "assets/px/leak.json").symlink_to(self.root / "data/replay.json")
        (self.root / "assets/px/alias").symlink_to(self.root / "assets/raw", target_is_directory=True)
        (self.root / "assets/px/external.json").symlink_to(Path(__file__).resolve())
        for path in ["assets/px/leak.json", "assets/px/alias/private.png", "assets/px/external.json"]:
            self.assertEqual(self.client.get(PREFIX + "/static/" + path).status_code, 404)

    def test_missing_assets_and_mutating_methods(self):
        self.assertEqual(self.client.get(PREFIX + "/static/assets/px/missing.png").status_code, 404)
        for path in ["/replay", "/events", "/static/index.html"]:
            self.assertEqual(self.client.post(PREFIX + path).status_code, 405)


if __name__ == "__main__":
    unittest.main()
