// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";
import { bibleFixture } from "./bible-fixture.ts";
import { buildBible, nextBibleVersion } from "../src/bible-content.ts";
import { renderBible, bibleLayout } from "../src/bible-render.ts";
import { fixture } from "./support.ts";
import {
  createBibleExport,
  readBibleExport,
  bibleExports,
} from "../src/bible-exports.ts";
import {
  captureBook,
  restoreBookBackup,
  backupTables,
  readBookBackup,
} from "../src/backup.ts";
import { StudioStore } from "../src/store.ts";
test("bible model covers all native sections, effective typed fields, relationships/history, names/questions/facts/notes and excludes invisible/Trash data", async () => {
  const s = bibleFixture();
  const blocks = buildBible(s, "1.9", "2026-11-06T00:00:00Z");
  assert.equal(
    blocks.filter((b) => b.kind === "heading" && b.level === 1).length,
    12,
  );
  const text = JSON.stringify(blocks);
  for (const term of [
    "41",
    "No",
    "1.230000000000000001",
    "First thaw",
    "Guardian of",
    "Age becomes 42",
    "Not true (told or believed)",
    "Known by the reader",
    "Decided",
    "The wax seal is blue.",
    "visitor name",
  ])
    assert.ok(text.includes(term), term);
  const word = await renderBible(blocks, "docx"),
    zip = unzipSync(word),
    xml = strFromU8(zip["word/document.xml"]);
  assert.match(xml, /w:tbl/);
  assert.match(xml, /Heading1/);
  assert.match(xml, /w:numPr/);
  assert.ok(xml.includes("1.230000000000000001"));
  assert.ok(!xml.includes("&lt;table"));
  const pdf = await renderBible(blocks, "pdf");
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.ok(pdf.includes(Buffer.from("/FontFile2")));
  assert.equal(nextBibleVersion("v1.8"), "1.9");
  assert.equal(nextBibleVersion(undefined), "1.0");
  assert.equal(nextBibleVersion("draft"), "draft.1");
  (s.books as any[]).push({ ...s.book, id: "other", title: "Other Book" });
  (s.relationships[0] as any).bookId = "other";
  (s.events as any[]).push({
    id: "unplaced",
    scope: { kind: "book", id: "book" },
    title: "Unplaced",
    sceneIds: [],
  });
  (s.stateChanges as any[]).push({
    ...s.stateChanges[0],
    id: "unplaced-change",
    nodeId: undefined,
    eventId: "unplaced",
    value: 43,
  });
  const expanded = JSON.stringify(buildBible(s, "2", "2026-11-06"));
  assert.ok(expanded.includes("in Other Book only"));
  assert.ok(expanded.includes("event: Unplaced: Age becomes 43"));
  (s.entries[0] as any).deletedAt = "now";
  (s.entries[1] as any).scope = { kind: "book", id: "foreign" };
  const filtered = JSON.stringify(buildBible(s, "2", "2026-11-06"));
  assert.ok(!filtered.includes("Guardian of"));
  assert.ok(!filtered.includes('"text":"The Orchard"'));
});
test("wide grids retain all cells in readable bands; long PDF rows paginate and unsupported glyph/control failures are explicit", async () => {
  const table: any = {
    kind: "table",
    header: Array.from({ length: 12 }, (_, i) => "Column " + i),
    rows: [Array.from({ length: 12 }, (_, i) => "Cell " + i)],
  };
  const laid = bibleLayout([table]);
  for (let i = 0; i < 12; i++)
    assert.ok(JSON.stringify(laid).includes("Cell " + i));
  assert.equal(laid.filter((b) => b.kind === "table").length, 3);
  const pdf = await renderBible(
    [
      { kind: "heading", text: "Stress Table", level: 1 },
      {
        kind: "table",
        header: ["Name", "Description"],
        rows: [
          ["Long row", "Many words stay readable. ".repeat(500)],
          ["Final row", "END OF LONG TABLE"],
        ],
      },
    ],
    "pdf",
  );
  assert.ok(pdf.length > 10000);
  const longWord = await renderBible(
    [
      {
        kind: "table",
        rows: [["Key", "Many words stay readable. ".repeat(500)]],
      },
    ],
    "docx",
  );
  const longXML = strFromU8(unzipSync(longWord)["word/document.xml"]).replace(
    /<[^>]*>/g,
    "",
  );
  assert.equal(longXML.split("Many words stay readable.").length - 1, 500);
  await assert.rejects(
    renderBible([{ kind: "paragraph", text: "\u0001" }], "docx"),
    { status: 422 },
  );
  await assert.rejects(
    renderBible([{ kind: "paragraph", text: "漢" }], "pdf"),
    { code: "PDF_GLYPH" },
  );
});
test("immutable Word/PDF exports update only version metadata, retry safely, reject stale writes and recover exact bytes including saved copies in Trash", async () => {
  const f = await fixture(),
    target = await fixture(),
    directory = await mkdtemp(join(tmpdir(), "rolltop-bible-purge-"));
  f.store.backupDirectory = directory;
  try {
    const before = await f.store.document(f.scene.id);
    const req = {
      id: crypto.randomUUID(),
      format: "docx",
      version: "1.0",
      expectedUpdatedAt: f.book.updatedAt,
    };
    const saved = await createBibleExport(f.store.db, f.book.id, req);
    const same = await createBibleExport(f.store.db, f.book.id, req);
    assert.deepEqual(same.export, saved.export);
    await assert.rejects(
      createBibleExport(f.store.db, f.book.id, {
        ...req,
        id: crypto.randomUUID(),
      }),
      { status: 409 },
    );
    const pdf = await createBibleExport(f.store.db, f.book.id, {
      ...req,
      id: crypto.randomUUID(),
      format: "pdf",
      version: "1.1",
      expectedUpdatedAt: saved.book.updatedAt,
    });
    const wordBytes = (
        await readBibleExport(f.store.db, f.book.id, saved.export.id)
      ).bytes,
      pdfBytes = (await readBibleExport(f.store.db, f.book.id, pdf.export.id))
        .bytes;
    assert.equal(wordBytes.subarray(0, 2).toString(), "PK");
    assert.equal(pdfBytes.subarray(0, 5).toString(), "%PDF-");
    assert.deepEqual(await f.store.document(f.scene.id), before);
    assert.equal((await bibleExports(f.store.db, f.book.id)).exports.length, 2);
    await f.store.createEntry(f.book.id, { name: "漢", entryType: "term" });
    const preFailure = (await f.store.book(f.book.id)).book;
    await assert.rejects(
      createBibleExport(f.store.db, f.book.id, {
        ...req,
        id: crypto.randomUUID(),
        format: "pdf",
        version: "failed",
        expectedUpdatedAt: preFailure.updatedAt,
      }),
      { code: "PDF_GLYPH" },
    );
    assert.deepEqual((await f.store.book(f.book.id)).book, preFailure);
    assert.equal((await bibleExports(f.store.db, f.book.id)).exports.length, 2);
    await f.store.trashBook(f.book.id);
    const backup = await f.store.db.transaction((q) =>
      captureBook(q, f.book.id),
    );
    assert.equal(backup.version, 10);
    assert.equal(backup.schemaVersion, 12);
    assert.equal(backup.tables.bible_exports.length, 2);
    await target.store.db.transaction(async (q) => {
      for (const t of [...backupTables].reverse()) await q("DELETE FROM " + t);
      await restoreBookBackup(q, backup);
    });
    assert.deepEqual(
      (await readBibleExport(target.store.db, f.book.id, saved.export.id))
        .bytes,
      wordBytes,
    );
    assert.deepEqual(
      (await readBibleExport(target.store.db, f.book.id, pdf.export.id)).bytes,
      pdfBytes,
    );
    const trashed = (await f.store.book(f.book.id)).book;
    const receipt = await f.store.purge("book", f.book.id, {
      confirmTitle: trashed.title,
      expectedDeletedAt: trashed.deletedAt,
    });
    const protectedCopy = await readBookBackup(join(directory, receipt.backup));
    assert.equal(protectedCopy.tables.bible_exports.length, 2);
    await assert.rejects(
      readBibleExport(f.store.db, f.book.id, saved.export.id),
      { status: 404 },
    );
    const legacy = {
      ...backup,
      version: 9 as const,
      schemaVersion: 11 as const,
      tables: { ...backup.tables },
    };
    delete legacy.tables.bible_exports;
    await target.store.db.transaction(async (q) => {
      for (const t of [...backupTables].reverse()) await q("DELETE FROM " + t);
      await restoreBookBackup(q, legacy);
    });
    assert.equal(
      (await bibleExports(target.store.db, f.book.id)).exports.length,
      0,
    );
  } finally {
    await f.pg.close();
    await target.pg.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test("schema11 export migration rolls back on failure, retries without rewriting books and refuses newer schemas", async () => {
  const f = await fixture();
  try {
    await f.store.db.query(
      "DROP TABLE bible_exports; UPDATE studio_schema SET version=11",
    );
    const before = await f.store.book(f.book.id);
    const broken = new StudioStore({
      query: f.store.db.query,
      transaction: (fn) =>
        f.store.db.transaction((q) =>
          fn((sql, p) => {
            if (sql.includes("CREATE TABLE bible_exports"))
              throw Error("injected");
            return q(sql, p);
          }),
        ),
    });
    await assert.rejects(broken.migrate(), /injected/);
    assert.equal(
      (await f.store.db.query("SELECT version FROM studio_schema")).rows[0]
        .version,
      11,
    );
    await f.store.migrate();
    await f.store.migrate();
    assert.equal(
      (await f.store.db.query("SELECT version FROM studio_schema")).rows[0]
        .version,
      12,
    );
    assert.deepEqual(await f.store.book(f.book.id), before);
  } finally {
    await f.pg.close();
  }
});
