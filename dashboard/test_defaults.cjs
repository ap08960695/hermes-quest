// Default-source and identity-upgrade contract: synthetic fixtures only.
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const vm = require('vm'), assert = require('assert'), {spawnSync} = require('child_process');
const root = path.resolve(__dirname, '..');
const world = JSON.parse(fs.readFileSync(path.join(root, 'data/world.json')));
const demo = JSON.parse(fs.readFileSync(path.join(root, 'data/demo.json')));
const heroMeta = JSON.parse(fs.readFileSync(path.join(root, 'assets/px/heroes.json')));
const shippedCombos = Object.keys(heroMeta.source_checks);
assert.strictEqual(shippedCombos.length, 21, 'all reviewed M1 sheets must be listed');
assert.deepStrictEqual([...shippedCombos].sort(), fs.readdirSync(path.join(root, 'assets/px/heroes'))
  .filter(f => f.endsWith('.png')).map(f => f.slice(0, -4)).sort(), 'manifest must match shipped sheets');
const {createClient} = require('../tools/parity/loader.cjs');
const copy = value => JSON.parse(JSON.stringify(value));
function client(search = '', pathname = '/index.html', replay = demo, manifest = heroMeta) {
  const elements = new Map(), calls = [], images = [], noop = () => {};
  const el = s => {
    if (!elements.has(s)) elements.set(s, {dataset: {}, style: {}, classList: {toggle: noop}, getContext: () => ({})});
    return elements.get(s);
  };
  const sandbox = {console, URLSearchParams, AbortController, setTimeout: noop, clearTimeout: noop,
    Date, Math, Image: class {set src(value) {images.push(value); this.onerror();}},
    requestAnimationFrame: noop, addEventListener: noop, performance: {now: () => 0},
    document: {querySelector: el, querySelectorAll: () => [], body: el('body')},
    window: {devicePixelRatio: 1, location: {search, pathname}},
    fetch: async (url, options) => {
      calls.push({url, options});
      return {ok: true, json: async () => copy(url === 'assets/px/heroes.json' ? manifest : url.startsWith('assets/') ? {} : url.includes('world') ? world : replay)};
    }};
  vm.createContext(sandbox);
  const connected = require('./ui_test_support.cjs')(sandbox, el);
  const {run} = createClient({root, sandbox});
  // Asset drawing/UI are browser-tested separately; keep the actual boot,
  // source selection, snapshot validation, timeline and polling code here.
  run('ui=()=>{};');
  return {sandbox, calls, images, run, el, connected};
}
(async () => {
  for (const [search, pathname, expected, live] of [
    ['', '/index.html', 'data/demo.json', false],
    ['?data=data/replay.json', '/index.html', 'data/replay.json', false],
    ['?live=1', '/index.html', '/api/plugins/hermes-quest/replay?hours=12', true],
    ['', '/api/plugins/hermes-quest/static/index.html', '/api/plugins/hermes-quest/replay?hours=12', true],
    // Live mode must not be demoted to standalone by a replay override.
    ['?live=1&data=data/demo.json', '/index.html', '/api/plugins/hermes-quest/replay?hours=12', true]
  ]) {
    const c = client(search, pathname); await c.run('boot()');
    assert.strictEqual(c.calls[0].url, expected);
    assert.strictEqual(c.calls[0].options.cache, 'no-store');
    assert.strictEqual(c.run('liveFeed'), live);
    assert(c.run('Object.keys(S.heroes).length') > 0);
    assert.strictEqual(c.run('captainId()'), 'demo-captain');
    for (const b of demo.bots) {
      c.sandbox.bot = b;
      const sprite = c.run('`${bot.cls}-${mstyle(bot.model).tag}.png`');
      assert(shippedCombos.includes(sprite.slice(0, -4)), sprite + ' absent from manifest');
      assert(fs.existsSync(path.join(root, 'assets/px/heroes', sprite)), sprite);
      assert(c.images.includes('assets/px/heroes/' + sprite), sprite + ' not requested');
    }
    if (!live && !search) assert(!c.calls.some(v => /replay|\/api\//.test(v.url)));
    assert(c.connected(live ? 'online' : 'file'), 'boot connection must expose its exact accessible meaning');
  }
  // Real data may contain new classes/models. Listed sheets load once; the five
  // historical missing demo combos, unknown styles/classes and absent manifests
  // must never cause speculative variant requests.
  const unusual = copy(demo);
  unusual.bots = [['commander','opus'],['paladin','haiku'],['engineer','luna'],
    ['sage','astra'],['mage','fable'],['new-class','sonnet'],['mage','future-model'],
    ['mage','sonnet'],['mage','sonnet']].map(([cls, model], i) =>
      ({id:'synthetic-'+i, cls, model, region:'forge'}));
  unusual.tasks = []; unusual.events = [];
  const legacyMeta = {...heroMeta, combos: shippedCombos};
  for (const manifest of [heroMeta, legacyMeta, {}, {...heroMeta, combos:null}, {...heroMeta, combos:[]}]) {
    const c = client('', '/index.html', unusual, manifest); await c.run('boot()');
    assert.deepStrictEqual(c.images.filter(v => v.startsWith('assets/px/heroes/')),
      manifest === heroMeta || manifest === legacyMeta ? ['assets/px/heroes/mage-Sonnet.png'] : []);
    assert(c.connected('file'));
    assert(c.images.includes('assets/px/mage.png')); // Class fallback remains loaded.
  }
  // No metadata means no implicit machine-specific Captain profile.
  const c = client(); c.sandbox.world = world;
  c.run(`W=world; loadReplay({meta:{from_:0,to:10,captain:'old-profile'},cursor:'old',
    bots:[{id:'old-profile',name:'OLD PRIVATE LABEL',cls:'commander',region:'castle'}],
    tasks:[],events:[]}); reset(10); liveFeed=true; following=true; S.play=true;
    S.feed=[{html:'OLD PRIVATE LABEL'}]; S.fx=[{k:'old',life:10}];`);
  c.sandbox.delta = {meta: {captain: 'bot-aaaaaaaaaaaaaaaaaaaa'}, events: [], bots: [], tasks: [], cursor: 'delta'};
  assert.throws(() => c.run('mergeDelta(delta)'), /identity changed/);
  assert.strictEqual(c.run('cursor'), 'old');
  assert.strictEqual(c.run('D.bots[0].id'), 'old-profile');
  const replay = {meta: {from_:0,to:10,captain:'bot-aaaaaaaaaaaaaaaaaaaa',show_titles:false},
    cursor:'new', bots:[{id:'bot-aaaaaaaaaaaaaaaaaaaa',name:'bot-aaaaaaaaaaaaaaaaaaaa',cls:'commander',region:'castle'}], tasks:[], events:[]};
  c.sandbox.fetch = async url => ({ok:true,json:async()=>copy(url.includes('events?') ? c.sandbox.delta : replay)});
  await c.run('pollEvents()');
  assert.strictEqual(c.run('cursor'), 'new');
  assert.strictEqual(c.run('S.heroes["old-profile"]'), undefined);
  assert.strictEqual(c.run('S.feed.length'), 0); assert.strictEqual(c.run('S.fx.length'), 0);
  assert.strictEqual(c.run('S.heroes[captainId()].cls'), 'commander');
  assert.strictEqual(c.run('following && S.play'), true);
  c.run('D.meta={};'); assert.strictEqual(c.run('captainId()'), '');

  // Exercise the real CLI from a fresh synthetic-only directory. Poisoned live
  // replay must be ignored, not silently substituted or overwritten by mock.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quest-default-'));
  try {
    const modules = [...fs.readFileSync(path.join(root, 'index.html'), 'utf8')
      .matchAll(/<script src="(quest\/[^"]+)"><\/script>/g)].map(m => m[1]);
    for (const f of ['index.html','game.js',...modules,'npcs.js','assets/px/npcs/meta.json','data/world.json','tools/backtest.js','tools/parity/loader.cjs','tools/mock.py','tools/extract.py']) {
      const dest=path.join(dir,f); fs.mkdirSync(path.dirname(dest),{recursive:true}); fs.copyFileSync(path.join(root,f),dest);
    }
    const exec = (command,args,expected=0) => {
      const r=spawnSync(command,args,{cwd:dir,encoding:'utf8'});
      assert.strictEqual(r.status,expected,`${command} ${args.join(' ')}: ${r.stderr}\n${r.stdout}`); return r;
    };
    exec('python3',['tools/mock.py']);
    const original=fs.readFileSync(path.join(dir,'data/demo.json'));
    assert.deepStrictEqual(JSON.parse(original), demo, 'shipped demo must match the seeded generator');
    const generated = JSON.parse(original), expectedEvents = generated.events.length;
    assert(expectedEvents > 0, 'default fixture must exercise replay events');
    for (const kind of ['mana', 'pause', 'resume', 'failover']) {
      assert(generated.events.some(e => e.kind === kind), 'C1 demo missing ' + kind);
    }
    const backtest = args => {
      const r = exec(process.execPath, ['tools/backtest.js', ...args]);
      assert(/\nPASS\s*$/.test(r.stdout), 'all motion/action/social/NPC gates must pass');
      // C1 intentionally adds mana/status events and seeded draws; 709 was the
      // pre-C1 fixture. Verify the selected source, not a frozen campaign size.
      // M4 adds a separate NPC result object after this replay result.
      assert.strictEqual(JSON.parse(r.stdout.match(/^\{[\s\S]*?^\}/m)[0]).replay_events, expectedEvents);
      return r.stdout;
    };
    const firstBacktest = backtest([]);
    fs.writeFileSync(path.join(dir,'data/replay.json'),'SYNTHETIC POISON NOT JSON');
    exec('python3',['tools/mock.py']);
    assert.deepStrictEqual(fs.readFileSync(path.join(dir,'data/demo.json')),original);
    assert.strictEqual(fs.readFileSync(path.join(dir,'data/replay.json'),'utf8'),'SYNTHETIC POISON NOT JSON');
    assert.strictEqual(backtest([]), firstBacktest, 'poisoned replay must not affect default backtest');
    assert.strictEqual(backtest(['--data','data/demo.json']), firstBacktest, 'explicit demo must match default');
    exec(process.execPath,['tools/backtest.js','--data','data/replay.json'],1);
    exec(process.execPath,['tools/backtest.js','--data','missing.json'],1);
    exec(process.execPath,['tools/backtest.js','--data'],2);
    fs.unlinkSync(path.join(dir,'data/demo.json'));
    exec(process.execPath,['tools/backtest.js'],1); // Never fall back to live.
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  console.log('PASS: standalone demo-only boot, explicit file/live selection, pseudonymous Captain clean migration, fresh CLI fixture-matched unchanged gate, poisoned replay ignored, deterministic mock and fail-closed missing sources');
})().catch(e => {console.error(e); process.exitCode=1});
