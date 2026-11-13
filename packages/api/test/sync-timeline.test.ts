// Timeline written by sync (M1-10 slice 3): events and state changes, field edits, bad values refused without a write,
// trash and restore, W_STATE_CONFLICT and W_CHRONOLOGY_ORDINAL on the stored library, and the export round trip.
// Scratch databases only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readArchive, validateArchiveData } from "@writers-rolltop/archive";
import { server } from "./helpers.ts";
import type { Server } from "./helpers.ts";

const T = new Date("2026-11-11T12:00:00Z");
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const C = "2026-11-01T09:00:00Z";
const STAMPS = { createdAt: C, updatedAt: C };
const push = (s: Server, epoch: string, ops: unknown[]) =>
  s.inject({ method: "POST", url: "/api/sync/v1/push", payload: { epoch, deviceId: A, ops } });
const codes = (res: { json(): any }) => (res.json().results as any[]).map((r) => r.code ?? r.status);
const create = (recordKind: string, value: { id: string; [k: string]: unknown }) => ({ opId: randomUUID(), op: "create", recordKind, recordId: value.id, value });
const set = (recordKind: string, recordId: string, field: string, value: unknown, baseSeq = 0) => ({ opId: randomUUID(), op: "set", recordKind, recordId, field, baseSeq, value });
const unset = (recordKind: string, recordId: string, field: string, baseSeq = 0) => ({ opId: randomUUID(), op: "unset", recordKind, recordId, field, baseSeq });
const tombstone = (recordKind: string, recordId: string, baseSeq = 0) => ({ opId: randomUUID(), op: "tombstone", recordKind, recordId, baseSeq });
const restore = (recordKind: string, recordId: string) => ({ opId: randomUUID(), op: "restore", recordKind, recordId });
const head = async (s: Server) => Number((await s.query("SELECT head FROM sync_state"))[0].head);
const epochOf = async (s: Server) => (await s.query("SELECT epoch FROM sync_state"))[0].epoch as string;

async function seed(s: Server) {
  const epoch = await epochOf(s);
  const I = { lib: randomUUID(), book: randomUUID(), book2: randomUUID(), chap: randomUUID(), scene: randomUUID(), scene2: randomUUID(), chap2: randomUUID(), ada: randomUUID(), evEntry: randomUUID(), tpl: randomUUID(), fld: randomUUID(), fldText: randomUUID(), ev: randomUUID(), ev2: randomUUID(), sc: randomUUID() };
  const doc = (id: string) => ({ schema: "writers-rolltop/document", version: 1, nodeId: id, blocks: [{ id: randomUUID(), type: "paragraph", content: [{ type: "text", text: "Hi" }] }] });
  const res = await push(s, epoch, [
    create("library", { id: I.lib, title: "L", ...STAMPS }), create("book", { id: I.book, title: "B", orderKey: "m", ...STAMPS }),
    create("book", { id: I.book2, title: "B2", orderKey: "n", ...STAMPS }),
    create("manuscriptNode", { id: I.chap, bookId: I.book, kind: "chapter", title: "C", orderKey: "m", ...STAMPS }),
    create("manuscriptNode", { id: I.scene, bookId: I.book, parentId: I.chap, kind: "scene", title: "S", orderKey: "m", ...STAMPS }),
    create("manuscriptNode", { id: I.chap2, bookId: I.book2, kind: "chapter", title: "C2", orderKey: "m", ...STAMPS }),
    create("manuscriptNode", { id: I.scene2, bookId: I.book2, parentId: I.chap2, kind: "scene", title: "S2", orderKey: "m", ...STAMPS }),
    { opId: randomUUID(), op: "document", recordKind: "document", recordId: I.scene, baseRevision: 0, value: doc(I.scene) },
    { opId: randomUUID(), op: "document", recordKind: "document", recordId: I.scene2, baseRevision: 0, value: doc(I.scene2) },
    create("template", { id: I.tpl, name: "Character", entryType: "character", builtIn: false, orderKey: "m", ...STAMPS }),
    create("field", { id: I.fld, templateId: I.tpl, key: "alive", label: "Alive", fieldType: "boolean", required: false, orderKey: "m", ...STAMPS }),
    create("field", { id: I.fldText, templateId: I.tpl, key: "title", label: "Title", fieldType: "shortText", required: false, orderKey: "n", ...STAMPS }),
    create("entry", { id: I.ada, entryType: "character", templateId: I.tpl, name: "Ada", aliases: [], scope: { kind: "book", id: I.book }, values: {}, overrides: [], attachments: [], ...STAMPS }),
    create("entry", { id: I.evEntry, entryType: "event", name: "The Fall", aliases: [], scope: { kind: "book", id: I.book }, values: {}, overrides: [], attachments: [], ...STAMPS }),
  ]);
  assert.deepEqual(codes(res), Array(14).fill("applied"), res.body);
  return { epoch, I, scope: { kind: "book", id: I.book } };
}
const warningCodes = (data: any) => validateArchiveData(data).warnings.map((w) => w.code);

test("events and state changes: create, edit by field, unset, trash, restore, and the export reads them back", async () => {
  const s = await server({ clock: () => T });
  try {
    const { epoch, I, scope } = await seed(s);
    const ev = { id: I.ev, scope, title: "The siege", summary: "Walls fall", when: { label: "Year 3", calendar: "Reckoning", ordinal: 3 }, orderKey: "m", entryId: I.evEntry, sceneIds: [I.scene], participants: [{ entryId: I.ada, role: "defender" }], ...STAMPS };
    const sc = { id: I.sc, eventId: I.ev, entryId: I.ada, fieldId: I.fld, value: true, note: "alive at the siege", ...STAMPS };
    assert.deepEqual(codes(await push(s, epoch, [create("event", ev), create("stateChange", sc)])), ["applied", "applied"]);
    let h = await head(s);
    assert.deepEqual(codes(await push(s, epoch, [
      set("event", I.ev, "title", "The long siege", h), set("event", I.ev, "when", { label: "Year 4", calendar: "Reckoning", ordinal: 4 }, h),
      set("event", I.ev, "sceneIds", [], h), set("event", I.ev, "participants", [], h), unset("event", I.ev, "summary", h), unset("event", I.ev, "entryId", h),
      set("stateChange", I.sc, "value", false, h), unset("stateChange", I.sc, "note", h),
    ])), Array(8).fill("applied"));
    let data = await s.store.readArchiveData();
    assert.deepEqual(validateArchiveData(data).errors, []);
    const e = data.events[0] as any, c = data.stateChanges[0] as any;
    assert.equal(e.title, "The long siege"); assert.deepEqual(e.when, { label: "Year 4", calendar: "Reckoning", ordinal: 4 });
    assert.deepEqual(e.sceneIds, []); assert.deepEqual(e.participants, []); assert.equal("summary" in e, false); assert.equal("entryId" in e, false);
    assert.equal(c.value, false); assert.equal("note" in c, false);
    // A state change moves from an event to a node (exactly one of the two).
    h = await head(s);
    assert.deepEqual(codes(await push(s, epoch, [unset("stateChange", I.sc, "eventId", h)])), ["INTEGRITY_VIOLATION"]);
    // Trash and restore.
    assert.deepEqual(codes(await push(s, epoch, [tombstone("event", I.ev, h), tombstone("stateChange", I.sc, h)])), ["applied", "applied"]);
    data = await s.store.readArchiveData();
    assert.ok((data.events[0] as any).deletedAt && (data.stateChanges[0] as any).deletedAt);
    assert.deepEqual(codes(await push(s, epoch, [set("event", I.ev, "title", "late", h)])), ["RECORD_DELETED"]);
    assert.deepEqual(codes(await push(s, epoch, [restore("event", I.ev), restore("stateChange", I.sc)])), ["applied", "applied"]);
    data = await s.store.readArchiveData();
    assert.equal((data.events[0] as any).deletedAt, undefined);
    assert.equal((data.events[0] as any).title, "The long siege");
    const res = await s.inject({ method: "GET", url: "/api/export" });
    assert.equal(res.statusCode, 200);
    const back = await readArchive(res.rawPayload);
    try {
      assert.equal(back.data.events.length, 1); assert.equal(back.data.stateChanges.length, 1);
      assert.deepEqual(back.data.events[0], data.events[0]);
      assert.deepEqual(back.data.stateChanges[0], data.stateChanges[0]);
    } finally { await back.close(); }
  } finally { await s.drop(); }
});

test("events and state changes: bad values are refused and nothing is written", async () => {
  const s = await server({ clock: () => T });
  try {
    const { epoch, I, scope } = await seed(s);
    const n = () => randomUUID();
    const event = (extra: object) => create("event", { id: n(), scope, title: "t", orderKey: "m", sceneIds: [], participants: [], ...STAMPS, ...extra });
    assert.deepEqual(codes(await push(s, epoch, [event({ id: I.ev })])), ["applied"]);
    const change = (extra: object) => create("stateChange", { id: n(), eventId: I.ev, entryId: I.ada, fieldId: I.fld, value: true, ...STAMPS, ...extra });
    const bad: any[] = [
      event({ title: undefined }), event({ orderKey: "" }), event({ when: { label: "" } }), event({ when: { label: "x", ordinal: 1.5 } }),
      event({ when: { label: "x", extra: 1 } }), event({ sceneIds: [I.scene, I.scene] }), event({ sceneIds: [I.scene2] }), event({ sceneIds: [I.chap] }), event({ sceneIds: [n()] }),
      event({ participants: [{ entryId: I.ada }, { entryId: I.ada }] }), event({ participants: [{ entryId: n() }] }), event({ entryId: I.ada }),
      event({ scope: { kind: "book", id: n() } }), event({ title: "a\u0000b" }),
      change({ eventId: undefined }), change({ nodeId: I.scene }), change({ eventId: n() }), change({ value: "yes" }), change({ fieldId: n() }),
      change({ entryId: n() }), change({ eventId: undefined, nodeId: I.scene2 }), change({ note: 5 }),
    ];
    const before = await s.query("SELECT (SELECT count(*) FROM continuity_event) AS e, (SELECT count(*) FROM state_change) AS c, (SELECT head FROM sync_state) AS h");
    const got = codes(await push(s, epoch, bad));
    assert.equal(got.length, bad.length);
    assert.ok(got.every((c) => c !== "applied"), JSON.stringify(got));
    const I_ = "INVALID_VALUE", V = "INTEGRITY_VIOLATION", R = "REFERENCE_UNRESOLVED";
    assert.deepEqual(got, [I_, I_, I_, I_, I_, V, V, V, R, V, R, V, R, I_, V, V, R, V, R, R, V, I_]);
    assert.deepEqual(await s.query("SELECT (SELECT count(*) FROM continuity_event) AS e, (SELECT count(*) FROM state_change) AS c, (SELECT head FROM sync_state) AS h"), before);
    // A field edit that would leave an invalid record is refused too.
    const ok = change({});
    assert.deepEqual(codes(await push(s, epoch, [ok])), ["applied"]);
    const h = await head(s);
    const edits = codes(await push(s, epoch, [
      set("stateChange", ok.recordId, "value", "yes", h), set("stateChange", ok.recordId, "fieldId", n(), h), set("event", I.ev, "sceneIds", [I.scene2], h),
      set("event", I.ev, "when", { label: "" }, h), set("event", I.ev, "orderKey", 5, h),
    ]));
    assert.deepEqual(edits, [V, R, V, I_, I_]);
    // A state change may name a node instead of an event.
    assert.deepEqual(codes(await push(s, epoch, [create("stateChange", { id: n(), nodeId: I.chap, entryId: I.ada, fieldId: I.fld, value: false, ...STAMPS })])), ["applied"]);
  } finally { await s.drop(); }
});

test("events and state changes: W_STATE_CONFLICT and W_CHRONOLOGY_ORDINAL show on the stored library, and clear when trashed", async () => {
  const s = await server({ clock: () => T });
  try {
    const { epoch, I, scope } = await seed(s);
    const n = () => randomUUID();
    const a = { id: I.ev, scope, title: "A", orderKey: "a", when: { label: "late", calendar: "Reckoning", ordinal: 10 }, sceneIds: [], participants: [], ...STAMPS };
    const b = { id: I.ev2, scope, title: "B", orderKey: "b", when: { label: "early", calendar: "Reckoning", ordinal: 4 }, sceneIds: [], participants: [], ...STAMPS };
    const one = { id: I.sc, eventId: I.ev, entryId: I.ada, fieldId: I.fld, value: true, ...STAMPS };
    const two = { id: n(), eventId: I.ev, entryId: I.ada, fieldId: I.fld, value: false, ...STAMPS };
    assert.deepEqual(codes(await push(s, epoch, [create("event", a), create("event", b), create("stateChange", one), create("stateChange", two)])), Array(4).fill("applied"));
    let data = await s.store.readArchiveData();
    const report = validateArchiveData(data);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.warnings.map((w) => w.code).sort(), ["W_CHRONOLOGY_ORDINAL", "W_STATE_CONFLICT"]);
    assert.equal(report.warnings.find((w) => w.code === "W_CHRONOLOGY_ORDINAL")!.recordId, I.ev2);
    assert.equal(report.warnings.find((w) => w.code === "W_STATE_CONFLICT")!.recordId, I.ev);
    // The export carries the same data and warns the same way.
    const back = await readArchive((await s.inject({ method: "GET", url: "/api/export" })).rawPayload);
    try { assert.deepEqual(warningCodes(back.data).sort(), ["W_CHRONOLOGY_ORDINAL", "W_STATE_CONFLICT"]); } finally { await back.close(); }
    // Same value, or a trashed record, clears the conflict; fixing the ordinal clears the other.
    let h = await head(s);
    assert.deepEqual(codes(await push(s, epoch, [set("stateChange", two.id, "value", true, h)])), ["applied"]);
    assert.deepEqual(warningCodes(await s.store.readArchiveData()), ["W_CHRONOLOGY_ORDINAL"]);
    assert.deepEqual(codes(await push(s, epoch, [set("event", I.ev2, "when", { label: "later", calendar: "Reckoning", ordinal: 12 }, h)])), ["applied"]);
    assert.deepEqual(warningCodes(await s.store.readArchiveData()), []);
    h = await head(s);
    assert.deepEqual(codes(await push(s, epoch, [set("stateChange", two.id, "value", false, h), set("event", I.ev2, "when", { label: "early", calendar: "Reckoning", ordinal: 4 }, h)])), ["applied", "applied"]);
    assert.equal(warningCodes(await s.store.readArchiveData()).length, 2);
    h = await head(s);
    assert.deepEqual(codes(await push(s, epoch, [tombstone("stateChange", two.id, h), tombstone("event", I.ev2, h)])), ["applied", "applied"]);
    data = await s.store.readArchiveData();
    assert.deepEqual(warningCodes(data), []);
  } finally { await s.drop(); }
});
