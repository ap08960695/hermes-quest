# Changelog

All notable changes to Hermes Quest are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and releases follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- UI2: fixed pixel-text HUD and semantic atlas icons, bitmap Thai details,
  mobile-safe panels, cached hurt effects, visibility-aware replay and a
  landscape dashboard iframe that fits the available height.
- C1 backend: token-based mana accounting with a text-size fallback and signed
  corrections, plus read-only botstatus history for pause, resume and failover
  events.
- C-UI: token-based mana percentages against simulated wallet capacity (not real
  quota), signed corrections without double counting, and heroes walking to the
  rest camp on pause/failover and returning on resume.

### Known limitations

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
