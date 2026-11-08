// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support.ts";
import { saveFact, unlinkFacts } from "../src/facts.ts";
import { saveQuestion, unlinkQuestions } from "../src/questions.ts";
import { saveEvent, unlinkEvents } from "../src/events.ts";
import { editWorld, bookMembership } from "../src/worlds.ts";
import {
  withoutOverrideParticipants,
  withoutRecordOverride,
} from "../src/record-overrides.ts";

const bookData = async (f: any, id: string) =>
  (await f.store.db.query("SELECT data FROM books WHERE id=$1", [id])).rows[0]
    .data;

/** Replace or remove a record's overrides directly (there is no write API for them yet). */
const setOverrides = (f: any, table: string, id: string, overrides?: any[]) =>
  f.store.db.query(
    overrides
      ? `UPDATE ${table} SET data=jsonb_set(data,'{overrides}',$2::jsonb) WHERE id=$1`
      : `UPDATE ${table} SET data=data - 'overrides' WHERE id=$1`,
    overrides ? [id, JSON.stringify(overrides)] : [id],
  );

const overridesOf = async (f: any, table: string, id: string) =>
  (
    await f.store.db.query(`SELECT data FROM ${table} WHERE id=$1`, [id])
  ).rows[0].data.overrides;

test("removing one book's override drops the key only when nothing is left", () => {
  const record = {
    id: "r",
    overrides: [
      { bookId: "a", text: "A" },
      { bookId: "b", truth: "false" },
    ],
  };
  assert.deepEqual(withoutRecordOverride(record, "a").overrides, [
    { bookId: "b", truth: "false" },
  ]);
  const last = withoutRecordOverride(withoutRecordOverride(record, "a"), "b");
  assert.equal(Object.hasOwn(last, "overrides"), false);
  assert.equal(withoutRecordOverride(record, "zz"), record, "no change, same object");
});

test("purging entries from event overrides keeps other participants and drops empty overrides", () => {
  const event = {
    id: "e",
    overrides: [
      {
        bookId: "a",
        participants: [{ entryId: "gone" }, { entryId: "kept" }],
      },
      { bookId: "b", participants: [{ entryId: "gone" }] },
      { bookId: "c", title: "Kept title" },
    ],
  };
  const next = withoutOverrideParticipants(event, ["gone"]);
  assert.deepEqual(next.overrides, [
    { bookId: "a", participants: [{ entryId: "kept" }] },
    { bookId: "c", title: "Kept title" },
  ]);
});

test("a book cannot leave a world while facts, questions or events hold its overrides", async () => {
  const f = await fixture();
  try {
    const world = await editWorld(f.store.db, f.library.id, "universes", {
      title: "World",
    });
    await bookMembership(f.store.db, f.book.id, {
      universeId: world.id,
      expectedUpdatedAt: (await bookData(f, f.book.id)).updatedAt,
    });
    const fact = await saveFact(f.store.db, f.book.id, {
      text: "The lamp is lit",
      truth: "true",
      knowledge: [{ knower: "reader" }],
      scopeKind: "universe",
    });
    const question = await saveQuestion(f.store.db, f.book.id, {
      text: "Who lit it?",
      topic: "plot",
      status: "open",
      entryIds: [],
      scopeKind: "universe",
    });
    const event = await saveEvent(f.store.db, f.book.id, {
      title: "Lighting",
      summary: "",
      sceneIds: [],
      participants: [],
      scopeKind: "universe",
    });
    // Each record type blocks leaving, one at a time.
    for (const [table, item] of [
      ["facts", fact],
      ["questions", question],
      ["continuity_events", event],
    ] as const) {
      await setOverrides(f, table, item.id, [{ bookId: f.book.id, title: "x" }]);
      const current = await bookData(f, f.book.id);
      await assert.rejects(
        () =>
          bookMembership(f.store.db, f.book.id, {
            universeId: null,
            expectedUpdatedAt: current.updatedAt,
          }),
        /Clear this book's values on facts, questions or events/,
        table,
      );
      await setOverrides(f, table, item.id);
    }
    // With no overrides left, the book may leave.
    await bookMembership(f.store.db, f.book.id, {
      universeId: null,
      expectedUpdatedAt: (await bookData(f, f.book.id)).updatedAt,
    });
  } finally {
    await f.pg.close();
  }
});

test("book purge removes that book's overrides from shared records and keeps the others", async () => {
  const f = await fixture();
  try {
    const other = await f.store.createBook(f.library.id, "Companion");
    const world = await editWorld(f.store.db, f.library.id, "universes", {
      title: "World",
    });
    for (const book of [f.book, other])
      await bookMembership(f.store.db, book.id, {
        universeId: world.id,
        expectedUpdatedAt: (await bookData(f, book.id)).updatedAt,
      });
    const fact = await saveFact(f.store.db, f.book.id, {
      text: "Canon",
      truth: "true",
      knowledge: [{ knower: "reader" }],
      scopeKind: "universe",
    });
    const question = await saveQuestion(f.store.db, f.book.id, {
      text: "Canon question",
      status: "open",
      entryIds: [],
      scopeKind: "universe",
    });
    await setOverrides(f, "facts", fact.id, [
      { bookId: f.book.id, truth: "false" },
      { bookId: other.id, truth: "undecided" },
    ]);
    await setOverrides(f, "questions", question.id, [
      { bookId: f.book.id, status: "decided", decision: "Yes" },
    ]);
    await f.store.db.transaction(async (q) => {
      await unlinkFacts(q, f.library.id, [], [], f.book.id);
      await unlinkQuestions(q, f.library.id, [], [], f.book.id);
    });
    assert.deepEqual(await overridesOf(f, "facts", fact.id), [
      { bookId: other.id, truth: "undecided" },
    ]);
    assert.equal(await overridesOf(f, "questions", question.id), undefined);
  } finally {
    await f.pg.close();
  }
});

test("entry purge removes the purged entry from event overrides", async () => {
  const f = await fixture();
  try {
    const other = await f.store.createBook(f.library.id, "Companion");
    const world = await editWorld(f.store.db, f.library.id, "universes", {
      title: "World",
    });
    for (const book of [f.book, other])
      await bookMembership(f.store.db, book.id, {
        universeId: world.id,
        expectedUpdatedAt: (await bookData(f, book.id)).updatedAt,
      });
    const gone = await f.store.createEntry(f.book.id, {
      name: "Gone",
      entryType: "character",
    });
    const kept = await f.store.createEntry(f.book.id, {
      name: "Kept",
      entryType: "character",
    });
    const event = await saveEvent(f.store.db, f.book.id, {
      title: "Meeting",
      summary: "",
      sceneIds: [],
      participants: [{ entryId: kept.id, role: "Host" }],
      scopeKind: "universe",
    });
    await setOverrides(f, "continuity_events", event.id, [
      {
        bookId: other.id,
        participants: [
          { entryId: gone.id, role: "Guest" },
          { entryId: kept.id, role: "Host" },
        ],
      },
      { bookId: f.book.id, participants: [{ entryId: gone.id, role: "Guest" }] },
    ]);
    await f.store.db.transaction((q) =>
      unlinkEvents(q, f.library.id, [gone.id], []),
    );
    assert.deepEqual(await overridesOf(f, "continuity_events", event.id), [
      { bookId: other.id, participants: [{ entryId: kept.id, role: "Host" }] },
    ]);
  } finally {
    await f.pg.close();
  }
});

test("an override must carry a key besides bookId, on facts, questions and events", async () => {
  const { readFileSync } = await import("node:fs");
  const { checkArchiveSchema } = await import("../src/archive-validation.ts");
  const dir = new URL("../fixtures/archives/valid/record-overrides/", import.meta.url);
  const read = (p: string) => JSON.parse(readFileSync(new URL(p, dir), "utf8"));
  const bookId = "b0000001-0000-4000-8000-000000000001";
  const cases = [
    ["facts", read("bible/facts.json")[0]],
    ["questions", read("bible/questions.json")[0]],
    ["events", read("continuity/events.json")[0]],
  ] as const;
  for (const [name, record] of cases) {
    // The fixture record itself is valid.
    checkArchiveSchema(name, [record]);
    // bookId alone is not an override.
    assert.throws(
      () => checkArchiveSchema(name, [{ ...record, overrides: [{ bookId }] }]),
      { code: "SCHEMA_VIOLATION" },
      name,
    );
  }
});
