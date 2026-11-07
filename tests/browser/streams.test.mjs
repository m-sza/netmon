// Streams in the Messages tab: server-sent events (fetch and EventSource),
// JSON lines, a JSON response arriving piece by piece, and live updates.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { BROWSERS, useBrowser, wait } from "../helpers/browser.mjs";

for (const kind of BROWSERS) describe(`streams (${kind})`, () => {
  const t = useBrowser(kind);
  let sitePage;
  const messages = (suffix) => t.ev(async (x) => {
    const s = [...store.values()].find((r) => r.url.endsWith(x));
    const res = await browser.runtime.sendMessage({ cmd: "getWsMessages", id: s.id, from: 0 });
    return res && res.messages.map((m) => (m.event ? `[${m.event}]` : "") + m.data);
  }, suffix);
  before(async () => {
    sitePage = await t.openSite("/stream/", { settle: 4500 });
    await t.openPanel();
    await t.waitFor(() => [...store.values()].some((s) => s.url.endsWith("/stream/es") && s.state !== "pending"));
  });

  it("server-sent events from fetch, with event types and multi-line data", async () => {
    assert.deepEqual(await messages("/stream/sse"), ['{"i":1,"text":"part 1"}', '[delta]{"text":"hel\nlo","i":2}', '[delta]{"i":3,"text":"part 3"}', '{"i":4,"text":"part 4"}', "[DONE]"]);
  });

  it("server-sent events from EventSource", async () => {
    assert.deepEqual((await messages("/stream/es")).slice(0, 3), ['{"i":1,"text":"part 1"}', '[delta]{"text":"hel\nlo","i":2}', '[delta]{"i":3,"text":"part 3"}']);
  });

  it("JSON lines, and a JSON response that arrives piece by piece", async () => {
    assert.deepEqual(await messages("/stream/ndjson"), ['{"line":1}', '{"line":2}', '{"line":3}']);
    assert.deepEqual(await messages("/stream/chunked"), ['{"a":', "[1,2,", '3],"b":', '"done"}']);
  });

  it("streamed responses still have their whole body", async () => {
    const size = await t.ev(async () => {
      const s = [...store.values()].find((r) => r.url.endsWith("/stream/chunked"));
      return (await browser.runtime.sendMessage({ cmd: "getDetails", id: s.id })).responseBody.byteLength;
    });
    assert.equal(size, 24);
  });

  it("the Messages tab shows them, updating while the stream runs", async () => {
    await sitePage.evaluate(() => { fetch("/stream/live").then((r) => r.text()); });
    // It has a Messages tab once it's known to be a stream (first event).
    await t.waitFor(async () => {
      const s = [...store.values()].find((r) => r.url.endsWith("/stream/live"));
      return s && !!(await browser.runtime.sendMessage({ cmd: "getDetails", id: s.id })).stream;
    });
    await t.select("/stream/live", "messages");
    const counts = [];
    for (let i = 0; i < 6; i++) { await wait(500); counts.push(await t.ev(() => document.querySelectorAll(".ws-table tr").length)); }
    assert.ok(counts[0] < counts[counts.length - 1], `rows grew: ${counts}`);
    assert.match(await t.ev(() => document.querySelector(".ws-status").textContent), /^Server-sent events/);
  });

  it("raised no errors in the panel", () => assert.deepEqual(t.errors, []));
});
