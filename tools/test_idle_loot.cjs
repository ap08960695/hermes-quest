'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const box = vm.createContext({});
// Any accidental ambient randomness, clock, storage, network or timers fails the test.
vm.runInContext(`Math.random = () => { throw Error('No RNG'); };
  Date = class { constructor() { throw Error('No clock'); } static now() { throw Error('No clock'); } };
  for (const key of ['localStorage', 'fetch', 'setTimeout', 'setInterval'])
    Object.defineProperty(globalThis, key, {get() { throw Error('No side effects'); }});`, box);
vm.runInContext(fs.readFileSync(path.join(root, 'quest/idle-loot.js'), 'utf8'), box);
const {stageToken, stageTokens} = box.HQIdleLoot;
const plain = v => JSON.parse(JSON.stringify(v));
const kinds = ['planning', 'build', 'testing', 'review', 'deploy', 'verification', 'guild'];
const item = (quest_kind, ref = 'w-example') => ({ref, status: 'done', quest_kind});
const all = kinds.map((kind, i) => item(kind, 'w-example-' + i));
const frozenAll = Object.freeze(all.map(row => Object.freeze(row)));
const expected = kinds.map(kind => 'stage-' + kind);
assert.deepEqual(plain(stageTokens(frozenAll)).map(t => t.id), expected);
for (const row of all) {
  const token = stageToken(row);
  assert.equal(token.quest_kind, row.quest_kind);
  assert.match(token.label, /stage token$/);
  assert.match(token.condition, /current board/);
  assert.equal(Object.isFrozen(token), true);
  assert.throws(() => { token.label = 'changed'; }, TypeError);
  assert.deepEqual(plain(stageTokens([row, row, {...row}])).map(t => t.id), [token.id]);
}
for (const kind of [undefined, null, '', 'unknown', 'plan', 'test', 'verify', 'BUILD', ' build',
  'terminal', 'mana', 'token', 'toString', '__proto__', 'constructor', {}, 10]) {
  assert.equal(stageToken(item(kind)), null);
  assert.deepEqual(plain(stageTokens([item(kind)])), []);
}
for (const status of [undefined, null, 'running', 'blocked', 'failed', 'archived', 'unknown',
  'review', 'completed', 'Done', ' done']) {
  assert.equal(stageToken({...item('build'), status}), null);
}
for (const row of [undefined, null, [], 'done', 7, {}, {status:'done',quest_kind:'build'},
  ...[undefined, null, '', ' ', ' w-example', 'w-example ', 'x'.repeat(129), 7, {}]
    .map(ref => ({...item('build'), ref}))]) {
  assert.equal(stageToken(row), null);
  assert.deepEqual(plain(stageTokens([row])), []);
}
for (const bad of [undefined, null, {}, 'done', 7]) assert.deepEqual(plain(stageTokens(bad)), []);
const decoys = {ref:'w-decoy', status:'done', title:'Build quest', note:'planning', stage:'BUILD',
  tool:'testing', mana:100000, tokens:1000000, action_count:999, completed_at:999999};
assert.equal(stageToken(decoys), null);
assert.equal(stageToken({...decoys, status:'running', quest_kind:'build'}), null);
assert.deepEqual(plain(stageToken({...decoys, quest_kind:'build'})), plain(stageToken(item('build'))));
assert.doesNotMatch(JSON.stringify(stageTokens([{...decoys, quest_kind:'build'}])), /w-decoy|100000|999|Build quest/);
// One stage design even after many distinct completions, never a quantity reward.
assert.equal(stageTokens(Array.from({length:2000}, (_, i) => item('build', 'w-volume-' + i))).length, 1);
// Independent input permutations include duplicate and contradictory identities.
function* permutations(rows) {
  if (!rows.length) { yield []; return; }
  for (let i = 0; i < rows.length; i++)
    for (const rest of permutations(rows.filter((_, j) => i !== j))) yield [rows[i], ...rest];
}
let permutationsChecked = 0;
for (const rows of [
  [item('build'), item('build'), item('review','w-other'), item('guild','w-third')],
  [item('build'), {...item('build'),status:'running'}, item('review','w-other'), item('build')],
  [item('build'), item('testing'), item('review','w-other'), item('testing')],
  [item('build'), item('unknown'), item('review','w-other'), item('build')]
]) {
  const reference = plain(stageTokens(rows));
  for (const perm of permutations(rows)) {
    assert.deepEqual(plain(stageTokens(perm)), reference);
    permutationsChecked++;
  }
  if (rows[1].status !== 'done' || rows[1].quest_kind !== 'build')
    assert.deepEqual(reference.map(t => t.quest_kind), ['review']);
}
// Actual Working reducer snapshots: no hook/ledger/UI adapter needed.
vm.runInContext(fs.readFileSync(path.join(root, 'quest/state.js'), 'utf8'), box);
const state = box.HQModules.createState({});
const snapshot = (as_of, items, mode = 'delta') => {
  state.applyWork(state.planWork({as_of, items}, {mode}));
  return plain(stageTokens(state.S.work.items()));
};
const running = {...item('build'), status:'running'};
assert.deepEqual(snapshot(1, [running], 'rebase'), []);
const done = snapshot(2, [item('build')]);
assert.deepEqual(done.map(t => t.id), ['stage-build']);
assert.deepEqual(snapshot(2, [item('build')]), done); // repeated poll
assert.deepEqual(snapshot(1, [running]), done); // stale delta ignored by reducer
assert.deepEqual(snapshot(2, [item('build')], 'rebase'), done); // replay/rebase
assert.deepEqual(snapshot(3, [{...item('build'), status:'archived'}]), []);
assert.deepEqual(snapshot(4, [running]), []); // no permanent unlock claim
assert.deepEqual(snapshot(5, [item('build')]), done); // re-completion is same design
assert.deepEqual(snapshot(6, []), []);
// Fresh call after unrelated input reproduces exactly; caller cannot mutate catalog.
const result = stageTokens(all);
result.length = 0;
assert.deepEqual(plain(stageTokens(all)).map(t => t.id), expected);
assert.deepEqual(Object.keys(box.HQIdleLoot).sort(), ['stageToken', 'stageTokens']);
console.log('PASS idle loot: 7 kinds, invalid/status/identity gates, ' + permutationsChecked +
  ' order permutations, pure cosmetic collection, Working poll/replay/archive/reopen');
