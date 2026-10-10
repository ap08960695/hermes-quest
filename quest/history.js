'use strict';
// Owns history; peer bindings stay live on the per-game context. Registration never boots.
(globalThis.HQModules ||= {}).createHistory = function createHistory(ctx) {
function redactCharacterNames() {
  for (const b of ctx.D.bots) {
    if (ctx.D.meta.show_profile_names === false) b.name = b.id;
    // Working payloads carry generated class labels even with aliases disabled.
    // Keep only that closed vocabulary; arbitrary aliases/profile names still go.
    if(!/^(?:Build Warrior|Test Ranger|Review Paladin|Deploy Engineer|Research Mage|Analyst Sage|Captain) \d+$/.test(b.display_name||''))delete b.display_name;
    delete b.profile_name; delete b.pet_name;
  }
}
function syncInspectionSessions(rows = ctx.D.sessions) {
  // A supplied inventory is authoritative, including an empty one; absence preserves it.
  ctx.D.sessions=[...new Map((rows||[]).filter(s=>s&&typeof s.bot==='string'&&ctx.validSessionRef(s.session_ref)&&
    (s.parent_session_ref == null || ctx.validSessionRef(s.parent_session_ref)))
    .map(s=>[s.session_ref,s])).values()].slice(-(HISTORY_LIMIT+METADATA_LIMIT));
  if (ctx.inspect.session && !ctx.characterSessions(ctx.inspect.bot).some(s=>s.session_ref===ctx.inspect.session)) ctx.inspect.session=null;
}
const eventKeys = new Set();
// Finite live replay: newest 2,000 events + an event-derived boundary checkpoint.
// Keep referenced entities and the newest 256 metadata entries of each kind; older
// unreferenced entities leave the scene. Scrubs older than the floor clamp to it.
// Outside-floor overlap/late writes and evicted-entity reappearances require a
// fresh replay checkpoint: bounded dedup cannot safely classify those events.
// Rebase uses the authoritative 12h replay, including its cursor and baseline
// coverage; it is not an all-time gold/history ledger. Persistent task IDs are
// bounded by 2,256; bot IDs by 6,769 (tail + metadata + task assignees), plus
// the existing anonymous-event fallback. Transport payloads are transient.
const HISTORY_LIMIT = 2000;
const METADATA_LIMIT = 256;
let checkpoint = null;
let privacyPending = false;
const cloneState = v => JSON.parse(JSON.stringify(v));
class HistoryExpired extends Error {}
class IdentityChanged extends HistoryExpired {}
const captainId = () => ctx.D.meta.captain ?? '';
function normalizeBot(b) {
  const classes = ctx.D.meta.classes || {};
  const role = b.role || Object.keys(classes).find(r => b.id.startsWith(r));
  const cls = b.id === ctx.D.meta.captain ? 'commander' : (classes[role] || b.cls || 'mage');
  return {...b, cls, region: ctx.validRegion(ctx.D.meta.regions?.[cls] || b.region || ctx.defaultRegion())};
}
function normalizeData() {
  ctx.D.meta ||= {};
  ctx.D.meta.from_ ??= ctx.D.events[0]?.t ?? Date.now() / 1000;
  ctx.D.meta.to ??= ctx.D.events[ctx.D.events.length - 1]?.t ?? ctx.D.meta.from_;
  ctx.D.bots = ctx.D.bots.map(normalizeBot);
  // Metadata is opt-in. Sanitize before state, accessible DOM or bitmap caches.
  if (ctx.D.meta.show_titles !== true) redactText();
  if (ctx.D.meta.show_profile_names !== true) redactCharacterNames();
}
function archiveSnapshots(payload) {
  const at = payload.meta?.as_of;
  if (!Number.isFinite(at)) return [];
  // Only an explicit tombstone is authoritative. Date it at the snapshot, never
  // hide the task at earlier playheads just because today's row is archived.
  return payload.tasks.filter(t => t.status === 'archived' &&
    ![...(ctx.D?.events || []), ...payload.events].some(e => e.task === t.id && e.kind === 'archived' && e.t <= at))
    .map(t => ({id: 'snapshot-archive:' + t.id + ':' + at, task: t.id, kind: 'archived', t: at}));
}
function redactText() {
  ctx.D.tasks.forEach(t => { t.title = t.id; t.campaign = 'misc'; delete t.note; });
  ctx.D.bots.forEach(b => { b.name = b.id; });
  ctx.D.events.forEach(e => { delete e.note; delete e.title; });
  // `working` carries opt-in title text (quest_label); drop it with the other prose and let
  // the next authorised snapshot refill it.
  delete ctx.D.working;
}
// Prefer extractor IDs. Canonical field ordering also deduplicates legacy overlap.
function eventKey(e) {
  const canonical = v => v && typeof v === 'object' ? (Array.isArray(v) ? v.map(canonical) :
    Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])]))) : v;
  return e.id !== undefined ? String(e.id) : JSON.stringify(canonical(e));
}
function eventOrder(a, b) {
  const x = String(a.id ?? ''), y = String(b.id ?? '');
  return a.t - b.t || (x < y ? -1 : x > y ? 1 : 0);
}
function restoreCheckpoint() {
  Object.assign(ctx.S, ctx.emptyState(), checkpoint ? cloneState(checkpoint.state) : {});
}
function retainHistory() {
  let cut = Math.max(0, ctx.D.events.length - HISTORY_LIMIT);
  // Never split a timestamp: the checkpoint includes every event at its floor.
  if (cut) while (cut < ctx.D.events.length && ctx.D.events[cut].t === ctx.D.events[cut - 1].t) cut++;
  if (cut) {
    const current = {...ctx.S};
    try {
      restoreCheckpoint();
      ctx.syncMetadata(false);
      for (const e of ctx.D.events.slice(0, cut)) { ctx.S.t = e.t; ctx.apply(e, false); }
      checkpoint = {t: ctx.D.events[cut - 1].t, state: cloneState({
        heroes: ctx.S.heroes, tasks: ctx.S.tasks, vault: ctx.S.vault, mana: ctx.S.mana,
        tokenNetByBot: ctx.S.tokenNetByBot, tokenNetByWallet: ctx.S.tokenNetByWallet, diagnostics: ctx.S.diagnostics})};
    } finally { Object.assign(ctx.S, current); }
    ctx.D.events.splice(0, cut); ctx.D.meta.from_ = checkpoint.t;
  }
  const tasks = new Set(ctx.D.tasks.slice(-METADATA_LIMIT).map(t => t.id));
  const bots = new Set(ctx.D.bots.slice(-METADATA_LIMIT).map(b => b.id));
  bots.add(captainId());
  for (const e of ctx.D.events) { if (e.task) tasks.add(e.task); if (e.bot) bots.add(e.bot); if (e.kind === 'failover' && e.other) bots.add(e.other); }
  for (const t of ctx.D.tasks) if (tasks.has(t.id) && t.bot) bots.add(t.bot);
  for (const t of Object.values(checkpoint?.state.tasks || {})) if (tasks.has(t.id) && t.bot) bots.add(t.bot);

  ctx.D.tasks = ctx.D.tasks.filter(t => tasks.has(t.id)).map(t => ({...t, parents: [...new Set(t.parents || [])].filter(p => tasks.has(p))}));
  ctx.D.bots = ctx.D.bots.filter(b => bots.has(b.id));
  const prune = state => {
    for (const id of Object.keys(state.tasks)) if (!tasks.has(id)) delete state.tasks[id];
    for (const id of Object.keys(state.heroes)) if (!bots.has(id)) delete state.heroes[id];
    for (const id of Object.keys(state.tokenNetByBot)) if (!bots.has(id)) delete state.tokenNetByBot[id];
    for (const t of Object.values(state.tasks)) t.parents = [...new Set(t.parents || [])].filter(p => tasks.has(p));
    for (const h of Object.values(state.heroes)) {
      if (h.task && !tasks.has(h.task)) { h.task = null; h.q = []; }
      if (h.rest?.savedTask && !tasks.has(h.rest.savedTask)) h.rest.savedTask = null;
    }
  };
  prune(ctx.S); if (checkpoint) prune(checkpoint.state);
  ctx.FRIENDS = null;
  eventKeys.clear(); ctx.D.events.forEach(e => eventKeys.add(eventKey(e)));
  return cut;
}
function loadReplay(replay, live = null, at = null) {
  if (!replay || !Array.isArray(replay.events) || !Array.isArray(replay.tasks) || !Array.isArray(replay.bots) ||
      replay.events.some(e => !e || !Number.isFinite(e.t)) || [...replay.tasks, ...replay.bots].some(v => !v || !v.id))
    throw new Error('Invalid replay');
  // Rebase is transactional: a failed snapshot must not destroy the old cursor/history.
  const previous = {D: ctx.D, checkpoint, cursor: ctx.cursor, state: {...ctx.S}, keys: [...eventKeys]};
  // Validate the Working snapshot before anything is touched; a malformed one rejects the whole rebase.
  const workPlan = ctx.planWork(replay.working, {mode: 'rebase', animate: !!(live && ctx.liveFeed && ctx.following && ctx.S.play)});
  let undoWork = () => {};
  ctx.clearInspection();
  if (ctx.UI) ctx.UI.privacy();
  try {
    ctx.D = replay; checkpoint = null; eventKeys.clear();
    for (const field of ['tasks', 'bots']) ctx.D[field] = [...new Map(ctx.D[field].map(v => [v.id, v])).values()];
    normalizeData(); ctx.D.events.push(...archiveSnapshots(ctx.D));
    syncInspectionSessions();
    ctx.D.events.sort(eventOrder);
    ctx.D.events = ctx.D.events.filter(e => { const key = eventKey(e); const duplicate = eventKeys.has(key); eventKeys.add(key); return !duplicate; });
    const preserve = live && previous.D?.meta.show_titles === ctx.D.meta.show_titles;
    Object.assign(ctx.S, ctx.emptyState(), preserve ? cloneState({feed: previous.state.feed, lastFeed: previous.state.lastFeed, fx: previous.state.fx}) : {});
    // Rebase before compaction: fresh actions can otherwise disappear into the
    // silent checkpoint, including a batch larger than the retained window.
    if (live) ctx.reset(live.t, live.keys);
    const cut = retainHistory();
    ctx.S.i = Math.max(0, ctx.S.i - cut);
    if (live && checkpoint && ctx.S.t < checkpoint.t) ctx.reset(checkpoint.t);
    if (at !== null) ctx.reset(at, new Set()); // Clean, silent migration commits atomically.
    ctx.cursor = ctx.D.cursor ?? '';
    privacyPending = false;
    undoWork = ctx.applyWork(workPlan);
  } catch (e) {
    undoWork();
    ctx.D = previous.D; checkpoint = previous.checkpoint; ctx.cursor = previous.cursor;
    Object.assign(ctx.S, previous.state); eventKeys.clear(); previous.keys.forEach(k => eventKeys.add(k)); ctx.FRIENDS = null;
    throw e;
  }
  ctx.dispatchWork(workPlan);   // listeners only see the committed rebase
}
function mergeDelta(delta) {
  if (!Array.isArray(delta.events) || !Array.isArray(delta.tasks) || !Array.isArray(delta.bots) || delta.cursor === undefined)
    throw new Error('Invalid event response');
  if (delta.events.some(e => !e || !Number.isFinite(e.t)) || [...delta.tasks, ...delta.bots].some(v => !v || !v.id))
    throw new Error('Invalid event data');
  if (delta.sessions !== undefined && !Array.isArray(delta.sessions)) throw new Error('Invalid session inventory');
  // An identity/config migration needs a clean authoritative snapshot, not an
  // upsert mixing old profile IDs/prose with pseudonyms. Check before mutation.
  if (privacyPending || (delta.meta?.show_titles !== undefined && delta.meta.show_titles !== ctx.D.meta.show_titles) ||
      (delta.meta?.show_profile_names !== undefined && delta.meta.show_profile_names !== ctx.D.meta.show_profile_names) ||
      (delta.meta?.config_revision !== undefined && delta.meta.config_revision !== ctx.D.meta.config_revision) ||
      (delta.meta?.captain !== undefined && delta.meta.captain !== ctx.D.meta.captain))
    throw new IdentityChanged('Replay identity changed');
  const workPlan = ctx.planWork(delta.working, {mode: 'delta', animate: !!(ctx.liveFeed && ctx.following && ctx.S.play)});
  delta = {...delta, events: [...delta.events, ...archiveSnapshots(delta)]};
  // Known metadata refreshes do not change history. A newly created task is
  // provably new; unknown older identities still require the bounded-history safeguard.
  const born = new Set(delta.events.filter(e => e.kind === 'created' && e.t > (checkpoint?.t ?? -Infinity)).map(e => e.task));
  if (checkpoint && (delta.events.some(e => e.t <= checkpoint.t ||
      (e.task && !ctx.D.tasks.some(t => t.id === e.task) && !checkpoint.state.tasks[e.task] && !born.has(e.task)) ||
      (e.bot && !ctx.D.bots.some(b => b.id === e.bot) && !checkpoint.state.heroes[e.bot]) ||
      (e.kind === 'failover' && e.other && !ctx.D.bots.some(b => b.id === e.other) && !checkpoint.state.heroes[e.other])) ||
      delta.tasks.some(t => !ctx.D.tasks.some(old => old.id === t.id) && !born.has(t.id)) ||
      delta.bots.some(b => !ctx.D.bots.some(old => old.id === b.id))))
    throw new HistoryExpired('Replay rebase required');
  const playhead = ctx.S.t, appliedThrough = ctx.D.events[ctx.S.i - 1]?.t ?? checkpoint?.t ?? -Infinity;
  const pending = new Set(ctx.D.events.slice(ctx.S.i).map(eventKey));
  for (const field of ['tasks', 'bots']) {
    const byId = new Map(ctx.D[field].map(v => [v.id, v]));
    for (const v of delta[field]) { const merged = {...byId.get(v.id), ...v}; byId.delete(v.id); byId.set(v.id, merged); }
    ctx.D[field] = [...byId.values()];
  }
  if (delta.sessions !== undefined) syncInspectionSessions(delta.sessions);
  normalizeData(); ctx.FRIENDS = null;
  if (delta.session_data) ctx.D.session_data = {...delta.session_data};
  if (Number.isFinite(delta.meta?.as_of)) ctx.D.meta.as_of = delta.meta.as_of;
  if (ctx.D.meta.show_titles !== true) delta.events.forEach(e => { delete e.note; delete e.title; });
  ctx.syncMetadata();
  let late = false;
  for (const e of delta.events) {
    const key = eventKey(e);
    if (eventKeys.has(key)) continue;
    eventKeys.add(key); pending.add(key); ctx.D.events.push(e); late ||= e.t <= appliedThrough;
  }
  ctx.D.events.sort(eventOrder);
  const animate = ctx.liveFeed && ctx.following && ctx.S.play;
  if (late) ctx.reset(playhead, animate ? pending : null);
  // Preserve the current scene during normal compaction. Apply due live actions
  // first so even an oversized delta gets effects once before prefix eviction.
  if (animate && ctx.D.events.length > HISTORY_LIMIT)
    while (ctx.S.i < ctx.D.events.length && ctx.D.events[ctx.S.i].t <= playhead) ctx.apply(ctx.D.events[ctx.S.i++], true);
  const applied = ctx.S.i, cut = retainHistory();
  ctx.S.i = Math.max(0, applied - cut);
  // Paused/non-following polls can evict events the scene has never applied,
  // even with the playhead beyond the new floor. Install that checkpoint and
  // silently reconstruct the due tail; normal live compaction keeps its effects.
  if (cut > applied || (checkpoint && ctx.S.t < checkpoint.t)) ctx.reset(playhead);
  ctx.D.meta.to = delta.events.reduce((to, e) => Math.max(to, e.t), Math.max(ctx.D.meta.to, Date.now() / 1000));
  ctx.cursor = delta.cursor;
  ctx.applyWork(workPlan); ctx.dispatchWork(workPlan);
}
return {
  get redactCharacterNames(){return redactCharacterNames}, set redactCharacterNames(v){redactCharacterNames=v},
  get syncInspectionSessions(){return syncInspectionSessions}, set syncInspectionSessions(v){syncInspectionSessions=v},
  get eventKeys(){return eventKeys},
  get HISTORY_LIMIT(){return HISTORY_LIMIT},
  get METADATA_LIMIT(){return METADATA_LIMIT},
  get checkpoint(){return checkpoint}, set checkpoint(v){checkpoint=v},
  get privacyPending(){return privacyPending}, set privacyPending(v){privacyPending=v},
  get cloneState(){return cloneState},
  get HistoryExpired(){return HistoryExpired}, set HistoryExpired(v){HistoryExpired=v},
  get IdentityChanged(){return IdentityChanged}, set IdentityChanged(v){IdentityChanged=v},
  get captainId(){return captainId},
  get normalizeBot(){return normalizeBot}, set normalizeBot(v){normalizeBot=v},
  get normalizeData(){return normalizeData}, set normalizeData(v){normalizeData=v},
  get archiveSnapshots(){return archiveSnapshots}, set archiveSnapshots(v){archiveSnapshots=v},
  get redactText(){return redactText}, set redactText(v){redactText=v},
  get eventKey(){return eventKey}, set eventKey(v){eventKey=v},
  get eventOrder(){return eventOrder}, set eventOrder(v){eventOrder=v},
  get restoreCheckpoint(){return restoreCheckpoint}, set restoreCheckpoint(v){restoreCheckpoint=v},
  get retainHistory(){return retainHistory}, set retainHistory(v){retainHistory=v},
  get loadReplay(){return loadReplay}, set loadReplay(v){loadReplay=v},
  get mergeDelta(){return mergeDelta}, set mergeDelta(v){mergeDelta=v}
};
};
