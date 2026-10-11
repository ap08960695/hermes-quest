'use strict';
// Guildhall tier model (pure). Synthetic inputs only; no browser, no game boot.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const city = require('../quest/idle-city.js');
const cases = [];
const test = (name, f) => cases.push({name, f});

test('tier boundaries: 0/1/4/5/9/10 and beyond', () => {
  const expect = {0: null, 1: 1, 2: 1, 4: 1, 5: 2, 6: 2, 9: 2, 10: 3, 11: 3, 99: 3, 1e6: 3};
  for (const [lv, tier] of Object.entries(expect)) {
    const r = city.tierForLevel(Number(lv));
    assert.equal(r.known, true, 'level ' + lv);
    assert.equal(r.tier, tier, 'level ' + lv);
  }
  assert.equal(city.tierForLevel(0).reason, 'below-first-tier');
  assert.equal(city.tierForLevel(1).reason, 'ok');
});

test('unknown level never guesses a tier', () => {
  for (const bad of [undefined, null, NaN, Infinity, -Infinity, -1, 1.5, '5', '', [], {}, true, 2 ** 60, 5n]) {
    const r = city.tierForLevel(bad);
    assert.equal(r.known, false, String(typeof bad) + ':' + String(bad));
    assert.equal(r.tier, null);
    assert.equal(r.level, null);
    const m = city.guildhallModel(bad, []);
    assert.equal(m.known, false);
    assert.equal(m.tier, null);
    assert.deepEqual([...m.decorations], []);
    assert.match(m.label, /Level unknown/);
  }
});

test('monotonic: tier never decreases as level rises and decorations only accumulate', () => {
  let prevTier = 0, prevDeco = 0;
  for (let lv = 0; lv <= 40; lv++) {
    const m = city.guildhallModel(lv, []);
    assert.ok((m.tier ?? 0) >= prevTier, 'tier dropped at ' + lv);
    assert.ok(m.decorations.length >= prevDeco, 'decorations dropped at ' + lv);
    prevTier = m.tier ?? 0; prevDeco = m.decorations.length;
  }
});

test('deterministic: same level, same output, any order and any repeat', () => {
  const seq = [10, 1, 5, 0, 10, 4, 9, 1];
  const first = seq.map(lv => JSON.stringify(city.guildhallModel(lv, [])));
  const again = [...seq].reverse().map(lv => JSON.stringify(city.guildhallModel(lv, []))).reverse();
  assert.deepEqual(first, again);
  // No hidden state, clock or RNG: poison them and compare.
  const {random, now} = {random: Math.random, now: Date.now};
  Math.random = () => { throw new Error('RNG used'); };
  Date.now = () => { throw new Error('clock used'); };
  try { assert.deepEqual(seq.map(lv => JSON.stringify(city.guildhallModel(lv, []))), first); }
  finally { Math.random = random; Date.now = now; }
});

test('labels and details name Guildhall and Level and the next threshold', () => {
  const m1 = city.guildhallModel(1, []), m5 = city.guildhallModel(5, []), m10 = city.guildhallModel(10, []), m0 = city.guildhallModel(0, []);
  assert.equal(m1.label, 'Guildhall \u00b7 Level 1');
  assert.match(m1.detail, /Tier 1 of 3/); assert.match(m1.detail, /next tier at Guild level 5/);
  assert.match(m5.detail, /Tier 2 of 3/); assert.match(m5.detail, /next tier at Guild level 10/);
  assert.match(m10.detail, /Tier 3 of 3/); assert.match(m10.detail, /final tier/);
  assert.equal(m10.next_level, null);
  assert.equal(m0.tier, null); assert.match(m0.detail, /first tier at Guild level 1/);
  assert.equal(m0.known, true);
  for (const m of [m0, m1, m5, m10]) assert.equal(m.title, 'Guildhall');
});

test('decorations use only existing assets/px sprites and grow by tier', () => {
  const sizes = [0, 1, 5, 10].map(lv => city.guildhallModel(lv, []).decorations.length);
  assert.deepEqual(sizes, [0, 0, 2, 6]);
  const meta = JSON.parse(fs.readFileSync(path.join(root, 'assets/px/props/meta.json'), 'utf8'));
  for (const d of city.guildhallModel(10, []).decorations) {
    assert.equal(d.src, 'props');
    assert.ok(fs.existsSync(path.join(root, 'assets/px', d.src, d.img + '.png')), d.img + '.png missing');
    assert.ok(meta[d.img], d.img + ' not in props/meta.json');
    assert.ok(Number.isInteger(d.dx) && Number.isInteger(d.dy));
  }
  const a = city.ANCHOR;
  assert.ok(fs.existsSync(path.join(root, 'assets/px', a.src, a.img + '.png')));
  // Tier 2 decorations stay present in tier 3.
  const t2 = JSON.stringify(city.guildhallModel(5, []).decorations), t3 = city.guildhallModel(10, []).decorations;
  for (const d of JSON.parse(t2)) assert.ok(t3.some(x => JSON.stringify(x) === JSON.stringify(d)));
});

test('anchor comes from the real world.json castle prop, read-only', () => {
  const world = JSON.parse(fs.readFileSync(path.join(root, 'data/world.json'), 'utf8'));
  const before = JSON.stringify(world);
  const m = city.guildhallModel(10, world.props);
  assert.equal(JSON.stringify(world), before, 'world mutated');
  const castle = world.props.find(p => p.src === 'buildings' && p.img === 'castle');
  assert.deepEqual({...m.anchor}, {x: castle.x, y: castle.y, w: castle.w, h: castle.h});
  assert.equal(city.guildhallModel(10, undefined).anchor, null);
  assert.equal(city.guildhallModel(10, [{img: 'castle', src: 'buildings', x: 'a', y: 1}]).anchor, null);
  assert.equal(city.guildhallModel(10, [null, 7, {}]).anchor, null);
});

test('inputs are not mutated, even when deep-frozen', () => {
  const props = Object.freeze([Object.freeze({img: 'castle', src: 'buildings', x: 1, y: 2, w: 3, h: 4})]);
  assert.doesNotThrow(() => city.guildhallModel(10, props));
  assert.throws(() => { 'use strict'; city.TIERS[0].min_level = 99; }, TypeError);
  assert.throws(() => { 'use strict'; city.guildhallModel(10, []).decorations.push(1); }, TypeError);
  assert.equal(city.tierForLevel(1).tier, 1);
});

test('classic-script registration works in a bare vm and does not touch the page', () => {
  const box = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(root, 'quest/idle-city.js'), 'utf8'), box, {filename: 'quest/idle-city.js'});
  assert.equal(vm.runInContext('QuestIdleCity.tierForLevel(5).tier', box), 2);
  assert.deepEqual(Object.keys(box), ['QuestIdleCity']);
});

let failed = 0;
for (const c of cases) {
  try { c.f(); console.log('ok   ' + c.name); }
  catch (e) { failed++; console.log('FAIL ' + c.name + '\n' + (e && e.stack || e)); }
}
console.log(failed ? `FAIL ${failed}/${cases.length}` : `PASS ${cases.length}/${cases.length}`);
process.exit(failed ? 1 : 0);
