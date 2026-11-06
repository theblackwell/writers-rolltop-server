// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support.ts";
import { studioServer } from "../src/http.ts";
import { passwordHash } from "../src/auth.ts";
test("planning HTTP guards auth, origin, IDs, owner/kind, Trash and stale versions", async () => {
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
    const path = "/books/" + f.book.id + "/planning",
      node = "/books/" + f.book.id + "/nodes/" + f.chapter.id + "/planning";
    assert.equal((await req(path)).status, 401);
    assert.equal((await req(node, "PUT", {})).status, 401);
    const login = await req("/login", "POST", { password: "scratch-planning" });
    cookie = login.headers.get("set-cookie")!.split(";")[0];
    assert.equal((await req(path)).status, 200);
    assert.equal(
      (
        await req(
          path,
          "PUT",
          { expectedUpdatedAt: f.book.updatedAt, logline: "New" },
          "https://other.invalid",
        )
      ).status,
      403,
    );
    assert.equal((await req("/books/no/planning")).status, 400);
    assert.equal(
      (await req("/books/" + f.book.id + "/nodes/no/planning", "PUT", {}))
        .status,
      400,
    );
    const write = {
      expectedUpdatedAt: f.chapter.updatedAt,
      plan: "Beats",
      targetWordCount: 100,
      synopsis: "",
      status: "Draft",
    };
    const r = await req(node, "PUT", write);
    assert.equal(r.status, 200);
    const n = await r.json();
    assert.equal(n.plan, "Beats");
    assert.equal((await req(node, "PUT", write)).status, 409);
    const other = await f.store.createBook(f.library.id, "Other");
    assert.equal(
      (
        await req(
          "/books/" + other.id + "/nodes/" + f.chapter.id + "/planning",
          "PUT",
          { ...write, expectedUpdatedAt: n.updatedAt },
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await req(path, "PUT", {
          expectedUpdatedAt: f.book.updatedAt,
          povEntryId: crypto.randomUUID(),
        })
      ).status,
      400,
    );
    await f.store.trashBook(f.book.id);
    assert.equal((await req(path)).status, 400);
    assert.equal(
      (
        await req(node, "PUT", {
          expectedUpdatedAt: n.updatedAt,
          status: "New",
        })
      ).status,
      400,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.pg.close();
  }
});
