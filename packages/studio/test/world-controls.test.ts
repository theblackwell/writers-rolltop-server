// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture } from "./support.ts";
import { editWorld, worlds, bookMembership } from "../src/worlds.ts";
import { studioServer } from "../src/http.ts";
import { passwordHash } from "../src/auth.ts";
import {
  readBookBackup,
  restoreBookBackup,
  backupTables,
} from "../src/backup.ts";

test("world controls preserve opaque data, isolate libraries and use CAS for rename/Trash/restore", async () => {
  const f = await fixture();
  try {
    const w = await editWorld(f.store.db, f.library.id, "universes", {
      title: "  World  ",
    });
    assert.equal(w.title, "World");
    await f.store.db.query(
      "UPDATE universes SET data=data || $2::jsonb WHERE id=$1",
      [w.id, { future: { keep: true } }],
    );
    const renamed = await editWorld(
      f.store.db,
      f.library.id,
      "universes",
      { title: "Renamed", expectedUpdatedAt: w.updatedAt },
      w.id,
    );
    assert.deepEqual(renamed.future, { keep: true });
    assert.equal(renamed.createdAt, w.createdAt);
    await assert.rejects(
      () =>
        editWorld(
          f.store.db,
          f.library.id,
          "universes",
          { title: "Stale", expectedUpdatedAt: w.updatedAt },
          w.id,
        ),
      /changed/,
    );
    const other = await f.store.createLibrary("Other");
    await assert.rejects(
      () =>
        editWorld(
          f.store.db,
          other.id,
          "universes",
          { title: "Wrong", expectedUpdatedAt: renamed.updatedAt },
          w.id,
        ),
      /no longer/,
    );
    await assert.rejects(
      () =>
        editWorld(f.store.db, other.id, "series", {
          title: "Wrong",
          universeId: w.id,
        }),
      /live world/,
    );
    await assert.rejects(
      () =>
        editWorld(f.store.db, f.library.id, "series", {
          title: "Wrong",
          universeId: "",
        }),
      /live world/,
    );
    const trashed = await editWorld(
      f.store.db,
      f.library.id,
      "universes",
      { deleted: true, expectedUpdatedAt: renamed.updatedAt },
      w.id,
    );
    assert.ok(trashed.deletedAt);
    await assert.rejects(
      () =>
        editWorld(f.store.db, f.library.id, "series", {
          title: "Wrong",
          universeId: w.id,
        }),
      /live world/,
    );
    const restored = await editWorld(
      f.store.db,
      f.library.id,
      "universes",
      { deleted: false, expectedUpdatedAt: trashed.updatedAt },
      w.id,
    );
    assert.equal(restored.deletedAt, undefined);
    assert.deepEqual((await worlds(f.store.db, f.library.id)).universes, [
      restored,
    ]);
    await assert.rejects(
      () =>
        editWorld(
          f.store.db,
          f.library.id,
          "universes",
          { title: " ", expectedUpdatedAt: restored.updatedAt },
          w.id,
        ),
      /title/,
    );
    await assert.rejects(
      () =>
        editWorld(
          f.store.db,
          f.library.id,
          "universes",
          { deleted: "yes", expectedUpdatedAt: restored.updatedAt },
          w.id,
        ),
      /Trash/,
    );
  } finally {
    await f.pg.close();
  }
});

test("book memberships match native clearing, validate live ownership, preserve content and reject stale drafts", async () => {
  const f = await fixture();
  try {
    const w = await editWorld(f.store.db, f.library.id, "universes", {
      title: "World",
    });
    const w2 = await editWorld(f.store.db, f.library.id, "universes", {
      title: "Other world",
    });
    const s = await editWorld(f.store.db, f.library.id, "series", {
      title: "Series",
      universeId: w.id,
    });
    const independent = await editWorld(f.store.db, f.library.id, "series", {
      title: "Independent",
    });
    const entry = await f.store.createEntry(f.book.id, {
      name: "Keeper",
      entryType: "character",
    });
    const doc = await f.store.document(f.scene.id);
    await f.store.db.query(
      "UPDATE books SET data=data || $2::jsonb WHERE id=$1",
      [f.book.id, { future: { keep: true } }],
    );
    let b = await bookMembership(f.store.db, f.book.id, {
      universeId: w.id,
      seriesId: s.id,
      expectedUpdatedAt: f.book.updatedAt,
    });
    assert.equal(b.seriesId, s.id);
    assert.deepEqual(b.future, { keep: true });
    await assert.rejects(
      () =>
        bookMembership(f.store.db, f.book.id, {
          universeId: null,
          expectedUpdatedAt: f.book.updatedAt,
        }),
      /changed/,
    );
    await assert.rejects(
      () =>
        bookMembership(f.store.db, f.book.id, {
          universeId: w2.id,
          seriesId: s.id,
          expectedUpdatedAt: b.updatedAt,
        }),
      /world first/,
    );
    b = await bookMembership(f.store.db, f.book.id, {
      universeId: w2.id,
      expectedUpdatedAt: b.updatedAt,
    });
    assert.equal(b.seriesId, undefined);
    b = await bookMembership(f.store.db, f.book.id, {
      universeId: null,
      seriesId: independent.id,
      expectedUpdatedAt: b.updatedAt,
    });
    assert.equal(b.universeId, undefined);
    assert.equal(b.seriesId, independent.id);
    const foreign = await f.store.createLibrary("Foreign");
    const fw = await editWorld(f.store.db, foreign.id, "universes", {
      title: "Foreign",
    });
    await assert.rejects(
      () =>
        bookMembership(f.store.db, f.book.id, {
          universeId: fw.id,
          expectedUpdatedAt: b.updatedAt,
        }),
      /live world/,
    );
    await assert.rejects(
      () =>
        bookMembership(f.store.db, f.book.id, {
          seriesId: "bad",
          expectedUpdatedAt: b.updatedAt,
        }),
      /live series/,
    );
    await assert.rejects(
      () =>
        bookMembership(f.store.db, f.book.id, {
          seriesId: "",
          expectedUpdatedAt: b.updatedAt,
        }),
      /Choose/,
    );
    await assert.rejects(
      () =>
        bookMembership(f.store.db, f.book.id, {
          universeId: null,
          values: {},
          expectedUpdatedAt: b.updatedAt,
        }),
      /supported/,
    );
    assert.deepEqual(await f.store.entries(f.book.id), [entry]);
    assert.deepEqual(await f.store.document(f.scene.id), doc);
    await f.store.trashBook(f.book.id);
    const dead = (await f.store.book(f.book.id)).book;
    await assert.rejects(
      () =>
        bookMembership(f.store.db, f.book.id, {
          seriesId: null,
          expectedUpdatedAt: dead.updatedAt,
        }),
      /Restore/,
    );
  } finally {
    await f.pg.close();
  }
});

test("world/series Trash refuses members including Trash and scoped entries; leaving preserves overrides", async () => {
  const f = await fixture();
  try {
    const w = await editWorld(f.store.db, f.library.id, "universes", {
      title: "World",
    });
    let s = await editWorld(f.store.db, f.library.id, "series", {
      title: "Series",
      universeId: w.id,
    });
    let b = await bookMembership(f.store.db, f.book.id, {
      universeId: w.id,
      seriesId: s.id,
      expectedUpdatedAt: f.book.updatedAt,
    });
    await assert.rejects(
      () =>
        editWorld(
          f.store.db,
          f.library.id,
          "universes",
          { deleted: true, expectedUpdatedAt: w.updatedAt },
          w.id,
        ),
      /still has/,
    );
    await f.store.trashBook(f.book.id);
    await assert.rejects(
      () =>
        editWorld(
          f.store.db,
          f.library.id,
          "series",
          { deleted: true, expectedUpdatedAt: s.updatedAt },
          s.id,
        ),
      /still has/,
    );
    await f.store.restoreBook(f.book.id);
    b = (await f.store.book(f.book.id)).book;
    const e = await f.store.createEntry(f.book.id, {
      name: "Opaque scoped record",
      entryType: "term",
    });
    await f.store.db.query(
      "UPDATE bible_entries SET data=data || $2::jsonb WHERE id=$1",
      [
        e.id,
        {
          scope: { kind: "universe", id: w.id },
          overrides: [{ bookId: f.book.id, values: { unknown: "kept" } }],
        },
      ],
    );
    await assert.rejects(
      () =>
        bookMembership(f.store.db, f.book.id, {
          universeId: null,
          expectedUpdatedAt: b.updatedAt,
        }),
      /Clear this book/,
    );
    assert.equal((await f.store.book(f.book.id)).book.universeId, w.id);
    await f.store.db.query(
      "UPDATE bible_entries SET data=data || $2::jsonb WHERE id=$1",
      [e.id, { overrides: [] }],
    );
    b = await bookMembership(f.store.db, f.book.id, {
      universeId: null,
      expectedUpdatedAt: b.updatedAt,
    });
    s = await editWorld(
      f.store.db,
      f.library.id,
      "series",
      { deleted: true, expectedUpdatedAt: s.updatedAt },
      s.id,
    );
    await assert.rejects(
      () =>
        editWorld(
          f.store.db,
          f.library.id,
          "universes",
          { deleted: true, expectedUpdatedAt: w.updatedAt },
          w.id,
        ),
      /still has/,
    );
    // Trashed child series may stay attached; restore requires a live parent.
    await f.store.db.query(
      "UPDATE bible_entries SET data=data || $2::jsonb WHERE id=$1",
      [e.id, { scope: { kind: "book", id: f.book.id } }],
    );
    const deadWorld = await editWorld(
      f.store.db,
      f.library.id,
      "universes",
      { deleted: true, expectedUpdatedAt: w.updatedAt },
      w.id,
    );
    await assert.rejects(
      () =>
        editWorld(
          f.store.db,
          f.library.id,
          "series",
          { deleted: false, expectedUpdatedAt: s.updatedAt },
          s.id,
        ),
      /parent world/,
    );
    await editWorld(
      f.store.db,
      f.library.id,
      "universes",
      { deleted: false, expectedUpdatedAt: deadWorld.updatedAt },
      w.id,
    );
    const restoredSeries = await editWorld(
      f.store.db,
      f.library.id,
      "series",
      { deleted: false, expectedUpdatedAt: s.updatedAt },
      s.id,
    );
    assert.equal(restoredSeries.deletedAt, undefined);
  } finally {
    await f.pg.close();
  }
});

test("book purge retains library worlds/series and recovers memberships and tombstones", async () => {
  const f = await fixture(),
    target = await fixture();
  const dir = await mkdtemp(join(tmpdir(), "rolltop-world-purge-"));
  try {
    f.store.backupDirectory = dir;
    const w = await editWorld(f.store.db, f.library.id, "universes", {
      title: "World",
    });
    const unused = await editWorld(f.store.db, f.library.id, "universes", {
      title: "Trashed world",
    });
    const dead = await editWorld(
      f.store.db,
      f.library.id,
      "universes",
      { deleted: true, expectedUpdatedAt: unused.updatedAt },
      unused.id,
    );
    const s = await editWorld(f.store.db, f.library.id, "series", {
      title: "Series",
      universeId: w.id,
    });
    await bookMembership(f.store.db, f.book.id, {
      universeId: w.id,
      seriesId: s.id,
      expectedUpdatedAt: f.book.updatedAt,
    });
    await f.store.trashBook(f.book.id);
    const b = (await f.store.book(f.book.id)).book;
    const receipt = await f.store.purge("book", b.id, {
      confirmTitle: b.title,
      expectedDeletedAt: b.deletedAt,
    });
    assert.equal((await worlds(f.store.db, f.library.id)).universes.length, 2);
    const backup = await readBookBackup(join(dir, receipt.backup));
    await target.store.db.transaction(async (q) => {
      for (const t of [...backupTables].reverse()) await q(`DELETE FROM ${t}`);
      await restoreBookBackup(q, backup);
    });
    assert.deepEqual((await target.store.book(b.id)).book, b);
    assert.deepEqual(
      (await worlds(target.store.db, f.library.id)).universes.find(
        (u) => u.id === dead.id,
      ),
      dead,
    );
  } finally {
    await f.pg.close();
    await target.pg.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("world HTTP routes enforce authentication, origin, identifiers, input and CAS", async () => {
  const f = await fixture(),
    origin = "http://localhost:4317",
    password = "scratch-world-password";
  const server = studioServer(f.store, {
    origin,
    passwordHash: await passwordHash(password),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  let cookie = "";
  const req = (path: string, value?: any, method = "POST", o = origin) =>
    fetch(base + path, {
      method,
      headers: {
        Cookie: cookie,
        Origin: o,
        "Content-Type": "application/json",
      },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
  try {
    const path = `/libraries/${f.library.id}/universes`;
    assert.equal((await req(path, { title: "World" })).status, 401);
    cookie = (await req("/login", { password })).headers
      .get("set-cookie")!
      .split(";")[0];
    assert.equal(
      (await req(path, { title: "World" }, "POST", "https://evil.example"))
        .status,
      403,
    );
    assert.equal((await req(path + "/bad", {}, "PUT")).status, 400);
    const result = await req(path, { title: "World" });
    assert.equal(result.status, 201);
    const w = await result.json();
    assert.equal(
      (await req(`/libraries/${f.library.id}/worlds`, undefined, "GET")).status,
      200,
    );
    assert.equal(
      (
        await req(
          path + `/${w.id}`,
          { title: "Renamed", expectedUpdatedAt: w.updatedAt },
          "PUT",
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await req(
          path + `/${w.id}`,
          { title: "Stale", expectedUpdatedAt: w.updatedAt },
          "PUT",
        )
      ).status,
      409,
    );
    const membership = `/books/${f.book.id}/membership`;
    assert.equal(
      (
        await req(
          membership,
          { universeId: w.id, expectedUpdatedAt: f.book.updatedAt },
          "PUT",
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await req(
          membership,
          { universeId: null, expectedUpdatedAt: f.book.updatedAt },
          "PUT",
        )
      ).status,
      409,
    );
    assert.equal(
      (await req(path, { title: "World", deleted: true })).status,
      400,
    );
    assert.equal(
      (await req(`/libraries/${crypto.randomUUID()}/worlds`, undefined, "GET"))
        .status,
      404,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.pg.close();
  }
});
