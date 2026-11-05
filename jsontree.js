"use strict";

/* Collapsible JSON viewer. Builds DOM nodes (never HTML strings), and keeps the
 * original text of every key and primitive, so large numbers and escapes are
 * shown exactly as they arrived. Children are only built when first expanded. */
const JsonTree = (() => {
  const AUTO_EXPAND_ALL = 2000; // above this many values, open only the top levels
  const AUTO_DEPTH = 2;

  /* ---- parser: assumes valid JSON (checked with JSON.parse first) ---- */
  const PRIM_RE = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;

  function parse(text) {
    let i = 0;
    let count = 0;
    const ws = () => { while (" \t\n\r".includes(text[i]) && i < text.length) i++; };
    const str = () => {
      const start = i++;
      while (text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      i++;
      return text.slice(start, i);
    };
    const value = () => {
      count++;
      const c = text[i];
      if (c === "{" || c === "[") {
        const isObj = c === "{";
        const close = isObj ? "}" : "]";
        const kids = [];
        i++;
        ws();
        if (text[i] === close) { i++; return { t: isObj ? "obj" : "arr", kids }; }
        for (;;) {
          ws();
          let key = null;
          if (isObj) { key = str(); ws(); i++; ws(); }
          kids.push([key, value()]);
          ws();
          if (text[i++] !== ",") break;
        }
        return { t: isObj ? "obj" : "arr", kids };
      }
      if (c === '"') return { t: "str", raw: str() };
      PRIM_RE.lastIndex = i;
      const m = PRIM_RE.exec(text);
      i = PRIM_RE.lastIndex;
      return { t: /^[-\d]/.test(m[0]) ? "num" : "lit", raw: m[0] };
    };
    ws();
    const root = value();
    return { root, count };
  }

  /* ---- rendering ---- */
  const info = new WeakMap(); // .jt-node element -> { node, depth, built, ctx }
  const lineCtx = new WeakMap(); // a primitive's .jt-line -> ctx
  // ctx: { node, key (raw JSON string or null), index, parent ctx or null }

  function span(cls, text) {
    const s = document.createElement("span");
    s.className = cls;
    s.textContent = text;
    return s;
  }

  function line(key, ...parts) {
    const div = document.createElement("div");
    div.className = "jt-line";
    if (key != null) div.append(span("tok-key", key), span("tok-punc", ": "));
    div.append(...parts);
    return div;
  }

  function renderValue(node, key, last, depth, autoDepth, ctx) {
    const comma = last ? null : span("tok-punc", ",");
    const commaParts = comma ? [comma] : [];

    if (node.t !== "obj" && node.t !== "arr") {
      const div = line(key, span("tok-" + node.t, node.raw), ...commaParts);
      lineCtx.set(div, ctx);
      return div;
    }
    const [open, close] = node.t === "obj" ? ["{", "}"] : ["[", "]"];
    if (!node.kids.length) {
      const div = line(key, span("tok-punc", open + close), ...commaParts);
      lineCtx.set(div, ctx);
      return div;
    }

    const n = node.kids.length;
    const count = node.t === "obj" ? `${n} ${n === 1 ? "key" : "keys"}` : `${n} ${n === 1 ? "item" : "items"}`;

    const el = document.createElement("div");
    el.className = "jt-node collapsed";
    const toggle = span("jt-toggle", "");
    toggle.title = "Click to expand or collapse. Alt+click to do the same for everything inside.";
    const summary = span("jt-summary", "");
    summary.append(span("jt-ellipsis", "…"), span("tok-punc", close), span("jt-count", count), ...(comma ? [comma.cloneNode(true)] : []));
    const head = line(key, span("tok-punc", open), summary);
    head.prepend(toggle);
    const kids = document.createElement("div");
    kids.className = "jt-kids";
    // The line down the left of an open section; clicking it collapses the section.
    const guide = span("jt-guide", "");
    guide.title = "Collapse";
    kids.append(guide);
    el.append(head, kids, line(null, span("tok-punc", close), ...commaParts));
    info.set(el, { node, depth, built: false, ctx });

    if (depth < autoDepth) setOpen(el, true, false, autoDepth);
    return el;
  }

  function build(el, autoDepth) {
    const meta = info.get(el);
    if (meta.built) return;
    meta.built = true;
    const kids = el.children[1];
    const list = meta.node.kids;
    list.forEach(([key, child], idx) => {
      kids.append(renderValue(child, key, idx === list.length - 1, meta.depth + 1, autoDepth,
        { node: child, key, index: idx, parent: meta.ctx }));
    });
  }

  function setOpen(el, open, deep, autoDepth = 0) {
    if (open) build(el, autoDepth);
    el.classList.toggle("collapsed", !open);
    if (deep && info.get(el).built) {
      for (const child of el.children[1].children) {
        if (child.classList.contains("jt-node")) setOpen(child, open, true);
      }
    }
  }

  /* ---- copying ---- */
  // JSON text of a node, pretty-printed, with numbers and strings exactly as received.
  function serialize(node, indent = "") {
    if (node.t !== "obj" && node.t !== "arr") return node.raw;
    const [open, close] = node.t === "obj" ? ["{", "}"] : ["[", "]"];
    if (!node.kids.length) return open + close;
    const inner = indent + "  ";
    const parts = node.kids.map(([k, v]) => inner + (k != null ? k + ": " : "") + serialize(v, inner));
    return `${open}\n${parts.join(",\n")}\n${indent}${close}`;
  }
  // A primitive as plain text: strings without quotes and escapes.
  const plain = (node) => (node.t === "str" ? JSON.parse(node.raw) : node.t === "num" || node.t === "lit" ? node.raw : serialize(node));
  const IDENT = /^[A-Za-z_$][\w$]*$/;
  function path(ctx) {
    let out = "";
    for (let c = ctx; c && c.parent; c = c.parent) {
      if (c.key == null) out = `[${c.index}]` + out;
      else { const k = JSON.parse(c.key); out = (IDENT.test(k) ? "." + k : `[${JSON.stringify(k)}]`) + out; }
    }
    return out.startsWith(".") ? out.slice(1) : out;
  }

  /* What a right-click hit: the value on that line (a closing bracket counts
   * as its section). Null outside a value. */
  function entryAt(target) {
    const ln = target.closest && target.closest(".jt-line");
    let ctx = ln && lineCtx.get(ln);
    if (!ctx) {
      const el = (ln || target).closest && (ln || target).closest(".jt-node");
      ctx = el && info.get(el).ctx;
    }
    if (!ctx) return null;
    const isSection = ctx.node.t === "obj" || ctx.node.t === "arr";
    return {
      key: ctx.key != null ? JSON.parse(ctx.key) : null,
      index: ctx.key == null && ctx.parent ? ctx.index : null,
      kind: ctx.node.t === "obj" ? "object" : ctx.node.t === "arr" ? "array" : "value",
      isSection,
      value: () => (isSection ? serialize(ctx.node) : plain(ctx.node)),
      parent: ctx.parent ? () => serialize(ctx.parent.node) : null,
      parentKind: ctx.parent ? (ctx.parent.node.t === "obj" ? "object" : "array") : null,
      path: ctx.parent ? path(ctx) : null,
    };
  }

  /* Returns a viewer element, or null if text isn't valid JSON. */
  function render(text) {
    try { JSON.parse(text); } catch { return null; }
    const { root, count } = parse(text);
    const autoDepth = count <= AUTO_EXPAND_ALL ? Infinity : AUTO_DEPTH;

    const wrap = document.createElement("div");
    wrap.className = "jtree code";
    wrap.append(renderValue(root, null, true, 0, autoDepth, { node: root, key: null, index: 0, parent: null }));

    wrap.addEventListener("click", (e) => {
      const hit = e.target.closest(".jt-toggle, .jt-summary, .jt-guide");
      if (!hit) return;
      const el = hit.closest(".jt-node");
      setOpen(el, el.classList.contains("collapsed"), e.altKey);
      // Collapsing from the line far below its start: keep the section's first line in view.
      if (hit.classList.contains("jt-guide")) {
        const head = el.firstElementChild;
        const sc = wrap.closest("#details-body") || document.scrollingElement;
        const top = head.getBoundingClientRect().top, scTop = sc.getBoundingClientRect ? sc.getBoundingClientRect().top : 0;
        if (top < scTop) sc.scrollTop -= scTop - top + 8;
      }
    });

    const top = wrap.firstElementChild;
    const all = (open) => { if (top.classList.contains("jt-node")) setOpen(top, open, true); };
    return { el: wrap, entryAt, expandAll: () => all(true), collapseAll: () => { all(false); if (top.classList.contains("jt-node")) setOpen(top, true, false); } };
  }

  return { render };
})();
