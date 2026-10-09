/* Pixel-only visible UI; semantic controls and offscreen text remain accessible. MIT. */
(function(root) {
  'use strict';
  const $=s=>document.querySelector(s), T=root.UIText, I=root.UIGlyphs;
  const icons=new Map(), numbers=new Map();
  let epoch=0, reserved=[], grid=1, drawn=[];
  const overlay=$('#ui-stage'), ctx=overlay.getContext('2d');
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
  }
  function resize() {
    grid=Math.ceil(root.devicePixelRatio||1);overlay.width=innerWidth*grid;overlay.height=innerHeight*grid;
    const hud=$('#hud');document.documentElement.style.setProperty('--hud-height',hud.getBoundingClientRect().height+'px');bounds();
  }
  function clear() {for(const r of drawn)ctx.clearRect(r.left*grid,r.top*grid,(r.right-r.left)*grid,(r.bottom-r.top)*grid);drawn=[];}
  function fits(x,y,w,h) {const overlaps=r=>x<r.right&&x+w>r.left&&y<r.bottom&&y+h>r.top;
    return x>=0&&y>=0&&x+w<=innerWidth&&y+h<=innerHeight&&!reserved.some(overlaps)&&!drawn.some(overlaps);}
  function screenIcon(id,x,y,state='normal') {
    const im=iconImage(id,state);x=Math.round(x-im.width/2);y=Math.round(y-im.height/2);
    if(fits(x,y,im.width,im.height)){ctx.imageSmoothingEnabled=false;ctx.drawImage(im,x*grid,y*grid,im.width*grid,im.height*grid);drawn.push({left:x,top:y,right:x+im.width,bottom:y+im.height});}
  }
  function screenNumber(text,x,y,color) {
    const im=numericImage(text,color);x=Math.round(x-im.width/2);y=Math.round(y-im.height);
    for(let lane=0;lane<3;lane++){const top=y-lane*18;
      if(fits(x,top,im.width,im.height)){ctx.imageSmoothingEnabled=false;ctx.drawImage(im,x*grid,top*grid,im.width*grid,im.height*grid);drawn.push({left:x,top,right:x+im.width,bottom:top+im.height});break;}}
  }
  // Strip only formatting created by the game; never parse payload as HTML.
  function plain(value) {
    return String(value??'').replace(/<\/?(?:b|span)(?: class="who")?>/g,'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&')
      .replace(/[^\p{L}\p{M}\p{N}\p{P}\p{Zs}\n+<>=]/gu,'').trim();
  }
  async function line(parent,text) {
    text=plain(text);const token=epoch;
    const row=document.createElement('div');row.className='bitmap-row';
    const accessible=document.createElement('span');accessible.className='sr-only';accessible.textContent=text;
    row.append(accessible);parent.append(row);
    try {
      const value=await T.bitmap(text||'-',{maxWidth:Math.max(32,parent.clientWidth-(parent.classList.contains('legend-row')?68:24))});
      if(token!==epoch||!row.isConnected)return;
      for(const b of value.lines){const c=document.createElement('canvas');const d=Math.ceil(root.devicePixelRatio||1);
        c.width=b.width*d;c.height=b.height*d;c.style.width=b.width+'px';c.style.height=b.height+'px';c.setAttribute('aria-hidden','true');
        const g=c.getContext('2d');g.imageSmoothingEnabled=false;g.drawImage(b.canvas,0,0,c.width,c.height);row.append(c);}
    } catch(e) {
      if(token!==epoch||!row.isConnected)return;
      const c=document.createElement('canvas');c.width=c.height=36;I.draw(c.getContext('2d'),'offline',2,2,2,'alert');
      c.setAttribute('aria-hidden','true');row.append(c);accessible.textContent='Detail font unavailable';row.setAttribute('role','status');
    }
  }
  function close() {$('#quest').hidden=true;bounds();}
  function detail(lines,label='รายละเอียด') {
    const el=$('#quest');el.hidden=false;el.replaceChildren();el.setAttribute('aria-label',label);
    const button=document.createElement('button');button.className='close';button.setAttribute('aria-label','ปิด');
    button.append(iconImage('close').cloneNode(true)); // Canvas pixels do not clone; paint explicitly below.
    el.append(button);paint(button,iconImage('close'),'ปิด');button.onclick=close;
    const content=document.createElement('div');content.className='detail-content';el.append(content);
    for(const text of lines)line(content,text);bounds();button.focus();
  }
  function privacy() {
    epoch++;T.clearCache();numbers.clear();feedKey='';campKey='';close();$('#quest').replaceChildren();
    $('#feed').replaceChildren();$('#camps').replaceChildren();clear();
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
  function camps(rows) {
    if($('#camp').hidden)return;
    const key=JSON.stringify(rows);if(key===campKey)return;campKey=key;const el=$('#camps');el.replaceChildren();
    for(const r of rows.slice(0,8)) {
      const section=document.createElement('section');section.className='campaign';el.append(section);
      line(section,r.title);line(section,r.count);
      const pips=document.createElement('div');pips.className='pips';section.append(pips);
      for(const p of r.stages){const c=document.createElement('canvas');c.width=c.height=36;c.setAttribute('role','img');c.setAttribute('aria-label',p.id+' '+p.state);c.getContext('2d').drawImage(iconImage(p.id,p.state),0,0);pips.append(c);}
      if(r.blocked)line(section,r.blocked);
    }
  }
  function resources(values) {
    const el=$('#mana');
    if(!el.children.length)for(const [key,id,color] of [['claude','mana-claude','#4aa3ff'],['codex','mana-codex','#58c27a'],['agy','mana-gemini','#b07cff']]) {
      const box=document.createElement('div');box.dataset.wallet=key;const c=document.createElement('canvas');c.width=c.height=16;
      I.draw(c.getContext('2d'),id,0,0,1);c.setAttribute('aria-hidden','true');box.append(c);
      const n=document.createElement('span');n.className='percentage';box.append(n);const bar=document.createElement('i'),fill=document.createElement('b');fill.style.background=color;bar.append(fill);box.append(bar);el.append(box);
    }
    for(const box of el.children){const n=Math.max(0,Math.min(100,Math.round(values[box.dataset.wallet]??0)));
      paint(box.querySelector('.percentage'),numericImage(n+'%'),box.dataset.wallet+' simulated mana '+n+'%');box.querySelector('b').style.width=n+'%';}
  }
  function status(text,state) {control('#connection',({online:'connected',file:'snapshot'})[state]||state,text,state==='offline'?'alert':'normal');}
  function legend() {
    const labels={'play':'เล่น','pause':'หยุด','live-follow':'ติดตามสด','speed':'ความเร็ว 30 / 120 / 600','clock':'เวลา replay','scrub-start':'เริ่มประวัติ','scrub-end':'ล่าสุด','world':'แผนที่','calm':'ลดการสั่นและแสงกะพริบ','quests':'งาน','log':'บันทึก','close':'ปิด','info':'คำอธิบาย','demo':'ข้อมูลจำลอง','connected':'เชื่อมต่อแล้ว','offline':'ขาดการเชื่อมต่อ','snapshot':'ไฟล์ย้อนหลัง','loading':'กำลังโหลด','mana-claude':'ทรัพยากร Claude','mana-codex':'ทรัพยากร Codex','mana-gemini':'ทรัพยากร Gemini','heart':'ไม่มีข้อมูล HP ฮีโร่','mana':'mana จำลอง ไม่ใช่ quota จริง','level':'ระดับเอฟเฟกต์จาก effort ไม่ใช่ EXP','coin':'งานที่สำเร็จ','plan':'วางแผน','build':'สร้าง','test':'ทดสอบ','review':'รีวิว','deploy':'เผยแพร่','verify':'ตรวจผล','chain':'ติดขัดหรือรอ dependency','sleep':'พัก','sword':'การโจมตีจากการทำงาน','crit':'ผลการโจมตีสำคัญ','read':'อ่าน','search':'ค้นหา','vision':'ดูภาพ','write':'เขียน','memory':'ความจำ','message':'ข้อความ','delegate':'มอบหมาย','commit':'บันทึกงาน','push':'ส่งงาน','merge':'รวมงาน','compressed':'ย่อบริบท'};
    detail([], 'คำอธิบายไอคอน');const content=$('#quest .detail-content');
    for(const id of I.ids){const row=document.createElement('div');row.className='legend-row';content.append(row);
      const im=iconImage(id),c=document.createElement('canvas');c.width=im.width;c.height=im.height;c.setAttribute('aria-hidden','true');c.getContext('2d').drawImage(im,0,0);row.append(c);
      line(row,labels[id]||id);}
    line(content,'แถบมอนสเตอร์แสดงเวลาเหลือ ไม่ใช่ HP จริง');bounds();
  }
  function init() {
    if(!T||!I)throw Error('Pixel UI dependencies unavailable');
    control('#world','world','แผนที่');control('#calm','calm','ลดเอฟเฟกต์');control('#quests','quests','งาน');control('#log','log','บันทึก');
    control('#help','info','คำอธิบาย');control('#live','live-follow','ติดตามสด');
    for(const id of ['camp','chron']){const b=$('#'+id+'-close');paint(b,iconImage('close'),'ปิด');b.onclick=()=>{$('#'+id).hidden=true;bounds();};}
    $('#help').onclick=legend;
    document.addEventListener('keydown',e=>{if(e.key==='Escape'){close();$('#camp').hidden=true;$('#chron').hidden=true;bounds();}});
    addEventListener('resize',resize);resize();
  }
  root.UIPanels={init,resize,bounds,clear,screenIcon,screenNumber,control,number,resources,status,detail,close,privacy,drawer,feed,camps,plain,
    diagnostics:()=>({grid,epoch,reserved,drawn})};
})(window);
