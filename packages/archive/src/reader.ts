// Reads and validates a .rolltop archive. Order of checks (archive-format-v1.md, "Import semantics"):
// container, checksums, JSON, schema, integrity, documents. Every size limit is applied to the
// bytes actually produced, and a bad archive is refused before anything is written anywhere.

import { createHash } from "node:crypto";
import { normalizeDocument, DocumentError } from "@writers-rolltop/document-adapter/canonical";
import type { CanonicalDocument } from "@writers-rolltop/document-adapter/canonical";
import { ArchiveError, IssueList, throwIfAborted } from "./errors.ts";
import type { Issue } from "./errors.ts";
import { decodeUtf8, JsonSyntaxError, JsonValueError, parseJson } from "./json.ts";
import type { Json, JsonObject } from "./json.ts";
import { resolveLimits } from "./limits.ts";
import type { ArchiveLimits } from "./limits.ts";
import { FILE_FIELDS } from "./model.ts";
import type { ArchiveData, ArchiveSummary, Rec } from "./model.ts";
import { attachmentParts, attachmentPath, CHECKSUMS, isAllowedFile, isAttachmentPath, MANIFEST, manuscriptNodeId, DOC_MESSAGE_MAX, printable, REQUIRED_FILES, syntaxProblem } from "./paths.ts";
import { checkShape } from "./schema.ts";
import { validateArchiveData } from "./validator.ts";
import { countWords } from "./words.ts";
import { bufferSource, checkNoOverlap, fileSource, readCentralDirectory, readEntry } from "./zip.ts";
import type { ByteSource, ZipDirectory, ZipEntry } from "./zip.ts";

export const SUPPORTED_FORMAT_VERSION = 1;

export interface ReadOptions {
  limits?: Partial<ArchiveLimits>;
  signal?: AbortSignal;
  /**
   * Called with the verified bytes of every file (manifest, checksums, JSON, documents and attachments)
   * right after its length and hash were checked, and before the archive as a whole is validated.
   * It is how the staged importer fills its private staging folder. If validation later fails the
   * caller must discard what it wrote.
   */
  onFile?: (path: string, bytes: Buffer) => Promise<void>;
}

export interface AttachmentFile {
  sha256: string;
  byteLength: number;
  /** The archive path of the file. */
  path: string;
  /** Reads the bytes again from the archive and checks length and hash. Needs the archive to be open (see `close`). */
  read(): Promise<Buffer>;
}

export interface ArchiveContents {
  manifest: JsonObject;
  data: ArchiveData;
  /** Advisory warnings (W_*). They never block an import. */
  warnings: Issue[];
  summary: ArchiveSummary;
  /** sha256 -> file in the archive. */
  attachments: Map<string, AttachmentFile>;
  /** Releases the archive file. Attachment `read()` stops working. Safe to call twice. */
  close(): Promise<void>;
}

export type ArchiveInput = string | Uint8Array;

/** Reads an archive from a file path or from bytes. The result must be closed. Throws ArchiveError. */
export async function readArchive(input: ArchiveInput, options: ReadOptions = {}): Promise<ArchiveContents> {
  const src = typeof input === "string" ? await fileSource(input) : bufferSource(input);
  try {
    const contents = await readFrom(src, options);
    return contents;
  } catch (e) {
    await src.close().catch(() => {});
    // A read outside the file (a header that lies about where data is) is reported as ARCHIVE_CORRUPT by
    // the byte sources themselves. Any other error, a RangeError included, is a bug and is not relabelled.
    throw e;
  }
}

const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

interface Item { entry: ZipEntry; path: string }

async function readFrom(src: ByteSource, options: ReadOptions): Promise<ArchiveContents> {
  const limits = resolveLimits(options.limits);
  const { signal } = options;
  const dir = await readCentralDirectory(src, limits);
  const files = checkContainer(dir, limits);
  await checkNoOverlap(src, files.map((f) => f.entry), dir, signal);
  const byPath = new Map<string, Item>(files.map((f) => [f.path, f]));
  const required = (path: string): Item => {
    const item = byPath.get(path);
    if (!item) throw new ArchiveError("ARCHIVE_MISSING_FILE", `The archive has no ${path}`, { path });
    return item;
  };
  for (const path of REQUIRED_FILES) required(path);

  let total = 0;
  let jsonTotal = 0;
  const extract = async (item: Item): Promise<Buffer> => {
    throwIfAborted(signal, "Reading the archive");
    const bytes = await readEntry(src, item.entry, dir);
    const isJson = !isAttachmentPath(item.path);
    const cap = isJson ? limits.maxJSONBytes : limits.maxAttachmentBytes;
    total += bytes.length;
    if (isJson) jsonTotal += bytes.length;
    if (bytes.length > cap) throw new ArchiveError("ARCHIVE_TOO_LARGE", `${item.path} expands beyond ${cap} bytes`, { path: item.path });
    if (jsonTotal > limits.maxTotalJSONBytes) throw new ArchiveError("ARCHIVE_TOO_LARGE", `The JSON files together expand beyond ${limits.maxTotalJSONBytes} bytes`, { path: item.path });
    if (total > limits.maxTotalBytes) throw new ArchiveError("ARCHIVE_TOO_LARGE", `The archive expands beyond ${limits.maxTotalBytes} bytes`);
    return bytes;
  };

  // Manifest first: a file that is not a Rolltop archive, or a newer one, is named as such.
  const manifestBytes = await extract(required(MANIFEST));
  const manifestValue = parseFile(manifestBytes, MANIFEST);
  checkManifestIdentity(manifestValue);
  requireShape(MANIFEST, manifestValue);
  const manifest = manifestValue as JsonObject;
  await options.onFile?.(MANIFEST, manifestBytes);

  // checksums.json is pinned by the manifest, then lists every other file.
  const checksumsBytes = await extract(required(CHECKSUMS));
  const pin = manifest.checksums as JsonObject;
  if (checksumsBytes.length !== pin.byteLength || sha256(checksumsBytes) !== pin.sha256) {
    throw new ArchiveError("ARCHIVE_CHECKSUM_MISMATCH", "checksums.json does not match the hash pinned in manifest.json", { path: CHECKSUMS });
  }
  const checksumsValue = parseFile(checksumsBytes, CHECKSUMS);
  requireShape(CHECKSUMS, checksumsValue);
  await options.onFile?.(CHECKSUMS, checksumsBytes);
  const listed = new Map<string, { byteLength: number; sha256: string }>();
  for (const f of (checksumsValue as JsonObject).files as JsonObject[]) {
    const path = f.path as string;
    if (path === MANIFEST || path === CHECKSUMS) throw new ArchiveError("SCHEMA_VIOLATION", `checksums.json must not list ${path}`, { path: CHECKSUMS });
    if (listed.has(path)) throw new ArchiveError("ARCHIVE_DUPLICATE_PATH", `checksums.json lists ${printable(path)} twice`, { path: printable(path) });
    listed.set(path, { byteLength: f.byteLength as number, sha256: f.sha256 as string });
  }
  const present = files.map((f) => f.path).filter((p) => p !== MANIFEST && p !== CHECKSUMS).sort();
  const missing = [...listed.keys()].filter((p) => !byPath.has(p)).sort()[0];
  if (missing !== undefined) throw new ArchiveError("ARCHIVE_MISSING_FILE", `checksums.json lists ${printable(missing)}, which the archive does not contain`, { path: printable(missing) });
  const extra = present.filter((p) => !listed.has(p))[0];
  if (extra !== undefined) throw new ArchiveError("ARCHIVE_UNEXPECTED_FILE", `${extra} is in the archive but not listed in checksums.json`, { path: extra });

  // Extract the rest, verifying each file against its listed length and hash.
  const json = new Map<string, Buffer>();
  const attachmentFiles = new Map<string, { path: string; sha256: string; byteLength: number; item: Item }>();
  for (const path of present) {
    const item = byPath.get(path)!;
    const want = listed.get(path)!;
    const bytes = await extract(item);
    if (bytes.length !== want.byteLength || sha256(bytes) !== want.sha256) {
      throw new ArchiveError("ARCHIVE_CHECKSUM_MISMATCH", `${path} does not match its entry in checksums.json`, { path });
    }
    const parts = attachmentParts(path);
    if (parts) {
      if (parts.sha256 !== want.sha256) throw new ArchiveError("ARCHIVE_CHECKSUM_MISMATCH", `The bytes of ${path} do not hash to the name they are stored under`, { path });
      attachmentFiles.set(path, { path, sha256: parts.sha256, byteLength: bytes.length, item });
    } else json.set(path, bytes);
    await options.onFile?.(path, bytes);
  }
  throwIfAborted(signal, "Reading the archive");

  // JSON stage, then shape stage. Documents are only checked for UTF-8 and JSON here.
  const parsed = new Map<string, Json>();
  for (const path of [...json.keys()].sort()) {
    if (manuscriptNodeId(path) !== undefined) { parseFile(json.get(path)!, path, true); continue; }
    parsed.set(path, parseFile(json.get(path)!, path));
  }
  const shape = new IssueList();
  for (const path of [...parsed.keys()].sort()) { checkShape(path, parsed.get(path)!, shape); if (shape.full) break; }
  if (shape.items.length > 0) {
    throw new ArchiveError("SCHEMA_VIOLATION", `${shape.items.length}${shape.truncated ? "+" : ""} shape problem(s). ${shape.items[0]!.message}`, { issues: shape.items, issuesTruncated: shape.truncated });
  }

  // Precedence of the stages after the shape check: documents are decoded first (DOCUMENT_INVALID,
  // DOCUMENT_UNSUPPORTED_VERSION), then a missing document file, attachment files, the library id,
  // and last the integrity and reference rules of the validator. So a bad document wins over a broken
  // reference. Documents come first because the validator's anchor warning needs the decoded documents.
  const data = assemble(manifest, parsed);
  data.documents = decodeDocuments(json);
  for (const n of data.library.manuscriptNodes as Rec[]) {
    if (["scene", "frontMatter", "backMatter"].includes(n.kind) && !data.documents.has(n.id)) {
      throw new ArchiveError("ARCHIVE_MISSING_FILE", `The archive has no document for ${n.kind} ${n.id}`, { path: `manuscript/${n.id}.json` });
    }
  }
  checkAttachmentFiles(data.attachments, attachmentFiles);
  if (manifest.libraryId !== data.library.library.id) {
    throw new ArchiveError("INTEGRITY_VIOLATION", `manifest.json names library ${String(manifest.libraryId)}, but library.json holds ${String(data.library.library.id)}`, { path: MANIFEST });
  }

  const report = validateArchiveData(data);
  if (report.errors.length > 0) throw validationError(report.errors, report.errorsTruncated);

  const attachments = new Map<string, AttachmentFile>();
  for (const f of attachmentFiles.values()) {
    attachments.set(f.sha256, {
      sha256: f.sha256,
      byteLength: f.byteLength,
      path: f.path,
      async read() {
        const bytes = await readEntry(src, f.item.entry, dir);
        if (bytes.length !== f.byteLength || sha256(bytes) !== f.sha256) throw new ArchiveError("ARCHIVE_CHECKSUM_MISMATCH", `${f.path} no longer matches its hash`, { path: f.path });
        return bytes;
      },
    });
  }
  let closed = false;
  return {
    manifest, data, warnings: report.warnings, summary: summarize(data), attachments,
    async close() { if (!closed) { closed = true; await src.close(); } },
  };
}

// ---- container checks ----

/** Whole-container checks, run over every entry so the error does not depend on entry order. */
function checkContainer(dir: ZipDirectory, limits: ArchiveLimits): Item[] {
  const entries = dir.entries;
  for (const e of entries) {
    const problem = syntaxProblem(e.name, e.isDirectory);
    if (problem) throw new ArchiveError("ARCHIVE_PATH_TRAVERSAL", `Entry "${printable(e.name)}" is refused: ${problem}`, { path: printable(e.name) });
  }
  for (const e of entries) {
    if (e.kind === "other") throw new ArchiveError("ARCHIVE_SYMLINK", `Entry ${printable(e.name)} is a symbolic link or other special file; archives may only hold plain files`, { path: printable(e.name) });
  }
  const seen = new Set<string>();
  for (const e of entries) {
    const key = (e.isDirectory ? e.name.slice(0, -1) : e.name).toLowerCase();
    if (seen.has(key)) throw new ArchiveError("ARCHIVE_DUPLICATE_PATH", `The path ${printable(e.name)} appears more than once (paths compare without regard to case)`, { path: printable(e.name) });
    seen.add(key);
  }
  // Directory entries are ignored (they hold no data and nothing is created from them).
  const files = entries.filter((e) => !e.isDirectory);
  for (const e of files) {
    if (!isAllowedFile(e.name)) throw new ArchiveError("ARCHIVE_UNEXPECTED_FILE", `${printable(e.name)} is not part of the archive format`, { path: printable(e.name) });
  }
  // Declared sizes: the first line of defence, from the headers. The same limits are applied again to the bytes produced.
  let total = 0;
  let jsonTotal = 0;
  for (const e of files) {
    const isJson = !isAttachmentPath(e.name);
    const cap = isJson ? limits.maxJSONBytes : limits.maxAttachmentBytes;
    if (e.uncompressedSize > cap) throw new ArchiveError("ARCHIVE_TOO_LARGE", `${e.name} is ${e.uncompressedSize} bytes; the limit is ${cap}`, { path: e.name });
    if (e.uncompressedSize > limits.ratioThresholdBytes && e.uncompressedSize > limits.maxCompressionRatio * Math.max(e.compressedSize, 1)) {
      throw new ArchiveError("ARCHIVE_TOO_LARGE", `${e.name} expands more than ${limits.maxCompressionRatio}:1`, { path: e.name });
    }
    if (isJson) {
      jsonTotal += e.uncompressedSize;
      if (jsonTotal > limits.maxTotalJSONBytes) throw new ArchiveError("ARCHIVE_TOO_LARGE", `The JSON files together exceed ${limits.maxTotalJSONBytes} bytes`, { path: e.name });
    }
    total += e.uncompressedSize;
    if (total > limits.maxTotalBytes) throw new ArchiveError("ARCHIVE_TOO_LARGE", `The archive expands to more than ${limits.maxTotalBytes} bytes`);
  }
  return files.map((entry) => ({ entry, path: entry.name }));
}

// ---- JSON ----

/** UTF-8, no BOM, strict JSON. A manuscript document is only checked for well-formedness (`isDocument`). */
function parseFile(bytes: Buffer, path: string, isDocument = false): Json {
  const text = decodeUtf8(bytes);
  if (text === undefined) throw new ArchiveError("ARCHIVE_INVALID_UTF8", `${path} is not valid UTF-8`, { path });
  if (text.charCodeAt(0) === 0xfeff) throw new ArchiveError("ARCHIVE_INVALID_JSON", `${path} starts with a byte order mark; archive JSON is UTF-8 without one`, { path });
  try {
    return parseJson(text);
  } catch (e) {
    if (e instanceof JsonSyntaxError) throw new ArchiveError("ARCHIVE_INVALID_JSON", `${path} is not valid JSON: ${e.message}`, { path, cause: e });
    // null and out-of-range numbers: the document decoder reports them for documents.
    if (e instanceof JsonValueError && !isDocument) throw new ArchiveError("SCHEMA_VIOLATION", `${path}: ${e.message}`, { path, issues: [{ code: "SCHEMA_VIOLATION", message: `${path}: ${e.message}` }] });
    if (e instanceof JsonValueError) return null;
    throw e;
  }
}

function requireShape(path: string, value: Json): void {
  const found = checkShape(path, value);
  if (found.items.length > 0) throw new ArchiveError("SCHEMA_VIOLATION", `${found.items.length}${found.truncated ? "+" : ""} shape problem(s). ${found.items[0]!.message}`, { path, issues: found.items, issuesTruncated: found.truncated });
}

function checkManifestIdentity(value: Json): void {
  if (typeof value !== "object" || value === null || Array.isArray(value) || value.format !== "writers-rolltop-archive") {
    throw new ArchiveError("ARCHIVE_NOT_ROLLTOP", "manifest.json does not name the format writers-rolltop-archive", { path: MANIFEST });
  }
  const v = value.formatVersion;
  if (typeof v === "number" && Number.isInteger(v) && v > SUPPORTED_FORMAT_VERSION) {
    throw new ArchiveError("ARCHIVE_UNSUPPORTED_VERSION", `This archive is format version ${v}; this server reads up to version ${SUPPORTED_FORMAT_VERSION}. Update the server to open it.`, { path: MANIFEST });
  }
  // A missing or mistyped version is reported by the shape check.
}

function assemble(manifest: JsonObject, parsed: Map<string, Json>): ArchiveData {
  const known = new Set(["format", "formatVersion", "archiveId", "libraryId", "createdAt", "generator", "checksums"]);
  const manifestExtra: { [key: string]: Json } = {};
  // defineProperty, not assignment: an own "__proto__" key must stay a plain property (assignment would set the prototype and lose the key).
  for (const [k, v] of Object.entries(manifest)) {
    if (!known.has(k)) Object.defineProperty(manifestExtra, k, { value: v, enumerable: true, writable: true, configurable: true });
  }
  const data: Record<string, unknown> = { manifestExtra, documents: new Map() };
  for (const [path, field] of FILE_FIELDS) data[field] = parsed.get(path);
  return data as unknown as ArchiveData;
}

function decodeDocuments(json: Map<string, Buffer>): Map<string, CanonicalDocument> {
  const docs = new Map<string, CanonicalDocument>();
  for (const path of [...json.keys()].sort()) {
    const nodeId = manuscriptNodeId(path);
    if (nodeId === undefined) continue;
    let value: Json;
    try {
      value = parseJson(decodeUtf8(json.get(path)!)!);
    } catch (e) {
      if (e instanceof JsonValueError) throw new ArchiveError("DOCUMENT_INVALID", `Document ${nodeId}: ${e.message}`, { path });
      throw e;
    }
    try {
      docs.set(nodeId, normalizeDocument(value));
    } catch (e) {
      if (e instanceof DocumentError) {
        throw new ArchiveError(e.code === "DOCUMENT_UNSUPPORTED_VERSION" ? "DOCUMENT_UNSUPPORTED_VERSION" : "DOCUMENT_INVALID", `Document ${nodeId}: ${printable(e.message, DOC_MESSAGE_MAX)}`, { path, cause: e });
      }
      throw e;
    }
  }
  return docs;
}

/** Each attachments.json entry has exactly one file, named by hash and extension; there are no other attachment files. */
function checkAttachmentFiles(infos: Rec[], files: Map<string, { sha256: string; byteLength: number }>): void {
  const expected = new Set<string>();
  for (const info of infos) {
    const path = attachmentPath(info.sha256, info.extension);
    expected.add(path);
    const file = files.get(path);
    if (!file) throw new ArchiveError("ARCHIVE_MISSING_FILE", `attachments.json lists ${path}, which the archive does not contain`, { path });
    if (file.sha256 !== info.sha256 || file.byteLength !== info.byteLength) throw new ArchiveError("ARCHIVE_CHECKSUM_MISMATCH", `${path} does not match its entry in attachments.json`, { path });
  }
  const extra = [...files.keys()].filter((p) => !expected.has(p)).sort()[0];
  if (extra !== undefined) throw new ArchiveError("ARCHIVE_UNEXPECTED_FILE", `${extra} is not described by attachments.json`, { path: extra });
}

const ERROR_PRIORITY = ["SCHEMA_VIOLATION", "REFERENCE_UNRESOLVED", "INTEGRITY_VIOLATION"] as const;
/** One ArchiveError for a failed validation: schema problems first, then unresolved references, then integrity. */
export function validationError(errors: Issue[], truncated = false): ArchiveError {
  const codes = new Set(errors.map((e) => e.code));
  const code = ERROR_PRIORITY.find((c) => codes.has(c)) ?? "INTEGRITY_VIOLATION";
  const first = errors.filter((e) => e.code === code).slice(0, 3).map((e) => e.message).join("; ");
  return new ArchiveError(code, `${errors.length}${truncated ? "+" : ""} problem(s). ${first}`, { issues: errors, issuesTruncated: truncated });
}

export function summarize(data: ArchiveData): ArchiveSummary {
  let words = 0;
  for (const doc of data.documents.values()) words += countWords(doc);
  const lib = data.library;
  return {
    libraryId: lib.library.id,
    title: lib.library.title,
    universes: lib.universes.length,
    series: lib.series.length,
    books: lib.books.length,
    manuscriptNodes: lib.manuscriptNodes.length,
    documents: data.documents.size,
    words,
    entries: data.entries.length,
    attachments: data.attachments.length,
    facts: data.facts.length,
    questions: data.questions.length,
    events: data.events.length,
    notes: data.notes.length,
  };
}
