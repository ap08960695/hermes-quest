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
 await context.addInitScript(()=>{window.__questTestGlobals=true;window.HQModules={};for(const [name,expose] of [['createGameUI','reviewUI'],['createHistory','reviewHistory']]){let factory;Object.defineProperty(window.HQModules,name,{get:()=>ctx=>(window[expose]=factory(ctx)),set:v=>factory=v});}});
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
 assert.equal(result.label,'Build quest #1');for(const text of ['Nova 1','Build quest #1','60 min','Status: Running'])assert(result.dialog.includes(text),text);
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
 assert(r.initial.includes('<1 min'));assert(r.row.includes('1 min'));assert(r.detail.includes('Running for 1 min'));
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
 assert.deepEqual(r,['Quest · Build quest #1','Quest · Build quest #2']);await page.locator('#character-content button').nth(1).click();assert((await page.locator('#quest').textContent()).includes('Build quest #2'));
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
 update(.5);update(.2);update(.23);const second=state();
 const hp=pair().monster.hp;reset(S.t);return {foreign,silent,windup,contact,paused,second,hp,seek:state()};
 });
 assert.equal(r.foreign,null);assert.equal(r.silent,null);assert.equal(r.windup.total,0);assert.equal(r.contact.total,1);assert(r.contact.flash>0);assert.equal(r.contact.hitCombo,1);assert.deepEqual(r.paused,r.contact);assert.equal(r.second.total,2);assert.equal(r.second.hitCombo,2);assert.equal(r.hp,null);assert.equal(r.seek,null);
 });
 await check('R2 pre-start and wrong worker cannot borrow current-run hits',async()=>{
 const r=await page.evaluate(()=>{const row=S.work.active()[0];S.play=true;D.meta.to=S.t+3600;
 const e={t:row.started_at-1,kind:'tool',bot:row.bot_ref,task:row.task_ref,id:'old-run'};
 apply(e,true);apply({...e,t:S.t,bot:'other-worker',id:'wrong-worker'},true);update(.01);
 return workingPairs().find(p=>p.item.ref===row.ref).monster.activity||null;});assert.equal(r,null);
 });
 await check('R2 hidden observations are dropped and hit-stop drains into bounded pending storage',async()=>{
 const r=await page.evaluate(()=>{const row=S.work.active()[0],e={t:S.t,kind:'tool',bot:row.bot_ref,task:row.task_ref};
 Object.defineProperty(document,'hidden',{configurable:true,value:true});for(let i=0;i<1000;i++)apply({...e,id:'hidden-'+i},true);
 delete document.hidden;update(.01);const hidden=workingPairs()[0].monster.activity||null;
 S.play=true;S.stop=100;for(let i=0;i<1000;i++){apply({...e,id:'hit-stop-'+i},true);update(.01);}
 const a=workingPairs()[0].monster.activity;return {hidden,total:a.total,pending:a.pending.length,damage:a.total+a.pending.reduce((n,p)=>n+p.damage,0)+(a.atk>=0&&a.atk<.22?a.current.damage:0)};});
 assert.equal(r.hidden,null);assert(r.total>0);assert(r.pending<=32);assert.equal(r.damage,1000);
 });
 await check('R2 sparring 60 seconds changes no HP, damage, actions, mana or rewards; pause and reduced motion',async()=>{
 const d=fixture();Object.assign(d.working.items[0],{action_count:12,last_action_at:Date.parse(d.working.as_of)/1000-8});await load(d);
 const r=await page.evaluate(()=>{S.play=true;S.speed=1;D.meta.to=S.t+3600;
 const values=()=>JSON.stringify({progress:S.work.progress(),items:S.work.items(),mana:S.mana,vault:S.vault,hp:workingPairs().map(p=>p.monster.hp),damage:workingPairs().map(p=>p.monster.activity?.total||0)});
 const before=values();let gap=0,maxGap=0,beats=0;for(let i=0;i<600;i++){if(i<100)S.stop=1;else S.stop=0;update(.1);const p=workingPairs()[0];if(p.hero.spar>0){gap=0;beats++;}else{gap+=.1;maxGap=Math.max(maxGap,gap);}}
 const after=values();S.play=false;const paused=workingPairs()[0].hero.spar;update(10);const freeze=workingPairs()[0].hero.spar;
 document.querySelector('#calm').click();const calm=workingPairs()[0].hero.spar;document.querySelector('#calm').click();
 S.t=Date.parse('2026-10-11T03:00:00Z')/1000;hudT=1;hud(0);return {before,after,maxGap,beats,paused,freeze,calm,row:document.querySelector('#working-rows button').textContent};});
 assert.equal(r.before,r.after);assert(r.maxGap<4);assert(r.beats>0);assert.equal(r.freeze,r.paused);assert.equal(r.calm,0);assert(r.row.includes('12 actions this run · last 8s ago'));
 await page.evaluate(()=>{S.play=true;update(.3);});await page.emulateMedia({reducedMotion:'reduce'});await page.waitForFunction(()=>matchMedia('(prefers-reduced-motion: reduce)').matches&&workingPairs()[0].hero.spar===0);assert.equal(await page.evaluate(()=>{update(.3);return workingPairs()[0].hero.spar;}),0);await page.emulateMedia({reducedMotion:'no-preference'});await page.waitForFunction(()=>!matchMedia('(prefers-reduced-motion: reduce)').matches&&workingPairs()[0].hero.spar>0);
 });
 await check('R2 live poll overlap and late batch retain queue, pace contacts and disclose source age',async()=>{
 const r=await page.evaluate(()=>{const row=S.work.active()[0];liveFeed=true;following=true;S.play=true;S.speed=1;
 const t=S.t-10,e={t,kind:'activity',bot:row.bot_ref,task:row.task_ref,id:'action-one'};
 const delta=events=>({events,bots:[],tasks:[],cursor:null,working:{as_of:S.work.asOf+1,items:S.work.items(),resting_count:0,latest_order:null,progress:S.work.progress()}});
 mergeDelta(delta([e,{...e,id:'action-two'}]));update(.01);mergeDelta(delta([e,{...e,id:'action-two'}]));
 mergeDelta(delta([{...e,id:'action-three',t:t-1}]));
 let last=0,clock=0;const contacts=[];for(let i=0;i<200;i++){update(.02);clock+=.02;const a=workingPairs()[0].monster.activity;if(a.total!==last){contacts.push(clock);last=a.total;}}
 const labels=[],old=UIPanels.screenLabel;UIPanels.screenLabel=(s,...args)=>{labels.push(s);old(s,...args);};draw();UIPanels.screenLabel=old;
 // Trigger one source-aged hit for the visible disclosure oracle.
 apply({...e,id:'action-four'},true);update(.01);update(.3);UIPanels.screenLabel=(s,...args)=>{labels.push(s);old(s,...args);};draw();UIPanels.screenLabel=old;
 return {total:last,contacts,labels};});assert.equal(r.total,3);assert.equal(r.contacts.length,3);for(let i=1;i<r.contacts.length;i++)assert(r.contacts[i]-r.contacts[i-1]>=.8);assert(r.labels.some(s=>/^Bot acted \d+s ago$/.test(s)));
 });
 for(const contacted of [false,true])await check('R3 late batch sorts uncontacted work; completed contact immutable '+contacted,async()=>{
 const r=await page.evaluate(contacted=>{const row=S.work.active()[0];liveFeed=true;following=true;S.play=true;S.speed=1;
 const t=S.t-10,e={t,kind:'tool',bot:row.bot_ref,task:row.task_ref,session_ref:'aaaaaaaaaaaaaaaaaaaa',source_seq:2,source_slot:0,id:'z-first'};
 const delta=events=>({events,bots:[],tasks:[],cursor:null,working:{as_of:S.work.asOf+1,items:S.work.items(),resting_count:0,latest_order:null,progress:S.work.progress()}});
 mergeDelta(delta([e,{...e,id:'a-next',t:t+1,source_seq:3}]));update(.01);
 const contacts=[];let last=0;const step=dt=>{update(dt);const a=workingPairs()[0].monster.activity;if(a.total!==last){contacts.push({at:a.current.at,combo:a.hitCombo,damage:a.damage});last=a.total;}};
 if(contacted)step(.23);
 mergeDelta(delta([{...e,id:'late',t:t-1,source_seq:1}]));
 mergeDelta(delta([e,{...e,id:'a-next',t:t+1,source_seq:3},{...e,id:'late',t:t-1,source_seq:1}]));
 for(let i=0;i<200;i++)step(.02);
 const before=last,snapshot=structuredClone(D);snapshot.working={as_of:S.work.asOf,items:S.work.items(),resting_count:0,latest_order:null,progress:S.work.progress()};loadReplay(snapshot,null,S.t);update(.3);
 return {t,contacts,before,reload:workingPairs()[0].monster.activity||null};},contacted);
 assert.deepEqual(r.contacts.map(c=>c.at),contacted?[r.t,r.t-1,r.t+1]:[r.t-1,r.t,r.t+1]);
 assert.deepEqual(r.contacts.map(c=>c.combo),contacted?[1,1,2]:[1,2,3]);assert.equal(r.before,3);assert.equal(r.contacts.reduce((n,c)=>n+c.damage,0),3);assert.equal(r.reload,null);
 });
 await check('R3 equal-time ordinals beat IDs and mixed legacy rows have total order',async()=>{
 const r=await page.evaluate(()=>{const row=S.work.active()[0];S.play=true;D.meta.to=S.t+3600;
 const e={t:S.t,kind:'tool',bot:row.bot_ref,task:row.task_ref,session_ref:'aaaaaaaaaaaaaaaaaaaa',source_seq:1,source_slot:0,id:'z-read'};
 const events=[{...e,id:'a-terminal',source_slot:1},e,{...e,id:'q-message',source_seq:2},{...e,id:'b-independent',session_ref:'bbbbbbbbbbbbbbbbbbbb'}, {t:e.t,id:'legacy-z'}, {t:e.t,id:'legacy-a'}];
 const sorted=[...events].sort(reviewHistory.eventOrder),reverse=[...events].reverse().sort(reviewHistory.eventOrder);
 apply(events[0],true);update(.01);apply(e,true);update(.01);
 const a=workingPairs()[0].monster.activity;const first=a.current.combo;update(.23);const contact=a.current.at;
 return {ids:sorted.map(e=>e.id),reverse:reverse.map(e=>e.id),first,contact,total:a.total};});
 assert.deepEqual(r.ids,['legacy-a','legacy-z','z-read','a-terminal','q-message','b-independent']);assert.deepEqual(r.ids,r.reverse);assert.equal(r.first,1);assert.equal(r.total,1);
 });
 await check('R3 late action inside coalesced burst retains exact source ranges and damage',async()=>{
 const r=await page.evaluate(()=>{const row=S.work.active()[0];S.play=true;D.meta.to=S.t+3600;const t=S.t;
 const e={kind:'tool',bot:row.bot_ref,task:row.task_ref};for(let i=0;i<100;i++)apply({...e,id:'burst-'+i,t:t+i/100},true);
 update(.01);apply({...e,id:'inside-tail',t:t+.5},true);apply({...e,id:'earliest',t:t-.01},true);update(.01);
 const a=workingPairs()[0].monster.activity;const first=a.current.at,queued=a.pending.length;
 let last=0;const contacts=[];for(let i=0;i<2000;i++){update(.02);if(a.total!==last){contacts.push({at:a.current.at,damage:a.damage,combo:a.hitCombo});last=a.total;}}
 return {t,first,queued,contacts,total:a.total,waiting:a.pending.reduce((n,p)=>n+p.events.length,0)+(a.current?.events?.length||0)};});
 assert.equal(r.first,r.t-.01);assert(r.queued<=32);assert.equal(r.total,102);assert.equal(r.waiting,0);assert.equal(r.contacts.reduce((n,c)=>n+c.damage,0),102);assert.equal(r.contacts.at(-1).combo,102);assert(r.contacts.at(-1).damage>1);for(let i=1;i<r.contacts.length;i++)assert(r.contacts[i].at>=r.contacts[i-1].at);
 });
 await check('Working feel large real-action burst retains damage with bounded animation storage',async()=>{
 const d=fixture();await load(d);const r=await page.evaluate(()=>{
 const row=S.work.active().find(i=>i.worker_observed),state=()=>workingPairs().find(p=>p.item.ref===row.ref).monster.activity;
 S.play=true;D.meta.to=S.t+3600;
 for(let i=0;i<1000;i++)apply({t:S.t+i/10000,kind:'tool',tool:'terminal',bot:row.bot_ref,task:row.task_ref},true);
 update(.01);const queued=state().pending.length;
 for(let i=0;i<80;i++){update(.7);update(.01);}
 return {queued,total:state().total,pending:state().pending.length,combo:state().hitCombo,damage:state().damage};
 });assert(r.queued<=64);assert.equal(r.total,1000);assert.equal(r.pending,0);assert.equal(r.combo,1000);assert(r.damage>1);
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
 await load();const r=await page.evaluate(()=>{const summary=()=>document.querySelector('#playback-summary').textContent;document.querySelector('#speeds').click();const speed=S.speed,speedText=summary();document.querySelector('#play').click();const playing=S.play,playText=summary();const scrub=document.querySelector('#scrub');scrub.value='250';scrub.dispatchEvent(new Event('input'));return {speed,speedText,playing,playText,seekText:summary(),following};});assert(r.speedText.includes(r.speed+'×'));assert(r.playText.startsWith(r.playing?'Playing':'Paused'));assert(r.seekText.includes('Saved range:'));assert(r.seekText.includes('Live-follow off'));assert.equal(r.following,false);
 });
 records.push({engine,name:'no page errors',pass:errors.length===0,errors});
 }finally{await browser.close();}
 }}finally{await new Promise(r=>server.close(r));}
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(records,null,2));for(const r of records)console.log((r.pass?'PASS':'FAIL')+' '+r.engine+' '+r.name+(r.error?' — '+r.error:''));if(records.some(r=>!r.pass))process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
