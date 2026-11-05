// SPDX-License-Identifier: AGPL-3.0-only
// Bounded real-PostgreSQL facts/API check. Uses only its own disposable container.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { postgres } from "../packages/studio/src/postgres.ts";
import { StudioStore } from "../packages/studio/src/store.ts";
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
const name = "rolltop-facts-api-" + randomBytes(4).toString("hex"),
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
  db = postgres(url.href);
  let store = new StudioStore(db);
  await store.migrate();
  const library = await store.createLibrary("Facts API scratch"),
    book = await store.createBook(library.id, "First book"),
    companion = await store.createBook(library.id, "Second book");
  const world = await editWorld(db, library.id, "universes", {
    title: "Facts world",
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
  await start(store);
  const path = `/books/${book.id}/facts`,
    other = `/books/${companion.id}/facts`;
  let fact = await api(path, "POST", {
    scopeKind: "universe",
    text: "A secret",
    truth: "false",
    entryIds: [entry.id],
    nodeId: scene.id,
    knowledge: [{ knower: "reader", nodeId: chapter.id }, { knower: entry.id }],
  });
  assert.equal((await api(other)).facts[0].id, fact.id);
  const attempts = await Promise.allSettled([
    api(path + `/${fact.id}`, "PUT", {
      text: "One",
      expectedUpdatedAt: fact.updatedAt,
      editSharedCanon: true,
    }),
    api(other + `/${fact.id}`, "PUT", {
      text: "Two",
      expectedUpdatedAt: fact.updatedAt,
      editSharedCanon: true,
    }),
  ]);
  assert.equal(attempts.filter((x) => x.status === "fulfilled").length, 1);
  assert.match(
    String(
      (attempts.find((x) => x.status === "rejected") as PromiseRejectedResult)
        .reason,
    ),
    /409/,
  );
  fact = (
    attempts.find(
      (x) => x.status === "fulfilled",
    ) as PromiseFulfilledResult<any>
  ).value;
  fact = await api(path + `/${fact.id}`, "PUT", {
    deleted: true,
    expectedUpdatedAt: fact.updatedAt,
    editSharedCanon: true,
  });
  fact = await api(other + `/${fact.id}`, "PUT", {
    deleted: false,
    expectedUpdatedAt: fact.updatedAt,
    editSharedCanon: true,
  });
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
  db = postgres(url.href);
  store = new StudioStore(db);
  await store.migrate();
  await start(store);
  const persisted = (await api(path)).facts[0];
  assert.deepEqual(persisted, fact);
  const backup = await db.transaction((q) => captureBook(q, book.id));
  await db.query("CREATE DATABASE facts_recovery_scratch");
  url.pathname = "/facts_recovery_scratch";
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
    "PASS: real PostgreSQL facts API/shared CAS/Trash/restore, restart persistence and exact whole-library recovery.",
  );
} finally {
  await stop();
  await target?.close();
  await db?.close();
  if (created) {
    await run("rm", "-f", "-v", name);
    console.log(
      "Removed disposable facts API PostgreSQL container and anonymous volume.",
    );
  }
}
