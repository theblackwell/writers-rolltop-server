import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type pg from "pg";
import { StoreError, mapPgError } from "./errors.ts";

const SHA256 = /^[0-9a-f]{64}$/;

export interface AttachmentInput {
  mediaType: string;
  originalName?: string;
  extension?: string;
  createdAt: Date;
}

export interface AttachmentRecord {
  sha256: string;
  byteLength: number;
  mediaType: string;
  originalName: string | null;
  extension: string | null;
}

/** Reject anything that is not 64 lowercase hex characters before it can reach a file path. */
export function assertSha256(sha256: string): void {
  if (typeof sha256 !== "string" || !SHA256.test(sha256)) {
    throw new StoreError("INVARIANT_VIOLATED", "sha256 must be 64 lowercase hex characters");
  }
}

const hashBytes = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export async function hashFile(path: string): Promise<{ sha256: string; byteLength: number }> {
  const hash = createHash("sha256");
  let byteLength = 0;
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
    hash.update(chunk);
    byteLength += chunk.length;
  }
  return { sha256: hash.digest("hex"), byteLength };
}

export const attachmentPath = (dir: string, sha256: string): string => {
  assertSha256(sha256);
  return join(dir, sha256);
};

async function fsyncDir(dir: string): Promise<void> {
  try {
    const h = await open(dir, "r");
    try { await h.sync(); } finally { await h.close(); }
  } catch { /* directory fsync is best effort (not supported everywhere) */ }
}

const TEMP_NAME = /^[0-9a-f]{64}\.tmp-[0-9a-f-]{36}$/;

/**
 * Write the bytes to `<dir>/<sha256>` if no such file exists. An existing file is hashed and must match;
 * it is never overwritten. `created` is true only if this call made the file.
 */
export async function writeAttachmentFile(dir: string, bytes: Uint8Array): Promise<{ sha256: string; created: boolean }> {
  const sha256 = hashBytes(bytes);
  const path = attachmentPath(dir, sha256);
  await mkdir(dir, { recursive: true });
  let exists = true;
  try { await stat(path); } catch { exists = false; }
  if (exists) {
    const existing = await hashFile(path);
    if (existing.sha256 !== sha256) {
      throw new StoreError("ATTACHMENT_HASH_MISMATCH", "an attachment file with this name holds different bytes; refusing to overwrite", { sha256 });
    }
    return { sha256, created: false };
  }
  const tmp = join(dir, `${sha256}.tmp-${randomUUID()}`);
  try {
    const h = await open(tmp, "wx", 0o600);
    try { await h.writeFile(bytes); await h.sync(); } finally { await h.close(); }
    await rename(tmp, path);
    await fsyncDir(dir);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
  return { sha256, created: true };
}

/** Startup sweep: remove temp files a crash left behind. Returns how many were removed. */
export async function sweepAttachmentTemps(dir: string): Promise<number> {
  let names: string[];
  try { names = await readdir(dir); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    if (!TEMP_NAME.test(name)) continue;
    try { await rm(join(dir, name), { force: true }); removed++; } catch { /* best effort */ }
  }
  return removed;
}

export async function putAttachment(
  pool: pg.Pool, dir: string, bytes: Uint8Array, input: AttachmentInput,
): Promise<AttachmentRecord> {
  const { sha256 } = await writeAttachmentFile(dir, bytes);
  try {
    await pool.query(
      `INSERT INTO attachment (sha256, media_type, byte_length, original_name, extension, created_at)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (sha256) DO NOTHING`,
      [sha256, input.mediaType, bytes.byteLength, input.originalName ?? null, input.extension ?? null, input.createdAt],
    );
  } catch (e) { throw mapPgError(e); }
  return { sha256, byteLength: bytes.byteLength, mediaType: input.mediaType, originalName: input.originalName ?? null, extension: input.extension ?? null };
}

export async function readAttachment(
  pool: pg.Pool, dir: string, sha256: string,
): Promise<AttachmentRecord & { bytes: Uint8Array }> {
  assertSha256(sha256);
  const { rows } = await pool.query(
    "SELECT media_type, byte_length, original_name, extension FROM attachment WHERE sha256 = $1", [sha256]);
  const row = rows[0];
  if (!row) throw new StoreError("NOT_FOUND", "attachment not found", { sha256 });
  let bytes: Buffer;
  try { bytes = await readFile(attachmentPath(dir, sha256)); } catch {
    throw new StoreError("INTEGRITY_FAILED", "attachment file is missing", { sha256 });
  }
  if (hashBytes(bytes) !== sha256) {
    throw new StoreError("ATTACHMENT_HASH_MISMATCH", "attachment file does not match its hash", { sha256 });
  }
  return { sha256, bytes, byteLength: bytes.length, mediaType: row.media_type, originalName: row.original_name, extension: row.extension };
}
