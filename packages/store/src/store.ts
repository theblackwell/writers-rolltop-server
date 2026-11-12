// Callers must run migrate() (or use Store.open) and refuse on SCHEMA_TOO_NEW before using a Store: a bare
// `new Store(...)` does not check the schema version of the database it is given.
import pg from "pg";
import type { CanonicalDocument } from "@writers-rolltop/document-adapter/canonical";
import { StoreError, mapPgError } from "./errors.ts";
import { UUID, insertFirstRevision, live, prepareDocument, swapRevision } from "./documents.ts";
import { putAttachment, readAttachment } from "./attachments.ts";
import type { AttachmentInput, AttachmentRecord } from "./attachments.ts";
import { migrate } from "./migrate.ts";
import type { Migration } from "./migrate.ts";
import { exportArchive, importContents, readArchiveData } from "./archive-io.ts";
import type { ArchiveImportResult } from "./archive-io.ts";
import type { ArchiveContents, ArchiveData, WriteOptions, WriteResult } from "@writers-rolltop/archive";
import { checkIntegrity } from "./integrity.ts";
import { syncChanges, syncConflicts, syncPush } from "./sync.ts";
import type { ChangesOutcome, ConflictsOutcome, PushOutcome } from "./sync.ts";
import type { IntegrityReport } from "./integrity.ts";

export interface StoreOptions {
  pool: pg.Pool;
  attachmentsDir: string;
  clock?: () => Date;
}

export interface StoredDocument { nodeId: string; revision: number; document: CanonicalDocument; updatedAt: Date }

export type NodeKind = "part" | "chapter" | "scene" | "frontMatter" | "backMatter";
export interface Stamps { createdAt: Date; updatedAt?: Date }
export interface LiveNode { id: string; parentId: string | null; kind: NodeKind; title: string; orderKey: string }

export interface OpenOptions {
  url: string;
  attachmentsDir: string;
  backupDir: string;
  pgDump?: string;
  migrations?: readonly Migration[];
  clock?: () => Date;
}

export class Store {
  readonly pool: pg.Pool;
  readonly attachmentsDir: string;
  readonly clock: () => Date;

  constructor(options: StoreOptions) {
    this.pool = options.pool;
    this.attachmentsDir = options.attachmentsDir;
    this.clock = options.clock ?? (() => new Date());
  }

  private ownsPool = false;
  private closePromise?: Promise<void>;

  /** Migrate the database (refusing with SCHEMA_TOO_NEW if it is ahead of this build), then open a Store on a new pool. */
  static async open(options: OpenOptions): Promise<Store> {
    await migrate({ url: options.url, backupDir: options.backupDir, pgDump: options.pgDump, migrations: options.migrations });
    const pool = new pg.Pool({ connectionString: options.url });
    pool.on("error", () => {}); // idle-client errors surface on the next query
    const store = new Store({ pool, attachmentsDir: options.attachmentsDir, clock: options.clock });
    store.ownsPool = true;
    return store;
  }

  /** Ends the pool if `open` created it. */
  async close(): Promise<void> {
    this.closePromise ??= this.ownsPool ? this.pool.end() : Promise.resolve();
    return this.closePromise;
  }

  private async tx<T>(signal: AbortSignal | undefined, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    signal?.throwIfAborted();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      signal?.throwIfAborted();
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw mapPgError(e);
    } finally {
      client.release();
    }
  }

  private async run(sql: string, params: unknown[]): Promise<pg.QueryResult> {
    try { return await this.pool.query(sql, params); } catch (e) { throw mapPgError(e); }
  }

  // ---- Documents (compare-and-swap) ----

  /** Create revision 1 of a node's document. CONFLICT if the node already has one. */
  async createDocument(nodeId: string, input: unknown, signal?: AbortSignal): Promise<StoredDocument> {
    const doc = prepareDocument(nodeId, input);
    const at = this.clock();
    await this.tx(signal, async (c) => {
      await this.requireLiveNode(c, nodeId);
      if (!(await insertFirstRevision(c, nodeId, doc, at))) throw new StoreError("CONFLICT", "node already has a document", { nodeId });
    });
    return { nodeId, revision: 1, document: doc, updatedAt: at };
  }

  /** Save only if the head is still at `expectedRevision`. A stale save is rejected and changes nothing. */
  async saveDocument(nodeId: string, expectedRevision: number, input: unknown, signal?: AbortSignal): Promise<StoredDocument> {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw new StoreError("INVARIANT_VIOLATED", "expectedRevision must be a positive integer");
    }
    const doc = prepareDocument(nodeId, input);
    const at = this.clock();
    const revision = await this.tx(signal, (c) => swapRevision(c, nodeId, expectedRevision, doc, at));
    if (revision === undefined) {
      const cur = await this.pool.query(
        `SELECT sd.revision, ${live("sd.node_id")} AS live FROM scene_document sd WHERE sd.node_id = $1`, [nodeId]);
      const row = cur.rows[0];
      if (!row || !row.live) throw new StoreError("NOT_FOUND", "document not found", { nodeId });
      throw new StoreError("CONFLICT", "the document changed since it was read", { nodeId, expected: expectedRevision, current: row.revision });
    }
    return { nodeId, revision, document: doc, updatedAt: at };
  }

  async readDocument(nodeId: string): Promise<StoredDocument> {
    if (!UUID.test(nodeId)) throw new StoreError("NOT_FOUND", "document not found");
    const { rows } = await this.run(
      `SELECT revision, document, updated_at FROM scene_document WHERE node_id = $1 AND ${live("$1::uuid")}`, [nodeId]);
    const row = rows[0];
    if (!row) throw new StoreError("NOT_FOUND", "document not found", { nodeId });
    return { nodeId, revision: row.revision, document: row.document, updatedAt: row.updated_at };
  }

  private async requireLiveNode(c: pg.PoolClient, nodeId: string): Promise<void> {
    const { rows } = await c.query(`SELECT 1 FROM manuscript_node WHERE id = $1 AND ${live("$1::uuid")}`, [nodeId]);
    if (!rows[0]) throw new StoreError("NOT_FOUND", "node not found", { nodeId });
  }

  // ---- Thin repository helpers ----

  async insertLibrary(v: { id: string; title: string } & Stamps): Promise<void> {
    await this.run("INSERT INTO library (id, title, created_at, updated_at) VALUES ($1, $2, $3, $4)",
      [v.id, v.title, v.createdAt, v.updatedAt ?? v.createdAt]);
  }

  async insertUniverse(v: { id: string; title: string; orderKey: string; summary?: string } & Stamps): Promise<void> {
    await this.run("INSERT INTO universe (id, title, summary, order_key, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)",
      [v.id, v.title, v.summary ?? null, v.orderKey, v.createdAt, v.updatedAt ?? v.createdAt]);
  }

  async insertSeries(v: { id: string; title: string; orderKey: string; universeId?: string; summary?: string } & Stamps): Promise<void> {
    await this.run("INSERT INTO series (id, universe_id, title, summary, order_key, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [v.id, v.universeId ?? null, v.title, v.summary ?? null, v.orderKey, v.createdAt, v.updatedAt ?? v.createdAt]);
  }

  async insertBook(v: {
    id: string; title: string; orderKey: string; universeId?: string; seriesId?: string;
    subtitle?: string; authorName?: string; description?: string; language?: string; logline?: string;
    premise?: string; themes?: string; arcs?: string; principles?: string;
  } & Stamps): Promise<void> {
    await this.run(
      `INSERT INTO book (id, universe_id, series_id, title, subtitle, author_name, description, language, logline,
         premise, themes, arcs, principles, order_key, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [v.id, v.universeId ?? null, v.seriesId ?? null, v.title, v.subtitle ?? null, v.authorName ?? null,
        v.description ?? null, v.language ?? null, v.logline ?? null, v.premise ?? null, v.themes ?? null,
        v.arcs ?? null, v.principles ?? null, v.orderKey, v.createdAt, v.updatedAt ?? v.createdAt]);
  }

  async insertNode(v: {
    id: string; bookId: string; kind: NodeKind; title: string; orderKey: string; parentId?: string;
    synopsis?: string; status?: string; targetWordCount?: number; plan?: string;
  } & Stamps): Promise<void> {
    await this.run(
      `INSERT INTO manuscript_node (id, book_id, parent_id, kind, title, synopsis, status, target_word_count, plan,
         order_key, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [v.id, v.bookId, v.parentId ?? null, v.kind, v.title, v.synopsis ?? null, v.status ?? null,
        v.targetWordCount ?? null, v.plan ?? null, v.orderKey, v.createdAt, v.updatedAt ?? v.createdAt]);
  }

  /** Tombstone a node. Idempotent: an already deleted node keeps its original deletion time. */
  async tombstoneNode(id: string, at: Date = this.clock()): Promise<void> {
    if (!UUID.test(id)) throw new StoreError("NOT_FOUND", "node not found");
    const r = await this.run(
      "UPDATE manuscript_node SET deleted_at = COALESCE(deleted_at, $2), updated_at = CASE WHEN deleted_at IS NULL THEN $2 ELSE updated_at END WHERE id = $1",
      [id, at]);
    if (r.rowCount === 0) throw new StoreError("NOT_FOUND", "node not found", { nodeId: id });
  }

  async listLiveNodes(bookId: string): Promise<LiveNode[]> {
    if (!UUID.test(bookId)) return [];
    const { rows } = await this.run(
      `SELECT id, parent_id, kind, title, order_key FROM manuscript_node
       WHERE book_id = $1 AND ${live("manuscript_node.id")} ORDER BY parent_id NULLS FIRST, order_key, id`, [bookId]);
    return rows.map((r) => ({ id: r.id, parentId: r.parent_id, kind: r.kind, title: r.title, orderKey: r.order_key }));
  }

  // ---- Attachments and integrity ----

  putAttachment(bytes: Uint8Array, input: AttachmentInput): Promise<AttachmentRecord> {
    return putAttachment(this.pool, this.attachmentsDir, bytes, input);
  }

  readAttachment(sha256: string): Promise<AttachmentRecord & { bytes: Uint8Array }> {
    return readAttachment(this.pool, this.attachmentsDir, sha256);
  }

  /** Load a read-and-validated archive into this (empty) database in one transaction. LIBRARY_EXISTS if it already holds a library. */
  importArchive(contents: ArchiveContents, signal?: AbortSignal): Promise<ArchiveImportResult> {
    return importContents(this, contents, signal);
  }

  /** The whole library in the archive's in-memory form (a consistent snapshot). */
  readArchiveData(): Promise<ArchiveData> {
    return readArchiveData(this);
  }

  /** Write the library to a .rolltop file. */
  exportArchive(destination: string, options?: WriteOptions): Promise<WriteResult> {
    return exportArchive(this, destination, options);
  }

  // ---- Sync protocol v1 (see sync.ts) ----

  /** POST /api/sync/v1/push. `body` is the parsed JSON, unchecked: it is validated here. */
  syncPush(body: unknown, signal?: AbortSignal): Promise<PushOutcome> {
    return syncPush({ pool: this.pool, clock: this.clock }, body, signal);
  }

  /** GET /api/sync/v1/changes. Query values are the raw strings (null when absent). */
  syncChanges(query: { epoch: string | null; after: string | null; limit: string | null }, signal?: AbortSignal): Promise<ChangesOutcome> {
    return syncChanges({ pool: this.pool, clock: this.clock }, query, signal);
  }

  /** GET /api/sync/v1/conflicts. */
  syncConflicts(query: { epoch: string | null }, signal?: AbortSignal): Promise<ConflictsOutcome> {
    return syncConflicts({ pool: this.pool, clock: this.clock }, query, signal);
  }

  checkIntegrity(): Promise<IntegrityReport> {
    return checkIntegrity(this.pool, this.attachmentsDir);
  }
}
