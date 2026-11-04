// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support.ts";
import { structuredValueError as error } from "../src/structured-values.ts";
import { captureBook, backupTables, restoreBookBackup } from "../src/backup.ts";
import { studioServer } from "../src/http.ts";
import { passwordHash } from "../src/auth.ts";

test("structured values follow Spec selection/date/table bounds including Unicode and year zero", () => {
  const a = crypto.randomUUID(),
    b = crypto.randomUUID();
  const selection = { fieldType: "selection", options: [{ id: a }, { id: b }] };
  for (const v of [[], [a]]) assert.equal(error(selection, v), undefined);
  for (const v of [[a, b], [a, a], ["foreign"], "a", [4]])
    assert.ok(error(selection, v));
  assert.equal(error({ ...selection, multiple: true }, [b, a]), undefined);
  for (const v of ["0000-02-29", "2000-02-29", "2024-12-31"])
    assert.equal(error({ fieldType: "realDate" }, v), undefined);
  for (const v of [
    "1900-02-29",
    "2025-02-29",
    "2024-04-31",
    "2024-00-10",
    "2024-01-00",
    "2024-01-01\n",
    "24-01-01",
    4,
  ])
    assert.ok(error({ fieldType: "realDate" }, v));
  for (const v of [
    { label: "Third moon" },
    { label: "Rain", calendar: "Orchard", ordinal: 0 },
    { label: "Before", ordinal: -9007199254740991 },
  ])
    assert.equal(error({ fieldType: "fictionalDate" }, v), undefined);
  for (const v of [
    { label: "" },
    { label: "x", calendar: "" },
    { label: "x", ordinal: 1.5 },
    { label: "x", ordinal: 9007199254740992 },
    { label: "x", ordinal: null },
    { label: "x", extra: true },
  ])
    assert.ok(error({ fieldType: "fictionalDate" }, v));
  const cell = "雨".repeat(1000),
    unicode = "😀".repeat(1000);
  assert.equal(
    error({ fieldType: "table" }, { columns: [unicode], rows: [[cell]] }),
    undefined,
  );
  assert.equal(
    error(
      { fieldType: "table" },
      {
        columns: Array(20).fill(""),
        rows: Array.from({ length: 500 }, () => Array(20).fill(cell)),
      },
    ),
    undefined,
  );
  for (const v of [
    { columns: [], rows: [] },
    { columns: Array(21).fill(""), rows: [] },
    { columns: ["a"], rows: Array(501).fill([""]) },
    { columns: ["a"], rows: [["x", "y"]] },
    { columns: ["a"], rows: [[4]] },
    { columns: ["a"], rows: [[cell + "x"]] },
    { columns: ["a"], rows: [], extra: true },
  ])
    assert.ok(error({ fieldType: "table" }, v));
});
async function setup() {
  const f = await fixture();
  const catalog = await f.store.templates(f.library.id);
  const template = catalog.templates.find((t) => t.entryType === "event")!;
  let entry = await f.store.createEntry(f.book.id, {
    name: "Rainfall",
    entryType: "event",
  });
  entry = await f.store.editEntryField(f.book.id, entry.id, {
    templateId: template.id,
    expectedUpdatedAt: entry.updatedAt,
    expectedTemplateUpdatedAt: template.updatedAt,
  });
  const fields: any[] = [];
  for (const fieldType of ["selection", "realDate", "table"]) {
    const field = {
      id: crypto.randomUUID(),
      templateId: template.id,
      key: fieldType,
      label: fieldType,
      fieldType,
      ...(fieldType === "selection"
        ? {
            options: [
              { id: crypto.randomUUID(), label: "One" },
              { id: crypto.randomUUID(), label: "Two" },
            ],
            multiple: true,
          }
        : {}),
      required: false,
      orderKey: "z",
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
    await f.store.db.query("INSERT INTO bible_fields VALUES($1,$2,$3,$4)", [
      field.id,
      f.library.id,
      template.id,
      field,
    ]);
    fields.push(field);
  }
  fields.push(
    catalog.fields.find(
      (f) => f.templateId === template.id && f.key === "when",
    ),
  );
  return { ...f, entry, fields };
}

test("structured writes preserve other data through stale failures, clearing and scratch recovery", async () => {
  const f = await setup(),
    target = await fixture();
  try {
    let entry = f.entry;
    const before = await f.store.document(f.scene.id);
    await f.store.db.query(
      "UPDATE bible_entries SET data=data || $2::jsonb WHERE id=$1",
      [
        entry.id,
        JSON.stringify({ future: { keep: true }, attachments: ["opaque"] }),
      ],
    );
    const samples: any = {
      selection: [f.fields[0].options[1].id, f.fields[0].options[0].id],
      realDate: "0000-02-29",
      table: {
        columns: ["Unit", "Meaning"],
        rows: [
          ["雨", "Rain\nwater"],
          ["Copper", ""],
        ],
      },
      fictionalDate: { label: "Third moon", calendar: "Lantern", ordinal: -2 },
    };
    for (const field of f.fields) {
      entry = await f.store.editEntryField(
        f.book.id,
        entry.id,
        {
          value: samples[field.fieldType],
          expectedUpdatedAt: entry.updatedAt,
          expectedFieldUpdatedAt: field.updatedAt,
        },
        field.id,
      );
      assert.deepEqual(entry.values[field.id], samples[field.fieldType]);
    }
    const backup = await f.store.db.transaction((q) =>
      captureBook(q, f.book.id),
    );
    await target.store.db.transaction(async (q) => {
      for (const t of [...backupTables].reverse()) await q(`DELETE FROM ${t}`);
      await restoreBookBackup(q, backup);
    });
    assert.deepEqual((await target.store.entries(f.book.id))[0], entry);
    const date = f.fields.find((f) => f.fieldType === "realDate");
    const snapshot = structuredClone(entry);
    await assert.rejects(
      () =>
        f.store.editEntryField(
          f.book.id,
          entry.id,
          {
            value: "2025-02-29",
            expectedUpdatedAt: entry.updatedAt,
            expectedFieldUpdatedAt: date.updatedAt,
          },
          date.id,
        ),
      /valid Gregorian/,
    );
    await assert.rejects(
      () =>
        f.store.editEntryField(
          f.book.id,
          entry.id,
          {
            value: "2024-01-01",
            expectedUpdatedAt: entry.updatedAt,
            expectedFieldUpdatedAt: "stale",
          },
          date.id,
        ),
      /field changed/,
    );
    assert.deepEqual((await f.store.entries(f.book.id))[0], snapshot);
    entry = await f.store.editEntryField(
      f.book.id,
      entry.id,
      {
        value: null,
        expectedUpdatedAt: entry.updatedAt,
        expectedFieldUpdatedAt: date.updatedAt,
      },
      date.id,
    );
    delete snapshot.values[date.id];
    assert.deepEqual(entry.values, snapshot.values);
    assert.deepEqual(entry.future, { keep: true });
    assert.deepEqual(entry.attachments, ["opaque"]);
    assert.deepEqual(await f.store.document(f.scene.id), before);
  } finally {
    await f.pg.close();
    await target.pg.close();
  }
});

test("structured HTTP saves valid large tables and refuses malformed values without changing saved data", async () => {
  const f = await setup();
  const password = "scratch-structured-password",
    origin = "http://localhost:4317";
  const server = studioServer(f.store, {
    origin,
    passwordHash: await passwordHash(password),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  let cookie = "";
  const request = (path: string, data: any, method = "PUT", site = origin) =>
    fetch(base + path, {
      method,
      headers: {
        Cookie: cookie,
        Origin: site,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });
  try {
    const field = f.fields.find((f) => f.fieldType === "table"),
      path = `/books/${f.book.id}/entries/${f.entry.id}/values/${field.id}`;
    const value = {
      columns: Array(20).fill("Column"),
      rows: Array.from({ length: 220 }, () => Array(20).fill("x".repeat(1000))),
    };
    const patch = {
      value,
      expectedUpdatedAt: f.entry.updatedAt,
      expectedFieldUpdatedAt: field.updatedAt,
    };
    assert.equal((await request(path, patch)).status, 401);
    const login = await request("/login", { password }, "POST");
    cookie = login.headers.get("set-cookie")!.split(";")[0];
    assert.equal(
      (await request(path, patch, "PUT", "https://evil.example")).status,
      403,
    );
    const response = await request(path, patch);
    assert.equal(response.status, 200);
    const saved = await response.json();
    assert.deepEqual(saved.values[field.id], value);
    assert.equal((await request(path, patch)).status, 409);
    assert.equal(
      (
        await request(path, {
          ...patch,
          expectedUpdatedAt: saved.updatedAt,
          value: { columns: ["a"], rows: [["a", "b"]] },
        })
      ).status,
      400,
    );
    assert.deepEqual((await f.store.entries(f.book.id))[0], saved);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.pg.close();
  }
});
