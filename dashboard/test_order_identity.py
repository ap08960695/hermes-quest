"""R-F8: real backend -> shipped reducer/social, synthetic SQLite only.

Run: python -m unittest dashboard.test_order_identity
QUEST_ORDER_ROOT points the same regression at an archived baseline (both Python and JS).
Old payloads without source_action_ref intentionally retain legacy tuple deduplication.
"""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import unittest

HERE = Path(__file__).resolve().parent.parent
ROOT = Path(os.environ.get('QUEST_ORDER_ROOT', HERE)).resolve()
sys.path.insert(0, str(ROOT / 'dashboard'))
from test_scene_contract import Scene


class OrderIdentityTests(unittest.TestCase):
    def reduce(self, replay, deltas):
        result = subprocess.run(['node', str(HERE / 'tools/test_order_identity.cjs')],
                                cwd=ROOT, input=json.dumps(dict(replay=replay, deltas=deltas)),
                                text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def board(self, scene, sql):
        with sqlite3.connect(Path(scene.cfg['hermes_home']) / 'kanban.db') as db:
            db.execute(sql)

    def captain(self, scene):
        db = sqlite3.connect(Path(scene.cfg['hermes_home']) / 'profiles/planner-demo/state.db')
        db.executescript('''CREATE TABLE sessions(id TEXT PRIMARY KEY,source TEXT,parent_session_id TEXT,started_at REAL,title TEXT);
CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,tool_calls TEXT,tool_name TEXT,tool_call_id TEXT,timestamp REAL,token_count INTEGER);''')
        db.execute("INSERT INTO sessions VALUES('captain','cli',NULL,?,'Captain')", (scene.now - 100,))
        db.commit()
        self.addCleanup(db.close)
        return db

    def calls(self, db, row, stamp, count=1):
        calls = [{'id': 'private-call-%s-%s' % (row, i), 'function': {
            'name': 'kanban_comment', 'arguments': json.dumps({
                'task_id': 't_a0000001', 'body': 'PRIVATE_PROSE_SENTINEL'})}} for i in range(count)]
        db.execute("INSERT INTO messages VALUES(?,'captain','assistant',NULL,?,NULL,NULL,?,NULL)",
                   (row, json.dumps(calls), stamp))
        db.commit()

    def test_current_recipient_change_is_not_an_action(self):
        with Scene(None, show_profile_names=True, show_titles=True) as s:
            first = s.replay()
            self.board(s, "UPDATE tasks SET assignee='tester-demo' WHERE id='t_a0000004'")
            changed = s.delta(first['cursor'])
            self.board(s, "UPDATE tasks SET assignee=NULL WHERE id='t_a0000004'")
            unassigned = s.delta(changed['cursor'])
            outcome = self.reduce(first, [changed, unassigned])
            self.assertEqual(outcome['hooks'], 0, outcome)
            self.assertEqual(changed['events'], [])
            self.assertEqual(first['working']['latest_order']['source_action_ref'],
                             unassigned['working']['latest_order']['source_action_ref'])
            self.assertNotEqual(first['working']['latest_order']['recipient_bot_ref'],
                                changed['working']['latest_order']['recipient_bot_ref'])
            self.assertNotEqual(first['working']['latest_order']['action_label'],
                                unassigned['working']['latest_order']['action_label'])

    def test_distinct_rows_within_one_second_both_dispatch(self):
        with Scene(None, show_profile_names=True) as s:
            db = self.captain(s)
            first = s.replay()
            self.calls(db, 1, s.now - 5.8)
            a = s.delta(first['cursor'])
            self.calls(db, 2, s.now - 5.2)
            b = s.delta(a['cursor'])
            idle = s.delta(b['cursor'])
            result = self.reduce(first, [a, b, idle])
            self.assertEqual(result['hooks'], 2, result)
            self.assertEqual(result['couriers'], 2, result)
            self.assertEqual(result['duplicateCouriers'], 0, result)
            oa, ob = a['working']['latest_order'], b['working']['latest_order']
            self.assertEqual(oa['at'], ob['at'])
            self.assertNotEqual(oa['source_action_ref'], ob['source_action_ref'])
            self.assertEqual(ob, idle['working']['latest_order'])
            for payload in [a, b, idle]:
                self.assertNotIn('private-call', json.dumps(payload))
                self.assertNotIn('PRIVATE_PROSE_SENTINEL', json.dumps(payload))

    def test_call_index_and_idle_snapshot_identity_agree(self):
        with Scene(None, show_profile_names=True) as s:
            db = self.captain(s)
            self.calls(db, 1, s.now - 5.8)
            first = s.replay()
            # Same row and timestamp; a distinct appended call must still dispatch.
            calls = json.loads(db.execute('SELECT tool_calls FROM messages').fetchone()[0])
            calls.append({**calls[0], 'id': 'private-call-new'})
            db.execute('UPDATE messages SET tool_calls=? WHERE id=1', (json.dumps(calls),))
            db.commit()
            delta = s.delta(first['cursor'])
            result = self.reduce(first, [delta])
            self.assertEqual(result['hooks'], 1, result)
            self.assertNotEqual(first['working']['latest_order']['source_action_ref'],
                                delta['working']['latest_order']['source_action_ref'])
            self.assertEqual(delta['working']['latest_order'], s.replay()['working']['latest_order'])

    def test_alias_title_prose_changes_and_legacy_payloads(self):
        with Scene(None, show_profile_names=True, show_titles=True) as s:
            db = self.captain(s)
            self.calls(db, 1, s.now - 5)
            first = s.replay()
            (Path(s.cfg['hermes_home']) / 'profiles/developer-demo/profile.yaml').write_text('display_name: New alias\n')
            self.board(s, "UPDATE tasks SET title='Changed safe title' WHERE id='t_a0000001'")
            calls = json.loads(db.execute('SELECT tool_calls FROM messages').fetchone()[0])
            calls[0]['function']['arguments'] = json.dumps({'task_id': 't_a0000001', 'body': 'Other prose'})
            db.execute('UPDATE messages SET tool_calls=?', (json.dumps(calls),))
            db.commit()
            delta = s.delta(first['cursor'])
            self.assertEqual(self.reduce(first, [delta])['hooks'], 0)
            self.assertEqual(first['working']['latest_order']['source_action_ref'],
                             delta['working']['latest_order']['source_action_ref'])
            for payload in [first, delta]:
                payload['working']['latest_order'].pop('source_action_ref', None)
            # Older payloads still accept, dedupe repeat tuples and ignore title/alias changes.
            self.assertEqual(self.reduce(first, [delta, delta])['hooks'], 0)

    def test_nonobject_call_slots_keep_delivery_and_idle_identity(self):
        with Scene(None, show_profile_names=True) as s:
            db = self.captain(s)
            first = s.replay()
            self.calls(db, 1, s.now - 5)
            calls = json.loads(db.execute('SELECT tool_calls FROM messages').fetchone()[0])
            db.execute('UPDATE messages SET tool_calls=?', (json.dumps([None, 'private-slot'] + calls),))
            db.commit()
            delta = s.delta(first['cursor'])
            idle = s.delta(delta['cursor'])
            self.assertEqual(self.reduce(first, [delta, idle])['hooks'], 1)
            ref = delta['working']['latest_order']['source_action_ref']
            self.assertEqual(ref, idle['working']['latest_order']['source_action_ref'])
            self.assertEqual(ref, next(e['source_action_ref'] for e in delta['events'] if e.get('act') == 'note'))

    def test_missing_key_is_fail_closed_and_legacy_compatible(self):
        with Scene(None) as s:
            (Path(s.cfg['hermes_home']) / 'hermes-quest/session-ref.key').unlink()
            first = s.replay()
            delta = s.delta(first['cursor'])
            self.assertIsNone(first['working']['latest_order']['source_action_ref'])
            self.assertEqual(self.reduce(first, [delta])['hooks'], 0)


if __name__ == '__main__':
    unittest.main()
