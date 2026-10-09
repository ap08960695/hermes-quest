/* Pixel-only visible UI; semantic controls and offscreen text remain accessible. MIT. */
(function(root) {
  'use strict';
  const $=s=>document.querySelector(s), T=root.UIText, I=root.UIGlyphs;
  const icons=new Map(), numbers=new Map();
  let epoch=0, reserved=[], grid=1, drawn=[];
  const overlay=$('#ui-stage'), slots=[];let slot=0, budget=Infinity, used=0;
  function iconImage(id,state='normal') {
    const key=id+state;if(icons.has(key))return icons.get(key);
    const c=document.createElement('canvas');c.width=c.height=36;
    I.draw(c.getContext('2d'),id,2,2,2,state);icons.set(key,c);return c;
  }
  function numericImage(text,color='#e8dfc6') {
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
  function control(selector,id,label,state='normal') {paint($(selector),iconImage(id,state),label+' '+state);}
  function number(selector,text,label) {paint($(selector),numericImage(text),label+': '+text);}
  function bounds() {
    reserved=['#hud','#tag','#camp','#chron','#quest','#help','#clock','#scrub'].map($).filter(el=>el&&!el.hidden&&getComputedStyle(el).display!=='none')
      .map(el=>el.getBoundingClientRect()).map(r=>({left:r.left-4,top:r.top-4,right:r.right+4,bottom:r.bottom+4}));
    const fixed=['#hud','#tag','#help','#clock','#scrub'].map(s=>$(s).getBoundingClientRect());
    const outer=fixed.filter((r,i)=>!fixed.some((o,j)=>i!==j&&r.left>=o.left&&r.top>=o.top&&r.right<=o.right&&r.bottom<=o.bottom));
    budget=Math.max(0,innerWidth*innerHeight*(innerWidth<=760||innerHeight<=500?.25:.2)-outer.reduce((n,r)=>n+r.width*r.height,0));
  }
  function resize() {
    grid=Math.ceil(root.devicePixelRatio||1);
    const hud=$('#hud');document.documentElement.style.setProperty('--hud-height',hud.getBoundingClientRect().height+'px');bounds();
  }
  function clear() {bounds();drawn=[];slot=0;used=0;}
  function flush() {for(let i=slot;i<slots.length;i++)slots[i].hidden=true;}
  function image(im,x,y) {
    if(slot>=128||used+im.width*im.height>budget)return;used+=im.width*im.height;
    let c=slots[slot++];if(!c){c=document.createElement('canvas');c.setAttribute('aria-hidden','true');c.style.left=c.style.top='0px';overlay.append(c);slots.push(c);}
    if(c._source!==im||c._grid!==grid){c.width=im.width*grid;c.height=im.height*grid;c.style.width=im.width+'px';c.style.height=im.height+'px';
      const g=c.getContext('2d');g.imageSmoothingEnabled=false;g.drawImage(im,0,0,c.width,c.height);c._source=im;c._grid=grid;}
    c.style.transform=`translate(${x}px,${y}px)`;c.hidden=false;
    drawn.push({left:x,top:y,right:x+im.width,bottom:y+im.height});
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
    const accessible=document.createElement('span');accessible.className='sr-only';accessible.textContent=meanings;
    row.append(accessible);parent.append(row);
    const glyphs=parts.map(symbol).filter(Boolean);
    if(glyphs.length){const strip=document.createElement('div');strip.style.cssText='display:flex;flex-wrap:wrap;gap:2px';row.append(strip);
      for(const [id] of glyphs){const holder=document.createElement('span');paint(holder,iconImage(id),id);strip.append(holder.firstChild);}}
    text=parts.filter(part=>!symbol(part)).join('');
    try {
      const value=await T.bitmap(text||'-',{maxWidth:Math.max(32,parent.clientWidth-(parent.classList.contains('legend-row')?68:24))});
      if(token!==epoch||!row.isConnected)return;
      for(const b of value.lines){const c=document.createElement('canvas');const d=Math.ceil(root.devicePixelRatio||1);
        c.width=b.width*d;c.height=b.height*d;c.style.width=b.width+'px';c.style.height=b.height+'px';c.setAttribute('aria-hidden','true');
        const g=c.getContext('2d');g.imageSmoothingEnabled=false;g.drawImage(b.canvas,0,0,c.width,c.height);row.append(c);}
    } catch(e) {
      if(token!==epoch||!row.isConnected)return;
      const c=document.createElement('canvas');c.width=c.height=36;I.draw(c.getContext('2d'),'offline',2,2,2,'alert');
      c.setAttribute('aria-hidden','true');row.append(c);accessible.textContent=meanings+' — Detail font unavailable';row.setAttribute('role','status');
    }
  }
  function close() {$('#quest').hidden=true;bounds();}
  function detail(lines,label='Details') {
    const el=$('#quest');el.hidden=false;el.replaceChildren();el.setAttribute('aria-label',label);
    const button=document.createElement('button');button.className='close';button.setAttribute('aria-label','Close');
    button.append(iconImage('close').cloneNode(true)); // Canvas pixels do not clone; paint explicitly below.
    el.append(button);paint(button,iconImage('close'),'Close');button.onclick=close;
    const content=document.createElement('div');content.className='detail-content';el.append(content);
    for(const text of lines)line(content,text);bounds();button.focus();
  }
  function privacy() {
    epoch++;T.clearCache();numbers.clear();feedKey='';campKey='';close();$('#quest').replaceChildren();
    $('#feed').replaceChildren();$('#camps').replaceChildren();clear();flush();
  }
  function drawer(which) {
    const el=$('#'+which), open=el.hidden;$('#camp').hidden=true;$('#chron').hidden=true;el.hidden=!open;bounds();return open;
  }
  let feedKey='',campKey='';
  function feed(entries) {
    if($('#chron').hidden)return;
    const key=JSON.stringify(entries);if(key===feedKey)return;feedKey=key;const el=$('#feed');el.replaceChildren();
    for(const f of entries.slice(0,40))line(el,f.text);
  }
  function campaignCount(parent,value) {
    const text=plain(value), match=/^(\d+)\/(\d+)(?:\s+(?:quests|เควส))?(?:\s*(?:·\s*)?⚔\uFE0F?\s*(\d+))?$/.exec(text);
    // Fixed four-cell fields; larger values retain their exact accessible value.
    const compact=n=>n.length>4?'999+':n;
    const im=document.createElement('canvas');im.width=200;im.height=36;
    const g=im.getContext('2d');g.imageSmoothingEnabled=false;
    T.draw(g,match?compact(match[1]):'?',0,10,{scale:2});T.draw(g,'/',48,10,{scale:2});
    T.draw(g,match?compact(match[2]):'?',60,10,{scale:2});g.drawImage(iconImage('sword'),112,0);
    if(match?.[3]!==undefined)T.draw(g,compact(match[3]),152,10,{scale:2});
    const row=document.createElement('div');row.className='campaign-count';row.setAttribute('role','img');parent.append(row);
    paint(row,im,text.replace(/เควส/g,'quests').split(symbolPattern).map(part=>symbol(part)?.[1]||part).join(' '));
  }
  function camps(rows) {
    if($('#camp').hidden)return;
    const key=JSON.stringify(rows);if(key===campKey)return;campKey=key;const el=$('#camps');el.replaceChildren();
    for(const r of rows.slice(0,8)) {
      const section=document.createElement('section');section.className='campaign';el.append(section);
      line(section,r.title);campaignCount(section,r.count);
      const pips=document.createElement('div');pips.className='pips';section.append(pips);
      for(const p of r.stages){const c=document.createElement('canvas');c.width=c.height=36;c.setAttribute('role','img');c.setAttribute('aria-label',p.id+' '+p.state);c.getContext('2d').drawImage(iconImage(p.id,p.state),0,0);pips.append(c);}
      if(r.blocked)line(section,r.blocked);
    }
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
      paint(box.querySelector('.percentage'),numericImage(n+'%'),label);box.querySelector('b').style.width=n+'%';
    }
  }
  function status(text,state) {control('#connection',({online:'connected',file:'snapshot'})[state]||state,text,state==='offline'?'alert':'normal');}
  function legend() {
    const labels={'play':'Play','pause':'Pause','live-follow':'Follow live','speed':'Speed 30 / 120 / 600','clock':'Replay time','scrub-start':'History start','scrub-end':'Latest','world':'Map','calm':'Reduce motion and flashes','quests':'Quests','log':'Log','close':'Close','info':'Help','demo':'Simulated data','connected':'Connected','offline':'Disconnected','snapshot':'History snapshot','loading':'Loading','mana-claude':'Claude resources','mana-codex':'Codex resources','mana-gemini':'Gemini resources','heart':'Hero HP unavailable','mana':'Simulated mana, not a real quota','level':'Effect level from effort, not EXP','coin':'Completed quests','plan':'Plan','build':'Build','test':'Test','review':'Review','deploy':'Deploy','verify':'Verify results','chain':'Blocked or waiting for a dependency','sleep':'Rest','sword':'Attack from work activity','crit':'Critical attack effect','read':'Read','search':'Search','vision':'View image','write':'Write','memory':'Memory','message':'Message','delegate':'Delegate','commit':'Commit work','push':'Push work','merge':'Merge work','compress':'Compress context'};
    detail([], 'Icon help');const content=$('#quest .detail-content');
    for(const id of I.ids){const row=document.createElement('div');row.className='legend-row';content.append(row);
      const im=iconImage(id),c=document.createElement('canvas');c.width=im.width;c.height=im.height;c.setAttribute('aria-hidden','true');c.getContext('2d').drawImage(im,0,0);row.append(c);
      line(row,labels[id]||id);}
    line(content,'Token capacity is simulated: 100,000 tokens per wallet per replay epoch, not a real provider quota. Used tokens are the nonnegative net total after signed usage corrections; remaining mana is capped between 0% and 100%. Rest does not refill tokens.');
    line(content,'Character-based estimates approximate tokens from text length. Usage corrections adjust earlier totals using reported usage; a correction is not itself a character-based estimate.');
    line(content,'Monster bars show time remaining, not real HP.');bounds();
  }
  function init() {
    if(!T||!I)throw Error('Pixel UI dependencies unavailable');
    control('#world','world','Map');control('#calm','calm','Reduce effects');control('#quests','quests','Quests');control('#log','log','Log');
    control('#help','info','Help');control('#live','live-follow','Follow live');
    for(const id of ['camp','chron']){const b=$('#'+id+'-close');paint(b,iconImage('close'),'Close');b.onclick=()=>{$('#'+id).hidden=true;bounds();};}
    $('#help').onclick=legend;
    document.addEventListener('keydown',e=>{if(e.key==='Escape'){close();$('#camp').hidden=true;$('#chron').hidden=true;bounds();}});
    addEventListener('resize',resize);resize();
  }
  root.UIPanels={init,resize,bounds,clear,flush,screenIcon,screenNumber,control,number,resources,status,detail,close,privacy,drawer,feed,camps,plain,
    diagnostics:()=>({grid,epoch,reserved,drawn})};
})(window);
