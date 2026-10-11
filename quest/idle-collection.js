/* Trophy collection built from Guild milestones. Pure functions only: no DOM, storage, time, randomness or UI wiring.
 * Classic script; MIT. Load quest/idle-progression.js first (browser) or let require() find it (tests).
 *
 * One fixed trophy per Guild milestone (levels 2/3/5). A trophy is a view of the milestone result, never a
 * separate counter: same input -> same output, so replay/poll/rebase cannot add or duplicate trophies.
 * Wording follows the progression mode:
 *   board     -> "Reached on this board" (follows the current done snapshot; no claim that it is kept)
 *   permanent -> "Earned" (only when the backend sent a valid career_xp)
 *   unknown   -> "Unknown" (never shown as locked or zero)
 */
(function(root) {
  'use strict';
  const progression = (typeof module === 'object' && module.exports) ? require('./idle-progression.js') : root.QuestIdleProgression;
  if (!progression) throw new Error('quest/idle-progression.js must load before quest/idle-collection.js');
  // Fixed catalog: id matches the milestone id so a trophy can never exist without its milestone.
  const CATALOG = Object.freeze([
    Object.freeze({level: 2, name: 'Guild Recruit', condition: 'Guild reaches level 2'}),
    Object.freeze({level: 3, name: 'Guild Regular', condition: 'Guild reaches level 3'}),
    Object.freeze({level: 5, name: 'Guild Veteran', condition: 'Guild reaches level 5'})
  ]);

  // collection(progress) -> {mode, trophies[], unlocked_count, total, note, next}
  //   trophies[i] = {id, name, condition, unlocked: true|false|null, status, label}
  function collection(progress) {
    const ev = progression.evaluate(progress);
    const trophies = CATALOG.map(c => {
      const m = ev.milestones.find(x => x.level === c.level);
      return {id: 'trophy-' + m.id, name: c.name, condition: c.condition,
        unlocked: m.reached, status: m.status === 'reached' ? 'unlocked' : m.status === 'pending' ? 'locked' : 'unknown', label: m.label};
    });
    const nextTrophy = ev.next && trophies.find(t => t.id === 'trophy-' + ev.next.id);
    return {mode: ev.mode, trophies, unlocked_count: ev.reached_count, total: trophies.length, note: ev.note,
      next: nextTrophy ? {id: nextTrophy.id, name: nextTrophy.name, condition: nextTrophy.condition,
        levels_remaining: ev.next.levels_remaining, xp_remaining: ev.next.xp_remaining} : null};
  }

  const api = {CATALOG, collection};
  root.QuestIdleCollection = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window === 'object' ? window : globalThis);
