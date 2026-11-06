// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support.ts";
import { studioServer } from "../src/http.ts";
import { passwordHash } from "../src/auth.ts";
test("names HTTP is authenticated, bounded to a live book, read-only and follows existing flag writes", async () => {
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
    const path = "/books/" + f.book.id + "/names-needed";
    assert.equal((await req(path)).status, 401);
    const login = await req("/login", "POST", { password: "scratch-planning" });
    cookie = login.headers.get("set-cookie")!.split(";")[0];
    assert.equal((await req("/books/no/names-needed")).status, 400);
    assert.equal(
      (await req("/books/" + crypto.randomUUID() + "/names-needed")).status,
      404,
    );
    const entry = await f.store.createEntry(f.book.id, {
      entryType: "term",
      name: "[Keeper]",
      toBeNamed: true,
    });
    const response = await req(path);
    assert.equal(response.status, 200);
    const catalog = await response.json();
    assert.equal(catalog.items.length, 2);
    assert.equal(catalog.items[0].sourceId, entry.id);
    assert.equal((await req(path, "PUT", {})).status, 404);
    assert.equal(
      (
        await req(
          "/books/" + f.book.id + "/entries/" + entry.id,
          "PUT",
          { expectedUpdatedAt: entry.updatedAt, toBeNamed: false },
          "https://other.invalid",
        )
      ).status,
      403,
    );
    await f.store.updateEntry(f.book.id, entry.id, {
      expectedUpdatedAt: entry.updatedAt,
      toBeNamed: false,
    });
    assert.equal((await (await req(path)).json()).items.length, 1);
    await f.store.trashBook(f.book.id);
    assert.equal((await req(path)).status, 400);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.pg.close();
  }
});
