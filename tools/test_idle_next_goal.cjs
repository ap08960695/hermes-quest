'use strict';
// Synthetic board snapshots. Exercise the real Web and opaque-origin SDK guest UI.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process'),{chromium,firefox}=require('playwright');
const root=path.resolve(__dirname,'..'),out=path.resolve(process.argv[2]||'.evidence/next-goal');
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const demo=JSON.parse(fs.readFileSync(path.join(root,'data/demo.json'))),now=1700005000;
function fixture(level=5){
  const d=structuredClone(demo);d.events=[];d.sessions=[];
  Object.assign(d.meta,{source:'live',from_:now-600,to:now,as_of:now,show_titles:false,show_profile_names:false});
  d.working={as_of:now,resting_count:2,latest_order:null,progress:{wins_today:4,xp:Math.max(0,level-1)*100,gold:40,level,level_progress:0},
    items:d.tasks.slice(0,1).map((t,i)=>({ref:'synthetic-goal-'+i,task_ref:t.id,bot_ref:d.bots[i].id,status:'running',started_at:now-60,display_name:'Build Warrior 1',class_label:'Build Warrior',quest_kind:'build',quest_label:'Build quest #1',worker_observed:true}))};
  return d;
}
const boot=JSON.parse(execFileSync(process.env.QUEST_PYTHON||'python3',['-c',"import json; from dashboard.desktop_transport import compose_bootstrap; print(json.dumps(compose_bootstrap('NextGuildGoalNonce123456')))"],{cwd:root,env:{...process.env,PYTHONPATH:root},encoding:'utf8'}));
for(const [file,hash] of Object.entries(boot.source))assert.equal(digest(fs.readFileSync(path.join(root,file))),hash,file);
const html=boot.html.replace('<script>','<script>window.__questTestGlobals=true;</script><script>');
const served={};
const server=http.createServer((req,res)=>{try{
  const u=new URL(req.url,'http://localhost');
  if(u.pathname==='/sdk-guest'){
    res.setHeader('Content-Type','text/html');res.end(`<!doctype html><html><body style="margin:0"><script>
      const frame=document.createElement('iframe');frame.setAttribute('sandbox','allow-scripts');frame.style='border:0;width:100vw;height:100vh';
      const connected=new Set();addEventListener('message',e=>{if(e.source!==frame.contentWindow||e.data?.kind!=='quest-ready'||connected.has(e.data.nonce))return;
        connected.add(e.data.nonce);const c=new MessageChannel();c.port1.onmessage=async e=>{const m=e.data;try{const r=await fetch('/api/plugins/hermes-quest'+m.path);if(!r.ok)throw Error('request failed');c.port1.postMessage({id:m.id,value:await r.json()});}catch{c.port1.postMessage({id:m.id,error:'request failed'});}};
        frame.contentWindow.postMessage({kind:'quest-connect',nonce:e.data.nonce},'*',[c.port2]);});
      frame.src='data:text/html;base64,${Buffer.from(html).toString('base64')}';document.body.append(frame);
    </script></body></html>`);return;
  }
  if(u.pathname.endsWith('/replay')||u.pathname.endsWith('/data/demo.json')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(fixture()));return;}
  if(u.pathname.endsWith('/events')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({events:[],tasks:[],bots:[],working:fixture().working,meta:fixture().meta}));return;}
  if(u.pathname.endsWith('/desktop-asset')){const file=path.resolve(root,u.searchParams.get('path'));assert(file.startsWith(root+path.sep)&&file.endsWith('.png'));const b=fs.readFileSync(file);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({mime:'image/png',base64:b.toString('base64'),sha256:digest(b)}));return;}
  const name=u.pathname.replace('/api/plugins/hermes-quest/static/','/');
  const relative=name==='/'?'index.html':name.slice(1),file=path.resolve(root,relative);assert(file.startsWith(root+path.sep));const b=fs.readFileSync(file);served[relative]=digest(b);
  res.setHeader('Content-Type',({'.js':'text/javascript','.html':'text/html','.json':'application/json','.png':'image/png','.otf':'font/otf'})[path.extname(file)]||'application/octet-stream');res.end(b);
}catch{res.writeHead(404).end();}});
(async()=>{
  fs.mkdirSync(out,{recursive:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));const records=[];
  try{for(const [engine,type] of Object.entries({chromium,firefox})){
    const browser=require('./parity/browser_loader.cjs').enable(await type.launch({headless:true}));
    try{for(const surface of ['web','sdk-guest'])for(const [width,height] of [[1440,900],[390,844]]){
      const page=await browser.newPage({viewport:{width,height}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
      await page.addInitScript(()=>window.__questTestGlobals=true);
      await page.goto('http://127.0.0.1:'+server.address().port+(surface==='web'?'/':'/sdk-guest'));
      const frame=surface==='web'?page:await(await page.waitForSelector('iframe')).contentFrame();
      await frame.waitForFunction(()=>window.__questTest?.S.work.has&&document.querySelector('#working-guild').onclick).catch(async e=>{console.error(engine,surface,width,errors,await frame.evaluate(()=>({test:!!window.__questTest,flag:window.__questTestGlobals,failure:document.querySelector('#failure')?.textContent,body:document.body.textContent.slice(-600)})));throw e;});
      await frame.evaluate(()=>{cancelAnimationFrame(raf);clearTimeout(pollTimer);S.play=false;liveFeed=false;following=false;document.querySelector('#hint-dismiss').click();});
      const load=d=>frame.evaluate(d=>{UIPanels.close();UIPanels.menu(false);loadReplay(d,null,d.working?.as_of??d.meta.to);S.play=false;workView.all=false;workView.key='';hudT=1;hud(0);resize();draw();},d);
      const check=async(name,fn)=>{try{const detail=await fn();records.push({engine,surface,width,height,name,pass:true,...detail});}catch(e){records.push({engine,surface,width,height,name,pass:false,error:e.message});}};
      const snapshot=()=>frame.evaluate(()=>JSON.stringify({progress:S.work.progress(),items:S.work.items(),props:W.props,vault:S.vault,fx:S.fx}));
      // Fixed expected thresholds are independent of the implementation's next_level.
      for(const [level,target] of [[0,1],[1,5],[4,5],[5,10],[9,10],[10,null]])await check('board level '+level,async()=>{
        await load(fixture(level));const before=await snapshot();
        const expected=(target===null?'Guildhall tiers complete':'Next Guildhall tier · Level '+target)+' · on this board';
        assert.equal(await frame.locator('#working-guild').textContent(),expected);
        assert(await frame.locator('#working-guild').isVisible());assert(await frame.locator('#quest').isHidden());assert(await frame.locator('#menu').isHidden());
        assert((await frame.locator('#working-rewards').textContent()).includes('Guild level '+level));
        const geometry=await frame.locator('#working-guild').evaluate(el=>{const b=el.getBoundingClientRect(),p=document.querySelector('#working-panel').getBoundingClientRect();return {left:b.left,right:b.right,top:b.top,bottom:b.bottom,pTop:p.top,pBottom:p.bottom,pRight:p.right};});
        assert(geometry.left>=0&&geometry.right<=width&&geometry.bottom<=height&&geometry.top>=geometry.pTop&&geometry.bottom<=geometry.pBottom,'goal is visible without panel scrolling');
        const children=await frame.locator('#working-panel').evaluate(el=>[...el.children].map(e=>e.id));assert.equal(children.filter(id=>id==='working-guild').length,1);
        await frame.evaluate(()=>{S.t+=60;hudT=1;hud(0);resize();draw();});assert.equal(await snapshot(),before,'render/elapsed time changes no progress, rewards or world');
        assert.equal(await frame.locator('#working-guild').textContent(),expected);
        if(engine==='chromium'&&level===5){const colours=await frame.evaluate(()=>{const c=document.querySelector('#stage'),p=c.getContext('2d').getImageData(0,0,c.width,c.height).data,s=new Set();for(let i=0;i<p.length;i+=256)s.add(p.slice(i,i+4).join());return s.size;});assert(colours>2);await page.screenshot({path:path.join(out,`${engine}-${surface}-${width}-next-tier.png`)});}
        await frame.locator('#working-guild').focus();await page.keyboard.press('Enter');assert(await frame.locator('#quest').isVisible());
        const text=await frame.locator('#quest').textContent();assert(text.includes('Guildhall')&&text.includes('Stage tokens'));
        if(width===390){const b=await frame.locator('#quest').boundingBox();assert(b.y>height/2&&b.height<=height*.38+1);}
        await frame.locator('#quest .close').click();assert(await frame.locator('#quest').isHidden());assert.equal(await snapshot(),before);
        return {text:expected,geometry};
      });
      await check('unknown and malformed presentation inputs never guess a tier',async()=>{
        await load(fixture());
        // The reducer may have a valid event projection. Test absence at the UI boundary
        // separately, without changing the read-only reducer's existing contract.
        for(const level of [null,undefined,'5',-1,1.5]){
          const result=await frame.evaluate(level=>{const original=S.work.progress;try{S.work.progress=()=>({xp:0,level,career_xp:900});hudT=1;hud(0);return document.querySelector('#working-guild').textContent;}finally{S.work.progress=original;}},level);
          assert.equal(result,'Next Guildhall tier · unknown · on this board');
        }
      });
      await check('no Working snapshot hides main panel rather than guessing',async()=>{
        const d=fixture();delete d.working;await load(d);assert(await frame.locator('#working-panel').isHidden());
        await frame.locator('#menu-toggle').click();await frame.evaluate(()=>document.querySelector('#group-world').open=true);
        assert((await frame.locator('#guild-summary').textContent()).includes('Next Guildhall tier · unknown'));await frame.locator('#menu-toggle').click();
      });
      await check('backend level decrease and increase replace stale goals',async()=>{
        await load(fixture(10));await load(fixture(4));assert.equal(await frame.locator('#working-guild').textContent(),'Next Guildhall tier · Level 5 · on this board');
        await frame.evaluate(d=>{mergeDelta({events:[],tasks:[],bots:[],cursor:null,working:{...d.working,as_of:d.working.as_of+1}});hudT=1;hud(0);},fixture(5));
        assert.equal(await frame.locator('#working-guild').textContent(),'Next Guildhall tier · Level 10 · on this board');
      });
      await check('privacy gate refuses goal details and page geometry',async()=>{
        await load(fixture());assert.deepEqual(errors,[]);
        assert.equal(await frame.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
        await frame.evaluate(()=>{privacyPending=true;});await frame.locator('#working-guild').click();assert(await frame.locator('#quest').isHidden());
      });await page.close();
    }}finally{await browser.close();}
  }}finally{server.close();}
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({synthetic_only:true,records},null,2));
  fs.writeFileSync(path.join(out,'source-sha256.json'),JSON.stringify({bootstrap:boot.source,served},null,2));
  for(const r of records)console.log(`${r.pass?'PASS':'FAIL'} ${r.engine} ${r.surface} ${r.width} ${r.name}${r.error?' :: '+r.error:''}`);
  if(records.some(r=>!r.pass))process.exitCode=1;
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
