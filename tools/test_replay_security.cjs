#!/usr/bin/env node
// Browser regressions exercise the production loader and renderer, not a copy.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname, '..');
const { chromium, firefox } = require(process.env.PLAYWRIGHT_NODE_MODULE || 'playwright');
const demo = JSON.parse(fs.readFileSync(path.join(root, 'data/demo.json')));
const hostile = structuredClone(demo);
const marker = '<img src=x onerror="window.__qcanary=1"><b data-qcanary="1">q</b>';
const feedFields = ['before', 'after', 'passed', 'code', 'stage', 'outcome'];
const feedEvent = demo.events.find(e => e.bot && e.task && e.kind === 'tests');
assert(feedEvent, 'synthetic fixture must contain a worker test event');
hostile.events = [
  ...demo.events.filter(e => e.kind !== 'captain'),
  { ...demo.events.find(e => e.kind === 'captain'), kind: 'captain', act: marker },
  ...feedFields.map(field => ({ ...feedEvent, id: 'hostile-feed-' + field, kind: ({ before: 'compress', after: 'compress',
    passed: 'tests', code: 'hurt', stage: 'created', outcome: 'run_end' })[field],
    before: 10, after: 5, passed: 2, code: 1, [field]: marker + ' field-' + field })),
];
const types = { '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png' };
const served = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  served.push(url.pathname);
  if (url.pathname === '/api/plugins/hermes-quest/replay') {
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(hostile)); return;
  }
  if (url.pathname === '/data/hostile.json') {
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(hostile)); return;
  }
  const route = url.pathname.replace(/^\/api\/plugins\/hermes-quest\/static/, '');
  const file = path.resolve(root, '.' + (route === '/' ? '/index.html' : route));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
  res.setHeader('content-type', types[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const engine of [chromium, firefox]) {
  const browser = await engine.launch({ headless: true, args: engine === chromium ? ['--no-sandbox'] : [] });
  try {
    const cases = [
      { url: '/index.html?data=https://attacker.invalid/payload.json', replay: '/data/demo.json' },
      { url: '/index.html?data=//attacker.invalid/payload.json', replay: '/data/demo.json' },
      { url: '/index.html?data=data:text/html,evil', replay: '/data/demo.json' },
      { url: '/index.html?data=/api/private.json', replay: '/data/demo.json' },
      { url: '/index.html?data=data/../private.json', replay: '/data/demo.json' },
      { url: '/index.html?data=data/hostile.json', replay: '/data/hostile.json', hostile: true },
      { url: '/index.html?live=1&data=https://attacker.invalid/payload.json', replay: '/api/plugins/hermes-quest/replay', hostile: true },
      { url: '/api/plugins/hermes-quest/static/index.html?data=https://attacker.invalid/payload.json', replay: '/api/plugins/hermes-quest/replay', hostile: true },
    ];
    for (const test of cases) {
      const page = await browser.newPage(); const errors = []; const external = [];
      page.on('pageerror', e => errors.push(String(e)));
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) { external.push(url.origin); return route.abort(); }
        return route.continue();
      });
      await page.addInitScript(() => { window.__questTestGlobals = true; });
      const start = served.length;
      await page.goto(origin + test.url);
      await page.waitForFunction(() => window.__questTest && window.D && typeof document.querySelector('#play').onclick === 'function');
      if (test.hostile) {
        const entered = await page.evaluate(() => {
          const game = window.__questTest;
          for (const event of window.D.events) game.apply(event, true);
          const captain = game.hero(window.D.meta.captain);
          captain.rest.state = 'active'; captain.rest.phase = null;
          const event = window.D.events.find(e => e.kind === 'captain');
          const before = window.S.soc.captain || 0;
          for (const act of [event.act, '__proto__', 'constructor', 'toString']) game.apply({ ...event, act }, true);
          game.draw();
          return (window.S.soc.captain || 0) - before;
        });
        assert.equal(entered, 4, 'unknown actions must reach the Captain handler');
        // Exercise each raw feed input through the real event handlers, then render
        // the actual feed and its Details dialog. Merely carrying HTML in JSON is not proof.
        for (const field of feedFields) {
          const reached = await page.evaluate(({ field, marker }) => {
            const game = window.__questTest;
            const event = window.D.events.find(e => typeof e[field] === 'string' && e[field].endsWith('field-' + field));
            if (!event) throw new Error('hostile event missing: ' + field);
            const hero = game.hero(event.bot), task = game.task(event.task);
            hero.rest.state = 'active'; hero.rest.phase = null; hero.task = task.id;
            task.bot = hero.bot; task.state = 'fight'; task.dying = 0; task.alpha = 1; task.mpath = null;
            window.S.feed = []; window.S.lastFeed = {};
            game.apply(event, true);
            // stage/outcome are fixed-enum presentation paths: unknown values must not
            // become feed prose. The four interpolated fields MUST reach the feed.
            const raw = window.S.feed.map(f => f.html).join('\n');
            document.querySelector('#menu').hidden = false;
            document.querySelector('#chron').hidden = false;
            document.querySelector('#group-overview').open = true;
            game.renderFeed();
            return { raw, rendered: document.querySelector('#feed').textContent };
          }, { field, marker });
          if (['stage', 'outcome'].includes(field)) {
            assert(!reached.raw.includes(marker), `${field}: unknown enum has no feed prose`);
          } else {
            assert(reached.raw.includes(marker), `${field}: marker actually reached the feed`);
            assert(reached.rendered.includes('field-' + field), `${field}: literal marker rendered`);
            await page.locator('#feed button').first().click();
            assert((await page.locator('#quest').textContent()).includes('field-' + field), `${field}: Details path rendered`);
          }
          assert.equal(await page.evaluate(() => window.__qcanary || 0), 0, field);
          assert.equal(await page.locator('[data-qcanary], img[src="x"]').count(), 0, field);
        }
      }
      assert(served.slice(start).includes(test.replay), `source ${test.url}`);
      assert.deepEqual(external, [], 'no attacker-origin fetch');
      assert.deepEqual(errors, [], 'unknown action must not throw');
      assert.equal(await page.evaluate(() => window.__qcanary || 0), 0);
      assert.equal(await page.locator('[data-qcanary]').count(), 0);
      assert.equal(await page.locator('img[src="x"]').count(), 0);
      await page.close();
    }
    const page = await browser.newPage();
    await page.addInitScript(() => { window.__questTestGlobals = true; });
    await page.goto(origin + '/index.html');
    await page.waitForFunction(() => window.D?.tasks?.length > 0 && typeof document.querySelector('#play').onclick === 'function');
    const redacted = await page.evaluate(() => {
      const source = structuredClone(window.D);
      source.tasks[0].title = 'SECRET title'; source.tasks[0].campaign = 'SECRET lane';
      source.tasks[0].note = 'SECRET'; source.events[0].note = 'SECRET';
      source.meta.show_titles = false;
      window.__questTest.loadReplay(source);
      return window.D;
    });
    assert.equal(redacted.tasks[0].title, redacted.tasks[0].id);
    assert.equal(redacted.tasks[0].campaign, 'misc');
    assert(!JSON.stringify(redacted).includes('SECRET'), 'titles/campaign/note removed');
    await page.close();
    console.log(`PASS replay-security ${engine.name()}: ${cases.length} URL sources, ${feedFields.length} hostile feed fields (4 interpolated + 2 enum-rejected), Details, no external fetch, privacy redaction`);
  } finally { await browser.close(); }
  }
  server.close();
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
