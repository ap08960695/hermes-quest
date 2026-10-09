'use strict';
// Node test for the live-stale warning: drives the production pollEvents()/pollFailed() with a fake
// fetch and checks the indicator state, reasons, recovery and that no payload/cursor/URL is shown.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'game.js'), 'utf8').replace(/\nboot\(\);\s*$/, '\n');
const world = JSON.parse(fs.readFileSync(path.join(root, 'data/world.json')));
const demo = JSON.parse(fs.readFileSync(path.join(root, 'data/demo.json')));
const noop = () => {}, elements = new Map();
const el = s => {
  if (!elements.has(s)) elements.set(s, {dataset: {}, style: {}, classList: {toggle: noop}, getContext: () => ({})});
  return elements.get(s);
};
const box = {console, URLSearchParams, AbortController, Date, Math, setTimeout: noop, clearTimeout: noop,
  requestAnimationFrame: noop, addEventListener: noop, performance: {now: () => 0},
  document: {querySelector: el, querySelectorAll: () => [], body: el('body')},
  window: {devicePixelRatio: 1}, world, initial: JSON.parse(JSON.stringify(demo))};
vm.createContext(box);
require('../dashboard/ui_test_support.cjs')(box, el);
vm.runInContext(source, box);
const run = s => vm.runInContext(s, box);
run('W=world; loadReplay(initial); reset(initial.meta.to); liveFeed=true; following=true; S.play=true;');

// Capture what the game hands to the UI instead of re-implementing the UI.
const calls = [];
box.calls = calls;
run('var realConnection = connection; connection = (text, state, extra) => { calls.push({text, state, extra}); realConnection(text, state, extra); }');
let mode = 'ok', seq = 0;
box.fetch = async url => {
  if (mode === 'network') throw new TypeError('Failed to fetch SECRET_CURSOR_CANARY');
  if (typeof mode === 'number') return {ok: false, status: mode, json: async () => ({detail: 'PAYLOAD_CANARY'})};
  seq++;
  return {ok: true, json: async () => ({state: 'online', events: [], tasks: [], bots: [], cursor: 'c' + seq})};
};
const poll = async next => { mode = next; calls.length = 0; await run('pollEvents()'); return calls.at(-1); };
const playbackProbe = () => run('JSON.stringify([S.speed, S.play, following, cam.tx, cam.ty, cam.zi])');

(async () => {
  let last = await poll('ok');
  assert.equal(last.state, 'online');
  assert.equal(run('pollFailures'), 0);
  const probe = playbackProbe();

  // Transient failures stay "Offline" until the third consecutive one.
  for (const failure of [503, 'network', 500]) {
    run('pollFailures = 0');
    assert.equal((await poll(failure)).state, 'offline', 'failure 1');
    assert.equal((await poll(failure)).state, 'offline', 'failure 2');
    last = await poll(failure);
    assert.equal(last.state, 'stale', 'failure 3 must warn: ' + failure);
    assert(last.text.startsWith('Live paused · not updating · last update '), last.text);
    assert.equal(last.extra.reason, failure === 'network' ? 'offline' : 'server error');
    assert.equal((await poll(failure)).state, 'stale', 'stays stale');
    assert.equal((await poll('ok')).state, 'online', 'one success returns to Live');
    assert.equal(run('pollFailures'), 0);
  }

  // Any 4xx warns on the first failure with a human reason.
  for (const [status, reason] of [[401, 'sign-in needed'], [403, 'sign-in needed'], [422, 'server rejected'], [404, 'server rejected']]) {
    last = await poll(status);
    assert.equal(last.state, 'stale', status + ' warns immediately');
    assert.equal(last.extra.reason, reason);
    assert.match(last.text, /last update \d\d:\d\d/);
    assert.equal((await poll('ok')).state, 'online');
  }

  // Nothing internal leaks: no payload, cursor, URL, status text or API path.
  for (const failure of [422, 401, 'network', 503]) {
    run('pollFailures = 5');
    last = await poll(failure);
    const shown = JSON.stringify(last);
    for (const bad of ['CANARY', 'cursor', 'events?', '/api/', 'http', 'HTTP ', 'c' + seq + ' ']) assert(!shown.includes(bad), `leaked ${bad} in ${shown}`);
  }
  await poll('ok');

  // A live view that never succeeded says so instead of inventing a time.
  run('lastPollOk = null; pollFailures = 0');
  last = await poll(422);
  assert.match(last.text, /no update yet/);
  assert.equal(last.extra.updated, null);
  await poll('ok');

  // Failure handling never touches the scene, playhead, speed, camera or cursor.
  run('pollFailures = 0');
  const cursorBefore = run('cursor');
  await poll(422); await poll('network'); await poll(503);
  assert.equal(run('cursor'), cursorBefore, 'cursor must not advance on failure');
  assert.equal(playbackProbe(), probe, 'speed/play/follow/camera unchanged by stale warning');
  assert.equal(run('S.play'), true);
  console.log('PASS test_live_stale');
})().catch(e => { console.error(e); process.exit(1); });
