// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fixture, removeRelationshipSchema } from "./support.ts";
import { StudioStore } from "../src/store.ts";
import { editWorld, bookMembership } from "../src/worlds.ts";
import {
  relationshipCatalog,
  editRelationship,
  editRelationshipType,
} from "../src/relationships.ts";
import {
  backupTables,
  captureBook,
  readBookBackup,
  restoreBookBackup,
} from "../src/backup.ts";
import { studioServer } from "../src/http.ts";
import { passwordHash } from "../src/auth.ts";
async function setup() {
  const f = await fixture();
  const w = await editWorld(f.store.db, f.library.id, "universes", {
    title: "World",
  });
  await bookMembership(f.store.db, f.book.id, {
    universeId: w.id,
    expectedUpdatedAt: f.book.updatedAt,
  });
  const other = await f.store.createBook(f.library.id, "Other");
  await bookMembership(f.store.db, other.id, {
    universeId: w.id,
    expectedUpdatedAt: other.updatedAt,
  });
  const a = await f.store.createEntry(f.book.id, {
      name: "Ada",
      entryType: "character",
      scopeKind: "universe",
    }),
    b = await f.store.createEntry(f.book.id, {
      name: "Ben",
      entryType: "character",
      scopeKind: "universe",
    });
  const type = await editRelationshipType(f.store.db, f.library.id, {
    label: "parent of",
    inverseLabel: "child of",
  });
  const create = (
    bookId = f.book.id,
    bookSpecific = true,
    extra: object = {},
  ) =>
    editRelationship(f.store.db, bookId, {
      typeId: type.id,
      fromEntryId: a.id,
      toEntryId: b.id,
      bookSpecific,
      editSharedCanon: !bookSpecific,
      expectedTypeUpdatedAt: type.updatedAt,
      ...extra,
    });
  return { ...f, w, other, a, b, type, create };
}
test("relationship migration v6 preserves entries/manuscripts and rolls back failure before retry", async () => {
  const f = await fixture();
  try {
    const e = await f.store.createEntry(f.book.id, {
        name: "Keep",
        entryType: "term",
      }),
      doc = await f.store.document(f.scene.id);
    await removeRelationshipSchema(f.store);
    await f.store.db.query("UPDATE studio_schema SET version=6");
    const broken = new StudioStore({
      query: f.store.db.query,
      transaction: (fn) =>
        f.store.db.transaction((q) =>
          fn((sql, params) => {
            if (sql.includes("CREATE TABLE relationships("))
              throw Error("Injected relationship migration failure");
            return q(sql, params);
          }),
        ),
    });
    await assert.rejects(() => broken.migrate(), /Injected/);
    assert.equal(
      (await f.store.db.query("SELECT version FROM studio_schema")).rows[0]
        .version,
      6,
    );
    assert.equal(
      (
        await f.store.db.query(
          "SELECT to_regclass('relationship_types') AS name",
        )
      ).rows[0].name,
      null,
    );
    await f.store.migrate();
    await f.store.migrate();
    assert.deepEqual(await f.store.entries(f.book.id), [e]);
    assert.deepEqual(await f.store.document(f.scene.id), doc);
    assert.deepEqual(await relationshipCatalog(f.store.db, f.book.id), {
      relationshipTypes: [],
      relationships: [],
    });
  } finally {
    await f.pg.close();
  }
});

test("directional types and links preserve opaque data and IDs; CAS and immutable endpoints protect edits", async () => {
  const f = await setup();
  try {
    let r = await f.create(f.book.id, false, { note: "Shared note" });
    await f.store.db.query(
      "UPDATE relationships SET data=data || $2::jsonb WHERE id=$1",
      [r.id, { future: { keep: true } }],
    );
    r = await editRelationship(
      f.store.db,
      f.other.id,
      {
        note: "Changed",
        expectedUpdatedAt: r.updatedAt,
        editSharedCanon: true,
      },
      r.id,
    );
    assert.deepEqual(r.future, { keep: true });
    assert.equal(r.fromEntryId, f.a.id);
    assert.equal(r.toEntryId, f.b.id);
    await assert.rejects(
      () =>
        editRelationship(
          f.store.db,
          f.book.id,
          {
            note: "Stale",
            expectedUpdatedAt: f.type.updatedAt,
            editSharedCanon: true,
          },
          r.id,
        ),
      /changed/,
    );
    await assert.rejects(
      () =>
        editRelationship(
          f.store.db,
          f.book.id,
          {
            fromEntryId: f.b.id,
            expectedUpdatedAt: r.updatedAt,
            editSharedCanon: true,
          },
          r.id,
        ),
      /supported/,
    );
    await assert.rejects(
      () =>
        editRelationship(
          f.store.db,
          f.book.id,
          { note: "Implicit", expectedUpdatedAt: r.updatedAt },
          r.id,
        ),
      /shared relationship/,
    );
    await assert.rejects(() => f.create(f.book.id, false), /already exists/);
    await assert.rejects(
      () => f.create(f.book.id, false, { toEntryId: f.a.id }),
      /itself/,
    );
    await assert.rejects(
      () => f.create(f.book.id, true, { toEntryId: "bad" }),
      /visible entries/,
    );
    await assert.rejects(
      () => f.create(f.book.id, true, { expectedTypeUpdatedAt: "stale" }),
      /type changed/,
    );
    await f.store.db.query(
      "UPDATE relationship_types SET data=data || $2::jsonb WHERE id=$1",
      [f.type.id, { future: "type" }],
    );
    const t = await editRelationshipType(
      f.store.db,
      f.library.id,
      {
        label: "mentor of",
        inverseLabel: "student of",
        expectedUpdatedAt: f.type.updatedAt,
      },
      f.type.id,
    );
    assert.equal(t.id, f.type.id);
    assert.equal(t.createdAt, f.type.createdAt);
    assert.equal(t.future, "type");
    const catalog = await relationshipCatalog(f.store.db, f.other.id);
    assert.equal(catalog.relationshipTypes[0].inverseLabel, "student of");
    assert.equal(catalog.relationships[0].typeId, t.id);
    await assert.rejects(
      () =>
        editRelationshipType(
          f.store.db,
          f.library.id,
          { label: "stale", expectedUpdatedAt: f.type.updatedAt },
          f.type.id,
        ),
      /changed/,
    );
    await assert.rejects(
      () =>
        editRelationshipType(f.store.db, f.library.id, {
          label: " ",
          inverseLabel: "x",
        }),
      /title/,
    );
  } finally {
    await f.pg.close();
  }
});

test("book-specific visibility, real FK ownership, shared co-visibility and independent Trash restore", async () => {
  const f = await setup();
  try {
    const own = await f.create(),
      shared = await f.create(f.book.id, false);
    assert.equal(
      (await relationshipCatalog(f.store.db, f.book.id)).relationships.length,
      2,
    );
    assert.deepEqual(
      (await relationshipCatalog(f.store.db, f.other.id)).relationships.map(
        (r) => r.id,
      ),
      [shared.id],
    );
    await assert.rejects(
      () =>
        editRelationship(
          f.store.db,
          f.other.id,
          { note: "Wrong book", expectedUpdatedAt: own.updatedAt },
          own.id,
        ),
      /not visible/,
    );
    const foreign = await f.store.createLibrary("Foreign"),
      book = await f.store.createBook(foreign.id, "Foreign");
    const foreignType = await editRelationshipType(f.store.db, foreign.id, {
      label: "knows",
      inverseLabel: "known by",
    });
    await assert.rejects(
      () => f.create(f.book.id, true, { typeId: foreignType.id }),
      /live relationship type/,
    );
    const e = await f.store.createEntry(book.id, {
      name: "Foreign",
      entryType: "term",
    });
    await assert.rejects(
      () => f.create(f.book.id, true, { toEntryId: e.id }),
      /visible entries/,
    );
    const raw = { ...own, id: crypto.randomUUID(), toEntryId: e.id };
    await assert.rejects(
      () =>
        f.store.db.query(
          "INSERT INTO relationships(id,library_id,data) VALUES($1,$2,$3)",
          [raw.id, f.library.id, raw],
        ),
      /foreign key/,
    );
    const nullBook = { ...own, id: crypto.randomUUID(), bookId: null };
    await assert.rejects(
      () =>
        f.store.db.query(
          "INSERT INTO relationships(id,library_id,data) VALUES($1,$2,$3)",
          [nullBook.id, f.library.id, nullBook],
        ),
      /check constraint/,
    );
    await assert.rejects(
      () => f.store.db.query("DELETE FROM bible_entries WHERE id=$1", [f.a.id]),
      /foreign key/,
    );
    let dead = await editRelationship(
      f.store.db,
      f.book.id,
      { deleted: true, expectedUpdatedAt: own.updatedAt },
      own.id,
    );
    assert.ok(dead.deletedAt);
    assert.equal(
      (await relationshipCatalog(f.store.db, f.book.id)).relationships.length,
      2,
    );
    let bookNow = (await f.store.book(f.book.id)).book;
    await bookMembership(f.store.db, f.book.id, {
      universeId: null,
      expectedUpdatedAt: bookNow.updatedAt,
    });
    const after = await relationshipCatalog(f.store.db, f.book.id);
    assert.deepEqual(
      after.relationships.map((r) => r.id),
      [own.id],
    );
    await assert.rejects(
      () =>
        editRelationship(
          f.store.db,
          f.book.id,
          {
            deleted: false,
            expectedUpdatedAt: dead.updatedAt,
            expectedTypeUpdatedAt: f.type.updatedAt,
          },
          own.id,
        ),
      /live visible/,
    );
    bookNow = (await f.store.book(f.book.id)).book;
    await bookMembership(f.store.db, f.book.id, {
      universeId: f.w.id,
      expectedUpdatedAt: bookNow.updatedAt,
    });
    dead = await editRelationship(
      f.store.db,
      f.book.id,
      {
        deleted: false,
        expectedUpdatedAt: dead.updatedAt,
        expectedTypeUpdatedAt: f.type.updatedAt,
      },
      own.id,
    );
    assert.equal(dead.deletedAt, undefined);
  } finally {
    await f.pg.close();
  }
});

test("live dependent types and membership changes are refused; entry Trash retains links and blocks restore", async () => {
  const f = await setup();
  try {
    let r = await f.create();
    await assert.rejects(
      () =>
        editRelationshipType(
          f.store.db,
          f.library.id,
          { deleted: true, expectedUpdatedAt: f.type.updatedAt },
          f.type.id,
        ),
      /live relationships/,
    );
    const book = (await f.store.book(f.book.id)).book;
    await assert.rejects(
      () =>
        bookMembership(f.store.db, f.book.id, {
          universeId: null,
          expectedUpdatedAt: book.updatedAt,
        }),
      /relationships to Trash/,
    );
    await f.store.updateEntry(f.book.id, f.a.id, {
      deleted: true,
      editSharedCanon: true,
      expectedUpdatedAt: f.a.updatedAt,
    });
    assert.equal(
      (await relationshipCatalog(f.store.db, f.book.id)).relationships[0].id,
      r.id,
    );
    r = await editRelationship(
      f.store.db,
      f.book.id,
      { deleted: true, expectedUpdatedAt: r.updatedAt },
      r.id,
    );
    await assert.rejects(
      () =>
        editRelationship(
          f.store.db,
          f.book.id,
          {
            deleted: false,
            expectedUpdatedAt: r.updatedAt,
            expectedTypeUpdatedAt: f.type.updatedAt,
          },
          r.id,
        ),
      /live visible/,
    );
    let t = await editRelationshipType(
      f.store.db,
      f.library.id,
      { deleted: true, expectedUpdatedAt: f.type.updatedAt },
      f.type.id,
    );
    assert.ok(t.deletedAt);
    await assert.rejects(() => f.create(), /live relationship type/);
    t = await editRelationshipType(
      f.store.db,
      f.library.id,
      { deleted: false, expectedUpdatedAt: t.updatedAt },
      t.id,
    );
    const a = (await f.store.entries(f.book.id)).find((e) => e.id === f.a.id);
    await f.store.updateEntry(f.book.id, a.id, {
      deleted: false,
      expectedUpdatedAt: a.updatedAt,
      editSharedCanon: true,
    });
    r = await editRelationship(
      f.store.db,
      f.book.id,
      {
        deleted: false,
        expectedUpdatedAt: r.updatedAt,
        expectedTypeUpdatedAt: t.updatedAt,
      },
      r.id,
    );
    assert.equal(r.deletedAt, undefined);
  } finally {
    await f.pg.close();
  }
});

test("book purge cleans dependent relationships after whole-library backup and restores types/links; v4 recovery remains accepted", async () => {
  const f = await setup(),
    target = await fixture(),
    dir = await mkdtemp(join(tmpdir(), "rolltop-relations-"));
  try {
    const shared = await f.create(f.book.id, false),
      own = await f.create(),
      other = await f.create(f.other.id);
    const local = await f.store.createEntry(f.book.id, {
      name: "Local",
      entryType: "term",
    });
    const dependent = await f.create(f.book.id, false, { toEntryId: local.id });
    f.store.backupDirectory = dir;
    await f.store.trashBook(f.book.id);
    const b = (await f.store.book(f.book.id)).book;
    const receipt = await f.store.purge("book", b.id, {
      confirmTitle: b.title,
      expectedDeletedAt: b.deletedAt,
    });
    const after = await relationshipCatalog(f.store.db, f.other.id);
    assert.deepEqual(
      new Set(after.relationships.map((r) => r.id)),
      new Set([shared.id, other.id]),
    );
    assert.equal(after.relationshipTypes.length, 1);
    const snapshot = await readBookBackup(join(dir, receipt.backup));
    assert.equal(snapshot.version, 5);
    assert.equal(snapshot.schemaVersion, 7);
    assert.equal(snapshot.tables.relationships.length, 4);
    await target.store.db.transaction(async (q) => {
      for (const t of [...backupTables].reverse()) await q(`DELETE FROM ${t}`);
      await restoreBookBackup(q, snapshot);
    });
    const recovered = await relationshipCatalog(target.store.db, f.book.id);
    assert.ok(recovered.relationships.some((r) => r.id === own.id));
    assert.ok(recovered.relationships.some((r) => r.id === dependent.id));
    const legacy = structuredClone(snapshot);
    legacy.version = 4;
    legacy.schemaVersion = 6;
    delete legacy.tables.relationship_types;
    delete legacy.tables.relationships;
    await target.store.db.transaction(async (q) => {
      for (const t of [...backupTables].reverse()) await q(`DELETE FROM ${t}`);
      await restoreBookBackup(q, legacy);
    });
    assert.deepEqual(await relationshipCatalog(target.store.db, f.book.id), {
      relationshipTypes: [],
      relationships: [],
    });
    assert.equal((await target.store.entries(f.book.id)).length, 3);
  } finally {
    await f.pg.close();
    await target.pg.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("relationship HTTP endpoints enforce auth, origin, ID/input validation, CAS and library ownership", async () => {
  const f = await setup(),
    origin = "http://localhost:4317",
    password = "scratch-relationship-password";
  const server = studioServer(f.store, {
    origin,
    passwordHash: await passwordHash(password),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  let cookie = "";
  const req = (path: string, value?: any, method = "POST", o = origin) =>
    fetch(base + path, {
      method,
      headers: {
        Cookie: cookie,
        Origin: o,
        "Content-Type": "application/json",
      },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
  try {
    const path = `/books/${f.book.id}/relationships`,
      body = {
        typeId: f.type.id,
        fromEntryId: f.a.id,
        toEntryId: f.b.id,
        bookSpecific: true,
        expectedTypeUpdatedAt: f.type.updatedAt,
      };
    assert.equal((await req(path, body)).status, 401);
    cookie = (await req("/login", { password })).headers
      .get("set-cookie")!
      .split(";")[0];
    assert.equal(
      (await req(path, body, "POST", "https://evil.example")).status,
      403,
    );
    assert.equal((await req(path + "/bad", {}, "PUT")).status, 400);
    const created = await req(path, body);
    assert.equal(created.status, 201);
    const r = await created.json();
    assert.equal((await req(path, undefined, "GET")).status, 200);
    assert.equal(
      (
        await req(
          path + `/${r.id}`,
          { note: "HTTP note", expectedUpdatedAt: r.updatedAt },
          "PUT",
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await req(
          path + `/${r.id}`,
          { note: "Stale", expectedUpdatedAt: r.updatedAt },
          "PUT",
        )
      ).status,
      409,
    );
    assert.equal(
      (await req(path, { ...body, fromEntryId: f.b.id })).status,
      400,
    );
    const typePath = `/libraries/${f.library.id}/relationship-types`;
    assert.equal(
      (await req(typePath, { label: "knows", inverseLabel: "known by" }))
        .status,
      201,
    );
    assert.equal(
      (
        await req(
          typePath + `/${f.type.id}`,
          {
            label: "mentor of",
            inverseLabel: "student of",
            expectedUpdatedAt: f.type.updatedAt,
          },
          "PUT",
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await req(
          typePath + `/${f.type.id}`,
          { label: "old", expectedUpdatedAt: f.type.updatedAt },
          "PUT",
        )
      ).status,
      409,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.pg.close();
  }
});
