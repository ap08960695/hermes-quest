'use strict';
// Optional real-browser proof. Install Playwright outside the repo and expose it via NODE_PATH.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
const out=process.argv[2];
const allow=new Map([['/font.js','font.js'],['/ui-glyphs.js','ui-glyphs.js'],['/assets/fonts/NotoSansThai-Regular.otf','assets/fonts/NotoSansThai-Regular.otf']]);
const html='<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,">'+
  '<style>body{margin:0;background:#111b30}canvas{display:block;image-rendering:pixelated}</style>'+
  '<canvas id="proof" width="1280" height="800"></canvas><script src="/ui-glyphs.js"></script><script src="/font.js"></script>';
(async()=>{
  const server=http.createServer((req,res)=>{
    if(req.url==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);return;}
    const p=allow.get(req.url);if(!p){res.writeHead(404);res.end();return;}
    res.setHeader('Content-Type',p.endsWith('.otf')?'font/otf':'application/javascript');res.end(fs.readFileSync(path.join(root,p)));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const url=`http://127.0.0.1:${server.address().port}/`;
  let browser;
  try {
    browser=await chromium.launch({headless:true});
    const records=[];
    for(const dpr of [1,3]) {
      const page=await browser.newPage({viewport:{width:1280,height:800},deviceScaleFactor:dpr});
      const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});page.on('requestfailed',r=>errors.push(r.url()));page.on('response',r=>{if(r.status()>=400)errors.push(String(r.status()));});
      await page.goto(url);await page.waitForFunction(()=>window.UIText&&window.UIGlyphs);
      const result=await page.evaluate(async()=>{
        const T=window.UIText,I=window.UIGlyphs,c=document.getElementById('proof'),ctx=c.getContext('2d');
        function ok(v,msg){if(!v)throw Error(msg);}
        await T.ready();ok(document.fonts.check('18px HermesQuestNotoThai'),'bundled font loaded');
        ctx.imageSmoothingEnabled=true;const original=ctx.fillStyle;
        T.draw(ctx,'23:18 100% +16 -19',24,20,{scale:4});ok(ctx.imageSmoothingEnabled&&ctx.fillStyle===original,'restore main context');
        for(let n=0;n<I.ids.length;n++)I.draw(ctx,I.ids[n],24+n%16*74,80+Math.floor(n/16)*74,4);
        const sample='ผู้สร้างกำลังทดสอบ กี่ กุ้ง น้ำ ฤทธิ์ ปี่\nLatin 0123 https://example.test/AAAA';
        const b=await T.bitmap(sample,{maxWidth:260});
        ok(b===await T.bitmap(sample,{maxWidth:260}),'memory cache hit');
        let visible=0;
        for(const line of b.lines){const p=line.canvas.getContext('2d').getImageData(0,0,line.width,line.height).data;
          for(let y=0;y<line.height;y++)for(let x=0;x<line.width;x++){const a=p[(y*line.width+x)*4+3];if(a){visible++;ok(y>=4&&y<line.height-4,'Thai diacritics retain four-pixel vertical pad');}}
          ok(line.width<=280,'detail width envelope');
        }
        ok(visible>300,'Thai ink present');T.drawBitmap(ctx,b,24,330,2);ok(ctx.imageSmoothingEnabled,'restore bitmap context');
        const token=await T.bitmap('https://example.test/'+ 'A'.repeat(1024),{maxWidth:120});ok(token.lines.length>50&&token.lines.every(l=>l.width<=128),'long token wraps');
        const pending=T.bitmap('กี่',{maxWidth:140});T.clearCache();let rejected=false;try{await pending;}catch(e){rejected=true;}ok(rejected,'pending privacy generation rejected');
        let stale=false;try{T.drawBitmap(ctx,b,0,0);}catch(e){stale=true;}ok(stale,'retained pre-migration bitmap rejected');
        const fresh=await T.bitmap(sample,{maxWidth:260});ok(fresh!==b,'cache cleared');
        let coverage=false;try{await T.bitmap('漢🙂');}catch(e){coverage=true;}ok(coverage,'unsupported glyph never system fallback');
        let fraction=false;try{T.drawBitmap(ctx,fresh,0,0,1.5);}catch(e){fraction=true;}ok(fraction,'fractional detail scale rejected');
        let status='';const fail=await T.detail(ctx,'漢',1100,350,{onError:s=>status=s});ok(fail.error&&status==='Detail font unavailable','visible error + accessible callback');
        return {advance:T.measure('23:18',2),thaiLines:b.lines.length,longTokenLines:token.lines.length,visibleInk:visible,fontLoaded:true,padding:true,privacyInvalidation:true,noFallback:true};
      });
      assert.deepEqual(errors,[]);assert.equal(result.advance,60);
      if(out){fs.mkdirSync(out,{recursive:true});await page.screenshot({path:path.join(out,`browser-dpr${dpr}.png`)});}
      records.push({dpr,...result,errors});await page.close();
    }
    // A fresh document proves an actual failed font request does not create invisible details.
    const page=await browser.newPage();await page.route('**/*.otf',r=>r.abort());await page.goto(url);
    const failure=await page.evaluate(async()=>{const ctx=document.getElementById('proof').getContext('2d');let status='';const result=await UIText.detail(ctx,'กี่',0,0,{onError:s=>status=s});const ink=Array.from(ctx.getImageData(0,0,16,16).data).some((v,i)=>i%4===3&&v>0);return {error:result.error,status,ink};});
    assert.deepEqual(failure,{error:true,status:'Detail font unavailable',ink:true});await page.close();
    const report={browser:await browser.version(),records,fontFailure:failure};
    if(out)fs.writeFileSync(path.join(out,'browser-report.json'),JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify(report,null,2));console.log('PASS browser font proof');
  } finally {if(browser)await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
