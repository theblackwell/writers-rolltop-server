# M3 development checkpoint — 2026-11-03

**Status: manuscript foundation implemented. M3 is not complete or signed off.**
Owner authorized Codex to work in Server in parallel with Claude's M2 Apple work.
No Apple or Spec files were changed for this slice. The owner authorized a Server-only
checkpoint commit after verification. No push was requested.

## What works

- React/TypeScript/Vite workspace with simplified walnut/parchment presentation, Projects and Manuscript, Desk/Writing/Focus. All current actions are in the browser window. Focus hides the formatting strip under Writing tools.
- Single-owner login using an environment-provided scrypt hash. Session tokens are random, hashed in PostgreSQL, HttpOnly/SameSite Strict, Secure for HTTPS. Same-origin checks on writes, request size limit, generic server errors and login throttling. HTTPS is required for non-loopback browser origins.
- Versioned/transactional PostgreSQL schema; libraries, books, chapters and scenes, with hierarchy validation and stable canonical UUIDs/order keys. Repository supports parts and front/back matter, but those creation flows aren't exposed yet.
- Actual Tiptap editor restricted to canonical v1 constructs; the existing adapter is reused. Current toolbar has basic marks, paragraph/headings, lists/quotes/scene breaks, save and history. Full formatting controls remain later work.
- Autosave uses expected revision and append-only saved versions. Stale saves are refused, with browser-draft download and server-version comparison. Restoring a saved version creates another revision.
- Browser recovery drafts use separate keys per editor instance, so one tab cannot clear another's draft. Invalid/newer drafts are retained. Browser storage can be unavailable/full: the interface then warns and keeps the in-memory draft. The UI offers the newest recovered copy first; other copies remain stored. This is not yet full offline application support or M4 synchronization.
- OCI multi-stage image, unprivileged/read-only app container, Docker/Podman Compose, private PostgreSQL service and persistent named volume. No real library/data is seeded into a normal deployment.

## Verification

| Check | Result |
|---|---|
| `npm run check` | Pass |
| `npm test` | **19 pass**: original 9 adapter tests, actual Tiptap fixture round trips, SQL hierarchy/CAS/history, authenticated API/origin/expiry/logout, transaction failure rollback, newer schema refusal, 100,000-word Unicode save/load, isolated browser drafts |
| `npm run build` | Pass; current JS bundle about 668 kB / 211 kB gzip. Vite reports its >500 kB advisory; code splitting is future performance work. |
| Podman OCI/Compose smoke | **Pass**, real PostgreSQL 17: image build, startup, login, create/save scene, stale-save refusal, restart persistence, built page/assets; disposable project and volume removed afterwards |
| Browser on scratch data | Login, first scene selection, editing/save, scene switching/reload, history preview/restore, Desk/Writing/Focus, two-tab conflict retains draft and shows server comparison |
| Visual review | Desktop manuscript at 1280 px, narrow Focus view; screenshots in `docs/screenshots/`. Phone/tablet and full keyboard/screen-reader review remain open. |
| Docker Engine | Not run separately. Docker Compose provider was used against the Podman engine. |

Scratch preview: `node scripts/preview-scratch.ts`, http://localhost:4318,
password `scratch-preview-password`. Its in-memory sample disappears on exit.
Production setup and backup/restore commands: [SETUP.md](SETUP.md).

## Next work / acceptance gates

1. Manuscript management: rename/move/order, parts/front/back matter UI, tombstones/restore, metadata/goals/search/notes, reference linking and complete formatting controls.
2. Bible and continuity parity with Spec/M1: scopes, all field kinds/templates/overrides, relationships, facts/questions, knowledge, timeline/state changes and warning dismissal.
3. Attachments and safe `.rolltop` archives: checksums/path/size limits, staging, preview, required optional-field preservation and cross-edition round trips. **No import/export is offered yet; never substitute a lossy text conversion.**
4. Durable offline application/recovery, additional browser concurrency/failure checks, 100k-word browser performance, responsive/accessibility pass, Docker Engine smoke, restore a PostgreSQL backup into a scratch installation, deployment/security review, screenshots and owner review.

M4 device sync and M5 publishing exports remain separate. Don't claim M3 complete from this checkpoint.
