// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support.ts";
import type { Database } from "../src/store.ts";
import { studioServer } from "../src/http.ts";
import { passwordHash } from "../src/auth.ts";
import { editWorld, bookMembership } from "../src/worlds.ts";
import { eventCatalog, saveEvent } from "../src/events.ts";
import { orderedEvents } from "../src/timeline-order.ts";
import { captureBook } from "../src/backup.ts";

test("timeline APIs enforce auth/origin/allowlists/scope and preserve date, role, CAS and Trash semantics", async () => {
  const f = await fixture(),
    origin = "http://localhost:4317";
  const server = studioServer(f.store, {
    origin,
    passwordHash: await passwordHash("scratch-events"),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + (server.address() as any).port + "/api";
  let cookie = "";
  const req = (path: string, method = "GET", value?: object, from = origin) =>
    fetch(base + path, {
      method,
      headers: {
        Cookie: cookie,
        Origin: from,
        "Content-Type": "application/json",
      },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
  try {
    const path = "/books/" + f.book.id + "/events";
    assert.equal((await req(path)).status, 401);
    const login = await req("/login", "POST", { password: "scratch-events" });
    cookie = login.headers.get("set-cookie")!.split(";")[0];
    assert.equal(
      (await req(path, "POST", { title: "No" }, "https://evil.example")).status,
      403,
    );
    assert.equal((await req("/books/no/events")).status, 400);
    assert.equal((await req(path + "/bad", "PUT", {})).status, 400);
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
    const person = await f.store.createEntry(other.id, {
      name: "Witness",
      entryType: "character",
    });
    const eventEntry = await f.store.createEntry(f.book.id, {
      name: "Storm",
      entryType: "event",
    });
    const local = await (await req(path, "POST", { title: "Local" })).json();
    const created = await req(path, "POST", {
      title: "Storm",
      scopeKind: "universe",
      summary: "",
      when: { label: "Third moon", calendar: "Old", ordinal: -3 },
      entryId: eventEntry.id,
      sceneIds: [f.scene.id],
      participants: [{ entryId: person.id, role: "" }],
    });
    assert.equal(created.status, 201);
    let e = await created.json();
    await f.store.db.query(
      "UPDATE continuity_events SET data=data || $2::jsonb WHERE id=$1",
      [
        e.id,
        {
          opaque: { keep: true },
          dismissedWarnings: [
            { warning: "stateConflict:abc:def", dismissedAt: e.updatedAt },
          ],
        },
      ],
    );
    const before = await f.store.db.transaction((q) =>
      captureBook(q, f.book.id),
    );
    const catalog = await (await req(path)).json();
    assert.equal(catalog.events.length, 2);
    assert.match(
      catalog.entries.find((x: any) => x.id === person.id).scopeTitle,
      /Companion/,
    );
    assert.ok(catalog.readingPositions[f.scene.id] !== undefined);
    assert.deepEqual(
      (await f.store.db.transaction((q) => captureBook(q, f.book.id))).tables,
      before.tables,
    );
    const otherPath = "/books/" + other.id + "/events";
    assert.deepEqual(
      (await (await req(otherPath)).json()).events.map((x: any) => x.id),
      [e.id],
    );
    assert.equal(
      (
        await req(otherPath + "/" + local.id, "PUT", {
          title: "Hidden",
          expectedUpdatedAt: local.updatedAt,
        })
      ).status,
      404,
    );
    const foreignLib = await f.store.createLibrary("Foreign"),
      foreign = await f.store.createBook(foreignLib.id, "Foreign");
    assert.equal(
      (
        await req("/books/" + foreign.id + "/events/" + e.id, "PUT", {
          title: "Steal",
          expectedUpdatedAt: e.updatedAt,
          editSharedCanon: true,
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await req(path + "/" + e.id, "PUT", {
          title: "No consent",
          expectedUpdatedAt: e.updatedAt,
        })
      ).status,
      400,
    );
    for (const patch of [
      { unknown: true },
      { scopeKind: "book" },
      { when: { label: "" } },
      { when: { label: "x", ordinal: 1.5 } },
      { entryId: person.id },
      { sceneIds: [f.chapter.id] },
      { sceneIds: [f.scene.id, f.scene.id] },
      { participants: [{ entryId: person.id }, { entryId: person.id }] },
      { participants: [{ entryId: foreign.id }] },
    ]) {
      assert.equal(
        (
          await req(path + "/" + e.id, "PUT", {
            expectedUpdatedAt: e.updatedAt,
            editSharedCanon: true,
            ...patch,
          })
        ).status,
        400,
      );
    }
    const results = await Promise.all(
      [path, otherPath].map((p, i) =>
        req(p + "/" + e.id, "PUT", {
          title: "Writer " + i,
          expectedUpdatedAt: e.updatedAt,
          editSharedCanon: true,
        }),
      ),
    );
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    e = await results.find((r) => r.status === 200)!.json();
    assert.deepEqual(e.opaque, { keep: true });
    assert.equal(e.dismissedWarnings.length, 1);
    assert.equal(e.when.ordinal, -3);
    assert.equal(e.participants[0].role, "");
    assert.equal(e.summary, "");
    e = await (
      await req(path + "/" + e.id, "PUT", {
        summary: null,
        when: null,
        entryId: null,
        expectedUpdatedAt: e.updatedAt,
        editSharedCanon: true,
      })
    ).json();
    assert.equal(e.summary, undefined);
    assert.equal(e.when, undefined);
    assert.equal(e.entryId, undefined);
    for (const deleted of [true, false]) {
      e = await (
        await req(path + "/" + e.id, "PUT", {
          deleted,
          expectedUpdatedAt: e.updatedAt,
          editSharedCanon: true,
        })
      ).json();
      assert.equal(!!e.deletedAt, deleted);
    }
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.pg.close();
  }
});

test("timeline catalog has native current-book reading positions, stable date ties, inherited Trash labels and independent bounds", async () => {
  const f = await fixture();
  try {
    const later = await f.store.createNode(
      f.book.id,
      "Later",
      "scene",
      f.chapter.id,
    );
    const first = await saveEvent(f.store.db, f.book.id, {
      title: "First in reading",
      when: { label: "Late", ordinal: 5 },
      sceneIds: [later.id, f.scene.id],
    });
    const second = await saveEvent(f.store.db, f.book.id, {
      title: "Later in reading",
      when: { label: "Early", ordinal: -5 },
      sceneIds: [later.id],
    });
    const undated = await saveEvent(f.store.db, f.book.id, {
      title: "Undated",
    });
    let c = await eventCatalog(f.store.db, f.book.id);
    assert.deepEqual(
      orderedEvents(c.events, c.readingPositions, false).map((e) => e.id),
      [second.id, first.id, undated.id],
    );
    assert.deepEqual(
      orderedEvents(c.events, c.readingPositions, true).map((e) => e.id),
      [first.id, second.id, undated.id],
    );
    const tied = [
      { ...first, id: "b", orderKey: "a" },
      { ...first, id: "a", orderKey: "a" },
      { ...first, id: "c", orderKey: "b" },
    ];
    assert.deepEqual(
      orderedEvents(tied, {}, false).map((e) => e.id),
      ["a", "b", "c"],
    );
    await f.store.trashNode(f.chapter.id);
    c = await eventCatalog(f.store.db, f.book.id);
    assert.equal(c.nodes.find((n) => n.id === f.scene.id)!.inTrash, true);
    assert.equal(c.readingPositions[f.scene.id], undefined);
    const foreign = await f.store.createLibrary("Foreign"),
      other = await f.store.createBook(foreign.id, "Foreign");
    await f.store.createEntry(other.id, {
      name: "Invisible",
      entryType: "term",
    });
    assert.equal(
      (await eventCatalog(f.store.db, f.book.id)).entries.some(
        (e) => e.name === "Invisible",
      ),
      false,
    );
    for (const source of [
      "books",
      "bible_entries",
      "continuity_events",
      "universes",
      "series",
      "manuscript_nodes",
    ]) {
      const db: Database = {
        ...f.store.db,
        transaction: (fn) =>
          f.store.db.transaction((q) =>
            fn(async (sql, p) => {
              assert.ok(
                !sql.startsWith("SELECT data FROM facts") &&
                  !sql.startsWith("SELECT data FROM questions"),
              );
              return (
                source === "manuscript_nodes"
                  ? sql.startsWith("SELECT n.data")
                  : sql.startsWith("SELECT data FROM " + source + " ")
              )
                ? { rows: Array(10001).fill({ data: {} }) }
                : q(sql, p);
            }),
          ),
      };
      await assert.rejects(
        () => eventCatalog(db, f.book.id),
        /No records were omitted/,
      );
    }
    await f.store.trashBook(f.book.id);
    await assert.rejects(
      () => eventCatalog(f.store.db, f.book.id),
      /Restore the book/,
    );
  } finally {
    await f.pg.close();
  }
});
