'use strict';
// Working view D: event-linked order courier, victory/loot and Inn ambience. Synthetic data only; runs the shipped scripts.
// Browser/raster/60 s hidden-tab gates are not claimed here.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const vm = require('node:vm');
const {load: loadGame} = require('./parity/loader.cjs');
// game.js's facade export list is owned by the integration card, so capture the real social service as the shipped
// scripts register it (same module code, same per-game ctx) and expose its hooks next to the facade.
function load(opts) {
  let social = null; const createContext = vm.createContext;
  vm.createContext = box => {
    let real; const mods = {};
    Object.defineProperty(mods, 'createSocial', {configurable: true, get: () => ctx => (social = real(ctx)), set: v => { real = v; }});
    box.HQModules = mods; return createContext(box);
  };
  try { var out = loadGame(opts); } finally { vm.createContext = createContext; }
  const G = out.G;
  for (const k of ['onOrder', 'onComplete', 'innAmbient']) Object.defineProperty(G, k, {configurable: true, get: () => social[k]});
  return out;
}
const demo = JSON.parse(fs.readFileSync(path.join(root, 'data/demo.json'), 'utf8'));
const copy = x => JSON.parse(JSON.stringify(x));
const cases = [];
const test = (name, f) => cases.push({name, f});

// No events: nothing is working, so every movement in the scene must come from the hooks or the Inn ambience.
function game({working = {as_of: '2026-01-01T00:00:00Z', items: [], resting_count: 0, latest_order: null, progress: {}}, seed = 3} = {}) {
  const data = copy(demo); data.events = []; data.tasks = [];
  if (working) data.working = working; else delete data.working;
  const {G, timers} = load({root, data, seed});
  G.S.speed = 120; G.S.play = false; G.reset(data.meta.from_);
  const step = (sec, each = () => {}) => {
    const dt = 1 / 60;
    for (let i = 0; i < Math.round(sec / dt); i++) {
      G.update(dt);
      for (let j = timers.length - 1; j >= 0; j--) if ((timers[j][0] -= dt) <= 0) { const f = timers[j][1]; timers.splice(j, 1); f(); }
      each(i * dt);
    }
  };
  return {G, step, data};
}
const counts = G => ({heroes: Object.keys(G.S.heroes).length, tasks: Object.keys(G.S.tasks).length, vault: G.S.vault, xp: G.S.xp, gold: G.S.gold, mana: JSON.stringify(G.S.mana)});
const kinds = G => G.S.fx.map(f => f.k);
const cap = G => G.S.heroes[G.D.meta.captain];
const smith = 'demo-smith';

test('hooks are exposed on the social service with the documented signature', () => {
  const {G} = game();
  assert.equal(typeof G.onOrder, 'function'); assert.equal(typeof G.onComplete, 'function');
});

test('one order -> one courier scroll and one acknowledgement; repeat delivery plays nothing', () => {
  const {G, step} = game(), before = counts(G);
  const order = {at: '2026-01-01T00:00:01Z', action_label: 'Assigned', quest_label: 'Build the forge door', bot: smith};
  assert.equal(G.onOrder(order), true);
  const scrolls = G.S.fx.filter(f => f.k === 'raven' && f.icon === '📜'); assert.equal(scrolls.length, 1);
  assert.ok(scrolls[0].life >= 1.2 && scrolls[0].life <= 3.2);
  assert.equal(G.S.soc.couriers, 1); assert.equal(G.S.feed.length, 1);
  assert.equal(G.onOrder({...order}), false);                 // poll re-delivers the same order
  assert.equal(G.S.fx.filter(f => f.icon === '📜').length, 1); assert.equal(G.S.feed.length, 1);
  step(scrolls[0].life + .2);
  assert.match(G.S.heroes[smith].bubble.text, /Build the forge door/);
  assert.equal(G.S.soc.couriers, 1);
  G.reset(G.D.meta.from_); assert.equal(G.onOrder({...order}), false);   // rebase/scrub does not reset the dedupe
  assert.equal(G.S.fx.filter(f => f.icon === '📜').length, 0);
  assert.deepEqual(counts(G), before);                          // no fake hero/task/xp/gold/mana
});

test('order: replay (animate:false), unknown recipient, resting recipient and malformed input play nothing and invent nothing', () => {
  const {G} = game(), before = counts(G), fx0 = G.S.fx.length;
  assert.equal(G.onOrder({at: 1, bot: smith, action_label: 'Assigned'}, {animate: false}), false);
  assert.equal(G.onOrder({at: 1, bot: smith, action_label: 'Assigned'}), false);   // key already consumed by the silent pass
  assert.equal(G.onOrder({at: 2, bot: 'nobody'}), false);
  assert.equal(G.onOrder({at: 3, recipient_display_name: 'No Such Hero'}), false);
  assert.equal(G.onOrder(null), false); assert.equal(G.onOrder({}), false); assert.equal(G.onOrder('x'), false);
  G.apply({id: 'p', t: 1, kind: 'pause', bot: smith, why: 'limited'}, false);
  assert.equal(G.onOrder({at: 4, bot: smith}), false);
  assert.equal(G.S.fx.length, fx0); assert.deepEqual(counts(G), before);
});

test('order resolves a recipient by unique display name and clamps the label to 30 graphemes', () => {
  const {G} = game(), name = G.S.heroes[smith].name;
  assert.equal(G.onOrder({at: 9, recipient_display_name: name, quest_label: 'x'.repeat(80)}), true);
  assert.ok(G.S.feed[0].html.length < 200);
  assert.ok(!G.S.feed[0].html.includes('x'.repeat(31)));
});

test('one completion -> one victory/loot set; duplicate, replay and non-done statuses earn and play nothing', () => {
  const {G} = game(), before = counts(G);
  assert.equal(G.onComplete({ref: 'r1', status: 'done', bot: smith, quest_label: 'Build the forge door'}), true);
  const k = kinds(G);
  assert.equal(k.filter(x => x === 'coin').length, 8); assert.ok(G.S.fx.some(f => f.k === 'num' && f.text === 'QUEST CLEAR!'));
  assert.equal(G.S.fx.filter(f => f.k === 'num' && f.text === 'QUEST CLEAR!').length, 1);
  assert.equal(G.S.soc.victories, 1); assert.equal(G.S.feed.length, 1);
  const n = G.S.fx.length;
  assert.equal(G.onComplete({ref: 'r1', status: 'done'}), false); assert.equal(G.S.fx.length, n);
  G.reset(G.D.meta.from_); assert.equal(G.onComplete({ref: 'r1', status: 'done'}), false);   // rebase/scrub does not reset the dedupe
  assert.equal(G.S.fx.length, 0);
  for (const status of ['failed', 'blocked', 'archived', 'running', 'unknown']) assert.equal(G.onComplete({ref: 'bad-' + status, status}), false);
  assert.equal(G.onComplete({ref: 'silent', status: 'done'}, {animate: false}), false);
  assert.equal(G.onComplete({ref: 'silent', status: 'done'}), false);
  assert.equal(G.onComplete(null), false); assert.equal(G.onComplete({status: 'done'}), false);
  assert.equal(G.S.fx.length, 0); assert.equal(G.S.soc.victories || 0, 0);   // reset cleared soc; nothing re-played
  assert.deepEqual(counts(G), before);                          // the reducer (card B) owns XP/gold/vault; the FX never add any
});

test('no running work: Inn ambience gives a meaningful effect in every 5 s window for 60 s, with no fake counters', () => {
  const {G, step} = game(), before = counts(G), seen = [];
  const known = new Set();
  step(60, t => { for (const f of G.S.fx) if (f.src === 'inn' && !known.has(f)) { known.add(f); seen.push(t); } });
  assert.ok(seen.length >= 15, 'beats: ' + seen.length);
  let gap = seen[0]; for (let i = 1; i < seen.length; i++) gap = Math.max(gap, seen[i] - seen[i - 1]);
  gap = Math.max(gap, 60 - seen[seen.length - 1]);
  assert.ok(gap <= 5, 'longest still gap ' + gap.toFixed(2));
  for (let w = 0; w < 12; w++) assert.ok(seen.some(t => t >= w * 5 && t < (w + 1) * 5), 'dead 5 s window ' + w);
  assert.deepEqual(counts(G), before);
  assert.equal(G.S.soc.couriers || 0, 0); assert.equal(G.S.soc.victories || 0, 0);
});

test('Inn ambience is off without a Working block, so the legacy scene is unchanged', () => {
  const {G, step} = game({working: null});
  step(20); assert.ok(!G.S.fx.some(f => f.src === 'inn')); assert.equal(G.S.soc.innBeats || 0, 0);
});

test('Inn ambience: calm mode trims particles; missing inn geometry is a no-op', () => {
  const {G, step} = game(); G.calm = true; step(20); assert.ok(G.S.soc.innBeats >= 5);
  const g2 = game(); delete g2.G.W.regions.inn; g2.step(10); assert.equal(g2.G.S.soc.innBeats || 0, 0);
});

test('with card B reducer present: baseline silent, one real order/done fires once, repeat poll silent (skipped on a base without S.work)', () => {
  const {G, data} = game({working: null}); if (!G.S.work) { console.log('SKIP reducer integration: S.work not in this base'); return; }
  const T = 1900000000, name = G.S.heroes[smith].name;
  const it = (ref, status) => ({ref, status, started_at: T, display_name: name, class_label: 'Mage', quest_label: 'Build door', quest_kind: 'build', group_label: 'A', parent_ref: null, worker_observed: true});
  const snap = (t, items, o) => ({as_of: t, items, resting_count: 0, latest_order: o || null});
  const delta = w => ({events: [], tasks: [], bots: [], cursor: 'c' + w.as_of, working: w});
  const ord = {at: T + 9, action_label: 'Assigned', quest_label: 'Build door', recipient_display_name: name};
  G.liveFeed = true; G.following = true; G.S.play = true; G.update(1 / 60);
  G.loadReplay({...copy(data), working: snap(T, [it('a', 'done')])}, {t: 0, keys: new Set()}); G.update(1 / 60);
  assert.equal(G.S.fx.filter(f => f.k === 'coin').length, 0);                       // baseline: finished work does not fire
  G.mergeDelta(delta(snap(T + 10, [it('a', 'done'), it('b', 'running')], ord)));
  assert.equal(G.S.fx.filter(f => f.icon === '📜').length, 1);
  G.S.fx.length = 0; G.mergeDelta(delta(snap(T + 20, [it('a', 'done'), it('b', 'done')], ord)));
  assert.equal(G.S.fx.filter(f => f.k === 'coin').length, 8); assert.equal(G.S.fx.filter(f => f.text === 'QUEST CLEAR!').length, 1);
  G.S.fx.length = 0; G.mergeDelta(delta(snap(T + 30, [it('a', 'done'), it('b', 'done')], ord)));
  assert.equal(G.S.fx.filter(f => f.k === 'coin' || f.icon === '📜').length, 0);
});

(async () => {
  let failed = 0;
  for (const {name, f} of cases) { try { await f(); console.log('PASS ' + name); } catch (e) { failed++; console.error('FAIL ' + name + '\n' + e.stack); } }
  console.log(JSON.stringify({tests: cases.length, passed: cases.length - failed, failed, notRun: ['browser/raster', 'hidden-tab 60 s', 'merged-branch integration is only exercised when S.work exists']}));
  process.exitCode = failed ? 1 : 0;
})();
