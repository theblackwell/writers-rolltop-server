#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
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
printf 'Vendored from writers-rolltop-spec at %s on %s (Apache-2.0). Do not edit; run scripts/sync-spec-fixtures.sh.\n' "$rev" "$(date -u +%Y-%m-%d)" > "$dest/SOURCE.txt"
echo "Synced spec fixtures ($rev) into $dest"

mkdir -p "$here/packages/studio/fixtures" "$here/packages/studio/schemas"
cp -R "$spec/fixtures/archives" "$here/packages/studio/fixtures/"
cp "$spec/schemas/archive-v1.schema.json" "$here/packages/studio/schemas/"
printf 'Vendored from writers-rolltop-spec %s (Apache-2.0). Sync via scripts/sync-spec-fixtures.sh.\nLicense and attribution: ../SPEC-LICENSE and ../SPEC-NOTICE.\n' "$rev" > "$here/packages/studio/fixtures/SOURCE.txt"

cp "$spec/LICENSE" "$here/packages/studio/SPEC-LICENSE"
cp "$spec/NOTICE" "$here/packages/studio/SPEC-NOTICE"
