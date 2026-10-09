'use strict';
// Owns transport; peer bindings stay live on the per-game context. Registration never boots.
(globalThis.HQModules ||= {}).createTransport = function createTransport(ctx) {

const API = '/api/plugins/hermes-quest/';
let liveFeed = false, following = false, cursor = '', pollTimer = null;
const TRANSPORT_MS = 35000;
let pollBusy = false;
// Live health: consecutive failed polls and the last time a fetch fully succeeded (ms). UI-only; never read by the scene.
let pollFailures = 0, lastPollOk = null, pollStale = false;
function connection(text, state, extra) { if (ctx.UI) ctx.UI.status(text, state, extra); }
function connectedStatus(payload) {
  if (ctx.D.session_data?.status === 'unavailable') return connection('Session activity unavailable', 'snapshot');
  connection(payload.state === 'legacy-fallback' ? 'Snapshot fallback' : 'Connected · 10s', payload.state === 'legacy-fallback' ? 'snapshot' : 'online');
}
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
// Three failed polls in a row (~30 s) or any 4xx means live data is not updating: say so on screen with a
// short reason and the last good time. Never exposes the response body, URL or cursor; the scene keeps running.
function pollFailed(e) {
  pollFailures++;
  const status = Number.isInteger(e?.status) ? e.status : 0, client = status >= 400 && status < 500;
  // Once the warning is up it stays up (with the latest reason) until a poll really succeeds: a different failure kind must not downgrade it.
  if (!pollStale && pollFailures < 3 && !client) { connection('Offline · retrying in 10s', 'offline'); return; }
  pollStale = true;
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
    try { ctx.mergeDelta(delta); } catch (e) {
      if (!(e instanceof ctx.HistoryExpired)) throw e;
      if (e instanceof ctx.IdentityChanged) {
        ctx.clearInspection();
        ctx.privacyPending = true;
        ctx.D.meta.show_profile_names = false;
        ctx.redactCharacterNames();
        ctx.redactText(); ctx.checkpoint = null;
        Object.assign(ctx.S, ctx.emptyState());
        if (ctx.UI) ctx.UI.privacy();
        ctx.cx.clearRect?.(0,0,ctx.cv.width,ctx.cv.height);
      }
      const replay = await json(`${API}replay?hours=12`);
      if (replay.cursor === undefined) throw new Error('Missing replay cursor');
      // Playback/controls may advance while the snapshot is in flight. Classify
      // against the applied boundary at commit time, not at request start.
      const playhead = ctx.S.t;
      const animate = liveFeed && following && ctx.S.play;
      const appliedThrough = ctx.D.events[ctx.S.i - 1]?.t ?? ctx.checkpoint?.t ?? -Infinity;
      const applied = new Set(ctx.D.events.slice(0, ctx.S.i).map(ctx.eventKey));
      const pending = new Set(ctx.D.events.slice(ctx.S.i).map(ctx.eventKey));
      // Outside-floor overlap is historical; bounded dedup cannot classify it.
      // Inside the window, genuinely late delta actions still animate.
      for (const event of delta.events) if (!ctx.eventKeys.has(ctx.eventKey(event)) && event.t > (ctx.checkpoint?.t ?? -Infinity)) pending.add(ctx.eventKey(event));
      for (const event of replay.events || []) if (event.t >= appliedThrough && event.t > (ctx.checkpoint?.t ?? -Infinity) && !applied.has(ctx.eventKey(event))) pending.add(ctx.eventKey(event));
      // Drop old scene/feed/effects on migration; no persistent client storage
      // exists. Normal retention rebases still preserve fresh live feedback.
      if (e instanceof ctx.IdentityChanged) ctx.loadReplay(replay, null, playhead);
      else if (animate) ctx.loadReplay(replay, {t: playhead, keys: pending});
      else { ctx.loadReplay(replay); ctx.reset(playhead); }
    }
    pollFailures = 0; pollStale = false; lastPollOk = Date.now();
    connectedStatus(delta);
  } catch (e) { pollFailed(e); }
  finally {
    // Serial requests: no overlap or advancing the cursor on a failed response.
    pollBusy = false; pollTimer = document.hidden ? null : setTimeout(pollEvents, 10000);
  }
}
function goLive() {
  following = true; ctx.S.play = true; ctx.S.speed = 1;
  document.querySelectorAll('[data-s]').forEach(b => b.classList.toggle('on', false));
  ctx.reset(Date.now() / 1000); if (ctx.UI) ctx.UI.control('#play','pause','Pause');
}
function visibility() {
  if (document.hidden) {
    if (ctx.raf !== null) cancelAnimationFrame(ctx.raf); ctx.raf = null;
    clearTimeout(pollTimer); pollTimer = null; ctx.loop.last = null;
  } else if (ctx.D && ctx.W) {
    ctx.loop.last = null;
    if (ctx.raf === null) ctx.raf = requestAnimationFrame(ctx.loop);
    if (liveFeed) pollEvents();
  }
}
return {
  get API(){return API},
  get liveFeed(){return liveFeed}, set liveFeed(v){liveFeed=v},
  get following(){return following}, set following(v){following=v},
  get cursor(){return cursor}, set cursor(v){cursor=v},
  get pollTimer(){return pollTimer}, set pollTimer(v){pollTimer=v},
  get TRANSPORT_MS(){return TRANSPORT_MS},
  get pollBusy(){return pollBusy}, set pollBusy(v){pollBusy=v},
  get pollFailures(){return pollFailures}, set pollFailures(v){pollFailures=v},
  get lastPollOk(){return lastPollOk}, set lastPollOk(v){lastPollOk=v},
  get pollStale(){return pollStale}, set pollStale(v){pollStale=v},
  get connection(){return connection}, set connection(v){connection=v},
  get connectedStatus(){return connectedStatus}, set connectedStatus(v){connectedStatus=v},
  get json(){return json}, set json(v){json=v},
  get pollFailed(){return pollFailed}, set pollFailed(v){pollFailed=v},
  get pollEvents(){return pollEvents}, set pollEvents(v){pollEvents=v},
  get goLive(){return goLive}, set goLive(v){goLive=v},
  get visibility(){return visibility}, set visibility(v){visibility=v}
};
};
