// SPDX-License-Identifier: AGPL-3.0-only
import { inflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import { StudioError } from "./store.ts";
export const archiveFiles: Record<string, string> = {
  "manifest.json": "manifest",
  "checksums.json": "checksums",
  "library.json": "library",
  "references.json": "references",
  "notes.json": "notes",
  "attachments.json": "attachments",
  "bible/entries.json": "entries",
  "bible/templates.json": "templates",
  "bible/fields.json": "fields",
  "bible/relationships.json": "relationships",
  "bible/facts.json": "facts",
  "bible/questions.json": "questions",
  "continuity/events.json": "events",
  "continuity/state_changes.json": "stateChanges",
};
export const archiveFail = (code: string, message: string): never => {
  throw new StudioError(400, code, message);
};
export const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const crcTable = Array.from({ length: 256 }, (_, i) => {
  let x = i;
  for (let j = 0; j < 8; j++) x = x & 1 ? 0xedb88320 ^ (x >>> 1) : x >>> 1;
  return x >>> 0;
});
const crc = (bytes: Uint8Array) => {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const dirs = new Set(["manuscript", "bible", "continuity", "attachments"]);
const fatal = new TextDecoder("utf-8", { fatal: true });
export function archiveJSON(bytes: Uint8Array, path: string): any {
  let text: string;
  try {
    if (bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191) throw Error();
    text = fatal.decode(bytes);
  } catch {
    archiveFail("ARCHIVE_INVALID_UTF8", path + " is not UTF-8 without BOM.");
  }
  try {
    const result = JSON.parse(text!);
    const stack: [any, number][] = [[result, 0]];
    while (stack.length) {
      const [v, depth] = stack.pop()!;
      if (depth > 128)
        archiveFail("ARCHIVE_TOO_LARGE", "JSON nesting exceeds safe limits.");
      if (
        typeof v === "number" &&
        (!Number.isFinite(v) ||
          (Number.isInteger(v) && !Number.isSafeInteger(v)))
      )
        archiveFail(
          "SCHEMA_VIOLATION",
          "JSON numbers must be finite and integers must be safely representable.",
        );
      if (v && typeof v === "object")
        for (const x of Object.values(v)) stack.push([x, depth + 1]);
    }
    return result;
  } catch (e) {
    if (e instanceof StudioError) throw e;
    archiveFail("ARCHIVE_INVALID_JSON", path + " is not valid JSON.");
  }
}
/** Inventory and size/ratio limits precede inflation. No archive path is ever written to disk. */
export function readZIP(bytes: Buffer): Map<string, Buffer> {
  const fail = (m: string) => archiveFail("ARCHIVE_CORRUPT", m);
  try {
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
      if (
        bytes.readUInt32LE(i) === 0x06054b50 &&
        i + 22 + bytes.readUInt16LE(i + 20) === bytes.length
      ) {
        end = i;
        break;
      }
    if (end < 0) fail("Not a readable ZIP archive.");
    if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6))
      fail("Multi-disk ZIP is not supported.");
    let count = bytes.readUInt16LE(end + 10),
      size = bytes.readUInt32LE(end + 12),
      offset = bytes.readUInt32LE(end + 16);
    const integer = (n: bigint) => {
      if (n > BigInt(Number.MAX_SAFE_INTEGER))
        archiveFail("ARCHIVE_TOO_LARGE", "ZIP64 value exceeds safe limits.");
      return Number(n);
    };
    if (count === 65535 || size === 0xffffffff || offset === 0xffffffff) {
      if (end < 20 || bytes.readUInt32LE(end - 20) !== 0x07064b50)
        fail("Missing ZIP64 locator.");
      const at = integer(bytes.readBigUInt64LE(end - 12));
      if (
        bytes.readUInt32LE(at) !== 0x06064b50 ||
        bytes.readUInt32LE(at + 16) ||
        bytes.readUInt32LE(at + 20)
      )
        fail("Invalid ZIP64 directory.");
      count = integer(bytes.readBigUInt64LE(at + 32));
      size = integer(bytes.readBigUInt64LE(at + 40));
      offset = integer(bytes.readBigUInt64LE(at + 48));
    }
    if (count > 10000)
      archiveFail("ARCHIVE_TOO_LARGE", "Archive has more than 10,000 entries.");
    if (offset + size > end) fail("ZIP directory extends outside the archive.");
    const inventory: any[] = [],
      seen = new Set<string>();
    let p = offset,
      total = 0;
    for (let i = 0; i < count; i++) {
      if (bytes.readUInt32LE(p) !== 0x02014b50)
        fail("Invalid central directory.");
      const flags = bytes.readUInt16LE(p + 8),
        method = bytes.readUInt16LE(p + 10),
        checksum = bytes.readUInt32LE(p + 16),
        nameLen = bytes.readUInt16LE(p + 28),
        extraLen = bytes.readUInt16LE(p + 30),
        commentLen = bytes.readUInt16LE(p + 32),
        attrs = bytes.readUInt32LE(p + 38);
      let expanded = bytes.readUInt32LE(p + 24),
        compressed = bytes.readUInt32LE(p + 20),
        local = bytes.readUInt32LE(p + 42);
      const nameBytes = bytes.subarray(p + 46, p + 46 + nameLen);
      let name: string;
      try {
        name = fatal.decode(nameBytes);
      } catch {
        fail("Invalid ZIP filename.");
      }
      const directory =
          name!.endsWith("/") || ((attrs >>> 16) & 0xf000) === 0x4000,
        clean = directory ? name!.replace(/\/$/, "") : name!;
      if (
        !clean ||
        clean.startsWith("/") ||
        /^[a-z]:/i.test(clean) ||
        /[\\\0]/.test(clean) ||
        clean.split("/").some((s) => !s || s === "." || s === "..")
      )
        archiveFail("ARCHIVE_PATH_TRAVERSAL", "Unsafe archive path.");
      const type = (attrs >>> 16) & 0xf000;
      if (type && type !== 0x8000 && type !== 0x4000)
        archiveFail("ARCHIVE_SYMLINK", "Non-file archive entry.");
      if (directory) {
        if (!dirs.has(clean))
          archiveFail(
            "ARCHIVE_UNEXPECTED_FILE",
            "Unexpected archive directory.",
          );
        p += 46 + nameLen + extraLen + commentLen;
        continue;
      }
      if (seen.has(name!.toLowerCase()))
        archiveFail("ARCHIVE_DUPLICATE_PATH", "Duplicate archive path.");
      seen.add(name!.toLowerCase());
      const attachment =
        /^attachments\/[0-9a-f]{64}(?:\.[a-z0-9]{1,10})?$/.test(name!);
      if (
        !Object.hasOwn(archiveFiles, name!) &&
        !/^manuscript\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.json$/.test(
          name!,
        ) &&
        !attachment
      )
        archiveFail(
          "ARCHIVE_UNEXPECTED_FILE",
          "Unexpected archive file: " + name!,
        );
      if (
        expanded === 0xffffffff ||
        compressed === 0xffffffff ||
        local === 0xffffffff
      ) {
        let e = p + 46 + nameLen,
          found = false;
        while (e < p + 46 + nameLen + extraLen) {
          const tag = bytes.readUInt16LE(e),
            len = bytes.readUInt16LE(e + 2);
          if (tag === 1) {
            let z = e + 4;
            if (expanded === 0xffffffff) {
              expanded = integer(bytes.readBigUInt64LE(z));
              z += 8;
            }
            if (compressed === 0xffffffff) {
              compressed = integer(bytes.readBigUInt64LE(z));
              z += 8;
            }
            if (local === 0xffffffff) local = integer(bytes.readBigUInt64LE(z));
            found = true;
            break;
          }
          e += 4 + len;
        }
        if (!found) fail("Missing ZIP64 sizes.");
      }
      if (
        expanded > (attachment ? 250 : 100) * 1024 * 1024 ||
        (expanded > 1048576 && expanded / Math.max(1, compressed) > 200) ||
        (total += expanded) > 2 * 1024 ** 3
      )
        archiveFail(
          "ARCHIVE_TOO_LARGE",
          "Archive expansion or compression ratio exceeds safe limits.",
        );
      if (flags & 0x41 || ![0, 8].includes(method))
        fail("Encrypted or unsupported ZIP entry.");
      inventory.push({
        name: name!,
        flags,
        nameBytes,
        expanded,
        compressed,
        local,
        checksum,
        method,
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    if (p !== offset + size) fail("ZIP directory length mismatch.");
    const files = new Map<string, Buffer>();
    for (const e of inventory) {
      const l = e.local;
      if (
        bytes.readUInt32LE(l) !== 0x04034b50 ||
        bytes.readUInt16LE(l + 6) !== e.flags ||
        bytes.readUInt16LE(l + 8) !== e.method
      )
        fail("Invalid ZIP local header.");
      const n = bytes.readUInt16LE(l + 26),
        x = bytes.readUInt16LE(l + 28),
        start = l + 30 + n + x;
      if (
        !bytes.subarray(l + 30, l + 30 + n).equals(e.nameBytes) ||
        start + e.compressed > offset
      )
        fail("ZIP entry boundaries disagree.");
      let out: Buffer;
      try {
        const compressed = bytes.subarray(start, start + e.compressed);
        out =
          e.method === 0
            ? Buffer.from(compressed)
            : inflateRawSync(compressed, {
                maxOutputLength: Math.max(1, e.expanded),
              });
      } catch {
        fail("ZIP entry could not be inflated within its declared length.");
      }
      if (out!.length !== e.expanded || crc(out!) !== e.checksum)
        fail("ZIP entry size or CRC mismatch.");
      files.set(e.name, out!);
    }
    return files;
  } catch (e) {
    if (e instanceof StudioError) throw e;
    return fail("Corrupt ZIP structure.");
  }
}
export function writeZIP(files: Map<string, Uint8Array>): Buffer {
  return Buffer.from(
    zipSync(
      Object.fromEntries([...files].map(([p, b]) => [p, [b, { level: 0 }]])),
      { level: 0 },
    ),
  );
}
