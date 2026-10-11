'use strict';
// Independent presentation oracles. Synthetic fixtures; no currency/state rewrites by UI.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process'),{chromium,firefox}=require('playwright');
const root=path.resolve(__dirname,'..'),out=path.resolve(process.argv[2]||'.evidence/idle-ui-fix');
const sha=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const served=new Map(),demo=JSON.parse(fs.readFileSync(path.join(root,'data/demo.json'))),now=1700005000;
function fixture(){
  const d=structuredClone(demo);d.events=[];d.sessions=[];Object.assign(d.meta,{source:'live',from_:now-600,to:now,as_of:now,show_titles:false,show_profile_names:false});
  d.working={as_of:now,resting_count:2,latest_order:null,progress:{wins_today:4,xp:140,gold:810,level:2,level_progress:40},
    items:d.tasks.slice(0,2).map((t,i)=>({ref:'synthetic-ui-work-'+i,task_ref:t.id,bot_ref:d.bots[i].id,status:'running',started_at:now-60,display_name:'Build Warrior '+(i+1),class_label:'Build Warrior',quest_kind:'build',quest_label:'Build quest #'+(i+1),worker_observed:true}))};
  return d;
}
const server=http.createServer((req,res)=>{try{
  const u=new URL(req.url,'http://localhost'),n=u.pathname;
  if(n.endsWith('/replay')||n.endsWith('/data/demo.json')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(fixture()));return;}
  if(n.endsWith('/events')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({events:[],tasks:[],bots:[],cursor:null,working:fixture().working,meta:fixture().meta}));return;}
  const relative=n==='/'?'index.html':n.slice(1),file=path.resolve(root,relative);assert(file.startsWith(root+path.sep));
  const b=fs.readFileSync(file);served.set(relative,digest(b));
  res.setHeader('Content-Type',({'.js':'text/javascript','.html':'text/html','.json':'application/json','.png':'image/png','.otf':'font/otf'})[path.extname(file)]||'application/octet-stream');res.end(b);
}catch{res.writeHead(404).end();}});
(async()=>{
  fs.mkdirSync(out,{recursive:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));const records=[];
  try{for(const [engine,type] of Object.entries({chromium,firefox})){
    const browser=require('./parity/browser_loader.cjs').enable(await type.launch({headless:true}));
    try{for(const [width,height] of [[1440,900],[1024,768],[390,844]]){
      const page=await browser.newPage({viewport:{width,height}}),errors=[];
      page.on('pageerror',e=>errors.push(e.message));
      await page.addInitScript(()=>{window.__questTestGlobals=true;window.labels=[];window.timeText=[];
        let text;Object.defineProperty(window,'UIText',{get:()=>text,set:v=>{text={...v,draw(c,t,...a){if(c.canvas.id==='stage')timeText.push(t);return v.draw(c,t,...a);}};}});
      });
      await page.goto('http://127.0.0.1:'+server.address().port+'/?live=1');await page.waitForFunction(()=>window.__questTest?.S.work.has&&typeof loop.last==='number');
      await page.evaluate(()=>{cancelAnimationFrame(raf);clearTimeout(pollTimer);S.play=false;S.t=S.work.asOf;hudT=1;hud(0);
        const label=UIPanels.screenLabel;UIPanels.screenLabel=(...a)=>{labels.push(a);return label(...a);};document.querySelector('#hint-dismiss').click();});
      const load=async(d=fixture())=>page.evaluate(d=>{UIPanels.close();UIPanels.menu(false);loadReplay(d,null,d.working?.as_of??d.meta.to);S.play=false;liveFeed=false;following=false;workView.all=false;workView.focus=null;workView.key='';hudT=1;hud(0);resize();labels=[];draw();},d);
      const capture=async name=>{await page.evaluate(()=>{labels=[];resize();draw();});await page.screenshot({path:path.join(out,`${engine}-${width}-${name}.png`)});};
      const check=async(name,fn)=>{try{await load();const detail=await fn();records.push({engine,browser:browser.version(),width,height,name,pass:true,...detail});}catch(e){records.push({engine,width,height,name,pass:false,error:e.message});}};
      await check('authoritative board gold in Working, vault and World, not replay wallet',async()=>{
        await page.evaluate(()=>{S.vault=171;document.querySelector('#working-toggle').click();Object.assign(cam,{x:W.regions.vault.spot[0],y:W.regions.vault.spot[1],zi:1});resize();labels=[];draw();});
        const r=await page.evaluate(()=>({labels:labels.map(a=>a[0]).join(' '),rewards:document.querySelector('#working-rewards').textContent,vault:S.vault,progress:S.work.progress()}));
        assert(r.rewards.includes('810 game gold · current board'));assert.equal(r.vault,171);assert.equal(r.progress.gold,810);
        if(width>760)assert(r.labels.includes('810 game gold')&&r.labels.includes('current board'),r.labels);
        await capture('board-vault');await page.locator('#menu-toggle').click();await page.locator('#group-world summary').click();await page.locator('#world').click();
        const text=await page.locator('#quest').textContent();assert(text.includes('810 game gold · current board')&&!text.includes('171 game gold'),text);
        await capture('world-board-gold');return r;
      });
      await check('legacy saved replay gold is explicitly scoped, including zero',async()=>{
        const d=structuredClone(demo);delete d.working;await page.evaluate(d=>{loadReplay(d);cancelAnimationFrame(raf);S.play=false;liveFeed=false;S.vault=0;hudT=1;hud(0);},d);
        await page.locator('#menu-toggle').click();await page.evaluate(()=>document.querySelector('#group-world').open=true);await page.locator('#world').click();
        const text=await page.locator('#quest').textContent();assert(text.includes('0 game gold · saved replay'),text);await capture('world-saved-gold');return {text};
      });
      await check('missing board aggregate uses reducer projection, never replay wallet',async()=>{
        const d=fixture();d.working.progress={xp:'unknown'};d.working.items=[];await load(d);
        await page.evaluate(()=>{S.vault=171;});await page.locator('#menu-toggle').click();await page.evaluate(()=>document.querySelector('#group-world').open=true);await page.locator('#world').click();
        const text=await page.locator('#quest').textContent();assert(text.includes('0 game gold · current board'),text);assert(!text.includes('171 game gold'),text);
        // The reducer's existing event projection is 0 here, not a UI fallback into S.vault.
      });
      await check('zero and large board gold agree, open World refreshes on authoritative delta',async()=>{
        const d=fixture();d.working.progress.gold=0;await load(d);
        assert((await page.locator('#working-rewards').textContent()).includes('0 game gold · current board'));
        await page.locator('#menu-toggle').click();await page.evaluate(()=>document.querySelector('#group-world').open=true);await page.locator('#world').click();
        assert((await page.locator('#quest').textContent()).includes('0 game gold · current board'));
        await page.evaluate(()=>{mergeDelta({events:[],tasks:[],bots:[],cursor:null,working:{as_of:S.work.asOf+1,items:S.work.items(),resting_count:2,latest_order:null,progress:{...S.work.progress(),gold:12345}}});hudT=1;hud(0);});
        await page.waitForTimeout(1050);await page.evaluate(()=>{hudT=1;hud(0);});
        assert((await page.locator('#quest').textContent()).includes('12345 game gold · current board'));
        assert((await page.locator('#working-rewards').textContent()).includes('12345 game gold · current board'));
      });
      await check('Show all empty scene has scope; mobile drops only decorative banners',async()=>{
        await page.evaluate(()=>{document.querySelector('#working-toggle').click();for(const t of Object.values(S.tasks))t.alpha=0;labels=[];resize();draw();});
        const text=await page.evaluate(()=>labels.map(a=>a[0]).join(' '));assert(text.includes('No active quests in replay scene'),text);
        assert((await page.locator('#working-count').textContent()).includes('2 active quests'));
        if(width===390)assert(!/REST INN|GOLD VAULT/i.test(text),text);
        await capture('show-all-empty');
        await page.locator('#menu-toggle').click();await capture('show-all-menu');
        const rects=await page.evaluate(()=>[...document.querySelectorAll('#ui-stage canvas')].filter(c=>!c.hidden).map(c=>c.getBoundingClientRect().toJSON()));
        for(let i=0;i<rects.length;i++)for(let j=i+1;j<rects.length;j++){const a=rects[i],b=rects[j];assert(!(a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top),'scene labels overlap');}
        return {text,labels:rects.length};
      });
      await check('progress ratio visible without hover at interior and level boundary',async()=>{
        assert.equal(await page.locator('#guild-progress-text').textContent(),'40/100 XP to Lv 3');await capture('progress');
        const d=fixture();Object.assign(d.working.progress,{xp:200,level:3,level_progress:0});await load(d);
        assert.equal(await page.locator('#guild-progress-text').textContent(),'0/100 XP to Lv 4');
      });
      await check('recap and Guildhall dock below battle center, Close remains usable after scrolling',async()=>{
        for(const [selector,name] of [['#idle-recap','recap'],['#working-guild','guild']]){
          await page.locator(selector).click();const r=await page.locator('#quest').boundingBox();assert(r);
          if(width===390)assert(r.y>height/2&&r.height<=height*.38+1,JSON.stringify(r));
          await capture(name);await page.locator('#quest').evaluate(el=>el.scrollTop=el.scrollHeight);
          assert(await page.locator('#quest .close').isVisible());await page.locator('#quest .close').click();assert(await page.locator('#quest').isHidden());
        }
        await page.locator('#menu-toggle').click();await page.evaluate(()=>document.querySelector('#group-world').open=true);await page.locator('#guild-details').click();
        assert(await page.locator('#menu').isHidden(),'Guildhall closes Menu so the battle center stays clear');await page.keyboard.press('Escape');
        await page.locator('#idle-recap').click();await page.keyboard.press('Escape');assert(await page.locator('#quest').isHidden());
      });
      await check('one transient QUEST COMPLETE per real done transition, replay/duplicate silent',async()=>{
        const result=await page.evaluate(()=>{
          S.fx=[];liveFeed=true;following=true;S.play=true;const items=S.work.items(),progress=S.work.progress();items[0].status='done';
          const delta={events:[],tasks:[],bots:[],cursor:null,working:{as_of:S.work.asOf+1,items,resting_count:2,latest_order:null,progress:{...progress,xp:150,gold:811,level_progress:50}}};
          mergeDelta(delta);const first=S.fx.filter(f=>f.k==='num'&&f.text.includes('CLEAR')).length;mergeDelta(delta);const second=S.fx.filter(f=>f.k==='num'&&f.text.includes('CLEAR')).length;
          S.play=false;hudT=1;hud(0);labels=[];draw();return {first,second,text:labels.map(a=>a[0]).join(' '),gold:S.work.progress().gold,coinLabels:S.fx.filter(f=>f.k==='coin'&&f.label).map(f=>f.label)};
        });
        assert.equal(result.first,1);assert.equal(result.second,1);assert(result.text.includes('Quest complete'),result.text);assert.equal(result.gold,811);
        assert.deepEqual(result.coinLabels,['+1 game gold']);assert(result.text.includes('+1 game gold'));
        await capture('victory');await page.evaluate(()=>{update(2);labels=[];draw();});assert(!(await page.evaluate(()=>labels.map(a=>a[0]).join(' '))).includes('Quest complete'));
        await load();assert.equal(await page.evaluate(()=>S.fx.filter(f=>f.k==='num'&&f.text.includes('CLEAR')).length),0);return result;
      });
      await check('last live completion takes priority over empty scene, then scoped empty returns',async()=>{
        await page.evaluate(()=>{S.fx=[];liveFeed=true;following=true;S.play=true;const items=S.work.items().map(i=>({...i,status:'done'}));
          mergeDelta({events:[],tasks:[],bots:[],cursor:null,working:{as_of:S.work.asOf+1,items,resting_count:2,latest_order:null,progress:{...S.work.progress(),xp:160,gold:812,level_progress:60}}});
          S.play=false;hudT=1;hud(0);labels=[];resize();draw();});
        const text=await page.evaluate(()=>labels.map(a=>a[0]).join(' '));
        assert(text.includes('Quest complete'));assert(!text.includes('No active quests'),text);
        assert.equal(await page.locator('#working-count').textContent(),'0 active quests');await capture('last-live-completion');
        await page.evaluate(()=>{update(2);labels=[];draw();});
        assert((await page.evaluate(()=>labels.map(a=>a[0]).join(' '))).includes('No active quests on this board'));
        await capture('last-completion-expired');return {text};
      });
      await check('coin label has no invented number when reward is absent',async()=>{
        const r=await page.evaluate(()=>{const before=JSON.stringify(S.work.progress());S.fx=[];HQModules.createCombat({S,W}).coins(workView.pairs[0].x,workView.pairs[0].y);labels=[];draw();return {before,after:JSON.stringify(S.work.progress()),labels:S.fx.filter(f=>f.k==='coin'&&f.label).map(f=>f.label)};});
        assert.equal(r.before,r.after);assert.deepEqual(r.labels,['game gold']);return r;
      });
      await check('Menu is opaque over scene time text and Settings remain operable',async()=>{
        await page.locator('#menu-toggle').click();await page.locator('#group-settings').evaluate(el=>el.open=true);
        const color=await page.locator('#menu').evaluate(el=>getComputedStyle(el).backgroundColor);assert.equal(color,'rgb(17, 27, 48)');
        await page.locator('#calm').click();await capture('opaque-menu-settings');
        await page.locator('#hide-panels').click();assert(await page.locator('#menu').isHidden());await page.locator('#menu-toggle').click();assert(await page.locator('#menu').isVisible());await page.locator('#menu-toggle').click();return {color};
      });
      await check('estimated countdown and zone colors are distinct',async()=>{
        const d=structuredClone(demo);delete d.working;await page.evaluate(d=>{loadReplay(d);cancelAnimationFrame(raf);S.play=false;
          for(const x of D.tasks)task(x.id).alpha=0;const t=task(D.tasks[0].id);Object.assign(t,{state:'fight',runStart:S.t-300,max_rt:1800,hp:.83,alpha:1,region:'forge',emerge:0,dying:false,x:700,y:500,mx:700,my:500,mpath:null});
          selectedScene=t.id;Object.assign(cam,{x:700,y:500,tx:700,ty:500,zi:2});timeText=[];labels=[];resize();draw();},d);
        assert((await page.evaluate(()=>timeText)).includes('EST. TIME LEFT 25 MIN'));await capture('estimated-time');
        const tones=await page.evaluate(()=>labels.filter(a=>a[3]===false).map(a=>a[5]));if(width>760)assert(tones.every(c=>c==='#7fc8b8'));
      });
      await check('privacy copy, nonblank canvas, no overflow or uncaught errors',async()=>{
        const d=fixture();d.tasks.forEach(t=>t.title='PRIVATE_UI_TITLE');d.bots.forEach(b=>b.profile_name='PRIVATE_UI_PROFILE');await load(d);
        const r=await page.evaluate(()=>{const c=document.querySelector('#stage'),pixels=c.getContext('2d').getImageData(0,0,c.width,c.height).data,colours=new Set();for(let i=0;i<pixels.length;i+=256)colours.add(pixels.slice(i,i+4).join());return {text:document.body.textContent,labels:labels.map(a=>a[0]).join(' '),colours:colours.size,overflow:document.documentElement.scrollWidth>innerWidth};});
        assert(!/PRIVATE_UI_TITLE|PRIVATE_UI_PROFILE/.test(r.text+r.labels));assert(r.colours>2&&!r.overflow);assert.deepEqual(errors,[]);return {colours:r.colours};
      });
      await page.close();
    }}finally{await browser.close();}
  }}finally{server.close();}
  const manifest=Object.fromEntries([...served].sort());fs.writeFileSync(path.join(out,'served-sha256.json'),JSON.stringify(manifest,null,2));
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({sha,synthetic_only:true,records},null,2));
  for(const r of records)console.log(`${r.pass?'PASS':'FAIL'} ${r.engine} ${r.width} ${r.name}${r.error?' :: '+r.error:''}`);
  if(records.some(r=>!r.pass))process.exitCode=1;
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
