// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support.ts";
import type { Database } from "../src/store.ts";
import { studioServer } from "../src/http.ts";
import { passwordHash } from "../src/auth.ts";
import { editWorld, bookMembership } from "../src/worlds.ts";
import { questionCatalog } from "../src/questions.ts";
import { captureBook, restoreBookBackup, backupTables } from "../src/backup.ts";

test("question APIs preserve canonical decisions and opaque data with auth, scope, CAS, Trash and exact recovery", async () => {
  const f = await fixture(),
    recovered = await fixture();
  const origin = "http://localhost:4317",
    server = studioServer(f.store, {
      origin,
      passwordHash: await passwordHash("scratch-questions"),
    });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  let cookie = "";
  const req = (path: string, method = "GET", body?: any, from = origin) =>
    fetch(base + path, {
      method,
      headers: {
        Cookie: cookie,
        Origin: from,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    const path = `/books/${f.book.id}/questions`;
    assert.equal((await req(path)).status, 401);
    const login = await req("/login", "POST", {
      password: "scratch-questions",
    });
    cookie = login.headers.get("set-cookie")!.split(";")[0];
    assert.equal(
      (await req(path, "POST", { text: "No" }, "https://evil.example")).status,
      403,
    );
    assert.equal((await req("/books/no/questions")).status, 400);
    assert.equal((await req(path + "/bad", "PUT", {})).status, 400);
    const world = await editWorld(f.store.db, f.library.id, "universes", {
      title: "World",
    });
    await bookMembership(f.store.db, f.book.id, {
      universeId: world.id,
      expectedUpdatedAt: f.book.updatedAt,
    });
    const other = await f.store.createBook(f.library.id, "Companion");
    await bookMembership(f.store.db, other.id, {
      universeId: world.id,
      expectedUpdatedAt: other.updatedAt,
    });
    const foreignLib = await f.store.createLibrary("Foreign"),
      foreign = await f.store.createBook(foreignLib.id, "Foreign");
    const term = await f.store.createEntry(other.id, {
      name: "Cross-book about",
      entryType: "term",
    });
    const local = await (await req(path, "POST", { text: "Local?" })).json();
    const created = await req(path, "POST", {
      text: "Why?",
      topic: "Mystery",
      status: "decided",
      decision: "",
      entryIds: [term.id],
      nodeId: f.scene.id,
      scopeKind: "universe",
    });
    assert.equal(created.status, 201);
    let q = await created.json();
    assert.equal(q.decision, "");
    await f.store.db.query(
      "UPDATE questions SET data=data || $2::jsonb WHERE id=$1",
      [
        q.id,
        {
          opaque: { keep: true },
          dismissedWarnings: [
            { warning: "questionOverdue:abc", dismissedAt: q.updatedAt },
          ],
        },
      ],
    );
    const before = await f.store.db.transaction((x) =>
      captureBook(x, f.book.id),
    );
    const catalog = await (await req(path)).json();
    assert.equal(catalog.questions.length, 2);
    assert.ok(
      catalog.entries
        .find((e: any) => e.id === term.id)
        .scopeTitle.includes("Companion"),
    );
    assert.ok(catalog.nodes.some((n: any) => n.id === f.scene.id));
    assert.deepEqual(
      (await f.store.db.transaction((x) => captureBook(x, f.book.id))).tables,
      before.tables,
      "GET is read-only",
    );
    const otherPath = `/books/${other.id}/questions`;
    assert.deepEqual(
      (await (await req(otherPath)).json()).questions.map((x: any) => x.id),
      [q.id],
    );
    assert.equal(
      (
        await req(`/books/${foreign.id}/questions/${q.id}`, "PUT", {
          expectedUpdatedAt: q.updatedAt,
          editSharedCanon: true,
          text: "Steal",
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await req(otherPath + `/${local.id}`, "PUT", {
          expectedUpdatedAt: local.updatedAt,
          text: "Hidden",
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await req(path + `/${q.id}`, "PUT", {
          expectedUpdatedAt: q.updatedAt,
          text: "No consent",
        })
      ).status,
      400,
    );
    for (const patch of [
      { extra: true },
      { scopeKind: "book" },
      { topic: "" },
      { topic: "x".repeat(65) },
      { decision: "x".repeat(20001) },
      { status: "maybe" },
      { entryIds: [term.id, term.id] },
      { entryIds: [crypto.randomUUID()] },
      { nodeId: crypto.randomUUID() },
    ]) {
      assert.equal(
        (
          await req(path + `/${q.id}`, "PUT", {
            expectedUpdatedAt: q.updatedAt,
            editSharedCanon: true,
            ...patch,
          })
        ).status,
        400,
      );
    }
    const results = await Promise.all([
      req(path + `/${q.id}`, "PUT", {
        expectedUpdatedAt: q.updatedAt,
        editSharedCanon: true,
        text: "First",
      }),
      req(otherPath + `/${q.id}`, "PUT", {
        expectedUpdatedAt: q.updatedAt,
        editSharedCanon: true,
        text: "Second",
      }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    q = await results.find((r) => r.status === 200)!.json();
    assert.deepEqual(q.opaque, { keep: true });
    assert.equal(q.dismissedWarnings.length, 1);
    assert.equal(q.topic, "Mystery");
    assert.equal(q.decision, "");
    q = await (
      await req(path + `/${q.id}`, "PUT", {
        expectedUpdatedAt: q.updatedAt,
        editSharedCanon: true,
        topic: null,
        decision: null,
        nodeId: null,
      })
    ).json();
    assert.equal(q.status, "decided", "decided without answer is valid");
    assert.equal(q.topic, undefined);
    assert.equal(q.decision, undefined);
    assert.equal(q.nodeId, undefined);
    q = await (
      await req(path + `/${q.id}`, "PUT", {
        expectedUpdatedAt: q.updatedAt,
        editSharedCanon: true,
        status: "open",
        decision: "Retained while open",
      })
    ).json();
    assert.equal(q.decision, "Retained while open");
    q = await (
      await req(path + `/${q.id}`, "PUT", {
        expectedUpdatedAt: q.updatedAt,
        editSharedCanon: true,
        deleted: true,
      })
    ).json();
    assert.ok(q.deletedAt);
    assert.ok((await (await req(otherPath)).json()).questions[0].deletedAt);
    q = await (
      await req(otherPath + `/${q.id}`, "PUT", {
        expectedUpdatedAt: q.updatedAt,
        editSharedCanon: true,
        deleted: false,
      })
    ).json();
    assert.equal(q.deletedAt, undefined);
    const backup = await f.store.db.transaction((x) =>
      captureBook(x, f.book.id),
    );
    await recovered.store.db.transaction(async (x) => {
      for (const t of [...backupTables].reverse()) await x(`DELETE FROM ${t}`);
      await restoreBookBackup(x, backup);
    });
    assert.deepEqual(
      (await recovered.store.db.transaction((x) => captureBook(x, f.book.id)))
        .tables,
      backup.tables,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.pg.close();
    await recovered.pg.close();
  }
});

test("question catalog includes retained Trash labels and refuses oversized sources without coupling to facts", async () => {
  const f = await fixture();
  try {
    await f.store.trashNode(f.chapter.id);
    const c = await questionCatalog(f.store.db, f.book.id);
    assert.equal(c.nodes.find((n: any) => n.id === f.scene.id)!.inTrash, true);
    let factRead = false;
    const db: Database = {
      ...f.store.db,
      transaction: (fn: any) =>
        f.store.db.transaction((x) =>
          fn(async (sql: string, params?: any[]) => {
            if (sql.startsWith("SELECT data FROM facts")) factRead = true;
            return sql.startsWith("SELECT data FROM questions")
              ? { rows: Array(10001).fill({ data: {} }) }
              : x(sql, params);
          }),
        ),
    };
    await assert.rejects(
      () => questionCatalog(db, f.book.id),
      /No records were omitted/,
    );
    assert.equal(factRead, false);
    const foreign = await f.store.createLibrary("Other"),
      other = await f.store.createBook(foreign.id, "Other");
    await f.store.createEntry(other.id, {
      name: "Invisible",
      entryType: "term",
    });
    assert.equal(
      (await questionCatalog(f.store.db, f.book.id)).entries.some(
        (e: any) => e.name === "Invisible",
      ),
      false,
    );
    await f.store.trashBook(f.book.id);
    await assert.rejects(
      () => questionCatalog(f.store.db, f.book.id),
      /Restore the book/,
    );
  } finally {
    await f.pg.close();
  }
});
