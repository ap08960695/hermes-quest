'use strict';
// Optional Playwright regression for the campaign/log inventory; synthetic data only.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium,firefox}=require('playwright');
const root=path.resolve(__dirname,'..'),out=process.argv[2];
const mime={'.js':'text/javascript','.json':'application/json','.png':'image/png','.otf':'font/otf','.html':'text/html; charset=utf-8'};
const server=http.createServer((req,res)=>{
  const name=new URL(req.url,'http://localhost').pathname;
  try {res.setHeader('Content-Type',mime[path.extname(name)]||mime['.html']);res.end(fs.readFileSync(path.join(root,name==='/'?'index.html':name)));}
  catch {res.writeHead(404).end();}
});
(async()=>{
  if(out)fs.mkdirSync(out,{recursive:true});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const records=[];
  try {
    for(const [engine,type] of Object.entries({chromium,firefox})) {
      const browser=await type.launch({headless:true});
      try {
        for(const [width,height] of [[375,667],[320,568],[667,375],[568,320]])for(const zoom of [1,3]) {
          const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:2}),errors=[];
          page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
          page.on('requestfailed',r=>errors.push(r.url()));page.on('response',r=>{if(r.status()>=400)errors.push(String(r.status()));});
          await page.addInitScript(()=>{
            window.shaped=[];const original=CanvasRenderingContext2D.prototype.fillText;
            CanvasRenderingContext2D.prototype.fillText=function(text,...args){shaped.push(text);return original.call(this,text,...args);};
          });
          await page.goto('http://127.0.0.1:'+server.address().port);
          await page.waitForFunction(()=>typeof loop.last==='number');
          await page.evaluate(z=>{S.play=false;cancelAnimationFrame(raf);cam.zi=z;draw();UIPanels.privacy();},zoom);
          const labels=await page.evaluate(async()=>{
            UIPanels.drawer('chron');
            // Exercise the real renderFeed boundary (which calls plain before feed).
            S.feed=[{t:D.meta.from_,html:'💥 💬 ✨ 🧭 👹 synthetic status'}];renderFeed();
            await new Promise(r=>setTimeout(r,200));
            const row=document.querySelector('#feed .bitmap-row');
            return {text:row.textContent,icons:row.querySelector('div').children.length,
              accessibleClipped:getComputedStyle(row.querySelector('.sr-only')).clipPath==='inset(50%)',
              emojiShaped:shaped.some(t=>/\p{Extended_Pictographic}/u.test(t))};
          });
          assert.equal(labels.icons,5);assert(labels.accessibleClipped);assert.equal(labels.emojiShaped,false);
          for(const meaning of ['กระแทก','ข้อความ','สภา','นำทาง','มอนสเตอร์'])assert(labels.text.includes(meaning));
          if(out&&zoom===1)await page.screenshot({path:path.join(out,engine+'-'+width+'x'+height+'-feed.png')});
          const counters=await page.evaluate(async()=>{
            UIPanels.drawer('camp');const results=[];
            for(const count of ['1/9 เควส','1234/9999 เควส · ⚔1','99999/999999 เควส ⚔12345']) {
              UIPanels.camps([{title:'synthetic',count,stages:[]}]);await new Promise(r=>setTimeout(r,100));
              const el=document.querySelector('.campaign-count'),c=el.querySelector('canvas'),r=c.getBoundingClientRect();
              const data=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
              results.push({count,label:el.getAttribute('aria-label'),width:r.width,height:r.height,
                ink:data.some((v,i)=>i%4===3&&v),alpha:[...new Set(Array.from(data).filter((v,i)=>i%4===3))]});
            }
            return results;
          });
          for(const c of counters){assert.equal(c.width,200);assert.equal(c.height,36);assert(c.ink);assert(c.label.includes(c.count.split(' ')[0]));assert.deepEqual(c.alpha.sort((a,b)=>a-b),[0,255]);}
          if(out&&zoom===1)await page.screenshot({path:path.join(out,engine+'-'+width+'x'+height+'-count.png')});
          const privacy=await page.evaluate(async()=>{
            UIPanels.drawer('chron');UIPanels.feed([{text:'💬 UI_INVENTORY_CANARY'}]);
            // Invalidate before the asynchronous bitmap resolves; no stale resurrection.
            UIPanels.privacy();await new Promise(r=>setTimeout(r,100));
            const pendingGone=!document.body.textContent.includes('UI_INVENTORY_CANARY')&&!document.querySelector('#feed canvas');
            UIPanels.feed([{text:'💬 UI_INVENTORY_CANARY_CACHED'}]);await new Promise(r=>setTimeout(r,100));
            UIPanels.privacy();const cachedGone=!document.body.textContent.includes('UI_INVENTORY_CANARY');
            document.querySelector('#help').click();await new Promise(r=>setTimeout(r,100));
            return {pendingGone,cachedGone,
              legend:document.querySelector('#quest').textContent,overflow:document.documentElement.scrollWidth>innerWidth+1};
          });
          assert(privacy.pendingGone&&privacy.cachedGone);assert(privacy.legend.includes('ย่อบริบท'));assert.equal(privacy.overflow,false);assert.deepEqual(errors,[]);
          records.push({engine,browser:browser.version(),width,height,dpr:2,zoom,labels,counters,privacy,errors});
          await page.close();
        }
      } finally {await browser.close();}
    }
    if(out)fs.writeFileSync(path.join(out,'inventory-report.json'),JSON.stringify({records},null,2));
    console.log('PASS inventory '+records.length+' engine/viewport/zoom cases');
  } finally {await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
