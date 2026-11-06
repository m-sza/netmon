"use strict";

/* Content script: forwards WebSocket events from page-hook.js to the background,
 * batched so busy sockets don't send one message per frame. */
(() => {
  const EVT = "__netmon_ws__";
  const CMD = "__netmon_ws_cmd__";
  const pending = new Map(); // reqId -> resolve, for sends from the monitor
  let nextReq = 1;
  const MAX_BATCH_CHARS = 16 * 1024 * 1024;
  let queue = [];
  let chars = 0;
  let timer = null;

  function flush() {
    timer = null;
    if (!queue.length) return;
    const events = queue;
    queue = [];
    chars = 0;
    browser.runtime.sendMessage({ cmd: "ws", events }).catch(() => { /* background busy or reloading */ });
  }

  window.addEventListener(EVT, (ev) => {
    const detail = ev.detail;
    if (typeof detail !== "string") return;
    if (detail.startsWith('{"k":"result"')) {
      try {
        const r = JSON.parse(detail);
        const done = pending.get(r.reqId);
        if (done) { pending.delete(r.reqId); done({ ok: !!r.ok, error: r.error ? String(r.error) : undefined }); }
      } catch { /* ignore */ }
      return;
    }
    queue.push(detail);
    chars += detail.length;
    if (chars > MAX_BATCH_CHARS) flush();
    else if (!timer) timer = setTimeout(flush, 100);
  }, true);

  // Load milestones of the top-level page, as absolute times like request
  // timestamps, for the overview's DOMContentLoaded and Load lines.
  if (window.top === window) {
    const report = () => {
      const nav = performance.getEntriesByType && performance.getEntriesByType("navigation")[0];
      if (!nav) return;
      const at = (v) => (v > 0 ? performance.timeOrigin + v : undefined);
      browser.runtime.sendMessage({ cmd: "pageTiming", nav: performance.timeOrigin, dcl: at(nav.domContentLoadedEventStart), load: at(nav.loadEventStart) })
        .catch(() => { /* background reloading */ });
    };
    document.addEventListener("DOMContentLoaded", report, { once: true });
    window.addEventListener("load", () => setTimeout(report, 0), { once: true });
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.cmd !== "wsSend") return undefined;
    const reqId = nextReq++;
    return new Promise((resolve) => {
      pending.set(reqId, resolve);
      setTimeout(() => {
        if (pending.delete(reqId)) resolve({ ok: false, error: "The page didn't respond." });
      }, 3000);
      window.dispatchEvent(new CustomEvent(CMD, { detail: JSON.stringify({ reqId, id: msg.id, op: msg.op, data: msg.data }) }));
    });
  });
})();
