import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { ArchiveError, importArchive, readArchive, stableStringify, writeArchive, FILE_FIELDS } from "../src/index.ts";
import type { ArchiveContents } from "../src/index.ts";
import { archiveFixtures, listFilesRecursive, readJSON, sha256, unpackedFiles, withTempDir } from "./helpers.ts";

// Every case comes from the vendored expected.json, never from a hand-written list.
const expected: Record<string, string> = readJSON("archives", "expected.json");
const folderExists = async (p: string): Promise<boolean> => (await stat(p).catch(() => undefined))?.isDirectory() === true;
const groups = { valid: 3, invalid: 17, malicious: 10 } as const;

test("expected.json has the documented counts (3 valid, 17 invalid, 10 malicious)", () => {
  for (const [group, count] of Object.entries(groups)) {
    assert.equal(Object.keys(expected).filter((k) => k.startsWith(`${group}/`)).length, count, group);
  }
});

test("every .rolltop fixture on disk is listed in expected.json, and every entry exists", async () => {
  const onDisk: string[] = [];
  for (const group of Object.keys(groups)) {
    for (const f of await readdir(path.join(archiveFixtures, group))) if (f.endsWith(".rolltop")) onDisk.push(`${group}/${f}`);
  }
  assert.deepEqual(onDisk.sort(), Object.keys(expected).sort());
});

/** Canonical form of everything an archive says except the manifest's per-export fields. */
function semantic(c: ArchiveContents): string {
  const out: Record<string, unknown> = { manifestExtra: c.data.manifestExtra, libraryId: c.manifest.libraryId };
  for (const [, field] of FILE_FIELDS) out[field] = c.data[field];
  out.documents = Object.fromEntries([...c.data.documents].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  return stableStringify(out);
}

for (const [fixture, code] of Object.entries(expected)) {
  const file = path.join(archiveFixtures, fixture);
  if (code === "VALID") {
    test(`${fixture}: accepted and round-trips to the same content`, async () => {
      const first = await readArchive(file);
      try {
        // Where the fixture also exists unpacked, every file is verified against that copy.
        const name = path.basename(fixture, ".rolltop");
        if (await folderExists(path.join(archiveFixtures, "valid", name))) {
          const unpacked = await unpackedFiles(name);
          for (const [p, field] of FILE_FIELDS) {
            assert.equal(stableStringify(first.data[field]), stableStringify(JSON.parse(unpacked.get(p)!.toString("utf8"))), p);
          }
          assert.equal(first.data.documents.size, [...unpacked.keys()].filter((k) => k.startsWith("manuscript/")).length);
          for (const [sha, att] of first.attachments) {
            const attName = [...unpacked.keys()].find((k) => k.startsWith(`attachments/${sha}`))!;
            assert.ok((await att.read()).equals(unpacked.get(attName)!), `attachment ${sha}`);
          }
        }
        await withTempDir(async (dir) => {
          const out = path.join(dir, "out.rolltop");
          await writeArchive(first.data, async (s) => first.attachments.get(s)!.read(), out);
          const second = await readArchive(out);
          try {
            assert.equal(semantic(second), semantic(first));
            assert.deepEqual([...second.attachments.keys()].sort(), [...first.attachments.keys()].sort());
            for (const [sha, att] of second.attachments) assert.ok((await att.read()).equals(await first.attachments.get(sha)!.read()));
            assert.deepEqual(second.warnings, first.warnings);
          } finally {
            await second.close();
          }
        });
      } finally {
        await first.close();
      }
    });
  } else {
    test(`${fixture}: rejected with ${code}`, async () => {
      await assert.rejects(readArchive(file), (e: unknown) => {
        assert.ok(e instanceof ArchiveError, `expected ArchiveError, got ${String(e)}`);
        assert.equal(e.code, code, e.message);
        return true;
      });
    });
  }
}

test("a rejected fixture also leaves a staging-free folder when imported", async () => {
  await withTempDir(async (dir) => {
    for (const [fixture, code] of Object.entries(expected)) {
      if (code === "VALID") continue;
      await assert.rejects(importArchive(path.join(archiveFixtures, fixture), dir), (e: unknown) => e instanceof ArchiveError && e.code === code);
    }
    assert.deepEqual(await listFilesRecursive(dir), []);
    assert.deepEqual(await readdir(dir), []);
  });
});

test("valid fixtures import to a folder identical to the unpacked fixture", async () => {
  for (const name of ["sample-library", "record-overrides", "unknown-optional-fields"]) {
    await withTempDir(async (dir) => {
      const result = await importArchive(path.join(archiveFixtures, "valid", `${name}.rolltop`), dir);
      const files = await listFilesRecursive(result.directory);
      const unpackedDir = path.join(archiveFixtures, "valid", name);
      let reference: string[] | undefined;
      try { reference = await listFilesRecursive(unpackedDir); } catch { reference = undefined; }
      if (reference) {
        assert.deepEqual(files, reference, name);
        for (const f of files) {
          assert.equal(sha256(await readFile(path.join(result.directory, f))), sha256(await readFile(path.join(unpackedDir, f))), `${name}/${f}`);
        }
      } else {
        assert.ok(files.includes("manifest.json"), name);
      }
    });
  }
});

test("unknown properties on the manifest and on top-level records survive read and write", async () => {
  const file = path.join(archiveFixtures, "valid", "unknown-optional-fields.rolltop");
  const first = await readArchive(file);
  try {
    assert.equal(first.data.manifestExtra["x-futureManifestProperty"], true);
    assert.deepEqual(first.data.library.books[0]["x-futureBookProperty"], { series: "preserve me", n: 7 });
    await withTempDir(async (dir) => {
      const out = path.join(dir, "out.rolltop");
      await writeArchive(first.data, async (s) => first.attachments.get(s)!.read(), out);
      const second = await readArchive(out);
      try {
        assert.equal(second.manifest["x-futureManifestProperty"], true);
        assert.deepEqual(stableStringify(second.data.library.books[0]["x-futureBookProperty"]), stableStringify({ series: "preserve me", n: 7 }));
      } finally {
        await second.close();
      }
    });
  } finally {
    await first.close();
  }
});
