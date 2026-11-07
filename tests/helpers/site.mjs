/* The test site: one server (plus a second origin for cross-site frames),
 * with each feature's scenario under its own path. Ports are picked freely.
 *
 *   /basic/      page, script, stylesheet, image, JSON API, XHR, redirect,
 *                404, a cross-site frame, a WebSocket (echo at /sock)
 *   /trace/      a login response hands out a token used by a later request
 *   /stream/     server-sent events, JSON lines, a slow JSON response, EventSource
 *   /gql/        GraphQL: named query, mutation with errors, batch, persisted GET
 *   /cookies/    cookies set by responses and by a script; a minified script
 *                whose calls make requests (for "Started by script")
 *   /code/       minified JavaScript, CSS and HTML
 *   /detect/     a page that checks what it can see of netmon */
import http from "node:http";
import { WebSocketServer } from "ws";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");

const BASIC_APP = `
fetch("/basic/api/data?x=1").then(r => r.json());
const x = new XMLHttpRequest(); x.open("GET", "/basic/api/xhr"); x.send();
fetch("/basic/old").catch(() => {});
const ws = new WebSocket("ws://" + location.host + "/sock");
ws.onopen = () => ws.send(JSON.stringify({ op: "hello" }));`;

const TRACE_PAGE = `<!doctype html><meta name="csrf" content="csrf_77aa55"><script>
(async () => {
  const r = await fetch("/trace/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user: "ada" }) });
  const { session } = await r.json();
  await fetch("/trace/me", { headers: { Authorization: "Bearer " + session.token, "X-CSRF": document.querySelector("meta").content } });
  await fetch("/trace/search?q=" + encodeURIComponent("hello world/x"));
})();</script>`;

const STREAM_PAGE = `<!doctype html><script>
(async () => {
  const r = await fetch("/stream/sse"); const rd = r.body.getReader(); while (!(await rd.read()).done) {}
  await (await fetch("/stream/ndjson")).text();
  await (await fetch("/stream/chunked")).text();
  const es = new EventSource("/stream/es"); let k = 0; es.onmessage = () => { if (++k >= 3) es.close(); };
})();</script>`;

const GQL_PAGE = `<!doctype html><script>
const g = (body) => fetch("/gql/graphql", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
(async () => {
  await g({ operationName: "GetUser", variables: { id: "42", first: 3 }, query: "query GetUser($id:ID!,$first:Int){user(id:$id){id name friends(first:$first){edges{node{...UserBits}}}}} fragment UserBits on User{id avatar(size:64)}" });
  await g({ operationName: "UpdateName", variables: { name: "" }, query: "mutation UpdateName($name: String!) { updateName(name: $name) { id name } }" });
  await g([{ query: "{ me { id } }" }, { operationName: "Feed", query: "query Feed { feed { id } }" }]);
  await fetch("/gql/graphql?operationName=Search&variables=" + encodeURIComponent(JSON.stringify({ q: "hi" })) + "&extensions=" + encodeURIComponent(JSON.stringify({ persistedQuery: { version: 1, sha256Hash: "abcdef0123456789abcdef" } })));
  await fetch("/gql/plain", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: 5 }) });
})();</script>`;

// One line, like a minified bundle: the columns of the fetch calls matter.
const COOKIES_APP = '!function(){var a={x:1};function b(){return a.x+1}document.cookie="byjs=1; path=/cookies/";fetch("/cookies/login",{method:"POST"}).then(function(r){return fetch("/cookies/me?n="+b())}).then(function(){return fetch("/cookies/refresh")}).then(function(){return fetch("/cookies/again")})}();';
const COOKIES_PAGE = '<!doctype html><html><head><script src="/cookies/app.js"></script></head><body><p>hi</p><script>fetch("/cookies/inline-api");</script></body></html>';

const CODE_JS = '!function(){"use strict";var e={a:1,b:[1,2,3]};function t(n){if(n>1){for(var r=0;r<n;r++){console.log(r)}return{x:n,y:"tok_secret"}}else{return null}}/* a comment\n spanning lines */window.app={init:function(){return t(3)},v:`tpl\n${e.a}`}}();';
const CODE_CSS = "body{margin:0;color:red}.a .b{display:flex}@media (max-width:600px){.a{display:none}.c{color:blue}}";
const CODE_HTML = '<!doctype html><html><head><title>T</title><link rel=stylesheet href=/code/s.css><style>p{color:red}</style></head><body><div class="w"><p>Hello <b>there</b></p><ul><li>a</li><li>b</li></ul><script src=/code/b.js></script><script>var z={q:1};</script></div></body></html>';

// Checks a page can make for injected code; results in window.__results.
const DETECT_CHECKS = String.raw`
window.__results = (async () => {
  const R = {};
  const ext = (s) => /(chrome|moz)-extension:|<anonymous code>|page-hook/.test(String(s));
  R.fetchToString = Function.prototype.toString.call(fetch);
  R.wsToString = Function.prototype.toString.call(WebSocket);
  R.sendToString = Function.prototype.toString.call(WebSocket.prototype.send);
  R.setAttrToString = Function.prototype.toString.call(Element.prototype.setAttribute);
  R.srcSetterToString = Function.prototype.toString.call(Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, "src").set);
  R.wsCtorLink = WebSocket.prototype.constructor === WebSocket;
  R.esCtorLink = EventSource.prototype.constructor === EventSource;
  R.wsMarker = WebSocket.__netmon_ws__;
  R.wsOwnKeys = Reflect.ownKeys(WebSocket).map(String).join(",");
  let evs = 0; window.addEventListener("__netmon_ws__", () => evs++, true);
  await fetch("/detect/x").catch(() => {}); R.fixedEventSeen = evs;
  let hello = 0; window.addEventListener("netmon-hook-hello", () => hello++, true);
  window.dispatchEvent(new CustomEvent("netmon-hook-ready")); R.handshakeAnswers = hello;
  let n = 0; const obj = { toString() { n++; return "/detect/x?obj"; } };
  await fetch(obj).catch(() => {}); R.fetchArgToStringCalls = n;
  n = 0; const img = new Image(); img.src = obj; R.imgSrcToStringCalls = n;
  try { XMLHttpRequest.prototype.open.call({}, "GET", "/detect/x"); } catch (e) { R.xhrErrStackHasExt = ext(e.stack); }
  try { Element.prototype.setAttribute.call({}, "a", "b"); } catch (e) { R.setAttrErrStackHasExt = ext(e.stack); }
  try { new WebSocket("not a url"); } catch (e) { R.wsErrStackHasExt = ext(e.stack); }
  if (Error.captureStackTrace) {
    const files = []; Error.prepareStackTrace = (e, cs) => { for (const c of cs) files.push(c.getFileName()); return ""; };
    await fetch("/detect/x?prep").catch(() => {}); new Error().stack; Error.prepareStackTrace = undefined;
    R.prepareStackTraceSawExt = files.some(ext);
  }
  return R;
})();`;

function routes(base2) {
  return async (req, res, body) => {
    const u = new URL(req.url, "http://x");
    const p = u.pathname;
    const send = (type, data, status = 200, extra = {}) => { res.writeHead(status, { "Content-Type": type, ...extra }); res.end(data); };
    const json = (obj, extra) => send("application/json", JSON.stringify(obj), 200, extra);

    // basic
    if (p === "/basic/") return send("text/html; charset=utf-8", `<!doctype html><html><head><link rel="stylesheet" href="/basic/site.css"><script src="/basic/app.js"></script></head><body><h1>Test</h1><div class="bg">bg</div><iframe src="${base2}/frame.html"></iframe><img src="/basic/missing.png"></body></html>`);
    if (p === "/basic/app.js") return send("application/javascript", BASIC_APP);
    if (p === "/basic/site.css") return send("text/css", ".bg { background: url(/basic/bg.png); }");
    if (p === "/basic/bg.png") return send("image/png", PNG);
    if (p === "/basic/api/data") return json({ ok: true, items: [1, 2, 3], user: { id: 42, name: "Ada", tags: ["a", "b"], address: { city: "Delft", zip: "2611" } }, list: [{ a: 1 }, { a: 2 }] }, { "Set-Cookie": "sid=abc; Path=/basic/" });
    if (p === "/basic/api/xhr") return send("text/plain", "xhr body");
    if (p === "/basic/old") { res.writeHead(302, { Location: "/basic/new" }); return res.end(); }
    if (p === "/basic/new") return json({ moved: true });

    // trace
    if (p === "/trace/") return send("text/html", TRACE_PAGE);
    if (p === "/trace/login") return json({ ok: true, session: { token: "tok_9f8e7d6c", ttl: 3600 }, pad: Array.from({ length: 50 }, (_, i) => ({ i })) }, { "Set-Cookie": "tsid=sess_123456; Path=/trace/" });
    if (p === "/trace/me") return json({ name: "Ada" });
    if (p === "/trace/search") return json({ q: u.searchParams.get("q"), results: [] });

    // streams
    if (p === "/stream/") return send("text/html", STREAM_PAGE);
    if (p === "/stream/sse" || p === "/stream/es") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write(": keep-alive\n\n");
      for (let i = 1; i <= 4; i++) {
        await wait(300);
        if (i === 2) res.write(`event: delta\nid: ${i}\ndata: {"text":"hel\ndata: lo","i":${i}}\n\n`);
        else res.write(`${i === 3 ? "event: delta\n" : ""}id: ${i}\ndata: {"i":${i},"text":"part ${i}"}\n\n`);
      }
      return res.end(p === "/stream/sse" ? "data: [DONE]\n\n" : "");
    }
    if (p === "/stream/live") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (let i = 1; i <= 8; i++) { await wait(400); res.write(`data: {"n":${i}}\n\n`); }
      return res.end();
    }
    if (p === "/stream/ndjson") {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      for (let i = 1; i <= 3; i++) { res.write(JSON.stringify({ line: i }) + "\n"); await wait(250); }
      return res.end();
    }
    if (p === "/stream/chunked") {
      res.writeHead(200, { "Content-Type": "application/json" });
      for (const part of ['{"a":', '[1,2,', '3],"b":', '"done"}']) { res.write(part); await wait(450); }
      return res.end();
    }

    // GraphQL
    if (p === "/gql/") return send("text/html", GQL_PAGE);
    if (p === "/gql/graphql" || p === "/gql/plain") {
      if (body.includes("UpdateName")) return json({ data: null, errors: [{ message: "Name can't be empty", path: ["updateName"] }] });
      return json({ data: { ok: true } });
    }

    // cookies and script locations
    if (p === "/cookies/") return send("text/html", COOKIES_PAGE, 200, { "Set-Cookie": "first=f1; Path=/cookies/" });
    if (p === "/cookies/app.js") return send("application/javascript", COOKIES_APP);
    if (p === "/cookies/login") return json({}, { "Set-Cookie": "csid=s1; Path=/cookies/" });
    if (p === "/cookies/refresh") return json({}, { "Set-Cookie": "csid=s2; Path=/cookies/" });
    if (p.startsWith("/cookies/")) return json({});

    // code view
    if (p === "/code/") return send("text/html", CODE_HTML);
    if (p === "/code/b.js") return send("application/javascript", CODE_JS);
    if (p === "/code/s.css") return send("text/css", CODE_CSS);

    // detection
    if (p === "/detect/") return send("text/html", `<!doctype html><script>${DETECT_CHECKS}</script>`);

    if (p === "/blank") return send("text/html", "<!doctype html><title>blank</title>");
    return send("text/plain", "not found", 404);
  };
}

export async function startSite() {
  const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
  // The second origin: a frame with its own script.
  const other = http.createServer((req, res) => {
    if (req.url === "/frame.html") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end('<script src="/frame.js"></script>'); }
    res.writeHead(200, { "Content-Type": "application/javascript" });
    res.end("fetch('/frame-api').catch(()=>{});");
  });
  const port2 = await listen(other);
  const base2 = `http://localhost:${port2}`;
  const handle = routes(base2);
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => { handle(req, res, body).catch(() => { try { res.end(); } catch { /* gone */ } }); });
  });
  new WebSocketServer({ server, path: "/sock" }).on("connection", (s) => s.on("message", (m) => s.send(JSON.stringify({ op: "echo", got: JSON.parse(m) }))));
  const port = await listen(server);
  return {
    base: `http://127.0.0.1:${port}`,
    base2,
    close: () => { server.closeAllConnections?.(); other.closeAllConnections?.(); server.close(); other.close(); },
  };
}
