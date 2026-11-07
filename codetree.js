"use strict";

/* Collapsible code (JS, CSS, HTML), shown like the JSON tree: an arrow and a
 * guide line on every block, Alt+click for everything inside, lines built
 * only when their block is first opened.
 *
 * Blocks come from indentation, as in code editors: a line followed by more
 * indented lines opens a block, which ends before the next line indented as
 * little as it. A line at the block's indent that only closes it (}, ], ),
 * </tag>) is its closing line, shown after the block and in its collapsed
 * summary. The text is expected to be formatted (see format-worker.js), so
 * indentation follows the structure. Nesting is shown by the tree, so each
 * line's own leading whitespace is dropped.
 *
 * Uses the JSON tree's classes (jt-*), so its look, the details row highlight
 * and search work the same. */
const CodeTree = (() => {
  const AUTO_LINES = 3000; // open blocks, outermost first, while about this many lines show

  function span(cls, text) {
    const s = document.createElement("span");
    s.className = cls;
    s.textContent = text;
    return s;
  }

  // The highlighted text as one array of nodes per line, leading whitespace
  // dropped, and which lines start inside a token (a multi-line string,
  // template or comment): those are text, not code, so they keep their
  // whitespace and don't count for the blocks.
  function highlightedLines(text, lang) {
    const lines = [[]];
    const inside = [false];
    const frag = Syntax.highlight(text, lang);
    const nodes = frag.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? [...frag.childNodes] : [frag];
    for (const n of nodes) {
      const cls = n.nodeType === Node.ELEMENT_NODE ? n.className : null;
      n.textContent.split("\n").forEach((part, i) => {
        if (i) { lines.push([]); inside.push(!!cls); }
        const line = lines[lines.length - 1];
        if (!line.length && !inside[lines.length - 1]) part = part.replace(/^[ \t]+/, "");
        if (part) line.push(cls ? span(cls, part) : document.createTextNode(part));
      });
    }
    return { lines, inside };
  }

  const CLOSER = /^[ \t]*([}\])]|<\/)/;
  function indentOf(s) {
    let i = 0;
    while (s[i] === " " || s[i] === "\t") i++;
    return i === s.length ? -1 : i; // -1: blank
  }

  // Blocks: { line, indent, items: [line numbers and blocks], close, parent }.
  function structure(lines, inside) {
    const n = lines.length;
    const indent = lines.map((l, i) => (inside[i] ? -1 : indentOf(l))); // text inside a token counts as blank
    const nextIndent = new Array(n); // indent of the next non-blank line
    for (let i = n - 1, next = -1; i >= 0; i--) { nextIndent[i] = next; if (indent[i] >= 0) next = indent[i]; }
    const root = { line: -1, indent: -1, items: [], close: null, parent: null };
    const stack = [root];
    const owner = new Array(n); // line -> the block it is drawn in (its own block for a closing line)
    const blockAt = new Map(); // first line -> block
    for (let i = 0; i < n; i++) {
      const ind = indent[i];
      const opens = ind >= 0 && nextIndent[i] > ind;
      if (ind >= 0) {
        let closed = false;
        while (stack.length > 1 && ind <= stack[stack.length - 1].indent) {
          const blk = stack.pop();
          if (ind === blk.indent && !opens && blk.close == null && CLOSER.test(lines[i])) {
            blk.close = i;
            owner[i] = blk;
            closed = true;
            break;
          }
        }
        if (closed) continue;
      }
      const top = stack[stack.length - 1];
      owner[i] = top;
      if (opens) {
        const blk = { line: i, indent: ind, items: [], close: null, parent: top };
        top.items.push(blk);
        blockAt.set(i, blk);
        stack.push(blk);
      } else top.items.push(i);
    }
    return { root, owner, blockAt };
  }

  /* Returns a viewer, with the same parts as JsonTree's that the panel uses. */
  function render(text, lang) {
    const raw = text.split("\n");
    const { lines: content, inside } = highlightedLines(text, lang);
    const plain = raw.map((l, i) => (inside[i] ? l : l.replace(/^[ \t]+/, ""))); // what each line shows
    const { root, owner, blockAt } = structure(raw, inside);

    const lineEl = new Array(raw.length); // built lines
    const blockEl = new Map(); // block -> its .jt-node
    const elBlock = new WeakMap(); // .jt-node -> block
    const lineOfEl = new WeakMap(); // .jt-line -> line number

    function makeLine(i) {
      const div = document.createElement("div");
      div.className = "jt-line";
      div.append(...content[i]);
      lineEl[i] = div;
      lineOfEl.set(div, i);
      return div;
    }
    const countLines = (blk) => (blk.close ?? endOf(blk)) - blk.line - 1;
    function endOf(blk) { // the last line inside the block, + 1
      const last = blk.items[blk.items.length - 1];
      return typeof last === "number" ? last + 1 : (last.close != null ? last.close + 1 : endOf(last));
    }

    function makeItem(item) {
      if (typeof item === "number") return makeLine(item);
      const blk = item;
      const el = document.createElement("div");
      el.className = "jt-node collapsed";
      const head = makeLine(blk.line);
      const toggle = span("jt-toggle", "");
      toggle.title = "Click to expand or collapse. Alt+click to do the same for everything inside.";
      const summary = span("jt-summary", "");
      const n = countLines(blk);
      summary.append(span("jt-ellipsis", "…"), ...(blk.close != null ? [span("tok-punc", plain[blk.close])] : []),
        span("jt-count", `${n} ${n === 1 ? "line" : "lines"}`));
      head.prepend(toggle);
      head.append(summary);
      const kids = document.createElement("div");
      kids.className = "jt-kids";
      const guide = span("jt-guide", "");
      guide.title = "Collapse";
      kids.append(guide);
      el.append(head, kids);
      if (blk.close != null) {
        const closing = makeLine(blk.close);
        closing.classList.add("jt-close");
        el.append(closing);
      }
      blockEl.set(blk, el);
      elBlock.set(el, { blk, built: false });
      return el;
    }

    function setOpen(el, open, deep) {
      const meta = elBlock.get(el);
      if (open && !meta.built) {
        meta.built = true;
        el.children[1].append(...meta.blk.items.map(makeItem));
      }
      el.classList.toggle("collapsed", !open);
      if (deep && meta.built) for (const child of el.children[1].children) if (child.classList.contains("jt-node")) setOpen(child, open, true);
    }

    const wrap = document.createElement("div");
    wrap.className = "jtree code codetree";
    wrap.append(...root.items.map(makeItem));

    // Opens blocks outermost first while the lines shown stay under AUTO_LINES.
    let shown = root.items.length;
    let level = root.items.filter((x) => typeof x !== "number");
    while (level.length && shown < AUTO_LINES) {
      const next = [];
      for (const blk of level) {
        if (shown + blk.items.length > AUTO_LINES) continue;
        setOpen(blockEl.get(blk), true, false);
        shown += blk.items.length + (blk.close != null ? 1 : 0);
        for (const x of blk.items) if (typeof x !== "number") next.push(x);
      }
      level = next;
    }

    wrap.addEventListener("click", (e) => {
      const hit = e.target.closest(".jt-toggle, .jt-summary, .jt-guide");
      if (!hit) return;
      const el = hit.closest(".jt-node");
      setOpen(el, el.classList.contains("collapsed"), e.altKey);
      if (hit.classList.contains("jt-guide")) {
        const top = el.firstElementChild.getBoundingClientRect().top;
        const sc = wrap.closest("#details-body");
        if (sc && top < sc.getBoundingClientRect().top) sc.scrollTop -= sc.getBoundingClientRect().top - top + 8;
      }
    });

    // The blocks to open, outermost first, to show line i (a block's first
    // line is drawn in the block around it; a closing line in its own block).
    function chainOf(i) {
      const out = [];
      for (let b = owner[i]; b && b !== root; b = b.parent) out.unshift(b);
      return out;
    }
    function lineOf(m, reveal) {
      for (const blk of m.chain) {
        const el = blockEl.get(blk);
        if (!el) return null;
        if (reveal) setOpen(el, true, false);
        else if (el.classList.contains("collapsed")) return null;
      }
      return lineEl[m.line] || null;
    }
    function find(re, limit) {
      const out = [];
      for (let i = 0; i < plain.length && out.length < limit; i++) {
        re.lastIndex = 0;
        let nth = 0;
        while (out.length < limit && re.exec(plain[i])) out.push({ line: i, chain: chainOf(i), nth: nth++, len: plain[i].length });
      }
      return out;
    }

    const sectionOf = (ln) => (ln.parentElement.classList.contains("jt-node") && ln === ln.parentElement.firstElementChild ? ln.parentElement : null);
    function step(ln, dir) {
      const sec = sectionOf(ln);
      if (dir < 0) {
        if (sec && !sec.classList.contains("collapsed")) { setOpen(sec, false, false); return ln; }
        const up = ln.closest(".jt-kids");
        return up ? up.parentElement.firstElementChild : null;
      }
      if (!sec) return null;
      if (sec.classList.contains("collapsed")) { setOpen(sec, true, false); return ln; }
      const first = sec.children[1].children[1];
      return first ? (first.classList.contains("jt-node") ? first.firstElementChild : first) : null;
    }

    // The text of lines a..b (inclusive), with the indent they share removed.
    function textOf(a, b) {
      const part = raw.slice(a, b + 1);
      const cut = Math.min(...part.map(indentOf).filter((x) => x >= 0));
      return part.map((l) => l.slice(Number.isFinite(cut) ? cut : 0)).join("\n");
    }
    function entryAt(target) {
      const ln = target.closest && target.closest(".jt-line");
      if (!ln || !lineOfEl.has(ln)) return null;
      const i = lineOfEl.get(ln);
      const blk = blockAt.get(i) || (ln.classList.contains("jt-close") ? owner[i] : null);
      return {
        kind: "code", isSection: !!blk, key: null, index: null, keys: null, path: null, pythonPath: null, parent: null,
        line: () => plain[i],
        value: () => (blk ? textOf(blk.line, blk.close ?? endOf(blk) - 1) : plain[i]),
        row: () => (blk ? textOf(blk.line, blk.close ?? endOf(blk) - 1) : plain[i]),
      };
    }

    const all = (open) => { for (const el of wrap.children) if (el.classList.contains("jt-node")) setOpen(el, open, true); };
    return { el: wrap, isCode: true, text, entryAt, step, find, lineOf, expandAll: () => all(true), collapseAll: () => all(false) };
  }

  return { render };
})();
