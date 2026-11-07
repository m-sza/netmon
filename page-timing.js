"use strict";

/* Content script (the extension's own isolated world, on every page): reports
 * the top-level page's load milestones, as absolute times like request
 * timestamps, for the overview's DOMContentLoaded and Load lines. It only
 * reads performance entries, so pages can't tell it's there. */
(() => {
  if (window.top !== window || globalThis.__netmonTiming) return;
  globalThis.__netmonTiming = true;
  const report = () => {
    const nav = performance.getEntriesByType && performance.getEntriesByType("navigation")[0];
    if (!nav) return;
    const at = (v) => (v > 0 ? performance.timeOrigin + v : undefined);
    browser.runtime.sendMessage({ cmd: "pageTiming", nav: performance.timeOrigin, dcl: at(nav.domContentLoadedEventStart), load: at(nav.loadEventStart) })
      .catch(() => { /* background reloading */ });
  };
  if (document.readyState === "complete") report();
  else {
    document.addEventListener("DOMContentLoaded", report, { once: true });
    window.addEventListener("load", () => setTimeout(report, 0), { once: true });
  }
})();
