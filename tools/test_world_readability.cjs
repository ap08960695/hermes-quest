'use strict';
// Synthetic World-first presentation; no real replay or native Desktop claims.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process'),{chromium,firefox}=require('playwright');
const root=path.resolve(__dirname,'..'),out=path.resolve(process.argv[2]||'.evidence/world-readability');
const digest=b=>crypto.createHash('sha256').update(b).digest('hex'),now=1700005000;
const demo=JSON.parse(fs.readFileSync(path.join(root,'data/demo.json')));
function fixture(){
  const d=structuredClone(demo);Object.assign(d.meta,{source:'live',mock:false,from_:now-600,to:now,as_of:now,show_titles:false,show_profile_names:true});
  d.bots.forEach((b,i)=>b.display_name=['Captain','Nova','Ember','Sage'][i%4]+' '+i);
  d.tasks=d.tasks.slice(0,3).map(t=>({...t,status:'running',created:now-200,started:now-120,completed:null}));
  d.events=d.tasks.flatMap((t,i)=>[{id:'create-'+i,t:now-200,kind:'created',task:t.id},{id:'claim-'+i,t:now-120,kind:'claimed',task:t.id,bot:t.bot},{id:'start-'+i,t:now-120,kind:'run_start',task:t.id,bot:t.bot}]).sort((a,b)=>a.t-b.t);
  d.sessions=[];d.session_data={status:'available'};
  d.working={as_of:now,resting_count:4,latest_order:{at:now-120,action_label:'Assigned quest',quest_label:'Build quest #1'},progress:{wins_today:4,xp:400,gold:40,level:5,level_progress:0},items:d.tasks.map((t,i)=>({ref:'synthetic-work-'+i,task_ref:t.id,bot_ref:t.bot,status:'running',started_at:now-120,display_name:d.bots.find(b=>b.id===t.bot).display_name,class_label:'Guild Worker',quest_kind:'build',quest_label:'Build quest #'+(i+1),worker_observed:true}))};return d;
}
const boot=JSON.parse(execFileSync(process.env.QUEST_PYTHON||'python3',['-c',"import json; from dashboard.desktop_transport import compose_bootstrap; print(json.dumps(compose_bootstrap('WorldReadabilityNonce1234')))"],{cwd:root,env:{...process.env,PYTHONPATH:root},encoding:'utf8'}));
for(const [file,hash] of Object.entries(boot.source))assert.equal(digest(fs.readFileSync(path.join(root,file))),hash,file);
const html=boot.html.replace('<script>','<script>window.__questTestGlobals=true;</script><script>'),served={};
const server=http.createServer((req,res)=>{try{
  const u=new URL(req.url,'http://localhost');
  if(u.pathname==='/sdk-guest'){res.setHeader('Content-Type','text/html');res.end(`<!doctype html><html><body style="margin:0"><script>
    const f=document.createElement('iframe');f.setAttribute('sandbox','allow-scripts');f.style='border:0;width:100vw;height:100vh';
    const connected=new Set();addEventListener('message',e=>{if(e.source!==f.contentWindow||e.data?.kind!=='quest-ready'||connected.has(e.data.nonce))return;
      connected.add(e.data.nonce);const c=new MessageChannel();c.port1.onmessage=async e=>{const m=e.data;try{const r=await fetch('/api/plugins/hermes-quest'+m.path);if(!r.ok)throw Error('request failed');c.port1.postMessage({id:m.id,value:await r.json()});}catch{c.port1.postMessage({id:m.id,error:'request failed'});}};
      f.contentWindow.postMessage({kind:'quest-connect',nonce:e.data.nonce},'*',[c.port2]);});
    f.src=${JSON.stringify('data:text/html;charset=utf-8,'+encodeURIComponent(html)+'?live=1')};document.body.append(f);
  </script></body></html>`);return;}
  if(u.pathname.endsWith('/replay')||u.pathname.endsWith('/data/demo.json')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(fixture()));return;}
  if(u.pathname.endsWith('/events')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({events:[],tasks:[],bots:[],working:fixture().working,meta:fixture().meta}));return;}
  if(u.pathname.endsWith('/desktop-asset')){const file=path.resolve(root,u.searchParams.get('path'));assert(file.startsWith(root+path.sep)&&file.endsWith('.png'));const b=fs.readFileSync(file);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({mime:'image/png',base64:b.toString('base64'),sha256:digest(b)}));return;}
  const name=u.pathname.replace('/api/plugins/hermes-quest/static/','/');
  const relative=name==='/'?'index.html':name.slice(1),file=path.resolve(root,relative);assert(file.startsWith(root+path.sep));const b=fs.readFileSync(file);served[relative]=digest(b);
  res.setHeader('Content-Type',({'.js':'text/javascript','.html':'text/html','.json':'application/json','.png':'image/png','.otf':'font/otf'})[path.extname(file)]||'application/octet-stream');res.end(b);
}catch{res.writeHead(404).end();}});
const overlap=(a,b)=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;
(async()=>{
  fs.mkdirSync(out,{recursive:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));const records=[];
  try{for(const [engine,type] of Object.entries({chromium,firefox})){
    const browser=require('./parity/browser_loader.cjs').enable(await type.launch({headless:true}));
    try{for(const [surface,width,height] of [['web',1440,900],['web',1024,768],['web',390,844],['sdk-guest',764,768]]){
      const page=await browser.newPage({viewport:{width,height}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
      await page.addInitScript(()=>window.__questTestGlobals=true);
      await page.goto('http://127.0.0.1:'+server.address().port+(surface==='web'?'/?live=1':'/sdk-guest'));
      const frame=surface==='web'?page:await(await page.waitForSelector('iframe')).contentFrame();
      await frame.waitForFunction(()=>window.__questTest?.S.work.has&&typeof loop.last==='number'&&window.NPCS?.state.ready).catch(async e=>{console.error(engine,surface,width,errors,await frame.evaluate(()=>({npc:window.NPCS?.state.ready,work:window.__questTest?.S.work.has,failure:document.querySelector('#failure')?.textContent})));throw e;});
      await frame.locator('#hint-dismiss').click();
      assert(await frame.evaluate(()=>workView.all),'fresh mount must be World');
      await frame.evaluate(d=>{cancelAnimationFrame(raf);clearTimeout(pollTimer);loadReplay(d,null,d.working.as_of);liveFeed=false;S.play=false;hudT=1;hud(0);resize();draw();},fixture());
      const sourceState=()=>frame.evaluate(()=>JSON.stringify({progress:S.work.progress(),items:S.work.items(),heroes:Object.values(S.heroes).map(h=>[h.bot,h.x,h.y,h.path]),tasks:Object.values(S.tasks).map(t=>[t.id,t.x,t.y,t.hp]),vault:S.vault,t:S.t}));
      const before=await sourceState(),npcSpawn=await frame.evaluate(()=>NPCS.state.list.map(n=>[n.x,n.y]));
      const capture=async name=>{await frame.evaluate(()=>{resize();draw();});await page.waitForTimeout(50);await frame.evaluate(()=>{draw();const c=document.querySelector('canvas'),d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let varied=0;for(let i=0;i<d.length;i+=400)if(d[i]>30||d[i+1]>40||d[i+2]>50)varied++;if(varied<100)throw Error('blank scene capture');});await page.screenshot({path:path.join(out,`${engine}-${surface}-${width}-${name}.png`)});};
      const check=async(name,fn)=>{try{const detail=await fn();records.push({engine,surface,width,name,pass:true,...detail});}catch(e){records.push({engine,surface,width,name,pass:false,error:e.message});}};
      await check('World decorative labels avoid real bodies, time bars and panels',async()=>{
        const r=await frame.evaluate(()=>{const labels=[],old=UI.screenLabel;UI.screenLabel=(...a)=>{const n=UI.diagnostics().drawn.length;old(...a);if(a[6]&&UI.diagnostics().drawn.length>n)labels.push({text:a[0],box:UI.diagnostics().drawn.at(-1)});};draw();UI.screenLabel=old;return {labels,...UI.diagnostics(),picks:inspect.picks.length};});
        assert(r.picks>0,'real actors are painted');
        assert(await frame.evaluate(()=>Object.values(S.tasks).some(t=>t.alpha>0&&t.state==='fight')),'fixture must paint actual running quests, not just idle heroes');
        for(const l of r.labels){assert(![...r.protectedScene,...r.reserved].some(b=>overlap(l.box,b)),l.text+' overlaps protected data');assert(l.box.left>=0&&l.box.right<=width&&l.box.top>=0&&l.box.bottom<=height);}
        for(let i=0;i<r.drawn.length;i++)assert(!r.drawn.slice(i+1).some(b=>overlap(r.drawn[i],b)),'overlay collision');
        await capture('fresh-world');return r;
      });
      await check('decorative priority suppresses collisions but keeps real labels',async()=>{
        const r=await frame.evaluate(()=>{UI.clear();UI.protectScene({left:120,top:180,right:280,bottom:230});UI.screenLabel('VILLAGER',200,220,false,280,'#b8d9d1',true);const suppressed=UI.diagnostics().drawn.length;
          UI.screenLabel('HERO',200,220);const real=UI.diagnostics().drawn.length;UI.screenLabel('REGION',200,220,false,280,'#b8d9d1',true);return {suppressed,real,final:UI.diagnostics().drawn.length};});
        assert.equal(r.suppressed,0);assert.equal(r.real,1);assert.equal(r.final,1);return r;
      });
      await check('mobile scroll cue is visible before scrolling and rewards remain reachable',async()=>{
        await frame.locator('#working-panel').evaluate(e=>e.scrollTop=0);
        if(width===390){const r=await frame.locator('#working-scroll-hint').evaluate(e=>{const b=e.getBoundingClientRect(),p=e.parentElement.getBoundingClientRect();return {text:e.textContent,top:b.top,bottom:b.bottom,pTop:p.top,pBottom:p.bottom};});assert(r.text.includes('gold')&&r.text.includes('XP')&&r.text.includes('instructions'));assert(r.top>=r.pTop&&r.bottom<=r.pBottom);}
        await frame.locator('#working-rewards').evaluate(e=>e.scrollIntoView({block:'center'}));const gold=await frame.locator('#working-rewards').innerText();assert(gold.includes('400 Guild XP')&&gold.includes('40 game gold'));
        await capture('gold-scrolled');await frame.locator('#working-panel').evaluate(e=>e.scrollTop=0);return {gold};
      });
      await check('actual Working toggle keeps paths, rewards and playhead unchanged',async()=>{
        await frame.locator('#working-toggle').click();assert.equal(await frame.evaluate(()=>workView.all),false);await capture('working');
        await frame.locator('#working-toggle').click();assert.equal(await sourceState(),before);return {};
      });
      await check('Working quest labels are complete and avoid every sprite and label',async()=>{
        await frame.locator('#working-toggle').click();
        const r=await frame.evaluate(()=>{const labels=[],old=UI.screenLabel;UI.screenLabel=(...a)=>{const n=UI.diagnostics().drawn.length;old(...a);if(UI.diagnostics().drawn.length>n)labels.push({text:a[0],anchor:[a[1],a[2]],box:UI.diagnostics().drawn.at(-1)});};draw();UI.screenLabel=old;return {labels,...UI.diagnostics(),pairs:workView.pairs.length,picks:inspect.picks.length};});
        // The existing phone contract focuses one pair; desktop/SDK show three.
        const expected=width<=760?1:3;assert.equal(r.pairs,expected);assert.equal(r.picks,expected*2,'every visible worker/quest pair still painted');
        for(let i=1;i<=expected;i++)assert(r.labels.some(l=>l.text.toUpperCase()==='BUILD QUEST #'+i),'complete quest '+i);
        for(const l of r.labels){assert(!r.protectedScene.some(b=>overlap(l.box,b)),l.text+' overlaps sprite');assert(Math.abs(l.box.bottom-l.anchor[1])<=80,l.text+' moved far from its pair');}
        for(let i=0;i<r.drawn.length;i++)assert(!r.drawn.slice(i+1).some(b=>overlap(r.drawn[i],b)),'Working label collision');
        if(width<=1100)assert(!r.labels.some(l=>l.text.startsWith('Hero · ')),'one identification label per pair in narrow scene');
        await capture('working-labels');await frame.locator('#working-toggle').click();assert.equal(await sourceState(),before);return r;
      });
      await check('painted villagers stay separated over 60 seconds without changing walkers',async()=>{
        const r=await frame.evaluate(()=>{let paintedMin=8,paintedMax=0,collisions=0,shadows=0;const snapshots=[];
          for(let i=0;i<=3600;i++){const before=JSON.stringify(NPCS.state.list),es=NPCS.ents({Z:cam.zi*DPR},()=>{},()=>shadows++);if(i%60===0)snapshots.push(es.map(e=>[e.x,e.y,e.box]));
            if(JSON.stringify(NPCS.state.list)!==before)throw Error('painting mutates walkers');paintedMin=Math.min(paintedMin,es.length);paintedMax=Math.max(paintedMax,es.length);
            for(let a=0;a<es.length;a++)for(const b of es.slice(a+1)){const x=es[a].box,y=b.box;if(x.left<y.right&&x.right>y.left&&x.top<y.bottom&&x.bottom>y.top)collisions++;}es.forEach(e=>e.f());if(i<3600)NPCS.update(1/60);}
          return {paintedMin,paintedMax,collisions,shadows,count:NPCS.state.list.length,snapshots,guide:document.querySelector('#working-guide').textContent};});
        assert.equal(r.count,8,'all decorative walkers retained');assert(r.paintedMin>=1);assert.equal(r.collisions,0);assert.equal(r.shadows,0);assert(r.guide.includes('Faded villagers are scenery and cannot be selected'));
        assert.equal(await sourceState(),before);await capture('separated-npc-60s');return r;
      });
      await check('decorative villagers stay outside standing yard through 60 simulated seconds',async()=>{
        const r=await frame.evaluate(spawn=>{const p=W.regions[NPCS.state.town].plaza;let intrusion=0;for(let i=0;i<3600;i++){NPCS.update(1/60);for(const n of NPCS.state.list)if(((n.x-p.center[0])/p.standing[0])**2+((n.y-p.center[1])/p.standing[1])**2<1)intrusion++;}return {spawn,intrusion,count:NPCS.state.list.length};},npcSpawn);
        assert.equal(r.count,8);assert.equal(r.intrusion,0);for(let i=0;i<r.spawn.length;i++)for(const b of r.spawn.slice(i+1))assert(Math.hypot(r.spawn[i][0]-b[0],r.spawn[i][1]-b[1])>=20);assert.equal(await sourceState(),before);await capture('npc-60s');return r;
      });
      await check('Follow, Reduce effects and real data survive presentation actions',async()=>{
        await frame.locator('#working-choose').click();await capture('chooser');await frame.locator('#character-content button').first().click();
        const r=await frame.evaluate(()=>{resize();draw();const p=inspect.picks.find(p=>p.type==='hero'&&p.id===inspect.bot),c=document.querySelector('#character-card').getBoundingClientRect(),b=document.querySelector('#focus-bar').getBoundingClientRect(),separate=r=>Math.max(r.left-p.body.right,p.body.left-r.right,r.top-p.body.bottom,p.body.top-r.bottom);return {following:inspect.follow,clearance:Math.min(p.body.left,innerWidth-p.body.right,p.body.top,innerHeight-p.body.bottom,separate(c),separate(b))};});
        assert(r.following);assert(r.clearance>=8);await capture('follow');await frame.locator('#character-close').click();
        await frame.locator('#menu-toggle').click();await frame.locator('#group-settings summary').click();await frame.locator('#calm').click();assert.equal(await frame.evaluate(()=>calm),true);await capture('reduce-effects');await frame.locator('#menu-toggle').click();assert.equal(await sourceState(),before);assert.deepEqual(errors,[]);return r;
      });await page.close();
    }}finally{await browser.close();}
  }}finally{server.close();}
  for(const [file,hash] of Object.entries(served))assert.equal(digest(fs.readFileSync(path.join(root,file))),hash,file);
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({synthetic_only:true,records},null,2));fs.writeFileSync(path.join(out,'source-sha256.json'),JSON.stringify({bootstrap:boot.source,served},null,2));
  console.log(JSON.stringify({cases:records.length,failed:records.filter(r=>!r.pass)},null,2));if(records.some(r=>!r.pass))process.exitCode=1;
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
