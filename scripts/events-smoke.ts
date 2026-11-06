// SPDX-License-Identifier: AGPL-3.0-only
// Bounded real-PostgreSQL timeline storage check. Uses only its own disposable container.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { postgres } from "../packages/studio/src/postgres.ts";
import { StudioStore } from "../packages/studio/src/store.ts";
import { saveEvent } from "../packages/studio/src/events.ts";
import { editWorld, bookMembership } from "../packages/studio/src/worlds.ts";
import {
  backupTables,
  captureBook,
  restoreBookBackup,
} from "../packages/studio/src/backup.ts";
const exec = promisify(execFile),
  runtime = process.env.CONTAINER_RUNTIME ?? "podman";
const name = "rolltop-events-" + randomBytes(4).toString("hex"),
  password = randomBytes(20).toString("hex");
const run = async (...args: string[]) =>
  (await exec(runtime, args)).stdout.trim();
let db: ReturnType<typeof postgres> | undefined,
  target: ReturnType<typeof postgres> | undefined,
  created = false;
async function connect(url: string) {
  for (let i = 0; ; i++) {
    const connection = postgres(url);
    try {
      await connection.query("SELECT 1");
      return connection;
    } catch (error) {
      await connection.close();
      if (i >= 30) throw error;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

try {
  await run(
    "run",
    "-d",
    "--name",
    name,
    "-e",
    `POSTGRES_PASSWORD=${password}`,
    "-e",
    "POSTGRES_USER=rolltop",
    "-e",
    "POSTGRES_DB=rolltop",
    "-p",
    "127.0.0.1::5432",
    "postgres:17",
  );
  created = true;
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try {
      await run("exec", name, "pg_isready", "-U", "rolltop");
      ready = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  assert.ok(ready, "scratch PostgreSQL readiness");
  const mapping = await run("port", name, "5432/tcp"),
    port = mapping.split(":").at(-1)!;
  const url = new URL(
    `postgres://rolltop:${password}@127.0.0.1:${port}/rolltop`,
  );
  db = await connect(url.href);
  let store = new StudioStore(db);
  await store.migrate();
  const library = await store.createLibrary("Timeline scratch"),
    book = await store.createBook(library.id, "First book"),
    companion = await store.createBook(library.id, "Second book");
  const world = await editWorld(db, library.id, "universes", {
    title: "Timeline world",
  });
  for (const b of [book, companion])
    await bookMembership(db, b.id, {
      universeId: world.id,
      expectedUpdatedAt: b.updatedAt,
    });
  const chapter = await store.createNode(book.id, "Chapter", "chapter"),
    scene = await store.createNode(book.id, "Scene", "scene", chapter.id),
    entry = await store.createEntry(book.id, {
      name: "Character",
      entryType: "character",
    });
  let event = await saveEvent(db, book.id, {
    scopeKind: "universe",
    title: "The storm",
    summary: "A shared event",
    when: { label: "Third moon", calendar: "Old calendar", ordinal: -3 },
    sceneIds: [scene.id],
    participants: [{ entryId: entry.id, role: "Witness" }],
  });
  const attempts = await Promise.allSettled(
    [book, companion].map((b, i) =>
      saveEvent(
        db!,
        b.id,
        {
          title: "Writer " + i,
          expectedUpdatedAt: event.updatedAt,
          editSharedCanon: true,
        },
        event.id,
      ),
    ),
  );
  assert.equal(attempts.filter((x) => x.status === "fulfilled").length, 1);
  const rejected = attempts.find(
    (x) => x.status === "rejected",
  ) as PromiseRejectedResult;
  assert.equal(rejected.reason.status, 409);
  event = (
    attempts.find(
      (x) => x.status === "fulfilled",
    ) as PromiseFulfilledResult<any>
  ).value;
  event = await saveEvent(
    db,
    book.id,
    {
      deleted: true,
      expectedUpdatedAt: event.updatedAt,
      editSharedCanon: true,
    },
    event.id,
  );
  event = await saveEvent(
    db,
    companion.id,
    {
      deleted: false,
      expectedUpdatedAt: event.updatedAt,
      editSharedCanon: true,
    },
    event.id,
  );
  await db.close();
  db = undefined;
  await run("restart", name);
  ready = false;
  for (let i = 0; i < 40; i++) {
    try {
      await run("exec", name, "pg_isready", "-U", "rolltop");
      ready = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  assert.ok(ready);
  db = await connect(url.href);
  store = new StudioStore(db);
  await store.migrate();
  const persisted = (
    await db.query("SELECT data FROM continuity_events WHERE id=$1", [event.id])
  ).rows[0].data;
  assert.deepEqual(persisted, event);
  const backup = await db.transaction((q) => captureBook(q, book.id));
  await db.query("CREATE DATABASE events_recovery_scratch");
  url.pathname = "/events_recovery_scratch";
  target = postgres(url.href);
  const recovery = new StudioStore(target);
  await recovery.migrate();
  await target.transaction((q) => restoreBookBackup(q, backup));
  const restored = await target.transaction((q) => captureBook(q, book.id));
  const sorted = (rows: any[]) =>
    JSON.parse(JSON.stringify(rows)).sort((a: any, b: any) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    );
  for (const table of backupTables)
    assert.deepEqual(
      sorted(restored.tables[table]),
      sorted(backup.tables[table]),
      table,
    );
  console.log(
    "PASS: real PostgreSQL timeline storage/shared CAS/Trash/restore, restart persistence and exact whole-library recovery.",
  );
} finally {
  await target?.close();
  await db?.close();
  if (created) {
    await run("rm", "-f", "-v", name);
    console.log(
      "Removed disposable timeline PostgreSQL container and anonymous volume.",
    );
  }
}
