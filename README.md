# Hermes Quest

A pixel-art fantasy RPG that turns the work of a [Hermes Agent](https://github.com/NousResearch/hermes-agent)
kanban board into a living game world. Your bots become heroes, your cards become monsters, and real activity
(patches, tests, builds, deploys) drives the fights.

<!-- screenshot: synthetic demo -->
![Hermes Quest town overview (synthetic demo)](docs/screenshots/overview.png)

Hermes Quest is read-only. It never writes to your Hermes data and never modifies cards. It runs either as a
standalone page with synthetic demo data or as a Hermes dashboard plugin fed by your real board.

## Features

- 21 hero sprite sheets, one per class x model combination. The class comes from the bot's role
  (warrior, ranger, paladin, engineer, mage, sage, plus the Captain as commander). The look and element come from
  the model family (Sol, Luna, Sonnet, Opus, Haiku, Gemini, and so on). Reasoning effort sets the hero's level.
- Monsters. Each card is a monster whose type follows its pipeline stage (plan, build, test, review, deploy,
  verify). It leaves a lair, waits at the war camp and marches into town when the Captain assigns a hero.
- Fights driven by activity. Patches, tests, builds and deploys are attacks. Failed commands make the monster hit
  back. Context compression makes the hero meditate. Subagents appear as familiars.
- Villagers. Porters, farmers, children and guards wander the town. They are decorative only.
- Idle heroes socialise with the bots they work with, chat and cheer completions.
- Live mode (dashboard plugin) polls for new events about every 10 seconds.
- Replay. A time bar with play/pause and 30x / 120x / 600x speeds lets you scrub the loaded window. Events
  received live are merged into the replay history, which keeps at most the latest 2,000 events; scrubbing to a
  time older than that is clamped to the oldest retained event. A LIVE button jumps back to now.
- Mobile friendly. The canvas supports drag to pan, tap to zoom into a town and tap a monster for its quest
  card. Small screens get tabbed campaign and chronicle panels.
- A "reduce effects" button turns off screen shake and flashes.

<!-- screenshot: synthetic demo -->
![A hero fighting a monster (synthetic demo)](docs/screenshots/battle.png)

<!-- screenshot: synthetic demo -->
![Replay controls and campaign panel (synthetic demo)](docs/screenshots/replay.png)

<!-- screenshot: synthetic demo -->
![Mobile layout (synthetic demo)](docs/screenshots/mobile.png)

![A short town and battle replay (synthetic demo)](docs/screenshots/demo.gif)

## Quick start: standalone demo

Requires Python 3 and any modern browser. The demo uses fully synthetic data in `data/demo.json` and needs no
Hermes installation.

```bash
git clone <this repository> hermes-quest
cd hermes-quest
python3 -m http.server 0 --bind 127.0.0.1   # prints the port it picked
```

Open the printed `http://127.0.0.1:<port>/` address. To pick a fixed port use for example
`python3 -m http.server 8765 --bind 127.0.0.1`. Bind to loopback only.

Standalone always loads `data/demo.json`, even if a private replay exists. To
inspect a private local replay explicitly, use `?data=data/replay.json` or
`node tools/backtest.js --data data/replay.json`. Do not expose a directory
containing private replay files beyond loopback. The dashboard plugin instead
loads the authenticated live API and polls every 10 seconds; it does not serve
private replay files. Extraction paths and mappings are configured through
`HERMES_QUEST_CONFIG` (see `config.example.json`); titles are hidden by default.
After upgrading from older profile-ID payloads, reload the Quest tab once:
client state is memory-only, replay requests bypass cache, and a changed effective
configuration (including automatic Captain, mappings and title privacy) during
polling triggers a clean transactional snapshot without old feed/effects.

## Title privacy (`show_titles`)

`show_titles` defaults to `false`: no upstream free-form text is displayed.
Setting it to `true` is an opt-in safeguard against accidental disclosure, not
protection against adversarial text. Sensitive-label matches, source brackets
(`[` or `]`), or risky punctuation remaining after span redaction (such as `:`
or `/`) hide the entire text as `[redacted]`. Generated redaction placeholders
do not trigger the source-bracket check. Labels use
NFKD → casefold → NFKD, retaining only letters/numbers, so combining marks and
punctuation cannot split labels. Matching can span words; most real card titles
will be `[redacted]`. Ordinary titles can still display.

Non-decomposable homoglyphs (e.g. Cyrillic `а` instead of Latin `a`) are outside
this opt-in threat model. Keep the default for screenshots or shared views;
never publish live data or screenshots. See also [adapter configuration](dashboard/README.md).

To regenerate the deterministic synthetic demo: `python3 tools/mock.py`.
See [docs/configuration.md](docs/configuration.md) for extraction options.

Controls: drag to pan, mouse wheel to zoom, click a town to zoom in, click a monster for its quest card.

## Quick start: Hermes dashboard plugin

The repository root is the plugin. It adds a "Hermes Quest" tab to the Hermes dashboard and registers no agent
tools or hooks. It does not open its own server.

```bash
# the Hermes home that runs the dashboard (default ~/.hermes); set it explicitly if yours differs
export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
mkdir -p "$HERMES_HOME/plugins"      # a fresh home has no plugins/ directory yet
ln -s "$(pwd)" "$HERMES_HOME/plugins/hermes-quest"   # run from the repository root
hermes plugins enable hermes-quest --no-allow-tool-override
# restart the running dashboard so it picks up the tab and API
```

The plugin serves a small read-only API beneath `/api/plugins/hermes-quest/`, behind the dashboard's own
authentication:

| Route | Purpose |
| --- | --- |
| `GET /replay?hours=12` | Snapshot of the last N hours (0 < hours <= 168, default 12) |
| `GET /events?since=<cursor>` | Only events newer than an opaque cursor, polled about every 10 s |
| `GET /static/...` | Allow-listed game files only (`index.html`, `game.js`, `npcs.js`, `data/world.json`, sprite metadata, PNG/JSON under `assets/px/`) |

Details, limits and error behaviour are in [docs/plugin.md](docs/plugin.md).

## Configuration

Set `HERMES_QUEST_CONFIG` to the path of a JSON file. It is read by the extractor, both from the plugin and from
the command line. See [`config.example.json`](config.example.json) and [docs/configuration.md](docs/configuration.md).

```json
{
  "hermes_home": "~/.hermes",
  "profiles": "auto",
  "captain": "auto",
  "show_titles": false,
  "classes": {"developer": "warrior", "tester": "ranger", "reviewer": "paladin"},
  "regions": {"warrior": "forge", "ranger": "forest", "paladin": "citadel"}
}
```

Profiles, the Captain, profile-to-class, class-to-region, stage mappings and title display are all configurable;
nothing is tied to a particular home directory or profile name.

## Privacy

Hermes Quest is designed so the default output is safe to screenshot.

- Free text is not exported by default. Card titles, comments and bot names are replaced by generated labels
  (for example `Quest #12 · BUILD`); bot and task identifiers are hashed; model names are reduced to a family.
- Text fields come from fixed enumerations. Anything unknown becomes `unknown`.
- Memory activity is counted and shown as a gesture. The extractor projects tool identities from session
  transcripts without materializing memory query/result prose. It does not open any memory store.
- If you opt in with `"show_titles": true`, text still passes through redaction that masks URLs, IP addresses,
  absolute paths, customer or account IDs, secrets and tokens, and replaces suspicious tokens with `[redacted]`.
  Sensitive labels or residual risky punctuation hide the whole text. This guards accidental disclosure,
  not adversarial non-decomposable homoglyphs; keep the default for shared views.
- Real replay files (`data/replay.json`), `preview/` and `assets/raw/` are git-ignored. Do not publish
  screenshots made from real data.

See [docs/privacy.md](docs/privacy.md) for the full list.

## Development

```bash
python3 tools/check_public.py          # tracked-tree privacy/release gate; must print PASS
node tools/backtest.js                 # headless motion/action/social gate over data/demo.json; must print PASS
python3 -m unittest discover -s tools -p 'test_*.py'          # extractor tests (synthetic fixtures)
node dashboard/test_game.cjs && node dashboard/test_defaults.cjs   # game/live-poll/default-data tests
python3 -m unittest discover -s dashboard -p 'test_*.py'      # plugin API tests (needs fastapi and httpx)
```

Never loosen a backtest threshold to get green. Sprites and ground are generated with image tooling and converted
to pixel art by `tools/pixelize.py`. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full
release gates and [docs/development.md](docs/development.md) for the asset pipeline.

## Status and limits

- Hermes Quest reads Hermes SQLite state read-only. It targets the Hermes Agent layout (`kanban.db`, per-profile
  `state.db`) and may need updates when that layout changes.
- Art was generated with OpenAI image generation and converted to pixel art. Confirm you are happy with the asset
  terms before redistributing.

## License

MIT — see [LICENSE](LICENSE).
