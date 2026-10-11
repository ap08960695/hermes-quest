'use strict';
// Owns render; peer bindings stay live on the per-game context. Registration never boots.
(globalThis.HQModules ||= {}).createRenderer = function createRenderer(ctx) {
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
  const r = ctx.cv.getBoundingClientRect(), scale = r.width / ctx.cv.width;
  const body = {left:r.left+(v.ox+box.left*v.Z)*scale, top:r.top+(v.oy+box.top*v.Z)*scale,
    right:r.left+(v.ox+box.right*v.Z)*scale, bottom:r.top+(v.oy+box.bottom*v.Z)*scale};
  if (body.right < r.left || body.left > r.right || body.bottom < r.top || body.top > r.bottom) return;
  const dx = Math.max(0, (44 - (body.right-body.left))/2), dy = Math.max(0, (44 - (body.bottom-body.top))/2);
  const h=ctx.workView?.pairs.find(p=>p.item.ref===id)?.hero || ctx.S.heroes[id];
  ctx.inspect.picks.push({type,id,world:box,body,anchor:type==='hero'&&h?[h.x,h.y]:null,order:ctx.inspect.picks.length,
    hit:{left:body.left-dx,right:body.right+dx,top:body.top-dy,bottom:body.bottom+dy}});
}
function registerSprite(v, type, id, im, sx, w, h, nx, ny, flip) {
  const b = spriteBox(im, sx, 0, w, h); if (!b) return;
  registerCharacter(v,type,id,{left:nx+(flip?w-b.right:b.left),right:nx+(flip?w-b.left:b.right),top:ny+b.top,bottom:ny+b.bottom});
}
function inspectionLinks(v) {
  const s = ctx.selectedSession(); if (!s || !ctx.inspect.bot) return;
  const selected=ctx.inspect.picks.find(p=>p.type==='hero'&&p.id===ctx.inspect.bot);if(!selected)return;
  const refs = (ctx.D.sessions || []).filter(p=>ctx.validSessionRef(p.session_ref) &&
    (p.session_ref===s.parent_session_ref || p.parent_session_ref===s.session_ref));
  const ids=[...new Set(refs.map(p=>p.bot))].filter(id=>id!==ctx.inspect.bot);
  const visible=ids.map(id=>ctx.inspect.picks.find(p=>p.type==='hero'&&p.id===id)).filter(Boolean);
  const card=ctx.$('#character-card').getBoundingClientRect(),side=ctx.$('#focus-bar').classList.contains('inspection-side');
  const point=p=>P(v,(p.world.left+p.world.right)/2,p.world.bottom);
  ctx.cx.save();ctx.cx.beginPath();
  if(side)ctx.cx.rect((card.right+8)*ctx.DPR,0,Math.max(0,innerWidth-card.right-8)*ctx.DPR,ctx.cv.height);
  else ctx.cx.rect(0,0,ctx.cv.width,Math.max(0,card.top-8)*ctx.DPR);
  ctx.cx.clip();
  ctx.cx.strokeStyle='rgba(232,223,198,.25)';ctx.cx.lineWidth=ctx.DPR;
  for(const p of visible.slice(0,3)){const a=point(selected),b=point(p);ctx.cx.beginPath();ctx.cx.moveTo(...a);ctx.cx.lineTo(...b);ctx.cx.stroke();}
  ctx.cx.restore();
  if(visible.length>3 && ctx.UI){const a=point(selected);ctx.UI.screenNumber('+'+(visible.length-3),a[0]/ctx.DPR,a[1]/ctx.DPR-90);}
}
function sceneSelection(v) {
  const entity = ctx.selectedEntity();
  if (ctx.UI?.selected) ctx.UI.selected(entity ? ctx.sceneName(entity) : null, entity?.id ? 'quests' : 'delegate');
  if (ctx.UI) ctx.UI.bounds();
  if (!entity || !ctx.UI) return;
  // Selected identification precedes regions/effects. The highlighted compact
  // representative remains visible even when no world-label lane fits.
  const x = entity.mx ?? entity.x, y = entity.my ?? entity.y;
  if (!ctx.overflowed(entity) && onScreen(v,x,y,180,180))
    ctx.UI.screenLabel(ctx.sceneName(entity),(v.ox+x*v.Z)/ctx.DPR,(v.oy+(y-110)*v.Z)/ctx.DPR,true);
}
function sceneOverflow(v) {
  if (!ctx.UI?.sceneOverflow) return;
  const entities = [...Object.values(ctx.S.heroes), ...Object.values(ctx.S.tasks).filter(t => t.alpha > 0)];
  ctx.UI.sceneOverflow(Object.entries(ctx.W.regions).flatMap(([region,r]) => {
    const items = entities.filter(o => ctx.overflowed(o) && o !== ctx.selectedEntity() && o.placement.region === region);
    if (!items.length) return [];
    const [x,y] = ctx.plazaOf(region).center;
    if (!onScreen(v,x,y,300,220)) return [];
    return [{region, label:r.label.split(' · ')[0], count:items.length,
      blocked:items.filter(o => o.chained || o.state === 'blocked').length,
      rows:() => entities.filter(o => o.placement?.region === region).map(o => ({key:o.id||o.bot, summary:ctx.sceneName(o)+' · '+(ctx.overflowed(o)?'Outside standing slots · ':'')+(o.id ? ctx.TASK_STATES[o.state]||'Unknown' : ctx.heroStatus(o)), details:()=>o.id?ctx.quest(o):ctx.heroDialog(o)}))}];
  }));
}
function resize() { ctx.cv.width = innerWidth * ctx.DPR; ctx.cv.height = innerHeight * ctx.DPR; if (ctx.UI) ctx.UI.resize(); }
// Pixel grid: logic runs in design units (1536x1024); the world is drawn on a native 768x512 pixel grid,
// one design unit = half a native pixel. Every sprite/tile is drawn at its native size times an INTEGER
// screen scale Z with smoothing off, and every position is snapped to the native grid -> crisp pixels.
function view() {
  const Z = ctx.cam.zi * ctx.DPR;
  let sx = 0, sy = 0;
  if (ctx.S.trauma > 0 && !ctx.calm) { const s = ctx.S.trauma ** 2, k = performance.now() / 33; sx = Math.round(4 * s * Math.sin(k * 1.7)); sy = Math.round(3 * s * Math.sin(k * 2.3)); }
  return {Z, z: Z, ox: Math.round(ctx.cv.width / 2 - ctx.cam.x * Z) + sx * Z, oy: Math.round(ctx.cv.height / 2 - ctx.cam.y * Z) + sy * Z};
}
const N = u => Math.round(u);                                       // design units == native px (1536x1024 grid)
const P = (v, x, y) => [v.ox + N(x) * v.Z, v.oy + N(y) * v.Z];
function blit(v, im, sx, sy, sw, sh, nx, ny, flip = false) {       // nx,ny: native top-left
  const Z = v.Z;
  if (!flip) return ctx.cx.drawImage(im, sx, sy, sw, sh, v.ox + nx * Z, v.oy + ny * Z, sw * Z, sh * Z);
  ctx.cx.save(); ctx.cx.translate(v.ox + (nx + sw) * Z, v.oy + ny * Z); ctx.cx.scale(-1, 1); ctx.cx.drawImage(im, sx, sy, sw, sh, 0, 0, sw * Z, sh * Z); ctx.cx.restore();
}
function draw() {
  if(ctx.workingSnapshot?.()&&!ctx.workView.all)return drawWorking();
  const v = view();
  if (!ctx.privacyPending) sceneOverflow(v);
  if (ctx.UI) ctx.UI.clear();
  ctx.cx.imageSmoothingEnabled = false;
  ctx.cx.fillStyle = '#0b1220'; ctx.cx.fillRect(0, 0, ctx.cv.width, ctx.cv.height);
  if (ctx.privacyPending) { if(ctx.UI)ctx.UI.flush(); return; }
  if (ctx.BG) ctx.cx.drawImage(ctx.BG, v.ox, v.oy, ctx.W.size[0] * v.Z, ctx.W.size[1] * v.Z);
  sceneSelection(v);
  for (const [k,r] of Object.entries(ctx.W.regions)) banner(v,k,r);
  inspectionLinks(v); ctx.inspect.picks = [];
  const ents = [...(ctx.W.layered ? ctx.W.props : []).map(p => ({y: p.y, f: () => prop(v, p)})),
    ...(Object.values(ctx.S.tasks).some(t => t.chained && t.alpha > 0) ? [{y: ctx.W.regions.volcano.spot[1] - 6, f: () => dragon(v)}] : []),
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
    fxDraw(v,{...f,y:f.y-i*18/v.Z*ctx.DPR,text:i===2&&group.length>3?'+'+compact(group.length-2):f.text}));

  if(ctx.UI)ctx.UI.flush();
  vignette();
}
const SHADOWS = new Map(), FLASH = new Map();
function drawWorking() {
  ctx.renderWorking();ctx.fitWorking();const v=view();
  ctx.UI?.sceneOverflow([]);ctx.UI?.selected(null);ctx.UI?.clear();ctx.inspect.picks=[];
  ctx.cx.imageSmoothingEnabled=false;ctx.cx.fillStyle='#0b1220';ctx.cx.fillRect(0,0,ctx.cv.width,ctx.cv.height);
  if(ctx.privacyPending){ctx.UI?.flush();return;}
  if(ctx.BG)ctx.cx.drawImage(ctx.BG,v.ox,v.oy,ctx.W.size[0]*v.Z,ctx.W.size[1]*v.Z);
  for(const p of ctx.W.layered?ctx.W.props:[])prop(v,p);
  for(const pair of ctx.workView.pairs){
    if(pair.hero)heroDraw(v,pair.hero);
    else {const [x,y]=P(v,pair.x-60,pair.y-20);ctx.cx.strokeStyle='#ffd36b';ctx.cx.strokeRect(x-12*v.Z,y-24*v.Z,24*v.Z,24*v.Z);}
    monster(v,pair.monster);
    const labelWidth=Math.max(48,110*v.Z/ctx.DPR),labelY=(v.oy+(pair.y-110)*v.Z)/ctx.DPR;
    if(pair.hero)ctx.UI?.screenLabel(pair.item.display_name,(v.ox+pair.hero.x*v.Z)/ctx.DPR,labelY,false,labelWidth);
    const compactLabel=pair.item.quest_label.replace(/^(Planning|Testing|Verification) quest/,(_,kind)=>({Planning:'Plan',Testing:'Test',Verification:'Verify'})[kind]).replace(/ quest(?= #)/,'');
    const number=compactLabel.match(/#\d+$/)?.[0];
    // Keep the stable quest number even when the scene lane is too narrow for its name.
    const sceneLabel=number&&UIText.measure(compactLabel,2)>labelWidth?number:compactLabel;
    ctx.UI?.screenLabel(sceneLabel,(v.ox+pair.monster.x*v.Z)/ctx.DPR,labelY,false,labelWidth);
    const a=pair.monster.activity;
    if(a?.hit>0){
      const x=v.ox+pair.monster.x*v.Z,y=v.oy+(pair.y-50-(1.1-a.hit)*22)*v.Z;
      ctx.UI?.screenLabel('1 DMG',x/ctx.DPR,y/ctx.DPR);
      if(a.hitCombo>1)ctx.UI?.screenLabel('COMBO X'+a.hitCombo,x/ctx.DPR,y/ctx.DPR-22);
      if(a.flash>0)fxDraw(v,{k:'slash',x:pair.monster.x-6,y:pair.y-22,dir:1,color:'#fff',glow:'#ffd36b',life:a.flash,max:.18,big:1});
    }
  }
  // Ambient villagers are reserved for the no-work scene; no hidden idle heroes.
  const cap=innerWidth<=760?8:innerWidth<=1100?14:20;
  const villagers=!ctx.workView.pairs.length&&window.NPCS?NPCS.ents(v,blit,shadowPx).slice(0,cap-1):[];
  villagers.forEach(e=>e.f());
  let couriers=0;
  for(const f of ctx.S.fx)if(f.working || (!ctx.workView.pairs.length && f.src==='inn')){
    if(f.k==='raven' && couriers++)continue;
    fxDraw(v,f);
  }
  for(const f of ctx.S.fx){
    const pair=f.task_ref&&ctx.workView.pairs.find(p=>p.item.task_ref===f.task_ref),t=pair&&ctx.S.tasks[f.task_ref];
    if(!t)continue;
    const mapped={...f},dx=pair.monster.x-t.x,dy=pair.monster.y-t.y;
    for(const key of ['x','x0','x1'])if(Number.isFinite(mapped[key]))mapped[key]+=dx;
    for(const key of ['y','y0','y1'])if(Number.isFinite(mapped[key]))mapped[key]+=dy;
    if(f.bot_ref&&pair.hero){mapped.x0=pair.hero.x+22;mapped.y0=pair.hero.y-34;}
    fxDraw(v,mapped);
  }
  ctx.workView.foreground={heroes:ctx.workView.pairs.filter(p=>p.hero).length,encounters:ctx.workView.pairs.length,npcs:villagers.length,couriers:Math.min(1,couriers)};
  ctx.UI?.flush();vignette();
}
function onScreen(v,x,y,w,h) {
  const sx=v.ox+x*v.Z, sy=v.oy+y*v.Z;
  return sx+w*v.Z>=0 && sx-w*v.Z<=ctx.cv.width && sy+32*v.Z>=0 && sy-h*v.Z<=ctx.cv.height;
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
  const im = ctx.BLD[p.img]; if (!im) return;
  const bx = N(p.x), by = N(p.y);
  if (!onScreen(v,bx,by,im.width+64,im.height+64)) return;
  shadowPx(v, bx, by, Math.round(im.width * .42));
  if (p.img === 'campfire' || p.img === 'lamp') { const r = (p.img === 'lamp' ? 20 : 32) * v.Z * (1 + Math.sin(performance.now() / 180 + p.x) * .06); const lx = v.ox + bx * v.Z, ly = v.oy + (by - im.height * .8) * v.Z; const g = ctx.cx.createRadialGradient(lx, ly, 0, lx, ly, r); g.addColorStop(0, 'rgba(255,190,90,.35)'); g.addColorStop(1, 'rgba(255,190,90,0)'); ctx.cx.fillStyle = g; ctx.cx.fillRect(lx - r, ly - r, r * 2, r * 2); }
  blit(v, im, 0, 0, im.width, im.height, bx - Math.floor(im.width / 2), by - im.height + 1);
}
function banner(v, key, r) {
  const [centerX,centerY] = ctx.plazaOf(key).center;
  if (!onScreen(v,centerX,centerY,240,200)) return;
  const pr = ctx.W.layered && ctx.W.props.find(p => p.region === key), im = pr && ctx.BLD[pr.img];
  const [px,py] = r.plaza?.label || [r.spot[0], im ? pr.y-im.height-10 : r.spot[1]-60];
  const x = v.ox + N(px) * v.Z, y = v.oy + N(py) * v.Z;
  const n = Object.values(ctx.S.tasks).filter(t => t.region === key && t.alpha > 0 && t.state !== 'done').length;
  if(ctx.UI){ctx.UI.screenLabel(r.label.split(' · ')[0],x/ctx.DPR,y/ctx.DPR,true);
    if(n||key==='vault')ctx.UI.screenNumber(compact(key==='vault'?ctx.S.vault:n),x/ctx.DPR,y/ctx.DPR-22,'#ffd36b');}
}
function heroDraw(v, h) {
  if (ctx.overflowed(h)) return;
  const img = ctx.SPRV[`${h.cls}-${(h.st || ctx.NO_STYLE).tag}`] || ctx.SPR[h.cls] || ctx.SPR.warrior; if (!img) return;
  if (!onScreen(v,h.x,h.y,180,180)) return;
  const M = ctx.HMETA, walking = h.path.length > 1;
  let fr = 0, bob = 0;
  const WK = ctx.HMETA.walk, n = WK.length, now = performance.now() / 1000;
  if (walking) { const i = Math.floor(h.dist / (ctx.STRIDE * 2 / n)) % n; fr = WK[i]; const ph = i % (n / 2); bob = ph === 1 ? 2 : ph === n / 4 + 1 ? -1 : 0; }   // dip after contact, rise on passing
  else if (ctx.HMETA.idle.length && h.atk < 0 && !h.sleep) fr = ctx.HMETA.idle[Math.floor(now * 5 + h.homeK) % ctx.HMETA.idle.length];   // breathing loop
  else if (h.atk < 0 && !h.sleep) bob = Math.floor((now + h.homeK * .37) % 1.6 / .8);                                    // 1px idle bob
  if (h.atk >= 0) fr = ctx.atkFrame(h.atk);
  if(h.preparing&&ctx.S.play&&!ctx.calm){fr=ctx.atkFrame(.19*(.5+.5*Math.sin(ctx.S.rt*2.5+h.homeK)));bob=-Math.round(Math.sin(ctx.S.rt*2.5+h.homeK)*2);}
  const knockX = -Math.round(ctx.ease(h.knock || 0) * 10) * (h.face || 1);
  const jump = h.cheer > 0 ? -Math.round(Math.sin((1 - h.cheer / .9) * Math.PI * 2) ** 2 * 8) : 0;
  const sink = h.meditate > 0 ? 3 : 0;
  const bx = N(h.x) + knockX + (h.atk >= 0 && h.cls !== 'commander' ? Math.round(ctx.lunge(h.atk)) * h.face : 0), by = N(h.y) + bob + jump + sink;
  const st = {...(h.st || ctx.NO_STYLE), ...accent(img)}, fighting = h.task && ctx.S.tasks[h.task] && ctx.S.tasks[h.task].state === 'fight' && !walking;
  if (fighting || h.charge > 0) {                                            // model aura under the feet
    ctx.cx.globalAlpha = .28 + Math.sin(performance.now() / 260 + h.homeK) * .08; ctx.cx.fillStyle = st.color;
    for (let i = -2; i <= 2; i++) { const half = Math.round((17 + (h.eff ? h.eff.mult * 3 : 3)) * Math.sqrt(1 - (i / 2.6) ** 2)); ctx.cx.fillRect(v.ox + (bx - half) * v.Z, v.oy + (N(h.y) + 1 + i) * v.Z, half * 2 * v.Z, v.Z); }
    ctx.cx.globalAlpha = 1;

  }
  if (h.charge > 0) {                                                          // effort wind-up: a ring closing in on the hero
    const c = 1 - h.charge / Math.max(.01, h.eff.charge), r = 30 - c * 18, n = 14;
    for (let i = 0; i < n; i++) { const a = i / n * 6.28 + c * 4; px(v, h.x + Math.cos(a) * r, h.y - 30 + Math.sin(a) * r * .8, 2, 2, i % 3 ? st.color : st.glow); }
  }
  shadowPx(v, bx, N(h.y) + 1, 15);
  if (ctx.inspect.bot === h.bot) {
    ctx.cx.save();ctx.cx.strokeStyle='rgba(255,211,107,.65)';ctx.cx.lineWidth=2*ctx.DPR;
    ctx.cx.beginPath();ctx.cx.ellipse(v.ox+bx*v.Z,v.oy+N(h.y)*v.Z,22*v.Z,7*v.Z,0,0,Math.PI*2);ctx.cx.stroke();
    ctx.cx.beginPath();ctx.cx.moveTo(v.ox+(bx-5)*v.Z,v.oy+(by-76)*v.Z);ctx.cx.lineTo(v.ox+bx*v.Z,v.oy+(by-71)*v.Z);ctx.cx.lineTo(v.ox+(bx+5)*v.Z,v.oy+(by-76)*v.Z);ctx.cx.stroke();ctx.cx.restore();
  }
  const sheet = h.hurt > 0 && !ctx.calm ? flashSheet(img,2.4,.2) : img;
  if (h.sleep && !walking) ctx.cx.globalAlpha = .9;
  if (h.down > 0 || (h.sleep && !walking)) {                     // lying down: rotate by exactly 90deg (stays on the grid)
    ctx.cx.save(); ctx.cx.translate(v.ox + bx * v.Z, v.oy + by * v.Z); ctx.cx.rotate(-Math.PI / 2);
    ctx.cx.drawImage(sheet, fr * M.fw, 0, M.fw, M.fh, -M.ax * v.Z, -M.base * v.Z, M.fw * v.Z, M.fh * v.Z); ctx.cx.restore();
    const b=spriteBox(img,fr*M.fw,0,M.fw,M.fh);
    if(b)registerCharacter(v,'hero',h.bot,{left:bx+b.top-M.base,right:bx+b.bottom-M.base,top:by+M.ax-b.right,bottom:by+M.ax-b.left});
  } else {
    const nx = h.face > 0 ? bx - M.ax : bx - (M.fw - M.ax), ny = by - M.base, lv = ctx.LEVEL[h.effort] || 0;
    levelBack(v, h, bx, by, st, lv);
    if (lv >= 1 && !(h.hurt > 0)) {                  // effort glow outline, pulsing
      const sil = silhouette(img, st.glow), pulse = .28 + Math.sin(performance.now() / 300 + h.homeK) * .12;   // soft rim light, not neon
      ctx.cx.globalAlpha = pulse * (lv >= 3 ? 1.5 : lv >= 2 ? 1.2 : 1);
      for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) blit(v, sil, fr * M.fw, 0, M.fw, M.fh, nx + ox, ny + oy, h.face < 0);
      ctx.cx.globalAlpha = (h.sleep && !walking) ? .9 : 1;
    }
    blit(v, sheet, fr * M.fw, 0, M.fw, M.fh, nx, ny, h.face < 0);
    registerSprite(v,'hero',h.bot,img,fr*M.fw,M.fw,M.fh,nx,ny,h.face<0);
    levelFront(v, h, bx, by, st, lv);
  }
  ctx.cx.filter = 'none'; ctx.cx.globalAlpha = 1;
  const hx = v.ox + bx * v.Z, top = v.oy + (by - 66) * v.Z;
  for (const f of h.fam) blitMon(v, 'bat', N(h.x + Math.cos(f.a) * 34), N(h.y - 46 + Math.sin(f.a) * 10), .7);
  if (h.gest && !walking) emoji(h.gest.icon.split(' ')[0], hx + 14 * v.Z, top + 6 * v.Z - Math.sin(performance.now() / 200) * 2 * v.Z, 12 * v.Z);
  if (h.sleep && !walking) emoji('💤', hx + 12 * v.Z, top + 28 * v.Z - Math.sin(performance.now() / 400) * 4 * v.Z, 14 * v.Z);

  if (h.bubble && !ctx.workingSnapshot?.()) bubble(hx, top - 16 * ctx.DPR, h.bubble.text);

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
  const im = ctx.MIMG[kind]; if (!im) return null;
  ctx.cx.globalAlpha = alpha; blit(v, im, 0, 0, im.width, im.height, bx - Math.floor(im.width / 2), by - im.height + 1); ctx.cx.globalAlpha = 1;
  return im;
}
function monsterPose(t,kind,walking) {
  // Stable phase from an opaque entity key, not the simulation RNG.
  let phase=0;for(const ch of String(t.id))phase=(Math.imul(phase,31)+ch.charCodeAt(0))>>>0;
  const now=performance.now()/1000+phase%1000/100,grounded=!['ghost','bat'].includes(kind);
  const owner=t.bot&&ctx.S.heroes[t.bot],anchor=t.mx??t.x;
  const face=walking?(t.mface||-1):owner?(owner.x>=anchor?1:-1):ctx.calm?-1:Math.floor(now/5)%2?1:-1;
  return {grounded,face,bob:ctx.calm||walking?0:grounded?(Math.sin(now*2*Math.PI/2.8)>0?1:0):Math.round(Math.sin(now*2*Math.PI/2.4)),
    recoil:ctx.calm?0:Math.min(2,Math.round(ctx.ease(t.kick||0)*2))};
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
  const kind = ctx.mtype(t), key = `${kind}-${ctx.mtier(t)}`, im2 = ctx.MON2[key], M = ctx.MMETA2[key];
  const walking = !!(t.mpath && t.emerge <= 0);
  const bx = N(t.mx !== undefined ? t.mx : t.x), by = N(t.mx !== undefined ? t.my : t.y);
  const alpha = t.alpha * (t.emerge > 0 ? 1 - t.emerge / .9 : 1);
  if (ctx.mtier(t) === 'l' && !t.dying) {                                       // elite: smouldering red ground ring
    ctx.cx.fillStyle = `rgba(220,40,30,${.18 + (ctx.calm?0:Math.sin(performance.now() / 300) * .06)})`;
    const r = Math.round((M ? M.fw * .3 : 24));
    for (let i = -3; i <= 3; i++) { const half = Math.round(r * Math.sqrt(1 - (i / 3.5) ** 2)); ctx.cx.fillRect(v.ox + (bx - half) * v.Z, v.oy + (by + i) * v.Z, half * 2 * v.Z, v.Z); }
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

    ctx.cx.globalAlpha = Math.max(0, Math.min(1, alpha * (t.dying ? Math.min(1, t.dying * 2.5) : 1)));
    const sheet=t.flash>0&&!ctx.calm?flashSheet(im2,2.6):im2;
    if(pose.grounded&&!walking&&!t.dying) {
      drawGroundedMonster(v,t,im2,sheet,M,fr,bx,by,pose);
    } else {
      const nx=face<0?bx-M.ax:bx-(M.fw-M.ax),ny=by-M.base-bob;
      blit(v,sheet,fr*M.fw,0,M.fw,M.fh,nx,ny,face>0);
      if(alpha>0)registerSprite(v,'monster',t.id,im2,fr*M.fw,M.fw,M.fh,nx,ny,face>0);
    }
    ctx.cx.globalAlpha = 1; ctx.cx.filter = 'none';
    top = by - Math.round(M.fh * .78);
  } else {
    const fallbackKind=t.chained?'skeleton':(ctx.MON[t.stage]||'goblin'),im=ctx.MIMG[fallbackKind],pose=monsterPose(t,fallbackKind,walking);
    ctx.cx.globalAlpha=alpha*(t.dying?t.dying:1);
    if(im){
      const M={fw:im.width,fh:im.height,ax:Math.floor(im.width/2),base:im.height-1};
      if(pose.grounded&&!walking&&!t.dying)drawGroundedMonster(v,t,im,im,M,0,bx,by,pose);
      else{blit(v,im,0,0,im.width,im.height,bx-M.ax,by-M.base-pose.bob,pose.face>0);if(alpha>0)registerSprite(v,'monster',t.id,im,0,im.width,im.height,bx-M.ax,by-M.base-pose.bob,pose.face>0);}
    }
    ctx.cx.globalAlpha=1;
    ctx.cx.filter = 'none'; top = by - (im ? im.height : 40) - 6;
  }

  if (t.state === 'caged' && !walking) emoji('⛓', v.ox + (bx + 14) * v.Z, v.oy + (top + 10) * v.Z, 10 * v.Z);

  if (Number.isFinite(t.hp) && t.alpha > .5 && !t.dying && t.region !== 'camp') {                  // Legacy time bar; Working never fabricates HP.
    const w = 36, x0 = bx - w / 2;
    ctx.cx.fillStyle = '#141824'; ctx.cx.fillRect(v.ox + (x0 - 2) * v.Z, v.oy + (top - 2) * v.Z, (w + 4) * v.Z, 6 * v.Z);
    ctx.cx.fillStyle = t.chained ? '#e0503c' : t.hp > .4 ? '#e8c04a' : '#e0503c'; ctx.cx.fillRect(v.ox + x0 * v.Z, v.oy + top * v.Z, Math.max(1, Math.round(w * t.hp)) * v.Z, 2 * v.Z);

  }
}
function dragon(v) {
  const [x, y] = ctx.W.regions.volcano.spot, b = Math.floor(performance.now() / 700) % 2;
  blitMon(v, 'dragon', N(x) + 52, N(y) - 12 - b * 2);
}
function nameplate(x, y, text, color) {
  if(!ctx.UI)return;
  const digits=String(text).replace(/−/g,'-').match(/[+-]?\d+/)?.[0];
  if(digits){const n=Number(digits),label=(n<0?'-':digits.startsWith('+')?'+':'')+compact(Math.abs(n));
    ctx.UI.screenNumber(label,x/ctx.DPR,y/ctx.DPR,color);
    if(/CRIT|COMBO/.test(text))ctx.UI.screenIcon(effectIcon(text),x/ctx.DPR,y/ctx.DPR-40);}
  else ctx.UI.screenIcon(effectIcon(text),x/ctx.DPR,y/ctx.DPR);
}
function bubble(x, y, text) {
  if(ctx.UI)ctx.UI.screenIcon('message',x/ctx.DPR,y/ctx.DPR);
}
function effectIcon(text) {
  const icons={'📜':'read','📖':'read','🔍':'search','👁':'vision','✒':'write','🗝':'memory','🕊':'message','🐦‍⬛':'message','🐣':'delegate','🦊':'delegate','🧙':'delegate','⚒':'commit','🎈':'push','⚔':'merge','🪙':'coin','💤':'sleep','⛓':'chain','🔮':'search'};
  if(String(text).includes('CRIT'))return 'crit';if(String(text).includes('CLEAR'))return 'verify';if(String(text).includes('COMBO'))return 'sword';
  return icons[text]||'info';
}
function emoji(e, x, y, size) { if(ctx.UI)ctx.UI.screenIcon(effectIcon(e),x/ctx.DPR,y/ctx.DPR); }
function compact(n) {return n>9999?'9999+':String(Math.max(0,Math.round(n)));}
function px(v, x, y, w, h, c) { ctx.cx.fillStyle = c; ctx.cx.fillRect(v.ox + Math.round(x) * v.Z, v.oy + Math.round(y) * v.Z, w * v.Z, h * v.Z); }
function fxDraw(v, f) {
  const k = f.max ? 1 - f.life / f.max : 0;
  if (f.k === 'bolt') { let x = f.x, y = f.y - 90; ctx.cx.globalAlpha = 1 - k; while (y < f.y) { const nx = x + (Math.random() - .5) * 10; px(v, nx, y, 2, 6, Math.random() < .3 ? '#fff' : f.color); x = nx; y += 6; } ctx.cx.globalAlpha = 1; return; }
  if (f.k === 'swirl') { const n = 10, r = 26 * (1 - ctx.ease(k)); for (let i = 0; i < n; i++) { const a = i / n * 6.28 + k * 9; px(v, f.x + Math.cos(a) * r, f.y + Math.sin(a) * r * .6, 2, 2, i % 2 ? '#c8b0ff' : '#9fd3ff'); } if (k > .8) emoji('📜', v.ox + N(f.x) * v.Z, v.oy + N(f.y) * v.Z, 12 * v.Z); return; }
  if (f.k === 'balloon') { const y = f.y - ctx.ease(k) * 120, x = f.x + Math.sin(k * 8) * 6; ctx.cx.globalAlpha = Math.min(1, f.life * 2); emoji('🎈', v.ox + N(x) * v.Z, v.oy + N(y) * v.Z, 14 * v.Z); ctx.cx.globalAlpha = 1; return; }
  if (f.k === 'proj') {
    const e = f.proj === 'arrow' ? k : ctx.ease(k), x = ctx.lerp(f.x0, f.x1, e), y = ctx.lerp(f.y0, f.y1, e) - Math.sin(e * Math.PI) * f.arc;
    const dx = f.x1 - f.x0, dy = f.y1 - f.y0 - Math.cos(e * Math.PI) * f.arc * 3, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
    if (f.proj === 'arrow') { for (let i = 0; i < 12; i++) px(v, x - ux * i, y - uy * i, 1, 1, i < 2 ? '#dfe6ee' : i > 9 ? '#c84a3a' : f.color); }
    else if (f.proj === 'orb' || f.proj === 'wisp' || f.proj === 'glob') {
      for (let i = 1; i < 6; i++) { ctx.cx.globalAlpha = .5 - i * .08; px(v, x - ux * i * 4 - 2, y - uy * i * 4 - 2, 4, 4, f.color); }
      ctx.cx.globalAlpha = 1; px(v, x - 3, y - 3, 6, 6, f.color); px(v, x - 2, y - 2, 3, 3, f.glow);
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
  if (f.k === 'pillar') { ctx.cx.globalAlpha = 1 - k; px(v, f.x - 5, f.y - 70 * (1 - k * .3), 10, 70 * (1 - k * .3), f.color); px(v, f.x - 2, f.y - 70, 4, 70, '#fffbe6'); ctx.cx.globalAlpha = 1; return; }
  if (f.k === 'ring') {
    const r = f.r * (.3 + k * .9), n = Math.max(10, Math.round(r * 1.2)); ctx.cx.globalAlpha = 1 - k;
    for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2; px(v, f.x + Math.cos(a) * r, f.y + Math.sin(a) * r * (f.flat ? .35 : 1), 2, 2, f.color); }
    ctx.cx.globalAlpha = 1; return;
  }
  if (f.k === 'p') { const [x, y] = P(v, f.x, f.y); ctx.cx.fillStyle = f.color; ctx.cx.fillRect(x, y, 2 * v.Z, 2 * v.Z); }
  else if (f.k === 'num') { const [x, y] = P(v, f.x, f.y - 18 * ctx.ease(Math.min(1, k * 1.6))); ctx.cx.globalAlpha = Math.min(1, f.life * 2); nameplate(x, y, f.text, f.color); ctx.cx.globalAlpha = 1; }
  else if (f.k === 'coin') { const e = ctx.ease(k), [x, y] = P(v, ctx.lerp(f.x0, f.x1, e), ctx.lerp(f.y0, f.y1, e) - Math.sin(e * Math.PI) * 60); emoji('🪙', x, y, 7 * v.z); }
  else if (f.k === 'arrows') { const e = ctx.ease(k); for (let i = 0; i < 3; i++) { const [x, y] = P(v, ctx.lerp(f.x0, f.x1, e) - i * 6, ctx.lerp(f.y0, f.y1, e) + i * 2); ctx.cx.fillStyle = '#e8f0ff'; ctx.cx.fillRect(x, y, 6 * v.Z, v.Z); } }
  else if (f.k === 'portal') { const [x, y] = P(v, f.x, f.y); const r = (8 + Math.sin(k * 20) * 2) * v.z * Math.min(1, k * 4) * Math.min(1, f.life * 2); ctx.cx.strokeStyle = '#7fc8ff'; ctx.cx.lineWidth = 3 * ctx.DPR; ctx.cx.beginPath(); ctx.cx.ellipse(x, y - 14 * v.z, r * .6, r * 1.3, 0, 0, 7); ctx.cx.stroke(); }
  else if (f.k === 'raven') { const e = ctx.ease(k), [x, y] = P(v, ctx.lerp(f.x0, f.x1, e), ctx.lerp(f.y0, f.y1, e) - Math.sin(e * Math.PI) * 50); emoji(f.icon || '🐦‍⬛', x, y, 9 * v.z); }
  else if (f.k === 'council') { const [x,y]=P(v,f.h.x,f.h.y);emoji('🧙',x,y-46*v.z,16);nameplate(x,y-68*v.z,'2','#ffd36b'); }
}
function vignette() { const g = ctx.cx.createRadialGradient(ctx.cv.width / 2, ctx.cv.height / 2, ctx.cv.height * .45, ctx.cv.width / 2, ctx.cv.height / 2, ctx.cv.height * .95); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.28)'); ctx.cx.fillStyle = g; ctx.cx.fillRect(0, 0, ctx.cv.width, ctx.cv.height); }
return {
  get ALPHA_BOXES(){return ALPHA_BOXES},
  get spriteBox(){return spriteBox}, set spriteBox(v){spriteBox=v},
  get registerCharacter(){return registerCharacter}, set registerCharacter(v){registerCharacter=v},
  get registerSprite(){return registerSprite}, set registerSprite(v){registerSprite=v},
  get inspectionLinks(){return inspectionLinks}, set inspectionLinks(v){inspectionLinks=v},
  get sceneSelection(){return sceneSelection}, set sceneSelection(v){sceneSelection=v},
  get sceneOverflow(){return sceneOverflow}, set sceneOverflow(v){sceneOverflow=v},
  get resize(){return resize}, set resize(v){resize=v},
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
  get vignette(){return vignette}, set vignette(v){vignette=v}
};
};
