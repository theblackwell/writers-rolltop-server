// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support.ts";
import { studioServer } from "../src/http.ts";
import { passwordHash } from "../src/auth.ts";
import { saveFact } from "../src/facts.ts";
import { knowledgeCatalog } from "../src/knowledge.ts";
import type { Database } from "../src/store.ts";
test("knowledge and warning endpoints enforce authentication, same-origin writes, IDs, notes and restored visibility", async () => {
  const f = await fixture(),
    origin = "http://localhost:4317",
    server = studioServer(f.store, {
      origin,
      passwordHash: await passwordHash("scratch-knowledge"),
    });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + (server.address() as any).port + "/api";
  let cookie = "";
  const req = (path: string, method = "GET", value?: object, from = origin) =>
    fetch(base + path, {
      method,
      headers: {
        Cookie: cookie,
        Origin: from,
        "Content-Type": "application/json",
      },
      ...(value ? { body: JSON.stringify(value) } : {}),
    });
  try {
    const path = "/books/" + f.book.id,
      knowledge = path + "/knowledge?asOf=" + f.scene.id,
      dismiss = path + "/continuity/dismissals";
    assert.equal((await req(knowledge)).status, 401);
    assert.equal((await req(dismiss, "PUT", {})).status, 401);
    cookie = (
      await req("/login", "POST", { password: "scratch-knowledge" })
    ).headers
      .get("set-cookie")!
      .split(";")[0];
    assert.equal((await req(path + "/knowledge?asOf=bad")).status, 400);
    assert.equal(
      (await req(dismiss, "PUT", {}, "https://evil.example")).status,
      403,
    );
    const fact = await saveFact(f.store.db, f.book.id, {
      text: "A mistaken belief",
      truth: "undecided",
      knowledge: [{ knower: "reader", nodeId: f.scene.id }],
    });
    let k = await (await req(knowledge)).json();
    assert.equal(k.groups[0].facts[0].id, fact.id);
    assert.equal(k.groups[0].facts[0].truth, "undecided");
    const args = {
      subjectKind: "fact",
      subjectId: fact.id,
      key: "undecidedButKnown",
      expectedUpdatedAt: fact.updatedAt,
      note: "Intentional",
    };
    let r = await req(dismiss, "PUT", args);
    assert.equal(r.status, 200);
    let c = await r.json();
    assert.equal(c.intentionalWarnings.length, 1);
    assert.equal(c.warnings.length, 0);
    assert.equal((await req(dismiss, "PUT", args)).status, 409);
    assert.equal(
      (
        await req(dismiss, "PUT", {
          ...args,
          expectedUpdatedAt: c.subjects[0].updatedAt,
          note: "x".repeat(2001),
        })
      ).status,
      400,
    );
    const restored = await req(dismiss, "PUT", {
      subjectKind: "fact",
      subjectId: fact.id,
      key: "undecidedButKnown",
      expectedUpdatedAt: c.subjects[0].updatedAt,
      restore: true,
    });
    assert.equal(restored.status, 200);
    c = await restored.json();
    assert.equal(c.warnings.length, 1);
    const foreignLib = await f.store.createLibrary("Foreign"),
      foreign = await f.store.createBook(foreignLib.id, "Foreign");
    assert.equal(
      (
        await req("/books/" + foreign.id + "/continuity/dismissals", "PUT", {
          ...args,
          expectedUpdatedAt: c.subjects[0].updatedAt,
        })
      ).status,
      404,
    );
    assert.equal(
      (await req("/books/" + foreign.id + "/knowledge?asOf=" + f.scene.id))
        .status,
      400,
    );
    await f.store.trashBook(f.book.id);
    assert.equal((await req(knowledge)).status, 400);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.pg.close();
  }
});
test("knowledge uses a bounded record snapshot without reading prose, questions or state changes", async () => {
  const f = await fixture();
  try {
    for (const source of ["books", "bible_entries", "facts", "nodes"]) {
      const db: Database = {
        ...f.store.db,
        transaction: (fn) =>
          f.store.db.transaction((q) =>
            fn(async (sql, p) => {
              if (sql.startsWith("SELECT (SELECT")) {
                assert.ok(!sql.includes("FROM documents"));
                assert.ok(!sql.includes("FROM questions"));
                assert.ok(!sql.includes("FROM state_changes"));
                const r = await q(sql, p);
                return {
                  rows: [{ ...r.rows[0], [source]: Array(10001).fill({}) }],
                };
              }
              return q(sql, p);
            }),
          ),
      };
      await assert.rejects(
        () => knowledgeCatalog(db, f.book.id),
        /No records were omitted/,
      );
    }
    const k = await knowledgeCatalog(f.store.db, f.book.id);
    assert.equal(k.pointId, f.scene.id);
    assert.deepEqual(
      k.nodes.map((n) => n.id),
      [f.chapter.id, f.scene.id],
    );
    await f.store.trashNode(f.chapter.id);
    assert.deepEqual((await knowledgeCatalog(f.store.db, f.book.id)).nodes, []);
  } finally {
    await f.pg.close();
  }
});
