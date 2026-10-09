// Run with a gate-complete data/replay.json fixture (synthetic for QA):
// node --test tools/backtest.test.js
'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const root = path.join(__dirname, '..');
function run(seed) {
  const env = {...process.env};
  delete env.BACKTEST_SEED;
  if (seed !== undefined) env.BACKTEST_SEED = String(seed);
  const result = spawnSync(process.execPath, ['tools/backtest.js'], {
    cwd: root, env, encoding: 'utf8', timeout: 120000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}
function same(a, b) {
  assert.equal(b.status, a.status);
  assert.equal(b.stdout, a.stdout);
  assert.equal(b.stderr, a.stderr);
}
test('default seed: independent processes PASS with byte-identical whole output', () => {
  const a = run(), b = run();
  assert.equal(a.status, 0, a.stdout + a.stderr);
  assert.match(a.stdout, /\nPASS\n$/);
  assert.equal(a.stderr, '');
  same(a, b);
  same(a, run(1));
});
test('alternate seed is reproducible but genuinely changes simulation results', () => {
  const a = run(2);
  assert.equal(a.status, 0, a.stdout + a.stderr);
  same(a, run(2));
  assert.notEqual(a.stdout, run(1).stdout);
});
test('unsigned seed boundaries remain reproducible (including any gate failure)', () => {
  for (const seed of [0, 0xffffffff]) same(run(seed), run(seed));
});
test('invalid seeds fail closed instead of silently truncating/wrapping', () => {
  for (const seed of ['', '-1', '1.5', '4294967296', 'NaN']) {
    const r = run(seed);
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /BACKTEST_SEED must be an unsigned 32-bit integer/);
  }
});
