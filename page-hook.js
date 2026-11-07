"use strict";

/* Runs in the page's own JavaScript world (registered by background.js, on
 * the sites the "Page hook" setting allows).
 *  - Wraps WebSocket so its frames can be recorded (webRequest only sees the
 *    handshake).
 *  - Notes which script starts each fetch, XHR, beacon, EventSource, socket,
 *    and script/image/stylesheet/frame load, for the request tree. Firefox only
 *    tells extensions which document a request came from, not which script.
 * Events go to ws-relay.js as JSON strings on window events with random names
 * (agreed in a handshake before the page's own scripts run). Workers aren't
 * covered.
 *
 * Keeping out of the page's sight, as far as wrapping in the page allows:
 *  - the wrappers are Proxies of the originals (they answer like them, except
 *    that Function.prototype.toString shows them without a name);
 *  - nothing is added to the page's objects, and WebSocket.prototype.constructor
 *    and EventSource.prototype.constructor point at the wrappers;
 *  - the page's own objects are never converted to strings (only plain
 *    strings, URL and Request objects are read), and built-ins the hook uses
 *    are taken before the page can replace them;
 *  - errors thrown through a wrapper have the hook's stack lines removed.
 * What it can't hide: wrapped calls are a little slower and leave a nameless
 * function in toString. The setting can turn the hook off per site. */
(() => {
  const NativeWS = window.WebSocket;
  if (!NativeWS) return;

  // Built-ins, taken now: the page could replace or watch them later.
  const { apply, construct } = Reflect;
  const stringify = JSON.stringify, parse = JSON.parse;
  const now = Date.now;
  const NativeURL = URL;
  const NativeCustomEvent = CustomEvent;
  const dispatch = EventTarget.prototype.dispatchEvent;
  const listen = EventTarget.prototype.addEventListener;
  const unlisten = EventTarget.prototype.removeEventListener;
  const mapGet = Map.prototype.get, mapSet = Map.prototype.set, mapDelete = Map.prototype.delete;
  const wmGet = WeakMap.prototype.get, wmSet = WeakMap.prototype.set;
  const urlHref = Object.getOwnPropertyDescriptor(URL.prototype, "href").get;
  const requestUrl = window.Request && Object.getOwnPropertyDescriptor(Request.prototype, "url").get;
  const baseURI = Object.getOwnPropertyDescriptor(Node.prototype, "baseURI").get;
  const wsUrl = Object.getOwnPropertyDescriptor(NativeWS.prototype, "url").get;
  const NativeError = Error;
  const MAX_DATA = 5 * 1024 * 1024; // per message; longer ones are cut off

  // This script's own name in stack traces, to take its lines out of errors.
  const selfFile = (() => {
    const line = (new NativeError().stack || "").split("\n").find((l) => /:\d+:\d+/.test(l)) || "";
    const m = /\((.+?):\d+:\d+\)\s*$/.exec(line) || /at (.+?):\d+:\d+\s*$/.exec(line) || /@(.+?):\d+:\d+\s*$/.exec(line);
    return m ? m[1] : "";
  })();
  function scrub(err) {
    try {
      if (selfFile && err && typeof err.stack === "string" && err.stack.includes(selfFile)) {
        err.stack = err.stack.split("\n").filter((l) => !l.includes(selfFile)).join("\n");
      }
    } catch { /* leave it */ }
    return err;
  }

  /* ---- talking to ws-relay.js ----
   * Handshake on two fixed event names, before any page script runs (both
   * scripts load at document_start, in either order): the hook announces
   * itself with READY, the relay answers with HELLO carrying two random event
   * names, one for each direction. Both stop listening to the fixed names then. */
  const READY = "netmon-hook-ready", HELLO = "netmon-hook-hello";
  let out = null; // the event name for messages to the relay
  const early = []; // messages from before the handshake
  const fire = (type, detail) => { try { apply(dispatch, window, [new NativeCustomEvent(type, { detail })]); } catch { /* ignore */ } };
  const post = (msg) => {
    let s;
    try { s = apply(stringify, JSON, [msg]); } catch { return; }
    if (out) fire(out, s);
    else if (early.length < 1000) early.push(s);
  };
  function onHello(ev) {
    let names;
    try { names = apply(parse, JSON, [ev.detail]); } catch { return; }
    if (!names || typeof names.out !== "string" || typeof names.cmd !== "string") return;
    apply(unlisten, window, [HELLO, onHello, true]);
    out = names.out;
    apply(listen, window, [names.cmd, onCommand, true]);
    fire(out, '{"k":"bound"}');
    for (const s of early.splice(0)) fire(out, s);
  }
  apply(listen, window, [HELLO, onHello, true]);
  fire(READY, "");

  /* ---- WebSocket frames ---- */
  const prefix = Math.random().toString(36).slice(2, 10);
  let seq = 0;
  const ids = new WeakMap();
  const open = new Map(); // id -> socket, so the monitor can send on it

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
  // The frame payload, or a promise of it for Blobs. Other objects (the
  // socket turns them into text itself) aren't converted a second time here.
  function encode(data) {
    if (typeof data === "string") return { op: 1, size: utf8Length(data), data: data.slice(0, MAX_DATA), truncated: data.length > MAX_DATA };
    if (data instanceof ArrayBuffer) return binary(new Uint8Array(data));
    if (ArrayBuffer.isView(data)) return binary(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    if (data instanceof Blob) return new Response(data).arrayBuffer().then((b) => binary(new Uint8Array(b)));
    return { op: 1, size: 0, data: null, truncated: false };
  }
  function frame(ws, dir, data, resent) {
    const id = apply(wmGet, ids, [ws]);
    if (!id) return;
    const t = apply(now, Date, []);
    try {
      const p = encode(data);
      if (p instanceof Promise) p.then((x) => post({ k: "msg", id, dir, t, resent, ...x }), () => {});
      else post({ k: "msg", id, dir, t, resent, ...p });
    } catch { /* ignore */ }
  }
  function track(ws) {
    const id = prefix + ":" + ++seq;
    apply(wmSet, ids, [ws, id]);
    apply(mapSet, open, [id, ws]);
    const url = apply(wsUrl, ws, []);
    post({ k: "new", id, url, t: apply(now, Date, []) });
    apply(listen, ws, ["open", () => post({ k: "open", id, url, protocol: ws.protocol, extensions: ws.extensions, t: apply(now, Date, []) })]);
    apply(listen, ws, ["message", (ev) => frame(ws, "recv", ev.data)]);
    apply(listen, ws, ["error", () => post({ k: "error", id, t: apply(now, Date, []) })]);
    apply(listen, ws, ["close", (ev) => {
      apply(mapDelete, open, [id]);
      post({ k: "close", id, code: ev.code, reason: ev.reason, wasClean: ev.wasClean, t: apply(now, Date, []) });
    }]);
  }

  const nativeSend = NativeWS.prototype.send;
  NativeWS.prototype.send = new Proxy(nativeSend, {
    apply(target, self, args) {
      let result;
      try { result = apply(target, self, args); } catch (e) { throw scrub(e); } // throws while still connecting, like the original
      frame(self, "send", args[0]);
      return result;
    },
  });

  // Sends from the monitor's Resend / Edit and resend, relayed by ws-relay.js.
  function onCommand(ev) {
    let cmd;
    try { cmd = apply(parse, JSON, [ev.detail]); } catch { return; }
    const reply = (ok, error) => post({ k: "result", reqId: cmd.reqId, ok, error });
    const ws = apply(mapGet, open, [cmd.id]);
    if (!ws) { reply(false, "The connection is gone (closed, or the page was reloaded)."); return; }
    if (ws.readyState !== 1) { reply(false, ws.readyState === 0 ? "The connection isn't open yet." : "The connection is closed."); return; }
    try {
      let payload = String(cmd.data);
      if (cmd.op === 2) {
        const s = atob(payload);
        payload = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) payload[i] = s.charCodeAt(i);
      }
      apply(nativeSend, ws, [payload]);
      frame(ws, "send", payload, true);
      reply(true);
    } catch (err) {
      reply(false, String(err && err.message || err));
    }
  }

  /* ---- initiators: which script made each request ---- */

  // The first stack frame outside this script, e.g. "https://x/app.js:120:15".
  // Firefox writes frames as "fn@url:line:col", Chrome as "    at fn (url:line:col)"
  // or "    at url:line:col". A page's Error.prepareStackTrace (Chrome) would
  // see this script's frames, so it's set aside meanwhile; if the page made
  // it a getter/setter (which would notice), no initiator is noted.
  function caller() {
    let stack = "";
    const prep = Object.getOwnPropertyDescriptor(NativeError, "prepareStackTrace");
    if (prep && !("value" in prep)) return null;
    try {
      if (prep) NativeError.prepareStackTrace = undefined;
      stack = new NativeError().stack || "";
    } finally {
      if (prep) NativeError.prepareStackTrace = prep.value;
    }
    if (typeof stack !== "string") return null;
    for (const line of stack.split("\n")) {
      let loc;
      const chrome = /^\s*at (?:.*?\()?(.+?:\d+:\d+)\)?\s*$/.exec(line);
      if (chrome) loc = chrome[1].replace(/^async /, "");
      else {
        const at = line.lastIndexOf("@");
        if (at < 0) continue;
        loc = line.slice(at + 1).replace(/ line \d+ > .*$/, "");
      }
      // Skip this script's own frames: Firefox may call a MAIN-world script
      // "<anonymous code>", Chrome names it chrome-extension://….
      if (!loc || (selfFile && loc.startsWith(selfFile)) || /^(moz|chrome)-extension:/.test(loc) || loc.startsWith("<")) continue;
      return { url: loc.replace(/:\d+:\d+$/, ""), loc };
    }
    return null;
  }

  // A request's URL, only from things that can't run the page's code: plain
  // strings, and URL and Request objects (read with the original getters).
  function urlOf(x) {
    try {
      if (typeof x === "string") return x;
      if (x instanceof NativeURL) return apply(urlHref, x, []);
      if (requestUrl && x instanceof Request) return apply(requestUrl, x, []);
    } catch { /* not what it claims */ }
    return null;
  }

  function hint(kind, url) {
    try {
      if (url == null || url === "") return;
      const abs = apply(urlHref, new NativeURL(url, apply(baseURI, document, [])), []);
      if (!/^(https?|wss?):/.test(abs)) return;
      const by = caller();
      if (by) post({ k: "init", kind, url: abs, by: by.url, loc: by.loc, t: apply(now, Date, []) });
    } catch { /* never break the page */ }
  }

  const wrapCall = (obj, name, kind, urlArg) => {
    const fn = obj && obj[name];
    if (typeof fn !== "function") return;
    obj[name] = new Proxy(fn, {
      apply(target, self, args) {
        hint(kind, urlOf(urlArg(args)));
        try { return apply(target, self, args); } catch (e) { throw scrub(e); }
      },
    });
  };
  wrapCall(window, "fetch", "fetch", (a) => a[0]);
  wrapCall(XMLHttpRequest.prototype, "open", "xhr", (a) => a[1]);
  wrapCall(Navigator.prototype, "sendBeacon", "beacon", (a) => a[0]);

  if (window.EventSource) {
    const NativeES = window.EventSource;
    const WrappedES = new Proxy(NativeES, {
      construct(target, args, newTarget) {
        hint("eventsource", urlOf(args[0]));
        try { return construct(target, args, newTarget === WrappedES ? target : newTarget); } catch (e) { throw scrub(e); }
      },
    });
    NativeES.prototype.constructor = WrappedES;
    window.EventSource = WrappedES;
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
          hint("element", urlOf(args[0]));
          try { return apply(target, self, args); } catch (e) { throw scrub(e); }
        },
      }),
    });
  }
  const loads = (el, name) => {
    if (typeof name !== "string") return false; // never convert the page's objects
    const n = name.toLowerCase();
    if (n === "src") return el instanceof HTMLScriptElement || el instanceof HTMLImageElement || el instanceof HTMLIFrameElement || el instanceof HTMLSourceElement || el instanceof HTMLMediaElement;
    return n === "href" && el instanceof HTMLLinkElement;
  };
  Element.prototype.setAttribute = new Proxy(Element.prototype.setAttribute, {
    apply(target, self, args) {
      if (loads(self, args[0])) hint("element", urlOf(args[1]));
      try { return apply(target, self, args); } catch (e) { throw scrub(e); }
    },
  });

  const WrappedWS = new Proxy(NativeWS, {
    construct(target, args, newTarget) {
      let ws;
      try { ws = construct(target, args, newTarget === WrappedWS ? target : newTarget); } catch (e) { throw scrub(e); }
      try { const url = apply(wsUrl, ws, []); hint("websocket", url); track(ws); } catch { /* never break the page */ }
      return ws;
    },
  });
  NativeWS.prototype.constructor = WrappedWS;
  window.WebSocket = WrappedWS;
})();
