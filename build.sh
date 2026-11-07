#!/bin/sh
# Builds both browsers' packages from the same sources:
#   always-on-netmon.xpi         Firefox (Manifest V2, manifest.json)
#   dist/chrome/                 Chrome, unpacked (Manifest V3, manifest.chrome.json)
#   always-on-netmon-chrome.zip  Chrome, the same as a zip
# With --install, also updates the add-on in the running Firefox (see the end).
set -e
cd "$(dirname "$0")"

SHARED="compat.js common.js background.js panel.js overview.js actions.js syntax.js jsontree.js codetree.js endpoints.js format-worker.js beautifier.js filters.js preview.js fontinfo.js
  page-hook.js ws-relay.js page-timing.js panel.html panel.css LICENSE-chromium-devtools.txt LICENSE-js-beautify.txt"

for f in $SHARED manifest.json manifest.chrome.json sw.js icons/icon.svg icons/icon-16.png icons/icon-32.png icons/icon-48.png icons/icon-128.png; do
  [ -f "$f" ] || { echo "Missing $f; not building." >&2; exit 1; }
done

rm -f always-on-netmon.xpi
zip -q -X always-on-netmon.xpi manifest.json $SHARED icons/icon.svg
echo "Built $(pwd)/always-on-netmon.xpi"

rm -rf dist/chrome always-on-netmon-chrome.zip
mkdir -p dist/chrome/icons
cp $SHARED sw.js dist/chrome/
cp icons/icon-16.png icons/icon-32.png icons/icon-48.png icons/icon-128.png dist/chrome/icons/
cp manifest.chrome.json dist/chrome/manifest.json
(cd dist/chrome && zip -q -r -X ../../always-on-netmon-chrome.zip .)
echo "Built $(pwd)/dist/chrome (load unpacked) and $(pwd)/always-on-netmon-chrome.zip"

# ./build.sh --install: hand the new .xpi to the running Firefox, which updates
# the installed add-on in place (settings kept). Set FIREFOX to pick the binary.
if [ "$1" = "--install" ]; then
  FF="${FIREFOX:-}"
  if [ -z "$FF" ]; then
    for c in firefox-developer-edition /opt/firefox-dev/firefox firefox-nightly firefox; do
      if command -v "$c" >/dev/null 2>&1; then FF="$c"; break; fi
    done
  fi
  [ -n "$FF" ] || { echo "No Firefox found; set FIREFOX=/path/to/firefox." >&2; exit 1; }
  "$FF" "$(pwd)/always-on-netmon.xpi" >/dev/null 2>&1 &
  echo "Sent the .xpi to $FF."
  # Firefox may ask first: check that the installed copy in the profile is this build.
  id=$(sed -n 's/^ *"id": *"\([^"]*@[^"]*\)".*/\1/p' manifest.json | head -1)
  installed=$(ls -t "$HOME"/.config/mozilla/firefox/*/extensions/"$id".xpi "$HOME"/.mozilla/firefox/*/extensions/"$id".xpi 2>/dev/null | head -1)
  if [ -z "$installed" ]; then
    echo "Couldn't find the installed add-on in a Firefox profile to check. Confirm the prompt if Firefox shows one."
  else
    i=0
    while ! cmp -s "$installed" always-on-netmon.xpi && [ $i -lt 30 ]; do
      [ $i -eq 3 ] && echo "Waiting for Firefox: confirm its install prompt (Add)..."
      sleep 1; i=$((i + 1))
    done
    if cmp -s "$installed" always-on-netmon.xpi; then echo "Installed in Firefox ($installed)."
    else echo "NOT installed yet: Firefox is probably showing an install prompt. Confirm it, or run ./build.sh --install again." >&2; exit 2
    fi
  fi
fi
