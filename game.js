// Hermes Quest demo: replays Hermes kanban + worker tool calls as an RPG world (back test).
// Plain Canvas 2D, no deps. Motion rules from the design talk:
//  - walk frames advance by distance travelled (no foot sliding), contact-frame bob, ground shadow,
//    eased start/stop; figures only travel on precomputed road paths (no wall walking)
//  - integer screen positions + nearest-neighbour sprites (no shimmer), preloaded atlases (no flicker)
//  - attacks are anticipation -> swing -> impact (hit-stop + shake + flash) -> recover
'use strict';
const $ = s => document.querySelector(s);
const cv = $('#stage'), cx = cv.getContext('2d');
const DPR = Math.min(2, window.devicePixelRatio || 1);
const UI = window.UIPanels;
const CUI = window.QuestCUI.create();
const STAGES = ['PLAN', 'BUILD', 'TEST', 'REVIEW', 'DEPLOY', 'VERIFY'];
const STAGE_TH = {PLAN: 'Plan', BUILD: 'Build', TEST: 'Test', REVIEW: 'Review', DEPLOY: 'Deploy', VERIFY: 'Verify'};
const MON = {PLAN: 'ghost', BUILD: 'golem', TEST: 'slime', REVIEW: 'bat', DEPLOY: 'skeleton', VERIFY: 'mimic'};
const CLS_HUE = {warrior: 0, ranger: 95, paladin: 45, engineer: 25, mage: 220, sage: 140, commander: 250};
const WALLET = {claude: ['CLAUDE', '#4aa3ff'], codex: ['CODEX', '#58c27a'], agy: ['GEMINI', '#b07cff']};
const HERO_H = 64, STRIDE = 24, WALK_V = 70;          // design units (2 per native px); walk speed per real second
const TOOL_ICON = {read_file: '📜', search_files: '🔍', vision_analyze: '👁', write_file: '✒', kanban_comment: '🕊',
  kanban_heartbeat: '♪', kanban_show: '📋', delegate_task: '🦊', web_search: '🔮'};
const CAT_ICON = {test: '🏹', build: '🔥', deploy: '🎈', git: 'ᚱ', probe: '🔮', shell: '⚙'};
let calm = false;

const img = src => new Promise(r => { const i = new Image(); i.onload = () => r(i); i.onerror = () => r(null); i.src = src; });
const ease = t => t < .5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
const lerp = (a, b, t) => a + (b - a) * t;
const CLOCK_FORMAT = new Intl.DateTimeFormat('en-GB', {hour: '2-digit', minute: '2-digit'});
const fmt = t => { const d = new Date(t * 1000); return Number.isNaN(d.getTime()) ? 'Invalid Date' : CLOCK_FORMAT.format(d); };

let MON2 = {}, MMETA2 = {}, SPRV = {};
let D, W, BG, SPR = {}, MONS = null, MONMETA = null, BLD = {}, MIMG = {}, HMETA = {fw: 128, fh: 96, ax: 48, base: 91, walk: [0, 1, 2, 3], atk: [4, 5, 6, 7], idle: []};
const S = {t: 0, i: 0, speed: 120, play: true, heroes: {}, tasks: {}, fx: [], feed: [], mana: {}, vault: 0,
  trauma: 0, stop: 0, lastFeed: {}};
const cam = {x: 1000, y: 700, tx: 1000, ty: 700, zi: 1};

const API = '/api/plugins/hermes-quest/';
let liveFeed = false, following = false, cursor = '', pollTimer = null;
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
const HISTORY_LIMIT = 2000, METADATA_LIMIT = 256, TRANSPORT_MS = 35000;
let checkpoint = null, pollBusy = false, privacyPending = false;
// Live health: consecutive failed polls and the last time a fetch fully succeeded (ms). UI-only; never read by the scene.
let pollFailures = 0, lastPollOk = null;
const cloneState = v => JSON.parse(JSON.stringify(v));
class HistoryExpired extends Error {}
class IdentityChanged extends HistoryExpired {}
const captainId = () => D.meta.captain ?? '';
function defaultRegion() { return validRegion(D.meta.regions?.commander || 'castle'); }
function validRegion(region) { return W.regions[region] ? region : (W.regions.castle ? 'castle' : Object.keys(W.regions)[0]); }
function normalizeBot(b) {
  const classes = D.meta.classes || {};
  const role = b.role || Object.keys(classes).find(r => b.id.startsWith(r));
  const cls = b.id === D.meta.captain ? 'commander' : (classes[role] || b.cls || 'mage');
  return {...b, cls, region: validRegion(D.meta.regions?.[cls] || b.region || defaultRegion())};
}
function normalizeData() {
  D.meta ||= {};
  D.meta.from_ ??= D.events[0]?.t ?? Date.now() / 1000;
  D.meta.to ??= D.events[D.events.length - 1]?.t ?? D.meta.from_;
  D.bots = D.bots.map(normalizeBot);
  // Metadata is opt-in. Sanitize before state, accessible DOM or bitmap caches.
  if (D.meta.show_titles !== true) redactText();
}
function redactText() {
  D.tasks.forEach(t => { t.title = t.id; delete t.note; });
  D.bots.forEach(b => { b.name = b.id; });
  D.events.forEach(e => { delete e.note; delete e.title; });
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
function connection(text, state, extra) { if (UI) UI.status(text, state, extra); }
async function json(url) {
  // One deadline covers both headers and body, allowing backend extraction 30s.
  // Race as well as abort: even a transport that ignores abort cannot stall retry.
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => {
    controller.abort(); reject(new Error('Transport timeout'));
  }, TRANSPORT_MS); });
  try {
    return await Promise.race([deadline, (async () => {
      const r = await fetch(url, {cache: 'no-store', signal: controller.signal});
      if (!r.ok) { const err = new Error(`HTTP ${r.status}`); err.status = r.status; throw err; }
      return await r.json();
    })()]);
  } finally { clearTimeout(timer); }
}
function emptyState() {
  return {i: 0, heroes: {}, tasks: {}, fx: [], feed: [], vault: 0, trauma: 0, stop: 0,
    lastFeed: {}, soc: {}, later: [], rt: 0, mana: {claude: 100, codex: 100, agy: 100}, ...CUI.empty()};
}
function restoreCheckpoint() {
  Object.assign(S, emptyState(), checkpoint ? cloneState(checkpoint.state) : {});
}
function retainHistory() {
  let cut = Math.max(0, D.events.length - HISTORY_LIMIT);
  // Never split a timestamp: the checkpoint includes every event at its floor.
  if (cut) while (cut < D.events.length && D.events[cut].t === D.events[cut - 1].t) cut++;
  if (cut) {
    const current = {...S};
    try {
      restoreCheckpoint();
      syncMetadata(false);
      for (const e of D.events.slice(0, cut)) { S.t = e.t; apply(e, false); }
      checkpoint = {t: D.events[cut - 1].t, state: cloneState({
        heroes: S.heroes, tasks: S.tasks, vault: S.vault, mana: S.mana,
        tokenNetByBot: S.tokenNetByBot, tokenNetByWallet: S.tokenNetByWallet, diagnostics: S.diagnostics})};
    } finally { Object.assign(S, current); }
    D.events.splice(0, cut); D.meta.from_ = checkpoint.t;
  }
  const tasks = new Set(D.tasks.slice(-METADATA_LIMIT).map(t => t.id));
  const bots = new Set(D.bots.slice(-METADATA_LIMIT).map(b => b.id));
  bots.add(captainId());
  for (const e of D.events) { if (e.task) tasks.add(e.task); if (e.bot) bots.add(e.bot); if (e.kind === 'failover' && e.other) bots.add(e.other); }
  for (const t of D.tasks) if (tasks.has(t.id) && t.bot) bots.add(t.bot);
  for (const t of Object.values(checkpoint?.state.tasks || {})) if (tasks.has(t.id) && t.bot) bots.add(t.bot);

  D.tasks = D.tasks.filter(t => tasks.has(t.id)).map(t => ({...t, parents: [...new Set(t.parents || [])].filter(p => tasks.has(p))}));
  D.bots = D.bots.filter(b => bots.has(b.id));
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
  prune(S); if (checkpoint) prune(checkpoint.state);
  FRIENDS = null;
  eventKeys.clear(); D.events.forEach(e => eventKeys.add(eventKey(e)));
  return cut;
}
function loadReplay(replay, live = null, at = null) {
  if (!replay || !Array.isArray(replay.events) || !Array.isArray(replay.tasks) || !Array.isArray(replay.bots) ||
      replay.events.some(e => !e || !Number.isFinite(e.t)) || [...replay.tasks, ...replay.bots].some(v => !v || !v.id))
    throw new Error('Invalid replay');
  // Rebase is transactional: a failed snapshot must not destroy the old cursor/history.
  const previous = {D, checkpoint, cursor, state: {...S}, keys: [...eventKeys]};
  if (UI) UI.privacy();
  try {
    D = replay; checkpoint = null; eventKeys.clear();
    for (const field of ['tasks', 'bots']) D[field] = [...new Map(D[field].map(v => [v.id, v])).values()];
    normalizeData();
    D.events.sort(eventOrder);
    D.events = D.events.filter(e => { const key = eventKey(e); const duplicate = eventKeys.has(key); eventKeys.add(key); return !duplicate; });
    const preserve = live && previous.D?.meta.show_titles === D.meta.show_titles;
    Object.assign(S, emptyState(), preserve ? cloneState({feed: previous.state.feed, lastFeed: previous.state.lastFeed, fx: previous.state.fx}) : {});
    // Rebase before compaction: fresh actions can otherwise disappear into the
    // silent checkpoint, including a batch larger than the retained window.
    if (live) reset(live.t, live.keys);
    const cut = retainHistory();
    S.i = Math.max(0, S.i - cut);
    if (live && checkpoint && S.t < checkpoint.t) reset(checkpoint.t);
    if (at !== null) reset(at, new Set()); // Clean, silent migration commits atomically.
    cursor = D.cursor ?? '';
    privacyPending = false;
  } catch (e) {
    D = previous.D; checkpoint = previous.checkpoint; cursor = previous.cursor;
    Object.assign(S, previous.state); eventKeys.clear(); previous.keys.forEach(k => eventKeys.add(k)); FRIENDS = null;
    throw e;
  }
}
function syncMetadata(includeNew = true) {
  for (const b of D.bots) {
    if (!includeNew && !S.heroes[b.id]) continue;
    const h = hero(b.id);
    if (h.home !== b.region) { h.home = b.region; h.homeK = Object.values(S.heroes).filter(other => other !== h && other.home === b.region).length; }
    Object.assign(h, {name: b.name, cls: b.cls, wallet: b.wallet || h.wallet, model: b.model || '', effort: b.effort || 'medium', st: mstyle(b.model), eff: EFF[b.effort] || EFF.medium});
  }
  for (const t of D.tasks) if (S.tasks[t.id]) {
    // Snapshot metadata must not overwrite event-derived historical state.
    for (const k of ['title', 'campaign', 'max_rt', 'stage', 'parents']) S.tasks[t.id][k] = t[k];
  }
}
function mergeDelta(delta) {
  if (!Array.isArray(delta.events) || !Array.isArray(delta.tasks) || !Array.isArray(delta.bots) || delta.cursor === undefined)
    throw new Error('Invalid event response');
  if (delta.events.some(e => !e || !Number.isFinite(e.t)) || [...delta.tasks, ...delta.bots].some(v => !v || !v.id))
    throw new Error('Invalid event data');
  // An identity/config migration needs a clean authoritative snapshot, not an
  // upsert mixing old profile IDs/prose with pseudonyms. Check before mutation.
  if ((delta.meta?.show_titles !== undefined && delta.meta.show_titles !== D.meta.show_titles) ||
      (delta.meta?.config_revision !== undefined && delta.meta.config_revision !== D.meta.config_revision) ||
      (delta.meta?.captain !== undefined && delta.meta.captain !== D.meta.captain))
    throw new IdentityChanged('Replay identity changed');
  // Known metadata refreshes do not change history. A newly created task is
  // provably new; unknown older identities still require the bounded-history safeguard.
  const born = new Set(delta.events.filter(e => e.kind === 'created' && e.t > (checkpoint?.t ?? -Infinity)).map(e => e.task));
  if (checkpoint && (delta.events.some(e => e.t <= checkpoint.t ||
      (e.task && !D.tasks.some(t => t.id === e.task) && !checkpoint.state.tasks[e.task] && !born.has(e.task)) ||
      (e.bot && !D.bots.some(b => b.id === e.bot) && !checkpoint.state.heroes[e.bot]) ||
      (e.kind === 'failover' && e.other && !D.bots.some(b => b.id === e.other) && !checkpoint.state.heroes[e.other])) ||
      delta.tasks.some(t => !D.tasks.some(old => old.id === t.id) && !born.has(t.id)) ||
      delta.bots.some(b => !D.bots.some(old => old.id === b.id))))
    throw new HistoryExpired('Replay rebase required');
  const playhead = S.t, appliedThrough = D.events[S.i - 1]?.t ?? checkpoint?.t ?? -Infinity;
  const pending = new Set(D.events.slice(S.i).map(eventKey));
  for (const field of ['tasks', 'bots']) {
    const byId = new Map(D[field].map(v => [v.id, v]));
    for (const v of delta[field]) { const merged = {...byId.get(v.id), ...v}; byId.delete(v.id); byId.set(v.id, merged); }
    D[field] = [...byId.values()];
  }
  normalizeData(); FRIENDS = null;
  if (D.meta.show_titles !== true) delta.events.forEach(e => { delete e.note; delete e.title; });
  syncMetadata();
  let late = false;
  for (const e of delta.events) {
    const key = eventKey(e);
    if (eventKeys.has(key)) continue;
    eventKeys.add(key); pending.add(key); D.events.push(e); late ||= e.t <= appliedThrough;
  }
  D.events.sort(eventOrder);
  const animate = liveFeed && following && S.play;
  if (late) reset(playhead, animate ? pending : null);
  // Preserve the current scene during normal compaction. Apply due live actions
  // first so even an oversized delta gets effects once before prefix eviction.
  if (animate && D.events.length > HISTORY_LIMIT)
    while (S.i < D.events.length && D.events[S.i].t <= playhead) apply(D.events[S.i++], true);
  const applied = S.i, cut = retainHistory();
  S.i = Math.max(0, applied - cut);
  // Paused/non-following polls can evict events the scene has never applied,
  // even with the playhead beyond the new floor. Install that checkpoint and
  // silently reconstruct the due tail; normal live compaction keeps its effects.
  if (cut > applied || (checkpoint && S.t < checkpoint.t)) reset(playhead);
  D.meta.to = delta.events.reduce((to, e) => Math.max(to, e.t), Math.max(D.meta.to, Date.now() / 1000));
  cursor = delta.cursor;
}
// Three failed polls in a row (~30 s) or any 4xx means live data is not updating: say so on screen with a
// short reason and the last good time. Never exposes the response body, URL or cursor; the scene keeps running.
function pollFailed(e) {
  pollFailures++;
  const status = Number.isInteger(e?.status) ? e.status : 0, client = status >= 400 && status < 500;
  if (pollFailures < 3 && !client) { connection('Offline · retrying in 10s', 'offline'); return; }
  const reason = status === 401 || status === 403 ? 'sign-in needed' : client ? 'server rejected' : status >= 500 ? 'server error'
    : e?.name === 'TypeError' || e?.message === 'Transport timeout' ? 'offline' : 'update failed';
  const updated = lastPollOk === null ? null : new Date(lastPollOk).toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit'});
  connection('Live paused · not updating · ' + (updated ? 'last update ' + updated : 'no update yet') + ' · ' + reason, 'stale', {updated, reason});
}
async function pollEvents() {
  if (pollBusy || document.hidden) return;
  pollBusy = true;
  clearTimeout(pollTimer);
  try {
    const delta = await json(`${API}events?since=${encodeURIComponent(cursor)}`);
    try { mergeDelta(delta); } catch (e) {
      if (!(e instanceof HistoryExpired)) throw e;
      if (e instanceof IdentityChanged) {
        privacyPending = true;
        redactText(); checkpoint = null;
        Object.assign(S, emptyState());
        if (UI) UI.privacy();
      }
      const replay = await json(`${API}replay?hours=12`);
      if (replay.cursor === undefined) throw new Error('Missing replay cursor');
      // Playback/controls may advance while the snapshot is in flight. Classify
      // against the applied boundary at commit time, not at request start.
      const playhead = S.t;
      const animate = liveFeed && following && S.play;
      const appliedThrough = D.events[S.i - 1]?.t ?? checkpoint?.t ?? -Infinity;
      const applied = new Set(D.events.slice(0, S.i).map(eventKey));
      const pending = new Set(D.events.slice(S.i).map(eventKey));
      // Outside-floor overlap is historical; bounded dedup cannot classify it.
      // Inside the window, genuinely late delta actions still animate.
      for (const event of delta.events) if (!eventKeys.has(eventKey(event)) && event.t > (checkpoint?.t ?? -Infinity)) pending.add(eventKey(event));
      for (const event of replay.events || []) if (event.t >= appliedThrough && event.t > (checkpoint?.t ?? -Infinity) && !applied.has(eventKey(event))) pending.add(eventKey(event));
      // Drop old scene/feed/effects on migration; no persistent client storage
      // exists. Normal retention rebases still preserve fresh live feedback.
      if (e instanceof IdentityChanged) loadReplay(replay, null, playhead);
      else if (animate) loadReplay(replay, {t: playhead, keys: pending});
      else { loadReplay(replay); reset(playhead); }
    }
    pollFailures = 0; lastPollOk = Date.now();
    connection(delta.state === 'legacy-fallback' ? 'Snapshot fallback' : 'Connected · 10s', delta.state === 'legacy-fallback' ? 'snapshot' : 'online');
  } catch (e) { pollFailed(e); }
  finally {
    // Serial requests: no overlap or advancing the cursor on a failed response.
    pollBusy = false; pollTimer = document.hidden ? null : setTimeout(pollEvents, 10000);
  }
}
function goLive() {
  following = true; S.play = true; S.speed = 1;
  document.querySelectorAll('[data-s]').forEach(b => b.classList.toggle('on', false));
  reset(Date.now() / 1000); if (UI) UI.control('#play','pause','Pause');
}
async function boot() {
  try {
  const params = new URLSearchParams(window.location?.search || '');
  liveFeed = !params.has('data') && (params.get('live') === '1' || (window.location?.pathname || '').startsWith(API));
  [D, W] = await Promise.all([json(params.get('data') || (liveFeed ? `${API}replay?hours=12` : 'data/demo.json')), json('data/world.json')]);
  loadReplay(D);
  BG = await img('assets/px/ground.png');
  for (const c of Object.keys(CLS_HUE)) SPR[c] = await img(`assets/px/${c}.png`);
  HMETA = Object.assign(HMETA, await fetch('assets/px/heroes.json').then(r => r.ok ? r.json() : {}).catch(() => ({})));
  // Only shipped combinations may trigger a request; unknown models/classes
  // keep the class (or warrior) fallback without a speculative sprite 404.
  // M1's audited metadata lists the shipped sheets as source_checks keys.
  // Explicit combos (including an empty/invalid list) still take precedence.
  const combos = new Set('combos' in HMETA ? (Array.isArray(HMETA.combos) ? HMETA.combos : []) : Object.keys(HMETA.source_checks || {}));
  for (const b of D.bots) { const st = mstyle(b.model), key = `${b.cls}-${st.tag}`; if (st !== NO_STYLE && combos.has(key) && !(key in SPRV)) SPRV[key] = await img(`assets/px/heroes/${key}.png`); }
  for (const n of ['goblin', 'golem', 'slime', 'ghost', 'bat', 'skeleton', 'dragon', 'mimic']) MIMG[n] = await img(`assets/px/monsters/${n}.png`);
  MMETA2 = await fetch('assets/px/monsters2/meta.json').then(r => r.ok ? r.json() : {}).catch(() => ({}));
  for (const k of Object.keys(MMETA2)) MON2[k] = await img(`assets/px/monsters2/${k}.png`);
  for (const p of W.props || []) if (!BLD[p.img]) BLD[p.img] = await img(`assets/px/${p.src || 'buildings'}/${p.img}.png`);
  if (window.NPCS) await NPCS.load(W, D, img);                      // M4 villagers (npcs.js)
  MONMETA = await fetch('assets/sprites/monsters.json').then(r => r.ok ? r.json() : null).catch(() => null);
  if (UI) UI.mode(D.meta.source === 'demo' ? 'DEMO' : liveFeed ? 'LIVE' : 'REPLAY');
  ui();
  if (liveFeed) {
    goLive(); pollFailures = 0; lastPollOk = Date.now();
    connection(D.state === 'legacy-fallback' ? 'Snapshot fallback' : 'Connected · 10s', D.state === 'legacy-fallback' ? 'snapshot' : 'online');
    if (!document.hidden) pollTimer = setTimeout(pollEvents, 10000);
  } else { reset(D.meta.from_); connection('Replay file', 'file'); }
  if (!document.hidden) raf = requestAnimationFrame(loop);
  } catch (e) { connection('Unable to load data · reload to retry', 'offline'); }
}

// ---------- world geometry ----------
// Road graph routing. Every walk starts by stepping onto the nearest road segment from where the figure
// physically stands, so a new order mid-walk never cuts across terrain.
function route(from, toNode, wild = false) {
  const G = W.graph, pts = G.pts, E = wild ? [...G.edges, ...(G.wild || [])] : G.edges;   // wild trails: monsters only
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
function spotOf(region) { return (W.regions[region] || W.lairs[region]).spot; }
function slotPos(region, k, kind) {
  const [x, y] = spotOf(region);
  if (region === 'camp') return [x - 90 + (k % 6) * 36 + (Math.floor(k / 6) % 2) * 18, y + 40 + Math.floor(k / 6) * 22];   // war camp yard
  // plaza split: idle party waits in a band by the building door (top), fights use the bottom half
  if (kind === 'home') return [x - 72 + (k % 4) * 48 + (Math.floor(k / 4) % 2) * 24, y - 22 + Math.floor(k / 4) * 16];
  const row = Math.floor(k / 3) % 3;
  return [x + ((k % 3) - 1) * 56 + 50, y + 24 + row * 20];
}
function regionOf(bot, stage) { const b = D.bots.find(b => b.id === bot); return b ? validRegion(b.region) : validRegion(D.meta.stage_regions?.[stage] || defaultRegion()); }

// ---------- state ----------
function hero(bot) {
  if (!S.heroes[bot]) {
    const b = D.bots.find(x => x.id === bot) || {id: bot, name: bot, cls: 'mage', region: defaultRegion(), wallet: ''};
    const home = b.region, k = Object.values(S.heroes).filter(h => h.home === home).length;
    const [x, y] = slotPos(home, k, 'home');
    S.heroes[bot] = {bot, name: b.name, cls: b.cls, wallet: b.wallet, home, homeK: k, x, y, region: home, path: [],
      st: mstyle(b.model), eff: EFF[b.effort] || EFF.medium, model: b.model || '', effort: b.effort || 'medium', charge: 0,
      v: 0, dist: 0, face: 1, task: null, q: [], atk: -1, hurt: 0, sleep: false, down: 0, bubble: null, combo: 0, fam: [],
      idle: 3 + Math.random() * 10, act: null, cheer: 0, talk: 0,
      rest: {state: 'active-unobserved', why: '', savedTask: null, target: null, generation: 0, slot: null, phase: 'idle'}};
  }
  return S.heroes[bot];
}
function task(id) {
  if (!S.tasks[id]) {
    const t = D.tasks.find(x => x.id === id) || {id, title: id, stage: 'BUILD', campaign: 'misc', max_rt: 1800};
    S.tasks[id] = {...t, state: 'quest', hp: 1, flash: 0, x: 0, y: 0, region: null, slot: 0, alpha: 0, bornT: 0,
      chained: false, note: '', runStart: null};
  }
  return S.tasks[id];
}
// ---------- monsters: born in a lair, wait at the war camp, march along trails/roads to the town ----------
const MTYPE = {PLAN: 'ghost', BUILD: 'golem', TEST: 'slime', REVIEW: 'bat', DEPLOY: 'skeleton', VERIFY: 'goblin'};
const LAIR_OF = {goblin: 'lair_cave', golem: 'lair_cave', slime: 'lair_swamp', ghost: 'lair_ruins', bat: 'lair_ruins', skeleton: 'lair_ruins'};
function mtype(t) { const k = MTYPE[t.stage] || 'goblin'; return k === 'golem' && (t.max_rt || 1800) <= 1200 ? 'goblin' : k; }
function mtier(t) { const r = t.max_rt || 1800; return t.chained ? 'l' : r <= 1200 ? 's' : r <= 2400 ? 'm' : 'l'; }   // difficulty = time budget
function spawnMonster(t, region) {
  if (t.region === region && t.alpha > 0) return;
  const used = Object.values(S.tasks).filter(o => o !== t && o.region === region && o.alpha > 0 && !o.dying).map(o => o.slot);
  let k = 0; while (used.includes(k)) k++;
  const born = t.alpha <= 0;
  const from = born ? W.lairs[LAIR_OF[mtype(t)]].spot : [t.mx ?? t.x, t.my ?? t.y];
  t.region = region; t.slot = k; [t.x, t.y] = slotPos(region, k, 'battle');
  if (W.regions[region]) [t.x, t.y] = inPlaza(region, [t.x, t.y]);      // battle slots stay on the paved square
  t.mx = from[0]; t.my = from[1] + (born ? 8 : 0); t.mdist = t.mdist || 0;
  t.mpath = [...route([t.mx, t.my], region, true), [t.x, t.y]];
  S.soc.marches = (S.soc.marches || 0) + 1;
  if (born) { S.soc.spawns = (S.soc.spawns || 0) + 1; t.alpha = .01; t.emerge = .9; S.fx.push({k: 'portal', x: from[0] + 34, y: from[1] + 6, life: 1.2, max: 1.2}); }
}
const PLAZA_RX = 112, PLAZA_RY = 66;              // paved square per region (tools/terrain.py ellipse minus margin)
function inPlaza(region, [x, y]) {                // clamp a final standing spot into the region's plaza
  const [cx_, cy_] = W.regions[region].spot, dx = (x - cx_) / PLAZA_RX, dy = (y - cy_) / PLAZA_RY, r = Math.hypot(dx, dy);
  return r <= 1 ? [x, y] : [cx_ + dx / r * PLAZA_RX * .97, cy_ + dy / r * PLAZA_RY * .97];
}
function walkTo(h, region, spot) {
  // The camp's portal sits inside its plaza, closer to an unrelated road.
  // Leave via the camp graph node before joining the road; nearest-segment
  // routing directly from the portal would cut across the edge of the plaza.
  const rest = W.regions[h.rest?.target], center = rest?.spot;
  const inside = center && Math.hypot((h.x-center[0])/PLAZA_RX,(h.y-center[1])/PLAZA_RY) <= 1;
  const exit = inside && W.graph.pts[rest.node || h.rest.target];
  const p = [...(exit ? [exit] : []), ...route(exit || [h.x, h.y], region)].map(q => q.slice());
  if (spot) p.push(inPlaza(region, spot));
  h.path = [[h.x, h.y], ...p]; h.region = region;
}
function goHome(h) { if (restLocked(h)) return; walkTo(h, h.home, slotPos(h.home, h.homeK, 'home')); h.task = null; }
// Model = element, colour and attack speed; effort = charge time, hit power and crit chance (from each bot's
// config.yaml: model.default + agent.reasoning_effort, or the effort suffix in the model id).
const MODEL_STYLE = [
  ['opus', {tag: 'Opus', el: 'holy', color: '#ffd36b', glow: '#fff6c8', speed: .85}],
  ['fable', {tag: 'Fable', el: 'holy', color: '#ffb36b', glow: '#ffffff', speed: .85}],
  ['sonnet', {tag: 'Sonnet', el: 'arcane', color: '#b07cff', glow: '#eadcff', speed: 1}],
  ['haiku', {tag: 'Haiku', el: 'wind', color: '#9fe8ff', glow: '#ffffff', speed: 1.45}],
  ['sol', {tag: 'Sol', el: 'fire', color: '#ff8a3a', glow: '#ffe0a0', speed: 1.1}],
  ['luna', {tag: 'Luna', el: 'frost', color: '#bcd4ff', glow: '#ffffff', speed: 1.25}],
  ['astra', {tag: 'Astra', el: 'star', color: '#7fe0ff', glow: '#ffffff', speed: .9}],
  ['gemini', {tag: 'Gemini', el: 'storm', color: '#ffe85a', glow: '#fffbe0', speed: 1.35}]];
const NO_STYLE = {tag: '?', el: 'none', color: '#cfd8ea', glow: '#ffffff', speed: 1};
function mstyle(model) { const m = (model || '').toLowerCase(); return (MODEL_STYLE.find(([k]) => m.includes(k)) || [0, NO_STYLE])[1]; }
const EFF = {low: {charge: .03, mult: .8, crit: .02}, medium: {charge: .1, mult: 1, crit: .06}, high: {charge: .25, mult: 1.3, crit: .14},
  xhigh: {charge: .4, mult: 1.6, crit: .22}, max: {charge: .55, mult: 1.9, crit: .3}};
const EL_PARTICLE = {fire: ['#ff8a3a', -1], frost: ['#e6f0ff', 1], storm: ['#ffe85a', 0], holy: ['#fff6c8', -1], arcane: ['#c8a0ff', -1], wind: ['#bff4ff', 0], star: ['#a8ecff', -1]};
// attack range per class (px between hero and monster): melee classes close in, casters/archers keep distance
const RANGE = {warrior: 46, paladin: 52, engineer: 96, sage: 132, mage: 150, ranger: 176, commander: 64};
function engage(h, t) {
  if (restLocked(h)) return;
  if (!t.region) spawnMonster(t, regionOf(h.bot, t.stage));
  h.task = t.id; walkTo(h, t.region, [t.x - (RANGE[h.cls] || 72), t.y + 2]);
}

function reset(t, liveKeys = null) {
  const feed = S.feed, lastFeed = S.lastFeed, fx = S.fx;
  const activeBots = new Set(), activeTasks = new Set();
  restoreCheckpoint();
  if (liveKeys) Object.assign(S, {feed, lastFeed, fx});
  if (checkpoint) t = Math.max(t, checkpoint.t);
  syncMetadata();
  S.t = t;
  while (S.i < D.events.length && D.events[S.i].t <= t) {
    const event = D.events[S.i++], animate = !!liveKeys?.has(eventKey(event));
    const fxCount = S.fx.length;
    apply(event, animate);
    if (animate) { activeBots.add(event.bot); activeTasks.add(event.task); }
    else if (liveKeys) S.fx.length = fxCount; // historical portals are not live effects
  }
  for (const h of Object.values(S.heroes)) {         // snap: no walking during a scrub
    if (activeBots.has(h.bot)) continue;
    if (h.rest.phase === 'portal') finishPortal(h);
    if (h.path.length) { [h.x, h.y] = h.path[h.path.length - 1]; h.path = []; }
    finishRestMotion(h);
  }
  for (const k of Object.values(S.tasks)) if (k.alpha > 0 && !activeTasks.has(k.id)) { k.alpha = 1; k.mx = undefined; k.mpath = null; k.emerge = 0; }   // scrub: everyone already in place
  // scrub lands mid-day: about half the idle heroes are already out socialising (snapped, no walk)
  for (const h of Object.values(S.heroes)) if (!liveKeys && free(h) && !h.act && (h.homeK % 2 || friends(h.bot).length) && Math.random() < .6) {
    startHangout(h, HANGOUTS[Math.floor(Math.random() * HANGOUTS.length)]);
    if (h.path.length) { [h.x, h.y] = h.path[h.path.length - 1]; h.path = []; }
  }
  renderFeed(); renderCamps();
}

// ---------- events -> game actions (the action table; extend here) ----------
const ACTIONS = {
  created(e, fx, t) { t.state = 'quest'; if (t.bot && D.tasks.some(x => x.id === t.id)) spawnMonster(t, 'camp'); fx && say(`👹 New monster: <b>${esc(t.title)}</b>`, e.t, 'new' + t.id); },
  specified(e, fx, t) {},
  dependency_wait(e, fx, t) { t.state = 'caged'; if (t.bot && !t.region) spawnMonster(t, 'camp'); },
  promoted(e, fx, t) { if (t.state === 'caged') t.state = 'quest'; },
  assigned(e, fx, t) { if (e.bot) t.bot = e.bot; },
  claimed(e, fx, t) { if (e.bot) t.bot = e.bot; },
  run_start(e, fx, t) {
    const h = hero(e.bot); t.bot = e.bot; t.state = 'fight'; t.runStart = e.t;
    if (h.sleep) wake(h, fx);
    spawnMonster(t, regionOf(e.bot, t.stage));
    if (restLocked(h)) return;
    h.act = null;
    if (!fx) { engage(h, t); return; }
    order(h, t, e.t);
  },
  tool(e, fx, t) {
    const h = hero(e.bot); if (restLocked(h)) return;
    if (!fx) return;
    // only work that changes or tests something is an attack; reading, searching, git status/diff, skills,
    // web and memory lookups are gestures (icon + small effect) so the fight reads like the real session
    const g = e.git, attack = e.tool === 'patch' || e.tool === 'write_file' || e.tool === 'vision_analyze'
      || (e.tool === 'terminal' && (!g || g === 'commit' || g === 'merge' || g === 'push') && ['test', 'build', 'deploy', 'probe', 'shell', 'git'].includes(e.cat));
    if (g === 'commit' || g === 'push' || g === 'merge') gesture(h, e, g);
    else if (!attack) { if (Math.random() < (e.util === 'read' || e.util === 'scout' ? .12 : 1)) gesture(h, e, e.util || (g ? 'read' : 'read')); return; }
    if (h.q.length < 6) h.q.push(e); else h.combo++;
  },
  compress(e, fx, t) {
    const h = hero(e.bot); if (!fx || restLocked(h)) return;
    h.meditate = 1.8; h.q.length = 0; S.soc.compress = (S.soc.compress || 0) + 1;
    S.fx.push({k: 'swirl', x: h.x, y: h.y - 30, life: 1.6, max: 1.6});
    h.bubble = {text: `🧘 Context compressed ${e.before}→${e.after}`, until: 2.2};
    say(`🧘 ${nm(h)} compressed context ${e.before}→${e.after} messages`, e.t, 'cp' + h.bot, 300);
  },
  captain(e, fx, t) {
    const cap = S.heroes[captainId()]; if (!fx || !cap || restLocked(cap)) return;
    S.soc.captain = (S.soc.captain || 0) + 1;
    const LINE = {create: ['📌 New quest!', '#ffd36b'], reassign: ['🔁 Reassigned!', '#9fd3ff'], extend: ['⏳ More time', '#ffd36b'],
      unblock: ['🔨 Unblocked!', '#ff9f5a'], block: ['⛓ On hold', '#ff6b5a'], link: ['🔗 Linked', '#c8b0ff'], unlink: ['✂ Unlinked', '#c8b0ff'], note: ['✒', '#cfd8ea']}[e.act];
    if (e.act !== 'note' || Math.random() < .15) { cap.atk = 0; cap.cur = {tool: 'order'}; cap.bubble = {text: LINE[0], until: 1.6}; }
    if (e.act === 'extend' && t.alpha > 0) num(t.x, t.y - 46, '⏳ +time', '#ffd36b', 1.4);
    if (e.act === 'unblock' && t.alpha > 0) { burst(t.x, t.y - 20, '#ff9f5a', 14); S.fx.push({k: 'ring', x: t.x, y: t.y - 20, color: '#ffcf6b', r: 26, life: .4, max: .4}); }
    if (e.act === 'reassign' && e.bot) { const h = S.heroes[e.bot]; if (h) S.fx.push({k: 'raven', x0: cap.x, y0: cap.y - 50, x1: h.x, y1: h.y - 50, life: 1.3, max: 1.3}); }
    if (e.act !== 'note') say(`👑 Captain ${LINE[0]} ${esc(t.title)}`, e.t, 'cap' + e.act + t.id, 120);
  },
  tests(e, fx, t) { if (fx) { const h = hero(e.bot); h.q.push({...e, tool: 'tests'}); say(`🏹 ${nm(h)} passed ${e.passed.toLocaleString('en-GB')} tests`, e.t, 'ts' + t.id, 600); } },
  hurt(e, fx, t) { if (fx) { const h = hero(e.bot); if (t.state === 'fight' && t.alpha > 0 && !t.mpath) { t.atk = 0; S.soc.fightbacks = (S.soc.fightbacks || 0) + 1; monsterHit(t, h); return say(`💥 ${nm(h)} hit by ${mtype(t)} (exit ${e.code})`, e.t, 'hu' + h.bot, 900); } h.hurt = .35; num(h.x, h.y - HERO_H, `exit ${e.code}`, '#ff6b5a'); say(`💥 ${nm(h)} command failed (exit ${e.code})`, e.t, 'hu' + h.bot, 900); } },
  heartbeat(e, fx, t) { t.note = e.note || t.note; const h = t.bot && S.heroes[t.bot]; if (fx && h && e.note) { h.bubble = {text: e.note, until: 3.5}; say(`💬 ${nm(h)}: ${esc(e.note)}`, e.t, 'hb' + t.id, 900); } },
  commented(e, fx, t) {},
  comment(e, fx, t) {
    if (!fx) return;
    if (e.tag === '[failover]') { portal(t); say(`🌀 Quest handoff: ${esc(e.note.replace('[failover] ', ''))}`, e.t); }
    else if (e.tag === '[extend-done]') { num(t.x, t.y - 40, '⏳ +time', '#ffd36b'); say(`⏳ Quest time extended: ${esc(t.title)}`, e.t); }
    else if (e.author === captainId()) { raven(t); say(`🐦‍⬛ Captain: ${esc(e.note)}`, e.t, 'cap' + t.id, 600); }
  },
  summon(e, fx, t) {
    const h = hero(e.bot);
    if (!fx) return;
    h.fam.push({a: Math.random() * 6, life: 8, task: t.id}); burst(h.x + 10, h.y - 6, '#ffb36b', 12);
    S.fx.push({k: 'ring', x: h.x + 26, y: h.y - 10, color: '#ffb36b', r: 18, flat: true, life: .6, max: .6});
    h.bubble = {text: '🦊 Help requested!', until: 1.6};
    say(`🦊 ${nm(h)} summoned a subagent${e.note ? ': ' + esc(e.note) : ''}`, e.t);
  },
  moa(e, fx, t) { if (fx) { const h = hero(e.bot); S.fx.push({k: 'council', h, life: 4}); say(`✨ FABLE + ASTRA council advised ${nm(h)}`, e.t); } },
  review_requested(e, fx, t) { fx && say(`🛡️ Quest submitted for review: ${esc(t.title)}`, e.t); },
  blocked(e, fx, t) {
    t.state = 'blocked'; t.chained = true; spawnMonster(t, 'volcano'); t.note = e.note || t.note;
    const h = t.bot && S.heroes[t.bot]; if (h && h.task === t.id) goHome(h);
    if (fx) { S.trauma = Math.min(1, S.trauma + .5); say(`⛓️ Quest blocked: <b>${esc(t.title)}</b> ${e.note ? '— ' + esc(e.note) : ''}`, e.t); }
  },
  block_loop_detected(e, fx, t) { ACTIONS.blocked(e, fx, t); },
  unblocked(e, fx, t) { t.chained = false; t.state = 'quest'; if (t.bot) spawnMonster(t, t.runStart ? regionOf(t.bot) : 'camp'); fx && say(`🔓 Quest unblocked: ${esc(t.title)}`, e.t); },
  run_end(e, fx, t) {
    const h = hero(e.bot);
    if (e.outcome === 'rate_limited') { sleep(h, fx); return; }
    if (['timed_out', 'crashed', 'gave_up'].includes(e.outcome)) {
      if (fx) { h.down = 1.2; num(h.x, h.y - HERO_H, '💀 ' + e.outcome, '#ff6b5a'); say(`💀 ${nm(h)} stopped (${e.outcome})`, e.t); }
      goHome(h);
    }
  },
  rate_limited(e, fx, t) {},
  wake(e, fx, t) { wake(hero(e.bot), fx); },
  completed(e, fx, t) {
    t.state = 'done'; S.vault++;
    if (fx) {
      t.flash = 1; t.dying = 1; S.stop = .07; S.trauma = Math.min(1, S.trauma + .35);
      coins(t.x, t.y - 10); num(t.x, t.y - 46, 'QUEST CLEAR!', '#ffd36b', 1.6);
      say(`🏆 Quest complete: <b>${esc(t.title)}</b>`, e.t);
      cheerAround(t);
    } else t.alpha = 0;
    const h = t.bot && S.heroes[t.bot]; if (h && h.task === t.id) { if (fx) laterHero(h, .9, () => { if (h.task === t.id) { h.task = null; handOff(t); if (!h.act) goHome(h); } }); else goHome(h); }
  },
  archived(e, fx, t) { t.alpha = 0; },
};
function apply(e, fx) {
  if (applyBotEvent(e, fx)) return;
  if (!e.task) return;
  if (['tool','tests','hurt','compress','summon','moa'].includes(e.kind) && e.bot && restLocked(hero(e.bot))) return;
  const t = task(e.task);
  (ACTIONS[e.kind] || (() => { if (fx && t.alpha > 0) num(t.x, t.y - 30, e.kind, '#8aa0c8', .8); }))(e, fx, t);
}
// Bot-level events never fabricate a task or transfer its ownership.
const REST_REASON = {limited: 'Rate limited', 'waiting-start': 'Waiting to start', unavailable: 'Unavailable'};
function diagnostic(message, fx = false, key = message) {
  S.diagnostics[message] = (S.diagnostics[message] || 0) + 1;
  if (fx) say(message, S.t, 'diagnostic:' + key, 0);
}
function restLocked(h) { return h.rest && (['paused', 'transferred'].includes(h.rest.state) || h.rest.phase === 'portal'); }
function laterHero(h, sec, callback) {
  const generation = h.rest.generation;
  later(sec, () => { if (h.rest.generation === generation && !restLocked(h)) callback(); });
}
function restGeometry(fx) {
  const region = W.regions.rest_inn ? 'rest_inn' : W.regions.inn ? 'inn' : null;
  if (region !== 'rest_inn') diagnostic('Rest camp unavailable; using the inn', fx);
  const data = W.regions[region], node = data?.node || region;
  if (!data || !W.graph?.pts[node] || !W.graph.edges?.length) {
    diagnostic('Rest geometry unavailable; staying in place', fx); return null;
  }
  return {region, node, data};
}
function restSpotClear(region, spot, occupied) {
  if (occupied.some(p => Math.hypot(p[0] - spot[0], p[1] - spot[1]) < 12)) return false;
  return !(W.props || []).some(p => {
    if (p.src === 'buildings') return spot[0] >= p.x - p.w * .46 && spot[0] <= p.x + p.w * .46 && spot[1] >= p.y - p.h && spot[1] <= p.y + 6;
    return ['tent','campfire','well','barrels','crates','cart','rock','rocks','oak','pine','pillar','fence'].includes(p.img) && Math.hypot(spot[0] - p.x, spot[1] - p.y) < 8;
  });
}
function allocateRestSlots(geometry) {
  const occupied = [], {region, data} = geometry;
  const resting = Object.values(S.heroes).filter(h => ['paused', 'transferred'].includes(h.rest.state)).sort((a,b) => a.bot < b.bot ? -1 : a.bot > b.bot ? 1 : 0);
  // Sorted IDs make slots deterministic independent of event delivery order.
  for (const h of resting) {
    let spot, slot;
    for (let k = 0; k < 256; k++) {
      const candidate = inPlaza(region, data.rest_spots?.[k] || hangSpot(region, k));
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
  if (Math.hypot((h.x-cx_)/PLAZA_RX,(h.y-cy_)/PLAZA_RY) <= 1) {
    // Slot reallocation or a repeated pause can start inside the camp.
    // Keep that short walk wholly in the plaza rather than detouring to
    // the nearest (possibly unrelated) road beyond its edge.
    h.path = [[h.x,h.y], inPlaza(geometry.region, spot)]; h.region = geometry.region; return;
  }
  const points = route([h.x,h.y], geometry.node);
  // A disconnected graph must not produce a direct jump across unpaved terrain.
  if (points.length < 3 && Math.hypot(points[0][0] - W.graph.pts[geometry.node][0],points[0][1] - W.graph.pts[geometry.node][1]) > 1) {
    h.path = []; diagnostic('Rest route unavailable; staying in place'); return;
  }
  h.path = [[h.x,h.y], ...points.map(p => p.slice()), inPlaza(geometry.region, spot)]; h.region = geometry.region;
}
function pauseHero(h, kind, why, observed = true, fx = false) {
  const savedTask = h.task || h.rest.savedTask;
  h.rest = CUI.transitionRest(h.rest, kind, {why, savedTask, observed});
  h.sleep = true; h.task = null; h.act = null; h.q = []; h.atk = -1; h.cur = null;
  h.charge = 0; h.fam = []; h.bubble = null; h.gest = null;
  const geometry = restGeometry(fx);
  if (geometry) allocateRestSlots(geometry);
  else { h.path = []; h.v = 0; h.rest.phase = 'resting'; h.rest.target = null; h.rest.slot = null; }
}
function resumeHero(h) {
  const saved = S.tasks[h.rest.savedTask];
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
  if (!e.bot || typeof e.bot !== 'string') { diagnostic('Invalid bot event ignored', fx, eventKey(e)); return true; }
  if (e.kind === 'mana') {
    // Validate before creating even a hero for malformed token payloads.
    if (!Number.isSafeInteger(e.tokens) || (e.tokens < 0 && e.correction !== true)) { diagnostic('Invalid token event ignored', fx, eventKey(e)); return true; }
    if (!e.tokens) return true;
    const h = hero(e.bot), error = CUI.reduceMana(S, e, h.wallet);
    if (error) diagnostic(error, fx, eventKey(e));
    else if (fx) say(`🔮 ${nm(h)} token usage ${e.tokens > 0 ? '+' : ''}${e.tokens}${e.basis === 'chars' ? ' (text estimate)' : e.correction ? ' (usage correction)' : ''}`, e.t, 'mana:' + eventKey(e), 0);
    return true;
  }
  if (e.kind === 'pause' && !REST_REASON[e.why]) { diagnostic('Invalid rest reason ignored', fx, eventKey(e)); return true; }
  if (e.kind === 'failover' && (!e.other || typeof e.other !== 'string' || e.other === e.bot)) { diagnostic('Invalid switch event ignored', fx, eventKey(e)); return true; }
  const h = hero(e.bot);
  if (e.kind === 'resume') {
    resumeHero(h); if (fx) say(`☀️ ${nm(h)} resumed`, e.t, 'resume:' + eventKey(e), 0);
  } else {
    pauseHero(h, e.kind, e.why || 'unavailable', true, fx);
    if (fx) say(`😴 ${nm(h)} ${e.kind === 'failover' ? 'switched to ' + nm(hero(e.other)) + ' (signal only; quest ownership unchanged)' : 'is resting: ' + REST_REASON[e.why]}`, e.t, 'rest:' + eventKey(e), 0);
    if (e.kind === 'failover') {
      const target = hero(e.other), geometry = restGeometry(false);
      const busy = Object.values(S.tasks).some(t => t.bot === target.bot && t.state === 'fight');
      if (fx && geometry) { const [x,y] = geometry.data.portal?.spot || geometry.data.spot; S.fx.push({k:'portal',x,y,life:2.2,max:2.2}); }
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
function sleep(h, fx) { if (restLocked(h) && h.rest.observed) return; pauseHero(h, 'pause', 'limited', false, fx); fx && say(`😴 ${nm(h)} is resting: rate limited`, S.t); }
function wake(h, fx) { if (!h.sleep || h.rest.observed) return; resumeHero(h); fx && say(`☀️ ${nm(h)} resumed`, S.t); }
const nm = h => `<span class="who">${esc(h.name)}</span> (${esc(h.bot)})`;
const esc = s => String(s ?? '').replace(/[<>&]/g, c => ({'<': '&lt;', '>': '&gt;', '&': '&amp;'}[c]));

// ---------- FX ----------
function num(x, y, text, color, life = 1.1) { S.fx.push({k: 'num', x, y, text, color, life, max: life}); }
function burst(x, y, color, n) { if (calm) n = Math.ceil(n / 3); for (let i = 0; i < n; i++) S.fx.push({k: 'p', x, y, vx: (Math.random() - .5) * 90, vy: -Math.random() * 90, color, life: .5 + Math.random() * .4}); }
function coins(x, y) { const [vx, vy] = W.regions.vault.spot; for (let i = 0; i < 8; i++) S.fx.push({k: 'coin', x, y, x0: x, y0: y, x1: vx + (Math.random() - .5) * 30, y1: vy - 10, life: 1.2 + i * .06, max: 1.2 + i * .06}); }
function portal(t) { S.fx.push({k: 'portal', x: t.x - 34, y: t.y, life: 2.2, max: 2.2}); }
function raven(t) { const [x, y] = spotOf(regionOf(captainId())); S.fx.push({k: 'raven', x0: x, y0: y - 40, x1: t.x, y1: t.y - 40, life: 1.6, max: 1.6}); }
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
  if (tool === 'terminal') { const c = e.cat || 'shell'; return [CAT_ICON[c] + ' ' + c, '#fff']; }
  if (tool === 'tests') return [`✔ ${e.passed}`, '#7dffa0'];
  return [TOOL_ICON[tool] || '✦', '#fff'];
}
function heroAccent(h) { const im = SPRV[`${h.cls}-${(h.st || NO_STYLE).tag}`] || SPR[h.cls]; return im ? accent(im) : {}; }
function landHit(h, t, e, a0, ix, iy) {
  if (restLocked(h) || !S.tasks[t.id] || t.dying) return;
  const st = {...(h.st || NO_STYLE), ...heroAccent(h)}, ef = h.eff || EFF.medium, crit = Math.random() < ef.crit;
  const a = {...a0, color: a0.kind === 'proj' ? st.color : a0.color, glow: st.glow};
  t.flash = .09 * ef.mult; t.kick = Math.min(1.6, ef.mult * (crit ? 1.4 : 1));
  S.trauma = Math.min(1, S.trauma + (a.kind === 'smite' ? .12 : .06) * ef.mult * (crit ? 2 : 1));
  if (crit) { S.stop = .05; num(ix, iy - 34, 'CRIT!', st.color, 1.2); }
  if (st.el === 'storm') S.fx.push({k: 'bolt', x: ix, y: iy, color: st.color, life: .2, max: .2});
  if (st.el === 'frost') S.fx.push({k: 'ring', x: ix, y: iy, color: '#e6f0ff', r: 14, life: .35, max: .35});
  if (st.el === 'fire' || st.el === 'holy' || st.el === 'arcane') burst(ix, iy - 4, st.color, Math.round(4 * ef.mult));
  if (a.kind === 'slash') S.fx.push({k: 'slash', x: ix, y: iy, dir: h.face, color: a.color, glow: st.color, life: .22, max: .22, big: ef.mult});
  else if (a.kind === 'smite') S.fx.push({k: 'pillar', x: ix, y: t.y, color: a.color, life: .45, max: .45});
  else S.fx.push({k: 'ring', x: ix, y: iy, color: a.glow, r: a.proj === 'orb' ? 18 : 11, life: .3, max: .3});
  burst(ix, iy, a.glow, a.kind === 'proj' ? 6 : 9);
  const [txt, col] = toolLabel(e); num(ix, iy - 18, txt, col, e.tool === 'tests' ? 1.4 : 1.1);
  if (h.combo > 1) { num(h.x, h.y - HERO_H - 14, `COMBO x${h.combo}`, '#7fc8ff', .9); h.combo = 0; }
}
function strike(h, t, e) {
  const a = ATTACK[h.cls] || ATTACK.warrior, ix = t.x - 6, iy = t.y - 22;
  if (a.kind !== 'proj') return landHit(h, t, e, a, ix, iy);
  const st = {...(h.st || NO_STYLE), ...heroAccent(h)}, sx = h.x + 22 * h.face, sy = h.y - 34, dur = Math.max(.12, Math.hypot(ix - sx, iy - sy) / (a.speed * st.speed));
  S.fx.push({k: 'proj', proj: a.proj, x0: sx, y0: sy, x1: ix, y1: iy, color: st.color, glow: st.glow, life: dur, max: dur, big: (h.eff || EFF.medium).mult,
    arc: a.proj === 'arrow' ? 16 : a.proj === 'gear' ? 24 : 0});
  laterHero(h, dur, () => landHit(h, t, e, a, ix, iy));
}
const GESTURE = {read: ['📜', '#cfd8ea'], scout: ['🔍', '#cfd8ea'], tome: ['📖', '#c8b0ff'], crystal: ['🔮', '#9fd3ff'],
  memory: ['🗝', '#ffd36b'], pigeon: ['🕊', '#ffffff'], spawn: ['🐣', '#ffcf6b'], commit: ['⚒ commit', '#ffe08a'],
  push: ['🎈 push', '#9fd3ff'], merge: ['⚔ merge', '#ffb36b']};
function gesture(h, e, kind) {
  if (restLocked(h)) return;
  const [icon, col] = GESTURE[kind] || GESTURE.read;
  h.gest = {icon, until: kind === 'read' || kind === 'scout' ? .8 : 1.3};
  if (kind === 'push') S.fx.push({k: 'balloon', x: h.x, y: h.y - 40, life: 2.2, max: 2.2});
  else if (kind === 'commit') { h.cheer = .5; S.fx.push({k: 'ring', x: h.x, y: h.y - 30, color: '#ffe08a', r: 16, life: .4, max: .4}); }
  else if (kind === 'merge') { burst(h.x, h.y - 40, '#ffb36b', 10); }
  else if (kind === 'pigeon') S.fx.push({k: 'raven', x0: h.x, y0: h.y - 40, x1: W.regions.castle.spot[0], y1: W.regions.castle.spot[1] - 60, life: 1.4, max: 1.4, icon: '🕊'});
  if (kind !== 'read' && kind !== 'scout') num(h.x, h.y - HERO_H - 4, icon, col, 1.1);
}
// Monster counter-attacks: melee monsters lunge (their sheet), golems slam a shockwave, slimes/ghosts spit.
const M_RANGED = {slime: {proj: 'glob', color: '#7ee05a', speed: 260}, ghost: {proj: 'wisp', color: '#b48cff', speed: 300}};
function monsterHit(t, h) {
  const kind = mtype(t), r = M_RANGED[kind], tx = h.x, ty = h.y - 26;
  const hit = () => { h.hurt = .35; h.knock = 1; S.trauma = Math.min(1, S.trauma + .15); burst(tx, ty, '#ff6b5a', 8);
    if (kind === 'golem') S.fx.push({k: 'ring', x: t.x - 20, y: t.y, color: '#d8b98a', r: 34, flat: true, life: .4, max: .4}); };
  if (!r) return laterHero(h, .26, hit);
  const sx = t.x - 20, sy = t.y - 28, dur = Math.max(.15, Math.hypot(tx - sx, ty - sy) / r.speed);
  laterHero(h, .26, () => S.fx.push({k: 'proj', proj: r.proj, x0: sx, y0: sy, x1: tx, y1: ty, color: r.color, glow: '#fff', life: dur, max: dur, arc: 10}));
  laterHero(h, .26 + dur, hit);
}


// ---------- orders: the Captain sends a raven, the hero acknowledges, then sets out ----------
function later(sec, f) { S.later.push({at: S.rt + sec, f}); }
function order(h, t, ts) {
  if (restLocked(h)) return;
  const cap = S.heroes[captainId()], [cx_, cy_] = cap ? [cap.x, cap.y] : spotOf(regionOf(captainId()));
  if (cap && !restLocked(cap)) { cap.bubble = {text: `⚔️ ${h.name}, take on ${t.title.slice(0, 24)}`, until: 2.6}; cap.cheer = .5; }
  S.fx.push({k: 'raven', x0: cx_, y0: cy_ - 50, x1: h.x, y1: h.y - 50, life: 1.3, max: 1.3});
  S.soc.orders = (S.soc.orders || 0) + 1;
  say(`📯 Captain sent ${nm(h)} to <b>${esc(t.title)}</b>`, ts, 'run' + t.id);
  h.act = null; h.task = t.id;                      // reserved: no hangout while the order is in the air
  laterHero(h, 1.3, () => { if (h.task !== t.id || t.state !== 'fight') return; h.bubble = {text: '❗ Acknowledged!', until: 1.4}; h.cheer = .5; });
  laterHero(h, 1.9, () => { if (h.task === t.id && t.state === 'fight') engage(h, t); });
}

// ---------- social life ----------
// Idle heroes don't stand in a row: they hang out with the bots they actually work with (friends = bots linked
// through parent/child cards in the replay), visit the tavern, the market or the campfire, chat, cheer each other's
// wins and walk over to hand off a finished quest to whoever picks it up next. All walks go through route().
const HANGOUTS = [
  {region: 'inn', kind: 'tavern', icon: '🍺', th: 'visited the inn'}, {region: 'castle', kind: 'square', icon: '💬', th: 'chatted in the castle square'},
  {region: 'vault', kind: 'treasure', icon: '🪙', th: 'visited the vault'}, {region: 'port', kind: 'harbor', icon: '⚓', th: 'visited the harbor'},
  {region: 'forest', kind: 'campfire', icon: '🔥', th: 'gathered around the campfire'}];
const CHAT = {
  generic: ['Busy day', 'Seen the Captain?', 'Taking a break', 'Back soon', 'Ha!', 'Watch out for the volcano boss', 'Checking my tokens', '☕ Coffee, please'],
  warrior: ['Patched three files', 'Build passed!', 'On it'], ranger: ['Tests passed', 'Found another bug', 'Testing again'],
  paladin: ['A tough review', 'Two changes requested', 'LGTM 👍'], engineer: ['Deployed', 'CDN checked', 'Airship ready'],
  mage: ['Research ready', 'Reading docs'], sage: ['Drawing a new flow', 'Checking the numbers'], commander: ['Ready, everyone?', 'New plan ready']};
let FRIENDS = null;
function friends(bot) {
  if (!FRIENDS) {
    FRIENDS = {};
    const byId = Object.fromEntries(D.tasks.map(t => [t.id, t]));
    for (const t of D.tasks) for (const p of t.parents || []) {
      const a = t.bot, b = byId[p] && byId[p].bot;
      if (a && b && a !== b) { ((FRIENDS[a] ||= {})[b] = (FRIENDS[a][b] || 0) + 1); ((FRIENDS[b] ||= {})[a] = (FRIENDS[b][a] || 0) + 1); }
    }
  }
  return Object.entries(FRIENDS[bot] || {}).sort((a, b) => b[1] - a[1]).map(x => x[0]);
}
function free(h) { return !restLocked(h) && h.rest.phase !== 'returning' && !h.task && !h.sleep && h.down <= 0 && h.atk < 0 && h.cls !== 'commander'; }   // Captain stays at the war room
function hangSpot(region, k) {                       // circle formation inside the plaza, facing the centre
  const [x, y] = W.regions[region].spot, ring = Math.floor(k / 6), a = (k % 6) / 6 * 6.283 + ring * .5 + region.length * .7;
  return [x + Math.cos(a) * (50 + ring * 26), y + 30 + Math.sin(a) * (22 + ring * 10)];   // 6 per ring, rings grow outward
}
function startHangout(h, place, withWho = []) {
  if (restLocked(h)) return;
  const party = [h, ...withWho.filter(free)].slice(0, 4);
  const used = new Set(Object.values(S.heroes).filter(o => o.act && o.act.region === place.region).map(o => o.act.k));
  S.soc.hangouts = (S.soc.hangouts || 0) + 1; if (party.length > 1) S.soc.group = (S.soc.group || 0) + 1;
  party.forEach(m => {                               // smallest free spot in the circle: nobody stands on anybody
    let k = 0; while (used.has(k)) k++; used.add(k);
    m.act = {...place, until: 18 + Math.random() * 20, k};
    walkTo(m, place.region, hangSpot(place.region, k));
  });
  if (party.length > 1) say(`${place.icon} ${party.map(nm).join(', ')} ${place.th}`, S.t, 'hang' + place.region, 900);
}
function social(dt) {
  const hs = Object.values(S.heroes);
  for (const h of hs) {
    h.cheer = Math.max(0, h.cheer - dt); h.talk = Math.max(0, h.talk - dt);
    if (!free(h) || h.path.length > 1) continue;
    if (h.act) {
      if ((h.act.until -= dt) <= 0) { h.act = null; h.idle = 6 + Math.random() * 14; goHome(h); continue; }
      // face the group centre and chat when someone else is here
      const mates = hs.filter(o => o !== h && o.act && o.act.region === h.act.region && o.path.length < 2);
      if (mates.length) {
        const cx_ = mates.reduce((s, o) => s + o.x, h.x) / (mates.length + 1); h.face = cx_ >= h.x ? 1 : -1;
        if (h.talk <= 0 && Math.random() < dt * .35) {
          const pool = [...(CHAT[h.cls] || []), ...CHAT.generic, ...recentNotes(h.bot)];
          h.bubble = {text: pool[Math.floor(Math.random() * pool.length)], until: 2.6}; h.talk = 3 + Math.random() * 3; S.soc.chats = (S.soc.chats || 0) + 1;
        }
      }
      continue;
    }
    if ((h.idle -= dt) > 0) continue;
    h.idle = 8 + Math.random() * 16;
    const fr = friends(h.bot).map(b => S.heroes[b]).filter(o => o && free(o) && !o.act);
    const place = HANGOUTS[Math.floor(Math.random() * HANGOUTS.length)];
    if (fr.length || Math.random() < .35) startHangout(h, place, fr.slice(0, 2));
  }
}
function recentNotes(bot) {
  return Object.values(S.tasks).filter(t => t.bot === bot && t.note).slice(-2).map(t => t.note.slice(0, 40));
}
function handOff(t) {                                // the finisher walks a quest scroll to whoever does the next card
  const from = t.bot && S.heroes[t.bot]; if (!from || restLocked(from)) return;
  const next = D.tasks.find(c => (c.parents || []).includes(t.id) && c.bot && c.bot !== t.bot);
  const to = next && S.heroes[next.bot]; if (!to || !free(to) || to.path.length > 1) return;   // only to someone standing still
  S.soc.handoffs = (S.soc.handoffs || 0) + 1;
  from.act = {region: to.region, kind: 'handoff', icon: '📜', until: 6, k: 0};
  walkTo(from, to.region, [to.x - 26, to.y]);
  from.bubble = {text: `📜 Handoff to ${to.name}`, until: 3};
  say(`📜 ${nm(from)} handed work to ${nm(to)}`, S.t, 'ho' + t.id);
}
function cheerAround(t) {
  for (const h of Object.values(S.heroes)) if (free(h) && Math.hypot(h.x - t.x, h.y - t.y) < 260) { h.cheer = .9; S.soc.cheers = (S.soc.cheers || 0) + 1; if (Math.random() < .4) h.bubble = {text: '🎉', until: 1.2}; }
}

// ---------- update ----------
function update(dt) {
  if (S.stop > 0) { S.stop -= dt; return; }               // hit-stop freezes the world, not the UI
  if (S.play) {
    if (liveFeed && following) { S.t = Math.max(S.t, Date.now() / 1000); D.meta.to = Math.max(D.meta.to, S.t); }
    else S.t += dt * S.speed;
    let n = 0;
    while (S.i < D.events.length && D.events[S.i].t <= S.t && n++ < 400) apply(D.events[S.i++], true);
    if (!(liveFeed && following) && S.t > D.meta.to + 60) S.play = false;

  }
  S.rt += dt;
  for (const l of S.later.filter(l => l.at <= S.rt)) l.f();
  S.later = S.later.filter(l => l.at > S.rt);
  if (window.NPCS && S.play) NPCS.update(dt);                       // M4 villagers: own seeded RNG, fixed step
  social(dt);
  for (const h of Object.values(S.heroes)) stepHero(h, dt);
  for (const t of Object.values(S.tasks)) {
    if (t.dying) { t.dying -= dt * 1.1; if (t.dying <= 0) { t.dying = 0; t.alpha = 0; burst(t.x, t.y - 10, '#6b5a8e', 14); } }
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
    if (t.state === 'fight' && t.runStart) t.hp = Math.max(.08, 1 - (S.t - t.runStart) / (t.max_rt || 1800));
  }
  S.fx = S.fx.filter(f => (f.life -= dt) > 0);
  for (const f of S.fx) if (f.k === 'p') { f.x += f.vx * dt; f.y += f.vy * dt; f.vy += 160 * dt; }
  S.trauma = Math.max(0, S.trauma - dt * 1.4);
  cam.x = lerp(cam.x, cam.tx, 1 - Math.exp(-dt * 5)); cam.y = lerp(cam.y, cam.ty, 1 - Math.exp(-dt * 5));
}
function stepHero(h, dt) {
  // Render-independent ambience: probabilities are rates calibrated at 60Hz.
  if (UI && !calm) {
    const st = {...(h.st || NO_STYLE), ...heroAccent(h)}, lv = LEVEL[h.effort] || 0;
    const fighting = h.task && S.tasks[h.task]?.state === 'fight' && h.path.length <= 1;
    const ep = EL_PARTICLE[st.el];
    if ((fighting || h.charge > 0) && ep && Math.random() < 1-Math.pow(.92,dt*60))
      S.fx.push({k:'p',x:h.x+(Math.random()-.5)*26,y:h.y-Math.random()*40,vx:(Math.random()-.5)*10,vy:ep[1]*30,color:ep[0],life:.6});
    if (lv >= 1 && Math.random() < 1-Math.pow(.95,dt*60))
      S.fx.push({k:'p',x:h.x+(Math.random()-.5)*24,y:h.y-20-Math.random()*30,vx:0,vy:-20,color:st.color,life:.5});
    if (lv >= 3 && Math.random() < 1-Math.pow(.75,dt*60))
      S.fx.push({k:'p',x:h.x+(Math.random()-.5)*30,y:h.y-Math.random()*20,vx:0,vy:-40,color:st.glow,life:.7});
  }
  h.hurt = Math.max(0, h.hurt - dt); h.down = Math.max(0, h.down - dt); h.knock = Math.max(0, (h.knock || 0) - dt * 3);
  h.meditate = Math.max(0, (h.meditate || 0) - dt); if (h.gest && (h.gest.until -= dt) <= 0) h.gest = null;
  for (const f of h.fam) if (!restLocked(h) && f.task && S.tasks[f.task] && S.tasks[f.task].state === 'fight' && Math.random() < dt * .6) { const t2 = S.tasks[f.task]; S.fx.push({k: 'proj', proj: 'orb', x0: h.x + Math.cos(f.a) * 34, y0: h.y - 46, x1: t2.x, y1: t2.y - 22, color: '#ffb36b', glow: '#fff', life: .35, max: .35, arc: 6}); laterHero(h, .35, () => { t2.flash = .05; burst(t2.x, t2.y - 22, '#ffb36b', 4); }); }
  if (h.bubble && (h.bubble.until -= dt) <= 0) h.bubble = null;
  h.fam = h.fam.filter(f => (f.life -= dt) > 0); for (const f of h.fam) f.a += dt * 3;
  if (h.down > 0) return;
  if (h.path.length > 1) {                                  // walk with eased speed, frames tied to distance
    const [nx, ny] = h.path[1], dx = nx - h.x, dy = ny - h.y, d = Math.hypot(dx, dy);
    const left = h.path.slice(1).reduce((s, p, i, a) => s + Math.hypot(p[0] - (i ? a[i - 1][0] : h.x), p[1] - (i ? a[i - 1][1] : h.y)), 0);
    const vmax = WALK_V * (left < 18 ? Math.max(.35, left / 18) : 1);
    h.v = lerp(h.v, vmax, 1 - Math.exp(-dt * 6));
    const step = Math.min(d, h.v * dt);
    if (d < .5) { h.path.shift(); if (h.path.length === 1) h.path = []; return; }
    h.x += dx / d * step; h.y += dy / d * step; h.dist += step;
    if (Math.abs(dx) > .3) h.face = dx > 0 ? 1 : -1;
    return;
  }
  h.v = 0; h.path = [];
  finishRestMotion(h);
  if (restLocked(h)) return;
  const t = h.task && S.tasks[h.task];
  if (t && t.state === 'fight') h.face = t.x >= h.x ? 1 : -1;
  if (h.atk >= 0) {                                         // anticipation .14 / swing .08 / impact .1 / recover .14
    if (h.charge > 0) { h.charge -= dt; return; }                  // effort: hold the wind-up while power gathers
    const prev = h.atk; h.atk += dt * (h.st ? h.st.speed : 1);       // model: faster models swing faster
    if (prev < .22 && h.atk >= .22 && t && h.cur && h.cur.tool !== 'order') strike(h, t, h.cur);
    if (h.atk >= .46) h.atk = -1;
  } else if (h.q.length && t && t.state === 'fight' && !h.meditate) { h.cur = h.q.shift(); h.atk = 0; h.charge = h.cls === 'commander' ? 0 : h.eff.charge; }
  else if (h.q.length && !t) h.q.length = 0;
}
function atkFrame(a) { const f = HMETA.atk; return a < .14 ? f[0] : a < .22 ? f[1] : a < .32 ? f[2] : f[3]; }
// lunge: pull back on anticipation, dash in on the swing, hold on impact, ease home on recover
function lunge(a) { return a < .14 ? -4 * ease(a / .14) : a < .22 ? lerp(-4, 12, ease((a - .14) / .08)) : a < .32 ? 12 : lerp(12, 0, ease((a - .32) / .14)); }

// ---------- render ----------
let raf = null;
function loop(ts) {
  raf = null;
  if (document.hidden) return;
  const dt = Math.min(.05, (ts - (loop.last || ts)) / 1000); loop.last = ts;
  update(dt); draw(); hud(dt);
  raf = requestAnimationFrame(loop);
}
function resize() { cv.width = innerWidth * DPR; cv.height = innerHeight * DPR; if (UI) UI.resize(); }
function visibility() {
  if (document.hidden) {
    if (raf !== null) cancelAnimationFrame(raf); raf = null;
    clearTimeout(pollTimer); pollTimer = null; loop.last = null;
  } else if (D && W) {
    loop.last = null;
    if (raf === null) raf = requestAnimationFrame(loop);
    if (liveFeed) pollEvents();
  }
}
// Pixel grid: logic runs in design units (1536x1024); the world is drawn on a native 768x512 pixel grid,
// one design unit = half a native pixel. Every sprite/tile is drawn at its native size times an INTEGER
// screen scale Z with smoothing off, and every position is snapped to the native grid -> crisp pixels.
function view() {
  const Z = cam.zi * DPR;
  let sx = 0, sy = 0;
  if (S.trauma > 0 && !calm) { const s = S.trauma ** 2, k = performance.now() / 33; sx = Math.round(4 * s * Math.sin(k * 1.7)); sy = Math.round(3 * s * Math.sin(k * 2.3)); }
  return {Z, z: Z, ox: Math.round(cv.width / 2 - cam.x * Z) + sx * Z, oy: Math.round(cv.height / 2 - cam.y * Z) + sy * Z};
}
const N = u => Math.round(u);                                       // design units == native px (1536x1024 grid)
const P = (v, x, y) => [v.ox + N(x) * v.Z, v.oy + N(y) * v.Z];
function blit(v, im, sx, sy, sw, sh, nx, ny, flip = false) {       // nx,ny: native top-left
  const Z = v.Z;
  if (!flip) return cx.drawImage(im, sx, sy, sw, sh, v.ox + nx * Z, v.oy + ny * Z, sw * Z, sh * Z);
  cx.save(); cx.translate(v.ox + (nx + sw) * Z, v.oy + ny * Z); cx.scale(-1, 1); cx.drawImage(im, sx, sy, sw, sh, 0, 0, sw * Z, sh * Z); cx.restore();
}
function draw() {
  const v = view();
  if (UI) UI.clear();
  cx.imageSmoothingEnabled = false;
  cx.fillStyle = '#0b1220'; cx.fillRect(0, 0, cv.width, cv.height);
  if (privacyPending) { if(UI)UI.flush(); return; }
  if (BG) cx.drawImage(BG, v.ox, v.oy, W.size[0] * v.Z, W.size[1] * v.Z);
  const ents = [...(W.layered ? W.props : []).map(p => ({y: p.y, f: () => prop(v, p)})),
    ...(Object.values(S.tasks).some(t => t.chained && t.alpha > 0) ? [{y: W.regions.volcano.spot[1] - 6, f: () => dragon(v)}] : []),
    ...Object.values(S.tasks).filter(t => t.alpha > 0).map(t => ({y: t.mx !== undefined ? t.my : t.y, f: () => monster(v, t)})),
    ...Object.values(S.heroes).map(h => ({y: h.y, f: () => heroDraw(v, h)})),
    ...(window.NPCS ? NPCS.ents(v, blit, shadowPx) : [])];             // M4 villagers share the y-sort
  ents.sort((a, b) => a.y - b.y).forEach(e => e.f());
  const groups = new Map();
  for (const f of S.fx) {
    if(f.k !== 'num') { fxDraw(v,f); continue; }
    // Limit visual lanes only; keep every original effect/event in simulation.
    const key=Math.round(f.x/24)+':'+Math.round(f.y/24),group=groups.get(key)||[];
    group.push(f);groups.set(key,group);
  }
  for(const group of groups.values())group.slice(0,3).forEach((f,i)=>
    fxDraw(v,{...f,y:f.y-i*18/v.Z*DPR,text:i===2&&group.length>3?'+'+compact(group.length-2):f.text}));
  for (const [k, r] of Object.entries(W.regions)) banner(v, k, r);
  if(UI)UI.flush();
  vignette();
}
const SHADOWS = new Map(), FLASH = new Map();
function onScreen(v,x,y,w,h) {
  const sx=v.ox+x*v.Z, sy=v.oy+y*v.Z;
  return sx+w*v.Z>=0 && sx-w*v.Z<=cv.width && sy+32*v.Z>=0 && sy-h*v.Z<=cv.height;
}
function flashSheet(im,brightness,saturation=1) {
  const key=im.src+brightness+':'+saturation;if(FLASH.has(key))return FLASH.get(key);
  const c=document.createElement('canvas');c.width=im.width;c.height=im.height;
  const g=c.getContext('2d');g.filter=`brightness(${brightness}) saturate(${saturation})`;g.drawImage(im,0,0);g.filter='none';
  // Force the one-time raster before any per-frame draw, never filter the scene.
  g.getImageData(0,0,1,1);FLASH.set(key,c);return c;
}
function shadowPx(v, nx, ny, w) {
  const h=Math.max(1,Math.round(w/3));let c=SHADOWS.get(w);
  if(!c){c=document.createElement('canvas');c.width=w*2+2;c.height=h*2+1;const g=c.getContext('2d');g.fillStyle='rgba(10,14,20,.32)';
    for(let r=-h;r<=h;r++){const half=Math.round(w*Math.sqrt(1-(r/(h+.5))**2));g.fillRect(w-half,h+r,half*2,1);}SHADOWS.set(w,c);}
  blit(v,c,0,0,c.width,c.height,nx-w,ny-h);
}
function prop(v, p) {
  const im = BLD[p.img]; if (!im) return;
  const bx = N(p.x), by = N(p.y);
  if (!onScreen(v,bx,by,im.width+64,im.height+64)) return;
  shadowPx(v, bx, by, Math.round(im.width * .42));
  if (p.img === 'campfire' || p.img === 'lamp') { const r = (p.img === 'lamp' ? 20 : 32) * v.Z * (1 + Math.sin(performance.now() / 180 + p.x) * .06); const lx = v.ox + bx * v.Z, ly = v.oy + (by - im.height * .8) * v.Z; const g = cx.createRadialGradient(lx, ly, 0, lx, ly, r); g.addColorStop(0, 'rgba(255,190,90,.35)'); g.addColorStop(1, 'rgba(255,190,90,0)'); cx.fillStyle = g; cx.fillRect(lx - r, ly - r, r * 2, r * 2); }
  blit(v, im, 0, 0, im.width, im.height, bx - Math.floor(im.width / 2), by - im.height + 1);
}
function banner(v, key, r) {
  const pr = W.layered && W.props.find(p => p.region === key), im = pr && BLD[pr.img];
  const x = v.ox + N(r.spot[0]) * v.Z, y = v.oy + (im ? N(pr.y) - im.height - 10 : N(r.spot[1]) - 60) * v.Z;
  const n = Object.values(S.tasks).filter(t => t.region === key && t.alpha > 0 && t.state !== 'done').length;
  if(UI){UI.screenIcon(key==='vault'?'coin':STAGES.map(s=>s.toLowerCase()).includes(key)?key:'world',x/DPR,y/DPR);
    if(n||key==='vault')UI.screenNumber(compact(key==='vault'?S.vault:n),x/DPR,y/DPR-22,'#ffd36b');}
}
function heroDraw(v, h) {
  const img = SPRV[`${h.cls}-${(h.st || NO_STYLE).tag}`] || SPR[h.cls] || SPR.warrior; if (!img) return;
  if (!onScreen(v,h.x,h.y,180,180)) return;
  const M = HMETA, walking = h.path.length > 1;
  let fr = 0, bob = 0;
  const WK = HMETA.walk, n = WK.length, now = performance.now() / 1000;
  if (walking) { const i = Math.floor(h.dist / (STRIDE * 2 / n)) % n; fr = WK[i]; const ph = i % (n / 2); bob = ph === 1 ? 2 : ph === n / 4 + 1 ? -1 : 0; }   // dip after contact, rise on passing
  else if (HMETA.idle.length && h.atk < 0 && !h.sleep) fr = HMETA.idle[Math.floor(now * 5 + h.homeK) % HMETA.idle.length];   // breathing loop
  else if (h.atk < 0 && !h.sleep) bob = Math.floor((now + h.homeK * .37) % 1.6 / .8);                                    // 1px idle bob
  if (h.atk >= 0) fr = atkFrame(h.atk);
  const knockX = -Math.round(ease(h.knock || 0) * 10) * (h.face || 1);
  const jump = h.cheer > 0 ? -Math.round(Math.sin((1 - h.cheer / .9) * Math.PI * 2) ** 2 * 8) : 0;
  const sink = h.meditate > 0 ? 3 : 0;
  const bx = N(h.x) + knockX + (h.atk >= 0 && h.cls !== 'commander' ? Math.round(lunge(h.atk)) * h.face : 0), by = N(h.y) + bob + jump + sink;
  const st = {...(h.st || NO_STYLE), ...accent(img)}, fighting = h.task && S.tasks[h.task] && S.tasks[h.task].state === 'fight' && !walking;
  if (fighting || h.charge > 0) {                                            // model aura under the feet
    cx.globalAlpha = .28 + Math.sin(performance.now() / 260 + h.homeK) * .08; cx.fillStyle = st.color;
    for (let i = -2; i <= 2; i++) { const half = Math.round((17 + (h.eff ? h.eff.mult * 3 : 3)) * Math.sqrt(1 - (i / 2.6) ** 2)); cx.fillRect(v.ox + (bx - half) * v.Z, v.oy + (N(h.y) + 1 + i) * v.Z, half * 2 * v.Z, v.Z); }
    cx.globalAlpha = 1;

  }
  if (h.charge > 0) {                                                          // effort wind-up: a ring closing in on the hero
    const c = 1 - h.charge / Math.max(.01, h.eff.charge), r = 30 - c * 18, n = 14;
    for (let i = 0; i < n; i++) { const a = i / n * 6.28 + c * 4; px(v, h.x + Math.cos(a) * r, h.y - 30 + Math.sin(a) * r * .8, 2, 2, i % 3 ? st.color : st.glow); }
  }
  shadowPx(v, bx, N(h.y) + 1, 15);
  const sheet = h.hurt > 0 && !calm ? flashSheet(img,2.4,.2) : img;
  if (h.sleep && !walking) cx.globalAlpha = .9;
  if (h.down > 0 || (h.sleep && !walking)) {                     // lying down: rotate by exactly 90deg (stays on the grid)
    cx.save(); cx.translate(v.ox + bx * v.Z, v.oy + by * v.Z); cx.rotate(-Math.PI / 2);
    cx.drawImage(sheet, fr * M.fw, 0, M.fw, M.fh, -M.ax * v.Z, -M.base * v.Z, M.fw * v.Z, M.fh * v.Z); cx.restore();
  } else {
    const nx = h.face > 0 ? bx - M.ax : bx - (M.fw - M.ax), ny = by - M.base, lv = LEVEL[h.effort] || 0;
    levelBack(v, h, bx, by, st, lv);
    if (lv >= 1 && !(h.hurt > 0)) {                  // effort glow outline, pulsing
      const sil = silhouette(img, st.glow), pulse = .28 + Math.sin(performance.now() / 300 + h.homeK) * .12;   // soft rim light, not neon
      cx.globalAlpha = pulse * (lv >= 3 ? 1.5 : lv >= 2 ? 1.2 : 1);
      for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) blit(v, sil, fr * M.fw, 0, M.fw, M.fh, nx + ox, ny + oy, h.face < 0);
      cx.globalAlpha = (h.sleep && !walking) ? .9 : 1;
    }
    blit(v, sheet, fr * M.fw, 0, M.fw, M.fh, nx, ny, h.face < 0);
    levelFront(v, h, bx, by, st, lv);
  }
  cx.filter = 'none'; cx.globalAlpha = 1;
  const hx = v.ox + bx * v.Z, top = v.oy + (by - 66) * v.Z;
  for (const f of h.fam) blitMon(v, 'bat', N(h.x + Math.cos(f.a) * 34), N(h.y - 46 + Math.sin(f.a) * 10), .7);
  if (h.gest && !walking) emoji(h.gest.icon.split(' ')[0], hx + 14 * v.Z, top + 6 * v.Z - Math.sin(performance.now() / 200) * 2 * v.Z, 12 * v.Z);
  if (h.sleep && !walking) emoji('💤', hx + 12 * v.Z, top + 28 * v.Z - Math.sin(performance.now() / 400) * 4 * v.Z, 14 * v.Z);

  if (h.bubble) bubble(hx, top - 16 * DPR, h.bubble.text);
}
// Effort/attack colours come from the character itself: the dominant saturated hue of its first frame, plus a
// light tint of it for glows. So a violet Sonnet knight glows violet-lilac, a moon sage glows pale silver-blue.
const ACC = new Map();
function accent(im, fw = 128, fh = 96) {
  if (ACC.has(im)) return ACC.get(im);
  const c = document.createElement('canvas'); c.width = fw; c.height = fh;
  const g = c.getContext('2d'); g.drawImage(im, 0, 0, fw, fh, 0, 0, fw, fh);
  const d = g.getImageData(0, 0, fw, fh).data, bins = Array.from({length: 24}, () => [0, 0, 0, 0]);
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 200) continue;
    const r = d[i] / 255, gg = d[i + 1] / 255, b = d[i + 2] / 255, mx = Math.max(r, gg, b), mn = Math.min(r, gg, b), v = mx, sat = mx ? (mx - mn) / mx : 0;
    if (sat < .3 || v < .4) continue;
    let h = mx === mn ? 0 : mx === r ? ((gg - b) / (mx - mn)) % 6 : mx === gg ? (b - r) / (mx - mn) + 2 : (r - gg) / (mx - mn) + 4;
    h = ((h * 60) + 360) % 360;
    const bin = bins[Math.floor(h / 15)], wgt = sat * v; bin[0] += d[i] * wgt; bin[1] += d[i + 1] * wgt; bin[2] += d[i + 2] * wgt; bin[3] += wgt;
  }
  const top = bins.reduce((a, b) => b[3] > a[3] ? b : a);
  const rgb = top[3] ? top.slice(0, 3).map(x => Math.round(x / top[3])) : [207, 216, 234];
  const mix = (k) => '#' + rgb.map(x => Math.round(x + (255 - x) * k).toString(16).padStart(2, '0')).join('');
  const out = {color: mix(.15), glow: mix(.6), soft: `rgba(${rgb.join(',')},`};
  ACC.set(im, out); return out;
}
const SIL = new Map();
function silhouette(im, color) {                     // solid-colour copy of a sprite sheet (cached) for pixel outlines
  const key = im.src + color; if (SIL.has(key)) return SIL.get(key);
  const c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
  const g = c.getContext('2d'); g.drawImage(im, 0, 0); g.globalCompositeOperation = 'source-in'; g.fillStyle = color; g.fillRect(0, 0, c.width, c.height);
  SIL.set(key, c); return c;
}
// Effort = level. medium: plain. high: glowing 1px outline. xhigh: + halo. max: + wings of light and rising motes.
const LEVEL = {low: 0, medium: 0, high: 1, xhigh: 2, max: 3};
const WINGS = new Map(), HALOS = new Map();
function levelBack(v, h, bx, by, st, lv) {
  if (lv >= 3) {                                     // wings of light: a fan of feathers from each shoulder, slow flap
    const flap = Math.sin(performance.now() / 420) * .12, pixels = [];
    for (const sd of [-1, 1]) for (let f = 0; f < 7; f++) {
      const ang = -.05 - f * .2 + flap, len = 46 - f * 4;
      for (let i = 10; i < len; i += 2) {
        pixels.push([N(sd*(8+Math.cos(ang)*i)-1),N(-46+Math.sin(ang)*i*.85),i>len-8||f%2===0]);
      }
    }
    // Key the exact snapped native pixels, not a quantized animation phase.
    const key=st.color+st.glow+JSON.stringify(pixels);let im=WINGS.get(key);
    if(!im){im=document.createElement('canvas');im.width=116;im.height=128;const g=im.getContext('2d');g.globalAlpha=.85;
      for(const [x,y,glow] of pixels){g.fillStyle=glow?st.glow:st.color;g.fillRect(x+58,y+124,3,2);}
      g.globalAlpha=.18;g.fillStyle=st.glow;g.fillRect(44,4,28,120);
      if(WINGS.size>=256)WINGS.delete(WINGS.keys().next().value);WINGS.set(key,im);}
    blit(v,im,0,0,116,128,bx-58,by-124);
  }
}
function levelFront(v, h, bx, by, st, lv) {

  if (lv >= 2) {                                     // halo
    const y = by - 72 + Math.round(Math.sin(performance.now() / 500) * 1);
    let im=HALOS.get(st.glow);if(!im){im=document.createElement('canvas');im.width=24;im.height=12;const g=im.getContext('2d');g.globalAlpha=.9;g.fillStyle=st.glow;
      for(let i=0;i<16;i++){const a=i/16*6.28;g.fillRect(N(Math.cos(a)*9)+11,N(Math.sin(a)*3)+5,2,1);}HALOS.set(st.glow,im);}
    blit(v,im,0,0,24,12,bx-11,y-5);
  }

}
function blitMon(v, kind, bx, by, alpha = 1) {
  const im = MIMG[kind]; if (!im) return null;
  cx.globalAlpha = alpha; blit(v, im, 0, 0, im.width, im.height, bx - Math.floor(im.width / 2), by - im.height + 1); cx.globalAlpha = 1;
  return im;
}
function monster(v, t) {
  if (!onScreen(v,t.mx ?? t.x,t.my ?? t.y,200,200)) return;
  if (t.region === 'camp' && t.slot >= 18) return;                          // camp yard shows the first 18 only
  const kind = mtype(t), key = `${kind}-${mtier(t)}`, im2 = MON2[key], M = MMETA2[key];
  const walking = !!(t.mpath && t.emerge <= 0), kick = Math.round(ease(t.kick || 0) * 8);
  const bx = N(t.mx !== undefined ? t.mx : t.x) + kick, by = N(t.mx !== undefined ? t.my : t.y);
  const alpha = t.alpha * (t.emerge > 0 ? 1 - t.emerge / .9 : 1);
  if (mtier(t) === 'l' && !t.dying) {                                       // elite: smouldering red ground ring
    cx.fillStyle = `rgba(220,40,30,${.18 + Math.sin(performance.now() / 300) * .06})`;
    const r = Math.round((M ? M.fw * .3 : 24));
    for (let i = -3; i <= 3; i++) { const half = Math.round(r * Math.sqrt(1 - (i / 3.5) ** 2)); cx.fillRect(v.ox + (bx - half) * v.Z, v.oy + (by + i) * v.Z, half * 2 * v.Z, v.Z); }
  }
  shadowPx(v, bx, by + 1, M ? Math.round(M.fw * .2) : 16);
  let top;
  if (im2 && M) {
    let fr = 0, bob = 0;
    if (t.dying) fr = 9 + Math.min(2, Math.floor((1 - t.dying) * 3));
    else if (t.atk >= 0) fr = 4 + Math.min(3, Math.floor(t.atk / .125));
    else if (t.flash > .02) fr = 8;
    else if (walking) fr = Math.floor(t.mdist / 9) % 4;
    else { fr = Math.floor(performance.now() / 380 + t.slot) % 2 ? 0 : 2; bob = 0; }      // idle: shift weight between two stances
    const face = walking ? (t.mface || -1) : -1;                            // sheets face LEFT; flip when marching right

    cx.globalAlpha = Math.max(0, Math.min(1, alpha * (t.dying ? Math.min(1, t.dying * 2.5) : 1)));
    blit(v, t.flash > 0 && !calm ? flashSheet(im2,2.6) : im2, fr * M.fw, 0, M.fw, M.fh, face < 0 ? bx - M.ax : bx - (M.fw - M.ax), by - M.base - bob, face > 0);
    cx.globalAlpha = 1; cx.filter = 'none';
    top = by - Math.round(M.fh * .78);
  } else {
    const bob = Math.floor(performance.now() / 420 + t.slot) % 2 * 2;

    const im = blitMon(v, t.chained ? 'skeleton' : (MON[t.stage] || 'goblin'), bx, by - bob, alpha * (t.dying ? t.dying : 1));
    cx.filter = 'none'; top = by - (im ? im.height : 40) - 6;
  }

  if (t.state === 'caged' && !walking) emoji('⛓', v.ox + (bx + 14) * v.Z, v.oy + (top + 10) * v.Z, 10 * v.Z);
  if (t.alpha > .5 && !t.dying && t.region !== 'camp') {                  // HP bar = time left; camp monsters just wait
    const w = 36, x0 = bx - w / 2;
    cx.fillStyle = '#141824'; cx.fillRect(v.ox + (x0 - 2) * v.Z, v.oy + (top - 2) * v.Z, (w + 4) * v.Z, 6 * v.Z);
    cx.fillStyle = t.chained ? '#e0503c' : t.hp > .4 ? '#e8c04a' : '#e0503c'; cx.fillRect(v.ox + x0 * v.Z, v.oy + top * v.Z, Math.max(1, Math.round(w * t.hp)) * v.Z, 2 * v.Z);

  }
}
function dragon(v) {
  const [x, y] = W.regions.volcano.spot, b = Math.floor(performance.now() / 700) % 2;
  blitMon(v, 'dragon', N(x) + 52, N(y) - 12 - b * 2);
}
function nameplate(x, y, text, color) {
  if(!UI)return;
  const digits=String(text).replace(/−/g,'-').match(/[+-]?\d+/)?.[0];
  if(digits){const n=Number(digits),label=(n<0?'-':digits.startsWith('+')?'+':'')+compact(Math.abs(n));
    UI.screenNumber(label,x/DPR,y/DPR,color);
    if(/CRIT|COMBO/.test(text))UI.screenIcon(effectIcon(text),x/DPR,y/DPR-40);}
  else UI.screenIcon(effectIcon(text),x/DPR,y/DPR);
}
function bubble(x, y, text) {
  if(UI)UI.screenIcon('message',x/DPR,y/DPR);
}
function effectIcon(text) {
  const icons={'📜':'read','📖':'read','🔍':'search','👁':'vision','✒':'write','🗝':'memory','🕊':'message','🐦‍⬛':'message','🐣':'delegate','🦊':'delegate','🧙':'delegate','⚒':'commit','🎈':'push','⚔':'merge','🪙':'coin','💤':'sleep','⛓':'chain','🔮':'search'};
  if(String(text).includes('CRIT'))return 'crit';if(String(text).includes('CLEAR'))return 'verify';if(String(text).includes('COMBO'))return 'sword';
  return icons[text]||'info';
}
function emoji(e, x, y, size) { if(UI)UI.screenIcon(effectIcon(e),x/DPR,y/DPR); }
function compact(n) {return n>9999?'9999+':String(Math.max(0,Math.round(n)));}
function px(v, x, y, w, h, c) { cx.fillStyle = c; cx.fillRect(v.ox + Math.round(x) * v.Z, v.oy + Math.round(y) * v.Z, w * v.Z, h * v.Z); }
function fxDraw(v, f) {
  const k = f.max ? 1 - f.life / f.max : 0;
  if (f.k === 'bolt') { let x = f.x, y = f.y - 90; cx.globalAlpha = 1 - k; while (y < f.y) { const nx = x + (Math.random() - .5) * 10; px(v, nx, y, 2, 6, Math.random() < .3 ? '#fff' : f.color); x = nx; y += 6; } cx.globalAlpha = 1; return; }
  if (f.k === 'swirl') { const n = 10, r = 26 * (1 - ease(k)); for (let i = 0; i < n; i++) { const a = i / n * 6.28 + k * 9; px(v, f.x + Math.cos(a) * r, f.y + Math.sin(a) * r * .6, 2, 2, i % 2 ? '#c8b0ff' : '#9fd3ff'); } if (k > .8) emoji('📜', v.ox + N(f.x) * v.Z, v.oy + N(f.y) * v.Z, 12 * v.Z); return; }
  if (f.k === 'balloon') { const y = f.y - ease(k) * 120, x = f.x + Math.sin(k * 8) * 6; cx.globalAlpha = Math.min(1, f.life * 2); emoji('🎈', v.ox + N(x) * v.Z, v.oy + N(y) * v.Z, 14 * v.Z); cx.globalAlpha = 1; return; }
  if (f.k === 'proj') {
    const e = f.proj === 'arrow' ? k : ease(k), x = lerp(f.x0, f.x1, e), y = lerp(f.y0, f.y1, e) - Math.sin(e * Math.PI) * f.arc;
    const dx = f.x1 - f.x0, dy = f.y1 - f.y0 - Math.cos(e * Math.PI) * f.arc * 3, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
    if (f.proj === 'arrow') { for (let i = 0; i < 12; i++) px(v, x - ux * i, y - uy * i, 1, 1, i < 2 ? '#dfe6ee' : i > 9 ? '#c84a3a' : f.color); }
    else if (f.proj === 'orb' || f.proj === 'wisp' || f.proj === 'glob') {
      for (let i = 1; i < 6; i++) { cx.globalAlpha = .5 - i * .08; px(v, x - ux * i * 4 - 2, y - uy * i * 4 - 2, 4, 4, f.color); }
      cx.globalAlpha = 1; px(v, x - 3, y - 3, 6, 6, f.color); px(v, x - 2, y - 2, 3, 3, f.glow);
    } else if (f.proj === 'rune') { const a = k * 14; for (let i = 0; i < 4; i++) px(v, x + Math.cos(a + i * 1.57) * 4, y + Math.sin(a + i * 1.57) * 4, 2, 2, f.color); px(v, x - 1, y - 1, 3, 3, f.glow); }
    else if (f.proj === 'gear') { const a = k * 18; for (let i = 0; i < 6; i++) px(v, x + Math.cos(a + i * 1.05) * 4, y + Math.sin(a + i * 1.05) * 4, 2, 2, f.color); px(v, x - 1, y - 1, 2, 2, '#5a4a2a'); }
    return;
  }
  if (f.k === 'slash') {                                                       // crescent of pixels sweeping top -> bottom
    const sweep = Math.min(1, k * 1.6);
    for (let i = 0; i < 14; i++) { const t2 = i / 13; if (t2 > sweep) break; const a = -1.1 + t2 * 2.2;
      const r = (20 - Math.abs(t2 - .5) * 6) * (f.big || 1); px(v, f.x - f.dir * 6 + Math.cos(a) * r * f.dir, f.y + Math.sin(a) * r, 2, 2, i > 10 ? f.glow : f.color); }
    return;
  }
  if (f.k === 'pillar') { cx.globalAlpha = 1 - k; px(v, f.x - 5, f.y - 70 * (1 - k * .3), 10, 70 * (1 - k * .3), f.color); px(v, f.x - 2, f.y - 70, 4, 70, '#fffbe6'); cx.globalAlpha = 1; return; }
  if (f.k === 'ring') {
    const r = f.r * (.3 + k * .9), n = Math.max(10, Math.round(r * 1.2)); cx.globalAlpha = 1 - k;
    for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2; px(v, f.x + Math.cos(a) * r, f.y + Math.sin(a) * r * (f.flat ? .35 : 1), 2, 2, f.color); }
    cx.globalAlpha = 1; return;
  }
  if (f.k === 'p') { const [x, y] = P(v, f.x, f.y); cx.fillStyle = f.color; cx.fillRect(x, y, 2 * v.Z, 2 * v.Z); }
  else if (f.k === 'num') { const [x, y] = P(v, f.x, f.y - 18 * ease(Math.min(1, k * 1.6))); cx.globalAlpha = Math.min(1, f.life * 2); nameplate(x, y, f.text, f.color); cx.globalAlpha = 1; }
  else if (f.k === 'coin') { const e = ease(k), [x, y] = P(v, lerp(f.x0, f.x1, e), lerp(f.y0, f.y1, e) - Math.sin(e * Math.PI) * 60); emoji('🪙', x, y, 7 * v.z); }
  else if (f.k === 'arrows') { const e = ease(k); for (let i = 0; i < 3; i++) { const [x, y] = P(v, lerp(f.x0, f.x1, e) - i * 6, lerp(f.y0, f.y1, e) + i * 2); cx.fillStyle = '#e8f0ff'; cx.fillRect(x, y, 6 * v.Z, v.Z); } }
  else if (f.k === 'portal') { const [x, y] = P(v, f.x, f.y); const r = (8 + Math.sin(k * 20) * 2) * v.z * Math.min(1, k * 4) * Math.min(1, f.life * 2); cx.strokeStyle = '#7fc8ff'; cx.lineWidth = 3 * DPR; cx.beginPath(); cx.ellipse(x, y - 14 * v.z, r * .6, r * 1.3, 0, 0, 7); cx.stroke(); }
  else if (f.k === 'raven') { const e = ease(k), [x, y] = P(v, lerp(f.x0, f.x1, e), lerp(f.y0, f.y1, e) - Math.sin(e * Math.PI) * 50); emoji(f.icon || '🐦‍⬛', x, y, 9 * v.z); }
  else if (f.k === 'council') { const [x,y]=P(v,f.h.x,f.h.y);emoji('🧙',x,y-46*v.z,16);nameplate(x,y-68*v.z,'2','#ffd36b'); }
}
function vignette() { const g = cx.createRadialGradient(cv.width / 2, cv.height / 2, cv.height * .45, cv.width / 2, cv.height / 2, cv.height * .95); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.28)'); cx.fillStyle = g; cx.fillRect(0, 0, cv.width, cv.height); }

// ---------- HUD / panels ----------
function say(html, t, key, minGap = 0) {
  if (key && minGap && S.lastFeed[key] && t - S.lastFeed[key] < minGap) return;
  if (key) {
    delete S.lastFeed[key]; S.lastFeed[key] = t;
    // Live compaction/rebase preserves feed throttles; do not accumulate keys
    // for every evicted task over the lifetime of a continuously running tab.
    const keys = Object.keys(S.lastFeed);
    if (keys.length > HISTORY_LIMIT) delete S.lastFeed[keys[0]];
  }
  S.feed.unshift({t, html}); S.feed.length = Math.min(S.feed.length, 60); S.feedDirty = true;
}
function renderFeed() {
  if(!UI||$('#chron').hidden||$('#menu').hidden||!$('#group-overview').open)return;
  UI.feed(S.feed.map(f=>{
    const detailText=fmt(f.t)+' '+UI.plain(f.html);
    let text=UI.plain(f.html).replace(/ — .*$/u,'');
    if(/^💬|^🐦‍⬛ Captain:/.test(text))text='💬 Message; open Details';
    else if(/^💀/.test(text))text='💀 Work stopped; open Details';
    else if(/^🌀/.test(text))text='🌀 Quest handoff; open Details';
    else if(/^🦊/.test(text))text='🦊 Subagent summoned; open Details';
    if(D.meta.show_titles!==true){
      for(const t of D.tasks)text=text.split(t.id).join('Task details hidden');
      for(const b of D.bots)text=text.split(b.id).join('Hero');
    }
    return {text:fmt(f.t)+' '+text,detailText};
  }));
  S.feedDirty=false;
}
function renderCamps() {
  if(!UI)return;
  const by={};for(const t of D.tasks)(by[t.campaign]||=[]).push(t);
  const rows=Object.entries(by).map(([title,ts])=>{
    const live=ts.map(t=>S.tasks[t.id]).filter(Boolean),done=live.filter(t=>t.state==='done').length;
    return {title,count:done+'/'+ts.length+' quests',blocked:live.find(t=>t.state==='blocked')?.title,
      stages:STAGES.map(st=>{const group=live.filter(t=>t.stage===st);return {id:st.toLowerCase(),state:group.some(t=>t.state==='fight')?'selected':group.length&&group.every(t=>t.state==='done')?'normal':'disabled'};})};
  });UI.camps(rows);
}
const TASK_STATES={quest:'Waiting',fight:'Working',blocked:'Blocked',caged:'Waiting for dependencies',done:'Complete',failed:'Failed'};
function renderOverview() {
  const states=Object.values(S.tasks),blocked=states.filter(t=>t.state==='blocked'||t.chained).length;
  const working=states.filter(t=>t.state==='fight').length,waiting=states.filter(t=>['quest','caged'].includes(t.state)).length;
  const completed=states.filter(t=>t.state==='done').length;
  const permitted=D.meta.show_titles===true,failures=new Map();
  for(const e of D.events){
    if(e.t>S.t)break;
    if(!e.task)continue;
    if(e.kind==='run_start'||e.kind==='completed')failures.delete(e.task);
    else if(e.kind==='run_end'&&['timed_out','crashed','gave_up'].includes(e.outcome))failures.set(e.task,({timed_out:'Run timed out',crashed:'Worker stopped unexpectedly',gave_up:'Worker stopped work'})[e.outcome]);
  }
  const tasks=D.tasks.map(meta=>{
    const t=S.tasks[meta.id]||meta, state=TASK_STATES[t.state]||'Not started in selected range';
    return {key:meta.id,blocked:t.state==='blocked'||!!t.chained,
      summary:(permitted?meta.title||'Untitled task':'Task details hidden')+' · '+state+(t.stage?' · '+(STAGE_TH[t.stage]||'Unknown stage'):'')+(t.bot?' · Assigned to: '+(permitted?D.bots.find(b=>b.id===t.bot)?.name||'Hero':'Hero'):''),
      details:()=>{const current=D.tasks.find(row=>row.id===meta.id);if(current)quest(S.tasks[meta.id]||current);else UI.detail(['This task is no longer in retained history'],'Task details');}};
  }).sort((a,b)=>Number(b.blocked)-Number(a.blocked));
  const heroes=Object.values(S.heroes).map(h=>({key:h.bot,
    summary:(permitted?h.name:'Hero')+' · '+heroStatus(h),
    details:()=>{const current=S.heroes[h.bot];if(current)heroDialog(current);else UI.detail(['This hero is no longer in retained history'],'Hero details');}}));
  UI.overview({tasks,heroes,blocked,errors:[...Object.keys(S.diagnostics||{}),...failures.values(),...states.filter(t=>t.state==='failed').map(()=> 'A task failed')],
    empty:'No tasks in this replay range',summary:D.tasks.length?working+' working · '+waiting+' waiting · '+blocked+' blocked · '+completed+' complete'+(!working&&!blocked?' · No active work':''):'No tasks in this replay range'});
}
let hudT=0;
function hud(dt) {
  if(!UI || privacyPending)return;
  if((hudT+=dt)<.1)return;hudT=0;
  UI.number('#clock',fmt(S.t),'Replay time');UI.number('#speeds',String(S.speed),'Speed');
  UI.control('#play',S.play?'pause':'play',S.play?'Pause':'Play');
  UI.control('#live','live-follow','Follow live',following?'selected':'normal');
  $('#play').setAttribute('aria-pressed',String(!S.play));$('#live').setAttribute('aria-pressed',String(following));
  $('#scrub').value=Math.max(0,Math.min(1000,Math.round((S.t-D.meta.from_)/Math.max(1,D.meta.to-D.meta.from_)*1000)));
  $('#scrub').setAttribute('aria-valuetext',fmt(S.t));
  renderFeed();renderCamps();UI.resources(S.mana,S.tokenNetByWallet);renderOverview();
  UI.playback((S.play?'Playing':'Paused')+' · Live-follow '+(following?'on':'off')+' · '+fmt(S.t)+' · Range '+fmt(D.meta.from_)+' - '+fmt(D.meta.to));
}
function ui() {
  resize();addEventListener('resize',resize);
  document.addEventListener('visibilitychange',visibility);
  $('#speeds').onclick=()=>{following=false;const speeds=[30,120,600];S.speed=speeds[(speeds.indexOf(S.speed)+1)%speeds.length];hudT=1;hud(0);};
  $('#play').onclick=()=>{following=false;S.play=!S.play;hudT=1;hud(0);};
  $('#scrub').oninput=e=>{following=false;reset(D.meta.from_+(D.meta.to-D.meta.from_)*e.target.value/1000);};
  $('#live').hidden=!liveFeed;$('#live').onclick=goLive;
  $('#calm').onclick=()=>{calm=!calm;$('#calm').setAttribute('aria-pressed',String(calm));if(UI)UI.control('#calm','calm','Reduce effects',calm?'selected':'normal');};
  $('#world').onclick=()=>{Object.assign(cam,{tx:W.size[0]/2,ty:W.size[1]/2,zi:1});
    if(UI)UI.detail(Object.entries(W.regions).map(([k,r])=>UI.plain(r.label)+(k==='vault'?' : '+S.vault:'')),'World');};
  $('#tabs').onclick=e=>{const t=e.target.closest('[data-t]')?.dataset.t;if(t&&UI){UI.drawer(t);renderFeed();renderCamps();}};
  hudT=1;hud(0);
  const pointers = new Map(); let moved = 0, pinch = null;
  const distance = () => { const [a, b] = [...pointers.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  cv.onpointerdown = e => {
    if (!pointers.size) moved = 0;
    pointers.set(e.pointerId, {x: e.clientX, y: e.clientY}); cv.setPointerCapture(e.pointerId);
    if (pointers.size === 2) { pinch = {distance: distance(), zoom: cam.zi}; moved = 10; }
  };
  cv.onpointermove = e => {
    const prev = pointers.get(e.pointerId); if (!prev) return;
    pointers.set(e.pointerId, {x: e.clientX, y: e.clientY});
    if (pointers.size > 1) { if (pinch) cam.zi = Math.max(1, Math.min(4, pinch.zoom * distance() / Math.max(1, pinch.distance))); return; }
    const v = view(), dx = (e.clientX - prev.x) * DPR / v.z, dy = (e.clientY - prev.y) * DPR / v.z;
    moved += Math.abs(dx) + Math.abs(dy); cam.tx -= dx; cam.ty -= dy; cam.x -= dx; cam.y -= dy;
  };
  cv.onpointerup = e => { const was = pointers.delete(e.pointerId); pinch = null; if (was && !pointers.size && moved < 4) click(e); };
  cv.onpointercancel = cv.onlostpointercapture = e => { pointers.delete(e.pointerId); pinch = null; moved = 10; };
  cv.onwheel = e => { e.preventDefault(); cam.zi = Math.max(1, Math.min(4, cam.zi + (e.deltaY < 0 ? 1 : -1))); };
}
function click(e) {
  if(privacyPending)return;
  const v = view(), wx = (e.clientX * DPR - v.ox) / v.z, wy = (e.clientY * DPR - v.oy) / v.z;
  const t = Object.values(S.tasks).filter(t => t.alpha > 0).sort((a, b) => Math.hypot(a.x - wx, a.y - 15 - wy) - Math.hypot(b.x - wx, b.y - 15 - wy))[0];
  if (t && Math.hypot(t.x - wx, t.y - 15 - wy) < 22) return quest(t);
  const h=Object.values(S.heroes).find(h=>Math.hypot(h.x-wx,h.y-36-wy)<36);
  if(h&&UI)return heroDialog(h);
  const r = Object.entries(W.regions).sort((a, b) => Math.hypot(a[1].spot[0] - wx, a[1].spot[1] - wy) - Math.hypot(b[1].spot[0] - wx, b[1].spot[1] - wy))[0];
  Object.assign(cam, {tx: r[1].spot[0], ty: r[1].spot[1] - 20, zi: 2});
  if(UI)UI.detail([r[1].label,'Quests: '+Object.values(S.tasks).filter(t=>t.region===r[0]).length],'Region');
}
function questLines(t) {
  const h=t.bot&&S.heroes[t.bot], elapsed=t.runStart?Math.round((S.t-t.runStart)/60):0;
  return ['Task ID: '+t.id,D.meta.show_titles===true?t.title:'Task details hidden',
    'Assigned to: '+(h?h.name+' ('+h.bot+')':'Not provided'),
    'Stage: '+(STAGE_TH[t.stage]||'Unknown')+' · Status: '+(TASK_STATES[t.state]||'Not started in selected range'),
    ...(t.runStart?['Run elapsed: '+elapsed+' minutes']:[]),
    ...(Number.isFinite(t.max_rt)?['Run time limit: '+Math.round(t.max_rt/60)+' minutes']:[]),
    'Campaign: '+(t.campaign||'Not provided'),'Latest note: '+(D.meta.show_titles===true?t.note||'Not provided':'Task details hidden'),
    [t.moa?'MoA':'',t.mock?'Demo':'',t.chained?'Blocked':''].join(' ')];
}
// Open task/hero dialogs follow the identity: refresh while it is retained, close (focus back to the opener) once it is evicted.
function quest(t) {
  if(privacyPending)return;
  const id=t.id;
  if(UI)UI.detail(questLines(t),'Quest',{refresh:()=>{
    const current=S.tasks[id]||D.tasks.find(row=>row.id===id);
    return current?questLines(current):null;}});
}
function heroDialog(h) {
  const id=h.bot;
  UI.detail(heroDetails(h),'Hero',{refresh:()=>{const current=S.heroes[id];if(current)return heroDetails(current);return D.bots.some(b=>b.id===id)?undefined:null;}});
}
function heroStatus(h) {
  return restLocked(h)?(h.rest.phase==='moving'?'Walking to rest':'Resting'):h.task?'Working':h.rest.state==='active-unobserved'?'Status unobserved':'Active';
}
function heroDetails(h) {
  const ledger = S.tokenNetByBot[h.bot],source=D.bots.find(b=>b.id===h.bot),current=h.task&&S.tasks[h.task];
  return [D.meta.show_titles===true?h.name:'Hero details hidden','Hero ID: '+h.bot,
    'Game class: '+h.cls,'Model: '+(source?.model||'Not provided'),'Effort: '+(source?.effort||'Not provided'),heroStatus(h),
    'Scene region: '+(W.regions[h.region]?.label||'Unknown'),
    'Current task: '+(current?(D.meta.show_titles===true?current.title:'Task details hidden'):'No current task in selected range'),
    'Rest reason: '+(REST_REASON[h.rest.why] || (h.rest.why?'Unknown':'None')),
    ...(h.rest.state === 'transferred' ? ['Switch signal only; quest ownership is unchanged'] : []),
    'Used tokens: '+(ledger ? Math.max(0,ledger.net).toLocaleString('en-GB') : 'Unknown (no usage events)'),
    'Signed token balance: '+(ledger?.net ?? 'Unknown'),
    ...(ledger?.hasCharsEstimate ? ['Includes estimates from text size'] : []),
    ...(ledger?.hasUsageCorrection ? ['Includes signed usage corrections'] : []),
    'Simulated capacity: 100,000 tokens per wallet per replay epoch; not real quota',
    'Historical usage may differ until reload (backend limitations)',
    ...Object.keys(S.diagnostics).filter(key=>key.startsWith('Rest ')),h.bubble?.text||'-'];
}
if(UI){UI.init();UI.status('Loading activity…','loading');}
boot();
