"""Exercise the real plugin allowlist without reading operator data."""
import hashlib
import importlib.util
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
assets = ["index.html", "game.js", "npcs.js", "font.js", "ui-glyphs.js", "ui-panels.js",
          "assets/fonts/NotoSansThai-Regular.otf", "assets/px/ui/font-5x7.png",
          "assets/px/ui/icons-16.png", "assets/px/ui/atlas.json"]
for asset in assets:
    response = client.get("/api/plugins/hermes-quest/static/" + asset)
    assert response.status_code == 200, (asset, response.status_code)
    assert hashlib.sha256(response.content).digest() == hashlib.sha256((ROOT / asset).read_bytes()).digest()
    assert response.headers["x-content-type-options"] == "nosniff"
    if asset.endswith(".otf"):
        assert response.headers["content-type"] == "font/otf"
for asset in ["data/replay.json", "assets/fonts/OFL.txt", "assets/fonts/other.otf", "../index.html",
              "assets/px/../../data/replay.json", "assets//px/ui/atlas.json", "assets\\px\\ui\\atlas.json"]:
    try:
        api._static_target(asset)
    except HTTPException as error:
        assert error.status_code == 404
    else:
        raise AssertionError("Unexpected allowlist path: " + asset)
print("PASS plugin static: 10 exact-byte assets, font MIME, 7 deny paths")
