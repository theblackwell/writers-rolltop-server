// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture } from "./support.ts";
import { PortableImports, exportPortable } from "../src/portable.ts";
import { readArchive } from "../src/archive-validation.ts";
import { captureLibrary, readBookBackup } from "../src/backup.ts";
test("native archive installs atomically alongside existing libraries, re-exports every record/attachment and replaces only after fresh preview plus durable backup", async () => {
  const f = await fixture(),
    dir = await mkdtemp(join(tmpdir(), "rolltop-portable-"));
  f.store.backupDirectory = dir;
  try {
    const bytes = await readFile(
        new URL(
          "../fixtures/archives/valid/unknown-optional-fields.rolltop",
          import.meta.url,
        ),
      ),
      source = readArchive(bytes),
      imports = new PortableImports(f.store);
    const preview = await imports.preview(bytes);
    assert.equal(preview.targetExists, false);
    const result = await imports.commit(preview.id, { mode: "new" });
    assert.equal(result.library.id, source.library.id);
    assert.deepEqual(await imports.commit(preview.id, { mode: "new" }), result);
    const out = readArchive(await exportPortable(f.store, source.library.id));
    for (const key of [
      "library",
      "universes",
      "series",
      "books",
      "nodes",
      "entries",
      "templates",
      "fields",
      "facts",
      "questions",
      "events",
      "stateChanges",
      "relationships",
      "relationshipTypes",
      "notes",
      "references",
      "attachments",
    ] as const) {
      const normalize = (v: any) =>
        Array.isArray(v)
          ? [...v].sort((a, b) =>
              (a.id ?? a.sha256).localeCompare(b.id ?? b.sha256),
            )
          : v;
      assert.deepEqual(normalize(out[key]), normalize(source[key]), key);
    }
    for (const [id, doc] of source.documents)
      assert.deepEqual(out.documents.get(id), doc);
    for (const [h, b] of source.blobs) assert.deepEqual(out.blobs.get(h), b);
    const p2 = await imports.preview(bytes);
    assert.equal(p2.targetExists, true);
    await assert.rejects(imports.commit(p2.id, { mode: "new" }), {
      code: "TARGET_EXISTS",
    });
    await assert.rejects(
      imports.commit(p2.id, {
        mode: "replace",
        confirmed: false,
        confirmTitle: source.library.title,
      }),
      { code: "CONFIRMATION_REQUIRED" },
    );
    await f.store.db.query(
      "UPDATE libraries SET data=jsonb_set(data,'{title}','\"Changed\"') WHERE id=$1",
      [source.library.id],
    );
    await assert.rejects(
      imports.commit(p2.id, {
        mode: "replace",
        confirmed: true,
        confirmTitle: source.library.title,
      }),
      { code: "IMPORT_CONFLICT" },
    );
    imports.cancel(p2.id);
    const p3 = await imports.preview(bytes);
    const replaced = await imports.commit(p3.id, {
      mode: "replace",
      confirmed: true,
      confirmTitle: source.library.title,
    });
    assert.ok(replaced.backup);
    const backup = await readBookBackup(join(dir, replaced.backup));
    assert.equal(backup.tables.libraries[0].data.title, "Changed");
    assert.equal(
      (await f.store.library(f.library.id)).library.title,
      "Scratch library",
    );
    assert.equal(
      (await f.store.library(source.library.id)).library.title,
      source.library.title,
    );
  } finally {
    await f.pg.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("empty libraries export, install and replace with a readable recovery backup", async () => {
  const f = await fixture(),
    dir = await mkdtemp(join(tmpdir(), "rolltop-empty-portable-"));
  f.store.backupDirectory = dir;
  try {
    const empty = await f.store.createLibrary("Empty room"),
      bytes = await exportPortable(f.store, empty.id),
      s = readArchive(bytes);
    assert.equal(s.books.length, 0);
    assert.equal(s.documents.size, 0);
    const imports = new PortableImports(f.store),
      p = await imports.preview(bytes);
    const result = await imports.commit(p.id, {
      mode: "replace",
      confirmed: true,
      confirmTitle: empty.title,
    });
    const b = await readBookBackup(join(dir, result.backup!));
    assert.equal(b.tables.books.length, 0);
    assert.equal(b.tables.libraries[0].id, empty.id);
    assert.equal(
      readArchive(await exportPortable(f.store, empty.id)).library.id,
      empty.id,
    );
  } finally {
    await f.pg.close();
    await rm(dir, { recursive: true, force: true });
  }
});
