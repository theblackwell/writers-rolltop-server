import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { sweepLeftovers } from "../src/sweep.ts";
import { adminUrl } from "./helpers.ts";

const SHA = "a".repeat(64);
const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));

async function leftovers(dir: string) {
  const attachmentsDir = join(dir, "attachments"), exportsDir = join(dir, "exports");
  await mkdir(attachmentsDir, { recursive: true });
  await mkdir(exportsDir, { recursive: true });
  await writeFile(join(attachmentsDir, `${SHA}.tmp-11111111-2222-3333-4444-555555555555`), "half written");
  await writeFile(join(attachmentsDir, "b".repeat(64)), "a real attachment");
  await writeFile(join(attachmentsDir, "notes.txt"), "not ours, not a temp file");
  await writeFile(join(exportsDir, "export-1.rolltop"), "stale export");
  await writeFile(join(exportsDir, ".library.rolltop.partial-1"), "stale partial");
  await mkdir(join(dir, ".import-11111111-2222-3333-4444-555555555555.staging"));
  await writeFile(join(dir, ".import-11111111-2222-3333-4444-555555555555.staging", "manifest.json"), "{}");
  await mkdir(join(dir, "abc.replaced-20261110T120000Z"));
  await mkdir(join(dir, "keep-me"));
  await mkdir(join(dir, ".import-abc.staging"));
  await mkdir(join(dir, ".import-.staging"));
  await writeFile(join(dir, "draft.replaced-2.docx"), "a user file that only looks similar");
  return { attachmentsDir, exportsDir };
}

test("the sweep removes crash leftovers and nothing else", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rolltop-sweep-"));
  try {
    const { attachmentsDir, exportsDir } = await leftovers(dir);
    const result = await sweepLeftovers({ attachmentsDir, exportsDir, dataDir: dir });
    assert.deepEqual(result, { attachmentTemps: 1, exports: 2, staging: 1 });
    assert.deepEqual((await readdir(attachmentsDir)).sort(), ["b".repeat(64), "notes.txt"]);
    assert.deepEqual(await readdir(exportsDir), []);
    assert.ok((await readdir(dir)).includes("keep-me"));
    assert.ok((await readdir(dir)).includes(".import-abc.staging") && (await readdir(dir)).includes(".import-.staging"), "folders that are not the importer's exact naming survive");
    assert.ok((await readdir(dir)).includes("abc.replaced-20261110T120000Z"), "a *.replaced-<stamp> entry is not the server's and survives");
    assert.ok((await readdir(dir)).includes("draft.replaced-2.docx"), "a user file with a similar name is not touched");
    // Running it again, or on missing folders, is harmless.
    assert.deepEqual(await sweepLeftovers({ attachmentsDir, exportsDir, dataDir: dir }), { attachmentTemps: 0, exports: 0, staging: 0 });
    assert.deepEqual(await sweepLeftovers({ attachmentsDir: join(dir, "nope"), exportsDir: join(dir, "nope2") }), { attachmentTemps: 0, exports: 0, staging: 0 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const freePort = () => new Promise<number>((resolve, reject) => {
  const srv = createServer();
  srv.listen(0, "127.0.0.1", () => { const { port } = srv.address() as { port: number }; srv.close(() => resolve(port)); });
  srv.on("error", reject);
});

test("startup migrates, sweeps leftovers, and then serves", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rolltop-start-"));
  const name = `rt_test_start_${Date.now().toString(36)}`;
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const u = new URL(adminUrl());
  u.pathname = `/${name}`;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const data = join(dir, "data");
    const { attachmentsDir, exportsDir } = await leftovers(data);
    const port = await freePort();
    child = spawn(process.execPath, [entry], { env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATABASE_URL: u.toString(), ROLLTOP_DATA_DIR: data }, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });
    let up = false;
    for (let i = 0; i < 200 && !up; i++) {
      try { up = (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 50)); }
    }
    assert.ok(up, `the server did not start: ${stderr}`);
    assert.deepEqual((await readdir(attachmentsDir)).sort(), ["b".repeat(64), "notes.txt"]);
    assert.deepEqual(await readdir(exportsDir), []);
    assert.deepEqual((await readdir(data)).filter((n) => /^\.import-[0-9a-f]{8}-/.test(n)), []);
    assert.match(stderr, /STARTUP_SWEEP/);
    // Library routes need a session. Setup with the token from the log, then sign in: the export then says "no library yet".
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${base}/api/export`)).status, 401);
    const token = /valid until [^)]*\): ([A-Za-z0-9_-]{43})/.exec(stderr)?.[1];
    assert.ok(token, "the setup token is printed at startup");
    const json = { "content-type": "application/json" };
    assert.equal((await fetch(`${base}/api/auth/setup`, { method: "POST", headers: json, body: JSON.stringify({ token, password: "correct horse battery staple" }) })).status, 201);
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: json, body: JSON.stringify({ password: "correct horse battery staple" }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const exp = await fetch(`${base}/api/export`, { headers: { cookie } });
    assert.equal(exp.status, 404);
    assert.equal(((await exp.json()) as { error: { code: string } }).error.code, "LIBRARY_NOT_FOUND");
  } finally {
    child?.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 100));
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the server refuses a non-loopback HOST while the library routes are on, unless ROLLTOP_INSECURE_BIND=1", async () => {
  const { bindRefusal } = await import("../src/bind.ts");
  assert.equal(bindRefusal("127.0.0.1", true, undefined), undefined);
  assert.equal(bindRefusal("localhost", true, undefined), undefined);
  assert.equal(bindRefusal("::1", true, undefined), undefined);
  assert.equal(bindRefusal("0.0.0.0", false, undefined), undefined, "health-only needs no library routes, so no refusal");
  assert.match(bindRefusal("0.0.0.0", true, undefined)!, /Refusing to start/);
  assert.match(bindRefusal("192.168.1.5", true, "0")!, /ROLLTOP_INSECURE_BIND=1/);
  assert.equal(bindRefusal("0.0.0.0", true, "1"), undefined);

  const dir = await mkdtemp(join(tmpdir(), "rolltop-bind-"));
  const name = `rt_test_bind_${Date.now().toString(36)}`;
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const u = new URL(adminUrl());
  u.pathname = `/${name}`;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const refused = spawn(process.execPath, [entry], { env: { ...process.env, HOST: "0.0.0.0", PORT: "0", DATABASE_URL: u.toString(), ROLLTOP_DATA_DIR: join(dir, "data") }, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    refused.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    assert.equal(await new Promise<number | null>((r) => refused.on("exit", (c) => r(c))), 1);
    assert.match(stderr, /Refusing to start/);

    const port = await freePort();
    child = spawn(process.execPath, [entry], { env: { ...process.env, HOST: "0.0.0.0", PORT: String(port), DATABASE_URL: u.toString(), ROLLTOP_DATA_DIR: join(dir, "data"), ROLLTOP_INSECURE_BIND: "1" }, stdio: "ignore" });
    let up = false;
    for (let i = 0; i < 200 && !up; i++) {
      try { up = (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 50)); }
    }
    assert.ok(up, "with ROLLTOP_INSECURE_BIND=1 the server starts");
  } finally {
    child?.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 100));
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
    await rm(dir, { recursive: true, force: true });
  }
});

test("startup refuses a database that is ahead of this build", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rolltop-start-"));
  const name = `rt_test_ahead_${Date.now().toString(36)}`;
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const u = new URL(adminUrl());
  u.pathname = `/${name}`;
  try {
    const c = new pg.Client({ connectionString: u.toString() });
    await c.connect();
    await c.query("CREATE TABLE schema_migrations (id text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
    await c.query("INSERT INTO schema_migrations (id, checksum) VALUES ('9999-from-the-future', 'x')");
    await c.end();
    const child = spawn(process.execPath, [entry], { env: { ...process.env, PORT: "0", DATABASE_URL: u.toString(), ROLLTOP_DATA_DIR: join(dir, "data") }, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    const code = await new Promise<number | null>((r) => child.on("exit", (c2) => r(c2)));
    assert.notEqual(code, 0);
    assert.match(stderr, /newer version of Writers Rolltop/);
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- cookie-secure flag at startup (M1-7 review) ----

/** Starts the real server on a scratch database. Returns what it printed and its exit code, or the port if it stays up. */
async function startWith(env: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "rolltop-cookie-"));
  const name = `rt_test_cookie_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const u = new URL(adminUrl());
  u.pathname = `/${name}`;
  const port = await freePort();
  const child = spawn(process.execPath, [entry], { env: { ...process.env, PORT: String(port), DATABASE_URL: u.toString(), ROLLTOP_DATA_DIR: join(dir, "data"), ...env }, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
  const exited = new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
  let up = false;
  let code: number | null | undefined;
  void exited.then((c) => { code = c; });
  for (let i = 0; i < 200 && !up && code === undefined; i++) {
    try { up = (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 50)); }
  }
  child.kill("SIGKILL");
  await exited;
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  const migrated = (await c.query("SELECT to_regclass('public.schema_migrations') AS t")).rows[0].t !== null;
  await c.end();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
  await rm(dir, { recursive: true, force: true });
  return { up, code, stderr, migrated };
}

test("ROLLTOP_COOKIE_SECURE=0 on a non-loopback HOST is refused before the database is opened, unless ROLLTOP_INSECURE_BIND=1", async () => {
  const refused = await startWith({ HOST: "0.0.0.0", ROLLTOP_COOKIE_SECURE: "0" });
  assert.equal(refused.up, false);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /Refusing to start/);
  assert.match(refused.stderr, /ROLLTOP_COOKIE_SECURE/);
  assert.match(refused.stderr, /ROLLTOP_INSECURE_BIND=1/);
  assert.equal(refused.migrated, false, "refused before Store.open ran any migration");
  const falseValue = await startWith({ HOST: "0.0.0.0", ROLLTOP_COOKIE_SECURE: "false" });
  assert.equal(falseValue.code, 1);
  assert.equal(falseValue.migrated, false);

  const allowed = await startWith({ HOST: "0.0.0.0", ROLLTOP_COOKIE_SECURE: "0", ROLLTOP_INSECURE_BIND: "1" });
  assert.equal(allowed.up, true, `with the override the server starts: ${allowed.stderr}`);
  assert.equal(allowed.migrated, true);

  const loopback = await startWith({ HOST: "127.0.0.1", ROLLTOP_COOKIE_SECURE: "0" });
  assert.equal(loopback.up, true, `loopback with Secure off starts: ${loopback.stderr}`);
});

test("a bad ROLLTOP_COOKIE_SECURE value stops startup before any migration runs", async () => {
  const bad = await startWith({ HOST: "127.0.0.1", ROLLTOP_COOKIE_SECURE: "maybe" });
  assert.equal(bad.up, false);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /ROLLTOP_COOKIE_SECURE must be 1, true, 0 or false/);
  assert.equal(bad.migrated, false);
});

test("the refusal texts say plain HTTP, TLS-terminating proxy, ROLLTOP_ALLOWED_HOSTS and ROLLTOP_COOKIE_SECURE, and no longer claim there is no authentication", async () => {
  const { bindRefusal } = await import("../src/bind.ts");
  const text = bindRefusal("0.0.0.0", true, undefined)!;
  for (const part of [/plain HTTP/, /TLS-terminating/, /ROLLTOP_ALLOWED_HOSTS/, /ROLLTOP_COOKIE_SECURE/, /ROLLTOP_INSECURE_BIND=1/]) assert.match(text, part);
  assert.doesNotMatch(text, /no authentication/);
});
