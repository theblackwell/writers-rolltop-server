// M1-10 slice 4: which continuity warnings show for a book, and the sentence for each kind (no browser, no server).
import { test } from "node:test";
import assert from "node:assert/strict";
import { appliesToBook, describeWarning, HEADINGS, warningsForBook } from "../src/sync/continuity.ts";
import { parseWarnings } from "../src/sync/http.ts";
import type { ContinuityWarning } from "../src/sync/http.ts";
import { emptyModel } from "../src/sync/model.ts";
import type { Model, Rec } from "../src/sync/model.ts";

const U = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const B1 = U(1), B2 = U(2), SERIES = U(3);
const put = (m: Model, kind: string, r: Rec) => { const k = m.records.get(kind) ?? new Map<string, Rec>(); m.records.set(kind, k); k.set(r.id, r); };

function model(): Model {
  const m = emptyModel();
  put(m, "book", { id: B1, title: "One", seriesId: SERIES });
  put(m, "book", { id: B2, title: "Two", seriesId: SERIES });
  put(m, "manuscriptNode", { id: U(10), bookId: B1, kind: "scene", title: "The bridge" });
  put(m, "manuscriptNode", { id: U(11), bookId: B1, kind: "scene", title: "The storm" });
  put(m, "manuscriptNode", { id: U(12), bookId: B1, kind: "chapter", title: "" });
  put(m, "manuscriptNode", { id: U(13), bookId: B1, kind: "part", title: " " });
  put(m, "manuscriptNode", { id: U(14), bookId: B1, kind: "scene", title: "Gone scene", deletedAt: "2026-11-12T00:00:00Z" });
  put(m, "manuscriptNode", { id: U(15), bookId: B1, kind: "chapter", title: "Gone chapter", deletedAt: "2026-11-12T00:00:00Z" });
  put(m, "manuscriptNode", { id: U(16), bookId: B1, kind: "scene", title: "Inside", parentId: U(15) });
  put(m, "entry", { id: U(20), name: "Mira Vale", entryType: "character", scope: { kind: "book", id: B1 } });
  put(m, "entry", { id: U(21), name: "Hollow Reach", entryType: "location", scope: { kind: "book", id: B1 } });
  put(m, "field", { id: U(30), label: "Home" });
  put(m, "fact", { id: U(40), text: "The bridge is old", scope: { kind: "book", id: B1 } });
  put(m, "fact", { id: U(41), text: "A series fact", scope: { kind: "series", id: SERIES } });
  put(m, "fact", { id: U(42), text: "Gone fact", scope: { kind: "book", id: B1 }, deletedAt: "2026-11-12T00:00:00Z" });
  put(m, "question", { id: U(50), text: "Who rang the bell?", scope: { kind: "book", id: B1 } });
  put(m, "event", { id: U(60), title: "The storm", scope: { kind: "book", id: B1 } });
  return m;
}
const w = (kind: ContinuityWarning["kind"], extra: Partial<ContinuityWarning> = {}): ContinuityWarning =>
  ({ key: `${kind}:x`, kind, recordKind: "fact", recordId: U(40), ...extra });

test("a warning with bookId holds in that book only", () => {
  assert.equal(appliesToBook({ bookId: B1 }, B1), true);
  assert.equal(appliesToBook({ bookId: B1 }, B2), false);
});

test("a warning with exceptBookIds holds in every book but those", () => {
  assert.equal(appliesToBook({ exceptBookIds: [B2] }, B1), true);
  assert.equal(appliesToBook({ exceptBookIds: [B2] }, B2), false);
  assert.equal(appliesToBook({ exceptBookIds: [] }, B2), true);
});

test("a warning with neither holds in every book in scope", () => {
  assert.equal(appliesToBook({}, B1), true);
  assert.equal(appliesToBook({}, B2), true);
});

test("the list for a book keeps what applies there, and only records that are live and in scope", () => {
  const m = model();
  const all = [
    w("undecidedButKnown", { bookId: B2, recordId: U(41) }),
    w("undecidedButKnown", { exceptBookIds: [B2], recordId: U(41) }),
    w("establishedInTrash", { recordId: U(40) }),
    w("establishedInTrash", { recordId: U(42) }), // trashed record
    w("establishedInTrash", { recordId: U(99) }), // not on this device yet
  ];
  assert.deepEqual(warningsForBook(m, all, B1).map((x) => `${x.recordId}`), [U(41), U(40)]);
  assert.deepEqual(warningsForBook(m, all, B2).map((x) => `${x.recordId}`), [U(41)], "the series fact shows in book two through its override");
  assert.deepEqual(warningsForBook(m, all, undefined), []);
});

test("a fact of book one is not listed while viewing book two", () => {
  assert.deepEqual(warningsForBook(model(), [w("establishedInTrash")], B2), []);
});

test("the eight sentences", () => {
  const m = model();
  const s = (x: ContinuityWarning) => describeWarning(m, x).sentence;
  assert.equal(s(w("learnedBeforeEstablished", { knower: "reader", learnNodeId: U(11), factNodeId: U(10) })),
    'The reader learns the fact "The bridge is old" in "The storm", which comes before "The bridge", where the fact is established.');
  assert.equal(s(w("learnedBeforeEstablished", { knower: U(20), learnNodeId: U(12), factNodeId: U(10) })),
    'Mira Vale learns the fact "The bridge is old" in "Untitled chapter", which comes before "The bridge", where the fact is established.');
  assert.equal(s(w("establishedInTrash", { factNodeId: U(14) })), 'The fact "The bridge is old" is established in "Gone scene", which is in the trash.');
  assert.equal(s(w("learnedInTrash", { knower: U(20), learnNodeId: U(15) })), 'Mira Vale learns the fact "The bridge is old" in "Gone chapter", which is in the trash.');
  assert.equal(s(w("aboutMissingEntry", { entryId: U(21) })), 'The fact "The bridge is old" is about "Hollow Reach", which is in the trash.');
  assert.equal(s(w("knowerMissing", { knower: U(20) })), 'The fact "The bridge is old" says Mira Vale knows it, but Mira Vale is in the trash.');
  assert.equal(s(w("undecidedButKnown")), 'The fact "The bridge is old" is known by someone, but its truth is still "Not decided".');
  assert.equal(s(w("questionOverdue", { recordKind: "question", recordId: U(50), nodeId: U(11) })),
    'The question "Who rang the bell?" is still open, but "The storm", where it should be decided, already has text.');
  assert.equal(s(w("stateConflict", { recordKind: "event", recordId: U(60), entryId: U(20), fieldId: U(30) })),
    'The event "The storm" sets "Home" of "Mira Vale" to more than one value.');
  assert.equal(Object.keys(HEADINGS).length, 8);
});

test("a trashed scene is in the trash itself", () => {
  const d = describeWarning(model(), w("establishedInTrash", { factNodeId: U(14) }));
  assert.equal(d.sentence, 'The fact "The bridge is old" is established in "Gone scene", which is in the trash.');
  assert.equal(d.heading, "Established in something in the trash");
  assert.equal(HEADINGS.learnedInTrash, "Learned in something in the trash");
});

test("a live scene inside a trashed chapter says so, and a live node does not claim to be in the trash", () => {
  const m = model();
  assert.equal(describeWarning(m, w("learnedInTrash", { knower: "reader", learnNodeId: U(16) })).sentence,
    'The reader learns the fact "The bridge is old" in "Inside", which is inside something in the trash.');
  assert.equal(describeWarning(m, w("establishedInTrash", { factNodeId: U(10) })).sentence,
    'The fact "The bridge is old" is established in "The bridge", which is no longer in the trash.');
});

test("a live scene in a trashed book is inside something in the trash, never no longer in the trash", () => {
  const m = model();
  put(m, "book", { id: U(4), title: "Gone book", deletedAt: "2026-11-12T00:00:00Z" });
  put(m, "manuscriptNode", { id: U(70), bookId: U(4), kind: "scene", title: "Orphan scene" });
  const sentence = describeWarning(m, w("establishedInTrash", { factNodeId: U(70) })).sentence;
  assert.equal(sentence, 'The fact "The bridge is old" is established in "Orphan scene", which is inside something in the trash.');
  assert.doesNotMatch(sentence, /no longer in the trash/);
});

test("a live scene whose ancestor record is missing says it is not available", () => {
  const m = model();
  put(m, "manuscriptNode", { id: U(71), bookId: B1, kind: "scene", title: "Lost", parentId: U(99) });
  assert.equal(describeWarning(m, w("learnedInTrash", { knower: "reader", learnNodeId: U(71) })).sentence,
    'The reader learns the fact "The bridge is old" in "Lost", which is not available.');
});

test("an untitled part, chapter, scene and unknown kind are named by kind", () => {
  const m = model();
  put(m, "manuscriptNode", { id: U(17), bookId: B1, kind: "mystery", title: "" });
  put(m, "manuscriptNode", { id: U(18), bookId: B1, kind: "scene" });
  const s = (id: string) => describeWarning(m, w("establishedInTrash", { factNodeId: id })).sentence;
  assert.match(s(U(13)), /"Untitled part"/);
  assert.match(s(U(12)), /"Untitled chapter"/);
  assert.match(s(U(18)), /"Untitled scene"/);
  assert.match(s(U(17)), /"Untitled section"/);
});

test("an id with no record is never shown; a plain phrase stands in", () => {
  const m = model();
  const all = describeWarning(m, w("learnedBeforeEstablished", { knower: U(97), learnNodeId: U(98), factNodeId: U(99) })).sentence;
  assert.match(all, /A character that is not available learns/);
  assert.match(all, /"a chapter or scene that is not available"/);
  assert.doesNotMatch(all, /20000000-/);
  assert.doesNotMatch(describeWarning(m, w("stateConflict", { recordKind: "event", recordId: U(98), entryId: U(97), fieldId: U(96) })).sentence, /20000000-/);
});

test("the server's answer is checked: unknown kinds and malformed items are dropped", () => {
  const good = { key: "a", kind: "stateConflict", recordKind: "event", recordId: "x" };
  assert.deepEqual(parseWarnings({ warnings: [good, { ...good, kind: "other" }, { ...good, recordKind: "entry" }, { key: 1 }, null, { ...good, exceptBookIds: [1] }] }), [good]);
  assert.deepEqual(parseWarnings({}), []);
  assert.deepEqual(parseWarnings(null), []);
});
