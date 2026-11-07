import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "../helpers/load.mjs";

const { NM } = load("common.js");
const plain = (x) => JSON.parse(JSON.stringify(x)); // out of the sandbox's realm, for deepEqual

test("searchRegExp finds a value as typed, URL-encoded, JSON- and HTML-escaped", () => {
  const re = NM.searchRegExp('a b/c"x');
  for (const hay of ['a b/c"x', "q=a%20b%2Fc%22x", "q=a+b%2Fc%22x", '{"v":"a b/c\\"x"}', "a b/c&quot;x", 'A B/C"X']) {
    re.lastIndex = 0;
    assert.ok(re.test(hay), hay);
  }
  re.lastIndex = 0;
  assert.ok(!re.test("a-b/c"));
});

test("reformatJson pretty-prints and minifies without touching values", () => {
  const src = '{ "a" : 12345678901234567890, "s":"x, {y}: \\"q\\" ", "e":{}, "l":[ ], "arr":[1,true,null,{"k":[2,3]}]}';
  const pretty = NM.reformatJson(src, true);
  assert.equal(pretty.split("\n")[1], '  "a": 12345678901234567890,');
  assert.match(pretty, /"e": \{\},\n  "l": \[\],/);
  assert.equal(NM.reformatJson(src, false), '{"a":12345678901234567890,"s":"x, {y}: \\"q\\" ","e":{},"l":[],"arr":[1,true,null,{"k":[2,3]}]}');
  assert.deepEqual(JSON.parse(pretty), JSON.parse(src));
});

test("offsetAt and mapOffset find a script position again in its formatted version", () => {
  const orig = 'function a(){return b(1)}\nfetch("/x",{method:"POST"})';
  const formatted = 'function a() {\n  return b(1)\n}\nfetch("/x", {\n  method: "POST"\n})';
  const at = NM.offsetAt(orig, 2, 12); // the { of the options
  assert.equal(orig[at], "{");
  const f = NM.mapOffset(orig, formatted, at);
  assert.equal(formatted.split("\n")[f.line][f.col], "{");
  assert.equal(f.line, 3);
  assert.equal(NM.offsetAt(orig, 9, 1), null);
});

test("graphqlRequest recognises queries, mutations, batches and persisted queries", () => {
  const one = NM.graphqlRequest("https://x/graphql", JSON.stringify({ operationName: "GetUser", query: "query GetUser { me { id } }", variables: { a: 1 } }));
  assert.deepEqual(plain(one.map((o) => [o.type, o.name])), [["query", "GetUser"]]);
  const batch = NM.graphqlRequest("https://x/graphql", JSON.stringify([{ query: "mutation Save { save }" }, { query: "{ me { id } }" }]));
  assert.deepEqual(plain(batch.map((o) => [o.type, o.name])), [["mutation", "Save"], ["query", null]]);
  const persisted = NM.graphqlRequest("https://x/graphql?operationName=Q&variables=%7B%7D&extensions=" + encodeURIComponent('{"persistedQuery":{"sha256Hash":"ab"}}'), "");
  assert.equal(persisted[0].name, "Q");
  assert.equal(persisted[0].persisted, true);
  assert.equal(NM.graphqlRequest("https://x/api", JSON.stringify({ query: 5 })), null);
  assert.equal(NM.graphqlRequest("https://x/api", "not json"), null);
});

test("formatGraphql lays out minified queries", () => {
  const out = NM.formatGraphql('query GetUser($id:ID!,$n:Int=5){user(id:$id){id friends(first:$n,after:"x, y"){...F @include(if:true)}}} fragment F on User{id # c\n}');
  assert.equal(out, [
    "query GetUser($id: ID!, $n: Int = 5) {",
    "  user(id: $id) {",
    "    id",
    '    friends(first: $n, after: "x, y") {',
    "      ...F @include(if: true)",
    "    }",
    "  }",
    "}",
    "fragment F on User {",
    "  id # c",
    "}",
  ].join("\n"));
});

test("siteOf groups hosts the way cookies are shared", () => {
  assert.equal(NM.siteOf("https://api.example.com/x"), "example.com");
  assert.equal(NM.siteOf("https://www.example.co.uk/"), "example.co.uk");
  assert.equal(NM.siteOf("http://127.0.0.1:8080/"), "127.0.0.1");
  assert.equal(NM.siteOf("http://localhost/"), "localhost");
});

test("cookie parsing", () => {
  assert.deepEqual(plain(NM.parseCookieHeader("a=1; b=x=y; c")).map((c) => [c.name, c.value]), [["a", "1"], ["b", "x=y"], ["c", ""]]);
  const set = NM.parseSetCookies(["sid=abc; Path=/; HttpOnly", "x=1"]);
  assert.deepEqual(plain(set.map((c) => [c.name, c.value, c.attrs.length])), [["sid", "abc", 2], ["x", "1", 0]]);
});
