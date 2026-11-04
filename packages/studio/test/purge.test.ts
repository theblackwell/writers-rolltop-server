// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fixture } from "./support.ts";
import { StudioStore } from "../src/store.ts";
import {
  captureBook,
  readBookBackup,
  restoreBookBackup,
  backupTables,
} from "../src/backup.ts";
import { studioServer } from "../src/http.ts";
import { passwordHash } from "../src/auth.ts";
const confirm = (item: any) => ({
  confirmTitle: item.title,
  expectedDeletedAt: item.deletedAt,
});
const normalized = (v: any) => JSON.parse(JSON.stringify(v));
async function rows(store: StudioStore, bookId: string) {
  const b = await store.db.transaction((q) => captureBook(q, bookId));
  return Object.fromEntries(
    backupTables.map((t) => [
      t,
      normalized(b.tables[t]).sort((a: any, b: any) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
      ),
    ]),
  );
}
test("purge fails closed, removes entire subtree and pinned notes, preserves siblings and restores backup", async () => {
  const f = await fixture();
  const scratch = await fixture();
  const dir = await mkdtemp(join(tmpdir(), "rolltop-purge-"));
  try {
    const sibling = await f.store.createNode(f.book.id, "Keep", "chapter");
    const kept = await f.store.saveNote(f.book.id, { text: "Book note" });
    await f.store.saveNote(f.book.id, { text: "Pinned", nodeId: f.scene.id });
    const entry = await f.store.createEntry(f.book.id, {
      name: "Keep entry",
      entryType: "term",
    });
    await f.store.db.query(
      "INSERT INTO manuscript_references VALUES($1,$2,$3,$4)",
      [
        crypto.randomUUID(),
        f.scene.id,
        entry.id,
        { unknown: "keep in backup" },
      ],
    );
    await assert.rejects(
      () => f.store.purge("node", f.chapter.id, confirm(f.chapter)),
      /Trash/,
    );
    await f.store.trashNode(f.scene.id); // independently trashed descendant is also purged
    await f.store.trashNode(f.chapter.id);
    const chapter = (await f.store.book(f.book.id)).nodes.find(
      (n) => n.id === f.chapter.id,
    )!;
    const before = await rows(f.store, f.book.id);
    await assert.rejects(
      () => f.store.purge("node", chapter.id, confirm(chapter)),
      /configured/,
    );
    f.store.backupDirectory = join(dir, "missing-mount");
    await assert.rejects(
      () => f.store.purge("node", chapter.id, confirm(chapter)),
      /could not be verified/,
    );
    assert.deepEqual(await rows(f.store, f.book.id), before);
    assert.deepEqual(await readdir(dir), []);
    const blocker = join(dir, "blocked");
    await writeFile(blocker, "file");
    f.store.backupDirectory = blocker;
    await assert.rejects(
      () => f.store.purge("node", chapter.id, confirm(chapter)),
      /could not be verified/,
    );
    assert.deepEqual(await rows(f.store, f.book.id), before);
    f.store.backupDirectory = dir;
    await assert.rejects(
      () =>
        f.store.purge("node", chapter.id, {
          ...confirm(chapter),
          expectedDeletedAt: "stale",
        }),
      /changed/,
    );
    assert.equal((await readdir(dir)).length, 1);
    const receipt = await f.store.purge("node", chapter.id, confirm(chapter));
    assert.equal(receipt.deletedNodes, 2);
    assert.deepEqual(
      (await f.store.book(f.book.id)).nodes.map((n) => n.id),
      [sibling.id],
    );
    assert.deepEqual(
      (await f.store.notes(f.book.id)).map((n) => n.id),
      [kept.id],
    );
    assert.equal((await f.store.entries(f.book.id)).length, 1);
    for (const t of [
      "documents",
      "document_revisions",
      "manuscript_references",
    ])
      assert.equal(
        (await f.store.db.query(`SELECT * FROM ${t}`)).rows.length,
        0,
      );
    const backup = await readBookBackup(join(dir, receipt.backup));
    await scratch.store.db.transaction(async (q) => {
      for (const t of [...backupTables].reverse()) await q(`DELETE FROM ${t}`);
      await restoreBookBackup(q, backup);
    });
    assert.deepEqual(await rows(scratch.store, f.book.id), before);
    await assert.rejects(
      () => f.store.purge("node", chapter.id, confirm(chapter)),
      /no longer exists/,
    );
  } finally {
    await f.pg.close();
    await scratch.pg.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQL failure rolls back purge while retaining verified backup; book purge isolates other books", async () => {
  const f = await fixture();
  const dir = await mkdtemp(join(tmpdir(), "rolltop-purge-"));
  try {
    const other = await f.store.createBook(f.library.id, "Other");
    await f.store.createEntry(f.book.id, { name: "Remove", entryType: "term" });
    await f.store.saveNote(f.book.id, { text: "Remove" });
    await f.store.trashBook(f.book.id);
    const book = (await f.store.book(f.book.id)).book;
    const before = await rows(f.store, f.book.id);
    const broken = new StudioStore(
      {
        query: f.store.db.query,
        transaction: (fn) =>
          f.store.db.transaction((q) =>
            fn(async (sql, params) => {
              if (sql.startsWith("DELETE FROM manuscript_nodes"))
                throw new Error("injected SQL failure");
              return q(sql, params);
            }),
          ),
      },
      dir,
    );
    await assert.rejects(
      () => broken.purge("book", book.id, confirm(book)),
      /injected/,
    );
    assert.deepEqual(await rows(f.store, f.book.id), before);
    const files = await readdir(dir);
    assert.equal(files.length, 1);
    assert.equal((await readBookBackup(join(dir, files[0]))).bookId, book.id);
    f.store.backupDirectory = dir;
    await f.store.purge("book", book.id, confirm(book));
    assert.equal((await f.store.book(other.id)).book.title, "Other");
    for (const t of backupTables.filter(
      (t) =>
        !["libraries", "books", "bible_templates", "bible_fields"].includes(t),
    ))
      assert.equal(
        (await f.store.db.query(`SELECT * FROM ${t}`)).rows.length,
        0,
      );
    assert.equal(
      (await f.store.db.query("SELECT * FROM books")).rows.length,
      1,
    );
  } finally {
    await f.pg.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("purge HTTP requires login, origin, matching confirmation and returns a recovery receipt", async () => {
  const f = await fixture();
  const dir = await mkdtemp(join(tmpdir(), "rolltop-purge-http-"));
  f.store.backupDirectory = dir;
  const origin = "http://localhost:4317";
  const password = "scratch-only-delete-test";
  const server = studioServer(f.store, {
    origin,
    passwordHash: await passwordHash(password),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  let cookie = "";
  const request = (path: string, value: any, requestOrigin = origin) =>
    fetch(base + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: requestOrigin,
        Cookie: cookie,
      },
      body: JSON.stringify(value),
    });
  try {
    const path = `/books/${f.book.id}/purge`;
    assert.equal((await request(path, {})).status, 401);
    const login = await request("/login", { password });
    cookie = login.headers.get("set-cookie")!.split(";")[0];
    await f.store.trashBook(f.book.id);
    const book = (await f.store.book(f.book.id)).book;
    assert.equal(
      (await request(path, confirm(book), "https://evil.example")).status,
      403,
    );
    assert.equal((await request(path, {})).status, 409);
    const response = await request(path, confirm(book));
    assert.equal(response.status, 200);
    assert.match(
      (await response.json()).backup,
      /^[a-f0-9-]+\.book-recovery\.json$/,
    );
    assert.equal((await request(path, confirm(book))).status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.pg.close();
    await rm(dir, { recursive: true, force: true });
  }
});
