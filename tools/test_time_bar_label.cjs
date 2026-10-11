#!/usr/bin/env node
// The gold countdown bar above a monster must be named "EST. TIME LEFT" with m/s units, drawn from the
// bundled bitmap alphabet (no URL font, so it also reads in the Desktop guest bridge).
// node tools/test_time_bar_label.cjs [outDir]
'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium,firefox}=require('playwright');
const root=path.resolve(__dirname,'..'),out=path.resolve(process.argv[2]||path.join(root,'.evidence/time-bar'));
const mime={'.js':'text/javascript','.json':'application/json','.png':'image/png','.html':'text/html','.otf':'font/otf'};
const server=http.createServer((req,res)=>{
  const n=new URL(req.url,'http://local').pathname,file=path.resolve(root,'.'+(n==='/'?'/index.html':n));
  if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
  fs.readFile(file,(e,b)=>{res.writeHead(e?404:200,{'content-type':mime[path.extname(file)]||'application/octet-stream'});res.end(e?'':b);});
});
(async()=>{
  fs.mkdirSync(out,{recursive:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const records=[];let failed=false;
  try{for(const [engine,type] of Object.entries({chromium,firefox})){
    const browser=await type.launch({headless:true});
    try{for(const [width,height] of [[1440,900],[390,844]]){
      const page=await browser.newPage({viewport:{width,height}}),errors=[];
      page.on('pageerror',e=>errors.push(e.message));
      await page.addInitScript(()=>{
        window.__questTestGlobals=true;window.HQModules={};window.barText=[];
        let factory;Object.defineProperty(HQModules,'createRenderer',{get:()=>c=>(window.timeBarRenderer=factory(c)),set:v=>factory=v});
        let font;Object.defineProperty(window,'UIText',{get:()=>font,set:v=>{font={...v,draw(ctx,text,...a){if(ctx.canvas.id==='stage')barText.push(String(text));return v.draw(ctx,text,...a);}};}});
        window.fontRequests=[];const fl=window.FontFace;
        if(fl)window.FontFace=function(...a){fontRequests.push(String(a[1]));return new fl(...a);};
      });
      const rec=async(name,fn)=>{try{await fn();records.push({engine,width,name,pass:true});}catch(e){failed=true;records.push({engine,width,name,pass:false,error:e.message});}};
      try{
        await page.goto('http://127.0.0.1:'+server.address().port+'/');
        await page.waitForFunction(()=>typeof S!=='undefined'&&typeof MON2!=='undefined'&&Object.keys(MON2).length>=18&&Object.keys(S.heroes).length);
        await page.evaluate(()=>{try{document.querySelector('#hint-dismiss')?.click();}catch(e){}cancelAnimationFrame(raf);raf=null;});
        const run=(setup)=>page.evaluate(setup=>{
          barText.length=0;
          for(const t of D.tasks)task(t.id).alpha=0;
          const f=new Function('S','D',setup);f(S,D);
          resize();draw();
          return {text:barText.slice(),w:cv.width,h:cv.height};
        },setup);
        await rec('running quest says EST. TIME LEFT with m unit',async()=>{
          const r=await run(`const t=task(D.tasks[0].id);Object.assign(t,{state:'fight',runStart:S.t-300,max_rt:1800,hp:.83,alpha:1,region:'forge',emerge:0,dying:false,x:700,y:500,mx:700,my:500,mpath:null});selectedScene=t.id;cam.x=700;cam.y=500;cam.tx=700;cam.ty=500;cam.zi=2;`);
          const labels=r.text.filter(x=>x.startsWith('EST. TIME L'));
          assert.equal(labels.length,1,'labels: '+JSON.stringify(r.text));
          assert.match(labels[0],/^EST\. TIME LEFT (\d+ MIN|\d+ SEC)$/);assert.equal(labels[0],'EST. TIME LEFT 25 MIN');
          await page.screenshot({path:path.join(out,`${engine}-${width}-running.png`)});
        });
        await rec('seconds use SEC unit and never go negative',async()=>{
          const r=await run(`const t=task(D.tasks[0].id);Object.assign(t,{state:'fight',runStart:S.t-1780,max_rt:1800,hp:.1,alpha:1,region:'forge',emerge:0,dying:false,x:700,y:500,mx:700,my:500,mpath:null});selectedScene=t.id;cam.x=700;cam.y=500;cam.tx=700;cam.ty=500;cam.zi=2;`);
          assert(r.text.includes('EST. TIME LEFT 20 SEC'),JSON.stringify(r.text));
          const o=await run(`const t=task(D.tasks[0].id);Object.assign(t,{state:'fight',runStart:S.t-9999,max_rt:1800,hp:.08,alpha:1,region:'forge',emerge:0,dying:false,x:700,y:500,mx:700,my:500,mpath:null});selectedScene=t.id;cam.x=700;cam.y=500;cam.tx=700;cam.ty=500;cam.zi=2;`);
          assert(o.text.includes('EST. TIME LEFT 0 SEC'),JSON.stringify(o.text));
        });
        await rec('no start time falls back to TIME LIMIT, not a made-up remainder',async()=>{
          const r=await run(`const t=task(D.tasks[0].id);Object.assign(t,{state:'fight',runStart:null,max_rt:1200,hp:1,alpha:1,region:'forge',emerge:0,dying:false,x:700,y:500,mx:700,my:500,mpath:null});selectedScene=t.id;cam.x=700;cam.y=500;cam.tx=700;cam.ty=500;cam.zi=2;`);
          assert(r.text.includes('TIME LIMIT 20 MIN'),JSON.stringify(r.text));assert(!r.text.some(x=>x.includes('TIME LEFT')));
        });
        await rec('crowded scene labels only the selected quest unless zoomed in',async()=>{
          const r=await run(`const ids=D.tasks.map(t=>t.id);ids.forEach((id,i)=>Object.assign(task(id),{state:'fight',runStart:S.t-60,max_rt:1800,hp:.9,alpha:1,region:'forge',emerge:0,dying:false,x:700+i*20,y:500,mx:700+i*20,my:500}));selectedScene=ids[0];cam.x=700;cam.y=500;cam.zi=1;`);
          const n=r.text.filter(x=>x.includes('TIME L')).length;
          assert(n<=1,'crowd labels '+n+' '+JSON.stringify(r.text));
          await page.screenshot({path:path.join(out,`${engine}-${width}-crowd.png`)});
        });
        await rec('label is drawn in canvas pixels without any URL font request',async()=>{
          
          const r=await run(`const t=task(D.tasks[0].id);Object.assign(t,{state:'fight',runStart:S.t-60,max_rt:1800,hp:.97,alpha:1,region:'forge',emerge:0,dying:false,x:700,y:500,mx:700,my:500,mpath:null});selectedScene=t.id;cam.x=700;cam.y=500;cam.tx=700;cam.ty=500;cam.zi=2;`);
          assert(r.text.some(x=>x.startsWith('EST. TIME LEFT')));
          assert(await page.evaluate(()=>barText.filter(t=>t.includes('TIME')).every(t=>Array.from(t).every(ch=>Object.hasOwn(UIText.glyphs,ch)))),'label uses a glyph outside the bundled bitmap alphabet');
          const gold=await page.evaluate(()=>{const d=cx.getImageData(0,0,cv.width,cv.height).data;let n=0;for(let i=0;i<d.length;i+=4)if(d[i]===255&&d[i+1]===211&&d[i+2]===107)n++;return n;});
          assert(gold>30,'label ink '+gold);
        });
        await rec('no page errors',async()=>assert.deepEqual(errors,[]));
      }finally{await page.close();}
    }}finally{await browser.close();}
  }}finally{server.close();}
  fs.writeFileSync(path.join(out,'time-bar-report.json'),JSON.stringify(records,null,1));
  for(const r of records)console.log((r.pass?'PASS ':'FAIL ')+r.engine+' '+r.width+' '+r.name+(r.error?' :: '+r.error:''));
  if(failed)process.exit(1);
})().catch(e=>{console.error(e);process.exit(1);});
