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
};
