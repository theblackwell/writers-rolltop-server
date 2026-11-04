// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support.ts";
import { StudioError } from "../src/store.ts";
import { between } from "../src/order.ts";

test("fractional ordering supports tight gaps, repeated front inserts and existing keys", () => {
  const keys = ["00000000sg1", "00000001kw1"];
  for (let i = 0; i < 1200; i++) {
    const index = (i * 7919) % (keys.length + 1);
    const key = between(keys[index - 1], keys[index]);
    assert.match(key, /^[0-9a-z]*[1-9a-z]$/);
    if (index) assert.ok(keys[index - 1] < key);
    if (index < keys.length) assert.ok(key < keys[index]);
    keys.splice(index, 0, key);
  }
  assert.equal(new Set(keys).size, keys.length);
  assert.throws(() => between("a", "a"));
  assert.throws(() => between("a0", "b"));
});
test("renaming and moving preserve documents, IDs, history and optional record fields", async () => {
  const f = await fixture();
  try {
    const original = await f.store.document(f.scene.id);
    const doc = structuredClone(original.document);
    if (doc.blocks[0].type === "paragraph")
      doc.blocks[0].content = [
        { type: "text", text: "Kept exactly: e\u0301 雨." },
      ];
    await f.store.save(f.scene.id, doc, 1);
    await f.store.db.query(
      'UPDATE manuscript_nodes SET data=data || \'{"x-future":{"keep":true}}\'::jsonb WHERE id=$1',
      [f.scene.id],
    );
    await f.store.renameBook(f.book.id, "Renamed book");
    await f.store.renameNode(f.scene.id, "Renamed scene");
    const second = await f.store.createNode(f.book.id, "Chapter 2", "chapter");
    await f.store.moveNode(f.scene.id, second.id, null);
    const current = await f.store.book(f.book.id);
    const moved = current.nodes.find((n) => n.id === f.scene.id);
    assert.equal(current.book.title, "Renamed book");
    assert.equal(moved.title, "Renamed scene");
    assert.equal(moved.parentId, second.id);
    assert.deepEqual(moved["x-future"], { keep: true });
    assert.deepEqual((await f.store.document(f.scene.id)).document, doc);
    assert.equal((await f.store.revisions(f.scene.id)).length, 2);
    assert.deepEqual(
      (await f.store.revision(f.scene.id, 1)).document,
      original.document,
    );
    const other = await f.store.createBook(f.library.id, "Other");
    const outsider = await f.store.createNode(
      other.id,
      "Other chapter",
      "chapter",
    );
    await assert.rejects(
      () => f.store.moveNode(f.scene.id, outsider.id, null),
      StudioError,
    );
    await assert.rejects(
      () => f.store.moveNode(second.id, f.scene.id, null),
      StudioError,
    );
    await assert.rejects(
      () => f.store.moveNode(second.id, second.id, null),
      StudioError,
    );
    await assert.rejects(
      () => f.store.renameNode(f.scene.id, " "),
      StudioError,
    );
    assert.equal(
      (await f.store.book(f.book.id)).nodes.find((n) => n.id === f.scene.id)
        .parentId,
      second.id,
    );
  } finally {
    await f.pg.close();
  }
});
test("reorder changes one key, new items append after moves, parts carry their chapters", async () => {
  const f = await fixture();
  try {
    const second = await f.store.createNode(
      f.book.id,
      "Scene 2",
      "scene",
      f.chapter.id,
    );
    const third = await f.store.createNode(
      f.book.id,
      "Scene 3",
      "scene",
      f.chapter.id,
    );
    const before = (await f.store.book(f.book.id)).nodes;
    await f.store.moveNode(third.id, f.chapter.id, f.scene.id);
    const after = (await f.store.book(f.book.id)).nodes;
    assert.deepEqual(
      after.filter((n) => n.parentId === f.chapter.id).map((n) => n.id),
      [third.id, f.scene.id, second.id],
    );
    for (const n of before.filter((n) => n.id !== third.id))
      assert.equal(after.find((a) => a.id === n.id).orderKey, n.orderKey);
    const fourth = await f.store.createNode(
      f.book.id,
      "Scene 4",
      "scene",
      f.chapter.id,
    );
    assert.equal(
      (await f.store.book(f.book.id)).nodes
        .filter((n) => n.parentId === f.chapter.id)
        .at(-1).id,
      fourth.id,
    );
    const part = await f.store.createNode(f.book.id, "Part One", "part");
    await f.store.moveNode(f.chapter.id, part.id, null);
    assert.equal(
      (await f.store.book(f.book.id)).nodes.find((n) => n.id === f.chapter.id)
        .parentId,
      part.id,
    );
    assert.equal(
      (await f.store.book(f.book.id)).nodes.find((n) => n.id === f.scene.id)
        .parentId,
      f.chapter.id,
    );
  } finally {
    await f.pg.close();
  }
});
test("trash and restore preserve earlier independent trash and all saved content", async () => {
  const f = await fixture();
  try {
    const independent = await f.store.createNode(
      f.book.id,
      "Already in trash",
      "scene",
      f.chapter.id,
    );
    await f.store.trashNode(independent.id);
    const firstBatch = (await f.store.book(f.book.id)).nodes.find(
      (n) => n.id === independent.id,
    ).deletedAt;
    await f.store.trashNode(f.chapter.id);
    const saved = await f.store.document(f.scene.id);
    await assert.rejects(
      () => f.store.save(f.scene.id, saved.document, saved.revision),
      (e: unknown) => e instanceof StudioError && e.code === "ITEM_IN_TRASH",
    );
    await assert.rejects(
      () => f.store.createNode(f.book.id, "Hidden", "scene", f.chapter.id),
      StudioError,
    );
    await assert.rejects(
      () => f.store.renameNode(f.scene.id, "Hidden"),
      StudioError,
    );
    await f.store.restoreNode(f.chapter.id);
    const nodes = (await f.store.book(f.book.id)).nodes;
    assert.equal(
      nodes.find((n) => n.id === independent.id).deletedAt,
      firstBatch,
    );
    assert.ok(!nodes.find((n) => n.id === f.scene.id).deletedAt);
    assert.deepEqual(await f.store.document(f.scene.id), saved);
    assert.equal((await f.store.revisions(f.scene.id)).length, 1);
    await f.store.trashBook(f.book.id);
    await assert.rejects(
      () => f.store.createNode(f.book.id, "Hidden", "chapter"),
      StudioError,
    );
    await f.store.restoreBook(f.book.id);
    assert.equal(
      (await f.store.book(f.book.id)).nodes.find((n) => n.id === independent.id)
        .deletedAt,
      firstBatch,
    );
    assert.ok(!(await f.store.book(f.book.id)).book.deletedAt);
  } finally {
    await f.pg.close();
  }
});
test("restoring a scene restores its ancestors without restoring its siblings", async () => {
  const f = await fixture();
  try {
    const sibling = await f.store.createNode(
      f.book.id,
      "Sibling",
      "scene",
      f.chapter.id,
    );
    const part = await f.store.createNode(f.book.id, "Part One", "part");
    await f.store.moveNode(f.chapter.id, part.id, null);
    await f.store.trashBook(f.book.id);
    await f.store.restoreNode(f.scene.id);
    const state = await f.store.book(f.book.id);
    for (const id of [part.id, f.chapter.id, f.scene.id])
      assert.ok(!state.nodes.find((n) => n.id === id).deletedAt);
    assert.ok(!state.book.deletedAt);
    assert.ok(state.nodes.find((n) => n.id === sibling.id).deletedAt);
  } finally {
    await f.pg.close();
  }
});
