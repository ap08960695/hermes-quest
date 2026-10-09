'use strict';
// Real Chromium proof; Playwright is an optional external test tool, not a runtime dependency.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict'),cp=require('node:child_process');
const crypto=require('node:crypto');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),out=path.resolve(process.argv[2]||process.env.TMPDIR||'.');fs.mkdirSync(out,{recursive:true});
const mode=process.argv[3]||'smoke',base='a326040901cc54d6e4a6fc34ea2ec2be97e4bb44';
const demo=JSON.parse(fs.readFileSync(path.join(root,'data/demo.json'))),requests=[];
const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript','.otf':'font/otf','.json':'application/json','.png':'image/png'};
let seq=0;
function liveReplay(){const d=structuredClone(demo),shift=Date.now()/1000-d.meta.to;d.events.forEach(e=>e.t+=shift);d.meta.from_+=shift;d.meta.to+=shift;d.cursor=String(seq);return d;}
const server=http.createServer((req,res)=>{
  const u=new URL(req.url,'http://localhost');requests.push({time:Date.now(),path:u.pathname});
  if(u.pathname.startsWith('/api/plugins/hermes-quest/replay')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(liveReplay()));return;}
  if(u.pathname.startsWith('/api/plugins/hermes-quest/events')){
    seq++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({events:[{id:'fresh-'+seq,t:Date.now()/1000,task:'t_demo0001',kind:'heartbeat',bot:'demo-smith',note:'synthetic update '+seq}],tasks:[],bots:[],cursor:String(seq),state:'online'}));return;
  }
  if(u.pathname==='/dashboard-host'){
    // Synthetic host chrome: 56px header + 24px top inset + 64px bottom inset.
    // The stateless SDK adapter mounts the actual plugin bundle, not a copied iframe.
    res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><html><head><style>
      *{box-sizing:border-box}body{margin:0;background:#10121c;color:white}
      header{height:56px;padding:16px}main{height:calc(100dvh - 56px);padding:24px 16px 64px;overflow:auto}
      </style></head><body><header>Hermes Quest — synthetic dashboard</header><main id="plugin"></main><script>
      window.__HERMES_PLUGIN_SDK__={React:{createElement(tag,props,...children){
        const el=document.createElement(tag);for(const [key,value] of Object.entries(props||{})){
          if(key==='style')Object.assign(el.style,value);else el.setAttribute(key,value);
        }el.append(...children);return el;
      }}};
      window.__HERMES_PLUGINS__={register(name,Component){document.querySelector('#plugin').append(Component());}};
      </script><script src="/dashboard/dist/index.js"></script></body></html>`);return;
  }
  let name=decodeURIComponent(u.pathname),baseline=name.startsWith('/before/');name=name.replace(/^\/before\//,'/').replace(/^\/api\/plugins\/hermes-quest\/static\//,'/');if(name==='/')name='/index.html';
  if(name.includes('..')){res.writeHead(404);res.end();return;}
  try{const data=baseline?cp.execFileSync('git',['show',base+':'+name.slice(1)],{cwd:root,maxBuffer:32*1024*1024,stdio:['ignore','pipe','ignore']}):fs.readFileSync(path.join(root,name));res.setHeader('Content-Type',mime[path.extname(name)]||'application/octet-stream');res.end(data);}catch{res.writeHead(404);res.end();}
});
async function ready(page,url){await page.goto(url);await page.waitForFunction(()=>typeof S==='object'&&typeof W==='object'&&W&&typeof loop.last==='number',{},{timeout:30000});}
// Navigation only: relocated controls retain their original behavioral gates.
async function openGroup(page,id){
  if(await page.locator('#menu').isHidden())await page.click('#menu-toggle');
  const group=page.locator('#group-'+id);
  if(!await group.evaluate(el=>el.open))await group.locator('summary').click();
}
function errors(page){const all=[];page.on('pageerror',e=>all.push('page: '+e.message));page.on('console',m=>{if(m.type()==='error')all.push('console: '+m.text());});page.on('requestfailed',r=>all.push('request: '+r.url()));page.on('response',r=>{if(r.status()>=400)all.push('http: '+r.status()+' '+r.url());});return all;}
function monitor(){
  window.measurement={frames:[],tasks:[],start:performance.now(),last:null};
  const observer=new PerformanceObserver(list=>{for(const e of list.getEntries())measurement.tasks.push({start:e.startTime,duration:e.duration});});observer.observe({type:'longtask',buffered:false});window.probeObserver=observer;
  const original=loop;loop=function(ts){if(measurement.last!==null)measurement.frames.push({ts,dt:ts-measurement.last});measurement.last=ts;return original(ts);};
}
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port+'/';let browser,native;
  const sourceHashes=()=>Object.fromEntries(['game.js','index.html','ui-panels.js','dashboard/plugin_api.py','dashboard/dist/index.js','tools/test_ui_mobile.cjs'].map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,f))).digest('hex')]));
  const report={base,browser:null,mode,source:sourceHashes(),demoSHA:crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'data/demo.json'))).digest('hex'),records:[]};
  try{
    if(mode==='hidden'){
      // Native default-context attachment avoids Playwright's sticky forced visibility.
      const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'quest-hidden-'));
      native=cp.spawn(chromium.executablePath(),['--no-sandbox','--no-first-run','--remote-debugging-port=0','--user-data-dir='+dir,'--ozone-platform=x11','about:blank'],{stdio:'ignore'});
      let port;for(let i=0;i<100;i++){try{port=fs.readFileSync(path.join(dir,'DevToolsActivePort'),'utf8').split('\n')[0];break;}catch{await new Promise(r=>setTimeout(r,100));}}
      assert(port,'Native browser readiness');browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{noDefaults:true});
    }else browser=await chromium.launch({headless:true});report.browser=await browser.version();
    if(mode==='perf'||mode==='perf-after'){
      for(const before of (mode==='perf-after'?[false]:[true,false]))for(const cpu of [1,4])for(const live of [false,true]){
        const page=await browser.newPage({viewport:{width:375,height:667},deviceScaleFactor:3}),err=errors(page),cdp=await page.context().newCDPSession(page);
        await cdp.send('Emulation.setCPUThrottlingRate',{rate:cpu});await cdp.send('Performance.enable');
        await ready(page,url+(before?'before/':'')+(live?'?live=1':''));await page.evaluate(monitor);const metrics0=(await cdp.send('Performance.getMetrics')).metrics;
        await page.waitForTimeout(60000);const metrics1=(await cdp.send('Performance.getMetrics')).metrics;
        const record=await page.evaluate(()=>{const end=performance.now(),start=measurement.start+5000,f=measurement.frames.filter(f=>f.ts>=start),rates=f.map(f=>1000/f.dt).sort((a,b)=>a-b),tasks=measurement.tasks.filter(t=>t.start>=start);
          return {elapsed:(end-start)/1000,frames:f.length,avg:f.length/((end-start)/1000),p5:rates[Math.floor(rates.length*.05)]||0,longTasks:tasks.length,maxLongTask:Math.max(0,...tasks.map(t=>t.duration)),tasks,hidden:document.hidden};});
        const m=(xs,k)=>xs.find(x=>x.name===k)?.value;record.taskDurationPerSecond=(m(metrics1,'TaskDuration')-m(metrics0,'TaskDuration'))/60;
        report.records.push({before,cpu,live,...record,errors:err});console.log(JSON.stringify(report.records.at(-1)));await page.close();
      }
    }else if(mode==='functional'){
      const page=await browser.newPage({viewport:{width:320,height:568},deviceScaleFactor:3}),err=errors(page);
      let replayCount=0,release;const delayed=new Promise(r=>release=r);
      const sensitive=liveReplay();sensitive.meta.show_titles=true;sensitive.meta.config_revision='opt-in';sensitive.tasks.forEach(t=>{t.title='UI_CANARY_TITLE';t.note='UI_CANARY_NOTE';});sensitive.events.forEach(e=>e.note='UI_CANARY_EVENT');
      await page.route('**/api/plugins/hermes-quest/replay*',async route=>{
        replayCount++;if(replayCount===2){await delayed;await route.fulfill({status:503,body:'synthetic unavailable'});return;}
        const data=replayCount===1?sensitive:liveReplay();if(replayCount>1){data.meta.show_titles=false;data.meta.config_revision='opt-out';}
        await route.fulfill({json:data});
      });
      await page.route('**/api/plugins/hermes-quest/events*',route=>route.fulfill({json:{events:[],tasks:[],bots:[],cursor:'migration',meta:{show_titles:false,config_revision:'opt-out'}}}));
      await ready(page,url+'?live=1');await page.evaluate(()=>{clearTimeout(pollTimer);pollTimer=null;S.play=false;UIPanels.detail(['UI_CANARY_PENDING'],'synthetic');});
      await page.waitForTimeout(100);await page.evaluate(()=>{window.pollProof=pollEvents();});await page.waitForFunction(()=>privacyPending,null,{polling:100});
      const pending=await page.evaluate(()=>({pending:privacyPending,dom:document.body.textContent.includes('UI_CANARY'),data:JSON.stringify(D).includes('UI_CANARY'),state:JSON.stringify(S).includes('UI_CANARY'),epoch:UIPanels.diagnostics().epoch}));
      assert.equal(pending.dom,false);assert.equal(pending.data,false);assert.equal(pending.state,false);release();await page.evaluate(()=>pollProof);assert(await page.evaluate(()=>privacyPending));
      await page.evaluate(async()=>{clearTimeout(pollTimer);await pollEvents();clearTimeout(pollTimer);pollTimer=null;});assert.equal(await page.evaluate(()=>privacyPending),false);
      await openGroup(page,'playback');
      await page.click('#live');assert(await page.evaluate(()=>following));await page.click('#play');assert.equal(await page.evaluate(()=>following),false);
      await page.locator('#speeds').focus();await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>S.speed),30);
      await openGroup(page,'settings');await page.click('#calm');assert.equal(await page.locator('#calm').getAttribute('aria-pressed'),'true');
      await openGroup(page,'playback');await page.locator('#scrub').focus();await page.keyboard.press('Home');assert.equal(await page.evaluate(()=>S.t),await page.evaluate(()=>D.meta.from_));
      await openGroup(page,'world');await page.click('#world');assert(await page.locator('#quest').isVisible());await page.keyboard.press('Escape');assert(await page.locator('#quest').isHidden());
      await openGroup(page,'settings');await page.click('#help');await page.waitForTimeout(500);assert.equal(await page.locator('.legend-row').count(),46);assert.equal(await page.evaluate(()=>document.querySelector('#quest').scrollWidth>document.querySelector('#quest').clientWidth+1),false);
      await page.screenshot({path:path.join(out,'legend-320.png')});await page.keyboard.press('Escape');
      const pure=await page.evaluate(()=>{S.play=false;const old=JSON.stringify(S);for(let i=0;i<10;i++)draw();return old===JSON.stringify(S);});assert(pure,'draw must not mutate simulation');
      await page.click('#menu-toggle');assert(await page.locator('#menu').isHidden());
      await page.setViewportSize({width:390,height:844});await page.evaluate(()=>UIPanels.resize());
      const glyphs=await page.evaluate(()=>{UIPanels.clear();for(let i=0;i<10;i++)UIPanels.screenNumber('10',160,200);const d=UIPanels.diagnostics();return {count:d.drawn.length,rows:d.drawn.map(r=>r.top)};});assert.equal(glyphs.count,3);
      report.records.push({pending,replayCount,pure,glyphs,errorsExpected503:err});assert.equal(err.filter(e=>!e.includes('503')).length,0);await page.close();
    }else if(mode==='hidden'){
      const context=browser.contexts()[0],page=context.pages()[0],err=errors(page);
      await ready(page,url+'?live=1');await page.evaluate(()=>{window.rafCalls=0;const orig=loop;loop=function(ts){rafCalls++;return orig(ts);};});
      const cdp=await context.newCDPSession(page),win=await cdp.send('Browser.getWindowForTarget');
      const other=await context.newPage();await other.goto('about:blank');await other.bringToFront();
      await page.waitForFunction(()=>document.hidden===true,null,{polling:100});
      const start=Date.now(),count=await page.evaluate(()=>rafCalls);await new Promise(r=>setTimeout(r,60000));
      const hidden=await page.evaluate(()=>({hidden:document.hidden,rafCalls,raf,pollTimer})),polls=requests.filter(r=>r.time>=start&&r.path.endsWith('/events')).length;
      assert.equal(hidden.hidden,true);assert.equal(hidden.rafCalls,count);assert.equal(polls,0);
      const back=Date.now();await page.bringToFront();await page.waitForFunction(()=>!document.hidden,null,{polling:100});await page.waitForTimeout(1500);
      const catches=requests.filter(r=>r.time>=back&&r.path.endsWith('/events')).length;assert.equal(catches,1);assert((await page.evaluate(()=>rafCalls))>count);
      report.records.push({hidden,callbackDelta:hidden.rafCalls-count,pollsIn60s:polls,catchupPolls:catches,errors:err});await context.close();
    }else if(mode==='dashboard'){
      const page=await browser.newPage({viewport:{width:844,height:390},deviceScaleFactor:3}),err=errors(page);
      await page.goto(url+'dashboard-host');
      const frame=await page.locator('iframe').elementHandle(),game=await frame.contentFrame();
      await game.waitForFunction(()=>typeof S==='object'&&typeof W==='object'&&W&&typeof loop.last==='number');
      // Reuse the mounted page to exercise orientation changes without reloading the iframe.
      for(const [width,height] of [[844,390],[667,375],[568,320],[1280,800],[800,1280],[390,844],[375,667],[320,568],[844,390]]){
        await page.setViewportSize({width,height});
        await page.waitForTimeout(150);
        await game.evaluate(()=>{S.play=false;reset(D.meta.from_+2100);draw();});
        const host=await page.locator('iframe').boundingBox();
        const geometry=await game.evaluate(()=>{
          const rect=el=>{const r=el.getBoundingClientRect();return {id:el.id,x:r.x,y:r.y,w:r.width,h:r.height,bottom:r.bottom};};
          return {width:innerWidth,height:innerHeight,hud:rect(document.querySelector('#focus-bar')),toolbarRects:document.querySelector('#hud').getClientRects().length,canvas:rect(document.querySelector('#stage')),buttons:[...document.querySelectorAll('button')].filter(b=>b.getClientRects().length&&!b.hidden&&!b.closest('[hidden]')).map(rect)};
        });
        assert(host.x>=0&&host.y>=0&&host.x+host.width<=width&&host.y+host.height<=height,'iframe viewport bounds');
        assert.equal(host.height,height-144,'dashboard available height');
        for(const b of [geometry.hud,...geometry.buttons]){
          assert(b.x>=-1&&b.x+b.w<=geometry.width+1&&b.y>=-1&&b.bottom<=geometry.height+1,b.id+' iframe bounds');
          assert(host.x+b.x>=-1&&host.x+b.x+b.w<=width+1&&host.y+b.y>=-1&&host.y+b.bottom<=height+1,b.id+' host bounds');
        }
        assert.equal(geometry.toolbarRects,0,'old toolbar absent in focus mode');
        assert.equal(geometry.hud.h,46,'compact overlay: 44px controls plus tag borders');
        assert(geometry.hud.w<geometry.width-16,'compact overlay does not become a full-width toolbar');
        assert.equal(geometry.canvas.w,geometry.width);assert.equal(geometry.canvas.h,geometry.height);
        for(const b of geometry.buttons)assert(b.w>=44&&b.h>=44,b.id+' touch target');
        assert.deepEqual(err,[]);
        if(width>height&&width<1000)await page.screenshot({path:path.join(out,'dashboard-'+width+'x'+height+'.png')});
        report.records.push({width,height,host,geometry,errors:[...err]});console.log('PASS dashboard '+width+'x'+height);
      }
      await page.close();
    }else{
      for(const [width,height] of [[1280,800],[800,1280],[390,844],[844,390],[375,667],[667,375],[320,568],[568,320]])for(const zoom of [1,2,3]){
        const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:3}),err=errors(page);
        await ready(page,url);await page.evaluate(z=>{S.play=false;reset(D.meta.from_+2100);cam.zi=z;draw();},zoom);await page.waitForTimeout(150);
        const geometry=await page.evaluate(()=>{
          const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,bottom:r.bottom};};
          const boxes=['#focus-bar'].map(s=>document.querySelector(s).getBoundingClientRect());
          const outer=boxes.filter((r,i)=>!boxes.some((o,j)=>i!==j&&r.left>=o.left&&r.top>=o.top&&r.right<=o.right&&r.bottom<=o.bottom));
          const bitmaps=[...document.querySelectorAll('#ui-stage canvas')].filter(c=>!c.hidden).map(c=>c.getBoundingClientRect());
          const occlusion=outer.concat(bitmaps).reduce((a,r)=>a+r.width*r.height,0)/(innerWidth*innerHeight);
          return {occlusion,hud:rect('#focus-bar'),toolbarRects:document.querySelector('#hud').getClientRects().length,buttons:[...document.querySelectorAll('button')].filter(b=>b.getClientRects().length&&!b.hidden&&!b.closest('[hidden]')).map(b=>({id:b.id,...rect('#'+b.id)})),scroll:document.documentElement.scrollWidth,grid:UIPanels.diagnostics().grid,worldDPR:DPR,visibleText:document.body.innerText.trim()};
        });
        assert.equal(geometry.visibleText,'Menu\nDEMO');assert.equal(geometry.toolbarRects,0);assert(geometry.hud.h<=(width>760&&height>500?64:176));assert(geometry.scroll<=width+1);assert(geometry.occlusion<=(width>760&&height>500?.2:.25),'closed UI occlusion budget '+JSON.stringify({width,height,zoom,geometry}));
        for(const b of geometry.buttons){assert(b.w>=44&&b.h>=44,b.id+' hitbox');assert(b.x>=-1&&b.x+b.w<=width+1&&b.y>=-1&&b.bottom<=height+1,b.id+' bounds');}
        await openGroup(page,'overview');await page.click('#log');const log=await page.evaluate(()=>{const c=document.querySelector('#chron').getBoundingClientRect(),m=document.querySelector('#menu'),r=m.getBoundingClientRect();return {x:c.x,w:c.width,menuX:r.x,menuW:r.width,menuBottom:r.bottom,overflow:m.scrollWidth>m.clientWidth+1};});assert(log.x>=log.menuX&&log.x+log.w<=log.menuX+log.menuW&&log.menuBottom<=height-8&&!log.overflow,'feed stays in scrollable Menu');
        await page.click('#chron-close');assert(await page.locator('#chron').isHidden());
        await page.click('#quests');assert(await page.locator('#chron').isHidden());assert(await page.locator('#camp').isVisible());
        await page.click('#quests');await page.evaluate(()=>UIPanels.detail(['กี่ กุ้ง น้ำ ฤทธิ์ ปี่ '+'A'.repeat(1024)],'synthetic detail'));await page.waitForTimeout(1000);
        const detail=await page.evaluate(()=>{const el=document.querySelector('#quest'),r=el.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,scroll:el.scrollWidth,client:el.clientWidth,canvases:el.querySelectorAll('canvas').length};});
        assert(detail.x>=8&&detail.y>=8&&detail.x+detail.w<=width-8&&detail.y+detail.h<=height-8);assert(detail.scroll<=detail.client+1);assert(detail.canvases>5);
        if(zoom!==2)await page.screenshot({path:path.join(out,'after-'+width+'x'+height+'-z'+zoom+'.png')});
        await page.keyboard.press('Escape');
        const privacy=await page.evaluate(async()=>{
          const r=structuredClone(D);r.meta.show_titles=false;r.tasks.forEach(t=>{t.title='UI_CANARY_TITLE';t.note='UI_CANARY_NOTE';});r.events.forEach(e=>e.note='UI_CANARY_EVENT');
          UIPanels.detail(['UI_CANARY_PENDING']);loadReplay(r,null,r.meta.from_+2100);quest(Object.values(S.tasks)[0]);await new Promise(r=>setTimeout(r,100));
          return {data:JSON.stringify(D).includes('UI_CANARY'),state:JSON.stringify(S).includes('UI_CANARY'),dom:document.body.textContent.includes('UI_CANARY'),epoch:UIPanels.diagnostics().epoch};
        });assert.equal(privacy.data,false);assert.equal(privacy.state,false);assert.equal(privacy.dom,false);assert.deepEqual(err,[]);
        report.records.push({width,height,dpr:3,zoom,geometry,log,detail,privacy,errors:err});console.log('PASS '+width+'x'+height+' z'+zoom);await page.close();
      }
      // Paired initial camera/world images, before any random ambience is advanced.
      for(const before of [true,false]){
        const page=await browser.newPage({viewport:{width:375,height:667},deviceScaleFactor:3});await ready(page,url+(before?'before/':''));
        await page.evaluate(()=>{S.play=false;reset(D.meta.from_);Object.assign(cam,{x:1000,y:700,tx:1000,ty:700,zi:1});draw();});
        await page.screenshot({path:path.join(out,(before?'before':'after')+'-paired.png')});await page.close();
      }
    }
    report.requests=requests;fs.writeFileSync(path.join(out,mode+'-report.json'),JSON.stringify(report,null,2)+'\n');console.log('PASS '+mode);
  }finally{if(browser)await browser.close();if(native)native.kill();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
