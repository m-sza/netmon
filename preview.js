"use strict";

/* Builds an offline copy of an HTML response for the preview frame: every image,
 * stylesheet and font it uses is swapped for the body the monitor already
 * recorded (as a data: URL), and a Content-Security-Policy blocks everything
 * else, so previewing a page never makes a network request. */
const HtmlPreview = (() => {
  const MAX_RESOURCE = 15 * 1024 * 1024;
  const MAX_TOTAL = 60 * 1024 * 1024;
  const MAX_CSS_DEPTH = 3; // stylesheets importing stylesheets

  const CSP = "default-src 'none'; img-src data:; style-src data: 'unsafe-inline'; font-src data:; media-src data:";

  const CSS_URL_RE = /url\(\s*(['"]?)([^'")]*?)\1\s*\)|@import\s+(['"])([^'"]+)\3/gi;

  function absolute(ref, base) {
    if (!ref) return null;
    ref = ref.trim();
    if (!ref || /^(data|blob|javascript|about|mailto|tel):/i.test(ref) || ref.startsWith("#")) return null;
    try {
      const u = new URL(ref, base);
      return /^https?:$/.test(u.protocol) ? u.href : null;
    } catch {
      return null;
    }
  }

  function cssRefs(css, base) {
    const out = [];
    for (const m of css.matchAll(CSS_URL_RE)) {
      const abs = absolute(m[2] ?? m[4], base);
      if (abs) out.push(abs);
    }
    return out;
  }

  function rewriteCss(css, base, lookup) {
    return css.replace(CSS_URL_RE, (all, q1, u1, q2, u2) => {
      const ref = u1 ?? u2;
      const abs = absolute(ref, base);
      const data = abs && lookup(abs);
      if (!data) return all;
      return u1 != null ? `url("${data}")` : `@import "${data}"`;
    });
  }

  function parseSrcset(value) {
    return value.split(/,\s+/).map((part) => {
      const [url, ...rest] = part.trim().split(/\s+/);
      return { url, descriptor: rest.join(" ") };
    }).filter((c) => c.url);
  }

  function toBase64(buf) {
    const bytes = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  const isCss = (mime, url) => /css/i.test(mime || "") || /\.css(\?|$)/i.test(url);

  /* fetchBodies(urls) -> { url: { mime, body: ArrayBuffer } } for the recorded ones. */
  async function build(text, pageUrl, fetchBodies) {
    const doc = new DOMParser().parseFromString(text, "text/html");
    const baseHref = doc.querySelector("base[href]")?.getAttribute("href");
    const base = (baseHref && absolute(baseHref, pageUrl)) || pageUrl;

    // Things the preview shouldn't have: scripts never run anyway, and these
    // would only try to load or navigate.
    for (const el of doc.querySelectorAll("script, base, meta[http-equiv], link:not([rel~='stylesheet' i])")) el.remove();

    // Every place that references a resource, as [element, attribute, kind].
    const slots = [];
    const add = (el, attr, kind) => { if (el.hasAttribute(attr)) slots.push([el, attr, kind]); };
    for (const el of doc.querySelectorAll("img, source, input[type='image' i], video, audio, track, embed")) add(el, "src", "url");
    for (const el of doc.querySelectorAll("img, source")) add(el, "srcset", "srcset");
    for (const el of doc.querySelectorAll("video")) add(el, "poster", "url");
    for (const el of doc.querySelectorAll("link[rel~='stylesheet' i]")) add(el, "href", "css");
    for (const el of doc.querySelectorAll("image, use, feImage")) { add(el, "href", "url"); add(el, "xlink:href", "url"); }
    for (const el of doc.querySelectorAll("[style]")) add(el, "style", "inline-css");
    for (const el of doc.querySelectorAll("[background]")) add(el, "background", "url");
    const styles = [...doc.querySelectorAll("style")];

    // Gather URLs, then follow stylesheets' own references a few levels deep.
    const wanted = new Set();
    const cssUrls = new Set();
    for (const [el, attr, kind] of slots) {
      const v = el.getAttribute(attr);
      if (kind === "url" || kind === "css") {
        const abs = absolute(v, base);
        if (abs) { wanted.add(abs); if (kind === "css") cssUrls.add(abs); }
      } else if (kind === "srcset") {
        for (const c of parseSrcset(v)) { const abs = absolute(c.url, base); if (abs) wanted.add(abs); }
      } else {
        for (const abs of cssRefs(v, base)) wanted.add(abs);
      }
    }
    for (const st of styles) for (const abs of cssRefs(st.textContent, base)) wanted.add(abs);

    const bodies = new Map();
    let pending = [...wanted];
    for (let depth = 0; pending.length && depth <= MAX_CSS_DEPTH; depth++) {
      const got = await fetchBodies(pending);
      const next = [];
      for (const url of pending) {
        const r = got[url];
        if (!r) continue;
        bodies.set(url, r);
        if (isCss(r.mime, url) || cssUrls.has(url)) {
          cssUrls.add(url);
          const css = new TextDecoder().decode(r.body);
          for (const abs of cssRefs(css, url)) if (!wanted.has(abs)) { wanted.add(abs); next.push(abs); }
        }
      }
      pending = next;
    }

    // data: URLs, built on demand; stylesheets get their own references rewritten first.
    let total = 0;
    const dataUrls = new Map();
    const visiting = new Set();
    const lookup = (url) => {
      if (dataUrls.has(url)) return dataUrls.get(url);
      const r = bodies.get(url);
      if (!r || r.body.byteLength > MAX_RESOURCE || total + r.body.byteLength > MAX_TOTAL || visiting.has(url)) return null;
      let data;
      if (cssUrls.has(url)) {
        visiting.add(url);
        const css = rewriteCss(new TextDecoder().decode(r.body), url, lookup);
        visiting.delete(url);
        data = "data:text/css;base64," + toBase64(new TextEncoder().encode(css));
      } else {
        const mime = (r.mime || "application/octet-stream").split(";")[0];
        data = `data:${mime};base64,${toBase64(r.body)}`;
      }
      total += data.length;
      dataUrls.set(url, data);
      return data;
    };

    for (const [el, attr, kind] of slots) {
      const v = el.getAttribute(attr);
      if (kind === "url" || kind === "css") {
        const abs = absolute(v, base);
        const data = abs && lookup(abs);
        if (data) el.setAttribute(attr, data);
      } else if (kind === "srcset") {
        el.setAttribute(attr, parseSrcset(v).map((c) => {
          const abs = absolute(c.url, base);
          return [(abs && lookup(abs)) || c.url, c.descriptor].filter(Boolean).join(" ");
        }).join(", "));
      } else {
        el.setAttribute(attr, rewriteCss(v, base, lookup));
      }
    }
    for (const st of styles) st.textContent = rewriteCss(st.textContent, base, lookup);

    // Links show their real target on hover, but clicking them does nothing:
    // they open in a new window, which the sandbox doesn't allow.
    for (const a of doc.querySelectorAll("a[href], area[href]")) {
      const abs = absolute(a.getAttribute("href"), base);
      if (abs) a.setAttribute("href", abs);
    }

    const head = doc.head || doc.documentElement.insertBefore(doc.createElement("head"), doc.body);
    const csp = doc.createElement("meta");
    csp.setAttribute("http-equiv", "Content-Security-Policy");
    csp.setAttribute("content", CSP);
    const target = doc.createElement("base");
    target.setAttribute("target", "_blank");
    head.prepend(csp, target);

    const found = [...wanted].filter((u) => dataUrls.has(u)).length;
    const doctype = doc.doctype ? `<!DOCTYPE ${doc.doctype.name}>` : "";
    return { html: doctype + doc.documentElement.outerHTML, found, missing: wanted.size - found };
  }

  return { build };
})();
