/* Pixel artwork with visible, local-system-font text fallbacks. MIT. */
(function(root) {
  'use strict';
  const $=s=>document.querySelector(s), T=root.UIText, I=root.UIGlyphs;
  const icons=new Map(), numbers=new Map(), sceneLabels=new Map();
  let epoch=0, reserved=[], grid=1, drawn=[];
  const overlay=$('#ui-stage'), slots=[];let slot=0, budget=Infinity, used=0;
  function iconImage(id,state='normal') {
    const key=id+state;if(icons.has(key))return icons.get(key);
    const c=document.createElement('canvas');c.width=c.height=36;
    I.draw(c.getContext('2d'),id,2,2,2,state);icons.set(key,c);return c;
  }
  function systemImage(text,color='#e8dfc6') {
    const c=document.createElement('canvas'),g=c.getContext('2d');g.font='bold 14px system-ui, sans-serif';
    c.width=Math.max(1,Math.ceil(g.measureText(text).width)+8);c.height=22;
    g.font='bold 14px system-ui, sans-serif';g.fillStyle=color;g.fillText(text,4,16);return c;
  }
  function numericImage(text,color='#e8dfc6') {
    if(Array.from(text).some(ch=>!Object.hasOwn(T.glyphs,ch)))return systemImage(text,color);
    const key=text+color;if(numbers.has(key))return numbers.get(key);
    const c=document.createElement('canvas');c.width=Math.max(1,T.measure(text,2));c.height=16;
    T.draw(c.getContext('2d'),text,0,0,{scale:2,color});
    if(numbers.size>128)numbers.clear();numbers.set(key,c);return c;
  }
  function paint(el,im,label) {
    if(!el)return;
    if(el.dataset.pixelKey===label)return;
    el.dataset.pixelKey=label;el.setAttribute('aria-label',label);
    let c=el.querySelector('canvas');if(!c){c=document.createElement('canvas');c.setAttribute('aria-hidden','true');el.replaceChildren(c);}
    const d=Math.ceil(root.devicePixelRatio||1);c.width=im.width*d;c.height=im.height*d;
    c.style.width=im.width+'px';c.style.height=im.height+'px';
    const g=c.getContext('2d');g.imageSmoothingEnabled=false;g.drawImage(im,0,0,c.width,c.height);
  }
  function control(selector,id,label,state='normal') {
    const el=$(selector);if(!el)return;paint(el,iconImage(id,state),label+' '+state);
    let name=el.querySelector('.control-name');if(!name){name=document.createElement('span');name.className='control-name';el.append(name);}
    name.textContent=label;el.title=label;el.classList.add('named-control');
  }
  function number(selector,text,label) {
    const el=$(selector);if(!el)return;
    const value=selector==='#speeds'?text+'×':text;
    if(selector==='#speeds')label='Replay speed';
    el.textContent=value;el.setAttribute('aria-label',label+': '+value);el.title=label+': '+value;
  }
  const visible=el=>el&&!el.hidden&&getComputedStyle(el).display!=='none'&&(!el.getClientRects||el.getClientRects().length>0);
  function bounds() {
    const top=($('#focus-bar')?.getBoundingClientRect().bottom||52)+8;
    const menuEl=$('#menu');if(menuEl){menuEl.style.top=top+'px';menuEl.style.maxHeight=Math.max(44,innerHeight-top-8)+'px';}
    const hint=$('#first-run');if(hint)hint.style.top=top+'px';
    const fixed=['#focus-bar','#menu','#quest','#character-card','#scene-overflow','#scene-selected','#working-panel','#first-run'].map($).filter(visible).map(el=>el.getBoundingClientRect());
    reserved=fixed.map(r=>({left:r.left-8,top:r.top-8,right:r.right+8,bottom:r.bottom+8}));
    const outer=fixed.filter((r,i)=>!fixed.some((o,j)=>i!==j&&r.left>=o.left&&r.top>=o.top&&r.right<=o.right&&r.bottom<=o.bottom));
    const area=innerWidth*innerHeight,covered=outer.reduce((n,r)=>n+r.width*r.height,0),ratio=innerWidth<=760||innerHeight<=500?.25:.2;
    // The work summary can occupy more than the legacy text budget by itself.
    // Reserve text in the remaining scene; do not silently drop every name.
    budget=Math.max(0,visible($('#working-panel'))?(area-covered)*ratio:area*ratio-covered);
  }
  function resize() {
    grid=Math.ceil(root.devicePixelRatio||1);bounds();
  }
  function clear() {bounds();drawn=[];slot=0;used=0;}
  function flush() {for(let i=slot;i<slots.length;i++)slots[i].hidden=true;}
  function image(im,x,y) {
    if(slot>=128||used+im.width*im.height>budget)return;used+=im.width*im.height;
    let c=slots[slot++];if(!c){c=document.createElement('canvas');c.setAttribute('aria-hidden','true');c.style.left=c.style.top='0px';overlay.append(c);slots.push(c);}
    if(c._source!==im||c._grid!==grid){c.width=im.width*grid;c.height=im.height*grid;c.style.width=im.width+'px';c.style.height=im.height+'px';
      const g=c.getContext('2d');g.imageSmoothingEnabled=false;g.drawImage(im,0,0,c.width,c.height);c._source=im;c._grid=grid;}
    c.style.transform=`translate(${x}px,${y}px)`;c.hidden=false;
    drawn.push({left:x,top:y,right:x+im.width,bottom:y+im.height,...(im._unicode?{unicode:true}:{})});
  }
  function fits(x,y,w,h) {const overlaps=r=>x<r.right&&x+w>r.left&&y<r.bottom&&y+h>r.top;
    return x>=0&&y>=0&&x+w<=innerWidth&&y+h<=innerHeight&&!reserved.some(overlaps)&&!drawn.some(overlaps);}
  function screenIcon(id,x,y,state='normal') {
    const im=iconImage(id,state);x=Math.round(x-im.width/2);y=Math.round(y-im.height/2);
    if(fits(x,y,im.width,im.height))image(im,x,y);
  }
  function screenNumber(text,x,y,color) {
    const im=numericImage(text,color);x=Math.round(x-im.width/2);y=Math.round(y-im.height);
    for(let lane=0;lane<3;lane++){const top=y-lane*18;
      if(fits(x,top,im.width,im.height)){image(im,x,top);break;}}
  }
  function screenLabel(text,x,y,pin=false,maxWidth=Infinity) {
    let label=text.toUpperCase(),im=numericImage(label,'#ffd36b');
    if(Number.isFinite(maxWidth)&&Array.from(label).some(ch=>!Object.hasOwn(T.glyphs,ch))){
      const width=Math.max(48,Math.floor(maxWidth)),key=JSON.stringify([label,width]);
      if(!sceneLabels.has(key)){
        const token=epoch;sceneLabels.set(key,null);
        (async()=>{
          const parts=T.graphemes(label);let value=await T.bitmap(label,{maxWidth:1024,color:'#ffd36b'});
          while(parts.length&&value.width>width){parts.pop();value=await T.bitmap(parts.join('')+'...',{maxWidth:1024,color:'#ffd36b'});}
          if(token===epoch){const canvas=value.lines[0].canvas;canvas._unicode=true;sceneLabels.set(key,canvas);}
        })().catch(()=>{if(token===epoch)sceneLabels.set(key,systemImage(label,'#ffd36b'));});
        if(sceneLabels.size>64)sceneLabels.delete(sceneLabels.keys().next().value);
      }
      im=sceneLabels.get(key)||numericImage('...','#ffd36b');
    }
    if(im.width>maxWidth){
      const parts=Array.from(new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(label),s=>s.segment);
      while(parts.length&&im.width>maxWidth){parts.pop();im=numericImage(parts.join('')+'...','#ffd36b');}
    }
    x=Math.round(x-im.width/2);y=Math.round(y-im.height);
    if(pin){x=Math.round(Math.max(8,Math.min(innerWidth-im.width-8,x)));
      y=Math.round(Math.max(($('#focus-bar')?.getBoundingClientRect().bottom||0)+12,Math.min(innerHeight-im.height-8,y)));}
    // System/Unicode fallback labels can be taller than the bitmap's 18px lane.
    // Try above as well as below the anchor; adjacent full names must not disappear.
    const lanes=pin?[0,1,-1,2,-2,3,-3]:[0],step=Math.max(18,im.height+4);
    const candidates=lanes.map(lane=>y+lane*step);
    // Mixed bitmap/system-font heights leave gaps that a fixed lane grid misses.
    if(pin)candidates.push(...[...reserved,...drawn].flatMap(r=>
      [Math.ceil(r.bottom+4),Math.floor(r.top-im.height-4)]).sort((a,b)=>Math.abs(a-y)-Math.abs(b-y)));
    for(const top of candidates){
      if(fits(x-2,top-2,im.width+4,im.height+4)){image(im,x,top);break;}}
  }
  let overflowKey='',overflowGroups=[];
  function selected(label,id='quests') {
    let el=$('#scene-selected');
    if(!el){el=document.createElement('div');el.id='scene-selected';el.setAttribute('role','img');
      el.style.cssText='position:fixed;left:8px;z-index:7;max-width:calc(100vw - 16px);display:flex;align-items:center;gap:4px;padding:4px;background:#0d1423;border:2px solid #ffd36b;border-radius:4px;pointer-events:none';
      document.body.append(el);}
    el.hidden=!label;
    if(!label){el.replaceChildren();el.removeAttribute('aria-label');delete el.dataset.label;return;}
    el.style.top=(($('#focus-bar')?.getBoundingClientRect().bottom||52)+8)+'px';
    el.setAttribute('aria-label','Selected '+label);
    if(el.dataset.label===label+' '+id)return;el.dataset.label=label+' '+id;el.replaceChildren();
    const symbol=iconImage(id).cloneNode(true);symbol.getContext('2d').drawImage(iconImage(id),0,0);symbol.setAttribute('aria-hidden','true');
    const text=document.createElement('span');paint(text,numericImage(label.toUpperCase()),'Selected '+label);el.append(symbol,text);
  }
  function sceneOverflow(groups) {
    overflowGroups=groups;
    let el=$('#scene-overflow');
    if(!el){el=document.createElement('div');el.id='scene-overflow';
      el.style.cssText='position:fixed;left:8px;bottom:8px;max-width:calc(100vw - 16px);display:flex;flex-wrap:wrap;gap:4px;z-index:5';
      el.setAttribute('aria-label','Characters outside the standing slots');document.body.append(el);}
    el.hidden=!groups.length;
    placeOverflow();bounds();
  }
  // The fixed overflow badges and the character card both live bottom-left. While the card is open
  // the per-region badges are replaced by one compact 44 px control stacked above it (same total
  // count, list of every overflow entry), so no card text is covered. Only the buttons for the
  // current mode exist in the DOM.
  function placeOverflow() {
    const el=$('#scene-overflow');if(!el)return;
    const groups=overflowGroups,card=$('#character-card'),docked=visible(card)&&groups.length>0;
    const key=JSON.stringify([docked,groups.map(g=>[g.region,g.label,g.count,g.blocked])]);
    if(key!==overflowKey){overflowKey=key;el.replaceChildren();
      const empty='No characters outside the standing slots';
      if(docked){
        const total=groups.reduce((n,g)=>n+g.count,0),blocked=groups.reduce((n,g)=>n+g.blocked,0);
        const b=button(el,'+'+total+' outside'+(blocked?' · '+blocked+' blocked':''),()=>
          listDialog('Overflow',()=>overflowGroups.flatMap(g=>g.rows().map(r=>({...r,summary:g.label+' · '+r.summary}))),empty));
        b.setAttribute('aria-label',total+' characters outside the standing slots'+(blocked?', '+blocked+' blocked':'')+'. Open list');
      } else for(const group of groups)button(el,group.label+' +'+group.count+(group.blocked?' · '+group.blocked+' blocked':''),()=>
        listDialog(group.label+' overflow',()=>overflowGroups.find(g=>g.region===group.region)?.rows()||[],empty));
    }
    if(docked){const r=card.getBoundingClientRect();
      el.style.left=r.left+'px';el.style.maxWidth=r.width+'px';el.style.bottom=Math.max(8,innerHeight-r.top+8)+'px';}
    else{el.style.left='8px';el.style.maxWidth='calc(100vw - 16px)';el.style.bottom='8px';}
  }
  // Game symbols survive plain() so renderFeed does not erase their meaning.
  // Visible symbols come only from our atlas; no emoji reaches the detail font.
  const symbols={
    '💥':['sword','Impact or command failure'],'💬':['message','Message'],'✨':['delegate','Council advice'],
    '🧭':['world','Navigate'],'👹':['quests','New monster'],'🧘':['compress','Compress context'],
    '👑':['delegate','Captain'],'🏹':['test','Test'],'🌀':['delegate','Quest handoff'],
    '⏳':['clock','Extend time'],'🐦‍⬛':['message','Message from Captain'],'🦊':['delegate','Summon subagent'],
    '🛡':['review','Send for review'],'⛓':['chain','Blocked'],'🔓':['chain','Unblocked'],'💀':['offline','Failed'],
    '🏆':['verify','Completed'],'😴':['sleep','Rest'],'☀':['play','Ready'],'📯':['delegate','Assign work'],
    '🍺':['sleep','Tavern'],'🪙':['coin','Coins'],'⚓':['world','Harbor'],'🔥':['build','Campfire'],
    '📜':['read','Document'],'📖':['read','Read'],'🔍':['search','Search'],'👁':['vision','View image'],
    '✒':['write','Write'],'🗝':['memory','Memory'],'🕊':['message','Message'],'🐣':['delegate','Delegate'],
    '🧙':['delegate','Council'],'⚒':['commit','Commit work'],'🎈':['push','Push work'],'⚔':['sword','Attack'],
    '💤':['sleep','Rest'],'🔮':['search','Search']
  };
  const symbolPattern=new RegExp('('+Object.keys(symbols).sort((a,b)=>b.length-a.length).join('|')+'\\uFE0F?)','gu');
  const symbol=part=>symbols[part.replace(/\uFE0F/g,'')];
  // Strip only formatting created by the game; never parse payload as HTML.
  function plain(value) {
    return String(value??'').replace(/<\/?(?:b|span)(?: class="who")?>/g,'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&')
      .split(symbolPattern).map(part=>symbol(part)?part:part.replace(/[^\p{L}\p{M}\p{N}\p{P}\p{Zs}\n+<>=]/gu,'')).join('').trim();
  }
  async function line(parent,text) {
    text=plain(text);const token=epoch;
    const row=document.createElement('div');row.className='bitmap-row';
    const parts=text.split(symbolPattern), meanings=parts.map(part=>symbol(part)?.[1]||part).join(' ');
    const accessible=document.createElement('span');accessible.className='detail-text';accessible.textContent=meanings||'Details unavailable';
    row.append(accessible);parent.append(row);
    const glyphs=parts.map(symbol).filter(Boolean);
    if(glyphs.length){const strip=document.createElement('div');strip.style.cssText='display:flex;flex-wrap:wrap;gap:2px';row.append(strip);
      for(const [id] of glyphs){const holder=document.createElement('span');paint(holder,iconImage(id),id);strip.append(holder.firstChild);}}
    if(glyphs.length)return; // The words describe the symbols on touch and when fonts fail.
    text=parts.filter(part=>!symbol(part)).join('');
    try {
      const value=await T.bitmap(text||'-',{maxWidth:Math.max(32,parent.clientWidth-(parent.classList.contains('legend-row')?68:24))});
      if(token!==epoch||!row.isConnected)return;
      if(!text.trim())return; // A symbol-only row still needs its visible meaning.
      accessible.className='sr-only';
      for(const b of value.lines){const c=document.createElement('canvas');const d=Math.ceil(root.devicePixelRatio||1);
        c.width=b.width*d;c.height=b.height*d;c.style.width=b.width+'px';c.style.height=b.height+'px';c.setAttribute('aria-hidden','true');
        const g=c.getContext('2d');g.imageSmoothingEnabled=false;g.drawImage(b.canvas,0,0,c.width,c.height);row.append(c);}
    } catch(e) {
      if(token!==epoch||!row.isConnected)return;
      accessible.className='detail-text';row.dataset.textFallback='true';
    }
  }
  // The open dialog is bound to retained identities. returnFocus/returnSpec remember the opener
  // (and, for list rows, its identity) because list rows are rebuilt while the dialog is open.
  let returnFocus=null, returnSpec=null, live=null;
  function remember(el) {
    returnFocus=el&&el!==document.body&&el!==document.documentElement?el:null;returnSpec=null;
    const entry=el?.closest?.('.item-summary[data-key]'), parent=entry?.parentElement;
    if(entry&&parent?.id)returnSpec={key:entry.dataset.key,container:'#'+parent.id,all:'#'+parent.id.replace(/-list$/,'-all')};
  }
  function focusTarget() {
    if(returnFocus?.isConnected&&visible(returnFocus))return returnFocus;
    if(returnSpec){
      if(returnSpec.focus){const own=returnSpec.focus();return visible(own)?own:$('#menu-toggle');}
      const row=Array.from(document.querySelectorAll(returnSpec.container+' .item-summary')).find(e=>e.dataset.key===returnSpec.key);
      const own=row?.querySelector('button'), all=$(returnSpec.all);
      if(visible(own))return own;if(visible(all))return all;
    }
    return $('#menu-toggle');
  }
  function close() {
    const wasOpen=!$('#quest').hidden;$('#quest').hidden=true;$('#quest').replaceChildren();live=null;bounds();
    if(wasOpen)focusTarget().focus();
  }
  // live (optional): {refresh} returns null when the subject left retained history (dialog closes and
  // focus returns to its opener), undefined to keep the current content, or new lines to show.
  function detail(lines,label='Details',binding=null) {
    if($('#quest').hidden){remember(document.activeElement);if(binding?.focus)returnSpec={focus:binding.focus};}
    label=({'Quest':'Quest details','Task details':'Quest details','Working quest':'Quest details','Hero':'Hero details','Helper':'Hero details','World':'World locations','Region':'Location details','All tasks':'All quests'})[label]||label;
    const el=$('#quest');el.hidden=false;el.replaceChildren();el.setAttribute('aria-label',label);el.setAttribute('aria-labelledby','dialog-heading');live=null;
    const button=document.createElement('button');button.className='close text-button';button.textContent='Close';button.setAttribute('aria-label','Close '+label);
    el.append(button);button.onclick=close;
    const heading=document.createElement('h2');heading.id='dialog-heading';heading.textContent=label;el.append(heading);
    const content=document.createElement('div');content.className='detail-content';el.append(content);
    for(const text of lines)line(content,text);bounds();button.focus();
    if(binding){
      live={kind:'detail',refresh:binding.refresh,status:binding.status,key:JSON.stringify(lines),at:performance.now()};
      refreshDialogStatus();
    }
  }
  // View all: rows follow the current retained list, so evicted identities and their actions disappear.
  function listDialog(label,rowsOf,empty) {
    detail([],label);const content=$('#quest .detail-content');
    live={kind:'list',rowsOf,empty,key:null,content};renderList();
  }
  function renderList() {
    const rows=live.rowsOf()||[], key=JSON.stringify(rows.map(r=>[r.key,r.summary]));
    if(key===live.key)return;live.key=key;
    const active=document.activeElement, focusedKey=live.content.contains(active)?active.closest('.item-summary')?.dataset.key:undefined;
    itemList(live.content,rows,live.empty,true);
    if(focusedKey!==undefined&&document.activeElement!==$('#quest .close')&&!live.content.contains(document.activeElement)){
      const row=Array.from(live.content.querySelectorAll('.item-summary')).find(e=>e.dataset.key===focusedKey);
      (row?.querySelector('button')||$('#quest .close')).focus();
    }
  }
  function refreshDialogStatus() {
    if(!live?.status)return;
    const lines=panelStaleLines(live.status()),key=JSON.stringify(lines);
    if(key===live.statusKey)return;live.statusKey=key;
    let section=$('#quest .detail-status');
    if(!section){section=document.createElement('div');section.className='detail-status';$('#quest').append(section);}
    section.replaceChildren();section.hidden=!lines.length;
    for(const text of lines)line(section,text);bounds();
  }
  function refreshDialog() {
    if(!live||$('#quest').hidden)return;
    if(live.kind==='list')return renderList();
    refreshDialogStatus();
    if(!live.refresh)return;
    const lines=live.refresh();
    if(lines===null){close();return;}
    if(!Array.isArray(lines))return;
    const key=JSON.stringify(lines);
    if(key===live.key||performance.now()-live.at<1000)return;
    live.key=key;live.at=performance.now();
    const content=$('#quest .detail-content');content.replaceChildren();
    for(const text of lines)line(content,text);bounds();
  }
  const groups=['playback','overview','world','settings'], preferenceKey='quest-menu-v1';
  let overviewKey='', overviewData=null, lastFeed=[], lastCamps=[], feedOptions={}, campOptions={}, allFeed=false, allCamps=false;
  let connectionState='loading', connectionText='Loading…', sourceMode='Loading', staleInfo=null;
  function savePreference() {
    const value={menu:!$('#menu').hidden,groups:Object.fromEntries(groups.map(id=>[id,!!$('#group-'+id).open]))};
    try {root.localStorage.setItem(preferenceKey,JSON.stringify(value));} catch (_) { /* Storage is optional. */ }
  }
  function menu(open,restoreFocus=false) {
    $('#menu').hidden=!open;$('#menu-toggle').setAttribute('aria-expanded',String(open));
    $('#menu-toggle').setAttribute('aria-label',open?'Close menu':'Menu');
    $('#menu-toggle').textContent=open?'Close menu':'Menu';
    savePreference();bounds();
    if(!open&&restoreFocus)$('#menu-toggle').focus();
    if(open&&overviewData)overview(overviewData);
  }
  function button(parent,label,action) {
    const b=document.createElement('button');b.className='text-button';b.textContent=label;b.setAttribute('aria-label',label);b.onclick=action;parent.append(b);return b;
  }
  function itemList(target,rows,empty,all=false) {
    const el=typeof target==='string'?$(target):target;el.replaceChildren();
    if(!rows.length){const p=document.createElement('p');p.textContent=empty;el.append(p);return;}
    for(const row of rows.slice(0,all?rows.length:3)){
      const entry=document.createElement('div');entry.className='item-summary';entry.dataset.key=presentationKey(row.key);const text=document.createElement('span');
      text.textContent=row.summary;entry.append(text);button(entry,'Details',row.details);el.append(entry);
    }
  }
  // Focus keys stay stable across rebuilds without exposing source IDs in DOM.
  const presentationKeys=new Map();let nextPresentationKey=0;
  function presentationKey(key) {
    key=String(key??'');
    if(!presentationKeys.has(key)){
      if(presentationKeys.size>=16384)presentationKeys.delete(presentationKeys.keys().next().value);
      presentationKeys.set(key,'item-'+(++nextPresentationKey));
    }
    return presentationKeys.get(key);
  }
  // A summary list is rebuilt on every changed overview, which deletes the focused Details button.
  // Whatever focus the list owns (including focus a closing dialog just returned to a stale row)
  // moves to the same row by key if it is still retained, else View all, else the Menu toggle.
  function keepListFocus(listSelector,allSelector,rebuild) {
    const list=$(listSelector), active=document.activeElement, owned=list?.contains(active)&&active!==list;
    const key=owned?active.closest('.item-summary')?.dataset.key:undefined;
    const disclosure=owned&&active===list.querySelector('summary');
    rebuild();
    if(!owned||document.activeElement===active)return;
    const row=Array.from(list.querySelectorAll('.item-summary')).find(e=>e.dataset.key===key);
    const own=disclosure?list.querySelector('summary'):row?.querySelector('button'), all=$(allSelector);
    (visible(own)?own:visible(all)?all:$('#menu-toggle')).focus();
  }
  function overview(data) {overviewView(data);refreshDialog();} // Dialog last: list rows exist again for focus return.
  function overviewTasks(data) {
    const el=$('#tasks-list'),completed=data.tasks.filter(t=>t.completed);
    const wasOpen=el.querySelector('details')?.open===true;
    itemList(el,data.tasks.filter(t=>!t.completed),data.empty);
    if(!completed.length)return;
    if(!data.tasks.some(t=>!t.completed))el.replaceChildren();
    const group=document.createElement('details'),heading=document.createElement('summary');
    heading.textContent='Completed quests · '+completed.length;group.append(heading);group.open=wasOpen;
    const rows=document.createElement('div');group.append(rows);itemList(rows,completed,data.empty);el.append(group);
  }
  function overviewView(data) {
    overviewData=data;
    const issueCount=data.blocked+data.errors.length;
    const badge=$('#issues'),down=connectionState==='offline'||connectionState==='snapshot'||connectionState==='stale';badge.hidden=!issueCount&&!down;
    const label=[data.blocked?data.blocked+' blocked quests':null,data.errors.length?data.errors.length+' issues':null,
      down?connectionText:null].filter(Boolean).join(' · ');
    badge.textContent=label;badge.setAttribute('aria-label',label||'No observed issues');
    badge.onclick=()=>detail([data.blocked+' blocked quests',...data.errors,
      ...(down?[connectionText,...staleLines()]:[]),
      ...data.tasks.filter(t=>t.blocked).map(t=>t.summary),'Open Overview for permitted quest details.'],'Issues');
    $('#overview-summary').textContent=[data.summary,...panelStaleLines(data)].join(' · ');
    if($('#menu').hidden||!$('#group-overview').open)return;
    const key=JSON.stringify([data.summary,data.tasks.map(t=>[t.key,t.summary,t.completed]),data.heroes.map(h=>[h.key,h.summary])]);
    if(key===overviewKey)return;overviewKey=key;
    keepListFocus('#tasks-list','#tasks-all',()=>overviewTasks(data));
    keepListFocus('#heroes-list','#heroes-all',()=>itemList('#heroes-list',data.heroes,'No heroes in this replay range'));
    $('#tasks-all').onclick=()=>listDialog('All quests',()=>overviewData?.tasks,overviewData.empty);
    $('#heroes-all').onclick=()=>listDialog('All heroes',()=>overviewData?.heroes,'No heroes in this replay range');
  }
  function playback(text) {$('#playback-summary').textContent=text;}
  function mode(text) {
    sourceMode=text;
    const source=({DEMO:'Sample data',Replay:'Saved history (not live)',Live:'Live data',Snapshot:'Saved history (not live)'})[text]||text;
    const connectionLabel={loading:'Loading',online:'Connected',snapshot:'Live paused',offline:'Offline',stale:'Live paused',file:'Saved history (not live)'}[connectionState]||'Unknown';
    $('#mode').textContent=source;
    $('#mode').setAttribute('aria-label',source+(connectionState==='file'?'':' · '+connectionLabel));
  }
  function privacy() {
    const work=$('#working-panel');if(work){work.hidden=true;$('#working-rows').replaceChildren();$('#working-order').textContent='';$('#working-rewards').textContent='';}
    selected(null);presentationKeys.clear();
    sceneOverflow([]);
    epoch++;T.clearCache();numbers.clear();sceneLabels.clear();feedKey='';campKey='';overviewKey='';overviewData=null;lastFeed=[];lastCamps=[];feedOptions={};campOptions={};
    close();$('#quest').replaceChildren();$('#tasks-list').replaceChildren();$('#heroes-list').replaceChildren();
    $('#overview-summary').textContent='Loading activity…';$('#issues').hidden=true;$('#issues').onclick=null;
    $('#tasks-all').onclick=$('#heroes-all').onclick=null;
    $('#feed').replaceChildren();$('#camps').replaceChildren();clear();flush();
  }
  function drawer(which) {
    const el=$('#'+which), open=el.hidden;menu(true);$('#group-overview').open=true;
    el.hidden=!open;savePreference();bounds();
    if(open){el.scrollIntoView({block:'nearest'});$('#'+which+'-close').focus();}
    return open;
  }
  let feedKey='',campKey='';
  function panelStaleLines(options) {
    if(!options?.stale)return [];
    const info=options.staleInfo||{};
    return ['Stale data · live updates paused',info.updated?'Last successful update: '+info.updated:'No successful update yet',
      'Reason: '+(info.reason||'update failed'),'Retrying in '+(info.retrySeconds||10)+' sec'];
  }
  function feed(entries,options={}) {
    lastFeed=entries;feedOptions=options;refreshDialog();if($('#chron').hidden)return;
    const filter=$('#feed-filter').value||'all',issue=f=>typeof f.issue==='boolean'?f.issue:/⛓|💀|💥|Blocked|Failed|Unavailable/i.test(f.text);
    const selected=entries.filter(f=>filter==='all'||(filter==='issues'?issue(f):!issue(f)));
    const key=JSON.stringify([selected,allFeed,filter,options]);if(key===feedKey)return;feedKey=key;const el=$('#feed');el.replaceChildren();
    for(const text of panelStaleLines(options))line(el,text);
    const shown=selected.slice(0,allFeed?selected.length:5);
    if(!shown.length)line(el,options.loading?'Loading activity…':options.empty||'No activity for this filter in saved history');
    for(const f of shown){const row=document.createElement('section');el.append(row);line(row,f.text);
      button(row,'Details',()=>detail([f.detailText||f.text,'Activity from the current retained replay history'],'Activity details',{status:()=>feedOptions}));}
    $('#feed-all').textContent=allFeed?'Show recent activity':'View all activity';
  }
  function campaignCount(parent,value) {
    const text=plain(value), match=/^(\d+)\/(\d+)(?:\s+(?:quests|เควส))?(?:\s*(?:·\s*)?⚔\uFE0F?\s*(\d+))?$/.exec(text);
    const row=document.createElement('div');row.className='campaign-count';
    row.textContent=match?match[1]+' of '+match[2]+' quests complete'+(match[3]===undefined?'':' · '+match[3]+' observed attacks'):text||'Quest count: unavailable';
    row.setAttribute('aria-label',row.textContent);parent.append(row);
  }
  function camps(rows,options={}) {
    lastCamps=rows;campOptions=options;refreshDialog();if($('#camp').hidden)return;
    const key=JSON.stringify([rows,allCamps,options]);if(key===campKey)return;campKey=key;const el=$('#camps');el.replaceChildren();
    for(const text of panelStaleLines(options))line(el,text);
    if(!rows.length)line(el,'No campaigns in this replay range');
    for(const r of rows.slice(0,allCamps?rows.length:3)) {
      const section=document.createElement('section');section.className='campaign';el.append(section);
      line(section,r.title);campaignCount(section,r.count);
      const pips=document.createElement('div');pips.className='pips';section.append(pips);
      for(const p of r.stages){const name=document.createElement('span');name.textContent=p.id+' stage: '+p.state;pips.append(name);}
      if(r.blocked)line(section,r.blocked);
      button(section,'Details',()=>detail([r.title,section.querySelector('.campaign-count').textContent,...r.stages.map(p=>p.id+' stage: '+p.state),r.blocked||'No blocked quests observed'],'Campaign details',{status:()=>campOptions}));
    }
    $('#camps-all').textContent=allCamps?'Show recent campaigns':'View all campaigns';
  }
  function resources(values,ledger={}) {
    const el=$('#mana');
    if(!el.children.length)for(const [key,id,color] of [['claude','mana-claude','#4aa3ff'],['codex','mana-codex','#58c27a'],['agy','mana-gemini','#b07cff']]) {
      const box=document.createElement('div');box.dataset.wallet=key;const c=document.createElement('canvas');c.width=c.height=16;
      I.draw(c.getContext('2d'),id,0,0,1);c.setAttribute('aria-hidden','true');box.append(c);
      const n=document.createElement('span');n.className='percentage';box.append(n);const bar=document.createElement('i'),fill=document.createElement('b');fill.style.background=color;bar.append(fill);box.append(bar);el.append(box);
    }
    for(const box of el.children){
      const wallet=box.dataset.wallet,entry=ledger[wallet],value=values[wallet];
      const n=Number.isFinite(value)?Math.max(0,Math.min(100,Math.round(value))):100;
      const usedTokens=Math.round(Math.max(0,Number.isFinite(entry?.net)?entry.net:0));
      const notes=[entry?.hasCharsEstimate?'Includes character-based token estimates':null,
        entry?.hasUsageCorrection?'Includes signed usage corrections':null].filter(Boolean);
      const label=wallet+' simulated mana '+n+'%; '+usedTokens.toLocaleString('en-US')+
        ' used tokens; simulated capacity 100,000 tokens per wallet per replay epoch, not a real quota'+
        (notes.length?'; '+notes.join('; '):'');
      box.setAttribute('role','img');box.setAttribute('aria-label',label);
      const provider=({claude:'Claude',codex:'Codex',agy:'Gemini'})[wallet]||wallet;
      box.querySelector('.percentage').textContent=provider+' simulated mana: '+n+'%';box.querySelector('b').style.width=n+'%';
    }
  }
  function staleLines() {
    return staleInfo?['Live updates are paused: the latest data could not be loaded.',
      staleInfo.updated?'Last successful update: '+staleInfo.updated+'.':'No successful update yet.','Reason: '+staleInfo.reason+'.',
      'Retrying in '+(staleInfo.retrySeconds||10)+' sec.','The game keeps running on the data it already has and returns to Live by itself after one successful update.']:[];
  }
  function status(text,state,extra) {
    const was=connectionState;
    connectionState=state;connectionText=text;staleInfo=state==='stale'?(extra||{updated:null,reason:'update failed'}):null;mode(extra?.source||sourceMode);
    control('#connection',({online:'connected',file:'snapshot',stale:'offline'})[state]||state,text,state==='offline'||state==='stale'?'alert':'normal');
    $('#connection .control-name').textContent=state==='offline'&&extra?.status?'Server error ('+extra.status+')':({loading:'Loading',online:'Connected',file:'Data source',snapshot:'Live paused',offline:'Offline',stale:'Live paused'})[state]||'Connection details';
    $('#connection').title=text;
    $('#connection').onclick=()=>detail([sourceMode+' data source',connectionText,...staleLines(),
      'Playback and live-follow are separate from connection status.','Live updates poll about every 10 seconds while this browser page is visible.'],'Connection details');
    const note=$('#live-note'),info=$('#live-detail');
    if(note){note.hidden=state!=='stale';note.textContent=staleInfo?(staleInfo.updated?'Last update '+staleInfo.updated:'No update yet')+' · '+staleInfo.reason:'';}
    if(info){info.hidden=state!=='stale';info.textContent=staleInfo?staleLines().slice(0,3).join(' '):'';}
    // Polite announcement on the transitions only, so repeated failed polls never re-announce.
    const say=$('#live-announce');
    if(say&&state==='stale'&&was!=='stale')say.textContent='Live paused. Not updating. '+(staleInfo.updated?'Last update '+staleInfo.updated+'. ':'')+'Reason: '+staleInfo.reason+'.';
    else if(say&&was==='stale'&&(state==='online'||state==='snapshot'))say.textContent='Live updates resumed.'; // only a real successful poll; never on another failure
    else if(say&&state!=='stale')say.textContent='';
    bounds();
    if(overviewData)overview(overviewData);
    else if(state==='offline'||state==='snapshot'||state==='stale'){
      $('#issues').hidden=false;$('#issues').textContent=text;
      $('#issues').setAttribute('aria-label',text);$('#issues').onclick=$('#connection').onclick;
    }
  }
  function legend() {
    const labels={'play':'Play — Resume replay','pause':'Pause — Pause replay','live-follow':'Follow live — Follow the newest live update','speed':'Replay speed: 30× / 120× / 600× — Playback speed relative to real time','clock':'Replay time — Current time in the selected replay','scrub-start':'Oldest saved event — Start of retained history','scrub-end':'Latest saved event — End of retained history; not necessarily live','world':'World locations — Select a location to focus the camera','calm':'Reduce effects — Reduce motion and flashes','quests':'Campaigns — Open grouped quests','log':'Activity log — Open recent retained events','close':'Close — Close the current panel or dialog','info':'Help — Open this icon guide','demo':'Sample data — Fictional example data','connected':'Connected — Live data source is reachable','offline':'Offline — Live source is not reachable','snapshot':'Saved history — Saved replay data; not live','loading':'Loading — Waiting for data','mana-claude':'Claude simulated mana — Game-only meter; not a Claude quota','mana-codex':'Codex simulated mana — Game-only meter; not a Codex quota','mana-gemini':'Gemini simulated mana — Game-only meter; not a Gemini quota','heart':'Hero health: not available — Heroes do not have a health meter','mana':'Simulated mana — not a real quota','level':'Effect level from effort, not XP — Glow reflects reasoning effort','coin':'Completed quests — Coin animation marks observed quest completion','plan':'Plan stage — Quest planning stage','build':'Build stage — Quest implementation stage','test':'Test stage — Quest testing stage','review':'Review stage — Quest review stage','deploy':'Deploy stage — Quest release/deployment stage','verify':'Verify stage — Quest verification stage','chain':'Waiting on a dependency — Another required Quest must finish first','sleep':'Resting — Idle animation; no work progress is implied','sword':'Attack from observed work — Combat represents observed activity; not a separate action','crit':'Critical attack effect — Visual only; does not change actual Quest state','read':'Read — Reading activity','search':'Search — Search activity','vision':'View image — Image inspection activity','write':'Write — Writing activity','memory':'Memory — Memory activity','message':'Message — Details may be privacy-filtered','delegate':'Delegate — Work handed to another agent','commit':'Commit work — Save a change in version control','push':'Push work — Send a change to a remote repository','merge':'Merge work — Combine a change into another branch','compress':'Compress context — Context compression activity'};
    detail([], 'Help');const content=$('#quest .detail-content');
    line(content,'Heroes are workers. Quests are tasks. Select either for details. Saved history is not live. Quest titles may be hidden by privacy settings. Villagers are decorative scenery, not workers or quests.');
    for(const id of I.ids){const row=document.createElement('div');row.className='legend-row';content.append(row);
      const im=iconImage(id),c=document.createElement('canvas');c.width=im.width;c.height=im.height;c.setAttribute('aria-hidden','true');c.getContext('2d').drawImage(im,0,0);row.append(c);
      line(row,labels[id]||id);}
    line(content,'Token capacity is simulated: 100,000 tokens per wallet per replay epoch, not a real provider quota. Used tokens are the nonnegative net total after signed usage corrections; remaining mana is capped between 0% and 100%. Rest does not refill tokens.');
    line(content,'Character-based estimates approximate tokens from text length. Usage corrections adjust earlier totals using reported usage; a correction is not itself a character-based estimate.');
    line(content,'Monster bars show time remaining, not real HP.');bounds();
  }
  function init() {
    if(!T||!I)throw Error('Pixel UI dependencies unavailable');
    control('#world','world','World locations');control('#calm','calm','Reduce effects');control('#quests','quests','Campaigns');control('#log','log','Activity log');
    control('#help','info','Help');control('#live','live-follow','Follow live');
    for(const id of ['camp','chron']){const b=$('#'+id+'-close');b.textContent='Close';b.classList.add('text-button');b.onclick=()=>{$('#'+id).hidden=true;$('#'+(id==='camp'?'quests':'log')).focus();bounds();};}
    $('#help').onclick=legend;$('#world-help').onclick=legend;
    $('#quick-help').onclick=$('#hint-help').onclick=legend;
    try {$('#first-run').hidden=root.localStorage.getItem('quest-hint-v1')==='dismissed';} catch (_) {$('#first-run').hidden=false;}
    $('#hint-dismiss').onclick=()=>{$('#first-run').hidden=true;try {root.localStorage.setItem('quest-hint-v1','dismissed');} catch (_) {} $('#quick-help').focus();bounds();};
    $('#menu-toggle').onclick=()=>menu($('#menu').hidden,!$('#menu').hidden);
    $('#hide-panels').onclick=()=>menu(false,true);
    // The desktop bootstrap audit refuses a literal <select> in index.html, so build the same control at runtime.
    const filter=document.createElement('select');filter.id='feed-filter';filter.setAttribute('aria-label','Activity');
    for(const [value,text] of [['all','All'],['work','Work'],['issues','Issues']]){const o=document.createElement('option');o.value=value;o.textContent=text;filter.append(o);}
    filter.value='all';$('#feed-filter-slot').append(filter);
    filter.onchange=()=>feed(lastFeed,feedOptions);
    $('#feed-all').onclick=()=>{allFeed=!allFeed;feed(lastFeed,feedOptions);};
    $('#camps-all').onclick=()=>{allCamps=!allCamps;camps(lastCamps,campOptions);};
    let saved={};try {saved=JSON.parse(root.localStorage.getItem(preferenceKey))||{};} catch (_) { /* Default canvas-first. */ }
    for(const id of groups){const group=$('#group-'+id);group.open=saved.groups?.[id]===true;
      group.ontoggle=()=>{savePreference();bounds();if(overviewData)overview(overviewData);};}
    menu(saved.menu===true);
    document.addEventListener('keydown',e=>{
      if(e.key==='Escape'){
        if(!$('#quest').hidden)close();else menu(false,true);
        e.preventDefault();bounds();
      } else if(e.key==='Tab'&&!$('#quest').hidden&&$('#quest').querySelectorAll){
        const targets=Array.from($('#quest').querySelectorAll('button,input,select,a[href],[tabindex="0"]')).filter(visible);
        const first=targets[0],last=targets[targets.length-1];
        if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
        else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
      }
    });
    addEventListener('resize',resize);resize();
  }
  root.UIPanels={init,resize,bounds,clear,flush,screenIcon,screenNumber,screenLabel,selected,sceneOverflow,placeOverflow,control,number,resources,status,mode,overview,playback,menu,detail,close,privacy,drawer,feed,camps,plain,
    diagnostics:()=>({grid,epoch,reserved,drawn})};
})(window);
