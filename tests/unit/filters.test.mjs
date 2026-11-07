import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "../helpers/load.mjs";

const { NetFilter } = load("common.js", "filters.js");

// A request summary as the background sends it, with what the filters read.
const req = (o) => ({
  url: "https://api.example.com/v1/users?id=1", method: "GET", status: 200, type: "xmlhttprequest", state: "done",
  size: 2048, transferred: 1024, fromCache: false, ip: "1.2.3.4", httpVersion: "HTTP/2", mimeType: "application/json",
  responseHeaderNames: ["content-type"], setCookies: [], gql: null, ...o,
});
// As the panel's filterHelpers.
const helpers = {
  cause: (s) => s.type, initiator: () => "app.js", mime: (s) => s.mimeType, blocked: (s) => !!s.blocked,
  unicodeUrl: (u) => { try { return decodeURI(u); } catch { return u; } },
};
const matches = (filter, s) => NetFilter.matchAll(NetFilter.parse(filter), s, helpers);

test("plain text matches the URL; - excludes", () => {
  assert.ok(matches("users", req()));
  assert.ok(!matches("orders", req()));
  assert.ok(!matches("-users", req()));
});

test("DevTools flags", () => {
  assert.ok(matches("status-code:200 method:get domain:example.com", req()));
  assert.ok(matches("2", req()), "a bare number is a status code prefix");
  assert.ok(matches("mime-type:json", req()));
  assert.ok(!matches("-mime-type:json", req()));
  assert.ok(matches("larger-than:1k", req()));
  assert.ok(!matches("transferred-larger-than:2k", req()));
  assert.ok(matches("has-response-header:content-type", req()));
  assert.ok(matches("regexp:v\\d/users", req()));
  assert.ok(matches("/V1\\/USERS/", req()), "/regex/ on the URL, case-insensitive");
});

test("is: filters", () => {
  assert.ok(matches("is:error", req({ status: 404 })));
  assert.ok(!matches("is:error", req()));
  assert.ok(matches("is:cached", req({ fromCache: true })));
  assert.ok(matches("is:running", req({ status: null, state: "pending" })));
  assert.ok(matches("is:blocked", req({ blocked: true })));
});

test("GraphQL: operation: and is:graphql", () => {
  const g = req({ gql: [{ type: "query", name: "GetUser" }] });
  const m = req({ gql: [{ type: "mutation", name: "UpdateName" }] });
  assert.ok(matches("is:graphql", g));
  assert.ok(!matches("is:graphql", req()));
  assert.ok(matches("operation:getuser", g));
  assert.ok(matches("operation:update", m), "part of the name");
  assert.ok(matches("operation:mutation", m));
  assert.ok(!matches("operation:mutation", g));
  assert.ok(!matches("operation:x", req()));
});

test("unknown keys are plain text, as in DevTools", () => {
  assert.ok(!matches("foo:bar", req()));
  assert.ok(matches("foo:bar", req({ url: "https://x/foo:bar" })));
});
