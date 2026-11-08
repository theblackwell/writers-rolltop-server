// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support.ts";
import { studioServer } from "../src/http.ts";
import { passwordHash } from "../src/auth.ts";
import { saveFact } from "../src/facts.ts";
import { saveQuestion } from "../src/questions.ts";
import { saveEvent } from "../src/events.ts";
import { editWorld, bookMembership } from "../src/worlds.ts";
import { saveRecordOverride } from "../src/record-overrides-write.ts";
import { exportPortable } from "../src/portable.ts";
import { readArchive } from "../src/archive-validation.ts";

const bookRow = async (f: any, id: string) =>
  (await f.store.db.query("SELECT data FROM books WHERE id=$1", [id])).rows[0]
    .data;
const row = async (f: any, table: string, id: string) =>
  (await f.store.db.query(`SELECT data FROM ${table} WHERE id=$1`, [id]))
    .rows[0].data;

async function setup() {
  const f = await fixture();
  const world = await editWorld(f.store.db, f.library.id, "universes", {
    title: "World",
  });
  await bookMembership(f.store.db, f.book.id, {
    universeId: world.id,
    expectedUpdatedAt: (await bookRow(f, f.book.id)).updatedAt,
  });
  const second = await f.store.createBook(f.library.id, "Second");
  await bookMembership(f.store.db, second.id, {
    universeId: world.id,
    expectedUpdatedAt: second.updatedAt,
  });
  const outsider = await f.store.createBook(f.library.id, "Outsider");
  const hero = await f.store.createEntry(f.book.id, {
    name: "Hero",
    entryType: "character",
  });
  const sharedHero = await f.store.createEntry(second.id, {
    name: "Elsewhere",
    entryType: "character",
  });
  const fact = await saveFact(f.store.db, f.book.id, {
    text: "The lamp is lit",
    truth: "true",
    scopeKind: "universe",
  });
  const question = await saveQuestion(f.store.db, f.book.id, {
    text: "Who lit it?",
    topic: "plot",
    status: "open",
    scopeKind: "universe",
  });
  const event = await saveEvent(f.store.db, f.book.id, {
    title: "Lighting",
    summary: "Canon summary",
    when: { label: "Dusk", ordinal: 3 },
    sceneIds: [],
    participants: [],
    scopeKind: "universe",
  });
  return {
    f,
    world,
    second,
    outsider,
    hero,
    sharedHero,
    fact,
    question,
    event,
  };
}
const put = (f: any, kind: any, book: string, id: string, body: any) =>
  saveRecordOverride(f.store.db, kind, book, id, body);

test("override writes succeed for facts, questions and events and touch only that book's entry", async () => {
  const { f, second, hero, fact, question, event } = await setup();
  try {
    const canon = { ...fact };
    const a = await put(f, "facts", f.book.id, fact.id, {
      truth: "false",
      text: "The lamp is dark",
      expectedUpdatedAt: fact.updatedAt,
    });
    assert.deepEqual(a.overrides, [
      { bookId: f.book.id, truth: "false", text: "The lamp is dark" },
    ]);
    assert.ok(a.updatedAt > fact.updatedAt);
    const { overrides: _o, updatedAt: _u, ...restA } = a;
    const { updatedAt: _cu, ...restCanon } = canon;
    assert.deepEqual(restA, restCanon, "canon fields untouched");
    // second book: separate entry; first untouched; later keys merge in place
    const b = await put(f, "facts", second.id, fact.id, {
      truth: "undecided",
      expectedUpdatedAt: a.updatedAt,
    });
    assert.equal(b.overrides.length, 2);
    const c = await put(f, "facts", f.book.id, fact.id, {
      truth: "true",
      expectedUpdatedAt: b.updatedAt,
    });
    assert.deepEqual(c.overrides[0], {
      bookId: f.book.id,
      truth: "true",
      text: "The lamp is dark",
    });
    assert.deepEqual(c.overrides[1], { bookId: second.id, truth: "undecided" });

    const q = await put(f, "questions", f.book.id, question.id, {
      status: "decided",
      decision: "",
      text: "Who lit the lamp?",
      expectedUpdatedAt: question.updatedAt,
    });
    assert.deepEqual(q.overrides[0], {
      bookId: f.book.id,
      status: "decided",
      decision: "",
      text: "Who lit the lamp?",
    });
    assert.equal(q.topic, "plot");

    const e = await put(f, "events", f.book.id, event.id, {
      title: "Lamp lit",
      summary: "",
      when: { label: "Dawn", calendar: "Old", ordinal: 1 },
      participants: [{ entryId: hero.id, role: "lighter" }],
      expectedUpdatedAt: event.updatedAt,
    });
    assert.equal(e.overrides[0].summary, "");
    assert.equal(e.title, "Lighting");
    assert.deepEqual(e.when, event.when);
    assert.deepEqual(e.participants, []);
  } finally {
    await f.pg.close();
  }
});

test("override writes refuse unknown or invalid values and the wrong targets", async () => {
  const {
    f,
    second,
    outsider,
    hero,
    sharedHero,
    world,
    fact,
    question,
    event,
  } = await setup();
  try {
    const bad = (kind: any, book: string, rec: any, body: any, status = 400) =>
      assert.rejects(
        () =>
          put(f, kind, book, rec.id, {
            expectedUpdatedAt: rec.updatedAt,
            ...body,
          }),
        { status },
      );
    await bad("facts", f.book.id, fact, { topic: "x" });
    await bad("facts", f.book.id, fact, { scope: { kind: "book" } });
    await bad("facts", f.book.id, fact, { entryIds: [] });
    await bad("facts", f.book.id, fact, { truth: "maybe" });
    await bad("facts", f.book.id, fact, { text: "" });
    await bad("facts", f.book.id, fact, { text: "x".repeat(20001) });
    await bad("facts", f.book.id, fact, { text: null });
    await bad("facts", f.book.id, fact, {});
    await bad("facts", f.book.id, fact, { clear: ["knowledge"] });
    await bad("facts", f.book.id, fact, { truth: "true", clear: ["truth"] });
    await bad("questions", f.book.id, question, { topic: "plot" });
    await bad("questions", f.book.id, question, { status: "closed" });
    await bad("questions", f.book.id, question, {
      decision: "x".repeat(20001),
    });
    await bad("questions", f.book.id, question, { decision: null });
    await bad("events", f.book.id, event, { title: "" });
    await bad("events", f.book.id, event, { summary: 3 });
    await bad("events", f.book.id, event, { when: { label: "" } });
    await bad("events", f.book.id, event, {
      when: { label: "x", ordinal: 1.5 },
    });
    await bad("events", f.book.id, event, { when: null });
    await bad("events", f.book.id, event, { sceneIds: [] });
    await bad("events", f.book.id, event, { participants: [] });
    await bad("events", f.book.id, event, {
      participants: [{ entryId: hero.id }, { entryId: hero.id }],
    });
    await bad("events", f.book.id, event, {
      participants: [{ entryId: hero.id, extra: 1 }],
    });
    await bad("events", f.book.id, event, {
      participants: [{ entryId: crypto.randomUUID() }],
    });
    // entry in a book outside this book's visible scope
    await bad("events", f.book.id, event, {
      participants: [{ entryId: sharedHero.id }],
    });
    // trashed entry
    await f.pg.query(
      "UPDATE bible_entries SET data=jsonb_set(data,'{deletedAt}',to_jsonb(now()::text)) WHERE id=$1",
      [hero.id],
    );
    await bad("events", f.book.id, event, {
      participants: [{ entryId: hero.id }],
    });

    // book-scoped record: no overrides
    const local = await saveFact(f.store.db, f.book.id, { text: "Local" });
    await bad("facts", f.book.id, local, { truth: "false" });
    // book outside the record's scope, missing book
    await bad("facts", outsider.id, fact, { truth: "false" }, 404);
    await bad("facts", crypto.randomUUID(), fact, { truth: "false" }, 404);
    await bad(
      "facts",
      f.book.id,
      { id: crypto.randomUUID(), updatedAt: "x" },
      { truth: "false" },
      404,
    );
    // trashed book
    await f.pg.query(
      "UPDATE books SET data=jsonb_set(data,'{deletedAt}',to_jsonb(now()::text)) WHERE id=$1",
      [second.id],
    );
    await bad("facts", second.id, fact, { truth: "false" });
    // trashed record
    const trashed = await saveFact(
      f.store.db,
      f.book.id,
      {
        deleted: true,
        expectedUpdatedAt: fact.updatedAt,
        editSharedCanon: true,
      },
      fact.id,
    );
    await assert.rejects(
      () =>
        put(f, "facts", f.book.id, fact.id, {
          truth: "false",
          expectedUpdatedAt: trashed.updatedAt,
        }),
      /Restore this fact/,
    );
    assert.equal(world.id, (await row(f, "facts", fact.id)).scope.id);
  } finally {
    await f.pg.close();
  }
});

test("stale override writes conflict and change nothing", async () => {
  const { f, fact, question, event } = await setup();
  try {
    for (const [kind, rec, body, code] of [
      ["facts", fact, { truth: "false" }, "FACT_CONFLICT"],
      ["questions", question, { status: "decided" }, "QUESTION_CONFLICT"],
      ["events", event, { title: "New" }, "EVENT_CONFLICT"],
    ] as const) {
      await assert.rejects(
        () =>
          put(f, kind, f.book.id, rec.id, {
            ...body,
            expectedUpdatedAt: "2000-01-01T00:00:00.000Z",
          }),
        (e: any) =>
          e.status === 409 &&
          e.code === code &&
          /Keep your draft/.test(e.message),
      );
      await assert.rejects(() => put(f, kind, f.book.id, rec.id, body), {
        status: 409,
      });
    }
    assert.deepEqual(await row(f, "facts", fact.id), fact);
    // after a successful write the old stamp is stale
    await put(f, "facts", f.book.id, fact.id, {
      truth: "false",
      expectedUpdatedAt: fact.updatedAt,
    });
    await assert.rejects(
      () =>
        put(f, "facts", f.book.id, fact.id, {
          truth: "true",
          expectedUpdatedAt: fact.updatedAt,
        }),
      { status: 409 },
    );
  } finally {
    await f.pg.close();
  }
});

test("clearing keys removes the book's override and then the overrides key; other books and dismissals stay", async () => {
  const { f, second, fact, event } = await setup();
  try {
    await f.pg.query("UPDATE facts SET data=data || $2::jsonb WHERE id=$1", [
      fact.id,
      {
        dismissedWarnings: [
          { warning: "undecidedButKnown", at: "2026-01-01T00:00:00.000Z" },
        ],
      },
    ]);
    const cur = await row(f, "facts", fact.id);
    assert.equal(cur.dismissedWarnings.length, 1);
    const a = await put(f, "facts", f.book.id, fact.id, {
      truth: "false",
      text: "Dark",
      expectedUpdatedAt: cur.updatedAt,
    });
    const b = await put(f, "facts", second.id, fact.id, {
      truth: "undecided",
      expectedUpdatedAt: a.updatedAt,
    });
    const c = await put(f, "facts", f.book.id, fact.id, {
      clear: ["truth"],
      expectedUpdatedAt: b.updatedAt,
    });
    assert.deepEqual(c.overrides, [
      { bookId: f.book.id, text: "Dark" },
      { bookId: second.id, truth: "undecided" },
    ]);
    const d = await put(f, "facts", f.book.id, fact.id, {
      clear: ["text", "truth"],
      expectedUpdatedAt: c.updatedAt,
    });
    assert.deepEqual(d.overrides, [{ bookId: second.id, truth: "undecided" }]);
    const e = await put(f, "facts", second.id, fact.id, {
      clear: ["truth"],
      expectedUpdatedAt: d.updatedAt,
    });
    assert.equal(Object.hasOwn(e, "overrides"), false);
    assert.equal(
      Object.hasOwn(await row(f, "facts", fact.id), "overrides"),
      false,
    );
    assert.equal(e.text, cur.text);
    assert.deepEqual(e.dismissedWarnings, cur.dismissedWarnings);
    // set and clear different keys in one request; clearing an absent key is harmless
    const g = await put(f, "events", f.book.id, event.id, {
      title: "T",
      expectedUpdatedAt: event.updatedAt,
    });
    const h = await put(f, "events", f.book.id, event.id, {
      summary: "",
      clear: ["title", "when"],
      expectedUpdatedAt: g.updatedAt,
    });
    assert.deepEqual(h.overrides, [{ bookId: f.book.id, summary: "" }]);
  } finally {
    await f.pg.close();
  }
});

test("records stay valid in an exported archive after override writes", async () => {
  const { f, second, hero, fact, question, event } = await setup();
  try {
    let fa = await put(f, "facts", f.book.id, fact.id, {
      truth: "false",
      expectedUpdatedAt: fact.updatedAt,
    });
    fa = await put(f, "facts", second.id, fact.id, {
      text: "Other",
      expectedUpdatedAt: fa.updatedAt,
    });
    await put(f, "questions", second.id, question.id, {
      decision: "",
      status: "decided",
      expectedUpdatedAt: question.updatedAt,
    });
    const ev = await put(f, "events", f.book.id, event.id, {
      title: "Lamp lit",
      summary: "",
      when: { label: "Dawn", ordinal: 1 },
      participants: [{ entryId: hero.id, role: "lighter" }],
      expectedUpdatedAt: event.updatedAt,
    });
    const s = readArchive(await exportPortable(f.store, f.library.id));
    assert.deepEqual(
      s.facts.find((x: any) => x.id === fact.id).overrides,
      fa.overrides,
    );
    assert.deepEqual(
      s.events.find((x: any) => x.id === event.id).overrides,
      ev.overrides,
    );
    assert.equal(
      s.questions.find((x: any) => x.id === question.id).overrides[0].decision,
      "",
    );
    // clearing everything keeps the archive valid, with no empty array
    await put(f, "facts", f.book.id, fact.id, {
      clear: ["truth"],
      expectedUpdatedAt: fa.updatedAt,
    }).then((r) =>
      put(f, "facts", second.id, fact.id, {
        clear: ["text"],
        expectedUpdatedAt: r.updatedAt,
      }),
    );
    const t = readArchive(await exportPortable(f.store, f.library.id));
    assert.equal(
      Object.hasOwn(
        t.facts.find((x: any) => x.id === fact.id),
        "overrides",
      ),
      false,
    );
  } finally {
    await f.pg.close();
  }
});

test("PUT /books/:id/{facts,questions,events}/:id/override is authenticated and maps errors", async () => {
  const { f, fact } = await setup();
  const origin = "http://localhost:4317",
    server = studioServer(f.store, {
      origin,
      passwordHash: await passwordHash("scratch-override-pw"),
    });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  let cookie = "";
  const req = (path: string, method: string, value?: any) =>
    fetch(base + path, {
      method,
      headers: {
        Cookie: cookie,
        Origin: origin,
        "Content-Type": "application/json",
      },
      ...(value !== undefined ? { body: JSON.stringify(value) } : {}),
    });
  try {
    const path = `/books/${f.book.id}/facts/${fact.id}/override`;
    assert.equal((await req(path, "PUT", {})).status, 401);
    const login = await req("/login", "POST", {
      password: "scratch-override-pw",
    });
    cookie = login.headers.get("set-cookie")!.split(";")[0];
    assert.equal(
      (await req(`/books/${f.book.id}/facts/bad/override`, "PUT", {})).status,
      400,
    );
    assert.equal((await req(path, "PUT", { truth: "false" })).status, 409);
    const ok = await req(path, "PUT", {
      truth: "false",
      expectedUpdatedAt: fact.updatedAt,
    });
    assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json()).overrides, [
      { bookId: f.book.id, truth: "false" },
    ]);
    assert.equal(
      (
        await req(path, "PUT", {
          truth: "false",
          expectedUpdatedAt: fact.updatedAt,
        })
      ).status,
      409,
    );
    assert.equal((await req(path, "POST", {})).status, 404);
  } finally {
    await new Promise((r) => server.close(r));
    await f.pg.close();
  }
});

test("clearing a key that has no override changes nothing and keeps updatedAt", async () => {
  const s = await setup();
  try {
    const before = await row(s.f, "facts", s.fact.id);
    const result = await saveRecordOverride(
      s.f.store.db,
      "facts",
      s.f.book.id,
      s.fact.id,
      { clear: ["truth"], expectedUpdatedAt: before.updatedAt },
    );
    assert.deepEqual(result, before);
    assert.deepEqual(await row(s.f, "facts", s.fact.id), before);
    assert.equal(Object.hasOwn(before, "overrides"), false);
  } finally {
    await s.f.pg.close();
  }
});
