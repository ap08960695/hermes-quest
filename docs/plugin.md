# Dashboard plugin

The repository root is a Hermes dashboard plugin named `hermes-quest`:

- `plugin.yaml` and `__init__.py` register a dashboard-only plugin (no tools, hooks or middleware).
- `dashboard/manifest.json` declares the tab (`/hermes-quest`), the UI bundle `dashboard/dist/index.js` and the
  API file `dashboard/plugin_api.py`.
- The tab embeds `/api/plugins/hermes-quest/static/index.html?live=1`.

## Install

Keep the repository layout intact: the API resolves the game, assets and extractor relative to the parent of
`dashboard/`.

```bash
export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"   # the home that runs the dashboard
mkdir -p "$HERMES_HOME/plugins"                       # absent on a fresh home
ln -s "$(pwd)" "$HERMES_HOME/plugins/hermes-quest"    # run from the repository root
hermes plugins enable hermes-quest --no-allow-tool-override
# then restart the existing dashboard
```

Enable it only in the Hermes home whose dashboard should show the tab. `HERMES_HOME` must point at that home;
if it is unset the link would target `/plugins`, which is why the snippet defaults it to `~/.hermes`.

## API

Mounted at `/api/plugins/hermes-quest/`, GET only, inheriting dashboard authentication. `replay` and `events` responses are never cached. Static files differ:
`index.html`, `game.js` and `npcs.js` are `no-store`, while PNG/JSON under `static/` are sent with
`Cache-Control: public, max-age=60`.

- `replay?hours=<n>`: snapshot with `meta`, `bots`, `tasks`, `events` and an opaque `cursor`. `hours` must be
  greater than 0 and at most 168; default 12.
- `events?since=<cursor>`: events and changed tasks/bots since the cursor, plus a new cursor. Pass cursors back
  unchanged. They can be several KiB long; the limit is 32 KiB. An empty cursor starts a fresh read.
- `static/<path>`: only `index.html`, `game.js`, `npcs.js`, `data/world.json`, `assets/sprites/monsters.json` and
  non-hidden PNG/JSON files under `assets/px/`. Everything else, traversal and symlinks return 404.

Extraction runs in a separate bounded process (30 s timeout). Failures return a generic 503 without paths or
database details.

## Behaviour in the browser

`live=1` makes the game fetch the replay and poll `events` every 10 seconds (one request at a time). New events
are merged into the replay history so you can scrub back to them. The history is bounded to the latest 2,000
events (`HISTORY_LIMIT` in `game.js`); older events are dropped and a scrub earlier than the oldest retained event
is clamped to it. If the connection drops the status badge
says so and polling continues.
