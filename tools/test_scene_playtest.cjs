'use strict';
// Automated observation, not a human rubric score. Default input is synthetic.
// QUEST_PLAYTEST_URL may point to an isolated read-only live candidate; that evidence
// MUST remain private. Neither payloads nor internal bindings are written to reports.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),out=path.resolve(process.argv[2]||'.evidence/playtest');
const data=JSON.parse(fs.readFileSync(path.join(root,'data/demo.json')));
const now=data.meta.to;
data.meta.show_profile_names=true;data.meta.show_titles=false;
data.bots.forEach((b,i)=>b.display_name='Guild Worker '+(i+1));
data.working={as_of:new Date(now*1000).toISOString(),resting_count:4,latest_order:null,
  progress:{wins_today:0,xp:0,gold:0,level:1,level_progress:0},
  items:data.tasks.slice(0,12).map((t,i)=>({ref:'synthetic-work-'+i,bot_ref:t.bot||data.bots[i%data.bots.length].id,task_ref:t.id,run_ref:null,status:'running',started_at:now-3600,display_name:'Guild Worker '+(i+1),class_label:'Guild Worker',quest_label:'Build quest #'+(i+1),quest_kind:'build',group_label:'Other work',parent_ref:null,worker_observed:true}))};
const mime={'.js':'text/javascript','.html':'text/html','.png':'image/png','.json':'application/json','.otf':'font/otf'};
const server=http.createServer((req,res)=>{try{
  const name=new URL(req.url,'http://localhost').pathname,rel=name==='/'?'index.html':name.slice(1),file=path.resolve(root,rel);
  if(!file.startsWith(root+path.sep)||rel.startsWith('.'))throw Error('private path');
  res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');
  res.end(rel==='data/demo.json'?JSON.stringify(data):fs.readFileSync(file));
}catch{res.writeHead(404).end();}});
async function metrics(page){return page.evaluate(()=>{
  draw();const diag=UIPanels.diagnostics(),labels=diag.drawn||[];
  let overlaps=0;for(let i=0;i<labels.length;i++)for(const b of labels.slice(i+1)){const a=labels[i];if(a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top)overlaps++;}
  const running=S.work.active(),buttons=[...document.querySelectorAll('#working-rows > section:first-child button')];
  const refs=workView.pairs.map(p=>p.item.ref),foreground=workView.foreground;
  const pixels=cv.getContext('2d').getImageData(0,0,cv.width,cv.height).data;
  let hash=2166136261;const colors=new Set();for(let i=0;i<pixels.length;i+=64){hash=Math.imul(hash^pixels[i],16777619);colors.add(pixels[i]);}
  return {running:running.length,rows:running.length?buttons.length:0,pairs:refs.length,duplicatePairs:refs.length-new Set(refs).size,foreground,entities:Object.values(foreground).reduce((a,b)=>a+b,0),overlaps,ink:colors.size,signature:hash>>>0,overflow:document.documentElement.scrollWidth>innerWidth,progress:S.work.progress()};
});}
(async()=>{
  fs.mkdirSync(out,{recursive:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=require('./parity/browser_loader.cjs').enable(await chromium.launch({headless:true})),records=[];
  const live=!!process.env.QUEST_PLAYTEST_URL,url=process.env.QUEST_PLAYTEST_URL||'http://127.0.0.1:'+server.address().port;
  try{for(const [width,height,cap] of [[1440,900,20],[1024,768,14],[390,844,8]]){
    const page=await browser.newPage({viewport:{width,height}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
    page.on('requestfailed',r=>errors.push(r.failure()?.errorText));page.on('response',r=>{if(r.status()>=400)errors.push('HTTP '+r.status());});
    await page.goto(url);await page.waitForFunction(()=>typeof loop.last==='number'&&S.work.has);
    // Pause replay, not render/update; there must be life without fabricated work.
    await page.evaluate(()=>{S.play=false;S.t=S.work.asOf;hudT=1;hud(0);draw();});
    const base=await metrics(page);assert.equal(base.rows,base.running);assert.equal(base.duplicatePairs,0);assert(base.entities<=cap);assert.equal(base.overlaps,0);assert.equal(base.overflow,false);assert(base.ink>20);
    await page.screenshot({path:path.join(out,width+'x'+height+'.png')});
    const before=await page.evaluate(()=>({t:S.t,speed:S.speed,play:S.play,following}));
    await page.click('#working-toggle');await page.click('#working-toggle');assert.deepEqual(await page.evaluate(()=>({t:S.t,speed:S.speed,play:S.play,following})),before);
    if(base.running){
      const started=Date.now();await page.locator('#working-rows > section:first-child button').last().click();
      const focused=await metrics(page);assert.equal(focused.pairs,1);assert(Date.now()-started<10000);assert(focused.entities<=cap);
    }
    const samples=[];for(let n=0;n<60;n++){await page.waitForTimeout(1000);const m=await metrics(page);assert(m.entities<=cap);assert.equal(m.overlaps,0);samples.push(m.signature);}
    const windows=[];for(let n=0;n<60;n+=5){const changed=new Set(samples.slice(n,n+5)).size>1;assert(changed,'dead 5 s observation window '+n);windows.push({from:n,to:n+5,moving:changed});}
    const end=await metrics(page);if(!live)assert.deepEqual(end.progress,base.progress);
    assert.deepEqual(errors,[]);
    records.push({width,height,cap,input:live?'private live backend':'synthetic',baseline:base,motionWindows:windows,observedSeconds:60,errors});
    if(!live){
      const empty=structuredClone(data);empty.working.items=[];empty.working.latest_order=null;
      await page.evaluate(d=>{loadReplay(d);S.play=false;S.t=S.work.asOf;hudT=1;hud(0);draw();},empty);
      const emptyBefore=await metrics(page),beats=[];
      for(let n=0;n<12;n++){await page.waitForTimeout(5000);beats.push(await page.evaluate(()=>S.soc.innBeats||0));}
      assert(beats[0]>0);for(let n=1;n<beats.length;n++)assert(beats[n]>beats[n-1]);
      assert.deepEqual((await metrics(page)).progress,emptyBefore.progress);records.at(-1).emptyInnBeats=beats;
    }
    await page.close();
  }}finally{await browser.close();await new Promise(r=>server.close(r));}
  const hash=crypto.createHash('sha256');for(const name of ['game.js','quest/state.js','quest/history.js','quest/ui.js','quest/render.js','quest/social.js','quest/combat.js'])hash.update(fs.readFileSync(path.join(root,name)));
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({runtimeHash:hash.digest('hex'),records,rubric:'NOT_SCORED: independent human playtest required'},null,2));
  console.log('PASS Working captures: 3 viewports, card/row 1:1, caps, overlap, focus, 60 s motion; rubric NOT_SCORED');
})().catch(e=>{console.error(e);process.exitCode=1;});
