// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support.ts";
import {
  uploadAttachment,
  downloadAttachment,
  attachmentCatalog,
  attachToRecord,
} from "../src/attachments.ts";
import { exportPortable, PortableImports } from "../src/portable.ts";
import { readArchive } from "../src/archive-validation.ts";
import {
  captureLibrary,
  restoreBookBackup,
  backupTables,
} from "../src/backup.ts";
import { StudioStore } from "../src/store.ts";
test("attachments deduplicate within libraries, verify bytes, guard links/covers with CAS, and survive portable and exact recovery", async () => {
  const f = await fixture(),
    target = await fixture();
  try {
    const bytes = Buffer.from("scratch attachment 雨\0\xff"),
      a = await uploadAttachment(
        f.store.db,
        f.library.id,
        bytes,
        "雨.txt",
        "text/plain",
      );
    assert.deepEqual(
      await uploadAttachment(
        f.store.db,
        f.library.id,
        bytes,
        "different.pdf",
        "application/pdf",
      ),
      a,
    );
    assert.equal((await attachmentCatalog(f.store.db, f.library.id)).length, 1);
    assert.deepEqual(
      (await downloadAttachment(f.store.db, f.library.id, a.sha256)).bytes,
      bytes,
    );
    const foreign = await f.store.createLibrary("Another");
    await assert.rejects(downloadAttachment(f.store.db, foreign.id, a.sha256), {
      status: 404,
    });
    const cover = await attachToRecord(f.store.db, f.book.id, {
      sha256: a.sha256,
      expectedUpdatedAt: f.book.updatedAt,
    });
    assert.equal(cover.coverAttachment, a.sha256);
    await assert.rejects(
      attachToRecord(f.store.db, f.book.id, {
        sha256: null,
        expectedUpdatedAt: f.book.updatedAt,
      }),
      { status: 409 },
    );
    const entry = await f.store.createEntry(f.book.id, {
      name: "File owner",
      entryType: "character",
    });
    const linked = await attachToRecord(
      f.store.db,
      f.book.id,
      { sha256: a.sha256, expectedUpdatedAt: entry.updatedAt },
      entry.id,
    );
    assert.deepEqual(linked.attachments, [a.sha256]);
    const catalog = await f.store.templates(f.library.id),
      template = catalog.templates.find(
        (t: any) => t.entryType === "character",
      )!;
    const fid = crypto.randomUUID(),
      stamp = new Date().toISOString();
    await f.store.db.query("INSERT INTO bible_fields VALUES($1,$2,$3,$4)", [
      fid,
      f.library.id,
      template.id,
      {
        id: fid,
        templateId: template.id,
        key: "file",
        label: "File",
        fieldType: "attachment",
        required: false,
        orderKey: "z",
        createdAt: stamp,
        updatedAt: stamp,
      },
    ]);
    const bound = await f.store.editEntryField(f.book.id, entry.id, {
      templateId: template.id,
      expectedUpdatedAt: linked.updatedAt,
      expectedTemplateUpdatedAt: template.updatedAt,
    });
    const valued = await f.store.editEntryField(
      f.book.id,
      entry.id,
      {
        value: a.sha256,
        mode: "canon",
        expectedUpdatedAt: bound.updatedAt,
        expectedFieldUpdatedAt: stamp,
      },
      fid,
    );
    assert.equal(valued.values[fid], a.sha256);
    await assert.rejects(
      f.store.editEntryField(
        f.book.id,
        entry.id,
        {
          value: "f".repeat(64),
          mode: "canon",
          expectedUpdatedAt: valued.updatedAt,
          expectedFieldUpdatedAt: stamp,
        },
        fid,
      ),
      { status: 400 },
    );
    const out = await exportPortable(f.store, f.library.id),
      s = readArchive(out);
    assert.equal(s.books[0].coverAttachment, a.sha256);
    assert.deepEqual(s.blobs.get(a.sha256), bytes);
    const installer = new PortableImports(target.store),
      p = await installer.preview(out);
    await installer.commit(p.id, { mode: "new" });
    assert.deepEqual(
      (await downloadAttachment(target.store.db, f.library.id, a.sha256)).bytes,
      bytes,
    );
    const backup = await f.store.db.transaction((q) =>
      captureLibrary(q, f.library.id),
    );
    await target.store.db.transaction(async (q) => {
      for (const t of [...backupTables].reverse()) await q("DELETE FROM " + t);
      await restoreBookBackup(q, backup);
    });
    assert.deepEqual(
      (
        await target.store.db.transaction((q) =>
          captureLibrary(q, f.library.id),
        )
      ).tables,
      backup.tables,
    );
    await target.store.db.query(
      "UPDATE library_attachments SET content_base64=$1 WHERE library_id=$2",
      [Buffer.from("damaged").toString("base64"), f.library.id],
    );
    await assert.rejects(
      downloadAttachment(target.store.db, f.library.id, a.sha256),
      { code: "ATTACHMENT_CHECKSUM" },
    );
  } finally {
    await f.pg.close();
    await target.pg.close();
  }
});
test("failed archive installation rolls back every inserted table, leaving the original library unchanged", async () => {
  const f = await fixture();
  try {
    const original = await f.store.db.transaction((q) =>
      captureLibrary(q, f.library.id),
    );
    const broken = new StudioStore({
      query: f.store.db.query,
      transaction: (fn) =>
        f.store.db.transaction((q) =>
          fn((sql, p) => {
            if (sql.startsWith("INSERT INTO documents"))
              throw Error("injected insert failure");
            return q(sql, p);
          }),
        ),
    });
    const { readFile } = await import("node:fs/promises");
    const bytes = await readFile(
      new URL(
        "../fixtures/archives/valid/unknown-optional-fields.rolltop",
        import.meta.url,
      ),
    );
    const imports = new PortableImports(broken),
      p = await imports.preview(bytes);
    await assert.rejects(imports.commit(p.id, { mode: "new" }), /injected/);
    assert.equal((await f.store.libraries()).length, 1);
    assert.deepEqual(
      (await f.store.db.transaction((q) => captureLibrary(q, f.library.id)))
        .tables,
      original.tables,
    );
  } finally {
    await f.pg.close();
  }
});
test("100,000-word portable export retains exact Unicode and reimports into a separate database", async () => {
  const f = await fixture(),
    target = await fixture();
  try {
    const current = await f.store.document(f.scene.id),
      doc = structuredClone(current.document);
    const text = "雨 café 🖋️ ".repeat(50000);
    if (doc.blocks[0].type === "paragraph")
      doc.blocks[0].content = [{ type: "text", text }];
    await f.store.save(f.scene.id, doc, current.revision);
    const bytes = await exportPortable(f.store, f.library.id),
      s = readArchive(bytes);
    assert.deepEqual(s.documents.get(f.scene.id), doc);
    const imports = new PortableImports(target.store),
      p = await imports.preview(bytes);
    assert.ok(p.words >= 100000);
    await imports.commit(p.id, { mode: "new" });
    assert.deepEqual((await target.store.document(f.scene.id)).document, doc);
  } finally {
    await f.pg.close();
    await target.pg.close();
  }
});
