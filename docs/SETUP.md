# Self-hosted studio: Docker and Podman

**M3 manuscript foundation, under development.** The current build supports a password-protected studio, libraries, books, parts/chapters/scenes and front/back matter, rename/move/reorder, reversible Trash/restore, canonical rich-text editing, revision-checked saves, browser drafts and version restoration. Bible/continuity, attachments and `.rolltop` import/export are still planned; this is not M3 feature parity or a release. Do not use it as the only copy of an important manuscript.

## Container prerequisites

- Docker Engine/Desktop with Compose, **or** Podman (Podman Desktop on Mac/Windows) with a running machine and Compose provider.
- `podman info` must connect. On Mac/Windows, start the machine in Podman Desktop or with `podman machine start`.
- `podman compose version` must work. Podman delegates Compose to a provider (for example Docker Compose or podman-compose).
- The app image is OCI-compatible, runs as the unprivileged `node` user, uses a read-only filesystem and exposes port 4317. PostgreSQL 17 uses a persistent named volume and has no published port. No Docker socket or privileged container is required.
- Commands below use `podman`; substitute `docker` for Docker. Run from `Server/`.

## Configure and start

1. Copy `.env.example` to `.env`. This file is ignored by Git. Protect it (`chmod 600 .env`).
2. Set `POSTGRES_PASSWORD` to a new random **hex** value (`openssl rand -hex 32`). Hex avoids URL-reserved characters in the database connection string. This is a different password from the one used to sign into the studio.
3. Generate the studio login password hash without putting your password in shell history or process arguments:

   ```bash
   read -r -s -p 'Studio password (at least 12 characters): ' studio_password
   printf '\n'
   printf '%s' "$studio_password" | podman run --rm -i docker.io/library/node:26-alpine node --input-type=module -e 'import{randomBytes,scryptSync}from"node:crypto";let p="";for await(const c of process.stdin)p+=c;if(p.length<12||p.length>1024)throw Error("Use 12–1024 characters");const s=randomBytes(16).toString("hex");console.log(`scrypt$${s}$${scryptSync(p,s,64).toString("hex")}`)'
   unset studio_password
   ```

   This prompt syntax is for Bash. For Zsh use `read -rs 'studio_password?Studio password (at least 12 characters): '` for the first line. Paste the resulting hash into `STUDIO_PASSWORD_HASH` in `.env`, **inside single quotes** so Compose preserves the dollar signs. Never put the plain studio password in `.env` or this repository. If Node ≥24 and dependencies are installed locally, `npm run password --silent` reads the password from stdin instead.

4. Leave `STUDIO_ORIGIN=http://localhost:4317` for local use. This must exactly match the browser origin (scheme, host and port; no trailing slash). Changing `STUDIO_PORT` also requires changing `STUDIO_ORIGIN`.
5. Start:

   ```bash
   podman compose up --build -d
   podman compose ps
   ```

6. Open **http://localhost:4317**, sign in with your studio password, create a library, then a book, chapter and scene. The first launch creates only schema; no sample content is put into your database.

For a remote installation, place a TLS reverse proxy in front and set `STUDIO_ORIGIN=https://your-hostname`. The server refuses non-loopback HTTP origins; HTTPS origins use Secure cookies. The published app port stays bound to host loopback unless you deliberately configure another network/proxy arrangement. No multi-user sharing, user accounts, M4 synchronization or end-to-end encryption is implemented.

## Data, restart and upgrades

- `podman compose stop` / `podman compose start` preserves the named PostgreSQL volume.
- `podman compose down` removes containers/networks and **keeps** that volume. **Do not use `down -v` on your real installation:** it deletes the database volume.
- `podman compose up --build -d` rebuilds the app. Back up first. Database migrations are transactional and versioned; a newer schema is refused by older server code. Downgrade by restoring a pre-upgrade backup into a separate installation, not by changing migration history.
- Studio login is single-owner. Password hashes come from environment; sessions expire after 12 hours. After changing the hash, revoke existing sessions by running `DELETE FROM studio_sessions;` through the database shell below.

## Backup and restore

Stop the studio service to avoid writes during an upgrade/restore. PostgreSQL's `pg_dump` itself takes a consistent snapshot without requiring database shutdown.

```bash
podman compose exec -T postgres pg_dump -U rolltop -d rolltop -Fc > rolltop-backup.dump
```

Keep backups outside the Compose volume, protect them as manuscript content, and test restoration into a **separate scratch installation**. First stop that scratch studio service, then:

```bash
podman compose stop studio
podman compose exec -T postgres pg_restore -U rolltop -d rolltop --clean --if-exists < rolltop-backup.dump
podman compose start studio
```

`--clean` replaces data in the target database: use only the intended restore target. The current slice stores manuscripts and revisions entirely in PostgreSQL; attachment storage and portable archive backups are future M3 work. To open the database shell: `podman compose exec postgres psql -U rolltop -d rolltop`.

## Development and verification

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run build
```

The API integration tests bind temporary loopback ports and use isolated PGlite databases (real PostgreSQL compiled to WebAssembly). They do not connect to your Compose database. The editor test loads the actual Tiptap schema against every document fixture.

For an ephemeral browser preview: `node scripts/preview-scratch.ts`, then open http://localhost:4318. Login is `scratch-preview-password`; all sample data is in memory and disappears on exit. The preview binds only loopback and is never the production entry point.

For the real PostgreSQL/container check:

```bash
CONTAINER_RUNTIME=podman node scripts/container-smoke.ts
# Or CONTAINER_RUNTIME=docker
```

It builds an image, creates an isolated Compose project/volume on port 14317, tests authentication, scene creation, saving, conflicts, restart persistence and built web assets, then removes **only its own** disposable containers/volume. Set `SMOKE_PORT` to choose another test port. It requires Node and installed dependencies on the host. It does not start or modify your normal Compose installation.

To work against a separate PostgreSQL development database, set `DATABASE_URL`, `STUDIO_PASSWORD_HASH`, and `STUDIO_ORIGIN=http://localhost:5173`, then run `npm start` and `npm run dev` in separate terminals. The Vite server proxies `/api` to loopback port 4317. Never point development/testing at the owner's libraries or production database.

Manuscript Actions (•••) are visible beside each binder item. Use Move To for another chapter/part and an insertion position. Trash preserves saved versions; Restore is in the binder Trash or Projects → Book Trash. Items trashed separately before a chapter/book remain trashed when that container is restored. Permanent deletion is available only in Trash, after verified backup and exact-title confirmation.

### Permanent deletion and book recovery

In Projects → Book Trash or Manuscript → Trash, choose **Delete Permanently…**. Type the exact title. The server rechecks that the item is still in the same Trash batch, locks its book, writes and verifies a whole-book recovery file, then deletes in one database transaction. A backup failure leaves content untouched; a database failure rolls deletion back and retains the recovery file. Closing or cancelling before submission does nothing. Once submitted, wait for the result; closing a browser cannot cancel a committed server operation.

Deleting a manuscript item deletes all descendants (including independently trashed ones), current text, saved versions, passage references and notes pinned to those nodes. Book notes and bible entries remain. Deleting a book also removes its notes and book-scoped bible entries. The library and other books remain. These book-content cleanup rules originated in schema v3; future bible/shared-scope/attachment tables must extend both backup and cleanup before they can ship.

Compose mounts a separate persistent `recovery-backups` volume at `/studio/backups`, owned by the unprivileged app user. `STUDIO_BACKUP_DIRECTORY` points there. Native development must pre-create a private (0700) absolute writable directory and configure its path; without it permanent deletion fails closed. Keep this directory private. Files are created exclusively with mode 0600, synced with their directory and verified by SHA-256/read-back. Do not serve this directory as web assets. Files are never pruned automatically. Copy them off the host regularly, protect them as manuscript content, and monitor free space. `compose down` retains both volumes; `down -v` destroys both. These are same-host recovery copies, not disaster protection.

Schema v4 adds library-owned bible templates and fields. New libraries and upgrades receive nine built-in templates with 20 native-compatible fields, without changing existing entries. Book purge retains these library definitions. Recovery files now use internal version 2 (schemaVersion 4) and include the parent library's templates/fields. Older version 1/schema3 files remain supported: recovery restores their book data and adds missing built-ins in the empty scratch target. Do not downgrade the server against schema v4 or open version 2 recovery files with older server code.

Schema v5 adds library-owned worlds (universes) and series, with generated membership columns derived from the preserved JSON records. Composite foreign keys prevent cross-library memberships; a book must match its series' world when the series has one. Series can exist without a world. A series' world is immutable in this storage section. Deleting referenced worlds/series is refused by foreign keys; book purge retains all library worlds/series. Library → Worlds and Series offers creation, renaming, book memberships and guarded Trash/restore. A world change clears an incompatible existing series. Book memberships (including trashed books), live child series and scoped bible entries block parent Trash. Trashed child series remain attached; restore requires a live parent world. Membership changes refuse leaving saved book overrides behind. Conflicts keep the form; close and reopen to load the latest records. No permanent world/series deletion is exposed. Internal recovery version 3/schema5 includes every world/series in the parent library as context, including tombstones, and restores generated columns from JSON. Version 1/schema3 and version 2/schema4 remain supported in empty migrated scratch databases. Never downgrade a schema5 database or read v3 recovery with an older server. All future world/series writes must take the library lock (book membership: book then library) to serialize with recovery; do not edit live tables manually.

A successful deletion shows a UUID `.book-recovery.json` filename. Retain it. Files contain the entire affected book before deletion, including Trash, unknown fields, notes, entries, references and every saved revision, plus its parent library record, template/field definitions and worlds/series. They exclude login sessions and other books. This is an internal recovery format, **not** a portable `.rolltop` archive.

Restore into a **new empty scratch database**, never over a live installation. Stop any studio connected to that scratch database first. The CLI locks content tables and refuses a nonempty target; inserts are transactional. For the default Compose setup, replace `REPLACE_WITH_RECEIPT` below with the returned filename:

```bash
podman compose exec -T postgres createdb -U rolltop rolltop_recovery
podman compose exec -T studio node --input-type=module -e '
  const target = new URL(process.env.DATABASE_URL);
  target.pathname = "/rolltop_recovery";
  process.env.RECOVERY_DATABASE_URL = target.href;
  process.argv = ["node", "restore-cli.ts", "/studio/backups/REPLACE_WITH_RECEIPT", "--empty-scratch"];
  await import("./packages/studio/src/restore-cli.ts");
'
```

Use `docker` in place of `podman` for Docker Engine. The command reuses existing database credentials without printing them. To run outside Compose, set `RECOVERY_DATABASE_URL` to the separate scratch database and run `node packages/studio/src/restore-cli.ts /absolute/backup/path --empty-scratch`. The CLI migrates the target schema and never drops or overwrites existing content.

Inspect recovered content through a separate scratch studio pointing only at the recovery database (with its own origin/port), or inspect SQL records. The book and manuscript may still be in Trash because the backup preserves pre-deletion state; use Restore there. Full-book recovery is deliberate: it preserves context and saved versions and does not merge over subsequent edits in the live book. Reconciliation with newer live content remains manual until safe portable archives are implemented. Keep full PostgreSQL disaster backups using the procedure above.

## Release architectures (required before final delivery)

The owner requires both `linux/arm64` and `linux/amd64` (x86-64) containers. A multi-platform release build and runtime smoke check on each architecture remain final M3 acceptance gates. The current local Podman smoke was on ARM64; x86-64 support is required but has not yet been built or verified.

## Bible field values (B2b–B2e)

Open Library → Bible Entries, then Fields beside an entry. Choose a compatible template and Assign Template, then edit/save individual fields. Clear Value removes just that value. Empty text, zero and false remain real saved values. Decimal input stays exact text (for example `12.50`); integers must be within ±(2^53−1). Missing required fields are allowed while drafting.

Template changes are blocked while saved values or overrides exist. Entry links can target live entries of the allowed types in the same book; existing links to Trash remain visible. Attachment values remain unavailable until storage is implemented. Built-in templates currently offer text/integer scalar fields; decimal/boolean controls support those definitions when present, and custom definitions can now be created with Templates and Fields. If a stale edit is refused, the form remains available: preserve your draft and close/reopen Bible Entries to review current data. Field saves compare both the entry and field-definition timestamps. No database migration is needed for this section.

Selection fields save option IDs (single choice or checkboxes). No choices saves an empty selection; Clear Value removes it. Real-world dates use YYYY-MM-DD and must exist in the Gregorian calendar. Story dates have a label, optional calendar and optional integer ordinal, including zero and negatives.

Tables support 1–20 columns and up to 500 rows. Each heading/cell allows 1,000 Unicode code points. Use Add/Remove Row or Column and Save Value; Cancel leaves saved data unchanged. Column/row removal takes effect only when saved. Clear Value removes the whole field value. Other saved fields stay intact. Table requests can be up to 64 MiB; reverse proxies must permit this size for field-value routes if large tables are needed. Other API routes retain the 4 MiB bound.

The native Event template exposes a story date. Selection, real-date and table controls work when their definitions exist; custom definitions are available under Templates and Fields. For disposable browser QA only, `STUDIO_STRUCTURED_PREVIEW=1 node scripts/preview-scratch.ts` adds demonstration definitions/entry to the volatile scratch library. It does not modify the production initializer or native built-ins.

## Custom templates and fields

Open Library → Bible Entries → Templates and Fields. Choose New Template and its entry type, or select an existing template. New Field offers text, number, choice, dates, entry links and table definitions; attachment definitions can be recorded, but attachment values remain unavailable. Customize changes a field's label, suggested status, choices or allowed target types. Move Up/Down changes display order. Built-ins can be customized without changing their IDs.

Types and keys stay fixed. Create a new field for a different type; existing values are never converted or dropped. Renaming choices preserves saved selections. Removing choices, reducing multiplicity or narrowing target types is refused if it would invalidate values, including in Trash. Unsaved entry forms survive navigation to definitions and back. Errors retain definition drafts; cancel before changing screens. A stale definition requires reopening Bible Entries to review the latest state.

Entry-reference fields save one ID or a unique list of IDs. Choose live entries in the current book, respecting allowed types. Empty multi-link lists differ from cleared values. Target Trash does not destroy existing links. Book purge refuses unexpected incoming typed links from another book instead of editing data outside its recovery snapshot; shared-scope links and their cleanup will be introduced together in B3.
