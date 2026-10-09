// Hermes Quest demo: replays Hermes kanban + worker tool calls as an RPG world (back test).
// Plain Canvas 2D, no deps. Motion rules from the design talk:
//  - walk frames advance by distance travelled (no foot sliding), contact-frame bob, ground shadow,
//    eased start/stop; figures only travel on precomputed road paths (no wall walking)
//  - integer screen positions + nearest-neighbour sprites (no shimmer), preloaded atlases (no flicker)
//  - attacks are anticipation -> swing -> impact (hit-stop + shake + flash) -> recover
'use strict';
// D2 facade: construction owns all game state; registration does not boot.
function createGame({autoBoot = true} = {}) {
// Two-phase wiring: publish live root bindings, construct without calling peers, then boot.
const ctx = {};

const $ = s => document.querySelector(s);
const cv = $('#stage'), cx = cv.getContext('2d');
const DPR = Math.min(2, window.devicePixelRatio || 1);
const UI = window.UIPanels;
let calm = false;

const img = src => new Promise(r => { const i = new Image(); i.onload = () => r(i); i.onerror = () => r(null); i.src = src; });
const CLOCK_FORMAT = new Intl.DateTimeFormat('en-GB', {hour: '2-digit', minute: '2-digit'});
const fmt = t => { const d = new Date(t * 1000); return Number.isNaN(d.getTime()) ? 'Invalid Date' : CLOCK_FORMAT.format(d); };

let MON2 = {}, MMETA2 = {}, SPRV = {};
let D, W, BG, SPR = {}, MONS = null, MONMETA = null, BLD = {}, MIMG = {}, HMETA = {fw: 128, fh: 96, ax: 48, base: 91, walk: [0, 1, 2, 3], atk: [4, 5, 6, 7], idle: []};

// Page-local presentation only. Never part of a replay checkpoint or live cursor.
const inspect = {bot: null, session: null, follow: false, picks: [], choices: null, key: '', revision: null, fit: false, zoom: null, fittedZoom: null};
const ALPHA_BOXES = new WeakMap();
function spriteBox(im, sx, sy, w, h) {
  let boxes = ALPHA_BOXES.get(im); if (!boxes) { boxes = new Map(); ALPHA_BOXES.set(im, boxes); }
  const key = [sx, sy, w, h].join(':'); if (boxes.has(key)) return boxes.get(key);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); g.drawImage(im, sx, sy, w, h, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  let left = w, top = h, right = 0, bottom = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 0) {
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
  }
  const box = right ? {left, top, right, bottom} : null; boxes.set(key, box); return box;
}
function registerCharacter(v, type, id, box) {
  if (!box) return;
  const r = cv.getBoundingClientRect(), scale = r.width / cv.width;
  const body = {left:r.left+(v.ox+box.left*v.Z)*scale, top:r.top+(v.oy+box.top*v.Z)*scale,
    right:r.left+(v.ox+box.right*v.Z)*scale, bottom:r.top+(v.oy+box.bottom*v.Z)*scale};
  if (body.right < r.left || body.left > r.right || body.bottom < r.top || body.top > r.bottom) return;
  const dx = Math.max(0, (44 - (body.right-body.left))/2), dy = Math.max(0, (44 - (body.bottom-body.top))/2);
  inspect.picks.push({type,id,world:box,body,anchor:type==='hero'?[ctx.S.heroes[id].x,ctx.S.heroes[id].y]:null,order:inspect.picks.length,
    hit:{left:body.left-dx,right:body.right+dx,top:body.top-dy,bottom:body.bottom+dy}});
}
function registerSprite(v, type, id, im, sx, w, h, nx, ny, flip) {
  const b = spriteBox(im, sx, 0, w, h); if (!b) return;
  registerCharacter(v,type,id,{left:nx+(flip?w-b.right:b.left),right:nx+(flip?w-b.left:b.right),top:ny+b.top,bottom:ny+b.bottom});
}
function characterName(id) {
  const b = D.bots.find(b => b.id === id);
  return D.meta.show_profile_names === true && b ? b.display_name || b.profile_name || b.pet_name || 'Hero' :
    'Hero '+Math.max(1,D.bots.findIndex(b => b.id === id)+1);
}
function redactCharacterNames() {
  for (const b of D.bots) {
    if (D.meta.show_profile_names === false) b.name = b.id;
    delete b.display_name; delete b.profile_name; delete b.pet_name;
  }
}
const validSessionRef = ref => typeof ref === 'string' && /^[a-f0-9]{20}$/.test(ref);
function characterSessions(id) {
  return (D.sessions || []).filter(s => s.bot === id && validSessionRef(s.session_ref) &&
    (!Number.isFinite(s.started_at) || s.started_at <= ctx.S.t));
}
function syncInspectionSessions(rows = D.sessions) {
  // A supplied inventory is authoritative, including an empty one; absence preserves it.
  D.sessions=[...new Map((rows||[]).filter(s=>s&&typeof s.bot==='string'&&validSessionRef(s.session_ref)&&
    (s.parent_session_ref == null || validSessionRef(s.parent_session_ref)))
    .map(s=>[s.session_ref,s])).values()].slice(-(HISTORY_LIMIT+METADATA_LIMIT));
  if (inspect.session && !characterSessions(inspect.bot).some(s=>s.session_ref===inspect.session)) inspect.session=null;
}
function selectedSession() {
  const rows = characterSessions(inspect.bot);
  return inspect.session ? rows.find(s => s.session_ref === inspect.session) || null : rows.length === 1 ? rows[0] : null;
}
function parentLabel(s) {
  if (!s) return 'Parent unknown';
  if (!s.parent_session_ref) return s.is_subagent === false ? 'Not a sub-agent' : 'Parent unknown';
  const parent = (D.sessions || []).find(p => validSessionRef(p.session_ref) && p.session_ref === s.parent_session_ref);
  return parent ? 'Parent: '+(ctx.S.heroes[parent.bot]?characterName(parent.bot):'Character unavailable') : 'Parent unknown';
}
function observedTasks(id) {
  return D.tasks.filter(t => ctx.S.tasks[t.id] ? ctx.S.tasks[t.id].bot === id : ctx.S.t >= D.meta.generated && t.bot === id).map(t => {
    const current = ctx.S.tasks[t.id];
    const status = current ? TASK_STATES[current.state] || 'Status unobserved' :
      ctx.S.t >= D.meta.generated ? ({running:'Working',done:'Complete',blocked:'Blocked',todo:'Waiting',ready:'Ready',review:'In review'})[t.status] || 'Status unobserved' : 'Status unobserved';
    return (D.meta.show_titles === true ? t.title || 'Untitled task' : 'Task details hidden')+' · '+status;
  });
}
function stopInspectionFollow() {
  if (inspect.zoom !== null && ctx.cam.zi === inspect.fittedZoom) ctx.cam.zi=inspect.zoom;
  inspect.follow=inspect.fit=false;inspect.zoom=inspect.fittedZoom=null;
}
function clearInspection(restore = false) {
  const card = $('#character-card'), owns = card?.contains?.(document.activeElement);
  stopInspectionFollow();
  inspect.bot = inspect.session = inspect.choices = null; inspect.key = '';
  if (card) { card.hidden = true; $('#character-heading').textContent = 'Character'; $('#character-content').replaceChildren?.(); }
  resetInspectionLayout();
  if (restore || owns) cv.focus?.();
}
function cardButton(parent, label, fn) {
  const b = document.createElement('button'); b.className = 'text-button'; b.style.width = '100%';
  b.textContent = label; b.onclick = fn; parent.append(b); return b;
}
function showInspection(id) {
  if (privacyPending || !ctx.S.heroes[id]) return;
  if (UI) UI.close();
  if (UI) UI.menu(false);
  inspect.revision = D.meta.config_revision ?? null;
  // Every successful hero inspection entry (canvas tap, chooser, overflow list, child link)
  // shares one selected identity, so the marker and the card name the same character.
  selectedScene = id;
  inspect.bot = id; inspect.session = null; inspect.choices = null; inspect.follow = true; inspect.key = '';
  renderInspection(); followCharacter(1); $('#character-close').focus();
}
function resetInspectionLayout() {
  const bar=$('#focus-bar'), card=$('#character-card');
  if (bar?.style) { bar.style.width=''; bar.classList.remove?.('inspection-side'); }
  if (card?.style) { card.style.left='8px'; card.style.width=innerWidth<=760?'calc(100vw - 16px)':'280px'; }
}
function inspectionFrame(bodyWidth, bodyHeight) {
  const bar=$('#focus-bar').getBoundingClientRect();
  let left=10,top=innerWidth/2-bodyWidth/2<bar.right+10?bar.bottom+10:10;
  // A wide attack pose in a short landscape viewport can fit beside the
  // status chip, but not underneath it. Reframe the camera, never the actor.
  if(innerHeight-top-bodyHeight-24<62 && innerWidth-20-bar.right>=bodyWidth){
    left=bar.right+10;top=10;
  }
  return {left,right:innerWidth-10,top,bottom:innerHeight-10};
}
function layoutInspection(bodyWidth, bodyHeight) {
  resetInspectionLayout();
  const card=$('#character-card'), bar=$('#focus-bar');
  const frame=inspectionFrame(bodyWidth,bodyHeight);
  // While the card is open the overflow badges collapse to one 44 px control stacked above it.
  const dock=UI?.placeOverflow&&$('#scene-overflow')&&!$('#scene-overflow').hidden?52:0;
  const room=innerHeight-frame.top-bodyHeight-24-dock;
  // If a bottom sheet cannot fit, reserve a side column for BOTH warning and
  // card. Keep the complete sprite at the chosen scale whenever it can fit.
  const sideWidth=Math.min(280,innerWidth-bodyWidth-36);
  if (room<62 && sideWidth>=96 && bodyHeight<=innerHeight-20) {
    card.style.width=bar.style.width=sideWidth+'px';bar.classList.add('inspection-side');
    card.style.maxHeight=Math.max(62,Math.min(innerWidth<=760?160:240,innerHeight-bar.getBoundingClientRect().bottom-16-dock))+'px';
    UI?.placeOverflow?.();
    return {left:sideWidth+24,right:innerWidth-10,top:10,bottom:innerHeight-10};
  }
  card.style.maxHeight=Math.max(62,Math.min(innerWidth<=760?160:240,innerHeight*.28,room))+'px';
  UI?.placeOverflow?.();
  const dockEl=$('#scene-overflow'),top=dockEl&&!dockEl.hidden?dockEl.getBoundingClientRect().top:card.getBoundingClientRect().top;
  return {...frame,bottom:Math.min(top,card.getBoundingClientRect().top)-10};
}
function renderInspection() {
  const card = $('#character-card'); if (!card) return;
  if (privacyPending || inspect.revision !== (D.meta.config_revision ?? null)) {
    clearInspection(); inspect.revision = D.meta.config_revision ?? null;
  }
  if (!inspect.bot && !inspect.choices) return;
  // Modal/Menu surfaces own focus and space while open. Never overlap them.
  if (!$('#quest').hidden || !$('#menu').hidden) { clearInspection(); return; }
  card.hidden = false;
  const selectedPick=inspect.picks.find(p=>p.type==='hero'&&p.id===inspect.bot);
  const height=selectedPick?selectedPick.world.bottom-selectedPick.world.top:70;
  const width=selectedPick?selectedPick.world.right-selectedPick.world.left:48;
  // A sprite wider than the viewport itself cannot be framed by translation.
  // Disclose that camera fit explicitly, rather than silently scaling the actor.
  if (inspect.follow) {
    if (inspect.zoom===null || ctx.cam.zi!==inspect.fittedZoom) inspect.zoom=ctx.cam.zi;
    ctx.cam.zi=Math.min(inspect.zoom,(innerWidth-20)/width,(innerHeight-20)/height);
    inspect.fittedZoom=ctx.cam.zi;inspect.fit=ctx.cam.zi<inspect.zoom;
  }
  layoutInspection(width*ctx.cam.zi,height*ctx.cam.zi);
  const h = ctx.S.heroes[inspect.bot], s = selectedSession(), rows = characterSessions(inspect.bot), b = D.bots.find(b => b.id === inspect.bot);
  if (inspect.bot && !h) stopInspectionFollow();
  const lines = inspect.choices ? [] : !h ? ['Character unavailable','Follow off'] : [
    D.meta.show_profile_names === true ? 'Profile: '+(b?.profile_name || 'Unknown')+' · Pet: '+(b?.pet_name || 'Unknown') : 'Profile and pet names hidden',
    rows.length > 1 && !s ? 'Choose a session to inspect its parent' : parentLabel(s),
    ...(observedTasks(inspect.bot).length ? observedTasks(inspect.bot) : ['No observed task']),
    'Follow '+(inspect.follow ? 'on' : 'off'),...(inspect.fit?['Zoom adjusted to fit this screen.']:[])];
  const heading = inspect.choices ? 'Choose character' : characterName(inspect.bot);
  const children=s?(D.sessions||[]).filter(row=>row.parent_session_ref===s.session_ref&&validSessionRef(row.session_ref)):[];
  const key = JSON.stringify([heading,lines,rows.map(s=>[s.session_ref,parentLabel(s)]),inspect.session,inspect.choices,children.map(c=>[c.session_ref,characterName(c.bot)])]);
  if (key === inspect.key) return; inspect.key = key;
  const content = $('#character-content'), active = document.activeElement, owns = content.contains(active);
  $('#character-heading').textContent = heading; content.replaceChildren();
  for (const line of lines) { const p=document.createElement('div');p.textContent=line;p.style.overflowWrap='anywhere';content.append(p); }
  if (inspect.choices) for (const pick of inspect.choices) cardButton(content,pick.type === 'hero' ? characterName(pick.id) : 'Monster · '+(ctx.STAGE_TH[ctx.S.tasks[pick.id]?.stage] || 'Unknown stage'),()=>{
    if (pick.type === 'hero') showInspection(pick.id); else {clearInspection();if(ctx.S.tasks[pick.id])quest(ctx.S.tasks[pick.id]);}
  });
  else if (h && rows.length > 1) rows.forEach((row,i)=>cardButton(content,'Session '+(i+1)+' · '+parentLabel(row),()=>{
    inspect.session=row.session_ref;inspect.key='';renderInspection();$('#character-close').focus();
  }));
  if(!inspect.choices&&children.length){const p=document.createElement('div');p.textContent=children.length+' child sessions'+(children.length>3?' · +'+(children.length-3)+' beyond three links':'');content.append(p);
    children.forEach((child,i)=>cardButton(content,'Child '+(i+1)+' · '+characterName(child.bot),()=>{
      if(ctx.S.heroes[child.bot]){showInspection(child.bot);inspect.session=child.session_ref;inspect.key='';renderInspection();}
      else {selectedScene=child.bot;inspect.bot=child.bot;inspect.session=child.session_ref;inspect.follow=false;inspect.key='';renderInspection();}
    }));}
  if (owns) $('#character-close').focus();
  layoutInspection(width*ctx.cam.zi,height*ctx.cam.zi);
}
function followCharacter(dt) {
  if (!inspect.follow || !inspect.bot) return;
  const h = ctx.S.heroes[inspect.bot]; if (!h || privacyPending) {stopInspectionFollow();return;}
  const pick = inspect.picks.find(p=>p.type==='hero'&&p.id===inspect.bot);
  const box = pick?.world ? {...pick.world} : {left:h.x-24,right:h.x+24,top:h.y-70,bottom:h.y};
  if(pick?.anchor){const dx=h.x-pick.anchor[0],dy=h.y-pick.anchor[1];box.left+=dx;box.right+=dx;box.top+=dy;box.bottom+=dy;}
  const {top,left,right,bottom}=layoutInspection((box.right-box.left)*ctx.cam.zi,(box.bottom-box.top)*ctx.cam.zi);
  const targetX = (left+right)/2, targetY = (top+bottom)/2;
  ctx.cam.tx=(box.left+box.right)/2-(targetX-innerWidth/2)/ctx.cam.zi;
  ctx.cam.ty=(box.top+box.bottom)/2-(targetY-innerHeight/2)/ctx.cam.zi;
  const k=calm?1:1-Math.exp(-dt/.18);ctx.cam.x=ctx.lerp(ctx.cam.x,ctx.cam.tx,k);ctx.cam.y=ctx.lerp(ctx.cam.y,ctx.cam.ty,k);
  // Allow background padding near world edges rather than moving the character.
  const rect = {left:innerWidth/2+(box.left-ctx.cam.x)*ctx.cam.zi,right:innerWidth/2+(box.right-ctx.cam.x)*ctx.cam.zi,
    top:innerHeight/2+(box.top-ctx.cam.y)*ctx.cam.zi,bottom:innerHeight/2+(box.bottom-ctx.cam.y)*ctx.cam.zi};
  if (rect.left<left)ctx.cam.x-=(left-rect.left)/ctx.cam.zi;else if(rect.right>right)ctx.cam.x+=(rect.right-right)/ctx.cam.zi;
  if (rect.top<top)ctx.cam.y-=(top-rect.top)/ctx.cam.zi;else if(rect.bottom>bottom)ctx.cam.y+=(rect.bottom-bottom)/ctx.cam.zi;
  ctx.cam.tx=ctx.cam.x;ctx.cam.ty=ctx.cam.y;
}
function inspectionLinks(v) {
  const s = selectedSession(); if (!s || !inspect.bot) return;
  const selected=inspect.picks.find(p=>p.type==='hero'&&p.id===inspect.bot);if(!selected)return;
  const refs = (D.sessions || []).filter(p=>validSessionRef(p.session_ref) &&
    (p.session_ref===s.parent_session_ref || p.parent_session_ref===s.session_ref));
  const ids=[...new Set(refs.map(p=>p.bot))].filter(id=>id!==inspect.bot);
  const visible=ids.map(id=>inspect.picks.find(p=>p.type==='hero'&&p.id===id)).filter(Boolean);
  const card=$('#character-card').getBoundingClientRect(),side=$('#focus-bar').classList.contains('inspection-side');
  const point=p=>P(v,(p.world.left+p.world.right)/2,p.world.bottom);
  cx.save();cx.beginPath();
  if(side)cx.rect((card.right+8)*DPR,0,Math.max(0,innerWidth-card.right-8)*DPR,cv.height);
  else cx.rect(0,0,cv.width,Math.max(0,card.top-8)*DPR);
  cx.clip();
  cx.strokeStyle='rgba(232,223,198,.25)';cx.lineWidth=DPR;
  for(const p of visible.slice(0,3)){const a=point(selected),b=point(p);cx.beginPath();cx.moveTo(...a);cx.lineTo(...b);cx.stroke();}
  cx.restore();
  if(visible.length>3 && UI){const a=point(selected);UI.screenNumber('+'+(visible.length-3),a[0]/DPR,a[1]/DPR-90);}
}

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
let pollFailures = 0, lastPollOk = null, pollStale = false;
const cloneState = v => JSON.parse(JSON.stringify(v));
class HistoryExpired extends Error {}
class IdentityChanged extends HistoryExpired {}
const captainId = () => D.meta.captain ?? '';
function normalizeBot(b) {
  const classes = D.meta.classes || {};
  const role = b.role || Object.keys(classes).find(r => b.id.startsWith(r));
  const cls = b.id === D.meta.captain ? 'commander' : (classes[role] || b.cls || 'mage');
  return {...b, cls, region: ctx.validRegion(D.meta.regions?.[cls] || b.region || ctx.defaultRegion())};
}
function normalizeData() {
  D.meta ||= {};
  D.meta.from_ ??= D.events[0]?.t ?? Date.now() / 1000;
  D.meta.to ??= D.events[D.events.length - 1]?.t ?? D.meta.from_;
  D.bots = D.bots.map(normalizeBot);
  // Metadata is opt-in. Sanitize before state, accessible DOM or bitmap caches.
  if (D.meta.show_titles !== true) redactText();
  if (D.meta.show_profile_names !== true) redactCharacterNames();
}
function archiveSnapshots(payload) {
  const at = payload.meta?.as_of;
  if (!Number.isFinite(at)) return [];
  // Only an explicit tombstone is authoritative. Date it at the snapshot, never
  // hide the task at earlier playheads just because today's row is archived.
  return payload.tasks.filter(t => t.status === 'archived' &&
    ![...(D?.events || []), ...payload.events].some(e => e.task === t.id && e.kind === 'archived' && e.t <= at))
    .map(t => ({id: 'snapshot-archive:' + t.id + ':' + at, task: t.id, kind: 'archived', t: at}));
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
function connectedStatus(payload) {
  if (D.session_data?.status === 'unavailable') return connection('Session activity unavailable', 'snapshot');
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
function restoreCheckpoint() {
  Object.assign(ctx.S, ctx.emptyState(), checkpoint ? cloneState(checkpoint.state) : {});
}
function retainHistory() {
  let cut = Math.max(0, D.events.length - HISTORY_LIMIT);
  // Never split a timestamp: the checkpoint includes every event at its floor.
  if (cut) while (cut < D.events.length && D.events[cut].t === D.events[cut - 1].t) cut++;
  if (cut) {
    const current = {...ctx.S};
    try {
      restoreCheckpoint();
      ctx.syncMetadata(false);
      for (const e of D.events.slice(0, cut)) { ctx.S.t = e.t; ctx.apply(e, false); }
      checkpoint = {t: D.events[cut - 1].t, state: cloneState({
        heroes: ctx.S.heroes, tasks: ctx.S.tasks, vault: ctx.S.vault, mana: ctx.S.mana,
        tokenNetByBot: ctx.S.tokenNetByBot, tokenNetByWallet: ctx.S.tokenNetByWallet, diagnostics: ctx.S.diagnostics})};
    } finally { Object.assign(ctx.S, current); }
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
  prune(ctx.S); if (checkpoint) prune(checkpoint.state);
  ctx.FRIENDS = null;
  eventKeys.clear(); D.events.forEach(e => eventKeys.add(eventKey(e)));
  return cut;
}
function loadReplay(replay, live = null, at = null) {
  if (!replay || !Array.isArray(replay.events) || !Array.isArray(replay.tasks) || !Array.isArray(replay.bots) ||
      replay.events.some(e => !e || !Number.isFinite(e.t)) || [...replay.tasks, ...replay.bots].some(v => !v || !v.id))
    throw new Error('Invalid replay');
  // Rebase is transactional: a failed snapshot must not destroy the old cursor/history.
  const previous = {D, checkpoint, cursor, state: {...ctx.S}, keys: [...eventKeys]};
  clearInspection();
  if (UI) UI.privacy();
  try {
    D = replay; checkpoint = null; eventKeys.clear();
    for (const field of ['tasks', 'bots']) D[field] = [...new Map(D[field].map(v => [v.id, v])).values()];
    normalizeData(); D.events.push(...archiveSnapshots(D));
    syncInspectionSessions();
    D.events.sort(eventOrder);
    D.events = D.events.filter(e => { const key = eventKey(e); const duplicate = eventKeys.has(key); eventKeys.add(key); return !duplicate; });
    const preserve = live && previous.D?.meta.show_titles === D.meta.show_titles;
    Object.assign(ctx.S, ctx.emptyState(), preserve ? cloneState({feed: previous.state.feed, lastFeed: previous.state.lastFeed, fx: previous.state.fx}) : {});
    // Rebase before compaction: fresh actions can otherwise disappear into the
    // silent checkpoint, including a batch larger than the retained window.
    if (live) ctx.reset(live.t, live.keys);
    const cut = retainHistory();
    ctx.S.i = Math.max(0, ctx.S.i - cut);
    if (live && checkpoint && ctx.S.t < checkpoint.t) ctx.reset(checkpoint.t);
    if (at !== null) ctx.reset(at, new Set()); // Clean, silent migration commits atomically.
    cursor = D.cursor ?? '';
    privacyPending = false;
  } catch (e) {
    D = previous.D; checkpoint = previous.checkpoint; cursor = previous.cursor;
    Object.assign(ctx.S, previous.state); eventKeys.clear(); previous.keys.forEach(k => eventKeys.add(k)); ctx.FRIENDS = null;
    throw e;
  }
}
function mergeDelta(delta) {
  if (!Array.isArray(delta.events) || !Array.isArray(delta.tasks) || !Array.isArray(delta.bots) || delta.cursor === undefined)
    throw new Error('Invalid event response');
  if (delta.events.some(e => !e || !Number.isFinite(e.t)) || [...delta.tasks, ...delta.bots].some(v => !v || !v.id))
    throw new Error('Invalid event data');
  if (delta.sessions !== undefined && !Array.isArray(delta.sessions)) throw new Error('Invalid session inventory');
  // An identity/config migration needs a clean authoritative snapshot, not an
  // upsert mixing old profile IDs/prose with pseudonyms. Check before mutation.
  if (privacyPending || (delta.meta?.show_titles !== undefined && delta.meta.show_titles !== D.meta.show_titles) ||
      (delta.meta?.show_profile_names !== undefined && delta.meta.show_profile_names !== D.meta.show_profile_names) ||
      (delta.meta?.config_revision !== undefined && delta.meta.config_revision !== D.meta.config_revision) ||
      (delta.meta?.captain !== undefined && delta.meta.captain !== D.meta.captain))
    throw new IdentityChanged('Replay identity changed');
  delta = {...delta, events: [...delta.events, ...archiveSnapshots(delta)]};
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
  const playhead = ctx.S.t, appliedThrough = D.events[ctx.S.i - 1]?.t ?? checkpoint?.t ?? -Infinity;
  const pending = new Set(D.events.slice(ctx.S.i).map(eventKey));
  for (const field of ['tasks', 'bots']) {
    const byId = new Map(D[field].map(v => [v.id, v]));
    for (const v of delta[field]) { const merged = {...byId.get(v.id), ...v}; byId.delete(v.id); byId.set(v.id, merged); }
    D[field] = [...byId.values()];
  }
  if (delta.sessions !== undefined) syncInspectionSessions(delta.sessions);
  normalizeData(); ctx.FRIENDS = null;
  if (delta.session_data) D.session_data = {...delta.session_data};
  if (Number.isFinite(delta.meta?.as_of)) D.meta.as_of = delta.meta.as_of;
  if (D.meta.show_titles !== true) delta.events.forEach(e => { delete e.note; delete e.title; });
  ctx.syncMetadata();
  let late = false;
  for (const e of delta.events) {
    const key = eventKey(e);
    if (eventKeys.has(key)) continue;
    eventKeys.add(key); pending.add(key); D.events.push(e); late ||= e.t <= appliedThrough;
  }
  D.events.sort(eventOrder);
  const animate = liveFeed && following && ctx.S.play;
  if (late) ctx.reset(playhead, animate ? pending : null);
  // Preserve the current scene during normal compaction. Apply due live actions
  // first so even an oversized delta gets effects once before prefix eviction.
  if (animate && D.events.length > HISTORY_LIMIT)
    while (ctx.S.i < D.events.length && D.events[ctx.S.i].t <= playhead) ctx.apply(D.events[ctx.S.i++], true);
  const applied = ctx.S.i, cut = retainHistory();
  ctx.S.i = Math.max(0, applied - cut);
  // Paused/non-following polls can evict events the scene has never applied,
  // even with the playhead beyond the new floor. Install that checkpoint and
  // silently reconstruct the due tail; normal live compaction keeps its effects.
  if (cut > applied || (checkpoint && ctx.S.t < checkpoint.t)) ctx.reset(playhead);
  D.meta.to = delta.events.reduce((to, e) => Math.max(to, e.t), Math.max(D.meta.to, Date.now() / 1000));
  cursor = delta.cursor;
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
    try { mergeDelta(delta); } catch (e) {
      if (!(e instanceof HistoryExpired)) throw e;
      if (e instanceof IdentityChanged) {
        clearInspection();
        privacyPending = true;
        D.meta.show_profile_names = false;
        redactCharacterNames();
        redactText(); checkpoint = null;
        Object.assign(ctx.S, ctx.emptyState());
        if (UI) UI.privacy();
        cx.clearRect?.(0,0,cv.width,cv.height);
      }
      const replay = await json(`${API}replay?hours=12`);
      if (replay.cursor === undefined) throw new Error('Missing replay cursor');
      // Playback/controls may advance while the snapshot is in flight. Classify
      // against the applied boundary at commit time, not at request start.
      const playhead = ctx.S.t;
      const animate = liveFeed && following && ctx.S.play;
      const appliedThrough = D.events[ctx.S.i - 1]?.t ?? checkpoint?.t ?? -Infinity;
      const applied = new Set(D.events.slice(0, ctx.S.i).map(eventKey));
      const pending = new Set(D.events.slice(ctx.S.i).map(eventKey));
      // Outside-floor overlap is historical; bounded dedup cannot classify it.
      // Inside the window, genuinely late delta actions still animate.
      for (const event of delta.events) if (!eventKeys.has(eventKey(event)) && event.t > (checkpoint?.t ?? -Infinity)) pending.add(eventKey(event));
      for (const event of replay.events || []) if (event.t >= appliedThrough && event.t > (checkpoint?.t ?? -Infinity) && !applied.has(eventKey(event))) pending.add(eventKey(event));
      // Drop old scene/feed/effects on migration; no persistent client storage
      // exists. Normal retention rebases still preserve fresh live feedback.
      if (e instanceof IdentityChanged) loadReplay(replay, null, playhead);
      else if (animate) loadReplay(replay, {t: playhead, keys: pending});
      else { loadReplay(replay); ctx.reset(playhead); }
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
  ctx.reset(Date.now() / 1000); if (UI) UI.control('#play','pause','Pause');
}
async function boot() {
  try {
  const params = new URLSearchParams(window.location?.search || '');
  liveFeed = !params.has('data') && (params.get('live') === '1' || (window.location?.pathname || '').startsWith(API));
  [D, W] = await Promise.all([json(params.get('data') || (liveFeed ? `${API}replay?hours=12` : 'data/demo.json')), json('data/world.json')]);
  loadReplay(D);
  BG = await img('assets/px/ground.png');
  for (const c of Object.keys(ctx.CLS_HUE)) SPR[c] = await img(`assets/px/${c}.png`);
  HMETA = Object.assign(HMETA, await fetch('assets/px/heroes.json').then(r => r.ok ? r.json() : {}).catch(() => ({})));
  // Only shipped combinations may trigger a request; unknown models/classes
  // keep the class (or warrior) fallback without a speculative sprite 404.
  // M1's audited metadata lists the shipped sheets as source_checks keys.
  // Explicit combos (including an empty/invalid list) still take precedence.
  const combos = new Set('combos' in HMETA ? (Array.isArray(HMETA.combos) ? HMETA.combos : []) : Object.keys(HMETA.source_checks || {}));
  for (const b of D.bots) { const st = ctx.mstyle(b.model), key = `${b.cls}-${st.tag}`; if (st !== ctx.NO_STYLE && combos.has(key) && !(key in SPRV)) SPRV[key] = await img(`assets/px/heroes/${key}.png`); }
  for (const n of ['goblin', 'golem', 'slime', 'ghost', 'bat', 'skeleton', 'dragon', 'mimic']) MIMG[n] = await img(`assets/px/monsters/${n}.png`);
  MMETA2 = await fetch('assets/px/monsters2/meta.json').then(r => r.ok ? r.json() : {}).catch(() => ({}));
  for (const k of Object.keys(MMETA2)) MON2[k] = await img(`assets/px/monsters2/${k}.png`);
  for (const p of W.props || []) if (!BLD[p.img]) BLD[p.img] = await img(`assets/px/${p.src || 'buildings'}/${p.img}.png`);
  if (window.NPCS) await NPCS.load(W, D, img);                      // M4 villagers (npcs.js)
  MONMETA = await fetch('assets/sprites/monsters.json').then(r => r.ok ? r.json() : null).catch(() => null);
  if (UI) UI.mode(D.meta.source === 'demo' ? 'DEMO' : liveFeed ? 'LIVE' : 'REPLAY');
  ui();
  if (liveFeed) {
    goLive(); pollFailures = 0; pollStale = false; lastPollOk = Date.now();
    connectedStatus(D);
    if (!document.hidden) pollTimer = setTimeout(pollEvents, 10000);
  } else { ctx.reset(D.meta.from_); connection('Replay file', 'file'); }
  if (!document.hidden) raf = requestAnimationFrame(loop);
  } catch (e) { connection('Unable to load data · reload to retry', 'offline'); }
}
function sceneName(entity) {
  const hero = !!entity.bot && !entity.id, rows = hero ? D.bots : D.tasks;
  const fallback = (hero ? 'Hero ' : 'Task ') + (rows.findIndex(r => r.id === (hero ? entity.bot : entity.id)) + 1);
  const name = D.meta.show_titles === true ? (hero ? entity.name : entity.title) : '';
  return name && !/(?:t_[a-f\d]+|[a-f\d]{8,}|[a-f\d]{8}-[a-f\d-]+)/i.test(name) ? name.slice(0,14) : fallback;
}
function selectedEntity() {
  return ctx.S.heroes[selectedScene] || (ctx.S.tasks[selectedScene]?.alpha > 0 ? ctx.S.tasks[selectedScene] : null);
}
function sceneSelection(v) {
  const entity = selectedEntity();
  if (UI?.selected) UI.selected(entity ? sceneName(entity) : null, entity?.id ? 'quests' : 'delegate');
  if (UI) UI.bounds();
  if (!entity || !UI) return;
  // Selected identification precedes regions/effects. The highlighted compact
  // representative remains visible even when no world-label lane fits.
  const x = entity.mx ?? entity.x, y = entity.my ?? entity.y;
  if (!ctx.overflowed(entity) && onScreen(v,x,y,180,180))
    UI.screenLabel(sceneName(entity),(v.ox+x*v.Z)/DPR,(v.oy+(y-110)*v.Z)/DPR,true);
}
function sceneOverflow(v) {
  if (!UI?.sceneOverflow) return;
  const entities = [...Object.values(ctx.S.heroes), ...Object.values(ctx.S.tasks).filter(t => t.alpha > 0)];
  UI.sceneOverflow(Object.entries(W.regions).flatMap(([region,r]) => {
    const items = entities.filter(o => ctx.overflowed(o) && o !== selectedEntity() && o.placement.region === region);
    if (!items.length) return [];
    const [x,y] = ctx.plazaOf(region).center;
    if (!onScreen(v,x,y,300,220)) return [];
    return [{region, label:r.label.split(' · ')[0], count:items.length,
      blocked:items.filter(o => o.chained || o.state === 'blocked').length,
      rows:() => entities.filter(o => o.placement?.region === region).map(o => ({key:o.id||o.bot, summary:sceneName(o)+' · '+(ctx.overflowed(o)?'Outside standing slots · ':'')+(o.id ? TASK_STATES[o.state]||'Unknown' : heroStatus(o)), details:()=>o.id?quest(o):heroDialog(o)}))}];
  }));
}
const nm = h => `<span class="who">${esc(h.name)}</span> (${esc(h.bot)})`;
let selectedScene = null;
const esc = s => String(s ?? '').replace(/[<>&]/g, c => ({'<': '&lt;', '>': '&gt;', '&': '&amp;'}[c]));

// ---------- render ----------
let raf = null;
function loop(ts) {
  raf = null;
  if (document.hidden) return;
  const dt = Math.min(.05, (ts - (loop.last || ts)) / 1000); loop.last = ts;
  ctx.update(dt); renderInspection(); followCharacter(dt); draw(); hud(dt);
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
  const Z = ctx.cam.zi * DPR;
  let sx = 0, sy = 0;
  if (ctx.S.trauma > 0 && !calm) { const s = ctx.S.trauma ** 2, k = performance.now() / 33; sx = Math.round(4 * s * Math.sin(k * 1.7)); sy = Math.round(3 * s * Math.sin(k * 2.3)); }
  return {Z, z: Z, ox: Math.round(cv.width / 2 - ctx.cam.x * Z) + sx * Z, oy: Math.round(cv.height / 2 - ctx.cam.y * Z) + sy * Z};
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
  if (!privacyPending) sceneOverflow(v);
  if (UI) UI.clear();
  cx.imageSmoothingEnabled = false;
  cx.fillStyle = '#0b1220'; cx.fillRect(0, 0, cv.width, cv.height);
  if (privacyPending) { if(UI)UI.flush(); return; }
  if (BG) cx.drawImage(BG, v.ox, v.oy, W.size[0] * v.Z, W.size[1] * v.Z);
  sceneSelection(v);
  for (const [k,r] of Object.entries(W.regions)) banner(v,k,r);
  inspectionLinks(v); inspect.picks = [];
  const ents = [...(W.layered ? W.props : []).map(p => ({y: p.y, f: () => prop(v, p)})),
    ...(Object.values(ctx.S.tasks).some(t => t.chained && t.alpha > 0) ? [{y: W.regions.volcano.spot[1] - 6, f: () => dragon(v)}] : []),
    ...Object.values(ctx.S.tasks).filter(t => t.alpha > 0).map(t => ({y: t.mx !== undefined ? t.my : t.y, f: () => monster(v, t)})),
    ...Object.values(ctx.S.heroes).map(h => ({y: h.y, f: () => heroDraw(v, h)})),
    ...(window.NPCS ? NPCS.ents(v, blit, shadowPx) : [])];             // M4 villagers share the y-sort
  ents.sort((a, b) => a.y - b.y).forEach(e => e.f());
  const groups = new Map();
  for (const f of ctx.S.fx) {
    if(f.k !== 'num') { fxDraw(v,f); continue; }
    // Limit visual lanes only; keep every original effect/event in simulation.
    const key=Math.round(f.x/24)+':'+Math.round(f.y/24),group=groups.get(key)||[];
    group.push(f);groups.set(key,group);
  }
  for(const group of groups.values())group.slice(0,3).forEach((f,i)=>
    fxDraw(v,{...f,y:f.y-i*18/v.Z*DPR,text:i===2&&group.length>3?'+'+compact(group.length-2):f.text}));

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
  const [centerX,centerY] = ctx.plazaOf(key).center;
  if (!onScreen(v,centerX,centerY,240,200)) return;
  const pr = W.layered && W.props.find(p => p.region === key), im = pr && BLD[pr.img];
  const [px,py] = r.plaza?.label || [r.spot[0], im ? pr.y-im.height-10 : r.spot[1]-60];
  const x = v.ox + N(px) * v.Z, y = v.oy + N(py) * v.Z;
  const n = Object.values(ctx.S.tasks).filter(t => t.region === key && t.alpha > 0 && t.state !== 'done').length;
  if(UI){UI.screenLabel(r.label.split(' · ')[0],x/DPR,y/DPR,true);
    if(n||key==='vault')UI.screenNumber(compact(key==='vault'?ctx.S.vault:n),x/DPR,y/DPR-22,'#ffd36b');}
}
function heroDraw(v, h) {
  if (ctx.overflowed(h)) return;
  const img = SPRV[`${h.cls}-${(h.st || ctx.NO_STYLE).tag}`] || SPR[h.cls] || SPR.warrior; if (!img) return;
  if (!onScreen(v,h.x,h.y,180,180)) return;
  const M = HMETA, walking = h.path.length > 1;
  let fr = 0, bob = 0;
  const WK = HMETA.walk, n = WK.length, now = performance.now() / 1000;
  if (walking) { const i = Math.floor(h.dist / (ctx.STRIDE * 2 / n)) % n; fr = WK[i]; const ph = i % (n / 2); bob = ph === 1 ? 2 : ph === n / 4 + 1 ? -1 : 0; }   // dip after contact, rise on passing
  else if (HMETA.idle.length && h.atk < 0 && !h.sleep) fr = HMETA.idle[Math.floor(now * 5 + h.homeK) % HMETA.idle.length];   // breathing loop
  else if (h.atk < 0 && !h.sleep) bob = Math.floor((now + h.homeK * .37) % 1.6 / .8);                                    // 1px idle bob
  if (h.atk >= 0) fr = ctx.atkFrame(h.atk);
  const knockX = -Math.round(ctx.ease(h.knock || 0) * 10) * (h.face || 1);
  const jump = h.cheer > 0 ? -Math.round(Math.sin((1 - h.cheer / .9) * Math.PI * 2) ** 2 * 8) : 0;
  const sink = h.meditate > 0 ? 3 : 0;
  const bx = N(h.x) + knockX + (h.atk >= 0 && h.cls !== 'commander' ? Math.round(ctx.lunge(h.atk)) * h.face : 0), by = N(h.y) + bob + jump + sink;
  const st = {...(h.st || ctx.NO_STYLE), ...accent(img)}, fighting = h.task && ctx.S.tasks[h.task] && ctx.S.tasks[h.task].state === 'fight' && !walking;
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
  if (inspect.bot === h.bot) {
    cx.save();cx.strokeStyle='rgba(255,211,107,.65)';cx.lineWidth=2*DPR;
    cx.beginPath();cx.ellipse(v.ox+bx*v.Z,v.oy+N(h.y)*v.Z,22*v.Z,7*v.Z,0,0,Math.PI*2);cx.stroke();
    cx.beginPath();cx.moveTo(v.ox+(bx-5)*v.Z,v.oy+(by-76)*v.Z);cx.lineTo(v.ox+bx*v.Z,v.oy+(by-71)*v.Z);cx.lineTo(v.ox+(bx+5)*v.Z,v.oy+(by-76)*v.Z);cx.stroke();cx.restore();
  }
  const sheet = h.hurt > 0 && !calm ? flashSheet(img,2.4,.2) : img;
  if (h.sleep && !walking) cx.globalAlpha = .9;
  if (h.down > 0 || (h.sleep && !walking)) {                     // lying down: rotate by exactly 90deg (stays on the grid)
    cx.save(); cx.translate(v.ox + bx * v.Z, v.oy + by * v.Z); cx.rotate(-Math.PI / 2);
    cx.drawImage(sheet, fr * M.fw, 0, M.fw, M.fh, -M.ax * v.Z, -M.base * v.Z, M.fw * v.Z, M.fh * v.Z); cx.restore();
    const b=spriteBox(img,fr*M.fw,0,M.fw,M.fh);
    if(b)registerCharacter(v,'hero',h.bot,{left:bx+b.top-M.base,right:bx+b.bottom-M.base,top:by+M.ax-b.right,bottom:by+M.ax-b.left});
  } else {
    const nx = h.face > 0 ? bx - M.ax : bx - (M.fw - M.ax), ny = by - M.base, lv = ctx.LEVEL[h.effort] || 0;
    levelBack(v, h, bx, by, st, lv);
    if (lv >= 1 && !(h.hurt > 0)) {                  // effort glow outline, pulsing
      const sil = silhouette(img, st.glow), pulse = .28 + Math.sin(performance.now() / 300 + h.homeK) * .12;   // soft rim light, not neon
      cx.globalAlpha = pulse * (lv >= 3 ? 1.5 : lv >= 2 ? 1.2 : 1);
      for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) blit(v, sil, fr * M.fw, 0, M.fw, M.fh, nx + ox, ny + oy, h.face < 0);
      cx.globalAlpha = (h.sleep && !walking) ? .9 : 1;
    }
    blit(v, sheet, fr * M.fw, 0, M.fw, M.fh, nx, ny, h.face < 0);
    registerSprite(v,'hero',h.bot,img,fr*M.fw,M.fw,M.fh,nx,ny,h.face<0);
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
function monsterPose(t,kind,walking) {
  // Stable phase from an opaque entity key, not the simulation RNG.
  let phase=0;for(const ch of String(t.id))phase=(Math.imul(phase,31)+ch.charCodeAt(0))>>>0;
  const now=performance.now()/1000+phase%1000/100,grounded=!['ghost','bat'].includes(kind);
  const owner=t.bot&&ctx.S.heroes[t.bot],anchor=t.mx??t.x;
  const face=walking?(t.mface||-1):owner?(owner.x>=anchor?1:-1):calm?-1:Math.floor(now/5)%2?1:-1;
  return {grounded,face,bob:calm||walking?0:grounded?(Math.sin(now*2*Math.PI/2.8)>0?1:0):Math.round(Math.sin(now*2*Math.PI/2.4)),
    recoil:calm?0:Math.min(2,Math.round(ctx.ease(t.kick||0)*2))};
}
function drawGroundedMonster(v,t,base,sheet,M,fr,bx,by,pose) {
  const box=spriteBox(base,0,0,M.fw,M.fh);if(!box)return;
  // Keep the bottom eight opaque rows AND the original shadow byte-stable.
  // Only the torso turns/breathes/recoils, including hurt and attack frames.
  const cut=Math.max(1,box.bottom-8),nx=bx-M.ax,ny=by-M.base;
  blit(v,base,0,cut,M.fw,M.fh-cut,nx,ny+cut);
  const upperX=(pose.face<0?bx-M.ax:bx-(M.fw-M.ax))+pose.recoil;
  blit(v,sheet,fr*M.fw,0,M.fw,cut,upperX,ny-pose.bob,pose.face>0);
  const upper=spriteBox(base,fr*M.fw,0,M.fw,cut);
  registerCharacter(v,'monster',t.id,{left:Math.min(nx+box.left,upperX+(upper?(pose.face>0?M.fw-upper.right:upper.left):0)),
    right:Math.max(nx+box.right,upperX+(upper?(pose.face>0?M.fw-upper.left:upper.right):M.fw)),top:ny+(upper?.top||0)-pose.bob,bottom:ny+box.bottom});
}
function monster(v, t) {
  if (ctx.overflowed(t)) return;
  if (!onScreen(v,t.mx ?? t.x,t.my ?? t.y,200,200)) return;
  if (t.region === 'camp' && t.slot >= 18) return;                          // camp yard shows the first 18 only
  const kind = ctx.mtype(t), key = `${kind}-${ctx.mtier(t)}`, im2 = MON2[key], M = MMETA2[key];
  const walking = !!(t.mpath && t.emerge <= 0);
  const bx = N(t.mx !== undefined ? t.mx : t.x), by = N(t.mx !== undefined ? t.my : t.y);
  const alpha = t.alpha * (t.emerge > 0 ? 1 - t.emerge / .9 : 1);
  if (ctx.mtier(t) === 'l' && !t.dying) {                                       // elite: smouldering red ground ring
    cx.fillStyle = `rgba(220,40,30,${.18 + (calm?0:Math.sin(performance.now() / 300) * .06)})`;
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
    else fr = 0;
    const pose = monsterPose(t,kind,walking);
    bob = pose.bob;
    const face = pose.face;

    cx.globalAlpha = Math.max(0, Math.min(1, alpha * (t.dying ? Math.min(1, t.dying * 2.5) : 1)));
    const sheet=t.flash>0&&!calm?flashSheet(im2,2.6):im2;
    if(pose.grounded&&!walking&&!t.dying) {
      drawGroundedMonster(v,t,im2,sheet,M,fr,bx,by,pose);
    } else {
      const nx=face<0?bx-M.ax:bx-(M.fw-M.ax),ny=by-M.base-bob;
      blit(v,sheet,fr*M.fw,0,M.fw,M.fh,nx,ny,face>0);
      if(alpha>0)registerSprite(v,'monster',t.id,im2,fr*M.fw,M.fw,M.fh,nx,ny,face>0);
    }
    cx.globalAlpha = 1; cx.filter = 'none';
    top = by - Math.round(M.fh * .78);
  } else {
    const fallbackKind=t.chained?'skeleton':(ctx.MON[t.stage]||'goblin'),im=MIMG[fallbackKind],pose=monsterPose(t,fallbackKind,walking);
    cx.globalAlpha=alpha*(t.dying?t.dying:1);
    if(im){
      const M={fw:im.width,fh:im.height,ax:Math.floor(im.width/2),base:im.height-1};
      if(pose.grounded&&!walking&&!t.dying)drawGroundedMonster(v,t,im,im,M,0,bx,by,pose);
      else{blit(v,im,0,0,im.width,im.height,bx-M.ax,by-M.base-pose.bob,pose.face>0);if(alpha>0)registerSprite(v,'monster',t.id,im,0,im.width,im.height,bx-M.ax,by-M.base-pose.bob,pose.face>0);}
    }
    cx.globalAlpha=1;
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
  if (f.k === 'swirl') { const n = 10, r = 26 * (1 - ctx.ease(k)); for (let i = 0; i < n; i++) { const a = i / n * 6.28 + k * 9; px(v, f.x + Math.cos(a) * r, f.y + Math.sin(a) * r * .6, 2, 2, i % 2 ? '#c8b0ff' : '#9fd3ff'); } if (k > .8) emoji('📜', v.ox + N(f.x) * v.Z, v.oy + N(f.y) * v.Z, 12 * v.Z); return; }
  if (f.k === 'balloon') { const y = f.y - ctx.ease(k) * 120, x = f.x + Math.sin(k * 8) * 6; cx.globalAlpha = Math.min(1, f.life * 2); emoji('🎈', v.ox + N(x) * v.Z, v.oy + N(y) * v.Z, 14 * v.Z); cx.globalAlpha = 1; return; }
  if (f.k === 'proj') {
    const e = f.proj === 'arrow' ? k : ctx.ease(k), x = ctx.lerp(f.x0, f.x1, e), y = ctx.lerp(f.y0, f.y1, e) - Math.sin(e * Math.PI) * f.arc;
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
  else if (f.k === 'num') { const [x, y] = P(v, f.x, f.y - 18 * ctx.ease(Math.min(1, k * 1.6))); cx.globalAlpha = Math.min(1, f.life * 2); nameplate(x, y, f.text, f.color); cx.globalAlpha = 1; }
  else if (f.k === 'coin') { const e = ctx.ease(k), [x, y] = P(v, ctx.lerp(f.x0, f.x1, e), ctx.lerp(f.y0, f.y1, e) - Math.sin(e * Math.PI) * 60); emoji('🪙', x, y, 7 * v.z); }
  else if (f.k === 'arrows') { const e = ctx.ease(k); for (let i = 0; i < 3; i++) { const [x, y] = P(v, ctx.lerp(f.x0, f.x1, e) - i * 6, ctx.lerp(f.y0, f.y1, e) + i * 2); cx.fillStyle = '#e8f0ff'; cx.fillRect(x, y, 6 * v.Z, v.Z); } }
  else if (f.k === 'portal') { const [x, y] = P(v, f.x, f.y); const r = (8 + Math.sin(k * 20) * 2) * v.z * Math.min(1, k * 4) * Math.min(1, f.life * 2); cx.strokeStyle = '#7fc8ff'; cx.lineWidth = 3 * DPR; cx.beginPath(); cx.ellipse(x, y - 14 * v.z, r * .6, r * 1.3, 0, 0, 7); cx.stroke(); }
  else if (f.k === 'raven') { const e = ctx.ease(k), [x, y] = P(v, ctx.lerp(f.x0, f.x1, e), ctx.lerp(f.y0, f.y1, e) - Math.sin(e * Math.PI) * 50); emoji(f.icon || '🐦‍⬛', x, y, 9 * v.z); }
  else if (f.k === 'council') { const [x,y]=P(v,f.h.x,f.h.y);emoji('🧙',x,y-46*v.z,16);nameplate(x,y-68*v.z,'2','#ffd36b'); }
}
function vignette() { const g = cx.createRadialGradient(cv.width / 2, cv.height / 2, cv.height * .45, cv.width / 2, cv.height / 2, cv.height * .95); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.28)'); cx.fillStyle = g; cx.fillRect(0, 0, cv.width, cv.height); }

// ---------- HUD / panels ----------
function say(html, t, key, minGap = 0) {
  if (key && minGap && ctx.S.lastFeed[key] && t - ctx.S.lastFeed[key] < minGap) return;
  if (key) {
    delete ctx.S.lastFeed[key]; ctx.S.lastFeed[key] = t;
    // Live compaction/rebase preserves feed throttles; do not accumulate keys
    // for every evicted task over the lifetime of a continuously running tab.
    const keys = Object.keys(ctx.S.lastFeed);
    if (keys.length > HISTORY_LIMIT) delete ctx.S.lastFeed[keys[0]];
  }
  ctx.S.feed.unshift({t, html}); ctx.S.feed.length = Math.min(ctx.S.feed.length, 60); ctx.S.feedDirty = true;
}
function renderFeed() {
  if(!UI||$('#chron').hidden||$('#menu').hidden||!$('#group-overview').open)return;
  UI.feed(ctx.S.feed.map(f=>{
    let detailText=fmt(f.t)+' '+UI.plain(f.html);
    let text=UI.plain(f.html).replace(/ — .*$/u,'');
    if(/^💬|^🐦‍⬛ Captain:/.test(text))text='💬 Message; open Details';
    else if(/^💀/.test(text))text='💀 Work stopped; open Details';
    else if(/^🌀/.test(text))text='🌀 Quest handoff; open Details';
    else if(/^🦊/.test(text))text='🦊 Subagent summoned; open Details';
    if(D.meta.show_titles!==true){
      for(const t of D.tasks){text=text.split(t.id).join('Task details hidden');detailText=detailText.split(t.id).join('Task details hidden');}
      for(const b of D.bots){text=text.split(b.id).join('Hero');detailText=detailText.split(b.id).join('Hero');}
    }
    return {text:fmt(f.t)+' '+text,detailText};
  }));
  ctx.S.feedDirty=false;
}
function renderCamps() {
  if(!UI)return;
  const by={};for(const t of D.tasks)(by[t.campaign]||=[]).push(t);
  const rows=Object.entries(by).map(([title,ts])=>{
    const live=ts.map(t=>ctx.S.tasks[t.id]).filter(Boolean),done=live.filter(t=>t.state==='done').length;
    return {title,count:done+'/'+ts.length+' quests',blocked:live.some(t=>t.state==='blocked')?(D.meta.show_titles===true?live.find(t=>t.state==='blocked').title:'Task details hidden · Blocked'):null,
      stages:ctx.STAGES.map(st=>{const group=live.filter(t=>t.stage===st);return {id:st.toLowerCase(),state:group.some(t=>t.state==='fight')?'selected':group.length&&group.every(t=>t.state==='done')?'normal':'disabled'};})};
  });UI.camps(rows);
}
const TASK_STATES={quest:'Waiting',fight:'Working',blocked:'Blocked',caged:'Waiting for dependencies',done:'Complete',failed:'Failed',archived:'Archived'};
function renderOverview() {
  const states=Object.values(ctx.S.tasks),blocked=states.filter(t=>t.state==='blocked'||t.chained).length;
  const working=states.filter(t=>t.state==='fight').length,waiting=states.filter(t=>['quest','caged'].includes(t.state)).length;
  const completed=states.filter(t=>t.state==='done').length;
  const permitted=D.meta.show_titles===true,failures=new Map();
  for(const e of D.events){
    if(e.t>ctx.S.t)break;
    if(!e.task)continue;
    if(e.kind==='run_start'||e.kind==='completed')failures.delete(e.task);
    else if(e.kind==='run_end'&&['timed_out','crashed','gave_up'].includes(e.outcome))failures.set(e.task,({timed_out:'Run timed out',crashed:'Worker stopped unexpectedly',gave_up:'Worker stopped work'})[e.outcome]);
  }
  const tasks=D.tasks.map(meta=>{
    const t=ctx.S.tasks[meta.id]||meta, state=TASK_STATES[t.state]||'Not started in selected range';
    return {key:meta.id,blocked:t.state==='blocked'||!!t.chained,
      summary:(permitted?meta.title||'Untitled task':'Task details hidden')+' · '+state+(t.stage?' · '+(ctx.STAGE_TH[t.stage]||'Unknown stage'):'')+(t.bot?' · Assigned to: '+(permitted?D.bots.find(b=>b.id===t.bot)?.name||'Hero':'Hero'):''),
      details:()=>{const current=D.tasks.find(row=>row.id===meta.id);if(current)quest(ctx.S.tasks[meta.id]||current);else UI.detail(['This task is no longer in retained history'],'Task details');}};
  }).sort((a,b)=>Number(b.blocked)-Number(a.blocked));
  const heroes=Object.values(ctx.S.heroes).map(h=>({key:h.bot,
    summary:(permitted?h.name:'Hero')+' · '+heroStatus(h),
    details:()=>{const current=ctx.S.heroes[h.bot];if(current)heroDialog(current);else UI.detail(['This hero is no longer in retained history'],'Hero details');}}));
  UI.overview({tasks,heroes,blocked,errors:[...Object.keys(ctx.S.diagnostics||{}),...failures.values(),...states.filter(t=>t.state==='failed').map(()=> 'A task failed')],
    empty:'No tasks in this replay range',summary:D.tasks.length?working+' working · '+waiting+' waiting · '+blocked+' blocked · '+completed+' complete'+(!working&&!blocked?' · No active work':''):'No tasks in this replay range'});
}
let hudT=0;
function hud(dt) {
  if(!UI || privacyPending)return;
  if((hudT+=dt)<.1)return;hudT=0;
  UI.number('#clock',fmt(ctx.S.t),'Replay time');UI.number('#speeds',String(ctx.S.speed),'Speed');
  UI.control('#play',ctx.S.play?'pause':'play',ctx.S.play?'Pause':'Play');
  UI.control('#live','live-follow','Follow live',following?'selected':'normal');
  $('#play').setAttribute('aria-pressed',String(!ctx.S.play));$('#live').setAttribute('aria-pressed',String(following));
  $('#scrub').value=Math.max(0,Math.min(1000,Math.round((ctx.S.t-D.meta.from_)/Math.max(1,D.meta.to-D.meta.from_)*1000)));
  $('#scrub').setAttribute('aria-valuetext',fmt(ctx.S.t));
  renderFeed();renderCamps();UI.resources(ctx.S.mana,ctx.S.tokenNetByWallet);renderOverview();
  UI.playback((ctx.S.play?'Playing':'Paused')+' · Live-follow '+(following?'on':'off')+' · '+fmt(ctx.S.t)+' · Range '+fmt(D.meta.from_)+' - '+fmt(D.meta.to));
}
function ui() {
  resize();addEventListener('resize',resize);
  document.addEventListener('visibilitychange',visibility);
  $('#speeds').onclick=()=>{following=false;const speeds=[30,120,600];ctx.S.speed=speeds[(speeds.indexOf(ctx.S.speed)+1)%speeds.length];hudT=1;hud(0);};
  $('#play').onclick=()=>{following=false;ctx.S.play=!ctx.S.play;hudT=1;hud(0);};
  $('#scrub').oninput=e=>{following=false;ctx.reset(D.meta.from_+(D.meta.to-D.meta.from_)*e.target.value/1000);};
  $('#live').hidden=!liveFeed;$('#live').onclick=goLive;
  $('#calm').onclick=()=>{calm=!calm;$('#calm').setAttribute('aria-pressed',String(calm));if(UI)UI.control('#calm','calm','Reduce effects',calm?'selected':'normal');};
  $('#world').onclick=()=>{clearInspection();Object.assign(ctx.cam,{tx:W.size[0]/2,ty:W.size[1]/2,zi:1});
    if(UI)UI.detail(Object.entries(W.regions).map(([k,r])=>UI.plain(r.label)+(k==='vault'?' : '+ctx.S.vault:'')),'World');};
  $('#tabs').onclick=e=>{const t=e.target.closest('[data-t]')?.dataset.t;if(t&&UI){UI.drawer(t);renderFeed();renderCamps();}};
  hudT=1;hud(0);
  cv.tabIndex=0;cv.setAttribute('aria-label','Hermes Quest world. Press Enter to choose a visible character.');
  $('#character-close').onclick=()=>clearInspection(true);
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'&&(inspect.bot||inspect.choices)){e.preventDefault();e.stopImmediatePropagation();clearInspection(true);}
    else if(e.key==='Enter'&&document.activeElement===cv){e.preventDefault();chooseCharacters([...inspect.picks].reverse());}
  },true);
  const pointers = new Map(); let moved = 0, pinch = null, start = null, dragging = false, pinching = false;
  const distance = () => { const [a, b] = [...pointers.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  cv.onpointerdown = e => {
    if(e.button!==0)return;
    if (!pointers.size) { moved = 0; dragging=false;pinching=false;start={x:e.clientX,y:e.clientY,time:performance.now()}; }
    pointers.set(e.pointerId, {x: e.clientX, y: e.clientY}); cv.setPointerCapture(e.pointerId);
    if (pointers.size === 2) { pinch = {distance: distance(), zoom: inspect.zoom??ctx.cam.zi}; pinching=true;moved = 10; }
  };
  cv.onpointermove = e => {
    const prev = pointers.get(e.pointerId); if (!prev) return;
    pointers.set(e.pointerId, {x: e.clientX, y: e.clientY});
    if (pinching) { if (pinch&&pointers.size>1) {ctx.cam.zi = Math.max(1, Math.min(4, pinch.zoom * distance() / Math.max(1, pinch.distance)));inspect.fittedZoom=null;} return; }
    moved=Math.max(moved,Math.hypot(e.clientX-start.x,e.clientY-start.y));
    if(moved<=8&&!dragging)return;
    const v = view(), dx = (e.clientX - (dragging?prev.x:start.x)) * DPR / v.z, dy = (e.clientY - (dragging?prev.y:start.y)) * DPR / v.z;
    dragging=true;clearInspection();ctx.cam.tx -= dx;ctx.cam.ty -= dy;ctx.cam.x -= dx;ctx.cam.y -= dy;
  };
  cv.onpointerup = e => { const was = pointers.delete(e.pointerId); pinch = null;
    if(was&&!pointers.size&&start&&Math.max(moved,Math.hypot(e.clientX-start.x,e.clientY-start.y))<=8&&performance.now()-start.time<=500)click(e); };
  cv.onpointercancel = cv.onlostpointercapture = e => { pointers.delete(e.pointerId); pinch = null; moved = 10; };
  cv.onwheel = e => { e.preventDefault(); ctx.cam.zi = Math.max(1, Math.min(4, (inspect.zoom??ctx.cam.zi) + (e.deltaY < 0 ? 1 : -1)));inspect.fittedZoom=null; };
}
function click(e) {
  if(privacyPending)return;
  const picks=inspect.picks.filter(p=>e.clientX>=p.hit.left&&e.clientX<=p.hit.right&&e.clientY>=p.hit.top&&e.clientY<=p.hit.bottom).sort((a,b)=>b.order-a.order);
  if(!picks.length){
    // An empty tap first closes an open inspection. With none open it keeps main's
    // region navigation: zoom to the nearest district and show Region details.
    if(inspect.bot||inspect.choices)return clearInspection(true);
    const v=view(), wx=(e.clientX*DPR-v.ox)/v.z, wy=(e.clientY*DPR-v.oy)/v.z;
    const r=Object.entries(W.regions).sort((a,b)=>Math.hypot(a[1].spot[0]-wx,a[1].spot[1]-wy)-Math.hypot(b[1].spot[0]-wx,b[1].spot[1]-wy))[0];
    if(!r)return;
    Object.assign(ctx.cam,{tx:r[1].spot[0],ty:r[1].spot[1]-20,zi:2});
    if(UI)UI.detail([r[1].label,'Quests: '+Object.values(ctx.S.tasks).filter(t=>t.region===r[0]).length],'Region');
    return;
  }
  if(picks.length===1){if(picks[0].type==='hero')showInspection(picks[0].id);else{clearInspection();quest(ctx.S.tasks[picks[0].id]);}return;}
  chooseCharacters(picks);
}
function chooseCharacters(picks) {
  if(!picks.length||privacyPending)return;
  if(UI){UI.close();UI.menu(false);}
  inspect.revision=D.meta.config_revision??null;inspect.choices=picks.map(({type,id})=>({type,id}));inspect.key='';
  renderInspection();$('#character-content button')?.focus();
}
function questLines(t) {
  const h=t.bot&&ctx.S.heroes[t.bot], elapsed=t.runStart?Math.round((ctx.S.t-t.runStart)/60):0;
  return [D.meta.show_titles===true?'Task ID: '+t.id:sceneName(t),D.meta.show_titles===true?t.title:'Task details hidden',
    'Assigned to: '+(h?(D.meta.show_titles===true?h.name+' ('+h.bot+')':sceneName(h)):'Not provided'),
    'Stage: '+(ctx.STAGE_TH[t.stage]||'Unknown')+' · Status: '+(TASK_STATES[t.state]||'Not started in selected range'),
    ...(t.runStart?['Run elapsed: '+elapsed+' minutes']:[]),
    ...(Number.isFinite(t.max_rt)?['Run time limit: '+Math.round(t.max_rt/60)+' minutes']:[]),
    'Campaign: '+(t.campaign||'Not provided'),'Latest note: '+(D.meta.show_titles===true?t.note||'Not provided':'Task details hidden'),
    [t.moa?'MoA':'',t.mock?'Demo':'',t.chained?'Blocked':''].join(' ')];
}
// Open task/hero dialogs follow the identity: refresh while it is retained, close (focus back to the opener) once it is evicted.
function quest(t) {
  if(privacyPending)return;
  selectedScene = t.id;
  const id=t.id;
  if(UI)UI.detail(questLines(t),'Quest',{refresh:()=>{
    const current=ctx.S.tasks[id]||D.tasks.find(row=>row.id===id);
    return current?questLines(current):null;}});
}
function heroDialog(h) {
  selectedScene = h.bot;
  const id=h.bot;
  UI.detail(heroDetails(h),'Hero',{refresh:()=>{const current=ctx.S.heroes[id];if(current)return heroDetails(current);return D.bots.some(b=>b.id===id)?undefined:null;}});
}
function heroStatus(h) {
  return ctx.restLocked(h)?(h.rest.phase==='moving'?'Walking to rest':'Resting'):h.task?'Working':h.rest.state==='active-unobserved'?'Status unobserved · Unknown':'Active';
}
function heroDetails(h) {
  const ledger = ctx.S.tokenNetByBot[h.bot],source=D.bots.find(b=>b.id===h.bot),current=h.task&&ctx.S.tasks[h.task];
  return [D.meta.show_titles===true?h.name:'Hero details hidden',D.meta.show_titles===true?'Hero ID: '+h.bot:sceneName(h),
    'Game class: '+h.cls,'Model: '+(source?.model||'Not provided'),'Effort: '+(source?.effort||'Not provided'),heroStatus(h),
    'Scene region: '+(W.regions[h.region]?.label||'Unknown'),
    'Current task: '+(current?(D.meta.show_titles===true?current.title:'Task details hidden'):'No current task in selected range'),
    'Rest reason: '+(ctx.REST_REASON[h.rest.why] || (h.rest.why?'Unknown':'None')),
    ...(h.rest.state === 'transferred' ? ['Switch signal only; quest ownership is unchanged'] : []),
    'Used tokens: '+(ledger ? Math.max(0,ledger.net).toLocaleString('en-GB') : 'Unknown (no usage events)'),
    'Signed token balance: '+(ledger?.net ?? 'Unknown'),
    ...(ledger?.hasCharsEstimate ? ['Includes estimates from text size'] : []),
    ...(ledger?.hasUsageCorrection ? ['Includes signed usage corrections'] : []),
    'Simulated capacity: 100,000 tokens per wallet per replay epoch; not real quota',
    'Historical usage may differ until reload (backend limitations)',
    ...Object.keys(ctx.S.diagnostics).filter(key=>key.startsWith('Rest ')),h.bubble?.text||'-'];
}

const bind = api => Object.defineProperties(ctx, Object.getOwnPropertyDescriptors(api));
bind({
  get $(){return $},
  get cv(){return cv},
  get cx(){return cx},
  get DPR(){return DPR},
  get UI(){return UI},
  get calm(){return calm}, set calm(v){calm=v},
  get img(){return img},
  get CLOCK_FORMAT(){return CLOCK_FORMAT},
  get fmt(){return fmt},
  get MON2(){return MON2}, set MON2(v){MON2=v},
  get MMETA2(){return MMETA2}, set MMETA2(v){MMETA2=v},
  get SPRV(){return SPRV}, set SPRV(v){SPRV=v},
  get D(){return D}, set D(v){D=v},
  get W(){return W}, set W(v){W=v},
  get BG(){return BG}, set BG(v){BG=v},
  get SPR(){return SPR}, set SPR(v){SPR=v},
  get MONS(){return MONS}, set MONS(v){MONS=v},
  get MONMETA(){return MONMETA}, set MONMETA(v){MONMETA=v},
  get BLD(){return BLD}, set BLD(v){BLD=v},
  get MIMG(){return MIMG}, set MIMG(v){MIMG=v},
  get HMETA(){return HMETA}, set HMETA(v){HMETA=v},
  get inspect(){return inspect},
  get ALPHA_BOXES(){return ALPHA_BOXES},
  get spriteBox(){return spriteBox}, set spriteBox(v){spriteBox=v},
  get registerCharacter(){return registerCharacter}, set registerCharacter(v){registerCharacter=v},
  get registerSprite(){return registerSprite}, set registerSprite(v){registerSprite=v},
  get characterName(){return characterName}, set characterName(v){characterName=v},
  get redactCharacterNames(){return redactCharacterNames}, set redactCharacterNames(v){redactCharacterNames=v},
  get validSessionRef(){return validSessionRef},
  get characterSessions(){return characterSessions}, set characterSessions(v){characterSessions=v},
  get syncInspectionSessions(){return syncInspectionSessions}, set syncInspectionSessions(v){syncInspectionSessions=v},
  get selectedSession(){return selectedSession}, set selectedSession(v){selectedSession=v},
  get parentLabel(){return parentLabel}, set parentLabel(v){parentLabel=v},
  get observedTasks(){return observedTasks}, set observedTasks(v){observedTasks=v},
  get stopInspectionFollow(){return stopInspectionFollow}, set stopInspectionFollow(v){stopInspectionFollow=v},
  get clearInspection(){return clearInspection}, set clearInspection(v){clearInspection=v},
  get cardButton(){return cardButton}, set cardButton(v){cardButton=v},
  get showInspection(){return showInspection}, set showInspection(v){showInspection=v},
  get resetInspectionLayout(){return resetInspectionLayout}, set resetInspectionLayout(v){resetInspectionLayout=v},
  get inspectionFrame(){return inspectionFrame}, set inspectionFrame(v){inspectionFrame=v},
  get layoutInspection(){return layoutInspection}, set layoutInspection(v){layoutInspection=v},
  get renderInspection(){return renderInspection}, set renderInspection(v){renderInspection=v},
  get followCharacter(){return followCharacter}, set followCharacter(v){followCharacter=v},
  get inspectionLinks(){return inspectionLinks}, set inspectionLinks(v){inspectionLinks=v},
  get API(){return API},
  get liveFeed(){return liveFeed}, set liveFeed(v){liveFeed=v},
  get following(){return following}, set following(v){following=v},
  get cursor(){return cursor}, set cursor(v){cursor=v},
  get pollTimer(){return pollTimer}, set pollTimer(v){pollTimer=v},
  get eventKeys(){return eventKeys},
  get HISTORY_LIMIT(){return HISTORY_LIMIT},
  get METADATA_LIMIT(){return METADATA_LIMIT},
  get TRANSPORT_MS(){return TRANSPORT_MS},
  get checkpoint(){return checkpoint}, set checkpoint(v){checkpoint=v},
  get pollBusy(){return pollBusy}, set pollBusy(v){pollBusy=v},
  get privacyPending(){return privacyPending}, set privacyPending(v){privacyPending=v},
  get pollFailures(){return pollFailures}, set pollFailures(v){pollFailures=v},
  get lastPollOk(){return lastPollOk}, set lastPollOk(v){lastPollOk=v},
  get pollStale(){return pollStale}, set pollStale(v){pollStale=v},
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
  get connection(){return connection}, set connection(v){connection=v},
  get connectedStatus(){return connectedStatus}, set connectedStatus(v){connectedStatus=v},
  get json(){return json}, set json(v){json=v},
  get restoreCheckpoint(){return restoreCheckpoint}, set restoreCheckpoint(v){restoreCheckpoint=v},
  get retainHistory(){return retainHistory}, set retainHistory(v){retainHistory=v},
  get loadReplay(){return loadReplay}, set loadReplay(v){loadReplay=v},
  get mergeDelta(){return mergeDelta}, set mergeDelta(v){mergeDelta=v},
  get pollFailed(){return pollFailed}, set pollFailed(v){pollFailed=v},
  get pollEvents(){return pollEvents}, set pollEvents(v){pollEvents=v},
  get goLive(){return goLive}, set goLive(v){goLive=v},
  get boot(){return boot}, set boot(v){boot=v},
  get sceneName(){return sceneName}, set sceneName(v){sceneName=v},
  get selectedEntity(){return selectedEntity}, set selectedEntity(v){selectedEntity=v},
  get sceneSelection(){return sceneSelection}, set sceneSelection(v){sceneSelection=v},
  get sceneOverflow(){return sceneOverflow}, set sceneOverflow(v){sceneOverflow=v},
  get nm(){return nm},
  get selectedScene(){return selectedScene}, set selectedScene(v){selectedScene=v},
  get esc(){return esc},
  get raf(){return raf}, set raf(v){raf=v},
  get loop(){return loop}, set loop(v){loop=v},
  get resize(){return resize}, set resize(v){resize=v},
  get visibility(){return visibility}, set visibility(v){visibility=v},
  get view(){return view}, set view(v){view=v},
  get N(){return N},
  get P(){return P},
  get blit(){return blit}, set blit(v){blit=v},
  get draw(){return draw}, set draw(v){draw=v},
  get SHADOWS(){return SHADOWS},
  get FLASH(){return FLASH},
  get onScreen(){return onScreen}, set onScreen(v){onScreen=v},
  get flashSheet(){return flashSheet}, set flashSheet(v){flashSheet=v},
  get shadowPx(){return shadowPx}, set shadowPx(v){shadowPx=v},
  get prop(){return prop}, set prop(v){prop=v},
  get banner(){return banner}, set banner(v){banner=v},
  get heroDraw(){return heroDraw}, set heroDraw(v){heroDraw=v},
  get ACC(){return ACC},
  get accent(){return accent}, set accent(v){accent=v},
  get SIL(){return SIL},
  get silhouette(){return silhouette}, set silhouette(v){silhouette=v},
  get WINGS(){return WINGS},
  get HALOS(){return HALOS},
  get levelBack(){return levelBack}, set levelBack(v){levelBack=v},
  get levelFront(){return levelFront}, set levelFront(v){levelFront=v},
  get blitMon(){return blitMon}, set blitMon(v){blitMon=v},
  get monsterPose(){return monsterPose}, set monsterPose(v){monsterPose=v},
  get drawGroundedMonster(){return drawGroundedMonster}, set drawGroundedMonster(v){drawGroundedMonster=v},
  get monster(){return monster}, set monster(v){monster=v},
  get dragon(){return dragon}, set dragon(v){dragon=v},
  get nameplate(){return nameplate}, set nameplate(v){nameplate=v},
  get bubble(){return bubble}, set bubble(v){bubble=v},
  get effectIcon(){return effectIcon}, set effectIcon(v){effectIcon=v},
  get emoji(){return emoji}, set emoji(v){emoji=v},
  get compact(){return compact}, set compact(v){compact=v},
  get px(){return px}, set px(v){px=v},
  get fxDraw(){return fxDraw}, set fxDraw(v){fxDraw=v},
  get vignette(){return vignette}, set vignette(v){vignette=v},
  get say(){return say}, set say(v){say=v},
  get renderFeed(){return renderFeed}, set renderFeed(v){renderFeed=v},
  get renderCamps(){return renderCamps}, set renderCamps(v){renderCamps=v},
  get TASK_STATES(){return TASK_STATES},
  get renderOverview(){return renderOverview}, set renderOverview(v){renderOverview=v},
  get hudT(){return hudT}, set hudT(v){hudT=v},
  get hud(){return hud}, set hud(v){hud=v},
  get ui(){return ui}, set ui(v){ui=v},
  get click(){return click}, set click(v){click=v},
  get chooseCharacters(){return chooseCharacters}, set chooseCharacters(v){chooseCharacters=v},
  get questLines(){return questLines}, set questLines(v){questLines=v},
  get quest(){return quest}, set quest(v){quest=v},
  get heroDialog(){return heroDialog}, set heroDialog(v){heroDialog=v},
  get heroStatus(){return heroStatus}, set heroStatus(v){heroStatus=v},
  get heroDetails(){return heroDetails}, set heroDetails(v){heroDetails=v}
});
ctx.services = {};
ctx.services.geometry = window.HQModules.createGeometry(ctx);
bind(ctx.services.geometry);
ctx.services.appearance = window.HQModules.createAppearance(ctx);
bind(ctx.services.appearance);
ctx.services.state = window.HQModules.createState(ctx);
bind(ctx.services.state);
ctx.services.actions = window.HQModules.createActions(ctx);
bind(ctx.services.actions);
ctx.services.combat = window.HQModules.createCombat(ctx);
bind(ctx.services.combat);
ctx.services.social = window.HQModules.createSocial(ctx);
bind(ctx.services.social);
ctx.services.simulation = window.HQModules.createSimulation(ctx);
bind(ctx.services.simulation);
ctx.state = ctx.S; ctx.camera = ctx.cam;
// Keep live payloads off DOM/storage. These references are for isolated tests;
// the browser only publishes them when its harness explicitly opts in.
const facade = {
  $, ACTIONS: ctx.ACTIONS, DPR, S: ctx.S, STRIDE: ctx.STRIDE, UI, WALK_V: ctx.WALK_V, cam: ctx.cam, cv, cx, eventKeys, inspect,
  captainId, cloneState,
  get D(){return D}, set D(v){D=v},
  get W(){return W}, set W(v){W=v},
  get FRIENDS(){return ctx.FRIENDS}, set FRIENDS(v){ctx.FRIENDS=v},
  get HMETA(){return HMETA}, set HMETA(v){HMETA=v},
  get MMETA2(){return MMETA2}, set MMETA2(v){MMETA2=v},
  get MON2(){return MON2}, set MON2(v){MON2=v},
  get SPR(){return SPR}, set SPR(v){SPR=v},
  get SPRV(){return SPRV}, set SPRV(v){SPRV=v},
  get calm(){return calm}, set calm(v){calm=v},
  get checkpoint(){return checkpoint}, set checkpoint(v){checkpoint=v},
  get cursor(){return cursor}, set cursor(v){cursor=v},
  get following(){return following}, set following(v){following=v},
  get hudT(){return hudT}, set hudT(v){hudT=v},
  get lastPollOk(){return lastPollOk}, set lastPollOk(v){lastPollOk=v},
  get liveFeed(){return liveFeed}, set liveFeed(v){liveFeed=v},
  get pollBusy(){return pollBusy}, set pollBusy(v){pollBusy=v},
  get pollFailures(){return pollFailures}, set pollFailures(v){pollFailures=v},
  get pollStale(){return pollStale}, set pollStale(v){pollStale=v},
  get pollTimer(){return pollTimer}, set pollTimer(v){pollTimer=v},
  get privacyPending(){return privacyPending}, set privacyPending(v){privacyPending=v},
  get raf(){return raf}, set raf(v){raf=v},
  get selectedScene(){return selectedScene}, set selectedScene(v){selectedScene=v},
  get apply(){return ctx.apply}, set apply(v){ctx.apply=v},
  get connection(){return connection}, set connection(v){connection=v},
  get reset(){return ctx.reset}, set reset(v){ctx.reset=v},
  get ui(){return ui}, set ui(v){ui=v},
  boot, characterName, chooseCharacters, clearInspection, click, connectedStatus,
  draw, engage: ctx.engage, eventKey, finishRestMotion: ctx.finishRestMotion, followCharacter, formation: ctx.formation, friends: ctx.friends,
  goHome: ctx.goHome, goLive, hero: ctx.hero, heroDialog, heroStatus, hud, inspectionLinks, json, later: ctx.later,
  laterHero: ctx.laterHero, loadReplay, loop, mergeDelta, monster, monsterPose, mstyle: ctx.mstyle, mtier: ctx.mtier, mtype: ctx.mtype,
  normalizeData, order: ctx.order, overflowed: ctx.overflowed, parentLabel, plazaOf: ctx.plazaOf, pollEvents, pollFailed,
  portal: ctx.portal, px, quest, regionOf: ctx.regionOf, renderFeed, renderInspection, resize, restLocked: ctx.restLocked,
  say, selectedSession, showInspection, spawnMonster: ctx.spawnMonster, spotOf: ctx.spotOf, startHangout: ctx.startHangout,
  stepHero: ctx.stepHero, strike: ctx.strike, task: ctx.task, update: ctx.update, view, wake: ctx.wake, walkTo: ctx.walkTo
};
if (autoBoot) {
  if(UI){UI.init();UI.status('Loading activity…','loading');}
  boot();
}
return facade;}
(globalThis.HQModules ||= {}).createGame = createGame;
if (globalThis.__questAutoBoot !== false) {
  const game = createGame();
  if (window.__questTestGlobals === true) {
    window.__questTest = game;
    for (const name of Object.keys(game)) Object.defineProperty(window, name, {
      configurable: true, get: () => game[name], set: value => {game[name] = value;}
    });
  }
}
