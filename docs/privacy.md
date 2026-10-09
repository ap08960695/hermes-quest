# Privacy

The goal is that default output can be screenshotted and shared. This is fail-closed: free text is excluded
unless you opt in.

## Defaults (`show_titles: false`)

- No free text is exported. Card titles become `Quest #<n> · <STAGE>`; comment, subagent and event notes are
  generated from fixed words; bot names are hashed (`bot-<hash>`).
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

The identity scheme and a keyed epoch tag participate in `config_revision`. Legacy
JSON/compact cursors still decode, but pre-HMAC cursors, key rotation or key
loss/restoration reset the retained replay window once. Old pending/ledger hashes
are discarded, including temporarily missing sources. Clients must compare the
revision before applying events and replace replay on a change (the existing game
client does this); never add the reset snapshot's mana to the old epoch. Chaining
the new cursor is incremental again, including signed corrections. No secret or
mapping is stored in the cursor. This deliberately supersedes the old unkeyed
session-reference formula; it is not an authentication or task-prose opt-in change.

- `data/replay.json`, `preview/`, `assets/raw/`: git-ignored; contain data derived from real activity.
- Screenshots or GIFs taken from real data. Use the synthetic demo (`data/demo.json`) for any public image.
- The plugin API inherits the dashboard's authentication. Do not expose the dashboard or a plain static server
  holding private replay files to untrusted networks.
