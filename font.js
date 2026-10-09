/* Original 5x7 pixel alphabet: MIT. Thai shaping uses the separately licensed bundled font. */
(function(root) {
  'use strict';
  const glyphs=Object.freeze(Object.fromEntries(Object.entries({
    '0':'01110/11001/10101/10101/10011/10001/01110',
    '1':'00100/01100/00100/00100/00100/00100/01110',
    '2':'11110/00001/00001/01110/10000/10000/11111',
    '3':'11110/00001/00001/01110/00001/00001/11110',
    '4':'10010/10010/10010/11111/00010/00010/00010',
    '5':'11111/10000/10000/11110/00001/00001/11110',
    '6':'01110/10000/10000/11110/10001/10001/01110',
    '7':'11111/00001/00010/00100/00100/01000/01000',
    '8':'01110/10001/10001/01110/10001/10001/01110',
    '9':'01110/10001/10001/01111/00001/00001/01110',
    'A':'00100/01010/10001/10001/11111/10001/10001',
    'B':'11110/10001/10001/11110/10001/10001/11110',
    'C':'01111/10000/10000/10000/10000/10000/01111',
    'D':'11100/10010/10001/10001/10001/10010/11100',
    'E':'11111/10000/10000/11110/10000/10000/11111',
    'F':'11111/10000/10000/11110/10000/10000/10000',
    'G':'01110/10001/10000/10111/10001/10001/01110',
    'H':'10001/10001/10001/11111/10001/10001/10001',
    'I':'01110/00100/00100/00100/00100/00100/01110',
    'J':'00111/00010/00010/00010/00010/10010/01100',
    'K':'10001/10010/10100/11000/10100/10010/10001',
    'L':'10000/10000/10000/10000/10000/10000/11111',
    'M':'10001/11011/10101/10101/10001/10001/10001',
    'N':'10001/11001/11001/10101/10011/10011/10001',
    'O':'01110/10001/10001/10001/10001/10001/01110',
    'P':'11110/10001/10001/11110/10000/10000/10000',
    'Q':'01110/10001/10001/10001/10101/10010/01101',
    'R':'11110/10001/10001/11110/10100/10010/10001',
    'S':'01111/10000/10000/01110/00001/00001/11110',
    'T':'11111/00100/00100/00100/00100/00100/00100',
    'U':'10001/10001/10001/10001/10001/10001/01110',
    'V':'10001/10001/10001/10001/01010/01010/00100',
    'W':'10001/10001/10001/10101/10101/11011/10001',
    'X':'10001/10001/01010/00100/01010/10001/10001',
    'Y':'10001/10001/01010/00100/00100/00100/00100',
    'Z':'11111/00001/00010/00100/01000/10000/11111',
    '+':'00000/00100/00100/11111/00100/00100/00000',
    '-':'00000/00000/00000/11111/00000/00000/00000',
    '/':'00001/00001/00010/00100/01000/10000/10000',
    ':':'00000/00100/00100/00000/00100/00100/00000',
    '%':'11001/11010/00010/00100/01000/01011/10011',
    ' ':'00000/00000/00000/00000/00000/00000/00000',
    '.':'00000/00000/00000/00000/00000/00110/00110',
    '?':'01110/10001/00001/00110/00100/00000/00100',
    '!':'00100/00100/00100/00100/00100/00000/00100'
  }).map(([k,v])=>[k,Object.freeze(v.split('/'))])));
  // Numeric property enumeration must not choose the atlas order implicitly.
  const repertoire=Object.freeze(Array.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ+-/:% .?!'));
  const cell=Object.freeze({width:6,height:8});
  function scaleCheck(scale) {if(!Number.isSafeInteger(scale)||scale<1) throw new RangeError('scale must be a positive integer');}
  function normalize(text) {return Array.from(String(text),ch=>Object.hasOwn(glyphs,ch)?ch:'?');}
  function measure(text,scale=2) {scaleCheck(scale); return normalize(text).length*6*scale;}
  // Returns the advance of the WHOLE glyphs drawn; overflow never squeezes/clips a glyph.
  function draw(ctx,text,x,y,{scale=2,color='#e8dfc6',align='left',maxWidth=Infinity}={}) {
    scaleCheck(scale);
    if(!['left','center','right'].includes(align)) throw new RangeError('Unknown alignment');
    if(!(maxWidth>=0)) throw new RangeError('maxWidth must be nonnegative');
    const chars=normalize(text).slice(0,Math.floor(maxWidth/(6*scale)));
    const width=chars.length*6*scale;
    const start=Math.round(x-(align==='center'?width/2:align==='right'?width:0));
    ctx.save();
    try {
      ctx.imageSmoothingEnabled=false; ctx.fillStyle=color;
      chars.forEach((ch,n)=>glyphs[ch].forEach((row,j)=>Array.from(row).forEach((p,i)=>{
        if(p==='1') ctx.fillRect(start+(n*6+i)*scale,Math.round(y)+j*scale,scale,scale);
      })));
    } finally {ctx.restore();}
    return width;
  }

  const fontURL=root && typeof document==='object' ? new URL('assets/fonts/NotoSansThai-Regular.otf',document.currentScript?.src || document.baseURI).href : null;
  const fontFamily='HermesQuestNotoThai';
  let fontPromise=null, generation=0;
  const bitmapCache=new Map(); // Never localStorage, indexedDB, or disk; caller clears on privacy migration.
  function clearCache() {generation++;bitmapCache.clear();}
  async function ready() {
    if(!root || typeof root.FontFace!=='function') throw new Error('Bundled font API unavailable');
    if(!fontPromise) fontPromise=(async()=>{
      const face=await new root.FontFace(fontFamily,`url("${fontURL}")`,{weight:'400',style:'normal'}).load();
      document.fonts.add(face);
      await document.fonts.ready;
      return face;
    })().catch(e=>{fontPromise=null;throw e;});
    return fontPromise;
  }
  function graphemes(text) {
    if(typeof Intl.Segmenter!=='function') throw new Error('Grapheme segmentation unavailable');
    return Array.from(new Intl.Segmenter('th',{granularity:'grapheme'}).segment(text),x=>x.segment);
  }
  function wrap(text,maxWidth,widthOf) {
    if(!Number.isFinite(maxWidth)||maxWidth<1) throw new RangeError('maxWidth must be positive and finite');
    const lines=[];
    for(const paragraph of String(text).split(/\r\n|\r|\n/)) {
      const clusters=graphemes(paragraph);
      const words=new Set(Array.from(new Intl.Segmenter('th',{granularity:'word'}).segment(paragraph),s=>s.index+s.segment.length)
        .filter(end=>end===paragraph.length || !/\s/u.test(paragraph[end])));
      let start=0;
      if(!clusters.length) {lines.push('');continue;}
      while(start<clusters.length) {
        let end=start, value='', lastBreak=start, offset=clusters.slice(0,start).join('').length;
        while(end<clusters.length && widthOf(value+clusters[end])<=maxWidth) {
          value+=clusters[end++]; offset+=clusters[end-1].length;
          if(words.has(offset)) lastBreak=end;
        }
        if(end===start) throw new RangeError('A grapheme is wider than the detail box');
        const stop=end===clusters.length?end:lastBreak>start?lastBreak:end;
        lines.push(clusters.slice(start,stop).join('')); start=stop;
      }
    }
    return lines;
  }
  // Reject unsupported codepoints before shaping, rather than silently drawing a system font.
  // The pinned full Noto Sans Thai cmap includes Latin, Thai and these punctuation ranges.
  const coverage=Object.freeze([[32,126],[160,163],[165,165],[167,171],[174,176],[180,180],[182,184],[186,187],[191,263],[266,275],[278,283],[286,291],[294,295],[298,299],[302,305],[310,311],[313,318],[321,328],[336,341],[344,347],[350,353],[356,357],[362,363],[366,382],[536,539],[567,567],[700,700],[710,711],[713,713],[727,733],[768,772],[774,776],[778,780],[806,808],[817,817],[3585,3642],[3647,3675],[7808,7813],[7838,7838],[7922,7923],[8203,8205],[8208,8208],[8211,8212],[8216,8218],[8220,8222],[8226,8226],[8230,8230],[8249,8250],[8364,8364],[8482,8482],[8722,8722],[9676,9676]]);
  function checkCoverage(text) {
    for(const ch of String(text)) {const n=ch.codePointAt(0); if(![10,13].includes(n) && !coverage.some(([a,b])=>n>=a&&n<=b)) throw new RangeError('Unsupported detail glyph');}
  }
  async function bitmap(text,{maxWidth=280,color='#e8dfc6'}={}) {
    text=String(text);checkCoverage(text);
    const epoch=generation;
    await ready();
    if(epoch!==generation) throw new Error('Detail bitmap invalidated by privacy migration');
    const key=JSON.stringify([text,maxWidth,color]);
    if(bitmapCache.has(key)) return bitmapCache.get(key);
    const probe=document.createElement('canvas').getContext('2d');
    probe.font=`18px "${fontFamily}"`; probe.textBaseline='alphabetic';
    const lines=wrap(text,maxWidth,s=>probe.measureText(s).width);
    const bitmaps=lines.map(line=>{
      const m=probe.measureText(line || 'กี่ญู');
      const left=Math.max(0,Math.ceil(m.actualBoundingBoxLeft));
      const width=Math.ceil(Math.max(m.width,m.actualBoundingBoxRight))+left+8;
      const ascent=Math.max(18,Math.ceil(m.actualBoundingBoxAscent));
      const descent=Math.max(5,Math.ceil(m.actualBoundingBoxDescent));
      const canvas=document.createElement('canvas');canvas.width=Math.max(8,width);canvas.height=ascent+descent+8;
      const ctx=canvas.getContext('2d');ctx.font=probe.font;ctx.textBaseline='alphabetic';ctx.fillStyle=color;
      // fillText is used ONLY here, on an offscreen bundled-font line; main glyph draw never calls it.
      ctx.fillText(line,left+4,ascent+4);
      return Object.freeze({canvas,width:canvas.width,height:canvas.height});
    });
    const result=Object.freeze({generation:epoch,lines:Object.freeze(bitmaps),width:Math.max(...bitmaps.map(b=>b.width)),height:bitmaps.reduce((h,b)=>h+b.height,0)});
    if(epoch!==generation) throw new Error('Detail bitmap invalidated by privacy migration');
    if(bitmapCache.size>=64) bitmapCache.delete(bitmapCache.keys().next().value);
    bitmapCache.set(key,result);
    return result;
  }
  function drawBitmap(ctx,value,x,y,scale=1) {
    scaleCheck(scale);
    if(value.generation!==generation) throw new Error('Detail bitmap invalidated by privacy migration');
    ctx.save();
    try {ctx.imageSmoothingEnabled=false;let top=Math.round(y);for(const b of value.lines){ctx.drawImage(b.canvas,Math.round(x),top,b.width*scale,b.height*scale);top+=b.height*scale;}}
    finally {ctx.restore();}
    return {width:value.width*scale,height:value.height*scale};
  }
  // Failure stays visible and accessible. Integration supplies its own hidden textContent DOM.
  async function detail(ctx,text,x,y,{scale=1,onError,...options}={}) {
    scaleCheck(scale);
    try {const value=await bitmap(text,options);return drawBitmap(ctx,value,x,y,scale);}
    catch(e) {
      if(root?.UIGlyphs) root.UIGlyphs.draw(ctx,'offline',x,y,scale,'alert');
      else draw(ctx,'!',x,y,{scale,color:'#e0503c'});
      if(onError) onError('Detail font unavailable');
      return {error:true,width:16*scale,height:16*scale};
    }
  }
  const api=Object.freeze({version:1,cell,advance:6,repertoire,glyphs,measure,draw,ready,bitmap,drawBitmap,detail,wrap,graphemes,clearCache,coverage});
  if(typeof module==='object'&&module.exports) module.exports=api;
  if(root) root.UIText=api;
})(typeof window==='object'?window:null);
