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
 const load=async(d=fixture(),invalidate=true)=>page.evaluate(({d,invalidate})=>{UIPanels.close();loadReplay(d,null,Date.parse(d.working.as_of)/1000);S.play=false;liveFeed=false;following=false;workView.all=false;workView.focus=null;if(invalidate)workView.key='';hudT=1;hud(0);draw();},{d,invalidate});
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
 await check('F6 real Pause control freezes elapsed across live polls',async()=>{
 const d=fixture();d.meta.to=Date.parse(d.working.as_of)/1000;await load(d);
 await page.evaluate(()=>{liveFeed=true;const now=Date.now;Date.now=()=>S.work.asOf*1000;try{goLive();}finally{Date.now=now;}UIPanels.menu(true);document.querySelector('#group-playback').open=true;hudT=1;hud(0);});
 await page.locator('#play').click();assert.equal(await page.evaluate(()=>following),false);assert.equal(await page.evaluate(()=>S.play),false);
 const before=await page.locator('#working-rows button').first().textContent();
 await page.evaluate(()=>{mergeDelta({events:[],tasks:[],bots:[],cursor:null,working:{as_of:S.work.asOf+120,items:S.work.items(),resting_count:0,latest_order:null,progress:S.work.progress()}});hudT=1;hud(0);});
 assert.equal(await page.locator('#working-rows button').first().textContent(),before);
 await page.evaluate(()=>focusWork(S.work.items()[0].ref,true));assert((await page.locator('#quest').textContent()).includes('60 min'));
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
 for(const mode of ['replay','live-follow'])await check('R-F6 relative-minute boundary '+mode,async()=>{
 const d=fixture();d.working.items[0].started_at='2026-10-11T02:00:10Z';await load(d);
 const r=await page.evaluate(mode=>{
 const base=Date.parse('2026-10-11T02:00:00Z')/1000;
 const advance=sec=>{if(mode==='replay')S.t=sec;else mergeDelta({events:[],tasks:[],bots:[],cursor:null,working:{as_of:sec,items:S.work.items(),resting_count:0,latest_order:null,progress:S.work.progress()}});hudT=1;hud(0);};
 // Rebase the synthetic snapshot before enabling live-follow, so deltas are newer.
 if(mode==='live-follow'){const d=structuredClone(D);d.working={as_of:base+60,items:S.work.items(),resting_count:0,latest_order:null,progress:S.work.progress()};loadReplay(d,null,base+60);liveFeed=true;goLive();}
 advance(base+60);const initial=workView.buttons.get('opaque-work-0').textContent;
 advance(base+70);return {initial,row:workView.buttons.get('opaque-work-0').textContent,detail:reviewUI.questLines({id:S.work.items()[0].task_ref})};
 },mode);
 assert(r.initial.includes('0 min'));assert(r.row.includes('1 min'));assert(r.detail.includes('1 min'));
 });
 await check('R-F5a names-off Captain retains canonical safe label',async()=>{
 const d=fixture();d.meta.show_profile_names=false;d.bots.forEach((b,i)=>b.display_name='Research Mage '+(i+1));d.bots[3].display_name='Captain';d.bots[4].display_name='PRIVATE_ALIAS_SENTINEL';d.working.items=[{...d.working.items[1],display_name:'Research Mage 2'}];await load(d);
 assert.equal(await page.evaluate(()=>characterName(D.bots[3].id)),'Captain');assert.equal(await page.evaluate(()=>D.bots[3].display_name),'Captain');assert.equal(await page.evaluate(()=>D.bots[4].display_name??null),null);
 const active=structuredClone(d);active.working.items.push({...d.working.items[0],ref:'opaque-captain',bot_ref:d.bots[3].id,display_name:'Captain',class_label:'Captain'});await load(active);assert.equal(await page.evaluate(()=>reviewUI.workItems().find(i=>i.ref==='opaque-captain').display_name),'Captain');
 });
 await check('R-F5b real bot alias survives shared unobserved running row',async()=>{
 const d=fixture();Object.assign(d.working.items[1],{status:'done',bot_ref:d.bots[0].id,display_name:'Nova 1'});await load(d);
 assert.equal(await page.evaluate(()=>characterName(D.bots[0].id)),'Nova 1');
 await page.evaluate(()=>{const items=S.work.items();Object.assign(items[0],{worker_observed:false,display_name:'Worker not observed'});mergeDelta({events:[],tasks:[],bots:[],cursor:null,working:{as_of:S.work.asOf+10,items,resting_count:0,latest_order:null,progress:S.work.progress()}});hudT=1;hud(0);});
 assert.equal(await page.evaluate(()=>characterName(D.bots[0].id)),'Nova 1');assert.equal(await page.evaluate(()=>characterName('opaque-work-0')),'Worker not observed');assert.equal(await page.evaluate(()=>reviewUI.workItems()[1].display_name),'Nova 1');
 });
 await check('R-F2 chooser distinguishes same-stage tasks and selection',async()=>{
 const r=await page.evaluate(()=>{UIPanels.menu(false);document.querySelector('#working-toggle').click();const items=S.work.items().slice(0,2);for(const i of items)Object.assign(task(i.task_ref),{stage:'BUILD',state:'fight',alpha:1});reviewUI.chooseCharacters(items.map(i=>({type:'monster',id:i.task_ref})));return [...document.querySelectorAll('#character-content button')].map(b=>b.textContent);});
 assert.deepEqual(r,['Monster · Build quest #1','Monster · Build quest #2']);await page.locator('#character-content button').nth(1).click();assert((await page.locator('#quest').textContent()).includes('Build quest #2'));
 });
 await check('R-K1 Completed disclosure preserves focus and expanded state on poll',async()=>{
 const d=fixture();d.working.items[0].status='done';await load(d);await page.evaluate(()=>{UIPanels.menu(true);document.querySelector('#group-overview').open=true;hudT=1;hud(0);});await page.locator('#tasks-list summary').click();
 await page.evaluate(()=>{const items=S.work.items();items[1].status='blocked';mergeDelta({events:[],tasks:[],bots:[],cursor:null,working:{as_of:S.work.asOf+10,items,resting_count:0,latest_order:null,progress:S.work.progress()}});hudT=1;hud(0);});
 assert.equal(await page.evaluate(()=>document.activeElement===document.querySelector('#tasks-list summary')),true);assert.equal(await page.locator('#tasks-list details').evaluate(el=>el.open),true);
 });
 await check('R-K2 completed dialog restores retained work identity or toggle after eviction',async()=>{
 const d=fixture();d.working.items[0].status='done';await load(d);await page.locator('#working-rows summary').click();await page.locator('#working-rows details button').first().click();await page.locator('#quest .close').click();
 assert.equal(await page.evaluate(()=>document.activeElement===workView.buttons.get('opaque-work-0')),true);
 await page.locator('#working-rows details button').first().click();await page.evaluate(()=>{const items=S.work.items().filter(i=>i.ref!=='opaque-work-0');mergeDelta({events:[],tasks:[],bots:[],cursor:null,working:{as_of:S.work.asOf+10,items,resting_count:0,latest_order:null,progress:S.work.progress()}});hudT=1;hud(0);});
 // The refreshed dialog can close automatically, or its Close button still owns focus.
 if(await page.locator('#quest .close').isVisible())await page.locator('#quest .close').click();
 assert.equal(await page.evaluate(()=>document.activeElement.id),'working-toggle');
 });
 await check('Working feel activity binding, contact, combo, pause and silent seek',async()=>{
 const d=fixture();await load(d);const r=await page.evaluate(()=>{
 const row=S.work.active().find(i=>i.worker_observed),pair=()=>workingPairs().find(p=>p.item.ref===row.ref),state=()=>structuredClone(pair().monster.activity||null);
 S.play=true;D.meta.to=S.t+3600;const e={t:S.t,kind:'tool',bot:row.bot_ref,task:row.task_ref,tool:'terminal'};
 apply({...e,task:'another-task'},true);const foreign=state();
 apply(e,false);const silent=state();
 apply(e,true);apply({...e,kind:'activity'},true);
 update(.01);const windup=state();update(.23);const contact=state();
 S.play=false;update(.2);const paused=state();S.play=true;
 update(.5);update(.01);update(.23);const second=state();
 const hp=pair().monster.hp;reset(S.t);return {foreign,silent,windup,contact,paused,second,hp,seek:state()};
 });
 assert.equal(r.foreign,null);assert.equal(r.silent,null);assert.equal(r.windup.total,0);assert.equal(r.contact.total,1);assert(r.contact.flash>0);assert.equal(r.contact.hitCombo,1);assert.deepEqual(r.paused,r.contact);assert.equal(r.second.total,2);assert.equal(r.second.hitCombo,2);assert.equal(r.hp,null);assert.equal(r.seek,null);
 });
 await check('Working feel sticky order, stable quest number and helper parent link',async()=>{
 const d=fixture();const i=d.working.items[0];d.sessions=[{session_ref:'aaaaaaaaaaaaaaaaaaaa',bot:i.bot_ref,task:i.task_ref,is_subagent:false,started_at:d.meta.from_,ended_at:null},{session_ref:'bbbbbbbbbbbbbbbbbbbb',parent_session_ref:'aaaaaaaaaaaaaaaaaaaa',bot:i.bot_ref,task:i.task_ref,is_subagent:true,started_at:d.meta.from_,ended_at:null}];await load(d);
 assert.equal(await page.locator('.work-helper').count(),1);assert((await page.locator('.work-helper').textContent()).includes('Open parent'));await page.locator('.work-helper').click();assert((await page.locator('#quest').textContent()).includes(i.quest_label));await page.locator('#quest .close').click();
 assert.equal(await page.locator('#working-order').evaluate(el=>getComputedStyle(el).position),'sticky');
 const labels=await page.evaluate(()=>{const labels=[],old=UIPanels.screenLabel;UIPanels.screenLabel=(s,...a)=>{labels.push(s);old(s,...a);};draw();UIPanels.screenLabel=old;return labels;});assert(labels.some(s=>/#\d+$/.test(s)));assert(!labels.some(s=>/Planning quest|Testing quest/.test(s)));
 });
 await check('Working feel mobile scroll keeps Captain instruction pinned',async()=>{
 const d=fixture(),i=d.working.items[0];d.working.latest_order={at:d.working.as_of,source_action_ref:'synthetic-command',action_label:'Assigned quest',quest_label:i.quest_label,recipient_display_name:i.display_name,recipient_bot_ref:i.bot_ref,task_ref:i.task_ref};await load(d);
 for(const width of [320,375]){await page.setViewportSize({width,height:568});await page.waitForTimeout(100);const r=await page.evaluate(()=>{const panel=document.querySelector('#working-panel');panel.scrollTop=panel.scrollHeight;const p=panel.getBoundingClientRect(),o=document.querySelector('#working-order').getBoundingClientRect();return {scrolled:panel.scrollTop,top:o.top,bottom:o.bottom,pTop:p.top,pBottom:p.bottom,text:document.querySelector('#working-order').textContent};});assert(r.scrolled>0);assert(r.top>=r.pTop-1);assert(r.bottom<=r.pBottom);assert(r.text.includes('Build quest #1'));}
 await page.setViewportSize({width:1440,height:900});
 });
 await check('Working feel playback controls update summary immediately',async()=>{
 await load();const r=await page.evaluate(()=>{const summary=()=>document.querySelector('#playback-summary').textContent;document.querySelector('#speeds').click();const speed=S.speed,speedText=summary();document.querySelector('#play').click();const playing=S.play,playText=summary();const scrub=document.querySelector('#scrub');scrub.value='250';scrub.dispatchEvent(new Event('input'));return {speed,speedText,playing,playText,seekText:summary(),following};});assert(r.speedText.includes(r.speed+'×'));assert(r.playText.startsWith(r.playing?'Playing':'Paused'));assert(r.seekText.includes('Range'));assert(r.seekText.includes('Live-follow off'));assert.equal(r.following,false);
 });
 records.push({engine,name:'no page errors',pass:errors.length===0,errors});
 }finally{await browser.close();}
 }}finally{await new Promise(r=>server.close(r));}
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(records,null,2));for(const r of records)console.log((r.pass?'PASS':'FAIL')+' '+r.engine+' '+r.name+(r.error?' — '+r.error:''));if(records.some(r=>!r.pass))process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
