#!/bin/sh
# Runs netmon's tests. Builds first, so the browser tests use the current code.
#   ./test.sh            unit tests, then browser tests in Firefox and Chrome
#   ./test.sh unit       unit tests only (a second, no browser)
#   ./test.sh firefox    unit tests and Firefox only (also: chrome)
#   ./test.sh <file>...  just those test files, e.g. tests/browser/search.test.mjs
# Browsers: FIREFOX (default /opt/firefox-dev/firefox, must allow unsigned
# add-ons: Developer Edition or Nightly) and CHROME (default /usr/bin/google-chrome).
# Test tools: npm install (once).
set -e
cd "$(dirname "$0")"
[ -d node_modules/puppeteer-core ] || { echo "Run npm install first (test tools)." >&2; exit 1; }

case "$1" in
  unit) exec node --test tests/unit/*.test.mjs ;;
  firefox|chrome) export NETMON_BROWSERS="$1"; set -- ;;
esac

./build.sh >/dev/null
if [ $# -gt 0 ]; then exec node --test --test-concurrency=1 "$@"; fi
node --test tests/unit/*.test.mjs
# One file at a time: each starts its own browsers.
node --test --test-concurrency=1 tests/browser/*.test.mjs
