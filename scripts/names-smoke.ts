// SPDX-License-Identifier: AGPL-3.0-only
// Bounded real-PostgreSQL continuity API check. Uses only its own disposable container.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { postgres } from "../packages/studio/src/postgres.ts";
import { StudioStore } from "../packages/studio/src/store.ts";
import { saveFact } from "../packages/studio/src/facts.ts";
import { saveQuestion } from "../packages/studio/src/questions.ts";
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
const name = "rolltop-names-" + randomBytes(4).toString("hex"),
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
  const library = await store.createLibrary("Continuity scratch"),
    book = await store.createBook(library.id, "First book"),
    companion = await store.createBook(library.id, "Second book");
  const world = await editWorld(db, library.id, "universes", {
    title: "Continuity world",
  });
  for (const b of [book, companion])
    await bookMembership(db, b.id, {
      universeId: world.id,
      expectedUpdatedAt: b.updatedAt,
    });
  const chapter = await store.createNode(book.id, "Chapter", "chapter"),
    scene = await store.createNode(book.id, "Scene", "scene", chapter.id);
  const entry = await store.createEntry(book.id, {
    name: "[Keeper]",
    entryType: "character",
    scopeKind: "universe",
    summary: "Lives in [place]",
    toBeNamed: true,
  });
  await saveFact(db, book.id, {
    scopeKind: "universe",
    text: "The [Keeper] knows [place].",
  });
  const doc = await store.document(scene.id);
  await store.save(
    scene.id,
    {
      ...doc.document,
      blocks: [
        {
          id: crypto.randomUUID(),
          type: "paragraph",
          content: [
            { type: "text", text: "[Scene " },
            { type: "text", text: "name] [Scene name]" },
          ],
        },
      ],
    },
    doc.revision,
  );
  const prose = await store.document(scene.id);
  await start(store);
  const path = "/books/" + book.id + "/names-needed",
    other = "/books/" + companion.id + "/names-needed",
    owner = "/books/" + book.id + "/entries/" + entry.id;
  let result = await api(path);
  assert.equal(result.items.length, 6);
  assert.equal((await api(other)).items.length, 5);
  const patch = {
    expectedUpdatedAt: entry.updatedAt,
    toBeNamed: false,
    editSharedCanon: true,
  };
  const races = await Promise.allSettled([
    api(owner, "PUT", patch),
    api("/books/" + companion.id + "/entries/" + entry.id, "PUT", patch),
  ]);
  assert.equal(races.filter((r) => r.status === "fulfilled").length, 1);
  assert.match(
    String(
      (races.find((r) => r.status === "rejected") as PromiseRejectedResult)
        .reason,
    ),
    /409/,
  );
  result = await api(path);
  assert.equal(result.items.filter((n: any) => n.source === "flag").length, 0);
  assert.equal((await api(other)).items.length, 4);
  assert.deepEqual(await store.document(scene.id), prose);
  const beforeRead = await db.transaction((q) => captureBook(q, book.id));
  result = await api(path);
  const afterRead = await db.transaction((q) => captureBook(q, book.id));
  const sorted = (rows: any[]) =>
    JSON.parse(JSON.stringify(rows)).sort((a: any, b: any) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    );
  for (const table of backupTables)
    assert.deepEqual(
      sorted(afterRead.tables[table]),
      sorted(beforeRead.tables[table]),
      table + " unchanged by names read",
    );
  const expected = result;
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
  const persisted = await api(path);
  assert.deepEqual(persisted, expected);
  const backup = await db.transaction((q) => captureBook(q, book.id));
  await db.query("CREATE DATABASE names_recovery_scratch");
  url.pathname = "/names_recovery_scratch";
  target = postgres(url.href);
  const recovery = new StudioStore(target);
  await recovery.migrate();
  await target.transaction((q) => restoreBookBackup(q, backup));
  const restored = await target.transaction((q) => captureBook(q, book.id));
  for (const table of backupTables)
    assert.deepEqual(
      sorted(restored.tables[table]),
      sorted(backup.tables[table]),
      table,
    );
  console.log(
    "PASS: real PostgreSQL names/flag shared-CAS/read-only checks, restart persistence and exact whole-library recovery.",
  );
} finally {
  await stop();
  await target?.close();
  await db?.close();
  if (created) {
    await run("rm", "-f", "-v", name);
    console.log(
      "Removed disposable names PostgreSQL container and anonymous volume.",
    );
  }
}
