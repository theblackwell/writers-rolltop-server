// SPDX-License-Identifier: AGPL-3.0-only
import { unlinkFacts } from "./facts.ts";
import { basename } from "node:path";
import { captureBook, writeBookBackup } from "./backup.ts";
import { visibleEntries } from "./scopes.ts";
import { StudioError } from "./store.ts";
import type { StudioStore } from "./store.ts";
const invalid = (message: string): never => {
  throw new StudioError(400, "INVALID_INPUT", message);
};
const stamp = (data: any) =>
  new Date(Math.max(Date.now(), Date.parse(data.updatedAt) + 1)).toISOString();

/** Clear only declared entry links. Unknown keys and non-reference field values survive. */
function withoutLinks(values: any, fields: any[], id: string) {
  if (!values) return values;
  const next = { ...values };
  for (const field of fields) {
    const value = next[field.id];
    if (field.fieldType === "entryReference" && value === id)
      delete next[field.id];
    if (
      field.fieldType === "entryReferences" &&
      Array.isArray(value) &&
      value.includes(id)
    ) {
      const kept = value.filter((v: unknown) => v !== id);
      if (kept.length) next[field.id] = kept;
      else delete next[field.id];
    }
  }
  return next;
}
function unlinkEntry(data: any, fields: any[], id: string) {
  const next = { ...data };
  if (data.values) next.values = withoutLinks(data.values, fields, id);
  if (data.overrides)
    next.overrides = data.overrides.flatMap((o: any) => {
      const values = withoutLinks(o.values, fields, id);
      if (JSON.stringify(values) === JSON.stringify(o.values)) return [o];
      if (
        !Object.keys(values ?? {}).length &&
        !Object.keys(o).some((k) => !["bookId", "values"].includes(k))
      )
        return [];
      return [{ ...o, values }];
    });
  return next;
}

export async function purgeEntry(
  store: StudioStore,
  bookId: string,
  id: string,
  input: any,
) {
  const allowed = [
    "confirmName",
    "expectedDeletedAt",
    "expectedUpdatedAt",
    "editSharedCanon",
  ];
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((k) => !allowed.includes(k)) ||
    typeof input.confirmName !== "string" ||
    typeof input.expectedDeletedAt !== "string" ||
    typeof input.expectedUpdatedAt !== "string" ||
    (input.editSharedCanon !== undefined &&
      typeof input.editSharedCanon !== "boolean")
  )
    invalid("Confirm the entry name and the saved Trash version.");
  return store.db.transaction(async (q) => {
    const book = (
      await q("SELECT data,library_id FROM books WHERE id=$1 FOR UPDATE", [
        bookId,
      ])
    ).rows[0];
    if (!book)
      throw new StudioError(404, "NOT_FOUND", "That book no longer exists.");
    if (book.data.deletedAt)
      invalid("Restore the book before deleting its entries permanently.");
    if (!store.backupDirectory)
      throw new StudioError(
        503,
        "BACKUP_UNAVAILABLE",
        "Permanent deletion needs configured recovery backup storage. Nothing was deleted.",
      );
    // Do not take library before the non-waiting book sweep: all content writers
    // use book→library and a waiting sweep after library would deadlock.
    let snapshot;
    try {
      snapshot = await captureBook(q, bookId);
    } catch {
      throw new StudioError(
        503,
        "BACKUP_FAILED",
        "The library recovery snapshot could not be captured. Nothing was deleted. Finish other library edits and try again.",
      );
    }
    const entry = (await visibleEntries(q, bookId)).find((e) => e.id === id);
    if (!entry)
      throw new StudioError(
        404,
        "NOT_FOUND",
        "That entry is no longer visible in this book.",
      );
    if (!entry.deletedAt)
      invalid("Move this entry to Trash before deleting it permanently.");
    if (entry.scope.kind !== "book" && input.editSharedCanon !== true)
      invalid(
        "Confirm deleting this shared entry for every book in its scope.",
      );
    if (
      input.confirmName !== entry.name ||
      input.expectedDeletedAt !== entry.deletedAt ||
      input.expectedUpdatedAt !== entry.updatedAt
    )
      throw new StudioError(
        409,
        "STALE_DELETE",
        "This entry changed. Your confirmation is kept. Close and reopen Bible Entries to review Trash again.",
      );
    const fields = (
      await q(
        "SELECT data,library_id FROM bible_fields WHERE data->>'fieldType' IN ('entryReference','entryReferences')",
      )
    ).rows;
    // Foreign JSON links can exist in imported/older data. Never alter data that
    // is outside this recovery snapshot, even when it is already in Trash.
    const rows = (
      await q("SELECT id,library_id,data FROM bible_entries WHERE id<>$1", [id])
    ).rows;
    const updates: { id: string; data: any }[] = [];
    for (const row of rows) {
      const next = unlinkEntry(
        row.data,
        fields
          .filter((f) => f.library_id === row.library_id)
          .map((f) => f.data),
        id,
      );
      if (JSON.stringify(next) === JSON.stringify(row.data)) continue;
      if (row.library_id !== book.library_id)
        invalid(
          "This entry has incoming links from another library. Resolve them before permanent deletion.",
        );
      next.updatedAt = stamp(row.data);
      updates.push({ id: row.id, data: next });
    }
    const nodes = (
      await q(
        "SELECT n.id,n.data,b.library_id FROM manuscript_nodes n JOIN books b ON b.id=n.book_id WHERE n.data->>'povEntryId'=$1 OR n.data->>'settingEntryId'=$1",
        [id],
      )
    ).rows;
    const externalPassages = (
      await q(
        "SELECT r.id FROM manuscript_references r JOIN manuscript_nodes n ON n.id=r.node_id JOIN books b ON b.id=n.book_id WHERE r.entry_id=$1 AND b.library_id<>$2 LIMIT 1",
        [id, book.library_id],
      )
    ).rows;
    if (
      externalPassages.length ||
      nodes.some((n) => n.library_id !== book.library_id)
    )
      invalid(
        "This entry has incoming manuscript links from another library. Resolve them before permanent deletion.",
      );
    let path: string;
    try {
      path = await writeBookBackup(store.backupDirectory, snapshot);
    } catch {
      throw new StudioError(
        503,
        "BACKUP_FAILED",
        "The recovery backup could not be verified. Nothing was deleted. Check backup storage and try again.",
      );
    }
    await unlinkFacts(q, book.library_id, [id], []);
    for (const row of updates)
      await q("UPDATE bible_entries SET data=$2 WHERE id=$1", [
        row.id,
        row.data,
      ]);
    for (const row of nodes) {
      const next = { ...row.data, updatedAt: stamp(row.data) };
      if (next.povEntryId === id) delete next.povEntryId;
      if (next.settingEntryId === id) delete next.settingEntryId;
      await q("UPDATE manuscript_nodes SET data=$2 WHERE id=$1", [
        row.id,
        next,
      ]);
    }
    await q("DELETE FROM manuscript_references WHERE entry_id=$1", [id]);
    await q(
      "DELETE FROM relationships WHERE from_entry_id=$1 OR to_entry_id=$1",
      [id],
    );
    await q("DELETE FROM bible_entries WHERE id=$1", [id]);
    return { deletedEntryId: id, backup: basename(path) };
  });
}
