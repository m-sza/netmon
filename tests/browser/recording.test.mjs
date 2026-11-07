import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { BROWSERS, useBrowser, wait } from "../helpers/browser.mjs";

for (const kind of BROWSERS) describe(`recording (${kind})`, () => {
  const t = useBrowser(kind);
  before(async () => {
    await t.openSite("/basic/", { settle: 2500 });
    await t.openPanel();
    await t.waitFor(() => [...store.values()].some((s) => s.url.endsWith("/frame-api")));
  });

  it("records the page's requests with status, type and redirects", async () => {
    const rows = await t.ev(() => [...store.values()].map((s) => [new URL(s.url).pathname, s.status, s.type]));
    const byPath = Object.fromEntries(rows.map(([p, st, ty]) => [p, { st, ty }]));
    assert.equal(byPath["/basic/"].st, 200);
    assert.equal(byPath["/basic/"].ty, "main_frame");
    assert.equal(byPath["/basic/app.js"].ty, "script");
    assert.equal(byPath["/basic/site.css"].ty, "stylesheet");
    assert.equal(byPath["/basic/bg.png"].ty, "image");
    assert.equal(byPath["/basic/missing.png"].st, 404);
    assert.equal(byPath["/basic/old"].st, 302);
    assert.equal(byPath["/basic/new"].st, 200);
    assert.ok(byPath["/frame-api"], "the cross-site frame's request");
    const redirect = await t.ev(() => { const n = [...store.values()].find((s) => s.url.endsWith("/basic/new")); return n.redirectedFrom === [...store.values()].find((s) => s.url.endsWith("/basic/old")).id; });
    assert.ok(redirect, "/basic/new is the redirect of /basic/old");
  });

  it("keeps response bodies", async () => {
    const body = await t.ev(async () => {
      const s = [...store.values()].find((x) => x.url.includes("/basic/api/data"));
      const d = await browser.runtime.sendMessage({ cmd: "getDetails", id: s.id });
      return new TextDecoder().decode(d.responseBody);
    });
    assert.equal(JSON.parse(body).user.address.city, "Delft");
  });

  it("knows which script started a request (tree and \"Started by script\")", async () => {
    const r = await t.ev(() => {
      const data = [...store.values()].find((s) => s.url.includes("/basic/api/data"));
      const app = [...store.values()].find((s) => s.url.endsWith("/basic/app.js"));
      return { loc: data.initiatorLoc, parentIsApp: treeParents().get(data.id) === app.id };
    });
    assert.match(r.loc, /\/basic\/app\.js:\d+:\d+$/);
    assert.ok(r.parentIsApp);
  });

  it("records WebSocket frames, and sends from the monitor", async () => {
    const sock = await t.waitFor(() => { const s = [...store.values()].find((x) => x.type === "websocket"); return s && s.wsCount >= 2 && s.id; });
    const sent = await t.ev((id) => browser.runtime.sendMessage({ cmd: "wsSend", id, op: 1, data: '{"op":"from-monitor"}' }), sock);
    assert.equal(sent.ok, true);
    const frames = await t.waitFor(async (id) => {
      const m = (await browser.runtime.sendMessage({ cmd: "getWsMessages", id, from: 0 })).messages;
      return m.length >= 4 && m.map((x) => `${x.dir}:${x.data}`);
    }, sock);
    assert.deepEqual(frames, ['send:{"op":"hello"}', 'recv:{"op":"echo","got":{"op":"hello"}}', 'send:{"op":"from-monitor"}', 'recv:{"op":"echo","got":{"op":"from-monitor"}}']);
  });

  it("gets the page's DOMContentLoaded and Load times", async () => {
    const timings = await t.ev(() => new Promise((res) => {
      const p = browser.runtime.connect({ name: "panel" });
      p.onMessage.addListener((m) => { if (m.type === "snapshot") { p.disconnect(); res(m.timings.map((x) => !!(x.dcl && x.load))); } });
    }));
    assert.ok(timings.includes(true));
  });

  it("filters the list", async () => {
    const shown = async (f) => {
      await t.ev((x) => { ruleAdd.value = x; compileFilters(); }, f);
      await wait(250);
      return t.ev(() => { if (viewDirty) rebuildView(); return view.map((id) => new URL(store.get(id).url).pathname); });
    };
    assert.deepEqual(await shown("status-code:404 -favicon"), ["/basic/missing.png"]);
    assert.deepEqual(await shown("mime-type:css"), ["/basic/site.css"]);
    assert.ok(!(await shown("-domain:127.0.0.1")).some((p) => p.startsWith("/basic/")));
    await shown("");
  });

  it("shows status names with an explanation on hover", async () => {
    await t.select("/basic/old");
    const chip = await t.ev(() => { const c = document.querySelector(".status-chip"); return [c.textContent, c.title]; });
    assert.equal(chip[0], "302 Found");
    assert.match(chip[1], /redirect/i);
  });

  it("raised no errors in the panel", () => assert.deepEqual(t.errors, []));
});
