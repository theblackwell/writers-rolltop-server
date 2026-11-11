import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { InjectOptions, LightMyRequestResponse } from "fastify";
import { Store } from "@writers-rolltop/store";
import { buildApp } from "../src/app.ts";
import { Auth } from "../src/auth.ts";
import type { LogEntry } from "../src/app.ts";

export const archiveFixtures = fileURLToPath(new URL("../../document-adapter/test/spec/fixtures/archives", import.meta.url));

export const syncFixtures = fileURLToPath(new URL("../../document-adapter/test/spec/fixtures/sync", import.meta.url));

export function adminUrl(): string {
  const url = process.env.ROLLTOP_TEST_DATABASE_URL;
  if (!url) throw new Error("ROLLTOP_TEST_DATABASE_URL is not set. Point it at an admin connection of a scratch PostgreSQL server, e.g. postgres://postgres@127.0.0.1:55432/postgres");
  return url;
}

export const TEST_PASSWORD = "correct horse battery staple";

export interface Server {
  app: ReturnType<typeof buildApp>;
  auth: Auth;
  /** The one-time setup token, or undefined once the helper has used it (signed-in servers). */
  setupToken: string | undefined;
  /** `name=value` of the session cookie of the signed-in owner; empty for an anonymous server. */
  cookie: string;
  /** app.inject with the signed-in owner's session cookie added (an explicit cookie header wins). */
  inject(opts: InjectOptions): Promise<LightMyRequestResponse>;
  store: Store;
  url: string;
  dir: string;
  attachmentsDir: string;
  exportsDir: string;
  logs: LogEntry[];
  /** Entries of the auth module (kept apart so the app log stays about requests). */
  authLogs: LogEntry[];
  query(sql: string): Promise<any[]>;
  drop(): Promise<void>;
}

/** A scratch database, a migrated Store on it, and an app with the library routes. */
export async function server(opts: {
  maxImportBytes?: number; timeoutMs?: number; maxHeapMb?: number; exportsDir?: string; limits?: object; fault?: "spin" | "allocate" | "hold-transaction" | "show-settings";
  requestTimeoutMs?: number; connectionTimeoutMs?: number; clock?: () => Date;
  /** Skip setup and login: the server is fresh, with its setup token still unused. */
  anonymous?: boolean; cookieSecure?: boolean; authClock?: () => Date; setupTokenTtlMs?: number;
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
  const authLogs: LogEntry[] = [];
  const auth = new Auth({
    pool: store.pool, cookieSecure: opts.cookieSecure ?? true, log: (e) => authLogs.push(e),
    ...(opts.authClock ?? opts.clock ? { clock: (opts.authClock ?? opts.clock)! } : {}),
    ...(opts.setupTokenTtlMs ? { setupTokenTtlMs: opts.setupTokenTtlMs } : {}),
  });
  const setup = await auth.prepareSetup();
  const app = buildApp({
    log: (e) => logs.push(e),
    ...(opts.requestTimeoutMs ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
    ...(opts.connectionTimeoutMs ? { connectionTimeoutMs: opts.connectionTimeoutMs } : {}),
    library: {
      store, auth, exportsDir, maxImportBytes: opts.maxImportBytes ?? 64 * 1024 ** 2,
      import: { databaseUrl: url, attachmentsDir, timeoutMs: opts.timeoutMs ?? 60_000, maxHeapMb: opts.maxHeapMb ?? 1024, ...(opts.limits ? { limits: opts.limits } : {}), ...(opts.fault ? { fault: opts.fault } : {}) },
    },
  });
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  let cookie = "";
  let setupToken = setup?.token;
  if (!opts.anonymous) {
    const made = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { token: setupToken, password: TEST_PASSWORD } });
    if (made.statusCode !== 201) throw new Error(`test setup failed: ${made.statusCode}`);
    setupToken = undefined;
    cookie = await signIn(app);
  }
  return {
    app, auth, store, url, dir, attachmentsDir, exportsDir, logs, authLogs, cookie, setupToken,
    inject: (o) => app.inject({ ...o, headers: { ...(cookie ? { cookie } : {}), ...o.headers } }),
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

/** Logs in with the test password and returns the `name=value` pair of the session cookie. */
export async function signIn(app: Server["app"], password = TEST_PASSWORD): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password } });
  if (res.statusCode !== 200) throw new Error(`test login failed: ${res.statusCode}`);
  return String(res.headers["set-cookie"]).split(";")[0]!;
}
