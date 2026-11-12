// M1-10 slice 1 review fix: opening the library's IndexedDB must never leave the studio loading for ever.
// A second tab that still holds the older version open blocks the upgrade; the open is bounded and the studio says what to do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SyncClient } from "../src/sync/client.ts";
import type { ClientIo } from "../src/sync/client.ts";
import { DB_BLOCKED_MESSAGE, DbBlockedError, openLibraryDb } from "../src/sync/local.ts";
import type { LibraryDb } from "../src/sync/local.ts";
import type { SyncChange } from "../src/sync/model.ts";

interface FakeReq { result?: unknown; error?: unknown; onsuccess?: () => void; onerror?: () => void; onblocked?: () => void; onupgradeneeded?: () => void }
interface FakeDb { closed: boolean; onversionchange: (() => void) | null; close(): void; objectStoreNames: { contains(n: string): boolean } }
const fakeDb = (): FakeDb => ({ closed: false, onversionchange: null, close() { this.closed = true; }, objectStoreNames: { contains: () => true } });
const withIndexedDb = async (open: () => FakeReq, f: () => Promise<void>) => {
  const g = globalThis as unknown as { indexedDB?: unknown };
  const before = g.indexedDB;
  g.indexedDB = { open };
  try { await f(); } finally { g.indexedDB = before; }
};
const tick = () => new Promise<void>((ok) => setImmediate(ok));

test("an open request that never answers gives up after the wait, and a database that opens late is closed", async () => {
  const req: FakeReq = {};
  await withIndexedDb(() => req, async () => {
    await assert.rejects(openLibraryDb("lib", 20), DbBlockedError);
    const late = fakeDb();
    req.result = late; req.onsuccess?.();
    assert.equal(late.closed, true, "nobody uses a database that opened after the call gave up");
  });
});

test("an upgrade that is blocked by another tab is not waited for", async () => {
  const req: FakeReq = {};
  await withIndexedDb(() => { setImmediate(() => req.onblocked?.()); return req; }, async () => {
    await assert.rejects(openLibraryDb("lib", 5000), DbBlockedError); // answers at once, not after 5 s
  });
});

test("a database that opened closes itself when another tab wants to upgrade it", async () => {
  const req: FakeReq = {};
  const db = fakeDb();
  await withIndexedDb(() => { req.result = db; setImmediate(() => req.onsuccess?.()); return req; }, async () => {
    await openLibraryDb("lib", 5000);
    assert.equal(typeof db.onversionchange, "function");
    db.onversionchange!();
    assert.equal(db.closed, true, "this client never blocks a later upgrade");
  });
});

const libraryFeed = (): Partial<ClientIo> => ({
  getChanges: async () => ({
    kind: "ok" as const, epoch: "E1", head: 1, next: 1,
    changes: [{ seq: 1, at: "2026-11-11T12:00:00Z", opId: "10000000-0000-4000-8000-000000000001", deviceId: "10000000-0000-4000-8000-000000000002", change: "create", recordKind: "library", recordId: "10000000-0000-4000-8000-000000000003", value: { id: "10000000-0000-4000-8000-000000000003", title: "L" } } as SyncChange],
  }),
  getConflicts: async () => ({ kind: "ok" as const, conflicts: [] }),
});

test("the studio is ready, with a plain message, when the database never opens", async () => {
  const c = new SyncClient(0, { ...libraryFeed(), openLibraryDb: () => new Promise(() => {}) });
  (c as unknown as { dbWaitMs: number }).dbWaitMs = 20;
  await c.start();
  const s = c.getState();
  assert.equal(s.phase, "ready", "never a permanent loading state");
  assert.equal(s.keepsCopies, false);
  assert.equal(s.storageMessage, DB_BLOCKED_MESSAGE);
  assert.equal(DB_BLOCKED_MESSAGE, "Close the other tab that has this library open, then reload.");
  c.stop();
});

test("the studio is ready, with the same message, when the upgrade is blocked", async () => {
  const c = new SyncClient(0, { ...libraryFeed(), openLibraryDb: async () => { throw new DbBlockedError("blocked"); } });
  await c.start();
  assert.equal(c.getState().phase, "ready");
  assert.equal(c.getState().keepsCopies, false);
  assert.equal(c.getState().storageMessage, DB_BLOCKED_MESSAGE);
  c.stop();
});

test("a database that opens after the studio gave up is closed, and a failure that is not a block shows no message", async () => {
  const late = fakeDb();
  let open!: (db: LibraryDb) => void;
  const c = new SyncClient(0, { ...libraryFeed(), openLibraryDb: () => new Promise((ok) => { open = ok; }) });
  (c as unknown as { dbWaitMs: number }).dbWaitMs = 10;
  await c.start();
  open(late as unknown as LibraryDb); await tick();
  assert.equal(late.closed, true);
  c.stop();
  const d = new SyncClient(0, { ...libraryFeed(), openLibraryDb: async () => { throw new Error("denied"); } });
  await d.start();
  assert.equal(d.getState().phase, "ready");
  assert.equal(d.getState().keepsCopies, false);
  assert.equal(d.getState().storageMessage, undefined);
  d.stop();
});
