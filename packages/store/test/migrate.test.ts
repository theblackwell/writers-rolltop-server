import { test } from "node:test";
import assert from "node:assert/strict";
import { stat, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { migrate, loadMigrations, assertNoTransactionControl, Store, StoreError } from "../src/index.ts";
import type { Migration } from "../src/index.ts";
import { scratch, pgDumpPath } from "./helpers.ts";

const m1: Migration = { id: "0001-a", sql: "CREATE TABLE a (x int);" };
const m2: Migration = { id: "0002-b", sql: "CREATE TABLE b (x int);" };

async function withDb(fn: (s: Awaited<ReturnType<typeof scratch>>) => Promise<void>) {
  const s = await scratch();
  try { await fn(s); } finally { await s.drop(); }
}
const opts = (s: { url: string; dir: string }, migrations?: Migration[]) =>
  ({ url: s.url, backupDir: join(s.dir, "backups"), pgDump: pgDumpPath(), migrations });
const tables = async (pool: pg.Pool) =>
  (await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1")).rows.map((r) => r.table_name as string);
const applied = async (pool: pg.Pool) =>
  (await pool.query("SELECT id FROM schema_migrations ORDER BY id")).rows.map((r) => r.id as string);
const code = (c: string) => (e: unknown) => e instanceof StoreError && e.code === c;

test("fresh database applies the bundled 0001, and a second run is a no-op", async () => {
  await withDb(async (s) => {
    const bundled = await loadMigrations();
    assert.equal(bundled[0]?.id, "0001-initial");
    const first = await migrate(opts(s));
    assert.deepEqual(first.applied, bundled.map((m) => m.id));
    assert.equal(first.backupFile, undefined, "a fresh database needs no backup");
    const t = await tables(s.pool);
    for (const name of ["library", "universe", "series", "book", "attachment", "manuscript_node", "scene_document", "document_revision", "schema_migrations"]) {
      assert.ok(t.includes(name), `missing table ${name}`);
    }
    const second = await migrate(opts(s));
    assert.deepEqual(second, { applied: [] });
    assert.deepEqual(await applied(s.pool), bundled.map((m) => m.id));
  });
});

test("an applied id this build does not know is refused as SCHEMA_TOO_NEW and nothing changes", async () => {
  await withDb(async (s) => {
    await migrate(opts(s, [m1, m2]));
    await assert.rejects(migrate(opts(s, [m1])), (e) => {
      assert.ok(code("SCHEMA_TOO_NEW")(e));
      assert.match((e as Error).message, /created by a newer version of Writers Rolltop; update to open it/);
      return true;
    });
    assert.deepEqual(await applied(s.pool), ["0001-a", "0002-b"]);
    assert.deepEqual(await tables(s.pool), ["a", "b", "schema_migrations"]);
  });
});

test("an edited applied migration is refused as MIGRATION_CHECKSUM_MISMATCH", async () => {
  await withDb(async (s) => {
    await migrate(opts(s, [m1]));
    await assert.rejects(migrate(opts(s, [{ id: m1.id, sql: "CREATE TABLE a (x int, y int);" }, m2])), code("MIGRATION_CHECKSUM_MISMATCH"));
    assert.deepEqual(await tables(s.pool), ["a", "schema_migrations"]);
  });
});

test("applied ids that are not a prefix of the known list are refused", async () => {
  await withDb(async (s) => {
    await migrate(opts(s, [m1, m2]));
    const m15: Migration = { id: "0001-aa", sql: "SELECT 1;" };
    await assert.rejects(migrate(opts(s, [m1, m15, m2])), code("MIGRATION_HISTORY_MISMATCH"));
  });
});

test("a pending migration on an existing database writes a non-empty backup first", async () => {
  await withDb(async (s) => {
    await migrate(opts(s, [m1]));
    const r = await migrate(opts(s, [m1, m2]));
    assert.deepEqual(r.applied, ["0002-b"]);
    assert.ok(r.backupFile, "backup file path returned");
    assert.ok((await stat(r.backupFile!)).size > 0);
    assert.match(r.backupFile!, new RegExp(`${s.name}-.*-before-0002-b\\.dump$`));
    assert.deepEqual(await applied(s.pool), ["0001-a", "0002-b"]);
  });
});

test("a failing migration rolls back fully and reports its id", async () => {
  await withDb(async (s) => {
    const bad: Migration = { id: "0002-bad", sql: "CREATE TABLE c (x int); SELECT 1/0;" };
    await assert.rejects(migrate(opts(s, [m1, bad])), (e) => {
      assert.ok(code("MIGRATION_FAILED")(e));
      assert.equal((e as StoreError).details?.id, "0002-bad");
      return true;
    });
    assert.deepEqual(await tables(s.pool), ["a", "schema_migrations"], "m1 stays, bad left no table");
    assert.deepEqual(await applied(s.pool), ["0001-a"]);
    // The very first migration failing leaves no schema_migrations row either.
    const s2 = await scratch();
    try {
      await assert.rejects(migrate(opts(s2, [{ id: "0001-bad", sql: "CREATE TABLE z (x int); SELECT 1/0;" }])), code("MIGRATION_FAILED"));
      assert.deepEqual(await tables(s2.pool), ["schema_migrations"]);
      assert.deepEqual(await applied(s2.pool), []);
    } finally { await s2.drop(); }
  });
});

test("BACKUP_FAILED with an unusable pg_dump applies nothing", async () => {
  await withDb(async (s) => {
    await migrate(opts(s, [m1]));
    await assert.rejects(
      migrate({ ...opts(s, [m1, m2]), pgDump: "/nonexistent/pg_dump" }), code("BACKUP_FAILED"));
    assert.deepEqual(await tables(s.pool), ["a", "schema_migrations"]);
    assert.deepEqual(await applied(s.pool), ["0001-a"]);
  });
});

test("the password never appears in pg_dump arguments", async () => {
  await withDb(async (s) => {
    await migrate(opts(s, [m1]));
    const u = new URL(s.url);
    u.password = "s3cret-pw";
    // A fake pg_dump that records argv and env, then fails; we only inspect what it was given.
    const { writeFile, chmod, readFile } = await import("node:fs/promises");
    const fake = join(s.dir, "fake-pg-dump.sh");
    await writeFile(fake, `#!/bin/sh\necho "$@" > "${s.dir}/argv.txt"\necho "$PGPASSWORD" > "${s.dir}/env.txt"\nexit 1\n`);
    await chmod(fake, 0o755);
    await assert.rejects(migrate({ url: u.toString(), backupDir: join(s.dir, "backups"), pgDump: fake, migrations: [m1, m2] }), code("BACKUP_FAILED"));
    assert.ok(!(await readFile(join(s.dir, "argv.txt"), "utf8")).includes("s3cret-pw"));
    assert.equal((await readFile(join(s.dir, "env.txt"), "utf8")).trim(), "s3cret-pw");
  });
});

test("migrations that carry transaction control are refused; plpgsql BEGIN/END and comments are fine", async () => {
  for (const sql of ["SELECT '--'; COMMIT;", "SELECT '$$'; COMMIT; SELECT '$$';", "E'\\''; COMMIT; SELECT '';", "/* a /* nested */ still comment */ COMMIT;", "SELECT \"a;b\"; BEGIN;", "SELECT 1; BEGIN;", "x; COMMIT;", "CREATE TABLE t (x int); COMMIT;", "SELECT 1; abort;", "SELECT 1; PREPARE TRANSACTION 'x';", "CREATE TABLE t (x int);\nCOMMIT;", "begin;\nSELECT 1;", "SELECT 1;\n  Rollback;", "END;", "start   transaction;"]) {
    assert.throws(() => assertNoTransactionControl({ id: "0001-x", sql }), code("MIGRATION_FAILED"), sql);
  }
  assert.doesNotThrow(() => assertNoTransactionControl({ id: "0001-x", sql: "-- COMMIT\nCREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$\nBEGIN\n RETURN 1;\nEND $$;" }));
  for (const sql of ["SELECT 'a; COMMIT; b';", "SELECT E'it\\'s; COMMIT;';", "SELECT \"commit\"; SELECT 1;", "/* a /* COMMIT; */ COMMIT; */ SELECT 1;", "SELECT $x$ ; COMMIT; $x$;", "SELECT CASE WHEN true THEN 1\nEND;", "-- COMMIT;\nSELECT 1;"]) {
    assert.doesNotThrow(() => assertNoTransactionControl({ id: "0001-x", sql }), sql);
  }
  assert.doesNotThrow(() => assertNoTransactionControl({ id: "0001-x", sql: "INSERT INTO t VALUES ('a; COMMIT; b', 'it''s; BEGIN;');" }));
  await loadMigrations(); // the bundled files, including 0001-initial.sql, still load
  await withDb(async (s) => {
    await assert.rejects(migrate(opts(s, [{ id: "0001-x", sql: "CREATE TABLE t (x int);\nCOMMIT;" }])), code("MIGRATION_FAILED"));
    assert.deepEqual(await tables(s.pool), []);
  });
  const dir = await mkdtemp(join(tmpdir(), "rolltop-mig-"));
  await writeFile(join(dir, "0001-bad.sql"), "COMMIT;\n");
  await assert.rejects(loadMigrations(dir), code("MIGRATION_FAILED"));
});

test("backup directory is private, the dump is 0600, and a query-string password stays out of argv", async () => {
  await withDb(async (s) => {
    await migrate(opts(s, [m1]));
    const r = await migrate(opts(s, [m1, m2]));
    assert.equal((await stat(r.backupFile!)).mode & 0o777, 0o600);
    assert.equal((await stat(join(s.dir, "backups"))).mode & 0o777, 0o700);

    const { writeFile: wf, chmod, readFile } = await import("node:fs/promises");
    const u = new URL(s.url);
    u.searchParams.set("password", "qs-secret");
    const fake = join(s.dir, "fake.sh");
    await wf(fake, `#!/bin/sh\necho "$@" > "${s.dir}/argv2.txt"\necho "$PGPASSWORD" > "${s.dir}/env2.txt"\nexit 1\n`);
    await chmod(fake, 0o755);
    const m3: Migration = { id: "0003-c", sql: "CREATE TABLE c (x int);" };
    await assert.rejects(migrate({ url: u.toString(), backupDir: join(s.dir, "b2"), pgDump: fake, migrations: [m1, m2, m3] }), code("BACKUP_FAILED"));
    assert.ok(!(await readFile(join(s.dir, "argv2.txt"), "utf8")).includes("qs-secret"));
    assert.equal((await readFile(join(s.dir, "env2.txt"), "utf8")).trim(), "qs-secret");
  });
});

test("migrate() waits for the advisory lock: while another session holds it nothing is applied", async () => {
  await withDb(async (s) => {
    // Hold the runner's lock from a raw client (same key as migrate.ts), start migrate(), and check it is blocked.
    const holder = new pg.Client({ connectionString: s.url });
    await holder.connect();
    let run: Promise<{ applied: string[] }> | undefined;
    try {
      await holder.query("SELECT pg_advisory_lock($1)", [5_203_141_001]);
      let finished = false;
      run = migrate(opts(s, [m1, m2]));
      run.then(() => { finished = true; }, () => { finished = true; }); // a rejection during the wait is handled here
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(finished, false, "migrate() must block on the advisory lock");
      assert.deepEqual(await tables(s.pool), [], "nothing applied while the lock is held");
    } finally {
      await holder.query("SELECT pg_advisory_unlock($1)", [5_203_141_001]).catch(() => {});
      await holder.end().catch(() => {});
    }
    assert.deepEqual((await run!).applied, ["0001-a", "0002-b"]);
  });
});

test("two concurrent migrate() calls on a fresh database: both succeed, one applies, one is a no-op", async () => {
  await withDb(async (s) => {
    const [a, b] = await Promise.all([migrate(opts(s, [m1, m2])), migrate(opts(s, [m1, m2]))]);
    assert.deepEqual([a.applied.length, b.applied.length].sort(), [0, 2]);
    assert.deepEqual(await applied(s.pool), ["0001-a", "0002-b"]);
  });
});

test("a pre-existing 0755 backup directory is tightened to 0700, and the dump is 0600", async () => {
  await withDb(async (s) => {
    const { mkdir, chmod } = await import("node:fs/promises");
    const dir = join(s.dir, "backups");
    await mkdir(dir);
    await chmod(dir, 0o755);
    await migrate(opts(s, [m1]));
    const r = await migrate(opts(s, [m1, m2]));
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(r.backupFile!)).mode & 0o777, 0o600);
  });
});

test("Store.open migrates, and refuses a database that is ahead of this build", async () => {
  await withDb(async (s) => {
    const open = (migrations: Migration[]) => Store.open({ url: s.url, attachmentsDir: join(s.dir, "att"), backupDir: join(s.dir, "backups"), pgDump: pgDumpPath(), migrations });
    const store = await open([m1]);
    assert.deepEqual(await tables(store.pool), ["a", "schema_migrations"]);
    await store.close();
    const ahead = await open([m1, m2]);
    await ahead.close();
    await assert.rejects(open([m1]), code("SCHEMA_TOO_NEW"));
    await ahead.close(); // idempotent: a second close is a no-op
  });
});

test("a pre-existing dump file with the same name is not removed when the backup cannot be created", async () => {
  await withDb(async (s) => {
    const { mkdir, writeFile, readFile } = await import("node:fs/promises");
    await migrate(opts(s, [m1]));
    const now = new Date("2026-11-10T12:00:00Z");
    const dir = join(s.dir, "backups");
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${s.name}-${now.toISOString().replace(/[:.]/g, "-")}-before-0002-b.dump`);
    await writeFile(file, "precious");
    await assert.rejects(migrate({ ...opts(s, [m1, m2]), now: () => now }), code("BACKUP_FAILED"));
    assert.equal(await readFile(file, "utf8"), "precious");
    assert.deepEqual(await applied(s.pool), ["0001-a"]);
  });
});

test("concurrent Store.close() calls both resolve once the pool has ended", async () => {
  await withDb(async (s) => {
    const store = await Store.open({ url: s.url, attachmentsDir: join(s.dir, "att"), backupDir: join(s.dir, "backups"), pgDump: pgDumpPath(), migrations: [m1] });
    await Promise.all([store.close(), store.close()]);
    assert.equal((store.pool as unknown as { ended: boolean }).ended, true);
    await store.close();
  });
});
