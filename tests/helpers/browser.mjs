/* Real Firefox and Chrome with the built extension (./build.sh first; test.sh
 * does). Each test file gets a fresh browser per browser kind, the test site
 * and the panel, opened as a page:
 *
 *   for (const kind of BROWSERS) describe(kind, () => {
 *     const t = useBrowser(kind);           // before/after hooks
 *     it("…", async () => { await t.openSite("/basic/"); … });
 *   });
 *
 * Browsers: FIREFOX (default /opt/firefox-dev/firefox) and CHROME (default
 * /usr/bin/google-chrome); NETMON_BROWSERS=firefox or =chrome runs just one.
 * Firefox needs a build that allows unsigned add-ons (Developer Edition or
 * Nightly). It can only script extension pages with MOZ_REMOTE_ALLOW_SYSTEM_ACCESS,
 * and only those listed as web_accessible_resources, so it gets a copy of the
 * .xpi with panel.html listed. */
import { before, after } from "node:test";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { startSite } from "./site.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CACHE = path.join(ROOT, "tests/.cache");
const PATHS = { firefox: process.env.FIREFOX || "/opt/firefox-dev/firefox", chrome: process.env.CHROME || "/usr/bin/google-chrome" };
const WANTED = (process.env.NETMON_BROWSERS || "firefox,chrome").split(",").map((s) => s.trim());
export const BROWSERS = WANTED.filter((k) => PATHS[k] && existsSync(PATHS[k]));
const UUID = "11111111-2222-3333-4444-555555555555";
const ADDON_ID = JSON.parse(readFileSync(path.join(ROOT, "manifest.json"), "utf8")).browser_specific_settings.gecko.id;

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function firefoxTestXpi() {
  const dir = path.join(CACHE, "ff");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  execFileSync("unzip", ["-q", path.join(ROOT, "always-on-netmon.xpi"), "-d", dir]);
  const mf = path.join(dir, "manifest.json");
  const m = JSON.parse(readFileSync(mf, "utf8"));
  m.web_accessible_resources = ["panel.html"];
  writeFileSync(mf, JSON.stringify(m));
  const xpi = path.join(CACHE, "test.xpi");
  rmSync(xpi, { force: true });
  execFileSync("zip", ["-q", "-r", xpi, "."], { cwd: dir });
  return xpi;
}

export function useBrowser(kind) {
  const t = { kind, copied: [] };
  before(async () => {
    t.site = await startSite();
    if (kind === "firefox") {
      t.browser = await puppeteer.launch({
        browser: "firefox", executablePath: PATHS.firefox, headless: true,
        env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1" },
        extraPrefsFirefox: { "extensions.webextensions.uuids": JSON.stringify({ [ADDON_ID]: UUID }), "xpinstall.signatures.required": false },
      });
      await t.browser.installExtension(firefoxTestXpi());
      t.panelUrl = `moz-extension://${UUID}/panel.html`;
    } else {
      t.browser = await puppeteer.launch({ executablePath: PATHS.chrome, pipe: true, enableExtensions: true, headless: true, args: ["--window-size=1400,900"] });
      const id = await t.browser.installExtension(path.join(ROOT, "dist/chrome"));
      await t.browser.waitForTarget((x) => x.type() === "service_worker" && x.url().includes(id));
      t.panelUrl = `chrome-extension://${id}/panel.html`;
    }
    await wait(1000); // the background registers the page hook
  });
  after(async () => {
    await t.browser?.close();
    t.site?.close();
  });

  // A page of the test site, loaded (path like "/basic/").
  t.openSite = async (p, { settle = 1500 } = {}) => {
    const page = await t.browser.newPage();
    await page.goto(t.site.base + p, { waitUntil: "load" });
    await wait(settle);
    return page;
  };

  // The panel, showing every tab's requests. Opened after the site pages it should show.
  t.openPanel = async () => {
    if (t.panel) await t.panel.close();
    const panel = t.panel = await t.browser.newPage();
    await panel.setViewport({ width: 1400, height: 900 });
    if (t.kind === "firefox") {
      await panel.goto(t.site.base + "/blank");
      await panel.evaluate((u) => { location.href = u; }, t.panelUrl);
    } else await panel.goto(t.panelUrl);
    t.errors = [];
    panel.on("pageerror", (e) => t.errors.push(e.message));
    await t.waitFor(() => typeof store !== "undefined" && typeof state !== "undefined");
    await t.ev(() => {
      state.tabFilter = "all";
      applyFilters();
      window.__copied = [];
      navigator.clipboard.writeText = async (x) => { window.__copied.push(x); };
    });
    return panel;
  };

  // Runs fn(...args) in the panel and returns the result.
  t.ev = (fn, ...args) => t.panel.evaluate(fn, ...args);
  // Polls fn(...args) in the panel until it returns something truthy. Page
  // objects (elements, highlights) count as true: Firefox can't send them back.
  t.waitFor = async (fn, ...args) => {
    const end = Date.now() + 10000;
    let last;
    for (;;) {
      try {
        const handle = await t.panel.evaluateHandle(fn, ...args);
        last = await handle.evaluate((x) => (x !== null && typeof x === "object" && !Array.isArray(x) && Object.getPrototypeOf(x) !== Object.prototype ? true : x));
        await handle.dispose();
      } catch (e) { last = undefined; if (Date.now() > end) throw e; }
      if (last) return last;
      if (Date.now() > end) throw new Error(`Timed out waiting for: ${fn}`);
      await wait(100);
    }
  };
  // Presses a key in the panel, with modifiers held ("Control", "Shift", "Alt").
  t.press = async (key, mods = []) => {
    for (const m of mods) await t.panel.keyboard.down(m);
    await t.panel.keyboard.press(key);
    for (const m of [...mods].reverse()) await t.panel.keyboard.up(m);
    await wait(250);
  };
  // Opens the request whose URL ends with `suffix` on details tab `tab`, once recorded.
  t.select = async (suffix, tab = "headers") => {
    const id = await t.waitFor((x) => { const s = [...store.values()].find((s) => s.url.endsWith(x)); return s && s.id; }, suffix);
    await t.ev((i, tb) => { state.detailsTab = tb; select(i); }, id, tab);
    await t.waitFor((i) => current && current.id === i, id);
    await wait(300);
    return id;
  };
  // What was copied with copy() since the panel opened.
  t.copied = () => t.ev(() => window.__copied);
  return t;
}
