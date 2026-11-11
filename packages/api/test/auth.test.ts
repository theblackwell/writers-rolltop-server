// M1-7: one owner, setup token, login, sessions, rate limit, the guard on every route, CSRF checks, and secrets in logs.
// Real app (buildApp) on a scratch PostgreSQL database; requests are made with app.inject, so "cross-origin" means
// requests carrying the headers a browser would send (Origin, Sec-Fetch-Site), not a browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadMigrations, migrate } from "@writers-rolltop/store";
import { Auth, LOGIN_FAILURE_WINDOW_MS, SESSION_ABSOLUTE_MS, SESSION_IDLE_MS } from "../src/auth.ts";
import { hashPassword, passwordProblem, verifyPassword } from "../src/password.ts";
import { adminUrl, server, TEST_PASSWORD } from "./helpers.ts";
import type { Server } from "./helpers.ts";

const T0 = new Date("2026-11-11T12:00:00Z");
const DAY = 24 * 3600_000;
const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** A clock a test can move. */
function clock(start = T0) {
  let now = start.getTime();
  const fn = () => new Date(now);
  return Object.assign(fn, { advance: (ms: number) => { now += ms; } });
}

const post = (s: Server, url: string, payload: unknown, headers: Record<string, string> = {}) =>
  s.app.inject({ method: "POST", url, payload: payload as object, headers });
const login = (s: Server, password: unknown, headers: Record<string, string> = {}) => post(s, "/api/auth/login", { password }, headers);
const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers["set-cookie"]).split(";")[0]!;
const count = async (s: Server, table: string) => Number((await s.query(`SELECT count(*) AS n FROM ${table}`))[0].n);
const sessionStatus = async (s: Server, cookie: string) =>
  (await s.app.inject({ method: "GET", url: "/api/export", headers: { cookie } })).statusCode;

// ---- password hashing ----

test("a password hash carries its version and cost, verifies, and malformed input never matches", async () => {
  const cheap = { N: 2 ** 10, r: 8, p: 1 };
  const h = await hashPassword(TEST_PASSWORD, cheap);
  assert.match(h, /^scrypt\$v1\$N=1024,r=8,p=1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.ok(!h.includes(TEST_PASSWORD));
  assert.notEqual(h, await hashPassword(TEST_PASSWORD, cheap), "a fresh salt each time");
  assert.equal(await verifyPassword(TEST_PASSWORD, h), true);
  assert.equal(await verifyPassword(TEST_PASSWORD + "x", h), false);
  for (const bad of ["", "scrypt", "scrypt$v2$N=1024,r=8,p=1$AAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAA==", "scrypt$v1$N=1000,r=8,p=1$AAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAA==", "scrypt$v1$N=1073741824,r=8,p=1$AAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAA=="]) {
    assert.equal(await verifyPassword(TEST_PASSWORD, bad), false, bad);
  }
  // The same characters composed differently are the same password.
  assert.equal(await verifyPassword("café café café", await hashPassword("café café café", cheap)), true);
  // The current cost is the one the migration comment and ADR describe.
  assert.match(await hashPassword("a long enough password"), /^scrypt\$v1\$N=131072,r=8,p=1\$/);
});

test("password rules: 12 characters to 1024 bytes, no composition rules", () => {
  assert.equal(passwordProblem("a".repeat(12)), undefined);
  assert.equal(passwordProblem("a".repeat(1024)), undefined);
  assert.equal(passwordProblem("\u{1F600}".repeat(12)), undefined, "characters, not bytes, for the minimum");
  for (const bad of ["", "a".repeat(11), "a".repeat(1025), "\u{1F600}".repeat(257), " ".repeat(20), 12345, null, undefined, ["a".repeat(12)]]) {
    assert.ok(passwordProblem(bad), String(bad));
  }
});

// ---- setup ----

test("setup works once and only once; a wrong token and a bad password are refused and leave the token usable", async () => {
  const s = await server({ anonymous: true });
  try {
    assert.match(s.setupToken!, /^[A-Za-z0-9_-]{43}$/, "256 bits, base64url");
    assert.deepEqual((await s.app.inject({ method: "GET", url: "/api/auth/session" })).json(), { signedIn: false, setupRequired: true });
    const wrong = await post(s, "/api/auth/setup", { token: "x".repeat(43), password: TEST_PASSWORD });
    assert.equal(wrong.statusCode, 403);
    assert.equal(wrong.json().error.code, "SETUP_UNAVAILABLE");
    for (const body of [{ password: TEST_PASSWORD }, { token: 5, password: TEST_PASSWORD }, { token: s.setupToken }]) {
      assert.ok([400, 403].includes((await post(s, "/api/auth/setup", body)).statusCode));
    }
    assert.equal(await count(s, "owner"), 0);
    for (const password of ["", "short", "a".repeat(1025), " ".repeat(30), 123456789012]) {
      const bad = await post(s, "/api/auth/setup", { token: s.setupToken, password });
      assert.equal(bad.statusCode, 400);
      assert.equal(bad.json().error.code, "INVALID_PASSWORD");
    }
    assert.equal(await count(s, "owner"), 0);
    const ok = await post(s, "/api/auth/setup", { token: s.setupToken, password: TEST_PASSWORD });
    assert.equal(ok.statusCode, 201);
    assert.equal(await count(s, "owner"), 1);
    const row = (await s.query("SELECT password_hash FROM owner"))[0];
    assert.match(row.password_hash, /^scrypt\$v1\$N=131072,r=8,p=1\$/);
    assert.ok(!row.password_hash.includes(TEST_PASSWORD));
    // Single use, and closed once an owner exists.
    const again = await post(s, "/api/auth/setup", { token: s.setupToken, password: "another long password" });
    assert.equal(again.statusCode, 403);
    assert.equal(again.json().error.code, "SETUP_UNAVAILABLE");
    assert.equal(await count(s, "owner"), 1);
    assert.equal(await login(s, "another long password").then((r) => r.statusCode), 401, "the first password is the only one");
    assert.equal((await login(s, TEST_PASSWORD)).statusCode, 200);
    assert.deepEqual((await s.app.inject({ method: "GET", url: "/api/auth/session" })).json(), { signedIn: false, setupRequired: false });
    // The database itself holds one owner at most.
    await assert.rejects(s.query("INSERT INTO owner (password_hash, created_at, updated_at) VALUES ('x', now(), now())"), /owner_single_row/);
  } finally { await s.drop(); }
});

test("two setups at the same moment: exactly one owner", async () => {
  const s = await server({ anonymous: true });
  try {
    const results = await Promise.all([1, 2, 3].map((i) => post(s, "/api/auth/setup", { token: s.setupToken, password: `${TEST_PASSWORD} ${i}` })));
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 403, 403]);
    assert.equal(await count(s, "owner"), 1);
  } finally { await s.drop(); }
});

test("the setup token expires", async () => {
  const c = clock();
  const s = await server({ anonymous: true, authClock: c, setupTokenTtlMs: 60_000 });
  try {
    c.advance(60_001);
    const late = await post(s, "/api/auth/setup", { token: s.setupToken, password: TEST_PASSWORD });
    assert.equal(late.statusCode, 403);
    assert.equal(await count(s, "owner"), 0);
    // A restart (a new Auth) issues a new token, which works.
    const next = new Auth({ pool: s.store.pool, cookieSecure: true, clock: c });
    const fresh = await next.prepareSetup();
    assert.ok(fresh && fresh.token !== s.setupToken);
    await next.setup(fresh.token, TEST_PASSWORD);
    assert.equal(await count(s, "owner"), 1);
  } finally { await s.drop(); }
});

test("with an owner, startup makes no setup token and setup stays closed", async () => {
  const s = await server();
  try {
    assert.equal(s.setupToken, undefined);
    const restarted = new Auth({ pool: s.store.pool, cookieSecure: true });
    assert.equal(await restarted.prepareSetup(), undefined);
    await assert.rejects(restarted.setup("a".repeat(43), "another long password"), (e: any) => e.code === "SETUP_UNAVAILABLE");
  } finally { await s.drop(); }
});

// ---- login ----

test("login: success sets a session; every failure looks the same, before and after setup", async () => {
  const s = await server({ anonymous: true });
  try {
    const before = await login(s, "some wrong password");
    assert.equal(before.statusCode, 401);
    await post(s, "/api/auth/setup", { token: s.setupToken, password: TEST_PASSWORD });
    const wrong = await login(s, "some wrong password");
    assert.equal(wrong.statusCode, 401);
    assert.deepEqual(wrong.json(), before.json(), "no difference between 'no owner' and 'wrong password'");
    assert.deepEqual(wrong.json(), { error: { code: "INVALID_CREDENTIALS", message: "Sign-in failed." } });
    assert.equal(wrong.headers["set-cookie"], undefined);
    for (const body of [undefined, {}, { password: "" }, { password: 5 }, [], "x"]) {
      const bad = await post(s, "/api/auth/login", body);
      assert.ok(bad.statusCode === 400 || bad.statusCode === 415, `${JSON.stringify(body)} -> ${bad.statusCode}`);
      assert.equal(bad.headers["set-cookie"], undefined);
    }
    const huge = await login(s, "a".repeat(2000));
    assert.equal(huge.statusCode, 401);
    const ok = await login(s, TEST_PASSWORD);
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(ok.json(), { signedIn: true });
    assert.equal(ok.headers["cache-control"], "no-store");
    const cookie = cookieOf(ok);
    assert.deepEqual((await s.app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie } })).json(), { signedIn: true, setupRequired: false });
    assert.equal(await sessionStatus(s, cookie), 404, "signed in: the export route runs (no library yet)");
  } finally { await s.drop(); }
});

test("the session cookie is HttpOnly, SameSite=Strict, Path=/, and Secure by configuration", async () => {
  for (const secure of [true, false]) {
    const s = await server({ cookieSecure: secure });
    try {
      const res = await login(s, TEST_PASSWORD);
      const header = String(res.headers["set-cookie"]);
      const [pair, ...attrs] = header.split("; ");
      const [name, token] = [pair!.slice(0, pair!.indexOf("=")), pair!.slice(pair!.indexOf("=") + 1)];
      assert.equal(name, secure ? "__Host-rolltop_session" : "rolltop_session");
      assert.match(token, /^[A-Za-z0-9_-]{43}$/, "256 random bits");
      assert.ok(attrs.includes("HttpOnly"), header);
      assert.ok(attrs.includes("SameSite=Strict"), header);
      assert.ok(attrs.includes("Path=/"), header);
      assert.ok(attrs.includes(`Max-Age=${SESSION_ABSOLUTE_MS / 1000}`), header);
      assert.equal(attrs.includes("Secure"), secure, header);
      assert.ok(!attrs.some((a) => /^Domain=/i.test(a)), "host-only cookie");
      // The database holds only the hash of the token.
      const rows = await s.query("SELECT * FROM session WHERE token_hash = '" + sha(token!) + "'");
      assert.equal(rows.length, 1);
      assert.ok(!JSON.stringify(await s.query("SELECT * FROM session")).includes(token!));
    } finally { await s.drop(); }
  }
});

test("a session ends after 7 idle days, and after 30 days however often it is used", async () => {
  const c = clock();
  const s = await server({ authClock: c });
  try {
    // Idle: used just inside the limit, it lives on; left alone past the limit, it is gone (and its row removed).
    const a = s.cookie;
    c.advance(SESSION_IDLE_MS - 60_000);
    assert.equal(await sessionStatus(s, a), 404);
    c.advance(SESSION_IDLE_MS - 60_000);
    assert.equal(await sessionStatus(s, a), 404, "the use above renewed the idle timer");
    c.advance(SESSION_IDLE_MS + 60_000);
    assert.equal(await sessionStatus(s, a), 401);
    assert.equal(await count(s, "session"), 0, "an expired session is deleted when seen");

    // Absolute: used every 6 days, it still ends 30 days after login.
    const b = cookieOf(await login(s, TEST_PASSWORD));
    for (let day = 6; day < 30; day += 6) { c.advance(6 * DAY); assert.equal(await sessionStatus(s, b), 404, `day ${day}`); }
    c.advance(6 * DAY); // day 30 plus: past the absolute limit
    assert.equal(await sessionStatus(s, b), 401);
    assert.equal(SESSION_ABSOLUTE_MS, 30 * DAY);
  } finally { await s.drop(); }
});

test("logout deletes the session and clears the cookie; the old cookie stops working", async () => {
  const s = await server({ cookieSecure: false });
  try {
    const other = cookieOf(await login(s, TEST_PASSWORD));
    const out = await s.inject({ method: "POST", url: "/api/auth/logout" });
    assert.equal(out.statusCode, 200);
    const cleared = String(out.headers["set-cookie"]);
    assert.match(cleared, /^rolltop_session=; Max-Age=0; Path=\/; HttpOnly; SameSite=Strict$/);
    assert.equal(await sessionStatus(s, s.cookie), 401);
    assert.equal(await sessionStatus(s, other), 404, "only that session ended");
    assert.equal((await s.app.inject({ method: "POST", url: "/api/auth/logout" })).statusCode, 401);
    assert.equal(await count(s, "session"), 1);
  } finally { await s.drop(); }
});

// ---- rate limit ----

test("5 failures in 15 minutes lock sign-in (even for the right password) until the window passes; a restart does not reset it", async () => {
  const c = clock();
  const s = await server({ anonymous: true, authClock: c });
  try {
    await post(s, "/api/auth/setup", { token: s.setupToken, password: TEST_PASSWORD });
    for (let i = 0; i < 5; i++) {
      assert.equal((await login(s, `wrong password ${i}`)).statusCode, 401);
      c.advance(60_000);
    }
    assert.equal(await count(s, "login_failure"), 5);
    const locked = await login(s, TEST_PASSWORD);
    assert.equal(locked.statusCode, 429);
    assert.equal(locked.json().error.code, "TOO_MANY_ATTEMPTS");
    assert.equal(locked.headers["set-cookie"], undefined);
    // First failure was 5 minutes ago, so 10 minutes remain.
    assert.equal(locked.headers["retry-after"], String(10 * 60));
    assert.equal(await count(s, "login_failure"), 5, "refused attempts are not counted: waiting always ends the lock");
    // A new process (a new Auth) on the same database still refuses: the count lives in the database.
    const restarted = new Auth({ pool: s.store.pool, cookieSecure: true, clock: c });
    await assert.rejects(restarted.login(TEST_PASSWORD), (e: any) => e.code === "TOO_MANY_ATTEMPTS");
    c.advance(10 * 60_000 + 1000);
    assert.equal((await login(s, TEST_PASSWORD)).statusCode, 200);
    assert.equal(await count(s, "login_failure"), 0, "a successful sign-in clears the failures");
    assert.equal(LOGIN_FAILURE_WINDOW_MS, 15 * 60_000);
  } finally { await s.drop(); }
});

test("failures older than the window do not count", async () => {
  const c = clock();
  const s = await server({ authClock: c });
  try {
    for (let i = 0; i < 4; i++) await login(s, "wrong password " + i);
    c.advance(LOGIN_FAILURE_WINDOW_MS + 1000);
    for (let i = 0; i < 4; i++) assert.equal((await login(s, "wrong password " + i)).statusCode, 401);
    assert.equal((await login(s, TEST_PASSWORD)).statusCode, 200);
  } finally { await s.drop(); }
});

test("concurrent wrong passwords cannot get past the limit", async () => {
  const s = await server();
  try {
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => login(s, `wrong password ${i}`)));
    const codes = results.map((r) => r.statusCode);
    assert.equal(codes.filter((x) => x === 401).length, 5, `statuses: ${codes}`);
    assert.ok(codes.every((x) => x === 401 || x === 429));
    assert.equal(await count(s, "login_failure"), 5);
    assert.ok(results.filter((r) => r.statusCode === 429).every((r) => ["TOO_MANY_ATTEMPTS", "AUTH_BUSY"].includes(r.json().error.code)));
  } finally { await s.drop(); }
});

// ---- the guard ----

/** Every route the app registers, read from the router itself, as "METHOD path". */
function registeredRoutes(s: Server): string[] {
  const out: string[] = [];
  for (const line of s.app.printRoutes({ commonPrefix: false }).split("\n")) {
    const m = /(\/\S*) \(([A-Z, ]+)\)$/.exec(line);
    if (m) for (const method of m[2]!.split(", ")) out.push(`${method} ${m[1]}`);
  }
  return out.sort();
}
const OPEN = ["GET /api/health", "GET /api/auth/session", "POST /api/auth/login", "POST /api/auth/setup"];

test("every route except health, session, login and setup refuses a request without a session", async () => {
  const s = await server();
  try {
    const routes = registeredRoutes(s);
    assert.ok(routes.length >= 12, routes.join("\n"));
    const closed = routes.filter((r) => !OPEN.includes(r) && r !== "HEAD /api/health" && r !== "HEAD /api/auth/session");
    for (const must of ["POST /api/import", "GET /api/export", "POST /api/auth/logout", "POST /api/sync/v1/push", "GET /api/sync/v1/changes", "GET /api/sync/v1/conflicts"]) assert.ok(closed.includes(must), must);
    const bogus = ["GET /api/nothing", "GET /nope", "POST /api/sync/v1/nothing", "DELETE /api/export", "PUT /api/import", "PATCH /api/sync/v1/push", "GET /api/sync/v1/%70ush", "GET /%61pi/export", "GET /api/export/", "GET //api/export", "OPTIONS /api/export", "GET /api/health/", "GET /api/health%2F"];
    for (const r of [...closed, ...bogus]) {
      const [method, path] = r.split(" ") as [string, string];
      const res = await s.app.inject({ method: method as "GET", url: path, ...(method === "POST" || method === "PUT" || method === "PATCH" ? { payload: {} } : {}) });
      assert.equal(res.statusCode, 401, r);
      if (method !== "HEAD") assert.deepEqual(res.json(), { error: { code: "UNAUTHENTICATED", message: "Sign in to use this server." } }, r);
    }
    // A cookie that is not a session, a revoked one, and junk are the same as none.
    for (const cookie of ["rolltop_session=" + "a".repeat(43), "__Host-rolltop_session=" + "a".repeat(43), "__Host-rolltop_session=", "__Host-rolltop_session=%00", "other=1"]) {
      assert.equal((await s.app.inject({ method: "GET", url: "/api/sync/v1/changes?epoch=x", headers: { cookie } })).statusCode, 401, cookie);
    }
    // The four open routes answer without one.
    assert.equal((await s.app.inject({ method: "GET", url: "/api/health" })).statusCode, 200);
    assert.equal((await s.app.inject({ method: "GET", url: "/api/auth/session" })).statusCode, 200);
    assert.notEqual((await post(s, "/api/auth/login", { password: "x" })).json().error.code, "UNAUTHENTICATED");
    assert.notEqual((await post(s, "/api/auth/setup", { token: "x", password: "y" })).json().error.code, "UNAUTHENTICATED");
    // And with the session, the same closed routes are reachable.
    assert.notEqual((await s.inject({ method: "GET", url: "/api/sync/v1/changes?epoch=x" })).statusCode, 401);
    assert.equal((await s.inject({ method: "GET", url: "/api/export" })).statusCode, 404);
  } finally { await s.drop(); }
});

test("a refusal without a session does not reach the import slot or the sync engine", async () => {
  const s = await server();
  try {
    const before = (await s.query("SELECT head FROM sync_state"))[0].head;
    const res = await s.app.inject({ method: "POST", url: "/api/import", payload: Buffer.from("x"), headers: { "content-type": "application/zip" } });
    assert.equal(res.statusCode, 401);
    const push = await s.app.inject({ method: "POST", url: "/api/sync/v1/push", payload: { epoch: "e", deviceId: "d", ops: [] } });
    assert.equal(push.statusCode, 401);
    assert.equal((await s.query("SELECT head FROM sync_state"))[0].head, before);
    // The slot is free: an import with the session is not told "busy".
    const ok = await s.inject({ method: "POST", url: "/api/import", payload: Buffer.from("x"), headers: { "content-type": "application/zip" } });
    assert.notEqual(ok.statusCode, 429);
  } finally { await s.drop(); }
});

// ---- CSRF and cross-site ----

test("a state-changing request with a foreign Origin, an Origin of null, or a same-site fetch is refused", async () => {
  const s = await server();
  try {
    const own = { host: "localhost:8080" };
    const body = { epoch: "e", deviceId: "d", ops: [] };
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      for (const origin of ["https://evil.example", "http://localhost:9999", "http://localhost", "null", "http://localhost:8080.evil.example", "ftp://localhost:8080", "not a url"]) {
        const res = await s.inject({ method, url: "/api/sync/v1/push", payload: body, headers: { ...own, origin } });
        assert.equal(res.statusCode, 403, `${method} ${origin}`);
        assert.equal(res.json().error.code, "FORBIDDEN_ORIGIN");
      }
    }
    for (const site of ["cross-site", "same-site"]) {
      assert.equal((await s.inject({ method: "POST", url: "/api/sync/v1/push", payload: body, headers: { ...own, "sec-fetch-site": site } })).statusCode, 403, site);
    }
    // Login and setup are state-changing too; a foreign page cannot even try a password.
    const attempt = await login(s, "guess guess guess", { ...own, origin: "https://evil.example" });
    assert.equal(attempt.statusCode, 403);
    assert.equal(await count(s, "login_failure"), 0, "refused before any password was checked");
    assert.equal((await s.inject({ method: "POST", url: "/api/auth/logout", headers: { ...own, origin: "https://evil.example" } })).statusCode, 403);
    assert.equal(await sessionStatus(s, s.cookie), 404, "the session survived the forged logout");
    // The server's own origin, and no Origin at all (native clients, curl), pass the check.
    for (const headers of [{ ...own, origin: "http://localhost:8080" }, { ...own, origin: "HTTPS://LOCALHOST:8080" }, { ...own, "sec-fetch-site": "same-origin" }, own]) {
      const res = await s.inject({ method: "POST", url: "/api/sync/v1/push", payload: body, headers });
      assert.notEqual(res.statusCode, 403, JSON.stringify(headers));
      assert.notEqual(res.statusCode, 401);
    }
    // Safe methods are not subject to the Origin rule (SameSite=Strict keeps the cookie off cross-site requests).
    assert.equal((await s.inject({ method: "GET", url: "/api/export", headers: { ...own, origin: "https://evil.example" } })).statusCode, 404);
  } finally { await s.drop(); }
});

// ---- migration ----

test("migration 0004 on a library made by 0003: data kept, a backup taken, an empty owner table", async () => {
  const { scratch, pgDumpPath } = await import("../../store/test/helpers.ts");
  const s = await scratch();
  try {
    const all = await loadMigrations();
    assert.equal(all[3]?.id, "0004-auth");
    const opts = { url: s.url, backupDir: join(s.dir, "b"), pgDump: pgDumpPath() };
    await migrate({ ...opts, migrations: all.slice(0, 3) });
    await s.pool.query("INSERT INTO library (id, title, created_at, updated_at) VALUES (gen_random_uuid(), 'Kept', now(), now())");
    const r = await migrate(opts);
    assert.deepEqual(r.applied, ["0004-auth"]);
    assert.ok(r.backupFile, "backed up before the pending migration");
    assert.equal((await s.pool.query("SELECT title FROM library")).rows[0].title, "Kept");
    for (const t of ["owner", "session", "login_failure"]) assert.equal(Number((await s.pool.query(`SELECT count(*) AS n FROM ${t}`)).rows[0].n), 0);
    assert.deepEqual((await migrate(opts)).applied, []);
  } finally { await s.drop(); }
});

// ---- secrets in logs ----

const freePort = () => new Promise<number>((resolve, reject) => {
  const srv = createServer();
  srv.listen(0, "127.0.0.1", () => { const { port } = srv.address() as { port: number }; srv.close(() => resolve(port)); });
  srv.on("error", reject);
});

test("the real server prints the setup token once, at startup, and never a password, token, cookie or hash", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rolltop-auth-"));
  const name = `rt_test_auth_${Date.now().toString(36)}`;
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const u = new URL(adminUrl());
  u.pathname = `/${name}`;
  const children: ReturnType<typeof spawn>[] = [];
  const run = async (port: number) => {
    const child = spawn(process.execPath, [entry], { env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATABASE_URL: u.toString(), ROLLTOP_DATA_DIR: join(dir, "data"), ROLLTOP_COOKIE_SECURE: "0" }, stdio: ["ignore", "ignore", "pipe"] });
    children.push(child);
    const log = { text: "" };
    child.stderr.on("data", (d: Buffer) => { log.text += d.toString(); });
    let up = false;
    for (let i = 0; i < 200 && !up; i++) {
      try { up = (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 50)); }
    }
    assert.ok(up, `the server did not start: ${log.text}`);
    return { child, log };
  };
  const stop = async (child: ReturnType<typeof spawn>) => {
    const exited = new Promise((r) => child.on("exit", r));
    child.kill("SIGTERM");
    await exited;
  };
  const secrets: string[] = [];
  try {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const json = { "content-type": "application/json" };
    const first = await run(port);
    const token = /valid until [^)]*\): ([A-Za-z0-9_-]{43})/.exec(first.log.text)?.[1];
    assert.ok(token, "the token is printed at startup");
    secrets.push(token);
    const password = "a very private passphrase 12345";
    secrets.push(password);
    const bad = await fetch(`${base}/api/auth/setup`, { method: "POST", headers: json, body: JSON.stringify({ token: "w".repeat(43), password }) });
    assert.equal(bad.status, 403);
    assert.equal((await fetch(`${base}/api/auth/setup`, { method: "POST", headers: json, body: JSON.stringify({ token, password }) })).status, 201);
    for (let i = 0; i < 6; i++) {
      secrets.push(`wrong guess number ${i}`);
      await fetch(`${base}/api/auth/login`, { method: "POST", headers: json, body: JSON.stringify({ password: `wrong guess number ${i}` }) });
    }
    // Locked by now (5 failures): clear them as the database would after the window, then sign in properly.
    const db = new pg.Client({ connectionString: u.toString() });
    await db.connect();
    await db.query("DELETE FROM login_failure");
    const ok = await fetch(`${base}/api/auth/login`, { method: "POST", headers: json, body: JSON.stringify({ password }) });
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get("set-cookie")!.split(";")[0]!;
    secrets.push(cookie.slice(cookie.indexOf("=") + 1), cookie);
    secrets.push((await db.query("SELECT password_hash FROM owner")).rows[0].password_hash);
    secrets.push((await db.query("SELECT token_hash FROM session")).rows[0].token_hash);
    await db.end();
    // Faults and odd requests too: broken JSON that contains the password, a wrong content type, an import without data.
    await fetch(`${base}/api/auth/login`, { method: "POST", headers: json, body: `{"password": "${password}` });
    await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "text/plain" }, body: password });
    await fetch(`${base}/api/export`, { headers: { cookie } });
    await fetch(`${base}/api/export`, { headers: { cookie: `${cookie.split("=")[0]}=${"b".repeat(43)}` } });
    await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { cookie } });
    await stop(first.child);

    const text = first.log.text;
    assert.equal(text.split(token).length - 1, 1, "the setup token appears exactly once");
    assert.ok(text.indexOf(token) < text.indexOf("STARTUP_SWEEP") + 1000, "printed during startup");
    for (const secret of secrets.slice(1)) assert.ok(!text.includes(secret), `a secret reached the log: ${secret.slice(0, 6)}...`);
    assert.ok(!text.includes("scrypt$"), "no hash in the log");
    assert.match(text, /AUTH_SETUP_DONE/);
    assert.match(text, /AUTH_LOGIN_FAILED/);
    assert.match(text, /AUTH_LOGIN_LOCKED/);

    // A restart with an owner in place prints no setup token.
    const second = await run(await freePort());
    await new Promise((r) => setTimeout(r, 200));
    await stop(second.child);
    assert.ok(!second.log.text.includes("SETUP_TOKEN"), second.log.text);
    assert.ok(!second.log.text.includes(token));
  } finally {
    for (const c of children) c.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 100));
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
    await rm(dir, { recursive: true, force: true });
  }
});

test("in-process: the app and auth logs and the error bodies hold no password, token, cookie or hash", async () => {
  const s = await server({ anonymous: true });
  try {
    const password = "another private passphrase";
    const bodies: string[] = [];
    const keep = <T extends { body: string }>(r: T): T => { bodies.push(r.body); return r; };
    keep(await post(s, "/api/auth/setup", { token: "z".repeat(43), password }));
    keep(await post(s, "/api/auth/setup", { token: s.setupToken, password: "short" }));
    keep(await post(s, "/api/auth/setup", { token: s.setupToken, password }));
    keep(await login(s, "nope nope nope nope"));
    const ok = keep(await login(s, password));
    const cookie = cookieOf(ok);
    keep(await s.app.inject({ method: "POST", url: "/api/auth/login", payload: `{"password": "${password}`, headers: { "content-type": "application/json" } }));
    const hash = (await s.query("SELECT password_hash FROM owner"))[0].password_hash as string;
    const all = JSON.stringify([s.logs, s.authLogs]) + bodies.join("\n");
    for (const secret of [password, s.setupToken!, cookie, cookie.split("=")[1]!, hash, "nope nope nope nope"]) {
      assert.ok(!all.includes(secret), `leaked: ${secret.slice(0, 8)}...`);
    }
    assert.ok(s.authLogs.every((e) => /^[A-Z_]+$/.test(e.code) && !/[:=]/.test(e.message)));
  } finally { await s.drop(); }
});

// ---- M1-7 review fixes ----

test("setup ends every existing session: a session left in a restored backup that has no owner gets 401", async () => {
  const s = await server();
  try {
    const old = s.cookie;
    assert.equal(await sessionStatus(s, old), 404, "the session works while the owner exists");
    // A restored backup: a session row, no owner. A fresh process prepares setup and the operator runs it.
    await s.query("DELETE FROM owner");
    assert.equal(await count(s, "session"), 1, "the session row is still there");
    assert.equal(await sessionStatus(s, old), 401, "no owner: the session is not valid");
    const next = new Auth({ pool: s.store.pool, cookieSecure: true });
    const fresh = await next.prepareSetup();
    assert.ok(fresh);
    await next.setup(fresh.token, TEST_PASSWORD);
    assert.equal(await count(s, "owner"), 1);
    assert.equal(await count(s, "session"), 0, "setup deleted the old session rows");
    assert.equal(await sessionStatus(s, old), 401, "the old cookie stays dead with the new owner in place");
    assert.equal(await sessionStatus(s, cookieOf(await login(s, TEST_PASSWORD))), 404, "a new sign-in works");
  } finally { await s.drop(); }
});

test("every /api/ response that can carry library content says Cache-Control: no-store", async () => {
  const s = await server();
  try {
    const cc = (res: { headers: Record<string, unknown> }) => res.headers["cache-control"];
    assert.equal(cc(await s.inject({ method: "GET", url: "/api/export" })), "no-store");
    assert.equal(cc(await s.inject({ method: "GET", url: "/api/sync/v1/changes?epoch=x" })), "no-store");
    assert.equal(cc(await s.inject({ method: "GET", url: "/api/sync/v1/conflicts?epoch=x" })), "no-store");
    assert.equal(cc(await s.inject({ method: "POST", url: "/api/sync/v1/push", payload: { epoch: "e", deviceId: "d", ops: [] } })), "no-store");
    assert.equal(cc(await s.app.inject({ method: "GET", url: "/api/export" })), "no-store", "also on the 401");
  } finally { await s.drop(); }
});

test("a GET with Sec-Fetch-Site: same-site or cross-site is refused with 403 FORBIDDEN_ORIGIN; same-origin and no header pass", async () => {
  const s = await server();
  try {
    for (const site of ["same-site", "cross-site"]) {
      for (const url of ["/api/export", "/api/health", "/api/auth/session", "/api/sync/v1/changes?epoch=x"]) {
        const res = await s.inject({ method: "GET", url, headers: { host: "localhost:8080", "sec-fetch-site": site } });
        assert.equal(res.statusCode, 403, `${site} ${url}`);
        assert.equal(res.json().error.code, "FORBIDDEN_ORIGIN");
      }
    }
    for (const headers of [{ "sec-fetch-site": "same-origin" }, { "sec-fetch-site": "none" }, {}]) {
      assert.equal((await s.inject({ method: "GET", url: "/api/health", headers: { host: "localhost:8080", ...headers } })).statusCode, 200);
    }
  } finally { await s.drop(); }
});

test("a 1024-byte non-ASCII password, and one that JSON-escapes to over 4096 bytes, fit the auth body limit", async () => {
  for (const password of ["é".repeat(512), "\u0001".repeat(1024)]) {
    const s = await server({ anonymous: true });
    try {
      assert.equal(Buffer.byteLength(password), 1024);
      assert.ok(Buffer.byteLength(JSON.stringify({ token: s.setupToken, password })) > (password.startsWith("\u0001") ? 4096 : 0));
      const made = await post(s, "/api/auth/setup", { token: s.setupToken, password });
      assert.equal(made.statusCode, 201, made.body);
      assert.equal((await login(s, password)).statusCode, 200);
      // One byte over is refused for the right reason (the password rule), not the body limit.
      const s2 = await server({ anonymous: true });
      try {
        const over = await post(s2, "/api/auth/setup", { token: s2.setupToken, password: password + "x" });
        assert.equal(over.statusCode, 400);
        assert.equal(over.json().error.code, "INVALID_PASSWORD");
      } finally { await s2.drop(); }
    } finally { await s.drop(); }
  }
});

test("the byte cap is applied after normalisation at login too: a decomposed password accepted at setup signs in with the same input", async () => {
  const s = await server({ anonymous: true });
  try {
    const typed = "é".repeat(500); // 1500 bytes as typed, 1000 bytes composed
    assert.ok(Buffer.byteLength(typed) > 1024 && Buffer.byteLength(typed.normalize("NFKC")) <= 1024);
    assert.equal((await post(s, "/api/auth/setup", { token: s.setupToken, password: typed })).statusCode, 201);
    assert.equal((await login(s, typed)).statusCode, 200, "the same typed input");
    assert.equal((await login(s, typed.normalize("NFKC"))).statusCode, 200, "and its composed form");
    // Over the cap after normalising: refused at login (counted as a failed attempt), as it is at setup.
    const long = "é".repeat(600);
    assert.equal((await login(s, long)).statusCode, 401);
    const s2 = await server({ anonymous: true });
    try {
      assert.equal((await post(s2, "/api/auth/setup", { token: s2.setupToken, password: long })).statusCode, 400);
    } finally { await s2.drop(); }
  } finally { await s.drop(); }
});

test("scrypt parse bounds: N up to 2^18, r up to 8, p of 1; an owner hash at the current cost still verifies", async () => {
  const pw = "a long enough password";
  assert.equal(await verifyPassword(pw, await hashPassword(pw, { N: 2 ** 18, r: 8, p: 1 })), true);
  assert.equal(await verifyPassword(pw, await hashPassword(pw)), true, "the current cost (N=2^17)");
  assert.equal(await verifyPassword(pw, await hashPassword(pw, { N: 2 ** 19, r: 8, p: 1 })), false, "N above 2^18");
  assert.equal(await verifyPassword(pw, await hashPassword(pw, { N: 2 ** 10, r: 9, p: 1 })), false, "r above 8");
  assert.equal(await verifyPassword(pw, await hashPassword(pw, { N: 2 ** 10, r: 8, p: 2 })), false, "p other than 1");
  assert.equal(await verifyPassword(pw, await hashPassword(pw, { N: 2 ** 10, r: 8, p: 1 })), true, "the same hash inside the bounds");
});

test("the dummy hash is made during setup preparation when there is no owner", async () => {
  const s = await server({ anonymous: true });
  try {
    const peek = (a: Auth) => (a as unknown as { dummy: Promise<string> | undefined }).dummy;
    const fresh = new Auth({ pool: s.store.pool, cookieSecure: true });
    assert.equal(peek(fresh), undefined);
    await fresh.prepareSetup();
    assert.ok(peek(fresh), "made eagerly with no owner");
    assert.match(await peek(fresh)!, /^scrypt\$v1\$/);
    await post(s, "/api/auth/setup", { token: s.setupToken, password: TEST_PASSWORD });
    const withOwner = new Auth({ pool: s.store.pool, cookieSecure: true });
    await withOwner.prepareSetup();
    assert.equal(peek(withOwner), undefined, "no dummy when an owner exists");
  } finally { await s.drop(); }
});
