# writers-rolltop-server

The free, self-hosted Writers Rolltop studio: a browser-based writing, story-bible and continuity app, plus an optional sync service, deployed with Docker. It doesn't depend on the paid Apple apps.

> Status: **M3 in development.** The M0 document adapter is joined by the first web manuscript slice. See [setup](docs/SETUP.md) and [M3 plan](docs/M3-PLAN.md). Full web parity is unfinished; device synchronization is M4.

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
node --test "test/*.test.ts"
```

## Editor schema the adapter expects

Tiptap with Document, Text, Paragraph, Heading (1–6), HardBreak, HorizontalRule (scene breaks), Blockquote, BulletList, OrderedList, ListItem, Bold, Italic, Underline, Link and TextAlign (left/center/right on paragraphs and headings). Paragraphs, headings and horizontal rules carry a stable `id` attribute (for example via the UniqueID extension). There's also a custom `rolltopAnchor` mark with an `id` attribute and `excludes: ""`. Canonical blocks are flat, so the adapter groups consecutive quoted blocks into one blockquote and rebuilds nested lists. Nesting the canonical format can't express (a list inside a quote, several paragraphs in one list item) is repaired without losing text. Editor JSON is never stored; only the canonical document is. Unknown editor block types are rejected, never dropped.

## License

Copyright 2026 The Black Well Foundry. Licensed under the [GNU Affero General Public License v3.0 only](LICENSE) (`AGPL-3.0-only`). If you run a modified version for other people over a network, you must offer them its source.

The data format itself is specified separately under Apache-2.0 in `writers-rolltop-spec`, so any software, open or proprietary, can read and write Writers Rolltop projects. The vendored files under `packages/document-adapter/fixtures/` come from that repository and remain under Apache-2.0. The license doesn't grant rights to the "Writers Rolltop" name or logos.

**Contributions:** a contribution policy (with a contributor license agreement) is being prepared. External pull requests can't be accepted until it's published.

## M3 development (2026-11-03)

The first manuscript slice is now under development: React/Tiptap web workspace,
PostgreSQL API, single-owner login, canonical JSON saves with revision-conflict
protection, and OCI containers for **Docker or Podman**. This is not a complete M3
release; bible/continuity, attachments and portable archives remain required.

Start with [container setup](docs/SETUP.md), [implementation plan](docs/M3-PLAN.md)
and `npm run check`, `npm test`, `npm run build` from this repository's root.
The existing document adapter stays independent and retains its conformance tests.
