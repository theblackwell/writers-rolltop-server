import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ArchiveError, readArchive } from "@writers-rolltop/archive";
import { Store, StoreError, importArchiveBytes } from "../src/index.ts";
import { scratch } from "./helpers.ts";
import { semantic } from "./semantic.ts";

const fixtures = fileURLToPath(new URL("../../document-adapter/test/spec/fixtures/archives", import.meta.url));
const expected: Record<string, string> = JSON.parse(await readFile(path.join(fixtures, "expected.json"), "utf8"));

const libraryCount = async (s: { pool: { query: (q: string) => Promise<any> } }) =>
  Number((await s.pool.query("SELECT (SELECT count(*) FROM library) + (SELECT count(*) FROM attachment) + (SELECT count(*) FROM manuscript_node) AS n")).rows[0].n);

for (const [fixture, code] of Object.entries(expected)) {
  const file = path.join(fixtures, fixture);
  if (code === "VALID") {
    test(`${fixture}: imports, exports, and reads back semantically identical`, async () => {
      const s = await scratch({ migrated: true });
      const out = await mkdtemp(path.join(tmpdir(), "rolltop-rt-"));
      try {
        const original = await readArchive(file);
        try {
          await s.store.importArchive(original);
          assert.deepEqual(await s.store.checkIntegrity(), { ok: true, problems: [] });
          const dest = path.join(out, "out.rolltop");
          await s.store.exportArchive(dest);
          const back = await readArchive(dest);
          try {
            assert.equal(semantic(back.data, back.manifest.libraryId as string), semantic(original.data, original.manifest.libraryId as string));
            assert.deepEqual([...back.attachments.keys()].sort(), [...original.attachments.keys()].sort());
            for (const [sha, f] of original.attachments) assert.ok((await f.read()).equals(await back.attachments.get(sha)!.read()));
            assert.deepEqual(back.warnings.map((w) => w.code).sort(), original.warnings.map((w) => w.code).sort());
          } finally { await back.close(); }
          // A second import into the same database is refused.
          await assert.rejects(s.store.importArchive(original), (e) => e instanceof StoreError && e.code === "LIBRARY_EXISTS");
        } finally { await original.close(); }
      } finally { await rm(out, { recursive: true, force: true }); await s.drop(); }
    });
  } else {
    test(`${fixture}: rejected with ${code} and the database is unchanged`, async () => {
      const s = await scratch({ migrated: true });
      try {
        await assert.rejects(importArchiveBytes(s.store, await readFile(file)), (e) => e instanceof ArchiveError && e.code === code);
        assert.equal(await libraryCount(s), 0);
        assert.deepEqual(await readdir(s.store.attachmentsDir).catch(() => []), []);
      } finally { await s.drop(); }
    });
  }
}

test("second line of defence: a NUL that got past the validator is refused by the store, rolled back, and its attachment files removed", async () => {
  const s = await scratch({ migrated: true });
  try {
    const original = await readArchive(path.join(fixtures, "valid/sample-library.rolltop"));
    // The validator now refuses NUL, so reach the store with data that skips it.
    original.data.library.books[0].title = "bad\u0000title";
    await assert.rejects(s.store.importArchive(original), (e) => {
      assert.ok(e instanceof StoreError && e.code === "INVARIANT_VIOLATED", String(e));
      assert.ok(!String((e as Error).message).includes("bad"), "no data in the message");
      return true;
    });
    await original.close();
    assert.equal(await libraryCount(s), 0);
    assert.deepEqual(await readdir(s.store.attachmentsDir), [], "attachment files written by the failed import are removed");
    assert.deepEqual(await s.store.checkIntegrity(), { ok: true, problems: [] });
  } finally { await s.drop(); }
});

test("unknown properties on top-level records and the manifest survive import and export", async () => {
  const s = await scratch({ migrated: true });
  const out = await mkdtemp(path.join(tmpdir(), "rolltop-rt-"));
  try {
    const original = await readArchive(path.join(fixtures, "valid/unknown-optional-fields.rolltop"));
    assert.ok(Object.keys(original.data.manifestExtra).length > 0, "the fixture carries manifest extras");
    await s.store.importArchive(original);
    const dest = path.join(out, "x.rolltop");
    await s.store.exportArchive(dest);
    const back = await readArchive(dest);
    assert.deepEqual(back.data.manifestExtra, original.data.manifestExtra);
    assert.deepEqual(back.data.library.library, original.data.library.library);
    await back.close(); await original.close();
  } finally { await rm(out, { recursive: true, force: true }); await s.drop(); }
});

/** A Store whose connection runs COMMIT for real, then fails as if the answer was lost (or fails before running it). */
function lossyStore(real: import("pg").Pool, attachmentsDir: string, mode: "after" | "before") {
  const pool = {
    query: (...a: unknown[]) => (real.query as any)(...a),
    connect: async () => {
      const c = await real.connect();
      const query = async (sql: unknown, ...rest: unknown[]) => {
        if (sql === "COMMIT") {
          if (mode === "before") { await (c.query as any)("ROLLBACK"); throw new Error("connection terminated"); }
          await (c.query as any)("COMMIT");
          throw new Error("connection terminated");
        }
        return (c.query as any)(sql, ...rest);
      };
      return new Proxy(c, { get: (t, p) => (p === "query" ? query : (t as any)[p] instanceof Function ? (t as any)[p].bind(t) : (t as any)[p]) });
    },
  };
  return new Store({ pool: pool as any, attachmentsDir });
}

test("a COMMIT whose answer is lost, but which did commit, keeps the attachment files and reports success", async () => {
  const s = await scratch({ migrated: true });
  try {
    const original = await readArchive(path.join(fixtures, "valid/sample-library.rolltop"));
    const store = lossyStore(s.pool, s.store.attachmentsDir, "after");
    const result = await store.importArchive(original);
    assert.equal(result.summary.libraryId, original.manifest.libraryId);
    assert.equal(Number((await s.pool.query("SELECT count(*) AS n FROM library")).rows[0].n), 1);
    assert.equal((await readdir(s.store.attachmentsDir)).length, 3, "the committed attachments' files are still there");
    assert.deepEqual(await s.store.checkIntegrity(), { ok: true, problems: [] });
    await original.close();
  } finally { await s.drop(); }
});

test("a COMMIT that failed and did not commit removes the files this import created", async () => {
  const s = await scratch({ migrated: true });
  try {
    const original = await readArchive(path.join(fixtures, "valid/sample-library.rolltop"));
    const store = lossyStore(s.pool, s.store.attachmentsDir, "before");
    await assert.rejects(store.importArchive(original));
    assert.equal(Number((await s.pool.query("SELECT count(*) AS n FROM library")).rows[0].n), 0);
    assert.deepEqual(await readdir(s.store.attachmentsDir), []);
    await original.close();
  } finally { await s.drop(); }
});
