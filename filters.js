"use strict";

/* The request filter language of Firefox DevTools' network panel, matched
 * against our request summaries (see devtools/client/netmonitor/src/utils/
 * filter-text-utils.js), so filters copied from DevTools behave the same.
 * Additions: is:blocked, is:error, is:graphql, operation: (GraphQL operation name or type), size-larger-than: (a clearer name for
 * larger-than:, which compares the content size, so cached responses count),
 * and /regex/ as a URL regex (the monitor's older syntax). A token whose key isn't a filter key is plain URL text, as in
 * DevTools. */
const NetFilter = (() => {
  const FLAGS = [
    "status-code", "method", "domain", "url", "protocol", "scheme", "remote-ip", "cause", "initiator",
    "transferred", "size", "priority", "set-cookie-domain", "set-cookie-name", "set-cookie-value",
    "mime-type", "larger-than", "transferred-larger-than", "is", "has-response-header", "regexp",
    "size-larger-than", "operation",
  ];
  const SIZE_FLAGS = new Set(["size", "transferred", "larger-than", "transferred-larger-than", "size-larger-than"]);
  const STATUS_CODES = "100 101 103 200 201 202 203 204 205 206 300 301 302 303 304 307 308 400 401 403 404 405 406 407 408 409 410 411 412 413 414 415 416 417 418 422 425 426 428 429 431 451 500 501 502 503 504 505 511".split(" ");

  // "10k" -> 10000, "2m" -> 2000000 (DevTools uses powers of 1000).
  function parseSize(v) {
    let mult = 1;
    if (v.endsWith("k")) { mult = 1000; v = v.slice(0, -1); }
    else if (v.endsWith("m")) { mult = 1000 * 1000; v = v.slice(0, -1); }
    const n = Number(v);
    return Number.isNaN(n) ? null : n * mult;
  }

  function parseToken(raw) {
    const re = /^(-?)\/(.+)\/$/.exec(raw);
    if (re) {
      try { return { raw, kind: "regex", re: new RegExp(re[2], "i"), negative: !!re[1] }; } catch { /* not a valid regex: URL text */ }
    }
    const colon = raw.indexOf(":");
    if (colon < 0) {
      const negative = raw.startsWith("-") && raw.length > 1;
      const body = negative ? raw.slice(1) : raw;
      // A bare number that starts a known status code is a status-code filter.
      if (/^\d+$/.test(body) && STATUS_CODES.some((c) => c.startsWith(body))) {
        return { raw, kind: "flag", key: "status-code", value: body, negative };
      }
      return { raw, kind: "text", value: body.toLowerCase(), negative };
    }
    let key = raw.slice(0, colon);
    const negative = key.startsWith("-");
    if (negative) key = key.slice(1);
    if (!FLAGS.includes(key)) {
      const body = raw.startsWith("-") && raw.length > 1 ? raw.slice(1) : raw;
      return { raw, kind: "text", value: body.toLowerCase(), negative: raw.startsWith("-") && raw.length > 1, unknownKey: key };
    }
    let value = raw.slice(colon + 1);
    if (key === "regexp") { /* case kept */ }
    else if (SIZE_FLAGS.has(key)) value = parseSize(value.toLowerCase());
    else value = value.toLowerCase();
    return { raw, kind: "flag", key, value, negative };
  }

  function parse(text) {
    return String(text || "").split(/\s+/).filter(Boolean).map(parseToken);
  }

  const near = (value, size) => size != null && value >= size - size / 10 && value <= size + size / 10;

  /* s: request summary. h: helpers from the panel —
   *   mime(s), cause(s), initiator(s), blocked(s), unicodeUrl(url) */
  function matchToken(t, s, h) {
    if (t.kind === "text" || t.kind === "regex") {
      const hit = t.kind === "regex" ? t.re.test(s.url) : h.unicodeUrl(s.url).toLowerCase().includes(t.value);
      return t.negative ? !hit : hit;
    }
    const { key, value } = t;
    if (value == null) return false;               // e.g. size:abc
    if (typeof value === "string" && !value) return true; // "domain:" alone shows everything
    // Parsed only for the keys that need it (domain, scheme, set-cookie-domain).
    let parsed;
    const getUrl = () => (parsed !== undefined ? parsed : (parsed = (() => { try { return new URL(s.url); } catch { return null; } })()));
    let m;
    switch (key) {
      case "status-code": m = s.status != null && String(s.status).startsWith(value); break;
      case "method": m = s.method.toLowerCase() === value; break;
      case "protocol": m = (s.httpVersion || "").toLowerCase().includes(value); break;
      case "domain": { const url = getUrl(); m = !!url && url.host.toLowerCase().includes(value); break; }
      case "scheme": { const url = getUrl(); m = !!url && url.protocol.slice(0, -1) === value; break; }
      case "remote-ip": m = (s.ip || "").toLowerCase().includes(value); break;
      case "cause": m = h.cause(s).toLowerCase().includes(value); break;
      case "initiator": m = h.initiator(s).toLowerCase().includes(value); break;
      case "transferred": m = !s.fromCache && near(value, s.transferred); break;
      case "size": m = near(value, s.size); break;
      case "larger-than":
      case "size-larger-than": m = (s.size ?? 0) > value; break;
      case "transferred-larger-than": m = !s.fromCache && (s.transferred ?? 0) > value; break;
      case "mime-type": { const mime = h.mime(s); m = !!mime && mime.includes(value); break; }
      case "has-response-header": m = (s.responseHeaderNames || []).includes(value); break;
      case "set-cookie-name": m = (s.setCookies || []).some((c) => c.name.toLowerCase().includes(value)); break;
      case "set-cookie-value": m = (s.setCookies || []).some((c) => c.value.toLowerCase().includes(value)); break;
      case "set-cookie-domain": m = (s.setCookies || []).some((c) => (c.domain || (getUrl() ? getUrl().host : "")).includes(value)); break;
      // GraphQL operations: their name, or their type (query, mutation, subscription).
      case "operation": m = (s.gql || []).some((o) => (o.name || "").toLowerCase().includes(value) || o.type === value); break;
      case "regexp": try { m = new RegExp(value).test(s.url); } catch { m = false; } break;
      case "priority": m = false; break;           // Firefox doesn't give extensions request priorities
      case "is":
        if (value === "from-cache" || value === "cached") m = !!s.fromCache || s.status === 304;
        else if (value === "running") m = s.status == null && s.state === "pending";
        else if (value === "blocked") m = h.blocked(s);
        else if (value === "error") m = s.state === "error" || (s.status ?? 0) >= 400;
        else if (value === "graphql") m = !!s.gql;
        else m = true;
        break;
      default: m = true;                            // "url:" has no matcher in DevTools either
    }
    return t.negative ? !m : m;
  }

  function matchAll(tokens, s, h) {
    for (const t of tokens) if (!matchToken(t, s, h)) return false;
    return true;
  }

  const fmtSize = (n) => (n >= 1e6 ? `${n / 1e6} MB` : n >= 1e3 ? `${n / 1e3} kB` : `${n} B`);
  const LABELS = {
    "status-code": (v) => `status starts with ${v}`,
    method: (v) => `method is ${v.toUpperCase()}`,
    protocol: (v) => `protocol contains “${v}”`,
    domain: (v) => `domain contains “${v}”`,
    scheme: (v) => `scheme is ${v}`,
    "remote-ip": (v) => `remote IP contains “${v}”`,
    cause: (v) => `cause contains “${v}”`,
    initiator: (v) => `initiator contains “${v}”`,
    transferred: (v) => `transferred about ${fmtSize(v)} (±10%)`,
    size: (v) => `size about ${fmtSize(v)} (±10%)`,
    "larger-than": (v) => `size over ${fmtSize(v)} (cached responses count)`,
    "size-larger-than": (v) => `size over ${fmtSize(v)} (cached responses count)`,
    "transferred-larger-than": (v) => `transferred over ${fmtSize(v)} (not from cache)`,
    "mime-type": (v) => `MIME type contains “${v}”`,
    "has-response-header": (v) => `response has a “${v}” header`,
    "set-cookie-name": (v) => `sets a cookie named like “${v}”`,
    "set-cookie-value": (v) => `sets a cookie with value like “${v}”`,
    "set-cookie-domain": (v) => `sets a cookie for a domain like “${v}”`,
    regexp: (v) => `URL matches /${v}/`,
    priority: () => "priority (Firefox doesn't tell extensions request priorities)",
    is: (v) => ({ running: "still running", cached: "served from cache", "from-cache": "served from cache", blocked: "blocked", error: "failed or 4xx/5xx" }[v] || `is:${v} (no effect)`),
    url: () => "url: (no effect, as in DevTools)",
  };

  // Plain-English summary of one rule, e.g. "Hide: MIME type contains “text/css”".
  function describe(raw) {
    const t = parseToken(raw);
    const verb = t.negative ? "Hide" : "Only";
    if (t.kind === "regex") return { text: `${verb}: URL matches ${raw.replace(/^-/, "")}`, warn: false };
    if (t.kind === "text") {
      const note = t.unknownKey ? ` (“${t.unknownKey}” isn't a filter key, so this is URL text)` : "";
      return { text: `${verb}: URL contains “${t.value}”${note}`, warn: !!t.unknownKey };
    }
    if (t.value == null) return { text: `“${raw}” has an invalid size and matches nothing`, warn: true };
    if (typeof t.value === "string" && !t.value) return { text: `${t.key}: with no value matches everything`, warn: true };
    return { text: `${verb}: ${LABELS[t.key](t.value)}`, warn: t.key === "priority" || (t.key === "is" && LABELS.is(t.value).startsWith("is:")) };
  }

  return { parse, matchAll, describe, FLAGS };
})();
