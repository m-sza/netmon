"use strict";

/* Overview: every request that passes the filters on one timeline above the
 * list, like the overview in Chrome's network panel. Bars are colored by
 * request type (the same colors as the type icons): the waiting part pale, the
 * download solid. Blue lines mark DOMContentLoaded and red lines Load of the
 * pages shown. Dragging across it shows only that time range in the list (and
 * zooms the Waterfall column to it); a click or double-click clears it.
 * Loaded after panel.js and uses its state and helpers. */
const Overview = (() => {
  const wrap = $("overview");
  const canvas = $("overview-canvas");
  const ctx = canvas.getContext("2d");
  const btn = $("btn-overview");
  const chip = $("overview-range");
  const chipText = $("overview-range-text");

  const RULER_H = 16;
  const MAX_LANE_H = 6;
  const MIN_BAR_W = 3;
  const timings = new Map(); // "tabId:nav" -> { tabId, nav, dcl, load }
  let shown = false;
  let layout = null;         // { t0, span, width } from the last draw
  let drag = null;           // { x0, x1 } in CSS pixels while selecting
  let hoverX = null;
  let queued = false;
  let dataDirty = true;      // the filtered list needs rebuilding (not just a hover redraw)
  let cached = [];

  /* Colors come from the icons' own CSS, so they follow the theme. */
  let colors = null;
  function colorFor(kind) {
    if (!colors) colors = new Map();
    if (!colors.has(kind)) {
      const probe = h("span", { class: "ic-" + kind, hidden: true });
      document.body.append(probe);
      probe.hidden = false;
      probe.style.display = "none";
      colors.set(kind, getComputedStyle(probe).color);
      probe.remove();
    }
    return colors.get(kind);
  }
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { colors = null; draw(); });

  // Ruler steps: 1, 2, 5 × 10^n ms, about every 90 px.
  function tickStep(span, width) {
    const raw = (span * 90) / Math.max(1, width);
    const p = 10 ** Math.floor(Math.log10(raw));
    for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p;
    return 10 * p;
  }
  function fmtTick(ms, step) {
    if (step < 1000) return `${Math.round(ms)} ms`;
    if (ms < 60000) return `${+(ms / 1000).toFixed(step < 10000 ? 1 : 0)} s`;
    const m = Math.floor(ms / 60000), s = Math.round((ms % 60000) / 1000);
    return s ? `${m} min ${s} s` : `${m} min`;
  }

  // Which page-load markers belong to the requests shown.
  function timingShown(t) {
    const f = state.tabFilter;
    if (f === "all") return true;
    if (f === "none") return false;
    if (f === "current") return state.originTabId == null || t.tabId === state.originTabId;
    return String(t.tabId) === f;
  }

  function draw(data = true) {
    if (data) dataDirty = true;
    if (!shown || queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; paint(); });
  }

  function paint() {
    const w = canvas.clientWidth, hgt = canvas.clientHeight;
    if (!w || !hgt) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(hgt * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    ctx.font = `11px ${cssVar("--ui") || "sans-serif"}`;
    ctx.textBaseline = "middle";

    const now = Date.now();
    if (dataDirty) {
      dataDirty = false;
      cached = [];
      for (const s of store.values()) if (matchesFilters(s)) cached.push(s);
      cached.sort((a, b) => a.start - b.start);
    }
    const list = cached;
    let t0 = Infinity, t1 = -Infinity;
    for (const s of list) {
      if (s.start < t0) t0 = s.start;
      const end = s.end ?? now;
      if (end > t1) t1 = end;
    }
    if (!list.length) {
      layout = null;
      ctx.fillStyle = cssVar("--muted");
      ctx.fillText("No requests to show.", 8, hgt / 2);
      return;
    }
    const span = Math.max(50, (t1 - t0) * 1.02);
    layout = { t0, span, width: w };
    const x = (t) => ((t - t0) / span) * w;

    // Ruler and grid
    const step = tickStep(span, w);
    ctx.fillStyle = cssVar("--chrome");
    ctx.fillRect(0, 0, w, RULER_H);
    ctx.fillStyle = cssVar("--border");
    ctx.fillRect(0, RULER_H - 1, w, 1);
    for (let t = step; t < span; t += step) {
      const px = Math.round(x(t0 + t)) + 0.5;
      ctx.fillStyle = cssVar("--border-faint");
      ctx.fillRect(px, RULER_H, 1, hgt - RULER_H);
      ctx.fillStyle = cssVar("--border");
      ctx.fillRect(px, RULER_H - 4, 1, 4);
      const label = fmtTick(t, step);
      const lw = ctx.measureText(label).width;
      if (px - lw - 3 > 0) { ctx.fillStyle = cssVar("--muted"); ctx.fillText(label, px - lw - 3, RULER_H / 2); }
    }

    // Bars, packed into lanes: each goes in the first lane free at its start.
    const laneEnds = [];
    const lanes = new Array(list.length);
    list.forEach((s, i) => {
      const x0 = x(s.start), x1 = Math.max(x0 + MIN_BAR_W, x(s.end ?? now));
      let lane = laneEnds.findIndex((e) => e < x0 - 1);
      if (lane < 0) { lane = laneEnds.length; laneEnds.push(0); }
      laneEnds[lane] = x1;
      lanes[i] = lane;
    });
    const area = hgt - RULER_H - 6;
    const laneH = Math.max(1, Math.min(MAX_LANE_H, area / laneEnds.length));
    const barH = laneH >= 3 ? laneH - 2 : laneH;
    list.forEach((s, i) => {
      const y = RULER_H + 3 + Math.min(lanes[i] * laneH, area - barH);
      const x0 = x(s.start), xEnd = Math.max(x0 + MIN_BAR_W, x(s.end ?? now));
      const xFirst = s.firstByte ? Math.min(xEnd, Math.max(x0, x(s.firstByte))) : (s.end ? x0 : xEnd);
      ctx.fillStyle = colorFor(iconKind(s));
      ctx.globalAlpha = 0.35;
      if (xFirst > x0) ctx.fillRect(x0, y, xFirst - x0, barH);
      ctx.globalAlpha = s.state === "pending" ? 0.6 : 1;
      if (xEnd > xFirst) ctx.fillRect(xFirst, y, Math.max(1, xEnd - xFirst), barH);
      ctx.globalAlpha = 1;
    });

    // Page load markers
    for (const t of timings.values()) {
      if (!timingShown(t)) continue;
      for (const [k, color] of [["dcl", cssVar("--tg-blue")], ["load", cssVar("--tg-red")]]) {
        if (!t[k] || t[k] < t0 || t[k] > t0 + span) continue;
        ctx.fillStyle = color;
        ctx.fillRect(Math.round(x(t[k])) - 1, RULER_H, 2, hgt - RULER_H);
      }
    }

    // Selected range (or the one being dragged): everything else dimmed.
    const sel = drag ? [Math.min(drag.x0, drag.x1), Math.max(drag.x0, drag.x1)]
      : state.timeRange ? [x(state.timeRange.from), x(state.timeRange.to)] : null;
    if (sel) {
      ctx.fillStyle = cssVar("--overview-dim");
      ctx.fillRect(0, RULER_H, Math.max(0, sel[0]), hgt - RULER_H);
      ctx.fillRect(sel[1], RULER_H, Math.max(0, w - sel[1]), hgt - RULER_H);
      ctx.fillStyle = cssVar("--accent");
      ctx.fillRect(Math.round(sel[0]), 0, 1, hgt);
      ctx.fillRect(Math.round(sel[1]), 0, 1, hgt);
    }

    // Cursor line and its time
    if (hoverX != null && !drag) {
      ctx.fillStyle = cssVar("--muted");
      ctx.fillRect(Math.round(hoverX), RULER_H, 1, hgt - RULER_H);
      const label = fmtMs((hoverX / w) * span);
      const lw = ctx.measureText(label).width + 8;
      const lx = Math.min(w - lw, Math.max(0, hoverX - lw / 2));
      ctx.fillStyle = cssVar("--accent");
      ctx.beginPath();
      ctx.roundRect(lx, 1, lw, RULER_H - 3, 3);
      ctx.fill();
      ctx.fillStyle = cssVar("--on-accent");
      ctx.fillText(label, lx + 4, RULER_H / 2);
    }
  }

  function updateChip() {
    const r = state.timeRange;
    chip.hidden = !r;
    if (!r) return;
    const base = layout ? layout.t0 : r.from;
    chipText.textContent = `${fmtMs(r.from - base)} – ${fmtMs(r.to - base)} (${fmtMs(r.to - r.from)})`;
  }

  function setRange(r) {
    const same = JSON.stringify(r) === JSON.stringify(state.timeRange);
    state.timeRange = r;
    updateChip();
    if (!same) applyFilters();
    draw();
  }

  function setShown(v, remember = true) {
    shown = v;
    wrap.hidden = !v;
    btn.classList.toggle("active", v);
    btn.setAttribute("aria-pressed", String(v));
    if (!v && state.timeRange) setRange(null); // no hidden time filter
    if (remember) { try { localStorage.setItem("overview", v ? "1" : "0"); } catch { /* storage unavailable */ } }
    draw();
  }

  /* Mouse: drag to pick a range; a plain click or double-click clears it. */
  const localX = (ev) => Math.max(0, Math.min(canvas.clientWidth, ev.clientX - canvas.getBoundingClientRect().left));
  const timeAt = (px) => layout.t0 + (px / layout.width) * layout.span;
  canvas.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0 || !layout) return;
    ev.preventDefault();
    drag = { x0: localX(ev), x1: localX(ev) };
    draw(false);
  });
  window.addEventListener("mousemove", (ev) => {
    if (drag) { drag.x1 = localX(ev); draw(false); return; }
    if (!shown) return;
    const r = canvas.getBoundingClientRect();
    const inside = ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
    const nx = inside ? ev.clientX - r.left : null;
    if (nx !== hoverX) { hoverX = nx; draw(false); }
  });
  window.addEventListener("mouseup", () => {
    if (!drag) return;
    const a = Math.min(drag.x0, drag.x1), b = Math.max(drag.x0, drag.x1);
    drag = null;
    if (b - a < 3 || !layout) setRange(null);
    else setRange({ from: Math.round(timeAt(a)), to: Math.round(timeAt(b)) });
  });
  canvas.addEventListener("dblclick", () => setRange(null));
  $("overview-clear").addEventListener("click", () => setRange(null));
  btn.addEventListener("click", () => setShown(!shown));
  new ResizeObserver(() => draw()).observe(canvas);

  let initial = false;
  try { initial = localStorage.getItem("overview") === "1"; } catch { /* storage unavailable */ }
  setShown(initial, false);

  return {
    draw: () => { draw(); if (state.timeRange) updateChip(); },
    addTiming(t) { if (t) { timings.set(`${t.tabId}:${Math.round(t.nav)}`, t); draw(); } },
    reset(list) {
      timings.clear();
      for (const t of list || []) timings.set(`${t.tabId}:${Math.round(t.nav)}`, t);
      if (state.timeRange) setRange(null);
      draw();
    },
  };
})();
