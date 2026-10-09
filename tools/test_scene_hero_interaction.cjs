'use strict';
// Native-interaction regression for the combined scene + hero-inspection build.
// Synthetic data only. Real mouse events, real DOM hit-testing; never a direct heroDialog() call
// as the only proof. Usage: node tools/test_scene_hero_interaction.cjs [outDir]
// BASE_REF (default da51d6d, the main base) supplies the region-click reference run.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {chromium,firefox}=require('playwright');
const root=path.resolve(__dirname,'..'),out=process.argv[2];
const BASE_REF=process.env.BASE_REF||'da51d6d18973ce053806ed3cbb88bd497dfd2b9d';
const mime={'.html':'text/html','.js':'text/javascript','.json':'application/json','.png':'image/png','.otf':'font/otf'};
const intersects=(a,b)=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;
function extractBase() {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'quest-base-'));
  const tar=execFileSync('git',['archive',BASE_REF],{cwd:root,maxBuffer:1<<28});
  execFileSync('tar',['-x','-C',dir],{input:tar});
  return dir;
}
const baseDir=extractBase();
const server=http.createServer((req,res)=>{
  let rel=new URL(req.url,'http://local').pathname;const b=rel.startsWith('/base/');if(b)rel=rel.slice(5);
  if(rel==='/')rel='/index.html';
  const r=b?baseDir:root,file=path.resolve(r,'.'+rel);
  if(!file.startsWith(r+path.sep)){res.writeHead(403).end();return;}
  fs.readFile(file,(e,d)=>{res.writeHead(e?404:200,{'content-type':mime[path.extname(file)]||'application/octet-stream'});res.end(e?'missing':d);});
});
const records=[];
(async()=>{
  if(out)fs.mkdirSync(out,{recursive:true});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const url='http://127.0.0.1:'+server.address().port;
  try {
    for(const [engine,type] of Object.entries({chromium,firefox})){
      const browser=require('./parity/browser_loader.cjs').enable(await type.launch({headless:true}));
      try {
        for(const [width,height] of [[1280,800],[390,844],[375,667],[320,568],[667,375],[568,320]]){
          const page=await browser.newPage({viewport:{width,height}}),errors=[];
          page.on('pageerror',e=>errors.push(e.message));
          page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
          await page.addInitScript(()=>{window.requestAnimationFrame=()=>0;window.__clock=0;Object.defineProperty(performance,'now',{value:()=>window.__clock});});
          await page.goto(url);
          await page.waitForFunction(()=>document.querySelector('#connection')?.getAttribute('aria-label')==='Replay file normal',null,{polling:50});
          const tag=engine+' '+width+'x'+height,rec={tag,checks:[]};
          const check=(label,ok,detail)=>{rec.checks.push({label,ok:!!ok,detail});assert(ok,tag+': '+label+(detail===undefined?'':' '+JSON.stringify(detail)));};

          // (a) region canvas click, compared with main (base) behaviour.
          await page.evaluate(()=>{UI.menu(false);UI.close();clearInspection();loadReplay({meta:{from_:0,to:600,show_titles:false,show_profile_names:false},bots:[],tasks:[],events:[]});reset(0);resize();Object.assign(cam,{x:1000,tx:1000,y:700,ty:700,zi:1});draw();});
          const pt={x:width-24,y:height-48};
          const regionClick=async(p,prefix)=>{
            const target=await p.evaluate(({x,y})=>document.elementFromPoint(x,y)?.id,pt);
            await p.mouse.click(pt.x,pt.y);
            return p.evaluate(()=>({cam:{tx:cam.tx,ty:cam.ty,zi:cam.zi},quest:!$('#quest').hidden,text:$('#quest').textContent}));
          };
          const cand=await regionClick(page);
          const basePage=await browser.newPage({viewport:{width,height}});
          await basePage.addInitScript(()=>window.requestAnimationFrame=()=>0);
          await basePage.goto(url+'/base/');
          await basePage.waitForFunction(()=>document.querySelector('#connection')?.getAttribute('aria-label')==='Replay file normal',null,{polling:50});
          await basePage.evaluate(()=>{UI.close();UI.menu(false);loadReplay({meta:{from_:0,to:600,show_titles:false},bots:[],tasks:[],events:[]});reset(0);resize();Object.assign(cam,{x:1000,tx:1000,y:700,ty:700,zi:1});draw();});
          const base=await regionClick(basePage);await basePage.close();
          check('empty tap with no inspection: camera equals main (zoom 2, nearest region)',JSON.stringify(cand.cam)===JSON.stringify(base.cam)&&cand.cam.zi===2,{cand:cand.cam,base:base.cam});
          check('empty tap with no inspection: Region details open like main',cand.quest&&base.quest&&/Quests: \d+/.test(cand.text)&&cand.text===base.text,{cand:cand.text,base:base.text});
          // Open inspection: an empty tap closes the inspection and does not navigate.
          const closed=await page.evaluate(()=>{UI.close();loadReplay({meta:{from_:0,to:600,show_titles:false},bots:[{id:'solo',cls:'commander',model:'Sol',region:'forge'}],tasks:[],sessions:[],events:[]});reset(0);const h=S.heroes.solo;Object.assign(h,{x:1000,y:700,path:[]});Object.assign(cam,{x:1000,tx:1000,y:700,ty:700,zi:1});draw();showInspection('solo');draw();return {open:!$('#character-card').hidden};});
          check('inspection opened for empty-tap dismissal case',closed.open);
          const emptyPoint=await page.evaluate(()=>{const pts=[[innerWidth-12,innerHeight-12],[innerWidth-12,innerHeight/2],[innerWidth/2,innerHeight-12]];
            return pts.map(([x,y])=>({x,y})).find(p=>!inspect.picks.some(k=>p.x>=k.hit.left&&p.x<=k.hit.right&&p.y>=k.hit.top&&p.y<=k.hit.bottom)&&document.elementFromPoint(p.x,p.y)===cv);});
          check('found an empty canvas point',!!emptyPoint);
          const beforeCam=await page.evaluate(()=>({tx:cam.tx,ty:cam.ty}));
          await page.mouse.click(emptyPoint.x,emptyPoint.y);
          const afterClose=await page.evaluate(()=>({card:!$('#character-card').hidden,bot:inspect.bot,quest:!$('#quest').hidden,cam:{tx:cam.tx,ty:cam.ty}}));
          check('empty tap with inspection open closes it without navigating',!afterClose.card&&afterClose.bot===null&&!afterClose.quest&&afterClose.cam.tx===beforeCam.tx,afterClose);

          // Real native monster hit still opens task details; overflow entries are not sprite picks.
          const monster=await page.evaluate(()=>{UI.close();clearInspection();loadReplay({meta:{from_:0,to:600,show_titles:false},bots:[],events:[],tasks:[{id:'t_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',title:'PRIVATE_TASK_CANARY',stage:'BUILD'}]});reset(0);spawnMonster(task(D.tasks[0].id),'forge');for(let i=0;i<9000;i++){window.__clock+=1000/60;S.play=true;S.speed=1;update(1/60);}S.play=false;const m=S.tasks[D.tasks[0].id];Object.assign(cam,{x:m.x,tx:m.x,y:m.y-40,ty:m.y-40,zi:1});draw();const p=inspect.picks.find(p=>p.type==='monster');return p?{id:p.id,point:{x:(p.body.left+p.body.right)/2,y:(p.body.top+p.body.bottom)/2}}:null;});
          check('monster is a sprite pick',!!monster);
          await page.mouse.click(monster.point.x,monster.point.y);
          const mAfter=await page.evaluate(()=>({selected:selectedScene,quest:!$('#quest').hidden,leak:/PRIVATE_TASK_CANARY|t_aaaaaaaa/.test($('#quest').outerHTML)}));
          check('native monster click opens its private-safe task details',mAfter.quest&&mAfter.selected===monster.id&&!mAfter.leak,mAfter);

          // (b)+(c) crowd of 18 heroes: private labels, session unavailable, 422 stale.
          const crowd=await page.evaluate(()=>{UI.close();clearInspection();loadReplay({meta:{from_:0,to:600,show_titles:false,show_profile_names:false,config_revision:'closed'},session_data:{status:'unavailable',reason:'missing_key'},bots:Array.from({length:18},(_,i)=>({id:'bot-'+i.toString(16).padStart(32,'0'),cls:'commander',region:'forge',display_name:'PRIVATE_PROFILE_CANARY',profile_name:'PRIVATE_PROFILE_CANARY',name:'PRIVATE_HERO_CANARY'})),tasks:[],sessions:[],events:[]});reset(0);for(const h of Object.values(S.heroes)){h.act=null;h.idle=1e6;goHome(h);}S.speed=1;S.play=true;for(let i=0;i<9000;i++){window.__clock+=1000/60;update(1/60);}S.play=false;const [x,y]=plazaOf('forge').center;Object.assign(cam,{x,tx:x,y:y-40,ty:y-40,zi:1});selectedScene=null;connectedStatus(D);hud(1);pollFailed({status:422});draw();hud(1);
            const over=Object.values(S.heroes).filter(overflowed).map(h=>h.bot);return {over,picksOverflow:inspect.picks.filter(p=>p.type==='hero'&&over.includes(p.id)).length,visible:Object.values(S.heroes).filter(h=>!overflowed(h)).length};});
          check('crowd has overflow heroes and none are sprite picks',crowd.over.length>=2&&crowd.picksOverflow===0,crowd);
          // Choose one overflow hero from the list (last row).
          await page.locator('#scene-overflow button:visible').first().click();
          const rows=page.locator('#quest .item-summary');const rowCount=await rows.count();
          check('overflow list still lists every character in the region',rowCount===18,rowCount);
          await rows.nth(17).locator('button').click();await page.evaluate(()=>draw());
          const pickedOverflow=await page.evaluate(()=>({id:selectedScene,overflow:overflowed(S.heroes[selectedScene]),label:$('#scene-selected')?.getAttribute('aria-label')}));
          check('overflow list selection marks that hero',pickedOverflow.overflow&&/^Selected Hero /.test(pickedOverflow.label),pickedOverflow);
          // Native tap on a different visible hero.
          await page.evaluate(()=>UI.close());
          const target=await page.evaluate(()=>{const h=Object.values(S.heroes).find(h=>!overflowed(h));Object.assign(cam,{x:h.x,tx:h.x,y:h.y-40,ty:h.y-40,zi:1});draw();const p=inspect.picks.find(p=>p.id===h.bot);return {id:h.bot,previous:selectedScene,point:{x:(p.body.left+p.body.right)/2,y:(p.body.top+p.body.bottom)/2}};});
          // A crowd can stack several picks at that point; resolve through the chooser when so.
          await page.mouse.click(target.point.x,target.point.y);
          let chooser=await page.evaluate(()=>!!inspect.choices);
          if(chooser){
            const choice=page.locator('#character-content button').first();await choice.click();
          }
          const synced=await page.evaluate(()=>{renderInspection();followCharacter(1);draw();const heading=$('#character-heading').textContent;
            return {selected:selectedScene,inspected:inspect.bot,card:!$('#character-card').hidden,heading,label:$('#scene-selected')?.getAttribute('aria-label')};});
          check('native hero tap'+(chooser?' via chooser':'')+' opens inspection',synced.card&&!!synced.inspected,synced);
          check('shared selected identity equals inspected hero (overflow -> native -> chooser)',synced.selected===synced.inspected&&synced.selected!==pickedOverflow.id,{synced,pickedOverflow});
          check('selected marker names the same character as the card',synced.label==='Selected '+synced.heading,synced);
          // Re-select through the chooser path explicitly when the tap resolved to a single hero.
          const viaChooser=await page.evaluate(()=>{const picks=inspect.picks.filter(p=>p.type==='hero').slice(0,2);if(picks.length<2)return null;chooseCharacters(picks);const buttons=[...document.querySelectorAll('#character-content button')];buttons[buttons.length-1].click();renderInspection();draw();return {selected:selectedScene,inspected:inspect.bot,label:$('#scene-selected')?.getAttribute('aria-label'),heading:$('#character-heading').textContent};});
          if(viaChooser)check('chooser selection synchronises shared identity and marker',viaChooser.selected===viaChooser.inspected&&viaChooser.label==='Selected '+viaChooser.heading,viaChooser);
          // Selection survives walking/overflow fallback with nothing leaking.
          const fallback=await page.evaluate(()=>{const id=inspect.bot;const h=S.heroes[id];for(let i=0;i<60;i++){window.__clock+=1000/60;S.play=true;update(1/60);}S.play=false;draw();return {selected:selectedScene,id,marker:!!$('#scene-selected')&&!$('#scene-selected').hidden};});
          check('selected identity retained across simulation steps',fallback.selected===fallback.id&&fallback.marker,fallback);

          // (c) occlusion in the combined state: inspection open + overflow + stale 422 + names hidden.
          const occl=await page.evaluate(()=>{
            const overflow=$('#scene-overflow'),card=$('#character-card'),bar=$('#focus-bar'),sel=$('#scene-selected');
            const topAt=el=>{const r=el.getBoundingClientRect();return document.elementFromPoint(r.left+Math.min(r.width/2,60),r.top+r.height/2);};
            const text=[...$('#character-content').children,$('#character-heading'),$('#character-close')].map(el=>{el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();
              const hit=document.elementFromPoint(r.left+Math.min(r.width/2,60),r.top+Math.min(r.height/2,10));
              return {text:el.textContent.slice(0,40),rect:r.toJSON(),ok:!!hit&&card.contains(hit)&&!overflow.contains(hit)&&!bar.contains(hit),hit:hit?.id||hit?.tagName};});
            const barText=[...bar.querySelectorAll('#live-note,#issues,#connection')].filter(el=>el.getClientRects().length).map(el=>{const hit=topAt(el);return {id:el.id,ok:!!hit&&(el.contains(hit)||hit.contains(el)||bar.contains(hit))};});
            const ov=[...overflow.children].filter(b=>b.getClientRects().length).map(b=>{const r=b.getBoundingClientRect();return {text:b.textContent,rect:r.toJSON(),w:r.width,h:r.height,hit:document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===b};});
            return {card:card.getBoundingClientRect().toJSON(),overflow:overflow.getBoundingClientRect().toJSON(),bar:bar.getBoundingClientRect().toJSON(),sel:sel?.getBoundingClientRect().toJSON(),text,barText,ov,
              warning:$('#live-note').textContent,hidden:overflow.hidden,reserved:UI.diagnostics().reserved,leak:/PRIVATE_(?:TASK|PROFILE|HERO)_CANARY|bot-[a-f\d]{32}|t_[a-f\d]{32}/.test(document.body.outerHTML)};});
          check('card text rows are not covered (elementFromPoint)',occl.text.every(t=>t.ok),occl.text.filter(t=>!t.ok));
          check('overflow control rectangle does not intersect the card',!occl.hidden&&!intersects(occl.overflow,occl.card),{card:occl.card,overflow:occl.overflow});
          check('overflow control rectangle does not intersect the stale-warning bar',!intersects(occl.overflow,occl.bar),{bar:occl.bar,overflow:occl.overflow});
          check('overflow keeps count and list access with 44px target and is reachable',occl.ov.length>=1&&occl.ov.every(o=>o.hit&&o.h>=44)&&occl.ov.some(o=>/\+\d+/.test(o.text)),occl.ov);
          check('stale 422 warning stays visible and uncovered',/server rejected/.test(occl.warning)&&occl.barText.every(t=>t.ok),{w:occl.warning,b:occl.barText});
          check('both widgets are inside reserved label bounds',[occl.card,occl.overflow].every(r=>occl.reserved.some(b=>b.left<=r.left&&b.right>=r.right&&b.top<=r.top&&b.bottom>=r.bottom)));
          check('no private identifier in DOM with names hidden',!occl.leak);
          const compact=await page.evaluate(()=>{const b=[...$('#scene-overflow').children].find(b=>b.getClientRects().length);b.click();const rows=[...document.querySelectorAll('#quest .item-summary')].length;const total=Object.values(S.heroes).filter(overflowed).length;UI.close();return {rows,total,text:b.textContent};});
          check('compact overflow control lists every overflow district entry',compact.rows>=compact.total&&compact.total>=2&&new RegExp('\\+'+compact.total).test(compact.text),compact);
          // Reopen overflow badges after closing inspection.
          await page.evaluate(()=>clearInspection(true));
          const restored=await page.evaluate(()=>{draw();const o=$('#scene-overflow');return {full:[...o.children].filter(b=>b.getClientRects().length).map(b=>b.textContent),left:o.getBoundingClientRect().left,bottom:innerHeight-o.getBoundingClientRect().bottom};});
          check('after closing inspection the per-region badge returns to bottom-left',restored.full.some(t=>/Forge/i.test(t)&&/\+\d+/.test(t))&&restored.left===8,restored);

          // (c2) landscape/side-column: wide attack pose + stale warning + overflow dock.
          const geometry=await page.evaluate(()=>{UI.close();clearInspection();loadReplay({meta:{from_:0,to:600,show_titles:false,show_profile_names:false},session_data:{status:'unavailable',reason:'missing_key'},bots:[{id:'chosen',cls:'commander',model:'Sol',region:'forge'},...Array.from({length:17},(_,i)=>({id:'x'+i,cls:'mage',region:'forge'}))],tasks:[],sessions:[],events:[]});reset(0);
            for(const h of Object.values(S.heroes)){h.act=null;h.idle=1e6;goHome(h);}S.speed=1;S.play=true;for(let i=0;i<9000;i++){window.__clock+=1000/60;update(1/60);}S.play=false;
            const h=S.heroes.chosen;Object.assign(h,{x:1000,y:700,path:[],atk:.2,sleep:false,down:0});Object.assign(cam,{x:1000,tx:1000,y:670,ty:670,zi:4});draw();showInspection('chosen');pollFailed({status:422});for(let i=0;i<10;i++){draw();renderInspection();followCharacter(1);}draw();
            const p=inspect.picks.find(p=>p.id==='chosen'),bar=$('#focus-bar'),card=$('#character-card'),o=$('#scene-overflow');
            return {body:p?.body,bar:bar.getBoundingClientRect().toJSON(),card:card.getBoundingClientRect().toJSON(),overflowHidden:o.hidden,overflow:o.getBoundingClientRect().toJSON(),side:bar.classList.contains('inspection-side'),selected:selectedScene,zoom:cam.zi,warning:$('#live-note').textContent};});
          check('followed attack body clear of warning, card and overflow',!!geometry.body&&!intersects(geometry.body,geometry.bar)&&!intersects(geometry.body,geometry.card)&&(geometry.overflowHidden||!intersects(geometry.body,geometry.overflow)),geometry);
          check('followed body stays within the viewport',geometry.body.left>=0&&geometry.body.right<=width&&geometry.body.top>=0&&geometry.body.bottom<=height,{body:geometry.body});
          check('overflow control does not overlap the card or the warning in landscape/side layouts',geometry.overflowHidden||(!intersects(geometry.overflow,geometry.card)&&!intersects(geometry.overflow,geometry.bar)),geometry);
          check('selected identity is the followed hero',geometry.selected==='chosen');
          check('no page/console errors',errors.length===0,errors);
          records.push(rec);
          if(out)await page.screenshot({path:path.join(out,engine+'-'+width+'x'+height+'-combined.png')});
          await page.close();
        }
      } finally {await browser.close();}
    }
    if(out)fs.writeFileSync(path.join(out,'scene-hero-interaction-report.json'),JSON.stringify({base:BASE_REF,records},null,2));
    console.log('PASS scene-hero native interaction: '+records.length+' engine/viewport cases, '+records.reduce((n,r)=>n+r.checks.length,0)+' assertions');
  } finally {
    await new Promise(r=>server.close(r));fs.rmSync(baseDir,{recursive:true,force:true});
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
