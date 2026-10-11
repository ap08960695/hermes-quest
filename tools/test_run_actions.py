"""Full-run numeric action projection; no private fixtures or prose output."""
import json
import sqlite3
import unittest
import extract


class RunActionsTests(unittest.TestCase):
    def test_boundaries_messages_and_json1_fallback(self):
        db = sqlite3.connect(':memory:')
        db.row_factory = sqlite3.Row
        db.executescript('CREATE TABLE messages(session_id TEXT,timestamp REAL,role TEXT,content TEXT,tool_calls TEXT);')
        calls = json.dumps([{'function': {'name': 'read_file'}}, {'function': {'name': 'terminal'}}])
        db.executemany('INSERT INTO messages VALUES(?,?,?,?,?)', [
            ('root', 9, 'assistant', 'old attempt', None),
            ('root', 10, 'assistant', 'PRIVATE_SENTINEL', calls),
            ('root', 11, 'assistant', 'PRIVATE_SENTINEL', None),
            ('root', 12, 'tool', 'result is not an action', None),
            ('root', 13, 'assistant', '', None),
            ('root', 15, 'assistant', 'future attempt', None),
            ('other', 11, 'assistant', 'other task', calls),
        ])
        for json1 in (True,):
            self.assertEqual(extract._run_actions(db, 'root', 10, 14, json1), (3, 11))
            self.assertEqual(extract._run_actions(db, 'root', 12, 14, json1), (0, None))
            self.assertEqual(extract._run_actions(db, 'root', 15, 15, json1), (1, 15))
        self.assertEqual(extract._run_actions(db, 'root', 10, 14, False), (None, None))
        db.close()


if __name__ == '__main__':
    unittest.main()
