// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture } from "./support.ts";
import { StudioStore } from "../src/store.ts";
import { saveStateChange, stateCatalog } from "../src/state-changes.ts";
import { saveEvent } from "../src/events.ts";
import { editWorld, bookMembership } from "../src/worlds.ts";
import { editDefinition } from "../src/template-editor.ts";
import {
  captureBook,
  restoreBookBackup,
  backupTables,
  readBookBackup,
} from "../src/backup.ts";
import { purgeEntry } from "../src/entry-purge.ts";
async function prepared(f: any, shared = false) {
  if (shared) {
    const w = await editWorld(f.store.db, f.library.id, "universes", {
      title: "World",
    });
    await bookMembership(f.store.db, f.book.id, {
      universeId: w.id,
      expectedUpdatedAt: f.book.updatedAt,
    });
  }
  let entry = await f.store.createEntry(f.book.id, {
    name: "Keeper",
    entryType: "character",
    ...(shared ? { scopeKind: "universe" } : {}),
  });
  const catalog = await f.store.templates(f.library.id),
    template = catalog.templates.find((t: any) => t.entryType === "character");
  entry = await f.store.editEntryField(f.book.id, entry.id, {
    templateId: template.id,
    expectedUpdatedAt: entry.updatedAt,
    expectedTemplateUpdatedAt: template.updatedAt,
    ...(shared ? { editSharedCanon: true } : {}),
  });
  return {
    entry,
    field: catalog.fields.find(
      (f: any) => f.templateId === template.id && f.fieldType === "integer",
    ),
    template,
  };
}
test("state schema migration is atomic and repeatable with prior all-table data intact", async () => {
  const f = await fixture();
  try {
    const before = await f.store.db.transaction((q) =>
      captureBook(q, f.book.id),
    );
    await f.store.db.query(
      "DROP TABLE library_portable; DROP TABLE library_attachments; DROP TABLE bible_exports; DROP TABLE state_changes; ALTER TABLE bible_fields DROP CONSTRAINT state_fields_library_identity; ALTER TABLE continuity_events DROP CONSTRAINT state_events_library_identity; UPDATE studio_schema SET version=10",
    );
    const broken = new StudioStore({
      ...f.store.db,
      transaction: (fn) =>
        f.store.db.transaction((q) =>
          fn(async (sql, p) => {
            const r = await q(sql, p);
            if (sql.includes("CREATE TABLE state_changes"))
              throw Error("injected after DDL");
            return r;
          }),
        ),
    });
    await assert.rejects(() => broken.migrate(), /injected/);
    assert.equal(
      (await f.store.db.query("SELECT version FROM studio_schema")).rows[0]
        .version,
      10,
    );
    assert.equal(
      (await f.store.db.query("SELECT to_regclass('state_changes') AS name"))
        .rows[0].name,
      null,
    );
    await f.store.migrate();
    await f.store.migrate();
    assert.deepEqual(
      (await f.store.db.transaction((q) => captureBook(q, f.book.id))).tables,
      before.tables,
    );
  } finally {
    await f.pg.close();
  }
});
test("canonical state changes validate typed values/placement/definitions, CAS/shared intent, Trash and opaque preservation", async () => {
  const f = await fixture();
  try {
    const { entry, field } = await prepared(f, true),
      event = await saveEvent(f.store.db, f.book.id, {
        title: "Storm",
        scopeKind: "universe",
        sceneIds: [f.scene.id],
      });
    const input = {
      entryId: entry.id,
      fieldId: field.id,
      value: 0,
      nodeId: f.scene.id,
      expectedEntryUpdatedAt: entry.updatedAt,
      expectedFieldUpdatedAt: field.updatedAt,
      editSharedCanon: true,
    };
    const original = await f.store.document(f.scene.id);
    for (const patch of [
      { editSharedCanon: false },
      { value: null },
      { value: 1.5 },
      { eventId: event.id },
      { nodeId: f.book.id },
      { expectedFieldUpdatedAt: "stale" },
      { unknown: true },
    ])
      await assert.rejects(() =>
        saveStateChange(f.store.db, f.book.id, { ...input, ...patch }),
      );
    let c = await saveStateChange(f.store.db, f.book.id, {
      ...input,
      note: "",
    });
    await f.store.db.query(
      "UPDATE state_changes SET data=data || $2::jsonb WHERE id=$1",
      [c.id, { opaque: { kept: true } }],
    );
    await assert.rejects(
      () =>
        saveStateChange(
          f.store.db,
          f.book.id,
          { ...input, value: 7, expectedUpdatedAt: "old" },
          c.id,
        ),
      /changed/,
    );
    c = await saveStateChange(
      f.store.db,
      f.book.id,
      {
        ...input,
        nodeId: null,
        eventId: event.id,
        note: null,
        expectedUpdatedAt: c.updatedAt,
      },
      c.id,
    );
    assert.equal(c.nodeId, undefined);
    assert.equal(c.note, undefined);
    assert.equal(c.value, 0);
    assert.deepEqual(c.opaque, { kept: true });
    const identity = { id: c.id, createdAt: c.createdAt };
    c = await saveStateChange(
      f.store.db,
      f.book.id,
      { deleted: true, expectedUpdatedAt: c.updatedAt, editSharedCanon: true },
      c.id,
    );
    await assert.rejects(
      () =>
        saveStateChange(
          f.store.db,
          f.book.id,
          { ...input, expectedUpdatedAt: c.updatedAt },
          c.id,
        ),
      /Restore/,
    );
    c = await saveStateChange(
      f.store.db,
      f.book.id,
      { deleted: false, expectedUpdatedAt: c.updatedAt, editSharedCanon: true },
      c.id,
    );
    assert.equal(c.deletedAt, undefined);
    assert.equal(c.createdAt, identity.createdAt);
    const companion = await f.store.createBook(f.library.id, "Companion");
    await bookMembership(f.store.db, companion.id, {
      universeId: entry.scope.id,
      expectedUpdatedAt: companion.updatedAt,
    });
    const localEvent = await saveEvent(f.store.db, f.book.id, {
      title: "Earlier book event",
      sceneIds: [f.scene.id],
    });
    await saveStateChange(f.store.db, companion.id, {
      ...input,
      nodeId: null,
      eventId: localEvent.id,
    });
    const local = await f.store.createBook(f.library.id, "Unrelated");
    await assert.rejects(
      () =>
        saveStateChange(
          f.store.db,
          local.id,
          { ...input, expectedUpdatedAt: c.updatedAt },
          c.id,
        ),
      /visible/,
    );
    assert.deepEqual(await f.store.document(f.scene.id), original);
    const before = await f.store.db.transaction((q) =>
      captureBook(q, f.book.id),
    );
    await stateCatalog(f.store.db, f.book.id);
    assert.deepEqual(
      (await f.store.db.transaction((q) => captureBook(q, f.book.id))).tables,
      before.tables,
    );
  } finally {
    await f.pg.close();
  }
});
test("state history guards templates, option constraints and shared membership, and joins exact/legacy8 recovery", async () => {
  const f = await fixture(),
    target = await fixture();
  try {
    const { entry, field, template } = await prepared(f, true);
    let c = await saveStateChange(f.store.db, f.book.id, {
      entryId: entry.id,
      fieldId: field.id,
      value: 5,
      nodeId: f.scene.id,
      expectedEntryUpdatedAt: entry.updatedAt,
      expectedFieldUpdatedAt: field.updatedAt,
      editSharedCanon: true,
    });
    c = await saveStateChange(
      f.store.db,
      f.book.id,
      { deleted: true, expectedUpdatedAt: c.updatedAt, editSharedCanon: true },
      c.id,
    );
    await assert.rejects(
      () =>
        f.store.editEntryField(f.book.id, entry.id, {
          templateId: null,
          expectedUpdatedAt: entry.updatedAt,
          editSharedCanon: true,
        }),
      /state changes/,
    );
    const current = (
      await f.store.db.query("SELECT data FROM books WHERE id=$1", [f.book.id])
    ).rows[0].data;
    await assert.rejects(
      () =>
        bookMembership(f.store.db, f.book.id, {
          universeId: null,
          expectedUpdatedAt: current.updatedAt,
        }),
      /state changes/,
    );
    const selection = await editDefinition(f.store.db, f.library.id, "field", {
      templateId: template.id,
      label: "Mood",
      fieldType: "selection",
      options: [{ label: "Calm" }, { label: "Alarm" }],
    });
    await saveStateChange(f.store.db, f.book.id, {
      entryId: entry.id,
      fieldId: selection.id,
      value: [selection.options[0].id],
      nodeId: f.scene.id,
      expectedEntryUpdatedAt: entry.updatedAt,
      expectedFieldUpdatedAt: selection.updatedAt,
      editSharedCanon: true,
    });
    await assert.rejects(
      () =>
        editDefinition(
          f.store.db,
          f.library.id,
          "field",
          {
            options: [selection.options[1]],
            expectedUpdatedAt: selection.updatedAt,
          },
          selection.id,
        ),
      /state changes/,
    );
    const backup = await f.store.db.transaction((q) =>
      captureBook(q, f.book.id),
    );
    await target.store.db.transaction(async (q) => {
      for (const t of [...backupTables].reverse()) await q("DELETE FROM " + t);
      await restoreBookBackup(q, backup);
    });
    assert.deepEqual(
      (await target.store.db.transaction((q) => captureBook(q, f.book.id)))
        .tables,
      backup.tables,
    );
    const legacy = {
      ...backup,
      version: 8 as const,
      schemaVersion: 10 as const,
      tables: { ...backup.tables },
    };
    delete legacy.tables.state_changes;
    await target.store.db.transaction(async (q) => {
      for (const t of [...backupTables].reverse()) await q("DELETE FROM " + t);
      await restoreBookBackup(q, legacy);
    });
    assert.equal(
      (await target.store.db.query("SELECT * FROM state_changes")).rows.length,
      0,
    );
  } finally {
    await f.pg.close();
    await target.pg.close();
  }
});
test("verified deletion captures then cleans node/entry/event state history, while failures roll back", async () => {
  const f = await fixture(),
    dir = await mkdtemp(join(tmpdir(), "rolltop-state-purge-"));
  try {
    f.store.backupDirectory = dir;
    const { entry, field } = await prepared(f, true);
    const input = {
      entryId: entry.id,
      fieldId: field.id,
      value: 7,
      nodeId: f.scene.id,
      expectedEntryUpdatedAt: entry.updatedAt,
      expectedFieldUpdatedAt: field.updatedAt,
      editSharedCanon: true,
    };
    const c = await saveStateChange(f.store.db, f.book.id, input);
    await f.store.trashNode(f.scene.id);
    const scene = (
      await f.store.db.query("SELECT data FROM manuscript_nodes WHERE id=$1", [
        f.scene.id,
      ])
    ).rows[0].data;
    const before = await f.store.db.transaction((q) =>
      captureBook(q, f.book.id),
    );
    const broken = new StudioStore(
      {
        ...f.store.db,
        transaction: (fn) =>
          f.store.db.transaction((q) =>
            fn((sql, p) => {
              if (sql.startsWith("DELETE FROM manuscript_nodes"))
                throw Error("injected");
              return q(sql, p);
            }),
          ),
      },
      dir,
    );
    await assert.rejects(
      () =>
        broken.purge("node", scene.id, {
          confirmTitle: scene.title,
          expectedDeletedAt: scene.deletedAt,
        }),
      /injected/,
    );
    assert.deepEqual(
      (await f.store.db.transaction((q) => captureBook(q, f.book.id))).tables,
      before.tables,
    );
    const receipt = await f.store.purge("node", scene.id, {
      confirmTitle: scene.title,
      expectedDeletedAt: scene.deletedAt,
    });
    assert.ok(
      (
        await readBookBackup(join(dir, receipt.backup))
      ).tables.state_changes.some((r) => r.id === c.id),
    );
    assert.equal(
      (await f.store.db.query("SELECT * FROM state_changes")).rows.length,
      0,
    );
    const event = await saveEvent(f.store.db, f.book.id, {
      title: "Local event",
    });
    await saveStateChange(f.store.db, f.book.id, {
      ...input,
      nodeId: null,
      eventId: event.id,
    });
    await f.store.trashBook(f.book.id);
    const book = (
      await f.store.db.query("SELECT data FROM books WHERE id=$1", [f.book.id])
    ).rows[0].data;
    await f.store.purge("book", book.id, {
      confirmTitle: book.title,
      expectedDeletedAt: book.deletedAt,
    });
    assert.equal(
      (await f.store.db.query("SELECT * FROM state_changes")).rows.length,
      0,
    );
    assert.equal(
      (
        await f.store.db.query("SELECT * FROM bible_entries WHERE id=$1", [
          entry.id,
        ])
      ).rows.length,
      1,
    );
  } finally {
    await f.pg.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("all supported typed changes validate and reference-target purge preserves valid multi-values after verified backup", async () => {
  const f = await fixture(),
    dir = await mkdtemp(join(tmpdir(), "rolltop-state-values-"));
  try {
    f.store.backupDirectory = dir;
    const { entry, template } = await prepared(f, true);
    const target = await f.store.createEntry(f.book.id, {
      name: "Target",
      entryType: "character",
      scopeKind: "universe",
    });
    const cases: any[] = [
      ["shortText", "", 7],
      ["longText", "Notes", false],
      ["integer", 0, 1.5],
      ["decimal", "0.123456789123456789", "1e2"],
      ["boolean", false, 0],
      ["realDate", "2000-02-29", "2025-02-29"],
      ["fictionalDate", { label: "Day", ordinal: 0 }, { label: "" }],
      [
        "table",
        { columns: ["C"], rows: [["Value"]] },
        { columns: [], rows: [] },
      ],
      ["selection", [], ["unknown"]],
      ["entryReference", target.id, entry.id + "bad"],
      ["entryReferences", [target.id], [target.id, target.id]],
    ];
    for (const [fieldType, value, bad] of cases) {
      const field = await editDefinition(f.store.db, f.library.id, "field", {
        templateId: template.id,
        label: fieldType,
        fieldType,
        ...(fieldType === "selection" ? { options: [{ label: "One" }] } : {}),
        ...(["entryReference", "entryReferences"].includes(fieldType)
          ? { targetEntryTypes: ["character"] }
          : {}),
      });
      const args = {
        entryId: entry.id,
        fieldId: field.id,
        value,
        nodeId: f.scene.id,
        expectedEntryUpdatedAt: entry.updatedAt,
        expectedFieldUpdatedAt: field.updatedAt,
        editSharedCanon: true,
      };
      const c = await saveStateChange(f.store.db, f.book.id, args);
      assert.deepEqual(c.value, value);
      await assert.rejects(() =>
        saveStateChange(f.store.db, f.book.id, { ...args, value: bad }),
      );
    }
    const dead = await f.store.updateEntry(f.book.id, target.id, {
      deleted: true,
      expectedUpdatedAt: target.updatedAt,
      editSharedCanon: true,
    });
    const receipt = await purgeEntry(f.store, f.book.id, target.id, {
      confirmName: dead.name,
      expectedDeletedAt: dead.deletedAt,
      expectedUpdatedAt: dead.updatedAt,
      editSharedCanon: true,
    });
    const backed = await readBookBackup(join(dir, receipt.backup));
    assert.equal(backed.tables.state_changes.length, 11);
    const rows = (
      await f.store.db.query("SELECT data FROM state_changes")
    ).rows.map((r) => r.data);
    assert.equal(rows.length, 10);
    assert.ok(rows.some((c) => Array.isArray(c.value) && c.value.length === 0));
    const nodeDead = await f.store.updateEntry(f.book.id, entry.id, {
      deleted: true,
      expectedUpdatedAt: entry.updatedAt,
      editSharedCanon: true,
    });
    await purgeEntry(f.store, f.book.id, entry.id, {
      confirmName: nodeDead.name,
      expectedDeletedAt: nodeDead.deletedAt,
      expectedUpdatedAt: nodeDead.updatedAt,
      editSharedCanon: true,
    });
    assert.equal(
      (await f.store.db.query("SELECT * FROM state_changes")).rows.length,
      0,
    );
  } finally {
    await f.pg.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("uncaptured external state node dependencies refuse deletion without modifying either library", async () => {
  const f = await fixture(),
    dir = await mkdtemp(join(tmpdir(), "rolltop-state-external-"));
  try {
    f.store.backupDirectory = dir;
    const foreign = await f.store.createLibrary("Other"),
      book = await f.store.createBook(foreign.id, "Other");
    const catalog = await f.store.templates(foreign.id),
      template = catalog.templates.find((t) => t.entryType === "character")!;
    let entry = await f.store.createEntry(book.id, {
      name: "Other entry",
      entryType: "character",
    });
    entry = await f.store.editEntryField(book.id, entry.id, {
      templateId: template.id,
      expectedUpdatedAt: entry.updatedAt,
      expectedTemplateUpdatedAt: template.updatedAt,
    });
    const field = catalog.fields.find(
      (x) => x.templateId === template.id && x.fieldType === "integer",
    )!;
    const chapter = await f.store.createNode(
      book.id,
      "Other chapter",
      "chapter",
    );
    const c = await saveStateChange(f.store.db, book.id, {
      entryId: entry.id,
      fieldId: field.id,
      value: 1,
      nodeId: chapter.id,
      expectedEntryUpdatedAt: entry.updatedAt,
      expectedFieldUpdatedAt: field.updatedAt,
    });
    await f.store.db.query(
      "UPDATE state_changes SET data=jsonb_set(data,'{nodeId}',$2::jsonb) WHERE id=$1",
      [c.id, JSON.stringify(f.scene.id)],
    );
    await f.store.trashNode(f.scene.id);
    const scene = (
      await f.store.db.query("SELECT data FROM manuscript_nodes WHERE id=$1", [
        f.scene.id,
      ])
    ).rows[0].data;
    const before = await f.store.db.transaction((q) =>
      captureBook(q, f.book.id),
    );
    await assert.rejects(
      () =>
        f.store.purge("node", scene.id, {
          confirmTitle: scene.title,
          expectedDeletedAt: scene.deletedAt,
        }),
      /another library/,
    );
    assert.deepEqual(
      (await f.store.db.transaction((q) => captureBook(q, f.book.id))).tables,
      before.tables,
    );
    assert.equal(
      (
        await f.store.db.query("SELECT data FROM state_changes WHERE id=$1", [
          c.id,
        ])
      ).rows[0].data.nodeId,
      f.scene.id,
    );
  } finally {
    await f.pg.close();
    await rm(dir, { recursive: true, force: true });
  }
});
