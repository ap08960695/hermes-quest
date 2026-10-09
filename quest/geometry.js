'use strict';
// Owns geometry; peer bindings stay live on the per-game context. Registration never boots.
(globalThis.HQModules ||= {}).createGeometry = function createGeometry(ctx) {
function defaultRegion() { return validRegion(ctx.D.meta.regions?.commander || 'castle'); }
function validRegion(region) { return ctx.W.regions[region] ? region : (ctx.W.regions.castle ? 'castle' : Object.keys(ctx.W.regions)[0]); }

// ---------- world geometry ----------
// Road graph routing. Every walk starts by stepping onto the nearest road segment from where the figure
// physically stands, so a new order mid-walk never cuts across terrain.
function route(from, toNode, wild = false) {
  const G = ctx.W.graph, pts = G.pts, E = wild ? [...G.edges, ...(G.wild || [])] : G.edges;   // wild trails: monsters only
  let best = null;
  for (const [a, b] of E) {
    const A = pts[a], B = pts[b], dx = B[0] - A[0], dy = B[1] - A[1], L = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((from[0] - A[0]) * dx + (from[1] - A[1]) * dy) / L));
    const q = [A[0] + t * dx, A[1] + t * dy], d = Math.hypot(from[0] - q[0], from[1] - q[1]);
    if (!best || d < best.d) best = {d, q, a, b, ta: t};
  }
  const adj = {};
  for (const [a, b] of E) { const d = Math.hypot(pts[a][0] - pts[b][0], pts[a][1] - pts[b][1]); (adj[a] ||= []).push([b, d]); (adj[b] ||= []).push([a, d]); }
  const dist = {}, prev = {}, todo = new Set(Object.keys(pts));
  dist[best.a] = best.ta * Math.hypot(pts[best.b][0] - pts[best.a][0], pts[best.b][1] - pts[best.a][1]);
  dist[best.b] = (1 - best.ta) * Math.hypot(pts[best.b][0] - pts[best.a][0], pts[best.b][1] - pts[best.a][1]);
  while (todo.size) {
    let u = null; for (const n of todo) if (dist[n] !== undefined && (u === null || dist[n] < dist[u])) u = n;
    if (u === null || u === toNode) break; todo.delete(u);
    for (const [v, d] of adj[u] || []) if (dist[u] + d < (dist[v] ?? 1e18)) { dist[v] = dist[u] + d; prev[v] = u; }
  }
  const out = []; for (let n = toNode; n; n = prev[n]) out.unshift(pts[n]);
  return [best.q, ...out];
}
function spotOf(region) { return (ctx.W.regions[region] || ctx.W.lairs[region]).spot; }
function plazaOf(region) {
  const r = ctx.W.regions[region];
  return {center: r.plaza?.center || r.spot, standing: r.plaza?.standing || [PLAZA_RX, PLAZA_RY], node: r.plaza?.node || r.node || region};
}
function formation(region) {
  const r = ctx.W.regions[region]; if (!r?.plaza) return null;
  const {center: [x,y], standing: [rx,ry]} = plazaOf(region), slots = [];
  // 102 x 84 idle envelopes, shared by heroes AND monsters. No wrapping or
  // clamping several slots to the same ellipse edge when capacity is exhausted.
  for (let dy = -84; dy <= 84; dy += 84) for (let dx = -153; dx <= 153; dx += 102)
    if ((dx/rx)**2 + (dy/ry)**2 <= 1) slots.push([x+dx,y+dy]);
  return slots;
}
function placeEntity(entity, region) {
  const slots = formation(region);
  if (!slots) { entity.placement = null; return null; }
  if (entity.placement?.region === region) return slots[entity.placement.k] || plazaOf(region).center;
  const used = new Set([...Object.values(ctx.S.heroes), ...Object.values(ctx.S.tasks)]
    .filter(o => o !== entity && o.placement?.region === region && (!o.id || (o.alpha > 0 && !o.dying)))
    .map(o => o.placement.k));
  let k = 0; while (used.has(k)) k++;
  entity.placement = {region, k};
  return slots[k] || plazaOf(region).center;
}
function overflowed(entity) {
  const p = entity.placement;
  return !!p && p.k >= formation(p.region).length && !(entity.path?.length > 1 || entity.mpath);
}
function slotPos(region, k, kind) {
  const slots = formation(region); if (slots) return slots[k] || plazaOf(region).center;
  const [x, y] = spotOf(region);
  if (region === 'camp') return [x - 90 + (k % 6) * 36 + (Math.floor(k / 6) % 2) * 18, y + 40 + Math.floor(k / 6) * 22];   // war camp yard
  // plaza split: idle party waits in a band by the building door (top), fights use the bottom half
  if (kind === 'home') return [x - 72 + (k % 4) * 48 + (Math.floor(k / 4) % 2) * 24, y - 22 + Math.floor(k / 4) * 16];
  const row = Math.floor(k / 3);
  return [x + ((k % 3) - 1) * 56 + 50, y + 24 + row * 20];
}
function regionOf(bot, stage) { const b = ctx.D.bots.find(b => b.id === bot); return b ? validRegion(b.region) : validRegion(ctx.D.meta.stage_regions?.[stage] || defaultRegion()); }
const PLAZA_RX = 112, PLAZA_RY = 66;              // paved square per region (tools/terrain.py ellipse minus margin)
function inPlaza(region, [x, y]) {                // clamp a final standing spot into the region's plaza
  const {center: [cx_,cy_], standing: [rx,ry]} = plazaOf(region), dx = (x-cx_)/rx, dy = (y-cy_)/ry, r = Math.hypot(dx,dy);
  return r <= 1 ? [x,y] : [cx_+dx/r*rx*.97,cy_+dy/r*ry*.97];
}
function walkTo(h, region, spot) {
  if (h.placement?.region !== region) h.placement = null;
  // Leave a standing yard through its own road node. Its outer slots can be
  // closer to an unrelated road; projecting onto that road cuts across grass.
  const rest = ctx.W.regions[h.rest?.target], center = rest?.spot;
  const inside = center && Math.hypot((h.x-center[0])/PLAZA_RX,(h.y-center[1])/PLAZA_RY) <= 1;
  const yard = Object.keys(ctx.W.regions).find(key => {
    const r = ctx.W.regions[key]; if (!r.plaza) return false;
    const {center:[x,y],standing:[rx,ry]} = plazaOf(key);
    return ((h.x-x)/rx)**2 + ((h.y-y)/ry)**2 <= 1;
  });
  const exit = inside ? ctx.W.graph.pts[rest.node || h.rest.target] : yard && ctx.W.graph.pts[plazaOf(yard).node];
  const p = [...(exit ? [exit] : []), ...route(exit || [h.x, h.y], plazaOf(region).node)].map(q => q.slice());
  if (spot) p.push(inPlaza(region, spot));
  h.path = [[h.x, h.y], ...p]; h.region = region;
}
return {
  get defaultRegion(){return defaultRegion}, set defaultRegion(v){defaultRegion=v},
  get validRegion(){return validRegion}, set validRegion(v){validRegion=v},
  get route(){return route}, set route(v){route=v},
  get spotOf(){return spotOf}, set spotOf(v){spotOf=v},
  get plazaOf(){return plazaOf}, set plazaOf(v){plazaOf=v},
  get formation(){return formation}, set formation(v){formation=v},
  get placeEntity(){return placeEntity}, set placeEntity(v){placeEntity=v},
  get overflowed(){return overflowed}, set overflowed(v){overflowed=v},
  get slotPos(){return slotPos}, set slotPos(v){slotPos=v},
  get regionOf(){return regionOf}, set regionOf(v){regionOf=v},
  get PLAZA_RX(){return PLAZA_RX},
  get PLAZA_RY(){return PLAZA_RY},
  get inPlaza(){return inPlaza}, set inPlaza(v){inPlaza=v},
  get walkTo(){return walkTo}, set walkTo(v){walkTo=v}
};
};
