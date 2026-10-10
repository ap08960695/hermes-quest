'use strict';
// Synthetic contract fixtures only. No source identifiers are written into the UI.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium,firefox}=require('playwright');
const root=path.resolve(__dirname,'..'),out=path.resolve(process.argv[2]||'.evidence/scene-focus');
const demo=JSON.parse(fs.readFileSync(path.join(root,'data/demo.json')));
function fixture(names=true,titles=false,count=3){
  const data=structuredClone(demo),as_of='2026-10-11T03:00:00Z';
  Object.assign(data.meta,{show_profile_names:names,show_titles:titles});
  data.bots.forEach((b,i)=>{b.display_name=['Nova','Ember','Sage'][i%3]+' '+(i+1);b.profile_name='private-profile-'+i;});
  const items=Array.from({length:count},(_,i)=>({ref:'opaque-work-'+i,status:'running',started_at:'2026-10-11T02:00:00Z',display_name:data.bots[i%data.bots.length].display_name,class_label:'Research Mage',quest_label:'Improve the guild '+(i+1),quest_kind:'build',group_label:'Other work',parent_ref:null,worker_observed:true}));
  for(const status of ['blocked','failed','done','archived'])items.push({...items[0],ref:'opaque-'+status,status,quest_kind:'test'});
  data.working={as_of,items,resting_count:7,latest_order:{at:as_of,action_label:'Assign work',quest_label:'Build quest',recipient_display_name:items[0].display_name},progress:{wins_today:2,xp:120,gold:12,level:2,level_progress:20}};
  return data;
}
const mime={'.js':'text/javascript','.json':'application/json','.png':'image/png','.otf':'font/otf','.html':'text/html'};
const server=http.createServer((req,res)=>{
  try{const name=new URL(req.url,'http://localhost').pathname;res.setHeader('Content-Type',name==='/'?'text/html':mime[path.extname(name)]||'application/octet-stream');res.end(fs.readFileSync(path.join(root,name==='/'?'index.html':name)));}catch{res.writeHead(404).end();}
});
(async()=>{
  fs.mkdirSync(out,{recursive:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));const results=[];
  try{for(const [engine,type] of Object.entries({chromium,firefox})){
    const browser=require('./parity/browser_loader.cjs').enable(await type.launch({headless:true}));
    try{for(const [width,height,cap] of [[1440,900,20],[1024,768,14],[390,844,8]]){
      const page=await browser.newPage({viewport:{width,height}}),errors=[];
      page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
      page.on('requestfailed',r=>errors.push(r.url()));page.on('response',r=>{if(r.status()>=400)errors.push('HTTP '+r.status()+' '+r.url());});
      await page.route('**/data/demo.json',r=>r.fulfill({json:fixture()}));
      // Exercise the real B selector without altering another card's owned modules.
      if(process.env.SCENE_STATE_ROOT)for(const file of ['state.js','history.js'])await page.route('**/quest/'+file,r=>r.fulfill({path:path.join(process.env.SCENE_STATE_ROOT,'quest',file),contentType:'text/javascript'}));
      await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>typeof loop.last==='number');
      await page.evaluate(()=>{cancelAnimationFrame(raf);S.play=false;S.t=S.work.asOf;hudT=1;hud(0);draw();});
      await page.waitForFunction(()=>document.querySelector('#working-count').textContent==='3 working');
      const baseline=await page.evaluate(()=>{
        draw();const d=UIPanels.diagnostics(),canvas=cv.getContext('2d').getImageData(0,0,cv.width,cv.height).data;
        return {count:inspect.picks.length,hero:inspect.picks.filter(p=>p.type==='hero').length,monster:inspect.picks.filter(p=>p.type==='monster').length,pressed:document.querySelectorAll('#working-rows button[aria-pressed=true]').length,
          groups:[...document.querySelectorAll('#working-rows h3,#working-rows summary')].map(el=>el.textContent),completed:document.querySelector('#working-rows details').open,
          labels:d.drawn.length,ink:new Set(Array.from(canvas).filter((v,i)=>i%4!==3)).size,overlap:d.drawn.some((r,i)=>d.drawn.slice(i+1).some(s=>r.left<s.right&&r.right>s.left&&r.top<s.bottom&&r.bottom>s.top)),
          pageOverflow:document.documentElement.scrollWidth>innerWidth};
      });
      assert.equal(baseline.hero,width<=760?1:3);assert.equal(baseline.monster,baseline.hero);assert(baseline.count<=cap);assert.equal(baseline.completed,false);assert.equal(baseline.overlap,false);assert.equal(baseline.pageOverflow,false);assert(baseline.ink>20);
      assert.equal(baseline.labels,baseline.hero+baseline.monster,'scene labels must not silently disappear');
      await page.evaluate(()=>{S.t-=1800;hudT=1;hud(0);});
      assert((await page.locator('#working-rows').textContent()).includes('30 min'),'replay elapsed follows playhead');
      await page.evaluate(()=>{S.t=S.work.asOf;hudT=1;hud(0);});
      assert(!(await page.locator('#working-order').textContent()).includes('Time unknown'));
      assert.equal(await page.locator('#working-resting').textContent(),'7 resting at the Inn');
      assert((await page.locator('#working-rewards').textContent()).includes('Guild XP 120'));
      assert.equal(await page.evaluate(()=>characterName('opaque-work-0')), 'Nova 1');
      if(process.env.SCENE_STATE_ROOT)assert.equal(await page.evaluate(()=>S.work.has),true);
      assert.deepEqual(baseline.groups,['Running · 3','Blocked · 1','Failed / Needs attention · 1','Completed · 1']);
      if(engine==='chromium')await page.screenshot({path:path.join(out,width+'x'+height+'.png')});
      const before=await page.evaluate(()=>({t:S.t,speed:S.speed,play:S.play,following}));
      await page.click('#working-toggle');assert.equal(await page.locator('#working-toggle').textContent(),'Working');
      await page.click('#working-toggle');assert.deepEqual(await page.evaluate(()=>({t:S.t,speed:S.speed,play:S.play,following})),before);
      await page.locator('#working-rows button').nth(2).click();
      assert.equal(await page.locator('#working-rows button[aria-pressed=true]').count(),1);
      assert.equal(await page.evaluate(()=>{draw();return inspect.picks.length;}),2);
      await page.focus('#stage');await page.keyboard.press('Enter');await page.waitForFunction(()=>!document.querySelector('#quest').hidden);
      assert((await page.locator('#quest').textContent()).includes('Build quest #3'));await page.keyboard.press('Escape');
      for(const names of [true,false])for(const titles of [true,false]){
        await page.evaluate(data=>{loadReplay(data,null,Date.parse(data.working.as_of)/1000);S.play=false;hudT=1;hud(0);draw();},fixture(names,titles));
        await page.click('#menu-toggle');await page.locator('#group-overview').evaluate(e=>e.open=true);
        await page.evaluate(()=>{hudT=1;hud(0);});
        const alias=names?'Nova 1':'Research Mage 1';
        assert((await page.locator('#working-rows').textContent()).includes(alias));assert((await page.locator('#heroes-list').textContent()).includes(alias));
        await page.locator('#heroes-list button').first().click();await page.waitForTimeout(150);
        assert((await page.locator('#quest').textContent()).includes(alias));await page.keyboard.press('Escape');
        await page.evaluate(()=>{UIPanels.drawer('chron');S.feed=[{t:S.t,html:D.bots[0].id+' '+D.bots[0].profile_name+' '+D.tasks[0].id}];renderFeed();});await page.waitForTimeout(150);
        const html=await page.locator('body').evaluate(el=>el.innerHTML);
        for(const raw of [demo.bots[0].id,demo.tasks[0].id,'private-profile-','opaque-work-'])assert(!html.includes(raw),raw);
        if(!names)assert(!html.includes('Nova 1'));if(!titles)assert(!html.includes('Improve the guild'));
        await page.evaluate(()=>UIPanels.menu(false));
      }
      await page.evaluate(data=>{loadReplay(data,null,Date.parse(data.working.as_of)/1000);S.play=false;hudT=1;hud(0);draw();},fixture(true,false,24));
      assert.equal(await page.locator('#working-count').textContent(),'24 working');
      assert.equal(await page.locator('#working-rows > section:first-child button').count(),24);
      assert((await page.evaluate(()=>{draw();return inspect.picks.length;}))<=cap);
      await page.locator('#working-rows > section:first-child button').last().click();assert.equal(await page.evaluate(()=>{draw();return inspect.picks.length;}),2);
      const bindings=fixture();
      bindings.working.items[0].bot_ref=demo.bots[0].id;bindings.working.items[0].task_ref=demo.tasks[0].id;
      bindings.working.items[1].bot_ref=demo.bots[0].id;bindings.working.items[1].task_ref=demo.tasks[1].id;
      const joined=await page.evaluate(data=>{
        loadReplay(data);S.play=false;workView.focus=null;
        const h=hero(data.bots[0].id);h.task=data.tasks[0].id;h.atk=.2;
        const pairs=workingPairs();return {bound:pairs[0].hero.cls===h.cls,first:pairs[0].hero.atk,other:pairs[1].hero.atk};
      },bindings);
      assert.equal(joined.bound,true);assert.equal(joined.first,.2);assert.equal(joined.other,-1);
      const fx=await page.evaluate(data=>{
        draw();const before=S.soc.victories||0;
        data.working.as_of=new Date(S.work.asOf*1000+1000).toISOString();data.working.items[0].status='done';
        const delta={events:[],tasks:[],bots:[],cursor:null,working:data.working};liveFeed=true;following=true;S.play=true;mergeDelta(delta);
        const after=S.soc.victories||0,visible=S.fx.filter(f=>f.working&&f.k==='coin').length;
        mergeDelta(delta);draw();return {added:after-before,repeat:(S.soc.victories||0)-after,visible};
      },bindings);
      assert.equal(fx.added,1);assert.equal(fx.repeat,0);assert(fx.visible>0);
      const thai=fixture();thai.working.items[0].display_name='กี่ญู';
      await page.evaluate(data=>{loadReplay(data);workView.focus=null;S.play=false;hudT=1;hud(0);draw();},thai);
      await page.evaluate(()=>UIText.ready());
      await page.waitForFunction(()=>{draw();return UIPanels.diagnostics().drawn.some(r=>r.unicode);});
      const empty=fixture();empty.working.items=[];empty.working.latest_order=null;
      await page.evaluate(data=>{loadReplay(data);S.play=false;hudT=1;hud(0);draw();},empty);
      assert.equal(await page.locator('#working-count').textContent(),'0 working');assert.equal(await page.locator('#working-order').textContent(),'No recent Captain instruction');
      const unknown=fixture();unknown.working.items[0].worker_observed=false;
      await page.evaluate(data=>{loadReplay(data);S.play=false;hudT=1;hud(0);draw();},unknown);
      assert((await page.locator('#working-rows').textContent()).includes('Worker not observed'));
      assert.equal(await page.evaluate(()=>{draw();return inspect.picks.filter(p=>p.type==='hero').length;}),width<=760?0:2);
      const attention=fixture();attention.working.items.push({...attention.working.items[0],ref:'opaque-unknown',status:'unknown'});
      await page.evaluate(data=>{loadReplay(data);S.play=false;hudT=1;hud(0);draw();},attention);
      assert((await page.locator('#working-rows').textContent()).includes('Failed / Needs attention · 2'));
      assert((await page.locator('#working-rows').textContent()).includes('Status unknown'));
      if(process.env.SCENE_STATE_ROOT){
        await page.evaluate(()=>{S.work.clear();hudT=1;hud(0);});
        assert.equal(await page.locator('#working-panel').isVisible(),false);
      }
      assert.deepEqual(errors,[]);results.push({engine,width,height,cap,baseline,errors});await page.close();
    }}finally{await browser.close();}
  }}finally{await new Promise(r=>server.close(r));}
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(results,null,2));console.log('PASS scene focus '+results.length+' engine/viewport cases; 4 privacy combinations, overflow, focus, empty and unknown worker');
})().catch(e=>{console.error(e);process.exitCode=1;});
