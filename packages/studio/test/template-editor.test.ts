// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support.ts";
import { editDefinition } from "../src/template-editor.ts";
import { captureBook, backupTables, restoreBookBackup } from "../src/backup.ts";
import { studioServer } from "../src/http.ts";
import { passwordHash } from "../src/auth.ts";
test("custom templates/fields preserve identities, generate unique keys and order without type conversions", async () => {
  const f = await fixture();
  try {
    const write = (kind: "template" | "field", input: any, id?: string) =>
      editDefinition(f.store.db, f.library.id, kind, input, id);
    const t = await write("template", {
      name: "Custom character",
      entryType: "character",
    });
    assert.equal(t.builtIn, false);
    let a = await write("field", {
      templateId: t.id,
      label: "Home port",
      fieldType: "shortText",
      required: true,
    });
    const b = await write("field", {
      templateId: t.id,
      label: "Home port",
      fieldType: "integer",
    });
    assert.equal(a.key, "homePort");
    assert.equal(b.key, "homePort2");
    assert.ok(a.orderKey < b.orderKey);
    await f.store.db.query(
      "UPDATE bible_fields SET data=data || $2::jsonb WHERE id=$1",
      [a.id, JSON.stringify({ future: { keep: true } })],
    );
    a = await write(
      "field",
      { label: "New label", expectedUpdatedAt: a.updatedAt },
      a.id,
    );
    assert.equal(a.key, "homePort");
    assert.deepEqual(a.future, { keep: true });
    assert.equal(a.required, true);
    await assert.rejects(
      () =>
        write(
          "field",
          { label: "Stale", expectedUpdatedAt: b.updatedAt },
          a.id,
        ),
      /changed/,
    );
    await assert.rejects(
      () =>
        write(
          "field",
          { fieldType: "decimal", expectedUpdatedAt: a.updatedAt },
          a.id,
        ),
      /Types and keys/,
    );
    const moved = await write(
      "field",
      { beforeId: a.id, expectedUpdatedAt: b.updatedAt },
      b.id,
    );
    assert.ok(moved.orderKey < a.orderKey);
    const renamed = await write(
      "template",
      { name: "Renamed", expectedUpdatedAt: t.updatedAt },
      t.id,
    );
    assert.equal(renamed.id, t.id);
    assert.equal(renamed.createdAt, t.createdAt);
    for (const input of [
      { templateId: t.id, label: "Bad", fieldType: "invalid" },
      { templateId: t.id, label: "Bad", fieldType: "selection", options: [] },
      {
        templateId: t.id,
        label: "Bad",
        fieldType: "shortText",
        multiple: true,
      },
      {
        templateId: t.id,
        label: "Bad",
        fieldType: "integer",
        options: [{ label: "No" }],
      },
    ])
      await assert.rejects(() => write("field", input));
    const other = await f.store.createLibrary("Other");
    await assert.rejects(
      () =>
        editDefinition(f.store.db, other.id, "field", {
          templateId: t.id,
          label: "No",
          fieldType: "shortText",
        }),
      /this library/,
    );
  } finally {
    await f.pg.close();
  }
});
test("option IDs and used values survive customization, Trash and recovery; destructive restrictions are rejected", async () => {
  const f = await fixture(),
    target = await fixture();
  try {
    const t = await editDefinition(f.store.db, f.library.id, "template", {
      name: "Custom",
      entryType: "character",
    });
    let field = await editDefinition(f.store.db, f.library.id, "field", {
      templateId: t.id,
      label: "State",
      fieldType: "selection",
      multiple: true,
      options: [{ label: "One" }, { label: "Two" }],
    });
    let e = await f.store.createEntry(f.book.id, {
      name: "Corin",
      entryType: "character",
    });
    e = await f.store.editEntryField(f.book.id, e.id, {
      templateId: t.id,
      expectedUpdatedAt: e.updatedAt,
      expectedTemplateUpdatedAt: t.updatedAt,
    });
    e = await f.store.editEntryField(
      f.book.id,
      e.id,
      {
        value: field.options.map((o: any) => o.id),
        expectedUpdatedAt: e.updatedAt,
        expectedFieldUpdatedAt: field.updatedAt,
      },
      field.id,
    );
    await assert.rejects(
      () =>
        editDefinition(
          f.store.db,
          f.library.id,
          "field",
          { multiple: false, expectedUpdatedAt: field.updatedAt },
          field.id,
        ),
      /used by saved values/,
    );
    await assert.rejects(
      () =>
        editDefinition(
          f.store.db,
          f.library.id,
          "field",
          { options: [field.options[0]], expectedUpdatedAt: field.updatedAt },
          field.id,
        ),
      /used by saved values/,
    );
    field = await editDefinition(
      f.store.db,
      f.library.id,
      "field",
      {
        options: field.options.map((o: any) => ({
          id: o.id,
          label: o.label + " renamed",
        })),
        expectedUpdatedAt: field.updatedAt,
      },
      field.id,
    );
    assert.deepEqual(
      (await f.store.entries(f.book.id))[0].values[field.id],
      e.values[field.id],
    );
    await f.store.updateEntry(f.book.id, e.id, {
      deleted: true,
      expectedUpdatedAt: e.updatedAt,
    });
    await assert.rejects(
      () =>
        editDefinition(
          f.store.db,
          f.library.id,
          "field",
          { multiple: false, expectedUpdatedAt: field.updatedAt },
          field.id,
        ),
      /including Trash/,
    );
    const backup = await f.store.db.transaction((q) =>
      captureBook(q, f.book.id),
    );
    await target.store.db.transaction(async (q) => {
      for (const table of [...backupTables].reverse())
        await q(`DELETE FROM ${table}`);
      await restoreBookBackup(q, backup);
    });
    assert.deepEqual(
      await target.store.templates(f.library.id),
      await f.store.templates(f.library.id),
    );
    assert.deepEqual(
      await target.store.entries(f.book.id),
      await f.store.entries(f.book.id),
    );
  } finally {
    await f.pg.close();
    await target.pg.close();
  }
});
test("definition HTTP writes require auth/origin, validate inputs and detect stale changes", async () => {
  const f = await fixture(),
    origin = "http://localhost:4317",
    password = "scratch-custom-password";
  const server = studioServer(f.store, {
    origin,
    passwordHash: await passwordHash(password),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  let cookie = "";
  const req = (p: string, v: any, m = "POST", o = origin) =>
    fetch(base + p, {
      method: m,
      headers: {
        Cookie: cookie,
        Origin: o,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(v),
    });
  try {
    const path = `/libraries/${f.library.id}/templates`,
      input = { name: "HTTP custom", entryType: "term" };
    assert.equal((await req(path, input)).status, 401);
    const login = await req("/login", { password });
    cookie = login.headers.get("set-cookie")!.split(";")[0];
    assert.equal(
      (await req(path, input, "POST", "https://evil.example")).status,
      403,
    );
    const result = await req(path, input);
    assert.equal(result.status, 201);
    const t = await result.json();
    const fieldResponse = await req(`/libraries/${f.library.id}/fields`, {
      templateId: t.id,
      label: "Exact",
      fieldType: "decimal",
    });
    assert.equal(fieldResponse.status, 201);
    const field = await fieldResponse.json();
    assert.equal(
      (
        await req(
          `${path}/${t.id}`,
          { name: "Rename", expectedUpdatedAt: t.updatedAt },
          "PUT",
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await req(
          `${path}/${t.id}`,
          { name: "Stale", expectedUpdatedAt: t.updatedAt },
          "PUT",
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await req(
          `/libraries/${f.library.id}/fields/${field.id}`,
          { fieldType: "integer", expectedUpdatedAt: field.updatedAt },
          "PUT",
        )
      ).status,
      400,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.pg.close();
  }
});

test("target restrictions cannot invalidate saved links; equal order keys are repaired safely", async () => {
  const f = await fixture();
  try {
    const c = await f.store.templates(f.library.id),
      t = c.templates.find((t) => t.entryType === "character")!,
      home = c.fields.find((x) => x.templateId === t.id && x.key === "home")!;
    const target = await f.store.createEntry(f.book.id, {
      name: "Place",
      entryType: "location",
    });
    let entry = await f.store.createEntry(f.book.id, {
      name: "Corin",
      entryType: "character",
    });
    entry = await f.store.editEntryField(f.book.id, entry.id, {
      templateId: t.id,
      expectedUpdatedAt: entry.updatedAt,
      expectedTemplateUpdatedAt: t.updatedAt,
    });
    entry = await f.store.editEntryField(
      f.book.id,
      entry.id,
      {
        value: target.id,
        expectedUpdatedAt: entry.updatedAt,
        expectedFieldUpdatedAt: home.updatedAt,
      },
      home.id,
    );
    await assert.rejects(
      () =>
        editDefinition(
          f.store.db,
          f.library.id,
          "field",
          {
            targetEntryTypes: ["character"],
            expectedUpdatedAt: home.updatedAt,
          },
          home.id,
        ),
      /invalidate saved links/,
    );
    const a = c.fields.find((x) => x.templateId === t.id && x.key === "role")!,
      b = c.fields.find((x) => x.templateId === t.id && x.key === "biography")!;
    await f.store.db.query(
      "UPDATE bible_fields SET data=jsonb_set(data,'{orderKey}','\"a\"') WHERE id=ANY($1::uuid[])",
      [[a.id, b.id]],
    );
    const peers = (await f.store.templates(f.library.id)).fields.filter(
      (f) => f.templateId === t.id,
    );
    const index = peers.findIndex((f) => f.id === a.id);
    const second = index === 0 ? b : a;
    const moved = await editDefinition(
      f.store.db,
      f.library.id,
      "field",
      { beforeId: second.id, expectedUpdatedAt: home.updatedAt },
      home.id,
    );
    assert.ok(moved.orderKey);
    const after = await f.store.templates(f.library.id);
    assert.equal(
      after.fields.filter((f) => f.templateId === t.id && f.orderKey === "a")
        .length,
      0,
    );
    assert.equal(
      (await f.store.entries(f.book.id)).find((e) => e.id === entry.id).values[
        home.id
      ],
      target.id,
    );
  } finally {
    await f.pg.close();
  }
});
