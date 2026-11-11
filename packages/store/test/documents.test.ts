import { test } from "node:test";
import assert from "node:assert/strict";
import { StoreError } from "../src/index.ts";
import { scratch, seedBook, doc, uuid, T0 } from "./helpers.ts";

const code = (c: string) => (e: unknown) => e instanceof StoreError && e.code === c;

async function setup() {
  const s = await scratch({ migrated: true });
  const book = await seedBook(s);
  const chapter = uuid(), scene = uuid();
  await s.store.insertNode({ id: chapter, bookId: book, kind: "chapter", title: "C", orderKey: "a1", createdAt: T0 });
  await s.store.insertNode({ id: scene, bookId: book, kind: "scene", title: "S", parentId: chapter, orderKey: "a1", createdAt: T0 });
  return { s, book, chapter, scene };
}

test("create then save moves revision 1 to 2 and keeps both revision rows", async () => {
  const { s, scene } = await setup();
  try {
    const created = await s.store.createDocument(scene, doc(scene, "one"));
    assert.equal(created.revision, 1);
    const saved = await s.store.saveDocument(scene, 1, doc(scene, "two"));
    assert.equal(saved.revision, 2);
    const head = await s.store.readDocument(scene);
    assert.equal(head.revision, 2);
    assert.equal((head.document.blocks[0] as { content: { text: string }[] }).content[0]!.text, "two");
    const rows = await s.pool.query("SELECT revision FROM document_revision WHERE node_id=$1 ORDER BY revision", [scene]);
    assert.deepEqual(rows.rows.map((r) => r.revision), [1, 2]);
    assert.equal((await s.store.checkIntegrity()).ok, true);
  } finally { await s.drop(); }
});

test("a second create on the same node is a CONFLICT", async () => {
  const { s, scene } = await setup();
  try {
    await s.store.createDocument(scene, doc(scene));
    await assert.rejects(s.store.createDocument(scene, doc(scene)), code("CONFLICT"));
  } finally { await s.drop(); }
});

test("a stale save is rejected with CONFLICT, reports the current revision and leaves the document alone", async () => {
  const { s, scene } = await setup();
  try {
    await s.store.createDocument(scene, doc(scene, "one"));
    await s.store.saveDocument(scene, 1, doc(scene, "two"));
    await assert.rejects(s.store.saveDocument(scene, 1, doc(scene, "stale")), (e) => {
      assert.ok(code("CONFLICT")(e));
      assert.deepEqual((e as StoreError).details, { nodeId: scene, expected: 1, current: 2 });
      assert.ok(!(e as Error).message.includes("stale"), "no document text in the message");
      return true;
    });
    const head = await s.store.readDocument(scene);
    assert.equal(head.revision, 2);
    assert.equal((head.document.blocks[0] as { content: { text: string }[] }).content[0]!.text, "two");
    assert.equal((await s.pool.query("SELECT count(*)::int AS n FROM document_revision")).rows[0].n, 2);
  } finally { await s.drop(); }
});

test("two concurrent saves from the same revision: exactly one wins", async () => {
  const { s, scene } = await setup();
  try {
    await s.store.createDocument(scene, doc(scene, "base"));
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => s.store.saveDocument(scene, 1, doc(scene, `w${i}`))));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    for (const r of results) if (r.status === "rejected") assert.ok(code("CONFLICT")(r.reason));
    assert.equal((await s.store.readDocument(scene)).revision, 2);
    assert.equal((await s.store.checkIntegrity()).ok, true);
  } finally { await s.drop(); }
});

test("invalid documents and mismatched node ids are DOCUMENT_INVALID", async () => {
  const { s, scene } = await setup();
  try {
    await assert.rejects(s.store.createDocument(scene, { nope: true }), code("DOCUMENT_INVALID"));
    await assert.rejects(s.store.createDocument(scene, doc(uuid())), code("DOCUMENT_INVALID"));
    await assert.rejects(s.store.readDocument(scene), code("NOT_FOUND"));
    await assert.rejects(s.store.saveDocument(scene, 0, doc(scene)), code("INVARIANT_VIOLATED"));
  } finally { await s.drop(); }
});

test("document_revision rows cannot be updated, deleted or truncated", async () => {
  const { s, scene } = await setup();
  try {
    await s.store.createDocument(scene, doc(scene));
    for (const sql of [
      "UPDATE document_revision SET revision = 5",
      "UPDATE document_revision SET document = '{}'::jsonb",
      "DELETE FROM document_revision",
      "TRUNCATE document_revision",
    ]) {
      await assert.rejects(s.pool.query(sql), /document_revision rows are immutable/, sql);
    }
    assert.equal((await s.pool.query("SELECT count(*)::int AS n FROM document_revision")).rows[0].n, 1);
  } finally { await s.drop(); }
});

test("a tombstoned node disappears from listLiveNodes and cannot be saved", async () => {
  const { s, book, chapter, scene } = await setup();
  try {
    await s.store.createDocument(scene, doc(scene));
    assert.deepEqual((await s.store.listLiveNodes(book)).map((n) => n.id), [chapter, scene]);
    await s.store.tombstoneNode(scene, T0);
    await s.store.tombstoneNode(scene, new Date("2027-01-01T00:00:00Z")); // idempotent
    assert.deepEqual((await s.store.listLiveNodes(book)).map((n) => n.id), [chapter]);
    assert.equal((await s.pool.query("SELECT deleted_at FROM manuscript_node WHERE id=$1", [scene])).rows[0].deleted_at.toISOString(), T0.toISOString());
    await assert.rejects(s.store.saveDocument(scene, 1, doc(scene, "x")), code("NOT_FOUND"));
    await assert.rejects(s.store.tombstoneNode(uuid()), code("NOT_FOUND"));
  } finally { await s.drop(); }
});

test("an aborted signal stops a save before it writes", async () => {
  const { s, scene } = await setup();
  try {
    await s.store.createDocument(scene, doc(scene));
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(s.store.saveDocument(scene, 1, doc(scene, "x"), ac.signal), { name: "AbortError" });
    assert.equal((await s.store.readDocument(scene)).revision, 1);
  } finally { await s.drop(); }
});

test("lone surrogates are DOCUMENT_INVALID without echoing document text, and never reach PostgreSQL", async () => {
  const { s, scene } = await setup();
  try {
    const bad = doc(scene, "secret-text \ud800 more");
    await assert.rejects(s.store.createDocument(scene, bad), (e) => {
      assert.ok(code("DOCUMENT_INVALID")(e));
      assert.ok(!(e as Error).message.includes("secret-text"));
      return true;
    });
    await s.store.createDocument(scene, doc(scene));
    await assert.rejects(s.store.saveDocument(scene, 1, bad), code("DOCUMENT_INVALID"));
    assert.equal((await s.store.readDocument(scene)).revision, 1);
  } finally { await s.drop(); }
});

test("a data-exception SQLSTATE from the database becomes a typed error with no raw detail", async () => {
  const { mapPgError } = await import("../src/errors.ts");
  const raw = Object.assign(new Error('invalid input syntax: "secret-text"'), { code: "22P05", detail: "secret-text", where: "secret-text" });
  const mapped = mapPgError(raw) as StoreError;
  assert.ok(mapped instanceof StoreError);
  assert.equal(mapped.code, "INVARIANT_VIOLATED");
  assert.ok(!JSON.stringify(mapped.details).includes("secret") && !mapped.message.includes("secret"));
  const operational = Object.assign(new Error("down"), { code: "57P01" });
  assert.equal(mapPgError(operational), operational);
});

test("a not-null violation is INVARIANT_VIOLATED and does not echo the row", async () => {
  const { s, book } = await setup();
  try {
    const { mapPgError } = await import("../src/errors.ts");
    let raw: unknown;
    try {
      await s.pool.query("INSERT INTO manuscript_node (id, book_id, kind, title, order_key, created_at, updated_at) VALUES ($1,$2,'part',NULL,'a1',now(),now())", [uuid(), book]);
    } catch (e) { raw = e; }
    assert.equal((raw as { code?: string }).code, "23502");
    const mapped = mapPgError(raw) as StoreError;
    assert.ok(code("INVARIANT_VIOLATED")(mapped));
    assert.equal(mapped.message, "INVARIANT_VIOLATED: a required value is missing");
  } finally { await s.drop(); }
});

test("a deleted chapter hides its scenes (list, read, save, create); restoring it restores them", async () => {
  const { s, book, chapter, scene } = await setup();
  try {
    const scene2 = uuid();
    await s.store.insertNode({ id: scene2, bookId: book, kind: "scene", title: "S2", parentId: chapter, orderKey: "a2", createdAt: T0 });
    await s.store.createDocument(scene, doc(scene));
    await s.store.tombstoneNode(chapter, T0);
    await s.store.tombstoneNode(chapter, T0); // idempotent
    assert.deepEqual(await s.store.listLiveNodes(book), []);
    await assert.rejects(s.store.readDocument(scene), code("NOT_FOUND"));
    await assert.rejects(s.store.saveDocument(scene, 1, doc(scene, "x")), code("NOT_FOUND"));
    await assert.rejects(s.store.createDocument(scene2, doc(scene2)), code("NOT_FOUND"));
    const kids = await s.pool.query("SELECT count(*)::int AS n FROM manuscript_node WHERE parent_id=$1 AND deleted_at IS NOT NULL", [chapter]);
    assert.equal(kids.rows[0].n, 0, "children are hidden by ancestry, not written");
    await s.pool.query("UPDATE manuscript_node SET deleted_at = NULL WHERE id=$1", [chapter]);
    assert.deepEqual((await s.store.listLiveNodes(book)).map((n) => n.id), [chapter, scene, scene2]);
    assert.equal((await s.store.readDocument(scene)).revision, 1);
    assert.equal((await s.store.saveDocument(scene, 1, doc(scene, "back"))).revision, 2);
    await s.store.createDocument(scene2, doc(scene2));
  } finally { await s.drop(); }
});

test("a deleted part hides its chapter and that chapter's scenes, two levels down", async () => {
  const { s, book, scene: _ } = await setup();
  try {
    const part = uuid(), ch = uuid(), sc = uuid();
    await s.store.insertNode({ id: part, bookId: book, kind: "part", title: "P", orderKey: "b1", createdAt: T0 });
    await s.store.insertNode({ id: ch, bookId: book, kind: "chapter", title: "C", parentId: part, orderKey: "a1", createdAt: T0 });
    await s.store.insertNode({ id: sc, bookId: book, kind: "scene", title: "S", parentId: ch, orderKey: "a1", createdAt: T0 });
    await s.store.createDocument(sc, doc(sc));
    assert.ok((await s.store.listLiveNodes(book)).some((n) => n.id === sc));
    await s.store.tombstoneNode(part, T0);
    const ids = (await s.store.listLiveNodes(book)).map((n) => n.id);
    assert.ok(!ids.includes(part) && !ids.includes(ch) && !ids.includes(sc));
    await assert.rejects(s.store.readDocument(sc), code("NOT_FOUND"));
    await assert.rejects(s.store.saveDocument(sc, 1, doc(sc, "x")), code("NOT_FOUND"));
    await s.pool.query("UPDATE manuscript_node SET deleted_at = NULL WHERE id=$1", [part]);
    assert.ok((await s.store.listLiveNodes(book)).some((n) => n.id === sc));
  } finally { await s.drop(); }
});

test("NUL in document text is DOCUMENT_INVALID before it reaches PostgreSQL", async () => {
  const { s, scene } = await setup();
  try {
    await assert.rejects(s.store.createDocument(scene, doc(scene, "a\u0000b")), (e) => {
      assert.ok(code("DOCUMENT_INVALID")(e));
      return true;
    });
    await assert.rejects(s.store.readDocument(scene), code("NOT_FOUND"));
  } finally { await s.drop(); }
});

test("NUL in a link href (not covered by the adapter's control-character rule) is DOCUMENT_INVALID", async () => {
  const { s, scene } = await setup();
  try {
    const d = doc(scene) as { blocks: { content: unknown[] }[] };
    d.blocks[0]!.content = [{ type: "text", text: "x", marks: [{ type: "link", href: "http://a\u0000b" }] }];
    await assert.rejects(s.store.createDocument(scene, d), code("DOCUMENT_INVALID"));
  } finally { await s.drop(); }
});
