# Development

## Layout

- `index.html`, `game.js`: canvas game, HUD, replay controls, live polling
- `npcs.js`: eight decorative villagers, four kinds, independently seeded fixed-step walking
- `data/world.json`: map, towns, roads, props. `data/demo.json`: synthetic demo data
- `tools/extract.py`: read-only Hermes extractor. `tools/mock.py`: demo generator
- `tools/backtest.js`: headless motion/action/social gate
- `dashboard/`, `plugin.yaml`, `__init__.py`: Hermes dashboard plugin
- `assets/px/`: shipped pixel art; `assets/raw/`: raw generated sheets (git-ignored)

## Tests and gates

```bash
python3 tools/check_public.py               # tracked-tree release gate; must print PASS
node tools/backtest.js                       # must print PASS
python3 -m unittest discover -s tools -p 'test_*.py'
node dashboard/test_game.cjs
node dashboard/test_defaults.cjs
node tools/backtest.test.js                  # reproducibility across processes and seeds
python3 tools/qa_heroes.py --all             # audited hero sheets, 21/21 (Pillow/numpy)
python3 -m unittest discover -s dashboard -p 'test_*.py'   # requires fastapi and httpx
```

`backtest.js` runs the real `game.js` logic headless over `data/demo.json` (or `--data <file>`). It checks foot
slide, heroes staying on roads, monsters staying on trails, teleports and that every action and social event
fires. Do not relax thresholds. If it fails, run `DEBUG=1 node tools/backtest.js`, read the hotspots and fix the
shared routine behind them.

The backtest also checks villagers stay on walkable town ground, avoid obstacles, move without teleporting
and repeat the same walk for the same seed. Its game RNG is isolated from the browser and from the NPC RNG.

Before a browser check, serve on loopback (`python3 -m http.server 0 --bind 127.0.0.1`), load the page at zoom 1
and zoom 2-3, and confirm there are no console errors.

## Asset pipeline

1. Prompts live in `tools/gen_*.sh`. They call an image generator. Run image jobs one at a time; parallel runs
   have produced duplicates.
2. Raw sheets go to `assets/raw/`. Convert them with `tools/pixelize.py` (run with `PYTHONPATH=tools`):
   `heroes8`, `combo <class>-<Model>`, `monsters2`, `buildings`, `props`, `lairs`, `variants`.
3. Ground: `tools/lairs.py`, then `tools/terrain.py`, then `tools/place.py`. Rerun all three after editing graph
   or region coordinates in `data/world.json`.
4. Hero sheets: `tools/gen_combos.sh` reads `assets/raw/combos.txt` (one `class-Model` per line), skipping finished
   files; `tools/process_combos.sh` converts each to `assets/px/heroes/<class>-<Model>.png`.
5. If sprite cuts show pieces from the neighbouring cell or rows at different sizes, adjust `sprites.keep_main`
   and the per-group scaling in `pixelize.combo`.

## Before committing

Run `git status` and make sure `data/replay.json`, `preview/`, `assets/raw/` and screenshots from real data are
not staged. Screenshots for the README must come from `data/demo.json`; put them in `docs/screenshots/`.
