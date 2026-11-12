# Web studio (`@writers-rolltop/web`)

React 19, TypeScript and Vite. A single-page app that calls the API at `/api`. This is the M1-8 shell: sign-in and setup
work against the real auth routes; the book list, sections, tabs and side panels are placeholder data (`src/placeholder.ts`)
and the editor comes in M1-9.

## Run it locally

1. Start the API on a scratch database (never your real library). From `Server/`:

   ```sh
   DATABASE_URL=postgres://postgres@127.0.0.1:55432/my_scratch_db \
   ROLLTOP_COOKIE_SECURE=0 ROLLTOP_DATA_DIR=/tmp/rolltop-scratch PORT=8080 \
   node packages/api/src/index.ts
   ```

   Create the database first (an empty one). On first start the API prints a one-time setup token in its log
   (`SETUP_TOKEN`). `ROLLTOP_COOKIE_SECURE=0` is for plain `http://localhost` only: the default Secure cookie does not
   work over plain HTTP in some browsers (the M1-7 notes record this as unconfirmed). Never use it on a public address.
   The API runs `pg_dump` before migrating a database that has data, so `pg_dump` must be on `PATH` for a non-empty one.

2. Start the studio. From `Server/`: `npm run dev:web` (or `npm run dev -w @writers-rolltop/web`), then open
   <http://127.0.0.1:5173>. Vite forwards `/api` to `http://127.0.0.1:$ROLLTOP_API_PORT` (then `$PORT`, then 8080), so the
   browser sees one origin and the session cookie works.

Other scripts (in `packages/web`): `npm run build`, `npm run preview` (same proxy), `npm run typecheck`.

## Browser tests

`npm run test:e2e -w @writers-rolltop/web` runs Playwright (`e2e/`). It creates its own scratch database named `rt_web_*`
on the PostgreSQL server in `ROLLTOP_TEST_DATABASE_URL` (the admin URL, as for the store tests), starts the API and Vite on
ports 18080 and 15173, and drops the database afterwards. It drives the installed Google Chrome (`channel: "chrome"`), so
no browser download is needed. `npm test` at `Server/` does not run these tests.

## Text kept on this device

While a scene's text has not been saved, or the server has not confirmed it, the studio keeps a copy in this browser
(IndexedDB, one database per library, named `rolltop-library-<id>`). It is removed once the server accepts the text or the
author decides what to do with it. A recovery item also keeps the saved server text it was compared with, so it can be
read when the scene has since changed or gone. The device id (not a secret) stays in this browser's `localStorage`. Signing out does not remove it: on a shared or public browser, text that was not
saved stays in that browser profile and comes back when someone signs in to the same library there. Use your own browser
profile, or clear this site's data when you leave a shared computer.

`window.__ROLLTOP_POLL_MS__` (how often the studio asks for changes) is a test knob. It is read only in a dev or test
build (`import.meta.env.DEV`); a production build never reads it.
