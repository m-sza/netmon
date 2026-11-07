"use strict";

/* Formats code for the collapsible code view, off the panel's thread (a large
 * bundle can take a second or two). Uses js-beautify 1.15.4 (beautifier.js,
 * unmodified from the npm package; MIT, see LICENSE-js-beautify.txt).
 * Message in: { id, lang: "js" | "css" | "html", text }. Out: { id, text } or { id, error }. */
importScripts("beautifier.js");

const COMMON = {
  indent_size: 2,
  preserve_newlines: true,
  max_preserve_newlines: 2,
  wrap_line_length: 0, // never wrap: one statement per line, so blocks stay clean
  end_with_newline: false,
};
const OPTIONS = {
  js: { ...COMMON, break_chained_methods: false, space_before_conditional: true },
  css: { ...COMMON },
  // indent_inner_html: <head> and <body> nest inside <html>, so they fold too.
  html: { ...COMMON, indent_inner_html: true, indent_scripts: "normal", wrap_attributes: "auto", extra_liners: [] },
};

self.onmessage = (ev) => {
  const { id, lang, text } = ev.data;
  try {
    const out = lang === "js" ? beautifier.js(text, OPTIONS.js)
      : lang === "css" ? beautifier.css(text, OPTIONS.css)
      : beautifier.html(text, OPTIONS.html);
    self.postMessage({ id, text: out });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
