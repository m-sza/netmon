"use strict";

const { header, headerAll, parseContentType, isTextMime, decodeText, safeUrl, parseCookieHeader, parseSetCookies } = NM;

/* ---------------------------------------------------------------------------
 * DOM
 * ------------------------------------------------------------------------- */
const $ = (id) => document.getElementById(id);
const tbody = $("rows");
const listPane = $("list-pane");
const detailsPane = $("details-pane");
const detailsBody = $("details-body");
const splitter = $("splitter");
const emptyMsg = $("empty");
const tabSelect = $("tab-filter");
const recordBtn = $("btn-record");
const bodiesChk = $("opt-bodies");

const OWN_ORIGIN = browser.runtime.getURL("");
const BROWSER = IS_CHROME ? "Chrome" : "Firefox";

/* ---------------------------------------------------------------------------
 * State
 * ------------------------------------------------------------------------- */
const store = new Map();  // id -> summary, in arrival order
const tabTitles = new Map(); // tabId -> { title, url, windowId, index, incognito, closed } (closed tabs too)

const state = {
  filterTokens: [],
  typeFilter: "all",
  tabFilter: "current",    // "current" (the tab the monitor was opened on), "all", "none" or a tab id
  originTabId: null,
  viewMode: "list",        // "list" or "tree"
  sortKey: null,
  sortDir: 1,
  selectedId: null,
  cursorId: null,          // the row the keyboard is on; Enter/Space opens it
  detailsTab: "headers",
  rawHeaders: false,
  rawJson: false,
  htmlPreview: true,
  recording: true,
  captureBodies: true,
  blocked: new Set(),
  blockers: [],            // other add-ons that can block requests
  timeRange: null,         // { from, to } (epoch ms) chosen in the overview, or null
};

let current = null;       // details object of the selected request
let detailsToken = 0;
let blobUrls = [];

/* ---------------------------------------------------------------------------
 * Small helpers
 * ------------------------------------------------------------------------- */
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

function fmtBytes(n) {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 2 : 1)} kB`;
  return `${(n / 1048576).toFixed(2)} MB`;
}

function fmtMs(ms) {
  if (ms == null || !isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function fmtClock(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0");
}

function fileName(url) {
  const u = safeUrl(url);
  if (!u) return url;
  if (!/^https?:|^wss?:|^ftp:/.test(u.protocol)) return url;
  const segs = u.pathname.split("/");
  const last = segs[segs.length - 1];
  return (last || "/") + u.search;
}

const MIME_ALIASES = { javascript: "js", "x-javascript": "js", ecmascript: "js", "svg+xml": "svg", "x-icon": "ico", "vnd.microsoft.icon": "ico" };
function mimeShort(mime) {
  if (!mime) return "";
  let sub = mime.split("/")[1] || mime;
  if (MIME_ALIASES[sub]) return MIME_ALIASES[sub];
  if (sub.endsWith("+json")) return "json";
  if (sub.endsWith("+xml")) return "xml";
  return sub.replace(/^x-/, "");
}

// The type to show for a request: its Content-Type, unless that's missing or
// generic, then what the body's first bytes say, then the URL's extension.
function effectiveMime(s) {
  if (!NM.isGenericMime(s.mimeType)) return { mime: s.mimeType, how: "header" };
  if (s.sniffedMime) return { mime: s.sniffedMime, how: "content" };
  const fromUrl = NM.mimeFromUrl(s.url);
  if (fromUrl) return { mime: fromUrl, how: "extension" };
  return { mime: s.mimeType || "", how: "header" };
}

function mimeTitle(s) {
  const { mime, how } = effectiveMime(s);
  const sent = s.mimeType ? `the response said ${s.mimeType}` : "the response had no Content-Type";
  if (how === "content") return `${mime}, detected from the content (${sent})`;
  if (how === "extension") return `${mime}, guessed from the file extension (${sent})`;
  return mime;
}

const CAUSE = { main_frame: "document", sub_frame: "subdocument", xmlhttprequest: "xhr", image: "img", imageset: "imageset", stylesheet: "stylesheet", script: "script", font: "font", media: "media", websocket: "websocket", beacon: "beacon", ping: "ping", object: "object", csp_report: "csp", web_manifest: "manifest", speculative: "speculative" };
const causeLabel = (type) => CAUSE[type] || type;

/* Request type icons (symbols live in panel.html) */
const SVG_NS = "http://www.w3.org/2000/svg";

function iconKind(s) {
  switch (s.type) {
    case "main_frame": case "sub_frame": return "doc";
    case "script": return "js";
    case "stylesheet": return "css";
    case "image": case "imageset": return "img";
    case "font": return "font";
    case "media": return "media";
    case "websocket": return "ws";
    case "beacon": case "ping": case "csp_report": return "ping";
    case "web_manifest": return "manifest";
  }
  const m = effectiveMime(s).mime;
  if (/json/.test(m)) return "json";
  if (/wasm/.test(m)) return "wasm";
  if (/javascript|ecmascript/.test(m)) return "js";
  if (/css/.test(m)) return "css";
  if (/^image\//.test(m)) return "img";
  if (/html/.test(m)) return "doc";
  if (/font|woff/.test(m)) return "font";
  if (/^(audio|video)\//.test(m)) return "media";
  if (s.type === "xmlhttprequest") return "fetch";
  if (/xml|^text\//.test(m)) return "text";
  return "other";
}

const ICON_TITLES = { doc: "Document", js: "Script", css: "Stylesheet", img: "Image", font: "Font", media: "Media", ws: "WebSocket", ping: "Beacon / ping", json: "JSON", fetch: "Fetch / XHR", wasm: "WebAssembly", manifest: "Manifest", text: "Text", other: "Other" };

function makeIcon() {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("class", "ficon");
  const title = document.createElementNS(SVG_NS, "title");
  const use = document.createElementNS(SVG_NS, "use");
  svg.append(title, use);
  return svg;
}

const CATEGORY = { main_frame: "html", sub_frame: "html", stylesheet: "css", script: "js", xmlhttprequest: "xhr", font: "font", image: "img", imageset: "img", media: "media", websocket: "ws" };
const category = (s) => CATEGORY[s.type] || "other";

/* Readable reasons for failed requests, like Firefox DevTools shows them.
 * Firefox gives extensions only the error code. NS_ERROR_ABORT is what it uses
 * when an add-on cancels a request (webRequest or declarativeNetRequest); which
 * add-on did it is only known to DevTools, so it's inferred from the add-ons
 * that are able to block. */
const FAILURES = {
  NS_BINDING_ABORTED: ["Cancelled", "The page cancelled this request, or navigated away before it finished."],
  NS_ERROR_TRACKING_URI: ["Blocked by Tracking Protection", "Firefox's Enhanced Tracking Protection blocked this tracker."],
  NS_ERROR_FINGERPRINTING_URI: ["Blocked by Tracking Protection", "Firefox's Enhanced Tracking Protection blocked this fingerprinter."],
  NS_ERROR_CRYPTOMINING_URI: ["Blocked by Tracking Protection", "Firefox's Enhanced Tracking Protection blocked this cryptominer."],
  NS_ERROR_SOCIALTRACKING_URI: ["Blocked by Tracking Protection", "Firefox's Enhanced Tracking Protection blocked this social media tracker."],
  NS_ERROR_EMAILTRACKING_URI: ["Blocked by Tracking Protection", "Firefox's Enhanced Tracking Protection blocked this email tracker."],
  NS_ERROR_MALWARE_URI: ["Blocked by Safe Browsing", "Firefox flagged this URL as malware."],
  NS_ERROR_PHISHING_URI: ["Blocked by Safe Browsing", "Firefox flagged this URL as phishing."],
  NS_ERROR_UNWANTED_URI: ["Blocked by Safe Browsing", "Firefox flagged this URL as unwanted software."],
  NS_ERROR_HARMFUL_URI: ["Blocked by Safe Browsing", "Firefox flagged this URL as harmful."],
  NS_ERROR_BLOCKED_BY_POLICY: ["Blocked by policy", "An enterprise policy blocks this URL."],
  NS_ERROR_CONTENT_BLOCKED: ["Blocked by content policy", "Blocked by a content policy, such as CSP or mixed-content blocking."],
  NS_ERROR_DOM_CORP_FAILED: ["Blocked by CORP", "The server's Cross-Origin-Resource-Policy doesn't allow this page to load it."],
  NS_ERROR_DOM_COEP_FAILED: ["Blocked by COEP", "The page's Cross-Origin-Embedder-Policy doesn't allow this response."],
  NS_ERROR_UNKNOWN_HOST: ["DNS lookup failed", "The domain name couldn't be resolved."],
  NS_ERROR_CONNECTION_REFUSED: ["Connection refused", "The server refused the connection."],
  NS_ERROR_NET_TIMEOUT: ["Timed out", "The connection timed out."],
  NS_ERROR_NET_RESET: ["Connection reset", "The connection was reset."],
  NS_ERROR_NET_INTERRUPT: ["Connection interrupted", "The connection was interrupted."],
  NS_ERROR_NET_PARTIAL_TRANSFER: ["Partial transfer", "The connection closed before the whole response arrived."],
  NS_ERROR_OFFLINE: ["Offline", "Firefox is in offline mode."],
  NS_ERROR_PROXY_CONNECTION_REFUSED: ["Proxy refused", "The proxy server refused the connection."],
  NS_ERROR_UNKNOWN_PROXY_HOST: ["Proxy not found", "The proxy server's name couldn't be resolved."],
  NS_ERROR_REDIRECT_LOOP: ["Redirect loop", "The server redirects in a way that never completes."],
  NS_ERROR_CORRUPTED_CONTENT: ["Corrupted content", "The response was corrupted (e.g. a MIME type mismatch or bad encoding)."],
  NS_ERROR_INTERCEPTION_FAILED: ["Service worker failed", "A service worker intercepted this request and failed to respond."],
  // Chrome's codes for the same situations
  "net::ERR_ABORTED": ["Cancelled", "The page cancelled this request, or navigated away before it finished."],
  "net::ERR_BLOCKED_BY_ADMINISTRATOR": ["Blocked by policy", "An enterprise policy blocks this URL."],
  "net::ERR_BLOCKED_BY_CSP": ["Blocked by content policy", "The page's Content Security Policy blocked this request."],
  "net::ERR_BLOCKED_BY_RESPONSE": ["Blocked by response policy", "The response's Cross-Origin-Resource-Policy, Cross-Origin-Embedder-Policy or X-Frame-Options doesn't allow this."],
  "net::ERR_BLOCKED_BY_ORB": ["Blocked by ORB", "Chrome's Opaque Response Blocking withheld this cross-origin response."],
  "net::ERR_NAME_NOT_RESOLVED": ["DNS lookup failed", "The domain name couldn't be resolved."],
  "net::ERR_CONNECTION_REFUSED": ["Connection refused", "The server refused the connection."],
  "net::ERR_CONNECTION_TIMED_OUT": ["Timed out", "The connection timed out."],
  "net::ERR_TIMED_OUT": ["Timed out", "The request timed out."],
  "net::ERR_CONNECTION_RESET": ["Connection reset", "The connection was reset."],
  "net::ERR_CONNECTION_CLOSED": ["Connection closed", "The server closed the connection."],
  "net::ERR_EMPTY_RESPONSE": ["Empty response", "The server closed the connection without sending anything."],
  "net::ERR_INCOMPLETE_CHUNKED_ENCODING": ["Partial transfer", "The connection closed before the whole response arrived."],
  "net::ERR_INTERNET_DISCONNECTED": ["Offline", "The computer isn't connected to the internet."],
  "net::ERR_NETWORK_CHANGED": ["Network changed", "The network connection changed during the request."],
  "net::ERR_PROXY_CONNECTION_FAILED": ["Proxy refused", "The proxy server couldn't be reached."],
  "net::ERR_TOO_MANY_REDIRECTS": ["Redirect loop", "The server redirects in a way that never completes."],
  "net::ERR_CONTENT_DECODING_FAILED": ["Corrupted content", "The response couldn't be decompressed."],
  "net::ERR_CACHE_MISS": ["Not in cache", "The response wasn't in the cache (e.g. a form resubmission)."],
};

// The code an add-on cancel produces: Firefox (webRequest or declarativeNetRequest)
// and Chrome (declarativeNetRequest; Chrome also uses it for its built-in ad filter).
const ADDON_BLOCK_CODES = new Set(["NS_ERROR_ABORT", "net::ERR_BLOCKED_BY_CLIENT"]);

function failure(s) {
  const code = s.error || "";
  if (s.blocked) return { text: "Blocked by Network Monitor", title: "You blocked this URL here. Right-click → Unblock URL to allow it again." };
  if (ADDON_BLOCK_CODES.has(code)) {
    const b = state.blockers;
    if (b.length === 1) {
      return { text: `Blocked by ${b[0]}`, title: `${b[0]} is the only add-on installed that can block requests, so it blocked this one. (${BROWSER} only tells extensions the error code: ${code}.)` };
    }
    if (b.length > 1) {
      return { text: "Blocked by an add-on", title: `Blocked by one of: ${b.join(", ")}. ${BROWSER} doesn't tell extensions which one. (${code})` };
    }
    return code === "NS_ERROR_ABORT"
      ? { text: "Aborted", title: "Cancelled before it completed (NS_ERROR_ABORT)." }
      : { text: "Blocked", title: "Blocked by the browser, e.g. Chrome's built-in ad filtering (net::ERR_BLOCKED_BY_CLIENT)." };
  }
  const known = FAILURES[code];
  if (known) {
    const tags = s.classification && s.classification.length ? ` Classified as: ${s.classification.join(", ")}.` : "";
    return { text: known[0], title: `${known[1]}${tags} (${code})` };
  }
  if (/^(SSL_ERROR_|SEC_ERROR_|MOZILLA_PKIX_ERROR_|net::ERR_(CERT_|SSL_))|NS_ERROR_MODULE_SECURITY/.test(code)) {
    return { text: "TLS error", title: `The secure connection failed (${code}).` };
  }
  return { text: code || "Failed", title: code };
}

const isBlockedFailure = (s) => s.blocked || (ADDON_BLOCK_CODES.has(s.error) && (state.blockers.length > 0 || s.error !== "NS_ERROR_ABORT")) ||
  /^Blocked/.test(FAILURES[s.error]?.[0] || "");

function statusClass(s) {
  if (s.state === "pending" && s.status == null) return "st-pending";
  if (s.status == null) return "st-error";
  if (s.fromCache) return "st-cached";
  if (s.status >= 400) return "st-bad";
  if (s.status >= 300) return "st-redirect";
  return "st-ok";
}

function tabLabel(tabId) {
  if (tabId == null || tabId < 0) return "No tab (browser / extensions)";
  const t = tabTitles.get(tabId);
  if (!t) return `Tab #${tabId} (closed)`;
  const title = t.title || t.url || `Tab #${tabId}`;
  return t.closed ? `${title} (closed)` : title;
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      const old = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(() => { btn.textContent = old; }, 1000);
    }
  } catch (err) {
    console.error("Copy failed", err);
  }
}

/* ---------------------------------------------------------------------------
 * Filtering
 * ------------------------------------------------------------------------- */
// What the shared filter language needs to know about a request.
const filterHelpers = {
  mime: (s) => effectiveMime(s).mime,
  cause: (s) => causeLabel(s.type),
  initiator: (s) => (s.initiatorLoc ? fileName(s.initiatorLoc) : ""),
  blocked: (s) => isBlockedFailure(s),
  unicodeUrl: (u) => { try { return decodeURI(u); } catch { return u; } },
};

// Every filter except the overview's time range (the overview shows these).
function matchesFilters(s) {
  if (state.typeFilter !== "all" && category(s) !== state.typeFilter) return false;
  if (state.tabFilter === "current") { if (state.originTabId != null && s.tabId !== state.originTabId) return false; }
  else if (state.tabFilter === "none") { if (s.tabId >= 0) return false; }
  else if (state.tabFilter !== "all" && String(s.tabId) !== state.tabFilter) return false;
  return NetFilter.matchAll(state.filterTokens, s, filterHelpers);
}

// A request is in the time range if any part of it falls inside.
function inTimeRange(s, now = Date.now()) {
  const r = state.timeRange;
  return !r || (s.start <= r.to && (s.end ?? now) >= r.from);
}

function matches(s) {
  return matchesFilters(s) && inTimeRange(s);
}

// The overview redraws (throttled) when requests or filters change; not on scrolling.
const overviewChanged = () => { if (typeof Overview !== "undefined") Overview.invalidate(); };

function applyFilters() {
  viewDirty = true;
  scheduleRefresh();
  overviewChanged();
}

/* ---------------------------------------------------------------------------
 * Rows
 * ------------------------------------------------------------------------- */
const COLUMNS = ["status", "method", "domain", "file", "initiator", "type", "transferred", "size", "time", "waterfall"];

function buildRow() {
  const tr = document.createElement("tr");
  for (const c of COLUMNS) {
    const td = document.createElement("td");
    td.className = "c-" + c;
    if (c === "waterfall") td.append(h("div", { class: "bar" }, h("div", { class: "bar-wait" })));
    if (c === "file") td.append(h("span", { class: "twisty" }), makeIcon(), h("span", { class: "fname" }), h("span", { class: "tguides" }));
    tr.append(td);
  }
  return tr;
}

function fillRow(tr, s) {
  const [cStatus, cMethod, cDomain, cFile, cInit, cType, cTrans, cSize, cTime] = tr.children;
  const u = safeUrl(s.url);

  cStatus.textContent = s.status ?? "";
  cStatus.className = "c-status " + statusClass(s);
  cStatus.title = s.status != null ? `${s.status} ${s.statusText || ""}`.trim() : s.state === "pending" ? "Pending" : (s.error || "");

  cMethod.textContent = s.method;

  cDomain.textContent = u ? u.host : "";
  cDomain.title = u ? u.origin : "";

  cFile.querySelector(".fname").textContent = fileName(s.url);
  cFile.title = s.url;
  const kind = iconKind(s);
  if (cFile.dataset.icon !== kind) {
    cFile.dataset.icon = kind;
    const svg = cFile.querySelector("svg");
    svg.setAttribute("class", "ficon ic-" + kind);
    svg.firstChild.textContent = ICON_TITLES[kind];
    svg.lastChild.setAttribute("href", "#i-" + kind);
  }

  const cause = causeLabel(s.type);
  if (s.resent) {
    cInit.textContent = "Resent from monitor";
    cInit.title = "";
  } else {
    const by = s.initiatorLoc ? fileName(s.initiatorLoc) : s.originUrl && s.type !== "main_frame" ? fileName(s.originUrl) : "";
    cInit.textContent = by ? `${by} (${cause})` : cause;
    cInit.title = s.initiatorLoc || s.originUrl || "";
  }

  const eff = effectiveMime(s);
  cType.textContent = mimeShort(eff.mime);
  cType.title = mimeTitle(s);
  cType.classList.toggle("guessed", eff.how !== "header");

  if (s.state === "error" && s.status == null) {
    const f = failure(s);
    cTrans.textContent = f.text;
    cTrans.title = f.title;
  } else if (s.fromCache) {
    cTrans.textContent = "cached";
    cTrans.title = "Served from cache";
  } else {
    cTrans.textContent = fmtBytes(s.transferred);
    cTrans.title = s.transferred != null ? `${s.transferred} bytes` : "";
  }

  cSize.textContent = fmtBytes(s.size);
  cSize.title = s.size != null ? `${s.size} bytes` : "";

  cTime.textContent = s.end ? fmtMs(s.end - s.start) : "…";

  tr.classList.toggle("row-error", s.state === "error" || (s.status ?? 0) >= 400);
  tr.classList.toggle("selected", s.id === state.selectedId);
}

/* ---------------------------------------------------------------------------
 * Sorting
 * ------------------------------------------------------------------------- */
const SORTERS = {
  status: (s) => s.status ?? -1,
  method: (s) => s.method,
  domain: (s) => safeUrl(s.url)?.host || "",
  file: (s) => fileName(s.url).toLowerCase(),
  initiator: (s) => s.originUrl || "",
  type: (s) => mimeShort(effectiveMime(s).mime),
  transferred: (s) => (s.fromCache ? -0.5 : s.transferred ?? -1),
  size: (s) => s.size ?? -1,
  time: (s) => (s.end ? s.end - s.start : Number.MAX_SAFE_INTEGER),
  waterfall: (s) => s.start,
};

function sortIds(ids) {
  if (!state.sortKey) return ids;
  const key = SORTERS[state.sortKey];
  const dir = state.sortDir;
  const keyed = ids.map((id) => [key(store.get(id)), id]);
  keyed.sort(([va, a], [vb, b]) => (va < vb ? -dir : va > vb ? dir : a - b));
  return keyed.map(([, id]) => id);
}

let resizedAt = 0; // a drag ends with a click on the header; don't sort on it

document.querySelector("#requests thead").addEventListener("click", (ev) => {
  const th = ev.target.closest("th[data-sort]");
  if (!th || ev.target.closest(".col-resizer") || Date.now() - resizedAt < 200) return;
  const key = th.dataset.sort;
  if (state.sortKey !== key) { state.sortKey = key; state.sortDir = 1; }
  else if (state.sortDir === 1) state.sortDir = -1;
  else state.sortKey = null;

  for (const el of document.querySelectorAll("#requests th")) el.classList.remove("sort-asc", "sort-desc");
  if (state.sortKey) th.classList.add(state.sortDir === 1 ? "sort-asc" : "sort-desc");

  applyFilters();
});

/* ---------------------------------------------------------------------------
 * The list is virtual: `view` holds the ids that pass the filters, in display
 * order, and only the rows in (or near) the viewport exist in the DOM. That
 * keeps thousands of requests as cheap to scroll and update as a handful.
 * ------------------------------------------------------------------------- */
let view = [];
let viewPos = new Map();  // id -> index in view
let viewDirty = true;
let stickPending = false; // scroll to the newest request on the next render
let rowH = 22;
const OVERSCAN = 12;
const rendered = new Map(); // id -> <tr> currently in the table
const spare = [];
// Spacer rows stand in for the rows above and below the viewport. Their single
// cell must not span columns: a span counts the columns hidden while the
// details pane is open, which leaves empty space at the table's right edge.
const topPad = h("tr", { class: "pad" }, h("td"));
const bottomPad = h("tr", { class: "pad" }, h("td"));

function rebuildView() {
  viewDirty = false;
  if (state.viewMode === "tree") {
    view = flattenTree();
  } else {
    const ids = [];
    for (const [id, s] of store) if (matches(s)) ids.push(id);
    view = sortIds(ids);
    treeInfo = null;
  }
  viewPos = new Map(view.map((id, i) => [id, i]));
}

/* ---------------------------------------------------------------------------
 * Tree view: each request sits under the one that caused it. Parents, in order
 * of preference: the request that redirected here; the script that made the
 * request (seen by the page hook); the stylesheet or other resource Firefox
 * names as the origin; the document of the frame it was made from. Page loads
 * (and requests whose parent wasn't recorded) are roots.
 * ------------------------------------------------------------------------- */
let treeInfo = null;            // id -> { depth, kids, context }
const collapsed = new Set();    // ids whose children are hidden

function treeParents() {
  const parent = new Map();
  const byUrl = new Map();      // "tab url" -> latest entry so far
  const docOfFrame = new Map(); // "tab frame" -> latest document entry so far
  const strip = (u) => { const i = (u || "").indexOf("#"); return i < 0 ? u || "" : u.slice(0, i); };
  const latest = (tabId, url) => (url ? byUrl.get(tabId + " " + strip(url)) : undefined);

  for (const s of store.values()) { // arrival order, so every candidate parent came earlier
    let p;
    if (s.redirectedFrom != null && store.has(s.redirectedFrom)) p = store.get(s.redirectedFrom);
    else if (s.type !== "main_frame") {
      if (s.initiator) p = latest(s.tabId, s.initiator);
      if (!p && s.originUrl && strip(s.originUrl) !== strip(s.documentUrl)) p = latest(s.tabId, s.originUrl);
      if (!p) p = docOfFrame.get(s.tabId + " " + (s.type === "sub_frame" ? s.parentFrameId : s.frameId));
      if (!p) p = latest(s.tabId, s.documentUrl || s.originUrl);
    }
    if (p && p.id !== s.id) parent.set(s.id, p.id);
    byUrl.set(s.tabId + " " + strip(s.url), s);
    if ((s.type === "main_frame" || s.type === "sub_frame") && s.state !== "redirect") docOfFrame.set(s.tabId + " " + s.frameId, s);
  }
  return parent;
}

function flattenTree() {
  const parent = treeParents();
  const kids = new Map();
  const roots = [];
  for (const id of store.keys()) {
    const p = parent.get(id);
    if (p == null) roots.push(id);
    else (kids.get(p) || kids.set(p, []).get(p)).push(id);
  }
  // A node is shown if it matches the filters or leads to something that does.
  const matched = new Set();
  const keep = new Set();
  const ids = [...store.keys()];
  for (let i = ids.length - 1; i >= 0; i--) { // children always arrive after their parents
    const id = ids[i];
    if (matches(store.get(id))) { matched.add(id); keep.add(id); }
    if (keep.has(id) && parent.has(id)) keep.add(parent.get(id));
  }

  treeInfo = new Map();
  const out = [];
  const NO_ANC = [];
  const stack = sortIds(roots.filter((id) => keep.has(id))).reverse().map((id) => [id, 0, NO_ANC]);
  while (stack.length) {
    const [id, depth, anc] = stack.pop();
    const shownKids = (kids.get(id) || []).filter((k) => keep.has(k));
    treeInfo.set(id, { depth, kids: shownKids.length, context: !matched.has(id), anc }); // anc: ancestors, root first
    out.push(id);
    if (!collapsed.has(id)) {
      const ordered = sortIds(shownKids);
      const kidAnc = [...anc, id];
      for (let i = ordered.length - 1; i >= 0; i--) stack.push([ordered[i], depth + 1, kidAnc]);
    }
  }
  return out;
}

const TREE_INDENT = 14;     // px per tree level (the twisty's width + gap)
let treeGuideHover = null; // the request whose tree line (or arrow) is hovered

// Hovering a tree line or an arrow highlights that request's whole line and
// its arrow, like the JSON tree.
function setTreeGuideHover(id) {
  if (id === treeGuideHover) return;
  treeGuideHover = id;
  for (const g of tbody.querySelectorAll(".tguide")) g.classList.toggle("hl", Number(g.dataset.anc) === id);
  for (const tr of tbody.querySelectorAll("tr[data-id]")) tr.children[3].firstChild.classList.toggle("hl", Number(tr.dataset.id) === id);
  for (const tr of tbody.querySelectorAll("tr[data-id]")) tr.children[3].querySelector(".tguides")._key = null;
}
tbody.addEventListener("mouseover", (ev) => {
  if (state.viewMode !== "tree") return;
  const g = ev.target.closest(".tguide");
  if (g) { setTreeGuideHover(Number(g.dataset.anc)); return; }
  const tw = ev.target.closest(".twisty");
  if (tw && tw.textContent) { setTreeGuideHover(Number(tw.closest("tr").dataset.id)); return; }
  setTreeGuideHover(null);
});
tbody.addEventListener("mouseleave", () => setTreeGuideHover(null));

function toggleCollapsed(id, deep) {
  const close = !collapsed.has(id);
  const apply = (x) => (close ? collapsed.add(x) : collapsed.delete(x));
  apply(id);
  if (deep) {
    const parent = treeParents();
    const under = new Set([id]);
    for (const [child, p] of [...parent].sort(([a], [b]) => a - b)) {
      if (under.has(p)) { under.add(child); apply(child); }
    }
  }
  viewDirty = true;
  scheduleRefresh();
}

function setViewMode(mode) {
  state.viewMode = mode;
  for (const b of document.querySelectorAll("#view-mode button")) b.classList.toggle("active", b.dataset.mode === mode);
  document.body.classList.toggle("tree-mode", mode === "tree");
  try { localStorage.setItem("viewMode", mode); } catch { /* ignore */ }
  stickPending = mode === "list" && !state.sortKey;
  applyFilters();
}

function visibleIds() {
  return view.slice();
}

let refreshQueued = false;
function scheduleRefresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  requestAnimationFrame(() => { refreshQueued = false; refreshView(); });
}

listPane.addEventListener("scroll", () => scheduleRefresh(), { passive: true });
window.addEventListener("resize", () => scheduleRefresh());

function renderRows(t0, span, now) {
  const headH = tbody.parentElement.tHead.offsetHeight;
  const viewportRows = Math.ceil(Math.max(0, listPane.clientHeight - headH) / rowH);
  const maxTop = Math.max(0, view.length * rowH - (listPane.clientHeight - headH));
  const scrollTop = stickPending ? maxTop : Math.min(listPane.scrollTop, maxTop);
  const first = Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN);
  const last = Math.min(view.length, Math.floor(scrollTop / rowH) + viewportRows + OVERSCAN);

  const keep = new Set(view.slice(first, last));
  for (const [id, tr] of rendered) {
    if (!keep.has(id)) { rendered.delete(id); spare.push(tr); }
  }
  const list = [];
  for (let i = first; i < last; i++) {
    const id = view[i];
    const s = store.get(id);
    let tr = rendered.get(id);
    if (!tr) {
      tr = spare.pop() || buildRow();
      tr._id = tr._rev = null;
      rendered.set(id, tr);
    }
    if (tr._id !== id || tr._rev !== s.rev) {
      tr.dataset.id = id;
      fillRow(tr, s);
      tr._id = id;
      tr._rev = s.rev;
    }
    tr.classList.toggle("alt", i % 2 === 1);
    tr.classList.toggle("selected", id === state.selectedId);
    tr.classList.toggle("cursor", id === state.cursorId && id !== state.selectedId);
    const node = treeInfo && treeInfo.get(id);
    const fileCell = tr.children[3];
    fileCell.style.paddingLeft = node ? 4 + node.depth * TREE_INDENT + "px" : "";
    const twisty = fileCell.firstChild;
    twisty.classList.toggle("hl", node != null && id === treeGuideHover);
    // Tree lines: one per ancestor, under its arrow; they join up row to row.
    const guides = fileCell.querySelector(".tguides");
    const anc = node ? node.anc : [];
    if (guides._key !== anc.join() + "|" + treeGuideHover) {
      guides._key = anc.join() + "|" + treeGuideHover;
      guides.replaceChildren(...anc.map((a, d) => {
        const g = h("span", { class: "tguide" + (a === treeGuideHover ? " hl" : ""), "data-anc": a, title: "Collapse" });
        g.style.left = 4 + d * TREE_INDENT + "px";
        return g;
      }));
    }
    twisty.textContent = node && node.kids ? (collapsed.has(id) ? "▸" : "▾") : "";
    twisty.title = node && node.kids ? `${node.kids} request${node.kids === 1 ? "" : "s"} started by this one. Alt+click for everything below.` : "";
    tr.classList.toggle("context", !!(node && node.context));
    // Waterfall bar
    const bar = tr.lastChild.firstChild;
    const end = s.end ?? now;
    const dur = Math.max(1, end - s.start);
    bar.style.left = ((s.start - t0) / span) * 100 + "%";
    bar.style.width = Math.max(0.15, (dur / span) * 100) + "%";
    const waitFrac = s.firstByte ? Math.min(1, Math.max(0, (s.firstByte - s.start) / dur)) : 1;
    bar.firstChild.style.width = waitFrac * 100 + "%";
    bar.classList.toggle("pending", s.state === "pending");
    list.push(tr);
  }
  topPad.firstChild.style.height = first * rowH + "px";
  bottomPad.firstChild.style.height = (view.length - last) * rowH + "px";
  topPad.hidden = !first;
  bottomPad.hidden = last >= view.length;
  tbody.replaceChildren(topPad, ...list, bottomPad);

  if (list.length) {
    const h0 = list[0].getBoundingClientRect().height;
    if (h0 && Math.abs(h0 - rowH) > 0.5) { rowH = h0; scheduleRefresh(); }
  }
  if (stickPending) { stickPending = false; listPane.scrollTop = maxTop; }
}

function refreshView() {
  if (viewDirty) rebuildView();
  const now = Date.now();
  let t0 = Infinity;
  let t1 = -Infinity;
  let transferred = 0;
  let size = 0;
  for (const id of view) {
    const s = store.get(id);
    if (s.start < t0) t0 = s.start;
    const end = s.end ?? now;
    if (end > t1) t1 = end;
    if (!s.fromCache && s.transferred) transferred += s.transferred;
    if (s.size) size += s.size;
  }
  const visible = view.length;
  // With a time range picked in the overview, the waterfall column shows that range.
  if (state.timeRange) { t0 = state.timeRange.from; t1 = state.timeRange.to; }
  renderRows(t0, Math.max(1, t1 - t0), now);

  $("st-count").textContent = visible === store.size
    ? `${store.size} request${store.size === 1 ? "" : "s"}`
    : `${visible} / ${store.size} requests`;
  $("st-transferred").textContent = `${fmtBytes(transferred)} transferred`;
  $("st-size").textContent = `${fmtBytes(size)} resources`;
  $("st-finish").textContent = visible ? `Span: ${fmtMs(t1 - t0)}` : "";

  const rec = $("st-recording");
  rec.textContent = state.recording ? "Recording" : "Paused";
  rec.classList.toggle("on", state.recording);

  if (!store.size) {
    emptyMsg.textContent = state.recording
      ? "Waiting for network activity. Requests show up here as they happen."
      : "Recording is paused. Press the record button to start capturing again.";
    emptyMsg.hidden = false;
  } else if (!visible) {
    emptyMsg.textContent = state.tabFilter === "current" && !state.filterTokens.length && state.typeFilter === "all"
      ? "No requests from this tab yet. Choose “All tabs” above to see everything."
      : "No requests match the current filters.";
    emptyMsg.hidden = false;
  } else {
    emptyMsg.hidden = true;
  }

  document.title = `Network Monitor (${store.size})`;
}

// Keep pending bars growing.
setInterval(() => {
  for (const s of store.values()) {
    if (s.state === "pending") { scheduleRefresh(); overviewChanged(); return; }
  }
}, 1000);

/* ---------------------------------------------------------------------------
 * Updates from the background
 * ------------------------------------------------------------------------- */
function isAtBottom() {
  return listPane.scrollHeight - listPane.scrollTop - listPane.clientHeight < 30;
}

function clearAllRows() {
  store.clear();
  view = [];
  viewPos = new Map();
  viewDirty = true;
  closeDetails();
  scheduleRefresh();
}

let tabsDirty = false;

function applyBatch(list, removed) {
  if (isAtBottom() && !state.sortKey && state.viewMode === "list") stickPending = true;
  for (const id of removed || []) {
    store.delete(id);
    if (viewPos.has(id)) viewDirty = true;
    if (state.selectedId === id) closeDetails();
  }

  let selectedChanged = false;
  for (const s of list) {
    const isNew = !store.has(s.id);
    store.set(s.id, s);
    if (s.tabId >= 0 && !tabTitles.has(s.tabId)) tabsDirty = true;
    if (!viewDirty) {
      const shown = matches(s);
      if (state.viewMode === "tree") {
        if (isNew || shown !== viewPos.has(s.id) || s.initiator) viewDirty = true;
      } else if (isNew && shown && !state.sortKey) {
        viewPos.set(s.id, view.length); // ids only grow, so new requests go last
        view.push(s.id);
      } else if (shown !== viewPos.has(s.id) || (shown && state.sortKey)) {
        viewDirty = true;
      }
    }
    if (s.id === state.selectedId && (!current || current.rev !== s.rev)) selectedChanged = true;
  }

  scheduleRefresh();
  if (list.length || (removed && removed.length)) overviewChanged();
  if (selectedChanged) scheduleDetailsReload();
  if (tabsDirty) scheduleTabRefresh();
}

function applySettings(st) {
  const blockersChanged = String(st.blockers || []) !== String(state.blockers);
  state.blockers = st.blockers || [];
  if (blockersChanged) for (const tr of rendered.values()) tr._rev = null; // relabel blocked rows
  state.recording = st.recording;
  state.captureBodies = st.captureBodies;
  recordBtn.classList.toggle("paused", !st.recording);
  recordBtn.title = st.recording ? "Pause recording" : "Resume recording";
  bodiesChk.checked = st.captureBodies;
  state.blocked = new Set(st.blocked || []);
  scheduleRefresh();
}

const port = browser.runtime.connect({ name: "panel" });
port.onMessage.addListener((msg) => {
  switch (msg.type) {
    case "snapshot":
      clearAllRows();
      state.originTabId = msg.originTabId ?? null;
      applySettings(msg.settings);
      applyBatch(msg.entries, []);
      Overview.reset(msg.timings);
      stickPending = true;
      refreshTabs();
      break;
    case "origin":
      state.originTabId = msg.tabId;
      refreshTabs();
      if (state.tabFilter === "current") applyFilters();
      break;
    case "update":
      applyBatch(msg.entries, msg.removed);
      break;
    case "cleared":
      clearAllRows();
      Overview.reset();
      break;
    case "timing":
      Overview.addTiming(msg.timing);
      break;
    case "settings":
      applySettings(msg.settings);
      break;
  }
});

/* ---------------------------------------------------------------------------
 * Toolbar
 * ------------------------------------------------------------------------- */
recordBtn.addEventListener("click", () => {
  browser.runtime.sendMessage({ cmd: "setSettings", settings: { recording: !state.recording } });
});

if (IS_CHROME) {
  bodiesChk.parentElement.title = "Capture response bodies, TLS details and exact sizes for new requests. " +
    "Chrome only gives these to extensions through its debugger, so while this is on Chrome shows a " +
    "“Network Monitor started debugging this browser” bar. Clicking Cancel there turns this off.";
}

bodiesChk.addEventListener("change", () => {
  browser.runtime.sendMessage({ cmd: "setSettings", settings: { captureBodies: bodiesChk.checked } });
});

$("btn-clear").addEventListener("click", () => {
  browser.runtime.sendMessage({ cmd: "clear" });
});

/* ---------------------------------------------------------------------------
 * Filter rules. The search box filters live as you type; Enter turns what's
 * typed into saved rules, one per token. The Rules popover lists them to turn
 * on and off, edit or remove. Every enabled rule (and the box) must match.
 * ------------------------------------------------------------------------- */
let filterRules = []; // [{ text, enabled }]
const rulesBtn = $("btn-rules");
const rulesPop = $("rules-pop");
const rulesList = $("rules-list");
const ruleAdd = $("rule-add");

function compileFilters() {
  const ruleText = filterRules.filter((r) => r.enabled).map((r) => r.text).join(" ");
  // What's typed in the Rules box filters live, before Enter saves it.
  state.filterTokens = NetFilter.parse(ruleText + " " + ruleAdd.value);
  const on = filterRules.filter((r) => r.enabled).length;
  rulesBtn.textContent = filterRules.length ? `Rules (${on}${on !== filterRules.length ? "/" + filterRules.length : ""})` : "Rules";
  rulesBtn.classList.toggle("active", on > 0);
  rulesBtn.title = (on ? filterRules.filter((r) => r.enabled).map((r) => r.text).join("\n") + "\n\n" : "") + "Filter rules (Ctrl+F)";
  applyFilters();
}

function saveRules() {
  browser.storage.local.set({ filterRules }).catch(() => {});
  compileFilters();
  if (!rulesPop.hidden) renderRules();
}

function addRules(text) {
  const have = new Set(filterRules.map((r) => r.text));
  for (const tok of String(text).split(/\s+/).filter(Boolean)) {
    if (!have.has(tok)) { filterRules.push({ text: tok, enabled: true }); have.add(tok); }
  }
  saveRules();
}

function renderRules() {
  rulesList.replaceChildren(...filterRules.map((rule, i) => {
    const d = NetFilter.describe(rule.text);
    const input = h("input", { type: "text", class: "rule-text", value: rule.text, spellcheck: "false", "aria-label": "Rule" });
    const desc = h("div", { class: "rule-desc" + (d.warn ? " warn" : "") }, d.text);
    input.addEventListener("input", () => { desc.textContent = input.value.trim() ? NetFilter.describe(input.value.trim()).text : "Empty rules are removed."; });
    input.addEventListener("change", () => {
      const parts = input.value.trim().split(/\s+/).filter(Boolean);
      filterRules.splice(i, 1, ...parts.map((text) => ({ text, enabled: rule.enabled })));
      saveRules();
    });
    input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") input.blur(); });
    return h("li", { class: "rule" + (rule.enabled ? "" : " off") },
      h("input", { type: "checkbox", checked: rule.enabled, title: rule.enabled ? "Turn this rule off" : "Turn this rule on",
        onchange: (ev) => { rule.enabled = ev.target.checked; saveRules(); } }),
      h("div", { class: "rule-body" }, input, desc),
      h("button", { class: "icon-btn rule-del", title: "Remove rule", onclick: () => { filterRules.splice(i, 1); saveRules(); } }, "×"));
  }));
  if (!filterRules.length) rulesList.append(h("li", { class: "note" }, "No rules yet. Type a filter in the search box and press Enter, or add one below."));
}

function openRules() {
  renderRules();
  rulesPop.hidden = false;
  const r = rulesBtn.getBoundingClientRect();
  rulesPop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - rulesPop.offsetWidth - 8)) + "px";
  rulesPop.style.top = r.bottom + 4 + "px";
  ruleAdd.focus();
}
// Closing drops an unsaved filter, so nothing filters that isn't listed as a rule.
const closeRules = () => {
  rulesPop.hidden = true;
  if (ruleAdd.value) { ruleAdd.value = ""; compileFilters(); }
};

rulesBtn.addEventListener("click", () => (rulesPop.hidden ? openRules() : closeRules()));
document.addEventListener("mousedown", (ev) => {
  if (!rulesPop.hidden && !rulesPop.contains(ev.target) && ev.target !== rulesBtn) closeRules();
});
rulesPop.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") { ev.stopPropagation(); closeRules(); rulesBtn.focus(); }
});
ruleAdd.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && ruleAdd.value.trim()) { const text = ruleAdd.value; ruleAdd.value = ""; addRules(text); }
});
let filterTimer = null;
ruleAdd.addEventListener("input", () => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(compileFilters, 120);
});
// Ctrl+F (Cmd+F) opens the filter rules, like focusing the filter in DevTools.
document.addEventListener("keydown", (ev) => {
  if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && !ev.shiftKey && (ev.key === "f" || ev.key === "F")) {
    ev.preventDefault();
    if (rulesPop.hidden) openRules(); else ruleAdd.focus();
  }
}, true);
$("rules-all-on").addEventListener("click", () => { for (const r of filterRules) r.enabled = true; saveRules(); });
$("rules-all-off").addEventListener("click", () => { for (const r of filterRules) r.enabled = false; saveRules(); });
$("rules-copy").addEventListener("click", (ev) => copyText(filterRules.filter((r) => r.enabled).map((r) => r.text).join(" "), ev.currentTarget));
$("rules-clear").addEventListener("click", () => { filterRules = []; saveRules(); });


browser.storage.local.get("filterRules").then(({ filterRules: saved }) => {
  if (Array.isArray(saved)) filterRules = saved.filter((r) => r && typeof r.text === "string").map((r) => ({ text: r.text, enabled: r.enabled !== false }));
  compileFilters();
}, () => compileFilters());

$("type-filters").addEventListener("click", (ev) => {
  const btn = ev.target.closest("button[data-type]");
  if (!btn) return;
  state.typeFilter = btn.dataset.type;
  for (const b of document.querySelectorAll("#type-filters button")) b.classList.toggle("active", b === btn);
  applyFilters();
});

$("view-mode").addEventListener("click", (ev) => {
  const btn = ev.target.closest("button[data-mode]");
  if (btn && btn.dataset.mode !== state.viewMode) setViewMode(btn.dataset.mode);
});
try { if (localStorage.getItem("viewMode") === "tree") setViewMode("tree"); } catch { /* storage unavailable */ }


$("btn-har").addEventListener("click", () => {
  saveHar(visibleIds()).catch((err) => toast(`Couldn't save HAR: ${err.message || err}`));
});

/* ---------------------------------------------------------------------------
 * Tab picker: "Current tab" and "All tabs" first, then the tabs grouped by
 * browser window in tab-strip order. Closed tabs that still have requests
 * stay under their window with their last title crossed out; the background
 * remembers titles and windows after tabs close. A native <select> can't
 * show crossed-out options in every browser, so this is a listbox popover.
 * ------------------------------------------------------------------------- */
const tabPop = $("tab-pop");
const tabSearch = $("tab-search");
const tabOptions = $("tab-options");
let tabInfo = { tabs: [], windows: [], panelWindowId: null };
let tabHighlight = null; // value of the highlighted option
// Tab groups start collapsed; these are the ones opened in this panel session.
const openTabGroups = new Set();

async function refreshTabs() {
  tabsDirty = false;
  let info;
  try { info = await browser.runtime.sendMessage({ cmd: "tabList" }); } catch { return; }
  if (!info) return;
  tabInfo = info;
  tabTitles.clear();
  for (const t of info.tabs) tabTitles.set(t.id, t);
  const f = state.tabFilter;
  if (!["current", "all", "none"].includes(f) && !tabTitles.has(Number(f)) && ![...store.values()].some((s) => String(s.tabId) === f)) {
    state.tabFilter = "current";
    applyFilters();
  }
  updateTabButton();
  if (!tabPop.hidden) renderTabOptions();
}

const tabTitleOf = (t, id) => (t && (t.title || t.url)) || `Tab #${id}`;

/* A tab's icon. Chrome: from its favicon cache (the _favicon endpoint, no
 * network). Firefox: the icon URL the tab reported, which the page has just
 * loaded, so it normally comes from cache. Anything else (no icon, internal
 * pages, a load error) shows a plain page icon. */
const BLANK_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4 1.5h5.5L13 5v9.5H4z" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/><path d="M9.5 1.5V5H13" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/></svg>';
function tabIconSrc(t) {
  if (!t) return null;
  if (IS_CHROME) return /^https?:/.test(t.url || "") ? `${browser.runtime.getURL("/_favicon/")}?pageUrl=${encodeURIComponent(t.url)}&size=32` : null;
  return /^(https?|data):/.test(t.favIconUrl || "") ? t.favIconUrl : null;
}
function tabIcon(t) {
  const box = h("span", { class: "tab-icon" });
  const src = tabIconSrc(t);
  const blank = () => { box.innerHTML = BLANK_ICON; box.classList.add("blank"); };
  if (!src) { blank(); return box; }
  const img = h("img", { src, alt: "", width: "16", height: "16", decoding: "async", referrerpolicy: "no-referrer" });
  img.addEventListener("error", blank, { once: true });
  box.append(img);
  return box;
}

// The options, in order: { group } headers and { value, title, closed, count, inGroup } rows.
function tabItems() {
  const counts = new Map();
  for (const s of store.values()) counts.set(s.tabId, (counts.get(s.tabId) || 0) + 1);
  const items = [];
  const origin = state.originTabId;
  const ot = origin != null ? tabTitles.get(origin) : null;
  items.push({ value: "current", title: origin != null ? `Current tab: ${tabTitleOf(ot, origin)}` : "Current tab",
    closed: false, count: origin != null ? counts.get(origin) || 0 : null, tab: ot || null, icon: origin != null });
  items.push({ value: "all", title: "All tabs", count: store.size });

  const byWindow = new Map(); // windowId -> tabs shown
  const unknown = [];
  for (const [id, t] of tabTitles) {
    if (t.closed && !counts.get(id)) continue; // a closed tab with nothing left to show
    if (t.windowId == null) { unknown.push(id); continue; }
    if (!byWindow.has(t.windowId)) byWindow.set(t.windowId, []);
    byWindow.get(t.windowId).push(id);
  }
  for (const id of counts.keys()) if (id >= 0 && !tabTitles.has(id)) unknown.push(id);

  const order = (ids) => ids.sort((a, b) => {
    const A = tabTitles.get(a), B = tabTitles.get(b);
    return (A.index - B.index) || (a - b);
  });
  const groups = new Map((tabInfo.groups || []).map((g) => [g.id, g]));
  const tabItem = (id, depth, gid) => {
    const t = tabTitles.get(id);
    return { value: String(id), title: tabTitleOf(t, id), url: t ? t.url : "", closed: !t || t.closed, count: counts.get(id) || 0, inGroup: true, depth, gid, tab: t || null, icon: true };
  };
  // A window's tabs in tab-strip order; the tabs of a tab group sit together
  // under the group's name, where the group's first tab is.
  const addGroup = (label, note, ids) => {
    if (!ids.length) return;
    items.push({ group: label, note, level: 1 });
    const blocks = [];
    const byGroup = new Map();
    for (const id of ids) {
      const gid = (tabTitles.get(id) || {}).groupId ?? -1;
      if (gid < 0) { blocks.push(id); continue; }
      if (!byGroup.has(gid)) { const b = { gid, ids: [] }; byGroup.set(gid, b); blocks.push(b); }
      byGroup.get(gid).ids.push(id);
    }
    for (const b of blocks) {
      if (typeof b === "number") { items.push(tabItem(b, 1)); continue; }
      const g = groups.get(b.gid) || {};
      const open = b.ids.filter((id) => !tabTitles.get(id).closed).length;
      const notes = [`${open} tab${open === 1 ? "" : "s"}`];
      if (g.closed) notes.push("closed group");
      const requests = b.ids.reduce((n, id) => n + (counts.get(id) || 0), 0);
      items.push({ group: g.title || "Unnamed group", note: notes.join(" · "), level: 2, color: g.color || "grey", closed: !!g.closed,
        value: "group:" + b.gid, gid: b.gid, count: requests });
      for (const id of b.ids) items.push(tabItem(id, 2, b.gid));
    }
  };

  // The monitor's own window is left out unless other tabs share it.
  const openWins = tabInfo.windows.filter((w) => w.id !== tabInfo.panelWindowId || byWindow.has(w.id)).sort((a, b) => a.id - b.id);
  const multi = openWins.length > 1;
  openWins.forEach((w, i) => {
    const ids = order(byWindow.get(w.id) || []);
    byWindow.delete(w.id);
    const open = ids.filter((id) => !tabTitles.get(id).closed).length;
    const notes = [`${open} tab${open === 1 ? "" : "s"}`];
    if (w.incognito) notes.unshift("private");
    if (origin != null && ids.includes(origin)) notes.push("current tab's window");
    addGroup(multi ? `Window ${i + 1}` : "Window", notes.join(" · "), ids);
  });
  for (const [, ids] of byWindow) { // windows that have been closed
    const priv = ids.some((id) => tabTitles.get(id).incognito);
    addGroup("Closed window", priv ? "private" : "", order(ids));
  }
  if (unknown.length) addGroup("Closed tabs", "", unknown.sort((a, b) => a - b));

  items.push({ group: "Other", level: 1 });
  items.push({ value: "none", title: "No tab (browser / extensions)", count: counts.get(-1) || 0, inGroup: true, depth: 1 });
  return items;
}

function updateTabButton() {
  const item = tabItems().find((it) => it.value === state.tabFilter);
  const label = tabSelect.querySelector(".select-label");
  label.textContent = item ? item.title : "Current tab";
  const oldIcon = tabSelect.querySelector(".tab-icon");
  if (oldIcon) oldIcon.remove();
  if (item && item.icon) tabSelect.prepend(tabIcon(item.tab));
  tabSelect.classList.toggle("tab-closed", !!(item && item.closed && item.inGroup));
  tabSelect.title = (item ? item.title + (item.closed && item.inGroup ? " (closed)" : "") + "\n" : "") + "Show requests from one tab";
}

function renderTabOptions() {
  const q = tabSearch.value.trim().toLowerCase();
  let items = tabItems();
  if (q) {
    items = items.filter((it) => it.group || (it.title + " " + (it.url || "")).toLowerCase().includes(q));
    // Drop headings with no matching tab before the next heading of the same or a higher level.
    items = items.filter((it, i) => {
      if (!it.group) return true;
      for (const next of items.slice(i + 1)) {
        if (!next.group) return true;
        if (next.level <= it.level) return false;
      }
      return false;
    });
  }
  // Collapsed groups hide their tabs, except while searching.
  if (!q) items = items.filter((it) => it.group || it.gid == null || openTabGroups.has(it.gid));
  const values = items.filter((it) => !it.group || it.level === 2).map((it) => it.value);
  if (!values.includes(tabHighlight)) {
    tabHighlight = values.includes(state.tabFilter) ? state.tabFilter
      : values.find((v) => !v.startsWith("group:")) ?? values[0] ?? null; // a tab first, so Enter picks it
  }

  tabOptions.replaceChildren(...items.map((it) => {
    if (it.group && it.level === 2) {
      const open = !!q || openTabGroups.has(it.gid);
      return h("li", {
        class: "tab-subgroup" + (it.closed ? " tab-closed" : "") + (it.value === tabHighlight ? " hl" : ""),
        role: "option", id: "tab-opt-" + it.value, "data-value": it.value, "aria-expanded": String(open), "aria-selected": "false",
        title: open ? "Collapse this group" : "Show this group's tabs",
      },
        h("span", { class: "tg-chevron" }),
        h("span", { class: "tg-dot", style: `--tg:var(--tg-${it.color}, var(--tg-grey))` }),
        h("span", { class: "tab-title" }, it.group), h("span", { class: "tab-group-note" }, it.note),
        h("span", { class: "tab-count" }, String(it.count)));
    }
    if (it.group) return h("li", { class: "tab-group", role: "presentation" }, it.group, it.note ? h("span", { class: "tab-group-note" }, it.note) : null);
    const li = h("li", {
      class: "tab-opt" + (it.inGroup ? " in-group" : "") + (it.depth === 2 ? " in-tabgroup" : "") + (it.closed ? " tab-closed" : "") + (it.value === tabHighlight ? " hl" : ""),
      role: "option", id: "tab-opt-" + it.value, "data-value": it.value,
      "aria-selected": String(it.value === state.tabFilter),
      title: it.closed && it.inGroup ? `${it.title} (closed)` : it.url || it.title,
    }, it.icon ? tabIcon(it.tab) : it.value === "all" ? h("span", { class: "tab-icon" }) : null, h("span", { class: "tab-title" }, it.title), it.count != null ? h("span", { class: "tab-count" }, String(it.count)) : null);
    return li;
  }));
  if (!values.length) tabOptions.append(h("li", { class: "tab-empty" }, "No tab matches."));
  tabSearch.setAttribute("aria-activedescendant", tabHighlight != null ? "tab-opt-" + tabHighlight : "");
}

function highlightTab(value, scroll) {
  tabHighlight = value;
  for (const li of tabOptions.querySelectorAll(".tab-opt, .tab-subgroup")) li.classList.toggle("hl", li.dataset.value === value);
  tabSearch.setAttribute("aria-activedescendant", value != null ? "tab-opt-" + value : "");
  if (scroll) { const li = tabOptions.querySelector(`[data-value="${CSS.escape(value)}"]`); if (li) li.scrollIntoView({ block: "nearest" }); }
}

function toggleTabGroup(value, open) {
  const gid = Number(value.slice(6));
  if (open ?? !openTabGroups.has(gid)) openTabGroups.add(gid); else openTabGroups.delete(gid);
  tabHighlight = value;
  renderTabOptions();
  highlightTab(value, true);
}

function chooseTab(value) {
  if (value && value.startsWith("group:")) { toggleTabGroup(value); return; }
  closeTabPop();
  tabSelect.focus();
  if (value == null || value === state.tabFilter) return;
  state.tabFilter = value;
  updateTabButton();
  applyFilters();
}

function openTabPop() {
  tabSearch.value = "";
  tabHighlight = state.tabFilter;
  // The group holding the selected tab opens, so the selection is visible.
  const selId = state.tabFilter === "current" ? state.originTabId : Number(state.tabFilter);
  const selTab = selId != null ? tabTitles.get(selId) : null;
  if (selTab && selTab.groupId >= 0 && state.tabFilter !== "current") openTabGroups.add(selTab.groupId);
  renderTabOptions();
  tabPop.hidden = false;
  tabSelect.setAttribute("aria-expanded", "true");
  const r = tabSelect.getBoundingClientRect();
  tabPop.style.left = Math.max(8, Math.min(r.right - tabPop.offsetWidth, window.innerWidth - tabPop.offsetWidth - 8)) + "px";
  tabPop.style.top = r.bottom + 4 + "px";
  tabSearch.focus();
  highlightTab(tabHighlight, true);
  refreshTabs(); // pick up anything that changed since the last refresh
}
function closeTabPop() {
  tabPop.hidden = true;
  tabSelect.setAttribute("aria-expanded", "false");
}

tabSelect.addEventListener("click", () => (tabPop.hidden ? openTabPop() : closeTabPop()));
tabSelect.addEventListener("keydown", (ev) => {
  if (ev.key === "ArrowDown" || ev.key === "ArrowUp") { ev.preventDefault(); ev.stopPropagation(); if (tabPop.hidden) openTabPop(); }
});
document.addEventListener("mousedown", (ev) => {
  if (!tabPop.hidden && !tabPop.contains(ev.target) && !tabSelect.contains(ev.target)) closeTabPop();
});
tabSearch.addEventListener("input", () => { tabHighlight = null; renderTabOptions(); highlightTab(tabHighlight, true); });
tabPop.addEventListener("keydown", (ev) => {
  const values = [...tabOptions.querySelectorAll(".tab-opt, .tab-subgroup")].map((li) => li.dataset.value);
  const i = values.indexOf(tabHighlight);
  const move = (to) => { ev.preventDefault(); if (values.length) highlightTab(values[Math.max(0, Math.min(values.length - 1, to))], true); };
  switch (ev.key) {
    case "ArrowDown": move(i + 1); break;
    case "ArrowUp": move(i - 1); break;
    case "PageDown": move(i + 10); break;
    case "PageUp": move(i - 10); break;
    case "Home": if (!tabSearch.value) move(0); break;
    case "End": if (!tabSearch.value) move(values.length - 1); break;
    case "Enter": ev.preventDefault(); chooseTab(tabHighlight); break;
    case "ArrowRight":
    case "ArrowLeft": // open/close a highlighted group (the search box keeps its caret keys while typing)
      if (!tabSearch.value && tabHighlight && tabHighlight.startsWith("group:")) { ev.preventDefault(); toggleTabGroup(tabHighlight, ev.key === "ArrowRight"); }
      break;
    case "Escape": ev.preventDefault(); ev.stopPropagation(); closeTabPop(); tabSelect.focus(); break;
    case "Tab": closeTabPop(); break;
  }
});
tabOptions.addEventListener("mousemove", (ev) => {
  const li = ev.target.closest(".tab-opt, .tab-subgroup");
  if (li && li.dataset.value !== tabHighlight) highlightTab(li.dataset.value, false);
});
tabOptions.addEventListener("click", (ev) => {
  const li = ev.target.closest(".tab-opt, .tab-subgroup");
  if (li) chooseTab(li.dataset.value);
});

let tabTimer = null;
function scheduleTabRefresh() {
  clearTimeout(tabTimer);
  tabTimer = setTimeout(refreshTabs, 300);
}
browser.tabs.onCreated.addListener(scheduleTabRefresh);
browser.tabs.onRemoved.addListener(scheduleTabRefresh);
browser.tabs.onAttached.addListener(scheduleTabRefresh);
browser.tabs.onMoved.addListener(scheduleTabRefresh);
browser.windows.onCreated.addListener(scheduleTabRefresh);
browser.windows.onRemoved.addListener(scheduleTabRefresh);
browser.tabs.onUpdated.addListener((id, info) => { if (info.title || info.url || info.favIconUrl || "groupId" in info) scheduleTabRefresh(); });
if (browser.tabGroups && browser.tabGroups.onUpdated) {
  for (const ev of ["onCreated", "onUpdated", "onRemoved", "onMoved"]) if (browser.tabGroups[ev]) browser.tabGroups[ev].addListener(scheduleTabRefresh);
}


/* ---------------------------------------------------------------------------
 * Selection & keyboard
 * ------------------------------------------------------------------------- */
tbody.addEventListener("click", (ev) => {
  const tr = ev.target.closest("tr[data-id]");
  if (!tr) return;
  if (ev.target.closest(".twisty") && ev.target.textContent) {
    toggleCollapsed(Number(tr.dataset.id), ev.altKey);
    return;
  }
  const guide = ev.target.closest(".tguide");
  if (guide) {
    // Collapse the request the line belongs to, and keep its row in sight.
    const anc = Number(guide.dataset.anc);
    toggleCollapsed(anc, ev.altKey);
    setTreeGuideHover(null);
    if (viewDirty) rebuildView();
    if (viewPos.has(anc)) revealIndex(viewPos.get(anc));
    return;
  }
  select(Number(tr.dataset.id));
});

function moveCursor(id) {
  state.cursorId = id;
  if (viewPos.has(id)) revealIndex(viewPos.get(id));
  scheduleRefresh();
}

// Scrolls just enough to bring row `i` of the view into sight.
function revealIndex(i) {
  const headH = tbody.parentElement.tHead.offsetHeight;
  const top = i * rowH;
  const room = listPane.clientHeight - headH;
  if (top < listPane.scrollTop) listPane.scrollTop = top;
  else if (top + rowH > listPane.scrollTop + room) listPane.scrollTop = top + rowH - room;
}

function select(id) {
  if (!store.has(id)) return;
  state.selectedId = id;
  state.cursorId = id;
  if (viewPos.has(id)) revealIndex(viewPos.get(id));
  detailsPane.hidden = false;
  splitter.hidden = false;
  document.body.classList.add("has-details");
  scheduleRefresh();
  loadDetails(id, false);
}

function closeDetails() {
  if (state.selectedId != null) scheduleRefresh();
  if (state.selectedId != null) state.cursorId = state.selectedId; // the keyboard carries on from there
  state.selectedId = null;
  current = null;
  detailsToken++;
  detailsPane.hidden = true;
  splitter.hidden = true;
  document.body.classList.remove("has-details");
  revokeBlobs();
  detailsBody.replaceChildren();
}

$("btn-close-details").addEventListener("click", closeDetails);

/* Ctrl+R / F5 (Cmd+R on macOS) reload the inspected tab, not the monitor, as
 * in DevTools; with Shift they bypass the cache. The inspected tab is the one
 * picked in the tab dropdown, or the tab the monitor was opened from. Works
 * from any focused control. */
function inspectedTabId() {
  const f = state.tabFilter;
  if (/^\d+$/.test(f)) return Number(f);
  return state.originTabId;
}
document.addEventListener("keydown", async (ev) => {
  const accel = ev.ctrlKey || ev.metaKey;
  const reload = (ev.key === "F5" && !accel && !ev.altKey) || (accel && !ev.altKey && (ev.key === "r" || ev.key === "R"));
  if (!reload) return;
  ev.preventDefault();
  ev.stopPropagation();
  if (ev.repeat) return;
  const id = inspectedTabId();
  const t = id != null ? tabTitles.get(id) : null;
  if (id == null || !t || t.closed) {
    toast(id == null ? "No tab to reload: pick one in the tab dropdown" : "That tab is closed");
    return;
  }
  const bypassCache = ev.shiftKey;
  try {
    await browser.tabs.reload(id, { bypassCache });
    toast(`${bypassCache ? "Hard reloading" : "Reloading"} “${tabTitleOf(t, id)}”`);
  } catch (err) {
    toast(`Couldn't reload the tab: ${err.message || err}`);
  }
}, true);

document.addEventListener("keydown", (ev) => {
  if (ev.target.matches("input, select, textarea") || document.querySelector("dialog[open]")) return;
  if (ev.key === "Escape") { closeDetails(); return; }
  const cursor = state.cursorId != null && viewPos.has(state.cursorId) ? state.cursorId : state.selectedId;
  const open = state.selectedId != null;
  // Enter / Space open the row the keyboard is on, and close it again, like
  // Escape (buttons keep their own Enter/Space).
  if ((ev.key === "Enter" || ev.key === " ") && !ev.target.closest("button, a, label, summary, [contenteditable]")) {
    ev.preventDefault();
    if (open && (cursor === state.selectedId || cursor == null)) closeDetails();
    else if (cursor != null && viewPos.has(cursor)) select(cursor);
    return;
  }
  if (open) {
    // Tab / Shift+Tab and Shift+Right / Shift+Left: next / previous details tab.
    const tabKey = ev.key === "Tab" && !ev.ctrlKey && !ev.altKey && !ev.metaKey;
    const arrowKey = (ev.key === "ArrowRight" || ev.key === "ArrowLeft") && ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey;
    if (tabKey || arrowKey) {
      ev.preventDefault();
      stepDetailsTab(tabKey ? (ev.shiftKey ? -1 : 1) : ev.key === "ArrowRight" ? 1 : -1);
      return;
    }
    // Shift + Up/Down, Page Up/Down, Home/End scroll the details pane.
    const SCROLL = { ArrowDown: 40, ArrowUp: -40, PageDown: "page", PageUp: "-page", Home: "top", End: "bottom" };
    if (ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey && ev.key in SCROLL) {
      ev.preventDefault();
      const by = SCROLL[ev.key];
      const page = Math.max(40, detailsBody.clientHeight - 40);
      if (by === "top") detailsBody.scrollTop = 0;
      else if (by === "bottom") detailsBody.scrollTop = detailsBody.scrollHeight;
      else detailsBody.scrollBy({ top: by === "page" ? page : by === "-page" ? -page : by });
      return;
    }
  }
  if ((ev.key === "ArrowLeft" || ev.key === "ArrowRight") && state.viewMode === "tree" && cursor != null) {
    const node = treeInfo && treeInfo.get(cursor);
    if (node && node.kids && collapsed.has(cursor) === (ev.key === "ArrowRight")) {
      ev.preventDefault();
      toggleCollapsed(cursor, false);
    }
    return;
  }
  // Up/Down: one row. PageUp/PageDown: a screenful, keeping one row of overlap.
  // Home/End: first/last row. These move the keyboard cursor; they don't open
  // the details pane. While it is open, it follows the cursor.
  const NAV = ["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End"];
  if (!NAV.includes(ev.key)) return;
  ev.preventDefault();
  if (viewDirty) rebuildView();
  if (!view.length) return;
  const headH = tbody.parentElement.tHead.offsetHeight;
  const page = Math.max(1, Math.floor((listPane.clientHeight - headH) / rowH) - 1);
  const at = cursor != null ? viewPos.get(cursor) : undefined;
  const step = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page }[ev.key];
  let i;
  if (ev.key === "Home") i = 0;
  else if (ev.key === "End") i = view.length - 1;
  else if (at == null) i = step > 0 ? 0 : view.length - 1;
  else i = Math.min(view.length - 1, Math.max(0, at + step));
  if (i === at) return;
  if (state.selectedId != null) select(view[i]);
  else moveCursor(view[i]);
});

/* Column resizing: dragging a header's right edge moves the border between it
 * and the next visible column. Widths are kept as percentages of the table so
 * they survive window resizes and the columns hidden while details are open. */
(function initColumnResize() {
  const ths = [...document.querySelectorAll("#requests thead th")];
  const visible = () => ths.filter((th) => th.offsetWidth > 0);
  const MIN = 36;

  let saved = null;
  try { saved = JSON.parse(localStorage.getItem("columnWidths") || "null"); } catch { /* storage unavailable */ }
  if (saved) for (const th of ths) if (saved[th.dataset.sort]) th.style.width = saved[th.dataset.sort];

  const save = () => {
    const widths = {};
    for (const th of ths) if (th.style.width) widths[th.dataset.sort] = th.style.width;
    try { localStorage.setItem("columnWidths", JSON.stringify(widths)); } catch { /* ignore */ }
  };

  for (const th of ths) {
    const grip = h("span", { class: "col-resizer", title: "Drag to resize. Double-click to reset all columns." });
    th.append(grip);

    grip.addEventListener("dblclick", () => {
      for (const t of ths) t.style.width = "";
      try { localStorage.removeItem("columnWidths"); } catch { /* ignore */ }
    });

    grip.addEventListener("mousedown", (ev) => {
      const cols = visible();
      const next = cols[cols.indexOf(th) + 1];
      if (!next) return;
      ev.preventDefault();
      // Freeze every visible column at its current width so only this pair moves.
      const total = th.closest("table").offsetWidth;
      const widths = new Map(cols.map((c) => [c, c.offsetWidth]));
      for (const [c, w] of widths) c.style.width = (w / total) * 100 + "%";
      const a = widths.get(th);
      const b = widths.get(next);
      const x0 = ev.clientX;
      document.body.classList.add("col-resizing");

      const move = (e) => {
        const dx = Math.max(MIN - a, Math.min(b - MIN, e.clientX - x0));
        th.style.width = ((a + dx) / total) * 100 + "%";
        next.style.width = ((b - dx) / total) * 100 + "%";
      };
      const up = () => {
        document.body.classList.remove("col-resizing");
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        resizedAt = Date.now();
        save();
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });
  }
})();

/* Splitter */
(function initSplitter() {
  let saved = 0;
  try { saved = Number(localStorage.getItem("detailsWidth")); } catch { /* storage unavailable */ }
  if (saved) detailsPane.style.width = saved + "px";
  splitter.addEventListener("mousedown", (ev) => {
    ev.preventDefault();
    splitter.classList.add("dragging");
    const move = (e) => {
      const w = Math.min(window.innerWidth - 240, Math.max(320, window.innerWidth - e.clientX));
      detailsPane.style.width = w + "px";
    };
    const up = () => {
      splitter.classList.remove("dragging");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      try { localStorage.setItem("detailsWidth", parseInt(detailsPane.style.width, 10) || 0); } catch { /* ignore */ }
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
})();

/* ---------------------------------------------------------------------------
 * Details pane
 * ------------------------------------------------------------------------- */
// Moves to the next (1) or previous (-1) details tab that applies, wrapping.
function stepDetailsTab(dir) {
  const btns = [...document.querySelectorAll("#details-tabs button[data-tab]")].filter((b) => !b.hidden);
  if (!btns.length) return;
  const i = btns.findIndex((b) => b.classList.contains("active"));
  btns[(i + dir + btns.length) % btns.length].click();
}
// A click on a details tab doesn't leave focus on it, so Enter/Space/arrows
// keep working on the list.
$("details-tabs").addEventListener("mousedown", (ev) => { if (ev.target.closest("button[data-tab]")) ev.preventDefault(); });

$("details-tabs").addEventListener("click", (ev) => {
  const btn = ev.target.closest("button[data-tab]");
  if (!btn) return;
  state.detailsTab = btn.dataset.tab;
  renderDetails(false);
});

async function loadDetails(id, keepScroll) {
  const token = ++detailsToken;
  const d = await browser.runtime.sendMessage({ cmd: "getDetails", id });
  if (token !== detailsToken || state.selectedId !== id) return;
  current = d;
  renderDetails(keepScroll);
}

let reloadTimer = null;
function scheduleDetailsReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    if (state.selectedId != null) loadDetails(state.selectedId, true);
  }, 300);
}

let previewFonts = []; // FontFaces added for font previews

function revokeBlobs() {
  for (const u of blobUrls) URL.revokeObjectURL(u);
  blobUrls = [];
  for (const f of previewFonts) document.fonts.delete(f);
  previewFonts = [];
}

function renderDetails(keepScroll) {
  const scroll = detailsBody.scrollTop;
  revokeBlobs();
  for (const b of document.querySelectorAll("#details-tabs button[data-tab]")) {
    b.classList.toggle("active", b.dataset.tab === state.detailsTab);
  }
  detailsBody.replaceChildren();
  if (!current) {
    detailsBody.append(note("This request is no longer available."));
    return;
  }
  const isWs = current.type === "websocket";
  $("details-tabs").querySelector('[data-tab="messages"]').hidden = !isWs;
  if (state.detailsTab === "messages" && !isWs) {
    state.detailsTab = "headers";
    for (const b of document.querySelectorAll("#details-tabs button[data-tab]")) b.classList.toggle("active", b.dataset.tab === "headers");
  }
  const render = { headers: renderHeaders, cookies: renderCookies, request: renderRequest, response: renderResponse, timings: renderTimings, security: renderSecurity, messages: renderMessages }[state.detailsTab];
  detailsBody.append(...[].concat(render(current)).filter(Boolean));
  if (keepScroll) detailsBody.scrollTop = scroll;
}

function note(text, cls) {
  return h("div", { class: "note" + (cls ? " " + cls : "") }, text);
}

/* The one key/value list used everywhere (summary, headers, cookies,
 * parameters, timings, security, font info). data ("header", "cookie" or
 * "param") marks names and values as sent: monospace, and copyable by name.
 * Every row has the same right-click menu. */
const kvRows = new WeakMap(); // row -> { kind, name, value }
const textOf = (v) => (v == null ? "" : v instanceof Node ? v.textContent : String(v));
function kvTable(pairs, data) {
  return h("table", { class: "kv" + (data ? " data" : "") },
    h("tbody", null, pairs.map(([k, v]) => {
      const tr = h("tr", null, h("td", { class: "k" }, k), h("td", null, v));
      kvRows.set(tr, { kind: data || "fact", name: textOf(k), value: textOf(v) });
      return tr;
    })));
}

detailsBody.addEventListener("contextmenu", (ev) => {
  const tr = ev.target.closest("table.kv tr");
  const row = tr && kvRows.get(tr);
  if (!row) return;
  ev.preventDefault();
  const { kind, name, value } = row;
  if (kind === "fact") {
    openMenu(ev.clientX, ev.clientY, [
      { label: "Copy Value", run: () => copy(value, "Value copied") },
      { label: "Copy Row", run: () => copy(`${name}: ${value}`, "Row copied") },
    ], ev.target);
    return;
  }
  const Noun = { header: "Header", cookie: "Cookie", param: "Parameter" }[kind];
  openMenu(ev.clientX, ev.clientY, [
    { label: "Copy Name", run: () => copy(name, "Name copied") },
    { label: "Copy Value", run: () => copy(value, "Value copied") },
    { label: `Copy ${Noun}`, run: () => copy(kind === "header" ? `${name}: ${value}` : `${name}=${value}`, `${Noun} copied`) },
    row.setCookie && { label: "Copy Set-Cookie Value", run: () => copy(row.setCookie, "Set-Cookie value copied") },
  ], ev.target);
});

function section(title, count, ...content) {
  return h("details", { class: "section", open: true },
    h("summary", null, title, count != null ? h("span", { class: "count" }, ` (${count})`) : null),
    ...content);
}

// Text shown exactly as sent (URLs, addresses, hashes): monospace.
const mono = (v) => (v == null || v === "" ? v : h("span", { class: "mono" }, v));

// The request this one hangs under in the tree, as a link that selects it.
function causedBy(d) {
  const pid = treeParents().get(d.id);
  const p = pid != null && store.get(pid);
  if (!p) return null;
  const how = d.redirectedFrom === pid ? "redirect from " : "";
  return h("a", { href: "#", class: "link", title: p.url, onclick: (e) => { e.preventDefault(); select(pid); } },
    `${how}${p.method} ${fileName(p.url)}`);
}

/* Headers tab */
function renderHeaders(d) {
  const statusText = d.status != null
    ? h("span", { class: "status-chip " + statusClass(d) }, `${d.status} ${d.statusText || ""}`.trim())
    : d.state === "pending" ? "Pending…" : "—";

  const cause = causedBy(d);
  const pairs = [
    ["URL", mono(d.url)],
    ["Method", d.method],
    ["Status", statusText],
    d.httpVersion && ["Version", d.httpVersion],
    d.ip && ["Address", mono(d.ip)],
    ["Type", `${causeLabel(d.type)}${effectiveMime(d).mime ? " · " + mimeTitle(d) : ""}`],
    d.initiatorLoc && ["Started by script", mono(d.initiatorLoc)],
    cause && ["Caused by", cause],
    d.originUrl && ["Initiator", mono(d.originUrl)],
    d.documentUrl && d.documentUrl !== d.originUrl && ["Document", mono(d.documentUrl)],
    ["Tab", tabLabel(d.tabId)],
    ["Started", fmtClock(d.start)],
    ["Duration", d.end ? fmtMs(d.end - d.start) : "Pending…"],
    d.fromCache && ["Cache", "Served from cache"],
    d.redirectUrl && ["Redirected to", mono(d.redirectUrl)],
    d.error && ["Error", h("span", { class: "warn", title: failure(d).title }, `${failure(d).text}${failure(d).text !== d.error ? ` (${d.error})` : ""}`)],
    ["Third party", d.thirdParty ? "Yes" : "No"],
  ].filter(Boolean);

  const summary = kvTable(pairs);

  const copyUrlBtn = h("button", { class: "text-btn", onclick: (e) => copyText(d.url, e.currentTarget) }, "Copy URL");
  const curlBtn = h("button", { class: "text-btn", onclick: (e) => copyText(curlCommand(d, false), e.currentTarget) }, "Copy as cURL");
  const rawToggle = h("label", { class: "check" },
    h("input", { type: "checkbox", checked: state.rawHeaders, onchange: (e) => { state.rawHeaders = e.target.checked; renderDetails(true); } }),
    "Raw headers");

  const u = safeUrl(d.url);
  const reqLine = `${d.method} ${u ? u.pathname + u.search : d.url} ${d.httpVersion || ""}`.trim();

  return [
    h("div", { class: "actions" }, copyUrlBtn, curlBtn, rawToggle),
    summary,
    headerSection("Response headers", d.responseHeaders, d.statusLine, d.state === "pending"),
    headerSection("Request headers", d.requestHeaders, reqLine, false),
  ];
}

function headerSection(title, list, firstLine, pending) {
  if (!list || !list.length) {
    return section(title, 0, note(pending ? "Not received yet." : "No headers."));
  }
  if (state.rawHeaders) {
    const raw = [firstLine, ...list.map((x) => `${x.name}: ${x.value}`)].filter(Boolean).join("\n");
    return section(title, list.length, h("pre", { class: "code" }, raw));
  }
  return section(title, list.length, kvTable(list.map((x) => [x.name, x.value]), "header"));
}

/* Cookies tab */
function renderCookies(d) {
  const reqCookies = parseCookieHeader(header(d.requestHeaders, "cookie"));
  const resCookies = parseSetCookies(headerAll(d.responseHeaders, "set-cookie"));
  const out = [];
  out.push(section("Response cookies", resCookies.length,
    resCookies.length
      ? h("table", { class: "kv data" }, h("tbody", null, resCookies.map((c) => {
          const tr = h("tr", null, h("td", { class: "k" }, c.name), h("td", null, c.value, c.attrs.length ? h("div", { class: "note" }, c.attrs.join("; ")) : null));
          kvRows.set(tr, { kind: "cookie", name: c.name, value: c.value, setCookie: c.attrs.length ? [`${c.name}=${c.value}`, ...c.attrs].join("; ") : null });
          return tr;
        })))
      : note("No cookies set by this response.")));
  out.push(section("Request cookies", reqCookies.length,
    reqCookies.length ? kvTable(reqCookies.map((c) => [c.name, c.value]), "cookie") : note("No cookies sent with this request.")));
  return out;
}

/* Request tab */
function renderRequest(d) {
  const out = [];
  const u = safeUrl(d.url);
  const params = u ? [...u.searchParams] : [];
  if (params.length) out.push(section("Query string", params.length, kvTable(params, "param")));

  const rb = d.requestBody;
  if (!rb) {
    out.push(note(params.length ? "No request body." : "This request has no query string or body."));
  } else if (rb.error) {
    out.push(note(`${BROWSER} couldn't read the request body: ${rb.error}`, "warn"));
  } else if (rb.formData) {
    const pairs = Object.entries(rb.formData).flatMap(([k, vs]) => vs.map((v) => [k, v]));
    out.push(section("Form data", pairs.length, kvTable(pairs, "param")));
  } else if (rb.raw) {
    const ct = parseContentType(header(d.requestHeaders, "content-type"));
    const content = [bodyView(rb.raw, ct.mime, ct.charset, d.url)];
    if (rb.truncated) content.unshift(note(`Only the first ${fmtBytes(rb.raw.byteLength)} were captured.`));
    if (rb.files && rb.files.length) content.push(note(`Uploaded file(s): ${rb.files.join(", ")}`));
    out.push(section(`Request payload`, null, ...content));
  }
  return out;
}

/* Response tab */
const BODY_NOTES = {
  off: "Response bodies weren't being captured when this request ran. Turn on “Capture bodies” in the toolbar to record them for new requests.",
  skipped: "Response bodies aren't captured for media and WebSocket requests, since they're streams.",
  unavailable: "The browser didn't make this response body available.",
  evicted: "This body was dropped to keep memory use under the limit. Newer bodies are kept first.",
  none: "No response body was recorded.",
};

function renderResponse(d) {
  const ct = parseContentType(header(d.responseHeaders, "content-type"));
  const out = [];
  const body = d.responseBody;

  if (d.bodyState === "capturing") out.push(note("Response is still loading. This view updates as data arrives."));
  if (d.bodyState === "truncated") out.push(note(`Only the first ${fmtBytes(d.storedBytes)} of this response were captured.`));
  if (d.bodyState === "partial") out.push(note("The response was interrupted. Showing what arrived before it stopped.", "warn"));
  if (d.bodyState === "error") out.push(note(`Couldn't read the response body${d.bodyError ? `: ${d.bodyError}` : ""}.`, "warn"));

  if (body && body.byteLength) {
    out.push(bodyView(body, ct.mime, ct.charset || d.charset, d.url, { tabId: d.tabId, key: `${d.id}:${d.rev}` }));
  } else if (BODY_NOTES[d.bodyState]) {
    out.push(note(d.bodyState === "unavailable" && d.bodyError ? d.bodyError : BODY_NOTES[d.bodyState]));
  } else if (d.bodyState === "done") {
    out.push(note(d.state === "redirect" || d.status === 204 || d.status === 304 ? "This response has no body." : "The response body is empty."));
  }
  return out;
}

function looksTextual(buf) {
  const bytes = new Uint8Array(buf, 0, Math.min(buf.byteLength, 1024));
  if (bytes.includes(0)) return false;
  const sample = new TextDecoder("utf-8").decode(bytes);
  const bad = (sample.match(/\uFFFD/g) || []).length;
  return bad <= 2;
}

function hexDump(buf, max) {
  const bytes = new Uint8Array(buf, 0, Math.min(buf.byteLength, max));
  const lines = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const slice = bytes.subarray(i, i + 16);
    const hex = [...slice].map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = [...slice].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("");
    lines.push(`${i.toString(16).padStart(8, "0")}  ${hex.padEnd(47)}  ${ascii}`);
  }
  return lines.join("\n");
}

const TEXT_LIMIT = 2_000_000;

// Renders an HTML body in a fully sandboxed frame (no scripts, forms, popups or
// same-origin access), with its images, stylesheets and fonts taken from the
// recorded traffic. Built previews are cached so live updates don't redo them.
const previewCache = new Map(); // key -> Promise<{ html, found, missing }>

function htmlPreview(text, url, ctx) {
  const frame = h("iframe", { class: "html-preview", sandbox: "", referrerpolicy: "no-referrer", title: "Preview" });
  const info = note("Building preview from recorded traffic…");
  const el = h("div", { class: "preview-wrap" }, info, frame);

  const tabId = ctx ? ctx.tabId : -1;
  // The key changes when this tab records more requests, so resources that
  // finished loading after the page did are picked up next time.
  let tabCount = 0;
  for (const s of store.values()) if (s.tabId === tabId && s.state !== "pending") tabCount++;
  const key = ctx ? `${ctx.key}:${tabCount}` : null;

  let job = key && previewCache.get(key);
  if (!job) {
    job = HtmlPreview.build(text, url || "about:blank", (urls) =>
      browser.runtime.sendMessage({ cmd: "previewResources", urls, tabId }));
    if (key) {
      previewCache.set(key, job);
      while (previewCache.size > 8) previewCache.delete(previewCache.keys().next().value);
    }
  }
  job.then((r) => {
    frame.srcdoc = r.html;
    const total = r.found + r.missing;
    info.textContent = !total
      ? "Rendered offline with scripts off. This page references no images, stylesheets or fonts."
      : r.missing
        ? `Rendered offline with scripts off. ${r.found} of ${total} images, stylesheets and fonts came from recorded traffic; the ${r.missing} that weren't recorded are left out.`
        : `Rendered offline with scripts off. All ${total} images, stylesheets and fonts came from recorded traffic.`;
  }, (err) => {
    if (key) previewCache.delete(key);
    info.textContent = `Couldn't build the preview: ${err.message || err}`;
    info.classList.add("warn");
  });
  return el;
}

// SVG served as XML, plain text or octet-stream still gets a picture.
function looksLikeSvg(buf, url) {
  if (/\.svgz?$/i.test(safeUrl(url)?.pathname || "")) return true;
  const head = new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(buf.byteLength, 1024)));
  return /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head);
}

// Images (SVGs included) are shown through <img>, so an SVG's scripts never
// run and it can't load anything. Tiny images, like icons, are enlarged.
function imagePreview(buf, mime) {
  const blobUrl = URL.createObjectURL(new Blob([buf], { type: mime }));
  blobUrls.push(blobUrl);
  const info = note(`${mime}, ${fmtBytes(buf.byteLength)}`);
  const img = h("img", { src: blobUrl, alt: "" });
  img.addEventListener("load", () => {
    const w = img.naturalWidth, ht = img.naturalHeight;
    let scale = "";
    if (w && ht && w <= 64 && ht <= 64) {
      const k = Math.max(1, Math.floor(128 / Math.max(w, ht)));
      img.style.width = w * k + "px";
      img.classList.toggle("pixelated", mime !== "image/svg+xml");
      scale = `, shown at ${k}×`;
    }
    info.textContent = `${mime}, ${w} × ${ht}${scale}, ${fmtBytes(buf.byteLength)}`;
  });
  img.addEventListener("error", () => { info.textContent = `${mime}, ${fmtBytes(buf.byteLength)}. ${BROWSER} couldn't display this image.`; });
  return h("div", null, h("div", { class: "img-preview" }, img), info);
}

const FONT_SAMPLE = "The quick brown fox jumps over the lazy dog";
const FONT_SIZES = [12, 16, 24, 32, 48, 72];
let fontSeq = 0;

function fontPreview(buf, mime) {
  const family = `netmon-preview-${++fontSeq}`;
  const status = note("Loading font…");
  const meta = h("div");
  const input = h("input", { type: "text", class: "font-sample-input", value: FONT_SAMPLE, spellcheck: "false", "aria-label": "Sample text" });
  const lines = FONT_SIZES.map((px) => h("div", { class: "font-line", style: `font-size:${px}px` }, FONT_SAMPLE));
  const charset = h("div", { class: "font-charset" },
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ", h("br"), "abcdefghijklmnopqrstuvwxyz", h("br"),
    "0123456789 !?&@#%$€£¥ ()[]{}<>+-=*/ .,:;'\"“”‘’ áéíóöőúüű ßçñ");
  const sample = h("div", { class: "font-sample", style: `font-family:"${family}", monospace` },
    ...lines.map((el, i) => h("div", { class: "font-row" }, h("span", { class: "font-px" }, `${FONT_SIZES[i]}px`), el)),
    charset);
  input.addEventListener("input", () => { for (const el of lines) el.textContent = input.value || FONT_SAMPLE; });

  const face = new FontFace(family, buf.slice(0));
  face.load().then((f) => {
    document.fonts.add(f);
    previewFonts.push(f);
    status.hidden = true;
  }, () => {
    status.textContent = /ms-fontobject/i.test(mime)
      ? `This is an EOT font (old Internet Explorer format), which ${BROWSER} can't display.`
      : `${BROWSER} couldn't load this font.`;
    status.classList.add("warn");
    sample.hidden = true;
  });

  FontInfo.read(buf).then((fi) => {
    const rows = [
      ["Family", fi.family],
      ["Style", fi.style],
      ["Full name", fi.fullName],
      ["Version", fi.version],
      ["Format", fi.format || mime || "Unknown"],
      ["Glyphs", fi.glyphs != null ? fi.glyphs.toLocaleString() : null],
      ["Size", fmtBytes(buf.byteLength)],
    ].filter(([, v]) => v);
    meta.replaceChildren(kvTable(rows));
  });

  return h("div", { class: "font-preview" }, meta, h("div", { class: "actions" }, input), status, sample);
}

// ctx (optional): { tabId, key } of the request, used by the HTML preview.
function bodyView(buf, mime, charset, url, ctx) {
  const wrap = h("div", { class: "body-view" });
  const size = buf.byteLength;

  // Trust the bytes over a missing, generic or plain-text Content-Type.
  if (NM.isGenericMime(mime) || mime === "text/plain") {
    const sniffed = NM.sniffMime(buf);
    if (sniffed && (sniffed !== "image/svg+xml" || NM.isGenericMime(mime))) {
      wrap.append(note(`Shown as ${sniffed}, detected from the content (${mime ? `the response said ${mime}` : "the response had no Content-Type"}).`));
      mime = sniffed;
    }
  }

  if (FontInfo.format(buf) || /^font\/|font-woff|x-font|opentype|truetype|sfnt|ms-fontobject/i.test(mime)) {
    wrap.append(fontPreview(buf, mime), h("details", { class: "section" },
      h("summary", null, "Raw bytes"),
      note(`Showing the first 4 kB of ${fmtBytes(size)} as hex.`),
      h("pre", { class: "code" }, hexDump(buf, 4096))));
    return wrap;
  }

  const svg = mime === "image/svg+xml" || (!mime.startsWith("image/") && looksLikeSvg(buf, url));
  if (mime.startsWith("image/") || svg) {
    wrap.append(imagePreview(buf, svg ? "image/svg+xml" : mime));
    if (!svg) return wrap;
  }

  if (!isTextMime(mime) && !looksTextual(buf)) {
    wrap.append(
      note(`Binary data${mime ? ` (${mime})` : ""}, ${fmtBytes(size)}. Showing the first 4 kB as hex.`),
      h("pre", { class: "code" }, hexDump(buf, 4096)));
    return wrap;
  }

  const text = decodeText(buf, charset);
  const lang = Syntax.langFor(mime, url, text);
  const tree = lang === "json" && text.length <= TEXT_LIMIT ? JsonTree.render(text) : null;
  const preview = lang === "html" ? htmlPreview(text, url, ctx) : null;
  if (tree) tree.el.addEventListener("contextmenu", (ev) => jsonMenu(ev, tree));

  const pre = h("pre", { class: "code" });
  const limitNote = note(`Showing the first ${TEXT_LIMIT.toLocaleString()} characters.`);
  const plainNote = note("Syntax highlighting is off for bodies this large.");
  const treeBtns = tree && h("span", { class: "tree-btns" },
    h("button", { class: "text-btn", onclick: () => tree.expandAll() }, "Expand all"),
    h("button", { class: "text-btn", onclick: () => tree.collapseAll() }, "Collapse all"));
  let highlighted = false;
  const show = () => {
    const usePreview = preview && state.htmlPreview;
    if (preview) preview.hidden = !usePreview;
    const useTree = tree && !state.rawJson;
    if (tree) { tree.el.hidden = !useTree; treeBtns.hidden = !useTree; }
    pre.hidden = useTree || usePreview;
    if (useTree || usePreview) { limitNote.hidden = plainNote.hidden = true; return; }
    const shown = text.length > TEXT_LIMIT ? text.slice(0, TEXT_LIMIT) : text;
    if (!highlighted) { pre.replaceChildren(Syntax.highlight(shown, lang)); highlighted = true; }
    limitNote.hidden = text.length <= TEXT_LIMIT;
    plainNote.hidden = lang === "text" || shown.length <= Syntax.MAX_CHARS;
  };
  show();

  const actions = h("div", { class: "actions" },
    h("button", { class: "text-btn", onclick: (e) => copyText(text, e.currentTarget) }, "Copy"),
    treeBtns,
    tree
      ? h("label", { class: "check" },
          h("input", { type: "checkbox", checked: state.rawJson, onchange: (e) => { state.rawJson = e.target.checked; show(); } }),
          "Raw")
      : null,
    preview
      ? h("label", { class: "check", title: "Show the page rendered, with scripts turned off" },
          h("input", { type: "checkbox", checked: state.htmlPreview, onchange: (e) => { state.htmlPreview = e.target.checked; show(); } }),
          "Preview")
      : null,
    h("span", { class: "note" }, `${Syntax.label(lang)} · ${fmtBytes(size)}`));

  wrap.append(actions, limitNote, plainNote, ...(tree ? [tree.el] : []), ...(preview ? [preview] : []), pre);
  return wrap;
}

// Right-click in a JSON tree: copy the key, the value or section, the object
// it sits in, or its path.
function jsonMenu(ev, tree) {
  const e = tree.entryAt(ev.target);
  if (!e) return;
  ev.preventDefault();
  const what = e.kind === "value" ? "Value" : e.kind === "object" ? "Object" : "Array";
  openMenu(ev.clientX, ev.clientY, [
    e.index != null
      ? { label: `Copy Index (${e.index})`, run: () => copy(String(e.index), "Index copied") }
      : { label: "Copy Key", disabled: e.key == null, run: () => copy(e.key, "Key copied") },
    { label: `Copy ${what}`, run: () => copy(e.value(), `${what} copied`) },
    { label: e.parentKind === "array" ? "Copy Parent Array" : "Copy Parent Object", disabled: !e.parent, run: () => copy(e.parent(), `Parent ${e.parentKind || "object"} copied`) },
    "-",
    { label: "Copy Path (JavaScript)", disabled: !e.path, run: () => copy(e.path, "Path copied") },
    { label: "Copy Path (Python)", disabled: !e.pythonPath, run: () => copy(e.pythonPath, "Path copied") },
  ], ev.target);
}

/* Timings tab */
function renderTimings(d) {
  const t = d.times;
  const end = d.end ?? Date.now();
  const total = Math.max(1, end - t.start);
  const firstByte = t.responseStarted ?? t.headersReceived;

  const phases = [
    ["Blocked / queued", "blocked", t.start, t.sendHeaders],
    ["Waiting for response", "waiting", t.sendHeaders ?? t.start, firstByte],
    ["Receiving", "receiving", firstByte, d.end ?? (d.state === "pending" ? end : null)],
  ].filter(([, , a, b]) => a != null && b != null && b >= a);

  const grid = h("div", { class: "timings" });
  for (const [label, cls, a, b] of phases) {
    const seg = h("div", { class: "seg " + cls });
    seg.style.left = ((a - t.start) / total) * 100 + "%";
    seg.style.width = ((b - a) / total) * 100 + "%";
    grid.append(h("div", { class: "label" }, label), h("div", { class: "track" }, seg), h("div", { class: "ms" }, fmtMs(b - a)));
  }
  grid.append(
    h("div", { class: "label total" }, "Total"),
    h("div"),
    h("div", { class: "ms total" }, d.end ? fmtMs(d.end - t.start) : "Pending…"));

  return [
    phases.length ? grid : note("No timing data yet."),
    kvTable([
      ["Started", fmtClock(t.start)],
      t.sendHeaders && ["Request sent", fmtClock(t.sendHeaders)],
      t.headersReceived && ["Headers received", fmtClock(t.headersReceived)],
      t.responseStarted && ["First byte", fmtClock(t.responseStarted)],
      d.end && ["Finished", fmtClock(d.end)],
    ].filter(Boolean)),
    note(`${BROWSER}'s extension API doesn't expose DNS, connect or TLS timings, so they're included in “Waiting for response”.`),
  ];
}

/* Messages tab (WebSocket frames). The view is kept per request and only new
 * frames are fetched and appended, so busy sockets stay cheap to watch. */
let wsView = null;

function base64ToBuffer(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes.buffer;
}

function wsPreview(m) {
  if (m.data == null) return h("span", { class: "muted" }, m.op === 2 ? "Binary frame (not captured)" : "Not captured");
  if (m.op === 2) return h("span", { class: "muted" }, `Binary frame, ${fmtBytes(m.size)}`);
  return m.data.length > 400 ? m.data.slice(0, 400) + "…" : m.data;
}

function bufferToBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const SEND_DISABLED = "The connection is closed, or it wasn't opened by a page the monitor can reach.";

async function sendWsMessage(v, op, data) {
  const res = await browser.runtime.sendMessage({ cmd: "wsSend", id: v.id, op, data });
  if (res && res.ok) toast("Message sent");
  else toast(`Couldn't send: ${(res && res.error) || "unknown error"}`);
  return !!(res && res.ok);
}

function resendWsMessage(v, m) {
  if (!m || m.data == null) return;
  sendWsMessage(v, m.op, m.data);
}

function createComposer(v) {
  const format = h("select", { class: "ws-dir", title: "How the message is written below" },
    h("option", { value: "text" }, "Text"), h("option", { value: "hex" }, "Binary (hex)"), h("option", { value: "base64" }, "Binary (base64)"));
  const input = h("textarea", { class: "ws-input", rows: "6", spellcheck: "false", placeholder: "Message to send. Ctrl+Enter sends." });
  const sendBtn = h("button", { class: "text-btn primary" }, "Send");
  const el = h("div", { class: "ws-composer", hidden: true },
    h("div", { class: "actions" }, h("strong", null, "Send a message"), h("span", { class: "spacer" }), format),
    input,
    h("div", { class: "rs-buttons" },
      h("button", { class: "text-btn", onclick: () => { el.hidden = true; } }, "Close"),
      sendBtn));

  const parse = () => {
    const text = input.value;
    if (format.value === "text") return { op: 1, data: text };
    if (format.value === "hex") {
      const hex = text.replace(/0x|[\s,:]/gi, "");
      if (hex.length % 2 || /[^0-9a-f]/i.test(hex)) throw new Error("Hex should be pairs of 0-9 / a-f, like 0a 1b ff");
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
      return { op: 2, data: bufferToBase64(bytes) };
    }
    const b64 = text.replace(/\s/g, "");
    try { atob(b64); } catch { throw new Error("That isn't valid base64"); }
    return { op: 2, data: b64 };
  };
  const send = async () => {
    let msg;
    try { msg = parse(); } catch (err) { toast(err.message); return; }
    await sendWsMessage(v, msg.op, msg.data);
  };
  sendBtn.addEventListener("click", send);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); send(); }
  });

  return {
    el,
    sendBtn,
    open(m) {
      if (m && m.data != null) {
        if (m.op === 2) {
          format.value = "hex";
          input.value = [...new Uint8Array(base64ToBuffer(m.data))].map((b) => b.toString(16).padStart(2, "0")).join(" ");
        } else {
          format.value = "text";
          input.value = m.data;
        }
      }
      el.hidden = false;
      el.scrollIntoView({ block: "nearest" });
      input.focus();
    },
  };
}

function createWsView(id) {
  const v = { id, next: 0, msgs: [], selected: null, scroll: 0, stick: true, fetching: false, again: false, canSend: false };
  const filterInput = h("input", { type: "search", class: "ws-filter", placeholder: "Filter messages", spellcheck: "false", title: "Text or /regex/" });
  const dirSelect = h("select", { class: "ws-dir" },
    h("option", { value: "all" }, "All"), h("option", { value: "send" }, "Sent"), h("option", { value: "recv" }, "Received"));
  v.status = h("div", { class: "ws-status" });
  v.count = h("span", { class: "note" });
  v.tbody = h("tbody");
  v.list = h("div", { class: "ws-list" }, h("table", { class: "ws-table" }, v.tbody));
  v.detail = h("div", { class: "ws-detail" }, note("Select a message to see its full content."));
  v.composer = createComposer(v);
  v.newBtn = h("button", { class: "text-btn", onclick: () => v.composer.open(null) }, "New message");
  v.el = h("div", { class: "ws-view" },
    v.status,
    h("div", { class: "actions" }, filterInput, dirSelect, v.count, h("span", { class: "spacer" }), v.newBtn),
    v.list,
    v.composer.el,
    v.detail);

  v.list.addEventListener("scroll", () => {
    v.scroll = v.list.scrollTop;
    v.stick = v.list.scrollTop + v.list.clientHeight >= v.list.scrollHeight - 4;
  });

  const matcher = () => {
    const q = filterInput.value.trim();
    const dir = dirSelect.value;
    let re = null;
    const m = /^\/(.+)\/([a-z]*)$/.exec(q);
    if (m) { try { re = new RegExp(m[1], m[2]); } catch { /* treat as text */ } }
    const lower = q.toLowerCase();
    return (msg) => (dir === "all" || msg.dir === dir) &&
      (!q || (msg.data != null && msg.op === 1 && (re ? re.test(msg.data) : msg.data.toLowerCase().includes(lower))));
  };
  v.match = matcher();
  const refilter = () => {
    v.match = matcher();
    for (const tr of v.tbody.children) tr.hidden = !v.match(v.msgs[Number(tr.dataset.i)]);
    updateCount(v);
  };
  filterInput.addEventListener("input", refilter);
  dirSelect.addEventListener("change", refilter);

  v.tbody.addEventListener("click", (ev) => {
    const tr = ev.target.closest("tr");
    if (!tr) return;
    for (const r of v.tbody.querySelectorAll("tr.selected")) r.classList.remove("selected");
    tr.classList.add("selected");
    v.selected = Number(tr.dataset.i);
    showWsMessage(v, v.msgs[v.selected]);
  });

  v.tbody.addEventListener("contextmenu", (ev) => {
    const tr = ev.target.closest("tr");
    if (!tr) return;
    ev.preventDefault();
    ev.stopPropagation();
    tr.click();
    const m = v.msgs[Number(tr.dataset.i)];
    const has = m.data != null;
    openMenu(ev.clientX, ev.clientY, [
      { label: m.op === 2 ? "Copy Message (base64)" : "Copy Message", disabled: !has, run: () => copy(m.data, "Message copied") },
      "-",
      { label: "Resend", disabled: !has || !v.canSend, run: () => resendWsMessage(v, m) },
      { label: "Edit and Resend…", disabled: !has || !v.canSend, run: () => v.composer.open(m) },
    ], ev.target);
  });
  return v;
}

function updateSendState(v) {
  v.newBtn.disabled = !v.canSend;
  v.newBtn.title = v.canSend ? "Send a new message on this connection" : SEND_DISABLED;
  v.composer.sendBtn.disabled = !v.canSend;
  v.composer.sendBtn.title = v.canSend ? "" : SEND_DISABLED;
}

function updateCount(v) {
  const shown = [...v.tbody.children].filter((tr) => !tr.hidden).length;
  v.count.textContent = shown === v.msgs.length ? `${v.msgs.length} messages` : `${shown} of ${v.msgs.length} messages`;
}

function showWsMessage(v, m) {
  if (!m) { v.detail.replaceChildren(note("Select a message to see its full content.")); return; }
  const head = note(`${m.resent ? "Sent from the monitor" : m.dir === "send" ? "Sent" : "Received"} at ${fmtClock(m.t)} · ${m.op === 2 ? "binary" : "text"} · ${fmtBytes(m.size)} · Right-click the message to resend it`);
  if (m.data == null) {
    v.detail.replaceChildren(head, note("The content wasn't captured because “Capture bodies” was off."));
    return;
  }
  const buf = m.op === 2 ? base64ToBuffer(m.data) : new TextEncoder().encode(m.data).buffer;
  const parts = [head];
  if (m.truncated) parts.push(note(`Only the first part of this message was captured.`));
  parts.push(bodyView(buf, m.op === 2 ? "application/octet-stream" : "text/plain", "utf-8", ""));
  v.detail.replaceChildren(...parts);
}

function wsStatusText(ws) {
  if (!ws) return "No frames recorded for this connection. It may have been opened before the extension loaded, or from a worker.";
  const parts = [];
  if (ws.closed) {
    parts.push(`Closed${ws.closed.code ? ` with code ${ws.closed.code}` : ""}${ws.closed.reason ? ` (${ws.closed.reason})` : ""}${ws.closed.wasClean ? "" : ", not cleanly"}`);
  } else if (ws.open) parts.push("Connected");
  else parts.push(ws.error ? "Failed to connect" : "Connecting…");
  if (ws.protocol) parts.push(`protocol ${ws.protocol}`);
  if (ws.extensions) parts.push(ws.extensions);
  parts.push(`${ws.sent} sent, ${ws.received} received`);
  if (ws.dropped) parts.push(`oldest ${ws.dropped} dropped to save memory`);
  return parts.join(" · ");
}

async function fetchWsMessages(v) {
  if (v.fetching) { v.again = true; return; }
  v.fetching = true;
  try {
    do {
      v.again = false;
      const res = await browser.runtime.sendMessage({ cmd: "getWsMessages", id: v.id, from: v.next });
      if (!res || wsView !== v) return;
      const frag = document.createDocumentFragment();
      for (const m of res.messages) {
        const i = v.msgs.length;
        v.msgs.push(m);
        const tr = h("tr", { class: m.dir === "send" ? "ws-send" : "ws-recv", "data-i": i },
          h("td", { class: "ws-arrow", title: m.dir === "send" ? "Sent" : "Received" }, m.dir === "send" ? "↑" : "↓"),
          h("td", { class: "ws-data" }, m.resent ? h("span", { class: "ws-tag", title: "Sent from the monitor" }, "resent") : null, wsPreview(m)),
          h("td", { class: "ws-size" }, fmtBytes(m.size)),
          h("td", { class: "ws-time" }, fmtClock(m.t)));
        tr.hidden = !v.match(m);
        frag.append(tr);
      }
      v.next = res.base + res.messages.length;
      v.tbody.append(frag);
      updateCount(v);
      if (v.stick) v.list.scrollTop = v.list.scrollHeight;
    } while (v.again);
  } finally {
    v.fetching = false;
  }
}

function renderMessages(d) {
  if (!wsView || wsView.id !== d.id) wsView = createWsView(d.id);
  const v = wsView;
  v.status.textContent = wsStatusText(d.ws);
  v.canSend = !!(d.ws && d.ws.canSend);
  updateSendState(v);
  // Re-attaching the view resets its scroll position; put it back once it's in the page.
  requestAnimationFrame(() => {
    if (v.stick) v.list.scrollTop = v.list.scrollHeight;
    else v.list.scrollTop = v.scroll;
  });
  if (d.ws) fetchWsMessages(v);
  return v.el;
}

/* Security tab */
function renderSecurity(d) {
  const scheme = (safeUrl(d.url) || {}).protocol;
  if (scheme !== "https:" && scheme !== "wss:") {
    return note(scheme === "http:" || scheme === "ws:"
      ? "This request wasn't encrypted, so there's no TLS connection to show."
      : "This request didn't go over the network, so there's no connection to show.");
  }
  const s = d.security;
  if (!s) {
    return note(d.state === "pending"
      ? "Not received yet."
      : d.fromCache ? `This response came from the cache, so ${BROWSER} didn't report connection details.`
        : IS_CHROME && !state.captureBodies ? "In Chrome, TLS details come from its debugger, which the monitor uses only while “Capture bodies” is on."
        : `${BROWSER} didn't report security details for this request.`);
  }
  if (s.error) return note(`${BROWSER} couldn't read the security details: ${s.error}`, "warn");

  const yn = (v) => (v == null ? null : v ? "Yes" : "No");
  const rows = (pairs) => pairs.filter(([, v]) => v != null && v !== "" && !(Array.isArray(v) && !v.length));
  const STATES = { secure: "Secure", weak: "Weak", broken: "Broken", insecure: "Insecure" };

  const out = [];
  if (s.errorMessage) out.push(note(s.errorMessage, "warn"));
  out.push(section("Connection", null, kvTable(rows([
    ["State", STATES[s.state] || s.state],
    ["Protocol", s.protocolVersion],
    ["Cipher suite", mono(s.cipherSuite)],
    ["Key exchange group", s.keaGroupName],
    ["Signature scheme", s.signatureSchemeName],
    ["Key length", s.secretKeyLength ? `${s.secretKeyLength} bits` : null],
    ["HTTP version", d.httpVersion],
    ["Remote address", mono(d.ip)],
    ["Encrypted Client Hello", yn(s.usedEch)],
    ["Encrypted DNS", yn(s.usedPrivateDns)],
    ["OCSP stapling", yn(s.usedOcsp)],
    ["Delegated credentials", yn(s.usedDelegatedCredentials)],
    ["Certificate Transparency", s.certificateTransparencyStatus ? s.certificateTransparencyStatus.replace(/_/g, " ") : null],
    ["HSTS", yn(s.hsts)],
    ["Extended Validation", yn(s.isExtendedValidation)],
    ["Weaknesses", s.weaknessReasons && s.weaknessReasons.join(", ")],
    ["Error category", s.overridableErrorCategory],
  ]))));

  const certs = s.certificates || [];
  certs.forEach((c, i) => {
    const v = c.validity || {};
    const fp = c.fingerprint || {};
    const title = i === 0 ? "Server certificate" : i === certs.length - 1 && c.isBuiltInRoot ? "Root certificate" : "Intermediate certificate";
    out.push(section(title, null, kvTable(rows([
      ["Subject", mono(c.subject)],
      ["Issuer", mono(c.issuer)],
      ["Valid from", v.start ? new Date(v.start).toLocaleString() : null],
      ["Valid until", v.end ? new Date(v.end).toLocaleString() : null],
      ["Serial number", mono(c.serialNumber)],
      ["SHA-256 fingerprint", mono(fp.sha256)],
      ["SHA-1 fingerprint", mono(fp.sha1)],
      ["Public key SHA-256", mono(c.subjectPublicKeyInfoDigest && c.subjectPublicKeyInfoDigest.sha256)],
      ["Alternative names", mono(c.sanList && c.sanList.join(", "))],
      ["Built-in root", c.isBuiltInRoot ? "Yes" : null],
    ]))));
  });

  out.push(note(`${BROWSER} doesn't give extensions the raw TLS handshake, so JA3/JA4 fingerprints can't be shown here.`));
  return out;
}

/* ---------------------------------------------------------------------------
 * Init
 * ------------------------------------------------------------------------- */
refreshTabs();
scheduleRefresh();
