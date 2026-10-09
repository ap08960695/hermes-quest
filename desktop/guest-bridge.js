// Hermes Quest - guest compatibility bridge for the Hermes Desktop SandboxedFrame.
//
// Runs INSIDE the opaque-origin guest document, as the very first inline script
// (the backend transport inlines this file before font.js; it is not imported as
// a disk-plugin module). It lets the unchanged Quest runtime keep calling
// fetch() / new Image() while every byte actually travels over ONE transferred
// MessagePort owned by desktop/plugin.js:
//
//   guest -> parent  {kind:'quest-ready', nonce}              (window message, once per announce)
//   parent -> guest  {kind:'quest-connect', nonce, theme}     (+ MessagePort, source/nonce checked)
//   guest -> parent  {id, method:'GET', path}                 (port)
//   parent -> guest  {id, value} | {id, error}                (port)
//   parent -> guest  {kind:'theme', accent}                   (port, live theme changes)
//
// Rules: GET only, no credentials, no direct network (the guest CSP is
// connect-src 'none'), no host API, no global wildcard messages after connect.
// Keep this file free of the closing-script and comment-open character
// sequences: the backend refuses to inline a source that contains them.
(() => {
  'use strict';

  const API_PREFIX = '/api/plugins/hermes-quest/';
  const VIRTUAL_BASE = 'https://hermes-quest.invalid/';
  const MAX_PENDING = 16;
  const MAX_PATH = 100000;
  const DEADLINE_MS = 40000;
  const ANNOUNCE_MS = 250;
  const ANNOUNCE_MAX = 80;

  const meta = document.querySelector('meta[name="quest-nonce"]');
  const nonce = meta && typeof meta.content === 'string' ? meta.content : '';
  const pending = new Map();
  let port = null;
  let seq = 0;
  let announced = 0;
  let announceTimer = 0;
  let resolveReady;
  const channelReady = new Promise(resolve => { resolveReady = resolve; });

  function applyAccent(value) {
    if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) return;
    const style = document.documentElement.style;
    style.setProperty('--ui-accent', value);
    style.setProperty('--gold', value);
  }

  function settle(id, fn) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    fn(entry);
  }

  function onPortMessage(event) {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.kind === 'theme') { applyAccent(data.accent); return; }
    if (!Number.isSafeInteger(data.id)) return;
    settle(data.id, entry => {
      if (typeof data.error === 'string') entry.reject(new Error(data.error));
      else entry.resolve(data.value);
    });
  }

  function onWindowMessage(event) {
    const data = event.data;
    if (port || event.source !== parent || !data || data.kind !== 'quest-connect') return;
    if (typeof data.nonce !== 'string' || data.nonce !== nonce || !event.ports || !event.ports[0]) return;
    window.removeEventListener('message', onWindowMessage);
    clearInterval(announceTimer);
    port = event.ports[0];
    port.onmessage = onPortMessage;
    port.start();
    if (data.theme) applyAccent(data.theme.accent);
    resolveReady();
  }

  function announce() {
    if (port || announced >= ANNOUNCE_MAX) { clearInterval(announceTimer); return; }
    announced += 1;
    // targetOrigin '*' is required for an opaque-origin frame; it carries only the
    // channel-binding nonce (not a credential). Data travels on the port.
    parent.postMessage({ kind: 'quest-ready', nonce }, '*');
  }

  if (nonce) {
    window.addEventListener('message', onWindowMessage);
    announce();
    // The parent may attach its listener a moment after the document starts.
    announceTimer = setInterval(announce, ANNOUNCE_MS);
  }

  function request(path) {
    if (!nonce) return Promise.reject(new TypeError('Bridge unavailable'));
    if (pending.size >= MAX_PENDING) return Promise.reject(new TypeError('Bridge busy'));
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => settle(id, entry => entry.reject(new Error('Bridge timeout'))), DEADLINE_MS);
      pending.set(id, { resolve, reject, timer });
      channelReady.then(() => {
        if (pending.has(id)) port.postMessage({ id, method: 'GET', path });
      });
    });
  }

  // fetch(url) for the original game: its API calls and relative static JSON.
  function toRoute(raw) {
    const url = String(raw);
    if (url.length > MAX_PATH) return null;
    if (url.startsWith(API_PREFIX)) return '/' + url.slice(API_PREFIX.length);
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(url) || /^[\\/]/.test(url)) return null;
    const rel = url.replace(/^\.\//, '');
    if (!rel || /[?#%\\]/.test(rel) || rel.split('/').some(part => part === '' || part === '.' || part === '..')) return null;
    return '/static/' + rel;
  }

  function statusOf(error) {
    const m = /^HTTP ([45]\d\d)$/.exec(error && error.message);
    return m ? Number(m[1]) : 0;
  }

  window.fetch = function questFetch(input, init) {
    const options = init || {};
    const raw = typeof input === 'string' ? input : (input && typeof input.url === 'string' ? input.url : String(input));
    const method = String(options.method || (input && input.method) || 'GET').toUpperCase();
    const route = method === 'GET' ? toRoute(raw) : null;
    const signal = options.signal;
    if (!route) return Promise.reject(new TypeError('Request denied'));
    if (signal && signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
    return new Promise((resolve, reject) => {
      let done = false;
      const onAbort = () => { if (!done) { done = true; reject(new DOMException('Aborted', 'AbortError')); } };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      request(route).then(value => {
        if (done) return;
        done = true;
        resolve(new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }, error => {
        if (done) return;
        done = true;
        const status = statusOf(error);
        if (status) resolve(new Response('{}', { status, headers: { 'Content-Type': 'application/json' } }));
        else reject(new TypeError('Network unavailable'));
      }).finally(() => { if (signal) signal.removeEventListener('abort', onAbort); });
    });
  };

  // new Image().src = 'assets/px/x.png' -> JSON envelope -> data: URL (CSP img-src data:).
  const NativeImage = window.Image;
  const nativeSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  if (typeof NativeImage === 'function' && nativeSrc && nativeSrc.set) {
    window.Image = class QuestImage extends NativeImage {
      get src() { return nativeSrc.get.call(this); }
      set src(value) {
        const path = String(value);
        const token = (this.questToken = (this.questToken || 0) + 1);
        if (path === '' || /^data:/i.test(path)) { nativeSrc.set.call(this, path); return; }
        request('/desktop-asset?path=' + encodeURIComponent(path)).then(envelope => {
          if (token !== this.questToken) return;
          if (!envelope || envelope.mime !== 'image/png' || typeof envelope.base64 !== 'string') throw new Error('Invalid image envelope');
          nativeSrc.set.call(this, 'data:image/png;base64,' + envelope.base64);
        }).catch(() => {
          if (token === this.questToken) this.dispatchEvent(new Event('error'));
        });
      }
    };
  }

  // font.js builds new URL('assets/fonts/...', currentScript.src || document.baseURI). In a
  // data: document baseURI is the data URL itself, which cannot be a base, so the font
  // module would throw "Invalid URL" at load. Give it a valid virtual base (no base element:
  // base-uri is 'none' under the guest CSP). Own property on the document instance only.
  try {
    Object.defineProperty(document, 'baseURI', { configurable: true, get: () => VIRTUAL_BASE });
  } catch (e) { /* keep the native value; font.js then reports its own failure */ }

  // Fonts are not part of this transport yet (CSP has no font-src, the asset envelope is PNG
  // only). Fail the font load cleanly and offline so the UI takes its documented fallback
  // path instead of firing a blocked network request and a CSP violation report.
  const NativeFontFace = window.FontFace;
  if (typeof NativeFontFace === 'function') {
    const blocked = new WeakSet();
    window.FontFace = class QuestFontFace extends NativeFontFace {
      constructor(family, source, descriptors) {
        const remote = typeof source === 'string' && /url\(/i.test(source);
        // Never hand a URL source to the browser: it would log a CSP violation for a request we refuse anyway.
        super(family, remote ? 'local("QuestUnavailableFont")' : source, descriptors);
        if (remote) blocked.add(this);
      }
      load() {
        if (blocked.has(this)) return Promise.reject(new Error('Font transport unavailable'));
        return super.load();
      }
    };
  }

  Object.defineProperty(window, '__questBridge', {
    value: Object.freeze({ version: 1, connected: () => port !== null, pending: () => pending.size }),
  });
})();
