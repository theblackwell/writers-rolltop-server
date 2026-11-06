// SPDX-License-Identifier: AGPL-3.0-only
// Bounded real-PostgreSQL state-change API and as-of check. Uses only its own disposable container.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { postgres } from "../packages/studio/src/postgres.ts";
import { StudioStore } from "../packages/studio/src/store.ts";
import { resolveState } from "../packages/studio/src/state-values.ts";
import { studioServer } from "../packages/studio/src/http.ts";
import { passwordHash } from "../packages/studio/src/auth.ts";
import { editWorld, bookMembership } from "../packages/studio/src/worlds.ts";
import {
  backupTables,
  captureBook,
  restoreBookBackup,
} from "../packages/studio/src/backup.ts";
const exec = promisify(execFile),
  runtime = process.env.CONTAINER_RUNTIME ?? "podman";
const name = "rolltop-state-api-" + randomBytes(4).toString("hex"),
  password = randomBytes(20).toString("hex");
const run = async (...args: string[]) =>
  (await exec(runtime, args)).stdout.trim();
let db: ReturnType<typeof postgres> | undefined,
  target: ReturnType<typeof postgres> | undefined,
  server: ReturnType<typeof studioServer> | undefined,
  created = false;
const origin = "http://localhost:4317",
  hash = await passwordHash(password);
let base = "",
  cookie = "";
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
async function start(store: StudioStore) {
  server = studioServer(store, { origin, passwordHash: hash });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  const response = await fetch(base + "/login", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  assert.equal(response.status, 200);
  cookie = response.headers.get("set-cookie")!.split(";")[0];
}
async function stop() {
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  }
}
async function api(path: string, method = "GET", value?: object) {
  const r = await fetch(base + path, {
    method,
    headers: {
      Cookie: cookie,
      Origin: origin,
      "Content-Type": "application/json",
    },
    ...(value ? { body: JSON.stringify(value) } : {}),
  });
  const result = await r.json();
  if (!r.ok) throw Error(`${r.status}: ${JSON.stringify(result)}`);
  return result;
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
  const library = await store.createLibrary("State API scratch"),
    book = await store.createBook(library.id, "First book"),
    companion = await store.createBook(library.id, "Second book");
  const world = await editWorld(db, library.id, "universes", {
    title: "State world",
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
  const templateCatalog = await store.templates(library.id),
    template = templateCatalog.templates.find(
      (t) => t.entryType === "character",
    )!;
  let character = await store.createEntry(book.id, {
    name: "Shared keeper",
    entryType: "character",
    scopeKind: "universe",
  });
  character = await store.editEntryField(book.id, character.id, {
    templateId: template.id,
    expectedUpdatedAt: character.updatedAt,
    expectedTemplateUpdatedAt: template.updatedAt,
    editSharedCanon: true,
  });
  const field = templateCatalog.fields.find(
    (f) => f.templateId === template.id && f.fieldType === "integer",
  )!;
  const otherChapter = await store.createNode(
      companion.id,
      "Next chapter",
      "chapter",
    ),
    otherScene = await store.createNode(
      companion.id,
      "Next scene",
      "scene",
      otherChapter.id,
    );
  await start(store);
  const path = "/books/" + book.id + "/state-changes",
    other = "/books/" + companion.id + "/state-changes";
  const args = {
    entryId: character.id,
    fieldId: field.id,
    value: 3,
    nodeId: scene.id,
    expectedEntryUpdatedAt: character.updatedAt,
    expectedFieldUpdatedAt: field.updatedAt,
    editSharedCanon: true,
  };
  let event = await api(path, "POST", args);
  assert.equal(
    resolveState(
      character,
      field.id,
      companion.id,
      otherScene.id,
      await api(other),
    ).value,
    3,
  );
  const attempts = await Promise.allSettled(
    [path, other].map((p, i) =>
      api(p + "/" + event.id, "PUT", {
        ...args,
        value: i + 7,
        expectedUpdatedAt: event.updatedAt,
      }),
    ),
  );
  assert.equal(attempts.filter((x) => x.status === "fulfilled").length, 1);
  assert.match(
    String(
      (attempts.find((x) => x.status === "rejected") as PromiseRejectedResult)
        .reason,
    ),
    /409/,
  );
  event = (
    attempts.find(
      (x) => x.status === "fulfilled",
    ) as PromiseFulfilledResult<any>
  ).value;
  event = await api(path + "/" + event.id, "PUT", {
    deleted: true,
    expectedUpdatedAt: event.updatedAt,
    editSharedCanon: true,
  });
  event = await api(other + "/" + event.id, "PUT", {
    deleted: false,
    expectedUpdatedAt: event.updatedAt,
    editSharedCanon: true,
  });
  character = await store.editEntryField(
    companion.id,
    character.id,
    {
      value: 4,
      mode: "book",
      expectedUpdatedAt: character.updatedAt,
      expectedFieldUpdatedAt: field.updatedAt,
    },
    field.id,
  );
  const second = await api(other, "POST", {
    entryId: character.id,
    fieldId: field.id,
    value: 5,
    nodeId: otherScene.id,
    expectedEntryUpdatedAt: character.updatedAt,
    expectedFieldUpdatedAt: field.updatedAt,
    editSharedCanon: true,
  });
  const c = await api(other);
  assert.equal(
    resolveState(character, field.id, companion.id, otherChapter.id, c).value,
    4,
  );
  assert.equal(
    resolveState(character, field.id, companion.id, otherScene.id, c).value,
    5,
  );
  await stop();
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
  await start(store);
  const persisted = (await api(path)).stateChanges.find(
    (x: any) => x.id === event.id,
  );
  assert.deepEqual(persisted, event);
  const backup = await db.transaction((q) => captureBook(q, book.id));
  await db.query("CREATE DATABASE state_recovery_scratch");
  url.pathname = "/state_recovery_scratch";
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
    "PASS: real PostgreSQL state changes API/shared CAS/Trash/restore, restart persistence and exact whole-library recovery.",
  );
} finally {
  await stop();
  await target?.close();
  await db?.close();
  if (created) {
    await run("rm", "-f", "-v", name);
    console.log(
      "Removed disposable state changes API PostgreSQL container and anonymous volume.",
    );
  }
}
