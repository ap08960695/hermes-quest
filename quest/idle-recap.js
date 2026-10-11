'use strict';
// Pure models/codecs only. The caller owns localStorage I/O and acknowledgement;
// never acknowledge a scrub/poll before the recap has actually been presented.
// Load history first and pass its eventOrder/eventKey from the SAME game context.
globalThis.QuestIdleRecap = (() => {
  const STORAGE_KEY = 'hermesQuest.idleRecap.seen.v1', LIMIT = 2000;
  const validId = id => typeof id === 'string' && /^e_[0-9a-f]{64}$/.test(id);
  function cleanSeen(ids) {
    if (!Array.isArray(ids) || ids.some(id => !validId(id))) return [];
    return [...new Set(ids)].slice(-LIMIT);
  }
  function decodeSeen(text) {
    try { return cleanSeen(JSON.parse(text)); } catch { return []; }
  }
  const encodeSeen = ids => JSON.stringify(cleanSeen(ids));
  function orderedEvents(events, history) {
    if (typeof history?.eventOrder !== 'function' || typeof history?.eventKey !== 'function')
      throw new TypeError('Recap requires history eventOrder/eventKey');
    const input = Array.isArray(events) ? events : [];
    const valid = input.filter(e => e && validId(e.id) && Number.isFinite(e.t));
    const keys = new Set();
    const rows = [...valid].sort(history.eventOrder).filter(e => {
      const key = history.eventKey(e);
      if (key !== e.id || keys.has(key)) return false;
      keys.add(key); return true;
    });
    return {rows, invalid: !Array.isArray(events) || valid.length !== input.length || valid.some(e => history.eventKey(e) !== e.id)};
  }
  // Persist ONLY opaque event IDs. Old IDs outside the current window stay at
  // the front; known rows are re-ordered by history, including late arrivals.
  function acknowledge(events, seen, history) {
    const {rows} = orderedEvents(events, history), current = new Set(rows.map(e => e.id));
    return [...cleanSeen(seen).filter(id => !current.has(id)), ...current].slice(-LIMIT);
  }
  function weekly(progress) {
    const days = progress?.done_days_7d;
    const known = Number.isSafeInteger(days) && days >= 0 && days <= 7;
    return {status: known ? 'complete' : 'unknown', days: known ? days : null,
      text: known ? `${days} of last 7 days had completed work.` : 'Completed work in the last 7 days: unknown.'};
  }
  function summarize({events, meta, seen, progress} = {}, history) {
    const {rows, invalid} = orderedEvents(events, history), previous = cleanSeen(seen);
    const seenIds = new Set(previous), anchor = rows.find(e => e.id === previous.at(-1));
    // IDs alone cannot prove a visit beyond the retained window or detect source
    // GC. "complete" means this retained replay covers our last seen boundary,
    // NOT a durable/all-time ledger. Unknown totals must never be rendered as 0.
    let reason = !previous.length ? 'no_seen_boundary' : !anchor ? 'boundary_not_retained' : null;
    if (invalid) reason = 'invalid_event_identity';
    else if (rows.length > LIMIT) reason = 'retention_limit';
    else if (!Number.isFinite(meta?.from_) || !Number.isFinite(meta?.as_of) || meta.from_ > meta.as_of ||
      (anchor && (meta.from_ > anchor.t || anchor.t > meta.as_of)) ||
      rows.some(e => e.t < meta.from_ || e.t > meta.as_of)) reason = 'unknown_window';
    const unseen = rows.filter(e => !seenIds.has(e.id));
    const observed = {completed: 0, blocked: 0, failed: 0};
    for (const e of unseen) if (Object.hasOwn(observed, e.kind)) observed[e.kind]++;
    const complete = reason === null;
    return {coverage: complete ? 'complete' : 'unknown', reason,
      counts: complete ? {...observed} : {completed: null, blocked: null, failed: null},
      // Diagnostic retained-event counts, not missing-history totals or rewards.
      observed, eventIds: unseen.map(e => e.id).slice(-LIMIT),
      text: complete ? `${observed.completed} completed, ${observed.blocked} blocked, ${observed.failed} failed since your last visit.`
        : 'Work since your last visit: unknown. History does not cover the full visit.',
      weekly: weekly(progress)};
  }
  return Object.freeze({STORAGE_KEY, LIMIT, decodeSeen, encodeSeen, acknowledge, summarize, weekly});
})();
