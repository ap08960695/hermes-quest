#!/usr/bin/env python3
"""Generate a deterministic, entirely synthetic data/demo.json. Never read live data."""
import json, os, random
from extract import DEFAULTS

P = os.path.join(os.path.dirname(__file__), '..', 'data', 'demo.json')
random.seed(7)
start = 1700000000
specs = [
    # Use class/model sheets shipped in the checkout, never raw/generated-only
    # combinations. A fresh standalone demo must not request missing sprites.
    ('demo-captain', 'commander', 'sol-demo', 'max', 'codex'),
    ('demo-smith', 'warrior', 'sol-demo', 'xhigh', 'codex'),
    ('demo-artisan', 'warrior', 'sonnet-demo', 'medium', 'claude'),
    ('demo-scout', 'ranger', 'sol-demo', 'high', 'codex'),
    ('demo-archer', 'ranger', 'gemini-demo', 'low', 'agy'),
    ('demo-guardian', 'paladin', 'sonnet-demo', 'medium', 'claude'),
    ('demo-engineer', 'engineer', 'sol-demo', 'high', 'codex'),
    ('demo-sage', 'sage', 'gemini-demo', 'max', 'agy'),
    ('demo-mage', 'mage', 'sonnet-demo', 'high', 'claude'),
]
d = dict(meta=dict(from_=start, to=start + 12 * 3600, hours=12, generated=start,
                   mock=True, source='demo', captain='demo-captain', show_titles=True,
                   classes=DEFAULTS['classes'], regions=DEFAULTS['regions'],
                   stage_regions=DEFAULTS['stage_regions']), cursor='', tasks=[], events=[],
         bots=[dict(id=p, name=p.removeprefix('demo-').title(), cls=c,
                    region=DEFAULTS['regions'][c], model=m, effort=e, wallet=w, mock=True)
               for p, c, m, e, w in specs])
t0 = start + 1800
EV, TASKS = [], []
TOOLS = {'PLAN': ['read_file', 'search_files', 'read_file', 'vision_analyze'],
         'BUILD': ['read_file', 'patch', 'terminal:build', 'patch', 'terminal:test', 'terminal:git', 'write_file'],
         'TEST': ['terminal:test', 'vision_analyze', 'terminal:probe', 'terminal:test'],
         'REVIEW': ['read_file', 'search_files', 'terminal:test', 'read_file'],
         'DEPLOY': ['terminal:deploy', 'terminal:probe', 'terminal:deploy', 'terminal:git'],
         'VERIFY': ['vision_analyze', 'terminal:test', 'terminal:probe']}


def e(t, task, kind, **kw):
    # Bot-level events (pause/resume/failover) come from botstatus history and carry no task.
    EV.append(dict(t=t, kind=kind, mock=True, **({'task': task} if task else {}), **kw))


def task(i, title, bot, stage, start, dur, parents=(), moa=False):
    tid = f't_demo{i:04d}'
    TASKS.append(dict(id=tid, title=title, bot=bot, status='done', created=start - 300, started=start,
                      completed=start + dur, campaign='DEMO-HOTFIX', moa=moa, max_rt=max(1200, dur + 600),
                      parents=list(parents), stage=stage, mock=True, tokens=random.randint(20, 90) * 1000))
    e(start - 300, tid, 'created')
    if parents:
        e(start - 290, tid, 'dependency_wait')
        e(start - 5, tid, 'promoted')
    e(start, tid, 'claimed', bot=bot)
    e(start, tid, 'run_start', bot=bot)
    t = start + 20
    while t < start + dur - 30:
        tool = random.choice(TOOLS[stage])
        name, _, cat = tool.partition(':')
        ev = dict(bot=bot, tool=name)
        if cat:
            ev['cat'] = cat
        if name in ('patch', 'write_file'):
            ev.update(plus=random.randint(3, 60), minus=random.randint(0, 20))
        e(t, tid, 'tool', **ev)
        # Mock mana: roughly chars/4 of a turn; the ones marked estimated mirror the
        # extractor's fallback when Hermes stored no token_count.
        if random.random() < .5:
            e(t + 1, tid, 'mana', bot=bot, tokens=random.randint(200, 4000), estimated=True, basis='chars')
        elif random.random() < .3:
            e(t + 1, tid, 'mana', bot=bot, tokens=random.randint(200, 4000))
        if cat == 'test' and random.random() < .5:
            e(t + 8, tid, 'tests', bot=bot, passed=random.choice([42, 318, 3486]))
        if random.random() < .06:
            e(t + 5, tid, 'hurt', bot=bot, code=1)
        if random.random() < .12:
            e(t + 2, tid, 'heartbeat', note=f'{stage.lower()} step ok')
        t += random.randint(15, 60)
    return tid


cap, dev, dev2 = 'demo-captain', 'demo-smith', 'demo-artisan'
tst, tstg, rev = 'demo-scout', 'demo-archer', 'demo-guardian'
ops, ana = 'demo-engineer', 'demo-sage'

a = task(1, 'DEMO plan hotfix (MoA council)', ana, 'PLAN', t0, 900, moa=True)
e(t0 + 5, a, 'moa', bot=ana, advisors=['FABLE', 'ASTRA'])
bd = task(2, 'DEMO build fix e-slip', dev, 'BUILD', t0 + 1000, 1800, [a])
e(t0 + 1200, bd, 'summon', bot=dev, sub='fox001')
e(t0 + 1500, bd, 'summon', bot=dev, sub='fox002')
ts = task(3, 'DEMO smoke SIT hotfix', tstg, 'TEST', t0 + 2900, 700, [bd])
e(t0 + 3550, ts, 'rate_limited', bot=tstg, note='gemini 5h pool empty')
# Botstatus history (synthetic): park the limited archer, fail its card over to the scout, resume.
e(t0 + 3552, None, 'pause', bot=tstg, why='limited')
e(t0 + 3561, None, 'failover', bot=tstg, other=tst)
e(t0 + 3560, ts, 'comment', author='default', tag='[failover]',
  note=f'[failover] {tstg} limited -> {tst}')
e(t0 + 3560, ts, 'assigned', bot=tst)
ts2 = task(4, 'DEMO smoke SIT hotfix (handed off)', tst, 'TEST', t0 + 3600, 600, [bd])
e(t0 + 9000, ts2, 'wake', bot=tstg, note='gemini pool reset')
e(t0 + 9001, None, 'resume', bot=tstg, why='limited')
e(t0 + 12000, None, 'pause', bot=ops, why='waiting-start')
e(t0 + 12600, None, 'resume', bot=ops, why='waiting-start')
rv = task(5, 'DEMO review hotfix diff', rev, 'REVIEW', t0 + 4300, 800, [ts2])
e(t0 + 4320, rv, 'review_requested')
dp = task(6, 'DEMO deploy the drawbridge', ops, 'DEPLOY', t0 + 5200, 1600, [rv])
e(t0 + 5500, dp, 'blocked', note='needs owner decision: deploy window')
e(t0 + 5520, dp, 'comment', author=cap, tag='', note='CAPTAIN: review the drawbridge')
e(t0 + 6300, dp, 'unblocked', note='owner approved')
vf = task(7, 'DEMO verify hotfix smoke', tst, 'VERIFY', t0 + 6400, 700, [dp])
for tid in (a, bd, ts2, rv, dp, vf):
    tk = next(t for t in TASKS if t['id'] == tid)
    e(tk['completed'], tid, 'completed', note=f'{tk["title"]} done')
    e(tk['completed'], tid, 'run_end', bot=tk['bot'], outcome='completed')
e(t0 + 3550, ts, 'run_end', bot=tstg, outcome='rate_limited')
next(t for t in TASKS if t['id'] == ts)['status'] = 'archived'

# A long training encounter allows the physical monster march to finish even at
# 120x replay speed. The quiet gap leaves time for scroll hand-offs before pickup.
training = task(8, 'DEMO defend the clockwork gate', dev2, 'BUILD', t0 + 14000, 6000, [vf])
for offset in (4500, 4800, 5100, 5400):
    e(t0 + 14000 + offset, training, 'hurt', bot=dev2, code=1)
followup = task(9, 'DEMO inspect the clockwork gate', 'demo-mage', 'PLAN', t0 + 22000, 6000, [training])
for tid in (training, followup):
    tk = next(t for t in TASKS if t['id'] == tid)
    e(tk['completed'], tid, 'completed')
    e(tk['completed'], tid, 'run_end', bot=tk['bot'], outcome='completed')
e(t0 + 1600, bd, 'compress', bot=dev, before=90, after=24)
e(t0 + 1700, bd, 'hurt', bot=dev, code=1)
for i, act in enumerate(('create', 'reassign', 'extend', 'link', 'unlink', 'unblock', 'block', 'note')):
    e(t0 + 1800 + i * 40, bd, 'captain', act=act, bot=dev2, other=a)
# Keep each hand-off window longer than the delayed completion animation.
# Without these gaps the next worker starts before the finisher can deliver a scroll.
shifts = {a: 0, bd: 400, ts: 1000, ts2: 1600, rv: 2000, dp: 2400, vf: 3000}
for tk in TASKS:
    shift = shifts.get(tk['id'], 0)
    for field in ('created', 'started', 'completed'):
        tk[field] += shift
for event in EV:
    event['t'] += shifts.get(event.get('task'), 0)
d['tasks'] = TASKS
d['events'] = sorted(EV, key=lambda x: x['t'])
for i, event in enumerate(d['events']):
    event['id'] = f'demo-event-{i}'
d['meta']['mock'] = True
os.makedirs(os.path.dirname(P), exist_ok=True)
with open(P, 'w', encoding='utf-8') as f:
    json.dump(d, f, ensure_ascii=False)
print('mock tasks', len(TASKS), 'mock events', len(EV))
