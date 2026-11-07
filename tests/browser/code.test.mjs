// The collapsible code view (JS, CSS, HTML) and "Started by script" jumping
// to the call in it.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { BROWSERS, useBrowser } from "../helpers/browser.mjs";

for (const kind of BROWSERS) describe(`code view (${kind})`, () => {
  const t = useBrowser(kind);
  // The lines shown, with a collapsed block's summary dropped.
  const lines = () => t.ev(() => [...document.querySelectorAll(".codetree .jt-line")].filter((l) => l.getClientRects().length)
    .map((l) => [...l.childNodes].filter((n) => !(n.classList && n.classList.contains("jt-summary"))).map((n) => n.textContent).join("")));
  before(async () => {
    await t.openSite("/code/");
    await t.openSite("/cookies/");
    await t.openPanel();
    await t.waitFor(() => [...store.values()].some((s) => s.url.endsWith("/cookies/again")));
  });

  it("formats minified JavaScript into collapsible blocks", async () => {
    await t.select("/code/b.js", "response");
    await t.waitFor(() => document.querySelector(".codetree"));
    const l = await lines();
    assert.equal(l[0], "! function() {");
    assert.ok(l.includes("for (var r = 0; r < n; r++) {"));
    assert.ok(l.includes("} else {"));
    assert.equal(l[l.length - 1], "}();", "the outer block closes last");
    assert.ok(l.includes("/* a comment") && l.some((x) => /^\s*spanning lines \*\/$/.test(x)), "comment lines stay comment text");
    assert.ok(l.includes("${e.a}`"), "template lines keep their text");
  });

  it("collapses blocks from the keyboard and copies a whole block", async () => {
    await t.ev(() => document.activeElement.blur());
    await t.press("ArrowDown", ["Control", "Shift"]);
    await t.press("ArrowDown", ["Control", "Shift"]);
    await t.press("ArrowLeft", ["Control", "Shift"]); // to the outer block
    await t.press("ArrowLeft", ["Control", "Shift"]); // collapse it
    assert.ok(await t.ev(() => detailsCursor.parentElement.classList.contains("collapsed")));
    await t.ev(() => { window.__copied = []; });
    await t.press("c");
    const [block] = await t.copied();
    assert.match(block, /^! function\(\) \{\n {2}"use strict";/);
    await t.press("ArrowRight", ["Control", "Shift"]);
  });

  it("Find works in the code view, R shows the source as sent", async () => {
    await t.press("f");
    await t.panel.keyboard.type("tok_secret");
    await t.waitFor(() => document.querySelector(".find-count").textContent === "1 of 1");
    await t.ev(() => document.activeElement.blur());
    await t.press("r");
    assert.match(await t.ev(() => document.querySelector(".body-view pre.code").textContent), /^!function\(\)\{"use strict"/);
    await t.press("r");
  });

  it("formats CSS", async () => {
    await t.select("/code/s.css", "response");
    await t.waitFor(() => document.querySelector(".codetree"));
    const l = await lines();
    assert.deepEqual(l.slice(0, 4), ["body {", "margin: 0;", "color: red", "}"]);
    assert.ok(l.includes("@media (max-width:600px) {"));
  });

  it("HTML: H switches the page preview and its code", async () => {
    await t.select("/code/", "response");
    assert.equal(await t.ev(() => state.htmlView), "preview");
    await t.press("h");
    await t.waitFor(() => document.querySelector(".codetree"));
    const l = await lines();
    assert.ok(l.includes("<html>") && l.includes("<body>") && l.includes("var z = {"));
    await t.press("h");
    assert.equal(await t.ev(() => state.htmlView), "preview");
  });

  it("\"Started by script\" opens the call that made the request, even in minified code", async () => {
    for (const [req, line] of [["/cookies/me?n=2", 'return fetch("/cookies/me?n=" + b())'], ["/cookies/again", 'return fetch("/cookies/again")'], ["/cookies/inline-api", 'fetch("/cookies/inline-api");']]) {
      await t.select(req);
      await t.ev(() => document.querySelector("table.kv a.link.mono").click());
      await t.waitFor(() => hasDetailsCursor() && CSS.highlights.get("nm-find-current"));
      assert.equal(await t.ev(() => detailsCursor.textContent), line, req);
      assert.equal(await t.ev(() => [...CSS.highlights.get("nm-find-current")][0].toString()), "fetch", req);
    }
  });

  it("raised no errors in the panel", () => assert.deepEqual(t.errors, []));
});
