'use strict';
// Public synthetic fixtures only. Exercises the real live transport and Working reducer.
// FOLLOWUP_ROOT=<checkout> FOLLOWUP_BEFORE=1 captures the two baseline failures.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process'),{chromium,firefox}=require('playwright');
const root=path.resolve(process.env.FOLLOWUP_ROOT||path.join(__dirname,'..'));
const out=path.resolve(process.argv[2]||'.evidence/web-followup'),before=process.env.FOLLOWUP_BEFORE==='1';
const demo=JSON.parse(fs.readFileSync(path.join(root,'data/demo.json'))),now=Math.floor(Date.now()/1000);
function fixture(names=false){
  const d=structuredClone(demo);d.events=[];d.sessions=[];d.cursor='synthetic-followup';d.state='online';
  Object.assign(d.meta,{source:'live',from_:now-600,to:now,as_of:now,show_titles:false,show_profile_names:names});
  d.tasks=d.tasks.slice(0,3);d.tasks.forEach(t=>t.title='PRIVATE_TITLE_CANARY');
  d.bots.forEach((b,i)=>{b.display_name=names?'Nova '+(i+1):'Research Mage '+(i+1);});
  d.working={as_of:now,items:d.tasks.map((t,i)=>({ref:'synthetic-work-'+i,task_ref:t.id,bot_ref:d.bots[0].id,status:'running',started_at:now-30,
    display_name:names?'Nova 1':'Research Mage 1',class_label:'Research Mage',quest_kind:'build',quest_label:'Build quest #'+(i+1),worker_observed:true})),
    resting_count:0,latest_order:null,progress:{wins_today:0,xp:0,gold:0,level:1,level_progress:0}};
  d.session_data={status:'unavailable',reason:'key_unavailable'};return d;
}
const mime={'.js':'text/javascript','.json':'application/json','.html':'text/html','.png':'image/png','.otf':'font/otf'};
let polls=0,nextStatus=200,nextSession='unavailable';
const server=http.createServer((req,res)=>{try{
  const u=new URL(req.url,'http://localhost');
  if(u.pathname==='/api/plugins/hermes-quest/replay'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(fixture()));return;}
  if(u.pathname==='/api/plugins/hermes-quest/events'){
    polls++;res.setHeader('Content-Type','application/json');
    if(nextStatus!==200){res.writeHead(nextStatus).end('PRIVATE_BACKEND_CANARY');return;}
    const d=fixture(),working=d.working;working.as_of=now+polls;working.items[2].status='done';
    res.end(JSON.stringify({events:[],tasks:[],bots:[],cursor:'synthetic-poll-'+polls,state:'online',working,
      session_data:{status:nextSession,reason:nextSession==='unavailable'?'key_unavailable':null}}));return;
  }
  const file=path.resolve(root,u.pathname==='/'?'index.html':u.pathname.slice(1));
  assert(file.startsWith(root+path.sep));res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));
}catch{res.writeHead(404).end();}});
(async()=>{
  fs.mkdirSync(out,{recursive:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));const records=[];
  const hashes=Object.fromEntries(['quest/ui.js','quest/transport.js','ui-panels.js','tools/test_clarity_web_followup.cjs'].map(p=>[p,crypto.createHash('sha256').update(fs.readFileSync(path.join(p.startsWith('tools/test_')?__dirname+'/..':root,p))).digest('hex')]));
  try{for(const [engine,type] of Object.entries(before?{chromium}:{chromium,firefox})){
    const browser=require('./parity/browser_loader.cjs').enable(await type.launch({headless:true}));
    try{for(const [width,height] of before?[[1440,900]]:[[1440,900],[390,844],[320,568]]){
      const page=await browser.newPage({viewport:{width,height}}),errors=[];nextStatus=200;nextSession='unavailable';
      page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('503'))errors.push(m.text());});
      await page.addInitScript(()=>{window.__questTestGlobals=true;window.requestAnimationFrame=()=>0;});
      await page.goto('http://127.0.0.1:'+server.address().port+'/?live=1');
      await page.waitForFunction(()=>window.__questTest?.D&&document.querySelector('#working-rows button'),null,{polling:50});
      await page.evaluate(()=>{clearTimeout(pollTimer);S.play=false;hudT=1;hud(0);resize();draw();});
      await page.locator('#hint-dismiss').click();
      const tag=engine+'-'+width;
      const capture=async name=>{
        await page.evaluate(()=>{resize();draw();});
        await page.waitForFunction(()=>[...document.querySelectorAll('#quest .bitmap-row')].every(r=>r.querySelector('canvas')||r.querySelector('.detail-text')?.getBoundingClientRect().height>0),null,{polling:50});
        const geometry=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth+1,dialog:document.querySelector('#quest').getBoundingClientRect().toJSON(),
          colours:(()=>{const c=document.querySelector('#stage'),p=c.getContext('2d').getImageData(0,0,c.width,c.height).data,s=new Set();for(let i=0;i<p.length;i+=256)s.add([p[i],p[i+1],p[i+2],p[i+3]].join());return s.size;})()}));
        assert(!geometry.overflow&&geometry.colours>2,'Visible, nonblank world without page overflow');
        await page.screenshot({path:path.join(out,tag+'-'+name+'.png')});return geometry;
      };
      const check=async(name,fn)=>{try{const details=await fn();records.push({engine,version:browser.version(),width,height,name,pass:true,...details});}catch(e){records.push({engine,width,height,name,pass:false,error:e.message});}};
      const openHeroes=async()=>{
        await page.evaluate(()=>{UIPanels.close();UIPanels.menu(true);document.querySelector('#group-overview').open=true;hudT=1;hud(0);});
        await page.locator('#heroes-all').click();
      };
      await check('W1 multi-card rows identify the quest before Details',async()=>{
        await openHeroes();const rows=await page.locator('#quest .item-summary span').allTextContents(),geometry=await capture('all-heroes');
        assert.equal(rows.length,3);assert.equal(new Set(rows).size,3,'Each shared-worker entry needs distinct context');
        rows.forEach((text,i)=>assert(text.includes('Research Mage 1')&&text.includes('Build quest #'+(i+1))));
        for(let i=0;i<3;i++){
          await openHeroes();await page.locator('#quest .item-summary button').nth(i).click();
          assert.equal(await page.evaluate(()=>workView.focus),'synthetic-work-'+i);
          assert((await page.locator('#quest').textContent()).includes('Build quest #'+(i+1)));
          await page.locator('#quest .close').click();
        }
        assert.equal(await page.evaluate(()=>S.work.items().length),3,'Do not collapse multi-card associations');
        assert(!(await page.locator('body').innerHTML()).includes('PRIVATE_TITLE_CANARY'));return {rows,geometry};
      });
      await check('W2 missing session data explains impact, healthy Kanban and next action',async()=>{
        await page.evaluate(()=>{UIPanels.close();document.querySelector('#connection').click();});
        const text=await page.locator('#quest').textContent(),geometry=await capture('session-details');
        for(const word of ['tool calls','messages','helper links','token usage','Kanban polling has not stopped','restart Hermes'])assert(text.includes(word),word);
        assert.equal(await page.locator('#connection .control-name').textContent(),'Kanban connected');
        assert(await page.locator('#issues').isVisible());
        await page.getByRole('button',{name:'Setup help',exact:true}).scrollIntoViewIfNeeded();await capture('session-details-next-action');
        await page.getByRole('button',{name:'Setup help',exact:true}).click();
        assert((await page.locator('#quest').textContent()).includes('read worker history and write its private Quest settings'));
        await capture('session-setup');await page.locator('#quest .close').click();
        await page.evaluate(()=>document.querySelector('#issues').click());assert((await page.locator('#quest').textContent()).includes('token usage'));
        await page.locator('#quest .close').click();return {text,geometry};
      });
      if(!before){
        await check('W1 permitted name preserved and font-failure rows remain readable',async()=>{
          await page.evaluate(d=>{UIPanels.close();loadReplay(d,null,d.meta.to);S.play=false;hudT=1;hud(0);},fixture(true));
          await openHeroes();const rows=await page.locator('#quest .item-summary span').allTextContents();
          rows.forEach((s,i)=>assert(s.includes('Nova 1')&&s.includes('Build quest #'+(i+1))));
          await page.locator('#quest .close').click();
          // Reload in a fresh font lifecycle: clearing the bitmap cache does not unload a resolved FontFace.
          await page.addInitScript(()=>{window.fontFailures=0;window.FontFace=class{load(){window.fontFailures++;return Promise.reject(Error('synthetic font failure'));}};});
          await page.reload();await page.waitForFunction(()=>window.__questTest?.D&&document.querySelector('#working-rows button'),null,{polling:50});
          await page.evaluate(()=>{clearTimeout(pollTimer);S.play=false;hudT=1;hud(0);document.querySelector('#connection').click();});
          assert((await page.evaluate(()=>window.fontFailures))>0,'Font rejection must actually execute');
          await page.waitForFunction(()=>[...document.querySelectorAll('#quest .bitmap-row')].every(r=>r.querySelector('.detail-text')?.getBoundingClientRect().height>0),null,{polling:50});
          const geometry=await capture('font-fallback');await page.locator('#quest .close').click();return {rows,geometry};
        });
        await check('W2 actual poll updates Kanban; stale and session recovery remain distinct',async()=>{
          const start=polls;await page.evaluate(async()=>{await pollEvents();clearTimeout(pollTimer);hudT=1;hud(0);});assert(polls>start);
          assert.equal(await page.evaluate(()=>S.work.items()[2].status),'done');await openHeroes();assert.equal(await page.locator('#quest .item-summary').count(),2);
          await page.locator('#quest .close').click();
          nextStatus=503;await page.evaluate(async()=>{for(let i=0;i<3;i++){await pollEvents();clearTimeout(pollTimer);}hudT=1;hud(0);document.querySelector('#connection').click();});
          const stale=await page.locator('#quest').textContent();assert(stale.includes('latest data could not be loaded'));assert(!stale.includes('Kanban polling has not stopped'));
          await capture('stale-and-session');await page.locator('#quest .close').click();
          nextStatus=200;nextSession='unavailable';await page.evaluate(async()=>{await pollEvents();clearTimeout(pollTimer);hudT=1;hud(0);});
          assert.equal(await page.locator('#connection .control-name').textContent(),'Kanban connected');assert.match(await page.locator('#issues').textContent(),/Session activity unavailable/);
          nextSession='available';await page.evaluate(async()=>{await pollEvents();clearTimeout(pollTimer);hudT=1;hud(0);document.querySelector('#connection').click();});
          assert.equal(await page.locator('#connection .control-name').textContent(),'Connected');assert(!(await page.locator('#quest').textContent()).includes('token usage cannot'));
          assert(!await page.locator('#issues').isVisible());await capture('recovered');await page.locator('#quest .close').click();
          // Never reflect arbitrary reason/body data, even in Issues and Setup.
          await page.evaluate(()=>{D.session_data={status:'unavailable',reason:'PRIVATE_REASON_CANARY'};connectedStatus(D);hudT=1;hud(0);document.querySelector('#connection').click();});
          assert(!/PRIVATE_(?:REASON|BACKEND)_CANARY|key_unavailable/.test(await page.locator('body').innerHTML()));
          await page.locator('#quest .close').click();return {polls:polls-start,stale};
        });
        assert.deepEqual(errors,[]);
      }
      await page.close();console.log('Executed '+tag);
    }}finally{await browser.close();}
  }}finally{await new Promise(r=>server.close(r));}
  const failed=records.filter(r=>!r.pass);
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({candidate:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),hashes,synthetic:true,before,records},null,2));
  if(before){assert.equal(failed.length,2,'Both baseline defects must reproduce');console.log('REPRODUCED W1/W2');}
  else{assert.deepEqual(failed,[]);console.log('PASS web followup '+records.length+' cases');}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
