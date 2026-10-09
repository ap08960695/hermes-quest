'use strict';
const assert = require('node:assert/strict');
const {createClient} = require('./parity/loader.cjs');
const calls = {fetch:0, raf:0, timer:0, random:0};
const noop = () => {};
const element = () => ({style:{},classList:{toggle:noop},addEventListener:noop,setPointerCapture:noop,getContext:()=>new Proxy({}, {get:()=>noop})});
const math = Object.create(Math);
math.random=()=>{calls.random++;return .5;};
const host = () => ({console,Math:math,Date,URLSearchParams,AbortController,Intl,Promise,
  document:{querySelector:element,querySelectorAll:()=>[],body:element(),addEventListener:noop,hidden:false},
  innerWidth:1280,innerHeight:800,devicePixelRatio:1,addEventListener:noop,performance:{now:()=>0},
  fetch:()=>{calls.fetch++;throw new Error('unexpected fetch');},requestAnimationFrame:()=>{calls.raf++;},
  setTimeout:()=>{calls.timer++;},clearTimeout:noop,cancelAnimationFrame:noop,Image:class {}});
const hostRandom=Math.random, hostWindow=global.window;
const a=createClient({sandbox:host()}),b=createClient({sandbox:host()});
assert.deepEqual(calls,{fetch:0,raf:0,timer:0,random:0});
assert.notEqual(a.G.S,b.G.S);assert.notEqual(a.G.cam,b.G.cam);assert.notEqual(a.G.ACTIONS,b.G.ACTIONS);
assert.notEqual(a.sandbox.NPCS,b.sandbox.NPCS);
const sameContext=a.sandbox.HQModules.createGame({autoBoot:false});
assert.notEqual(a.G.S,sameContext.S);assert.notEqual(a.G.cam,sameContext.cam);
a.G.S.vault=123;a.G.S.mana.test=9;a.G.D={marker:'a'};a.G.W={marker:'world-a'};
assert.equal(b.G.S.vault,0);assert.equal(b.G.S.mana.test,undefined);assert.equal(b.G.D,undefined);assert.equal(b.G.W,undefined);
a.run('S.vault=456;D={marker:"replaced"};');assert.equal(a.G.S.vault,456);assert.equal(a.G.D.marker,'replaced');
assert.equal(Math.random,hostRandom);assert.equal(global.window,hostWindow);
assert.deepEqual(calls,{fetch:0,raf:0,timer:0,random:0});
// Replacement crosses factory boundaries without taking a construction-time snapshot.
a.G.W={regions:{synthetic:{spot:[21,34]}}};
assert.deepEqual(Array.from(a.G.spotOf('synthetic')),[21,34]);
a.G.D={meta:{captain:'synthetic-captain'}};
assert.equal(a.G.captainId(),'synthetic-captain');
a.G.D={meta:{captain:'replacement-captain'}};
assert.equal(a.G.captainId(),'replacement-captain');
const state=a.G.S;
let resetCalls=0;
a.G.reset=()=>{resetCalls++;};
a.G.goLive();
assert.equal(resetCalls,1);assert.equal(a.G.S,state);
// Node host adapters may provide a separate window object; registration lives on globalThis.
const splitHost=host();splitHost.window={devicePixelRatio:1};
const split=createClient({sandbox:splitHost});
assert.notEqual(split.G.S,a.G.S);
assert.deepEqual(calls,{fetch:0,raf:0,timer:0,random:0});
console.log('PASS factory/loader: zero fetch/rAF/timer/RNG, separate instances, live peer replacements, split-window host, untouched host globals');
