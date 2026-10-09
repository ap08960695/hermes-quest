#!/usr/bin/env node
'use strict';
// Dependency-free deterministic RGBA PNGs from original pixel arrays (MIT).
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const Text=require('../font.js');
const Icons=require('../ui-glyphs.js');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function crc(b) {let c=0xffffffff;for(const byte of b){c^=byte;for(let i=0;i<8;i++) c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
function chunk(kind,data) {const k=Buffer.from(kind),size=Buffer.alloc(4),sum=Buffer.alloc(4);size.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([k,data])));return Buffer.concat([size,k,data,sum]);}
function png(width,height,pixels) {
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=6;
  const raw=Buffer.alloc(height*(1+width*4));for(let y=0;y<height;y++) pixels.copy(raw,y*(1+width*4)+1,y*width*4,(y+1)*width*4);
  // Stored DEFLATE blocks: identical across runtimes/zlib versions, no timestamps.
  const blocks=[Buffer.from([0x78,0x01])];let a=1,b=0;
  for(const n of raw){a=(a+n)%65521;b=(b+a)%65521;}
  for(let i=0;i<raw.length;i+=65535){const data=raw.subarray(i,i+65535),h=Buffer.alloc(5);h[0]=i+data.length===raw.length?1:0;h.writeUInt16LE(data.length,1);h.writeUInt16LE(65535-data.length,3);blocks.push(h,data);}
  const adler=Buffer.alloc(4);adler.writeUInt32BE((b*65536+a)>>>0);blocks.push(adler);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('IDAT',Buffer.concat(blocks)),chunk('IEND',Buffer.alloc(0))]);
}
function surface(w,h,bg=null) {
  const data=Buffer.alloc(w*h*4);
  const put=(x,y,c)=>{if(x>=0&&y>=0&&x<w&&y<h) data.set(c,(y*w+x)*4);};
  if(bg) for(let y=0;y<h;y++) for(let x=0;x<w;x++) put(x,y,bg);
  const rect=(x,y,rw,rh,c)=>{for(let j=y;j<y+rh;j++)for(let i=x;i<x+rw;i++)put(i,j,c);};
  return {data,w,h,put,rect,encode:()=>png(w,h,data)};
}
const rgba=s=>[...s.slice(1).match(/../g).map(v=>parseInt(v,16)),255];
function text(s,value,x,y,scale=1,color=[232,223,198,255]) {
  Array.from(value).forEach((ch,n)=>(Text.glyphs[ch]||Text.glyphs['?']).forEach((row,j)=>Array.from(row).forEach((p,i)=>{if(p==='1')s.rect(x+(n*6+i)*scale,y+j*scale,scale,scale,color);})));
}
function icon(s,id,x,y,scale=1) {Icons.pixels[id].forEach((row,j)=>row.forEach((c,i)=>{if(c>=0)s.rect(x+i*scale,y+j*scale,scale,scale,rgba(Icons.palette[c]));}));}
function generate(out=path.resolve(__dirname,'../assets/px/ui')) {
  fs.mkdirSync(out,{recursive:true});
  const f=surface(96,24),g=surface(128,96),map={},icons={};
  Text.repertoire.forEach((ch,n)=>{const x=n%16*6,y=Math.floor(n/16)*8;text(f,ch,x,y);map[ch]={x,y,width:5,height:7,advance:6};});
  Icons.ids.forEach((id,n)=>{const x=n%8*16,y=Math.floor(n/8)*16;icon(g,id,x,y);icons[id]={x,y,width:16,height:16};});
  const font=f.encode(),glyph=g.encode();
  const meta={version:1,license:'MIT',font:{file:'font-5x7.png',width:96,height:24,cell:Text.cell,advance:6,map,sha256:sha(font)},icons:{file:'icons-16.png',width:128,height:96,cell:{width:16,height:16},palette:Icons.palette,map:icons,sha256:sha(glyph)}};
  const outputs={'font-5x7.png':font,'icons-16.png':glyph,'atlas.json':Buffer.from(JSON.stringify(meta,null,2)+'\n')};
  for(const [name,b] of Object.entries(outputs)) fs.writeFileSync(path.join(out,name),b);
  return outputs;
}
function contacts(out) {
  fs.mkdirSync(out,{recursive:true});
  const f=surface(16*36,3*52,rgba('#111b30')),g=surface(8*104,6*104,rgba('#111b30'));
  Text.repertoire.forEach((ch,n)=>{const x=n%16*36,y=Math.floor(n/16)*52;text(f,ch,x+6,y+5,4);text(f,ch===' '?'SP':ch,x+7,y+39,1,rgba('#d9b25c'));});
  Icons.ids.forEach((id,n)=>{const x=n%8*104,y=Math.floor(n/8)*104;icon(g,id,x+20,y+6,4);id.toUpperCase().split('-').forEach((v,i)=>text(g,v,x+Math.floor((104-v.length*6)/2),y+78+i*10,1));});
  fs.writeFileSync(path.join(out,'glyphs-4x.png'),f.encode());fs.writeFileSync(path.join(out,'icons-4x.png'),g.encode());
}
if(require.main===module) {
  const args=process.argv.slice(2);
  if(args.length && !(args.length===2 && ['--out','--contact-dir'].includes(args[0]))) throw new Error('Usage: node tools/gen_ui_atlas.cjs [--out DIR | --contact-dir DIR]');
  if(args[0]==='--contact-dir') contacts(path.resolve(args[1]));else generate(args[0]==='--out'?path.resolve(args[1]):undefined);
}
module.exports={generate,contacts,png};
