/* Original Hermes Quest pixel drawings. MIT; no provider logos or traced art. */
(function (root) {
  'use strict';
  const palette = Object.freeze(['#0d1526', '#3a4a6b', '#99783b', '#d9b25c', '#e8dfc6']);
  const ids = Object.freeze(('play pause live-follow speed clock scrub-start scrub-end world calm quests log close info ' +
    'demo connected offline snapshot loading mana-claude mana-codex mana-gemini heart mana level coin ' +
    'plan build test review deploy verify sword chain read search vision write memory message delegate compress commit push merge sleep crit').split(' '));

  // All primitives write native pixels into a 16x16 array. No canvas vector paths.
  function make(id) {
    const a = Array.from({length: 16}, () => Array(16).fill(-1));
    const dot = (x, y, c = 3) => { if (x >= 0 && x < 16 && y >= 0 && y < 16) a[y][x] = c; };
    const rect = (x, y, w, h, c = 3) => { for (let j=y;j<y+h;j++) for (let i=x;i<x+w;i++) dot(i,j,c); };
    const line = (x, y, u, v, c = 3) => {
      const dx=Math.abs(u-x), dy=-Math.abs(v-y), sx=x<u?1:-1, sy=y<v?1:-1;
      let e=dx+dy;
      for (;;) { dot(x,y,c); if(x===u && y===v) break; const e2=2*e; if(e2>=dy){e+=dy;x+=sx;} if(e2<=dx){e+=dx;y+=sy;} }
    };
    const box = (x,y,w,h) => { rect(x,y,w,h,3); rect(x+1,y+1,w-2,h-2,0); line(x+1,y+1,x+w-2,y+1,4); };
    const check = () => { line(3,8,6,11,4); line(6,11,12,4,4); line(3,9,6,12); line(6,12,12,5); };
    const arrow = (x,y,dx,dy,n=6) => { line(x,y,x+dx*n,y+dy*n,4); const u=x+dx*n,v=y+dy*n; line(u,v,u-dx*3+dy*3,v-dy*3-dx*3); line(u,v,u-dx*3-dy*3,v-dy*3+dx*3); };
    const page = () => { box(4,2,9,12); rect(11,2,2,3,2); line(6,6,10,6); line(6,9,10,9); line(6,11,8,11,2); };
    const book = () => { box(2,3,12,10); line(7,4,7,12,2); line(4,6,5,6,4); line(9,6,11,6,4); line(9,9,11,9); };
    const bubble = (x,y,w,h) => { box(x,y,w,h); line(x+2,y+h-1,x+2,y+h+1); dot(x+3,y+h); };
    const flask = () => { rect(6,2,4,2,4); line(6,3,6,6); line(9,3,9,6); line(6,6,3,11); line(9,6,12,11); line(3,11,4,13); line(12,11,11,13); line(4,13,11,13); rect(5,10,6,3,2); line(5,10,10,10,3); dot(7,8,4); };
    const diamond = (cx,cy,r,c=3) => { for(let y=-r;y<=r;y++) for(let x=-r;x<=r;x++) if(Math.abs(x)+Math.abs(y)<=r) dot(cx+x,cy+y,c); };
    const ring = (cx,cy,r) => { for(let y=-r;y<=r;y++) for(let x=-r;x<=r;x++){ const d=x*x+y*y; if(d<=r*r && d>=(r-1)*(r-1)) dot(cx+x,cy+y); } dot(cx-2,cy-r+1,4); };
    switch(id) {
      case 'play': for(let x=4;x<=11;x++) rect(x,3+Math.floor((x-4)/2),1,10-2*Math.floor((x-4)/2),3); line(4,3,4,12,4); break;
      case 'pause': rect(3,3,4,10); rect(9,3,4,10); line(3,3,3,12,4); line(9,3,9,12,4); break;
      case 'live-follow': ring(7,7,6); diamond(7,7,2,4); line(7,0,7,3,2); line(7,11,7,14,2); line(0,7,3,7,2); line(11,7,14,7,2); break;
      case 'speed': line(2,4,6,8,4); line(6,8,2,12,4); line(8,4,12,8); line(12,8,8,12); break;
      case 'clock': ring(8,8,6); line(8,4,8,8,4); line(8,8,11,9,4); break;
      case 'scrub-start': case 'scrub-end': line(4,2,11,2,4); line(4,13,11,13); line(5,3,10,8); line(10,3,5,8); line(5,12,10,7); line(10,12,5,7); rect(6,id==='scrub-start'?4:10,4,2,3); rect(id==='scrub-start'?1:14,3,1,10,2); break;
      case 'world': ring(8,8,6); line(2,8,14,8,2); line(4,4,12,4,2); line(4,12,12,12,2); line(7,2,5,8,4); line(5,8,7,14,4); line(9,2,11,8); line(11,8,9,14); break;
      case 'calm': line(3,3,12,3,4); line(3,3,3,9); line(12,3,12,9); line(3,9,7,13); line(12,9,7,13); line(5,7,7,9,4); line(7,9,10,6,4); break;
      case 'quests': page(); rect(2,3,2,3,2); rect(12,11,2,3,2); break;
      case 'log': book(); rect(10,2,2,5,4); break;
      case 'close': line(4,4,11,11,4); line(4,11,11,4,4); line(5,4,12,11); line(5,11,12,4); break;
      case 'info': ring(8,8,6); rect(7,7,2,5,4); rect(7,4,2,2,4); break;
      case 'demo': flask(); break;
      case 'connected': line(2,11,4,9,2); box(4,6,5,4); line(8,6,10,4,4); line(9,7,11,5,4); line(11,4,13,2,2); break;
      case 'offline': box(2,6,5,5); box(9,3,5,5); line(2,2,13,13,4); break;
      case 'snapshot': box(2,3,12,10); rect(5,1,4,3,2); ring(8,8,3); dot(12,5,4); break;
      case 'loading': line(3,3,10,3,4); line(10,3,13,6,4); line(13,6,13,10); line(13,10,10,13); line(10,13,5,13,2); line(5,13,2,10,1); break;
      case 'mana-claude': diamond(7,8,6,2); diamond(7,8,4,3); line(7,3,7,10,4); line(4,8,10,8,4); break;
      case 'mana-codex': box(3,3,10,10); line(6,6,4,8,4); line(4,8,6,10,4); line(9,6,11,8); line(11,8,9,10); break;
      case 'mana-gemini': diamond(4,8,3); diamond(11,8,3); line(7,3,7,13,4); break;
      case 'heart': rect(3,3,4,2); rect(9,3,4,2); rect(2,5,12,3); rect(3,8,10,2); rect(5,10,6,2); rect(7,12,2,2); line(3,4,5,4,4); dot(3,5,4); break;
      case 'mana': for(let y=2;y<=9;y++){const r=Math.floor((y-2)/2);rect(8-r,y,2*r+1,1,3);} rect(4,9,9,2,3); rect(5,11,7,2,3); rect(7,13,3,1,2); line(6,7,5,10,4); dot(6,11,4); break;
      case 'level': diamond(8,8,5); line(8,1,8,14,4); line(2,8,14,8,4); line(3,3,12,12); line(3,12,12,3); break;
      case 'coin': ring(8,8,6); for(let y=4;y<=12;y++) rect(5,y,7,1,2); rect(7,4,3,9,3); line(8,5,8,11,4); dot(5,5,4); break;
      case 'plan': page(); line(2,12,11,3,4); dot(2,13,2); break;
      case 'build': rect(3,3,9,4,3); rect(8,2,4,6,2); line(7,7,4,13,4); line(8,7,5,13); break;
      case 'test': flask(); line(11,2,13,4,4); line(13,2,11,4,4); break;
      case 'review': page(); ring(5,7,3); line(6,10,2,14,4); break;
      case 'deploy': line(8,1,4,6,4); line(8,1,12,6,4); rect(5,6,7,5); rect(7,4,3,5,2); rect(7,11,3,3,4); dot(5,13,2); dot(11,13,2); break;
      case 'verify': check(); break;
      case 'sword': line(4,11,12,3,4); line(5,11,13,3); line(4,9,7,12,2); line(3,12,5,14,3); dot(13,2,4); break;
      case 'chain': box(2,8,7,5); box(7,3,7,5); line(6,10,10,6,4); break;
      case 'read': book(); line(3,2,6,2,2); break;
      case 'search': ring(6,6,4); line(9,9,13,13,4); line(10,9,14,13); break;
      case 'vision': line(1,8,5,4); line(5,4,10,4); line(10,4,14,8); line(1,8,5,12); line(5,12,10,12); line(10,12,14,8); diamond(8,8,3,4); dot(8,8,0); break;
      case 'write': line(3,11,11,3,4); line(4,12,12,4); line(5,12,13,4,2); dot(2,13,3); line(10,2,13,5,3); line(3,14,12,14,2); break;
      case 'memory': box(4,4,8,8); rect(6,6,4,4,2); for(let i=4;i<=11;i+=3){rect(i,2,1,2,4);rect(i,12,1,2,3);rect(2,i,2,1,4);rect(12,i,2,1,3);} break;
      case 'message': bubble(2,3,12,8); line(4,6,11,6,4); line(4,8,8,8); break;
      case 'delegate': bubble(1,2,8,6); bubble(8,8,7,5); line(4,11,6,13,4); line(6,13,7,11,4); break;
      case 'compress': arrow(1,8,1,0,4); arrow(14,8,-1,0,4); rect(7,3,2,10,2); break;
      case 'commit': ring(8,8,3); line(1,8,4,8,4); line(12,8,14,8,4); dot(8,8,4); break;
      case 'push': box(2,11,12,3); arrow(8,10,0,-1,7); break;
      case 'merge': line(4,3,4,12,4); line(11,3,11,6); line(11,6,4,10); diamond(4,3,1); diamond(11,3,1); diamond(4,12,1); break;
      case 'sleep': line(4,3,11,3,4); line(11,3,4,10,4); line(4,10,11,10,4); line(10,12,14,12,2); line(14,12,10,15,2); line(10,15,14,15,2); break;
      case 'crit': diamond(8,8,4,4); line(8,0,8,3); line(8,13,8,15); line(0,8,3,8); line(13,8,15,8); line(2,2,4,4,2); line(12,12,14,14,2); line(2,14,4,12,2); line(12,4,14,2,2); break;
      default: throw new RangeError('Unknown icon: '+id);
    }
    // A one-pixel navy silhouette separates clusters from the game scene.
    const out=a.map(r=>r.slice());
    for(let y=0;y<16;y++) for(let x=0;x<16;x++) if(a[y][x]>0)
      for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]) if(a[y+dy]?.[x+dx]===-1) out[y+dy][x+dx]=0;
    return Object.freeze(out.map(r=>Object.freeze(r)));
  }
  const pixels=Object.freeze(Object.fromEntries(ids.map(id=>[id,make(id)])));
  function validateScale(scale) { if(!Number.isSafeInteger(scale)||scale<1) throw new RangeError('scale must be a positive integer'); }
  function draw(ctx,id,x,y,scale=2,state='normal') {
    validateScale(scale);
    if(!Object.hasOwn(pixels,id)) throw new RangeError('Unknown icon: '+id);
    if(!['normal','selected','disabled','alert'].includes(state)) throw new RangeError('Unknown icon state');
    ctx.save();
    try {
      ctx.imageSmoothingEnabled=false;
      const colors=state==='disabled'?['#0d1526','#3a4a6b','#3a4a6b','#3a4a6b','#99783b']:
        state==='alert'?['#0d1526','#3a4a6b','#99783b','#e0503c','#e8dfc6']:palette;
      if(state==='selected') { ctx.fillStyle=palette[3]; ctx.fillRect(Math.round(x)-scale,Math.round(y)-scale,18*scale,18*scale); ctx.fillStyle=palette[0]; ctx.fillRect(Math.round(x),Math.round(y),16*scale,16*scale); }
      pixels[id].forEach((row,j)=>row.forEach((c,i)=>{if(c>=0){ctx.fillStyle=colors[c];ctx.fillRect(Math.round(x)+i*scale,Math.round(y)+j*scale,scale,scale);}}));
    } finally {ctx.restore();}
    return {width:16*scale,height:16*scale};
  }
  const api=Object.freeze({version:1,ids,palette,pixels,draw});
  if(typeof module==='object' && module.exports) module.exports=api;
  if(root) root.UIGlyphs=api;
})(typeof window==='object'?window:null);
