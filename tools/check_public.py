#!/usr/bin/env python3
"""Fail closed on private material in the tracked tree or HEAD's history.

Reads every tracked file (including binary metadata) and symlink target; never
prints matched values. --history audits every object reachable from HEAD,
not other branches, tags, unreachable objects, or a hosting provider's caches.
"""
import argparse
import hashlib
import io
import ipaddress
from pathlib import Path
import re
import subprocess
import zlib

# Assemble signatures so the guard itself contains no private reference.
RULES = {
    'local-path': re.compile(r'/(?:home|media|Users|root|mnt)/[^\s\'"`|<>),;]*'
                             r'|(?<![\w\\])[A-Za-z]:\\+[^\s\'"`|<>),;]*'),
    'private-key': re.compile(r'-----BEGIN (?P<kind>(?:[A-Z0-9]+ )*PRIVATE KEY)-----'
                              r'(?:.*?-----END (?P=kind)-----)?', re.S),
    'internal-host': re.compile(r'\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?[.])+'
                                r'(?:local|internal|lan)\b(?![\w-])(?!\.[\w-])', re.I),
    'profile-path': re.compile(r'~/' + r'\.hermes/profiles\b', re.I),
    'operator': re.compile('|'.join(('orchestra' + '-captain', 'ap089' + '60695', 'Phaisit' + '-Big')), re.I),
    'network': re.compile(r'\b(?:172[.]22[.]|(?:\d{1,3}[.]){3}\d{1,3}\b)'),
    'github-account': re.compile(
        r'github[.]com/(?!NousResearch/hermes-agent(?:[\s/\)#]|$))[\w-]+'
        r'|\bgh\s+auth\s+(?:token|login|switch)\b[^\n]*--(?:user|hostname)\b'
        r'|\b(?:username|GH_USER|GITHUB_USER)\s*[:=]\s*[\w-]+', re.I),
    'email': re.compile(r'[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}'),
    'token': re.compile(
        r'\bgh[pousr]_[A-Za-z0-9_]+' r'|\bgithub_pat_[A-Za-z0-9_]+'
        r'|\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]+'
        r'|\bAKIA[A-Z0-9]{16}\b|\beyJ[\w-]*[.]eyJ[\w-]*[.][\w-]+'
        r'|\bxox[a-z]+-[A-Za-z0-9-]+|\bAIza[A-Za-z0-9_-]+'
        r'|\bBearer\s+[A-Za-z0-9._-]{10,}', re.I),
}

# Exact synthetic matches, scoped to named test files, NOT whole-file exemptions.
# Escape-built roots keep the policy itself from being a fixture exemption.
HOME = '/' + 'home/'
MEDIA = '/' + 'media/'
WINDOWS = 'C:' + '\\'
FIXTURES = {
    'tools/test_extract.py': {
        HOME + suffix for suffix in (
            '', 'Jane', 'Jane\\', '{a}', '{a}\\', 'demo/customer.txt', 'fake')
    } | {MEDIA + suffix for suffix in ('', 'Fake/demo.json', 'fake/private-campaign', 'fake')}
      | {'192' + '.0.2.1', '192' + '.0.2.42', 'Bearer ' + 'fictionalValue',
         'ey' + 'Jfake.eyJdemo.signature', 'api' + '.internal'}
      | {WINDOWS + suffix for suffix in ('Users\\Jane', 'Users\\Jane\\',
                                         'Users\\{a}', 'Users\\Fake\\customer.txt')}
      | {WINDOWS + '\\Users\\\\Jane'},
    'dashboard/test_live_contract.py': {HOME + '{a}', WINDOWS + 'Users\\{a}'},
}
# Exact hashes of pre-existing fake credential fixtures; no pattern-wide exemption.
TOKEN_FIXTURES = {'tools/test_extract.py': {
    'b1d8f2ce350edc0128d78a9c7f1c6f954bdff24e5eab432899e788a65f7b3154',
    '33ce96b1a9f758b219cbf4e587f18afe44e015fae4343efe2033a3a265f1822b',
    '9accac3b538ed2c3a61ff6778e8269af2cdbac84d542cc7e5b2b2235bd6df170',
}}
PRIVATE_KEY_FIXTURES = {'tools/test_extract.py': {
    'c6bd9404d564496a52ebca6b14206bc939b0093e85a9095d48f3b4e91f83c5b7',
}}

FORBIDDEN = ('data/replay.json', 'preview/', 'assets/raw/', '.claude/', 'RUNBOOK.md', 'HANDOFF.md')

# Release documentation only: exact public destinations, not an account exemption.
# Adding future release versions requires an explicit policy update.
PUBLIC_DOCUMENTATION_URLS = re.compile(
    r'''(?<![^\s'"`<(\[])'''
    + re.escape('https://github.com/' + 'ap089' + '60695/hermes-quest')
    + r'(?:[.]git|/releases/tag/v0[.]1[.]0|/compare/v0[.]1[.]0[.][.][.]HEAD)'
    + r'''(?=$|[\s'"`>)\]])''')

# The explicitly approved public Git identity, only in author/committer headers.
PUBLIC_IDENTITY = ('ap089' + '60695 <17912262+ap089' +
                   '60695@users.noreply.github.com>')


def forbidden_path(path):
    parts = Path(path).parts
    for forbidden in FORBIDDEN:
        sequence = tuple(forbidden.rstrip('/').split('/'))
        if any(parts[i:i + len(sequence)] == sequence for i in range(len(parts))):
            return True
    return any(p == '.env' or p.lower().endswith(('.pem', '.key')) for p in parts)


def permitted(path, rule, value):
    if value in FIXTURES.get(path, set()):
        return True
    if rule == 'token' and hashlib.sha256(value.encode()).hexdigest() in TOKEN_FIXTURES.get(path, set()):
        return True
    if rule == 'private-key' and hashlib.sha256(value.encode()).hexdigest() in PRIVATE_KEY_FIXTURES.get(path, set()):
        return True
    if rule == 'network':
        try:
            address = ipaddress.ip_address(value)
        except ValueError:
            return False
        return address.is_loopback or address.is_unspecified
    if rule == 'email':
        domain = value.rsplit('@', 1)[1].lower()
        return (domain == 'example' or domain.startswith('example.')
                or domain in {'noreply.github.com', 'users.noreply.github.com'})
    return False


def scan_text(path, text):
    findings = []
    public_spans = ([match.span() for match in PUBLIC_DOCUMENTATION_URLS.finditer(text)]
                    if path in {'README.md', 'CHANGELOG.md'} else [])
    for rule, pattern in RULES.items():
        for match in pattern.finditer(text):
            # Exempt only account signatures wholly inside a validated URL;
            # keep every other rule and nearby occurrence independently scanned.
            if rule in {'operator', 'github-account'} and any(
                    start <= match.start() and match.end() <= end
                    for start, end in public_spans):
                continue
            if not permitted(path, rule, match.group()):
                findings.append((path, text.count('\n', 0, match.start()) + 1, rule))
    return findings


def readable_text(raw):
    # PNG pixels are compressed random bytes, not text. Scan their metadata,
    # including compressed text chunks, instead of inventing email/token hits.
    if raw.startswith(b'\x89PNG\r\n\x1a\n'):
        texts, offset = [], 8
        while offset < len(raw):
            size = int.from_bytes(raw[offset:offset + 4], 'big')
            kind = raw[offset + 4:offset + 8]
            payload = raw[offset + 8:offset + 8 + size]
            if offset + size + 12 > len(raw):
                raise ValueError('truncated PNG chunk')
            if kind == b'zTXt':
                keyword, compressed = payload.split(b'\0', 1)
                payload = keyword + b'\0' + zlib.decompress(compressed[1:])
            elif kind == b'iTXt':
                keyword, remainder = payload.split(b'\0', 1)
                compressed, method = remainder[:2]
                language, translated, text = remainder[2:].split(b'\0', 2)
                payload = b'\0'.join((keyword, language, translated,
                                      zlib.decompress(text) if compressed else text))
            if kind not in {b'IDAT', b'IHDR', b'PLTE', b'tRNS', b'IEND'}:
                texts.append(payload)
            offset += size + 12
        raw = b'\n'.join(texts)
    try:
        return raw.decode('utf-8')
    except UnicodeDecodeError:
        # Preserve ASCII signatures in other binary formats and invalid UTF-8.
        return raw.decode('latin-1')


def scan_repository(root):
    result = subprocess.run(['git', 'ls-files', '-z'], cwd=root, check=True, capture_output=True)
    paths = [p.decode('utf-8', 'surrogateescape') for p in result.stdout.split(b'\0') if p]
    findings = []
    for path in paths:
        if forbidden_path(path):
            findings.append((path, 0, 'private-file'))
        file = root / path
        try:
            # Latin-1 fallback keeps ASCII signatures visible inside binary files.
            raw = str(file.readlink()).encode() if file.is_symlink() else file.read_bytes()
            findings.extend(scan_text(path, readable_text(raw)))
        except (OSError, ValueError, zlib.error):
            findings.append((path, 0, 'unreadable-file'))
    return paths, findings


def scan_commit(oid, raw):
    headers, separator, message = raw.partition(b'\n\n')
    identity = re.compile(rb'(author|committer) ' + re.escape(PUBLIC_IDENTITY.encode())
                          + rb' [0-9]+ [+-][0-9]{4}')
    # Do not exempt messages, arbitrary noreply names, or any other header.
    headers = b'\n'.join(b'public contributor <public@users.noreply.github.com>'
                         if identity.fullmatch(line) else line
                         for line in headers.split(b'\n'))
    return scan_text('commit:' + oid, readable_text(headers + separator + message))


def scan_history(root):
    def git(*args, **kwargs):
        return subprocess.run(['git', '--no-replace-objects', *args], cwd=root, check=True,
                              capture_output=True, **kwargs).stdout

    # A shallow clone cannot prove that all ancestors have been audited.
    if git('rev-parse', '--is-shallow-repository').strip() != b'false':
        raise ValueError('shallow history')
    oids = git('rev-list', '--objects', '--no-object-names', 'HEAD').splitlines()
    stream = io.BytesIO(git('cat-file', '--batch', input=b'\n'.join(oids) + b'\n'))
    objects = {}
    for expected in oids:
        oid, kind, size = stream.readline().split()
        raw = stream.read(int(size))
        if oid != expected or len(raw) != int(size) or stream.read(1) != b'\n':
            raise ValueError('invalid Git object stream')
        objects[oid.decode()] = (kind, raw)

    findings, roots, blob_paths = [], set(), {}
    for oid, (kind, raw) in objects.items():
        if kind == b'commit':
            findings.extend(scan_commit(oid, raw))
            roots.add(raw.split(b'\n', 1)[0].removeprefix(b'tree ').decode('ascii'))
    for tree in sorted(roots):
        # rev-list gives only one name per object. Enumerate every tree to catch
        # the same blob reused at both a permitted fixture and a private path.
        for entry in git('ls-tree', '-r', '-z', '--full-tree', tree).split(b'\0'):
            if not entry:
                continue
            metadata, name = entry.split(b'\t', 1)
            mode, kind, oid = metadata.split()
            path = name.decode('utf-8', 'surrogateescape')
            label = 'history-path:' + hashlib.sha256(name).hexdigest()
            findings.extend((label, line, rule) for _, line, rule in scan_text('', path))
            if forbidden_path(path):
                findings.append((label, 0, 'private-file'))
            if kind == b'blob':
                blob_paths.setdefault(oid.decode(), set()).add(path)
            elif kind == b'commit':
                findings.append((label, 0, 'unaudited-submodule'))
    for oid, (kind, raw) in objects.items():
        if kind != b'blob':
            continue
        try:
            text = readable_text(raw)
            for path in sorted(blob_paths.get(oid, {''})):
                findings.extend(('blob:' + oid, line, rule)
                                for _, line, rule in scan_text(path, text))
        except (ValueError, zlib.error):
            findings.append(('blob:' + oid, 0, 'unreadable-file'))
    return objects, findings


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--history', action='store_true', help='audit all objects reachable from HEAD')
    args = parser.parse_args(argv)
    try:
        paths, findings = (scan_history if args.history else scan_repository)(args.root.resolve())
    except (OSError, ValueError, subprocess.CalledProcessError):
        print('FAIL check_public: cannot audit complete history' if args.history
              else 'FAIL check_public: cannot enumerate tracked files')
        return 2
    for path, line, rule in findings:
        print(f'{path}:{line}: {rule}')
    scope = 'reachable objects' if args.history else 'tracked files'
    print(f'{"FAIL" if findings else "PASS"} check_public: {len(paths)} {scope}; {len(findings)} findings')
    return 1 if findings else 0


if __name__ == '__main__':
    raise SystemExit(main())
