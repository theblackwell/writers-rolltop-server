# Self-hosted studio: Docker and Podman

**M3 manuscript foundation, under development.** The current build supports a password-protected studio, libraries, books, chapters/scenes, canonical rich-text editing, revision-checked saves, browser drafts and version restoration. Bible/continuity, attachments and `.rolltop` import/export are still planned; this is not M3 feature parity or a release. Do not use it as the only copy of an important manuscript.

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
