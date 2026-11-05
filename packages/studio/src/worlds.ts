// SPDX-License-Identifier: AGPL-3.0-only
import { scopeAllowsTarget } from "./scope-values.ts";
import { randomUUID } from "node:crypto";
import { StudioError, title } from "./store.ts";
import type { Database, Query } from "./store.ts";
import { between } from "./order.ts";
const invalid = (message: string): never => {
  throw new StudioError(400, "INVALID_INPUT", message);
};
const found = (row: any) => {
  if (!row)
    throw new StudioError(404, "NOT_FOUND", "That item no longer exists.");
  return row;
};
const stamp = (old?: string) =>
  new Date(Math.max(Date.now(), Date.parse(old ?? "") + 1 || 0)).toISOString();
function input(value: any, allowed: string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !allowed.includes(k))
  )
    invalid("Choose supported world or series details.");
}
function cas(old: any, expected: unknown) {
  if (typeof expected !== "string" || old.updatedAt !== expected)
    throw new StudioError(
      409,
      "WORLD_CONFLICT",
      "This item changed. Your form is kept. Close and reopen Worlds and Series to review it.",
    );
}
async function libraryLock(q: Query, id: string) {
  found(
    (await q("SELECT id FROM libraries WHERE id=$1 FOR UPDATE", [id])).rows[0],
  );
}
export async function worlds(db: Database, libraryId: string) {
  return db.transaction(async (q) => {
    await libraryLock(q, libraryId);
    const universes = (
      await q(
        "SELECT data FROM universes WHERE library_id=$1 ORDER BY (data->>'orderKey') COLLATE \"C\",id",
        [libraryId],
      )
    ).rows.map((r) => r.data);
    const series = (
      await q(
        "SELECT data FROM series WHERE library_id=$1 ORDER BY (data->>'orderKey') COLLATE \"C\",id",
        [libraryId],
      )
    ).rows.map((r) => r.data);
    const books = (
      await q(
        "SELECT data FROM books WHERE library_id=$1 ORDER BY (data->>'orderKey') COLLATE \"C\",id",
        [libraryId],
      )
    ).rows.map((r) => r.data);
    return { universes, series, books };
  });
}
export async function editWorld(
  db: Database,
  libraryId: string,
  kind: "universes" | "series",
  value: any,
  id?: string,
) {
  input(
    value,
    id
      ? ["title", "expectedUpdatedAt", "deleted"]
      : kind === "series"
        ? ["title", "universeId"]
        : ["title"],
  );
  if (
    Object.hasOwn(value, "deleted") &&
    (typeof value.deleted !== "boolean" || Object.hasOwn(value, "title"))
  )
    invalid("Choose either rename or Trash/restore.");
  return db.transaction(async (q) => {
    await libraryLock(q, libraryId);
    let data: any;
    if (id) {
      data = {
        ...found(
          (
            await q(`SELECT data FROM ${kind} WHERE id=$1 AND library_id=$2`, [
              id,
              libraryId,
            ])
          ).rows[0],
        ).data,
      };
      cas(data, value.expectedUpdatedAt);
      if (data.deletedAt && value.deleted !== false)
        invalid("Restore this item before editing it.");
      if (!Object.hasOwn(value, "deleted") && !Object.hasOwn(value, "title"))
        invalid("Provide a title or Trash/restore action.");
    } else {
      const now = stamp();
      const last = (
        await q(
          `SELECT data FROM ${kind} WHERE library_id=$1 ORDER BY (data->>'orderKey') COLLATE "C" DESC,id DESC LIMIT 1`,
          [libraryId],
        )
      ).rows[0]?.data.orderKey;
      data = {
        id: randomUUID(),
        title: title(value.title),
        orderKey: between(last),
        createdAt: now,
        updatedAt: now,
      };
      if (kind === "series" && value.universeId != null) {
        if (typeof value.universeId !== "string")
          invalid("Choose a live world in this library.");
        const world = (
          await q(
            "SELECT data FROM universes WHERE id::text=$1 AND library_id=$2",
            [value.universeId, libraryId],
          )
        ).rows[0]?.data;
        if (!world || world.deletedAt)
          invalid("Choose a live world in this library.");
        data.universeId = world.id;
      }
    }
    if (value.deleted === true) {
      // Include Trash: a restored book must never inherit a dead parent.
      const members = (
        await q(
          `SELECT id FROM books WHERE library_id=$1 AND ${kind === "universes" ? "universe_id" : "series_id"}=$2 LIMIT 1`,
          [libraryId, id],
        )
      ).rows;
      const children =
        kind === "universes"
          ? (
              await q(
                "SELECT id FROM series WHERE library_id=$1 AND universe_id=$2 AND NOT (data ? 'deletedAt') LIMIT 1",
                [libraryId, id],
              )
            ).rows
          : [];
      const entries = (
        await q(
          "SELECT e.id FROM bible_entries e WHERE e.library_id=$1 AND e.data->'scope'->>'id'=$2 LIMIT 1",
          [libraryId, id],
        )
      ).rows;
      if (members.length || children.length || entries.length)
        invalid(
          "This item still has books, series or bible entries, including Trash. Move or clear those first.",
        );
      data.deletedAt = stamp(data.updatedAt);
    }
    if (value.deleted === false) {
      if (data.universeId) {
        const parent = (
          await q("SELECT data FROM universes WHERE id=$1", [data.universeId])
        ).rows[0]?.data;
        if (!parent || parent.deletedAt)
          invalid("Restore the parent world first.");
      }
      delete data.deletedAt;
    }
    if (Object.hasOwn(value, "title")) data.title = title(value.title);
    if (id) {
      data.updatedAt = stamp(data.updatedAt);
      await q(`UPDATE ${kind} SET data=$3 WHERE id=$1 AND library_id=$2`, [
        id,
        libraryId,
        data,
      ]);
    } else
      await q(`INSERT INTO ${kind}(id,library_id,data) VALUES($1,$2,$3)`, [
        data.id,
        libraryId,
        data,
      ]);
    return data;
  });
}
export async function bookMembership(db: Database, bookId: string, value: any) {
  input(value, ["universeId", "seriesId", "expectedUpdatedAt"]);
  if (!["universeId", "seriesId"].some((k) => Object.hasOwn(value, k)))
    invalid("Choose a world or series.");
  for (const k of ["universeId", "seriesId"])
    if (
      Object.hasOwn(value, k) &&
      value[k] !== null &&
      (typeof value[k] !== "string" || !value[k])
    )
      invalid("Choose a world or series, or clear it explicitly.");
  return db.transaction(async (q) => {
    const row = found(
      (
        await q("SELECT data,library_id FROM books WHERE id=$1 FOR UPDATE", [
          bookId,
        ])
      ).rows[0],
    );
    await libraryLock(q, row.library_id);
    const old = row.data;
    cas(old, value.expectedUpdatedAt);
    if (old.deletedAt)
      invalid("Restore the book before changing its world or series.");
    const universeId = Object.hasOwn(value, "universeId")
      ? value.universeId
      : old.universeId;
    let seriesId = Object.hasOwn(value, "seriesId")
      ? value.seriesId
      : old.seriesId;
    if (universeId) {
      const world = (
        await q(
          "SELECT data FROM universes WHERE id::text=$1 AND library_id=$2",
          [universeId, row.library_id],
        )
      ).rows[0]?.data;
      if (!world || world.deletedAt)
        invalid("Choose a live world in this library.");
    }
    if (seriesId) {
      const serial = (
        await q("SELECT data FROM series WHERE id::text=$1 AND library_id=$2", [
          seriesId,
          row.library_id,
        ])
      ).rows[0]?.data;
      if (!serial || serial.deletedAt)
        invalid("Choose a live series in this library.");
      // Native world changes clear an incompatible existing series.
      if (
        (serial.universeId ?? null) !== (universeId ?? null) &&
        !Object.hasOwn(value, "seriesId")
      )
        seriesId = null;
      else if (serial.universeId && serial.universeId !== universeId)
        invalid("Choose the series' world first.");
    }
    const left = [
      old.universeId !== universeId ? old.universeId : null,
      old.seriesId !== seriesId ? old.seriesId : null,
    ].filter(Boolean);
    if (left.length) {
      const entries = (
        await q("SELECT e.data FROM bible_entries e WHERE e.library_id=$1", [
          row.library_id,
        ])
      ).rows;
      if (
        entries.some(
          (r) =>
            left.includes(r.data.scope?.id) &&
            (r.data.overrides ?? []).some((o: any) => o.bookId === bookId),
        )
      )
        invalid(
          "Clear this book's values on entries in the world or series it would leave first.",
        );
    }
    // Local values and this-book overrides must still resolve after membership changes.
    const futureBook = { ...old, universeId, seriesId };
    const all = (
      await q("SELECT data FROM bible_entries WHERE library_id=$1", [
        row.library_id,
      ])
    ).rows.map((r) => r.data);
    const fields = (
      await q(
        "SELECT data FROM bible_fields WHERE library_id=$1 AND data->>'fieldType' IN ('entryReference','entryReferences')",
        [row.library_id],
      )
    ).rows.map((r) => r.data);
    for (const entry of all) {
      const maps =
        entry.scope?.kind === "book" && entry.scope.id === bookId
          ? [entry.values]
          : (entry.overrides ?? [])
              .filter((o: any) => o.bookId === bookId)
              .map((o: any) => o.values);
      for (const values of maps)
        for (const field of fields) {
          const value = values?.[field.id];
          const ids =
            field.fieldType === "entryReferences"
              ? Array.isArray(value)
                ? value
                : []
              : value == null
                ? []
                : [value];
          for (const id of ids) {
            const target = all.find((e) => e.id === id);
            if (
              target &&
              scopeAllowsTarget(
                { scope: { kind: "book", id: bookId } },
                target,
                old,
              ) &&
              !scopeAllowsTarget(
                { scope: { kind: "book", id: bookId } },
                target,
                futureBook,
              )
            )
              invalid(
                "Clear saved entry links to the world or series this book would leave first.",
              );
          }
        }
    }
    const relations = (
      await q(
        "SELECT data FROM relationships WHERE book_id=$1 AND NOT (data ? 'deletedAt')",
        [bookId],
      )
    ).rows.map((r) => r.data);
    for (const relation of relations)
      for (const id of [relation.fromEntryId, relation.toEntryId]) {
        const target = all.find((e) => e.id === id);
        if (
          target &&
          scopeAllowsTarget(
            { scope: { kind: "book", id: bookId } },
            target,
            old,
          ) &&
          !scopeAllowsTarget(
            { scope: { kind: "book", id: bookId } },
            target,
            futureBook,
          )
        )
          invalid(
            "Move this book's relationships to Trash before leaving the world or series of their entries.",
          );
      }
    const book = { ...old, updatedAt: stamp(old.updatedAt) };
    if (universeId) book.universeId = universeId;
    else delete book.universeId;
    if (seriesId) book.seriesId = seriesId;
    else delete book.seriesId;
    await q("UPDATE books SET data=$2 WHERE id=$1", [bookId, book]);
    return book;
  });
}
