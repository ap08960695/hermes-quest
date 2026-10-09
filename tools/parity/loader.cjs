'use strict';
// Shipped classic-script loader. Each client gets its own vm and game instance.
// Only the immutable pre-facade baseline uses the explicit legacy adapter.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function createClient({root = path.resolve(__dirname, '../..'), sandbox = {}, legacy = false} = {}) {
  sandbox.__questAutoBoot = false;
  sandbox.window ||= sandbox;
  const box = vm.isContext(sandbox) ? sandbox : vm.createContext(sandbox);
  const run = code => vm.runInContext(code, box);
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
  for (const rel of scripts.filter(s => s === 'npcs.js' || s.startsWith('quest/'))) {
    if (rel === 'quest/c-ui.js' && sandbox.window.QuestCUI) continue;
    vm.runInContext(fs.readFileSync(path.join(root, rel), 'utf8'), box, {filename: rel});
  }
  sandbox.NPCS = sandbox.window.NPCS;
  let source = fs.readFileSync(path.join(root, 'game.js'), 'utf8');
  if (legacy) source = source.replace(/\nboot\(\);\s*$/, '\n') +
    '\n;globalThis.__legacyGame={S,update,reset,ACTIONS,STRIDE,WALK_V,get D(){return D},set D(v){D=v},get W(){return W},set W(v){W=v}};';
  vm.runInContext(source, box, {filename: 'game.js'});
  const G = legacy ? sandbox.__legacyGame : sandbox.HQModules.createGame({autoBoot: false});
  if (!legacy) for (const name of Object.keys(G)) Object.defineProperty(sandbox, name, {
    configurable: true, get: () => G[name], set: value => {G[name] = value;}
  });
  return {G, sandbox, run};
}
function load({root, data, seed = 1, legacy = false}) {
  const D = data ?? JSON.parse(fs.readFileSync(path.join(root, 'data/demo.json'), 'utf8'));
  const W = JSON.parse(fs.readFileSync(path.join(root, 'data/world.json'), 'utf8'));
  const noop = () => {};
  const el = () => ({style: {}, classList: {toggle: noop}, set innerHTML(v) {}, set textContent(v) {}, set value(v) {},
    addEventListener: noop, setPointerCapture: noop, getContext: () => new Proxy({}, {get: () => noop})});
  const timers = [];
  let rng = Number(seed) >>> 0;
  const math = Object.create(Math);
  math.random = () => { rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0; return rng / 0x100000000; };
  class FixedDate extends Date { static now() { return 1700001800000; } constructor(...a) { a.length ? super(...a) : super(1700001800000); } }
  const sb = {console, Math: math, Date: FixedDate, URLSearchParams, AbortController, Promise, JSON, Intl,
    document: {querySelector: el, querySelectorAll: () => [], body: el(), hidden: false, addEventListener: noop},
    devicePixelRatio: 1, innerWidth: 1440, innerHeight: 860, addEventListener: noop, requestAnimationFrame: noop, cancelAnimationFrame: noop,
    performance: {now: () => 0}, Image: class { set src(v) { timers.push([0, () => this.onerror && this.onerror()]); } },
    fetch: async u => ({ok: true, json: async () => (u.includes('replay') ? D : u.includes('world') ? W : null)}),
    setTimeout: (f, ms) => timers.push([ms / 1000, f]), clearTimeout: noop};
  const {G} = createClient({root, sandbox: sb, legacy});
  G.D = D; G.W = W;
  const npcMeta = JSON.parse(fs.readFileSync(path.join(root, 'assets/px/npcs/meta.json'), 'utf8'));
  const npcOk = sb.NPCS.init(W, D.meta, npcMeta);
  return {G, NPCS: sb.NPCS, npcOk, D, W, timers, sandbox: sb};
}
module.exports = {createClient, load};
