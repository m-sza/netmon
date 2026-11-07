// Search across requests (Ctrl+F) and tracing where a value came from.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { BROWSERS, useBrowser } from "../helpers/browser.mjs";

for (const kind of BROWSERS) describe(`search and trace (${kind})`, () => {
  const t = useBrowser(kind);
  const rows = () => t.ev(() => { if (viewDirty) rebuildView(); return view.map((id) => new URL(store.get(id).url).pathname + (contextRow(store.get(id)) ? " (context)" : "")); });
  const at = () => t.ev(() => new URL(store.get(state.selectedId).url).pathname);
  before(async () => {
    await t.openSite("/trace/");
    await t.openPanel();
    await t.waitFor(() => [...store.values()].some((s) => s.url.includes("/trace/search")));
  });

  it("Ctrl+F narrows the list to requests containing the text, also URL-encoded", async () => {
    await t.press("f", ["Control"]);
    assert.equal(await t.ev(() => document.activeElement.id), "search-input");
    await t.panel.keyboard.type("hello world/x");
    await t.waitFor(() => search && search.hits && searchCount.textContent === "2 requests");
    assert.deepEqual(await rows(), ["/trace/", "/trace/search"]);
  });

  it("Enter opens a result on the details tab with the match, marked", async () => {
    await t.ev(() => { searchInput.value = "tok_9f8e7d6c"; searchInput.dispatchEvent(new Event("input")); });
    await t.waitFor(() => search && search.text === "tok_9f8e7d6c" && search.hits && search.hits.size === 2);
    await t.ev(() => searchInput.focus());
    await t.press("Enter");
    await t.waitFor(() => current && current.url.endsWith("/trace/login"));
    assert.equal(await t.ev(() => state.detailsTab), "response");
    await t.waitFor(() => document.querySelector(".find-count")?.textContent === "1 of 1");
    await t.press("Enter");
    await t.waitFor(() => current && current.url.endsWith("/trace/me"));
    assert.equal(await t.ev(() => state.detailsTab), "headers");
    assert.ok(await t.ev(() => CSS.highlights.get("nm-search")?.size >= 1));
  });

  it("Esc closes the search from anywhere", async () => {
    await t.ev(() => document.activeElement.blur());
    await t.press("Escape");
    assert.ok(await t.ev(() => searchBar.hidden && !search));
    assert.ok((await rows()).length > 3);
  });

  it("tracing a header value finds the response that handed out its token", async () => {
    await t.select("/trace/me");
    await t.ev(() => [...document.querySelectorAll("table.kv tr")].find((r) => r.textContent.startsWith("Authorization")).click());
    await t.press("t");
    await t.waitFor(() => current && current.url.endsWith("/trace/login") && search && search.hits);
    assert.equal(await t.ev(() => search.text), "tok_9f8e7d6c", "the token part of \"Bearer tok_…\"");
    assert.match(await t.ev(() => searchTracePost.textContent), /part of “Bearer tok_9f8e7d6c”/);
    assert.deepEqual(await rows(), ["/trace/login", "/trace/me (context)"]);
    assert.equal(await t.ev(() => state.rawBody), false, "tracing doesn't switch bodies to Raw");
  });

  it("Esc leaves tracing, back at the request traced from", async () => {
    await t.ev(() => document.activeElement.blur());
    await t.press("Escape");
    assert.ok(await t.ev(() => !search));
    assert.equal(await at(), "/trace/me");
  });

  it("traces into the page's HTML and into Set-Cookie headers", async () => {
    await t.ev(() => traceValue("csrf_77aa55"));
    await t.waitFor(() => search && search.hits && current && !current.url.endsWith("/trace/me"));
    assert.equal(await at(), "/trace/");
    await t.ev(() => closeSearch());
    await t.ev(() => traceValue("sess_123456"));
    await t.waitFor(() => search && search.hits && current && current.url.endsWith("/trace/login"));
    assert.equal(await t.ev(() => state.detailsTab), "headers");
    await t.ev(() => closeSearch());
  });

  it("says so when a value isn't in any earlier response", async () => {
    await t.ev(() => traceValue("nowhere_xyz"));
    await t.waitFor(() => search && search.hits);
    assert.match(await t.ev(() => searchCount.textContent), /^Not in any earlier response/);
    await t.ev(() => closeSearch());
  });

  it("raised no errors in the panel", () => assert.deepEqual(t.errors, []));
});
