'use strict';
// Guild milestones (levels 2/3/5) and trophy collection: pure functions, synthetic data only.
// Covers both paths (no career_xp -> "reached on this board"; career_xp -> permanent) before/at/after each
// threshold, unknown values, determinism and the no-"permanent"-wording rule. No UI/browser claim.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const prog = require('../quest/idle-progression.js');
const coll = require('../quest/idle-collection.js');
const cases = [];
const test = (name, f) => cases.push({name, f});
const copy = x => JSON.parse(JSON.stringify(x));
const board = (level, extra = {}) => ({wins_today: 0, xp: (level - 1) * 100, gold: 0, level, level_progress: 0, ...extra});
const reached = ev => ev.milestones.map(m => m.reached);
const unlocked = c => c.trophies.map(t => t.unlocked);
const BANNED = /permanent|forever|lifetime|all[- ]time|career/i;

test('exports are the documented API', () => {
  assert.deepEqual([...prog.MILESTONE_LEVELS], [2, 3, 5]);
  assert.equal(typeof prog.evaluate, 'function'); assert.equal(typeof coll.collection, 'function');
  assert.equal(coll.CATALOG.length, 3);
});

// ---- board path (no career_xp) ----
for (const [level, want] of [[1, [false, false, false]], [2, [true, false, false]], [3, [true, true, false]],
  [4, [true, true, false]], [5, [true, true, true]], [6, [true, true, true]], [40, [true, true, true]]]) {
  test(`board path: level ${level} -> ${want}`, () => {
    const ev = prog.evaluate(board(level));
    assert.equal(ev.mode, 'board'); assert.deepEqual(reached(ev), want);
    assert.equal(ev.reached_count, want.filter(Boolean).length);
    const c = coll.collection(board(level));
    assert.equal(c.mode, 'board'); assert.deepEqual(unlocked(c), want); assert.equal(c.unlocked_count, ev.reached_count);
  });
}

test('board path: before / at / after each threshold (level 1->2, 2->3, 4->5)', () => {
  for (const [lo, hi, idx] of [[1, 2, 0], [2, 3, 1], [4, 5, 2]]) {
    assert.equal(prog.evaluate(board(lo)).milestones[idx].reached, false);
    assert.equal(prog.evaluate(board(hi)).milestones[idx].reached, true);
    assert.equal(prog.evaluate(board(hi + 1)).milestones[idx].reached, true);
  }
});

test('board path: copy says "reached on this board" and never uses permanent wording', () => {
  for (const level of [1, 2, 3, 5, 9, null]) {
    const p = level === null ? {} : board(level), ev = prog.evaluate(p), c = coll.collection(p);
    const text = JSON.stringify([ev, c]).replace(/"(?:career_xp|permanent)"/g, '');   // keys/mode ids are not copy
    assert.ok(!BANNED.test(JSON.stringify([ev.note, c.note, ev.milestones.map(m => m.label), c.trophies.map(t => [t.label, t.name, t.condition])])), `banned wording at ${level}: ${text}`);
  }
  assert.equal(prog.evaluate(board(2)).milestones[0].label, 'Reached on this board');
  assert.equal(coll.collection(board(2)).trophies[0].label, 'Reached on this board');
  assert.match(prog.evaluate(board(2)).note, /archived or reopened/);
});

test('board path: a level drop (archive/reopen) is followed, not remembered, and nothing is stored', () => {
  const up = prog.evaluate(board(5)), down = prog.evaluate(board(2));
  assert.deepEqual(reached(up), [true, true, true]); assert.deepEqual(reached(down), [true, false, false]);
  assert.deepEqual(reached(prog.evaluate(board(5))), [true, true, true]);   // no hidden state between calls
});

test('board path: next milestone with remaining levels / XP', () => {
  assert.deepEqual(prog.evaluate(board(1, {xp: 30})).next, {id: 'guild-level-2', level: 2, xp_required: 100, reached: false, status: 'pending', label: 'Not reached yet', levels_remaining: 1, xp_remaining: 70});
  assert.equal(prog.evaluate(board(4, {xp: 350})).next.xp_remaining, 50);
  assert.equal(prog.evaluate(board(5)).next, null);
  assert.equal(coll.collection(board(3)).next.name, 'Guild Veteran');
  assert.equal(coll.collection(board(5)).next, null);
  // xp missing but level valid: milestone still decided from level, xp_remaining unknown (null, not 0)
  const ev = prog.evaluate({level: 2}); assert.equal(ev.next.xp_remaining, null); assert.equal(ev.xp, null);
});

// ---- permanent path (career_xp present) ----
for (const [xp, want] of [[0, [false, false, false]], [99, [false, false, false]], [100, [true, false, false]], [199, [true, false, false]],
  [200, [true, true, false]], [399, [true, true, false]], [400, [true, true, true]], [10000, [true, true, true]]]) {
  test(`permanent path: career_xp ${xp} -> ${want}`, () => {
    const ev = prog.evaluate({career_xp: xp});
    assert.equal(ev.mode, 'permanent'); assert.equal(ev.level, 1 + Math.floor(xp / 100)); assert.deepEqual(reached(ev), want);
    assert.deepEqual(unlocked(coll.collection({career_xp: xp})), want);
  });
}

test('permanent path: career_xp wins over a lower board level (archive/reopen cannot revoke)', () => {
  const p = board(1, {career_xp: 450});   // current snapshot dropped to level 1; lifetime total is level 5
  assert.deepEqual(reached(prog.evaluate(p)), [true, true, true]); assert.equal(prog.evaluate(p).mode, 'permanent');
  assert.equal(coll.collection(p).unlocked_count, 3);
  assert.equal(prog.evaluate(p).milestones[0].label, 'Earned');
  assert.equal(coll.collection(p).trophies[2].label, 'Earned');
});

test('permanent path: monotonic career_xp never un-earns; same input twice gives same output', () => {
  let prev = -1;
  for (const xp of [0, 50, 100, 100, 250, 250, 400, 900]) {
    const n = coll.collection({career_xp: xp}).unlocked_count; assert.ok(n >= prev); prev = n;
    assert.deepEqual(coll.collection({career_xp: xp}), coll.collection({career_xp: xp}));
  }
});

test('permanent path: remaining XP is measured from career_xp', () => {
  const ev = prog.evaluate({career_xp: 150, level: 1, xp: 10});
  assert.equal(ev.xp, 150); assert.equal(ev.next.level, 3); assert.equal(ev.next.xp_remaining, 50); assert.equal(ev.next.levels_remaining, 1);
});

// ---- unknown values ----
test('unknown: no progress / bad shapes -> unknown, never false or zero', () => {
  for (const p of [undefined, null, {}, [], 'x', 7, {level: null}, {level: 'two'}, {level: 0}, {level: -1}, {level: 1.5}, {level: NaN},
    {level: Infinity}, {level: 2 ** 60}, {level: undefined, xp: 500}, {career_xp: null}, {career_xp: -1}, {career_xp: 1.5}, {career_xp: '400'},
    {career_xp: NaN}, {career_xp: Infinity}, {career_xp: 2 ** 60}]) {
    const ev = prog.evaluate(p), c = coll.collection(p);
    assert.equal(ev.mode, 'unknown', JSON.stringify(p)); assert.equal(ev.level, null); assert.equal(ev.next, null); assert.equal(ev.reached_count, null);
    assert.deepEqual(reached(ev), [null, null, null]); assert.deepEqual(unlocked(c), [null, null, null]); assert.equal(c.unlocked_count, null);
    assert.ok(ev.milestones.every(m => m.status === 'unknown' && m.label === 'Unknown'));
    assert.ok(c.trophies.every(t => t.status === 'unknown'));
    assert.ok(!BANNED.test(ev.note + c.note));
  }
});

test('unknown career_xp falls back to the board path when level is valid (missing != zero)', () => {
  for (const career_xp of [undefined, null, -5, 'abc', 1.2]) {
    const ev = prog.evaluate(board(3, {career_xp})); assert.equal(ev.mode, 'board'); assert.deepEqual(reached(ev), [true, true, false]);
  }
  assert.equal(prog.evaluate({career_xp: 0, level: 5}).mode, 'permanent');   // 0 is a real value
  assert.deepEqual(reached(prog.evaluate({career_xp: 0, level: 5})), [false, false, false]);
});

// ---- purity / contract ----
test('inputs are not mutated and outputs do not alias the input', () => {
  const p = Object.freeze(board(3)), before = copy(p);
  const ev = prog.evaluate(p); coll.collection(p);
  assert.deepEqual(p, before); ev.milestones[0].reached = null; assert.equal(prog.evaluate(p).milestones[0].reached, true);
});

test('trophy catalog is fixed: 3 unique ids, English name + condition, tied to milestone ids', () => {
  const c = coll.collection(board(5));
  assert.equal(new Set(c.trophies.map(t => t.id)).size, 3);
  assert.deepEqual(c.trophies.map(t => t.id), ['trophy-guild-level-2', 'trophy-guild-level-3', 'trophy-guild-level-5']);
  for (const t of c.trophies) { assert.match(t.name, /^[A-Za-z ]+$/); assert.match(t.condition, /^Guild reaches level \d$/); }
});

test('works with the real reducer progress object (existing level/xp, no new counter)', () => {
  const state = fs.readFileSync(path.join(root, 'quest/state.js'), 'utf8');
  assert.match(state, /'wins_today', 'xp', 'gold', 'level', 'level_progress'/);   // field names this module consumes
  const p = {wins_today: 1, xp: 230, gold: 23, level: 3, level_progress: 30};
  assert.deepEqual(reached(prog.evaluate({...p, source: 'backend'})), [true, true, false]);
});

test('source is pure: no storage, clock, randomness, network, DOM or console', () => {
  for (const f of ['quest/idle-progression.js', 'quest/idle-collection.js']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8').replace(/\/\*[\s\S]*?\*\//, '').replace(/\/\/.*$/gm, '');
    assert.ok(!/localStorage|sessionStorage|Date\b|Math\.random|fetch\(|document\.|XMLHttpRequest|console\.|setTimeout|setInterval/.test(src), f);
  }
});

test('loads as a classic browser script (globals) in load order, with and without progression first', () => {
  const read = f => fs.readFileSync(path.join(root, f), 'utf8');
  const box = vm.createContext({}); box.window = box;
  vm.runInContext(read('quest/idle-progression.js'), box); vm.runInContext(read('quest/idle-collection.js'), box);
  assert.equal(box.QuestIdleCollection.collection(board(3)).unlocked_count, 2);
  assert.equal(box.QuestIdleProgression.evaluate(board(3)).mode, 'board');
  const bare = vm.createContext({}); bare.window = bare;
  assert.throws(() => vm.runInContext(read('quest/idle-collection.js'), bare), /idle-progression/);
});

test('determinism: 200 mixed inputs evaluate identically twice', () => {
  const inputs = [];
  for (let i = 0; i < 200; i++) inputs.push(i % 3 === 0 ? {career_xp: i * 7} : i % 3 === 1 ? board(1 + (i % 8)) : {level: i % 2 ? 'x' : null});
  const run = () => JSON.stringify(inputs.map(p => [prog.evaluate(p), coll.collection(p)]));
  assert.equal(run(), run());
});

let failed = 0;
for (const {name, f} of cases) {
  try { f(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n' + (e && e.stack || e)); }
}
console.log(`${cases.length - failed}/${cases.length} passed`);
if (failed) process.exit(1);
