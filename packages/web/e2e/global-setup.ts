// Starts the API on a scratch database for the browser tests, and cleans up after them.
// The database is named rt_web_<random> on the server in ROLLTOP_TEST_DATABASE_URL. It is dropped at the end.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const API_PORT = 18080;
const serverRoot = fileURLToPath(new URL("../../../", import.meta.url));

export default async function globalSetup(): Promise<() => Promise<void>> {
  const adminUrl = process.env.ROLLTOP_TEST_DATABASE_URL;
  if (!adminUrl) {
    throw new Error("ROLLTOP_TEST_DATABASE_URL is not set. Point it at an admin connection of a scratch PostgreSQL server, e.g. postgres://postgres@127.0.0.1:55432/postgres");
  }
  const name = `rt_web_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try { await admin.query(`CREATE DATABASE ${name}`); } finally { await admin.end(); }
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const dataDir = await mkdtemp(join(tmpdir(), "rolltop-web-e2e-"));

  const api: ChildProcess = spawn(process.execPath, ["packages/api/src/index.ts"], {
    cwd: serverRoot,
    env: {
      ...process.env,
      DATABASE_URL: url.toString(), ROLLTOP_DATA_DIR: dataDir, PORT: String(API_PORT), HOST: "127.0.0.1",
      ROLLTOP_COOKIE_SECURE: "0",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  let log = "";
  const token = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`API did not print a setup token in time. Log:\n${log}`)), 20_000);
    api.once("error", (e) => { clearTimeout(timer); reject(e); });
    api.once("exit", (code) => { clearTimeout(timer); reject(new Error(`API exited with ${code}. Log:\n${log}`)); });
    api.stderr!.on("data", (chunk: Buffer) => {
      log += chunk.toString();
      const m = /First-run setup token \(shown once[^)]*\): ([A-Za-z0-9_-]+)/.exec(log);
      if (m) { clearTimeout(timer); resolve(m[1]!); }
    });
  });
  // Give the tests the token. It stays in this run's environment only.
  process.env.ROLLTOP_E2E_SETUP_TOKEN = token;

  return async () => {
    api.kill("SIGTERM");
    await new Promise((r) => { api.once("exit", r); setTimeout(r, 5000); });
    const a = new pg.Client({ connectionString: adminUrl });
    await a.connect();
    try { await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await a.end(); }
    await rm(dataDir, { recursive: true, force: true });
  };
}
