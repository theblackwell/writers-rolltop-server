// Rules of the sync client that need no browser: which recovery choices the server's records allow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SyncClient } from "../src/sync/client.ts";
import { applyChange } from "../src/sync/model.ts";
import type { SyncChange } from "../src/sync/model.ts";
import type { RecoveryItem } from "../src/sync/local.ts";

const U = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let seq = 0;
const create = (recordKind: string, value: Record<string, unknown>): SyncChange =>
  ({ seq: ++seq, at: "2026-11-11T12:00:00Z", opId: U(500 + seq), deviceId: U(800), change: "create", recordKind, recordId: String(value.id), value });
const item = (sceneId: string): RecoveryItem =>
  ({ sceneId, conflictId: "c", source: "conflict", sceneTitle: "T", mine: { schema: "writers-rolltop/document", version: 1, nodeId: sceneId, blocks: [] }, theirs: null, createdAt: "2026-11-11T12:00:00Z" });

test("a copy (keep both, or a new scene) is offered for a scene only; front and back matter get the other choices", () => {
  seq = 0;
  const c = new SyncClient(0);
  applyChange(c.model, create("library", { id: U(1), title: "L" }));
  applyChange(c.model, create("book", { id: U(2), title: "B", orderKey: "m" }));
  applyChange(c.model, create("manuscriptNode", { id: U(3), bookId: U(2), kind: "chapter", title: "C", orderKey: "m" }));
  applyChange(c.model, create("manuscriptNode", { id: U(4), bookId: U(2), parentId: U(3), kind: "scene", title: "S", orderKey: "m" }));
  applyChange(c.model, create("manuscriptNode", { id: U(5), bookId: U(2), kind: "frontMatter", title: "F", orderKey: "a" }));
  applyChange(c.model, create("manuscriptNode", { id: U(6), bookId: U(2), kind: "backMatter", title: "K", orderKey: "z" }));
  assert.deepEqual(c.choicesFor(item(U(4))), ["mine", "saved", "both"]);
  assert.deepEqual(c.choicesFor(item(U(5))), ["mine", "saved"]);
  assert.deepEqual(c.choicesFor(item(U(6))), ["mine", "saved"]);
  // A trashed front matter node: no copy can be made of it either.
  c.model.records.get("manuscriptNode")!.get(U(5))!.deletedAt = "2026-11-11T12:00:00Z";
  assert.deepEqual(c.choicesFor(item(U(5))), []);
  // A trashed scene may become a new scene.
  c.model.records.get("manuscriptNode")!.get(U(4))!.deletedAt = "2026-11-11T12:00:00Z";
  assert.deepEqual(c.choicesFor(item(U(4))), ["copy"]);
  c.stop();
});

// ----- stubs for the client's calls to the server and to IndexedDB -----
import type { Held, LibraryDb } from "../src/sync/local.ts";
import type { ClientIo } from "../src/sync/client.ts";
import type { Op, OpResult, PushAnswer } from "../src/sync/http.ts";
import { NetworkError } from "../src/sync/http.ts";

const doc = (nodeId: string, text: string) =>
  ({ schema: "writers-rolltop/document", version: 1, nodeId, blocks: [{ type: "paragraph", text }] }) as unknown as RecoveryItem["mine"];
const tick = () => new Promise<void>((ok) => setImmediate(ok));
const gate = () => { let open!: () => void; const p = new Promise<void>((ok) => { open = ok; }); return { p, open }; };

interface StubDb extends LibraryDb { closed: boolean; heldRows: Map<string, Held>; recoveryRows: RecoveryItem[] }
function stubDb(opts: { beforePutRecovery?: Promise<void> } = {}): StubDb {
  const db: StubDb = {
    closed: false, heldRows: new Map(), recoveryRows: [],
    allHeld: async () => [...db.heldRows.values()],
    putHeld: async (h) => { db.heldRows.set(h.sceneId, h); },
    deleteHeld: async (id) => { db.heldRows.delete(id); },
    allRecovery: async () => [...db.recoveryRows],
    putRecovery: async (r) => { await opts.beforePutRecovery; db.recoveryRows = [...db.recoveryRows.filter((x) => !(x.sceneId === r.sceneId && x.conflictId === r.conflictId)), r]; },
    deleteRecovery: async (s, c) => { db.recoveryRows = db.recoveryRows.filter((x) => !(x.sceneId === s && x.conflictId === c)); },
    close: () => { db.closed = true; },
  };
  return db;
}
const emptyFeed = (epoch: string) => async () => ({ kind: "ok" as const, epoch, head: 0, changes: [], next: 0 });
const noConflicts = async () => ({ kind: "ok" as const, conflicts: [] });

/** A client that is ready, with a scene, and whose calls are stubbed. */
function readyClient(io: Partial<ClientIo>) {
  seq = 0;
  const c = new SyncClient(0, { getChanges: emptyFeed("E1"), getConflicts: noConflicts, ...io });
  applyChange(c.model, create("library", { id: U(1), title: "L" }));
  applyChange(c.model, create("book", { id: U(2), title: "B", orderKey: "m" }));
  applyChange(c.model, create("manuscriptNode", { id: U(3), bookId: U(2), kind: "chapter", title: "C", orderKey: "m" }));
  applyChange(c.model, create("manuscriptNode", { id: U(4), bookId: U(2), parentId: U(3), kind: "scene", title: "S", orderKey: "m" }));
  applyChange(c.model, create("manuscriptNode", { id: U(7), bookId: U(2), parentId: U(3), kind: "scene", title: "S2", orderKey: "n" }));
  c.model.docs.set(U(4), { revision: 1, seq: 9, doc: doc(U(4), "saved") });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = c as any;
  p.state = { ...p.state, phase: "ready", libraryId: U(1) };
  p.active = true;
  p.epoch = "E1";
  p.epochKnown = true;
  return { c, p };
}

test("a save that runs while the epoch change is being routed is sent to the author, never pushed under the new epoch", async () => {
  const hold = gate();
  const db = stubDb({ beforePutRecovery: hold.p }); // the routing is held up while it stores the first text
  const pushed: Op[][] = [];
  const { c, p } = readyClient({ pushOps: async (_e, _d, ops) => { pushed.push(ops); return { kind: "invalid" } as PushAnswer; } });
  p.db = db;
  p.held.set(U(4), { sceneId: U(4), doc: doc(U(4), "first"), baseRevision: 1, opId: U(901), status: "sent", savedAt: "x" });
  p.epoch = "E2"; p.epochGen = 1; // the library's history changed
  const routing = p.routeEpochChange() as Promise<void>;
  await tick(); // the routing has taken its list (scene 4) and waits for the device
  const save = p.doSave(U(7), doc(U(7), "typed under the old history"), "E1") as Promise<{ kind: string }>;
  await tick();
  hold.open();
  await routing;
  assert.equal((await save).kind, "recovery");
  assert.equal(pushed.length, 0, "nothing is pushed under the new epoch");
  assert.equal(p.held.size, 0);
  const items = c.getState().recovery;
  assert.deepEqual(items.map((r) => r.sceneId).sort(), [U(4), U(7)]);
  assert.ok(items.some((r) => r.sceneId === U(7) && JSON.stringify(r.mine).includes("typed under the old history")));
  // The next save is made under the new epoch and is pushed as itself.
  c.stop();
});

test("text typed under the old history, saved while the routing awaits the conflicts call, goes to the author and is never pushed", async () => {
  const hold = gate();
  const pushed: Op[][] = [];
  const { c, p } = readyClient({
    pushOps: async (_e, _d, ops) => { pushed.push(ops); return { kind: "invalid" } as PushAnswer; },
    getConflicts: async () => { await hold.p; return { kind: "ok" as const, conflicts: [] }; },
  });
  p.db = stubDb();
  p.epoch = "E2"; p.epochGen = 1;
  const routing = p.routeEpochChange() as Promise<void>;
  await tick(); // the routing waits in the conflicts call
  const old = p.doSave(U(4), doc(U(4), "old history"), "E1", 0) as Promise<{ kind: string }>;
  const fresh = c.saveScene(U(7), doc(U(7), "typed meanwhile")); // captured under the new epoch while routing is pending
  await tick();
  hold.open();
  await routing;
  assert.equal((await old).kind, "recovery");
  assert.equal((await fresh).kind, "recovery");
  assert.equal(pushed.length, 0, "nothing is pushed under the new epoch");
  assert.equal(p.held.size, 0);
  const items = c.getState().recovery;
  assert.equal(items.find((r) => r.sceneId === U(4))?.source, "unsent");
  assert.ok(items.some((r) => r.sceneId === U(7)));
  assert.equal(p.epochPending, false);
  c.stop();
});

test("a stop and start during the routing: routing completes for the new run without another poll", async () => {
  const hold = gate();
  const { c, p } = readyClient({});
  p.epochGen = 1;
  p.epochHolds.push(hold.p);
  const first = p.routeEpochChange() as Promise<void>;
  await tick();
  c.stop();
  p.active = true; p.runId++; // started again
  const second = p.routeEpochChange() as Promise<void>; // resolves at once: routing is still set by the stale run
  await second;
  assert.equal(p.epochPending, true);
  hold.open();
  await first;
  await tick(); await tick();
  assert.equal(p.epochPending, false, "routing completed for the new run");
  c.stop();
});

test("two overlapping holdForAuthor calls for the same text add one recovery item", async () => {
  const hold = gate();
  const { c, p } = readyClient({});
  p.db = stubDb({ beforePutRecovery: hold.p });
  const text = doc(U(4), "typed");
  const a = c.holdForAuthor(U(4), text, "unsent", "r");
  const b = c.holdForAuthor(U(4), doc(U(4), "typed"), "unsent", "r");
  await tick();
  hold.open();
  await Promise.all([a, b]);
  assert.equal(c.getState().recovery.length, 1);
  c.stop();
});

test("the session-end notice says kept only when the text was written to a database", async () => {
  const run = async (opts: { openFails: boolean; draft: boolean }) => {
    const { c, p } = readyClient({ openLibraryDb: async () => { if (opts.openFails) throw new Error("IndexedDB blocked"); return stubDb(); } });
    await p.openDb(U(1));
    if (opts.draft) await c.keepDraft(U(4), doc(U(4), "typed"));
    let info: { kept: boolean; lost: boolean } | undefined;
    c.onSessionEnded = (i) => { info = i; };
    await p.endSession();
    c.stop();
    return info!;
  };
  const blocked = await run({ openFails: true, draft: true });
  assert.equal(blocked.kept, false);
  assert.equal(blocked.lost, true);
  assert.deepEqual(await run({ openFails: false, draft: true }), { kept: true, lost: false });
  assert.deepEqual(await run({ openFails: true, draft: false }), { kept: false, lost: false });
  assert.deepEqual(await run({ openFails: false, draft: false }), { kept: false, lost: false });
});

test("a client stopped while the epoch change is being routed opens no database", async () => {
  const hold = gate();
  const opened: StubDb[] = [];
  const { c, p } = readyClient({ openLibraryDb: async () => { const d = stubDb(); opened.push(d); return d; } });
  p.state = { ...p.state, libraryId: "another-library" }; // the library differs, so routing would open a database
  p.epochGen = 1;
  p.epochHolds.push(hold.p);
  const routing = p.routeEpochChange() as Promise<void>;
  await tick();
  c.stop();
  hold.open();
  await routing;
  assert.equal(opened.length, 0);
  assert.equal(p.db, undefined);
});

test("a pull asked for while another pull started at the end of the one running does not run at the same time", async () => {
  let running = 0, most = 0, calls = 0;
  const { c, p } = readyClient({
    getChanges: async () => { calls++; running++; most = Math.max(most, running); await tick(); running--; return { kind: "ok", epoch: "E1", head: 0, changes: [], next: 0 }; },
  });
  const a = c.pull();
  const b = c.pull(); // queued behind a
  // A caller that runs the moment a ends (as the conflicts resync pull of the epoch routing does) starts its own pull first.
  const early = (p.pulling as Promise<void>).then(() => c.pull());
  await Promise.all([a, b, early]);
  assert.equal(most, 1, "two pull loops ran at once");
  assert.ok(calls >= 2);
  c.stop();
});

test("a scene with no parent gets no copy choice", () => {
  const { c } = readyClient({});
  applyChange(c.model, create("manuscriptNode", { id: U(8), bookId: U(2), kind: "scene", title: "Orphan", orderKey: "p" }));
  assert.deepEqual(c.choicesFor(item(U(8))), ["mine", "saved"]);
  c.model.records.get("manuscriptNode")!.get(U(8))!.deletedAt = "2026-11-11T12:00:00Z";
  assert.deepEqual(c.choicesFor(item(U(8))), []);
  c.stop();
});

const ok = (ops: Op[], statuses: Array<Partial<OpResult>> = []): PushAnswer =>
  ({ kind: "ok", epoch: "E1", head: 1, results: ops.map((o, i) => ({ opId: o.opId, status: "applied", seq: 20 + i, revision: 1, ...statuses[i] }) as OpResult) });

test("keep both: step 2 follows step 1 only when it is applied; op ids are reused for the same content and renewed after a refusal", async () => {
  const pushes: Op[][] = [];
  let script: Array<(ops: Op[]) => PushAnswer> = [];
  const { c, p } = readyClient({ pushOps: async (_e, _d, ops) => { pushes.push(ops); const f = script.shift(); if (!f) throw new NetworkError("down"); return f(ops); } });
  const ids = (ops: Op[]) => ops.map((o) => o.opId);
  const conflictItem = { ...item(U(4)), mine: doc(U(4), "mine") };
  await c.addRecovery(conflictItem);
  const current = () => c.getState().recovery.find((r) => r.sceneId === U(4))!;

  // 1. Step 1 refused (slot 1 rejected): step 2 is not sent; the rejected slots get new ids.
  script = [(ops) => ok(ops, [{}, { status: "rejected", code: "INVALID_VALUE" }])];
  let r = await c.resolveItem(current(), "both");
  assert.equal(r.ok, false);
  assert.equal(pushes.length, 1, "step 2 not sent after a refused step 1");
  const first = ids(pushes[0]!);
  const copyId1 = current().attempt!.copyId;
  // 2. Retry: only the refused slot (1) has a new id; slot 0 was applied, so it repeats (a duplicate) under the same copy.
  script = [(ops) => ok(ops), () => { throw new NetworkError("lost"); }];
  r = await c.resolveItem(current(), "both");
  assert.equal(pushes.length, 3, "step 1 applied, then step 2 was sent");
  const second = ids(pushes[1]!);
  assert.equal(second[0], first[0]);
  assert.notEqual(second[1], first[1]);
  assert.equal(current().attempt!.copyId, copyId1);
  assert.equal(pushes[1]![1]!.recordId, current().attempt!.copyId);
  // 3. Step 2's answer was lost. Retry with the same saved text: the same op ids, in both steps (step 1 answers duplicate).
  const step2 = ids(pushes[2]!);
  script = [(ops) => ok(ops, [{ status: "duplicate", firstStatus: "applied" }, { status: "duplicate", firstStatus: "applied" }]),
    (ops) => ok(ops, [{ revision: 2 }, { status: "applied" }])];
  r = await c.resolveItem(current(), "both");
  assert.deepEqual(ids(pushes[3]!), second, "the same content is sent under the same op ids");
  assert.deepEqual(ids(pushes[4]!), step2);
  assert.equal(r.ok, true);
  c.stop();
});

test("keep both: a retry after the saved text changed uses new op ids for the copy", async () => {
  const pushes: Op[][] = [];
  let script: Array<(ops: Op[]) => PushAnswer> = [];
  const { c, p } = readyClient({ pushOps: async (_e, _d, ops) => { pushes.push(ops); const f = script.shift(); if (!f) throw new NetworkError("down"); return f(ops); } });
  await c.addRecovery({ ...item(U(4)), mine: doc(U(4), "mine") });
  const current = () => c.getState().recovery.find((r) => r.sceneId === U(4))!;
  // Step 1 applies, step 2's answer is lost.
  script = [(ops) => ok(ops)];
  await c.resolveItem(current(), "both");
  assert.equal(pushes.length, 2);
  const [create1, copyDoc1] = pushes[0]!;
  const step2 = pushes[1]!.map((o) => o.opId);
  // Another device saved the scene: the saved text the copy is made from is now different.
  c.model.docs.set(U(4), { revision: 2, seq: 30, doc: doc(U(4), "saved again") });
  script = [(ops) => ok(ops), (ops) => ok(ops)];
  await c.resolveItem(current(), "both");
  const [create2, copyDoc2] = pushes[2]!;
  assert.notEqual(create2!.opId, create1!.opId);
  assert.notEqual(copyDoc2!.opId, copyDoc1!.opId);
  assert.notEqual(create2!.recordId, create1!.recordId, "a copy that already exists is not created again");
  assert.deepEqual((copyDoc2!.value as { blocks: unknown }).blocks, [{ type: "paragraph", text: "saved again" }]);
  void p; void step2;
  c.stop();
});
