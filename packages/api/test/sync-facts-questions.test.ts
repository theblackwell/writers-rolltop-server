// Facts and questions written by sync (M1-10 slice 2): the records are the archive's facts and questions, edits go
// through field ops, trash and restore keep them, bad values are refused without a write, and export reads them back.
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
  const I = { lib: randomUUID(), book: randomUUID(), book2: randomUUID(), chap: randomUUID(), scene: randomUUID(), ada: randomUUID(), ben: randomUUID(), fact: randomUUID(), q: randomUUID() };
  const doc = { schema: "writers-rolltop/document", version: 1, nodeId: I.scene, blocks: [{ id: randomUUID(), type: "paragraph", content: [{ type: "text", text: "Hi" }] }] };
  const entry = (id: string, name: string) => ({ id, entryType: "character", name, aliases: [], scope: { kind: "book", id: I.book }, values: {}, overrides: [], attachments: [], ...STAMPS });
  const res = await push(s, epoch, [
    create("library", { id: I.lib, title: "L", ...STAMPS }), create("book", { id: I.book, title: "B", orderKey: "m", ...STAMPS }),
    create("book", { id: I.book2, title: "B2", orderKey: "n", ...STAMPS }),
    create("manuscriptNode", { id: I.chap, bookId: I.book, kind: "chapter", title: "C", orderKey: "m", ...STAMPS }),
    create("manuscriptNode", { id: I.scene, bookId: I.book, parentId: I.chap, kind: "scene", title: "S", orderKey: "m", ...STAMPS }),
    { opId: randomUUID(), op: "document", recordKind: "document", recordId: I.scene, baseRevision: 0, value: doc },
    create("entry", entry(I.ada, "Ada")), create("entry", entry(I.ben, "Ben")),
  ]);
  assert.deepEqual(codes(res), Array(8).fill("applied"), res.body);
  return { epoch, I, scope: { kind: "book", id: I.book } };
}

test("facts and questions: create, edit by field, unset, trash, restore, and the export reads them back", async () => {
  const s = await server({ clock: () => T });
  try {
    const { epoch, I, scope } = await seed(s);
    const fact = { id: I.fact, scope, text: "Ada is seven", truth: "undecided", nodeId: I.scene, entryIds: [I.ada], knowledge: [{ knower: "reader", nodeId: I.chap }, { knower: I.ben }], orderKey: "m", ...STAMPS };
    const q = { id: I.q, scope, text: "Who is Ben?", topic: "Cast", status: "open", entryIds: [I.ben], nodeId: I.chap, orderKey: "m", ...STAMPS };
    assert.deepEqual(codes(await push(s, epoch, [create("fact", fact), create("question", q)])), ["applied", "applied"]);
    let h = await head(s);
    assert.deepEqual(codes(await push(s, epoch, [
      set("fact", I.fact, "truth", "false", h), set("fact", I.fact, "text", "Ada is eight", h), set("fact", I.fact, "entryIds", [I.ada, I.ben], h),
      unset("fact", I.fact, "nodeId", h),
      set("question", I.q, "status", "decided", h), set("question", I.q, "decision", "Ben is Ada's brother", h), unset("question", I.q, "topic", h),
    ])), Array(7).fill("applied"));
    let data = await s.store.readArchiveData();
    assert.deepEqual(validateArchiveData(data).errors, []);
    const f = data.facts[0] as any, qq = data.questions[0] as any;
    assert.equal(f.truth, "false"); assert.equal(f.text, "Ada is eight"); assert.equal("nodeId" in f, false);
    assert.deepEqual(f.entryIds, [I.ada, I.ben]); assert.deepEqual(f.knowledge, fact.knowledge);
    assert.equal(qq.status, "decided"); assert.equal(qq.decision, "Ben is Ada's brother"); assert.equal("topic" in qq, false);
    // Trash and restore.
    h = await head(s);
    assert.deepEqual(codes(await push(s, epoch, [tombstone("fact", I.fact, h), tombstone("question", I.q, h)])), ["applied", "applied"]);
    data = await s.store.readArchiveData();
    assert.ok((data.facts[0] as any).deletedAt && (data.questions[0] as any).deletedAt);
    assert.deepEqual(codes(await push(s, epoch, [set("fact", I.fact, "text", "late", h)])), ["RECORD_DELETED"]);
    assert.deepEqual(codes(await push(s, epoch, [restore("fact", I.fact), restore("question", I.q)])), ["applied", "applied"]);
    data = await s.store.readArchiveData();
    assert.equal((data.facts[0] as any).deletedAt, undefined);
    assert.equal((data.facts[0] as any).text, "Ada is eight");
    // The real export, read back and validated.
    const res = await s.inject({ method: "GET", url: "/api/export" });
    assert.equal(res.statusCode, 200);
    const back = await readArchive(res.rawPayload);
    try {
      assert.equal(back.data.facts.length, 1); assert.equal(back.data.questions.length, 1);
      assert.deepEqual(back.data.facts[0], data.facts[0]);
      assert.deepEqual(back.data.questions[0], data.questions[0]);
    } finally { await back.close(); }
  } finally { await s.drop(); }
});

test("facts and questions: bad values are refused and nothing is written", async () => {
  const s = await server({ clock: () => T });
  try {
    const { epoch, I, scope } = await seed(s);
    const n = () => randomUUID();
    const fact = (extra: object) => create("fact", { id: n(), scope, text: "t", truth: "true", entryIds: [], knowledge: [], orderKey: "m", ...STAMPS, ...extra });
    const question = (extra: object) => create("question", { id: n(), scope, text: "t", status: "open", entryIds: [], orderKey: "m", ...STAMPS, ...extra });
    const bad: any[] = [
      fact({ truth: "maybe" }), fact({ text: "" }), fact({ text: "x".repeat(20001) }), fact({ text: "a\u0000b" }),
      fact({ entryIds: [I.ada, I.ada] }), fact({ knowledge: [{ knower: "reader" }, { knower: "reader" }] }), fact({ knowledge: [{ knower: I.ada }] .concat([{ knower: "nobody" }] as any) }),
      question({ status: "closed" }), question({ topic: "x".repeat(65) }), question({ decision: "x".repeat(20001) }), question({ text: undefined }),
      fact({ entryIds: [n()] }), question({ nodeId: n() }), fact({ nodeId: I.book }),
      fact({ knowledge: [{ knower: "reader", nodeId: n() }] }),
      fact({ scope: { kind: "book", id: n() } }),
    ];
    const before = await s.query("SELECT (SELECT count(*) FROM fact) AS f, (SELECT count(*) FROM question) AS q, (SELECT head FROM sync_state) AS h");
    const res = await push(s, epoch, bad);
    const got = codes(res);
    assert.equal(got.length, bad.length);
    assert.ok(got.every((c) => c !== "applied"), JSON.stringify(got));
    assert.deepEqual(await s.query("SELECT (SELECT count(*) FROM fact) AS f, (SELECT count(*) FROM question) AS q, (SELECT head FROM sync_state) AS h"), before);
    // A field edit that would leave an invalid record is refused too.
    const okFact = fact({}), okQuestion = question({});
    assert.deepEqual(codes(await push(s, epoch, [okFact, okQuestion])), ["applied", "applied"]);
    const h = await head(s);
    assert.deepEqual(codes(await push(s, epoch, [
      set("fact", okFact.recordId, "truth", "maybe", h), set("fact", okFact.recordId, "nodeId", I.book, h), set("question", okQuestion.recordId, "status", "x", h),
    ])), ["INVALID_VALUE", "REFERENCE_UNRESOLVED", "INVALID_VALUE"]);
    // A knower must be a character: a non-character entry is an integrity violation.
    const place = randomUUID();
    assert.deepEqual(codes(await push(s, epoch, [create("entry", { id: place, entryType: "location", name: "Hall", aliases: [], scope, values: {}, overrides: [], attachments: [], ...STAMPS })])), ["applied"]);
    assert.deepEqual(codes(await push(s, epoch, [fact({ knowledge: [{ knower: place }] })])), ["INTEGRITY_VIOLATION"]);
    // A knowledge entry whose node is trashed.
    assert.deepEqual(codes(await push(s, epoch, [tombstone("manuscriptNode", I.chap, await head(s))])), ["applied"]);
    const trashed = await push(s, epoch, [fact({ knowledge: [{ knower: "reader", nodeId: I.chap }] })]);
    // Accepted; the server returns no warning for it (the result carries only opId, status and seq).
    assert.deepEqual(codes(trashed), ["applied"]);
    assert.deepEqual(Object.keys(trashed.json().results[0]).sort(), ["opId", "seq", "status"]);
  } finally { await s.drop(); }
});
