// SPDX-License-Identifier: AGPL-3.0-only
import { fixture } from "./support.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { StudioError } from "../src/store.ts";
import { passwordHash } from "../src/auth.ts";
import { studioServer } from "../src/http.ts";

test("migrations are repeatable; hierarchy, ordering and canonical documents persist", async () => {
  const f = await fixture();
  try {
    await f.store.migrate();
    assert.equal((await f.store.libraries()).length, 1);
    const next = await f.store.createNode(
      f.book.id,
      "Scene 2",
      "scene",
      f.chapter.id,
    );
    const data = await f.store.book(f.book.id);
    assert.ok(
      data.nodes.find((n) => n.id === f.scene.id).orderKey <
        data.nodes.find((n) => n.id === next.id).orderKey,
    );
    const document = await f.store.document(f.scene.id);
    assert.equal(document.document.nodeId, f.scene.id);
    assert.equal(document.revision, 1);
    await assert.rejects(
      () => f.store.createNode(f.book.id, "Wrong", "scene"),
      StudioError,
    );
    const other = await f.store.createBook(f.library.id, "Other");
    await assert.rejects(
      () => f.store.createNode(other.id, "Wrong", "scene", f.chapter.id),
      StudioError,
    );
    await assert.rejects(
      () => f.store.createNode(f.book.id, "Wrong", "part", f.chapter.id),
      StudioError,
    );
    assert.equal((await f.store.book(f.book.id)).nodes.length, 3);
  } finally {
    await f.pg.close();
  }
});
test("stale and concurrent saves preserve both current content and immutable revision history", async () => {
  const f = await fixture();
  try {
    const { document: original } = await f.store.document(f.scene.id);
    const doc = structuredClone(original);
    if (doc.blocks[0].type === "paragraph")
      doc.blocks[0].content = [
        { type: "text", text: "First draft: e\u0301, 雨, 🖋️." },
      ];
    const result = await f.store.save(f.scene.id, doc, 1);
    assert.equal(result.revision, 2);
    await assert.rejects(
      () => f.store.save(f.scene.id, original, 1),
      (e: unknown) => e instanceof StudioError && e.status === 409,
    );
    assert.deepEqual((await f.store.document(f.scene.id)).document, doc);
    assert.deepEqual(
      (await f.store.revision(f.scene.id, 1)).document,
      original,
    );
    assert.equal(
      (await f.store.save(f.scene.id, doc, 2)).revision,
      2,
      "unchanged save adds no revision",
    );
    const outcomes = await Promise.allSettled([
      f.store.save(f.scene.id, original, 2),
      f.store.save(f.scene.id, { ...doc, blocks: [] }, 2),
    ]);
    assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal((await f.store.revisions(f.scene.id)).length, 3);
    const current = await f.store.document(f.scene.id);
    await f.store.save(f.scene.id, doc, current.revision);
    assert.deepEqual((await f.store.document(f.scene.id)).document, doc);
    const bad = { ...doc, nodeId: f.book.id };
    await assert.rejects(() => f.store.save(f.scene.id, bad, 4), StudioError);
    await assert.rejects(() =>
      f.store.save(f.scene.id, { ...doc, version: 2 }, 4),
    );
  } finally {
    await f.pg.close();
  }
});
test("HTTP authentication, same-origin writes, expiry, conflict responses and session revocation", async () => {
  const f = await fixture();
  const password = "scratch-password-for-tests";
  const origin = "http://localhost:4317";
  const server = studioServer(f.store, {
    origin,
    passwordHash: await passwordHash(password),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const base = "http://127.0.0.1:" + port;
  let cookie = "";
  async function request(
    path: string,
    method = "GET",
    data?: unknown,
    requestOrigin = origin,
  ) {
    return fetch(base + "/api" + path, {
      method,
      headers: {
        Cookie: cookie,
        Origin: requestOrigin,
        "Content-Type": "application/json",
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  }
  try {
    assert.equal((await request("/health")).status, 200);
    assert.equal((await request("/libraries")).status, 401);
    assert.equal((await request(`/books/${f.book.id}/progress`)).status, 401);
    assert.equal(
      (await request(`/books/${f.book.id}/search?q=Scene`)).status,
      401,
    );
    assert.equal(
      (await request("/login", "POST", { password }, "https://evil.example"))
        .status,
      403,
    );
    assert.equal(
      (await request("/login", "POST", { password: "wrong" })).status,
      401,
    );
    const login = await request("/login", "POST", { password });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get("set-cookie")!;
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    cookie = setCookie.split(";")[0];
    assert.equal((await request("/libraries")).status, 200);
    const notePath = `/books/${f.book.id}/notes`;
    assert.equal(
      (
        await request(
          notePath,
          "POST",
          { text: "Blocked" },
          "https://evil.example",
        )
      ).status,
      403,
    );
    const noteResponse = await request(notePath, "POST", {
      text: "HTTP note",
      nodeId: f.scene.id,
    });
    assert.equal(noteResponse.status, 201);
    const note = await noteResponse.json();
    assert.equal((await (await request(notePath)).json())[0].id, note.id);
    const updatedNote = await request(`${notePath}/${note.id}`, "PUT", {
      text: "Updated",
      expectedUpdatedAt: note.updatedAt,
    });
    assert.equal(updatedNote.status, 200);
    assert.equal(
      (
        await request(`${notePath}/${note.id}`, "PUT", {
          text: "Stale",
          expectedUpdatedAt: note.updatedAt,
        })
      ).status,
      409,
    );
    assert.equal((await request(`${notePath}/invalid`, "PUT", {})).status, 400);
    const entryPath = `/books/${f.book.id}/entries`;
    assert.equal(
      (
        await request(
          entryPath,
          "POST",
          { name: "Blocked", entryType: "term" },
          "https://evil.example",
        )
      ).status,
      403,
    );
    const entryResponse = await request(entryPath, "POST", {
      name: "HTTP character",
      entryType: "character",
    });
    assert.equal(entryResponse.status, 201);
    const entry = await entryResponse.json();
    assert.equal((await (await request(entryPath)).json())[0].id, entry.id);
    const referencePath = `/nodes/${f.scene.id}/references`;
    const passage = await f.store.document(f.scene.id);
    const anchorId = crypto.randomUUID();
    if (passage.document.blocks[0].type === "sceneBreak")
      throw new Error("Expected paragraph");
    passage.document.blocks[0].content = [
      {
        type: "text",
        text: "HTTP passage",
        marks: [{ type: "anchor", id: anchorId }],
      },
    ];
    const anchorSave = await f.store.save(
      f.scene.id,
      passage.document,
      passage.revision,
    );
    const referenceResponse = await request(referencePath, "POST", {
      entryId: entry.id,
      anchorId,
      expectedRevision: anchorSave.revision,
    });
    assert.equal(referenceResponse.status, 201);
    const reference = await referenceResponse.json();
    assert.equal(
      (await (await request(referencePath)).json())[0].id,
      reference.id,
    );
    assert.equal(
      (
        await request(
          `${referencePath}/${reference.id}`,
          "PUT",
          { deleted: true, expectedUpdatedAt: reference.updatedAt },
          "https://evil.example",
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await request(`${referencePath}/${reference.id}`, "PUT", {
          deleted: true,
          expectedUpdatedAt: reference.updatedAt,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request(`${referencePath}/${reference.id}`, "PUT", {
          deleted: false,
          expectedUpdatedAt: reference.updatedAt,
        })
      ).status,
      409,
    );
    assert.equal(
      (await request(`${referencePath}/invalid`, "PUT", {})).status,
      400,
    );
    const totals = await request(`/books/${f.book.id}/progress`);
    assert.equal(totals.status, 200);
    assert.equal((await totals.json()).words, 2);
    const hits = await (
      await request(`/books/${f.book.id}/search?q=Scene%201`)
    ).json();
    assert.equal(hits.results[0].nodeId, f.scene.id);
    assert.equal((await request(`/books/${f.book.id}/search?q=`)).status, 400);

    assert.equal(
      (
        await request(
          "/libraries",
          "POST",
          { title: "Blocked" },
          "https://evil.example",
        )
      ).status,
      403,
    );
    assert.equal(
      (await request("/libraries", "POST", { title: "" })).status,
      400,
    );
    const doc = await (await request(`/documents/${f.scene.id}`)).json();
    assert.equal(
      (
        await request(`/documents/${f.scene.id}`, "PUT", {
          document: doc.document,
          expectedRevision: 99,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await request(`/books/${f.book.id}`, "PUT", {
          title: "Renamed over HTTP",
        })
      ).status,
      200,
    );
    assert.equal(
      (await request(`/nodes/${f.scene.id}`, "PUT", { title: "Scene renamed" }))
        .status,
      200,
    );
    assert.equal(
      (
        await request(`/nodes/${f.scene.id}/move`, "POST", {
          parentId: f.chapter.id,
          beforeId: null,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request(`/nodes/${f.scene.id}/move`, "POST", {
          parentId: 123,
          beforeId: null,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(
          `/nodes/${f.scene.id}/trash`,
          "POST",
          {},
          "https://evil.example",
        )
      ).status,
      403,
    );
    assert.equal(
      (await request(`/nodes/${f.chapter.id}/trash`, "POST", {})).status,
      200,
    );
    assert.equal(
      (
        await request(`/documents/${f.scene.id}`, "PUT", {
          document: doc.document,
          expectedRevision: doc.revision,
        })
      ).status,
      409,
    );
    assert.equal(
      (await request(`/nodes/${f.chapter.id}/restore`, "POST", {})).status,
      200,
    );
    assert.equal(
      (await request(`/books/${f.book.id}/trash`, "POST", {})).status,
      200,
    );
    assert.equal(
      (await request(`/books/${f.book.id}/restore`, "POST", {})).status,
      200,
    );
    assert.equal(
      (await (await request(`/books/${f.book.id}`)).json()).book.title,
      "Renamed over HTTP",
    );
    assert.equal((await request("/logout", "POST", {})).status, 200);
    assert.equal((await request("/session")).status, 401);
    const second = await request("/login", "POST", { password });
    cookie = second.headers.get("set-cookie")!.split(";")[0];
    await f.store.db.query(
      "UPDATE studio_sessions SET expires_at=now()-interval '1 hour'",
    );
    assert.equal((await request("/session")).status, 401);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.pg.close();
  }
});
test("production configuration rejects missing hashes and insecure remote origins", async () => {
  const f = await fixture();
  try {
    const hash = await passwordHash("scratch-password-for-tests");
    assert.throws(
      () =>
        studioServer(f.store, {
          origin: "http://studio.example",
          passwordHash: hash,
        }),
      /HTTPS/,
    );
    assert.throws(
      () =>
        studioServer(f.store, {
          origin: "http://localhost:4317",
          passwordHash: "plaintext",
        }),
      /STUDIO_PASSWORD_HASH/,
    );
  } finally {
    await f.pg.close();
  }
});

test("a failed revision append rolls back the document update atomically", async () => {
  const f = await fixture();
  try {
    const before = await f.store.document(f.scene.id);
    const original = f.store.db;
    f.store.db = {
      ...original,
      transaction: (fn) =>
        original.transaction((q) =>
          fn(async (sql, params) => {
            if (sql.startsWith("INSERT INTO document_revisions"))
              throw new Error("Injected disk/write failure");
            return q(sql, params);
          }),
        ),
    };
    const changed = structuredClone(before.document);
    if (changed.blocks[0].type === "paragraph")
      changed.blocks[0].content = [
        { type: "text", text: "Must not be half saved." },
      ];
    await assert.rejects(
      () => f.store.save(f.scene.id, changed, before.revision),
      /Injected/,
    );
    assert.deepEqual(await f.store.document(f.scene.id), before);
    assert.equal((await f.store.revisions(f.scene.id)).length, 1);
  } finally {
    await f.pg.close();
  }
});

test("newer database schemas are refused without changing their version", async () => {
  const f = await fixture();
  try {
    await f.store.db.query("UPDATE studio_schema SET version=12");
    await assert.rejects(() => f.store.migrate(), /newer/);
    assert.equal(
      (await f.store.db.query("SELECT version FROM studio_schema")).rows[0]
        .version,
      12,
    );
  } finally {
    await f.pg.close();
  }
});

test("100,000 words save and reload with exact Unicode and canonical IDs", async () => {
  const f = await fixture();
  try {
    const doc = (await f.store.document(f.scene.id)).document;
    const text = "word ".repeat(100000) + "e\u0301 雨 🖋️";
    if (doc.blocks[0].type === "paragraph")
      doc.blocks[0].content = [{ type: "text", text }];
    await f.store.save(f.scene.id, doc, 1);
    assert.deepEqual((await f.store.document(f.scene.id)).document, doc);
    assert.deepEqual((await f.store.revision(f.scene.id, 2)).document, doc);
  } finally {
    await f.pg.close();
  }
});

test("book details preserve unknown fields and manuscripts; goals validate and clear", async () => {
  const f = await fixture();
  try {
    await f.store.db.query(
      "UPDATE books SET data=data || $2::jsonb WHERE id=$1",
      [f.book.id, JSON.stringify({ futureField: { keep: true } })],
    );
    const before = await f.store.document(f.scene.id);
    const updated = await f.store.updateBookDetails(f.book.id, {
      title: "New title",
      authorName: "A Writer",
      language: "en-US",
      targetWordCount: 80000,
      targetDate: "2028-02-29",
    });
    assert.deepEqual(updated.futureField, { keep: true });
    assert.equal(updated.targetWordCount, 80000);
    assert.deepEqual((await f.store.book(f.book.id)).book, updated);
    for (const bad of [
      { targetWordCount: 0 },
      { targetWordCount: 1.5 },
      { targetWordCount: "10" },
      { targetDate: "2027-02-29" },
      { language: "bad tag" },
      { id: f.scene.id },
    ]) {
      await assert.rejects(
        () => f.store.updateBookDetails(f.book.id, bad),
        StudioError,
      );
    }
    const cleared = await f.store.updateBookDetails(f.book.id, {
      targetWordCount: null,
      targetDate: "",
    });
    assert.equal(cleared.targetWordCount, undefined);
    assert.equal(cleared.targetDate, undefined);
    assert.equal(cleared.authorName, "A Writer");
    assert.deepEqual(await f.store.document(f.scene.id), before);
    await f.store.trashBook(f.book.id);
    await assert.rejects(
      () => f.store.updateBookDetails(f.book.id, { title: "No" }),
      StudioError,
    );
  } finally {
    await f.pg.close();
  }
});
