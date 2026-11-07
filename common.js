"use strict";

/* Helpers shared by the background script and the panel. */
const NM = {
  header(headers, name) {
    if (!headers) return null;
    name = name.toLowerCase();
    for (const h of headers) if (h.name.toLowerCase() === name) return h.value ?? "";
    return null;
  },

  headerAll(headers, name) {
    if (!headers) return [];
    name = name.toLowerCase();
    return headers.filter(h => h.name.toLowerCase() === name).map(h => h.value ?? "");
  },

  parseContentType(value) {
    if (!value) return { mime: "", charset: "" };
    const [mime, ...params] = value.split(";");
    let charset = "";
    for (const p of params) {
      const i = p.indexOf("=");
      if (i > 0 && p.slice(0, i).trim().toLowerCase() === "charset") {
        charset = p.slice(i + 1).trim().replace(/^"|"$/g, "");
      }
    }
    return { mime: mime.trim().toLowerCase(), charset };
  },

  isTextMime(mime) {
    return /^text\/|json|javascript|ecmascript|xml|x-www-form-urlencoded|graphql|csv|yaml|svg|manifest/.test(mime || "");
  },

  decodeText(buf, charset) {
    try { return new TextDecoder(charset || "utf-8").decode(buf); }
    catch { return new TextDecoder("utf-8").decode(buf); }
  },

  concat(chunks) {
    let total = 0;
    for (const c of chunks) total += c.byteLength;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) { out.set(new Uint8Array(c), offset); offset += c.byteLength; }
    return out.buffer;
  },

  toBase64(buf) {
    const bytes = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  },

  // A Content-Type that says nothing about the content.
  isGenericMime(mime) {
    return !mime || /^(application\/(octet-stream|unknown|x-binary|binary)|binary\/octet-stream|unknown\/unknown)$/.test(mime);
  },

  // The type a body really is, from its first bytes (like browsers sniff).
  sniffMime(buf) {
    const b = new Uint8Array(buf, 0, Math.min(buf.byteLength, 512));
    const at = (o, ...bytes) => bytes.every((x, i) => b[o + i] === x);
    const ascii = (o, str) => [...str].every((c, i) => b[o + i] === c.charCodeAt(0));
    if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
    if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
    if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
    if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
    if (ascii(4, "ftyp")) {
      const brand = String.fromCharCode(...b.subarray(8, 12));
      if (brand === "avif" || brand === "avis") return "image/avif";
      if (/^(heic|heix|mif1)$/.test(brand)) return "image/heic";
      return "video/mp4";
    }
    if (at(0, 0, 0, 1, 0) && b.length > 4 && b[4] > 0) return "image/x-icon";
    if (at(0, 0, 0, 2, 0) && b.length > 4 && b[4] > 0) return "image/x-icon"; // cursor
    if (ascii(0, "BM") && b.length > 14) return "image/bmp";
    if (ascii(0, "wOF2")) return "font/woff2";
    if (ascii(0, "wOFF")) return "font/woff";
    if (ascii(0, "OTTO")) return "font/otf";
    if (at(0, 0, 1, 0, 0) || ascii(0, "true") || ascii(0, "ttcf")) return "font/ttf";
    if (ascii(0, "%PDF-")) return "application/pdf";
    if (at(0, 0, 0x61, 0x73, 0x6d)) return "application/wasm";
    if (at(0, 0x1f, 0x8b)) return "application/gzip";
    if (ascii(0, "PK") && at(2, 3, 4)) return "application/zip";
    if (ascii(0, "OggS")) return "audio/ogg";
    if (at(0, 0x1a, 0x45, 0xdf, 0xa3)) return "video/webm";
    const head = new TextDecoder().decode(b).replace(/^\uFEFF/, "");
    if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return "image/svg+xml";
    return "";
  },

  // Last resort when there's neither a usable header nor a captured body.
  mimeFromUrl(url) {
    let path = "";
    try { path = new URL(url).pathname.toLowerCase(); } catch { return ""; }
    const ext = (/\.([a-z0-9]+)$/.exec(path) || [])[1];
    return {
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif",
      ico: "image/x-icon", cur: "image/x-icon", bmp: "image/bmp", svg: "image/svg+xml",
      woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
      js: "text/javascript", mjs: "text/javascript", css: "text/css", json: "application/json", map: "application/json",
      html: "text/html", htm: "text/html", xml: "application/xml", txt: "text/plain", pdf: "application/pdf", wasm: "application/wasm",
      mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav",
    }[ext] || "";
  },

  safeUrl(u) {
    try { return new URL(u); } catch { return null; }
  },

  parseCookieHeader(value) {
    if (!value) return [];
    return value.split(/;\s*/).filter(Boolean).map(p => {
      const i = p.indexOf("=");
      return i < 0 ? { name: p.trim(), value: "" } : { name: p.slice(0, i).trim(), value: p.slice(i + 1).trim() };
    });
  },

  // Firefox may join several Set-Cookie headers into one value separated by newlines.
  parseSetCookies(values) {
    const out = [];
    for (const v of values) {
      for (const line of v.split("\n")) {
        if (!line.trim()) continue;
        const parts = line.split(";");
        const first = parts.shift();
        const i = first.indexOf("=");
        const cookie = {
          name: i < 0 ? first.trim() : first.slice(0, i).trim(),
          value: i < 0 ? "" : first.slice(i + 1).trim(),
          attrs: [],
        };
        for (const a of parts) if (a.trim()) cookie.attrs.push(a.trim());
        out.push(cookie);
      }
    }
    return out;
  },

  /* Search pattern for a value as it may appear elsewhere: as typed, URL-
   * encoded (with %20 or +), escaped inside a JSON string, or HTML-escaped.
   * Case-insensitive. Global, so it can also find every match. */
  searchRegExp(text) {
    const html = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    let url = text;
    try { url = encodeURIComponent(text); } catch { /* lone surrogate */ }
    const variants = new Set([text, url, url.replace(/%20/g, "+"), JSON.stringify(text).slice(1, -1), html]);
    const esc = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp([...variants].filter(Boolean).sort((a, b) => b.length - a.length).map(esc).join("|"), "gi");
  },

  /* GraphQL operations in a request, or null: a JSON body (or GET query
   * string) with a "query" string, or a persisted query (only its hash and
   * operation name are sent). Batches are arrays. Each operation:
   * { type: "query" | "mutation" | "subscription", name, query, variables, extensions }. */
  graphqlRequest(url, bodyText) {
    const parse = (t) => { try { return t ? JSON.parse(t) : null; } catch { return null; } };
    let payload = bodyText && /^\s*[[{]/.test(bodyText) ? parse(bodyText) : null;
    if (!payload) {
      const u = NM.safeUrl(url);
      const q = u && u.searchParams;
      if (q && (q.has("query") || (q.has("operationName") && q.has("extensions")))) {
        payload = { query: q.get("query"), operationName: q.get("operationName"), variables: parse(q.get("variables")), extensions: parse(q.get("extensions")) };
      }
    }
    const list = Array.isArray(payload) ? payload : payload ? [payload] : [];
    const ops = [];
    for (const p of list) {
      if (!p || typeof p !== "object") continue;
      const persisted = !!(p.extensions && p.extensions.persistedQuery);
      if (typeof p.query !== "string" && !persisted) continue;
      const query = typeof p.query === "string" ? p.query : "";
      const name = typeof p.operationName === "string" && p.operationName ? p.operationName : null;
      const plain = query.replace(/#[^\n]*/g, "");
      // The operation's type: from its definition (the named one, when there are several).
      const def = name ? new RegExp(`\\b(query|mutation|subscription)\\s+${name}\\b`).exec(plain) : null;
      const first = /^\s*(query|mutation|subscription)\b\s*([_A-Za-z][_0-9A-Za-z]*)?/.exec(plain);
      ops.push({
        type: def ? def[1] : first ? first[1] : "query",
        name: name || (first && first[2]) || null,
        query, variables: p.variables ?? null, extensions: p.extensions ?? null, persisted,
      });
    }
    return ops.length ? ops : null;
  },

  // A GraphQL document laid out one selection per line, indented by nesting.
  // Arguments stay on their line; strings, block strings and comments are kept.
  formatGraphql(q) {
    let out = "", depth = 0, paren = 0, line = "";
    const nl = () => { if (line.trim()) out += "  ".repeat(depth) + line.trim() + "\n"; line = ""; };
    for (let i = 0; i < q.length; i++) {
      const c = q[i];
      if (c === '"') {
        const block = q.startsWith('"""', i);
        let j = i + (block ? 3 : 1);
        if (block) { j = q.indexOf('"""', j); j = j < 0 ? q.length : j + 3; }
        else { while (j < q.length && q[j] !== '"') j += q[j] === "\\" ? 2 : 1; j++; }
        line += q.slice(i, j);
        i = j - 1;
      } else if (c === "#") {
        const j = q.indexOf("\n", i);
        line += q.slice(i, j < 0 ? q.length : j);
        nl();
        i = j < 0 ? q.length : j;
      } else if (paren) {
        if (c === "(") paren++;
        else if (c === ")") paren--;
        if (c === ":" || c === ",") { line = line.trimEnd() + c + " "; while (/[ \t\r\n]/.test(q[i + 1] || "")) i++; }
        else if (c === "=") { line = line.trimEnd() + " = "; while (/[ \t\r\n]/.test(q[i + 1] || "")) i++; }
        else line += /\s/.test(c) ? (line.endsWith(" ") || line.endsWith("(") ? "" : " ") : c;
      } else if (c === "(") { paren = 1; line += c; }
      else if (c === "{") { line = line.trimEnd() + " {"; nl(); depth++; }
      else if (c === "}") { nl(); depth = Math.max(0, depth - 1); line = "}"; nl(); }
      else if (c === "," || c === "\n" || c === "\r") nl();
      else if (/\s/.test(c)) { if (line.trim() && !line.endsWith(" ")) line += " "; }
      else {
        // A new selection starts after a finished one: "a b" on one line is two fields.
        const word = (/^[_A-Za-z][_0-9A-Za-z]*/.exec(q.slice(i, i + 64)) || [""])[0];
        if (/[_A-Za-z.]/.test(c) && word !== "on" && /[_0-9A-Za-z)\]!] $/.test(line) &&
            !/(\b(on|query|mutation|subscription|fragment)|:|=|@\w+|\.\.\.) $/.test(line)) nl();
        line += c;
      }
    }
    nl();
    return out.trimEnd();
  },

  /* Re-lays out valid JSON text: pretty (2-space indent) or minified. Works on
   * the text, not on parsed values, so numbers and string escapes stay exactly
   * as sent (JSON.parse would round big numbers). */
  reformatJson(text, pretty) {
    const out = [];
    let depth = 0;
    const nl = () => "\n" + "  ".repeat(depth);
    const n = text.length;
    for (let i = 0; i < n;) {
      const c = text[i];
      if (c === '"') {
        let j = i + 1;
        while (j < n && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
        out.push(text.slice(i, j + 1));
        i = j + 1;
      } else if (c === " " || c === "\n" || c === "\r" || c === "\t") {
        i++;
      } else if (!pretty || !"{}[],:".includes(c)) {
        let j = i + 1; // a run of other characters (numbers, literals; punctuation when minifying)
        while (j < n && !" \n\r\t\"".includes(text[j]) && (!pretty || !"{}[],:".includes(text[j]))) j++;
        out.push(text.slice(i, j));
        i = j;
      } else if (c === "{" || c === "[") {
        let j = i + 1;
        while (j < n && " \n\r\t".includes(text[j])) j++;
        if (text[j] === (c === "{" ? "}" : "]")) { out.push(c + text[j]); i = j + 1; continue; } // {} and [] stay on one line
        depth++;
        out.push(c + nl());
        i++;
      } else {
        if (c === "}" || c === "]") { depth--; out.push(nl() + c); }
        else out.push(c === "," ? "," + nl() : ": ");
        i++;
      }
    }
    return out.join("");
  },

  // The offset of a 1-based line and column in text, or null past the end.
  offsetAt(text, line, col) {
    let i = 0;
    for (let n = 1; n < line; n++) {
      i = text.indexOf("\n", i);
      if (i < 0) return null;
      i++;
    }
    const end = text.indexOf("\n", i);
    return Math.min(i + Math.max(0, col - 1), end < 0 ? text.length : end);
  },

  // Where offset `at` of the original text is in its formatted version: the
  // formatter only changes whitespace, so the same number of other characters
  // comes before it. Returns a 0-based line and column of the formatted text.
  mapOffset(orig, formatted, at) {
    const isWs = (c) => c === 32 || c === 10 || c === 13 || c === 9;
    let k = 0;
    for (let i = 0; i < at; i++) if (!isWs(orig.charCodeAt(i))) k++;
    let j = 0;
    for (let seen = 0; j < formatted.length; j++) {
      if (isWs(formatted.charCodeAt(j))) continue;
      if (seen === k) break;
      seen++;
    }
    const lineStart = formatted.lastIndexOf("\n", j - 1) + 1;
    let line = 0;
    for (let i = formatted.indexOf("\n"); i >= 0 && i < j; i = formatted.indexOf("\n", i + 1)) line++;
    return { line, col: j - lineStart };
  },

  // The site a URL belongs to, for cookies: its last two host labels (three for
  // hosts like example.co.uk). Close enough to the browser's cookie scoping here.
  siteOf(url) {
    const host = (NM.safeUrl(url) || {}).hostname || "";
    if (/^[\d.]+$|^\[|^localhost$/.test(host)) return host;
    const labels = host.split(".");
    const n = /^(co|com|net|org|gov|ac|edu|ne|or|go)$/.test(labels[labels.length - 2] || "") && labels[labels.length - 1].length === 2 ? 3 : 2;
    return labels.slice(-n).join(".");
  },
};
