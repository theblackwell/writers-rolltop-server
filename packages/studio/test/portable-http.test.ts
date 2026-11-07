// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fixture } from "./support.ts";
import { studioServer } from "../src/http.ts";
import { passwordHash } from "../src/auth.ts";
import { readArchive } from "../src/archive-validation.ts";
test("portable HTTP authenticates raw uploads, checks origin, stages without mutation, cancels, installs and serves safe attachment downloads", async () => {
  const f = await fixture(),
    origin = "http://localhost:4317",
    server = studioServer(f.store, {
      origin,
      passwordHash: await passwordHash("scratch-portable"),
    });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + (server.address() as any).port + "/api";
  let cookie = "";
  const req = (path: string, method = "GET", data?: any, from = origin) =>
    fetch(base + path, {
      method,
      headers: {
        Cookie: cookie,
        Origin: from,
        "Content-Type": Buffer.isBuffer(data)
          ? "application/octet-stream"
          : "application/json",
      },
      ...(data === undefined
        ? {}
        : {
            body: Buffer.isBuffer(data)
              ? new Uint8Array(data)
              : JSON.stringify(data),
          }),
    });
  try {
    const archive = await readFile(
      new URL(
        "../fixtures/archives/valid/unknown-optional-fields.rolltop",
        import.meta.url,
      ),
    );
    assert.equal((await req("/archive-imports", "POST", archive)).status, 401);
    const login = await req("/login", "POST", { password: "scratch-portable" });
    cookie = login.headers.get("set-cookie")!.split(";")[0];
    assert.equal(
      (await req("/archive-imports", "POST", archive, "https://wrong.invalid"))
        .status,
      403,
    );
    assert.equal(
      (await req("/archive-imports", "POST", Buffer.from("garbage"))).status,
      400,
    );
    const preview = await (
      await req("/archive-imports", "POST", archive)
    ).json();
    assert.equal((await f.store.libraries()).length, 1);
    assert.equal(
      (await req(`/archive-imports/${preview.id}/cancel`, "POST", {})).status,
      200,
    );
    assert.equal(
      (
        await req(`/archive-imports/${preview.id}/commit`, "POST", {
          mode: "new",
        })
      ).status,
      410,
    );
    const p = await (await req("/archive-imports", "POST", archive)).json();
    const result = await req(`/archive-imports/${p.id}/commit`, "POST", {
      mode: "new",
    });
    assert.equal(result.status, 200);
    const reexport = await req(`/libraries/${p.libraryId}/archive`);
    assert.equal(reexport.status, 200);
    assert.match(reexport.headers.get("content-disposition")!, /attachment/);
    assert.equal(
      readArchive(Buffer.from(await reexport.arrayBuffer())).library.id,
      p.libraryId,
    );
    const path = `/libraries/${p.libraryId}/attachments`,
      bytes = Buffer.from("<script>alert(1)</script>"),
      uploaded = await req(
        path + "?name=hostile.html&mediaType=text%2Fhtml",
        "POST",
        bytes,
      );
    assert.equal(uploaded.status, 201);
    const a = await uploaded.json();
    assert.equal(
      (await (await req(path)).json()).length,
      readArchive(archive).attachments.length + 1,
    );
    const download = await req(path + "/" + a.sha256);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("x-content-type-options"), "nosniff");
    assert.match(download.headers.get("content-disposition")!, /attachment/);
    assert.equal(
      download.headers.get("content-type"),
      "application/octet-stream",
    );
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
    assert.equal(
      (await req(`/libraries/${f.library.id}/attachments/${a.sha256}`)).status,
      404,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await f.pg.close();
  }
});
