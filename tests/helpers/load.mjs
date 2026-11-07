/* Loads the extension's plain scripts (no modules) into a sandbox, for unit
 * tests: load("common.js", "filters.js") -> { NM, NetFilter, ... }. */
import vm from "node:vm";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function load(...files) {
  const ctx = vm.createContext({ URL, TextDecoder, TextEncoder, console });
  const exportsOf = { "common.js": "NM", "filters.js": "NetFilter" };
  const names = files.map((f) => exportsOf[f]).filter(Boolean);
  vm.runInContext(files.map((f) => readFileSync(path.join(ROOT, f), "utf8")).join("\n;\n") +
    `;\nthis.__out = { ${names.join(", ")} };`, ctx);
  return ctx.__out;
}
