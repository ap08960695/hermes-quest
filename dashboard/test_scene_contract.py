"""Contract A (readability-r2): the `working` block from replay/events.

Synthetic Kanban fixture only (tools/fixtures/working_snapshot.json). Run in a Python with
fastapi+httpx: python3 -m unittest discover -s dashboard -p test_scene_contract.py
"""
import copy
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))
import extract  # noqa: E402

FIXTURE = json.loads((ROOT / 'tools/fixtures/working_snapshot.json').read_text(encoding='utf-8'))
ITEM_KEYS = {'ref', 'status', 'started_at', 'display_name', 'class_label', 'quest_label',
             'quest_kind', 'group_label', 'parent_ref', 'worker_observed', 'bot_ref', 'task_ref', 'run_ref'}
WORKING_KEYS = {'as_of', 'items', 'resting_count', 'latest_order', 'progress'}
PROGRESS_KEYS = {'wins_today', 'xp', 'gold', 'level', 'level_progress'}
ORDER_KEYS = {'at', 'source_action_ref', 'action_label', 'quest_label', 'recipient_display_name', 'recipient_bot_ref', 'task_ref'}
STATUSES = {'running', 'blocked', 'failed', 'done', 'archived', 'unknown'}
QUEST_KINDS = {'planning', 'build', 'testing', 'review', 'deploy', 'verification', 'guild'}
FORBIDDEN = re.compile(r't_[0-9a-f]{8}|[0-9a-f]{12,}|[a-z]+-demo\b|/srv|/media|/home|CUST-|Fictional|password',
                       re.I)


def build_home(fixture, aliases=True, mutate=None):
    """Create a throwaway Hermes home from the fixture; returns (TemporaryDirectory, now)."""
    tmp = tempfile.TemporaryDirectory()
    home, now = Path(tmp.name), float(fixture['now'])
    state = home / 'hermes-quest'
    state.mkdir(mode=0o700)
    key = state / 'session-ref.key'
    key.write_bytes(bytes(range(32)))
    key.chmod(0o600)
    for name, meta in fixture['profiles'].items():
        root = home / 'profiles' / name
        root.mkdir(parents=True)
        if aliases and meta.get('display_name'):
            (root / 'profile.yaml').write_text('display_name: ' + meta['display_name'] + '\n')
    db = sqlite3.connect(home / 'kanban.db')
    db.executescript('''
CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT,assignee TEXT,status TEXT,created_by TEXT,
created_at REAL,started_at REAL,completed_at REAL,workspace_path TEXT,provider_override TEXT,max_runtime_seconds INTEGER);
CREATE TABLE task_events(id INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT,run_id INTEGER,kind TEXT,payload TEXT,created_at REAL);
CREATE TABLE task_comments(id INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT,author TEXT,body TEXT,created_at REAL);
CREATE TABLE task_runs(id INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT,profile TEXT,started_at REAL,ended_at REAL,outcome TEXT);
CREATE TABLE task_links(parent_id TEXT,child_id TEXT);
''')
    ago = lambda value: None if value is None else now - value
    for t in fixture['board']['tasks']:
        db.execute('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                   (t['id'], t['title'], t['assignee'], t['status'], t['created_by'],
                    ago(t['created_ago']), ago(t.get('started_ago')), ago(t.get('completed_ago')),
                    None, None, 1800))
    for r in fixture['board']['runs']:
        db.execute('INSERT INTO task_runs(task_id,profile,started_at,ended_at,outcome) VALUES(?,?,?,?,?)',
                   (r['task_id'], r['profile'], ago(r['started_ago']), ago(r['ended_ago']), r['outcome']))
    if mutate:
        mutate(db)
    db.commit()
    db.close()
    return tmp, now


class Scene:
    """Context manager: run the real extractor on the fixture under a pinned clock/timezone."""
    def __init__(self, test, aliases=True, mutate=None, fixture=None, **config):
        self.test, self.aliases, self.mutate, self.config = test, aliases, mutate, config
        self.fixture = fixture or FIXTURE

    def __enter__(self):
        self.tmp, self.now = build_home(self.fixture, self.aliases, self.mutate)
        env = {'HERMES_HOME': self.tmp.name, 'HERMES_QUEST_CONFIG': '', 'TZ': self.fixture['tz']}
        self.patches = [patch.dict(os.environ, env), patch.object(extract.time, 'time', return_value=self.now)]
        for p in self.patches:
            p.start()
        time.tzset()
        self.cfg = extract.load_config()
        self.cfg.update(captain=self.fixture['captain'], **self.config)
        return self

    def __exit__(self, *exc):
        for p in reversed(self.patches):
            p.stop()
        time.tzset()
        self.tmp.cleanup()

    def replay(self, hours=12):
        return extract.build_replay(self.cfg, hours)

    def delta(self, cursor):
        return extract.collect_since(self.cfg, cursor)


def visible_strings(working):
    out = []
    for item in working['items']:
        out += [item[k] for k in ('display_name', 'class_label', 'quest_label', 'group_label')]
    order = working['latest_order']
    if order:
        out += [order['action_label'], order['quest_label'], order['recipient_display_name'] or '']
    return out


def graphemes(text):
    return extract._graphemes(text)


class WorkingContractTests(unittest.TestCase):
    def scene(self, **kw):
        s = Scene(self, **kw)
        self.enterContext(s)
        return s

    def by_label(self, working, label):
        return [i for i in working['items'] if i['quest_label'] == label]

    def test_golden_snapshot_matches_per_privacy_mode(self):
        for mode, names, titles in (('anonymous', False, False), ('names_only', True, False),
                                    ('names_and_titles', True, True)):
            with self.subTest(mode=mode):
                s = self.scene(show_titles=titles)
                s.cfg['show_profile_names'] = names
                working = s.replay()['working']
                # Additive internal source identity does not change the frozen display fixture.
                ref = working['latest_order'].pop('source_action_ref')
                self.assertRegex(ref, r'^o-[0-9a-f]{20}$')
                self.assertEqual(working, FIXTURE['expected'][mode])

    # --- schema ---------------------------------------------------------------------
    def test_schema_matches_frozen_contract_in_replay_and_delta(self):
        s = self.scene()
        replay = s.replay()
        for payload in (replay, s.delta(replay['cursor'])):
            w = payload['working']
            self.assertEqual(set(w), WORKING_KEYS)
            self.assertEqual(set(w['progress']), PROGRESS_KEYS)
            self.assertTrue(re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ', w['as_of']))
            self.assertIsInstance(w['resting_count'], int)
            for item in w['items']:
                self.assertEqual(set(item), ITEM_KEYS)
                self.assertIn(item['status'], STATUSES)
                self.assertIn(item['quest_kind'], QUEST_KINDS)
                self.assertIsInstance(item['worker_observed'], bool)
                self.assertTrue(re.fullmatch(r'w-[0-9a-f]{20}', item['ref']), item['ref'])
            self.assertEqual(set(w['latest_order']), ORDER_KEYS)
        # as_of is the same instant as meta.as_of
        self.assertEqual(replay['working']['as_of'],
                         extract._iso(replay['meta']['as_of']))

    # --- R1/R2: current running, one row per current card ----------------------------
    def test_running_rows_come_from_current_board_not_events(self):
        s = self.scene()
        replay = s.replay()
        self.assertEqual(replay['events'] and len(replay['events']) >= 0, True)
        running = [i for i in replay['working']['items'] if i['status'] == 'running']
        # 001,002,003,004 + unowned 005 + shared 00d = 6 distinct current cards.
        self.assertEqual(len(running), 6)
        self.assertEqual(len({i['ref'] for i in replay['working']['items']}),
                         len(replay['working']['items']))
        # No task_events rows exist at all, yet every running card is present.
        self.assertEqual([e for e in replay['events'] if e['kind'] == 'heartbeat'], [])

    def test_running_card_with_no_event_in_window_is_still_present(self):
        s = self.scene()
        old = s.replay(hours=0.001)  # window far shorter than every run
        self.assertEqual(sum(i['status'] == 'running' for i in old['working']['items']), 6)

    def test_two_open_runs_on_one_task_are_one_row_with_newest_worker(self):
        w = self.scene().replay()['working']
        observed = [i for i in w['items'] if i['status'] == 'running' and i['worker_observed']]
        # 001, 002, 003 (one open run each) + newest open run of the shared task = 4 rows;
        # t_a0000004 has no run row at all, so it is the "not observed" case.
        self.assertEqual(len(observed), 4)
        self.assertEqual(len({i['task_ref'] for i in observed}), 4)
        shared = [i for i in observed if i['task_ref'] == 't_a000000d']
        self.assertEqual(len(shared), 1)
        self.assertEqual(shared[0]['bot_ref'], extract._bot_id('tester-demo'))

    def test_running_without_run_or_assignee_keeps_one_unknown_row(self):
        w = self.scene().replay()['working']
        unowned = [i for i in w['items'] if i['display_name'] == 'Unassigned']
        self.assertEqual(len(unowned), 1)
        self.assertEqual((unowned[0]['status'], unowned[0]['worker_observed'],
                          unowned[0]['class_label']), ('running', False, 'Unassigned'))
        # An assigned running task with no run row (t_a0000004) is "Worker not observed",
        # never a guessed hero; deleting another task's run adds exactly one more such row.
        missing = [i for i in w['items'] if i['display_name'] == 'Worker not observed']
        self.assertEqual(len(missing), 1)
        self.assertFalse(missing[0]['worker_observed'])
        def drop_runs(db):
            db.execute("DELETE FROM task_runs WHERE task_id='t_a0000001'")
        w2 = self.scene(mutate=drop_runs).replay()['working']
        self.assertEqual(sum(i['display_name'] == 'Worker not observed' for i in w2['items']), 2)

    def test_internal_bindings_resolve_exact_entities_without_alias_matching(self):
        fixture = copy.deepcopy(FIXTURE)
        for meta in fixture['profiles'].values():
            meta['display_name'] = 'Twin'
        s = self.scene(fixture=fixture, show_profile_names=True)
        payload = s.replay()
        bots = {b['id']: b for b in payload['bots']}
        tasks = {t['id']: t for t in payload['tasks']}
        for row in payload['working']['items']:
            self.assertIn(row['task_ref'], tasks)
            if row['bot_ref']:
                self.assertIn(row['bot_ref'], bots)
            if row['worker_observed']:
                self.assertEqual(row['display_name'], bots[row['bot_ref']]['display_name'])
                self.assertRegex(row['run_ref'], r'^r-[0-9a-f]{20}$')
            else:
                self.assertIsNone(row['run_ref'])
        tester = extract._bot_id('tester-demo')
        self.assertEqual(sum(i['bot_ref'] == tester and i['status'] == 'running'
                             for i in payload['working']['items']), 3)
        self.assertEqual(s.delta(payload['cursor'])['working'], payload['working'])

    def test_open_attempt_without_profile_does_not_invent_a_worker(self):
        def lose_worker(db):
            db.execute("UPDATE task_runs SET profile=NULL WHERE task_id='t_a0000001'")
        payload = self.scene(mutate=lose_worker).replay()
        row = next(i for i in payload['working']['items'] if i['task_ref'] == 't_a0000001')
        self.assertFalse(row['worker_observed'])
        self.assertEqual(row['display_name'], 'Worker not observed')
        self.assertEqual(row['bot_ref'], extract._bot_id('developer-demo'))
        self.assertRegex(row['run_ref'], r'^r-[0-9a-f]{20}$')

    def test_nonstandard_source_task_id_uses_the_same_safe_payload_binding(self):
        def odd_id(db):
            db.execute("UPDATE tasks SET id='private-card-slug' WHERE id='t_a0000001'")
            db.execute("UPDATE task_runs SET task_id='private-card-slug' WHERE task_id='t_a0000001'")
        payload = self.scene(mutate=odd_id).replay()
        safe_id = extract._bot_id('private-card-slug')
        self.assertIn(safe_id, {t['id'] for t in payload['tasks']})
        self.assertEqual(sum(i['task_ref'] == safe_id for i in payload['working']['items']), 1)
        self.assertNotIn('private-card-slug', json.dumps(payload))

    def test_card_ref_survives_retry_status_change_and_keyless_reordering(self):
        s = self.scene()
        before = s.replay()
        first = next(i for i in before['working']['items'] if i['task_ref'] == 't_a0000001')
        db = sqlite3.connect(Path(s.cfg['hermes_home']) / 'kanban.db')
        db.execute("INSERT INTO task_runs(task_id,profile,started_at) VALUES('t_a0000001','tester-demo',?)", (s.now - 1,))
        db.commit(); db.close()
        after = next(i for i in s.delta(before['cursor'])['working']['items'] if i['task_ref'] == first['task_ref'])
        self.assertEqual(first['ref'], after['ref'])
        self.assertNotEqual(first['run_ref'], after['run_ref'])
        self.assertEqual(after['bot_ref'], extract._bot_id('tester-demo'))
        (Path(s.cfg['hermes_home']) / 'hermes-quest/session-ref.key').unlink()
        keyless = s.replay()
        db = sqlite3.connect(Path(s.cfg['hermes_home']) / 'kanban.db')
        db.execute("UPDATE tasks SET status='blocked' WHERE id='t_a0000001'")
        db.commit(); db.close()
        again = s.delta(keyless['cursor'])
        self.assertEqual({i['task_ref']: i['ref'] for i in keyless['working']['items']},
                         {i['task_ref']: i['ref'] for i in again['working']['items']})
        self.assertTrue(all(i['run_ref'] is None for i in again['working']['items']))

    def test_key_rotation_changes_opaque_refs_but_not_entity_binding(self):
        s = self.scene()
        before = s.replay()
        (Path(s.cfg['hermes_home']) / 'hermes-quest/session-ref.key').write_bytes(bytes(reversed(range(32))))
        after = s.delta(before['cursor'])
        self.assertNotEqual(before['meta']['config_revision'], after['meta']['config_revision'])
        for a, b in zip(before['working']['items'], after['working']['items']):
            self.assertNotEqual(a['ref'], b['ref'])
            self.assertEqual((a['task_ref'], a['bot_ref']), (b['task_ref'], b['bot_ref']))
            if a['run_ref']:
                self.assertNotEqual(a['run_ref'], b['run_ref'])

    # --- R4: ordering and status mapping --------------------------------------------
    def test_status_classes_and_group_order(self):
        w = self.scene().replay()['working']
        order = [i['status'] for i in w['items']]
        self.assertEqual(order, sorted(order, key=lambda s: ['running', 'blocked', 'failed', 'unknown',
                                                              'done', 'archived'].index(s)))
        counts = {s: order.count(s) for s in set(order)}
        self.assertEqual(counts, {'running': 6, 'blocked': 1, 'failed': 1, 'done': 2, 'archived': 1,
                                  'unknown': 1})
        # ready/queued cards are not current work.
        self.assertFalse([i for i in w['items'] if i['quest_label'] in ('Queued lambda',)])

    def test_failed_run_on_retry_queue_is_failed_and_not_running(self):
        w = self.scene().replay()['working']
        failed = [i for i in w['items'] if i['status'] == 'failed']
        self.assertEqual(len(failed), 1)
        self.assertEqual(failed[0]['quest_kind'], 'build')

    def test_done_before_window_and_without_timestamp(self):
        w = self.scene().replay()['working']
        # theta finished 3 days ago: outside the 12 h window, so no row (still counted in XP).
        self.assertEqual(sum(i['status'] == 'done' for i in w['items']), 2)
        # done without completed_at is contradictory: Status unknown, never a win.
        self.assertEqual(sum(i['status'] == 'unknown' for i in w['items']), 1)

    def test_status_change_between_polls_moves_the_row(self):
        s = self.scene()
        before = s.replay()
        def finish(db):
            db.execute("UPDATE tasks SET status='done',completed_at=? WHERE id='t_a0000001'", (s.now - 5,))
            db.execute("UPDATE task_runs SET ended_at=?,outcome='completed' WHERE task_id='t_a0000001'", (s.now - 5,))
        db = sqlite3.connect(Path(s.cfg['hermes_home']) / 'kanban.db')
        finish(db); db.commit(); db.close()
        after = s.delta(before['cursor'])['working']
        self.assertEqual(sum(i['status'] == 'running' for i in after['items']), 5)
        self.assertEqual(after['progress']['wins_today'], before['working']['progress']['wins_today'] + 1)

    # --- R5: names ------------------------------------------------------------------
    def test_display_name_is_single_source_and_never_a_profile_id(self):
        for names in (True, False):
            for titles in (True, False):
                with self.subTest(show_profile_names=names, show_titles=titles):
                    s = self.scene(show_profile_names=names, show_titles=titles)
                    # backend injects the permission; the file value is ignored
                    s.cfg['show_profile_names'] = names
                    w = s.replay()['working']
                    for text in visible_strings(w):
                        self.assertNotRegex(text, r'(?i)\b(?:developer|tester|reviewer|researcher|devops|planner)-demo\b')
                        self.assertNotRegex(text, FORBIDDEN if not titles else r't_[0-9a-f]{8}')
                    labels = {i['display_name'] for i in w['items']}
                    if names:
                        self.assertIn('Demo Builder', labels)
                    else:
                        self.assertNotIn('Demo Builder', labels)
                        self.assertIn('Build Warrior 1', labels)

    def test_missing_alias_uses_stable_class_label_with_ordinal(self):
        s = self.scene(show_profile_names=True)
        s.cfg['show_profile_names'] = True
        labels = {i['display_name'] for i in s.replay()['working']['items']}
        self.assertTrue({'Demo Builder', 'Test Ranger 1', 'Review Paladin 1'} <= labels, labels)
        # Same label on a second poll and on a delta: stable.
        a = s.replay()['working']['items']
        b = s.replay()['working']['items']
        self.assertEqual(a, b)

    def test_duplicate_aliases_get_distinct_names(self):
        fixture = copy.deepcopy(FIXTURE)
        fixture['profiles']['tester-demo']['display_name'] = 'Twin'
        fixture['profiles']['reviewer-demo']['display_name'] = 'Twin'
        s = Scene(self, fixture=fixture, show_profile_names=True)
        self.enterContext(s)
        s.cfg['show_profile_names'] = True
        # tester-demo has no profile.yaml in build_home unless we write it.
        for name in ('tester-demo', 'reviewer-demo'):
            (Path(s.cfg['hermes_home']) / 'profiles' / name / 'profile.yaml').write_text('display_name: Twin\n')
        names = [i['display_name'] for i in s.replay()['working']['items'] if i['worker_observed']]
        self.assertIn('Twin', names)
        self.assertIn('Twin 2', names)

    def test_privacy_flags_are_independent(self):
        s = self.scene(show_titles=True)
        s.cfg['show_profile_names'] = False
        w = s.replay()['working']
        # titles on, names off: titles are sanitized text, aliases stay hidden.
        self.assertIn('Smoke verify beta checkout', {i['quest_label'] for i in w['items']})
        self.assertNotIn('Demo Builder', {i['display_name'] for i in w['items']})
        s2 = self.scene(show_titles=False)
        s2.cfg['show_profile_names'] = True
        w2 = s2.replay()['working']
        # names on, titles off: the alias shows but no raw title does.
        self.assertIn('Demo Builder', {i['display_name'] for i in w2['items']})
        self.assertFalse([i for i in w2['items'] if 'Smoke' in i['quest_label']])

    # --- quest names ----------------------------------------------------------------
    def test_generic_quest_names_are_typed_numbered_and_stable(self):
        w = self.scene().replay()['working']
        labels = {i['quest_label'] for i in w['items']}
        self.assertIn('Testing quest #1', labels)
        self.assertTrue(all(re.fullmatch(r'(?:Planning|Build|Testing|Review|Deploy|Verification|Guild) quest #\d+', l)
                            for l in labels), labels)
        # Verification wording on a tester task is typed Verification, not Testing.
        self.assertTrue(any(l.startswith('Verification quest') for l in labels))
        # Numbers do not come from card IDs, and two polls agree.
        self.assertEqual(labels, {i['quest_label'] for i in self.scene().replay()['working']['items']})

    def test_opt_in_titles_are_sanitized_short_and_fall_back_to_generic(self):
        s = self.scene(show_titles=True)
        w = s.replay()['working']
        labels = {i['quest_label'] for i in w['items']}
        self.assertTrue(all(len(graphemes(l)) <= 30 for l in labels), labels)
        self.assertIn('Build alpha dashboard', labels)  # project prefix, customer id and path removed
        self.assertNotIn('password', json.dumps(w).lower())
        self.assertNotIn('Fictional', json.dumps(w))
        self.assertTrue(any(re.fullmatch(r'Build quest #\d+', l) for l in labels))  # unsafe title -> generic
        long = [l for l in labels if l.startswith('Regression sweep')]
        self.assertEqual(len(long), 1)
        self.assertTrue(long[0].endswith('…'))
        self.assertEqual(len(graphemes(long[0])), 30)

    def test_cluster_aware_truncation(self):
        title = 'Build ' + 'e\u0301' * 40
        self.assertEqual(len(graphemes(extract._quest_title(title))), 30)

    # --- R6: latest Captain order ---------------------------------------------------
    def test_latest_order_is_newest_explicit_captain_action(self):
        s = self.scene()
        w = s.replay()['working']
        order = w['latest_order']
        # Newest Captain-created card is t_a0000004 (created 100 s ago); the worker-created
        # card created 10 s ago is not a Captain instruction.
        self.assertEqual(order['at'], extract._iso(s.now - 100))
        self.assertEqual(order['action_label'], 'Assigned quest')
        self.assertTrue(re.fullmatch(r'Build quest #\d+', order['quest_label']))
        self.assertEqual(order['recipient_display_name'], 'Build Warrior 1')

    def test_no_captain_action_in_retained_history_is_null(self):
        def only_worker_cards(db):
            db.execute("UPDATE tasks SET created_by='tester-demo'")
        s = self.scene(mutate=only_worker_cards)
        self.assertIsNone(s.replay()['working']['latest_order'])

    def test_run_start_never_becomes_a_captain_order(self):
        def drop_captain(db):
            db.execute("UPDATE tasks SET created_by=NULL")
        self.assertIsNone(self.scene(mutate=drop_captain).replay()['working']['latest_order'])

    def test_unassigned_order_has_no_recipient(self):
        def newest_unowned(db):
            db.execute("UPDATE tasks SET created_by='tester-demo'")
            db.execute("UPDATE tasks SET created_by='planner-demo' WHERE id='t_a0000005'")
        w = self.scene(mutate=newest_unowned).replay()['working']
        self.assertEqual(w['latest_order']['action_label'], 'Created quest')
        self.assertIsNone(w['latest_order']['recipient_display_name'])

    def test_explicit_reassignment_stays_pinned_across_unchanged_polls(self):
        s = self.scene()
        db = sqlite3.connect(Path(s.cfg['hermes_home']) / 'profiles/planner-demo/state.db')
        db.executescript('''
CREATE TABLE sessions(id TEXT PRIMARY KEY,source TEXT,parent_session_id TEXT,started_at REAL,title TEXT);
CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,
 tool_calls TEXT,tool_name TEXT,tool_call_id TEXT,timestamp REAL,token_count INTEGER);
''')
        db.execute("INSERT INTO sessions VALUES('captain','cli',NULL,?,'Captain')", (s.now - 100,))
        calls = [{'id': 'order', 'function': {'name': 'kanban_reassign', 'arguments':
                  json.dumps({'task_id': 't_a0000001', 'assignee': 'tester-demo'})}}]
        db.execute("INSERT INTO messages VALUES(1,'captain','assistant',NULL,?,NULL,NULL,?,NULL)",
                   (json.dumps(calls), s.now - 5))
        db.commit(); db.close()
        first = s.replay()
        order = first['working']['latest_order']
        self.assertEqual(order['action_label'], 'Reassigned quest')
        self.assertEqual(order['recipient_display_name'], 'Test Ranger 1')
        delta = s.delta(first['cursor'])
        idle = s.delta(delta['cursor'])
        self.assertEqual(idle['events'], [])
        self.assertEqual(delta['working']['latest_order'], order)
        self.assertEqual(idle['working']['latest_order'], order)
        self.assertEqual(s.replay()['working']['latest_order'], order)

    def test_idle_latest_order_scan_never_imports_private_arguments(self):
        s = self.scene()
        private = 'PRIVATE_ARGUMENT_SENTINEL'
        db = sqlite3.connect(Path(s.cfg['hermes_home']) / 'profiles/planner-demo/state.db')
        db.executescript('''
CREATE TABLE sessions(id TEXT PRIMARY KEY,source TEXT,parent_session_id TEXT,started_at REAL,title TEXT);
CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,
 tool_calls TEXT,tool_name TEXT,tool_call_id TEXT,timestamp REAL,token_count INTEGER);
''')
        db.execute("INSERT INTO sessions VALUES('captain','cli',NULL,?,'Captain')", (s.now - 100,))
        calls = [
            {'id': 'order', 'function': {'name': 'kanban_reassign', 'arguments':
             json.dumps({'task_id': 't_a0000001', 'assignee': 'tester-demo', 'reason': private})}},
            {'id': 'comment', 'function': {'name': 'kanban_comment', 'arguments':
             json.dumps({'task_id': 't_a0000001', 'body': private})}},
        ] + [{'id': name, 'function': {'name': name, 'arguments': json.dumps({'prose': private})}}
             for name in ('terminal', 'patch', 'write_file', 'mnemosyne_recall')]
        db.execute("INSERT INTO messages VALUES(1,'captain','assistant',NULL,?,NULL,NULL,?,NULL)",
                   (json.dumps(calls), s.now - 5))
        db.commit(); db.close()
        first = s.replay()
        original_ro = extract.ro
        source_rows = []

        def spy_ro(path):
            connection = original_ro(path)
            if Path(path).name == 'state.db':
                def source_read(cursor, values):
                    # Observe SQL result values as they cross into Python, not only
                    # the final payload (which already redacted the old full args).
                    source_rows.append(tuple(values))
                    return sqlite3.Row(cursor, values)
                connection.row_factory = source_read
            return connection

        with patch.object(extract, 'ro', side_effect=spy_ro):
            delta = s.delta(first['cursor'])
        self.assertEqual(delta['events'], [])
        self.assertEqual(delta['working']['latest_order'], first['working']['latest_order'])
        self.assertTrue(source_rows, 'The source-read spy must observe the idle scan')
        imported = repr(source_rows)
        self.assertNotIn(private, imported)
        for name in ('terminal', 'patch', 'write_file', 'mnemosyne_recall'):
            self.assertNotIn(name, imported)
        self.assertNotIn(private, json.dumps(delta))

    def test_latest_order_projection_is_scalar_only_and_json1_fails_closed(self):
        private = 'PRIVATE_PROJECTION_SENTINEL'
        with sqlite3.connect(':memory:') as db:
            db.row_factory = sqlite3.Row
            db.execute('CREATE TABLE messages(session_id TEXT,timestamp REAL,role TEXT,tool_calls TEXT)')
            calls = [
                {'function': {'name': 'kanban_link', 'arguments':
                 {'child_id': 't_a0000001', 'parent_id': private, 'body': private}}},
                {'function': {'name': 'kanban_reassign', 'arguments': json.dumps(
                 {'task_id': 't_a0000002', 'assignee': 'tester-demo', 'reason': private})}},
                {'function': {'name': 'kanban_comment', 'arguments':
                 {'task_id': {'nested': private}, 'child_id': [private], 'assignee': [private]}}},
                {'function': {'name': 'kanban_block', 'arguments': 'not JSON ' + private}},
                {'function': {'name': 'terminal', 'arguments': {'task_id': private}}},
                private, None,
            ]
            for raw in (json.dumps(calls), 'invalid JSON ' + private, json.dumps(private)):
                db.execute("INSERT INTO messages VALUES('captain',10,'assistant',?)", (raw,))
            projected = [dict(r) for r in db.execute(extract._latest_order_sql(), (0, 20))]
            self.assertEqual(len(projected), 4)
            self.assertEqual(set(projected[0]),
                             {'seq', 'call_index', 'session_id', 'timestamp', 'name', 'task_id', 'child_id', 'assignee'})
            self.assertEqual(projected[0]['child_id'], 't_a0000001')
            self.assertEqual(projected[1]['task_id'], 't_a0000002')
            self.assertEqual(projected[1]['assignee'], 'tester-demo')
            for row in projected[2:]:
                self.assertTrue(all(row[field] is None for field in ('task_id', 'child_id', 'assignee')))
            self.assertNotIn(private, json.dumps(projected))
            # Prove the fallback does not merely skip parsing the returned source:
            # even unavailable JSON functions cannot execute on this path.
            def unavailable(*args):
                raise AssertionError('JSON1 must not run in the fail-closed query')
            db.create_function('json_valid', 1, unavailable)
            self.assertEqual(list(db.execute(extract._latest_order_sql(False), (0, 20))), [])

    def test_session_parent_lineage_is_keyed_and_never_task_dependencies(self):
        s = self.scene()
        db = sqlite3.connect(Path(s.cfg['hermes_home']) / 'profiles/developer-demo/state.db')
        db.executescript('''
CREATE TABLE sessions(id TEXT PRIMARY KEY,source TEXT,parent_session_id TEXT,started_at REAL,title TEXT);
CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,
 tool_calls TEXT,tool_name TEXT,tool_call_id TEXT,timestamp REAL,token_count INTEGER);
''')
        for sid, source, parent in [('root', 'kanban', None), ('child', 'subagent', 'root'),
                                    ('orphan', 'subagent', 'missing')]:
            db.execute('INSERT INTO sessions VALUES(?,?,?,?,?)', (sid, source, parent, s.now - 40, 'Worker'))
        db.execute("INSERT INTO messages VALUES(1,'root','user','task t_a0000001',NULL,NULL,NULL,?,NULL)", (s.now - 40,))
        db.commit(); db.close()
        db = sqlite3.connect(Path(s.cfg['hermes_home']) / 'kanban.db')
        db.execute("INSERT INTO task_links VALUES('t_a0000002','t_a0000001')")
        db.commit(); db.close()
        payload = s.replay()
        key = bytes(range(32))
        ref = lambda sid: extract._session_digest(key, 'developer-demo', sid)[:20]
        sessions = {row['session_ref']: row for row in payload['sessions']}
        self.assertEqual(sessions[ref('child')]['parent_session_ref'], ref('root'))
        self.assertEqual(sessions[ref('child')]['task'], 't_a0000001')
        self.assertIsNone(sessions[ref('orphan')]['parent_session_ref'])
        self.assertTrue(all(i['parent_ref'] is None for i in payload['working']['items']))
        self.assertEqual(s.delta(payload['cursor'])['sessions'], payload['sessions'])

    # --- R7: rewards ----------------------------------------------------------------
    def test_progress_comes_from_done_tasks_with_the_agreed_formula(self):
        w = self.scene().replay()['working']
        # done with completed_at: zeta (today), eta (today), theta (3 days ago). Not archived,
        # not the done-without-timestamp card, not blocked/failed.
        self.assertEqual(w['progress'], dict(wins_today=2, xp=30, gold=3, level=1, level_progress=30))

    def test_level_and_idempotence_across_replay_delta_and_rebase(self):
        fixture = copy.deepcopy(FIXTURE)
        for n in range(9):
            fixture['board']['tasks'].append(dict(
                id='t_b%07x' % n, title='Bulk', assignee='developer-demo', status='done',
                created_by='planner-demo', created_ago=90000, started_ago=80000, completed_ago=70000))
        s = Scene(self, fixture=fixture)
        self.enterContext(s)
        first = s.replay()
        self.assertEqual(first['working']['progress']['xp'], 120)
        self.assertEqual((first['working']['progress']['level'],
                          first['working']['progress']['level_progress']), (2, 20))
        again = s.replay()
        delta = s.delta(first['cursor'])
        rebase = s.replay(hours=24)
        for payload in (again, delta, rebase):
            self.assertEqual(payload['working']['progress'], first['working']['progress'])

    def test_failed_blocked_and_archived_earn_nothing(self):
        def only_non_done(db):
            db.execute("UPDATE tasks SET status='archived' WHERE status='done'")
        w = self.scene(mutate=only_non_done).replay()['working']
        self.assertEqual(w['progress'], dict(wins_today=0, xp=0, gold=0, level=1, level_progress=0))

    def test_wins_today_uses_the_backend_machine_timezone(self):
        fixture = copy.deepcopy(FIXTURE)
        fixture['board']['tasks'][8]['completed_ago'] = 40000  # yesterday UTC, today Bangkok
        with Scene(self, fixture=fixture) as bangkok:
            self.assertEqual(bangkok.replay()['working']['progress']['wins_today'], 2)
        fixture['tz'] = 'UTC'
        with Scene(self, fixture=fixture) as utc:
            self.assertEqual(utc.replay()['working']['progress']['wins_today'], 1)

    def test_future_completion_does_not_earn_rewards(self):
        def future(db):
            db.execute("UPDATE tasks SET completed_at=? WHERE id='t_a0000008'", (FIXTURE['now'] + 1,))
        w = self.scene(mutate=future).replay()['working']
        self.assertEqual(w['progress'], dict(wins_today=1, xp=20, gold=2, level=1, level_progress=20))

    # --- R3: resting ----------------------------------------------------------------
    def test_resting_count_excludes_busy_workers_and_the_captain(self):
        w = self.scene().replay()['working']
        # busy: developer, tester, (reviewer's task is blocked, not running), none other.
        self.assertEqual(w['resting_count'], 3)  # reviewer, researcher, devops

    # --- degenerate sources ---------------------------------------------------------
    def test_absent_board_has_an_empty_working_block(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {'HERMES_HOME': tmp, 'HERMES_QUEST_CONFIG': ''}):
            cfg = extract.load_config()
            w = extract.build_replay(cfg, 12)['working']
        self.assertEqual((w['items'], w['resting_count'], w['latest_order']), ([], 0, None))
        self.assertEqual(w['progress'], dict(wins_today=0, xp=0, gold=0, level=1, level_progress=0))

    def test_without_session_key_refs_are_ordinals_not_ids(self):
        s = self.scene()
        (Path(s.cfg['hermes_home']) / 'hermes-quest' / 'session-ref.key').unlink()
        items = s.replay()['working']['items']
        self.assertTrue(items)
        self.assertTrue(all(re.fullmatch(r'w-\d+', i['ref']) for i in items))

    # --- privacy over the whole payload --------------------------------------------
    def test_no_task_profile_hash_or_path_in_any_visible_working_text(self):
        for names in (True, False):
            for titles in (True, False):
                with self.subTest(names=names, titles=titles):
                    s = self.scene(show_titles=titles)
                    s.cfg['show_profile_names'] = names
                    w = s.replay()['working']
                    blob = json.dumps(w)
                    self.assertNotRegex(' '.join(visible_strings(w)), r't_[0-9a-f]{8}')
                    self.assertNotRegex(blob, r'(?i)(?:developer|tester|reviewer|researcher|devops|planner)-demo')
                    self.assertNotRegex(blob, r'/srv|/media|/home|CUST-|Fictional|password')
                    self.assertNotRegex(blob, r'[0-9a-f]{32}')
                    for item in w['items']:
                        self.assertNotRegex(item['ref'], r't_[0-9a-f]')

    def test_refs_are_not_derived_from_task_ids_without_the_key(self):
        a = self.scene().replay()['working']['items']
        fixture = copy.deepcopy(FIXTURE)
        for t in fixture['board']['tasks']:
            t['id'] = t['id'].replace('t_a', 't_c')
        for r in fixture['board']['runs']:
            r['task_id'] = r['task_id'].replace('t_a', 't_c')
        b = Scene(self, fixture=fixture)
        with b:
            other = b.replay()['working']['items']
        # Different private keys/ids give different refs (they are HMACs, not echoes of ids).
        self.assertNotEqual([i['ref'] for i in a], [i['ref'] for i in other])


class WorkingApiTests(unittest.TestCase):
    """The mounted API passes the block through unchanged and anonymous callers get no names."""
    def test_api_replay_and_events_carry_working_with_names_closed_when_anonymous(self):
        import importlib.util
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        spec = importlib.util.spec_from_file_location('quest_scene_api', ROOT / 'dashboard/plugin_api.py')
        api = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(api)
        s = Scene(self)
        self.enterContext(s)
        cfgpath = Path(s.cfg['hermes_home']) / 'config.json'
        cfgpath.write_text(json.dumps(dict(s.cfg, show_titles=False, show_profile_names=True)))
        self.enterContext(patch.dict(os.environ, {'HERMES_QUEST_CONFIG': str(cfgpath),
                                                 'HERMES_QUEST_SAMPLER': 'off',
                                                 'PYTHONDONTWRITEBYTECODE': '1'}))
        app = FastAPI()
        app.include_router(api.router, prefix='/api/plugins/hermes-quest')
        client = self.enterContext(TestClient(app))
        replay = client.get('/api/plugins/hermes-quest/replay').json()
        self.assertEqual(set(replay['working']), WORKING_KEYS)
        self.assertNotIn('Demo Builder', json.dumps(replay['working']))  # anonymous: no alias
        delta = client.get('/api/plugins/hermes-quest/events', params={'since': replay['cursor']}).json()
        self.assertEqual(set(delta['working']), WORKING_KEYS)


if __name__ == '__main__':
    unittest.main()
