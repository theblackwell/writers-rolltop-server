// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fixture } from "./support.ts";
import { StudioStore } from "../src/store.ts";
import { saveQuestion } from "../src/questions.ts";
import { editWorld, bookMembership } from "../src/worlds.ts";
import {
  backupTables,
  captureBook,
  restoreBookBackup,
  readBookBackup,
} from "../src/backup.ts";
import { purgeEntry } from "../src/entry-purge.ts";

test("question schema upgrade is atomic, repeatable and preserves existing records", async () => {
  const f = await fixture();
  try {
    const before = await f.store.db.transaction((q) =>
      captureBook(q, f.book.id),
    );
    await f.store.db.query("DROP TABLE bible_exports; DROP TABLE state_changes");
    await f.store.db.query(
      "ALTER TABLE bible_fields DROP CONSTRAINT state_fields_library_identity; ALTER TABLE continuity_events DROP CONSTRAINT state_events_library_identity",
    );
    await f.store.db.query("DROP TABLE continuity_events");
    await f.store.db.query("DROP TABLE questions");
    await f.store.db.query("UPDATE studio_schema SET version=8");
    const broken = new StudioStore({
      query: f.store.db.query,
      transaction: (fn) =>
        f.store.db.transaction((q) =>
          fn((sql, p) => {
            if (sql.includes("CREATE TABLE questions("))
              throw Error("injected");
            return q(sql, p);
          }),
        ),
    });
    await assert.rejects(() => broken.migrate(), /injected/);
    assert.equal(
      (await f.store.db.query("SELECT version FROM studio_schema")).rows[0]
        .version,
      8,
    );
    await f.store.migrate();
    await f.store.migrate();
    assert.equal(
      (await f.store.db.query("SELECT version FROM studio_schema")).rows[0]
        .version,
      12,
    );
    assert.deepEqual(
      (await f.store.db.transaction((q) => captureBook(q, f.book.id))).tables,
      before.tables,
    );
  } finally {
    await f.pg.close();
  }
});

test("internal questions validate canonical optional topic/decision, scope, CAS, Trash and preserve opaque data", async () => {
  const f = await fixture();
  try {
    const person = await f.store.createEntry(f.book.id, {
      name: "Person",
      entryType: "character",
    });
    let item = await saveQuestion(f.store.db, f.book.id, {
      text: "Who?",
      topic: "Mystery",
      status: "decided",
      decision: "",
      entryIds: [person.id],
      nodeId: f.scene.id,
    });
    assert.equal(item.status, "decided");
    assert.equal(item.decision, "");
    await f.store.db.query(
      "UPDATE questions SET data=data || $2::jsonb WHERE id=$1",
      [
        item.id,
        {
          opaque: { keep: true },
          dismissedWarnings: [
            {
              warning: "questionOverdue:" + f.scene.id,
              dismissedAt: item.updatedAt,
            },
          ],
        },
      ],
    );
    for (const patch of [
      { text: "" },
      { text: "x".repeat(20001) },
      { topic: "" },
      { topic: "x".repeat(65) },
      { decision: "x".repeat(20001) },
      { status: "other" },
      { nodeId: f.book.id },
      { entryIds: [person.id, person.id] },
      { entryIds: [crypto.randomUUID()] },
      { scopeKind: "series" },
      { knowledge: [] },
    ])
      await assert.rejects(() =>
        saveQuestion(
          f.store.db,
          f.book.id,
          { ...patch, expectedUpdatedAt: item.updatedAt },
          item.id,
        ),
      );
    await assert.rejects(
      () =>
        saveQuestion(
          f.store.db,
          f.book.id,
          { text: "stale", expectedUpdatedAt: "old" },
          item.id,
        ),
      /changed/,
    );
    item = await saveQuestion(
      f.store.db,
      f.book.id,
      {
        topic: null,
        decision: null,
        nodeId: null,
        status: "open",
        expectedUpdatedAt: item.updatedAt,
      },
      item.id,
    );
    assert.equal(item.topic, undefined);
    assert.equal(item.decision, undefined);
    assert.equal(item.nodeId, undefined);
    assert.deepEqual(item.opaque, { keep: true });
    assert.equal(item.dismissedWarnings.length, 1);
    item = await saveQuestion(
      f.store.db,
      f.book.id,
      { deleted: true, expectedUpdatedAt: item.updatedAt },
      item.id,
    );
    await assert.rejects(
      () =>
        saveQuestion(
          f.store.db,
          f.book.id,
          { text: "bad", expectedUpdatedAt: item.updatedAt },
          item.id,
        ),
      /Restore/,
    );
    item = await saveQuestion(
      f.store.db,
      f.book.id,
      { deleted: false, expectedUpdatedAt: item.updatedAt },
      item.id,
    );
    assert.equal(item.deletedAt, undefined);
    const other = await f.store.createBook(f.library.id, "Other");
    await assert.rejects(
      () =>
        saveQuestion(
          f.store.db,
          other.id,
          { text: "hidden", expectedUpdatedAt: item.updatedAt },
          item.id,
        ),
      /visible/,
    );
    const foreign = await f.store.createLibrary("Foreign"),
      foreignBook = await f.store.createBook(foreign.id, "Foreign book"),
      chapter = await f.store.createNode(
        foreignBook.id,
        "Other chapter",
        "chapter",
      );
    await assert.rejects(
      () =>
        saveQuestion(f.store.db, f.book.id, { text: "No", nodeId: chapter.id }),
      /scope/,
    );
    assert.equal(
      (
        await saveQuestion(f.store.db, f.book.id, {
          text: "Unanswered but decided",
          status: "decided",
        })
      ).decision,
      undefined,
      "native allows decided without an answer",
    );
  } finally {
    await f.pg.close();
  }
});

test("questions join exact recovery/legacy restore, scope guards and backed entry/node/book cleanup", async () => {
  const f = await fixture(),
    target = await fixture(),
    dir = await mkdtemp(join(tmpdir(), "rolltop-questions-"));
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
      entryType: "character",
    });
    let item = await saveQuestion(f.store.db, f.book.id, {
      scopeKind: "universe",
      text: "Shared?",
      nodeId: f.scene.id,
      entryIds: [person.id],
      topic: "Secret",
      status: "decided",
      decision: "Answer",
    });
    await assert.rejects(
      () =>
        saveQuestion(
          f.store.db,
          f.book.id,
          { text: "No consent", expectedUpdatedAt: item.updatedAt },
          item.id,
        ),
      /Confirm/,
    );
    item = await saveQuestion(
      f.store.db,
      f.book.id,
      {
        text: "Shared changed?",
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
      /shared questions/,
    );
    const before = await f.store.db.transaction((q) =>
      captureBook(q, f.book.id),
    );
    assert.equal(before.version, 10);
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
      version: 6 as const,
      schemaVersion: 8 as const,
      tables: { ...before.tables },
    };
    delete legacy.tables.questions;
    await target.store.db.transaction(async (q) => {
      for (const t of [...backupTables].reverse()) await q(`DELETE FROM ${t}`);
      await restoreBookBackup(q, legacy);
    });
    assert.equal(
      (await target.store.db.query("SELECT * FROM questions")).rows.length,
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
      (await readBookBackup(join(dir, receipt.backup))).tables.questions[0].data
        .entryIds[0],
      person.id,
    );
    let kept = (
      await f.store.db.query("SELECT data FROM questions WHERE id=$1", [
        item.id,
      ])
    ).rows[0].data;
    assert.deepEqual(kept.entryIds, []);
    assert.equal(kept.decision, "Answer");
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
      await f.store.db.query("SELECT data FROM questions WHERE id=$1", [
        item.id,
      ])
    ).rows[0].data;
    assert.equal(kept.nodeId, undefined);
    const local = await saveQuestion(f.store.db, f.book.id, { text: "Local?" });
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
        await f.store.db.query("SELECT id FROM questions WHERE id=$1", [
          local.id,
        ])
      ).rows.length,
      0,
    );
    assert.equal(
      (
        await f.store.db.query("SELECT id FROM questions WHERE id=$1", [
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

test("question cleanup refuses external dependencies and rolls back with fact cleanup on failure", async () => {
  const f = await fixture(),
    dir = await mkdtemp(join(tmpdir(), "rolltop-question-rollback-"));
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
    await saveQuestion(f.store.db, f.book.id, {
      text: "Question?",
      entryIds: [person.id],
    });
    const foreign = await f.store.createLibrary("Other"),
      book = await f.store.createBook(foreign.id, "Other book");
    const question = await saveQuestion(f.store.db, book.id, {
      text: "Foreign?",
    });
    await f.store.db.query(
      "UPDATE questions SET data=jsonb_set(data,'{entryIds}',$2::jsonb) WHERE id=$1",
      [question.id, [person.id]],
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
      "UPDATE questions SET data=jsonb_set(data,'{entryIds}','[]') WHERE id=$1",
      [question.id],
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
      "both fact and question cleanup roll back",
    );
  } finally {
    await f.pg.close();
    await rm(dir, { recursive: true, force: true });
  }
});
