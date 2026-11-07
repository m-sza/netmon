// Cookies tab: which response set each cookie.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { BROWSERS, useBrowser } from "../helpers/browser.mjs";

for (const kind of BROWSERS) describe(`cookie origins (${kind})`, () => {
  const t = useBrowser(kind);
  const notes = () => t.ev(() => Object.fromEntries([...document.querySelectorAll("#details-body details.section")].map((sec) => [
    sec.querySelector("summary").firstChild.textContent,
    [...sec.querySelectorAll("table.kv tr")].map((r) => `${r.querySelector("td.k").textContent}: ${r.querySelector(".cookie-origin").textContent}`),
  ])));
  const open = async (suffix) => {
    await t.select(suffix, "cookies");
    await t.waitFor(() => [...document.querySelectorAll(".cookie-origin")].every((n) => n.textContent));
    return notes();
  };
  before(async () => {
    await t.openSite("/cookies/");
    await t.openPanel();
    await t.waitFor(() => [...store.values()].some((s) => s.url.endsWith("/cookies/again")));
  });

  it("says which response set each sent cookie, or that a script did", async () => {
    assert.deepEqual((await open("/cookies/me?n=2"))["Request cookies"].sort(), ["byjs: set by a script", "csid: from POST login", "first: from GET /"]);
    assert.deepEqual((await open("/cookies/again"))["Request cookies"].sort(), ["byjs: set by a script", "csid: from GET refresh", "first: from GET /"]);
  });

  it("says whether a response's cookie is new or replaces one", async () => {
    assert.deepEqual((await open("/cookies/login"))["Response cookies"], ["csid: new"]);
    assert.deepEqual((await open("/cookies/refresh"))["Response cookies"], ["csid: replaces POST login"]);
  });

  it("the link opens the response with its Set-Cookie highlighted", async () => {
    await open("/cookies/again");
    await t.ev(() => [...document.querySelectorAll(".cookie-origin a")].find((a) => a.textContent === "GET refresh").click());
    await t.waitFor(() => current && current.url.endsWith("/cookies/refresh") && hasDetailsCursor());
    assert.match(await t.ev(() => detailsCursor.textContent), /^Set-Cookiecsid=s2/);
  });

  it("raised no errors in the panel", () => assert.deepEqual(t.errors, []));
});
