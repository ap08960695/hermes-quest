'use strict';
// Tests for desktop/plugin.js and desktop/guest-bridge.js.
//
//   node desktop/test_plugin.cjs                      unit tests only (no browser, no server)
//   QUEST_SDK_SRC=<hermes-agent>/apps/desktop/src node desktop/test_plugin.cjs
//                                                     + owner/lifecycle routing regression on the actual SDK sources
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
const atom = v => { const ls = new Set(); return { get: () => v, set: n => { v = n; for (const f of [...ls]) f(v) }, listen: f => { ls.add(f); return () => ls.delete(f) }, subscribe: cb => { cb(v); return () => {} } } }
const profile = atom('default'), connectionId = atom('local')
globalThis.__owner = { connection: 'local', profile }
export const host = { state: { profile, connectionId }, activeConnectionId: () => globalThis.__owner.connection, navigate: p => { globalThis.__navigated = p } }
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
  catch (error) { console.error(`FAIL ${name}\n${error.stack || error}`); process.exitCode = 1; error.__reported = true; throw error; }
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

  // ---- route guard: owner/lifecycle binding (fake host; the real SDK routing is exercised in sdkRouting()) ----
  const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));
  function fakeHost(initial = { connectionId: 'A', profile: 'default' }) {
    const owner = { ...initial }; const profileL = new Set(); const registryL = new Set(); let applied = null;
    const watchers = {
      pushes: { changed: true, applied: true },
      subscribe: api => { const pl = () => api.check(), rl = p => api.registry(p), al = () => api.registry(null); profileL.add(pl); registryL.add(rl); applied = al; return () => { profileL.delete(pl); registryL.delete(rl); applied = null; }; },
    };
    return {
      owner, watchers, read: () => ({ ...owner }),
      setOwner: (o, notify = true) => { Object.assign(owner, o); if (notify) for (const f of [...profileL]) f(); },
      push: p => { for (const f of [...registryL]) f(p); }, apply: () => applied && applied(),
      listeners: () => profileL.size + registryL.size + (applied ? 1 : 0),
    };
  }
  function guarded(hostApi, restImpl) {
    const lostWhy = []; const guard = plugin.createRouteGuard({ read: hostApi.read, watchers: hostApi.watchers, onLost: why => lostWhy.push(why) });
    const listeners = new Set(); const sent = []; const frame = { postMessage: (m, t, p) => sent.push(p) };
    const calls = [];
    const rest = (p, o) => { calls.push(p); return restImpl(p, o); };
    const ch = plugin.createGuestChannel({ getWindow: () => frame, nonce: NONCE, rest: guard.rest(rest), isCurrent: () => guard.valid(),
      listen: (t, f) => listeners.add(f), unlisten: (t, f) => listeners.delete(f) });
    guard.retireWith(ch.dispose);
    for (const f of [...listeners]) f({ source: frame, origin: 'null', data: { kind: 'quest-ready', nonce: NONCE } });
    const port = sent[0][0]; const got = []; port.onmessage = e => got.push(e.data); port.start?.();
    return { guard, ch, port, got, calls, lostWhy };
  }

  await test('route guard: owner switch without any descriptor change retires BEFORE the next ctx.rest; late old result is dropped', async () => {
    const hostApi = fakeHost(); const pend = [];
    const t = guarded(hostApi, (p) => new Promise(res => pend.push({ p, res, owner: hostApi.owner.connectionId })));
    t.port.postMessage({ id: 1, method: 'GET', path: '/events?since=a' }); await tick();
    assert.strictEqual(t.calls.length, 1);
    hostApi.setOwner({ connectionId: 'B' }, false);            // authority moved; no atom fired (descriptor still pending)
    t.port.postMessage({ id: 2, method: 'GET', path: '/replay' }); await tick();
    assert.strictEqual(t.calls.length, 1, 'no ctx.rest call was made for the new owner on the old channel');
    assert.strictEqual(t.ch.stats.disposed, true); assert.deepStrictEqual(t.lostWhy, ['owner']);
    pend[0].res({ owner: 'A', late: true }); await tick();
    assert.deepStrictEqual(t.got, [], 'the old channel received nothing: no B result, no late A result');
  });

  await test('route guard: profile change retires synchronously (no further requests, no replies)', async () => {
    const hostApi = fakeHost(); const pend = [];
    const t = guarded(hostApi, () => new Promise(res => pend.push(res)));
    t.port.postMessage({ id: 1, method: 'GET', path: '/replay' }); await tick();
    hostApi.setOwner({ profile: 'work' });
    assert.strictEqual(t.ch.stats.disposed, true, 'retired inside the same tick as the profile change');
    pend[0]({ ok: 1 }); t.port.postMessage({ id: 2, method: 'GET', path: '/replay' }); await tick();
    assert.strictEqual(t.calls.length, 1); assert.deepStrictEqual(t.got, []); assert.strictEqual(hostApi.listeners(), 0, 'watchers unsubscribed');
  });

  await test('route guard: same-ID endpoint edit / removal / soft apply / malformed push retire; other ids do not', async () => {
    for (const [name, fire, expectLost] of [
      ['updated', h => h.push({ connectionId: 'A', reason: 'updated' }), true],
      ['removed', h => h.push({ connectionId: 'A', reason: 'removed' }), true],
      ['saved', h => h.push({ connectionId: 'A', reason: 'saved' }), true],
      ['soft apply', h => h.apply(), true],
      ['malformed', h => h.push({ reason: 'updated' }), true],
      ['null', h => h.push(null), true],
      ['other id', h => h.push({ connectionId: 'Z', reason: 'updated' }), false],
    ]) {
      const hostApi = fakeHost(); const pend = [];
      const t = guarded(hostApi, () => new Promise(res => pend.push(res)));
      t.port.postMessage({ id: 1, method: 'GET', path: '/events?since=a' }); await tick();
      fire(hostApi);
      assert.strictEqual(t.ch.stats.disposed, expectLost, name);
      pend[0]({ late: name }); await tick();
      assert.strictEqual(t.got.length, expectLost ? 0 : 1, name + ': old channel result delivery');
      t.guard.dispose();
    }
  });

  await test('route guard: result for the right owner is delivered; dispose is silent; unsupported host fails closed', async () => {
    const hostApi = fakeHost(); const pend = [];
    const t = guarded(hostApi, () => new Promise(res => pend.push(res)));
    t.port.postMessage({ id: 1, method: 'GET', path: '/replay' }); await tick(); pend[0]({ v: 1 }); await tick();
    assert.deepStrictEqual(t.got, [{ id: 1, value: { v: 1 } }]);
    t.port.postMessage({ id: 2, method: 'GET', path: '/replay' }); await tick();
    t.guard.dispose(); assert.strictEqual(t.ch.stats.disposed, true); pend[1]({ v: 2 }); await tick(); assert.strictEqual(t.got.length, 1);
    assert.strictEqual(hostApi.listeners(), 0);
    const bad = (read, pushes) => () => plugin.createRouteGuard({ read, watchers: { pushes, subscribe: () => () => {} } });
    assert.throws(bad(() => ({ connectionId: 'A', profile: 'p' }), { changed: false, applied: true }), /lifecycle unavailable/);
    assert.throws(bad(() => ({ connectionId: null, profile: 'p' }), { changed: true, applied: false }), /lifecycle unavailable/);
    assert.throws(bad(() => { throw new Error('x'); }, { changed: true, applied: true }));
    assert.doesNotThrow(bad(() => ({ connectionId: 'local', profile: 'default' }), {}));
    assert.throws(() => plugin.readOwner({}), /lifecycle unavailable/);
    assert.strictEqual(plugin.classifyError(new Error('Desktop route lifecycle unavailable')), 'lifecycle');
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

async function waitUntil(fn, timeoutMs, what) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (fn()) return; await new Promise(r => setTimeout(r, 100)); }
  throw new Error(`timed out waiting for ${what} after ${timeoutMs} ms`);
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
    // The HUD markup exists before the game boots, so it proves nothing about boot. Wait (bounded) for the
    // actual boot evidence instead of a fixed sleep: the replay was fetched, the bridge delivered PNG
    // envelopes, and the game's serial ~10 s poll made its FIRST /events request through the bridge.
    const bootStart = Date.now();
    await waitUntil(() => (stats.byPath['/replay'] || 0) >= 1 && (stats.byPath['/desktop-asset'] || 0) >= 5, 30000, 'game boot (replay + assets)');
    const bootMs = Date.now() - bootStart;
    await waitUntil(() => (stats.byPath['/events'] || 0) >= 1, 30000, 'first live /events poll through the bridge');
    console.log(`     boot ${bootMs} ms after the HUD; first events poll ${Date.now() - bootStart} ms`);

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


// ---------------------------------------------------------------------------------------------
// SDK routing regression: the candidate React UI on the ACTUAL Hermes Desktop SDK sources
// (api/client.ts request scope, api/plugins.ts pluginRest, sandboxed-frame, connectionId projection,
// real MessageChannel is replaced by a recorder). Needs QUEST_SDK_SRC = <hermes-agent>/apps/desktop/src
// and jsdom + nanostores + @nanostores/react + react-dom in QUEST_NODE_MODULES. Desktop IPC and the
// registry transitions are simulated from the SDK source trace; this is NOT a test inside Desktop.
// ---------------------------------------------------------------------------------------------
async function sdkRouting(sdkRoot) {
  const { JSDOM } = req('jsdom');
  const slash = p => p.split(path.sep).join('/');
  const index = fs.readFileSync(path.join(sdkRoot, 'sdk/index.ts'), 'utf8');
  const a = index.indexOf('const $activeConnectionId = computed($connection');
  const b = index.indexOf('/** Ordinary session opens fail fast');
  assert.ok(a > 0 && b > a, 'SDK connectionId projection found in source');
  const projection = index.slice(a, b);
  const facade = `
import {createElement as h} from 'react';
import {atom, computed} from 'nanostores';
import {useStore as useValue} from '@nanostores/react';
import {setApiRequestProfile,setApiRequestConnection,$apiRequestScope} from '${slash(sdkRoot)}/api/client.ts';
import {pluginRest} from '${slash(sdkRoot)}/api/plugins.ts';
export {SandboxedFrame} from '${slash(sdkRoot)}/components/ui/sandboxed-frame.tsx';
export {useValue};
const $connection = atom({connectionId:'A',mode:'remote',baseUrl:'https://synthetic-A.invalid'});
const $activeGatewayProfile = atom('default');
${projection}
$activeGatewayProfile.subscribe(v => setApiRequestProfile(v));
setApiRequestConnection('A');
// host.activeConnectionId() is activeGatewayConnectionId(); store/gateway applyActive publishes it into
// the request scope in the same synchronous step, so the request scope models it here.
export const host = {state:{profile:$activeGatewayProfile,connectionId:$activeConnectionId},activeConnectionId:()=>$apiRequestScope.get().connectionId,navigate:()=>{}};
export const ROUTES_AREA='routes',SIDEBAR_NAV_AREA='sidebar.nav',PALETTE_AREA='palette';
export const usePluginI18n=()=>k=>k;
export const useTheme=()=>({theme:{name:'test'},renderedMode:'dark'});
export const Button=p=>h('button',p,p.children);
export const GlyphSpinner=()=>h('span');
export const probe={ $connection,$activeGatewayProfile,$apiRequestScope,setApiRequestConnection,
  rest:(p,o)=>pluginRest('hermes-quest',p,o) };
`;
  const entry = `import plugin from '__plugin__'; import {probe} from '@hermes/plugin-sdk'; import {createRoot} from 'react-dom/client'; import {act} from 'react'; export {plugin,probe,createRoot,act};`;
  const built = await esbuild.build({
    stdin: { contents: entry, resolveDir: sdkRoot, sourcefile: 'quest-sdk-entry.js' }, bundle: true, write: false, format: 'cjs', platform: 'node',
    nodePaths: [NM], jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [{ name: 'quest-sdk-facade', setup(build) {
      build.onResolve({ filter: /^@hermes\/plugin-sdk$/ }, () => ({ path: 'sdk-facade', namespace: 'qf' }));
      build.onLoad({ filter: /.*/, namespace: 'qf' }, () => ({ contents: facade, resolveDir: sdkRoot, loader: 'js' }));
      build.onResolve({ filter: /^__plugin__$/ }, () => ({ path: path.join(__dirname, 'plugin.js') }));
      build.onResolve({ filter: /^@hermes\/shared$/ }, () => ({ path: 'shared', namespace: 'qs' }));
      build.onLoad({ filter: /.*/, namespace: 'qs' }, () => ({ contents: 'export class JsonRpcGatewayClient {}; export const reconnectBackoffDelayMs=()=>1;' }));
      build.onResolve({ filter: /^@\/lib\/utils$/ }, () => ({ path: 'utils', namespace: 'qu' }));
      build.onLoad({ filter: /.*/, namespace: 'qu' }, () => ({ contents: 'export const cn=(...x)=>x.join(" ");' }));
      build.onResolve({ filter: /^@\// }, args => ({ path: path.join(sdkRoot, args.path.slice(2) + '.ts') }));
    } }],
  });
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://synthetic-host.invalid' });
  global.window = dom.window; global.document = dom.window.document;
  Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
  global.IS_REACT_ACT_ENVIRONMENT = true;
  global.requestAnimationFrame = () => 1; global.cancelAnimationFrame = () => {};
  const ports = [];
  class RecMessageChannel {
    constructor() {
      const rec = { onmessage: null, closed: false, replies: [], start() {}, close() { this.closed = true; }, postMessage(m) { this.replies.push(m); } };
      this.port1 = rec; this.port2 = { postMessage: m => setImmediate(() => rec.onmessage && rec.onmessage({ data: m })) }; ports.push(rec);
    }
  }
  global.MessageChannel = RecMessageChannel;
  const requests = []; const pendingEvents = []; let serial = 0;
  const regL = new Set(); const appliedL = new Set();
  window.hermesDesktop = {
    connections: { onChanged: f => { regL.add(f); return () => regL.delete(f); } },
    onConnectionApplied: f => { appliedL.add(f); return () => appliedL.delete(f); },
    api: async request => {
      requests.push({ ...request });
      if (request.path.endsWith('/desktop-bootstrap')) {
        const nonce = 'SyntheticNonce000000' + (++serial);
        return { version: 1, nonce, html: `<meta http-equiv="Content-Security-Policy" content="connect-src 'none'"><meta name="quest-nonce" content="${nonce}"><script>/* quest-ready */</script>` };
      }
      if (request.path.includes('/events')) return new Promise(resolve => pendingEvents.push({ request, resolve }));
      return { syntheticOwner: request.connectionId, profile: request.profile };
    },
  };
  const bundleFile = path.join(tmp, 'sdk-routing-bundle.cjs');
  fs.writeFileSync(bundleFile, built.outputFiles[0].text);
  const { plugin: sdkPlugin, probe, createRoot, act } = require(bundleFile);
  const wait = (ms = 5) => new Promise(r => setTimeout(r, ms));
  let root;
  async function mount() {
    const items = []; sdkPlugin.register({ i18n: { register() {}, t: k => k }, registerMany: x => items.push(...x), rest: probe.rest });
    root = createRoot(document.getElementById('root'));
    await act(async () => { root.render(items.find(i => i.id === 'page').render()); await wait(); }); await act(wait);
  }
  function connect() {
    const frame = document.querySelector('iframe');
    const html = decodeURIComponent(frame.src.slice('data:text/html,'.length).replace(/\?live=1$/, ''));
    const nonce = html.match(/quest-nonce" content="([^"]+)/)[1];
    frame.contentWindow.postMessage = () => {};
    window.dispatchEvent(new window.MessageEvent('message', { source: frame.contentWindow, origin: 'null', data: { kind: 'quest-ready', nonce } }));
    return { frame, port: ports[ports.length - 1], nonce };
  }
  const bootstraps = () => requests.filter(x => x.path.endsWith('/desktop-bootstrap'));
  const reset = async () => { if (root) await act(() => root.unmount()); requests.length = 0; pendingEvents.length = 0; ports.length = 0; serial = 0; probe.$connection.set({ connectionId: 'A', mode: 'remote', baseUrl: 'https://synthetic-A.invalid' }); probe.setApiRequestConnection('A'); probe.$activeGatewayProfile.set('default'); };
  const guestSend = (c, m) => c.port.onmessage({ data: m });
  const ownerOf = c => c.port.replies.filter(r => r && r.value).map(r => r.value.syntheticOwner);

  await test('SDK routing: connection fallback while the descriptor is pending (A -> B, profile unchanged)', async () => {
    await reset(); await mount(); const first = connect();
    guestSend(first, { id: 1, method: 'GET', path: '/events?since=synthetic-A-cursor' });
    await act(async () => { probe.setApiRequestConnection('B'); await wait(); }); // authority moved, descriptor/atoms still say A
    assert.strictEqual(probe.$connection.get().connectionId, 'A', 'descriptor projection lags (the F1 trigger)');
    guestSend(first, { id: 2, method: 'GET', path: '/replay' }); await act(wait);
    assert.strictEqual(requests.filter(r => r.path.endsWith('/replay')).length, 0, 'no replay request was issued by the old channel');
    assert.strictEqual(first.port.closed, true, 'old port retired');
    pendingEvents[0].resolve({ syntheticOwner: 'A', late: true }); await act(wait);
    assert.deepStrictEqual(first.port.replies, [], 'old channel got neither the B replay nor the late A result');
    // the page re-bootstraps for the NEW owner (not the old one) and shows a fresh frame
    await act(wait);
    const boots = bootstraps(); assert.strictEqual(boots.length, 2); assert.strictEqual(boots[1].connectionId, 'B');
    const second = connect(); assert.notStrictEqual(second.frame, first.frame); assert.notStrictEqual(second.nonce, first.nonce);
    guestSend(second, { id: 1, method: 'GET', path: '/replay' }); await act(wait);
    assert.deepStrictEqual(ownerOf(second), ['B']); assert.deepStrictEqual(ownerOf(first), []);
    await act(async () => { probe.$connection.set({ connectionId: 'B', mode: 'remote', baseUrl: 'https://synthetic-B.invalid' }); await wait(); }); await act(wait);
    assert.strictEqual(second.port.closed, false, 'the descriptor catching up to the pinned owner B does not retire the already-rebound generation');
    guestSend(second, { id: 2, method: 'GET', path: '/replay' }); await act(wait);
    assert.deepStrictEqual(ownerOf(second), ['B', 'B']);
  });

  await test('SDK routing: same-ID endpoint edit retires the frame/port (registry push) and late A result is dropped', async () => {
    await reset(); await mount(); const first = connect();
    guestSend(first, { id: 1, method: 'GET', path: '/events?since=synthetic-A-cursor' }); await act(wait);
    await act(async () => { probe.$connection.set({ connectionId: 'A', mode: 'remote', baseUrl: 'https://synthetic-C.invalid' }); for (const f of [...regL]) f({ connectionId: 'A', reason: 'updated' }); await wait(); });
    assert.strictEqual(first.port.closed, true, 'port closed synchronously by the lifecycle push');
    pendingEvents[0].resolve({ syntheticOwner: 'A-old-endpoint', late: true }); await act(wait);
    assert.deepStrictEqual(first.port.replies, []);
    await act(wait); assert.strictEqual(bootstraps().length, 2, 'bootstrap repeated for the edited connection');
    assert.notStrictEqual(document.querySelector('iframe'), first.frame);
  });

  await test('SDK routing: actual profile change retires; removal of another connection does not', async () => {
    await reset(); await mount(); const first = connect();
    await act(async () => { for (const f of [...regL]) f({ connectionId: 'Z', reason: 'removed' }); await wait(); });
    assert.strictEqual(first.port.closed, false, 'unrelated registry change keeps the channel');
    guestSend(first, { id: 1, method: 'GET', path: '/replay' }); await act(wait);
    assert.deepStrictEqual(ownerOf(first), ['A']);
    guestSend(first, { id: 2, method: 'GET', path: '/events?since=a' }); await act(wait);
    await act(async () => { probe.$activeGatewayProfile.set('work'); await wait(); });
    assert.strictEqual(first.port.closed, true, 'profile switch retired the old port in the same step');
    pendingEvents[0].resolve({ syntheticOwner: 'A', profile: 'default', late: true }); await act(wait);
    assert.strictEqual(first.port.replies.filter(r => r.id === 2).length, 0, 'late response after the profile switch is not delivered');
    await act(wait); const boots = bootstraps(); assert.strictEqual(boots[boots.length - 1].profile, 'work');
  });

  await test('SDK routing: idle channel is retired by the watchdog when the authority moves silently', async () => {
    await reset(); await mount(); const first = connect();
    await act(async () => { probe.setApiRequestConnection('B'); await wait(700); });
    assert.strictEqual(first.port.closed, true, 'retired without any guest traffic');
  });

  await test('SDK routing: unmount/disable closes the port, drops late results, unsubscribes watchers', async () => {
    await reset(); await mount(); const first = connect();
    guestSend(first, { id: 1, method: 'GET', path: '/events?since=a' }); await act(wait);
    await act(() => root.unmount()); root = null;
    assert.strictEqual(first.port.closed, true);
    pendingEvents[0].resolve({ syntheticOwner: 'A', late: true }); await act(wait);
    assert.deepStrictEqual(first.port.replies, []);
    assert.strictEqual(regL.size, 0); assert.strictEqual(appliedL.size, 0);
    const before = requests.length; await wait(700); assert.strictEqual(requests.length, before, 'no traffic after unmount');
  });

  await test('SDK routing: Desktop without lifecycle pushes fails closed (no bootstrap, no frame)', async () => {
    await reset(); const saved = window.hermesDesktop.connections; window.hermesDesktop.connections = undefined;
    try { await mount(); assert.strictEqual(document.querySelector('iframe'), null); assert.strictEqual(bootstraps().length, 0);
      assert.ok(document.querySelector('[data-quest-state="lifecycleTitle"]')); }
    finally { window.hermesDesktop.connections = saved; }
    await reset();
  });
  if (root) await act(() => root.unmount());
}

(async () => {
  await unit();
  if (process.env.QUEST_SDK_SRC) await sdkRouting(process.env.QUEST_SDK_SRC);
  else console.log('skip SDK routing regression (set QUEST_SDK_SRC to the Hermes apps/desktop/src directory)');
  const transport = process.env.QUEST_TRANSPORT;
  if (transport) {
    for (const name of (process.env.QUEST_BROWSERS || 'chromium').split(',')) {
      await test(`browser ${name} against real transport`, () => browserRun(name.trim(), transport));
    }
  } else console.log('skip browser run (set QUEST_TRANSPORT to run against a real backend)');
  console.log(`PASS ${passed} tests`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
})().catch(error => { if (!error || !error.__reported) console.error(error && error.stack || error); process.exitCode = 1; });
