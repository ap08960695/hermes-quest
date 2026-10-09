"""Read-only Hermes Quest API, mounted by Hermes at /api/plugins/hermes-quest.

The host's authentication applies to these routes. No server, database writer, or
broad StaticFiles mount is created here. Extraction runs in an isolated process:
legacy module-level argv handling and mutable globals cannot affect the host.
"""
from __future__ import annotations

import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import sys

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse

router = APIRouter()
ROOT = Path(__file__).resolve().parent.parent
EXTRACT_TIMEOUT = 30

# This wrapper imports the extractor by absolute path, with no sys.path changes.
# It also supports the pre-M3 extractor without ever touching data/replay.json.
_EXTRACT = r'''
import contextlib, importlib.util, json, os, pathlib, sys, tempfile, time
path, mode, value = sys.argv[1:4]
sys.argv = [path, value if mode == "replay" else "12"]
with contextlib.redirect_stdout(sys.stderr):
    spec = importlib.util.spec_from_file_location("hermes_quest_extractor", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    modern = all(callable(getattr(module, name, None)) for name in
                 ("load_config", "build_replay", "collect_since"))
    if modern:
        cfg = module.load_config(os.environ.get("HERMES_QUEST_CONFIG") or None)
        payload = (module.build_replay(cfg, float(value)) if mode == "replay"
                   else module.collect_since(cfg, value or None))
    elif mode == "events":
        payload = {"events": [], "tasks": [], "bots": [], "cursor": value, "state": "legacy-fallback",
                   "meta": {"source": "live", "incremental": False},
                   "warning": "Incremental events require the M3 extractor; reload replay for a new snapshot."}
    else:
        with tempfile.TemporaryDirectory(prefix="hermes-quest-") as scratch:
            module.OUT = str(pathlib.Path(scratch) / "replay.json")
            module.HOURS = float(value)
            module.T0 = time.time() - module.HOURS * 3600
            module.main()
            payload = json.loads(pathlib.Path(module.OUT).read_text())
        payload["state"] = "legacy-fallback"
        payload["cursor"] = "legacy:" + str(payload.get("meta", {}).get("generated", time.time()))
        payload.setdefault("meta", {}).update(source="live", incremental=False)
        payload["warning"] = "Legacy snapshot: M3 privacy/configuration support is not available yet."
if not isinstance(payload, dict):
    raise ValueError("Extractor must return an object")
print(json.dumps(payload, ensure_ascii=False, allow_nan=False))
'''


def _extract(mode: str, value: str) -> dict:
    try:
        result = subprocess.run(
            [sys.executable, "-c", _EXTRACT, str(ROOT / "tools" / "extract.py"), mode, value],
            cwd=ROOT, env=os.environ.copy(), capture_output=True, text=True,
            timeout=EXTRACT_TIMEOUT, check=True,
        )
        payload = json.loads(result.stdout)
        if not isinstance(payload, dict):
            raise ValueError("Invalid extractor payload")
        return payload
    except (OSError, subprocess.SubprocessError, ValueError):
        # Do not expose stderr: it can contain private paths, DB details, or data.
        raise HTTPException(status_code=503, detail="Quest data is unavailable") from None


@router.get("/replay")
def replay(hours: float = Query(default=12, gt=0, le=168)):
    return JSONResponse(_extract("replay", str(hours)), headers={"Cache-Control": "no-store"})


@router.get("/events")
def events(since: str = Query(default="", max_length=32768)):
    # Query max_length counts characters, not the decoded opaque cursor's bytes.
    if len(since.encode("utf-8")) > 32768:
        raise HTTPException(status_code=422, detail="Cursor exceeds 32 KiB UTF-8")
    return JSONResponse(_extract("events", since), headers={"Cache-Control": "no-store"})


def _static_target(asset_path: str) -> Path:
    # Reject traversal before normalization; only literal POSIX URL paths exist.
    parts = asset_path.split("/")
    if not asset_path or "\\" in asset_path or any(p in ("", ".", "..") for p in parts):
        raise HTTPException(status_code=404, detail="Not found")
    relative = PurePosixPath(asset_path)
    allowed = asset_path in {
        "index.html", "game.js", "npcs.js", "font.js", "ui-glyphs.js", "ui-panels.js",
        "assets/fonts/NotoSansThai-Regular.otf", "data/world.json", "assets/sprites/monsters.json"
    } or (
        len(parts) >= 3 and parts[:2] == ["assets", "px"]
        and relative.suffix.lower() in {".png", ".json"}
        and not any(p.startswith(".") for p in parts)
    )
    if not allowed:
        raise HTTPException(status_code=404, detail="Not found")
    # Even a symlink *inside* assets/px could point to replay or another private
    # in-repo path. Reject every symlink component, not just escapes from ROOT.
    target = ROOT
    for part in parts:
        target = target / part
        if target.is_symlink():
            raise HTTPException(status_code=404, detail="Not found")
    try:
        resolved = target.resolve(strict=True)
        resolved.relative_to(ROOT.resolve())
        if not resolved.is_file():
            raise ValueError("Not a file")
    except (OSError, ValueError, RuntimeError):
        raise HTTPException(status_code=404, detail="Not found") from None
    return resolved


@router.get("/static/{asset_path:path}")
def static_asset(asset_path: str):
    target = _static_target(asset_path)
    media_type = {".html": "text/html", ".js": "application/javascript",
                  ".json": "application/json", ".png": "image/png", ".otf": "font/otf"}[target.suffix.lower()]
    return FileResponse(target, media_type=media_type, headers={
        "Cache-Control": "no-store" if target.suffix in {".html", ".js"} else "public, max-age=60",
        "X-Content-Type-Options": "nosniff",
    })
