import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { Store } from "@writers-rolltop/store";
import { buildApp } from "../src/app.ts";
import type { LogEntry } from "../src/app.ts";

export const archiveFixtures = fileURLToPath(new URL("../../document-adapter/test/spec/fixtures/archives", import.meta.url));

export const syncFixtures = fileURLToPath(new URL("../../document-adapter/test/spec/fixtures/sync", import.meta.url));

export function adminUrl(): string {
  const url = process.env.ROLLTOP_TEST_DATABASE_URL;
  if (!url) throw new Error("ROLLTOP_TEST_DATABASE_URL is not set. Point it at an admin connection of a scratch PostgreSQL server, e.g. postgres://postgres@127.0.0.1:55432/postgres");
  return url;
}

export interface Server {
  app: ReturnType<typeof buildApp>;
  store: Store;
  url: string;
  dir: string;
  attachmentsDir: string;
  exportsDir: string;
  logs: LogEntry[];
  query(sql: string): Promise<any[]>;
  drop(): Promise<void>;
}

/** A scratch database, a migrated Store on it, and an app with the library routes. */
export async function server(opts: {
  maxImportBytes?: number; timeoutMs?: number; maxHeapMb?: number; exportsDir?: string; limits?: object; fault?: "spin" | "allocate" | "hold-transaction" | "show-settings";
  requestTimeoutMs?: number; connectionTimeoutMs?: number; clock?: () => Date;
} = {}): Promise<Server> {
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  const name = `rt_test_${randomBytes(6).toString("hex")}`;
  try { await admin.query(`CREATE DATABASE ${name}`); } finally { await admin.end(); }
  const u = new URL(adminUrl());
  u.pathname = `/${name}`;
  const url = u.toString();
  const dir = await mkdtemp(join(tmpdir(), "rolltop-api-"));
  const attachmentsDir = join(dir, "attachments");
  const exportsDir = opts.exportsDir ?? join(dir, "exports");
  await mkdir(exportsDir, { recursive: true });
  const store = await Store.open({ url, attachmentsDir, backupDir: join(dir, "backups"), ...(opts.clock ? { clock: opts.clock } : {}) });
  const logs: LogEntry[] = [];
  const app = buildApp({
    log: (e) => logs.push(e),
    ...(opts.requestTimeoutMs ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
    ...(opts.connectionTimeoutMs ? { connectionTimeoutMs: opts.connectionTimeoutMs } : {}),
    library: {
      store, exportsDir, maxImportBytes: opts.maxImportBytes ?? 64 * 1024 ** 2,
      import: { databaseUrl: url, attachmentsDir, timeoutMs: opts.timeoutMs ?? 60_000, maxHeapMb: opts.maxHeapMb ?? 1024, ...(opts.limits ? { limits: opts.limits } : {}), ...(opts.fault ? { fault: opts.fault } : {}) },
    },
  });
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  return {
    app, store, url, dir, attachmentsDir, exportsDir, logs,
    async query(sql) { return (await pool.query(sql)).rows; },
    async drop() {
      await app.close().catch(() => {});
      await pool.end().catch(() => {});
      await store.close().catch(() => {});
      const a = new pg.Client({ connectionString: adminUrl() });
      await a.connect();
      try { await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await a.end(); }
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export const rowCount = async (s: Server): Promise<number> =>
  Number((await s.query("SELECT (SELECT count(*) FROM library) + (SELECT count(*) FROM attachment) + (SELECT count(*) FROM manuscript_node) + (SELECT count(*) FROM bible_entry) AS n"))[0].n);
