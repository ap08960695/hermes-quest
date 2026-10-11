'use strict';
// Real extractor identities from synthetic copied DBs; real poll/replay lifecycle.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process'),{chromium,firefox}=require('playwright');
const root=path.resolve(__dirname,'..'),out=path.resolve(process.argv[2]||'.evidence/idle-source');
const payloads=JSON.parse(execFileSync(process.env.QUEST_PYTHON||'python3',['-c',`
import sys,json,sqlite3
sys.path.insert(0,'tools')
import extract
from test_extract import ExtractTests
x=ExtractTests('test_snapshot_privacy_and_meta'); x.setUp()
try:
    x.k.execute('DELETE FROM task_events')
    x.event('created', x.now-300); x.event('completed', x.now-200); x.k.commit()
    a=extract.build_replay(x.cfg,12)
    other=x.home/'other-board'; other.mkdir()
    db=sqlite3.connect(other/'kanban.db'); x.k.backup(db)
    db.execute('UPDATE task_events SET created_at=created_at+150'); db.commit(); db.close()
    b=extract.build_replay(dict(x.cfg,hermes_home=str(other),profiles=[],history_dir=str(x.home/'hermes-quest')),12)
    print(json.dumps(dict(A=a,B=b)))
finally:
    x.doCleanups()
`],{cwd:root,encoding:'utf8'}));
const demo=JSON.parse(fs.readFileSync(path.join(root,'data/demo.json')));
function fixture(source){
  const p=payloads[source],d=structuredClone(demo);
  d.meta={...d.meta,...p.meta};d.cursor=p.cursor;d.tasks=[];d.sessions=[];
  d.events=p.events.filter(e=>['created','completed'].includes(e.kind));
  d.working={as_of:p.meta.as_of,items:[],resting_count:0,latest_order:null,
    progress:{wins_today:0,xp:0,gold:0,level:1,level_progress:0,...(source==='A'?{done_days_7d:3}:{})}};
  return d;
}
const a=fixture('A'),b=fixture('B');
assert.deepEqual(a.events.map(e=>e.id),b.events.map(e=>e.id),'reproduces actual global ordinal collision');
assert.notDeepEqual(a.events.map(e=>e.recap_id),b.events.map(e=>e.recap_id));
let source='A',pending=null,replayMode='normal';
const mime={'.js':'text/javascript','.json':'application/json','.html':'text/html','.png':'image/png','.otf':'font/otf'};
const server=http.createServer((req,res)=>{try{
  const u=new URL(req.url,'http://localhost');
  if(u.pathname.endsWith('/replay')){
    res.setHeader('Content-Type','application/json');
    if(replayMode==='pending'){pending=()=>res.end(JSON.stringify(fixture(source)));return;}
    if(replayMode==='fail'){res.writeHead(503).end('{}');return;}
    res.end(JSON.stringify(fixture(source)));return;
  }
  if(u.pathname.endsWith('/events')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({cursor:'switch',events:[],tasks:[],bots:[],meta:fixture(source).meta,working:fixture(source).working}));return;}
  const file=path.resolve(root,u.pathname==='/'?'index.html':u.pathname.slice(1));assert(file.startsWith(root+path.sep));
  res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));
}catch{res.writeHead(404).end();}});
(async()=>{
  fs.mkdirSync(out,{recursive:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));const records=[];
  try{for(const [engine,type] of Object.entries({chromium,firefox})){
    const browser=await type.launch({headless:true}),context=await browser.newContext(),page=await context.newPage(),errors=[];
    try{
      source='A';replayMode='normal';page.on('pageerror',e=>errors.push(e.message));
      await page.addInitScript(()=>window.__questTestGlobals=true);
      const ready=async()=>{await page.waitForFunction(()=>window.__questTest?.S.work.has&&document.querySelector('#idle-recap').onclick);await page.evaluate(()=>{cancelAnimationFrame(raf);clearTimeout(pollTimer);S.play=false;hudT=1;hud(0);});};
      const stored=()=>page.evaluate(()=>localStorage.getItem(QuestIdleRecap.STORAGE_KEY));
      const show=async()=>{await page.evaluate(()=>{hudT=1;hud(0);document.querySelector('#idle-recap').click();});return page.locator('#quest').textContent();};
      await page.goto(`http://127.0.0.1:${server.address().port}/?live=1`);await ready();
      await show();await page.locator('#quest .close').click();
      const seenA=await stored();assert.deepEqual(JSON.parse(seenA),a.events.map(e=>e.recap_id));
      await page.reload();await ready();assert((await show()).includes('0 completed, 0 blocked, 0 failed'));
      await page.locator('#quest .close').click();
      source='B';replayMode='pending';await page.evaluate(()=>{window.switchPoll=pollEvents();});
      await page.waitForFunction(()=>privacyPending);
      assert(await page.locator('#idle-recap').isHidden());
      assert.equal(await page.evaluate(()=>document.querySelector('#idle-recap').onclick),null);
      assert.equal(await stored(),seenA,'pending transition never acknowledges');
      await page.evaluate(()=>document.querySelector('#idle-recap').click());assert.equal(await stored(),seenA);
      assert(pending);pending();pending=null;await page.evaluate(()=>window.switchPoll);await ready();replayMode='normal';
      assert.equal(await stored(),seenA,'committed replay never acknowledges');
      const hot=await show();assert(hot.includes('Work since your last visit: unknown.')&&hot.includes('last 7 days: unknown.'),hot);
      assert(!hot.includes('3 of last 7 days')&&!hot.includes('0 completed'),hot);
      const seenB=await stored();assert(JSON.parse(seenB).includes(b.events.at(-1).recap_id));
      await page.locator('#quest .close').click();
      // Full reload A -> B, with acknowledged A boundary and colliding global IDs.
      await page.evaluate(seen=>localStorage.setItem(QuestIdleRecap.STORAGE_KEY,seen),seenA);
      await page.reload();await ready();assert.equal(await stored(),seenA);
      const reload=await show();assert(reload.includes('Work since your last visit: unknown.')&&!reload.includes('0 completed'),reload);
      await page.locator('#quest .close').click();
      // Failed authoritative replay cannot resurrect B's handler/data as A.
      source='A';replayMode='fail';const beforeFail=await stored();
      await page.evaluate(async()=>{await pollEvents();clearTimeout(pollTimer);hudT=1;hud(0);});
      assert(await page.locator('#idle-recap').isHidden());assert.equal(await stored(),beforeFail);
      assert.equal(await page.evaluate(()=>document.querySelector('#idle-recap').onclick),null);
      replayMode='normal';await page.evaluate(async()=>{await pollEvents();clearTimeout(pollTimer);});await ready();
      assert.equal(await stored(),beforeFail);assert((await show()).includes('3 of last 7 days'));
      await page.locator('#quest .close').click();
      // Rebase may run while the animation loop is stopped. No Working data
      // must hide the rebuilt button immediately, not on a future HUD frame.
      const withoutWorking=fixture('A');delete withoutWorking.working;
      withoutWorking.meta.show_profile_names=!withoutWorking.meta.show_profile_names;
      const beforeEmpty=await stored();
      await page.evaluate(replay=>loadReplay(replay),withoutWorking);
      assert(await page.locator('#idle-recap').isHidden());assert.equal(await stored(),beforeEmpty);
      assert.deepEqual(errors,[]);records.push({engine,hot,reload,failedReplayInvalidated:true,noAutomaticAcknowledgement:true});
    }finally{await context.close();await browser.close();}
  }}finally{server.close();}
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({synthetic_only:true,records},null,2));
  console.log('PASS source switch/reload/replay failure, both engines; bounded source IDs only');
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
