// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("single/multi entry fields enforce live same-book target types, retain Trash links and clear independently", async () => {
  const f = await fixture();
  try {
    const c = await f.store.templates(f.library.id),
      t = c.templates.find((t) => t.entryType === "character")!,
      home = c.fields.find((x) => x.templateId === t.id && x.key === "home")!;
    let e = await f.store.createEntry(f.book.id, {
      name: "Corin",
      entryType: "character",
    });
    e = await f.store.editEntryField(f.book.id, e.id, {
      templateId: t.id,
      expectedUpdatedAt: e.updatedAt,
      expectedTemplateUpdatedAt: t.updatedAt,
    });
    const target = await f.store.createEntry(f.book.id, {
      name: "Orchard",
      entryType: "location",
    });
    const put = (field: any, value: any, expected = e.updatedAt) =>
      f.store.editEntryField(
        f.book.id,
        e.id,
        {
          value,
          expectedUpdatedAt: expected,
          expectedFieldUpdatedAt: field.updatedAt,
        },
        field.id,
      );
    e = await put(home, target.id);
    assert.equal(e.values[home.id], target.id);
    for (const v of [e.id, "bad", [target.id]])
      await assert.rejects(() => put(home, v));
    const other = await f.store.createBook(f.library.id, "Other"),
      foreign = await f.store.createEntry(other.id, {
        name: "Foreign",
        entryType: "location",
      });
    await assert.rejects(() => put(home, foreign.id), /live entries/);
    const multi = {
      ...home,
      id: crypto.randomUUID(),
      key: "places",
      fieldType: "entryReferences",
    };
    await f.store.db.query("INSERT INTO bible_fields VALUES($1,$2,$3,$4)", [
      multi.id,
      f.library.id,
      t.id,
      multi,
    ]);
    e = await put(multi, [target.id]);
    assert.deepEqual(e.values[multi.id], [target.id]);
    await assert.rejects(() => put(multi, [target.id, target.id]), /unique/);
    await f.store.updateEntry(f.book.id, target.id, {
      deleted: true,
      expectedUpdatedAt: target.updatedAt,
    });
    await assert.rejects(() => put(home, target.id), /live entries/);
    assert.equal(
      (await f.store.entries(f.book.id)).find((x) => x.id === e.id).values[
        home.id
      ],
      target.id,
    );
    e = await put(home, null);
    assert.deepEqual(e.values[multi.id], [target.id]);
    e = await put(multi, []);
    assert.deepEqual(e.values[multi.id], []);
  } finally {
    await f.pg.close();
  }
});
test("book purge refuses unbacked incoming links from other books", async () => {
  const f = await fixture(),
    dir = await mkdtemp(join(tmpdir(), "rolltop-links-"));
  try {
    const c = await f.store.templates(f.library.id),
      home = c.fields.find((f) => f.key === "home")!;
    const target = await f.store.createEntry(f.book.id, {
      name: "Place",
      entryType: "location",
    });
    const other = await f.store.createBook(f.library.id, "Other"),
      owner = await f.store.createEntry(other.id, {
        name: "Other",
        entryType: "character",
      });
    await f.store.db.query(
      "UPDATE bible_entries SET data=data || $2::jsonb WHERE id=$1",
      [owner.id, JSON.stringify({ values: { [home.id]: target.id } })],
    );
    await f.store.trashBook(f.book.id);
    const b = (await f.store.book(f.book.id)).book;
    f.store.backupDirectory = dir;
    await assert.rejects(
      () =>
        f.store.purge("book", b.id, {
          confirmTitle: b.title,
          expectedDeletedAt: b.deletedAt,
        }),
      /incoming links/,
    );
    assert.equal((await f.store.entries(f.book.id))[0].id, target.id);
  } finally {
    await f.pg.close();
    await rm(dir, { recursive: true, force: true });
  }
});
