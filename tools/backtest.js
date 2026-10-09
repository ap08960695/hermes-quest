// Back test: replay synthetic data/demo.json headless through the real game.js logic and
// check the motion rules numerically. Run: node tools/backtest.js
'use strict';
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--data' || !args[1])) {
  console.error('Usage: node tools/backtest.js [--data <replay.json>]');
  process.exit(2);
}
// A live/private replay is opt-in only; never probe it or fall back to it.
const dataPath = args.length ? path.resolve(args[1]) : path.join(root, 'data/demo.json');
const D = JSON.parse(fs.readFileSync(dataPath));
const W = JSON.parse(fs.readFileSync(path.join(root, 'data/world.json')));

// Minimal DOM/canvas stubs: game.js runs its update loop unchanged, drawing is a no-op.
const noop = () => {}, el = () => ({style: {}, classList: {toggle: noop}, set innerHTML(v) {}, set textContent(v) {}, set value(v) {},
  addEventListener: noop, setPointerCapture: noop, getContext: () => new Proxy({}, {get: () => noop})});
global.document = {querySelector: el, querySelectorAll: () => [], body: el()};
global.window = global; global.devicePixelRatio = 1; global.innerWidth = 1440; global.innerHeight = 860;
global.addEventListener = noop; global.requestAnimationFrame = noop; global.performance = {now: () => 0};
global.Image = class { set src(v) { setTimeout(() => this.onerror && this.onerror(), 0); } };
global.fetch = async u => ({ok: true, json: async () => (u.includes('replay') ? D : u.includes('world') ? W : null)});
const timers = []; global.setTimeout = (f, ms) => timers.push([ms / 1000, f]);
const src = fs.readFileSync(path.join(root, 'game.js'), 'utf8').replace(/\nboot\(\);\s*$/, '\n');
global.QuestCUI = require(path.join(root, 'quest/c-ui.js'));
// M4 villagers: npcs.js is loaded like index.html does (global NPCS); init() replaces the fetch in NPCS.load
const NPCS = global.NPCS = require(path.join(root, 'npcs.js'));
const NPC_META = JSON.parse(fs.readFileSync(path.join(root, 'assets/px/npcs/meta.json')));
const npcOk = NPCS.init(W, D.meta, NPC_META);
// Own RNG for the headless simulation, including hero/social/FX choices. Do not change
// the browser's Math or NPCS' independent RNG. BACKTEST_SEED selects another reproducible run.
const seed = process.env.BACKTEST_SEED ?? '1';
if (!/^\d+$/.test(seed) || !Number.isSafeInteger(Number(seed)) || Number(seed) > 0xffffffff) {
  throw new Error('BACKTEST_SEED must be an unsigned 32-bit integer');
}
let rng = Number(seed) >>> 0;
const replayMath = Object.create(Math);
replayMath.random = () => {
  rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
  return rng / 0x100000000;
};
// game.js is trusted repository source; no replay/seed text is interpolated into code.
const G = new Function('Math', src + '\nreturn {S, update, reset, ACTIONS, STRIDE, WALK_V, get D(){return D}, set D(v){D=v}, set W(v){W=v}, get W(){return W}};')(replayMath);
G.D = D; G.W = W;

// Road mask from tools/roads.py (white = road). Off-road check uses the hand-placed path polylines instead
// (the painted roads are the source of truth for the graph), so we verify heroes stay on those polylines.
const segs = W.graph.edges.map(([a, b]) => [W.graph.pts[a], W.graph.pts[b]]);
function distToRoads(x, y) {
  let best = 1e9;
  for (const [a, b] of segs) {
    const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L));
    best = Math.min(best, Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy));
  }
  return best;
}

// ---- M4 villager checks (independent of npcs.js internals: re-derived from data/world.json) ----
const npc = {n: 0, frames: 0, outTown: 0, blocked: 0, offGround: 0, tele: 0, maxStep: 0, still: {}, stillMax: 0, moved: {}, trace: 0, kinds: {}};
const solidBase = [];                                    // building sprites (whole footprint) + the base of solid props, no padding
for (const p of W.props || []) {
  if (p.src === 'buildings') solidBase.push([p.x - p.w * .46, p.y - p.h, p.x + p.w * .46, p.y + 6]);
  else if (['well', 'banner', 'barrels', 'crates', 'lamp', 'signpost', 'stall', 'cart', 'rock', 'rocks', 'oak', 'pine', 'deadtree', 'tent', 'campfire', 'pillar', 'windmill', 'fence', 'rowboat'].includes(p.img)) solidBase.push([p.x - 3, p.y - 3, p.x + 3, p.y + 2]);
}
const townSpot = npcOk ? W.regions[NPCS.state.town].spot : null;
const npcPrev = {};
if (npcOk) NPCS.state.onStep = () => npcCheck();
function npcCheck() {                                    // called after every fixed 1/60 s villager step
  for (const n of NPCS.state.list) {
    npc.frames++; npc.kinds[n.kind] = 1;
    if (((n.x - townSpot[0]) / NPCS.TOWN.rx) ** 2 + ((n.y - townSpot[1]) / NPCS.TOWN.ry) ** 2 >= 1) npc.outTown++;
    if (solidBase.some(r => n.x > r[0] && n.x < r[2] && n.y > r[1] && n.y < r[3])) { npc.blocked++; if (process.env.DEBUG) console.error('NPC IN SOLID', n.id, Math.round(n.x), Math.round(n.y)); }
    const onPlaza = ((n.x - townSpot[0]) / 120) ** 2 + ((n.y - townSpot[1]) / 72) ** 2 < 1;
    if (!onPlaza && distToRoads(n.x, n.y) > NPCS.ROAD_HALF + 1) npc.offGround++;       // only paved plaza or road tiles
    if (!NPCS.walkable(n.x, n.y)) { npc.blocked++; if (process.env.DEBUG) console.error('NPC NOT WALKABLE', n.id, n.state, n.x.toFixed(1), n.y.toFixed(1)); }
    const p = npcPrev[n.id];
    if (p) {
      const step = Math.hypot(n.x - p.x, n.y - p.y); npc.maxStep = Math.max(npc.maxStep, step);
      if (step > NPCS.CFG[n.kind].speed / 60 + .5) npc.tele++;
      npc.moved[n.id] = (npc.moved[n.id] || 0) + step;
      npc.still[n.id] = step < .01 ? (npc.still[n.id] || 0) + 1 : 0; npc.stillMax = Math.max(npc.stillMax, npc.still[n.id]);
    }
    npcPrev[n.id] = {x: n.x, y: n.y}; npc.trace = (npc.trace * 31 + Math.round(n.x * 10) * 7 + Math.round(n.y * 10)) >>> 0;   // determinism digest
  }
}
G.S.speed = 120; G.S.play = true;
G.reset(D.meta.from_);
const dt = 1 / 60, stats = {frames: 0, walkFrames: 0, maxStep: 0, offRoad: 0, offRoadMax: 0, slide: 0, slideMax: 0,
  teleports: 0, kinds: {}, strikes: 0, completes: 0, where: {}};
const PLAZA_RX = 120, PLAZA_RY = 72;  // paved square per region (same ellipse as tools/terrain.py) where figures may stand and fight
let prev = {}, simT = 0;
const wildSegs = (W.graph.wild || []).map(([a, b]) => [W.graph.pts[a], W.graph.pts[b]]);
function distToAny(x, y, list) { let best = 1e9; for (const [a, b] of list) { const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy || 1; const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L)); best = Math.min(best, Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy)); } return best; }
const mon = {frames: 0, off: 0, offMax: 0, where: {}};
const counted = new Set();
const origApply = G.ACTIONS;
for (const k of Object.keys(origApply)) { const f = origApply[k]; origApply[k] = (e, fx, t) => { if (fx) stats.kinds[k] = (stats.kinds[k] || 0) + 1; return f(e, fx, t); }; }

while (G.S.t < D.meta.to + 30 && stats.frames < 60 * 60 * 30) {
  G.update(dt); simT += dt; stats.frames++;
  for (let i = timers.length - 1; i >= 0; i--) if ((timers[i][0] -= dt) <= 0) { const f = timers[i][1]; timers.splice(i, 1); f(); }
  if (stats.frames % 3 === 0) for (const t of Object.values(G.S.tasks)) {
    if (!t.mpath || t.emerge > 0 || t.mx === undefined) continue;
    mon.frames++;
    const d = Math.min(distToRoads(t.mx, t.my), distToAny(t.mx, t.my, wildSegs));
    const zone = Object.values(W.regions).some(r => ((t.mx - r.spot[0]) / PLAZA_RX) ** 2 + ((t.my - r.spot[1]) / PLAZA_RY) ** 2 < 1)
      || Object.values(W.lairs || {}).some(l => Math.hypot(t.mx - l.spot[0], (t.my - l.spot[1]) * 1.5) < 130);
    if (d > 8 && !zone) { mon.off++; mon.offMax = Math.max(mon.offMax, d); const key = Math.round(t.mx / 40) * 40 + ',' + Math.round(t.my / 40) * 40; mon.where[key] = (mon.where[key] || 0) + 1; }
  }
  for (const h of Object.values(G.S.heroes)) {
    const p = prev[h.bot];
    if (p) {
      const step = Math.hypot(h.x - p.x, h.y - p.y);
      if (h.path.length > 1 || p.walking) {
        stats.walkFrames++; stats.maxStep = Math.max(stats.maxStep, step);
        // foot slide: distance moved must equal distance the walk cycle accounts for (frames are tied to h.dist)
        const slide = Math.abs(step - (h.dist - p.dist)); stats.slide += slide; stats.slideMax = Math.max(stats.slideMax, slide);
        const off = distToRoads(h.x, h.y);
        const plaza = Object.values(W.regions).some(r => ((h.x - r.spot[0]) / PLAZA_RX) ** 2 + ((h.y - r.spot[1]) / PLAZA_RY) ** 2 < 1);
        if (off > 6 && !plaza) { stats.offRoad++; stats.offRoadMax = Math.max(stats.offRoadMax, off);
          const key = Math.round(h.x / 40) * 40 + ',' + Math.round(h.y / 40) * 40; stats.where[key] = (stats.where[key] || 0) + 1;
          if (process.env.DEBUG && !stats.dbg) { stats.dbg = 1; console.error('OFFROAD', h.bot, h.region, h.home, JSON.stringify(h.path.map(p => p.map(Math.round)))); } }
      } else if (step > 0.01 && !counted.has(h.bot + G.S.i)) { stats.teleports++; counted.add(h.bot + G.S.i); }
    }
    prev[h.bot] = {x: h.x, y: h.y, dist: h.dist, walking: h.path.length > 1};
  }
}
const rate = (n, d) => (100 * n / Math.max(1, d)).toFixed(2) + '%';
const res = {
  replay_events: D.events.length, sim_seconds: Math.round(simT), frames: stats.frames,
  walk_frames: stats.walkFrames, max_step_px_per_frame: +stats.maxStep.toFixed(2),
  foot_slide_max_px: +stats.slideMax.toFixed(3), off_road_frames: rate(stats.offRoad, stats.walkFrames),
  off_road_max_px: +stats.offRoadMax.toFixed(1), idle_teleports: stats.teleports, actions_fired: stats.kinds,
};
res.social = G.S.soc;
res.monster_march_frames = mon.frames; res.monster_off_trail = rate(mon.off, mon.frames); res.monster_off_max_px = +mon.offMax.toFixed(1); res.monster_hotspots = Object.entries(mon.where).sort((a, b) => b[1] - a[1]).slice(0, 4);
res.off_road_hotspots = Object.entries(stats.where).sort((a, b) => b[1] - a[1]).slice(0, 6);
console.log(JSON.stringify(res, null, 1));
// determinism: a second run of the same seed over the same number of fixed steps must give the identical digest
function npcDigest(frames) {
  NPCS.state.onStep = null; NPCS.init(W, D.meta, NPC_META); let d = 0;
  for (let f = 0; f < frames; f++) { NPCS.update(1 / 60); for (const n of NPCS.state.list) d = (d * 31 + Math.round(n.x * 10) * 7 + Math.round(n.y * 10)) >>> 0; }
  return d;
}
res.npc = npcOk ? {count: NPCS.state.list.length, kinds: Object.keys(npc.kinds).length, frames_per_npc: Math.round(npc.frames / NPCS.state.list.length), out_of_town: npc.outTown,
  blocked_or_off_ground: npc.blocked + npc.offGround, teleports: npc.tele, max_step_px: +npc.maxStep.toFixed(2), longest_still_s: +(npc.stillMax / 60).toFixed(1),
  min_distance_walked_px: Math.round(Math.min(...Object.values(npc.moved)))} : 'npcs.js not initialised';
console.log(JSON.stringify({npc: res.npc}, null, 1));
const fail = [];
if (!npcOk) fail.push('npc: villagers failed to initialise');
else {
  const N = NPCS.state.list.length, REST_MAX = Math.max(...Object.values(NPCS.CFG).map(c => c.rest[1]));
  if (N < 6 || N > 10) fail.push('npc: villager count outside 6-10');
  if (Object.keys(npc.kinds).length < 4) fail.push('npc: not all 4 villager kinds present');
  if (npc.outTown) fail.push('npc: villagers left the town zone');
  if (npc.blocked || npc.offGround) fail.push('npc: villager on a non-walkable tile (building/prop/off road+plaza)');
  if (npc.tele) fail.push('npc: villager teleported / moved faster than walk speed');
  if (npc.stillMax / 60 > REST_MAX + 3) fail.push('npc: villager stuck in one place longer than a rest (' + (npc.stillMax / 60).toFixed(1) + 's)');
  if (Math.min(...Object.values(npc.moved)) < 150) fail.push('npc: a villager barely moved (< 150px)');
  if (npc.frames / N < 60 * 60) fail.push('npc: too few simulated frames to judge villagers');
  const frames = Math.round(npc.frames / N), d1 = npcDigest(frames), d2 = npcDigest(frames);
  if (d1 !== d2) fail.push('npc: not deterministic (same seed, different walk)');
  if (d1 !== npc.trace) fail.push('npc: walk differs between the full game run and a standalone run of the same seed');
}
if (res.foot_slide_max_px > 1) fail.push('foot slide > 1px');
if (res.max_step_px_per_frame > G.WALK_V / 60 + .5) fail.push('step faster than walk speed (pop/teleport)');
if (stats.offRoad / Math.max(1, stats.walkFrames) > .01) fail.push('heroes off the road > 1% of walk frames');
const must = ['run_start', 'tool', 'completed', 'blocked', 'unblocked', 'summon', 'moa', 'comment', 'run_end', 'wake', 'compress', 'captain'];
for (const k of must) if (!stats.kinds[k]) fail.push('action never fired: ' + k);
if (mon.off / Math.max(1, mon.frames) > .01) fail.push('monsters off road/trail > 1% of march frames');
for (const k of ['hangouts', 'group', 'chats', 'handoffs', 'cheers', 'orders', 'spawns', 'marches', 'fightbacks']) if (!(G.S.soc || {})[k]) fail.push('social never happened: ' + k);
console.log(fail.length ? 'FAIL\n- ' + fail.join('\n- ') : 'PASS');
process.exit(fail.length ? 1 : 0);
