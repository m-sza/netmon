"use strict";

/* ---------------------------------------------------------------------------
 * Configuration
 * ------------------------------------------------------------------------- */
const MAX_ENTRIES = 5000;                         // oldest requests are dropped beyond this
const MAX_BODY_BYTES = 5 * 1024 * 1024;           // per request / response body
const MAX_TOTAL_BODY_BYTES = 300 * 1024 * 1024;   // memory budget for all stored bodies
const NO_BODY_TYPES = new Set(["media", "websocket"]); // streams: don't intercept
const FLUSH_MS = 200;                             // how often the panel receives updates

const OWN_ORIGIN = browser.runtime.getURL("");
const OWN_ORIGIN_BARE = OWN_ORIGIN.replace(/\/$/, ""); // Chrome reports initiators without the slash
const PANEL_URL = browser.runtime.getURL("panel.html");
const ALL_URLS = { urls: ["<all_urls>"] };
const action = browser.action || browser.browserAction; // MV3 (Chrome) / MV2 (Firefox)

// webRequest options differ: Chrome (MV3) has no "blocking" for normal
// extensions, and only shows headers like Cookie with "extraHeaders".
function spec(...opts) {
  if (!IS_CHROME) return opts;
  const out = opts.filter(o => o !== "blocking");
  if (out.some(o => o === "requestHeaders" || o === "responseHeaders")) out.push("extraHeaders");
  return out;
}

// Chrome stops an idle MV3 service worker after 30 s, which would drop
// everything recorded in memory. Calling an extension API resets that timer.
if (IS_CHROME) setInterval(() => browser.runtime.getPlatformInfo(), 20000);

const settings = { recording: true, captureBodies: true };

/* ---------------------------------------------------------------------------
 * State
 * ------------------------------------------------------------------------- */
const entries = new Map();  // our id -> entry (insertion order = chronological)
const active = new Map();   // Firefox requestId -> entry currently in flight
let nextId = 1;
let totalBodyBytes = 0;

const ports = new Set();
const dirty = new Set();
let removedIds = [];
let flushTimer = null;

const blockedUrls = new Set();          // exact URLs the user chose to block
const pendingResends = [];              // resends we started, waiting for onBeforeRequest
const resentRequests = new Map();       // requestId -> tab the original request came from

/* ---------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */
function normHeaders(list) {
  return (list || []).map(h => ({
    name: h.name,
    value: h.value !== undefined ? h.value
      : h.binaryValue ? String.fromCharCode(...h.binaryValue) : "",
  }));
}

function touch(e) {
  e.rev++;
  if (!ports.size || e.removed) return;
  dirty.add(e.id);
  scheduleFlush();
}

function scheduleFlush() {
  if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
}

function flush() {
  flushTimer = null;
  if (!ports.size) { dirty.clear(); removedIds = []; return; }
  const list = [];
  for (const id of dirty) {
    const e = entries.get(id);
    if (e) list.push(summarize(e));
  }
  dirty.clear();
  const msg = { type: "update", entries: list, removed: removedIds };
  removedIds = [];
  broadcast(msg);
}

function broadcast(msg) {
  for (const p of ports) {
    try { p.postMessage(msg); } catch { /* port closed */ }
  }
}

function dropEntry(e) {
  entries.delete(e.id);
  if (active.get(e.requestId) === e) active.delete(e.requestId);
  totalBodyBytes -= e.storedBytes + (e.ws ? e.ws.bytes : 0);
  e.chunks = [];
  e.storedBytes = 0;
  if (e.ws) { e.ws.messages = []; e.ws.bytes = 0; }
  e.removed = true;
  dirty.delete(e.id);
  if (ports.size) { removedIds.push(e.id); scheduleFlush(); }
}

function evictIfNeeded() {
  while (entries.size > MAX_ENTRIES) {
    dropEntry(entries.values().next().value);
  }
}

// Drop stored bodies of the oldest finished requests until we're back under budget.
function enforceBodyBudget() {
  if (totalBodyBytes <= MAX_TOTAL_BODY_BYTES) return;
  for (const e of entries.values()) {
    if (e.storedBytes && e.bodyState !== "capturing") {
      totalBodyBytes -= e.storedBytes;
      e.chunks = [];
      e.storedBytes = 0;
      e.bodyState = "evicted";
      touch(e);
      if (totalBodyBytes <= MAX_TOTAL_BODY_BYTES * 0.9) break;
    }
  }
}

function serializeRequestBody(rb) {
  if (rb.error) return { error: rb.error };
  if (rb.formData) {
    const fd = {};
    for (const [k, v] of Object.entries(rb.formData)) fd[k] = Array.from(v, String);
    return { formData: fd };
  }
  if (rb.raw) {
    const bufs = [];
    const files = [];
    let n = 0;
    let truncated = false;
    for (const part of rb.raw) {
      if (part.bytes) {
        const take = Math.min(part.bytes.byteLength, MAX_BODY_BYTES - n);
        if (take > 0) { bufs.push(part.bytes.slice(0, take)); n += take; }
        if (take < part.bytes.byteLength) truncated = true;
      } else if (part.file) {
        files.push(part.file);
      }
    }
    return { raw: NM.concat(bufs), files, truncated };
  }
  return null;
}

function applyResponse(e, d) {
  if (d.statusCode !== undefined) e.status = d.statusCode;
  if (d.statusLine) {
    e.statusLine = d.statusLine;
    const m = /^(\S+)\s+\d{3}\s*(.*)$/.exec(d.statusLine);
    if (m) {
      // Chrome's status line always says HTTP/1.1, even for HTTP/2 and 3; the
      // debugger's protocol, when known, is the real one.
      if (!e.httpVersionKnown) e.httpVersion = m[1];
      e.statusText = m[2];
    }
  }
  if (d.responseHeaders) {
    e.responseHeaders = normHeaders(d.responseHeaders);
    const ct = NM.parseContentType(NM.header(e.responseHeaders, "content-type"));
    e.mimeType = ct.mime;
    e.charset = ct.charset;
    const cl = NM.header(e.responseHeaders, "content-length");
    e.contentLength = cl != null && /^\d+$/.test(cl.trim()) ? Number(cl) : null;
  }
  if (d.ip) e.ip = d.ip;
  if (d.fromCache !== undefined) e.fromCache = d.fromCache;
}

function publicSettings() {
  return { ...settings, blocked: [...blockedUrls], blockers };
}

// Other add-ons that can block requests. Firefox gives extensions only the
// error code (NS_ERROR_ABORT) for a request another add-on cancelled, not which
// add-on did it; with a single possible blocker installed, that's the one.
let blockers = [];
const BLOCKING_PERMISSIONS = ["webRequestBlocking", "declarativeNetRequest", "declarativeNetRequestWithHostAccess"];

async function refreshBlockers() {
  try {
    const all = await browser.management.getAll();
    blockers = all
      .filter(x => x.type === "extension" && x.enabled && x.id !== browser.runtime.id &&
                   (x.permissions || []).some(p => BLOCKING_PERMISSIONS.includes(p)))
      .map(x => x.name)
      .sort();
  } catch {
    blockers = [];
  }
  broadcast({ type: "settings", settings: publicSettings() });
}
refreshBlockers();
for (const ev of ["onInstalled", "onUninstalled", "onEnabled", "onDisabled"]) {
  browser.management[ev].addListener(() => refreshBlockers());
}

// Our own fetches (Resend) carry the extension's origin; map them back to the
// tab of the request they repeat so they show up next to it.
function claimResend(d) {
  if (resentRequests.has(d.requestId)) return { tabId: resentRequests.get(d.requestId) };
  const now = Date.now();
  while (pendingResends.length && now - pendingResends[0].at > 60000) pendingResends.shift();
  const i = pendingResends.findIndex(r => r.url === d.url && r.method === d.method);
  const tabId = i >= 0 ? pendingResends.splice(i, 1)[0].tabId : -1;
  resentRequests.set(d.requestId, tabId);
  return { tabId };
}

function finish(e, d, state) {
  e.end = d.timeStamp;
  e.times.end = d.timeStamp;
  e.state = state;
  if (state !== "redirect") resentRequests.delete(d.requestId);
  // A redirected or failed request may never get onstop from its body filter.
  if (e.bodyState === "capturing" && state === "redirect") { e.bodyState = "done"; e.bodySize = e.seenBytes; }
  if (e.bodyState === "capturing" && state === "error") e.bodyState = e.storedBytes ? "partial" : "error";
  if (active.get(d.requestId) === e) active.delete(d.requestId);
  // Chrome: the debugger delivers the body shortly after the request ends; if it
  // doesn't (tab not attached yet, a chrome:// page), say so instead of waiting forever.
  if (IS_CHROME && e.bodyState === "capturing") {
    setTimeout(() => {
      if (e.bodyState !== "capturing") return;
      e.bodyState = state === "complete" ? "unavailable" : "none";
      if (state === "complete") e.bodyError = debuggerNote(e.tabId);
      touch(e);
    }, 5000);
  }
  touch(e);
}

/* ---------------------------------------------------------------------------
 * Response body capture (Firefox-only filterResponseData)
 * ------------------------------------------------------------------------- */
function attachFilter(e) {
  let filter;
  try {
    filter = browser.webRequest.filterResponseData(e.requestId);
  } catch (err) {
    e.bodyState = "unavailable";
    e.bodyError = String(err && err.message || err);
    return;
  }
  e.bodyState = "capturing";

  filter.ondata = (ev) => {
    const data = ev.data;
    // No useful Content-Type (often a 304 revalidation, or a server that omits
    // it): note what the body really is, from its first bytes.
    if (!e.seenBytes && NM.isGenericMime(e.mimeType)) e.sniffedMime = NM.sniffMime(data);
    let keep = 0;
    if (!e.removed) keep = Math.min(data.byteLength, MAX_BODY_BYTES - e.storedBytes);
    if (keep > 0) {
      e.chunks.push(data.slice(0, keep));
      e.storedBytes += keep;
      totalBodyBytes += keep;
    }
    e.seenBytes += data.byteLength;
    filter.write(data); // always pass the data through untouched

    if (e.removed) { filter.disconnect(); return; }
    if (keep < data.byteLength) {
      // Hit the per-body limit: stop intercepting, let the rest flow normally.
      e.bodyState = "truncated";
      filter.disconnect();
      touch(e);
    }
    enforceBodyBudget();
  };

  filter.onstop = () => {
    try { filter.close(); } catch { /* already closed */ }
    if (e.bodyState === "capturing") {
      e.bodyState = "done";
      e.bodySize = e.seenBytes;
    }
    touch(e);
  };

  filter.onerror = () => {
    if (e.bodyState === "capturing") {
      e.bodyState = e.storedBytes ? "partial" : "error";
      e.bodyError = filter.error;
      touch(e);
    }
  };
}

/* ---------------------------------------------------------------------------
 * webRequest listeners
 * ------------------------------------------------------------------------- */
function makeEntry(d) {
  return {
    id: nextId++,
    requestId: d.requestId,
    url: d.url,
    method: d.method,
    type: d.type,
    tabId: d.tabId,
    resent: false,
    blocked: false,
    frameId: d.frameId,
    parentFrameId: d.parentFrameId ?? -1,
    originUrl: d.originUrl ?? requestOrigin(d),
    documentUrl: d.documentUrl ?? frameDocument(d),
    thirdParty: !!d.thirdParty,
    // Firefox's tracking-protection labels for the URL (e.g. "tracking_ad").
    classification: d.urlClassification
      ? [...new Set([...(d.urlClassification.firstParty || []), ...(d.urlClassification.thirdParty || [])])]
      : [],
    start: d.timeStamp,
    times: { start: d.timeStamp },
    end: null,
    state: "pending",
    status: null,
    statusLine: "",
    statusText: "",
    httpVersion: "",
    ip: null,
    fromCache: false,
    requestHeaders: [],
    responseHeaders: [],
    requestBody: d.requestBody ? serializeRequestBody(d.requestBody) : null,
    mimeType: "",
    sniffedMime: "",
    charset: "",
    contentLength: null,
    requestSize: null,
    responseSize: null,
    chunks: [],
    storedBytes: 0,
    seenBytes: 0,
    bodySize: null,
    bodyState: "none",
    bodyError: null,
    error: null,
    redirectUrl: null,
    security: null,
    ws: null,
    redirectedFrom: null,   // id of the request that redirected here
    initiator: "",          // script that started this request, if the page hook saw it
    initiatorLoc: "",       // …with line and column
    removed: false,
    rev: 0,
  };
}

/* Chrome doesn't say which document a request came from (Firefox's documentUrl
 * and originUrl); it's the latest document loaded in the request's frame. */
const frameDocs = new Map(); // "tabId:frameId" -> URL of the frame's document

function frameDocument(d) {
  if (d.type === "main_frame") return "";
  return frameDocs.get(`${d.tabId}:${d.type === "sub_frame" ? d.parentFrameId : d.frameId}`) || "";
}
function requestOrigin(d) {
  return d.type === "main_frame" ? "" : frameDocument(d) || d.initiator || "";
}
function noteFrameDocument(d) {
  if (d.type !== "main_frame" && d.type !== "sub_frame") return;
  if (d.type === "main_frame") for (const k of frameDocs.keys()) if (k.startsWith(d.tabId + ":")) frameDocs.delete(k);
  frameDocs.set(`${d.tabId}:${d.frameId}`, d.url);
}
browser.tabs.onRemoved.addListener((tabId) => {
  for (const k of frameDocs.keys()) if (k.startsWith(tabId + ":")) frameDocs.delete(k);
});

function onBeforeRequest(d) {
  // The extension's own files (Chrome reports them; Firefox doesn't). A panel
  // page loading tells us which tab is the monitor, however it was opened.
  if (d.url.startsWith(OWN_ORIGIN_BARE)) {
    if (d.type === "main_frame" && d.url.startsWith(PANEL_URL)) panelTabId = d.tabId;
    return undefined;
  }
  const block = blockedUrls.has(d.url) ? { cancel: true } : undefined; // Chrome blocks with DNR rules instead
  const origin = d.originUrl || d.initiator || "";
  const doc = d.documentUrl || "";
  // The monitor's own traffic (including what an HTML preview loads) isn't recorded.
  if (origin.startsWith(PANEL_URL) || doc.startsWith(PANEL_URL) || (panelTabId !== null && d.tabId === panelTabId)) return block;
  const resent = origin.startsWith(OWN_ORIGIN_BARE) || doc.startsWith(OWN_ORIGIN_BARE) ? claimResend(d) : null;
  if (!settings.recording && !resent) return block;

  const e = makeEntry(d);
  if (IS_CHROME) noteFrameDocument(d);
  e.tabId = resent ? resent.tabId : d.tabId;
  e.resent = !!resent;
  e.blocked = !!block;
  if (redirectSources.has(d.requestId)) {
    e.redirectedFrom = redirectSources.get(d.requestId);
    redirectSources.delete(d.requestId);
  }
  noteRecent(e);
  entries.set(e.id, e);
  active.set(d.requestId, e);
  evictIfNeeded();

  if (block) { touch(e); return block; }
  if (d.type === "websocket") bindWaitingSockets(e.tabId);

  if (!settings.captureBodies) e.bodyState = "off";
  else if (NO_BODY_TYPES.has(d.type)) e.bodyState = "skipped";
  else if (IS_CHROME) e.bodyState = "capturing"; // filled in by the debugger (see below)
  else attachFilter(e);

  touch(e);
}

browser.webRequest.onBeforeRequest.addListener(onBeforeRequest, ALL_URLS, spec("blocking", "requestBody"));

browser.webRequest.onSendHeaders.addListener((d) => {
  const e = active.get(d.requestId);
  if (!e) return;
  e.requestHeaders = normHeaders(d.requestHeaders);
  e.times.sendHeaders = d.timeStamp;
  touch(e);
}, ALL_URLS, spec("requestHeaders"));

browser.webRequest.onHeadersReceived.addListener((d) => {
  const e = active.get(d.requestId);
  if (!e) return;
  applyResponse(e, d);
  e.times.headersReceived = d.timeStamp;
  if (!IS_CHROME && /^(https|wss):/.test(e.url)) captureSecurity(e, d.requestId); // Chrome: from the debugger
  touch(e);
}, ALL_URLS, spec("blocking", "responseHeaders"));

// TLS details. getSecurityInfo only works inside a blocking onHeadersReceived
// listener; we don't wait for it, so responses aren't held up.
const certChains = new Map(); // leaf sha256 -> chain, shared by requests to the same server
const MAX_CERT_CHAINS = 500;

function captureSecurity(e, requestId) {
  browser.webRequest.getSecurityInfo(requestId, { certificateChain: true }).then((info) => {
    const { certificates = [], ...rest } = info;
    const leaf = certificates[0] && certificates[0].fingerprint && certificates[0].fingerprint.sha256;
    let chain = certificates;
    if (leaf) {
      if (certChains.has(leaf)) chain = certChains.get(leaf);
      else {
        if (certChains.size >= MAX_CERT_CHAINS) certChains.delete(certChains.keys().next().value);
        certChains.set(leaf, certificates);
      }
    }
    e.security = { ...rest, certificates: chain };
    touch(e);
  }, (err) => {
    e.security = { error: String(err && err.message || err) };
    touch(e);
  });
}

browser.webRequest.onResponseStarted.addListener((d) => {
  const e = active.get(d.requestId);
  if (!e) return;
  applyResponse(e, d);
  e.times.responseStarted = d.timeStamp;
  touch(e);
}, ALL_URLS, spec("responseHeaders"));

browser.webRequest.onBeforeRedirect.addListener((d) => {
  const e = active.get(d.requestId);
  if (!e) return;
  applyResponse(e, d);
  e.redirectUrl = d.redirectUrl;
  // Firefox keeps the request id across a redirect; the next onBeforeRequest
  // with this id is the redirect target.
  redirectSources.set(d.requestId, e.id);
  if (redirectSources.size > 1000) redirectSources.delete(redirectSources.keys().next().value);
  finish(e, d, "redirect");
}, ALL_URLS, spec("responseHeaders"));

browser.webRequest.onCompleted.addListener((d) => {
  const e = active.get(d.requestId);
  if (!e) return;
  applyResponse(e, d);
  if (typeof d.requestSize === "number") e.requestSize = d.requestSize;
  if (typeof d.responseSize === "number") e.responseSize = d.responseSize;
  finish(e, d, "complete");
}, ALL_URLS, spec("responseHeaders"));

browser.webRequest.onErrorOccurred.addListener((d) => {
  const e = active.get(d.requestId);
  if (!e) return;
  e.error = e.blocked ? "Blocked" : d.error;
  if (d.ip) e.ip = d.ip;
  finish(e, d, "error");
}, ALL_URLS);

/* ---------------------------------------------------------------------------
 * Request tree links
 *
 * Firefox tells us the document a request came from, not the script. The page
 * hook reports "script X asked for URL Y"; those reports are matched to the
 * recorded request with the same tab and URL started around the same time.
 * ------------------------------------------------------------------------- */
const redirectSources = new Map(); // Firefox requestId -> id of the entry that redirected
const recent = [];                 // the latest entries, newest last, for matching reports
const MAX_RECENT = 600;
let pendingHints = [];             // reports that arrived before their request

function noteRecent(e) {
  if (IS_CHROME) bindWaitingDebuggerRequest(e);
  recent.push(e);
  if (recent.length > MAX_RECENT) recent.splice(0, recent.length - MAX_RECENT);
  if (pendingHints.length) {
    const key = stripHash(e.url);
    const i = pendingHints.findIndex(h => h.tabId === e.tabId && h.url === key && Math.abs(h.t - e.start) < 5000);
    if (i >= 0) {
      const [h] = pendingHints.splice(i, 1);
      e.initiator = h.by;
      e.initiatorLoc = h.loc;
    }
  }
}

function onInitiatorHint(tabId, ev) {
  if (typeof ev.url !== "string" || typeof ev.by !== "string") return;
  const url = stripHash(ev.url);
  const t = Number(ev.t) || Date.now();
  for (let i = recent.length - 1; i >= 0; i--) {
    const e = recent[i];
    if (e.tabId === tabId && !e.initiator && !e.removed && stripHash(e.url) === url && Math.abs(e.start - t) < 5000) {
      e.initiator = ev.by.slice(0, 2000);
      e.initiatorLoc = String(ev.loc || "").slice(0, 2000);
      touch(e);
      return;
    }
  }
  const now = Date.now();
  pendingHints = pendingHints.filter(h => now - h.at < 10000);
  if (pendingHints.length < 500) pendingHints.push({ tabId, url, by: ev.by.slice(0, 2000), loc: String(ev.loc || "").slice(0, 2000), t, at: now });
}

/* ---------------------------------------------------------------------------
 * WebSocket frames
 *
 * webRequest only sees the handshake. page-hook.js wraps WebSocket in each page
 * and ws-relay.js forwards its events here; each page socket is matched to
 * the handshake request with the same tab and URL.
 * ------------------------------------------------------------------------- */
const WS_SCRIPT_ID = "netmon-ws-page";
const MAX_WS_MESSAGES = 10000;               // per socket; oldest are dropped beyond this
const MAX_WS_BYTES = 32 * 1024 * 1024;       // per socket
const MAX_SOCKETS = 2000;

const sockets = new Map(); // "tabId/frameId/pageId" -> { tabId, frameId, url, created, docUrl, entry, early }

(async () => {
  const script = {
    id: WS_SCRIPT_ID,
    js: ["page-hook.js"],
    matches: ["<all_urls>"],
    runAt: "document_start",
    allFrames: true,
    world: "MAIN",
  };
  try {
    const existing = await browser.scripting.getRegisteredContentScripts({ ids: [WS_SCRIPT_ID] });
    if (existing.length) await browser.scripting.updateContentScripts([script]);
    else await browser.scripting.registerContentScripts([script]);
  } catch (err) {
    console.error("Couldn't register the WebSocket hook:", err);
  }
})();

// ws:// and the http:// form the handshake may be reported under are the same socket.
const wsKey = (url) => String(url || "").replace(/^ws(s?):/i, "http$1:");

function newWsState() {
  return { messages: [], dropped: 0, bytes: 0, sent: 0, received: 0, open: null, closed: null, error: false, protocol: "", extensions: "" };
}

function tryBind(sock) {
  if (sock.entry) return true;
  const key = wsKey(sock.url);
  for (const e of entries.values()) {
    if (e.type === "websocket" && !e.ws && e.tabId === sock.tabId &&
        e.start >= sock.created - 5000 && wsKey(e.url) === key) {
      e.ws = newWsState();
      e.wsLink = { tabId: sock.tabId, frameId: sock.frameId, pageId: sock.pageId };
      sock.entry = e;
      for (const ev of sock.early) applyWsEvent(e, ev);
      sock.early = [];
      touch(e);
      return true;
    }
  }
  return false;
}

function bindWaitingSockets(tabId) {
  for (const sock of sockets.values()) {
    if (!sock.entry && sock.tabId === tabId) tryBind(sock);
  }
}

// The handshake wasn't recorded (e.g. recording resumed mid-connection, or it was
// evicted): show the socket as its own row so its frames aren't lost.
function synthesizeEntry(sock) {
  if (sock.entry || !settings.recording) return;
  const e = makeEntry({
    requestId: "ws:" + sock.key,
    url: sock.url,
    method: "GET",
    type: "websocket",
    tabId: sock.tabId,
    frameId: sock.frameId,
    documentUrl: sock.docUrl,
    timeStamp: sock.created,
  });
  e.state = "complete";
  e.status = 101;
  e.statusText = "Switching Protocols";
  e.bodyState = "skipped";
  e.end = sock.created;
  e.ws = newWsState();
  e.wsLink = { tabId: sock.tabId, frameId: sock.frameId, pageId: sock.pageId };
  entries.set(e.id, e);
  evictIfNeeded();
  sock.entry = e;
  for (const ev of sock.early) applyWsEvent(e, ev);
  sock.early = [];
  touch(e);
}

function applyWsEvent(e, ev) {
  const ws = e.ws;
  switch (ev.k) {
    case "open":
      ws.open = ev.t;
      ws.protocol = String(ev.protocol || "");
      ws.extensions = String(ev.extensions || "");
      break;
    case "error":
      ws.error = true;
      break;
    case "close":
      ws.closed = { t: ev.t, code: Number(ev.code) || 0, reason: String(ev.reason || ""), wasClean: !!ev.wasClean };
      break;
    case "msg": {
      if (!settings.recording) return;
      const keep = settings.captureBodies && typeof ev.data === "string";
      const m = {
        t: Number(ev.t) || Date.now(),
        dir: ev.dir === "send" ? "send" : "recv",
        op: ev.op === 2 ? 2 : 1,
        size: Number(ev.size) || 0,
        data: keep ? ev.data : null,
        truncated: !!ev.truncated,
        resent: !!ev.resent,
      };
      if (m.dir === "send") ws.sent++; else ws.received++;
      ws.messages.push(m);
      const len = keep ? m.data.length : 0;
      ws.bytes += len;
      totalBodyBytes += len;
      while (ws.messages.length > MAX_WS_MESSAGES || ws.bytes > MAX_WS_BYTES) {
        const old = ws.messages.shift();
        const n = old.data ? old.data.length : 0;
        ws.bytes -= n;
        totalBodyBytes -= n;
        ws.dropped++;
      }
      enforceBodyBudget();
      break;
    }
  }
  touch(e);
}

function onWsEvents(events, sender) {
  if (!sender.tab || !Array.isArray(events)) return;
  const tabId = sender.tab.id;
  const frameId = sender.frameId || 0;
  for (const raw of events) {
    let ev;
    try { ev = JSON.parse(raw); } catch { continue; }
    if (ev && ev.k === "init") { if (settings.recording) onInitiatorHint(tabId, ev); continue; }
    if (!ev || typeof ev.id !== "string") continue;
    const key = `${tabId}/${frameId}/${ev.id}`;
    let sock = sockets.get(key);
    if (!sock) {
      if (ev.k !== "new" && ev.k !== "open") continue;
      if (sockets.size >= MAX_SOCKETS) sockets.delete(sockets.keys().next().value);
      sock = { key, tabId, frameId, pageId: ev.id, url: String(ev.url || ""), created: Number(ev.t) || Date.now(), docUrl: sender.url || "", entry: null, early: [] };
      sockets.set(key, sock);
    }
    if (ev.k === "new") { tryBind(sock); continue; }

    if (sock.entry && !sock.entry.removed) applyWsEvent(sock.entry, ev);
    else if (tryBind(sock)) applyWsEvent(sock.entry, ev);
    else {
      sock.early.push(ev);
      // By "open" the handshake is normally recorded already; give it a moment, then show the socket anyway.
      if (!sock.waiting && (ev.k === "open" || sock.early.length > 50)) {
        sock.waiting = true;
        setTimeout(() => { if (!tryBind(sock)) synthesizeEntry(sock); }, 1000);
      }
    }
    if (ev.k === "close") sockets.delete(key);
  }
}

browser.tabs.onRemoved.addListener((tabId) => {
  for (const [key, sock] of sockets) if (sock.tabId === tabId) sockets.delete(key);
});

// Sends a message on the page's own socket (Resend / Edit and resend). It's
// recorded like any other sent frame when the page hook reports it.
async function wsSend(id, op, data) {
  const e = entries.get(id);
  if (!e || !e.ws || !e.wsLink) return { ok: false, error: "This connection can't be reached from the monitor." };
  if (e.ws.closed) return { ok: false, error: "The connection is closed." };
  const { tabId, frameId, pageId } = e.wsLink;
  try {
    const res = await browser.tabs.sendMessage(tabId, { cmd: "wsSend", id: pageId, op: op === 2 ? 2 : 1, data: String(data) }, { frameId });
    return res || { ok: false, error: "The page didn't respond." };
  } catch (err) {
    return { ok: false, error: "The page is gone or was reloaded." };
  }
}

function wsMessages(id, from) {
  const e = entries.get(id);
  if (!e || !e.ws) return null;
  const ws = e.ws;
  const start = Math.max(0, (Number(from) || 0) - ws.dropped);
  return { base: ws.dropped + start, messages: ws.messages.slice(start) };
}

/* ---------------------------------------------------------------------------
 * Chrome: bodies, TLS details and initiators through the debugger
 *
 * Chrome's webRequest can't read response bodies (Firefox has
 * filterResponseData). The debugger API's Network domain can, so while
 * "Capture bodies" is on the monitor attaches to every tab (Chrome then shows
 * its "started debugging this browser" bar), and to cross-site iframes and
 * workers inside them. Debugger request ids differ from webRequest's, so each
 * debugger request is matched to the recorded one with the same tab, URL and
 * method that started at about the same time.
 * ------------------------------------------------------------------------- */
const dbg = {
  wanted: false,
  attached: new Set(),   // tab ids
  bound: new Map(),      // "tabId|sessionId|requestId" -> entry
  info: new Map(),       // same key -> { type, initiator } until bound
  waiting: [],           // debugger requests not yet matched to an entry
};
const DEBUGGABLE = /^(https?|wss?|data|blob|about):|^$/;

function debuggerNote(tabId) {
  if (!settings.captureBodies) return "";
  return dbg.attached.has(tabId)
    ? "Chrome didn't provide this body (it may have been evicted from its buffer, or the request came from the page cache)."
    : "Chrome only gives bodies for tabs the monitor's debugger is attached to. It attaches to new tabs as they open; reload this page to capture it.";
}

async function setDebugging(on) {
  if (!IS_CHROME) return;
  dbg.wanted = on;
  if (on) {
    for (const t of await browser.tabs.query({})) attachTab(t.id, t.url);
  } else {
    for (const tabId of [...dbg.attached]) browser.debugger.detach({ tabId }).catch(() => {});
    dbg.attached.clear();
  }
}

async function enableNetwork(target) {
  await browser.debugger.sendCommand(target, "Network.enable", { maxTotalBufferSize: 200e6, maxResourceBufferSize: MAX_BODY_BYTES });
  // Cross-site iframes and workers are separate targets: attach to them too, and
  // have Chrome hold each one until it's being listened to, so none of its
  // requests are missed.
  await browser.debugger.sendCommand(target, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
}

async function attachTab(tabId, url) {
  if (!dbg.wanted || dbg.attached.has(tabId) || tabId === panelTabId || !DEBUGGABLE.test(url || "")) return;
  dbg.attached.add(tabId);
  try {
    await browser.debugger.attach({ tabId }, "1.3");
    await enableNetwork({ tabId });
  } catch {
    dbg.attached.delete(tabId); // chrome:// pages, the Web Store, other extensions, or already gone
  }
}

if (IS_CHROME) {
  browser.tabs.onCreated.addListener((t) => attachTab(t.id, t.pendingUrl || t.url));
  browser.tabs.onUpdated.addListener((tabId, info, t) => { if (info.url || info.status === "loading") attachTab(tabId, t.url); });
  browser.tabs.onRemoved.addListener((tabId) => dbg.attached.delete(tabId));
  // Attach before a navigation's first request, so a new tab's page is captured too.
  browser.webNavigation.onBeforeNavigate.addListener((d) => { if (d.frameId === 0) attachTab(d.tabId, d.url); });

  browser.debugger.onDetach.addListener((source, reason) => {
    dbg.attached.delete(source.tabId);
    if (reason === "canceled_by_user" && settings.captureBodies) {
      // The user clicked Cancel on Chrome's "debugging this browser" bar.
      settings.captureBodies = false;
      browser.storage.local.set({ settings: { ...settings } });
      setDebugging(false);
      broadcast({ type: "settings", settings: publicSettings() });
    }
  });

  browser.debugger.onEvent.addListener((source, method, params) => {
    try { onDebuggerEvent(source, method, params); } catch (err) { console.error(err); }
  });
}

function debuggerKey(source, requestId) {
  return `${source.tabId}|${source.sessionId || ""}|${requestId}`;
}

// The entry for a debugger request. A cross-site iframe's navigation starts in
// its parent's session but finishes in the iframe's own, with the same id.
function boundRequest(source, requestId) {
  const key = debuggerKey(source, requestId);
  if (dbg.bound.has(key)) return [key, dbg.bound.get(key)];
  const prefix = `${source.tabId}|`, suffix = `|${requestId}`;
  for (const [k, e] of dbg.bound) if (k.startsWith(prefix) && k.endsWith(suffix)) return [k, e];
  return [key, undefined];
}

// The recorded request this debugger request is, if webRequest has seen it.
function matchEntry(tabId, url, method, t) {
  const key = stripHash(url);
  for (let i = recent.length - 1; i >= 0; i--) {
    const e = recent[i];
    if (!e.cdpBound && e.tabId === tabId && e.method === method && stripHash(e.url) === key && Math.abs(e.start - t) < 5000) return e;
  }
  return null;
}

function bindDebuggerRequest(key, e) {
  e.cdpBound = true;
  dbg.bound.set(key, e);
  const info = dbg.info.get(key);
  if (info && info.initiator && !e.initiator) {
    e.initiator = info.initiator.url;
    e.initiatorLoc = info.initiator.loc;
  }
}

// Called for each new entry (Chrome): binds a debugger request seen first.
function bindWaitingDebuggerRequest(e) {
  const i = dbg.waiting.findIndex(w => w.tabId === e.tabId && w.method === e.method && w.url === stripHash(e.url) && Math.abs(w.t - e.start) < 5000);
  if (i >= 0) bindDebuggerRequest(dbg.waiting.splice(i, 1)[0].key, e);
}

// Where a debugger initiator points: the top stack frame of the calling
// script, or the document/stylesheet whose markup asked for the resource.
function debuggerInitiator(init) {
  if (!init) return null;
  // The top frames can be the page hook's wrappers; the caller is the first page frame.
  let stack = init.stack;
  let frame;
  while (stack && !frame) {
    frame = (stack.callFrames || []).find(f => f.url && !f.url.startsWith(OWN_ORIGIN_BARE));
    stack = stack.parent;
  }
  if (frame && frame.url) return { url: frame.url, loc: `${frame.url}:${frame.lineNumber + 1}:${frame.columnNumber + 1}` };
  if (init.url) return { url: init.url, loc: init.lineNumber != null ? `${init.url}:${init.lineNumber + 1}` : init.url };
  return null;
}

const SIGNATURE_SCHEMES = {
  0x0401: "rsa_pkcs1_sha256", 0x0501: "rsa_pkcs1_sha384", 0x0601: "rsa_pkcs1_sha512",
  0x0403: "ecdsa_secp256r1_sha256", 0x0503: "ecdsa_secp384r1_sha384", 0x0603: "ecdsa_secp521r1_sha512",
  0x0804: "rsa_pss_rsae_sha256", 0x0805: "rsa_pss_rsae_sha384", 0x0806: "rsa_pss_rsae_sha512", 0x0807: "ed25519",
};

// The debugger's securityDetails, in the shape Firefox's getSecurityInfo gives.
function securityFromDebugger(state, d) {
  if (!d) return { state: state === "secure" ? "secure" : state === "insecure" ? "insecure" : "weak" };
  return {
    state: state === "secure" ? "secure" : state === "insecure" ? "broken" : "weak",
    protocolVersion: d.protocol,
    cipherSuite: d.mac ? `${d.cipher} (${d.mac})` : d.cipher,
    keaGroupName: d.keyExchangeGroup || d.keyExchange,
    signatureSchemeName: SIGNATURE_SCHEMES[d.serverSignatureAlgorithm] || (d.serverSignatureAlgorithm ? `0x${d.serverSignatureAlgorithm.toString(16)}` : ""),
    usedEch: d.encryptedClientHello,
    certificateTransparencyStatus: d.certificateTransparencyCompliance === "compliant" ? "policy_compliant"
      : d.certificateTransparencyCompliance === "not-compliant" ? "policy_not_enough_scts" : undefined,
    certificates: [{
      subject: `CN=${d.subjectName}`,
      issuer: d.issuer,
      validity: { start: d.validFrom * 1000, end: d.validTo * 1000 },
      sanList: d.sanList,
    }],
  };
}

const HTTP_VERSIONS = { "h2": "HTTP/2", "h3": "HTTP/3", "http/1.1": "HTTP/1.1", "http/1.0": "HTTP/1.0" };

function onDebuggerEvent(source, method, params) {
  if (method === "Target.attachedToTarget") {
    const child = { tabId: source.tabId, sessionId: params.sessionId };
    enableNetwork(child).catch(() => {}).finally(() => {
      if (params.waitingForDebugger) browser.debugger.sendCommand(child, "Runtime.runIfWaitingForDebugger").catch(() => {});
    });
    return;
  }
  if (!method.startsWith("Network.")) return;
  const key = debuggerKey(source, params.requestId);

  switch (method) {
    case "Network.requestWillBeSent": {
      const init = debuggerInitiator(params.initiator);
      dbg.info.set(key, { type: params.type, initiator: init });
      if (dbg.info.size > 5000) dbg.info.delete(dbg.info.keys().next().value);
      // A redirect keeps the debugger's request id; the next hop is a new entry.
      if (params.redirectResponse) dbg.bound.delete(key);
      const t = params.wallTime ? params.wallTime * 1000 : Date.now();
      const e = matchEntry(source.tabId, params.request.url, params.request.method, t);
      if (e) bindDebuggerRequest(key, e);
      else {
        dbg.waiting.push({ key, tabId: source.tabId, url: stripHash(params.request.url), method: params.request.method, t });
        if (dbg.waiting.length > 500) dbg.waiting.shift();
      }
      break;
    }
    case "Network.responseReceived": {
      const [, e] = boundRequest(source, params.requestId);
      if (!e) break;
      const r = params.response;
      if (HTTP_VERSIONS[r.protocol]) { e.httpVersion = HTTP_VERSIONS[r.protocol]; e.httpVersionKnown = true; }
      if (/^(https|wss):/.test(e.url)) e.security = securityFromDebugger(r.securityState, r.securityDetails);
      if (r.remoteIPAddress && !e.ip) e.ip = r.remoteIPAddress;
      touch(e);
      break;
    }
    case "Network.loadingFinished": {
      const [k, e] = boundRequest(source, params.requestId);
      dbg.bound.delete(k);
      dbg.info.delete(k);
      if (!e) break;
      if (params.encodedDataLength) e.responseSize = params.encodedDataLength;
      if (e.bodyState !== "capturing" || e.removed) { touch(e); break; }
      const target = source.sessionId ? { tabId: source.tabId, sessionId: source.sessionId } : { tabId: source.tabId };
      browser.debugger.sendCommand(target, "Network.getResponseBody", { requestId: params.requestId }).then((res) => {
        storeDebuggerBody(e, res);
      }, () => {
        e.bodyState = "unavailable";
        e.bodyError = debuggerNote(e.tabId);
        touch(e);
      });
      break;
    }
    case "Network.loadingFailed": {
      const [k, e] = boundRequest(source, params.requestId);
      dbg.bound.delete(k);
      dbg.info.delete(k);
      if (e && e.bodyState === "capturing") { e.bodyState = "none"; touch(e); }
      break;
    }
  }
}

function storeDebuggerBody(e, res) {
  if (e.removed) return;
  let buf;
  if (res.base64Encoded) {
    const bin = atob(res.body);
    buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  } else {
    buf = new TextEncoder().encode(res.body);
    e.charset = "utf-8"; // the debugger hands text bodies over already decoded
  }
  const keep = Math.min(buf.byteLength, MAX_BODY_BYTES);
  e.chunks = [buf.slice(0, keep).buffer];
  e.storedBytes = keep;
  e.seenBytes = buf.byteLength;
  e.bodySize = buf.byteLength;
  totalBodyBytes += keep;
  e.bodyState = keep < buf.byteLength ? "truncated" : "done";
  if (NM.isGenericMime(e.mimeType)) e.sniffedMime = NM.sniffMime(e.chunks[0]);
  enforceBodyBudget();
  touch(e);
}

/* ---------------------------------------------------------------------------
 * Data for the panel
 * ------------------------------------------------------------------------- */
function decodedSize(e) {
  if (e.bodySize != null) return e.bodySize;
  const enc = NM.header(e.responseHeaders, "content-encoding");
  if (e.contentLength != null && (!enc || enc === "identity")) return e.contentLength;
  return null;
}

function transferredSize(e) {
  if (e.fromCache) return 0;
  if (typeof e.responseSize === "number" && e.responseSize > 0) return e.responseSize;
  if (e.contentLength != null) return e.contentLength;
  if (e.bodySize != null && !NM.header(e.responseHeaders, "content-encoding")) return e.bodySize;
  return null;
}

function summarize(e) {
  return {
    id: e.id,
    url: e.url,
    method: e.method,
    type: e.type,
    tabId: e.tabId,
    originUrl: e.originUrl,
    status: e.status,
    statusText: e.statusText,
    httpVersion: e.httpVersion,
    mimeType: e.mimeType,
    sniffedMime: e.sniffedMime,
    fromCache: e.fromCache,
    transferred: transferredSize(e),
    size: decodedSize(e),
    start: e.start,
    end: e.end,
    firstByte: e.times.responseStarted || e.times.headersReceived || null,
    state: e.state,
    error: e.error,
    ip: e.ip,
    bodyState: e.bodyState,
    blocked: e.blocked,
    resent: e.resent,
    wsCount: e.ws ? e.ws.sent + e.ws.received : null,
    // For the has-response-header: and set-cookie-*: filters.
    responseHeaderNames: e.responseHeaders.map(h => h.name.toLowerCase()),
    setCookies: NM.parseSetCookies(NM.headerAll(e.responseHeaders, "set-cookie")).map(c => ({
      name: c.name,
      value: c.value,
      domain: (/^domain=(.*)$/i.exec(c.attrs.find(a => /^domain=/i.test(a)) || "") || [])[1] || "",
    })),
    classification: e.classification,
    documentUrl: e.documentUrl,
    frameId: e.frameId,
    parentFrameId: e.parentFrameId,
    redirectedFrom: e.redirectedFrom,
    initiator: e.initiator,
    initiatorLoc: e.initiatorLoc,
    rev: e.rev,
  };
}

function details(id) {
  const e = entries.get(id);
  if (!e) return null;
  return {
    ...summarize(e),
    thirdParty: e.thirdParty,
    statusLine: e.statusLine,
    redirectUrl: e.redirectUrl,
    security: e.security,
    ws: e.ws && { open: e.ws.open, closed: e.ws.closed, error: e.ws.error, protocol: e.ws.protocol, extensions: e.ws.extensions,
                  canSend: !!e.wsLink && !e.ws.closed, sent: e.ws.sent, received: e.ws.received, dropped: e.ws.dropped, stored: e.ws.messages.length },
    times: { ...e.times },
    requestHeaders: e.requestHeaders,
    responseHeaders: e.responseHeaders,
    requestBody: e.requestBody,
    responseBody: e.chunks.length ? NM.concat(e.chunks) : null,
    storedBytes: e.storedBytes,
    charset: e.charset,
    bodyError: e.bodyError,
    requestSize: e.requestSize,
    responseSize: e.responseSize,
  };
}

/* ---------------------------------------------------------------------------
 * HTML preview: recorded bodies for the images, stylesheets and fonts a page
 * uses, so the preview never touches the network.
 * ------------------------------------------------------------------------- */
const stripHash = (u) => { const i = u.indexOf("#"); return i < 0 ? u : u.slice(0, i); };

function previewResources(urls, tabId) {
  const index = new Map(); // url -> entries, newest first
  const all = [...entries.values()];
  for (let i = all.length - 1; i >= 0; i--) {
    const key = stripHash(all[i].url);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(all[i]);
  }
  const pick = (url, depth) => {
    const list = index.get(url) || [];
    const ordered = [...list.filter(e => e.tabId === tabId), ...list.filter(e => e.tabId !== tabId)];
    for (const e of ordered) {
      if (e.state === "redirect" && e.redirectUrl && depth < 5) {
        const r = pick(stripHash(e.redirectUrl), depth + 1);
        if (r) return r;
        continue;
      }
      const ok = e.status == null || (e.status >= 200 && e.status < 300);
      if (ok && e.chunks.length && e.bodyState !== "truncated" && e.bodyState !== "partial") {
        return { mime: NM.isGenericMime(e.mimeType) ? e.sniffedMime || e.mimeType : e.mimeType, body: NM.concat(e.chunks) };
      }
    }
    return null;
  };
  const out = {};
  for (const u of new Set((urls || []).map(String))) {
    const r = pick(stripHash(u), 0);
    if (r) out[u] = r;
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * HAR export
 * ------------------------------------------------------------------------- */
function harPostData(e) {
  const rb = e.requestBody;
  if (!rb || rb.error) return null;
  const mimeType = NM.header(e.requestHeaders, "content-type") || "";
  if (rb.formData) {
    const params = [];
    for (const [name, values] of Object.entries(rb.formData)) {
      for (const value of values) params.push({ name, value });
    }
    const text = params.map(p => encodeURIComponent(p.name) + "=" + encodeURIComponent(p.value)).join("&");
    return { mimeType, params, text };
  }
  if (rb.raw) {
    const ct = NM.parseContentType(mimeType);
    return { mimeType, text: NM.decodeText(rb.raw, ct.charset) };
  }
  return null;
}

const HAR_RESOURCE_TYPES = {
  main_frame: "document", sub_frame: "document", stylesheet: "stylesheet", script: "script",
  image: "image", imageset: "image", font: "font", xmlhttprequest: "xhr", websocket: "websocket",
  media: "media", ping: "ping", beacon: "ping", csp_report: "csp-violation-report", manifest: "manifest",
};

function harEntry(e) {
  const t = e.times;
  const end = e.end ?? Date.now();
  const sent = t.sendHeaders ?? t.start;
  const firstByte = t.responseStarted ?? t.headersReceived ?? end;
  const blocked = Math.max(0, sent - t.start);
  const wait = Math.max(0, firstByte - sent);
  const receive = Math.max(0, end - firstByte);

  const u = NM.safeUrl(e.url);
  const request = {
    method: e.method,
    url: e.url,
    httpVersion: e.httpVersion || "",
    cookies: NM.parseCookieHeader(NM.header(e.requestHeaders, "cookie")),
    headers: e.requestHeaders,
    queryString: u ? [...u.searchParams].map(([name, value]) => ({ name, value })) : [],
    headersSize: -1,
    bodySize: -1,
  };
  const postData = harPostData(e);
  if (postData) {
    request.postData = postData;
    request.bodySize = postData.text.length;
  }

  const content = {
    size: decodedSize(e) ?? e.storedBytes,
    mimeType: NM.header(e.responseHeaders, "content-type") || "",
  };
  if (e.chunks.length) {
    const buf = NM.concat(e.chunks);
    if (NM.isTextMime(e.mimeType)) content.text = NM.decodeText(buf, e.charset);
    else { content.text = NM.toBase64(buf); content.encoding = "base64"; }
    if (e.bodyState === "truncated") content.comment = `Truncated to ${e.storedBytes} bytes`;
  }

  const response = {
    status: e.status ?? 0,
    statusText: e.statusText || "",
    httpVersion: e.httpVersion || "",
    cookies: NM.parseSetCookies(NM.headerAll(e.responseHeaders, "set-cookie"))
      .map(c => ({ name: c.name, value: c.value })),
    headers: e.responseHeaders,
    content,
    redirectURL: e.redirectUrl || "",
    headersSize: -1,
    bodySize: transferredSize(e) ?? -1,
  };

  const entry = {
    startedDateTime: new Date(e.start).toISOString(),
    time: blocked + wait + receive,
    request,
    response,
    cache: {},
    timings: { blocked, dns: -1, connect: -1, ssl: -1, send: 0, wait, receive },
  };
  if (e.ip) entry.serverIPAddress = e.ip;
  entry._resourceType = HAR_RESOURCE_TYPES[e.type] || "other";
  // Same shape as Chrome's export, which tools like HAR viewers understand.
  if (e.ws) {
    entry._webSocketMessages = e.ws.messages.map(m => ({
      type: m.dir === "send" ? "send" : "receive",
      time: m.t / 1000,
      opcode: m.op,
      data: m.data ?? "",
    }));
  }
  if (e.error) entry._error = e.error;
  return entry;
}

function buildHar(ids) {
  const list = Array.isArray(ids)
    ? ids.map(id => entries.get(id)).filter(Boolean)
    : [...entries.values()];
  return JSON.stringify({
    log: {
      version: "1.2",
      creator: { name: "Always-On Network Monitor", version: browser.runtime.getManifest().version },
      pages: [],
      entries: list.map(harEntry),
    },
  }, null, 2);
}

/* ---------------------------------------------------------------------------
 * Resend
 * ------------------------------------------------------------------------- */
async function doResend(req) {
  const method = String(req.method || "GET").toUpperCase();
  pendingResends.push({ url: req.url, method, tabId: req.tabId ?? -1, at: Date.now() });
  const headers = new Headers();
  for (const { name, value } of req.headers || []) {
    try { headers.append(name, value); } catch { /* invalid header: skip */ }
  }
  const init = { method, headers, credentials: "include", cache: "no-store", redirect: "follow" };
  if (req.body != null && !/^(GET|HEAD)$/.test(method)) init.body = req.body;
  try {
    const res = await fetch(req.url, init);
    await res.arrayBuffer(); // read it fully so the request completes
  } catch {
    /* network errors show up in the list like any other failed request */
  }
}

function resendEntry(e) {
  let headers = e.requestHeaders.map(x => ({ ...x }));
  let body = null;
  const rb = e.requestBody;
  if (rb && rb.raw) body = rb.raw;
  else if (rb && rb.formData) {
    const pairs = Object.entries(rb.formData).flatMap(([k, vs]) => vs.map(v => [k, v]));
    if (/multipart\/form-data/i.test(NM.header(headers, "content-type") || "")) {
      body = new FormData();
      for (const [k, v] of pairs) body.append(k, v);
      headers = headers.filter(x => x.name.toLowerCase() !== "content-type"); // new boundary
    } else {
      body = new URLSearchParams(pairs).toString();
    }
  }
  return doResend({ method: e.method, url: e.url, headers, body, tabId: e.tabId });
}

/* ---------------------------------------------------------------------------
 * Settings, messaging, toolbar button
 * ------------------------------------------------------------------------- */
function updateBadge() {
  action.setBadgeBackgroundColor({ color: "#d70022" });
  action.setBadgeText({ text: settings.recording ? "" : "off" });
}

function saveBlocked() {
  browser.storage.local.set({ blocked: [...blockedUrls] });
  syncBlockRules();
  broadcast({ type: "settings", settings: publicSettings() });
}

// Chrome (MV3) can't cancel requests from webRequest; blocked URLs become
// declarativeNetRequest rules that match exactly that URL.
const ALL_RESOURCE_TYPES = ["main_frame", "sub_frame", "stylesheet", "script", "image", "font", "object", "xmlhttprequest",
  "ping", "csp_report", "media", "websocket", "webtransport", "webbundle", "other"];
async function syncBlockRules() {
  if (!IS_CHROME) return;
  try {
    const old = await browser.declarativeNetRequest.getDynamicRules();
    const escape = (u) => u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const addRules = [...blockedUrls].map((url, i) => ({
      id: i + 1,
      priority: 1,
      action: { type: "block" },
      condition: {
        // "|url|" anchors both ends; URLs containing urlFilter's own wildcards need a regex.
        ...(/[*^|]/.test(url) ? { regexFilter: "^" + escape(url) + "$" } : { urlFilter: "|" + url + "|" }),
        resourceTypes: ALL_RESOURCE_TYPES,
      },
    }));
    await browser.declarativeNetRequest.updateDynamicRules({ removeRuleIds: old.map(r => r.id), addRules });
  } catch (err) {
    console.error("Couldn't update the block rules:", err);
  }
}

browser.storage.local.get(["settings", "blocked"]).then(({ settings: saved, blocked }) => {
  if (Array.isArray(blocked)) for (const u of blocked) blockedUrls.add(u);
  if (saved) {
    if (typeof saved.recording === "boolean") settings.recording = saved.recording;
    if (typeof saved.captureBodies === "boolean") settings.captureBodies = saved.captureBodies;
  }
  updateBadge();
  syncBlockRules();
  if (IS_CHROME) setDebugging(settings.captureBodies);
});

function clearAll() {
  for (const e of entries.values()) { e.removed = true; e.chunks = []; if (e.ws) e.ws.messages = []; }
  entries.clear();
  active.clear();
  dirty.clear();
  removedIds = [];
  totalBodyBytes = 0;
  recent.length = 0;
  pendingHints = [];
  broadcast({ type: "cleared" });
}

/* ---------------------------------------------------------------------------
 * Tab memory: the last title, URL and window of every tab, kept after the tab
 * closes, so the panel can name closed tabs and group tabs by window.
 * ------------------------------------------------------------------------- */
const tabMeta = new Map(); // tabId -> { title, url, windowId, index, incognito, closed, closedAt }
const MAX_CLOSED_TABS = 500;

function noteTab(t) {
  if (!t || t.id == null || t.id < 0 || (t.url || "").startsWith(OWN_ORIGIN)) return;
  const old = tabMeta.get(t.id) || {};
  tabMeta.set(t.id, {
    title: t.title || old.title || "",
    url: t.url || old.url || "",
    favIconUrl: t.favIconUrl || (t.url && t.url !== old.url ? "" : old.favIconUrl) || "",
    windowId: t.windowId ?? old.windowId,
    index: t.index ?? old.index ?? 0,
    incognito: !!t.incognito,
    closed: false,
  });
}
browser.tabs.query({}).then((tabs) => tabs.forEach(noteTab), () => {});
browser.tabs.onCreated.addListener(noteTab);
browser.tabs.onUpdated.addListener((id, info, tab) => noteTab(tab));
browser.tabs.onAttached.addListener((id, info) => {
  const m = tabMeta.get(id);
  if (m) { m.windowId = info.newWindowId; m.index = info.newPosition; }
});
browser.tabs.onMoved.addListener((id, info) => { const m = tabMeta.get(id); if (m) m.index = info.toIndex; });
browser.tabs.onReplaced.addListener((added, removed) => {
  const m = tabMeta.get(removed);
  if (m) { tabMeta.delete(removed); tabMeta.set(added, m); }
});
browser.tabs.onRemoved.addListener((id) => {
  const m = tabMeta.get(id);
  if (!m) return;
  m.closed = true;
  m.closedAt = Date.now();
  const closed = [...tabMeta].filter(([, v]) => v.closed);
  if (closed.length > MAX_CLOSED_TABS) {
    closed.sort((a, b) => a[1].closedAt - b[1].closedAt);
    for (const [k] of closed.slice(0, closed.length - MAX_CLOSED_TABS)) tabMeta.delete(k);
  }
});

async function tabList() {
  const [tabs, wins] = await Promise.all([browser.tabs.query({}), browser.windows.getAll({})]);
  for (const t of tabs) noteTab(t); // fills in anything an event missed
  const open = new Set(tabs.map((t) => t.id));
  for (const [id, m] of tabMeta) if (!m.closed && !open.has(id)) { m.closed = true; m.closedAt = Date.now(); }
  return {
    tabs: [...tabMeta].map(([id, m]) => ({ id, ...m })),
    windows: wins.map((w) => ({ id: w.id, focused: !!w.focused, incognito: !!w.incognito, type: w.type })),
    panelWindowId: (tabs.find((t) => t.id === panelTabId) || {}).windowId ?? null,
  };
}

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== "panel") return;
  ports.add(port);
  port.postMessage({
    type: "snapshot",
    originTabId,
    settings: publicSettings(),
    entries: [...entries.values()].map(summarize),
  });
  port.onDisconnect.addListener(() => ports.delete(port));
});

browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.cmd === "ws") { onWsEvents(msg.events, sender); return undefined; }
  // Everything else comes from the panel, never from content scripts.
  if (!(sender.url || "").startsWith(OWN_ORIGIN)) return undefined;
  switch (msg && msg.cmd) {
    case "tabList":
      return tabList();
    case "previewResources":
      return Promise.resolve(previewResources(msg.urls, msg.tabId));
    case "getWsMessages":
      return Promise.resolve(wsMessages(msg.id, msg.from));
    case "wsSend":
      return wsSend(msg.id, msg.op, msg.data);
    case "getDetails":
      return Promise.resolve(details(msg.id));
    case "clear":
      clearAll();
      return Promise.resolve(true);
    case "setSettings":
      for (const k of ["recording", "captureBodies"]) {
        if (typeof msg.settings[k] === "boolean") settings[k] = msg.settings[k];
      }
      if (IS_CHROME) setDebugging(settings.captureBodies);
      browser.storage.local.set({ settings: { ...settings } });
      updateBadge();
      broadcast({ type: "settings", settings: publicSettings() });
      return Promise.resolve(publicSettings());
    case "exportHar":
      return Promise.resolve(buildHar(msg.ids));
    case "resend": {
      if (msg.request) { doResend(msg.request); return Promise.resolve(true); }
      const e = entries.get(msg.id);
      if (e) resendEntry(e);
      return Promise.resolve(!!e);
    }
    case "block":
      blockedUrls.add(msg.url);
      saveBlocked();
      return Promise.resolve(true);
    case "unblock":
      blockedUrls.delete(msg.url);
      saveBlocked();
      return Promise.resolve(true);
    case "unblockAll":
      blockedUrls.clear();
      saveBlocked();
      return Promise.resolve(true);
  }
  return undefined;
});

// Firefox: the panel opens as a regular window, because Firefox's "popup"
// windows stay above every other Firefox window. The title preface marks the
// window so the optional userChrome.css (see userChrome-netmon.css) can hide its
// toolbars. Chrome: a popup window has no toolbars and doesn't stay on top.
const PANEL_MARK = "\u2063\u2063";
let panelTabId = null;

function markPanelWindow(windowId) {
  if (IS_CHROME) return Promise.resolve();
  return browser.windows.update(windowId, { titlePreface: PANEL_MARK }).catch(() => {});
}

async function findPanelTab() {
  if (panelTabId !== null) {
    try { return await browser.tabs.get(panelTabId); } catch { panelTabId = null; }
  }
  const tabs = await browser.tabs.query({});
  const tab = tabs.find(t => (t.url || "").startsWith(PANEL_URL));
  if (tab) panelTabId = tab.id;
  return tab || null;
}

// "Current tab" in the panel is the tab the toolbar button was last clicked on.
// When the panel opens some other way (session restore), it falls back to the
// active tab of the browser window that was focused last.
let originTabId = null;

function setOriginTab(id) {
  if (id == null || id < 0 || id === originTabId) return;
  originTabId = id;
  broadcast({ type: "origin", tabId: id });
}

browser.tabs.query({ active: true, lastFocusedWindow: true }).then(([t]) => {
  if (t && originTabId == null && !(t.url || "").startsWith(PANEL_URL)) originTabId = t.id;
}, () => {});
browser.tabs.onActivated.addListener(({ tabId }) => {
  if (originTabId == null && tabId !== panelTabId) setOriginTab(tabId);
});

action.onClicked.addListener(async (clicked) => {
  const tab = await findPanelTab();
  if (clicked && clicked.id !== (tab && tab.id)) setOriginTab(clicked.id);
  if (tab) {
    await browser.tabs.update(tab.id, { active: true });
    await browser.windows.update(tab.windowId, { focused: true });
    markPanelWindow(tab.windowId);
    return;
  }
  const win = await browser.windows.create(IS_CHROME
    ? { url: PANEL_URL, type: "popup", width: 1300, height: 860 }
    : { url: PANEL_URL, type: "normal", width: 1300, height: 860, titlePreface: PANEL_MARK });
  panelTabId = win.tabs[0].id;
});

// A panel window restored by session restore loses its mark; put it back.
findPanelTab().then((tab) => { if (tab) markPanelWindow(tab.windowId); });
browser.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "complete" && (tab.url || "").startsWith(PANEL_URL)) {
    panelTabId = tabId;
    markPanelWindow(tab.windowId);
  }
});

browser.tabs.onRemoved.addListener((id) => {
  if (id === panelTabId) panelTabId = null;
});
