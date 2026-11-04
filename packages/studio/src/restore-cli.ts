// SPDX-License-Identifier: AGPL-3.0-only
import { postgres } from "./postgres.ts";
import { StudioStore } from "./store.ts";
import { readBookBackup, restoreBookBackup } from "./backup.ts";
const [path, confirmation] = process.argv.slice(2);
if (
  !path ||
  confirmation !== "--empty-scratch" ||
  !process.env.RECOVERY_DATABASE_URL
)
  throw new Error(
    "Set RECOVERY_DATABASE_URL to a separate empty scratch database; run restore-cli.ts BACKUP_PATH --empty-scratch. Stop the scratch studio first.",
  );
const backup = await readBookBackup(path);
const db = postgres(process.env.RECOVERY_DATABASE_URL);
try {
  const store = new StudioStore(db);
  await store.migrate();
  await db.transaction((q) => restoreBookBackup(q, backup));
  console.log(
    `Recovered book ${backup.bookId} into the empty scratch database. Inspect it before exporting or migrating any content.`,
  );
} finally {
  await db.close();
}
