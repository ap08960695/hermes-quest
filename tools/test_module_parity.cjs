'use strict';
// D2 module-parity harness. Captures (1) backtest stdout JSON for seeds 1 and 7, (2) a deterministic frame trace
// from an isolated Node vm load of game.js, (3) RGBA canvas hashes + screenshots of scripted scenes in headless
// Chromium (loopback port 0). Compares to a recorded baseline byte for byte; no tolerance.
//   node tools/test_module_parity.cjs record  --out DIR [--no-browser] [--scene SUBSTR]
//   node tools/test_module_parity.cjs compare --baseline DIR [--out DIR] [--no-browser]
//   node tools/test_module_parity.cjs twice   --out DIR [--no-browser]   (two captures, must be identical)
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
let root;
const {trace} = require('./parity/trace.cjs');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const args = process.argv.slice(2), mode = args[0];
const opt = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
root = path.resolve(opt('--root', path.resolve(__dirname, '..')));
const legacy = args.includes('--legacy'); // Only for the immutable pre-facade B0.
const noBrowser = args.includes('--no-browser'), only = opt('--scene');
if (!['record', 'compare', 'twice'].includes(mode)) { console.error('usage: test_module_parity.cjs record|compare|twice --out DIR | --baseline DIR [--no-browser] [--scene SUBSTR]'); process.exit(2); }
const git = a => cp.execFileSync('git', a, {cwd: root, encoding: 'utf8'}).trim();
function digestTree() {
  const files = ['data/demo.json', 'data/world.json', 'tools/fixtures/c-ui.json',
    ...git(['ls-files', 'assets']).split('\n').filter(Boolean)];
  return Object.fromEntries(files.filter(f => fs.existsSync(path.join(root, f))).map(f => [f, sha(fs.readFileSync(path.join(root, f)))]));
}
function backtest(seed) {
  const r = cp.spawnSync(process.execPath, ['tools/backtest.js'], {cwd: root, env: {...process.env, BACKTEST_SEED: String(seed)}, encoding: 'utf8', maxBuffer: 1 << 26});
  if(r.status!==0)throw new Error(`backtest seed ${seed}: ${r.error||r.stderr||r.stdout}`);
  const stats=r.stdout.replace(/\nPASS\s*$/, '').trim().split(/\n(?=\{)/).map(text=>JSON.parse(text));
  return {seed, exit: r.status, stats, stdout: r.stdout, stdout_sha256: sha(r.stdout), pass: /\nPASS\s*$/.test(r.stdout)};
}
async function capture(out) {
  fs.mkdirSync(out, {recursive: true});
  const cap = {game_js_sha256: sha(fs.readFileSync(path.join(root, 'game.js'))), inputs: digestTree(), node: process.version};
  cap.backtest = [1, 7].map(backtest);
  cap.trace = [1, 7].map(seed => trace({root, seed, legacy}));
  if (!noBrowser) cap.browser = await require('./parity/browser_scenes.cjs').run({root, outDir: out, only});
  else cap.browser = {skipped: '--no-browser'};
  // Keep full stdout/trace in files; the manifest holds only digests and per-field values.
  fs.mkdirSync(path.join(out, 'backtest'), {recursive: true});
  for (const b of cap.backtest) fs.writeFileSync(path.join(out, 'backtest', `seed${b.seed}.stdout.txt`), b.stdout);
  fs.writeFileSync(path.join(out, 'trace.json'), JSON.stringify(cap.trace, null, 1));
  const manifest = {...cap, revision: git(['rev-parse', 'HEAD']), backtest: cap.backtest.map(({stdout, ...r}) => r)};
  const text = JSON.stringify(manifest, null, 1) + '\n';
  fs.writeFileSync(path.join(out, 'manifest.json'), text);
  fs.writeFileSync(path.join(out, 'manifest.sha256'), sha(text) + '  manifest.json\n');
  return {cap, manifestSha: sha(text)};
}
function diff(a, b) {
  const bad = [];
  const norm = c => ({...c, node: undefined, revision: undefined});
  const walk = (x, y, p) => {
    if (JSON.stringify(x) === JSON.stringify(y)) return;
    if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x) === !Array.isArray(y)) {
      for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk(x[k], y[k], p + '/' + k); return;
    }
    bad.push(p + ': ' + String(JSON.stringify(x)).slice(0, 80) + ' != ' + String(JSON.stringify(y)).slice(0, 80));
  };
  walk(norm(a), norm(b), ''); return bad;
}
(async () => {
  const fail = [];
  if (mode === 'record' || mode === 'twice') {
    const out = path.resolve(opt('--out', ''));
    if (!opt('--out')) { console.error('--out required'); process.exit(2); }
    const dirs = mode === 'twice' ? [path.join(out, 'run1'), path.join(out, 'run2')] : [out];
    const res = [];
    for (const d of dirs) res.push(await capture(d));
    for (const r of res) for (const b of r.cap.backtest) if (b.exit !== 0 || !b.pass) fail.push(`backtest seed ${b.seed} did not PASS`);
    if (mode === 'twice') {
      const bad = diff(res[0].cap, res[1].cap); fail.push(...bad.map(x => 'run1 != run2 ' + x));
      for (const f of ['trace.json']) if (!fs.readFileSync(path.join(dirs[0], f)).equals(fs.readFileSync(path.join(dirs[1], f)))) fail.push(f + ' bytes differ');
      for (const s of [1, 7]) if (!fs.readFileSync(path.join(dirs[0], `backtest/seed${s}.stdout.txt`)).equals(fs.readFileSync(path.join(dirs[1], `backtest/seed${s}.stdout.txt`)))) fail.push(`backtest seed ${s} stdout bytes differ`);
      if (res[0].manifestSha !== res[1].manifestSha) fail.push('manifest sha256 differs');
    }
    console.log(JSON.stringify({mode, base: git(['rev-parse', 'HEAD']), manifest_sha256: res.map(r => r.manifestSha), pass: !fail.length}, null, 1));
  } else {
    const base = path.resolve(opt('--baseline', ''));
    if (!opt('--baseline')) { console.error('--baseline required'); process.exit(2); }
    const want = JSON.parse(fs.readFileSync(path.join(base, 'manifest.json'), 'utf8'));
    const {cap} = await capture(path.resolve(opt('--out', path.join(process.env.TMPDIR || '/tmp', 'parity-compare-' + process.pid))));
    const got = JSON.parse(JSON.stringify({...cap, backtest: cap.backtest.map(({stdout, ...r}) => r)}));
    if (want.browser && want.browser.skipped !== got.browser.skipped) fail.push('browser section present in only one side');
    fail.push(...diff(want, got).filter(x => !x.startsWith('/game_js_sha256') || process.argv.includes('--strict-source')));
    // Field-by-field backtest JSON (parsed, not only PASS).
    for (let i = 0; i < 2; i++) {
      const a = fs.readFileSync(path.join(base, 'backtest', `seed${want.backtest[i].seed}.stdout.txt`), 'utf8');
      if (a !== cap.backtest[i].stdout) fail.push(`backtest seed ${want.backtest[i].seed} stdout differs`);
    }
    console.log(JSON.stringify({mode, equal: !fail.length}, null, 1));
  }
  if (fail.length) { console.log('FAIL\n- ' + fail.join('\n- ')); process.exit(1); }
  console.log('PASS'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
