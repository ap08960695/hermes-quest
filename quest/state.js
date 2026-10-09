'use strict';
// Owns state; peer bindings stay live on the per-game context. Registration never boots.
(globalThis.HQModules ||= {}).createState = function createState(ctx) {
const S = {t: 0, i: 0, speed: 120, play: true, heroes: {}, tasks: {}, fx: [], feed: [], mana: {}, vault: 0,
  trauma: 0, stop: 0, lastFeed: {}};
const cam = {x: 1000, y: 700, tx: 1000, ty: 700, zi: 1};
function emptyState() {
  return {i: 0, heroes: {}, tasks: {}, fx: [], feed: [], vault: 0, trauma: 0, stop: 0,
    lastFeed: {}, soc: {}, later: [], rt: 0, mana: {claude: 100, codex: 100, agy: 100}, ...ctx.CUI.empty()};
}
function syncMetadata(includeNew = true) {
  for (const b of ctx.D.bots) {
    if (b.entity_type === 'actor') { delete S.heroes[b.id]; continue; }
    if (!includeNew && !S.heroes[b.id]) continue;
    const h = hero(b.id);
    if (h.home !== b.region) { h.home = b.region; h.homeK = Object.values(S.heroes).filter(other => other !== h && other.home === b.region).length; }
    Object.assign(h, {name: b.name, cls: b.cls, availability: b.availability, wallet: b.wallet || h.wallet, model: b.model || '', effort: b.effort || 'medium', st: ctx.mstyle(b.model), eff: ctx.EFF[b.effort] || ctx.EFF.medium});
  }
  for (const t of ctx.D.tasks) if (S.tasks[t.id]) {
    // Snapshot metadata must not overwrite event-derived historical state.
    for (const k of ['title', 'campaign', 'max_rt', 'stage', 'parents']) S.tasks[t.id][k] = t[k];
  }
}

// ---------- state ----------
function hero(bot) {
  if (ctx.D.bots.some(b => b.id === bot && b.entity_type === 'actor')) return null;
  if (!S.heroes[bot]) {
    const b = ctx.D.bots.find(x => x.id === bot) || {id: bot, name: bot, cls: 'mage', region: ctx.defaultRegion(), wallet: ''};
    const home = b.region, k = Object.values(S.heroes).filter(h => h.home === home).length;
    const [x, y] = ctx.slotPos(home, k, 'home');
    S.heroes[bot] = {bot, name: b.name, cls: b.cls, wallet: b.wallet, home, homeK: k, x, y, region: home, path: [],
      st: ctx.mstyle(b.model), eff: ctx.EFF[b.effort] || ctx.EFF.medium, model: b.model || '', effort: b.effort || 'medium', charge: 0,
      v: 0, dist: 0, face: 1, task: null, q: [], atk: -1, hurt: 0, sleep: false, down: 0, bubble: null, combo: 0, fam: [],
      idle: 3 + Math.random() * 10, act: null, cheer: 0, talk: 0,
      rest: {state: 'active-unobserved', why: '', savedTask: null, target: null, generation: 0, slot: null, phase: 'idle'}};
    const h = S.heroes[bot], spot = ctx.placeEntity(h, home);
    if (spot) [h.x, h.y] = spot;
  }
  return S.heroes[bot];
}
function task(id) {
  if (!S.tasks[id]) {
    const t = ctx.D.tasks.find(x => x.id === id) || {id, title: id, stage: 'BUILD', campaign: 'misc', max_rt: 1800};
    S.tasks[id] = {...t, state: 'quest', hp: 1, flash: 0, x: 0, y: 0, region: null, slot: 0, alpha: 0, bornT: 0,
      chained: false, note: '', runStart: null};
  }
  return S.tasks[id];
}
return {
  get S(){return S},
  get cam(){return cam},
  get emptyState(){return emptyState}, set emptyState(v){emptyState=v},
  get syncMetadata(){return syncMetadata}, set syncMetadata(v){syncMetadata=v},
  get hero(){return hero}, set hero(v){hero=v},
  get task(){return task}, set task(v){task=v}
};
};
