// Signed reconciliation is retained by the unchanged production client.
'use strict';
const fs=require('fs'), vm=require('vm'), assert=require('assert'), path=require('path');
const noop=()=>{}, elements=new Map();
const el=s=>{if(!elements.has(s))elements.set(s,{dataset:{},style:{},classList:{toggle:noop},getContext:()=>({}),setPointerCapture:noop});return elements.get(s)};
const sandbox={console,URLSearchParams,Date,Math,Set,Map,Number,Object,JSON,Promise,encodeURIComponent,AbortController,
  document:{querySelector:el,querySelectorAll:()=>[],body:el('body')},window:{devicePixelRatio:1},
  innerWidth:1440,innerHeight:900,requestAnimationFrame:noop,addEventListener:noop,setTimeout:noop,clearTimeout:noop,performance:{now:()=>0}};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname,'../game.js'),'utf8').replace(/\nboot\(\);\s*$/,'\n'),sandbox);
const run=code=>vm.runInContext(code,sandbox);
sandbox.world=JSON.parse(fs.readFileSync(path.join(__dirname,'../data/world.json')));
run(`W=world; loadReplay({meta:{from_:0,to:100,config_revision:'ledger'},bots:[{id:'worker',region:'forge',wallet:'codex'}],tasks:[{id:'q',stage:'BUILD'}],events:[{id:'estimate',t:1,task:'q',bot:'worker',kind:'mana',tokens:1000,estimated:true,basis:'chars'}],cursor:'c1'});`);
const refund={events:[{id:'refund',t:2,task:'q',bot:'worker',kind:'mana',tokens:-800,estimated:true,basis:'usage',correction:true}],tasks:[],bots:[],meta:{config_revision:'ledger'},cursor:'c2'};
sandbox.refund=refund;
run('mergeDelta(refund); mergeDelta(refund);');
assert.strictEqual(run('D.events.filter(e=>e.kind==="mana").reduce((s,e)=>s+e.tokens,0)'),200);
assert.strictEqual(run('D.events.length'),2);
run('S.play=false; reset(1); reset(2);');
assert.strictEqual(run('D.events.find(e=>e.id==="refund").tokens'),-800);
assert.strictEqual(run('D.events.filter(e=>e.kind==="mana").reduce((s,e)=>s+e.tokens,0)'),200);
console.log('PASS signed mana reconciliation retained once across merge and scrub; rendering remains later C UI scope');
