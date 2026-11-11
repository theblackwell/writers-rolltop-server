export type StoreErrorCode =
  | "CONFLICT"
  | "NOT_FOUND"
  | "INVARIANT_VIOLATED"
  | "DOCUMENT_INVALID"
  | "SCHEMA_TOO_NEW"
  | "MIGRATION_CHECKSUM_MISMATCH"
  | "MIGRATION_HISTORY_MISMATCH"
  | "MIGRATION_FAILED"
  | "BACKUP_FAILED"
  | "ATTACHMENT_HASH_MISMATCH"
  | "INTEGRITY_FAILED"
  | "LIBRARY_EXISTS";

/** Typed store failure. Messages never carry document text; `details` holds ids and numbers only. */
export class StoreError extends Error {
  readonly code: StoreErrorCode;
  readonly details?: Record<string, unknown>;
  constructor(code: StoreErrorCode, message: string, details?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "StoreError";
    this.code = code;
    this.details = details;
  }
}

/** SQLSTATEs the store treats as a violated invariant (check, unique, foreign key). The server's message is kept: it names constraints, not data. */
const INVARIANT_STATES = new Set(["23514", "23505", "23503"]);
/** 23502 (not null): pg's detail carries the failing row, so the message is fixed and names no data. */

/**
 * Turn a pg error caused by caller input into a StoreError. Class 22 (data exceptions, e.g. 22P02 bad
 * input shape, 22P05 untranslatable character) gets a fixed message because pg echoes the offending value.
 * pg's `detail` and `where` fields are never forwarded. Operational errors (connection, shutdown) pass through.
 */
export function mapPgError(e: unknown): unknown {
  if (e instanceof StoreError) return e;
  const state = (e as { code?: unknown } | null)?.code;
  if (typeof state !== "string") return e;
  if (INVARIANT_STATES.has(state)) {
    const message = String((e as { message?: unknown }).message ?? "constraint violated");
    return new StoreError("INVARIANT_VIOLATED", message, { sqlState: state });
  }
  if (state === "23502") {
    return new StoreError("INVARIANT_VIOLATED", "a required value is missing", { sqlState: state });
  }
  if (state.startsWith("22")) {
    return new StoreError("INVARIANT_VIOLATED", "a value has an invalid form", { sqlState: state });
  }
  return e;
}
