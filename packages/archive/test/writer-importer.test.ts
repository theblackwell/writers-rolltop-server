import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { ArchiveError, importArchive, previewArchive, readArchive, stableStringify, writeArchive } from "../src/index.ts";
import type { ArchiveData } from "../src/index.ts";
import { archiveFixtures, listFilesRecursive, loadSample, samplePath, sha256, unpackedFiles, withTempDir } from "./helpers.ts";

const SENTINEL = Buffer.from("PREVIOUS EXPORT, DO NOT LOSE ME");

async function codeOf(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { assert.ok(e instanceof ArchiveError, String(e)); return e.code; }
  return assert.fail("expected the call to be refused");
}

// ---- writer ----

test("export keeps an existing file until the new archive is complete", async () => {
  const { data, attachments } = await loadSample();
  await withTempDir(async (dir) => {
    const dest = path.join(dir, "library.rolltop");
    await writeFile(dest, SENTINEL);
    const provide = async (sha: string) => attachments.get(sha)!;

    // The destination is still the old file while the last attachment is being fetched.
    const shas = data.attachments.map((a) => a.sha256);
    let seenDuringWrite: Buffer | undefined;
    let partialsDuringWrite: string[] = [];
    await writeArchive(data, async (sha) => {
      if (sha === shas[shas.length - 1] || sha === [...shas].sort()[shas.length - 1]) {
        seenDuringWrite = await readFile(dest);
        partialsDuringWrite = (await readdir(dir)).filter((f) => f.includes("partial"));
      }
      return provide(sha);
    }, dest);
    assert.ok(seenDuringWrite?.equals(SENTINEL), "the old file was still in place while writing");
    assert.equal(partialsDuringWrite.length, 1, "the new archive is built in a hidden partial file");
    assert.ok(partialsDuringWrite[0]!.startsWith(".library.rolltop.partial-"));
    const written = await readArchive(dest);
    await written.close();
    assert.deepEqual(await readdir(dir), ["library.rolltop"]);
  });
});

test("export failures leave the existing file untouched and remove the partial file", async () => {
  const { data, attachments } = await loadSample();
  await withTempDir(async (dir) => {
    const dest = path.join(dir, "library.rolltop");
    const reset = async () => writeFile(dest, SENTINEL);
    const unchanged = async () => {
      assert.ok((await readFile(dest)).equals(SENTINEL), "destination changed");
      assert.deepEqual(await readdir(dir), ["library.rolltop"], "leftover files");
    };
    const good = async (sha: string) => attachments.get(sha)!;

    await reset();
    assert.equal(await codeOf(writeArchive(data, async () => { throw new Error("store unavailable"); }, dest)), "ARCHIVE_MISSING_FILE");
    await unchanged();

    let n = 0;
    assert.equal(await codeOf(writeArchive(data, async (sha) => { if (++n === 2) throw new Error("store dropped out"); return good(sha); }, dest)), "ARCHIVE_MISSING_FILE");
    await unchanged();

    assert.equal(await codeOf(writeArchive(data, async (sha) => Buffer.from(`${sha} but not these bytes`), dest)), "ARCHIVE_CHECKSUM_MISMATCH");
    await unchanged();

    const broken = structuredClone(data);
    broken.library.manuscriptNodes[0].kind = "nonsense";
    assert.equal(await codeOf(writeArchive(broken, good, dest)), "SCHEMA_VIOLATION");
    await unchanged();

    const unresolved = structuredClone(data);
    unresolved.notes[0].bookId = "a0000000-0000-4000-8000-00000000dead";
    assert.equal(await codeOf(writeArchive(unresolved, good, dest)), "REFERENCE_UNRESOLVED");
    await unchanged();

    const badDoc = structuredClone(data);
    const id = [...badDoc.documents.keys()][0]!;
    (badDoc.documents.get(id) as any).blocks[0].id = "NOT-A-UUID";
    assert.equal(await codeOf(writeArchive(badDoc, good, dest)), "DOCUMENT_INVALID");
    await unchanged();

    const ac = new AbortController();
    let calls = 0;
    assert.equal(await codeOf(writeArchive(data, async (sha) => { if (++calls === 1) ac.abort(); return good(sha); }, dest, { signal: ac.signal })), "ARCHIVE_CANCELLED");
    await unchanged();

    // A folder where the file should go, and a missing folder.
    assert.equal(await codeOf(writeArchive(data, good, path.join(dir, "no-such-folder", "x.rolltop"))), "ARCHIVE_IO_ERROR");
    await rm(dest);
    await mkdir(dest);
    assert.equal(await codeOf(writeArchive(data, good, dest)), "ARCHIVE_IO_ERROR");
    assert.deepEqual(await readdir(dir), ["library.rolltop"]);
  });
});

test("export is deterministic for fixed archive id and time, and lists files in the canonical order", async () => {
  const { data, attachments } = await loadSample();
  await withTempDir(async (dir) => {
    const opts = { archiveId: "a0000000-0000-4000-8000-0000000000aa", createdAt: "2026-11-09T00:00:00Z" };
    const provide = async (sha: string) => attachments.get(sha)!;
    await writeArchive(data, provide, path.join(dir, "a.rolltop"), opts);
    await writeArchive(data, provide, path.join(dir, "b.rolltop"), opts);
    assert.ok((await readFile(path.join(dir, "a.rolltop"))).equals(await readFile(path.join(dir, "b.rolltop"))));
    const c = await readArchive(path.join(dir, "a.rolltop"));
    try {
      assert.equal(c.manifest.archiveId, opts.archiveId);
      assert.deepEqual(c.manifest.generator, { name: "@writers-rolltop/archive", version: "0.0.0" });
    } finally {
      await c.close();
    }
  });
});

test("export output is a standard ZIP: the system unzip tests it clean, with manifest first", async (t) => {
  const probe = spawnSync("unzip", ["-v"]);
  if (probe.error || probe.status !== 0) return t.skip("unzip is not installed");
  const { data, attachments } = await loadSample();
  await withTempDir(async (dir) => {
    const out = path.join(dir, "x.rolltop");
    await writeArchive(data, async (s) => attachments.get(s)!, out);
    const test = spawnSync("unzip", ["-tq", out], { encoding: "utf8" });
    assert.equal(test.status, 0, test.stdout + test.stderr);
    const list = spawnSync("unzip", ["-Z1", out], { encoding: "utf8" }).stdout.trim().split("\n");
    assert.equal(list[0], "manifest.json");
    assert.equal(list[1], "checksums.json");
    assert.deepEqual(list.slice(2), [...list.slice(2)].sort());
    assert.equal(list.length, 2 + (await unpackedFiles("sample-library")).size - 2);
  });
});

test("export emits normalized documents and keeps highly compressible content under the ratio limit", async () => {
  const { data, attachments } = await loadSample();
  const nodeId = [...data.documents.keys()][0]!;
  const doc: any = structuredClone(data.documents.get(nodeId));
  doc.blocks[0] = { id: doc.blocks[0].id, type: "paragraph", content: [{ type: "text", text: "one\r\ntwo" }, { type: "text", text: "", marks: [] }] };
  data.documents.set(nodeId, doc);
  // A 3 MiB value of one repeated letter compresses far better than 200:1.
  const entry = data.entries.find((e) => e.templateId !== undefined)!;
  const field = { id: "a0000000-0000-4000-8000-000000000f01", templateId: entry.templateId, key: "bulk", label: "Bulk", fieldType: "longText", required: false, orderKey: "z", createdAt: "2026-11-02T12:00:00Z", updatedAt: "2026-11-02T12:00:00Z" };
  data.fields.push(field);
  entry.values[field.id] = "a".repeat(3 * 1024 * 1024);
  await withTempDir(async (dir) => {
    const out = path.join(dir, "x.rolltop");
    await writeArchive(data, async (s) => attachments.get(s)!, out);
    const back = await readArchive(out);
    try {
      const written: any = back.data.documents.get(nodeId);
      assert.deepEqual(written.blocks[0].content, [{ type: "text", text: "one" }, { type: "hardBreak" }, { type: "text", text: "two" }]);
      assert.equal(back.data.entries.find((e) => e.id === entry.id)!.values[field.id].length, 3 * 1024 * 1024);
    } finally {
      await back.close();
    }
  });
});

// ---- importer ----

test("import creates <libraryId>/ holding exactly the archive's files, with nothing left behind", async () => {
  await withTempDir(async (root) => {
    const result = await importArchive(samplePath, root);
    assert.equal(result.libraryId, "10000001-0000-4000-8000-000000000001");
    assert.equal(result.replaced, false);
    assert.equal(path.basename(result.directory), result.libraryId);
    assert.deepEqual(await readdir(root), [result.libraryId]);
    const reference = await unpackedFiles("sample-library");
    assert.deepEqual(await listFilesRecursive(result.directory), [...reference.keys()].sort());
    for (const [p, bytes] of reference) assert.ok((await readFile(path.join(result.directory, p))).equals(bytes), p);
    assert.equal(result.summary.books, 3);
    assert.deepEqual(result.warnings, []);
    assert.equal(((await stat(path.join(result.directory, "manifest.json"))).mode & 0o077), 0, "staged files are private");
  });
});

test("import from bytes works the same as from a path", async () => {
  await withTempDir(async (root) => {
    const result = await importArchive(await readFile(samplePath), root);
    assert.deepEqual(await readdir(root), [result.libraryId]);
  });
});

test("an existing library is refused without approval, and left untouched", async () => {
  await withTempDir(async (root) => {
    const first = await importArchive(samplePath, root);
    await writeFile(path.join(first.directory, "marker.txt"), "mine");
    assert.equal(await codeOf(importArchive(samplePath, root)), "ARCHIVE_ALREADY_EXISTS");
    assert.deepEqual(await readdir(root), [first.libraryId]);
    assert.equal(await readFile(path.join(first.directory, "marker.txt"), "utf8"), "mine");
  });
});

test("replacing needs explicit approval and keeps the old library whole as a backup", async () => {
  await withTempDir(async (root) => {
    const first = await importArchive(samplePath, root);
    await writeFile(path.join(first.directory, "marker.txt"), "mine");
    const second = await importArchive(path.join(archiveFixtures, "valid", "record-overrides.rolltop"), root, { replaceExisting: true });
    assert.equal(second.replaced, true);
    assert.ok(second.backup);
    assert.equal(await readFile(path.join(second.backup!, "marker.txt"), "utf8"), "mine");
    assert.ok(second.backup!.startsWith(`${second.directory}.replaced-`));
    await assert.rejects(stat(path.join(second.directory, "marker.txt")));
    assert.equal((await readdir(root)).length, 2);
    const names = await readdir(root);
    assert.ok(!names.some((n) => n.startsWith(".import-")));
  });
});

test("a failure before the move leaves the destination folder as it was", async () => {
  await withTempDir(async (root) => {
    await writeFile(path.join(root, "keep.txt"), "x");
    const before = await readdir(root);
    await assert.rejects(importArchive(samplePath, root, { beforeCommit: () => { throw new Error("disk full"); } }), /disk full/);
    assert.deepEqual(await readdir(root), before);
    const ac = new AbortController();
    assert.equal(await codeOf(importArchive(samplePath, root, { signal: ac.signal, beforeCommit: () => ac.abort() })), "ARCHIVE_CANCELLED");
    assert.deepEqual(await readdir(root), before);
  });
});

test("if the final move fails during a replacement, the previous library is put back", async () => {
  await withTempDir(async (root) => {
    const first = await importArchive(samplePath, root);
    await writeFile(path.join(first.directory, "marker.txt"), "mine");
    const names = async () => (await readdir(root)).sort();
    const before = await names();
    // Remove the staging folder just before the commit, so the second rename of the swap fails.
    const sabotage = async () => {
      for (const n of await readdir(root)) if (n.startsWith(".import-")) await rm(path.join(root, n), { recursive: true, force: true });
    };
    await assert.rejects(importArchive(samplePath, root, { replaceExisting: true, beforeCommit: sabotage }), (e: unknown) => e instanceof ArchiveError && e.code === "ARCHIVE_IO_ERROR");
    assert.deepEqual(await names(), before, "no backup or staging left behind");
    assert.equal(await readFile(path.join(first.directory, "marker.txt"), "utf8"), "mine");
  });
});

test("preview validates and reports, and writes nothing", async () => {
  await withTempDir(async (root) => {
    let p = await previewArchive(samplePath, root);
    assert.equal(p.summary.title, "The Black Well Foundry Library");
    assert.equal(p.targetExists, false);
    assert.ok(p.summary.words > 0);
    assert.deepEqual(await readdir(root), []);
    await importArchive(samplePath, root);
    p = await previewArchive(samplePath, root);
    assert.equal(p.targetExists, true);
    await assert.rejects(previewArchive(path.join(archiveFixtures, "malicious", "zip-bomb.rolltop"), root), (e: unknown) => e instanceof ArchiveError && e.code === "ARCHIVE_TOO_LARGE");
  });
});

test("the libraries folder may be a symbolic link to a folder", async (t) => {
  if (process.platform === "win32") return t.skip("symbolic links need privileges on Windows");
  await withTempDir(async (dir) => {
    const real = path.join(dir, "real-libraries");
    const link = path.join(dir, "libraries-link");
    await mkdir(real);
    await symlink(real, link, "dir");
    const result = await importArchive(samplePath, link);
    assert.equal(result.libraryId, "10000001-0000-4000-8000-000000000001");
    assert.deepEqual(await readdir(real), [result.libraryId]);
    // A link to something that is not a folder is still refused, with the I/O error.
    await writeFile(path.join(dir, "plain-file"), "x");
    await symlink(path.join(dir, "plain-file"), path.join(dir, "file-link"));
    assert.equal(await codeOf(importArchive(samplePath, path.join(dir, "file-link"))), "ARCHIVE_IO_ERROR");
  });
});

test("an export file is private (0600), also after the rename over an existing file", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX modes");
  const { data, attachments } = await loadSample();
  await withTempDir(async (dir) => {
    const dest = path.join(dir, "library.rolltop");
    const provide = async (sha: string) => attachments.get(sha)!;
    await writeArchive(data, provide, dest);
    assert.equal((await stat(dest)).mode & 0o777, 0o600);
    await writeFile(dest, SENTINEL, { mode: 0o644 });
    await chmod(dest, 0o644);
    await writeArchive(data, provide, dest);
    assert.equal((await stat(dest)).mode & 0o777, 0o600);
  });
});

test("a file system failure while exporting is an ARCHIVE_IO_ERROR, not a raw error", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) return t.skip("needs a POSIX folder that cannot be written, and not root");
  const { data, attachments } = await loadSample();
  await withTempDir(async (dir) => {
    const locked = path.join(dir, "locked");
    await mkdir(locked);
    await chmod(locked, 0o500);
    try {
      assert.equal(await codeOf(writeArchive(data, async (sha) => attachments.get(sha)!, path.join(locked, "x.rolltop"))), "ARCHIVE_IO_ERROR");
    } finally {
      await chmod(locked, 0o700);
    }
  });
});

test("import of a missing file or a missing destination folder is an I/O error", async () => {
  await withTempDir(async (root) => {
    assert.equal(await codeOf(importArchive(path.join(root, "nope.rolltop"), root)), "ARCHIVE_IO_ERROR");
    assert.equal(await codeOf(importArchive(samplePath, path.join(root, "no-folder"))), "ARCHIVE_IO_ERROR");
    assert.deepEqual(await readdir(root), []);
  });
});

test("export then import round-trips an archive to the same content", async () => {
  const src = await readArchive(path.join(archiveFixtures, "valid", "record-overrides.rolltop"));
  try {
    await withTempDir(async (dir) => {
      const out = path.join(dir, "again.rolltop");
      await writeArchive(src.data, async (s) => src.attachments.get(s)!.read(), out);
      const root = path.join(dir, "libs");
      await mkdir(root);
      const result = await importArchive(out, root);
      const lib = JSON.parse(await readFile(path.join(result.directory, "library.json"), "utf8"));
      assert.equal(stableStringify(lib), stableStringify(src.data.library));
      const att = [...src.attachments.values()][0]!;
      assert.equal(sha256(await readFile(path.join(result.directory, att.path))), att.sha256);
    });
  } finally {
    await src.close();
  }
});

test("data typed as ArchiveData can be built from a fixture and written without the reader", async () => {
  const { data, attachments } = await loadSample("sample-library");
  const minimal: ArchiveData = { ...data, manifestExtra: {} };
  await withTempDir(async (dir) => {
    const out = path.join(dir, "m.rolltop");
    const r = await writeArchive(minimal, async (s) => attachments.get(s)!, out);
    assert.equal(r.fileCount, (await unpackedFiles("sample-library")).size);
    assert.ok(r.byteLength > 0);
  });
});
