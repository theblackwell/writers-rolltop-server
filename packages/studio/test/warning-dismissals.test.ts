// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support.ts";
import { editWorld, bookMembership } from "../src/worlds.ts";
import { saveFact } from "../src/facts.ts";
import { saveQuestion } from "../src/questions.ts";
import { changeWarningDismissal } from "../src/warning-dismissals.ts";
import { continuityCatalog } from "../src/continuity.ts";
import { knowledgeCatalog } from "../src/knowledge.ts";
import { captureBook, restoreBookBackup, backupTables } from "../src/backup.ts";
test("intentional warning changes use exact subject CAS/shared intent and preserve unknown fields/keys, prose and recoverable history", async () => {
  const f = await fixture(),
    target = await fixture();
  try {
    const world = await editWorld(f.store.db, f.library.id, "universes", {
      title: "World",
    });
    await bookMembership(f.store.db, f.book.id, {
      universeId: world.id,
      expectedUpdatedAt: f.book.updatedAt,
    });
    const other = await f.store.createBook(f.library.id, "Companion");
    await bookMembership(f.store.db, other.id, {
      universeId: world.id,
      expectedUpdatedAt: other.updatedAt,
    });
    const fact = await saveFact(f.store.db, f.book.id, {
      scopeKind: "universe",
      text: "A shared guess",
      truth: "undecided",
      knowledge: [{ knower: "reader" }],
    });
    await f.store.db.query(
      "UPDATE facts SET data=data || $2::jsonb WHERE id=$1",
      [
        fact.id,
        {
          opaque: { keep: true },
          dismissedWarnings: [
            {
              warning: "FutureKind:abc",
              dismissedAt: fact.updatedAt,
              note: "Keep me",
            },
          ],
        },
      ],
    );
    const args = {
      subjectKind: "fact",
      subjectId: fact.id,
      key: "undecidedButKnown",
      expectedUpdatedAt: fact.updatedAt,
      editSharedCanon: true,
      note: "  Deliberate uncertainty  ",
    };
    for (const patch of [
      { key: "bad:key with space" },
      { key: "a".repeat(401) },
      { note: "x".repeat(2001) },
      { editSharedCanon: false },
      { subjectKind: "entry" },
      { unknown: true },
    ])
      await assert.rejects(() =>
        changeWarningDismissal(f.store.db, f.book.id, { ...args, ...patch }),
      );
    const results = await Promise.allSettled(
      [f.book.id, other.id].map((id) =>
        changeWarningDismissal(f.store.db, id, args),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(
      (results.find((r) => r.status === "rejected") as PromiseRejectedResult)
        .reason.status,
      409,
    );
    let catalog = await continuityCatalog(f.store.db, f.book.id);
    assert.equal(catalog.warnings.length, 0);
    assert.equal(
      catalog.intentionalWarnings[0].dismissal?.note,
      "Deliberate uncertainty",
    );
    let stored = (
      await f.store.db.query("SELECT data FROM facts WHERE id=$1", [fact.id])
    ).rows[0].data;
    assert.deepEqual(stored.opaque, { keep: true });
    assert.equal(stored.dismissedWarnings.length, 2);
    const summary = catalog.subjects[0];
    assert.ok(summary.shared);
    assert.equal(summary.updatedAt, stored.updatedAt);
    await changeWarningDismissal(f.store.db, other.id, {
      subjectKind: "fact",
      subjectId: fact.id,
      key: "undecidedButKnown",
      restore: true,
      expectedUpdatedAt: stored.updatedAt,
      editSharedCanon: true,
    });
    stored = (
      await f.store.db.query("SELECT data FROM facts WHERE id=$1", [fact.id])
    ).rows[0].data;
    assert.deepEqual(stored.dismissedWarnings, [
      {
        warning: "FutureKind:abc",
        dismissedAt: fact.updatedAt,
        note: "Keep me",
      },
    ]);
    assert.equal(
      (await continuityCatalog(f.store.db, f.book.id)).warnings.length,
      1,
    );
    const backup = await f.store.db.transaction((q) =>
      captureBook(q, f.book.id),
    );
    await target.store.db.transaction(async (q) => {
      for (const t of [...backupTables].reverse()) await q("DELETE FROM " + t);
      await restoreBookBackup(q, backup);
    });
    assert.deepEqual(
      (await target.store.db.transaction((q) => captureBook(q, f.book.id)))
        .tables,
      backup.tables,
    );
    const hidden = await f.store.createBook(f.library.id, "Unrelated");
    await assert.rejects(
      () =>
        changeWarningDismissal(f.store.db, hidden.id, {
          ...args,
          expectedUpdatedAt: stored.updatedAt,
        }),
      /not visible/,
    );
  } finally {
    await f.pg.close();
    await target.pg.close();
  }
});
test("changed places return warnings while stale keys survive; absent/empty notes and last-key removal follow canonical optional semantics", async () => {
  const f = await fixture();
  try {
    const later = await f.store.createNode(
      f.book.id,
      "Later",
      "scene",
      f.chapter.id,
    );
    let fact = await saveFact(f.store.db, f.book.id, {
      text: "Secret",
      nodeId: later.id,
      knowledge: [{ knower: "reader", nodeId: f.scene.id }],
    });
    const key =
      "learnedBeforeEstablished:reader:" + f.scene.id + ":" + later.id;
    let c = await changeWarningDismissal(f.store.db, f.book.id, {
      subjectKind: "fact",
      subjectId: fact.id,
      key,
      note: "   ",
      expectedUpdatedAt: fact.updatedAt,
    });
    assert.equal(c.intentionalWarnings[0].dismissal?.note, undefined);
    fact = (
      await f.store.db.query("SELECT data FROM facts WHERE id=$1", [fact.id])
    ).rows[0].data;
    fact = await saveFact(
      f.store.db,
      f.book.id,
      {
        knowledge: [{ knower: "reader", nodeId: f.chapter.id }],
        expectedUpdatedAt: fact.updatedAt,
      },
      fact.id,
    );
    c = await continuityCatalog(f.store.db, f.book.id);
    assert.equal(c.warnings.length, 1);
    assert.notEqual(c.warnings[0].key, key);
    await assert.rejects(
      () =>
        changeWarningDismissal(f.store.db, f.book.id, {
          subjectKind: "fact",
          subjectId: fact.id,
          key,
          expectedUpdatedAt: fact.updatedAt,
        }),
      /no longer applies/,
    );
    await changeWarningDismissal(f.store.db, f.book.id, {
      subjectKind: "fact",
      subjectId: fact.id,
      key,
      restore: true,
      expectedUpdatedAt: fact.updatedAt,
    });
    const stored = (
      await f.store.db.query("SELECT data FROM facts WHERE id=$1", [fact.id])
    ).rows[0].data;
    assert.equal(stored.dismissedWarnings, undefined);
    const before = await f.store.db.transaction((q) =>
      captureBook(q, f.book.id),
    );
    const knowledge = await knowledgeCatalog(f.store.db, f.book.id, later.id);
    assert.equal(knowledge.groups[0].facts[0].id, fact.id);
    await assert.rejects(
      () => knowledgeCatalog(f.store.db, f.book.id, crypto.randomUUID()),
      /live chapter/,
    );
    assert.deepEqual(
      (await f.store.db.transaction((q) => captureBook(q, f.book.id))).tables,
      before.tables,
    );
  } finally {
    await f.pg.close();
  }
});
