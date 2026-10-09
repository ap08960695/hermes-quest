#!/usr/bin/env python3
"""Read-only botstatus history for Hermes Quest (pause / resume / failover source).

The bot-status file written by Hermes is only ever opened for reading. Whenever a
profile's status changes, one small JSON line is appended to a history file that
lives in Hermes Quest's own data directory (default: <hermes_home>/hermes-quest/).
Only an allowlist is stored: sequence, timestamp, profile ID, one of four status
enums and, for failover, the two profile IDs. Reasons, account names, usage and
tokens from the source file are never copied.

Run once (cron):   python3 tools/botstatus_history.py [--config config.json]
The dashboard plugin runs the same sample_once() every ~30 s while it is up.

Settings (all optional, JSON keys of the Hermes Quest config file):
  botstatus_path          default <hermes_home>/bot-status.json
  history_dir             default <hermes_home>/hermes-quest
  history_max_bytes       rotate the active file at this size (default 262144)
  history_keep            rotated files to keep (default 3)
  history_sample_seconds  sampler period used by the dashboard (default 30)
Importing this module reads and writes nothing.
"""
import argparse
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import sys
import time

try:  # POSIX only; without it samplers are simply not serialized.
    import fcntl
except ImportError:  # pragma: no cover
    fcntl = None

STATUSES = ('active', 'limited', 'waiting-start', 'unavailable')
PROFILE_RE = re.compile(r'[\w-]{1,64}')
# "[failover] A <status> (<reason>) -> B", "[failover] captain request #7: A -> B | ..."
FAILOVER_RE = re.compile(r'^\[failover\]\s+(?:captain request #\d+:\s+)?([\w-]{1,64})\b.*?->\s*([\w-]{1,64})\b', re.S)
DEFAULTS = {'botstatus_path': None, 'history_dir': None, 'history_max_bytes': 262144,
            'history_keep': 3, 'history_sample_seconds': 30}
LIMITS = {'history_max_bytes': (4096, 64 * 1024 * 1024), 'history_keep': (0, 20),
          'history_sample_seconds': (5, 3600)}
FILE = 'botstatus-history.jsonl'
STATE = 'state.json'
LOCK = '.lock'
MAX_STATUS_BYTES = 1024 * 1024
MAX_BATCH = 500


def resolve_settings(cfg=None, env=None):
    """Validate a config mapping (may be partial) and return absolute settings."""
    env = os.environ if env is None else env
    cfg = cfg or {}
    if not isinstance(cfg, dict):
        raise ValueError('config must be a JSON object')
    home = Path(str(cfg.get('hermes_home') or env.get('HERMES_HOME') or '~/.hermes')).expanduser().resolve()
    out = dict(home=home)
    for key, (low, high) in LIMITS.items():
        value = cfg.get(key, DEFAULTS[key])
        if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
            raise ValueError(f'{key} must be an integer from {low} to {high}')
        out[key] = value
    for key, default in (('botstatus_path', home / 'bot-status.json'), ('history_dir', home / 'hermes-quest')):
        value = cfg.get(key)
        if value is not None and (not isinstance(value, str) or not value.strip() or '\0' in value):
            raise ValueError(f'{key} must be a non-empty path string or null')
        out[key] = Path(value).expanduser() if value else default
    out['kanban_db'] = home / 'kanban.db'
    return out


def load_settings(config_path=None, env=None):
    env = os.environ if env is None else env
    cfg = {}
    path = config_path or env.get('HERMES_QUEST_CONFIG')
    if path:
        with open(os.path.expanduser(str(path)), encoding='utf-8') as f:
            cfg = json.load(f)
    return resolve_settings(cfg, env)


def _files(settings):
    base = Path(settings['history_dir']) / FILE
    rotated = [base.with_name(f'{FILE}.{i}') for i in range(settings['history_keep'], 0, -1)]
    return rotated + [base]  # oldest -> newest


def _lock(settings, shared, wait):
    """Return an open lock fd (or None). Readers never create the lock file."""
    if fcntl is None:
        return None
    path = Path(settings['history_dir']) / LOCK
    try:
        fd = os.open(path, os.O_RDONLY if shared else os.O_RDWR | os.O_CREAT, 0o600)
    except OSError:
        return None
    deadline = time.monotonic() + wait
    while True:
        try:
            fcntl.flock(fd, (fcntl.LOCK_SH if shared else fcntl.LOCK_EX) | fcntl.LOCK_NB)
            return fd
        except OSError:
            if time.monotonic() >= deadline:
                os.close(fd)
                return None
            time.sleep(0.02)


def _unlock(fd):
    if fd is not None:
        os.close(fd)  # closing releases the flock


def _record(raw, known=None):
    """Strict allowlist normalization; anything unexpected is dropped."""
    if not isinstance(raw, dict) or raw.get('v') != 1:
        return None
    seq, ts, kind, profile = raw.get('seq'), raw.get('ts'), raw.get('type'), raw.get('profile')
    if isinstance(seq, bool) or not isinstance(seq, int) or seq < 1 or seq > 2 ** 53:
        return None
    if isinstance(ts, bool) or not isinstance(ts, (int, float)) or not math.isfinite(ts) or ts <= 0:
        return None
    if not isinstance(profile, str) or not PROFILE_RE.fullmatch(profile):
        return None
    if kind == 'status':
        prev = raw.get('prev')
        if raw.get('status') not in STATUSES or (prev is not None and prev not in STATUSES):
            return None
        return dict(seq=seq, ts=float(ts), type='status', profile=profile, status=raw['status'], prev=prev)
    if kind == 'failover':
        to = raw.get('to')
        if not isinstance(to, str) or not PROFILE_RE.fullmatch(to) or to == profile:
            return None
        return dict(seq=seq, ts=float(ts), type='failover', profile=profile, to=to)
    return None


def read_records(settings):
    """All valid records, oldest first, deduplicated by seq. Never writes."""
    cap = settings['history_max_bytes'] * 2 + 65536
    fd = _lock(settings, True, 0.5)
    seen = {}
    try:
        for path in _files(settings):
            try:
                with open(path, 'rb') as f:
                    size = os.fstat(f.fileno()).st_size
                    if size > cap:
                        f.seek(size - cap)
                    data = f.read(cap)
            except OSError:
                continue
            lines = data.split(b'\n')
            if size > cap:
                lines = lines[1:]  # first line is a partial one
            for line in lines:
                try:
                    rec = _record(json.loads(line))
                except (ValueError, RecursionError):
                    continue
                if rec:
                    seen.setdefault(rec['seq'], rec)
    finally:
        _unlock(fd)
    return [seen[k] for k in sorted(seen)]


def read_status(path):
    """{profile: status} from the bot-status file, or None. Opens read-only."""
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError:
        return None
    try:
        data = b''
        while len(data) <= MAX_STATUS_BYTES:
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            data += chunk
    except OSError:
        return None
    finally:
        os.close(fd)
    if len(data) > MAX_STATUS_BYTES:
        return None
    try:
        bots = json.loads(data).get('bots')
    except (ValueError, AttributeError, RecursionError):
        return None
    if not isinstance(bots, dict):
        return None
    result = {}
    for name, entry in bots.items():
        if isinstance(name, str) and PROFILE_RE.fullmatch(name) and isinstance(entry, dict) \
                and entry.get('status') in STATUSES:
            result[name] = (entry['status'], entry.get('since'))
    return result


def _load_state(settings):
    directory = Path(settings['history_dir'])
    try:
        raw = json.loads((directory / STATE).read_text(encoding='utf-8'))
        last, seq, comment = raw['last'], raw['seq'], raw['comment']
        if raw.get('v') == 1 and isinstance(last, dict) and isinstance(seq, int) and not isinstance(seq, bool) \
                and (comment is None or (isinstance(comment, int) and not isinstance(comment, bool))) \
                and all(isinstance(k, str) and PROFILE_RE.fullmatch(k) and v in STATUSES for k, v in last.items()):
            return dict(last=dict(last), seq=seq, comment=comment)
    except (OSError, ValueError, KeyError, TypeError, RecursionError):
        pass
    state = dict(last={}, seq=0, comment=None)  # rebuild from the history itself
    for rec in read_records(settings):
        state['seq'] = max(state['seq'], rec['seq'])
        if rec['type'] == 'status':
            state['last'][rec['profile']] = rec['status']
    return state


def _save_state(settings, state):
    directory = Path(settings['history_dir'])
    tmp = directory / (STATE + '.tmp')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        json.dump(dict(v=1, last=state['last'], seq=state['seq'], comment=state['comment']), f, separators=(',', ':'))
    os.replace(tmp, directory / STATE)


def _failovers(settings, state, known):
    """New [failover] comments as (ts, from, to). Reads kanban.db read-only,
    prefix of the body only; only validated profile IDs ever leave this function."""
    path = Path(settings['kanban_db'])
    if not path.exists():
        return []
    db = None
    try:
        db = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True, timeout=2)
        db.execute('PRAGMA query_only=ON')
        if state['comment'] is None:  # first run: do not replay old failovers
            state['comment'] = db.execute('SELECT coalesce(max(id),0) FROM task_comments').fetchone()[0]
            return []
        rows = db.execute("SELECT id,created_at,substr(body,1,400) FROM task_comments WHERE id>? AND "
                          "substr(body,1,10)='[failover]' ORDER BY id LIMIT 200", (state['comment'],)).fetchall()
    except sqlite3.Error:
        return []
    finally:
        if db is not None:
            db.close()
    found = {}
    for cid, created, body in rows:
        state['comment'] = max(state['comment'], cid)
        match = FAILOVER_RE.match(body or '')
        if match and match[1] != match[2] and match[1] in known and match[2] in known \
                and isinstance(created, (int, float)):
            found.setdefault((match[1], match[2]), float(created))  # one record per pair per sample
    return sorted((ts, a, b) for (a, b), ts in found.items())


def _rotate(settings):
    base = Path(settings['history_dir']) / FILE
    try:
        if base.stat().st_size < settings['history_max_bytes']:
            return
    except OSError:
        return
    keep = settings['history_keep']
    if keep <= 0:
        base.unlink()
        return
    oldest = base.with_name(f'{FILE}.{keep}')
    if oldest.exists():
        oldest.unlink()
    for i in range(keep - 1, 0, -1):
        src = base.with_name(f'{FILE}.{i}')
        if src.exists():
            os.replace(src, base.with_name(f'{FILE}.{i + 1}'))
    os.replace(base, base.with_name(f'{FILE}.1'))


def sample_once(settings, now=None):
    """One sample. Returns {'state': ok|absent|busy, 'written': n}. Never raises for
    an unreadable source; raises OSError only if our own data directory is unusable."""
    now = time.time() if now is None else now
    status = read_status(settings['botstatus_path'])
    if status is None:
        return dict(state='absent', written=0)
    directory = Path(settings['history_dir'])
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = _lock(settings, False, 0)
    if fd is None and fcntl is not None:
        return dict(state='busy', written=0)
    try:
        state = _load_state(settings)
        pending = []  # (ts, record without seq)
        for name in sorted(status):
            new, since = status[name]
            old = state['last'].get(name)
            if old == new:
                continue
            state['last'][name] = new
            if old is None and new == 'active':
                continue  # first sight of a healthy bot is a baseline, not an event
            ts = float(since) if isinstance(since, (int, float)) and not isinstance(since, bool) \
                and math.isfinite(since) and now - 86400 <= since <= now else now
            pending.append(dict(v=1, ts=round(ts, 3), type='status', profile=name, status=new, prev=old))
        for ts, a, b in _failovers(settings, state, set(status) | set(state['last'])):
            pending.append(dict(v=1, ts=round(min(ts, now), 3), type='failover', profile=a, to=b))
        pending = pending[:MAX_BATCH]
        lines = []
        for rec in pending:
            state['seq'] = max(state['seq'] + 1, int(now * 1000))
            lines.append(json.dumps(dict(rec, seq=state['seq']), separators=(',', ':')))
        if lines:
            _rotate(settings)
            wfd = os.open(directory / FILE, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
            try:
                os.write(wfd, ('\n'.join(lines) + '\n').encode('utf-8'))
            finally:
                os.close(wfd)
        _save_state(settings, state)  # after the append: a crash can duplicate, never lose
        return dict(state='ok', written=len(lines))
    finally:
        _unlock(fd)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--config', help='Hermes Quest JSON config (default: $HERMES_QUEST_CONFIG)')
    args = parser.parse_args(argv)
    try:
        result = sample_once(load_settings(args.config))
    except (OSError, ValueError) as error:
        print(f'botstatus-history: error {type(error).__name__}', file=sys.stderr)
        return 1
    print(f'botstatus-history: {result["state"]} written={result["written"]}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
