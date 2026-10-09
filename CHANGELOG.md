# Changelog

All notable changes to Hermes Quest are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and releases follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

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
