"use strict";

/* The Endpoints view (List | Tree | Endpoints): requests grouped by method,
 * host and path pattern (NM.pathPattern: /users/123 -> /users/{id}); GraphQL
 * by operation. Endpoints sit in a tree of folders: the host, then the path
 * (a folder holding just one folder is merged with it: /api/organizations/{uuid}).
 * Folders and endpoints are rows of the request list with negative ids;
 * folders start open, endpoints expand to their requests, which are ordinary rows. Opening an
 * endpoint row shows what its calls have in common instead of the request
 * tabs: path and query parameters, request body fields, the response shape
 * and the headers that change. Uses panel.js's list, details pane and helpers. */

const epByKey = new Map(); // key -> endpoint row (rebuilt with the view; ids stay)
const epRows = new Map(); // negative id -> endpoint row
const epOpen = new Set(); // keys of expanded endpoints
const folderClosed = new Set(); // keys of collapsed folders
let epNextId = -1;
const epIds = new Map(); // key -> id, kept so selection and cursor survive rebuilds

// What groups a request: method, host, path pattern; GraphQL: its operations.
function endpointKey(s) {
  const u = safeUrl(s.url);
  if (!u) return `${s.method} ${s.url}`;
  const ops = s.gql ? " · " + s.gql.map((o) => o.name || `(${o.type})`).join(", ") : "";
  const scheme = /^wss?:$/.test(u.protocol) ? u.protocol.slice(0, -1) + "://" : "";
  return `${s.method} ${scheme}${u.host}${NM.pathPattern(u.pathname)}${ops}`;
}

const epCount = () => [...epRows.values()].filter((e) => !e.folder).length;
const isEndpoint = (id) => id < 0 && epRows.has(id); // an endpoint or a folder
// A row of the list: a request summary, or an endpoint.
const rowOf = (id) => (id < 0 ? epRows.get(id) : store.get(id));

/* The view in Endpoints mode: endpoints in order of their first call (or as
 * sorted), each followed by its calls when expanded. Fills treeInfo so the
 * list draws arrows and guide lines like the tree. */
function flattenEndpoints() {
  epByKey.clear();
  epRows.clear();
  for (const [id, s] of store) {
    if (!matches(s)) continue;
    const key = endpointKey(s);
    let ep = epByKey.get(key);
    if (!ep) {
      let eid = epIds.get(key);
      if (eid == null) { eid = epNextId--; epIds.set(key, eid); }
      const u = safeUrl(s.url);
      ep = {
        id: eid, ep: true, key, method: s.method, url: u ? u.origin + NM.pathPattern(u.pathname) : s.url,
        host: u ? u.host : "", pattern: u ? NM.pathPattern(u.pathname) : s.url, gql: s.gql, type: s.type,
        mimeType: s.mimeType, sniffedMime: s.sniffedMime, calls: [], statuses: new Map(),
        start: s.start, end: 0, transferred: 0, size: 0, sized: 0, time: 0, timed: 0, state: "done", rev: "",
      };
      epByKey.set(key, ep);
      epRows.set(eid, ep);
    }
    ep.calls.push(id);
    const st = s.status ?? (s.state === "pending" ? "pending" : "error");
    ep.statuses.set(st, (ep.statuses.get(st) || 0) + 1);
    if (s.start < ep.start) ep.start = s.start;
    ep.end = Math.max(ep.end, s.end ?? Date.now());
    if (!s.fromCache && s.transferred) ep.transferred += s.transferred;
    if (s.size != null) { ep.size += s.size; ep.sized++; }
    if (s.end) { ep.time += s.end - s.start; ep.timed++; }
    if (s.state === "pending") ep.state = "pending";
    ep.rev += s.rev + ",";
  }
  for (const ep of epRows.values()) {
    // The status shown: the worst one (errors first), others in the tooltip.
    const codes = [...ep.statuses.keys()];
    ep.status = codes.filter((c) => typeof c === "number").sort((a, b) => b - a)[0] ?? null;
    if (codes.includes("error")) ep.state = ep.state === "pending" ? "pending" : "error";
    ep.avgSize = ep.sized ? ep.size / ep.sized : null;
    ep.avgTime = ep.timed ? ep.time / ep.timed : null;
    ep.rev = `${ep.calls.length}:${hashText(ep.rev)}`;
  }
  return flattenFolders([...epRows.values()]);
}

// The id a folder or endpoint keeps across rebuilds.
function rowId(key) {
  let id = epIds.get(key);
  if (id == null) { id = epNextId--; epIds.set(key, id); }
  return id;
}

/* Puts the endpoints in folders (host, then path parts) and returns the rows
 * to show, filling treeInfo (depth, children, ancestors) for the arrows and
 * guide lines. Folders get totals like endpoints. */
function flattenFolders(eps) {
  const newFolder = (key, name, host) => ({ key, name, host, folders: new Map(), eps: [] });
  const hosts = new Map();
  for (const ep of eps) {
    const scheme = /^wss?:/.test(ep.url) ? ep.url.slice(0, ep.url.indexOf(":")) + "://" : "";
    const hostKey = "folder " + scheme + ep.host;
    let node = hosts.get(hostKey) || (hosts.set(hostKey, newFolder(hostKey, scheme + ep.host, ep.host)), hosts.get(hostKey));
    const parts = ep.pattern.split("/").filter(Boolean);
    for (const part of parts.slice(0, -1)) {
      const key = node.key + "/" + part;
      node = node.folders.get(key) || (node.folders.set(key, newFolder(key, "/" + part, ep.host)), node.folders.get(key));
    }
    // The endpoint's own part of the path (a trailing slash kept: /basic/).
    ep.label = parts.length ? "/" + parts[parts.length - 1] + (ep.pattern.endsWith("/") ? "/" : "") : "/";
    node.eps.push(ep);
  }
  // A folder with just one folder in it and no endpoints is shown as one: /api/organizations/{uuid}.
  const compact = (f, isHost) => {
    for (const child of f.folders.values()) compact(child, false);
    if (isHost) return;
    while (f.folders.size === 1 && !f.eps.length) {
      const only = [...f.folders.values()][0];
      f.name += only.name;
      f.key = only.key;
      f.folders = only.folders;
      f.eps = only.eps;
    }
  };
  // Totals of a folder: everything below it.
  const total = (f) => {
    const below = [...f.eps, ...[...f.folders.values()].map(total)];
    const row = {
      id: rowId(f.key), ep: true, folder: true, key: f.key, name: f.name, host: f.host, pattern: f.name, method: "",
      calls: below.flatMap((x) => x.calls), endpoints: below.reduce((n, x) => n + (x.folder ? x.endpoints : 1), 0),
      statuses: new Map(), start: Math.min(...below.map((x) => x.start)), end: Math.max(...below.map((x) => x.end)),
      transferred: below.reduce((n, x) => n + x.transferred, 0), state: below.some((x) => x.state === "pending") ? "pending" : below.some((x) => x.state === "error") ? "error" : "done",
      kids: below, url: "", type: "", mimeType: "",
    };
    for (const x of below) for (const [c, n] of x.statuses) row.statuses.set(c, (row.statuses.get(c) || 0) + n);
    row.status = [...row.statuses.keys()].filter((c) => typeof c === "number").sort((a, b) => b - a)[0] ?? null;
    const sized = below.reduce((n, x) => n + (x.folder ? x.sized : x.sized), 0);
    const timed = below.reduce((n, x) => n + x.timed, 0);
    row.size = below.reduce((n, x) => n + x.size, 0);
    row.sized = sized;
    row.time = below.reduce((n, x) => n + x.time, 0);
    row.timed = timed;
    row.avgSize = sized ? row.size / sized : null;
    row.avgTime = timed ? row.time / timed : null;
    row.rev = `${row.calls.length}:${hashText(below.map((x) => x.rev).join(","))}`;
    epRows.set(row.id, row);
    return row;
  };
  const roots = [...hosts.values()].map((hst) => { compact(hst, true); return total(hst); });

  treeInfo = new Map();
  const out = [];
  const order = (rows) => (state.sortKey ? sortEndpoints(rows) : rows.slice().sort((a, b) => a.start - b.start));
  const emit = (row, depth, anc) => {
    const open = row.folder ? !folderClosed.has(row.key) : epOpen.has(row.key);
    treeInfo.set(row.id, { depth, kids: row.folder ? row.kids.length : row.calls.length, context: false, anc });
    out.push(row.id);
    if (!open) return;
    const kidAnc = [...anc, row.id];
    if (row.folder) for (const kid of order(row.kids)) emit(kid, depth + 1, kidAnc);
    else for (const id of sortIds(row.calls)) { treeInfo.set(id, { depth: depth + 1, kids: 0, context: false, anc: kidAnc }); out.push(id); }
  };
  for (const r of order(roots)) emit(r, 0, []);
  return out;
}

// Column sorting for endpoints: totals and averages.
const EP_SORTERS = {
  status: (e) => e.status ?? -1, method: (e) => e.method, domain: (e) => e.host, file: (e) => e.pattern.toLowerCase(),
  initiator: (e) => e.calls.length, type: (e) => mimeShort(effectiveMime(e).mime), transferred: (e) => e.transferred,
  size: (e) => e.avgSize ?? -1, time: (e) => e.avgTime ?? Number.MAX_SAFE_INTEGER, waterfall: (e) => e.start,
};
function sortEndpoints(eps) {
  const key = EP_SORTERS[state.sortKey];
  const dir = state.sortDir;
  return eps.map((e) => [key(e), e]).sort(([va, a], [vb, b]) => (va < vb ? -dir : va > vb ? dir : a.start - b.start)).map(([, e]) => e);
}

// Folders start open, endpoints closed.
function epCollapsed(id) {
  const row = epRows.get(id);
  return row.folder ? folderClosed.has(row.key) : !epOpen.has(row.key);
}
function toggleEndpoint(id) {
  const row = epRows.get(id);
  const set = row.folder ? folderClosed : epOpen;
  if (set.has(row.key)) set.delete(row.key); else set.add(row.key);
  viewDirty = true;
  scheduleRefresh();
}

// A list row for an endpoint (the cells of fillRow, filled with totals).
function fillEndpointRow(tr, ep) {
  const [cStatus, cMethod, cDomain, cFile, cInit, cType, cTrans, cSize, cTime] = tr.children;
  const counts = [...ep.statuses].sort(([a], [b]) => String(a).localeCompare(String(b)));
  cStatus.textContent = ep.status ?? (ep.state === "pending" ? "" : "—");
  cStatus.className = "c-status " + (ep.state === "error" ? "st-error" : ep.status == null ? "st-pending" : ep.status >= 400 ? "st-bad" : ep.status >= 300 ? "st-redirect" : "st-ok");
  cStatus.title = counts.map(([c, n]) => `${c === "error" ? "failed" : c} ×${n}`).join("\n");
  cMethod.textContent = ep.method;
  cDomain.textContent = ep.host;
  cDomain.title = ep.host;
  cFile.querySelector(".fname").textContent = ep.folder ? ep.name : ep.label || ep.pattern;
  tr.classList.toggle("ep-folder", !!ep.folder);
  const op = cFile.querySelector(".gql-op");
  op.textContent = ep.gql ? (ep.gql.length > 1 ? `${ep.gql.length} operations` : ep.gql[0].name || `(${ep.gql[0].type})`) : "";
  op.className = "gql-op" + (ep.gql && ep.gql.some((o) => o.type === "mutation") ? " mutation" : "");
  cFile.title = ep.folder ? `${ep.name}\n${ep.endpoints} endpoint${ep.endpoints === 1 ? "" : "s"}, ${ep.calls.length} call${ep.calls.length === 1 ? "" : "s"}`
    : `${ep.method} ${ep.url}${op.textContent ? " · " + op.textContent : ""}\n${ep.calls.length} call${ep.calls.length === 1 ? "" : "s"}`;
  const first = store.get(ep.calls[0]);
  const kind = ep.folder ? "folder" : iconKind(first);
  if (cFile.dataset.icon !== kind) {
    cFile.dataset.icon = kind;
    const svg = cFile.querySelector("svg");
    svg.setAttribute("class", "ficon ic-" + kind);
    svg.firstChild.textContent = ICON_TITLES[kind];
    svg.lastChild.setAttribute("href", "#i-" + kind);
  }
  cInit.textContent = ep.folder ? `${ep.endpoints} endpoint${ep.endpoints === 1 ? "" : "s"} · ${ep.calls.length} call${ep.calls.length === 1 ? "" : "s"}` : `${ep.calls.length} call${ep.calls.length === 1 ? "" : "s"}`;
  cInit.title = "";
  cType.textContent = ep.folder ? "" : mimeShort(effectiveMime(first).mime) || causeLabel(first.type);
  cType.title = "";
  cTrans.textContent = ep.transferred ? fmtBytes(ep.transferred) : "";
  cTrans.title = "Transferred, all calls";
  cSize.textContent = ep.avgSize != null ? fmtBytes(ep.avgSize) : "";
  cSize.title = "Size, average per call";
  cTime.textContent = ep.avgTime != null ? fmtMs(ep.avgTime) : "";
  cTime.title = "Time, average per call";
  tr.classList.add("endpoint");
  tr.classList.toggle("row-error", ep.state === "error" || (ep.status ?? 0) >= 400); // some call failed
}

/* Details of a folder: the endpoints in it, each a link that opens it. */
function renderFolder(f) {
  ++epToken;
  detailsPane.classList.add("endpoint-details");
  revokeBlobs();
  const eps = [];
  const walk = (row, path) => { for (const k of row.kids) { if (k.folder) walk(k, path + k.name); else eps.push([path + k.label, k]); } };
  walk(f, "");
  const counts = [...f.statuses].sort(([a], [b]) => String(a).localeCompare(String(b))).map(([c, k]) => `${c === "error" ? "failed" : c} ×${k}`).join(" · ");
  detailsBody.replaceChildren(
    h("div", { class: "ep-title mono" }, f.host === f.name ? f.name : f.host + " " + f.name),
    kvTable([["Endpoints", String(f.endpoints)], ["Calls", String(f.calls.length)], ["Statuses", counts]]),
    section("Endpoints", eps.length, kvTable(eps.map(([path, ep]) => [
      h("a", { href: "#", class: "link mono", onclick: (e) => { e.preventDefault(); revealEndpoint(ep.id); } }, `${ep.method} ${path || "/"}`),
      `${ep.calls.length} call${ep.calls.length === 1 ? "" : "s"}${ep.gql ? " · " + ep.gql.map((o) => o.name || `(${o.type})`).join(", ") : ""}`,
    ]))));
  detailsBody.scrollTop = 0;
}
// Opens an endpoint, opening the folders above it.
function revealEndpoint(id) {
  const node = treeInfo && treeInfo.get(id);
  for (const a of node ? node.anc : []) folderClosed.delete(epRows.get(a).key);
  viewDirty = true;
  select(id);
}

/* Details of an endpoint: what its calls have in common. Most of it comes
 * from the background (it has the bodies); path parameters from the URLs. */
let epToken = 0;
async function renderEndpoint(ep) {
  if (ep.folder) { renderFolder(ep); return; }
  const token = ++epToken;
  detailsPane.classList.add("endpoint-details");
  revokeBlobs();
  detailsBody.replaceChildren(note("Reading the calls…"));
  const calls = ep.calls.map((id) => store.get(id)).filter(Boolean);
  let info;
  try { info = await browser.runtime.sendMessage({ cmd: "endpointInfo", ids: ep.calls }); } catch { info = null; }
  if (token !== epToken || state.selectedId !== ep.id) return;
  const n = calls.length;
  const of = (k) => (k === n ? "every call" : `${k} of ${n} calls`);

  const out = [h("div", { class: "ep-title mono" }, h("span", { class: "ep-method" }, ep.method), " ", ep.host + ep.pattern,
    ep.gql ? h("span", { class: "gql-op" }, " · " + ep.gql.map((o) => o.name || `(${o.type})`).join(", ")) : null)];

  const statuses = [...ep.statuses].sort(([a], [b]) => String(a).localeCompare(String(b))).map(([c, k]) => `${c === "error" ? "failed" : c} ×${k}`).join(" · ");
  const callers = new Map();
  for (const s of calls) {
    if (!s.initiatorLoc) continue;
    const url = parseLoc(s.initiatorLoc)?.url || s.initiatorLoc;
    const f = fileName(url) === "/" ? (safeUrl(url)?.pathname || url) : fileName(url); // a page's inline script: the page's path
    callers.set(f, (callers.get(f) || 0) + 1);
  }
  out.push(kvTable([
    ["Calls", String(n)],
    ["Statuses", statuses],
    ["First", fmtClock(Math.min(...calls.map((s) => s.start)))],
    ["Last", fmtClock(Math.max(...calls.map((s) => s.start)))],
    ep.avgTime != null && ["Average time", fmtMs(ep.avgTime)],
    callers.size && ["Called by", [...callers].map(([f, k]) => `${f}${k > 1 ? ` ×${k}` : ""}`).join(", ")],
  ].filter(Boolean)));

  // Path parameters: the values each placeholder had.
  const segs = ep.pattern.split("/");
  const params = [];
  segs.forEach((seg, i) => {
    if (!/\{\w+\}/.test(seg)) return;
    const values = [];
    for (const s of calls) {
      const v = (safeUrl(s.url)?.pathname.split("/")[i]) ?? "";
      if (!values.includes(v)) values.push(v);
    }
    params.push([`${seg} (part ${i})`, values.slice(0, 8).join(", ") + (values.length > 8 ? ` … (${values.length} different)` : "")]);
  });
  if (params.length) out.push(section("Path parameters", params.length, kvTable(params, "param")));

  if (!info) out.push(note("Couldn't read the calls' details.", "warn"));
  else {
    if (info.query.length) {
      out.push(section("Query parameters", info.query.length, kvTable(info.query.map((q) =>
        [q.name, h("span", null, h("span", { class: "ep-of" }, of(q.calls)), " · e.g. ", mono(q.examples.join(", "))), q.examples.join(", ")]), "param")));
    }
    const fieldRows = (fields, docs) => fields.map((f) => [f.path,
      h("span", null, h("span", { class: "ep-type" }, f.types.join(" | ")), " · ", h("span", { class: "ep-of" + (f.docs < docs ? " optional" : "") }, f.docs < docs ? `in ${f.docs} of ${docs}` : "always"),
        f.example !== undefined ? [" · e.g. ", mono(f.example)] : null),
      f.example ?? ""]);
    if (info.requestFields.length) {
      out.push(section("Request body fields", info.requestFields.length, note(`From ${info.requestDocs} JSON or form bod${info.requestDocs === 1 ? "y" : "ies"}.`), kvTable(fieldRows(info.requestFields, info.requestDocs), "param")));
    }
    if (info.responseFields.length) {
      out.push(section("Response shape", info.responseFields.length, note(`Merged from ${info.responseDocs} JSON response${info.responseDocs === 1 ? "" : "s"}. Fields not in every response are marked.`), kvTable(fieldRows(info.responseFields, info.responseDocs), "param")));
    } else if (!info.requestFields.length && !params.length && !info.query.length) {
      out.push(note("No JSON bodies or parameters to compare in these calls."));
    }
    if (info.headers.length) {
      out.push(section("Request headers that change", info.headers.length, kvTable(info.headers.map((x) =>
        [x.name, h("span", null, h("span", { class: "ep-of" }, `${x.values} different values`), " · e.g. ", mono(x.examples[0])), x.examples.join("\n")]), "header")));
    }
  }
  detailsBody.replaceChildren(...out);
  detailsBody.scrollTop = 0;
}
