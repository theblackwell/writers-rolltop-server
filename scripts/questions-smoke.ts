// SPDX-License-Identifier: AGPL-3.0-only
// Internal-question storage checkpoint, using only a disposable PostgreSQL container.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { postgres } from "../packages/studio/src/postgres.ts";
import { StudioStore } from "../packages/studio/src/store.ts";
import { saveQuestion } from "../packages/studio/src/questions.ts";
import { editWorld, bookMembership } from "../packages/studio/src/worlds.ts";
import {
  backupTables,
  captureBook,
  restoreBookBackup,
} from "../packages/studio/src/backup.ts";
const exec = promisify(execFile),
  runtime = process.env.CONTAINER_RUNTIME ?? "podman";
const name = "rolltop-questions-" + randomBytes(4).toString("hex"),
  password = randomBytes(20).toString("hex");
const run = async (...args: string[]) =>
  (await exec(runtime, args)).stdout.trim();
let db: ReturnType<typeof postgres> | undefined,
  target: ReturnType<typeof postgres> | undefined,
  created = false;
async function ready() {
  for (let i = 0; i < 40; i++) {
    try {
      await run("exec", name, "pg_isready", "-U", "rolltop");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw Error("scratch PostgreSQL readiness");
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
  await ready();
  const mapping = await run("port", name, "5432/tcp"),
    port = mapping.split(":").at(-1)!;
  const url = new URL(
    `postgres://rolltop:${password}@127.0.0.1:${port}/rolltop`,
  );
  db = postgres(url.href);
  let store = new StudioStore(db);
  await store.migrate();
  const library = await store.createLibrary("Questions scratch"),
    book = await store.createBook(library.id, "First"),
    other = await store.createBook(library.id, "Second");
  const world = await editWorld(db, library.id, "universes", {
    title: "Questions world",
  });
  for (const b of [book, other])
    await bookMembership(db, b.id, {
      universeId: world.id,
      expectedUpdatedAt: b.updatedAt,
    });
  const chapter = await store.createNode(book.id, "Chapter", "chapter"),
    entry = await store.createEntry(book.id, {
      name: "Entry",
      entryType: "term",
    });
  let question = await saveQuestion(db, book.id, {
    scopeKind: "universe",
    text: "Who left?",
    topic: "Departure",
    status: "decided",
    decision: "The keeper",
    entryIds: [entry.id],
    nodeId: chapter.id,
  });
  const attempts = await Promise.allSettled([
    saveQuestion(
      db,
      book.id,
      {
        decision: "One",
        expectedUpdatedAt: question.updatedAt,
        editSharedCanon: true,
      },
      question.id,
    ),
    saveQuestion(
      db,
      other.id,
      {
        decision: "Two",
        expectedUpdatedAt: question.updatedAt,
        editSharedCanon: true,
      },
      question.id,
    ),
  ]);
  assert.equal(attempts.filter((x) => x.status === "fulfilled").length, 1);
  assert.match(
    String(
      (attempts.find((x) => x.status === "rejected") as PromiseRejectedResult)
        .reason,
    ),
    /changed/,
  );
  question = (
    attempts.find(
      (x) => x.status === "fulfilled",
    ) as PromiseFulfilledResult<any>
  ).value;
  question = await saveQuestion(
    db,
    book.id,
    {
      deleted: true,
      expectedUpdatedAt: question.updatedAt,
      editSharedCanon: true,
    },
    question.id,
  );
  question = await saveQuestion(
    db,
    other.id,
    {
      deleted: false,
      expectedUpdatedAt: question.updatedAt,
      editSharedCanon: true,
    },
    question.id,
  );
  await db.close();
  db = undefined;
  await run("restart", name);
  await ready();
  db = postgres(url.href);
  store = new StudioStore(db);
  await store.migrate();
  assert.deepEqual(
    (await db.query("SELECT data FROM questions WHERE id=$1", [question.id]))
      .rows[0].data,
    question,
  );
  const backup = await db.transaction((q) => captureBook(q, book.id));
  await db.query("CREATE DATABASE questions_recovery_scratch");
  url.pathname = "/questions_recovery_scratch";
  target = postgres(url.href);
  await new StudioStore(target).migrate();
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
    "PASS: PostgreSQL17 question migration/storage/shared CAS/Trash/restore/restart and exact whole-library recovery.",
  );
} finally {
  await target?.close();
  await db?.close();
  if (created) {
    await run("rm", "-f", "-v", name);
    console.log(
      "Removed disposable questions PostgreSQL container and anonymous volume.",
    );
  }
}
