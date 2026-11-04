// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, removeWorldSchema } from "./support.ts";
test("notes persist, validate same-book pins, preserve extras, detect stale edits and restore", async () => {
  const f = await fixture();
  try {
    await f.store.migrate();
    const before = await f.store.document(f.scene.id);
    const a = await f.store.saveNote(f.book.id, {
      text: "  Remember this\nnext line  ",
    });
    const b = await f.store.saveNote(f.book.id, { text: "Second" });
    assert.ok(a.orderKey < b.orderKey);
    assert.equal(a.text, "Remember this\nnext line");
    await f.store.db.query(
      "UPDATE notes SET data=data || $2::jsonb WHERE id=$1",
      [a.id, JSON.stringify({ future: { keep: true } })],
    );
    const moved = await f.store.saveNote(
      f.book.id,
      { nodeId: f.scene.id, text: "Edited", expectedUpdatedAt: a.updatedAt },
      a.id,
    );
    assert.deepEqual(moved.future, { keep: true });
    assert.equal(moved.nodeId, f.scene.id);
    await assert.rejects(
      () =>
        f.store.saveNote(
          f.book.id,
          { text: "Stale", expectedUpdatedAt: a.updatedAt },
          a.id,
        ),
      /changed/,
    );
    const other = await f.store.createBook(f.library.id, "Other");
    const node = await f.store.createNode(other.id, "Other chapter", "chapter");
    for (const input of [
      { text: " " },
      { text: "x".repeat(20001) },
      { text: 4 },
      { text: "ok", nodeId: node.id },
      { text: "ok", unexpected: true },
    ])
      await assert.rejects(() => f.store.saveNote(f.book.id, input));
    await assert.rejects(() =>
      f.store.saveNote(
        other.id,
        { text: "Wrong book", expectedUpdatedAt: moved.updatedAt },
        a.id,
      ),
    );
    const trashed = await f.store.saveNote(
      f.book.id,
      { deleted: true, expectedUpdatedAt: moved.updatedAt },
      a.id,
    );
    assert.ok(trashed.deletedAt);
    await assert.rejects(() =>
      f.store.saveNote(
        f.book.id,
        { text: "No", expectedUpdatedAt: trashed.updatedAt },
        a.id,
      ),
    );
    const restored = await f.store.saveNote(
      f.book.id,
      { deleted: false, expectedUpdatedAt: trashed.updatedAt },
      a.id,
    );
    assert.equal(restored.deletedAt, undefined);
    assert.equal(restored.text, "Edited");
    assert.equal((await f.store.notes(f.book.id)).length, 2);
    assert.deepEqual(await f.store.document(f.scene.id), before);
    await f.store.trashBook(f.book.id);
    await assert.rejects(() => f.store.saveNote(f.book.id, { text: "No" }));
  } finally {
    await f.pg.close();
  }
});

test("v1 upgrades transactionally to notes schema and keeps manuscripts", async () => {
  const f = await fixture();
  try {
    const before = await f.store.document(f.scene.id);
    await removeWorldSchema(f.store);
    await f.store.db.query("DROP TABLE bible_fields");
    await f.store.db.query("DROP TABLE bible_templates");
    await f.store.db.query("DROP TABLE manuscript_references");
    await f.store.db.query("DROP TABLE bible_entries");
    await f.store.db.query("DROP TABLE notes");
    await f.store.db.query("UPDATE studio_schema SET version=1");
    await f.store.migrate();
    await f.store.migrate();
    assert.equal(
      (await f.store.db.query("SELECT version FROM studio_schema")).rows[0]
        .version,
      5,
    );
    assert.deepEqual(await f.store.document(f.scene.id), before);
    assert.deepEqual(await f.store.notes(f.book.id), []);
    await f.store.saveNote(f.book.id, { text: "After upgrade" });
    assert.equal((await f.store.notes(f.book.id))[0].text, "After upgrade");
  } finally {
    await f.pg.close();
  }
});
