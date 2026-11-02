# writers-rolltop-server

The free, self-hosted Writers Rolltop studio: a browser-based writing, story-bible and continuity app, plus an optional sync service, deployed with Docker. It doesn't depend on the paid Apple apps.

> Status: **M0.** The only thing here so far is the **web document adapter prototype**, which proves the browser editor (Tiptap/ProseMirror) can round-trip the canonical document format without semantic loss. The full web studio is M3; self-hosted sync is M4.

## Layout

| Path | What |
|---|---|
| `packages/document-adapter` | Dependency-free TypeScript: canonical document parse/normalize/validate (a second, independent implementation of the spec) and canonical ⇄ Tiptap/ProseMirror JSON |
| `packages/document-adapter/fixtures` | Conformance fixtures vendored from `writers-rolltop-spec` (don't edit) |
| `scripts/sync-spec-fixtures.sh` | Refreshes the vendored fixtures |

## Test

Requires Node.js ≥ 23.6, which runs TypeScript directly by stripping types. Verified with Node 26.10.

```bash
cd packages/document-adapter
node --test test/
```

## Editor schema the adapter expects

Tiptap with Document, Text, Paragraph, Heading (1–6), HardBreak, Bold, Italic and Link. Paragraphs and headings carry a stable `id` attribute (for example via the UniqueID extension). There's also a custom `rolltopAnchor` mark with an `id` attribute and `excludes: ""`. Editor JSON is never stored; only the canonical document is. Unknown editor block types are rejected, never dropped.

## License

Copyright 2026 The Black Well Foundry. Licensed under the [GNU Affero General Public License v3.0 only](LICENSE) (`AGPL-3.0-only`). If you run a modified version for other people over a network, you must offer them its source.

The data format itself is specified separately under Apache-2.0 in `writers-rolltop-spec`, so any software, open or proprietary, can read and write Writers Rolltop projects. The vendored files under `packages/document-adapter/fixtures/` come from that repository and remain under Apache-2.0. The license doesn't grant rights to the "Writers Rolltop" name or logos.

**Contributions:** a contribution policy (with a contributor license agreement) is being prepared. External pull requests can't be accepted until it's published.
