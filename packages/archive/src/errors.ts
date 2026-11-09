// Error codes of archive-format-v1.md ("Reader safety requirements") plus two operational codes
// that are not part of the format (ARCHIVE_CANCELLED, ARCHIVE_IO_ERROR).

export type ArchiveErrorCode =
  | "ARCHIVE_TOO_LARGE"
  | "ARCHIVE_CORRUPT"
  | "ARCHIVE_PATH_TRAVERSAL"
  | "ARCHIVE_SYMLINK"
  | "ARCHIVE_DUPLICATE_PATH"
  | "ARCHIVE_UNEXPECTED_FILE"
  | "ARCHIVE_MISSING_FILE"
  | "ARCHIVE_CHECKSUM_MISMATCH"
  | "ARCHIVE_INVALID_UTF8"
  | "ARCHIVE_INVALID_JSON"
  | "ARCHIVE_NOT_ROLLTOP"
  | "ARCHIVE_UNSUPPORTED_VERSION"
  | "SCHEMA_VIOLATION"
  | "REFERENCE_UNRESOLVED"
  | "INTEGRITY_VIOLATION"
  | "DOCUMENT_INVALID"
  | "DOCUMENT_UNSUPPORTED_VERSION"
  | "ARCHIVE_CANCELLED"
  | "ARCHIVE_IO_ERROR"
  | "ARCHIVE_ALREADY_EXISTS";

/** One validator finding (error or warning). */
export interface Issue {
  code: string;
  message: string;
  /** The record the issue is about, when there is one. */
  recordId?: string;
  /** Set when a warning holds only in one book. */
  bookId?: string;
}

/** The most problems any one report lists. A hostile archive could otherwise make the list as big as the archive. */
export const MAX_ISSUES = 100;

/** Collects issues up to MAX_ISSUES and remembers that more were left out. */
export class IssueList {
  readonly items: Issue[] = [];
  /** True when at least one more problem may exist than the list holds. */
  truncated = false;
  get full(): boolean { return this.items.length >= MAX_ISSUES; }
  add(issue: Issue): void {
    if (this.full) this.truncated = true;
    else this.items.push(issue);
  }
}

export class ArchiveError extends Error {
  readonly code: ArchiveErrorCode;
  /** The archive entry or file the problem is about. */
  readonly path?: string;
  /** For validation failures: every problem found. */
  readonly issues: Issue[];
  /** True when `issues` holds only the first MAX_ISSUES problems. */
  readonly issuesTruncated: boolean;
  constructor(code: ArchiveErrorCode, message: string, options: { path?: string; issues?: Issue[]; issuesTruncated?: boolean; cause?: unknown } = {}) {
    super(`${code}: ${message}${options.path === undefined ? "" : ` (${options.path})`}`, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ArchiveError";
    this.code = code;
    if (options.path !== undefined) this.path = options.path;
    this.issues = options.issues ?? [];
    this.issuesTruncated = options.issuesTruncated ?? false;
  }
}

/** Wraps a raw file system error as ARCHIVE_IO_ERROR; an ArchiveError passes through unchanged. */
export function ioError(what: string, e: unknown): ArchiveError {
  if (e instanceof ArchiveError) return e;
  return new ArchiveError("ARCHIVE_IO_ERROR", `${what}: ${(e as Error)?.message ?? String(e)}`, { cause: e });
}

export function throwIfAborted(signal: AbortSignal | undefined, what: string): void {
  if (signal?.aborted) throw new ArchiveError("ARCHIVE_CANCELLED", `${what} was cancelled`);
}
