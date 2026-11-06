// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support.ts";
import { placeholders, namesCatalog, namesFrom } from "../src/names.ts";
import { saveFact } from "../src/facts.ts";
import { editWorld, bookMembership } from "../src/worlds.ts";
import { captureBook, backupTables } from "../src/backup.ts";
import { prepareNamesPlace } from "../../../apps/web/src/names-navigation.ts";
test("native bracket extraction handles Unicode graphemes, whitespace, nested and repeated text without crossing lines", () => {
  const sixty = "e\u0301".repeat(60);
  assert.deepEqual(
    [
      ...placeholders(
        "[  name ] [name] [] [  ] [outer[inner]] [two\nlines] [x] [x] [" +
          "a".repeat(61) +
          "] [" +
          sixty +
          "] [" +
          "👩‍🌾".repeat(61) +
          "]",
      ),
    ],
    ["name", "inner", "x", sixty],
  );
});
test("names scan live manuscript in bytewise binder order, visible flags/entry summaries/facts, distinct per source, with zero record changes", async () => {
  const f = await fixture();
  try {
    const world = await editWorld(f.store.db, f.library.id, "universes", {
      title: "World",
    });
    await bookMembership(f.store.db, f.book.id, {
      universeId: world.id,
      expectedUpdatedAt: f.book.updatedAt,
    });
    const shared = await f.store.createEntry(f.book.id, {
      entryType: "character",
      name: "[Keeper]",
      summary: "The [keeper home]",
      toBeNamed: true,
      scopeKind: "universe",
    });
    const local = await f.store.createEntry(f.book.id, {
      entryType: "term",
      name: "Local",
      summary: "A [keeper home] and [keeper home]",
    });
    const other = await f.store.createBook(f.library.id, "Other");
    await f.store.createEntry(other.id, {
      entryType: "term",
      name: "[Foreign]",
      toBeNamed: true,
    });
    const trashed = await f.store.createEntry(f.book.id, {
      entryType: "term",
      name: "[Trashed]",
      toBeNamed: true,
    });
    await f.store.updateEntry(f.book.id, trashed.id, {
      expectedUpdatedAt: trashed.updatedAt,
      deleted: true,
    });
    await saveFact(f.store.db, f.book.id, {
      text: "The [keeper home] has a [name].",
      scopeKind: "universe",
    });
    await saveFact(f.store.db, other.id, { text: "[Foreign fact]" });
    const front = await f.store.createNode(f.book.id, "Preface", "frontMatter");
    for (const node of [front, f.scene]) {
      const d = await f.store.document(node.id);
      await f.store.save(
        node.id,
        {
          ...d.document,
          blocks: [
            {
              id: crypto.randomUUID(),
              type: "paragraph",
              content: [
                { type: "text", text: "[Scene " },
                { type: "text", text: "name] [Scene name]" },
              ],
            },
          ],
        },
        d.revision,
      );
    }
    const before = await f.store.db.transaction((q) =>
      captureBook(q, f.book.id),
    );
    const c = await namesCatalog(f.store.db, f.book.id);
    const after = await f.store.db.transaction((q) =>
      captureBook(q, f.book.id),
    );
    for (const t of backupTables)
      assert.deepEqual(after.tables[t], before.tables[t], t);
    assert.equal(c.items.filter((n) => n.source === "flag").length, 1);
    assert.equal(c.items[0].sourceId, shared.id);
    assert.equal(c.items.filter((n) => n.source === "manuscript").length, 2);
    assert.equal(
      c.items.filter((n) => n.source === "entry" && n.sourceId === local.id)
        .length,
      1,
    );
    assert.equal(c.items.filter((n) => n.source === "fact").length, 2);
    assert.ok(
      c.items.every(
        (n) => !n.text.includes("Foreign") && !n.text.includes("Trashed"),
      ),
    );
    await f.store.trashNode(f.chapter.id);
    assert.deepEqual(
      (await namesCatalog(f.store.db, f.book.id)).items
        .filter((n) => n.source === "manuscript")
        .map((n) => n.sourceId),
      [front.id],
    );
  } finally {
    await f.pg.close();
  }
});
test("names navigation flushes before loading and rejects stale/Trash destinations, including parent Trash; front/back matter are valid", async () => {
  let loads = 0;
  const data = {
    book: { id: "book", title: "Book" },
    nodes: [
      { id: "chapter", title: "Chapter", kind: "chapter", deletedAt: "now" },
      { id: "scene", title: "Scene", kind: "scene", parentId: "chapter" },
      { id: "front", title: "Front", kind: "frontMatter" },
      { id: "back", title: "Back", kind: "backMatter" },
    ],
  };
  const load = async () => {
    loads++;
    return data;
  };
  await assert.rejects(
    prepareNamesPlace("front", async () => false, load),
    /draft or save conflict/,
  );
  assert.equal(loads, 0);
  for (const id of ["scene", "gone"])
    await assert.rejects(
      prepareNamesPlace(id, async () => true, load),
      /no longer available/,
    );
  for (const id of ["front", "back"])
    assert.equal(
      (await prepareNamesPlace(id, async () => true, load)).target.id,
      id,
    );
});

test("names fail visibly instead of truncating more than 10,000 results", () => {
  const s: any = {
    book: { id: "book" },
    entries: [],
    facts: [],
    nodes: [
      {
        id: "scene",
        bookId: "book",
        kind: "scene",
        title: "Scene",
        orderKey: "a",
      },
    ],
  };
  const document: any = {
    blocks: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: Array.from({ length: 10001 }, (_, i) => `[name${i}]`).join(
              " ",
            ),
          },
        ],
      },
    ],
  };
  assert.throws(() => namesFrom(s, [{ node_id: "scene", document }]), {
    status: 413,
  });
});
