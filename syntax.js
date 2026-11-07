"use strict";

/* A small, dependency-free syntax highlighter. Produces DOM nodes (never HTML
 * strings), so response content can't inject markup into the panel. */
const Syntax = (() => {
  const MAX_CHARS = 400000; // above this, show plain text to keep the panel fast

  /* ---- output: merges adjacent tokens of the same class into one node ---- */
  class Out {
    constructor() { this.frag = document.createDocumentFragment(); this.cls = null; this.buf = ""; }
    push(cls, text) {
      if (!text) return;
      if (cls === this.cls) { this.buf += text; return; }
      this.flush();
      this.cls = cls;
      this.buf = text;
    }
    flush() {
      if (!this.buf) return;
      if (this.cls) {
        const s = document.createElement("span");
        s.className = "tok-" + this.cls;
        s.textContent = this.buf;
        this.frag.append(s);
      } else {
        this.frag.append(document.createTextNode(this.buf));
      }
      this.buf = "";
    }
    done() { this.flush(); return this.frag; }
  }

  // Runs a sticky regex over text, calling handle(match) for each token.
  function scan(text, re, out, handle) {
    let pos = 0;
    while (pos < text.length) {
      re.lastIndex = pos;
      const m = re.exec(text);
      if (!m || re.lastIndex === pos) { out.push(null, text.slice(pos)); return; }
      handle(m);
      pos = re.lastIndex;
    }
  }

  /* ---------------- JSON ---------------- */
  const JSON_RE = /("(?:[^"\\\n]|\\[\s\S])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(true|false|null)\b|([{}[\],:])|(\s+)|([^\s"{}[\],:]+|[\s\S])/y;
  function json(text, out) {
    scan(text, JSON_RE, out, (m) => {
      if (m[1]) {
        if (m[2]) { out.push("key", m[1]); out.push("punc", m[2]); }
        else out.push("str", m[1]);
      } else if (m[3]) out.push("num", m[3]);
      else if (m[4]) out.push("lit", m[4]);
      else if (m[5]) out.push("punc", m[5]);
      else out.push(null, m[0]);
    });
  }

  /* ---------------- JavaScript ---------------- */
  const JS_KW = new Set("break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new return super switch throw try typeof var void while with yield async await of static get set from as".split(" "));
  const JS_LIT = new Set("true false null undefined NaN Infinity this".split(" "));
  const JS_RE_AFTER = new Set("return typeof instanceof in of new delete void throw case do else yield await".split(" "));
  const JS_RE = /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|("(?:[^"\\\n]|\\[\s\S])*"?|'(?:[^'\\\n]|\\[\s\S])*'?|`(?:[^`\\]|\\[\s\S])*`?)|(\/(?![*/])(?:[^/\\\n[]|\\.|\[(?:[^\]\\\n]|\\.)*\])+\/[a-z]*)|(0[xX][\da-fA-F_]+n?|0[bB][01_]+n?|0[oO][0-7_]+n?|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?n?)|([A-Za-z_$\u00a0-\uffff][\w$\u00a0-\uffff]*)|(\s+)|([\s\S])/y;
  const CALL_AFTER = /\s*\(/y;

  function js(text, out) {
    let regexOk = true; // can a "/" start a regex literal here?
    let pos = 0;
    while (pos < text.length) {
      JS_RE.lastIndex = pos;
      const m = JS_RE.exec(text);
      if (!m) { out.push(null, text.slice(pos)); return; }
      let end = JS_RE.lastIndex;
      if (m[1]) out.push("com", m[1]);
      else if (m[2]) { out.push("str", m[2]); regexOk = false; }
      else if (m[3]) {
        if (regexOk) { out.push("re", m[3]); regexOk = false; }
        else { out.push("punc", "/"); end = pos + 1; regexOk = true; }
      } else if (m[4]) { out.push("num", m[4]); regexOk = false; }
      else if (m[5]) {
        const w = m[5];
        if (JS_KW.has(w)) out.push("kw", w);
        else if (JS_LIT.has(w)) out.push("lit", w);
        else {
          CALL_AFTER.lastIndex = end;
          out.push(CALL_AFTER.test(text) ? "fn" : null, w);
        }
        regexOk = JS_RE_AFTER.has(w);
      } else if (m[6]) out.push(null, m[6]);
      else {
        const c = m[7];
        out.push("punc", c);
        regexOk = c !== ")" && c !== "]";
      }
      pos = end;
    }
  }

  /* ---------------- CSS ---------------- */
  const CSS_VALUE_RE = /(\/\*[\s\S]*?(?:\*\/|$))|("(?:[^"\\\n]|\\[\s\S])*"?|'(?:[^'\\\n]|\\[\s\S])*'?)|(#[\da-fA-F]{3,8}\b)|(-?(?:\d+\.?\d*|\.\d+)(?:%|[a-zA-Z]+)?)|(!important)|([\w-]+(?=\())|([\w-]+)|(\s+)|([\s\S])/y;

  function cssValue(text, out) {
    scan(text, CSS_VALUE_RE, out, (m) => {
      if (m[1]) out.push("com", m[1]);
      else if (m[2]) out.push("str", m[2]);
      else if (m[3] || m[4]) out.push("num", m[0]);
      else if (m[5]) out.push("kw", m[5]);
      else if (m[6]) out.push("fn", m[6]);
      else if (m[7]) out.push("val", m[7]);
      else if (m[8]) out.push(null, m[8]);
      else out.push("punc", m[9]);
    });
  }

  // Index of the next { ; or } that isn't inside a string, comment or parentheses.
  function cssNextDelim(text, i) {
    let depth = 0;
    const n = text.length;
    while (i < n) {
      const c = text[i];
      if (c === '"' || c === "'") {
        i++;
        while (i < n && text[i] !== c && text[i] !== "\n") i += text[i] === "\\" ? 2 : 1;
      } else if (c === "/" && text[i + 1] === "*") {
        const e = text.indexOf("*/", i + 2);
        i = e < 0 ? n : e + 1;
      } else if (c === "(") depth++;
      else if (c === ")") depth = Math.max(0, depth - 1);
      else if (depth === 0 && (c === "{" || c === ";" || c === "}")) return i;
      i++;
    }
    return n;
  }

  function atRule(stmt, out) {
    const m = /^@[\w-]+/.exec(stmt);
    out.push("kw", m ? m[0] : "@");
    cssValue(stmt.slice(m ? m[0].length : 1), out);
  }

  function css(text, out) {
    let i = 0;
    const n = text.length;
    while (i < n) {
      const c = text[i];
      if (/\s/.test(c)) {
        let j = i + 1;
        while (j < n && /\s/.test(text[j])) j++;
        out.push(null, text.slice(i, j));
        i = j;
      } else if (c === "/" && text[i + 1] === "*") {
        const e = text.indexOf("*/", i + 2);
        const j = e < 0 ? n : e + 2;
        out.push("com", text.slice(i, j));
        i = j;
      } else if (c === "{" || c === "}" || c === ";") {
        out.push("punc", c);
        i++;
      } else {
        const j = cssNextDelim(text, i);
        const stmt = text.slice(i, j);
        if (stmt.startsWith("@")) atRule(stmt, out);
        else if (text[j] === "{") out.push("sel", stmt);
        else {
          const colon = stmt.indexOf(":");
          if (colon > 0) {
            out.push("prop", stmt.slice(0, colon));
            out.push("punc", ":");
            cssValue(stmt.slice(colon + 1), out);
          } else cssValue(stmt, out);
        }
        i = j;
      }
    }
  }

  /* ---------------- HTML / XML ---------------- */
  const TAG_RE = /<\/?([A-Za-z][\w:.-]*)/y;
  const ATTR_RE = /(\s+)|(\/?>)|([^\s=>/"']+)(\s*=\s*)?("[^"]*"?|'[^']*'?|[^\s>"']+)?|([\s\S])/y;

  function markup(text, out, isHtml) {
    let i = 0;
    const n = text.length;
    while (i < n) {
      const lt = text.indexOf("<", i);
      if (lt < 0) { out.push(null, text.slice(i)); return; }
      if (lt > i) out.push(null, text.slice(i, lt));
      i = lt;

      if (text.startsWith("<!--", i)) {
        const e = text.indexOf("-->", i + 4);
        const j = e < 0 ? n : e + 3;
        out.push("com", text.slice(i, j));
        i = j;
        continue;
      }
      if (text.startsWith("<![CDATA[", i)) {
        const e = text.indexOf("]]>", i);
        const j = e < 0 ? n : e + 3;
        out.push("str", text.slice(i, j));
        i = j;
        continue;
      }
      if (text[i + 1] === "!" || text[i + 1] === "?") {
        const e = text.indexOf(">", i);
        const j = e < 0 ? n : e + 1;
        out.push("meta", text.slice(i, j));
        i = j;
        continue;
      }

      TAG_RE.lastIndex = i;
      const t = TAG_RE.exec(text);
      if (!t) { out.push(null, "<"); i++; continue; }
      out.push("tag", t[0]);
      i = TAG_RE.lastIndex;
      const name = t[1].toLowerCase();
      const closing = t[0][1] === "/";

      const attrs = {};
      let selfClosed = false;
      while (i < n) {
        ATTR_RE.lastIndex = i;
        const a = ATTR_RE.exec(text);
        if (!a) break;
        i = ATTR_RE.lastIndex;
        if (a[1]) out.push(null, a[1]);
        else if (a[2]) { out.push("tag", a[2]); selfClosed = a[2] === "/>"; break; }
        else if (a[3]) {
          out.push("attr", a[3]);
          if (a[4]) out.push("punc", a[4]);
          if (a[5]) out.push("str", a[5]);
          attrs[a[3].toLowerCase()] = (a[5] || "").replace(/^["']|["']$/g, "");
        } else out.push(null, a[6]);
      }

      // Highlight the contents of <script> and <style> with their own language.
      if (isHtml && !closing && !selfClosed && (name === "script" || name === "style")) {
        const endRe = new RegExp("</" + name + "\\s*>", "ig");
        endRe.lastIndex = i;
        const em = endRe.exec(text);
        const j = em ? em.index : n;
        const inner = text.slice(i, j);
        if (name === "style") css(inner, out);
        else {
          const type = (attrs.type || "").toLowerCase();
          if (/json/.test(type)) json(inner, out);
          else if (!type || /javascript|ecmascript|module/.test(type)) js(inner, out);
          else out.push(null, inner);
        }
        i = j;
      }
    }
  }

  /* ---------------- application/x-www-form-urlencoded ---------------- */
  function form(text, out) {
    for (const [idx, pair] of text.split("&").entries()) {
      if (idx) out.push("punc", "&");
      const eq = pair.indexOf("=");
      if (eq < 0) { out.push("attr", pair); continue; }
      out.push("attr", pair.slice(0, eq));
      out.push("punc", "=");
      out.push("str", pair.slice(eq + 1));
    }
  }

  /* ---------------- public API ---------------- */
  /* ---------------- GraphQL ---------------- */
  const GQL_KW = new Set("query mutation subscription fragment on true false null schema type input enum interface union scalar extend directive implements repeatable".split(" "));
  const GQL_RE = /(#[^\n]*)|("""[\s\S]*?"""|"(?:[^"\\\n]|\\.)*")|(\$[_A-Za-z][_0-9A-Za-z]*)|(@[_A-Za-z][_0-9A-Za-z]*)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([_A-Za-z][_0-9A-Za-z]*)(\s*:)?|(\.\.\.|[{}()[\]:=!|&,])|(\s+)|([\s\S])/y;
  function graphql(text, out) {
    scan(text, GQL_RE, out, (m) => {
      if (m[1]) out.push("com", m[1]);
      else if (m[2]) out.push("str", m[2]);
      else if (m[3]) out.push("val", m[3]);
      else if (m[4]) out.push("fn", m[4]);
      else if (m[5]) out.push("num", m[5]);
      else if (m[6]) {
        if (m[7]) { out.push("key", m[6]); out.push("punc", m[7]); }
        else out.push(GQL_KW.has(m[6]) ? "kw" : null, m[6]);
      } else if (m[8]) out.push("punc", m[8]);
      else out.push(null, m[0]);
    });
  }

  const LABELS = { json: "JSON", js: "JavaScript", css: "CSS", html: "HTML", xml: "XML", form: "Form data", graphql: "GraphQL", text: "Text" };

  function langFor(mime, url, text) {
    mime = mime || "";
    if (/graphql/.test(mime)) return "graphql";
    if (/json/.test(mime)) return "json";
    if (/javascript|ecmascript/.test(mime)) return "js";
    if (/css/.test(mime)) return "css";
    if (/html/.test(mime)) return "html";
    if (/xml|svg|rss|atom|xslt/.test(mime)) return "xml";
    if (/x-www-form-urlencoded/.test(mime)) return "form";
    const u = NM.safeUrl(url);
    const path = u ? u.pathname.toLowerCase() : "";
    if (/\.(m?js|cjs|jsx|ts|tsx)$/.test(path)) return "js";
    if (/\.css$/.test(path)) return "css";
    if (/\.(json|map)$/.test(path)) return "json";
    if (/\.html?$/.test(path)) return "html";
    if (/\.(xml|svg)$/.test(path)) return "xml";
    const head = text.slice(0, 200).trimStart();
    if (/^[[{]/.test(head)) {
      try { JSON.parse(text); return "json"; } catch { /* not JSON */ }
    }
    if (/^<\?xml/.test(head)) return "xml";
    if (/^<(!doctype|html|head|body|div|script|meta|link)\b/i.test(head)) return "html";
    if (/^</.test(head)) return "xml";
    return "text";
  }

  function highlight(text, lang) {
    if (lang === "text" || text.length > MAX_CHARS) return document.createTextNode(text);
    const out = new Out();
    switch (lang) {
      case "json": json(text, out); break;
      case "js": js(text, out); break;
      case "css": css(text, out); break;
      case "html": markup(text, out, true); break;
      case "xml": markup(text, out, false); break;
      case "form": form(text, out); break;
      case "graphql": graphql(text, out); break;
      default: out.push(null, text);
    }
    return out.done();
  }

  return { highlight, langFor, label: (l) => LABELS[l] || l, MAX_CHARS };
})();
