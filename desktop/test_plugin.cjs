'use strict';
// Tests for desktop/plugin.js and desktop/guest-bridge.js.
//
//   node desktop/test_plugin.cjs                      unit tests only (no browser, no server)
//   QUEST_TRANSPORT=http://127.0.0.1:PORT/api/plugins/hermes-quest QUEST_BROWSERS=chromium,firefox \
//     node desktop/test_plugin.cjs                    + browser run against a REAL backend transport
//
// Needs `esbuild`, `react` (and `playwright-core` for the browser part). Set QUEST_NODE_MODULES to a
// node_modules directory that has them. The Desktop SDK is replaced by a tiny stand-in (the real
// SandboxedFrame is an iframe with sandbox="allow-scripts"; the stand-in renders exactly that).
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');

const NM = process.env.QUEST_NODE_MODULES || path.join(__dirname, '..', 'node_modules');
const req = createRequire(path.join(NM, 'x.js'));
const esbuild = req('esbuild');
const ROOT = path.join(__dirname, '..');

const SDK_STUB = `
import { createElement as h, useState } from 'react'
export const ROUTES_AREA = 'routes', SIDEBAR_NAV_AREA = 'sidebar.nav', PALETTE_AREA = 'palette'
const atom = v => ({ get: () => v, listen: () => () => {}, subscribe: cb => { cb(v); return () => {} } })
export const host = { state: { profile: atom('default'), connectionId: atom('local') }, navigate: p => { globalThis.__navigated = p } }
export const useValue = a => a.get()
export const useTheme = () => ({ theme: { name: 'test' }, renderedMode: 'dark' })
export const usePluginI18n = () => k => k
export const Button = p => h('button', { onClick: p.onClick }, p.children)
export const GlyphSpinner = () => h('span', null, '...')
export const SandboxedFrame = ({ ref, src, title, style }) => h('iframe', { ref, src, title, style, sandbox: 'allow-scripts' })
`;

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'quest-plugin-'));
const stubFile = path.join(tmp, 'sdk-stub.js');
fs.writeFileSync(stubFile, SDK_STUB);

function bundle(format, platform, entry = path.join(__dirname, 'plugin.js')) {
  const out = esbuild.buildSync({
    entryPoints: [entry], bundle: true, write: false, format, platform,
    nodePaths: [NM], jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' },
    alias: { '@hermes/plugin-sdk': stubFile, __plugin__: path.join(__dirname, 'plugin.js') },
  });
  return out.outputFiles[0].text;
}

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok   ${name}`); }
  catch (error) { console.error(`FAIL ${name}\n${error.stack || error}`); process.exitCode = 1; throw error; }
}

const cjsFile = path.join(tmp, 'plugin.cjs');
fs.writeFileSync(cjsFile, bundle('cjs', 'node'));
const plugin = require(cjsFile);
const bridgeSource = fs.readFileSync(path.join(__dirname, 'guest-bridge.js'), 'utf8');

const NONCE = 'Sp0oROAYg7qG6emDk4C2Jtjg';
const goodHtml = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'none'"><meta name="quest-nonce" content="${NONCE}"></head><body><script>parent.postMessage({kind:'quest-ready'})</script></body></html>`;

async function unit() {
  await test('registers route, sidebar nav and palette command; opt-in default', () => {
    const items = [];
    const ctx = { i18n: { register() {}, t: k => k }, registerMany: list => items.push(...list), rest: async () => ({}) };
    assert.strictEqual(plugin.default.id, 'hermes-quest');
    assert.strictEqual(plugin.default.defaultEnabled, false);
    plugin.default.register(ctx);
    const byId = Object.fromEntries(items.map(i => [i.id, i]));
    assert.deepStrictEqual(Object.keys(byId).sort(), ['nav', 'open', 'page']);
    assert.strictEqual(byId.page.area, 'routes'); assert.strictEqual(byId.page.data.path, '/hermes-quest');
    assert.strictEqual(byId.nav.area, 'sidebar.nav'); assert.strictEqual(byId.nav.data.path, '/hermes-quest');
    assert.strictEqual(byId.open.area, 'palette');
    byId.open.data.run(); assert.strictEqual(globalThis.__navigated, '/hermes-quest');
  });

  await test('guest request validation: allowlist, GET only, traversal, encoding, limits', () => {
    const ok = p => plugin.validateGuestRequest({ id: 1, method: 'GET', path: p });
    const bad = (m, re) => assert.throws(() => plugin.validateGuestRequest(m), re || /denied|exceeds/);
    for (const p of ['/replay?hours=12', '/replay', '/events?since=', '/events?since=' + encodeURIComponent('{"a":1}'),
      '/static/data/world.json', '/static/assets/px/heroes.json', '/static/assets/px/monsters2/meta.json',
      '/static/assets/sprites/monsters.json', '/desktop-asset?path=assets/px/ground.png',
      '/desktop-asset?path=' + encodeURIComponent('assets/px/npcs/farmer.png')]) assert.strictEqual(ok(p), p);
    for (const p of ['/desktop-bootstrap', '/static/index.html', '/static/game.js', '/static/data/replay.json',
      '/static/assets/fonts/NotoSansThai-Regular.otf', '/static/assets/px/../../data/replay.json',
      '/static/%2e%2e/x.json', '/static/assets/px/a.json?x=1', '/replay?hours=0', '/replay?hours=1000', '/replay?hours=12&x=1',
      '/events?since=a&since=b', '/events?x=1', 'replay', '//evil/replay', 'https://evil/replay', '/replay#x', '/re\\play',
      '/desktop-asset?path=assets/raw/a.png', '/desktop-asset?path=data/replay.json', '/desktop-asset?path=assets/px/../x.png',
      '/desktop-asset', '/desktop-asset?path=assets/px/a.png&x=1', '/replay\n']) bad({ id: 1, method: 'GET', path: p });
    bad({ id: 1, method: 'POST', path: '/replay' }); bad({ id: 1, method: 'get', path: '/replay' });
    bad({ id: 0, method: 'GET', path: '/replay' }); bad({ id: 1.5, method: 'GET', path: '/replay' }); bad({ id: '1', method: 'GET', path: '/replay' });
    bad({ id: 1, method: 'GET', path: '/replay', body: 'x' }); bad(null); bad([]); bad('x');
    bad({ id: 1, method: 'GET', path: '/replay?hours=' + '1'.repeat(100001) });
    // Cursor limit is measured on decoded UTF-8 bytes: 32768 passes, 32769 fails, 3-byte chars count as 3.
    assert.doesNotThrow(() => ok('/events?since=' + 'a'.repeat(32768)));
    bad({ id: 1, method: 'GET', path: '/events?since=' + 'a'.repeat(32769) }, /32 KiB/);
    bad({ id: 1, method: 'GET', path: '/events?since=' + encodeURIComponent('\u0e01'.repeat(10923)) }, /32 KiB/);
    assert.doesNotThrow(() => ok('/events?since=' + encodeURIComponent('\u0e01'.repeat(10922))));
  });

  await test('bootstrap envelope fails closed', () => {
    assert.strictEqual(plugin.validateBootstrap({ version: 1, nonce: NONCE, html: goodHtml }).nonce, NONCE);
    const v = o => () => plugin.validateBootstrap({ version: 1, nonce: NONCE, html: goodHtml, ...o });
    for (const o of [{ version: 2 }, { nonce: 'short' }, { nonce: 'bad nonce with spaces!!' }, { html: '' }, { html: 5 },
      { html: goodHtml.replace('connect-src', 'x-src') }, { html: goodHtml.replace(NONCE, 'AAAAAAAAAAAAAAAAAAAAAAAA') },
      { html: goodHtml.replace('quest-ready', 'q') }, { html: 'x'.repeat(3 * 1024 * 1024 + 1) }])
      assert.throws(v(o), /invalid bootstrap/);
    assert.throws(() => plugin.validateBootstrap(null), /invalid bootstrap/);
    assert.throws(() => plugin.validateBootstrap('x'), /invalid bootstrap/);
    const src = plugin.buildFrameSrc('<a>#?%</a>');
    assert.ok(src.startsWith('data:text/html,') && src.endsWith('?live=1') && !src.includes('<'));
  });

  await test('error mapping never carries payload text', () => {
    assert.strictEqual(plugin.classifyError(new Error('401: {"secret":"x"}')), 'auth');
    assert.strictEqual(plugin.classifyError(new Error('403: nope')), 'auth');
    assert.strictEqual(plugin.classifyError(new Error('404: Not Found')), 'unavailable');
    assert.strictEqual(plugin.classifyError(new Error('503: down')), 'unavailable');
    assert.strictEqual(plugin.classifyError(new Error('Hermes desktop bridge unavailable')), 'bridge');
    assert.strictEqual(plugin.classifyError(new Error('socket hang up')), 'offline');
    assert.strictEqual(plugin.sanitizeError(new Error('500: secret-detail boom')), 'HTTP 500');
    assert.strictEqual(plugin.sanitizeError(new Error('ECONNRESET secret-detail')), 'Request failed');
    assert.strictEqual(plugin.validAccent('#a1B2c3'), '#a1B2c3'); assert.strictEqual(plugin.validAccent('red;x'), null);
  });

  await test('channel: exact source + opaque origin + nonce, single connection, late results suppressed, dispose', async () => {
    const listeners = new Set();
    const listen = (t, f) => t === 'message' && listeners.add(f), unlisten = (t, f) => t === 'message' && listeners.delete(f);
    const sent = [];
    const frame = { postMessage: (msg, target, ports) => sent.push({ msg, target, ports }) };
    const calls = []; let release;
    const rest = (p, o) => { calls.push([p, o]); return new Promise(r => { release = r; }); };
    const ch = plugin.createGuestChannel({ getWindow: () => frame, nonce: NONCE, rest, accent: () => '#112233', listen, unlisten });
    const fire = e => { for (const f of [...listeners]) f(e); };
    const ready = { kind: 'quest-ready', nonce: NONCE };
    fire({ source: {}, origin: 'null', data: ready });          // wrong source
    fire({ source: frame, origin: 'https://evil', data: ready }); // wrong origin
    fire({ source: frame, origin: 'null', data: { ...ready, nonce: 'x' } }); // wrong nonce
    assert.strictEqual(sent.length, 0);
    fire({ source: frame, origin: 'null', data: ready });
    assert.strictEqual(sent.length, 1); assert.strictEqual(sent[0].target, '*');
    assert.deepStrictEqual(sent[0].msg, { kind: 'quest-connect', nonce: NONCE, theme: { accent: '#112233' } });
    assert.strictEqual(listeners.size, 0, 'listener removed after connect (single connection)');
    fire({ source: frame, origin: 'null', data: ready }); assert.strictEqual(sent.length, 1);
    const guest = sent[0].ports[0]; const got = []; guest.onmessage = e => got.push(e.data); guest.start?.();
    const tick = () => new Promise(r => setTimeout(r, 20));
    guest.postMessage({ id: 1, method: 'POST', path: '/replay' }); guest.postMessage({ id: 2, method: 'GET', path: '/desktop-bootstrap' });
    await tick();
    assert.strictEqual(calls.length, 0); assert.deepStrictEqual(got.map(g => g.error), ['Bridge request denied', 'Bridge path denied']);
    guest.postMessage({ id: 3, method: 'GET', path: '/events?since=abc' }); await tick();
    assert.deepStrictEqual(calls[0], ['/events?since=abc', { method: 'GET', timeoutMs: 35000 }]);
    release({ cursor: 'c' }); await tick();
    assert.deepStrictEqual(got[2], { id: 3, value: { cursor: 'c' } });
    guest.postMessage({ id: 4, method: 'GET', path: '/replay' }); await tick();
    ch.dispose(); release({ late: true }); await tick();
    assert.strictEqual(got.length, 3, 'late result after dispose is not delivered');
    assert.strictEqual(ch.stats.disposed, true); ch.dispose();
    guest.postMessage({ id: 5, method: 'GET', path: '/replay' }); await tick(); assert.strictEqual(calls.length, 2);
  });

  await test('channel: in-flight cap, error sanitising, oversized response', async () => {
    const listeners = new Set(); const sent = []; const frame = { postMessage: (m, t, p) => sent.push(p) };
    const pend = []; const rest = () => new Promise((res, rej) => pend.push({ res, rej }));
    const ch = plugin.createGuestChannel({ getWindow: () => frame, nonce: NONCE, rest, listen: (t, f) => listeners.add(f), unlisten: (t, f) => listeners.delete(f) });
    for (const f of [...listeners]) f({ source: frame, origin: 'null', data: { kind: 'quest-ready', nonce: NONCE } });
    const guest = sent[0][0]; const got = []; guest.onmessage = e => got.push(e.data); guest.start?.();
    for (let i = 1; i <= 10; i++) guest.postMessage({ id: i, method: 'GET', path: '/replay' });
    await new Promise(r => setTimeout(r, 30));
    assert.strictEqual(pend.length, 8); assert.strictEqual(ch.stats.maxInflight, 8);
    assert.deepStrictEqual(got.filter(g => g.error === 'Bridge busy').map(g => g.id), [9, 10]);
    pend[0].rej(new Error('500: secret-detail trace line 3')); pend[1].res({ a: 'x'.repeat(17 * 1024 * 1024) });
    await new Promise(r => setTimeout(r, 60));
    assert.ok(got.some(g => g.id === 1 && g.error === 'HTTP 500'));
    assert.ok(got.some(g => g.id === 2 && g.error === 'Response too large'));
    assert.ok(!JSON.stringify(got).includes('secret-detail'));
    ch.dispose();
  });

  await test('guest bridge source is inline-safe and has no network/storage use', () => {
    assert.ok(!/<\/script/i.test(bridgeSource) && !bridgeSource.includes('<!--'), 'backend refuses these sequences');
    assert.ok(/meta\[name="quest-nonce"\]/.test(bridgeSource), 'reads the nonce meta the backend writes');
    assert.ok(!/localStorage|sessionStorage|indexedDB|XMLHttpRequest|WebSocket|importScripts|eval\(|new Function/.test(bridgeSource));
    assert.ok(!/quest-probe-nonce/.test(bridgeSource));
  });
}

// ---------------------------------------------------------------------------------------------
// Browser run: real plugin.js UI + real guest bridge + real backend transport.
// ---------------------------------------------------------------------------------------------
const HARNESS = `<!doctype html><meta charset=utf-8><body style="margin:0"><div id=root style="width:900px;height:600px"></div>
<script src="/bundle.js"></script>`;
const ENTRY = `
import { createRoot } from 'react-dom/client'
import { createElement as h } from 'react'
import plugin from '__plugin__'
const T = location.pathname.replace(/\\/$/, '')
const log = (window.__log = [])
const rest = async (p, o = {}) => {
  log.push(p)
  if (window.__mode === 'auth') throw new Error('401: {"detail":"nope"}')
  if (window.__mode === 'down' && p === '/desktop-bootstrap') throw new Error('503: unavailable')
  const r = await fetch('/api/plugins/hermes-quest' + p, { method: o.method || 'GET', cache: 'no-store' })
  const text = await r.text()
  if (!r.ok) throw new Error(r.status + ': ' + text.slice(0, 40))
  try { return JSON.parse(text) } catch { throw new Error('HTML response, JSON API required') }
}
const items = []
const ctx = { i18n: { register() {}, t: k => k }, registerMany: l => items.push(...l), rest }
plugin.register(ctx)
const page = items.find(i => i.id === 'page')
let root
window.__mount = () => { root = createRoot(document.getElementById('root')); root.render(page.render()) }
window.__unmount = () => root.unmount()
`;

function startServer(transport) {
  const target = new URL(transport);
  const base = target.pathname.replace(/\/$/, '');
  const entry = path.join(tmp, 'entry.jsx'); fs.writeFileSync(entry, ENTRY);
  const bundleText = bundle('iife', 'browser', entry);
  const stats = { byPath: {}, total: 0, activeEvents: 0, maxConcurrentEvents: 0 };
  const server = http.createServer((rq, rs) => {
    if (rq.url === '/') { rs.setHeader('content-type', 'text/html'); return rs.end(HARNESS); }
    if (rq.url === '/bundle.js') { rs.setHeader('content-type', 'text/javascript'); return rs.end(bundleText); }
    if (rq.url.startsWith('/api/plugins/hermes-quest/')) {
      const route = rq.url.slice('/api/plugins/hermes-quest'.length).split('?')[0];
      const key = route.startsWith('/static') ? '/static' : route; stats.byPath[key] = (stats.byPath[key] || 0) + 1; stats.total += 1;
      const isEvents = key === '/events'; if (isEvents) { stats.activeEvents += 1; stats.maxConcurrentEvents = Math.max(stats.maxConcurrentEvents, stats.activeEvents); rs.on('close', () => { stats.activeEvents -= 1; }); }
      const up = http.request({ host: target.hostname, port: target.port, path: base + rq.url.slice('/api/plugins/hermes-quest'.length), method: rq.method },
        r => { rs.writeHead(r.statusCode, r.headers); r.pipe(rs); });
      up.on('error', () => { rs.statusCode = 502; rs.end('bad gateway'); });
      return rq.pipe(up);
    }
    rs.statusCode = 404; rs.end();
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, stats, url: `http://127.0.0.1:${server.address().port}/` })));
}

async function browserRun(name, transport) {
  const pw = req('playwright-core');
  const browser = await pw[name].launch({ headless: true });
  const { server, stats, url } = await startServer(transport);
  const errors = [];
  try {
    const page = await (await browser.newContext({ viewport: { width: 1000, height: 700 } })).newPage();
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });
    await page.goto(url);
    await page.evaluate(() => window.__mount());
    const frameEl = await page.waitForSelector('iframe[title="title"]', { timeout: 20000 });
    assert.strictEqual(await frameEl.getAttribute('sandbox'), 'allow-scripts');
    const frame = await frameEl.contentFrame();
    // The unchanged game boots through the bridge: nonce meta read, connect, JSON + image envelopes.
    await page.waitForFunction(() => true);
    await frame.waitForFunction(() => window.__questBridge && window.__questBridge.connected(), null, { timeout: 20000 });
    await frame.waitForFunction(() => document.querySelector('#stage') && document.querySelector('#stage').width > 0, null, { timeout: 20000 });
    await frame.waitForFunction(() => document.querySelector('#hud button') != null, null, { timeout: 20000 });
    await new Promise(r => setTimeout(r, 11500)); // the game's serial poll fires every ~10 s

    const probe = await frame.evaluate(async () => {
      const out = {};
      out.origin = location.origin; out.hostApi = typeof window.hermesDesktop;
      const rej = async fn => { try { await fn(); return 'resolved'; } catch (e) { return e.name; } };
      out.postFetch = await rej(() => fetch('/api/plugins/hermes-quest/replay', { method: 'POST' }));
      out.absFetch = await rej(() => fetch('https://example.org/'));
      out.bootstrapFetch = await rej(() => fetch('/api/plugins/hermes-quest/desktop-bootstrap'));
      out.traversal = await rej(() => fetch('../data/replay.json'));
      out.storage = await rej(async () => localStorage.getItem('x'));
      const r = await fetch('assets/px/heroes.json'); out.heroesStatus = r.status;
      out.heroesKeys = Object.keys(await r.json()).length;
      out.baseURI = document.baseURI;
      out.fontFace = await new Promise(res => { const f = new FontFace('X', 'url("https://example.org/a.otf")'); f.load().then(() => res('loaded'), e => res(e.message)); });
      out.canvasPixels = (() => { const c = document.querySelector('#stage'); const g = c.getContext('2d'); const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4000) if (d[i]) n++; return n; })();
      return out;
    });
    assert.strictEqual(probe.origin, 'null');
    assert.strictEqual(probe.hostApi, 'undefined');
    for (const k of ['postFetch', 'absFetch', 'bootstrapFetch', 'traversal']) assert.strictEqual(probe[k], 'TypeError', k);
    assert.notStrictEqual(probe.storage, 'resolved', 'opaque origin has no localStorage');
    assert.strictEqual(probe.heroesStatus, 200); assert.ok(probe.heroesKeys > 0);
    assert.ok(probe.baseURI.startsWith('https://'), 'font.js can resolve its URL');
    assert.ok(/unavailable/i.test(probe.fontFace), 'font load fails cleanly offline: ' + probe.fontFace);
    assert.ok(probe.canvasPixels > 0, 'canvas drawn');
    assert.ok(stats.byPath['/desktop-bootstrap'] === 1, 'one bootstrap');
    assert.ok(stats.byPath['/desktop-asset'] >= 5, 'PNG assets via envelope: ' + stats.byPath['/desktop-asset']);
    assert.ok(stats.byPath['/static'] >= 2, 'static JSON via /static');
    assert.ok(stats.byPath['/replay'] >= 1, 'replay fetched');
    assert.ok(stats.byPath['/events'] >= 1, 'live poll flows through the bridge');
    assert.ok(stats.maxConcurrentEvents <= 1, 'serial polling preserved');
    const fatal = errors.filter(e => !/Failed to load resource|Content Security Policy|NotoSansThai|Detail font/i.test(e));
    assert.deepStrictEqual(fatal, [], 'no uncaught page errors');

    // Disable / leave route: realm destroyed, no further backend traffic.
    await page.evaluate(() => window.__unmount());
    await page.waitForSelector('iframe', { state: 'detached', timeout: 5000 });
    const before = stats.total; await new Promise(r => setTimeout(r, 1500));
    assert.strictEqual(stats.total, before, 'no requests after unmount');

    // Failure UI: auth loss / backend without the endpoint, then retry.
    await page.evaluate(() => { window.__mode = 'auth'; window.__mount(); });
    await page.waitForSelector('[data-quest-state="authTitle"]', { timeout: 5000 });
    assert.strictEqual(await page.locator('iframe').count(), 0, 'nothing mounted on auth failure');
    await page.evaluate(() => { window.__unmount(); window.__mode = 'down'; window.__mount(); });
    await page.waitForSelector('[data-quest-state="unavailableTitle"]', { timeout: 5000 });
    await page.evaluate(() => { window.__mode = ''; });
    await page.getByText('retry').click();
    await page.waitForSelector('iframe', { timeout: 10000 });
    if (errors.length) console.log('     filtered console:', JSON.stringify(errors));
    console.log(`ok   browser ${name}: game booted through bridge; assets=${stats.byPath['/desktop-asset']} static=${stats.byPath['/static']} events=${stats.byPath['/events'] || 0}; ${errors.length} filtered console msgs`);
  } finally { await browser.close(); server.close(); }
}

(async () => {
  await unit();
  const transport = process.env.QUEST_TRANSPORT;
  if (transport) {
    for (const name of (process.env.QUEST_BROWSERS || 'chromium').split(',')) {
      await test(`browser ${name} against real transport`, () => browserRun(name.trim(), transport));
    }
  } else console.log('skip browser run (set QUEST_TRANSPORT to run against a real backend)');
  console.log(`PASS ${passed} tests`);
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch(() => { process.exitCode = 1; });
