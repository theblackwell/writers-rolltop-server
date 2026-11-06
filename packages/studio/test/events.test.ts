// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fixture } from "./support.ts";
import { StudioStore } from "../src/store.ts";
import { saveEvent } from "../src/events.ts";
import { editWorld, bookMembership } from "../src/worlds.ts";
import {
  backupTables,
  captureBook,
  restoreBookBackup,
  readBookBackup,
} from "../src/backup.ts";
import { purgeEntry } from "../src/entry-purge.ts";

test("event schema upgrade is atomic, repeatable and preserves existing records", async () => {
  const f = await fixture();
  try {
    const before = await f.store.db.transaction((q) =>
      captureBook(q, f.book.id),
    );
    await f.store.db.query("DROP TABLE continuity_events");
    await f.store.db.query("UPDATE studio_schema SET version=9");
    const broken = new StudioStore({
      query: f.store.db.query,
      transaction: (fn) =>
        f.store.db.transaction((q) =>
          fn((sql, p) => {
            if (sql.includes("CREATE TABLE continuity_events("))
              throw Error("injected");
            return q(sql, p);
          }),
        ),
    });
    await assert.rejects(() => broken.migrate(), /injected/);
    assert.equal(
      (await f.store.db.query("SELECT version FROM studio_schema")).rows[0]
        .version,
      9,
    );
    await f.store.migrate();
    await f.store.migrate();
    assert.equal(
      (await f.store.db.query("SELECT version FROM studio_schema")).rows[0]
        .version,
      10,
    );
    assert.deepEqual(
      (await f.store.db.transaction((q) => captureBook(q, f.book.id))).tables,
      before.tables,
    );
  } finally {
    await f.pg.close();
  }
});

test("events validate canonical dates, typed links, scope, CAS, Trash and preserve opaque data", async () => {
  const f = await fixture();
  try {
    const person = await f.store.createEntry(f.book.id, {
      name: "Person",
      entryType: "character",
    });
    const entry = await f.store.createEntry(f.book.id, {
      name: "Storm",
      entryType: "event",
    });
    let item = await saveEvent(f.store.db, f.book.id, {
      title: "Storm",
      summary: "",
      when: { label: "Third moon", calendar: "Old calendar", ordinal: -3 },
      entryId: entry.id,
      sceneIds: [f.scene.id],
      participants: [{ entryId: person.id, role: "Witness" }],
    });
    const originalDocument = await f.store.document(f.scene.id);
    await f.store.db.query(
      "UPDATE continuity_events SET data=data || $2::jsonb WHERE id=$1",
      [
        item.id,
        {
          opaque: { keep: true },
          dismissedWarnings: [
            {
              warning: "stateConflict:" + entry.id + ":" + crypto.randomUUID(),
              dismissedAt: item.updatedAt,
            },
          ],
        },
      ],
    );
    for (const patch of [
      { title: 7 },
      { summary: 7 },
      { when: {} },
      { when: { label: "", ordinal: 0 } },
      { when: { label: "Date", calendar: "" } },
      { when: { label: "Date", ordinal: 1.5 } },
      { when: { label: "Date", ordinal: 9007199254740992 } },
      { when: { label: "Date", extra: true } },
      { entryId: person.id },
      { entryId: crypto.randomUUID() },
      { sceneIds: [f.chapter.id] },
      { sceneIds: [f.scene.id, f.scene.id] },
      { sceneIds: [crypto.randomUUID()] },
      { participants: [{ entryId: person.id }, { entryId: person.id }] },
      { participants: [{ entryId: person.id, role: 7 }] },
      { participants: [{ entryId: crypto.randomUUID() }] },
      { scopeKind: "series" },
      { stateChanges: [] },
      { deleted: true, title: "mixed" },
    ])
      await assert.rejects(() =>
        saveEvent(
          f.store.db,
          f.book.id,
          { ...patch, expectedUpdatedAt: item.updatedAt },
          item.id,
        ),
      );
    await assert.rejects(
      () =>
        saveEvent(
          f.store.db,
          f.book.id,
          { title: "stale", expectedUpdatedAt: "old" },
          item.id,
        ),
      /changed/,
    );
    const hidden = await f.store.createBook(f.library.id, "Other");
    const hiddenScene = await f.store.createNode(
      hidden.id,
      "Other scene",
      "scene",
      (await f.store.createNode(hidden.id, "Other chapter", "chapter")).id,
    );
    await assert.rejects(
      () =>
        saveEvent(f.store.db, f.book.id, {
          title: "No",
          sceneIds: [hiddenScene.id],
        }),
      /scope/,
    );
    await assert.rejects(
      () =>
        saveEvent(
          f.store.db,
          hidden.id,
          { title: "No", expectedUpdatedAt: item.updatedAt },
          item.id,
        ),
      /visible/,
    );
    const foreign = await f.store.createLibrary("Foreign");
    const foreignBook = await f.store.createBook(foreign.id, "Foreign book");
    const foreignEntry = await f.store.createEntry(foreignBook.id, {
      name: "Foreign",
      entryType: "event",
    });
    await assert.rejects(
      () =>
        saveEvent(f.store.db, f.book.id, {
          title: "No",
          entryId: foreignEntry.id,
        }),
      /library/,
    );
    await assert.rejects(
      () =>
        saveEvent(f.store.db, f.book.id, {
          title: "No",
          participants: [{ entryId: foreignEntry.id }],
        }),
      /library/,
    );
    item = await saveEvent(
      f.store.db,
      f.book.id,
      {
        summary: null,
        when: null,
        entryId: null,
        expectedUpdatedAt: item.updatedAt,
      },
      item.id,
    );
    assert.equal(item.summary, undefined);
    assert.equal(item.when, undefined);
    assert.equal(item.entryId, undefined);
    assert.deepEqual(item.opaque, { keep: true });
    assert.equal(item.dismissedWarnings.length, 1);
    assert.deepEqual(item.participants, [
      { entryId: person.id, role: "Witness" },
    ]);
    item = await saveEvent(
      f.store.db,
      f.book.id,
      { deleted: true, expectedUpdatedAt: item.updatedAt },
      item.id,
    );
    await assert.rejects(
      () =>
        saveEvent(
          f.store.db,
          f.book.id,
          { title: "No", expectedUpdatedAt: item.updatedAt },
          item.id,
        ),
      /Restore/,
    );
    item = await saveEvent(
      f.store.db,
      f.book.id,
      { deleted: false, expectedUpdatedAt: item.updatedAt },
      item.id,
    );
    assert.equal(item.deletedAt, undefined);
    assert.deepEqual(await f.store.document(f.scene.id), originalDocument);
    // The canonical event schema permits empty titles/summaries and role strings.
    const empty = await saveEvent(f.store.db, f.book.id, {
      title: "",
      summary: "",
      participants: [{ entryId: person.id, role: "" }],
      when: { label: "Unsorted" },
    });
    assert.equal(empty.title, "");
    assert.equal(empty.when.ordinal, undefined);
  } finally {
    await f.pg.close();
  }
});

test("continuity_events join exact recovery/legacy restore, scope guards and backed entry/node/book cleanup", async () => {
  const f = await fixture(),
    target = await fixture(),
    dir = await mkdtemp(join(tmpdir(), "rolltop-continuity_events-"));
  try {
    f.store.backupDirectory = dir;
    const world = await editWorld(f.store.db, f.library.id, "universes", {
      title: "World",
    });
    const member = await bookMembership(f.store.db, f.book.id, {
      universeId: world.id,
      expectedUpdatedAt: f.book.updatedAt,
    });
    const person = await f.store.createEntry(f.book.id, {
      name: "Person",
      entryType: "event",
    });
    let item = await saveEvent(f.store.db, f.book.id, {
      scopeKind: "universe",
      title: "Shared storm",
      sceneIds: [f.scene.id],
      participants: [{ entryId: person.id, role: "Witness" }],
      entryId: person.id,
      summary: "Keep this",
      when: { label: "Third moon", ordinal: 3 },
    });
    await assert.rejects(
      () =>
        saveEvent(
          f.store.db,
          f.book.id,
          { title: "No consent", expectedUpdatedAt: item.updatedAt },
          item.id,
        ),
      /Confirm/,
    );
    item = await saveEvent(
      f.store.db,
      f.book.id,
      {
        title: "Shared changed",
        expectedUpdatedAt: item.updatedAt,
        editSharedCanon: true,
      },
      item.id,
    );
    await assert.rejects(
      () =>
        bookMembership(f.store.db, f.book.id, {
          universeId: null,
          expectedUpdatedAt: member.updatedAt,
        }),
      /shared timeline events/,
    );
    const before = await f.store.db.transaction((q) =>
      captureBook(q, f.book.id),
    );
    assert.equal(before.version, 8);
    await target.store.db.transaction(async (q) => {
      for (const t of [...backupTables].reverse()) await q(`DELETE FROM ${t}`);
      await restoreBookBackup(q, before);
    });
    assert.deepEqual(
      (await target.store.db.transaction((q) => captureBook(q, f.book.id)))
        .tables,
      before.tables,
    );
    const legacy = {
      ...before,
      version: 7 as const,
      schemaVersion: 9 as const,
      tables: { ...before.tables },
    };
    delete legacy.tables.continuity_events;
    await target.store.db.transaction(async (q) => {
      for (const t of [...backupTables].reverse()) await q(`DELETE FROM ${t}`);
      await restoreBookBackup(q, legacy);
    });
    assert.equal(
      (await target.store.db.query("SELECT * FROM continuity_events")).rows
        .length,
      0,
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
    assert.equal(
      (await readBookBackup(join(dir, receipt.backup))).tables
        .continuity_events[0].data.participants[0].entryId,
      person.id,
    );
    let kept = (
      await f.store.db.query("SELECT data FROM continuity_events WHERE id=$1", [
        item.id,
      ])
    ).rows[0].data;
    assert.deepEqual(kept.participants, []);
    assert.equal(kept.entryId, undefined);
    assert.equal(kept.summary, "Keep this");
    assert.ok(kept.updatedAt > item.updatedAt);
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
    kept = (
      await f.store.db.query("SELECT data FROM continuity_events WHERE id=$1", [
        item.id,
      ])
    ).rows[0].data;
    assert.deepEqual(kept.sceneIds, []);
    const local = await saveEvent(f.store.db, f.book.id, { title: "Local" });
    await f.store.trashBook(f.book.id);
    const book = (
      await f.store.db.query("SELECT data FROM books WHERE id=$1", [f.book.id])
    ).rows[0].data;
    await f.store.purge("book", f.book.id, {
      confirmTitle: book.title,
      expectedDeletedAt: book.deletedAt,
    });
    assert.equal(
      (
        await f.store.db.query("SELECT id FROM continuity_events WHERE id=$1", [
          local.id,
        ])
      ).rows.length,
      0,
    );
    assert.equal(
      (
        await f.store.db.query("SELECT id FROM continuity_events WHERE id=$1", [
          item.id,
        ])
      ).rows.length,
      1,
    );
  } finally {
    await f.pg.close();
    await target.pg.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("event cleanup refuses external dependencies and rolls back with fact cleanup on failure", async () => {
  const f = await fixture(),
    dir = await mkdtemp(join(tmpdir(), "rolltop-event-rollback-"));
  try {
    f.store.backupDirectory = dir;
    const person = await f.store.createEntry(f.book.id, {
      name: "Doomed",
      entryType: "character",
    });
    const { saveFact } = await import("../src/facts.ts");
    await saveFact(f.store.db, f.book.id, {
      text: "Fact",
      entryIds: [person.id],
      knowledge: [{ knower: person.id }],
    });
    const { saveQuestion } = await import("../src/questions.ts");
    await saveQuestion(f.store.db, f.book.id, {
      text: "Question",
      entryIds: [person.id],
    });
    await saveEvent(f.store.db, f.book.id, {
      title: "Event",
      participants: [{ entryId: person.id }],
    });
    const foreign = await f.store.createLibrary("Other"),
      book = await f.store.createBook(foreign.id, "Other book");
    const event = await saveEvent(f.store.db, book.id, {
      title: "Foreign",
    });
    await f.store.db.query(
      "UPDATE continuity_events SET data=jsonb_set(data,'{participants}',$2::jsonb) WHERE id=$1",
      [event.id, [{ entryId: person.id }]],
    );
    const dead = await f.store.updateEntry(f.book.id, person.id, {
      deleted: true,
      expectedUpdatedAt: person.updatedAt,
    });
    const input = {
      confirmName: dead.name,
      expectedDeletedAt: dead.deletedAt,
      expectedUpdatedAt: dead.updatedAt,
    };
    const before = await f.store.db.transaction((q) =>
      captureBook(q, f.book.id),
    );
    await assert.rejects(
      () => purgeEntry(f.store, f.book.id, person.id, input),
      /another library/,
    );
    assert.deepEqual(
      (await f.store.db.transaction((q) => captureBook(q, f.book.id))).tables,
      before.tables,
    );
    await f.store.db.query(
      "UPDATE continuity_events SET data=jsonb_set(data,'{participants}','[]') WHERE id=$1",
      [event.id],
    );
    const broken = new StudioStore(
      {
        query: f.store.db.query,
        transaction: (fn) =>
          f.store.db.transaction((q) =>
            fn((sql, p) => {
              if (sql.startsWith("DELETE FROM bible_entries"))
                throw Error("injected deletion");
              return q(sql, p);
            }),
          ),
      },
      dir,
    );
    await assert.rejects(
      () => purgeEntry(broken, f.book.id, person.id, input),
      /injected deletion/,
    );
    assert.deepEqual(
      (await f.store.db.transaction((q) => captureBook(q, f.book.id))).tables,
      before.tables,
      "fact, question and event cleanup roll back",
    );
  } finally {
    await f.pg.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("shared series events retain scoped scenes through Trash and guard membership and parent deletion", async () => {
  const f = await fixture();
  try {
    const world = await editWorld(f.store.db, f.library.id, "universes", {
      title: "World",
    });
    const series = await editWorld(f.store.db, f.library.id, "series", {
      title: "Series",
      universeId: world.id,
    });
    const member = await bookMembership(f.store.db, f.book.id, {
      universeId: world.id,
      seriesId: series.id,
      expectedUpdatedAt: f.book.updatedAt,
    });
    const other = await f.store.createBook(f.library.id, "Other");
    await bookMembership(f.store.db, other.id, {
      universeId: world.id,
      seriesId: series.id,
      expectedUpdatedAt: other.updatedAt,
    });
    let event = await saveEvent(f.store.db, f.book.id, {
      title: "Event",
      scopeKind: "series",
      sceneIds: [f.scene.id],
    });
    event = await saveEvent(
      f.store.db,
      other.id,
      {
        deleted: true,
        editSharedCanon: true,
        expectedUpdatedAt: event.updatedAt,
      },
      event.id,
    );
    await assert.rejects(
      () =>
        bookMembership(f.store.db, f.book.id, {
          seriesId: null,
          expectedUpdatedAt: member.updatedAt,
        }),
      /shared timeline events/,
    );
    event = await saveEvent(
      f.store.db,
      other.id,
      {
        deleted: false,
        editSharedCanon: true,
        expectedUpdatedAt: event.updatedAt,
      },
      event.id,
    );
    event = await saveEvent(
      f.store.db,
      other.id,
      {
        sceneIds: [],
        editSharedCanon: true,
        expectedUpdatedAt: event.updatedAt,
      },
      event.id,
    );
    await bookMembership(f.store.db, f.book.id, {
      seriesId: null,
      expectedUpdatedAt: member.updatedAt,
    });
    const otherNow = (
      await f.store.db.query("SELECT data FROM books WHERE id=$1", [other.id])
    ).rows[0].data;
    await bookMembership(f.store.db, other.id, {
      seriesId: null,
      expectedUpdatedAt: otherNow.updatedAt,
    });
    await assert.rejects(
      () =>
        editWorld(
          f.store.db,
          f.library.id,
          "series",
          { deleted: true, expectedUpdatedAt: series.updatedAt },
          series.id,
        ),
      /timeline events/,
    );
    // Composite FKs reject a foreign library ownership for the same canonical scope.
    const foreign = await f.store.createLibrary("Foreign");
    await assert.rejects(
      () =>
        f.store.db.query(
          "UPDATE continuity_events SET library_id=$2 WHERE id=$1",
          [event.id, foreign.id],
        ),
      /foreign key/,
    );
    assert.equal(
      (
        await f.store.db.query(
          "SELECT library_id FROM continuity_events WHERE id=$1",
          [event.id],
        )
      ).rows[0].library_id,
      f.library.id,
    );
  } finally {
    await f.pg.close();
  }
});
