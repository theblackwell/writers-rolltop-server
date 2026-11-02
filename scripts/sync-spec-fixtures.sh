#!/bin/sh
# Vendors document conformance fixtures from writers-rolltop-spec.
# Usage: scripts/sync-spec-fixtures.sh [path-to-spec-checkout]   (default: ../Spec)
set -eu
here="$(cd "$(dirname "$0")/.." && pwd)"
spec="${1:-$here/../Spec}"
dest="$here/packages/document-adapter/fixtures"
rm -rf "$dest"
mkdir -p "$dest"
cp -R "$spec/fixtures/documents" "$dest/documents"
rev="$(git -C "$spec" rev-parse --short HEAD 2>/dev/null || echo uncommitted)"
printf 'Vendored from writers-rolltop-spec at %s on %s. Do not edit; run scripts/sync-spec-fixtures.sh.\n' "$rev" "$(date -u +%Y-%m-%d)" > "$dest/SOURCE.txt"
echo "Synced spec fixtures ($rev) into $dest"
