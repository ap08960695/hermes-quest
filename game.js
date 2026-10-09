// Hermes Quest demo: replays Hermes kanban + worker tool calls as an RPG world (back test).
// Plain Canvas 2D, no deps. Motion rules from the design talk:
//  - walk frames advance by distance travelled (no foot sliding), contact-frame bob, ground shadow,
//    eased start/stop; figures only travel on precomputed road paths (no wall walking)
//  - integer screen positions + nearest-neighbour sprites (no shimmer), preloaded atlases (no flicker)
//  - attacks are anticipation -> swing -> impact (hit-stop + shake + flash) -> recover
'use strict';
// D2 facade: construction owns all game state; registration does not boot.
function createGame({autoBoot = true} = {}) {
// Two-phase wiring: publish live root bindings, construct without calling peers, then boot.
const ctx = {};

const $ = s => document.querySelector(s);
const cv = $('#stage'), cx = cv.getContext('2d');
const DPR = Math.min(2, window.devicePixelRatio || 1);
const UI = window.UIPanels;
let calm = false;

const img = src => new Promise(r => { const i = new Image(); i.onload = () => r(i); i.onerror = () => r(null); i.src = src; });

let MON2 = {}, MMETA2 = {}, SPRV = {};
let D, W, BG, SPR = {}, MONS = null, MONMETA = null, BLD = {}, MIMG = {}, HMETA = {fw: 128, fh: 96, ax: 48, base: 91, walk: [0, 1, 2, 3], atk: [4, 5, 6, 7], idle: []};
async function boot() {
  try {
  const params = new URLSearchParams(window.location?.search || '');
  ctx.liveFeed = !params.has('data') && (params.get('live') === '1' || (window.location?.pathname || '').startsWith(ctx.API));
  [D, W] = await Promise.all([ctx.json(params.get('data') || (ctx.liveFeed ? `${ctx.API}replay?hours=12` : 'data/demo.json')), ctx.json('data/world.json')]);
  ctx.loadReplay(D);
  BG = await img('assets/px/ground.png');
  for (const c of Object.keys(ctx.CLS_HUE)) SPR[c] = await img(`assets/px/${c}.png`);
  HMETA = Object.assign(HMETA, await fetch('assets/px/heroes.json').then(r => r.ok ? r.json() : {}).catch(() => ({})));
  // Only shipped combinations may trigger a request; unknown models/classes
  // keep the class (or warrior) fallback without a speculative sprite 404.
  // M1's audited metadata lists the shipped sheets as source_checks keys.
  // Explicit combos (including an empty/invalid list) still take precedence.
  const combos = new Set('combos' in HMETA ? (Array.isArray(HMETA.combos) ? HMETA.combos : []) : Object.keys(HMETA.source_checks || {}));
  for (const b of D.bots) { const st = ctx.mstyle(b.model), key = `${b.cls}-${st.tag}`; if (st !== ctx.NO_STYLE && combos.has(key) && !(key in SPRV)) SPRV[key] = await img(`assets/px/heroes/${key}.png`); }
  for (const n of ['goblin', 'golem', 'slime', 'ghost', 'bat', 'skeleton', 'dragon', 'mimic']) MIMG[n] = await img(`assets/px/monsters/${n}.png`);
  MMETA2 = await fetch('assets/px/monsters2/meta.json').then(r => r.ok ? r.json() : {}).catch(() => ({}));
  for (const k of Object.keys(MMETA2)) MON2[k] = await img(`assets/px/monsters2/${k}.png`);
  for (const p of W.props || []) if (!BLD[p.img]) BLD[p.img] = await img(`assets/px/${p.src || 'buildings'}/${p.img}.png`);
  if (window.NPCS) await NPCS.load(W, D, img);                      // M4 villagers (npcs.js)
  MONMETA = await fetch('assets/sprites/monsters.json').then(r => r.ok ? r.json() : null).catch(() => null);
  if (UI) UI.mode(D.meta.source === 'demo' ? 'DEMO' : ctx.liveFeed ? 'LIVE' : 'REPLAY');
  ctx.ui();
  if (ctx.liveFeed) {
    ctx.goLive(); ctx.pollFailures = 0; ctx.pollStale = false; ctx.lastPollOk = Date.now();
    ctx.connectedStatus(D);
    if (!document.hidden) ctx.pollTimer = setTimeout(ctx.pollEvents, 10000);
  } else { ctx.reset(D.meta.from_); ctx.connection('Replay file', 'file'); }
  if (!document.hidden) raf = requestAnimationFrame(loop);
  } catch (e) { ctx.connection('Unable to load data · reload to retry', 'offline'); }
}

// ---------- render ----------
let raf = null;
function loop(ts) {
  raf = null;
  if (document.hidden) return;
  const dt = Math.min(.05, (ts - (loop.last || ts)) / 1000); loop.last = ts;
  ctx.update(dt); ctx.renderInspection(); ctx.followCharacter(dt); ctx.draw(); ctx.hud(dt);
  raf = requestAnimationFrame(loop);
}

const bind = api => Object.defineProperties(ctx, Object.getOwnPropertyDescriptors(api));
bind({
  get $(){return $},
  get cv(){return cv},
  get cx(){return cx},
  get DPR(){return DPR},
  get UI(){return UI},
  get calm(){return calm}, set calm(v){calm=v},
  get img(){return img},
  get MON2(){return MON2}, set MON2(v){MON2=v},
  get MMETA2(){return MMETA2}, set MMETA2(v){MMETA2=v},
  get SPRV(){return SPRV}, set SPRV(v){SPRV=v},
  get D(){return D}, set D(v){D=v},
  get W(){return W}, set W(v){W=v},
  get BG(){return BG}, set BG(v){BG=v},
  get SPR(){return SPR}, set SPR(v){SPR=v},
  get MONS(){return MONS}, set MONS(v){MONS=v},
  get MONMETA(){return MONMETA}, set MONMETA(v){MONMETA=v},
  get BLD(){return BLD}, set BLD(v){BLD=v},
  get MIMG(){return MIMG}, set MIMG(v){MIMG=v},
  get HMETA(){return HMETA}, set HMETA(v){HMETA=v},
  get boot(){return boot}, set boot(v){boot=v},
  get raf(){return raf}, set raf(v){raf=v},
  get loop(){return loop}, set loop(v){loop=v}
});
ctx.services = {};
ctx.services.geometry = globalThis.HQModules.createGeometry(ctx);
bind(ctx.services.geometry);
ctx.services.appearance = globalThis.HQModules.createAppearance(ctx);
bind(ctx.services.appearance);
ctx.services.state = globalThis.HQModules.createState(ctx);
bind(ctx.services.state);
ctx.services.actions = globalThis.HQModules.createActions(ctx);
bind(ctx.services.actions);
ctx.services.combat = globalThis.HQModules.createCombat(ctx);
bind(ctx.services.combat);
ctx.services.social = globalThis.HQModules.createSocial(ctx);
bind(ctx.services.social);
ctx.services.simulation = globalThis.HQModules.createSimulation(ctx);
bind(ctx.services.simulation);
ctx.services.render = globalThis.HQModules.createRenderer(ctx);
bind(ctx.services.render);
ctx.services.ui = globalThis.HQModules.createGameUI(ctx);
bind(ctx.services.ui);
ctx.services.history = globalThis.HQModules.createHistory(ctx);
bind(ctx.services.history);
ctx.services.transport = globalThis.HQModules.createTransport(ctx);
bind(ctx.services.transport);
ctx.state = ctx.S; ctx.camera = ctx.cam;
// Keep live payloads off DOM/storage. These references are for isolated tests;
// the browser only publishes them when its harness explicitly opts in.
const facade = {
  $, ACTIONS: ctx.ACTIONS, DPR, S: ctx.S, STRIDE: ctx.STRIDE, UI, WALK_V: ctx.WALK_V, cam: ctx.cam, cv, cx, eventKeys: ctx.eventKeys, inspect: ctx.inspect,
  captainId: ctx.captainId, cloneState: ctx.cloneState,
  get D(){return D}, set D(v){D=v},
  get W(){return W}, set W(v){W=v},
  get FRIENDS(){return ctx.FRIENDS}, set FRIENDS(v){ctx.FRIENDS=v},
  get HMETA(){return HMETA}, set HMETA(v){HMETA=v},
  get MMETA2(){return MMETA2}, set MMETA2(v){MMETA2=v},
  get MON2(){return MON2}, set MON2(v){MON2=v},
  get SPR(){return SPR}, set SPR(v){SPR=v},
  get SPRV(){return SPRV}, set SPRV(v){SPRV=v},
  get calm(){return calm}, set calm(v){calm=v},
  get checkpoint(){return ctx.checkpoint}, set checkpoint(v){ctx.checkpoint=v},
  get cursor(){return ctx.cursor}, set cursor(v){ctx.cursor=v},
  get following(){return ctx.following}, set following(v){ctx.following=v},
  get hudT(){return ctx.hudT}, set hudT(v){ctx.hudT=v},
  get lastPollOk(){return ctx.lastPollOk}, set lastPollOk(v){ctx.lastPollOk=v},
  get liveFeed(){return ctx.liveFeed}, set liveFeed(v){ctx.liveFeed=v},
  get pollBusy(){return ctx.pollBusy}, set pollBusy(v){ctx.pollBusy=v},
  get pollFailures(){return ctx.pollFailures}, set pollFailures(v){ctx.pollFailures=v},
  get pollStale(){return ctx.pollStale}, set pollStale(v){ctx.pollStale=v},
  get pollTimer(){return ctx.pollTimer}, set pollTimer(v){ctx.pollTimer=v},
  get privacyPending(){return ctx.privacyPending}, set privacyPending(v){ctx.privacyPending=v},
  get raf(){return raf}, set raf(v){raf=v},
  get selectedScene(){return ctx.selectedScene}, set selectedScene(v){ctx.selectedScene=v},
  get apply(){return ctx.apply}, set apply(v){ctx.apply=v},
  get connection(){return ctx.connection}, set connection(v){ctx.connection=v},
  get reset(){return ctx.reset}, set reset(v){ctx.reset=v},
  get ui(){return ctx.ui}, set ui(v){ctx.ui=v},
  boot, characterName: ctx.characterName, chooseCharacters: ctx.chooseCharacters, clearInspection: ctx.clearInspection, click: ctx.click, connectedStatus: ctx.connectedStatus,
  draw: ctx.draw, engage: ctx.engage, eventKey: ctx.eventKey, finishRestMotion: ctx.finishRestMotion, followCharacter: ctx.followCharacter, formation: ctx.formation, friends: ctx.friends,
  goHome: ctx.goHome, goLive: ctx.goLive, hero: ctx.hero, heroDialog: ctx.heroDialog, heroStatus: ctx.heroStatus, hud: ctx.hud, inspectionLinks: ctx.inspectionLinks, json: ctx.json, later: ctx.later,
  laterHero: ctx.laterHero, loadReplay: ctx.loadReplay, loop, mergeDelta: ctx.mergeDelta, monster: ctx.monster, monsterPose: ctx.monsterPose, mstyle: ctx.mstyle, mtier: ctx.mtier, mtype: ctx.mtype,
  normalizeData: ctx.normalizeData, order: ctx.order, overflowed: ctx.overflowed, parentLabel: ctx.parentLabel, plazaOf: ctx.plazaOf, pollEvents: ctx.pollEvents, pollFailed: ctx.pollFailed,
  portal: ctx.portal, px: ctx.px, quest: ctx.quest, regionOf: ctx.regionOf, renderFeed: ctx.renderFeed, renderInspection: ctx.renderInspection, resize: ctx.resize, restLocked: ctx.restLocked,
  say: ctx.say, selectedSession: ctx.selectedSession, showInspection: ctx.showInspection, spawnMonster: ctx.spawnMonster, spotOf: ctx.spotOf, startHangout: ctx.startHangout,
  stepHero: ctx.stepHero, strike: ctx.strike, task: ctx.task, update: ctx.update, view: ctx.view, wake: ctx.wake, walkTo: ctx.walkTo
};
if (autoBoot) {
  if(UI){UI.init();UI.status('Loading activity…','loading');}
  boot();
}
return facade;
}
(globalThis.HQModules ||= {}).createGame = createGame;
if (globalThis.__questAutoBoot !== false) {
  const game = createGame();
  if (window.__questTestGlobals === true) {
    window.__questTest = game;
    for (const name of Object.keys(game)) Object.defineProperty(window, name, {
      configurable: true, get: () => game[name], set: value => {game[name] = value;}
    });
  }
}
