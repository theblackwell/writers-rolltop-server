// Sync protocol v1 engine (Spec/docs/sync-protocol-v1.md). The reference model is Spec/tools/sync-model.mjs; the
// scenario runner in packages/api/test checks this code against the same fixtures.
//
// Storage (migration 0003): sync_state (epoch, head), sync_change (append-only log), sync_result (first outcome per
// opId), sync_conflict (open conflicts). Records are NOT kept here: an op reads and writes the library tables through
// records.ts (the code archive import and export use), and a scene document through documents.ts (the store's own
// compare-and-swap). Every record has one current state, and an archive export contains what sync wrote.
//
// Values: before anything is written, the record an op would produce is validated by the archive validator
// (validateRecord, the same rules as a whole archive) and a document by the canonical document rules. A rejected op
// writes nothing: the validation runs before the write, and the write runs under a savepoint that a constraint of
// the database (the second line of defence behind the validator) rolls back.
//
// Attachments: sync v1 has no attachment upload (decision E: attachment bytes are out of v1), so a create or set that
// names an attachment the library does not hold is rejected REFERENCE_UNRESOLVED, with a message that says so. Attachments
// reach a library by archive import only.
//
// Known gaps (recorded, not fixed here): a scene created by sync without its document makes archive export fail (500)
// until the document is saved; an imported library has no change-feed snapshot (a client pulls the library by export);
// dependents of a record are not rechecked after it changes (a later set can leave a record that points at it invalid).
//
// Transactions: every op runs in its own transaction, which first locks the sync_state row. That serialises all
// writers (seq is gapless and in acceptance order) and makes each op atomic with its stored result and its
// changes. The push as a whole is not atomic, as the protocol says: a lost response is repaired by retrying the
// same opIds, which are answered from sync_result.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { validateRecord } from "@writers-rolltop/archive";
import type { Rec, RecordContext, RecordKind } from "@writers-rolltop/archive";
import { StoreError, mapPgError } from "./errors.ts";
import { insertFirstRevision, prepareDocument, swapRevision } from "./documents.ts";
import { canTrash, insertRecords, kindsOf, readRecords, recordTable, setTrash, updateRecord } from "./records.ts";
import type { Db } from "./records.ts";
import { RESERVED_FIELDS, isAfter, isLimit, isValidPush, unstorableValue, UUID } from "./sync-validate.ts";
import type { PushBody, SyncOp } from "./sync-validate.ts";

type Obj = Record<string, unknown>;

export const DOCUMENT_LIMIT_BYTES = 8 * 1024 ** 2;
/** A pull page stops before its serialised changes pass 8 MiB (one change is always returned). */
export const PULL_PAGE_BYTES = 8 * 1024 ** 2;
const PULL_FETCH_ROWS = 8;

const MESSAGES: Record<string, string> = {
  RECORD_EXISTS: "A record with this id already exists.",
  RECORD_UNKNOWN: "No such record.",
  RECORD_DELETED: "The record is in the trash.",
  RECORD_NOT_DELETED: "The record is not in the trash.",
  FIELD_UNKNOWN: "This field cannot be set.",
  INVALID_VALUE: "The value does not fit the record.",
  REFERENCE_UNRESOLVED: "The value refers to a record that does not exist.",
  INTEGRITY_VIOLATION: "The value breaks a rule of the library.",
  DOCUMENT_INVALID: "The document cannot be stored.",
  OP_UNSUPPORTED: "This operation is not supported for this record kind.",
  CONFLICT_UNKNOWN: "No open conflict with this id.",
};

export type OpResult =
  | { opId: string; status: "applied"; seq?: number; revision?: number; conflictId?: string }
  | { opId: string; status: "conflict"; conflictId: string; current: { seq: number; revision?: number } }
  | { opId: string; status: "rejected"; code: string; message: string }
  | { opId: string; status: "duplicate"; firstStatus: "applied" | "conflict" | "rejected"; seq?: number; revision?: number; conflictId?: string; code?: string };

export interface SyncChange {
  seq: number; at: string; opId: string; deviceId: string; change: string; recordKind: string; recordId: string;
  field?: string; value?: unknown; revision?: number;
}
export interface SyncConflict {
  conflictId: string; kind: "field" | "tombstone" | "document"; recordKind: string; recordId: string; field?: string;
  losing: Obj; current: { seq: number; revision?: number };
}

export type PushOutcome =
  | { kind: "ok"; epoch: string; head: number; results: OpResult[] }
  | { kind: "invalid" }
  | { kind: "too-large" }
  | { kind: "resync"; epoch: string; head: number };
export type ChangesOutcome =
  | { kind: "ok"; epoch: string; head: number; changes: SyncChange[]; next: number }
  | { kind: "invalid" }
  | { kind: "resync"; epoch: string; head: number };
export type ConflictsOutcome =
  | { kind: "ok"; epoch: string; conflicts: SyncConflict[] }
  | { kind: "invalid" }
  | { kind: "resync"; epoch: string; head: number };

export interface SyncDeps { pool: pg.Pool; clock: () => Date }

/** RFC 3339 UTC to the second ("2026-11-11T12:00:00Z"). Informational: server time, never used to order changes. */
const stamp = (d: Date): string => d.toISOString().replace(/\.\d+Z$/, "Z");
const num = (v: unknown): number => Number(v);

/** Serialised size of a document value that unstorableValue accepted (at most 64 levels deep). A RangeError counts as 0: the op itself then rejects the value (guarded). */
function documentBytes(v: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(v), "utf8"); } catch (e) { if (e instanceof RangeError) return 0; throw e; }
}

class EpochChanged extends Error {}

async function inTx<T>(pool: pg.Pool, signal: AbortSignal | undefined, mode: string, fn: (c: Db) => Promise<T>): Promise<T> {
  signal?.throwIfAborted();
  const client = await pool.connect();
  try {
    await client.query(`BEGIN ${mode}`);
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
    throw mapPgError(e);
  } finally {
    client.release();
  }
}

async function readState(c: Db): Promise<{ epoch: string; head: number }> {
  const { rows } = await c.query("SELECT epoch, head FROM sync_state");
  return { epoch: rows[0].epoch as string, head: num(rows[0].head) };
}

// ---- push ----

export async function syncPush(deps: SyncDeps, body: unknown, signal?: AbortSignal): Promise<PushOutcome> {
  // 1. Schema. Reads no state. One malformed op rejects the whole push.
  if (!isValidPush(body)) return { kind: "invalid" };
  for (const op of body.ops) {
    // unstorableValue is iterative and depth-limited: a value it refuses (too deep, say) is never stringified here (a very
    // deep one would overflow the stack) and is rejected DOCUMENT_INVALID by its op.
    if (op.op === "document" && !unstorableValue(op.value) && documentBytes(op.value) > DOCUMENT_LIMIT_BYTES) return { kind: "too-large" };
  }
  // 2 and 3. Epoch, then bases, against the state at the start of the push (one snapshot).
  const documentIds = [...new Set(body.ops.filter((o) => o.op === "document").map((o) => o.recordId))];
  const start = await inTx(deps.pool, signal, "ISOLATION LEVEL REPEATABLE READ READ ONLY", async (c) => {
    const state = await readState(c);
    const revisions = new Map<string, number>();
    if (documentIds.length > 0) {
      const { rows } = await c.query("SELECT node_id AS id, revision FROM scene_document WHERE node_id = ANY($1::uuid[])", [documentIds]);
      for (const r of rows) revisions.set(r.id, r.revision);
    }
    return { ...state, revisions };
  });
  if (body.epoch !== start.epoch) return { kind: "resync", epoch: start.epoch, head: start.head };
  for (const op of body.ops) {
    if ("baseSeq" in op && op.baseSeq > start.head) return { kind: "resync", epoch: start.epoch, head: start.head };
    if (op.op === "document" && op.baseRevision > (start.revisions.get(op.recordId) ?? 0)) return { kind: "resync", epoch: start.epoch, head: start.head };
  }
  // Ops in array order, one transaction each. A client that goes away stops the push between ops; what was applied
  // stays applied and a retry with the same opIds gets duplicates.
  const results: OpResult[] = [];
  let head = start.head;
  for (const op of body.ops) {
    signal?.throwIfAborted();
    try {
      const done = await inTx(deps.pool, signal, "", (c) => runOp(c, deps, body, op));
      results.push(done.result);
      head = done.head;
    } catch (e) {
      if (e instanceof EpochChanged) {
        const now = await inTx(deps.pool, undefined, "READ ONLY", readState);
        return { kind: "resync", ...now };
      }
      throw e;
    }
  }
  return { kind: "ok", epoch: start.epoch, head, results };
}

interface StoredResult { status: "applied" | "conflict" | "rejected"; seq: number | null; revision: number | null; conflict_id: string | null; code: string | null }

async function runOp(c: Db, deps: SyncDeps, body: PushBody, op: SyncOp): Promise<{ result: OpResult; head: number }> {
  const lock = await c.query("SELECT epoch, head FROM sync_state FOR UPDATE");
  if (lock.rows[0].epoch !== body.epoch) throw new EpochChanged();
  const ctx: Ctx = { c, head: num(lock.rows[0].head), deviceId: body.deviceId, at: deps.clock(), op };

  const stored = (await c.query<StoredResult>("SELECT status, seq, revision, conflict_id, code FROM sync_result WHERE op_id = $1", [op.opId])).rows[0];
  if (stored) {
    const dup: OpResult = { opId: op.opId, status: "duplicate", firstStatus: stored.status };
    if (stored.seq !== null) dup.seq = num(stored.seq);
    if (stored.revision !== null) dup.revision = stored.revision;
    if (stored.conflict_id !== null) dup.conflictId = stored.conflict_id;
    if (stored.code !== null) dup.code = stored.code;
    return { result: dup, head: ctx.head };
  }

  // Writes run in guarded(), which handles a RangeError of its own; this catches one raised before any write.
  const outcome = await applyOp(ctx).catch((e: unknown) => {
    if (e instanceof RangeError) return rangeRejection(op);
    throw e;
  });
  const result = { opId: op.opId, ...outcome } as OpResult;
  await c.query(
    "INSERT INTO sync_result (op_id, status, seq, revision, conflict_id, code) VALUES ($1,$2,$3,$4,$5,$6)",
    [op.opId, result.status,
      "seq" in result && result.seq !== undefined ? result.seq : null,
      "revision" in result && result.revision !== undefined ? result.revision : null,
      "conflictId" in result && result.conflictId !== undefined ? result.conflictId : null,
      result.status === "rejected" ? result.code : null]);
  if (ctx.head !== num(lock.rows[0].head)) await c.query("UPDATE sync_state SET head = $1", [ctx.head]);
  return { result, head: ctx.head };
}

interface Ctx { c: Db; head: number; deviceId: string; at: Date; op: SyncOp }
type Outcome =
  | { status: "applied"; seq?: number; revision?: number; conflictId?: string }
  | { status: "conflict"; conflictId: string; current: { seq: number; revision?: number } }
  | { status: "rejected"; code: string; message: string };

const reject = (code: string, message?: string): Outcome => ({ status: "rejected", code, message: message ?? MESSAGES[code]! });
const rangeRejection = (op: SyncOp): Outcome => reject(op.op === "document" ? "DOCUMENT_INVALID" : "INVALID_VALUE");
const lastSeq = (changes: { seq: number }[]): number => Math.max(...changes.map((x) => x.seq));
const isOutcome = (x: Found | Outcome): x is Outcome => "status" in x;

async function append(ctx: Ctx, f: { change: string; recordKind: string; recordId: string; field?: string; value?: unknown; revision?: number }): Promise<number> {
  const seq = ++ctx.head;
  await ctx.c.query(
    `INSERT INTO sync_change (seq, at, op_id, device_id, change, record_kind, record_id, field, value, revision)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
    [seq, ctx.at, ctx.op.opId, ctx.deviceId, f.change, f.recordKind, f.recordId, f.field ?? null,
      f.value === undefined ? null : JSON.stringify(f.value), f.revision ?? null]);
  return seq;
}

async function openConflict(ctx: Ctx, p: { kind: string; recordKind: string; recordId: string; field?: string; losing: Obj; current: { seq: number; revision?: number } }): Promise<string> {
  const id = randomUUID();
  await ctx.c.query(
    "INSERT INTO sync_conflict (id, kind, record_kind, record_id, field, losing, current) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)",
    [id, p.kind, p.recordKind, p.recordId, p.field ?? null, JSON.stringify(p.losing), JSON.stringify(p.current)]);
  return id;
}

/**
 * Run the writes of an op under a savepoint. A constraint of the database that the validator did not foresee (class
 * 23: a trigger, a foreign key, a unique index) or a value PostgreSQL cannot hold (class 22: a date out of range, an
 * integer too large for its column) rejects the op instead of failing it: the writes are rolled back, nothing is stored.
 */
async function guarded(ctx: Ctx, write: () => Promise<Outcome>): Promise<Outcome> {
  const head = ctx.head;
  await ctx.c.query("SAVEPOINT op_write");
  try {
    const out = await write();
    await ctx.c.query("RELEASE SAVEPOINT op_write");
    return out;
  } catch (e) {
    if (e instanceof RangeError) {
      // A value too deep to serialise (a stack overflow): rejected like a value the database cannot hold.
      await ctx.c.query("ROLLBACK TO SAVEPOINT op_write");
      ctx.head = head;
      return rangeRejection(ctx.op);
    }
    const state = (e as { code?: unknown } | null)?.code;
    if (typeof state !== "string" || !(state.startsWith("22") || state.startsWith("23"))) throw e;
    await ctx.c.query("ROLLBACK TO SAVEPOINT op_write");
    ctx.head = head;
    return reject(state.startsWith("23") ? "INTEGRITY_VIOLATION" : "INVALID_VALUE");
  }
}

// ---- the library as the validator sees it ----

const UUID_IN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const isUuidValue = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const SHA_IN = /^[0-9a-f]{64}$/;

/** Every uuid in a record's values and keys: the ids it may point at. */
function idsIn(root: unknown, into: Set<string> = new Set()): Set<string> {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v === "string") { for (const m of v.matchAll(UUID_IN)) into.add(m[0]); }
    else if (Array.isArray(v)) stack.push(...v);
    else if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v)) { for (const m of k.matchAll(UUID_IN)) into.add(m[0]); stack.push(x); }
  }
  return into;
}
function shasIn(root: unknown, into: Set<string> = new Set()): Set<string> {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v === "string") { if (SHA_IN.test(v)) into.add(v); }
    else if (Array.isArray(v)) stack.push(...v);
    else if (v !== null && typeof v === "object") for (const x of Object.values(v)) stack.push(x);
  }
  return into;
}

const CONTEXT_LIST: Partial<Record<RecordKind, keyof RecordContext>> = {
  universe: "universes", series: "series", book: "books", manuscriptNode: "manuscriptNodes", template: "templates", field: "fields",
  entry: "entries", relationshipType: "relationshipTypes", relationship: "relationships", fact: "facts", question: "questions",
  event: "events", stateChange: "stateChanges", reference: "references", note: "notes",
};

/**
 * The records the archive rules read when they check `rec`, read from the library tables: what `rec` names, and what
 * those records name (two levels reach everything a rule looks at: a node's book, an entry's template and fields, the
 * books of the nodes a fact points at), plus the attachments `rec` names, the sibling fields that share a template key
 * and the sibling references that share a (node, anchor, entry) triple.
 */
async function loadContext(c: Db, kind: RecordKind, rec: Rec): Promise<RecordContext> {
  const ctx: Record<string, Rec[] | string[]> = {};
  const seen = new Set<string>([rec.id]);
  const add = (k: RecordKind, recs: Rec[]): void => {
    const list = CONTEXT_LIST[k];
    if (!list || list === "attachmentHashes") return;
    ((ctx[list] ??= []) as Rec[]).push(...recs);
  };
  let frontier = [...idsIn(rec)].filter((id) => !seen.has(id));
  for (let depth = 0; depth < 2 && frontier.length > 0; depth++) {
    for (const id of frontier) seen.add(id);
    const kinds = await kindsOf(c, frontier);
    const byKind = new Map<RecordKind, string[]>();
    for (const [id, k] of kinds) byKind.set(k, [...(byKind.get(k) ?? []), id]);
    const next = new Set<string>();
    for (const [k, ids] of byKind) {
      const recs = await readRecords(c, k, ids);
      add(k, recs);
      for (const r of recs) idsIn(r, next);
    }
    frontier = [...next].filter((id) => !seen.has(id));
  }
  if (kind === "field" && isUuidValue(rec.templateId) && typeof rec.key === "string") {
    const sib = await c.query("SELECT id FROM entry_field WHERE template_id = $1 AND key = $2 AND id <> $3", [rec.templateId, rec.key, rec.id]);
    add("field", await readRecords(c, "field", sib.rows.map((r) => r.id)));
  }
  if (kind === "reference" && isUuidValue(rec.nodeId) && typeof rec.anchorId === "string" && isUuidValue(rec.entryId)) {
    const sib = await c.query("SELECT id FROM manuscript_reference WHERE node_id = $1 AND anchor_id = $2 AND entry_id = $3 AND id <> $4", [rec.nodeId, rec.anchorId, rec.entryId, rec.id]);
    add("reference", await readRecords(c, "reference", sib.rows.map((r) => r.id)));
  }
  const shas = [...shasIn(rec)];
  if (shas.length > 0) ctx.attachmentHashes = (await c.query("SELECT sha256 FROM attachment WHERE sha256 = ANY($1::text[])", [shas])).rows.map((r) => r.sha256);
  return ctx as RecordContext;
}

const ATTACHMENT_MESSAGE = "The value names an attachment this library does not hold. Sync v1 carries no attachment bytes; attachments arrive by archive import.";

/**
 * The rejection for a record that does not validate, or null when it does. The shape and value rules run first, with no
 * context and before any SQL: a malformed value (an id that is not a uuid, an object where an id belongs) is
 * INVALID_VALUE and never reaches a query on a uuid column, which would raise 22P02 outside the savepoint.
 */
async function invalidRecord(c: Db, kind: RecordKind, rec: Rec): Promise<Outcome | null> {
  const shape = validateRecord(kind, rec, {});
  if (shape.some((i) => i.code === "SCHEMA_VIOLATION")) return reject("INVALID_VALUE");
  if (kind === "library") return shape.length === 0 ? null : reject("INTEGRITY_VIOLATION");
  const context = await loadContext(c, kind, rec);
  const issues = validateRecord(kind, rec, context);
  if (issues.length === 0) return null;
  const codes = new Set(issues.map((i) => i.code));
  if (codes.has("SCHEMA_VIOLATION")) return reject("INVALID_VALUE");
  if (codes.has("REFERENCE_UNRESOLVED")) {
    const held = new Set(context.attachmentHashes ?? []);
    const missing = [...shasIn(rec)].some((sha) => !held.has(sha));
    return reject("REFERENCE_UNRESOLVED", missing ? ATTACHMENT_MESSAGE : undefined);
  }
  return reject("INTEGRITY_VIOLATION");
}

/** RFC 3339 UTC with the shortest fraction, as the library exports timestamps. */
const stampOf = (d: Date): string => d.toISOString().replace(/\.?0+Z$/, "Z");

// ---- reading what sync needs to know about a record ----

interface Tombstone { seq: number; opId: string | null; deviceId: string | null }

/**
 * The change that put a trashed record in the trash: the latest tombstone change, if no restore change follows it. A
 * record that is in the trash without such a change (trashed in the archive that was imported, or by the store
 * itself) has seq 0: no base can be older than it, so an edit of it is RECORD_DELETED, never the restore branch.
 */
async function tombstoneOf(c: Db, recordId: string): Promise<Tombstone> {
  const { rows } = await c.query(
    "SELECT seq, change, op_id, device_id FROM sync_change WHERE record_id = $1 AND change IN ('tombstone','restore') ORDER BY seq DESC LIMIT 1", [recordId]);
  const r = rows[0];
  if (!r || r.change !== "tombstone") return { seq: 0, opId: null, deviceId: null };
  return { seq: num(r.seq), opId: r.op_id, deviceId: r.device_id };
}

/** Changes to one record by other devices after `baseSeq`, ascending. */
async function foreignChanges(ctx: Ctx, recordId: string, baseSeq: number): Promise<{ seq: number; change: string; field: string | null }[]> {
  const { rows } = await ctx.c.query(
    "SELECT seq, change, field FROM sync_change WHERE record_id = $1 AND device_id <> $2 AND seq > $3 ORDER BY seq",
    [recordId, ctx.deviceId, baseSeq]);
  return rows.map((r) => ({ seq: num(r.seq), change: r.change, field: r.field }));
}

interface Found { kind: RecordKind; trashed: boolean }

/** The record the op addresses, or a rejected outcome when it cannot address one. */
async function find(ctx: Ctx, op: { recordKind: string; recordId: string }): Promise<Found | Outcome> {
  if (op.recordKind === "document") return reject("OP_UNSUPPORTED");
  const kind = op.recordKind as RecordKind;
  const { rows } = await ctx.c.query(`SELECT ${canTrash(kind) ? "deleted_at IS NOT NULL" : "false"} AS trashed FROM ${recordTable(kind)} WHERE id = $1`, [op.recordId]);
  if (!rows[0]) return reject("RECORD_UNKNOWN");
  return { kind, trashed: rows[0].trashed };
}

// ---- the ops ----

async function applyOp(ctx: Ctx): Promise<Outcome> {
  const op = ctx.op;
  switch (op.op) {
    case "resolve": {
      const del = await ctx.c.query("DELETE FROM sync_conflict WHERE id = $1", [op.conflictId]);
      return del.rowCount === 0 ? reject("CONFLICT_UNKNOWN") : { status: "applied" };
    }
    case "document": return applyDocument(ctx, op);
    case "create": return applyCreate(ctx, op);
    case "set": case "unset": return applyField(ctx, op);
    case "tombstone": return applyTombstone(ctx, op);
    case "restore": return applyRestore(ctx, op);
  }
}

async function applyCreate(ctx: Ctx, op: Extract<SyncOp, { op: "create" }>): Promise<Outcome> {
  if (op.recordKind === "document") return reject("OP_UNSUPPORTED");
  const kind = op.recordKind as RecordKind;
  // An id is never reused, in any kind, trashed or not.
  if ((await kindsOf(ctx.c, [op.recordId])).size > 0) return reject("RECORD_EXISTS");
  // `deletedAt` is never in a create value: a record starts live and is trashed only by a tombstone.
  if (op.value.id !== op.recordId || unstorableValue(op.value) || Object.hasOwn(op.value, "deletedAt")) return reject("INVALID_VALUE");
  // A library database holds exactly one library.
  if (kind === "library" && ((await ctx.c.query("SELECT 1 FROM library LIMIT 1")).rowCount ?? 0) > 0) return reject("INTEGRITY_VIOLATION");
  const bad = await invalidRecord(ctx.c, kind, op.value);
  if (bad) return bad;
  return guarded(ctx, async () => {
    await insertRecords(ctx.c, kind, [op.value]);
    const seq = await append(ctx, { change: "create", recordKind: op.recordKind, recordId: op.recordId, value: op.value });
    return { status: "applied", seq };
  });
}

/** The record with one field changed, or the rejection when the field is not one the kind has or the value is not one it takes. */
function withField(kind: RecordKind, old: Rec, field: string, op: "set" | "unset", value: unknown): { next: Rec } | { rejected: Outcome } {
  const next: Rec = {};
  const put = (o: Rec, k: string, v: unknown): void => { Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true }); };
  for (const [k, v] of Object.entries(old)) put(next, k, v);
  const values = /^values\/([0-9a-f-]{36})$/.exec(field);
  const overrides = /^overrides\/([0-9a-f-]{36})$/.exec(field);
  if (values) {
    if (kind !== "entry") return { rejected: reject("FIELD_UNKNOWN") };
    const map: Rec = {};
    for (const [k, v] of Object.entries(old.values ?? {})) if (k !== values[1]) put(map, k, v);
    if (op === "set") put(map, values[1]!, value);
    put(next, "values", map);
    return { next };
  }
  if (overrides) {
    if (kind !== "entry" && kind !== "fact" && kind !== "question" && kind !== "event") return { rejected: reject("FIELD_UNKNOWN") };
    const bookId = overrides[1]!;
    const list: unknown[] = Array.isArray(old.overrides) ? [...old.overrides] : [];
    const at = list.findIndex((o) => (o as Rec | null)?.bookId === bookId);
    if (op === "set") {
      if (value === null || typeof value !== "object" || Array.isArray(value) || (value as Rec).bookId !== bookId) return { rejected: reject("INVALID_VALUE") };
      if (at >= 0) list[at] = value; else list.push(value);
    } else if (at >= 0) list.splice(at, 1);
    if (list.length === 0 && kind !== "entry") delete next.overrides; else put(next, "overrides", list);
    return { next };
  }
  if (op === "set") put(next, field, value); else delete next[field];
  return { next };
}

async function applyField(ctx: Ctx, op: Extract<SyncOp, { op: "set" | "unset" }>): Promise<Outcome> {
  const found = await find(ctx, op);
  if (isOutcome(found)) return found;
  if (RESERVED_FIELDS.has(op.field)) return reject("FIELD_UNKNOWN");
  if (op.op === "set" && unstorableValue(op.value)) return reject("INVALID_VALUE");
  const { kind } = found;
  const tomb = found.trashed ? await tombstoneOf(ctx.c, op.recordId) : null;
  let restoreBranch: Tombstone | null = null;
  if (tomb) {
    if (tomb.seq > op.baseSeq && tomb.deviceId !== ctx.deviceId) restoreBranch = tomb;
    else return reject("RECORD_DELETED");
  }
  // The record this op would leave behind must be a valid archive record (a restore makes it live again).
  const old = (await readRecords(ctx.c, kind, [op.recordId]))[0]!;
  const base = { ...old };
  if (restoreBranch) delete base.deletedAt;
  const changed = withField(kind, base, op.field, op.op, op.op === "set" ? op.value : undefined);
  if ("rejected" in changed) return changed.rejected;
  const next = changed.next;
  Object.defineProperty(next, "updatedAt", { value: stampOf(ctx.at), enumerable: true, writable: true, configurable: true });
  const bad = await invalidRecord(ctx.c, kind, next);
  if (bad) return bad;

  const foreign = await foreignChanges(ctx, op.recordId, op.baseSeq);
  // A conflicting field comes before the restore branch: the record stays in the trash.
  const clash = foreign.filter((x) => (x.change === "set" || x.change === "unset") && x.field === op.field);
  if (clash.length > 0) {
    const current = { seq: lastSeq(clash) };
    const conflictId = await openConflict(ctx, {
      kind: "field", recordKind: op.recordKind, recordId: op.recordId, field: op.field,
      losing: { opId: op.opId, deviceId: ctx.deviceId, change: op.op, ...(op.op === "set" ? { value: op.value } : {}), baseSeq: op.baseSeq },
      current,
    });
    return { status: "conflict", conflictId, current };
  }
  return guarded(ctx, async () => {
    if (restoreBranch) {
      await setTrash(ctx.c, kind, op.recordId, null, ctx.at);
      await append(ctx, { change: "restore", recordKind: op.recordKind, recordId: op.recordId });
    }
    await updateRecord(ctx.c, kind, base, next);
    const seq = await append(ctx, {
      change: op.op, recordKind: op.recordKind, recordId: op.recordId, field: op.field, ...(op.op === "set" ? { value: op.value } : {}),
    });
    if (!restoreBranch) return { status: "applied", seq } as Outcome;
    const conflictId = await openConflict(ctx, {
      kind: "tombstone", recordKind: op.recordKind, recordId: op.recordId,
      losing: { opId: restoreBranch.opId, deviceId: restoreBranch.deviceId, change: "tombstone", seq: restoreBranch.seq },
      current: { seq },
    });
    return { status: "applied", seq, conflictId } as Outcome;
  });
}

async function applyTombstone(ctx: Ctx, op: Extract<SyncOp, { op: "tombstone" }>): Promise<Outcome> {
  const found = await find(ctx, op);
  if (isOutcome(found)) return found;
  // The library record has no trash: its archive record has no deletedAt.
  if (!canTrash(found.kind)) return reject("OP_UNSUPPORTED");
  if (found.trashed) return reject("RECORD_DELETED");
  const foreign = (await foreignChanges(ctx, op.recordId, op.baseSeq)).filter((x) => x.change !== "tombstone");
  if (foreign.length > 0) {
    const current = { seq: lastSeq(foreign) };
    const conflictId = await openConflict(ctx, {
      kind: "tombstone", recordKind: op.recordKind, recordId: op.recordId,
      losing: { opId: op.opId, deviceId: ctx.deviceId, change: "tombstone", baseSeq: op.baseSeq },
      current,
    });
    return { status: "conflict", conflictId, current };
  }
  return guarded(ctx, async () => {
    await setTrash(ctx.c, found.kind, op.recordId, ctx.at, ctx.at);
    const seq = await append(ctx, { change: "tombstone", recordKind: op.recordKind, recordId: op.recordId });
    return { status: "applied", seq };
  });
}

async function applyRestore(ctx: Ctx, op: Extract<SyncOp, { op: "restore" }>): Promise<Outcome> {
  const found = await find(ctx, op);
  if (isOutcome(found)) return found;
  if (!canTrash(found.kind)) return reject("OP_UNSUPPORTED");
  if (!found.trashed) return reject("RECORD_NOT_DELETED");
  return guarded(ctx, async () => {
    await setTrash(ctx.c, found.kind, op.recordId, null, ctx.at);
    const seq = await append(ctx, { change: "restore", recordKind: op.recordKind, recordId: op.recordId });
    return { status: "applied", seq };
  });
}

/** The nearest trashed node on the way from `nodeId` up through its parents (the node itself first), if any. */
async function trashingNode(c: Db, nodeId: string): Promise<string | undefined> {
  const { rows } = await c.query(
    `WITH RECURSIVE chain(id, parent_id, deleted_at, depth) AS (
       SELECT id, parent_id, deleted_at, 0 FROM manuscript_node WHERE id = $1
       UNION ALL SELECT p.id, p.parent_id, p.deleted_at, c.depth + 1 FROM manuscript_node p JOIN chain c ON p.id = c.parent_id)
     SELECT id FROM chain WHERE deleted_at IS NOT NULL ORDER BY depth LIMIT 1`, [nodeId]);
  return rows[0]?.id;
}

async function applyDocument(ctx: Ctx, op: Extract<SyncOp, { op: "document" }>): Promise<Outcome> {
  const node = (await ctx.c.query("SELECT kind FROM manuscript_node WHERE id = $1", [op.recordId])).rows[0];
  if (!node) return reject("RECORD_UNKNOWN");
  if (op.value.nodeId !== op.recordId) return reject("INVALID_VALUE");
  if (unstorableValue(op.value)) return reject("DOCUMENT_INVALID");
  let doc;
  try { doc = prepareDocument(op.recordId, op.value); } catch (e) {
    if (e instanceof StoreError && e.code === "DOCUMENT_INVALID") return reject("DOCUMENT_INVALID");
    throw e;
  }
  // Only scenes, front matter and back matter carry a document (archive format, and the store's own trigger).
  if (node.kind === "part" || node.kind === "chapter") return reject("INTEGRITY_VIOLATION");
  const losing = { opId: op.opId, deviceId: ctx.deviceId, change: "document", baseRevision: op.baseRevision, value: doc };
  const conflict = async (seq: number, revision: number): Promise<Outcome> => {
    const current = { seq, revision };
    const conflictId = await openConflict(ctx, { kind: "document", recordKind: "document", recordId: op.recordId, losing, current });
    return { status: "conflict", conflictId, current };
  };
  const revisionOf = async (): Promise<number> =>
    (await ctx.c.query("SELECT revision FROM scene_document WHERE node_id = $1", [op.recordId])).rows[0]?.revision ?? 0;
  const lastDocumentSeq = async (): Promise<number> =>
    num((await ctx.c.query("SELECT max(seq) AS seq FROM sync_change WHERE record_id = $1 AND change = 'document'", [op.recordId])).rows[0].seq ?? 0);

  const revision = await revisionOf();
  // Text must never be lost: a trashed node (or one under a trashed parent, which the store hides) keeps the save as a conflict.
  const trashing = await trashingNode(ctx.c, op.recordId);
  if (trashing !== undefined) return conflict((await tombstoneOf(ctx.c, trashing)).seq, revision);
  // Compare-and-swap on the revision. Device-independent: the own-device rule never applies here.
  if (op.baseRevision !== revision) return conflict(await lastDocumentSeq(), revision);
  return guarded(ctx, async () => {
    // The store's own writes (documents.ts), under the sync_state lock this op holds. The swap is a real compare-and-swap
    // in SQL (revision and liveness in the WHERE), so it would refuse a stale write even without the lock.
    let written: number | undefined;
    if (revision === 0) written = (await insertFirstRevision(ctx.c, op.recordId, doc, ctx.at)) ? 1 : undefined;
    else written = await swapRevision(ctx.c, op.recordId, op.baseRevision, doc, ctx.at);
    if (written === undefined) return conflict(await lastDocumentSeq(), await revisionOf());
    const seq = await append(ctx, { change: "document", recordKind: "document", recordId: op.recordId, revision: written });
    return { status: "applied", seq, revision: written };
  });
}

// ---- pull and conflicts ----

export async function syncChanges(deps: SyncDeps, q: { epoch: string | null; after: string | null; limit: string | null }, signal?: AbortSignal): Promise<ChangesOutcome> {
  const after = q.after ?? "0";
  const limit = q.limit ?? "200";
  if (!UUID.test(q.epoch ?? "") || !isAfter(after) || !isLimit(limit)) return { kind: "invalid" };
  return inTx(deps.pool, signal, "ISOLATION LEVEL REPEATABLE READ READ ONLY", async (c): Promise<ChangesOutcome> => {
    const state = await readState(c);
    if (q.epoch !== state.epoch || Number(after) > state.head) return { kind: "resync", ...state };
    // A page ends at `limit` changes or when the next change would take its serialised size past PULL_PAGE_BYTES,
    // whichever comes first, but always holds at least one change, so a client that pages with `next` makes progress even
    // past a single change larger than the cap (a document change can be up to DOCUMENT_LIMIT_BYTES). Rows are read a few at
    // a time so a page of large documents is never held whole in memory.
    const wanted = Number(limit);
    const changes: SyncChange[] = [];
    let bytes = 0;
    let cursor = Number(after);
    let full = false;
    while (!full && changes.length < wanted) {
      const { rows } = await c.query(
        // A document change carries no text of its own: the revision it names is read from document_revision.
        `SELECT c.seq, c.at, c.op_id, c.device_id, c.change, c.record_kind, c.record_id, c.field, c.revision,
                CASE WHEN c.change = 'document' THEN d.document ELSE c.value END AS value
         FROM sync_change c LEFT JOIN document_revision d ON c.change = 'document' AND d.node_id = c.record_id AND d.revision = c.revision
         WHERE c.seq > $1 ORDER BY c.seq LIMIT $2`,
        [cursor, Math.min(PULL_FETCH_ROWS, wanted - changes.length)]);
      if (rows.length === 0) break;
      for (const r of rows) {
        const ch: SyncChange = { seq: num(r.seq), at: stamp(r.at), opId: r.op_id, deviceId: r.device_id, change: r.change, recordKind: r.record_kind, recordId: r.record_id };
        if (r.field !== null) ch.field = r.field;
        if (r.change === "create" || r.change === "set" || r.change === "document") ch.value = r.value;
        if (r.revision !== null) ch.revision = r.revision;
        const size = Buffer.byteLength(JSON.stringify(ch), "utf8") + 1;
        if (changes.length > 0 && bytes + size > PULL_PAGE_BYTES) { full = true; break; }
        changes.push(ch);
        bytes += size;
        cursor = ch.seq;
      }
    }
    return { kind: "ok", epoch: state.epoch, head: state.head, changes, next: changes.length > 0 ? changes[changes.length - 1]!.seq : Number(after) };
  });
}

export async function syncConflicts(deps: SyncDeps, q: { epoch: string | null }, signal?: AbortSignal): Promise<ConflictsOutcome> {
  if (!UUID.test(q.epoch ?? "")) return { kind: "invalid" };
  return inTx(deps.pool, signal, "ISOLATION LEVEL REPEATABLE READ READ ONLY", async (c): Promise<ConflictsOutcome> => {
    const state = await readState(c);
    if (q.epoch !== state.epoch) return { kind: "resync", ...state };
    const { rows } = await c.query("SELECT id, kind, record_kind, record_id, field, losing, current FROM sync_conflict ORDER BY n");
    const conflicts: SyncConflict[] = rows.map((r) => {
      const x: SyncConflict = { conflictId: r.id, kind: r.kind, recordKind: r.record_kind, recordId: r.record_id, losing: r.losing, current: r.current };
      if (r.field !== null) x.field = r.field;
      return x;
    });
    return { kind: "ok", epoch: state.epoch, conflicts };
  });
}
