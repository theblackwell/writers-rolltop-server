// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support.ts";
import { planningCatalog, savePlanning } from "../src/planning.ts";
import { captureBook, restoreBookBackup, backupTables } from "../src/backup.ts";
import { editWorld, bookMembership } from "../src/worlds.ts";
test("planning edits preserve prose, opaque fields and optional semantics; live totals avoid double counting and recovery is exact", async () => {
  const f = await fixture(),
    target = await fixture();
  try {
    await f.store.db.query(
      "UPDATE books SET data=data || $2::jsonb WHERE id=$1",
      [f.book.id, { future: { keep: true } }],
    );
    const b = await savePlanning(f.store.db, f.book.id, {
      expectedUpdatedAt: f.book.updatedAt,
      logline: "  A story.  ",
      premise: "Premise",
      themes: "Themes",
      arcs: "Arcs",
      principles: "Principles",
    });
    assert.equal(b.logline, "  A story.  ");
    assert.deepEqual(b.future, { keep: true });
    await assert.rejects(
      savePlanning(f.store.db, f.book.id, {
        expectedUpdatedAt: f.book.updatedAt,
        logline: "stale",
      }),
      { status: 409 },
    );
    const part = await f.store.createNode(f.book.id, "Act I", "part");
    await f.store.moveNode(f.chapter.id, part.id, null);
    const current = (await f.store.book(f.book.id)).nodes.find(
      (n: any) => n.id === f.chapter.id,
    )!;
    const character = await f.store.createEntry(f.book.id, {
        name: "Hero",
        entryType: "character",
      }),
      place = await f.store.createEntry(f.book.id, {
        name: "Home",
        entryType: "location",
      });
    const original = await f.store.document(f.scene.id);
    await f.store.save(
      f.scene.id,
      {
        ...original.document,
        blocks: [
          {
            id: crypto.randomUUID(),
            type: "paragraph",
            content: [{ type: "text", text: "Three saved words." }],
          },
        ],
      },
      original.revision,
    );
    const prose = await f.store.document(f.scene.id);
    const p = await savePlanning(
      f.store.db,
      f.book.id,
      {
        expectedUpdatedAt: part.updatedAt,
        targetWordCount: 100,
        plan: "Act beats",
      },
      part.id,
    );
    const c = await savePlanning(
      f.store.db,
      f.book.id,
      {
        expectedUpdatedAt: current.updatedAt,
        targetWordCount: 10,
        plan: "Chapter beats",
        synopsis: "",
        status: "Custom stage",
        povEntryId: character.id,
        settingEntryId: place.id,
      },
      f.chapter.id,
    );
    assert.equal(c.synopsis, "");
    assert.equal(c.status, "Custom stage");
    let catalog = await planningCatalog(f.store.db, f.book.id);
    assert.equal(catalog.words, 3);
    assert.equal(catalog.nodeWords[part.id], 3);
    assert.equal(catalog.nodeWords[f.chapter.id], 3);
    assert.equal(catalog.nodeWords[f.scene.id], 3);
    assert.equal(catalog.nodes[0].id, part.id);
    assert.deepEqual(await f.store.document(f.scene.id), prose);
    const cleared = await savePlanning(
      f.store.db,
      f.book.id,
      {
        expectedUpdatedAt: c.updatedAt,
        targetWordCount: null,
        plan: "  ",
        synopsis: null,
        status: "",
        povEntryId: null,
      },
      c.id,
    );
    for (const k of ["targetWordCount", "plan", "synopsis", "povEntryId"])
      assert.equal(Object.hasOwn(cleared, k), false);
    assert.equal(cleared.status, "");
    assert.equal(cleared.settingEntryId, place.id);
    await f.store.trashNode(f.chapter.id);
    catalog = await planningCatalog(f.store.db, f.book.id);
    assert.equal(catalog.words, 0);
    assert.equal(catalog.nodes.length, 1);
    await assert.rejects(
      savePlanning(
        f.store.db,
        f.book.id,
        { expectedUpdatedAt: f.scene.updatedAt, synopsis: "Trash" },
        f.scene.id,
      ),
      { status: 400 },
    );
    await f.store.restoreNode(f.chapter.id);
    const backup = await f.store.db.transaction((q) =>
      captureBook(q, f.book.id),
    );
    await target.store.db.transaction(async (q) => {
      for (const t of [...backupTables].reverse()) await q("DELETE FROM " + t);
      await restoreBookBackup(q, backup);
    });
    const restored = await target.store.db.transaction((q) =>
      captureBook(q, f.book.id),
    );
    const sort = (r: any[]) =>
      JSON.parse(JSON.stringify(r)).sort((a: any, b: any) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
      );
    for (const table of backupTables)
      assert.deepEqual(
        sort(restored.tables[table]),
        sort(backup.tables[table]),
        table,
      );
  } finally {
    await f.pg.close();
    await target.pg.close();
  }
});
test("planning validates kind, bounded text/targets and visible typed links; stale writes cannot discard draft or unknown links", async () => {
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
      name: "Shared hero",
      entryType: "character",
      scopeKind: "universe",
    });
    const other = await f.store.createBook(f.library.id, "Other");
    const foreign = await f.store.createEntry(other.id, {
      name: "Other hero",
      entryType: "character",
    });
    const location = await f.store.createEntry(f.book.id, {
      name: "Place",
      entryType: "location",
    });
    for (const patch of [
      { targetWordCount: 0 },
      { targetWordCount: 1.5 },
      { targetWordCount: 9007199254740992 },
      { plan: "x".repeat(20001) },
      { status: "x".repeat(65) },
      { povEntryId: location.id },
      { povEntryId: foreign.id },
      { settingEntryId: shared.id },
      { povEntryId: "bad" },
      { title: "no" },
    ])
      await assert.rejects(
        savePlanning(
          f.store.db,
          f.book.id,
          { expectedUpdatedAt: f.chapter.updatedAt, ...patch },
          f.chapter.id,
        ),
        { status: 400 },
      );
    await assert.rejects(
      savePlanning(
        f.store.db,
        f.book.id,
        {
          expectedUpdatedAt: f.scene.updatedAt,
          plan: "scene has no plan field",
        },
        f.scene.id,
      ),
      { status: 400 },
    );
    const c = await savePlanning(
      f.store.db,
      f.book.id,
      { expectedUpdatedAt: f.chapter.updatedAt, povEntryId: shared.id },
      f.chapter.id,
    );
    assert.equal(c.povEntryId, shared.id);
    const races = await Promise.allSettled([
      savePlanning(
        f.store.db,
        f.book.id,
        { expectedUpdatedAt: c.updatedAt, status: "A" },
        c.id,
      ),
      savePlanning(
        f.store.db,
        f.book.id,
        { expectedUpdatedAt: c.updatedAt, status: "B" },
        c.id,
      ),
    ]);
    assert.equal(races.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(
      (races.find((r) => r.status === "rejected") as PromiseRejectedResult)
        .reason.status,
      409,
    );
    const last = await f.store.createNode(
      f.book.id,
      "Later chapter",
      "chapter",
    );
    await f.store.db.query(
      "UPDATE manuscript_nodes SET data=data || $2::jsonb WHERE id=$1",
      [f.chapter.id, { orderKey: "Z" }],
    );
    await f.store.db.query(
      "UPDATE manuscript_nodes SET data=data || $2::jsonb WHERE id=$1",
      [last.id, { orderKey: "a" }],
    );
    const ordered = await planningCatalog(f.store.db, f.book.id);
    assert.deepEqual(
      ordered.nodes.filter((n) => n.kind === "chapter").map((n) => n.id),
      [f.chapter.id, last.id],
    );
    const unknown = crypto.randomUUID();
    await f.store.db.query(
      "UPDATE manuscript_nodes SET data=data || $2::jsonb WHERE id=$1",
      [f.scene.id, { povEntryId: unknown, opaque: { keep: 1 } }],
    );
    const s = await savePlanning(
      f.store.db,
      f.book.id,
      {
        expectedUpdatedAt: f.scene.updatedAt,
        povEntryId: unknown,
        synopsis: "New",
      },
      f.scene.id,
    );
    assert.equal(s.povEntryId, unknown);
    assert.deepEqual(s.opaque, { keep: 1 });
    const cleared = await savePlanning(
      f.store.db,
      f.book.id,
      { expectedUpdatedAt: s.updatedAt, povEntryId: null },
      s.id,
    );
    assert.equal(Object.hasOwn(cleared, "povEntryId"), false);
    await assert.rejects(
      savePlanning(
        f.store.db,
        f.book.id,
        { expectedUpdatedAt: c.updatedAt, status: "wrong book" },
        crypto.randomUUID(),
      ),
      { status: 404 },
    );
  } finally {
    await f.pg.close();
  }
});
