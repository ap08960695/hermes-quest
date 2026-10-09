"""Bounded C1 regressions; run against a baseline with SAMPLER_API_SOURCE.

Each probe runs in a disposable process: even the old FIFO-blocking implementation
cannot hang the suite or leak its unowned daemon workers into another test.
"""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import patch

SOURCE = Path(os.environ.get("SAMPLER_API_SOURCE", Path(__file__).with_name("plugin_api.py")))


def load_api():
    spec = importlib.util.spec_from_file_location("sampler_lifecycle_api", SOURCE)
    api = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(api)
    return api


def wait_for(predicate, seconds=2):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if predicate():
            return True
        time.sleep(0.01)
    return bool(predicate())


def benign(*args):
    return types.SimpleNamespace(sample_once=lambda _: None), {"history_sample_seconds": 30}


def probe(name):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    api = load_api()
    # Baseline source may be extracted to scratch; keep its helper lookup rooted
    # in this checkout so FIFO probes exercise real I/O, not a missing module.
    api.ROOT = Path(__file__).resolve().parent.parent
    with tempfile.TemporaryDirectory() as scratch, patch.dict(os.environ, {
        "HERMES_HOME": scratch, "HERMES_QUEST_CONFIG": "", "HERMES_QUEST_SAMPLER": "on"
    }):
        home = Path(scratch)
        if name == "concurrent_start":
            # The old implementation releases its lifecycle lock before stopping.
            # Force both callers through that gap; the fixed code never calls stop.
            barrier = threading.Barrier(2)
            original = api._stop_sampler
            def raced_stop():
                original()
                barrier.wait(timeout=2)
            with patch.object(api, "_history_settings", side_effect=benign), patch.object(api, "_stop_sampler", side_effect=raced_stop):
                callers = [threading.Thread(target=api._ensure_sampler) for _ in range(2)]
                for caller in callers:
                    caller.start()
                for caller in callers:
                    caller.join(3)
                    assert not caller.is_alive(), "ensure hung"
                live = [t for t in threading.enumerate() if t.name == "hermes-quest-botstatus"]
                assert len(live) == 1, f"overlapping workers: {len(live)}"
            original()
        elif name in {"stop_ownership", "replacement", "disabled", "stop_start_race"}:
            entered, release = threading.Event(), threading.Event()
            def blocked(_):
                entered.set()
                release.wait(20)
            module = types.SimpleNamespace(sample_once=blocked)
            with patch.object(api, "_history_settings", return_value=(module, {"history_sample_seconds": 30})):
                api._ensure_sampler()
                assert entered.wait(2)
                old, stop = api._sampler["thread"], api._sampler["stop"]
                # Model expiry of the bounded join without spending five seconds.
                with patch.object(old, "join", return_value=None):
                    if name == "stop_ownership":
                        api._stop_sampler()
                        assert api._sampler["thread"] is old, "live worker lost ownership"
                        assert stop.is_set()
                    elif name == "disabled":
                        os.environ["HERMES_QUEST_SAMPLER"] = "off"
                        assert api._ensure_sampler() == "disabled"
                        assert stop.is_set(), "disabled mode left worker sampling"
                        assert api._sampler["thread"] is old
                    elif name == "stop_start_race":
                        joining, finish_join = threading.Event(), threading.Event()
                        def join_pending(*args, **kwargs):
                            joining.set()
                            assert finish_join.wait(2)
                        with patch.object(old, "join", side_effect=join_pending):
                            stopper = threading.Thread(target=api._stop_sampler)
                            stopper.start()
                            assert joining.wait(2)
                            api._ensure_sampler()
                            finish_join.set()
                            stopper.join(2)
                            assert not stopper.is_alive()
                            assert api._sampler["thread"] is old, "ensure replaced worker during stop"
                    else:
                        os.environ["HERMES_HOME"] = str(home / "replacement")
                        start = time.monotonic()
                        api._ensure_sampler()
                        assert time.monotonic() - start < 1, "replacement blocked request"
                        assert api._sampler["thread"] is old, "replacement overlapped live worker"
                        assert stop.is_set()
                release.set()
                old.join(2)
                assert not old.is_alive()
                if name != "disabled":
                    api._ensure_sampler()
                    assert api._sampler["thread"] is not old, "dead worker prevented restart"
                api._stop_sampler()
        elif name == "lifespan":
            with patch.object(api, "_history_settings", side_effect=benign), patch.object(api, "_extract", return_value={"events": []}):
                app = FastAPI()
                app.include_router(api.router)
                with TestClient(app) as client:
                    assert client.get("/events").status_code == 200
                    old, stop = api._sampler["thread"], api._sampler["stop"]
                assert stop.is_set(), "host lifespan failed to signal shutdown"
                assert not old.is_alive(), "host lifespan left sampler alive"
                assert api._sampler["thread"] is None
        elif name == "slow_config":
            entered, release, responded = threading.Event(), threading.Event(), threading.Event()
            def settings(*args):
                entered.set()
                release.wait(20)
                return benign()
            with patch.object(api, "_history_settings", side_effect=settings), patch.object(api, "_extract", return_value={"events": []}):
                def request():
                    api.events("")
                    responded.set()
                caller = threading.Thread(target=request, daemon=True)
                caller.start()
                assert entered.wait(2)
                assert responded.wait(1), "settings I/O blocked the API request"
                release.set()
                caller.join(2)
                api._stop_sampler()
        elif name in {"fifo_config", "fifo_status"}:
            fifo = home / "input.fifo"
            os.mkfifo(fifo)
            if name == "fifo_config":
                os.environ["HERMES_QUEST_CONFIG"] = str(fifo)
                with patch.object(api, "_extract", return_value={"events": []}):
                    # Even without the bounded history reader, this must respond.
                    api.events("")
                # The parent-owned reader rejects this outright. With an older
                # reader, release its FIFO so this lifecycle probe can clean up.
                time.sleep(0.1)
                try:
                    fd = os.open(fifo, os.O_WRONLY | os.O_NONBLOCK)
                except OSError:
                    pass
                else:
                    try:
                        os.write(fd, b"{}")
                    finally:
                        os.close(fd)
            else:
                config = home / "config.json"
                config.write_text(json.dumps({"hermes_home": scratch, "botstatus_path": str(fifo)}))
                os.environ["HERMES_QUEST_CONFIG"] = str(config)
                api._ensure_sampler()
                old = api._sampler["thread"]
                time.sleep(0.1)
                stop = api._sampler["stop"]
                # Expire the join immediately; lifecycle must retain an alive
                # FIFO-blocked worker even before the reader fix is integrated.
                with patch.object(old, "join", return_value=None):
                    api._stop_sampler()
                wait_for(lambda: not old.is_alive(), seconds=0.1)
                if old.is_alive():
                    assert stop.is_set()
                    assert api._sampler["thread"] is old, "FIFO worker orphaned"
                    api._ensure_sampler()
                    assert api._sampler["thread"] is old, "FIFO replacement overlapped"
                    fd = os.open(fifo, os.O_WRONLY | os.O_NONBLOCK)
                    try:
                        os.write(fd, b'{"bots":{}}')
                    finally:
                        os.close(fd)
                    old.join(2)
                    assert not old.is_alive()
                api._ensure_sampler()
                assert api._sampler["thread"] is not old
                # A legacy reader may now be blocked again; release before stop.
                time.sleep(0.1)
                try:
                    fd = os.open(fifo, os.O_WRONLY | os.O_NONBLOCK)
                except OSError:
                    pass
                else:
                    try:
                        os.write(fd, b'{"bots":{}}')
                    finally:
                        os.close(fd)
            api._stop_sampler()
        else:
            raise AssertionError(name)


class SamplerLifecycleTests(unittest.TestCase):
    def run_probe(self, name):
        try:
            result = subprocess.run([sys.executable, str(Path(__file__).resolve()), "--probe", name],
                                    capture_output=True, text=True, timeout=9)
        except subprocess.TimeoutExpired:
            self.fail(f"{name}: child exceeded 9s bound (blocked sampler/request)")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_concurrent_start(self): self.run_probe("concurrent_start")
    def test_stop_retains_live_worker(self): self.run_probe("stop_ownership")
    def test_replacement_waits_without_blocking(self): self.run_probe("replacement")
    def test_disable_signals_existing_worker(self): self.run_probe("disabled")
    def test_start_during_stop_does_not_overlap(self): self.run_probe("stop_start_race")
    def test_included_router_shutdown(self): self.run_probe("lifespan")
    def test_slow_config_does_not_block_request(self): self.run_probe("slow_config")
    @unittest.skipUnless(hasattr(os, "mkfifo"), "POSIX FIFO required")
    def test_config_fifo_does_not_block_request(self): self.run_probe("fifo_config")
    @unittest.skipUnless(hasattr(os, "mkfifo"), "POSIX FIFO required")
    def test_status_fifo_does_not_orphan_worker(self): self.run_probe("fifo_status")


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--probe":
        probe(sys.argv[2])
    else:
        unittest.main()
