#!/usr/bin/env python3
"""Isolated HTTP + executable fake-git/systemctl regression; no live mutations."""
import contextlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch
from urllib import parse

try:
    from . import post_deploy_check as check
except ImportError:
    import post_deploy_check as check

CANDIDATE = "a" * 40
ROLLBACK = "b" * 40
PASSWORD = "password-canary"
SESSION = "opaque-host-issued-session-canary"
TOKEN = "host-issued-token-canary"
USER = "login-canary"
CURSOR = "opaque-canary+/=雪"

FAKE_COMMAND = '''#!/usr/bin/env python3
import json, os, pathlib, sys, time
state = pathlib.Path(os.environ["FAKE_STATE"])
data = json.loads(state.read_text())
args = sys.argv[1:]
kind = pathlib.Path(sys.argv[0]).name
with pathlib.Path(os.environ["FAKE_CALLS"]).open("a") as f:
    f.write(json.dumps([kind, args]) + "\\n")
if kind == "git":
    args = args[2:]
    if args == ["rev-parse", "--show-toplevel"]:
        print(data.get("root", os.environ["FAKE_PLUGIN"]))
    elif args == ["rev-parse", "HEAD"]:
        print(data["sha"])
    elif args[0] == "status":
        print(data.get("dirty", ""))
    elif args[:2] == ["checkout", "--detach"]:
        if data.get("checkout_fail"):
            print("private stderr canary", file=sys.stderr)
            sys.exit(9)
        if not data.get("checkout_noop"):
            data["sha"] = args[2]
            state.write_text(json.dumps(data))
    else:
        sys.exit(8)
elif kind == "systemctl":
    if args != ["--user", "restart", "hermes-dashboard"]:
        sys.exit(8)
    if data.get("restart_fail"):
        sys.exit(7)
else:
    sys.exit(8)
if data.get("exit_delay"):
    # EOF before exit forces the parent's timed Popen.wait() sleep path.
    sys.stdout.flush()
    os.close(1)
    os.close(2)
    time.sleep(data["exit_delay"])
'''


class PostDeployTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="quest-post-check-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.plugin = self.root / "plugin"
        (self.plugin / "dashboard").mkdir(parents=True)
        self.state = self.root / "state.json"
        self.calls_file = self.root / "calls.jsonl"
        self.update_state(sha=CANDIDATE)
        self.auth = self.root / "auth.txt"
        self.auth.write_text("# synthetic credentials\nexport HERMES_DASHBOARD_BASIC_AUTH_USERNAME='" + USER + "'\n"
                             + "HERMES_DASHBOARD_BASIC_AUTH_PASSWORD='" + PASSWORD + "' # comment\n")
        self.auth.chmod(0o600)
        bindir = self.root / "bin"
        bindir.mkdir()
        for name in ("git", "systemctl"):
            executable = bindir / name
            executable.write_text(FAKE_COMMAND)
            executable.chmod(0o700)
        env = {"PATH": str(bindir) + os.pathsep + os.environ["PATH"],
               "FAKE_STATE": str(self.state), "FAKE_CALLS": str(self.calls_file),
               "FAKE_PLUGIN": str(self.plugin)}
        self.env = patch.dict(os.environ, env)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.mode = "pass"
        self.received = []
        self.logins = []
        self.auth_received = []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format, *args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                owner.logins.append((self.path, body))
                valid = self.path == '/auth/password-login' and body == {'provider': 'basic', 'username': USER, 'password': PASSWORD}
                status = 302 if owner.mode == 'login_redirect' else (200 if valid and owner.mode != 'login_401' else 401)
                self.send_response(status)
                if status == 302:
                    self.send_header('Location', '/redirect-canary')
                if status == 200 and owner.mode != 'login_no_cookie':
                    self.send_header('Set-Cookie', 'hermes_session_at=' + SESSION + '; HttpOnly; Path=/')
                    self.send_header('Set-Cookie', 'hermes_session_provider=basic; Path=/')
                self.send_header('Content-Length', '0')
                self.end_headers()

            def do_GET(self):
                url = parse.urlsplit(self.path)
                cookie = self.headers.get("Cookie", "")
                bearer = self.headers.get('Authorization', '')
                owner.auth_received.append((cookie, bearer))
                authenticated = cookie == 'hermes_session_at=' + SESSION + '; hermes_session_provider=basic' or bearer == 'Bearer ' + TOKEN
                rolled_back = json.loads(owner.state.read_text())["sha"] == ROLLBACK
                failing = not rolled_back or owner.mode == "rollback_health_fail"
                status = 200
                payload = {"cursor": CURSOR, "private": "payload-canary"}
                protected = url.path.startswith(check.API)
                if protected and not authenticated:
                    status = 200 if owner.mode == "unauth_200" and failing else 401
                elif authenticated:
                    if url.path.endswith("/events"):
                        since = parse.parse_qs(url.query).get("since", [""])[0]
                        owner.received.append(since)
                        payload["cursor"] = CURSOR + str(len(owner.received))
                        if failing and owner.mode in {"events_422", "rollback_health_fail"}:
                            status = 422
                        if failing and owner.mode == "events_oversize":
                            payload["cursor"] = "雪" * 11000
                    if url.path.endswith("/replay") and failing:
                        if owner.mode == "oversize":
                            payload["cursor"] = "雪" * 11000
                        if owner.mode == "boundary":
                            payload["cursor"] = "x" * check.MAX_CURSOR
                        if owner.mode == "missing_cursor":
                            del payload["cursor"]
                        if owner.mode == "replay_503":
                            status = 503
                    if url.path.endswith("/desktop-bootstrap") and failing and owner.mode == "desktop_503":
                        status = 503
                    if url.path == "/hermes-quest" and failing and owner.mode == "page_503":
                        status = 503
                    if failing and owner.mode == "redirect":
                        status = 302
                body = json.dumps(payload, ensure_ascii=False).encode()
                if owner.mode == "invalid_json" and failing and authenticated and url.path.endswith("/replay"):
                    body = b"private-invalid-payload"
                self.send_response(status)
                if status == 302:
                    self.send_header("Location", "/redirect-canary")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.server = ThreadingHTTPServer(("localhost", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close_server)
        self.base = "http://localhost:" + str(self.server.server_port)

    def close_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)

    def update_state(self, **changes):
        data = json.loads(self.state.read_text()) if self.state.exists() else {}
        data.update(changes)
        self.state.write_text(json.dumps(data))

    def argv(self):
        return ["--plugin-dir", str(self.plugin), "--expected-sha", CANDIDATE,
                "--rollback-sha", ROLLBACK, "--base-url", self.base, "--auth-file", str(self.auth)]

    def run_gate(self, *extra):
        stdout, stderr = io.StringIO(), io.StringIO()
        # Replace only the gate's module binding, not shared time.sleep used by subprocess.
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr), patch.object(check, "time", wraps=time, sleep=Mock()) as clock:
            rc = check.main(self.argv() + list(extra))
        self.assertEqual(stderr.getvalue(), "")
        self.logs = [json.loads(line) for line in stdout.getvalue().splitlines()]
        for canary in (PASSWORD, SESSION, TOKEN, USER, CURSOR, "payload-canary", "private stderr canary", str(self.root)):
            self.assertNotIn(canary, stdout.getvalue())
        allowed = {"phase", "check", "status", "time", "http_status", "bytes", "elapsed_ms", "round", "rounds", "exit_code"}
        for row in self.logs:
            self.assertLessEqual(set(row), allowed)
        self.sleeps = clock.sleep.call_args_list
        self.calls = [json.loads(line) for line in self.calls_file.read_text().splitlines()] if self.calls_file.exists() else []
        for canary in (PASSWORD, SESSION, TOKEN, USER):
            self.assertNotIn(canary, json.dumps(self.calls))
        return rc

    def mutations(self):
        return [row for row in self.calls if row[0] == "systemctl" or "checkout" in row[1]]

    def test_pass_three_rounds_cursor_chain_and_timing(self):
        self.assertEqual(self.run_gate(), 0)
        self.assertEqual(self.logins, [('/auth/password-login', {'provider': 'basic', 'username': USER, 'password': PASSWORD})])
        self.assertEqual(sum(not cookie and not bearer for cookie, bearer in self.auth_received), 3)
        self.assertEqual(self.received, [CURSOR, CURSOR + "1", CURSOR + "2"])
        self.assertEqual([call.args for call in self.sleeps], [(10.0,), (10.0,)])
        self.assertEqual(self.mutations(), [])

    def test_poll_timing_excludes_delayed_subprocess_wait(self):
        self.update_state(exit_delay=0.05)
        with patch.object(time, "sleep", wraps=time.sleep) as wait_sleep:
            self.test_pass_three_rounds_cursor_chain_and_timing()
        self.assertTrue(wait_sleep.called, "fixture must exercise real subprocess wait sleeps")

    def test_events_422_rolls_back_and_rechecks(self):
        self.mode = "events_422"
        self.assertEqual(self.run_gate(), 1)
        self.assertEqual(json.loads(self.state.read_text())["sha"], ROLLBACK)
        self.assertEqual([row[0] for row in self.mutations()], ["git", "systemctl"])

        self.assertEqual(self.mutations()[0][1][2:], ["checkout", "--detach", ROLLBACK])
        self.assertTrue(any(row["phase"] == "rollback" and row["check"] == "gate" and row["status"] == "pass" for row in self.logs))

    def test_unauth_200_is_failure(self):
        self.mode = "unauth_200"
        self.assertEqual(self.run_gate(), 1)
        self.assertTrue(self.mutations())

    def test_sha_mismatch_rolls_back(self):
        self.update_state(sha="c" * 40)
        self.assertEqual(self.run_gate(), 1)
        self.assertTrue(self.mutations())

    def test_check_only_never_mutates_even_on_422(self):
        self.mode = "events_422"
        self.assertEqual(self.run_gate("--check-only"), 1)
        self.assertEqual(self.mutations(), [])
        self.assertEqual(json.loads(self.state.read_text())["sha"], CANDIDATE)

    def test_check_only_success(self):
        self.assertEqual(self.run_gate("--check-only"), 0)
        self.assertEqual(self.mutations(), [])

    def test_checkout_failure(self):
        self.mode = "events_422"
        self.update_state(checkout_fail=True)
        self.assertEqual(self.run_gate(), 2)
        self.assertFalse(any(row[0] == "systemctl" for row in self.calls))

    def test_checkout_success_without_effect_is_failure(self):
        self.mode = "events_422"
        self.update_state(checkout_noop=True)
        self.assertEqual(self.run_gate(), 2)
        self.assertFalse(any(row[0] == "systemctl" for row in self.calls))

    def test_restart_failure(self):
        self.mode = "events_422"
        self.update_state(restart_fail=True)
        self.assertEqual(self.run_gate(), 2)

    def test_rollback_health_failure(self):
        self.mode = "rollback_health_fail"
        self.assertEqual(self.run_gate(), 2)
        self.assertEqual(len(self.mutations()), 2)

    def test_cursor_utf8_bytes_not_characters(self):
        self.mode = "oversize"
        self.assertEqual(self.run_gate(), 1)
        self.assertTrue(any(row["check"] == "cursor" and row.get("bytes") == 33000 and row["status"] == "fail" for row in self.logs))

    def test_event_cursor_limit(self):
        self.mode = "events_oversize"
        self.assertEqual(self.run_gate(), 1)

    def test_cursor_exact_limit(self):
        self.mode = "boundary"
        self.assertEqual(self.run_gate("--check-only"), 0)
        self.assertEqual(len(self.received[0].encode()), check.MAX_CURSOR)

    def test_malformed_payloads(self):
        for mode in ("missing_cursor", "invalid_json"):
            with self.subTest(mode=mode):
                self.mode = mode
                self.assertEqual(self.run_gate("--check-only"), 1)

    def test_replay_page_and_desktop_failures(self):
        (self.plugin / "dashboard" / "desktop_transport.py").touch()
        for mode in ("replay_503", "page_503", "desktop_503"):
            with self.subTest(mode=mode):
                self.mode = mode
                self.assertEqual(self.run_gate("--check-only"), 1)

    def test_optional_desktop_present_pass(self):
        (self.plugin / "dashboard" / "desktop_transport.py").touch()
        self.assertEqual(self.run_gate(), 0)
        self.assertTrue(any(row["check"] == "desktop_bootstrap" and row.get("http_status") == 200 for row in self.logs))

    def test_dirty_tree_is_never_overwritten(self):
        self.update_state(dirty=" M operator-file")
        self.assertEqual(self.run_gate(), 2)
        self.assertEqual(self.mutations(), [])

    def test_nested_plugin_dir_is_never_mutated(self):
        self.update_state(root=str(self.root))
        self.assertEqual(self.run_gate(), 2)
        self.assertEqual(self.mutations(), [])

    def test_redirects_fail_without_following(self):
        self.mode = "redirect"
        self.assertEqual(self.run_gate("--check-only"), 1)
        self.assertEqual(self.received, [])

    def test_bad_auth_does_not_print_or_modify_in_check_only(self):
        self.auth.write_text(PASSWORD)
        self.assertEqual(self.run_gate("--check-only"), 1)
        self.assertEqual(self.mutations(), [])

    def test_config_errors_are_json_only(self):
        for extra in (["--expected-sha", "invalid-canary"], ["--interval", "nan"],
                      ["--timeout", "0"], ["--unknown-secret-option"],
                      ["--base-url", "http://user:private-canary@localhost"]):
            with self.subTest(extra=extra):
                self.assertEqual(self.run_gate(*extra), 2)
                self.assertEqual(self.mutations(), [])

    def test_cli_environment_arguments(self):
        env = os.environ.copy()
        env.update({"QUEST_PLUGIN_DIR": str(self.plugin), "QUEST_EXPECTED_SHA": CANDIDATE,
                    "QUEST_ROLLBACK_SHA": ROLLBACK, "QUEST_BASE_URL": self.base,
                    "QUEST_AUTH_FILE": str(self.auth)})
        result = subprocess.run([sys.executable, str(Path(check.__file__)), "--check-only", "--interval", "0"],
                                env=env, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(result.stderr, "")
        self.assertEqual(json.loads(result.stdout.splitlines()[-1])["rounds"], 3)
        self.assertNotIn(PASSWORD, result.stdout)

    def test_host_issued_cookie_and_token_files(self):
        for key, value in [('QUEST_AUTH_COOKIE', 'hermes_session_at=' + SESSION + '; hermes_session_provider=basic'),
                           ('QUEST_AUTH_TOKEN', TOKEN)]:
            with self.subTest(key=key):
                self.auth.write_text(key + '=' + repr(value) + '\n')
                self.assertEqual(self.run_gate('--check-only'), 0)
                self.assertEqual(self.logins, [])
                self.assertEqual(self.mutations(), [])

    def test_login_rejection_redirect_or_missing_session_fails_closed(self):
        for mode in ('login_401', 'login_redirect', 'login_no_cookie'):
            with self.subTest(mode=mode):
                self.mode = mode
                self.assertEqual(self.run_gate('--check-only'), 1)
                self.assertEqual(self.auth_received, [])
                self.assertEqual(self.mutations(), [])

    def test_unrelated_signing_fields_are_not_parsed(self):
        with self.auth.open('a') as f:
            f.write("HERMES_DASHBOARD_BASIC_AUTH_SECRET='unclosed-ignored\n")
        self.assertEqual(self.run_gate('--check-only'), 0)

    def test_signing_secret_and_password_hash_cannot_authenticate(self):
        self.auth.write_text("HERMES_DASHBOARD_BASIC_AUTH_USERNAME='" + USER + "'\n"
                             "HERMES_DASHBOARD_BASIC_AUTH_SECRET='synthetic-unused'\n"
                             "HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH='synthetic-unused'\n")
        self.assertEqual(self.run_gate('--check-only'), 1)
        self.assertEqual(self.logins, [])
        self.assertEqual(self.auth_received, [])

    def test_auth_file_permissions_symlink_and_fifo_fail_closed(self):
        self.auth.chmod(0o644)
        self.assertEqual(self.run_gate('--check-only'), 1)
        self.auth.chmod(0o600)
        saved = self.root / 'saved-auth'
        self.auth.rename(saved)
        self.auth.symlink_to(saved)
        self.assertEqual(self.run_gate('--check-only'), 1)
        self.auth.unlink()
        os.mkfifo(self.auth, 0o600)
        self.assertEqual(self.run_gate('--check-only'), 1)
        self.assertEqual(self.logins, [])

    def test_ambiguous_duplicate_and_header_injection_credentials_rejected(self):
        for data in ("QUEST_AUTH_TOKEN='a'\nQUEST_AUTH_COOKIE='b'\n",
                     "QUEST_AUTH_TOKEN='a'\nQUEST_AUTH_TOKEN='b'\n",
                     "QUEST_AUTH_TOKEN='a\rX: b'\n"):
            with self.subTest():
                self.auth.write_text(data)
                self.assertEqual(self.run_gate('--check-only'), 1)
                self.assertEqual(self.logins, [])


if __name__ == "__main__":
    unittest.main()
