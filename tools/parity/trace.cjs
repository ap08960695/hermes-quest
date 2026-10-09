'use strict';
// Deterministic frame trace of the headless simulation (dt 1/60, same loop shape and caps as tools/backtest.js).
const crypto = require('node:crypto');
const {load} = require('./loader.cjs');
const r4 = v => v; // Exact IEEE-754 values: no tolerance or quantization.
function frameLine(G, timers) {
  const S = G.S, hs = Object.keys(S.heroes).sort(), ts = Object.keys(S.tasks).sort();
  return JSON.stringify([S.t, S.rt, S.vault, S.mana, S.tokenNetByWallet || null, S.tokenNetByBot || null, S.later.map(p=>p.at), timers,
    hs.map(k => { const h = S.heroes[k]; return [k, r4(h.x), r4(h.y), r4(h.dist), h.path.length, h.path.length ? h.path[h.path.length - 1].map(r4) : null,
      h.path, h.task, h.rest, h.face, r4(h.hurt), r4(h.v), !!h.sleep]; }),
    ts.map(k => { const t = S.tasks[k]; return [k, t.state, r4(t.x), r4(t.y), r4(t.mx), r4(t.my), r4(t.hp), t.region, r4(t.alpha)]; }), S.fx]);
}
function trace({root, seed, legacy = false}) {
  const {G, D, timers} = load({root, seed, legacy});
  G.S.speed = 120; G.S.play = true; G.reset(D.meta.from_);
  const h = crypto.createHash('sha256'), samples = [], dt = 1 / 60;
  let frames = 0, fired = 0;
  while (G.S.t < D.meta.to + 30 && frames < 60 * 60 * 30) {
    G.update(dt); frames++;
    for (let i = timers.length - 1; i >= 0; i--) if ((timers[i][0] -= dt) <= 0) { const f = timers[i][1]; timers.splice(i, 1); f(); fired++; }
    h.update(frameLine(G, fired) + '\n');
    if (frames % 1000 === 0) samples.push([frames, h.copy().digest('hex').slice(0, 16)]);
  }
  return {seed: String(seed), frames, timers_fired: fired, events_applied: G.S.i, digest: h.digest('hex'), samples,
    final: JSON.parse(frameLine(G, fired))};
}
module.exports = {trace};
