// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support.ts";

test("search joins marked text, treats punctuation literally, isolates books and excludes Trash", async () => {
  const f = await fixture();
  try {
    const { document } = await f.store.document(f.scene.id);
    const block = document.blocks[0];
    if (block.type !== "paragraph") throw new Error("Expected paragraph");
    block.content = [
      { type: "text", text: "Rain ", marks: [{ type: "strong" }] },
      { type: "text", text: "雨 100%_ <script>" },
    ];
    await f.store.save(f.scene.id, document, 1);
    assert.equal(
      (await f.store.search(f.book.id, "RAIN 雨")).results[0].nodeId,
      f.scene.id,
    );
    assert.equal((await f.store.search(f.book.id, "%_")).results.length, 1);
    assert.equal(
      (await f.store.search(f.book.id, "Scene 1")).results.length,
      1,
    );
    assert.equal(
      (await f.store.search(f.book.id, "not present")).results.length,
      0,
    );
    const other = await f.store.createBook(f.library.id, "Other");
    assert.equal((await f.store.search(other.id, "rain")).results.length, 0);
    await assert.rejects(() => f.store.search(f.book.id, " "));
    await assert.rejects(() => f.store.search(f.book.id, "x".repeat(201)));
    await f.store.trashNode(f.chapter.id);
    assert.equal((await f.store.search(f.book.id, "rain")).results.length, 0);
    await f.store.restoreNode(f.chapter.id);
    assert.equal((await f.store.search(f.book.id, "rain")).results.length, 1);
    assert.deepEqual((await f.store.document(f.scene.id)).document, document);
    assert.equal((await f.store.document(f.scene.id)).revision, 2);
    await f.store.trashBook(f.book.id);
    assert.equal((await f.store.search(f.book.id, "rain")).results.length, 0);
  } finally {
    await f.pg.close();
  }
});
