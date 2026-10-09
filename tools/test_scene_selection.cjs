'use strict';
// Synthetic selected-rendering/privacy regression; real DOM, bitmap and canvas.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium,firefox}=require('playwright');
const root=path.resolve(process.env.SCENE_ROOT||path.join(__dirname,'..')),out=process.argv[2];
const mime={'.html':'text/html','.js':'text/javascript','.json':'application/json','.png':'image/png','.otf':'font/otf'};
const server=http.createServer((req,res)=>{
  const name=new URL(req.url,'http://localhost').pathname,file=path.resolve(root,'.'+(name==='/'?'/index.html':name));
  if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
  fs.readFile(file,(error,data)=>{res.writeHead(error?404:200,{'content-type':mime[path.extname(file)]||'application/octet-stream'});res.end(error?'not found':data);});
});
(async()=>{
  if(out)fs.mkdirSync(out,{recursive:true});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const records=[];
  try {
    for(const [engine,type] of Object.entries({chromium,firefox})){
      const browser=require('./parity/browser_loader.cjs').enable(await type.launch({headless:true}));
      try {
        for(const [width,height] of [[1280,800],[375,667],[320,568]]){
          const page=await browser.newPage({viewport:{width,height}}),errors=[];
          page.on('pageerror',error=>errors.push(error.message));
          page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
          await page.addInitScript(()=>{
            window.__nativeRaf=requestAnimationFrame.bind(window);window.requestAnimationFrame=()=>0;
            window.__clock=0;Object.defineProperty(performance,'now',{value:()=>window.__clock});
            window.__raster=[];const fill=CanvasRenderingContext2D.prototype.fillText;
            CanvasRenderingContext2D.prototype.fillText=function(text,...args){window.__raster.push(String(text));return fill.call(this,text,...args);};
          });
          await page.route('**/data/demo.json',route=>route.fulfill({json:{meta:{from_:0,to:600,show_titles:false},bots:[],tasks:[],events:[]}}));
          await page.goto('http://127.0.0.1:'+server.address().port+'/',{waitUntil:'load'});
          await page.waitForFunction(()=>document.querySelector('#connection')?.getAttribute('aria-label')==='Replay file normal',null,{polling:50});
          await page.evaluate(()=>{
            window.__drawnText=[];for(const method of ['bitmap','draw']){const original=UIText[method];UIText[method]=function(...args){window.__drawnText.push(String(args[method==='draw'?1:0]));return original.apply(this,args);};}
            window.__labels=[];const label=UI.screenLabel;UI.screenLabel=(...args)=>{const n=UI.diagnostics().drawn.length;label(...args);window.__labels.push({text:args[0],drawn:UI.diagnostics().drawn.length>n});};
            loadReplay({meta:{from_:0,to:600,show_titles:false},bots:[],events:[],tasks:Array.from({length:18},(_,i)=>({id:'t_'+i.toString(16).padStart(32,'0'),title:'PRIVATE_JOB_CANARY',stage:'BUILD',campaign:'Synthetic'}))});reset(0);
            for(const row of D.tasks)spawnMonster(task(row.id),'forge');S.play=true;S.speed=1;
            for(let i=0;i<9000;i++){window.__clock+=1000/60;update(1/60);}S.play=false;
            const [x,y]=plazaOf('forge').center;Object.assign(cam,{x,tx:x,y:y-40,ty:y-40,zi:1});selectedScene=null;resize();draw();hud(1);
          });
          assert.match(await page.locator('#scene-overflow').textContent(),/\+6/);
          const scan=()=>page.evaluate(()=>({html:document.body.outerHTML,raster:[...window.__raster,...window.__drawnText]}));
          const privateSafe=async()=>{const value=await scan();for(const text of [value.html,...value.raster])assert(!/t_[a-f\d]{32}|bot-[a-f\d]{32}|PRIVATE_(?:JOB|HERO)_CANARY/.test(text),'private identity/prose reached DOM or raster');};
          const representative=async(label)=>{
            await page.evaluate(()=>draw());
            const value=await page.locator('#scene-selected').evaluate(el=>{
              const r=el.getBoundingClientRect(),canvas=el.querySelector('span canvas'),pixels=canvas&&canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
              return {label:el.getAttribute('aria-label'),visible:!el.hidden&&r.width>0&&r.height>0,left:r.left,right:r.right,top:r.top,bottom:r.bottom,
                width:innerWidth,height:innerHeight,ink:pixels?Array.from(pixels).filter((_,i)=>i%4===3&&pixels[i]>0).length:0};
            });
            assert.equal(value.label,'Selected '+label);assert(value.visible&&value.ink>0,'selected representative is blank/hidden');
            assert(value.left>=0&&value.right<=value.width&&value.top>=0&&value.bottom<=value.height,'selected representative clipped');
            return value;
          };
          const selections=[];
          for(let i=0;i<18;i++){
            await page.locator('#scene-overflow button').click();assert.equal(await page.locator('#quest .item-summary').count(),18);await privateSafe();
            const key=await page.locator('#quest .item-summary').nth(i).getAttribute('data-key');assert.match(key,/^item-\d+$/);
            await page.locator('#quest .item-summary').nth(i).locator('button').click();
            const state=await page.evaluate(()=>({selected:selectedScene,slot:S.tasks[selectedScene].placement.k,world:JSON.stringify(S.tasks)}));
            assert.equal(state.selected,'t_'+i.toString(16).padStart(32,'0'));
            selections.push(await representative('Task '+(i+1)));
            assert.equal(await page.evaluate(()=>JSON.stringify(S.tasks)),state.world,'render changed simulation state');
            assert.match(await page.locator('#scene-overflow').textContent(),state.slot>=12?/\+5/:/\+6/);
            await page.waitForFunction(()=>Array.from(document.querySelectorAll('#quest .bitmap-row')).every(row=>row.querySelector('canvas')),null,{polling:50});await privateSafe();
            if(out&&i===17)await page.screenshot({path:path.join(out,`${engine}-${width}-selected-overflow.png`)});
            await page.locator('#quest .close').click();
          }
          // Walking, Details occlusion, offscreen and both hero overflow cases.
          for(const heroes of [1,18]){
            await page.evaluate(n=>{
              UI.close();loadReplay({meta:{from_:0,to:600,show_titles:false},tasks:[],events:[],bots:Array.from({length:n},(_,i)=>({id:'bot-'+i.toString(16).padStart(32,'0'),name:'PRIVATE_HERO_CANARY',region:'forge',cls:'warrior'}))});reset(0);
              for(const h of Object.values(S.heroes)){h.path=[];h.act=null;h.idle=1e6;}const h=Object.values(S.heroes).at(-1);
              Object.assign(cam,{x:h.x,tx:h.x,y:h.y-80,ty:h.y-80,zi:1});heroDialog(h);UI.close();goHome(h);window.__labels=[];draw();hud(1);
            },heroes);
            assert((await page.evaluate(()=>S.heroes[selectedScene].path.length))>1);
            await representative('Hero '+heroes);
            if(heroes===1){const labels=await page.evaluate(()=>window.__labels);assert.equal(labels[0].text,'Hero 1','region allocated before selected label');}
            await page.evaluate(()=>{const h=S.heroes[selectedScene];h.path=[];heroDialog(h);window.__labels=[];draw();});
            await page.waitForFunction(()=>Array.from(document.querySelectorAll('#quest .bitmap-row')).every(row=>row.querySelector('canvas')),null,{polling:50});
            await representative('Hero '+heroes);await privateSafe();
            if(out&&heroes===1)await page.screenshot({path:path.join(out,`${engine}-${width}-selected-details.png`)});
            await page.evaluate(()=>{UI.close();cam.x=cam.tx=0;cam.y=cam.ty=0;draw();});await representative('Hero '+heroes);
          }
          await page.evaluate(()=>{
            UI.close();D.session_data={status:'unavailable',reason:'/synthetic/private/key-file'};connectedStatus(D);hud(1);draw();
          });
          assert.match(await page.locator('#issues').textContent(),/Session activity unavailable/);
          assert(await page.locator('#issues').isVisible());assert(!(await page.locator('body').evaluate(el=>el.outerHTML)).includes('/synthetic/private/key-file'));
          if(out)await page.screenshot({path:path.join(out,`${engine}-${width}-session-warning.png`)});
          await page.evaluate(()=>{connection('Live paused · not updating','stale',{reason:'server unavailable',updated:null});hud(1);});
          assert.match(await page.locator('#issues').textContent(),/Live paused/);
          await page.evaluate(()=>{connectedStatus(D);hud(1);});assert.match(await page.locator('#issues').textContent(),/Session activity unavailable/);
          await page.evaluate(()=>{D.session_data={status:'available'};connectedStatus(D);hud(1);});assert(!(await page.locator('#issues').textContent()).includes('Session activity unavailable'));
          await page.evaluate(()=>{UI.privacy();});assert(await page.locator('#scene-selected').isHidden());assert.equal(await page.locator('#scene-selected').getAttribute('aria-label'),null);
          assert.deepEqual(errors,[]);records.push({engine,browser:browser.version(),width,height,selections:selections.length,selectedOverflow:true,walking:true,detailsFallback:true,offscreenFallback:true,domRasterPrivacy:true,warningRecovery:true});
          await page.close();
        }
      } finally {await browser.close();}
    }
    if(out)fs.writeFileSync(path.join(out,'selection-report.json'),JSON.stringify({records},null,2));
    console.log('PASS selected representative, exact hidden badge, walking/Details/offscreen fallback, DOM/accessibility/raster privacy, unavailable/stale/recovery: '+records.length+' browser/viewports');
  } finally {await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
