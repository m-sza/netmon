#!/bin/sh
# Publishes a GitHub release of the current commit with both packages:
#   ./release.sh notes.md
# The version comes from the manifests (bump them, commit, then run this).
# Checks first: both manifests agree, the tree is clean and pushed, and the
# tag doesn't exist yet. Builds from the committed files, tags vX.Y.Z, and
# uploads netmon-X.Y.Z-firefox.xpi and netmon-X.Y.Z-chrome.zip.
set -e
cd "$(dirname "$0")"

notes="$1"
[ -f "$notes" ] || { echo "Usage: ./release.sh <release-notes.md>" >&2; exit 1; }

v=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' manifest.json)
vc=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' manifest.chrome.json)
[ -n "$v" ] && [ "$v" = "$vc" ] || { echo "Version mismatch: manifest.json=$v, manifest.chrome.json=$vc" >&2; exit 1; }
tag="v$v"

[ -z "$(git status --porcelain)" ] || { echo "Uncommitted changes; commit them first." >&2; exit 1; }
git fetch -q origin
[ "$(git rev-parse HEAD)" = "$(git rev-parse '@{u}')" ] || { echo "HEAD isn't pushed (or is behind origin); push/pull first." >&2; exit 1; }
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null || git ls-remote --exit-code --tags origin "$tag" >/dev/null 2>&1; then
  echo "Tag $tag already exists; bump the version in both manifests." >&2; exit 1
fi

./build.sh
out=dist/release
rm -rf "$out" && mkdir -p "$out"
cp always-on-netmon.xpi "$out/netmon-$v-firefox.xpi"
cp always-on-netmon-chrome.zip "$out/netmon-$v-chrome.zip"

git tag -a "$tag" -m "netmon $v"
git push -q origin "$tag"
gh release create "$tag" "$out/netmon-$v-firefox.xpi" "$out/netmon-$v-chrome.zip" \
  --title "netmon $v" --notes-file "$notes" --verify-tag
echo "Released $tag"
