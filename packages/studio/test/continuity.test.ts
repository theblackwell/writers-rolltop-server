// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support.ts";
import { studioServer } from "../src/http.ts";
import { passwordHash } from "../src/auth.ts";
import { continuityCatalog } from "../src/continuity.ts";
import { captureBook } from "../src/backup.ts";
import { editWorld, bookMembership } from "../src/worlds.ts";
import { saveFact } from "../src/facts.ts";
import { saveQuestion } from "../src/questions.ts";
import { saveEvent } from "../src/events.ts";
import { saveStateChange } from "../src/state-changes.ts";
import type { Database } from "../src/store.ts";
test("continuity GET is authenticated, library/scope-isolated, read-only and reacts to saved text/truth/Trash/state", async () => {
  const f = await fixture(),
    origin = "http://localhost:4317",
    server = studioServer(f.store, {
      origin,
      passwordHash: await passwordHash("scratch-continuity"),
    });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + (server.address() as any).port + "/api";
  let cookie = "";
  const req = (path: string, method = "GET", body?: object) =>
    fetch(base + path, {
      method,
      headers: {
        Cookie: cookie,
        Origin: origin,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  try {
    const path = "/books/" + f.book.id + "/continuity";
    assert.equal((await req(path)).status, 401);
    cookie = (
      await req("/login", "POST", { password: "scratch-continuity" })
    ).headers
      .get("set-cookie")!
      .split(";")[0];
    assert.equal((await req("/books/no/continuity")).status, 400);
    assert.equal(
      (await req("/books/" + crypto.randomUUID() + "/continuity")).status,
      404,
    );
    assert.equal((await req(path, "POST", {})).status, 404);
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
    const hidden = await saveFact(f.store.db, other.id, {
      text: "Hidden local",
      truth: "undecided",
      knowledge: [{ knower: "reader" }],
    });
    const foreignLib = await f.store.createLibrary("Foreign"),
      foreign = await f.store.createBook(foreignLib.id, "Foreign");
    await saveFact(f.store.db, foreign.id, {
      text: "Foreign secret",
      truth: "undecided",
      knowledge: [{ knower: "reader" }],
    });
    let fact = await saveFact(f.store.db, f.book.id, {
      scopeKind: "universe",
      text: "A shared mystery",
      truth: "undecided",
      knowledge: [{ knower: "reader" }],
    });
    const question = await saveQuestion(f.store.db, f.book.id, {
      text: "Who delivered it?",
      nodeId: f.chapter.id,
    });
    let result = await (await req(path)).json();
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0].subject.id, fact.id);
    assert.ok(!JSON.stringify(result).includes(hidden.text));
    assert.ok(!JSON.stringify(result).includes("Foreign secret"));
    const original = await f.store.document(f.scene.id);
    const document = {
      ...original.document,
      blocks: [
        {
          id: crypto.randomUUID(),
          type: "paragraph" as const,
          content: [{ type: "text" as const, text: "... — !!!" }],
        },
      ],
    };
    await f.store.save(f.scene.id, document, original.revision);
    assert.equal(
      (await continuityCatalog(f.store.db, f.book.id)).warnings.some(
        (w) => w.kind === "questionOverdue",
      ),
      false,
    );
    const current = await f.store.document(f.scene.id);
    document.blocks[0].content[0].text = "One recorded word";
    await f.store.save(f.scene.id, document, current.revision);
    result = await (await req(path)).json();
    assert.ok(
      result.warnings.some(
        (w: any) => w.key === "questionOverdue:" + f.chapter.id,
      ),
    );
    assert.ok(!JSON.stringify(result).includes("One recorded word"));
    await f.store.db.query(
      "UPDATE facts SET data=data || $2::jsonb WHERE id=$1",
      [
        fact.id,
        {
          dismissedWarnings: [
            {
              warning: "undecidedButKnown",
              dismissedAt: fact.updatedAt,
              note: "Intentional",
            },
          ],
        },
      ],
    );
    const before = await f.store.db.transaction((q) =>
      captureBook(q, f.book.id),
    );
    result = await (await req(path)).json();
    assert.equal(result.intentionalCount, 1);
    assert.equal(result.warnings.length, 1);
    assert.deepEqual(
      (await f.store.db.transaction((q) => captureBook(q, f.book.id))).tables,
      before.tables,
    );
    assert.equal(
      (await continuityCatalog(f.store.db, other.id)).warnings.some(
        (w) => w.subject.id === fact.id,
      ),
      false,
      "shared dismissed warning suppressed in both books",
    );
    const event = await saveEvent(f.store.db, f.book.id, {
      title: "Discovery",
      scopeKind: "universe",
      sceneIds: [f.scene.id],
    });
    let entry = await f.store.createEntry(f.book.id, {
      name: "Keeper",
      entryType: "character",
      scopeKind: "universe",
    });
    const templates = await f.store.templates(f.library.id),
      template = templates.templates.find((t) => t.entryType === "character")!,
      field = templates.fields.find(
        (x) => x.templateId === template.id && x.fieldType === "integer",
      )!;
    entry = await f.store.editEntryField(f.book.id, entry.id, {
      templateId: template.id,
      expectedUpdatedAt: entry.updatedAt,
      expectedTemplateUpdatedAt: template.updatedAt,
      editSharedCanon: true,
    });
    const args = {
      entryId: entry.id,
      fieldId: field.id,
      eventId: event.id,
      expectedEntryUpdatedAt: entry.updatedAt,
      expectedFieldUpdatedAt: field.updatedAt,
      editSharedCanon: true,
    };
    await saveStateChange(f.store.db, f.book.id, { ...args, value: 1 });
    await saveStateChange(f.store.db, f.book.id, { ...args, value: 2 });
    result = await (await req(path)).json();
    assert.ok(
      result.warnings.some(
        (w: any) => w.key === "stateConflict:" + entry.id + ":" + field.id,
      ),
    );
    await f.store.trashNode(f.chapter.id);
    result = await (await req(path)).json();
    assert.ok(!result.warnings.some((w: any) => w.subject.id === question.id));
    await f.store.trashBook(f.book.id);
    assert.equal((await req(path)).status, 400);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.pg.close();
  }
});
test("one bounded MVCC snapshot covers every dependency, fails explicitly on oversized sources and remains read-only", async () => {
  const f = await fixture();
  try {
    let reads = 0;
    const names = [
      "books",
      "bible_entries",
      "bible_fields",
      "facts",
      "questions",
      "continuity_events",
      "state_changes",
      "nodes",
      "documents",
    ];
    for (const name of names) {
      const db: Database = {
        ...f.store.db,
        transaction: (fn) =>
          f.store.db.transaction((q) =>
            fn(async (sql, p) => {
              const result = await q(sql, p);
              if (sql.startsWith("SELECT (SELECT")) {
                reads++;
                assert.ok(names.every((n) => sql.includes(" AS " + n)));
                return {
                  rows: [{ ...result.rows[0], [name]: Array(10001).fill({}) }],
                };
              }
              return result;
            }),
          ),
      };
      await assert.rejects(
        () => continuityCatalog(db, f.book.id),
        /No records were omitted/,
      );
    }
    assert.equal(reads, names.length);
  } finally {
    await f.pg.close();
  }
});
test("100k-word question check stays advisory and preserves documents and saved revisions", async () => {
  const f = await fixture();
  try {
    const original = await f.store.document(f.scene.id);
    await f.store.save(
      f.scene.id,
      {
        ...original.document,
        blocks: [
          {
            id: crypto.randomUUID(),
            type: "paragraph",
            content: [{ type: "text", text: "orchard ".repeat(100000) }],
          },
        ],
      },
      original.revision,
    );
    await saveQuestion(f.store.db, f.book.id, {
      text: "Overdue?",
      nodeId: f.chapter.id,
    });
    const before = await f.store.db.transaction((q) =>
      captureBook(q, f.book.id),
    );
    const result = await continuityCatalog(f.store.db, f.book.id);
    assert.equal(result.warnings[0].kind, "questionOverdue");
    assert.deepEqual(
      (await f.store.db.transaction((q) => captureBook(q, f.book.id))).tables,
      before.tables,
    );
  } finally {
    await f.pg.close();
  }
});
