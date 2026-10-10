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

    def lifecycle_columns(self):
        self.s.execute('ALTER TABLE sessions ADD COLUMN ended_at REAL')
        self.s.execute('ALTER TABLE sessions ADD COLUMN last_activity_at REAL')
        self.s.execute('CREATE INDEX messages_session ON messages(session_id)')

    def message_at(self, role, stamp, **kwargs):
        self.f.message(role, **kwargs)
        self.s.execute('UPDATE messages SET timestamp=? WHERE rowid=last_insert_rowid()', (stamp,))

    def test_history_does_not_grow_window_cursor(self):
        self.lifecycle_columns()
        now, ancient = self.f.now, self.f.now - 48 * 3600

        def add_tasks(first, last, stamp):
            for i in range(first, last):
                tid = f't_{i:08x}'
                self.f.add_task(tid)
                self.f.k.execute('UPDATE tasks SET status=?,created_at=?,started_at=?,completed_at=? WHERE id=?',
                                 ('done', stamp, stamp, stamp, tid))
            self.f.k.commit()

        def add_sessions(first, last, stamp, task_first, task_count):
            for i in range(first, last):
                sid = f'synthetic-history-{i}'
                tid = f't_{task_first + i % task_count:08x}'
                self.s.execute('INSERT INTO sessions VALUES(?,?,?,?,?,?,?)',
                               (sid, 'kanban', None, stamp, 'Synthetic', stamp, stamp))
                self.message_at('user', stamp, sid=sid, content='work kanban task ' + tid)
                self.message_at('assistant', stamp, sid=sid, token_count=5)
                self.s.execute('INSERT INTO session_model_usage VALUES(?,?,0)', (sid, 100 + i))
            self.s.commit()

        add_tasks(1, 200, now)
        add_sessions(0, 299, now, 1, 199)
        with patch.object(extract.time, 'time', return_value=now):
            small = extract.build_replay(self.cfg, 12)
        add_tasks(200, 5000, ancient)
        add_sessions(299, 9999, ancient, 200, 4800)
        with patch.object(extract.time, 'time', return_value=now):
            large = extract.build_replay(self.cfg, 12)
            self.assertEqual(extract.collect_since(self.cfg, large['cursor'])['events'], [])
        state = extract._decode(large['cursor'])
        self.assertEqual(len(state['mana']), 300)
        self.assertEqual(len(state['tasks']), 200)
        self.assertLessEqual(len(large['cursor']), 16384)
        self.assertLessEqual(abs(len(large['cursor']) - len(small['cursor'])), len(small['cursor']) * .05)
        # Migration must bound an already accumulated historical ledger too,
        # not just a fresh replay. Decoder accepts legacy cursors up to 1 MiB.
        accumulated = copy.deepcopy(state)
        accumulated.pop('identity')  # genuine pre-HMAC ledger, not a v2 identity
        for i in range(299, 9999):
            key = 'session-' + extract._hash(['developer-demo', f'synthetic-history-{i}'])[:20]
            accumulated['mana'][key] = 100 + i
            accumulated['mana_versions'][key] = 1
        for i in range(201, 5001):
            accumulated['tasks'][str(i)] = extract._hash(['old-task', i])[:16]
            accumulated['delivered'].append(str(i))
        with patch.object(extract.time, 'time', return_value=now):
            migrated = extract.collect_since(self.cfg, legacy_cursor(accumulated))
            # The approved HMAC migration replaces the entire replay epoch once.
            authoritative = extract.build_replay(self.cfg, 12)
            self.assertEqual(migrated['events'], authoritative['events'])
            self.assertEqual(migrated['cursor'], authoritative['cursor'])
            self.assertEqual(extract.collect_since(self.cfg, migrated['cursor'])['events'], [])
            self.assertLessEqual(len(migrated['cursor']), 16384)
            migrated_state = extract._decode(migrated['cursor'])
            self.assertEqual(len(migrated_state['mana']), 300)
            self.assertEqual(len(migrated_state['tasks']), 200)
        print(f'History 10000 sessions/5000 tasks: window 300/200; '
              f'window-only={len(small["cursor"])} bytes; history={len(large["cursor"])} bytes', flush=True)

    def test_eviction_reentry_and_signed_corrections_do_not_duplicate(self):
        self.lifecycle_columns()
        now = self.f.now
        self.s.execute('UPDATE sessions SET ended_at=?,last_activity_at=?', (now, now))
        self.s.commit()
        self.f.k.execute('UPDATE tasks SET status=?,completed_at=?', ('done', now))
        self.f.k.execute('UPDATE task_runs SET ended_at=?', (now,))
        self.f.k.commit()
        with patch.object(extract.time, 'time', return_value=now):
            first = extract.build_replay(self.cfg, 12)
        live_ids = {e['id'] for e in first['events']}
        # The grace keeps both fingerprints and ledgers for one extra hour.
        with patch.object(extract.time, 'time', return_value=now + 12.5 * 3600):
            grace = extract.collect_since(self.cfg, first['cursor'])
            self.assertEqual(len(extract._decode(grace['cursor'])['mana']), 1)
        later = now + 14 * 3600
        with patch.object(extract.time, 'time', return_value=later):
            expired = extract.collect_since(self.cfg, grace['cursor'])
            state = extract._decode(expired['cursor'])
            for field in ('mana', 'mana_versions', 'tasks', 'delivered'):
                self.assertFalse(state[field])
            self.assertEqual(expired['events'], [])
            self.assertEqual(expired['tasks'], [])
            self.assertEqual(extract.collect_since(self.cfg, expired['cursor']), expired)
            self.message_at('assistant', later, token_count=10,
                           tool_calls=json.dumps([{'function': {'name': 'patch', 'arguments': '{}'}}]))
            self.s.execute('UPDATE session_model_usage SET input_tokens=130,output_tokens=0')
            self.s.execute('UPDATE sessions SET last_activity_at=?', (later,))
            self.s.commit()
            self.f.event('heartbeat', stamp=later)
            self.f.k.commit()
            returning = extract.collect_since(self.cfg, expired['cursor'])
            self.assertEqual(self.total(returning), 10, 'do not recharge historical usage')
            self.assertEqual(len(returning['tasks']), 1)
            self.assertEqual({e['kind'] for e in returning['events']}, {'heartbeat', 'tool', 'mana'})
            self.assertFalse(live_ids & {e['id'] for e in returning['events']})
            self.assertEqual(extract.collect_since(self.cfg, expired['cursor']), returning)
            cursor = returning['cursor']
            for usage, delta in ((180, 50), (155, -25), (180, 25)):
                self.s.execute('UPDATE session_model_usage SET input_tokens=?', (usage,))
                self.s.commit()
                result = extract.collect_since(self.cfg, cursor)
                self.assertEqual(self.total(result), delta)
                self.assertEqual(extract.collect_since(self.cfg, cursor), result)
                ids = {e['id'] for e in result['events']}
                self.assertFalse(live_ids & ids)
                live_ids |= ids
                cursor = result['cursor']
                self.assertEqual(extract.collect_since(self.cfg, cursor)['events'], [])
        # Reenter with activity only (no new message high-water mark). Repeated
        # usage values after a second eviction must still have fresh event IDs.
        later += 14 * 3600
        with patch.object(extract.time, 'time', return_value=later):
            expired = extract.collect_since(self.cfg, cursor)
            self.s.execute('UPDATE sessions SET last_activity_at=?', (later,))
            self.s.execute('UPDATE session_model_usage SET input_tokens=130')
            self.s.commit()
            baseline = extract.collect_since(self.cfg, expired['cursor'])
            self.assertEqual(baseline['events'], [])
            self.s.execute('UPDATE session_model_usage SET input_tokens=180')
            self.s.commit()
            correction = extract.collect_since(self.cfg, baseline['cursor'])
            self.assertEqual(self.total(correction), 50)
            self.assertFalse(live_ids & {e['id'] for e in correction['events']})

    def test_active_and_custom_window_and_legacy_retention(self):
        self.lifecycle_columns()
        ancient = self.f.now - 48 * 3600
        self.s.execute('UPDATE sessions SET started_at=?,last_activity_at=?', (ancient, ancient))
        self.s.execute('UPDATE messages SET timestamp=?', (ancient,))
        self.s.commit()
        first = extract.build_replay(self.cfg, 1)
        self.assertEqual(len(extract._decode(first['cursor'])['mana']), 1, 'active sessions survive')
        self.assertEqual(extract._decode(first['cursor'])['window_hours'], 1)
        self.s.execute('UPDATE sessions SET ended_at=?', (ancient,))
        self.s.commit()
        state = extract._decode(first['cursor'])
        state.pop('window_hours')  # Old JSON/HQ2 cursors default to 12 hours.
        result = extract.collect_since(self.cfg, legacy_cursor(state))
        self.assertEqual(result['events'], [])
        self.assertFalse(extract._decode(result['cursor'])['mana'])

    def test_task_only_reentry_preserves_event_high_water_marks(self):
        self.f.k.execute('UPDATE task_runs SET ended_at=?', (self.f.now,))
        self.f.k.commit()
        first = extract.build_replay(self.cfg, 12)
        self.f.k.execute('UPDATE tasks SET status=?,created_at=?,started_at=?,completed_at=?',
                         ('archived', 1, 1, 1))
        self.f.k.execute('UPDATE task_events SET created_at=1')
        self.f.k.execute('UPDATE task_runs SET started_at=1,ended_at=1')
        self.f.k.commit()
        db = self.f.home / 'profiles' / 'developer-demo' / 'state.db'
        absent = db.with_suffix('.absent')
        db.rename(absent)
        self.addCleanup(lambda: absent.rename(db))
        expired = extract.collect_since(self.cfg, first['cursor'])
        self.assertEqual([t['status'] for t in expired['tasks']], ['archived'],
                         'a formerly retained task needs one final snapshot tombstone')
        expired = extract.collect_since(self.cfg, expired['cursor'])
        self.assertFalse(extract._decode(expired['cursor'])['tasks'])
        self.f.event('heartbeat')
        self.f.k.commit()
        returning = extract.collect_since(self.cfg, expired['cursor'])
        self.assertEqual([e['kind'] for e in returning['events']], ['heartbeat'])
        self.assertEqual(len(returning['tasks']), 1)
        self.assertEqual(extract.collect_since(self.cfg, expired['cursor']), returning)
        after = extract.collect_since(self.cfg, returning['cursor'])
        self.assertEqual(after['events'], [])
        self.assertEqual(after['tasks'], [])

    def test_returning_session_with_delayed_usage_does_not_recharge_history(self):
        self.lifecycle_columns()
        now, later = self.f.now, self.f.now + 14 * 3600
        self.s.execute('UPDATE sessions SET ended_at=?', (now,))
        self.s.commit()
        first = extract.build_replay(self.cfg, 12)
        with patch.object(extract.time, 'time', return_value=later):
            expired = extract.collect_since(self.cfg, first['cursor'])
            self.s.execute('DELETE FROM session_model_usage')
            self.message_at('assistant', later, token_count=10)
            self.s.commit()
            returning = extract.collect_since(self.cfg, expired['cursor'])
            self.assertEqual(self.total(returning), 10)
            self.assertEqual(extract.collect_since(self.cfg, returning['cursor'])['events'], [])
            self.s.execute('INSERT INTO session_model_usage VALUES(?,?,0)', ('worker', 130))
            self.s.commit()
            baseline = extract.collect_since(self.cfg, returning['cursor'])
            self.assertEqual(self.total(baseline), 0, 'late usage must not recharge history')
            self.s.execute('UPDATE session_model_usage SET input_tokens=180')
            self.s.commit()
            correction = extract.collect_since(self.cfg, baseline['cursor'])
            self.assertEqual(self.total(correction), 50)
            self.assertEqual(extract.collect_since(self.cfg, baseline['cursor']), correction)

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
                retry = get('/events', since=cursor)
                self.assertGreaterEqual(retry['meta']['as_of'], delta['meta']['as_of'])
                self.assertEqual(retry['working']['as_of'], extract._iso(retry['meta']['as_of']))
                self.assertEqual(delta['working']['as_of'], extract._iso(delta['meta']['as_of']))
                retry['meta']['as_of'] = delta['meta']['as_of']
                retry['working']['as_of'] = delta['working']['as_of']
                self.assertEqual(retry, delta, 'retry rows/cursor must be identical apart from snapshot observation clocks')
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
