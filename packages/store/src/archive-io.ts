// Loads a validated archive into the database (import) and reads the database back into the archive's
// ArchiveData form (export). Import is one transaction: a failure rolls everything back, and attachment
// files this import created are removed again. Top-level records are open (archive-format-v1.md,
// "Forward compatibility"): unknown properties are kept in extra_json and written back on export.

import type pg from "pg";
import { readArchive, writeArchive, ArchiveError } from "@writers-rolltop/archive";
import type { ArchiveContents, ArchiveData, ArchiveLimits, ArchiveSummary, Issue, Json, Rec, WriteOptions, WriteResult } from "@writers-rolltop/archive";
import { StoreError, mapPgError } from "./errors.ts";
import { writeAttachmentFile } from "./attachments.ts";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Store } from "./store.ts";

type Row = Record<string, any>;
type Db = pg.PoolClient;

// ---- helpers ----

const nul = <T>(v: T | undefined): T | null => (v === undefined ? null : v);
const js = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v));

/** Unknown properties of an open record, as JSON text (null when there are none). */
function extraOf(rec: Rec, known: readonly string[]): string | null {
  const skip = new Set(known);
  const extra: Rec = {};
  let any = false;
  for (const [k, v] of Object.entries(rec)) {
    if (!skip.has(k)) { Object.defineProperty(extra, k, { value: v, enumerable: true, writable: true, configurable: true }); any = true; }
  }
  return any ? JSON.stringify(extra) : null;
}

const STAMPS = ["createdAt", "updatedAt", "deletedAt"] as const;
const stamps = (r: Rec): unknown[] => [r.createdAt, r.updatedAt, nul(r.deletedAt)];
const scopeCols = (s: { kind: string; id: string }): unknown[] => [
  s.kind === "universe" ? s.id : null, s.kind === "series" ? s.id : null, s.kind === "book" ? s.id : null];

const MAX_PARAMS = 30_000;

async function insertMany(db: Db, table: string, columns: string[], rows: unknown[][]): Promise<void> {
  if (rows.length === 0) return;
  const per = Math.max(1, Math.min(500, Math.floor(MAX_PARAMS / columns.length)));
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per);
    const params: unknown[] = [];
    const tuples = chunk.map((row) => `(${row.map((v) => { params.push(v); return `$${params.length}`; }).join(",")})`);
    await db.query(`INSERT INTO ${table} (${columns.join(",")}) VALUES ${tuples.join(",")}`, params);
  }
}

// ---- import ----

export interface ArchiveImportResult {
  summary: ArchiveSummary;
  warnings: Issue[];
}

/**
 * Write a read-and-validated archive into an empty database in one transaction. Refuses (LIBRARY_EXISTS)
 * when the database already holds a library. Attachment bytes go to the hash-addressed store first; if the
 * transaction fails, the files this call created are removed.
 */
export async function importContents(store: Store, contents: ArchiveContents, signal?: AbortSignal): Promise<ArchiveImportResult> {
  const data = contents.data;
  const libraryId = (data.library.library as Rec).id as string;
  const created: string[] = [];
  const removeCreated = async (): Promise<void> => {
    for (const sha of created) await rm(join(store.attachmentsDir, sha), { force: true }).catch(() => {});
  };
  const client = await store.pool.connect();
  let commitSent = false;
  let released = false;
  const releaseClient = (destroy: boolean): void => { if (!released) { released = true; client.release(destroy); } };
  try {
    await client.query("BEGIN");
    await client.query("LOCK TABLE library IN EXCLUSIVE MODE");
    if ((await client.query("SELECT 1 FROM library LIMIT 1")).rowCount! > 0) {
      throw new StoreError("LIBRARY_EXISTS", "this database already holds a library; import into an empty database");
    }
    const info = data.attachments.map((a) => ({ ...a }));
    for (const a of info) {
      signal?.throwIfAborted();
      const file = contents.attachments.get(a.sha256);
      if (!file) throw new StoreError("INTEGRITY_FAILED", "an attachment file is missing from the archive", { sha256: a.sha256 });
      const written = await writeAttachmentFile(store.attachmentsDir, await file.read());
      if (written.created) created.push(written.sha256);
    }
    await loadData(client, data, signal);
    signal?.throwIfAborted();
    commitSent = true;
    await client.query("COMMIT");
    return { summary: contents.summary, warnings: contents.warnings };
  } catch (e) {
    if (!commitSent) {
      // Nothing was committed: undo the transaction and the files this import created.
      await client.query("ROLLBACK").catch(() => {});
      await removeCreated();
      throw mapPgError(e);
    }
    // Give the connection back first (and destroy it: it failed during COMMIT and is not trusted again). With a
    // one-connection pool the check below would otherwise wait for the very connection this function still holds.
    releaseClient(true);
    // COMMIT was sent but its answer did not arrive (connection lost, for example). The transaction may or
    // may not have committed, so the files must not be deleted on a guess. Ask on a fresh connection.
    // (A worker killed by the API's time budget between COMMIT and its reply is the same situation seen from
    // outside: the API then reports a timeout although the library was stored, and a retry gets LIBRARY_EXISTS.)
    let stored: boolean | undefined;
    try {
      stored = ((await store.pool.query("SELECT 1 FROM library WHERE id = $1", [libraryId])).rowCount ?? 0) > 0;
    } catch { stored = undefined; }
    if (stored === true) return { summary: contents.summary, warnings: contents.warnings }; // it did commit
    if (stored === false) {
      await removeCreated();
      throw mapPgError(e);
    }
    throw new StoreError("INTEGRITY_FAILED", "the outcome of the import could not be confirmed; the library may have been stored. Check the server before importing again");
  } finally {
    releaseClient(false);
  }
}

async function loadData(db: Db, data: ArchiveData, signal: AbortSignal | undefined): Promise<void> {
  const lib = data.library;
  const L = lib.library as Rec;
  await insertMany(db, "library", ["id", "title", "created_at", "updated_at", "extra_json", "manifest_extra_json"], [[
    L.id, L.title, L.createdAt, L.updatedAt, extraOf(L, ["id", "title", "createdAt", "updatedAt"]),
    Object.keys(data.manifestExtra).length > 0 ? JSON.stringify(data.manifestExtra) : null]]);
  signal?.throwIfAborted();

  const S = ["createdAt", "updatedAt", "deletedAt"];
  await insertMany(db, "attachment", ["sha256", "media_type", "byte_length", "original_name", "extension", "created_at", "extra_json"],
    data.attachments.map((a) => [a.sha256, a.mediaType, a.byteLength, nul(a.originalName), nul(a.extension), a.createdAt,
      extraOf(a, ["sha256", "mediaType", "byteLength", "originalName", "extension", "createdAt"])]));

  await insertMany(db, "universe", ["id", "title", "summary", "order_key", "created_at", "updated_at", "deleted_at", "extra_json"],
    (lib.universes as Rec[]).map((r) => [r.id, r.title, nul(r.summary), r.orderKey, ...stamps(r), extraOf(r, ["id", "title", "summary", "orderKey", ...S])]));
  await insertMany(db, "series", ["id", "universe_id", "title", "summary", "order_key", "created_at", "updated_at", "deleted_at", "extra_json"],
    (lib.series as Rec[]).map((r) => [r.id, nul(r.universeId), r.title, nul(r.summary), r.orderKey, ...stamps(r), extraOf(r, ["id", "universeId", "title", "summary", "orderKey", ...S])]));
  const BOOK = ["id", "universeId", "seriesId", "title", "subtitle", "authorName", "description", "language", "coverAttachment",
    "targetWordCount", "targetDate", "logline", "premise", "themes", "arcs", "principles", "bibleVersion", "orderKey", ...S];
  await insertMany(db, "book", ["id", "universe_id", "series_id", "title", "subtitle", "author_name", "description", "language", "cover_attachment",
    "target_word_count", "target_date", "logline", "premise", "themes", "arcs", "principles", "bible_version", "order_key", "created_at", "updated_at", "deleted_at", "extra_json"],
    (lib.books as Rec[]).map((r) => [r.id, nul(r.universeId), nul(r.seriesId), r.title, nul(r.subtitle), nul(r.authorName), nul(r.description), nul(r.language),
      nul(r.coverAttachment), nul(r.targetWordCount), nul(r.targetDate), nul(r.logline), nul(r.premise), nul(r.themes), nul(r.arcs), nul(r.principles),
      nul(r.bibleVersion), r.orderKey, ...stamps(r), extraOf(r, BOOK)]));
  signal?.throwIfAborted();

  // Bible: templates, fields, entries (the nodes' pov and setting point at entries).
  await insertMany(db, "entry_template", ["id", "name", "entry_type", "built_in", "order_key", "created_at", "updated_at", "deleted_at", "extra_json"],
    data.templates.map((r) => [r.id, r.name, r.entryType, r.builtIn, r.orderKey, ...stamps(r), extraOf(r, ["id", "name", "entryType", "builtIn", "orderKey", ...S])]));
  await insertMany(db, "entry_field", ["id", "template_id", "key", "label", "field_type", "required", "multiple", "options_json", "target_entry_types_json", "order_key",
    "created_at", "updated_at", "deleted_at", "extra_json"],
    data.fields.map((r) => [r.id, r.templateId, r.key, r.label, r.fieldType, r.required, nul(r.multiple), js(r.options), js(r.targetEntryTypes), r.orderKey,
      ...stamps(r), extraOf(r, ["id", "templateId", "key", "label", "fieldType", "required", "multiple", "options", "targetEntryTypes", "orderKey", ...S])]));
  const ENTRY = ["id", "entryType", "templateId", "name", "givenName", "familyName", "toBeNamed", "aliases", "summary", "scope", "values", "overrides", "attachments", ...S];
  await insertMany(db, "bible_entry", ["id", "entry_type", "template_id", "name", "given_name", "family_name", "to_be_named", "aliases_json", "summary",
    "universe_id", "series_id", "book_id", "created_at", "updated_at", "deleted_at", "extra_json"],
    data.entries.map((r) => [r.id, r.entryType, nul(r.templateId), r.name, nul(r.givenName), nul(r.familyName), nul(r.toBeNamed), js(r.aliases), nul(r.summary),
      ...scopeCols(r.scope), ...stamps(r), extraOf(r, ENTRY)]));
  const values: unknown[][] = [], overrides: unknown[][] = [], overrideValues: unknown[][] = [], entryAttachments: unknown[][] = [];
  for (const e of data.entries) {
    for (const [fieldId, v] of Object.entries(e.values as Rec)) values.push([e.id, fieldId, JSON.stringify(v)]);
    (e.overrides as Rec[]).forEach((o, i) => {
      overrides.push([e.id, o.bookId, i]);
      for (const [fieldId, v] of Object.entries(o.values as Rec)) overrideValues.push([e.id, o.bookId, fieldId, JSON.stringify(v)]);
    });
    (e.attachments as string[]).forEach((sha, i) => entryAttachments.push([e.id, sha, i]));
  }
  await insertMany(db, "entry_value", ["entry_id", "field_id", "value_json"], values);
  await insertMany(db, "entry_override", ["entry_id", "book_id", "position"], overrides);
  await insertMany(db, "entry_override_value", ["entry_id", "book_id", "field_id", "value_json"], overrideValues);
  await insertMany(db, "entry_attachment", ["entry_id", "sha256", "position"], entryAttachments);
  signal?.throwIfAborted();

  // Manuscript: parents before children (part/front/back matter, then chapters, then scenes).
  const rank: Record<string, number> = { part: 0, frontMatter: 0, backMatter: 0, chapter: 1, scene: 2 };
  const nodes = [...(lib.manuscriptNodes as Rec[])].sort((a, b) => rank[a.kind]! - rank[b.kind]!);
  const NODE = ["id", "bookId", "parentId", "kind", "title", "synopsis", "status", "povEntryId", "settingEntryId", "targetWordCount", "plan", "orderKey", ...S];
  await insertMany(db, "manuscript_node", ["id", "book_id", "parent_id", "kind", "title", "synopsis", "status", "pov_entry_id", "setting_entry_id",
    "target_word_count", "plan", "order_key", "created_at", "updated_at", "deleted_at", "extra_json"],
    nodes.map((r) => [r.id, r.bookId, nul(r.parentId), r.kind, r.title, nul(r.synopsis), nul(r.status), nul(r.povEntryId), nul(r.settingEntryId),
      nul(r.targetWordCount), nul(r.plan), r.orderKey, ...stamps(r), extraOf(r, NODE)]));
  const stampOf = new Map(nodes.map((n) => [n.id as string, n.updatedAt as string]));
  const docs = [...data.documents].map(([nodeId, doc]) => [nodeId, 1, JSON.stringify(doc), stampOf.get(nodeId) ?? L.updatedAt]);
  await insertMany(db, "scene_document", ["node_id", "revision", "document", "updated_at"], docs);
  await insertMany(db, "document_revision", ["node_id", "revision", "document", "created_at"], docs);
  signal?.throwIfAborted();

  await insertMany(db, "manuscript_reference", ["id", "node_id", "anchor_id", "entry_id", "created_at", "updated_at", "deleted_at", "extra_json"],
    data.references.map((r) => [r.id, r.nodeId, r.anchorId, r.entryId, ...stamps(r), extraOf(r, ["id", "nodeId", "anchorId", "entryId", ...S])]));
  await insertMany(db, "note", ["id", "book_id", "node_id", "text", "order_key", "created_at", "updated_at", "deleted_at", "extra_json"],
    data.notes.map((r) => [r.id, r.bookId, nul(r.nodeId), r.text, r.orderKey, ...stamps(r), extraOf(r, ["id", "bookId", "nodeId", "text", "orderKey", ...S])]));

  const rel = data.relationships;
  await insertMany(db, "relationship_type", ["id", "label", "inverse_label", "order_key", "created_at", "updated_at", "deleted_at", "extra_json"],
    (rel.relationshipTypes as Rec[]).map((r) => [r.id, r.label, r.inverseLabel, r.orderKey, ...stamps(r), extraOf(r, ["id", "label", "inverseLabel", "orderKey", ...S])]));
  await insertMany(db, "relationship", ["id", "type_id", "from_entry_id", "to_entry_id", "book_id", "note", "created_at", "updated_at", "deleted_at", "extra_json"],
    (rel.relationships as Rec[]).map((r) => [r.id, r.typeId, r.fromEntryId, r.toEntryId, nul(r.bookId), nul(r.note), ...stamps(r),
      extraOf(r, ["id", "typeId", "fromEntryId", "toEntryId", "bookId", "note", ...S])]));
  signal?.throwIfAborted();

  const FACT = ["id", "scope", "text", "truth", "nodeId", "entryIds", "knowledge", "overrides", "dismissedWarnings", "orderKey", ...S];
  await insertMany(db, "fact", ["id", "universe_id", "series_id", "book_id", "text", "truth", "node_id", "knowledge_json", "overrides_json", "dismissed_warnings_json",
    "order_key", "created_at", "updated_at", "deleted_at", "extra_json"],
    data.facts.map((r) => [r.id, ...scopeCols(r.scope), r.text, r.truth, nul(r.nodeId), js(r.knowledge), js(r.overrides), js(r.dismissedWarnings), r.orderKey,
      ...stamps(r), extraOf(r, FACT)]));
  await insertMany(db, "fact_entry", ["fact_id", "entry_id", "position"],
    data.facts.flatMap((f) => (f.entryIds as string[]).map((id, i) => [f.id, id, i])));
  const QUESTION = ["id", "scope", "text", "topic", "status", "decision", "entryIds", "nodeId", "overrides", "dismissedWarnings", "orderKey", ...S];
  await insertMany(db, "question", ["id", "universe_id", "series_id", "book_id", "text", "topic", "status", "decision", "node_id", "overrides_json",
    "dismissed_warnings_json", "order_key", "created_at", "updated_at", "deleted_at", "extra_json"],
    data.questions.map((r) => [r.id, ...scopeCols(r.scope), r.text, nul(r.topic), r.status, nul(r.decision), nul(r.nodeId), js(r.overrides), js(r.dismissedWarnings),
      r.orderKey, ...stamps(r), extraOf(r, QUESTION)]));
  await insertMany(db, "question_entry", ["question_id", "entry_id", "position"],
    data.questions.flatMap((q) => (q.entryIds as string[]).map((id, i) => [q.id, id, i])));
  const EVENT = ["id", "scope", "title", "summary", "when", "orderKey", "entryId", "sceneIds", "participants", "overrides", "dismissedWarnings", ...S];
  await insertMany(db, "continuity_event", ["id", "universe_id", "series_id", "book_id", "title", "summary", "when_json", "entry_id", "overrides_json",
    "dismissed_warnings_json", "order_key", "created_at", "updated_at", "deleted_at", "extra_json"],
    data.events.map((r) => [r.id, ...scopeCols(r.scope), r.title, nul(r.summary), js(r.when), nul(r.entryId), js(r.overrides), js(r.dismissedWarnings), r.orderKey,
      ...stamps(r), extraOf(r, EVENT)]));
  await insertMany(db, "event_scene", ["event_id", "node_id", "position"],
    data.events.flatMap((e) => (e.sceneIds as string[]).map((id, i) => [e.id, id, i])));
  await insertMany(db, "event_participant", ["event_id", "entry_id", "role", "position"],
    data.events.flatMap((e) => (e.participants as Rec[]).map((p, i) => [e.id, p.entryId, nul(p.role), i])));
  await insertMany(db, "state_change", ["id", "event_id", "node_id", "entry_id", "field_id", "value_json", "note", "created_at", "updated_at", "deleted_at", "extra_json"],
    data.stateChanges.map((r) => [r.id, nul(r.eventId), nul(r.nodeId), r.entryId, r.fieldId, JSON.stringify(r.value), nul(r.note), ...stamps(r),
      extraOf(r, ["id", "eventId", "nodeId", "entryId", "fieldId", "value", "note", ...S])]));
}

/** Read archive bytes, validate them, and import into the database `pool` points at. Used by the API's import worker. */
export async function importArchiveBytes(store: Store, bytes: Uint8Array, options: { limits?: Partial<ArchiveLimits>; signal?: AbortSignal } = {}): Promise<ArchiveImportResult> {
  const contents = await readArchive(bytes, { ...(options.limits ? { limits: options.limits } : {}), ...(options.signal ? { signal: options.signal } : {}) });
  try {
    return await importContents(store, contents, options.signal);
  } finally {
    await contents.close().catch(() => {});
  }
}

// ---- export ----

/** Timestamps leave as RFC 3339 UTC with the shortest fraction that holds the stored microseconds. */
const T = (col: string): string =>
  `regexp_replace(to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '\\.?0+Z$', 'Z')`;
const stampSql = `${T("created_at")} AS created_at, ${T("updated_at")} AS updated_at, ${T("deleted_at")} AS deleted_at`;

function build(extra: unknown, known: Record<string, unknown>): Rec {
  const out: Rec = {};
  if (extra && typeof extra === "object") for (const [k, v] of Object.entries(extra as Rec)) Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
  for (const [k, v] of Object.entries(known)) if (v !== null && v !== undefined) Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
  return out;
}
const stampsOut = (r: Row) => ({ createdAt: r.created_at, updatedAt: r.updated_at, deletedAt: r.deleted_at });
const scopeOut = (r: Row) =>
  r.universe_id ? { kind: "universe", id: r.universe_id } : r.series_id ? { kind: "series", id: r.series_id } : { kind: "book", id: r.book_id };

/** Read the whole database into ArchiveData, in one read-only repeatable-read transaction (a consistent snapshot). */
export async function readArchiveData(store: Store): Promise<ArchiveData> {
  const client = await store.pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      return await readAll(client);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
    }
  } finally {
    client.release();
  }
}

async function readAll(db: Db): Promise<ArchiveData> {
  const q = async (sql: string): Promise<Row[]> => (await db.query(sql)).rows;
  const libRows = await q(`SELECT id, title, ${T("created_at")} AS created_at, ${T("updated_at")} AS updated_at, extra_json, manifest_extra_json FROM library`);
  const L = libRows[0];
  if (!L) throw new StoreError("NOT_FOUND", "this database holds no library");
  const group = <T extends Row>(rows: T[], key: string): Map<string, T[]> => {
    const m = new Map<string, T[]>();
    for (const r of rows) { const k = r[key] as string; const l = m.get(k); if (l) l.push(r); else m.set(k, [r]); }
    return m;
  };

  const universes = (await q(`SELECT id, title, summary, order_key, ${stampSql}, extra_json FROM universe ORDER BY id`))
    .map((r) => build(r.extra_json, { id: r.id, title: r.title, summary: r.summary, orderKey: r.order_key, ...stampsOut(r) }));
  const series = (await q(`SELECT id, universe_id, title, summary, order_key, ${stampSql}, extra_json FROM series ORDER BY id`))
    .map((r) => build(r.extra_json, { id: r.id, universeId: r.universe_id, title: r.title, summary: r.summary, orderKey: r.order_key, ...stampsOut(r) }));
  const books = (await q(`SELECT *, ${stampSql} FROM book ORDER BY id`)).map((r) => build(r.extra_json, {
    id: r.id, universeId: r.universe_id, seriesId: r.series_id, title: r.title, subtitle: r.subtitle, authorName: r.author_name, description: r.description,
    language: r.language, coverAttachment: r.cover_attachment, targetWordCount: r.target_word_count, targetDate: r.target_date, logline: r.logline,
    premise: r.premise, themes: r.themes, arcs: r.arcs, principles: r.principles, bibleVersion: r.bible_version, orderKey: r.order_key, ...stampsOut(r) }));
  const manuscriptNodes = (await q(`SELECT *, ${stampSql} FROM manuscript_node ORDER BY id`)).map((r) => build(r.extra_json, {
    id: r.id, bookId: r.book_id, parentId: r.parent_id, kind: r.kind, title: r.title, synopsis: r.synopsis, status: r.status, povEntryId: r.pov_entry_id,
    settingEntryId: r.setting_entry_id, targetWordCount: r.target_word_count, plan: r.plan, orderKey: r.order_key, ...stampsOut(r) }));

  const attachments = (await q(`SELECT sha256, media_type, byte_length, original_name, extension, ${T("created_at")} AS created_at, extra_json FROM attachment ORDER BY sha256`))
    .map((r) => build(r.extra_json, { sha256: r.sha256, mediaType: r.media_type, byteLength: Number(r.byte_length), originalName: r.original_name, extension: r.extension, createdAt: r.created_at }));

  const templates = (await q(`SELECT *, ${stampSql} FROM entry_template ORDER BY id`))
    .map((r) => build(r.extra_json, { id: r.id, name: r.name, entryType: r.entry_type, builtIn: r.built_in, orderKey: r.order_key, ...stampsOut(r) }));
  const fields = (await q(`SELECT *, ${stampSql} FROM entry_field ORDER BY id`)).map((r) => build(r.extra_json, {
    id: r.id, templateId: r.template_id, key: r.key, label: r.label, fieldType: r.field_type, required: r.required, multiple: r.multiple,
    options: r.options_json, targetEntryTypes: r.target_entry_types_json, orderKey: r.order_key, ...stampsOut(r) }));

  const values = group(await q("SELECT entry_id, field_id, value_json FROM entry_value ORDER BY entry_id, field_id"), "entry_id");
  const overrideRows = group(await q("SELECT entry_id, book_id, position FROM entry_override ORDER BY entry_id, position"), "entry_id");
  const overrideValues = group(await q("SELECT entry_id, book_id, field_id, value_json FROM entry_override_value ORDER BY entry_id, book_id, field_id"), "entry_id");
  const entryAttachments = group(await q("SELECT entry_id, sha256 FROM entry_attachment ORDER BY entry_id, position"), "entry_id");
  const entries = (await q(`SELECT *, ${stampSql} FROM bible_entry ORDER BY id`)).map((r) => {
    const vals: Rec = {};
    for (const v of values.get(r.id) ?? []) Object.defineProperty(vals, v.field_id, { value: v.value_json, enumerable: true, writable: true, configurable: true });
    const ovs = (overrideRows.get(r.id) ?? []).map((o) => {
      const ov: Rec = {};
      for (const v of (overrideValues.get(r.id) ?? []).filter((x) => x.book_id === o.book_id)) Object.defineProperty(ov, v.field_id, { value: v.value_json, enumerable: true, writable: true, configurable: true });
      return { bookId: o.book_id, values: ov };
    });
    return build(r.extra_json, {
      id: r.id, entryType: r.entry_type, templateId: r.template_id, name: r.name, givenName: r.given_name, familyName: r.family_name, toBeNamed: r.to_be_named,
      aliases: r.aliases_json, summary: r.summary, scope: scopeOut(r), values: vals, overrides: ovs,
      attachments: (entryAttachments.get(r.id) ?? []).map((a) => a.sha256), ...stampsOut(r) });
  });

  const references = (await q(`SELECT *, ${stampSql} FROM manuscript_reference ORDER BY id`))
    .map((r) => build(r.extra_json, { id: r.id, nodeId: r.node_id, anchorId: r.anchor_id, entryId: r.entry_id, ...stampsOut(r) }));
  const notes = (await q(`SELECT *, ${stampSql} FROM note ORDER BY id`))
    .map((r) => build(r.extra_json, { id: r.id, bookId: r.book_id, nodeId: r.node_id, text: r.text, orderKey: r.order_key, ...stampsOut(r) }));
  const relationshipTypes = (await q(`SELECT *, ${stampSql} FROM relationship_type ORDER BY id`))
    .map((r) => build(r.extra_json, { id: r.id, label: r.label, inverseLabel: r.inverse_label, orderKey: r.order_key, ...stampsOut(r) }));
  const relationships = (await q(`SELECT *, ${stampSql} FROM relationship ORDER BY id`))
    .map((r) => build(r.extra_json, { id: r.id, typeId: r.type_id, fromEntryId: r.from_entry_id, toEntryId: r.to_entry_id, bookId: r.book_id, note: r.note, ...stampsOut(r) }));

  const factEntries = group(await q("SELECT fact_id, entry_id FROM fact_entry ORDER BY fact_id, position"), "fact_id");
  const facts = (await q(`SELECT *, ${stampSql} FROM fact ORDER BY id`)).map((r) => build(r.extra_json, {
    id: r.id, scope: scopeOut(r), text: r.text, truth: r.truth, nodeId: r.node_id, entryIds: (factEntries.get(r.id) ?? []).map((x) => x.entry_id),
    knowledge: r.knowledge_json, overrides: r.overrides_json, dismissedWarnings: r.dismissed_warnings_json, orderKey: r.order_key, ...stampsOut(r) }));
  const questionEntries = group(await q("SELECT question_id, entry_id FROM question_entry ORDER BY question_id, position"), "question_id");
  const questions = (await q(`SELECT *, ${stampSql} FROM question ORDER BY id`)).map((r) => build(r.extra_json, {
    id: r.id, scope: scopeOut(r), text: r.text, topic: r.topic, status: r.status, decision: r.decision, entryIds: (questionEntries.get(r.id) ?? []).map((x) => x.entry_id),
    nodeId: r.node_id, overrides: r.overrides_json, dismissedWarnings: r.dismissed_warnings_json, orderKey: r.order_key, ...stampsOut(r) }));
  const eventScenes = group(await q("SELECT event_id, node_id FROM event_scene ORDER BY event_id, position"), "event_id");
  const eventParticipants = group(await q("SELECT event_id, entry_id, role FROM event_participant ORDER BY event_id, position"), "event_id");
  const events = (await q(`SELECT *, ${stampSql} FROM continuity_event ORDER BY id`)).map((r) => build(r.extra_json, {
    id: r.id, scope: scopeOut(r), title: r.title, summary: r.summary, when: r.when_json, orderKey: r.order_key, entryId: r.entry_id,
    sceneIds: (eventScenes.get(r.id) ?? []).map((x) => x.node_id),
    participants: (eventParticipants.get(r.id) ?? []).map((p) => build(null, { entryId: p.entry_id, role: p.role })),
    overrides: r.overrides_json, dismissedWarnings: r.dismissed_warnings_json, ...stampsOut(r) }));
  const stateChanges = (await q(`SELECT *, ${stampSql} FROM state_change ORDER BY id`)).map((r) => build(r.extra_json, {
    id: r.id, eventId: r.event_id, nodeId: r.node_id, entryId: r.entry_id, fieldId: r.field_id, value: r.value_json, note: r.note, ...stampsOut(r) }));

  const documents = new Map<string, any>();
  for (const r of await q("SELECT node_id, document FROM scene_document ORDER BY node_id")) documents.set(r.node_id, r.document);

  return {
    manifestExtra: (L.manifest_extra_json ?? {}) as { [key: string]: Json },
    library: {
      library: build(L.extra_json, { id: L.id, title: L.title, createdAt: L.created_at, updatedAt: L.updated_at }),
      universes, series, books, manuscriptNodes,
    },
    references, notes, attachments, entries, templates, fields,
    relationships: { relationshipTypes, relationships },
    facts, questions, events, stateChanges, documents,
  };
}

/** Export the library as a .rolltop file at `destination` (atomic: written aside, read back, then renamed). */
export async function exportArchive(store: Store, destination: string, options: WriteOptions = {}): Promise<WriteResult> {
  const data = await readArchiveData(store);
  try {
    return await writeArchive(data, async (sha) => (await store.readAttachment(sha)).bytes, destination, options);
  } catch (e) {
    if (e instanceof ArchiveError || e instanceof StoreError) throw e;
    throw mapPgError(e);
  }
}
