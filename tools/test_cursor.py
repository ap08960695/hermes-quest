"""Lossless cursor compaction; synthetic GET roundtrips and capacity failure."""
import base64
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import unittest
from unittest.mock import patch
import zlib

import extract
import test_extract


def legacy_cursor(state):
    data = json.dumps(state, separators=(',', ':'), sort_keys=True).encode()
    return base64.urlsafe_b64encode(zlib.compress(data)).decode().rstrip('=')


def wire_cursor(data):
    return base64.urlsafe_b64encode(zlib.compress(data)).decode().rstrip('=')


class CursorCodecTests(unittest.TestCase):
    def state(self, count=1):
        state: dict = dict(v=1, marks={}, tasks={}, bots={}, runs={}, mana={}, mana_versions={})
        for i in range(count):
            key = 'session-' + extract._hash(['synthetic', i])[:20]
            state['mana'][key] = 100 + i
            state['mana_versions'][key] = 1
        return state

    def test_lossless_sparse_zero_and_maximum_ledgers(self):
        state = self.state(4)
        keys = sorted(state['mana'])
        state['mana'][keys[0]] = 0
        state['mana'][keys[1]] = 2 ** 53
        state['mana_versions'][keys[2]] = 2 ** 53
        del state['mana'][keys[2]]
        del state['mana_versions'][keys[3]]
        before = copy.deepcopy(state)
        self.assertEqual(extract._decode(extract._cursor(state)), state)
        self.assertEqual(extract._decode(legacy_cursor(state)), state)
        self.assertEqual(state, before, 'encoding must not mutate the ledger')
        legacy = self.state(0)
        del legacy['mana']
        del legacy['mana_versions']
        self.assertEqual(extract._decode(extract._cursor(legacy)), legacy)

    def test_malformed_binary_is_rejected(self):
        header = json.dumps(self.state(0)).encode()
        prefix = b'HQ2\0' + len(header).to_bytes(4, 'big') + header
        record = b'\x03' + bytes(10) + b'\x01\x01'
        invalid = [b'HQ2\0', b'HQ2\0' + (9999).to_bytes(4, 'big') + header,
                   prefix + b'\x00', prefix + b'\x04' + bytes(10),
                   prefix + record[:-1], prefix + record * 2,
                   prefix + b'\x01' + bytes(10) + b'\xff' * 8,
                   prefix + b'\x01' + bytes(10) + b'\xff' * 7 + b'\x7f']
        for data in invalid:
            with self.subTest(data_size=len(data)), self.assertRaises(ValueError):
                extract._decode(wire_cursor(data))

    def test_capacity_fails_without_evicting_any_state(self):
        state = self.state(4000)
        before = copy.deepcopy(state)
        with self.assertRaisesRegex(ValueError, 'capacity exceeded'):
            extract._cursor(state)
        self.assertEqual(state, before)
        # Even the incompressible identity bits alone cannot fit an arbitrary
        # number of sessions in 32 KiB. No hidden cache or lossy eviction is used.
        self.assertGreater(len(wire_cursor(extract._pack_cursor(state))), 32768)


class CursorRoundtripTests(unittest.TestCase):
    def setUp(self):
        self.f = test_extract.ExtractTests('test_snapshot_privacy_and_meta')
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        self.s = self.f.s
        self.cfg = self.f.cfg

    def total(self, result):
        return sum(e['tokens'] for e in result['events'] if e['kind'] == 'mana')

    def test_old_ledger_migrates_and_retries_without_rebase(self):
        first = extract.build_replay(self.cfg, 12)
        old = legacy_cursor(extract._decode(first['cursor']))
        self.assertEqual(extract.collect_since(self.cfg, old)['events'], [])
        self.s.execute('UPDATE session_model_usage SET input_tokens=200')
        self.s.commit()
        delta = extract.collect_since(self.cfg, old)
        self.assertEqual(self.total(delta), 100)
        self.assertEqual(extract.collect_since(self.cfg, old), delta)
        self.assertEqual(first['meta']['config_revision'], delta['meta']['config_revision'])
        self.assertEqual(extract.collect_since(self.cfg, delta['cursor'])['events'], [])

    def test_same_session_id_in_other_profile_is_not_same_ledger(self):
        root = self.f.home / 'profiles' / 'reviewer-demo'
        root.mkdir()
        self.s.commit()
        shutil.copyfile(self.f.home / 'profiles' / 'developer-demo' / 'state.db', root / 'state.db')
        first = extract.build_replay(self.cfg, 12)
        self.assertEqual(len(extract._decode(first['cursor'])['mana']), 2)
        self.s.execute('UPDATE session_model_usage SET input_tokens=200')
        self.s.commit()
        delta = extract.collect_since(self.cfg, first['cursor'])
        corrections = [e for e in delta['events'] if e.get('correction')]
        self.assertEqual([(e['bot'], e['tokens']) for e in corrections],
                         [(extract._bot_id('developer-demo'), 100)])
        self.assertEqual(extract.collect_since(self.cfg, delta['cursor'])['events'], [])

    def test_absent_profile_preserves_ledger_and_marks(self):
        first = extract.build_replay(self.cfg, 12)
        db = self.f.home / 'profiles' / 'developer-demo' / 'state.db'
        absent = db.with_suffix('.absent')
        db.rename(absent)
        try:
            delta = extract.collect_since(self.cfg, first['cursor'])
            before = extract._decode(first['cursor'])
            after = extract._decode(delta['cursor'])
            for key in ('mana', 'mana_versions', 'marks'):
                self.assertEqual(after[key], before[key])
        finally:
            absent.rename(db)
        self.assertEqual(extract.collect_since(self.cfg, delta['cursor'])['events'], [])

    def test_high_cardinality_actual_get_and_signed_corrections(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        count = 1400
        for i in range(count):
            sid = 'PRIVATE-SYNTHETIC-SESSION-' + str(i)
            self.s.execute('INSERT INTO sessions VALUES(?,?,?,?,?)',
                           (sid, 'kanban', 'worker', self.f.now, 'Private synthetic title'))
            self.f.message('assistant', sid=sid, content='Private synthetic result', token_count=5)
            self.s.execute('INSERT INTO session_model_usage VALUES(?,?,0)', (sid, 100 + i))
        self.s.commit()
        root = Path(extract.__file__).resolve().parent.parent
        spec = importlib.util.spec_from_file_location('cursor_api', root / 'dashboard' / 'plugin_api.py')
        assert spec is not None and spec.loader is not None
        api = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(api)
        app = FastAPI()
        app.include_router(api.router, prefix='/api/plugins/hermes-quest')
        cfgpath = self.f.home / 'cursor-config.json'
        cfgpath.write_text(json.dumps(self.cfg))
        sources = [self.f.home / 'kanban.db',
                   self.f.home / 'profiles' / 'developer-demo' / 'state.db']

        def fingerprints():
            return [(hashlib.sha256(p.read_bytes()).hexdigest(), p.stat().st_mtime_ns) for p in sources]

        with patch.dict(os.environ, {'HERMES_QUEST_CONFIG': str(cfgpath), 'HERMES_QUEST_SAMPLER': 'off',
                                     'PYTHONDONTWRITEBYTECODE': '1'}), TestClient(app) as client:
            def get(route, **params):
                before = fingerprints()
                response = client.get('/api/plugins/hermes-quest' + route, params=params)
                self.assertEqual(response.status_code, 200, response.text[:200])
                self.assertEqual(response.headers['cache-control'], 'no-store')
                self.assertEqual(fingerprints(), before, 'GET must not write source DBs')
                payload = response.json()
                self.assertLessEqual(len(payload['cursor'].encode()), 32768)
                self.assertNotIn('PRIVATE-SYNTHETIC-SESSION-', json.dumps(payload))
                self.assertNotIn('PRIVATE-SYNTHETIC-SESSION-', json.dumps(extract._decode(payload['cursor'])))
                return payload

            first = get('/replay', hours=12)
            state = extract._decode(first['cursor'])
            old = legacy_cursor(state)
            self.assertGreater(len(old), 32768, 'corpus must reproduce the original GET failure')
            self.assertEqual(client.get('/api/plugins/hermes-quest/events', params={'since': old}).status_code, 422)
            self.assertEqual(len(state['mana']), count + 1)
            self.assertEqual(get('/events', since=first['cursor'])['events'], [])
            live = {e['id']: e['tokens'] for e in first['events'] if e['kind'] == 'mana'}
            cursor = first['cursor']
            previous_change = 0
            # No new messages: usage grows, shrinks, then returns to a previous
            # value. The latter must have new IDs despite the repeated totals.
            for change in (50, -25, 50):
                self.s.execute("UPDATE session_model_usage SET input_tokens=100+CAST(substr(session_id,27) AS INTEGER)+? "
                               "WHERE session_id LIKE 'PRIVATE-SYNTHETIC-SESSION-%'", (change,))
                self.s.commit()
                delta = get('/events', since=cursor)
                self.assertEqual(get('/events', since=cursor), delta, 'retry must be identical')
                corrections = [e for e in delta['events'] if e.get('correction')]
                self.assertEqual(len(corrections), count)
                self.assertEqual({e['tokens'] for e in corrections}, {change - previous_change})
                for e in corrections:
                    self.assertNotIn(e['id'], live)
                    live[e['id']] = e['tokens']
                self.assertEqual(sum(live.values()), self.total(get('/replay', hours=12)))
                cursor = delta['cursor']
                previous_change = change
                self.assertEqual(get('/events', since=cursor)['events'], [])
            print(f'Synthetic GET cursor: {count + 1} sessions; legacy={len(old)} bytes; '
                  f'compact={len(first["cursor"])} bytes; final={len(cursor)} bytes', flush=True)


if __name__ == '__main__':
    unittest.main()
