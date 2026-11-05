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
  const info = new WeakMap(); // .jt-node element -> { node, depth, built }

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

  function renderValue(node, key, last, depth, autoDepth) {
    const comma = last ? null : span("tok-punc", ",");
    const commaParts = comma ? [comma] : [];

    if (node.t !== "obj" && node.t !== "arr") {
      return line(key, span("tok-" + node.t, node.raw), ...commaParts);
    }
    const [open, close] = node.t === "obj" ? ["{", "}"] : ["[", "]"];
    if (!node.kids.length) return line(key, span("tok-punc", open + close), ...commaParts);

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
    el.append(head, kids, line(null, span("tok-punc", close), ...commaParts));
    info.set(el, { node, depth, built: false });

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
      kids.append(renderValue(child, key, idx === list.length - 1, meta.depth + 1, autoDepth));
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

  /* Returns a viewer element, or null if text isn't valid JSON. */
  function render(text) {
    try { JSON.parse(text); } catch { return null; }
    const { root, count } = parse(text);
    const autoDepth = count <= AUTO_EXPAND_ALL ? Infinity : AUTO_DEPTH;

    const wrap = document.createElement("div");
    wrap.className = "jtree code";
    wrap.append(renderValue(root, null, true, 0, autoDepth));

    wrap.addEventListener("click", (e) => {
      const hit = e.target.closest(".jt-toggle, .jt-summary");
      if (!hit) return;
      const el = hit.closest(".jt-node");
      setOpen(el, el.classList.contains("collapsed"), e.altKey);
    });

    const top = wrap.firstElementChild;
    const all = (open) => { if (top.classList.contains("jt-node")) setOpen(top, open, true); };
    return { el: wrap, expandAll: () => all(true), collapseAll: () => { all(false); if (top.classList.contains("jt-node")) setOpen(top, true, false); } };
  }

  return { render };
})();
