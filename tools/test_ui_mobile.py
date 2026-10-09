"""Exercise the real plugin allowlist without reading operator data."""
import hashlib
import importlib.util
import unittest
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("quest_ui_api", ROOT / "dashboard/plugin_api.py")
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)
app = FastAPI()
app.include_router(api.router, prefix="/api/plugins/hermes-quest")
client = TestClient(app)
class PluginStaticTests(unittest.TestCase):
    def test_exact_assets_and_font_mime(self):
        assets = ["index.html", "game.js", "npcs.js", "font.js", "ui-glyphs.js", "ui-panels.js",
                  "assets/fonts/NotoSansThai-Regular.otf", "assets/px/ui/font-5x7.png",
                  "assets/px/ui/icons-16.png", "assets/px/ui/atlas.json"]
        for asset in assets:
            with self.subTest(asset=asset):
                response = client.get("/api/plugins/hermes-quest/static/" + asset)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(hashlib.sha256(response.content).digest(),
                                 hashlib.sha256((ROOT / asset).read_bytes()).digest())
                self.assertEqual(response.headers["x-content-type-options"], "nosniff")
                if asset.endswith(".otf"):
                    self.assertEqual(response.headers["content-type"], "font/otf")

    def test_denied_paths(self):
        for asset in ["data/replay.json", "assets/fonts/OFL.txt", "assets/fonts/other.otf", "../index.html",
                      "assets/px/../../data/replay.json", "assets//px/ui/atlas.json", "assets\\px\\ui\\atlas.json"]:
            with self.subTest(asset=asset):
                with self.assertRaises(HTTPException) as caught:
                    api._static_target(asset)
                self.assertEqual(caught.exception.status_code, 404)


if __name__ == "__main__":
    unittest.main()
