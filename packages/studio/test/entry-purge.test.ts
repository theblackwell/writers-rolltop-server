// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fixture } from "./support.ts";
import { StudioStore } from "../src/store.ts";
import { purgeEntry } from "../src/entry-purge.ts";
import {
  captureBook,
  backupTables,
  readBookBackup,
  restoreBookBackup,
} from "../src/backup.ts";
import { editWorld, bookMembership } from "../src/worlds.ts";
import {
  editRelationship,
  editRelationshipType,
} from "../src/relationships.ts";
import { studioServer } from "../src/http.ts";
import { passwordHash } from "../src/auth.ts";
const confirm = (e: any) => ({
  confirmName: e.name,
  expectedDeletedAt: e.deletedAt,
  expectedUpdatedAt: e.updatedAt,
  editSharedCanon: e.scope.kind !== "book",
});
async function snapshot(store: StudioStore, book: string) {
  const b = await store.db.transaction((q) => captureBook(q, book));
  return Object.fromEntries(
    backupTables.map((t) => [
      t,
      JSON.parse(JSON.stringify(b.tables[t])).sort((a: any, b: any) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
      ),
    ]),
  );
}
async function trashed(f: any, entry?: any) {
  entry ??= await f.store.createEntry(f.book.id, {
    name: "Doomed",
    entryType: "character",
  });
  return f.store.updateEntry(f.book.id, entry.id, {
    deleted: true,
    expectedUpdatedAt: entry.updatedAt,
    editSharedCanon: true,
  });
}
async function field(f: any, kind: string, libraryId = f.library.id) {
  const template = (await f.store.templates(libraryId)).templates[0];
  const id = crypto.randomUUID(),
    now = new Date().toISOString();
  await f.store.db.query("INSERT INTO bible_fields VALUES($1,$2,$3,$4)", [
    id,
    libraryId,
    template.id,
    {
      id,
      templateId: template.id,
      key: "ref" + id.replaceAll("-", ""),
      label: kind,
      fieldType: kind,
      required: false,
      orderKey: id,
      createdAt: now,
      updatedAt: now,
    },
  ]);
  return id;
}
test("entry purge requires exact saved Trash confirmation and durable backup; failures leave every record intact", async () => {
  const f = await fixture(),
    dir = await mkdtemp(join(tmpdir(), "rolltop-entry-purge-"));
  try {
    const entry = await f.store.createEntry(f.book.id, {
      name: "Doomed",
      entryType: "term",
    });
    f.store.backupDirectory = dir;
    await assert.rejects(
      () =>
        purgeEntry(f.store, f.book.id, entry.id, {
          ...confirm(entry),
          expectedDeletedAt: "none",
        }),
      /Trash/,
    );
    const dead = await trashed(f, entry),
      before = await snapshot(f.store, f.book.id);
    for (const patch of [
      { confirmName: "wrong" },
      { expectedUpdatedAt: "old" },
      { expectedDeletedAt: "old" },
    ])
      await assert.rejects(
        () =>
          purgeEntry(f.store, f.book.id, dead.id, {
            ...confirm(dead),
            ...patch,
          }),
        /changed/,
      );
    await assert.rejects(
      () =>
        purgeEntry(f.store, f.book.id, dead.id, {
          ...confirm(dead),
          extra: true,
        }),
      /Confirm/,
    );
    f.store.backupDirectory = undefined;
    await assert.rejects(
      () => purgeEntry(f.store, f.book.id, dead.id, confirm(dead)),
      /configured/,
    );
    f.store.backupDirectory = join(dir, "missing");
    await assert.rejects(
      () => purgeEntry(f.store, f.book.id, dead.id, confirm(dead)),
      /verified/,
    );
    assert.deepEqual(await snapshot(f.store, f.book.id), before);
    assert.deepEqual(await readdir(dir), []);
    const broken = new StudioStore(
      {
        query: f.store.db.query,
        transaction: (fn) =>
          f.store.db.transaction((q) =>
            fn(async (sql, params) => {
              if (sql.startsWith("DELETE FROM bible_entries"))
                throw Error("injected cleanup failure");
              return q(sql, params);
            }),
          ),
      },
      dir,
    );
    await assert.rejects(
      () => purgeEntry(broken, f.book.id, dead.id, confirm(dead)),
      /injected/,
    );
    assert.deepEqual(await snapshot(f.store, f.book.id), before);
    assert.equal((await readdir(dir)).length, 1);
    const locked = new StudioStore(
      {
        query: f.store.db.query,
        transaction: (fn) =>
          f.store.db.transaction((q) =>
            fn(async (sql, params) => {
              if (sql.includes("FOR UPDATE NOWAIT"))
                throw Error("competing book lock");
              return q(sql, params);
            }),
          ),
      },
      dir,
    );
    await assert.rejects(
      () => purgeEntry(locked, f.book.id, dead.id, confirm(dead)),
      /snapshot/,
    );
    assert.deepEqual(await snapshot(f.store, f.book.id), before);
  } finally {
    await f.pg.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("shared entry purge cleans typed canon/overrides, all relationships, passage and POV/setting links; restores whole library exactly", async () => {
  const f = await fixture(),
    scratch = await fixture(),
    dir = await mkdtemp(join(tmpdir(), "rolltop-entry-recover-"));
  try {
    f.store.backupDirectory = dir;
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
    const target = await f.store.createEntry(f.book.id, {
      name: "Shared",
      entryType: "character",
      scopeKind: "universe",
    });
    const keep = await f.store.createEntry(other.id, {
      name: "Keep",
      entryType: "term",
    });
    const deadOther = await trashed(
      f,
      await f.store.createEntry(f.book.id, {
        name: "Trashed unrelated",
        entryType: "term",
      }),
    );
    const single = await field(f, "entryReference"),
      multi = await field(f, "entryReferences");
    // Preserved unknown fields must not be mistaken for links. Include explicit
    // override values/metadata and an unrelated empty override.
    const values = {
      [single]: target.id,
      [multi]: [target.id, keep.id],
      unknown: target.id,
      zero: 0,
      flag: false,
    };
    const oldStamp = "2090-01-01T00:00:00.000Z";
    const overrides = [
      { bookId: f.book.id, values: { [single]: target.id } },
      { bookId: other.id, values: { [multi]: [target.id] }, opaque: "keep" },
    ];
    await f.store.db.query(
      "UPDATE bible_entries SET data=data || $2::jsonb WHERE id=$1",
      [
        keep.id,
        { values, overrides, updatedAt: oldStamp, opaque: { id: target.id } },
      ],
    );
    await f.store.db.query(
      "UPDATE bible_entries SET data=data || $2::jsonb WHERE id=$1",
      [
        deadOther.id,
        {
          values: { [multi]: [target.id] },
          overrides: [{ bookId: other.id, values: {} }],
        },
      ],
    );
    const type = await editRelationshipType(f.store.db, f.library.id, {
      label: "Knows",
      inverseLabel: "Known by",
    });
    const relationship = await editRelationship(f.store.db, f.book.id, {
      typeId: type.id,
      fromEntryId: target.id,
      toEntryId: deadOther.id,
      bookSpecific: true,
      expectedTypeUpdatedAt: type.updatedAt,
    }).catch(async () => {
      // A live local entry provides the endpoint; trash it after relationship creation.
      const restored = await f.store.updateEntry(f.book.id, deadOther.id, {
        deleted: false,
        expectedUpdatedAt: deadOther.updatedAt,
      });
      return editRelationship(f.store.db, f.book.id, {
        typeId: type.id,
        fromEntryId: target.id,
        toEntryId: restored.id,
        bookSpecific: true,
        expectedTypeUpdatedAt: type.updatedAt,
      });
    });
    assert.ok(relationship.id);
    await f.store.db.query(
      "UPDATE bible_entries SET data=data || $2::jsonb WHERE id=$1",
      [deadOther.id, { deletedAt: oldStamp }],
    );

    const otherChapter = await f.store.createNode(
      other.id,
      "Chapter",
      "chapter",
    );
    const otherScene = await f.store.createNode(
      other.id,
      "Scene",
      "scene",
      otherChapter.id,
    );
    const doc = await f.store.document(f.scene.id),
      anchorId = crypto.randomUUID();
    if (doc.document.blocks[0].type === "sceneBreak")
      throw Error("Expected paragraph");
    doc.document.blocks[0].content = [
      {
        type: "text",
        text: "Prose survives",
        marks: [{ type: "anchor", id: anchorId }],
      },
    ];
    const saved = await f.store.save(f.scene.id, doc.document, doc.revision);
    await f.store.saveReference(f.scene.id, {
      entryId: target.id,
      anchorId,
      expectedRevision: saved.revision,
    });
    await f.store.db.query(
      "INSERT INTO manuscript_references VALUES($1,$2,$3,$4)",
      [
        crypto.randomUUID(),
        otherScene.id,
        target.id,
        { deletedAt: oldStamp, opaque: "kept in backup" },
      ],
    );
    await f.store.db.query(
      "UPDATE manuscript_nodes SET data=data || $2::jsonb WHERE id=$1",
      [
        otherScene.id,
        {
          povEntryId: target.id,
          settingEntryId: target.id,
          opaque: target.id,
          updatedAt: oldStamp,
        },
      ],
    );
    const dead = await trashed(f, target),
      before = await snapshot(f.store, f.book.id);
    await assert.rejects(
      () =>
        purgeEntry(f.store, f.book.id, dead.id, {
          ...confirm(dead),
          editSharedCanon: false,
        }),
      /shared/,
    );
    const receipt = await purgeEntry(f.store, other.id, dead.id, confirm(dead));
    assert.equal(receipt.deletedEntryId, target.id);
    assert.equal(
      (
        await f.store.db.query("SELECT id FROM bible_entries WHERE id=$1", [
          target.id,
        ])
      ).rows.length,
      0,
    );
    assert.equal(
      (await f.store.db.query("SELECT * FROM relationships")).rows.length,
      0,
    );
    assert.equal(
      (await f.store.db.query("SELECT * FROM manuscript_references")).rows
        .length,
      0,
    );
    const kept = (
      await f.store.db.query("SELECT data FROM bible_entries WHERE id=$1", [
        keep.id,
      ])
    ).rows[0].data;
    assert.deepEqual(kept.values, {
      [multi]: [keep.id],
      unknown: target.id,
      zero: 0,
      flag: false,
    });
    assert.deepEqual(kept.overrides, [
      { bookId: other.id, values: {}, opaque: "keep" },
    ]);
    assert.ok(kept.updatedAt > oldStamp);
    assert.deepEqual(kept.opaque, { id: target.id });
    const node = (
      await f.store.db.query("SELECT data FROM manuscript_nodes WHERE id=$1", [
        otherScene.id,
      ])
    ).rows[0].data;
    assert.equal(node.povEntryId, undefined);
    assert.equal(node.settingEntryId, undefined);
    assert.equal(node.opaque, target.id);
    assert.ok(node.updatedAt > oldStamp);
    assert.deepEqual(
      (await f.store.document(f.scene.id)).document,
      doc.document,
    );
    const after = await snapshot(f.store, f.book.id);
    for (const t of [
      "documents",
      "document_revisions",
      "notes",
      "relationship_types",
      "bible_fields",
      "books",
    ])
      assert.deepEqual(after[t], before[t]);
    const backup = await readBookBackup(join(dir, receipt.backup));
    await scratch.store.db.transaction(async (q) => {
      for (const t of [...backupTables].reverse()) await q(`DELETE FROM ${t}`);
      await restoreBookBackup(q, backup);
    });
    assert.deepEqual(await snapshot(scratch.store, f.book.id), before);
  } finally {
    await f.pg.close();
    await scratch.pg.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("entry purge refuses invisible, trashed-book and uncaptured external dependencies; opaque foreign field keys survive", async () => {
  const f = await fixture(),
    dir = await mkdtemp(join(tmpdir(), "rolltop-entry-external-"));
  try {
    f.store.backupDirectory = dir;
    const dead = await trashed(f),
      second = await f.store.createBook(f.library.id, "No visibility");
    await assert.rejects(
      () => purgeEntry(f.store, second.id, dead.id, confirm(dead)),
      /visible/,
    );
    const foreignLib = await f.store.createLibrary("Foreign"),
      foreignBook = await f.store.createBook(foreignLib.id, "Foreign book");
    const foreign = await f.store.createEntry(foreignBook.id, {
      name: "Foreign entry",
      entryType: "term",
    });
    const ref = await field(f, "entryReference", foreignLib.id);
    await f.store.db.query(
      "UPDATE bible_entries SET data=data || $2::jsonb WHERE id=$1",
      [
        foreign.id,
        { values: { [ref]: dead.id }, deletedAt: new Date().toISOString() },
      ],
    );
    const before = await snapshot(f.store, f.book.id);
    await assert.rejects(
      () => purgeEntry(f.store, f.book.id, dead.id, confirm(dead)),
      /another library/,
    );
    assert.deepEqual(await snapshot(f.store, f.book.id), before);
    assert.deepEqual(await readdir(dir), []);
    await f.store.db.query(
      "UPDATE bible_entries SET data=jsonb_set(data,'{values}','{}') WHERE id=$1",
      [foreign.id],
    );
    const externalId = crypto.randomUUID();
    const chapter = await f.store.createNode(
        foreignBook.id,
        "Chapter",
        "chapter",
      ),
      scene = await f.store.createNode(
        foreignBook.id,
        "Scene",
        "scene",
        chapter.id,
      );
    await f.store.db.query(
      "INSERT INTO manuscript_references VALUES($1,$2,$3,$4)",
      [externalId, scene.id, dead.id, {}],
    );
    await assert.rejects(
      () => purgeEntry(f.store, f.book.id, dead.id, confirm(dead)),
      /another library/,
    );
    await f.store.db.query("DELETE FROM manuscript_references WHERE id=$1", [
      externalId,
    ]);
    await f.store.db.query(
      "UPDATE manuscript_nodes SET data=data || $2::jsonb WHERE id=$1",
      [scene.id, { povEntryId: dead.id }],
    );
    await assert.rejects(
      () => purgeEntry(f.store, f.book.id, dead.id, confirm(dead)),
      /another library/,
    );
    await f.store.db.query(
      "UPDATE manuscript_nodes SET data=data - 'povEntryId' WHERE id=$1",
      [scene.id],
    );
    const keep = await f.store.createEntry(f.book.id, {
      name: "Opaque",
      entryType: "term",
    });
    await f.store.db.query(
      "UPDATE bible_entries SET data=data || $2::jsonb WHERE id=$1",
      [keep.id, { values: { [ref]: dead.id } }],
    );
    await f.store.trashBook(f.book.id);
    await assert.rejects(
      () => purgeEntry(f.store, f.book.id, dead.id, confirm(dead)),
      /Restore the book/,
    );
    await f.store.restoreBook(f.book.id);
    await purgeEntry(f.store, f.book.id, dead.id, confirm(dead));
    const kept = (
      await f.store.db.query("SELECT data FROM bible_entries WHERE id=$1", [
        keep.id,
      ])
    ).rows[0].data;
    assert.equal(
      kept.values[ref],
      dead.id,
      "foreign definition is not this library's declared field",
    );
  } finally {
    await f.pg.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("entry purge HTTP enforces login, origin, IDs, allowlist and CAS before returning receipt", async () => {
  const f = await fixture(),
    dir = await mkdtemp(join(tmpdir(), "rolltop-entry-http-"));
  f.store.backupDirectory = dir;
  const origin = "http://localhost:4317",
    password = "scratch-entry-delete";
  const server = studioServer(f.store, {
    origin,
    passwordHash: await passwordHash(password),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  let cookie = "";
  const request = (path: string, value: any, from = origin) =>
    fetch(base + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: from,
        Cookie: cookie,
      },
      body: JSON.stringify(value),
    });
  try {
    const dead = await trashed(f),
      path = `/books/${f.book.id}/entries/${dead.id}/purge`;
    assert.equal((await request(path, confirm(dead))).status, 401);
    const login = await request("/login", { password });
    cookie = login.headers.get("set-cookie")!.split(";")[0];
    assert.equal(
      (await request(path, confirm(dead), "https://evil.example")).status,
      403,
    );
    assert.equal(
      (await request(`/books/${f.book.id}/entries/no/purge`, confirm(dead)))
        .status,
      400,
    );
    assert.equal(
      (await request(path, { ...confirm(dead), extra: true })).status,
      400,
    );
    assert.equal(
      (await request(path, { ...confirm(dead), expectedUpdatedAt: "old" }))
        .status,
      409,
    );
    const result = await request(path, confirm(dead));
    assert.equal(result.status, 200);
    assert.match(
      (await result.json()).backup,
      /^[a-f0-9-]+\.book-recovery\.json$/,
    );
    assert.equal((await request(path, confirm(dead))).status, 404);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.pg.close();
    await rm(dir, { recursive: true, force: true });
  }
});
