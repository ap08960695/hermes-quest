"""Growing and delayed synthetic usage; totals must equal a fresh replay."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import unittest

import test_extract

SOURCE = Path(os.environ.get('MANA_EXTRACT_SOURCE', Path(__file__).with_name('extract.py')))
spec = importlib.util.spec_from_file_location('mana_subject', SOURCE)
extract = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extract)


class ManaAccountingTests(unittest.TestCase):
    def setUp(self):
        self.f = test_extract.ExtractTests('test_snapshot_privacy_and_meta')
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        self.s = self.f.s
        self.cfg = self.f.cfg
        self.s.execute("DELETE FROM messages WHERE role<>'user'")
        self.s.execute('DELETE FROM session_model_usage')
        self.s.commit()

    def usage(self, n):
        self.s.execute('DELETE FROM session_model_usage')
        self.s.execute("INSERT INTO session_model_usage VALUES('worker',?,0)", (n,))
        self.s.commit()

    def mana(self, result):
        return [e for e in result['events'] if e['kind'] == 'mana']

    def total(self, result):
        return sum(e['tokens'] for e in self.mana(result))

    def replay(self):
        return extract.build_replay(self.cfg, 12)

    def advance(self, live, cursor):
        delta = extract.collect_since(self.cfg, cursor)
        self.assertEqual(extract.collect_since(self.cfg, cursor), delta, 'same cursor must be retry-safe')
        # The production client retains immutable IDs, never replaces old mana.
        for e in self.mana(delta):
            self.assertNotIn(e['id'], live)
            live[e['id']] = dict(e)
        self.assertEqual(sum(e['tokens'] for e in live.values()), self.total(self.replay()))
        self.assertEqual(extract.collect_since(self.cfg, delta['cursor'])['events'], [])
        return delta['cursor']

    def test_growing_usage_100_then_200_never_live_250(self):
        self.f.message('assistant', content='a' * 40)
        self.usage(100)
        first = self.replay()
        self.assertEqual(self.total(first), 100)
        live = {e['id']: dict(e) for e in self.mana(first)}
        old = dict(live)
        self.f.message('assistant', content='b' * 120)
        self.usage(200)
        delta = extract.collect_since(self.cfg, first['cursor'])
        self.assertEqual(self.total(delta), 100)
        self.advance(live, first['cursor'])
        for key in old:
            self.assertEqual(live[key], old[key])

    def test_delayed_usage_without_any_new_message(self):
        self.f.message('assistant', content='a' * 40)
        self.s.commit()
        first = self.replay()
        self.assertEqual(self.total(first), 10)
        live = {e['id']: dict(e) for e in self.mana(first)}
        self.usage(100)
        cursor = self.advance(live, first['cursor'])
        self.usage(200)
        self.advance(live, cursor)

    def test_delayed_smaller_usage_refunds_estimate_once(self):
        self.f.message('tool', tool_name='web_search', content='x' * 4000)
        self.s.commit()
        first = self.replay()
        self.assertEqual(self.total(first), 1000)
        live = {e['id']: dict(e) for e in self.mana(first)}
        self.usage(200)
        delta = extract.collect_since(self.cfg, first['cursor'])
        self.assertEqual(self.total(delta), -800)
        self.assertTrue(self.mana(delta)[0]['correction'])
        cursor = self.advance(live, first['cursor'])
        self.usage(100)
        cursor = self.advance(live, cursor)
        self.usage(200)
        self.advance(live, cursor)

    def test_tool_result_size_is_numeric_private_and_not_recharged(self):
        marker = 'RESULT MUST STAY PRIVATE '
        self.f.message('assistant', content='abcd')
        self.s.commit()
        first = self.replay()
        self.assertEqual(self.total(first), 1)
        self.f.message('tool', tool_name='web_search', content=marker + 'x' * (4000 - len(marker)))
        self.s.commit()
        sources = [self.f.home / 'kanban.db', self.f.home / 'profiles' / 'developer-demo' / 'state.db']
        before = [(hashlib.sha256(p.read_bytes()).hexdigest(), p.stat().st_mtime_ns) for p in sources]
        delta = extract.collect_since(self.cfg, first['cursor'])
        self.assertEqual(self.total(delta), 1000)
        self.assertEqual(self.total(self.replay()), 1001)
        self.assertNotIn(marker, json.dumps(delta))
        self.assertNotIn(marker, json.dumps(extract._decode(delta['cursor'])))
        self.assertEqual(extract.collect_since(self.cfg, delta['cursor'])['events'], [])
        self.assertEqual(before, [(hashlib.sha256(p.read_bytes()).hexdigest(), p.stat().st_mtime_ns) for p in sources])

    def test_real_tool_count_takes_precedence_over_size(self):
        self.f.message('tool', tool_name='web_search', content='x' * 4000, token_count=55)
        self.s.commit()
        result = self.replay()
        self.assertEqual(self.total(result), 55)
        self.assertNotIn('estimated', self.mana(result)[0])
        self.usage(100)
        live = {e['id']: dict(e) for e in self.mana(result)}
        cursor = self.advance(live, result['cursor'])
        self.f.message('assistant', content='b' * 120, token_count=70)
        self.usage(200)
        self.advance(live, cursor)

    def test_legacy_cursor_requires_revision_rebase_without_new_charges(self):
        self.f.message('assistant', content='abcd')
        self.usage(100)
        first = self.replay()
        legacy = extract._decode(first['cursor'])
        legacy.pop('mana', None)
        legacy.pop('mana_versions', None)
        delta = extract.collect_since(self.cfg, extract._cursor(legacy))
        self.assertEqual(delta['events'], [])
        self.assertNotEqual(delta['meta']['config_revision'], extract._hash([self.cfg, 'planner-demo']))
        self.assertEqual(self.total(self.replay()), 100)

    def test_usage_allocation_rounding_never_exceeds_total(self):
        for _ in range(7):
            self.f.message('assistant', content='abcde')
        self.usage(3)
        first = self.replay()
        self.assertEqual(self.total(first), 3)
        self.assertEqual(extract.collect_since(self.cfg, first['cursor'])['events'], [])


if __name__ == '__main__':
    unittest.main()
