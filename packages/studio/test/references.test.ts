// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, removeWorldSchema } from "./support.ts";
test("references require saved anchors and live same-book entries; Trash preserves anchors and extras", async () => {
  const f = await fixture();
  try {
    const entry = await f.store.createEntry(f.book.id, {
      name: "  Corin  ",
      entryType: "character",
      summary: "Carries a letter",
    });
    assert.equal(entry.name, "Corin");
    assert.deepEqual(entry.scope, { kind: "book", id: f.book.id });
    assert.deepEqual(entry.values, {});
    assert.equal((await f.store.entries(f.book.id))[0].id, entry.id);
    for (const input of [
      { name: "", entryType: "character" },
      { name: "x", entryType: "invalid" },
      { name: "x", entryType: "term", scope: {} },
      { name: "x", entryType: "term", summary: 4 },
    ])
      await assert.rejects(() => f.store.createEntry(f.book.id, input));
    const before = await f.store.document(f.scene.id);
    const anchorId = randomUUID();
    const input = {
      entryId: entry.id,
      anchorId,
      expectedRevision: before.revision,
    };
    await assert.rejects(
      () => f.store.saveReference(f.scene.id, input),
      /anchor/,
    );
    const document = structuredClone(before.document);
    if (document.blocks[0].type === "sceneBreak")
      throw new Error("Expected paragraph");
    document.blocks[0].content = [
      {
        type: "text",
        text: "Corin",
        marks: [{ type: "anchor", id: anchorId }, { type: "strong" }],
      },
    ];
    const saved = await f.store.save(f.scene.id, document, before.revision);
    await assert.rejects(
      () => f.store.saveReference(f.scene.id, input),
      /changed/,
    );
    input.expectedRevision = saved.revision;
    const other = await f.store.createBook(f.library.id, "Other");
    const foreign = await f.store.createEntry(other.id, {
      name: "Foreign",
      entryType: "term",
    });
    await assert.rejects(() =>
      f.store.saveReference(f.scene.id, { ...input, entryId: foreign.id }),
    );
    await assert.rejects(() =>
      f.store.saveReference(f.scene.id, { ...input, entryId: "invalid" }),
    );
    const savedDocument = await f.store.document(f.scene.id);
    const reference = await f.store.saveReference(f.scene.id, input);
    await assert.rejects(
      () => f.store.saveReference(f.scene.id, input),
      /already/,
    );
    assert.deepEqual(await f.store.document(f.scene.id), savedDocument);
    await f.store.db.query(
      "UPDATE manuscript_references SET data=data || $2::jsonb WHERE id=$1",
      [reference.id, JSON.stringify({ future: { keep: true } })],
    );
    const trashed = await f.store.saveReference(
      f.scene.id,
      { deleted: true, expectedUpdatedAt: reference.updatedAt },
      reference.id,
    );
    assert.ok(trashed.deletedAt);
    assert.deepEqual(trashed.future, { keep: true });
    await assert.rejects(
      () =>
        f.store.saveReference(
          f.scene.id,
          { deleted: false, expectedUpdatedAt: reference.updatedAt },
          reference.id,
        ),
      /changed/,
    );
    const restored = await f.store.saveReference(
      f.scene.id,
      { deleted: false, expectedUpdatedAt: trashed.updatedAt },
      reference.id,
    );
    assert.equal(restored.deletedAt, undefined);
    assert.deepEqual(await f.store.document(f.scene.id), savedDocument);
    const removed = structuredClone(document);
    if (removed.blocks[0].type === "sceneBreak")
      throw new Error("Expected paragraph");
    removed.blocks[0].content = [
      { type: "text", text: "Corin", marks: [{ type: "strong" }] },
    ];
    await f.store.save(f.scene.id, removed, saved.revision);
    assert.equal((await f.store.references(f.scene.id))[0].anchorId, anchorId);
    const missing = await f.store.saveReference(
      f.scene.id,
      { deleted: true, expectedUpdatedAt: restored.updatedAt },
      reference.id,
    );
    await assert.rejects(
      () =>
        f.store.saveReference(
          f.scene.id,
          { deleted: false, expectedUpdatedAt: missing.updatedAt },
          reference.id,
        ),
      /anchor/,
    );
    await f.store.trashBook(f.book.id);
    await assert.rejects(() =>
      f.store.createEntry(f.book.id, { name: "No", entryType: "term" }),
    );
    await assert.rejects(() => f.store.saveReference(f.scene.id, input));
  } finally {
    await f.pg.close();
  }
});
test("v2 upgrades preserve notes and manuscripts", async () => {
  const f = await fixture();
  try {
    const note = await f.store.saveNote(f.book.id, { text: "Keep note" });
    const doc = await f.store.document(f.scene.id);
    await removeWorldSchema(f.store);
    await f.store.db.query("DROP TABLE bible_fields");
    await f.store.db.query("DROP TABLE bible_templates");
    await f.store.db.query("DROP TABLE manuscript_references");
    await f.store.db.query("DROP TABLE bible_entries");
    await f.store.db.query("UPDATE studio_schema SET version=2");
    await f.store.migrate();
    await f.store.migrate();
    assert.equal(
      (await f.store.db.query("SELECT version FROM studio_schema")).rows[0]
        .version,
      10,
    );
    assert.deepEqual(await f.store.notes(f.book.id), [note]);
    assert.deepEqual(await f.store.document(f.scene.id), doc);
  } finally {
    await f.pg.close();
  }
});
