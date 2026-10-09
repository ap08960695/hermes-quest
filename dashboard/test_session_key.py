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

from fastapi import FastAPI
from fastapi.testclient import TestClient

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
        self.enterContext(patch.object(api, '_ensure_sampler', return_value='disabled'))
        app = FastAPI()
        app.include_router(api.router)
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def get_payload(self, route, cursor=None):
        response = self.client.get('/' + route, params={'since': cursor} if cursor else {})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers['cache-control'], 'no-store')
        return response.json()

    def assert_closed(self, payload, reason):
        self.assertEqual(payload['session_data'], {'status': 'unavailable', 'reason': reason})
        self.assertTrue(payload['sessions'])
        self.assertTrue(all(s['session_ref'] is None and s['parent_session_ref'] is None
                            for s in payload['sessions']))
        state = extract._decode(payload['cursor'])
        for ledger in ('mana', 'mana_versions', 'pending', 'compression_pending'):
            self.assertFalse(state[ledger])
        self.assertFalse(any(e['kind'] in ('mana', 'code', 'tool', 'summon', 'compression')
                             for e in payload['events']))
        wire = json.dumps(payload) + json.dumps(state)
        self.assertNotIn(str(self.path), wire)
        self.assertNotIn('session-ref.key', wire)
        self.assertNotIn('worker', wire)

    def test_http_missing_unsafe_restore_and_no_duplicate_mana(self):
        (self.f.home / 'bot-status.json').write_text(json.dumps({
            'updated': self.f.now, 'bots': {'developer-demo': {'status': 'active'}}}))
        first = self.get_payload('replay')
        self.assertEqual(first['session_data'], {'status': 'available', 'reason': None})
        original = self.path.read_bytes()
        availability = {b['id']: b['availability'] for b in first['bots']}
        self.assertTrue(any(a['status'] == 'active' for a in availability.values()))
        cursor = first['cursor']
        self.path.unlink()
        for case in ('missing', 'short', 'permissions', 'readonly', 'symlink', 'fifo', 'directory'):
            with self.subTest(case=case):
                if case == 'short':
                    self.path.write_bytes(b'short')
                    self.path.chmod(0o600)
                elif case in ('permissions', 'readonly'):
                    self.path.write_bytes(original)
                    self.path.chmod(0o644 if case == 'permissions' else 0o400)
                elif case == 'symlink':
                    target = self.path.with_name('synthetic-target')
                    target.write_bytes(original)
                    target.chmod(0o600)
                    self.path.symlink_to(target)
                elif case == 'fifo':
                    os.mkfifo(self.path, 0o600)
                elif case == 'directory':
                    self.path.mkdir()
                # Simulate absence without allowing API provisioning to hide it.
                with patch.object(api, '_ensure_session_key', return_value=None):
                    replay = self.get_payload('replay')
                    delta = self.get_payload('events', cursor)
                    reason = 'key_missing' if case == 'missing' else 'key_unsafe'
                    for payload in (replay, delta):
                        self.assert_closed(payload, reason)
                        self.assertTrue(payload['tasks'])
                        self.assertEqual({b['id']: b['availability'] for b in payload['bots']}, availability)
                    retry = self.get_payload('events', delta['cursor'])
                    self.assert_closed(retry, reason)
                    self.assertEqual(retry['events'], [])
                if case == 'directory':
                    self.path.rmdir()
                elif case != 'missing':
                    self.path.unlink()
                self.path.write_bytes(original)
                self.path.chmod(0o600)
                restored = self.get_payload('events', delta['cursor'])
                self.assertEqual(restored['session_data'], first['session_data'])
                self.assertEqual(restored['meta']['config_revision'], first['meta']['config_revision'])
                self.assertEqual(restored['sessions'], first['sessions'])
                self.assertEqual(sum(e['tokens'] for e in restored['events'] if e['kind'] == 'mana'), 120)
                retry = self.get_payload('events', restored['cursor'])
                self.assertEqual(retry['events'], [])
                self.assertEqual(retry['session_data'], first['session_data'])
                cursor = restored['cursor']
                self.path.unlink()

    def test_failure_reason_does_not_change_revision_or_cursor(self):
        with patch.object(api, '_ensure_session_key', return_value=None):
            missing = self.get_payload('replay')
        with patch.object(api.os, 'write', side_effect=PermissionError):
            failed = self.get_payload('events', missing['cursor'])
        self.assert_closed(missing, 'key_missing')
        self.assert_closed(failed, 'key_provision_failed')
        self.assertEqual(failed['meta']['config_revision'], missing['meta']['config_revision'])
        self.assertEqual(failed['cursor'], missing['cursor'])
        self.assertEqual(failed['events'], [])

    def test_optional_provision_failures_and_published_key_are_reported_truthfully(self):
        for failure in (patch.object(api, 'fcntl', None),
                        patch.object(api, '_history_settings', side_effect=PermissionError),
                        patch.object(api, '_history_settings', return_value=(None, {'history_dir': str(ROOT / 'data')}))):
            with failure:
                replay = self.get_payload('replay')
                delta = self.get_payload('events', replay['cursor'])
            self.assert_closed(replay, 'key_provision_failed')
            self.assert_closed(delta, 'key_provision_failed')
        # Directory fsync can fail after atomic publication. A reader using that
        # complete key must report available, not claim its emitted events vanished.
        real_fsync = os.fsync
        calls = 0
        def fail_directory_sync(fd):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise PermissionError
            return real_fsync(fd)
        with patch.object(api.os, 'fsync', side_effect=fail_directory_sync):
            restored = self.get_payload('events', delta['cursor'])
        self.assertEqual(restored['session_data'], {'status': 'available', 'reason': None})
        self.assertEqual(sum(e['tokens'] for e in restored['events'] if e['kind'] == 'mana'), 120)
        self.assertEqual(self.get_payload('events', restored['cursor'])['events'], [])

    def test_reader_permission_owner_and_short_read_fail_closed(self):
        api._ensure_session_key()
        real_fstat = os.fstat
        from types import SimpleNamespace
        def wrong_owner(fd):
            info = real_fstat(fd)
            return SimpleNamespace(st_mode=info.st_mode, st_size=info.st_size,
                                   st_uid=info.st_uid + 1)
        for failure in (patch.object(extract.os, 'open', side_effect=PermissionError),
                        patch.object(extract.os, 'fstat', side_effect=wrong_owner),
                        patch.object(extract.os, 'read', return_value=b'short')):
            with failure:
                for payload in (extract.build_replay(self.f.cfg, 12),
                                extract.collect_since(self.f.cfg, '')):
                    self.assert_closed(payload, 'key_unsafe')

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
                    payload = self.get_payload('replay')
                    delta = self.get_payload('events', payload['cursor'])
                self.assert_closed(payload, 'key_provision_failed')
                self.assert_closed(delta, 'key_provision_failed')
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
