"use strict";

/* Runs in the page's own JavaScript world (registered by background.js).
 *  - Wraps WebSocket so its frames can be recorded (webRequest only sees the
 *    handshake).
 *  - Notes which script starts each fetch, XHR, beacon, EventSource, socket,
 *    and script/image/stylesheet/frame load, for the request tree. Firefox only
 *    tells extensions which document a request came from, not which script.
 * Events go to ws-relay.js as JSON strings on a window event. Wrappers are
 * Proxies, so they still look native to the page. Workers aren't covered. */
(() => {
  const EVT = "__netmon_ws__";
  const CMD = "__netmon_ws_cmd__";
  const Native = window.WebSocket;
  if (!Native || Native[EVT]) return;

  const MAX_DATA = 5 * 1024 * 1024; // per message; longer ones are cut off
  const prefix = Math.random().toString(36).slice(2, 10);
  let seq = 0;
  const ids = new WeakMap();
  const open = new Map(); // id -> socket, so the monitor can send on it

  const post = (msg) => {
    try { window.dispatchEvent(new CustomEvent(EVT, { detail: JSON.stringify(msg) })); } catch { /* ignore */ }
  };

  function utf8Length(str) {
    let n = 0;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c < 0xdc00) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }

  function toBase64(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function binary(bytes) {
    return { op: 2, size: bytes.length, data: toBase64(bytes.subarray(0, MAX_DATA)), truncated: bytes.length > MAX_DATA };
  }

  // Returns the frame payload, or a promise of it for Blobs.
  function encode(data) {
    if (typeof data === "string") {
      return { op: 1, size: utf8Length(data), data: data.slice(0, MAX_DATA), truncated: data.length > MAX_DATA };
    }
    if (data instanceof ArrayBuffer) return binary(new Uint8Array(data));
    if (ArrayBuffer.isView(data)) return binary(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    if (data instanceof Blob) return data.arrayBuffer().then((b) => binary(new Uint8Array(b)));
    return encode(String(data));
  }

  function frame(ws, dir, data, resent) {
    const id = ids.get(ws);
    if (!id) return;
    const t = Date.now();
    try {
      const p = encode(data);
      if (p instanceof Promise) p.then((x) => post({ k: "msg", id, dir, t, resent, ...x }), () => {});
      else post({ k: "msg", id, dir, t, resent, ...p });
    } catch { /* ignore */ }
  }

  function track(ws) {
    const id = prefix + ":" + ++seq;
    ids.set(ws, id);
    open.set(id, ws);
    post({ k: "new", id, url: ws.url, t: Date.now() });
    ws.addEventListener("open", () => post({ k: "open", id, url: ws.url, protocol: ws.protocol, extensions: ws.extensions, t: Date.now() }));
    ws.addEventListener("message", (ev) => frame(ws, "recv", ev.data));
    ws.addEventListener("error", () => post({ k: "error", id, t: Date.now() }));
    ws.addEventListener("close", (ev) => {
      open.delete(id);
      post({ k: "close", id, code: ev.code, reason: ev.reason, wasClean: ev.wasClean, t: Date.now() });
    });
  }

  const nativeSend = Native.prototype.send;
  Native.prototype.send = new Proxy(nativeSend, {
    apply(target, self, args) {
      const result = Reflect.apply(target, self, args); // throws while still connecting, like the original
      frame(self, "send", args[0]);
      return result;
    },
  });

  // Sends from the monitor's Resend / Edit and resend, relayed by ws-relay.js.
  window.addEventListener(CMD, (ev) => {
    let cmd;
    try { cmd = JSON.parse(ev.detail); } catch { return; }
    const reply = (ok, error) => post({ k: "result", reqId: cmd.reqId, ok, error });
    const ws = open.get(cmd.id);
    if (!ws) { reply(false, "The connection is gone (closed, or the page was reloaded)."); return; }
    if (ws.readyState !== 1) { reply(false, ws.readyState === 0 ? "The connection isn't open yet." : "The connection is closed."); return; }
    try {
      let payload = String(cmd.data);
      if (cmd.op === 2) {
        const s = atob(payload);
        payload = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) payload[i] = s.charCodeAt(i);
      }
      nativeSend.call(ws, payload);
      frame(ws, "send", payload, true);
      reply(true);
    } catch (err) {
      reply(false, String(err && err.message || err));
    }
  }, true);

  /* ---- initiators: which script made each request ---- */

  // The first stack frame outside this extension, e.g. "https://x/app.js:120:15".
  // Firefox writes frames as "fn@url:line:col", Chrome as "    at fn (url:line:col)"
  // or "    at url:line:col".
  function caller() {
    const stack = new Error().stack || "";
    for (const line of stack.split("\n")) {
      let loc;
      const chrome = /^\s*at (?:.*?\()?(.+?:\d+:\d+)\)?\s*$/.exec(line);
      if (chrome) loc = chrome[1].replace(/^async /, "");
      else {
        const at = line.lastIndexOf("@");
        if (at < 0) continue;
        loc = line.slice(at + 1).replace(/ line \d+ > .*$/, "");
      }
      // Skip this hook's own frames: Firefox names a manifest MAIN-world script
      // "<anonymous code>", a registered one moz-extension://…; Chrome chrome-extension://….
      if (!loc || /^(moz|chrome)-extension:/.test(loc) || loc.startsWith("<")) continue;
      return { url: loc.replace(/:\d+:\d+$/, ""), loc };
    }
    return null;
  }

  function hint(kind, url) {
    try {
      if (url == null || url === "") return;
      const abs = new URL(String(url), document.baseURI).href;
      if (!/^(https?|wss?):/.test(abs)) return;
      const by = caller();
      if (by) post({ k: "init", kind, url: abs, by: by.url, loc: by.loc, t: Date.now() });
    } catch { /* never break the page */ }
  }

  const wrapCall = (obj, name, kind, urlOf) => {
    const fn = obj && obj[name];
    if (typeof fn !== "function") return;
    obj[name] = new Proxy(fn, {
      apply(target, self, args) {
        try { hint(kind, urlOf(args)); } catch { /* ignore */ }
        return Reflect.apply(target, self, args);
      },
    });
  };

  wrapCall(window, "fetch", "fetch", (a) => (a[0] && typeof a[0] === "object" && "url" in a[0] ? a[0].url : a[0]));
  wrapCall(XMLHttpRequest.prototype, "open", "xhr", (a) => a[1]);
  wrapCall(Navigator.prototype, "sendBeacon", "beacon", (a) => a[0]);

  if (window.EventSource) {
    window.EventSource = new Proxy(window.EventSource, {
      construct(target, args, newTarget) {
        hint("eventsource", args[0]);
        return Reflect.construct(target, args, newTarget);
      },
    });
  }

  // Script-made loads: el.src = …, link.href = …, setAttribute("src", …).
  const LOADING = [
    [window.HTMLScriptElement, "src"], [window.HTMLImageElement, "src"], [window.HTMLLinkElement, "href"],
    [window.HTMLIFrameElement, "src"], [window.HTMLSourceElement, "src"], [window.HTMLMediaElement, "src"],
  ];
  for (const [ctor, prop] of LOADING) {
    const proto = ctor && ctor.prototype;
    const desc = proto && Object.getOwnPropertyDescriptor(proto, prop);
    if (!desc || !desc.set) continue;
    Object.defineProperty(proto, prop, {
      ...desc,
      set: new Proxy(desc.set, {
        apply(target, self, args) {
          hint("element", args[0]);
          return Reflect.apply(target, self, args);
        },
      }),
    });
  }
  const loadsByAttr = (el, name) => {
    const n = String(name).toLowerCase();
    if (n === "src") return el instanceof HTMLScriptElement || el instanceof HTMLImageElement || el instanceof HTMLIFrameElement || el instanceof HTMLSourceElement || el instanceof HTMLMediaElement;
    return n === "href" && el instanceof HTMLLinkElement;
  };
  Element.prototype.setAttribute = new Proxy(Element.prototype.setAttribute, {
    apply(target, self, args) {
      try { if (loadsByAttr(self, args[0])) hint("element", args[1]); } catch { /* ignore */ }
      return Reflect.apply(target, self, args);
    },
  });

  const Wrapped = new Proxy(Native, {
    construct(target, args, newTarget) {
      const ws = Reflect.construct(target, args, newTarget);
      try { hint("websocket", ws.url); track(ws); } catch { /* never break the page */ }
      return ws;
    },
    get(target, key, receiver) {
      return key === EVT ? true : Reflect.get(target, key, receiver);
    },
  });
  window.WebSocket = Wrapped;
})();
