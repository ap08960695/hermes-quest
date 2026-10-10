'use strict';
// Backend-generated replay/delta snapshots, reduced by the shipped game, not a mock reducer.
const fs = require('node:fs'), path = require('node:path');
const root = process.env.QUEST_ORDER_ROOT || path.resolve(__dirname, '..');
const {load} = require(path.join(root, 'tools/parity/loader.cjs'));
const sample = JSON.parse(fs.readFileSync(0, 'utf8'));
// Capture the real social service on its real game context (not exported by the facade).
const vm = require('node:vm'), createContext = vm.createContext;
let social;
vm.createContext = box => {
  let factory;
  box.HQModules = {};
  Object.defineProperty(box.HQModules, 'createSocial', {
    get: () => ctx => (social = factory(ctx)), set: fn => { factory = fn; }
  });
  return createContext(box);
};
let G;
try { ({G} = load({root, data: sample.replay})); } finally { vm.createContext = createContext; }
G.loadReplay(G.D); G.reset(G.D.meta.to);
G.liveFeed = true; G.following = true; G.S.play = true;
let hooks = 0;
G.S.work.onOrder(() => hooks++);
// Working is an authoritative snapshot, independent of event replay delivery.
// Isolate that contract from late historical events rebuilding resting actors.
for (const delta of sample.deltas) G.mergeDelta({...delta, events: []});
const before = G.S.soc.couriers || 0;
// Exercise the social idempotence guard separately: even bypassing reducer hooks,
// re-delivering a source ref after mutable presentation changes must stay silent.
const current = G.S.work.latestOrder;
social.onOrder({...current, action_label: 'Changed presentation', recipient_display_name: 'Changed alias'});
const duplicateCouriers = (G.S.soc.couriers || 0) - before;
console.log(JSON.stringify({hooks, couriers: before, duplicateCouriers, order: G.S.work.latestOrder}));
