import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { StoreError } from "../src/index.ts";
import { scratch, T0, uuid, doc, seedBook } from "./helpers.ts";

const code = (c: string) => (e: unknown) => e instanceof StoreError && e.code === c;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const meta = { mediaType: "image/png", originalName: "a.png", extension: "png", createdAt: T0 };

test("attachments are stored by hash, deduplicated and read back", async () => {
  const s = await scratch({ migrated: true });
  try {
    const bytes = new TextEncoder().encode("pretend png");
    const rec = await s.store.putAttachment(bytes, meta);
    assert.equal(rec.sha256, sha(bytes));
    assert.equal(rec.byteLength, bytes.length);
    await s.store.putAttachment(bytes, meta); // idempotent
    assert.equal((await s.pool.query("SELECT count(*)::int AS n FROM attachment")).rows[0].n, 1);
    assert.deepEqual(await readdir(s.store.attachmentsDir), [rec.sha256], "no temp files left");
    const back = await s.store.readAttachment(rec.sha256);
    assert.deepEqual(Buffer.from(back.bytes), Buffer.from(bytes));
    assert.equal(back.mediaType, "image/png");
    await assert.rejects(s.store.readAttachment(sha(new Uint8Array([1]))), code("NOT_FOUND"));
  } finally { await s.drop(); }
});

test("a file holding different bytes is never overwritten", async () => {
  const s = await scratch({ migrated: true });
  try {
    const bytes = new TextEncoder().encode("real");
    const hash = sha(bytes);
    await s.store.putAttachment(new TextEncoder().encode("seed"), meta); // creates the directory
    await writeFile(join(s.store.attachmentsDir, hash), "tampered");
    await assert.rejects(s.store.putAttachment(bytes, meta), code("ATTACHMENT_HASH_MISMATCH"));
    assert.equal(await readFile(join(s.store.attachmentsDir, hash), "utf8"), "tampered");
  } finally { await s.drop(); }
});

test("reading a tampered file throws ATTACHMENT_HASH_MISMATCH", async () => {
  const s = await scratch({ migrated: true });
  try {
    const rec = await s.store.putAttachment(new TextEncoder().encode("data"), meta);
    await writeFile(join(s.store.attachmentsDir, rec.sha256), "other");
    await assert.rejects(s.store.readAttachment(rec.sha256), code("ATTACHMENT_HASH_MISMATCH"));
    await rm(join(s.store.attachmentsDir, rec.sha256));
    await assert.rejects(s.store.readAttachment(rec.sha256), code("INTEGRITY_FAILED"));
  } finally { await s.drop(); }
});

test("path-traversal shaped hashes are rejected before touching the file system", async () => {
  const s = await scratch({ migrated: true });
  try {
    for (const bad of ["../../etc/passwd", "a".repeat(63), "A".repeat(64), `${"a".repeat(60)}/../`, ""]) {
      await assert.rejects(s.store.readAttachment(bad), code("INVARIANT_VIOLATED"), bad);
    }
  } finally { await s.drop(); }
});

test("integrity passes on a healthy database and reports corruption", async () => {
  const s = await scratch({ migrated: true });
  try {
    const book = await seedBook(s);
    const node = uuid();
    await s.store.insertNode({ id: node, bookId: book, kind: "frontMatter", title: "F", orderKey: "a1", createdAt: T0 });
    await s.store.createDocument(node, doc(node));
    await s.store.saveDocument(node, 1, doc(node, "two"));
    const rec = await s.store.putAttachment(new TextEncoder().encode("good bytes"), meta);
    assert.deepEqual(await s.store.checkIntegrity(), { ok: true, problems: [] });

    // Corrupt the attachment file.
    await writeFile(join(s.store.attachmentsDir, rec.sha256), "bad bytes!");
    let report = await s.store.checkIntegrity();
    assert.equal(report.ok, false);
    assert.deepEqual(report.problems, [{ code: "ATTACHMENT_HASH_MISMATCH", id: rec.sha256 }]);
    await rm(join(s.store.attachmentsDir, rec.sha256));
    report = await s.store.checkIntegrity();
    assert.deepEqual(report.problems, [{ code: "ATTACHMENT_FILE_MISSING", id: rec.sha256 }]);
    await writeFile(join(s.store.attachmentsDir, rec.sha256), "good bytes");

    // Corrupt the database behind the store's back (triggers disabled in a scratch DB only).
    await s.pool.query("ALTER TABLE document_revision DISABLE TRIGGER USER");
    await s.pool.query("DELETE FROM document_revision WHERE node_id=$1 AND revision=1", [node]);
    report = await s.store.checkIntegrity();
    assert.deepEqual(report.problems.map((p) => p.code), ["REVISION_ROWS_NOT_CONTIGUOUS"]);
    await s.pool.query("UPDATE document_revision SET document = '{}'::jsonb WHERE node_id=$1 AND revision=2", [node]);
    report = await s.store.checkIntegrity();
    assert.ok(report.problems.some((p) => p.code === "HEAD_DOCUMENT_MISMATCH" && p.id === node));
    await s.pool.query("DELETE FROM document_revision WHERE node_id=$1", [node]);
    assert.ok((await s.store.checkIntegrity()).problems.some((p) => p.code === "HEAD_REVISION_ROW_MISSING"));
    // A real invalid index: CONCURRENTLY on duplicated data fails and leaves an invalid index behind.
    await s.pool.query("ALTER TABLE document_revision ENABLE TRIGGER USER");
    await s.pool.query("CREATE TABLE dup_probe (x int)");
    await s.pool.query("INSERT INTO dup_probe VALUES (1), (1)");
    await assert.rejects(s.pool.query("CREATE UNIQUE INDEX CONCURRENTLY dup_probe_x ON dup_probe (x)"), /could not create unique index/);
    assert.ok((await s.store.checkIntegrity()).problems.some((p) => p.code === "INVALID_INDEX" && p.id === "dup_probe_x"));
    await s.pool.query("DROP INDEX dup_probe_x");
    assert.ok(!(await s.store.checkIntegrity()).problems.some((p) => p.code === "INVALID_INDEX"));
  } finally { await s.drop(); }
});
