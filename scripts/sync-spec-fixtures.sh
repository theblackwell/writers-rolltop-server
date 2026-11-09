#!/usr/bin/env bash
# Copies Spec/fixtures and Spec/schemas into the document-adapter test folder, and the archive schema
# into packages/archive/src (the archive reader loads it at run time; a test fails if it drifts).
# Idempotent. Never hand-edit the vendored output.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
spec="${SPEC_DIR:-$here/../../Spec}"
dest="$here/../packages/document-adapter/test/spec"
[ -d "$spec/fixtures" ] || { echo "Spec not found at $spec" >&2; exit 1; }
[ -z "$(git -C "$spec" status --porcelain)" ] || { echo "Spec has uncommitted changes; commit them before vendoring" >&2; exit 1; }
commit="$(git -C "$spec" rev-parse HEAD)"
rm -rf "$dest"
mkdir -p "$dest"
cp -R "$spec/fixtures" "$dest/fixtures"
cp -R "$spec/schemas" "$dest/schemas"
cp "$spec/schemas/archive-v1.schema.json" "$here/../packages/archive/src/archive-v1.schema.json"
find "$dest" -name .DS_Store -delete
printf '%s\n' "$commit" > "$dest/SOURCE.txt"
echo "Synced Spec fixtures from $commit"
