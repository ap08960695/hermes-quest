'use strict';
// Owns actions; peer bindings stay live on the per-game context. Registration never boots.
(globalThis.HQModules ||= {}).createActions = function createActions(ctx) {
const CUI = window.QuestCUI.create();   // difficulty = time budget
function spawnMonster(t, region) {
  if (t.region === region && t.alpha > 0) return;
  const used = Object.values(ctx.S.tasks).filter(o => o !== t && o.region === region && o.alpha > 0 && !o.dying).map(o => o.slot);
  let k = 0; while (used.includes(k)) k++;
  const born = t.alpha <= 0;
  const from = born ? ctx.W.lairs[ctx.LAIR_OF[ctx.mtype(t)]].spot : [t.mx ?? t.x, t.my ?? t.y];
  t.region = region; t.slot = k; [t.x, t.y] = ctx.placeEntity(t, region) || ctx.slotPos(region, k, 'battle');
  if (ctx.W.regions[region]) [t.x, t.y] = ctx.inPlaza(region, [t.x, t.y]);      // battle slots stay on the paved square
  t.mx = from[0]; t.my = from[1] + (born ? 8 : 0); t.mdist = t.mdist || 0;
  t.mpath = [...ctx.route([t.mx, t.my], ctx.W.regions[region] ? ctx.plazaOf(region).node : region, true), [t.x, t.y]];
  ctx.S.soc.marches = (ctx.S.soc.marches || 0) + 1;
  if (born) { ctx.S.soc.spawns = (ctx.S.soc.spawns || 0) + 1; t.alpha = .01; t.emerge = .9; ctx.S.fx.push({k: 'portal', x: from[0] + 34, y: from[1] + 6, life: 1.2, max: 1.2}); }
}
function goHome(h) { if (restLocked(h)) return; ctx.walkTo(h, h.home, ctx.placeEntity(h, h.home) || ctx.slotPos(h.home, h.homeK, 'home')); h.task = null; }
function engage(h, t) {
  if (restLocked(h) || t.bot !== h.bot || t.state !== 'fight') return;
  if (!t.region) spawnMonster(t, ctx.regionOf(h.bot, t.stage));
  h.task = t.id; ctx.walkTo(h, t.region, ctx.placeEntity(h, t.region) || [t.x - (ctx.RANGE[h.cls] || 72), t.y + 2]);
}

function reset(t, liveKeys = null) {
  const feed = ctx.S.feed, lastFeed = ctx.S.lastFeed, fx = ctx.S.fx;
  const activeBots = new Set(), activeTasks = new Set();
  ctx.restoreCheckpoint();
  if (liveKeys) Object.assign(ctx.S, {feed, lastFeed, fx});
  if (ctx.checkpoint) t = Math.max(t, ctx.checkpoint.t);
  ctx.syncMetadata();
  ctx.S.t = t;
  while (ctx.S.i < ctx.D.events.length && ctx.D.events[ctx.S.i].t <= t) {
    const event = ctx.D.events[ctx.S.i++], animate = !!liveKeys?.has(ctx.eventKey(event));
    const fxCount = ctx.S.fx.length;
    apply(event, animate);
    if (animate) { activeBots.add(event.bot); activeTasks.add(event.task); }
    else if (liveKeys) ctx.S.fx.length = fxCount; // historical portals are not live effects
  }
  for (const h of Object.values(ctx.S.heroes)) {         // snap: no walking during a scrub
    if (activeBots.has(h.bot)) continue;
    if (h.rest.phase === 'portal') finishPortal(h);
    if (h.path.length) { [h.x, h.y] = h.path[h.path.length - 1]; h.path = []; }
    finishRestMotion(h);
  }
  for (const k of Object.values(ctx.S.tasks)) if (k.alpha > 0 && !activeTasks.has(k.id)) { k.alpha = 1; k.mx = undefined; k.mpath = null; k.emerge = 0; }   // scrub: everyone already in place
  // scrub lands mid-day: about half the idle heroes are already out socialising (snapped, no walk)
  for (const h of Object.values(ctx.S.heroes)) if (!liveKeys && ctx.free(h) && !h.act && (h.homeK % 2 || ctx.friends(h.bot).length) && Math.random() < .6) {
    ctx.startHangout(h, ctx.HANGOUTS[Math.floor(Math.random() * ctx.HANGOUTS.length)]);
    if (h.path.length) { [h.x, h.y] = h.path[h.path.length - 1]; h.path = []; }
  }
  ctx.renderFeed(); ctx.renderCamps();
}

// ---------- events -> game actions (the action table; extend here) ----------
function cancelTaskActions(t) {
  for (const h of Object.values(ctx.S.heroes)) {
    h.q = h.q.filter(e => e.task !== t.id);
    h.fam = h.fam.filter(f => f.task !== t.id);
    if (h.rest.savedTask === t.id) h.rest.savedTask = null;
    if (h.task !== t.id) continue;
    h.rest.generation++; h.atk = -1; h.cur = null; h.charge = 0;
    goHome(h); h.task = null;
  }
}
function assignTask(t, bot) {
  if (!bot) return;
  if (t.bot !== bot) cancelTaskActions(t);
  t.bot = bot;
}
function canStrike(h, t, e) {
  return !restLocked(h) && ctx.S.tasks[t.id] === t && t.state === 'fight' && !t.dying &&
    t.bot === h.bot && h.task === t.id && e.task === t.id && e.bot === h.bot;
}
const ACTIONS = {
  created(e, fx, t) { t.state = 'quest'; if (t.bot && ctx.D.tasks.some(x => x.id === t.id)) spawnMonster(t, 'camp'); fx && ctx.say(`👹 New monster: <b>${ctx.esc(t.title)}</b>`, e.t, 'new' + t.id); },
  specified(e, fx, t) {},
  dependency_wait(e, fx, t) { t.state = 'caged'; if (t.bot && !t.region) spawnMonster(t, 'camp'); },
  promoted(e, fx, t) { if (t.state === 'caged') t.state = 'quest'; },
  assigned(e, fx, t) { assignTask(t, e.bot); },
  claimed(e, fx, t) { assignTask(t, e.bot); },
  run_start(e, fx, t) {
    cancelTaskActions(t); assignTask(t, e.bot);
    const h = ctx.hero(e.bot); t.state = 'fight'; t.runStart = e.t;
    if (!h) return;
    if (h.sleep) wake(h, fx);
    spawnMonster(t, ctx.regionOf(e.bot, t.stage));
    if (restLocked(h)) return;
    h.act = null;
    if (!fx) { engage(h, t); return; }
    ctx.order(h, t, e.t);
  },
  tool(e, fx, t) {
    const h = ctx.hero(e.bot); if (restLocked(h) || t.bot !== h.bot || h.task !== t.id || t.state !== 'fight') return;
    if (!fx) return;
    // only work that changes or tests something is an attack; reading, searching, git status/diff, skills,
    // web and memory lookups are gestures (icon + small effect) so the fight reads like the real session
    const g = e.git, attack = e.tool === 'patch' || e.tool === 'write_file' || e.tool === 'vision_analyze'
      || (e.tool === 'terminal' && (!g || g === 'commit' || g === 'merge' || g === 'push') && ['test', 'build', 'deploy', 'probe', 'shell', 'git'].includes(e.cat));
    if (g === 'commit' || g === 'push' || g === 'merge') ctx.gesture(h, e, g);
    else if (!attack) { if (Math.random() < (e.util === 'read' || e.util === 'scout' ? .12 : 1)) ctx.gesture(h, e, e.util || (g ? 'read' : 'read')); return; }
    if (h.q.length < 6) h.q.push(e); else h.combo++;
  },
  compress(e, fx, t) {
    const h = ctx.hero(e.bot); if (!fx || restLocked(h)) return;
    h.meditate = 1.8; h.q.length = 0; ctx.S.soc.compress = (ctx.S.soc.compress || 0) + 1;
    ctx.S.fx.push({k: 'swirl', x: h.x, y: h.y - 30, life: 1.6, max: 1.6});
    h.bubble = {text: `🧘 Context compressed ${e.before}→${e.after}`, until: 2.2};
    ctx.say(`🧘 ${ctx.nm(h)} compressed context ${e.before}→${e.after} messages`, e.t, 'cp' + h.bot, 300);
  },
  captain(e, fx, t) {
    const cap = ctx.S.heroes[ctx.captainId()]; if (!fx || !cap || restLocked(cap)) return;
    ctx.S.soc.captain = (ctx.S.soc.captain || 0) + 1;
    const LINE = {create: ['📌 New quest!', '#ffd36b'], reassign: ['🔁 Reassigned!', '#9fd3ff'], extend: ['⏳ More time', '#ffd36b'],
      unblock: ['🔨 Unblocked!', '#ff9f5a'], block: ['⛓ On hold', '#ff6b5a'], link: ['🔗 Linked', '#c8b0ff'], unlink: ['✂ Unlinked', '#c8b0ff'], note: ['✒', '#cfd8ea']}[e.act];
    if (e.act !== 'note' || Math.random() < .15) { cap.atk = 0; cap.cur = {tool: 'order'}; cap.bubble = {text: LINE[0], until: 1.6}; }
    if (e.act === 'extend' && t.alpha > 0) ctx.num(t.x, t.y - 46, '⏳ +time', '#ffd36b', 1.4);
    if (e.act === 'unblock' && t.alpha > 0) { ctx.burst(t.x, t.y - 20, '#ff9f5a', 14); ctx.S.fx.push({k: 'ring', x: t.x, y: t.y - 20, color: '#ffcf6b', r: 26, life: .4, max: .4}); }
    if (e.act === 'reassign' && e.bot) { const h = ctx.S.heroes[e.bot]; if (h) ctx.S.fx.push({k: 'raven', x0: cap.x, y0: cap.y - 50, x1: h.x, y1: h.y - 50, life: 1.3, max: 1.3}); }
    if (e.act !== 'note') ctx.say(`👑 Captain ${LINE[0]} ${ctx.esc(t.title)}`, e.t, 'cap' + e.act + t.id, 120);
  },
  tests(e, fx, t) { const h = ctx.hero(e.bot); if (fx && canStrike(h,t,e)) { h.q.push({...e, tool: 'tests'}); ctx.say(`🏹 ${ctx.nm(h)} passed ${e.passed.toLocaleString('en-GB')} tests`, e.t, 'ts' + t.id, 600); } },
  hurt(e, fx, t) { if (fx) { const h = ctx.hero(e.bot); if (t.state === 'fight' && t.alpha > 0 && !t.mpath) { t.atk = 0; ctx.S.soc.fightbacks = (ctx.S.soc.fightbacks || 0) + 1; ctx.monsterHit(t, h); return ctx.say(`💥 ${ctx.nm(h)} hit by ${ctx.mtype(t)} (exit ${e.code})`, e.t, 'hu' + h.bot, 900); } h.hurt = .35; ctx.num(h.x, h.y - ctx.HERO_H, `exit ${e.code}`, '#ff6b5a'); ctx.say(`💥 ${ctx.nm(h)} command failed (exit ${e.code})`, e.t, 'hu' + h.bot, 900); } },
  heartbeat(e, fx, t) { t.note = e.note || t.note; const h = t.bot && ctx.S.heroes[t.bot]; if (fx && h && e.note) { h.bubble = {text: e.note, until: 3.5}; ctx.say(`💬 ${ctx.nm(h)}: ${ctx.esc(e.note)}`, e.t, 'hb' + t.id, 900); } },
  commented(e, fx, t) {},
  comment(e, fx, t) {
    if (!fx) return;
    if (e.tag === '[failover]') { ctx.portal(t); ctx.say(`🌀 Quest handoff: ${ctx.esc(e.note.replace('[failover] ', ''))}`, e.t); }
    else if (e.tag === '[extend-done]') { ctx.num(t.x, t.y - 40, '⏳ +time', '#ffd36b'); ctx.say(`⏳ Quest time extended: ${ctx.esc(t.title)}`, e.t); }
    else if (e.author === ctx.captainId()) { ctx.raven(t); ctx.say(`🐦‍⬛ Captain: ${ctx.esc(e.note)}`, e.t, 'cap' + t.id, 600); }
  },
  summon(e, fx, t) {
    const h = ctx.hero(e.bot);
    if (!fx) return;
    h.fam.push({a: Math.random() * 6, life: 8, task: t.id}); ctx.burst(h.x + 10, h.y - 6, '#ffb36b', 12);
    ctx.S.fx.push({k: 'ring', x: h.x + 26, y: h.y - 10, color: '#ffb36b', r: 18, flat: true, life: .6, max: .6});
    h.bubble = {text: '🦊 Help requested!', until: 1.6};
    ctx.say(`🦊 ${ctx.nm(h)} summoned a subagent${e.note ? ': ' + ctx.esc(e.note) : ''}`, e.t);
  },
  moa(e, fx, t) { if (fx) { const h = ctx.hero(e.bot); ctx.S.fx.push({k: 'council', h, life: 4}); ctx.say(`✨ FABLE + ASTRA council advised ${ctx.nm(h)}`, e.t); } },
  review_requested(e, fx, t) { fx && ctx.say(`🛡️ Quest submitted for review: ${ctx.esc(t.title)}`, e.t); },
  blocked(e, fx, t) {
    cancelTaskActions(t);
    t.state = 'blocked'; t.chained = true; spawnMonster(t, 'volcano'); t.note = e.note || t.note;
    const h = t.bot && ctx.S.heroes[t.bot]; if (h && h.task === t.id) goHome(h);
    if (fx) { ctx.S.trauma = Math.min(1, ctx.S.trauma + .5); ctx.say(`⛓️ Quest blocked: <b>${ctx.esc(t.title)}</b> ${e.note ? '— ' + ctx.esc(e.note) : ''}`, e.t); }
  },
  block_loop_detected(e, fx, t) { ACTIONS.blocked(e, fx, t); },
  unblocked(e, fx, t) { t.chained = false; t.state = 'quest'; if (t.bot) spawnMonster(t, t.runStart ? ctx.regionOf(t.bot) : 'camp'); fx && ctx.say(`🔓 Quest unblocked: ${ctx.esc(t.title)}`, e.t); },
  run_end(e, fx, t) {
    const h = ctx.hero(e.bot);
    if (!h) return;
    if (t.bot === e.bot && t.state !== 'done') cancelTaskActions(t);
    if (e.outcome === 'rate_limited') { sleep(h, fx); return; }
    if (['timed_out', 'crashed', 'gave_up', 'interrupted'].includes(e.outcome)) {
      if (fx) { h.down = 1.2; ctx.num(h.x, h.y - ctx.HERO_H, '💀 ' + e.outcome, '#ff6b5a'); ctx.say(`💀 ${ctx.nm(h)} stopped (${e.outcome})`, e.t); }
      goHome(h);
    }
  },
  rate_limited(e, fx, t) {},
  wake(e, fx, t) { wake(ctx.hero(e.bot), fx); },
  completed(e, fx, t) {
    for (const h of Object.values(ctx.S.heroes)) { h.q = h.q.filter(e => e.task !== t.id); if (h.task === t.id) { h.atk = -1; h.cur = null; } }
    t.state = 'done'; ctx.S.vault++;
    if (fx) {
      t.flash = 1; t.dying = 1; ctx.S.stop = .07; ctx.S.trauma = Math.min(1, ctx.S.trauma + .35);
      ctx.coins(t.x, t.y - 10); ctx.num(t.x, t.y - 46, 'QUEST CLEAR!', '#ffd36b', 1.6);
      ctx.say(`🏆 Quest complete: <b>${ctx.esc(t.title)}</b>`, e.t);
      ctx.cheerAround(t);
    } else t.alpha = 0;
    const h = t.bot && ctx.S.heroes[t.bot]; if (h && h.task === t.id) { if (fx) laterHero(h, .9, () => { if (h.task === t.id) { h.task = null; ctx.handOff(t); if (!h.act) goHome(h); } }); else goHome(h); }
  },
  archived(e, fx, t) { cancelTaskActions(t); t.state = 'archived'; t.alpha = 0; t.chained = false; t.placement = null; t.mpath = null; t.dying = 0; },
};
function apply(e, fx) {
  const actor = e.bot && ctx.D.bots.some(b => b.id === e.bot && b.entity_type === 'actor');
  if (actor && ['mana','pause','resume','failover','tool','tests','hurt','compress','summon','moa','wake'].includes(e.kind)) return;
  if (applyBotEvent(e, fx)) return;
  if (!e.task) return;
  if (['tool','tests','hurt','compress','summon','moa'].includes(e.kind) && e.bot && restLocked(ctx.hero(e.bot))) return;
  const t = ctx.task(e.task);
  if (t.state === 'archived') return;
  (ACTIONS[e.kind] || (() => { if (fx && t.alpha > 0) ctx.num(t.x, t.y - 30, e.kind, '#8aa0c8', .8); }))(e, fx, t);
}
// Bot-level events never fabricate a task or transfer its ownership.
const REST_REASON = {limited: 'Rate limited', 'waiting-start': 'Waiting to start', unavailable: 'Unavailable'};
function diagnostic(message, fx = false, key = message) {
  ctx.S.diagnostics[message] = (ctx.S.diagnostics[message] || 0) + 1;
  if (fx) ctx.say(message, ctx.S.t, 'diagnostic:' + key, 0);
}
function restLocked(h) { return h.rest && (['paused', 'transferred'].includes(h.rest.state) || h.rest.phase === 'portal'); }
function laterHero(h, sec, callback) {
  const generation = h.rest.generation;
  ctx.later(sec, () => { if (h.rest.generation === generation && !restLocked(h)) callback(); });
}
function restGeometry(fx) {
  const region = ctx.W.regions.rest_inn ? 'rest_inn' : ctx.W.regions.inn ? 'inn' : null;
  if (region !== 'rest_inn') diagnostic('Rest camp unavailable; using the inn', fx);
  const data = ctx.W.regions[region], node = data?.node || region;
  if (!data || !ctx.W.graph?.pts[node] || !ctx.W.graph.edges?.length) {
    diagnostic('Rest geometry unavailable; staying in place', fx); return null;
  }
  return {region, node, data};
}
function restSpotClear(region, spot, occupied) {
  if (occupied.some(p => Math.hypot(p[0] - spot[0], p[1] - spot[1]) < 12)) return false;
  return !(ctx.W.props || []).some(p => {
    if (p.src === 'buildings') return spot[0] >= p.x - p.w * .46 && spot[0] <= p.x + p.w * .46 && spot[1] >= p.y - p.h && spot[1] <= p.y + 6;
    return ['tent','campfire','well','barrels','crates','cart','rock','rocks','oak','pine','pillar','fence'].includes(p.img) && Math.hypot(spot[0] - p.x, spot[1] - p.y) < 8;
  });
}
function allocateRestSlots(geometry) {
  const occupied = [], {region, data} = geometry;
  const resting = Object.values(ctx.S.heroes).filter(h => ['paused', 'transferred'].includes(h.rest.state)).sort((a,b) => a.bot < b.bot ? -1 : a.bot > b.bot ? 1 : 0);
  // Sorted IDs make slots deterministic independent of event delivery order.
  for (const h of resting) {
    let spot, slot;
    for (let k = 0; k < 256; k++) {
      const candidate = ctx.inPlaza(region, data.rest_spots?.[k] || ctx.hangSpot(region, k));
      if (restSpotClear(region, candidate, occupied)) { spot = candidate; slot = k; break; }
    }
    if (!spot) { diagnostic('Rest camp has no free safe slot'); h.path = []; h.rest.phase = 'resting'; continue; }
    occupied.push(spot);
    if (h.rest.slot === slot && h.rest.target === region && h.rest.spot?.every((v,i) => v === spot[i])) continue;
    h.rest.slot = slot; h.rest.target = region; h.rest.spot = spot; h.rest.phase = 'moving';
    walkRest(h, geometry, spot);
  }
}
function walkRest(h, geometry, spot) {
  const [cx_,cy_] = geometry.data.spot;
  if (Math.hypot((h.x-cx_)/ctx.PLAZA_RX,(h.y-cy_)/ctx.PLAZA_RY) <= 1) {
    // Slot reallocation or a repeated pause can start inside the camp.
    // Keep that short walk wholly in the plaza rather than detouring to
    // the nearest (possibly unrelated) road beyond its edge.
    h.path = [[h.x,h.y], ctx.inPlaza(geometry.region, spot)]; h.region = geometry.region; return;
  }
  const exit = ctx.W.regions[h.region]?.plaza?.center;
  const points = [...(exit ? [exit] : []), ...ctx.route(exit || [h.x,h.y], geometry.node)];
  // A disconnected graph must not produce a direct jump across unpaved terrain.
  if (points.length < 3 && Math.hypot(points[0][0] - ctx.W.graph.pts[geometry.node][0],points[0][1] - ctx.W.graph.pts[geometry.node][1]) > 1) {
    h.path = []; diagnostic('Rest route unavailable; staying in place'); return;
  }
  h.path = [[h.x,h.y], ...points.map(p => p.slice()), ctx.inPlaza(geometry.region, spot)]; h.region = geometry.region;
}
function pauseHero(h, kind, why, observed = true, fx = false) {
  h.placement = null;
  const savedTask = h.task || h.rest.savedTask;
  h.rest = CUI.transitionRest(h.rest, kind, {why, savedTask, observed});
  h.sleep = true; h.task = null; h.act = null; h.q = []; h.atk = -1; h.cur = null;
  h.charge = 0; h.fam = []; h.bubble = null; h.gest = null;
  const geometry = restGeometry(fx);
  if (geometry) allocateRestSlots(geometry);
  else { h.path = []; h.v = 0; h.rest.phase = 'resting'; h.rest.target = null; h.rest.slot = null; }
}
function resumeHero(h) {
  const saved = ctx.S.tasks[h.rest.savedTask];
  h.rest = CUI.transitionRest(h.rest, 'resume'); h.sleep = false; h.act = null; h.q = []; h.atk = -1;
  if (saved?.state === 'fight' && saved.bot === h.bot) engage(h, saved); else goHome(h);
  h.rest.savedTask = null;
}
function finishPortal(h) { h.rest.phase = 'returning'; goHome(h); }
function finishRestMotion(h) {
  if (h.path.length > 1) return;
  if (h.rest.phase === 'portal') finishPortal(h);
  else if (['moving','returning'].includes(h.rest.phase)) h.rest.phase = restLocked(h) ? 'resting' : 'idle';
}
function applyBotEvent(e, fx) {
  if (!['mana','pause','resume','failover'].includes(e.kind)) return false;
  if (!e.bot || typeof e.bot !== 'string') { diagnostic('Invalid bot event ignored', fx, ctx.eventKey(e)); return true; }
  if (e.kind === 'mana') {
    // Validate before creating even a hero for malformed token payloads.
    if (!Number.isSafeInteger(e.tokens) || (e.tokens < 0 && e.correction !== true)) { diagnostic('Invalid token event ignored', fx, ctx.eventKey(e)); return true; }
    if (!e.tokens) return true;
    const h = ctx.hero(e.bot), error = CUI.reduceMana(ctx.S, e, h.wallet);
    if (error) diagnostic(error, fx, ctx.eventKey(e));
    else if (fx) ctx.say(`🔮 ${ctx.nm(h)} token usage ${e.tokens > 0 ? '+' : ''}${e.tokens}${e.basis === 'chars' ? ' (text estimate)' : e.correction ? ' (usage correction)' : ''}`, e.t, 'mana:' + ctx.eventKey(e), 0);
    return true;
  }
  if (e.kind === 'pause' && !REST_REASON[e.why]) { diagnostic('Invalid rest reason ignored', fx, ctx.eventKey(e)); return true; }
  if (e.kind === 'failover' && (!e.other || typeof e.other !== 'string' || e.other === e.bot)) { diagnostic('Invalid switch event ignored', fx, ctx.eventKey(e)); return true; }
  const h = ctx.hero(e.bot);
  if (e.kind === 'resume') {
    resumeHero(h); if (fx) ctx.say(`☀️ ${ctx.nm(h)} resumed`, e.t, 'resume:' + ctx.eventKey(e), 0);
  } else {
    pauseHero(h, e.kind, e.why || 'unavailable', true, fx);
    if (fx) ctx.say(`😴 ${ctx.nm(h)} ${e.kind === 'failover' ? 'switched to ' + ctx.nm(ctx.hero(e.other)) + ' (signal only; quest ownership unchanged)' : 'is resting: ' + REST_REASON[e.why]}`, e.t, 'rest:' + ctx.eventKey(e), 0);
    if (e.kind === 'failover') {
      const target = ctx.hero(e.other), geometry = restGeometry(false);
      const busy = Object.values(ctx.S.tasks).some(t => t.bot === target.bot && t.state === 'fight');
      if (fx && geometry) { const [x,y] = geometry.data.portal?.spot || geometry.data.spot; ctx.S.fx.push({k:'portal',x,y,life:2.2,max:2.2}); }
      if (geometry && !busy && !restLocked(target)) {
        target.rest = {...target.rest, generation: target.rest.generation + 1, state:'active',phase:'portal',target:geometry.region,slot:null};
        target.act = null; target.q = []; target.atk = -1;
        walkRest(target, geometry, geometry.data.portal?.spot || geometry.data.spot);
        // A portal visit does not reserve a resting slot or claim a quest.
      }
    }
  }
  return true;
}
function sleep(h, fx) { if (restLocked(h) && h.rest.observed) return; pauseHero(h, 'pause', 'limited', false, fx); fx && ctx.say(`😴 ${ctx.nm(h)} is resting: rate limited`, ctx.S.t); }
function wake(h, fx) { if (!h.sleep || h.rest.observed) return; resumeHero(h); fx && ctx.say(`☀️ ${ctx.nm(h)} resumed`, ctx.S.t); }
return {
  get CUI(){return CUI},
  get spawnMonster(){return spawnMonster}, set spawnMonster(v){spawnMonster=v},
  get goHome(){return goHome}, set goHome(v){goHome=v},
  get engage(){return engage}, set engage(v){engage=v},
  get reset(){return reset}, set reset(v){reset=v},
  get cancelTaskActions(){return cancelTaskActions}, set cancelTaskActions(v){cancelTaskActions=v},
  get assignTask(){return assignTask}, set assignTask(v){assignTask=v},
  get canStrike(){return canStrike}, set canStrike(v){canStrike=v},
  get ACTIONS(){return ACTIONS},
  get apply(){return apply}, set apply(v){apply=v},
  get REST_REASON(){return REST_REASON},
  get diagnostic(){return diagnostic}, set diagnostic(v){diagnostic=v},
  get restLocked(){return restLocked}, set restLocked(v){restLocked=v},
  get laterHero(){return laterHero}, set laterHero(v){laterHero=v},
  get restGeometry(){return restGeometry}, set restGeometry(v){restGeometry=v},
  get restSpotClear(){return restSpotClear}, set restSpotClear(v){restSpotClear=v},
  get allocateRestSlots(){return allocateRestSlots}, set allocateRestSlots(v){allocateRestSlots=v},
  get walkRest(){return walkRest}, set walkRest(v){walkRest=v},
  get pauseHero(){return pauseHero}, set pauseHero(v){pauseHero=v},
  get resumeHero(){return resumeHero}, set resumeHero(v){resumeHero=v},
  get finishPortal(){return finishPortal}, set finishPortal(v){finishPortal=v},
  get finishRestMotion(){return finishRestMotion}, set finishRestMotion(v){finishRestMotion=v},
  get applyBotEvent(){return applyBotEvent}, set applyBotEvent(v){applyBotEvent=v},
  get sleep(){return sleep}, set sleep(v){sleep=v},
  get wake(){return wake}, set wake(v){wake=v}
};
};
