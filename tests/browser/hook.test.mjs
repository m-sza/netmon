// What a page can see of netmon, with the page hook on and with it turned
// off for the site, and the setting that turns it off.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { BROWSERS, useBrowser, wait } from "../helpers/browser.mjs";

for (const kind of BROWSERS) describe(`page hook (${kind})`, () => {
  const t = useBrowser(kind);
  const checks = async () => {
    const page = await t.openSite("/detect/", { settle: 0 });
    const r = await page.evaluate(() => window.__results);
    await page.close();
    return r;
  };
  before(async () => { await t.openPanel(); });

  it("with the hook on: nothing added, constructors intact, page objects untouched, no extension in stacks", async () => {
    const r = await checks();
    assert.equal(r.wsMarker, undefined);
    assert.equal(r.wsOwnKeys, "length,name,prototype,CONNECTING,OPEN,CLOSING,CLOSED");
    assert.equal(r.wsCtorLink, true);
    assert.equal(r.esCtorLink, true);
    assert.equal(r.fixedEventSeen, 0);
    assert.equal(r.handshakeAnswers, 0, "the handshake's fixed event names aren't answered any more");
    assert.equal(r.fetchArgToStringCalls, 1);
    assert.equal(r.imgSrcToStringCalls, 1);
    assert.equal(r.xhrErrStackHasExt, false);
    assert.equal(r.setAttrErrStackHasExt, false);
    if (kind === "chrome") assert.equal(r.prepareStackTraceSawExt, false);
    assert.equal(r.fetchToString, kind === "chrome" ? "function () { [native code] }" : "function () {\n    [native code]\n}", "the hook is on (wrapped fetch)");
  });

  it("the setting turns it off for a site: the page then sees no difference at all", async () => {
    await t.ev(() => browser.runtime.sendMessage({ cmd: "setSettings", settings: { hookMode: "except", hookSites: ["127.0.0.1"] } }));
    await wait(500);
    const r = await checks();
    assert.match(r.fetchToString, /^function fetch\(\)/);
    assert.match(r.wsToString, /^function WebSocket\(\)/);
    assert.match(r.setAttrToString, /^function setAttribute\(\)/);
    assert.match(r.srcSetterToString, /^function (set )?src\(\)/);
    assert.equal(r.handshakeAnswers, 0);
    const regs = await t.ev(async () => (await browser.scripting.getRegisteredContentScripts()).map((x) => [x.id, x.excludeMatches || []]));
    assert.deepEqual(regs.map((x) => x[1]).flat().sort(), ["*://*.127.0.0.1/*", "*://*.127.0.0.1/*", "*://127.0.0.1/*", "*://127.0.0.1/*"]);
  });

  it("\"only on these sites\" with no sites registers nothing; back to everywhere registers it again", async () => {
    await t.ev(() => browser.runtime.sendMessage({ cmd: "setSettings", settings: { hookMode: "only", hookSites: [] } }));
    await wait(500);
    assert.equal(await t.ev(async () => (await browser.scripting.getRegisteredContentScripts()).length), 0);
    await t.ev(() => browser.runtime.sendMessage({ cmd: "setSettings", settings: { hookMode: "except", hookSites: [] } }));
    await wait(500);
    assert.deepEqual(await t.ev(async () => (await browser.scripting.getRegisteredContentScripts()).map((x) => x.id).sort()), ["netmon-page-hook", "netmon-ws-relay"]);
    assert.doesNotMatch((await checks()).fetchToString, /^function fetch/);
  });

  it("raised no errors in the panel", () => assert.deepEqual(t.errors, []));
});
