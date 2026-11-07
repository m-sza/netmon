// The Endpoints view: grouping, expanding, and an endpoint's details.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { BROWSERS, useBrowser } from "../helpers/browser.mjs";

for (const kind of BROWSERS) describe(`endpoints view (${kind})`, () => {
  const t = useBrowser(kind);
  const rows = () => t.ev(() => { if (viewDirty) rebuildView(); refreshView(); return view.map((id) => {
    const r = rowOf(id);
    return r.ep ? `${r.method} ${r.pattern} [${r.calls.length}]` : `  ${new URL(r.url).pathname}`;
  }); });
  const epRow = (pattern) => t.ev((p) => [...epRows.values()].find((e) => e.pattern === p).id, pattern);
  before(async () => {
    await t.openSite("/ep/");
    await t.openPanel();
    await t.waitFor(() => [...store.values()].filter((s) => s.url.includes("/ep/api/posts")).length === 2);
    await t.ev(() => { ruleAdd.value = "/ep/api/"; compileFilters(); setViewMode("endpoints"); });
  });

  it("groups calls by method and path pattern", async () => {
    assert.deepEqual(await rows(), [
      "GET /ep/api/users/{id} [3]",
      "GET /ep/api/users/{uuid} [1]",
      "GET /ep/api/search [2]",
      "POST /ep/api/posts [2]",
    ]);
  });

  it("→ expands an endpoint to its calls, ← on a call goes back to the endpoint", async () => {
    const id = await epRow("/ep/api/users/{id}");
    await t.ev((i) => { document.activeElement.blur(); moveCursor(i); }, id);
    await t.press("ArrowRight");
    assert.deepEqual((await rows()).slice(0, 4), ["GET /ep/api/users/{id} [3]", "  /ep/api/users/42", "  /ep/api/users/43", "  /ep/api/users/7"]);
    await t.press("ArrowDown");
    await t.press("ArrowLeft");
    assert.equal(await t.ev(() => state.cursorId), id);
    await t.press("ArrowLeft");
    assert.equal((await rows()).length, 4);
  });

  it("an endpoint's details: path and query parameters, response shape", async () => {
    await t.ev((i) => select(i), await epRow("/ep/api/users/{id}"));
    await t.waitFor(() => document.querySelectorAll("#details-body details.section").length >= 3);
    const sections = await t.ev(() => Object.fromEntries([...document.querySelectorAll("#details-body details.section")].map((sec) => [
      sec.querySelector("summary").firstChild.textContent,
      [...sec.querySelectorAll("table.kv tr")].map((r) => `${r.children[0].textContent} = ${r.children[1].textContent}`),
    ])));
    assert.deepEqual(sections["Path parameters"], ["{id} (part 4) = 42, 43, 7"]);
    assert.deepEqual(sections["Query parameters"], ["fields = every call · e.g. name", "lang = every call · e.g. en"]);
    assert.ok(sections["Response shape"].includes("id = number | string · always · e.g. 42"), sections["Response shape"].join("\n"));
    assert.ok(sections["Response shape"].includes("address.city = string · in 2 of 3 · e.g. Delft"));
    assert.ok(sections["Response shape"].includes("admin = boolean · in 1 of 3 · e.g. true"));
    assert.ok(sections["Request headers that change"][0].startsWith("x-request-id = 3 different values"));
    assert.ok(await t.ev(() => detailsPane.classList.contains("endpoint-details")), "the request tabs are hidden");
  });

  it("query parameters that are sometimes missing, and request body fields", async () => {
    await t.ev((i) => select(i), await epRow("/ep/api/search"));
    await t.waitFor(() => [...document.querySelectorAll("#details-body summary")].some((s) => s.textContent.startsWith("Query")));
    assert.ok(await t.ev(() => [...document.querySelectorAll("#details-body table.kv tr")].some((r) => r.textContent.startsWith("sort") && r.textContent.includes("1 of 2 calls"))));
    await t.ev((i) => select(i), await epRow("/ep/api/posts"));
    await t.waitFor(() => [...document.querySelectorAll("#details-body summary")].some((s) => s.textContent.startsWith("Request body fields")));
    const fields = await t.ev(() => [...[...document.querySelectorAll("#details-body details.section")].find((s) => s.querySelector("summary").textContent.startsWith("Request body")).querySelectorAll("table.kv tr")].map((r) => r.children[0].textContent));
    assert.deepEqual(fields.sort(), ["draft", "tags", "tags[]", "title"]);
  });

  it("opening a call shows the normal request tabs again", async () => {
    const call = await t.ev(() => [...store.values()].find((s) => s.url.includes("/ep/api/users/43?")).id);
    await t.ev((i) => select(i), call);
    await t.waitFor((i) => current && current.id === i, call);
    assert.ok(await t.ev(() => !detailsPane.classList.contains("endpoint-details")));
  });

  it("raised no errors in the panel", async () => {
    await t.ev(() => setViewMode("list"));
    assert.deepEqual(t.errors, []);
  });
});
