'use strict';
const assert=require('node:assert/strict');
// Runs inside the browser. A canvas element alone is not readable output.
function inspectDetail(){
  const el=document.querySelector('#quest'),r=el.getBoundingClientRect();
  const rows=[...el.querySelectorAll('.detail-content .bitmap-row')].map(row=>{
    const text=row.querySelector('span')?.textContent||'';
    const fallback=row.querySelector('.detail-text'),box=fallback?.getBoundingClientRect();
    const ink=[...row.querySelectorAll('canvas')].some(c=>{
      const b=c.getBoundingClientRect();
      return b.width>0&&b.height>0&&c.getContext('2d').getImageData(0,0,c.width,c.height).data.some((v,i)=>i%4===3&&v>0);
    });
    return {text,readable:!!(fallback&&box.width>0&&box.height>0&&fallback.textContent.trim())||ink};
  });
  return {x:r.x,y:r.y,w:r.width,h:r.height,scroll:el.scrollWidth,client:el.clientWidth,rows};
}
function assertReadableDetail(detail,expected){
  assert(expected.length>0,'readability oracle must name expected rows');
  assert.equal(detail.rows.length,expected.length,'expected nonempty detail rows');
  detail.rows.forEach((row,i)=>{assert.equal(row.text,expected[i],'expected detail text');assert(row.readable,'expected visible text or raster ink');});
}
function assertRenderedAliases(rendered,aliases){
  assert(rendered.length>0,'nonempty rendered scene labels');
  const text=rendered.map(row=>row.text).join(' ').toUpperCase();
  for(const alias of aliases)assert(text.includes(alias.toUpperCase()),'missing rendered identity: '+alias+'; raster='+JSON.stringify(rendered));
  assert(rendered.every(row=>row.ink),'rendered label has no ink');
}
module.exports={inspectDetail,assertReadableDetail,assertRenderedAliases};
