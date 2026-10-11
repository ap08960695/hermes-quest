'use strict';
// Actual package markup/CSS: configuration guidance must remain readable on mobile.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const engine=process.argv[2]||'chromium';
const browserType=require('playwright')[engine];
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
const hint='Quest data is unavailable: set HERMES_QUEST_CONFIG with hermes_home (see README › Custom HERMES_HOME)';
(async()=>{
  const browser=await browserType.launch({headless:true});
  try {
    for(const width of [1440,390,320]) {
      const page=await browser.newPage({viewport:{width,height:900}});
      await page.setContent(html);
      const dimensions=await page.evaluate(text=>{
        const badge=document.querySelector('#issues');badge.hidden=false;badge.textContent=text;
        return {width:badge.clientWidth,scrollWidth:badge.scrollWidth,height:badge.clientHeight,scrollHeight:badge.scrollHeight,
          right:badge.getBoundingClientRect().right,viewport:innerWidth};
      },hint);
      assert(dimensions.scrollWidth<=dimensions.width+1,`hint wraps horizontally at ${width}px`);
      assert(dimensions.scrollHeight<=dimensions.height+1,`hint is not vertically clipped at ${width}px`);
      assert(dimensions.right<=dimensions.viewport,`hint stays in viewport at ${width}px`);
      await page.close();
    }
    console.log('PASS config hint layout: 1440, 390, 320 px');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
