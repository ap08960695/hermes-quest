#!/usr/bin/env python3
"""Synthetic fixtures only: privacy, read-only imports, and incremental boundaries."""
import importlib.util
import json
import os
import random
import re
import string
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
import unicodedata
from unittest.mock import patch

import extract


# Each fixture lists every sensitive component, including partial suffixes.
PRIVACY_CASES = [
    ('portal.example.test:443?session=FictionalCredential', ('portal', 'FictionalCredential')),
    ('portal.example.test#customer=FictionalCustomer', ('portal', 'FictionalCustomer')),
    ('portal.example.test/private?session=FictionalCredential#FictionalCustomer',
     ('portal', 'private', 'FictionalCredential', 'FictionalCustomer')),
    ('"/home/Jane Doe/private/reports.csv"', ('Jane', 'Doe', 'private', 'reports')),
    ("'/home/Jane Doe/private/reports.csv'", ('Jane', 'Doe', 'private', 'reports')),
    (r'"C:\Users\Jane Doe\Documents\private-data.txt"', ('Jane', 'Doe', 'Documents', 'private-data')),
    (r'"C:\\Users\\Jane Doe\\Documents\\private-data.txt"', ('Jane', 'Doe', 'Documents', 'private-data')),
    (r'/home/Jane\ Doe/private/reports.csv', ('Jane', 'Doe', 'private', 'reports')),
    ('customer ID: ABCD-1234-EFGH-5678', ('ABCD', '1234', 'EFGH', '5678')),
    ('customer_id=FICTIONAL-QZ-WR-TY-OP', ('FICTIONAL', 'QZ-WR-TY-OP')),
    ('card **** **** **** 5678', ('5678',)),
    ('customer ID XXXX XXXX 5678', ('5678', 'XXXX')),
    ('password=Fictional,Credential', ('Fictional', 'Credential')),
    ('token=Fictional,Credential', ('Fictional', 'Credential')),
    (r'password="Fictional,Credential \"Suffix\""', ('Fictional', 'Credential', 'Suffix')),
    (r"token='Fictional,Credential \'Suffix\''", ('Fictional', 'Credential', 'Suffix')),
    ('password=Fictional,Credential,user=demo', ('Fictional', 'Credential')),
    ('{"password":"Fictional,Credential","count":42}', ('Fictional', 'Credential')),
    ('host=payments-core-01', ('payments-core-01',)),
    ('hostname: prodweb01', ('prodweb01',)),
    ('"password=Fictional,Credential"', ('Fictional', 'Credential')),
    ('"customer_id=FICTIONAL-QZ-WR-TY-OP"', ('FICTIONAL', 'QZ-WR-TY-OP')),
    ('"host=payments-core-01"', ('payments-core-01',)),
    ('password=Fictional{Credential}', ('Fictional', 'Credential')),
    ('token=Fictional;Credential', ('Fictional', 'Credential')),
    ('password={Fictional {Credential Suffix}}', ('Fictional', 'Credential', 'Suffix')),
    ('"/home/Jane Doe/private/www.example.test/path"', ('Jane', 'Doe', 'private', 'example')),
    (r'"C:\Users\Jane Doe\www.example.test\reports.csv"', ('Jane', 'Doe', 'example', 'reports')),
    (r'"C:\\Users\\Jane Doe\\www.example.test\\reports.csv"', ('Jane', 'Doe', 'example', 'reports')),
    (r'/home/Jane\ Doe/private/www.example.test/path', ('Jane', 'Doe', 'private', 'example')),
    (r'C:\Users\Jane\ Doe\www.example.test\reports.csv', ('Jane', 'Doe', 'example', 'reports')),
    ('Authorization: Basic Zm9vOmJhcg==', ('Zm9vOmJhcg',)),
    ('Authorization: Basic "Fictional Credential"', ('Fictional', 'Credential')),
    ('"Authorization: Bearer Fictional;Credential"', ('Fictional', 'Credential')),
]


def generated_privacy_cases():
    """Seeded property coverage across punctuation, nested scopes and compositions."""
    rng = random.Random(603)
    templates = [
        '"password={a},{b}"', "'customer_id={a}-{b}'", 'token={a};{b}',
        'password={a}{{{b}}}', 'password={{{a} {{{b}}}}}',
        'password="{a} \\"{b}\\"",user=demo',
        '"/home/{a} {b}/private/www.example.test/path"',
        r'"C:\Users\{a} {b}\www.example.test\reports.csv"',
        r'/home/{a}\ {b}/www.example.test/path',
        'portal.example.test:443?session={a}#customer={b}',
        'host="{a}-{b}";count=42',
    ]
    for index in range(110):
        a, b = [''.join(rng.choices(string.ascii_uppercase, k=14)) for _ in range(2)]
        yield templates[index % len(templates)].format(a=a, b=b), (a, b)


UNICODE_KEY_CASES = [
    ('{“password”: “FICTIONAL SUFFIX”}', ('FICTIONAL', 'SUFFIX')),
    ('「customer_id」：「FICTIONAL SUFFIX」', ('FICTIONAL', 'SUFFIX')),
    ('‘token’＝‘FICTIONAL SUFFIX’', ('FICTIONAL', 'SUFFIX')),
    ('«api_key»：«FICTIONAL SUFFIX»', ('FICTIONAL', 'SUFFIX')),
    ('password＝FICTIONAL SUFFIX', ('FICTIONAL', 'SUFFIX')),
    ('password：FICTIONAL SUFFIX', ('FICTIONAL', 'SUFFIX')),
    ('＂ｐａｓｓｗｏｒｄ＂：＂FICTIONAL SUFFIX＂', ('FICTIONAL', 'SUFFIX')),
    ('“pass\u200bword\u2060”\ufeff： “FICTIONAL SUFFIX”', ('FICTIONAL', 'SUFFIX')),
    ('password="FICTIONAL "NESTED" SUFFIX', ('FICTIONAL', 'NESTED', 'SUFFIX')),
    ('password="FICTIONAL " NESTED" SUFFIX', ('FICTIONAL', 'NESTED', 'SUFFIX')),
    ('password=‟FICTIONAL ‟NESTED” SUFFIX', ('FICTIONAL', 'NESTED', 'SUFFIX')),
]


def combining_mark_privacy_cases():
    """Every label position, including marks that compose with Latin letters."""
    labels = ('authorization', 'bearer', 'token', 'password', 'passwd', 'secret',
              'key', 'credential', 'apikey', 'accesskey', 'customerid', 'clientid',
              'accountid', 'custid', 'host', 'hostname')
    for label in labels:
        for position in range(len(label)):
            for mark in ('\u0300', '\u0301', '\u0302', '\u0303', '\u0308', '\u0327', '\u030c', '\u0345'):
                spelling = label[:position + 1] + mark + label[position + 1:]
                yield spelling + ' ZQXWVUTSRPNMLJ', ('ZQXWVUTSRPNMLJ',)


class RedactionTests(unittest.TestCase):
    def test_all_nonletter_code_points_inside_every_sensitive_label(self):
        # Exercise the production skeleton gate, not millions of redundant regex
        # passes; representative full replay/delta coverage lives below.
        started = time.perf_counter()
        points = checks = 0
        for code in range(0x110000):
            if 0xD800 <= code <= 0xDFFF:
                continue
            char = chr(code)
            if unicodedata.category(char)[0] not in 'MCZPS':
                continue
            points += 1
            for label in extract.SENSITIVE_LABELS:
                middle = len(label) // 2
                text = label[:middle] + char + label[middle:] + ' ZQXWVUTSRPNMLJ'
                if not extract._has_sensitive_label(text):
                    self.fail(f'U+{code:04X} inserted into {label} evades the privacy gate')
                checks += 1
        print(f'Exhaustive Unicode {unicodedata.unidata_version}: '
              f'{points} code points, {checks} label checks, '
              f'{time.perf_counter() - started:.3f}s', flush=True)

    def test_nonletter_insertions_full_opt_in_path(self):
        # Include symbols that compatibility normalization turns into letters,
        # and compatibility punctuation (U+2034 decomposes to three primes).
        for code in (0x0345, 0x20A8, 0x2103, 0x2121, 0x24D0, 0x2034,
                     0x200B, 0x00A0, 0x1F600, 0x10FFFF):
            for label in extract.SENSITIVE_LABELS:
                middle = len(label) // 2
                text = label[:middle] + chr(code) + label[middle:] + ' ZQXWVUTSRPNMLJ'
                with self.subTest(code=code, label=label):
                    self.assertEqual(extract._opt_in_text(text), '[redacted]')
        for text in ('ⓟas℃sword ZQXWVUTSRPNMLJ', 'ordinary ℃ words'):
            self.assertEqual(extract._opt_in_text(text), '[redacted]')
        self.assertEqual(extract._opt_in_text('ordinary 😀 words'), 'ordinary 😀 words')

    def test_combining_marks_at_every_label_position(self):
        for text, fragments in combining_mark_privacy_cases():
            with self.subTest(text=text):
                self.assertEqual(extract._opt_in_text(text), '[redacted]')
        for text in ('passwórd ZQXWVUTSRPNMLJ', 'PrIVATE_KEỸ ZQXWVUTSRPNMLJ',
                     'ＴＯＫＥＮ\u0301 ZQXWVUTSRPNMLJ', 'apİkey ZQXWVUTSRPNMLJ'):
            with self.subTest(text=text):
                self.assertEqual(extract._opt_in_text(text), '[redacted]')
        for text in ('ordinary words 42 tasks', 'Café improvements', 'ปรับปรุงหน้าเกม'):
            self.assertEqual(extract._opt_in_text(text), text)

    def test_unicode_keys_separators_and_nested_tail(self):
        for text, parts in UNICODE_KEY_CASES:
            with self.subTest(text=text):
                for output in (extract.redact(text, 1000), extract._opt_in_text(text, 1000)):
                    for part in parts:
                        self.assertNotIn(part, output)
        self.assertEqual(extract.redact('password="A "B" C'), '[redacted]')
        self.assertIn('"count":42', extract.redact('{“password”: “A B”, “count”：42}'))
        self.assertEqual(extract._opt_in_text('ordinary words 42 tasks'), 'ordinary words 42 tasks')

    def test_sensitive_fixtures(self):
        samples = [
            'https://service.example/path?token=fake', 'http://192.0.2.1:9000/',
            'ftp://files.example/demo', 'www.example.test', '192.0.2.42',
            '2001:db8::42', '[2001:db8:12345678::1]', '::ffff:192.0.2.1', 'fe80::1%eth0',
            '/home/demo/customer.txt', '/media/Fake/demo.json', '/etc/credentials',
            r'C:\Users\Fake\customer.txt', r'\\fake-server\share\demo',
            'alice@example.test', 'api.internal', 'srv-example', 'example-uat',
            'localhost', 'srv01', 'ip-192-0-2-1',
            '1234567890123', 'account 123-456-789', '123_456_789', 'CUST-00012345',
            'CUST-***1234', 'XX123456', '1234xxxx5678',
            'token=fictionalValue', 'password: fictionalValue', 'api_key = fictionalValue',
            'Bearer fictionalValue', 'ghp_FakeToken0123456789ABCDE',
            '{"password": "fictionalValue"}', "{'api_key': 'fictionalValue with spaces'}",
            'client_secret=fictionalValue', 'private_key: fictionalValue',
            '-----BEGIN RSA PRIVATE KEY-----\nfictionalValue\n-----END RSA PRIVATE KEY-----',
            'sk-FakeToken0123456789ABCDE', 'eyJfake.eyJdemo.signature',
            'AbcDEfgh012345678901234567890ABCDE',
        ]
        for sample in samples:
            with self.subTest(sample=sample):
                value = extract.redact(sample, 1000)
                self.assertNotEqual(value, sample)
                self.assertNotIn('fictionalValue', value)
                self.assertNotIn('12345678', value)
                self.assertNotRegex(value, r'https?://|/home/|/media/|192\.0\.2\.')

    def test_complete_privacy_components_and_structured_boundaries(self):
        for text, fragments in PRIVACY_CASES:
            with self.subTest(text=text):
                redacted = extract.redact(text, 1000)
                self.assertEqual(extract.redact(redacted, 1000), redacted)
                for fragment in fragments:
                    self.assertNotIn(fragment, redacted)
        self.assertIn('user=demo', extract.redact('password=Fictional,Credential,user=demo'))
        self.assertIn('"count":42', extract.redact('{"password":"Fictional,Credential","count":42}'))
        self.assertEqual(extract.redact('payments-core-01 finished 42 tasks'),
                         'payments-core-01 finished 42 tasks')

    def test_safe_text_and_truncation(self):
        self.assertEqual(extract.redact('Quest #7 · BUILD'), 'Quest #7 · BUILD')
        self.assertEqual(extract.redact('gpt-6.1-sol'), 'gpt-6.1-sol')
        self.assertEqual(extract.redact('test passed 42'), 'test passed 42')
        self.assertEqual(extract.redact('https://example.test/secret', 5), '[url]')

    def test_labeled_unicode_and_ambiguous_word_boundaries_fail_closed(self):
        for text in ('token=«FICTIONAL PREFIX SUFFIX»', 'password=“FICTIONAL PREFIX SUFFIX”',
                     'customer ID: 「FICTIONAL PREFIX SUFFIX」', 'password=FICTIONAL\u00a0SUFFIX',
                     'password=FICTIONAL SUFFIX', 'password=FICTIONAL\nSUFFIX',
                     'token=❝FICTIONAL SUFFIX❞', 'token=«FICTIONAL SUFFIX',
                     'credentials={“FICTIONAL SUFFIX”}'):
            for output in (extract.redact(text, 1000), extract._opt_in_text(text, 1000)):
                self.assertNotIn('FICTIONAL', output)
                self.assertNotIn('SUFFIX', output)
        self.assertEqual(extract.redact('harmless prose 42 tasks'), 'harmless prose 42 tasks')
        self.assertIn('count=42', extract.redact('password=FICTIONAL SUFFIX count=42'))
        self.assertIn('finished 42 tasks', extract.redact('token=«FICTIONAL SUFFIX» finished 42 tasks'))

    def test_generated_complete_components_direct_and_fail_closed(self):
        for text, fragments in generated_privacy_cases():
            with self.subTest(text=text):
                for output in (extract.redact(text, 1000), extract._opt_in_text(text, 1000)):
                    for fragment in fragments:
                        self.assertNotIn(fragment, output)
        for text in ('user=demo', 'count:42', 'hello@there', 'x/y', 'x\\y', '{hello}',
                     '[ordinary]', 'ordinary[', 'ordinary]',
                     'semi;colon', '"word"', "'word'", 'abc12345def', 'other.example.test'):
            self.assertNotIn(text, extract._opt_in_text(text))
        self.assertEqual(extract._opt_in_text('ordinary words 42 tasks'), 'ordinary words 42 tasks')

    def test_mock_is_synthetic_and_reproducible(self):
        # Execute in a disposable directory, with a poisonous old replay present.
        import shutil
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'tools').mkdir()
            (root / 'data').mkdir()
            for name in ('mock.py', 'extract.py'):
                shutil.copyfile(Path(extract.__file__).parent / name, root / 'tools' / name)
            sentinel = 'THIS IS NOT JSON: DO NOT READ LIVE REPLAY'
            (root / 'data' / 'replay.json').write_text(sentinel)
            command = [sys.executable, '-B', str(root / 'tools' / 'mock.py')]
            first = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(first.returncode, 0, first.stderr)
            data = (root / 'data' / 'demo.json').read_bytes()
            second = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertEqual(data, (root / 'data' / 'demo.json').read_bytes())
            self.assertEqual((root / 'data' / 'replay.json').read_text(), sentinel)
            demo = json.loads(data)
            self.assertEqual(demo['meta']['source'], 'demo')
            self.assertTrue(all(x['mock'] for key in ('bots', 'tasks', 'events') for x in demo[key]))
            self.assertTrue(all(b['id'].startswith('demo-') for b in demo['bots']))
            self.assertTrue({'run_start', 'tool', 'completed', 'blocked', 'unblocked', 'summon',
                             'moa', 'comment', 'run_end', 'wake', 'compress', 'captain'} <= {e['kind'] for e in demo['events']})

    def test_import_does_not_touch_sources_or_output(self):
        path = Path(extract.__file__).resolve()
        program = '''import importlib.util,sys,builtins,sqlite3,pathlib,os
sys.dont_write_bytecode=True
import argparse,base64,datetime,hashlib,ipaddress,json,re,time,zlib
def forbidden(*a,**k): raise AssertionError('import side effect')
builtins.open=forbidden
sqlite3.connect=forbidden
pathlib.Path.read_text=forbidden
pathlib.Path.mkdir=forbidden
os.makedirs=forbidden
sys.argv=['unrelated-client','--unrelated-option']
spec=importlib.util.spec_from_file_location('probe',sys.argv[0] if False else %r)
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
assert callable(module.build_replay) and callable(module.collect_since)
''' % str(path)
        result = subprocess.run([sys.executable, '-B', '-c', program], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, '')


class AbsentSourceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        with patch.dict(os.environ, {'HERMES_HOME': str(self.root), 'HERMES_QUEST_CONFIG': ''}):
            self.cfg = extract.load_config()
        self.cfg.update(captain='planner-fixture', classes={'developer': 'sage'},
                        regions={'sage': 'custom-place'}, stage_regions={'BUILD': 'custom-place'})

    def test_empty_or_fictitious_home_has_meta_no_data_and_no_writes(self):
        for name in ('empty', 'nonexistent'):
            home = self.root / name
            if name == 'empty':
                home.mkdir()
            for profiles in ([], 'auto'):
                with self.subTest(name=name, profiles=profiles):
                    cfg = dict(self.cfg, hermes_home=str(home), profiles=profiles)
                    before = set(self.root.rglob('*'))
                    replay = extract.build_replay(cfg, 12)
                    self.assertEqual([replay[k] for k in ('tasks', 'bots', 'events')], [[], [], []])
                    self.assertEqual(replay['meta']['captain'], extract._bot_id(cfg['captain']))
                    for key in ('classes', 'regions', 'stage_regions', 'show_titles'):
                        self.assertEqual(replay['meta'][key], cfg[key])
                    self.assertEqual(replay['meta']['source'], 'live')
                    self.assertFalse(replay['meta']['mock'])
                    delta = extract.collect_since(cfg, replay['cursor'])
                    self.assertEqual(delta['meta'], {k: v for k, v in replay['meta'].items()
                                                   if k not in ('from_', 'to', 'hours', 'generated')})
                    self.assertEqual([delta[k] for k in ('tasks', 'bots', 'events')], [[], [], []])
                    self.assertEqual(delta['cursor'], replay['cursor'])
                    self.assertEqual(extract.collect_since(cfg, delta['cursor']), delta)
                    self.assertEqual(before, set(self.root.rglob('*')))
                    self.assertFalse((home / 'kanban.db').exists())
                    self.assertEqual(extract.build_replay(dict(cfg, captain='auto'), 12)['meta']['captain'], '')

    def test_existing_invalid_sources_raise_instead_of_no_data(self):
        path = self.root / 'kanban.db'
        for content in (b'not a database', b''):
            with self.subTest(content=content):
                path.write_bytes(content)
                with self.assertRaises(sqlite3.DatabaseError):
                    extract.build_replay(self.cfg, 12)
                self.assertEqual(path.read_bytes(), content)
        path.unlink()
        path.mkdir()
        with self.assertRaises(sqlite3.OperationalError):
            extract.build_replay(self.cfg, 12)
        path.rmdir()
        path.symlink_to(self.root / 'missing-source.db')
        with self.assertRaises(FileNotFoundError):
            extract.build_replay(self.cfg, 12)
        self.assertFalse((self.root / 'missing-source.db').exists())

    def test_inaccessible_source_is_not_treated_as_absent(self):
        with patch.object(Path, 'stat', side_effect=PermissionError('fixture access denied')):
            with self.assertRaises(PermissionError):
                extract.build_replay(self.cfg, 12)
        path = self.root / 'kanban.db'
        path.write_bytes(b'')
        with patch.object(extract, 'ro', side_effect=sqlite3.OperationalError('fixture cannot open')):
            with self.assertRaises(sqlite3.OperationalError):
                extract.build_replay(self.cfg, 12)


class ExtractTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.now = time.time()
        self.k = sqlite3.connect(self.home / 'kanban.db')
        self.addCleanup(self.k.close)
        self.k.executescript('''
CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT,assignee TEXT,status TEXT,created_by TEXT,
created_at REAL,started_at REAL,completed_at REAL,workspace_path TEXT,provider_override TEXT,max_runtime_seconds INTEGER);
CREATE TABLE task_events(id INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT,run_id INTEGER,kind TEXT,payload TEXT,created_at REAL);
CREATE TABLE task_comments(id INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT,author TEXT,body TEXT,created_at REAL);
CREATE TABLE task_runs(id INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT,profile TEXT,started_at REAL,ended_at REAL,outcome TEXT);
CREATE TABLE task_links(parent_id TEXT,child_id TEXT);
''')
        self.tid = 't_12345678'  # Preserve IDs even when their hex happens to be all digits.
        self.add_task(self.tid)
        self.k.execute('INSERT INTO task_runs(task_id,profile,started_at) VALUES(?,?,?)',
                       (self.tid, 'developer-demo', self.now))
        self.event('claimed')
        self.k.commit()
        root = self.home / 'profiles' / 'developer-demo'
        root.mkdir(parents=True)
        (root / 'config.yaml').write_text('model:\n  default: gpt-demo-sol\nagent:\n  reasoning_effort: high\n')
        (self.home / 'profiles' / 'planner-demo').mkdir()
        self.s = sqlite3.connect(root / 'state.db')
        self.addCleanup(self.s.close)
        self.s.executescript('''
CREATE TABLE sessions(id TEXT PRIMARY KEY,source TEXT,parent_session_id TEXT,started_at REAL,title TEXT);
CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT,role TEXT,content TEXT,
 tool_calls TEXT,tool_name TEXT,tool_call_id TEXT,timestamp REAL,token_count INTEGER);
CREATE TABLE session_model_usage(session_id TEXT,input_tokens INTEGER,output_tokens INTEGER);
''')
        self.s.execute('INSERT INTO sessions VALUES(?,?,?,?,?)', ('worker', 'kanban', None, self.now, 'Worker'))
        self.message('user', content='work kanban task ' + self.tid)
        self.tool('patch', {'new_string': 'fake secret'}, token_count=42)
        self.s.execute('INSERT INTO session_model_usage VALUES(?,?,?)', ('worker', 100, 20))
        self.s.commit()
        with patch.dict(os.environ, {'HERMES_HOME': str(self.home), 'HERMES_QUEST_CONFIG': ''}):
            self.cfg = extract.load_config()

    def add_task(self, tid):
        self.k.execute('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                       (tid, 'Private project https://example.test /home/fake CUST-00012345',
                        'developer-demo', 'running', 'planner-demo', self.now, self.now,
                        None, '/media/fake/private-campaign', None, 1800))

    def event(self, kind='heartbeat', stamp=None):
        self.k.execute('INSERT INTO task_events(task_id,kind,payload,created_at) VALUES(?,?,?,?)',
                       (self.tid, kind, json.dumps({'note': 'Private note 192.0.2.1 password=Fake'}),
                        self.now if stamp is None else stamp))

    def message(self, role, sid='worker', **kwargs):
        fields = dict(session_id=sid, role=role, timestamp=self.now, **kwargs)
        self.s.execute('INSERT INTO messages(' + ','.join(fields) + ') VALUES(' + ','.join('?' * len(fields)) + ')', tuple(fields.values()))

    def tool(self, name, args, **kwargs):
        self.message('assistant', tool_calls=json.dumps([{'function': {'name': name, 'arguments': json.dumps(args)}}]), **kwargs)

    def test_snapshot_privacy_and_meta(self):
        result = extract.build_replay(self.cfg, 12)
        self.assertEqual(result['meta']['captain'], extract._bot_id('planner-demo'))
        self.assertEqual(result['meta']['source'], 'live')
        self.assertEqual(result['tasks'][0]['title'], 'Quest #1 · BUILD')
        self.assertEqual(result['tasks'][0]['id'], self.tid)
        self.assertEqual(result['tasks'][0]['tokens'], 120)
        raw = json.dumps(result)
        self.assertNotIn('Private', raw)
        self.assertNotIn('fake secret', raw)
        self.assertNotRegex(raw, r'https?://|/home/|/media/|192\.0\.2\.')
        decoded = json.dumps(extract._decode(result['cursor']))
        self.assertNotIn('Private', decoded)
        self.assertNotIn('/media/', decoded)
        self.assertEqual(extract.collect_since(self.cfg, result['cursor'])['events'], [])

    def test_no_title_path_identifier_note_or_comment_leaks_in_any_payload(self):
        # Synthetic markers only. Every free-text source row carries a unique marker;
        # none may reach the snapshot, the delta, or the decoded cursor by default.
        # With show_titles opted in, harmless words are shown by design, but the
        # sensitive components (path, identifier, host, IP, workspace) must still not leak.
        # Paths and the address are assembled so this fixture is not a literal private reference.
        ip = '.'.join(('10', '9', '8', '7'))
        media, home = '/' + 'media/', '/' + 'home/'
        sensitive = ('private-campaign', 'CUST-00012345', 'Zq9Host.internal.test', ip, 'Zq9Workspace')
        harmless = ('Zq9Title', 'Zq9Comment', 'Zq9Note')
        self.k.execute('UPDATE tasks SET title=?,workspace_path=?', (
            f'Zq9Title CUST-00012345 Zq9Host.internal.test {ip}',
            media + 'Zq9Workspace/private-campaign'))
        self.k.execute('INSERT INTO task_comments(task_id,author,body,created_at) VALUES(?,?,?,?)',
                       (self.tid, 'planner-demo', 'Zq9Comment ' + home + 'Zq9Workspace/x', self.now))
        self.k.execute('INSERT INTO task_events(task_id,kind,payload,created_at) VALUES(?,?,?,?)',
                       (self.tid, 'heartbeat', json.dumps({'note': 'Zq9Note ' + ip}), self.now))
        self.k.commit()
        for show in (False, True):
            cfg = dict(self.cfg, show_titles=show)
            replay = extract.build_replay(cfg, 12)
            self.k.execute('INSERT INTO task_comments(task_id,author,body,created_at) VALUES(?,?,?,?)',
                           (self.tid, 'planner-demo', 'Zq9Comment', self.now))
            self.k.commit()
            delta = extract.collect_since(cfg, replay['cursor'])
            for payload in (replay, delta):
                raw = json.dumps({k: v for k, v in payload.items() if k != 'cursor'}, ensure_ascii=False)
                raw += json.dumps(extract._decode(payload['cursor']), ensure_ascii=False)
                for marker in sensitive + (() if show else harmless):
                    with self.subTest(show_titles=show, marker=marker):
                        self.assertNotIn(marker, raw)
            self.assertEqual(replay['tasks'][0]['id'], self.tid)

    def test_opt_in_label_skeleton_and_whole_text_gate(self):
        import unicodedata
        # Sample from every Unicode P/S/Z/C code point, not an ASCII allowlist.
        separators = [chr(i) for i in range(0x110000)
                      if unicodedata.category(chr(i))[0] in 'PSZC']
        rng = random.Random(202610094)
        for index in range(1200):
            label = rng.choice(extract.SENSITIVE_LABELS)
            spelling = rng.choice(separators).join(label)
            with self.subTest(index=index):
                self.assertEqual(extract._opt_in_text(spelling + ' FICTIONAL TAIL'),
                                 '[redacted]')
        for text in ('prefix password="A ",B" C', 'customer‑id Fictional tail',
                     'ｐａｓｓｗｏｒｄ TAIL', 'ordinary prefix odd=value suffix',
                     'ordinary prefix "odd" suffix'):
            self.assertEqual(extract._opt_in_text(text), '[redacted]')
        # Scan the complete input before truncating.
        self.assertEqual(extract._opt_in_text('plain ' * 100 + 'secret TAIL', 8),
                         '[redacted]')
        self.k.execute('UPDATE tasks SET title=? WHERE id=?',
                       ('ordinary words 42 tasks', self.tid))
        self.k.commit()
        result = extract.build_replay(dict(self.cfg, show_titles=True), 12)
        self.assertEqual(result['tasks'][0]['title'], 'ordinary words 42 tasks')

    def test_opt_in_titles_still_redacted(self):
        cfg = dict(self.cfg, show_titles=True)
        result = extract.build_replay(cfg, 12)
        raw = json.dumps(result)
        self.assertIn('Private project', result['tasks'][0]['title'])
        self.assertNotRegex(raw, r'https?://|/home/|/media/|192\.0\.2\.|CUST-00012345|password=Fake')

    def test_opt_in_payload_consumes_complete_authorization_and_identifiers(self):
        samples = [
            ('Authorization: Basic Zm9vOmJhcg==', 'Zm9vOmJhcg=='),
            ('Authorization: Bearer fictionalCredential', 'fictionalCredential'),
            ('account: 4111.1111.1111.1111', '4111'),
            ('account: 1234/5678/9012/3456', '1234'),
        ]
        for text, sensitive in samples:
            with self.subTest(text=text):
                self.k.execute('UPDATE tasks SET title=? WHERE id=?', (text, self.tid))
                self.k.execute('INSERT INTO task_comments(task_id,author,body,created_at) VALUES(?,?,?,?)',
                               (self.tid, 'planner-demo', text, self.now))
                self.k.commit()
                result = extract.build_replay(dict(self.cfg, show_titles=True), 12)
                # Invariant task IDs may contain the same digits as a fixture.
                exposed = [t['title'] for t in result['tasks']] + [e.get('note', '') for e in result['events']]
                self.assertNotIn(sensitive, json.dumps(exposed))
                self.assertNotIn(text, json.dumps(result))
                self.assertNotIn(text, json.dumps(extract._decode(result['cursor'])))
        self.assertEqual(extract.redact('version 1.2.3; batch 1234; ratio 12/34'),
                         'version 1.2.3; batch 1234; ratio 12/34')

    def test_privacy_findings_across_default_and_opt_in_payloads(self):
        display = self.home / 'profiles' / 'developer-demo' / 'profile.yaml'
        for text, fragments in PRIVACY_CASES + list(generated_privacy_cases()):
            with self.subTest(text=text):
                display.write_text('display_name: ' + text + '\n')
                self.k.execute('UPDATE tasks SET title=? WHERE id=?', (text, self.tid))
                self.k.execute('DELETE FROM task_comments')
                self.k.execute('INSERT INTO task_comments(task_id,author,body,created_at) VALUES(?,?,?,?)',
                               (self.tid, 'planner-demo', text, self.now))
                self.k.commit()
                for show in (False, True):
                    cfg = dict(self.cfg, show_titles=show)
                    replay = extract.build_replay(cfg, 12)
                    self.k.execute('INSERT INTO task_comments(task_id,author,body,created_at) VALUES(?,?,?,?)',
                                   (self.tid, 'planner-demo', text, self.now))
                    self.k.commit()
                    delta = extract.collect_since(cfg, replay['cursor'])
                    self.assertEqual([e['kind'] for e in delta['events']], ['comment'])
                    # Digit fragments can legitimately occur in stable IDs,
                    # timestamps and fingerprints; inspect every free-text surface
                    # separately rather than deleting those required invariants.
                    exposed = json.dumps([b['name'] for b in replay['bots']] +
                                         [t['title'] for t in replay['tasks'] + delta['tasks']] +
                                         [e.get('note', '') for e in replay['events'] + delta['events']])
                    # Compressed base64 can coincidentally spell short fragments
                    # (e.g. Doe). Check all emitted fields and both decoded cursor
                    # states, not random bytes of their opaque transport encoding.
                    cursor_text = json.dumps([extract._decode(v['cursor']) for v in (replay, delta)])
                    payload_text = json.dumps([{k: v for k, v in p.items() if k != 'cursor'}
                                               for p in (replay, delta)])
                    for fragment in fragments:
                        self.assertNotIn(fragment, exposed)
                        if not fragment.isdigit():
                            self.assertNotIn(fragment, payload_text + cursor_text)
                    self.assertNotIn(text, cursor_text)
                    self.assertEqual(replay['tasks'][0]['id'], self.tid)
                    self.assertTrue(all(t['id'] == self.tid for t in delta['tasks']))
                    self.assertEqual(extract.collect_since(cfg, delta['cursor'])['events'], [])

    def test_default_allowlist_has_no_upstream_free_text_and_stable_references(self):
        marker = 'UnclassifiedHarmlessCustomerWords'
        root = self.home / 'profiles' / 'developer-demo'
        (root / 'profile.yaml').write_text('display_name: ' + marker + '\n')
        (root / 'config.yaml').write_text('model:\n  default: ' + marker + '\nagent:\n  reasoning_effort: ' + marker + '\n')
        self.k.execute('UPDATE tasks SET title=?,status=?', (marker, marker))
        self.k.execute('UPDATE task_runs SET outcome=?', (marker,))
        self.event(marker)
        self.k.execute('INSERT INTO task_comments(task_id,author,body,created_at) VALUES(?,?,?,?)',
                       (self.tid, marker, marker, self.now))
        self.k.commit()
        self.tool(marker, {'secret': marker})
        self.s.commit()
        replay = extract.build_replay(self.cfg, 12)
        self.event(marker)
        self.k.commit()
        delta = extract.collect_since(self.cfg, replay['cursor'])
        for payload in (replay, delta):
            raw = json.dumps(payload) + json.dumps(extract._decode(payload['cursor']))
            for source in (marker, 'developer-demo', 'planner-demo'):
                self.assertNotIn(source, raw)
            self.assertTrue(all(e['task'] == self.tid for e in payload['events']))
        bots = {b['id'] for b in replay['bots']}
        self.assertIn(replay['meta']['captain'], bots)
        self.assertTrue(all(t['bot'] in bots for t in replay['tasks']))
        self.assertTrue(all(e[key] in bots for e in replay['events'] for key in ('bot', 'author') if e.get(key)))
        self.assertTrue(all(b['id'] == b['name'] and b['id'].startswith('bot-') for b in replay['bots']))
        self.assertEqual(delta['bots'], [])
        self.assertEqual(extract.collect_since(self.cfg, delta['cursor'])['events'], [])
        self.assertTrue(all(e['kind'] in extract.TEXT_ENUMS['kind'] | {'unknown'} for e in replay['events']))
        self.assertEqual(replay['tasks'][0]['status'], 'unknown')
        self.assertTrue(all(b['model'] in extract.TEXT_ENUMS['model'] for b in replay['bots']))

    def test_absent_board_recovers_and_preserves_existing_cursor(self):
        path = self.home / 'kanban.db'
        saved = self.home / 'saved.db'
        path.rename(saved)
        try:
            empty = extract.build_replay(self.cfg, 12)
            self.assertEqual([empty[k] for k in ('tasks', 'bots', 'events')], [[], [], []])
        finally:
            saved.rename(path)
        initial = extract.collect_since(self.cfg, empty['cursor'])
        self.assertEqual(len(initial['tasks']), 1)
        self.assertTrue(initial['events'])
        self.assertEqual(extract.collect_since(self.cfg, initial['cursor'])['events'], [])
        path.rename(saved)
        try:
            waiting = extract.collect_since(self.cfg, initial['cursor'])
            self.assertEqual(waiting['cursor'], initial['cursor'])
            self.assertEqual([waiting[k] for k in ('tasks', 'bots', 'events')], [[], [], []])
        finally:
            saved.rename(path)
        self.event('heartbeat')
        self.k.commit()
        resumed = extract.collect_since(self.cfg, waiting['cursor'])
        self.assertEqual([e['kind'] for e in resumed['events']], ['heartbeat'])
        self.assertEqual(extract.collect_since(self.cfg, resumed['cursor'])['events'], [])

    def test_board_without_profiles_directory(self):
        other = self.home / 'board-only'
        other.mkdir()
        c = sqlite3.connect(other / 'kanban.db')
        try:
            self.k.backup(c)
        finally:
            c.close()
        result = extract.build_replay(dict(self.cfg, hermes_home=str(other)), 12)
        self.assertEqual(result['tasks'][0]['id'], self.tid)
        self.assertEqual(extract.collect_since(dict(self.cfg, hermes_home=str(other)), result['cursor'])['events'], [])

    def test_captain_actions_deferred_until_all_tasks_are_visible(self):
        c = sqlite3.connect(self.home / 'profiles' / 'planner-demo' / 'state.db')
        self.addCleanup(c.close)
        self.s.backup(c)
        c.execute('INSERT INTO sessions VALUES(?,?,?,?,?)', ('chat', 'chat', None, self.now, 'Synthetic chat'))
        calls = [dict(id='create-demo', function=dict(name='kanban_create', arguments='{}')),
                 dict(id='note-demo', function=dict(name='kanban_comment', arguments=json.dumps({'task_id': self.tid}))),
                 dict(id='late-note', function=dict(name='kanban_comment', arguments='{"task_id":"t_abcdefab"}'))]
        c.execute('INSERT INTO messages(session_id,role,tool_calls,timestamp) VALUES(?,?,?,?)',
                  ('chat', 'assistant', json.dumps(calls), self.now))
        c.execute('INSERT INTO messages(session_id,role,tool_call_id,content,timestamp) VALUES(?,?,?,?,?)',
                  ('chat', 'tool', 'create-demo', '{"task":{"id":"t_abcdefab"}}', self.now))
        c.commit()
        initial = extract.build_replay(self.cfg, 12)
        self.assertEqual([e['act'] for e in initial['events'] if e['kind'] == 'captain'], ['note'])
        waiting = extract.collect_since(self.cfg, initial['cursor'])
        self.assertEqual(waiting['events'], [])
        self.add_task('t_abcdefab')
        self.k.commit()
        delta = extract.collect_since(self.cfg, waiting['cursor'])
        self.assertCountEqual([e['act'] for e in delta['events']], ['create', 'note'])
        self.assertTrue(all(e['task'] == 't_abcdefab' for e in delta['events']))
        self.assertEqual(len({e['id'] for e in delta['events']}), 2)
        self.assertEqual(extract.collect_since(self.cfg, waiting['cursor']), delta)
        self.assertEqual(extract.collect_since(self.cfg, delta['cursor'])['events'], [])

    def assert_compression_deferred(self, parent_missing):
        sid = 'late-child' if parent_missing else 'late-root'
        parent = 'late-parent' if parent_missing else None
        self.s.execute('INSERT INTO sessions VALUES(?,?,?,?,?)',
                       (sid, 'subagent' if parent else 'kanban', parent, self.now, 'Worker'))
        if not parent:
            self.message('user', sid=sid, content='work kanban task t_abcdefab')
        self.s.commit()
        root = self.home / 'profiles' / 'developer-demo' / 'logs'
        root.mkdir()
        stamp = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(self.now))
        (root / 'agent.log').write_text(stamp + f' INFO context compression done: session={sid} messages=90->24\n')
        initial = extract.build_replay(self.cfg, 12)
        self.assertNotIn('compress', [e['kind'] for e in initial['events']])
        self.assertNotIn(sid, json.dumps(extract._decode(initial['cursor'])))
        waiting = extract.collect_since(self.cfg, initial['cursor'])
        self.assertEqual(waiting['events'], [])
        self.add_task('t_abcdefab')
        self.k.commit()
        if parent:
            self.s.execute('INSERT INTO sessions VALUES(?,?,?,?,?)', (parent, 'kanban', None, self.now, 'Worker'))
            self.message('user', sid=parent, content='work kanban task t_abcdefab')
            self.s.commit()
        delta = extract.collect_since(self.cfg, waiting['cursor'])
        compression = [e for e in delta['events'] if e['kind'] == 'compress']
        self.assertEqual(len(compression), 1)
        self.assertEqual(compression[0]['task'], 't_abcdefab')
        self.assertEqual((compression[0]['before'], compression[0]['after']), (90, 24))
        self.assertEqual(extract.collect_since(self.cfg, waiting['cursor']), delta)
        self.assertEqual(extract.collect_since(self.cfg, delta['cursor'])['events'], [])

    def test_compression_deferred_until_task_visible(self):
        self.assert_compression_deferred(parent_missing=False)

    def test_compression_deferred_until_parent_session_visible(self):
        self.assert_compression_deferred(parent_missing=True)

    def test_compression_for_known_chat_does_not_accumulate_in_cursor(self):
        self.s.execute('INSERT INTO sessions VALUES(?,?,?,?,?)', ('chat', 'chat', None, self.now, 'Chat'))
        self.s.commit()
        root = self.home / 'profiles' / 'developer-demo' / 'logs'
        root.mkdir()
        stamp = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(self.now))
        (root / 'agent.log').write_text(stamp + ' INFO context compression done: session=chat messages=90->24\n')
        initial = extract.build_replay(self.cfg, 12)
        self.assertNotIn('compress', [e['kind'] for e in initial['events']])
        self.assertEqual(extract._decode(initial['cursor'])['compression_pending'], [])
        self.assertEqual(extract.collect_since(self.cfg, initial['cursor'])['events'], [])

    def test_cursor_pending_validation_and_legacy_delivery_tracking(self):
        initial = extract.build_replay(self.cfg, 12)
        state = extract._decode(initial['cursor'])
        for field, malformed in [('delivered', [{}]), ('captain_pending', {'x': [1]}),
                                 ('captain_pending', {'1': [-1]}), ('compression_pending', [{}])]:
            with self.subTest(field=field, malformed=malformed):
                with self.assertRaises(ValueError):
                    extract.collect_since(self.cfg, extract._cursor(dict(state, **{field: malformed})))
        for field in ('delivered', 'captain_pending', 'compression_pending'):
            state.pop(field)
        self.event()
        self.k.commit()
        delta = extract.collect_since(self.cfg, extract._cursor(state))
        self.assertEqual([t['id'] for t in delta['tasks']], [self.tid])
        self.assertEqual([e['kind'] for e in delta['events']], ['heartbeat'])
        self.assertEqual(extract.collect_since(self.cfg, delta['cursor'])['tasks'], [])

    def test_historical_task_snapshot_delivered_with_first_new_reference(self):
        self.k.execute('UPDATE tasks SET status=?,completed_at=? WHERE id=?', ('done', self.now - 13 * 3600, self.tid))
        self.k.execute('UPDATE task_runs SET started_at=?,ended_at=?,outcome=?',
                       (self.now - 14 * 3600, self.now - 13 * 3600, 'completed'))
        self.k.execute('DELETE FROM task_events')
        self.s.execute('DELETE FROM messages')
        self.k.commit()
        self.s.commit()
        initial = extract.build_replay(self.cfg, 12)
        self.assertEqual(initial['tasks'], [])
        quiet = extract.collect_since(self.cfg, initial['cursor'])
        self.assertEqual(quiet['tasks'], [])
        self.k.execute('INSERT INTO task_comments(task_id,author,body,created_at) VALUES(?,?,?,?)',
                       (self.tid, 'planner-demo', 'Synthetic historical note', self.now))
        self.k.commit()
        delta = extract.collect_since(self.cfg, quiet['cursor'])
        self.assertEqual([e['kind'] for e in delta['events']], ['comment'])
        self.assertEqual([t['id'] for t in delta['tasks']], [self.tid])
        self.assertEqual(delta['tasks'][0]['title'], 'Quest #1 · BUILD')
        self.assertEqual(extract.collect_since(self.cfg, quiet['cursor']), delta)
        self.assertEqual(extract.collect_since(self.cfg, delta['cursor'])['tasks'], [])
        # A recent event on a completed historical task also needs its snapshot
        # in the initial replay, not only when using incremental polling.
        replay = extract.build_replay(self.cfg, 12)
        self.assertEqual([t['id'] for t in replay['tasks']], [self.tid])
        self.assertEqual([e['kind'] for e in replay['events']], ['comment'])

    def test_no_duplicate_no_drop_equal_and_backdated_timestamps(self):
        initial = extract.build_replay(self.cfg, 12)
        # Same timestamp AND older timestamp are still new by source sequence.
        self.event(stamp=self.now)
        self.event(stamp=self.now - 60)
        self.k.execute('INSERT INTO task_comments(task_id,author,body,created_at) VALUES(?,?,?,?)',
                       (self.tid, 'planner-demo', 'Private note', self.now))
        self.k.execute('UPDATE task_runs SET ended_at=?,outcome=? WHERE id=1', (self.now, 'completed'))
        self.k.execute('UPDATE tasks SET status=? WHERE id=?', ('done', self.tid))
        self.k.commit()
        self.tool('terminal', {'command': 'pytest'}, token_count=15)
        self.message('tool', tool_name='terminal', content='{"exit_code":1,"tests_passed":12}')
        self.s.execute('UPDATE session_model_usage SET output_tokens=30')
        self.s.commit()
        delta = extract.collect_since(self.cfg, initial['cursor'])
        self.assertCountEqual([e['kind'] for e in delta['events']], ['heartbeat', 'heartbeat', 'comment', 'run_end', 'tool', 'mana', 'hurt', 'tests'])
        self.assertEqual(delta['tasks'][0]['status'], 'done')
        self.assertEqual(delta['tasks'][0]['tokens'], 130)
        self.assertEqual(delta['bots'], [])
        self.assertFalse({e['id'] for e in initial['events']} & {e['id'] for e in delta['events']})
        self.assertEqual(len(delta['events']), len({e['id'] for e in delta['events']}))
        self.assertEqual(extract.collect_since(self.cfg, delta['cursor']),
                         dict(meta=delta['meta'], events=[], tasks=[], bots=[], cursor=delta['cursor']))
        # Reusing the same cursor gives the same delta (retry-safe).
        self.assertEqual(extract.collect_since(self.cfg, initial['cursor']), delta)

    def test_new_task_subagent_and_config_change(self):
        initial = extract.build_replay(self.cfg, 12)
        self.add_task('t_abcdefab')
        self.k.execute('INSERT INTO task_links VALUES(?,?)', (self.tid, 't_abcdefab'))
        self.k.commit()
        self.s.execute('INSERT INTO sessions VALUES(?,?,?,?,?)', ('child', 'subagent', 'worker', self.now, 'Subagent /home/fake'))
        self.tool('read_file', {'path': '/media/fake'}, sid='child')
        self.s.commit()
        conf = self.home / 'profiles' / 'developer-demo' / 'config.yaml'
        conf.write_text('model:\n  default: gemini-demo\nagent:\n  reasoning_effort: low\n')
        delta = extract.collect_since(self.cfg, initial['cursor'])
        self.assertCountEqual([e['kind'] for e in delta['events']], ['summon', 'tool'])
        self.assertEqual(delta['tasks'][0]['parents'], [self.tid])
        self.assertEqual(delta['bots'][0]['model'], 'gemini')
        self.assertEqual(extract.collect_since(self.cfg, delta['cursor'])['events'], [])

    def test_compression_complete_lines_only(self):
        root = self.home / 'profiles' / 'developer-demo' / 'logs'
        root.mkdir()
        log = root / 'agent.log'
        prefix = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(self.now))
        line = prefix + ' INFO context compression done: session=worker messages=90->24'
        log.write_text(line)
        initial = extract.build_replay(self.cfg, 12)
        self.assertNotIn('compress', [e['kind'] for e in initial['events']])
        with log.open('a') as f:
            f.write('\n')
        delta = extract.collect_since(self.cfg, initial['cursor'])
        self.assertEqual([e['kind'] for e in delta['events']], ['compress'])
        self.assertEqual(extract.collect_since(self.cfg, delta['cursor'])['events'], [])

    def test_task_visible_after_worker_snapshot_is_not_lost(self):
        self.s.execute('INSERT INTO sessions VALUES(?,?,?,?,?)', ('late', 'kanban', None, self.now, 'Worker'))
        self.message('user', sid='late', content='work kanban task t_abcdefab')
        self.tool('terminal', {'command': 'npm run build'}, sid='late')
        self.s.commit()
        initial = extract.build_replay(self.cfg, 12)
        self.add_task('t_abcdefab')
        self.k.commit()
        delta = extract.collect_since(self.cfg, initial['cursor'])
        self.assertEqual([e['task'] for e in delta['events']], ['t_abcdefab'])
        self.assertEqual(delta['events'][0]['cat'], 'build')
        self.assertEqual(extract.collect_since(self.cfg, delta['cursor'])['events'], [])

    def test_late_first_user_recovers_earlier_tool_calls(self):
        self.s.execute('INSERT INTO sessions VALUES(?,?,?,?,?)', ('late', 'kanban', None, self.now, 'Worker'))
        self.tool('read_file', {'path': '/home/fake'}, sid='late')
        self.s.commit()
        initial = extract.build_replay(self.cfg, 12)
        self.message('user', sid='late', content='work kanban task ' + self.tid)
        self.s.commit()
        delta = extract.collect_since(self.cfg, initial['cursor'])
        self.assertEqual([e['kind'] for e in delta['events']], ['tool'])
        self.assertEqual(extract.collect_since(self.cfg, delta['cursor'])['events'], [])

    def test_captain_create_waits_for_result_without_duplicate(self):
        path = self.home / 'profiles' / 'planner-demo' / 'state.db'
        c = sqlite3.connect(path)
        self.addCleanup(c.close)
        self.s.backup(c)
        c.execute('INSERT INTO sessions VALUES(?,?,?,?,?)', ('chat', 'chat', None, self.now, 'Synthetic chat'))
        call = dict(id='call-demo', function=dict(name='kanban_create', arguments='{}'))
        c.execute('INSERT INTO messages(session_id,role,tool_calls,timestamp) VALUES(?,?,?,?)',
                  ('chat', 'assistant', json.dumps([call]), self.now))
        c.commit()
        initial = extract.build_replay(self.cfg, 12)
        self.assertNotIn('captain', [e['kind'] for e in initial['events']])
        self.add_task('t_abcdefab')
        self.k.commit()
        c.execute('INSERT INTO messages(session_id,role,tool_call_id,content,timestamp) VALUES(?,?,?,?,?)',
                  ('chat', 'tool', 'call-demo', '{"task":{"id":"t_abcdefab"}}', self.now))
        c.commit()
        delta = extract.collect_since(self.cfg, initial['cursor'])
        self.assertEqual([e['kind'] for e in delta['events']], ['captain'])
        self.assertEqual(delta['events'][0]['task'], 't_abcdefab')
        self.assertEqual(extract.collect_since(self.cfg, delta['cursor'])['events'], [])

    def test_read_only_and_no_api_output(self):
        db = extract.ro(self.home / 'kanban.db')
        try:
            with self.assertRaises(sqlite3.OperationalError):
                db.execute('DELETE FROM tasks')
        finally:
            db.close()
        before = {p.relative_to(self.home) for p in self.home.rglob('*')}
        extract.build_replay(self.cfg, 1)
        after = {p.relative_to(self.home) for p in self.home.rglob('*')}
        self.assertEqual(before, after)
        with self.assertRaises(sqlite3.OperationalError):
            extract.ro(self.home / 'missing.db')
        self.assertFalse((self.home / 'missing.db').exists())

    def test_no_json1_keeps_replay_without_loading_private_arguments(self):
        marker = 'FICTIONAL_MEMORY_QUERY'
        self.tool('mnemosyne_shared_recall', {'query': marker}, token_count=17)
        self.message('tool', tool_name='mnemosyne_shared_recall', content=marker)
        self.message('tool', tool_name='terminal', content='{"exit_code":1,"tests_passed":3}')
        self.s.commit()
        observed, denied = [], []
        original = extract.ro
        def ro(path):
            db = original(path)
            if Path(path).name == 'state.db':
                def authorize(action, first, second, *unused):
                    if action == sqlite3.SQLITE_FUNCTION and second.startswith('json_'):
                        denied.append(second)
                        return sqlite3.SQLITE_DENY
                    return sqlite3.SQLITE_OK
                db.set_authorizer(authorize)
                def factory(cursor, row):
                    observed.append(row)
                    return sqlite3.Row(cursor, row)
                db.row_factory = factory
            return db
        with patch.object(extract, 'ro', side_effect=ro):
            replay = extract.build_replay(self.cfg, 12)
            delta = extract.collect_since(self.cfg, replay['cursor'])
        self.assertTrue(denied)
        self.assertTrue(replay['tasks'])
        self.assertEqual(delta['events'], [])
        self.assertNotIn(marker, str(observed))
        self.assertNotIn('tool', [e['kind'] for e in replay['events']])
        self.assertIn(17, [e.get('tokens') for e in replay['events']])
        self.assertIn(1, [e.get('code') for e in replay['events'] if e['kind'] == 'hurt'])
        self.assertIn(3, [e.get('passed') for e in replay['events'] if e['kind'] == 'tests'])

    def test_memory_projection_does_not_materialize_unused_prose(self):
        markers = ('FICTIONAL_MEMORY_QUERY', 'FICTIONAL_MEMORY_RESULT', 'FICTIONAL_MEMORY_EXTRA')
        self.s.execute('ALTER TABLE messages ADD COLUMN unused_private TEXT')
        self.tool('mnemosyne_shared_recall', {'query': markers[0]}, token_count=17)
        self.message('tool', tool_name='mnemosyne_shared_recall', content=markers[1])
        self.s.execute('UPDATE messages SET unused_private=?', (markers[2],))
        self.s.commit()
        # Exercise the captain's unassigned call/result path too, including a
        # result with no tool_name: matching memory IDs still must not read prose.
        c = sqlite3.connect(self.home / 'profiles' / 'planner-demo' / 'state.db')
        self.addCleanup(c.close)
        self.s.backup(c)
        c.execute('INSERT INTO sessions VALUES(?,?,?,?,?)', ('chat', 'chat', None, self.now, 'Chat'))
        call = {'id': 'memory-call', 'function': {'name': 'mnemosyne_shared_recall',
                                                'arguments': json.dumps({'query': markers[0]})}}
        c.execute('INSERT INTO messages(session_id,role,tool_calls,timestamp) VALUES(?,?,?,?)',
                  ('chat', 'assistant', json.dumps([call]), self.now))
        c.execute('INSERT INTO messages(session_id,role,tool_call_id,content,timestamp) VALUES(?,?,?,?,?)',
                  ('chat', 'tool', 'memory-call', markers[1], self.now))
        c.commit()
        observed, queries = [], []
        original = extract.ro
        def ro(path):
            db = original(path)
            if Path(path).name == 'state.db':
                db.set_trace_callback(queries.append)
                def factory(cursor, row):
                    observed.append(row)
                    return sqlite3.Row(cursor, row)
                db.row_factory = factory
            return db
        with patch.object(extract, 'ro', side_effect=ro):
            replay = extract.build_replay(self.cfg, 12)
            delta = extract.collect_since(self.cfg, replay['cursor'])
        self.assertEqual(delta['events'], [])
        memory = [e for e in replay['events'] if e.get('tool') == 'mnemosyne_shared_recall']
        self.assertEqual(len(memory), 2)  # Both synthetic profile DBs have a mapped worker.
        self.assertEqual(memory[0]['util'], 'memory')
        self.assertIn(17, [e.get('tokens') for e in replay['events']])
        for marker in markers:
            self.assertNotIn(marker, str(observed))
        self.assertTrue(any('json_each' in q for q in queries))
        self.assertFalse(any(re.search(r'SELECT\s+rowid AS seq,\*\s+FROM messages', q) for q in queries))

    def test_config_precedence_and_custom_mapping(self):
        path = self.home / 'quest.json'
        path.write_text(json.dumps(dict(hermes_home=str(self.home), captain='developer-demo', profiles=['developer-demo'],
                                       classes={'developer': 'sage'}, regions={'commander': 'port', 'sage': 'observatory', 'mage': 'tower'})))
        with patch.dict(os.environ, {'HERMES_QUEST_CONFIG': str(path), 'HERMES_HOME': '/nonexistent'}):
            cfg = extract.load_config()
        result = extract.build_replay(cfg, 1)
        self.assertEqual(result['meta']['captain'], extract._bot_id('developer-demo'))
        self.assertEqual(result['bots'][0]['cls'], 'commander')
        self.assertEqual(result['bots'][0]['region'], 'port')
        with self.assertRaises(ValueError):
            extract.collect_since(cfg, 'not-a-valid-cursor')
        with self.assertRaises(ValueError):
            extract.build_replay(cfg, -1)
        path.write_text('{"profiles":["../bad"]}')
        with self.assertRaises(ValueError):
            extract.load_config(path)


if __name__ == '__main__':
    unittest.main()
