// M1-10 slice 1: the value rules of the bible, the built-in template seeding, and saving an entry's fields through the
// sync client with stubbed calls (no browser, no server).
import { test } from "node:test";
import assert from "node:assert/strict";
import { SyncClient, HISTORY_MESSAGE, HISTORY_REASON, RETRY_MESSAGE } from "../src/sync/client.ts";
import type { ClientIo } from "../src/sync/client.ts";
import { applyChange, emptyModel } from "../src/sync/model.ts";
import type { Model, SyncChange } from "../src/sync/model.ts";
import type { Op, OpResult, PushAnswer } from "../src/sync/http.ts";
import type { FieldDraft, LibraryDb } from "../src/sync/local.ts";
import {
  bibleReady, builtInTemplate, checkEntryField, encodeInput, encodeText, entriesOfType, fieldsOf, inputOf, newEntryValue, seedOps, validateValue,
} from "../src/sync/bible.ts";
import type { FieldDef } from "../src/sync/bible.ts";
import { BUILTIN_FIELDS, BUILTIN_TEMPLATES } from "../src/sync/bible-builtins.ts";

const U = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CHARACTER_TPL = "80000001-0000-4000-8000-000000000001";
const F = (fieldType: string, extra: Partial<FieldDef> = {}): FieldDef =>
  ({ id: U(900), key: "k", label: "L", fieldType, multiple: false, required: false, options: [], targetEntryTypes: [], ...extra });
const OPTS = [{ id: U(1001), label: "A" }, { id: U(1002), label: "B" }];

let seq = 0;
const change = (c: Partial<SyncChange> & Pick<SyncChange, "change" | "recordKind" | "recordId">): SyncChange =>
  ({ seq: ++seq, at: "2026-11-11T12:00:00Z", opId: U(5000 + seq), deviceId: U(800), ...c });

// ---------- value encoding and validation ----------

test("a value of the wrong type for the field is refused before it is sent", () => {
  assert.match(validateValue(F("integer"), 24.5)!, /whole number/);
  assert.match(validateValue(F("integer"), "24")!, /whole number/);
  assert.equal(validateValue(F("integer"), 24), undefined);
  assert.equal(validateValue(F("integer"), -3), undefined);
  assert.match(validateValue(F("decimal"), 1.68)!, /decimal/, "a decimal is a string, never a binary float");
  assert.match(validateValue(F("decimal"), "1.")!, /decimal/);
  assert.match(validateValue(F("decimal"), "01.5")!, /decimal/);
  assert.equal(validateValue(F("decimal"), "-0.5"), undefined);
  assert.match(validateValue(F("boolean"), "yes")!, /yes or no/);
  assert.equal(validateValue(F("boolean"), false), undefined);
  assert.match(validateValue(F("shortText"), 5)!, /text/);
  assert.match(validateValue(F("longText"), "a\u0000b")!, /cannot be stored/);
  assert.match(validateValue(F("longText"), "lone \ud800 surrogate")!, /cannot be stored/);
  assert.match(validateValue(F("realDate"), "2001-02-29")!, /real date/);
  assert.match(validateValue(F("realDate"), "2000-13-01")!, /real date/);
  assert.equal(validateValue(F("realDate"), "2000-02-29"), undefined);
  assert.match(validateValue(F("fictionalDate"), { label: "" })!, /label/);
  assert.match(validateValue(F("fictionalDate"), { label: "x", year: 1 })!, /fictional date/);
  assert.equal(validateValue(F("fictionalDate"), { label: "Third Moon", calendar: "Lantern", ordinal: 388 }), undefined);
  assert.match(validateValue(F("entryReference"), "not-a-uuid")!, /entry/);
  assert.match(validateValue(F("attachment"), "abc")!, /file/);
  assert.equal(validateValue(F("attachment"), "f".repeat(64)), undefined);
});

test("a selection takes only its options, and one option unless it allows several", () => {
  assert.equal(validateValue(F("selection", { options: OPTS }), [U(1001)]), undefined);
  assert.match(validateValue(F("selection", { options: OPTS }), [U(1001), U(1002)])!, /Only one/);
  assert.equal(validateValue(F("selection", { options: OPTS, multiple: true }), [U(1001), U(1002)]), undefined);
  assert.match(validateValue(F("selection", { options: OPTS, multiple: true }), [U(1001), U(1001)])!, /twice/);
  assert.match(validateValue(F("selection", { options: OPTS }), [U(1099)])!, /options/);
  assert.match(validateValue(F("selection", { options: OPTS }), U(1001))!, /list/);
});

test("typed text is turned into the JSON value of its field type; nonsense is refused with a plain message", () => {
  assert.deepEqual(encodeText(F("integer"), " 24 "), { ok: true, value: 24 });
  assert.deepEqual(encodeText(F("integer"), ""), { ok: true, value: undefined });
  assert.equal(encodeText(F("integer"), "24.5").ok, false);
  assert.equal(encodeText(F("integer"), "abc").ok, false);
  assert.equal(encodeText(F("integer"), "99999999999999999999").ok, false);
  assert.deepEqual(encodeText(F("decimal"), "1.68"), { ok: true, value: "1.68" });
  assert.equal(encodeText(F("decimal"), "1,68").ok, false);
  assert.deepEqual(encodeText(F("realDate"), "2000-02-29"), { ok: true, value: "2000-02-29" });
  assert.equal(encodeText(F("realDate"), "29/02/2000").ok, false);
  assert.deepEqual(encodeText(F("shortText"), "   "), { ok: true, value: undefined });
  // Only the label is edited: a calendar and a number already stored stay.
  assert.deepEqual(encodeText(F("fictionalDate"), "Fourth Moon", { label: "Third Moon", calendar: "Lantern", ordinal: 388 }),
    { ok: true, value: { calendar: "Lantern", ordinal: 388, label: "Fourth Moon" } });
  assert.equal(encodeText(F("fictionalDate"), "", { label: "Third Moon", ordinal: 388 }).ok, false);
  assert.deepEqual(encodeInput(F("boolean"), "no"), { ok: true, value: false });
  assert.deepEqual(encodeInput(F("selection", { options: OPTS, multiple: true }), []), { ok: true, value: undefined });
  assert.deepEqual(encodeInput(F("selection", { options: OPTS }), U(1002)), { ok: true, value: [U(1002)] });
  assert.equal(inputOf(F("boolean"), true), "yes");
  assert.deepEqual(inputOf(F("selection", { options: OPTS, multiple: true }), [U(1001)]), [U(1001)]);
});

// ---------- the built-in templates ----------

const applyOps = (m: Model, ops: Array<Record<string, unknown>>) => {
  for (const o of ops) applyChange(m, change({ change: "create", recordKind: String(o.recordKind), recordId: String(o.recordId), value: o.value }));
};
let opN = 0;
const opId = () => U(7000 + ++opN);

test("seeding makes the sample library's built-in templates and fields with the same ids, templates first", () => {
  seq = 0;
  const m = emptyModel();
  const ops = seedOps(m, opId);
  assert.equal(ops.filter((o) => o.recordKind === "template").length, 9);
  assert.equal(ops.filter((o) => o.recordKind === "field").length, 14);
  const firstField = ops.findIndex((o) => o.recordKind === "field");
  assert.ok(ops.slice(0, firstField).every((o) => o.recordKind === "template"), "a template comes before its fields");
  assert.deepEqual(ops.filter((o) => o.recordKind === "template").map((o) => o.recordId), BUILTIN_TEMPLATES.map((t) => t.id));
  assert.equal(ops.find((o) => o.recordId === CHARACTER_TPL)?.recordKind, "template");
  assert.equal((ops.find((o) => o.recordId === CHARACTER_TPL)!.value as { builtIn: boolean }).builtIn, true);
  assert.ok(new Set(ops.map((o) => o.opId)).size === ops.length, "every op has its own op id");
  assert.ok(BUILTIN_TEMPLATES.every((t) => t.builtIn === true));
  assert.equal(bibleReady(m), false);
});

test("a second open makes no second template or field", () => {
  seq = 0;
  const m = emptyModel();
  applyOps(m, seedOps(m, opId));
  assert.equal(bibleReady(m), true);
  assert.deepEqual(seedOps(m, opId), []);
  assert.equal(m.records.get("template")!.size, 9);
  assert.equal(m.records.get("field")!.size, 14);
  assert.equal(builtInTemplate(m, "character")?.id, CHARACTER_TPL);
  assert.equal(fieldsOf(m, CHARACTER_TPL).length, 11);
  // A template that is missing a field (an earlier run stopped half way) gets that field only.
  m.records.get("field")!.delete("90000019-0000-4000-8000-000000000019");
  const again = seedOps(m, opId);
  assert.deepEqual(again.map((o) => o.recordId), ["90000019-0000-4000-8000-000000000019"]);
});

test("a library that already has a built-in template of a type, under another id, gets no second one", () => {
  seq = 0;
  const m = emptyModel();
  applyChange(m, change({ change: "create", recordKind: "template", recordId: U(60), value: { id: U(60), name: "Character", entryType: "character", builtIn: true, orderKey: "m", createdAt: "x", updatedAt: "x" } }));
  const ops = seedOps(m, opId);
  assert.equal(ops.some((o) => o.recordKind === "template" && (o.value as { entryType: string }).entryType === "character"), false);
  assert.equal(ops.some((o) => o.recordKind === "field" && (o.value as { templateId: string }).templateId === CHARACTER_TPL), false, "no fields pointing at a template that was not made");
  assert.equal(builtInTemplate(m, "character")?.id, U(60));
});

// ---------- a fake server for the client ----------

interface Fake { io: Partial<ClientIo>; pushes: Op[][]; changes: SyncChange[]; reply: Array<(ops: Op[]) => OpResult[] | undefined>; head: number; before: ((ops: Op[]) => Promise<void>) | undefined }
/** Applies creates, sets and unsets like the server would (without validation), unless a reply function answers first. */
function fake(): Fake {
  const f: Fake = { pushes: [], changes: [], reply: [], io: {}, head: 0, before: undefined };
  f.io = {
    getChanges: async (_e, after) => ({ kind: "ok" as const, epoch: "E1", head: f.head, changes: f.changes.filter((c) => c.seq > after), next: f.head }),
    getConflicts: async () => ({ kind: "ok" as const, conflicts: [] }),
    pushOps: async (_e, _d, ops): Promise<PushAnswer> => {
      f.pushes.push(ops);
      await f.before?.(ops);
      const custom = f.reply.shift()?.(ops);
      if (custom) return { kind: "ok", epoch: "E1", head: f.head, results: custom };
      const results: OpResult[] = ops.map((o) => {
        const seqNo = ++f.head;
        const c: SyncChange = { seq: seqNo, at: "2026-11-11T12:00:00Z", opId: o.opId, deviceId: U(1), change: String(o.op), recordKind: String(o.recordKind), recordId: String(o.recordId) };
        if (o.field !== undefined) c.field = String(o.field);
        if (o.value !== undefined) c.value = o.value;
        f.changes.push(c);
        return { opId: o.opId, status: "applied", seq: seqNo };
      });
      return { kind: "ok", epoch: "E1", head: f.head, results };
    },
  };
  return f;
}
function stubDb(): LibraryDb & { drafts: Map<string, FieldDraft> } {
  const drafts = new Map<string, FieldDraft>();
  return {
    drafts, allHeld: async () => [], putHeld: async () => {}, deleteHeld: async () => {}, allRecovery: async () => [], putRecovery: async () => {}, deleteRecovery: async () => {},
    allDrafts: async () => [...drafts.values()], putDraft: async (d) => { drafts.set(d.key, d); }, deleteDraft: async (k) => { drafts.delete(k); }, close: () => {},
  };
}
/** A ready client with a library and a book. `serve` adds a change that the fake server already holds and the client has pulled. */
function ready(f: Fake) {
  const c = new SyncClient(0, f.io);
  const serve = (kind: string, value: Record<string, unknown>) => {
    const ch: SyncChange = { seq: ++f.head, at: "2026-11-11T12:00:00Z", opId: U(6000 + f.head), deviceId: U(9), change: "create", recordKind: kind, recordId: String(value.id), value };
    f.changes.push(ch);
    applyChange(c.model, ch);
  };
  serve("library", { id: U(1), title: "L" });
  serve("book", { id: U(2), title: "Book", orderKey: "m" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = c as any;
  const db = stubDb();
  p.db = db;
  p.state = { ...p.state, phase: "ready", libraryId: U(1) };
  p.active = true; p.epoch = "E1"; p.epochKnown = true;
  return { c, p, db, serve };
}

test("opening the story bible twice sends the templates once", async () => {
  const f = fake();
  const { c } = ready(f);
  const m = c.model;
  await c.seedBible();
  assert.equal(f.pushes.length, 1);
  assert.equal(f.pushes[0]!.length, 23);
  assert.equal(c.getState().bible, "ready");
  await c.seedBible();
  assert.equal(f.pushes.length, 1, "nothing is sent the second time");
  assert.equal(m.records.get("template")?.size, 9);
  c.stop();
});

test("seeding that loses a race with another tab is not an error: a record that already exists is what was wanted", async () => {
  const f = fake();
  const { c } = ready(f);
  f.reply.push((ops) => ops.map((o) => ({ opId: o.opId, status: "rejected" as const, code: "RECORD_EXISTS", message: "A record with this id already exists." })));
  // the other tab made them: the feed shows them, but this client has not pulled yet
  for (const o of seedOps(c.model, opId)) f.changes.push({ seq: ++f.head, at: "2026-11-11T12:00:00Z", opId: String(o.opId), deviceId: U(9), change: "create", recordKind: String(o.recordKind), recordId: String(o.recordId), value: o.value });
  await c.seedBible();
  assert.equal(c.getState().bible, "ready");
  assert.equal(c.model.records.get("template")?.size, 9);
  c.stop();
});

// ---------- creating and saving entries ----------

type Ready = ReturnType<typeof ready>;
const withTemplates = (r: Ready) => { for (const o of seedOps(r.c.model, opId)) r.serve(String(o.recordKind), o.value as Record<string, unknown>); };
const newEntry = (r: Ready, id: string, type: "character" | "location" | "term" = "character") => {
  const made = newEntryValue(r.c.model, { id, type, name: "Mira Vale", toBeNamed: false, bookId: U(2) });
  assert.ok(made.ok);
  r.serve("entry", made.value);
};

test("a new entry is a create op with a fresh id, the built-in template, the book as its scope and empty values", async () => {
  const f = fake();
  const r = ready(f); const { c } = r;
  withTemplates(r);
  const a = await c.createEntry({ id: U(20), opId: U(21), type: "character", name: " Mira Vale ", toBeNamed: false, bookId: U(2) });
  const b = await c.createEntry({ id: U(22), opId: U(23), type: "location", name: "Hollow Reach", toBeNamed: false, bookId: U(2) });
  assert.deepEqual([a, b], [{ ok: true, id: U(20) }, { ok: true, id: U(22) }]);
  const [first, second] = f.pushes.map((p) => p[0]!);
  assert.equal(first!.op, "create"); assert.equal(first!.recordKind, "entry");
  const v = first!.value as Record<string, unknown>;
  assert.equal(v.id, U(20)); assert.equal(v.entryType, "character"); assert.equal(v.templateId, CHARACTER_TPL);
  assert.equal(v.name, "Mira Vale");
  assert.deepEqual(v.scope, { kind: "book", id: U(2) });
  assert.deepEqual(v.values, {}); assert.deepEqual(v.aliases, []); assert.deepEqual(v.overrides, []); assert.deepEqual(v.attachments, []);
  assert.match(String(v.createdAt), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/); assert.equal(v.createdAt, v.updatedAt);
  assert.equal("toBeNamed" in v, false);
  assert.equal((second!.value as Record<string, unknown>).templateId, "80000002-0000-4000-8000-000000000002");
  assert.notEqual(first!.recordId, second!.recordId);
  c.stop();
});

test("a name is needed unless the entry is to be named; the server's plain message is shown when it refuses a create", async () => {
  const f = fake();
  const r = ready(f); const { c } = r;
  withTemplates(r);
  const none = await c.createEntry({ id: U(20), opId: U(21), type: "term", name: "  ", toBeNamed: false, bookId: U(2) });
  assert.equal(none.ok, false);
  assert.equal(f.pushes.length, 0, "refused before it is sent");
  const tbn = await c.createEntry({ id: U(22), opId: U(23), type: "character", name: "", toBeNamed: true, bookId: U(2) });
  assert.equal(tbn.ok, true);
  assert.equal((f.pushes[0]![0]!.value as Record<string, unknown>).toBeNamed, true);
  assert.equal((f.pushes[0]![0]!.value as Record<string, unknown>).name, "Unnamed character");
  f.reply.push((ops) => [{ opId: ops[0]!.opId, status: "rejected", code: "INVALID_VALUE", message: "The value does not fit the record." }]);
  const refused = await c.createEntry({ id: U(24), opId: U(25), type: "term", name: "Lumen", toBeNamed: false, bookId: U(2) });
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.message, /The value does not fit the record\./);
  assert.match(refused.ok ? "" : refused.message, /still here/);
  c.stop();
});

test("saving a field sends a set op with the field's baseSeq; Saved only after the server answered; the text is on the device first", async () => {
  const f = fake();
  const r = ready(f); const { c, db } = r;
  withTemplates(r);
  newEntry(r, U(30));
  const base = c.baseOfField(U(30), "summary");
  assert.equal(base, c.model.seqs.get(`entry/${U(30)}`));
  let release!: () => void;
  const gate = new Promise<void>((ok) => { release = ok; });
  f.before = async () => { await gate; };
  const saving = c.saveEntryField({ entryId: U(30), field: "summary", value: "Reads letters twice.", input: "Reads letters twice.", base });
  await new Promise((ok) => setImmediate(ok));
  assert.equal(c.getState().fields.get(`${U(30)}/summary`)?.state, "saving", "not Saved before the server answers");
  assert.equal(db.drafts.get(`${U(30)}/summary`)?.input, "Reads letters twice.", "kept on this device before it is sent");
  release();
  assert.deepEqual(await saving, { kind: "saved" });
  assert.equal(c.getState().fields.get(`${U(30)}/summary`)?.state, "saved");
  assert.equal(db.drafts.size, 0, "the copy goes only after the server applied it");
  const op = f.pushes[0]![0]!;
  assert.deepEqual({ op: op.op, recordKind: op.recordKind, field: op.field, baseSeq: op.baseSeq, value: op.value }, { op: "set", recordKind: "entry", field: "summary", baseSeq: base, value: "Reads letters twice." });
  assert.equal(c.model.records.get("entry")!.get(U(30))!.summary, "Reads letters twice.", "the model shows the saved value after the pull");
  // A template field is named values/<fieldId>.
  const age = "90000003-0000-4000-8000-000000000003";
  assert.deepEqual(await c.saveEntryField({ entryId: U(30), field: `values/${age}`, value: 24, input: "24", base: c.baseOfField(U(30), `values/${age}`) }), { kind: "saved" });
  assert.equal(f.pushes[1]![0]!.field, `values/${age}`);
  // Removing a value is an unset.
  assert.deepEqual(await c.saveEntryField({ entryId: U(30), field: "summary", value: undefined, input: "", base: c.baseOfField(U(30), "summary") }), { kind: "saved" });
  assert.equal(f.pushes[2]![0]!.op, "unset");
  c.stop();
});

test("a value of the wrong type is not sent, and the text stays on the device", async () => {
  const f = fake();
  const r = ready(f); const { c, db } = r;
  withTemplates(r);
  newEntry(r, U(30));
  const age = "90000003-0000-4000-8000-000000000003";
  const out = await c.saveEntryField({ entryId: U(30), field: `values/${age}`, value: "twenty", input: "twenty", base: 0 });
  assert.equal(out.kind, "invalid");
  assert.match(out.message ?? "", /whole number/);
  assert.equal(f.pushes.length, 0);
  assert.equal(db.drafts.get(`${U(30)}/values/${age}`)?.input, "twenty");
  assert.equal(c.getState().fields.get(`${U(30)}/values/${age}`)?.state, "invalid");
  // A decimal given as a number, a field the template does not have, and a given name on a place are refused too.
  const decimal = "90000004-0000-4000-8000-000000000004";
  assert.equal((await c.saveEntryField({ entryId: U(30), field: `values/${decimal}`, value: 1.68, input: "1.68", base: 0 })).kind, "invalid");
  assert.equal((await c.saveEntryField({ entryId: U(30), field: `values/${U(999)}`, value: "x", input: "x", base: 0 })).kind, "invalid");
  newEntry(r, U(31), "location");
  assert.equal((await c.saveEntryField({ entryId: U(31), field: "givenName", value: "Mira", input: "Mira", base: 0 })).kind, "invalid");
  assert.equal(f.pushes.length, 0, "none of them was sent");
  assert.equal(checkEntryField(c.model, c.model.records.get("entry")!.get(U(30))!, "givenName", "Mira"), undefined, "a character may have a given name");
  c.stop();
});

test("a rejected value (INVALID_VALUE) shows the server's message, keeps the text, and a later good save is a new op", async () => {
  const f = fake();
  const r = ready(f); const { c, db } = r;
  withTemplates(r);
  newEntry(r, U(30));
  f.reply.push((ops) => [{ opId: ops[0]!.opId, status: "rejected", code: "INVALID_VALUE", message: "The value does not fit the record." }]);
  const out = await c.saveEntryField({ entryId: U(30), field: "summary", value: "x", input: "x", base: 0 });
  assert.equal(out.kind, "refused");
  assert.match(out.message ?? "", /^The value does not fit the record\./);
  assert.equal(db.drafts.get(`${U(30)}/summary`)?.state, "refused");
  assert.equal(c.draftFor(`${U(30)}/summary`)?.input, "x");
  const first = f.pushes[0]![0]!.opId;
  assert.deepEqual(await c.saveEntryField({ entryId: U(30), field: "summary", value: "y", input: "y", base: 0 }), { kind: "saved" });
  assert.notEqual(f.pushes[1]![0]!.opId, first);
  assert.equal(db.drafts.size, 0);
  c.stop();
});

test("a failed push keeps the text and says it is not saved; the retry is the same op", async () => {
  const f = fake();
  const r = ready(f); const { c, db } = r;
  withTemplates(r);
  newEntry(r, U(30));
  let down = true;
  const seen: string[] = [];
  f.before = async (ops) => { seen.push(ops[0]!.opId); if (down) throw new Error("offline"); };
  const out = await c.saveEntryField({ entryId: U(30), field: "summary", value: "x", input: "x", base: 5 });
  assert.equal(out.kind, "unsaved");
  assert.match(out.message ?? "", /Not saved yet/);
  assert.equal(db.drafts.get(`${U(30)}/summary`)?.input, "x");
  down = false;
  assert.deepEqual(await c.saveEntryField({ entryId: U(30), field: "summary", value: "x", input: "x", base: 5 }), { kind: "saved" });
  assert.equal(new Set(seen).size, 1, "a retry after a lost answer is the same op, so it cannot apply twice");
  c.stop();
});

test("entries are listed by type, from the books that can see them", () => {
  seq = 0;
  const m = emptyModel();
  applyChange(m, change({ change: "create", recordKind: "library", recordId: U(1), value: { id: U(1), title: "L" } }));
  applyChange(m, change({ change: "create", recordKind: "book", recordId: U(2), value: { id: U(2), title: "B", orderKey: "m", universeId: U(50) } }));
  applyChange(m, change({ change: "create", recordKind: "book", recordId: U(3), value: { id: U(3), title: "C", orderKey: "n" } }));
  const e = (id: string, type: string, name: string, scope: unknown, extra: Record<string, unknown> = {}) =>
    applyChange(m, change({ change: "create", recordKind: "entry", recordId: id, value: { id, entryType: type, name, scope, aliases: [], values: {}, overrides: [], attachments: [], ...extra } }));
  e(U(10), "character", "Zed", { kind: "book", id: U(2) });
  e(U(11), "character", "Ada", { kind: "universe", id: U(50) });
  e(U(12), "location", "Port", { kind: "book", id: U(3) });
  e(U(13), "character", "Trashed", { kind: "book", id: U(2) });
  m.records.get("entry")!.get(U(13))!.deletedAt = "2026-11-11T12:00:00Z";
  assert.deepEqual(entriesOfType(m, ["character"], U(2)).map((x) => x.name), ["Ada", "Zed"]);
  assert.deepEqual(entriesOfType(m, ["character"], U(3)).map((x) => x.name), []);
  assert.deepEqual(entriesOfType(m, ["location", "term"], U(3)).map((x) => x.name), ["Port"]);
  assert.equal(BUILTIN_FIELDS.length, 14);
});

// ---------- M1-10 slice 1 review fixes ----------

const gate = () => { let open!: () => void; const p = new Promise<void>((ok) => { open = ok; }); return { p, open }; };
const tick = () => new Promise<void>((ok) => setImmediate(ok));

test("two overlapping saves of one field (ticked, then unticked) end with the server holding the last value; no Saved for the older one", async () => {
  const f = fake();
  const r = ready(f); const { c, db } = r;
  withTemplates(r);
  newEntry(r, U(30));
  const key = `${U(30)}/toBeNamed`;
  const base = c.baseOfField(U(30), "toBeNamed");
  const g = gate();
  let n = 0;
  f.before = async () => { if (++n === 1) await g.p; }; // the first answer is slow
  const savedWhen: number[] = [];
  c.subscribe(() => { if (c.getState().fields.get(key)?.state === "saved") savedWhen.push(f.pushes.length); });
  const first = c.saveEntryField({ entryId: U(30), field: "toBeNamed", value: true, input: "yes", base });
  await tick();
  const second = c.saveEntryField({ entryId: U(30), field: "toBeNamed", value: undefined, input: "", base });
  await tick();
  assert.equal(f.pushes.length, 1, "the second save waits for the first");
  assert.equal(db.drafts.get(key)?.input, "", "the newest input is on the device while the older one is in flight");
  assert.notEqual(c.getState().fields.get(key)?.state, "saved");
  g.open();
  await Promise.all([first, second]);
  assert.equal(f.pushes.length, 2);
  const [a, b] = [f.pushes[0]![0]!, f.pushes[1]![0]!];
  assert.equal(a.op, "set"); assert.equal(b.op, "unset");
  assert.equal(b.baseSeq, f.changes.find((x) => x.opId === a.opId)!.seq, "the second save is made against the first, so it cannot conflict with it");
  assert.equal(c.model.records.get("entry")!.get(U(30))!.toBeNamed, undefined, "the server holds the last value");
  assert.equal(db.drafts.size, 0, "no draft of an older input is left, and the newest one is confirmed");
  assert.equal(c.getState().fields.get(key)?.state, "saved");
  assert.deepEqual(savedWhen.filter((x) => x < 2), [], "Saved never showed for the older value");
  c.stop();
});

test("an older answer does not discard the draft of a newer input", async () => {
  const f = fake();
  const r = ready(f); const { c, db } = r;
  withTemplates(r);
  newEntry(r, U(30));
  const key = `${U(30)}/summary`;
  const base = c.baseOfField(U(30), "summary");
  const g = gate();
  let n = 0;
  f.before = async () => { if (++n === 1) await g.p; else await new Promise(() => {}); }; // the second push never answers
  const first = c.saveEntryField({ entryId: U(30), field: "summary", value: "one", input: "one", base });
  await tick();
  void c.saveEntryField({ entryId: U(30), field: "summary", value: "two", input: "two", base });
  await tick();
  g.open();
  await first;
  await tick(); await tick();
  assert.equal(db.drafts.get(key)?.input, "two", "the answer for 'one' leaves the draft of 'two'");
  assert.equal(c.getState().fields.get(key)?.state, "saving", "and does not say Saved");
  c.stop();
});

test("an epoch change keeps the text typed in a bible field and not yet left, resets the bible, and the seeding runs again", async () => {
  const f = fake();
  const r = ready(f); const { c, p, db } = r;
  withTemplates(r);
  newEntry(r, U(30));
  await c.seedBible();
  assert.equal(c.getState().bible, "ready");
  assert.equal(f.pushes.length, 0, "the templates were there");
  // A field on screen with text that was typed and not left.
  c.registerFieldKeeper(`${U(30)}/summary`, () => ({ entryId: U(30), field: "summary", input: "typed, never left", base: 7 }));
  // The server now has another history: a library and a book only.
  const lib = f.changes.find((x) => x.recordKind === "library")!, book = f.changes.find((x) => x.recordKind === "book")!;
  f.changes = [{ ...lib, seq: 1 }, { ...book, seq: 2 }]; f.head = 2;
  const real = f.io.getChanges!;
  let flip = true;
  const epochs: Array<string | undefined> = [];
  c.subscribe(() => epochs.push(c.getState().epoch));
  p.io.getChanges = (e: string, a: number) => (flip ? (flip = false, Promise.resolve({ kind: "resync" as const, epoch: "E2", head: 2 })) : real(e, a));
  await c.pull();
  const saved = db.drafts.get(`${U(30)}/summary`);
  assert.equal(saved?.input, "typed, never left", "the text is on the device");
  assert.equal(saved?.state, "conflict", "it is never sent as it is: its base belongs to the old history");
  assert.equal(c.getState().fields.get(`${U(30)}/summary`)?.state, "conflict");
  assert.match(c.getState().fields.get(`${U(30)}/summary`)?.message ?? "", /kept on this device/);
  assert.equal(c.getState().epoch, "E2");
  assert.equal(c.getState().bible, "idle", "the bible is read again from the new history");
  assert.ok(epochs.includes("E2"));
  assert.equal(f.pushes.length, 0, "nothing was sent under the new epoch");
  await c.seedBible();
  assert.equal(f.pushes.length, 1, "the seeding ran again");
  assert.equal(f.pushes[0]!.length, 23);
  assert.equal(c.getState().bible, "ready");
  c.stop();
});

test("a field with nothing unsent is not written to the device when the epoch changes", async () => {
  const f = fake();
  const r = ready(f); const { c, db } = r;
  c.registerFieldKeeper(`${U(30)}/summary`, () => undefined);
  (c as unknown as { adoptEpoch(e: string): void }).adoptEpoch("E2");
  await tick();
  assert.equal(db.drafts.size, 0);
  c.stop();
});

test("a refused create is not a lost answer, so its retry may use a new op id; an offline create is", async () => {
  const f = fake();
  const r = ready(f); const { c } = r;
  withTemplates(r);
  f.reply.push((ops) => [{ opId: ops[0]!.opId, status: "rejected", code: "INVALID_VALUE", message: "The value does not fit the record." }]);
  const refused = await c.createEntry({ id: U(40), opId: U(41), type: "term", name: "Lumen", toBeNamed: false, bookId: U(2) });
  assert.equal(refused.ok, false);
  assert.equal(refused.ok ? undefined : refused.lost, undefined);
  const real = f.io.pushOps!;
  f.io.pushOps = async () => { throw new Error("offline"); };
  (c as unknown as { io: ClientIo }).io.pushOps = f.io.pushOps;
  const lost = await c.createEntry({ id: U(40), opId: U(41), type: "term", name: "Lumen", toBeNamed: false, bookId: U(2) });
  assert.equal(lost.ok ? undefined : lost.lost, true);
  (c as unknown as { io: ClientIo }).io.pushOps = real;
  c.stop();
});

test("a trashed built-in template is not used: no entry is made against it, and seeding does not give it fields", async () => {
  const f = fake();
  const r = ready(f); const { c } = r;
  withTemplates(r);
  c.model.records.get("template")!.get(CHARACTER_TPL)!.deletedAt = "2026-11-11T12:00:00Z";
  assert.equal(builtInTemplate(c.model, "character"), undefined);
  assert.equal(builtInTemplate(c.model, "location")?.id, "80000002-0000-4000-8000-000000000002");
  const made = newEntryValue(c.model, { id: U(50), type: "character", name: "Mira", toBeNamed: false, bookId: U(2) });
  assert.equal(made.ok, false);
  assert.match(made.ok ? "" : made.error, /in the trash/);
  const out = await c.createEntry({ id: U(50), opId: U(51), type: "character", name: "Mira", toBeNamed: false, bookId: U(2) });
  assert.equal(out.ok, false);
  assert.equal(f.pushes.length, 0, "nothing is sent");
  // An empty model with a trashed template of ours: no second template with its id, and no fields for it.
  seq = 0;
  const m = emptyModel();
  applyChange(m, change({ change: "create", recordKind: "template", recordId: CHARACTER_TPL, value: { id: CHARACTER_TPL, name: "Character", entryType: "character", builtIn: true, orderKey: "a", createdAt: "x", updatedAt: "x" } }));
  applyChange(m, change({ change: "tombstone", recordKind: "template", recordId: CHARACTER_TPL }));
  const ops = seedOps(m, opId);
  assert.equal(ops.some((o) => o.recordId === CHARACTER_TPL), false);
  assert.equal(ops.some((o) => o.recordKind === "field" && (o.value as { templateId: string }).templateId === CHARACTER_TPL), false);
  c.stop();
});

test("a refused seeding does not say the library changed; a changed library does", async () => {
  const f = fake();
  const { c, p } = ready(f);
  const real = f.io.pushOps!;
  p.io.pushOps = async () => ({ kind: "invalid" as const });
  await c.seedBible();
  assert.equal(c.getState().bible, "failed");
  assert.match(c.getState().bibleMessage ?? "", /story bible could not be set up/);
  assert.doesNotMatch(c.getState().bibleMessage ?? "", /library changed/);
  p.io.pushOps = async () => ({ kind: "resync" as const, epoch: "E1", head: 5 });
  await c.seedBible();
  assert.equal(c.getState().bibleMessage, RETRY_MESSAGE, "the same epoch is not a changed library");
  assert.doesNotMatch(c.getState().bibleMessage ?? "", /library changed/);
  // A really different epoch is a changed library (the seeding then runs once more for the new epoch, which this stub also answers).
  const said: string[] = [];
  c.subscribe(() => said.push(c.getState().bibleMessage ?? ""));
  p.io.pushOps = async () => ({ kind: "resync" as const, epoch: "E7", head: 5 });
  await c.seedBible();
  assert.ok(said.some((m) => /library changed/.test(m)), "the changed epoch said so");
  p.io.pushOps = real;
  c.stop();
});

test("a create and a field save answered with a resync of the same epoch say to try again, not that the library changed", async () => {
  const f = fake();
  const r = ready(f); const { c, p, db } = r;
  withTemplates(r);
  newEntry(r, U(30));
  p.io.pushOps = async () => ({ kind: "resync" as const, epoch: "E1", head: 5 });
  const made = await c.createEntry({ id: U(40), opId: U(41), type: "term", name: "Lumen", toBeNamed: false, bookId: U(2) });
  assert.equal(made.ok, false);
  assert.match(made.ok ? "" : made.message, /did not have the version it was expecting/);
  assert.doesNotMatch(made.ok ? "" : made.message, /library changed/);
  const out = await c.saveEntryField({ entryId: U(30), field: "summary", value: "x", input: "x", base: 0 });
  assert.equal(out.kind, "unsaved");
  assert.match(out.message ?? "", /did not have the version it was expecting/);
  assert.equal(db.drafts.get(`${U(30)}/summary`)?.state, "unsent", "the text is kept and Save now stays offered");
  c.stop();
});

// ---------- M1-10 slice 1 re-review fixes ----------

/** The server shows another history (a library and a book only), the client pulls and the routing is done. */
async function changeEpoch(f: Fake, r: Ready, to = "E2") {
  const lib = f.changes.find((x) => x.recordKind === "library")!, book = f.changes.find((x) => x.recordKind === "book")!;
  f.changes = [{ ...lib, seq: 1 }, { ...book, seq: 2 }]; f.head = 2;
  const real = f.io.getChanges!;
  let flip = true;
  r.p.io.getChanges = (e: string, a: number) => (flip ? (flip = false, Promise.resolve({ kind: "resync" as const, epoch: to, head: 2 })) : real(e, a));
  await r.c.pull();
}

test("a save made with a base read before an epoch change is not sent: a conflict draft with the history reason, and the conflict choice", async () => {
  const f = fake();
  const r = ready(f); const { c, db } = r;
  withTemplates(r);
  newEntry(r, U(30));
  const key = `${U(30)}/summary`;
  const base = c.baseOfField(U(30), "summary"), gen = c.generation;
  c.registerFieldKeeper(key, () => ({ entryId: U(30), field: "summary", input: "typed", base }));
  await changeEpoch(f, r);
  assert.equal(c.generation, gen + 1);
  assert.equal(c.getState().epoch, "E2");
  // Routing is done: only the generation stands between this text and a push under the new epoch.
  const out = await c.saveEntryField({ entryId: U(30), field: "summary", value: "typed", input: "typed", base, gen });
  assert.equal(out.kind, "conflict");
  assert.equal(f.pushes.length, 0, "nothing was pushed");
  assert.equal(db.drafts.get(key)?.state, "conflict");
  assert.equal(db.drafts.get(key)?.reason, HISTORY_REASON);
  assert.equal(db.drafts.get(key)?.input, "typed");
  assert.equal(c.getState().fields.get(key)?.state, "conflict", "the page shows Keep my text / Use the saved text for this state");
  assert.equal(c.getState().fields.get(key)?.message, HISTORY_MESSAGE);
  assert.equal(c.draftFor(key)?.reason, HISTORY_REASON);
  // "Keep my text" takes a fresh base and generation: that one is sent, as a new op.
  r.serve("entry", { ...c.model.records.get("entry")?.get(U(30)) ?? { id: U(30), entryType: "character", name: "Mira Vale", scope: { kind: "book", id: U(2) }, aliases: [], values: {}, overrides: [], attachments: [] }, id: U(30) });
  const again = await c.saveEntryField({ entryId: U(30), field: "summary", value: "typed", input: "typed", base: c.baseOfField(U(30), "summary"), gen: c.generation });
  assert.equal(again.kind, "saved");
  assert.equal(f.pushes.length, 1);
  c.stop();
});

test("a blur after an epoch change does not push the old base, however often it happens, and a save without a generation is taken as fresh", async () => {
  const f = fake();
  const r = ready(f); const { c } = r;
  withTemplates(r);
  newEntry(r, U(30));
  const base = c.baseOfField(U(30), "summary"), gen = c.generation;
  await changeEpoch(f, r);
  for (let i = 0; i < 3; i++) {
    // The field on screen keeps the generation it read the base under; blur calls this with it each time.
    assert.equal((await c.saveEntryField({ entryId: U(30), field: "summary", value: "x", input: "x", base, gen })).kind, "conflict");
  }
  assert.equal(f.pushes.length, 0);
  // A draft kept under the old history is the same: the page takes generation -1 for it.
  assert.equal(c.generationFor({ key: "k", entryId: U(30), field: "summary", input: "x", base, state: "unsent", epoch: "E1", savedAt: "x" }), -1);
  assert.equal(c.generationFor(undefined), c.generation);
  c.stop();
});

test("a save answered ok before an epoch change does not record an old-history seq under the new epoch", async () => {
  const f = fake();
  const r = ready(f); const { c } = r;
  withTemplates(r);
  newEntry(r, U(30));
  const g = gate();
  f.before = async () => { await g.p; };
  const base = c.baseOfField(U(30), "summary");
  const saving = c.saveEntryField({ entryId: U(30), field: "summary", value: "x", input: "x", base });
  await tick();
  assert.equal(f.pushes.length, 1);
  (c as unknown as { adoptEpoch(e: string): void }).adoptEpoch("E2"); // the history changes while the answer is on its way
  g.open();
  await saving;
  assert.equal((c as unknown as { fieldOwnSeq: Map<string, number> }).fieldOwnSeq.size, 0);
  c.stop();
});

test("a draft saved under one epoch and loaded under another is a conflict, and Save now does not push it", async () => {
  const f = fake();
  const r = ready(f); const { c, p } = r;
  withTemplates(r);
  newEntry(r, U(30));
  const key = `${U(30)}/summary`;
  p.drafts.set(key, { key, entryId: U(30), field: "summary", input: "from before", base: 3, state: "unsent", epoch: "E0", savedAt: "x" });
  const d = c.draftFor(key)!;
  assert.equal(d.state, "conflict");
  assert.equal(d.reason, HISTORY_REASON);
  assert.equal(c.generationFor(d), -1);
  const out = await c.saveEntryField({ entryId: U(30), field: "summary", value: "from before", input: "from before", base: d.base, gen: c.generationFor(d) });
  assert.equal(out.kind, "conflict");
  assert.equal(f.pushes.length, 0);
  // One saved under the current epoch is still unsent.
  p.drafts.set(key, { key, entryId: U(30), field: "summary", input: "now", base: 3, state: "unsent", epoch: "E1", savedAt: "x" });
  assert.equal(c.draftFor(key)!.state, "unsent");
  c.stop();
});

test("an epoch change during seeding makes one more seeding run for the new epoch", async () => {
  const f = fake();
  const r = ready(f); const { c, p } = r;
  const g = gate();
  f.before = async () => { await g.p; };
  const realSeed = p.doSeed.bind(p);
  let runs = 0;
  p.doSeed = () => { runs++; return realSeed(); };
  const seeding = c.seedBible();
  await tick(); await tick();
  assert.equal(f.pushes.length, 1);
  p.adoptEpoch("E2");
  assert.equal(c.seedBible(), seeding, "the same promise is returned");
  g.open();
  await seeding;
  assert.equal(runs, 2, "the second run is for the new epoch");
  c.stop();
});
