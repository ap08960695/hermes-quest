// Hermes Quest - native Hermes Desktop plugin (the desktop half of the unified package).
//
// Mounts the ORIGINAL Quest game in the SDK SandboxedFrame (opaque origin, allow-scripts only).
// The page is composed by the package backend (GET /desktop-bootstrap), loaded as a data: document,
// and talks to the host only through one transferred MessagePort that this file owns. Contract:
// docs/native-integration.md. No game fork, no raw iframe to a protected URL, no credential in the guest.
import {
  Button, GlyphSpinner, host, PALETTE_AREA, ROUTES_AREA, SandboxedFrame, SIDEBAR_NAV_AREA,
  usePluginI18n, useTheme
} from '@hermes/plugin-sdk'
import { createElement as h, useEffect, useRef, useState } from 'react'

const ID = 'hermes-quest'
const PATH = '/hermes-quest'

// ---- limits (wire contract: probe/MOUNT-CONTRACT.md "Wire / isolation contract") ----
const REST_TIMEOUT_MS = 35000        // the host transport deadline; the SDK has no AbortSignal
const MAX_PATH = 100000              // guest request path, UTF-16 units (a 32 KiB cursor, fully percent-encoded, is ~98k)
const MAX_CURSOR_BYTES = 32768       // opaque /events cursor, UTF-8 bytes (decoded)
const MAX_INFLIGHT = 8               // concurrent ctx.rest calls per channel
const MAX_RESPONSE_CHARS = 16 * 1024 * 1024
const MAX_BOOTSTRAP_CHARS = 3 * 1024 * 1024
const WATCHDOG_MS = 500             // owner re-check cadence while a channel is alive (requests are checked synchronously regardless)
const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/

const EN = {
  quest: 'Quest', open: 'Open Hermes Quest', title: 'Hermes Quest',
  loading: 'Loading Hermes Quest', reconnecting: 'Quest reconnecting', retry: 'Try again',
  unavailableTitle: 'Quest is not available yet',
  unavailable: 'The Hermes Quest backend on this connection does not provide the Desktop page. Update or reinstall the plugin package, then try again.',
  authTitle: 'Sign-in needed',
  auth: 'This connection did not accept the request. Reconnect or sign in again, then try again.',
  offlineTitle: 'Quest could not load',
  offline: 'The backend did not answer. Check the connection, then try again.',
  bridgeTitle: 'Desktop bridge unavailable',
  bridge: 'This view needs the Hermes Desktop app.',
  lifecycleTitle: 'Desktop update needed',
  lifecycle: 'This Hermes Desktop build cannot report connection changes, so Quest cannot guarantee that it only shows data from the connection you selected. Update Hermes Desktop, then try again.',
  invalidTitle: 'Quest page was refused',
  invalid: 'The backend returned a page that does not match the Desktop contract, so it was not loaded.'
}

// ---------------------------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------------------------

/** Map a ctx.rest failure to a stable UI kind. Never exposes the response body. */
export function classifyError(error) {
  const message = String((error && error.message) || error || '')
  const status = Number((/^(\d{3})\b/.exec(message) || [])[1] || 0)
  if (status === 401 || status === 403) return 'auth'
  if (status === 404 || status === 503) return 'unavailable'
  if (/bridge unavailable/i.test(message)) return 'bridge'
  if (/route lifecycle unavailable/i.test(message)) return 'lifecycle'
  return 'offline'
}

/** Short, payload-free error text for the guest. The guest turns `HTTP nnn` into a Response status. */
export function sanitizeError(error) {
  const status = Number((/^(\d{3})\b/.exec(String((error && error.message) || '')) || [])[1] || 0)
  return status >= 400 && status <= 599 ? `HTTP ${status}` : 'Request failed'
}

const STATIC_JSON_RE = /^\/static\/(?:data\/world\.json|assets\/sprites\/monsters\.json|assets\/px\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.json)$/
const ASSET_PNG_RE = /^assets\/px\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.png$/

function utf8Length(text) {
  return new TextEncoder().encode(text).length
}

/**
 * Validate one guest request and return the exact path the parent may pass to ctx.rest.
 * Throws Error('Bridge request denied'|'Bridge path denied'|...) otherwise. GET only; the
 * parent-only /desktop-bootstrap is deliberately NOT reachable from the guest.
 */
export function validateGuestRequest(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Bridge request denied')
  const keys = Object.keys(message)
  if (keys.some(key => key !== 'id' && key !== 'method' && key !== 'path')) throw new Error('Bridge request denied')
  if (!Number.isSafeInteger(message.id) || message.id <= 0 || message.method !== 'GET') throw new Error('Bridge request denied')
  const raw = message.path
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_PATH || !raw.startsWith('/') || raw.startsWith('//')) {
    throw new Error('Bridge request denied')
  }
  if (/[\u0000-\u001f\u007f\\#]/.test(raw)) throw new Error('Bridge path denied')
  const cut = raw.indexOf('?')
  const path = cut < 0 ? raw : raw.slice(0, cut)
  const queryText = cut < 0 ? '' : raw.slice(cut + 1)
  if (path.includes('%') || path.includes('..') || path.includes('//') || /\/\./.test(path)) throw new Error('Bridge traversal denied')
  let query
  try {
    query = new URLSearchParams(queryText)
  } catch (e) {
    throw new Error('Bridge path denied')
  }
  const names = [...query.keys()]
  if (new Set(names).size !== names.length) throw new Error('Bridge path denied')
  const only = allowed => { if (names.some(name => !allowed.includes(name))) throw new Error('Bridge path denied') }

  if (path === '/replay') {
    only(['hours'])
    const hours = query.get('hours')
    if (hours !== null && !(/^\d{1,3}(?:\.\d{1,3})?$/.test(hours) && Number(hours) > 0 && Number(hours) <= 168)) throw new Error('Bridge path denied')
    return raw
  }
  if (path === '/events') {
    only(['since'])
    if (utf8Length(query.get('since') || '') > MAX_CURSOR_BYTES) throw new Error('Cursor exceeds 32 KiB')
    return raw
  }
  if (path === '/desktop-asset') {
    only(['path'])
    const asset = query.get('path') || ''
    if (!ASSET_PNG_RE.test(asset)) throw new Error('Asset path denied')
    return raw
  }
  if (STATIC_JSON_RE.test(path) && names.length === 0 && cut < 0) return raw
  throw new Error('Bridge path denied')
}

/**
 * Validate the bootstrap envelope from GET /desktop-bootstrap. Fails closed: the host mounts
 * nothing unless the document carries the guest CSP, the nonce meta that matches the envelope
 * nonce, and the guest bridge marker. Returns the document HTML.
 */
export function validateBootstrap(value) {
  if (!value || typeof value !== 'object' || value.version !== 1) throw new Error('invalid bootstrap')
  const { nonce, html } = value
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) throw new Error('invalid bootstrap')
  if (typeof html !== 'string' || html.length === 0 || html.length > MAX_BOOTSTRAP_CHARS) throw new Error('invalid bootstrap')
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const nodes = [...doc.head.childNodes].filter(node => node.nodeType !== 3 || node.textContent.trim())
  const [csp, nonceMeta] = nodes
  const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'"
  if (doc.doctype?.name !== 'html' || csp?.tagName !== 'META' ||
      csp.getAttribute('http-equiv') !== 'Content-Security-Policy' || csp.getAttribute('content') !== policy ||
      nonceMeta?.tagName !== 'META' || nonceMeta.getAttribute('name') !== 'quest-nonce' || nonceMeta.getAttribute('content') !== nonce ||
      doc.querySelectorAll('meta[http-equiv]').length !== 1 || doc.querySelectorAll('meta[name="quest-nonce"]').length !== 1 ||
      ![...doc.body.querySelectorAll('script:not([src])')].some(script => script.textContent.includes('quest-ready'))) throw new Error('invalid bootstrap')
  return { nonce, html }
}

/** The frame URL. A percent-encoded text data: URL with ?live=1 (verified shape; do not switch to base64/blob/srcdoc). */
export function buildFrameSrc(html) {
  return `data:text/html,${encodeURIComponent(html)}?live=1`
}

/** Accept only a #rrggbb accent for the guest. */
export function validAccent(value) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : null
}

// ---------------------------------------------------------------------------------------------
// Route guard: owner + lifecycle binding for everything that crosses ctx.rest
// ---------------------------------------------------------------------------------------------
//
// ctx.rest does not pin an owner: each call is routed by the host's CURRENT request scope
// (registry connection + profile), read synchronously when the call is made. The SDK atom
// host.state.connectionId is a lagging descriptor projection, so it can still name the old
// connection while requests already go to the new one, and it never changes when a registry
// connection keeps its id but is edited to another endpoint. The guard therefore
//   1. pins the owner read from host.activeConnectionId() (the same source as the request scope)
//      and host.state.profile, plus a lifecycle epoch fed by the registry push events;
//   2. verifies the pin in the same synchronous tick as every ctx.rest call (nothing can
//      interleave between the check and the host reading its scope) and again before any
//      result is published;
//   3. on any mismatch retires the channel synchronously (port closed, no reply of any kind)
//      before anything can be re-routed, then lets the page bootstrap again for the new owner.
// A transition that is neither observable through the SDK nor reported by a lifecycle push in
// time cannot be detected here; docs/native-integration.md lists that residual window.

export class RouteChangedError extends Error {
  constructor() {
    super('Quest connection changed')
    this.name = 'RouteChangedError'
    this.code = 'route_changed'
  }
}

const isRouteChanged = error => Boolean(error) && (error instanceof RouteChangedError || error.code === 'route_changed')

/** Current request owner, read synchronously. Throws when the host cannot provide it (fail closed). */
export function readOwner(h = host) {
  if (!h || typeof h.activeConnectionId !== 'function' || !h.state || !h.state.profile || typeof h.state.profile.get !== 'function') {
    throw new Error('Desktop route lifecycle unavailable')
  }
  const connectionId = h.activeConnectionId() || null
  const profile = h.state.profile.get() || null
  return { connectionId: connectionId ? String(connectionId) : null, profile: profile ? String(profile) : null }
}

const ownerKey = owner => `${owner.connectionId === null ? '\u0001' : owner.connectionId}\u0000${owner.profile === null ? '\u0001' : owner.profile}`

/**
 * Watchers fed from the Desktop host: SDK atoms (prompt retirement) and the registry lifecycle
 * pushes (same-id endpoint edits, removal, soft connection apply). Every subscription is
 * optional; the per-request check above is the authority, these only retire sooner.
 * `pushes` says which lifecycle pushes this Desktop build provides.
 */
export function hostWatchers(h = host, desktop = typeof window !== 'undefined' ? window.hermesDesktop : undefined) {
  const connections = desktop && desktop.connections
  const pushes = {
    changed: Boolean(connections && typeof connections.onChanged === 'function'),
    applied: Boolean(desktop && typeof desktop.onConnectionApplied === 'function')
  }
  return {
    pushes,
    subscribe(api) {
      const offs = []
      const add = fn => { try { const off = fn(); if (typeof off === 'function') offs.push(off) } catch (e) { /* unobservable here */ } }
      // Prompt retirement even when the guest is idle: the lagging descriptor atom can stay
      // silent, so the request authority is also sampled on a short timer (cleared on retire).
      add(() => { const id = setInterval(() => api.check(), WATCHDOG_MS); return () => clearInterval(id) })
      add(() => h.state.profile.listen(() => api.check()))
      add(() => h.state.connectionId.listen(() => api.check()))
      if (pushes.changed) add(() => connections.onChanged(payload => api.registry(payload)))
      if (pushes.applied) add(() => desktop.onConnectionApplied(() => api.registry(null)))
      return () => { for (const off of offs) { try { off() } catch (e) { /* already gone */ } } }
    }
  }
}

/**
 * One guard per bootstrap generation.
 *   read()      -> {connectionId, profile}   authoritative owner, synchronous
 *   watchers    -> {pushes:{changed,applied}, subscribe(api)} (see hostWatchers)
 *   onLost(why) -> called once, after the retire hooks ran
 * Returns {pin, lost, valid(), rest(fn), retireWith(hook), dispose()}.
 */
export function createRouteGuard({ read, watchers, onLost }) {
  const pin = Object.freeze({ ...read() })
  const pinKey = ownerKey(pin)
  // An endpoint can change behind an unchanged owner id; only a lifecycle push reports that.
  // Without the push this owner cannot be guarded, so refuse (fail closed) instead of guessing.
  const pushes = (watchers && watchers.pushes) || {}
  if (pin.connectionId === 'local' ? false : pin.connectionId === null ? !pushes.applied : !pushes.changed) {
    throw new Error('Desktop route lifecycle unavailable')
  }

  const hooks = []
  let lost = false
  let disposed = false
  let unwatch = null

  const finish = why => {
    if (unwatch) { const off = unwatch; unwatch = null; try { off() } catch (e) { /* ignore */ } }
    for (const hook of hooks.splice(0)) { try { hook() } catch (e) { /* retire must not throw outward */ } }
    if (why && typeof onLost === 'function') { try { onLost(why) } catch (e) { /* UI callback */ } }
  }
  const lose = why => {
    if (lost || disposed) return
    lost = true
    finish(why)
  }
  const check = () => {
    if (lost || disposed) return false
    let now
    try { now = ownerKey(read()) } catch (e) { lose('owner'); return false }
    if (now !== pinKey) { lose('owner'); return false }
    return true
  }
  const registry = payload => {
    if (lost || disposed) return
    const id = payload && typeof payload === 'object' ? payload.connectionId : undefined
    // A malformed payload, a soft connection apply (null) or an untagged owner cannot be matched
    // to one registry id, so it counts (fail closed).
    if (typeof id !== 'string' || pin.connectionId === null || id === pin.connectionId) lose('registry')
  }

  const guard = {
    pin,
    get lost() { return lost },
    valid: check,
    /** Wrap ctx.rest: verify the pin, call rest in the SAME tick, verify again before publishing. */
    rest(fn) {
      return (path, opts) => {
        if (!check()) return Promise.reject(new RouteChangedError())
        let call
        try { call = Promise.resolve(fn(path, opts)) } catch (error) { call = Promise.reject(error) }
        return call.then(
          value => { if (!check()) throw new RouteChangedError(); return value },
          error => { if (!check()) throw new RouteChangedError(); throw error }
        )
      }
    },
    /** Register a hook that runs synchronously on loss/dispose (or now, when already retired). */
    retireWith(hook) {
      if (lost || disposed) { try { hook() } catch (e) { /* ignore */ } return }
      hooks.push(hook)
    },
    dispose() {
      if (lost || disposed) return
      disposed = true
      finish(null)
    }
  }
  if (watchers && typeof watchers.subscribe === 'function') unwatch = watchers.subscribe({ check, registry })
  return guard
}

/**
 * The parent end of the private channel. Created once per mounted frame generation.
 *   getWindow()  -> the frame's contentWindow (must be the exact message source)
 *   rest(path, {method, timeoutMs}) -> Promise (ctx.rest)
 *   accent()     -> '#rrggbb' | null  (sampled when the guest connects)
 *   isCurrent()  -> false once the owner/route of this channel is no longer the pinned one:
 *                   the channel then never connects and retires itself
 * A rest() rejection that isRouteChanged retires the channel without any reply to the guest.
 * `listen/unlisten` default to window.addEventListener/removeEventListener. dispose() retires
 * the channel: listener removed, port closed, late results suppressed, no further rest calls.
 */
export function createGuestChannel({ getWindow, nonce, rest, accent = () => null, isCurrent = () => true, listen, unlisten, MessageChannelImpl }) {
  const Channel = MessageChannelImpl || MessageChannel
  const on = listen || ((type, fn) => window.addEventListener(type, fn))
  const off = unlisten || ((type, fn) => window.removeEventListener(type, fn))
  const stats = { messages: 0, denied: 0, connected: false, inflight: 0, disposed: false, maxInflight: 0 }
  let port = null
  let disposed = false

  function retire() {
    if (disposed) return
    disposed = true
    stats.disposed = true
    off('message', onMessage)
    if (port) { try { port.onmessage = null; port.close() } catch (e) { /* already closed */ } }
    port = null
  }

  const reply = payload => {
    if (disposed || !port) return
    try { port.postMessage(payload) } catch (e) { /* port closed */ }
  }

  const answer = async message => {
    const id = message.id
    let path
    try {
      path = validateGuestRequest(message)
    } catch (error) {
      stats.denied += 1
      if (Number.isSafeInteger(id) && id > 0) reply({ id, error: error.message })
      return
    }
    if (stats.inflight >= MAX_INFLIGHT) {
      stats.denied += 1
      reply({ id, error: 'Bridge busy' })
      return
    }
    stats.messages += 1
    stats.inflight += 1
    stats.maxInflight = Math.max(stats.maxInflight, stats.inflight)
    try {
      const value = await rest(path, { method: 'GET', timeoutMs: REST_TIMEOUT_MS })
      if (disposed) return
      if (!isCurrent()) { retire(); return }
      if (JSON.stringify(value === undefined ? null : value).length > MAX_RESPONSE_CHARS) throw new Error('Response too large')
      reply({ id, value })
    } catch (error) {
      if (isRouteChanged(error)) { retire(); return }
      if (disposed) return
      reply({ id, error: error && error.message === 'Response too large' ? 'Response too large' : sanitizeError(error) })
    } finally {
      stats.inflight -= 1
    }
  }

  const onMessage = event => {
    if (disposed || port) return
    const frame = getWindow()
    const data = event.data
    if (!frame || event.source !== frame || event.origin !== 'null') return
    if (!data || data.kind !== 'quest-ready' || data.nonce !== nonce) return
    if (!isCurrent()) { retire(); return }
    const channel = new Channel()
    port = channel.port1
    stats.connected = true
    port.onmessage = e => { if (!disposed) void answer(e.data) }
    if (typeof port.start === 'function') port.start()
    // '*' is required for an opaque-origin frame; the nonce is a channel binding, not a credential.
    frame.postMessage({ kind: 'quest-connect', nonce, theme: { accent: validAccent(accent()) } }, '*', [channel.port2])
    off('message', onMessage)
  }

  on('message', onMessage)

  return {
    stats,
    pushTheme(value) {
      const color = validAccent(value)
      if (color) reply({ kind: 'theme', accent: color })
    },
    pushResize() { reply({ kind: 'resize' }) },
    dispose: retire
  }
}

/** Resolve the host --ui-accent to #rrggbb through a 1px canvas (handles color-mix and color()). */
export function resolveAccent(doc = document) {
  try {
    const probe = doc.createElement('span')
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--ui-accent)'
    doc.body.append(probe)
    const color = doc.defaultView.getComputedStyle(probe).color
    probe.remove()
    const canvas = doc.createElement('canvas')
    canvas.width = canvas.height = 1
    const g = canvas.getContext('2d', { willReadFrequently: true })
    g.fillStyle = color
    g.fillRect(0, 0, 1, 1)
    const [r, gr, b, a] = g.getImageData(0, 0, 1, 1).data
    if (a !== 255) return null
    return `#${[r, gr, b].map(n => n.toString(16).padStart(2, '0')).join('')}`
  } catch (e) {
    return null
  }
}

// ---------------------------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------------------------

const fill = { width: '100%', height: '100%', minHeight: 0 }
const centered = {
  ...fill, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
  gap: 12, padding: 24, textAlign: 'center', color: 'var(--ui-text-secondary)'
}

function StateCard({ icon, title, body, action }) {
  return h('div', { style: centered, role: 'status', 'data-quest-state': title },
    icon,
    h('div', { style: { fontSize: 14, fontWeight: 600, color: 'var(--ui-text-primary)' } }, title),
    body ? h('p', { style: { margin: 0, maxWidth: 420, fontSize: 12, lineHeight: '18px' } }, body) : null,
    action)
}

function Quest({ ctx }) {
  const t = usePluginI18n(ID)
  const { theme, renderedMode } = useTheme()
  const [attempt, setAttempt] = useState(0)
  const [routeEpoch, setRouteEpoch] = useState(0)
  const [state, setState] = useState({ phase: 'loading' })
  const frameRef = useRef(null)
  const boxRef = useRef(null)
  const channelRef = useRef(null)

  // Bootstrap: one fetch per route generation (a retry or a retired owner). The guard pins the
  // authoritative owner BEFORE the request and ctx.rest is called in the same tick, so the
  // bootstrap belongs to exactly that owner; a result for any other owner is dropped and nothing
  // from the previous owner survives in state. A lost route bumps routeEpoch ("Quest reconnecting").
  useEffect(() => {
    let alive = true
    setState({ phase: 'loading', reconnecting: routeEpoch > 0 })
    let guard
    try {
      guard = createRouteGuard({
        read: () => readOwner(host),
        watchers: hostWatchers(host),
        onLost: () => { if (alive) setRouteEpoch(n => n + 1) }
      })
    } catch (error) {
      setState({ phase: 'error', kind: classifyError(error) })
      return () => { alive = false }
    }
    guard.rest(ctx.rest)('/desktop-bootstrap', { timeoutMs: REST_TIMEOUT_MS }).then(value => {
      if (!alive || guard.lost) return
      try {
        setState({ phase: 'ready', ...validateBootstrap(value), guard })
      } catch (e) {
        setState({ phase: 'error', kind: 'invalid' })
      }
    }, error => {
      if (alive && !guard.lost && !isRouteChanged(error)) setState({ phase: 'error', kind: classifyError(error) })
    })
    return () => { alive = false; guard.dispose() }
  }, [attempt, routeEpoch])

  const ready = state.phase === 'ready'
  const nonce = ready ? state.nonce : null
  const guard = ready ? state.guard : null

  // Private channel + size observer, bound to this frame generation and its guard only.
  useEffect(() => {
    if (!nonce || !guard) return undefined
    const channel = createGuestChannel({
      getWindow: () => (frameRef.current ? frameRef.current.contentWindow : null),
      nonce,
      rest: guard.rest(ctx.rest),
      isCurrent: () => guard.valid(),
      accent: () => resolveAccent(document)
    })
    channelRef.current = channel
    guard.retireWith(channel.dispose)
    let raf = 0
    const observer = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
        cancelAnimationFrame(raf)
        raf = requestAnimationFrame(() => channel.pushResize())
      })
      : null
    if (observer && boxRef.current) observer.observe(boxRef.current)
    return () => {
      cancelAnimationFrame(raf)
      if (observer) observer.disconnect()
      channel.dispose()
      if (channelRef.current === channel) channelRef.current = null
    }
  }, [nonce, guard, ctx])

  // Live theme: re-sample after the host repaints, then hand the validated colour to the guest.
  useEffect(() => {
    if (!nonce) return undefined
    const id = requestAnimationFrame(() => {
      const channel = channelRef.current
      if (channel) channel.pushTheme(resolveAccent(document))
    })
    return () => cancelAnimationFrame(id)
  }, [nonce, theme && theme.name, renderedMode])

  if (state.phase === 'loading') {
    const label = state.reconnecting ? t('reconnecting') : t('loading')
    return h(StateCard, { icon: h(GlyphSpinner, { ariaLabel: label }), title: label })
  }
  if (state.phase === 'error') {
    const kind = state.kind
    return h(StateCard, {
      title: t(`${kind}Title`),
      body: t(kind),
      action: h(Button, { size: 'xs', variant: 'outline', onClick: () => setAttempt(n => n + 1) }, t('retry'))
    })
  }
  return h('div', { ref: boxRef, style: fill },
    h(SandboxedFrame, {
      key: nonce, ref: frameRef, src: buildFrameSrc(state.html), title: t('title'), style: fill
    }))
}

export default {
  id: ID,
  name: 'Hermes Quest',
  version: '0.1.2',
  description: 'The Hermes Quest pixel RPG of your agents, mounted natively in a sandboxed frame.',
  defaultEnabled: false,
  register(ctx) {
    ctx.i18n.register({ en: EN })
    ctx.registerMany([
      { id: 'page', area: ROUTES_AREA, data: { path: PATH }, render: () => h(Quest, { ctx }) },
      { id: 'nav', area: SIDEBAR_NAV_AREA, order: 60, data: { codicon: 'game', label: ctx.i18n.t('quest'), path: PATH } },
      {
        id: 'open',
        area: PALETTE_AREA,
        data: {
          id: 'hermes-quest.open', label: ctx.i18n.t('open'),
          keywords: ['quest', 'game', 'agents', 'rpg', 'hermes'], run: () => host.navigate(PATH)
        }
      }
    ])
  }
}
