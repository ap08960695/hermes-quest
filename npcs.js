// Hermes Quest: villagers (M4). Porters, farmers, children and guards wander the town so it feels alive.
// All NPC logic lives here; game.js only calls load/update/ents (3 hook lines).
//  - town = the hub region of the road graph (or meta.town_region / world.town), found from data, no region names
//  - walk area = paved plaza oval + road corridors near it, minus building/prop footprints and the hero fight yard
//  - wander: pick a far waypoint, route over a walkable lattice, string-pull into straight legs, walk, rest, repeat
//  - own seeded RNG + fixed 1/60 s step: same seed => same walk, never touches Math.random of game.js
//  - decorative only: never in S.heroes/S.tasks, never in the battle log, never clickable
'use strict';
(function (root) {
  const STEP = 1 / 60, CELL = 4, LATTICE = 16, SEED = 0x4d34;
  const PLAZA = {rx: 108, ry: 62};              // paved oval minus margin (terrain.py uses 120 x 72)
  const TOWN = {rx: 400, ry: 210};              // how far from the town spot villagers may roam along the roads
  const ROAD_HALF = 15;                         // road + a little grass verge (cobble 9 px, curb 13 px each side)
  const PAD = 5;                                // keep feet this far from solid footprints
  const COUNT = 8;                              // 6-10 villagers
  const KINDS = ['porter', 'farmer', 'child', 'guard'];
  const CFG = {porter: {speed: 36, rest: [2, 6]}, farmer: {speed: 34, rest: [3, 8]}, child: {speed: 44, rest: [.8, 3]}, guard: {speed: 32, rest: [4, 10]}};
  // props that block feet; the rest (flowers, field, ...) are walk-through ground decoration
  const SOLID = new Set(['well', 'banner', 'barrels', 'crates', 'lamp', 'signpost', 'stall', 'cart', 'rock', 'rocks', 'oak', 'pine',
    'deadtree', 'tent', 'campfire', 'pillar', 'windmill', 'fence', 'stump', 'bush', 'rowboat']);
  const TRUNK = new Set(['oak', 'pine', 'deadtree', 'lamp', 'banner', 'signpost']);   // tall props: only the base blocks

  const S = {ready: false, list: [], meta: null, imgs: {}, acc: 0, t: 0};

  function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  const hash = s => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
  const lerp = (a, b, t) => a + (b - a) * t;

  // ---------- town + walk grid (derived from world.json only) ----------
  function pickTown(W, meta) {
    const regs = W.regions || {};
    for (const k of [meta && meta.town_region, W.town]) if (k && regs[k]) return k;
    const deg = {};
    for (const [a, b] of W.graph.edges) { deg[a] = (deg[a] || 0) + 1; deg[b] = (deg[b] || 0) + 1; }
    const byNode = Object.entries(regs).map(([k, r]) => [k, deg[r.node] || deg[k] || 0]).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    return byNode.length ? byNode[0][0] : null;
  }
  function footprints(W) {
    const out = [];
    for (const p of W.props || []) {
      if (p.src === 'buildings') out.push([p.x - p.w * .46, p.y - p.h, p.x + p.w * .46, p.y + 6]);                  // whole sprite: nobody hides behind it
      else if (SOLID.has(p.img)) { const hw = TRUNK.has(p.img) ? Math.min(p.w * .25, 9) : p.w * .4; out.push([p.x - hw, p.y - 6, p.x + hw, p.y + 3]); }
    }
    return out;
  }
  function buildArea(W, townKey) {
    const [sx, sy] = W.regions[townKey].spot, rects = footprints(W);
    const segs = W.graph.edges.map(([a, b]) => [W.graph.pts[a], W.graph.pts[b]]).filter(([a, b]) =>
      Math.min(Math.hypot(a[0] - sx, a[1] - sy), Math.hypot(b[0] - sx, b[1] - sy)) < TOWN.rx + 200);
    const busy = {x: sx + 8, y: sy + 18, rx: 132, ry: 58};                     // hero home band + hangout ring + fight yard (game.js slotPos/hangSpot): keep clear
    const x0 = Math.floor(sx - TOWN.rx), y0 = Math.floor(sy - TOWN.ry), nx = Math.ceil(TOWN.rx * 2 / CELL), ny = Math.ceil(TOWN.ry * 2 / CELL);
    const grid = new Uint8Array(nx * ny);
    const roadD = (x, y) => { let best = 1e9; for (const [a, b] of segs) { const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy || 1, t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L)); best = Math.min(best, Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy)); } return best; };
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const x = x0 + (i + .5) * CELL, y = y0 + (j + .5) * CELL;
      if (((x - sx) / (TOWN.rx - CELL)) ** 2 + ((y - sy) / (TOWN.ry - CELL)) ** 2 >= 1) continue;   // one cell inside the zone: a whole cell stays in town
      if (((x - sx) / PLAZA.rx) ** 2 + ((y - sy) / PLAZA.ry) ** 2 >= 1 && roadD(x, y) > ROAD_HALF - CELL) continue;
      if (((x - busy.x) / busy.rx) ** 2 + ((y - busy.y) / busy.ry) ** 2 < 1) continue;
      if (rects.some(r => x > r[0] - PAD && x < r[2] + PAD && y > r[1] - PAD && y < r[3] + PAD)) continue;
      grid[j * nx + i] = 1;
    }
    return {x0, y0, nx, ny, grid, spot: [sx, sy], key: townKey};
  }
  function walkable(x, y) {
    const A = S.area; if (!A) return false;
    const i = Math.floor((x - A.x0) / CELL), j = Math.floor((y - A.y0) / CELL);
    return i >= 0 && j >= 0 && i < A.nx && j < A.ny && A.grid[j * A.nx + i] === 1;
  }
  function clear(a, b) {                              // straight leg stays on walkable cells
    const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) * 10);   // sample every 0.1 px: a walker (<= 0.8 px/step) cannot clip a cell corner
    for (let k = 0; k <= n; k++) if (!walkable(lerp(a[0], b[0], k / n), lerp(a[1], b[1], k / n))) return false;
    return true;
  }
  function buildNodes() {
    const A = S.area, nodes = [], idx = new Map();
    const o = CELL / 2;                                  // nodes sit on cell centres: never on the border between walkable and blocked cells
    for (let y = A.y0 + o; y < A.y0 + A.ny * CELL; y += LATTICE)
      for (let x = A.x0 + o; x < A.x0 + A.nx * CELL; x += LATTICE)
        if (walkable(x, y)) { idx.set(x + ',' + y, nodes.length); nodes.push({x, y, adj: []}); }
    for (const n of nodes) for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1], [-1, 0], [0, -1], [-1, -1], [-1, 1]]) {
      const m = idx.get((n.x + dx * LATTICE) + ',' + (n.y + dy * LATTICE));
      if (m !== undefined && clear([n.x, n.y], [nodes[m].x, nodes[m].y])) n.adj.push(m);
    }
    // keep only the biggest connected piece so every target is reachable from every spawn
    const comp = new Array(nodes.length).fill(-1); let best = [], c = 0;
    for (let s = 0; s < nodes.length; s++) {
      if (comp[s] >= 0) continue; const q = [s], members = []; comp[s] = c;
      while (q.length) { const u = q.pop(); members.push(u); for (const v of nodes[u].adj) if (comp[v] < 0) { comp[v] = c; q.push(v); } }
      if (members.length > best.length) best = members; c++;
    }
    const keep = new Set(best), remap = new Map(); best.sort((a, b) => a - b).forEach((o, i) => remap.set(o, i));
    S.nodes = best.map(o => ({x: nodes[o].x, y: nodes[o].y, adj: nodes[o].adj.filter(v => keep.has(v)).map(v => remap.get(v))}));
  }
  function route(from, toIdx) {                        // Dijkstra over the lattice, then string-pull into straight legs
    const N = S.nodes, start = nearest(from);
    const dist = new Float64Array(N.length).fill(1e18), prev = new Int32Array(N.length).fill(-1), done = new Uint8Array(N.length);
    dist[start] = 0;
    for (;;) {
      let u = -1; for (let i = 0; i < N.length; i++) if (!done[i] && dist[i] < 1e17 && (u < 0 || dist[i] < dist[u])) u = i;
      if (u < 0 || u === toIdx) break; done[u] = 1;
      for (const v of N[u].adj) { const d = dist[u] + Math.hypot(N[u].x - N[v].x, N[u].y - N[v].y); if (d < dist[v]) { dist[v] = d; prev[v] = u; } }
    }
    const chain = []; for (let n = toIdx; n >= 0; n = prev[n]) chain.unshift([N[n].x, N[n].y]);
    const out = []; let cur = from, i = 0;
    while (i < chain.length) {
      let j = chain.length - 1; while (j > i && !clear(cur, chain[j])) j--;
      out.push(chain[j]); cur = chain[j]; i = j + 1;
    }
    return out;
  }
  function nearest(p) { let b = 0, bd = 1e18; S.nodes.forEach((n, i) => { const d = Math.hypot(n.x - p[0], n.y - p[1]); if (d < bd) { bd = d; b = i; } }); return b; }

  // ---------- simulation ----------
  const between = (rng, [a, b]) => a + rng() * (b - a);
  function pickTarget(n) {
    for (let k = 0; k < 12; k++) {
      const i = Math.floor(S.rng() * S.nodes.length), t = S.nodes[i];
      if (Math.hypot(t.x - n.x, t.y - n.y) > 70) { n.path = route([n.x, n.y], i); n.state = 'walk'; return; }
    }
    n.rest = between(S.rng, CFG[n.kind].rest);            // nowhere far enough: just rest again
  }
  function stepNpc(n, dt) {
    n.clock += dt;
    if (n.state === 'rest') {
      n.v = 0;
      if ((n.rest -= dt) <= 0) { if (S.rng() < .25) n.face = -n.face; pickTarget(n); }
      return;
    }
    if (!n.path.length) { n.state = 'rest'; n.rest = between(S.rng, CFG[n.kind].rest); return; }
    const [tx, ty] = n.path[0], dx = tx - n.x, dy = ty - n.y, d = Math.hypot(dx, dy);
    if (d < 1e-6) { n.path.shift(); if (!n.path.length) { n.state = 'rest'; n.rest = between(S.rng, CFG[n.kind].rest); n.v = 0; } return; }
    const left = n.path.reduce((s, p, i, a) => s + Math.hypot(p[0] - (i ? a[i - 1][0] : n.x), p[1] - (i ? a[i - 1][1] : n.y)), 0);
    n.v = lerp(n.v, CFG[n.kind].speed * (left < 10 ? Math.max(.4, left / 10) : 1), 1 - Math.exp(-dt * 6));
    const st = Math.min(d, n.v * dt);
    n.x += dx / d * st; n.y += dy / d * st; n.dist += st;
    if (Math.abs(dx) > .3) n.face = dx > 0 ? 1 : -1;
  }
  function init(W, meta, npcMeta) {
    S.ready = false; S.list = []; S.acc = 0; S.t = 0;
    const m = npcMeta && npcMeta.npcs; if (!W || !W.graph || !m) return false;
    const town = pickTown(W, meta); if (!town) return false;
    S.meta = m; S.town = town; S.area = buildArea(W, town); buildNodes();
    if (S.nodes.length < 8) return false;
    S.rng = mulberry32(SEED ^ hash(town));
    for (let i = 0; i < COUNT; i++) {
      const kind = KINDS[i % KINDS.length], n0 = S.nodes[Math.floor(S.rng() * S.nodes.length)];
      S.list.push({id: 'npc' + i, kind, x: n0.x, y: n0.y, face: S.rng() < .5 ? 1 : -1, dist: S.rng() * 40, v: 0, state: 'rest',
        rest: S.rng() * 3, path: [], clock: S.rng() * 5, k: i});
    }
    S.ready = true; return true;
  }
  async function load(W, D, img) {
    try {
      const meta = await fetch('assets/px/npcs/meta.json').then(r => r.ok ? r.json() : null);
      if (!meta || !init(W, D.meta, meta)) return;
      for (const k of Object.keys(meta.npcs)) S.imgs[k] = await img('assets/px/npcs/' + meta.npcs[k].file);
    } catch (e) { S.ready = false; }
  }
  function update(dt) {
    if (!S.ready) return;
    S.acc = Math.min(S.acc + dt, STEP * 6);
    while (S.acc >= STEP - 1e-9) { S.acc -= STEP; S.t += STEP; for (const n of S.list) stepNpc(n, STEP); if (S.onStep) S.onStep(); }
  }

  // ---------- draw (y-sorted together with heroes and monsters by game.js) ----------
  function drawOne(v, n, blit, shadowPx) {
    const M = S.meta[n.kind], im = S.imgs[n.kind]; if (!im || !M) return;
    const walking = n.state === 'walk' && n.v > 1, WK = M.frames.walk, k = WK.length, sc = M.scale_vs_hero || 1;
    let fr, bob = 0;
    if (walking) { const i = Math.floor(n.dist / (10 * sc)) % k; fr = WK[i]; bob = i % 2 ? 1 : 0; }   // contact frames dip 1 px
    else { fr = M.frames.idle[0]; bob = Math.floor((n.clock + n.k * .37) % 1.6 / .8); }          // 1 px breathing bob
    const bx = Math.round(n.x), by = Math.round(n.y) + bob;
    const flip = (M.native_facing || 'right') === 'right' ? n.face < 0 && M.mirror_left !== false : n.face > 0;   // sheet faces right; left = mirror
    shadowPx(v, bx, Math.round(n.y) + 1, Math.round(M.fw * .13));
    blit(v, im, fr * M.fw, 0, M.fw, M.fh, flip ? bx - (M.fw - M.ax) : bx - M.ax, by - M.base, flip);
  }
  function ents(v, blit, shadowPx) { return S.ready ? S.list.map(n => ({y: n.y, f: () => drawOne(v, n, blit, shadowPx)})) : []; }

  const NPCS = {init, load, update, ents, walkable, state: S, STEP, CFG, KINDS, PLAZA, TOWN, ROAD_HALF, COUNT};
  if (typeof module !== 'undefined' && module.exports) module.exports = NPCS; else root.NPCS = NPCS;
})(typeof window !== 'undefined' ? window : globalThis);
