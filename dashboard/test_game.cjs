// Behavioral timeline contract; synthetic inputs only, actual game logic.
'use strict';
const fs=require('fs'), vm=require('vm'), assert=require('assert'), path=require('path');
const elements=new Map(), noop=()=>{};
const el=s=>{if(!elements.has(s))elements.set(s,{dataset:{},style:{},classList:{toggle:noop},getContext:()=>({}),setPointerCapture:noop});return elements.get(s)};
const sandbox={console,URLSearchParams,Date,Math,Set,Map,Number,Object,JSON,Promise,encodeURIComponent,AbortController,
  document:{querySelector:el,querySelectorAll:()=>[],body:el('body')},window:{devicePixelRatio:1},
  innerWidth:1440,innerHeight:900,requestAnimationFrame:noop,addEventListener:noop,setTimeout:noop,clearTimeout:noop,performance:{now:()=>0}};
vm.createContext(sandbox);
const connected=require('./ui_test_support.cjs')(sandbox,el);
const src=fs.readFileSync(path.join(__dirname,'../game.js'),'utf8').replace(/\nboot\(\);\s*$/,'\n');
vm.runInContext(src,sandbox);
const run=code=>vm.runInContext(code,sandbox);
sandbox.world=JSON.parse(fs.readFileSync(path.join(__dirname,'../data/world.json')));
run(`W=world; D={meta:{from_:0,to:100,captain:'chief',classes:{builder:'ranger'},regions:{ranger:'forest'},stage_regions:{PLAN:'forge'},show_titles:false},bots:[{id:'builder-one',name:'Builder',cls:'warrior',region:'forge',wallet:'codex'}],tasks:[{id:'q',title:'must hide',campaign:'synthetic',stage:'BUILD'}],events:[]}; normalizeData(); reset(0);`);
assert.strictEqual(run('captainId()'),'chief');
assert.strictEqual(run('D.bots[0].cls'),'ranger'); assert.strictEqual(run('D.bots[0].region'),'forest');
assert.strictEqual(run('D.tasks[0].title'),'q');
assert.strictEqual(run('D.bots[0].name'),'builder-one');
assert.strictEqual(run("regionOf('unknown','PLAN')"),'forge');
run(`mergeDelta({events:[{id:'e1',t:10,kind:'created',task:'q'}],tasks:[],bots:[],cursor:'c1'}); S.play=true; S.speed=1; update(11);`);
assert.strictEqual(run('S.i'),1); assert.strictEqual(run('S.tasks.q.state'),'quest');
run(`mergeDelta({events:[{id:'e1',t:10,kind:'created',task:'q'},{id:'e2',t:12,kind:'completed',task:'q'}],tasks:[],bots:[],cursor:'c2'}); update(2);`);
assert.strictEqual(run('D.events.length'),2); assert.strictEqual(run('S.tasks.q.state'),'done');
// Pausing/scrubbing must preserve history; a late event is sorted and applied exactly once.
run(`S.play=false; reset(11); mergeDelta({events:[{id:'e0',t:5,kind:'dependency_wait',task:'q'}],tasks:[],bots:[],cursor:'c3'});`);
assert.strictEqual(run('S.t'),11); assert.strictEqual(run('S.i'),2); assert.strictEqual(run('S.tasks.q.state'),'quest');
run(`reset(13);`); assert.strictEqual(run('S.tasks.q.state'),'done');
run(`reset(4);`); assert.strictEqual(run('S.tasks.q'),undefined);
assert.strictEqual(run('eventKey({t:2,kind:"x",task:"q"})===eventKey({task:"q",kind:"x",t:2})'),true);
// Snapshot upserts retain event-derived state rather than replacing it with current status.
run(`reset(11); mergeDelta({events:[],tasks:[{id:'q',title:'private',status:'done'}],bots:[],cursor:'c4'});`);
assert.strictEqual(run('S.tasks.q.state'),'quest'); assert.strictEqual(run('S.tasks.q.title'),'q');
const oldCursor=run('cursor');
assert.throws(()=>run(`mergeDelta({events:[{t:'bad'}],tasks:[],bots:[],cursor:'invalid'})`));
assert.strictEqual(run('cursor'),oldCursor);
run(`liveFeed=true; goLive(); update(.1);`);
assert.strictEqual(run('following'),true); assert.strictEqual(run('S.speed'),1);
assert(Math.abs(run('S.t')-Date.now()/1000)<1);
// More than three windows: prerequisite assignment/run/block/sleep state must
// survive eviction, including aggregate gold/mana, not just tail event count.
// Checkpoint metadata/notes are synthetic opt-in prose, not default-private data.
run(`loadReplay({meta:{from_:0,to:7000,show_titles:true},bots:[{id:'worker',name:'Worker',region:'forge',wallet:'codex'}],
  tasks:[{id:'long',stage:'BUILD',campaign:'synthetic'}],cursor:'initial',events:[
  {id:'created',t:1,kind:'created',task:'long'},
  {id:'assigned',t:2,kind:'assigned',task:'long',bot:'worker'},
  {id:'run',t:3,kind:'run_start',task:'long',bot:'worker'},
  {id:'block',t:4,kind:'blocked',task:'long',note:'prerequisite'},
  {id:'sleep',t:5,kind:'run_end',task:'long',bot:'worker',outcome:'rate_limited'},
  ...Array.from({length:6000},(_,i)=>({id:'f'+i,t:10+i,kind:'heartbeat',task:'long',note:'beat'+i}))]});
  S.play=false; following=false; reset(D.meta.from_);`);
assert.strictEqual(run('D.events.length'),2000); assert.strictEqual(run('eventKeys.size'),2000);
assert.strictEqual(run('S.tasks.long.state'),'blocked'); assert.strictEqual(run('S.tasks.long.chained'),true);
assert.strictEqual(run('S.tasks.long.bot'),'worker'); assert.strictEqual(run('S.tasks.long.runStart'),3);
assert.strictEqual(run('S.heroes.worker.sleep'),true); assert.strictEqual(run('S.mana.codex'),100);
run(`mergeDelta({events:[],tasks:[{id:'long',title:'Updated metadata',status:'done'}],bots:[{id:'worker',name:'Updated bot',model:'sol',effort:'high'}],cursor:'metadata-after-checkpoint'}); reset(D.meta.from_);`);
assert.strictEqual(run('S.tasks.long.title'),'Updated metadata');assert.strictEqual(run('S.tasks.long.state'),'blocked');
assert.strictEqual(run('S.heroes.worker.name'),'Updated bot');assert.strictEqual(run('S.heroes.worker.model'),'sol');
assert.strictEqual(run('S.heroes.worker.sleep'),true);assert.strictEqual(run('S.mana.codex'),100);
const floor=run('D.meta.from_');
run('reset(0)'); assert.strictEqual(run('S.t'),floor); assert.strictEqual(run('S.tasks.long.note'),'beat3999');
run(`reset(5010); mergeDelta({events:[{id:'f4000',t:4010,kind:'heartbeat',task:'long'},
  {id:'late-inside',t:5009.5,kind:'heartbeat',task:'long',note:'late in window'}],tasks:[],bots:[],cursor:'inside'});`);
assert.strictEqual(run('S.play'),false); assert.strictEqual(run('S.t'),5010);
assert.strictEqual(run('S.tasks.long.note'),'beat5000');
run('reset(5009.75)'); assert.strictEqual(run('S.tasks.long.note'),'late in window');
const heldSpeed=run('S.speed');
run(`reset(D.meta.from_); mergeDelta({events:[{id:'new-tail',t:7001,kind:'heartbeat',task:'long',note:'new tail'}],tasks:[],bots:[],cursor:'moved-floor'});`);
assert.strictEqual(run('S.t'),run('D.meta.from_'));assert.strictEqual(run('S.play'),false);assert.strictEqual(run('S.speed'),heldSpeed);
const boundaryCursor=run('cursor');
assert.throws(()=>run(`mergeDelta({events:[{id:'assigned',t:2,kind:'assigned',task:'long',bot:'worker'}],tasks:[],bots:[],cursor:'overlap'})`),/rebase/);
assert.throws(()=>run(`mergeDelta({events:[{id:'late-before',t:2.5,kind:'dependency_wait',task:'long'}],tasks:[],bots:[],cursor:'outside'})`),/rebase/);
assert.strictEqual(run('cursor'),boundaryCursor);
run('goLive()'); assert.strictEqual(run('S.tasks.long.state'),'blocked'); assert.strictEqual(run('S.i'),2000);
// Bounded metadata, state maps, checkpoint maps, parents and social cache with
// thousands of distinct entities. Previously completed gold remains exact.
run(`loadReplay({meta:{from_:0,to:7000},cursor:'many',
  bots:Array.from({length:7000},(_,i)=>({id:'b'+i,name:'Bot',region:'forge',wallet:'codex'})),
  tasks:Array.from({length:7000},(_,i)=>({id:'q'+i,stage:'BUILD',campaign:'synthetic',bot:'b'+i,parents:['q0']})),
  events:Array.from({length:7000},(_,i)=>({id:'done'+i,t:i+1,kind:'completed',task:'q'+i,bot:'b'+i}))}); reset(8000);`);
assert.strictEqual(run('S.vault'),7000); assert.strictEqual(run('checkpoint.state.vault'),5000);
assert.strictEqual(run('D.events.length'),2000); assert.strictEqual(run('eventKeys.size'),2000);
for(const expression of ['D.tasks.length','D.bots.length','Object.keys(S.tasks).length','Object.keys(S.heroes).length',
  'Object.keys(checkpoint.state.tasks).length','Object.keys(checkpoint.state.heroes).length']) assert(run(expression)<=2256,expression);
assert.strictEqual(run('S.tasks.q0'),undefined); assert.strictEqual(run('D.tasks.some(t=>t.parents.includes("q0"))'),false);
run('friends("b6999")'); assert(run('Object.keys(FRIENDS).length')<=2256);
// Repeated windows do not accumulate entities or dedup keys; metadata-only
// churn is bounded too, even when no new timeline event forces compaction.
run(`for(let batch=0;batch<3;batch++) {
  mergeDelta({events:Array.from({length:2000},(_,i)=>({id:'extra'+batch+'-'+i,t:8001+batch*2000+i,kind:'commented',task:'q6999'})),
    tasks:[],bots:[],cursor:'batch'+batch}); reset(20000);
  if(D.events.length>2000 || eventKeys.size>2000 || D.tasks.length>2256 || D.bots.length>4513 ||
     Object.keys(S.tasks).length>2256 || Object.keys(S.heroes).length>4513 || S.vault!==7000) throw Error('unbounded repeated window');
}
for(let batch=0;batch<3;batch++) {
  // At this point a missing entity would require rebase; use fresh snapshots
  // to exercise the same ingestion bound without bypassing that safeguard.
  loadReplay({meta:{from_:0,to:100},cursor:'metadata'+batch,events:[],
    tasks:Array.from({length:5000},(_,i)=>({id:'m'+batch+'-'+i,stage:'BUILD',campaign:'synthetic'})),
    bots:Array.from({length:5000},(_,i)=>({id:'mb'+batch+'-'+i,name:'Bot',region:'forge'}))}); reset(100);
}`);
assert.strictEqual(run('D.tasks.length'),256); assert.strictEqual(run('D.bots.length'),256);
assert.strictEqual(run('Object.keys(S.heroes).length'),256); assert.strictEqual(run('eventKeys.size'),0);
// Scene truth: typed commenters are not workers; archive snapshots are dated
// tombstones, not a reason to erase the earlier replay or infer inactivity.
run(`loadReplay({meta:{from_:0,to:120,as_of:100,show_titles:false},cursor:'truth',
  session_data:{status:'unavailable',reason:'SYNTHETIC_PRIVATE_PATH'},
  bots:[{id:'worker',entity_type:'profile',availability:{status:'unknown',observed_at:null},region:'forge'},
    {id:'commenter',entity_type:'actor',region:'forge'}],
  tasks:[{id:'old',bot:'worker',stage:'BUILD',status:'archived'}],events:[
    {id:'birth',t:1,kind:'created',task:'old'},
    {id:'run',t:2,kind:'run_start',task:'old',bot:'worker'},
    {id:'comment',t:3,kind:'commented',task:'old',bot:'commenter'}]}); reset(90);`);
assert.strictEqual(run('S.tasks.old.state'),'fight');assert(run('S.tasks.old.alpha')>0);
assert.strictEqual(run('S.heroes.commenter'),undefined);
run('reset(100)');assert.strictEqual(run('S.tasks.old.state'),'archived');assert.strictEqual(run('S.tasks.old.alpha'),0);
assert.strictEqual(run('S.heroes.worker.task'),null);assert(/Unknown/.test(run('heroStatus(S.heroes.worker)')));
run('connectedStatus(D)');assert(/Session activity unavailable/.test(el('#connection').getAttribute('aria-label')));
assert(!el('#connection').getAttribute('aria-label').includes('SYNTHETIC_PRIVATE_PATH'));
run(`apply({t:101,kind:'run_start',task:'old',bot:'worker'},true); reset(90);`);
assert.strictEqual(run('S.tasks.old.state'),'fight');
run(`mergeDelta({meta:{as_of:105},tasks:[{id:'old',status:'archived'}],bots:[],events:[],cursor:'truth-delta'});reset(110);`);
assert.strictEqual(run('S.tasks.old.alpha'),0);
assert.strictEqual(run('D.events.filter(e=>e.kind==="archived").length'),1);
// Assignment cancels queued attacks, ranged hits and pending order callbacks.
run(`loadReplay({meta:{from_:0,to:100},bots:[{id:'a',cls:'ranger',region:'forge'}, {id:'b',region:'forge'}],
  tasks:[{id:'transfer',bot:'a',stage:'BUILD'}],events:[]});reset(0);
  apply({t:1,kind:'run_start',task:'transfer',bot:'a'},false);
  const oldStrike={t:2,kind:'tool',task:'transfer',bot:'a',tool:'write_file'};
  apply(oldStrike,true);strike(S.heroes.a,S.tasks.transfer,oldStrike);
  apply({t:3,kind:'assigned',task:'transfer',bot:'b'},true);
  apply({t:4,kind:'run_start',task:'transfer',bot:'b'},false);
  S.tasks.transfer.flash=0;S.heroes.a.combo=0;strike(S.heroes.a,S.tasks.transfer,oldStrike);
  S.rt+=100;for(const pending of S.later)pending.f();S.later=[];`);
assert.strictEqual(run('S.tasks.transfer.bot'),'b');assert.strictEqual(run('S.heroes.a.task'),null);
assert.strictEqual(run('S.heroes.a.q.length'),0);assert.strictEqual(run('S.heroes.a.combo'),0);
assert.strictEqual(run('S.tasks.transfer.flash'),0);
run(`apply({t:5,kind:'tool',task:'transfer',bot:'b',tool:'write_file'},true);
  apply({t:6,kind:'run_end',task:'transfer',bot:'b',outcome:'interrupted'},true);`);
assert.strictEqual(run('S.heroes.b.task'),null);assert.strictEqual(run('S.heroes.b.q.length'),0);
// Slots reserve shared space for both entity kinds; overflow never wraps to 0.
run(`loadReplay({meta:{from_:0,to:100},bots:[],events:[],tasks:Array.from({length:18},(_,i)=>({id:'crowd'+i,stage:'BUILD'}))});reset(0);
  for(const row of D.tasks)spawnMonster(task(row.id),'forge');`);
assert.strictEqual(run('formation("forge").length'),12);
assert.strictEqual(run('new Set(Object.values(S.tasks).map(t=>t.placement.k)).size'),18);
assert.strictEqual(run('Object.values(S.tasks).filter(t=>t.placement.k>=12).length'),6);
assert(run(`Object.values(S.tasks).filter(t=>t.placement.k<12).every(t=>{
  const {center:[x,y],standing:[rx,ry]}=plazaOf('forge');return ((t.x-x)/rx)**2+((t.y-y)/ry)**2<=1;})`));
console.log('PASS scene truth, dated archives, ownership/interrupted queues, unknown/unavailable and 18-task formation');
// Fake clock exercises the production 35s deadline without waiting in CI.
// Both stalled headers and stalled JSON bodies must abort and then recover via
// the scheduled 10s retry with the SAME cursor and no overlapping poll.
let finished=false;
process.on('beforeExit',()=>{if(!finished){console.error('FAIL: asynchronous regression did not complete');process.exitCode=1}});
(async()=>{
  const timers=new Map(); let timerId=0;
  sandbox.setTimeout=(fn,ms)=>{timers.set(++timerId,{fn,ms});return timerId};
  sandbox.clearTimeout=id=>timers.delete(id);
  const fire=ms=>{const entry=[...timers].find(([,t])=>t.ms===ms);assert(entry,`missing ${ms}ms timer`);timers.delete(entry[0]);return entry[1].fn()};
  const tick=async()=>{for(let i=0;i<50;i++)await Promise.resolve()};
  const retryOnly=()=>assert.deepStrictEqual([...timers.values()].map(t=>t.ms),[10000]);
  // Reviewer F3 repro, extended through compaction, late insertion and rebase.
  // Real ACTIONS/pollEvents/update; assert fx, feed and gold, not just final state.
  const RealDate=sandbox.Date;
  sandbox.Date=class extends RealDate {static now(){return 100000}};
  sandbox.effectCalls=[];
  run(`const originalApply=apply; apply=(e,fx)=>{if(fx) effectCalls.push(eventKey(e));return originalApply(e,fx)};`);
  const fixture=n=>({meta:{from_:0,to:100},cursor:'old',
    bots:[{id:'b',name:'Synthetic',cls:'mage',region:'forge',wallet:'codex'}],
    tasks:[{id:'evicted',stage:'BUILD'},...Array.from({length:256},(_,i)=>({id:'meta'+i,stage:'BUILD'})),
      {id:'q',title:'Synthetic',stage:'BUILD',campaign:'synthetic',bot:'b'}],
    events:[{id:'initial',t:1,kind:'created',task:'q'},
      ...Array.from({length:n-1},(_,i)=>({id:'old'+i,t:2+i*78/n,kind:'commented',task:'q'}))]});
  const actions=(task,prefix,t)=>[
    {id:prefix+'run',t,kind:'run_start',task,bot:'b'},
    {id:prefix+'tool',t:t+1,kind:'tool',task,bot:'b',tool:'write_file'},
    {id:prefix+'done',t:t+2,kind:'completed',task,bot:'b'}];
  const setup=replay=>{sandbox.fxReplay=replay;run(`loadReplay(cloneState(fxReplay)); reset(100); S.stop=0; S.play=true; S.speed=1; liveFeed=true; following=true; effectCalls.length=0;`)};
  const poll=async(delta,replay)=>{
    sandbox.fetch=async url=>({ok:true,json:async()=>JSON.parse(JSON.stringify(url.includes('events?')?delta:replay))});
    await run('pollEvents()');run('S.stop=0; update(.001)');retryOnly();
    assert(connected('online'));
  };
  const assertEffects=expected=>assert.deepStrictEqual(sandbox.effectCalls,expected);
  for(const n of [1,1999,2000,2200]) {
    setup(fixture(n)); const fresh=actions('q','fresh',90);
    const delta={events:fresh,tasks:[],bots:[],cursor:'fresh'};
    await poll(delta);assertEffects(fresh.map(e=>e.id));
    assert.strictEqual(run('S.feed.length'),2);assert(run('S.fx.some(f=>f.k==="coin")'));
    assert(run('S.tasks.q.dying')>0);assert.strictEqual(run('S.vault'),1);
    assert.strictEqual(run('cursor'),'fresh');assert(run('D.events.length')<=2000);
    await poll(delta);assertEffects(fresh.map(e=>e.id));assert.strictEqual(run('S.feed.length'),2);assert.strictEqual(run('S.vault'),1);
    // Truly late relative to the APPLIED event boundary, not the wall clock.
    const late={id:'late-tool',t:85,kind:'tool',task:'q',bot:'b',tool:'write_file'};
    await poll({...delta,events:[fresh[0],late]});
    assertEffects([...fresh.map(e=>e.id),'late-tool']);assert.strictEqual(run('S.vault'),1);
    assert.strictEqual(run('S.feed.length'),2);
  }
  // Oversized live batch: new actions in the evicted prefix still fire once.
  setup(fixture(2000));
  const large=[...actions('q','large',81),...Array.from({length:2100},(_,i)=>({id:'tail'+i,t:84+i/1000,kind:'commented',task:'q'}))];
  await poll({events:large,tasks:[],bots:[],cursor:'large'});
  assertEffects(large.map(e=>e.id));assert.strictEqual(run('S.vault'),1);assert.strictEqual(run('S.feed.length'),2);
  assert.strictEqual(run('D.events.length'),2000);assert.strictEqual(run('eventKeys.size'),2000);
  // New entity and an evicted entity both trigger authoritative replay rebase.
  run(`for(let i=0;i<7000;i++) say('synthetic',i,'throttle'+i,1);`);
  assert.strictEqual(run('Object.keys(S.lastFeed).length'),2000);assert.strictEqual(run('S.feed.length'),60);
  let snapshot=fixture(2200);setup(snapshot);let allFresh=[];
  for(const [taskId,prefix,t] of [['new','new',90],['evicted','returned',94]]) {
    const fresh=actions(taskId,prefix,t);allFresh.push(...fresh.map(e=>e.id));
    snapshot.events.push(...fresh);snapshot.tasks.push({id:taskId,title:'Synthetic',stage:'BUILD',campaign:'synthetic',bot:'b'});snapshot.cursor=prefix;
    await poll({events:[snapshot.events[0],...fresh],tasks:[snapshot.tasks.at(-1)],bots:[],cursor:'delta'},snapshot);
    assertEffects(allFresh);assert.strictEqual(run('S.feed.length'),allFresh.length/3*2);
    assert.strictEqual(run('S.vault'),allFresh.length/3);assert.strictEqual(run('cursor'),prefix);
    assert.strictEqual(run('D.events.length'),2000);assert.strictEqual(run('eventKeys.size'),2000);
    await poll({events:[snapshot.events[0],...fresh],tasks:[],bots:[],cursor:'overlap'},snapshot);
    assertEffects(allFresh);assert.strictEqual(run('S.vault'),allFresh.length/3);
  }
  // Snapshot may contain fresh events absent from the delta. While fetching it,
  // the prior timeline can advance: those already played must NOT fire twice.
  const queued={id:'queued',t:97,kind:'compress',task:'q',bot:'b',before:10,after:5};
  run('S.stop=0');await poll({events:[queued],tasks:[],bots:[],cursor:'queued'});
  allFresh.push('queued');snapshot.events.push(queued);
  const extra={id:'snapshot-only',t:98,kind:'compress',task:'q',bot:'b',before:12,after:6};
  snapshot.events.push(extra);snapshot.cursor='snapshot-only';
  await poll({events:[snapshot.events[0]],tasks:[],bots:[],cursor:'overlap'},snapshot);
  allFresh.push('snapshot-only');assertEffects(allFresh);assert.strictEqual(run('S.vault'),2);
  const inFlight={...extra,id:'in-flight',t:99}, afterFlight={...extra,id:'after-flight',t:99};
  sandbox.inFlight=inFlight;
  run(`mergeDelta({events:[inFlight],tasks:[],bots:[],cursor:'waiting'}); S.stop=0;`);
  snapshot.events.push(inFlight,afterFlight);
  sandbox.fetch=async url=>{
    if(url.includes('replay?')) run('update(.001)'); // actual playback while snapshot request resolves
    return {ok:true,json:async()=>JSON.parse(JSON.stringify(url.includes('events?')?
      {events:[snapshot.events[0]],tasks:[],bots:[],cursor:'overlap'}:snapshot))};
  };
  await run('pollEvents()');run('S.stop=0; update(.001)');retryOnly();
  allFresh.push('in-flight','after-flight');assertEffects(allFresh);
  // Paused/scrub reconstruction is silent, including new-entity rebase, LIVE
  // jump, and subsequent repeated overlap. Replay playback remains independent.
  const paused=actions('paused','paused',99);snapshot.events.push(...paused);snapshot.tasks.push({id:'paused',stage:'BUILD',bot:'b'});
  run('S.play=false; following=false; reset(96)');
  await poll({events:paused,tasks:[snapshot.tasks.at(-1)],bots:[],cursor:'paused'},snapshot);
  assertEffects(allFresh);assert.strictEqual(run('S.play'),false);assert.strictEqual(run('S.t'),96);
  run('reset(100); goLive()');assertEffects(allFresh);assert.strictEqual(run('S.feed.length'),0);
  // F5: compaction crosses the applied index while the clock is already past
  // the floor. Assert ACTUAL poll state before any update/reset, then ordinary
  // Play; pause and non-following playback both reconstruct silently.
  for (const [follow, play] of [[true,false],[false,false],[false,true]]) {
    for (const tied of [false,true]) for (const head of [80,81,83,100]) {
      setup(fixture(2000));
      sandbox.head=head; sandbox.follow=follow; sandbox.play=play;
      run('reset(head); following=follow; S.play=play; S.speed=1; effectCalls.length=0;');
      const completions=tied?120:1;
      const fresh=[...Array.from({length:completions},(_,i)=>({id:'evicted-done'+i,t:81,kind:'completed',task:'q',bot:'b'})),
        ...Array.from({length:tied?2000:2100},(_,i)=>({id:'f5-tail'+i,t:82+i/1000,kind:'commented',task:'q'}))];
      sandbox.fetch=async()=>({ok:true,json:async()=>({events:fresh,tasks:[],bots:[],cursor:'f5'})});
      await run('pollEvents()');retryOnly();
      const expectedFloor=tied?81:82.099, expectedHead=Math.max(head,expectedFloor);
      assert.strictEqual(run('S.t'),expectedHead);assert.strictEqual(run('checkpoint.t'),expectedFloor);
      assert.strictEqual(run('S.play'),play);assert.strictEqual(run('following'),follow);assert.strictEqual(run('S.speed'),1);
      assert.strictEqual(run('S.tasks.q.state'),'done');assert.strictEqual(run('S.vault'),completions);
      assert.strictEqual(run('checkpoint.state.vault'),completions);assert.strictEqual(run('checkpoint.state.tasks.q.state'),'done');
      assert.strictEqual(run('cursor'),'f5');assert.strictEqual(run('D.events.length'),2000);assert.strictEqual(run('eventKeys.size'),2000);
      assert.strictEqual(run('S.i'),run('D.events.filter(e=>e.t<=S.t).length'));
      assertEffects([]);assert.strictEqual(run('S.feed.length'),0);assert.strictEqual(run('Object.keys(S.lastFeed).length'),0);
      assert.strictEqual(run('S.fx.some(f=>f.k==="coin"||f.k==="raven")'),false);
      for(const expr of ['D.tasks.length','D.bots.length','Object.keys(S.tasks).length','Object.keys(S.heroes).length',
        'Object.keys(checkpoint.state.tasks).length','Object.keys(checkpoint.state.heroes).length']) assert(run(expr)<=2256,expr);
      // No forced reset or LIVE jump: the production Play control resumes.
      run('ui(); if(!S.play) document.querySelector("#play").onclick(); for(let frame=0;frame<40;frame++){S.stop=0;update(1)}');
      assert.strictEqual(run('S.i'),2000);assert.strictEqual(run('S.tasks.q.state'),'done');assert.strictEqual(run('S.vault'),completions);
      assert.strictEqual(run('cursor'),'f5');assert.strictEqual(run('effectCalls.some(id=>id.startsWith("evicted-done"))'),false);
      // Retained overlap must neither rebuild nor award gold a second time.
      sandbox.fetch=async()=>({ok:true,json:async()=>({events:fresh.slice(-10),tasks:[],bots:[],cursor:'f5-overlap'})});
      await run('pollEvents()');retryOnly();
      assert.strictEqual(run('S.vault'),completions);assert.strictEqual(run('S.i'),2000);
      assert.strictEqual(run('checkpoint.state.vault'),completions);assert.strictEqual(run('cursor'),'f5-overlap');
    }
  }
  console.log('PASS: F5 immediate poll + ordinary Play without reset; paused/following/non-following, oversized/tied boundary, floor clamp, exact checkpoint/state/gold/cursor/dedup and silent reconstruction');
  setup(fixture(1)); // isolate the original transport recovery fixture below
  sandbox.Date=RealDate;
  console.log('PASS: actual live poll effects/feed once below/at/after cap, oversized delta, overlap, late insertion, new/evicted entity rebase, snapshot-only actions, silent pause/scrub/LIVE');
  sandbox.fetch=async()=>{throw new Error('synthetic network failure')};
  const retained=run('cursor'), count=run('D.events.length');
  await run('pollEvents()');
  assert.strictEqual(run('cursor'),retained); assert.strictEqual(run('D.events.length'),count);
  assert(connected('offline')); retryOnly();
  for(const phase of ['headers','body']) {
    run('pollFailures=0'); // each phase checks the timeout path alone; three failures in a row is covered by tools/test_live_stale.cjs
    let active=0,maxActive=0,calls=0,signal,requested;
    sandbox.fetch=(url,options)=>{
      calls++; active++;maxActive=Math.max(maxActive,active);signal=options.signal;requested=url;
      signal.addEventListener('abort',()=>active--,{once:true});
      return phase==='headers'?new Promise(()=>{}):Promise.resolve({ok:true,json:()=>new Promise(()=>{})});
    };
    const pending=fire(10000); await tick();
    assert.strictEqual(run('pollBusy'),true); assert.strictEqual(calls,1);
    await run('pollEvents()'); assert.strictEqual(calls,1); // guard accidental concurrent invocation
    assert(requested.endsWith(`since=${encodeURIComponent(retained)}`));
    assert.strictEqual(signal.aborted,false);assert.strictEqual(run('cursor'),retained);
    assert.deepStrictEqual([...timers.values()].map(t=>t.ms),[35000]);
    fire(35000); await pending;
    assert.strictEqual(signal.aborted,true);assert.strictEqual(active,0);assert.strictEqual(maxActive,1);
    assert.strictEqual(run('pollBusy'),false);assert.strictEqual(run('cursor'),retained);
    assert(connected('offline'));retryOnly();
  }
  let requested;
  sandbox.fetch=async url=>{requested=url;return {ok:true,json:async()=>({events:[{id:'recovered',t:101,kind:'completed',task:'q'}],tasks:[],bots:[],cursor:'recovered-cursor'})}};
  await fire(10000);
  assert(requested.endsWith(`since=${encodeURIComponent(retained)}`));
  assert.strictEqual(run('cursor'),'recovered-cursor'); assert.strictEqual(run('D.events.length'),count+1);
  run('S.stop=0; update(.001)');assertEffects(['recovered']);
  assert.strictEqual(run('S.vault'),1);assert.strictEqual(run('S.feed.length'),1);
  assert(connected('online'));retryOnly();
  // Old overlap / unseen late write must rebase from authoritative replay,
  // rather than silently lose prerequisites or count an old completion twice.
  const replay={meta:{from_:0,to:5000},cursor:'snapshot-new',bots:[],tasks:[{id:'long',stage:'BUILD',campaign:'synthetic'}],events:[
    {id:'born',t:1,kind:'created',task:'long'}, {id:'block',t:2,kind:'blocked',task:'long'},
    ...Array.from({length:4000},(_,i)=>({id:'f'+i,t:10+i,kind:'commented',task:'long'}))]};
  sandbox.rebaseReplay=replay;
  run('loadReplay(cloneState(rebaseReplay)); S.play=false; following=false; reset(D.meta.from_); cursor="before-rebase";');
  const oldFloor=run('D.meta.from_'), urls=[];
  const delta={events:[{id:'block',t:2,kind:'blocked',task:'long'},{id:'late-unblock',t:3,kind:'unblocked',task:'long'}],tasks:[],bots:[],cursor:'delta-new'};
  // Failed body during rebase retains the original playhead/checkpoint/cursor.
  let rebaseSignal;
  sandbox.fetch=async(url,options)=>{
    urls.push(url); if(url.includes('events?')) return {ok:true,json:async()=>delta};
    rebaseSignal=options.signal; return {ok:true,json:()=>new Promise(()=>{})};
  };
  const pendingRebase=fire(10000);await tick();fire(35000);await pendingRebase;
  assert.strictEqual(rebaseSignal.aborted,true);assert.strictEqual(run('cursor'),'before-rebase');
  assert.strictEqual(run('S.tasks.long.state'),'blocked');assert.strictEqual(run('D.meta.from_'),oldFloor);retryOnly();
  replay.events.splice(2,0,delta.events[1]);
  sandbox.fetch=async url=>{urls.push(url);return {ok:true,json:async()=>url.includes('events?')?delta:JSON.parse(JSON.stringify(replay))}};
  await fire(10000);
  assert.strictEqual(run('cursor'),'snapshot-new');assert.strictEqual(run('S.tasks.long.state'),'quest');
  assert.strictEqual(run('S.tasks.long.chained'),false);assert.strictEqual(run('S.play'),false);
  assert.strictEqual(run('following'),false);assert.strictEqual(run('S.t'),oldFloor);
  assert.strictEqual(urls.filter(u=>u.endsWith('since=before-rebase')).length,2);
  assert.strictEqual(run('D.events.length'),2000);assert.strictEqual(run('eventKeys.size'),2000);retryOnly();
  run('goLive()');assert.strictEqual(run('S.tasks.long.state'),'quest');assert.strictEqual(run('S.i'),2000);
  // Unique entity churn through ACTUAL polls: each evicted ID reappearance or
  // new entity rebases serially; duplicated old completions never add gold.
  const churn={meta:{from_:0,to:9000},cursor:'churn0',bots:[],tasks:[],events:[]};
  for(let batch=0;batch<4;batch++) {
    const fresh=Array.from({length:2200},(_,i)=>({id:`churn${batch}-${i}`,t:batch*2200+i+1,kind:'completed',task:`cq${batch}-${i}`,bot:`cb${batch}-${i}`}));
    churn.events.push(...fresh);churn.tasks.push(...fresh.map(e=>({id:e.task,bot:e.bot,stage:'BUILD',campaign:'synthetic'})));
    churn.bots.push(...fresh.map(e=>({id:e.bot,name:'Bot',region:'forge',wallet:'codex'})));churn.cursor=`churn${batch+1}`;
    if(batch===0){sandbox.churn=churn;run('loadReplay(cloneState(churn)); S.play=false; following=false; reset(9000);');continue}
    const update={cursor:'ignored-delta',events:[churn.events[0],...fresh],tasks:[],bots:[]};
    sandbox.fetch=async url=>({ok:true,json:async()=>url.includes('events?')?update:JSON.parse(JSON.stringify(churn))});
    await fire(10000);
    assert.strictEqual(run('cursor'),churn.cursor);assert.strictEqual(run('S.vault'),churn.events.length);
    assert.strictEqual(run('S.play'),false);assert.strictEqual(run('S.t'),9000);
    assert.strictEqual(run('D.events.length'),2000);assert.strictEqual(run('eventKeys.size'),2000);
    for(const expression of ['D.tasks.length','D.bots.length','Object.keys(S.tasks).length','Object.keys(S.heroes).length',
      'Object.keys(checkpoint.state.tasks).length','Object.keys(checkpoint.state.heroes).length','Object.keys(S.lastFeed).length']) assert(run(expression)<=2256,expression);
    assert.strictEqual(run('S.tasks["cq0-0"]'),undefined);retryOnly();
  }
  // Metadata-only reappearance is also unsafe after eviction, even without an
  // event referring to it yet. The cursor cannot advance without a rebase.
  const beforeUnknown=run('JSON.stringify({D,checkpoint,cursor,S,keys:[...eventKeys]})');
  assert.throws(()=>run(`mergeDelta({events:[],tasks:[{id:'cq0-0'}],bots:[],cursor:'lost-prerequisite'})`),/rebase/);
  assert.throws(()=>run(`mergeDelta({events:[],tasks:[],bots:[{id:'cb0-0'}],cursor:'lost-bot'})`),/rebase/);
  assert.strictEqual(run('JSON.stringify({D,checkpoint,cursor,S,keys:[...eventKeys]})'),beforeUnknown);
  // Known metadata and provably new tasks remain incremental (no whole replay).
  run(`mergeDelta({events:[],tasks:[{id:'cq3-2199',max_rt:2345}],bots:[{id:'cb3-2199',effort:'high'}],cursor:'known-metadata'});`);
  assert.strictEqual(run('cursor'),'known-metadata');assert.strictEqual(run('S.vault'),churn.events.length);
  assert.strictEqual(run('S.tasks["cq3-2199"].max_rt'),2345);
  run(`mergeDelta({events:[{id:'new-born',t:9001,kind:'created',task:'truly-new'}],tasks:[{id:'truly-new',stage:'BUILD'}],bots:[],cursor:'born-incremental'});`);
  assert.strictEqual(run('cursor'),'born-incremental');assert(run('D.tasks.some(t=>t.id==="truly-new")'));
  // Duplicate metadata IDs cannot circumvent a count bound.
  run(`loadReplay({meta:{from_:0,to:1},cursor:'duplicates',events:[],
    tasks:Array.from({length:5000},()=>({id:'duplicate',stage:'BUILD',parents:['duplicate','duplicate']})),
    bots:Array.from({length:5000},()=>({id:'duplicate-bot',name:'Bot',region:'forge'}))}); reset(1);`);
  assert.strictEqual(run('D.tasks.length'),1);assert.strictEqual(run('D.bots.length'),1);
  assert.strictEqual(run('D.tasks[0].parents.length'),1);
  // Equal timestamps cannot straddle a checkpoint or get replayed twice.
  run(`loadReplay({meta:{from_:0,to:10},cursor:'ties',bots:[],tasks:[],events:Array.from({length:2100},(_,i)=>({id:'tie'+i,t:10,kind:'completed',task:'tie'}))}); reset(0);`);
  assert.strictEqual(run('S.t'),10);assert.strictEqual(run('S.vault'),2100);assert.strictEqual(run('D.events.length'),0);
  run('reset(10)');assert.strictEqual(run('S.vault'),2100);
  assert.throws(()=>run('loadReplay({events:[{t:"invalid"}],tasks:[],bots:[],cursor:"bad"})'),/Invalid replay/);
  assert.strictEqual(run('cursor'),'ties');
  console.log('PASS: timeline + 2000-event checkpoint/prerequisites, 7000-entity bounds, overlap/late boundary rebase, pause/scrub/LIVE, tied timestamps, 35s headers/body abort, failed rebase retention and serial10s recovery');
})().then(()=>{finished=true}).catch(e=>{finished=true;console.error(e);process.exitCode=1});
