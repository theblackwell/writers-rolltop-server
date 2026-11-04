// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture } from "./support.ts";
import {
  backupTables,
  captureBook,
  writeBookBackup,
  readBookBackup,
  restoreBookBackup,
} from "../src/backup.ts";

test("durable book backup restores all stored rows and refuses corruption/nonempty targets", async () => {
  const f = await fixture();
  const target = await fixture();
  const directory = await mkdtemp(join(tmpdir(), "rolltop-backup-"));
  try {
    await f.store.saveNote(f.book.id, {
      text: "Keep this",
      nodeId: f.scene.id,
    });
    const entry = await f.store.createEntry(f.book.id, {
      name: "Character",
      entryType: "character",
    });
    await f.store.db.query(
      "INSERT INTO manuscript_references(id,node_id,entry_id,data) VALUES($1,$2,$3,$4)",
      [
        crypto.randomUUID(),
        f.scene.id,
        entry.id,
        { future: "preserved reference" },
      ],
    );
    const doc = await f.store.document(f.scene.id);
    await f.store.save(f.scene.id, doc.document, doc.revision);
    await f.store.db.query(
      "UPDATE books SET data=data || $2::jsonb WHERE id=$1",
      [f.book.id, JSON.stringify({ future: { keep: true } })],
    );
    await f.store.trashNode(f.chapter.id);
    const snapshot = await f.store.db.transaction((q) =>
      captureBook(q, f.book.id),
    );
    const path = await writeBookBackup(directory, snapshot);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const backup = await readBookBackup(path);
    await assert.rejects(
      () => target.store.db.transaction((q) => restoreBookBackup(q, backup)),
      /empty scratch/,
    );
    await target.store.db.transaction(async (q) => {
      for (const table of [...backupTables].reverse())
        await q(`DELETE FROM ${table}`);
    });
    await target.store.db.transaction((q) => restoreBookBackup(q, backup));
    const restored = await target.store.db.transaction((q) =>
      captureBook(q, f.book.id),
    );
    for (const table of backupTables)
      assert.deepEqual(
        JSON.parse(JSON.stringify(restored.tables[table])).sort(
          (a: any, b: any) =>
            JSON.stringify(a).localeCompare(JSON.stringify(b)),
        ),
        backup.tables[table].sort((a: any, b: any) =>
          JSON.stringify(a).localeCompare(JSON.stringify(b)),
        ),
      );
    await writeFile(path, JSON.stringify({ payload: "{}", sha256: "invalid" }));
    await assert.rejects(() => readBookBackup(path), /checksum/);
    const blocked = join(directory, "file");
    await writeFile(blocked, "blocked");
    await assert.rejects(() => writeBookBackup(blocked, snapshot));
  } finally {
    await f.pg.close();
    await target.pg.close();
    await rm(directory, { recursive: true, force: true });
  }
});
