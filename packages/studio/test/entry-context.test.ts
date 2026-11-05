// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support.ts";
import { familyName, sameFamilyName } from "../src/family-values.ts";
import {
  familyMatches,
  saveFamilyAnswer,
  entryAppearances,
} from "../src/entry-context.ts";
import { editWorld, bookMembership } from "../src/worlds.ts";
import { editRelationship, relationshipCatalog } from "../src/relationships.ts";
import { backupTables, captureBook, restoreBookBackup } from "../src/backup.ts";
import { studioServer } from "../src/http.ts";
import { passwordHash } from "../src/auth.ts";
async function setup() {
  const f = await fixture();
  const world = await editWorld(f.store.db, f.library.id, "universes", {
    title: "World",
  });
  await bookMembership(f.store.db, f.book.id, {
    universeId: world.id,
    expectedUpdatedAt: f.book.updatedAt,
  });
  const other = await f.store.createBook(f.library.id, "Other book");
  await bookMembership(f.store.db, other.id, {
    universeId: world.id,
    expectedUpdatedAt: other.updatedAt,
  });
  const create = (name: string, extra: object = {}) =>
    f.store.createEntry(f.book.id, {
      name,
      entryType: "character",
      scopeKind: "universe",
      ...extra,
    });
  const a = await create("Ada García"),
    b = await create("Ben garcia");
  const answer = (
    relation: string,
    bookId = f.book.id,
    source = a,
    target = b,
    bookSpecific = true,
  ) =>
    saveFamilyAnswer(f.store.db, bookId, source.id, {
      relation,
      otherEntryId: target.id,
      bookSpecific,
      editSharedCanon: !bookSpecific,
      expectedUpdatedAt: source.updatedAt,
      expectedOtherUpdatedAt: target.updatedAt,
    });
  return { ...f, world, other, a, b, create, answer };
}
async function link(f: any, node: any, entryId: string, text = "Mention") {
  const before = await f.store.document(node.id),
    anchorId = crypto.randomUUID();
  before.document.blocks[0].content = [
    { type: "text", text, marks: [{ type: "anchor", id: anchorId }] },
  ];
  const saved = await f.store.save(node.id, before.document, before.revision);
  const reference = await f.store.saveReference(node.id, {
    entryId,
    anchorId,
    expectedRevision: saved.revision,
  });
  return { reference, anchorId };
}

test("family matching follows explicit name parts and fallback, ignores case/accents and scopes live candidates", async () => {
  assert.equal(
    familyName({ entryType: "character", name: "First Middle Last" }),
    "Last",
  );
  assert.equal(familyName({ entryType: "character", name: "Cher" }), "");
  assert.equal(
    familyName({
      entryType: "character",
      name: "First Last",
      givenName: "First",
    }),
    "",
  );
  assert.equal(
    sameFamilyName(
      { entryType: "character", name: "A García" },
      { entryType: "character", name: "B GARCIA" },
    ),
    true,
  );
  const f = await setup();
  try {
    const explicit = await f.create("Different display", {
        familyName: "García",
        givenName: "C",
      }),
      single = await f.create("Garcia"),
      noFamily = await f.create("D Garcia", { givenName: "D" });
    await f.create("A Garcia", { entryType: "term" });
    const foreign = await f.store.createEntry(f.other.id, {
      name: "Other Garcia",
      entryType: "character",
    });
    const dead = await f.create("Deleted Garcia");
    await f.store.updateEntry(f.book.id, dead.id, {
      deleted: true,
      editSharedCanon: true,
      expectedUpdatedAt: dead.updatedAt,
    });
    const before = await f.store.document(f.scene.id),
      matches = await familyMatches(f.store.db, f.book.id, f.a.id);
    assert.deepEqual(
      new Set(matches.matches.map((m) => m.entry.id)),
      new Set([f.b.id, explicit.id]),
    );
    assert.equal(
      matches.matches.some((m) =>
        [single.id, noFamily.id, foreign.id, dead.id].includes(m.entry.id),
      ),
      false,
    );
    assert.deepEqual(await f.store.document(f.scene.id), before);
  } finally {
    await f.pg.close();
  }
});

test("Not related is a durable scoped answer; reverse family directions reuse native labels and type IDs", async () => {
  const f = await setup(),
    target = await fixture();
  try {
    const notRelated = await f.answer("notRelated");
    assert.equal(notRelated.relationshipType.label, "not related to");
    assert.equal(notRelated.relationship.bookId, f.book.id);
    let data = await familyMatches(f.store.db, f.book.id, f.a.id);
    assert.equal(data.matches[0].related, true);
    assert.deepEqual(data.matches[0].labels, ["not related to"]);
    assert.equal(
      (await familyMatches(f.store.db, f.other.id, f.a.id)).matches[0].related,
      false,
    );
    const c = await f.create("C Garcia"),
      d = await f.create("D Garcia");
    const parent = await f.answer("parent", f.book.id, f.a, c, false),
      child = await f.answer("child", f.book.id, f.b, d, false);
    assert.equal(parent.relationshipType.id, child.relationshipType.id);
    assert.equal(child.relationship.fromEntryId, d.id);
    assert.equal(child.relationship.toEntryId, f.b.id);
    const inverse = (
      await familyMatches(f.store.db, f.book.id, f.b.id)
    ).matches.find((m) => m.entry.id === d.id);
    assert.deepEqual(inverse?.labels, ["child of"]);
    assert.equal(
      (await familyMatches(f.store.db, f.other.id, f.a.id)).matches.find(
        (m) => m.entry.id === c.id,
      )?.related,
      true,
    );
    await editRelationship(
      f.store.db,
      f.book.id,
      { deleted: true, expectedUpdatedAt: notRelated.relationship.updatedAt },
      notRelated.relationship.id,
    );
    assert.equal(
      (await familyMatches(f.store.db, f.book.id, f.a.id)).matches.find(
        (m) => m.entry.id === f.b.id,
      )?.related,
      false,
    );
    const saved = await f.answer("notRelated");
    assert.equal(saved.relationshipType.id, notRelated.relationshipType.id);
    const backup = await f.store.db.transaction((q) =>
      captureBook(q, f.book.id),
    );
    await target.store.db.transaction(async (q) => {
      for (const t of [...backupTables].reverse()) await q(`DELETE FROM ${t}`);
      await restoreBookBackup(q, backup);
    });
    assert.equal(
      (await familyMatches(target.store.db, f.book.id, f.a.id)).matches.find(
        (m) => m.entry.id === f.b.id,
      )?.related,
      true,
    );
  } finally {
    await f.pg.close();
    await target.pg.close();
  }
});

test("family answers reject stale/hidden/mismatched pairs and concurrent answers without changing character data", async () => {
  const f = await setup();
  try {
    const results = await Promise.allSettled([
      f.answer("sibling"),
      f.answer("notRelated"),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
    assert.equal(
      (await relationshipCatalog(f.store.db, f.book.id)).relationships.length,
      1,
    );
    assert.deepEqual(
      (await f.store.entries(f.book.id)).find((e) => e.id === f.a.id),
      f.a,
    );
    const c = await f.create("C Garcia");
    await f.store.updateEntry(f.book.id, c.id, {
      givenName: "C",
      familyName: "Changed",
      editSharedCanon: true,
      expectedUpdatedAt: c.updatedAt,
    });
    await assert.rejects(
      () => f.answer("parent", f.book.id, f.a, c),
      /character changed/,
    );
    const changed = (await f.store.entries(f.book.id)).find(
      (e) => e.id === c.id,
    );
    await assert.rejects(
      () => f.answer("parent", f.book.id, f.a, changed),
      /same family name/,
    );
    const foreign = await f.store.createEntry(f.other.id, {
      name: "Hidden Garcia",
      entryType: "character",
    });
    await assert.rejects(
      () => f.answer("parent", f.book.id, f.a, foreign),
      /no longer visible/,
    );
    await assert.rejects(() => f.answer("bad"), /family answer/);
    await assert.rejects(
      () =>
        saveFamilyAnswer(f.store.db, f.book.id, f.a.id, {
          relation: "parent",
          otherEntryId: c.id,
          bookSpecific: false,
          expectedUpdatedAt: f.a.updatedAt,
          expectedOtherUpdatedAt: c.updatedAt,
        }),
      /shared family/,
    );
  } finally {
    await f.pg.close();
  }
});

test("family type creation and link save are atomic when inserting the relationship fails", async () => {
  const f = await setup();
  try {
    const db = {
      query: f.store.db.query,
      transaction: <T>(fn: (q: any) => Promise<T>) =>
        f.store.db.transaction((q) =>
          fn((sql: string, params: any[]) => {
            if (sql.startsWith("INSERT INTO relationships"))
              throw Error("Injected link failure");
            return q(sql, params);
          }),
        ),
    };
    await assert.rejects(
      () =>
        saveFamilyAnswer(db, f.book.id, f.a.id, {
          relation: "parent",
          otherEntryId: f.b.id,
          bookSpecific: true,
          expectedUpdatedAt: f.a.updatedAt,
          expectedOtherUpdatedAt: f.b.updatedAt,
        }),
      /Injected link/,
    );
    const catalog = await relationshipCatalog(f.store.db, f.book.id);
    assert.equal(catalog.relationshipTypes.length, 0);
    assert.equal(catalog.relationships.length, 0);
    assert.equal(
      (await familyMatches(f.store.db, f.book.id, f.a.id)).matches[0].related,
      false,
    );
  } finally {
    await f.pg.close();
  }
});

test("appearances stay in the open book, distinguish missing anchors, follow reading order and exclude Trash", async () => {
  const f = await setup();
  try {
    const first = await link(f, f.scene, f.a.id, "Ada in chapter one"),
      laterChapter = await f.store.createNode(
        f.book.id,
        "Later chapter",
        "chapter",
      ),
      later = await f.store.createNode(
        f.book.id,
        "Later scene",
        "scene",
        laterChapter.id,
      );
    const missing = await link(f, later, f.a.id, "Passage to remove");
    const d = await f.store.document(later.id);
    if (d.document.blocks[0].type === "sceneBreak")
      throw Error("Expected paragraph");
    d.document.blocks[0].content = [
      { type: "text", text: "Replacement without the anchor" },
    ];
    await f.store.save(later.id, d.document, d.revision);
    const otherChapter = await f.store.createNode(
        f.other.id,
        "Other chapter",
        "chapter",
      ),
      otherScene = await f.store.createNode(
        f.other.id,
        "Other scene",
        "scene",
        otherChapter.id,
      );
    await link(f, otherScene, f.a.id);
    const before = await f.store.document(f.scene.id);
    let data = await entryAppearances(f.store.db, f.book.id, f.a.id);
    assert.equal(data.appearances.length, 2);
    assert.equal(data.appearances[0].nodeId, f.scene.id);
    assert.equal(data.appearances[0].passageMissing, false);
    assert.equal(data.appearances[0].excerpt, "Ada in chapter one");
    assert.equal(data.appearances[1].passageMissing, true);
    assert.equal(data.appearances[1].anchorId, missing.anchorId);
    assert.equal(
      (await entryAppearances(f.store.db, f.other.id, f.a.id)).appearances
        .length,
      1,
    );
    await f.store.saveReference(
      f.scene.id,
      { deleted: true, expectedUpdatedAt: first.reference.updatedAt },
      first.reference.id,
    );
    assert.equal(
      (await entryAppearances(f.store.db, f.book.id, f.a.id)).appearances
        .length,
      1,
    );
    await f.store.trashNode(laterChapter.id);
    assert.equal(
      (await entryAppearances(f.store.db, f.book.id, f.a.id)).appearances
        .length,
      0,
    );
    await f.store.restoreNode(laterChapter.id);
    assert.equal(
      (await entryAppearances(f.store.db, f.book.id, f.a.id)).appearances
        .length,
      1,
    );
    await f.store.updateEntry(f.book.id, f.a.id, {
      deleted: true,
      editSharedCanon: true,
      expectedUpdatedAt: f.a.updatedAt,
    });
    assert.equal(
      (await entryAppearances(f.store.db, f.book.id, f.a.id)).appearances
        .length,
      1,
    );
    assert.deepEqual(await f.store.document(f.scene.id), before);
    const hidden = await f.store.createEntry(f.other.id, {
      name: "Hidden",
      entryType: "term",
    });
    await assert.rejects(
      () => entryAppearances(f.store.db, f.book.id, hidden.id),
      /not visible|no longer visible/,
    );
  } finally {
    await f.pg.close();
  }
});

test("family and appearance HTTP routes enforce authentication, origin, identifiers, allowlists and conflicts", async () => {
  const f = await setup(),
    origin = "http://localhost:4317",
    password = "scratch-family-password",
    server = studioServer(f.store, {
      origin,
      passwordHash: await passwordHash(password),
    });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  let cookie = "";
  const req = (path: string, value?: any, method = "GET", o = origin) =>
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
    const path = `/books/${f.book.id}/entries/${f.a.id}`,
      body = {
        relation: "notRelated",
        otherEntryId: f.b.id,
        bookSpecific: true,
        expectedUpdatedAt: f.a.updatedAt,
        expectedOtherUpdatedAt: f.b.updatedAt,
      };
    assert.equal((await req(path + "/family")).status, 401);
    cookie = (await req("/login", { password }, "POST")).headers
      .get("set-cookie")!
      .split(";")[0];
    assert.equal((await req(path + "/family")).status, 200);
    assert.equal((await req(path + "/appearances")).status, 200);
    assert.equal(
      (await req(path + "/family", body, "POST", "https://evil.example"))
        .status,
      403,
    );
    assert.equal(
      (await req(`/books/${f.book.id}/entries/bad/appearances`)).status,
      400,
    );
    assert.equal(
      (await req(path + "/family", { ...body, values: {} }, "POST")).status,
      400,
    );
    assert.equal(
      (
        await req(
          path + "/family",
          { ...body, expectedOtherUpdatedAt: "stale" },
          "POST",
        )
      ).status,
      409,
    );
    assert.equal((await req(path + "/family", body, "POST")).status, 201);
    assert.equal((await req(path + "/family", body, "POST")).status, 409);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.pg.close();
  }
});
