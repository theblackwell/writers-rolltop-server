import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readArchive, writeArchive } from "@writers-rolltop/archive";
import { semantic } from "../../store/test/semantic.ts";
import { archiveFixtures, rowCount, server } from "./helpers.ts";

const expected: Record<string, string> = JSON.parse(await readFile(path.join(archiveFixtures, "expected.json"), "utf8"));
const post = (s: Awaited<ReturnType<typeof server>>, payload: Buffer | string, contentType = "application/zip") =>
  s.app.inject({ method: "POST", url: "/api/import", payload, headers: { "content-type": contentType } });

for (const name of ["sample-library", "record-overrides", "unknown-optional-fields"]) {
  test(`${name}: import over HTTP, then export over HTTP, is semantically identical`, async () => {
    const s = await server();
    const out = await mkdtemp(path.join(tmpdir(), "rolltop-api-out-"));
    try {
      const file = path.join(archiveFixtures, "valid", `${name}.rolltop`);
      const res = await post(s, await readFile(file));
      assert.equal(res.statusCode, 201, res.body);
      const body = res.json();
      assert.equal(typeof body.summary.libraryId, "string");
      assert.ok(Array.isArray(body.warnings));
      const exp = await s.app.inject({ method: "GET", url: "/api/export" });
      assert.equal(exp.statusCode, 200);
      assert.equal(exp.headers["content-type"], "application/zip");
      assert.match(String(exp.headers["content-disposition"]), /attachment; filename="library\.rolltop"/);
      const dest = path.join(out, "back.rolltop");
      await writeFile(dest, exp.rawPayload);
      const original = await readArchive(file);
      const back = await readArchive(dest);
      assert.equal(semantic(back.data, back.manifest.libraryId as string), semantic(original.data, original.manifest.libraryId as string));
      await original.close(); await back.close();
      assert.deepEqual(await readdir(s.exportsDir), [], "the export file is removed once it has been sent");
      assert.deepEqual(await s.store.checkIntegrity(), { ok: true, problems: [] });
      // One library per database.
      const again = await post(s, await readFile(file));
      assert.equal(again.statusCode, 409);
      assert.equal(again.json().error.code, "LIBRARY_EXISTS");
    } finally { await rm(out, { recursive: true, force: true }); await s.drop(); }
  });
}

test("export with no library is a 404 with a stable code", async () => {
  const s = await server();
  try {
    const res = await s.app.inject({ method: "GET", url: "/api/export" });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error.code, "LIBRARY_NOT_FOUND");
  } finally { await s.drop(); }
});

for (const [fixture, code] of Object.entries(expected)) {
  if (code === "VALID") continue;
  test(`${fixture}: HTTP import is refused with ${code}, the database is unchanged and the error body is generic`, async () => {
    const s = await server();
    try {
      const res = await post(s, await readFile(path.join(archiveFixtures, fixture)));
      assert.ok(res.statusCode === 422 || res.statusCode === 413, `${res.statusCode}`);
      const body = res.json();
      assert.equal(body.error.code, code);
      assert.equal(await rowCount(s), 0);
      assert.deepEqual(await readdir(s.attachmentsDir).catch(() => []), []);
      // No absolute paths, no file names from the archive, no document text.
      assert.doesNotMatch(res.body, /\/(Users|private|tmp|var|home)\//);
      assert.deepEqual(Object.keys(body.error).filter((k) => !["code", "message", "issues", "issuesTruncated"].includes(k)), []);
      for (const entry of s.logs) assert.deepEqual(Object.keys(entry).filter((k) => !["code", "message", "issues"].includes(k)), []);
    } finally { await s.drop(); }
  });
}

test("an oversized body is refused with 413 before any work starts", async () => {
  const s = await server({ maxImportBytes: 1024 });
  try {
    const res = await post(s, await readFile(path.join(archiveFixtures, "valid", "sample-library.rolltop")));
    assert.equal(res.statusCode, 413);
    assert.equal(res.json().error.code, "PAYLOAD_TOO_LARGE");
    assert.equal(await rowCount(s), 0);
  } finally { await s.drop(); }
});

test("a wrong content type is 415", async () => {
  const s = await server();
  try {
    const res = await post(s, "hello", "text/plain");
    assert.equal(res.statusCode, 415);
    assert.equal(res.json().error.code, "UNSUPPORTED_MEDIA_TYPE");
  } finally { await s.drop(); }
});

test("garbage bytes are refused as not an archive, with a generic message", async () => {
  const s = await server();
  try {
    const res = await post(s, Buffer.from("this is not a zip file at all, it only looks like text"));
    assert.equal(res.statusCode, 422);
    assert.match(res.json().error.code, /^ARCHIVE_/);
  } finally { await s.drop(); }
});

/** A valid archive made from the sample plus `mutate`. */
async function craft(mutate: (data: any) => void): Promise<Buffer> {
  const original = await readArchive(path.join(archiveFixtures, "valid", "record-overrides.rolltop"));
  const data = original.data as any;
  mutate(data);
  const dir = await mkdtemp(path.join(tmpdir(), "rolltop-craft-"));
  try {
    const file = path.join(dir, "c.rolltop");
    await writeArchive(data, async (sha) => original.attachments.get(sha)!.read(), file);
    return await readFile(file);
  } finally { await original.close(); await rm(dir, { recursive: true, force: true }); }
}
const T = "2026-11-02T12:00:00Z";
const uuid = (p: string, n: number) => `${p}0000000-${(n >> 16).toString(16).padStart(4, "0").slice(-4)}-4000-8000-${n.toString(16).padStart(12, "0")}`;

test("crafted input: the chronology cost trips the worker's time budget, and the database is unchanged", async () => {
  // 2,000 books each overridden by events of a 20,000-event timeline: about 40 million steps, about 1.6 s here.
  const bytes = await craft((data) => {
    const lib = data.library;
    const universeId = lib.universes[0].id, seriesId = lib.series[0].id;
    const books: string[] = [];
    for (let i = 0; i < 2000; i++) { const id = uuid("4", 100000 + i); books.push(id); lib.books.push({ id, title: "B", orderKey: "9", seriesId, universeId, createdAt: T, updatedAt: T }); }
    for (let i = 0; i < 20000; i++) {
      data.events.push({ id: uuid("d", 100000 + i), title: "E", orderKey: `${String(i).padStart(7, "0")}1`, scope: { kind: "universe", id: universeId }, participants: [], sceneIds: [], createdAt: T, updatedAt: T,
        when: { calendar: "C", label: "x", ordinal: i }, overrides: [{ bookId: books[i % 2000], when: { calendar: "C", label: "y", ordinal: i } }] });
    }
  });
  const s = await server({ timeoutMs: 700 });
  try {
    const started = Date.now();
    const res = await post(s, bytes);
    assert.equal(res.statusCode, 422, res.body);
    assert.equal(res.json().error.code, "IMPORT_TIMEOUT");
    assert.ok(Date.now() - started < 8000, "the request was answered shortly after the budget");
    assert.equal(await rowCount(s), 0);
    // The server is still healthy and can import a normal archive afterwards.
    const ok = await post(s, await readFile(path.join(archiveFixtures, "valid", "sample-library.rolltop")));
    assert.equal(ok.statusCode, 201, ok.body);
  } finally { await s.drop(); }
});

test("crafted input: a huge JSON file trips the worker's memory cap, and the database is unchanged", async () => {
  const bytes = await craft((data) => {
    const bookId = data.library.books[0].id;
    for (let i = 0; i < 250_000; i++) data.notes.push({ id: uuid("f", 500000 + i), bookId, text: `note ${i} ${"x".repeat(60)}`, orderKey: "h", createdAt: T, updatedAt: T });
  });
  const s = await server({ maxHeapMb: 96 });
  try {
    const res = await post(s, bytes);
    assert.equal(res.statusCode, 422, res.body);
    assert.equal(res.json().error.code, "IMPORT_MEMORY_EXCEEDED");
    assert.equal(await rowCount(s), 0);
    const ok = await s.app.inject({ method: "GET", url: "/api/health" });
    assert.equal(ok.statusCode, 200);
  } finally { await s.drop(); }
});

test("unknown routes and server faults answer with the generic error envelope", async () => {
  const s = await server();
  try {
    await rm(s.exportsDir, { recursive: true });
    await writeFile(s.exportsDir, "a file where the exports folder should be");
    const nope = await s.app.inject({ method: "GET", url: "/nope/../secret" });
    assert.equal(nope.statusCode, 404);
    assert.deepEqual(nope.json(), { error: { code: "NOT_FOUND", message: "There is nothing at this address." } });
    // An internal failure (the exports folder cannot be created) must not leak the path.
    await post(s, await readFile(path.join(archiveFixtures, "valid", "sample-library.rolltop")));
    const res = await s.app.inject({ method: "GET", url: "/api/export" });
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.json(), { error: { code: "INTERNAL_ERROR", message: "The server could not complete the request." } });
    assert.doesNotMatch(JSON.stringify(s.logs) + res.body, /exports|\/(Users|private|tmp|var)\//);
    assert.ok(s.logs.length > 0);
  } finally { await s.drop(); }
});
