"""Synthetic mounted API + real extractor subprocess + production-client contracts.
Run in the Hermes Python runtime: unittest discover -s dashboard -p test_live_contract.py.
"""
import importlib.util
import json
import os
from pathlib import Path
import random
import sqlite3
import string
import subprocess
import sys
import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))
import extract
import test_extract

spec = importlib.util.spec_from_file_location('quest_actual_api', ROOT / 'dashboard/plugin_api.py')
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)
PREFIX = '/api/plugins/hermes-quest'


def privacy_cases():
    rng = random.Random(202610092)
    templates = [
        'token=«{a} {b}»', 'password=“{a} {b}”', 'customer ID: ‹{a} {b}›',
        'password=‘{a} {b}’', 'password=„{a} {b}“', 'token=「{a} {b}」',
        'token=『{a} {b}』', 'token=《{a} {b}》', 'token=【{a} {b}】',
        'password={a}\u00a0{b}', 'password={a}\u202f{b}', 'token={a}\u2007{b}',
        'token=«{a} {b}', 'password={{“{a} {b}”}}',
        'customer_id=«{a} \\"{b}\\"»;count=42',
        '"/home/{a} {b}/private/https://example.test/{b}"',
        r'"C:\Users\{a} {b}\www.example.test\reports.csv"',
        'portal.example.test:443?session={a}#customer={b}',
        'password="{a},{b}",user=demo', 'password={a};customer_id={b}',
        'password={a} {b}', 'token=❝{a} {b}❞',
        '{{“password”: “{a} {b}”}}', '「customer_id」：「{a} {b}」',
        '‘token’＝‘{a} {b}’', '«api_key»：«{a} {b}»',
        'password＝{a} {b}', 'password：{a} {b}',
        '＂ｐａｓｓｗｏｒｄ＂：＂{a} {b}＂',
        '“pass\u200bword\u2060”\ufeff： “{a} {b}”',
        'password="{a} "{b}" TAIL', 'password=‟{a} ‟{b}” TAIL',
    ]
    return test_extract.PRIVACY_CASES + test_extract.UNICODE_KEY_CASES + list(test_extract.generated_privacy_cases()) + [
        (templates[i % len(templates)].format(**dict(zip(('a', 'b'), parts))), parts)
        for i in range(500)
        for parts in [tuple(''.join(rng.choices(string.ascii_uppercase, k=14)) for _ in range(2))]
    ]


class LiveContractTests(unittest.TestCase):
    def fixture(self):
        f = test_extract.ExtractTests('test_snapshot_privacy_and_meta')
        f.setUp()
        self.addCleanup(f.doCleanups)
        return f

    def client(self, cfgpath):
        self.enterContext(patch.dict(os.environ, {'HERMES_QUEST_CONFIG': str(cfgpath),
                                                 'PYTHONDONTWRITEBYTECODE': '1'}))
        app = FastAPI()
        app.include_router(api.router, prefix=PREFIX)
        self.addCleanup(api._stop_sampler)  # the first API call starts the botstatus sampler
        return self.enterContext(TestClient(app))

    def get(self, client, route, **params):
        r = client.get(PREFIX + route, params=params)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.headers['cache-control'], 'no-store')
        return r.json()

    def test_seeded_unicode_privacy_actual_replay_and_events(self):
        corpus = privacy_cases()
        self.assertGreaterEqual(len(corpus), 500)
        requests = 0
        for begin in range(0, len(corpus), 100):
            f = self.fixture()
            f.k.execute('DELETE FROM tasks')
            f.k.execute('DELETE FROM task_events')
            f.k.execute('DELETE FROM task_comments')
            f.k.execute('DELETE FROM task_runs')
            f.s.execute('DELETE FROM messages'); f.s.commit()
            batch = corpus[begin:begin + 100]
            for index, (text, _) in enumerate(batch):
                tid = 't_' + format(0xb0000000 + index, '08x')
                prof = 'developer-synthetic-' + str(index)
                root = f.home / 'profiles' / prof
                root.mkdir()
                (root / 'profile.yaml').write_text('display_name: ' + text + '\n')
                f.k.execute('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                            (tid, text, prof, 'running', 'planner-demo', f.now, f.now, None, None, None, 1800))
                f.k.execute('INSERT INTO task_events(task_id,kind,payload,created_at) VALUES(?,?,?,?)',
                            (tid, 'blocked', json.dumps({'reason': text}), f.now))
            f.k.commit()
            cfgpath = f.home / 'config.json'
            client = self.client(cfgpath)
            for show in (False, True):
                cfgpath.write_text(json.dumps(dict(f.cfg, show_titles=show)))
                replay = self.get(client, '/replay', hours=12); requests += 1
                for index, (text, _) in enumerate(batch):
                    f.k.execute('INSERT INTO task_comments(task_id,author,body,created_at) VALUES(?,?,?,?)',
                                ('t_' + format(0xb0000000 + index, '08x'), 'planner-demo', text, f.now))
                f.k.commit()
                delta = self.get(client, '/events', since=replay['cursor']); requests += 1
                self.assertEqual(len(delta['events']), len(batch))
                retry = self.get(client, '/events', since=delta['cursor']); requests += 1
                self.assertEqual(retry['events'], [])
                self.assertEqual(retry['cursor'], delta['cursor'])
                raw = json.dumps([extract._decode(v['cursor']) for v in (replay, delta)])
                for index, (_, parts) in enumerate(batch):
                    tid = 't_' + format(0xb0000000 + index, '08x')
                    bot = extract._bot_id('developer-synthetic-' + str(index))
                    exposed = json.dumps([t['title'] for t in replay['tasks'] if t['id'] == tid] +
                                         [b['name'] for b in replay['bots'] if b['id'] == bot] +
                                         [e.get('note', '') for e in replay['events'] + delta['events'] if e.get('task') == tid])
                    for part in parts:
                        self.assertNotIn(part, exposed, (show, batch[index][0]))
                        if not part.isdigit():
                            self.assertNotIn(part, raw)
        self.assertEqual(extract._opt_in_text('ordinary words 42 tasks'), 'ordinary words 42 tasks')
        print(f'PASS actual API privacy: {len(corpus)} cases, 500 new seed202610092, both modes, {requests} requests, leaks0')

    def test_real_api_config_delta_to_production_client(self):
        f = self.fixture()
        f.k.execute('UPDATE tasks SET title=?', ('Harmless old prose 42 tasks',)); f.k.commit()
        cfg = dict(f.cfg, captain='planner-demo', show_titles=True)
        cfgpath = f.home / 'config.json'; cfgpath.write_text(json.dumps(cfg))
        client = self.client(cfgpath)
        initial = self.get(client, '/replay', hours=12)
        last = initial
        migrations = []
        for case in ('explicit-captain', 'auto-config', 'auto-detected-captain', 'return-captain',
                     'classes', 'regions', 'stage-regions', 'stages', 'privacy-off', 'privacy-on', 'profiles'):
            if case == 'explicit-captain':
                cfg.update(captain='developer-demo', regions=dict(cfg['regions'], commander='tower'))
            elif case == 'auto-config':
                cfg['captain'] = 'auto'
            elif case == 'auto-detected-captain':
                f.k.execute("UPDATE tasks SET created_by='developer-demo'"); f.k.commit()
            elif case == 'return-captain':
                f.k.execute("UPDATE tasks SET created_by='planner-demo'"); f.k.commit()
            elif case == 'classes':
                cfg['classes'] = dict(cfg['classes'], developer='sage')
            elif case == 'regions':
                cfg['regions'] = dict(cfg['regions'], sage='forest', commander='port')
            elif case == 'stage-regions':
                cfg['stage_regions'] = dict(cfg['stage_regions'], PLAN='tower')
            elif case == 'stages':
                cfg['stages'] = dict(cfg['stages'], sage='REVIEW')
            elif case == 'privacy-off':
                cfg['show_titles'] = False
            elif case == 'privacy-on':
                cfg['show_titles'] = True
            elif case == 'profiles':
                cfg['profiles'] = ['developer-demo']
            cfgpath.write_text(json.dumps(cfg))
            delta = self.get(client, '/events', since=last['cursor'])
            newest = self.get(client, '/replay', hours=12)
            self.assertNotEqual(last['meta']['config_revision'], delta['meta']['config_revision'], case)
            self.assertEqual(delta['meta']['config_revision'], newest['meta']['config_revision'])
            migrations.append(dict(case=case, delta=delta, replay=newest))
            last = newest
        stable = self.get(client, '/events', since=last['cursor'])
        proof = dict(initial=initial, migrations=migrations, stable=stable)
        result = subprocess.run(['node', str(ROOT / 'dashboard/test_api_migration.cjs')],
                                input=json.dumps(proof), text=True, capture_output=True, cwd=ROOT)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        print(result.stdout.strip())
        evidence = os.environ.get('QUEST_TEST_EVIDENCE')
        if evidence:
            Path(evidence).mkdir(parents=True, exist_ok=True)
            (Path(evidence) / 'api-migration-fixture.json').write_text(json.dumps(proof, indent=2))
            (Path(evidence) / 'api-migration-client.log').write_text(result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
