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
  "universes",
  "series",
  "books",
  "manuscript_nodes",
  "documents",
  "document_revisions",
  "notes",
  "relationship_types",
  "bible_entries",
  "relationships",
  "manuscript_references",
  "facts",
  "questions",
  "continuity_events",
  "state_changes",
  "bible_exports",
  "library_attachments",
  "library_portable",
] as const;
export type BookBackup = {
  format: "writers-rolltop/book-recovery";
  version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;
  schemaVersion: 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13;
  createdAt: string;
  bookId: string;
  tables: Record<string, any[]>;
};
const digest = (payload: string) =>
  createHash("sha256").update(payload).digest("hex");

/** Caller holds the target book lock. Other book locks never wait: contention fails closed. */
export async function captureBook(
  q: Query,
  bookId: string,
): Promise<BookBackup> {
  const book = (await q("SELECT * FROM books WHERE id=$1 FOR UPDATE", [bookId]))
    .rows[0];
  if (!book) throw new Error("Book no longer exists.");
  return captureLibrary(q, book.library_id, bookId);
}
/** Whole-library recovery also supports libraries without books, for portable replacement. */
export async function captureLibrary(
  q: Query,
  libraryId: string,
  receiptId = libraryId,
): Promise<BookBackup> {
  // Existing writers lock book before library. NOWAIT avoids a cycle with a
  // writer already holding another book while waiting for this library.
  await q(
    "SELECT id FROM books WHERE library_id=$1 ORDER BY id FOR UPDATE NOWAIT",
    [libraryId],
  );
  const tables: Record<string, any[]> = {};
  tables.libraries = (
    await q("SELECT * FROM libraries WHERE id=$1 FOR UPDATE", [libraryId])
  ).rows;
  // A book could have been created between the first sweep and library lock.
  tables.books = (
    await q(
      "SELECT * FROM books WHERE library_id=$1 ORDER BY id FOR UPDATE NOWAIT",
      [libraryId],
    )
  ).rows;
  for (const table of [
    "bible_templates",
    "bible_fields",
    "universes",
    "series",
    "bible_entries",
    "relationship_types",
    "relationships",
    "facts",
    "questions",
    "continuity_events",
    "state_changes",
    "bible_exports",
    "library_attachments",
    "library_portable",
  ])
    tables[table] = (
      await q(`SELECT * FROM ${table} WHERE library_id=$1`, [libraryId])
    ).rows;
  const bookIds = tables.books.map((b) => b.id);
  for (const table of ["manuscript_nodes", "notes"])
    tables[table] = (
      await q(`SELECT * FROM ${table} WHERE book_id=ANY($1::uuid[])`, [bookIds])
    ).rows;
  for (const table of [
    "documents",
    "document_revisions",
    "manuscript_references",
  ])
    tables[table] = (
      await q(
        `SELECT t.* FROM ${table} t JOIN manuscript_nodes n ON n.id=t.node_id WHERE n.book_id=ANY($1::uuid[])`,
        [bookIds],
      )
    ).rows;
  const entryIds = new Set(tables.bible_entries.map((e) => e.id));
  if (tables.manuscript_references.some((r) => !entryIds.has(r.entry_id)))
    throw new Error("Recovery cannot omit an externally referenced entry.");
  return {
    format: "writers-rolltop/book-recovery",
    version: 11,
    schemaVersion: 13,
    createdAt: new Date().toISOString(),
    bookId: receiptId,
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
  const prior = data?.version === 2 && data?.schemaVersion === 4;
  const previous = data?.version === 3 && data?.schemaVersion === 5;
  const beforeRelationships = data?.version === 4 && data?.schemaVersion === 6;
  const beforeFacts = data?.version === 5 && data?.schemaVersion === 7;
  const beforeQuestions = data?.version === 6 && data?.schemaVersion === 8;
  const beforeEvents = data?.version === 7 && data?.schemaVersion === 9;
  const beforeState = data?.version === 8 && data?.schemaVersion === 10;
  const current =
    (data?.version === 9 && data?.schemaVersion === 11) ||
    (data?.version === 10 && data?.schemaVersion === 12) ||
    (data?.version === 11 && data?.schemaVersion === 13);
  const compatibleTables = backupTables.filter(
    (t) =>
      (data?.version === 11 ||
        !["library_attachments", "library_portable"].includes(t)) &&
      (data?.version === 10 || data?.version === 11 || t !== "bible_exports") &&
      (current || t !== "state_changes") &&
      (current || beforeState || t !== "continuity_events") &&
      (current || beforeState || beforeEvents || t !== "questions") &&
      (current ||
        beforeState ||
        beforeEvents ||
        beforeQuestions ||
        t !== "facts") &&
      (current ||
        beforeState ||
        beforeEvents ||
        beforeFacts ||
        beforeQuestions ||
        !["relationship_types", "relationships"].includes(t)),
  );
  const tables = legacy
    ? compatibleTables.filter(
        (t) =>
          !["bible_templates", "bible_fields", "universes", "series"].includes(
            t,
          ),
      )
    : prior
      ? compatibleTables.filter((t) => !["universes", "series"].includes(t))
      : compatibleTables;
  if (
    data?.format !== "writers-rolltop/book-recovery" ||
    (!legacy &&
      !prior &&
      !previous &&
      !beforeRelationships &&
      !beforeFacts &&
      !beforeQuestions &&
      !beforeEvents &&
      !beforeState &&
      !current) ||
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
  await insertRecoveryRows(q, backup);
}
/** Internal validated library installation; caller owns all required locks and rollback. */
export async function insertRecoveryRows(q: Query, backup: BookBackup) {
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
    for (const sourceRow of table === "manuscript_nodes"
      ? nodes
      : (backup.tables[table] ?? [])) {
      // Older files used a creator book for every entry. Infer library ownership
      // before adopting a preserved canonical world/series scope, as migration does.
      const row =
        table === "bible_entries" && backup.version < 4
          ? {
              ...sourceRow,
              library_id:
                sourceRow.library_id ??
                backup.tables.books.find((b) => b.id === sourceRow.book_id)
                  ?.library_id,
            }
          : sourceRow;
      if (
        table === "bible_entries" &&
        backup.version < 4 &&
        ["universe", "series"].includes(row.data?.scope?.kind)
      )
        row.book_id = null;
      const columns = Object.keys(row).filter(
        (c) =>
          !(
            (table === "books" && ["universe_id", "series_id"].includes(c)) ||
            (table === "series" && c === "universe_id") ||
            (table === "bible_entries" &&
              ["universe_id", "series_id"].includes(c)) ||
            (["facts", "questions", "continuity_events"].includes(table) &&
              ["book_id", "universe_id", "series_id"].includes(c)) ||
            (table === "state_changes" &&
              ["entry_id", "field_id", "event_id", "node_id"].includes(c)) ||
            (table === "relationships" &&
              ["type_id", "from_entry_id", "to_entry_id", "book_id"].includes(
                c,
              ))
          ),
      );
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
