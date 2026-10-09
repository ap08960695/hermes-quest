"""Exercise the real plugin allowlist without reading operator data."""
import hashlib
import importlib.util
import subprocess
import unittest
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("quest_ui_api", ROOT / "dashboard/plugin_api.py")
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)
app = FastAPI()
app.include_router(api.router, prefix="/api/plugins/hermes-quest")
client = TestClient(app)
class PluginStaticTests(unittest.TestCase):
    def test_exact_assets_and_font_mime(self):
        assets = ["index.html", "game.js", "npcs.js", "font.js", "ui-glyphs.js", "ui-panels.js", "quest/c-ui.js",
                  "assets/fonts/NotoSansThai-Regular.otf", "assets/px/ui/font-5x7.png",
                  "assets/px/ui/icons-16.png", "assets/px/ui/atlas.json"]
        for asset in assets:
            with self.subTest(asset=asset):
                response = client.get("/api/plugins/hermes-quest/static/" + asset)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(hashlib.sha256(response.content).digest(),
                                 hashlib.sha256((ROOT / asset).read_bytes()).digest())
                self.assertEqual(response.headers["x-content-type-options"], "nosniff")
                if asset.endswith(".otf"):
                    self.assertEqual(response.headers["content-type"], "font/otf")
                if asset.endswith(".js"):
                    self.assertIn("application/javascript", response.headers["content-type"])
                    self.assertEqual(response.headers["cache-control"], "no-store")

    def test_c_ui_loads_before_game(self):
        html = (ROOT / "index.html").read_text()
        self.assertEqual(html.count('<script src="quest/c-ui.js"></script>'), 1)
        self.assertLess(html.index('<script src="quest/c-ui.js"></script>'),
                        html.index('<script src="game.js"></script>'))
        self.assertIn('<html lang="en">', html)

    def test_denied_paths(self):
        for asset in ["data/replay.json", "assets/fonts/OFL.txt", "assets/fonts/other.otf", "../index.html",
                      "assets/px/../../data/replay.json", "assets//px/ui/atlas.json", "assets\\px\\ui\\atlas.json",
                      "quest/private.js", "quest/c-ui.json", "quest/C-UI.js", "quest/sub/c-ui.js",
                      "quest//c-ui.js", "quest/./c-ui.js", "quest/../game.js", "quest\\c-ui.js"]:
            with self.subTest(asset=asset):
                with self.assertRaises(HTTPException) as caught:
                    api._static_target(asset)
                self.assertEqual(caught.exception.status_code, 404)

    def test_panel_token_accessibility_and_campaign_compatibility(self):
        # Exercise the real panel code with a minimal DOM/canvas test double.
        # Browser geometry and font rasterization remain separate browser tests.
        script = r'''
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const draws=[],bitmaps=[];
class Element {
  constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.style={};this.attrs={};
    this.clientWidth=320;this.hidden=false;this.isConnected=true;
    this.classList={contains:name=>this.className===name};}
  append(...items){this.children.push(...items);}
  replaceChildren(...items){this.children=items;}
  setAttribute(key,value){this.attrs[key]=value;}
  get firstChild(){return this.children[0];}
  querySelector(selector){for(const child of this.children){
    if(selector.startsWith('.')?child.className===selector.slice(1):child.tag===selector)return child;
    const match=child.querySelector(selector);if(match)return match;}return null;}
  getContext(){return {save(){},restore(){},fillRect(){},drawImage(){}};}
  getBoundingClientRect(){return {left:0,top:0,right:40,bottom:40,width:40,height:40};}
  cloneNode(){return new Element(this.tag);}
  focus(){}
}
const elements=new Map(),el=id=>{if(!elements.has(id))elements.set(id,new Element('div'));return elements.get(id);};
global.window=global;global.innerWidth=390;global.innerHeight=844;
global.document={createElement:tag=>new Element(tag),querySelector:selector=>{
  if(selector==='#quest .detail-content')return el('#quest').querySelector('.detail-content');return el(selector);},
  documentElement:{style:{setProperty(){}}},addEventListener(){}};
global.addEventListener=()=>{};global.getComputedStyle=()=>({display:'block'});
global.UIText={measure:t=>t.length*12,draw:(ctx,t)=>draws.push(t),clearCache(){},
  bitmap:async text=>{bitmaps.push(text);return {lines:[]};}};
vm.runInThisContext(fs.readFileSync('ui-glyphs.js','utf8'));
assert.equal(UIGlyphs.ids.length,46);
vm.runInThisContext(fs.readFileSync('ui-panels.js','utf8'));
UIPanels.init();
const ledger={claude:{net:90000,hasCharsEstimate:true,hasUsageCorrection:true},
  codex:{net:-20,hasUsageCorrection:true},agy:{net:120000}};
const before=JSON.stringify(ledger);
UIPanels.resources({claude:10,codex:100,agy:0},ledger);
const wallets=el('#mana').children;
assert.match(wallets[0].attrs['aria-label'],/90,000 used tokens/);
assert.match(wallets[0].attrs['aria-label'],/100,000 tokens per wallet per replay epoch, not a real quota/);
assert.match(wallets[0].attrs['aria-label'],/character-based token estimates/);
assert.match(wallets[0].attrs['aria-label'],/signed usage corrections/);
assert.match(wallets[1].attrs['aria-label'],/0 used tokens/);
assert.doesNotMatch(wallets[1].attrs['aria-label'],/character-based/);
assert.match(wallets[2].attrs['aria-label'],/120,000 used tokens/);
assert.deepEqual(wallets.map(box=>box.querySelector('b').style.width),['10%','100%','0%']);
UIPanels.resources({claude:10,codex:100,agy:0},{claude:{net:89999}});
assert.match(wallets[0].querySelector('.percentage').attrs['aria-label'],/89,999 used tokens/);
assert.doesNotMatch(wallets[0].attrs['aria-label'],/character-based|signed usage corrections/);
assert.equal(JSON.stringify(ledger),before);
UIPanels.resources({claude:101,codex:-1,agy:99.6});
assert.deepEqual(wallets.map(box=>box.querySelector('b').style.width),['100%','0%','100%']);
for(const count of ['1/2 quests · ⚔ 3','1/2 เควส · ⚔ 3','1/2 · ⚔ 3']){
  draws.length=0;UIPanels.camps([{title:'Synthetic campaign',count,stages:[]}]);
  assert.deepEqual(draws,['1','/','2','3']);
  assert.doesNotMatch(el('#camps').querySelector('.campaign-count').attrs['aria-label'],/[\u0e00-\u0e7f]/);
}
el('#help').onclick();
assert.equal(el('#quest').querySelector('.detail-content').children.filter(e=>e.className==='legend-row').length,46);
assert(bitmaps.some(text=>text.includes('100,000 tokens per wallet per replay epoch')));
assert(bitmaps.some(text=>text.includes('a correction is not itself a character-based estimate')));
console.log('PASS token accessibility, campaign compatibility, 46-glyph legend');
'''
        result = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True, check=True)
        self.assertIn("PASS token accessibility", result.stdout)


if __name__ == "__main__":
    unittest.main()
