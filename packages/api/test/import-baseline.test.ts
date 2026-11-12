// An archive import writes its records into the sync change feed as the new epoch's baseline (sync-protocol-v1.md, "Import
// baseline"). Real store, scratch PostgreSQL. The replay below is the test's own client: it applies the feed in sequence to a
// record model, the way the sync scenarios treat a pulled feed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readArchive, writeArchive } from "@writers-rolltop/archive";
import type { ArchiveData, Rec } from "@writers-rolltop/archive";
import { importArchiveBytes } from "@writers-rolltop/store";
import { semantic } from "../../store/test/semantic.ts";
import { archiveFixtures, server } from "./helpers.ts";
import type { Server } from "./helpers.ts";

const T = new Date("2026-11-11T12:00:00Z");
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const IMPORT_DEVICE = "1b0b0000-0000-4000-8000-00000000c0de";
const UUID_IN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const SAMPLE = path.join(archiveFixtures, "valid", "sample-library.rolltop");

const state = async (s: Server) => (await s.query("SELECT epoch, head FROM sync_state"))[0] as { epoch: string; head: string };
const push = (s: Server, epoch: string, deviceId: string, ops: unknown[]) => s.inject({ method: "POST", url: "/api/sync/v1/push", payload: { epoch, deviceId, ops } });
const results = (res: { json(): any }) => res.json().results as any[];
const doImport = (s: Server, payload: Buffer) => s.inject({ method: "POST", url: "/api/import", payload, headers: { "content-type": "application/zip" } });

/** Every change of the feed, paged the way a client pages. */
async function pullAll(s: Server): Promise<{ epoch: string; head: number; changes: any[] }> {
  const { epoch } = await state(s);
  const changes: any[] = [];
  let after = 0, head = 0;
  for (;;) {
    const res = await s.inject({ method: "GET", url: `/api/sync/v1/changes?epoch=${epoch}&after=${after}&limit=500` });
    assert.equal(res.statusCode, 200, res.body);
    const page = res.json();
    head = page.head;
    changes.push(...page.changes);
    if (page.changes.length === 0 || page.next >= page.head) break;
    after = page.next;
  }
  return { epoch, head, changes };
}

/**
 * A client applying the feed in order. Fails on a gap in seq, on a create that points at a record the client has not seen yet
 * (a reference error), and on a document for an unknown node. Returns the records as ArchiveData (attachments copied from the
 * archive: sync v1 carries no attachment bytes).
 */
function replay(changes: any[], original: ArchiveData): ArchiveData {
  const allIds = new Set<string>();
  const collect = (r: Rec): void => { allIds.add(r.id as string); };
  const o = original;
  collect(o.library.library as Rec);
  for (const list of [o.library.universes, o.library.series, o.library.books, o.library.manuscriptNodes, o.templates, o.fields, o.entries, o.notes, o.references,
    o.relationships.relationshipTypes, o.relationships.relationships, o.facts, o.questions, o.events, o.stateChanges]) (list as Rec[]).forEach(collect);

  const entryIds = new Set(o.entries.map((e) => e.id as string));
  const seen = new Set<string>();
  const byKind = new Map<string, Map<string, Rec>>();
  const documents = new Map<string, any>();
  let expect = 1;
  for (const c of changes) {
    assert.equal(c.seq, expect++, "seq is gapless from 1");
    assert.equal(c.deviceId, IMPORT_DEVICE);
    if (c.change === "create") {
      // The one exception (Spec, Import baseline): a link from an entry to an entry (or itself) inside the entry's own `values` or the
      // `values` of one of its `overrides` may point forward or in a circle (A links B, B links A): no order resolves it. Only those
      // entry ids are skipped; every other reference, in those places too, must already be in the feed.
      const stripEntryLinks = (v: unknown): unknown => JSON.parse(JSON.stringify(v).replace(UUID_IN, (m) => (entryIds.has(m) ? "-" : m)));
      const checked = c.recordKind === "entry"
        ? { ...c.value, values: stripEntryLinks(c.value.values), overrides: (c.value.overrides ?? []).map((ov: any) => ({ ...ov, values: stripEntryLinks(ov.values) })) }
        : c.value;
      for (const m of JSON.stringify(checked).matchAll(UUID_IN)) {
        if (m[0] !== c.recordId && allIds.has(m[0])) assert.ok(seen.has(m[0]), `${c.recordKind} ${c.recordId} refers to ${m[0]} before the feed creates it`);
      }
      seen.add(c.recordId);
      assert.equal(c.value.deletedAt, undefined, "a create never carries deletedAt");
      if (!byKind.has(c.recordKind)) byKind.set(c.recordKind, new Map());
      byKind.get(c.recordKind)!.set(c.recordId, { ...c.value });
    } else if (c.change === "tombstone") {
      const rec = byKind.get(c.recordKind)?.get(c.recordId);
      assert.ok(rec, "a tombstone follows its create");
      rec.deletedAt = c.at;
      assert.equal(c.value, undefined);
    } else if (c.change === "document") {
      assert.ok(byKind.get("manuscriptNode")?.has(c.recordId), "a document follows its node");
      assert.equal(c.revision, 1);
      documents.set(c.recordId, c.value);
    } else assert.fail(`unexpected change ${c.change}`);
  }
  const list = (k: string): Rec[] => [...(byKind.get(k)?.values() ?? [])];
  return {
    manifestExtra: original.manifestExtra,
    library: { library: list("library")[0]!, universes: list("universe"), series: list("series"), books: list("book"), manuscriptNodes: list("manuscriptNode") },
    references: list("reference"), notes: list("note"), attachments: original.attachments,
    entries: list("entry"), templates: list("template"), fields: list("field"),
    relationships: { relationshipTypes: list("relationshipType"), relationships: list("relationship") },
    facts: list("fact"), questions: list("question"), events: list("event"), stateChanges: list("stateChange"),
    documents,
  } as ArchiveData;
}

/** Every record of the archive has exactly one create in the feed, and the feed has no other create. */
function assertOneCreateEach(changes: any[], data: ArchiveData): void {
  const ids: string[] = [];
  const o = data;
  ids.push((o.library.library as Rec).id as string);
  for (const list of [o.library.universes, o.library.series, o.library.books, o.library.manuscriptNodes, o.templates, o.fields, o.entries, o.notes, o.references,
    o.relationships.relationshipTypes, o.relationships.relationships, o.facts, o.questions, o.events, o.stateChanges]) for (const r of list as Rec[]) ids.push(r.id as string);
  const creates = changes.filter((c) => c.change === "create");
  assert.equal(new Set(ids).size, ids.length, "the archive's record ids are distinct");
  assert.equal(creates.length, ids.length, "the create count equals the archive's record count");
  const per = new Map<string, number>();
  for (const c of creates) per.set(c.recordId, (per.get(c.recordId) ?? 0) + 1);
  for (const id of ids) assert.equal(per.get(id), 1, `exactly one create for ${id}`);
  assert.equal(per.size, ids.length, "no create for a record the archive lacks");
}

const sampleBytes = (): Promise<Buffer> => readFile(SAMPLE);
async function sampleData(): Promise<{ data: ArchiveData; libraryId: string }> {
  const c = await readArchive(SAMPLE);
  try { return { data: c.data, libraryId: c.manifest.libraryId as string }; } finally { await c.close(); }
}

test("the sample library's records are the feed from seq 1: the whole library, in dependency order, one import device, revision 1 documents", async () => {
  const s = await server({ clock: () => T });
  try {
    const imp = await doImport(s, await sampleBytes());
    assert.equal(imp.statusCode, 201, imp.body);
    const feed = await pullAll(s);
    const { data, libraryId } = await sampleData();
    assert.equal(feed.changes.length, feed.head);
    assert.equal(feed.changes[0].recordKind, "library");
    assert.equal(feed.changes[0].change, "create");
    const kinds = feed.changes.filter((c) => c.change === "create").map((c) => c.recordKind);
    // Kinds appear in blocks, in this order (a kind absent from the sample is skipped).
    const order = ["library", "universe", "series", "book", "template", "field", "entry", "relationshipType", "relationship", "manuscriptNode", "note", "reference", "fact", "question", "event", "stateChange"];
    const ranks = kinds.map((k) => order.indexOf(k));
    assert.ok(ranks.every((r) => r >= 0), JSON.stringify(kinds));
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
    assert.equal(new Set(feed.changes.map((c) => c.opId)).size, feed.changes.length, "a fresh opId per change");
    const docs = feed.changes.filter((c) => c.change === "document");
    assert.equal(docs.length, data.documents.size);
    assert.ok(docs.every((c) => c.recordKind === "document" && c.revision === 1));
    assert.ok(feed.changes.indexOf(docs[0]!) > feed.changes.findLastIndex((c) => c.recordKind === "manuscriptNode"), "documents follow every node");
    // Parents before children.
    const pos = new Map(feed.changes.filter((c) => c.recordKind === "manuscriptNode" && c.change === "create").map((c, i) => [c.recordId, i]));
    for (const c of feed.changes) if (c.recordKind === "manuscriptNode" && c.change === "create" && c.value.parentId) assert.ok(pos.get(c.value.parentId)! < pos.get(c.recordId)!);
    // Replay: no reference error; the records equal the archive's (b).
    assertOneCreateEach(feed.changes, data);
    const replayed = replay(feed.changes, data);
    assert.equal(semantic(replayed, libraryId), semantic(data, libraryId));
    // The import is not a client op: no stored result, no conflict.
    assert.equal((await s.query("SELECT count(*) AS n FROM sync_result"))[0].n, "0");
    assert.equal((await s.query("SELECT count(*) AS n FROM sync_conflict"))[0].n, "0");
    // A document change carries no text of its own in the log; the feed reads it from the revision.
    assert.equal((await s.query("SELECT count(*) AS n FROM sync_change WHERE change = 'document' AND value IS NOT NULL"))[0].n, "0");
    // (c) The export is the imported archive.
    assert.equal(semantic(await s.store.readArchiveData(), libraryId), semantic(data, libraryId));
  } finally { await s.drop(); }
});

test("records trashed in the archive are a create then a tombstone; after replay they are trashed and restore works", async () => {
  const s = await server({ clock: () => T });
  try {
    await doImport(s, await sampleBytes());
    const { data } = await sampleData();
    const trashed = [...(data.library.books as Rec[]), ...(data.library.manuscriptNodes as Rec[]), ...data.notes, ...data.entries, ...data.facts]
      .filter((r) => r.deletedAt !== undefined);
    assert.ok(trashed.length > 0, "the sample holds trashed records");
    const feed = await pullAll(s);
    for (const r of trashed) {
      const own = feed.changes.filter((c) => c.recordId === r.id).map((c) => c.change);
      assert.deepEqual(own.filter((c) => c !== "document"), ["create", "tombstone"], String(r.id));
      assert.equal(feed.changes.find((c) => c.recordId === r.id && c.change === "tombstone").at, r.deletedAt, "the tombstone carries the record's deletedAt");
    }
    const replayed = replay(feed.changes, data);
    const all = [...replayed.library.manuscriptNodes, ...replayed.notes];
    for (const r of trashed.filter((x) => all.some((y) => y.id === x.id))) assert.equal(all.find((y) => y.id === r.id)!.deletedAt, r.deletedAt);
    // Restore works, with a base at head (the replayed client has seen everything).
    const note = trashed.find((r) => data.notes.some((n) => n.id === r.id))!;
    const { epoch, head } = await state(s);
    const out = await push(s, epoch, A, [{ opId: randomUUID(), op: "restore", recordKind: "note", recordId: note.id }]);
    assert.equal(results(out)[0].status, "applied", out.body);
    assert.equal((await s.store.readArchiveData()).notes.find((n) => n.id === note.id)!.deletedAt, undefined);
    // An edit of a trashed record from a client that has the whole baseline (base at head) is RECORD_DELETED: the rules are unchanged.
    const other = trashed.find((r) => data.library.books.some((b: Rec) => b.id === r.id) || data.library.manuscriptNodes.some((n: Rec) => n.id === r.id))!;
    const kind = data.library.books.some((b: Rec) => b.id === other.id) ? "book" : "manuscriptNode";
    const edit = await push(s, epoch, A, [{ opId: randomUUID(), op: "set", recordKind: kind, recordId: other.id, field: "title", baseSeq: Number(head), value: "x" }]);
    assert.equal(results(edit)[0].code, "RECORD_DELETED", edit.body);
  } finally { await s.drop(); }
});

test("an imported library accepts sync edits: a set, a document save on revision 1, and a stale save is a conflict", async () => {
  const s = await server({ clock: () => T });
  try {
    await doImport(s, await sampleBytes());
    const { epoch, head } = await state(s);
    const feed = await pullAll(s);
    const sceneId = feed.changes.find((c) => c.change === "document" && !(feed.changes.find((x) => x.recordId === c.recordId && x.change === "tombstone")))!.recordId as string;
    const doc = (text: string) => ({ schema: "writers-rolltop/document", version: 1, nodeId: sceneId, blocks: [{ id: randomUUID(), type: "paragraph", content: [{ type: "text", text }] }] });
    const docOp = (base: number, text: string) => ({ opId: randomUUID(), op: "document", recordKind: "document", recordId: sceneId, baseRevision: base, value: doc(text) });
    const out = await push(s, epoch, A, [
      { opId: randomUUID(), op: "set", recordKind: "manuscriptNode", recordId: sceneId, field: "title", baseSeq: Number(head), value: "Edited title" },
      docOp(1, "fresh"),
      docOp(1, "stale"),
    ]);
    assert.equal(out.statusCode, 200, out.body);
    assert.deepEqual(results(out).map((r) => r.status), ["applied", "applied", "conflict"], out.body);
    assert.equal(results(out)[1].revision, 2);
    assert.equal(results(out)[1].seq, Number(head) + 2);
    const after = await pullAll(s);
    assert.equal(after.changes.at(-1).seq, Number(head) + 2);
    assert.equal(after.changes.at(-1).value.blocks[0].content[0].text, "fresh");
    assert.equal(after.changes.filter((c) => c.seq > Number(head)).every((c) => c.deviceId === A), true);
  } finally { await s.drop(); }
});

test("import into a database that already has sync changes is refused, and nothing changes", async () => {
  const s = await server({ clock: () => T });
  try {
    const { epoch } = await state(s);
    const universe = { id: randomUUID(), title: "U", orderKey: "m", createdAt: "2026-11-01T09:00:00Z", updatedAt: "2026-11-01T09:00:00Z" };
    await push(s, epoch, A, [{ opId: randomUUID(), op: "create", recordKind: "universe", recordId: universe.id, value: universe }]);
    const imp = await doImport(s, await sampleBytes());
    assert.equal(imp.statusCode, 409);
    assert.equal(imp.json().error.code, "LIBRARY_EXISTS");
    assert.deepEqual(await state(s), { epoch, head: "1" });
    assert.equal((await s.query("SELECT count(*) AS n FROM sync_change"))[0].n, "1");
    // And a second import into an imported library is refused too.
    const s2 = await server({ clock: () => T });
    try {
      assert.equal((await doImport(s2, await sampleBytes())).statusCode, 201);
      const before = await state(s2);
      assert.equal((await doImport(s2, await sampleBytes())).json().error.code, "LIBRARY_EXISTS");
      assert.deepEqual(await state(s2), before);
    } finally { await s2.drop(); }
  } finally { await s.drop(); }
});

const FAIL_FN = `CREATE FUNCTION rt_fail_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.seq = __SEQ__ THEN RAISE EXCEPTION 'injected failure' USING ERRCODE = 'XX001'; END IF; RETURN NEW; END $$`;
const TABLES = ["library", "manuscript_node", "scene_document", "document_revision", "bible_entry", "sync_change", "sync_result", "attachment"];
const countsOf = async (s: Server) => Object.fromEntries(await Promise.all(TABLES.map(async (t) => [t, (await s.query(`SELECT count(*) AS n FROM ${t}`))[0].n])));

test("a failure in the middle of the baseline rolls back the records, the changes and the epoch", async () => {
  const s = await server({ clock: () => T });
  try {
    const before = await state(s);
    // A test-only trigger fails the insert of the 40th change: after records and some baseline changes are written.
    await s.query(FAIL_FN.replace("__SEQ__", "40"));
    await s.query("CREATE TRIGGER rt_fail_at BEFORE INSERT ON sync_change FOR EACH ROW EXECUTE FUNCTION rt_fail_at()");
    await assert.rejects(importArchiveBytes(s.store, await sampleBytes()));
    assert.deepEqual(await state(s), before, "epoch and head are unchanged");
    for (const t of TABLES) assert.equal((await s.query(`SELECT count(*) AS n FROM ${t}`))[0].n, "0", t);
    // With the trigger gone the same import succeeds: nothing of the failed one is in the way.
    await s.query("DROP TRIGGER rt_fail_at ON sync_change");
    await importArchiveBytes(s.store, await sampleBytes());
    assert.notEqual((await state(s)).epoch, before.epoch);
  } finally { await s.drop(); }
});

/** The sample, with `scenes` more scenes (each with a document) in chapters of 20, a tenth of the chapters trashed. */
async function bigArchive(dir: string, scenes: number): Promise<string> {
  const c = await readArchive(SAMPLE);
  try {
    const data = c.data;
    const book = data.library.books[0] as Rec;
    const stamp = "2026-11-01T09:00:00Z";
    const nodes = data.library.manuscriptNodes as Rec[];
    let chapter = "";
    for (let i = 0; i < scenes; i++) {
      if (i % 20 === 0) {
        chapter = randomUUID();
        const trashed = (i / 20) % 10 === 5;
        nodes.push({ id: chapter, bookId: book.id, kind: "chapter", title: `Generated chapter ${i / 20}`, orderKey: `z${String(i / 20).padStart(5, "0")}1`, createdAt: stamp, updatedAt: stamp, ...(trashed ? { deletedAt: "2026-11-05T10:00:00Z" } : {}) });
      }
      const id = randomUUID();
      nodes.push({ id, bookId: book.id, parentId: chapter, kind: "scene", title: `Generated scene ${i}`, orderKey: `m${String(i % 20).padStart(3, "0")}1`, createdAt: stamp, updatedAt: stamp });
      data.documents.set(id, { schema: "writers-rolltop/document", version: 1, nodeId: id,
        blocks: Array.from({ length: 5 }, (_, b) => ({ id: randomUUID(), type: "paragraph", content: [{ type: "text", text: `Scene ${i} paragraph ${b}. `.repeat(20) }] })) });
    }
    const file = path.join(dir, "big.rolltop");
    await writeArchive(data, async (sha) => await c.attachments.get(sha)!.read(), file);
    return file;
  } finally { await c.close(); }
}

test("a generated library of 2000 scenes imports inside the production time limit, replays equal, and trashed chapters stay trashed", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "rolltop-big-"));
  const s = await server({ clock: () => T, timeoutMs: 120_000 });
  try {
    const file = await bigArchive(dir, 2000);
    const bytes = await readFile(file);
    const t0 = performance.now();
    const imp = await doImport(s, bytes);
    const ms = Math.round(performance.now() - t0);
    assert.equal(imp.statusCode, 201, imp.body);
    console.log(`# 2000-scene import through the API: ${ms} ms, ${(await state(s)).head} changes, archive ${bytes.length} bytes`);
    assert.ok(ms < 120_000, "inside the production limit (ROLLTOP_IMPORT_TIMEOUT_MS default 120000)");
    const c = await readArchive(file);
    try {
      const feed = await pullAll(s);
      assertOneCreateEach(feed.changes, c.data);
      assert.equal(semantic(replay(feed.changes, c.data), c.manifest.libraryId as string), semantic(c.data, c.manifest.libraryId as string));
      assert.equal(semantic(await s.store.readArchiveData(), c.manifest.libraryId as string), semantic(c.data, c.manifest.libraryId as string));
    } finally { await c.close(); }
  } finally { await s.drop(); await rm(dir, { recursive: true, force: true }); }
});

test("a failure at change 1500 of a 2000-scene baseline, after three 500-row batches, leaves head, sync_change and the library unchanged", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "rolltop-big-"));
  const s = await server({ clock: () => T, timeoutMs: 120_000 });
  try {
    const bytes = await readFile(await bigArchive(dir, 2000));
    const before = await state(s);
    const rows = await countsOf(s);
    await s.query(FAIL_FN.replace("__SEQ__", "1500"));
    await s.query("CREATE TRIGGER rt_fail_at BEFORE INSERT ON sync_change FOR EACH ROW EXECUTE FUNCTION rt_fail_at()");
    await assert.rejects(importArchiveBytes(s.store, bytes));
    assert.deepEqual(await state(s), before, "epoch and head are unchanged");
    assert.deepEqual(await countsOf(s), rows, "no record, document, change or result of the failed import remains");
    assert.equal((await s.query("SELECT count(*) AS n FROM sync_change"))[0].n, "0");
    assert.equal((await s.query("SELECT count(*) AS n FROM library"))[0].n, "0");
    await s.query("DROP TRIGGER rt_fail_at ON sync_change");
    await importArchiveBytes(s.store, bytes);
    assert.ok(Number((await state(s)).head) > 1500, "the same import succeeds and writes past seq 1500");
  } finally { await s.drop(); await rm(dir, { recursive: true, force: true }); }
});

test("a baseline tombstone's at is the record's deletedAt to the second, in the feed and in the export", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "rolltop-frac-"));
  const s = await server({ clock: () => T });
  try {
    const c = await readArchive(SAMPLE);
    let file: string;
    let noteId: string;
    try {
      const note = c.data.notes.find((n) => n.deletedAt === undefined)!;
      noteId = note.id as string;
      note.deletedAt = "2026-11-05T10:00:00.789Z";
      file = path.join(dir, "frac.rolltop");
      await writeArchive(c.data, async (sha) => await c.attachments.get(sha)!.read(), file);
    } finally { await c.close(); }
    const imp = await doImport(s, await readFile(file));
    assert.equal(imp.statusCode, 201, imp.body);
    const feed = await pullAll(s);
    const tomb = feed.changes.find((x) => x.recordId === noteId && x.change === "tombstone");
    assert.ok(tomb, "the note has a tombstone");
    const stored = (await s.store.readArchiveData()).notes.find((n) => n.id === noteId)!.deletedAt as string;
    assert.equal(stored, "2026-11-05T10:00:00.789Z", "the library keeps the fraction");
    assert.equal(tomb.at, stored.replace(/\.\d+Z$/, "Z"), "the feed's at equals the stored value to the second");
    assert.equal(tomb.at, "2026-11-05T10:00:00Z");
    assert.equal((await s.query(`SELECT to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS a FROM sync_change WHERE record_id = '${noteId}' AND change = 'tombstone'`))[0].a, "2026-11-05T10:00:00.000", "the log stores the second");
  } finally { await s.drop(); await rm(dir, { recursive: true, force: true }); }
});

test("2000-scene import: heap use and time of the import run in this process (the API runs the same code in a worker, capped at 1024 MiB)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "rolltop-heap-"));
  const s = await server({ clock: () => T });
  try {
    const bytes = await readFile(await bigArchive(dir, 2000));
    globalThis.gc?.();
    const before = process.memoryUsage().heapUsed;
    let peak = before;
    const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().heapUsed); }, 10);
    const t0 = performance.now();
    try { await importArchiveBytes(s.store, bytes); } finally { clearInterval(timer); }
    const ms = Math.round(performance.now() - t0);
    peak = Math.max(peak, process.memoryUsage().heapUsed);
    globalThis.gc?.();
    const after = process.memoryUsage().heapUsed;
    const mib = (n: number) => (n / 1024 ** 2).toFixed(1);
    console.log(`# 2000-scene import, in process: ${ms} ms, ${(await state(s)).head} changes, heapUsed before ${mib(before)} MiB, peak sampled ${mib(peak)} MiB, after ${mib(after)} MiB (gc ${globalThis.gc ? "forced" : "not exposed"})`);
    assert.ok(peak - before < 1024 * 1024 ** 2, "the import stays far under the worker's 1024 MiB cap");
  } finally { await s.drop(); await rm(dir, { recursive: true, force: true }); }
});
