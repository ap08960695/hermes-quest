'use strict';
// Independent transition oracles from the Working review, synthetic data only.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium,firefox}=require('playwright');
const root=path.resolve(process.env.WORKING_ROOT||path.join(__dirname,'..'));
const out=path.resolve(process.argv[2]||'.evidence/working-regressions');
const demo=JSON.parse(fs.readFileSync(path.join(root,'data/demo.json')));
function fixture(){
 const d=structuredClone(demo);Object.assign(d.meta,{show_profile_names:true,show_titles:false});d.events=[];
 d.bots.forEach((b,i)=>b.display_name='Nova '+(i+1));
 const items=[0,1,2].map(i=>({ref:'opaque-work-'+i,bot_ref:d.bots[i].id,task_ref:d.tasks[i].id,status:'running',started_at:'2026-10-11T02:00:00Z',display_name:d.bots[i].display_name,class_label:'Research Mage',quest_label:'Build quest #'+(i+1),quest_kind:'build',group_label:'Other work',parent_ref:null,worker_observed:true}));
 d.working={as_of:'2026-10-11T03:00:00Z',items,resting_count:0,latest_order:null,progress:{wins_today:0,xp:0,gold:0,level:1,level_progress:0}};return d;
}
const server=http.createServer((req,res)=>{try{const n=new URL(req.url,'http://localhost').pathname;res.setHeader('Content-Type',({'.js':'text/javascript','.json':'application/json','.png':'image/png','.otf':'font/otf','.html':'text/html'})[path.extname(n)]||'text/html');res.end(fs.readFileSync(path.join(root,n==='/'?'index.html':n)));}catch{res.writeHead(404).end();}});
(async()=>{
 fs.mkdirSync(out,{recursive:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));const records=[];
 try{for(const [engine,type] of Object.entries({chromium,firefox})){
 const browser=await type.launch({headless:true});
 try{const context=await browser.newContext({viewport:{width:1440,height:900}});
 await context.addInitScript(()=>{window.__questTestGlobals=true;let factory;Object.defineProperty(window.HQModules={},'createGameUI',{get:()=>ctx=>(window.reviewUI=factory(ctx)),set:v=>factory=v});});
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/data/demo.json',r=>r.fulfill({json:fixture()}));await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>typeof loop.last==='number');
 await page.evaluate(()=>cancelAnimationFrame(raf));
 const load=async(d=fixture(),invalidate=true)=>page.evaluate(({d,invalidate})=>{loadReplay(d,null,Date.parse(d.working.as_of)/1000);S.play=false;liveFeed=false;following=false;workView.all=false;workView.focus=null;if(invalidate)workView.key='';hudT=1;hud(0);draw();},{d,invalidate});
 const check=async(name,fn)=>{try{await load();await fn();records.push({engine,name,pass:true});}catch(e){records.push({engine,name,pass:false,error:e.message});}};
 await check('F1 identical rebase retains usable rows',async()=>{
 assert.equal(await page.locator('#working-rows button').count(),3);await load(fixture(),false);assert.equal(await page.locator('#working-rows button').count(),3);
 await page.locator('#working-rows button').nth(1).click();assert.equal(await page.evaluate(()=>workView.focus),'opaque-work-1');
 });
 await check('F2 Show all resolves task binding and details',async()=>{
 const result=await page.evaluate(()=>{document.querySelector('#working-toggle').click();const item=S.work.items()[0],t=task(item.task_ref);Object.assign(t,{state:'fight',alpha:1});quest(t);return {label:reviewUI.sceneName(t),dialog:document.querySelector('#quest').textContent};});
 assert.equal(result.label,'Build quest #1');for(const text of ['Nova 1','Build quest #1','60 min','Status: running'])assert(result.dialog.includes(text),text);
 });
 await check('F3 explicit offscreen order cannot borrow a shared worker pair',async()=>{
 const d=fixture();d.working.items[1].bot_ref=d.working.items[0].bot_ref;d.working.items[1].display_name=d.working.items[0].display_name;await load(d);
 const result=await page.evaluate(()=>{focusWork(S.work.items()[0].ref);draw();liveFeed=true;following=true;S.play=true;const items=S.work.items(),latest_order={at:S.work.asOf+10,action_label:'Assign work',quest_label:items[1].quest_label,recipient_display_name:items[1].display_name,recipient_bot_ref:items[1].bot_ref,task_ref:items[1].task_ref};mergeDelta({events:[],tasks:[],bots:[],cursor:null,working:{as_of:S.work.asOf+10,items,resting_count:0,latest_order,progress:S.work.progress()}});hudT=1;hud(0);return {couriers:S.fx.filter(f=>f.icon==='📜').length,pinned:document.querySelector('#working-order').textContent,errors:S.work.hookErrors};});
 assert.equal(result.couriers,0);assert(result.pinned.includes('Build quest #2'));assert.equal(result.errors,0);
 });
 await check('F4 keyboard focus follows identity through reorder and removal',async()=>{
 await page.locator('#working-rows button').nth(1).focus();
 await page.evaluate(()=>{const items=S.work.items();items[0].status='done';mergeDelta({events:[],tasks:[],bots:[],cursor:null,working:{as_of:S.work.asOf+10,items,resting_count:0,latest_order:null,progress:S.work.progress()}});hudT=1;hud(0);});
 assert((await page.evaluate(()=>document.activeElement.textContent)).includes('Nova 2'));await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>workView.focus),'opaque-work-1');
 await page.evaluate(()=>{const items=S.work.items().filter(i=>i.ref!=='opaque-work-1');mergeDelta({events:[],tasks:[],bots:[],cursor:null,working:{as_of:S.work.asOf+10,items,resting_count:0,latest_order:null,progress:S.work.progress()}});hudT=1;hud(0);});
 assert.equal(await page.evaluate(()=>document.activeElement.id),'working-toggle');
 });
 await check('F5 completed without observed run retains canonical alias',async()=>{
 const d=fixture();d.working.items[0].status='done';d.working.items[0].worker_observed=false;await load(d);
 assert.equal(await page.evaluate(()=>reviewUI.workItems()[0].display_name),'Nova 1');assert.equal(await page.evaluate(()=>characterName(S.work.items()[0].bot_ref)),'Nova 1');
 });
 await check('F5 resting names-off worker retains backend role label',async()=>{
 const d=fixture();
 d.meta.show_profile_names=false;d.bots.forEach((b,i)=>b.display_name='Research Mage '+(i+1));d.working.items=[{...d.working.items[1],display_name:'Research Mage 2'}];await load(d);
 assert.equal(await page.evaluate(()=>characterName(D.bots[3].id)),'Research Mage 4');assert(!(await page.locator('body').innerHTML()).includes('Nova'));
 });
 await check('F6 replay elapsed follows playhead in row and detail',async()=>{
 await page.evaluate(()=>{S.t-=1800;hudT=1;hud(0);focusWork(S.work.items()[0].ref,true);});assert((await page.locator('#working-rows button').first().textContent()).includes('30 min'));assert((await page.locator('#quest').textContent()).includes('30 min'));
 });
 await check('F6 paused live row updates with the same snapshot clock as detail',async()=>{
 await page.evaluate(()=>{liveFeed=true;following=true;S.play=false;const working={as_of:S.work.asOf+120,items:S.work.items(),resting_count:0,latest_order:null,progress:S.work.progress()};mergeDelta({events:[],tasks:[],bots:[],cursor:null,working});hudT=1;hud(0);});
 assert((await page.locator('#working-rows button').first().textContent()).includes('62 min'));
 await page.evaluate(()=>focusWork(S.work.items()[0].ref,true));assert((await page.locator('#quest').textContent()).includes('62 min'));
 });
 await check('F8 immutable order dedup ignores alias and quest presentation',async()=>{
 const result=await page.evaluate(()=>{let fires=0;const off=S.work.onOrder(()=>fires++);const i=S.work.items()[0],order={at:S.work.asOf+10,action_label:'Assign work',quest_label:i.quest_label,recipient_display_name:i.display_name,recipient_bot_ref:i.bot_ref,task_ref:i.task_ref};
 const deliver=o=>mergeDelta({events:[],tasks:[],bots:[],cursor:null,working:{as_of:S.work.asOf+10,items:S.work.items(),resting_count:0,latest_order:o,progress:S.work.progress()}});
 deliver(order);deliver({...order,quest_label:'Testing quest #8',recipient_display_name:'Ember'});off();return {fires,label:S.work.latestOrder.recipient_display_name};});
 assert.equal(result.fires,1);assert.equal(result.label,'Ember');
 });
 await check('F11 Overview Completed collapsed but accessible',async()=>{
 const d=fixture();d.working.items.forEach(i=>i.status='done');await load(d);await page.evaluate(()=>{UIPanels.menu(true);document.querySelector('#group-overview').open=true;hudT=1;hud(0);});
 assert.equal(await page.locator('#tasks-list details').count(),1);assert.equal(await page.locator('#tasks-list details').evaluate(el=>el.open),false);assert.equal(await page.locator('#tasks-list .item-summary').first().isVisible(),false);
 await page.locator('#tasks-list summary').click();assert.equal(await page.locator('#tasks-list .item-summary').first().isVisible(),true);await page.locator('#tasks-list button').first().click();assert((await page.locator('#quest').textContent()).includes('Nova 1'));
 });
 records.push({engine,name:'no page errors',pass:errors.length===0,errors});
 }finally{await browser.close();}
 }}finally{await new Promise(r=>server.close(r));}
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(records,null,2));for(const r of records)console.log((r.pass?'PASS':'FAIL')+' '+r.engine+' '+r.name+(r.error?' — '+r.error:''));if(records.some(r=>!r.pass))process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
