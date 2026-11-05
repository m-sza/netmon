"use strict";

/* Runs first in every context (background, panel, content script).
 *
 * Firefox: nothing to do; `browser` is native.
 * Chrome: provides `browser` on top of `chrome`, and makes messaging binary-safe.
 * (Recent Chrome versions have a built-in `browser` too, so the browser is told
 * apart by its extension URLs, and the built-in one is replaced: it has the same
 * JSON-only messaging.)
 * Chrome serializes extension messages as JSON, which turns an ArrayBuffer (a
 * response body) into {}; here they are sent as base64 and turned back into
 * ArrayBuffers on arrival, so the rest of the code is the same in both. */
var IS_CHROME = !(globalThis.browser || globalThis.chrome).runtime.getURL("").startsWith("moz-extension:");

if (IS_CHROME) {
  const TAG = "__nm_ab";

  const toB64 = (buf) => {
    const bytes = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const fromB64 = (b64) => {
    const s = atob(b64);
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return bytes.buffer;
  };

  const encode = (v) => {
    if (v instanceof ArrayBuffer) return { [TAG]: toB64(v) };
    if (ArrayBuffer.isView(v)) return { [TAG]: toB64(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)) };
    if (Array.isArray(v)) return v.map(encode);
    if (v && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v)) out[k] = encode(v[k]);
      return out;
    }
    return v;
  };
  const decode = (v) => {
    if (Array.isArray(v)) return v.map(decode);
    if (v && typeof v === "object") {
      if (typeof v[TAG] === "string" && Object.keys(v).length === 1) return fromB64(v[TAG]);
      for (const k of Object.keys(v)) v[k] = decode(v[k]);
    }
    return v;
  };

  // Listeners may return a Promise (as in Firefox); its value is encoded for the reply.
  const wrapMessageListener = (fn) => (msg, sender, sendResponse) => {
    const result = fn(decode(msg), sender);
    if (result && typeof result.then === "function") {
      result.then((value) => sendResponse(encode(value)), () => sendResponse(undefined));
      return true;
    }
    return false;
  };
  const messageEvent = (ev) => {
    const wrapped = new Map();
    return {
      addListener(fn) { const w = wrapMessageListener(fn); wrapped.set(fn, w); ev.addListener(w); },
      removeListener(fn) { ev.removeListener(wrapped.get(fn)); wrapped.delete(fn); },
      hasListener(fn) { return wrapped.has(fn); },
    };
  };

  const wrapPort = (port) => {
    const listeners = new Map();
    return {
      get name() { return port.name; },
      get sender() { return port.sender; },
      postMessage: (m) => port.postMessage(encode(m)),
      disconnect: () => port.disconnect(),
      onMessage: {
        addListener(fn) { const w = (m, p) => fn(decode(m), p); listeners.set(fn, w); port.onMessage.addListener(w); },
        removeListener(fn) { port.onMessage.removeListener(listeners.get(fn)); listeners.delete(fn); },
      },
      onDisconnect: port.onDisconnect,
    };
  };

  const passThrough = (target, overrides) => new Proxy(target, {
    get(t, key) {
      if (key in overrides) return overrides[key];
      const v = t[key];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });

  const runtime = passThrough(chrome.runtime, {
    sendMessage: (msg) => chrome.runtime.sendMessage(encode(msg)).then(decode),
    onMessage: messageEvent(chrome.runtime.onMessage),
    connect: (info) => wrapPort(chrome.runtime.connect(info)),
    onConnect: {
      addListener: (fn) => chrome.runtime.onConnect.addListener((p) => fn(wrapPort(p))),
    },
  });
  const tabs = chrome.tabs && passThrough(chrome.tabs, {
    sendMessage: (tabId, msg, options) => chrome.tabs.sendMessage(tabId, encode(msg), options || {}).then(decode),
  });

  globalThis.browser = passThrough(chrome, { runtime, ...(tabs ? { tabs } : {}) });
}
