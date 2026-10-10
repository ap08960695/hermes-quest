'use strict';
const assert = require('node:assert/strict');

// Install before boot. Observe the native scheduler, not an assignable test facade.
// game.js owns the sole callback named loop; keep its identity and native rAF IDs.
function instrument() {
  const native = window.requestAnimationFrame.bind(window);
  const measurement = window.measurement = {calls: 0, frames: [], tasks: [], start: null, last: null, gameLoop: null};
  window.requestAnimationFrame = function(callback) {
    if (callback.name !== 'loop') return native(callback);
    if (measurement.gameLoop === null) measurement.gameLoop = callback;
    if (callback !== measurement.gameLoop) throw new Error('Ambiguous game rAF callback');
    return native(function(ts) {
      measurement.calls++;
      if (measurement.start !== null && measurement.last !== null) measurement.frames.push({ts, dt: ts - measurement.last});
      measurement.last = ts;
      return callback.call(window, ts);
    });
  };
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) measurement.tasks.push({start: entry.startTime, duration: entry.duration});
  });
  observer.observe({type: 'longtask', buffered: false});
}

function assertPerf(record) {
  const {cpu, live, frames, elapsed, avg, p5, maxLongTask, hidden, errors} = record;
  assert([1, 4].includes(cpu), 'known CPU rate');
  assert.equal(typeof live, 'boolean');
  for (const [name, value] of Object.entries({frames, elapsed, avg, p5, maxLongTask})) assert(Number.isFinite(value), name + ' must be finite');
  assert(frames > 0 && elapsed > 0 && avg > 0 && p5 > 0, 'game must produce measured frames');
  assert.equal(hidden, false, 'perf tab must be visible');
  assert.deepEqual(errors, [], 'no browser errors');
  assert(maxLongTask <= 250, 'long task <=250ms after warmup');
  assert(avg >= (cpu === 1 ? 59 : live ? 55 : 50), 'average FPS threshold');
  if (cpu === 4 && !live) assert(p5 >= 30, 'demo p5 >=30 FPS');
}

module.exports = {instrument, assertPerf};
// Small process boundary used by the negative regression; same gate as perf-after.
if (require.main === module) {
  try { assertPerf(JSON.parse(require('node:fs').readFileSync(0, 'utf8'))); console.log('PASS perf gate'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
