'use strict';
// No runtime dependency: unit mode uses Node's VM. Browser mode uses the pinned
// CI Playwright and Python/FastAPI only to compose the real package bootstrap.
// node dashboard/test_dashboard_auth.cjs [chromium|firefox] [output-directory]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const {execFileSync} = require('node:child_process');
const {MessageChannel} = require('node:worker_threads');
const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(__dirname, 'dist/index.js'), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 20));

async function unit() {
  const listeners = new Set(), calls = [], timers = new Set();
  let effect, cleanup, exported, component;
  const frameWindow = {postMessage(message, origin, ports) { frameWindow.connected = {message, origin, ports}; }};
  const state = [];
  const React = {
    useRef: () => ({current: {contentWindow: frameWindow}}),
    useState: value => { const i = state.length; state.push(value); return [value, v => { state[i] = v; }]; },
    useEffect: fn => { effect = fn; }, createElement: () => null
  };
  const window = {__HERMES_PLUGIN_SDK__: {React, fetchJSON(url, init) {
    return new Promise((resolve, reject) => calls.push({url, init, resolve, reject}));
  }}, __HERMES_PLUGINS__: {register(name, value) { assert.equal(name, 'hermes-quest'); component = value; }},
  addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn)};
  const sandbox = {window, URLSearchParams, TextEncoder, AbortController, MessageChannel,
    setTimeout: (fn, ms) => { const timer = {fn, ms}; timers.add(timer); return timer; }, clearTimeout: t => timers.delete(t),
    expose: value => { exported = value; }};
  vm.runInNewContext(source.replace('window.__HERMES_PLUGINS__.register', 'expose({guestPath, safeError}); window.__HERMES_PLUGINS__.register'), sandbox);
  const request = p => exported.guestPath({id: 1, method: 'GET', path: p});
  for (const p of ['/replay', '/replay?hours=12', '/events?since=', '/events?since=' + encodeURIComponent('ก'.repeat(10922)),
    '/static/data/world.json', '/static/assets/px/heroes.json', '/desktop-asset?path=assets%2Fpx%2Fground.png']) assert.equal(request(p), p);
  for (const p of ['/desktop-bootstrap', '/static/index.html', '/static/data/replay.json', '/api/config', '//evil/replay',
    '/replay?hours=0', '/replay?hours=169', '/replay?data=x', '/events?since=x&since=y', '/events?since=' + 'a'.repeat(32769),
    '/events?since=' + encodeURIComponent('ก'.repeat(10923)), '/static/assets/px/../x.json', '/static/%2e%2e/x.json',
    '/desktop-asset?path=assets/raw/a.png', '/desktop-asset?path=assets/px/../a.png', '/replay#x', '/replay\n']) assert.throws(() => request(p));
  for (const m of [null, [], {id: 0, method: 'GET', path: '/replay'}, {id: 1, method: 'POST', path: '/replay'},
    {id: 1, method: 'GET', path: '/replay', body: 'x'}]) assert.throws(() => exported.guestPath(m));
  assert.equal(exported.safeError({status: 401, message: 'private response'}), 'HTTP 401');
  assert.equal(exported.safeError(new Error('503: private response')), 'HTTP 503');
  assert.equal(exported.safeError(new Error('private response')), 'Request failed');
  component(); cleanup = effect();
  assert.equal(calls[0].url, '/api/plugins/hermes-quest/desktop-bootstrap');
  assert.equal(calls[0].init.cache, 'no-store');
  const nonce = 'abcdefghijklmnopqrstuv';
  calls[0].resolve({version: 1, nonce, html: `<meta http-equiv="Content-Security-Policy" content="connect-src 'none'"><meta name="quest-nonce" content="${nonce}">quest-ready`});
  await tick();
  assert(state[0].startsWith('data:text/html,') && state[0].endsWith('?live=1'));
  const fire = (source, origin = 'null', n = nonce) => { for (const fn of [...listeners]) fn({source, origin, data: {kind: 'quest-ready', nonce: n}}); };
  fire({}); fire(frameWindow, 'https://evil'); fire(frameWindow, 'null', 'wrong');
  assert.equal(frameWindow.connected, undefined);
  fire(frameWindow);
  assert.equal(listeners.size, 0);
  const port = frameWindow.connected.ports[0], replies = [];
  port.on('message', message => replies.push(message));
  port.postMessage({id: 1, method: 'GET', path: '/api/config'});
  await tick(); assert.equal(calls.length, 1); assert.equal(replies[0].error, 'Request failed');
  port.postMessage({id: 2, method: 'GET', path: '/events?since=x'});
  await tick(); assert.equal(calls.length, 2);
  calls[1].reject({status: 401, message: 'private response'});
  await tick(); assert.equal(replies[1].error, 'HTTP 401');
  port.postMessage({id: 3, method: 'GET', path: '/replay'});
  await tick(); const pending = calls[2];
  assert.equal([...timers][0].ms, 35000);
  [...timers][0].fn(); await tick();
  assert(pending.init.signal.aborted); assert.equal(replies[2].error, 'Request failed');
  pending.resolve({late: true}); await tick(); assert.equal(replies.length, 3);
  port.postMessage({id: 4, method: 'GET', path: '/replay'});
  await tick(); cleanup();
  assert(calls[3].init.signal.aborted); calls[3].resolve({retired: true});
  await tick(); assert.equal(replies.length, 3); port.close();
  console.log('PASS dashboard SDK unit: allowlist, source/nonce binding, HTTP status, deadline/abort, late replies, unmount');
}

// Deliberately tiny React-compatible mounting harness, not a replacement shipped
// with the plugin. Actual-host integration runs separately against Hermes's React.
const harness = `
const values = [], refs = [], effects = [];
let cursor = 0, rc = 0, Page, cleanups = [], oldFrame, ranEffect = false;
const React = {
 useRef(value) { const i=rc++; return refs[i] ||= {current:value}; },
 useState(value) { const i=cursor++; if (!(i in values)) values[i]=value; return [values[i], v=>{values[i]=typeof v==='function'?v(values[i]):v;queueMicrotask(render);}]; },
 useEffect(fn) { if (!ranEffect) { ranEffect=true; effects.push(fn); } },
 createElement(tag, props, ...children) { return {tag, props:props||{}, children}; }
};
function node(tree) {
 if (typeof tree==='string') return document.createTextNode(tree);
 const el=document.createElement(tree.tag);
 for (const [key,value] of Object.entries(tree.props)) {
  if(key==='style') Object.assign(el.style,value);
  else if(key==='ref') value.current=el;
  else if(key==='onClick') el.onclick=value;
  else if(key!=='key') el.setAttribute(key,value);
 }
 for(const child of tree.children.flat()) if(child) el.append(node(child));
 return el;
}
function render() {
 cursor=rc=0;const tree=Page();
 // State rerenders do not reload a mounted frame; matching React's reconciliation.
 if(!oldFrame) { const el=node(tree);document.querySelector('#root').replaceChildren(el);oldFrame=el.querySelector('iframe'); }
 while(effects.length) cleanups.push(effects.shift()());
}
window.__HERMES_PLUGIN_SDK__={React,fetchJSON:async(url,init)=>{
 const headers=new Headers(init?.headers);if(window.testMode==='token') headers.set('X-Hermes-Session-Token',window.testToken);
 const response=await fetch(url,{...init,headers,credentials:'include'});
 if(!response.ok) throw Object.assign(new Error('Host request failed'),{status:response.status});
 return response.json();
}};
window.__HERMES_PLUGINS__={register(name,component){Page=component;render();}};
`;

async function browserTest(engine, out) {
  const pw = require(process.env.QUEST_NODE_MODULES ? path.join(process.env.QUEST_NODE_MODULES, 'playwright') : 'playwright');
  const python = process.env.QUEST_PYTHON || 'python3';
  const bootstrap = JSON.parse(execFileSync(python, ['-c', "import json;from dashboard.desktop_transport import desktop_bootstrap;print(desktop_bootstrap().body.decode())"], {cwd: ROOT, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024}));
  const demo = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/demo.json')));
  // Shift the entirely synthetic timeline into the live replay window.
  const shift = Date.now()/1000 - demo.meta.from_ - 3600;
  for (const e of demo.events) e.t += shift;
  for (const t of demo.tasks) for (const k of ['created','started','completed']) if(t[k]) t[k]+=shift;
  demo.meta.from_ += shift; demo.meta.to += shift; demo.cursor='synthetic-cursor';
  const token='synthetic-dashboard-token', records=[];
  const server = http.createServer((req,res)=>{
    const u=new URL(req.url,'http://localhost');
    if(u.pathname==='/') {
      const mode=u.searchParams.get('mode') || 'token';
      if(mode==='cookie') res.setHeader('Set-Cookie','quest-test=synthetic; HttpOnly; SameSite=Strict; Path=/');
      res.setHeader('Content-Type','text/html');
      res.end('<!doctype html><div id="root"></div><script>window.testMode='+JSON.stringify(mode)+';window.testToken='+JSON.stringify(token)+';'+harness+'</script><script src="/entry.js"></script>'); return;
    }
    if(u.pathname==='/entry.js') {res.setHeader('Content-Type','text/javascript');res.end(source);return;}
    if(u.pathname==='/favicon.ico') {res.writeHead(204);res.end();return;}
    const authed=req.headers['x-hermes-session-token']===token || req.headers.cookie?.includes('quest-test=synthetic');
    const send=(value,status=200)=>{records.push({path:u.pathname,status,header:Boolean(req.headers['x-hermes-session-token']),cookie:Boolean(req.headers.cookie)});res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
    if(!authed) {send({detail:'Unauthorized'},401);return;}
    const rel=u.pathname.replace('/api/plugins/hermes-quest','');
    if(rel==='/desktop-bootstrap') {send(bootstrap);return;}
    if(rel==='/replay') {send(demo);return;}
    if(rel==='/events') {send({meta:demo.meta,events:[],tasks:[],bots:[],cursor:demo.cursor});return;}
    if(rel==='/desktop-asset') {
      const asset=u.searchParams.get('path')||'';
      if(!/^assets\/px\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.png$/.test(asset)) {send({},404);return;}
      send({mime:'image/png',base64:fs.readFileSync(path.join(ROOT,asset)).toString('base64')});return;
    }
    if(rel.startsWith('/static/')) {
      const name=rel.slice(8);
      if(!/^(data\/world\.json|assets\/sprites\/monsters\.json|assets\/px\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.json)$/.test(name)) {send({},404);return;}
      send(JSON.parse(fs.readFileSync(path.join(ROOT,name))));return;
    }
    send({},404);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  let browser;
  const results=[];
  try {
    browser=await pw[engine].launch({headless:true});
    for(const mode of ['token','cookie']) {
      records.length=0;const context=await browser.newContext({viewport:{width:1280,height:800}});
      await context.addInitScript(()=>{window.__questTestGlobals=true;});
      const page=await context.newPage(), errors=[];
      page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error') errors.push(m.text());});
      page.on('response',r=>{if(r.status()>=400) errors.push('HTTP '+r.status());});
      await page.goto(base+'/?mode='+mode);
      await page.waitForSelector('iframe');
      const frame=page.frames().find(f=>f!==page.mainFrame());
      await frame.waitForFunction(()=>window.D?.events?.length>0 && /^Connected/.test(document.querySelector('#connection')?.getAttribute('aria-label') || ''),null,{timeout:30000});
      // Real updates: walk through synthetic events, do not infer motion from screenshots.
      const motion=await frame.evaluate(()=>{
        reset(D.meta.from_);let moved=0,last=new Map();
        for(let i=0;i<600;i++) {update(1);for(const [id,h] of Object.entries(S.heroes)) {
          const old=last.get(id);if(old && (old.x!==h.x || old.y!==h.y)) moved++;last.set(id,{x:h.x,y:h.y});
        }}draw();return {replayLoaded:!!D,moved,width:cv.width,height:cv.height};
      });
      assert(motion.replayLoaded && motion.moved>0 && motion.width>300 && motion.height>150);
      await frame.evaluate(()=>pollEvents());
      assert(records.some(r=>r.path.endsWith('/events')));
      assert(!records.some(r=>r.status===401));
      assert(records.every(r=>mode==='token'?r.header:r.cookie));
      const isolation=await frame.evaluate(()=>({token:window.__HERMES_SESSION_TOKEN__,sdk:window.__HERMES_PLUGIN_SDK__,origin:origin}));
      assert.equal(isolation.token,undefined);assert.equal(isolation.sdk,undefined);assert.equal(isolation.origin,'null');
      assert.equal(await page.locator('iframe').getAttribute('sandbox'),'allow-scripts');
      assert.deepEqual(errors,[]);
      fs.mkdirSync(out,{recursive:true});await page.screenshot({path:path.join(out,engine+'-'+mode+'.png')});
      results.push({engine,mode,...motion,requests:records.length,errors});await context.close();
    }
  } finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
  fs.writeFileSync(path.join(out,engine+'-auth-results.json'),JSON.stringify(results,null,2));
  console.log(JSON.stringify(results));
}
(async()=>{await unit();if(process.argv[2]) await browserTest(process.argv[2],path.resolve(process.argv[3]||'.evidence/auth'));})().catch(error=>{console.error(error);process.exitCode=1;});
