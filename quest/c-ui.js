/* Token ledger and bot-level rest transitions. Classic script factory; MIT. */
(function(root) {
  'use strict';
  function create() {
    const CAPACITY = 100000;
    const wallets = ['claude', 'codex', 'agy'];
    const entry = () => ({net: 0, hasCharsEstimate: false, hasUsageCorrection: false});
    const empty = () => ({tokenNetByBot: {}, tokenNetByWallet: Object.fromEntries(wallets.map(w => [w, entry()])), diagnostics: {}});
    const project = net => Math.max(0, Math.min(100, 100 - Math.max(0, net) / (CAPACITY / 100)));
    function reduceMana(state, event, wallet) {
      if (!event.bot || !Number.isSafeInteger(event.tokens) || (event.tokens < 0 && event.correction !== true)) return 'Invalid token event ignored';
      if (!event.tokens) return null;
      const bot = state.tokenNetByBot[event.bot] || entry(), known = wallets.includes(wallet);
      const total = known ? state.tokenNetByWallet[wallet] : null;
      // Reject unsafe aggregate arithmetic too; never install a partially updated ledger.
      if (!Number.isSafeInteger(bot.net + event.tokens) || (total && !Number.isSafeInteger(total.net + event.tokens))) return 'Unsafe token total ignored';
      state.tokenNetByBot[event.bot] = bot;
      for (const value of [bot, total].filter(Boolean)) {
        value.net += event.tokens;
        value.hasCharsEstimate ||= event.basis === 'chars';
        value.hasUsageCorrection ||= event.basis === 'usage' && event.correction === true;
      }
      if (known) state.mana[wallet] = project(total.net);
      return null;
    }
    function transitionRest(previous, kind, options = {}) {
      const old = previous || {state: 'active-unobserved', generation: 0, savedTask: null};
      const active = kind === 'resume';
      return {state: active ? 'active' : kind === 'failover' ? 'transferred' : 'paused',
        why: active ? '' : options.why || 'unavailable',
        savedTask: options.savedTask ?? old.savedTask, target: options.target ?? old.target ?? null,
        generation: old.generation + 1, slot: active ? null : options.slot ?? old.slot ?? null,
        phase: active ? 'returning' : 'moving', observed: options.observed ?? true};
    }
    return {CAPACITY, empty, project, reduceMana, transitionRest};
  }
  const api = {create};
  root.QuestCUI = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window === 'object' ? window : globalThis);
