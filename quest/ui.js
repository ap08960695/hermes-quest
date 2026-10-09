'use strict';
// Owns ui; peer bindings stay live on the per-game context. Registration never boots.
(globalThis.HQModules ||= {}).createGameUI = function createGameUI(ctx) {
const CLOCK_FORMAT = new Intl.DateTimeFormat('en-GB', {hour: '2-digit', minute: '2-digit'});
const fmt = t => { const d = new Date(t * 1000); return Number.isNaN(d.getTime()) ? 'Invalid Date' : CLOCK_FORMAT.format(d); };

// Page-local presentation only. Never part of a replay checkpoint or live cursor.
const inspect = {bot: null, session: null, follow: false, picks: [], choices: null, key: '', revision: null, fit: false, zoom: null, fittedZoom: null};
function characterName(id) {
  const b = ctx.D.bots.find(b => b.id === id);
  return ctx.D.meta.show_profile_names === true && b ? b.display_name || b.profile_name || b.pet_name || 'Hero' :
    'Hero '+Math.max(1,ctx.D.bots.findIndex(b => b.id === id)+1);
}
const validSessionRef = ref => typeof ref === 'string' && /^[a-f0-9]{20}$/.test(ref);
function characterSessions(id) {
  return (ctx.D.sessions || []).filter(s => s.bot === id && validSessionRef(s.session_ref) &&
    (!Number.isFinite(s.started_at) || s.started_at <= ctx.S.t));
}
function selectedSession() {
  const rows = characterSessions(inspect.bot);
  return inspect.session ? rows.find(s => s.session_ref === inspect.session) || null : rows.length === 1 ? rows[0] : null;
}
function parentLabel(s) {
  if (!s) return 'Parent unknown';
  if (!s.parent_session_ref) return s.is_subagent === false ? 'Not a sub-agent' : 'Parent unknown';
  const parent = (ctx.D.sessions || []).find(p => validSessionRef(p.session_ref) && p.session_ref === s.parent_session_ref);
  return parent ? 'Parent: '+(ctx.S.heroes[parent.bot]?characterName(parent.bot):'Character unavailable') : 'Parent unknown';
}
function observedTasks(id) {
  return ctx.D.tasks.filter(t => ctx.S.tasks[t.id] ? ctx.S.tasks[t.id].bot === id : ctx.S.t >= ctx.D.meta.generated && t.bot === id).map(t => {
    const current = ctx.S.tasks[t.id];
    const status = current ? TASK_STATES[current.state] || 'Status unobserved' :
      ctx.S.t >= ctx.D.meta.generated ? ({running:'Working',done:'Complete',blocked:'Blocked',todo:'Waiting',ready:'Ready',review:'In review'})[t.status] || 'Status unobserved' : 'Status unobserved';
    return (ctx.D.meta.show_titles === true ? t.title || 'Untitled task' : 'Task details hidden')+' · '+status;
  });
}
function stopInspectionFollow() {
  if (inspect.zoom !== null && ctx.cam.zi === inspect.fittedZoom) ctx.cam.zi=inspect.zoom;
  inspect.follow=inspect.fit=false;inspect.zoom=inspect.fittedZoom=null;
}
function clearInspection(restore = false) {
  const card = ctx.$('#character-card'), owns = card?.contains?.(document.activeElement);
  stopInspectionFollow();
  inspect.bot = inspect.session = inspect.choices = null; inspect.key = '';
  if (card) { card.hidden = true; ctx.$('#character-heading').textContent = 'Character'; ctx.$('#character-content').replaceChildren?.(); }
  resetInspectionLayout();
  if (restore || owns) ctx.cv.focus?.();
}
function cardButton(parent, label, fn) {
  const b = document.createElement('button'); b.className = 'text-button'; b.style.width = '100%';
  b.textContent = label; b.onclick = fn; parent.append(b); return b;
}
function showInspection(id) {
  if (ctx.privacyPending || !ctx.S.heroes[id]) return;
  if (ctx.UI) ctx.UI.close();
  if (ctx.UI) ctx.UI.menu(false);
  inspect.revision = ctx.D.meta.config_revision ?? null;
  // Every successful hero inspection entry (canvas tap, chooser, overflow list, child link)
  // shares one selected identity, so the marker and the card name the same character.
  selectedScene = id;
  inspect.bot = id; inspect.session = null; inspect.choices = null; inspect.follow = true; inspect.key = '';
  renderInspection(); followCharacter(1); ctx.$('#character-close').focus();
}
function resetInspectionLayout() {
  const bar=ctx.$('#focus-bar'), card=ctx.$('#character-card');
  if (bar?.style) { bar.style.width=''; bar.classList.remove?.('inspection-side'); }
  if (card?.style) { card.style.left='8px'; card.style.width=innerWidth<=760?'calc(100vw - 16px)':'280px'; }
}
function inspectionFrame(bodyWidth, bodyHeight) {
  const bar=ctx.$('#focus-bar').getBoundingClientRect();
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
  const card=ctx.$('#character-card'), bar=ctx.$('#focus-bar');
  const frame=inspectionFrame(bodyWidth,bodyHeight);
  // While the card is open the overflow badges collapse to one 44 px control stacked above it.
  const dock=ctx.UI?.placeOverflow&&ctx.$('#scene-overflow')&&!ctx.$('#scene-overflow').hidden?52:0;
  const room=innerHeight-frame.top-bodyHeight-24-dock;
  // If a bottom sheet cannot fit, reserve a side column for BOTH warning and
  // card. Keep the complete sprite at the chosen scale whenever it can fit.
  const sideWidth=Math.min(280,innerWidth-bodyWidth-36);
  if (room<62 && sideWidth>=96 && bodyHeight<=innerHeight-20) {
    card.style.width=bar.style.width=sideWidth+'px';bar.classList.add('inspection-side');
    card.style.maxHeight=Math.max(62,Math.min(innerWidth<=760?160:240,innerHeight-bar.getBoundingClientRect().bottom-16-dock))+'px';
    ctx.UI?.placeOverflow?.();
    return {left:sideWidth+24,right:innerWidth-10,top:10,bottom:innerHeight-10};
  }
  card.style.maxHeight=Math.max(62,Math.min(innerWidth<=760?160:240,innerHeight*.28,room))+'px';
  ctx.UI?.placeOverflow?.();
  const dockEl=ctx.$('#scene-overflow'),top=dockEl&&!dockEl.hidden?dockEl.getBoundingClientRect().top:card.getBoundingClientRect().top;
  return {...frame,bottom:Math.min(top,card.getBoundingClientRect().top)-10};
}
function renderInspection() {
  const card = ctx.$('#character-card'); if (!card) return;
  if (ctx.privacyPending || inspect.revision !== (ctx.D.meta.config_revision ?? null)) {
    clearInspection(); inspect.revision = ctx.D.meta.config_revision ?? null;
  }
  if (!inspect.bot && !inspect.choices) return;
  // Modal/Menu surfaces own focus and space while open. Never overlap them.
  if (!ctx.$('#quest').hidden || !ctx.$('#menu').hidden) { clearInspection(); return; }
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
  const h = ctx.S.heroes[inspect.bot], s = selectedSession(), rows = characterSessions(inspect.bot), b = ctx.D.bots.find(b => b.id === inspect.bot);
  if (inspect.bot && !h) stopInspectionFollow();
  const lines = inspect.choices ? [] : !h ? ['Character unavailable','Follow off'] : [
    ctx.D.meta.show_profile_names === true ? 'Profile: '+(b?.profile_name || 'Unknown')+' · Pet: '+(b?.pet_name || 'Unknown') : 'Profile and pet names hidden',
    rows.length > 1 && !s ? 'Choose a session to inspect its parent' : parentLabel(s),
    ...(observedTasks(inspect.bot).length ? observedTasks(inspect.bot) : ['No observed task']),
    'Follow '+(inspect.follow ? 'on' : 'off'),...(inspect.fit?['Zoom adjusted to fit this screen.']:[])];
  const heading = inspect.choices ? 'Choose character' : characterName(inspect.bot);
  const children=s?(ctx.D.sessions||[]).filter(row=>row.parent_session_ref===s.session_ref&&validSessionRef(row.session_ref)):[];
  const key = JSON.stringify([heading,lines,rows.map(s=>[s.session_ref,parentLabel(s)]),inspect.session,inspect.choices,children.map(c=>[c.session_ref,characterName(c.bot)])]);
  if (key === inspect.key) return; inspect.key = key;
  const content = ctx.$('#character-content'), active = document.activeElement, owns = content.contains(active);
  ctx.$('#character-heading').textContent = heading; content.replaceChildren();
  for (const line of lines) { const p=document.createElement('div');p.textContent=line;p.style.overflowWrap='anywhere';content.append(p); }
  if (inspect.choices) for (const pick of inspect.choices) cardButton(content,pick.type === 'hero' ? characterName(pick.id) : 'Monster · '+(ctx.STAGE_TH[ctx.S.tasks[pick.id]?.stage] || 'Unknown stage'),()=>{
    if (pick.type === 'hero') showInspection(pick.id); else {clearInspection();if(ctx.S.tasks[pick.id])quest(ctx.S.tasks[pick.id]);}
  });
  else if (h && rows.length > 1) rows.forEach((row,i)=>cardButton(content,'Session '+(i+1)+' · '+parentLabel(row),()=>{
    inspect.session=row.session_ref;inspect.key='';renderInspection();ctx.$('#character-close').focus();
  }));
  if(!inspect.choices&&children.length){const p=document.createElement('div');p.textContent=children.length+' child sessions'+(children.length>3?' · +'+(children.length-3)+' beyond three links':'');content.append(p);
    children.forEach((child,i)=>cardButton(content,'Child '+(i+1)+' · '+characterName(child.bot),()=>{
      if(ctx.S.heroes[child.bot]){showInspection(child.bot);inspect.session=child.session_ref;inspect.key='';renderInspection();}
      else {selectedScene=child.bot;inspect.bot=child.bot;inspect.session=child.session_ref;inspect.follow=false;inspect.key='';renderInspection();}
    }));}
  if (owns) ctx.$('#character-close').focus();
  layoutInspection(width*ctx.cam.zi,height*ctx.cam.zi);
}
function followCharacter(dt) {
  if (!inspect.follow || !inspect.bot) return;
  const h = ctx.S.heroes[inspect.bot]; if (!h || ctx.privacyPending) {stopInspectionFollow();return;}
  const pick = inspect.picks.find(p=>p.type==='hero'&&p.id===inspect.bot);
  const box = pick?.world ? {...pick.world} : {left:h.x-24,right:h.x+24,top:h.y-70,bottom:h.y};
  if(pick?.anchor){const dx=h.x-pick.anchor[0],dy=h.y-pick.anchor[1];box.left+=dx;box.right+=dx;box.top+=dy;box.bottom+=dy;}
  const {top,left,right,bottom}=layoutInspection((box.right-box.left)*ctx.cam.zi,(box.bottom-box.top)*ctx.cam.zi);
  const targetX = (left+right)/2, targetY = (top+bottom)/2;
  ctx.cam.tx=(box.left+box.right)/2-(targetX-innerWidth/2)/ctx.cam.zi;
  ctx.cam.ty=(box.top+box.bottom)/2-(targetY-innerHeight/2)/ctx.cam.zi;
  const k=ctx.calm?1:1-Math.exp(-dt/.18);ctx.cam.x=ctx.lerp(ctx.cam.x,ctx.cam.tx,k);ctx.cam.y=ctx.lerp(ctx.cam.y,ctx.cam.ty,k);
  // Allow background padding near world edges rather than moving the character.
  const rect = {left:innerWidth/2+(box.left-ctx.cam.x)*ctx.cam.zi,right:innerWidth/2+(box.right-ctx.cam.x)*ctx.cam.zi,
    top:innerHeight/2+(box.top-ctx.cam.y)*ctx.cam.zi,bottom:innerHeight/2+(box.bottom-ctx.cam.y)*ctx.cam.zi};
  if (rect.left<left)ctx.cam.x-=(left-rect.left)/ctx.cam.zi;else if(rect.right>right)ctx.cam.x+=(rect.right-right)/ctx.cam.zi;
  if (rect.top<top)ctx.cam.y-=(top-rect.top)/ctx.cam.zi;else if(rect.bottom>bottom)ctx.cam.y+=(rect.bottom-bottom)/ctx.cam.zi;
  ctx.cam.tx=ctx.cam.x;ctx.cam.ty=ctx.cam.y;
}
function sceneName(entity) {
  const hero = !!entity.bot && !entity.id, rows = hero ? ctx.D.bots : ctx.D.tasks;
  const fallback = (hero ? 'Hero ' : 'Task ') + (rows.findIndex(r => r.id === (hero ? entity.bot : entity.id)) + 1);
  const name = ctx.D.meta.show_titles === true ? (hero ? entity.name : entity.title) : '';
  return name && !/(?:t_[a-f\d]+|[a-f\d]{8,}|[a-f\d]{8}-[a-f\d-]+)/i.test(name) ? name.slice(0,14) : fallback;
}
function selectedEntity() {
  return ctx.S.heroes[selectedScene] || (ctx.S.tasks[selectedScene]?.alpha > 0 ? ctx.S.tasks[selectedScene] : null);
}
const nm = h => `<span class="who">${esc(h.name)}</span> (${esc(h.bot)})`;
let selectedScene = null;
const esc = s => String(s ?? '').replace(/[<>&]/g, c => ({'<': '&lt;', '>': '&gt;', '&': '&amp;'}[c]));

// ---------- HUD / panels ----------
function say(html, t, key, minGap = 0) {
  if (key && minGap && ctx.S.lastFeed[key] && t - ctx.S.lastFeed[key] < minGap) return;
  if (key) {
    delete ctx.S.lastFeed[key]; ctx.S.lastFeed[key] = t;
    // Live compaction/rebase preserves feed throttles; do not accumulate keys
    // for every evicted task over the lifetime of a continuously running tab.
    const keys = Object.keys(ctx.S.lastFeed);
    if (keys.length > ctx.HISTORY_LIMIT) delete ctx.S.lastFeed[keys[0]];
  }
  ctx.S.feed.unshift({t, html}); ctx.S.feed.length = Math.min(ctx.S.feed.length, 60); ctx.S.feedDirty = true;
}
function renderFeed() {
  if(!ctx.UI||ctx.$('#chron').hidden||ctx.$('#menu').hidden||!ctx.$('#group-overview').open)return;
  ctx.UI.feed(ctx.S.feed.map(f=>{
    let detailText=fmt(f.t)+' '+ctx.UI.plain(f.html);
    let text=ctx.UI.plain(f.html).replace(/ — .*$/u,'');
    if(/^💬|^🐦‍⬛ Captain:/.test(text))text='💬 Message; open Details';
    else if(/^💀/.test(text))text='💀 Work stopped; open Details';
    else if(/^🌀/.test(text))text='🌀 Quest handoff; open Details';
    else if(/^🦊/.test(text))text='🦊 Subagent summoned; open Details';
    if(ctx.D.meta.show_titles!==true){
      for(const t of ctx.D.tasks){text=text.split(t.id).join('Task details hidden');detailText=detailText.split(t.id).join('Task details hidden');}
      for(const b of ctx.D.bots){text=text.split(b.id).join('Hero');detailText=detailText.split(b.id).join('Hero');}
    }
    return {text:fmt(f.t)+' '+text,detailText};
  }));
  ctx.S.feedDirty=false;
}
function renderCamps() {
  if(!ctx.UI)return;
  const by={};for(const t of ctx.D.tasks)(by[t.campaign]||=[]).push(t);
  const rows=Object.entries(by).map(([title,ts])=>{
    const live=ts.map(t=>ctx.S.tasks[t.id]).filter(Boolean),done=live.filter(t=>t.state==='done').length;
    return {title,count:done+'/'+ts.length+' quests',blocked:live.some(t=>t.state==='blocked')?(ctx.D.meta.show_titles===true?live.find(t=>t.state==='blocked').title:'Task details hidden · Blocked'):null,
      stages:ctx.STAGES.map(st=>{const group=live.filter(t=>t.stage===st);return {id:st.toLowerCase(),state:group.some(t=>t.state==='fight')?'selected':group.length&&group.every(t=>t.state==='done')?'normal':'disabled'};})};
  });ctx.UI.camps(rows);
}
const TASK_STATES={quest:'Waiting',fight:'Working',blocked:'Blocked',caged:'Waiting for dependencies',done:'Complete',failed:'Failed',archived:'Archived'};
function renderOverview() {
  const states=Object.values(ctx.S.tasks),blocked=states.filter(t=>t.state==='blocked'||t.chained).length;
  const working=states.filter(t=>t.state==='fight').length,waiting=states.filter(t=>['quest','caged'].includes(t.state)).length;
  const completed=states.filter(t=>t.state==='done').length;
  const permitted=ctx.D.meta.show_titles===true,failures=new Map();
  for(const e of ctx.D.events){
    if(e.t>ctx.S.t)break;
    if(!e.task)continue;
    if(e.kind==='run_start'||e.kind==='completed')failures.delete(e.task);
    else if(e.kind==='run_end'&&['timed_out','crashed','gave_up'].includes(e.outcome))failures.set(e.task,({timed_out:'Run timed out',crashed:'Worker stopped unexpectedly',gave_up:'Worker stopped work'})[e.outcome]);
  }
  const tasks=ctx.D.tasks.map(meta=>{
    const t=ctx.S.tasks[meta.id]||meta, state=TASK_STATES[t.state]||'Not started in selected range';
    return {key:meta.id,blocked:t.state==='blocked'||!!t.chained,
      summary:(permitted?meta.title||'Untitled task':'Task details hidden')+' · '+state+(t.stage?' · '+(ctx.STAGE_TH[t.stage]||'Unknown stage'):'')+(t.bot?' · Assigned to: '+(permitted?ctx.D.bots.find(b=>b.id===t.bot)?.name||'Hero':'Hero'):''),
      details:()=>{const current=ctx.D.tasks.find(row=>row.id===meta.id);if(current)quest(ctx.S.tasks[meta.id]||current);else ctx.UI.detail(['This task is no longer in retained history'],'Task details');}};
  }).sort((a,b)=>Number(b.blocked)-Number(a.blocked));
  const heroes=Object.values(ctx.S.heroes).map(h=>({key:h.bot,
    summary:(permitted?h.name:'Hero')+' · '+heroStatus(h),
    details:()=>{const current=ctx.S.heroes[h.bot];if(current)heroDialog(current);else ctx.UI.detail(['This hero is no longer in retained history'],'Hero details');}}));
  ctx.UI.overview({tasks,heroes,blocked,errors:[...Object.keys(ctx.S.diagnostics||{}),...failures.values(),...states.filter(t=>t.state==='failed').map(()=> 'A task failed')],
    empty:'No tasks in this replay range',summary:ctx.D.tasks.length?working+' working · '+waiting+' waiting · '+blocked+' blocked · '+completed+' complete'+(!working&&!blocked?' · No active work':''):'No tasks in this replay range'});
}
let hudT=0;
function hud(dt) {
  if(!ctx.UI || ctx.privacyPending)return;
  if((hudT+=dt)<.1)return;hudT=0;
  ctx.UI.number('#clock',fmt(ctx.S.t),'Replay time');ctx.UI.number('#speeds',String(ctx.S.speed),'Speed');
  ctx.UI.control('#play',ctx.S.play?'pause':'play',ctx.S.play?'Pause':'Play');
  ctx.UI.control('#live','live-follow','Follow live',ctx.following?'selected':'normal');
  ctx.$('#play').setAttribute('aria-pressed',String(!ctx.S.play));ctx.$('#live').setAttribute('aria-pressed',String(ctx.following));
  ctx.$('#scrub').value=Math.max(0,Math.min(1000,Math.round((ctx.S.t-ctx.D.meta.from_)/Math.max(1,ctx.D.meta.to-ctx.D.meta.from_)*1000)));
  ctx.$('#scrub').setAttribute('aria-valuetext',fmt(ctx.S.t));
  renderFeed();renderCamps();ctx.UI.resources(ctx.S.mana,ctx.S.tokenNetByWallet);renderOverview();
  ctx.UI.playback((ctx.S.play?'Playing':'Paused')+' · Live-follow '+(ctx.following?'on':'off')+' · '+fmt(ctx.S.t)+' · Range '+fmt(ctx.D.meta.from_)+' - '+fmt(ctx.D.meta.to));
}
function ui() {
  ctx.resize();addEventListener('resize',ctx.resize);
  document.addEventListener('visibilitychange',ctx.visibility);
  ctx.$('#speeds').onclick=()=>{ctx.following=false;const speeds=[30,120,600];ctx.S.speed=speeds[(speeds.indexOf(ctx.S.speed)+1)%speeds.length];hudT=1;hud(0);};
  ctx.$('#play').onclick=()=>{ctx.following=false;ctx.S.play=!ctx.S.play;hudT=1;hud(0);};
  ctx.$('#scrub').oninput=e=>{ctx.following=false;ctx.reset(ctx.D.meta.from_+(ctx.D.meta.to-ctx.D.meta.from_)*e.target.value/1000);};
  ctx.$('#live').hidden=!ctx.liveFeed;ctx.$('#live').onclick=ctx.goLive;
  ctx.$('#calm').onclick=()=>{ctx.calm=!ctx.calm;ctx.$('#calm').setAttribute('aria-pressed',String(ctx.calm));if(ctx.UI)ctx.UI.control('#calm','calm','Reduce effects',ctx.calm?'selected':'normal');};
  ctx.$('#world').onclick=()=>{clearInspection();Object.assign(ctx.cam,{tx:ctx.W.size[0]/2,ty:ctx.W.size[1]/2,zi:1});
    if(ctx.UI)ctx.UI.detail(Object.entries(ctx.W.regions).map(([k,r])=>ctx.UI.plain(r.label)+(k==='vault'?' : '+ctx.S.vault:'')),'World');};
  ctx.$('#tabs').onclick=e=>{const t=e.target.closest('[data-t]')?.dataset.t;if(t&&ctx.UI){ctx.UI.drawer(t);renderFeed();renderCamps();}};
  hudT=1;hud(0);
  ctx.cv.tabIndex=0;ctx.cv.setAttribute('aria-label','Hermes Quest world. Press Enter to choose a visible character.');
  ctx.$('#character-close').onclick=()=>clearInspection(true);
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'&&(inspect.bot||inspect.choices)){e.preventDefault();e.stopImmediatePropagation();clearInspection(true);}
    else if(e.key==='Enter'&&document.activeElement===ctx.cv){e.preventDefault();chooseCharacters([...inspect.picks].reverse());}
  },true);
  const pointers = new Map(); let moved = 0, pinch = null, start = null, dragging = false, pinching = false;
  const distance = () => { const [a, b] = [...pointers.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  ctx.cv.onpointerdown = e => {
    if(e.button!==0)return;
    if (!pointers.size) { moved = 0; dragging=false;pinching=false;start={x:e.clientX,y:e.clientY,time:performance.now()}; }
    pointers.set(e.pointerId, {x: e.clientX, y: e.clientY}); ctx.cv.setPointerCapture(e.pointerId);
    if (pointers.size === 2) { pinch = {distance: distance(), zoom: inspect.zoom??ctx.cam.zi}; pinching=true;moved = 10; }
  };
  ctx.cv.onpointermove = e => {
    const prev = pointers.get(e.pointerId); if (!prev) return;
    pointers.set(e.pointerId, {x: e.clientX, y: e.clientY});
    if (pinching) { if (pinch&&pointers.size>1) {ctx.cam.zi = Math.max(1, Math.min(4, pinch.zoom * distance() / Math.max(1, pinch.distance)));inspect.fittedZoom=null;} return; }
    moved=Math.max(moved,Math.hypot(e.clientX-start.x,e.clientY-start.y));
    if(moved<=8&&!dragging)return;
    const v = ctx.view(), dx = (e.clientX - (dragging?prev.x:start.x)) * ctx.DPR / v.z, dy = (e.clientY - (dragging?prev.y:start.y)) * ctx.DPR / v.z;
    dragging=true;clearInspection();ctx.cam.tx -= dx;ctx.cam.ty -= dy;ctx.cam.x -= dx;ctx.cam.y -= dy;
  };
  ctx.cv.onpointerup = e => { const was = pointers.delete(e.pointerId); pinch = null;
    if(was&&!pointers.size&&start&&Math.max(moved,Math.hypot(e.clientX-start.x,e.clientY-start.y))<=8&&performance.now()-start.time<=500)click(e); };
  ctx.cv.onpointercancel = ctx.cv.onlostpointercapture = e => { pointers.delete(e.pointerId); pinch = null; moved = 10; };
  ctx.cv.onwheel = e => { e.preventDefault(); ctx.cam.zi = Math.max(1, Math.min(4, (inspect.zoom??ctx.cam.zi) + (e.deltaY < 0 ? 1 : -1)));inspect.fittedZoom=null; };
}
function click(e) {
  if(ctx.privacyPending)return;
  const picks=inspect.picks.filter(p=>e.clientX>=p.hit.left&&e.clientX<=p.hit.right&&e.clientY>=p.hit.top&&e.clientY<=p.hit.bottom).sort((a,b)=>b.order-a.order);
  if(!picks.length){
    // An empty tap first closes an open inspection. With none open it keeps main's
    // region navigation: zoom to the nearest district and show Region details.
    if(inspect.bot||inspect.choices)return clearInspection(true);
    const v=ctx.view(), wx=(e.clientX*ctx.DPR-v.ox)/v.z, wy=(e.clientY*ctx.DPR-v.oy)/v.z;
    const r=Object.entries(ctx.W.regions).sort((a,b)=>Math.hypot(a[1].spot[0]-wx,a[1].spot[1]-wy)-Math.hypot(b[1].spot[0]-wx,b[1].spot[1]-wy))[0];
    if(!r)return;
    Object.assign(ctx.cam,{tx:r[1].spot[0],ty:r[1].spot[1]-20,zi:2});
    if(ctx.UI)ctx.UI.detail([r[1].label,'Quests: '+Object.values(ctx.S.tasks).filter(t=>t.region===r[0]).length],'Region');
    return;
  }
  if(picks.length===1){if(picks[0].type==='hero')showInspection(picks[0].id);else{clearInspection();quest(ctx.S.tasks[picks[0].id]);}return;}
  chooseCharacters(picks);
}
function chooseCharacters(picks) {
  if(!picks.length||ctx.privacyPending)return;
  if(ctx.UI){ctx.UI.close();ctx.UI.menu(false);}
  inspect.revision=ctx.D.meta.config_revision??null;inspect.choices=picks.map(({type,id})=>({type,id}));inspect.key='';
  renderInspection();ctx.$('#character-content button')?.focus();
}
function questLines(t) {
  const h=t.bot&&ctx.S.heroes[t.bot], elapsed=t.runStart?Math.round((ctx.S.t-t.runStart)/60):0;
  return [ctx.D.meta.show_titles===true?'Task ID: '+t.id:sceneName(t),ctx.D.meta.show_titles===true?t.title:'Task details hidden',
    'Assigned to: '+(h?(ctx.D.meta.show_titles===true?h.name+' ('+h.bot+')':sceneName(h)):'Not provided'),
    'Stage: '+(ctx.STAGE_TH[t.stage]||'Unknown')+' · Status: '+(TASK_STATES[t.state]||'Not started in selected range'),
    ...(t.runStart?['Run elapsed: '+elapsed+' minutes']:[]),
    ...(Number.isFinite(t.max_rt)?['Run time limit: '+Math.round(t.max_rt/60)+' minutes']:[]),
    'Campaign: '+(t.campaign||'Not provided'),'Latest note: '+(ctx.D.meta.show_titles===true?t.note||'Not provided':'Task details hidden'),
    [t.moa?'MoA':'',t.mock?'Demo':'',t.chained?'Blocked':''].join(' ')];
}
// Open task/hero dialogs follow the identity: refresh while it is retained, close (focus back to the opener) once it is evicted.
function quest(t) {
  if(ctx.privacyPending)return;
  selectedScene = t.id;
  const id=t.id;
  if(ctx.UI)ctx.UI.detail(questLines(t),'Quest',{refresh:()=>{
    const current=ctx.S.tasks[id]||ctx.D.tasks.find(row=>row.id===id);
    return current?questLines(current):null;}});
}
function heroDialog(h) {
  selectedScene = h.bot;
  const id=h.bot;
  ctx.UI.detail(heroDetails(h),'Hero',{refresh:()=>{const current=ctx.S.heroes[id];if(current)return heroDetails(current);return ctx.D.bots.some(b=>b.id===id)?undefined:null;}});
}
function heroStatus(h) {
  return ctx.restLocked(h)?(h.rest.phase==='moving'?'Walking to rest':'Resting'):h.task?'Working':h.rest.state==='active-unobserved'?'Status unobserved · Unknown':'Active';
}
function heroDetails(h) {
  const ledger = ctx.S.tokenNetByBot[h.bot],source=ctx.D.bots.find(b=>b.id===h.bot),current=h.task&&ctx.S.tasks[h.task];
  return [ctx.D.meta.show_titles===true?h.name:'Hero details hidden',ctx.D.meta.show_titles===true?'Hero ID: '+h.bot:sceneName(h),
    'Game class: '+h.cls,'Model: '+(source?.model||'Not provided'),'Effort: '+(source?.effort||'Not provided'),heroStatus(h),
    'Scene region: '+(ctx.W.regions[h.region]?.label||'Unknown'),
    'Current task: '+(current?(ctx.D.meta.show_titles===true?current.title:'Task details hidden'):'No current task in selected range'),
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
return {
  get CLOCK_FORMAT(){return CLOCK_FORMAT},
  get fmt(){return fmt},
  get inspect(){return inspect},
  get characterName(){return characterName}, set characterName(v){characterName=v},
  get validSessionRef(){return validSessionRef},
  get characterSessions(){return characterSessions}, set characterSessions(v){characterSessions=v},
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
  get sceneName(){return sceneName}, set sceneName(v){sceneName=v},
  get selectedEntity(){return selectedEntity}, set selectedEntity(v){selectedEntity=v},
  get nm(){return nm},
  get selectedScene(){return selectedScene}, set selectedScene(v){selectedScene=v},
  get esc(){return esc},
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
};
};
