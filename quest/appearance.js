'use strict';
// Owns appearance; peer bindings stay live on the per-game context. Registration never boots.
(globalThis.HQModules ||= {}).createAppearance = function createAppearance(ctx) {
const STAGES = ['PLAN', 'BUILD', 'TEST', 'REVIEW', 'DEPLOY', 'VERIFY'];
const STAGE_TH = {PLAN: 'Plan', BUILD: 'Build', TEST: 'Test', REVIEW: 'Review', DEPLOY: 'Deploy', VERIFY: 'Verify'};
const MON = {PLAN: 'ghost', BUILD: 'golem', TEST: 'slime', REVIEW: 'bat', DEPLOY: 'skeleton', VERIFY: 'mimic'};
const CLS_HUE = {warrior: 0, ranger: 95, paladin: 45, engineer: 25, mage: 220, sage: 140, commander: 250};
const WALLET = {claude: ['CLAUDE', '#4aa3ff'], codex: ['CODEX', '#58c27a'], agy: ['GEMINI', '#b07cff']};
const HERO_H = 64, STRIDE = 24, WALK_V = 70;          // design units (2 per native px); walk speed per real second
const TOOL_ICON = {read_file: '📜', search_files: '🔍', vision_analyze: '👁', write_file: '✒', kanban_comment: '🕊',
  kanban_heartbeat: '♪', kanban_show: '📋', delegate_task: '🦊', web_search: '🔮'};
const CAT_ICON = {test: '🏹', build: '🔥', deploy: '🎈', git: 'ᚱ', probe: '🔮', shell: '⚙'};
const ease = t => t < .5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
const lerp = (a, b, t) => a + (b - a) * t;
// ---------- monsters: born in a lair, wait at the war camp, march along trails/roads to the town ----------
const MTYPE = {PLAN: 'ghost', BUILD: 'golem', TEST: 'slime', REVIEW: 'bat', DEPLOY: 'skeleton', VERIFY: 'goblin'};
const LAIR_OF = {goblin: 'lair_cave', golem: 'lair_cave', slime: 'lair_swamp', ghost: 'lair_ruins', bat: 'lair_ruins', skeleton: 'lair_ruins'};
function mtype(t) { const k = MTYPE[t.stage] || 'goblin'; return k === 'golem' && (t.max_rt || 1800) <= 1200 ? 'goblin' : k; }
function mtier(t) { const r = t.max_rt || 1800; return t.chained ? 'l' : r <= 1200 ? 's' : r <= 2400 ? 'm' : 'l'; }
// Model = element, colour and attack speed; effort = charge time, hit power and crit chance (from each bot's
// config.yaml: model.default + agent.reasoning_effort, or the effort suffix in the model id).
const MODEL_STYLE = [
  ['opus', {tag: 'Opus', el: 'holy', color: '#ffd36b', glow: '#fff6c8', speed: .85}],
  ['fable', {tag: 'Fable', el: 'holy', color: '#ffb36b', glow: '#ffffff', speed: .85}],
  ['sonnet', {tag: 'Sonnet', el: 'arcane', color: '#b07cff', glow: '#eadcff', speed: 1}],
  ['haiku', {tag: 'Haiku', el: 'wind', color: '#9fe8ff', glow: '#ffffff', speed: 1.45}],
  ['sol', {tag: 'Sol', el: 'fire', color: '#ff8a3a', glow: '#ffe0a0', speed: 1.1}],
  ['luna', {tag: 'Luna', el: 'frost', color: '#bcd4ff', glow: '#ffffff', speed: 1.25}],
  ['astra', {tag: 'Astra', el: 'star', color: '#7fe0ff', glow: '#ffffff', speed: .9}],
  ['gemini', {tag: 'Gemini', el: 'storm', color: '#ffe85a', glow: '#fffbe0', speed: 1.35}]];
const NO_STYLE = {tag: '?', el: 'none', color: '#cfd8ea', glow: '#ffffff', speed: 1};
function mstyle(model) { const m = (model || '').toLowerCase(); return (MODEL_STYLE.find(([k]) => m.includes(k)) || [0, NO_STYLE])[1]; }
const EFF = {low: {charge: .03, mult: .8, crit: .02}, medium: {charge: .1, mult: 1, crit: .06}, high: {charge: .25, mult: 1.3, crit: .14},
  xhigh: {charge: .4, mult: 1.6, crit: .22}, max: {charge: .55, mult: 1.9, crit: .3}};
const EL_PARTICLE = {fire: ['#ff8a3a', -1], frost: ['#e6f0ff', 1], storm: ['#ffe85a', 0], holy: ['#fff6c8', -1], arcane: ['#c8a0ff', -1], wind: ['#bff4ff', 0], star: ['#a8ecff', -1]};
// attack range per class (px between hero and monster): melee classes close in, casters/archers keep distance
const RANGE = {warrior: 46, paladin: 52, engineer: 96, sage: 132, mage: 150, ranger: 176, commander: 64};
// Effort = level. medium: plain. high: glowing 1px outline. xhigh: + halo. max: + wings of light and rising motes.
const LEVEL = {low: 0, medium: 0, high: 1, xhigh: 2, max: 3};
return {
  get STAGES(){return STAGES},
  get STAGE_TH(){return STAGE_TH},
  get MON(){return MON},
  get CLS_HUE(){return CLS_HUE},
  get WALLET(){return WALLET},
  get HERO_H(){return HERO_H},
  get STRIDE(){return STRIDE},
  get WALK_V(){return WALK_V},
  get TOOL_ICON(){return TOOL_ICON},
  get CAT_ICON(){return CAT_ICON},
  get ease(){return ease},
  get lerp(){return lerp},
  get MTYPE(){return MTYPE},
  get LAIR_OF(){return LAIR_OF},
  get mtype(){return mtype}, set mtype(v){mtype=v},
  get mtier(){return mtier}, set mtier(v){mtier=v},
  get MODEL_STYLE(){return MODEL_STYLE},
  get NO_STYLE(){return NO_STYLE},
  get mstyle(){return mstyle}, set mstyle(v){mstyle=v},
  get EFF(){return EFF},
  get EL_PARTICLE(){return EL_PARTICLE},
  get RANGE(){return RANGE},
  get LEVEL(){return LEVEL}
};
};
