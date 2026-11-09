// Staged import. The archive is read and fully validated; every verified file is written into a
// private staging folder beside the destination; the staged files are checked again against the
// archive's checksums; and the folder is moved into place with one rename. A failure at any point
// removes the staging folder and leaves the destination unchanged.
//
// The result is an unpacked library folder named by library id (the layout of the archive, one file
// per archive path). Loading it into the database is M1-4's job.

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, stat, open, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { ArchiveError, ioError, throwIfAborted } from "./errors.ts";
import type { Issue } from "./errors.ts";
import { readArchive } from "./reader.ts";
import type { ArchiveInput, ReadOptions } from "./reader.ts";
import type { ArchiveSummary } from "./model.ts";
import { syncDirectory } from "./writer.ts";

export interface ImportOptions extends Pick<ReadOptions, "limits" | "signal"> {
  /** Explicit approval to replace a library with the same id. Without it, an existing library is refused. */
  replaceExisting?: boolean;
  /** Test seam: runs after staging is verified and before the move into place. */
  beforeCommit?: () => Promise<void> | void;
}

export interface ImportPreview {
  summary: ArchiveSummary;
  warnings: Issue[];
  /** Whether a library with this id is already in the destination folder. */
  targetExists: boolean;
}

export interface ImportResult {
  /** The imported library folder. */
  directory: string;
  libraryId: string;
  title: string;
  summary: ArchiveSummary;
  warnings: Issue[];
  replaced: boolean;
  /** The previous library, kept whole, when one was replaced. */
  backup?: string;
}

const exists = async (p: string): Promise<boolean> => (await lstat(p).catch(() => undefined)) !== undefined;

/** Validates an archive without writing anything (import step 2: the preview). */
export async function previewArchive(input: ArchiveInput, librariesDir?: string, options: Pick<ReadOptions, "limits" | "signal"> = {}): Promise<ImportPreview> {
  const contents = await readArchive(input, options);
  try {
    const targetExists = librariesDir === undefined ? false : await exists(path.join(path.resolve(librariesDir), contents.summary.libraryId));
    return { summary: contents.summary, warnings: contents.warnings, targetExists };
  } finally {
    await contents.close();
  }
}

export async function importArchive(input: ArchiveInput, librariesDir: string, options: ImportOptions = {}): Promise<ImportResult> {
  const root = path.resolve(librariesDir);
  // stat, not lstat: the libraries folder may itself be a symbolic link to a folder (the destination and its entries are checked with lstat).
  const rootStat = await stat(root).catch(() => undefined);
  if (!rootStat?.isDirectory()) throw new ArchiveError("ARCHIVE_IO_ERROR", `The folder ${root} does not exist`);
  const staging = path.join(root, `.import-${randomUUID()}.staging`);
  const { signal } = options;
  try {
    try {
      await mkdir(staging, { mode: 0o700 });
    } catch (e) {
      throw new ArchiveError("ARCHIVE_IO_ERROR", `Cannot create the staging folder: ${(e as Error).message}`, { cause: e });
    }
    const staged = new Map<string, { byteLength: number; sha256: string }>();
    const contents = await readArchive(input, {
      ...(options.limits ? { limits: options.limits } : {}),
      ...(signal ? { signal } : {}),
      onFile: async (p, bytes) => {
        await writeStaged(staging, p, bytes);
        staged.set(p, { byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
      },
    });
    let committed = false;
    try {
      const { libraryId, title } = contents.summary;
      const destination = path.join(root, libraryId); // a validated lowercase UUID
      const present = await exists(destination);
      if (present && !options.replaceExisting) {
        throw new ArchiveError("ARCHIVE_ALREADY_EXISTS", `A library with the id ${libraryId} already exists. Importing would replace it; confirm the replacement to continue. Nothing was changed.`);
      }
      await verifyStaged(staging, staged);
      await syncTree(staging);
      throwIfAborted(signal, "The import");
      await options.beforeCommit?.();
      throwIfAborted(signal, "The import");

      let backup: string | undefined;
      if (present) backup = await swapIn(staging, destination);
      else {
        try {
          await rename(staging, destination);
        } catch (e) {
          throw new ArchiveError("ARCHIVE_IO_ERROR", `Moving the library into place failed: ${(e as Error).message}`, { cause: e });
        }
      }
      committed = true;
      await syncDirectory(root);
      return {
        directory: destination, libraryId, title, summary: contents.summary, warnings: contents.warnings,
        replaced: present, ...(backup === undefined ? {} : { backup }),
      };
    } finally {
      // Once the library is in place, a failing close must not turn a finished import into a rejection.
      if (committed) await contents.close().catch(() => {});
      else await contents.close().catch(() => {}); // never replace the real error (already exists, cancelled, rollback with backup path)
    }
  } finally {
    // After a successful move the staging path no longer exists, so this is a no-op.
    await rm(staging, { recursive: true, force: true }).catch(() => {}); // best effort; must not hide the original error
  }
}

/** Writes one verified archive file into the staging folder. The name already passed the allowlist; this is a second guard. */
async function writeStaged(staging: string, archivePath: string, bytes: Buffer): Promise<void> {
  const target = path.join(staging, ...archivePath.split("/"));
  const rel = path.relative(staging, target);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new ArchiveError("ARCHIVE_PATH_TRAVERSAL", "A path left the staging folder", { path: archivePath });
  }
  try {
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const fh = await open(target, "wx", 0o600); // never overwrites
    try {
      let done = 0;
      while (done < bytes.length) done += (await fh.write(bytes, done, bytes.length - done)).bytesWritten;
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch (e) {
    if (e instanceof ArchiveError) throw e;
    throw new ArchiveError("ARCHIVE_IO_ERROR", `Writing ${archivePath} to the staging folder failed: ${(e as Error).message}`, { path: archivePath, cause: e });
  }
}

async function hashFile(file: string): Promise<{ byteLength: number; sha256: string }> {
  const h = createHash("sha256");
  let n = 0;
  try {
    for await (const chunk of createReadStream(file) as AsyncIterable<Buffer>) { h.update(chunk); n += chunk.length; }
  } catch (e) {
    throw ioError("Reading a staged file back failed", e);
  }
  return { byteLength: n, sha256: h.digest("hex") };
}

async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  let listing;
  try { listing = await readdir(dir, { withFileTypes: true }); } catch (e) { throw ioError("Listing the staging folder failed", e); }
  for (const d of listing) {
    const rel = prefix === "" ? d.name : `${prefix}/${d.name}`;
    if (d.isDirectory()) out.push(...await listFiles(path.join(dir, d.name), rel));
    else if (d.isFile()) out.push(rel);
    else throw new ArchiveError("ARCHIVE_IO_ERROR", `The staging folder holds something that is not a plain file: ${rel}`);
  }
  return out;
}

/** The staged folder must hold exactly the verified files, byte for byte. */
async function verifyStaged(staging: string, expected: Map<string, { byteLength: number; sha256: string }>): Promise<void> {
  const files = await listFiles(staging);
  const extra = files.filter((f) => !expected.has(f));
  if (extra.length > 0 || files.length !== expected.size) throw new ArchiveError("ARCHIVE_CORRUPT", "The staged library does not hold exactly the archive's files");
  for (const [p, want] of expected) {
    const got = await hashFile(path.join(staging, ...p.split("/")));
    if (got.byteLength !== want.byteLength || got.sha256 !== want.sha256) throw new ArchiveError("ARCHIVE_CORRUPT", `The staged copy of ${p} does not match the archive`, { path: p });
  }
}

async function syncTree(dir: string): Promise<void> {
  let listing;
  try { listing = await readdir(dir, { withFileTypes: true }); } catch (e) { throw ioError("Listing the staging folder failed", e); }
  for (const d of listing) if (d.isDirectory()) await syncTree(path.join(dir, d.name));
  await syncDirectory(dir);
}

/**
 * Replaces `live` with `staging`: the old library is renamed aside (kept whole), then the new one moves
 * in; the first rename is undone if the second fails. The swap is two renames and is NOT crash-atomic:
 * a crash between them leaves no folder at `live` and the old library at the backup path. An error
 * therefore always names the backup path when the old library is not back in place.
 */
async function swapIn(staging: string, live: string): Promise<string> {
  let liveStat;
  try { liveStat = await lstat(live); } catch (e) { throw ioError("Cannot inspect the existing library", e); }
  if (!liveStat.isDirectory()) throw new ArchiveError("ARCHIVE_IO_ERROR", `${live} exists and is not a library folder`);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  let backup = `${live}.replaced-${stamp}`;
  for (let n = 2; await exists(backup); n++) backup = `${live}.replaced-${stamp}-${n}`;
  try {
    await rename(live, backup);
  } catch (e) {
    throw new ArchiveError("ARCHIVE_IO_ERROR", `Replacing the library failed: ${(e as Error).message}`, { cause: e });
  }
  try {
    await rename(staging, live);
  } catch (e) {
    try {
      await rename(backup, live);
    } catch (rollback) {
      throw new ArchiveError("ARCHIVE_IO_ERROR",
        `Replacing the library failed (${(e as Error).message}) and the old library could not be put back (${(rollback as Error).message}). The previous library is intact at ${backup}.`,
        { cause: new AggregateError([e, rollback], "swap and rollback both failed") });
    }
    throw new ArchiveError("ARCHIVE_IO_ERROR", `Replacing the library failed: ${(e as Error).message}`, { cause: e });
  }
  return backup;
}
