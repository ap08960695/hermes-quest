'use strict';
// Synthetic integration tests: execute the shipped classic scripts, not a replica reducer.
// No browser/layout claim; genuine hidden-60s/browser gates belong to the parent suite.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/c-ui.json'), 'utf8'));
const world = JSON.parse(fs.readFileSync(path.join(root, 'data/world.json'), 'utf8'));
const copy = x => JSON.parse(JSON.stringify(x));
const cases = [];
function test(name, f) { cases.push({name, f}); }
function replay(events = [], extra = {}) {
  const {knownLimitations, synthetic, ...base} = copy(fixture);
  return {...base, events: copy(events), ...copy(extra)};
}
function mana(id, t, tokens, bot = 'a', extra = {}) { return {id, t, kind: 'mana', bot, tokens, basis: 'usage', ...extra}; }
function event(id, kind, bot = 'a', extra = {}) { return {id, t: 1, kind, bot, ...extra}; }
function load(events = [], extra = {}, w = world) {
  const elements = new Map(), timers = new Map(), requests = [], responses = [];
  let timerId = 0, now = 10000;
  const noop = () => {};
  const el = selector => {
    if (!elements.has(selector)) elements.set(selector, {getContext: () => ({}), setAttribute: noop, classList: {toggle: noop}});
    return elements.get(selector);
  };
  const ui = new Proxy({plain: String}, {get: (o, k) => o[k] || noop});
  class Clock extends Date { static now() { return now * 1000; } }
  const math = Object.create(Math); math.random = () => .99;
  const box = vm.createContext({console, Date: Clock, Math: math, URLSearchParams, AbortController,
    window: {devicePixelRatio: 1, UIPanels: ui}, document: {hidden: false, querySelector: el, querySelectorAll: () => [], addEventListener: noop},
    setTimeout: f => { timers.set(++timerId, f); return timerId; }, clearTimeout: id => timers.delete(id),
    requestAnimationFrame: () => ++timerId, cancelAnimationFrame: noop,
    fetch: async url => { requests.push(url); const r = responses.shift(); if (!r) throw Error('Unexpected fetch: ' + url); return {ok: true, json: async () => copy(r)}; }});
  vm.runInContext(fs.readFileSync(path.join(root, 'quest/c-ui.js'), 'utf8'), box, {filename: 'quest/c-ui.js'});
  const source = fs.readFileSync(path.join(root, 'game.js'), 'utf8');
  assert.match(source, /\bboot\(\);\s*$/);
  vm.runInContext(source.replace(/\bboot\(\);\s*$/, '') + `\n globalThis.game = {
    S, hero, task, apply, reset, mergeDelta, loadReplay, pollEvents, goLive, update, stepHero,
    restLocked, laterHero, startHangout, engage, order, goHome, finishRestMotion,
    get D(){return D}, get checkpoint(){return checkpoint}, get cursor(){return cursor},
    flags(live,follow,play){liveFeed=live;following=follow;S.play=play},
    setup(w,d){W=w;loadReplay(d);reset(0);S.play=false},
    bounds(){return Object.values(S.mana).every(v=>v>=0&&v<=100)}
  };`, box, {filename: 'game.js'});
  const g = box.game;
  g.setup(copy(w), replay(events, extra));
  g.responses = responses; g.requests = requests; g.timers = timers;
  g.now = value => { now = value; };
  return g;
}
function delta(events, extra = {}) { return {events: copy(events), bots: [], tasks: [], cursor: 'synthetic-next', ...copy(extra)}; }
function net(g, bot = 'a') { return g.S.tokenNetByBot[bot]?.net || 0; }
function wallet(g, name = 'codex') { return g.S.tokenNetByWallet[name].net; }
function near(actual, expected) { assert.ok(Math.abs(actual - expected) <= 1e-9, `${actual} != ${expected}`); }
function ledger(g) { return copy({bots: g.S.tokenNetByBot, wallets: g.S.tokenNetByWallet, mana: g.S.mana}); }
function noUndefined(g) { assert.ok(!Object.hasOwn(g.S.tasks, 'undefined')); }
function roadDistance(x, y, w = world) {
  return Math.min(...w.graph.edges.map(([a, b]) => {
    const A = w.graph.pts[a], B = w.graph.pts[b], dx = B[0]-A[0], dy = B[1]-A[1];
    const t = Math.max(0, Math.min(1, ((x-A[0])*dx+(y-A[1])*dy)/(dx*dx+dy*dy || 1)));
    return Math.hypot(x-A[0]-t*dx, y-A[1]-t*dy);
  }));
}
const motion = {frames: 0, maxSpeed: 0, maxRoadDistanceOutsidePlaza: 0};
function walk(g, seconds, ids = Object.keys(g.S.heroes)) {
  const dt = 1/60;
  for (let i = 0; i < seconds/dt; i++) {
    const old = new Map(ids.map(id => {const h = g.hero(id); return [id, [h.x,h.y,h.dist]];}));
    // Real update executes generation-guarded callbacks and movement, not test-driven teleports.
    g.update(dt);
    for (const id of ids) {
      const h = g.hero(id), p = old.get(id), distance = Math.hypot(h.x-p[0], h.y-p[1]);
      const speed = distance/dt; motion.maxSpeed = Math.max(motion.maxSpeed,speed); motion.frames++;
      assert.ok(speed <= 70 + 1e-7, `speed ${speed} for ${id}`);
      near(distance,h.dist-p[2]);
      const plaza = Object.values(world.regions).some(r => ((h.x-r.spot[0])/112)**2+((h.y-r.spot[1])/66)**2 <= 1+1e-9);
      if (!plaza) { const off = roadDistance(h.x,h.y); motion.maxRoadDistanceOutsidePlaza = Math.max(motion.maxRoadDistanceOutsidePlaza,off); assert.ok(off <= 6 + 1e-7, `off road ${off} for ${id} at [${h.x},${h.y}], phase=${h.rest.phase}, path=${JSON.stringify(h.path)}`); }
    }
  }
}
function settle(g, ids = Object.keys(g.S.heroes)) {
  for (let i=0;i<90;i++) {
    if (ids.every(id => g.hero(id).path.length <= 1 && !['portal','moving','returning'].includes(g.hero(id).rest.phase))) return;
    walk(g,1,ids);
  }
  assert.fail('motion did not settle in 90 seconds');
}

test('signed 100-45=55; flags, shared wallet, no undefined task, reset0/repeated scrub', () => {
  const g = load(fixture.events); g.reset(20);
  assert.equal(net(g),55); assert.equal(wallet(g),55); near(g.S.mana.codex,99.945);
  assert.equal(g.S.tokenNetByBot.a.hasCharsEstimate,true); assert.equal(g.S.tokenNetByBot.a.hasUsageCorrection,true);
  const expected = ledger(g); g.reset(0); assert.equal(net(g),0); assert.equal(wallet(g),0); assert.equal(g.S.mana.codex,100);
  for(let i=0;i<3;i++){g.reset(20);assert.deepEqual(ledger(g),expected);}
  g.mergeDelta(delta([mana('b-25',21,25,'b')]));g.reset(21);
  assert.equal(net(g,'b'),25);assert.equal(wallet(g),80);assert.equal(wallet(g,'agy'),0);assert.ok(g.bounds());noUndefined(g);
});
test('overspend/refund preserves 90000/10; negative-first preserves 100', () => {
  const g=load([mana('over',1,120000),mana('refund',2,-30000,'a',{correction:true})]);g.reset(1);assert.equal(wallet(g),120000);assert.equal(g.S.mana.codex,0);
  g.reset(2);assert.equal(wallet(g),90000);assert.equal(g.S.mana.codex,10);
  const n=load([mana('negative',1,-20,'a',{correction:true}),mana('positive',2,120)]);n.reset(1);assert.equal(net(n),-20);assert.equal(n.S.mana.codex,100);n.reset(2);assert.equal(net(n),100);near(n.S.mana.codex,99.9);
});
test('invalid/zero tokens, invalid bot, unsafe aggregate, unknown wallet', () => {
  const g=load();const values=[null,'100',1.5,Number.MAX_SAFE_INTEGER+1,Infinity,NaN,-1,undefined];
  values.forEach((tokens,i)=>g.apply(mana('bad'+i,1,tokens),false));
  g.apply(mana('no-bot',1,100,'',{}),false);g.apply(mana('zero',1,0),false);g.apply(mana('correction-zero',1,0,'a',{correction:true}),false);
  assert.equal(net(g),0);assert.equal(wallet(g),0);assert.ok(Object.keys(g.S.diagnostics).length);assert.equal(g.S.feed.length,0);
  g.apply(mana('unknown',1,80,'unknown'),false);assert.equal(net(g,'unknown'),80);assert.equal(wallet(g),0);assert.equal(wallet(g,'agy'),0);
  g.apply(mana('max',1,Number.MAX_SAFE_INTEGER),false);g.apply(mana('overflow',2,1),false);assert.equal(net(g),Number.MAX_SAFE_INTEGER);assert.equal(wallet(g),Number.MAX_SAFE_INTEGER);noUndefined(g);
});
test('overlap/duplicate batches and late correction reconstruct once', () => {
  const a=mana('m',10,100),b=mana('r',9,-45,'a',{correction:true});const g=load([a]);g.reset(20);
  g.mergeDelta(delta([a,a,b,b]));assert.equal(net(g),55);const expected=ledger(g);
  g.mergeDelta(delta([a,b]));g.reset(20);assert.deepEqual(ledger(g),expected);assert.equal(g.D.events.length,2);
});
test('canonical equal timestamp id order, not transport order', () => {
  const events=[event('z-resume','resume','a',{t:10}),event('a-pause','pause','a',{t:10,why:'limited'})];
  const g=load(events);g.reset(10);assert.equal(g.hero('a').rest.state,'active');assert.deepEqual(Array.from(g.D.events,e=>e.id),['a-pause','z-resume']);
  const h=load();h.mergeDelta(delta(events));h.reset(10);assert.equal(h.hero('a').rest.state,'active');
});
test('2005 event compaction prefix/tail corrections and outside-floor rebase', () => {
  const events=Array.from({length:2005},(_,i)=>mana('ret-'+String(i).padStart(4,'0'),i+1,1));
  events[0].tokens=100;events[1].tokens=-45;events[1].correction=true;events[2004].tokens=-20;events[2004].correction=true;
  const g=load(events);g.reset(10000);const total=events.reduce((sum,e)=>sum+e.tokens,0);assert.equal(net(g),total);
  assert.equal(g.D.events.length,2000);assert.ok(g.checkpoint);assert.equal(g.checkpoint.state.tokenNetByBot.a.net,58);
  const expected=ledger(g);for(let i=0;i<3;i++){g.reset(10000);assert.deepEqual(ledger(g),expected);}g.reset(0);assert.equal(net(g),58);
  const correction=mana('outside-floor',2.5,-10,'a',{correction:true});assert.throws(()=>g.mergeDelta(delta([correction])),/rebase/);
  g.loadReplay(replay([...events,correction]),null,10000);assert.equal(net(g),total-10);assert.equal(wallet(g),total-10);
  const tail=mana('late-tail',1500.5,-7,'a',{correction:true});g.mergeDelta(delta([tail]));assert.equal(net(g),total-17);assert.ok(g.bounds());
});
test('paused polling then goLive catches overlap/correction/rest exactly once', async () => {
  const a=mana('live-a',10,100);const g=load([a]);g.reset(10);g.flags(true,false,false);
  const events=[a,mana('live-r',20,-45,'a',{correction:true}),event('live-p','pause','a',{t:21,why:'limited'})];
  g.responses.push(delta(events));await g.pollEvents();assert.equal(net(g),100);assert.equal(g.hero('a').rest.state,'active-unobserved');
  g.goLive();assert.equal(net(g),55);assert.equal(g.hero('a').rest.state,'paused');const expected=ledger(g),generation=g.hero('a').rest.generation;
  g.responses.push(delta(events));await g.pollEvents();g.update(1/60);assert.deepEqual(ledger(g),expected);assert.equal(g.hero('a').rest.generation,generation);assert.equal(g.requests.length,2);
});
test('identity migration poll clears old ledgers and commits replacement snapshot', async () => {
  const g=load([mana('old',10,100)]);g.reset(30);g.flags(true,false,false);
  const meta={...fixture.meta,config_revision:'synthetic-v2'};const bots=fixture.bots.map(b=>({...b,id:'new-'+b.id,name:'new-'+b.id}));
  g.responses.push(delta([],{meta}),replay([mana('new',20,7,'new-a')],{meta,bots,tasks:[]}));await g.pollEvents();
  assert.equal(g.requests.length,2);assert.equal(net(g),0);assert.equal(net(g,'new-a'),7);assert.equal(wallet(g),7);assert.ok(!g.S.heroes.a);assert.equal(g.S.feed.length,0);noUndefined(g);
});
test('failed snapshot after mutation rolls ledger/history/cursor back transactionally',()=>{
  const g=load([mana('old',10,100)]);g.reset(20);const expected=ledger(g),cursor=g.cursor,ids=Array.from(g.D.events,e=>e.id);
  // Pass transport shape validation, then fail normalization inside the transaction.
  assert.throws(()=>g.loadReplay(replay([],{bots:[{id:123}],meta:{...fixture.meta,classes:{synthetic:'mage'}}})),/startsWith/);
  assert.deepEqual(ledger(g),expected);assert.equal(g.cursor,cursor);assert.deepEqual(Array.from(g.D.events,e=>e.id),ids);
  g.reset(20);assert.deepEqual(ledger(g),expected);
});
test('paused oversized poll installs prefix and goLive reconstructs retained tail',()=>{
  const g=load();g.flags(true,false,false);g.S.t=10000;
  const events=Array.from({length:2005},(_,i)=>mana('poll-'+i,i+1,i===1?-45:i===2004?-20:100,'a',{correction:i===1||i===2004}));
  const expected=events.reduce((n,e)=>n+e.tokens,0);g.mergeDelta(delta(events));assert.equal(g.D.events.length,2000);assert.ok(g.checkpoint);assert.equal(net(g),expected);assert.equal(wallet(g),expected);
  g.goLive();assert.equal(net(g),expected);assert.ok(g.bounds());
});
for (const [label,f] of Object.entries(fixture.knownLimitations)) test(`${label} KNOWN LIMITATION backend mismatch; transactional snapshot replaces totals`,()=>{
  const g=load(f.liveEvents);g.reset(100);assert.equal(net(g),f.liveNet);const live=net(g);
  assert.throws(()=>g.loadReplay({...replay(),events:[{t:NaN}]}),/Invalid replay/);assert.equal(net(g),live);
  g.loadReplay(replay(f.replayEvents),null,100);assert.equal(net(g),f.replayNet);assert.notEqual(live,net(g));assert.equal(wallet(g),f.replayNet);
  g.loadReplay(replay(f.replayEvents),null,100);assert.equal(net(g),f.replayNet);
  console.log(`KNOWN LIMITATION ${label}: live=${live}, replay=${net(g)}; mismatch preserved, no invented refund`);
});
test('pause/resume midroute: coordinate continuity, road/speed, saved fighting task',()=>{
  const g=load();g.apply(event('run','run_start','a',{task:'q'}),false);const h=g.hero('a');walk(g,2,['a']);
  const start=[h.x,h.y];g.apply(event('pause','pause','a',{why:'limited'}),true);assert.deepEqual([h.x,h.y],start);assert.equal(h.rest.savedTask,'q');assert.equal(h.task,null);assert.equal(h.sleep,true);
  walk(g,2,['a']);const mid=[h.x,h.y];assert.notDeepEqual(mid,start);g.apply(event('resume','resume'),true);assert.deepEqual([h.x,h.y],mid);assert.equal(h.task,'q');assert.equal(h.sleep,false);settle(g,['a']);assert.equal(h.rest.state,'active');
});
test('old order callback guarded across pause/resume; wake/run_start cannot override explicit pause',()=>{
  const g=load();g.apply(event('run','run_start','a',{task:'q'}),true);assert.ok(g.S.later.length>=2);walk(g,1,['a']);g.apply(event('pause','pause','a',{why:'waiting-start'}),true);
  const h=g.hero('a'),generation=h.rest.generation;g.apply(event('wake','wake','a',{task:'q'}),true);g.apply(event('run-again','run_start','a',{task:'q'}),false);
  assert.equal(h.rest.generation,generation);assert.equal(h.rest.state,'paused');assert.equal(h.task,null);walk(g,2,['a']);assert.equal(h.bubble,null);assert.equal(h.rest.target,'rest_inn');
  let stale=0;g.laterHero(h,.01,()=>stale++);g.apply(event('resume','resume'),false);walk(g,.1,['a']);assert.equal(stale,0);
});
test('completed while resting then resume home, no task resurrection',()=>{
  const g=load();g.apply(event('run','run_start','a',{task:'q'}),false);g.apply(event('pause','pause','a',{why:'unavailable'}),true);g.apply(event('done','completed','a',{task:'q'}),true);
  const h=g.hero('a');walk(g,2,['a']);assert.equal(h.rest.state,'paused');assert.equal(g.task('q').state,'done');g.apply(event('resume','resume'),false);assert.equal(h.task,null);assert.equal(h.region,h.home);settle(g,['a']);assert.equal(h.rest.state,'active');
});
test('A->B->C chain cancels stale callbacks, preserves ownership and stays on roads',()=>{
  const g=load();const a=g.hero('a'),b=g.hero('b');let stale=0;g.laterHero(b,2,()=>{stale++;g.goHome(b);});
  g.apply(event('ab','failover','a',{other:'b'}),true);assert.equal(a.rest.state,'transferred');assert.equal(b.rest.phase,'portal');walk(g,.5);
  g.apply(event('bc','failover','b',{other:'c'}),true);assert.equal(b.rest.state,'transferred');walk(g,2);assert.equal(stale,0);assert.equal(a.rest.state,'transferred');assert.equal(b.rest.state,'transferred');assert.equal(g.task('q').bot,'a');settle(g);assert.equal(stale,0);assert.equal(a.rest.state,'transferred');assert.equal(b.rest.state,'transferred');assert.equal(b.rest.phase,'resting');assert.equal(g.hero('c').rest.state,'active');assert.equal(g.task('q').bot,'a');
});
test('busy failover target preserves fighting path/task/rest; only portal FX',()=>{
  const busy=load();busy.apply(event('busy','run_start','b',{task:'q'}),false);const target=busy.hero('b'),before=copy({path:target.path,rest:target.rest,task:target.task});busy.apply(event('busy-ab','failover','a',{other:'b'}),true);
  assert.deepEqual(copy({path:target.path,rest:target.rest,task:target.task}),before);assert.equal(busy.task('q').bot,'b');assert.ok(busy.S.fx.some(f=>f.k==='portal'));
});
test('duplicate failover id through history has no second generation/log/portal',()=>{
  const e=event('same','failover','a',{other:'b',t:10}),g=load();g.flags(true,true,true);g.S.t=10;
  g.mergeDelta(delta([e,e]));g.update(1/60);const generation=g.hero('a').rest.generation,feed=g.S.feed.length,portals=g.S.fx.filter(f=>f.k==='portal').length;
  g.mergeDelta(delta([e]));g.update(1/60);assert.equal(g.hero('a').rest.generation,generation);assert.equal(g.S.feed.length,feed);assert.equal(g.S.fx.filter(f=>f.k==='portal').length,portals);
});
test('concurrent pairs >7: deterministic sorted unique safe resting slots',()=>{
  // Spread initial homes so the test starts on existing paved plazas, not an
  // unrelated overfull home-slot layout; rest-slot overflow remains nine heroes.
  const homes=['castle','forge','vault','forest','tower','observatory','citadel','volcano','port','inn'];
  const bots=Array.from({length:18},(_,i)=>({id:'pair-'+String(i).padStart(2,'0'),cls:'mage',region:homes[i%homes.length],wallet:'codex'}));
  const events=Array.from({length:9},(_,i)=>event('pair-'+i,'failover',bots[i*2].id,{other:bots[i*2+1].id,t:10}));
  const run=order=>{const g=load([],{bots,tasks:[]});for(const e of order)g.apply(e,false);return g;};
  const g=run(events),reverse=run([...events].reverse());const resting=Object.values(g.S.heroes).filter(h=>h.rest.state==='transferred').sort((a,b)=>a.bot.localeCompare(b.bot));
  assert.equal(resting.length,9);assert.equal(Object.keys(g.S.heroes).length,18);assert.equal(new Set(resting.map(h=>h.rest.slot)).size,9);
  const slots=resting.map(h=>h.rest.slot);assert.deepEqual(slots,[...slots].sort((a,b)=>a-b));assert.ok(slots.some(k=>k>=7));
  for(const h of resting){assert.deepEqual(copy(h.rest.spot),copy(reverse.hero(h.bot).rest.spot));assert.equal(h.rest.slot,reverse.hero(h.bot).rest.slot);assert.ok(((h.rest.spot[0]-970)/112)**2+((h.rest.spot[1]-1200)/66)**2<=1);}
  for(let i=0;i<resting.length;i++)for(let j=i+1;j<resting.length;j++)assert.ok(Math.hypot(resting[i].rest.spot[0]-resting[j].rest.spot[0],resting[i].rest.spot[1]-resting[j].rest.spot[1])>=12);
  settle(g);for(const h of resting)assert.equal(h.rest.phase,'resting');
});
test('legacy rate-limit/wake cannot replace a newer explicit rest reason', () => {
  const g=load();g.apply(event('explicit','pause','a',{why:'unavailable'}),false);
  const old=copy(g.hero('a').rest);
  g.apply(event('old-run','run_end','a',{task:'q',outcome:'rate_limited'}),true);
  g.apply(event('old-wake','wake','a',{task:'q'}),true);
  assert.deepEqual(copy(g.hero('a').rest),old);assert.equal(g.hero('a').sleep,true);
});
test('settled repeated pause and sorted slot reassignment remain inside the camp', () => {
  const g=load(), b=g.hero('b');g.apply(event('pause-b','pause','b',{why:'limited'}),true);settle(g,['b']);
  const old=[b.x,b.y];g.apply(event('pause-b-again','pause','b',{why:'unavailable'}),true);walk(g,.1,['b']);
  assert.ok(Math.hypot(b.x-old[0],b.y-old[1])<=7+1e-7);settle(g,['b']);
  g.apply(event('pause-a','pause','a',{why:'waiting-start'}),true);settle(g,['a','b']);
  assert.equal(g.hero('a').rest.slot,0);assert.equal(b.rest.slot,1);
  assert.ok(Math.hypot(g.hero('a').x-b.x,g.hero('a').y-b.y)>=12);
});
test('missing rest_inn falls back to inn with diagnostic; missing node stays in place', () => {
  const fallback=copy(world);delete fallback.regions.rest_inn;const g=load([],{},fallback),h=g.hero('a');g.apply(event('p','pause','a',{why:'limited'}),false);assert.equal(h.rest.target,'inn');assert.ok(Object.keys(g.S.diagnostics).some(k=>/inn/i.test(k)));assert.ok(h.path.length>1);
  const missing=copy(world);delete missing.graph.pts.rest_inn;const n=load([],{},missing),hero=n.hero('a'),start=[hero.x,hero.y];n.apply(event('p','pause','a',{why:'limited'}),false);assert.deepEqual([hero.x,hero.y],start);assert.equal(hero.path.length,0);assert.equal(hero.rest.state,'paused');assert.ok(Object.keys(n.S.diagnostics).some(k=>/geometry/i.test(k)));n.update(1/60);assert.deepEqual([hero.x,hero.y],start);
});
test('fx=false bot events silent: no feed/portal; status reasons, rest scrub reconstruction',()=>{
  const g=load(fixture.events);g.reset(32);assert.equal(g.S.feed.length,0);assert.equal(g.S.fx.length,0);assert.deepEqual(['a','b','c'].map(id=>g.hero(id).rest.why),['limited','waiting-start','unavailable']);
  const logical=()=>copy(Object.fromEntries(['a','b','c'].map(id=>{const h=g.hero(id);return [id,{rest:h.rest,sleep:h.sleep,x:h.x,y:h.y}];})));const expected=logical();g.reset(0);g.reset(32);assert.deepEqual(logical(),expected);
  g.apply(event('silent-ab','failover','a',{other:'b'}),false);g.apply(mana('silent-m',33,5),false);g.apply(event('silent-resume','resume'),false);assert.equal(g.S.feed.length,0);assert.equal(g.S.fx.length,0);noUndefined(g);
});
test('tool/regen/legacy sleep-wake and social cannot mutate ledger or override rest',()=>{
  const g=load([mana('usage',1,100)]);g.reset(1);const expected=ledger(g);g.apply(event('run','run_start','a',{task:'q'}),false);g.apply(event('tool','tool','a',{task:'q',tool:'patch'}),true);g.apply(event('limited','run_end','a',{task:'q',outcome:'rate_limited'}),false);
  const h=g.hero('a');assert.equal(h.rest.state,'paused');g.startHangout(h,{region:'inn'});assert.equal(h.act,null);walk(g,2,['a']);g.apply(event('wake','wake','a',{task:'q'}),false);assert.equal(h.rest.state,'active');assert.deepEqual(ledger(g),expected);
});

(async()=>{
  let failed=0;
  for(const {name,f} of cases){try{await f();console.log('PASS '+name);}catch(e){failed++;console.error('FAIL '+name+'\n'+e.stack);}}
  console.log(JSON.stringify({tests:cases.length,passed:cases.length-failed,failed,motion,notRun:['genuine hidden 60s (parent-owned)','browser/raster/performance gates']},null,2));
  process.exitCode=failed?1:0;
})().catch(e=>{console.error(e);process.exitCode=1;});
