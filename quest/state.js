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

// ---------- work items (Working view reducer) ----------
// `working` is an authoritative snapshot of CURRENT Kanban work, not an event stream. It is
// reduced into one store keyed by the opaque work_item.ref. The store lives outside S on
// purpose: scrubbing/reset() rebuilds S from events, but "what is running right now" and
// "which done card already paid out" must survive that. Plan/apply/dispatch is split so a
// failing rebase can roll the store back and listeners only ever see committed state.
const WORK_STATUS = ['running', 'blocked', 'failed', 'done', 'archived', 'unknown'];
const WORK_ITEM_LIMIT = 2000, CREDIT_LIMIT = 4096, ORDER_SEEN_LIMIT = 64;
const XP_PER_DONE = 10, GOLD_PER_DONE = 1, XP_PER_LEVEL = 100;
const newWork = () => ({has: false, asOf: null, items: new Map(), resting: 0, latestOrder: null, progress: null,
  credited: new Map(), orderSeen: new Set(), version: 0});
let work = newWork();
const workHooks = {onOrder: new Set(), onComplete: new Set(), errors: 0};
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonNegInt = v => Number.isSafeInteger(v) && v >= 0 ? v : null;
const cleanText = (v, max = 80) => typeof v === 'string' ? v.slice(0, max) : '';
function toSeconds(v) {                                  // epoch seconds | epoch ms | ISO-8601 -> seconds
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e11 ? v / 1000 : v;
  if (typeof v === 'string' && v) { const ms = Date.parse(v); return Number.isFinite(ms) ? ms / 1000 : null; }
  return null;
}
function parseWorkItem(raw) {
  if (!isObj(raw) || typeof raw.ref !== 'string' || !raw.ref) return null;
  return {ref: raw.ref.slice(0, 128), status: WORK_STATUS.includes(raw.status) ? raw.status : 'unknown',
    started_at: toSeconds(raw.started_at), display_name: cleanText(raw.display_name), class_label: cleanText(raw.class_label),
    quest_label: cleanText(raw.quest_label), quest_kind: cleanText(raw.quest_kind), group_label: cleanText(raw.group_label) || 'Other work',
    parent_ref: typeof raw.parent_ref === 'string' && raw.parent_ref ? raw.parent_ref.slice(0, 128) : null,
    worker_observed: raw.worker_observed === true,
    // Internal render bindings only; never copied to DOM/labels.
    bot_ref: typeof raw.bot_ref === 'string' ? raw.bot_ref : null,
    task_ref: typeof raw.task_ref === 'string' ? raw.task_ref : null,
    run_ref: typeof raw.run_ref === 'string' ? raw.run_ref : null};
}
function parseWorkingBlock(block) {
  if (block === undefined || block === null) return null;   // old backend: no Working view data
  const asOf = isObj(block) ? toSeconds(block.as_of) : null;
  if (asOf === null || !Array.isArray(block.items) || block.items.length > WORK_ITEM_LIMIT) throw new Error('Invalid working block');
  const items = new Map();
  for (const raw of block.items) {
    const item = parseWorkItem(raw);
    if (!item) throw new Error('Invalid working item');
    items.set(item.ref, item);                              // duplicate ref in one snapshot: last row wins, never two rows
  }
  let order = null;
  if (block.latest_order != null) {
    const o = block.latest_order, at = isObj(o) ? toSeconds(o.at) : null;
    if (at === null) throw new Error('Invalid working order');
    order = {at, action_label: cleanText(o.action_label), quest_label: cleanText(o.quest_label),
      recipient_display_name: typeof o.recipient_display_name === 'string' ? o.recipient_display_name.slice(0, 80) : null,
      recipient_bot_ref: typeof o.recipient_bot_ref === 'string' ? o.recipient_bot_ref : null,
      task_ref: typeof o.task_ref === 'string' ? o.task_ref : null};
  }
  const p = isObj(block.progress) ? block.progress : null;
  const fields = p && ['wins_today', 'xp', 'gold', 'level', 'level_progress'].map(k => nonNegInt(p[k]));
  return {asOf, items, order, resting: nonNegInt(block.resting_count) ?? 0,
    progress: fields && fields.every(v => v !== null) ? {wins_today: fields[0], xp: fields[1], gold: fields[2], level: fields[3], level_progress: fields[4]} : null};
}
const orderKey = o => [o.at, o.action_label, o.quest_label, o.recipient_display_name ?? ''].join('\u0001');
const dayKey = sec => { const d = new Date(sec * 1000); return d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate(); };
// Pure: nothing is mutated until applyWork. mode 'delta' ignores an older snapshot (out-of-order
// poll); 'rebase' is an authoritative reload and always wins.
function planWork(block, {mode = 'delta', animate = false} = {}) {
  const parsed = parseWorkingBlock(block);
  // Absent block: an authoritative reload from an old backend clears Working data; a delta that
  // merely omits it keeps what we have.
  if (!parsed) return mode === 'rebase' ? {clear: true, fires: [], items: new Map(), prev: work.items, mode}
    : {stale: true, fires: [], items: work.items, prev: work.items, mode};
  if (mode === 'delta' && work.has && parsed.asOf < work.asOf) return {stale: true, fires: [], items: work.items, prev: work.items, mode};
  const baseline = !work.has, credits = [], fires = [];
  const seen = new Set(work.credited.keys());
  for (const item of parsed.items.values()) {
    const before = work.items.get(item.ref);
    item.firstSeen = before?.firstSeen ?? parsed.asOf;
    if (item.status !== 'done' || seen.has(item.ref)) continue;
    seen.add(item.ref); credits.push({ref: item.ref, at: baseline ? null : parsed.asOf});
    // First-ever snapshot is a baseline: already-finished work is credited silently (no fireworks at boot).
    if (!baseline) fires.push({hook: 'onComplete', info: {ref: item.ref, bot_ref: item.bot_ref, task_ref: item.task_ref, display_name: item.display_name, class_label: item.class_label,
      quest_label: item.quest_label, quest_kind: item.quest_kind, group_label: item.group_label, at: parsed.asOf, animate, mode}});
  }
  let orderFire = null;
  if (parsed.order) {
    const key = orderKey(parsed.order);
    if (!work.orderSeen.has(key)) { orderFire = key;
      if (!baseline) fires.push({hook: 'onOrder', info: {...parsed.order, animate, mode}}); }
  }
  return {parsed, items: parsed.items, prev: work.items, credits, fires, orderFire, mode};
}
function applyWork(plan) {
  const undo = work;
  if (plan.stale) return () => {};
  if (plan.clear) { work = newWork(); return () => { work = undo; }; }
  const next = {has: true, asOf: plan.mode === 'delta' ? Math.max(work.asOf ?? -Infinity, plan.parsed.asOf) : plan.parsed.asOf,
    items: plan.items, resting: plan.parsed.resting, latestOrder: plan.parsed.order ?? null, progress: plan.parsed.progress,
    credited: new Map(work.credited), orderSeen: new Set(work.orderSeen), version: work.version + 1};
  for (const c of plan.credits) next.credited.set(c.ref, c.at);
  while (next.credited.size > CREDIT_LIMIT) next.credited.delete(next.credited.keys().next().value);
  if (plan.orderFire) { next.orderSeen.add(plan.orderFire); while (next.orderSeen.size > ORDER_SEEN_LIMIT) next.orderSeen.delete(next.orderSeen.values().next().value); }
  work = next;
  return () => { work = undo; };
}
// Listeners run only after the whole transaction committed; one throwing never blocks the others or the poll.
function dispatchWork(plan) {
  ctx.wireWork?.();
  for (const f of plan.fires) for (const fn of [...workHooks[f.hook]]) { try { fn({...f.info}); } catch (e) { workHooks.errors++; } }
}
const subscribe = set => fn => { if (typeof fn !== 'function') throw new TypeError('hook must be a function'); set.add(fn); return () => set.delete(fn); };
const workActive = () => [...work.items.values()].filter(i => i.status === 'running');
const byStart = (a, b) => (a.started_at ?? Infinity) - (b.started_at ?? Infinity) || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);
// R4 order: Running -> Blocked -> Failed / Needs attention (failed + unknown) -> Completed. Archived leaves the list.
function workRows() {
  const all = [...work.items.values()], pick = (...s) => all.filter(i => s.includes(i.status)).sort(byStart);
  return {running: pick('running'), blocked: pick('blocked'), attention: pick('failed', 'unknown'), completed: pick('done')};
}
function workCounts() {
  const r = workRows();
  return {running: r.running.length, blocked: r.blocked.length, attention: r.attention.length, completed: r.completed.length, resting: work.resting};
}
// Backend progress is authoritative (same snapshot, replaced not summed, so replay/poll/rebase cannot
// add twice). Without it, derive from the distinct done refs this client has credited: 10 XP + 1 game
// gold each, level = 1 + floor(XP / 100). wins_today uses the viewer's local day and excludes the silent boot baseline (backend value wins when present).
function workProgress() {
  if (work.progress) return {...work.progress, source: 'backend'};
  const wins = work.credited.size, xp = wins * XP_PER_DONE, today = work.asOf === null ? null : dayKey(work.asOf);
  return {wins_today: [...work.credited.values()].filter(at => at !== null && dayKey(at) === today).length, xp, gold: wins * GOLD_PER_DONE,
    level: 1 + Math.floor(xp / XP_PER_LEVEL), level_progress: xp % XP_PER_LEVEL, source: 'observed'};
}
const workApi = {
  get has() { return work.has; }, get asOf() { return work.asOf; }, get version() { return work.version; },
  get resting() { return work.resting; }, get latestOrder() { return work.latestOrder && {...work.latestOrder}; },
  get hookErrors() { return workHooks.errors; },
  item: ref => work.items.get(ref) ?? null,
  items: () => [...work.items.values()], active: workActive, rows: workRows, counts: workCounts, progress: workProgress,
  credited: ref => work.credited.has(ref),
  onOrder: subscribe(workHooks.onOrder), onComplete: subscribe(workHooks.onComplete),
  clear() { work = newWork(); }
};
// Published on S (non-enumerable) so the state-only test facade and every module reach one API;
// enumeration/JSON/cloneState of S are unchanged.
Object.defineProperty(S, 'work', {value: workApi, enumerable: false});

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
  get task(){return task}, set task(v){task=v},
  get planWork(){return planWork}, get applyWork(){return applyWork}, get dispatchWork(){return dispatchWork}
};
};
