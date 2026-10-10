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
             'quest_kind', 'group_label', 'parent_ref', 'worker_observed'}
WORKING_KEYS = {'as_of', 'items', 'resting_count', 'latest_order', 'progress'}
PROGRESS_KEYS = {'wins_today', 'xp', 'gold', 'level', 'level_progress'}
ORDER_KEYS = {'at', 'action_label', 'quest_label', 'recipient_display_name'}
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
                self.assertEqual(s.replay()['working'], FIXTURE['expected'][mode])

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

    # --- R1/R2: current running, one row per (task, run) ------------------------------
    def test_running_rows_come_from_current_board_not_events(self):
        s = self.scene()
        replay = s.replay()
        self.assertEqual(replay['events'] and len(replay['events']) >= 0, True)
        running = [i for i in replay['working']['items'] if i['status'] == 'running']
        # 001,002,003,004 + unowned 005 + 2 open runs on 00d = 7 distinct (task, run) rows.
        self.assertEqual(len(running), 7)
        self.assertEqual(len({i['ref'] for i in replay['working']['items']}),
                         len(replay['working']['items']))
        # No task_events rows exist at all, yet every running card is present.
        self.assertEqual([e for e in replay['events'] if e['kind'] == 'heartbeat'], [])

    def test_running_card_with_no_event_in_window_is_still_present(self):
        s = self.scene()
        old = s.replay(hours=0.001)  # window far shorter than every run
        self.assertEqual(sum(i['status'] == 'running' for i in old['working']['items']), 7)

    def test_two_open_runs_on_one_task_are_two_rows_with_own_worker(self):
        w = self.scene().replay()['working']
        observed = [i for i in w['items'] if i['status'] == 'running' and i['worker_observed']]
        # 001, 002, 003 (one open run each) + both open runs of the shared task = 5 rows;
        # t_a0000004 has no run row at all, so it is the "not observed" case.
        self.assertEqual(len(observed), 5)
        self.assertEqual(len({(i['display_name'], i['quest_label']) for i in observed}), 5)
        # Exactly one quest label appears on two rows (the shared task), with two different workers.
        by_quest = {}
        for item in observed:
            by_quest.setdefault(item['quest_label'], []).append(item['display_name'])
        shared = [names for names in by_quest.values() if len(names) == 2]
        self.assertEqual(len(shared), 1)
        self.assertEqual(len(set(shared[0])), 2)

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

    # --- R4: ordering and status mapping --------------------------------------------
    def test_status_classes_and_group_order(self):
        w = self.scene().replay()['working']
        order = [i['status'] for i in w['items']]
        self.assertEqual(order, sorted(order, key=lambda s: ['running', 'blocked', 'failed', 'unknown',
                                                              'done', 'archived'].index(s)))
        counts = {s: order.count(s) for s in set(order)}
        self.assertEqual(counts, {'running': 7, 'blocked': 1, 'failed': 1, 'done': 2, 'archived': 1,
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
        self.assertEqual(sum(i['status'] == 'running' for i in after['items']), 6)
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
        s = self.scene()
        bangkok_today = s.replay()['working']['progress']['wins_today']
        fixture = copy.deepcopy(FIXTURE)
        fixture['tz'] = 'Pacific/Kiritimati'  # UTC+14: day began 8 h before the 08:00 UTC now
        with Scene(self, fixture=fixture) as other:
            ahead = other.replay()['working']['progress']['wins_today']
        self.assertEqual(bangkok_today, 2)
        self.assertGreaterEqual(ahead, bangkok_today)

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
                    self.assertNotRegex(blob, r't_[0-9a-f]{8}')
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
