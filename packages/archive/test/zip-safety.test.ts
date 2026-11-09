import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, truncate } from "node:fs/promises";
import path from "node:path";
import { ArchiveError, readArchive, writeArchive } from "../src/index.ts";
import { fileSource } from "../src/zip.ts";
import type { ArchiveLimits } from "../src/index.ts";
import { archiveFromFiles, buildZip, sha256, unpackedFiles, withTempDir } from "./helpers.ts";
import type { RawEntry } from "./helpers.ts";

const base = await unpackedFiles("sample-library");
const entriesOf = (files: Map<string, Buffer> = base): RawEntry[] => {
  // archiveFromFiles with an identity tweak, captured for tampering.
  let captured: RawEntry[] = [];
  archiveFromFiles(files, (e) => (captured = e));
  return captured;
};
const zipOf = (entries: RawEntry[], extra?: Parameters<typeof buildZip>[1]): Buffer => buildZip(entries, extra);

async function refused(input: Uint8Array, code: string, limits?: Partial<ArchiveLimits>, signal?: AbortSignal): Promise<void> {
  await assert.rejects(readArchive(input, { ...(limits ? { limits } : {}), ...(signal ? { signal } : {}) }), (e: unknown) => {
    assert.ok(e instanceof ArchiveError, String(e));
    assert.equal(e.code, code, e.message);
    return true;
  });
}
async function accepted(input: Uint8Array, limits?: Partial<ArchiveLimits>): Promise<void> {
  const c = await readArchive(input, limits ? { limits } : {});
  await c.close();
}
const tamper = (name: string, fn: (e: RawEntry) => void): RawEntry[] => {
  const entries = entriesOf();
  fn(entries.find((e) => e.name === name)!);
  return entries;
};
const withExtra = (extra: RawEntry): RawEntry[] => [...entriesOf(), extra];

test("a well-formed archive built by the test helper is accepted (control)", async () => {
  await accepted(zipOf(entriesOf()));
});

test("not a ZIP: empty, too short, text, truncated, bad end record", async () => {
  await refused(Buffer.alloc(0), "ARCHIVE_CORRUPT");
  await refused(Buffer.from("PK"), "ARCHIVE_CORRUPT");
  await refused(Buffer.from("this is not a zip file at all, just a sentence of text"), "ARCHIVE_CORRUPT");
  const good = zipOf(entriesOf());
  await refused(good.subarray(0, good.length - 10), "ARCHIVE_CORRUPT");
  await refused(good.subarray(0, 1000), "ARCHIVE_CORRUPT");
});

test("a ZIP comment is allowed", async () => {
  await accepted(zipOf(entriesOf(), { comment: "made by a test" }));
});

test("entry count: over the limit, and a count that does not match the directory", async () => {
  await refused(zipOf(entriesOf()), "ARCHIVE_TOO_LARGE", { maxEntries: 5 });
  await refused(zipOf(entriesOf(), { eocdCount: 3 }), "ARCHIVE_CORRUPT"); // count says 3, directory holds more
  await refused(zipOf(entriesOf(), { eocdCount: 500 }), "ARCHIVE_CORRUPT");
});

test("ZIP64, encryption and unsupported compression are refused", async () => {
  await refused(zipOf(entriesOf(), { zip64Count: true }), "ARCHIVE_CORRUPT");
  await refused(zipOf(tamper("notes.json", (e) => { e.flags = 0x0801; })), "ARCHIVE_CORRUPT");
  await refused(zipOf(tamper("notes.json", (e) => { e.method = 12 as 8; })), "ARCHIVE_CORRUPT");
});

test("sizes in the header are limits on the bytes produced, not claims to believe", async () => {
  // Header says 10 bytes, the data inflates to far more: inflate stops, the entry is corrupt.
  await refused(zipOf(tamper("library.json", (e) => { e.declaredSize = 10; })), "ARCHIVE_CORRUPT");
  // Header says more than the data holds.
  await refused(zipOf(tamper("library.json", (e) => { e.declaredSize = e.data.length + 5; })), "ARCHIVE_CORRUPT");
  // Header CRC-32 does not match.
  await refused(zipOf(tamper("library.json", (e) => { e.declaredCrc = 1234; })), "ARCHIVE_CORRUPT");
});

test("stored (uncompressed) entries are read like DEFLATE ones", async () => {
  await accepted(zipOf(entriesOf().map((e) => ({ ...e, method: 0 as const }))));
});

test("size limits: JSON file, attachment, total, all JSON together", async () => {
  await refused(zipOf(entriesOf()), "ARCHIVE_TOO_LARGE", { maxJSONBytes: 1000 });
  await refused(zipOf(entriesOf()), "ARCHIVE_TOO_LARGE", { maxAttachmentBytes: 50 });
  await refused(zipOf(entriesOf()), "ARCHIVE_TOO_LARGE", { maxTotalBytes: 5000 });
  await refused(zipOf(entriesOf()), "ARCHIVE_TOO_LARGE", { maxTotalJSONBytes: 5000 });
  await refused(zipOf(entriesOf()), "ARCHIVE_TOO_LARGE", { maxCentralDirectoryBytes: 100 });
  await accepted(zipOf(entriesOf()), { maxJSONBytes: 1_000_000, maxTotalBytes: 1_000_000 });
});

test("compression ratio is checked from the headers, before any extraction, only above the size threshold", async () => {
  const bomb = Buffer.alloc(3 * 1024 * 1024, 0); // 3 MiB of zeros compresses to a few kilobytes
  const files = new Map(base);
  files.set(`attachments/${sha256(bomb)}`, bomb);
  const lib = JSON.parse(files.get("attachments.json")!.toString("utf8"));
  lib.push({ sha256: sha256(bomb), mediaType: "application/octet-stream", byteLength: bomb.length, createdAt: "2026-11-02T12:00:00Z" });
  files.set("attachments.json", Buffer.from(JSON.stringify(lib)));
  await refused(archiveFromFiles(files), "ARCHIVE_TOO_LARGE"); // default 200:1 over 1 MiB
  await refused(archiveFromFiles(files), "ARCHIVE_TOO_LARGE", { maxCompressionRatio: 100_000 }); // limits cannot be raised above the default
  await refused(archiveFromFiles(files), "ARCHIVE_TOO_LARGE", { ratioThresholdBytes: 10 * 1024 * 1024 }); // nor the threshold
  // Under the threshold the ratio is not checked: 512 KiB of zeros is also tiny when compressed.
  const small = Buffer.alloc(512 * 1024, 0);
  const smallFiles = new Map(base);
  smallFiles.set(`attachments/${sha256(small)}`, small);
  const smallList = JSON.parse(smallFiles.get("attachments.json")!.toString("utf8"));
  smallList.push({ sha256: sha256(small), mediaType: "application/octet-stream", byteLength: small.length, createdAt: "2026-11-02T12:00:00Z" });
  smallFiles.set("attachments.json", Buffer.from(JSON.stringify(smallList)));
  await accepted(archiveFromFiles(smallFiles));
  // Small, highly compressible entries (under the threshold) are fine at the default.
  await accepted(zipOf(entriesOf()));
});

test("a zip bomb that lies about its size is stopped by the bytes actually produced", async () => {
  const bomb = Buffer.alloc(8 * 1024 * 1024, 0);
  const files = new Map(base);
  files.set(`attachments/${sha256(bomb)}`, bomb);
  const list = JSON.parse(files.get("attachments.json")!.toString("utf8"));
  list.push({ sha256: sha256(bomb), mediaType: "application/octet-stream", byteLength: bomb.length, createdAt: "2026-11-02T12:00:00Z" });
  files.set("attachments.json", Buffer.from(JSON.stringify(list)));
  // The header claims 4 KiB (so the ratio check passes); the data inflates to 8 MiB.
  await refused(archiveFromFiles(files, (entries) => entries.map((e) => (e.name.startsWith("attachments/" + sha256(bomb)) ? { ...e, declaredSize: 4096 } : e))), "ARCHIVE_CORRUPT");
});

test("path rules: absolute, traversal, dot segments, backslash, empty segment, NUL, volume prefix", async () => {
  for (const name of ["/etc/passwd", "../evil.json", "bible/../../evil.json", "./manifest2.json", "bible/./x.json", "a\\b.json", "bible//entries2.json", "x\0y.json", "C:/evil.json", "C:evil.json", "", "..", "."]) {
    await refused(zipOf(withExtra({ name, data: Buffer.from("x") })), "ARCHIVE_PATH_TRAVERSAL");
  }
  await refused(zipOf(withExtra({ name: "../evil/", data: Buffer.alloc(0) })), "ARCHIVE_PATH_TRAVERSAL"); // a directory entry is still checked
});

test("path allowlist: unknown names, near misses, other extensions, deep paths, non-ASCII look-alikes", async () => {
  const sha = "a".repeat(64);
  for (const name of ["notes.txt", "extra.json", "manuscript/readme.txt", "manuscript/NOT-A-UUID.json", "manuscript/50000099-0000-4000-8000-000000000001.JSON",
    "manuscript/50000099-0000-4000-8000-00000000000A.json", "manuscript/50000099-0000-4000-8000-000000000001.json.bak", "manuscript/sub/50000099-0000-4000-8000-000000000001.json",
    `attachments/${sha.toUpperCase()}`, `attachments/${sha}.`, `attachments/${sha}.toolongextension`, `attachments/${sha}.PNG`, `attachments/${sha.slice(1)}`,
    "attachments/x/y", "bible/other.json", "continuity/other.json", "m\u0430nifest.json", "notes.json ", " notes.json", "notes.json."]) {
    await refused(zipOf(withExtra({ name, data: Buffer.from("x") })), "ARCHIVE_UNEXPECTED_FILE");
  }
});

test("duplicate paths: exact, case-only, and file against directory", async () => {
  await refused(zipOf(withExtra({ name: "notes.json", data: Buffer.from("[]") })), "ARCHIVE_DUPLICATE_PATH");
  await refused(zipOf(withExtra({ name: "Notes.JSON", data: Buffer.from("[]") })), "ARCHIVE_DUPLICATE_PATH");
  await refused(zipOf(withExtra({ name: "bible/", data: Buffer.alloc(0) , mode: 0o040755 }).concat([{ name: "BIBLE/", data: Buffer.alloc(0), mode: 0o040755 }])), "ARCHIVE_DUPLICATE_PATH");
});

test("directory entries are ignored", async () => {
  const dirs: RawEntry[] = ["bible/", "manuscript/", "attachments/", "continuity/", "anything/"].map((name) => ({ name, data: Buffer.alloc(0), mode: 0o040755 }));
  await accepted(zipOf([...dirs, ...entriesOf()]));
});

test("symlinks and other non-file entries are refused", async () => {
  const sha = "b".repeat(64);
  for (const mode of [0o120777, 0o010644, 0o020644, 0o060644, 0o140644, 0o040755 /* a directory flag on a name without a slash */]) {
    await refused(zipOf(withExtra({ name: `attachments/${sha}`, data: Buffer.from("/etc/passwd"), mode })), "ARCHIVE_SYMLINK");
  }
  // DOS-hosted entries: the reparse-point attribute, and the directory attribute on a name without a slash.
  await refused(zipOf(withExtra({ name: `attachments/${sha}`, data: Buffer.from("x"), madeByHost: 0, external: 0x400 })), "ARCHIVE_SYMLINK");
  await refused(zipOf(withExtra({ name: `attachments/${sha}`, data: Buffer.from("x"), madeByHost: 0, external: 0x10 })), "ARCHIVE_SYMLINK");
  // A plain DOS file and a Unix file with no type bits are fine (the control above).
});

test("overlapping entries and header disagreements are corrupt", async () => {
  // Two directory entries point at the same local header.
  const overlapping = entriesOf();
  overlapping[3] = { ...overlapping[3]!, centralOffset: 0 };
  await refused(zipOf(overlapping), "ARCHIVE_CORRUPT");
  // The local header names a different file than the directory does.
  await refused(zipOf(tamper("notes.json", (e) => { e.localName = "references.json"; })), "ARCHIVE_CORRUPT");
  // Entry B starts inside entry A's LOCAL extra field. The extra is invisible to the central directory,
  // so A's data really begins after it; only a check on the real ranges sees that B sits inside A.
  const inner = buildZip([{ name: "notes.json", data: Buffer.from("[]"), method: 0 }]);
  const bLocal = inner.subarray(0, 30 + "notes.json".length + 2); // B's whole local record
  const hidden = entriesOf();
  hidden[0] = { name: "manifest.json", data: Buffer.alloc(0), method: 0, localExtra: bLocal }; // A, first in the file, at offset 0
  const notes = hidden.findIndex((e) => e.name === "notes.json");
  hidden[notes] = { ...hidden[notes]!, centralOffset: 30 + "manifest.json".length }; // B points just past A's name, into A's extra
  await assert.rejects(readArchive(zipOf(hidden)), (e: unknown) => {
    assert.ok(e instanceof ArchiveError);
    assert.equal(e.code, "ARCHIVE_CORRUPT");
    assert.match(e.message, /overlaps/);
    return true;
  });
  // A local extra field alone is harmless.
  await accepted(zipOf(entriesOf().map((e) => ({ ...e, localExtra: Buffer.from("abcd") }))));
  // Directory offset past the data.
  await refused(zipOf(tamper("notes.json", (e) => { e.centralOffset = 0x7fffffff; })), "ARCHIVE_CORRUPT");
});

test("a cancelled read stops with ARCHIVE_CANCELLED", async () => {
  const ac = new AbortController();
  ac.abort();
  await refused(zipOf(entriesOf()), "ARCHIVE_CANCELLED", undefined, ac.signal);
});

test("archive content must agree with checksums.json and attachments.json", async () => {
  // A file listed in checksums.json that the ZIP does not hold.
  const missing = new Map(base);
  missing.delete("notes.json");
  const manifest = new Map(base);
  const sums = JSON.parse(manifest.get("checksums.json")!.toString("utf8"));
  const listed = entriesOf().filter((e) => e.name !== "notes.json");
  assert.ok(sums.files.some((f: { path: string }) => f.path === "notes.json"));
  await refused(zipOf(listed), "ARCHIVE_MISSING_FILE"); // notes.json is a required file
  // An attachment file attachments.json does not describe.
  const extra = new Map(base);
  const stray = Buffer.from("stray bytes");
  extra.set(`attachments/${sha256(stray)}`, stray);
  await refused(archiveFromFiles(extra), "ARCHIVE_UNEXPECTED_FILE");
  // An attachment stored under a name that is not its hash.
  const wrongName = new Map(base);
  const sha = [...base.keys()].find((k) => k.startsWith("attachments/"))!;
  wrongName.delete(sha);
  wrongName.set(`attachments/${"c".repeat(64)}`, base.get(sha)!);
  await refused(archiveFromFiles(wrongName), "ARCHIVE_CHECKSUM_MISMATCH");
});

test("JSON is strict: BOM, duplicate keys, null, huge integers, fractions that are whole numbers, trailing text", async () => {
  const edit = (path: string, fn: (text: string) => string | Buffer): Buffer => {
    const files = new Map(base);
    const out = fn(files.get(path)!.toString("utf8"));
    files.set(path, Buffer.isBuffer(out) ? out : Buffer.from(out));
    return archiveFromFiles(files);
  };
  await refused(edit("notes.json", (t) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(t)])), "ARCHIVE_INVALID_JSON");
  await refused(edit("notes.json", () => '[{"id":"x","id":"y"}]'), "ARCHIVE_INVALID_JSON");
  await refused(edit("notes.json", (t) => `${t} trailing`), "ARCHIVE_INVALID_JSON");
  await refused(edit("notes.json", () => "[1,]"), "ARCHIVE_INVALID_JSON");
  await refused(edit("notes.json", () => "[" .repeat(200) + "]".repeat(200)), "ARCHIVE_INVALID_JSON"); // nesting
  await refused(edit("notes.json", () => "[NaN]"), "ARCHIVE_INVALID_JSON");
  await refused(edit("notes.json", () => '["\\ud800"]'), "ARCHIVE_INVALID_JSON"); // unpaired surrogate escape
  await refused(edit("notes.json", () => "[null]"), "SCHEMA_VIOLATION");
  await refused(edit("notes.json", () => "[9007199254740993]"), "SCHEMA_VIOLATION");
  await refused(edit("notes.json", () => "[1.0]"), "SCHEMA_VIOLATION");
  await refused(edit("notes.json", () => "{}"), "SCHEMA_VIOLATION"); // wrong top-level type
  await refused(edit("notes.json", () => Buffer.from([0x5b, 0xff, 0x5d])), "ARCHIVE_INVALID_UTF8");
});

test("a __proto__ key in an open record or in the manifest is an ordinary property and pollutes nothing", async () => {
  const files = new Map(base);
  const lib = files.get("library.json")!.toString("utf8").replace(/("books"\s*:\s*\[\s*\{)/, '$1"__proto__":{"polluted":true},');
  assert.ok(lib.includes("__proto__"));
  files.set("library.json", Buffer.from(lib));
  const manifest = files.get("manifest.json")!.toString("utf8").replace(/^\{/, '{"__proto__":{"polluted":"manifest"},');
  assert.ok(manifest.includes("__proto__"));
  files.set("manifest.json", Buffer.from(manifest));
  const c = await readArchive(archiveFromFiles(files));
  try {
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal(Object.hasOwn(c.data.library.books[0], "__proto__"), true);
    // The manifest key is an own property of manifestExtra and the prototype is untouched.
    assert.equal(Object.hasOwn(c.data.manifestExtra, "__proto__"), true);
    assert.equal(Object.getPrototypeOf(c.data.manifestExtra), Object.prototype);
    // It survives a write and a second read.
    await withTempDir(async (dir) => {
      const dest = `${dir}/again.rolltop`;
      await writeArchive(c.data, async (sha) => c.attachments.get(sha)!.read(), dest);
      const again = await readArchive(dest);
      try {
        assert.equal(Object.hasOwn(again.data.manifestExtra, "__proto__"), true);
        assert.deepEqual(Object.getOwnPropertyDescriptor(again.data.manifestExtra, "__proto__")?.value, { polluted: "manifest" });
        assert.equal(Object.hasOwn(again.manifest, "__proto__"), true);
        assert.equal(({} as Record<string, unknown>).polluted, undefined);
      } finally {
        await again.close();
      }
    });
  } finally {
    await c.close();
  }
});

test("manifest: not Rolltop, newer version, missing fields, library id mismatch, pinned checksums", async () => {
  const editManifest = (fn: (m: any) => void): Buffer => {
    const entries = entriesOf();
    const m = JSON.parse(entries.find((e) => e.name === "manifest.json")!.data.toString("utf8")); // its pin is correct
    fn(m);
    return zipOf(entries.map((e) => (e.name === "manifest.json" ? { ...e, data: Buffer.from(JSON.stringify(m)) } : e)));
  };
  await refused(editManifest((m) => { m.format = "something-else"; }), "ARCHIVE_NOT_ROLLTOP");
  await refused(editManifest((m) => { m.formatVersion = 2; }), "ARCHIVE_UNSUPPORTED_VERSION");
  await refused(editManifest((m) => { m.formatVersion = 1000000; }), "ARCHIVE_UNSUPPORTED_VERSION");
  await refused(editManifest((m) => { m.formatVersion = 0; }), "SCHEMA_VIOLATION");
  await refused(editManifest((m) => { delete m.generator; }), "SCHEMA_VIOLATION");
  await refused(editManifest((m) => { m.libraryId = "20000001-0000-4000-8000-000000000001"; }), "INTEGRITY_VIOLATION");
  await refused(editManifest((m) => { m.checksums.sha256 = "0".repeat(64); }), "ARCHIVE_CHECKSUM_MISMATCH");
  await refused(editManifest((m) => { m.checksums.byteLength += 1; }), "ARCHIVE_CHECKSUM_MISMATCH");
});

test("a file source: a file that shrinks after opening is ARCHIVE_CORRUPT, and a read on a closed handle is ARCHIVE_IO_ERROR", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "a.bin");
    await writeFile(file, Buffer.alloc(100, 1));
    const src = await fileSource(file);
    assert.equal((await src.read(0, 10)).length, 10);
    await truncate(file, 20);
    await assert.rejects(src.read(0, 100), (e: unknown) => e instanceof ArchiveError && e.code === "ARCHIVE_CORRUPT" && /shorter/.test(e.message));
    await src.close();
    // The read-failure branch (a raw read error, for example EIO or EBADF) goes through the same wrapper; the closed handle triggers it (a failing close() has no seam and is untested).
    await assert.rejects(src.read(0, 10), (e: unknown) => e instanceof ArchiveError && e.code === "ARCHIVE_IO_ERROR");
  });
});
