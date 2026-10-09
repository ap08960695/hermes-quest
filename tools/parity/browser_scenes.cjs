'use strict';
// RGBA pixel capture of scripted scenes in headless Chromium over a loopback http server (port 0).
// Fixed clock + seeded Math.random + manual rAF stepping; game.js itself is untouched. Page access to game
// internals goes through window.__questTest when a future facade exists, else through global-scope lookups.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const MIME = {'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.otf': 'font/otf'};
const VIEWPORTS = [{name: '1280x800', width: 1280, height: 800}, {name: '390x844', width: 390, height: 844}];
const DPRS = [1, 2, 3], ZOOMS = [1, 3];
const SCENES = [
  {id: 'boot', t: null, speed: 30, frames: 2},
  {id: 'midwalk', t: 1700001795, speed: 30, frames: 130},
  {id: 'hurt-wings', t: 1700003668, speed: 30, frames: 3, presentation: 'hurt'},
  {id: 'combat-proj', t: 1700001815, speed: 30, frames: 90},
  {id: 'monster-march', t: 1700004000, speed: 30, frames: 70},
  {id: 'rest-switch', t: 1700005340, speed: 30, frames: 120},
  {id: 'detail', t: 1700002000, speed: 30, frames: 60, detail: true},
  {id: 'resource-correction', t: 1700003000, speed: 30, frames: 80},
  {id: 'pause-scrub-hidden', t: 1700006000, speed: 30, frames: 40, pause: true},
  {id: 'selection', t: null, speed: 1, frames: 1, presentation: 'selection'},
  {id: 'overflow', t: null, speed: 1, frames: 1, presentation: 'overflow'},
  {id: 'inspection-card', t: null, speed: 1, frames: 1, presentation: 'inspection'},
  {id: 'session-unavailable-hud', t: null, speed: 1, frames: 1, presentation: 'unavailable'},
  {id: 'live-poll-follow', t: null, speed: 1, frames: 2, live: true}];
function resolvePlaywright(root) {
  const tried = [];
  for (const base of [root, path.resolve(__dirname, '../..')]) {
    try { return createRequire(path.join(base, 'package.json'))('playwright'); } catch (e) { tried.push(base); }
  }
  throw new Error('playwright not found in ' + tried.join(', '));
}
function serve(root) {
  const server = http.createServer((req, res) => {
    const u = decodeURIComponent(new URL(req.url, 'http://x').pathname), file = path.join(root, u === '/' ? 'index.html' : u);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, {'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store'});
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}
const INIT = () => {
  window.__questTestGlobals = true;
  const T0 = 1700001800000; let ts = 0, q = null, seed = 12345;
  const RealDate = Date;
  window.Date = class extends RealDate { static now(){return T0;} constructor(...a){a.length?super(...a):super(T0);} };
  performance.now = () => ts;
  const realTimeout = window.setTimeout.bind(window), realClear = window.clearTimeout.bind(window);
  let tid = 1000000; const held = new Map();
  window.setTimeout = (f, ms, ...a) => ms >= 1000 ? (held.set(++tid, [f,ms,a]),tid) : realTimeout(f,ms,...a);
  window.clearTimeout = id => held.delete(id) || realClear(id);
  Math.random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
  window.requestAnimationFrame = cb => { q = cb; return 1; }; window.cancelAnimationFrame = () => { q = null; };
  window.__step = n => { for (let i = 0; i < n; i++) { ts += 1000 / 60; const cb = q; q = null; if (cb) cb(ts); } return !!q; };
  window.__pending = () => !!q;
  window.__g = name => (window.__questTest && name in window.__questTest) ? window.__questTest[name] : (0, eval)(name);
};
const HASH = async () => {
  const hex = async buf => [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map(b => b.toString(16).padStart(2, '0')).join('');
  const out = {}; let i = 0;
  for (const c of document.querySelectorAll('canvas')) {
    if (!c.width || !c.height || c.hidden || c.offsetParent === null && c.id !== 'stage') continue;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const key = (c.id || (c.parentElement && (c.parentElement.id || c.parentElement.className)) || 'canvas') + '#' + (i++) + ' ' + c.width + 'x' + c.height;
    out[key] = await hex(d.buffer);
  }
  return out;
};
async function run({root, outDir, only}) {
  root = path.resolve(root);
  const pw = resolvePlaywright(root), server = await serve(root), port = server.address().port;
  const browser = await pw.chromium.launch({headless: true}), result = {browser: 'chromium ' + browser.version(), captures: {}, not_run: []};
  const shots = path.join(outDir, 'screens'); fs.mkdirSync(shots, {recursive: true});
  try {
    for (const vp of VIEWPORTS) for (const dpr of DPRS) {
      const ctx = await browser.newContext({viewport: {width: vp.width, height: vp.height}, deviceScaleFactor: dpr, locale: 'th-TH', timezoneId: 'Asia/Bangkok', reducedMotion: 'no-preference'});
      await ctx.addInitScript(INIT);
      const page = await ctx.newPage(), errors = [];
      page.on('pageerror', e => errors.push(String(e))); page.on('console', m => m.type() === 'error' && errors.push(m.text()));
      await page.route(u => !u.href.startsWith(`http://127.0.0.1:${port}/`) && !u.href.startsWith('data:'), r => r.abort());
      for (const sc of SCENES) for (const z of ZOOMS) {
        if (only && !sc.id.includes(only)) continue;
        const id = `${vp.name}@dpr${dpr}/z${z}/${sc.id}`;
        let polls = 0;
        if(sc.live)await page.route('**/api/**', route => {
          const d=JSON.parse(fs.readFileSync(path.join(root,'data/demo.json'),'utf8'));
          const isPoll=route.request().url().includes('/events');
          if(isPoll)polls++;
          const value=isPoll ? {events:[],next:null,snapshot:{bots:d.bots,tasks:d.tasks,sessions:{}}} : d;
          return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(value)});
        });
        await page.goto(`http://127.0.0.1:${port}/index.html?`+(sc.live?'live=1':'data=data/demo.json'));
        await page.waitForFunction(()=>window.__pending(),null,{timeout:60000,polling:100});
        await page.evaluate(async()=>{await document.fonts.ready;});
        await page.waitForTimeout(400);
        if(sc.live)await page.evaluate(async()=>{await window.__g('pollEvents')();await window.__g('pollEvents')();});
        await page.evaluate(([sc, z]) => {
          const g = window.__g, S = g('S'), cam = g('cam');
          if (!window.__q) { document.hidden; }
          S.speed = sc.speed; S.play = !sc.pause;
          if (sc.t !== null) g('reset')(sc.t);
          cam.zi = z; cam.x = cam.tx; cam.y = cam.ty;
          window.__step(sc.frames);
          if(sc.id==='combat-proj'){
            const t=Object.values(S.tasks).find(t=>t.state==='fight'&&S.heroes[t.bot]?.task===t.id&&['mage','sage','ranger','engineer'].includes(S.heroes[t.bot].cls));
            if(!t)throw new Error('missing ranged combat fixture');
            g('strike')(S.heroes[t.bot],t,{task:t.id,bot:t.bot,tool:'read_file',t:S.t});g('draw')();
          }
          if(sc.id==='monster-march'){
            const t=g('task')('parity-march');t.stage='BUILD';g('spawnMonster')(t,'forge');
            S.play=false;Object.assign(cam,{x:t.mx,tx:t.mx,y:t.my-40,ty:t.my-40});g('draw')();
          }
          if(sc.id==='resource-correction'){
            const h=Object.values(S.heroes).find(h=>h.bot!==g('captainId')());
            g('apply')({kind:'mana',id:'parity-usage',bot:h.bot,t:S.t,tokens:100},true);
            g('apply')({kind:'mana',id:'parity-correction',bot:h.bot,t:S.t,tokens:-50,correction:true},true);g('hud')(1);g('draw')();
          }
          if(sc.presentation){
            const h=Object.values(S.heroes).find(h=>h.bot!==g('captainId')());
            if(!h)throw new Error('missing presentation hero');
            if(sc.presentation==='hurt'){h.hurt=.35;h.eff={charge:.55,mult:1.9,crit:.3};}
            if(sc.presentation==='selection'||sc.presentation==='inspection')g('heroDialog')(h);
            if(sc.presentation==='selection')g('UI').close();
            if(sc.presentation==='overflow'){
              g('loadReplay')({meta:{from_:0,to:600,show_titles:false},bots:[],events:[],tasks:Array.from({length:18},(_,i)=>({id:'parity-task-'+i,stage:'BUILD',campaign:'Synthetic'}))});g('reset')(0);
              for(const row of g('D').tasks)g('spawnMonster')(g('task')(row.id),'forge');
              S.play=true;S.speed=1;for(let i=0;i<9000;i++)g('update')(1/60);S.play=false;
              const [x,y]=g('plazaOf')('forge').center;Object.assign(cam,{x,tx:x,y:y-40,ty:y-40});
            }
            if(sc.presentation==='unavailable'){g('D').session_data={status:'unavailable'};g('connectedStatus')(g('D'));}
            g('draw')();g('hud')(1);
          }
          if (sc.detail) { const h = Object.values(S.heroes)[0], t = Object.values(S.tasks)[0]; if (h) g('heroDialog')(h); if (t) g('quest')(t); window.__step(5); }
          if (sc.pause) {
            const sc2 = document.querySelector('#scrub'); sc2.value = 500; sc2.dispatchEvent(new Event('input', {bubbles: true}));
            Object.defineProperty(document, 'hidden', {configurable: true, get: () => true}); document.dispatchEvent(new Event('visibilitychange'));
            Object.defineProperty(document, 'hidden', {configurable: true, get: () => false}); document.dispatchEvent(new Event('visibilitychange'));
            window.__step(10);
          }
        }, [sc, z]);
        const state=await page.evaluate(()=>{const g=window.__g,S=g('S');return {selected:g('selectedScene'),live:g('liveFeed'),following:g('following'),
          t:S.t,rt:S.rt,heroes:Object.values(S.heroes).map(h=>[h.bot,h.x,h.y,h.path,h.hurt,h.eff,h.rest]),
          tasks:Object.values(S.tasks).map(t=>[t.id,t.x,t.y,t.state,t.hp,t.mpath]),fx:S.fx.map(p=>p.k),mana:S.mana,tokenNet:S.tokenNetByWallet,callbacks:S.later.map(p=>p.at),
          overflow:document.querySelector('#scene-overflow').textContent,issues:document.querySelector('#issues').textContent};});
        if(sc.live)assert.ok(state.live&&state.following&&polls>=2,'live poll/follow not exercised');
        if(sc.presentation==='unavailable')assert.match(state.issues,/Session activity unavailable/);
        if(sc.presentation==='selection')assert.ok(state.selected,'selection not exercised');
        if(sc.presentation==='overflow')assert.match(state.overflow,/\+6/);
        if(sc.id==='combat-proj')assert.ok(state.fx.includes('proj'),'projectile missing');
        if(sc.id==='monster-march')assert.ok(state.tasks.some(t=>t[5]?.length>1),'marching monster missing');
        if(sc.id==='rest-switch')assert.ok(state.heroes.some(h=>h[6]?.state==='transferred'),'switch/rest missing');
        await page.waitForTimeout(60);
        const hashes = await page.evaluate(HASH);
        const png = await page.screenshot({fullPage: true, animations: 'disabled'});
        const name = id.replace(/[/@]/g, '_') + '.png'; fs.writeFileSync(path.join(shots, name), png);
        result.captures[id] = {state,polls,canvases: hashes, screenshot_sha256: crypto.createHash('sha256').update(png).digest('hex')};
        if(sc.live)await page.unroute('**/api/**');
      }
      result.captures[`${vp.name}@dpr${dpr}/_errors`] = errors;
      assert.deepEqual(errors, [], 'page/console errors');
      await ctx.close();
    }
  } finally { await browser.close(); server.close(); }
  result.not_run = ['Firefox pixel equality (plan: same browser/version only)', 'real server live API (synthetic route used)'];
  return result;
}
module.exports = {INIT, run, SCENES, VIEWPORTS, DPRS, ZOOMS};
