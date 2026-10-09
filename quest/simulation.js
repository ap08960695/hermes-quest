'use strict';
// Owns simulation; peer bindings stay live on the per-game context. Registration never boots.
(globalThis.HQModules ||= {}).createSimulation = function createSimulation(ctx) {


// ---------- orders: the Captain sends a raven, the hero acknowledges, then sets out ----------
function later(sec, f) { ctx.S.later.push({at: ctx.S.rt + sec, f}); }

// ---------- update ----------
function update(dt) {
  if (ctx.S.stop > 0) { ctx.S.stop -= dt; return; }               // hit-stop freezes the world, not the UI
  if (ctx.S.play) {
    if (ctx.liveFeed && ctx.following) { ctx.S.t = Math.max(ctx.S.t, Date.now() / 1000); ctx.D.meta.to = Math.max(ctx.D.meta.to, ctx.S.t); }
    else ctx.S.t += dt * ctx.S.speed;
    let n = 0;
    while (ctx.S.i < ctx.D.events.length && ctx.D.events[ctx.S.i].t <= ctx.S.t && n++ < 400) ctx.apply(ctx.D.events[ctx.S.i++], true);
    if (!(ctx.liveFeed && ctx.following) && ctx.S.t > ctx.D.meta.to + 60) ctx.S.play = false;

  }
  ctx.S.rt += dt;
  for (const l of ctx.S.later.filter(l => l.at <= ctx.S.rt)) l.f();
  ctx.S.later = ctx.S.later.filter(l => l.at > ctx.S.rt);
  if (window.NPCS && ctx.S.play) NPCS.update(dt);                       // M4 villagers: own seeded RNG, fixed step
  ctx.social(dt);
  for (const h of Object.values(ctx.S.heroes)) stepHero(h, dt);
  for (const t of Object.values(ctx.S.tasks)) {
    if (t.dying) { t.dying -= dt * 1.1; if (t.dying <= 0) { t.dying = 0; t.alpha = 0; ctx.burst(t.x, t.y - 10, '#6b5a8e', 14); } }
    else if (t.alpha > 0 && t.alpha < 1) t.alpha = Math.min(1, t.alpha + dt * 2);
    t.flash = Math.max(0, t.flash - dt); t.kick = Math.max(0, (t.kick || 0) - dt * 4);
    if (t.emerge > 0) t.emerge -= dt;
    else if (t.mpath && t.mpath.length) {                // march along trail/road waypoints, eased into the final slot
      const [nx, ny] = t.mpath[0], dx = nx - t.mx, dy = ny - t.my, d = Math.hypot(dx, dy);
      const last = t.mpath.length === 1, st = Math.min(d, 55 * dt * (last ? Math.max(.35, Math.min(1, d / 30)) : 1));
      if (d < .6) { t.mpath.shift(); if (!t.mpath.length) { t.mpath = null; t.mx = undefined; if (t.state === 'fight') { t.roar = 1.2; } } }
      else { t.mx += dx / d * st; t.my += dy / d * st; t.mdist += st; if (Math.abs(dx) > .3) t.mface = dx > 0 ? 1 : -1; }
    }
    if (t.atk >= 0) { t.atk += dt; if (t.atk >= .5) t.atk = -1; }
    t.roar = Math.max(0, (t.roar || 0) - dt);
    if (t.state === 'fight' && t.runStart) t.hp = Math.max(.08, 1 - (ctx.S.t - t.runStart) / (t.max_rt || 1800));
  }
  ctx.S.fx = ctx.S.fx.filter(f => (f.life -= dt) > 0);
  for (const f of ctx.S.fx) if (f.k === 'p') { f.x += f.vx * dt; f.y += f.vy * dt; f.vy += 160 * dt; }
  ctx.S.trauma = Math.max(0, ctx.S.trauma - dt * 1.4);
  ctx.cam.x = ctx.lerp(ctx.cam.x, ctx.cam.tx, 1 - Math.exp(-dt * 5)); ctx.cam.y = ctx.lerp(ctx.cam.y, ctx.cam.ty, 1 - Math.exp(-dt * 5));
}
function stepHero(h, dt) {
  // Render-independent ambience: probabilities are rates calibrated at 60Hz.
  if (ctx.UI && !ctx.calm) {
    const st = {...(h.st || ctx.NO_STYLE), ...ctx.heroAccent(h)}, lv = ctx.LEVEL[h.effort] || 0;
    const fighting = h.task && ctx.S.tasks[h.task]?.state === 'fight' && h.path.length <= 1;
    const ep = ctx.EL_PARTICLE[st.el];
    if ((fighting || h.charge > 0) && ep && Math.random() < 1-Math.pow(.92,dt*60))
      ctx.S.fx.push({k:'p',x:h.x+(Math.random()-.5)*26,y:h.y-Math.random()*40,vx:(Math.random()-.5)*10,vy:ep[1]*30,color:ep[0],life:.6});
    if (lv >= 1 && Math.random() < 1-Math.pow(.95,dt*60))
      ctx.S.fx.push({k:'p',x:h.x+(Math.random()-.5)*24,y:h.y-20-Math.random()*30,vx:0,vy:-20,color:st.color,life:.5});
    if (lv >= 3 && Math.random() < 1-Math.pow(.75,dt*60))
      ctx.S.fx.push({k:'p',x:h.x+(Math.random()-.5)*30,y:h.y-Math.random()*20,vx:0,vy:-40,color:st.glow,life:.7});
  }
  h.hurt = Math.max(0, h.hurt - dt); h.down = Math.max(0, h.down - dt); h.knock = Math.max(0, (h.knock || 0) - dt * 3);
  h.meditate = Math.max(0, (h.meditate || 0) - dt); if (h.gest && (h.gest.until -= dt) <= 0) h.gest = null;
  for (const f of h.fam) if (!ctx.restLocked(h) && f.task && ctx.S.tasks[f.task] && ctx.S.tasks[f.task].state === 'fight' && Math.random() < dt * .6) { const t2 = ctx.S.tasks[f.task]; ctx.S.fx.push({k: 'proj', proj: 'orb', x0: h.x + Math.cos(f.a) * 34, y0: h.y - 46, x1: t2.x, y1: t2.y - 22, color: '#ffb36b', glow: '#fff', life: .35, max: .35, arc: 6}); ctx.laterHero(h, .35, () => { t2.flash = .05; ctx.burst(t2.x, t2.y - 22, '#ffb36b', 4); }); }
  if (h.bubble && (h.bubble.until -= dt) <= 0) h.bubble = null;
  h.fam = h.fam.filter(f => (f.life -= dt) > 0); for (const f of h.fam) f.a += dt * 3;
  if (h.down > 0) return;
  if (h.path.length > 1) {                                  // walk with eased speed, frames tied to distance
    const [nx, ny] = h.path[1], dx = nx - h.x, dy = ny - h.y, d = Math.hypot(dx, dy);
    const left = h.path.slice(1).reduce((s, p, i, a) => s + Math.hypot(p[0] - (i ? a[i - 1][0] : h.x), p[1] - (i ? a[i - 1][1] : h.y)), 0);
    const vmax = ctx.WALK_V * (left < 18 ? Math.max(.35, left / 18) : 1);
    h.v = ctx.lerp(h.v, vmax, 1 - Math.exp(-dt * 6));
    const step = Math.min(d, h.v * dt);
    if (d < .5) { h.path.shift(); if (h.path.length === 1) h.path = []; return; }
    h.x += dx / d * step; h.y += dy / d * step; h.dist += step;
    if (Math.abs(dx) > .3) h.face = dx > 0 ? 1 : -1;
    return;
  }
  h.v = 0; h.path = [];
  ctx.finishRestMotion(h);
  if (ctx.restLocked(h)) return;
  const t = h.task && ctx.S.tasks[h.task];
  if (t && t.state === 'fight') h.face = t.x >= h.x ? 1 : -1;
  if (h.atk >= 0) {                                         // anticipation .14 / swing .08 / impact .1 / recover .14
    if (h.charge > 0) { h.charge -= dt; return; }                  // effort: hold the wind-up while power gathers
    const prev = h.atk; h.atk += dt * (h.st ? h.st.speed : 1);       // model: faster models swing faster
    if (prev < .22 && h.atk >= .22 && t && h.cur && h.cur.tool !== 'order') ctx.strike(h, t, h.cur);
    if (h.atk >= .46) h.atk = -1;
  } else if (h.q.length && t && t.state === 'fight' && !h.meditate) { h.cur = h.q.shift(); h.atk = 0; h.charge = h.cls === 'commander' ? 0 : h.eff.charge; }
  else if (h.q.length && !t) h.q.length = 0;
}
function atkFrame(a) { const f = ctx.HMETA.atk; return a < .14 ? f[0] : a < .22 ? f[1] : a < .32 ? f[2] : f[3]; }
// lunge: pull back on anticipation, dash in on the swing, hold on impact, ease home on recover
function lunge(a) { return a < .14 ? -4 * ctx.ease(a / .14) : a < .22 ? ctx.lerp(-4, 12, ctx.ease((a - .14) / .08)) : a < .32 ? 12 : ctx.lerp(12, 0, ctx.ease((a - .32) / .14)); }
return {
  get later(){return later}, set later(v){later=v},
  get update(){return update}, set update(v){update=v},
  get stepHero(){return stepHero}, set stepHero(v){stepHero=v},
  get atkFrame(){return atkFrame}, set atkFrame(v){atkFrame=v},
  get lunge(){return lunge}, set lunge(v){lunge=v}
};
};
