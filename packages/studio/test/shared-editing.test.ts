// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fixture } from "./support.ts";
import { editWorld, bookMembership } from "../src/worlds.ts";
import { editDefinition } from "../src/template-editor.ts";
import {
  backupTables,
  readBookBackup,
  restoreBookBackup,
} from "../src/backup.ts";
import { studioServer } from "../src/http.ts";
import { passwordHash } from "../src/auth.ts";
async function sharedFixture() {
  const f = await fixture();
  const world = await editWorld(f.store.db, f.library.id, "universes", {
    title: "World",
  });
  const series = await editWorld(f.store.db, f.library.id, "series", {
    title: "Series",
    universeId: world.id,
  });
  await bookMembership(f.store.db, f.book.id, {
    universeId: world.id,
    seriesId: series.id,
    expectedUpdatedAt: f.book.updatedAt,
  });
  const other = await f.store.createBook(f.library.id, "Second book");
  await bookMembership(f.store.db, other.id, {
    universeId: world.id,
    seriesId: series.id,
    expectedUpdatedAt: other.updatedAt,
  });
  const catalog = await f.store.templates(f.library.id),
    template = catalog.templates.find((t) => t.entryType === "character")!;
  const fields = catalog.fields.filter((x) => x.templateId === template.id);
  const create = (
    bookId = f.book.id,
    scopeKind = "universe",
    entryType = "character",
    name = "Shared character",
  ) => f.store.createEntry(bookId, { scopeKind, entryType, name });
  const current = async (id: string, bookId = f.book.id) =>
    (await f.store.entries(bookId)).find((e) => e.id === id)!;
  const assign = (e: any, bookId = f.book.id) =>
    f.store.editEntryField(bookId, e.id, {
      templateId: template.id,
      expectedUpdatedAt: e.updatedAt,
      expectedTemplateUpdatedAt: template.updatedAt,
      editSharedCanon: true,
    });
  const put = (
    e: any,
    field: any,
    value: any,
    mode = "canon",
    bookId = f.book.id,
  ) =>
    f.store.editEntryField(
      bookId,
      e.id,
      {
        value,
        mode,
        editSharedCanon: mode === "canon",
        expectedUpdatedAt: e.updatedAt,
        expectedFieldUpdatedAt: field.updatedAt,
      },
      field.id,
    );
  return {
    ...f,
    world,
    series,
    other,
    template,
    fields,
    create,
    current,
    assign,
    put,
  };
}

test("scope choice, explicit shared headers/templates, immutable scope and global entry CAS", async () => {
  const f = await sharedFixture();
  try {
    let e = await f.create();
    assert.deepEqual(e.scope, { kind: "universe", id: f.world.id });
    assert.equal((await f.current(e.id, f.other.id)).name, e.name);
    await assert.rejects(
      () =>
        f.store.updateEntry(f.book.id, e.id, {
          name: "Implicit",
          expectedUpdatedAt: e.updatedAt,
        }),
      /shared canon/,
    );
    await assert.rejects(
      () =>
        f.store.editEntryField(f.book.id, e.id, {
          templateId: f.template.id,
          expectedUpdatedAt: e.updatedAt,
          expectedTemplateUpdatedAt: f.template.updatedAt,
        }),
      /shared canon/,
    );
    await assert.rejects(
      () =>
        f.store.updateEntry(f.book.id, e.id, {
          scopeKind: "book",
          editSharedCanon: true,
          expectedUpdatedAt: e.updatedAt,
        }),
      /editable/,
    );
    const old = e;
    e = await f.store.updateEntry(f.other.id, e.id, {
      name: "Shared rename",
      summary: "Canon",
      expectedUpdatedAt: e.updatedAt,
      editSharedCanon: true,
    });
    assert.equal((await f.current(e.id)).name, "Shared rename");
    await assert.rejects(
      () =>
        f.store.updateEntry(f.book.id, e.id, {
          name: "Stale",
          expectedUpdatedAt: old.updatedAt,
          editSharedCanon: true,
        }),
      /changed/,
    );
    e = await f.assign(e);
    assert.equal(e.templateId, f.template.id);
    const serial = await f.create(f.book.id, "series");
    assert.equal(serial.scope.id, f.series.id);
    const standalone = await f.store.createBook(f.library.id, "Standalone");
    await assert.rejects(() => f.create(standalone.id), /Join/);
    await assert.rejects(
      () =>
        f.store.updateEntry(standalone.id, e.id, {
          name: "Hidden",
          expectedUpdatedAt: e.updatedAt,
          editSharedCanon: true,
        }),
      /no longer/,
    );
    const local = await f.create(f.book.id, "book");
    await assert.rejects(
      () =>
        f.put(
          local,
          f.fields.find((x) => x.key === "age"),
          0,
          "book",
        ),
      /only to shared/,
    );
    await assert.rejects(
      () =>
        f.store.createEntry(f.book.id, {
          scopeKind: "wrong",
          entryType: "term",
          name: "Invalid",
        }),
      /scope/,
    );
    const unchanged = await f.store.document(f.scene.id);
    assert.equal(unchanged.revision, 1);
    await f.store.db.query(
      "UPDATE universes SET data=data || $2::jsonb WHERE id=$1",
      [f.world.id, { deletedAt: new Date().toISOString() }],
    );
    await assert.rejects(() => f.create(), /live scope/);
    await assert.rejects(
      () =>
        f.store.updateEntry(f.book.id, e.id, {
          name: "Dead scope",
          expectedUpdatedAt: e.updatedAt,
          editSharedCanon: true,
        }),
      /Restore the shared scope/,
    );
  } finally {
    await f.pg.close();
  }
});

test("book overrides preserve canon, other books and opaque values; false/zero/empty and clearing inherit", async () => {
  const f = await sharedFixture();
  try {
    let e = await f.assign(await f.create());
    const age = f.fields.find((x) => x.key === "age")!,
      role = f.fields.find((x) => x.key === "role")!;
    const boolean = await editDefinition(f.store.db, f.library.id, "field", {
      templateId: f.template.id,
      label: "Active",
      fieldType: "boolean",
    });
    await f.store.db.query(
      "UPDATE bible_entries SET data=data || $2::jsonb WHERE id=$1",
      [
        e.id,
        {
          future: { keep: true },
          values: { opaque: { keep: true } },
          overrides: [
            {
              bookId: f.other.id,
              values: { opaque: "second" },
              future: "preserved",
            },
          ],
        },
      ],
    );
    e = await f.current(e.id);
    e = await f.put(e, age, 8);
    e = await f.put(e, role, "Canon");
    e = await f.put(e, boolean, true);
    const canon = structuredClone(e.values);
    e = await f.put(e, age, 0, "book");
    e = await f.put(e, role, "", "book");
    e = await f.put(e, boolean, false, "book");
    assert.deepEqual(e.values, canon);
    assert.deepEqual(e.future, { keep: true });
    assert.deepEqual(e.overrides[1].values, {
      [age.id]: 0,
      [role.id]: "",
      [boolean.id]: false,
    });
    assert.deepEqual(e.overrides[0], {
      bookId: f.other.id,
      values: { opaque: "second" },
      future: "preserved",
    });
    const stamp = e.updatedAt;
    e = await f.put(e, age, 12, "book", f.other.id);
    await assert.rejects(
      () => f.put({ ...e, updatedAt: stamp }, age, 2, "book"),
      /changed/,
    );
    e = await f.put(e, age, 9);
    assert.equal(e.overrides[1].values[age.id], 0);
    assert.equal(e.overrides[0].values[age.id], 12);
    await assert.rejects(
      () =>
        f.store.editEntryField(f.book.id, e.id, {
          templateId: null,
          expectedUpdatedAt: e.updatedAt,
          editSharedCanon: true,
        }),
      /saved values/,
    );
    e = await f.put(e, age, null, "book");
    e = await f.put(e, role, null, "book");
    e = await f.put(e, boolean, null, "book");
    assert.equal(
      e.overrides.some((o: any) => o.bookId === f.book.id),
      false,
    );
    assert.equal(e.values[age.id], 9);
    assert.equal(e.overrides[0].values[age.id], 12);
    const b = (await f.store.book(f.book.id)).book;
    await bookMembership(f.store.db, b.id, {
      universeId: null,
      seriesId: null,
      expectedUpdatedAt: b.updatedAt,
    });
  } finally {
    await f.pg.close();
  }
});

test("canonical links respect owner scope while book overrides may link to local visible targets", async () => {
  const f = await sharedFixture();
  try {
    let e = await f.assign(await f.create());
    const home = f.fields.find((x) => x.key === "home")!;
    const world = await f.create(
        f.book.id,
        "universe",
        "location",
        "World location",
      ),
      serial = await f.create(
        f.book.id,
        "series",
        "location",
        "Series location",
      ),
      local = await f.create(f.book.id, "book", "location", "Local location");
    e = await f.put(e, home, world.id);
    await assert.rejects(() => f.put(e, home, serial.id), /live entries/);
    await assert.rejects(() => f.put(e, home, local.id), /live entries/);
    e = await f.put(e, home, local.id, "book");
    assert.equal(e.values[home.id], world.id);
    assert.equal(e.overrides[0].values[home.id], local.id);
    const foreign = await f.create(
      f.other.id,
      "book",
      "location",
      "Other local",
    );
    await assert.rejects(
      () => f.put(e, home, foreign.id, "book"),
      /live entries/,
    );
    let seriesOwner = await f.assign(await f.create(f.book.id, "series"));
    seriesOwner = await f.put(seriesOwner, home, world.id);
    seriesOwner = await f.put(seriesOwner, home, serial.id);
    await assert.rejects(
      () => f.put(seriesOwner, home, local.id),
      /live entries/,
    );
    const multi = await editDefinition(f.store.db, f.library.id, "field", {
      templateId: f.template.id,
      label: "Places",
      fieldType: "entryReferences",
      targetEntryTypes: ["location"],
    });
    e = await f.put(e, multi, [world.id]);
    await assert.rejects(() => f.put(e, multi, [world.id, world.id]), /unique/);
    e = await f.put(e, multi, [serial.id, local.id], "book");
    await f.store.updateEntry(f.book.id, local.id, {
      deleted: true,
      expectedUpdatedAt: local.updatedAt,
    });
    await assert.rejects(
      () => f.put(e, home, local.id, "book"),
      /live entries/,
    );
    assert.equal(
      (await f.current(e.id)).overrides[0].values[home.id],
      local.id,
    );
    const independent = await editWorld(f.store.db, f.library.id, "series", {
      title: "No world",
    });
    const b = (await f.store.book(f.other.id)).book;
    await bookMembership(f.store.db, b.id, {
      seriesId: independent.id,
      expectedUpdatedAt: b.updatedAt,
    });
    let ind = await f.assign(await f.create(f.other.id, "series"), f.other.id);
    await assert.rejects(
      () => f.put(ind, home, world.id, "canon", f.other.id),
      /live entries/,
    );
  } finally {
    await f.pg.close();
  }
});

async function anchor(f: any, bookId: string) {
  const chapter = await f.store.createNode(bookId, "Passage", "chapter"),
    scene = await f.store.createNode(bookId, "Scene", "scene", chapter.id);
  const before = await f.store.document(scene.id),
    id = crypto.randomUUID();
  before.document.blocks[0].content = [
    { type: "text", text: "Shared passage", marks: [{ type: "anchor", id }] },
  ];
  const saved = await f.store.save(scene.id, before.document, before.revision);
  return { scene, id, revision: saved.revision };
}
test("shared passage links survive shared Trash/restore and leaving a world without losing anchors", async () => {
  const f = await sharedFixture();
  try {
    let e = await f.create();
    const a = await anchor(f, f.book.id),
      b = await anchor(f, f.other.id);
    const r = await f.store.saveReference(a.scene.id, {
      entryId: e.id,
      anchorId: a.id,
      expectedRevision: a.revision,
    });
    await f.store.saveReference(b.scene.id, {
      entryId: e.id,
      anchorId: b.id,
      expectedRevision: b.revision,
    });
    e = await f.store.updateEntry(f.other.id, e.id, {
      deleted: true,
      editSharedCanon: true,
      expectedUpdatedAt: e.updatedAt,
    });
    assert.equal((await f.store.references(a.scene.id)).length, 1);
    const c = await anchor(f, f.book.id);
    await assert.rejects(
      () =>
        f.store.saveReference(c.scene.id, {
          entryId: e.id,
          anchorId: c.id,
          expectedRevision: c.revision,
        }),
      /live/,
    );
    e = await f.store.updateEntry(f.book.id, e.id, {
      deleted: false,
      editSharedCanon: true,
      expectedUpdatedAt: e.updatedAt,
    });
    await f.store.saveReference(c.scene.id, {
      entryId: e.id,
      anchorId: c.id,
      expectedRevision: c.revision,
    });
    const book = (await f.store.book(f.book.id)).book;
    await bookMembership(f.store.db, book.id, {
      universeId: null,
      seriesId: null,
      expectedUpdatedAt: book.updatedAt,
    });
    assert.equal((await f.store.references(a.scene.id))[0].entryId, e.id);
    const trashed = await f.store.saveReference(
      a.scene.id,
      { deleted: true, expectedUpdatedAt: r.updatedAt },
      r.id,
    );
    await assert.rejects(
      () =>
        f.store.saveReference(
          a.scene.id,
          { deleted: false, expectedUpdatedAt: trashed.updatedAt },
          r.id,
        ),
      /visible scope/,
    );
    assert.equal((await f.store.document(a.scene.id)).revision, a.revision);
  } finally {
    await f.pg.close();
  }
});

test("leaving a world refuses saved local links and overrides until deliberately cleared", async () => {
  const f = await sharedFixture();
  try {
    const location = await f.create(
        f.book.id,
        "universe",
        "location",
        "World place",
      ),
      home = f.fields.find((x) => x.key === "home")!;
    let local = await f.assign(await f.create(f.book.id, "book"));
    local = await f.put(local, home, location.id);
    let book = (await f.store.book(f.book.id)).book;
    await assert.rejects(
      () =>
        bookMembership(f.store.db, book.id, {
          universeId: null,
          seriesId: null,
          expectedUpdatedAt: book.updatedAt,
        }),
      /saved entry links/,
    );
    local = await f.put(local, home, null);
    let shared = await f.assign(await f.create());
    shared = await f.put(shared, home, location.id, "book");
    await assert.rejects(
      () =>
        bookMembership(f.store.db, book.id, {
          universeId: null,
          seriesId: null,
          expectedUpdatedAt: book.updatedAt,
        }),
      /this book's values/,
    );
    shared = await f.put(shared, home, null, "book");
    await bookMembership(f.store.db, book.id, {
      universeId: null,
      seriesId: null,
      expectedUpdatedAt: book.updatedAt,
    });
    assert.equal(
      (await f.store.entries(book.id)).some((e: any) => e.id === shared.id),
      false,
    );
  } finally {
    await f.pg.close();
  }
});

test("book purge removes its local override links, retains shared canon and recovers complete API-created state", async () => {
  const f = await sharedFixture(),
    target = await fixture(),
    dir = await mkdtemp(join(tmpdir(), "rolltop-shared-write-"));
  try {
    const home = f.fields.find((x) => x.key === "home")!;
    const location = await f.create(f.book.id, "universe", "location", "World"),
      local = await f.create(f.book.id, "book", "location", "Local");
    let e = await f.assign(await f.create());
    e = await f.put(e, home, location.id);
    e = await f.put(e, home, local.id, "book");
    e = await f.put(e, home, location.id, "book", f.other.id);
    const before = structuredClone(e);
    await f.store.trashBook(f.book.id);
    const dead = (await f.store.book(f.book.id)).book;
    f.store.backupDirectory = dir;
    const receipt = await f.store.purge("book", dead.id, {
      confirmTitle: dead.title,
      expectedDeletedAt: dead.deletedAt,
    });
    e = await f.current(e.id, f.other.id);
    assert.deepEqual(e.values, before.values);
    assert.equal(e.overrides.length, 1);
    assert.equal(e.overrides[0].bookId, f.other.id);
    const backup = await readBookBackup(join(dir, receipt.backup));
    await target.store.db.transaction(async (q) => {
      for (const t of [...backupTables].reverse()) await q(`DELETE FROM ${t}`);
      await restoreBookBackup(q, backup);
    });
    assert.deepEqual(
      (await target.store.entries(f.other.id)).find((x) => x.id === e.id),
      before,
    );
  } finally {
    await f.pg.close();
    await target.pg.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("shared HTTP scope, canon confirmation, overrides, definitions and conflicts are authenticated", async () => {
  const f = await sharedFixture(),
    origin = "http://localhost:4317",
    password = "scratch-shared-password";
  const server = studioServer(f.store, {
    origin,
    passwordHash: await passwordHash(password),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  let cookie = "";
  const req = (path: string, value?: any, method = "PUT", o = origin) =>
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
    const path = `/books/${f.book.id}/entries`;
    assert.equal(
      (
        await req(
          path,
          { name: "Shared", entryType: "character", scopeKind: "universe" },
          "POST",
        )
      ).status,
      401,
    );
    cookie = (await req("/login", { password }, "POST")).headers
      .get("set-cookie")!
      .split(";")[0];
    const created = await req(
      path,
      { name: "Shared", entryType: "character", scopeKind: "universe" },
      "POST",
    );
    assert.equal(created.status, 201);
    let e = await created.json();
    assert.equal(
      (
        await req(`${path}/${e.id}`, {
          name: "Implicit",
          expectedUpdatedAt: e.updatedAt,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await req(
          `${path}/${e.id}`,
          {
            name: "Explicit",
            editSharedCanon: true,
            expectedUpdatedAt: e.updatedAt,
          },
          "PUT",
          "https://evil.example",
        )
      ).status,
      403,
    );
    e = await f.assign(e);
    const age = f.fields.find((x) => x.key === "age")!;
    const valuePath = `${path}/${e.id}/values/${age.id}`;
    const payload = {
      mode: "book",
      value: 0,
      expectedUpdatedAt: e.updatedAt,
      expectedFieldUpdatedAt: age.updatedAt,
    };
    const saved = await req(valuePath, payload);
    assert.equal(saved.status, 200);
    e = await saved.json();
    assert.equal(e.overrides[0].values[age.id], 0);
    assert.equal(e.values[age.id], undefined);
    assert.equal((await req(valuePath, payload)).status, 409);
    assert.equal(
      (
        await req(valuePath, {
          ...payload,
          expectedUpdatedAt: e.updatedAt,
          expectedFieldUpdatedAt: "stale",
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await req(valuePath, {
          ...payload,
          mode: "wrong",
          expectedUpdatedAt: e.updatedAt,
        })
      ).status,
      400,
    );
    const otherPath = `/books/${f.other.id}/entries/${e.id}`;
    const updated = await req(otherPath, {
      name: "Canon",
      expectedUpdatedAt: e.updatedAt,
      editSharedCanon: true,
    });
    assert.equal(updated.status, 200);
    assert.equal((await req(path, undefined, "GET")).status, 200);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.pg.close();
  }
});

test("structured and exact-decimal overrides stay independent from canon and use the same validators", async () => {
  const f = await sharedFixture();
  try {
    let e = await f.assign(await f.create());
    for (const [fieldType, value] of [
      ["decimal", "12345678901234567890.00100"],
      ["realDate", "2024-02-29"],
      ["fictionalDate", { label: "Winter end", ordinal: 0 }],
      ["table", { columns: ["Name"], rows: [["雨\ntext"]] }],
    ] as const) {
      const field = await editDefinition(f.store.db, f.library.id, "field", {
        templateId: f.template.id,
        label: fieldType,
        fieldType,
      });
      e = await f.put(e, field, value, "book");
      assert.equal(e.values[field.id], undefined);
      assert.deepEqual(e.overrides[0].values[field.id], value);
      const previous = e;
      await assert.rejects(() => f.put(e, field, { invalid: true }, "book"));
      assert.deepEqual(await f.current(e.id), previous);
    }
    const choice = await editDefinition(f.store.db, f.library.id, "field", {
      templateId: f.template.id,
      label: "Choice",
      fieldType: "selection",
      options: [{ label: "A" }, { label: "B" }],
      multiple: true,
    });
    e = await f.put(e, choice, [choice.options[1].id], "book");
    await assert.rejects(
      () =>
        editDefinition(
          f.store.db,
          f.library.id,
          "field",
          { expectedUpdatedAt: choice.updatedAt, options: [choice.options[0]] },
          choice.id,
        ),
      /saved values/,
    );
    assert.deepEqual(e.overrides[0].values[choice.id], [choice.options[1].id]);
  } finally {
    await f.pg.close();
  }
});
