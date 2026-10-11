'use strict';
// Synthetic acceptance cases: production factories, real DOM/raster and transport.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium,firefox}=require('playwright');
const {assertRenderedAliases}=require('./clarity_readability.cjs');
const root=path.resolve(process.env.SCENE_ROOT||path.join(__dirname,'..'));
const out=path.resolve(process.argv[2]||'.evidence/clarity-scene');
const demo=JSON.parse(fs.readFileSync(path.join(root,'data/demo.json')));
const secret=['PRIVATE_TITLE_CANARY','PRIVATE_PROFILE_CANARY','PRIVATE_NOTE_CANARY','PRIVATE_GROUP_CANARY'];
function fixture(working=true){
 const d=structuredClone(demo);Object.assign(d.meta,{show_titles:false,show_profile_names:true});d.events=[];
 d.bots.forEach((b,i)=>Object.assign(b,{profile_name:secret[1]+i,name:secret[1]+i,display_name:'Nova '+(i+1)}));
 d.tasks.forEach(t=>Object.assign(t,{title:secret[0],note:secret[2],campaign:secret[3]}));
 if(working){const statuses=['running','running','blocked','failed','done','unknown'];
 d.working={as_of:d.meta.to,items:statuses.map((status,i)=>({ref:'opaque-work-'+i,task_ref:d.tasks[i].id,bot_ref:d.bots[i].id,status,started_at:i===5?null:d.meta.to-30,display_name:'Nova '+(i+1),class_label:'Research Mage',quest_label:secret[0],quest_kind:'build',group_label:secret[3],worker_observed:true,action_count:i===5?null:i,last_action_at:i===5?null:d.meta.to-8})),resting_count:1,latest_order:null,progress:{wins_today:1,xp:10,gold:1,level:1,level_progress:10}};d.tasks.forEach(t=>t.max_rt=30);}
 else delete d.working;
 return d;
}
const server=http.createServer((req,res)=>{
 const n=new URL(req.url,'http://localhost').pathname,file=path.resolve(root,'.'+(n==='/'?'/index.html':n));
 if(!file.startsWith(root+path.sep))return res.writeHead(403).end();
 fs.readFile(file,(e,bytes)=>{res.writeHead(e?404:200,{'content-type':({'.js':'text/javascript','.json':'application/json','.png':'image/png','.html':'text/html','.otf':'font/otf'})[path.extname(file)]||'application/octet-stream'});res.end(e?'not found':bytes);});
});
(async()=>{
 fs.mkdirSync(out,{recursive:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));const records=[];
 try{for(const [engine,type] of Object.entries({chromium,firefox})){
 const browser=await type.launch({headless:true});
 try{const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{
  window.__questTestGlobals=true;window.HQModules={};
  for(const [name,key] of [['createGameUI','clarityUI'],['createRenderer','clarityRenderer'],['createTransport','clarityTransport']]){
   let factory;Object.defineProperty(HQModules,name,{get:()=>ctx=>(window[key]=factory(ctx)),set:v=>factory=v});
  }
  window.clarityText=[];const fill=CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText=function(text,...args){clarityText.push(String(text));this.canvas.rasterText=String(text);return fill.call(this,text,...args);};
  const image=CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage=function(source,...args){this.canvas.rasterText=source.rasterText;return image.call(this,source,...args);};
  let font;Object.defineProperty(window,'UIText',{get:()=>font,set:value=>{font={...value,draw(ctx,text,...args){ctx.canvas.rasterText=String(text);return value.draw(ctx,text,...args);}};}});
 });
 await page.route('**/data/demo.json',r=>r.fulfill({json:fixture()}));
 await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>typeof loop.last==='number');
 await page.locator('#hint-dismiss').click();
 await page.evaluate(()=>{cancelAnimationFrame(raf);const bitmap=UIText.bitmap;UIText.bitmap=(text,...args)=>{clarityText.push(String(text));return bitmap.call(UIText,text,...args);};
 const label=UIPanels.screenLabel;UIPanels.screenLabel=(text,...args)=>{clarityText.push(String(text));return label.call(UIPanels,text,...args);};

 window.clarityPayload={};for(const name of ['overview','feed','camps','status']){const original=UIPanels[name];UIPanels[name]=(...args)=>{clarityPayload[name]=args;return original.apply(UIPanels,args);};}
 });
 const check=async(name,fn)=>{try{await fn();records.push({engine,name,pass:true});}catch(e){records.push({engine,name,pass:false,error:e.message});}};
 const load=async d=>{await page.evaluate(d=>{UIPanels.close();UIPanels.menu(false);clearInspection();selectedScene=null;loadReplay(d,null,d.working?.as_of??d.meta.to);S.play=false;following=false;liveFeed=false;pollStale=false;pollFailures=0;workView.all=false;workView.focus=null;workView.key='';hudT=1;hud(0);draw();},d);};
 const privacy=async()=>{
 const outputs=await page.evaluate(()=>JSON.stringify({html:document.body.outerHTML,text:clarityText,payload:clarityPayload}));
 // Keys remain internal transport bindings; inspect only presentation, not callback/store keys.
 const visible=await page.evaluate(()=>document.body.outerHTML+'\n'+clarityText.join('\n'));
 for(const s of secret)assert(!visible.includes(s),'privacy leak: '+s);
 for(const id of [...fixture().bots,...fixture().tasks].map(row=>row.id))assert(!visible.includes(id),'raw ID in DOM/raster');
 assert(!outputs.includes('secret-token-never-display'));return 0;
 };
 await check('canonical statuses, next actions, elapsed boundaries, unknown and units',async()=>{
 await load(fixture());const r=await page.evaluate(()=>({rows:document.querySelector('#working-rows').textContent,details:clarityUI.questLines({id:S.work.items()[5].task_ref}),rewards:document.querySelector('#working-rewards').textContent,speed:document.querySelector('#speeds').getAttribute('aria-label')}));
 for(const word of ['Hero ·','Build quest','Running','Blocked','Failed','Unknown','Next:','Running for <1 min'])assert(r.rows.includes(word),word);
 assert(!r.rows.includes('0 min'));assert(r.details.includes('Run time: unavailable'));assert(r.details.includes('Actions: unavailable'));assert(r.details.includes('Time limit: <1 min'));
 for(const unit of ['quests completed today','Guild XP','game gold','Guild level'])assert(r.rewards.includes(unit));
 for(const speed of [30,120,600]){
   const copy=await page.evaluate(speed=>{S.speed=speed;hudT=1;hud(0);const el=document.querySelector('#speeds');return {visible:el.textContent,aria:el.getAttribute('aria-label'),title:el.title};},speed);
   assert.deepEqual(copy,{visible:speed+'×',aria:'Replay speed: '+speed+'×',title:'Replay speed: '+speed+'×'});
 }
 await page.evaluate(()=>{S.t+=30;hudT=1;hud(0);});assert((await page.locator('#working-rows').textContent()).includes('Running for 1 min'));
 await privacy();
 });
 await check('legacy Quest/Hero/Campaign/Activity text and private canaries',async()=>{
 await load(fixture(false));await page.evaluate(()=>{const t=task(D.tasks[0].id);Object.assign(t,{state:'fight',runStart:S.t-30,max_rt:30,moa:true,mock:true,alpha:1});quest(t);});
 let text=await page.locator('#quest').textContent();for(const word of ['Quest title hidden to protect privacy','Running for <1 min','Time limit: <1 min','Tag: MoA Demo'])assert(text.includes(word),word);
 await page.evaluate(()=>{UIPanels.close();heroDialog(Object.values(S.heroes)[0]);});await privacy();
 await page.evaluate(()=>{UIPanels.close();UIPanels.menu(true);document.querySelector('#group-overview').open=true;document.querySelector('#chron').hidden=false;S.feed=[{t:S.t,html:D.tasks[0].title+' '+D.bots[0].profile_name+' '+D.tasks[0].id}];renderFeed();clarityUI.renderCamps();});
 await privacy();const camps=await page.evaluate(()=>clarityPayload.camps[0]);assert(camps[0].count.includes('quests complete'));
 await page.evaluate(()=>{UIPanels.menu(false);clarityUI.chooseCharacters([{type:'hero',id:D.bots[0].id},{type:'monster',id:D.tasks[0].id}]);});await privacy();
 const states=await page.evaluate(()=>['quest','caged','blocked','failed','done'].map(state=>clarityUI.questLines({...D.tasks[0],state})));
 for(const [i,state] of ['Waiting to start','Waiting on a dependency','Blocked','Failed','Complete'].entries())assert(states[i].some(line=>line.includes(state)&&line.includes('Next:')),state);
 await page.evaluate(()=>{S.feed=[];renderFeed();});assert.equal((await page.evaluate(()=>clarityPayload.feed[1])).loading,false);assert.equal((await page.evaluate(()=>clarityPayload.feed[1])).empty,'No activity for this filter in saved history');
 });
 await check('privacy-safe Issues vs Work and open Activity/Campaign stale recovery',async()=>{
 await load(fixture(false));
 await page.evaluate(()=>{UIPanels.menu(true);document.querySelector('#group-overview').open=true;document.querySelector('#chron').hidden=false;document.querySelector('#camp').hidden=false;S.feed=[];
 say('⛓ Quest blocked: '+D.tasks[0].id,S.t);say('💀 Hero stopped (crashed)',S.t);say('📖 Read document',S.t);renderFeed();clarityUI.renderCamps();});
 const filter=async value=>page.evaluate(value=>{const el=document.querySelector('#feed-filter');el.value=value;el.dispatchEvent(new Event('change'));},value);
 await filter('all');assert.equal(await page.locator('#feed section').count(),3);
 await filter('issues');assert.equal(await page.locator('#feed section').count(),2);
 await filter('work');assert.equal(await page.locator('#feed section').count(),1);assert(!(await page.locator('#feed').textContent()).includes('Quest stopped'));
 await filter('all');
 for(const [selector,heading] of [['#feed section button','Activity details'],['#camps section button','Campaign details']]){
   await page.locator(selector).first().evaluate(el=>el.click());assert.equal(await page.locator('#dialog-heading').textContent(),heading);
   const fail=async()=>page.evaluate(async()=>{liveFeed=true;lastPollOk=Date.now();pollFailures=0;const old=fetch;for(const status of [422,503,503]){window.fetch=async()=>({ok:false,status});await pollEvents();clearTimeout(pollTimer);}hudT=1;hud(0);window.fetch=old;});
   await fail();
   let text=await page.locator('#quest').textContent();for(const copy of ['Stale data','Last successful update:','Reason:','Retrying in'])assert(text.includes(copy),heading+' '+copy);
   assert.equal(await page.evaluate(()=>document.activeElement===document.querySelector('#quest .close')),true,'stale does not steal focus');await privacy();
   await page.locator('#quest .close').click();await page.locator(selector).first().evaluate(el=>el.click());assert((await page.locator('#quest').textContent()).includes('Stale data'),'open while stale');
   await page.evaluate(async()=>{const old=fetch;window.fetch=async()=>({ok:true,json:async()=>({state:'online',events:[],bots:[],tasks:[],cursor:null})});await pollEvents();clearTimeout(pollTimer);hudT=1;hud(0);window.fetch=old;});
   text=await page.locator('#quest').textContent();for(const copy of ['Stale data','Last successful update:','Reason:','Retrying in'])assert(!text.includes(copy),'recovery clears '+copy);
   assert.equal(await page.evaluate(()=>document.activeElement===document.querySelector('#quest .close')),true,'recovery does not steal focus');await privacy();await page.locator('#quest .close').click();
 }
 });
 await check('server error vs offline, three-failure stale payload and success recovery',async()=>{
 await load(fixture());const r=await page.evaluate(async()=>{
 liveFeed=true;following=true;lastPollOk=Date.now();const old=fetch;
 const failure=async status=>{window.fetch=async()=>({ok:false,status});await pollEvents();clearTimeout(pollTimer);return structuredClone(clarityPayload.status);};
 const one=await failure(503),two=await failure(500),three=await failure(503),stale={stale:clarityPayload.overview[0].stale,staleInfo:clarityPayload.overview[0].staleInfo};
 window.fetch=async()=>{throw new TypeError('secret-token-never-display');};await pollEvents();clearTimeout(pollTimer);const network=structuredClone(clarityPayload.status);
 window.fetch=async()=>({ok:true,json:async()=>({state:'online',events:[],bots:[],tasks:[],cursor:null})});await pollEvents();clearTimeout(pollTimer);hudT=1;hud(0);const success=structuredClone(clarityPayload.status),recovered=clarityPayload.overview[0].stale;window.fetch=old;
 return {one,two,three,stale:{stale:stale.stale,info:stale.staleInfo},network,success,recovered};
 });
 assert(!r.one[0].includes('Offline'));assert(r.one[0].includes('Server error (503)'));assert.equal(r.one[2].status,503);assert.equal(r.three[1],'stale');assert(r.three[0].includes('Last successful update:'));assert.equal(r.stale.stale,true);assert.equal(r.network[1],'stale');assert.equal(r.success[1],'online');assert.equal(r.recovered,false);await privacy();
 });
 await check('focus identity, non-mutating draw and real observed contact',async()=>{
 await load(fixture());await page.locator('.work-row').nth(1).focus();await page.evaluate(()=>{const items=S.work.items();items[0].status='done';mergeDelta({events:[],bots:[],tasks:[],cursor:null,working:{as_of:S.work.asOf+1,items,resting_count:1,latest_order:null,progress:S.work.progress()}});hudT=1;hud(0);});
 assert((await page.evaluate(()=>document.activeElement.textContent)).includes('Nova 2'));
 const r=await page.evaluate(()=>{const before=JSON.stringify([S.tasks,S.heroes,S.work.items()]);draw();const after=JSON.stringify([S.tasks,S.heroes,S.work.items()]);const row=S.work.active()[0];S.play=true;D.meta.to=S.t+3600;apply({t:S.t,kind:'tool',bot:row.bot_ref,task:row.task_ref,tool:'terminal'},true);update(.01);update(.23);const a=workingPairs()[0].monster.activity;return {before,after,total:a.total,combo:a.hitCombo,hp:workingPairs()[0].monster.hp};});
 assert.equal(r.before,r.after);assert.equal(r.total,1);assert.equal(r.combo,1);assert.equal(r.hp,null);
 });
 for(const [width,height] of [[1440,900],[1024,768],[390,844],[375,667],[320,568]])await check('viewport '+width+' crowd/long labels, empty center and privacy',async()=>{
 await page.setViewportSize({width,height});await load(fixture());await page.waitForTimeout(100);
 await page.evaluate(()=>{resize();draw();});await page.waitForTimeout(200);await page.evaluate(()=>draw());
 const measure=()=>page.evaluate(()=>{const drawn=UIPanels.diagnostics().drawn;const rendered=[...document.querySelectorAll('#ui-stage canvas')].filter(c=>!c.hidden&&c.rasterText).map(c=>({text:c.rasterText,ink:c.getContext('2d').getImageData(0,0,c.width,c.height).data.some((v,i)=>i%4===3&&v>0)}));return {drawn,rendered,overflow:document.documentElement.scrollWidth>innerWidth,labels:clarityText.slice(-100),camera:{...cam},width:innerWidth,height:innerHeight};});
 const r=await measure();assert(!r.overflow,'horizontal overflow');assert(r.drawn.length>0,'blank labels');
 for(let i=0;i<r.drawn.length;i++){const a=r.drawn[i];assert(a.left>=0&&a.right<=width&&a.top>=0&&a.bottom<=height,'clipped label');for(let j=i+1;j<r.drawn.length;j++){const b=r.drawn[j];assert(!(a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top),'label overlap');}}
 await privacy();await page.screenshot({path:path.join(out,engine+'-'+width+'-working.png')});
 // Permitted long aliases remain complete, and crowd still exposes retained identities.
 const long=fixture();long.bots.forEach((b,i)=>b.display_name='Long Friendly Worker Alias '+(i+1));long.working.items.forEach((item,i)=>item.display_name='Long Friendly Worker Alias '+(i+1));await load(long);await page.evaluate(()=>{resize();draw();});await page.waitForTimeout(200);await page.evaluate(()=>draw());
 const aliases=['Long Friendly Worker Alias 1','Long Friendly Worker Alias 2'];
 const wrapped=await measure();assert(wrapped.drawn.length>1);assertRenderedAliases(wrapped.rendered,width>760?aliases:aliases.slice(0,1));
 // Narrow screens expose each pair through the existing focus control. Prove
 // every identity in its own view, rather than mistaking an off-screen pair for ink.
 for(const [i,alias] of aliases.entries()){
   await page.evaluate(i=>{workView.focus=S.work.active()[i].ref;draw();},i);
   assertRenderedAliases((await measure()).rendered,[alias]);
 }
 await page.evaluate(()=>{workView.focus=null;draw();});
 // Drop actual Hero draws, not just the recorded inputs; the same gate must reject it.
 await page.evaluate(()=>{window.savedScreenLabel=UIPanels.screenLabel;UIPanels.screenLabel=(text,...args)=>{if(!/Hero|Long Friendly|Alias/i.test(text))return savedScreenLabel(text,...args);};draw();});
 const dropped=await measure();assert.throws(()=>assertRenderedAliases(dropped.rendered,aliases),/missing rendered identity|nonempty rendered/);
 await page.evaluate(()=>{UIPanels.screenLabel=savedScreenLabel;delete window.savedScreenLabel;draw();});
 for(let i=0;i<wrapped.drawn.length;i++){const a=wrapped.drawn[i];assert(a.left>=0&&a.right<=width&&a.top>=0&&a.bottom<=height);for(let j=i+1;j<wrapped.drawn.length;j++){const b=wrapped.drawn[j];assert(!(a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top),'long labels overlap');}}
 await privacy();await page.screenshot({path:path.join(out,engine+'-'+width+'-long.png')});
 await page.evaluate(()=>document.querySelector('#working-toggle').click());await page.evaluate(()=>draw());await privacy();
 const crowd={meta:{from_:0,to:600,show_titles:false,source:'demo'},bots:[],events:[],tasks:Array.from({length:18},(_,i)=>({id:'synthetic-private-quest-'+i,title:secret[0],stage:'BUILD',campaign:secret[3]}))};await load(crowd);
 await page.evaluate(()=>{reset(0);for(const row of D.tasks)spawnMonster(task(row.id),'forge');const [x,y]=plazaOf('forge').center;Object.assign(cam,{x,tx:x,y:y-40,ty:y-40,zi:1});S.play=true;S.speed=1;for(let i=0;i<9000;i++)update(1/60);S.play=false;resize();draw();});assert((await page.locator('#scene-overflow').textContent()).includes('+6'));await page.locator('#scene-overflow button').click();assert.equal(await page.locator('#quest .item-summary').count(),18);
 await page.locator('#quest .item-summary').nth(17).locator('button').click();await page.evaluate(()=>draw());assert.equal(await page.locator('#scene-selected').getAttribute('aria-label'),'Selected Build quest #18');await privacy();
 await page.waitForTimeout(200);await page.evaluate(()=>draw());await page.screenshot({path:path.join(out,engine+'-'+width+'-crowd.png')});
 const empty={meta:{from_:0,to:600,show_titles:false,source:'demo'},tasks:[],bots:[],events:[],working:{as_of:600,items:[],resting_count:0,latest_order:null,progress:{wins_today:0,xp:0,gold:0,level:1,level_progress:0}}};await load(empty);await page.evaluate(()=>{resize();draw();});
 const e=await measure();assert.equal(e.camera.x,await page.evaluate(()=>W.size[0]/2));assert.equal(e.camera.y,await page.evaluate(()=>W.size[1]/2));assert(e.labels.includes('No active quests'));
 await page.waitForTimeout(200);await page.evaluate(()=>draw());await page.screenshot({path:path.join(out,engine+'-'+width+'-empty.png')});
 });
 await check('first-load 503 has functional Retry',async()=>{
 const errorPage=await browser.newPage();await errorPage.addInitScript(()=>window.__questTestGlobals=true);let fails=true;
 await errorPage.route('**/api/plugins/hermes-quest/replay?**',r=>fails?r.fulfill({status:503,json:{detail:'secret-token-never-display'}}):r.fulfill({json:{...fixture(),cursor:'synthetic'}}));
 await errorPage.route('**/api/plugins/hermes-quest/events?**',r=>r.fulfill({json:{state:'online',events:[],tasks:[],bots:[],cursor:'synthetic'}}));
 await errorPage.goto('http://127.0.0.1:'+server.address().port+'/?live=1');await errorPage.waitForSelector('#quest-load-error button');assert((await errorPage.locator('#quest-load-error').textContent()).includes("Couldn't load Quest data (503)"));
 assert(!(await errorPage.locator('body').textContent()).includes('secret-token-never-display'));fails=false;await errorPage.locator('#quest-load-error button').click();await errorPage.waitForFunction(()=>typeof loop.last==='number');assert.equal(await errorPage.locator('#quest-load-error').count(),0);await errorPage.close();
 });
 records.push({engine,name:'no page errors',pass:errors.length===0,errors});
 }finally{await browser.close();}
 }}finally{await new Promise(r=>server.close(r));}
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(records,null,2));for(const r of records)console.log((r.pass?'PASS':'FAIL')+' '+r.engine+' '+r.name+(r.error?' — '+r.error:''));if(records.some(r=>!r.pass))process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
