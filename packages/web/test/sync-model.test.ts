// The local model built from the change feed, and the rules the client relies on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyChange, emptyModel, FeedError, outline, sceneDocument, sceneIsLive } from "../src/sync/model.ts";
import type { SyncChange } from "../src/sync/model.ts";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let seq = 0;
const ch = (c: Partial<SyncChange> & { change: string; recordKind: string; recordId: string }): SyncChange =>
  ({ seq: ++seq, at: "2026-11-11T12:00:00Z", opId: U(900 + seq), deviceId: U(800), ...c });

test("changes apply in order into records, documents and trash; a gap is refused", () => {
  seq = 0;
  const m = emptyModel();
  applyChange(m, ch({ change: "create", recordKind: "library", recordId: U(1), value: { id: U(1), title: "L" } }));
  applyChange(m, ch({ change: "create", recordKind: "book", recordId: U(2), value: { id: U(2), title: "B", orderKey: "m" } }));
  applyChange(m, ch({ change: "create", recordKind: "manuscriptNode", recordId: U(3), value: { id: U(3), bookId: U(2), kind: "chapter", title: "C", orderKey: "m" } }));
  applyChange(m, ch({ change: "create", recordKind: "manuscriptNode", recordId: U(4), value: { id: U(4), bookId: U(2), parentId: U(3), kind: "scene", title: "S", orderKey: "m" } }));
  applyChange(m, ch({ change: "document", recordKind: "document", recordId: U(4), revision: 1, value: { blocks: [] } }));
  assert.equal(m.sawLibraryCreate, true);
  assert.equal(sceneDocument(m, U(4)).revision, 1);
  assert.deepEqual(outline(m, U(2)).map((i) => [i.node.title, i.depth, i.hasDocument]), [["C", 0, false], ["S", 1, true]]);
  applyChange(m, ch({ change: "set", recordKind: "manuscriptNode", recordId: U(4), field: "title", value: "Renamed" }));
  assert.equal(m.records.get("manuscriptNode")!.get(U(4))!.title, "Renamed");
  applyChange(m, ch({ change: "tombstone", recordKind: "manuscriptNode", recordId: U(3) }));
  assert.equal(sceneIsLive(m, U(4)), false); // a trashed parent hides the scene
  assert.equal(outline(m, U(2)).length, 0);
  applyChange(m, ch({ change: "restore", recordKind: "manuscriptNode", recordId: U(3) }));
  assert.equal(sceneIsLive(m, U(4)), true);
  seq += 1; // a gap
  assert.throws(() => applyChange(m, ch({ change: "restore", recordKind: "manuscriptNode", recordId: U(3) })), FeedError);
});

test("an imported library shows no library create in the feed", () => {
  const m = emptyModel();
  assert.equal(m.sawLibraryCreate, false);
  assert.equal(sceneDocument(m, U(9)).revision, 0);
});

test("a document change older than the revision already held is ignored, but the cursor still moves (a pull that started before a save)", () => {
  seq = 0;
  const m = emptyModel();
  applyChange(m, ch({ change: "document", recordKind: "document", recordId: U(4), revision: 2, value: { text: "second" } }));
  m.docs.set(U(4), { revision: 3, seq: 0, doc: { text: "saved just now" } }); // a save was applied
  applyChange(m, ch({ change: "document", recordKind: "document", recordId: U(4), revision: 2, value: { text: "second" } }));
  assert.equal(m.docs.get(U(4))!.revision, 3);
  assert.deepEqual(m.docs.get(U(4))!.doc, { text: "saved just now" });
  assert.equal(m.cursor, 2);
  applyChange(m, ch({ change: "document", recordKind: "document", recordId: U(4), revision: 3, value: { text: "saved just now" } })); // the same revision settles its real seq
  assert.equal(m.docs.get(U(4))!.seq, 3);
});
