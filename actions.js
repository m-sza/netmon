"use strict";

/* Right-click menu, copy/export formats, Edit and Resend. Loaded after panel.js
 * and uses its helpers (h, note, state, rows, select, ...). */

const send = (msg) => browser.runtime.sendMessage(msg);

/* ---------------------------------------------------------------------------
 * Toast
 * ------------------------------------------------------------------------- */
const toastEl = h("div", { id: "toast", role: "status" });
document.body.append(toastEl);
let toastTimer = null;
function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1500);
}

async function copy(text, done) {
  await navigator.clipboard.writeText(text);
  toast(done || "Copied");
}

/* ---------------------------------------------------------------------------
 * Request formats
 * ------------------------------------------------------------------------- */
const FORBIDDEN_FETCH_HEADERS = /^(host|content-length|connection|keep-alive|cookie|cookie2|referer|origin|accept-encoding|accept-charset|te|trailer|transfer-encoding|upgrade|via|date|expect|dnt|access-control-request-.*|sec-.*|proxy-.*)$/i;

function isMultipart(d) {
  return !!(d.requestBody && d.requestBody.formData) &&
    /multipart\/form-data/i.test(header(d.requestHeaders, "content-type") || "");
}

function formPairs(formData) {
  return Object.entries(formData).flatMap(([k, vs]) => vs.map((v) => [k, v]));
}

function requestBodyText(d) {
  const rb = d.requestBody;
  if (!rb || rb.error) return null;
  if (rb.formData) {
    return formPairs(rb.formData).map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&");
  }
  if (rb.raw && rb.raw.byteLength) {
    const ct = parseContentType(header(d.requestHeaders, "content-type"));
    return decodeText(rb.raw, ct.charset);
  }
  return null;
}

const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

// cmd.exe quoting, same approach as Chromium's "Copy as cURL (cmd)".
function winq(s) {
  return '^"' + String(s)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[^a-zA-Z0-9\s_\-:=+~'/.,?;()*`]/g, "^$&")
    .replace(/%(?=[a-zA-Z0-9_])/g, "%^")
    .replace(/\r?\n/g, "^\n\n") + '^"';
}

function curlCommand(d, windows) {
  const q = windows ? winq : shq;
  const multipart = isMultipart(d);
  const parts = ["curl " + q(d.url)];
  if (d.method !== "GET") parts.push("-X " + q(d.method));
  for (const hd of d.requestHeaders) {
    if (/^(host|content-length)$/i.test(hd.name)) continue;
    if (multipart && /^content-type$/i.test(hd.name)) continue;
    parts.push("-H " + q(`${hd.name}: ${hd.value}`));
  }
  if (multipart) {
    for (const [k, v] of formPairs(d.requestBody.formData)) parts.push("-F " + q(`${k}=${v}`));
  } else {
    const body = requestBodyText(d);
    if (body != null) parts.push("--data-raw " + q(body));
  }
  if (/gzip|deflate|br|zstd/i.test(header(d.requestHeaders, "accept-encoding") || "")) parts.push("--compressed");
  return parts.join(windows ? " ^\n  " : " \\\n  ");
}

function powershellCommand(d) {
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const lines = [`Invoke-WebRequest -UseBasicParsing -Uri ${q(d.url)}`];
  if (d.method !== "GET") lines.push(`-Method ${q(d.method)}`);
  const ua = header(d.requestHeaders, "user-agent");
  if (ua) lines.push(`-UserAgent ${q(ua)}`);
  const hs = d.requestHeaders.filter((x) => !/^(host|content-length|connection|user-agent|content-type)$/i.test(x.name));
  if (hs.length) lines.push("-Headers @{\n" + hs.map((x) => `  ${q(x.name)} = ${q(x.value)}`).join("\n") + "\n}");
  const body = requestBodyText(d);
  if (body != null) {
    const ct = isMultipart(d) ? "application/x-www-form-urlencoded" : header(d.requestHeaders, "content-type");
    if (ct) lines.push(`-ContentType ${q(ct)}`);
    lines.push(`-Body ${q(body)}`);
  }
  return lines.join(" `\n");
}

function fetchCommand(d) {
  const headers = {};
  for (const x of d.requestHeaders) {
    if (FORBIDDEN_FETCH_HEADERS.test(x.name)) continue;
    if (isMultipart(d) && /^content-type$/i.test(x.name)) continue;
    headers[x.name] = x.value;
  }
  const init = { credentials: "include", headers };
  const referrer = header(d.requestHeaders, "referer");
  if (referrer) init.referrer = referrer;
  const body = requestBodyText(d);
  if (body != null) init.body = body;
  init.method = d.method;
  init.mode = "cors";
  return `await fetch(${JSON.stringify(d.url)}, ${JSON.stringify(init, null, 4)});`;
}

/* Python (requests / curl_cffi) */
// JSON string escapes are also valid Python string escapes.
const pyStr = (v) => JSON.stringify(String(v));

function pyValue(v, indent = "") {
  if (v === null) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : `float(${pyStr(v)})`;
  if (typeof v === "string") return pyStr(v);
  const inner = indent + "    ";
  if (Array.isArray(v)) {
    if (!v.length) return "[]";
    return "[\n" + v.map((x) => inner + pyValue(x, inner) + ",\n").join("") + indent + "]";
  }
  const keys = Object.keys(v);
  if (!keys.length) return "{}";
  return "{\n" + keys.map((k) => `${inner}${pyStr(k)}: ${pyValue(v[k], inner)},\n`).join("") + indent + "}";
}

const pyDict = (pairs) => pyValue(Object.fromEntries(pairs));
const pyTuples = (pairs, wrap) => "[\n" + pairs.map(([k, v]) => `    (${pyStr(k)}, ${wrap ? wrap(v) : pyStr(v)}),\n`).join("") + "]";

function pyBytes(buf) {
  let out = "";
  for (const b of new Uint8Array(buf)) {
    out += b >= 0x20 && b < 0x7f && b !== 0x27 && b !== 0x5c ? String.fromCharCode(b) : "\\x" + b.toString(16).padStart(2, "0");
  }
  return "b'" + out + "'";
}

// How requests and curl_cffi encode params= (urllib's urlencode / quote_plus).
const quotePlus = (s) => encodeURIComponent(s)
  .replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
  .replace(/%20/g, "+");

// What impersonate="firefox" sends on its own (curl_cffi 0.16, which maps it to
// firefox147). These are the headers of a top-level page load.
const CFFI_FIREFOX_DEFAULTS = {
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:147.0) Gecko/20100101 Firefox/147.0",
  "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "accept-encoding": "gzip, deflate, br, zstd",
  "upgrade-insecure-requests": "1",
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1",
  "priority": "u=0, i",
  "te": "trailers",
};

// Headers impersonate would send with the same value are commented out. Ones it
// sends differently stay, since dropping them would change the request (an API
// call would turn into a page load, or cookies tied to the User-Agent would stop
// working). curl_cffi also drops its Priority header when the User-Agent is
// overridden, so Priority stays whenever the User-Agent does. Page-load-only
// defaults the captured request didn't have are set to None, which removes them.
const CFFI_NAVIGATION_ONLY = ["Upgrade-Insecure-Requests", "Sec-Fetch-Dest", "Sec-Fetch-Mode", "Sec-Fetch-Site", "Sec-Fetch-User"];

function cffiHeaderLines(hs) {
  const same = (x) => CFFI_FIREFOX_DEFAULTS[x.name.toLowerCase()] === x.value.trim();
  const ua = hs.find((x) => /^user-agent$/i.test(x.name));
  const keepPriority = ua ? !same(ua) : false;
  let commented = 0;
  const body = hs.map((x) => {
    const lower = x.name.toLowerCase();
    let line = `    ${pyStr(x.name)}: ${pyStr(x.value)},`;
    if (same(x) && !(lower === "priority" && keepPriority)) { commented++; return "    # " + line.trimStart(); }
    if (lower === "user-agent") line += "  # impersonate's default is a macOS Firefox 147 one; cookies like cf_clearance are tied to this";
    return line;
  });
  const have = new Set(hs.map((x) => x.name.toLowerCase()));
  const removed = CFFI_NAVIGATION_ONLY.filter((n) => !have.has(n.toLowerCase()));
  if (removed.length) {
    body.push("    # Not in the original request; None stops impersonate from adding its page-load defaults.");
    for (const n of removed) body.push(`    ${pyStr(n)}: None,`);
  }
  return [
    ...(commented ? ['# Commented-out headers are sent by impersonate="firefox" with the same value.'] : []),
    "headers = {", ...body, "}",
  ];
}

function pythonCommand(d, cffi) {
  const lines = [cffi ? "from curl_cffi import requests" : "import requests", ""];
  const args = [pyStr(d.url)];
  const multipart = isMultipart(d);

  // requests sets these itself (and can't decode br/zstd without extras); curl_cffi decodes everything.
  const skip = cffi ? /^(host|content-length|cookie|connection)$/i : /^(host|content-length|cookie|connection|accept-encoding)$/i;
  const hs = d.requestHeaders.filter((x) => !skip.test(x.name) && !(multipart && /^content-type$/i.test(x.name)));
  if (hs.length) {
    lines.push(...(cffi ? cffiHeaderLines(hs) : ["headers = " + pyDict(hs.map((x) => [x.name, x.value]))]), "");
    args.push("headers=headers");
  }

  const cookies = parseCookieHeader(header(d.requestHeaders, "cookie"));
  if (cookies.length) {
    lines.push("cookies = " + pyDict(cookies.map((c) => [c.name, c.value])), "");
    args.push("cookies=cookies");
  }

  const u = safeUrl(d.url);
  const query = u ? u.search.slice(1) : "";
  if (query) {
    const pairs = [...u.searchParams];
    const dup = new Set(pairs.map(([k]) => k)).size !== pairs.length;
    lines.push("params = " + (dup ? pyTuples(pairs) : pyDict(pairs)), "");
    // Re-encoding can differ from the original (e.g. %20 vs +, or a literal comma).
    // Say so, since signed URLs and picky servers care.
    if (pairs.map(([k, v]) => quotePlus(k) + "=" + quotePlus(v)).join("&") !== query) {
      lines.push("# params= re-encodes the query string, so it won't match the original byte for byte. For the exact URL,");
      lines.push(`# drop params=params and use: ${pyStr(d.url)}`, "");
    }
    args[0] = pyStr(d.url.slice(0, d.url.indexOf("?")));
    args.push("params=params");
  }

  const rb = d.requestBody;
  const ct = parseContentType(header(d.requestHeaders, "content-type"));
  if (multipart) {
    lines.push("files = " + pyTuples(formPairs(rb.formData), (v) => `(None, ${pyStr(v)})`), "");
    args.push("files=files");
  } else if (rb && rb.formData) {
    const pairs = formPairs(rb.formData);
    const dup = new Set(pairs.map(([k]) => k)).size !== pairs.length;
    lines.push("data = " + (dup ? pyTuples(pairs) : pyDict(pairs)), "");
    args.push("data=data");
  } else if (rb && rb.raw && rb.raw.byteLength) {
    const textual = isTextMime(ct.mime) || looksTextual(rb.raw);
    const text = textual ? decodeText(rb.raw, ct.charset) : null;
    let json;
    if (text != null && /json/i.test(ct.mime)) { try { json = JSON.parse(text); } catch { /* not JSON */ } }
    if (json !== undefined) {
      lines.push("json_data = " + pyValue(json), "");
      lines.push("# json= re-serializes the body, so spacing may differ from the original. For the exact bytes:");
      lines.push("# data = " + pyStr(text), "");
      args.push("json=json_data");
    } else {
      lines.push("data = " + (text != null ? pyStr(text) : pyBytes(rb.raw)), "");
      args.push("data=data");
    }
  }

  if (cffi) args.push('impersonate="firefox"');
  const m = d.method.toUpperCase();
  const call = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(m)
    ? `requests.${m.toLowerCase()}(`
    : `requests.request(${pyStr(m)}, `;
  lines.push(`response = ${call}${args.join(", ")})`);
  return lines.join("\n");
}

function rawRequestHeaders(d) {
  const u = safeUrl(d.url);
  const first = `${d.method} ${u ? u.pathname + u.search : d.url} ${d.httpVersion || ""}`.trim();
  return [first, ...d.requestHeaders.map((x) => `${x.name}: ${x.value}`)].join("\n");
}

function rawResponseHeaders(d) {
  return [d.statusLine, ...d.responseHeaders.map((x) => `${x.name}: ${x.value}`)].filter(Boolean).join("\n");
}

function responseAsText(d) {
  const ct = parseContentType(header(d.responseHeaders, "content-type"));
  const buf = d.responseBody;
  if (isTextMime(ct.mime) || looksTextual(buf)) return decodeText(buf, ct.charset || d.charset);
  return `data:${ct.mime || "application/octet-stream"};base64,${NM.toBase64(buf)}`;
}

/* ---------------------------------------------------------------------------
 * Files
 * ------------------------------------------------------------------------- */
const EXTENSIONS = {
  "application/json": "json", "text/html": "html", "text/css": "css", "text/javascript": "js",
  "application/javascript": "js", "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif",
  "image/webp": "webp", "image/svg+xml": "svg", "image/avif": "avif", "text/plain": "txt",
  "application/xml": "xml", "text/xml": "xml", "application/pdf": "pdf", "font/woff2": "woff2",
  "font/woff": "woff", "application/wasm": "wasm",
};

function responseFileName(d) {
  const u = safeUrl(d.url);
  let name = "";
  if (u) {
    const last = u.pathname.split("/").pop() || "";
    try { name = decodeURIComponent(last); } catch { name = last; }
  }
  if (!name) name = "response";
  if (!/\.[a-z0-9]{1,5}$/i.test(name)) {
    const ext = EXTENSIONS[effectiveMime(d).mime.toLowerCase()];
    if (ext) name += "." + ext;
  }
  return name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 120);
}

async function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    await browser.downloads.download({ url, filename, saveAs: true });
  } catch (err) {
    if (!/cancel/i.test(String(err && err.message))) throw err;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

function saveResponse(d) {
  const type = header(d.responseHeaders, "content-type") || "application/octet-stream";
  return downloadBlob(new Blob([d.responseBody], { type }), responseFileName(d));
}

async function saveHar(ids) {
  const json = await send({ cmd: "exportHar", ids });
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  await downloadBlob(new Blob([json], { type: "application/json" }), `network-${stamp}.har`);
}

async function copyHar(ids) {
  const json = await send({ cmd: "exportHar", ids });
  await copy(json, ids.length === 1 ? "Request copied as HAR" : `${ids.length} requests copied as HAR`);
}

/* ---------------------------------------------------------------------------
 * Edit and Resend dialog
 * ------------------------------------------------------------------------- */
const rsMethod = h("input", { id: "rs-method", list: "rs-methods", spellcheck: "false", "aria-label": "Method" });
const rsUrl = h("input", { id: "rs-url", spellcheck: "false", "aria-label": "URL" });
const rsHeaders = h("textarea", { id: "rs-headers", rows: "10", spellcheck: "false" });
const rsBody = h("textarea", { id: "rs-body", rows: "7", spellcheck: "false" });
const rsDialog = h("dialog", { id: "resend-dialog" },
  h("h2", null, "Edit and resend"),
  h("div", { class: "rs-line" }, rsMethod, rsUrl),
  h("datalist", { id: "rs-methods" }, ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map((m) => h("option", { value: m }))),
  h("label", { for: "rs-headers" }, "Headers ", h("span", { class: "hint" }, "One per line, as Name: value")),
  rsHeaders,
  h("label", { for: "rs-body" }, "Body"),
  rsBody,
  h("p", { class: "note" }, `${BROWSER} sets headers like Host, Cookie and Content-Length itself, so changes to those are ignored. The new request appears in the list.`),
  h("div", { class: "rs-buttons" },
    h("button", { class: "text-btn", onclick: () => rsDialog.close() }, "Cancel"),
    h("button", { class: "text-btn primary", onclick: () => sendEdited() }, "Send")));
document.body.append(rsDialog);
let rsTabId = -1;

function openResendDialog(d) {
  const multipart = isMultipart(d);
  rsMethod.value = d.method;
  rsUrl.value = d.url;
  rsHeaders.value = d.requestHeaders
    .map((x) => (multipart && /^content-type$/i.test(x.name)
      ? `${x.name}: application/x-www-form-urlencoded`
      : `${x.name}: ${x.value}`))
    .join("\n");
  rsBody.value = requestBodyText(d) ?? "";
  rsTabId = d.tabId;
  rsDialog.showModal();
  rsUrl.focus();
}

async function sendEdited() {
  const method = rsMethod.value.trim().toUpperCase() || "GET";
  const url = rsUrl.value.trim();
  if (!/^https?:$/.test(safeUrl(url)?.protocol || "")) {
    toast("Enter a full http:// or https:// URL");
    rsUrl.focus();
    return;
  }
  const headers = rsHeaders.value.split("\n").map((line) => {
    const i = line.indexOf(":");
    return i > 0 ? { name: line.slice(0, i).trim(), value: line.slice(i + 1).trim() } : null;
  }).filter(Boolean);
  const body = /^(GET|HEAD)$/.test(method) ? null : rsBody.value;
  rsDialog.close();
  await send({ cmd: "resend", request: { method, url, headers, body, tabId: rsTabId } });
  toast("Request sent");
}

/* ---------------------------------------------------------------------------
 * Context menu
 * ------------------------------------------------------------------------- */
const menuEl = h("div", { id: "ctx-menu", role: "menu", tabindex: "-1", hidden: true });
document.body.append(menuEl);

function cleanItems(items) {
  const out = [];
  for (const it of items) {
    if (!it) continue;
    if (it === "-" && (!out.length || out[out.length - 1] === "-")) continue;
    out.push(it);
  }
  while (out[out.length - 1] === "-") out.pop();
  return out;
}

function openMenu(x, y, items) {
  menuEl.replaceChildren();
  for (const it of cleanItems(items)) {
    if (it === "-") { menuEl.append(h("div", { class: "sep", role: "separator" })); continue; }
    const btn = h("button", { class: "item", role: "menuitem", tabindex: "-1", disabled: !!it.disabled }, it.label);
    btn.addEventListener("click", async () => {
      closeMenu();
      try { await it.run(); }
      catch (err) { console.error(err); toast(`“${it.label}” didn't work: ${err.message || err}`); }
    });
    menuEl.append(btn);
  }
  menuEl.hidden = false;
  menuEl.style.left = "0px";
  menuEl.style.top = "0px";
  const r = menuEl.getBoundingClientRect();
  const left = Math.max(2, Math.min(x, window.innerWidth - r.width - 2));
  const top = y + r.height > window.innerHeight - 2 ? Math.max(2, y - r.height) : y;
  menuEl.style.left = left + "px";
  menuEl.style.top = top + "px";
  menuEl.focus();
}

function closeMenu() {
  if (!menuEl.hidden) menuEl.hidden = true;
}

function requestMenuItems(d) {
  const u = safeUrl(d.url);
  const params = u ? [...u.searchParams] : [];
  const bodyText = requestBodyText(d);
  const hasResponse = !!(d.responseBody && d.responseBody.byteLength);
  const isHttp = /^https?:$/.test(u?.protocol || "");
  const blocked = state.blocked.has(d.url);

  return [
    { label: "Copy URL", run: () => copy(d.url, "URL copied") },
    { label: "Copy URL Parameters", disabled: !params.length, run: () => copy(params.map(([k, v]) => `${k}=${v}`).join("\n"), "URL parameters copied") },
    { label: "Copy POST Data", disabled: bodyText == null, run: () => copy(bodyText, "POST data copied") },
    { label: "Copy as cURL", run: () => copy(curlCommand(d, false), "cURL command copied") },
    { label: "Copy as cURL (Windows)", run: () => copy(curlCommand(d, true), "cURL command copied") },
    { label: "Copy as PowerShell", run: () => copy(powershellCommand(d), "PowerShell command copied") },
    { label: "Copy as Fetch", run: () => copy(fetchCommand(d), "fetch() call copied") },
    { label: "Copy as Python (requests)", run: () => copy(pythonCommand(d, false), "Python code copied") },
    { label: "Copy as Python (curl_cffi)", run: () => copy(pythonCommand(d, true), "Python code copied") },
    { label: "Copy Request Headers", disabled: !d.requestHeaders.length, run: () => copy(rawRequestHeaders(d), "Request headers copied") },
    { label: "Copy Response Headers", disabled: !d.responseHeaders.length, run: () => copy(rawResponseHeaders(d), "Response headers copied") },
    { label: "Copy Response", disabled: !hasResponse, run: () => copy(responseAsText(d), "Response copied") },
    { label: "Copy as HAR", run: () => copyHar([d.id]) },
    { label: "Copy All As HAR", run: () => copyHar(visibleIds()) },
    "-",
    { label: "Save Response As…", disabled: !hasResponse, run: () => saveResponse(d) },
    { label: "Save All As HAR", run: () => saveHar(visibleIds()) },
    "-",
    { label: "Resend", disabled: !isHttp, run: async () => { await send({ cmd: "resend", id: d.id }); toast("Request resent"); } },
    { label: "Edit and Resend…", disabled: !isHttp, run: () => openResendDialog(d) },
    blocked
      ? { label: "Unblock URL", run: async () => { await send({ cmd: "unblock", url: d.url }); toast("URL unblocked"); } }
      : { label: "Block URL", disabled: !isHttp, run: async () => { await send({ cmd: "block", url: d.url }); toast("Requests to this URL will be blocked"); } },
    state.blocked.size > (blocked ? 1 : 0)
      ? { label: `Unblock All URLs (${state.blocked.size})`, run: async () => { await send({ cmd: "unblockAll" }); toast("All URLs unblocked"); } }
      : null,
    "-",
    { label: "Open in New Tab", disabled: !isHttp || d.method !== "GET", run: () => browser.tabs.create({ url: d.url }) },
  ];
}

function listMenuItems() {
  const any = visibleIds().length > 0;
  return [
    { label: "Copy All As HAR", disabled: !any, run: () => copyHar(visibleIds()) },
    { label: "Save All As HAR", disabled: !any, run: () => saveHar(visibleIds()) },
    "-",
    state.blocked.size
      ? { label: `Unblock All URLs (${state.blocked.size})`, run: async () => { await send({ cmd: "unblockAll" }); toast("All URLs unblocked"); } }
      : null,
    { label: "Clear", disabled: !store.size, run: () => send({ cmd: "clear" }) },
  ];
}

listPane.addEventListener("contextmenu", async (ev) => {
  ev.preventDefault();
  const x = ev.clientX;
  const y = ev.clientY;
  const tr = ev.target.closest("#rows tr[data-id]");
  if (!tr) { openMenu(x, y, listMenuItems()); return; }
  const id = Number(tr.dataset.id);
  if (state.selectedId !== id) select(id);
  const d = await send({ cmd: "getDetails", id });
  openMenu(x, y, d ? requestMenuItems(d) : listMenuItems());
});

// Menu keyboard handling runs before the panel's own shortcuts.
document.addEventListener("keydown", (ev) => {
  if (menuEl.hidden) return;
  ev.preventDefault();
  ev.stopImmediatePropagation();
  const items = [...menuEl.querySelectorAll("button.item:not(:disabled)")];
  if (!items.length) { closeMenu(); return; }
  const i = items.indexOf(document.activeElement);
  switch (ev.key) {
    case "Escape": closeMenu(); break;
    case "ArrowDown": items[(i + 1) % items.length].focus(); break;
    case "ArrowUp": items[i <= 0 ? items.length - 1 : i - 1].focus(); break;
    case "Home": items[0].focus(); break;
    case "End": items[items.length - 1].focus(); break;
    case "Enter":
    case " ": if (i >= 0) items[i].click(); break;
  }
}, true);

document.addEventListener("mousedown", (ev) => {
  if (!menuEl.hidden && !menuEl.contains(ev.target)) closeMenu();
}, true);
window.addEventListener("blur", closeMenu);
window.addEventListener("resize", closeMenu);
listPane.addEventListener("scroll", closeMenu);
