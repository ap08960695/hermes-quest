"""Synthetic backend/root boundaries plus actual subprocess and privacy regression."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock, patch

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))
import extract
import test_extract

spec = importlib.util.spec_from_file_location('quest_root_api', ROOT / 'dashboard/plugin_api.py')
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)


class DataRootTests(unittest.TestCase):
    def setUp(self):
        self.f = test_extract.ExtractTests('test_snapshot_privacy_and_meta')
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        self.home = self.f.home.resolve()
        self.profile = self.home / 'profiles' / 'developer-demo'
        self.enterContext(patch.dict(os.environ, {'HERMES_HOME': str(self.profile),
                                                 'HERMES_QUEST_CONFIG': '',
                                                 'HERMES_QUEST_SAMPLER': 'off'}))
        self.host = types.ModuleType('hermes_constants')
        self.host.get_default_hermes_root = Mock(return_value=self.home)
        self.host.get_process_hermes_home = Mock(return_value=self.home)
        self.enterContext(patch.dict(sys.modules, {'hermes_constants': self.host}))
        self.history = extract._history_module()

    def config(self, data):
        path = self.home / 'quest.json'
        path.write_text(json.dumps(data))
        return path

    def test_auto_profile_uses_shared_root_and_consistent_private_state(self):
        cfg = extract.load_backend_config()
        self.assertEqual(cfg['hermes_home'], str(self.home))
        settings = self.history.load_settings(backend=True)
        _, api_settings = api._history_settings()
        for actual in (settings, api_settings):
            self.assertEqual(actual['home'], self.home)
            self.assertEqual(actual['history_dir'], self.home / 'hermes-quest')
            self.assertEqual(actual['botstatus_path'], self.home / 'bot-status.json')
        self.host.get_default_hermes_root.assert_called_with(home=self.profile)

    def test_root_mode_and_no_environment_use_official_default(self):
        with patch.dict(os.environ, {'HERMES_HOME': str(self.home)}):
            self.assertEqual(extract.load_backend_config()['hermes_home'], str(self.home))
        with patch.dict(os.environ):
            os.environ.pop('HERMES_HOME', None)
            self.assertEqual(extract.load_backend_config()['hermes_home'], str(self.home))
            self.host.get_process_hermes_home.assert_called()

    def test_standalone_remains_profile_scoped_without_host(self):
        with patch.dict(sys.modules, {'hermes_constants': None}):
            self.assertEqual(extract.load_config()['hermes_home'], str(self.profile))
            self.assertEqual(self.history.load_settings()['home'], self.profile)

    def test_explicit_home_and_history_override_win_even_without_host(self):
        for home in (self.profile, self.home, self.home / 'custom-data'):
            with self.subTest(home=home), patch.dict(sys.modules, {'hermes_constants': None}):
                path = self.config({'hermes_home': str(home),
                                    'history_dir': str(self.home / 'private-state'),
                                    'botstatus_path': str(self.home / 'custom-status.json')})
                cfg = extract.load_backend_config(path)
                self.assertEqual(cfg['hermes_home'], str(home))
                settings = self.history.load_settings(path, backend=True)
                self.assertEqual(settings['home'], home)
                self.assertEqual(settings['history_dir'], self.home / 'private-state')
                self.assertEqual(settings['botstatus_path'], self.home / 'custom-status.json')
        self.host.get_default_hermes_root.assert_not_called()

    def test_symlinked_profile_resolves_without_stripping_paths(self):
        alias = self.home / 'alias-home'
        alias.symlink_to(self.profile, target_is_directory=True)
        # The profile may be addressed with a symlink outside the root. A name
        # alias cannot authorize broader reads; a root alias still works.
        with patch.dict(os.environ, {'HERMES_HOME': str(alias)}):
            with self.assertRaises(ValueError):
                extract.load_backend_config()
        alias.unlink()
        alias.symlink_to(self.home, target_is_directory=True)
        with patch.dict(os.environ, {'HERMES_HOME': str(alias)}):
            self.assertEqual(extract.load_backend_config()['hermes_home'], str(self.home))

    def test_invalid_explicit_home_fails_without_discovery(self):
        for value in (None, '', ' ', 1, 'bad\0path'):
            with self.subTest(value=value):
                path = self.config({'hermes_home': value})
                with self.assertRaises(ValueError):
                    extract.load_backend_config(path)
                with self.assertRaises(ValueError):
                    self.history.load_settings(path, backend=True)
        self.host.get_default_hermes_root.assert_not_called()

    def test_environment_expansion_uses_official_root(self):
        with patch.dict(os.environ, {'QUEST_TEST_HOME': str(self.profile),
                                     'HERMES_HOME': ' ${QUEST_TEST_HOME} '}):
            self.assertEqual(extract.load_backend_config()['hermes_home'], str(self.home))
            self.host.get_default_hermes_root.assert_called_with(home=self.profile)

    def test_relocated_symlink_profile_uses_canonical_membership(self):
        moved = self.home / 'relocated' / self.profile.name
        moved.parent.mkdir()
        self.profile.rename(moved)
        self.profile.symlink_to(moved, target_is_directory=True)
        self.assertEqual(extract.load_backend_config()['hermes_home'], str(self.home))

    def test_missing_or_wrong_host_never_guesses_another_root(self):
        for host in (None, types.ModuleType('hermes_constants')):
            with self.subTest(host=host), patch.dict(sys.modules, {'hermes_constants': host}):
                with self.assertRaises(ValueError):
                    extract.load_backend_config()
        for wrong in (self.home / 'unrelated', self.home.parent):
            self.host.get_default_hermes_root.return_value = wrong
            with self.assertRaises(ValueError):
                extract.load_backend_config()
        self.host.get_default_hermes_root.return_value = self.home
        with patch.dict(os.environ, {'HERMES_HOME': str(self.profile / 'cache')}):
            with self.assertRaises(ValueError):
                extract.load_backend_config()

    def test_subprocess_auth_data_cursor_and_privacy(self):
        # Only the host discovery seam is synthetic. The wrapper, extractor,
        # SQLite reads, cursor, key reads and FastAPI responses are production.
        seam = self.home / 'host-seam'
        seam.mkdir()
        (seam / 'hermes_constants.py').write_text(
            'from pathlib import Path\nimport os\n'
            'def get_default_hermes_root(*, home=None):\n'
            '    return Path(os.environ["QUEST_TEST_ROOT"])\n'
            'def get_process_hermes_home():\n'
            '    return Path(os.environ["HERMES_HOME"])\n')
        self.enterContext(patch.dict(os.environ, {'PYTHONPATH': str(seam),
                                                 'QUEST_TEST_ROOT': str(self.home)}))
        app = FastAPI()
        @app.middleware('http')
        async def auth(request: Request, call_next):
            if request.headers.get('Authorization') != 'Bearer synthetic':
                return JSONResponse({'detail': 'Unauthorized'}, status_code=401)
            request.state.session = object()
            return await call_next(request)
        app.include_router(api.router)
        with TestClient(app) as client:
            for route in ('/replay', '/events'):
                self.assertEqual(client.get(route).status_code, 401)
            headers = {'Authorization': 'Bearer synthetic'}
            replay = client.get('/replay', headers=headers)
            self.assertEqual(replay.status_code, 200)
            data = replay.json()
            for key in ('bots', 'tasks', 'events', 'sessions'):
                self.assertTrue(data[key], key)
            self.assertEqual(data['session_data']['status'], 'available')
            self.assertFalse(data['meta']['show_titles'])
            raw = replay.text
            for secret in ('Private project', 'example.test', 'CUST-00012345', 'fake secret'):
                self.assertNotIn(secret, raw)
            self.assertNotIn(str(self.home), raw)
            self.assertTrue(data['meta']['show_profile_names'])
            # A new real fixture row must be observed once, not a 200/empty pass.
            self.f.event('completed')
            self.f.k.commit()
            delta = client.get('/events', headers=headers, params={'since': data['cursor']})
            self.assertEqual(delta.status_code, 200)
            self.assertTrue(delta.json()['events'])
            again = client.get('/events', headers=headers, params={'since': delta.json()['cursor']})
            self.assertEqual(again.status_code, 200)
            self.assertEqual(again.json()['events'], [])
            # No official resolver in the subprocess -> sanitized failure, not
            # silent 200 with empty activity from the profile directory.
            (seam / 'hermes_constants.py').write_text('')
            failed = client.get('/replay', headers=headers)
            self.assertEqual(failed.status_code, 503)
            self.assertEqual(failed.json(), {'detail': 'Quest data is unavailable'})


if __name__ == '__main__':
    unittest.main()
