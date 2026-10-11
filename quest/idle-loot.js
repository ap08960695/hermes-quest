'use strict';
// Cosmetic collection derived from the current Working snapshot, never a reward ledger.
// Identity refs are used only for deduplication and never copied into the display model.
(globalThis.HQIdleLoot = (() => {
  const names = [
    ['planning', 'Planning'], ['build', 'Build'], ['testing', 'Testing'],
    ['review', 'Review'], ['deploy', 'Deploy'], ['verification', 'Verification'], ['guild', 'Guild']
  ];
  const catalog = names.map(([quest_kind, name]) => Object.freeze({
    id: 'stage-' + quest_kind, quest_kind, label: name + ' stage token',
    description: 'A cosmetic token for completed work in the ' + name + ' stage.',
    condition: 'Completed work with this stage kind on the current board.'
  }));
  const byKind = new Map(catalog.map(token => [token.quest_kind, token]));
  const isItem = item => item !== null && typeof item === 'object' && !Array.isArray(item);
  const validRef = item => isItem(item) && typeof item.ref === 'string' &&
    item.ref.length > 0 && item.ref.length <= 128 && item.ref.trim() === item.ref;

  // No fallback to stage, title, tool, mana, usage tokens or event timestamps.
  function stageToken(item) {
    if (!validRef(item) || item.status !== 'done') return null;
    return byKind.get(item.quest_kind) ?? null;
  }

  // One collectible design per kind, not a currency/count bonus for task volume.
  // Exact duplicate work rows/polls do not change the result. Conflicting rows for
  // the same ref fail closed rather than depending on arrival order. A new snapshot
  // replaces the old one: archive/reopen is not evidence of a permanent unlock.
  function stageTokens(items) {
    if (!Array.isArray(items)) return [];
    const refs = new Map();
    for (const item of items) {
      if (!validRef(item)) continue;
      const token = stageToken(item);
      if (!refs.has(item.ref)) refs.set(item.ref, token);
      else if (refs.get(item.ref) !== token) refs.set(item.ref, null);
    }
    const unlocked = new Set(refs.values());
    return catalog.filter(token => unlocked.has(token));
  }
  return Object.freeze({stageToken, stageTokens});
})());
