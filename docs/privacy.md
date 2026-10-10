# Privacy

The goal is that default output can be screenshotted and shared. This is fail-closed: free text is excluded
unless you opt in.

## Network and telemetry

Hermes Quest does not send data off your machine. It has no telemetry, analytics, crash reporting, update check
or remote logging, and the plugin's runtime code (game page, API, extractor) calls no external service. The
repository's `tools/post_deploy_check.py` is a maintainer script that probes a dashboard URL you give it; it is
not loaded by the plugin. The game page loads files from its own
package and from the dashboard's `/api/plugins/hermes-quest/` routes only; the Desktop guest page is sandboxed
with `connect-src 'none'` and reaches the backend only through the Desktop app's authenticated transport. The
only traffic is between your browser/Desktop app and the Hermes dashboard/backend you already run. Installing
or updating the plugin contacts GitHub or the plugin catalog, which is part of Hermes plugin installation.

## What Quest reads, runs and writes

- Reads, read-only: `kanban.db`, each profile's `state.db`, `config.yaml`, `profile.yaml` and `logs/agent.log`
  under the Hermes home, and `bot-status.json` if present. The extractor opens databases with `mode=ro` and
  `PRAGMA query_only` and does not open any memory store.
- Runs: one bundled Python extractor subprocess per `/replay` or `/events` request (30 second limit), about every
  10 seconds while a Quest tab is open; plus one background thread inside the dashboard process that samples
  `bot-status.json` about every 30 seconds. Set `HERMES_QUEST_SAMPLER=off` to disable the sampler.
- Writes: only the Quest state folder, `<hermes_home>/hermes-quest` (or `history_dir`): `session-ref.key`,
  `botstatus-history.jsonl` with its rotated copies, `state.json` and `.lock`. Quest also stores panel layout in
  your browser's local storage. Nothing else is written.

## Who can see names (`show_titles` and `show_profile_names`)

These are two separate settings.

| Setting | Default | What it controls | Can the JSON file change it? |
| --- | --- | --- | --- |
| `show_titles` | `false` | Free text from cards (titles, notes). Opt-in, redacted. | Yes (boolean) |
| `show_profile_names` | `false` | Profile and display names of bots. | **No.** The plugin API turns it on only for a request carrying a verified dashboard session or provider-verified bearer/cookie; otherwise it stays off. |

So with the default `show_titles: false`, a signed-in dashboard user still sees profile/display names (they are
not card text), while anonymous or unverified output shows `bot-<hash>`. `show_titles` does not hide profile names
and `show_profile_names` does not reveal card text. Pet names are currently always empty. Standalone demo data is
synthetic.

## Defaults (`show_titles: false`)

- No free text is exported. Card titles become `Quest #<n> · <STAGE>`; comment, subagent and event notes are
  generated from fixed words. Bot names are hashed (`bot-<hash>`) unless the request has the profile-name
  permission above.
- Bot, task and author identifiers are replaced by hashes unless they already match a safe ID shape.
- Model names are reduced to a family: `gemini`, `gpt`, `claude` or `unknown`.
- Fields such as status, kind, outcome, tool, effort, wallet and campaign are checked against fixed
  enumerations. Values not in the list become `unknown`.
- Terminal commands are only categorised (test, build, deploy, git, probe, shell). Command text and output are
  not exported.
- Memory tools (lookups, recall) only produce a "memory" gesture. Memory text is not exported (counted only).
  SQLite JSON1 projects tool identities and fields needed for classification from the session transcript
  (`messages` table); memory query/result prose is not materialized. The non-JSON1 fallback preserves the
  same privacy boundary. The extractor does not open or query any memory store.
- Tool arguments are not exported. Patch and write calls report only approximate added/removed line counts.
- Database access is read-only (`mode=ro`, `PRAGMA query_only`).

## What redaction masks (opt-in text)

If you set `"show_titles": true`, text passes through span redaction and fail-closed checks. It masks:

- URLs and hostnames, IPv4 and IPv6 addresses
- absolute file paths (POSIX and Windows)
- customer, client and account IDs, long digit sequences and masked numbers
- secrets, tokens, passwords, API keys, bearer and basic credentials, PEM blocks, long random-looking strings
- email addresses

Sensitive labels, source brackets (`[`/`]`) or risky punctuation remaining after redaction (such as `:` or `/`)
hide the entire text as `[redacted]`. Label matching uses NFKD, strips combining marks before and after
casefold/NFKD, then keeps only letters/numbers. Punctuation and combining marks cannot split a label;
matches can span words, so most real titles will be hidden. Ordinary titles can still display.

Opt-in guards accidental disclosure, not adversarial text: non-decomposable homoglyphs (such as Cyrillic
`а` for Latin `a`) are outside this threat model. Keep `show_titles: false` for screenshots/shared views.
Never publish real replay data or screenshots, even after redaction.

## Things to keep private

### Session references and private key lifecycle

Live `session_ref` and immediate `parent_session_ref` are 20 lowercase hex digits
from domain-separated HMAC-SHA256 of the profile and session ID. An orphan parent
is null. Mana source keys, event IDs derived from those sources, subagent labels,
pending roots and compression session digests use the same keyed identity;
no session-derived unkeyed hash is published in a payload or decoded cursor.
Timestamp-shaped session IDs have little random entropy: an unkeyed hash or public
salt does not protect them from offline guessing, even behind dashboard auth.

The plugin API provisions a random 32-byte `session-ref.key` in its own state
directory (`history_dir`, default `<hermes_home>/hermes-quest`), not in the checkout
or Hermes databases. First provisioning locks the directory, writes a 0600
exclusive temporary file, fsyncs it, then atomically renames and fsyncs the directory.
Existing keys are never automatically replaced, including malformed keys. Keep the
directory private to the service user; share the same directory across API workers.
Never put this key in configuration JSON, environment variables, arguments, logs,
exports, source control, static files or cursors. Back up the file privately with
its ownership and 0600 mode; restore it to retain stable references after reinstall.
Standalone demo/mock data does not read or need a key.

The extractor only reads a regular, service-user-owned, exactly 32-byte 0600 file;
symlinks, FIFOs, unsafe permissions and missing/unreadable keys fail closed. It never
creates a key or writes any database. If provisioning or reading fails, the API
continues returning board data and session rows with null refs. Session-derived
tool/mana/summon/compression events and their ledgers are suppressed, rather than
falling back to a guessable hash. Repair permissions/ownership or restore a private
backup; an intentional key replacement changes identity, not authentication.

Both `/replay` and `/events` include top-level `session_data: {"status": "available", "reason": null}` when the private key is usable, or `{"status": "unavailable", "reason": "key_missing" | "key_unsafe" | "key_provision_failed"}` when it is missing, rejected by the reader, or could not be provisioned. This additive machine-readable diagnostic contains no key, path or raw session ID; HTTP 200 and board data remain usable, bot availability still reflects its own observations, refs stay null and session-derived events/ledgers stay suppressed while unavailable. An empty activity list is therefore not proof of inactivity. The field itself does not change `config_revision` or cursor encoding/state; the existing identity reset on key loss/restoration still applies. Older clients may ignore the diagnostic; displaying a degraded-state warning is a separate renderer change.

The identity scheme and a keyed epoch tag participate in `config_revision`. Legacy
JSON/compact cursors still decode, but pre-HMAC cursors, key rotation or key
loss/restoration reset the retained replay window once. Old pending/ledger hashes
are discarded, including temporarily missing sources. Clients must compare the
revision before applying events and replace replay on a change (the existing game
client does this); never add the reset snapshot's mana to the old epoch. Chaining
the new cursor is incremental again, including signed corrections. No secret or
mapping is stored in the cursor. This deliberately supersedes the old unkeyed
session-reference formula; it is not an authentication or task-prose opt-in change.

### Removing Quest's private state

`hermes plugins remove hermes-quest` deletes the package and its `plugins` entry in `config.yaml`, but it does
**not** delete the Quest state folder, which is the only place Quest keeps data outside the checkout:
`<hermes_home>/hermes-quest` (or your `history_dir`). To purge it: stop the dashboard, then
`rm -r "$HERMES_HOME/hermes-quest"`. If you plan to reinstall, keep `session-ref.key` (0600) and back it up
privately: a new key replaces every session reference once (see above). Also delete the optional Quest config JSON
(`$HERMES_HOME/hermes-quest.json` or the `HERMES_QUEST_CONFIG` path). In Hermes Desktop turn the Desktop switch off
and rescan; the app copy is `$HERMES_HOME/desktop-plugins/hermes-quest` on the computer that runs the app. The
full step list is in the README [Remove](../README.md#remove) section.

- `data/replay.json`, `preview/`, `assets/raw/`: git-ignored; contain data derived from real activity.
- Screenshots or GIFs taken from real data. Use the synthetic demo (`data/demo.json`) for any public image.
- The plugin API inherits the dashboard's authentication. Do not expose the dashboard or a plain static server
  holding private replay files to untrusted networks.
