/* Guildhall tier model. Classic script factory; MIT.
 *
 * Pure and deterministic: Guild level in -> what the Guildhall should look like out.
 * No DOM, canvas, clock, RNG, storage or game state; it never mutates world/entity data.
 * Not wired into index.html on purpose: the integration card owns loading and drawing.
 *
 * Contract
 *   tierForLevel(level)   level must be a non-negative safe integer. Anything else
 *                         (null, undefined, NaN, strings, floats, negatives) is UNKNOWN and
 *                         never gets a guessed tier. Level 0 is known but below the first tier.
 *   guildhallModel(level, props?)  view model: tier, labels, and decorations to draw.
 *
 * Tiers (thresholds are fixed, they do not grow with time and never go down by themselves):
 *   tier 1 at level 1  - the Guildhall as painted today (no decoration)
 *   tier 2 at level 5  - banners flank the hall
 *   tier 3 at level 10 - banners, pillars and lamps
 *
 * Decorations only name sprites that already exist under assets/px (props/banner, props/pillar,
 * props/lamp). Offsets are in world pixels from the hall's anchor (horizontal centre, bottom edge
 * of the `castle` building prop). They are a proposal for the integrator to tune in playtest.
 */
(function(root) {
  'use strict';
  const TITLE = 'Guildhall';
  const ANCHOR = Object.freeze({src: 'buildings', img: 'castle'});
  const freeze = o => Object.freeze(o);
  const deco = (img, dx, dy) => freeze({src: 'props', img, dx, dy});
  // Cumulative: each tier lists only what it adds over the previous one.
  const TIERS = freeze([
    freeze({tier: 1, min_level: 1, name: 'Guildhall', adds: freeze([])}),
    freeze({tier: 2, min_level: 5, name: 'Guildhall with banners', adds: freeze([
      deco('banner', -140, 0), deco('banner', 140, 0)])}),
    freeze({tier: 3, min_level: 10, name: 'Grand Guildhall', adds: freeze([
      deco('pillar', -105, 6), deco('pillar', 105, 6), deco('lamp', -175, 4), deco('lamp', 175, 4)])})
  ]);
  const isLevel = v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

  function tierForLevel(level) {
    if (!isLevel(level)) return freeze({known: false, level: null, tier: null, reason: 'unknown-level'});
    let tier = null;
    for (const t of TIERS) if (level >= t.min_level) tier = t;
    return freeze({known: true, level, tier: tier ? tier.tier : null, reason: tier ? 'ok' : 'below-first-tier'});
  }

  // Everything drawn at `tier`, in tier order (so lower tiers keep their decorations).
  function decorationsForTier(tier) {
    if (!Number.isInteger(tier)) return freeze([]);
    return freeze(TIERS.filter(t => t.tier <= tier).flatMap(t => t.adds));
  }

  // Read-only lookup of the building the hall is drawn on. Returns null if absent; never creates one.
  function findAnchor(props) {
    if (!Array.isArray(props)) return null;
    const p = props.find(x => x && x.src === ANCHOR.src && x.img === ANCHOR.img);
    return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? freeze({x: p.x, y: p.y, w: p.w, h: p.h}) : null;
  }

  function guildhallModel(level, props) {
    const r = tierForLevel(level);
    const anchor = findAnchor(props);
    if (!r.known) return freeze({title: TITLE, known: false, tier: null, tier_count: TIERS.length, level: null, anchor,
      label: TITLE + ' \u00b7 Level unknown', detail: 'Guild level is not available yet.',
      next_level: null, decorations: freeze([])});
    const cur = r.tier ? TIERS[r.tier - 1] : null, next = TIERS[r.tier ?? 0] || null;
    return freeze({title: TITLE, known: true, tier: r.tier, tier_count: TIERS.length, level: r.level, anchor,
      tier_name: cur ? cur.name : null,
      label: TITLE + ' \u00b7 Level ' + r.level,
      detail: cur ? 'Tier ' + r.tier + ' of ' + TIERS.length + (next ? ' \u00b7 next tier at Guild level ' + next.min_level : ' \u00b7 final tier')
        : 'No tier yet \u00b7 first tier at Guild level ' + TIERS[0].min_level,
      next_level: next ? next.min_level : null,
      decorations: decorationsForTier(r.tier)});
  }

  const api = freeze({TITLE, ANCHOR, TIERS, tierForLevel, decorationsForTier, findAnchor, guildhallModel});
  root.QuestIdleCity = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window === 'object' ? window : globalThis);
