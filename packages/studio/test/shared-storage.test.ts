// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, removeScopeSchema } from "./support.ts";
import { editWorld, bookMembership } from "../src/worlds.ts";
import {
  captureBook,
  readBookBackup,
  restoreBookBackup,
  backupTables,
} from "../src/backup.ts";
import { StudioStore } from "../src/store.ts";
import { editDefinition } from "../src/template-editor.ts";
async function hierarchy(f: Awaited<ReturnType<typeof fixture>>) {
  const w = await editWorld(f.store.db, f.library.id, "universes", {
    title: "World",
  });
  const s = await editWorld(f.store.db, f.library.id, "series", {
    title: "Series",
    universeId: w.id,
  });
  await bookMembership(f.store.db, f.book.id, {
    universeId: w.id,
    seriesId: s.id,
    expectedUpdatedAt: f.book.updatedAt,
  });
  const other = await f.store.createBook(f.library.id, "Other");
  await bookMembership(f.store.db, other.id, {
    universeId: w.id,
    expectedUpdatedAt: other.updatedAt,
  });
  return { w, s, other };
}
async function shared(
  f: Awaited<ReturnType<typeof fixture>>,
  scope: { kind: string; id: string },
  extra: object = {},
) {
  const now = new Date().toISOString();
  const e: any = {
    id: crypto.randomUUID(),
    name: "Shared",
    entryType: "term",
    scope,
    values: {},
    overrides: [],
    aliases: [],
    attachments: [],
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
  await f.store.db.query(
    "INSERT INTO bible_entries(id,book_id,data,library_id) VALUES($1,NULL,$2,$3)",
    [e.id, e, f.library.id],
  );
  return e;
}

test("schema6 adopts legacy shared scope without rewriting canonical data and rejects inconsistent ownership", async () => {
  const f = await fixture();
  try {
    const { w } = await hierarchy(f);
    const e = await f.store.createEntry(f.book.id, {
      name: "Preserved",
      entryType: "term",
    });
    const doc = await f.store.document(f.scene.id);
    await removeScopeSchema(f.store);
    await f.store.db.query("UPDATE studio_schema SET version=5");
    const data = {
      ...e,
      scope: { kind: "universe", id: w.id },
      future: { keep: true },
    };
    await f.store.db.query("UPDATE bible_entries SET data=$2 WHERE id=$1", [
      e.id,
      data,
    ]);
    await f.store.migrate();
    await f.store.migrate();
    const row = (
      await f.store.db.query("SELECT * FROM bible_entries WHERE id=$1", [e.id])
    ).rows[0];
    assert.deepEqual(row.data, data);
    assert.equal(row.book_id, null);
    assert.equal(row.library_id, f.library.id);
    assert.deepEqual(await f.store.document(f.scene.id), doc);
    const foreign = await f.store.createLibrary("Foreign");
    await assert.rejects(
      () =>
        f.store.db.query("UPDATE bible_entries SET library_id=$2 WHERE id=$1", [
          e.id,
          foreign.id,
        ]),
      /foreign key/,
    );
    await assert.rejects(
      () =>
        f.store.db.query("UPDATE bible_entries SET book_id=$2 WHERE id=$1", [
          e.id,
          f.book.id,
        ]),
      /entries_scope/,
    );
    await assert.rejects(
      () => shared(f, { kind: "series", id: crypto.randomUUID() }),
      /foreign key/,
    );
    await assert.rejects(
      () => shared(f, { kind: "invalid", id: w.id }),
      /entries_scope/,
    );
  } finally {
    await f.pg.close();
  }
});

test("visible entries include exactly book/world/series, preserve Trash and require explicit shared canon writes", async () => {
  const f = await fixture();
  try {
    const { w, s, other } = await hierarchy(f);
    const world = await shared(f, { kind: "universe", id: w.id });
    const serial = await shared(
      f,
      { kind: "series", id: s.id },
      { deletedAt: new Date().toISOString() },
    );
    const local = await f.store.createEntry(f.book.id, {
      name: "Local",
      entryType: "term",
    });
    const otherLocal = await f.store.createEntry(other.id, {
      name: "Other local",
      entryType: "term",
    });
    assert.deepEqual(
      new Set((await f.store.entries(f.book.id)).map((e) => e.id)),
      new Set([world.id, serial.id, local.id]),
    );
    assert.deepEqual(
      new Set((await f.store.entries(other.id)).map((e) => e.id)),
      new Set([world.id, otherLocal.id]),
    );
    const standalone = await f.store.createBook(f.library.id, "Standalone");
    assert.deepEqual(await f.store.entries(standalone.id), []);
    const lib = await f.store.createLibrary("Other library"),
      book = await f.store.createBook(lib.id, "Foreign");
    assert.deepEqual(await f.store.entries(book.id), []);
    await assert.rejects(
      () =>
        f.store.updateEntry(f.book.id, world.id, {
          name: "Unsafe",
          expectedUpdatedAt: world.updatedAt,
        }),
      /shared canon/,
    );
    const template = (await f.store.templates(f.library.id)).templates.find(
      (t) => t.entryType === "term",
    )!;
    await assert.rejects(
      () =>
        f.store.editEntryField(f.book.id, world.id, {
          templateId: template.id,
          expectedUpdatedAt: world.updatedAt,
          expectedTemplateUpdatedAt: template.updatedAt,
        }),
      /shared canon/,
    );
  } finally {
    await f.pg.close();
  }
});

test("full library recovery restores other manuscripts and shared canon/overrides; book purge only removes its override", async () => {
  const f = await fixture(),
    target = await fixture(),
    dir = await mkdtemp(join(tmpdir(), "rolltop-shared-"));
  try {
    const { w, other } = await hierarchy(f);
    const chapter = await f.store.createNode(
      other.id,
      "Other chapter",
      "chapter",
    );
    const scene = await f.store.createNode(
      other.id,
      "Other scene",
      "scene",
      chapter.id,
    );
    const first = await f.store.document(scene.id);
    if (first.document.blocks[0].type === "paragraph")
      first.document.blocks[0].content = [
        { type: "text", text: "Other book manuscript" },
      ];
    await f.store.save(scene.id, first.document, first.revision);
    const e = await shared(
      f,
      { kind: "universe", id: w.id },
      {
        values: { future: "canon" },
        overrides: [
          { bookId: f.book.id, values: { future: "this book" } },
          { bookId: other.id, values: { future: "other book" } },
        ],
        future: { keep: true },
      },
    );
    await f.store.db.query(
      "INSERT INTO manuscript_references VALUES($1,$2,$3,$4)",
      [crypto.randomUUID(), scene.id, e.id, { future: "reference" }],
    );
    const before = await f.store.document(scene.id);
    f.store.backupDirectory = dir;
    await f.store.trashBook(f.book.id);
    const dead = (await f.store.book(f.book.id)).book;
    const receipt = await f.store.purge("book", dead.id, {
      confirmTitle: dead.title,
      expectedDeletedAt: dead.deletedAt,
    });
    const live = (await f.store.entries(other.id)).find((x) => x.id === e.id);
    assert.deepEqual(live.values, e.values);
    assert.deepEqual(live.overrides, [e.overrides[1]]);
    assert.deepEqual(live.future, e.future);
    assert.deepEqual(await f.store.document(scene.id), before);
    const backup = await readBookBackup(join(dir, receipt.backup));
    assert.equal(backup.version, 9);
    assert.equal(backup.schemaVersion, 11);
    assert.equal(backup.tables.books.length, 2);
    await target.store.db.transaction(async (q) => {
      for (const t of [...backupTables].reverse()) await q(`DELETE FROM ${t}`);
      await restoreBookBackup(q, backup);
    });
    assert.deepEqual(await target.store.document(scene.id), before);
    assert.equal((await target.store.revisions(scene.id)).length, 2);
    assert.deepEqual(
      (await target.store.entries(other.id)).find((x) => x.id === e.id),
      e,
    );
    assert.equal((await target.store.references(scene.id)).length, 1);
  } finally {
    await f.pg.close();
    await target.pg.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("library snapshot lock contention fails closed before backup or deletion", async () => {
  const f = await fixture(),
    dir = await mkdtemp(join(tmpdir(), "rolltop-lock-"));
  try {
    await f.store.trashBook(f.book.id);
    const b = (await f.store.book(f.book.id)).book;
    const broken = new StudioStore(
      {
        query: f.store.db.query,
        transaction: (fn) =>
          f.store.db.transaction((q) =>
            fn((sql, params) => {
              if (sql.includes("FOR UPDATE NOWAIT"))
                throw Error("55P03 lock unavailable");
              return q(sql, params);
            }),
          ),
      },
      dir,
    );
    await assert.rejects(
      () =>
        broken.purge("book", b.id, {
          confirmTitle: b.title,
          expectedDeletedAt: b.deletedAt,
        }),
      /Finish other library edits/,
    );
    assert.deepEqual((await f.store.book(b.id)).book, b);
    assert.ok(await f.store.document(f.scene.id));
  } finally {
    await f.pg.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("definition compatibility checks include shared canon and overrides", async () => {
  const f = await fixture();
  try {
    const { w, other } = await hierarchy(f);
    const t = await editDefinition(f.store.db, f.library.id, "template", {
      name: "Shared term",
      entryType: "term",
    });
    const field = await editDefinition(f.store.db, f.library.id, "field", {
      templateId: t.id,
      label: "Choice",
      fieldType: "selection",
      options: [{ label: "A" }, { label: "B" }],
    });
    await shared(
      f,
      { kind: "universe", id: w.id },
      {
        templateId: t.id,
        values: { [field.id]: [field.options[0].id] },
        overrides: [
          { bookId: other.id, values: { [field.id]: [field.options[1].id] } },
        ],
      },
    );
    await assert.rejects(
      () =>
        editDefinition(
          f.store.db,
          f.library.id,
          "field",
          { expectedUpdatedAt: field.updatedAt, options: [field.options[0]] },
          field.id,
        ),
      /saved/,
    );
    const snapshot = await f.store.db.transaction((q) =>
      captureBook(q, f.book.id),
    );
    assert.equal(snapshot.tables.books.length, 2);
  } finally {
    await f.pg.close();
  }
});

test("schema6 migration fails atomically on unresolved scope; real v3/schema5 rows restore with inferred library ownership", async () => {
  const f = await fixture(),
    target = await fixture();
  try {
    const e = await f.store.createEntry(f.book.id, {
      name: "Kept",
      entryType: "term",
    });
    const snapshot = await f.store.db.transaction((q) =>
      captureBook(q, f.book.id),
    );
    const legacy = structuredClone(snapshot);
    legacy.version = 3;
    legacy.schemaVersion = 5;
    for (const row of legacy.tables.bible_entries) {
      delete row.library_id;
      delete row.universe_id;
      delete row.series_id;
    }
    await target.store.db.transaction(async (q) => {
      for (const t of [...backupTables].reverse()) await q(`DELETE FROM ${t}`);
      await restoreBookBackup(q, legacy);
    });
    assert.deepEqual(await target.store.entries(f.book.id), [e]);
    const restored = (
      await target.store.db.query(
        "SELECT library_id FROM bible_entries WHERE id=$1",
        [e.id],
      )
    ).rows[0];
    assert.equal(restored.library_id, f.library.id);
    const world = await editWorld(f.store.db, f.library.id, "universes", {
      title: "Legacy shared world",
    });
    const sharedLegacy = structuredClone(legacy);
    sharedLegacy.tables.universes = (
      await f.store.db.query("SELECT * FROM universes WHERE id=$1", [world.id])
    ).rows;
    sharedLegacy.tables.bible_entries[0].data = {
      ...e,
      scope: { kind: "universe", id: world.id },
    };
    await target.store.db.transaction(async (q) => {
      for (const t of [...backupTables].reverse()) await q(`DELETE FROM ${t}`);
      await restoreBookBackup(q, sharedLegacy);
    });
    const adopted = (
      await target.store.db.query("SELECT * FROM bible_entries WHERE id=$1", [
        e.id,
      ])
    ).rows[0];
    assert.equal(adopted.book_id, null);
    assert.equal(adopted.library_id, f.library.id);
    assert.deepEqual(adopted.data, sharedLegacy.tables.bible_entries[0].data);

    await removeScopeSchema(f.store);
    await f.store.db.query("UPDATE studio_schema SET version=5");
    const invalid = { ...e, scope: { kind: "book", id: crypto.randomUUID() } };
    await f.store.db.query("UPDATE bible_entries SET data=$2 WHERE id=$1", [
      e.id,
      invalid,
    ]);
    await assert.rejects(() => f.store.migrate(), /entries_scope/);
    assert.equal(
      (await f.store.db.query("SELECT version FROM studio_schema")).rows[0]
        .version,
      5,
    );
    assert.deepEqual(
      (
        await f.store.db.query("SELECT data FROM bible_entries WHERE id=$1", [
          e.id,
        ])
      ).rows[0].data,
      invalid,
    );
    assert.equal(
      (
        await f.store.db.query(
          "SELECT column_name FROM information_schema.columns WHERE table_name='bible_entries' AND column_name='library_id'",
        )
      ).rows.length,
      0,
    );
    await f.store.db.query("UPDATE bible_entries SET data=$2 WHERE id=$1", [
      e.id,
      e,
    ]);
    await f.store.migrate();
    assert.deepEqual(await f.store.entries(f.book.id), [e]);
  } finally {
    await f.pg.close();
    await target.pg.close();
  }
});

test("book purge refuses cross-library incoming passage links outside its recovery snapshot", async () => {
  const f = await fixture(),
    dir = await mkdtemp(join(tmpdir(), "rolltop-external-"));
  try {
    const e = await f.store.createEntry(f.book.id, {
      name: "Target",
      entryType: "term",
    });
    const foreign = await f.store.createLibrary("Foreign"),
      b = await f.store.createBook(foreign.id, "Foreign book");
    const chapter = await f.store.createNode(
      b.id,
      "Foreign chapter",
      "chapter",
    );
    const scene = await f.store.createNode(
      b.id,
      "Foreign scene",
      "scene",
      chapter.id,
    );
    const id = crypto.randomUUID();
    await f.store.db.query(
      "INSERT INTO manuscript_references VALUES($1,$2,$3,$4)",
      [id, scene.id, e.id, { id, future: "keep" }],
    );
    await f.store.trashBook(f.book.id);
    const dead = (await f.store.book(f.book.id)).book;
    f.store.backupDirectory = dir;
    await assert.rejects(
      () =>
        f.store.purge("book", dead.id, {
          confirmTitle: dead.title,
          expectedDeletedAt: dead.deletedAt,
        }),
      /another library/,
    );
    assert.equal((await f.store.references(scene.id)).length, 1);
    assert.ok(await f.store.book(dead.id));
  } finally {
    await f.pg.close();
    await rm(dir, { recursive: true, force: true });
  }
});
