"""Read-only Hermes Quest API, mounted by Hermes at /api/plugins/hermes-quest.

The host's authentication applies to these routes. No server, database writer, or
broad StaticFiles mount is created here. Extraction runs in an isolated process:
legacy module-level argv handling and mutable globals cannot affect the host.
"""
from __future__ import annotations

from contextlib import asynccontextmanager
import atexit
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import sys
import threading
import types

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse

@asynccontextmanager
async def _lifespan(app):
    try:
        yield
    finally:
        # Joining is bounded and must not block the host's event loop.
        import asyncio
        await asyncio.to_thread(_stop_sampler)


router = APIRouter(lifespan=_lifespan)
_desktop_spec = importlib.util.spec_from_file_location("hermes_quest_desktop_transport", Path(__file__).with_name("desktop_transport.py"))
assert _desktop_spec is not None and _desktop_spec.loader is not None
_desktop_module = importlib.util.module_from_spec(_desktop_spec)
_desktop_spec.loader.exec_module(_desktop_module)
router.include_router(_desktop_module.router)
ROOT = Path(__file__).resolve().parent.parent
EXTRACT_TIMEOUT = 30
_sampler = {"lock": threading.Lock(), "key": None, "thread": None, "stop": None, "state": "idle"}

# This wrapper imports the extractor by absolute path, with no sys.path changes.
# It also supports the pre-M3 extractor without ever touching data/replay.json.
_EXTRACT = r'''
import contextlib, importlib.util, json, os, pathlib, sys, tempfile, time
path, mode, value = sys.argv[1:4]
show_profile_names = len(sys.argv) > 4 and sys.argv[4] == "authenticated"
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
        if isinstance(cfg, dict):
            cfg['show_profile_names'] = show_profile_names
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


def _extract(mode: str, value: str, show_profile_names: bool = False) -> dict:
    try:
        result = subprocess.run(
            [sys.executable, "-c", _EXTRACT, str(ROOT / "tools" / "extract.py"), mode, value,
             "authenticated" if show_profile_names else "anonymous"],
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


def _history_settings(root=None, env=None):
    """Load history settings without changing the host's imports."""
    env = os.environ if env is None else env
    source = (ROOT if root is None else root) / "tools" / "botstatus_history.py"
    module = types.ModuleType("hermes_quest_botstatus_history")
    module.__file__ = str(source)
    exec(compile(source.read_text(encoding="utf-8"), str(source), "exec"), module.__dict__)
    return module, module.load_settings(env.get("HERMES_QUEST_CONFIG") or None, env=env)


def _sample_loop(module, settings, stop):
    # Read-only sampler: bot-status.json is only read; one small JSONL line per status change
    # goes to Hermes Quest's own data directory. A failure here never reaches a request.
    period = settings["history_sample_seconds"]
    while not stop.is_set():
        try:
            module.sample_once(settings)
        except Exception:  # noqa: BLE001
            pass
        stop.wait(period)


def _sampler_worker(root, env, stop):
    # Configuration I/O is off the request path and rejects oversized / special
    # files. A stalled worker stays owned until exit, never overlapping replacement.
    try:
        module, settings = _history_settings(root, env)
        if not stop.is_set():
            _sample_loop(module, settings, stop)
    except Exception:  # noqa: BLE001 -- optional sampler must not affect API availability
        with _sampler["lock"]:
            if _sampler["stop"] is stop and not stop.is_set():
                _sampler["state"] = "unavailable"


def _stop_sampler() -> None:
    with _sampler["lock"]:
        stop, thread = _sampler["stop"], _sampler["thread"]
        if stop is not None:
            stop.set()
            _sampler["state"] = "stopping"
    # Do not hold the lock while joining: the worker can publish a load failure.
    if thread is not None:
        thread.join(timeout=5)
    with _sampler["lock"]:
        # A timed-out worker remains owned; it must never overlap a replacement.
        # A concurrent ensure may already have replaced a terminated worker.
        if _sampler["thread"] is thread and (thread is None or not thread.is_alive()):
            _sampler.update(key=None, thread=None, stop=None, state="idle")


# Included routers receive ASGI teardown. Isolated request-only hosts that do
# not dispatch lifespan still stop their worker on ordinary process shutdown.
atexit.register(_stop_sampler)


def _ensure_sampler() -> str:
    """Start at most one worker, with atomic ownership of loading and sampling.

    Replacement is nonblocking: signal the previous worker and retry on a later
    request only after it has exited. Disabled mode also stops existing sampling.
    """
    env = os.environ.copy()
    root = ROOT
    disabled = env.get("HERMES_QUEST_SAMPLER", "").lower() in {"0", "off", "false", "no"}
    key = (str(root), env.get("HERMES_QUEST_CONFIG", ""), env.get("HERMES_HOME", ""))
    with _sampler["lock"]:
        thread, stop = _sampler["thread"], _sampler["stop"]
        if thread is not None and thread.is_alive():
            if disabled or _sampler["key"] != key or stop.is_set():
                stop.set()
                _sampler["state"] = "stopping"
                return "disabled" if disabled else "stopping"
            return _sampler["state"]
        if disabled:
            _sampler.update(key=None, thread=None, stop=None, state="idle")
            return "disabled"
        if _sampler["key"] == key and _sampler["state"] == "unavailable":
            return "unavailable"
        stop = threading.Event()
        thread = threading.Thread(target=_sampler_worker, args=(root, env, stop),
                                  name="hermes-quest-botstatus", daemon=True)
        _sampler.update(key=key, thread=thread, stop=stop, state="running")
        try:
            thread.start()
        except RuntimeError:
            _sampler.update(thread=None, stop=None, state="unavailable")
        return _sampler["state"]


def _profile_names_allowed(request: Request | None) -> bool:
    """Only verified host state or provider-verified credentials disclose names.

    Isolated plugin hosts forward headers/cookies, not parent ASGI state. Reverify
    those with the host's own providers; never trust a query or presence of a header.
    Missing Hermes auth support leaves pseudonyms rather than widening disclosure.
    """
    if request is None:
        return False
    if getattr(request.state, "session", None) is not None:
        return True
    if (getattr(request.state, "token_authenticated", False) is True
            and getattr(request.state, "token_principal", None) is not None):
        return True
    try:
        from hermes_cli.dashboard_auth.cookies import read_session_cookies, read_session_provider
        from hermes_cli.dashboard_auth.middleware import _extract_bearer, _verify_access_token
        token = _extract_bearer(request) or read_session_cookies(request)[0]
        if not token:
            return False
        if _verify_access_token(request, access_token=token,
                                provider_hint=read_session_provider(request), audit=False) is not None:
            return True
        # Basic sessions are stateless. The isolated host may not have registered
        # this bundled provider; use its official verifier/config, without logging
        # in, refreshing, registering providers, or minting a new signing secret.
        from plugins.dashboard_auth.basic import BasicAuthProvider, _settings, _load_config_basic_auth_section
        section = _load_config_basic_auth_section()
        if not (os.environ.get("HERMES_DASHBOARD_BASIC_AUTH_SECRET") or section.get("secret")):
            return False
        return BasicAuthProvider(**_settings()).verify_session(access_token=token) is not None
    except Exception:  # optional host seam/provider outage: fail closed on names
        return False


@router.get("/replay")
def replay(hours: float = Query(default=12, gt=0, le=168), request: Request = None):
    _ensure_sampler()
    return JSONResponse(_extract("replay", str(hours), _profile_names_allowed(request)), headers={"Cache-Control": "no-store"})


@router.get("/events")
def events(since: str = Query(default="", max_length=32768), request: Request = None):
    # Query max_length counts characters, not the decoded opaque cursor's bytes.
    if len(since.encode("utf-8")) > 32768:
        raise HTTPException(status_code=422, detail="Cursor exceeds 32 KiB UTF-8")
    _ensure_sampler()
    return JSONResponse(_extract("events", since, _profile_names_allowed(request)), headers={"Cache-Control": "no-store"})


def _static_target(asset_path: str) -> Path:
    # Reject traversal before normalization; only literal POSIX URL paths exist.
    parts = asset_path.split("/")
    if not asset_path or "\\" in asset_path or any(p in ("", ".", "..") for p in parts):
        raise HTTPException(status_code=404, detail="Not found")
    relative = PurePosixPath(asset_path)
    allowed = asset_path in {
        "index.html", "game.js", "npcs.js", "font.js", "ui-glyphs.js", "ui-panels.js", "quest/c-ui.js",
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
