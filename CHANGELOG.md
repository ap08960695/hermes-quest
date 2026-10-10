# Changelog

All notable changes to Hermes Quest are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and releases follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## v0.1.1 - 2026-10-10

### Security

- Replace guessable session-derived hashes (including mana, subagents and cursor
  pending/compression state) with private-key HMAC references. The API provisions
  a 0600 key in plugin state; extraction stays read-only and fails closed to null
  references when the key is unavailable. Legacy cursor decoding remains supported;
  identity migration/key changes reset the replay epoch once rather than double
  counting old mana. See `docs/privacy.md` for backup, rotation and failure handling.

### Added

- Canvas-first English Menu with Playback, Overview, World and Settings groups,
  expandable summaries and privacy-safe details.
- Expanded scale-C world built from processed pixel assets, a rest camp and
  failover portal, clearer region selection and less crowded standing slots.
- Tap heroes and monsters for details, follow heroes without changing replay
  state, and see parent/session lineage. Oversized poses adjust camera zoom to
  fit the screen with an explicit notice; monster motion is render-only.
- Authenticated Desktop guest transport and bridge with safe static traversal
  and canonical bootstrap HTML. Native Linux gameplay and the Mac SSH backend
  path were verified separately; Mac renderer motion was not measured.
- Truthful archive/actor/session metadata, authenticated profile-name display,
  and a visible degraded-session warning when the private key is unavailable.
- Chromium/Firefox CI smoke, inventory, mobile and scene/hero regressions,
  cursor capacity and Desktop checks, and a post-deploy gate with rollback.
- D2: split the game into classic-script factories with unchanged simulation and
  rendering behavior, exact static/Desktop script ordering, deterministic parity
  checks, and native game-frame performance and hidden-tab measurements.
- Live status warning: after 3 failed polls in a row (about 30 s) or any 4xx response the compact
  indicator shows "Live paused · not updating" with the last successful update time and a short reason
  (sign-in needed, server rejected, server error, offline). Details are in Menu > Overview and the
  Connection details dialog; a polite live region announces the change. One successful poll returns to
  Live; playback, camera and cursor are untouched and no payload, cursor or URL is shown.
- UI2: fixed pixel-text HUD and semantic atlas icons, bitmap Thai details,
  mobile-safe panels, cached hurt effects, visibility-aware replay and a
  landscape dashboard iframe that fits the available height.
- C1 backend: token-based mana accounting with a text-size fallback and signed
  corrections, plus read-only botstatus history for pause, resume and failover
  events.
- C-UI: token-based mana percentages against simulated wallet capacity (not real
  quota), signed corrections without double counting, and heroes walking to the
  rest camp on pause/failover and returning on resume.

### Fixed

- Repair five cropped sprites and cape/boot edges from processed pixel assets;
  keep rest-camp placement off existing roads without removing existing props.
- Make sampler shutdown and history recovery safe for FIFO inputs, torn tails,
  short writes and full Unicode batches; fsync before checkpointing.
- Index Captain tool-call lookups once per session and discover the shared data
  root in profile hosts, avoiding slow extraction and empty Desktop data.
- Preserve fail-closed metadata, update open details after history eviction, and
  keep stale warnings across different failure types until a successful poll.

### Known limitations

- Menu: closing a task/hero detail opened from a collapsed Overview group after a poll evicts that entity may leave keyboard focus on the page body (P2, no data impact).

- Live cursors retain session mana ledgers and task snapshot/delivery metadata
  only for the replay window plus one hour, or while active. Event high-water
  marks and unresolved deliveries are preserved; returning tasks receive their
  snapshot with new events. Returning sessions baseline historical usage rather
  than charge it again; new message tokens and subsequent signed corrections
  remain incremental. If returning usage is unavailable, historical baselining
  waits for usage; earlier new-message estimates are not retroactively corrected.
  Missing profile sources conservatively retain ledgers.
  Legacy cursors without a window use 12 hours. The 32 KiB guard fails closed
  if retained active/recent state still exceeds capacity.

- B/UI2 was tested with Chromium/Firefox emulation only, not physical phones.
- Fractional DPR (such as 2.625) and pinch zoom are measured but not release gates.
- CPU 6x throttling has no acceptance threshold.
- CPU 4x headroom is low; slower machines may miss the performance gates.
- The campaign sword-count field stays blank when its source has no count.
- Older sessions returning to the 12-hour replay window can have different live
  and replay mana totals until reload.
- Usage counters reset to zero are treated as unavailable, so live and replay
  mana totals can differ until reload.

## 0.1.0 - 2026-10-09

### Added

- M1: 21 class/model hero sprite sheets with annotated anatomical head landmarks
  and pixel-art quality checks. AI art generated using Codex.
- M2: native Hermes dashboard plugin, read-only snapshot/incremental APIs,
  live polling about every 10 seconds, replay scrubbing and bounded event history.
- M3: synthetic-only standalone demo, configurable source/profile/class/region
  mappings, hashed live identifiers and hidden free text by default. Optional
  title display uses fail-closed redaction against accidental disclosure.
- M4: animated town villagers and deterministic movement/action/social backtests.
- Mobile controls, activity-driven combat, familiars, HUD and reduced-effects mode.
- Step-by-step plugin installation, configuration, update/removal instructions,
  synthetic screenshots/demo GIF and privacy-aware issue/PR templates.
- MIT license and public tree/history checks with automated regression tests.

### Security

- Live routes inherit dashboard authentication; static serving is allow-listed
  and rejects traversal/symlinks. Private replay/raw assets are excluded.
- No live data or screenshots are published. Opt-in titles are not a defense
  against adversarial text or non-decomposable homoglyphs.
