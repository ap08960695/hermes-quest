#!/usr/bin/env python3
"""Post-install Quest gate; stdout is JSONL, never response/subprocess contents.

Pass --plugin-dir, --expected-sha, --rollback-sha, --base-url, --auth-file
(or QUEST_PLUGIN_DIR, QUEST_EXPECTED_SHA, QUEST_ROLLBACK_SHA, QUEST_BASE_URL,
QUEST_AUTH_FILE). Default failure action: detach rollback SHA, restart the user
hermes-dashboard service, verify rollback with the same three-round gate, exit 1.
--check-only never checks out or restarts anything. Exit 2 means rollback failed
(or configuration/preflight failed). No reset/stash/force checkout is used.
Auth file: owner-only ordinary QUEST_AUTH_COOKIE / QUEST_AUTH_TOKEN, or username
and password for the public Basic login endpoint. See docs/post-deploy-check.md.
"""
from __future__ import annotations

import argparse
from http.cookies import SimpleCookie
import json
import math
import os
from pathlib import Path
import re
import shlex
import stat
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


def auth_values(path):
    """Read only ordinary login/session fields from an owner-only regular file."""
    keys = {"QUEST_AUTH_COOKIE", "QUEST_AUTH_TOKEN",
            "HERMES_DASHBOARD_BASIC_AUTH_USERNAME", "HERMES_DASHBOARD_BASIC_AUTH_PASSWORD"}
    values = {}
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, encoding="utf-8") as source:
        info = os.fstat(source.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) & 0o077 or info.st_size > 65536):
            raise CheckError("auth_file")
        lines = source.read(65537)
    if len(lines) > 65536:
        raise CheckError("auth_file")
    for line in lines.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:]
        key, separator, value = line.partition("=")
        key = key.strip()
        if key not in keys:
            continue  # Do not parse or use host signing configuration / password hashes.
        parts = shlex.split(value, comments=True)
        if not separator or len(parts) != 1 or key in values or not parts[0] or any(c in parts[0] for c in "\r\n\0"):
            raise CheckError("auth_file")
        values[key] = parts[0]
    modes = sum(("QUEST_AUTH_COOKIE" in values, "QUEST_AUTH_TOKEN" in values,
                 "HERMES_DASHBOARD_BASIC_AUTH_PASSWORD" in values))
    if modes != 1:
        raise CheckError("auth_file")
    return values


class Gate:
    def __init__(self, args):
        self.args = args
        self.plugin = Path(args.plugin_dir).resolve()
        self.opener = request.build_opener(request.ProxyHandler({}), NoRedirect())
        self.auth_headers = {}
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
        headers = self.auth_headers if authenticated else {}
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

    def authenticate(self):
        values = auth_values(self.args.auth_file)
        if "QUEST_AUTH_COOKIE" in values:
            self.auth_headers = {"Cookie": values["QUEST_AUTH_COOKIE"]}
        elif "QUEST_AUTH_TOKEN" in values:
            self.auth_headers = {"Authorization": "Bearer " + values["QUEST_AUTH_TOKEN"]}
        else:
            payload = json.dumps({"provider": "basic", "username": values["HERMES_DASHBOARD_BASIC_AUTH_USERNAME"],
                                  "password": values["HERMES_DASHBOARD_BASIC_AUTH_PASSWORD"]}).encode()
            req = request.Request(self.args.base_url.rstrip("/") + "/auth/password-login",
                                  data=payload, headers={"Content-Type": "application/json"}, method="POST")
            try:
                with self.opener.open(req, timeout=self.args.timeout) as response:
                    if response.code != 200:
                        raise CheckError("login")
                    cookies = SimpleCookie()
                    for value in response.headers.get_all("Set-Cookie", []):
                        cookies.load(value)
                    # Forward the host-issued session unchanged, never manufacture claims/signatures.
                    if not cookies.get("hermes_session_at") or not cookies["hermes_session_at"].value:
                        raise CheckError("login")
                    self.auth_headers = {"Cookie": "; ".join(f"{key}={cookie.coded_value}" for key, cookie in cookies.items())}
            except error.HTTPError as exc:
                exc.close()
                raise CheckError("login") from None
            except (OSError, error.URLError, ValueError):
                raise CheckError("login") from None
        emit(self.phase, "authentication", "pass")

    def verify(self, sha):
        self.head(sha)
        self.clean()
        # Ordinary host-issued auth per phase; no redirects or proxy destinations.
        self.authenticate()
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
