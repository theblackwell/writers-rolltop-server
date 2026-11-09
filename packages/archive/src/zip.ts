// A small ZIP reader and writer, written for this format instead of a dependency so that every
// safety limit is applied to the bytes actually read. Supports stored and DEFLATE entries only;
// no encryption, no ZIP64 (the format needs neither below 4 GiB), no multi-disk archives.
//
// The reader never trusts a header it can check: central directory and local header must agree on
// the name, entry data must lie inside the file and may not overlap, sizes are bounds on what
// inflate may produce, and the CRC-32 must match.

import { constants, crc32, inflateRaw, deflateRaw } from "node:zlib";
import { promisify } from "node:util";
import { open } from "node:fs/promises";
import { ArchiveError, ioError, throwIfAborted } from "./errors.ts";
import type { ArchiveLimits } from "./limits.ts";
import { printable } from "./paths.ts";

const inflateRawAsync = promisify(inflateRaw);
const deflateRawAsync = promisify(deflateRaw);

/** Random-access read-only bytes. */
export interface ByteSource {
  readonly size: number;
  /** Exactly `length` bytes at `offset`; throws ARCHIVE_CORRUPT if the range is outside the source (a header that lies about where data is). */
  read(offset: number, length: number): Promise<Buffer>;
  close(): Promise<void>;
}

const outside = (): ArchiveError => new ArchiveError("ARCHIVE_CORRUPT", "The ZIP headers point outside the file");

export function bufferSource(buffer: Uint8Array): ByteSource {
  const buf = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  return {
    size: buf.length,
    async read(offset, length) {
      if (offset < 0 || length < 0 || offset + length > buf.length) throw outside();
      return buf.subarray(offset, offset + length);
    },
    async close() {},
  };
}

export async function fileSource(path: string): Promise<ByteSource> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (e) {
    throw new ArchiveError("ARCHIVE_IO_ERROR", `Cannot open the archive: ${(e as Error).message}`, { cause: e });
  }
  try {
    const st = await handle.stat().catch((e: unknown) => { throw ioError("Reading the archive failed", e); });
    if (!st.isFile()) throw new ArchiveError("ARCHIVE_IO_ERROR", "The archive path is not a regular file");
    const size = st.size;
    return {
      size,
      async read(offset, length) {
        if (offset < 0 || length < 0 || offset + length > size) throw outside();
        const out = Buffer.allocUnsafe(length);
        let done = 0;
        while (done < length) {
          const { bytesRead } = await handle.read(out, done, length - done, offset + done).catch((e: unknown) => { throw ioError("Reading the archive failed", e); });
          if (bytesRead === 0) throw new ArchiveError("ARCHIVE_CORRUPT", "The archive file is shorter than its size says (it changed while being read)");
          done += bytesRead;
        }
        return out;
      },
      async close() { await handle.close().catch((e: unknown) => { throw ioError("Closing the archive failed", e); }); },
    };
  } catch (e) {
    await handle.close().catch(() => {});
    throw e;
  }
}

export interface ZipEntry {
  name: string;
  isDirectory: boolean;
  /** "file" for a regular file or directory; "other" for a symlink, device, fifo, socket or reparse point. */
  kind: "file" | "other";
  method: 0 | 8;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  /** Raw name bytes, compared with the local header's. */
  nameBytes: Buffer;
  /** Where the data really starts and ends, from the local header's own name and extra lengths. Set by `locateEntry`. */
  dataStart?: number;
  dataEnd?: number;
}

export interface ZipDirectory {
  entries: ZipEntry[];
  /** Offset where the central directory starts; entry data must end at or before it. */
  centralDirectoryOffset: number;
}

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const corrupt = (message: string): never => { throw new ArchiveError("ARCHIVE_CORRUPT", message); };

/** Reads and checks the central directory. Entry count and directory size are bounded before any entry is parsed. */
export async function readCentralDirectory(src: ByteSource, limits: ArchiveLimits): Promise<ZipDirectory> {
  if (src.size < 22) return corrupt("The file is not a ZIP archive (too short)");
  const tailLength = Math.min(src.size, 22 + 0xffff);
  const tail = await src.read(src.size - tailLength, tailLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { eocd = i; break; }
  }
  if (eocd < 0) return corrupt("The file is not a ZIP archive (no end-of-central-directory record)");
  const disk = tail.readUInt16LE(eocd + 4);
  const cdDisk = tail.readUInt16LE(eocd + 6);
  const countOnDisk = tail.readUInt16LE(eocd + 8);
  const count = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (disk !== 0 || cdDisk !== 0 || countOnDisk !== count) return corrupt("Multi-disk ZIP archives are not supported");
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return corrupt("ZIP64 archives are not supported");
  if (count > limits.maxEntries) throw new ArchiveError("ARCHIVE_TOO_LARGE", `The archive declares ${count} entries; the limit is ${limits.maxEntries}`);
  if (cdSize > limits.maxCentralDirectoryBytes) throw new ArchiveError("ARCHIVE_TOO_LARGE", `The ZIP directory is ${cdSize} bytes; the limit is ${limits.maxCentralDirectoryBytes}`);
  const eocdOffset = src.size - tailLength + eocd;
  if (cdOffset + cdSize !== eocdOffset) return corrupt("The ZIP central directory is not where the end record says");

  const cd = await src.read(cdOffset, cdSize);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== CD_SIG) return corrupt("A ZIP directory entry is malformed");
    const madeBy = cd.readUInt16LE(p + 4);
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const crc = cd.readUInt32LE(p + 16);
    const csize = cd.readUInt32LE(p + 20);
    const usize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const diskStart = cd.readUInt16LE(p + 34);
    const external = cd.readUInt32LE(p + 38);
    const localOffset = cd.readUInt32LE(p + 42);
    const end = p + 46 + nameLen + extraLen + commentLen;
    if (end > cd.length) return corrupt("A ZIP directory entry runs past the directory");
    const nameBytes = Buffer.from(cd.subarray(p + 46, p + 46 + nameLen));
    const name = nameBytes.toString("utf8");
    const shown = printable(name);
    p = end;
    if (diskStart !== 0) return corrupt(`Entry ${shown} is on another disk`);
    if (csize === 0xffffffff || usize === 0xffffffff || localOffset === 0xffffffff) return corrupt(`Entry ${shown} needs ZIP64, which is not supported`);
    const isDirectory = name.endsWith("/");
    if (flags & 0x0001 || flags & 0x0040) return corrupt(`Entry ${shown} is encrypted`);
    if (method !== 0 && method !== 8) return corrupt(`Entry ${shown} uses compression method ${method}; only stored and DEFLATE are supported`);
    if (method === 0 && csize !== usize) return corrupt(`Entry ${shown} is stored but its sizes differ`);

    // Entry type from the Unix mode (hosts 3 = Unix, 19 = macOS) or the DOS attributes (host 0).
    const host = madeBy >>> 8;
    let kind: "file" | "other" = "file";
    if (host === 3 || host === 19) {
      const type = (external >>> 16) & 0o170000;
      if (type === 0o040000) { if (!isDirectory) kind = "other"; }
      else if (type !== 0 && type !== 0o100000) kind = "other";
    } else if (host === 0) {
      if (external & 0x400) kind = "other"; // reparse point
      else if (external & 0x10 && !isDirectory) kind = "other";
    }
    entries.push({ name, isDirectory, kind, method, crc32: crc, compressedSize: csize, uncompressedSize: usize, localOffset, nameBytes });
  }
  if (p !== cd.length) return corrupt("The ZIP directory has unexpected bytes after its last entry");
  return { entries, centralDirectoryOffset: cdOffset };
}

/**
 * Reads and checks an entry's local header and records where its data really is. The local header may
 * carry an extra field that the central directory does not mention, so the true data start is
 * localOffset + 30 + name length + the LOCAL extra length.
 */
export async function locateEntry(src: ByteSource, entry: ZipEntry, dir: ZipDirectory): Promise<{ dataStart: number; dataEnd: number }> {
  if (entry.dataStart !== undefined && entry.dataEnd !== undefined) return { dataStart: entry.dataStart, dataEnd: entry.dataEnd };
  const shown = printable(entry.name);
  const head = await src.read(entry.localOffset, 30);
  if (head.readUInt32LE(0) !== LOCAL_SIG) return corrupt(`Entry ${shown} has no local header`);
  const flags = head.readUInt16LE(6);
  if (flags & 0x0001 || flags & 0x0040) return corrupt(`Entry ${shown} is encrypted`);
  const nameLen = head.readUInt16LE(26);
  const extraLen = head.readUInt16LE(28);
  const dataStart = entry.localOffset + 30 + nameLen + extraLen;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > dir.centralDirectoryOffset) return corrupt(`Entry ${shown} runs past the end of the data`);
  if (nameLen !== entry.nameBytes.length) return corrupt(`Entry ${shown}: the local header names a different file`);
  const localName = await src.read(entry.localOffset + 30, nameLen);
  if (!localName.equals(entry.nameBytes)) return corrupt(`Entry ${shown}: the local header names a different file`);
  entry.dataStart = dataStart;
  entry.dataEnd = dataEnd;
  return { dataStart, dataEnd };
}

/**
 * Entries must not share bytes. Each entry's real range is [localOffset, dataEnd), including its local
 * header, name and local extra field; sorted by offset, each must end before the next begins.
 */
export async function checkNoOverlap(src: ByteSource, entries: readonly ZipEntry[], dir: ZipDirectory, signal?: AbortSignal): Promise<void> {
  const ranges: { e: ZipEntry; start: number; end: number }[] = [];
  for (const e of entries) {
    if (e.isDirectory) continue;
    throwIfAborted(signal, "Reading the archive");
    const { dataEnd } = await locateEntry(src, e, dir);
    ranges.push({ e, start: e.localOffset, end: dataEnd });
  }
  ranges.sort((a, b) => a.start - b.start);
  let floor = 0;
  for (const r of ranges) {
    throwIfAborted(signal, "Reading the archive");
    if (r.start < floor) corrupt(`Entry ${printable(r.e.name)} overlaps another entry`);
    floor = r.end;
  }
}

/**
 * Reads one entry's bytes, verified against its header: the local header must match, inflate may not
 * produce more than the declared size, the produced length and CRC-32 must match.
 */
export async function readEntry(src: ByteSource, entry: ZipEntry, dir: ZipDirectory): Promise<Buffer> {
  const shown = printable(entry.name);
  const { dataStart } = await locateEntry(src, entry, dir);
  if (entry.method === 8 && entry.compressedSize > entry.uncompressedSize + (entry.uncompressedSize >> 3) + 1024) {
    return corrupt(`Entry ${shown}: the compressed size is implausible`);
  }
  const data = await src.read(dataStart, entry.compressedSize);
  let out: Buffer;
  if (entry.method === 0) out = data;
  else {
    try {
      // maxOutputLength makes inflate stop as soon as it would produce more than the header says.
      out = await inflateRawAsync(data, { maxOutputLength: Math.max(entry.uncompressedSize, 1), finishFlush: constants.Z_FINISH });
    } catch (e) {
      const code = (e as { code?: string }).code;
      return corrupt(code === "ERR_BUFFER_TOO_LARGE"
        ? `Entry ${shown} holds more bytes than its header says (${entry.uncompressedSize})`
        : `Entry ${shown} cannot be inflated (${(e as Error).message})`);
    }
  }
  if (out.length !== entry.uncompressedSize) return corrupt(`Entry ${shown} holds ${out.length} bytes but its header says ${entry.uncompressedSize}`);
  if (crc32(out) !== entry.crc32) return corrupt(`Entry ${shown} fails the ZIP's own CRC-32 check`);
  return out;
}

// ---- writing ----

export interface ZipFileInput {
  name: string;
  data: Buffer;
  /** Store without compressing (attachments are mostly compressed media already). */
  store?: boolean;
}

export interface ZipWriteSink {
  write(chunk: Buffer): Promise<void>;
}

const DOS_DATE_1980_01_01 = (0 << 9) | (1 << 5) | 1;

/**
 * Streams a ZIP to `sink` one entry at a time. `files` yields entries in the order they are written;
 * each is read lazily so only one attachment is in memory at once. Returns the number of bytes written.
 */
export async function writeZip(
  files: AsyncIterable<ZipFileInput> | Iterable<ZipFileInput>,
  sink: ZipWriteSink,
  limits: ArchiveLimits,
  signal?: AbortSignal,
): Promise<{ bytes: number; entries: number }> {
  const central: Buffer[] = [];
  let offset = 0;
  let count = 0;
  const emit = async (b: Buffer): Promise<void> => { await sink.write(b); offset += b.length; };
  for await (const f of files) {
    if (signal?.aborted) throw new ArchiveError("ARCHIVE_CANCELLED", "The export was cancelled");
    const nameBytes = Buffer.from(f.name, "utf8");
    let method: 0 | 8 = 0;
    let body = f.data;
    if (!f.store && f.data.length > 0) {
      const packed = await deflateRawAsync(f.data, { level: 9 });
      // Keep DEFLATE only when it helps and stays well under the reader's ratio limit.
      const ratioOk = f.data.length <= limits.ratioThresholdBytes || packed.length * (limits.maxCompressionRatio * 0.75) >= f.data.length;
      if (packed.length < f.data.length && ratioOk) { method = 8; body = packed; }
    }
    if (offset + 30 + nameBytes.length + body.length > 0xfffffff0 || count >= 0xfffe) {
      throw new ArchiveError("ARCHIVE_TOO_LARGE", "The archive would need ZIP64, which the format does not use");
    }
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_DATE_1980_01_01, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    const localOffset = offset;
    await emit(local);
    await emit(nameBytes);
    await emit(body);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(CD_SIG, 0);
    cd.writeUInt16LE((3 << 8) | 20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(DOS_DATE_1980_01_01, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(f.data.length, 24);
    cd.writeUInt16LE(nameBytes.length, 28);
    cd.writeUInt32LE(((0o100644 << 16) >>> 0), 38);
    cd.writeUInt32LE(localOffset, 42);
    central.push(cd, nameBytes);
    count++;
  }
  const cdOffset = offset;
  const cdBytes = Buffer.concat(central);
  await emit(cdBytes);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(EOCD_SIG, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(cdBytes.length, 12);
  end.writeUInt32LE(cdOffset, 16);
  await emit(end);
  return { bytes: offset, entries: count };
}
