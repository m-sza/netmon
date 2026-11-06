"use strict";

/* Overview: every request that passes the filters on one timeline above the
 * list, like the overview in Chrome's network panel. Bars are colored by
 * request type (the same colors as the type icons): the waiting part pale, the
 * download solid. Blue lines mark DOMContentLoaded and red lines Load of the
 * pages shown. Dragging across it shows only that time range in the list (and
 * zooms the Waterfall column to it); a click or double-click clears it.
 * Loaded after panel.js and uses its state and helpers.
 *
 * Drawing is in two layers so it stays cheap:
 *  - the bars, ruler and markers are drawn into an offscreen canvas, at most
 *    five times a second, and only when requests or filters changed (invalidate());
 *  - hovering and dragging only copy that image and draw the cursor and the
 *    selection on top (paint()), once per animation frame. */
const Overview = (() => {
  const wrap = $("overview");
  const canvas = $("overview-canvas");
  const ctx = canvas.getContext("2d");
  const base = document.createElement("canvas"); // the bars layer
  const bctx = base.getContext("2d");
  const btn = $("btn-overview");
  const chip = $("overview-range");
  const chipText = $("overview-range-text");

  const RULER_H = 16;
  const MAX_LANE_H = 6;          // at the default height; scales with the overview's height
  const BASE_H = 84;
  const MIN_BAR_W = 3;
  const MAX_LANES = 64;          // more overlap than this shares lanes
  const DATA_INTERVAL = 200;     // ms between redraws of the bars: 5 per second

  const timings = new Map();     // "tabId:nav" -> { tabId, nav, dcl, load }
  let shown = false;
  let layout = null;             // { t0, span, width } of the bars layer
  let drag = null;               // { x0, x1 } in CSS pixels while selecting
  let hoverX = null;
  let framePending = false;
  let dataTimer = null;
  let lastData = 0;

  /* Theme colors, read once (reading CSS is slow) and again when the theme changes. */
  let theme = null;
  function readTheme() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    const kinds = new Map();
    const probe = h("span");
    probe.style.display = "none";
    document.body.append(probe);
    for (const k of ["doc", "js", "css", "img", "font", "json", "media", "fetch", "ws", "wasm", "manifest", "ping", "text", "other"]) {
      probe.className = "ic-" + k;
      kinds.set(k, getComputedStyle(probe).color);
    }
    probe.remove();
    theme = {
      kinds, font: `11px ${v("--ui") || "sans-serif"}`,
      chrome: v("--chrome"), border: v("--border"), faint: v("--border-faint"), muted: v("--muted"),
      text: v("--text"), accent: v("--accent"), onAccent: v("--on-accent"), dim: v("--overview-dim"),
      dcl: v("--tg-blue"), load: v("--tg-red"),
    };
  }
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { theme = null; invalidate(true); });

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

  /* Requests or filters changed: redraw the bars, at most every DATA_INTERVAL
   * (now = true skips the wait, for resizing and showing). */
  function invalidate(now = false) {
    if (!shown) return;
    if (now) { clearTimeout(dataTimer); dataTimer = null; drawData(); return; }
    if (dataTimer) return;
    dataTimer = setTimeout(() => { dataTimer = null; drawData(); }, Math.max(0, lastData + DATA_INTERVAL - Date.now()));
  }

  function drawData() {
    lastData = Date.now();
    if (!theme) readTheme();
    const w = canvas.clientWidth, hgt = canvas.clientHeight;
    if (!w || !hgt) return;
    const dpr = window.devicePixelRatio || 1;
    for (const c of [canvas, base]) {
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(hgt * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(hgt * dpr);
      }
    }
    const g = bctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hgt);
    g.font = theme.font;
    g.textBaseline = "middle";

    const now = Date.now();
    const list = [];
    let t0 = Infinity, t1 = -Infinity;
    for (const s of store.values()) {
      if (!matchesFilters(s)) continue;
      list.push(s);
      if (s.start < t0) t0 = s.start;
      const end = s.end ?? now;
      if (end > t1) t1 = end;
    }
    if (!list.length) {
      layout = null;
      g.fillStyle = theme.muted;
      g.fillText("No requests to show.", 8, hgt / 2);
      updateChip();
      paint();
      return;
    }
    list.sort((a, b) => a.start - b.start);
    const span = Math.max(50, (t1 - t0) * 1.02);
    layout = { t0, span, width: w };
    const k = w / span;
    const x = (t) => (t - t0) * k;

    // Ruler and grid
    const step = tickStep(span, w);
    g.fillStyle = theme.chrome;
    g.fillRect(0, 0, w, RULER_H);
    g.fillStyle = theme.border;
    g.fillRect(0, RULER_H - 1, w, 1);
    for (let t = step; t < span; t += step) {
      const px = Math.round(x(t0 + t)) + 0.5;
      g.fillStyle = theme.faint;
      g.fillRect(px, RULER_H, 1, hgt - RULER_H);
      g.fillStyle = theme.border;
      g.fillRect(px, RULER_H - 4, 1, 4);
      const label = fmtTick(t, step);
      const lw = g.measureText(label).width;
      if (px - lw - 3 > 0) { g.fillStyle = theme.muted; g.fillText(label, px - lw - 3, RULER_H / 2); }
    }

    // Bars, packed into lanes: each goes in the first lane free at its start
    // (past MAX_LANES, the lane that frees up first).
    const laneEnds = [];
    const lanes = new Int32Array(list.length);
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const x0 = x(s.start), x1 = Math.max(x0 + MIN_BAR_W, x(s.end ?? now));
      let lane = -1;
      for (let l = 0; l < laneEnds.length; l++) if (laneEnds[l] < x0 - 1) { lane = l; break; }
      if (lane < 0) {
        if (laneEnds.length < MAX_LANES) { lane = laneEnds.length; laneEnds.push(0); }
        else { lane = 0; for (let l = 1; l < laneEnds.length; l++) if (laneEnds[l] < laneEnds[lane]) lane = l; }
      }
      laneEnds[lane] = x1;
      lanes[i] = lane;
    }
    // Bars get thicker as the overview is made taller (and thinner when many overlap).
    const area = hgt - RULER_H - 6;
    const maxLane = MAX_LANE_H * Math.max(1, hgt / BASE_H);
    const laneH = Math.max(1, Math.min(maxLane, area / laneEnds.length));
    const gap = laneH >= 3 ? Math.max(1, Math.round(laneH / 3)) : 0;
    const barH = laneH - gap;
    // Grouped by color and opacity, so the canvas state changes rarely.
    const runs = new Map(); // "kind|alpha" -> flat [x, y, w, ...]
    const push = (key, x0, y, bw) => { let r = runs.get(key); if (!r) runs.set(key, (r = [])); r.push(x0, y, bw); };
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const y = RULER_H + 3 + Math.min(lanes[i] * laneH, area - barH);
      const x0 = x(s.start), xEnd = Math.max(x0 + MIN_BAR_W, x(s.end ?? now));
      const xFirst = s.firstByte ? Math.min(xEnd, Math.max(x0, x(s.firstByte))) : (s.end ? x0 : xEnd);
      const kind = iconKind(s);
      if (xFirst > x0) push(kind + "|0.35", x0, y, xFirst - x0);
      if (xEnd > xFirst) push(kind + (s.state === "pending" ? "|0.6" : "|1"), xFirst, y, Math.max(1, xEnd - xFirst));
    }
    for (const [key, r] of runs) {
      const [kind, alpha] = key.split("|");
      g.fillStyle = theme.kinds.get(kind) || theme.kinds.get("other");
      g.globalAlpha = Number(alpha);
      for (let i = 0; i < r.length; i += 3) g.fillRect(r[i], r[i + 1], r[i + 2], barH);
    }
    g.globalAlpha = 1;

    // Page load markers
    for (const t of timings.values()) {
      if (!timingShown(t)) continue;
      for (const [key, color] of [["dcl", theme.dcl], ["load", theme.load]]) {
        if (!t[key] || t[key] < t0 || t[key] > t0 + span) continue;
        g.fillStyle = color;
        g.fillRect(Math.round(x(t[key])) - 1, RULER_H, 2, hgt - RULER_H);
      }
    }

    updateChip();
    paint();
  }

  /* The visible canvas: the bars layer plus the selection and cursor. Cheap;
   * runs at most once per frame. */
  function paint() {
    if (!shown || framePending) return;
    framePending = true;
    requestAnimationFrame(() => {
      framePending = false;
      const w = canvas.clientWidth, hgt = canvas.clientHeight;
      if (!w || !hgt || !theme) return;
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(base, 0, 0);
      if (!layout) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.font = theme.font;
      ctx.textBaseline = "middle";
      const x = (t) => ((t - layout.t0) / layout.span) * layout.width;

      // Selected range (or the one being dragged): everything else dimmed.
      const sel = drag ? [Math.min(drag.x0, drag.x1), Math.max(drag.x0, drag.x1)]
        : state.timeRange ? [x(state.timeRange.from), x(state.timeRange.to)] : null;
      if (sel) {
        ctx.fillStyle = theme.dim;
        ctx.fillRect(0, RULER_H, Math.max(0, sel[0]), hgt - RULER_H);
        ctx.fillRect(sel[1], RULER_H, Math.max(0, w - sel[1]), hgt - RULER_H);
        ctx.fillStyle = theme.accent;
        ctx.fillRect(Math.round(sel[0]), 0, 1, hgt);
        ctx.fillRect(Math.round(sel[1]), 0, 1, hgt);
      }

      // Cursor line and its time
      if (hoverX != null && !drag) {
        ctx.fillStyle = theme.muted;
        ctx.fillRect(Math.round(hoverX), RULER_H, 1, hgt - RULER_H);
        const label = fmtMs((hoverX / layout.width) * layout.span);
        const lw = ctx.measureText(label).width + 8;
        const lx = Math.min(w - lw, Math.max(0, hoverX - lw / 2));
        ctx.fillStyle = theme.accent;
        ctx.beginPath();
        ctx.roundRect(lx, 1, lw, RULER_H - 3, 3);
        ctx.fill();
        ctx.fillStyle = theme.onAccent;
        ctx.fillText(label, lx + 4, RULER_H / 2);
      }
    });
  }

  function updateChip() {
    const r = state.timeRange;
    chip.hidden = !r;
    if (!r) return;
    const t0 = layout ? layout.t0 : r.from;
    chipText.textContent = `${fmtMs(r.from - t0)} – ${fmtMs(r.to - t0)} (${fmtMs(r.to - r.from)})`;
  }

  function setRange(r) {
    const same = JSON.stringify(r) === JSON.stringify(state.timeRange);
    state.timeRange = r;
    updateChip();
    if (!same) applyFilters();
    paint();
  }

  function setShown(v, remember = true) {
    shown = v;
    wrap.hidden = !v;
    btn.classList.toggle("active", v);
    btn.setAttribute("aria-pressed", String(v));
    if (!v && state.timeRange) setRange(null); // no hidden time filter
    if (remember) { try { localStorage.setItem("overview", v ? "1" : "0"); } catch { /* storage unavailable */ } }
    if (v) invalidate(true);
  }

  /* Mouse: drag to pick a range; a plain click or double-click clears it. */
  const localX = (ev) => Math.max(0, Math.min(canvas.clientWidth, ev.clientX - canvas.getBoundingClientRect().left));
  const timeAt = (px) => layout.t0 + (px / layout.width) * layout.span;
  canvas.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0 || !layout) return;
    ev.preventDefault();
    drag = { x0: localX(ev), x1: localX(ev) };
    paint();
  });
  window.addEventListener("mousemove", (ev) => {
    if (drag) { drag.x1 = localX(ev); paint(); return; }
    if (!shown) return;
    const r = canvas.getBoundingClientRect();
    const inside = ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
    const nx = inside ? ev.clientX - r.left : null;
    if (nx !== hoverX) { hoverX = nx; paint(); }
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

  /* Height: drag the bottom edge; remembered. Double-click restores the default. */
  const DEFAULT_H = 84, MIN_H = 40;
  const maxH = () => Math.max(MIN_H, Math.round(window.innerHeight * 0.6));
  const setHeight = (px, remember) => {
    const hgt = Math.round(Math.min(maxH(), Math.max(MIN_H, px)));
    wrap.style.height = hgt + "px";
    if (remember) { try { localStorage.setItem("overviewHeight", String(hgt)); } catch { /* storage unavailable */ } }
  };
  try { const saved = Number(localStorage.getItem("overviewHeight")); if (saved) setHeight(saved, false); } catch { /* storage unavailable */ }
  const resizer = $("overview-resizer");
  resizer.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const startY = ev.clientY, startH = wrap.offsetHeight;
    resizer.classList.add("dragging");
    document.body.classList.add("row-resizing");
    const move = (e) => setHeight(startH + e.clientY - startY, false);
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      resizer.classList.remove("dragging");
      document.body.classList.remove("row-resizing");
      setHeight(wrap.offsetHeight, true);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
  resizer.addEventListener("dblclick", () => setHeight(DEFAULT_H, true));
  new ResizeObserver(() => invalidate(true)).observe(canvas);

  let initial = false;
  try { initial = localStorage.getItem("overview") === "1"; } catch { /* storage unavailable */ }
  setShown(initial, false);

  return {
    invalidate: () => invalidate(),
    addTiming(t) { if (t) { timings.set(`${t.tabId}:${Math.round(t.nav)}`, t); invalidate(); } },
    reset(list) {
      timings.clear();
      for (const t of list || []) timings.set(`${t.tabId}:${Math.round(t.nav)}`, t);
      if (state.timeRange) setRange(null);
      invalidate();
    },
  };
})();
