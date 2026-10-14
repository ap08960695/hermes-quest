'use strict';
// Synthetic visit/UI fixtures plus the real opaque-origin Desktop bootstrap/bridge.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process'),{chromium,firefox}=require('playwright');
const root=path.resolve(__dirname,'..'),out=path.resolve(process.argv[2]||'.evidence/idle');
const demo=JSON.parse(fs.readFileSync(path.join(root,'data/demo.json'))),now=Math.floor(Date.now()/1000);
const digest=b=>crypto.createHash('sha256').update(b).digest('hex'),id=n=>'e_'+digest('idle-event-'+n);
let returning=false;
function fixture(known=true,level=5){
  const d=structuredClone(demo);Object.assign(d.meta,{source:'live',from_:now-600,to:now,as_of:now,show_titles:false,show_profile_names:false});
  d.cursor='synthetic-idle';d.sessions=[];d.session_data={status:'available'};
  d.events=[{id:id(1),recap_id:id(1),t:now-300,kind:'created'},{id:id(2),recap_id:id(2),t:now-200,kind:'completed'},...(returning?[{id:id(3),recap_id:id(3),t:now-100,kind:'blocked'}]:[])];
  d.working={as_of:now,resting_count:2,latest_order:null,progress:{wins_today:4,xp:(level-1)*100,gold:40,level,level_progress:0,...(known?{done_days_7d:3}:{})},
    items:d.tasks.slice(0,3).map((t,i)=>({ref:'synthetic-work-'+i,task_ref:t.id,bot_ref:d.bots[i%d.bots.length].id,status:i?'done':'running',
      started_at:now-60,display_name:'Build Warrior '+(i+1),class_label:'Build Warrior',quest_kind:['build','testing','review'][i],quest_label:'Build quest #'+(i+1),worker_observed:true}))};
  return d;
}
const boot=JSON.parse(execFileSync(process.env.QUEST_PYTHON||'python3',['-c',"import json; from dashboard.desktop_transport import compose_bootstrap; print(json.dumps(compose_bootstrap('IdleIntegrationNonce123456')))"],{cwd:root,env:{...process.env,PYTHONPATH:root},encoding:'utf8'}));
for(const [file,hash] of Object.entries(boot.source))assert.equal(digest(fs.readFileSync(path.join(root,file))),hash,file);
const instrumentation=`<script>window.__questTestGlobals=true;window.barText=[];let text;Object.defineProperty(window,'UIText',{get:()=>text,set:v=>{text={...v,draw(ctx,t,...a){if(ctx.canvas.id==='stage')barText.push(String(t));return v.draw(ctx,t,...a);}};}});</script>`;
const html=boot.html.replace('<script>',instrumentation+'<script>');
const mime={'.js':'text/javascript','.json':'application/json','.png':'image/png','.html':'text/html','.otf':'font/otf'};
const server=http.createServer((req,res)=>{try{
  const u=new URL(req.url,'http://localhost');
  if(u.pathname==='/desktop-harness'){
    res.setHeader('Content-Type','text/html');res.end(`<!doctype html><html><body style="margin:0"><script>
      const frame=document.createElement('iframe');frame.setAttribute('sandbox','allow-scripts');frame.style='border:0;width:100vw;height:100vh';
      const connected=new Set();addEventListener('message',e=>{if(e.source!==frame.contentWindow||e.data?.kind!=='quest-ready'||connected.has(e.data.nonce))return;
        connected.add(e.data.nonce);const c=new MessageChannel();c.port1.onmessage=async e=>{const m=e.data;try{const r=await fetch('/api/plugins/hermes-quest'+m.path);if(!r.ok)throw Error('request failed');c.port1.postMessage({id:m.id,value:await r.json()});}catch{c.port1.postMessage({id:m.id,error:'request failed'});}};
        frame.contentWindow.postMessage({kind:'quest-connect',nonce:e.data.nonce},'*',[c.port2]);});
      frame.src='data:text/html;base64,${Buffer.from(html).toString('base64')}';document.body.append(frame);
    </script></body></html>`);return;
  }
  if(u.pathname.endsWith('/replay')||u.pathname.endsWith('/data/demo.json')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(fixture()));return;}
  if(u.pathname.endsWith('/events')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({cursor:'synthetic-idle-poll',events:[],tasks:[],bots:[],working:fixture().working,meta:fixture().meta}));return;}
  if(u.pathname.endsWith('/desktop-asset')){const file=path.resolve(root,u.searchParams.get('path'));assert(file.startsWith(root+path.sep)&&file.endsWith('.png'));const b=fs.readFileSync(file);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({mime:'image/png',base64:b.toString('base64'),sha256:digest(b)}));return;}
  const name=u.pathname.replace('/api/plugins/hermes-quest/static/','/');
  const file=path.resolve(root,name==='/'?'index.html':name.slice(1));assert(file.startsWith(root+path.sep));res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));
}catch(e){res.writeHead(404).end();}});
(async()=>{
  fs.mkdirSync(out,{recursive:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));const records=[];
  try{for(const [engine,type] of Object.entries({chromium,firefox})){
    if(process.env.QUEST_IDLE_ENGINE&&engine!==process.env.QUEST_IDLE_ENGINE)continue;
    const browser=require('./parity/browser_loader.cjs').enable(await type.launch({headless:true}));
    try{for(const surface of ['web','desktop'])for(const [width,height] of [[1440,900],[390,844]]){
      if(process.env.QUEST_IDLE_SURFACE&&surface!==process.env.QUEST_IDLE_SURFACE)continue;
      returning=false;const page=await browser.newPage({viewport:{width,height}}),errors=[];
      page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(()=>window.__questTestGlobals=true);
      if(surface==='web')await page.addInitScript({content:instrumentation.slice('<script>'.length,-'</script>'.length)});
      await page.goto('http://127.0.0.1:'+server.address().port+(surface==='desktop'?'/desktop-harness':'/'));
      const frame=surface==='desktop'?await (await page.waitForSelector('iframe')).contentFrame():page;
      await frame.waitForFunction(()=>window.__questTest?.S.work.has&&document.querySelector('#idle-recap').onclick).catch(async e=>{console.error(engine,surface,width,errors,await frame.evaluate(()=>({global:!!window.__questTest,flag:window.__questTestGlobals,fail:document.querySelector('#failure')?.textContent,body:document.body.textContent.slice(-500)})));throw e;});
      const freeze=()=>frame.evaluate(()=>{cancelAnimationFrame(raf);clearTimeout(pollTimer);S.play=false;S.t=S.work.asOf;hudT=1;hud(0);resize();draw();});
      await freeze();await frame.locator('#hint-dismiss').click();
      const capture=async name=>{
        await frame.evaluate(()=>{resize();draw();});const geometry=await frame.evaluate(()=>{
          const c=document.querySelector('#stage'),d=c.getContext('2d').getImageData(0,0,c.width,c.height).data,colours=new Set();for(let i=0;i<d.length;i+=256)colours.add(d.slice(i,i+4).join());
          return {colours:colours.size,overflow:document.documentElement.scrollWidth>innerWidth,menu:document.querySelector('#menu-toggle').getBoundingClientRect().toJSON(),help:document.querySelector('#quick-help').getBoundingClientRect().toJSON()};});
        assert(geometry.colours>2&&!geometry.overflow,'Nonblank world, no page overflow');
        await page.screenshot({path:path.join(out,`${engine}-${surface}-${width}-${name}.png`)});return geometry;
      };
      const check=async(name,fn)=>{try{const detail=await fn();records.push({engine,surface,width,height,name,pass:true,...detail});}catch(e){records.push({engine,surface,width,height,name,pass:false,error:e.message});}};
      await check('fresh mount is World; Working toggle preserves replay and board progress',async()=>{
        assert.equal(await frame.evaluate(()=>workView.all),true);
        assert.equal(await frame.locator('#working-toggle').getAttribute('aria-pressed'),'true');
        assert(await frame.locator('#working-panel').isVisible());
        assert(await frame.locator('#working-guild').isVisible());
        assert(await frame.locator('#idle-recap').isVisible());
        const state=()=>frame.evaluate(()=>({t:S.t,speed:S.speed,play:S.play,following,progress:S.work.progress()}));
        const before=await state();
        await frame.locator('#working-toggle').click();
        assert.equal(await frame.evaluate(()=>workView.all),false);
        assert.equal(await frame.locator('#working-toggle').getAttribute('aria-pressed'),'false');
        await frame.locator('#working-toggle').click();
        assert.equal(await frame.evaluate(()=>workView.all),true);
        assert.deepEqual(await state(),before);
        return {geometry:await capture('default-world')};
      });
      await check('visit unknown, explicit acknowledgement only, reload coverage',async()=>{
        assert((await frame.locator('#idle-recap').textContent()).includes('unknown'));
        if(surface==='web'){
          assert.equal(await frame.evaluate(()=>localStorage.getItem(QuestIdleRecap.STORAGE_KEY)),null);
          await frame.evaluate(()=>{document.querySelector('#scrub').value=500;document.querySelector('#scrub').dispatchEvent(new Event('input'));});
          assert.equal(await frame.evaluate(()=>localStorage.getItem(QuestIdleRecap.STORAGE_KEY)),null,'scrub never acknowledges');
        }
        await frame.locator('#idle-recap').click();let text=await frame.locator('#quest').textContent();assert(text.includes('unknown'));
        if(surface==='desktop')assert(text.includes("Away summary isn't available"));
        await capture('recap-unknown');await frame.locator('#quest .close').click();
        if(surface==='web'){
          const seen=await frame.evaluate(()=>JSON.parse(localStorage.getItem(QuestIdleRecap.STORAGE_KEY)));assert.deepEqual(seen,[id(1),id(2)]);
          returning=true;await page.reload();await frame.waitForFunction(()=>window.__questTest?.S.work.has);await freeze();
          await frame.locator('#idle-recap').click();text=await frame.locator('#quest').textContent();assert(text.includes('0 completed, 1 blocked, 0 failed'),text+' '+JSON.stringify(await frame.evaluate(()=>({meta:D.meta,events:D.events,seen:localStorage.getItem(QuestIdleRecap.STORAGE_KEY)}))));
          await capture('recap-return');await frame.locator('#quest .close').click();
        }
        return {text};
      });
      await check('board trophies, weekly known/unknown, tokens removed on reopen',async()=>{
        await freeze();await frame.locator('#working-guild').click();let text=await frame.locator('#quest').textContent();
        for(const s of ['Reached on this board','Guild Veteran','Testing stage token','Review stage token','3 of last 7 days'])assert(text.includes(s),s);
        assert(!/permanent|forever/.test(text));await capture('guild-known');await frame.locator('#quest .close').click();
        const d=fixture(false,1);d.working.items.forEach(i=>i.status='running');
        await frame.evaluate(d=>{loadReplay(d,null,d.working.as_of);S.play=false;hudT=1;hud(0);draw();},d);
        await frame.locator('#working-guild').click();text=await frame.locator('#quest').textContent();assert(text.includes('last 7 days: unknown')&&text.includes('Not reached yet'));
        assert(!text.includes('Testing stage token')&&text.includes('No stage tokens'));await capture('guild-unknown');await frame.locator('#quest .close').click();return {text};
      });
      await check('Guildhall tiers draw without world mutations or blocking Menu/Help',async()=>{
        const d=fixture(true,10);await frame.evaluate(d=>{loadReplay(d,null,d.working.as_of);S.play=false;hudT=1;hud(0);if(!workView.all)document.querySelector('#working-toggle').click();const a=QuestIdleCity.findAnchor(W.props);Object.assign(cam,{x:a.x,y:a.y,tx:a.x,ty:a.y,zi:1});resize();draw();},d);
        const props=await frame.evaluate(()=>JSON.stringify(W.props));await capture('guildhall-tier3');
        assert.equal(await frame.evaluate(()=>JSON.stringify(W.props)),props);
        await frame.locator('#menu-toggle').click();assert(await frame.locator('#menu').isVisible());await frame.locator('#menu-toggle').click();
        await frame.locator('#quick-help').click();assert(await frame.locator('#quest').isVisible());await frame.locator('#quest .close').click();
      });
      await check('countdown unit readable in the same Web/Desktop renderer',async()=>{
        const d=structuredClone(demo);delete d.working;
        await frame.evaluate(d=>{loadReplay(d);cancelAnimationFrame(raf);S.play=false;document.querySelector('#working-panel').hidden=true;
          for(const x of D.tasks)task(x.id).alpha=0;const t=task(D.tasks[0].id);Object.assign(t,{state:'fight',runStart:S.t-300,max_rt:1800,hp:.83,alpha:1,region:'forge',emerge:0,dying:false,x:700,y:500,mx:700,my:500,mpath:null});
          selectedScene=t.id;Object.assign(cam,{x:700,y:500,tx:700,ty:500,zi:2});barText=[];resize();draw();},d);
        const labels=await frame.evaluate(()=>barText);assert(labels.includes('EST. TIME LEFT 25 MIN'),JSON.stringify(labels));await capture('time-left');
      });
      await check('no uncaught errors',async()=>assert.deepEqual(errors,[]));await page.close();
    }}finally{await browser.close();}
  }}finally{server.close();}
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({source:boot.source,synthetic_only:true,records},null,2));
  for(const r of records)console.log(`${r.pass?'PASS':'FAIL'} ${r.engine} ${r.surface} ${r.width} ${r.name}${r.error?' :: '+r.error:''}`);
  if(records.some(r=>!r.pass))process.exitCode=1;
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
