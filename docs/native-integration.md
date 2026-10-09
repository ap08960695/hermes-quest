# Hermes Desktop native integration

`desktop/plugin.js` is the Desktop half of the unified Hermes Quest package. It mounts the
unchanged Quest game in the SDK `SandboxedFrame` (opaque origin, `sandbox="allow-scripts"`).
The backend half is `dashboard/desktop_transport.py` (`GET /desktop-bootstrap`, `GET /desktop-asset`).
The game source is not forked, and no raw iframe points at a protected URL.

## Data flow

    Desktop route /hermes-quest
      -> ctx.rest('/desktop-bootstrap')            { version:1, nonce, html }   (parent only)
      -> SandboxedFrame src = data:text/html,<encoded html>?live=1
    guest (opaque origin, CSP connect-src 'none')
      -> guest-bridge.js (inlined FIRST, then font.js, ui-glyphs.js, ui-panels.js, npcs.js, game.js)
      -> window message {kind:'quest-ready', nonce}
    parent
      -> checks event.source === frame window, origin 'null', nonce
      -> transfers ONE MessagePort {kind:'quest-connect', nonce, theme}; listener removed
    guest <-> parent, over the port only
      guest  {id, method:'GET', path}      parent {id, value} | {id, error}
      parent {kind:'theme', accent}        live host accent colour

The parent validates every guest request against a fixed allowlist before calling `ctx.rest`:
`/replay?hours=`, `/events?since=` (cursor up to 32 KiB decoded), `/static/data/world.json`,
`/static/assets/sprites/monsters.json`, `/static/assets/px/**.json`, and
`/desktop-asset?path=assets/px/**.png`. GET only, no traversal or encoded dots, no duplicate or
unknown query keys, at most 8 requests in flight, responses capped at 16 MiB.
`/desktop-bootstrap` is not reachable from the guest. Errors reach the guest as `HTTP nnn` or a
fixed phrase, never as response bodies or paths.

## guest-bridge.js (backend contract)

1. Nonce: read from `<meta name="quest-nonce" content="...">`. The bridge is inlined as the first script.
2. It replaces `window.fetch` (API calls and relative static JSON such as `assets/px/heroes.json`
   become port requests) and `window.Image` (the `src` setter fetches the PNG envelope and sets a
   `data:` URL). Absolute URLs, non-GET, `..`, `?`, `#`, `%` and backslashes reject with `TypeError`.
3. `font.js` builds `new URL('assets/fonts/...', document.currentScript?.src || document.baseURI)`.
   In a `data:` document that throws `Invalid URL`. The bridge defines an own `document.baseURI`
   getter returning `https://hermes-quest.invalid/` (no `<base>`: the CSP has `base-uri 'none'`).
   `font.js` is untouched.
4. Fonts: the CSP has no `font-src` and `/desktop-asset` serves PNG only. Captain decision: fonts fail
   silently. `FontFace` with a `url(...)` source is constructed with a local placeholder source and its
   `load()` rejects `Font transport unavailable`, so there is no network attempt, no CSP report, and the
   UI uses the system fallback. A later change may add a font envelope.
5. Other JSON goes through `ctx.rest('/static/<path>.json')`, which the existing static allowlist serves.

## Behaviour notes

- Plugin is opt-in (`defaultEnabled: false`). Route `/hermes-quest`, sidebar item, command palette entry.
- States: loading, unavailable (404/503), sign-in needed (401/403), offline, invalid bootstrap
  (fail closed: no frame is mounted unless CSP, nonce meta and bridge marker are present), each with Retry.
- A connection or profile change refetches the bootstrap and replaces the frame (`key = nonce`);
  late results from a retired generation are dropped. Unmount closes the port and stops all traffic.
- The host accent (`--ui-accent`) is resolved to `#rrggbb` in the parent and pushed to the guest as `--ui-accent` and `--gold`.

## Tests

    # unit only
    QUEST_NODE_MODULES=<node_modules with esbuild, react, react-dom, playwright-core> node desktop/test_plugin.cjs
    # + real browsers against a running backend transport (needs the transport branch, FastAPI)
    QUEST_TRANSPORT=http://127.0.0.1:PORT/api/plugins/hermes-quest QUEST_BROWSERS=chromium,firefox node desktop/test_plugin.cjs

The browser run mounts the real `plugin.js` with a stand-in for the SDK `SandboxedFrame` (an
`iframe sandbox="allow-scripts"`), boots the unchanged game through the real backend bootstrap, and checks
isolation (origin `null`, no host API, POST/absolute/`desktop-bootstrap`/traversal fetches rejected),
asset and JSON traffic, serial `/events` polling, the font fallback, unmount silence and the failure UIs.
It is not a test inside the real Desktop app.
