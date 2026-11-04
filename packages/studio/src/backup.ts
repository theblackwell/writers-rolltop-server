// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomUUID } from "node:crypto";
import { open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { initializeTemplates } from "./templates.ts";
import type { Query } from "./store.ts";

// Explicit table order is also the foreign-key-safe restore order. No sessions.
export const backupTables = [
  "libraries",
  "bible_templates",
  "bible_fields",
  "books",
  "manuscript_nodes",
  "documents",
  "document_revisions",
  "notes",
  "bible_entries",
  "manuscript_references",
] as const;
export type BookBackup = {
  format: "writers-rolltop/book-recovery";
  version: 1 | 2;
  schemaVersion: 3 | 4;
  createdAt: string;
  bookId: string;
  tables: Record<string, any[]>;
};
const digest = (payload: string) =>
  createHash("sha256").update(payload).digest("hex");

/** Caller must hold the book row lock until the durable backup succeeds. */
export async function captureBook(
  q: Query,
  bookId: string,
): Promise<BookBackup> {
  const book = (await q("SELECT * FROM books WHERE id=$1 FOR UPDATE", [bookId]))
    .rows[0];
  if (!book) throw new Error("Book no longer exists.");
  const tables: Record<string, any[]> = {};
  tables.libraries = (
    await q("SELECT * FROM libraries WHERE id=$1 FOR UPDATE", [book.library_id])
  ).rows;
  for (const table of ["bible_templates", "bible_fields"])
    tables[table] = (
      await q(`SELECT * FROM ${table} WHERE library_id=$1`, [book.library_id])
    ).rows;
  tables.books = [book];
  tables.manuscript_nodes = (
    await q("SELECT * FROM manuscript_nodes WHERE book_id=$1", [bookId])
  ).rows;
  for (const table of [
    "documents",
    "document_revisions",
    "manuscript_references",
  ])
    tables[table] = (
      await q(
        `SELECT t.* FROM ${table} t JOIN manuscript_nodes n ON n.id=t.node_id WHERE n.book_id=$1`,
        [bookId],
      )
    ).rows;
  for (const table of ["notes", "bible_entries"])
    tables[table] = (
      await q(`SELECT * FROM ${table} WHERE book_id=$1`, [bookId])
    ).rows;
  return {
    format: "writers-rolltop/book-recovery",
    version: 2,
    schemaVersion: 4,
    createdAt: new Date().toISOString(),
    bookId,
    tables,
  };
}

export async function readBookBackup(path: string): Promise<BookBackup> {
  const envelope = JSON.parse(await readFile(path, "utf8"));
  if (
    typeof envelope.payload !== "string" ||
    digest(envelope.payload) !== envelope.sha256
  )
    throw new Error("Recovery backup checksum mismatch.");
  const data = JSON.parse(envelope.payload);
  validateBackup(data);
  return data;
}

function validateBackup(data: BookBackup) {
  const legacy = data?.version === 1 && data?.schemaVersion === 3;
  const current = data?.version === 2 && data?.schemaVersion === 4;
  const tables = legacy
    ? backupTables.filter(
        (t) => !["bible_templates", "bible_fields"].includes(t),
      )
    : backupTables;
  if (
    data?.format !== "writers-rolltop/book-recovery" ||
    (!legacy && !current) ||
    tables.some((t) => !Array.isArray(data.tables?.[t]))
  )
    throw new Error("Unsupported recovery backup.");
}

/** Resolves only after file + directory fsync and read-back verification. */
export async function writeBookBackup(directory: string, backup: BookBackup) {
  // Require pre-provisioned storage: syncing a new nested directory alone does
  // not make its parent directory entries durable. Missing mounts fail closed.
  const path = join(directory, `${randomUUID()}.book-recovery.json`);
  const payload = JSON.stringify(backup);
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify({ sha256: digest(payload), payload }));
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    const dir = await open(directory, "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
    const verified = await readBookBackup(path);
    if (JSON.stringify(verified) !== payload)
      throw new Error("Recovery backup verification failed.");
    return path;
  } catch (error) {
    await unlink(path).catch(() => {});
    throw error;
  }
}

/** Only for an empty, migrated scratch database, inside a transaction. */
export async function restoreBookBackup(q: Query, backup: BookBackup) {
  validateBackup(backup);
  await q(`LOCK TABLE ${backupTables.join(",")} IN EXCLUSIVE MODE`);
  for (const table of backupTables) {
    if ((await q(`SELECT 1 FROM ${table} LIMIT 1`)).rows.length)
      throw new Error("Recovery requires an empty scratch database.");
  }
  // Insert parents first even when SQL returned children in arbitrary order.
  const pending = [...backup.tables.manuscript_nodes];
  const nodes: any[] = [];
  while (pending.length) {
    const index = pending.findIndex(
      (n) => !n.parent_id || nodes.some((p) => p.id === n.parent_id),
    );
    if (index < 0) throw new Error("Invalid recovery hierarchy.");
    nodes.push(pending.splice(index, 1)[0]);
  }
  for (const table of backupTables) {
    for (const row of table === "manuscript_nodes"
      ? nodes
      : (backup.tables[table] ?? [])) {
      const columns = Object.keys(row);
      // Column names originate in a backup file: quote and escape identifiers.
      const names = columns.map((c) => '"' + c.replaceAll('"', '""') + '"');
      await q(
        `INSERT INTO ${table} (${names.join(",")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(",")})`,
        columns.map((c) => row[c]),
      );
    }
  }
  if (backup.version === 1)
    for (const library of backup.tables.libraries)
      await initializeTemplates(q, library.id);
}
