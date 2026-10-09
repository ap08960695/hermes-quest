#!/usr/bin/env python3
"""Post-install Quest gate; stdout is JSONL, never response/subprocess contents.

Pass --plugin-dir, --expected-sha, --rollback-sha, --base-url, --auth-file
(or QUEST_PLUGIN_DIR, QUEST_EXPECTED_SHA, QUEST_ROLLBACK_SHA, QUEST_BASE_URL,
QUEST_AUTH_FILE). Default failure action: detach rollback SHA, restart the user
hermes-dashboard service, verify rollback with the same three-round gate, exit 1.
--check-only never checks out or restarts anything. Exit 2 means rollback failed
(or configuration/preflight failed). No reset/stash/force checkout is used.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import math
import os
from pathlib import Path
import re
import shlex
import subprocess
import time
from urllib import error, parse, request

API = "/api/plugins/hermes-quest"
MAX_CURSOR = 32768
MAX_RESPONSE = 32 * 1024 * 1024


class CheckError(Exception):
    """Only fixed, non-sensitive codes may be reported."""


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise CheckError("arguments")


def emit(phase, check, status, **numbers):
    print(json.dumps({"phase": phase, "check": check, "status": status,
                      "time": int(time.time()), **numbers}), flush=True)


class NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def auth_cookie(path):
    values = {}
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:]
        key, value = line.split("=", 1)
        parts = shlex.split(value, comments=True)
        if len(parts) != 1:
            raise CheckError("auth_file")
        values[key.strip()] = parts[0]
    raw_secret = values["HERMES_DASHBOARD_BASIC_AUTH_SECRET"]
    secret = raw_secret.encode()
    for decode in (base64.b64decode, bytes.fromhex):
        try:
            decoded = decode(raw_secret)
            if len(decoded) >= 16:
                secret = decoded
                break
        except (ValueError, TypeError):
            pass
    raw = json.dumps({"sub": values["HERMES_DASHBOARD_BASIC_AUTH_USERNAME"],
                      "kind": "access", "exp": int(time.time()) + 3600},
                     separators=(",", ":")).encode()
    token = base64.urlsafe_b64encode(raw + hmac.new(secret, raw, hashlib.sha256).digest()).decode()
    return "hermes_session_at=" + token + "; hermes_session_provider=basic"


class Gate:
    def __init__(self, args):
        self.args = args
        self.plugin = Path(args.plugin_dir).resolve()
        self.opener = request.build_opener(request.ProxyHandler({}), NoRedirect())
        self.cookie = None
        self.phase = "candidate"
        self.root_valid = False

    def command(self, check, argv, timeout=60):
        start = time.monotonic()
        try:
            result = subprocess.run(argv, cwd=self.plugin, capture_output=True,
                                    text=True, timeout=timeout, check=False)
        except (OSError, subprocess.SubprocessError):
            emit(self.phase, check, "fail", elapsed_ms=int((time.monotonic() - start) * 1000))
            raise CheckError(check) from None
        emit(self.phase, check, "pass" if result.returncode == 0 else "fail",
             exit_code=result.returncode, elapsed_ms=int((time.monotonic() - start) * 1000))
        if result.returncode:
            raise CheckError(check)
        return result.stdout.strip()

    def git(self, check, *args):
        return self.command(check, ["git", "-C", str(self.plugin), *args])

    def head(self, sha):
        actual = self.git("git_head", "rev-parse", "HEAD")
        if actual != sha:
            emit(self.phase, "installed_sha", "fail")
            raise CheckError("installed_sha")
        emit(self.phase, "installed_sha", "pass")

    def clean(self):
        if self.git("git_status", "status", "--porcelain", "--untracked-files=all"):
            emit(self.phase, "clean_tree", "fail")
            raise CheckError("clean_tree")

    def http(self, check, path, expected=200, authenticated=True, round_number=0):
        headers = {"Cookie": self.cookie or ""} if authenticated else {}
        req = request.Request(self.args.base_url.rstrip("/") + path, headers=headers)
        start = time.monotonic()
        code, body = 0, b""
        try:
            try:
                response = self.opener.open(req, timeout=self.args.timeout)
            except error.HTTPError as exc:
                response = exc
            with response:
                code = response.code
                body = response.read(MAX_RESPONSE + 1)
        except (OSError, error.URLError, ValueError):
            emit(self.phase, check, "fail", http_status=code, bytes=len(body),
                 elapsed_ms=int((time.monotonic() - start) * 1000), round=round_number)
            raise CheckError(check) from None
        ok = code == expected and len(body) <= MAX_RESPONSE
        emit(self.phase, check, "pass" if ok else "fail", http_status=code,
             bytes=len(body), elapsed_ms=int((time.monotonic() - start) * 1000), round=round_number)
        if not ok:
            raise CheckError(check)
        return body

    def cursor(self, body, round_number):
        try:
            payload = json.loads(body)
            cursor = payload["cursor"]
            if not isinstance(cursor, str) or not cursor:
                raise ValueError()
            size = len(cursor.encode("utf-8"))
        except (ValueError, KeyError, TypeError, UnicodeError):
            emit(self.phase, "cursor", "fail", round=round_number)
            raise CheckError("cursor") from None
        emit(self.phase, "cursor", "pass" if size <= MAX_CURSOR else "fail",
             bytes=size, round=round_number)
        if size > MAX_CURSOR:
            raise CheckError("cursor")
        return cursor

    def verify(self, sha):
        self.head(sha)
        self.clean()
        # New cookie per phase; never send it to redirects or proxy destinations.
        self.cookie = auth_cookie(self.args.auth_file)
        desktop = (self.plugin / "dashboard" / "desktop_transport.py").is_file()
        protected = [("replay", API + "/replay"), ("events", API + "/events"),
                     ("quest_page", API + "/static/index.html")]
        if desktop:
            protected.append(("desktop_bootstrap", API + "/desktop-bootstrap"))
        for label, path in protected:
            self.http("unauth_" + label, path, 401, False)
        self.http("quest_entry", "/hermes-quest")
        self.http("quest_page", API + "/static/index.html?live=1")
        if desktop:
            self.http("desktop_bootstrap", API + "/desktop-bootstrap")
        else:
            emit(self.phase, "desktop_bootstrap", "skipped")
        cursor = None
        for round_number in range(1, 4):
            if round_number > 1:
                time.sleep(self.args.interval)
            replay_cursor = self.cursor(self.http("replay", API + "/replay", round_number=round_number), round_number)
            if cursor is None:
                cursor = replay_cursor
            cursor = self.cursor(self.http("events", API + "/events?" + parse.urlencode({"since": cursor}),
                                           round_number=round_number), round_number)
        self.head(sha)
        emit(self.phase, "gate", "pass", rounds=3)

    def rollback(self):
        self.phase = "rollback"
        if not self.root_valid:
            raise CheckError("plugin_root")
        # Refuse all local edits, including untracked files; no stash/reset.
        self.clean()
        self.git("checkout", "checkout", "--detach", self.args.rollback_sha)
        self.head(self.args.rollback_sha)
        self.command("restart", ["systemctl", "--user", "restart", self.args.service])
        # A restart exit 0 can precede HTTP readiness. Only startup gets retries;
        # once ready, any gate failure is decisive (never hidden by a retry).
        for attempt in range(10):
            try:
                self.http("ready", "/hermes-quest")
                break
            except CheckError:
                if attempt == 9:
                    raise
                time.sleep(1)
        self.verify(self.args.rollback_sha)


def arguments(argv):
    parser = Parser(description=__doc__)
    for name in ("plugin-dir", "expected-sha", "rollback-sha", "base-url", "auth-file"):
        parser.add_argument("--" + name, default=os.getenv("QUEST_" + name.upper().replace("-", "_")))
    parser.add_argument("--check-only", action="store_true")
    parser.add_argument("--service", default=os.getenv("QUEST_DASHBOARD_SERVICE", "hermes-dashboard"))
    parser.add_argument("--interval", type=float, default=10.0, help="seconds between rounds (default: 10)")
    parser.add_argument("--timeout", type=float, default=45.0, help="HTTP timeout in seconds")
    args = parser.parse_args(argv)
    if not all((args.plugin_dir, args.expected_sha, args.base_url, args.auth_file)):
        raise CheckError("arguments")
    for sha in (args.expected_sha, args.rollback_sha):
        if sha is not None and not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", sha):
            raise CheckError("arguments")
    if not args.check_only and not args.rollback_sha:
        raise CheckError("arguments")
    url = parse.urlsplit(args.base_url)
    if (url.scheme not in {"http", "https"} or not url.hostname or url.username or url.password
            or url.query or url.fragment or url.path not in {"", "/"}):
        raise CheckError("arguments")
    if not re.fullmatch(r"[A-Za-z0-9_.@-]+", args.service) or args.service.startswith("-"):
        raise CheckError("arguments")
    if not math.isfinite(args.interval) or args.interval < 0 or not math.isfinite(args.timeout) or args.timeout <= 0:
        raise CheckError("arguments")
    return args


def main(argv=None):
    gate = None
    try:
        args = arguments(argv)
        gate = Gate(args)
        root = gate.git("git_root", "rev-parse", "--show-toplevel")
        if Path(root).resolve() != gate.plugin:
            raise CheckError("plugin_root")
        gate.root_valid = True
        gate.verify(args.expected_sha)
        return 0
    except Exception:
        # No exception text: URLs, credentials, payloads and git stderr are private.
        emit("candidate", "gate", "fail")
        if gate is None:
            return 2
        if gate.args.check_only:
            return 1
        try:
            gate.rollback()
        except Exception:
            emit("rollback", "gate", "fail")
            return 2
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
