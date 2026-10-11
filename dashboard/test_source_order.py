"""Source chronology/privacy regression; synthetic SQLite, no Hermes runtime.
QUEST_SOURCE_ROOT runs this oracle against the old extractor unchanged.
"""
import json
import os
from pathlib import Path
import sqlite3
import sys
import unittest

ROOT = Path(os.environ.get('QUEST_SOURCE_ROOT', Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(ROOT / 'dashboard'))
from test_scene_contract import Scene


class SourceOrderTests(unittest.TestCase):
    def worker(self, scene, profile='developer-demo', sid='PRIVATE_SESSION_SENTINEL'):
        db = sqlite3.connect(Path(scene.cfg['hermes_home']) / 'profiles' / profile / 'state.db')
        db.executescript('''CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,source TEXT,parent_session_id TEXT,started_at REAL,title TEXT);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,tool_calls TEXT,tool_name TEXT,tool_call_id TEXT,timestamp REAL,token_count INTEGER);''')
        db.execute('INSERT INTO sessions VALUES(?,\'kanban\',NULL,?,\'Worker\')', (sid, scene.now - 40))
        row = db.execute('SELECT coalesce(max(id),0)+1 FROM messages').fetchone()[0]
        db.execute('INSERT INTO messages VALUES(?,?,\'user\',\'task t_a0000001\',NULL,NULL,NULL,?,NULL)', (row, sid, scene.now - 40))
        db.commit()
        self.addCleanup(db.close)
        return db

    def calls(self, db, row, sid, stamp):
        calls = [{'id': 'PRIVATE_CALL_SENTINEL', 'function': {'name': name, 'arguments': 'PRIVATE_ARGS_SENTINEL'}}
                 for name in ['read_file', 'terminal']]
        db.execute('INSERT INTO messages VALUES(?,?,\'assistant\',\'PRIVATE_TEXT_SENTINEL\',?,NULL,NULL,?,NULL)',
                   (row, sid, json.dumps(calls), stamp))
        db.commit()

    def actions(self, data):
        return [e for e in data['events'] if e['kind'] in ('tool', 'activity')]

    def count(self, data):
        return next(i['action_count'] for i in data['working']['items'] if i['task_ref'] == 't_a0000001')

    def assert_private(self, data):
        for sentinel in ['PRIVATE_SESSION_SENTINEL', 'PRIVATE_CALL_SENTINEL', 'PRIVATE_ARGS_SENTINEL', 'PRIVATE_TEXT_SENTINEL']:
            self.assertNotIn(sentinel, json.dumps(data))
        for e in self.actions(data):
            self.assertIsInstance(e['source_seq'], int)
            self.assertIsInstance(e['source_slot'], int)
            self.assertRegex(e['session_ref'], r'^[0-9a-f]{20}$')

    def test_ten_same_message_pairs_follow_source_slots_in_all_privacy_modes(self):
        for names, titles in [(False, False), (True, False), (True, True)]:
            with self.subTest(names=names, titles=titles), Scene(self, show_profile_names=names, show_titles=titles) as s:
                db = self.worker(s)
                for row in range(2, 12):
                    self.calls(db, row, 'PRIVATE_SESSION_SENTINEL', s.now - 30 + row)
                data = s.replay()
                self.assertEqual([e['tool'] for e in self.actions(data)], ['read_file', 'terminal'] * 10)
                self.assertEqual(self.count(data), 20)
                self.assert_private(data)

    def test_same_time_message_rows_and_incremental_ordinals_are_stable(self):
        with Scene(self) as s:
            db = self.worker(s)
            initial = s.replay()
            self.calls(db, 2, 'PRIVATE_SESSION_SENTINEL', s.now - 10)
            first = s.delta(initial['cursor'])
            self.calls(db, 3, 'PRIVATE_SESSION_SENTINEL', s.now - 10)
            second = s.delta(first['cursor'])
            replay = s.replay()
            events = self.actions(replay)
            self.assertEqual([(e['source_seq'], e['source_slot']) for e in events], [(2, 0), (2, 1), (3, 0), (3, 1)])
            self.assertEqual(self.actions(first) + self.actions(second), events)
            self.assertEqual(self.count(second), 4)
            self.assertEqual(self.count(replay), 4)
            self.assertEqual(self.actions(s.delta(second['cursor'])), [])
            self.assert_private(replay)

    def test_independent_profiles_and_sessions_have_deterministic_discriminators(self):
        with Scene(self) as s:
            for profile in ['developer-demo', 'tester-demo']:
                db = self.worker(s, profile)
                self.calls(db, 2, 'PRIVATE_SESSION_SENTINEL', s.now - 10)
                db = self.worker(s, profile, 'PRIVATE_SESSION_SENTINEL-2')
                self.calls(db, 4, 'PRIVATE_SESSION_SENTINEL-2', s.now - 10)
            a, b = self.actions(s.replay()), self.actions(s.replay())
            self.assertEqual(a, b)
            self.assertEqual(len({(e['bot'], e['session_ref']) for e in a}), 4)
            self.assertEqual([(e['source_seq'], e['source_slot']) for e in a],
                             [(e['source_seq'], e['source_slot']) for e in sorted(a, key=lambda e: (e['bot'], e['session_ref'], e['source_seq'], e['source_slot']))])
            for i in range(0, len(a), 2):
                self.assertEqual([e['tool'] for e in a[i:i+2]], ['read_file', 'terminal'])


if __name__ == '__main__':
    unittest.main()
