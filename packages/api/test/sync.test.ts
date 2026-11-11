// Sync protocol v1 behaviour beyond the scenarios, against the real library tables: records written by sync are the
// records archive export reads and archive import writes; values are validated as archive records; idempotent retries,
// limits, concurrency, partial failure, the epoch rule on import, and the guards every route shares. Scratch databases only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { readArchive, validateArchiveData } from "@writers-rolltop/archive";
import type { ArchiveData } from "@writers-rolltop/archive";
import { loadMigrations, migrate } from "@writers-rolltop/store";
import { scratch, pgDumpPath } from "../../store/test/helpers.ts";
import { buildApp } from "../src/app.ts";
import { archiveFixtures, server } from "./helpers.ts";
import type { Server } from "./helpers.ts";

const T = new Date("2026-11-11T12:00:00Z");
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "2026-11-01T09:00:00Z"; // the createdAt and updatedAt the clients send; never equal to the server's clock
const STAMPS = { createdAt: C, updatedAt: C };
const MISSING = "99999999-9999-4999-8999-999999999999";

const state = async (s: Server) => (await s.query("SELECT epoch, head FROM sync_state"))[0] as { epoch: string; head: string };
const push = (s: Server, epoch: string, deviceId: string, ops: unknown[]) =>
  s.app.inject({ method: "POST", url: "/api/sync/v1/push", payload: { epoch, deviceId, ops } });
const results = (res: { json(): any }) => res.json().results as any[];
const codes = (res: { json(): any }) => results(res).map((r) => r.code ?? r.status);

// ---- valid archive records, and the ops that carry them ----

const lib = (id: string = randomUUID()) => ({ id, title: "Library", ...STAMPS });
const universe = (id: string = randomUUID()) => ({ id, title: "Universe", orderKey: "m", ...STAMPS });
const book = (id: string = randomUUID(), extra: object = {}) => ({ id, title: "Book", orderKey: "m", ...STAMPS, ...extra });
const chapter = (id: string, bookId: string, extra: object = {}) => ({ id, bookId, kind: "chapter", title: "Chapter", orderKey: "m", ...STAMPS, ...extra });
const scene = (id: string, bookId: string, parentId: string, extra: object = {}) => ({ id, bookId, parentId, kind: "scene", title: "Scene", orderKey: "m", ...STAMPS, ...extra });
const docOf = (nodeId: string, text = "Hello") => ({
  schema: "writers-rolltop/document", version: 1, nodeId,
  blocks: [{ id: randomUUID(), type: "paragraph", content: [{ type: "text", text }] }],
});
const textOf = (doc: any): string => doc.blocks[0].content[0].text;
const create = (recordKind: string, value: { id: string; [k: string]: unknown }) => ({ opId: randomUUID(), op: "create", recordKind, recordId: value.id, value });
const set = (recordKind: string, recordId: string, field: string, value: unknown, baseSeq = 0) => ({ opId: randomUUID(), op: "set", recordKind, recordId, field, baseSeq, value });
const unset = (recordKind: string, recordId: string, field: string, baseSeq = 0) => ({ opId: randomUUID(), op: "unset", recordKind, recordId, field, baseSeq });
const tombstone = (recordKind: string, recordId: string, baseSeq = 0) => ({ opId: randomUUID(), op: "tombstone", recordKind, recordId, baseSeq });
const restore = (recordKind: string, recordId: string) => ({ opId: randomUUID(), op: "restore", recordKind, recordId });
const docOp = (nodeId: string, baseRevision: number, text = "Hello") =>
  ({ opId: randomUUID(), op: "document", recordKind: "document", recordId: nodeId, baseRevision, value: docOf(nodeId, text) });

/** A library with one book, a chapter, a scene and the scene's first document, pushed by device A. */
async function seed(s: Server) {
  const { epoch } = await state(s);
  const ids = { lib: randomUUID(), book: randomUUID(), chapter: randomUUID(), scene: randomUUID() };
  const res = await push(s, epoch, A, [
    create("library", lib(ids.lib)), create("book", book(ids.book)), create("manuscriptNode", chapter(ids.chapter, ids.book)),
    create("manuscriptNode", scene(ids.scene, ids.book, ids.chapter)), docOp(ids.scene, 0, "First"),
  ]);
  assert.deepEqual(codes(res), ["applied", "applied", "applied", "applied", "applied"], res.body);
  return { epoch, ...ids };
}

const counts = async (s: Server) =>
  (await s.query(`SELECT (SELECT count(*) FROM sync_change) AS changes, (SELECT count(*) FROM sync_result) AS results,
    (SELECT count(*) FROM sync_conflict) AS conflicts, (SELECT head FROM sync_state) AS head,
    (SELECT count(*) FROM library) + (SELECT count(*) FROM universe) + (SELECT count(*) FROM book) + (SELECT count(*) FROM manuscript_node)
      + (SELECT count(*) FROM scene_document) + (SELECT count(*) FROM bible_entry) AS rows`))[0];

const importSample = (s: Server) => readFile(path.join(archiveFixtures, "valid", "sample-library.rolltop")).then((payload) =>
  s.app.inject({ method: "POST", url: "/api/import", payload, headers: { "content-type": "application/zip" } }));

const normalize = (data: ArchiveData): string => JSON.stringify(data, (_k, v) => (v instanceof Map ? Object.fromEntries([...v].sort()) : v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v));
const byId = (rs: any[], id: string) => rs.find((r) => r.id === id);

/** A full library written only by sync: one record of every kind, with scene, document and trash. Returns what was sent. */
async function writeEverything(s: Server) {
  const { epoch } = await state(s);
  const I = Object.fromEntries(["lib", "uni", "ser", "book", "chap", "scene", "tpl", "fld", "ent", "ent2", "ref", "note", "rtype", "rel", "fact", "q", "ev", "sc"].map((k) => [k, randomUUID()])) as Record<string, string>;
  const scope = { kind: "book", id: I.book };
  const sent: [string, any][] = [
    ["library", lib(I.lib)], ["universe", universe(I.uni)],
    ["series", { id: I.ser, universeId: I.uni, title: "Series", orderKey: "m", ...STAMPS }],
    ["book", book(I.book, { universeId: I.uni, seriesId: I.ser, author: undefined, authorName: "Ada", language: "en" })],
    ["template", { id: I.tpl, name: "Character", entryType: "character", builtIn: false, orderKey: "m", ...STAMPS }],
    ["field", { id: I.fld, templateId: I.tpl, key: "age", label: "Age", fieldType: "integer", required: false, orderKey: "m", ...STAMPS }],
    ["entry", { id: I.ent, entryType: "character", templateId: I.tpl, name: "Ada", aliases: ["A"], scope, values: { [I.fld]: 7 }, overrides: [], attachments: [], ...STAMPS }],
    ["entry", { id: I.ent2, entryType: "character", name: "Ben", aliases: [], scope, values: {}, overrides: [], attachments: [], ...STAMPS }],
    ["manuscriptNode", chapter(I.chap, I.book, { povEntryId: I.ent })],
    ["manuscriptNode", scene(I.scene, I.book, I.chap, { synopsis: "Ada meets Ben" })],
    ["reference", { id: I.ref, nodeId: I.scene, anchorId: randomUUID(), entryId: I.ent, ...STAMPS }],
    ["note", { id: I.note, bookId: I.book, nodeId: I.scene, text: "Remember", orderKey: "m", ...STAMPS }],
    ["relationshipType", { id: I.rtype, label: "Friend", inverseLabel: "Friend", orderKey: "m", ...STAMPS }],
    ["relationship", { id: I.rel, typeId: I.rtype, fromEntryId: I.ent, toEntryId: I.ent2, note: "since school", ...STAMPS }],
    ["fact", { id: I.fact, scope, text: "Ada is seven", truth: "true", entryIds: [I.ent], knowledge: [{ knower: "reader" }], orderKey: "m", ...STAMPS }],
    ["question", { id: I.q, scope, text: "Who is Ben?", status: "open", entryIds: [I.ent2], orderKey: "m", ...STAMPS }],
    ["event", { id: I.ev, scope, title: "They meet", orderKey: "m", sceneIds: [I.scene], participants: [{ entryId: I.ent, role: "host" }], ...STAMPS }],
    ["stateChange", { id: I.sc, eventId: I.ev, entryId: I.ent, fieldId: I.fld, value: 8, ...STAMPS }],
  ];
  for (const [, v] of sent) for (const k of Object.keys(v)) if (v[k] === undefined) delete v[k];
  const ops = [...sent.map(([k, v]) => create(k, v)), docOp(I.scene, 0, "The meeting"), tombstone("note", I.note, 0)];
  const res = await push(s, epoch, A, ops);
  assert.deepEqual(codes(res), ops.map(() => "applied"), res.body);
  return { epoch, I, sent };
}

// ---- tests ----

test("a repeated push returns the same results as duplicates and writes nothing", async () => {
  const s = await server({ clock: () => T });
  try {
    const { epoch } = await state(s);
    const [l, b] = [randomUUID(), randomUUID()];
    const ops = [create("library", lib(l)), create("book", book(b)), set("book", b, "title", "New"),
      restore("book", b), // rejected: not deleted
      { opId: randomUUID(), op: "resolve", conflictId: "nope" }];
    const first = await push(s, epoch, A, ops);
    assert.equal(first.statusCode, 200);
    const before = await counts(s);
    assert.deepEqual(codes(first), ["applied", "applied", "applied", "RECORD_NOT_DELETED", "CONFLICT_UNKNOWN"]);
    const again = await push(s, epoch, A, ops);
    assert.equal(again.statusCode, 200);
    assert.deepEqual(await counts(s), before, "nothing was written by the retry");
    const r = results(again);
    assert.deepEqual(r.map((x) => x.status), ["duplicate", "duplicate", "duplicate", "duplicate", "duplicate"]);
    assert.deepEqual(r.map((x) => x.firstStatus), ["applied", "applied", "applied", "rejected", "rejected"]);
    assert.deepEqual(r.map((x) => x.seq), [1, 2, 3, undefined, undefined]);
    assert.deepEqual(r.map((x) => x.code), [undefined, undefined, undefined, "RECORD_NOT_DELETED", "CONFLICT_UNKNOWN"]);
    // The same opId in a different push, even with other content, is still a duplicate.
    const other = await push(s, epoch, B, [{ ...ops[2], value: "Other" }]);
    assert.equal(results(other)[0].status, "duplicate");
    assert.deepEqual(await counts(s), before);
    assert.equal((await s.query("SELECT title FROM book"))[0].title, "New");
  } finally { await s.drop(); }
});

test("sync keeps no copy of any record: there is no sync_record table, and the library tables hold the state", async () => {
  const s = await server({ clock: () => T });
  try {
    assert.equal((await s.query("SELECT to_regclass('sync_record') AS t"))[0].t, null);
    assert.deepEqual((await s.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'sync\\_%' ORDER BY 1")).map((r) => r.table_name),
      ["sync_change", "sync_conflict", "sync_result", "sync_state"]);
    const x = await seed(s);
    assert.equal((await s.query(`SELECT title FROM book WHERE id = '${x.book}'`))[0].title, "Book");
    assert.equal((await s.query(`SELECT kind, parent_id FROM manuscript_node WHERE id = '${x.scene}'`))[0].parent_id, x.chapter);
    assert.equal((await s.query(`SELECT revision FROM scene_document WHERE node_id = '${x.scene}'`))[0].revision, 1);
    assert.equal((await s.query(`SELECT count(*) AS n FROM document_revision WHERE node_id = '${x.scene}'`))[0].n, "1");
    // A document change holds no text of its own: the pull reads it from document_revision.
    assert.equal((await s.query("SELECT value FROM sync_change WHERE change = 'document'"))[0].value, null);
    const feed = (await s.app.inject({ method: "GET", url: `/api/sync/v1/changes?epoch=${x.epoch}` })).json();
    assert.equal(textOf(feed.changes.find((c: any) => c.change === "document").value), "First");
  } finally { await s.drop(); }
});

test("every record kind is written to its own table, and archive export contains what sync wrote", async () => {
  const s = await server({ clock: () => T });
  try {
    const { I, sent } = await writeEverything(s);
    assert.equal(new Set(sent.map(([k]) => k)).size, 16, "all sixteen kinds");
    // The tables, not a copy.
    for (const [table, id] of [["library", I.lib], ["universe", I.uni], ["series", I.ser], ["book", I.book], ["manuscript_node", I.scene], ["entry_template", I.tpl],
      ["entry_field", I.fld], ["bible_entry", I.ent], ["manuscript_reference", I.ref], ["note", I.note], ["relationship_type", I.rtype],
      ["relationship", I.rel], ["fact", I.fact], ["question", I.q], ["continuity_event", I.ev], ["state_change", I.sc]] as const) {
      assert.equal((await s.query(`SELECT count(*) AS n FROM ${table} WHERE id = '${id}'`))[0].n, "1", table);
    }
    assert.equal((await s.query(`SELECT value_json FROM entry_value WHERE entry_id = '${I.ent}'`))[0].value_json, 7);
    // In-process snapshot: valid, and every record equals what was sent (the note with its tombstone).
    const data = await s.store.readArchiveData();
    const report = validateArchiveData(data);
    assert.deepEqual(report.errors, []);
    const all: any[] = [data.library.library, ...data.library.universes, ...data.library.series, ...data.library.books, ...data.library.manuscriptNodes, ...data.templates,
      ...data.fields, ...data.entries, ...data.references, ...data.notes, ...data.relationships.relationshipTypes, ...data.relationships.relationships,
      ...data.facts, ...data.questions, ...data.events, ...data.stateChanges];
    assert.equal(all.length, sent.length);
    for (const [kind, value] of sent) {
      const got = byId(all, value.id);
      const want = kind === "note" ? { ...value, updatedAt: "2026-11-11T12:00:00Z", deletedAt: "2026-11-11T12:00:00Z" } : value;
      assert.deepEqual(JSON.parse(normalize({ ...got } as any)), JSON.parse(normalize({ ...want } as any)), `${kind} ${value.id}`);
    }
    assert.equal(textOf(data.documents.get(I.scene!)), "The meeting");
    // The real export, over HTTP, read back and validated by the archive reader (schema, integrity, checksums).
    const res = await s.app.inject({ method: "GET", url: "/api/export" });
    assert.equal(res.statusCode, 200, res.body);
    const contents = await readArchive(res.rawPayload);
    try {
      assert.equal(contents.summary.libraryId, I.lib);
      assert.equal(contents.summary.manuscriptNodes, 2);
      assert.equal(contents.summary.documents, 1);
      assert.equal(contents.summary.entries, 2);
      assert.equal(normalize(contents.data), normalize(data));
    } finally { await contents.close(); }
  } finally { await s.drop(); }
});

test("a scene still waiting for its document makes the export refuse, and the document lets it through", async () => {
  const s = await server({ clock: () => T });
  try {
    const { epoch } = await state(s);
    const [l, b, c, sc] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await push(s, epoch, A, [create("library", lib(l)), create("book", book(b)), create("manuscriptNode", chapter(c, b)), create("manuscriptNode", scene(sc, b, c))]);
    // Sync allows the node before its text (the client creates first); the archive needs the document, so the export waits.
    assert.equal((await s.app.inject({ method: "GET", url: "/api/export" })).statusCode, 500);
    assert.ok(s.logs.some((e) => e.code === "INTEGRITY_VIOLATION" || e.message === "INTEGRITY_VIOLATION"), JSON.stringify(s.logs));
    await push(s, epoch, A, [docOp(sc, 0)]);
    assert.equal((await s.app.inject({ method: "GET", url: "/api/export" })).statusCode, 200);
  } finally { await s.drop(); }
});

test("round trip: an archive that holds sync-written records imports into a new library, and sync sees the same records", async () => {
  const s1 = await server({ clock: () => T });
  const s2 = await server({ clock: () => T });
  try {
    const { I, sent } = await writeEverything(s1);
    const exported = await s1.app.inject({ method: "GET", url: "/api/export" });
    assert.equal(exported.statusCode, 200);
    const imp = await s2.app.inject({ method: "POST", url: "/api/import", payload: exported.rawPayload, headers: { "content-type": "application/zip" } });
    assert.equal(imp.statusCode, 201, imp.body);
    // The imported library is the same library, record for record.
    assert.equal(normalize(await s2.store.readArchiveData()), normalize(await s1.store.readArchiveData()));
    // A new epoch for the new library; nothing of the old epoch; and no snapshot of the imported records in the feed (see the report).
    const e1 = await state(s1), e2 = await state(s2);
    assert.notEqual(e2.epoch, e1.epoch);
    assert.equal(e2.head, "0");
    const pull = (await s2.app.inject({ method: "GET", url: `/api/sync/v1/changes?epoch=${e2.epoch}` })).json();
    assert.deepEqual([pull.head, pull.changes, pull.next], [0, [], 0]);
    // The note was trashed by sync on s1 and arrives trashed on s2, with no tombstone change in the new epoch (seq 0): no base is
    // older than it, so an edit is RECORD_DELETED and never the restore branch.
    assert.ok((await s2.store.readArchiveData()).notes.find((n: any) => n.id === I.note)!.deletedAt);
    const e = await state(s2);
    assert.equal(codes(await push(s2, e.epoch, B, [set("note", I.note!, "text", "edit", 0)]))[0], "RECORD_DELETED");
    // Sync sees every record on both servers: create says RECORD_EXISTS, restore finds the live record (the library has no trash).
    for (const s of [s1, s2]) {
      const { epoch } = await state(s);
      const ops = sent.flatMap(([k, v]) => [create(k, v), restore(k, v.id)]);
      const out = await push(s, epoch, B, ops);
      const expectRestore = (k: string, id: string) => (k === "library" ? "OP_UNSUPPORTED" : k === "note" && id === I.note ? "applied" : "RECORD_NOT_DELETED");
      assert.deepEqual(codes(out), sent.flatMap(([k, v]) => ["RECORD_EXISTS", expectRestore(k, v.id)]));
    }
  } finally { await s1.drop(); await s2.drop(); }
});

test("an imported library is visible to sync: edits, trash and documents work against the imported rows", async () => {
  const s = await server({ clock: () => T });
  try {
    const imp = await importSample(s);
    assert.equal(imp.statusCode, 201, imp.body);
    const { epoch, head } = await state(s);
    assert.equal(head, "0");
    const scene = (await s.query("SELECT id, title FROM manuscript_node WHERE kind = 'scene' ORDER BY id LIMIT 1"))[0];
    const revision = (await s.query(`SELECT revision FROM scene_document WHERE node_id = '${scene.id}'`))[0].revision;
    assert.equal(revision, 1, "an imported document is revision 1");
    const bookId = (await s.query("SELECT id FROM book ORDER BY id LIMIT 1"))[0].id;
    const note = randomUUID();
    const out = await push(s, epoch, A, [
      set("manuscriptNode", scene.id, "title", "Renamed"), // base 0: nothing newer exists
      docOp(scene.id, 0, "stale"), // the imported text is revision 1: a base of 0 is stale, kept as a conflict
      docOp(scene.id, 1, "fresh"),
      create("note", { id: note, bookId, nodeId: scene.id, text: "New", orderKey: "m", ...STAMPS }),
    ]);
    assert.equal(out.statusCode, 200, out.body + JSON.stringify(s.logs));
    assert.deepEqual(results(out).map((r) => r.status), ["applied", "conflict", "applied", "applied"], out.body);
    assert.equal(results(out)[2].revision, 2);
    assert.equal((await s.query(`SELECT title FROM manuscript_node WHERE id = '${scene.id}'`))[0].title, "Renamed");
    assert.equal((await s.query(`SELECT revision, document->'blocks'->0->'content'->0->>'text' AS t FROM scene_document WHERE node_id = '${scene.id}'`))[0].t, "fresh");
    assert.equal((await s.query(`SELECT count(*) AS n FROM document_revision WHERE node_id = '${scene.id}'`))[0].n, "2", "the imported text is kept as revision 1");
    // A base past the imported revision is a different history.
    const past = await push(s, epoch, A, [docOp(scene.id, 5)]);
    assert.equal(past.statusCode, 409);
    // The export holds the imported records and the sync edits together, and validates.
    const data = await s.store.readArchiveData();
    assert.deepEqual(validateArchiveData(data).errors, []);
    assert.equal(byId(data.library.manuscriptNodes, scene.id).title, "Renamed");
    assert.ok(byId(data.notes, note));
    // Trash an imported node: the tombstone is deleted_at on its own row, and the export carries it.
    const t = await push(s, epoch, A, [tombstone("manuscriptNode", scene.id, 0)]);
    assert.equal(results(t)[0].status, "applied");
    assert.equal((await s.query(`SELECT deleted_at IS NOT NULL AS d FROM manuscript_node WHERE id = '${scene.id}'`))[0].d, true);
    assert.ok(byId((await s.store.readArchiveData()).library.manuscriptNodes, scene.id).deletedAt);
  } finally { await s.drop(); }
});

test("an archive import starts a new epoch, and is refused when sync has written to the database", async () => {
  const s = await server({ clock: () => T });
  try {
    const before = (await state(s)).epoch;
    const rejected = await push(s, before, A, [restore("note", randomUUID())]);
    assert.equal(results(rejected)[0].status, "rejected");
    const imp = await importSample(s);
    assert.equal(imp.statusCode, 201, imp.body);
    const after = await state(s);
    assert.notEqual(after.epoch, before);
    assert.equal(after.head, "0");
    assert.equal((await counts(s)).results, "0", "no result of the old epoch survives");
    const stale = await push(s, before, A, [create("universe", universe())]);
    assert.equal(stale.statusCode, 409);
    assert.deepEqual(stale.json(), { error: { code: "RESYNC_REQUIRED", message: stale.json().error.message }, epoch: after.epoch, head: 0 });
  } finally { await s.drop(); }
  // A library that sync created is a library: the import is refused and changes nothing.
  const s2 = await server({ clock: () => T });
  try {
    const x = await seed(s2);
    const imp = await importSample(s2);
    assert.equal(imp.statusCode, 409);
    assert.equal(imp.json().error.code, "LIBRARY_EXISTS");
    const st = await state(s2);
    assert.equal(st.epoch, x.epoch);
    assert.equal(st.head, "5");
    assert.equal((await s2.query("SELECT count(*) AS n FROM library"))[0].n, "1");
    assert.equal((await s2.query("SELECT title FROM library"))[0].title, "Library", "the sync library is untouched");
  } finally { await s2.drop(); }
  // Sync records with no library record yet are library content too: nothing is merged into them.
  const s3 = await server({ clock: () => T });
  try {
    const { epoch } = await state(s3);
    const u = universe();
    await push(s3, epoch, A, [create("universe", u)]);
    const imp = await importSample(s3);
    assert.equal(imp.statusCode, 409);
    assert.equal(imp.json().error.code, "LIBRARY_EXISTS");
    assert.equal((await state(s3)).epoch, epoch);
    assert.equal((await s3.query("SELECT count(*) AS n FROM library"))[0].n, "0", "the refused import left no library");
    assert.equal((await s3.query("SELECT count(*) AS n FROM universe"))[0].n, "1");
  } finally { await s3.drop(); }
});

test("create values are validated as archive records: INVALID_VALUE, REFERENCE_UNRESOLVED, INTEGRITY_VIOLATION, and nothing is stored", async () => {
  const s = await server({ clock: () => T });
  try {
    const x = await seed(s);
    const before = await counts(s);
    const n = () => randomUUID();
    const bad: [string, any][] = [
      // INVALID_VALUE: shape and typing
      ["INVALID_VALUE", create("manuscriptNode", { id: n(), kind: "chapter", title: "No book", orderKey: "m", ...STAMPS })],
      ["INVALID_VALUE", create("manuscriptNode", chapter(n(), x.book, { title: 5 }))],
      ["INVALID_VALUE", create("manuscriptNode", chapter(n(), x.book, { kind: "volume" }))],
      ["INVALID_VALUE", create("manuscriptNode", chapter(n(), x.book, { orderKey: "A!" }))],
      ["INVALID_VALUE", create("manuscriptNode", chapter(n(), x.book, { createdAt: "yesterday" }))],
      ["INVALID_VALUE", create("manuscriptNode", chapter(n(), x.book, { title: "a\u0000b" }))],
      ["INVALID_VALUE", create("fact", { id: n(), scope: { kind: "book", id: x.book, junk: true }, text: "t", truth: "true", entryIds: [], knowledge: [], orderKey: "m", ...STAMPS })],
      ["INVALID_VALUE", { ...create("universe", universe()), value: { id: n(), title: "id is not the recordId", orderKey: "m", ...STAMPS } }],
      ["INVALID_VALUE", create("universe", { ...universe(), deletedAt: C })], // a record starts live
      ["INVALID_VALUE", create("universe", { ...universe(), title: undefined })],
      // REFERENCE_UNRESOLVED
      ["REFERENCE_UNRESOLVED", create("manuscriptNode", chapter(n(), MISSING))],
      ["REFERENCE_UNRESOLVED", create("manuscriptNode", scene(n(), x.book, MISSING))],
      ["REFERENCE_UNRESOLVED", create("series", { id: n(), universeId: MISSING, title: "S", orderKey: "m", ...STAMPS })],
      ["REFERENCE_UNRESOLVED", create("note", { id: n(), bookId: MISSING, text: "t", orderKey: "m", ...STAMPS })],
      // Several problems at once: unresolved wins over integrity (here the node also sits in "another book" than its parent).
      ["REFERENCE_UNRESOLVED", create("relationship", { id: n(), typeId: MISSING, fromEntryId: MISSING, toEntryId: MISSING, ...STAMPS })],
      // INTEGRITY_VIOLATION: hierarchy, one library
      ["INTEGRITY_VIOLATION", create("manuscriptNode", { id: n(), bookId: x.book, kind: "scene", title: "At root", orderKey: "m", ...STAMPS })],
      ["INTEGRITY_VIOLATION", create("manuscriptNode", chapter(n(), x.book, { parentId: x.scene }))],
      ["INTEGRITY_VIOLATION", create("library", lib())], // a library database holds one library
    ];
    const res = await push(s, x.epoch, A, bad.map(([, op]) => op));
    assert.deepEqual(codes(res), bad.map(([code]) => code), res.body);
    const after = await counts(s);
    assert.deepEqual({ ...after, results: undefined }, { ...before, results: undefined }, "nothing stored for a rejected op");
    assert.equal(Number(after.results), Number(before.results) + bad.length, "but each answer is kept, permanently");
    // A rejection is permanent for its opId, even when the cause goes away.
    const again = await push(s, x.epoch, A, [bad[0]![1]]);
    assert.equal(results(again)[0].status, "duplicate");
    assert.equal(results(again)[0].code, "INVALID_VALUE");
  } finally { await s.drop(); }
});

test("kinds with rules of their own: duplicate field key, document on a chapter, entry values, state changes, trashed targets", async () => {
  const s = await server({ clock: () => T });
  try {
    const x = await seed(s);
    const [tpl, f1, f2, ent, ev] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const field = (id: string, key: string) => ({ id, templateId: tpl, key, label: key, fieldType: "integer", required: false, orderKey: "m", ...STAMPS });
    const scope = { kind: "book", id: x.book };
    const out = await push(s, x.epoch, A, [
      create("template", { id: tpl, name: "T", entryType: "character", builtIn: false, orderKey: "m", ...STAMPS }),
      create("field", field(f1, "age")),
      create("field", field(f2, "age")), // same key in the template
      create("field", field(f2, "Bad Key")), // a key must match ^[a-z][a-zA-Z0-9_]{0,63}$
      create("entry", { id: ent, entryType: "character", templateId: tpl, name: "E", aliases: [], scope, values: { [f1]: "seven" }, overrides: [], attachments: [], ...STAMPS }), // typing
      create("entry", { id: ent, entryType: "location", templateId: tpl, name: "E", aliases: [], scope, values: {}, overrides: [], attachments: [], ...STAMPS }), // template is for characters
      create("entry", { id: ent, entryType: "character", name: "E", aliases: [], scope, values: { [f1]: 7 }, overrides: [], attachments: [], ...STAMPS }), // no template, so no values
      create("entry", { id: ent, entryType: "character", templateId: tpl, name: "E", aliases: [], scope, values: { [f1]: 7 }, overrides: [], attachments: [], ...STAMPS }),
      create("event", { id: ev, scope, title: "Ev", orderKey: "m", sceneIds: [x.chapter], participants: [], ...STAMPS }), // an event's scenes must be scenes
      docOp(x.chapter, 0), // a chapter has no document
    ]);
    assert.deepEqual(codes(out), ["applied", "applied", "INTEGRITY_VIOLATION", "INVALID_VALUE", "INTEGRITY_VIOLATION", "INTEGRITY_VIOLATION", "INTEGRITY_VIOLATION", "applied", "INTEGRITY_VIOLATION", "INTEGRITY_VIOLATION"], out.body);
    assert.equal((await s.query("SELECT count(*) AS n FROM entry_field"))[0].n, "1");
    // A trashed target still resolves.
    const trash = await push(s, x.epoch, A, [tombstone("manuscriptNode", x.scene, 0)]);
    assert.equal(results(trash)[0].status, "applied");
    const ref = await push(s, x.epoch, A, [create("event", { id: ev, scope, title: "Ev", orderKey: "m", sceneIds: [x.scene], participants: [], ...STAMPS })]);
    assert.equal(results(ref)[0].status, "applied");
  } finally { await s.drop(); }
});

test("set and unset: the record the op leaves behind must be valid; values/ and overrides/ fields; unknown properties are kept", async () => {
  const s = await server({ clock: () => T });
  try {
    const x = await seed(s);
    const head = async () => Number((await state(s)).head);
    const [uni, tpl, fld, ent, b2] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const setup = await push(s, x.epoch, A, [
      create("universe", universe(uni)),
      create("book", book(b2, { universeId: uni })),
      create("template", { id: tpl, name: "T", entryType: "character", builtIn: false, orderKey: "m", ...STAMPS }),
      create("field", { id: fld, templateId: tpl, key: "age", label: "Age", fieldType: "integer", required: false, orderKey: "m", ...STAMPS }),
      create("entry", { id: ent, entryType: "character", templateId: tpl, name: "E", aliases: [], scope: { kind: "universe", id: uni }, values: {}, overrides: [], attachments: [], ...STAMPS }),
    ]);
    assert.deepEqual(codes(setup), ["applied", "applied", "applied", "applied", "applied"], setup.body);
    const h = await head();
    const ops = [
      set("manuscriptNode", x.chapter, "title", 5, h), // INVALID_VALUE: wrong type
      set("manuscriptNode", x.chapter, "kind", "volume", h), // INVALID_VALUE: not a kind
      unset("manuscriptNode", x.chapter, "title", h), // INVALID_VALUE: a required field cannot be unset
      set("manuscriptNode", x.scene, "parentId", MISSING, h), // REFERENCE_UNRESOLVED
      set("manuscriptNode", x.scene, "kind", "chapter", h), // INTEGRITY_VIOLATION: a chapter does not sit under a chapter
      set("manuscriptNode", x.chapter, "id", MISSING, h), // FIELD_UNKNOWN: reserved
      set("manuscriptNode", x.chapter, "updatedAt", C, h), // FIELD_UNKNOWN
      unset("manuscriptNode", x.chapter, "deletedAt", h), // FIELD_UNKNOWN
      set("manuscriptNode", x.chapter, "values/" + fld, 1, h), // FIELD_UNKNOWN: only entries have values
      set("note", randomUUID(), "text", "x", h), // RECORD_UNKNOWN
      set("manuscriptNode", x.chapter, "synopsis", "A summary", h), // applied
      unset("manuscriptNode", x.chapter, "synopsis", h), // applied: optional
      set("manuscriptNode", x.chapter, "futureThing", { a: [1, 2] }, h), // an open record keeps what it does not know
      set("entry", ent, "values/" + fld, 7, h), // applied
      set("entry", ent, "values/" + fld, "seven", h), // INTEGRITY_VIOLATION: field typing
      set("entry", ent, "overrides/" + b2, { bookId: b2, values: { [fld]: 9 } }, h), // applied: the book is in the entry's universe
      set("entry", ent, "overrides/" + x.book, { bookId: x.book, values: {} }, h), // INTEGRITY_VIOLATION: a book outside the scope
      set("entry", ent, "overrides/" + b2, { bookId: x.book, values: {} }, h), // INVALID_VALUE: the override names another book
      set("book", b2, "targetWordCount", 9007199254740991, h), // the schema allows it, the integer column cannot hold it: INVALID_VALUE, not a failure
      set("book", b2, "createdAt", C, h),
    ];
    const out = await push(s, x.epoch, B, ops);
    assert.deepEqual(codes(out), ["INVALID_VALUE", "INVALID_VALUE", "INVALID_VALUE", "REFERENCE_UNRESOLVED", "INTEGRITY_VIOLATION", "FIELD_UNKNOWN", "FIELD_UNKNOWN", "FIELD_UNKNOWN",
      "FIELD_UNKNOWN", "RECORD_UNKNOWN", "applied", "applied", "applied", "applied", "INTEGRITY_VIOLATION", "applied", "INTEGRITY_VIOLATION", "INVALID_VALUE", "INVALID_VALUE", "FIELD_UNKNOWN"], out.body);
    const row = (await s.query(`SELECT title, synopsis, extra_json FROM manuscript_node WHERE id = '${x.chapter}'`))[0];
    assert.deepEqual([row.title, row.synopsis, row.extra_json], ["Chapter", null, { futureThing: { a: [1, 2] } }]);
    assert.equal((await s.query(`SELECT value_json FROM entry_value WHERE entry_id = '${ent}'`))[0].value_json, 7);
    assert.equal((await s.query(`SELECT value_json FROM entry_override_value WHERE entry_id = '${ent}'`))[0].value_json, 9);
    assert.equal((await s.query(`SELECT count(*) AS n FROM entry_override WHERE entry_id = '${ent}'`))[0].n, "1");
    // The open property comes back out in the export and is valid there; unsetting removes it and the override.
    const data = await s.store.readArchiveData();
    assert.deepEqual(validateArchiveData(data).errors, []);
    assert.deepEqual(byId(data.library.manuscriptNodes, x.chapter).futureThing, { a: [1, 2] });
    const h2 = await head();
    const un = await push(s, x.epoch, B, [unset("manuscriptNode", x.chapter, "futureThing", h2), unset("entry", ent, "overrides/" + b2, h2), unset("entry", ent, "values/" + fld, h2)]);
    assert.deepEqual(codes(un), ["applied", "applied", "applied"]);
    assert.equal((await s.query(`SELECT extra_json FROM manuscript_node WHERE id = '${x.chapter}'`))[0].extra_json, null);
    assert.equal((await s.query(`SELECT count(*) AS n FROM entry_override WHERE entry_id = '${ent}'`))[0].n, "0");
    assert.equal((await s.query(`SELECT count(*) AS n FROM entry_value WHERE entry_id = '${ent}'`))[0].n, "0");
    // The rejected ops changed nothing: the rejected title is still the original, the log holds only the applied ops.
    assert.equal((await s.query(`SELECT count(*) AS n FROM sync_change WHERE seq > ${h}`))[0].n, String(Number((await state(s)).head) - h));
  } finally { await s.drop(); }
});

test("createdAt and updatedAt: kept as sent on create, and the server sets updatedAt itself on every later change", async () => {
  let now = new Date("2026-11-12T08:30:00.500Z");
  const s = await server({ clock: () => now });
  try {
    const x = await seed(s);
    const node = async () => (await s.store.readArchiveData()).library.manuscriptNodes.find((n: any) => n.id === x.chapter);
    assert.deepEqual([(await node()).createdAt, (await node()).updatedAt], [C, C], "as the client sent them");
    now = new Date("2026-11-12T09:00:00Z");
    const h = Number((await state(s)).head);
    await push(s, x.epoch, A, [set("manuscriptNode", x.chapter, "title", "Later", h)]);
    assert.deepEqual([(await node()).createdAt, (await node()).updatedAt], [C, "2026-11-12T09:00:00Z"]);
    now = new Date("2026-11-12T10:00:00.25Z");
    await push(s, x.epoch, A, [tombstone("manuscriptNode", x.chapter, h + 1)]);
    const n = await node();
    assert.deepEqual([n.updatedAt, n.deletedAt], ["2026-11-12T10:00:00.25Z", "2026-11-12T10:00:00.25Z"]);
    now = new Date("2026-11-12T11:00:00Z");
    await push(s, x.epoch, A, [restore("manuscriptNode", x.chapter)]);
    const r = await node();
    assert.deepEqual([r.updatedAt, r.deletedAt], ["2026-11-12T11:00:00Z", undefined]);
    // A document save does not touch the node record.
    await push(s, x.epoch, A, [docOp(x.scene, 1, "Two")]);
    assert.equal((await s.store.readArchiveData()).library.manuscriptNodes.find((m: any) => m.id === x.scene)!.updatedAt, C);
  } finally { await s.drop(); }
});

test("tombstone and restore write deletedAt on the record's own row; a trashed parent hides its scene's document, and the save is kept", async () => {
  const s = await server({ clock: () => T });
  try {
    const x = await seed(s);
    const head = async () => Number((await state(s)).head);
    const t = await push(s, x.epoch, B, [tombstone("manuscriptNode", x.chapter, await head())]);
    const tombSeq = results(t)[0].seq;
    assert.equal(results(t)[0].status, "applied");
    assert.equal((await s.query(`SELECT deleted_at IS NOT NULL AS d FROM manuscript_node WHERE id = '${x.chapter}'`))[0].d, true);
    assert.equal((await s.query(`SELECT deleted_at IS NOT NULL AS d FROM manuscript_node WHERE id = '${x.scene}'`))[0].d, false, "the scene itself is not marked");
    // The store hides the scene's document (ancestry), and sync keeps a save instead of writing it.
    await assert.rejects(s.store.readDocument(x.scene), /NOT_FOUND/);
    const save = await push(s, x.epoch, A, [docOp(x.scene, 1, "Saved while hidden")]);
    assert.equal(results(save)[0].status, "conflict");
    assert.deepEqual(results(save)[0].current, { seq: tombSeq, revision: 1 });
    const open = (await s.app.inject({ method: "GET", url: `/api/sync/v1/conflicts?epoch=${x.epoch}` })).json().conflicts;
    assert.equal(open.length, 1);
    assert.equal(open[0].kind, "document");
    assert.equal(textOf(open[0].losing.value), "Saved while hidden", "the full value");
    assert.equal(textOf((await s.store.readArchiveData()).documents.get(x.scene)), "First", "nothing was overwritten");
    // The trash is exported like any trashed record.
    const exported = (await s.store.readArchiveData()).library.manuscriptNodes.find((n: any) => n.id === x.chapter);
    assert.equal(exported.deletedAt, "2026-11-11T12:00:00Z");
    // Restore: the scene is readable again and saves again.
    assert.equal(results(await push(s, x.epoch, A, [restore("manuscriptNode", x.chapter)]))[0].status, "applied");
    assert.equal(textOf((await s.store.readDocument(x.scene)).document), "First");
    const again = await push(s, x.epoch, A, [docOp(x.scene, 1, "Second")]);
    assert.equal(results(again)[0].revision, 2);
    // The library record cannot be trashed.
    assert.equal(codes(await push(s, x.epoch, A, [tombstone("library", x.lib, await head()), restore("library", x.lib)]))[0], "OP_UNSUPPORTED");
  } finally { await s.drop(); }
});

test("request-level errors use the envelope, with short generic messages", async () => {
  const s = await server({ clock: () => T });
  try {
    const { epoch } = await state(s);
    const post = (payload: string | Buffer, type = "application/json") => s.app.inject({ method: "POST", url: "/api/sync/v1/push", payload, headers: { "content-type": type } });
    const bad = async (res: Awaited<ReturnType<typeof post>>, status: number, code: string) => {
      assert.equal(res.statusCode, status, res.body);
      const b = res.json();
      assert.equal(b.error.code, code);
      assert.ok(b.error.message.length <= 200);
      assert.deepEqual(Object.keys(b), ["error"]);
      assert.doesNotMatch(res.body, /\bat\s.*\.(ts|js):\d+|node_modules|\/Users\//);
    };
    await bad(await post("{not json"), 400, "INVALID_REQUEST");
    await bad(await post(""), 400, "INVALID_REQUEST");
    await bad(await post('{"__proto__": {}}'), 400, "INVALID_REQUEST");
    await bad(await post("[]"), 400, "INVALID_REQUEST");
    await bad(await post("{}", "application/xml"), 415, "UNSUPPORTED_MEDIA_TYPE");
    const secret = await post(JSON.stringify({ epoch: "SECRET-RAW-INPUT", deviceId: A, ops: [] }));
    await bad(secret, 400, "INVALID_REQUEST");
    assert.doesNotMatch(secret.body, /SECRET/);
    // Over 16 MiB.
    await bad(await post(Buffer.alloc(16 * 1024 ** 2 + 1, 0x20)), 413, "PAYLOAD_TOO_LARGE");
    // A document over 8 MiB: refused whole, nothing applied (the create before it is not applied either).
    const id = randomUUID();
    const big = docOf(id, "x".repeat(8 * 1024 ** 2 + 1));
    await bad(await push(s, epoch, A, [create("library", lib()), { opId: randomUUID(), op: "document", recordKind: "document", recordId: id, baseRevision: 0, value: big }]), 413, "PAYLOAD_TOO_LARGE");
    assert.equal((await counts(s)).changes, "0");
    // GET parameters.
    for (const q of [`epoch=${epoch}&after=01`, `epoch=${epoch}&after=-1`, `epoch=${epoch}&after=1.5`, `epoch=${epoch}&after=`, `epoch=${epoch}&limit=0`, `epoch=${epoch}&limit=1001`, `epoch=${epoch}&limit=abc`, "after=0", "epoch=nope"]) {
      await bad(await s.app.inject({ method: "GET", url: `/api/sync/v1/changes?${q}` }), 400, "INVALID_REQUEST");
    }
    await bad(await s.app.inject({ method: "GET", url: "/api/sync/v1/conflicts" }), 400, "INVALID_REQUEST");
    const past = await s.app.inject({ method: "GET", url: `/api/sync/v1/changes?epoch=${epoch}&after=1` });
    assert.equal(past.statusCode, 409);
    assert.equal(past.json().head, 0);
    const wrong = await s.app.inject({ method: "GET", url: `/api/sync/v1/conflicts?epoch=${randomUUID()}` });
    assert.equal(wrong.statusCode, 409);
    assert.equal(wrong.json().epoch, epoch);
    await bad(await s.app.inject({ method: "GET", url: "/api/sync/v1/nothing" }), 404, "NOT_FOUND");
    await bad(await s.app.inject({ method: "GET", url: "/api/sync/v1/push" }), 404, "NOT_FOUND");
    // 1000 is allowed.
    assert.equal((await s.app.inject({ method: "GET", url: `/api/sync/v1/changes?epoch=${epoch}&limit=1000` })).statusCode, 200);
  } finally { await s.drop(); }
});

test("values the database cannot hold are rejected per op, and never reach a record or the log", async () => {
  const s = await server({ clock: () => T });
  try {
    const x = await seed(s);
    const h = Number((await state(s)).head);
    const raw = (ops: string) => s.app.inject({ method: "POST", url: "/api/sync/v1/push", headers: { "content-type": "application/json" }, payload: `{"epoch":"${x.epoch}","deviceId":"${A}","ops":${ops}}` });
    const res = await push(s, x.epoch, A, [
      set("manuscriptNode", x.chapter, "title", "a\u0000b", h),
      set("manuscriptNode", x.chapter, "title", "x", h),
      docOp(x.scene, 1, "a\u0000b"),
      set("manuscriptNode", x.chapter, "synopsis", JSON.parse("[".repeat(80) + "]".repeat(80)), h),
      create("book", book(randomUUID(), { targetWordCount: 9007199254740991 })), // valid archive value, too big for the column
      create("book", book(randomUUID(), { createdAt: "2026-13-45T25:61:61Z" })), // matches the pattern, is not a date
      docOp(x.scene, 1, "fine"),
    ]);
    assert.deepEqual(codes(res), ["INVALID_VALUE", "applied", "DOCUMENT_INVALID", "INVALID_VALUE", "INVALID_VALUE", "INVALID_VALUE", "applied"], res.body);
    // A lone surrogate arrives as the JSON escape \ud800.
    const lone = await raw(`[{"opId":"${randomUUID()}","op":"set","recordKind":"manuscriptNode","recordId":"${x.chapter}","field":"synopsis","baseSeq":${h},"value":"\\ud800"}]`);
    assert.equal(results(lone)[0].code, "INVALID_VALUE");
    assert.equal((await s.query(`SELECT title, synopsis FROM manuscript_node WHERE id = '${x.chapter}'`))[0].title, "x");
    assert.equal((await s.query("SELECT count(*) AS n FROM book"))[0].n, "1", "the two rejected books are not stored");
    assert.equal((await counts(s)).conflicts, "0");
  } finally { await s.drop(); }
});

test("parallel pushes get gapless unique seqs; parallel saves of one base: one applies, the rest are kept", async () => {
  const s = await server({ clock: () => T });
  try {
    const x = await seed(s);
    const base = Number((await state(s)).head);
    const res = await Promise.all(Array.from({ length: 24 }, (_, i) => push(s, x.epoch, i % 2 ? A : B, [create("universe", universe()), create("universe", universe())])));
    const seqs = res.flatMap((r) => results(r).map((o) => o.seq)).sort((a: number, b: number) => a - b);
    assert.deepEqual(seqs, Array.from({ length: 48 }, (_, i) => base + 1 + i));
    assert.equal(Number((await state(s)).head), base + 48);
    const saves = await Promise.all(["one", "two", "three", "four"].map((t, i) => push(s, x.epoch, i % 2 ? A : B, [docOp(x.scene, 1, t)])));
    assert.deepEqual(saves.map((r) => results(r)[0].status).sort(), ["applied", "conflict", "conflict", "conflict"]);
    const open = (await s.app.inject({ method: "GET", url: `/api/sync/v1/conflicts?epoch=${x.epoch}` })).json().conflicts;
    assert.equal(open.length, 3);
    const stored = (await s.query(`SELECT document FROM document_revision WHERE node_id = '${x.scene}' AND revision = 2`))[0].document;
    const kept = [textOf(stored), ...open.map((c: any) => textOf(c.losing.value))].sort();
    assert.deepEqual(kept, ["four", "one", "three", "two"], "every saved text is held: one as the revision, the rest as conflicts");
    assert.equal((await s.query(`SELECT revision FROM scene_document WHERE node_id = '${x.scene}'`))[0].revision, 2);
  } finally { await s.drop(); }
});

test("the log is append-only and document revisions keep every text", async () => {
  const s = await server({ clock: () => T });
  try {
    const x = await seed(s);
    for (const [rev, t] of [[1, "two"], [2, "three"]] as const) assert.equal(results(await push(s, x.epoch, A, [docOp(x.scene, rev, t)]))[0].revision, rev + 1);
    const feed = (await s.app.inject({ method: "GET", url: `/api/sync/v1/changes?epoch=${x.epoch}` })).json();
    assert.deepEqual(feed.changes.filter((c: any) => c.change === "document").map((c: any) => [c.revision, textOf(c.value)]), [[1, "First"], [2, "two"], [3, "three"]]);
    assert.deepEqual(feed.changes.map((c: any) => c.at), feed.changes.map(() => "2026-11-11T12:00:00Z"));
    await assert.rejects(s.query("UPDATE sync_change SET value = '{}'"), /immutable/);
    await assert.rejects(s.query("DELETE FROM sync_change"), /immutable/);
    await assert.rejects(s.query("TRUNCATE sync_change"), /immutable/);
  } finally { await s.drop(); }
});

test("a push cut off between ops keeps what was applied; the retry finishes it", async () => {
  const s = await server({ clock: () => T });
  try {
    const { epoch } = await state(s);
    const ops = Array.from({ length: 6 }, () => create("universe", universe()));
    let calls = 0;
    const fake = { throwIfAborted() { if (++calls > 8) throw Object.assign(new Error("aborted"), { name: "AbortError" }); } } as unknown as AbortSignal;
    await assert.rejects(s.store.syncPush({ epoch, deviceId: A, ops }, fake), /aborted/);
    const applied = Number((await counts(s)).changes);
    assert.ok(applied > 0 && applied < 6, `applied ${applied}`);
    const retry = await push(s, epoch, A, ops);
    const r = results(retry);
    assert.equal(r.filter((x) => x.status === "duplicate").length, applied);
    assert.equal(r.filter((x) => x.status === "applied").length, 6 - applied);
    assert.equal((await counts(s)).changes, "6");
    assert.equal((await s.query("SELECT count(*) AS n FROM universe"))[0].n, "6");
    // A signal that is already aborted writes nothing.
    await assert.rejects(s.store.syncPush({ epoch, deviceId: A, ops: [create("universe", universe())] }, AbortSignal.abort()), /abort/i);
    assert.equal((await counts(s)).changes, "6");
  } finally { await s.drop(); }
});

test("sync routes keep the host and cross-site guards, and exist only with library routes", async () => {
  const s = await server({ clock: () => T });
  try {
    const { epoch } = await state(s);
    const payload = { epoch, deviceId: A, ops: [create("universe", universe())] };
    const host = await s.app.inject({ method: "POST", url: "/api/sync/v1/push", payload, headers: { host: "evil.example" } });
    assert.equal(host.statusCode, 403);
    assert.equal(host.json().error.code, "FORBIDDEN_HOST");
    const site = await s.app.inject({ method: "POST", url: "/api/sync/v1/push", payload, headers: { "sec-fetch-site": "cross-site" } });
    assert.equal(site.statusCode, 403);
    for (const url of [`/api/sync/v1/changes?epoch=${epoch}`, `/api/sync/v1/conflicts?epoch=${epoch}`]) {
      assert.equal((await s.app.inject({ method: "GET", url, headers: { host: "evil.example" } })).statusCode, 403);
      assert.equal((await s.app.inject({ method: "GET", url, headers: { "sec-fetch-site": "cross-site" } })).statusCode, 403);
    }
    assert.equal((await counts(s)).changes, "0");
  } finally { await s.drop(); }
  const bare = buildApp();
  try {
    assert.equal((await bare.inject({ method: "POST", url: "/api/sync/v1/push", payload: {} })).statusCode, 404);
  } finally { await bare.close(); }
});

test("migration 0003 on a library made by 0002: data kept, a backup taken, new epoch, head 0, no record table", async () => {
  const s = await scratch();
  try {
    const all = await loadMigrations();
    assert.deepEqual(all.map((m) => m.id), ["0001-initial", "0002-archive-tables", "0003-sync"]);
    await migrate({ url: s.url, backupDir: path.join(s.dir, "b"), pgDump: pgDumpPath(), migrations: all.slice(0, 2) });
    await s.pool.query("INSERT INTO library (id, title, created_at, updated_at) VALUES ($1, 'Kept', now(), now())", [randomUUID()]);
    const r = await migrate({ url: s.url, backupDir: path.join(s.dir, "b"), pgDump: pgDumpPath() });
    assert.deepEqual(r.applied, ["0003-sync"]);
    assert.ok(r.backupFile, "a backup was taken before the pending migration");
    assert.equal((await s.pool.query("SELECT title FROM library")).rows[0].title, "Kept");
    const st = (await s.pool.query("SELECT epoch, head FROM sync_state")).rows;
    assert.equal(st.length, 1);
    assert.equal(st[0].head, "0");
    assert.match(st[0].epoch, /^[0-9a-f-]{36}$/);
    assert.equal((await s.pool.query("SELECT to_regclass('sync_record') AS t")).rows[0].t, null);
    assert.deepEqual((await migrate({ url: s.url, backupDir: path.join(s.dir, "b"), pgDump: pgDumpPath() })).applied, []);
  } finally { await s.drop(); }
});

test("a pull pages with next until it reaches head", async () => {
  const s = await server({ clock: () => T });
  try {
    const { epoch } = await state(s);
    await push(s, epoch, A, Array.from({ length: 5 }, () => create("universe", universe())));
    let after = 0;
    const seen: number[] = [];
    for (;;) {
      const page = (await s.app.inject({ method: "GET", url: `/api/sync/v1/changes?epoch=${epoch}&after=${after}&limit=2` })).json();
      seen.push(...page.changes.map((c: any) => c.seq));
      if (page.next >= page.head) break;
      after = page.next;
    }
    assert.deepEqual(seen, [1, 2, 3, 4, 5]);
  } finally { await s.drop(); }
});

// ---- M1-6 review fixes ----

test("F1: a malformed id in a record value is INVALID_VALUE before any SQL, nothing is stored, and the push continues", async () => {
  const s = await server({ clock: () => T });
  try {
    const x = await seed(s);
    const before = await counts(s);
    const n = () => randomUUID();
    const scope = { kind: "book", id: x.book };
    const note = { id: n(), bookId: x.book, text: "t", orderKey: "m", ...STAMPS };
    const field = (templateId: unknown) => ({ id: n(), templateId, key: "age", label: "Age", fieldType: "integer", required: false, orderKey: "m", ...STAMPS });
    const last = create("universe", universe());
    const ops = [
      create("reference", { id: n(), nodeId: "x", anchorId: n(), entryId: n(), ...STAMPS }), // non-uuid nodeId
      create("reference", { id: n(), nodeId: x.scene, anchorId: "a", entryId: "x", ...STAMPS }), // non-uuid entryId
      create("reference", { id: n(), nodeId: 5, anchorId: "a", entryId: n(), ...STAMPS }), // number
      create("fact", { id: n(), scope, text: "t", truth: "true", entryIds: ["x"], knowledge: [], orderKey: "m", ...STAMPS }),
      create("relationship", { id: n(), typeId: n(), fromEntryId: "x", toEntryId: n(), ...STAMPS }),
      create("relationship", { id: n(), typeId: { a: 1 }, fromEntryId: n(), toEntryId: n(), ...STAMPS }), // object
      create("field", field("x")),
      create("field", field({ id: n() })),
      create("field", field(7)),
      create("entry", { id: n(), entryType: "character", templateId: "x", name: "E", aliases: [], scope, values: {}, overrides: [], attachments: [], ...STAMPS }),
      create("note", note), // valid: applied, then broken by a set
      set("note", note.id, "nodeId", "x", 0),
      set("note", note.id, "nodeId", { id: n() }, 0),
      last,
    ];
    const res = await push(s, x.epoch, A, ops);
    assert.equal(res.statusCode, 200, res.body);
    const expected = ops.map(() => "INVALID_VALUE");
    expected[10] = "applied";
    expected[13] = "applied";
    assert.deepEqual(codes(res), expected, res.body);
    const after = await counts(s);
    assert.equal(Number(after.changes), Number(before.changes) + 2, "only the valid note and the final universe were stored");
    assert.equal(Number(after.results), Number(before.results) + ops.length, "every op has its answer");
    assert.equal((await s.query("SELECT count(*) AS n FROM manuscript_reference"))[0].n, "0");
    assert.equal((await s.query("SELECT count(*) AS n FROM entry_field"))[0].n, "0");
    assert.equal((await s.query(`SELECT node_id FROM note WHERE id = '${note.id}'`))[0].node_id, null, "the note was not changed");
    // The answers are stored: a retry gets duplicates, so the client does not retry forever.
    const again = await push(s, x.epoch, A, ops);
    assert.deepEqual(results(again).map((r) => r.status), ops.map(() => "duplicate"));
  } finally { await s.drop(); }
});

test("F5: a document nested 2000 levels deep is DOCUMENT_INVALID, nothing is stored, and the push continues", async () => {
  const s = await server({ clock: () => T });
  try {
    const x = await seed(s);
    const before = await counts(s);
    let deep: unknown[] = [];
    for (let i = 0; i < 2000; i++) deep = [deep];
    const bad = { ...docOp(x.scene, 1, "deep"), value: { ...docOf(x.scene, "deep"), extra: deep } };
    const res = await push(s, x.epoch, A, [bad, set("manuscriptNode", x.chapter, "synopsis", deep, 0), docOp(x.scene, 1, "after")]);
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(codes(res), ["DOCUMENT_INVALID", "INVALID_VALUE", "applied"], res.body);
    // So deep that JSON.stringify itself would overflow the stack: sent as raw text.
    const n = 200_000;
    const raw = await s.app.inject({
      method: "POST", url: "/api/sync/v1/push", headers: { "content-type": "application/json" },
      payload: `{"epoch":"${x.epoch}","deviceId":"${A}","ops":[{"opId":"${randomUUID()}","op":"document","recordKind":"document","recordId":"${x.scene}","baseRevision":1,"value":{"schema":"writers-rolltop/document","version":1,"nodeId":"${x.scene}","blocks":[],"extra":${"[".repeat(n)}${"]".repeat(n)}}},{"opId":"${randomUUID()}","op":"set","recordKind":"manuscriptNode","recordId":"${x.chapter}","field":"synopsis","baseSeq":0,"value":${"[".repeat(n)}${"]".repeat(n)}}]}`,
    });
    assert.equal(raw.statusCode, 200, raw.body.slice(0, 300));
    assert.deepEqual(codes(raw), ["DOCUMENT_INVALID", "INVALID_VALUE"]);
    const after = await counts(s);
    assert.equal(Number(after.changes), Number(before.changes) + 1);
    assert.equal((await s.query(`SELECT revision FROM scene_document WHERE node_id = '${x.scene}'`))[0].revision, 2);
    assert.equal(textOf((await s.query(`SELECT document FROM document_revision WHERE node_id = '${x.scene}' AND revision = 2`))[0].document), "after");
  } finally { await s.drop(); }
});

test("F5: a RangeError while serialising a value (a stack overflow, forced here) is a rejection, never a 500, and writes nothing", async () => {
  const s = await server({ clock: () => T });
  const real = JSON.stringify;
  try {
    const x = await seed(s);
    const before = await counts(s);
    // This runtime's JSON.stringify does not overflow even at 200000 levels, so the failure is simulated for one document.
    (JSON as { stringify: unknown }).stringify = function (this: unknown, v: any, ...rest: unknown[]) {
      if (v && v.schema === "writers-rolltop/document" && v.blocks?.[0]?.content?.[0]?.text === "overflow") throw new RangeError("Maximum call stack size exceeded");
      return (real as (...a: unknown[]) => string).call(this, v, ...rest);
    };
    const res = await push(s, x.epoch, A, [docOp(x.scene, 1, "overflow"), docOp(x.scene, 1, "after")]);
    JSON.stringify = real;
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(codes(res), ["DOCUMENT_INVALID", "applied"], res.body);
    assert.equal(Number((await counts(s)).changes), Number(before.changes) + 1);
    assert.equal((await s.query(`SELECT revision FROM scene_document WHERE node_id = '${x.scene}'`))[0].revision, 2);
  } finally { JSON.stringify = real; await s.drop(); }
});

test("F6: a pull page stops at 8 MiB, always returns one change, and paging from next returns everything once, in order", async () => {
  const s = await server({ clock: () => T });
  try {
    const x = await seed(s);
    const MiB = 1024 ** 2;
    const big = (rev: number, bytes: number) => docOp(x.scene, rev, "z".repeat(bytes));
    for (let rev = 1; rev <= 5; rev++) assert.equal(results(await push(s, x.epoch, A, [big(rev, 3 * MiB)]))[0].revision, rev + 1);
    // A document whose own text fits the 8 MiB document limit, but whose change (text plus envelope) does not fit a page.
    const edge = docOp(x.scene, 6, "");
    const room = 8 * MiB - Buffer.byteLength(JSON.stringify(edge.value), "utf8") - 8;
    const lone = { ...edge, value: docOf(x.scene, "y".repeat(room)) };
    assert.ok(Buffer.byteLength(JSON.stringify(lone.value), "utf8") <= 8 * MiB);
    const tail = [create("universe", universe()), create("universe", universe())];
    const pushed = await push(s, x.epoch, A, [lone, ...tail]);
    assert.deepEqual(codes(pushed), ["applied", "applied", "applied"], pushed.body);
    const head = Number((await state(s)).head);
    assert.equal(head, 5 + 5 + 3);

    const pages: any[] = [];
    let after = 0;
    for (let guard = 0; guard < 50; guard++) {
      const res = await s.app.inject({ method: "GET", url: `/api/sync/v1/changes?epoch=${x.epoch}&after=${after}` });
      assert.equal(res.statusCode, 200);
      const page = res.json();
      assert.ok(page.changes.length >= 1, "a page always makes progress");
      pages.push(page);
      after = page.next;
      if (after >= head) break;
    }
    const seqs = pages.flatMap((p) => p.changes.map((c: any) => c.seq));
    assert.deepEqual(seqs, Array.from({ length: head }, (_, i) => i + 1), "no gap, no duplicate, in order");
    assert.ok(pages.length >= 4, `${pages.length} pages`);
    assert.ok(pages[0].changes.length < head, "the first page stopped early");
    assert.equal(pages[0].changes.at(-1).seq, 7, "five small changes and two 3 MiB documents fit; the third document does not");
    for (const p of pages) {
      const size = p.changes.reduce((n: number, c: any) => n + Buffer.byteLength(JSON.stringify(c), "utf8") + 1, 0);
      assert.ok(p.changes.length === 1 || size <= 8 * MiB, `a page of ${p.changes.length} changes is ${size} bytes`);
    }
    const loneChange = pages.find((p) => p.changes.some((c: any) => c.seq === 11));
    assert.equal(loneChange.changes.length, 1, "a change over the cap is a page of its own");
    assert.ok(Buffer.byteLength(JSON.stringify(loneChange.changes[0]), "utf8") > 8 * MiB);
    assert.equal(loneChange.next, 11);
    // The limit still applies, and a page smaller than the cap is cut by it.
    const small = (await s.app.inject({ method: "GET", url: `/api/sync/v1/changes?epoch=${x.epoch}&after=0&limit=3` })).json();
    assert.deepEqual(small.changes.map((c: any) => c.seq), [1, 2, 3]);
  } finally { await s.drop(); }
});

test("F4: a push and an archive import at the same time never deadlock, and the final state is consistent", async () => {
  const bytes = await readFile(path.join(archiveFixtures, "valid", "sample-library.rolltop"));
  const { importArchiveBytes } = await import("@writers-rolltop/store");
  const outcome = (e: unknown): string => (e as { code?: string }).code ?? String(e);
  // A library exists: sync ops write the library table (a row lock under the sync_state lock), and every import takes its
  // locks and is refused. With the import taking the library lock before the sync_state lock, one of these rounds deadlocks.
  const s = await server({ clock: () => T });
  try {
    const { epoch } = await state(s);
    const libId = randomUUID();
    assert.deepEqual(codes(await push(s, epoch, A, [create("library", lib(libId))])), ["applied"]);
    const errors: string[] = [];
    for (let round = 0; round < 30; round++) {
      const ops = Array.from({ length: 12 }, (_, i) => set("library", libId, "title", `T${round}-${i}`, 0));
      const [p, i] = await Promise.all([
        push(s, epoch, A, ops),
        importArchiveBytes(s.store, bytes).then(() => "imported", outcome),
      ]);
      if (p.statusCode !== 200 || codes(p).some((c) => c !== "applied")) errors.push(`push ${p.statusCode} ${p.body.slice(0, 300)}`);
      if (i !== "LIBRARY_EXISTS") errors.push(`import ${i}`);
    }
    assert.deepEqual(errors, []);
    const st = await state(s);
    assert.equal(st.epoch, epoch, "a refused import leaves the epoch alone");
    assert.equal(st.head, String(1 + 30 * 12));
    const log = (await s.query("SELECT count(*) AS n, max(seq) AS top FROM sync_change"))[0];
    assert.deepEqual([log.n, log.top], [st.head, st.head], "the log is gapless up to head");
    assert.equal((await s.query("SELECT title FROM library"))[0].title, "T29-11");
  } finally { await s.drop(); }
  // An empty database: either the push or the import wins, never both, and the state is one of the two.
  const e = await server({ clock: () => T });
  try {
    const { epoch } = await state(e);
    const [p, i] = await Promise.all([
      push(e, epoch, A, [create("library", lib()), create("universe", universe()), create("universe", universe())]),
      importArchiveBytes(e.store, bytes).then(() => "imported", outcome),
    ]);
    assert.ok(p.statusCode === 200 || p.statusCode === 409, p.body);
    assert.ok(i === "imported" || i === "LIBRARY_EXISTS", i);
    const st = await state(e);
    const n = Number((await e.query("SELECT count(*) AS n FROM sync_change"))[0].n);
    assert.equal(n, Number(st.head), "head names the log");
    if (i === "imported") {
      assert.notEqual(st.epoch, epoch);
      assert.equal(n, 0, "the import's epoch starts with an empty log");
      assert.equal((await e.query("SELECT count(*) AS n FROM library"))[0].n, "1");
    } else {
      assert.equal(st.epoch, epoch);
      assert.ok(n >= 1, "the push won");
    }
  } finally { await e.drop(); }
});

test("F7: an attachment cannot be uploaded by sync: REFERENCE_UNRESOLVED, and the message says what is missing", async () => {
  const s = await server({ clock: () => T });
  try {
    const x = await seed(s);
    const sha = "a".repeat(64);
    const res = await push(s, x.epoch, A, [create("book", book(randomUUID(), { coverAttachment: sha })), create("book", book(randomUUID(), { universeId: MISSING }))]);
    const [att, other] = results(res);
    assert.equal(att.code, "REFERENCE_UNRESOLVED");
    assert.match(att.message, /attachment/i);
    assert.match(att.message, /archive import/i);
    assert.ok(att.message.length <= 200);
    assert.equal(other.code, "REFERENCE_UNRESOLVED");
    assert.doesNotMatch(other.message, /attachment/i);
  } finally { await s.drop(); }
});

test("F8: two document ops for one node in one push: the second is a conflict and its text is kept", async () => {
  const s = await server({ clock: () => T });
  try {
    const x = await seed(s);
    const res = await push(s, x.epoch, A, [docOp(x.scene, 1, "first"), docOp(x.scene, 1, "second")]);
    assert.deepEqual(codes(res), ["applied", "conflict"], res.body);
    assert.equal((await s.query(`SELECT revision FROM scene_document WHERE node_id = '${x.scene}'`))[0].revision, 2);
    const kept = await s.query("SELECT kind, record_id, losing FROM sync_conflict");
    assert.equal(kept.length, 1);
    assert.equal(kept[0].kind, "document");
    assert.equal(kept[0].record_id, x.scene);
    assert.equal(textOf(kept[0].losing.value), "second");
    assert.equal(textOf((await s.query(`SELECT document FROM document_revision WHERE node_id = '${x.scene}' AND revision = 2`))[0].document), "first");
  } finally { await s.drop(); }
});
