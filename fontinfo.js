"use strict";

/* Reads a font's names and glyph count from its own tables (TrueType/OpenType,
 * collections and WOFF). WOFF2 compresses its tables with Brotli, which the
 * browser can't decode for us, so for those only the format is known. */
const FontInfo = (() => {
  const tag = (dv, o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));

  function format(buf) {
    if (buf.byteLength < 4) return null;
    const t = tag(new DataView(buf), 0);
    if (t === "\0\x01\0\0" || t === "true") return "TrueType";
    if (t === "OTTO") return "OpenType (CFF)";
    if (t === "ttcf") return "Font collection";
    if (t === "wOFF") return "WOFF";
    if (t === "wOF2") return "WOFF2";
    return null;
  }

  async function inflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
    return new Response(stream).arrayBuffer();
  }

  // tag -> async () => ArrayBuffer of that table
  function tables(buf) {
    const dv = new DataView(buf);
    const fmt = format(buf);
    const out = new Map();
    if (fmt === "WOFF") {
      const n = dv.getUint16(12);
      for (let i = 0; i < n; i++) {
        const r = 44 + i * 20;
        const off = dv.getUint32(r + 4), comp = dv.getUint32(r + 8), orig = dv.getUint32(r + 12);
        const bytes = new Uint8Array(buf, off, comp);
        out.set(tag(dv, r), () => (comp < orig ? inflate(bytes) : Promise.resolve(bytes.slice().buffer)));
      }
      return out;
    }
    let base = 0;
    if (fmt === "Font collection") base = dv.getUint32(12); // first font in the collection
    const n = dv.getUint16(base + 4);
    for (let i = 0; i < n; i++) {
      const r = base + 12 + i * 16;
      const off = dv.getUint32(r + 8), len = dv.getUint32(r + 12);
      out.set(tag(dv, r), () => Promise.resolve(buf.slice(off, off + len)));
    }
    return out;
  }

  function readNames(buf) {
    const dv = new DataView(buf);
    const count = dv.getUint16(2);
    const strings = dv.getUint16(4);
    const best = {}; // nameID -> [score, text]
    for (let i = 0; i < count; i++) {
      const r = 6 + i * 12;
      const platform = dv.getUint16(r), lang = dv.getUint16(r + 4), id = dv.getUint16(r + 6);
      const len = dv.getUint16(r + 8), off = strings + dv.getUint16(r + 10);
      if (![1, 2, 4, 5, 16, 17].includes(id) || off + len > buf.byteLength) continue;
      const bytes = new Uint8Array(buf, off, len);
      let text, score;
      if (platform === 3 || platform === 0) {
        text = new TextDecoder("utf-16be").decode(bytes);
        score = platform === 3 && lang === 0x409 ? 3 : 2;
      } else if (platform === 1) {
        text = new TextDecoder("latin1").decode(bytes);
        score = 1;
      } else continue;
      if (!best[id] || best[id][0] < score) best[id] = [score, text];
    }
    const get = (id) => best[id] && best[id][1];
    return {
      family: get(16) || get(1),
      style: get(17) || get(2),
      fullName: get(4),
      version: get(5),
    };
  }

  async function read(buf) {
    const fmt = format(buf);
    const info = { format: fmt };
    if (!fmt || fmt === "WOFF2") return info;
    try {
      const t = tables(buf);
      if (t.has("name")) Object.assign(info, readNames(await t.get("name")()));
      if (t.has("maxp")) info.glyphs = new DataView(await t.get("maxp")()).getUint16(4);
    } catch {
      /* damaged or unusual font: the format is still worth showing */
    }
    return info;
  }

  return { format, read };
})();
