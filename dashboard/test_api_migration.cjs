// Input is produced by actual mounted replay/events APIs in test_live_contract.py.
// No fabricated delta metadata. Exercise the production poll/normalization/rebase.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const root = path.resolve(__dirname, '..');
const fixture = JSON.parse(fs.readFileSync(0, 'utf8'));
const source = fs.readFileSync(path.join(root, 'game.js'), 'utf8').replace(/\nboot\(\);\s*$/, '\n');
const world = JSON.parse(fs.readFileSync(path.join(root, 'data/world.json')));
const copy = v => JSON.parse(JSON.stringify(v));
const noop = () => {}, elements = new Map();
const el = s => {
  if (!elements.has(s)) elements.set(s, {dataset: {}, style: {}, classList: {toggle: noop}, getContext: () => ({})});
  return elements.get(s);
};
const box = {console, URLSearchParams, AbortController, Date, Math, setTimeout: noop, clearTimeout: noop,
  requestAnimationFrame: noop, addEventListener: noop, performance: {now: () => 0},
  document: {querySelector: el, querySelectorAll: () => [], body: el('body')},
  window: {devicePixelRatio: 1}, world, initial: copy(fixture.initial)};
vm.createContext(box); vm.runInContext(source, box);
const run = s => vm.runInContext(s, box);
const state = () => run('JSON.stringify({D,checkpoint,cursor,S,keys:[...eventKeys],following,play:S.play})');
run('W=world; loadReplay(initial); reset(initial.meta.to); liveFeed=true; following=true; S.play=true;');
assert.strictEqual(run('captainId()'), fixture.initial.meta.captain);
assert.strictEqual(run('S.heroes[captainId()].cls'), 'commander');
assert(run('Object.values(S.tasks).some(t=>t.title.includes("Harmless old prose"))'));
(async () => {
  let requests = 0;
  for (const step of fixture.migrations) {
    box.delta = copy(step.delta); box.replay = copy(step.replay);
    run('S.feed=[{html:"STALE OLD PRIVATE PROSE"}]; S.fx=[{k:"old",life:10}];');
    const before = state(), oldCursor = run('cursor');
    let mode = 'http-failure';
    box.fetch = async url => {
      if (url.includes('events?')) {
        assert(url.endsWith(encodeURIComponent(oldCursor)) || mode === 'stable');
        return {ok: true, json: async () => copy(box.delta)};
      }
      requests++;
      if (mode === 'http-failure') return {ok: false, status: 503};
      if (mode === 'invalid-snapshot') return {ok: true, json: async () => ({cursor: 'BAD', events: []})};
      return {ok: true, json: async () => copy(box.replay)};
    };
    // Every config surface must request a clean replay without first committing
    // any delta cursor or changing current scene; retry failure is byte-stable.
    assert.throws(() => run('mergeDelta(delta)'), /identity changed/, step.case);
    assert.strictEqual(state(), before, step.case + ' guard');
    await run('pollEvents()');
    assert.strictEqual(state(), before, step.case + ' 503 rollback');
    assert.strictEqual(el('#connection').dataset.state, 'offline');
    mode = 'invalid-snapshot'; await run('pollEvents()');
    assert.strictEqual(state(), before, step.case + ' invalid rollback');
    // Reconstruction errors must also roll back the authoritative snapshot and
    // cursor (not just transport/shape failures). Use actual reset first.
    mode = 'success';
    run('var originalReset=reset; reset=(...args)=>{originalReset(...args);throw new Error("synthetic reset failure")};');
    await run('pollEvents()');
    run('reset=originalReset;');
    assert.strictEqual(state(), before, step.case + ' reset rollback');
    await run('pollEvents()');
    assert.strictEqual(run('cursor'), step.replay.cursor, step.case);
    assert.strictEqual(run('D.meta.config_revision'), step.replay.meta.config_revision);
    assert.strictEqual(run('captainId()'), step.replay.meta.captain);
    assert.strictEqual(run('Object.values(S.heroes).filter(h=>h.cls==="commander").length'), 1);
    assert.strictEqual(run('S.heroes[captainId()].home'), step.replay.meta.regions.commander);
    assert.strictEqual(run('S.feed.length'), 0); assert.strictEqual(run('S.fx.length'), 0);
    assert.strictEqual(run('following && S.play'), true);
    assert.strictEqual(el('#connection').dataset.state, 'online');
    const bots = JSON.parse(run('JSON.stringify(D.bots)'));
    for (const bot of step.replay.bots) {
      const actual = bots.find(b => b.id === bot.id);
      assert(actual, step.case + ' bot');
      assert.strictEqual(actual.cls, bot.cls, step.case + ' class');
      assert.strictEqual(actual.region, bot.region, step.case + ' region');
    }
    if (step.case === 'privacy-off') assert(!state().includes('Harmless old prose'));
    if (step.case === 'privacy-on') assert(state().includes('Harmless old prose'));
    console.log('PASS actual API -> production poll:', step.case, '503/invalid/reset rollback + recovery/one commander/cleared feed+fx');
  }
  // No config churn: real no-op delta does not request a replay or clear feed.
  box.delta = copy(fixture.stable);
  box.fetch = async url => {
    assert(url.includes('events?')); return {ok: true, json: async () => copy(box.delta)};
  };
  run('S.feed=[{html:"NEW SAFE FEEDBACK"}];');
  await run('pollEvents()');
  assert.strictEqual(run('S.feed[0].html'), 'NEW SAFE FEEDBACK');
  assert.strictEqual(run('cursor'), fixture.stable.cursor);
  assert.strictEqual(requests, fixture.migrations.length * 4);
  console.log(`PASS ${fixture.migrations.length} API config migrations, ${requests} replay attempts; unchanged config remains incremental`);
})().catch(e => {console.error(e); process.exitCode = 1;});
