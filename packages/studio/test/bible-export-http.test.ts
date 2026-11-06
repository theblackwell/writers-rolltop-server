// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support.ts";
import { studioServer } from "../src/http.ts";
import { passwordHash } from "../src/auth.ts";
test("bible export HTTP authenticates, validates origin/IDs/format/version/CAS, serves private typed downloads and isolates books", async () => {
  const f = await fixture(),
    origin = "http://localhost:4317",
    server = studioServer(f.store, {
      origin,
      passwordHash: await passwordHash("scratch-planning"),
    });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + (server.address() as any).port + "/api";
  let cookie = "";
  const req = (path: string, method = "GET", value?: object, from = origin) =>
    fetch(base + path, {
      method,
      headers: {
        Cookie: cookie,
        Origin: from,
        "Content-Type": "application/json",
      },
      ...(value ? { body: JSON.stringify(value) } : {}),
    });
  try {
    const path = "/books/" + f.book.id + "/bible-exports";
    assert.equal((await req(path)).status, 401);
    const login = await req("/login", "POST", { password: "scratch-planning" });
    cookie = login.headers.get("set-cookie")!.split(";")[0];
    assert.equal((await req("/books/no/bible-exports")).status, 400);
    assert.equal((await req(path)).status, 200);
    const input = {
      id: crypto.randomUUID(),
      version: "1.0",
      format: "docx",
      expectedUpdatedAt: f.book.updatedAt,
    };
    assert.equal(
      (await req(path, "POST", input, "https://other.invalid")).status,
      403,
    );
    assert.equal(
      (await req(path, "POST", { ...input, format: "html" })).status,
      400,
    );
    assert.equal(
      (await req(path, "POST", { ...input, version: "x".repeat(33) })).status,
      400,
    );
    const result = await req(path, "POST", input);
    assert.equal(result.status, 201);
    const saved = await result.json();
    assert.equal(saved.book.bibleVersion, "1.0");
    assert.equal((await req(path, "POST", input)).status, 201);
    assert.equal(
      (await req(path, "POST", { ...input, id: crypto.randomUUID() })).status,
      409,
    );
    const download = await req(path + "/" + input.id);
    assert.equal(download.status, 200);
    assert.match(download.headers.get("content-type")!, /wordprocessingml/);
    assert.equal(download.headers.get("cache-control"), "no-store");
    assert.equal(
      Buffer.from(await download.arrayBuffer())
        .subarray(0, 2)
        .toString(),
      "PK",
    );
    const foreign = await f.store.createBook(f.library.id, "Other");
    assert.equal(
      (await req("/books/" + foreign.id + "/bible-exports/" + input.id)).status,
      404,
    );
    assert.equal((await req(path + "/bad")).status, 400);
    assert.equal((await req(path + "/" + input.id, "DELETE")).status, 405);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.pg.close();
  }
});
