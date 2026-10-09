"""Plugin-owned atomic key lifecycle; real subprocess API stays available on failure."""
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))
import extract
import test_extract

spec = importlib.util.spec_from_file_location('quest_key_api', ROOT / 'dashboard/plugin_api.py')
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)


class SessionKeyTests(unittest.TestCase):
    def setUp(self):
        self.f = test_extract.ExtractTests('test_snapshot_privacy_and_meta')
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        self.path = self.f.home / 'hermes-quest' / 'session-ref.key'
        self.path.unlink()
        self.config = self.f.home / 'quest.json'
        self.config.write_text(json.dumps(self.f.cfg))
        self.enterContext(patch.dict(os.environ, {'HERMES_QUEST_CONFIG': str(self.config),
                                                 'PYTHONDONTWRITEBYTECODE': '1'}))

    def test_cross_process_first_run_is_atomic_stable_and_private(self):
        code = ("import importlib.util; s=importlib.util.spec_from_file_location('api', "
                + repr(str(ROOT / 'dashboard/plugin_api.py')) +
                "); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); m._ensure_session_key()")
        def provision(_):
            return subprocess.run([sys.executable, '-c', code], capture_output=True, timeout=20)
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(provision, range(8)))
        self.assertTrue(all(r.returncode == 0 and not r.stdout and not r.stderr for r in results))
        key = self.path.read_bytes()
        self.assertEqual(len(key), 32)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(extract._session_key(self.f.cfg), key)
        api._ensure_session_key()
        self.assertEqual(self.path.read_bytes(), key)
        self.assertEqual(list(self.path.parent.glob('.session-ref-*')), [])
        with patch.object(api.subprocess, 'run', wraps=subprocess.run) as run:
            payload = api._extract('replay', '12')
        self.assertTrue(all(s['session_ref'] for s in payload['sessions']))
        self.assertNotIn(key.hex(), json.dumps(payload))
        self.assertNotIn(key.hex(), repr(run.call_args))
        self.assertEqual(api._extract('events', payload['cursor'])['events'], [])

    def test_write_failures_cleanup_and_api_returns_null_refs(self):
        for operation in ('open', 'write', 'fsync', 'replace'):
            with self.subTest(operation=operation):
                with patch.object(api.os, operation, side_effect=PermissionError):
                    payload = api._extract('replay', '12')
                self.assertTrue(payload['tasks'])
                self.assertTrue(payload['sessions'])
                self.assertTrue(all(s['session_ref'] is None for s in payload['sessions']))
                self.assertFalse(self.path.exists())
                self.assertEqual(list(self.path.parent.glob('.session-ref-*')), [])
                self.assertEqual(extract._decode(payload['cursor'])['mana'], {})
        # Handle short writes rather than assuming a single write is complete.
        real_write = os.write
        with patch.object(api.os, 'write', side_effect=lambda fd, data: real_write(fd, data[:3])):
            api._ensure_session_key()
        self.assertEqual(len(self.path.read_bytes()), 32)
        self.assertIsNotNone(extract._session_key(self.f.cfg))

    def test_existing_unsafe_key_is_not_silently_replaced(self):
        for contents, mode in ((b'bad', 0o600), (os.urandom(32), 0o644)):
            self.path.write_bytes(contents)
            self.path.chmod(mode)
            api._ensure_session_key()
            self.assertEqual(self.path.read_bytes(), contents)
            payload = api._extract('replay', '12')
            self.assertTrue(all(s['session_ref'] is None for s in payload['sessions']))
        self.path.unlink()
        os.mkfifo(self.path, 0o600)
        api._ensure_session_key()
        self.assertIsNone(extract._session_key(self.f.cfg))

    def test_state_inside_checkout_is_not_provisioned(self):
        with patch.object(api, '_history_settings', return_value=(None, {'history_dir': str(ROOT / 'data')})), \
                patch.object(Path, 'mkdir') as mkdir:
            api._ensure_session_key()
        mkdir.assert_not_called()


if __name__ == '__main__':
    unittest.main()
