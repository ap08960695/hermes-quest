"""Synthetic regression of timestamp-ID recovery, cursor oracles and key loss."""
import copy
import datetime
import hashlib
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

import extract
import test_extract


class SessionIdentityTests(unittest.TestCase):
    def setUp(self):
        self.f = test_extract.ExtractTests('test_snapshot_privacy_and_meta')
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        self.cfg = dict(self.f.cfg, show_profile_names=True)
        self.keyfile = self.f.home / 'hermes-quest' / 'session-ref.key'

    def total(self, payload):
        return sum(e['tokens'] for e in payload['events'] if e['kind'] == 'mana')

    def test_full_24_bit_public_preimage_probe_cannot_recover_ref(self):
        # Same public inputs and producer-shaped ID as the independent finding.
        stamp = datetime.datetime.fromtimestamp(self.f.now).strftime('%Y%m%d_%H%M%S')
        sid = stamp + '_000123'
        for table, column in [('sessions', 'id'), ('messages', 'session_id'),
                              ('session_model_usage', 'session_id')]:
            self.f.s.execute(f'UPDATE {table} SET {column}=? WHERE {column}=?', (sid, 'worker'))
        self.f.s.commit()
        payload = extract.build_replay(self.cfg, 12)
        row = next(s for s in payload['sessions'] if s['task'] == self.f.tid)
        profile = next(b['profile_name'] for b in payload['bots'] if b['id'] == row['bot'])
        public_stamp = datetime.datetime.fromtimestamp(row['started_at']).strftime('%Y%m%d_%H%M%S')
        prefix = ('[' + json.dumps(profile) + ', "' + public_stamp + '_').encode()
        target = bytes.fromhex(row['session_ref'])
        old_target = bytes.fromhex(extract._hash([profile, sid])[:20])
        old_recovered = recovered = None
        for n in range(1 << 24):
            suffix = format(n, '06x')
            digest = hashlib.sha256(prefix + suffix.encode() + b'"]').digest()[:10]
            if digest == old_target:
                old_recovered = public_stamp + '_' + suffix
            if digest == target:
                recovered = public_stamp + '_' + suffix
                break
        self.assertEqual(old_recovered, sid, 'probe must detect the vulnerable scheme')
        self.assertIsNone(recovered)
        self.assertNotIn(sid, json.dumps(payload))
        self.assertIn('session-' + row['session_ref'], extract._decode(payload['cursor'])['mana'])
        print('Full synthetic timestamp recovery probe: 16777216 guesses; old recovered; HMAC ref not recovered')

    def test_every_cursor_derivative_and_sub_is_keyed(self):
        f = self.f
        child = 'synthetic-child-session'
        pending = 'synthetic-pending-session'
        f.s.execute('INSERT INTO sessions VALUES(?,?,?,?,?)', (child, 'subagent', 'worker', f.now, 'Subagent child'))
        f.message('assistant', sid=child, token_count=12)
        f.s.execute('INSERT INTO sessions VALUES(?,?,?,?,?)', (pending, 'kanban', None, f.now, 'Worker'))
        f.message('user', sid=pending, content='work kanban task t_ffffffff')
        f.s.commit()
        logs = f.home / 'profiles' / 'developer-demo' / 'logs'
        logs.mkdir()
        stamp = datetime.datetime.fromtimestamp(f.now).strftime('%Y-%m-%d %H:%M:%S')
        (logs / 'agent.log').write_text(f'{stamp} context compression done session={pending} messages=100->20\n')
        first = extract.build_replay(self.cfg, 12)
        state = extract._decode(first['cursor'])
        key = extract._session_key(self.cfg)
        wanted = extract._session_digest(key, 'developer-demo', pending)
        self.assertEqual(state['pending'], [wanted[:20]])
        self.assertEqual(state['compression_pending'][0]['session'], wanted)
        summon = next(e for e in first['events'] if e['kind'] == 'summon')
        self.assertEqual(summon['sub'], extract._session_digest(key, 'developer-demo', child)[:6])
        wire = json.dumps(first) + json.dumps(state)
        for sid in ('worker', child, pending):
            self.assertNotIn(extract._hash(['developer-demo', sid])[:20], wire)
            self.assertNotIn(extract._hash(sid)[:6], wire)
        self.assertNotIn(key.hex(), wire)
        self.assertNotIn('session-ref.key', wire)
        retry = extract.collect_since(self.cfg, first['cursor'])
        self.assertEqual(retry['events'], [])
        self.assertEqual(retry['sessions'], first['sessions'])

    def test_legacy_reset_is_once_and_mana_is_not_recharged(self):
        fresh = extract.build_replay(self.cfg, 12)
        old = copy.deepcopy(extract._decode(fresh['cursor']))
        old.pop('identity')
        old['mana'] = {'session-' + extract._hash(['developer-demo', 'worker'])[:20]: 120}
        old['pending'] = [extract._hash(['developer-demo', 'lost-session'])[:20]]
        old['compression_pending'] = [dict(source='compression-demo', seq='1:0',
             session=extract._hash(['developer-demo', 'lost-session']), t=self.f.now, before=20, after=10)]
        # Decoder accepts both legacy JSON and the old compact codec.
        from test_cursor import legacy_cursor
        for cursor in (legacy_cursor(old), extract._cursor(old)):
            reset = extract.collect_since(self.cfg, cursor)
            self.assertEqual(self.total(reset), 120)  # replaces, never appends to old epoch
            self.assertEqual(reset['cursor'], fresh['cursor'])
            self.assertNotIn(old['pending'][0], json.dumps(extract._decode(reset['cursor'])))
            self.assertEqual(extract.collect_since(self.cfg, reset['cursor'])['events'], [])
        self.f.s.execute('UPDATE session_model_usage SET input_tokens=160')
        self.f.s.commit()
        delta = extract.collect_since(self.cfg, reset['cursor'])
        self.assertEqual(self.total(delta), 60)
        self.assertEqual(extract.collect_since(self.cfg, delta['cursor'])['events'], [])

    def test_loss_restore_rotation_and_unsafe_keys_fail_closed_without_writes(self):
        first = extract.build_replay(self.cfg, 12)
        original = self.keyfile.read_bytes()
        self.keyfile.unlink()
        closed = extract.collect_since(self.cfg, first['cursor'])
        self.assertTrue(closed['sessions'])
        self.assertTrue(all(s['session_ref'] is None and s['parent_session_ref'] is None for s in closed['sessions']))
        self.assertFalse(extract._decode(closed['cursor'])['mana'])
        self.assertFalse(self.keyfile.exists(), 'extractor must not create a key')
        self.assertNotEqual(closed['meta']['config_revision'], first['meta']['config_revision'])
        self.keyfile.write_bytes(original)
        self.keyfile.chmod(0o600)
        restored = extract.collect_since(self.cfg, closed['cursor'])
        self.assertEqual(restored['sessions'], first['sessions'])
        self.assertEqual(restored['meta']['config_revision'], first['meta']['config_revision'])
        self.assertEqual(extract.collect_since(self.cfg, restored['cursor'])['events'], [])
        self.keyfile.write_bytes(os.urandom(32))
        rotated = extract.collect_since(self.cfg, restored['cursor'])
        self.assertNotEqual(rotated['sessions'], restored['sessions'])
        self.assertNotEqual(rotated['meta']['config_revision'], restored['meta']['config_revision'])
        for mode in (0o644, 0o400):
            self.keyfile.chmod(mode)
            self.assertIsNone(extract._session_key(self.cfg))
        self.keyfile.chmod(0o600)
        self.keyfile.write_bytes(b'short')
        self.assertIsNone(extract._session_key(self.cfg))
        self.keyfile.unlink()
        target = self.keyfile.with_name('target')
        target.write_bytes(original)
        target.chmod(0o600)
        self.keyfile.symlink_to(target)
        self.assertIsNone(extract._session_key(self.cfg))
        self.keyfile.unlink()
        os.mkfifo(self.keyfile, 0o600)
        self.assertIsNone(extract._session_key(self.cfg))
        with patch.object(extract.os, 'open', side_effect=PermissionError):
            self.assertIsNone(extract._session_key(self.cfg))


if __name__ == '__main__':
    unittest.main()
