// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support.ts";
import { wordCount } from "../../document-adapter/src/text.ts";
test("goal totals join marked runs, count Unicode words and aggregate live hierarchy only", async () => {
  const f = await fixture();
  try {
    const before = await f.store.document(f.scene.id);
    const doc = structuredClone(before.document);
    doc.blocks = [
      {
        id: crypto.randomUUID(),
        type: "paragraph",
        content: [
          { type: "text", text: "hel", marks: [{ type: "strong" }] },
          { type: "text", text: "lo world" },
          { type: "hardBreak" },
          { type: "text", text: "café 123 🙂" },
        ],
      },
    ];
    assert.equal(wordCount(doc), 4);
    await f.store.save(f.scene.id, doc, before.revision);
    const front = await f.store.createNode(f.book.id, "Preface", "frontMatter");
    const frontDoc = await f.store.document(front.id);
    frontDoc.document.blocks = [
      {
        id: crypto.randomUUID(),
        type: "paragraph",
        content: [{ type: "text", text: "One more" }],
      },
    ];
    await f.store.save(front.id, frontDoc.document, frontDoc.revision);
    const other = await f.store.createBook(f.library.id, "Other");
    const progress = await f.store.progress(f.book.id);
    assert.equal(progress.words, 6);
    assert.equal(progress.nodeWords[f.chapter.id], 4);
    assert.equal(progress.nodeWords[f.scene.id], 4);
    assert.equal(progress.nodeWords[front.id], 2);
    assert.equal((await f.store.progress(other.id)).words, 0);
    const saved = await f.store.document(f.scene.id);
    await f.store.trashNode(f.chapter.id);
    const trashed = await f.store.progress(f.book.id);
    assert.equal(trashed.words, 2);
    assert.equal(trashed.nodeWords[f.scene.id], undefined);
    await f.store.restoreNode(f.chapter.id);
    assert.equal((await f.store.progress(f.book.id)).words, 6);
    assert.deepEqual(await f.store.document(f.scene.id), saved);
    await f.store.trashBook(f.book.id);
    assert.equal((await f.store.progress(f.book.id)).words, 0);
    await assert.rejects(() => f.store.progress(crypto.randomUUID()));
  } finally {
    await f.pg.close();
  }
});
