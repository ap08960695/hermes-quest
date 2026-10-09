#!/usr/bin/env node
// Browser smoke test: serves the checkout on a loopback port (0 = OS-chosen) with the
// synthetic demo from tools/mock.py, then drives the page in a real browser.
//
//   node tools/browser_smoke.mjs <chromium|firefox> [--out DIR]
//
// Per viewport (1280x800, 390x844): wait for the scene to paint, pause, play, scrub.
// Fails on any console error, page error, failed/4xx/5xx request, boot-error banner,
// a clock that does not behave, or a blank (single-colour) canvas.
// Screenshots go to --out (default: $SMOKE_OUT or the OS temp dir) and are never committed.
// SMOKE_ROOT overrides the directory that is served (used to prove the test catches faults).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const root = path.resolve(process.env.SMOKE_ROOT || repo);
const args = process.argv.slice(2);
const outFlag = args.indexOf('--out');
const outDir = path.resolve(outFlag >= 0 ? args[outFlag + 1] : (process.env.SMOKE_OUT || path.join(os.tmpdir(), 'hermes-quest-smoke')));
const browserName = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
if (!['chromium', 'firefox'].includes(browserName)) {
  console.error('usage: node tools/browser_smoke.mjs <chromium|firefox> [--out DIR]');
  process.exit(2);
}
const playwright = createRequire(path.join(repo, 'package.json'))('playwright');

const VIEWPORTS = [{name: '1280x800', width: 1280, height: 800}, {name: '390x844', width: 390, height: 844}];
const TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.css': 'text/css', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ttf': 'font/ttf', '.woff2': 'font/woff2'};

function serve() {
  const server = http.createServer((req, res) => {
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { rel = '/\0'; }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(root, '.' + rel);
    const inside = file === root || file.startsWith(root + path.sep);
    const blocked = /(^|\/)(\.git|node_modules|\.worktrees)(\/|$)/.test(rel) || rel.includes('\0');
    if (!inside || blocked) { res.writeHead(403); res.end('forbidden'); return; }
    fs.readFile(file, (err, body) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, {'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store'});
      res.end(body);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// Distinct colours on a coarse sample grid of the canvas: 1 means blank/single-colour.
const canvasColours = () => {
  const cv = document.querySelector('#stage');
  if (!cv || !cv.width || !cv.height) return 0;
  const ctx = cv.getContext('2d');
  const seen = new Set();
  for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) {
    const d = ctx.getImageData(Math.min(cv.width - 1, Math.floor((x + .5) * cv.width / 24)),
      Math.min(cv.height - 1, Math.floor((y + .5) * cv.height / 24)), 1, 1).data;
    seen.add(d[0] << 24 | d[1] << 16 | d[2] << 8 | d[3]);
  }
  return seen.size;
};

async function runViewport(browser, base, vp) {
  const problems = [];
  const steps = [];
  const ctx = await browser.newContext({viewport: {width: vp.width, height: vp.height}, deviceScaleFactor: 1});
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') problems.push(`console error: ${m.text()}`); });
  page.on('pageerror', e => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', r => problems.push(`request failed: ${r.url()} (${r.failure()?.errorText})`));
  page.on('response', r => { if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`); });
  const shot = async label => page.screenshot({path: path.join(outDir, `${browserName}-${vp.name}-${label}.png`)});
  const colours = async label => {
    const n = await page.evaluate(canvasColours);
    steps.push(`${label}: ${n} colours`);
    if (n < 8) problems.push(`canvas looks blank at "${label}" (${n} distinct sampled colours)`);
  };
  const clock = () => page.locator('#clock').getAttribute('aria-label');
  try {
    // data/demo.json is the default feed; the boot code reports a load failure only via this banner.
    await page.goto(`${base}/index.html`, {waitUntil: 'load'});
    await page.waitForFunction(() => document.querySelector('#connection')?.getAttribute('aria-label'), null, {timeout: 30000});
    const state = await page.locator('#connection').getAttribute('aria-label');
    if (state !== 'ไฟล์ย้อนหลัง normal') problems.push(`boot did not reach file/demo mode (connection label "${state}")`);
    await page.waitForFunction(() => /^เวลา replay: \d/.test(document.querySelector('#clock')?.getAttribute('aria-label') || ''), null, {timeout: 30000});
    // Let the scene draw: clock must advance (loop is running) and a few frames must pass.
    const first = await clock();
    await page.waitForFunction(t => document.querySelector('#clock').getAttribute('aria-label') !== t, first, {timeout: 30000});
    await page.waitForTimeout(1500);
    await colours('drawn');
    await shot('1-drawn');

    // Pause
    await page.click('#play');
    if ((await page.locator('#play').getAttribute('aria-label')) !== 'เล่น normal' ||
        (await page.locator('#play').getAttribute('aria-pressed')) !== 'true') problems.push('pause: button did not switch to accessible play state');
    await page.waitForTimeout(300);
    const frozen = await clock();
    await page.waitForTimeout(1200);
    if ((await clock()) !== frozen) problems.push(`pause: clock kept moving (${frozen} -> ${await clock()})`);
    await shot('2-paused');
    // Play
    await page.click('#play');
    if ((await page.locator('#play').getAttribute('aria-label')) !== 'หยุด normal' ||
        (await page.locator('#play').getAttribute('aria-pressed')) !== 'false') problems.push('play: button did not switch to accessible pause state');
    await page.waitForFunction(t => document.querySelector('#clock').getAttribute('aria-label') !== t, frozen, {timeout: 15000})
      .catch(() => problems.push('play: clock did not advance after resume'));
    await shot('3-playing');
    // Scrub to 70% (an input event, exactly what dragging the slider fires)
    const before = await clock();
    await page.evaluate(() => { const s = document.querySelector('#scrub'); s.value = 700; s.dispatchEvent(new Event('input', {bubbles: true})); });
    await page.waitForTimeout(1000);
    const after = await clock();
    if (after === before) problems.push(`scrub: clock unchanged (${before})`);
    const pos = Number(await page.locator('#scrub').inputValue());
    if (Math.abs(pos - 700) > 60) problems.push(`scrub: slider ended at ${pos}, expected ~700`);
    await page.waitForTimeout(800);
    await colours('after scrub');
    await shot('4-scrubbed');
    steps.push(`clock ${first} -> pause ${frozen} -> scrub ${before} -> ${after}`);
  } catch (e) {
    problems.push(`flow error: ${String(e.message).split('\n')[0]}`);
    await shot('error').catch(() => {});
  }
  await ctx.close();
  return {viewport: vp.name, problems, steps};
}

fs.mkdirSync(outDir, {recursive: true});
// Regenerate the deterministic synthetic demo exactly as documented (never reads live data).
execFileSync('python3', [path.join('tools', 'mock.py')], {cwd: root, stdio: 'inherit'});
const server = await serve();
const base = `http://127.0.0.1:${server.address().port}`;
console.log(`serving ${root} at ${base} (${browserName})`);
const browser = await playwright[browserName].launch();
console.log(`${browserName} ${browser.version()}`);
let failed = 0;
for (const vp of VIEWPORTS) {
  const r = await runViewport(browser, base, vp);
  for (const s of r.steps) console.log(`  [${r.viewport}] ${s}`);
  if (r.problems.length) {
    failed++;
    console.log(`FAIL ${browserName} ${r.viewport}`);
    for (const p of [...new Set(r.problems)]) console.log(`  - ${p}`);
  } else console.log(`PASS ${browserName} ${r.viewport}`);
}
await browser.close();
server.close();
console.log(failed ? `SMOKE FAIL (${failed}/${VIEWPORTS.length} viewports) screenshots: ${outDir}` : `SMOKE PASS screenshots: ${outDir}`);
process.exit(failed ? 1 : 0);
