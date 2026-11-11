// validateRecord: one record against the archive schema and the integrity rules, with a context of the records it
// can point at. It must agree with the whole-archive validator, because it runs the same rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateArchiveData, validateRecord } from "../src/index.ts";
import type { ArchiveData, Rec, RecordContext, RecordKind } from "../src/index.ts";
import { loadSample } from "./helpers.ts";

/** Every record of the archive with its kind, and the whole archive as a context. */
function records(data: ArchiveData): { kind: RecordKind; rec: Rec }[] {
  const lib = data.library;
  const out: { kind: RecordKind; rec: Rec }[] = [{ kind: "library", rec: lib.library }];
  const add = (kind: RecordKind, rs: Rec[]) => rs.forEach((rec) => out.push({ kind, rec }));
  add("universe", lib.universes); add("series", lib.series); add("book", lib.books); add("manuscriptNode", lib.manuscriptNodes);
  add("template", data.templates); add("field", data.fields); add("entry", data.entries);
  add("relationshipType", data.relationships.relationshipTypes); add("relationship", data.relationships.relationships);
  add("fact", data.facts); add("question", data.questions); add("event", data.events); add("stateChange", data.stateChanges);
  add("reference", data.references); add("note", data.notes);
  return out;
}
const contextOf = (data: ArchiveData): RecordContext => ({
  universes: data.library.universes, series: data.library.series, books: data.library.books, manuscriptNodes: data.library.manuscriptNodes,
  templates: data.templates, fields: data.fields, entries: data.entries, relationshipTypes: data.relationships.relationshipTypes,
  relationships: data.relationships.relationships, facts: data.facts, questions: data.questions, events: data.events,
  stateChanges: data.stateChanges, references: data.references, notes: data.notes, attachmentHashes: data.attachments.map((a) => a.sha256),
});
const codes = (issues: { code: string }[]): string[] => [...new Set(issues.map((i) => i.code))].sort();

test("every record of the fixture archives is valid on its own, in the context of the archive", async () => {
  for (const name of ["sample-library", "record-overrides"]) {
    const { data } = await loadSample(name);
    const ctx = contextOf(data);
    const all = records(data);
    assert.ok(all.length > 20);
    const kinds = new Set(all.map((r) => r.kind));
    for (const { kind, rec } of all) assert.deepEqual(validateRecord(kind, rec, ctx), [], `${name} ${kind} ${rec.id}`);
    assert.ok(kinds.size >= 13, `kinds covered: ${[...kinds].join(",")}`);
  }
});

test("the record is checked in place of the copy the context holds, and the context is not re-validated", async () => {
  const { data } = await loadSample("record-overrides");
  const ctx = contextOf(data);
  const node = data.library.manuscriptNodes.find((n: Rec) => n.kind === "scene")!;
  assert.deepEqual(validateRecord("manuscriptNode", { ...node, title: "Another" }, ctx), []);
  // Break another record in the context (a note of another book): it is not reported.
  const broken = { ...ctx, notes: ctx.notes!.map((n: Rec) => ({ ...n, bookId: "99999999-9999-4999-8999-999999999999" })) };
  assert.deepEqual(validateRecord("manuscriptNode", node, broken), []);
});

test("shape problems are SCHEMA_VIOLATION and stop the integrity rules", async () => {
  const { data } = await loadSample();
  const ctx = contextOf(data);
  const node = data.library.manuscriptNodes[0]!;
  const { title: _t, ...noTitle } = node;
  assert.deepEqual(codes(validateRecord("manuscriptNode", noTitle, ctx)), ["SCHEMA_VIOLATION"]);
  assert.deepEqual(codes(validateRecord("manuscriptNode", { ...node, kind: "volume" }, ctx)), ["SCHEMA_VIOLATION"]);
  assert.deepEqual(codes(validateRecord("manuscriptNode", { ...node, title: 5 }, ctx)), ["SCHEMA_VIOLATION"]);
  assert.deepEqual(codes(validateRecord("manuscriptNode", { ...node, title: "a\u0000b" }, ctx)), ["SCHEMA_VIOLATION"]);
  assert.deepEqual(codes(validateRecord("book", { ...data.library.books[0]!, language: "not a tag!" }, ctx)), ["SCHEMA_VIOLATION"]);
  assert.deepEqual(codes(validateRecord("library", { id: "x", title: "T" })), ["SCHEMA_VIOLATION"]);
  // The library has no integrity rules of its own.
  assert.deepEqual(validateRecord("library", data.library.library), []);
  // Open records keep unknown properties; closed parts do not.
  assert.deepEqual(validateRecord("manuscriptNode", { ...node, futureThing: { a: 1 } }, ctx), []);
  const entry = data.entries.find((e) => e.overrides.length > 0)!;
  assert.deepEqual(codes(validateRecord("entry", { ...entry, scope: { ...entry.scope, extra: 1 } }, ctx)), ["SCHEMA_VIOLATION"]);
});

test("references and rules are reported with the archive's own codes", async () => {
  const { data } = await loadSample("record-overrides");
  const ctx = contextOf(data);
  const scene = data.library.manuscriptNodes.find((n: Rec) => n.kind === "scene")!;
  const chapter = data.library.manuscriptNodes.find((n: Rec) => n.id === scene.parentId)!;
  // A missing book is unresolved; the parent then also sits "in a different book", which the archive reports too.
  assert.deepEqual(codes(validateRecord("manuscriptNode", { ...scene, bookId: "99999999-9999-4999-8999-999999999999" }, ctx)), ["INTEGRITY_VIOLATION", "REFERENCE_UNRESOLVED"]);
  assert.deepEqual(codes(validateRecord("manuscriptNode", { ...scene, parentId: "99999999-9999-4999-8999-999999999999" }, ctx)), ["REFERENCE_UNRESOLVED"]);
  const { parentId: _p, ...orphan } = scene;
  assert.deepEqual(codes(validateRecord("manuscriptNode", orphan, ctx)), ["INTEGRITY_VIOLATION"], "a scene must be under a chapter");
  assert.deepEqual(codes(validateRecord("manuscriptNode", { ...chapter, kind: "part", parentId: chapter.parentId ?? scene.id }, ctx)), ["INTEGRITY_VIOLATION"]);
  // A context without the book is the same as a missing book.
  assert.ok(codes(validateRecord("manuscriptNode", scene, { ...ctx, books: [] })).includes("REFERENCE_UNRESOLVED"));
  // A trashed target still resolves (a warning in the archive, no error).
  const trashed = { ...ctx, manuscriptNodes: ctx.manuscriptNodes!.map((n: Rec) => (n.id === chapter.id ? { ...n, deletedAt: "2026-11-02T12:00:00Z" } : n)) };
  assert.deepEqual(validateRecord("manuscriptNode", scene, trashed), []);
  // Typing of values, uniqueness among the context.
  const entry = data.entries.find((e) => Object.keys(e.values).length > 0)!;
  const fieldId = Object.keys(entry.values)[0]!;
  const field = data.fields.find((f) => f.id === fieldId)!;
  const wrong = field.fieldType === "boolean" ? "yes" : true;
  assert.deepEqual(codes(validateRecord("entry", { ...entry, values: { ...entry.values, [fieldId]: wrong } }, ctx)), ["INTEGRITY_VIOLATION"]);
  assert.ok(codes(validateRecord("entry", { ...entry, scope: { kind: "book", id: "99999999-9999-4999-8999-999999999999" } }, ctx)).includes("REFERENCE_UNRESOLVED"));
  const sibling = data.fields.find((f) => f.id !== field.id && f.templateId === field.templateId)!;
  assert.deepEqual(codes(validateRecord("field", { ...field, key: sibling.key }, ctx)), ["INTEGRITY_VIOLATION"]);
});

test("a scene without a document is valid here (the node is created before its text); the archive as a whole still needs one", async () => {
  const { data } = await loadSample();
  const scene = data.library.manuscriptNodes.find((n: Rec) => n.kind === "scene")!;
  assert.deepEqual(validateRecord("manuscriptNode", scene, contextOf(data)), []);
  data.documents.delete(scene.id);
  assert.ok(validateArchiveData(data).errors.some((e) => /needs a document/.test(e.message)));
});

test("a single-record check agrees with the whole-archive validator on a broken record", async () => {
  const { data } = await loadSample("record-overrides");
  const note = data.notes[0]!;
  const bad = { ...note, bookId: "99999999-9999-4999-8999-999999999999" };
  data.notes[0] = bad;
  const whole = validateArchiveData(data).errors.filter((e) => e.recordId === note.id).map((e) => e.message);
  const one = validateRecord("note", bad, contextOf(data)).map((e) => e.message);
  assert.deepEqual(one, whole);
  assert.ok(one.length > 0);
});
