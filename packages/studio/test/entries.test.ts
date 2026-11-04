// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./support.ts";
import { entryTypes } from "../src/entries.ts";
import { captureBook } from "../src/backup.ts";
import { studioServer } from "../src/http.ts";
import { passwordHash } from "../src/auth.ts";
test("entry details persist for all types, preserve unknown/custom data and detect stale edits", async () => {
  const f = await fixture();
  try {
    const before = await f.store.document(f.scene.id);
    for (const entryType of entryTypes) {
      const entry = await f.store.createEntry(f.book.id, {
        name: "Original",
        entryType,
      });
      // Future/custom content is deliberately opaque to this header editor.
      const opaque = {
        templateId: crypto.randomUUID(),
        values: { futureField: { keep: true } },
        overrides: [{ future: true }],
        attachments: ["future-attachment"],
        future: { nested: [1, 2] },
      };
      await f.store.db.query(
        "UPDATE bible_entries SET data=data || $2::jsonb WHERE id=$1",
        [entry.id, JSON.stringify(opaque)],
      );
      const patch = {
        name: " Edited ",
        aliases: [" One ", "", "雨"],
        summary: "Line one\nLine two",
        toBeNamed: true,
        expectedUpdatedAt: entry.updatedAt,
      };
      const saved = await f.store.updateEntry(f.book.id, entry.id, patch);
      assert.equal(saved.name, "Edited");
      assert.deepEqual(saved.aliases, ["One", "雨"]);
      assert.equal(saved.toBeNamed, true);
      assert.ok(saved.updatedAt > entry.updatedAt);
      assert.equal(saved.createdAt, entry.createdAt);
      for (const [key, value] of Object.entries(opaque))
        assert.deepEqual(saved[key], value);
      await assert.rejects(
        () => f.store.updateEntry(f.book.id, entry.id, patch),
        /changed/,
      );
      const cleared = await f.store.updateEntry(f.book.id, entry.id, {
        summary: "",
        toBeNamed: false,
        aliases: [],
        expectedUpdatedAt: saved.updatedAt,
      });
      assert.equal(cleared.summary, undefined);
      assert.equal(cleared.toBeNamed, undefined);
      assert.deepEqual(cleared.aliases, []);
      const invalids = [
        { entryType: "term" },
        { scope: { kind: "book", id: f.book.id } },
        { name: " " },
        { summary: "x".repeat(20001) },
        { summary: null },
        { aliases: "bad" },
        { aliases: [4] },
        { aliases: Array(101).fill("a") },
        { toBeNamed: "true" },
        { deleted: true, name: "mixed" },
        ...(entryType !== "character"
          ? [{ givenName: "No" }]
          : [{ givenName: "", familyName: "" }]),
      ];
      for (const input of invalids)
        await assert.rejects(() =>
          f.store.updateEntry(f.book.id, entry.id, {
            ...input,
            expectedUpdatedAt: cleared.updatedAt,
          }),
        );
      assert.deepEqual(
        (await f.store.entries(f.book.id)).find((e) => e.id === entry.id),
        cleared,
      );
    }
    const character = await f.store.createEntry(f.book.id, {
      name: "Placeholder",
      entryType: "character",
      givenName: " Corin ",
      familyName: " Vale ",
      toBeNamed: true,
    });
    assert.equal(character.name, "Corin Vale");
    const renamed = await f.store.updateEntry(f.book.id, character.id, {
      givenName: null,
      familyName: " Vale ",
      expectedUpdatedAt: character.updatedAt,
    });
    assert.equal(renamed.name, "Vale");
    assert.equal(renamed.givenName, undefined);
    const other = await f.store.createBook(f.library.id, "Other");
    await assert.rejects(
      () =>
        f.store.updateEntry(other.id, character.id, {
          name: "No",
          expectedUpdatedAt: renamed.updatedAt,
        }),
      /no longer exists/,
    );
    await f.store.trashBook(f.book.id);
    await assert.rejects(
      () =>
        f.store.updateEntry(f.book.id, character.id, {
          name: "No",
          expectedUpdatedAt: renamed.updatedAt,
        }),
      /Restore the book/,
    );
    assert.deepEqual(await f.store.document(f.scene.id), before);
    const backup = await f.store.db.transaction((q) =>
      captureBook(q, f.book.id),
    );
    assert.deepEqual(
      backup.tables.bible_entries.find((e) => e.id === renamed.id).data,
      renamed,
    );
  } finally {
    await f.pg.close();
  }
});
test("entry Trash and restore retain references, anchors and revisions; dead targets refuse new links", async () => {
  const f = await fixture();
  try {
    const entry = await f.store.createEntry(f.book.id, {
      name: "Target",
      entryType: "term",
    });
    const doc = await f.store.document(f.scene.id);
    const anchorId = crypto.randomUUID();
    if (doc.document.blocks[0].type === "sceneBreak")
      throw Error("Expected paragraph");
    doc.document.blocks[0].content = [
      {
        type: "text",
        text: "A passage",
        marks: [{ type: "anchor", id: anchorId }],
      },
    ];
    const saved = await f.store.save(f.scene.id, doc.document, doc.revision);
    const ref = await f.store.saveReference(f.scene.id, {
      anchorId,
      entryId: entry.id,
      expectedRevision: saved.revision,
    });
    const trashed = await f.store.updateEntry(f.book.id, entry.id, {
      deleted: true,
      expectedUpdatedAt: entry.updatedAt,
    });
    assert.ok(trashed.deletedAt);
    await assert.rejects(
      () =>
        f.store.updateEntry(f.book.id, entry.id, {
          name: "No",
          expectedUpdatedAt: trashed.updatedAt,
        }),
      /Restore the entry/,
    );
    await assert.rejects(
      () =>
        f.store.saveReference(f.scene.id, {
          anchorId,
          entryId: entry.id,
          expectedRevision: saved.revision,
        }),
      /live bible/,
    );
    assert.deepEqual(await f.store.references(f.scene.id), [ref]);
    const restored = await f.store.updateEntry(f.book.id, entry.id, {
      deleted: false,
      expectedUpdatedAt: trashed.updatedAt,
    });
    assert.equal(restored.deletedAt, undefined);
    assert.deepEqual(await f.store.references(f.scene.id), [ref]);
    assert.equal((await f.store.revisions(f.scene.id)).length, 2);
    assert.deepEqual(
      (await f.store.document(f.scene.id)).document,
      doc.document,
    );
  } finally {
    await f.pg.close();
  }
});
test("entry update HTTP validates identifiers, authentication, origin, input and conflicts", async () => {
  const f = await fixture();
  const origin = "http://localhost:4317",
    password = "scratch-entry-password";
  const server = studioServer(f.store, {
    origin,
    passwordHash: await passwordHash(password),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  let cookie = "";
  const request = (
    path: string,
    data: any,
    method = "PUT",
    requestOrigin = origin,
  ) =>
    fetch(base + path, {
      method,
      headers: {
        Cookie: cookie,
        Origin: requestOrigin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });
  try {
    const entry = await f.store.createEntry(f.book.id, {
      name: "HTTP",
      entryType: "object",
    });
    const path = `/books/${f.book.id}/entries/${entry.id}`;
    const patch = { name: "HTTP edit", expectedUpdatedAt: entry.updatedAt };
    assert.equal((await request(path, patch)).status, 401);
    const login = await request("/login", { password }, "POST");
    cookie = login.headers.get("set-cookie")!.split(";")[0];
    assert.equal(
      (await request(path, patch, "PUT", "https://evil.example")).status,
      403,
    );
    assert.equal(
      (await request(`/books/${f.book.id}/entries/invalid`, patch)).status,
      400,
    );
    assert.equal((await request(path, { ...patch, values: {} })).status, 400);
    const response = await request(path, patch);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).name, "HTTP edit");
    assert.equal((await request(path, patch)).status, 409);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.pg.close();
  }
});
