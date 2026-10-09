#!/usr/bin/env node
// Browser smoke test: serves the checkout on a loopback port (0 = OS-chosen) with the
// synthetic demo from tools/mock.py, then drives the page in a real browser.
//
//   node tools/browser_smoke.mjs <chromium|firefox> [--out DIR]
//
// Per viewport (1280x800, 390x844): wait for the scene to paint, pause, play, scrub.
// Fails on any console error, page error, failed/4xx/5xx request, boot-error banner,
// a clock that does not behave, or a blank (single-colour) canvas.
// Screenshots go to --out (default: $SMOKE_OUT or the OS temp dir) and are never committed.
// SMOKE_ROOT overrides the directory that is served (used to prove the test catches faults).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const root = path.resolve(process.env.SMOKE_ROOT || repo);
const args = process.argv.slice(2);
const outFlag = args.indexOf('--out');
const outDir = path.resolve(outFlag >= 0 ? args[outFlag + 1] : (process.env.SMOKE_OUT || path.join(os.tmpdir(), 'hermes-quest-smoke')));
const browserName = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
if (!['chromium', 'firefox'].includes(browserName)) {
  console.error('usage: node tools/browser_smoke.mjs <chromium|firefox> [--out DIR]');
  process.exit(2);
}
const playwright = createRequire(path.join(repo, 'package.json'))('playwright');

const VIEWPORTS = [{name: '1280x800', width: 1280, height: 800}, {name: '390x844', width: 390, height: 844},
  ...[[375,667],[320,568],[667,375],[568,320]].map(([width,height])=>({name:width+'x'+height,width,height}))];
const TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.css': 'text/css', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ttf': 'font/ttf', '.woff2': 'font/woff2'};

function serve() {
  const server = http.createServer((req, res) => {
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { rel = '/\0'; }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(root, '.' + rel);
    const inside = file === root || file.startsWith(root + path.sep);
    const blocked = /(^|\/)(\.git|node_modules|\.worktrees)(\/|$)/.test(rel) || rel.includes('\0');
    if (!inside || blocked) { res.writeHead(403); res.end('forbidden'); return; }
    fs.readFile(file, (err, body) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, {'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store'});
      res.end(body);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// Distinct colours on a coarse sample grid of the canvas: 1 means blank/single-colour.
const canvasColours = () => {
  const cv = document.querySelector('#stage');
  if (!cv || !cv.width || !cv.height) return 0;
  const ctx = cv.getContext('2d');
  const seen = new Set();
  for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) {
    const d = ctx.getImageData(Math.min(cv.width - 1, Math.floor((x + .5) * cv.width / 24)),
      Math.min(cv.height - 1, Math.floor((y + .5) * cv.height / 24)), 1, 1).data;
    seen.add(d[0] << 24 | d[1] << 16 | d[2] << 8 | d[3]);
  }
  return seen.size;
};

async function runViewport(browser, base, vp) {
  const problems = [];
  const steps = [];
  const ctx = await browser.newContext({viewport: {width: vp.width, height: vp.height}, deviceScaleFactor: 1});
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') problems.push(`console error: ${m.text()}`); });
  page.on('pageerror', e => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', r => problems.push(`request failed: ${r.url()} (${r.failure()?.errorText})`));
  page.on('response', r => { if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`); });
  const shot = async label => page.screenshot({path: path.join(outDir, `${browserName}-${vp.name}-${label}.png`)});
  const colours = async label => {
    const n = await page.evaluate(canvasColours);
    steps.push(`${label}: ${n} colours`);
    if (n < 8) problems.push(`canvas looks blank at "${label}" (${n} distinct sampled colours)`);
  };
  const clock = () => page.locator('#clock').getAttribute('aria-label');
  try {
    // data/demo.json is the default feed; the boot code reports a load failure only via this banner.
    await page.goto(`${base}/index.html`, {waitUntil: 'load'});
    await page.waitForFunction(() => /^(Replay file|Unable to load data)/.test(document.querySelector('#connection')?.getAttribute('aria-label')||''), null, {timeout: 30000});
    const state = await page.locator('#connection').getAttribute('aria-label');
    if (state !== 'Replay file normal') problems.push(`boot did not reach file/demo mode (connection label "${state}")`);
    await page.waitForFunction(() => /^Replay time: \d/.test(document.querySelector('#clock')?.getAttribute('aria-label') || ''), null, {timeout: 30000});
    // Let the scene draw: clock must advance (loop is running) and a few frames must pass.
    const first = await clock();
    await page.waitForFunction(t => document.querySelector('#clock').getAttribute('aria-label') !== t, first, {timeout: 30000});
    await page.waitForTimeout(1500);
    await colours('drawn');
    const focusBounds=await page.evaluate(()=>{
      const r=document.querySelector('#stage').getBoundingClientRect(),b=document.querySelector('#menu-toggle').getBoundingClientRect();
      return {canvas:r.width===innerWidth&&r.height===innerHeight,menu:document.querySelector('#menu').hidden,
        target:b.width>=44&&b.height>=44,toolbar:document.querySelector('#hud').getClientRects().length,
        overflow:document.documentElement.scrollWidth>innerWidth+1};
    });
    if(!focusBounds.canvas||!focusBounds.menu||!focusBounds.target||focusBounds.toolbar||focusBounds.overflow)problems.push('focus mode: toolbar/layout/touch-target gate failed');
    await shot('1-drawn');
    await page.locator('#menu-toggle').focus();await page.keyboard.press('Enter');
    if(await page.locator('#menu-toggle').getAttribute('aria-expanded')!=='true')problems.push('keyboard Menu did not open');
    await page.click('#group-playback > summary');

    // Pause
    await page.click('#play');
    if ((await page.locator('#play').getAttribute('aria-label')) !== 'Play normal' ||
        (await page.locator('#play').getAttribute('aria-pressed')) !== 'true') problems.push('pause: button did not switch to accessible play state');
    await page.waitForTimeout(300);
    const frozen = await clock();
    await page.waitForTimeout(1200);
    if ((await clock()) !== frozen) problems.push(`pause: clock kept moving (${frozen} -> ${await clock()})`);
    await shot('2-paused');
    const stable=await page.evaluate(()=>{cam.x=cam.tx;cam.y=cam.ty;return JSON.stringify([S.t,S.i,S.speed,S.play,following,cursor,cam.x,cam.y,cam.tx,cam.ty,cam.zi]);});
    await page.keyboard.press('Escape');
    if(!await page.locator('#menu-toggle').evaluate(el=>el===document.activeElement))problems.push('Escape did not return Menu focus');
    await page.keyboard.press('Space');
    await page.click('#group-overview > summary');
    await page.locator('#tasks-list .item-summary').first().waitFor();
    await page.locator('#tasks-list button').first().click();
    await page.locator('#quest .bitmap-row canvas').first().waitFor();
    await page.keyboard.press('Escape');
    if(!await page.locator('#tasks-list button').first().evaluate(el=>el===document.activeElement))problems.push('detail close did not return focus');
    if(await page.evaluate(()=>JSON.stringify([S.t,S.i,S.speed,S.play,following,cursor,cam.x,cam.y,cam.tx,cam.ty,cam.zi]))!==stable)problems.push('Menu/detail changed paused playback/camera/cursor');
    await shot('menu-overview');
    await page.click('#group-overview > summary');
    // Play
    await page.click('#play');
    if ((await page.locator('#play').getAttribute('aria-label')) !== 'Pause normal' ||
        (await page.locator('#play').getAttribute('aria-pressed')) !== 'false') problems.push('play: button did not switch to accessible pause state');
    await page.waitForFunction(t => document.querySelector('#clock').getAttribute('aria-label') !== t, frozen, {timeout: 15000})
      .catch(() => problems.push('play: clock did not advance after resume'));
    await shot('3-playing');
    // Scrub to 70% (an input event, exactly what dragging the slider fires)
    const before = await clock();
    await page.evaluate(() => { const s = document.querySelector('#scrub'); s.value = 700; s.dispatchEvent(new Event('input', {bubbles: true})); });
    await page.waitForTimeout(1000);
    const after = await clock();
    if (after === before) problems.push(`scrub: clock unchanged (${before})`);
    const pos = Number(await page.locator('#scrub').inputValue());
    if (Math.abs(pos - 700) > 60) problems.push(`scrub: slider ended at ${pos}, expected ~700`);
    await page.waitForTimeout(800);
    await colours('after scrub');
    await shot('4-scrubbed');
    steps.push(`clock ${first} -> pause ${frozen} -> scrub ${before} -> ${after}`);
  } catch (e) {
    problems.push(`flow error: ${String(e.message).split('\n')[0]}`);
    await shot('error').catch(() => {});
  }
  await ctx.close();
  return {viewport: vp.name, problems, steps};
}

async function runLoadStates(browser,base) {
  const check=(v,m)=>{if(!v)throw Error(m);},demo=JSON.parse(fs.readFileSync(path.join(root,'data/demo.json')));
  for(const state of ['loading','error','empty','idle']){
    const ctx=await browser.newContext({viewport:{width:320,height:568}}),page=await ctx.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    let release;const delayed=new Promise(r=>release=r);
    await page.route('**/data/demo.json',async route=>{
      if(state==='loading')await delayed;
      if(state==='error')return route.fulfill({status:503,body:'synthetic load failure'});
      const data=structuredClone(demo);data.events=[];
      if(state==='empty'){data.tasks=[];data.bots=[];}
      return route.fulfill({json:data});
    });
    try {
      await page.goto(base+'/index.html',{waitUntil:'domcontentloaded'});
      if(state==='loading'){
        check((await page.locator('#connection').getAttribute('aria-label')).includes('Loading'),'Loading confused with empty');
        await page.click('#menu-toggle');check(await page.locator('#menu').isVisible(),'Loading Menu unavailable');release();
      } else if(state==='error'){
        await page.waitForFunction(()=>document.querySelector('#issues').textContent==='Offline');
        check((await page.locator('#connection').getAttribute('aria-label')).includes('Unable to load data'),'Error confused with empty');
        await page.click('#issues');check((await page.locator('#quest').textContent()).includes('Unable to load data'),'Boot error details unavailable');
      } else {
        await page.waitForFunction(()=>typeof loop.last==='number');
        await page.click('#menu-toggle');await page.click('#group-overview > summary');
        check((await page.locator('#overview-summary').textContent()).includes(state==='empty'?'No tasks in this replay range':'No active work'),'Empty/idle labels confused');
      }
      check(errors.length===0,errors.join('; '));
    } finally {release();await ctx.close();}
  }
  console.log('PASS '+browserName+' loading/error/empty/idle distinct and accessible');
}

async function runLiveMenu(browser,base) {
  // Synthetic transport, never operator data. Exercise the production polling path.
  const ctx=await browser.newContext({viewport:{width:320,height:568},hasTouch:true});
  const page=await ctx.newPage(),errors=[],polls=[];let seq=0,replays=0,state='online';
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('503'))errors.push(m.text());});
  page.on('requestfailed',r=>errors.push(r.url()));
  const check=(value,message)=>{if(!value)throw Error(message);};
  const demo=JSON.parse(fs.readFileSync(path.join(root,'data/demo.json')));
  await page.route('**/api/plugins/hermes-quest/replay*',route=>{
    replays++;const d=structuredClone(demo),shift=Date.now()/1000-d.meta.to;
    d.events.forEach(e=>e.t+=shift);d.meta.from_+=shift;d.meta.to+=shift;
    d.meta.source='synthetic-live';d.meta.show_titles=false;d.cursor='0';
    d.tasks.forEach(t=>{t.title='MENU_PRIVATE_TITLE';t.note='MENU_PRIVATE_NOTE';});
    return route.fulfill({json:d});
  });
  await page.route('**/api/plugins/hermes-quest/events*',route=>{
    polls.push(Date.now());if(state==='offline')return route.fulfill({status:503,body:'synthetic unavailable'});
    seq++;return route.fulfill({json:{state,events:[{id:'menu-live-'+seq,t:Date.now()/1000,
      kind:seq===1?'blocked':'heartbeat',task:demo.tasks[0].id,bot:demo.bots[0].id}],tasks:[],bots:[],cursor:String(seq)}});
  });
  try {
    await page.goto(base+'/index.html?live=1');
    await page.waitForFunction(()=>typeof loop.last==='number'&&cursor!=='0');
    await page.waitForFunction(()=>!document.querySelector('#issues').hidden);
    const before=await page.evaluate(()=>({t:S.t,i:S.i,speed:S.speed,play:S.play,following,cam:[cam.tx,cam.ty,cam.zi],cursor}));
    for(let n=0;n<12;n++){
      await page.tap('#menu-toggle');await page.waitForTimeout(5000);
    }
    const after=await page.evaluate(()=>({t:S.t,i:S.i,speed:S.speed,play:S.play,following,cam:[cam.tx,cam.ty,cam.zi],cursor,
      hidden:document.hidden,events:D.events.filter(e=>String(e.id).startsWith('menu-live-')).map(e=>e.id)}));
    check(after.t>before.t+50&&after.i>before.i,'Menu stopped live playback');
    check(JSON.stringify([before.speed,before.play,before.following,before.cam])===JSON.stringify([after.speed,after.play,after.following,after.cam]),'Menu reset playback/camera');
    check(!after.hidden&&replays===1&&Number(after.cursor)>Number(before.cursor),'Menu reset/refetched transport');
    check(new Set(after.events).size===after.events.length&&after.events.length===seq,'Live event duplication/loss');
    for(let n=1;n<polls.length;n++)check(polls[n]-polls[n-1]>=9000&&polls[n]-polls[n-1]<=13000,'Polling cadence changed');
    check(await page.locator('#issues').isVisible(),'Blocked badge hidden with Menu');
    await page.tap('#menu-toggle');await page.click('#group-overview > summary');
    await page.click('#log');
    const filterState=await page.evaluate(()=>{const f=document.querySelector('#feed-filter'),l=document.querySelector('label[for="feed-filter"]');return {tag:f.tagName,value:f.value,options:[...f.options].map(o=>o.value).join(),name:f.getAttribute('aria-label'),label:l&&l.textContent,slot:!!document.querySelector('#feed-filter-slot'),count:document.querySelectorAll('#feed-filter').length};});
    check(filterState.tag==='SELECT'&&filterState.value==='all'&&filterState.options==='all,work,issues'&&filterState.name==='Activity'&&filterState.label==='Activity'&&filterState.count===1,'Runtime Activity filter lost id/label/options/default');
    await page.focus('#feed-filter');await page.keyboard.press('ArrowDown');
    check(await page.evaluate(()=>document.querySelector('#feed-filter').value)==='work','Activity filter not keyboard operable');
    await page.selectOption('#feed-filter','work');
    check(await page.locator('#issues').isVisible(),'Feed filter hid blocked badge');
    await page.click('#tasks-all');check(await page.locator('#quest .item-summary').count()===demo.tasks.length,'View all escaped or omitted loaded task window');
    await page.keyboard.press('Escape');
    const privacy=await page.evaluate(()=>!JSON.stringify(D).includes('MENU_PRIVATE')&&!JSON.stringify(S).includes('MENU_PRIVATE')&&!document.body.textContent.includes('MENU_PRIVATE'));
    check(privacy,'Hidden title/note canary leaked');
    const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('quest-menu-v1')));
    check(JSON.stringify(Object.keys(saved).sort())===JSON.stringify(['groups','menu'])&&Object.values(saved.groups).every(v=>typeof v==='boolean'),'Non-UI data in preference');
    // Explicit failure states use the real delta/error path, not a painted status stub.
    state='legacy-fallback';await page.evaluate(async()=>{clearTimeout(pollTimer);await pollEvents();});
    check((await page.locator('#mode').textContent()).includes('Snapshot'),'Snapshot falsely connected');
    state='offline';await page.evaluate(async()=>{clearTimeout(pollTimer);await pollEvents();});
    check((await page.locator('#mode').textContent()).includes('Offline'),'Offline falsely connected');
    await page.click('#menu-toggle');check(await page.locator('#issues').isVisible(),'Offline/blocked hidden in focus mode');
    await page.screenshot({path:path.join(outDir,browserName+'-synthetic-live-focus.png')});
    check(errors.length===0,errors.join('; '));
    fs.writeFileSync(path.join(outDir,browserName+'-live-menu.json'),JSON.stringify({synthetic:true,before,after,polls,replays,privacy,saved,errors},null,2));
    console.log('PASS '+browserName+' synthetic Menu touch/live 60s, cadence, dedup, privacy, retained lists, snapshot/offline');
  } finally {await ctx.close();}
}

async function runLiveStale(browser,base) {
  // Synthetic fake server: failing polls must raise the compact warning (also with the Menu closed),
  // leak nothing internal, leave playback/camera/cursor alone, and one success must restore Live.
  const check=(v,m)=>{if(!v)throw Error(m);},demo=JSON.parse(fs.readFileSync(path.join(root,'data/demo.json')));
  for(const [width,height] of [[1280,800],[375,667],[320,568]]){
    const ctx=await browser.newContext({viewport:{width,height}}),page=await ctx.newPage(),errors=[];let mode='ok',seq=0;
    page.on('pageerror',e=>errors.push(e.message));
    page.on('console',m=>{if(m.type()==='error'&&!/status of [45]\d\d|Failed to load resource|net::ERR|NS_ERROR/.test(m.text()))errors.push(m.text());});
    await page.route('**/api/plugins/hermes-quest/replay*',route=>{const d=structuredClone(demo),shift=Date.now()/1000-d.meta.to;
      d.events.forEach(e=>e.t+=shift);d.meta.from_+=shift;d.meta.to+=shift;d.meta.source='synthetic-live';d.meta.show_titles=false;d.cursor='0';return route.fulfill({json:d});});
    await page.route('**/api/plugins/hermes-quest/events*',route=>{
      if(mode==='network')return route.abort('connectionrefused');
      if(typeof mode==='number')return route.fulfill({status:mode,contentType:'application/json',body:'{"detail":"STALE_PAYLOAD_CANARY"}'});
      seq++;return route.fulfill({json:{state:'online',events:[{id:'stale-smoke-'+seq,t:Date.now()/1000,kind:'heartbeat',task:demo.tasks[0].id,bot:demo.bots[0].id}],tasks:[],bots:[],cursor:'s'+seq}});});
    try {
      await page.goto(base+'/index.html?live=1');
      await page.waitForFunction(()=>typeof loop.last==='number'&&cursor!=='');
      const poll=async next=>{mode=next;await page.evaluate(async()=>{clearTimeout(pollTimer);await pollEvents();});};
      const view=()=>page.evaluate(()=>{const h=s=>{const e=document.querySelector(s);return e&&!e.hidden?e.textContent:null;},r=document.querySelector('#focus-bar').getBoundingClientRect();
        return {mode:h('#mode'),issues:h('#issues'),note:h('#live-note'),announce:document.querySelector('#live-announce').textContent,
          live:document.querySelector('#live-announce').getAttribute('aria-live'),role:document.querySelector('#live-announce').getAttribute('role'),
          menuClosed:document.querySelector('#menu').hidden,fits:r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,
          overflow:document.documentElement.scrollWidth>innerWidth+1,state:JSON.stringify([S.speed,S.play,following,cam.tx,cam.ty,cam.zi])};});
      await poll('ok');const online=await view();
      check(online.menuClosed&&!online.issues&&!online.note&&/Connected/.test(online.mode),'baseline not a quiet Live');
      const raf1=await page.evaluate(()=>S.t);
      // Two transient failures: still the old quiet Offline; third: the warning.
      await poll(503);await poll(503);let v=await view();
      check(v.issues==='Offline'&&!v.note,'warning raised before 3 consecutive failures');
      await poll(503);v=await view();
      check(v.menuClosed&&v.issues==='Live paused · not updating'&&/^Last update \d\d:\d\d · server error$/.test(v.note),'3rd failure: '+JSON.stringify(v));
      check(/^Live paused\./.test(v.announce)&&v.live==='polite'&&v.role==='status','warning not announced politely');
      check(v.fits&&!v.overflow,'warning overflows at '+width);
      await page.waitForTimeout(600);
      check(await page.evaluate(t=>S.t>t,raf1),'animation/playhead stopped while stale');
      if(width===320||width===1280)await page.screenshot({path:path.join(outDir,browserName+'-live-stale-'+width+'.png')});
      // Recovery on one success; transitions announce once and clear.
      await poll('ok');v=await view();
      check(!v.issues&&!v.note&&/Connected/.test(v.mode)&&v.announce==='Live updates resumed.','one success did not restore Live: '+JSON.stringify(v));
      // A 4xx warns at once with the human reason, and never prints payload/URL/cursor.
      for(const [code,reason] of [[401,'sign-in needed'],[422,'server rejected']]){
        const before=await view();await poll(code);v=await view();
        check(v.issues==='Live paused · not updating'&&v.note.endsWith(' · '+reason),code+' reason: '+JSON.stringify(v));
        check(v.state===before.state,code+' reset speed/follow/camera');
        await page.click('#issues');const dialog=await page.locator('#quest').textContent();
        check(/Reason: /.test(dialog)&&!/CANARY|events\?|\/api\/|cursor|HTTP/i.test(dialog+JSON.stringify(v)),'internal data leaked in '+code+': '+dialog);
        await page.keyboard.press('Escape');await poll('ok');
      }
      await poll('network');await poll('network');await poll('network');v=await view();
      check(/offline$/.test(v.note||''),'network error reason: '+JSON.stringify(v));
      // Menu > Overview carries the same detail.
      await page.click('#menu-toggle');await page.click('#group-overview > summary');
      check((await page.locator('#live-detail').textContent()).includes('Last successful update'),'Overview lacks stale detail');
      await page.click('#menu-toggle');await poll('ok');
      // Mixed error kinds (F1): once stale, a different failure kind keeps the warning + last update and never announces "resumed".
      for(const seqn of [[422,503],[401,'network'],[422,503,500,'network']]){
        await poll('ok');
        for(const failure of seqn){
          await poll(failure);v=await view();
          check(v.issues==='Live paused · not updating'&&/^Last update \d\d:\d\d · /.test(v.note||''),'mixed '+seqn+' dropped warning at '+failure+': '+JSON.stringify(v));
          check(!/resumed/i.test(v.announce),'resumed announced on failed poll after '+failure+': '+v.announce);
          check(v.menuClosed&&v.fits&&!v.overflow,'mixed layout at '+width);
        }
        await poll('ok');v=await view();
        check(!v.issues&&!v.note&&v.announce==='Live updates resumed.','200 did not resume after '+seqn+': '+JSON.stringify(v));
      }
      // 4xx -> failure -> 200, and a fresh transient run after recovery is quiet for 1-2 failures, stale on the 3rd.
      await poll(404);await poll(503);v=await view();
      check(v.issues==='Live paused · not updating'&&!/resumed/i.test(v.announce),'4xx->503 lost warning: '+JSON.stringify(v));
      await poll('ok');await poll(503);v=await view();
      check(v.issues==='Offline'&&!v.note,'fresh transient 1 not quiet: '+JSON.stringify(v));
      await poll(500);v=await view();check(v.issues==='Offline'&&!v.note,'fresh transient 2 not quiet');
      await poll('network');v=await view();check(/^Live paused/.test(v.issues||'')&&!!v.note,'fresh transient 3 not stale');
      await poll('ok');
      // Hidden-tab behaviour is unchanged: no poll and no scheduling while hidden.
      const hidden=await page.evaluate(async()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});
        clearTimeout(pollTimer);pollTimer=null;const f=pollFailures;await pollEvents();return {f,after:pollFailures,timer:pollTimer};});
      check(hidden.after===hidden.f&&hidden.timer===null,'hidden tab polled or rescheduled');
      check(errors.length===0,errors.join('; '));
    } finally {await ctx.close();}
  }
  console.log('PASS '+browserName+' live-stale warning at 1280/375/320: 3x/4xx trigger, reasons, polite announce, recovery, no leak, playback untouched, hidden tab unchanged');
}

async function runRetention(browser,base) {
  // An open View all / task / hero dialog must follow retained history (F7). Synthetic data only; the
  // real production mergeDelta evicts the oldest task, hero and events while each dialog stays open.
  const ctx=await browser.newContext({viewport:{width:320,height:568}}),page=await ctx.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  const check=(v,m)=>{if(!v)throw Error(m);};
  try {
    await page.goto(base+'/index.html',{waitUntil:'load'});
    await page.waitForFunction(()=>typeof loop.last==='number');
    // Freeze the scheduler so only the explicit mergeDelta below changes data; hud() keeps running.
    const setup=()=>page.evaluate(async()=>{
      S.play=false;cancelAnimationFrame(raf);clearTimeout(pollTimer);
      const d=structuredClone(D),base=d.meta.from_,old=d.tasks[0],oldBot=d.bots[0];
      old.id='retention-old';old.title='SYNTHETIC_EVICTED_TITLE';old.parents=[];old.bot=oldBot.id;
      const hero={...oldBot,id:'retention-hero-old',name:'SYNTHETIC_EVICTED_HERO'};
      d.meta.show_titles=true;d.bots=[hero,...Array.from({length:257},(_,i)=>({...oldBot,id:'retention-hero-'+i,name:'Synthetic hero '+i}))];
      d.tasks=[old,...Array.from({length:257},(_,i)=>({...old,id:'retention-'+i,title:'Synthetic task '+i,bot:'retention-hero-0'}))];
      d.events=[{id:'retention-old-event',t:base+1,task:old.id,bot:hero.id,kind:'created'},
        {id:'retention-old-hero',t:base+1.5,bot:hero.id,kind:'heartbeat'},{id:'retention-new-event',t:base+2,task:'retention-256',kind:'created'}];
      d.meta.to=base+3;d.cursor='initial';
      loadReplay(d,null,base+3);UIPanels.menu(true);document.querySelector('#group-overview').open=true;
      await new Promise(r=>setTimeout(r,100));hudT=1;hud(0);
      return {base};
    });
    const evict=(base)=>page.evaluate(async base=>{
      mergeDelta({events:Array.from({length:2100},(_,i)=>({id:'retention-delta-'+i,t:base+10+i,task:'retention-256',bot:'retention-hero-0',kind:'heartbeat'})),tasks:[],bots:[],cursor:'after'});
      const probe=()=>JSON.stringify([S.t,S.i,S.speed,S.play,following,cursor,cam.tx,cam.ty,cam.zi]);
      hudT=1;hud(0);await new Promise(r=>setTimeout(r,150));return probe();
    },base);
    const snap=()=>page.evaluate(()=>({
      old:D.tasks.some(t=>t.id==='retention-old')||!!S.tasks['retention-old'],
      hero:D.bots.some(b=>b.id==='retention-hero-old')||!!S.heroes['retention-hero-old'],
      tasks:D.tasks.length,
      dialogOpen:!document.querySelector('#quest').hidden,
      text:document.querySelector('#quest').textContent,
      rows:document.querySelectorAll('#quest .item-summary').length,
      active:document.activeElement?.id||document.activeElement?.className||document.activeElement?.tagName,
      playback:JSON.stringify([S.speed,following,cam.tx,cam.ty,cam.zi])}));
    const results={};
    // 1) View all tasks stays open and drops the evicted row.
    let {base:b0}=await setup();
    await page.click('#tasks-all');
    let before=await snap();
    check(before.old&&before.dialogOpen&&before.rows===257&&before.text.includes('SYNTHETIC_EVICTED_TITLE'),'retention setup: View all tasks not open with 257 rows');
    const pre=await page.evaluate(()=>JSON.stringify([S.speed,following,cam.tx,cam.ty,cam.zi]));
    await evict(b0);let after=await snap();
    check(!after.old,'retention: task was not evicted by mergeDelta');
    check(after.dialogOpen,'View all tasks closed itself (it should only drop the row)');
    check(after.rows===after.tasks&&after.rows===256,'View all rows '+after.rows+' != retained tasks '+after.tasks);
    check(!after.text.includes('SYNTHETIC_EVICTED_TITLE'),'View all still shows evicted task title');
    check(await page.locator('#quest .item-summary button').count()===256,'View all keeps a Details action for an evicted task');
    check(after.playback===pre,'View all refresh changed speed/follow/camera');
    results.viewAllTasks={before:before.rows,after:after.rows};
    await page.keyboard.press('Escape');
    // 2) View all heroes drops the evicted hero.
    ({base:b0}=await setup());
    await page.click('#heroes-all');
    before=await snap();
    check(before.hero&&before.text.includes('SYNTHETIC_EVICTED_HERO'),'retention setup: View all heroes lacks old hero');
    await evict(b0);after=await snap();
    check(!after.hero,'retention: hero was not evicted by mergeDelta');
    check(after.dialogOpen&&!after.text.includes('SYNTHETIC_EVICTED_HERO'),'View all heroes still shows evicted hero');
    results.viewAllHeroes={before:before.rows,after:after.rows};
    await page.keyboard.press('Escape');
    // 3) Task detail opened from the list closes and returns focus to a live control.
    ({base:b0}=await setup());
    await page.locator('#tasks-list .item-summary button').first().focus();
    const openerKey=await page.evaluate(()=>document.activeElement.closest('.item-summary').dataset.key);
    await page.click('#tasks-list .item-summary button >> nth=0');
    check((await snap()).dialogOpen,'task detail did not open');
    await page.evaluate(id=>{quest(S.tasks[id]||D.tasks.find(t=>t.id===id));},'retention-old');
    check((await snap()).text.includes('SYNTHETIC_EVICTED_TITLE'),'task detail lacks old task before eviction');
    await evict(b0);after=await snap();
    check(!after.dialogOpen&&!after.text.includes('SYNTHETIC_EVICTED_TITLE'),'task detail for evicted task stayed open');
    check(await page.evaluate(()=>{const a=document.activeElement;return !!a&&a.isConnected&&a!==document.body;}),'focus lost after task detail closed');
    results.taskDetail={closed:!after.dialogOpen,active:after.active,openerKey};
    // 4) Hero detail opened from the canvas path closes the same way.
    ({base:b0}=await setup());
    await page.locator('#menu-toggle').focus();
    await page.evaluate(()=>heroDialog(S.heroes['retention-hero-old']));
    check((await snap()).text.includes('SYNTHETIC_EVICTED_HERO'),'hero detail lacks old hero before eviction');
    await evict(b0);after=await snap();
    check(!after.dialogOpen&&!after.text.includes('SYNTHETIC_EVICTED_HERO'),'hero detail for evicted hero stayed open');
    check(after.active==='menu-toggle','focus did not return to the opener after hero detail closed ('+after.active+')');
    results.heroDetail={closed:!after.dialogOpen,active:after.active};
    // 5) A dialog for a still-retained task stays open and refreshes.
    ({base:b0}=await setup());
    await page.evaluate(()=>quest(S.tasks['retention-5']||D.tasks.find(t=>t.id==='retention-5')));
    await evict(b0);after=await snap();
    check(after.dialogOpen&&after.text.includes('retention-5'),'detail for a retained task closed or lost content');
    // 6) Production poll path: pollEvents (HTTP) -> connection() with the previous overview -> dialog close
    // -> HUD rebuilds the summary lists. mergeDelta+hud alone cannot see focus handed to a Details button
    // that the next HUD pass deletes, so the delta is served over the real /events route.
    let queued=null;const requests=[];
    await page.route('**/api/plugins/hermes-quest/**',route=>{const u=new URL(route.request().url());requests.push(u.pathname);
      if(u.pathname.endsWith('/events')&&queued)return route.fulfill({contentType:'application/json',body:JSON.stringify(queued)});
      return route.fulfill({status:404,body:'not found'});});
    const pollEvict=async(base,opener)=>{
      queued={events:Array.from({length:2100},(_,i)=>({id:'retention-delta-'+i,t:base+10+i,task:'retention-256',bot:'retention-hero-0',kind:'heartbeat'})),tasks:[],bots:[],cursor:'after',state:'online'};
      await page.locator(opener).first().focus();await page.click(opener+' >> nth=0');
      await page.evaluate(()=>document.querySelector('#quest .close').focus());
      const reqStart=requests.length;await page.evaluate(()=>pollEvents());
      await page.evaluate(()=>{clearTimeout(pollTimer);hudT=1;hud(0);});await page.waitForTimeout(250);
      check(requests.slice(reqStart).some(u=>u.endsWith('/events'))&&!requests.slice(reqStart).some(u=>u.endsWith('/replay')),'poll case did not use /events only');
      return page.evaluate(()=>{const a=document.activeElement;return {open:!document.querySelector('#quest').hidden,tag:a.tagName,id:a.id,
        key:a.closest('.item-summary')?.dataset.key||'',connected:a.isConnected,visible:a.getClientRects().length>0,
        gone:!JSON.stringify([D,S]).includes('SYNTHETIC_EVICTED')&&!document.body.textContent.includes('SYNTHETIC_EVICTED')};});
    };
    const settled=f=>f.connected&&f.visible&&f.tag!=='BODY'&&(f.id==='tasks-all'||f.id==='heroes-all'||f.id==='menu-toggle'||f.key!=='');
    for(const [kind,opener,expectOwn] of [['task','#tasks-list [data-key="retention-old"] button','tasks-all'],['hero','#heroes-list [data-key="retention-hero-old"] button','heroes-all']]){
      ({base:b0}=await setup());
      const f=await pollEvict(b0,opener);
      check(!f.open&&f.gone,'poll: '+kind+' detail for evicted subject stayed open or leaked');
      check(settled(f),'poll: focus after '+kind+' detail closed is '+JSON.stringify(f)+' (expected a connected control, not BODY)');
      check(f.id===expectOwn,'poll: focus after '+kind+' detail should land on '+expectOwn+', got '+JSON.stringify(f));
      results['pollFocus-'+kind]=f;
      // The scheduled HUD tick must keep that control stable (no second deletion).
      await page.evaluate(()=>{hudT=1;hud(0);});await page.waitForTimeout(150);
      check(settled(await page.evaluate(()=>{const a=document.activeElement;return {tag:a.tagName,id:a.id,key:a.closest('.item-summary')?.dataset.key||'',connected:a.isConnected,visible:a.getClientRects().length>0};})),'poll: focus lost on later HUD pass ('+kind+')');
    }
    check(errors.length===0,errors.join('; '));
    fs.writeFileSync(path.join(outDir,browserName+'-retention.json'),JSON.stringify({synthetic:true,results,errors},null,2));
    console.log('PASS '+browserName+' open View all/task/hero dialogs follow retained history (rows 257 -> 256, evicted task/hero removed, focus returned)');
  } finally {await ctx.close();}
}

async function runHeroInspect(browser,base,vp) {
  const ctx=await browser.newContext({viewport:vp,deviceScaleFactor:1,hasTouch:true}),page=await ctx.newPage(),errors=[],checks=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  const check=(value,message)=>{if(!value)throw Error(message);checks.push(message);};
  try {
    await page.goto(base);await page.waitForFunction(()=>typeof S!=='undefined'&&Object.keys(S.heroes).length&&Object.keys(SPRV).length);
    await page.evaluate(()=>{
      cancelAnimationFrame(raf);raf=null;UI.menu(false);UI.close();
      const b=D.bots[0],ref=n=>String(n).repeat(20);
      loadReplay({meta:{...D.meta,from_:0,to:100,generated:100,show_titles:false,show_profile_names:true},events:[],
        bots:['root','child','orphan'].map((id,i)=>({...b,id,name:'PRIVATE_NAME',display_name:['Root','Child','Orphan'][i],profile_name:'synthetic-'+id,pet_name:'Demo pet'})),
        tasks:[{id:'hidden',title:'PRIVATE_TASK_CANARY',note:'PRIVATE_NOTE_CANARY',bot:'child',stage:'BUILD',status:'running',parents:['fake-dependency']}],
        sessions:[{bot:'root',session_ref:ref(1),parent_session_ref:null,is_subagent:false,started_at:0},
          {bot:'child',session_ref:ref(2),parent_session_ref:ref(1),is_subagent:true,started_at:0},
          {bot:'orphan',session_ref:ref(3),parent_session_ref:ref(9),is_subagent:true,started_at:0}]});
      reset(100);S.play=false;
      Object.values(S.heroes).forEach((h,i)=>Object.assign(h,{x:1000+(i===2?110:0),y:700,path:[],atk:-1,down:0,sleep:false,effort:'medium',fam:[]}));
      Object.assign(cam,{x:1000,y:670,tx:1000,ty:670,zi:1});draw();
    });
    const picks=await page.evaluate(()=>inspect.picks.filter(p=>p.type==='hero'));
    check(picks.length===3&&picks.every(p=>p.hit.right-p.hit.left>=44&&p.hit.bottom-p.hit.top>=44),'all rendered heroes have 44 CSS px hit targets');
    const p=picks.find(p=>p.id==='child'),x=(p.body.left+p.body.right)/2,y=(p.body.top+p.body.bottom)/2;
    await page.touchscreen.tap(x,y);
    check(await page.locator('#character-content button').count()===2,'overlap exposes both characters');
    await page.getByRole('button',{name:'Child',exact:true}).click();
    await page.evaluate(()=>{followCharacter(1);draw();});
    check((await page.locator('#character-content').innerText()).includes('Parent: Root'),'child resolves explicit session parent');
    const geometry=await page.evaluate(()=>{
      const p=inspect.picks.find(p=>p.id==='child'),c=$('#character-card').getBoundingClientRect(),bar=$('#focus-bar').getBoundingClientRect();
      return {clearance:Math.min(p.body.left,p.body.top-bar.bottom,c.top-p.body.bottom,innerWidth-p.body.right),card:c.toJSON(),hit:p.hit};
    });
    check(geometry.clearance>=8,'followed hero clears card and status by 8 CSS px');
    const invariant=await page.evaluate(()=>{
      const before=JSON.stringify([S,D.events,following,cursor]);
      for(let i=0;i<120;i++){followCharacter(1/60);draw();}
      return before===JSON.stringify([S,D.events,following,cursor]);
    });
    check(invariant,'120 follow/render frames leave replay, hero paths and ledger unchanged');
    if(browserName==='chromium'){
      const cdp=await ctx.newCDPSession(page),saved=await page.evaluate(()=>({...cam}));
      const a={x:40,y:120,id:1},b={x:90,y:120,id:2};
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[a,b]});
      await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[a,{...b,x:110}]});
      await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[{...b,x:110}]});
      await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{...b,x:112}]});
      await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      check(await page.evaluate(()=>inspect.follow&&cam.zi>1),'pinch retains Follow through staggered finger release');
      await page.evaluate(saved=>{Object.assign(cam,saved);draw();},saved);await cdp.detach();
    }
    const privateDOM=await page.content();
    check(!/PRIVATE_TASK_CANARY|PRIVATE_NOTE_CANARY|[1239]{20}/.test(privateDOM),'task prose and session refs absent from DOM');
    await page.screenshot({path:path.join(outDir,`${browserName}-${vp.name}-hero-follow.png`)});
    if(args.includes('--gif-frames')&&browserName==='chromium'&&vp.width===1280){
      const saved=await page.evaluate(()=>({state:cloneState(S),camera:{...cam}}));
      for(let i=0;i<30;i++){
        await page.evaluate(i=>{
          if(i===0){clearInspection();draw();const p=inspect.picks.find(p=>p.id==='child'&&p.type==='hero');click({clientX:(p.body.left+p.body.right)/2,clientY:(p.body.top+p.body.bottom)/2});}
          if(i===4){showInspection('child');S.heroes.root.x-=140;S.heroes.child.path=[[1000,700],[1170,700]];S.tasks.demo={id:'demo',stage:'BUILD',max_rt:1800,x:1160,y:740,alpha:1,emerge:0,atk:-1,hp:1,region:'forge',slot:0,state:'quest'};}
          if(i>=4){stepHero(S.heroes.child,.16);if(i===16){S.tasks.demo.flash=.1;S.tasks.demo.kick=.8;}else{S.tasks.demo.flash=0;S.tasks.demo.kick=0;}renderInspection();followCharacter(.16);draw();}
        },i);
        await page.screenshot({path:path.join(outDir,'hero-frame-'+String(i).padStart(2,'0')+'.png')});
      }
      await page.evaluate(saved=>{Object.assign(S,saved.state);Object.assign(cam,saved.camera);showInspection('child');draw();},saved);
    }
    await page.keyboard.press('Escape');
    check(await page.evaluate(()=>!inspect.follow&&document.activeElement===cv&&$('#character-card').hidden),'Escape stops follow and restores canvas focus');
    await page.evaluate(()=>{showInspection('root');draw();});
    check((await page.locator('#character-content').innerText()).includes('Not a sub-agent'),'root is not a sub-agent');
    await page.evaluate(()=>{showInspection('orphan');draw();});
    check((await page.locator('#character-content').innerText()).includes('Parent unknown'),'orphan does not infer a parent from task dependencies');
    await page.mouse.click(vp.width-12,80);
    check(await page.evaluate(()=>!inspect.follow),'empty-space tap stops follow');
    await page.evaluate(()=>{showInspection('child');draw();});
    await page.mouse.move(vp.width/2,80);await page.mouse.down();await page.mouse.move(vp.width/2+20,80);await page.mouse.up();
    check(await page.evaluate(()=>!inspect.follow&&$('#character-card').hidden),'drag over 8 CSS px pans without selecting');
    await page.evaluate(()=>{clearInspection();Object.assign(cam,{x:1000,y:670,tx:1000,ty:670});draw();});
    await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+7,y);await page.mouse.up();
    check(await page.evaluate(()=>!$('#character-card').hidden),'7 CSS px movement remains a tap, not a pan');
    await page.keyboard.press('Escape');
    await page.evaluate(()=>{clearInspection();Object.assign(cam,{x:1000,y:670,tx:1000,ty:670});draw();});
    await page.mouse.move(x,y);await page.mouse.down();await page.waitForTimeout(550);await page.mouse.up();
    check(await page.evaluate(()=>$('#character-card').hidden),'press over 500 ms does not select');
    await page.locator('#stage').focus();await page.keyboard.press('Enter');
    check(await page.locator('#character-content button').count()===3,'keyboard picker exposes every visible hero');
    await page.keyboard.press('Escape');
    const sessions=await page.evaluate(()=>{
      showInspection('child');D.sessions.push({bot:'child',session_ref:'88888888888888888888',parent_session_ref:'99999999999999999999',is_subagent:true});renderInspection();
      return {text:$('#character-content').textContent,count:document.querySelectorAll('#character-content button').length,selected:selectedSession()};
    });
    check(sessions.count===2&&sessions.selected===null&&sessions.text.includes('Choose a session to inspect its parent'),'multiple sessions require explicit selection of one parent');
    await page.getByRole('button',{name:'Session 1 · Parent: Root',exact:true}).click();
    const chosenText=await page.locator('#character-content').innerText();
    check(chosenText.includes('Parent: Root')&&!chosenText.includes('Choose a session'),'explicit session choice exposes that session parent');
    await page.evaluate(()=>{D.sessions.pop();clearInspection();});
    const links=await page.evaluate(()=>{
      const heroes={...S.heroes},sessions=D.sessions.slice(),stroke=cx.stroke,number=UI.screenNumber;let count=0,more='';
      for(let i=0;i<4;i++){const id='extra'+i;S.heroes[id]={...S.heroes.child,bot:id,x:1000+(i-1.5)*30};D.sessions.push({bot:id,session_ref:String(i+4).repeat(20),parent_session_ref:'11111111111111111111',is_subagent:true});}
      showInspection('root');draw();cx.stroke=()=>{count++;};UI.screenNumber=(value)=>{more=value;};
      inspectionLinks(view());cx.stroke=stroke;UI.screenNumber=number;
      const rows=document.querySelectorAll('#character-content button').length,dom=$('#character-content').textContent;
      S.heroes=heroes;D.sessions=sessions;clearInspection();draw();return{count,more,dom,rows};
    });
    check(links.count===3&&links.more==='+2'&&links.dom.includes('+2')&&links.rows===5,'direct parent/child lines cap at three with +N and complete child list');
    const liveParent=await page.evaluate(()=>{
      showInspection('child');mergeDelta({events:[],tasks:[],bots:[],sessions:[{...D.sessions[1],parent_session_ref:'99999999999999999999'}],cursor:'synthetic-lineage-update'});
      renderInspection();const result=$('#character-content').textContent;
      mergeDelta({events:[],tasks:[],bots:[],sessions:[{...D.sessions.find(s=>s.bot==='child'),parent_session_ref:'11111111111111111111'}],cursor:'synthetic-lineage-restore'});return result;
    });
    check(liveParent.includes('Parent unknown'),'live session metadata upserts refresh parent without inferring');
    await page.evaluate(()=>{showInspection('child');delete S.heroes.child;renderInspection();});
    check((await page.locator('#character-content').innerText()).includes('Character unavailable')&&await page.evaluate(()=>!inspect.follow&&!S.heroes.child),'eviction stops follow without recreating character');
    // A moving monster must use the painted position, never its route destination.
    const monsterPoint=await page.evaluate(()=>{
      clearInspection();S.heroes={};S.tasks={moving:{id:'moving',stage:'TEST',max_rt:1800,x:1900,y:1400,mx:1000,my:700,mpath:[[1900,1400]],mdist:0,mface:1,alpha:1,emerge:0,atk:-1,hp:1,region:'forge',slot:0,state:'fight'}};
      Object.assign(cam,{x:1000,y:670,tx:1000,ty:670});draw();const p=inspect.picks.find(p=>p.type==='monster');return{x:(p.body.left+p.body.right)/2,y:(p.body.top+p.body.bottom)/2};
    });
    await page.mouse.click(monsterPoint.x,monsterPoint.y);
    check(!await page.locator('#quest').evaluate(el=>el.hidden),'moving monster is selected at actual painted coordinates');
    check(errors.length===0,errors.join('; ')||'no console/page errors');
    fs.writeFileSync(path.join(outDir,`${browserName}-${vp.name}-hero-inspect.json`),JSON.stringify({synthetic:true,checks,geometry,errors},null,2));
    console.log('PASS '+browserName+' '+vp.name+' hero inspection ('+checks.length+' checks)');
  }finally{await ctx.close();}
}

fs.mkdirSync(outDir, {recursive: true});
// Regenerate the deterministic synthetic demo exactly as documented (never reads live data).
execFileSync('python3', [path.join('tools', 'mock.py')], {cwd: root, stdio: 'inherit'});
const server = await serve();
const base = `http://127.0.0.1:${server.address().port}`;
console.log(`serving ${root} at ${base} (${browserName})`);
const browser = await playwright[browserName].launch();
console.log(`${browserName} ${browser.version()}`);
let failed = 0;
for (const vp of args.includes('--inspect-only')?[]:VIEWPORTS) {
  const r = await runViewport(browser, base, vp);
  for (const s of r.steps) console.log(`  [${r.viewport}] ${s}`);
  if (r.problems.length) {
    failed++;
    console.log(`FAIL ${browserName} ${r.viewport}`);
    for (const p of [...new Set(r.problems)]) console.log(`  - ${p}`);
  } else console.log(`PASS ${browserName} ${r.viewport}`);
}
for(const vp of VIEWPORTS){try{await runHeroInspect(browser,base,vp);}catch(e){failed++;console.log('FAIL hero inspection '+vp.name+': '+e.stack);}}
if(!args.includes('--inspect-only')) {
try {await runLoadStates(browser,base);} catch(e){failed++;console.log('FAIL load states: '+e.message);}
try {await runRetention(browser,base);} catch(e){failed++;console.log('FAIL retention dialogs: '+e.message);}
try {await runLiveStale(browser,base);} catch(e){failed++;console.log('FAIL live stale warning: '+e.message);}
try {await runLiveMenu(browser,base);} catch(e){failed++;console.log('FAIL synthetic live Menu: '+e.message);}
}
await browser.close();
server.close();
console.log(failed ? `SMOKE FAIL (${failed} failing flows) screenshots: ${outDir}` : `SMOKE PASS screenshots: ${outDir}`);
process.exit(failed ? 1 : 0);
