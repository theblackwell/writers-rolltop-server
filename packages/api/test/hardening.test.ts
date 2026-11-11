import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { buildApp } from "../src/app.ts";
import { ApiError } from "../src/api-errors.ts";
import { runImport } from "../src/import-runner.ts";
import { archiveFromFiles, unpackedFiles } from "../../archive/test/helpers.ts";
import { archiveFixtures, rowCount, server } from "./helpers.ts";
import type { Server } from "./helpers.ts";

const sampleBytes = () => readFile(path.join(archiveFixtures, "valid", "sample-library.rolltop"));
const T0 = new Date("2026-11-10T12:00:00Z");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function listen(s: Server): Promise<number> {
  await s.app.listen({ port: 0, host: "127.0.0.1" });
  return (s.app.server.address() as { port: number }).port;
}
async function until(check: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) assert.fail("the condition did not become true in time");
    await sleep(50);
  }
}
async function getExport(port: number, cookie: string): Promise<{ status: number; length: number }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/export`, { headers: { cookie } });
  return { status: res.status, length: (await res.arrayBuffer()).byteLength };
}

// ---- 1. a client that leaves must not hold the export slot ----

test("a client that aborts an export, mid-download or before the answer, frees the slot and leaves no temp file", async () => {
  const s = await server();
  try {
    const port = await listen(s);
    const imp = await s.inject({ method: "POST", url: "/api/import", payload: await sampleBytes(), headers: { "content-type": "application/zip" } });
    assert.equal(imp.statusCode, 201);
    await s.store.putAttachment(randomBytes(40 * 1024 ** 2), { mediaType: "application/octet-stream", createdAt: T0 }); // big enough that the download cannot finish in the socket buffers

    // (a) leaves in the middle of the download
    await new Promise<void>((resolve) => {
      const req = http.get({ port, host: "127.0.0.1", path: "/api/export", headers: { cookie: s.cookie } }, (res) => { res.pause(); res.socket.destroy(); resolve(); });
      req.on("error", () => {});
    });
    await until(async () => (await readdir(s.exportsDir)).length === 0);
    // (b) leaves while the file is still being built
    const early = http.get({ port, host: "127.0.0.1", path: "/api/export", headers: { cookie: s.cookie } });
    early.on("error", () => {});
    await sleep(15);
    early.destroy();
    await until(async () => (await readdir(s.exportsDir)).length === 0, 15_000);

    // The slot is free again and an export works start to finish.
    let result = { status: 0, length: 0 };
    await until(async () => { result = await getExport(port, s.cookie); return result.status !== 429; });
    assert.equal(result.status, 200);
    assert.ok(result.length > 40 * 1024 ** 2);
    await until(async () => (await readdir(s.exportsDir)).length === 0);
  } finally { await s.drop(); }
});

// ---- 3 and 10. export faults are server faults, and the log has codes only ----

test("an export fault is a generic 500 (never 422), logged by code only, and the slot is released", async () => {
  const s = await server();
  try {
    assert.equal((await s.inject({ method: "POST", url: "/api/import", payload: await sampleBytes(), headers: { "content-type": "application/zip" } })).statusCode, 201);
    const [file] = (await readdir(s.attachmentsDir)).sort();
    await rm(path.join(s.attachmentsDir, file!));
    for (let i = 0; i < 2; i++) {
      const res = await s.inject({ method: "GET", url: "/api/export" });
      assert.equal(res.statusCode, 500);
      assert.deepEqual(res.json(), { error: { code: "INTERNAL_ERROR", message: "The server could not complete the request." } });
    }
    assert.ok(s.logs.length >= 2);
    for (const entry of s.logs) {
      assert.deepEqual(entry, { code: "INTERNAL_ERROR", message: entry.message });
      assert.match(entry.message, /^[A-Z_]+$/, "the log carries a code, not a message with paths");
    }
    assert.deepEqual(await readdir(s.exportsDir), []);
  } finally { await s.drop(); }
});

// ---- 5. host check ----

test("requests for another Host are refused with 403; loopback names and allowed names pass", async () => {
  const app = buildApp({ allowedHosts: ["files.example"] });
  const get = (headers: Record<string, string>) => app.inject({ method: "GET", url: "/api/health", headers });
  for (const host of ["127.0.0.1", "127.0.0.1:8080", "localhost", "LOCALHOST:3000", "[::1]", "[::1]:9", "files.example", "files.example:443"]) {
    assert.equal((await get({ host })).statusCode, 200, host);
  }
  for (const host of ["evil.example", "evil.example:8080", "127.0.0.1.evil.example", "localhost.evil.example", "files.example.evil.com"]) {
    const res = await get({ host });
    assert.equal(res.statusCode, 403, host);
    assert.equal(res.json().error.code, "FORBIDDEN_HOST");
  }
  const cross = await get({ host: "localhost", "sec-fetch-site": "cross-site" });
  assert.equal(cross.statusCode, 403);
  assert.equal(cross.json().error.code, "FORBIDDEN_ORIGIN");
  assert.equal((await get({ host: "localhost", "sec-fetch-site": "same-origin" })).statusCode, 200);
  await app.close();
});

// ---- 7. a busy server refuses before reading the body ----

test("a second concurrent upload gets 429 as soon as its headers arrive, without its body being read", async () => {
  const s = await server({ timeoutMs: 3000, fault: "spin" });
  try {
    const port = await listen(s);
    const first = new Promise<{ status?: number; body: string }>((resolve) => {
      const req = http.request({ port, host: "127.0.0.1", path: "/api/import", method: "POST", headers: { cookie: s.cookie, "content-type": "application/zip" } }, (res) => {
        let body = "";
        res.on("data", (d) => { body += d; });
        res.on("end", () => resolve({ status: res.statusCode, body }));
      });
      req.end(Buffer.from("x"));
    });
    await sleep(300); // the first import is now being processed by the (spinning) worker
    const started = Date.now();
    const second = await new Promise<number | undefined>((resolve, reject) => {
      const req = http.request({ port, host: "127.0.0.1", path: "/api/import", method: "POST", headers: { cookie: s.cookie, "content-type": "application/zip", "content-length": String(500 * 1024 ** 2) } }, (res) => {
        resolve(res.statusCode);
        req.destroy();
      });
      req.on("error", () => {});
      req.flushHeaders(); // headers only: not one byte of the promised 500 MiB body is ever sent
      setTimeout(() => reject(new Error("no answer before the body")), 2000);
    });
    assert.equal(second, 429);
    assert.ok(Date.now() - started < 1500);
    const done = await first;
    assert.equal(done.status, 422);
    assert.match(done.body, /IMPORT_TIMEOUT/);
  } finally { await s.drop(); }
});

test("a rejected or dropped upload gives the import slot back", async () => {
  const s = await server({ maxImportBytes: 64 });
  try {
    const post = (payload: Buffer | string, type = "application/zip") => s.inject({ method: "POST", url: "/api/import", payload, headers: { "content-type": type } });
    assert.equal((await post(Buffer.alloc(1000))).statusCode, 413);
    assert.equal((await post("hello", "text/plain")).statusCode, 415);
    const small = await post(Buffer.from("not a zip"));
    assert.equal(small.statusCode, 422, "not 429: the earlier failures released the slot");
  } finally { await s.drop(); }
});

test("request and connection timeouts are set on the HTTP server", async () => {
  const s = await server({ requestTimeoutMs: 7000, connectionTimeoutMs: 9000 });
  try {
    assert.equal(s.app.server.requestTimeout, 7000);
    assert.equal(s.app.server.timeout, 9000);
    const dflt = buildApp();
    assert.equal(dflt.server.requestTimeout, 600_000);
    await dflt.close();
  } finally { await s.drop(); }
});

// ---- 8. the worker's database connection ----

test("the worker's connection carries statement, lock and idle-in-transaction timeouts", async () => {
  const s = await server();
  try {
    const out = await runImport(Buffer.from("x"), { databaseUrl: s.url, attachmentsDir: s.attachmentsDir, timeoutMs: 5000, maxHeapMb: 512, fault: "show-settings" });
    assert.deepEqual(out.summary, { s: "5s", l: "10s", i: "1min" });
  } finally { await s.drop(); }
});

test("a worker killed with its transaction open leaves no rows and no lock, and the next import is not blocked", async () => {
  const s = await server();
  try {
    await assert.rejects(
      runImport(Buffer.from("x"), { databaseUrl: s.url, attachmentsDir: s.attachmentsDir, timeoutMs: 1500, maxHeapMb: 512, fault: "hold-transaction" }),
      (e) => e instanceof ApiError && e.code === "IMPORT_TIMEOUT");
    await until(async () => (await s.query("SELECT 1 FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE c.relname = 'library' AND l.pid <> pg_backend_pid()")).length === 0, 8000);
    assert.equal(await rowCount(s), 0, "the held transaction's row is not visible");
    const started = Date.now();
    const ok = await s.inject({ method: "POST", url: "/api/import", payload: await sampleBytes(), headers: { "content-type": "application/zip" } });
    assert.equal(ok.statusCode, 201, ok.body);
    assert.ok(Date.now() - started < 8000, "not blocked on the lock");
  } finally { await s.drop(); }
});

// ---- owner decision: NUL in archive text ----

test("archives with U+0000 in a title, a synopsis or a plan are refused over HTTP with SCHEMA_VIOLATION and nothing is written", async () => {
  const s = await server();
  try {
    const nul = "secret-text\u0000tail";
    const edits: ((j: any) => void)[] = [
      (j) => { j.books[0].title = nul; },
      (j) => { j.manuscriptNodes[0].synopsis = nul; },
      (j) => { j.manuscriptNodes.find((n: any) => n.kind === "chapter").plan = nul; },
    ];
    for (const edit of edits) {
      const files = await unpackedFiles("sample-library");
      const lib = JSON.parse(files.get("library.json")!.toString("utf8"));
      edit(lib);
      files.set("library.json", Buffer.from(JSON.stringify(lib)));
      const res = await s.inject({ method: "POST", url: "/api/import", payload: archiveFromFiles(files), headers: { "content-type": "application/zip" } });
      assert.equal(res.statusCode, 422);
      assert.equal(res.json().error.code, "SCHEMA_VIOLATION");
      assert.doesNotMatch(res.body, /secret-text/);
      assert.equal(await rowCount(s), 0);
      assert.deepEqual(await readdir(s.attachmentsDir).catch(() => []), []);
    }
  } finally { await s.drop(); }
});

// ---- import slot belongs to its holder ----

test("a client that leaves after its body arrived does not free the slot while its import still runs", async () => {
  const s = await server({ timeoutMs: 2500, fault: "spin" });
  try {
    const port = await listen(s);
    const first = http.request({ port, host: "127.0.0.1", path: "/api/import", method: "POST", headers: { cookie: s.cookie, "content-type": "application/zip" } });
    first.on("error", () => {});
    first.end(Buffer.from("x"));
    await sleep(400); // body delivered, worker spinning
    first.destroy();
    await sleep(100);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = http.request({ port, host: "127.0.0.1", path: "/api/import", method: "POST", headers: { cookie: s.cookie, "content-type": "application/zip", "content-length": "1" } }, (res) => { resolve(res.statusCode); req.destroy(); });
      req.on("error", () => {});
      req.flushHeaders();
      setTimeout(() => reject(new Error("no answer")), 2000);
    });
    assert.equal(status, 429, "the first import is still running, so no second one may start");
    // Once the worker's budget ends, the slot is free again.
    await until(async () => {
      const r = await s.inject({ method: "POST", url: "/api/import", payload: Buffer.from("x"), headers: { "content-type": "application/zip" } });
      return r.statusCode !== 429;
    }, 10_000);
  } finally { await s.drop(); }
});

// ---- COMMIT answer lost, through the worker's one-connection pool ----

test("a lost COMMIT answer is resolved, not hung, when the worker has a single database connection", async () => {
  for (const mode of ["lose-commit-after", "lose-commit-before"] as const) {
    const s = await server();
    try {
      const started = Date.now();
      const run = runImport(await sampleBytes(), { databaseUrl: s.url, attachmentsDir: s.attachmentsDir, timeoutMs: 20_000, maxHeapMb: 1024, fault: mode });
      if (mode === "lose-commit-after") {
        const out = await run; // the library did commit: success, files kept
        assert.ok(out.summary);
        assert.equal(Number((await s.query("SELECT count(*) AS n FROM library"))[0].n), 1);
        assert.equal((await readdir(s.attachmentsDir)).length, 3);
        assert.deepEqual(await s.store.checkIntegrity(), { ok: true, problems: [] });
      } else {
        await assert.rejects(run, (e) => e instanceof ApiError && e.code !== "IMPORT_TIMEOUT"); // an answer, not a hang
        assert.equal(await rowCount(s), 0);
        assert.deepEqual(await readdir(s.attachmentsDir), []);
      }
      assert.ok(Date.now() - started < 10_000, `${mode} took ${Date.now() - started} ms`);
    } finally { await s.drop(); }
  }
});
