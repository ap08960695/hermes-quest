# Configuration

The extractor (`tools/extract.py`) is configured by a JSON file. Point to it with the `HERMES_QUEST_CONFIG`
environment variable, or with `--config` on the command line. With neither, built-in defaults are used. The
dashboard plugin passes the environment of the dashboard process to the extractor, so set the variable there.

A copy of every option is in [`config.example.json`](../config.example.json).

## Options

| Key | Default | Meaning |
| --- | --- | --- |
| `hermes_home` | `$HERMES_HOME`, else `~/.hermes` (backend: official shared root) | Hermes data directory to read (read-only); an explicit value always wins |
| `profiles` | `"auto"` | `"auto"` uses every directory under `<hermes_home>/profiles`; or a list of profile IDs |
| `captain` | `"auto"` | Profile that creates most cards (shown as the commander), or an explicit profile ID |
| `show_titles` | `false` | Opt in to showing redacted text (see Privacy). Must be a boolean |
| `show_profile_names` | `false` | Server-only presentation permission; a JSON setting cannot enable it. Verified dashboard sessions may display profile/display names independently of task prose |
| `classes` | developer: warrior, tester: ranger, reviewer: paladin, devops and operator: engineer, researcher: mage, analyst: sage | Profile name prefix to hero class. Unmatched profiles become `mage` |
| `regions` | one region per class | Class to home region on the map |
| `stages` | sage and mage: PLAN, warrior: BUILD, ranger: TEST, paladin: REVIEW, engineer: DEPLOY | Class to pipeline stage; unmatched falls back to BUILD |
| `stage_regions` | PLAN: observatory, BUILD: forge, TEST: forest, REVIEW: citadel, DEPLOY: port, VERIFY: forest | Stage to region where its monster fights |

Notes:

- With no explicit `hermes_home`, the dashboard backend uses the installed Hermes
  `get_default_hermes_root` resolver to read the shared board and profile roster.
  Only the root itself or a direct `profiles/<name>` home can select that root;
  unsupported discovery fails closed (HTTP 503), without guessing parent paths.
  The sampler and session-key store use the same resolved home. Existing explicit
  `history_dir` and `botstatus_path` settings still take precedence.
- An explicit Quest `hermes_home` always wins, including a profile-local home.
  Standalone CLI/library extraction keeps `$HERMES_HOME` (or `~/.hermes`) unchanged.

- A key you set replaces the whole default object for that key (the merge is shallow). Include every mapping you
  still need.
- Profile IDs must match `[\w-]+`.
- Mapping keys and values must be identifier strings; invalid types report the option and entry name.
  `stages` values must be PLAN, BUILD, TEST, REVIEW, DEPLOY or VERIFY. `hermes_home` must be a nonempty path string.
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

## Identity and observation payload

Replay and delta responses keep the existing tasks, bots, events and opaque cursor. Additive fields:

- `meta.as_of`: observation time in epoch seconds, not an inferred archive timestamp. Retries keep
  rows/cursor stable but may have a newer observation time. `meta.show_profile_names` records the
  effective server permission; its change alters `config_revision` and requires a replay rebase.
- `tasks[].tombstone`: boolean, true for snapshot `status: "archived"`. The `archived` event kind
  is retained. Apply snapshots only at as-of; before that, history is driven by events. An old retained
  task archived without an event is delivered once as a tombstone before its fingerprint expires.
- `bots[].entity_type`: `profile` for a real profile directory in the configured selection, otherwise
  `actor`. `actor_type` is `profile`, `commenter` or `unknown`. Consumers must not create worker heroes
  for actors or equate profile presence with a running OS process.
- `profile_name`, `display_name`, `pet_name`: nullable strings. Profile/display names require verified
  host session state or provider-verified bearer/cookie credentials. Missing host auth support fails
  closed. Query parameters and caller-supplied auth flags never authorize names. Pet name currently
  remains null (not guessed from a slug or display name). Task prose remains governed by `show_titles`.
- `availability`: `{status, observed_at}` from the bounded bot-status snapshot, using its `updated`
  epoch timestamp. Status is active, limited, waiting-start, unavailable or unknown. Missing/malformed
  observations are unknown/null; source reasons are not sent. This is not historical availability.
- `sessions`: authoritative list for the retained replay window plus ancestors, repeated in deltas;
  consumers replace rather than append it. Each entry contains `session_ref`, `parent_session_ref`,
  opaque `bot`, nullable `task`, `started_at`, nullable `ended_at`, and boolean `is_subagent`.
  Refs are 20 lowercase hex characters: the extractor hash of `[profile_id, session_id]`, truncated
  to 20. Only an actual parent in the same database resolves; missing/cross-profile parents are null,
  and unmapped sessions have null task. Immediate nested parents are preserved. These refs also
  accompany session-derived events; no raw session IDs or lineage ledger enter the cursor.

The renderer must separately reconcile archived snapshots and filter actors. These backend fields alone
do not change historical game rendering. Public demo/default extraction stays pseudonymous.
