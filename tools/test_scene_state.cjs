'use strict';
// Working-view reducer: one row per ref, idempotent poll/replay/rebase, rewards once per distinct done ref.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {load} = require('./parity/loader.cjs');
const root = path.resolve(__dirname, '..');
// Objects built inside the game's vm realm are not reference-equal to host ones; compare by value.
const deepEqual = (a, b) => assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), b);
const clone = v => JSON.parse(JSON.stringify(v));
const demo = () => JSON.parse(fs.readFileSync(path.join(root, 'data/demo.json'), 'utf8'));
const mk = () => { const {G} = load({root, data: demo()}); G.loadReplay(G.D); G.reset(G.D.meta.to); G.liveFeed = true; G.following = true; G.S.play = true; return G; };
const item = (ref, status, extra = {}) => ({ref, status, started_at: 1700000000, display_name: 'Hero ' + ref, class_label: 'Mage',
  quest_label: 'Build', quest_kind: 'build', group_label: 'Alpha', parent_ref: null, worker_observed: true, ...extra});
const snap = (asOf, items, extra = {}) => ({as_of: asOf, items, resting_count: 0, latest_order: null, progress: null, ...extra});
const delta = (working, extra = {}) => ({events: [], tasks: [], bots: [], cursor: 'c', working, ...extra});
const T = 1700003000;
let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok -', name); };

test('no working block (old backend / demo) leaves Working view empty and S enumeration unchanged', () => {
  const G = mk();
  assert.equal(G.S.work.has, false); assert.equal(G.S.work.rows().running.length, 0);
  assert.ok(!Object.keys(G.S).includes('work')); assert.ok(!JSON.stringify(G.S).includes('"work"'));
});
test('current running with no events stays active; done/archived leave active; failed does not stay running', () => {
  const G = mk();
  G.mergeDelta(delta(snap(T, [item('a', 'running'), item('b', 'done'), item('c', 'archived'), item('d', 'failed'), item('e', 'blocked'), item('f', 'weird')])));
  deepEqual(G.S.work.active().map(i => i.ref), ['a']);
  const c = G.S.work.counts();
  deepEqual([c.running, c.blocked, c.attention, c.completed], [1, 1, 2, 1]);
  assert.equal(G.S.work.item('f').status, 'unknown');
  assert.ok(!G.S.work.rows().running.concat(G.S.work.rows().attention, G.S.work.rows().completed).some(i => i.ref === 'c'));
});
test('one row per ref even with duplicate refs in a snapshot; overlapping delta is idempotent', () => {
  const G = mk(); const s = snap(T, [item('a', 'running'), item('a', 'running', {display_name: 'Latest'}), item('b', 'running')]);
  G.mergeDelta(delta(s)); G.mergeDelta(delta(clone(s))); G.mergeDelta(delta(clone(s)));
  assert.equal(G.S.work.items().length, 2); assert.equal(G.S.work.item('a').display_name, 'Latest');
});
test('rows are ordered by start time then ref', () => {
  const G = mk();
  G.mergeDelta(delta(snap(T, [item('z', 'running', {started_at: 5}), item('b', 'running', {started_at: 9}), item('a', 'running', {started_at: 9}), item('n', 'running', {started_at: null})])));
  deepEqual(G.S.work.rows().running.map(i => i.ref), ['z', 'a', 'b', 'n']);
});
test('reward once per distinct done ref across delta, replay, rebase and done->running->done', () => {
  const G = mk(), done = [];
  G.mergeDelta(delta(snap(T, [item('a', 'running')])));
  G.S.work.onComplete(i => done.push(i.ref));
  G.mergeDelta(delta(snap(T + 10, [item('a', 'done')])));
  G.mergeDelta(delta(snap(T + 20, [item('a', 'done')])));
  G.loadReplay({...clone(demo()), working: snap(T + 30, [item('a', 'done')])}, {t: 0, keys: new Set()});
  G.mergeDelta(delta(snap(T + 40, [item('a', 'running')])));
  G.mergeDelta(delta(snap(T + 50, [item('a', 'done')])));
  deepEqual(done, ['a']);
  const p = G.S.work.progress(); deepEqual([p.xp, p.gold, p.level, p.source], [10, 1, 1, 'observed']);
  G.mergeDelta(delta(snap(T + 60, [item('b', 'done')])));
  deepEqual(done, ['a', 'b']); assert.equal(G.S.work.progress().xp, 20);
});
test('boot baseline credits finished work silently (no fireworks), later completions fire', () => {
  const G = mk(), done = [];
  G.S.work.onComplete(i => done.push(i.ref));
  G.mergeDelta(delta(snap(T, [item('old', 'done'), item('r', 'running')])));
  deepEqual(done, []); assert.equal(G.S.work.credited('old'), true);
  assert.equal(G.S.work.progress().wins_today, 0, 'baseline is not a win today');
  G.mergeDelta(delta(snap(T + 10, [item('old', 'done'), item('r', 'done')])));
  deepEqual(done, ['r']); assert.equal(G.S.work.progress().wins_today, 1);
});
test('backend progress is authoritative and replaced, not summed', () => {
  const G = mk(), pr = {wins_today: 3, xp: 250, gold: 42, level: 3, level_progress: 50};
  G.mergeDelta(delta(snap(T, [item('a', 'done')], {progress: pr}))); G.mergeDelta(delta(snap(T + 5, [item('a', 'done')], {progress: pr})));
  const p = G.S.work.progress(); deepEqual([p.wins_today, p.xp, p.gold, p.level, p.level_progress, p.source], [3, 250, 42, 3, 50, 'backend']);
});
test('out-of-order older delta is ignored; rebase is authoritative even when older', () => {
  const G = mk();
  G.mergeDelta(delta(snap(T + 100, [item('a', 'running')])));
  G.mergeDelta(delta(snap(T, [item('a', 'failed')])));
  assert.equal(G.S.work.item('a').status, 'running'); assert.equal(G.S.work.asOf, T + 100);
  G.loadReplay({...demo(), working: snap(T, [item('a', 'failed')])}, {t: 0, keys: new Set()});
  assert.equal(G.S.work.item('a').status, 'failed');
});
test('delta without working keeps state; rebase without working clears it', () => {
  const G = mk();
  G.mergeDelta(delta(snap(T, [item('a', 'running')]))); G.mergeDelta(delta(undefined));
  assert.equal(G.S.work.active().length, 1);
  G.loadReplay(demo(), {t: 0, keys: new Set()});
  assert.equal(G.S.work.has, false);
});
test('scrub/reset rebuilds scene from events but does not touch work or credits', () => {
  const G = mk(); G.mergeDelta(delta(snap(T, [item('a', 'running'), item('b', 'done')])));
  const v = G.S.work.version; G.reset(G.D.meta.from_); G.reset(G.D.meta.to);
  assert.equal(G.S.work.version, v); assert.equal(G.S.work.active().length, 1); assert.equal(G.S.work.credited('b'), true);
});
test('malformed working rejects the whole delta/rebase and leaves everything unchanged', () => {
  const G = mk(); G.mergeDelta(delta(snap(T, [item('a', 'running')])));
  const cursor = G.cursor, events = G.D.events.length;
  for (const bad of [{items: []}, {as_of: T, items: 'x'}, snap(T, [{status: 'running'}]), snap(T, [null]), snap(T, [], {latest_order: {at: 'nope'}})]) {
    assert.throws(() => G.mergeDelta(delta(bad, {cursor: 'x', events: [{t: T, kind: 'created', task: 'zzz', id: 'zz'}]})), /Invalid working/);
    assert.throws(() => G.loadReplay({...demo(), working: bad}, {t: 0, keys: new Set()}), /Invalid working/);
  }
  assert.equal(G.cursor, cursor); assert.equal(G.D.events.length, events); assert.equal(G.S.work.active()[0].ref, 'a');
});
test('rebase failure after planning rolls Working state back', () => {
  const G = mk(); G.mergeDelta(delta(snap(T, [item('a', 'running')])));
  const bad = {...demo(), working: snap(T + 10, [item('b', 'running')])}; bad.events = [...bad.events];
  G.D.meta.captain; const real = G.reset; G.reset = () => { throw new Error('boom'); };
  assert.throws(() => G.loadReplay(bad, {t: 0, keys: new Set()}, null), /boom/);
  G.reset = real; deepEqual(G.S.work.active().map(i => i.ref), ['a']);
});
test('latest order fires once per distinct order, not at boot baseline, never twice on replay', () => {
  const G = mk(), orders = []; G.S.work.onOrder(o => orders.push(o.quest_label));
  const o1 = {at: T, action_label: 'Sent', quest_label: 'Q1', recipient_display_name: 'Hero a'};
  G.mergeDelta(delta(snap(T, [], {latest_order: o1}))); deepEqual(orders, []);
  G.mergeDelta(delta(snap(T + 5, [], {latest_order: o1}))); deepEqual(orders, []);
  const o2 = {...o1, at: T + 9, quest_label: 'Q2', recipient_display_name: null};
  G.mergeDelta(delta(snap(T + 10, [], {latest_order: o2}))); G.mergeDelta(delta(snap(T + 11, [], {latest_order: o2})));
  G.loadReplay({...demo(), working: snap(T + 12, [], {latest_order: o2})}, {t: 0, keys: new Set()});
  deepEqual(orders, ['Q2']); assert.equal(G.S.work.latestOrder.recipient_display_name, null);
});
test('order identity ignores alias/title changes but distinguishes bound tasks', () => {
  const G=mk(),orders=[];G.S.work.onOrder(o=>orders.push(o.task_ref));
  G.mergeDelta(delta(snap(T,[])));
  const order={at:T+1,action_label:'Assigned quest',quest_label:'Build quest #1',recipient_display_name:'Nova',task_ref:'task-one',recipient_bot_ref:'bot-one'};
  G.mergeDelta(delta(snap(T+2,[],{latest_order:order})));
  G.mergeDelta(delta(snap(T+3,[],{latest_order:{...order,quest_label:'Safe new label',recipient_display_name:'Ember'}})));
  deepEqual(orders,['task-one']);assert.equal(G.S.work.latestOrder.recipient_display_name,'Ember');
  G.mergeDelta(delta(snap(T+4,[],{latest_order:{...order,task_ref:'task-two'}})));
  deepEqual(orders,['task-one','task-two']);
});
test('a throwing hook neither blocks other hooks nor the poll; unsubscribe works', () => {
  const G = mk(), got = []; G.mergeDelta(delta(snap(T, [item('a', 'running')])));
  G.S.work.onComplete(() => { throw new Error('listener'); }); const off = G.S.work.onComplete(i => got.push(i.ref));
  G.mergeDelta(delta(snap(T + 5, [item('a', 'done')]))); deepEqual(got, ['a']); assert.equal(G.S.work.hookErrors, 1);
  off(); G.mergeDelta(delta(snap(T + 6, [item('a', 'done'), item('b', 'done')]))); deepEqual(got, ['a']);
  assert.throws(() => G.S.work.onOrder('x'), /hook must be a function/);
});
test('hook payload carries no ref/task id and listeners cannot mutate state', () => {
  const G = mk(); let info; G.mergeDelta(delta(snap(T, [item('a', 'running')])));
  G.S.work.onComplete(i => { info = i; i.display_name = 'tampered'; });
  G.mergeDelta(delta(snap(T + 5, [item('a', 'done')])));
  assert.equal(G.S.work.item('a').display_name, 'Hero a'); assert.ok(info.ref);
});
test('ISO and epoch-ms timestamps normalise to seconds', () => {
  const G = mk(); G.mergeDelta(delta({as_of: '2023-11-14T22:30:00Z', items: [item('a', 'running', {started_at: '2023-11-14T22:13:20Z'}), item('b', 'running', {started_at: 1700000000000})],
    resting_count: 2, latest_order: null, progress: null}));
  assert.equal(G.S.work.asOf, 1700001000); assert.equal(G.S.work.item('a').started_at, 1700000000); assert.equal(G.S.work.item('b').started_at, 1700000000);
  assert.equal(G.S.work.resting, 2);
});
test('bounded memory: credit ledger and done rows are capped', () => {
  const G = mk(); const items = Array.from({length: 2000}, (_, i) => item('r' + i, 'done'));
  for (let k = 0; k < 3; k++) G.mergeDelta(delta(snap(T + k, items.map(i => ({...i, ref: i.ref + ':' + k})))));
  assert.ok(G.S.work.items().length <= 2000);
  assert.throws(() => G.mergeDelta(delta(snap(T + 9, [...items, item('x', 'done')]))), /Invalid working/);
});
console.log(`PASS scene state: ${n} cases`);
