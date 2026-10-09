# Configuration

The extractor (`tools/extract.py`) is configured by a JSON file. Point to it with the `HERMES_QUEST_CONFIG`
environment variable, or with `--config` on the command line. With neither, built-in defaults are used. The
dashboard plugin passes the environment of the dashboard process to the extractor, so set the variable there.

A copy of every option is in [`config.example.json`](../config.example.json).

## Options

| Key | Default | Meaning |
| --- | --- | --- |
| `hermes_home` | `$HERMES_HOME`, else `~/.hermes` | Hermes data directory to read (read-only) |
| `profiles` | `"auto"` | `"auto"` uses every directory under `<hermes_home>/profiles`; or a list of profile IDs |
| `captain` | `"auto"` | Profile that creates most cards (shown as the commander), or an explicit profile ID |
| `show_titles` | `false` | Opt in to showing redacted text (see Privacy). Must be a boolean |
| `classes` | developer: warrior, tester: ranger, reviewer: paladin, devops and operator: engineer, researcher: mage, analyst: sage | Profile name prefix to hero class. Unmatched profiles become `mage` |
| `regions` | one region per class | Class to home region on the map |
| `stages` | sage and mage: PLAN, warrior: BUILD, ranger: TEST, paladin: REVIEW, engineer: DEPLOY | Class to pipeline stage; unmatched falls back to BUILD |
| `stage_regions` | PLAN: observatory, BUILD: forge, TEST: forest, REVIEW: citadel, DEPLOY: port, VERIFY: forest | Stage to region where its monster fights |

Notes:

- A key you set replaces the whole default object for that key (the merge is shallow). Include every mapping you
  still need.
- Profile IDs must match `[\w-]+`.
- Valid classes are those with sprites: `warrior`, `ranger`, `paladin`, `engineer`, `mage`, `sage`, `commander`.
  Regions must exist in `data/world.json`.
- The game reads the effective captain, classes, regions and stage regions from the payload's `meta`, so it does
  not hard-code profile or region names.

## Command line

```bash
HERMES_QUEST_CONFIG=./my-config.json python3 tools/extract.py 12 --output /path/outside/repo/replay.json
```

`12` is the number of hours. The default output is `data/replay.json`, which is git-ignored and private. Open it
explicitly with `/?data=data/replay.json`, and do not publish it.

Importing the module reads nothing. The functions used by the plugin are `load_config`, `build_replay(cfg,
hours)` and `collect_since(cfg, cursor)`.
