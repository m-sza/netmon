import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { BROWSERS, useBrowser, wait } from "../helpers/browser.mjs";

for (const kind of BROWSERS) describe(`GraphQL (${kind})`, () => {
  const t = useBrowser(kind);
  // File column of the shown rows: name, then the operation (* for a mutation).
  const files = () => t.ev(() => { if (viewDirty) rebuildView(); refreshView(); return view.map((id) => {
    const tr = document.querySelector(`#rows tr[data-id="${id}"]`);
    const op = tr && tr.querySelector(".gql-op");
    return tr ? tr.querySelector(".fname").textContent + (op.textContent ? ` [${op.textContent}${op.classList.contains("mutation") ? "*" : ""}]` : "") : "?";
  }); });
  const filter = async (f) => { await t.ev((x) => { ruleAdd.value = x; compileFilters(); }, f); await wait(300); return files(); };
  before(async () => {
    await t.openSite("/gql/");
    await t.openPanel();
    await t.waitFor(() => [...store.values()].some((s) => s.url.endsWith("/gql/plain")));
  });

  it("shows operation names in the list", async () => {
    assert.deepEqual(await filter("is:graphql"), ["graphql [GetUser]", "graphql [UpdateName*]", "graphql [2 operations]", "graphql [Search]"]);
  });

  it("filters by operation name or type", async () => {
    assert.deepEqual(await filter("operation:getuser"), ["graphql [GetUser]"]);
    assert.deepEqual(await filter("operation:mutation"), ["graphql [UpdateName*]"]);
    assert.ok(!(await filter("-is:graphql")).some((f) => f.startsWith("graphql")));
    await filter("");
  });

  it("shows the query formatted and the variables as JSON", async () => {
    await t.select("/gql/graphql", "request"); // the first: GetUser
    await t.waitFor(() => document.querySelector(".codetree"));
    const sections = await t.ev(() => [...document.querySelectorAll("#details-body details.section")].map((d) => d.querySelector("summary").textContent + (d.open ? "" : " (closed)")));
    assert.deepEqual(sections, ["GraphQL query GetUser", "Request payload (closed)"]);
    const first = await t.ev(() => [...document.querySelectorAll(".codetree .jt-line")].slice(0, 2).map((l) => [...l.childNodes].filter((n) => !(n.classList && n.classList.contains("jt-summary"))).map((n) => n.textContent).join("")));
    assert.deepEqual(first, ["query GetUser($id: ID!, $first: Int) {", "user(id: $id) {"]);
    assert.ok(await t.ev(() => !!document.querySelector(".sub-label + .body-view .jtree")), "variables as a JSON tree");
  });

  it("lists GraphQL errors of a 200 response", async () => {
    const id = await t.ev(() => [...store.values()].filter((s) => s.gql)[1].id);
    await t.ev((i) => { state.detailsTab = "response"; select(i); }, id);
    await t.waitFor(() => document.querySelector("#details-body .note.warn"));
    assert.equal(await t.ev(() => document.querySelector("#details-body .note.warn").textContent), "GraphQL error: Name can't be empty");
  });

  it("recognises a persisted query", async () => {
    const id = await t.ev(() => [...store.values()].filter((s) => s.gql)[3].id);
    await t.ev((i) => { state.detailsTab = "request"; select(i); }, id);
    await t.waitFor(() => document.querySelector("#details-body .note"));
    assert.match(await t.ev(() => document.querySelector("#details-body .note").textContent), /^A persisted query: only its hash was sent/);
  });

  it("raised no errors in the panel", () => assert.deepEqual(t.errors, []));
});
