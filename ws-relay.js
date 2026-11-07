"use strict";

/* Content script (isolated world), on the same sites as page-hook.js:
 * forwards its events to the background, batched so busy sockets don't send
 * one message per frame, and passes the monitor's WebSocket sends to it.
 *
 * Handshake (see page-hook.js): whichever of the two loads first, this answers
 * the hook's READY (or greets it straight away) with HELLO, carrying two
 * random event names; once the hook confirms, the fixed names aren't
 * listened to any more. Both run before the page's own scripts. */
(() => {
  /* One working relay per frame. After the add-on updates, the old copy can
   * no longer reach the background; it then steps aside for the new one. */
  const alive = () => { try { return !!browser.runtime.id; } catch { return false; } };
  const prev = globalThis.__netmonRelay;
  if (prev && prev.alive()) return;
  globalThis.__netmonRelay = { alive };

  const READY = "netmon-hook-ready", HELLO = "netmon-hook-hello";
  const rand = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => (b % 36).toString(36)).join("");
  const OUT = rand(); // hook -> relay
  const CMD = rand(); // relay -> hook
  const greet = () => window.dispatchEvent(new CustomEvent(HELLO, { detail: JSON.stringify({ out: OUT, cmd: CMD }) }));

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

  window.addEventListener(OUT, function onEvent(ev) {
    if (!alive()) { window.removeEventListener(OUT, onEvent, true); return; } // an update replaced this copy
    const detail = ev.detail;
    if (typeof detail !== "string") return;
    if (detail === '{"k":"bound"}') { window.removeEventListener(READY, greet, true); return; }
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

  // Only now, with the listener for the hook's messages in place: the hook
  // answers (and sends what it has so far) as soon as it's greeted.
  window.addEventListener(READY, greet, true);
  greet();

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
