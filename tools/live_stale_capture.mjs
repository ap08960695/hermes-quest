#!/usr/bin/env node
// Synthetic live-status capture: serves a checkout (argv root) with a fake /replay and /events and
// drives the real poll path through ok -> failing -> recovered for 401/422/503/network errors.
// It records what the compact indicator says and writes synthetic before/after screenshots.
//
//   node tools/live_stale_capture.mjs <root> <outDir> <label> [chromium|firefox]
//
// Never reads operator data; every payload comes from data/demo.json. Output is not committed.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const [rootArg, outArg, label = 'run', engine = 'chromium'] = process.argv.slice(2);
if (!rootArg || !outArg) { console.error('usage: live_stale_capture.mjs <root> <outDir> <label> [engine]'); process.exit(2); }
const root = path.resolve(rootArg), outDir = path.resolve(outArg);
const playwright = createRequire(path.join(repo, 'package.json'))('playwright');
const TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.otf': 'font/otf'};
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.resolve(root, '.' + (rel.endsWith('/') ? rel + 'index.html' : rel));
  if (!file.startsWith(root + path.sep) || /(^|\/)(\.git|node_modules)(\/|$)/.test(rel)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, body) => {
    if (err) { res.writeHead(404).end(); return; }
    res.writeHead(200, {'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store'}).end(body);
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
fs.mkdirSync(outDir, {recursive: true});
const demo = JSON.parse(fs.readFileSync(path.join(root, 'data/demo.json')));
const browser = await playwright[engine].launch();
const report = {label, engine, synthetic: true, viewports: {}};
const failures = {s401: 401, s422: 422, s503: 503, network: 'abort'};

async function run(vp) {
  const ctx = await browser.newContext({viewport: vp, deviceScaleFactor: 1}), page = await ctx.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/status of (4|5)\d\d|net::ERR|NS_ERROR|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  let mode = 'ok', seq = 0;
  await page.route('**/api/plugins/hermes-quest/replay*', route => {
    const d = structuredClone(demo), shift = Date.now() / 1000 - d.meta.to;
    d.events.forEach(e => e.t += shift); d.meta.from_ += shift; d.meta.to += shift;
    d.meta.source = 'synthetic-live'; d.meta.show_titles = false; d.cursor = '0';
    return route.fulfill({json: d});
  });
  await page.route('**/api/plugins/hermes-quest/events*', route => {
    if (mode === 'abort') return route.abort('connectionrefused');
    if (typeof mode === 'number') return route.fulfill({status: mode, contentType: 'application/json', body: '{"detail":"SYNTHETIC_PAYLOAD_CANARY /internal/path cursor=SECRET"}'});
    seq++;
    return route.fulfill({json: {state: 'online', events: [{id: 'stale-ok-' + seq, t: Date.now() / 1000, kind: 'heartbeat', task: demo.tasks[0].id, bot: demo.bots[0].id}], tasks: [], bots: [], cursor: String(seq)}});
  });
  await page.goto(base + '/index.html?live=1');
  await page.waitForFunction(() => typeof loop.last === 'number' && cursor !== '');
  const snap = () => page.evaluate(() => {
    const el = s => document.querySelector(s);
    const rect = s => { const r = el(s); const b = r && r.getBoundingClientRect(); return b && b.width ? [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)] : null; };
    return {mode: el('#mode').textContent, modeAria: el('#mode').getAttribute('aria-label'),
      issues: el('#issues').hidden ? null : el('#issues').textContent, connection: el('#connection').getAttribute('aria-label'),
      note: el('#live-note') && !el('#live-note').hidden ? el('#live-note').textContent : null,
      announce: el('#live-announce') ? el('#live-announce').textContent : null,
      overflow: document.documentElement.scrollWidth > innerWidth + 1, bar: rect('#focus-bar'), tag: rect('#tag'), menuToggle: rect('#menu-toggle'),
      timer: pollTimer !== null, play: S.play, speed: S.speed, following, cursor, t: Math.round(S.t)};
  });
  const poll = async next => { mode = next; await page.evaluate(async () => { clearTimeout(pollTimer); await pollEvents(); }); };
  const out = {};
  await poll('ok'); out.online = await snap();
  await page.screenshot({path: path.join(outDir, `${label}-${engine}-${vp.width}-1-live.png`)});
  for (const [name, code] of Object.entries(failures)) {
    const rows = [];
    for (let n = 1; n <= 4; n++) {
      await poll(code === 'abort' ? 'abort' : code); rows.push(await snap());
      if (n === 3 && (name === 's422' || name === 's503')) await page.screenshot({path: path.join(outDir, `${label}-${engine}-${vp.width}-2-${name}-after3.png`)});
    }
    await poll('ok'); const recovered = await snap();
    out[name] = {afterEach: rows, recovered};
  }
  out.errors = errors;
  await ctx.close();
  return out;
}
try {
  for (const vp of [{width: 1280, height: 800}, {width: 375, height: 667}, {width: 320, height: 568}]) report.viewports[vp.width] = await run(vp);
} finally { await browser.close(); server.close(); }
fs.writeFileSync(path.join(outDir, `${label}-${engine}-report.json`), JSON.stringify(report, null, 2));
console.log('wrote', path.join(outDir, `${label}-${engine}-report.json`));
