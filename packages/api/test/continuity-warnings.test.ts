// Continuity warnings route (M1-10 slice 4): GET /api/continuity/warnings. Each spec key kind, the key format, a fix clearing a
// warning, trashed records, book overrides, dismissed keys kept, the session guard, and agreement with the archive validator
// on the exported library. Scratch databases only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { continuityWarnings, readArchive, validateArchiveData } from "@writers-rolltop/archive";
import { server } from "./helpers.ts";
import type { Server } from "./helpers.ts";

const T = new Date("2026-11-11T12:00:00Z");
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const C = "2026-11-01T09:00:00Z";
const STAMPS = { createdAt: C, updatedAt: C };
const KEY = /^[A-Za-z]+(:[0-9A-Za-z-]+)*$/;
const push = (s: Server, epoch: string, ops: unknown[]) => s.inject({ method: "POST", url: "/api/sync/v1/push", payload: { epoch, deviceId: A, ops } });
const codes = (res: { json(): any }) => (res.json().results as any[]).map((r) => r.code ?? r.status);
const create = (recordKind: string, value: { id: string; [k: string]: unknown }) => ({ opId: randomUUID(), op: "create", recordKind, recordId: value.id, value });
const set = (recordKind: string, recordId: string, field: string, value: unknown, baseSeq: number) => ({ opId: randomUUID(), op: "set", recordKind, recordId, field, baseSeq, value });
const tombstone = (recordKind: string, recordId: string, baseSeq: number) => ({ opId: randomUUID(), op: "tombstone", recordKind, recordId, baseSeq });
const restore = (recordKind: string, recordId: string) => ({ opId: randomUUID(), op: "restore", recordKind, recordId });
const head = async (s: Server) => Number((await s.query("SELECT head FROM sync_state"))[0].head);
const warnings = async (s: Server): Promise<any[]> => {
  const res = await s.inject({ method: "GET", url: "/api/continuity/warnings" });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().warnings;
};
const keys = (w: any[]) => w.map((x) => x.key).sort();

/** Book 1 (chapter 1 with scenes 1 and 2) then book 2 (chapter 2 with scene 3), two characters, an empty chapter 3, and event entries. */
async function seed(s: Server) {
  const epoch = (await s.query("SELECT epoch FROM sync_state"))[0].epoch as string;
  const I = {
    lib: randomUUID(), uni: randomUUID(), b1: randomUUID(), b2: randomUUID(), c1: randomUUID(), s1: randomUUID(), s2: randomUUID(), c2: randomUUID(), s3: randomUUID(),
    c3: randomUUID(), tpl: randomUUID(), fld: randomUUID(), ada: randomUUID(), ben: randomUUID(), place: randomUUID(), ev: randomUUID(),
  };
  const words = (id: string, text: string) => ({ opId: randomUUID(), op: "document", recordKind: "document", recordId: id, baseRevision: 0,
    value: { schema: "writers-rolltop/document", version: 1, nodeId: id, blocks: [{ id: randomUUID(), type: "paragraph", content: text ? [{ type: "text", text }] : [] }] } });
  const node = (id: string, bookId: string, kind: string, orderKey: string, parentId?: string) =>
    create("manuscriptNode", { id, bookId, kind, title: kind, orderKey, ...(parentId ? { parentId } : {}), ...STAMPS });
  const res = await push(s, epoch, [
    create("library", { id: I.lib, title: "L", ...STAMPS }), create("universe", { id: I.uni, title: "U", orderKey: "m", ...STAMPS }),
    create("book", { id: I.b1, title: "One", orderKey: "a", universeId: I.uni, ...STAMPS }), create("book", { id: I.b2, title: "Two", orderKey: "b", universeId: I.uni, ...STAMPS }),
    node(I.c1, I.b1, "chapter", "a"), node(I.s1, I.b1, "scene", "a", I.c1), node(I.s2, I.b1, "scene", "b", I.c1),
    node(I.c2, I.b2, "chapter", "a"), node(I.s3, I.b2, "scene", "a", I.c2), node(I.c3, I.b2, "chapter", "b"),
    words(I.s1, ""), words(I.s2, "Ada walks in."), words(I.s3, ""),
    create("template", { id: I.tpl, name: "Character", entryType: "character", builtIn: false, orderKey: "m", ...STAMPS }),
    create("field", { id: I.fld, templateId: I.tpl, key: "alive", label: "Alive", fieldType: "boolean", required: false, orderKey: "m", ...STAMPS }),
    ...[[I.ada, "Ada", "character"], [I.ben, "Ben", "character"], [I.place, "Hold", "location"]].map(([id, name, entryType]) =>
      create("entry", { id, entryType, ...(entryType === "character" ? { templateId: I.tpl } : {}), name, aliases: [], scope: { kind: "universe", id: I.uni }, values: {}, overrides: [], attachments: [], ...STAMPS })),
  ]);
  assert.deepEqual(codes(res), Array(18).fill("applied"), res.body);
  return { epoch, I, scope: { kind: "universe", id: I.uni } };
}
const fact = (scope: object, extra: object = {}) => create("fact", { id: randomUUID(), scope, text: "f", truth: "true", entryIds: [], knowledge: [], orderKey: "m", ...STAMPS, ...extra });
const question = (scope: object, extra: object = {}) => create("question", { id: randomUUID(), scope, text: "q?", status: "open", entryIds: [], orderKey: "m", ...STAMPS, ...extra });

test("keys and records of each warning kind, with the spec's key format", async () => {
  const s = await server({ clock: () => T });
  try {
    const { epoch, I, scope } = await seed(s);
    const f1 = fact(scope, { nodeId: I.s2, knowledge: [{ knower: I.ada, nodeId: I.s1 }, { knower: "reader", nodeId: I.c1 }] }); // Ada learns it before it is established; the chapter comes just before its scenes.
    const f2 = fact(scope, { nodeId: I.s3, knowledge: [{ knower: I.ben, nodeId: I.s2 }] }); // learned in book 1, established in book 2
    const f3 = fact(scope, { nodeId: I.s1, knowledge: [{ knower: I.ben, nodeId: I.s1 }, { knower: "reader" }] }); // same node, and no node: nothing
    const f4 = fact(scope, { truth: "undecided", knowledge: [{ knower: "reader" }] });
    const f5 = fact(scope, { truth: "undecided", knowledge: [] }); // nobody knows it: nothing
    const q1 = question(scope, { nodeId: I.s2 }); // open, the scene has words
    const q2 = question(scope, { nodeId: I.c1 }); // open, a scene under the chapter has words
    const q3 = question(scope, { nodeId: I.s1 }); // empty scene: nothing
    const q4 = question(scope, { nodeId: I.c3 }); // empty chapter: nothing
    const q5 = question(scope, { nodeId: I.s2, status: "decided", decision: "yes" }); // decided: nothing
    const ev = create("event", { id: I.ev, scope, title: "E", orderKey: "m", sceneIds: [], participants: [], ...STAMPS });
    const sc = (value: unknown) => create("stateChange", { id: randomUUID(), eventId: I.ev, entryId: I.ada, fieldId: I.fld, value, ...STAMPS });
    const all = [f1, f2, f3, f4, f5, q1, q2, q3, q4, q5, ev, sc(true), sc(false)];
    assert.deepEqual(codes(await push(s, epoch, all)), Array(all.length).fill("applied"));
    const w = await warnings(s);
    for (const x of w) assert.match(x.key, KEY);
    const id = (op: { recordId: string }) => op.recordId;
    const on = (rid: string) => w.filter((x) => x.recordId === rid);
    assert.deepEqual(on(id(f1)).map((x) => x.key).sort(), [`learnedBeforeEstablished:${I.ada}:${I.s1}:${I.s2}`, `learnedBeforeEstablished:reader:${I.c1}:${I.s2}`].sort());
    assert.deepEqual(on(id(f1)).find((x) => x.knower === I.ada), { key: `learnedBeforeEstablished:${I.ada}:${I.s1}:${I.s2}`, kind: "learnedBeforeEstablished", recordKind: "fact", recordId: id(f1), knower: I.ada, learnNodeId: I.s1, factNodeId: I.s2 });
    assert.deepEqual(on(id(f2)).map((x) => x.key), [`learnedBeforeEstablished:${I.ben}:${I.s2}:${I.s3}`]); // learned in book 1, established in book 2
    assert.deepEqual(on(id(f3)), []);
    assert.deepEqual(on(id(f4)), [{ key: "undecidedButKnown", kind: "undecidedButKnown", recordKind: "fact", recordId: id(f4) }]);
    assert.deepEqual(on(id(f5)), []);
    assert.deepEqual(on(id(q1)), [{ key: `questionOverdue:${I.s2}`, kind: "questionOverdue", recordKind: "question", recordId: id(q1), nodeId: I.s2 }]);
    assert.deepEqual(keys(on(id(q2))), [`questionOverdue:${I.c1}`]);
    for (const q of [q3, q4, q5]) assert.deepEqual(on(id(q)), []);
    assert.deepEqual(on(I.ev), [{ key: `stateConflict:${I.ada}:${I.fld}`, kind: "stateConflict", recordKind: "event", recordId: I.ev, entryId: I.ada, fieldId: I.fld }]);
    assert.equal(w.length, 2 + 1 + 1 + 1 + 1 + 1);
  } finally { await s.drop(); }
});

test("learned before established follows story order across books (a later book's learn node is not before)", async () => {
  const s = await server({ clock: () => T });
  try {
    const { epoch, I, scope } = await seed(s);
    const late = fact(scope, { nodeId: I.s1, knowledge: [{ knower: I.ben, nodeId: I.s3 }] }); // learned in book 2, established in book 1: fine
    const early = fact(scope, { nodeId: I.s3, knowledge: [{ knower: I.ben, nodeId: I.s1 }] }); // learned in book 1, established in book 2: warning
    assert.deepEqual(codes(await push(s, epoch, [late, early])), ["applied", "applied"]);
    const w = await warnings(s);
    assert.deepEqual(w.map((x) => [x.recordId, x.key]), [[early.recordId, `learnedBeforeEstablished:${I.ben}:${I.s1}:${I.s3}`]]);
  } finally { await s.drop(); }
});

test("trash: a trashed record has no warnings; trashed nodes and entries give the trash warnings, and a restore clears them", async () => {
  const s = await server({ clock: () => T });
  try {
    const { epoch, I, scope } = await seed(s);
    const f = fact(scope, { nodeId: I.s2, entryIds: [I.place], knowledge: [{ knower: I.ben, nodeId: I.s3 }, { knower: I.ada }, { knower: I.ada, nodeId: I.s3 }].slice(0, 2) });
    assert.deepEqual(codes(await push(s, epoch, [f])), ["applied"]);
    assert.deepEqual(await warnings(s), []);
    let h = await head(s);
    // The establishing scene's chapter, the learning scene's book, a place and a knower go to the trash.
    assert.deepEqual(codes(await push(s, epoch, [tombstone("manuscriptNode", I.c1, h), tombstone("book", I.b2, h), tombstone("entry", I.place, h), tombstone("entry", I.ben, h)])), Array(4).fill("applied"));
    assert.deepEqual(keys(await warnings(s)), [
      `aboutMissingEntry:${I.place}`, `establishedInTrash:${I.s2}`, `knowerMissing:${I.ben}`, `learnedInTrash:${I.ben}:${I.s3}`,
    ].sort());
    // A trashed fact has no warnings at all.
    h = await head(s);
    assert.deepEqual(codes(await push(s, epoch, [tombstone("fact", f.recordId, h)])), ["applied"]);
    assert.deepEqual(await warnings(s), []);
    // Restoring the fact and the things it names clears everything.
    assert.deepEqual(codes(await push(s, epoch, [restore("fact", f.recordId), restore("manuscriptNode", I.c1), restore("book", I.b2), restore("entry", I.place), restore("entry", I.ben)])), Array(5).fill("applied"));
    assert.deepEqual(await warnings(s), []);
  } finally { await s.drop(); }
});

test("learned before established has no trash exemption: a trashed learn scene gives it and the trash warning, and the archive reading agrees", async () => {
  const s = await server({ clock: () => T });
  try {
    const { epoch, I, scope } = await seed(s);
    const f = fact(scope, { nodeId: I.s2, knowledge: [{ knower: I.ben, nodeId: I.s1 }] }); // established in scene B (s2), learned in earlier scene A (s1)
    assert.deepEqual(codes(await push(s, epoch, [f])), ["applied"]);
    assert.deepEqual(keys(await warnings(s)), [`learnedBeforeEstablished:${I.ben}:${I.s1}:${I.s2}`]);
    assert.deepEqual(codes(await push(s, epoch, [tombstone("manuscriptNode", I.s1, await head(s))])), ["applied"]);
    const w = await warnings(s);
    assert.deepEqual(keys(w), [`learnedBeforeEstablished:${I.ben}:${I.s1}:${I.s2}`, `learnedInTrash:${I.ben}:${I.s1}`].sort());
    const res = await s.inject({ method: "GET", url: "/api/export" });
    assert.equal(res.statusCode, 200);
    const back = await readArchive(res.rawPayload);
    try { assert.deepEqual(continuityWarnings(back.data), w); } finally { await back.close(); }
    assert.deepEqual(continuityWarnings(await s.store.readArchiveData()), w);
  } finally { await s.drop(); }
});

test("questionOverdue counts live text only: trashed scenes, chapters and parts do not make a question overdue", async () => {
  const s = await server({ clock: () => T });
  try {
    const { epoch, I, scope } = await seed(s);
    const [p1, ch1, sc1, ch2, sc2, sc3] = [1, 2, 3, 4, 5, 6].map(() => randomUUID());
    const node = (id: string, kind: string, orderKey: string, parentId?: string) =>
      create("manuscriptNode", { id, bookId: I.b1, kind, title: kind, orderKey, ...(parentId ? { parentId } : {}), ...STAMPS });
    const words = (id: string) => ({ opId: randomUUID(), op: "document", recordKind: "document", recordId: id, baseRevision: 0,
      value: { schema: "writers-rolltop/document", version: 1, nodeId: id, blocks: [{ id: randomUUID(), type: "paragraph", content: [{ type: "text", text: "Some words here." }] }] } });
    // Part p1 holds chapter ch1 (scene sc1, words) and chapter ch2 (scene sc2, words); chapter ch3 is live with a scene sc3 (words).
    const ops = [node(p1, "part", "p"), node(ch1, "chapter", "a", p1), node(sc1, "scene", "a", ch1), node(ch2, "chapter", "b", p1), node(sc2, "scene", "a", ch2),
      node(sc3, "scene", "c", I.c1), words(sc1), words(sc2), words(sc3)];
    assert.deepEqual(codes(await push(s, epoch, ops)), Array(ops.length).fill("applied"));
    const qCh1 = question(scope, { nodeId: ch1 }), qCh2 = question(scope, { nodeId: ch2 });
    assert.deepEqual(codes(await push(s, epoch, [qCh1, qCh2])), Array(2).fill("applied"));
    assert.deepEqual(keys(await warnings(s)), [`questionOverdue:${ch1}`, `questionOverdue:${ch2}`].sort());
    // Trashed chapters: their own questions are in the trash, so skipped.
    const h = await head(s);
    assert.deepEqual(codes(await push(s, epoch, [tombstone("manuscriptNode", ch1, h), tombstone("manuscriptNode", ch2, h)])), ["applied", "applied"]);
    assert.deepEqual(keys(await warnings(s)), []);
    // Restore one chapter: its text counts again. Then trash the scene under it instead: no text again.
    assert.deepEqual(codes(await push(s, epoch, [restore("manuscriptNode", ch1)])), ["applied"]);
    assert.deepEqual(keys(await warnings(s)), [`questionOverdue:${ch1}`]);
    assert.deepEqual(codes(await push(s, epoch, [tombstone("manuscriptNode", sc1, await head(s))])), ["applied"]);
    assert.deepEqual(keys(await warnings(s)), []);
    // A trashed part (parts are roots and a question sits on a chapter or scene, so the question is on a live chapter under it): in the trash, no warning. Restored: warns.
    assert.deepEqual(codes(await push(s, epoch, [restore("manuscriptNode", sc1), tombstone("manuscriptNode", p1, await head(s))])), ["applied", "applied"]);
    assert.deepEqual(keys(await warnings(s)), []);
    assert.deepEqual(codes(await push(s, epoch, [restore("manuscriptNode", p1)])), ["applied"]);
    assert.deepEqual(keys(await warnings(s)), [`questionOverdue:${ch1}`]);
  } finally { await s.drop(); }
});

test("a fix clears the warning at once (no stale answer), and the response is not cacheable", async () => {
  const s = await server({ clock: () => T });
  try {
    const { epoch, I, scope } = await seed(s);
    const f = fact(scope, { truth: "undecided", knowledge: [{ knower: "reader" }] });
    const q = question(scope, { nodeId: I.s2 });
    assert.deepEqual(codes(await push(s, epoch, [f, q])), ["applied", "applied"]);
    const res = await s.inject({ method: "GET", url: "/api/continuity/warnings" });
    assert.match(String(res.headers["cache-control"]), /no-store/);
    assert.equal(res.json().warnings.length, 2);
    const h = await head(s);
    assert.deepEqual(codes(await push(s, epoch, [set("fact", f.recordId, "truth", "true", h), set("question", q.recordId, "status", "decided", h)])), ["applied", "applied"]);
    assert.deepEqual(await warnings(s), []);
    // And it comes back when the change is undone.
    assert.deepEqual(codes(await push(s, epoch, [set("fact", f.recordId, "truth", "undecided", await head(s))])), ["applied"]);
    assert.deepEqual(keys(await warnings(s)), ["undecidedButKnown"]);
  } finally { await s.drop(); }
});

test("book overrides: a truth or status override decides per book; the key stays the same", async () => {
  const s = await server({ clock: () => T });
  try {
    const { epoch, I, scope } = await seed(s);
    const shared = fact(scope, { truth: "undecided", knowledge: [{ knower: "reader" }], overrides: [{ bookId: I.b2, truth: "true" }] }); // holds everywhere but book 2
    const only = fact(scope, { truth: "true", knowledge: [{ knower: "reader" }], overrides: [{ bookId: I.b2, truth: "undecided" }] }); // holds in book 2 only
    const q = question(scope, { nodeId: I.s2, overrides: [{ bookId: I.b1, status: "decided" }] });
    assert.deepEqual(codes(await push(s, epoch, [shared, only, q])), ["applied", "applied", "applied"]);
    const w = await warnings(s);
    assert.deepEqual(w.find((x) => x.recordId === shared.recordId), { key: "undecidedButKnown", kind: "undecidedButKnown", recordKind: "fact", recordId: shared.recordId, exceptBookIds: [I.b2] });
    assert.deepEqual(w.find((x) => x.recordId === only.recordId), { key: "undecidedButKnown", kind: "undecidedButKnown", recordKind: "fact", recordId: only.recordId, bookId: I.b2 });
    assert.deepEqual(w.find((x) => x.recordId === q.recordId), { key: `questionOverdue:${I.s2}`, kind: "questionOverdue", recordKind: "question", recordId: q.recordId, nodeId: I.s2, exceptBookIds: [I.b1] });
  } finally { await s.drop(); }
});

test("a dismissed key is not shown; a key that does not match still shows", async () => {
  const s = await server({ clock: () => T });
  try {
    const { epoch, I, scope } = await seed(s);
    const dismissedAt = C;
    const f = fact(scope, { truth: "undecided", knowledge: [{ knower: "reader" }], dismissedWarnings: [{ warning: "undecidedButKnown", dismissedAt }] });
    const q = question(scope, { nodeId: I.s2, dismissedWarnings: [{ warning: `questionOverdue:${I.s1}`, dismissedAt }] });
    const ev = create("event", { id: I.ev, scope, title: "E", orderKey: "m", sceneIds: [], participants: [], dismissedWarnings: [{ warning: `stateConflict:${I.ada}:${I.fld}`, dismissedAt }], ...STAMPS });
    const sc = (value: unknown) => create("stateChange", { id: randomUUID(), eventId: I.ev, entryId: I.ada, fieldId: I.fld, value, ...STAMPS });
    assert.deepEqual(codes(await push(s, epoch, [f, q, ev, sc(true), sc(false)])), Array(5).fill("applied"));
    assert.deepEqual(keys(await warnings(s)), [`questionOverdue:${I.s2}`]);
    assert.deepEqual(validateArchiveData(await s.store.readArchiveData()).warnings.filter((x) => x.code === "W_STATE_CONFLICT"), []);
  } finally { await s.drop(); }
});

test("warnings equal the archive's on the same library, exported and read back; keyless W_* codes are left out", async () => {
  const s = await server({ clock: () => T });
  try {
    const { epoch, I, scope } = await seed(s);
    const ev = (id: string, orderKey: string, ordinal: number) => create("event", { id, scope, title: "E", orderKey, when: { label: "x", calendar: "Reckoning", ordinal }, sceneIds: [], participants: [], ...STAMPS });
    const ev2 = randomUUID();
    const sc = (value: unknown) => create("stateChange", { id: randomUUID(), eventId: I.ev, entryId: I.ada, fieldId: I.fld, value, ...STAMPS });
    assert.deepEqual(codes(await push(s, epoch, [
      fact(scope, { truth: "undecided", knowledge: [{ knower: "reader" }], nodeId: I.s2 }), question(scope, { nodeId: I.s2 }),
      ev(I.ev, "a", 10), ev(ev2, "b", 4), sc(true), sc(false),
    ])), Array(6).fill("applied"));
    const before = await warnings(s);
    assert.ok(before.length >= 3);
    const res = await s.inject({ method: "GET", url: "/api/export" });
    assert.equal(res.statusCode, 200);
    const back = await readArchive(res.rawPayload);
    try {
      assert.deepEqual(continuityWarnings(back.data), before);
      // The archive validator agrees on the one warning it names with a key, and the chronology warning is there but has no key.
      const archiveCodes = back.warnings.map((x) => x.code).sort();
      assert.deepEqual(archiveCodes, ["W_CHRONOLOGY_ORDINAL", "W_STATE_CONFLICT"]);
      assert.equal(before.filter((x) => x.kind === "stateConflict").length, 1);
      assert.ok(before.every((x) => !["W_CHRONOLOGY_ORDINAL", "W_REFERENCE_TO_DELETED", "W_REFERENCE_ANCHOR_MISSING"].includes(x.kind)));
    } finally { await back.close(); }
  } finally { await s.drop(); }
});

test("the route needs a signed-in owner, and a server without a library answers 404", async () => {
  const anon = await server({ anonymous: true });
  try {
    const res = await anon.app.inject({ method: "GET", url: "/api/continuity/warnings" });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error.code, "UNAUTHENTICATED");
    assert.equal(res.body.includes("warnings"), false);
  } finally { await anon.drop(); }
  const s = await server({ clock: () => T });
  try {
    const res = await s.inject({ method: "GET", url: "/api/continuity/warnings" });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error.code, "LIBRARY_NOT_FOUND");
  } finally { await s.drop(); }
});
