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
  const nodeEl = new WeakMap(); // parsed node -> its .jt-node (sections) or .jt-line (primitives), once built
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
      nodeEl.set(node, div);
      return div;
    }
    const [open, close] = node.t === "obj" ? ["{", "}"] : ["[", "]"];
    if (!node.kids.length) {
      const div = line(key, span("tok-punc", open + close), ...commaParts);
      lineCtx.set(div, ctx);
      nodeEl.set(node, div);
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
    const closing = line(null, span("tok-punc", close), ...commaParts);
    closing.classList.add("jt-close");
    el.append(head, kids, closing);
    info.set(el, { node, depth, built: false, ctx });
    nodeEl.set(node, el);

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
  // JavaScript: user.tags[0], a["odd key"]. Python: ["user"]["tags"][0], for
  // indexing what json.loads() returns (JSON string escapes are valid Python).
  function path(ctx, python) {
    let out = "";
    for (let c = ctx; c && c.parent; c = c.parent) {
      if (c.key == null) out = `[${c.index}]` + out;
      else {
        const k = JSON.parse(c.key);
        out = (!python && IDENT.test(k) ? "." + k : `[${JSON.stringify(k)}]`) + out;
      }
    }
    return out.startsWith(".") ? out.slice(1) : out;
  }

  // The keys (object members) and indexes (array items) from the top down to ctx.
  function keysOf(ctx) {
    const out = [];
    for (let c = ctx; c && c.parent; c = c.parent) out.unshift(c.key != null ? JSON.parse(c.key) : c.index);
    return out;
  }
  // The line at those keys, opening the sections on the way; null if this
  // JSON has nothing there.
  function lineAt(root, keys) {
    let node = root;
    const chain = [root];
    for (const k of keys) {
      if (!node.kids) return null;
      const i = node.t === "arr"
        ? (typeof k === "number" && k < node.kids.length ? k : -1)
        : node.kids.findIndex(([rk]) => JSON.parse(rk) === k);
      if (i < 0) return null;
      node = node.kids[i][1];
      chain.push(node);
    }
    return lineOf({ chain }, true);
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
      // As a JSON fragment: "key": value inside an object, else just the value.
      row: () => (ctx.key != null ? `${ctx.key}: ` : "") + serialize(ctx.node),
      keys: keysOf(ctx),
      path: ctx.parent ? path(ctx) : null,
      pythonPath: ctx.parent ? path(ctx, true) : null,
    };
  }

  /* ---- keyboard: lines are .jt-line elements (a section's first line stands for it) ---- */
  const sectionOf = (ln) => (ln.parentElement.classList.contains("jt-node") && ln === ln.parentElement.firstElementChild ? ln.parentElement : null);
  // Left: collapse an open section, else go to the section it's in. Right:
  // expand a closed section, else go to its first line. Returns the line to
  // move to (the same one when it only toggled), or null.
  function step(ln, dir) {
    const sec = sectionOf(ln);
    if (dir < 0) {
      if (sec && !sec.classList.contains("collapsed")) { setOpen(sec, false, false); return ln; }
      const up = ln.closest(".jt-kids");
      return up ? up.parentElement.firstElementChild : null;
    }
    if (!sec) return null;
    if (sec.classList.contains("collapsed")) { setOpen(sec, true, false); return ln; }
    const first = sec.children[1].children[1]; // after the guide
    return first ? (first.classList.contains("jt-node") ? first.firstElementChild : first) : null;
  }

  /* ---- search: over the parsed values, so matches inside collapsed (or
   * never built) sections are found too ---- */
  // The text a line shows, as search sees it: "key": value for values, the
  // key alone for sections.
  const lineText = (key, node) => (node.t === "obj" || node.t === "arr" ? (key != null ? key : "") : (key != null ? key + ": " : "") + node.raw);
  // Matches of `re` (a global, case-insensitive RegExp), in order:
  // { chain: [root … node], nth, len } where nth counts the matches within
  // the line's first len characters.
  function find(root, re, limit) {
    const out = [];
    const walk = (key, node, chain) => {
      if (out.length >= limit) return;
      const text = lineText(key, node);
      re.lastIndex = 0;
      let n = 0;
      while (text && re.exec(text) && out.length < limit) { out.push({ chain, nth: n++, len: text.length }); if (re.lastIndex === 0) break; }
      if (node.kids) for (const [k, child] of node.kids) walk(k, child, chain.concat(child));
    };
    walk(null, root, [root]);
    return out;
  }
  // The line of a match, opening the sections around it when reveal is set
  // (else null when it isn't built).
  function lineOf(m, reveal) {
    for (let i = 0; i < m.chain.length - 1; i++) {
      const el = nodeEl.get(m.chain[i]);
      if (!el) return null;
      if (reveal) setOpen(el, true, false);
      else if (el.classList.contains("collapsed")) return null;
    }
    const el = nodeEl.get(m.chain[m.chain.length - 1]);
    return el ? (el.classList.contains("jt-node") ? el.firstElementChild : el) : null;
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
    return {
      el: wrap, entryAt, step,
      find: (re, limit) => find(root, re, limit),
      lineOf,
      lineAt: (keys) => lineAt(root, keys),
      expandAll: () => all(true),
      collapseAll: () => { all(false); if (top.classList.contains("jt-node")) setOpen(top, true, false); },
    };
  }

  return { render };
})();
