/* Dependency-free Hermes Dashboard SDK entry; React is supplied by the host. */
(() => {
  "use strict";
  const { React, fetchJSON } = window.__HERMES_PLUGIN_SDK__;
  const API = "/api/plugins/hermes-quest";
  const DEADLINE_MS = 35000;
  const PNG = /^assets\/px\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.png$/;
  const STATIC_JSON = /^\/static\/(?:data\/world\.json|assets\/sprites\/monsters\.json|assets\/px\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.json)$/;

  // Reuse the audited Desktop document/asset envelopes and guest bridge, not a
  // second game bundle. All network access stays in the host's authenticated SDK;
  // the opaque-origin guest gets neither a token nor access to other host APIs.
  function guestPath(message) {
    if (!message || typeof message !== "object" || Array.isArray(message) ||
        Object.keys(message).some(k => !["id", "method", "path"].includes(k)) ||
        !Number.isSafeInteger(message.id) || message.id <= 0 || message.method !== "GET") throw new Error("Request denied");
    const raw = message.path;
    if (typeof raw !== "string" || !raw || raw.length > 100000 || !raw.startsWith("/") ||
        /[\u0000-\u001f\u007f\\#]/.test(raw)) throw new Error("Request denied");
    const cut = raw.indexOf("?");
    const path = cut < 0 ? raw : raw.slice(0, cut);
    if (path.includes("%") || path.includes("..") || path.includes("//") || /\/\./.test(path)) throw new Error("Request denied");
    const query = new URLSearchParams(cut < 0 ? "" : raw.slice(cut + 1));
    const names = [...query.keys()];
    const only = allowed => new Set(names).size === names.length && names.every(k => allowed.includes(k));
    const hours = query.get("hours");
    if (path === "/replay" && only(["hours"]) && (hours === null ||
        (/^\d{1,3}(?:\.\d{1,3})?$/.test(hours) && Number(hours) > 0 && Number(hours) <= 168))) return raw;
    if (path === "/events" && only(["since"]) && new TextEncoder().encode(query.get("since") || "").length <= 32768) return raw;
    if (path === "/desktop-asset" && only(["path"]) && PNG.test(query.get("path") || "")) return raw;
    if (STATIC_JSON.test(path) && cut < 0) return raw;
    throw new Error("Request denied");
  }

  function safeError(error) {
    // SDK ApiError carries status; legacy SDK errors start with the HTTP code.
    const status = Number(error?.status || /^(\d{3})\b/.exec(error?.message || "")?.[1]);
    return status >= 400 && status <= 599 ? `HTTP ${status}` : "Request failed";
  }

  function HermesQuestPage() {
    const frame = React.useRef(null);
    const [page, setPage] = React.useState(null);
    const [failed, setFailed] = React.useState(false);
    const [attempt, setAttempt] = React.useState(0);
    React.useEffect(() => {
      let disposed = false, connected = false, port = null;
      const active = new Set();
      // Race headers AND body; abort the SDK fetch on deadline/unmount. Do not
      // let a late response from a retired view populate its replacement.
      async function json(path) {
        const controller = new AbortController();
        active.add(controller);
        let timer;
        try {
          return await Promise.race([
            fetchJSON(API + path, { cache: "no-store", signal: controller.signal }),
            new Promise((_, reject) => { timer = setTimeout(() => {
              controller.abort(); reject(new Error("Transport timeout"));
            }, DEADLINE_MS); })
          ]);
        } finally { clearTimeout(timer); active.delete(controller); }
      }
      let nonce;
      function ready(event) {
        if (disposed || connected || event.origin !== "null" || event.source !== frame.current?.contentWindow ||
            event.data?.kind !== "quest-ready" || event.data.nonce !== nonce) return;
        connected = true;
        window.removeEventListener("message", ready);
        const channel = new MessageChannel();
        port = channel.port1;
        port.onmessage = async event => {
          const message = event.data;
          const id = message?.id;
          if (disposed || !Number.isSafeInteger(id) || id <= 0) return;
          try {
            const path = guestPath(message);
            if (active.size >= 8) throw new Error("Bridge busy");
            const value = await json(path);
            if (JSON.stringify(value).length > 16 * 1024 * 1024) throw new Error("Response too large");
            if (!disposed) port.postMessage({ id, value });
          } catch (error) {
            if (!disposed) port.postMessage({ id, error: safeError(error) });
          }
        };
        port.start();
        frame.current.contentWindow.postMessage({ kind: "quest-connect", nonce }, "*", [channel.port2]);
      }
      window.addEventListener("message", ready);
      json("/desktop-bootstrap").then(value => {
        if (disposed) return;
        if (value?.version !== 1 || !/^[A-Za-z0-9_-]{16,128}$/.test(value.nonce) ||
            typeof value.html !== "string" || !value.html || value.html.length > 3 * 1024 * 1024 ||
            !value.html.includes('http-equiv="Content-Security-Policy"') || !value.html.includes("connect-src 'none'") ||
            !value.html.includes(`<meta name="quest-nonce" content="${value.nonce}">`) ||
            !value.html.includes("quest-ready")) throw new Error("Invalid bootstrap");
        nonce = value.nonce;
        setPage(`data:text/html,${encodeURIComponent(value.html)}?live=1`);
      }).catch(() => { if (!disposed) setFailed(true); });
      return () => {
        disposed = true;
        window.removeEventListener("message", ready);
        port?.close();
        for (const controller of active) controller.abort();
      };
    }, [attempt]);
    const h = React.createElement;
    return h("section", {
      "aria-label": "Hermes Quest",
      style: { width: "100%", minWidth: 0 }
    }, failed ? h("div", { role: "alert" }, "Quest could not load. Check your connection or sign in again. ",
      h("button", { onClick: () => { setPage(null); setFailed(false); setAttempt(n => n + 1); } }, "Try again")) :
      page ? h("iframe", {
        ref: frame, key: attempt, title: "Hermes Quest live activity and replay",
        src: page, sandbox: "allow-scripts",
        style: {
          display: "block", width: "100%", height: "calc(100dvh - 9rem)",
          minHeight: 0, border: 0, borderRadius: "8px", background: "#10121c"
        },
        referrerPolicy: "no-referrer"
      }) : h("div", { role: "status" }, "Loading Hermes Quest"));
  }

  window.__HERMES_PLUGINS__.register("hermes-quest", HermesQuestPage);
})();
