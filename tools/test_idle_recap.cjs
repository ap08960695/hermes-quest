'use strict';
// Synthetic retained-history fixtures and the real history comparator/reducer.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const assert = require('node:assert/strict');
const {load} = require('./parity/loader.cjs');
const root = path.resolve(__dirname, '..');
const sandbox = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(root, 'quest/idle-recap.js'), 'utf8'), sandbox);
const R = sandbox.QuestIdleRecap;
const plain = v => JSON.parse(JSON.stringify(v));
const equal = (actual, expected) => assert.deepEqual(plain(actual), expected);
const demo = () => JSON.parse(fs.readFileSync(path.join(root, 'data/demo.json'), 'utf8'));
const mk = () => { const {G} = load({root, data: demo()}); G.loadReplay(G.D); return G; };
vm.runInContext(fs.readFileSync(path.join(root, 'quest/history.js'), 'utf8'), sandbox);
const H = sandbox.HQModules.createHistory({validSessionRef: ref => typeof ref === 'string' && /^[a-f0-9]{20}$/.test(ref)});
const id = n => 'e_' + n.toString(16).padStart(64, '0');
const event = (n, t, kind = 'completed', extra = {}) => ({id: id(n), t, kind, ...extra});
const windowMeta = {from_: 0, as_of: 10000};
const recap = (events, seen, extra = {}) => R.summarize({events, seen, meta: windowMeta, ...extra}, H);
let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok -', name); };

test('fixed localStorage key and strict codecs keep only opaque IDs, never prose/task IDs', () => {
  assert.equal(R.STORAGE_KEY, 'hermesQuest.idleRecap.seen.v1');
  equal(R.decodeSeen(R.encodeSeen([id(1), id(1), id(2)])), [id(1), id(2)]);
  for (const raw of ['not json', '{}', 'null', '["t_12345678"]', '["e_title"]',
    JSON.stringify([{id: id(1), title: 'Private title', note: 'Private note'}]),
    JSON.stringify([id(1), 'Private title'])]) equal(R.decodeSeen(raw), []);
  assert.equal(R.encodeSeen([{id: id(1), task: 't_12345678'}]), '[]');
});
test('unseen real completion/block/failure events dedupe; tool/mana/time/archive add no rewards', () => {
  const rows = [event(1, 1, 'created'), event(2, 2), event(2, 2), event(3, 3, 'blocked'),
    event(4, 4, 'failed'), event(5, 5, 'tool'), event(6, 6, 'mana'), event(7, 7, 'archived')];
  const frozen = JSON.stringify(rows);
  const r = recap(rows, [id(1)]);
  assert.equal(r.coverage, 'complete'); equal(r.counts, {completed: 1, blocked: 1, failed: 1});
  assert.equal(JSON.stringify(rows), frozen);
  const seen = R.acknowledge(rows, [id(1)], H);
  equal(recap(rows, seen).counts, {completed: 0, blocked: 0, failed: 0});
  equal(R.acknowledge(rows, seen, H), plain(seen));
});
test('history order handles same-time source ordinals, mixed legacy and opaque-ID ties', () => {
  const ordinal = {bot: 'bot-demo', session_ref: 'a'.repeat(20), source_slot: 0};
  const rows = [event(1, 10, 'completed', {...ordinal, source_seq: 2}),
    event(9, 10, 'blocked', {...ordinal, source_seq: 1}), event(7, 10, 'created'), event(5, 10, 'created')];
  equal(R.acknowledge(rows, [], H), [id(5), id(7), id(9), id(1)]);
  equal(R.acknowledge([...rows].reverse(), [], H), [id(5), id(7), id(9), id(1)]);
  equal(recap(rows, [id(5), id(7), id(9)]).eventIds, [id(1)]);
});
test('late older arrival is counted despite the newer seen boundary; replay cannot pay twice', () => {
  const baseline = [event(1, 10, 'created'), event(3, 30)];
  const seen = R.acknowledge(baseline, [], H), rows = [event(2, 20), ...baseline];
  equal(recap(rows, seen).counts, {completed: 1, blocked: 0, failed: 0});
  const next = R.acknowledge(rows, seen, H);
  equal(next, [id(1), id(2), id(3)]);
  equal(recap([...rows].reverse(), next).counts, {completed: 0, blocked: 0, failed: 0});
});
test('no seen boundary, expired/missing boundary and incomplete window are unknown, never zero', () => {
  for (const r of [recap([], []), recap([event(2, 2)], [id(1)]),
    recap([event(1, 1)], [id(1)], {meta: {from_: 2, as_of: 3}}),
    recap([event(1, 1)], [id(1)], {meta: {as_of: 2}}),
    recap([event(1, 1)], [id(1)], {meta: {from_: 0}})]) {
    assert.equal(r.coverage, 'unknown'); equal(r.counts, {completed: null, blocked: null, failed: null});
    assert(r.text.includes('unknown'));
  }
});
test('a retained seen boundary allows older seen IDs to expire without losing coverage', () => {
  const r = recap([event(2, 20), event(3, 30)], [id(1), id(2)], {meta: {from_: 10, as_of: 40}});
  assert.equal(r.coverage, 'complete'); assert.equal(r.counts.completed, 1);
});
test('missing/raw identity and invalid timestamps never persist and force unknown totals', () => {
  for (const bad of [{t: 2, kind: 'completed'}, event(2, NaN), event(2, 2, 'completed', {id: 't_12345678'}), null]) {
    const rows = [event(1, 1), bad], r = recap(rows, [id(1)]);
    assert.equal(r.coverage, 'unknown'); assert.equal(r.counts.completed, null);
    equal(R.acknowledge(rows, [id(1)], H), [id(1)]);
  }
  assert.equal(recap([event(1, 1), event(2, 10001)], [id(1)]).coverage, 'unknown');
});
test('exactly 2000 rows complete; 2001 bounded and unknown; newest history-ordered IDs retained', () => {
  const rows = Array.from({length: 2001}, (_, i) => event(i + 1, i + 1));
  assert.equal(recap(rows.slice(0, 2000), [id(1)]).counts.completed, 1999);
  const r = recap(rows, [id(1)]);
  assert.equal(r.coverage, 'unknown'); assert.equal(r.counts.completed, null); assert.equal(r.eventIds.length, 2000);
  const seen = R.acknowledge([...rows].reverse(), [], H);
  assert.equal(seen.length, 2000); assert.equal(seen[0], id(2)); assert.equal(seen.at(-1), id(2001));
  equal(R.decodeSeen(R.encodeSeen(seen)), plain(seen));
  assert.equal(R.decodeSeen(JSON.stringify(rows.map(e => e.id))).length, 2000);
});
test('same-timestamp overflow is ordered by IDs and does not claim complete totals', () => {
  const rows = Array.from({length: 2001}, (_, i) => event(i + 1, 10));
  assert.equal(recap(rows, [id(1)]).coverage, 'unknown');
  equal(R.acknowledge(rows.reverse(), [], H), rows.map(e => e.id).reverse().slice(1));
});
test('pure model cannot access localStorage, network, DOM or mutate caller seen-state', () => {
  for (const key of ['localStorage', 'fetch', 'document'])
    Object.defineProperty(sandbox, key, {get() { throw new Error('Unexpected side effect'); }});
  const rows = Object.freeze([Object.freeze(event(2, 2, 'completed', {title: 'Private title', task: 't_12345678', note: 'Private note'})), Object.freeze(event(1, 1))]);
  const seen = Object.freeze([id(1)]), r = recap(rows, seen);
  const encoded = R.encodeSeen(R.acknowledge(rows, seen, H));
  assert(!encoded.includes('Private')); assert(!encoded.includes('t_12345678'));
  assert(!JSON.stringify(r).includes('Private')); equal(seen, [id(1)]);
  assert.throws(() => R.summarize({events: rows}, {}), /eventOrder\/eventKey/);
});
test('weekly is backend-only: 0 and 7 known, absent/null/invalid unknown', () => {
  for (const days of [0, 3, 7]) {
    const w = R.weekly({done_days_7d: days}); assert.equal(w.days, days);
    assert.equal(w.text, `${days} of last 7 days had completed work.`);
  }
  for (const days of [undefined, null, -1, 8, 1.5, '4', false, NaN]) {
    assert.equal(R.weekly({done_days_7d: days}).days, null); assert.equal(R.weekly({done_days_7d: days}).status, 'unknown');
  }
});
test('reducer keeps existing counters with A omitted, null or malformed; valid weekly replaced not accumulated', () => {
  const G = mk(), base = {wins_today: 2, xp: 120, gold: 12, level: 2, level_progress: 20};
  let at = 1700003000;
  const push = progress => G.mergeDelta({events: [], tasks: [], bots: [], cursor: 'demo',
    working: {as_of: ++at, items: [], resting_count: 0, progress}});
  push(base); equal(G.S.work.progress(), {...base, source: 'backend'});
  for (const days of [0, 7, 3, null, 8, -1, '3', 1.5]) {
    push({...base, done_days_7d: days}); const p = G.S.work.progress();
    for (const key of Object.keys(base)) assert.equal(p[key], base[key]);
    assert.equal(p.done_days_7d, [0, 7, 3].includes(days) ? days : null);
  }
  push(base); assert.equal(G.S.work.progress().done_days_7d, undefined);
  assert.equal(R.weekly(G.S.work.progress()).status, 'unknown');
  push({...base, done_days_7d: 4}); G.reset(G.D.meta.from_); assert.equal(G.S.work.progress().done_days_7d, 4);
  const snap = {...demo(), working: {as_of: ++at, items: [], progress: base}};
  G.loadReplay(snap); equal(G.S.work.progress(), {...base, source: 'backend'});
  G.loadReplay(demo()); assert.equal(R.weekly(G.S.work.progress()).status, 'unknown');
});
console.log(`PASS ${n} idle recap cases`);
