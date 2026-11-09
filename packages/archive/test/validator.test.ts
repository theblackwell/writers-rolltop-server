import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readArchive, validateArchiveData, writeArchive } from "../src/index.ts";
import type { ArchiveData, Rec } from "../src/index.ts";
import { loadSample, withTempDir } from "./helpers.ts";

const H = (n: number): string => `a${n.toString(16).padStart(7, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const T = "2026-11-02T12:00:00Z";

async function fresh(name = "record-overrides") {
  const { data, attachments } = await loadSample(name);
  const lib = data.library;
  const byPrefix = <R extends Rec>(rs: R[], prefix: string): R => {
    const r = rs.find((x) => x.id.startsWith(prefix));
    if (!r) throw new Error(`no record ${prefix}`);
    return r;
  };
  return {
    data, attachments, lib,
    node: (p: string) => byPrefix(lib.manuscriptNodes, p),
    book: (p: string) => byPrefix(lib.books, p),
    entry: (p: string) => byPrefix(data.entries, p),
    fact: (p: string) => byPrefix(data.facts, p),
    question: (p: string) => byPrefix(data.questions, p),
    event: (p: string) => byPrefix(data.events, p),
  };
}
const errorCodes = (d: ArchiveData): string[] => [...new Set(validateArchiveData(d).errors.map((e) => e.code))].sort();
const warningCodes = (d: ArchiveData): string[] => [...new Set(validateArchiveData(d).warnings.map((e) => e.code))].sort();

test("the fixture data validates with no errors and no warnings", async () => {
  for (const n of ["sample-library", "record-overrides"]) {
    const { data } = await fresh(n);
    assert.deepEqual(validateArchiveData(data), { errors: [], warnings: [], errorsTruncated: false, warningsTruncated: false });
  }
});

test("hierarchy: parent rules", async () => {
  const f = await fresh();
  f.node("50000006").parentId = undefined; // scene at root
  assert.deepEqual(errorCodes(f.data), ["INTEGRITY_VIOLATION"]);
  const g = await fresh();
  g.node("50000006").parentId = g.node("50000002").id; // scene under a part
  assert.deepEqual(errorCodes(g.data), ["INTEGRITY_VIOLATION"]);
  const h = await fresh();
  h.node("50000005").parentId = h.node("50000004").id; // chapter under a chapter
  assert.deepEqual(errorCodes(h.data), ["INTEGRITY_VIOLATION"]);
  const i = await fresh();
  i.node("50000002").parentId = i.node("50000002").id; // part with a parent
  assert.deepEqual(errorCodes(i.data), ["INTEGRITY_VIOLATION"]);
  const j = await fresh();
  j.node("50000001").parentId = j.node("50000002").id; // frontMatter with a parent
  assert.deepEqual(errorCodes(j.data), ["INTEGRITY_VIOLATION"]);
  const k = await fresh();
  k.node("50000006").parentId = k.node("5000000a").id; // parent in another book
  assert.ok(errorCodes(k.data).includes("INTEGRITY_VIOLATION"));
  const l = await fresh();
  l.node("50000006").parentId = H(999); // parent does not exist
  assert.deepEqual(errorCodes(l.data), ["REFERENCE_UNRESOLVED"]);
});

test("hierarchy: universe, series and book", async () => {
  const f = await fresh();
  f.book("40000001").universeId = H(7);
  f.lib.universes.push({ id: H(7), title: "Other", orderKey: "a", createdAt: T, updatedAt: T });
  assert.deepEqual(errorCodes(f.data), ["INTEGRITY_VIOLATION"]); // differs from the series' universe
  const g = await fresh();
  delete g.book("40000001").universeId;
  assert.deepEqual(errorCodes(g.data), ["INTEGRITY_VIOLATION"]); // series has a universe, so the book needs one
  const h = await fresh();
  h.book("40000003").universeId = H(555);
  assert.deepEqual(errorCodes(h.data), ["REFERENCE_UNRESOLVED"]);
  const i = await fresh();
  i.book("40000003").targetDate = "2026-02-30";
  assert.deepEqual(errorCodes(i.data), ["SCHEMA_VIOLATION"]);
  const j = await fresh();
  j.book("40000003").coverAttachment = "e".repeat(64);
  assert.deepEqual(errorCodes(j.data), ["REFERENCE_UNRESOLVED"]);
});

test("ids are unique across record types", async () => {
  const f = await fresh();
  f.data.notes[0].id = f.data.entries[0].id;
  assert.deepEqual(errorCodes(f.data), ["INTEGRITY_VIOLATION"]);
});

test("point-of-view and setting entries: node kind, entry type and scope visibility", async () => {
  const f = await fresh();
  f.node("50000002").povEntryId = f.entry("b0000001").id; // on a part
  assert.deepEqual(errorCodes(f.data), ["INTEGRITY_VIOLATION"]);
  const g = await fresh();
  g.node("50000006").povEntryId = g.entry("b0000003").id; // a location as POV
  assert.deepEqual(errorCodes(g.data), ["INTEGRITY_VIOLATION"]);
  const h = await fresh();
  h.node("50000006").settingEntryId = h.entry("b0000001").id; // a character as setting
  assert.deepEqual(errorCodes(h.data), ["INTEGRITY_VIOLATION"]);
  const i = await fresh();
  i.node("50000006").povEntryId = i.entry("b000000a").id; // book-scoped to another book
  assert.deepEqual(errorCodes(i.data), ["INTEGRITY_VIOLATION"]);
  const j = await fresh();
  j.node("50000006").povEntryId = H(404);
  assert.deepEqual(errorCodes(j.data), ["REFERENCE_UNRESOLVED"]);
});

test("documents: one per scene, frontMatter and backMatter, naming its node", async () => {
  const f = await fresh();
  f.data.documents.delete(f.node("50000006").id);
  assert.deepEqual(errorCodes(f.data), ["INTEGRITY_VIOLATION"]);
  const g = await fresh();
  const chapter = g.node("50000004").id;
  g.data.documents.set(chapter, { ...g.data.documents.get(g.node("50000006").id)!, nodeId: chapter });
  assert.deepEqual(errorCodes(g.data), ["INTEGRITY_VIOLATION"]); // a chapter has no document
  const h = await fresh();
  const doc = h.data.documents.get(h.node("50000006").id)!;
  h.data.documents.set(h.node("50000006").id, { ...doc, nodeId: h.node("50000007").id });
  assert.deepEqual(errorCodes(h.data), ["INTEGRITY_VIOLATION"]);
  const i = await fresh();
  i.data.documents.set(H(77), { ...doc, nodeId: H(77) });
  assert.deepEqual(errorCodes(i.data), ["INTEGRITY_VIOLATION"]); // belongs to no node
});

test("templates and fields", async () => {
  const f = await fresh();
  f.data.fields[1].key = f.data.fields[0].key;
  f.data.fields[1].templateId = f.data.fields[0].templateId;
  assert.ok(errorCodes(f.data).includes("INTEGRITY_VIOLATION"));
  const g = await fresh();
  g.data.fields[0].key = "Bad Key";
  assert.deepEqual(errorCodes(g.data), ["SCHEMA_VIOLATION"]);
  const h = await fresh();
  h.data.fields[0].fieldType = "selection"; // selection without options
  assert.ok(errorCodes(h.data).includes("SCHEMA_VIOLATION"));
  const i = await fresh();
  i.data.fields[0].options = [{ id: "x", label: "X" }]; // options on a non-selection field
  assert.ok(errorCodes(i.data).includes("SCHEMA_VIOLATION"));
  const j = await fresh();
  Object.assign(j.data.fields[0], { fieldType: "selection", options: [{ id: "x", label: "A" }, { id: "x", label: "B" }] });
  assert.ok(errorCodes(j.data).includes("INTEGRITY_VIOLATION"));
});

/** Adds a field of the given type to the character template and returns a function to set a value on an entry. */
async function withField(fieldType: string, extra: Rec = {}) {
  const f = await fresh();
  const entry = f.entry("b0000002");
  const field = { id: H(1000), templateId: entry.templateId, key: "probe", label: "Probe", fieldType, required: false, orderKey: "z", createdAt: T, updatedAt: T, ...extra };
  f.data.fields.push(field);
  return { ...f, set: (v: unknown) => { entry.values[field.id] = v; return errorCodes(f.data); } };
}

const typingCases: [string, Rec, unknown[], unknown[]][] = [
  ["shortText", {}, ["a", ""], [1, true, ["a"]]],
  ["longText", {}, ["a long text"], [null === 0 ? 0 : 5]],
  ["integer", {}, [0, -5, 9007199254740991], ["5", true]],
  ["decimal", {}, ["-12.50", "0", "10"], ["1.", "01", "1e3", 3, ".5", "-"]],
  ["boolean", {}, [true, false], ["true", 1]],
  ["realDate", {}, ["2024-02-29", "2026-11-09"], ["2026-02-29", "2026-13-01", "20261109", "2026-1-9", 5]],
  ["fictionalDate", {}, [{ label: "Year 1" }, { label: "Y", calendar: "c", ordinal: -3 }], [{ label: "" }, { label: "Y", calendar: "" }, { label: "Y", ordinal: 1.5 }, { calendar: "c" }, { label: "Y", extra: 1 }, "Year 1"]],
  ["table", {}, [{ columns: ["a"], rows: [] }, { columns: ["a", "b"], rows: [["1", "2"]] }], [{ columns: [], rows: [] }, { columns: ["a"], rows: [["1", "2"]] }, { columns: ["a"] }, { columns: ["a"], rows: [[1]] }, { columns: ["a"], rows: [], extra: 1 }, { columns: Array(21).fill("x"), rows: [] }, { columns: ["a"], rows: Array(501).fill(["x"]) }, { columns: ["a"], rows: [["x".repeat(1001)]] }]],
];
for (const [type, extra, good, bad] of typingCases) {
  test(`field typing: ${type}`, async () => {
    for (const v of good) assert.deepEqual((await withField(type, extra)).set(v), [], `${JSON.stringify(v)} should be accepted`);
    for (const v of bad) assert.deepEqual((await withField(type, extra)).set(v), ["INTEGRITY_VIOLATION"], `${JSON.stringify(v)} should be refused`);
  });
}

test("field typing: selection, with and without multiple", async () => {
  const options = [{ id: "a", label: "A" }, { id: "b", label: "B" }];
  assert.deepEqual((await withField("selection", { options })).set(["a"]), []);
  assert.deepEqual((await withField("selection", { options })).set([]), []);
  assert.deepEqual((await withField("selection", { options })).set(["a", "b"]), ["INTEGRITY_VIOLATION"]);
  assert.deepEqual((await withField("selection", { options, multiple: true })).set(["a", "b"]), []);
  assert.deepEqual((await withField("selection", { options })).set(["zzz"]), ["INTEGRITY_VIOLATION"]);
  assert.deepEqual((await withField("selection", { options })).set("a"), ["INTEGRITY_VIOLATION"]);
});

test("field typing: entry references and attachments", async () => {
  const probe = await withField("entryReference", { targetEntryTypes: ["location"] });
  assert.deepEqual(probe.set(probe.entry("b0000003").id), []);
  assert.deepEqual((await withField("entryReference", { targetEntryTypes: ["location"] })).set(H(404)), ["REFERENCE_UNRESOLVED"]);
  const wrong = await withField("entryReference", { targetEntryTypes: ["location"] });
  assert.deepEqual(wrong.set(wrong.entry("b0000001").id), ["INTEGRITY_VIOLATION"]);
  const many = await withField("entryReferences");
  assert.deepEqual(many.set([many.entry("b0000001").id, many.entry("b0000003").id]), []);
  const dup = await withField("entryReferences");
  assert.deepEqual(dup.set([dup.entry("b0000001").id, dup.entry("b0000001").id]), ["INTEGRITY_VIOLATION"]);
  const att = await withField("attachment");
  assert.deepEqual(att.set(att.data.attachments[0].sha256), []);
  assert.deepEqual((await withField("attachment")).set("e".repeat(64)), ["REFERENCE_UNRESOLVED"]);
  assert.deepEqual((await withField("attachment")).set(5), ["INTEGRITY_VIOLATION"]);
});

test("entries: template, values, names, attachments", async () => {
  const f = await fresh();
  f.entry("b0000003").templateId = f.entry("b0000002").templateId; // location entry, character template
  assert.ok(errorCodes(f.data).includes("INTEGRITY_VIOLATION"));
  const g = await fresh();
  g.entry("b0000007").values = { [H(1)]: "x" }; // no template, so no values
  assert.deepEqual(errorCodes(g.data), ["INTEGRITY_VIOLATION"]);
  const h = await fresh();
  h.entry("b0000003").givenName = "Ann"; // a location with a given name
  assert.deepEqual(errorCodes(h.data), ["INTEGRITY_VIOLATION"]);
  const i = await fresh();
  i.entry("b0000001").attachments = [i.data.attachments[0].sha256, i.data.attachments[0].sha256];
  assert.deepEqual(errorCodes(i.data), ["INTEGRITY_VIOLATION"]);
  const j = await fresh();
  j.entry("b0000001").attachments = ["e".repeat(64)];
  assert.deepEqual(errorCodes(j.data), ["REFERENCE_UNRESOLVED"]);
  const k = await fresh();
  k.entry("b0000001").scope = { kind: "universe", id: H(404) };
  assert.ok(errorCodes(k.data).includes("REFERENCE_UNRESOLVED"));
});

test("entry overrides: scope, one per book, book must exist", async () => {
  const f = await fresh();
  const e = f.entry("b0000001"); // universe scope, one override
  const dup = structuredClone(e.overrides[0]);
  e.overrides.push(dup);
  assert.deepEqual(errorCodes(f.data), ["INTEGRITY_VIOLATION"]);
  const g = await fresh();
  g.entry("b0000002").overrides[0].bookId = g.book("40000003").id; // series-scoped; book 3 is outside the series
  assert.deepEqual(errorCodes(g.data), ["INTEGRITY_VIOLATION"]);
  const h = await fresh();
  h.entry("b000000a").overrides = [{ bookId: h.book("40000003").id, values: {} }]; // book-scoped entries have none
  assert.deepEqual(errorCodes(h.data), ["INTEGRITY_VIOLATION"]);
  const i = await fresh();
  i.entry("b0000001").overrides[0].bookId = H(404);
  assert.deepEqual(errorCodes(i.data), ["REFERENCE_UNRESOLVED"]);
  const j = await fresh();
  j.entry("b0000001").overrides[0].values = { [H(5000)]: "x" }; // not a field of the template
  assert.deepEqual(errorCodes(j.data), ["INTEGRITY_VIOLATION"]);
});

test("record overrides on facts, questions and events", async () => {
  for (const [kind, pick] of [["facts", "f0000202"], ["questions", ""], ["events", "d0000001"]] as const) {
    const records = (d: ArchiveData): Rec[] => d[kind];
    const withOverride = async () => {
      const f = await fresh();
      const r = records(f.data).find((x) => (pick === "" || x.id.startsWith(pick)) && x.overrides?.length > 0 && x.scope.kind !== "book");
      assert.ok(r, `${kind} with an override`);
      return { f, r };
    };
    let { f, r } = await withOverride();
    r.overrides.push(structuredClone(r.overrides[0])); // two overrides for one book
    assert.deepEqual(errorCodes(f.data), ["INTEGRITY_VIOLATION"], `${kind} duplicate`);
    ({ f, r } = await withOverride());
    r.overrides[0].bookId = H(404);
    assert.deepEqual(errorCodes(f.data), ["REFERENCE_UNRESOLVED"], `${kind} unknown book`);
    ({ f, r } = await withOverride());
    r.scope = { kind: "book", id: f.book("40000001").id }; // book-scoped records cannot have overrides
    assert.ok(errorCodes(f.data).includes("INTEGRITY_VIOLATION"), `${kind} book scope`);
    ({ f, r } = await withOverride());
    // Move the override to a book outside the record's scope.
    const outside = f.lib.books.find((b: Rec) => !(r.scope.kind === "universe" ? b.universeId === r.scope.id : b.seriesId === r.scope.id))!;
    r.overrides[0].bookId = outside.id;
    assert.deepEqual(errorCodes(f.data), ["INTEGRITY_VIOLATION"], `${kind} outside scope`);
  }
});

test("facts: nodes must be in scope, knowers must be characters and unique", async () => {
  const f = await fresh();
  f.fact("f0000202").nodeId = f.node("5000000d").id; // series-scoped fact, node in a book outside the series
  assert.deepEqual(errorCodes(f.data), ["INTEGRITY_VIOLATION"]);
  const g = await fresh();
  g.fact("f0000201").knowledge[0].knower = g.entry("b0000003").id; // a location
  assert.deepEqual(errorCodes(g.data), ["INTEGRITY_VIOLATION"]);
  const h = await fresh();
  h.fact("f0000201").knowledge.push({ knower: "reader" }, { knower: "reader" });
  assert.deepEqual(errorCodes(h.data), ["INTEGRITY_VIOLATION"]);
  const i = await fresh();
  i.fact("f0000201").nodeId = i.node("50000002").id; // a part is not a chapter or scene
  assert.deepEqual(errorCodes(i.data), ["INTEGRITY_VIOLATION"]);
  const j = await fresh();
  j.fact("f0000201").entryIds = [H(404)];
  assert.deepEqual(errorCodes(j.data), ["REFERENCE_UNRESOLVED"]);
  const k = await fresh();
  k.fact("f0000201").entryIds = [k.entry("b0000001").id, k.entry("b0000001").id];
  assert.deepEqual(errorCodes(k.data), ["INTEGRITY_VIOLATION"]);
  const l = await fresh();
  const fact = l.fact("f0000201");
  fact.dismissedWarnings = [{ warning: "undecidedButKnown", dismissedAt: T }, { warning: "undecidedButKnown", dismissedAt: T }];
  assert.deepEqual(errorCodes(l.data), ["SCHEMA_VIOLATION"]);
});

test("events, relationships, state changes, references, notes", async () => {
  const f = await fresh();
  f.event("d0000001").sceneIds = [f.node("50000004").id]; // a chapter is not a scene
  assert.deepEqual(errorCodes(f.data), ["INTEGRITY_VIOLATION"]);
  const g = await fresh();
  g.event("d0000001").participants = [{ entryId: g.entry("b0000005").id }, { entryId: g.entry("b0000005").id }];
  assert.deepEqual(errorCodes(g.data), ["INTEGRITY_VIOLATION"]);
  const h = await fresh();
  h.event("d0000001").entryId = h.entry("b0000001").id; // not an event entry
  assert.deepEqual(errorCodes(h.data), ["INTEGRITY_VIOLATION"]);

  const r = await fresh();
  const rel = r.data.relationships.relationships[0];
  rel.toEntryId = rel.fromEntryId;
  assert.deepEqual(errorCodes(r.data), ["INTEGRITY_VIOLATION"]);

  const s = await fresh();
  s.data.stateChanges[0].nodeId = s.node("50000006").id; // both eventId and nodeId
  assert.ok(errorCodes(s.data).includes("INTEGRITY_VIOLATION"));
  const t = await fresh();
  delete t.data.stateChanges[0].eventId; // neither
  assert.deepEqual(errorCodes(t.data), ["INTEGRITY_VIOLATION"]);
  const u = await fresh();
  u.data.stateChanges[0].fieldId = u.data.fields.find((x: Rec) => x.templateId !== u.entry("b0000002").templateId)!.id;
  assert.deepEqual(errorCodes(u.data), ["INTEGRITY_VIOLATION"]);
  const v = await fresh();
  v.data.stateChanges[0].value = 12; // field is a boolean or text; wrong type
  assert.deepEqual(errorCodes(v.data), ["INTEGRITY_VIOLATION"]);

  const w = await fresh();
  w.data.references[0].nodeId = w.node("50000004").id; // a chapter has no document
  assert.deepEqual(errorCodes(w.data), ["INTEGRITY_VIOLATION"]);
  const x = await fresh();
  x.data.references.push({ ...x.data.references[0], id: H(2000) });
  assert.deepEqual(errorCodes(x.data), ["INTEGRITY_VIOLATION"]);
  const y = await fresh();
  y.data.notes[0].nodeId = y.node("5000000b").id;
  y.data.notes[0].bookId = y.book("40000001").id;
  assert.deepEqual(errorCodes(y.data), ["INTEGRITY_VIOLATION"]);
});

test("attachments.json lists each hash once", async () => {
  const f = await fresh();
  f.data.attachments.push({ ...f.data.attachments[0] });
  assert.deepEqual(errorCodes(f.data), ["INTEGRITY_VIOLATION"]);
});

// ---- warnings ----

test("W_REFERENCE_TO_DELETED: a live record points at a tombstoned one; a tombstoned source does not warn", async () => {
  const f = await fresh();
  f.entry("b0000001").deletedAt = T; // referenced by a live reference, facts and events
  const report = validateArchiveData(f.data);
  assert.deepEqual(report.errors, []);
  assert.ok(report.warnings.some((w) => w.code === "W_REFERENCE_TO_DELETED"));
  const g = await fresh();
  g.entry("b0000001").deletedAt = T;
  for (const list of [g.data.references, g.data.facts, g.data.events, g.data.stateChanges, g.data.relationships.relationships, g.data.questions, g.lib.manuscriptNodes, g.data.entries]) {
    for (const r of list) if (JSON.stringify(r).includes(g.entry("b0000001").id) && r.id !== g.entry("b0000001").id) r.deletedAt = T;
  }
  assert.deepEqual(validateArchiveData(g.data).warnings.filter((w) => w.code === "W_REFERENCE_TO_DELETED" && w.recordId !== undefined && g.data.references.some((r) => r.id === w.recordId)), []);
});

test("W_REFERENCE_ANCHOR_MISSING: only for a live reference whose anchor left the document", async () => {
  const f = await fresh();
  f.data.references[0].anchorId = H(31337);
  const report = validateArchiveData(f.data);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.warnings.map((w) => w.code), ["W_REFERENCE_ANCHOR_MISSING"]);
  assert.equal(report.warnings[0]!.recordId, f.data.references[0].id);
  f.data.references[0].deletedAt = T; // a trashed reference does not warn
  assert.deepEqual(warningCodes(f.data), []);
});

test("W_STATE_CONFLICT: differing live values at one event; same values, trashed or dismissed do not warn", async () => {
  const f = await fresh();
  const first = f.data.stateChanges[0];
  assert.equal(typeof first.value, "boolean"); // a boolean field, so the conflicting value must be a boolean too
  const other: Rec = { ...first, id: H(3000), value: !first.value, note: undefined };
  f.data.stateChanges.push(other);
  assert.deepEqual(warningCodes(f.data), ["W_STATE_CONFLICT"]);
  other.value = first.value; // same value: no conflict
  assert.deepEqual(warningCodes(f.data), []);
  other.value = !first.value;
  other.deletedAt = T; // trashed: no conflict
  assert.deepEqual(warningCodes(f.data), []);
  delete other.deletedAt;
  const ev = f.data.events.find((e) => e.id === first.eventId)!;
  ev.dismissedWarnings = [{ warning: `stateConflict:${first.entryId}:${first.fieldId}`, dismissedAt: T }];
  assert.deepEqual(warningCodes(f.data), []); // dismissed
  assert.deepEqual(errorCodes(f.data), []);
});

test("W_CHRONOLOGY_ORDINAL: orderKey order contradicts ordinal order within one calendar", async () => {
  const f = await fresh();
  const scope = { kind: "universe", id: f.lib.universes[0].id };
  const ev = (n: number, orderKey: string, calendar: string, ordinal: number): Rec => ({
    id: H(n), scope, title: `E${n}`, orderKey, sceneIds: [], participants: [], when: { label: `L${n}`, calendar, ordinal }, createdAt: T, updatedAt: T,
  });
  const a = ev(4001, "zz1", "Reckoning", 10);
  const b = ev(4002, "zz2", "Reckoning", 4);
  f.data.events.push(a, b);
  const report = validateArchiveData(f.data);
  assert.deepEqual(report.errors, []);
  const chron = report.warnings.filter((w) => w.code === "W_CHRONOLOGY_ORDINAL");
  assert.equal(chron.length, 1);
  assert.equal(chron[0]!.recordId, b.id);
  b.when.calendar = "Other"; // different calendars are not compared
  assert.deepEqual(warningCodes(f.data), []);
  b.when.calendar = "Reckoning";
  b.deletedAt = T; // trashed events are not compared
  assert.deepEqual(warningCodes(f.data), []);
  delete b.deletedAt;
  b.orderKey = "zz0"; // now in order
  assert.deepEqual(warningCodes(f.data), []);
});

test("warnings never block a read, and survive a write and read back", async () => {
  const f = await fresh();
  f.data.references[0].anchorId = H(31337);
  await withTempDir(async (dir) => {
    const out = path.join(dir, "warn.rolltop");
    await writeArchive(f.data, async (s) => f.attachments.get(s)!, out);
    const back = await readArchive(out);
    try {
      assert.deepEqual(back.warnings.map((w) => w.code), ["W_REFERENCE_ANCHOR_MISSING"]);
    } finally {
      await back.close();
    }
  });
});
