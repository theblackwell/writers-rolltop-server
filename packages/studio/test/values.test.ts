// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support.ts";
import { captureBook } from "../src/backup.ts";
import { studioServer } from "../src/http.ts";
import { passwordHash } from "../src/auth.ts";
async function setup() {
  const f = await fixture();
  const catalog = await f.store.templates(f.library.id);
  const template = catalog.templates.find((t) => t.entryType === "character")!;
  let entry = await f.store.createEntry(f.book.id, {
    name: "Corin",
    entryType: "character",
  });
  entry = await f.store.editEntryField(f.book.id, entry.id, {
    templateId: template.id,
    expectedUpdatedAt: entry.updatedAt,
    expectedTemplateUpdatedAt: template.updatedAt,
  });
  return { ...f, catalog, template, entry };
}
test("scalar values preserve exact decimals, false/zero/empty text and opaque data; clear only one field", async () => {
  const f = await setup();
  try {
    let entry = f.entry;
    const before = await f.store.document(f.scene.id);
    const extras = {
      future: { keep: true },
      overrides: [],
      attachments: ["opaque"],
    };
    await f.store.db.query(
      "UPDATE bible_entries SET data=data || $2::jsonb WHERE id=$1",
      [entry.id, JSON.stringify(extras)],
    );
    const fields = f.catalog.fields.filter(
      (x) => x.templateId === f.template.id,
    );
    for (const [key, fieldType] of [
      ["exact", "decimal"],
      ["flag", "boolean"],
    ]) {
      const id = crypto.randomUUID();
      const field = {
        id,
        templateId: f.template.id,
        key,
        label: key,
        fieldType,
        required: true,
        orderKey: "z",
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      };
      await f.store.db.query("INSERT INTO bible_fields VALUES($1,$2,$3,$4)", [
        id,
        f.library.id,
        f.template.id,
        field,
      ]);
      fields.push(field);
    }
    const samples: Record<string, unknown> = {
      role: "",
      biography: "Line one\n雨",
      age: 0,
      exact: "123456789012345678901234567890.00100",
      flag: false,
    };
    for (const field of fields.filter((x) => Object.hasOwn(samples, x.key))) {
      entry = await f.store.editEntryField(
        f.book.id,
        entry.id,
        {
          value: samples[field.key],
          expectedUpdatedAt: entry.updatedAt,
          expectedFieldUpdatedAt: field.updatedAt,
        },
        field.id,
      );
      assert.deepEqual(entry.values[field.id], samples[field.key]);
    }
    for (const [k, v] of Object.entries(extras)) assert.deepEqual(entry[k], v);
    const saved = structuredClone(entry);
    const role = fields.find((f) => f.key === "role")!;
    entry = await f.store.editEntryField(
      f.book.id,
      entry.id,
      {
        value: null,
        expectedUpdatedAt: entry.updatedAt,
        expectedFieldUpdatedAt: role.updatedAt,
      },
      role.id,
    );
    assert.equal(Object.hasOwn(entry.values, role.id), false);
    delete saved.values[role.id];
    assert.deepEqual(entry.values, saved.values);
    const backup = await f.store.db.transaction((q) =>
      captureBook(q, f.book.id),
    );
    assert.deepEqual(
      backup.tables.bible_entries.find((e) => e.id === entry.id).data,
      entry,
    );
    assert.deepEqual(await f.store.document(f.scene.id), before);
    const invalids: Record<string, unknown[]> = {
      role: [4, {}],
      age: [1.2, "12", Number.MAX_SAFE_INTEGER + 1, true],
      exact: [12, "1e3", "01", ".5", "1.", "NaN", "1.25\n"],
      flag: [0, "false"],
    };
    for (const field of fields.filter((x) => Object.hasOwn(invalids, x.key)))
      for (const value of invalids[field.key])
        await assert.rejects(() =>
          f.store.editEntryField(
            f.book.id,
            entry.id,
            {
              value,
              expectedUpdatedAt: entry.updatedAt,
              expectedFieldUpdatedAt: field.updatedAt,
            },
            field.id,
          ),
        );
    assert.deepEqual((await f.store.entries(f.book.id))[0], entry);
  } finally {
    await f.pg.close();
  }
});
test("template/field writes refuse foreign, stale, trashed and destructive changes without losing data", async () => {
  const f = await setup();
  try {
    let entry = f.entry;
    const role = f.catalog.fields.find(
      (x) => x.templateId === f.template.id && x.key === "role",
    )!;
    const patch = {
      value: "Courier",
      expectedUpdatedAt: entry.updatedAt,
      expectedFieldUpdatedAt: role.updatedAt,
    };
    entry = await f.store.editEntryField(f.book.id, entry.id, patch, role.id);
    await assert.rejects(
      () => f.store.editEntryField(f.book.id, entry.id, patch, role.id),
      /changed/,
    );
    await assert.rejects(
      () =>
        f.store.editEntryField(
          f.book.id,
          entry.id,
          {
            ...patch,
            expectedUpdatedAt: entry.updatedAt,
            expectedFieldUpdatedAt: "stale",
          },
          role.id,
        ),
      /field changed/,
    );
    const home = f.catalog.fields.find((x) => x.key === "home")!;
    await assert.rejects(
      () =>
        f.store.editEntryField(
          f.book.id,
          entry.id,
          {
            value: null,
            expectedUpdatedAt: entry.updatedAt,
            expectedFieldUpdatedAt: home.updatedAt,
          },
          home.id,
        ),
      /not supported/,
    );
    await assert.rejects(
      () =>
        f.store.editEntryField(f.book.id, entry.id, {
          templateId: null,
          expectedUpdatedAt: entry.updatedAt,
        }),
      /saved values/,
    );
    const otherLibrary = await f.store.createLibrary("Other");
    const foreign = (await f.store.templates(otherLibrary.id)).templates.find(
      (t) => t.entryType === "character",
    )!;
    const wrongType = f.catalog.templates.find((t) => t.entryType === "term")!;
    for (const t of [foreign, wrongType])
      await assert.rejects(
        () =>
          f.store.editEntryField(f.book.id, entry.id, {
            templateId: t.id,
            expectedUpdatedAt: entry.updatedAt,
            expectedTemplateUpdatedAt: t.updatedAt,
          }),
        /same entry type/,
      );
    const otherField = f.catalog.fields.find(
      (x) => x.templateId === wrongType.id,
    )!;
    await assert.rejects(
      () =>
        f.store.editEntryField(
          f.book.id,
          entry.id,
          {
            value: "No",
            expectedUpdatedAt: entry.updatedAt,
            expectedFieldUpdatedAt: otherField.updatedAt,
          },
          otherField.id,
        ),
      /this entry's template/,
    );
    const before = structuredClone(entry);
    const trashed = await f.store.updateEntry(f.book.id, entry.id, {
      deleted: true,
      expectedUpdatedAt: entry.updatedAt,
    });
    await assert.rejects(
      () =>
        f.store.editEntryField(
          f.book.id,
          entry.id,
          { ...patch, expectedUpdatedAt: trashed.updatedAt },
          role.id,
        ),
      /Restore the entry/,
    );
    entry = await f.store.updateEntry(f.book.id, entry.id, {
      deleted: false,
      expectedUpdatedAt: trashed.updatedAt,
    });
    assert.deepEqual(entry.values, before.values);
    await f.store.trashBook(f.book.id);
    await assert.rejects(
      () =>
        f.store.editEntryField(
          f.book.id,
          entry.id,
          { ...patch, expectedUpdatedAt: entry.updatedAt },
          role.id,
        ),
      /Restore the book/,
    );
  } finally {
    await f.pg.close();
  }
});
test("template assignment can be cleared only without saved values/overrides; HTTP routing enforces auth/origin/CAS", async () => {
  const f = await fixture();
  const password = "scratch-fields-password",
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
    const template = (await f.store.templates(f.library.id)).templates.find(
      (t) => t.entryType === "term",
    )!;
    let entry = await f.store.createEntry(f.book.id, {
      name: "Word",
      entryType: "term",
    });
    const path = `/books/${f.book.id}/entries/${entry.id}`;
    const patch = {
      templateId: template.id,
      expectedUpdatedAt: entry.updatedAt,
      expectedTemplateUpdatedAt: template.updatedAt,
    };
    assert.equal((await request(path + "/template", patch)).status, 401);
    const login = await request("/login", { password }, "POST");
    cookie = login.headers.get("set-cookie")!.split(";")[0];
    assert.equal(
      (await request(path + "/template", patch, "PUT", "https://evil.example"))
        .status,
      403,
    );
    let response = await request(path + "/template", patch);
    assert.equal(response.status, 200);
    entry = await response.json();
    assert.equal((await request(path + "/template", patch)).status, 409);
    const field = (await f.store.templates(f.library.id)).fields.find(
      (f) => f.templateId === template.id,
    )!;
    response = await request(path + `/values/${field.id}`, {
      value: "Meaning",
      expectedUpdatedAt: entry.updatedAt,
      expectedFieldUpdatedAt: field.updatedAt,
    });
    assert.equal(response.status, 200);
    entry = await response.json();
    response = await request(path + `/values/${field.id}`, {
      value: null,
      expectedUpdatedAt: entry.updatedAt,
      expectedFieldUpdatedAt: field.updatedAt,
    });
    entry = await response.json();
    entry = await f.store.editEntryField(f.book.id, entry.id, {
      templateId: null,
      expectedUpdatedAt: entry.updatedAt,
    });
    assert.equal(entry.templateId, undefined);
    await f.store.db.query(
      "UPDATE bible_entries SET data=data || $2::jsonb WHERE id=$1",
      [entry.id, JSON.stringify({ overrides: [{ future: true }] })],
    );
    await assert.rejects(
      () =>
        f.store.editEntryField(f.book.id, entry.id, {
          templateId: template.id,
          expectedUpdatedAt: entry.updatedAt,
          expectedTemplateUpdatedAt: template.updatedAt,
        }),
      /saved values or overrides/,
    );
    assert.equal((await request(path + "/values/invalid", {})).status, 400);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.pg.close();
  }
});
