#!/usr/bin/env node
// Actual Canvas pixels: stationary grounded feet survive idle, turns and hits.
'use strict';
const fs=require('fs'),path=require('path'),http=require('http'),assert=require('assert');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
(async()=>{
  const server=http.createServer((req,res)=>{
    const file=path.resolve(root,'.'+new URL(req.url,'http://local').pathname.replace(/\/$/,'/index.html'));
    if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
    fs.readFile(file,(err,data)=>{res.writeHead(err?404:200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.html')?'text/html':file.endsWith('.png')?'image/png':'application/json'});res.end(err?'':data);});
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  let browser;
  try{
    browser=await chromium.launch();const page=await browser.newPage({viewport:{width:800,height:600}});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(()=>typeof S!=='undefined'&&Object.keys(MON2).length>=18&&Object.keys(S.heroes).length);
    const result=await page.evaluate(()=>{
      cancelAnimationFrame(raf);raf=null;
      let clock=0;Object.defineProperty(performance,'now',{value:()=>clock});
      const originalRandom=Math.random;Math.random=()=>{throw Error('render called RNG');};
      const stage={golem:'BUILD',goblin:'VERIFY',slime:'TEST',skeleton:'DEPLOY',ghost:'PLAN',bat:'REVIEW'};
      const reports=[];
      try{
        for(const [key,M] of Object.entries(MMETA2)){
          const kind=key.split('-')[0],tier=key.split('-')[1],im=MON2[key];
          const t={id:'synthetic-'+key,stage:stage[kind],max_rt:{s:1000,m:1800,l:3000}[tier],x:400,y:300,alpha:1,slot:0,region:'forge',state:'quest',hp:1,emerge:0,atk:-1,flash:0,kick:0};
          const raw=document.createElement('canvas');raw.width=M.fw;raw.height=M.fh;
          const g=raw.getContext('2d');g.drawImage(im,0,0,M.fw,M.fh,0,0,M.fw,M.fh);
          const pixels=g.getImageData(0,0,M.fw,M.fh).data;
          let bottom=0;for(let y=0;y<M.fh;y++)for(let x=0;x<M.fw;x++)if(pixels[(y*M.fw+x)*4+3])bottom=Math.max(bottom,y+1);
          const mask=[];for(let y=bottom-8;y<bottom;y++)for(let x=0;x<M.fw;x++)if(pixels[(y*M.fw+x)*4+3]===255)mask.push([400-M.ax+x,300-M.base+y]);
          const drawAt=(time,hit,face,attack=-1)=>{
            clock=time;S.heroes={};if(face)S.heroes.owner={x:400+face*100};t.bot=face?'owner':null;t.flash=hit?.1:0;t.kick=hit?.8:0;t.atk=attack;
            cx.clearRect(0,0,cv.width,cv.height);inspect.picks=[];monster({ox:0,oy:0,Z:1,z:1},t);
            return cx.getImageData(0,0,cv.width,cv.height).data;
          };
          const first=drawAt(0,false,-1),foot=mask.map(([x,y])=>Array.from(first.slice((y*cv.width+x)*4,(y*cv.width+x)*4+4)).join(','));
          let checked=0,changed=false;
          for(const time of [0,700,1400,2100,2800,4900,5600])for(const face of [-1,1])for(const hit of [false,true]){
            const frame=drawAt(time,hit,face,hit?.2:-1);checked++;
            if(!['bat','ghost'].includes(kind))mask.forEach(([x,y],i)=>{const actual=Array.from(frame.slice((y*cv.width+x)*4,(y*cv.width+x)*4+4)).join(',');if(actual!==foot[i])throw Error(key+' moved contact pixel at '+[x,y]);});
            if(frame.some((v,i)=>v!==first[i]))changed=true;
            const repeat=drawAt(time,hit,face,hit?.2:-1);if(frame.some((v,i)=>v!==repeat[i]))throw Error(key+' nondeterministic draw');
          }
          if(!changed)throw Error(key+' has no visible motion');
          reports.push({key,samples:checked,contactPixels:mask.length,grounded:!['bat','ghost'].includes(kind),displacement:!['bat','ghost'].includes(kind)?0:null});
        }
        // Rendering with all assets loaded must not mutate the replay or ledger.
        S.heroes={};const before=JSON.stringify(S);clock=700;inspect.picks=[];draw();if(JSON.stringify(S)!==before)throw Error('draw mutated simulation');
        calm=true;const t={id:'calm',x:0,kick:1};clock=0;const a=monsterPose(t,'golem',false);clock=12000;const b=monsterPose(t,'golem',false);if(JSON.stringify(a)!==JSON.stringify(b)||a.bob||a.recoil)throw Error('calm ambient motion');
      }finally{Math.random=originalRandom;}
      return reports;
    });
    assert.deepStrictEqual(errors,[]);console.log(JSON.stringify({synthetic:true,reports:result,errors},null,2));
    console.log('PASS monster idle: real pixels, stable grounded contact, deterministic motion, render-only and reduced effects');
  }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
