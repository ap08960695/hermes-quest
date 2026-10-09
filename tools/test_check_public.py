"""Release guard regressions, using only synthetic identities and credentials."""
import contextlib
import io
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

import check_public as guard


class PublicGuardTests(unittest.TestCase):
    def test_private_signatures_in_json_and_markdown(self):
        samples = [
            guard.HOME + 'operator/private', guard.MEDIA + 'Volume/private',
            '~/' + '.hermes/profiles/demo', 'orchestra' + '-captain',
            '172' + '.22.27.224', '10' + '.147.1.22',
            'ap089' + '60695', 'Phaisit' + '-Big',
            'https://' + 'github' + '.com/fictional-person/project',
            'gh auth ' + 'token --user fictional-person',
            'fictional' + '@private.invalid', 'gh' + 'p_' + 'FictionalOnly123',
            'github' + '_pat_' + 'FictionalOnly123', 'sk' + '-proj-FictionalOnly123',
            'AK' + 'IA' + 'A' * 16, 'Bearer ' + 'FictionalOnly123',
            'ey' + 'Jfake.eyJdemo.FictionalSignature',
        ]
        for path in ('new.json', 'docs/new.md', 'tools/test_extract.py'):
            for value in samples:
                with self.subTest(path=path, value=value):
                    self.assertTrue(guard.scan_text(path, '{"note": "' + value + '"}'))

    def test_fixture_allowlist_is_exact_and_file_scoped(self):
        for path, values in guard.FIXTURES.items():
            for value in values:
                with self.subTest(path=path, value=value):
                    self.assertFalse(guard.scan_text(path, value))
                    self.assertTrue(guard.scan_text('new-test.py', value))
        self.assertTrue(guard.scan_text('tools/test_extract.py', guard.HOME + 'Jane/private-secret'))
        self.assertTrue(guard.scan_text('tools/test_extract.py', '192' + '.0.2.99'))
        self.assertTrue(guard.scan_text('tools/test_extract.py', 'Bearer ' + 'fictionalValueOther'))

    def test_safe_public_references(self):
        text = ('https://github.com/NousResearch/hermes-agent '
                'demo@example.test demo@users.noreply.github.com '
                'http://127.0.0.1:8765/ 0.0.0.0 ./qa-out')
        self.assertFalse(guard.scan_text('README.md', text))

    def test_git_tracked_json_markdown_binary_symlink_and_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            subprocess.run(['git', 'init', '-q', tmp], check=True)
            (root / 'safe.md').write_text('synthetic demo\n')
            (root / 'ignored.json').write_text(guard.HOME + 'operator')
            subprocess.run(['git', 'add', 'safe.md'], cwd=root, check=True)
            paths, findings = guard.scan_repository(root)
            self.assertEqual(paths, ['safe.md'])
            self.assertEqual(findings, [])
            for name in ('leak.json', 'leak.md', 'image.png'):
                (root / name).write_bytes(b'\xff\x00' + (guard.HOME + 'operator/private').encode())
            (root / 'link').symlink_to(guard.HOME + 'operator/private')
            (root / 'RUNBOOK.md').write_text('local instructions')
            subprocess.run(['git', 'add', 'leak.json', 'leak.md', 'image.png', 'link', 'RUNBOOK.md'], cwd=root, check=True)
            self.assertEqual({p for p, _, _ in guard.scan_repository(root)[1]},
                             {'leak.json', 'leak.md', 'image.png', 'link', 'RUNBOOK.md'})
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(guard.main(['--root', tmp]), 1)
            self.assertNotIn('operator/private', output.getvalue())
            (root / 'safe.md').unlink()
            self.assertIn(('safe.md', 0, 'unreadable-file'), guard.scan_repository(root)[1])

    def test_png_plain_and_compressed_metadata(self):
        import struct
        import zlib
        def chunk(kind, payload):
            return struct.pack('>I', len(payload)) + kind + payload + b'\0' * 4
        leak = (guard.HOME + 'operator/private').encode()
        for kind, payload in (
            (b'tEXt', b'Note\0' + leak),
            (b'zTXt', b'Note\0\0' + zlib.compress(leak)),
            (b'iTXt', b'Note\0\1\0\0\0' + zlib.compress(leak)),
        ):
            with self.subTest(kind=kind):
                raw = b'\x89PNG\r\n\x1a\n' + chunk(kind, payload) + chunk(b'IEND', b'')
                self.assertTrue(guard.scan_text('image.png', guard.readable_text(raw)))
        raw = b'\x89PNG\r\n\x1a\n' + chunk(b'IDAT', leak) + chunk(b'IEND', b'')
        self.assertFalse(guard.scan_text('image.png', guard.readable_text(raw)))
        with self.assertRaises(ValueError):
            guard.readable_text(b'\x89PNG\r\n\x1a\n' + b'\0\0\0\xfftEXt')

    def test_existing_fake_token_hashes_are_file_scoped(self):
        source = (Path(__file__).parent / 'test_extract.py').read_text()
        found = set()
        for match in guard.RULES['token'].finditer(source):
            value = match.group()
            digest = guard.hashlib.sha256(value.encode()).hexdigest()
            if digest in guard.TOKEN_FIXTURES['tools/test_extract.py']:
                found.add(digest)
                self.assertFalse(guard.scan_text('tools/test_extract.py', value))
                self.assertTrue(guard.scan_text('new.py', value))
                self.assertTrue(guard.scan_text('tools/test_extract.py', value + 'Other'))
        self.assertEqual(found, guard.TOKEN_FIXTURES['tools/test_extract.py'])

    def test_no_git_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(guard.main(['--root', tmp]), 2)


class HistoryGuardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.git('init', '-q')
        self.git('config', 'user.name', 'Synthetic Contributor')
        self.git('config', 'user.email', 'demo@users.noreply.github.com')

    def git(self, *args, **kwargs):
        return subprocess.run(['git', *args], cwd=self.root, check=True,
                              capture_output=True, **kwargs).stdout

    def put(self, path, content):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)

    def commit(self, message='Synthetic release', **kwargs):
        self.git('add', '-A')
        self.git('commit', '-qm', message, **kwargs)

    def test_clean_history_and_uncommitted_tree_are_separate(self):
        self.put('safe.md', 'synthetic demo')
        self.commit()
        self.assertEqual(guard.scan_history(self.root)[1], [])
        self.put('safe.md', guard.HOME + 'operator/private')
        self.assertTrue(guard.scan_repository(self.root)[1])
        self.assertFalse(guard.scan_history(self.root)[1])

    def test_deleted_blob_signatures_are_still_reachable(self):
        self.put('deleted.md', '\n'.join((guard.HOME + 'operator/private',
                 '172' + '.22.1.2', '~/' + '.hermes/profiles/demo',
                 'gh' + 'p_' + 'FictionalOnly123', 'fictional' + '@private.invalid')))
        self.commit()
        self.git('rm', 'deleted.md')
        self.put('safe.md', 'synthetic demo')
        self.commit()
        self.assertFalse(guard.scan_repository(self.root)[1])
        rules = {rule for _, _, rule in guard.scan_history(self.root)[1]}
        self.assertTrue({'local-path', 'network', 'profile-path', 'token', 'email'} <= rules)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(guard.main(['--root', str(self.root), '--history']), 1)
        self.assertNotIn('operator/private', output.getvalue())
        self.assertNotIn('FictionalOnly123', output.getvalue())

    def test_all_forbidden_paths_in_old_tree(self):
        for path in ('RUNBOOK.md', 'HANDOFF.md', '.claude/config.json',
                     'data/replay.json', 'preview/demo.gif', 'assets/raw/demo.png',
                     'docs/RUNBOOK.md', 'docs/.claude/config.json'):
            self.put(path, 'synthetic')
        self.commit()
        self.git('rm', '-r', '.')
        self.put('safe.md', 'synthetic')
        self.commit()
        self.assertFalse(guard.scan_repository(self.root)[1])
        self.assertEqual(sum(rule == 'private-file' for _, _, rule
                             in guard.scan_history(self.root)[1]), 8)

    def test_blob_alias_cannot_reuse_fixture_exemption(self):
        value = guard.HOME + 'Jane'
        self.put('tools/test_extract.py', value)
        self.put('new alias\nfile.py', value)
        self.commit()
        self.assertTrue(guard.scan_history(self.root)[1])
        self.git('rm', 'new alias\nfile.py')
        self.commit()
        self.assertTrue(guard.scan_history(self.root)[1])

    def test_path_itself_is_scanned_without_leaking_filename(self):
        name = 'space\n' + 'orchestra' + '-captain/file.txt'
        self.put(name, 'synthetic')
        self.commit()
        findings = guard.scan_history(self.root)[1]
        self.assertTrue(any(rule == 'operator' for _, _, rule in findings))
        self.assertTrue(all(name not in label for label, _, _ in findings))

    def test_message_author_and_committer_are_scanned(self):
        self.put('safe.md', 'synthetic')
        env = dict(os.environ, GIT_AUTHOR_EMAIL='fictional' + '@private.invalid',
                   GIT_COMMITTER_NAME='orchestra' + '-captain')
        self.commit('Synthetic ' + 'gh' + 'p_' + 'FictionalOnly123', env=env)
        rules = {rule for _, _, rule in guard.scan_history(self.root)[1]}
        self.assertTrue({'email', 'operator', 'token'} <= rules)

    def test_approved_identity_is_header_only_and_exact(self):
        self.put('safe.md', 'synthetic')
        name, email = guard.PUBLIC_IDENTITY[:-1].split(' <')
        self.git('config', 'user.name', name)
        self.git('config', 'user.email', email)
        self.commit()
        self.assertFalse(guard.scan_history(self.root)[1])
        self.git('commit', '--allow-empty', '-qm', guard.PUBLIC_IDENTITY)
        self.assertTrue(guard.scan_history(self.root)[1])
        self.assertTrue(guard.scan_commit('synthetic',
            ('author ' + name + ' <other@users.noreply.github.com> 1 +0000\n\n').encode()))

    def test_shallow_and_missing_head_fail_closed(self):
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(guard.main(['--root', str(self.root), '--history']), 2)
        self.put('safe.md', 'synthetic')
        self.commit()
        self.put('safe.md', 'updated synthetic')
        self.commit()
        with tempfile.TemporaryDirectory() as clone:
            self.git('clone', '-q', '--depth=1', self.root.as_uri(), clone)
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(guard.main(['--root', clone, '--history']), 2)


if __name__ == '__main__':
    unittest.main()
