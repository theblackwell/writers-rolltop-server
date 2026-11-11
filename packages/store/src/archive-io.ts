// Loads a validated archive into the database (import) and reads the database back into the archive's
// ArchiveData form (export). Import is one transaction: a failure rolls everything back, and attachment
// files this import created are removed again. Top-level records are open (archive-format-v1.md,
// "Forward compatibility"): unknown properties are kept in extra_json and written back on export.

import type pg from "pg";
import { readArchive, writeArchive, ArchiveError } from "@writers-rolltop/archive";
import type { ArchiveContents, ArchiveData, ArchiveLimits, ArchiveSummary, Issue, Json, Rec, RecordKind, WriteOptions, WriteResult } from "@writers-rolltop/archive";
import { StoreError, mapPgError } from "./errors.ts";
import { writeAttachmentFile } from "./attachments.ts";
import { build, extraOf, insertMany, insertRecords, readRecords, T } from "./records.ts";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Store } from "./store.ts";

type Db = pg.PoolClient;

const nul = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

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
    // Lock order: sync_state first, then the library table. A sync op (sync.ts, runOp) takes the sync_state row first and
    // then writes the library tables (a row lock on them, which an EXCLUSIVE table lock blocks); taking them in the other
    // order here would let the two wait for each other (deadlock, 40P01).
    await client.query("SELECT 1 FROM sync_state FOR UPDATE");
    await client.query("LOCK TABLE library IN EXCLUSIVE MODE");
    if ((await client.query("SELECT 1 FROM library LIMIT 1")).rowCount! > 0) {
      throw new StoreError("LIBRARY_EXISTS", "this database already holds a library; import into an empty database");
    }
    // Sync writes the library tables themselves (sync.ts), so a library made by sync is refused above like any other.
    // What the library check cannot see is a sync log without a library (records created, no library record yet):
    // those records are library content too, and an import must not merge into them.
    if ((await client.query("SELECT 1 FROM sync_change LIMIT 1")).rowCount! > 0) {
      throw new StoreError("LIBRARY_EXISTS", "this database already holds sync records; import into an empty database");
    }
    // The import starts a new sync epoch (sync-protocol-v1.md, "Epoch"): head 0, and no stored op result or open
    // conflict of the old epoch survives. The change log is empty here (checked above), so nothing is discarded that
    // an import could not replace.
    await client.query("DELETE FROM sync_result");
    await client.query("DELETE FROM sync_conflict");
    await client.query("UPDATE sync_state SET epoch = gen_random_uuid(), head = 0");
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
  await insertRecords(db, "library", [L]);
  if (Object.keys(data.manifestExtra).length > 0) await db.query("UPDATE library SET manifest_extra_json = $1", [JSON.stringify(data.manifestExtra)]);
  signal?.throwIfAborted();

  await insertMany(db, "attachment", ["sha256", "media_type", "byte_length", "original_name", "extension", "created_at", "extra_json"],
    data.attachments.map((a) => [a.sha256, a.mediaType, a.byteLength, nul(a.originalName), nul(a.extension), a.createdAt,
      extraOf(a, ["sha256", "mediaType", "byteLength", "originalName", "extension", "createdAt"])]));

  await insertRecords(db, "universe", lib.universes as Rec[]);
  await insertRecords(db, "series", lib.series as Rec[]);
  await insertRecords(db, "book", lib.books as Rec[]);
  signal?.throwIfAborted();

  // Bible: templates, fields, entries (the nodes' pov and setting point at entries).
  await insertRecords(db, "template", data.templates);
  await insertRecords(db, "field", data.fields);
  await insertRecords(db, "entry", data.entries);
  signal?.throwIfAborted();

  // Manuscript (parents before children, inside insertRecords), then the documents.
  const nodes = lib.manuscriptNodes as Rec[];
  await insertRecords(db, "manuscriptNode", nodes);
  const stampOf = new Map(nodes.map((n) => [n.id as string, n.updatedAt as string]));
  const docs = [...data.documents].map(([nodeId, doc]) => [nodeId, 1, JSON.stringify(doc), stampOf.get(nodeId) ?? L.updatedAt]);
  await insertMany(db, "scene_document", ["node_id", "revision", "document", "updated_at"], docs);
  await insertMany(db, "document_revision", ["node_id", "revision", "document", "created_at"], docs);
  signal?.throwIfAborted();

  await insertRecords(db, "reference", data.references);
  await insertRecords(db, "note", data.notes);
  await insertRecords(db, "relationshipType", data.relationships.relationshipTypes as Rec[]);
  await insertRecords(db, "relationship", data.relationships.relationships as Rec[]);
  signal?.throwIfAborted();

  await insertRecords(db, "fact", data.facts);
  await insertRecords(db, "question", data.questions);
  await insertRecords(db, "event", data.events);
  await insertRecords(db, "stateChange", data.stateChanges);
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
  const [L] = await readRecords(db, "library");
  const manifestExtra = (await db.query("SELECT manifest_extra_json FROM library")).rows[0]?.manifest_extra_json;
  if (!L) throw new StoreError("NOT_FOUND", "this database holds no library");
  const read = (kind: RecordKind) => readRecords(db, kind);

  const attachments = (await db.query(`SELECT sha256, media_type, byte_length, original_name, extension, ${T("created_at")} AS created_at, extra_json FROM attachment ORDER BY sha256`)).rows
    .map((r) => build(r.extra_json, { sha256: r.sha256, mediaType: r.media_type, byteLength: Number(r.byte_length), originalName: r.original_name, extension: r.extension, createdAt: r.created_at }));

  const documents = new Map<string, any>();
  const docRows = (await db.query("SELECT node_id, document FROM scene_document ORDER BY node_id")).rows;
  for (const r of docRows) documents.set(r.node_id, r.document);

  return {
    manifestExtra: (manifestExtra ?? {}) as { [key: string]: Json },
    library: {
      library: L,
      universes: await read("universe"), series: await read("series"), books: await read("book"), manuscriptNodes: await read("manuscriptNode"),
    },
    references: await read("reference"), notes: await read("note"), attachments,
    entries: await read("entry"), templates: await read("template"), fields: await read("field"),
    relationships: { relationshipTypes: await read("relationshipType"), relationships: await read("relationship") },
    facts: await read("fact"), questions: await read("question"), events: await read("event"), stateChanges: await read("stateChange"),
    documents,
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
