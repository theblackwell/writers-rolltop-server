// SPDX-License-Identifier: AGPL-3.0-only
// Disposable PostgreSQL only; never connects to an existing studio database.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { postgres } from "../packages/studio/src/postgres.ts";
import { StudioStore } from "../packages/studio/src/store.ts";
import { saveFact } from "../packages/studio/src/facts.ts";
import {
  captureBook,
  restoreBookBackup,
  backupTables,
} from "../packages/studio/src/backup.ts";
const name = "rolltop-facts-" + randomUUID();
const runtime = process.env.CONTAINER_RUNTIME ?? "podman";
const command = (...args: string[]) =>
  execFileSync(runtime, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
let db: ReturnType<typeof postgres> | undefined;
try {
  command(
    "run",
    "-d",
    "--name",
    name,
    "-e",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    "-p",
    "127.0.0.1::5432",
    "postgres:17-alpine",
  );
  const port = command("port", name, "5432").trim().split(":").at(-1);
  const url = `postgresql://postgres@127.0.0.1:${port}/postgres`;
  db = postgres(url);
  for (let i = 0; ; i++) {
    try {
      await db.query("SELECT 1");
      break;
    } catch (e) {
      if (i >= 30) throw e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  const store = new StudioStore(db);
  await store.migrate();
  const lib = await store.createLibrary("Facts smoke scratch"),
    book = await store.createBook(lib.id, "Book");
  const chapter = await store.createNode(book.id, "Chapter", "chapter"),
    person = await store.createEntry(book.id, {
      name: "Person",
      entryType: "character",
    });
  const fact = await saveFact(db, book.id, {
    text: "Persisted secret",
    nodeId: chapter.id,
    entryIds: [person.id],
    knowledge: [{ knower: "reader" }, { knower: person.id }],
  });
  const before = await db.transaction((q) => captureBook(q, book.id));
  await db.close();
  db = undefined;
  command("restart", name);
  db = postgres(url);
  for (let i = 0; ; i++) {
    try {
      await db.query("SELECT 1");
      break;
    } catch (e) {
      if (i >= 30) throw e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  assert.deepEqual(
    (await db.query("SELECT data FROM facts WHERE id=$1", [fact.id])).rows[0]
      .data,
    fact,
  );
  await db.query("CREATE DATABASE facts_restore_scratch");
  const restoreUrl = new URL(url);
  restoreUrl.pathname = "/facts_restore_scratch";
  const restoredDb = postgres(restoreUrl.href);
  try {
    const restoredStore = new StudioStore(restoredDb);
    await restoredStore.migrate();
    await restoredDb.transaction((q) => restoreBookBackup(q, before));
    const restored = await restoredDb.transaction((q) =>
      captureBook(q, book.id),
    );
    const norm = (rows: any[]) =>
      JSON.parse(JSON.stringify(rows)).sort((a: any, b: any) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
      );
    for (const table of backupTables)
      assert.deepEqual(
        norm(restored.tables[table]),
        norm(before.tables[table]),
        table,
      );
  } finally {
    await restoredDb.close();
  }
  console.log(
    "PASS: PostgreSQL fact migration/storage/restart and exact whole-library recovery.",
  );
} finally {
  if (db) await db.close();
  command("rm", "-f", "-v", name);
  console.log(
    "Removed disposable facts PostgreSQL container and anonymous volume.",
  );
}
