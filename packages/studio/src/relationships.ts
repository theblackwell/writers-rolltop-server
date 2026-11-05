// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { StudioError, title } from "./store.ts";
import type { Database, Query } from "./store.ts";
import { visibleEntries } from "./scopes.ts";
import { between } from "./order.ts";
const invalid = (message: string): never => {
  throw new StudioError(400, "INVALID_INPUT", message);
};
const found = (row: any) => {
  if (!row)
    throw new StudioError(
      404,
      "NOT_FOUND",
      "That item no longer exists or is not visible here.",
    );
  return row;
};
const stamp = (old?: string) =>
  new Date(Math.max(Date.now(), Date.parse(old ?? "") + 1 || 0)).toISOString();
function input(value: any, keys: string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    invalid("Provide only supported relationship details.");
}
function cas(data: any, expected: unknown) {
  if (typeof expected !== "string" || expected !== data.updatedAt)
    throw new StudioError(
      409,
      "RELATIONSHIP_CONFLICT",
      "This relationship or type changed. Your form is kept. Close and reopen Relationships to review it.",
    );
}
async function lockLibrary(q: Query, id: string) {
  found(
    (await q("SELECT id FROM libraries WHERE id=$1 FOR UPDATE", [id])).rows[0],
  );
}
async function context(q: Query, id: string) {
  const row = found(
    (await q("SELECT data,library_id FROM books WHERE id=$1 FOR UPDATE", [id]))
      .rows[0],
  );
  await lockLibrary(q, row.library_id);
  return row;
}
export async function migrateRelationships(q: Query) {
  await q(`ALTER TABLE bible_entries ADD CONSTRAINT entries_library_identity UNIQUE(id,library_id);
 CREATE TABLE relationship_types(id uuid PRIMARY KEY,library_id uuid NOT NULL REFERENCES libraries(id),data jsonb NOT NULL,UNIQUE(id,library_id),
 CHECK ((data ?& ARRAY['id','label','inverseLabel','orderKey','createdAt','updatedAt'] AND (data->>'id')::uuid=id AND length(data->>'label')>0 AND length(data->>'inverseLabel')>0) IS TRUE));
 CREATE TABLE relationships(id uuid PRIMARY KEY,library_id uuid NOT NULL REFERENCES libraries(id),data jsonb NOT NULL,
 type_id uuid GENERATED ALWAYS AS ((data->>'typeId')::uuid) STORED,
 from_entry_id uuid GENERATED ALWAYS AS ((data->>'fromEntryId')::uuid) STORED,
 to_entry_id uuid GENERATED ALWAYS AS ((data->>'toEntryId')::uuid) STORED,
 book_id uuid GENERATED ALWAYS AS ((data->>'bookId')::uuid) STORED,
 FOREIGN KEY(type_id,library_id) REFERENCES relationship_types(id,library_id),
 FOREIGN KEY(from_entry_id,library_id) REFERENCES bible_entries(id,library_id),
 FOREIGN KEY(to_entry_id,library_id) REFERENCES bible_entries(id,library_id),
 FOREIGN KEY(book_id,library_id) REFERENCES books(id,library_id),
 CHECK ((data ?& ARRAY['id','typeId','fromEntryId','toEntryId','createdAt','updatedAt'] AND (data->>'id')::uuid=id AND type_id IS NOT NULL AND from_entry_id IS NOT NULL AND to_entry_id IS NOT NULL AND from_entry_id<>to_entry_id AND (NOT (data ? 'bookId') OR book_id IS NOT NULL)) IS TRUE));
 CREATE INDEX relationship_types_by_library ON relationship_types(library_id);
 CREATE INDEX relationships_by_library ON relationships(library_id);
 CREATE INDEX relationships_by_book ON relationships(book_id);
 CREATE INDEX relationships_from ON relationships(from_entry_id);
 CREATE INDEX relationships_to ON relationships(to_entry_id);
 UPDATE studio_schema SET version=7`);
}
export async function relationshipCatalog(db: Database, bookId: string) {
  return db.transaction(async (q) => {
    const ctx = await context(q, bookId),
      entries = await visibleEntries(q, bookId),
      visible = new Set(entries.map((e) => e.id));
    const relationshipTypes = (
      await q(
        `SELECT data FROM relationship_types WHERE library_id=$1 ORDER BY (data->>'orderKey') COLLATE "C",id`,
        [ctx.library_id],
      )
    ).rows.map((r) => r.data);
    const relationships = (
      await q(
        "SELECT data FROM relationships WHERE library_id=$1 ORDER BY data->>'createdAt',id",
        [ctx.library_id],
      )
    ).rows
      .map((r) => r.data)
      .filter(
        (r) =>
          r.bookId === bookId ||
          (!r.bookId && visible.has(r.fromEntryId) && visible.has(r.toEntryId)),
      );
    return { relationshipTypes, relationships };
  });
}
export async function editRelationshipType(
  db: Database,
  libraryId: string,
  value: any,
  id?: string,
) {
  input(
    value,
    id
      ? ["label", "inverseLabel", "deleted", "expectedUpdatedAt"]
      : ["label", "inverseLabel"],
  );
  if (
    Object.hasOwn(value, "deleted") &&
    (typeof value.deleted !== "boolean" ||
      Object.keys(value).some(
        (k) => !["deleted", "expectedUpdatedAt"].includes(k),
      ))
  )
    invalid("Choose type Trash/restore separately from labels.");
  return db.transaction(async (q) => {
    await lockLibrary(q, libraryId);
    let data: any;
    if (id) {
      data = {
        ...found(
          (
            await q(
              "SELECT data FROM relationship_types WHERE id=$1 AND library_id=$2",
              [id, libraryId],
            )
          ).rows[0],
        ).data,
      };
      cas(data, value.expectedUpdatedAt);
      if (data.deletedAt && value.deleted !== false)
        invalid("Restore the relationship type before editing it.");
      if (
        !["label", "inverseLabel", "deleted"].some((k) =>
          Object.hasOwn(value, k),
        )
      )
        invalid("Provide labels or a Trash/restore action.");
    } else {
      const now = stamp(),
        last = (
          await q(
            `SELECT data FROM relationship_types WHERE library_id=$1 ORDER BY (data->>'orderKey') COLLATE "C" DESC,id DESC LIMIT 1`,
            [libraryId],
          )
        ).rows[0]?.data.orderKey;
      data = {
        id: randomUUID(),
        label: title(value.label),
        inverseLabel: title(value.inverseLabel),
        orderKey: between(last),
        createdAt: now,
        updatedAt: now,
      };
    }
    for (const key of ["label", "inverseLabel"])
      if (Object.hasOwn(value, key)) data[key] = title(value[key]);
    if (value.deleted === true) {
      if (
        (
          await q(
            "SELECT id FROM relationships WHERE type_id=$1 AND NOT (data ? 'deletedAt') LIMIT 1",
            [id],
          )
        ).rows.length
      )
        invalid(
          "This type is used by live relationships. Move those relationships to Trash first.",
        );
      data.deletedAt = stamp(data.updatedAt);
    }
    if (value.deleted === false) delete data.deletedAt;
    if (id) {
      data.updatedAt = stamp(data.updatedAt);
      await q(
        "UPDATE relationship_types SET data=$3 WHERE id=$1 AND library_id=$2",
        [id, libraryId, data],
      );
    } else
      await q(
        "INSERT INTO relationship_types(id,library_id,data) VALUES($1,$2,$3)",
        [data.id, libraryId, data],
      );
    return data;
  });
}
export async function editRelationship(
  db: Database,
  bookId: string,
  value: any,
  id?: string,
) {
  input(
    value,
    id
      ? [
          "note",
          "deleted",
          "expectedUpdatedAt",
          "expectedTypeUpdatedAt",
          "editSharedCanon",
        ]
      : [
          "typeId",
          "fromEntryId",
          "toEntryId",
          "bookSpecific",
          "note",
          "expectedTypeUpdatedAt",
          "editSharedCanon",
        ],
  );
  if (
    value.editSharedCanon !== undefined &&
    typeof value.editSharedCanon !== "boolean"
  )
    invalid("Confirm shared relationships explicitly.");
  if (
    Object.hasOwn(value, "deleted") &&
    (typeof value.deleted !== "boolean" || Object.hasOwn(value, "note"))
  )
    invalid("Choose relationship Trash/restore separately from its note.");
  if (
    Object.hasOwn(value, "note") &&
    (typeof value.note !== "string" || value.note.length > 20000)
  )
    invalid("Use a relationship note of at most 20,000 characters.");
  return db.transaction(async (q) => {
    const ctx = await context(q, bookId);
    if (ctx.data.deletedAt)
      invalid("Restore the book before editing relationships.");
    const visible = await visibleEntries(q, bookId),
      ids = new Set(visible.map((e) => e.id));
    let data: any;
    if (id) {
      data = {
        ...found(
          (
            await q(
              "SELECT data FROM relationships WHERE id=$1 AND library_id=$2",
              [id, ctx.library_id],
            )
          ).rows[0],
        ).data,
      };
      if (
        data.bookId
          ? data.bookId !== bookId
          : !ids.has(data.fromEntryId) || !ids.has(data.toEntryId)
      )
        found(null);
      cas(data, value.expectedUpdatedAt);
      if (data.deletedAt && value.deleted !== false)
        invalid("Restore the relationship before editing its note.");
      if (!Object.hasOwn(value, "deleted") && !Object.hasOwn(value, "note"))
        invalid("Provide a note or Trash/restore action.");
    } else {
      if (typeof value.bookSpecific !== "boolean")
        invalid("Choose whether this relationship applies only to this book.");
      if (
        [value.typeId, value.fromEntryId, value.toEntryId].some(
          (v) => typeof v !== "string" || !v,
        )
      )
        invalid("Choose a type and two entries.");
      const now = stamp();
      data = {
        id: randomUUID(),
        typeId: value.typeId,
        fromEntryId: value.fromEntryId,
        toEntryId: value.toEntryId,
        createdAt: now,
        updatedAt: now,
        ...(value.bookSpecific ? { bookId } : {}),
      };
    }
    if (!data.bookId && value.editSharedCanon !== true)
      invalid(
        "Confirm a shared relationship affecting every book that can see both entries.",
      );
    if (!id || value.deleted === false) {
      const type = (
        await q(
          "SELECT data FROM relationship_types WHERE id::text=$1 AND library_id=$2",
          [data.typeId, ctx.library_id],
        )
      ).rows[0]?.data;
      if (!type || type.deletedAt)
        invalid("Choose a live relationship type in this library.");
      if (value.expectedTypeUpdatedAt !== type.updatedAt)
        throw new StudioError(
          409,
          "RELATIONSHIP_CONFLICT",
          "This type changed. Your form is kept. Reopen Relationships before saving.",
        );
      const live = new Set(
        (await visibleEntries(q, bookId, true)).map((e) => e.id),
      );
      if (data.fromEntryId === data.toEntryId)
        invalid("An entry cannot relate to itself.");
      if (!live.has(data.fromEntryId) || !live.has(data.toEntryId))
        invalid("Choose two live visible entries in this book.");
      const duplicates = (
        await q(
          "SELECT id FROM relationships WHERE library_id=$1 AND type_id::text=$2 AND from_entry_id::text=$3 AND to_entry_id::text=$4 AND book_id IS NOT DISTINCT FROM $5::uuid AND NOT (data ? 'deletedAt')",
          [
            ctx.library_id,
            data.typeId,
            data.fromEntryId,
            data.toEntryId,
            data.bookId ?? null,
          ],
        )
      ).rows;
      if (duplicates.some((r) => r.id !== id))
        invalid("That directional relationship already exists in this scope.");
    }
    if (Object.hasOwn(value, "note")) {
      if (value.note) data.note = value.note;
      else delete data.note;
    }
    if (value.deleted === true) data.deletedAt = stamp(data.updatedAt);
    if (value.deleted === false) delete data.deletedAt;
    if (id) {
      data.updatedAt = stamp(data.updatedAt);
      await q(
        "UPDATE relationships SET data=$3 WHERE id=$1 AND library_id=$2",
        [id, ctx.library_id, data],
      );
    } else
      await q(
        "INSERT INTO relationships(id,library_id,data) VALUES($1,$2,$3)",
        [data.id, ctx.library_id, data],
      );
    return data;
  });
}
