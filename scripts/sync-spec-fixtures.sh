#!/usr/bin/env bash
# Copies Spec/fixtures and Spec/schemas into the document-adapter test folder.
# Idempotent. Never hand-edit the vendored output.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
spec="${SPEC_DIR:-$here/../../Spec}"
dest="$here/../packages/document-adapter/test/spec"
commit="$(git -C "$spec" rev-parse HEAD)"
rm -rf "$dest"
mkdir -p "$dest"
cp -R "$spec/fixtures" "$dest/fixtures"
cp -R "$spec/schemas" "$dest/schemas"
find "$dest" -name .DS_Store -delete
printf '%s\n' "$commit" > "$dest/SOURCE.txt"
echo "Synced Spec fixtures from $commit"
