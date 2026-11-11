import { test } from "node:test";
import assert from "node:assert/strict";
import { StoreError } from "../src/index.ts";
import type { NodeKind } from "../src/index.ts";
import { scratch, seedBook, doc, uuid, T0 } from "./helpers.ts";

const violation = (e: unknown) => e instanceof StoreError && e.code === "INVARIANT_VIOLATED";
const rejects = (p: Promise<unknown>, re: RegExp) =>
  assert.rejects(p, (e) => { assert.ok(violation(e), String(e)); assert.match((e as Error).message, re); return true; });

async function setup() {
  const s = await scratch({ migrated: true });
  const book = await seedBook(s);
  const add = async (kind: NodeKind, parentId?: string, bookId = book) => {
    const id = uuid();
    await s.store.insertNode({ id, bookId, kind, title: kind, parentId, orderKey: "a1", createdAt: T0 });
    return id;
  };
  return { s, book, add };
}

test("hierarchy: valid shapes are accepted", async () => {
  const { s, add } = await setup();
  try {
    const part = await add("part");
    const chapterInPart = await add("chapter", part);
    await add("chapter");
    await add("scene", chapterInPart);
    await add("frontMatter");
    await add("backMatter");
  } finally { await s.drop(); }
});

test("hierarchy: each rule rejects", async () => {
  const { s, book, add } = await setup();
  try {
    const part = await add("part");
    const chapter = await add("chapter", part);
    const scene = await add("scene", chapter);
    const ins = (kind: NodeKind, parentId?: string, bookId = book) =>
      s.store.insertNode({ id: uuid(), bookId, kind, title: "x", parentId, orderKey: "a1", createdAt: T0 });
    await rejects(ins("part", part), /sit at the book root/);
    await rejects(ins("frontMatter", chapter), /sit at the book root/);
    await rejects(ins("backMatter", part), /sit at the book root/);
    await rejects(ins("chapter", chapter), /chapter sits at the book root or under a part/);
    await rejects(ins("chapter", scene), /chapter sits at the book root or under a part/);
    await rejects(ins("scene"), /scene sits under a chapter/);
    await rejects(ins("scene", part), /scene sits under a chapter/);
    // same book
    const other = uuid();
    await s.store.insertBook({ id: other, title: "Other", orderKey: "a2", createdAt: T0 });
    await rejects(ins("chapter", part, other), /same-book/);
    // a node with children cannot change kind or book (root chapter: the hierarchy rule alone would allow both)
    const rootChapter = await add("chapter");
    await add("scene", rootChapter);
    await assert.rejects(s.pool.query("UPDATE manuscript_node SET kind='part' WHERE id=$1", [rootChapter]), /children cannot change kind or book/);
    await assert.rejects(s.pool.query("UPDATE manuscript_node SET book_id=$1 WHERE id=$2", [other, rootChapter]), /children cannot change kind or book/);
    // a node without children may change kind validly
    const lone = await add("chapter");
    await s.pool.query("UPDATE manuscript_node SET kind='frontMatter' WHERE id=$1", [lone]);
  } finally { await s.drop(); }
});

test("a node with a document cannot become a chapter or part; documents only on scene and matter", async () => {
  const { s, add } = await setup();
  try {
    const chapter = await add("chapter");
    const scene = await add("scene", chapter);
    const front = await add("frontMatter");
    await s.store.createDocument(scene, doc(scene));
    await s.store.createDocument(front, doc(front));
    await assert.rejects(s.pool.query("UPDATE manuscript_node SET kind='chapter', parent_id=NULL WHERE id=$1", [scene]), /cannot become a part or chapter/);
    await assert.rejects(s.pool.query("UPDATE manuscript_node SET kind='part' WHERE id=$1", [front]), /cannot become a part or chapter/);
    await rejects(s.store.createDocument(chapter, doc(chapter)), /only scenes, front matter and back matter/);
    const back = await add("backMatter");
    await s.store.createDocument(back, doc(back));
  } finally { await s.drop(); }
});

test("order_key shape is enforced", async () => {
  const { s, book } = await setup();
  try {
    for (const bad of ["", "A1", "a0", "a-1", "a b"]) {
      await assert.rejects(
        s.store.insertNode({ id: uuid(), bookId: book, kind: "part", title: "p", orderKey: bad, createdAt: T0 }),
        violation, `order key ${JSON.stringify(bad)}`);
    }
  } finally { await s.drop(); }
});

test("a single library per database", async () => {
  const { s } = await setup();
  try {
    await assert.rejects(s.store.insertLibrary({ id: uuid(), title: "Second", createdAt: T0 }), violation);
  } finally { await s.drop(); }
});

test("book and series universes must agree", async () => {
  const s = await scratch({ migrated: true });
  try {
    const u1 = uuid(), u2 = uuid(), series = uuid(), loose = uuid();
    await s.store.insertUniverse({ id: u1, title: "U1", orderKey: "a1", createdAt: T0 });
    await s.store.insertUniverse({ id: u2, title: "U2", orderKey: "a2", createdAt: T0 });
    await s.store.insertSeries({ id: series, universeId: u1, title: "S", orderKey: "a1", createdAt: T0 });
    const book = (extra: object) => s.store.insertBook({ id: uuid(), title: "B", orderKey: "a1", createdAt: T0, ...extra });
    await book({ seriesId: series, universeId: u1 }); // valid
    await rejects(book({ seriesId: series, universeId: u2 }), /universe-match/);
    await rejects(book({ seriesId: series }), /universe-match/); // IS DISTINCT FROM: NULL differs from u1
    // series without a universe accepts any book universe
    await s.store.insertSeries({ id: loose, title: "Loose", orderKey: "a2", createdAt: T0 });
    await book({ seriesId: loose, universeId: u2 });
    await book({ seriesId: loose });
    // book update
    const b = uuid();
    await s.store.insertBook({ id: b, title: "B", orderKey: "a3", createdAt: T0 });
    await s.pool.query("UPDATE book SET series_id=$1, universe_id=$2 WHERE id=$3", [series, u1, b]);
    await assert.rejects(s.pool.query("UPDATE book SET universe_id=$1 WHERE id=$2", [u2, b]), /universe-match/);
    // series update: rejected while a book disagrees, accepted when it still agrees
    await assert.rejects(s.pool.query("UPDATE series SET universe_id=$1 WHERE id=$2", [u2, series]), /universe-match/);
    await s.pool.query("UPDATE series SET universe_id=$1 WHERE id=$2", [u1, series]);
    const empty = uuid();
    await s.store.insertSeries({ id: empty, universeId: u1, title: "E", orderKey: "a3", createdAt: T0 });
    await s.pool.query("UPDATE series SET universe_id=$1 WHERE id=$2", [u2, empty]);
  } finally { await s.drop(); }
});
