// SPDX-License-Identifier: AGPL-3.0-only
import { StudioError } from "./store.ts";
import type { Database } from "./store.ts";
import { hash } from "./archive-zip.ts";
import { inScope } from "./state-values.ts";
const invalid = (m: string): never => {
  throw new StudioError(400, "INVALID_INPUT", m);
};
export async function attachmentCatalog(db: Database, libraryId: string) {
  if (
    !(await db.query("SELECT id FROM libraries WHERE id=$1", [libraryId])).rows
      .length
  )
    throw new StudioError(404, "NOT_FOUND", "Library no longer exists.");
  const rows = (
    await db.query(
      "SELECT data FROM library_attachments WHERE library_id=$1 ORDER BY data->>'createdAt' DESC,sha256 LIMIT 10001",
      [libraryId],
    )
  ).rows;
  if (rows.length > 10000)
    throw new StudioError(
      413,
      "CATALOG_TOO_LARGE",
      "Attachment catalog exceeds 10,000 files. Nothing was omitted.",
    );
  return rows.map((r) => r.data);
}
export async function uploadAttachment(
  db: Database,
  libraryId: string,
  bytes: Buffer,
  originalName: string,
  mediaType: string,
) {
  if (bytes.length > 250 * 1024 * 1024)
    throw new StudioError(
      413,
      "TOO_LARGE",
      "Attachments are limited to 250 MiB.",
    );
  if (
    !originalName ||
    originalName.length > 1000 ||
    !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mediaType)
  )
    invalid("Provide a filename and media type.");
  const sha256 = hash(bytes),
    ext = originalName.split(".").at(-1)?.toLowerCase(),
    data = {
      sha256,
      mediaType,
      byteLength: bytes.length,
      originalName,
      ...(originalName.includes(".") && ext && /^[a-z0-9]{1,10}$/.test(ext)
        ? { extension: ext }
        : {}),
      createdAt: new Date().toISOString(),
    };
  return db.transaction(async (q) => {
    if (
      !(await q("SELECT id FROM libraries WHERE id=$1 FOR UPDATE", [libraryId]))
        .rows.length
    )
      throw new StudioError(404, "NOT_FOUND", "Library no longer exists.");
    const prior = (
      await q(
        "SELECT data FROM library_attachments WHERE library_id=$1 AND sha256=$2",
        [libraryId, sha256],
      )
    ).rows[0]?.data;
    if (prior) return prior;
    await q("INSERT INTO library_attachments VALUES($1,$2,$3,$4)", [
      libraryId,
      sha256,
      data,
      bytes.toString("base64"),
    ]);
    return data;
  });
}
export async function downloadAttachment(
  db: Database,
  libraryId: string,
  sha: string,
) {
  if (!/^[0-9a-f]{64}$/.test(sha)) invalid("Choose a valid attachment hash.");
  const row = (
    await db.query(
      "SELECT data,content_base64 FROM library_attachments WHERE library_id=$1 AND sha256=$2",
      [libraryId, sha],
    )
  ).rows[0];
  if (!row)
    throw new StudioError(
      404,
      "NOT_FOUND",
      "Attachment no longer exists in this library.",
    );
  const bytes = Buffer.from(row.content_base64, "base64");
  if (hash(bytes) !== sha || bytes.length !== row.data.byteLength)
    throw new StudioError(
      500,
      "ATTACHMENT_CHECKSUM",
      "Attachment checksum failed. Restore it from a verified backup.",
    );
  return { data: row.data, bytes };
}
export async function attachToRecord(
  db: Database,
  bookId: string,
  input: any,
  entryId?: string,
) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (k) =>
        !["sha256", "remove", "expectedUpdatedAt", "editSharedCanon"].includes(
          k,
        ),
    ) ||
    typeof input.expectedUpdatedAt !== "string" ||
    (input.sha256 !== null &&
      (typeof input.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(input.sha256))) ||
    (input.remove !== undefined && typeof input.remove !== "boolean") ||
    (input.editSharedCanon !== undefined &&
      typeof input.editSharedCanon !== "boolean")
  )
    invalid(
      "Provide an attachment, the saved record version and optional removal choice.",
    );
  return db.transaction(async (q) => {
    const b = (
      await q("SELECT data,library_id FROM books WHERE id=$1 FOR UPDATE", [
        bookId,
      ])
    ).rows[0];
    if (!b) throw new StudioError(404, "NOT_FOUND", "Book no longer exists.");
    await q("SELECT id FROM libraries WHERE id=$1 FOR UPDATE", [b.library_id]);
    if (b.data.deletedAt)
      invalid("Restore this book before editing attachments.");
    const owner = entryId
      ? (
          await q(
            "SELECT data FROM bible_entries WHERE id=$1 AND library_id=$2",
            [entryId, b.library_id],
          )
        ).rows[0]?.data
      : b.data;
    if (!owner || (entryId && !inScope(owner.scope, b.data)))
      throw new StudioError(404, "NOT_FOUND", "Record is not visible here.");
    if (owner.deletedAt) invalid("Restore the entry first.");
    if (owner.updatedAt !== input.expectedUpdatedAt)
      throw new StudioError(
        409,
        "ATTACHMENT_CONFLICT",
        "This record changed. Your attachment choice is kept; refresh before trying again.",
      );
    if (
      entryId &&
      owner.scope.kind !== "book" &&
      input.editSharedCanon !== true
    )
      invalid("Confirm changing attachments on shared canon.");
    if (
      input.sha256 &&
      !(
        await q(
          "SELECT sha256 FROM library_attachments WHERE library_id=$1 AND sha256=$2",
          [b.library_id, input.sha256],
        )
      ).rows.length
    )
      invalid("Choose an attachment in this library.");
    const next = {
      ...owner,
      updatedAt: new Date(
        Math.max(Date.now(), Date.parse(owner.updatedAt) + 1),
      ).toISOString(),
    };
    if (entryId) {
      if (!input.sha256) invalid("Choose an attachment to add or remove.");
      next.attachments = input.remove
        ? (owner.attachments ?? []).filter((h: string) => h !== input.sha256)
        : [...new Set([...(owner.attachments ?? []), input.sha256])];
    } else {
      if (input.sha256 && !input.remove) next.coverAttachment = input.sha256;
      else delete next.coverAttachment;
    }
    await q(
      `UPDATE ${entryId ? "bible_entries" : "books"} SET data=$2 WHERE id=$1`,
      [owner.id, next],
    );
    return next;
  });
}
