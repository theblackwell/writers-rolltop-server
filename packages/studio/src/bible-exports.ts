// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";
import { StudioError } from "./store.ts";
import type { Database } from "./store.ts";
import { readContinuitySnapshot } from "./continuity.ts";
import { buildBible, nextBibleVersion } from "./bible-content.ts";
import { renderBible } from "./bible-render.ts";
const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const metadata = (data: any) => {
  const { contentBase64, ...rest } = data;
  return rest;
};
export async function bibleExports(db: Database, bookId: string) {
  return db.transaction(async (q) => {
    const book = (
      await q("SELECT data FROM books WHERE id=$1 FOR SHARE", [bookId])
    ).rows[0]?.data;
    if (!book)
      throw new StudioError(404, "NOT_FOUND", "Book no longer exists.");
    const rows = (
      await q(
        "SELECT data - 'contentBase64' AS data FROM bible_exports WHERE book_id=$1 ORDER BY data->>'createdAt' DESC,id DESC LIMIT 1001",
        [bookId],
      )
    ).rows;
    if (rows.length > 1000)
      throw new StudioError(
        413,
        "CATALOG_TOO_LARGE",
        "This book has too many saved exports for this view. No files were omitted.",
      );
    return {
      book,
      nextVersion: nextBibleVersion(book.bibleVersion),
      exports: rows.map((r) => r.data),
    };
  });
}
export async function createBibleExport(
  db: Database,
  bookId: string,
  input: any,
) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (k) => !["id", "version", "format", "expectedUpdatedAt"].includes(k),
    ) ||
    !uuid.test(input.id) ||
    !["docx", "pdf"].includes(input.format) ||
    typeof input.version !== "string" ||
    !input.version.trim() ||
    [...input.version.trim()].length > 32 ||
    typeof input.expectedUpdatedAt !== "string"
  )
    throw new StudioError(
      400,
      "INVALID_INPUT",
      "Provide a format, a version of 1–32 characters, a request ID and the saved book version.",
    );
  return db.transaction(async (q) => {
    const s: any = await readContinuitySnapshot(q, bookId, false, false);
    const previous = (
      await q("SELECT data FROM bible_exports WHERE id=$1", [input.id])
    ).rows[0]?.data;
    if (previous) {
      if (
        previous.bookId !== bookId ||
        previous.version !== input.version.trim() ||
        previous.format !== input.format
      )
        throw new StudioError(
          409,
          "EXPORT_CONFLICT",
          "This request ID already names a different export.",
        );
      return { export: metadata(previous), book: s.book };
    }
    if (
      (
        await q("SELECT id FROM bible_exports WHERE book_id=$1 LIMIT 1000", [
          bookId,
        ])
      ).rows.length >= 1000
    )
      throw new StudioError(
        413,
        "CATALOG_TOO_LARGE",
        "This book has reached the saved-export limit. Existing versions remain available.",
      );
    if (s.book.updatedAt !== input.expectedUpdatedAt)
      throw new StudioError(
        409,
        "EXPORT_CONFLICT",
        "This book changed. Your version label is kept. Check the saved versions before exporting again.",
      );
    // Shared record writers use the library lock; local prose/notes use this book lock.
    for (const table of ["relationship_types", "relationships"]) {
      const rows = (
        await q(
          `SELECT data FROM ${table} WHERE library_id=(SELECT library_id FROM books WHERE id=$1) LIMIT 10001`,
          [bookId],
        )
      ).rows;
      if (rows.length > 10000)
        throw new StudioError(
          413,
          "CATALOG_TOO_LARGE",
          "This library is too large to export without omissions.",
        );
      s[table === "relationship_types" ? "relationshipTypes" : table] =
        rows.map((r) => r.data);
    }
    s.documents = (
      await q(
        "SELECT d.node_id,d.document FROM documents d JOIN manuscript_nodes n ON n.id=d.node_id WHERE n.book_id=$1 LIMIT 10001",
        [bookId],
      )
    ).rows;
    const notes = (
      await q("SELECT data FROM notes WHERE book_id=$1 LIMIT 10001", [bookId])
    ).rows;
    s.notes = notes.map((r) => r.data);
    if (s.documents.length > 10000 || notes.length > 10000)
      throw new StudioError(
        413,
        "CATALOG_TOO_LARGE",
        "This book is too large to export without omissions.",
      );
    const version = input.version.trim(),
      createdAt = new Date().toISOString(),
      blocks = buildBible(s, version, createdAt);
    if (
      blocks.length > 20000 ||
      JSON.stringify(blocks).length > 4 * 1024 * 1024
    )
      throw new StudioError(
        413,
        "EXPORT_TOO_LARGE",
        "This bible exceeds the export size limit. No saved files or records changed.",
      );
    const bytes = await renderBible(blocks, input.format);
    if (bytes.length > 32 * 1024 * 1024)
      throw new StudioError(
        413,
        "EXPORT_TOO_LARGE",
        "This export exceeds 32 MiB.",
      );
    const data = {
      id: input.id,
      bookId,
      version,
      format: input.format,
      createdAt,
      filename: `Bible-${version.replace(/[^A-Za-z0-9._-]/g, "_")}-${input.id}.${input.format}`,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
      contentBase64: bytes.toString("base64"),
    };
    await q(
      "INSERT INTO bible_exports(id,library_id,book_id,data) SELECT $1,library_id,id,$3 FROM books WHERE id=$2",
      [data.id, bookId, data],
    );
    const book = {
      ...s.book,
      bibleVersion: version,
      updatedAt: new Date(
        Math.max(Date.now(), Date.parse(s.book.updatedAt) + 1),
      ).toISOString(),
    };
    await q("UPDATE books SET data=$2 WHERE id=$1", [bookId, book]);
    return { export: metadata(data), book };
  });
}
export async function readBibleExport(
  db: Database,
  bookId: string,
  id: string,
) {
  const data = (
    await db.query(
      "SELECT data FROM bible_exports WHERE id=$1 AND book_id=$2",
      [id, bookId],
    )
  ).rows[0]?.data;
  if (!data)
    throw new StudioError(
      404,
      "NOT_FOUND",
      "Saved bible export no longer exists.",
    );
  const bytes = Buffer.from(data.contentBase64, "base64");
  if (
    createHash("sha256").update(bytes).digest("hex") !== data.sha256 ||
    bytes.length !== data.size
  )
    throw new StudioError(
      500,
      "EXPORT_CHECKSUM",
      "This saved export failed its checksum. Restore it from a verified backup.",
    );
  return { data: metadata(data), bytes };
}
