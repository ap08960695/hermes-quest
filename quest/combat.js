'use strict';
// Owns combat; peer bindings stay live on the per-game context. Registration never boots.
(globalThis.HQModules ||= {}).createCombat = function createCombat(ctx) {

// Working fights are a presentation of observed activity, not a second simulation.
// One game damage point = one real tool call or assistant message (never tokens/rewards).
// The task/run binding prevents a shared bot's other quest from borrowing its hits.
const workCombat = new Map();
let workEvents=[];
function clearWorkCombat(){workCombat.clear();workEvents=[];}
function observeWork(e, animate) {
  if (!animate || !ctx.S.work?.has || !['tool','activity'].includes(e.kind)) return;
  // Bind on the next frame, after mergeDelta commits its authoritative work snapshot.
  workEvents.push(e);
}
function stepWorkCombat(dt) {
  for(const e of workEvents){
    const item=ctx.S.work.active().find(i=>i.worker_observed&&i.task_ref===e.task&&i.bot_ref===e.bot);
    if(!item||(item.started_at!=null&&e.t<item.started_at))continue;
    let a=workCombat.get(item.ref);
    if(!a||a.run!==item.run_ref){a={run:item.run_ref,pending:[],atk:-1,flash:0,hit:0,combo:0,last:-Infinity,total:0};workCombat.set(item.ref,a);}
    a.combo=e.t-a.last<=5&&e.t>=a.last?a.combo+1:1;a.last=e.t;a.pending.push(a.combo);
  }
  workEvents=[];
  for(const [ref,a] of workCombat){
    const item=ctx.S.work.item(ref);
    if(!item||item.status!=='running'||item.run_ref!==a.run){workCombat.delete(ref);continue;}
    if(!ctx.S.play)continue;
    a.flash=Math.max(0,a.flash-dt);a.hit=Math.max(0,a.hit-dt);
    if(a.atk<0){if(a.pending.length){a.currentCombo=a.pending.shift();a.atk=0;}}
    else {const before=a.atk;a.atk+=dt;
      if(before<.22&&a.atk>=.22){a.flash=.18;a.hit=1.1;a.total++;a.hitCombo=a.currentCombo;}
      if(a.atk>=.65)a.atk=-1;
    }
  }
}

// ---------- FX ----------
function num(x, y, text, color, life = 1.1) { ctx.S.fx.push({k: 'num', x, y, text, color, life, max: life}); }
function burst(x, y, color, n) { if (ctx.calm) n = Math.ceil(n / 3); for (let i = 0; i < n; i++) ctx.S.fx.push({k: 'p', x, y, vx: (Math.random() - .5) * 90, vy: -Math.random() * 90, color, life: .5 + Math.random() * .4}); }
function coins(x, y) { const [vx, vy] = ctx.W.regions.vault.spot; for (let i = 0; i < 8; i++) ctx.S.fx.push({k: 'coin', x, y, x0: x, y0: y, x1: vx + (Math.random() - .5) * 30, y1: vy - 10, life: 1.2 + i * .06, max: 1.2 + i * .06}); }
function portal(t) { ctx.S.fx.push({k: 'portal', x: t.x - 34, y: t.y, life: 2.2, max: 2.2}); }
function raven(t) { const [x, y] = ctx.spotOf(ctx.regionOf(ctx.captainId())); ctx.S.fx.push({k: 'raven', x0: x, y0: y - 40, x1: t.x, y1: t.y - 40, life: 1.6, max: 1.6}); }
// Order courier: a scroll (or other icon) flies from the Captain to the recipient. Lifetime scales with the distance so a long
// walk across the map stays visible; returns the flight time so callers can schedule the arrival.
function courier(x0, y0, x1, y1, {icon = '📜'} = {}) {
  const life = Math.max(1.2, Math.min(3.2, Math.hypot(x1 - x0, y1 - y0) / 140));
  ctx.S.fx.push({k: 'raven', x0, y0, x1, y1, life, max: life, icon});
  return life;
}
// Victory + loot for one real completion: coins fly to the vault, QUEST CLEAR! floats up, a gold ring and sparks mark the spot.
// Presentation only: it never touches the vault counter, XP, gold or any task.
function victory(x, y) {
  coins(x, y); num(x, y - 36, 'QUEST CLEAR!', '#ffd36b', 1.6);
  ctx.S.fx.push({k: 'ring', x, y: y - 10, color: '#ffd36b', r: 30, life: .5, max: .5});
  burst(x, y - 14, '#ffd36b', 12);
  ctx.S.trauma = Math.min(1, ctx.S.trauma + .12);
}
// Class-specific attacks. Melee hits land on the impact frame; ranged attacks fire a projectile on the
// impact frame and the hit (flash, knockback, numbers) lands when it arrives. The tool label rides on the hit.
const ATTACK = {
  warrior: {kind: 'slash', color: '#f4f0e6', glow: '#ff6a3a'},
  paladin: {kind: 'smite', color: '#ffe27a', glow: '#fff6c8'},
  engineer: {kind: 'proj', proj: 'gear', color: '#c9b27a', speed: 380, glow: '#ffd36b'},
  sage: {kind: 'proj', proj: 'rune', color: '#7dff9a', speed: 300, glow: '#c8ffd4'},
  mage: {kind: 'proj', proj: 'orb', color: '#5ab8ff', speed: 340, glow: '#d8f0ff'},
  ranger: {kind: 'proj', proj: 'arrow', color: '#e8dcc0', speed: 620, glow: '#ffffff'},
  commander: {kind: 'slash', color: '#ffd36b', glow: '#fff'}};
function toolLabel(e) {
  const tool = e.tool;
  if (tool === 'patch' || tool === 'write_file') return [`+${e.plus || 1} −${e.minus || 0}`, '#ffe08a'];
  if (tool === 'terminal') { const c = e.cat || 'shell'; return [ctx.CAT_ICON[c] + ' ' + c, '#fff']; }
  if (tool === 'tests') return [`✔ ${e.passed}`, '#7dffa0'];
  return [ctx.TOOL_ICON[tool] || '✦', '#fff'];
}
function heroAccent(h) { const im = ctx.SPRV[`${h.cls}-${(h.st || ctx.NO_STYLE).tag}`] || ctx.SPR[h.cls]; return im ? ctx.accent(im) : {}; }
function landHit(h, t, e, a0, ix, iy) {
  if (!ctx.canStrike(h,t,e)) return;
  const firstFx=ctx.S.fx.length;
  const st = {...(h.st || ctx.NO_STYLE), ...heroAccent(h)}, ef = h.eff || ctx.EFF.medium, crit = Math.random() < ef.crit;
  const a = {...a0, color: a0.kind === 'proj' ? st.color : a0.color, glow: st.glow};
  t.flash = .09 * ef.mult; t.kick = Math.min(1.6, ef.mult * (crit ? 1.4 : 1));
  ctx.S.trauma = Math.min(1, ctx.S.trauma + (a.kind === 'smite' ? .12 : .06) * ef.mult * (crit ? 2 : 1));
  if (crit) { ctx.S.stop = .05; num(ix, iy - 34, 'CRIT!', st.color, 1.2); }
  if (st.el === 'storm') ctx.S.fx.push({k: 'bolt', x: ix, y: iy, color: st.color, life: .2, max: .2});
  if (st.el === 'frost') ctx.S.fx.push({k: 'ring', x: ix, y: iy, color: '#e6f0ff', r: 14, life: .35, max: .35});
  if (st.el === 'fire' || st.el === 'holy' || st.el === 'arcane') burst(ix, iy - 4, st.color, Math.round(4 * ef.mult));
  if (a.kind === 'slash') ctx.S.fx.push({k: 'slash', x: ix, y: iy, dir: h.face, color: a.color, glow: st.color, life: .22, max: .22, big: ef.mult});
  else if (a.kind === 'smite') ctx.S.fx.push({k: 'pillar', x: ix, y: t.y, color: a.color, life: .45, max: .45});
  else ctx.S.fx.push({k: 'ring', x: ix, y: iy, color: a.glow, r: a.proj === 'orb' ? 18 : 11, life: .3, max: .3});
  burst(ix, iy, a.glow, a.kind === 'proj' ? 6 : 9);
  const [txt, col] = toolLabel(e); num(ix, iy - 18, txt, col, e.tool === 'tests' ? 1.4 : 1.1);
  if (h.combo > 1) { num(h.x, h.y - ctx.HERO_H - 14, `COMBO x${h.combo}`, '#7fc8ff', .9); h.combo = 0; }
  if(ctx.S.work?.has)for(const f of ctx.S.fx.slice(firstFx))f.task_ref=t.id;
}
function strike(h, t, e) {
  if (!ctx.canStrike(h,t,e)) return;
  const a = ATTACK[h.cls] || ATTACK.warrior, ix = t.x - 6, iy = t.y - 22;
  if (a.kind !== 'proj') return landHit(h, t, e, a, ix, iy);
  const st = {...(h.st || ctx.NO_STYLE), ...heroAccent(h)}, sx = h.x + 22 * h.face, sy = h.y - 34, dur = Math.max(.12, Math.hypot(ix - sx, iy - sy) / (a.speed * st.speed));
  ctx.S.fx.push({k: 'proj', proj: a.proj, x0: sx, y0: sy, x1: ix, y1: iy, color: st.color, glow: st.glow, life: dur, max: dur, big: (h.eff || ctx.EFF.medium).mult,
    arc: a.proj === 'arrow' ? 16 : a.proj === 'gear' ? 24 : 0,
    ...(ctx.S.work?.has?{task_ref:t.id,bot_ref:h.bot}:{})});
  ctx.laterHero(h, dur, () => landHit(h, t, e, a, ix, iy));
}
const GESTURE = {read: ['📜', '#cfd8ea'], scout: ['🔍', '#cfd8ea'], tome: ['📖', '#c8b0ff'], crystal: ['🔮', '#9fd3ff'],
  memory: ['🗝', '#ffd36b'], pigeon: ['🕊', '#ffffff'], spawn: ['🐣', '#ffcf6b'], commit: ['⚒ commit', '#ffe08a'],
  push: ['🎈 push', '#9fd3ff'], merge: ['⚔ merge', '#ffb36b']};
function gesture(h, e, kind) {
  if (ctx.restLocked(h)) return;
  const [icon, col] = GESTURE[kind] || GESTURE.read;
  h.gest = {icon, until: kind === 'read' || kind === 'scout' ? .8 : 1.3};
  if (kind === 'push') ctx.S.fx.push({k: 'balloon', x: h.x, y: h.y - 40, life: 2.2, max: 2.2});
  else if (kind === 'commit') { h.cheer = .5; ctx.S.fx.push({k: 'ring', x: h.x, y: h.y - 30, color: '#ffe08a', r: 16, life: .4, max: .4}); }
  else if (kind === 'merge') { burst(h.x, h.y - 40, '#ffb36b', 10); }
  else if (kind === 'pigeon') ctx.S.fx.push({k: 'raven', x0: h.x, y0: h.y - 40, x1: ctx.W.regions.castle.spot[0], y1: ctx.W.regions.castle.spot[1] - 60, life: 1.4, max: 1.4, icon: '🕊'});
  if (kind !== 'read' && kind !== 'scout') num(h.x, h.y - ctx.HERO_H - 4, icon, col, 1.1);
}
// Monster counter-attacks: melee monsters lunge (their sheet), golems slam a shockwave, slimes/ghosts spit.
const M_RANGED = {slime: {proj: 'glob', color: '#7ee05a', speed: 260}, ghost: {proj: 'wisp', color: '#b48cff', speed: 300}};
function monsterHit(t, h) {
  const kind = ctx.mtype(t), r = M_RANGED[kind], tx = h.x, ty = h.y - 26;
  const hit = () => { h.hurt = .35; h.knock = 1; ctx.S.trauma = Math.min(1, ctx.S.trauma + .15); burst(tx, ty, '#ff6b5a', 8);
    if (kind === 'golem') ctx.S.fx.push({k: 'ring', x: t.x - 20, y: t.y, color: '#d8b98a', r: 34, flat: true, life: .4, max: .4}); };
  if (!r) return ctx.laterHero(h, .26, hit);
  const sx = t.x - 20, sy = t.y - 28, dur = Math.max(.15, Math.hypot(tx - sx, ty - sy) / r.speed);
  ctx.laterHero(h, .26, () => ctx.S.fx.push({k: 'proj', proj: r.proj, x0: sx, y0: sy, x1: tx, y1: ty, color: r.color, glow: '#fff', life: dur, max: dur, arc: 10}));
  ctx.laterHero(h, .26 + dur, hit);
}
return {
  get workCombat(){return workCombat},
  get clearWorkCombat(){return clearWorkCombat},
  get observeWork(){return observeWork},
  get stepWorkCombat(){return stepWorkCombat},
  get num(){return num}, set num(v){num=v},
  get burst(){return burst}, set burst(v){burst=v},
  get coins(){return coins}, set coins(v){coins=v},
  get portal(){return portal}, set portal(v){portal=v},
  get raven(){return raven}, set raven(v){raven=v},
  get courier(){return courier}, set courier(v){courier=v},
  get victory(){return victory}, set victory(v){victory=v},
  get ATTACK(){return ATTACK},
  get toolLabel(){return toolLabel}, set toolLabel(v){toolLabel=v},
  get heroAccent(){return heroAccent}, set heroAccent(v){heroAccent=v},
  get landHit(){return landHit}, set landHit(v){landHit=v},
  get strike(){return strike}, set strike(v){strike=v},
  get GESTURE(){return GESTURE},
  get gesture(){return gesture}, set gesture(v){gesture=v},
  get M_RANGED(){return M_RANGED},
  get monsterHit(){return monsterHit}, set monsterHit(v){monsterHit=v}
};
};
