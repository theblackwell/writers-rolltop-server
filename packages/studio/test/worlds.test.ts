// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, removeWorldSchema } from "./support.ts";
import { backupTables, captureBook, restoreBookBackup } from "../src/backup.ts";

const worldRecord = (title: string) => ({
  id: crypto.randomUUID(),
  title,
  orderKey: "a",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  future: { keep: true },
});

test("world schema upgrades v4 without rewriting entries or manuscripts", async () => {
  const f = await fixture();
  try {
    const entry = await f.store.createEntry(f.book.id, {
      name: "Kept",
      entryType: "character",
    });
    const doc = await f.store.document(f.scene.id);
    await removeWorldSchema(f.store);
    await f.store.db.query("UPDATE studio_schema SET version=4");
    await f.store.migrate();
    await f.store.migrate();
    assert.deepEqual(await f.store.entries(f.book.id), [entry]);
    assert.deepEqual(await f.store.document(f.scene.id), doc);
    assert.equal(
      (await f.store.db.query("SELECT version FROM studio_schema")).rows[0]
        .version,
      10,
    );
  } finally {
    await f.pg.close();
  }
});

test("world ownership, matching series, deletion restrictions and recovery context", async () => {
  const f = await fixture(),
    target = await fixture();
  try {
    const world = worldRecord("Shared world"),
      serial = { ...worldRecord("Series"), universeId: world.id };
    await f.store.db.query(
      "INSERT INTO universes(id,library_id,data) VALUES($1,$2,$3)",
      [world.id, f.library.id, world],
    );
    await f.store.db.query(
      "INSERT INTO series(id,library_id,data) VALUES($1,$2,$3)",
      [serial.id, f.library.id, serial],
    );
    await assert.rejects(
      () =>
        f.store.db.query(
          "UPDATE books SET data=data || $2::jsonb WHERE id=$1",
          [f.book.id, { seriesId: serial.id }],
        ),
      /match/,
    );
    await f.store.db.query(
      "UPDATE books SET data=data || $2::jsonb WHERE id=$1",
      [f.book.id, { seriesId: serial.id, universeId: world.id }],
    );
    const foreign = await f.store.createLibrary("Other library");
    const other = await f.store.createBook(foreign.id, "Other");
    await assert.rejects(
      () =>
        f.store.db.query(
          "UPDATE books SET data=data || $2::jsonb WHERE id=$1",
          [other.id, { universeId: world.id }],
        ),
      /foreign key/,
    );
    await assert.rejects(
      () => f.store.db.query("DELETE FROM universes WHERE id=$1", [world.id]),
      /foreign key/,
    );
    await assert.rejects(
      () => f.store.db.query("DELETE FROM series WHERE id=$1", [serial.id]),
      /foreign key/,
    );
    await assert.rejects(
      () =>
        f.store.db.query(
          "UPDATE series SET data=data - 'universeId' WHERE id=$1",
          [serial.id],
        ),
      /immutable/,
    );
    const backup = await f.store.db.transaction((q) =>
      captureBook(q, f.book.id),
    );
    assert.equal(backup.version, 8);
    assert.deepEqual(
      backup.tables.universes.map((r) => r.data),
      [world],
    );
    await target.store.db.transaction(async (q) => {
      for (const table of [...backupTables].reverse())
        await q(`DELETE FROM ${table}`);
      await restoreBookBackup(q, backup);
    });
    assert.deepEqual(
      (await target.store.book(f.book.id)).book,
      (await f.store.book(f.book.id)).book,
    );
    assert.deepEqual(
      await target.store.document(f.scene.id),
      await f.store.document(f.scene.id),
    );
    // Schema4 files omit the new tables/columns and remain recoverable.
    const legacy = structuredClone(backup);
    legacy.version = 2;
    legacy.schemaVersion = 4;
    delete legacy.tables.universes;
    delete legacy.tables.series;
    legacy.tables.books[0].data = f.book;
    delete legacy.tables.books[0].universe_id;
    delete legacy.tables.books[0].series_id;
    await target.store.db.transaction(async (q) => {
      for (const table of [...backupTables].reverse())
        await q(`DELETE FROM ${table}`);
      await restoreBookBackup(q, legacy);
    });
    assert.deepEqual((await target.store.book(f.book.id)).book, f.book);
  } finally {
    await f.pg.close();
    await target.pg.close();
  }
});

test("world migration rolls back entirely when older opaque memberships cannot resolve", async () => {
  const f = await fixture();
  try {
    await removeWorldSchema(f.store);
    await f.store.db.query("UPDATE studio_schema SET version=4");
    const missing = crypto.randomUUID();
    await f.store.db.query(
      "UPDATE books SET data=data || $2::jsonb WHERE id=$1",
      [f.book.id, { universeId: missing }],
    );
    const before = (await f.store.book(f.book.id)).book;
    await assert.rejects(() => f.store.migrate(), /foreign key/);
    assert.equal(
      (await f.store.db.query("SELECT version FROM studio_schema")).rows[0]
        .version,
      4,
    );
    assert.equal(
      (await f.store.db.query("SELECT to_regclass('universes') AS name"))
        .rows[0].name,
      null,
    );
    assert.deepEqual((await f.store.book(f.book.id)).book, before);
    // Repair only the test's intentionally invalid fixture, then retry.
    await f.store.db.query(
      "UPDATE books SET data=data - 'universeId' WHERE id=$1",
      [f.book.id],
    );
    await f.store.migrate();
    const serial = worldRecord("Independent series");
    await f.store.db.query(
      "INSERT INTO series(id,library_id,data) VALUES($1,$2,$3)",
      [serial.id, f.library.id, serial],
    );
    await f.store.db.query(
      "UPDATE books SET data=data || $2::jsonb WHERE id=$1",
      [f.book.id, { seriesId: serial.id }],
    );
    assert.equal((await f.store.book(f.book.id)).book.seriesId, serial.id);
  } finally {
    await f.pg.close();
  }
});
