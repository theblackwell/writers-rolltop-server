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
  bibleReady, builtInTemplate, checkEntryField, checkEventField, checkRecordField, checkStateChangeField, encodeEventInput, eventInputOf, eventsOf, newEventValue, newStateChangeValue, nextMoveAttempt, attemptAfterFailedMove, EARLIER_MOVE_FIRST, EARLIER_MOVE_MAY_HAVE_WORKED, participantItem, nodesInScope, encodeRecordInput, newFactValue, newQuestionValue, recordInputOf, encodeInput, encodeText, entriesOfType, fieldsOf, inputOf, newEntryValue, seedOps, validateValue,
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

interface Fake { io: Partial<ClientIo>; pushes: Op[][]; changes: SyncChange[]; reply: Array<(ops: Op[]) => OpResult[] | undefined>; head: number; before: ((ops: Op[]) => Promise<void>) | undefined; lose?: (ops: Op[]) => boolean }
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
      if (f.lose?.(ops)) throw new Error("answer lost"); // applied on the server, but the answer never arrives
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

// ---------- facts and questions (slice 2) ----------

/** A model with a book, a chapter and a scene, a second book, and a character and a place in the first book. */
function storyModel(): Model {
  seq = 0;
  const m = emptyModel();
  const mk = (kind: string, value: Record<string, unknown>) => applyChange(m, change({ change: "create", recordKind: kind, recordId: String(value.id), value }));
  mk("library", { id: U(1), title: "L" });
  mk("book", { id: U(2), title: "Book", orderKey: "m" });
  mk("book", { id: U(3), title: "Other", orderKey: "n" });
  mk("manuscriptNode", { id: U(10), bookId: U(2), kind: "chapter", title: "C", orderKey: "m" });
  mk("manuscriptNode", { id: U(11), bookId: U(2), parentId: U(10), kind: "scene", title: "S", orderKey: "m" });
  mk("manuscriptNode", { id: U(12), bookId: U(3), kind: "scene", title: "Elsewhere", orderKey: "m" });
  mk("manuscriptNode", { id: U(13), bookId: U(2), kind: "part", title: "P", orderKey: "z" });
  const scope = { kind: "book", id: U(2) };
  mk("entry", { id: U(20), entryType: "character", name: "Ada", scope, aliases: [], values: {}, overrides: [], attachments: [] });
  mk("entry", { id: U(21), entryType: "location", name: "Hall", scope, aliases: [], values: {}, overrides: [], attachments: [] });
  return m;
}

test("a new fact or question is a whole archive record for the book's scope, with an order key that sorts after the others", () => {
  const m = storyModel();
  const a = newFactValue(m, { id: U(40), text: "  The bridge is closed.  ", bookId: U(2) });
  assert.ok(a.ok);
  assert.deepEqual({ ...a.value, orderKey: undefined, createdAt: undefined, updatedAt: undefined },
    { id: U(40), scope: { kind: "book", id: U(2) }, text: "The bridge is closed.", truth: "undecided", entryIds: [], knowledge: [], orderKey: undefined, createdAt: undefined, updatedAt: undefined });
  assert.match(String(a.value.orderKey), /^[0-9a-z]*[1-9a-z]$/);
  applyChange(m, change({ change: "create", recordKind: "fact", recordId: U(40), value: { ...a.value, orderKey: "zzzzzzzzzzzz" } })); // a key from a clock far ahead
  const b = newFactValue(m, { id: U(41), text: "Next", bookId: U(2) });
  assert.ok(b.ok && String(b.value.orderKey) > "zzzzzzzzzzzz" && !String(b.value.orderKey).endsWith("0"));
  const q = newQuestionValue(m, { id: U(42), text: "Who?", bookId: U(2) });
  assert.ok(q.ok);
  assert.deepEqual([q.value.status, q.value.entryIds, "topic" in q.value, "decision" in q.value], ["open", [], false, false]);
  assert.equal(newFactValue(m, { id: U(43), text: "   ", bookId: U(2) }).ok, false);
  assert.equal(newQuestionValue(m, { id: U(43), text: "x".repeat(20001), bookId: U(2) }).ok, false);
  assert.equal(newQuestionValue(m, { id: U(43), text: "a\u0000b", bookId: U(2) }).ok, false);
});

test("the checks for a fact's and a question's fields follow the archive rules", () => {
  const m = storyModel();
  const fact = { id: U(40), scope: { kind: "book", id: U(2) } };
  const check = (kind: "fact" | "question", field: string, value: unknown) => checkRecordField(m, kind, fact, field, value);
  assert.match(check("fact", "text", "")!, /needed/);
  assert.match(check("fact", "text", "x".repeat(20001))!, /at most 20,000/);
  assert.equal(check("fact", "text", "x".repeat(20000)), undefined);
  assert.match(check("fact", "truth", "maybe")!, /true, false/);
  assert.equal(check("fact", "truth", "undecided"), undefined);
  assert.match(check("fact", "status", "open")!, /cannot be changed/, "a fact has no status");
  assert.match(check("question", "truth", "true")!, /cannot be changed/, "a question has no truth");
  assert.match(check("question", "status", "closed")!, /open or decided/);
  assert.equal(check("question", "topic", undefined), undefined);
  assert.match(check("question", "topic", "")!, /needed/);
  assert.match(check("question", "topic", "t".repeat(65))!, /at most 64/);
  assert.equal(check("question", "topic", "t".repeat(64)), undefined);
  assert.equal(check("question", "decision", "x".repeat(20000)), undefined);
  assert.match(check("question", "decision", "x".repeat(20001))!, /at most 20,000/);
  // scene: a chapter or a scene in a book of the scope
  assert.equal(check("fact", "nodeId", U(11)), undefined);
  assert.equal(check("fact", "nodeId", U(10)), undefined);
  assert.equal(check("fact", "nodeId", undefined), undefined);
  assert.match(check("fact", "nodeId", U(12))!, /outside/);
  assert.match(check("fact", "nodeId", U(13))!, /chapter or a scene/);
  assert.match(check("fact", "nodeId", U(99))!, /not in the library/);
  // entries: unique, known
  assert.equal(check("fact", "entryIds", [U(20), U(21)]), undefined);
  assert.equal(check("fact", "entryIds", []), undefined);
  assert.match(check("fact", "entryIds", [U(20), U(20)])!, /twice/);
  assert.match(check("fact", "entryIds", [U(99)])!, /not in the library/);
  assert.match(check("fact", "entryIds", "x")!, /list/);
  // knowledge: the reader or a character, once each
  assert.equal(check("fact", "knowledge", [{ knower: "reader" }, { knower: U(20), nodeId: U(11) }]), undefined);
  assert.match(check("fact", "knowledge", [{ knower: U(21) }])!, /character/);
  assert.match(check("fact", "knowledge", [{ knower: "reader" }, { knower: "reader" }])!, /twice/);
  assert.match(check("fact", "knowledge", [{ knower: "reader", extra: 1 }])!, /list/);
  assert.match(check("fact", "knowledge", [{ knower: U(20), nodeId: U(12) }])!, /outside/);
  assert.match(check("question", "knowledge", [])!, /cannot be changed/);
});

test("what the controls show and send for entries and who knows a fact: whole arrays, and a knower keeps the scene they learn it in", () => {
  const rec = { id: U(40), text: "T", truth: "false", entryIds: [U(20)], knowledge: [{ knower: "reader" }, { knower: U(20), nodeId: U(11) }] };
  assert.deepEqual(recordInputOf("entryIds", rec), [U(20)]);
  assert.deepEqual(recordInputOf("knowledge", rec), ["reader", U(20)]);
  assert.equal(recordInputOf("truth", rec), "false");
  assert.equal(recordInputOf("topic", rec), "");
  assert.deepEqual(encodeRecordInput("entryIds", [U(21), U(20)], rec.entryIds), { ok: true, value: [U(21), U(20)] });
  assert.deepEqual(encodeRecordInput("entryIds", [], rec.entryIds), { ok: true, value: [] }, "an empty list is a set, not an unset");
  assert.deepEqual(encodeRecordInput("knowledge", ["reader", U(20)], rec.knowledge), { ok: true, value: [{ knower: "reader" }, { knower: U(20), nodeId: U(11) }] });
  assert.deepEqual(encodeRecordInput("knowledge", [U(20)], rec.knowledge), { ok: true, value: [{ knower: U(20), nodeId: U(11) }] });
  assert.deepEqual(encodeRecordInput("topic", "  ", undefined), { ok: true, value: undefined });
  assert.deepEqual(encodeRecordInput("topic", " Overlord ", undefined), { ok: true, value: "Overlord" });
  assert.deepEqual(encodeRecordInput("text", " x ", undefined), { ok: true, value: "x" });
});

test("a fact is created and saved through the client as record kind fact; an unset and an array set go out as such; a bad value is not sent", async () => {
  const f = fake();
  const { c, db, serve } = ready(f);
  serve("entry", { id: U(20), entryType: "character", name: "Ada", scope: { kind: "book", id: U(2) }, aliases: [], values: {}, overrides: [], attachments: [] });
  const out = await c.createStoryRecord({ kind: "fact", id: U(40), opId: U(41), text: "The bridge is closed.", bookId: U(2) });
  assert.deepEqual(out, { ok: true, id: U(40) });
  assert.deepEqual([f.pushes[0]![0]!.op, f.pushes[0]![0]!.recordKind, f.pushes[0]![0]!.opId], ["create", "fact", U(41)]);
  assert.equal(c.model.records.get("fact")!.get(U(40))!.truth, "undecided");
  const arr = await c.saveEntryField({ kind: "fact", entryId: U(40), field: "entryIds", value: [U(20)], input: [U(20)], base: c.baseOfField(U(40), "entryIds", "fact") });
  assert.deepEqual(arr, { kind: "saved" });
  const set = f.pushes[1]![0]!;
  assert.deepEqual({ op: set.op, recordKind: set.recordKind, field: set.field, value: set.value }, { op: "set", recordKind: "fact", field: "entryIds", value: [U(20)] });
  assert.deepEqual(c.model.records.get("fact")!.get(U(40))!.entryIds, [U(20)]);
  assert.deepEqual(await c.saveEntryField({ kind: "fact", entryId: U(40), field: "nodeId", value: undefined, input: "", base: c.baseOfField(U(40), "nodeId", "fact") }), { kind: "nothing" }, "nothing to remove");
  const before = f.pushes.length;
  const bad = await c.saveEntryField({ kind: "fact", entryId: U(40), field: "truth", value: "maybe", input: "maybe", base: 0 });
  assert.equal(bad.kind, "invalid");
  assert.equal(f.pushes.length, before, "nothing is sent");
  assert.equal(db.drafts.get(`${U(40)}/truth`)?.state, "refused");
  // A refused value from the server keeps the plain message with the fact's own noun
  f.reply.push((ops) => [{ opId: ops[0]!.opId, status: "rejected", code: "RECORD_DELETED", message: "x" }]);
  const gone = await c.saveEntryField({ kind: "fact", entryId: U(40), field: "truth", value: "true", input: "true", base: c.baseOfField(U(40), "truth", "fact") });
  assert.equal(gone.kind, "refused");
  assert.match(gone.message ?? "", /This fact is in the trash/);
  c.stop();
});

test("a knowledge entry that points at a trashed scene is still accepted, but a trashed scene is not offered", () => {
  const m = storyModel();
  applyChange(m, change({ change: "create", recordKind: "manuscriptNode", recordId: U(14), value: { id: U(14), bookId: U(2), parentId: U(10), kind: "scene", title: "Gone", orderKey: "n", deletedAt: "2026-01-01T00:00:00.000Z" } }));
  const fact = { id: U(40), scope: { kind: "book", id: U(2) } };
  const next = [{ knower: "reader", nodeId: U(14) }, { knower: U(20) }];
  assert.equal(checkRecordField(m, "fact", fact, "knowledge", next), undefined);
  assert.equal(checkRecordField(m, "fact", fact, "nodeId", U(14)), undefined);
  assert.ok(!nodesInScope(m, fact.scope).some((x) => x.id === U(14)), "not offered as a new choice");
  assert.match(checkRecordField(m, "fact", fact, "knowledge", [{ knower: "reader", nodeId: U(12) }])!, /outside/);
});

// ---------- events and state changes (slice 3) ----------

test("a new event is a whole archive record: title, book scope, a key after the others, empty scenes and participants, and nothing else", () => {
  const m = storyModel();
  assert.equal(newEventValue(m, { id: U(50), title: "  ", bookId: U(2) }).ok, false);
  assert.match((newEventValue(m, { id: U(50), title: "a\u0000b", bookId: U(2) }) as { error: string }).error, /cannot be stored/);
  const a = newEventValue(m, { id: U(50), title: " The storm ", bookId: U(2) });
  assert.ok(a.ok);
  assert.deepEqual(Object.keys(a.value).sort(), ["createdAt", "id", "orderKey", "participants", "sceneIds", "scope", "title", "updatedAt"]);
  assert.equal(a.value.title, "The storm");
  assert.deepEqual(a.value.scope, { kind: "book", id: U(2) });
  assert.match(String(a.value.orderKey), /^[0-9a-z]*[1-9a-z]$/);
  applyChange(m, change({ change: "create", recordKind: "event", recordId: U(50), value: a.value }));
  const b = newEventValue(m, { id: U(51), title: "Next", bookId: U(2) });
  assert.ok(b.ok && String(b.value.orderKey) > String(a.value.orderKey), "after the largest key");
});

test("events are listed by order key, then by id (not by the date's number); a removed event is not listed", () => {
  const m = storyModel();
  const mk = (id: string, orderKey: string, when?: unknown, extra: Record<string, unknown> = {}) =>
    applyChange(m, change({ change: "create", recordKind: "event", recordId: id, value: { id, scope: { kind: "book", id: U(2) }, title: id.slice(-2), orderKey, sceneIds: [], participants: [], ...(when ? { when } : {}), ...extra } }));
  mk(U(50), "b", { label: "x", ordinal: 9 }); mk(U(51), "b", { label: "y", ordinal: 2 }); mk(U(52), "a"); mk(U(53), "b"); mk(U(54), "c", undefined, { deletedAt: "2026-01-01T00:00:00Z" });
  mk(U(55), "a", undefined, { scope: { kind: "book", id: U(3) } });
  assert.deepEqual(eventsOf(m, U(2)).map((e) => e.id), [U(52), U(50), U(51), U(53)]);
});

test("the date of an event: label, number and calendar are one value; the label is needed; the number is a whole number", () => {
  assert.deepEqual(encodeEventInput("when", ["", "", ""]), { ok: true, value: undefined });
  assert.deepEqual(encodeEventInput("when", [" Third Moon ", " 388 ", " Lantern "]), { ok: true, value: { label: "Third Moon", calendar: "Lantern", ordinal: 388 } });
  assert.deepEqual(encodeEventInput("when", ["Dawn", "", ""]), { ok: true, value: { label: "Dawn" } });
  assert.deepEqual(encodeEventInput("when", ["Dawn", "-3", ""]), { ok: true, value: { label: "Dawn", ordinal: -3 } });
  assert.match((encodeEventInput("when", ["", "5", ""]) as { message: string }).message, /label is needed/);
  assert.match((encodeEventInput("when", ["Dawn", "1.5", ""]) as { message: string }).message, /whole number/);
  assert.match((encodeEventInput("when", ["Dawn", "9007199254740993", ""]) as { message: string }).message, /whole number/);
  assert.deepEqual(eventInputOf("when", { id: "x", when: { label: "A", ordinal: 4, calendar: "C" } }), ["A", "4", "C"]);
  assert.deepEqual(eventInputOf("when", { id: "x" }), ["", "", ""]);
});

test("event fields are checked before they are sent: scenes only, no repeats, an event entry only, no repeated participants", () => {
  const m = storyModel();
  applyChange(m, change({ change: "create", recordKind: "entry", recordId: U(22), value: { id: U(22), entryType: "event", name: "Storm", scope: { kind: "book", id: U(2) } } }));
  const ev = { id: U(50), scope: { kind: "book", id: U(2) } };
  assert.equal(checkEventField(m, ev, "title", "Storm"), undefined);
  assert.match(checkEventField(m, ev, "title", "  ")!, /needed/);
  assert.equal(checkEventField(m, ev, "summary", undefined), undefined);
  assert.equal(checkEventField(m, ev, "sceneIds", [U(11)]), undefined);
  assert.match(checkEventField(m, ev, "sceneIds", [U(10)])!, /Choose a scene/, "a chapter is not a scene");
  assert.match(checkEventField(m, ev, "sceneIds", [U(11), U(11)])!, /twice/);
  assert.match(checkEventField(m, ev, "sceneIds", [U(12)])!, /outside/);
  assert.match(checkEventField(m, ev, "sceneIds", [U(99)])!, /not in the library/);
  assert.equal(checkEventField(m, ev, "entryId", U(22)), undefined);
  assert.match(checkEventField(m, ev, "entryId", U(20))!, /type event/);
  assert.equal(checkEventField(m, ev, "entryId", undefined), undefined);
  assert.equal(checkEventField(m, ev, "participants", [{ entryId: U(20), role: "witness" }, { entryId: U(21) }]), undefined);
  assert.match(checkEventField(m, ev, "participants", [{ entryId: U(20) }, { entryId: U(20), role: "x" }])!, /twice/);
  assert.match(checkEventField(m, ev, "participants", [{ entryId: U(99) }])!, /not in the library/);
  assert.match(checkEventField(m, ev, "when", { label: "" })!, /label/);
  assert.match(checkEventField(m, ev, "orderKey", "z")!, /cannot be changed/);
  assert.match(checkEventField(m, ev, "dismissedWarnings", [])!, /cannot be changed/);
  assert.deepEqual(encodeEventInput("participants", [participantItem(U(20), " witness "), participantItem(U(21), "")]), { ok: true, value: [{ entryId: U(20), role: "witness" }, { entryId: U(21) }] });
});

/** storyModel plus a template with an integer and a boolean field, an entry that uses it, one that has no template, and an event. */
function stateModel(): Model {
  const m = storyModel();
  const mk = (kind: string, value: Record<string, unknown>) => applyChange(m, change({ change: "create", recordKind: kind, recordId: String(value.id), value }));
  mk("template", { id: U(70), name: "Character", entryType: "character", builtIn: true, orderKey: "m" });
  mk("field", { id: U(71), templateId: U(70), key: "age", label: "Age", fieldType: "integer", orderKey: "m", multiple: false, required: false });
  mk("field", { id: U(72), templateId: U(70), key: "alive", label: "Alive", fieldType: "boolean", orderKey: "n", multiple: false, required: false });
  mk("field", { id: U(73), templateId: U(70), key: "portrait", label: "Portrait", fieldType: "attachment", orderKey: "o", multiple: false, required: false });
  mk("entry", { id: U(23), entryType: "character", name: "Bo", templateId: U(70), scope: { kind: "book", id: U(2) }, aliases: [], values: {}, overrides: [], attachments: [] });
  mk("event", { id: U(50), scope: { kind: "book", id: U(2) }, title: "Storm", orderKey: "m", sceneIds: [], participants: [] });
  return m;
}

test("a new state change needs a template field, a value of its type, and exactly one of an event or a scene in the entry's scope", () => {
  const m = stateModel();
  const base = { id: U(80), entryId: U(23), fieldId: U(71), input: "24" as string | string[], note: "", target: { eventId: U(50) } as { eventId: string } | { nodeId: string } | undefined };
  const ok = newStateChangeValue(m, base);
  assert.ok(ok.ok);
  assert.deepEqual({ ...ok.value, createdAt: undefined, updatedAt: undefined }, { id: U(80), entryId: U(23), fieldId: U(71), value: 24, eventId: U(50), createdAt: undefined, updatedAt: undefined });
  const onScene = newStateChangeValue(m, { ...base, target: { nodeId: U(11) }, note: " later " });
  assert.ok(onScene.ok && onScene.value.nodeId === U(11) && !("eventId" in onScene.value) && onScene.value.note === "later");
  const bad = (p: Partial<typeof base>) => (newStateChangeValue(m, { ...base, ...p }) as { error?: string }).error ?? "";
  assert.match(bad({ input: "abc" }), /whole number/);
  assert.match(bad({ input: "" }), /value is needed/);
  assert.match(bad({ fieldId: U(99) }), /field of this entry/);
  assert.match(bad({ fieldId: U(73) }), /cannot be changed here/, "an attachment field has no control yet");
  assert.match(bad({ target: undefined }), /Choose the event or scene/);
  assert.match(bad({ target: { nodeId: U(12) } }), /outside/);
  assert.match(bad({ target: { nodeId: U(13) } }), /Choose a chapter or a scene/);
  assert.match(bad({ target: { eventId: U(99) } }), /event is not in the library/);
  assert.match(bad({ entryId: U(20) }), /no template/, "an entry without a template cannot have state changes");
  assert.match(bad({ note: "a\u0000" }), /cannot be stored/);
});

test("a state change's value and note are checked against the entry's template field", () => {
  const m = stateModel();
  applyChange(m, change({ change: "create", recordKind: "stateChange", recordId: U(80), value: { id: U(80), entryId: U(23), fieldId: U(72), eventId: U(50), value: true } }));
  const c = m.records.get("stateChange")!.get(U(80))!;
  assert.equal(checkStateChangeField(m, c, "value", false), undefined);
  assert.match(checkStateChangeField(m, c, "value", "yes")!, /yes or no/);
  assert.match(checkStateChangeField(m, c, "value", undefined)!, /value is needed/);
  assert.equal(checkStateChangeField(m, c, "note", undefined), undefined);
  assert.equal(checkStateChangeField(m, c, "note", "later"), undefined);
  assert.match(checkStateChangeField(m, c, "note", 5)!, /cannot be stored/);
  assert.match(checkStateChangeField(m, c, "eventId", U(50))!, /cannot be changed/);
});

test("creating an event or a state change sends one create op; a lost answer keeps the same op id for the retry", async () => {
  const f = fake();
  const r = ready(f); const { c } = r;
  const out = await c.createEvent({ id: U(50), opId: U(51), title: "Storm", bookId: U(2) });
  assert.deepEqual(out, { ok: true, id: U(50) });
  assert.equal(f.pushes[0]![0]!.recordKind, "event"); assert.equal(f.pushes[0]![0]!.op, "create");
  assert.equal("dismissedWarnings" in (f.pushes[0]![0]!.value as object), false);
  f.reply.push((ops) => [{ opId: ops[0]!.opId, status: "rejected", code: "INTEGRITY_VIOLATION", message: "This does not fit." }]);
  const refused = await c.createEvent({ id: U(52), opId: U(53), title: "Again", bookId: U(2) });
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.message, /This does not fit\..*still here/);
  assert.equal((await c.createEvent({ id: U(54), opId: U(55), title: " ", bookId: U(2) })).ok, false);
  assert.equal(f.pushes.length, 2, "an empty title is not sent");
  c.stop();
});

test("removing and restoring send tombstone (with the newest seq this device has seen) and restore; an answer that says it is already so is fine", async () => {
  const f = fake();
  const r = ready(f); const { c } = r;
  r.serve("event", { id: U(50), scope: { kind: "book", id: U(2) }, title: "Storm", orderKey: "m", sceneIds: [], participants: [] });
  const head = c.model.cursor;
  assert.deepEqual(await c.tombstoneRecord("event", U(50)), { ok: true });
  assert.deepEqual({ ...f.pushes[0]![0]!, opId: undefined }, { opId: undefined, op: "tombstone", recordKind: "event", recordId: U(50), baseSeq: head });
  assert.ok(c.model.records.get("event")!.get(U(50))!.deletedAt, "the feed was read again");
  assert.deepEqual(await c.restoreRecord("event", U(50)), { ok: true });
  assert.deepEqual({ ...f.pushes[1]![0]!, opId: undefined }, { opId: undefined, op: "restore", recordKind: "event", recordId: U(50) });
  assert.equal(c.model.records.get("event")!.get(U(50))!.deletedAt, undefined);
  f.reply.push((ops) => [{ opId: ops[0]!.opId, status: "rejected", code: "RECORD_DELETED" }]);
  assert.deepEqual(await c.tombstoneRecord("event", U(50)), { ok: true });
  f.reply.push((ops) => [{ opId: ops[0]!.opId, status: "conflict", conflictId: U(90), current: { seq: 99 } }]);
  const clash = await c.tombstoneRecord("event", U(50));
  assert.equal(clash.ok, false);
  assert.match(clash.ok ? "" : clash.message, /changed on another device/);
  f.reply.push((ops) => [{ opId: ops[0]!.opId, status: "rejected", code: "RECORD_UNKNOWN" }]);
  assert.match((await c.restoreRecord("event", U(50)) as { message: string }).message, /not in the library any more/);
  c.stop();
});

test("moving a state change makes the new record first and removes the old one only after that was applied", async () => {
  const f = fake();
  const r = ready(f); const { c } = r;
  for (const [kind, v] of [
    ["template", { id: U(70), name: "Character", entryType: "character", builtIn: true, orderKey: "m" }],
    ["field", { id: U(71), templateId: U(70), key: "age", label: "Age", fieldType: "integer", orderKey: "m", multiple: false, required: false }],
    ["entry", { id: U(23), entryType: "character", name: "Bo", templateId: U(70), scope: { kind: "book", id: U(2) }, aliases: [], values: {}, overrides: [], attachments: [] }],
    ["event", { id: U(50), scope: { kind: "book", id: U(2) }, title: "Storm", orderKey: "m", sceneIds: [], participants: [] }],
    ["manuscriptNode", { id: U(11), bookId: U(2), kind: "scene", title: "S", orderKey: "m" }],
    ["stateChange", { id: U(80), entryId: U(23), fieldId: U(71), eventId: U(50), value: 24, note: "after the storm", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }],
  ] as const) r.serve(kind, v as Record<string, unknown>);
  // refused: the old record stays and no tombstone is sent
  f.reply.push((ops) => [{ opId: ops[0]!.opId, status: "rejected", code: "INTEGRITY_VIOLATION", message: "No." }]);
  const refused = await c.moveStateChange({ id: U(81), opId: U(82), oldId: U(80), target: { nodeId: U(11) } });
  assert.equal(refused.ok, false);
  assert.equal(f.pushes.length, 1);
  assert.equal(f.pushes[0]!.length, 1);
  assert.equal(c.model.records.get("stateChange")!.get(U(80))!.deletedAt, undefined);
  // applied: create (same value and note, a scene instead of the event), then the tombstone
  const ok = await c.moveStateChange({ id: U(83), opId: U(84), oldId: U(80), target: { nodeId: U(11) } });
  assert.deepEqual(ok, { ok: true });
  assert.equal(f.pushes.length, 3);
  const made = f.pushes[1]![0]!; const tomb = f.pushes[2]![0]!;
  assert.equal(made.op, "create"); assert.equal(f.pushes[1]!.length, 1);
  const v = made.value as Record<string, unknown>;
  assert.deepEqual({ ...v, createdAt: undefined, updatedAt: undefined }, { id: U(83), entryId: U(23), fieldId: U(71), value: 24, nodeId: U(11), note: "after the storm", createdAt: undefined, updatedAt: undefined });
  assert.equal("eventId" in v, false);
  assert.deepEqual({ ...tomb, opId: undefined, baseSeq: undefined }, { opId: undefined, op: "tombstone", recordKind: "stateChange", recordId: U(80), baseSeq: undefined });
  assert.ok(c.model.records.get("stateChange")!.get(U(80))!.deletedAt);
  // a target outside the scope is refused before anything is sent
  const outside = await c.moveStateChange({ id: U(85), opId: U(86), oldId: U(83), target: { nodeId: U(99) } });
  assert.equal(outside.ok, false);
  assert.equal(f.pushes.length, 3);
  c.stop();
});

function moveSetup() {
  const f = fake();
  const r = ready(f);
  for (const [kind, v] of [
    ["template", { id: U(70), name: "Character", entryType: "character", builtIn: true, orderKey: "m" }],
    ["field", { id: U(71), templateId: U(70), key: "age", label: "Age", fieldType: "integer", orderKey: "m", multiple: false, required: false }],
    ["entry", { id: U(23), entryType: "character", name: "Bo", templateId: U(70), scope: { kind: "book", id: U(2) }, aliases: [], values: {}, overrides: [], attachments: [] }],
    ["event", { id: U(50), scope: { kind: "book", id: U(2) }, title: "Storm", orderKey: "m", sceneIds: [], participants: [] }],
    ["manuscriptNode", { id: U(11), bookId: U(2), kind: "scene", title: "S", orderKey: "m" }],
    ["stateChange", { id: U(80), entryId: U(23), fieldId: U(71), eventId: U(50), value: 24, note: "n", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }],
  ] as const) r.serve(kind, v as Record<string, unknown>);
  return { f, c: r.c };
}
const live = (c: SyncClient) => [...c.model.records.get("stateChange")!.values()].filter((x) => !x.deletedAt);

test("a move whose answer was lost keeps its ids: the retry makes no second copy", async () => {
  const { f, c } = moveSetup();
  let lose = true;
  f.lose = () => { const was = lose; lose = false; return was; };
  const first = await c.moveStateChange({ id: U(81), opId: U(82), oldId: U(80), target: { nodeId: U(11) } });
  assert.equal(first.ok, false);
  assert.equal(!first.ok && first.lost, true);
  const again = await c.moveStateChange({ id: U(81), opId: U(82), oldId: U(80), target: { nodeId: U(11) } });
  assert.deepEqual(again, { ok: true });
  assert.equal(f.pushes[0]![0]!.recordId, U(81)); assert.equal(f.pushes[1]![0]!.recordId, U(81));
  assert.equal(f.pushes[0]![0]!.opId, f.pushes[1]![0]!.opId, "the same op id");
  assert.deepEqual(live(c).map((x) => x.id), [U(81)], "one copy, the old one removed");
  c.stop();
});

test("a move whose create was applied but whose tombstone failed retries only the tombstone", async () => {
  const { f, c } = moveSetup();
  let down = true;
  f.before = async (ops) => { if (ops[0]!.op === "tombstone" && down) throw new Error("offline"); };
  const first = await c.moveStateChange({ id: U(81), opId: U(82), oldId: U(80), target: { nodeId: U(11) } });
  assert.equal(first.ok, false);
  assert.equal(!first.ok && first.created, true);
  assert.match(first.ok ? "" : first.message, /shows twice/);
  down = false;
  const before = f.pushes.length;
  const again = await c.moveStateChange({ id: U(81), opId: U(82), oldId: U(80), target: { nodeId: U(11) }, created: true });
  assert.deepEqual(again, { ok: true });
  assert.equal(f.pushes.length, before + 1);
  assert.equal(f.pushes[before]![0]!.op, "tombstone");
  assert.deepEqual(live(c).map((x) => x.id), [U(81)]);
  c.stop();
});

test("after a create was applied and the tombstone failed, a different target is refused and the same one retries", async () => {
  const { f, c } = moveSetup();
  f.before = async (ops) => { if (ops[0]!.op === "tombstone") throw new Error("offline"); };
  let n = 100;
  const mint = () => U(n++);
  let attempt = nextMoveAttempt(undefined, "A", mint);
  assert.equal(attempt.ok, true);
  if (!attempt.ok) return;
  const first = await c.moveStateChange({ ...attempt.attempt, oldId: U(80), target: { nodeId: U(11) } });
  assert.equal(!first.ok && first.created, true);
  const held = { ...attempt.attempt, created: true };
  const pushes = f.pushes.length;
  const other = nextMoveAttempt(held, "B", mint);
  assert.deepEqual(other, { ok: false, message: "Finish the earlier move first: remove one of the two copies, or choose the same place again." });
  assert.equal(EARLIER_MOVE_FIRST, !other.ok ? other.message : "");
  assert.equal(f.pushes.length, pushes, "nothing was sent for the refused target");
  assert.deepEqual(f.pushes.map((p) => p[0]!.op), ["create", "tombstone"], "only the earlier pushes");
  assert.equal(n, 102, "no new ids were minted");
  const same = nextMoveAttempt(held, "A", mint);
  assert.deepEqual(same, { ok: true, attempt: held });
  c.stop();
});

test("the new copy was removed after the tombstone failed: the old one is not removed, and the attempt is cleared", async () => {
  const { f, c } = moveSetup();
  let down = true;
  f.before = async (ops) => { if (ops[0]!.op === "tombstone" && down) throw new Error("offline"); };
  const first = await c.moveStateChange({ id: U(81), opId: U(82), oldId: U(80), target: { nodeId: U(11) } });
  assert.equal(!first.ok && first.created, true);
  down = false;
  assert.deepEqual(await c.tombstoneRecord("stateChange", U(81)), { ok: true }, "the author removes the new copy from its own row");
  const pushes = f.pushes.length;
  const again = await c.moveStateChange({ id: U(81), opId: U(82), oldId: U(80), target: { nodeId: U(11) }, created: true });
  assert.equal(again.ok, false);
  assert.match(again.ok ? "" : again.message, /new copy was removed/);
  assert.equal(!again.ok && again.created, undefined, "the view clears its attempt");
  assert.equal(f.pushes.length, pushes, "the old record was not tombstoned");
  assert.deepEqual(live(c).map((x) => x.id), [U(80)], "one live copy remains");
  c.stop();
});

test("a lost create keeps the attempt: a different target is refused with nothing sent, the same target retries with the same id", async () => {
  const { f, c } = moveSetup();
  let lose = true;
  f.lose = () => { const was = lose; lose = false; return was; };
  let n = 100;
  const mint = () => U(n++);
  const a = nextMoveAttempt(undefined, "A", mint);
  if (!a.ok) throw new Error("unexpected");
  const first = await c.moveStateChange({ ...a.attempt, oldId: U(80), target: { nodeId: U(11) } });
  assert.equal(!first.ok && first.lost, true);
  const held = { ...a.attempt, lost: true };
  const pushes = f.pushes.length;
  const other = nextMoveAttempt(held, "B", mint);
  assert.deepEqual(other, { ok: false, message: EARLIER_MOVE_MAY_HAVE_WORKED });
  assert.equal(f.pushes.length, pushes, "nothing was sent");
  assert.equal(n, 102, "no new ids were minted");
  const same = nextMoveAttempt(held, "A", mint);
  assert.deepEqual(same, { ok: true, attempt: held });
  const again = await c.moveStateChange({ id: held.id, opId: held.opId, oldId: U(80), target: { nodeId: U(11) } });
  assert.deepEqual(again, { ok: true });
  assert.equal(f.pushes[pushes]![0]!.recordId, f.pushes[0]![0]!.recordId, "the same record id");
  assert.equal(f.pushes[pushes]![0]!.opId, f.pushes[0]![0]!.opId);
  c.stop();
});

test("a refused draft on the old row blocks a move until it is discarded", async () => {
  const { f, c } = moveSetup();
  const key = `${U(80)}/note`;
  await c.holdField({ entryId: U(80), field: "note", input: "x", base: 0 }, "No.");
  const out = await c.moveStateChange({ id: U(81), opId: U(82), oldId: U(80), target: { nodeId: U(11) } });
  assert.deepEqual(out, { ok: false, message: "This change has text that cannot be saved as it is. Correct the text so it can be saved, then move it." });
  assert.equal(f.pushes.length, 0);
  await c.discardDraft(key);
  assert.equal(c.draftFor(key), undefined);
  assert.equal(c.getState().fields.get(key), undefined);
  assert.deepEqual(await c.moveStateChange({ id: U(81), opId: U(82), oldId: U(80), target: { nodeId: U(11) } }), { ok: true });
  c.stop();
});

test("a conflict draft on the old row blocks a move with the conflict message", async () => {
  const { f, c } = moveSetup();
  f.reply.push((ops) => [{ opId: ops[0]!.opId, status: "conflict" }]);
  const saved = await c.saveEntryField({ kind: "stateChange", entryId: U(80), field: "note", value: "mine", input: "mine", base: c.baseOfField(U(80), "note", "stateChange") });
  assert.equal(saved.kind, "conflict");
  const pushes = f.pushes.length;
  const out = await c.moveStateChange({ id: U(81), opId: U(82), oldId: U(80), target: { nodeId: U(11) } });
  assert.deepEqual(out, { ok: false, message: "This change has text that was changed on another device. Choose which text to keep (Keep my text or Use the saved text), then move it." });
  assert.equal(f.pushes.length, pushes);
  c.stop();
});

test("a refused create is neither lost nor created, so the view clears its attempt", async () => {
  const { f, c } = moveSetup();
  f.reply.push((ops) => [{ opId: ops[0]!.opId, status: "rejected", code: "INTEGRITY_VIOLATION", message: "No." }]);
  const out = await c.moveStateChange({ id: U(81), opId: U(82), oldId: U(80), target: { nodeId: U(11) } });
  assert.equal(out.ok, false);
  assert.equal(!out.ok && out.lost, undefined);
  assert.equal(!out.ok && out.created, undefined);
  c.stop();
});

test("a move is refused while the old row has text that is not saved yet", async () => {
  const { f, c } = moveSetup();
  const g = gate();
  f.before = async () => { await g.p; };
  const save = c.saveEntryField({ kind: "stateChange", entryId: U(80), field: "note", value: "late", input: "late", base: c.baseOfField(U(80), "note", "stateChange") });
  await tick();
  const out = await c.moveStateChange({ id: U(81), opId: U(82), oldId: U(80), target: { nodeId: U(11) } });
  assert.deepEqual(out, { ok: false, message: "This change has text that is not saved yet. Save it first, then move it." });
  assert.equal(f.pushes.length, 1, "nothing but the note was sent");
  g.open(); await save;
  c.stop();
});

test("a select save followed by a blur save of the same value ends on Saved", async () => {
  const { f, c } = moveSetup();
  const g = gate();
  let n = 0;
  f.before = async () => { if (++n === 1) await g.p; };
  const q = { kind: "stateChange" as const, entryId: U(80), field: "value", value: 25, input: "25", base: c.baseOfField(U(80), "value", "stateChange") };
  const first = c.saveEntryField(q);
  await tick();
  const second = c.saveEntryField({ ...q });
  await tick();
  assert.equal(c.getState().fields.get(`${U(80)}/value`)?.state, "saving");
  g.open();
  await Promise.all([first, second]);
  assert.equal(f.pushes.length, 1);
  assert.equal(c.getState().fields.get(`${U(80)}/value`)?.state, "saved");
  c.stop();
});

test("a state change's value saves as a set op on its own record and kind, and a refused value is not sent", async () => {
  const f = fake();
  const r = ready(f); const { c } = r;
  for (const [kind, v] of [
    ["template", { id: U(70), name: "Character", entryType: "character", builtIn: true, orderKey: "m" }],
    ["field", { id: U(71), templateId: U(70), key: "age", label: "Age", fieldType: "integer", orderKey: "m", multiple: false, required: false }],
    ["entry", { id: U(23), entryType: "character", name: "Bo", templateId: U(70), scope: { kind: "book", id: U(2) }, aliases: [], values: {}, overrides: [], attachments: [] }],
    ["event", { id: U(50), scope: { kind: "book", id: U(2) }, title: "Storm", orderKey: "m", sceneIds: [], participants: [] }],
    ["stateChange", { id: U(80), entryId: U(23), fieldId: U(71), eventId: U(50), value: 24 }],
  ] as const) r.serve(kind, v as Record<string, unknown>);
  const ok = await c.saveEntryField({ kind: "stateChange", entryId: U(80), field: "value", value: 25, input: "25", base: c.baseOfField(U(80), "value", "stateChange") });
  assert.equal(ok.kind, "saved");
  assert.deepEqual({ ...f.pushes[0]![0]!, opId: undefined, baseSeq: undefined }, { opId: undefined, op: "set", recordKind: "stateChange", recordId: U(80), field: "value", baseSeq: undefined, value: 25 });
  const before = f.pushes.length;
  const bad = await c.saveEntryField({ kind: "stateChange", entryId: U(80), field: "value", value: 2.5, input: "2.5", base: c.baseOfField(U(80), "value", "stateChange") });
  assert.equal(bad.kind, "invalid");
  assert.equal(f.pushes.length, before);
  const noText = await c.saveEntryField({ kind: "event", entryId: U(50), field: "title", value: "", input: "", base: c.baseOfField(U(50), "title", "event") });
  assert.equal(noText.kind, "invalid");
  assert.equal(f.pushes.length, before);
  f.reply.push((ops) => [{ opId: ops[0]!.opId, status: "rejected", code: "RECORD_DELETED", message: "x" }]);
  const gone = await c.saveEntryField({ kind: "event", entryId: U(50), field: "title", value: "Gale", input: "Gale", base: c.baseOfField(U(50), "title", "event") });
  assert.match(gone.message ?? "", /This event is in the trash/);
  c.stop();
});

test("two saves of one field in quick succession leave Saved on it: the second finds the value already stored", async () => {
  const f = fake();
  const r = ready(f); const { c } = r;
  r.serve("event", { id: U(50), scope: { kind: "book", id: U(2) }, title: "Storm", orderKey: "m", sceneIds: [], participants: [] });
  const q = { kind: "event" as const, entryId: U(50), field: "title", value: "Gale", input: "Gale", base: c.baseOfField(U(50), "title", "event") };
  const [a, b] = await Promise.all([c.saveEntryField(q), c.saveEntryField(q)]);
  assert.equal(a.kind, "saved");
  assert.equal(b.kind, "nothing");
  assert.equal(f.pushes.length, 1);
  assert.equal(c.getState().fields.get(`${U(50)}/title`)?.state, "saved");
  c.stop();
});

test("a retry refused for unsaved text keeps created: a different target is still refused with EARLIER_MOVE_FIRST", async () => {
  const { f, c } = moveSetup();
  f.before = async (ops) => { if (ops[0]!.op === "tombstone") throw new Error("offline"); };
  let n = 100;
  const mint = () => U(n++);
  const a = nextMoveAttempt(undefined, "A", mint);
  if (!a.ok) throw new Error("unexpected");
  const first = await c.moveStateChange({ ...a.attempt, oldId: U(80), target: { nodeId: U(11) } });
  assert.equal(!first.ok && first.created, true);
  let held = attemptAfterFailedMove(a.attempt, first.ok ? {} : first)!;
  assert.equal(held.created, true);
  const g = gate();
  f.before = async () => { await g.p; };
  const save = c.saveEntryField({ kind: "stateChange", entryId: U(80), field: "note", value: "late", input: "late", base: c.baseOfField(U(80), "note", "stateChange") });
  await tick();
  const retry = await c.moveStateChange({ id: held.id, opId: held.opId, created: held.created, oldId: U(80), target: { nodeId: U(11) } });
  assert.match(retry.ok ? "" : retry.message, /not saved yet/);
  held = attemptAfterFailedMove(held, retry.ok ? {} : retry)!;
  assert.equal(held.created, true, "still held");
  assert.equal(held.id, a.attempt.id); assert.equal(held.opId, a.attempt.opId);
  const other = nextMoveAttempt(held, "B", mint);
  assert.deepEqual(other, { ok: false, message: EARLIER_MOVE_FIRST });
  g.open(); await save;
  c.stop();
});

test("a retry refused by a stuck draft keeps lost: a different target is still refused with EARLIER_MOVE_MAY_HAVE_WORKED", async () => {
  const { f, c } = moveSetup();
  let lose = true;
  f.lose = () => { const was = lose; lose = false; return was; };
  let n = 100;
  const mint = () => U(n++);
  const a = nextMoveAttempt(undefined, "A", mint);
  if (!a.ok) throw new Error("unexpected");
  const first = await c.moveStateChange({ ...a.attempt, oldId: U(80), target: { nodeId: U(11) } });
  assert.equal(!first.ok && first.lost, true);
  let held = attemptAfterFailedMove(a.attempt, first.ok ? {} : first)!;
  assert.equal(held.lost, true);
  await c.holdField({ entryId: U(80), field: "note", input: "x", base: 0 }, "No.");
  const retry = await c.moveStateChange({ id: held.id, opId: held.opId, created: held.created, oldId: U(80), target: { nodeId: U(11) } });
  assert.match(retry.ok ? "" : retry.message, /cannot be saved as it is/);
  held = attemptAfterFailedMove(held, retry.ok ? {} : retry)!;
  assert.equal(held.lost, true, "still held");
  assert.equal(held.id, a.attempt.id); assert.equal(held.opId, a.attempt.opId);
  assert.deepEqual(nextMoveAttempt(held, "B", mint), { ok: false, message: EARLIER_MOVE_MAY_HAVE_WORKED });
  c.stop();
});

test("a refused create that is not lost clears the attempt, and a different target is then allowed", async () => {
  const { f, c } = moveSetup();
  f.reply.push((ops) => [{ opId: ops[0]!.opId, status: "rejected", code: "INVALID_VALUE", message: "The value does not fit the record." }]);
  let n = 100;
  const mint = () => U(n++);
  const a = nextMoveAttempt(undefined, "A", mint);
  if (!a.ok) throw new Error("unexpected");
  const out = await c.moveStateChange({ ...a.attempt, oldId: U(80), target: { nodeId: U(11) } });
  assert.equal(out.ok, false);
  assert.equal(!out.ok && out.clear, true);
  assert.equal(attemptAfterFailedMove(a.attempt, out.ok ? {} : out), undefined);
  assert.equal(nextMoveAttempt(undefined, "B", mint).ok, true);
  c.stop();
});

test("the new copy was removed outcome still clears the attempt", async () => {
  const { f, c } = moveSetup();
  let down = true;
  f.before = async (ops) => { if (ops[0]!.op === "tombstone" && down) throw new Error("offline"); };
  const first = await c.moveStateChange({ id: U(81), opId: U(82), oldId: U(80), target: { nodeId: U(11) } });
  down = false;
  await c.tombstoneRecord("stateChange", U(81));
  const held = { key: "A", id: U(81), opId: U(82), created: true };
  const again = await c.moveStateChange({ id: U(81), opId: U(82), oldId: U(80), target: { nodeId: U(11) }, created: true });
  assert.equal(!again.ok && again.clear, true);
  assert.equal(attemptAfterFailedMove(held, again.ok ? {} : again), undefined);
  assert.equal(first.ok, false);
  c.stop();
});

test("a create applied with its pull failing, then a failed tombstone: a retry that cannot pull is refused without clear, and a working pull then tombstones the old record only", async () => {
  const { f, c } = moveSetup();
  const goodPull = f.io.getChanges!;
  let pullDown = true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (c as any).io = { ...f.io, getChanges: async (...a: Parameters<typeof goodPull>) => { if (pullDown) throw new Error("offline"); return goodPull(...a); } };
  f.before = async (ops) => { if (ops[0]!.op === "tombstone" && pullDown) throw new Error("offline"); };
  const first = await c.moveStateChange({ id: U(81), opId: U(82), oldId: U(80), target: { nodeId: U(11) } });
  assert.equal(!first.ok && first.created, true);
  assert.equal(c.model.records.get("stateChange")?.get(U(81)), undefined, "the local model does not have the new copy");
  const pushes = f.pushes.length;
  const retry = await c.moveStateChange({ id: U(81), opId: U(82), oldId: U(80), target: { nodeId: U(11) }, created: true });
  assert.equal(retry.ok, false);
  assert.match(retry.ok ? "" : retry.message, /Could not check whether the new copy is there/);
  assert.equal(!retry.ok && retry.clear, undefined, "not cleared");
  assert.equal(!retry.ok && retry.created, true, "the attempt is kept");
  assert.equal(f.pushes.length, pushes, "no tombstone was pushed");
  pullDown = false;
  const again = await c.moveStateChange({ id: U(81), opId: U(82), oldId: U(80), target: { nodeId: U(11) }, created: true });
  assert.deepEqual(again, { ok: true });
  assert.equal(f.pushes.length, pushes + 1);
  assert.equal(f.pushes[pushes]![0]!.op, "tombstone");
  assert.equal(f.pushes[pushes]![0]!.recordId, U(80), "the old record only");
  assert.deepEqual(live(c).map((x) => x.id), [U(81)]);
  c.stop();
});

test("a lost create whose retry gets changed or retry keeps lost: a different target is still refused with EARLIER_MOVE_MAY_HAVE_WORKED", async () => {
  for (const kind of ["changed", "retry"] as const) {
    const { f, c } = moveSetup();
    let lose = true;
    f.lose = () => { const was = lose; lose = false; return was; };
    let n = 100;
    const mint = () => U(n++);
    const a = nextMoveAttempt(undefined, "A", mint);
    if (!a.ok) throw new Error("unexpected");
    const first = await c.moveStateChange({ ...a.attempt, oldId: U(80), target: { nodeId: U(11) } });
    assert.equal(!first.ok && first.lost, true);
    let held = attemptAfterFailedMove(a.attempt, first.ok ? {} : first)!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c as any).sendRecordOps = async () => ({ kind });
    const retry = await c.moveStateChange({ id: held.id, opId: held.opId, oldId: U(80), target: { nodeId: U(11) } });
    assert.equal(retry.ok, false);
    assert.equal(!retry.ok && retry.clear, undefined, `${kind}: not cleared`);
    held = attemptAfterFailedMove(held, retry.ok ? {} : retry)!;
    assert.equal(held.lost, true, `${kind}: still lost`);
    assert.deepEqual(nextMoveAttempt(held, "B", mint), { ok: false, message: EARLIER_MOVE_MAY_HAVE_WORKED });
    c.stop();
  }
});
