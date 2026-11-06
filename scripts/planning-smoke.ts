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
const name = "rolltop-planning-" + randomBytes(4).toString("hex"),
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
  const part = await store.createNode(book.id, "Act I", "part"),
    chapter = await store.createNode(book.id, "Chapter", "chapter", part.id),
    scene = await store.createNode(book.id, "Scene", "scene", chapter.id);
  const hero = await store.createEntry(book.id, {
      name: "Hero",
      entryType: "character",
      scopeKind: "universe",
    }),
    place = await store.createEntry(book.id, {
      name: "Home",
      entryType: "location",
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
          content: [{ type: "text", text: "Three saved words." }],
        },
      ],
    },
    doc.revision,
  );
  const prose = await store.document(scene.id);
  await start(store);
  const path = "/books/" + book.id + "/planning",
    node = "/books/" + book.id + "/nodes/" + chapter.id + "/planning";
  await api(path, "PUT", {
    expectedUpdatedAt: (await store.book(book.id)).book.updatedAt,
    logline: "A story",
    premise: "Premise",
    themes: "Themes",
    arcs: "Arcs",
    principles: "Principles",
  });
  const plan = {
    expectedUpdatedAt: chapter.updatedAt,
    targetWordCount: 100,
    plan: "Chapter beats",
    synopsis: "",
    status: "Draft",
    povEntryId: hero.id,
    settingEntryId: place.id,
  };
  const races = await Promise.allSettled([
    api(node, "PUT", plan),
    api(node, "PUT", plan),
  ]);
  assert.equal(races.filter((r) => r.status === "fulfilled").length, 1);
  assert.match(
    String(
      (races.find((r) => r.status === "rejected") as PromiseRejectedResult)
        .reason,
    ),
    /409/,
  );
  const p = await api(
    "/books/" + book.id + "/nodes/" + part.id + "/planning",
    "PUT",
    {
      expectedUpdatedAt: part.updatedAt,
      targetWordCount: 1000,
      plan: "Act beats",
    },
  );
  let result = await api(path);
  assert.equal(result.words, 3);
  assert.equal(result.nodeWords[part.id], 3);
  assert.equal(result.nodeWords[chapter.id], 3);
  assert.equal(result.nodeWords[scene.id], 3);
  assert.equal(
    result.nodes.find((n: any) => n.id === chapter.id).povEntryId,
    hero.id,
  );
  const current = result.nodes.find((n: any) => n.id === chapter.id);
  const cleared = await api(node, "PUT", {
    expectedUpdatedAt: current.updatedAt,
    synopsis: null,
    settingEntryId: null,
  });
  assert.equal(Object.hasOwn(cleared, "synopsis"), false);
  assert.equal(Object.hasOwn(cleared, "settingEntryId"), false);
  assert.equal(cleared.povEntryId, hero.id);
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
      table + " unchanged by planning read",
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
  await db.query("CREATE DATABASE planning_recovery_scratch");
  url.pathname = "/planning_recovery_scratch";
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
    "PASS: real PostgreSQL planning API/CAS/optional clearing/read-only checks, restart persistence and exact whole-library recovery.",
  );
} finally {
  await stop();
  await target?.close();
  await db?.close();
  if (created) {
    await run("rm", "-f", "-v", name);
    console.log(
      "Removed disposable planning PostgreSQL container and anonymous volume.",
    );
  }
}
