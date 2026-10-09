# Hermes Quest dashboard adapter

The Hermes loader discovers `manifest.json`, serves `dist/index.js`, and mounts
`plugin_api.py` beneath `/api/plugins/hermes-quest`. The bundle uses the host's
React SDK directly; no build or additional dependencies are needed.

The iframe URL is `/api/plugins/hermes-quest/static/index.html?live=1`. The game
must interpret `live=1`, fetch the absolute `/api/plugins/hermes-quest/replay`
endpoint, and poll `/api/plugins/hermes-quest/events?since=<cursor>` every ~10s.
Replay history merging and transport/error status belong to the game, not this
adapter. Standalone demo loading is also owned by the game; `data/demo.json` is
intentionally not served by this live-only API static route.

## Extractor integration

`tools/extract.py` is imported by absolute path in an isolated, bounded subprocess.
The adapter calls the M3 contract:

- `load_config(os.environ.get('HERMES_QUEST_CONFIG') or None)`
- `build_replay(cfg, hours)`
- `collect_since(cfg, cursor)` (initial cursor is `None`)

Payload objects and opaque cursors are passed through without rewriting. Replay
hours are bounded to `(0, 168]`; the default is 12. GET cursors support 32 KiB
(the M3 12-hour cursor can exceed 4 KiB). Responses are not cached.

Modern events now include additive `meta` (the former no-meta delta contract is
superseded): sanitized Captain/mappings/privacy flags and `config_revision`, a
SHA256 of the effective extractor config plus the resolved Captain. Replay has
the same revision, excluding window timestamps. This detects explicit/automatic
Captain changes, source/profile scope, mapping/stage and `show_titles` changes.
No private config values are exported in the revision. The adapter passes it
unchanged. Before accepting a changed revision's rows or cursor, the client loads
a clean authoritative replay, renormalizes entities, silently reconstructs its
playhead and clears old feed/effects/prose. A failed replay preserves the previous
cursor/scene; the next poll retries. Unchanged revisions retain incremental/live
effects behavior. Older clients can ignore additive meta; upgrade/reload once to
enable this migration. SQLite JSON1 (provided by the Hermes runtime) projects
tool identities and only arguments/results with actual classification consumers;
memory query/result prose is not materialized by the extractor.

Until all three functions exist, replay invokes legacy `main()` with `OUT` set
to a temporary file and explicit `HOURS`/`T0`. It never writes the real
`data/replay.json`. Events return an empty array, preserve the requested cursor,
and explicitly identify `state: legacy-fallback` and `meta.incremental: false`.
The legacy snapshot retains legacy privacy behavior: do not treat it as M3-safe
or use it for public screenshots. Import/extraction failures return a generic
503 without stderr, filesystem paths, or database details.

## `show_titles` configuration

Set `show_titles` in the JSON file selected by `HERMES_QUEST_CONFIG` (see
`config.example.json`). The default `false` displays no upstream free-form text.
Opt-in `true` guards against accidental disclosure only: a sensitive label,
source `[`/`]`, or risky punctuation remaining after span redaction (such as
`:` or `/`) replaces the entire text with `[redacted]`, so most real card titles
will be hidden. Generated redaction placeholders do not trigger the source-bracket
check. Label skeletons use
NFKD → casefold → NFKD, keeping letters/numbers and dropping combining marks;
matching can span words. Ordinary titles still display. Non-decomposable
homoglyphs (e.g. Cyrillic `а`) are outside this threat model. Use the default
for screenshots/shared views; never publish live data or screenshots.

## Static boundary

Only `index.html`, `game.js`, `npcs.js`, `data/world.json`, `assets/sprites/monsters.json`,
and non-hidden PNG/JSON files beneath `assets/px/` are served. Missing files,
traversal, symlinks (including links to private files inside the repo), raw
assets, replay files, tools, and other source/configuration paths return 404.
All routes are GET-only and inherit the host's authentication boundary.

Keep the repository layout when installing: the adapter resolves game/assets
and extractor relative to the parent of `dashboard/`. Plugin registration and
enabling in the intended Hermes profile are separate integration steps; this
adapter does not install itself or change host configuration.

For a local checkout, install from the repository root into the Hermes home
that runs the dashboard (`~/.hermes` by default, or the home selected by
`hermes --profile <name>` for a named profile). Resolve and export that home first: an unset
`HERMES_HOME` would link into `/plugins`. A fresh home has no `plugins/`
directory, so create it before linking:

```sh
export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
mkdir -p "$HERMES_HOME/plugins"
ln -s "$(pwd)" "$HERMES_HOME/plugins/hermes-quest"
hermes plugins enable hermes-quest --no-allow-tool-override
```

Then restart the existing dashboard. The same sequence is the canonical
"Quick start: Hermes dashboard plugin" in the root README. The root
`plugin.yaml` and `__init__.py` register the dashboard-only package; the
plugin adds no agent tools or hooks. Do not enable it in a different
profile merely because a coding worker runs there.

## Checks

Use the existing Hermes Python environment (with FastAPI and httpx):

```sh
python -m unittest discover -s dashboard -p 'test_*.py' -v
node --check dashboard/dist/index.js
node dashboard/test_game.cjs
python -m unittest discover -s dashboard -p 'test_live_contract.py' -v
```

Tests extract synthetic fixtures only and cover the modern contract, legacy
isolation, cursor preservation, input limits, sanitized failures, route methods,
and the static allowlist including symlink/traversal denials.
