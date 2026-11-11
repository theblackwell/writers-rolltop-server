import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { Store, migrate } from "../src/index.ts";

export function adminUrl(): string {
  const url = process.env.ROLLTOP_TEST_DATABASE_URL;
  if (!url) {
    throw new Error("ROLLTOP_TEST_DATABASE_URL is not set. Point it at an admin connection of a scratch PostgreSQL server, e.g. postgres://postgres@127.0.0.1:55432/postgres");
  }
  return url;
}

export const pgDumpPath = (): string => process.env.ROLLTOP_TEST_PG_DUMP ?? "pg_dump";

export interface Scratch {
  url: string;
  name: string;
  dir: string;
  pool: pg.Pool;
  store: Store;
  drop(): Promise<void>;
}

/** A uniquely named scratch database (not yet migrated unless `migrated`), plus a temp directory. */
export async function scratch(opts: { migrated?: boolean } = {}): Promise<Scratch> {
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  const name = `rt_test_${randomBytes(6).toString("hex")}`;
  try { await admin.query(`CREATE DATABASE ${name}`); } finally { await admin.end(); }
  const u = new URL(adminUrl());
  u.pathname = `/${name}`;
  const url = u.toString();
  const dir = await mkdtemp(join(tmpdir(), "rolltop-store-"));
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  const store = new Store({ pool, attachmentsDir: join(dir, "attachments") });
  if (opts.migrated) await migrate({ url, backupDir: join(dir, "backups"), pgDump: pgDumpPath() });
  return {
    url, name, dir, pool, store,
    async drop() {
      await pool.end().catch(() => {});
      const a = new pg.Client({ connectionString: adminUrl() });
      await a.connect();
      try { await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await a.end(); }
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export const uuid = (): string => randomUUID();
export const T0 = new Date("2026-11-10T12:00:00Z");

export function doc(nodeId: string, text = "Hello") {
  return {
    schema: "writers-rolltop/document", version: 1, nodeId,
    blocks: [{ id: randomUUID(), type: "paragraph", content: [{ type: "text", text }] }],
  };
}

/** Library, book and (optionally) the nodes a test needs. */
export async function seedBook(s: Scratch) {
  const book = uuid();
  await s.store.insertLibrary({ id: uuid(), title: "Lib", createdAt: T0 });
  await s.store.insertBook({ id: book, title: "Book", orderKey: "a1", createdAt: T0 });
  return book;
}
