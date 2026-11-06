// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture } from "./support.ts";
import { saveFact } from "../src/facts.ts";
import { StudioStore } from "../src/store.ts";
import {
  captureBook,
  backupTables,
  readBookBackup,
  restoreBookBackup,
} from "../src/backup.ts";
import { purgeEntry } from "../src/entry-purge.ts";
import { editWorld, bookMembership } from "../src/worlds.ts";

test("facts migration v7 is atomic, repeatable and preserves documents", async () => {
  const f = await fixture();
  try {
    const before = await f.store.document(f.scene.id);
    await f.store.db.query("DROP TABLE state_changes");
    await f.store.db.query(
      "ALTER TABLE bible_fields DROP CONSTRAINT state_fields_library_identity; ALTER TABLE continuity_events DROP CONSTRAINT state_events_library_identity",
    );
    await f.store.db.query("DROP TABLE continuity_events");
    await f.store.db.query("DROP TABLE questions");
    await f.store.db.query("DROP TABLE facts");
    await f.store.db.query("UPDATE studio_schema SET version=7");
    const broken = new StudioStore({
      query: f.store.db.query,
      transaction: (fn) =>
        f.store.db.transaction((q) =>
          fn((sql, p) => {
            if (sql.includes("CREATE TABLE facts(")) throw Error("injected");
            return q(sql, p);
          }),
        ),
    });
    await assert.rejects(() => broken.migrate(), /injected/);
    assert.equal(
      (await f.store.db.query("SELECT version FROM studio_schema")).rows[0]
        .version,
      7,
    );
    await f.store.migrate();
    await f.store.migrate();
    assert.equal(
      (await f.store.db.query("SELECT version FROM studio_schema")).rows[0]
        .version,
      11,
    );
    assert.deepEqual(await f.store.document(f.scene.id), before);
  } finally {
    await f.pg.close();
  }
});
test("internal fact storage validates scope, chapters/scenes, knowers, CAS, Trash and preserves opaque data", async () => {
  const f = await fixture();
  try {
    const person = await f.store.createEntry(f.book.id, {
      name: "Person",
      entryType: "character",
    });
    let fact = await saveFact(f.store.db, f.book.id, {
      text: "A secret",
      truth: "false",
      entryIds: [person.id],
      nodeId: f.scene.id,
      knowledge: [
        { knower: "reader" },
        { knower: person.id, nodeId: f.chapter.id },
      ],
    });
    assert.equal(fact.truth, "false");
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
    await assert.rejects(
      () =>
        saveFact(
          f.store.db,
          f.book.id,
          { text: "stale", expectedUpdatedAt: "old" },
          fact.id,
        ),
      /changed/,
    );
    for (const patch of [
      { entryIds: [person.id, person.id] },
      { knowledge: [{ knower: "reader" }, { knower: "reader" }] },
      { knowledge: [{ knower: "missing" }] },
      { nodeId: f.book.id },
      { truth: true },
      { text: "" },
    ])
      await assert.rejects(() =>
        saveFact(
          f.store.db,
          f.book.id,
          { ...patch, expectedUpdatedAt: fact.updatedAt },
          fact.id,
        ),
      );
    fact = await saveFact(
      f.store.db,
      f.book.id,
      { text: "Changed", expectedUpdatedAt: fact.updatedAt },
      fact.id,
    );
    assert.deepEqual(fact.opaque, { keep: true });
    assert.equal(fact.dismissedWarnings.length, 1);
    fact = await saveFact(
      f.store.db,
      f.book.id,
      { deleted: true, expectedUpdatedAt: fact.updatedAt },
      fact.id,
    );
    await assert.rejects(
      () =>
        saveFact(
          f.store.db,
          f.book.id,
          { text: "no", expectedUpdatedAt: fact.updatedAt },
          fact.id,
        ),
      /Restore/,
    );
    fact = await saveFact(
      f.store.db,
      f.book.id,
      { deleted: false, expectedUpdatedAt: fact.updatedAt },
      fact.id,
    );
    assert.equal(fact.deletedAt, undefined);
    const other = await f.store.createBook(f.library.id, "Other");
    await assert.rejects(
      () =>
        saveFact(
          f.store.db,
          other.id,
          { text: "hidden", expectedUpdatedAt: fact.updatedAt },
          fact.id,
        ),
      /visible/,
    );
  } finally {
    await f.pg.close();
  }
});
test("facts join verified recovery, shared membership guards and backed entry/node/book cleanup; legacy recovery remains accepted", async () => {
  const f = await fixture(),
    target = await fixture(),
    dir = await mkdtemp(join(tmpdir(), "rolltop-facts-"));
  try {
    f.store.backupDirectory = dir;
    const world = await editWorld(f.store.db, f.library.id, "universes", {
      title: "World",
    });
    const membership = await bookMembership(f.store.db, f.book.id, {
      universeId: world.id,
      expectedUpdatedAt: f.book.updatedAt,
    });
    const person = await f.store.createEntry(f.book.id, {
      name: "Person",
      entryType: "character",
    });
    const fact = await saveFact(f.store.db, f.book.id, {
      scopeKind: "universe",
      text: "Shared secret",
      entryIds: [person.id],
      nodeId: f.scene.id,
      knowledge: [
        { knower: person.id },
        { knower: "reader", nodeId: f.scene.id },
      ],
    });
    await assert.rejects(
      () =>
        bookMembership(f.store.db, f.book.id, {
          universeId: null,
          expectedUpdatedAt: membership.updatedAt,
        }),
      /shared facts/,
    );
    const dead = await f.store.updateEntry(f.book.id, person.id, {
      deleted: true,
      expectedUpdatedAt: person.updatedAt,
    });
    const receipt = await purgeEntry(f.store, f.book.id, person.id, {
      confirmName: dead.name,
      expectedDeletedAt: dead.deletedAt,
      expectedUpdatedAt: dead.updatedAt,
    });
    const after = (
      await f.store.db.query("SELECT data FROM facts WHERE id=$1", [fact.id])
    ).rows[0].data;
    assert.deepEqual(after.entryIds, []);
    assert.deepEqual(after.knowledge, [
      { knower: "reader", nodeId: f.scene.id },
    ]);
    const backup = await readBookBackup(join(dir, receipt.backup));
    assert.equal(backup.version, 9);
    assert.equal(backup.tables.facts.length, 1);
    await target.store.db.transaction(async (q) => {
      for (const t of [...backupTables].reverse()) await q(`DELETE FROM ${t}`);
      await restoreBookBackup(q, backup);
    });
    const restored = await target.store.db.transaction((q) =>
      captureBook(q, f.book.id),
    );
    assert.deepEqual(restored.tables.facts, backup.tables.facts);
    const legacy = {
      ...backup,
      version: 5 as const,
      schemaVersion: 7 as const,
      tables: { ...backup.tables },
    };
    delete legacy.tables.facts;
    await target.store.db.transaction(async (q) => {
      for (const t of [...backupTables].reverse()) await q(`DELETE FROM ${t}`);
      await restoreBookBackup(q, legacy);
    });
    assert.equal(
      (await target.store.db.query("SELECT * FROM facts")).rows.length,
      0,
    );
    await f.store.trashNode(f.scene.id);
    const scene = (
      await f.store.db.query("SELECT data FROM manuscript_nodes WHERE id=$1", [
        f.scene.id,
      ])
    ).rows[0].data;
    await f.store.purge("node", f.scene.id, {
      confirmTitle: scene.title,
      expectedDeletedAt: scene.deletedAt,
    });
    const unlinked = (
      await f.store.db.query("SELECT data FROM facts WHERE id=$1", [fact.id])
    ).rows[0].data;
    assert.equal(unlinked.nodeId, undefined);
    assert.deepEqual(unlinked.knowledge, []);
    const local = await saveFact(f.store.db, f.book.id, { text: "local" });
    await f.store.trashBook(f.book.id);
    const book = (
      await f.store.db.query("SELECT data FROM books WHERE id=$1", [f.book.id])
    ).rows[0].data;
    await f.store.purge("book", f.book.id, {
      confirmTitle: book.title,
      expectedDeletedAt: book.deletedAt,
    });
    assert.equal(
      (await f.store.db.query("SELECT id FROM facts WHERE id=$1", [local.id]))
        .rows.length,
      0,
    );
    assert.equal(
      (await f.store.db.query("SELECT id FROM facts WHERE id=$1", [fact.id]))
        .rows.length,
      1,
    );
  } finally {
    await f.pg.close();
    await target.pg.close();
    await rm(dir, { recursive: true, force: true });
  }
});
