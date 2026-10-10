'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const cp = require('node:child_process');
const path = require('node:path');
const {instrument} = require('./mobile_measurement.cjs');
const gate = path.join(__dirname, 'mobile_measurement.cjs');
const valid = {cpu: 4, live: false, frames: 3300, elapsed: 55, avg: 60, p5: 60, maxLongTask: 0, hidden: false, errors: []};
function exit(record) {
  const result = cp.spawnSync(process.execPath, [gate], {input: JSON.stringify(record), encoding: 'utf8'});
  assert.equal(result.error, undefined);
  return result;
}

test('native observer excludes UI rAF and preserves callback identity, receiver, timestamps and cancellation IDs', () => {
  const scheduled = new Map(); let id = 0;
  const window = {requestAnimationFrame(fn) { scheduled.set(++id, fn); return id; }};
  const sandbox = {window, PerformanceObserver: class {observe() {}}};
  vm.runInNewContext('(' + instrument.toString() + ')()', sandbox);
  let uiCalls = 0, gameCalls = 0;
  const ui = () => uiCalls++;
  function loop(ts) { assert.equal(this, window); assert.equal(ts, 16); gameCalls++; }
  const uiID = window.requestAnimationFrame(ui), gameID = window.requestAnimationFrame(loop);
  assert.equal(scheduled.get(uiID), ui, 'UI callback remains untouched');
  scheduled.get(uiID)(16);scheduled.get(gameID)(16);
  assert.equal(uiCalls, 1);assert.equal(gameCalls, 1);
  assert.equal(window.measurement.calls, 1);assert.equal(window.measurement.gameLoop, loop);
  const canceled = window.requestAnimationFrame(loop);scheduled.delete(canceled);
  assert.equal(window.measurement.calls, 1, 'cancelled callback is not a frame');
  window.measurement.start = 0;
  const next = window.requestAnimationFrame(loop);scheduled.get(next)(16);
  assert.equal(window.measurement.frames.length, 1);
  assert.throws(() => window.requestAnimationFrame(function loop() {}), /Ambiguous/);
});

test('gate subprocess accepts original CPU4 boundaries and CPU1 approximately 60 FPS', () => {
  for (const record of [{...valid, avg: 50, p5: 30, maxLongTask: 250}, {...valid, live: true, avg: 55}, {...valid, cpu: 1, avg: 59}]) {
    const result = exit(record);assert.equal(result.status, 0, result.stderr);
  }
});

for (const [name, change] of Object.entries({
  'zero frames': {frames: 0, avg: 0, p5: 0},
  'absent frame count': {frames: undefined},
  'demo average below 50': {avg: 49.99},
  'demo p5 below 30': {p5: 29.99},
  'live average below 55': {live: true, avg: 54.99},
  'CPU1 below approximately 60': {cpu: 1, avg: 58.99},
  'long task above 250': {maxLongTask: 250.01},
  'hidden tab': {hidden: true},
  'browser error': {errors: ['synthetic failure']},
  'nonfinite rate': {avg: null}
})) test('gate subprocess rejects ' + name + ' with nonzero exit and no PASS', () => {
  const result = exit({...valid, ...change});
  assert.equal(result.status, 1, result.stderr);assert(!result.stdout.includes('PASS'));assert(result.stderr.length > 0);
});
