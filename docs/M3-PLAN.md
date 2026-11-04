# M3: self-hosted studio

Owner authorized M3 on 2026-11-03, in parallel with Claude's M2 work.
Codex edits Server only; Apple belongs to Claude. No format changes are needed for this first slice.

## Delivery sequence

1. **Manuscript foundation (implemented; full M3 acceptance pending):** React/TypeScript and Tiptap using the existing adapter; same-origin Node API; PostgreSQL migrations, single-owner login, libraries/books/binder, revision-checked autosave, version history/recovery, Desk/Writing/Focus, Docker/Podman Compose, setup guide. Every product action lives in the window. Simplified walnut/parchment styling follows Mac terminology.
2. **Library editing (rename/move/Trash implemented; remaining items next):** metadata/goals, parts/chapters/scenes, ordering/moving, tombstones/restore and backup-protected purge, search, notes, references, persistent layout preferences.
3. **Bible/continuity parity:** all entry types/fields/templates, shared scopes/book overrides, relationships, facts/questions, timeline/state changes, who-knows-what and intentional warning dismissals. Mirror Spec semantics and Apple behavior; coordinate additive format changes.
4. **Portable libraries:** hostile-archive checks, import preview/new-library default, checksums, attachments, optional-field preservation, Mac↔web fixture round trips. Never ship partial/lossy import or export.
5. **M3 acceptance:** setup on Docker/PostgreSQL, authentication/security review, backup/restore test, browser/accessibility/responsive checks, 100k-word performance, complete compatibility fixtures and owner review. M4 device sync stays separate. Publishing manuscript exports are M5.

## Architecture

- `packages/document-adapter`: existing canonical document parser/normalizer and Tiptap adapter; keep its conformance tests.
- `packages/studio`: Node HTTP API and PostgreSQL repository. JSONB retains canonical records; relational columns enforce hierarchy and ownership. Scene documents are canonical JSON, never Tiptap JSON. Append-only revisions and compare-and-swap protect stale saves.
- `apps/web`: React/Vite SPA and Tiptap editor. All requests are same-origin; API and static assets share one service in production. No external fonts, telemetry, paid services or native-app dependency.
- First deployment is single-owner. Password is supplied as an scrypt hash; random session tokens are hashed in PostgreSQL. Cookies are HttpOnly/SameSite Strict; writes require the configured Origin. HTTPS is required outside loopback. PostgreSQL is never published from Compose.
- Tests use isolated PGlite PostgreSQL instances and temp data; real PostgreSQL/Docker smoke testing is separately required. Podman Desktop became available during development; real PostgreSQL/container checks are run separately from PGlite tests.

## Current limits

This is the beginning of M3, not a complete web edition. Features in later slices must be labelled unavailable; no fake archive buttons or lossy text imports. Browser drafts and server revisions are separate from the future M4 sync protocol. No claim of seamless simultaneous editing or end-to-end encryption.

## Sections (one per session, owner rule 2026-11-04)

- **L1 — Book metadata and goal settings: implemented 2026-11-04.** Title, subtitle, author, description, language, word goal and target date; validated partial updates preserve unknown fields. Goal settings shown in manuscript navigation. Browser visual QA and live manuscript goal-progress totals remain follow-up work.
- **L2a — Saved manuscript search: implemented 2026-11-04.** In-window search of scene/front/back matter titles and canonical prose, excerpts and navigation; literal case-insensitive matching, reading order, 50-item limit, Trash excluded. Saves current editor before opening search. Browser visual QA, chapter/part titles and Apple-style prefix/relevance ranking remain follow-up work.
- **L2b — Quick notes: implemented 2026-11-04.** Plain-text notes pinned to book/manuscript nodes; editing, re-pin, reversible Trash and stale-write protection. Schema v2 adds notes without changing the archive format. Browser visual QA and real PostgreSQL smoke remain follow-up checks.
- **L2c — References: implemented 2026-11-04.** Book-scoped bible entry creation (name/type/summary), saved passage anchors, reference linking/navigation and reversible reference Trash. Schema v3 adds entries/references; validates same-book live targets, saved revision/anchor and stale updates. Full bible editing/shared scopes remain delivery step 3. Browser visual QA and real PostgreSQL smoke remain follow-up checks.
- **L3 — Remaining formatting, goal-progress totals and layout preferences.**
- **L4 — Backup-protected permanent deletion.**

Continue delivery steps 3–5 above in separately sized sections after library editing.
