// Input is produced by actual mounted replay/events APIs in test_live_contract.py.
// No fabricated delta metadata. Exercise the production poll/normalization/rebase.
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const root = path.resolve(__dirname, '..');
const fixture = JSON.parse(fs.readFileSync(0, 'utf8'));
const {createClient} = require('../tools/parity/loader.cjs');
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
vm.createContext(box);
const connected = require('./ui_test_support.cjs')(box, el);
const {run} = createClient({root, sandbox: box});
const state = () => run('JSON.stringify({D,checkpoint,cursor,S,keys:[...eventKeys],following,play:S.play,privacyPending})');
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
    // The direct guard is non-mutating. A poll discovering config churn must
    // revoke old prose/scene immediately, even when replay retrieval fails.
    assert.throws(() => run('mergeDelta(delta)'), /identity changed/, step.case);
    assert.strictEqual(state(), before, step.case + ' guard');
    await run('pollEvents()');
    const prior = JSON.parse(before), failed = JSON.parse(state());
    const safeData = copy(prior.D);
    // Campaign names are prose too: fail-closed revocation must remove them.
    for (const task of safeData.tasks) {task.title = task.id; task.campaign = 'misc'; delete task.note;}
    for (const bot of safeData.bots) bot.name = bot.id;
    for (const event of safeData.events) {delete event.title; delete event.note;}
    const safeExpected = copy(prior);
    safeExpected.D = safeData; safeExpected.checkpoint = null; safeExpected.privacyPending = true;
    // Exact safe rollback snapshot: only revoked prose and the old scene change.
    Object.assign(safeExpected.S, {i:0, heroes:{}, tasks:{}, fx:[], feed:[], vault:0,
      trauma:0, stop:0, lastFeed:{}, soc:{}, later:[], rt:0, mana:{claude:100,codex:100,agy:100},
      tokenNetByBot:{},tokenNetByWallet:Object.fromEntries(['claude','codex','agy'].map(w=>[w,{net:0,hasCharsEstimate:false,hasUsageCorrection:false}])),diagnostics:{}});
    assert.deepStrictEqual(failed, safeExpected, step.case + ' exact fail-closed rollback snapshot');
    assert.deepStrictEqual(failed.D, safeData, step.case + ' preserves all non-prose replay fields');
    assert.strictEqual(failed.cursor, prior.cursor, step.case + ' cursor rollback');
    assert.deepStrictEqual(failed.keys, prior.keys, step.case + ' dedup rollback');
    assert.strictEqual(failed.following, prior.following);
    for (const field of ['t', 'play', 'speed']) assert.strictEqual(failed.S[field], prior.S[field]);
    assert.strictEqual(failed.checkpoint, null, 'old scene checkpoint cannot retain prose');
    assert.strictEqual(failed.privacyPending, true);
    for (const field of ['heroes', 'tasks', 'lastFeed', 'soc']) assert.deepStrictEqual(failed.S[field], {});
    for (const field of ['fx', 'feed', 'later']) assert.deepStrictEqual(failed.S[field], []);
    assert(!state().includes('Harmless old prose') && !state().includes('STALE OLD PRIVATE PROSE'));
    const safeBefore = state();
    assert(connected('offline'));
    mode = 'invalid-snapshot'; await run('pollEvents()');
    assert.strictEqual(state(), safeBefore, step.case + ' invalid safe rollback');
    // Reconstruction errors must also roll back the authoritative snapshot and
    // cursor (not just transport/shape failures). Use actual reset first.
    mode = 'success';
    run('var originalReset=reset; reset=(...args)=>{originalReset(...args);throw new Error("synthetic reset failure")};');
    await run('pollEvents()');
    run('reset=originalReset;');
    assert.strictEqual(state(), safeBefore, step.case + ' reset safe rollback');
    await run('pollEvents()');
    assert.strictEqual(run('cursor'), step.replay.cursor, step.case);
    assert.strictEqual(run('D.meta.config_revision'), step.replay.meta.config_revision);
    assert.strictEqual(run('captainId()'), step.replay.meta.captain);
    const captain = step.replay.bots.find(b => b.id === step.replay.meta.captain);
    assert(captain, step.case + ' authoritative captain metadata');
    // Filtering configured profiles may retain the captain only as an actor.
    // Identity still migrates, but actor metadata must never create a hero.
    const captainIsProfile = captain.entity_type !== 'actor';
    assert.strictEqual(run('Object.values(S.heroes).filter(h=>h.cls==="commander").length'),
      captainIsProfile ? 1 : 0, step.case + ' profile-only commander');
    if (captainIsProfile) assert.strictEqual(run('S.heroes[captainId()].home'), step.replay.meta.regions.commander);
    else assert.strictEqual(run('S.heroes[captainId()]'), undefined, step.case + ' actor captain has no hero');
    for (const actor of step.replay.bots.filter(b => b.entity_type === 'actor'))
      assert.strictEqual(run(`S.heroes[${JSON.stringify(actor.id)}]`), undefined, step.case + ' actor has no hero');
    assert.strictEqual(run('S.feed.length'), 0); assert.strictEqual(run('S.fx.length'), 0);
    assert.strictEqual(run('following && S.play'), true);
    assert.strictEqual(run('privacyPending'), false);
    assert(connected('online'));
    const bots = JSON.parse(run('JSON.stringify(D.bots)'));
    for (const bot of step.replay.bots) {
      const actual = bots.find(b => b.id === bot.id);
      assert(actual, step.case + ' bot');
      assert.strictEqual(actual.cls, bot.cls, step.case + ' class');
      assert.strictEqual(actual.region, bot.region, step.case + ' region');
    }
    if (step.case === 'privacy-off') assert(!state().includes('Harmless old prose'));
    if (step.case === 'privacy-on') assert(state().includes('Harmless old prose'));
    if (step.case === 'key-rotation') {
      const expected = step.replay.events.filter(e => e.kind === 'mana').reduce((n, e) => n + e.tokens, 0);
      assert.strictEqual(run('Object.values(S.tokenNetByWallet).reduce((n,w)=>n+w.net,0)'), expected,
        'identity rebase replaces old mana rather than charging twice');
    }
    console.log('PASS actual API -> production poll:', step.case, '503/invalid/reset rollback + recovery/profile-only commander/cleared feed+fx');
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
