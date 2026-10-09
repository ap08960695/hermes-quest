# Contributing

Start with the synthetic standalone demo in [README.md](README.md). Python 3 and
Node.js run the checks; sprite checks additionally need Pillow and numpy, and
API tests need FastAPI and httpx. Install these in your own virtual environment:

```sh
python3 -m venv .venv
. .venv/bin/activate
python3 -m pip install Pillow numpy fastapi httpx
```

## Required gates

Run from the repository root, including after staging any new files:

```sh
python3 tools/check_public.py
node tools/backtest.js > ../backtest-first.txt
node tools/backtest.js > ../backtest-second.txt
cmp ../backtest-first.txt ../backtest-second.txt
node tools/backtest.test.js
python3 -m unittest discover -s tools -p 'test_*.py'
node dashboard/test_game.cjs
node dashboard/test_defaults.cjs
# The mounted API tests below also run test_api_migration.cjs with real API fixtures.
python3 -m unittest discover -s dashboard -p 'test_*.py'
python3 tools/qa_heroes.py --self-test
python3 tools/qa_heroes.py --all --output ../qa-out
git diff --check
git status --short
```

Both backtests must print PASS and produce identical output; hero QA must pass
21/21. Never loosen thresholds. QA evidence defaults to `../qa-out`, relative to
the current directory, and must remain outside the source tree. The landmark
`external-review-evidence/` references are neutral identifiers of external visual
reviews, not shipped files or inputs to the QA computation. Keep landmark masks
and sprite hashes consistent; review marked anatomical heads, not just metrics.
See [docs/development.md](docs/development.md) for layout and sequential asset generation.

For a browser check, serve only on loopback (see README), check desktop/mobile
at zoom 1–3, and require no console errors or missing assets. Dashboard setup,
including a fresh Hermes home, is documented in README and [dashboard/README.md](dashboard/README.md).

## Public-tree guard

`check_public.py` reads every path returned by `git ls-files` in the working tree,
including JSON/Markdown, binary metadata and symlink targets. Stage new files so
it sees them. It rejects private paths, operator identities, non-local IPs,
personal GitHub account references, non-example/non-noreply emails and credential
signatures. PNG compressed text metadata is inspected without scanning compressed
pixel noise. Findings print only file, line and category, never secret values.
Fake privacy fixtures are exempt only by exact value/hash in named test files;
adding a test file does not exempt it. This guard does not replace manual review,
a history audit or screenshot inspection and cannot recognize every secret format.

Keep private data, raw assets, previews and local operator/agent records untracked.
Do not publish screenshots derived from real data. Use `data/demo.json` only for
README images. The repository stays private until its owner chooses a license
and publication date. Old history can still hold private material even when the
current tree passes: before publication, obtain owner approval and prepare a
sanitized/squashed history rather than publishing the existing history as-is.
