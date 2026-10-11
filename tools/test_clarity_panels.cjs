'use strict';
// Synthetic-only visual regression. Real guest bridge + optional official SDK SandboxedFrame.
// QUEST_PYTHON=<venv python> QUEST_SDK_SRC=<desktop src> node tools/test_clarity_panels.cjs <out>
// CLARITY_BEFORE=1 CLARITY_ROOT=<baseline checkout> captures the original defect without claiming PASS.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const {chromium,firefox}=require('playwright');
const root=path.resolve(process.env.CLARITY_ROOT||path.join(__dirname,'..'));
const out=path.resolve(process.argv[2]||path.join(root,'.evidence/clarity'));
const before=process.env.CLARITY_BEFORE==='1',records=[];
fs.mkdirSync(out,{recursive:true});
const boot=JSON.parse(execFileSync(process.env.QUEST_PYTHON||'python3',['-c',
  'import json; from dashboard.desktop_transport import compose_bootstrap; print(json.dumps(compose_bootstrap("ClaritySyntheticNonce123456")))'],{cwd:root,env:{...process.env,PYTHONPATH:root},encoding:'utf8'}));
const demo=JSON.parse(fs.readFileSync(path.join(root,'data/demo.json')));
let sdkBundle=null,sdkHash=null;
if(process.env.QUEST_SDK_SRC){
  fs.writeFileSync(path.join(out,'sdk-utils.cjs'),'exports.cn=(...values)=>values.filter(Boolean).join(" ");');
  const sdk=path.join(process.env.QUEST_SDK_SRC,'components/ui/sandboxed-frame.tsx');
  sdkHash=crypto.createHash('sha256').update(fs.readFileSync(sdk)).digest('hex');
  sdkBundle=require('esbuild').buildSync({stdin:{contents:`import React from 'react'; import {createRoot} from 'react-dom/client'; import {SandboxedFrame} from ${JSON.stringify(sdk)}; window.mountQuest=src=>createRoot(document.getElementById('host')).render(React.createElement(SandboxedFrame,{src,title:'Quest SDK guest',style:{width:'100vw',height:'100vh',border:0}}));`,resolveDir:__dirname},bundle:true,write:false,format:'iife',jsx:'automatic',nodePaths:[path.resolve(__dirname,'../node_modules')],alias:{'@/lib/utils':path.join(out,'sdk-utils.cjs')}});
}
function host(){return `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><div id="host"></div><script src="/sdk.js"></script><script>
const boot=${JSON.stringify(boot).replace(/</g,'\\u003c')};
window.addEventListener('message',e=>{const frame=document.querySelector('iframe');if(!frame||e.source!==frame.contentWindow||e.origin!=='null'||e.data.kind!=='quest-ready'||e.data.nonce!==boot.nonce)return;
const ch=new MessageChannel();ch.port1.onmessage=async e=>{const m=e.data;try{const r=await fetch('/fixture'+m.path);if(!r.ok)throw Error('HTTP '+r.status);ch.port1.postMessage({id:m.id,value:await r.json()});}catch(err){ch.port1.postMessage({id:m.id,error:'Synthetic transport failure'});}};ch.port1.start();frame.contentWindow.postMessage({kind:'quest-connect',nonce:boot.nonce},'*',[ch.port2]);});
mountQuest('data:text/html,'+encodeURIComponent(boot.html)+'?live=1');</script></body></html>`;}
const mime={'.js':'text/javascript','.html':'text/html','.json':'application/json','.png':'image/png','.otf':'font/otf'};
const server=http.createServer((req,res)=>{try{
  const u=new URL(req.url,'http://localhost');let value;
  if(u.pathname==='/sdk'){res.setHeader('Content-Type','text/html');res.end(host());return;}
  if(u.pathname==='/sdk.js'){res.setHeader('Content-Type','text/javascript');res.end(sdkBundle.outputFiles[0].text);return;}
  if(u.pathname.startsWith('/fixture')){
    const route=u.pathname.slice(8);
    if(route==='/replay')value=demo;
    else if(route==='/events')value={events:[],tasks:[],bots:[],cursor:'clarity',state:'online'};
    else if(route==='/desktop-asset'){
      const p=u.searchParams.get('path');assert(/^assets\/px\/[\w./-]+\.png$/.test(p)&&!p.includes('..'));
      const bytes=fs.readFileSync(path.join(root,p));value={mime:'image/png',base64:bytes.toString('base64'),sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
    }else if(route.startsWith('/static/'))value=JSON.parse(fs.readFileSync(path.join(root,route.slice(8))));else throw Error('Denied');
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));return;
  }
  const rel=u.pathname==='/'?'index.html':u.pathname.slice(1),file=path.resolve(root,rel);
  assert(file.startsWith(root+path.sep)&&!rel.includes('..'));res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));
}catch{res.writeHead(404).end();}});
async function capture(page,frame,tag,action){
  await frame.waitForTimeout(80);
  const observation=await frame.evaluate(()=>({heading:document.querySelector('#dialog-heading')?.textContent,
    rows:[...document.querySelectorAll('#quest .bitmap-row')].map(r=>({text:r.textContent,visibleText:!!r.querySelector('.detail-text')&&r.querySelector('.detail-text').getBoundingClientRect().height>0,canvases:r.querySelectorAll('canvas').length})),
    bridge:window.__questBridge?.connected()||false,overflow:document.documentElement.scrollWidth>innerWidth+1,
    scriptExecuted:!!window.CLARITY_XSS,epoch:UIPanels.diagnostics().epoch,
    canvasColours:(()=>{const c=document.querySelector('#stage'),d=c.getContext('2d').getImageData(0,0,c.width,c.height).data,colours=new Set();for(let i=0;i<d.length;i+=256)colours.add([d[i],d[i+1],d[i+2],d[i+3]].join());return colours.size;})()}));
  assert(observation.canvasColours>2,'World canvas must not be blank');
  await page.screenshot({path:path.join(out,tag+'-'+action+'.png')});
  records.push({tag,action,...observation});return observation;
}
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
  try{for(const [engine,type] of Object.entries({chromium,firefox})){
    const browser=require('./parity/browser_loader.cjs').enable(await type.launch({headless:true}));
    try{for(const mode of sdkBundle?['web','sdk']:['web'])for(const [width,height] of before?[[1440,900]]:[[1440,900],[1024,768],[390,844],[375,667],[320,568]]){
      const ctx=await browser.newContext({viewport:{width,height}}),page=await ctx.newPage(),errors=[];
      page.on('pageerror',e=>errors.push(e.message));
      await ctx.addInitScript(()=>{window.__questTestGlobals=true;window.FontFace=class {load(){return Promise.reject(Error('Synthetic font rejection'));}};
        const request=window.requestAnimationFrame.bind(window);window.requestAnimationFrame=fn=>request(t=>{if(!window.__freezeAnimation)fn(t);});});
      await page.goto(base+(mode==='sdk'?'/sdk':'/'));const frame=mode==='sdk'?page.frames().find(f=>f.parentFrame()):page.mainFrame();
      await frame.waitForFunction(()=>window.__questTest?.D?.tasks?.length&&typeof window.__questTest.loop.last==='number'&&window.UIPanels);
      // Freeze transport as well as animation: an automatic successful poll must
      // not overwrite a deliberately injected stale fixture mid-assertion.
      await frame.evaluate(()=>{window.__freezeAnimation=true;const g=window.__questTest;g.S.play=false;cancelAnimationFrame(g.raf);clearTimeout(g.pollTimer);});
      const tag=engine+'-'+mode+'-'+width+'x'+height;
      if(!before){
        await frame.locator('#menu-toggle').evaluate(e=>{if(e.getAttribute('aria-expanded')==='true')e.click();});
        if(mode==='web'){
          assert(await frame.locator('#first-run').isVisible());await page.screenshot({path:path.join(out,tag+'-hint.png')});
          await frame.locator('#hint-dismiss').click();assert(await frame.locator('#first-run').isHidden());
          assert.equal(await frame.evaluate(()=>localStorage.getItem('quest-hint-v1')),'dismissed');
        }else {await frame.locator('#hint-dismiss').click();assert(await frame.locator('#first-run').isHidden());}
      }
      for(const [label,heading] of [['Working quest','Quest details'],['Hero','Hero details'],['Quest','Quest details'],['Region','Location details'],['World','World locations'],['Activity details','Activity details'],['Campaign details','Campaign details'],['Connection details','Connection details'],['Character chooser','Character chooser']]){
        await frame.evaluate(label=>UIPanels.detail(['Quest title hidden to protect privacy','Unsupported glyph: Ж','<img src=x onerror=window.CLARITY_XSS=1>'],label),label);
        const v=await capture(page,frame,tag,heading.replaceAll(' ','-'));
        if(!before){assert.equal(v.heading,heading);assert(v.rows.length===3&&v.rows.every(r=>r.visibleText));assert(!v.scriptExecuted&&!v.overflow);assert.equal(v.bridge,mode==='sdk');assert.equal(await frame.locator('#quest .close').textContent(),'Close');}
        await frame.locator('#quest .close').click();
      }
      if(!before){
        await frame.locator('#quick-help').focus();await frame.locator('#quick-help').press('Enter');
        const v=await capture(page,frame,tag,'help');assert.equal(v.heading,'Help');
        assert.equal(await frame.locator('.legend-row').count(),46);
        assert(v.rows.every(r=>r.visibleText));
        for(const entry of await frame.locator('.legend-row').all()){
          await entry.scrollIntoViewIfNeeded();assert(await entry.locator('.detail-text').isVisible());
        }
        await page.screenshot({path:path.join(out,tag+'-help-end.png')});await frame.locator('#quest .close').click();
        await frame.evaluate(()=>{UIPanels.menu(true);document.querySelector('#group-overview').open=true;
          UIPanels.drawer('camp');UIPanels.camps([{title:'Synthetic campaign',count:'56/68 quests ⚔120',stages:[{id:'build',state:'complete'}]}]);});
        assert.equal(await frame.evaluate(()=>document.activeElement.id),'camp-close');
        await capture(page,frame,tag,'campaign-list');const count=await frame.locator('.campaign-count').textContent();assert(count.includes('56 of 68 quests complete'),JSON.stringify({count,charset:await frame.evaluate(()=>document.characterSet),swordInSource:await frame.evaluate(()=>[...document.scripts].some(s=>s.textContent.includes('⚔')))}));
        await frame.locator('#camps .text-button').click();await capture(page,frame,tag,'campaign-detail');await frame.locator('#quest .close').click();
        await frame.evaluate(()=>{UIPanels.drawer('chron');UIPanels.feed([{text:'Message from Hero · Synthetic activity',detailText:'Permitted event details'}]);});
        assert.equal(await frame.evaluate(()=>document.activeElement.id),'chron-close');await capture(page,frame,tag,'activity-list');
        await frame.locator('#feed .text-button').click();await capture(page,frame,tag,'activity-detail');await frame.locator('#quest .close').click();
        // Real privacy boundary: the runtime must discard synthetic source canaries before panels see them.
        await frame.evaluate(()=>{const g=window.__questTest,d=structuredClone(g.D);d.meta.show_titles=false;
          d.tasks.forEach(t=>{t.title='CLARITY_PRIVATE_CANARY';t.note='CLARITY_PRIVATE_CANARY';});d.events.forEach(e=>e.note='CLARITY_PRIVATE_CANARY');
          g.loadReplay(d,null,d.meta.from_);g.S.play=false;UIPanels.menu(true);document.querySelector('#group-overview').open=true;g.hudT=1;g.hud(0);});
        await frame.locator('#tasks-list button').first().click();await capture(page,frame,tag,'privacy-quest');
        assert.equal(await frame.evaluate(()=>/CLARITY_PRIVATE_CANARY/.test(document.documentElement.outerHTML+JSON.stringify(window.__questTest.D)+JSON.stringify(window.__questTest.S))),false);
        // Deferred work cannot resurrect cleared text, whether it succeeds or rejects after invalidation.
        await frame.evaluate(()=>{window.savedFontFace=FontFace;window.FontFace=class {load(){return new Promise((ok,no)=>{window.rejectPendingFont=()=>no(Error('late font rejection'));});};};
          UIPanels.detail(['CLARITY_PENDING_CANARY'],'Quest');});
        await frame.waitForFunction(()=>typeof window.rejectPendingFont==='function');
        await frame.evaluate(()=>{UIPanels.privacy();rejectPendingFont();window.FontFace=savedFontFace;});
        await frame.waitForTimeout(100);assert.equal(await frame.evaluate(()=>document.documentElement.outerHTML.includes('CLARITY_PENDING_CANARY')),false);
        await frame.evaluate(()=>{UIPanels.menu(false);UIPanels.status('Connected','online');document.querySelector('#connection').click();});
        await capture(page,frame,tag,'connection');await frame.locator('#quest .close').click();
        await frame.evaluate(()=>{UIPanels.overview({tasks:[{key:'synthetic-ref',summary:'Blocked quest',blocked:true,details:()=>UIPanels.detail(['Dependency required'],'Quest')}],heroes:[],blocked:1,errors:[],empty:'No active quests',summary:'1 blocked quest'});document.querySelector('#issues').click();});
        await capture(page,frame,tag,'issues');assert.equal(await frame.locator('#dialog-heading').textContent(),'Issues');await frame.locator('#quest .close').click();
        await frame.evaluate(()=>{UIPanels.menu(true);document.querySelector('#group-overview').open=true;document.querySelector('#tasks-all').click();});
        await capture(page,frame,tag,'all-quests');assert.equal(await frame.locator('#dialog-heading').textContent(),'All quests');await frame.locator('#quest .close').click();
        await frame.locator('#heroes-all').click();await capture(page,frame,tag,'all-heroes');
        assert.equal(await frame.locator('#dialog-heading').textContent(),'All heroes');await frame.locator('#quest .close').click();
        // Integration contract: unchanged retained rows must update their stale/loading metadata,
        // including filter/expand controls and recovery (not just the connection badge).
        for(const source of ['Sample data','Saved history (not live)','Live data']){
          await frame.evaluate(source=>UIPanels.status('Connected','online',{source,following:false}),source);
          assert.equal(await frame.locator('#mode').textContent(),source);
        }
        await frame.evaluate(()=>{
          const opts={stale:true,staleInfo:{updated:'12:34',reason:'server error',retrySeconds:10}};
          UIPanels.status('Server error (503) · retrying in 10 sec','offline',{source:'Live data',status:503});
          UIPanels.overview({tasks:[],heroes:[],blocked:0,errors:[],empty:'No active quests',summary:'No active quests',...opts});
          document.querySelector('#chron').hidden=false;document.querySelector('#camp').hidden=false;
          UIPanels.feed([{text:'Synthetic retained activity',detailText:'Synthetic retained details'}],opts);
          UIPanels.camps([{title:'Synthetic campaign',count:'1 of 2 quests complete',stages:[]}],opts);
        });
        assert.equal(await frame.locator('#connection .control-name').textContent(),'Server error (503)');
        for(const selector of ['#overview-summary','#feed','#camps']){
          const text=await frame.locator(selector).textContent();
          for(const word of ['Stale data','12:34','server error','Retrying in 10 sec'])assert(text.includes(word),selector+' '+word);
        }
        await capture(page,frame,tag,'stale-panels');
        await frame.locator('#feed-filter').selectOption('issues');
        assert((await frame.locator('#feed').textContent()).includes('Stale data'));
        await frame.locator('#feed-all').click();assert((await frame.locator('#feed').textContent()).includes('Stale data'));
        await frame.locator('#camps-all').click();assert((await frame.locator('#camps').textContent()).includes('Stale data'));
        await frame.evaluate(()=>{UIPanels.feed([],{loading:true});});
        assert((await frame.locator('#feed').textContent()).includes('Loading activity'));
        await frame.evaluate(()=>{UIPanels.feed([],{loading:false});UIPanels.camps([],{stale:false});
          UIPanels.overview({tasks:[],heroes:[],blocked:0,errors:[],empty:'No active quests',summary:'No active quests',stale:false});});
        assert((await frame.locator('#feed').textContent()).includes('No activity for this filter in saved history'));
        for(const selector of ['#overview-summary','#feed','#camps'])assert(!(await frame.locator(selector).textContent()).includes('Stale data'));
        await frame.evaluate(()=>{UIPanels.menu(false);UIPanels.setup();});
        assert(!(await frame.locator('#quest').textContent()).includes('HERMES_QUEST_CONFIG'));
        await capture(page,frame,tag,'setup');await frame.getByRole('button',{name:'Technical details',exact:true}).click();
        assert((await frame.locator('#quest').textContent()).includes('hermes_home'));await frame.locator('#quest .close').click();
        await frame.evaluate(()=>{const g=window.__questTest,d=structuredClone(g.D);d.events=[];
          d.working={as_of:d.meta.to,items:d.tasks.slice(0,2).map((t,i)=>({ref:'synthetic-work-'+i,task_ref:t.id,bot_ref:d.bots[i].id,status:'running',started_at:d.meta.to-30,display_name:'Nova '+(i+1),class_label:'Research Mage',quest_kind:'build',worker_observed:true,action_count:3,last_action_at:d.meta.to-8})),resting_count:0,latest_order:null,progress:{wins_today:0,xp:0,gold:0,level:1,level_progress:0}};
          g.loadReplay(d,null,d.meta.to);g.S.play=false;g.hudT=1;g.hud(0);g.resize();g.draw();});
        assert((await frame.locator('#working-panel').textContent()).includes('no damage, progress or rewards'));
        await capture(page,frame,tag,'working-copy');
        await frame.locator('#working-toggle').click();await frame.evaluate(()=>window.__questTest.draw());
        assert(await frame.locator('#working-guide').isVisible());await capture(page,frame,tag,'show-all');
        await frame.locator('#working-choose').click();assert((await frame.locator('#character-content button').count())>=2);
        await frame.locator('#character-content button').first().click();await frame.evaluate(()=>{const g=window.__questTest;g.renderInspection();g.draw();});
        assert((await frame.locator('#scene-selected').getAttribute('aria-label')).includes('Hero'));await capture(page,frame,tag,'show-all-selected');
        await frame.evaluate(()=>{const g=window.__questTest;g.clearInspection();g.workView.all=false;
          const d=structuredClone(g.D);d.tasks=[];d.bots=[];d.events=[];d.working={as_of:d.meta.to,items:[],resting_count:0,latest_order:null,progress:{wins_today:0,xp:0,gold:0,level:1,level_progress:0}};
          g.loadReplay(d,null,d.meta.to);g.S.play=false;g.resize();g.hudT=1;g.hud(0);g.draw();});
        assert(await frame.locator('#empty-note').isVisible());assert((await frame.locator('#empty-note').textContent()).includes('Start a task in Hermes Kanban'));
        await capture(page,frame,tag,'empty-next-action');
        await frame.evaluate(async()=>{const g=window.__questTest;window.savedFetch=fetch;window.fetch=async()=>({ok:false,status:503});
          g.liveFeed=true;g.lastPollOk=Date.now();g.pollFailures=0;g.pollStale=false;
          for(let i=0;i<3;i++){await g.pollEvents();clearTimeout(g.pollTimer);}g.hudT=1;g.hud(0);});
        assert((await frame.locator('#issues').textContent()).includes('custom Hermes folder'));
        assert(!(await frame.locator('#issues').textContent()).includes('HERMES_QUEST_CONFIG'));
        await capture(page,frame,tag,'stale-error-guidance');
        await frame.evaluate(async()=>{await window.__questTest.boot();window.fetch=savedFetch;});
        assert(await frame.getByRole('button',{name:'Retry',exact:true}).isVisible());
        await capture(page,frame,tag,'initial-error-guidance');
        assert.deepEqual(errors,[]);if(mode==='web'){await page.reload();await frame.waitForFunction(()=>window.UIPanels&&window.__questTest?.D);assert(await frame.locator('#first-run').isHidden());assert(await frame.locator('#quick-help').isVisible());}
      }
      await ctx.close();console.log('OK '+tag);
    }}finally{await browser.close();}
  }}finally{await new Promise(r=>server.close(r));}
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({before,synthetic:true,sdkHash,source:boot.source,candidate:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),records},null,2));
  console.log((before?'CAPTURE BEFORE':'PASS clarity panels')+' '+records.length+' surface captures');
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
