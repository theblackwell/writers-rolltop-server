// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support.ts";
import type { Database } from "../src/store.ts";
import { studioServer } from "../src/http.ts";
import { passwordHash } from "../src/auth.ts";
import { editWorld, bookMembership } from "../src/worlds.ts";
import { captureBook, restoreBookBackup, backupTables } from "../src/backup.ts";

test("fact HTTP catalog and edits enforce auth/origin/IDs, shared scope, knowledge, CAS and recovery without changing prose", async () => {
  const f = await fixture(),
    recovered = await fixture();
  const origin = "http://localhost:4317",
    server = studioServer(f.store, {
      origin,
      passwordHash: await passwordHash("scratch-facts"),
    });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  let cookie = "";
  const request = (path: string, method = "GET", value?: any, from = origin) =>
    fetch(base + path, {
      method,
      headers: {
        Cookie: cookie,
        Origin: from,
        "Content-Type": "application/json",
      },
      ...(value !== undefined ? { body: JSON.stringify(value) } : {}),
    });
  try {
    const path = `/books/${f.book.id}/facts`;
    assert.equal((await request(path)).status, 401);
    const login = await request("/login", "POST", {
      password: "scratch-facts",
    });
    cookie = login.headers.get("set-cookie")!.split(";")[0];
    assert.equal(
      (await request(path, "POST", { text: "No" }, "https://evil.example"))
        .status,
      403,
    );
    assert.equal((await request("/books/no/facts")).status, 400);
    assert.equal((await request(path + "/bad", "PUT", {})).status, 400);
    const world = await editWorld(f.store.db, f.library.id, "universes", {
      title: "World",
    });
    await bookMembership(f.store.db, f.book.id, {
      universeId: world.id,
      expectedUpdatedAt: f.book.updatedAt,
    });
    const companion = await f.store.createBook(f.library.id, "Companion"),
      foreignLibrary = await f.store.createLibrary("Foreign"),
      foreign = await f.store.createBook(foreignLibrary.id, "Foreign book");
    await bookMembership(f.store.db, companion.id, {
      universeId: world.id,
      expectedUpdatedAt: companion.updatedAt,
    });
    const character = await f.store.createEntry(companion.id, {
        name: "Cross-book knower",
        entryType: "character",
      }),
      term = await f.store.createEntry(f.book.id, {
        name: "Term",
        entryType: "term",
      });
    const local = await (
      await request(path, "POST", { text: "Book fact" })
    ).json();
    const payload = {
      text: "A secret is believed",
      truth: "false",
      scopeKind: "universe",
      nodeId: f.scene.id,
      entryIds: [term.id],
      knowledge: [
        { knower: "reader", nodeId: f.chapter.id },
        { knower: character.id },
      ],
    };
    const created = await request(path, "POST", payload);
    assert.equal(created.status, 201);
    let fact = await created.json();
    await f.store.db.query(
      "UPDATE facts SET data=data || $2::jsonb WHERE id=$1",
      [
        fact.id,
        {
          opaque: { keep: true },
          dismissedWarnings: [
            { warning: "undecidedButKnown", dismissedAt: fact.updatedAt },
          ],
        },
      ],
    );
    const before = await f.store.db.transaction((q) =>
      captureBook(q, f.book.id),
    );
    const catalog = await (await request(path)).json();
    assert.equal(catalog.facts.length, 2);
    assert.ok(catalog.scopes.some((s: any) => s.kind === "universe"));
    assert.ok(catalog.entries.some((e: any) => e.id === character.id));
    assert.ok(catalog.nodes.some((n: any) => n.id === f.scene.id));
    const after = await f.store.db.transaction((q) =>
      captureBook(q, f.book.id),
    );
    assert.deepEqual(after.tables, before.tables, "GET is read-only");
    const otherPath = `/books/${companion.id}/facts`;
    assert.deepEqual(
      (await (await request(otherPath)).json()).facts.map((x: any) => x.id),
      [fact.id],
    );
    assert.equal(
      (
        await request(`/books/${foreign.id}/facts/${fact.id}`, "PUT", {
          text: "steal",
          expectedUpdatedAt: fact.updatedAt,
          editSharedCanon: true,
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await request(otherPath + `/${local.id}`, "PUT", {
          text: "hidden",
          expectedUpdatedAt: local.updatedAt,
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await request(path + `/${fact.id}`, "PUT", {
          text: "no shared consent",
          expectedUpdatedAt: fact.updatedAt,
        })
      ).status,
      400,
    );
    for (const patch of [
      { extra: true },
      { scopeKind: "book" },
      { knowledge: [{ knower: "reader" }, { knower: "reader" }] },
      { knowledge: [{ knower: term.id }] },
      { truth: "maybe" },
      { entryIds: [crypto.randomUUID()] },
      { nodeId: crypto.randomUUID() },
    ])
      assert.equal(
        (
          await request(path + `/${fact.id}`, "PUT", {
            expectedUpdatedAt: fact.updatedAt,
            editSharedCanon: true,
            ...patch,
          })
        ).status,
        400,
      );
    const results = await Promise.all([
      request(path + `/${fact.id}`, "PUT", {
        text: "First",
        expectedUpdatedAt: fact.updatedAt,
        editSharedCanon: true,
      }),
      request(otherPath + `/${fact.id}`, "PUT", {
        text: "Second",
        expectedUpdatedAt: fact.updatedAt,
        editSharedCanon: true,
      }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    fact = await results.find((r) => r.status === 200)!.json();
    assert.deepEqual(fact.knowledge, payload.knowledge);
    assert.deepEqual(fact.entryIds, payload.entryIds);
    assert.deepEqual(fact.opaque, { keep: true });
    assert.equal(fact.dismissedWarnings.length, 1);
    fact = await (
      await request(otherPath + `/${fact.id}`, "PUT", {
        deleted: true,
        expectedUpdatedAt: fact.updatedAt,
        editSharedCanon: true,
      })
    ).json();
    assert.ok(fact.deletedAt);
    assert.ok(
      (await (await request(path)).json()).facts.find(
        (x: any) => x.id === fact.id,
      ).deletedAt,
    );
    fact = await (
      await request(path + `/${fact.id}`, "PUT", {
        deleted: false,
        expectedUpdatedAt: fact.updatedAt,
        editSharedCanon: true,
      })
    ).json();
    assert.equal(fact.deletedAt, undefined);
    const backup = await f.store.db.transaction((q) =>
      captureBook(q, f.book.id),
    );
    await recovered.store.db.transaction(async (q) => {
      for (const t of [...backupTables].reverse()) await q(`DELETE FROM ${t}`);
      await restoreBookBackup(q, backup);
    });
    assert.deepEqual(
      (await recovered.store.db.transaction((q) => captureBook(q, f.book.id)))
        .tables.facts,
      backup.tables.facts,
    );
    assert.deepEqual(
      (await f.store.document(f.scene.id)).document,
      (await recovered.store.document(f.scene.id)).document,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.pg.close();
    await recovered.pg.close();
  }
});

test("fact catalog labels retained Trash dependencies and rejects silent catalog truncation", async () => {
  const f = await fixture();
  try {
    const { factCatalog } = await import("../src/facts.ts");
    await f.store.trashNode(f.chapter.id);
    const c = await factCatalog(f.store.db, f.book.id);
    assert.equal(c.nodes.find((n: any) => n.id === f.scene.id)!.inTrash, true);
    const db: Database = {
      ...f.store.db,
      transaction: (fn: any) =>
        f.store.db.transaction((q) =>
          fn(async (sql: string, params?: any[]) =>
            sql.startsWith("SELECT data FROM facts")
              ? { rows: Array(10001).fill({ data: {} }) }
              : q(sql, params),
          ),
        ),
    };
    await assert.rejects(
      () => factCatalog(db, f.book.id),
      /No records were omitted/,
    );
  } finally {
    await f.pg.close();
  }
});
