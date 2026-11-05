# netmon — Always-On Network Monitor

A browser extension for Firefox and Chrome that records network traffic in the background, all the time, and shows it in a DevTools-style network panel in its own window. No need to open DevTools before the request happens.

## Features

- Records every tab continuously; view one tab, the current tab or all tabs
- Request/response headers, bodies (collapsible JSON tree, syntax highlighting), cookies, timings
- TLS / security details per request
- WebSocket traffic, including sending and editing-and-resending messages; HAR export includes WebSocket frames
- Resend / edit and resend requests
- Copy as cURL, fetch, Python `requests` and Python `curl_cffi`
- DevTools-compatible filter language (`-mime-type:`, `transferred-larger-than:`, `is:blocked`, `size-larger-than:` …) with a rules editor
- Shows which extension blocked a request (e.g. "Blocked by uBlock Origin")
- Initiator tree view (which script/stylesheet loaded what)
- Offline preview of HTML (using already-recorded resources), images, SVGs and fonts
- URL blocking

## Build

```sh
./build.sh
```

Produces:

- `always-on-netmon.xpi` — Firefox (Manifest V2)
- `dist/chrome/` and `always-on-netmon-chrome.zip` — Chrome (Manifest V3)

## Install

**Firefox:** `about:addons` → gear icon → *Install Add-on From File…* → `always-on-netmon.xpi` (unsigned builds need Firefox Developer Edition/Nightly with `xpinstall.signatures.required` set to `false`, or load it temporarily via `about:debugging`).

**Chrome:** `chrome://extensions` → enable *Developer mode* → *Load unpacked* → `dist/chrome`.

In Chrome, response bodies, TLS details and initiators come from the `chrome.debugger` API, so Chrome shows a "started debugging this browser" bar while *Capture bodies* is on.

## Optional: toolbar-free window in Firefox

`userChrome-netmon.css` hides Firefox's toolbars in the monitor window. Copy it into your profile's `chrome/userChrome.css` and set `toolkit.legacyUserProfileCustomizations.stylesheets` to `true`.

## Credits

Request type icons are from Chromium DevTools (BSD license, see `LICENSE-chromium-devtools.txt`).
