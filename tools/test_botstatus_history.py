"""Synthetic tests for botstatus history, pause/resume/failover events and estimated mana.
Run: python3 -m unittest discover -s tools -p test_botstatus_history.py
No live Hermes data is opened; every path is inside a temporary directory.
"""
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import extract
import test_extract

spec = importlib.util.spec_from_file_location('bh_under_test', Path(extract.__file__).with_name('botstatus_history.py'))
bh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bh)

SECRET = '' + 'alice' + '@' + 'example.test ' + 'sk' + '-FAKEFAKEFAKE password=Hunter2 quota window 1% remaining'


def write_status(path, bots):
    path.write_text(json.dumps({'updated': 1, 'usage': {'anthropic': 5, 'who': SECRET},
                                'bots': {n: dict(status=s, reason=SECRET, since=ts) for n, (s, ts) in bots.items()}}))


class HistoryBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.status = self.home / 'bot-status.json'
        self.now = time.time()
        self.cfg = dict(hermes_home=str(self.home))
        self.settings = bh.resolve_settings(self.cfg, env={})

    def sample(self, bots, now=None):
        write_status(self.status, bots)
        return bh.sample_once(self.settings, now or self.now)

    def lines(self):
        return [json.loads(x) for x in (self.home / 'hermes-quest' / bh.FILE).read_text().splitlines()]


class HistoryTests(HistoryBase):
    def test_absent_or_damaged_source_writes_nothing_and_does_not_raise(self):
        self.assertEqual(bh.sample_once(self.settings), dict(state='absent', written=0))
        self.assertFalse((self.home / 'hermes-quest').exists())
        for text in ('', '{', '[]', '{"bots":3}', 'null'):
            self.status.write_text(text)
            self.assertEqual(bh.sample_once(self.settings)['state'], 'absent', text)
        self.assertEqual(bh.read_records(self.settings), [])

    def test_only_changes_are_written_and_no_reason_or_account_is_stored(self):
        self.assertEqual(self.sample({'dev': ('active', 1), 'qa': ('active', 1)})['written'], 0)  # baseline
        self.assertEqual(self.sample({'dev': ('active', 1), 'qa': ('active', 1)})['written'], 0)
        self.assertEqual(self.sample({'dev': ('limited', self.now - 5), 'qa': ('active', 1)})['written'], 1)
        self.assertEqual(self.sample({'dev': ('limited', self.now - 5), 'qa': ('active', 1)})['written'], 0)
        self.assertEqual(self.sample({'dev': ('active', self.now), 'qa': ('waiting-start', self.now)})['written'], 2)
        records = self.lines()
        self.assertEqual([(r['profile'], r['status'], r['prev']) for r in records],
                         [('dev', 'limited', 'active'), ('dev', 'active', 'limited'), ('qa', 'waiting-start', 'active')])
        raw = (self.home / 'hermes-quest' / bh.FILE).read_text()
        for leak in ('alice', 'example.test', 'sk' + '-FAKE', 'Hunter2', 'quota', 'reason', 'usage'):
            self.assertNotIn(leak, raw)
        self.assertEqual(set(records[0]), {'v', 'seq', 'ts', 'type', 'profile', 'status', 'prev'})

    def test_invalid_status_and_profile_names_are_ignored(self):
        self.status.write_text(json.dumps({'bots': {'ok': {'status': 'limited'}, 'a b@c': {'status': 'limited'},
                                                    'bad': {'status': 'password=Hunter2'}, '../x': {'status': 'limited'}}}))
        bh.sample_once(self.settings, self.now)
        self.assertEqual([r['profile'] for r in self.lines()], ['ok'])

    def test_failover_comments_become_records_without_reason_text(self):
        k = sqlite3.connect(self.home / 'kanban.db')
        self.addCleanup(k.close)
        k.execute('CREATE TABLE task_comments(id INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT,author TEXT,body TEXT,created_at REAL)')
        k.execute("INSERT INTO task_comments(task_id,author,body,created_at) VALUES('t_00000001','x','[failover] dev limited (old) -> qa',1)")
        k.commit()
        self.sample({'dev': ('active', 1), 'qa': ('active', 1)})  # first run: pre-existing failovers are not replayed
        self.assertEqual(bh.read_records(self.settings), [])
        k.execute("INSERT INTO task_comments(task_id,author,body,created_at) VALUES('t_00000001','x',?,?)",
                  (f'[failover] dev limited ({SECRET}) -> qa. Same card', self.now - 1))
        k.execute("INSERT INTO task_comments(task_id,author,body,created_at) VALUES('t_00000001','x','[failover] ghost limited -> qa',?)", (self.now,))
        k.execute("INSERT INTO task_comments(task_id,author,body,created_at) VALUES('t_00000001','x','not a failover -> qa',?)", (self.now,))
        k.commit()
        self.assertEqual(self.sample({'dev': ('active', 1), 'qa': ('active', 1)})['written'], 1)
        self.assertEqual([(r['type'], r['profile'], r['to']) for r in bh.read_records(self.settings)], [('failover', 'dev', 'qa')])
        self.assertNotIn('Hunter2', (self.home / 'hermes-quest' / bh.FILE).read_text())
        self.assertEqual(self.sample({'dev': ('active', 1), 'qa': ('active', 1)})['written'], 0)  # cursor advanced

    def test_rotation_is_bounded_and_ordered(self):
        cfg = dict(self.cfg, history_max_bytes=4096, history_keep=2)
        self.settings = bh.resolve_settings(cfg, env={})
        flip = 'limited'
        for i in range(120):
            flip = 'active' if flip == 'limited' else 'limited'
            self.sample({'dev-profile-name': (flip, self.now)}, self.now + i)
        directory = self.home / 'hermes-quest'
        names = sorted(p.name for p in directory.iterdir())
        self.assertEqual(names, sorted([bh.FILE, bh.FILE + '.1', bh.FILE + '.2', bh.LOCK, bh.STATE]))
        for p in directory.glob(bh.FILE + '*'):
            self.assertLess(p.stat().st_size, 4096 + 1024)
        seqs = [r['seq'] for r in bh.read_records(self.settings)]
        self.assertEqual(seqs, sorted(set(seqs)))
        self.assertGreater(len(seqs), 20)
        self.assertLess(len(seqs), 120)  # oldest rotated away

    def test_damaged_lines_and_state_are_survivable(self):
        self.sample({'dev': ('active', 1)})
        self.sample({'dev': ('limited', self.now)})
        path = self.home / 'hermes-quest' / bh.FILE
        path.write_text(path.read_text() + 'garbage\n{"v":1,"seq":"x"}\n' + '[' * 5000 + '\n')
        (self.home / 'hermes-quest' / bh.STATE).write_text('{nope')
        self.assertEqual(len(bh.read_records(self.settings)), 1)
        self.assertEqual(self.sample({'dev': ('limited', self.now)})['written'], 0)  # state rebuilt from history
        self.assertEqual(self.sample({'dev': ('active', self.now)})['written'], 1)

    def test_config_validation(self):
        for bad in (dict(history_max_bytes=10), dict(history_keep=-1), dict(history_sample_seconds=True),
                    dict(botstatus_path=''), dict(history_dir=5)):
            with self.assertRaises(ValueError, msg=bad):
                bh.resolve_settings(dict(self.cfg, **bad), env={})
        with patch.dict(os.environ, {'HERMES_HOME': str(self.home), 'HERMES_QUEST_CONFIG': ''}):
            cfg = extract.load_config()
        self.assertEqual(bh.resolve_settings(cfg, env={})['botstatus_path'], self.home.resolve() / 'bot-status.json')
        path = self.home / 'q.json'
        path.write_text(json.dumps({'history_keep': 999}))
        with self.assertRaises(ValueError):
            extract.load_config(path)

    def test_status_file_is_only_read(self):
        """mtime/content unchanged, and no write-mode open of the source at any point."""
        write_status(self.status, {'dev': ('active', 1)})
        bh.sample_once(self.settings, self.now)
        write_status(self.status, {'dev': ('limited', self.now)})
        os.utime(self.status, (1_000_000_000, 1_000_000_000))
        before = (self.status.stat().st_mtime_ns, self.status.read_bytes())
        opened = []
        real_open, real_os_open = open, os.open
        target = str(self.status)

        def spy(path, *a, **k):
            if str(path) == target:
                opened.append(('open', a, k))
            return real_open(path, *a, **k)

        def spy_os(path, flags, *a, **k):
            if str(path) == target:
                opened.append(('os.open', flags))
                self.assertEqual(flags & (os.O_WRONLY | os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_TRUNC), 0)
            return real_os_open(path, flags, *a, **k)

        with patch('builtins.open', spy), patch('os.open', spy_os):
            self.assertEqual(bh.sample_once(self.settings, self.now)['written'], 1)
        self.assertTrue(opened)
        self.assertEqual((self.status.stat().st_mtime_ns, self.status.read_bytes()), before)
        # Other process holding a write handle would show up in /proc; none of ours remain open.
        if Path('/proc/self/fd').exists():
            for fd in Path('/proc/self/fd').iterdir():
                try:
                    self.assertNotEqual(os.readlink(fd), target)
                except OSError:
                    pass

    def test_one_shot_cli(self):
        write_status(self.status, {'dev': ('limited', 1)})
        cfg = self.home / 'q.json'
        cfg.write_text(json.dumps(self.cfg))
        run = lambda: subprocess.run([sys.executable, '-B', str(Path(bh.__file__)), '--config', str(cfg)],
                                     capture_output=True, text=True)
        first = run()
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(first.stdout.strip(), 'botstatus-history: ok written=1')
        self.assertEqual(run().stdout.strip(), 'botstatus-history: ok written=0')
        cfg.write_text('{"history_keep": "x"}')
        bad = run()
        self.assertEqual(bad.returncode, 1)
        self.assertEqual(bad.stdout, '')
        self.assertNotIn('Traceback', bad.stderr)

    def test_import_has_no_side_effects(self):
        program = ('import builtins,sqlite3,os,importlib.util,sys\n'
                   'sys.dont_write_bytecode=True\n'
                   'def f(*a,**k): raise AssertionError("side effect")\n'
                   'builtins.open=f; sqlite3.connect=f; os.makedirs=f; os.open=f\n'
                   's=importlib.util.spec_from_file_location("m",%r); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)\n'
                   'assert callable(m.sample_once)\n') % bh.__file__
        r = subprocess.run([sys.executable, '-B', '-c', program], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)


class ExtractEventTests(HistoryBase):
    def setUp(self):
        super().setUp()
        self.k = sqlite3.connect(self.home / 'kanban.db')  # no board -> the extractor emits nothing at all
        self.addCleanup(self.k.close)
        self.k.executescript('''
CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT,assignee TEXT,status TEXT,created_by TEXT,created_at REAL,started_at REAL,completed_at REAL,workspace_path TEXT,provider_override TEXT,max_runtime_seconds INTEGER);
CREATE TABLE task_events(id INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT,run_id INTEGER,kind TEXT,payload TEXT,created_at REAL);
CREATE TABLE task_comments(id INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT,author TEXT,body TEXT,created_at REAL);
CREATE TABLE task_runs(id INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT,profile TEXT,started_at REAL,ended_at REAL,outcome TEXT);
CREATE TABLE task_links(parent_id TEXT,child_id TEXT);
''')
        self.k.commit()

    def cfg_for(self, **extra):
        cfg = dict(self.cfg, **extra)
        with patch.dict(os.environ, {'HERMES_HOME': str(self.home), 'HERMES_QUEST_CONFIG': ''}):
            base = extract.load_config()
        base.update(history_keep=3, captain='planner-demo', profiles=[])
        base.update(extra)
        return base

    def test_pause_resume_failover_events_are_incremental_and_redacted(self):
        cfg = self.cfg_for()
        initial = extract.build_replay(cfg, 1)
        self.assertEqual([e for e in initial['events'] if e['kind'] in ('pause', 'resume', 'failover')], [])
        k = self.k
        self.sample({'dev': ('active', 1), 'qa': ('active', 1)}, self.now - 30)
        self.sample({'dev': ('limited', self.now - 20), 'qa': ('active', 1)}, self.now - 20)
        k.execute("INSERT INTO task_comments(task_id,author,body,created_at) VALUES('t_00000001','x',?,?)",
                  (f'[failover] dev limited ({SECRET}) -> qa', self.now - 10))
        k.commit()
        self.sample({'dev': ('limited', self.now - 20), 'qa': ('active', 1)}, self.now - 10)
        self.sample({'dev': ('active', self.now - 5), 'qa': ('active', 1)}, self.now - 5)
        delta = extract.collect_since(cfg, initial['cursor'])
        events = [e for e in delta['events'] if e['kind'] in ('pause', 'resume', 'failover')]
        self.assertEqual([e['kind'] for e in events], ['pause', 'failover', 'resume'])
        dev, qa = extract._bot_id('dev'), extract._bot_id('qa')
        self.assertEqual([(e['bot'], e.get('why'), e.get('other')) for e in events],
                         [(dev, 'limited', None), (dev, None, qa), (dev, 'limited', None)])
        self.assertTrue(all('task' not in e and e['id'].startswith('e_') for e in events))
        dumped = json.dumps(delta)
        for leak in ('alice', 'Hunter2', 'sk' + '-FAKE', 'example.test', '"dev"', '"qa"'):
            self.assertNotIn(leak, dumped)
        self.assertIn(qa, [b['id'] for b in delta['bots']])  # the failover target is a known bot
        again = extract.collect_since(cfg, delta['cursor'])
        self.assertEqual([e for e in again['events'] if e['kind'] in ('pause', 'resume', 'failover')], [])
        # A replay covers the same window and yields identical ids (no duplicate on the client).
        replay = extract.build_replay(cfg, 1)
        self.assertEqual({e['id'] for e in replay['events'] if e['kind'] in ('pause', 'resume', 'failover')},
                         {e['id'] for e in events})

    def test_absent_history_and_status_file_leave_replay_unchanged(self):
        cfg = self.cfg_for()
        before = set(self.home.rglob('*'))
        replay = extract.build_replay(cfg, 1)
        self.assertEqual(replay['events'], [])
        self.assertEqual(set(self.home.rglob('*')), before)  # the extractor never creates the history directory
        delta = extract.collect_since(cfg, replay['cursor'])
        self.assertEqual(delta['cursor'], replay['cursor'])

    def test_history_is_not_replayed_for_a_cursor_that_already_saw_it(self):
        cfg = self.cfg_for()
        self.sample({'dev': ('active', 1)}, self.now - 10)
        self.sample({'dev': ('unavailable', self.now - 5)}, self.now - 5)
        first = extract.build_replay(cfg, 1)
        self.assertEqual([e['why'] for e in first['events'] if e['kind'] == 'pause'], ['unavailable'])
        self.assertEqual(extract.collect_since(cfg, first['cursor'])['events'], [])


class EstimatedManaTests(unittest.TestCase):
    """Reuses the synthetic Hermes fixture (one worker session, real token_count on one message)."""

    def setUp(self):
        self.f = test_extract.ExtractTests('test_snapshot_privacy_and_meta')
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)

    def __getattr__(self, name):
        if name == 'f':
            raise AttributeError(name)
        return getattr(self.f, name)

    def mana(self, result):
        return [e for e in result['events'] if e['kind'] == 'mana']

    def test_real_token_count_is_kept_and_not_marked_estimated(self):
        mana = self.mana(extract.build_replay(self.cfg, 12))
        self.assertEqual([m['tokens'] for m in mana if 'estimated' not in m], [42])

    def test_estimate_is_chars_over_four_rounded_up_numbers_only(self):
        self.s.execute('DROP TABLE session_model_usage')
        marker = 'FICTIONAL ESTIMATE MARKER'
        self.message('assistant', content=marker * 3 + 'x')          # 76 chars
        self.tool('terminal', {'command': 'echo ' + marker})          # tool_calls JSON counts too
        self.message('tool', tool_name='terminal', content='{"exit_code":0}' + marker)  # results are not "mana"
        self.s.commit()
        result = extract.build_replay(self.cfg, 12)
        estimated = [m for m in self.mana(result) if m.get('estimated')]
        # Each assistant / result message contributes its numeric size once.
        self.assertEqual(len(estimated), 3)
        by = sorted(m['tokens'] for m in estimated)
        self.assertIn(19, by)  # 76 chars -> 19 tokens
        for m in estimated:
            self.assertEqual(m['basis'], 'chars')
            self.assertIs(m['estimated'], True)
            self.assertEqual(set(m) - {'t', 'task', 'bot', 'kind', 'tokens', 'estimated', 'basis', 'id',
                                      'session_ref', 'parent_session_ref'}, set())
            self.assertRegex(m['session_ref'], r'^[0-9a-f]{20}$')
            self.assertIsNone(m['parent_session_ref'])
        self.assertNotIn(marker, json.dumps(result))
        c = self.s.execute("SELECT coalesce(length(content),0)+coalesce(length(tool_calls),0) FROM messages WHERE role IN ('assistant','tool') AND token_count IS NULL ORDER BY id").fetchall()
        self.assertEqual(sorted(-(-r[0] // 4) for r in c if r[0]), by)

    def test_session_usage_is_authoritative_and_marked(self):
        # Real counts stay immutable; session remainder is one numeric adjustment.
        self.message('assistant', content='a' * 40)
        self.message('assistant', content='b' * 120)
        self.s.commit()
        mana = [m for m in self.mana(extract.build_replay(self.cfg, 12)) if m.get('estimated')]
        self.assertEqual({m['basis'] for m in mana}, {'usage'})
        self.assertEqual(sum(m['tokens'] for m in mana), 78)
        self.assertTrue(all(m['correction'] for m in mana))

    def test_empty_messages_and_zero_counts_emit_nothing_and_are_incremental(self):
        self.s.execute('DROP TABLE session_model_usage')
        initial = extract.build_replay(self.cfg, 12)
        self.message('assistant', content='')
        self.message('assistant', content=None)
        self.message('user', content='u' * 400)
        self.message('assistant', content='abcde')
        self.s.commit()
        delta = extract.collect_since(self.cfg, initial['cursor'])
        self.assertEqual([m['tokens'] for m in self.mana(delta)], [2])  # ceil(5/4); user text is never mana
        self.assertEqual(extract.collect_since(self.cfg, delta['cursor'])['events'], [])


if __name__ == '__main__':
    unittest.main()
