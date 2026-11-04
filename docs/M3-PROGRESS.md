# M3 development checkpoint — 2026-11-03

**Status: manuscript foundation and rename/move/Trash management implemented. M3 is not complete or signed off.**
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

1. Remaining manuscript management: metadata/goals/search/notes, reference linking, complete formatting controls and backup-protected permanent deletion. Rename/move/order, parts/front/back matter UI and tombstones/restore are implemented.
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
