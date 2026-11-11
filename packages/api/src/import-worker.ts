// Runs one archive import in a worker thread with resource limits (see import-runner.ts). The untrusted
// archive is parsed and validated here, and loaded into the database from here, so a hostile archive can
// only exhaust this thread's heap or time budget, not the server's. Only a small summary or a sanitised
// error goes back: never a cause object, document text or a path.

import { parentPort, workerData } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { ArchiveError } from "@writers-rolltop/archive";
import type { ArchiveLimits } from "@writers-rolltop/archive";
import { Store, StoreError, importArchiveBytes } from "@writers-rolltop/store";
import { sanitizeForLog } from "./api-errors.ts";

export interface WorkerInput {
  bytes: Uint8Array;
  databaseUrl: string;
  attachmentsDir: string;
  limits?: Partial<ArchiveLimits>;
  /** Test seam: makes the worker loop or allocate until a resource limit trips. */
  fault?: "spin" | "allocate" | "hold-transaction" | "show-settings" | "lose-commit-after" | "lose-commit-before";
  /** Database-side limits for the worker's connection, in milliseconds. */
  dbTimeouts: { statementMs: number; lockMs: number; idleInTransactionMs: number };
}

export type WorkerResult =
  | { ok: true; summary: unknown; warnings: { code: string; recordId?: string; bookId?: string }[] }
  | { ok: false; kind: "archive" | "store" | "other"; code: string; issues?: { code: string; recordId?: string; bookId?: string }[]; issuesTruncated?: boolean; logMessage: string };

const input = workerData as WorkerInput;

/** Test seam: a pool whose connections lose the answer to COMMIT (after it ran, or instead of running it). */
function lossyCommit(real: pg.Pool, commitRuns: boolean): pg.Pool {
  const wrapped = {
    query: (...a: unknown[]) => (real.query as any)(...a),
    connect: async () => {
      const c = await real.connect();
      const query = async (sql: unknown, ...rest: unknown[]) => {
        if (sql !== "COMMIT") return (c.query as any)(sql, ...rest);
        await (c.query as any)(commitRuns ? "COMMIT" : "ROLLBACK");
        throw new Error("connection terminated");
      };
      return new Proxy(c, { get: (t, p) => (p === "query" ? query : typeof (t as any)[p] === "function" ? (t as any)[p].bind(t) : (t as any)[p]) });
    },
  };
  return wrapped as unknown as pg.Pool;
}

async function main(): Promise<WorkerResult> {
  if (input.fault === "spin") for (;;) { /* a CPU-bound hang: the time budget must cut it off */ }
  if (input.fault === "allocate") { const keep: unknown[] = []; for (;;) keep.push(new Array(1_000_000).fill(keep.length)); }
  // A killed or stuck worker must not leave the database waiting on it: the server drops a transaction that idles, a
  // statement that runs too long, and a lock wait that never ends.
  const pool = new pg.Pool({
    connectionString: input.databaseUrl, max: 1, connectionTimeoutMillis: 15_000,
    statement_timeout: input.dbTimeouts.statementMs,
    lock_timeout: input.dbTimeouts.lockMs,
    idle_in_transaction_session_timeout: input.dbTimeouts.idleInTransactionMs,
  });
  pool.on("error", () => {});
  try {
    if (input.fault === "show-settings") {
      const r = await pool.query("SELECT current_setting('statement_timeout') AS s, current_setting('lock_timeout') AS l, current_setting('idle_in_transaction_session_timeout') AS i");
      return { ok: true, summary: r.rows[0], warnings: [] };
    }
    if (input.fault === "hold-transaction") {
      const c = await pool.connect();
      await c.query("BEGIN");
      await c.query("LOCK TABLE library IN EXCLUSIVE MODE");
      await c.query("INSERT INTO library (id, title, created_at, updated_at) VALUES ($1, 'held', now(), now())", [randomUUID()]);
      await new Promise(() => {}); // hold the transaction open until the worker is killed
    }
    const store = new Store({ pool: input.fault?.startsWith("lose-commit") ? lossyCommit(pool, input.fault === "lose-commit-after") : pool, attachmentsDir: input.attachmentsDir });
    const result = await importArchiveBytes(store, input.bytes, input.limits ? { limits: input.limits } : {});
    return {
      ok: true,
      summary: result.summary,
      warnings: result.warnings.map((w) => ({ code: w.code, ...(w.recordId ? { recordId: w.recordId } : {}), ...(w.bookId ? { bookId: w.bookId } : {}) })),
    };
  } catch (e) {
    if (e instanceof ArchiveError) {
      return {
        ok: false, kind: "archive", code: e.code, logMessage: sanitizeForLog(e.message),
        issues: e.issues.map((i) => ({ code: i.code, ...(i.recordId ? { recordId: i.recordId } : {}), ...(i.bookId ? { bookId: i.bookId } : {}) })),
        issuesTruncated: e.issuesTruncated,
      };
    }
    if (e instanceof StoreError) return { ok: false, kind: "store", code: e.code, logMessage: sanitizeForLog(e.message) };
    const state = (e as { code?: unknown } | null)?.code;
    return { ok: false, kind: "other", code: "UNKNOWN", logMessage: sanitizeForLog(`${(e as Error)?.name ?? "Error"}${typeof state === "string" ? ` ${state}` : ""}`) };
  } finally {
    await pool.end().catch(() => {});
  }
}

parentPort!.postMessage(await main());
