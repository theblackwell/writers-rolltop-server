// SPDX-License-Identifier: AGPL-3.0-only
import { postgres } from "./postgres.ts";
import { StudioStore } from "./store.ts";
import { studioServer } from "./http.ts";
const {
  DATABASE_URL,
  STUDIO_PASSWORD_HASH,
  STUDIO_ORIGIN = "http://localhost:4317",
  HOST = "127.0.0.1",
  PORT = "4317",
} = process.env;
if (!DATABASE_URL || !STUDIO_PASSWORD_HASH)
  throw new Error(
    "Set DATABASE_URL and STUDIO_PASSWORD_HASH; see docs/SETUP.md.",
  );
const db = postgres(DATABASE_URL);
const store = new StudioStore(db, process.env.STUDIO_BACKUP_DIRECTORY);
// Validate configuration before connecting/migrating.
const server = studioServer(store, {
  origin: STUDIO_ORIGIN,
  passwordHash: STUDIO_PASSWORD_HASH,
});
await store.migrate();
server.listen(Number(PORT), HOST, () =>
  console.log(`Writers Rolltop listening on port ${PORT}.`),
);
let closing = false;
async function stop() {
  if (closing) return;
  closing = true;
  server.close(async () => {
    await db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
