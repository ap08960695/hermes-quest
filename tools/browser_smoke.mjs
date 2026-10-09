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
    await page.click('#log');await page.selectOption('#feed-filter','work');
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

fs.mkdirSync(outDir, {recursive: true});
// Regenerate the deterministic synthetic demo exactly as documented (never reads live data).
execFileSync('python3', [path.join('tools', 'mock.py')], {cwd: root, stdio: 'inherit'});
const server = await serve();
const base = `http://127.0.0.1:${server.address().port}`;
console.log(`serving ${root} at ${base} (${browserName})`);
const browser = await playwright[browserName].launch();
console.log(`${browserName} ${browser.version()}`);
let failed = 0;
for (const vp of VIEWPORTS) {
  const r = await runViewport(browser, base, vp);
  for (const s of r.steps) console.log(`  [${r.viewport}] ${s}`);
  if (r.problems.length) {
    failed++;
    console.log(`FAIL ${browserName} ${r.viewport}`);
    for (const p of [...new Set(r.problems)]) console.log(`  - ${p}`);
  } else console.log(`PASS ${browserName} ${r.viewport}`);
}
try {await runLoadStates(browser,base);} catch(e){failed++;console.log('FAIL load states: '+e.message);}
try {await runLiveMenu(browser,base);} catch(e){failed++;console.log('FAIL synthetic live Menu: '+e.message);}
await browser.close();
server.close();
console.log(failed ? `SMOKE FAIL (${failed} failing flows) screenshots: ${outDir}` : `SMOKE PASS screenshots: ${outDir}`);
process.exit(failed ? 1 : 0);
