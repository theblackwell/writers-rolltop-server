# M3 development checkpoint — 2026-11-04

**Status: manuscript foundation and library editing L1–L4 implemented, including backup-protected permanent deletion. M3 is not complete or signed off.**

Latest B1 verification: 40 tests, TypeScript/build, Podman/PostgreSQL purge-failure/restart/restore and desktop book-deletion QA pass; see the L4b checkpoint below. The original foundation verification table and older dated checkpoints are retained as history.
Owner authorized Codex to work in Server in parallel with Claude's M2 Apple work.
No Apple or Spec files were changed for this slice. The owner authorized a Server-only
checkpoint commit after verification. No push was requested.

## What works

- React/TypeScript/Vite workspace with simplified walnut/parchment presentation, Projects and Manuscript, Desk/Writing/Focus. All current actions are in the browser window. Focus hides the formatting strip under Writing tools.
- Single-owner login using an environment-provided scrypt hash. Session tokens are random, hashed in PostgreSQL, HttpOnly/SameSite Strict, Secure for HTTPS. Same-origin checks on writes, request size limit, generic server errors and login throttling. HTTPS is required for non-loopback browser origins.
- Versioned/transactional PostgreSQL schema; libraries, books, chapters and scenes, with hierarchy validation and stable canonical UUIDs/order keys. The binder now exposes parts, chapters, scenes and front/back matter.
- Actual Tiptap editor restricted to canonical v1 constructs; the existing adapter is reused. Current toolbar has basic marks, paragraph/headings, lists/quotes/scene breaks, save and history. Full formatting controls remain later work.
- Autosave uses expected revision and append-only saved versions. Stale saves are refused, with browser-draft download and server-version comparison. Restoring a saved version creates another revision.
- Browser recovery drafts use separate keys per editor instance, so one tab cannot clear another's draft. Invalid/newer drafts are retained. Browser storage can be unavailable/full: the interface then warns and keeps the in-memory draft. The UI offers the newest recovered copy first; other copies remain stored. This is not yet full offline application support or M4 synchronization.
- OCI multi-stage image, unprivileged/read-only app container, Docker/Podman Compose, private PostgreSQL service and persistent named volume. No real library/data is seeded into a normal deployment.

## Verification

| Check                    | Result                                                                                                                                                                                                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`          | Pass                                                                                                                                                                                                                                                                              |
| `npm test`               | **26 pass**: original adapter/Tiptap fixtures, SQL hierarchy/CAS/history, authenticated API/origin/expiry/logout, rollback, newer schemas, 100k-word save/load, isolated drafts, fractional ordering, rename/move/Trash preservation, restored ancestors and binder reading order |
| `npm run build`          | Pass; current JS bundle about 675 kB / 213 kB gzip. Vite reports its >500 kB advisory; code splitting is future performance work.                                                                                                                                                 |
| Podman OCI/Compose smoke | **Pass**, real PostgreSQL 17: image build, startup, login, create/save scene, stale-save refusal, rename/move/chapter and book Trash/restore, restart persistence, built page/assets; disposable project and volume removed afterwards                                            |
| Browser on scratch data  | Login, first scene selection, editing/save, scene switching/reload, history preview/restore, Desk/Writing/Focus, two-tab conflict retains draft and shows server comparison                                                                                                       |
| Visual review            | Desktop manuscript at 1280 px, narrow Focus view; screenshots in `docs/screenshots/`. Phone/tablet and full keyboard/screen-reader review remain open.                                                                                                                            |
| Docker Engine            | Not run separately. Docker Compose provider was used against the Podman engine.                                                                                                                                                                                                   |

Scratch preview: `node scripts/preview-scratch.ts`, http://localhost:4318,
password `scratch-preview-password`. Its in-memory sample disappears on exit.
Production setup and backup/restore commands: [SETUP.md](SETUP.md).

## Next work / acceptance gates

1. Library editing L1–L4 is implemented. Finish broader browser QA for metadata/search/notes/references/formatting/goals, responsive/accessibility checks and search-parity follow-ups described in the section checkpoints.
2. Bible and continuity parity with Spec/M1: scopes, all field kinds/templates/overrides, relationships, facts/questions, knowledge, timeline/state changes and warning dismissal.
3. Attachments and safe `.rolltop` archives: checksums/path/size limits, staging, preview, required optional-field preservation and cross-edition round trips. **No import/export is offered yet; never substitute a lossy text conversion.**
4. Durable offline application/recovery, additional browser concurrency/failure checks, 100k-word browser performance, responsive/accessibility pass, Docker Engine smoke, restore a PostgreSQL backup into a scratch installation, deployment/security review, screenshots and owner review.

M4 device sync and M5 publishing exports remain separate. Don't claim M3 complete from this checkpoint.

## Manuscript-management checkpoint (recovered after crash, 2026-11-03)

- On recovery, the uncommitted API and 24 passing tests were intact; the UI was still unfinished. Completed the UI and added binder/API checks: **26 tests pass**, TypeScript and production build pass.
- Books and every manuscript kind have visible Actions controls for rename and Trash. Manuscript items also have Move Up/Down and Move To with destination/position selectors. Scenes move between chapters; chapters move between root/parts. The binder follows hierarchy order, not a flat sort of every node.
- A move normally rewrites one fractional order key. Equal imported keys are repaired only when they prevent insertion. Existing keys remain valid; no archive/schema-format changes. New items append after moves without key collisions.
- Trash sets tombstones and preserves all documents/revisions. Each trash action uses a unique timestamp within its book; restore brings back its group and necessary ancestors, while children trashed separately stay trashed. Book Trash is on Projects; manuscript Trash is in the binder. No permanent-delete control is offered yet.
- Structural mutations and scene saves take the same book lock; stale saves after a trash operation are rejected with the draft retained. Record edits preserve unknown optional data. No database migration was required (SQL schema remains v1).
- Browser QA on disposable sample data: book/scene rename, move scene to another chapter, chapter Trash/restore, create a part, move chapter into part, book Trash/restore, reload hierarchy, Move Up, text unchanged (84 words). Screenshot: `docs/screenshots/m3-management.png`.
- Real Podman/PostgreSQL smoke extended and passed: rename, move, Trash/restore, revision count unchanged, and saved text survives container restart. Scratch containers/volume removed after verification.
- Owner authorized a Server-only checkpoint commit for these follow-up changes on top of `26f6e40`. No push requested. Apple/Spec and owner libraries remain untouched.

## Book metadata and goals section — 2026-11-04

- Implemented book details form reachable from Library in every layout and from the manuscript binder: title, subtitle, author, description, language, word goal and target date. Empty optional fields remove the value.
- New same-origin authenticated `PUT /api/books/:id/details` validates an allowlisted partial patch, positive safe-integer goals, language tags and real calendar dates. Serializes on the existing book lock, refuses trashed books and preserves unknown fields/documents/revisions. No migration or Spec change.
- Verification: TypeScript and production build pass; **27/27 tests pass**, including persistence, invalid goals/dates, optional-field clearing, unknown-field preservation, unchanged manuscript and refusal in Trash. HTTP test needed loopback permission outside the sandbox. Existing Vite bundle-size advisory remains.
- Browser visual QA and real PostgreSQL smoke were not repeated for this section. Goal-progress totals remain to implement; this section covers editable goal settings.
- Next session: L2, search, notes and references (see plan). Apple/Spec and owner libraries untouched. End-of-section commit authorized by standing owner instruction; no push.

## L2a — Saved manuscript search — 2026-11-04

- Split L2 into L2a search, L2b notes and L2c references to keep sessions small. References require story-bible entry storage, which is not implemented yet; no placeholder targets or format changes introduced.
- Library → Search Manuscript is reachable in every layout for an open book. Flushes the editor first and refuses to proceed if the save fails. Searches saved scene/front/back matter titles and canonical text, including marked runs, with plain-text excerpts and buttons opening the matching item. No prose/anchor/revision mutations.
- Authenticated `GET /api/books/:id/search?q=...`: bounded 1–200 character literal case-insensitive query, reading-order results capped at 50 with a truncation indicator; book isolation and ancestor/book Trash filtering. Uses existing schema v1, transaction and book lock.
- Validation: **28/28 tests pass**, TypeScript and production build pass; diff whitespace check clean. Tests cover marked text, CJK, literal SQL wildcard characters, title hits, empty/long query rejection, book isolation, Trash/restore, unchanged documents/revisions and authenticated HTTP routing. Full suite required loopback permission for the disposable HTTP server. Existing Vite bundle-size advisory remains.
- Limits: browser visual QA and real PostgreSQL smoke not repeated. This initial matcher differs from Apple's prefix/relevance search; chapter/part titles, ranking, notes and bible search remain follow-up work. Next session: **L2b quick notes**. End-of-section Server commit under standing permission; no push. No Apple/Spec or owner data touched.

## L2b — Quick notes — 2026-11-04

- Library → Quick Notes opens an in-window form in all layouts. Add/edit plain text (1–20,000 characters), pin to the whole book or a manuscript node, re-pin, move to Trash and restore. Follows Apple's trimming and same-book pin semantics; notes retain pins when their manuscript item is trashed. No permanent deletion.
- Authenticated GET/POST `/api/books/:id/notes` and PUT `/api/books/:id/notes/:noteId`; same-origin writes, allowlisted inputs, same-book validation, book-lock serialization and expected-updated-at conflicts prevent silent stale overwrites. Unknown stored note fields survive edits.
- Append-only SQL migration v2 adds a notes table with canonical spec-shaped JSONB records and book FK. Fresh databases and v1 upgrades tested; manuscripts remain unchanged. No Apple or Spec changes.
- Validation: **30/30 tests pass**, TypeScript and production build pass, whitespace check clean. Coverage includes persistence, ordering, re-pin, invalid/foreign pins and inputs, extra fields, stale writes, Trash/restore, upgrade/repeat migration and authenticated HTTP routing/origin/conflict checks. Existing bundle-size advisory remains.
- Browser visual QA and real PostgreSQL/container smoke were not repeated. Notes search and portable archives remain later work. Next: **L2c references alongside valid bible-entry storage**. End-of-section Server commit under standing permission; not pushed. Owner libraries/databases untouched.

## L2c — Passage references — 2026-11-04

- Library → Bible Entries creates real book-scoped entries with name, one of the nine spec types and optional summary; complete canonical entry records include empty aliases/values/overrides/attachments. Full entry editing, templates, shared scopes and bible parity remain delivery step 3.
- Writing tools → Mark Passage for Reference requires selected text within one paragraph, applies a fresh canonical anchor, flushes the editor and opens References only after successful save. References lists saved passages and entry targets, creates links, shows passages in the editor and offers reversible Trash/restore. The editor is read-only while the reference dialog is open. Missing passages remain visible rather than silently deleting their references.
- Authenticated entries GET/POST and node references GET/POST/PUT endpoints enforce same-origin writes. Reference creation serializes on the book, checks document revision, saved anchor, live same-book entry and duplicate links. Trash updates check expected timestamps; restore revalidates targets/anchors. Stored unknown reference fields survive edits. Document prose/formatting/revisions are not mutated by link/Trash operations.
- Append-only schema v3 adds bible_entries and manuscript_references with foreign keys/indexes and spec-shaped JSONB records. Fresh databases, v1/v2 upgrades and repeated migration tested; notes/manuscripts preserved. No archive format, Apple or Spec changes.
- Validation: **32/32 tests pass**, TypeScript and production build pass, whitespace check clean. Includes HTTP routing/origin/conflict tests, invalid and foreign targets, saved-anchor/revision checks, duplicate rejection, stale updates, Trash/restore, missing anchors, unknown fields and migration preservation. Actual Tiptap test verifies overlapping new anchors preserve old anchors, text and strong formatting. Existing bundle-size advisory remains.
- Browser visual QA and real PostgreSQL/container smoke not repeated. Full bible editing/shared visibility and portable archives remain open. Next session: **L3**, size into smaller sections if needed. End-of-section Server commit under standing permission; not pushed. No owner libraries/databases touched.

## L3 — Formatting, goal totals and layout preferences — 2026-11-04

- Added in-window formatting controls for headings 1–6, left/center/right alignment, numbered lists, indent/outdent (indent bounded to canonical levels 0–7) and add/edit/remove links. The link form accepts http/https/mailto addresses; existing canonical anchor marks survive formatting. No unsupported font/size/colour fields introduced.
- Library → Word Goals and Progress saves the current editor before loading totals. Shows saved words, book goal percentage, remaining words, target date and hierarchy totals including front/back matter. Unsaved drafts are not counted; Trash and descendants of trashed ancestors are excluded. Totals refresh when opened and after successful editor autosaves.
- Authenticated GET `/api/books/:id/progress` computes totals under the existing book lock without changing records/revisions. A shared canonical-text/Intl.Segmenter helper joins marked runs and uses Unicode word boundaries for both scene footer and server totals. Informational counts may differ from Apple's OS word segmentation. No migration or format change.
- Existing browser-local Desk/Writing/Focus persistence now tolerates unavailable storage on both read and write; the app remains usable with an in-memory layout. Preferences are per browser/origin, not server-synced.
- Verification: **33/33 tests pass**, TypeScript and production build pass, whitespace check clean. Tests cover hierarchy aggregation, marked text, Unicode/numbers/emoji, front matter, other-book isolation, Trash/restore, unchanged documents, authenticated progress HTTP and actual Tiptap heading/alignment/link/ordered-list commands preserving text and anchors. Existing Vite bundle-size advisory remains.
- Browser visual QA and real PostgreSQL/container smoke not repeated; responsive/accessibility review remains an M3 acceptance gate. Next: **L4 backup-protected permanent deletion**. End-of-section Server commit under standing permission; not pushed. No Apple/Spec or owner data changes.

## L4a — Durable recovery backup foundation — 2026-11-04

- Split L4 into backup foundation (this session) and L4b deletion/storage/UI integration to keep one coherent section per session. Permanent deletion remains unavailable; no partial purge operation was exposed.
- Internal book-recovery format v1 (SQL schema v3, distinct from portable `.rolltop` archives) captures the library/book, all manuscript descendants including Trash, current documents, immutable revisions, notes, bible entries and references, preserving unknown JSON fields. Sessions are excluded. Capture takes a book row lock; L4b must hold that same transaction through durable backup and deletion.
- Writer creates exclusive UUID-named 0600 files under a 0700-created directory, syncs file and directory, verifies SHA-256 and reads back the payload before resolving. Storage errors propagate. Recovery inserts in FK order, sorting parents before children; requires empty migrated scratch content tables and a caller-owned transaction. This is an internal recovery primitive, not an archive import feature or a deployed restore workflow. External PostgreSQL disaster backups remain required.
- Verification: 34/34 tests pass (HTTP test uses authorized loopback); TypeScript and production build pass. Round trip uses two isolated PGlite databases/temp files and compares all stored rows, including multiple revisions, unknown fields, tombstones, pinned notes, bible entries and references. Corruption, invalid backup destination and nonempty restore target rejected. No real PostgreSQL/container or browser check this session.
- Next session: L4b in the plan. Configure persistent storage and operator recovery tooling; integrate backup-before-delete with cleanup, safe confirmation and failure tests. No schema/Spec/Apple changes or owner data touched. Standing-authorized section commit; no push.

## L4b — Backup-protected permanent deletion — 2026-11-04

- Trash-only book/manuscript purge API and in-window exact-title confirmation. The server rechecks title and deletedAt under the book lock, captures a whole-book backup, waits for private-file fsync/checksum/read-back success, then deletes transactionally. Disabled/missing/unwritable storage fails closed. Database failure rolls back deletion but retains the verified recovery file. Success reports its filename.
- All manuscript descendants (including independent Trash groups), documents, revisions, references and pinned notes are removed, matching native semantics. Book purge additionally removes book notes and entries; library/other books remain. Schema stays v3; future bible/shared-scope/attachment work must extend capture and cleanup together.
- Compose adds a persistent recovery-backups volume, initialized with private app-user ownership in the OCI image; app remains unprivileged/read-only outside its writable backup mount/tmpfs. Native startup accepts STUDIO_BACKUP_DIRECTORY; absent configuration disables purge. The writer requires pre-provisioned storage rather than creating missing directories, so a missing mount fails closed and new parent-directory entries cannot escape the durability check. No automatic backup pruning or HTTP backup download.
- Operator CLI verifies the file and restores transactionally into empty migrated scratch tables under exclusive table locks. Setup documents separate-database recovery, retained tombstones, no live merge, volume retention and off-host disaster backups. Scratch preview optionally accepts a temporary backup directory.
- Verification: **37/37 tests pass**, TypeScript/production build pass, whitespace clean. New tests cover Trash requirement, missing/unwritable backup storage and unchanged rows, stale confirmation, subtree/pinned-note/reference cleanup, sibling/entry/book isolation, full backup restore, SQL-failure rollback with retained verified backup, authenticated/origin-checked HTTP purge and receipts. Existing Vite bundle-size advisory remains.
- **Real PostgreSQL 17/Podman smoke passes**: OCI/Compose startup, login/save/CAS/management, unwritable storage refuses purge with document unchanged, verified purge, backup-volume persistence over studio restart, CLI restore into a new recovery_scratch database, canonical text and both saved revisions verified. Disposable project and both volumes removed. One smoke assertion was corrected to compare JSON objects semantically because PostgreSQL JSONB reorders keys.
- **Desktop browser QA passes** on in-memory scratch data: book Trash → permanent-delete dialog; wrong title keeps submit disabled; matching title enables it; submit removes book and shows recovery filename. Screenshot: docs/screenshots/m3-purge.png. Scratch preview stopped afterward. Full responsive/accessibility review and separate Docker Engine smoke remain open M3 gates.
- No Apple/Spec or owner data changes. Section commit under standing permission; no push. L4 complete for current schema. Next session: B1, size bible/continuity parity into small sections; do not begin it in this session.

## B1 — Bible parity plan and entry details — 2026-11-04

- Reviewed authoritative developer handoff Story bible/M3 requirements, Spec archive entry/field/scope semantics and native store/model/views. Added `M3-BIBLE-PLAN.md` with bounded B2a–B9b sections for remaining parity. Next is B2a, template/field storage; no work from it started this session.
- Library → Bible Entries now supports editing core headers for all nine entry types, name/alias substring and type filters, reversible Trash/restore and a naming-placeholder flag. Character first/last names build display names when edited, with native last-space fallback for older records. Unchanged names/aliases are not rewritten by an unrelated form edit. Changes save explicitly with Save Entry; failures keep the form.
- Authenticated same-origin PUT `/api/books/:bookId/entries/:entryId` uses allowlisted partial patches and expectedUpdatedAt, book locking and monotonic update timestamps. Type/scope/template/values/overrides/attachments cannot be replaced through this header editor. Blank optional names/summary and false `toBeNamed` remove optional keys. Names are nonempty/bounded, aliases bounded and trimmed; only characters accept first/last names. Entry Trash preserves passage references, anchors and saved revisions; new references to a trashed entry are refused. No permanent entry-purge UI yet (B4c).
- Schema remains v3 and recovery format remains v1: entries are already fully captured by L4 backups. No Apple/Spec edits or owner data touched. Existing custom fields and unknown optional data survive header edits.
- Verification: **40/40 tests pass**, TypeScript and production build pass, whitespace clean. Tests cover all nine entry types, validation/clearing, stale edits, cross-book isolation, trashed-book refusal, opaque data preservation, references through entry Trash/restore, unchanged documents/revisions and authenticated/origin/identifier HTTP checks. Vite's existing bundle-size advisory remains.
- Podman/PostgreSQL 17 smoke passes entry edit/conflict/Trash/restore, restart persistence and recovery of edited entry details from the deletion backup into a separate scratch database. Existing manuscript/purge checks also pass; disposable containers and volumes removed.
- Browser QA on volatile scratch data: create character, edit first/last names and aliases, naming flag, filter by alias, Trash/restore and reload retain the details. Narrow 615 px dialog checked; checkbox layout corrected. Screenshot: `docs/screenshots/m3-bible-entries.png`. Full keyboard/screen-reader/responsive matrix remains an acceptance gate. Preview stopped after QA.
- Owner added final-delivery requirement: **both ARM64 (`linux/arm64`) and x86-64 (`linux/amd64`) containers** are required. Multi-platform build plus runtime smoke on each remains open; current local Podman verification is ARM64 only. Logged in plan/setup and shared tracking.
- End-of-section Server commit under standing permission; no push. M3 remains in progress.
