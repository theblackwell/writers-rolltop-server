// The API's error contract: a stable code and a fixed, generic message. Messages are never built from
// archive content, database errors, or file system paths. Logs carry only the code, a sanitised message
// and the validator issues, never a cause object.

export interface PublicIssue { code: string; recordId?: string; bookId?: string }

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues?: PublicIssue[];
  readonly issuesTruncated?: boolean;
  /** For the log only: a sanitised, bounded description of the real cause. */
  readonly logMessage?: string;
  /** Extra response headers (for example Retry-After). */
  readonly headers?: Record<string, string>;
  constructor(status: number, code: string, message: string, extra: { issues?: PublicIssue[]; issuesTruncated?: boolean; logMessage?: string; headers?: Record<string, string> } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.issues = extra.issues;
    this.issuesTruncated = extra.issuesTruncated;
    this.logMessage = extra.logMessage;
    this.headers = extra.headers;
  }
}

/** Control characters, bidi overrides and anything non-printable become "?", and the text is cut at `max`. */
export function sanitizeForLog(s: unknown, max = 300): string {
  const text = String(s ?? "").slice(0, max * 2);
  return text.replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/gu, "?").slice(0, max);
}

const ARCHIVE_MESSAGES: Record<string, [number, string]> = {
  ARCHIVE_TOO_LARGE: [413, "The archive is larger than this server accepts."],
  ARCHIVE_CORRUPT: [422, "The archive is damaged."],
  ARCHIVE_PATH_TRAVERSAL: [422, "The archive contains a file name that is not allowed."],
  ARCHIVE_SYMLINK: [422, "The archive contains an entry that is not a plain file."],
  ARCHIVE_DUPLICATE_PATH: [422, "The archive lists the same file twice."],
  ARCHIVE_UNEXPECTED_FILE: [422, "The archive contains a file that is not part of the format."],
  ARCHIVE_MISSING_FILE: [422, "The archive is missing a required file."],
  ARCHIVE_CHECKSUM_MISMATCH: [422, "A file in the archive does not match its checksum."],
  ARCHIVE_INVALID_UTF8: [422, "A file in the archive is not valid UTF-8."],
  ARCHIVE_INVALID_JSON: [422, "A file in the archive is not valid JSON."],
  ARCHIVE_NOT_ROLLTOP: [422, "This is not a Writers Rolltop archive."],
  ARCHIVE_UNSUPPORTED_VERSION: [422, "The archive was written by a newer version of Writers Rolltop; update the server to open it."],
  SCHEMA_VIOLATION: [422, "The archive does not follow the archive format."],
  REFERENCE_UNRESOLVED: [422, "The archive refers to a record that is not in it."],
  INTEGRITY_VIOLATION: [422, "The archive breaks a rule of the archive format."],
  DOCUMENT_INVALID: [422, "A manuscript document in the archive is invalid."],
  DOCUMENT_UNSUPPORTED_VERSION: [422, "A manuscript document was written by a newer version of Writers Rolltop."],
};

/** Map an archive-reader code to the public error. Operational codes (I/O, cancelled) are not the client's fault. */
export function fromArchiveCode(code: string, extra: { issues?: PublicIssue[]; issuesTruncated?: boolean; logMessage?: string }): ApiError {
  const known = ARCHIVE_MESSAGES[code];
  if (!known) return new ApiError(500, "INTERNAL_ERROR", "The server could not complete the request.", { ...extra, logMessage: extra.logMessage ?? code });
  return new ApiError(known[0], code, known[1], extra);
}

export const publicBody = (e: ApiError) => ({
  error: {
    code: e.code,
    message: e.message,
    ...(e.issues && e.issues.length > 0 ? { issues: e.issues, issuesTruncated: e.issuesTruncated === true } : {}),
  },
});
