'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),zlib=require('node:zlib'),crypto=require('node:crypto');
const T=require('../font.js'),I=require('../ui-glyphs.js'),G=require('./gen_ui_atlas.cjs');
const root=path.resolve(__dirname,'..');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function decode(b) {
  assert.equal(b.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  const width=b.readUInt32BE(16),height=b.readUInt32BE(20);assert.equal(b[24],8);assert.equal(b[25],6);
  let off=8,parts=[];
  while(off<b.length){const n=b.readUInt32BE(off),kind=b.toString('ascii',off+4,off+8);if(kind==='IDAT')parts.push(b.subarray(off+8,off+8+n));off+=n+12;}
  const data=zlib.inflateSync(Buffer.concat(parts));assert.equal(data.length,height*(1+width*4));
  const rows=[];for(let y=0;y<height;y++){assert.equal(data[y*(1+width*4)],0);rows.push(data.subarray(y*(1+width*4)+1,(y+1)*(1+width*4)));}
  return {width,height,rows};
}
function context(){return {calls:[],save(){},restore(){},fillRect(...v){this.calls.push([...v,this.fillStyle]);},fillText(){throw Error('Main text fallback forbidden');}};}

test('atlas regeneration is byte-identical, matches checked-in hashes and PNG geometry',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ui-atlas-'));
  try {
    const a=G.generate(path.join(dir,'a')),b=G.generate(path.join(dir,'b'));
    for(const name of Object.keys(a)){assert.deepEqual(a[name],b[name]);assert.deepEqual(a[name],fs.readFileSync(path.join(root,'assets/px/ui',name)));}
    const m=JSON.parse(a['atlas.json']);assert.equal(m.version,1);assert.equal(m.font.advance,6);assert.deepEqual(m.font.cell,{width:6,height:8});
    assert.equal(hash(a['font-5x7.png']),m.font.sha256);assert.equal(hash(a['icons-16.png']),m.icons.sha256);
    const f=decode(a['font-5x7.png']),i=decode(a['icons-16.png']);assert.deepEqual([f.width,f.height],[96,24]);assert.deepEqual([i.width,i.height],[128,96]);
    assert.equal(Object.keys(m.font.map).length,45);assert.equal(Object.keys(m.icons.map).length,46);
    // Font cell gutters stay transparent; independent PNG decoder checks native geometry.
    for(const p of Object.values(m.font.map)){for(let y=p.y;y<p.y+8;y++)assert.equal(f.rows[y][(p.x+5)*4+3],0);for(let x=p.x;x<p.x+6;x++)assert.equal(f.rows[p.y+7][x*4+3],0);}
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('measure uses full fixed advance including space/unknown Unicode graphemes',()=>{
  assert.equal(T.measure('23:18',2),60);assert.equal(T.measure('100%',2),48);assert.equal(T.measure('',3),0);assert.equal(T.measure('A A',1),18);
  assert.equal(T.measure('🙂',2),12);assert.equal(T.repertoire.length,45);assert.equal(new Set(T.repertoire).size,45);
  for(const rows of Object.values(T.glyphs)){assert.equal(rows.length,7);for(const row of rows)assert.match(row,/^[01]{5}$/);}
});
test('unknown becomes question mark; no fillText; overflow only whole cells; alignment',()=>{
  const a=context(),b=context();T.draw(a,'a🙂',0,0,{scale:2});T.draw(b,'??',0,0,{scale:2});assert.deepEqual(a.calls,b.calls);
  const c=context(),d=context();assert.equal(T.draw(c,'12',100,2,{scale:2,align:'right',maxWidth:13}),12);T.draw(d,'1',88,2,{scale:2});assert.deepEqual(c.calls,d.calls);
  const e=context();assert.equal(T.draw(e,'12',0,0,{scale:2,maxWidth:11}),0);assert.equal(e.calls.length,0);
  for(const s of [0,-1,1.5,NaN,Infinity]) {assert.throws(()=>T.measure('1',s),RangeError);assert.throws(()=>T.draw(context(),'1',0,0,{scale:s}),RangeError);assert.throws(()=>I.draw(context(),'play',0,0,s),RangeError);}
});
test('all 46 agreed icons are 16x16, distinct nonempty silhouettes, palette-only, all states draw',()=>{
  const expected=('play pause live-follow speed clock scrub-start scrub-end world calm quests log close info demo connected offline snapshot loading mana-claude mana-codex mana-gemini heart mana level coin plan build test review deploy verify sword chain read search vision write memory message delegate compress commit push merge sleep crit').split(' ');
  assert.deepEqual(I.ids,expected);assert.equal(new Set(Object.values(I.pixels).map(JSON.stringify)).size,46);
  for(const id of expected){const rows=I.pixels[id];assert.equal(rows.length,16);assert(rows.flat().some(c=>c>0));for(const row of rows){assert.equal(row.length,16);for(const c of row)assert(c>=-1&&c<I.palette.length);}
    for(const state of ['normal','disabled','selected','alert']){const c=context();assert.deepEqual(I.draw(c,id,0,0,2,state),{width:32,height:32});assert(c.calls.length>0);for(const [x,y,w,h] of c.calls){assert(Number.isInteger(x)&&Number.isInteger(y));assert(w>=2&&h>=2);}}
  }
  assert.throws(()=>I.draw(context(),'missing',0,0),RangeError);assert.throws(()=>I.draw(context(),'__proto__',0,0),RangeError);assert.throws(()=>I.draw(context(),'play',0,0,1,'invalid'),RangeError);
});
test('Thai and long token wrapping preserves grapheme clusters and original content',()=>{
  const text='กี่น้ำ ทดสอบ '+'A'.repeat(1024),lines=T.wrap(text,8,s=>T.graphemes(s).length);
  assert.equal(lines.join(''),text);assert(lines.every(s=>T.graphemes(s).length<=8));assert(!lines.some(s=>/^[\u0e31\u0e34-\u0e3a\u0e47-\u0e4e]/u.test(s)));
  assert.deepEqual(T.wrap('AA BB CC',5,s=>s.length),['AA ','BB CC']);assert.deepEqual(T.wrap('A\n\nB',5,s=>s.length),['A','','B']);
  assert.throws(()=>T.wrap('กี่',1,()=>2),RangeError);
});
function fontTables(b){const tables={};for(let i=0;i<b.readUInt16BE(4);i++){const o=12+i*16;tables[b.toString('ascii',o,o+4)]=b.subarray(b.readUInt32BE(o+8),b.readUInt32BE(o+8)+b.readUInt32BE(o+12));}return tables;}
test('unmodified static upstream font pin, OFL terms and exact declared glyph coverage',()=>{
  const b=fs.readFileSync(path.join(root,'assets/fonts/NotoSansThai-Regular.otf'));
  assert.equal(hash(b),'b96ed42039921333c7ae12676bead8118ac5204f837d0cabd1215fd493b2da84');
  const tables=fontTables(b);assert.equal(tables.fvar,undefined);assert(tables.GSUB&&tables.GPOS);
  const cm=tables.cmap;let sub;
  for(let i=0;i<cm.readUInt16BE(2);i++){const o=4+i*8,p=cm.readUInt16BE(o),e=cm.readUInt16BE(o+2),offset=cm.readUInt32BE(o+4);if(p===3&&e===1)sub=cm.subarray(offset);}
  assert.equal(sub.readUInt16BE(0),4);const count=sub.readUInt16BE(6)/2,end=14,start=end+count*2+2,delta=start+count*2,ranges=delta+count*2;
  const supported=new Set();
  for(let i=0;i<count;i++)for(let c=sub.readUInt16BE(start+i*2);c<=sub.readUInt16BE(end+i*2)&&c<65535;c++){
    const r=sub.readUInt16BE(ranges+i*2),d=sub.readInt16BE(delta+i*2);let glyph=r?sub.readUInt16BE(ranges+i*2+r+2*(c-sub.readUInt16BE(start+i*2))):c;
    if(!r||glyph)glyph=(glyph+d)&65535;if(glyph)supported.add(c);
  }
  // Cmap also has nonprinting NUL/CR. The helper rejects NUL and consumes CR as a line break.
  supported.delete(0);supported.delete(13);
  const declared=new Set();for(const [a,z]of T.coverage)for(let c=a;c<=z;c++)declared.add(c);
  assert.deepEqual([...declared].sort((a,b)=>a-b),[...supported].sort((a,b)=>a-b));
  const ofl=fs.readFileSync(path.join(root,'assets/fonts/OFL.txt'),'utf8');assert.match(ofl,/Copyright 2022 The Noto Project Authors/);assert.match(ofl,/SIL OPEN FONT LICENSE Version 1\.1/);assert.match(ofl,/5\) The Font Software/);
});
