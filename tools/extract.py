#!/usr/bin/env python3
"""Read-only Hermes replay API. Importing this module never reads or writes data.

CLI: extract.py [hours=12] [--config config.json] [--output replay.json]
Cursors are opaque URL-safe strings: source high-water marks plus fingerprints of
mutable rows. Pass them unchanged to collect_since; invalid cursors raise ValueError.
"""
import argparse
import base64
import datetime
import hashlib
import hmac
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import stat
import time
import types
import unicodedata
import zlib

DEFAULTS = {
    'profiles': 'auto', 'captain': 'auto', 'show_titles': False, 'show_profile_names': False,
    'classes': {'developer': 'warrior', 'tester': 'ranger', 'reviewer': 'paladin',
                'devops': 'engineer', 'operator': 'engineer', 'researcher': 'mage',
                'analyst': 'sage'},
    'regions': {'commander': 'castle', 'warrior': 'forge', 'ranger': 'forest',
                'paladin': 'citadel', 'engineer': 'port', 'mage': 'tower', 'sage': 'observatory'},
    'stages': {'sage': 'PLAN', 'mage': 'PLAN', 'warrior': 'BUILD', 'ranger': 'TEST',
               'paladin': 'REVIEW', 'engineer': 'DEPLOY'},
    'stage_regions': {'PLAN': 'observatory', 'BUILD': 'forge', 'TEST': 'forest',
                      'REVIEW': 'citadel', 'DEPLOY': 'port', 'VERIFY': 'forest'},
}
GIT = r'\bgit\s+(commit|push|merge|rebase|checkout|worktree|diff|status|log|pull|fetch)\b'
UTIL = {'skill_view': 'tome', 'tool_search': 'tome', 'tool_describe': 'tome',
        'web_search': 'crystal', 'web_extract': 'crystal', 'mnemosyne_recall': 'memory',
        'mnemosyne_shared_recall': 'memory', 'mnemosyne_forget': 'memory', 'lcm_grep': 'memory',
        'kanban_comment': 'pigeon', 'kanban_create': 'spawn', 'kanban_show': 'scout',
        'kanban_list': 'scout', 'read_file': 'read', 'search_files': 'read'}
CAP_ACT = {'kanban_create': 'create', 'kanban_reassign': 'reassign',
           'kanban_extend_runtime': 'extend', 'kanban_link': 'link', 'kanban_unlink': 'unlink',
           'kanban_unblock': 'unblock', 'kanban_block': 'block', 'kanban_comment': 'note'}
CMD = [('test', r'\b(jest|vitest|go test|pytest|playwright|npm (run )?test|check\.py)\b'),
       ('build', r'\b(npm (run )?build|webpack|tsc|next build|make|go build|docker build)\b'),
       ('deploy', r'\b(kubectl|helm|deploy|ssh|scp|sshpass|jenkins)\b'),
       ('git', r'\bgit\b'), ('probe', r'\b(curl|psql|mysql|wget|sqlite3)\b')]


# --- `working` block (readability-r2 contract A) ---------------------------------
# Every string below is generated here or sanitized; upstream prose never passes through.
QUEST_KIND = {'PLAN': 'planning', 'BUILD': 'build', 'TEST': 'testing', 'REVIEW': 'review',
              'DEPLOY': 'deploy', 'VERIFY': 'verification'}
QUEST_NOUN = {'planning': 'Planning quest', 'build': 'Build quest', 'testing': 'Testing quest',
              'review': 'Review quest', 'deploy': 'Deploy quest',
              'verification': 'Verification quest', 'guild': 'Guild quest'}
ROLE_LABEL = {'warrior': 'Build Warrior', 'ranger': 'Test Ranger', 'paladin': 'Review Paladin',
              'engineer': 'Deploy Engineer', 'mage': 'Research Mage', 'sage': 'Analyst Sage',
              'commander': 'Captain'}
WORK_ORDER = {'running': 0, 'blocked': 1, 'failed': 2, 'unknown': 3, 'done': 4, 'archived': 5}
FAILED_OUTCOMES = {'failed', 'crashed', 'timed_out', 'spawn_failed'}
RETRY_STATUSES = {'ready', 'todo', 'scheduled', 'triage'}
ORDER_LABEL = {'create': 'Assigned quest', 'create_unassigned': 'Created quest',
               'reassign': 'Reassigned quest', 'unblock': 'Unblocked quest',
               'block': 'Blocked quest', 'extend': 'Extended quest runtime',
               'link': 'Linked quests', 'unlink': 'Unlinked quests', 'note': 'Sent quest instruction'}
GROUP_LABEL = 'Other work'     # no safe project mapping exists yet (Captain decision 2026-10-11)
XP_PER_WIN, GOLD_PER_WIN, XP_PER_LEVEL = 10, 1, 100
QUEST_TEXT_MAX = 30            # grapheme clusters


def load_backend_config(path=None):
    """Host-only entry point; CLI/library callers keep their original home scope."""
    return load_config(path, backend=True)


def load_config(path=None, *, backend=False):
    cfg = json.loads(json.dumps(DEFAULTS))
    cfg['hermes_home'] = os.environ.get('HERMES_HOME', '~/.hermes')
    path = path or os.environ.get('HERMES_QUEST_CONFIG')
    custom = {}
    if path:
        with open(os.path.expanduser(str(path)), encoding='utf-8') as f:
            custom = json.load(f)
        if not isinstance(custom, dict):
            raise ValueError('config must be a JSON object')
        cfg.update(custom)
    if backend and 'hermes_home' not in custom:
        history = _history_module()
        if history is None:
            raise ValueError('backend data root unavailable')
        cfg['hermes_home'] = str(history.resolve_data_home(backend=True))
    if not isinstance(cfg['hermes_home'], str) or not cfg['hermes_home'].strip() or '\0' in cfg['hermes_home']:
        raise ValueError('hermes_home must be a non-empty path string')
    cfg['hermes_home'] = str(Path(cfg['hermes_home']).expanduser().resolve())
    if cfg['profiles'] != 'auto' and not isinstance(cfg['profiles'], list):
        raise ValueError('profiles must be auto or a list of profile IDs')
    if not isinstance(cfg['show_titles'], bool):
        raise ValueError('show_titles must be boolean')
    if not isinstance(cfg['show_profile_names'], bool):
        raise ValueError('show_profile_names must be boolean')
    # Presentation permission is injected by the authenticated API, never a file.
    cfg['show_profile_names'] = False
    for p in ([] if cfg['profiles'] == 'auto' else cfg['profiles']) + [cfg['captain']]:
        if not isinstance(p, str) or not re.fullmatch(r'[\w-]+', p):
            raise ValueError('invalid profile ID')
    for key in ('classes', 'regions', 'stages', 'stage_regions'):
        if not isinstance(cfg[key], dict):
            raise ValueError(f'{key} must be an object')
        for name, value in cfg[key].items():
            if not isinstance(name, str) or not re.fullmatch(r'[\w-]+', name):
                raise ValueError(f'{key} keys must be game identifiers')
            if not isinstance(value, str) or not re.fullmatch(r'[\w-]+', value):
                raise ValueError(f'{key}.{name} must be a game identifier string')
            if key == 'classes' and value not in {'warrior', 'ranger', 'paladin', 'engineer', 'mage', 'sage', 'commander'}:
                raise ValueError(f'classes.{name} must be a supported hero class')
            if key == 'stages' and value not in {'PLAN', 'BUILD', 'TEST', 'REVIEW', 'DEPLOY', 'VERIFY'}:
                raise ValueError(f'stages.{name} must be a supported pipeline stage')
    history = _history_module()
    if history:
        history.resolve_settings(cfg)  # botstatus_path/history_* are validated with the rest
    return cfg


def _history_module():
    """tools/botstatus_history.py loaded by path (this file may itself be imported by path,
    with no sys.path entry). Absent file -> None: pause/resume/failover simply do not exist.
    Called only from functions, never at import. Executed from source so no bytecode is written."""
    path = Path(__file__).resolve().with_name('botstatus_history.py')
    try:
        source = path.read_text(encoding='utf-8')
    except OSError:
        return None
    module = types.ModuleType('hermes_quest_botstatus_history')
    module.__file__ = str(path)
    exec(compile(source, str(path), 'exec'), module.__dict__)
    return module


def _normalize_text(value):
    """One alphabet for keys, separators, values and the final token gate.

    Keep JSON containers structural; canonicalize other paired wrappers as
    quotes too (including CJK/ornamental quotes). Drop invisible format chars
    before matching so they cannot split a sensitive label or separator.
    """
    single = "‘’‚‛❛❜"
    double = '❝❞❮❯〝〞〟<>'
    text = unicodedata.normalize('NFKC', str(value or ''))
    return ''.join(
        "'" if char in single else
        '"' if char in double or (unicodedata.category(char) in {'Pi', 'Pf', 'Ps', 'Pe'}
                                  and char not in '[]{}') else char
        for char in text if unicodedata.category(char) != 'Cf')


def redact(s, n=80):
    """Conservative screenshot-safe text. Redact before truncation, never keep suffixes."""
    s = _normalize_text(s)
    # Consume outer paths before an inner URL/IP can destroy their boundaries.
    s = re.sub(r""""(?:[A-Za-z]:[\\/]|\\\\|/)(?:\\.|[^"\\])*"|'(?:[A-Za-z]:[\\/]|\\\\|/)(?:\\.|[^'\\])*'""", '[path]', s)
    # Balanced labeled values may contain spaces inside quotes/braces. Treat
    # comma/semicolon as separators only when an actual next field follows.
    label = r'''(?i)\b(?:(?:[\w-]*[_-])?(?:authorization|token|password|passwd|secret|key|credentials?|api[_-]?key|access[_-]?key)(?:[_-][\w-]+)?|(?:customer|client|account|cust)[-_ ]?id|host|hostname)\b["']?\s*[:=]\s*'''
    pieces, end = [], 0
    for match in re.finditer(label, s):
        if match.start() < end:
            continue
        start = i = match.end()
        scheme = re.match(r'(?i)(?:basic|bearer)\s+', s[i:]) if 'authorization' in match.group().lower() else None
        if scheme:
            i += scheme.end()
        value_start = i
        stack, quote = [], None
        quoted = i < len(s) and s[i] in '\"\''
        while i < len(s):
            char = s[i]
            if char == '\\':
                i += 2
                continue
            if quote:
                if char == quote:
                    quote = None
                    if quoted and not stack:
                        i += 1
                        # A same-quote nested value has no trustworthy end.
                        # Never release its tail as ordinary opt-in prose.
                        if i < len(s) and not (s[i].isspace() or s[i] in ',;}]'):
                            i = len(s)
                        elif re.match(r'''\s+[^,;}]*["']''', s[i:]):
                            i = len(s)
                        break
            elif char in '\"\'':
                if i == value_start or stack:
                    quote = char
                else:
                    break  # Closing quote of an entire quoted assignment.
            elif char in '{[':
                stack.append('}' if char == '{' else ']')
            elif stack and char == stack[-1]:
                stack.pop()
            elif not stack:
                # Unquoted labeled spans have no trustworthy word boundary:
                # ASCII/Unicode whitespace may both separate secret components.
                # Fail closed until a container closes or a real next field starts.
                if char in '}]':
                    break
                if char.isspace() and re.match(r'''\s+["']?[\w-]+["']?\s*[:=]''', s[i:]):
                    break
                if char in ',;' and re.match(r'''[,;]\s*["']?[\w-]+["']?\s*[:=]''', s[i:]):
                    break
            i += 1
        if i > start:
            pieces.extend((s[end:match.start()], '[redacted]'))
            end = min(i, len(s))
    s = ''.join(pieces) + s[end:]
    def ip_replace(m):
        value = m.group().strip('[]').rstrip('.,;')
        try:
            ipaddress.ip_address(value.split('%')[0])
            return '[ip]'
        except ValueError:
            return m.group()
    s = re.sub(r'(?<!\w)(?:\d{1,3}\.){3}\d{1,3}(?!\w)|(?<!\w)\[?[0-9a-fA-F]*:[0-9a-fA-F:.%\w]*\]?', ip_replace, s)
    # Commas are value punctuation unless followed by another labeled field.
    # Quoted values may contain escaped quotes, whitespace and delimiters.
    value = (r'''(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|'''
             r'''[^\s"']+?(?=[;,]\s*["']?[\w-]+["']?\s*[:=]|[\s"']|$))''')
    masked = r'(?i)[\w-]*[x*•]{2,}[\w*•-]*(?:\s+[x*•]{2,}[\w*•-]*)*(?:\s+\d[\w-]*)?|\b\d+[x*•]+[\w*•-]*'
    patterns = [
        (r'(?is)-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----.*?-----END [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----', '[secret]'),
        (r'(?i)\b(?:authorization\b["\']?\s*[:=]?\s*["\']?\s*)?(?:basic|bearer)\s+[^\s"\';}]+', '[secret]'),
        (r'(?i)\b(?:[\w-]*[_-])?(?:authorization|bearer|token|password|passwd|secret|key|credentials?|api[_-]?key|access[_-]?key)(?:[_-][\w-]+)?\b(?!\])["\']?\s*[:=]?\s*' + value, '[secret]'),
        (masked, '[id]'),
        (r'(?i)\b(?:customer|client|account|cust)[-_ ]?id\b["\']?\s*[:=]?\s*' + value, '[id]'),
        (r'(?i)\b(?:host|hostname)\b["\']?\s*[:=]\s*' + value, '[host]'),
        # Consume separated identifiers before path/hostname rules can split them.
        (r'(?i)(?:\b(?:customer|client|account|cust)[-_ ]?(?:id)?\s*[:=]?\s*)?[\w-]*\d(?:[ ._/-]?\d){5,}[\w-]*', '[id]'),
        (r'\b(?:https?|ftp|ssh|file|wss?)://[^\s<>]+|\bwww\.[^\s<>]+', '[url]'),
        (r'(?i)\b(?:[\w-]+\.)+[a-z][\w-]*(?::\d+)?[/?#][^\s<>"\']*', '[url]'),
        (r'[\w.+-]+@[\w.-]+', '[email]'),
        (r""""(?:[A-Za-z]:[\\/]|\\\\|/)(?:\\.|[^"\\])*"|'(?:[A-Za-z]:[\\/]|\\\\|/)(?:\\.|[^'\\])*'""", '[path]'),
        (r'(?<!\w)(?:[A-Za-z]:[\\/]|\\\\)(?:\\[ \t]|[^\s<>"\'])+|(?<![\w:])/(?:\\[ \t]|[^\s<>"\'])+', '[path]'),
        (r'(?i)\b(?:[\w-]+\.)+(?:[a-z][\w-]*)(?::\d+)?\b', '[host]'),
        (r'(?i)\b(?:srv|host|db|uat|sit|prod|internal|server)[-_][\w-]+\b', '[host]'),
        (r'(?i)\b[\w-]+[-_](?:server|db|uat|sit|prod|internal)\b', '[host]'),
        (r'(?i)\b(?:localhost|(?:srv|host|db|uat|sit|prod|server)\d[\w-]*|ip[-_][\d-]+)\b', '[host]'),
        (r'\b(?:sk|ghp|gho|github_pat|AKIA)[-_]?[A-Za-z0-9_\-]{12,}\b|\beyJ[A-Za-z0-9_\-.]+', '[secret]'),
        (r'(?i)\b(?=[A-Za-z0-9_+\-=]{24,}\b)(?=[A-Za-z0-9_+\-=]*[a-z])(?=[A-Za-z0-9_+\-=]*\d)[A-Za-z0-9_+\-=]+', '[secret]'),
    ]
    for pattern, replacement in patterns:
        s = re.sub(pattern, replacement, s)

    s = ' '.join(s.split())
    return s[:n] + ('…' if len(s) > n else '')


# Include every sensitive label handled by redact; substrings intentionally catch
# compound/prefixed labels too. No separator or value boundary is trustworthy.
SENSITIVE_LABELS = (
    'authorization', 'bearer', 'token', 'password', 'passwd', 'secret', 'key',
    'credential', 'apikey', 'accesskey', 'customerid', 'clientid', 'accountid',
    'custid', 'host', 'hostname',
)


def _label_skeleton(value):
    """Decompose before/after casefold so marks cannot hide sensitive labels."""
    normalized = unicodedata.normalize('NFKD', str(value or ''))
    normalized = ''.join(char for char in normalized
                         if unicodedata.category(char)[0] != 'M')
    normalized = unicodedata.normalize('NFKD', normalized.casefold())
    normalized = ''.join(char for char in normalized
                         if unicodedata.category(char)[0] != 'M')
    return ''.join(char for char in normalized
                   if unicodedata.category(char)[0] in 'LN')


def _has_sensitive_label(value):
    # Preserve compatibility spellings. Fail closed on source nonletters that
    # expand to letters/numbers: they may be inserted symbols, not label letters.
    skeleton = _label_skeleton(value)
    if any(label in skeleton for label in SENSITIVE_LABELS):
        return True
    return any(unicodedata.category(char)[0] not in 'LN' and _label_skeleton(char)
               for char in str(value or ''))


def _opt_in_text(value, n=120):
    """Fail closed on the whole text, scanning labels before any span redaction."""
    if _has_sensitive_label(value):
        return '[redacted]'
    # Gate source brackets, not placeholders produced by the span redactor.
    if re.search(r'[\[\]]', _normalize_text(value)):
        return '[redacted]'
    text = redact(value, max(len(str(value or '')), n))
    risky = r'''[=:/\\@{};"']|\d{5,}|(?:[\w-]+\.)+[a-zA-Z][\w-]*'''
    if re.search(risky, text):
        return '[redacted]'
    return text[:n] + ('…' if len(text) > n else '')


def _bot_id(value):
    return 'bot-' + _hash(str(value))[:20] if value else ''


# Source-controlled enumerations: unknown upstream strings never become default text.
TEXT_ENUMS = {
    'kind': {'created', 'assigned', 'claimed', 'spawned', 'heartbeat', 'completed', 'failed',
             'blocked', 'unblocked', 'reassigned', 'promoted', 'scheduled', 'linked', 'unlinked',
             'comment', 'run_start', 'run_end', 'summon', 'tool', 'hurt', 'tests', 'mana', 'compress',
             'captain', 'review_requested', 'changes_requested', 'dependency_wait', 'wake', 'moa',
             'pause', 'resume', 'failover', 'archived'},
    'entity_type': {'profile', 'actor'},
    'actor_type': {'profile', 'commenter', 'unknown'},
    'status': {'triage', 'todo', 'scheduled', 'ready', 'running', 'blocked', 'review', 'done', 'archived',
               'active', 'limited', 'waiting-start', 'unavailable', 'unknown'},
    'why': {'limited', 'waiting-start', 'unavailable'},   # pause cause / the cause a resume ended
    'basis': {'chars', 'usage'},                          # how an estimated mana figure was derived
    'outcome': {'', 'completed', 'failed', 'interrupted', 'timed_out', 'blocked', 'review', 'success'},
    'tool': set(UTIL) | set(CAP_ACT) | {'terminal', 'patch', 'write_file', 'tool', 'delegate_task',
                                      'vision_analyze', 'web_extract', 'execute_code'},
    'effort': {'max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none'},
    'tag': {'', '[failover]', '[extend-done]', '[moa-limit]', '[REASSIGN]'},
    'wallet': {'agy', 'codex', 'claude'},
    'model': {'gpt', 'gemini', 'claude', 'unknown'},
    'campaign': {'quests'},
    'cat': {cat for cat, _ in CMD} | {'shell'},
    'git': {'commit', 'push', 'merge', 'rebase', 'checkout', 'worktree', 'diff', 'status', 'log', 'pull', 'fetch'},
    'util': set(UTIL.values()), 'act': set(CAP_ACT.values()),
}


def ro(path):
    db = sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True, timeout=5)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA query_only=ON')
    db.execute('BEGIN')  # High-water marks and rows use the same database snapshot.
    return db


def _json(value, default):
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value or 'null') or default
    except (ValueError, TypeError):
        return default


def _has_json1(db):
    try:
        db.execute("SELECT json_group_array(json_object('probe',json_extract(value,'$'))) "
                   "FROM json_each(CASE WHEN json_valid('[]') THEN '[]' ELSE '[]' END)").fetchone()
        return True
    except sqlite3.OperationalError:
        return False


def _tool_calls_sql(captain=False, json1=True):
    # Project call identity in SQLite: memory queries/arguments must never be
    # returned to Python merely to classify a generated gesture. Keep order/IDs
    # and retrieve arguments only for real consumers. Without JSON1 omit call
    # gestures (not the replay) rather than load private memory arguments into
    # Python. Terminal results, usage, lifecycle and comments remain available.
    if not json1:
        return "'[]'"
    consumers = {'terminal', 'patch', 'write_file'} | (set(CAP_ACT) if captain else set())
    names = ','.join("'" + name + "'" for name in sorted(consumers))
    return f"""(SELECT json_group_array(json_object(
        '_source_index',key,
        'id',json_extract(value,'$.id'), 'call_id',json_extract(value,'$.call_id'),
        'function',json_object('name',json_extract(value,'$.function.name'),
        'arguments',CASE WHEN json_extract(value,'$.function.name') IN ({names})
                        THEN json_extract(value,'$.function.arguments') END)))
        FROM json_each(CASE WHEN json_valid(tool_calls) THEN tool_calls ELSE '[]' END)
        WHERE type='object')"""


def _latest_order_sql(json1=True):
    # Repeated snapshot reads have no prose consumer. Project only known action
    # names, row/call coordinates and string bindings in SQLite, never full arguments or call IDs.
    window = "FROM messages WHERE role='assistant' AND timestamp>=? AND timestamp<=?"
    if not json1:
        return 'SELECT session_id,timestamp,NULL AS name,NULL AS task_id,' \
               'NULL AS child_id,NULL AS assignee ' + window + ' AND 0'
    names = ','.join("'" + name + "'" for name in sorted(CAP_ACT))
    fields = ','.join(
        f"CASE WHEN json_type(args,'$.{field}')='text' "
        f"THEN json_extract(args,'$.{field}') END AS {field}"
        for field in ('task_id', 'child_id', 'assignee'))
    return f"""WITH calls AS (
        SELECT messages.rowid AS seq,session_id,timestamp,j.key AS call_index,
               CASE WHEN j.type='object' THEN j.value ELSE '{{}}' END AS call
        FROM messages,json_each(CASE WHEN json_valid(tool_calls) THEN tool_calls ELSE '[]' END) AS j
        WHERE role='assistant' AND timestamp>=? AND timestamp<=?
    ), actions AS (
        SELECT seq,session_id,timestamp,call_index,json_extract(call,'$.function.name') AS name,
               CASE WHEN json_valid(json_extract(call,'$.function.arguments'))
                    THEN json_extract(call,'$.function.arguments') ELSE '{{}}' END AS args
        FROM calls WHERE json_extract(call,'$.function.name') IN ({names})
    ) SELECT seq,call_index,session_id,timestamp,name,{fields} FROM actions ORDER BY seq,call_index"""


def _message_columns(captain=False, json1=True):
    # chars is a number only: the size of what the model wrote/received in this message
    # (content + tool-call arguments / tool result), used to estimate mana when Hermes
    # recorded no token_count. Tool results count once, separately from call arguments.
    # Only lengths are projected; result prose is not fetched for mana.
    return ("session_id,role,tool_name,tool_call_id,timestamp,token_count,"
            "CASE WHEN role IN ('assistant','tool') THEN coalesce(length(messages.content),0)"
            "+coalesce(length(messages.tool_calls),0) ELSE 0 END AS chars,"
            "CASE WHEN role='tool' AND tool_name='terminal' THEN content END AS content,"
            + _tool_calls_sql(captain, json1) + " AS tool_calls")


def _hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def _session_key(cfg):
    return _session_key_state(cfg)[0]


def _session_key_state(cfg):
    """Read only: the API owns provisioning; absent/unsafe keys close identity."""
    directory = Path(cfg.get('history_dir') or Path(cfg['hermes_home']) / 'hermes-quest').expanduser()
    fd = directory_fd = None
    try:
        directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        fd = os.open('session-ref.key', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                     dir_fd=directory_fd)
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600
                or info.st_uid != os.getuid() or info.st_size != 32):
            return None, 'key_unsafe'
        key = os.read(fd, 33)
        return (key, None) if len(key) == 32 else (None, 'key_unsafe')
    except FileNotFoundError:
        return None, 'key_missing'
    except (OSError, AttributeError):
        return None, 'key_unsafe'
    finally:
        if fd is not None:
            os.close(fd)
        if directory_fd is not None:
            os.close(directory_fd)


def _session_digest(key, profile, sid):
    return hmac.new(key, b'hermes-quest/session/v2\0' +
                    json.dumps([profile, sid]).encode(), hashlib.sha256).hexdigest() if key else ''


CURSOR_LIMIT = 32768
CURSOR_GRACE = 3600
_CURSOR_MAGIC = b'HQ2\0'


def _varint(value):
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 2 ** 53:
        raise ValueError('invalid Hermes Quest cursor')
    data = bytearray()
    while value >= 128:
        data.append((value & 127) | 128)
        value >>= 7
    data.append(value)
    return data


def _pack_cursor(state):
    # Lossless wire-only change: keep full profile/session hashes and every ledger
    # entry, including temporarily absent sources. Store shared keys once as raw
    # 80-bit hashes rather than two JSON dictionaries of 20-digit hex strings.
    header = dict(state)
    fields = ('mana', 'mana_versions')
    keys = set()
    for field in fields:
        if field in state:
            header[field] = {}
            keys.update(state[field])
    if not keys:
        return json.dumps(state, separators=(',', ':'), sort_keys=True).encode()
    data = json.dumps(header, separators=(',', ':'), sort_keys=True).encode()
    packed = bytearray(_CURSOR_MAGIC + len(data).to_bytes(4, 'big') + data)
    for key in sorted(keys):
        if not re.fullmatch(r'session-[0-9a-f]{20}', key):
            raise ValueError('invalid Hermes Quest cursor')
        flags = sum(1 << i for i, field in enumerate(fields) if key in state.get(field, {}))
        packed.append(flags)
        packed.extend(bytes.fromhex(key[8:]))
        for field in fields:
            if key in state.get(field, {}):
                packed.extend(_varint(state[field][key]))
    return bytes(packed)


def _unpack_cursor(data):
    if not data.startswith(_CURSOR_MAGIC):
        return json.loads(data)  # Existing v1 cursors migrate without a rebase.
    end = 8 + int.from_bytes(data[4:8], 'big')
    if len(data) < 8 or end > len(data):
        raise ValueError()
    state = json.loads(data[8:end])
    fields = ('mana', 'mana_versions')
    if any(field in state and state[field] != {} for field in fields):
        raise ValueError()
    seen = set()
    while end < len(data):
        flags = data[end]
        if flags not in (1, 2, 3) or end + 11 > len(data):
            raise ValueError()
        key = 'session-' + data[end + 1:end + 11].hex()
        if key in seen:
            raise ValueError()
        seen.add(key)
        end += 11
        for i, field in enumerate(fields):
            if not flags & (1 << i):
                continue
            if field not in state:
                raise ValueError()
            value = 0
            for shift in range(0, 56, 7):
                if end >= len(data):
                    raise ValueError()
                byte = data[end]
                end += 1
                value |= (byte & 127) << shift
                if not byte & 128:
                    break
            else:
                raise ValueError()
            state[field][key] = value
    return state


def _cursor(state):
    data = _pack_cursor(state)
    cursor = base64.urlsafe_b64encode(zlib.compress(data)).decode().rstrip('=')
    # Never return a cursor the GET API/guest cannot use. An oversized state must
    # fail closed, not silently evict ledgers or acknowledge undelivered events.
    if len(cursor) > CURSOR_LIMIT:
        raise ValueError('Hermes Quest cursor capacity exceeded')
    return cursor


def _decode(cursor):
    if not cursor:
        return {}
    try:
        if not isinstance(cursor, str) or len(cursor) > 1024 * 1024:
            raise ValueError()
        data = base64.b64decode(cursor + '=' * (-len(cursor) % 4), altchars=b'-_', validate=True)
        decoder = zlib.decompressobj()
        unpacked = decoder.decompress(data, 2 * 1024 * 1024)
        if not decoder.eof or decoder.unused_data:
            raise ValueError()
        state = _unpack_cursor(unpacked)
        hours = state.get('window_hours', 12)
        if isinstance(hours, bool) or not isinstance(hours, (int, float)) or not 0 < hours <= 24 * 365:
            raise ValueError()
        if state.get('v') != 1 or not isinstance(state.get('marks'), dict):
            raise ValueError()
        if any(not isinstance(state.get(key), dict) for key in ('tasks', 'bots', 'runs')):
            raise ValueError()
        for key, value in state['marks'].items():
            values = value if key.startswith('compression-') and isinstance(value, list) and len(value) == 2 else [value]
            if any(not isinstance(v, int) or v < 0 for v in values):
                raise ValueError()
        if not isinstance(state.get('pending', []), list):
            raise ValueError()
        delivered = state.get('delivered', [])
        if not isinstance(delivered, list) or any(not isinstance(seq, str) or not re.fullmatch(r'[0-9]+', seq) for seq in delivered):
            raise ValueError()
        captain_pending = state.get('captain_pending', {})
        if not isinstance(captain_pending, dict) or any(
                not re.fullmatch(r'[0-9]+', seq) or not isinstance(indices, list) or
                any(not isinstance(i, int) or i < 0 for i in indices)
                for seq, indices in captain_pending.items()):
            raise ValueError()
        compression_pending = state.get('compression_pending', [])
        if not isinstance(compression_pending, list) or any(
                not isinstance(e, dict) or not all(isinstance(e.get(k), str) for k in ('source', 'seq', 'session')) or
                not all(isinstance(e.get(k), (int, float)) for k in ('t', 'before', 'after'))
                for e in compression_pending):
            raise ValueError()
        for field in ('mana', 'mana_versions'):
            totals = state.get(field, {})
            if not isinstance(totals, dict) or any(
                    not re.fullmatch(r'session-[0-9a-f]{20}', key) or
                    isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 2 ** 53
                    for key, value in totals.items()):
                raise ValueError()
        return state
    except (ValueError, TypeError, AttributeError, zlib.error):
        raise ValueError('invalid Hermes Quest cursor') from None


def _class(prof, cfg, captain):
    if prof == captain:
        return 'commander'
    return next((c for role, c in cfg['classes'].items() if prof.startswith(role)), 'mage')


def _bot(prof, cfg, captain, entity_type='profile', availability=None, commenter=False):
    root = Path(cfg['hermes_home']) / 'profiles' / prof
    def text(name):
        try:
            return (root / name).read_text(encoding='utf-8')
        except FileNotFoundError:
            return ''
    display = re.search(r'^display_name:\s*(.+)$', text('profile.yaml'), re.M)
    conf = text('config.yaml')
    model = re.search(r'^model:\s*\n(?:[ \t]+.*\n)*?[ \t]+default:\s*(\S+)', conf, re.M)
    effort = re.search(r'^agent:\s*\n((?:[ \t]+.*\n)+)', conf, re.M)
    effort = effort and re.search(r'reasoning_effort:\s*(\S+)', effort.group(1))
    model = model.group(1).strip('"\'') if model else ''
    effort = effort.group(1).strip('"\'') if effort else next(
        (x for x in ('max', 'xhigh', 'high', 'medium', 'low') if model.endswith('-' + x)),
        'high' if 'thinking' in model else 'medium')
    cls = _class(prof, cfg, captain)
    wallet = 'agy' if 'gemini' in model.lower() else 'codex' if any(x in model.lower() for x in ('gpt', 'codex', 'sol')) else 'claude'
    # Default labels are generated, never redacted copies of upstream prose.
    permitted = entity_type == 'profile' and cfg.get('show_profile_names', False)
    profile_name = _opt_in_text(prof) if permitted else None
    display_name = _opt_in_text(display.group(1).strip('"\'')) if permitted and display else None
    name = (display_name or profile_name) if permitted else _bot_id(prof)
    if not cfg['show_titles']:
        model = ('gemini' if 'gemini' in model.lower() else 'gpt' if wallet == 'codex'
                 else 'claude' if 'claude' in model.lower() else 'unknown')
    return dict(id=_bot_id(prof), name=name, entity_type=entity_type,
                actor_type='profile' if entity_type == 'profile' else 'commenter' if commenter else 'unknown',
                profile_name=profile_name, display_name=display_name, pet_name=None,
                availability=availability or dict(status='unknown', observed_at=None),
                cls=cls, region=cfg['regions'].get(cls, cfg['regions'].get('mage', 'tower')),
                wallet=wallet, model=model, effort=effort)


def _iso(stamp):
    if stamp is None:
        return None
    return datetime.datetime.fromtimestamp(float(stamp), datetime.timezone.utc).isoformat(
        timespec='seconds').replace('+00:00', 'Z')


def _order_ref(key, source):
    # Domain-separated keyed identity: no session/call IDs or prose reach the UI.
    # Without the privacy key leave identity absent (legacy clients use their tuple).
    return ('o-' + _session_digest(key, '', 'order:' + json.dumps(source))[:20]) if key else None


def _graphemes(text):
    """Approximate grapheme clusters: a base character plus marks/modifiers/joiners."""
    clusters = []
    for char in text:
        joined = clusters and clusters[-1].endswith('\u200d')
        if clusters and (joined or unicodedata.category(char)[0] == 'M' or
                         unicodedata.category(char) == 'Sk' or char in '\u200d\ufe0e\ufe0f'):
            clusters[-1] += char
        else:
            clusters.append(char)
    return clusters


def _quest_title(raw, profile_ids=()):
    """Opt-in task title -> short action+object text, or None when nothing safe remains.

    Strips project prefixes, task/profile IDs and hash-like words, keeps only the head
    before the first separator, then fails closed through the same gate as every other
    opt-in text. Never returns an ellipsis-free overlong value (<= QUEST_TEXT_MAX clusters).
    """
    text = _normalize_text(raw)
    text = re.sub(r'^\s*(?:\[[^\]]*\]\s*)+', '', text)
    text = re.split(r'\s[-:|]\s|[:|—–]', text, maxsplit=1)[0]
    text = re.sub(r'(?i)\bt_[0-9a-f]{8}\b|\b[0-9a-f]{7,64}\b', ' ', text)
    for profile in sorted((p for p in profile_ids if len(p) >= 3), key=len, reverse=True):
        text = re.sub(re.escape(profile), ' ', text, flags=re.I)
    text = ' '.join(text.split()).strip(' -_.,;')
    if not text or not any(char.isalpha() for char in text):
        return None
    text = _opt_in_text(text, QUEST_TEXT_MAX * 4)
    if text == '[redacted]' or re.search(r'[\[\]…]', text) or not any(c.isalpha() for c in text):
        return None
    clusters = _graphemes(text)
    if len(clusters) > QUEST_TEXT_MAX:
        text = ''.join(clusters[:QUEST_TEXT_MAX - 1]).rstrip() + '…'
    return text


def _display_labels(bot_rows, profiles, captain):
    """One display name per profile: consented alias, else a stable `<Class> <n>` label.
    Never falls back to a profile ID, profile_name or hash."""
    labels, seen_class, used = {}, {}, {}
    for prof in sorted(bot_rows, key=lambda p: (p not in profiles, p)):
        row = bot_rows[prof]
        alias = row.get('display_name')
        if alias and alias != '[redacted]':
            label = alias
        elif prof == captain:
            label = ROLE_LABEL['commander']
        else:
            seen_class[row['cls']] = seen_class.get(row['cls'], 0) + 1
            label = f"{ROLE_LABEL.get(row['cls'], 'Guild Hero')} {seen_class[row['cls']]}"
        used[label.lower()] = used.get(label.lower(), 0) + 1
        labels[prof] = label if used[label.lower()] == 1 else f'{label} {used[label.lower()]}'
    return labels


def _empty_working(as_of):
    return dict(as_of=_iso(as_of), items=[], resting_count=0, latest_order=None,
                progress=dict(wins_today=0, xp=0, gold=0, level=1, level_progress=0))


def _build_working(cfg, as_of, hours, captain, tasks, runs, bot_rows, profiles, captain_events, key):
    """Read-only projection of CURRENT Kanban state (same snapshot as meta.as_of).

    One row per current card, including cards with multiple open runs. The newest
    open run (started_at, then id) supplies the observed worker. Internal bot_ref/task_ref
    match the existing public payload IDs; run_ref is keyed, never a raw run ID.
    No binding/ref may be rendered or stored in DOM attributes."""
    cutoff = as_of - hours * 3600
    labels = _display_labels(bot_rows, set(profiles), captain)
    ordered = sorted(tasks.values(), key=lambda t: t['seq'])
    numbers, counts = {}, {}
    for t in ordered:
        counts[t['kind']] = counts.get(t['kind'], 0) + 1
        numbers[t['id']] = counts[t['kind']]
    profile_ids = set(bot_rows) | set(profiles)

    def quest_label(t):
        generic = f"{QUEST_NOUN[t['kind']]} #{numbers[t['id']]}"
        if cfg['show_titles']:
            title = _quest_title(t['title'], profile_ids)
            return title or generic
        return generic

    def class_of(prof):
        return bot_rows[prof]['cls'] if prof in bot_rows else None

    rows, busy = [], set()
    for t in ordered:
        rs = sorted(runs.get(t['id'], []), key=lambda r: (r['started_at'] or 0, r['id']))
        last = rs[-1] if rs else None
        status = t['status']
        if status == 'failed' or (status in RETRY_STATUSES and last and last['ended_at'] and
                                  last['outcome'] in FAILED_OUTCOMES and last['ended_at'] >= cutoff):
            status = 'failed'
        elif status in ('running', 'blocked', 'done', 'archived'):
            pass
        elif status in RETRY_STATUSES or status == 'review':
            continue  # queued/waiting work is not "current work"
        else:
            status = 'unknown'
        activity = max([t['completed_at'] or 0, t['started_at'] or 0] +
                       [r['ended_at'] or 0 for r in rs])
        if status in ('done', 'archived') and activity < cutoff:
            continue
        if status == 'done' and not t['completed_at']:
            status = 'unknown'  # contradictory source state never earns a win
        open_runs = [r for r in rs if r['ended_at'] is None]
        # Count cards, not attempts. Stale concurrent attempts never duplicate a card.
        for run in [open_runs[-1] if status == 'running' and open_runs else
                    last if status != 'running' else None]:
            prof = (run['profile'] if run and run['profile'] else None) or t['assignee'] or None
            observed = bool(run and run['profile'])
            if status == 'running' and not observed:
                name = 'Worker not observed' if t['assignee'] else 'Unassigned'
                class_label = ROLE_LABEL.get(class_of(t['assignee']) or '', 'Unassigned')
            else:
                name = labels.get(prof) or 'Unassigned'
                class_label = ROLE_LABEL.get(class_of(prof), 'Unassigned') if prof else 'Unassigned'
            if status == 'running':
                busy.add(prof)
                busy.add(t['assignee'])
                busy.update(r['profile'] for r in open_runs if r['profile'])
            rows.append(dict(
                _order=(WORK_ORDER.get(status, 3), -(((run or {}).get('started_at') or t['started_at'] or 0)),
                        t['seq'], (run or {}).get('id') or 0),
                _key=(t['id'], (run or {}).get('id')),
                bot_ref=_bot_id(prof) or None,
                task_ref=t['id'] if re.fullmatch(r'(?:t_[0-9a-f]{8}|e_[0-9a-f]{64}|bot-[0-9a-f]{20})', t['id']) else _bot_id(t['id']),
                run_ref=('r-' + _session_digest(key, '', f"run:{t['id']}:{run['id']}")[:20]) if key and run else None,
                status=status, started_at=_iso((run or {}).get('started_at') or t['started_at']),
                display_name=name, class_label=class_label, quest_label=quest_label(t),
                quest_kind=t['kind'], group_label=GROUP_LABEL, parent_ref=None,
                worker_observed=observed))
    rows.sort(key=lambda r: r['_order'])
    items = []
    for index, row in enumerate(rows, 1):
        task_id, run_id = row.pop('_key')
        row.pop('_order')
        # Card identity survives retries, completion and ordering changes. Without a
        # key, the immutable board ordinal is the permitted non-hash fallback.
        ref = ('w-' + _session_digest(key, '', f'work:{task_id}')[:20]) if key else f"w-{tasks[task_id]['seq']}"
        items.append(dict(ref=ref, **row))

    candidates = []
    if captain:
        candidates += [(t['created_at'], 'create', t['id'], t['assignee'],
                        _order_ref(key, ['create', t['id']])) for t in ordered
                       if t['created_by'] == captain and t['created_at']]
    def action_ref(e):
        if e['act'] == 'create':
            return _order_ref(key, ['create', e['task']])
        return e.get('source_action_ref') or (_order_ref(key, ['event', e['id']]) if e.get('id') else None)

    candidates += [(e['t'], e['act'], e['task'], e.get('bot') or tasks[e['task']]['assignee'], action_ref(e))
                   for e in captain_events if e.get('act') in ORDER_LABEL
                   and e['task'] in tasks]
    candidates = [c for c in candidates if cutoff <= c[0] <= as_of]
    latest_order = None
    if candidates:
        # Calls are projected in row/call order; the last source action wins ties.
        _, (at, act, tid, recipient, source_ref) = max(enumerate(candidates), key=lambda c: (c[1][0], c[1][1], c[0]))
        latest_order = dict(
            source_action_ref=source_ref,
            at=_iso(at), action_label=ORDER_LABEL[act if recipient or act != 'create' else 'create_unassigned'],
            quest_label=quest_label(tasks[tid]), recipient_display_name=labels.get(recipient) if recipient else None,
            recipient_bot_ref=_bot_id(recipient) or None,
            task_ref=next((i['task_ref'] for i in items if i['ref'] ==
                           (('w-' + _session_digest(key, '', f'work:{tid}')[:20]) if key else f"w-{tasks[tid]['seq']}")), None))

    done = [t for t in ordered if t['status'] == 'done' and t['completed_at']
            and t['completed_at'] <= as_of]
    midnight = datetime.datetime.fromtimestamp(as_of).replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
    xp = len(done) * XP_PER_WIN
    progress = dict(wins_today=sum(1 for t in done if midnight <= t['completed_at'] <= as_of),
                    xp=xp, gold=len(done) * GOLD_PER_WIN, level=1 + xp // XP_PER_LEVEL,
                    level_progress=xp % XP_PER_LEVEL)
    resting = {p for p in profiles if p != captain and p not in busy}
    return dict(as_of=_iso(as_of), items=items, resting_count=len(resting),
                latest_order=latest_order, progress=progress)


def _snapshot(cfg, previous=None, t0=None, window_hours=None):
    previous = previous or {}
    hours = window_hours if window_hours is not None else previous.get('window_hours', 12)
    session_key, key_reason = _session_key_state(cfg)
    session_data = dict(status='available' if session_key else 'unavailable', reason=key_reason)
    identity = _session_digest(session_key, '', 'identity-epoch')[:20] if session_key else None
    if previous and (previous.get('identity') != identity or 'identity' not in previous):
        # One authoritative window reset. The client checks config_revision before
        # applying any delta, so old and new mana histories are never added together.
        previous = {}
        t0 = time.time() - hours * 3600
    old = previous.get('marks', {})
    cutoff = time.time() - hours * 3600 - CURSOR_GRACE
    state: dict = dict(v=1, marks=dict(old), runs={}, tasks={}, bots={}, pending=[],
                 window_hours=hours, identity=identity,
                 captain_pending={}, compression_pending=[],
                 mana=dict(previous.get('mana', {})),
                 mana_versions=dict(previous.get('mana_versions', {})))
    marks, events, tasks, task_keys = state['marks'], [], {}, {}
    session_entities, session_lineage = {}, {}
    as_of = time.time()
    home = Path(cfg['hermes_home'])
    captain = cfg['captain'] if cfg['captain'] != 'auto' else ''
    def safe(value, key=''):
        if isinstance(value, str):
            if key == 'source_action_ref':
                return value if re.fullmatch(r'o-[0-9a-f]{20}', value) else None
            if key in ('session_ref', 'parent_session_ref'):
                return value if re.fullmatch(r'[0-9a-f]{20}', value) else None
            if key in ('profile_name', 'display_name', 'pet_name'):
                return _opt_in_text(value) if cfg.get('show_profile_names', False) else None
            if key in TEXT_ENUMS:
                return value if value in TEXT_ENUMS[key] else 'unknown'
            if key in ('id', 'task', 'other', 'parents'):
                if re.fullmatch(r'(?:t_[0-9a-f]{8}|e_[0-9a-f]{64}|bot-[0-9a-f]{20})', value):
                    return value
                return _bot_id(value)
            if key in ('bot', 'author', 'captain'):
                return _bot_id(value)
            if cfg['show_titles']:
                return _opt_in_text(value)
            if key in ('title', 'note', 'name'):
                return value  # Generated by this module only in default mode.
            if key == 'sub' and re.fullmatch(r'[0-9a-f]{6}', value):
                return value
            configured = {'cls': set(cfg['classes'].values()) | {'commander', 'mage'},
                          'region': set(cfg['regions'].values()) | {'tower'},
                          'stage': set(cfg['stages'].values()) | {'BUILD', 'VERIFY'}}
            if value in configured.get(key, set()):
                return _opt_in_text(value)
            return 'unknown'
        if isinstance(value, list):
            return [safe(v, key) for v in value]
        if isinstance(value, dict):
            return {k: safe(v, k) for k, v in value.items()}
        return value
    def meta():
        # Mapping labels are explicit configured game enums, not source free text.
        return dict(captain=_bot_id(captain),
                    **{key: {_opt_in_text(k): _opt_in_text(v) for k, v in cfg[key].items()}
                       for key in ('classes', 'regions', 'stage_regions')},
                    show_titles=cfg['show_titles'], show_profile_names=cfg.get('show_profile_names', False),
                    as_of=as_of, source='live', mock=False,
                    config_revision=_hash([cfg, captain, 'truth-identity-hmac-v2', identity]))
    if previous and 'mana' not in previous:
        # Legacy cursors cannot reconstruct yesterday's evolving usage totals.
        # The revision change makes the production client rebase before accepting
        # any events, rather than guessing what it has already charged.
        return dict(meta=meta(), session_data=session_data, tasks=[], bots=[], sessions=[], events=[],
                    working=_empty_working(as_of), cursor=_cursor(previous))
    path = home / 'kanban.db'
    try:
        path.stat()
    except FileNotFoundError:
        if path.is_symlink():
            raise  # A broken configured source is not an absent database.
        # No board means no live observations. Preserve an existing cursor so a
        # temporarily absent source cannot acknowledge rows or duplicate recovery.
        return dict(meta=meta(), session_data=session_data, tasks=[], bots=[], sessions=[], events=[],
                    working=_empty_working(as_of), cursor=_cursor(previous or state))
    def emit(source, seq, event):
        event['id'] = 'e_' + _hash([source, seq])
        if t0 is None or event['t'] >= t0:
            events.append(event)
    def rows(db, table, source, timestamp, deferred=(), columns='*'):
        hi = db.execute(f'SELECT coalesce(max(rowid),0) FROM {table}').fetchone()[0]
        marks[source] = hi
        for seq in sorted(int(seq) for seq in deferred if int(seq) <= old.get(source, 0)):
            row = db.execute(f'SELECT rowid AS seq,{columns} FROM {table} WHERE rowid=? AND rowid<=?', (seq, hi)).fetchone()
            if row is not None:
                yield row
        yield from db.execute(f'SELECT rowid AS seq,{columns} FROM {table} WHERE rowid>? AND rowid<=?' +
                              (f' AND {timestamp}>=?' if t0 is not None else '') + ' ORDER BY rowid',
                              (old.get(source, 0), hi) + ((t0,) if t0 is not None else ()))
    k = ro(home / 'kanban.db')
    task_activity, active_tasks = {}, set()
    commenters = set()
    raw_tasks, raw_runs = {}, {}   # unsanitized current rows, consumed only by _build_working
    working_captain_events = []   # retained observations, independent of delta delivery
    try:
        commenters = {r[0] for r in k.execute('SELECT DISTINCT author FROM task_comments') if r[0]}
        captain = cfg['captain']
        if captain == 'auto':
            row = k.execute('SELECT created_by,count(*) AS n FROM tasks WHERE created_by IS NOT NULL '
                            'GROUP BY created_by ORDER BY n DESC,created_by LIMIT 1').fetchone()
            captain = row[0] if row else ''
        for row in k.execute('SELECT rowid AS seq,* FROM tasks ORDER BY rowid'):
            r = dict(row); prof = r['assignee'] or ''
            task_activity[r['id']] = max(r['created_at'] or 0, r['started_at'] or 0, r['completed_at'] or 0)
            if r['status'] not in ('done', 'archived'):
                active_tasks.add(r['id'])
            task_keys[r['id']] = str(r['seq'])
            stage = cfg['stages'].get(_class(prof, cfg, captain), 'BUILD')
            if stage == 'TEST' and re.search(r'smoke|verify|retest|หลัง deploy', r['title'], re.I):
                stage = 'VERIFY'
            title = r['title'] if cfg['show_titles'] else f'Quest #{r["seq"]} · {stage}'
            tasks[r['id']] = dict(id=r['id'], title=title, bot=r['assignee'], status=r['status'],
                                  created=r['created_at'], started=r['started_at'], completed=r['completed_at'],
                                  campaign='quests', moa=r.get('provider_override') == 'moa',
                                  max_rt=r.get('max_runtime_seconds') or 1800, parents=[], stage=stage)
            # Snapshot-only tombstone: do not synthesize a historical archive time.
            tasks[r['id']]['tombstone'] = r['status'] == 'archived'
            kind_class = _class(prof, cfg, captain) if prof and prof != captain else None
            raw_tasks[r['id']] = dict(
                id=r['id'], seq=r['seq'], title=r['title'] or '', assignee=prof or None,
                status=r['status'], created_by=r['created_by'], created_at=r['created_at'],
                started_at=r['started_at'], completed_at=r['completed_at'],
                kind=QUEST_KIND.get(stage if kind_class else '', 'guild'))
        for table, timestamp in (('task_events', 'created_at'), ('task_comments', 'created_at'),
                                 ('task_runs', 'started_at'), ('task_runs', 'ended_at')):
            for r in k.execute(f'SELECT task_id,max({timestamp}) AS stamp FROM {table} GROUP BY task_id'):
                task_activity[r['task_id']] = max(task_activity.get(r['task_id'], 0), r['stamp'] or 0)
        for r in k.execute('SELECT * FROM task_links'):
            if r['child_id'] in tasks:
                tasks[r['child_id']]['parents'].append(r['parent_id'])
        def note(tid, kind, raw):
            if cfg['show_titles']:
                return str(raw)
            return f'{tasks.get(tid, {}).get("title", "Quest")} · {kind if kind in TEXT_ENUMS["kind"] else "unknown"}'
        for r in rows(k, 'task_events', 'kanban-events', 'created_at'):
            pl = _json(r['payload'], {})
            if not isinstance(pl, dict):
                pl = {}
            e = dict(t=r['created_at'], task=r['task_id'], kind=r['kind'])
            raw = pl.get('note') or pl.get('summary') or pl.get('reason')
            if raw:
                e['note'] = note(r['task_id'], r['kind'], raw)
            if r['kind'] in ('assigned', 'claimed') and pl.get('assignee'):
                e['bot'] = pl['assignee']
            emit('kanban-events', r['seq'], e)
        for r in rows(k, 'task_comments', 'kanban-comments', 'created_at'):
            body = r['body'] or ''
            tag = next((t for t in ('[failover]', '[extend-done]', '[moa-limit]', '[REASSIGN]') if body.startswith(t)), '')
            emit('kanban-comments', r['seq'], dict(t=r['created_at'], task=r['task_id'], kind='comment',
                 author=r['author'], tag=tag, note=note(r['task_id'], 'comment', body)))
        marks['kanban-runs'] = k.execute('SELECT coalesce(max(id),0) FROM task_runs').fetchone()[0]
        for r in k.execute('SELECT * FROM task_runs'):
            raw_runs.setdefault(r['task_id'], []).append(
                dict(id=r['id'], profile=r['profile'], started_at=r['started_at'],
                     ended_at=r['ended_at'], outcome=r['outcome'] or ''))
            for field, kind in (('started_at', 'run_start'), ('ended_at', 'run_end')):
                key = f'{r["id"]}:{kind}'
                stamp = [r[field], _hash(r['outcome'])[:16] if field == 'ended_at' else None]
                if not r['ended_at']:
                    state['runs'][key] = stamp
                is_new = r['id'] > old.get('kanban-runs', 0)
                was_running = f'{r["id"]}:run_start' in previous.get('runs', {})
                if r[field] and (is_new or (kind == 'run_end' and was_running)):
                    e = dict(t=r[field], task=r['task_id'], kind=kind, bot=r['profile'])
                    if kind == 'run_end':
                        e['outcome'] = r['outcome'] or ''
                    emit('kanban-runs', key, e)
    finally:
        k.close()
    if cfg['profiles'] == 'auto':
        try:
            profiles = sorted(p.name for p in (home / 'profiles').iterdir() if p.is_dir())
        except FileNotFoundError:
            profiles = []
    else:
        profiles = sorted(p for p in cfg['profiles'] if (home / 'profiles' / p).is_dir())
    sid_map, nonworker_sessions = {}, set()
    for prof in profiles:
        path = home / 'profiles' / prof / 'state.db'
        if not path.exists():
            continue
        s = ro(path)
        try:
            json1 = _has_json1(s)
            sessions = {r['id']: dict(r) for r in s.execute('SELECT rowid AS seq,* FROM sessions')}
            def digest(sid):
                return _session_digest(session_key, prof, sid)
            def lineage(sid):
                parent = sessions[sid]['parent_session_id']
                return dict(session_ref=digest(sid)[:20] if session_key else None,
                            parent_session_ref=digest(parent)[:20] if session_key and parent in sessions else None)
            for sid, r in sessions.items():
                session_lineage[digest(sid)] = lineage(sid)
            nonworker_sessions.update(digest(sid) for sid, r in sessions.items()
                                      if r['source'] != 'kanban' and not r['parent_session_id'])
            message_source = 'messages-' + _hash(prof)[:20]
            session_source = 'sessions-' + _hash(prof)[:20]
            message_hi = s.execute('SELECT coalesce(max(rowid),0) FROM messages').fetchone()[0]
            marks[message_source] = message_hi
            message_activity = {r[0]: r[1] for r in s.execute(
                'SELECT session_id,max(timestamp) FROM messages WHERE rowid<=? GROUP BY session_id', (message_hi,))}
            marks[session_source] = max((r['seq'] for r in sessions.values()), default=0)
            mapping, newly_mapped = {}, set()
            for sid, r in sessions.items():
                if r['source'] != 'kanban' or r['parent_session_id']:
                    continue
                first = s.execute("SELECT content,rowid FROM messages WHERE session_id=? AND role='user' ORDER BY rowid LIMIT 1", (sid,)).fetchone()
                match = re.search(r't_[0-9a-f]{8}', (first[0] if first else '') or '')
                root_key = digest(sid)[:20] if session_key else None
                if match and match.group() not in tasks:
                    # Kanban and state.db are separate snapshots. Don't acknowledge
                    # a newly created worker before its task is visible next poll.
                    if root_key:
                        state['pending'].append(root_key)
                if match and match.group() in tasks:
                    mapping[sid] = match.group()
                    if first[1] > old.get(message_source, 0) or root_key in previous.get('pending', []):
                        newly_mapped.add(sid)
            pending = set(sessions) - set(mapping)
            while pending:
                found = {sid for sid in pending if sessions[sid]['parent_session_id'] in mapping}
                if not found:
                    break
                for sid in found:
                    mapping[sid] = mapping[sessions[sid]['parent_session_id']]
                    if sessions[sid]['parent_session_id'] in newly_mapped:
                        newly_mapped.add(sid)
                pending -= found
            # Send the retained window plus its ancestor closure. No lineage ledger
            # goes into the cursor; a delta repeats this bounded authoritative list.
            retained = set()
            for sid, r in sessions.items():
                last = message_activity.get(sid)
                activity = max(r['started_at'] or 0, r.get('ended_at') or 0,
                               r.get('last_activity_at') or 0, last or 0)
                if r.get('ended_at') is None or activity >= cutoff:
                    retained.add(sid)
            todo = list(retained)
            while todo:
                parent = sessions[todo.pop()]['parent_session_id']
                if parent in sessions and parent not in retained:
                    retained.add(parent)
                    todo.append(parent)
            for sid in sorted(retained):
                r = sessions[sid]
                entity = dict(**lineage(sid), bot=prof, task=mapping.get(sid),
                              started_at=r['started_at'], ended_at=r.get('ended_at'),
                              is_subagent=bool(r['parent_session_id']))
                session_entities[(prof, sid)] = entity  # internal only; preserve null-ref rows
            for sid, tid in mapping.items():
                if not session_key:
                    continue  # no unkeyed fallback for event IDs, sub or accounting
                sid_map[(prof, sid)] = tid
                r = sessions[sid]
                source = 'session-' + digest(sid)[:20]
                last_stamp = message_activity.get(sid) or r['started_at']
                activity = max(r['started_at'] or 0, r.get('ended_at') or 0,
                               r.get('last_activity_at') or 0, last_stamp or 0)
                task_activity[tid] = max(task_activity.get(tid, 0), activity)
                retain_mana = r.get('ended_at') is None or activity >= cutoff
                if r['parent_session_id'] and (r.get('title') or '').startswith('Subagent'):
                    if r['seq'] > old.get(session_source, 0) or sid in newly_mapped:
                        emit(source, 'summon', dict(t=r['started_at'], task=tid, kind='summon', bot=prof,
                             **lineage(sid), sub=digest(sid)[:6], note=note(tid, 'summon', r['title'][9:])))
                lower = 0 if sid in newly_mapped else old.get(message_source, 0)
                messages = s.execute(f'SELECT rowid AS seq,{_message_columns(json1=json1)} FROM messages WHERE session_id=? AND rowid>? AND rowid<=?' +
                                     (' AND timestamp>=?' if t0 is not None else '') + ' ORDER BY rowid',
                                     (sid, lower, message_hi) + ((t0,) if t0 is not None else ()))
                usage = None
                if s.execute("SELECT 1 FROM sqlite_master WHERE name='session_model_usage'").fetchone():
                    usage = s.execute('SELECT sum(input_tokens+output_tokens) FROM session_model_usage WHERE session_id=?', (sid,)).fetchone()[0]
                # A cursor carries only hashed session IDs and numeric totals. Never
                # reallocate already delivered message events when usage grows.
                ledger = previous.get('mana', {}).get(source)
                accounted = ledger if ledger is not None else 0
                charged = 0
                for m in messages:
                    base = dict(t=m['timestamp'], task=tid, bot=prof, **lineage(sid))
                    sub = digest(sid)[:6] if r['parent_session_id'] else None
                    for i, call in enumerate(_json(m['tool_calls'], [])):
                        fn = call.get('function') or {}
                        name = fn.get('name') or 'tool'
                        e = dict(base, kind='tool', tool=name)
                        if sub:
                            e['sub'] = sub
                        if name in ('terminal', 'patch', 'write_file'):
                            args = fn.get('arguments') or ''
                            if not isinstance(args, str):
                                args = json.dumps(args)
                        if name == 'terminal':
                            e['cat'] = next((cat for cat, rx in CMD if re.search(rx, args)), 'shell')
                            g = re.search(GIT, args)
                            if g:
                                e['git'] = g.group(1)
                        elif name in UTIL:
                            e['util'] = UTIL[name]
                        elif name in ('patch', 'write_file'):
                            e.update(plus=len(re.findall(r'\\n\+', args)) or args.count('\\n'), minus=len(re.findall(r'\\n-', args)))
                        emit(source, f'{m["seq"]}:tool:{i}', e)
                    if m['role'] == 'tool' and m['tool_name'] == 'terminal':
                        content = m['content'] or ''
                        fail = re.search(r'"exit_code"\s*:\s*(-?\d+)', content)
                        passed = re.search(r'(\d{1,6}) (?:passed|tests? passed)|"tests_passed"\s*:\s*(\d+)', content)
                        if fail and int(fail.group(1)):
                            emit(source, f'{m["seq"]}:hurt', dict(base, kind='hurt', code=int(fail.group(1))))
                        if passed:
                            emit(source, f'{m["seq"]}:tests', dict(base, kind='tests', passed=int(passed.group(1) or passed.group(2))))
                    if m['role'] in ('assistant', 'tool'):
                        last_stamp = max(last_stamp, m['timestamp'])
                        if m['token_count'] and m['token_count'] > 0:
                            charged += m['token_count']
                            emit(source, f'{m["seq"]}:mana', dict(base, kind='mana', tokens=m['token_count']))
                        elif not usage and m['chars']:
                            guess = -(-m['chars'] // 4)
                            charged += guess
                            emit(source, f'{m["seq"]}:mana', dict(
                                base, kind='mana', estimated=True, tokens=guess, basis='chars'))
                returning = ledger is None and previous and sid not in newly_mapped
                if returning:
                    # A returning session has no retained accounting baseline.
                    # Do not recharge its historical usage; new message tokens
                    # still arrive through the global message high-water mark.
                    accounted = usage - charged if usage else 0
                if usage:
                    # Append a signed reconciliation, never mutate an existing ID.
                    # Negative deltas refund an earlier chars estimate when delayed
                    # authoritative usage is smaller; clients retain these numeric
                    # events in the ordinary append/dedup/replay stream.
                    delta = usage - accounted - charged
                    if delta:
                        version = previous.get('mana_versions', {}).get(source, 0) + 1
                        state['mana_versions'][source] = version
                        emit(source, f'usage:{version}:{message_hi}:{accounted}:{usage}:{activity}',
                             dict(t=last_stamp,
                                  task=tid, bot=prof, **lineage(sid), kind='mana', tokens=delta,
                                  estimated=True, basis='usage', correction=True))
                    accounted = usage
                else:
                    accounted += charged
                state['mana'][source] = accounted
                if not retain_mana or (returning and not usage):
                    # Without authoritative usage a returning session has no
                    # reconstructible historical baseline. Keep message marks,
                    # but defer baselining until usage arrives rather than later
                    # charging all of its old usage against a partial total.
                    state['mana'].pop(source, None)
                    state['mana_versions'].pop(source, None)
                if s.execute("SELECT 1 FROM sqlite_master WHERE name='session_model_usage'").fetchone():
                    tok = s.execute('SELECT coalesce(sum(input_tokens+output_tokens),0) FROM session_model_usage WHERE session_id=?', (sid,)).fetchone()[0]
                    tasks[tid]['tokens'] = tasks[tid].get('tokens', 0) + tok
            if prof == captain:
                # A latest-order snapshot cannot be built from just newly delivered
                # events: otherwise every unchanged poll forgets an explicit order.
                # Read only projected Captain calls; never comments/results/prose.
                for m in s.execute(_latest_order_sql(json1), (as_of - hours * 3600, as_of)):
                    if m['session_id'] in mapping:
                        continue
                    act = CAP_ACT.get(m['name'])
                    tid = m['task_id'] or m['child_id']
                    if act and tid in tasks:
                        working_captain_events.append(dict(t=m['timestamp'], task=tid, act=act,
                                                           bot=m['assignee'], source_action_ref=_order_ref(
                                                               session_key, ['call', prof, m['session_id'], m['seq'], m['call_index']])))
                deferred = previous.get('captain_pending', {})
                call_indexes = {}
                def call_index(session_id):
                    # call ID -> (rowid, matching calls) of the earliest row that
                    # names it, built lazily once per session in rowid order.
                    index = call_indexes.get(session_id)
                    if index is None:
                        index = call_indexes[session_id] = {}
                        for a in s.execute(f'SELECT rowid,{_tool_calls_sql(True, json1)} FROM messages WHERE session_id=? AND tool_calls IS NOT NULL ORDER BY rowid', (session_id,)):
                            grouped = {}
                            for c in _json(a[1], []):
                                key = c.get('id') or c.get('call_id')
                                try:
                                    if key and key not in index:
                                        grouped.setdefault(key, []).append(c)
                                except TypeError:
                                    continue  # unhashable ID can never equal a result's call ID
                            for key, found in grouped.items():
                                index[key] = (a[0], found)
                    return index
                for m in rows(s, 'messages', 'captain-messages', 'timestamp', deferred, _message_columns(True, json1)):
                    if m['session_id'] in mapping:
                        continue
                    calls = _json(m['tool_calls'], [])
                    result = None
                    if m['role'] == 'tool' and m['tool_call_id']:
                        # A create call's ID is known only once its result arrives.
                        # The earliest preceding row naming this ID wins. The
                        # per-session index is built once, so a long history is
                        # scanned O(n) rather than once per tool result.
                        first = call_index(m['session_id']).get(m['tool_call_id'])
                        if first and first[0] < m['seq']:
                            found = first[1]
                            calls = found; result = ''
                            if any((c.get('function') or {}).get('name') == 'kanban_create' for c in found):
                                # Some historical result rows omit tool_name;
                                # the matched call, not that nullable column,
                                # proves this result has an actual consumer.
                                result = s.execute('SELECT content FROM messages WHERE rowid=?', (m['seq'],)).fetchone()[0] or ''
                    for i, call in enumerate(calls):
                        # Deferred rows can contain already-delivered actions.
                        if m['seq'] <= old.get('captain-messages', 0) and i not in deferred.get(str(m['seq']), []):
                            continue
                        fn = call.get('function') or {}; act = CAP_ACT.get(fn.get('name'))
                        if not act:
                            continue
                        args = _json(fn.get('arguments'), {})
                        tid = args.get('task_id') or args.get('child_id')
                        if result is not None:
                            if tid:
                                continue
                            match = re.search(r'"(?:task_id|id)"\s*:\s*"(t_[0-9a-f]{8})"', result)
                            tid = match.group(1) if match else None
                        if tid and tid not in tasks:
                            # Keep only row/call coordinates, never raw arguments/results.
                            state['captain_pending'].setdefault(str(m['seq']), []).append(i)
                        if tid in tasks:
                            e = dict(t=m['timestamp'], task=tid, kind='captain', act=act,
                                     source_action_ref=_order_ref(session_key, ['create', tid] if act == 'create' else
                                                                 ['call', prof, m['session_id'], m['seq'], call['_source_index']]),
                                     **lineage(m['session_id']))
                            if args.get('assignee'):
                                e['bot'] = args['assignee']
                            if act == 'link' and args.get('parent_id'):
                                e['other'] = args['parent_id']
                            emit('captain-messages', f'{m["seq"]}:{i}', e)
        finally:
            s.close()
    compression_mapping = {_session_digest(session_key, prof, sid): (tid, prof) for (prof, sid), tid in sid_map.items()}
    compression_seen = set()
    def compression(event):
        key = (event['source'], event['seq'])
        if key in compression_seen or event['session'] in nonworker_sessions:
            return
        compression_seen.add(key)
        target = compression_mapping.get(event['session'])
        if target:
            tid, prof = target
            emit(event['source'], event['seq'], dict(t=event['t'], task=tid, kind='compress',
                 bot=prof, **session_lineage[event['session']], before=event['before'], after=event['after']))
        elif t0 is None or event['t'] >= t0:
            # A complete line is consumed, but not acknowledged as delivered until
            # its session/task is visible across the independent source snapshots.
            state['compression_pending'].append(event)
    for event in previous.get('compression_pending', []):
        compression(event)
    for prof in profiles:
        if not session_key:
            continue  # do not retain a session-derived compression oracle
        path = home / 'profiles' / prof / 'logs' / 'agent.log'
        if not path.exists():
            continue
        source = 'compression-' + _hash(prof)[:20]
        with path.open('rb') as f:
            stat = os.fstat(f.fileno())
            marker = old.get(source, [0, 0])
            offset = marker[1] if marker[0] == stat.st_ino and marker[1] <= stat.st_size else 0
            f.seek(offset)
            while f.tell() < stat.st_size:
                start = f.tell(); line = f.readline(stat.st_size - start)
                if not line.endswith(b'\n'):
                    f.seek(start); break
                match = re.search(r'^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d).*context compression done.*session=(\S+) messages=(\d+)->(\d+)', line.decode(errors='replace'))
                if match:
                    stamp = datetime.datetime.strptime(match[1], '%Y-%m-%d %H:%M:%S').timestamp()
                    compression(dict(source=source, seq=f'{stat.st_ino}:{start}', session=_session_digest(session_key, prof, match[2]),
                                     t=stamp, before=int(match[3]), after=int(match[4])))
            marks[source] = [stat.st_ino, f.tell()]
    history = _history_module()
    if history:
        settings = history.resolve_settings(cfg)
        seen = old.get('botstatus-history', 0)
        records = history.read_records(settings)  # read-only; absent/damaged history -> []
        marks['botstatus-history'] = max([seen] + [r['seq'] for r in records])
        for r in records:
            if r['seq'] <= seen:
                continue
            if r['type'] == 'failover':
                event = dict(t=r['ts'], kind='failover', bot=r['profile'], other=r['to'])
            elif r['status'] != 'active':
                event = dict(t=r['ts'], kind='pause', bot=r['profile'], why=r['status'])
            elif r['prev'] not in (None, 'active'):
                event = dict(t=r['ts'], kind='resume', bot=r['profile'], why=r['prev'])
            else:
                continue
            emit('botstatus-history', r['seq'], event)
    bot_ids = set(profiles) | {t['bot'] for t in tasks.values() if t['bot']} | ({captain} if captain else set())
    bot_ids |= {e[key] for e in events for key in ('bot', 'author') if e.get(key)}
    bot_ids |= {e['other'] for e in events if e['kind'] == 'failover'}
    availability = {}
    if history:
        try:
            data = json.loads(history._read_regular(settings['botstatus_path'], history.MAX_STATUS_BYTES)[0])
            observed = data.get('updated')
            if (not isinstance(observed, bool) and isinstance(observed, (int, float))
                    and math.isfinite(observed) and 0 < observed <= as_of):
                for p, entry in data.get('bots', {}).items():
                    if isinstance(entry, dict) and entry.get('status') in history.STATUSES:
                        availability[p] = dict(status=entry['status'], observed_at=observed)
        except (OSError, ValueError, TypeError, AttributeError):
            pass  # Absent/malformed observation is unknown, never active.

    raw_bots = {p: _bot(p, cfg, captain, 'profile' if p in profiles else 'actor',
                        availability.get(p) if p in profiles else None, p in commenters)
                for p in sorted(bot_ids) if re.fullmatch(r'[\w-]+', p)}
    for p in {r['profile'] for rs in raw_runs.values() for r in rs if r['profile']} | {
            t['assignee'] for t in raw_tasks.values() if t['assignee']}:
        if p not in raw_bots and re.fullmatch(r'[\w-]+', p):
            raw_bots[p] = _bot(p, cfg, captain, 'profile' if p in profiles else 'actor')
    working = _build_working(cfg, as_of, hours, captain, raw_tasks, raw_runs, raw_bots,
                             profiles, working_captain_events + events, session_key)
    # Generated fallback names must survive names-off sanitization, and duplicate
    # alias disambiguation must agree between bot surfaces and working rows.
    display_labels = _display_labels(raw_bots, set(profiles), captain)
    bot_ids.update(raw_bots)
    bots = [raw_bots[p] for p in sorted(bot_ids) if p in raw_bots]
    tasks = [safe(t) for t in tasks.values()]
    bots = safe(bots)
    labels_by_id = {raw_bots[p]['id']: label for p, label in display_labels.items()}
    for bot in bots:
        bot['display_name'] = labels_by_id[bot['id']]
    # Event high-water marks, not task fingerprints, deduplicate events. Keep a
    # snapshot fingerprint/delivery bit only while active, recent or referenced
    # by this response, so a returning task's snapshot accompanies its new event.
    # Retention/fingerprint lookups must use the same safe IDs as payload tasks.
    # Nonstandard source IDs are supported, not silently dropped after sanitizing.
    public_task_id = lambda tid: safe(tid, 'id')
    task_activity = {public_task_id(tid): stamp for tid, stamp in task_activity.items()}
    task_keys = {public_task_id(tid): seq for tid, seq in task_keys.items()}
    active_tasks = {public_task_id(tid) for tid in active_tasks}
    referenced = {public_task_id(e['task']) for e in events if e.get('task')} | {
        public_task_id(e['other']) for e in events if e.get('other') and e.get('task')}
    retained_tasks = {t['id'] for t in tasks if t['id'] in active_tasks or
                      task_activity.get(t['id'], 0) >= cutoff or t['id'] in referenced or
                      (t['tombstone'] and task_keys[t['id']] in previous.get('tasks', {}) and
                       previous['tasks'][task_keys[t['id']]] != _hash(t)[:16])}
    state['tasks'] = {task_keys[t['id']]: _hash(t)[:16] for t in tasks if t['id'] in retained_tasks}
    state['bots'] = {b['id']: _hash(b)[:16] for b in bots}
    changed_tasks = [t for t in tasks if t['id'] in retained_tasks and
                     previous.get('tasks', {}).get(task_keys[t['id']]) != state['tasks'][task_keys[t['id']]]]
    changed_bots = [b for b in bots if previous.get('bots', {}).get(b['id']) != state['bots'][b['id']]]
    # Bot-level events (pause/resume/failover) have no task; failover's `other` is a bot.
    # Older v1 cursors lack delivery tracking: resend first-referenced snapshots
    # rather than assume every fingerprint was actually delivered to the client.
    delivered = set(previous.get('delivered', []))
    if t0 is not None:
        changed_tasks = [t for t in changed_tasks if t['completed'] is None or t['completed'] >= t0 or t['id'] in referenced]
    else:
        changed_ids = {t['id'] for t in changed_tasks}
        changed_tasks += [t for t in tasks if t['id'] in referenced and t['id'] not in changed_ids and task_keys[t['id']] not in delivered]
    state['delivered'] = sorted((delivered | {task_keys[t['id']] for t in changed_tasks}) & set(state['tasks']))
    events = safe(events)
    events.sort(key=lambda e: (e['t'], e['id']))
    return dict(meta=meta(), session_data=session_data, tasks=changed_tasks, bots=changed_bots,
                sessions=safe(list(session_entities.values())), events=events, working=working,
                cursor=_cursor(state))


def build_replay(cfg, hours=12):
    hours = float(hours)
    if not 0 < hours <= 24 * 365:
        raise ValueError('hours must be positive and at most one year')
    now = time.time()
    result = _snapshot(cfg, t0=now - hours * 3600, window_hours=hours)
    result['meta'].update(from_=now - hours * 3600, to=now, hours=hours, generated=now)
    return result


def collect_since(cfg, cursor):
    result = _snapshot(cfg, previous=_decode(cursor))
    # Additive delta schema: the same safe identity/config revision as replay.
    # A client must rebase before accepting rows/cursor under a new revision.
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('hours', nargs='?', type=float, default=12)
    parser.add_argument('--config')
    parser.add_argument('--output', default=str(Path(__file__).resolve().parent.parent / 'data' / 'replay.json'))
    args = parser.parse_args()
    result = build_replay(load_config(args.config), args.hours)
    path = Path(args.output).expanduser()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False)
    print(f'tasks={len(result["tasks"])} bots={len(result["bots"])} events={len(result["events"])}')


if __name__ == '__main__':
    main()
