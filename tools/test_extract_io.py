"""Read-only window queries must preserve payloads and avoid historical bodies."""
import importlib.util
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import test_extract as fixtures

extract = fixtures.extract


class WindowIOTests(unittest.TestCase):
    def test_latest_orders_preserve_null_orphan_ids_and_source_order(self):
        for indexed in (False, True):
            with self.subTest(indexed=indexed), sqlite3.connect(':memory:') as db:
                db.row_factory = sqlite3.Row
                db.execute('CREATE TABLE messages(session_id TEXT,role TEXT,timestamp REAL,tool_calls TEXT)')
                if indexed:
                    db.execute('CREATE INDEX time_range ON messages(session_id,timestamp)')
                def calls(tid):
                    return json.dumps([{'function': {'name': 'kanban_comment',
                                                     'arguments': json.dumps({'task_id': tid})}}])
                db.executemany('INSERT INTO messages VALUES(?,?,?,?)', [
                    ('orphan', 'assistant', 30, calls('t_12345678')),
                    (None, 'assistant', 20, calls('t_87654321')),
                    ('orphan', 'assistant', 10, calls('t_11111111')),
                    ('orphan', 'assistant', 25, '{broken'),
                    ('orphan', 'tool', 25, calls('t_22222222')),
                    ('older', 'assistant', -500, calls('t_33333333'))])
                rows = [dict(r) for r in db.execute(extract._latest_order_sql(), (20, 30))]
                self.assertEqual([(r['seq'], r['task_id']) for r in rows],
                                 [(1, 't_12345678'), (2, 't_87654321')])
                self.assertEqual(list(db.execute(extract._latest_order_sql(False), (20, 30))), [])
                if indexed:
                    plan = [r[3] for r in db.execute('EXPLAIN QUERY PLAN ' + extract._latest_order_sql(), (20, 30))]
                    self.assertTrue(any('time_range' in p and 'timestamp>' in p for p in plan), plan)
                    self.assertFalse(any(p == 'SCAN messages' for p in plan), plan)

    def test_frozen_payload_and_delta_equal_release_with_indexed_history(self):
        # Reuse synthetic contract sources, never the operator's DBs or payloads.
        fixture = fixtures.ExtractTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        now = fixture.now
        fixture.s.executescript('CREATE INDEX time_range ON messages(session_id,timestamp); '
                               'CREATE INDEX row_range ON messages(session_id,id);')
        fixture.s.executemany('INSERT INTO messages(session_id,role,content,timestamp) VALUES(?,?,?,?)',
                             [('worker', 'assistant', 'old body', now - 100000)] * 100)
        fixture.s.commit()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            repo = Path(extract.__file__).resolve().parent.parent
            source = subprocess.check_output(['git', 'show',
                                             '0ace110650c25a6f2698ca144ef4200d27adcde2:tools/extract.py'], cwd=repo)
            (root / 'extract.py').write_bytes(source)
            (root / 'botstatus_history.py').write_bytes((repo / 'tools/botstatus_history.py').read_bytes())
            spec = importlib.util.spec_from_file_location('release_extract_io', root / 'extract.py')
            assert spec is not None and spec.loader is not None
            baseline = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(baseline)
            def collect(module):
                with patch.object(module.time, 'time', return_value=now):
                    replay = module.build_replay(fixture.cfg, 12)
                    delta = module.collect_since(fixture.cfg, replay['cursor'])
                for payload in (replay, delta):
                    for bot in payload['bots']:
                        bot.pop('availability', None)
                return replay, delta
            for status, completed in [('running', None), ('done', now - 100000),
                                      ('done', now - 43200), ('archived', now)]:
                with self.subTest(status=status, completed=completed):
                    fixture.k.execute('UPDATE tasks SET status=?,completed_at=?,started_at=?',
                                      (status, completed, completed or now))
                    fixture.k.execute('UPDATE task_runs SET started_at=?,ended_at=?',
                                      (completed or now, completed))
                    fixture.k.commit()
                    self.assertEqual(collect(extract), collect(baseline))
            # Verify the time seek does not become a rowid/history body scan when
            # both production-style indexes are available.
            queries = []
            real_ro = extract.ro
            def observed_ro(path):
                db = real_ro(path)
                db.set_trace_callback(queries.append)
                return db
            with patch.object(extract, 'ro', side_effect=observed_ro):
                collect(extract)
            window = next(q for q in queries if q.startswith('WITH window_rows AS MATERIALIZED (SELECT rowid AS seq'))
            plan = [r[3] for r in fixture.s.execute('EXPLAIN QUERY PLAN ' + window)]
            self.assertTrue(any('COVERING INDEX time_range' in p and 'timestamp>' in p for p in plan), plan)


if __name__ == '__main__':
    unittest.main()
