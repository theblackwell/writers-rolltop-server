import { Worker } from "node:worker_threads";
import type { ArchiveLimits } from "@writers-rolltop/archive";
import { ApiError, fromArchiveCode } from "./api-errors.ts";
import type { PublicIssue } from "./api-errors.ts";
import type { WorkerInput, WorkerResult } from "./import-worker.ts";

export interface ImportConfig {
  databaseUrl: string;
  attachmentsDir: string;
  /** Wall-clock budget for one import (reading, validating and loading). The worker is terminated when it runs out. */
  timeoutMs: number;
  /** Heap cap of the worker (V8 old generation), in MiB. */
  maxHeapMb: number;
  limits?: Partial<ArchiveLimits>;
  /** Database-side limits for the worker's connection. Defaults: statement = the time budget, lock wait 10 s, idle in transaction 60 s. */
  dbTimeouts?: { lockMs?: number; idleInTransactionMs?: number };
  /** Test seam. */
  fault?: WorkerInput["fault"];
}

export interface ImportOutcome {
  summary: unknown;
  warnings: PublicIssue[];
}

const WORKER_FILE = new URL("./import-worker.ts", import.meta.url);

export function runImport(bytes: Buffer, config: ImportConfig): Promise<ImportOutcome> {
  // Hand the bytes over without a copy when the Buffer owns its whole ArrayBuffer.
  const owns = bytes.byteOffset === 0 && bytes.buffer.byteLength === bytes.length && bytes.buffer instanceof ArrayBuffer;
  const data = owns ? new Uint8Array(bytes.buffer, 0, bytes.length) : new Uint8Array(bytes);
  const workerData: WorkerInput = {
    bytes: data, databaseUrl: config.databaseUrl, attachmentsDir: config.attachmentsDir,
    dbTimeouts: { statementMs: config.timeoutMs, lockMs: config.dbTimeouts?.lockMs ?? 10_000, idleInTransactionMs: config.dbTimeouts?.idleInTransactionMs ?? 60_000 },
    ...(config.limits ? { limits: config.limits } : {}), ...(config.fault ? { fault: config.fault } : {}),
  };
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_FILE, {
      workerData,
      transferList: [data.buffer as ArrayBuffer],
      resourceLimits: { maxOldGenerationSizeMb: config.maxHeapMb, maxYoungGenerationSizeMb: 64, stackSizeMb: 4 },
      stdout: true, stderr: true, // keep worker output out of the server's streams
    });
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Settle only after the worker has really stopped, so its database connection is closed before the caller
      // (and the import slot) moves on.
      void worker.terminate().catch(() => {}).then(fn);
    };
    const timer = setTimeout(() => finish(() => reject(new ApiError(422, "IMPORT_TIMEOUT",
      "The archive took too long to process.", { logMessage: `import exceeded ${config.timeoutMs} ms` }))), config.timeoutMs);
    worker.on("message", (m: WorkerResult) => finish(() => {
      if (m.ok) return resolve({ summary: m.summary, warnings: m.warnings });
      if (m.kind === "archive") return reject(fromArchiveCode(m.code, { issues: m.issues, issuesTruncated: m.issuesTruncated, logMessage: m.logMessage }));
      if (m.kind === "store" && m.code === "LIBRARY_EXISTS") {
        return reject(new ApiError(409, "LIBRARY_EXISTS", "This server already holds a library. Import is only allowed into an empty server.", { logMessage: m.logMessage }));
      }
      if (m.kind === "store" && m.code === "INVARIANT_VIOLATED") {
        return reject(new ApiError(422, "INTEGRITY_VIOLATION", "The archive holds a value this server cannot store.", { logMessage: m.logMessage }));
      }
      reject(new ApiError(500, "INTERNAL_ERROR", "The server could not complete the request.", { logMessage: `${m.kind} ${m.code}: ${m.logMessage}` }));
    }));
    worker.on("error", (e: Error & { code?: string }) => finish(() => {
      if (e.code === "ERR_WORKER_OUT_OF_MEMORY") {
        return reject(new ApiError(422, "IMPORT_MEMORY_EXCEEDED", "The archive needs more memory than an import may use.", { logMessage: `worker heap cap ${config.maxHeapMb} MiB reached` }));
      }
      reject(new ApiError(500, "INTERNAL_ERROR", "The server could not complete the request.", { logMessage: `worker error ${e.code ?? e.name}` }));
    }));
    worker.on("exit", (code) => finish(() => reject(new ApiError(500, "INTERNAL_ERROR", "The server could not complete the request.", { logMessage: `worker exited with ${code}` }))));
  });
}
