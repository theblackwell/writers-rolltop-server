// Writes a library as a .rolltop ZIP in the canonical layout. Export is atomic: the archive is built
// in a temporary file next to the destination, flushed, read back and fully validated exactly as an
// importer would, compared with the input, and only then renamed over the destination. Until that
// last step an existing destination is untouched; on any failure the temporary file is removed.

import { createHash, randomUUID } from "node:crypto";
import { open, rename, rm, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { normalizeDocument, DocumentError } from "@writers-rolltop/document-adapter/canonical";
import type { CanonicalDocument } from "@writers-rolltop/document-adapter/canonical";
import { ArchiveError, IssueList, ioError, throwIfAborted } from "./errors.ts";
import { stableStringify } from "./json.ts";
import type { Json } from "./json.ts";
import { resolveLimits } from "./limits.ts";
import type { ArchiveLimits } from "./limits.ts";
import { FILE_FIELDS } from "./model.ts";
import type { ArchiveData } from "./model.ts";
import { attachmentPath, CHECKSUMS, DOC_MESSAGE_MAX, MANIFEST, printable } from "./paths.ts";
import { readArchive, SUPPORTED_FORMAT_VERSION, validationError } from "./reader.ts";
import { checkShape } from "./schema.ts";
import { validateArchiveData } from "./validator.ts";
import { writeZip } from "./zip.ts";
import type { ZipFileInput } from "./zip.ts";

export interface WriteOptions {
  generator?: { name: string; version: string };
  /** Fixed values are for tests; by default each export gets a new archive id and the current time. */
  archiveId?: string;
  createdAt?: string;
  limits?: Partial<ArchiveLimits>;
  signal?: AbortSignal;
}

export interface WriteResult {
  destination: string;
  archiveId: string;
  byteLength: number;
  fileCount: number;
}

/** Supplies the bytes of an attachment by SHA-256 (from the attachment store). */
export type AttachmentProvider = (sha256: string) => Promise<Uint8Array>;

const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const bytesOf = (value: unknown): Buffer => Buffer.from(stableStringify(value), "utf8");
const cmpAscii = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

async function writeAll(fh: FileHandle, chunk: Buffer): Promise<void> {
  let done = 0;
  while (done < chunk.length) {
    const { bytesWritten } = await fh.write(chunk, done, chunk.length - done);
    done += bytesWritten;
  }
}

export async function writeArchive(
  data: ArchiveData,
  attachmentBytes: AttachmentProvider,
  destination: string,
  options: WriteOptions = {},
): Promise<WriteResult> {
  const limits = resolveLimits(options.limits);
  const { signal } = options;
  const dest = path.resolve(destination);
  const dir = path.dirname(dest);

  // Normalize documents (writers MUST emit normalized documents), then check shape and integrity.
  const documents = new Map<string, CanonicalDocument>();
  for (const [nodeId, doc] of data.documents) {
    try {
      documents.set(nodeId, normalizeDocument(doc));
    } catch (e) {
      if (e instanceof DocumentError) throw new ArchiveError(e.code === "DOCUMENT_UNSUPPORTED_VERSION" ? "DOCUMENT_UNSUPPORTED_VERSION" : "DOCUMENT_INVALID", `Document ${nodeId} cannot be written: ${printable(e.message, DOC_MESSAGE_MAX)}`, { path: `manuscript/${nodeId}.json`, cause: e });
      throw e;
    }
  }
  const normalized: ArchiveData = { ...data, documents };
  const shape = new IssueList();
  const json = new Map<string, Buffer>();
  for (const [file, field] of FILE_FIELDS) {
    const bytes = bytesOf(normalized[field]);
    json.set(file, bytes);
    checkShape(file, JSON.parse(bytes.toString("utf8")) as Json, shape);
  }
  if (shape.items.length > 0) throw new ArchiveError("SCHEMA_VIOLATION", `${shape.items.length}${shape.truncated ? "+" : ""} shape problem(s). ${shape.items[0]!.message}`, { issues: shape.items, issuesTruncated: shape.truncated });
  const report = validateArchiveData(normalized);
  if (report.errors.length > 0) throw validationError(report.errors, report.errorsTruncated);
  for (const [nodeId, doc] of documents) json.set(`manuscript/${nodeId}.json`, bytesOf(doc));

  // checksums.json lists every file but the manifest and itself, sorted by path.
  const listed: { path: string; byteLength: number; sha256: string }[] = [];
  for (const [p, bytes] of json) listed.push({ path: p, byteLength: bytes.length, sha256: sha256(bytes) });
  for (const a of normalized.attachments) listed.push({ path: attachmentPath(a.sha256, a.extension), byteLength: a.byteLength, sha256: a.sha256 });
  listed.sort((a, b) => cmpAscii(a.path, b.path));
  const checksums = bytesOf({ algorithm: "sha256", files: listed });
  const attachmentByPath = new Map<string, Record<string, any>>();
  for (const a of normalized.attachments) attachmentByPath.set(attachmentPath(a.sha256, a.extension), a);
  const archiveId = options.archiveId ?? randomUUID();
  const manifest = bytesOf({
    ...data.manifestExtra,
    format: "writers-rolltop-archive",
    formatVersion: SUPPORTED_FORMAT_VERSION,
    archiveId,
    libraryId: normalized.library.library.id,
    createdAt: options.createdAt ?? new Date().toISOString(),
    generator: options.generator ?? { name: "@writers-rolltop/archive", version: "0.0.0" },
    checksums: { path: CHECKSUMS, byteLength: checksums.length, sha256: sha256(checksums) },
  });

  let dirStat;
  try { dirStat = await stat(dir); } catch (e) { throw new ArchiveError("ARCHIVE_IO_ERROR", `The folder ${dir} does not exist`, { cause: e }); }
  if (!dirStat.isDirectory()) throw new ArchiveError("ARCHIVE_IO_ERROR", `${dir} is not a folder`);
  const existing = await stat(dest).catch(() => undefined);
  if (existing?.isDirectory()) throw new ArchiveError("ARCHIVE_IO_ERROR", `${dest} is a folder, not an archive file`);

  const partial = path.join(dir, `.${path.basename(dest)}.partial-${randomUUID()}`);
  try {
    // 0600: the export may hold unpublished manuscripts. The mode stays through the rename.
    let fh: FileHandle;
    try { fh = await open(partial, "wx", 0o600); } catch (e) { throw ioError("Cannot create the export file", e); }
    let result: { bytes: number; entries: number };
    try {
      async function* entries(): AsyncGenerator<ZipFileInput> {
        yield { name: MANIFEST, data: manifest };
        yield { name: CHECKSUMS, data: checksums };
        for (const f of listed) {
          throwIfAborted(signal, "The export");
          const info = attachmentByPath.get(f.path);
          if (!info) { yield { name: f.path, data: json.get(f.path)! }; continue; }
          let bytes: Buffer;
          try {
            const got = await attachmentBytes(info.sha256);
            bytes = Buffer.from(got.buffer, got.byteOffset, got.byteLength);
          } catch (e) {
            throw new ArchiveError("ARCHIVE_MISSING_FILE", `The bytes of attachment ${info.sha256} are not available: ${(e as Error).message}`, { path: f.path, cause: e });
          }
          if (bytes.length !== info.byteLength || sha256(bytes) !== info.sha256) {
            throw new ArchiveError("ARCHIVE_CHECKSUM_MISMATCH", `The stored bytes of attachment ${info.sha256} do not match its hash or length; the export was abandoned`, { path: f.path });
          }
          yield { name: f.path, data: bytes, store: true };
        }
      }
      const sink = { write: async (chunk: Buffer): Promise<void> => { try { await writeAll(fh, chunk); } catch (e) { throw ioError("Writing the export failed", e); } } };
      result = await writeZip(entries(), sink, limits, signal);
      try { await fh.sync(); } catch (e) { throw ioError("Flushing the export failed", e); }
    } finally {
      await fh.close().catch(() => {}); // a failed close of a file being discarded or already synced adds nothing
    }

    // Read the finished file back exactly as an importer would, and compare.
    const back = await readArchive(partial, { limits: options.limits, ...(signal ? { signal } : {}) });
    try {
      for (const [, field] of FILE_FIELDS) {
        if (stableStringify(back.data[field]) !== stableStringify(normalized[field])) {
          throw new ArchiveError("ARCHIVE_CORRUPT", `The archive that was just written does not read back to the same ${field}; the export was abandoned`);
        }
      }
      if (back.data.documents.size !== documents.size) throw new ArchiveError("ARCHIVE_CORRUPT", "The archive that was just written does not read back to the same documents; the export was abandoned");
      for (const [nodeId, doc] of documents) {
        if (stableStringify(back.data.documents.get(nodeId)) !== stableStringify(doc)) {
          throw new ArchiveError("ARCHIVE_CORRUPT", `The archive that was just written does not read back to the same document ${nodeId}; the export was abandoned`);
        }
      }
    } finally {
      await back.close().catch(() => {}); // a failed close must not replace the read-back error; the file is verified by the comparison above
    }
    throwIfAborted(signal, "The export");
    try {
      await rename(partial, dest);
    } catch (e) {
      throw new ArchiveError("ARCHIVE_IO_ERROR", `Moving the finished archive into place failed: ${(e as Error).message}`, { cause: e });
    }
    await syncDirectory(dir);
    return { destination: dest, archiveId, byteLength: result.bytes, fileCount: result.entries };
  } finally {
    await rm(partial, { force: true }).catch(() => {}); // best effort; must not hide the original error
  }
}

/** Best effort: makes the rename itself durable. */
export async function syncDirectory(dir: string): Promise<void> {
  try {
    const fh = await open(dir, "r");
    try { await fh.sync(); } finally { await fh.close(); }
  } catch {
    // Not every platform can fsync a directory.
  }
}
