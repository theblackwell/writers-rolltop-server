// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support.ts";
import { studioServer } from "../src/http.ts";
import { passwordHash } from "../src/auth.ts";
import { editWorld, bookMembership } from "../src/worlds.ts";
import { stateCatalog } from "../src/state-changes.ts";
import type { Database } from "../src/store.ts";
test("state APIs enforce authentication, origin, ownership, typed CAS and shared cross-book edits", async () => {
  const f = await fixture(),
    origin = "http://localhost:4317",
    server = studioServer(f.store, {
      origin,
      passwordHash: await passwordHash("scratch-state"),
    });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + (server.address() as any).port + "/api";
  let cookie = "";
  const req = (path: string, method = "GET", value?: any, from = origin) =>
    fetch(base + path, {
      method,
      headers: {
        Cookie: cookie,
        Origin: from,
        "Content-Type": "application/json",
      },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
  try {
    const path = "/books/" + f.book.id + "/state-changes";
    assert.equal((await req(path)).status, 401);
    cookie = (
      await req("/login", "POST", { password: "scratch-state" })
    ).headers
      .get("set-cookie")!
      .split(";")[0];
    assert.equal(
      (await req(path, "POST", {}, "https://evil.example")).status,
      403,
    );
    assert.equal((await req("/books/no/state-changes")).status, 400);
    assert.equal((await req(path + "/bad", "PUT", {})).status, 400);
    const world = await editWorld(f.store.db, f.library.id, "universes", {
      title: "World",
    });
    await bookMembership(f.store.db, f.book.id, {
      universeId: world.id,
      expectedUpdatedAt: f.book.updatedAt,
    });
    const other = await f.store.createBook(f.library.id, "Other");
    await bookMembership(f.store.db, other.id, {
      universeId: world.id,
      expectedUpdatedAt: other.updatedAt,
    });
    let entry = await f.store.createEntry(f.book.id, {
      name: "Person",
      entryType: "character",
      scopeKind: "universe",
    });
    const catalog = await f.store.templates(f.library.id),
      template = catalog.templates.find((t) => t.entryType === "character")!,
      field = catalog.fields.find(
        (x) => x.templateId === template.id && x.fieldType === "integer",
      )!;
    entry = await f.store.editEntryField(f.book.id, entry.id, {
      templateId: template.id,
      expectedUpdatedAt: entry.updatedAt,
      expectedTemplateUpdatedAt: template.updatedAt,
      editSharedCanon: true,
    });
    const input = {
      entryId: entry.id,
      fieldId: field.id,
      value: 0,
      nodeId: f.scene.id,
      expectedEntryUpdatedAt: entry.updatedAt,
      expectedFieldUpdatedAt: field.updatedAt,
      editSharedCanon: true,
    };
    assert.equal(
      (await req(path, "POST", { ...input, extra: true })).status,
      400,
    );
    assert.equal(
      (await req(path, "POST", { ...input, value: null })).status,
      400,
    );
    const created = await req(path, "POST", input);
    assert.equal(created.status, 201);
    let c = await created.json();
    const otherPath = "/books/" + other.id + "/state-changes";
    assert.equal(
      (await (await req(otherPath)).json()).stateChanges[0].id,
      c.id,
    );
    const results = await Promise.all(
      [path, otherPath].map((p, i) =>
        req(p + "/" + c.id, "PUT", {
          ...input,
          value: i + 1,
          expectedUpdatedAt: c.updatedAt,
        }),
      ),
    );
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    c = await results.find((r) => r.status === 200)!.json();
    for (const deleted of [true, false]) {
      const r = await req(path + "/" + c.id, "PUT", {
        deleted,
        expectedUpdatedAt: c.updatedAt,
        editSharedCanon: true,
      });
      assert.equal(r.status, 200);
      c = await r.json();
      assert.equal(!!c.deletedAt, deleted);
    }
    const foreignLib = await f.store.createLibrary("Foreign"),
      foreign = await f.store.createBook(foreignLib.id, "Foreign");
    assert.equal(
      (
        await req("/books/" + foreign.id + "/state-changes/" + c.id, "PUT", {
          ...input,
          expectedUpdatedAt: c.updatedAt,
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await req(path + "/" + c.id, "PUT", {
          ...input,
          expectedEntryUpdatedAt: "stale",
          expectedUpdatedAt: c.updatedAt,
        })
      ).status,
      409,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.pg.close();
  }
});
test("state catalog refuses oversized dependency sources explicitly and never reads facts or questions", async () => {
  const f = await fixture();
  try {
    for (const table of [
      "books",
      "bible_entries",
      "bible_fields",
      "bible_templates",
      "continuity_events",
      "state_changes",
      "universes",
      "series",
    ]) {
      const db: Database = {
        ...f.store.db,
        transaction: (fn) =>
          f.store.db.transaction((q) =>
            fn((sql, p) => {
              assert.ok(
                !sql.startsWith("SELECT data FROM facts") &&
                  !sql.startsWith("SELECT data FROM questions"),
              );
              return sql.startsWith("SELECT data FROM " + table + " ")
                ? Promise.resolve({ rows: Array(10001).fill({ data: {} }) })
                : q(sql, p);
            }),
          ),
      };
      await assert.rejects(
        () => stateCatalog(db, f.book.id),
        /No records were omitted/,
      );
    }
  } finally {
    await f.pg.close();
  }
});
