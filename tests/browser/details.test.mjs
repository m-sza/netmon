// The details pane from the keyboard: tabs, Raw, Pretty/Minified, the row
// highlight and its copy keys, the highlight staying on a row across
// requests, and Find in a body.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { BROWSERS, useBrowser } from "../helpers/browser.mjs";

for (const kind of BROWSERS) describe(`details pane (${kind})`, () => {
  const t = useBrowser(kind);
  const cursorText = () => t.ev(() => (hasDetailsCursor() ? detailsCursor.textContent : null));
  before(async () => {
    await t.openSite("/basic/", { settle: 2500 });
    await t.openPanel();
    await t.select("/basic/api/data?x=1");
    await t.ev(() => document.activeElement.blur());
  });

  it("1–9 go to a details tab; Shift+→ to the next", async () => {
    await t.press("4");
    assert.equal(await t.ev(() => state.detailsTab), "response");
    await t.press("ArrowLeft", ["Shift"]);
    assert.equal(await t.ev(() => state.detailsTab), "request");
    await t.press("4");
  });

  it("R switches the JSON tree and the raw text; M pretty / minified", async () => {
    const view = () => t.ev(() => ({ raw: state.rawBody, tree: !document.querySelector(".jtree").hidden, text: document.querySelector(".body-view pre.code").textContent.slice(0, 12) }));
    assert.deepEqual(await view(), { raw: false, tree: true, text: "" });
    await t.press("r");
    assert.deepEqual(await view(), { raw: true, tree: false, text: '{"ok":true,"' });
    await t.press("m");
    assert.equal((await view()).text, '{\n  "ok": tr');
    await t.press("m");
    await t.press("r");
    assert.equal((await view()).raw, false);
  });

  it("Ctrl+Shift+↓ highlights rows; C, K, P, Shift+P and Ctrl+C copy from them", async () => {
    await t.press("ArrowDown", ["Control", "Shift"]);
    await t.press("ArrowDown", ["Control", "Shift"]);
    assert.equal(await cursorText(), '"ok": true,');
    await t.ev(() => { window.__copied = []; });
    await t.press("c");
    await t.press("k");
    await t.press("p");
    await t.press("P", ["Shift"]);
    await t.press("c", ["Control"]);
    assert.deepEqual(await t.copied(), ["true", "ok", "ok", '["ok"]', '"ok": true']);
  });

  it("Ctrl+Shift+← / → collapse and expand a JSON section", async () => {
    await t.press("ArrowDown", ["Control", "Shift"]); // "items": [
    await t.press("ArrowLeft", ["Control", "Shift"]);
    assert.ok(await t.ev(() => detailsCursor.parentElement.classList.contains("collapsed")));
    await t.press("ArrowRight", ["Control", "Shift"]);
    assert.ok(!(await t.ev(() => detailsCursor.parentElement.classList.contains("collapsed"))));
  });

  it("the highlight stays on the same header when moving to another request", async () => {
    await t.press("1");
    await t.ev(() => [...document.querySelectorAll("table.kv tr")].find((r) => r.textContent.startsWith("Content-Type")).click());
    const top = await t.ev(() => Math.round(detailsCursor.getBoundingClientRect().top));
    await t.select("/basic/new");
    assert.match(await cursorText(), /^Content-Typeapplication\/json/);
    // Same place on screen, unless the pane can't scroll that far (it's at the top).
    const now = await t.ev(() => ({ top: Math.round(detailsCursor.getBoundingClientRect().top), scrolled: detailsBody.scrollTop > 0 }));
    if (now.scrolled) assert.equal(now.top, top);
    else assert.ok(now.top <= top);
    await t.select("/basic/old");
    assert.equal(await cursorText(), null, "no Content-Type on the redirect");
    await t.select("/basic/api/xhr");
    assert.match(await cursorText(), /^Content-Typetext\/plain/);
    await t.press("Escape");
    assert.equal(await cursorText(), null);
  });

  it("F finds in a body, also inside collapsed JSON; N goes to the next match", async () => {
    await t.select("/basic/api/data?x=1", "response");
    await t.ev(() => document.querySelector(".tree-btns button:last-child").click()); // Collapse all
    await t.press("f");
    await t.panel.keyboard.type("delft");
    await t.waitFor(() => document.querySelector(".find-count").textContent === "1 of 1");
    assert.equal(await t.ev(() => [...CSS.highlights.get("nm-find-current")][0].toString()), "Delft");
    await t.ev(() => { const i = document.querySelector(".find-input"); i.value = "a"; i.dispatchEvent(new Event("input")); i.blur(); });
    await t.waitFor(() => /^1 of ([2-9]|\d\d)/.test(document.querySelector(".find-count").textContent)); // the new search's results
    await t.press("n");
    assert.match(await t.ev(() => document.querySelector(".find-count").textContent), /^2 of /);
    await t.press("N", ["Shift"]);
    assert.match(await t.ev(() => document.querySelector(".find-count").textContent), /^1 of /);
  });

  it("Esc drops a highlighted row first, then closes the details", async () => {
    await t.ev(() => { document.activeElement.blur(); setDetailsCursor(detailLines()[1], false); });
    await t.press("Escape");
    assert.ok(await t.ev(() => !hasDetailsCursor() && state.selectedId != null));
    await t.press("Escape");
    assert.equal(await t.ev(() => state.selectedId), null);
  });

  it("raised no errors in the panel", () => assert.deepEqual(t.errors, []));
});
