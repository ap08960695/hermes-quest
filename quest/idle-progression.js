/* Guild milestones (level 2/3/5). Pure functions only: no DOM, storage, time, randomness or UI wiring. Classic script; MIT.
 *
 * Input is the existing `working.progress` object (level/xp/...) plus the optional backend `career_xp`.
 * Two paths, chosen only by whether a valid `career_xp` is present:
 *   - no valid career_xp -> mode 'board': milestones are "reached on this board" from the current level.
 *     They follow the current done snapshot, so they can change if tasks are archived or reopened. Copy never
 *     says the progress is kept for good.
 *   - valid career_xp (monotonic, non-negative safe integer from the backend) -> mode 'permanent'.
 * Neither a valid level nor a valid career_xp -> mode 'unknown': every milestone is null (not false).
 * Nothing here counts anything itself, and no browser/server ledger is kept.
 */
(function(root) {
  'use strict';
  // Same constant as the backend/reducer formula (level = 1 + floor(XP / 100)); XP are in-game points.
  const XP_PER_LEVEL = 100;
  const MILESTONE_LEVELS = Object.freeze([2, 3, 5]);
  const isCount = v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  const isLevel = v => isCount(v) && v >= 1;
  const xpFor = level => (level - 1) * XP_PER_LEVEL;
  const levelFor = xp => 1 + Math.floor(xp / XP_PER_LEVEL);
  const COPY = Object.freeze({
    board: Object.freeze({
      reached: 'Reached on this board', pending: 'Not reached yet', unknown: 'Unknown',
      note: 'Based on the completed work currently on this board. It can change if tasks are archived or reopened.'}),
    permanent: Object.freeze({
      reached: 'Earned', pending: 'Not earned yet', unknown: 'Unknown',
      note: 'Based on lifetime completed work recorded by the backend.'}),
    unknown: Object.freeze({
      reached: 'Unknown', pending: 'Unknown', unknown: 'Unknown',
      note: 'Guild progress is not available yet.'})
  });

  function resolve(progress) {
    const p = progress !== null && typeof progress === 'object' ? progress : {};
    if (isCount(p.career_xp)) return {mode: 'permanent', level: levelFor(p.career_xp), xp: p.career_xp};
    if (isLevel(p.level)) return {mode: 'board', level: p.level, xp: isCount(p.xp) ? p.xp : null};
    return {mode: 'unknown', level: null, xp: null};
  }

  // evaluate(progress) -> {mode, level, xp, milestones[], next, reached_count, total, note}
  //   milestones[i] = {id, level, xp_required, reached: true|false|null, status, label}
  //   next = first milestone not reached (with levels_remaining and xp_remaining|null), or null
  function evaluate(progress) {
    const r = resolve(progress), copy = COPY[r.mode];
    const milestones = MILESTONE_LEVELS.map(level => {
      const reached = r.level === null ? null : r.level >= level;
      return {id: 'guild-level-' + level, level, xp_required: xpFor(level), reached,
        status: reached === null ? 'unknown' : reached ? 'reached' : 'pending',
        label: reached === null ? copy.unknown : reached ? copy.reached : copy.pending};
    });
    const nextRow = r.level === null ? null : milestones.find(m => !m.reached) ?? null;
    return {
      mode: r.mode, level: r.level, xp: r.xp, milestones,
      next: nextRow && {...nextRow, levels_remaining: nextRow.level - r.level,
        xp_remaining: r.xp === null ? null : Math.max(0, nextRow.xp_required - r.xp)},
      reached_count: r.level === null ? null : milestones.filter(m => m.reached).length,
      total: milestones.length, note: copy.note};
  }

  const api = {XP_PER_LEVEL, MILESTONE_LEVELS, COPY, evaluate};
  root.QuestIdleProgression = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window === 'object' ? window : globalThis);
