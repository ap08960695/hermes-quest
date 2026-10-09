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

- `data/replay.json`, `preview/`, `assets/raw/`: git-ignored; contain data derived from real activity.
- Screenshots or GIFs taken from real data. Use the synthetic demo (`data/demo.json`) for any public image.
- The plugin API inherits the dashboard's authentication. Do not expose the dashboard or a plain static server
  holding private replay files to untrusted networks.
