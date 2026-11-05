// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, removeWorldSchema } from "./support.ts";
import { StudioStore } from "../src/store.ts";
import { initializeTemplates } from "../src/templates.ts";
import {
  captureBook,
  backupTables,
  readBookBackup,
  restoreBookBackup,
} from "../src/backup.ts";
import { studioServer } from "../src/http.ts";
import { passwordHash } from "../src/auth.ts";

test("libraries seed native built-ins once with stable IDs, library isolation and FK/key protection", async () => {
  const f = await fixture();
  try {
    const before = await f.store.document(f.scene.id);
    const first = await f.store.templates(f.library.id);
    assert.equal(first.templates.length, 9);
    assert.equal(first.fields.length, 20);
    const expected: Record<string, string[]> = {
      character: [
        "role:Role:shortText",
        "biography:Biography:longText",
        "age:Age:integer",
        "home:Home:entryReference",
      ],
      location: [
        "description:Description:longText",
        "climate:Climate:shortText",
      ],
      organization: [
        "purpose:Purpose:longText",
        "leader:Leader:entryReference",
      ],
      object: [
        "description:Description:longText",
        "owner:Owner:entryReference",
      ],
      event: ["when:When:fictionalDate", "whatHappens:What happens:longText"],
      plotline: ["stakes:Stakes:longText", "resolution:Resolution:longText"],
      worldRule: ["rule:The rule:longText", "exceptions:Exceptions:longText"],
      research: ["source:Source:shortText", "notes:Notes:longText"],
      term: [
        "meaning:Meaning:longText",
        "pronunciation:Pronunciation:shortText",
      ],
    };
    for (const t of first.templates) {
      assert.equal(
        t.name,
        t.entryType === "worldRule"
          ? "World Rule"
          : t.entryType[0].toUpperCase() + t.entryType.slice(1),
      );
      assert.equal(t.builtIn, true);
      const fields = first.fields.filter((x) => x.templateId === t.id);
      assert.deepEqual(
        fields.map((x) => `${x.key}:${x.label}:${x.fieldType}`),
        expected[t.entryType],
      );
      for (const field of fields) {
        assert.equal(field.required, false);
        assert.ok(field.orderKey);
        assert.equal(field.options, undefined);
      }
    }
    for (const [key, target] of [
      ["home", "location"],
      ["leader", "character"],
      ["owner", "character"],
    ])
      assert.deepEqual(
        first.fields.find((x) => x.key === key).targetEntryTypes,
        [target],
      );
    // Existing customizations and unknown fields are never overwritten by initialization.
    const template = first.templates[0];
    await f.store.db.query(
      "UPDATE bible_templates SET data=data || $2::jsonb WHERE id=$1",
      [
        template.id,
        JSON.stringify({ name: "Customized", future: { keep: true } }),
      ],
    );
    const customized = await f.store.templates(f.library.id);
    await f.store.migrate();
    assert.equal(
      await f.store.db.transaction((q) => initializeTemplates(q, f.library.id)),
      0,
    );
    assert.deepEqual(await f.store.templates(f.library.id), customized);
    const other = await f.store.createLibrary("Other");
    const second = await f.store.templates(other.id);
    assert.equal(second.templates.length, 9);
    assert.ok(
      second.templates.every(
        (t) => !first.templates.some((x) => x.id === t.id),
      ),
    );
    const field = { ...first.fields[0], id: randomUUID() };
    await assert.rejects(() =>
      f.store.db.query("INSERT INTO bible_fields VALUES($1,$2,$3,$4)", [
        field.id,
        other.id,
        field.templateId,
        field,
      ]),
    );
    await assert.rejects(() =>
      f.store.db.query("INSERT INTO bible_fields VALUES($1,$2,$3,$4)", [
        field.id,
        f.library.id,
        field.templateId,
        field,
      ]),
    ); // duplicate key
    await assert.rejects(() =>
      f.store.db.query("DELETE FROM libraries WHERE id=$1", [other.id]),
    );
    assert.deepEqual(await f.store.document(f.scene.id), before);
  } finally {
    await f.pg.close();
  }
});

test("v3 upgrade preserves entries/revisions and rolls back seeding failure before retry", async () => {
  const f = await fixture();
  try {
    const entry = await f.store.createEntry(f.book.id, {
      name: "Keep",
      entryType: "term",
    });
    const before = await f.store.document(f.scene.id);
    await removeWorldSchema(f.store);
    await f.store.db.query("DROP TABLE bible_fields");
    await f.store.db.query("DROP TABLE bible_templates");
    await f.store.db.query("UPDATE studio_schema SET version=3");
    const broken = new StudioStore({
      query: f.store.db.query,
      transaction: (fn) =>
        f.store.db.transaction((q) =>
          fn((sql, params) => {
            if (sql.startsWith("INSERT INTO bible_fields"))
              throw Error("seed failure");
            return q(sql, params);
          }),
        ),
    });
    await assert.rejects(() => broken.migrate(), /seed failure/);
    assert.equal(
      (await f.store.db.query("SELECT version FROM studio_schema")).rows[0]
        .version,
      3,
    );
    assert.equal(
      (await f.store.db.query("SELECT to_regclass('bible_templates') AS name"))
        .rows[0].name,
      null,
    );
    await f.store.migrate();
    await f.store.migrate();
    assert.equal(
      (await f.store.db.query("SELECT version FROM studio_schema")).rows[0]
        .version,
      9,
    );
    assert.equal((await f.store.templates(f.library.id)).fields.length, 20);
    assert.deepEqual(await f.store.entries(f.book.id), [entry]);
    assert.deepEqual(await f.store.document(f.scene.id), before);
  } finally {
    await f.pg.close();
  }
});

test("new recovery includes library templates; legacy v1 files restore into v4 without losing book data", async () => {
  const f = await fixture(),
    target = await fixture();
  const dir = await mkdtemp(join(tmpdir(), "rolltop-legacy-"));
  try {
    const backup = await f.store.db.transaction((q) =>
      captureBook(q, f.book.id),
    );
    assert.equal(backup.version, 7);
    assert.equal(backup.schemaVersion, 9);
    assert.equal(backup.tables.bible_fields.length, 20);
    const legacy = structuredClone(backup);
    legacy.version = 1;
    legacy.schemaVersion = 3;
    delete legacy.tables.bible_fields;
    delete legacy.tables.bible_templates;
    const payload = JSON.stringify(legacy),
      path = join(dir, "legacy.json");
    await writeFile(
      path,
      JSON.stringify({
        payload,
        sha256: createHash("sha256").update(payload).digest("hex"),
      }),
    );
    const read = await readBookBackup(path);
    await target.store.db.transaction(async (q) => {
      for (const t of [...backupTables].reverse()) await q(`DELETE FROM ${t}`);
      await restoreBookBackup(q, read);
    });
    assert.deepEqual((await target.store.book(f.book.id)).book, f.book);
    assert.deepEqual(
      await target.store.document(f.scene.id),
      await f.store.document(f.scene.id),
    );
    assert.equal(
      (await target.store.templates(f.library.id)).templates.length,
      9,
    );
    const trashed = await f.store.trashBook(f.book.id);
    f.store.backupDirectory = dir;
    const book = (await f.store.book(trashed.id)).book;
    await f.store.purge("book", book.id, {
      confirmTitle: book.title,
      expectedDeletedAt: book.deletedAt,
    });
    assert.equal((await f.store.templates(f.library.id)).fields.length, 20);
  } finally {
    await f.pg.close();
    await target.pg.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("template catalog HTTP requires login and scopes reads to a valid library", async () => {
  const f = await fixture();
  const password = "scratch-template-password",
    origin = "http://localhost:4317";
  const server = studioServer(f.store, {
    origin,
    passwordHash: await passwordHash(password),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  try {
    const path = `/libraries/${f.library.id}/templates`;
    assert.equal((await fetch(base + path)).status, 401);
    const login = await fetch(base + "/login", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const headers = { Cookie: login.headers.get("set-cookie")!.split(";")[0] };
    const response = await fetch(base + path, { headers });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).fields.length, 20);
    assert.equal(
      (await fetch(base + `/libraries/${randomUUID()}/templates`, { headers }))
        .status,
      404,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.pg.close();
  }
});
