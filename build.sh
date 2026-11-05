#!/bin/sh
# Builds both browsers' packages from the same sources:
#   always-on-netmon.xpi         Firefox (Manifest V2, manifest.json)
#   dist/chrome/                 Chrome, unpacked (Manifest V3, manifest.chrome.json)
#   always-on-netmon-chrome.zip  Chrome, the same as a zip
set -e
cd "$(dirname "$0")"

SHARED="compat.js common.js background.js panel.js actions.js syntax.js jsontree.js filters.js preview.js fontinfo.js
  page-hook.js ws-relay.js panel.html panel.css LICENSE-chromium-devtools.txt"

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
