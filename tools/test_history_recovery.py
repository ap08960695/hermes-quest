"""Synthetic durability regressions; no live Hermes status or database is opened."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import select
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
MODULE = Path(os.environ.get('HISTORY_SOURCE', Path(__file__).with_name('botstatus_history.py'))).resolve()
spec = importlib.util.spec_from_file_location('history_recovery_subject', MODULE)
bh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bh)
SECRET = 'private-account@example.test secret-token reason-not-for-history'


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.source = self.home / 'bot-status.json'
        self.settings = bh.resolve_settings({'hermes_home': str(self.home)}, env={})
        self.directory = self.settings['history_dir']
        self.now = 2000000000

    def status(self, bots):
        self.source.write_text(json.dumps({'bots': {
            name: {'status': value, 'since': self.now, 'reason': SECRET}
            for name, value in bots.items()}}))

    def sample(self):
        return bh.sample_once(self.settings, self.now)

    def records(self):
        return bh.read_records(self.settings)

    def database(self):
        db = sqlite3.connect(self.home / 'kanban.db')
        db.execute('CREATE TABLE task_comments(id INTEGER PRIMARY KEY, created_at REAL, body TEXT)')
        db.commit()
        self.addCleanup(db.close)
        return db

    def crash_at_save(self):
        # A real process pauses after its durable append, retaining the exclusive
        # lock. Another sampler must be busy; SIGKILL releases the lock without
        # executing Python cleanup or saving the checkpoint.
        program = '''import importlib.util, os, sys
s=importlib.util.spec_from_file_location('bh', sys.argv[1])
m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
def save(*args):
    print('checkpoint', flush=True)
    os.read(0,1)
    os._exit(90)
m._save_state=save
m.sample_once(m.resolve_settings({'hermes_home':sys.argv[2]},env={}),2000000000)
'''
        child = subprocess.Popen([sys.executable, '-B', '-c', program, str(MODULE), str(self.home)],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            ready, _, _ = select.select([child.stdout], [], [], 4)
            self.assertTrue(ready, 'child did not reach checkpoint')
            self.assertEqual(child.stdout.readline(), b'checkpoint\n')
            self.assertEqual(self.sample(), {'state': 'busy', 'written': 0})
        finally:
            child.kill()
            child.communicate(timeout=4)
        self.assertEqual(child.returncode, -9)

    def test_real_concurrent_save_crash_recovers_resume_and_preserves_source(self):
        self.status({'dev': 'active'})
        self.sample()
        self.status({'dev': 'limited'})
        os.utime(self.source, ns=(1000000000, 1000000000))
        before = (hashlib.sha256(self.source.read_bytes()).hexdigest(), self.source.stat().st_mtime_ns)
        self.crash_at_save()
        self.assertEqual((hashlib.sha256(self.source.read_bytes()).hexdigest(), self.source.stat().st_mtime_ns), before)
        self.status({'dev': 'active'})
        self.assertEqual(self.sample()['written'], 1)
        records = self.records()
        self.assertEqual([(r['status'], r['prev']) for r in records], [('limited', 'active'), ('active', 'limited')])
        self.assertEqual(len({r['seq'] for r in records}), 2)
        self.assertEqual(self.sample()['written'], 0)

    def test_save_exception_keeps_committed_lines_without_duplicates(self):
        self.status({'dev': 'active'})
        self.sample()
        self.status({'dev': 'limited'})
        with patch.object(bh, '_save_state', side_effect=OSError('synthetic checkpoint failure')):
            with self.assertRaises(OSError):
                self.sample()
        committed = (self.directory / bh.FILE).read_bytes()
        self.assertEqual(self.sample()['written'], 0)
        self.assertEqual((self.directory / bh.FILE).read_bytes(), committed)
        self.status({'dev': 'active'})
        self.assertEqual(self.sample()['written'], 1)
        self.assertEqual([r['status'] for r in self.records()], ['limited', 'active'])

    def test_501_status_changes_defer_unappended_transition(self):
        bots = {f'bot{i:04}': 'active' for i in range(501)}
        self.status(bots)
        self.sample()
        self.status(dict.fromkeys(bots, 'limited'))
        self.assertEqual(self.sample()['written'], 500)
        checkpoint = json.loads((self.directory / bh.STATE).read_text())
        self.assertEqual(checkpoint['last']['bot0500'], 'active')
        self.assertEqual(self.sample()['written'], 1)
        self.assertEqual(len(self.records()), 501)
        self.assertEqual(self.sample()['written'], 0)

    def test_large_batch_crash_recovers_all_long_profile_names(self):
        self.settings.update(history_max_bytes=4096, history_keep=0)
        bots = {('b' * 59 + f'{i:05}'): 'active' for i in range(500)}
        self.status(bots)
        self.sample()
        self.status(dict.fromkeys(bots, 'limited'))
        with patch.object(bh, '_save_state', side_effect=OSError('checkpoint failed')):
            with self.assertRaises(OSError):
                self.sample()
        self.assertEqual(len(self.records()), 500)
        self.status(dict.fromkeys(bots, 'active'))
        self.assertEqual(self.sample()['written'], 500)
        self.assertTrue(all(r['prev'] == 'limited' for r in self.records()))
        self.assertEqual(self.sample()['written'], 0)

    def test_torn_tail_is_not_a_commit_and_is_discarded_before_append(self):
        self.status({'dev': 'limited'})
        self.sample()
        path = self.directory / bh.FILE
        committed = path.read_bytes()
        torn = dict(v=1, seq=2000000000001, ts=self.now, type='status',
                    profile='dev', status='active', prev='limited')
        path.write_bytes(committed + json.dumps(torn).encode())  # valid JSON, missing commit newline
        self.assertEqual([r['status'] for r in self.records()], ['limited'])
        self.status({'dev': 'active'})
        self.assertEqual(self.sample()['written'], 1)
        self.assertTrue(path.read_bytes().startswith(committed))
        self.assertEqual([r['status'] for r in self.records()], ['limited', 'active'])
        self.assertEqual(self.sample()['written'], 0)

    def test_short_writes_finish_and_sync_before_checkpoint(self):
        self.status({'dev': 'limited', 'qa': 'limited'})
        writes, synced = [], set()
        real_write, real_sync = os.write, os.fsync

        def short(fd, data):
            writes.append(fd)
            return real_write(fd, data[:7])

        def sync(fd):
            synced.add(fd)
            return real_sync(fd)

        real_save = bh._save_state

        def save(settings, state):
            self.assertGreater(len(writes), 1)
            self.assertIn(writes[-1], synced)
            self.assertEqual(len(self.records_unlocked()), 2)
            return real_save(settings, state)

        with patch.object(bh.os, 'write', short), patch.object(bh.os, 'fsync', sync), patch.object(bh, '_save_state', save):
            self.assertEqual(self.sample()['written'], 2)
        self.assertEqual(len(self.records()), 2)
        self.assertEqual(self.sample()['written'], 0)

    def records_unlocked(self):
        # Avoid requesting a shared lock while the tested sampler owns EX.
        lines = (self.directory / bh.FILE).read_bytes().split(b'\n')[:-1]
        return [json.loads(line) for line in lines]

    def test_partial_write_failure_preserves_committed_prefix_and_retries_tail(self):
        self.status({'dev': 'limited', 'qa': 'limited'})
        real_write = os.write
        calls = []

        def fail(fd, data):
            calls.append(fd)
            if len(calls) > 1:
                raise OSError('synthetic disk failure')
            first_line = bytes(data).index(b'\n') + 1
            return real_write(fd, data[:first_line + 9])

        with patch.object(bh.os, 'write', fail):
            with self.assertRaises(OSError):
                self.sample()
        self.assertEqual([r['profile'] for r in self.records()], ['dev'])
        self.assertEqual(self.sample()['written'], 1)
        self.assertEqual([r['profile'] for r in self.records()], ['dev', 'qa'])
        self.assertEqual(self.sample()['written'], 0)

    def test_failover_crash_deduplicates_by_committed_comment_identity(self):
        db = self.database()
        self.status({'dev': 'active', 'qa': 'active'})
        self.sample()
        db.execute('INSERT INTO task_comments VALUES(1,?,?)',
                   (self.now, '[failover] dev limited (' + SECRET + ') -> qa'))
        db.commit()
        self.crash_at_save()
        self.assertEqual(self.sample()['written'], 0)
        records = self.records()
        self.assertEqual([(r['profile'], r['to'], r['comment_id']) for r in records], [('dev', 'qa', 1)])
        self.assertNotIn(SECRET, (self.directory / bh.FILE).read_text())
        db.execute('INSERT INTO task_comments VALUES(2,?,?)', (self.now, '[failover] dev limited -> qa'))
        db.commit()
        self.assertEqual(self.sample()['written'], 1)  # same pair, distinct committed comment
        self.assertEqual([r['comment_id'] for r in self.records()], [1, 2])

    def test_captain_producer_shape_known_profiles_and_privacy(self):
        db = self.database()
        self.status({'dev': 'active', 'qa': 'active'})
        self.sample()
        bodies = ['[reassign-done] dev -> qa (same card, body, workspace).',
                  '[reassign-done] unknown -> qa (same card, body, workspace).',
                  '[reassign-done] dev -> dev (same card, body, workspace).',
                  '[reassign-rejected] dev -> qa ' + SECRET]
        for cid, body in enumerate(bodies, 1):
            db.execute('INSERT INTO task_comments VALUES(?,?,?)', (cid, self.now, body))
        db.commit()
        before = (hashlib.sha256((self.home / 'kanban.db').read_bytes()).hexdigest(),
                  (self.home / 'kanban.db').stat().st_mtime_ns)
        self.assertEqual(self.sample()['written'], 1)
        record = self.records()[0]
        self.assertEqual((record['profile'], record['to'], record['comment_id']), ('dev', 'qa', 1))
        self.assertEqual(set(record), {'seq', 'ts', 'type', 'profile', 'to', 'comment_id'})
        self.assertNotIn(SECRET, (self.directory / bh.FILE).read_text())
        self.assertEqual((hashlib.sha256((self.home / 'kanban.db').read_bytes()).hexdigest(),
                          (self.home / 'kanban.db').stat().st_mtime_ns), before)
        self.assertEqual(self.sample()['written'], 0)

    def test_batch_full_defers_comment_cursor_until_failover_append(self):
        db = self.database()
        bots = dict.fromkeys((f'bot{i:04}' for i in range(501)), 'active')
        self.status(bots)
        self.sample()
        db.execute('INSERT INTO task_comments VALUES(1,?,?)',
                   (self.now, '[failover] bot0000 limited -> bot0001'))
        db.commit()
        self.status(dict.fromkeys(bots, 'limited'))
        self.assertEqual(self.sample()['written'], 500)
        self.assertEqual(json.loads((self.directory / bh.STATE).read_text())['comment'], 0)
        self.assertEqual(self.sample()['written'], 2)
        self.assertEqual(len(self.records()), 502)
        self.assertEqual(self.records()[-1]['comment_id'], 1)
        self.assertEqual(self.sample()['written'], 0)

    def test_all_regular_source_reads_are_readonly_nonblocking_and_unchanged(self):
        self.status({'dev': 'limited'})
        config = self.home / 'config.json'
        config.write_text(json.dumps({'hermes_home': str(self.home)}))
        before = {p: (hashlib.sha256(p.read_bytes()).hexdigest(), p.stat().st_mtime_ns)
                  for p in (config, self.source)}
        opened = set()
        real_open = os.open

        def spy(path, flags, *args, **kwargs):
            if Path(path) in before:
                opened.add(Path(path))
                self.assertEqual(flags & os.O_ACCMODE, os.O_RDONLY)
                self.assertTrue(flags & os.O_NONBLOCK)
            return real_open(path, flags, *args, **kwargs)

        with patch.object(bh.os, 'open', spy):
            settings = bh.load_settings(config, env={})
            self.assertEqual(bh.sample_once(settings, self.now)['written'], 1)
        self.assertEqual(opened, set(before))
        for path, identity in before.items():
            self.assertEqual((hashlib.sha256(path.read_bytes()).hexdigest(), path.stat().st_mtime_ns), identity)

    def test_oversized_config_state_and_status_rejected(self):
        config = self.home / 'config.json'
        config.write_bytes(b'{}' + b' ' * (1024 * 1024))
        with self.assertRaises(ValueError):
            bh.load_settings(config, env={})
        self.source.write_bytes(b' ' * (1024 * 1024 + 1))
        self.assertIsNone(bh.read_status(self.source))
        self.status({'dev': 'limited'})
        self.sample()
        (self.directory / bh.STATE).write_bytes(b' ' * (1024 * 1024 + 1))
        reads = []
        real_read = os.read

        def spy(fd, size):
            reads.append(os.readlink(f'/proc/self/fd/{fd}'))
            return real_read(fd, size)

        with patch.object(bh.os, 'read', spy):
            self.assertEqual(self.sample()['written'], 0)
        self.assertNotIn(str(self.directory / bh.STATE), reads)

    def test_fifo_and_directory_sources_do_not_block(self):
        # Execute each probe separately so a baseline FIFO hang is killed, not
        # left as a blocked test thread in the shared test process.
        self.status({'dev': 'limited'})
        self.sample()
        program = '''import importlib.util, sys
s=importlib.util.spec_from_file_location('bh',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
settings=m.resolve_settings({'hermes_home':sys.argv[2]},env={})
kind=sys.argv[3]; path=sys.argv[4]
if kind=='config':
    try: m.load_settings(path,env={})
    except (OSError,ValueError): pass
    else: raise AssertionError('accepted nonregular config')
elif kind=='status': assert m.read_status(path) is None
elif kind=='history': assert m.read_records(settings)==[]
else: assert m.sample_once(settings,2000000000)['state']=='ok'
'''
        for shape in ('fifo', 'directory'):
            for kind in ('status', 'config', 'history', 'state'):
                with self.subTest(shape=shape, kind=kind):
                    path = {'status': self.home / 'invalid-status', 'config': self.home / 'invalid-config',
                            'history': self.directory / bh.FILE, 'state': self.directory / bh.STATE}[kind]
                    old = path.read_bytes() if path.exists() and path.is_file() else None
                    if path.exists():
                        path.unlink()
                    if shape == 'fifo':
                        os.mkfifo(path)
                    else:
                        path.mkdir()
                    try:
                        # State directory cannot be replaced by a file; rejection
                        # must still be prompt, even if saving fails afterwards.
                        probe = program
                        if kind == 'state' and shape == 'directory':
                            probe = program.replace("else: assert m.sample_once(settings,2000000000)['state']=='ok'",
                                                    "else:\n    try: m.sample_once(settings,2000000000)\n    except OSError: pass")
                        run = subprocess.run([sys.executable, '-B', '-c', probe, str(MODULE),
                                              str(self.home), kind, str(path)], capture_output=True, timeout=3)
                        self.assertEqual(run.returncode, 0, run.stderr.decode())
                    finally:
                        if path.is_dir():
                            path.rmdir()
                        elif path.exists():
                            path.unlink()
                        if old is not None:
                            path.write_bytes(old)


if __name__ == '__main__':
    unittest.main()
