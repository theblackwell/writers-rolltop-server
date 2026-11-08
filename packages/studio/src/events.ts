// SPDX-License-Identifier: AGPL-3.0-only
import { unlinkStateChanges } from "./state-changes.ts";
import { randomUUID } from "node:crypto";
import { StudioError } from "./store.ts";
import type { Database, Query } from "./store.ts";
import { between } from "./order.ts";
import {
  hasRecordOverride,
  withoutOverrideParticipants,
  withoutRecordOverride,
} from "./record-overrides.ts";
const invalid = (message: string): never => {
  throw new StudioError(400, "INVALID_INPUT", message);
};
const stamp = (old?: string) =>
  new Date(Math.max(Date.now(), Date.parse(old ?? "") + 1 || 0)).toISOString();
export async function migrateEvents(q: Query) {
  await q(`CREATE TABLE continuity_events(id uuid PRIMARY KEY,library_id uuid NOT NULL REFERENCES libraries(id),data jsonb NOT NULL,
 book_id uuid GENERATED ALWAYS AS (CASE WHEN data->'scope'->>'kind'='book' THEN (data->'scope'->>'id')::uuid END) STORED,
 universe_id uuid GENERATED ALWAYS AS (CASE WHEN data->'scope'->>'kind'='universe' THEN (data->'scope'->>'id')::uuid END) STORED,
 series_id uuid GENERATED ALWAYS AS (CASE WHEN data->'scope'->>'kind'='series' THEN (data->'scope'->>'id')::uuid END) STORED,
 FOREIGN KEY(book_id,library_id) REFERENCES books(id,library_id),
 FOREIGN KEY(universe_id,library_id) REFERENCES universes(id,library_id),
 FOREIGN KEY(series_id,library_id) REFERENCES series(id,library_id),
 CHECK ((data ?& ARRAY['id','scope','title','sceneIds','participants','orderKey','createdAt','updatedAt'] AND (data->>'id')::uuid=id
 AND data->'scope'->>'kind' IN ('book','universe','series') AND coalesce(book_id,universe_id,series_id) IS NOT NULL
 AND jsonb_typeof(data->'title')='string'
 AND jsonb_typeof(data->'sceneIds')='array' AND jsonb_typeof(data->'participants')='array') IS TRUE));
 CREATE INDEX continuity_events_by_library ON continuity_events(library_id);
 UPDATE studio_schema SET version=10`);
}
/** Saved event catalog and choices; a single book→library lock gives a consistent view. */
export async function eventCatalog(db: Database, bookId: string) {
  return db.transaction(async (q) => {
    const row = (
      await q("SELECT data,library_id FROM books WHERE id=$1 FOR UPDATE", [
        bookId,
      ])
    ).rows[0];
    if (!row) throw new StudioError(404, "NOT_FOUND", "Book no longer exists.");
    await q("SELECT id FROM libraries WHERE id=$1 FOR UPDATE", [
      row.library_id,
    ]);
    if (row.data.deletedAt) invalid("Restore the book before opening events.");
    const read = async (table: string) => {
      const rows = (
        await q(`SELECT data FROM ${table} WHERE library_id=$1 LIMIT 10001`, [
          row.library_id,
        ])
      ).rows;
      if (rows.length > 10000)
        throw new StudioError(
          413,
          "CATALOG_TOO_LARGE",
          "This library is too large for the events catalog. No records were omitted.",
        );
      return rows.map((r) => r.data);
    };
    const books = await read("books"),
      entries = await read("bible_entries"),
      events = await read("continuity_events");
    const worlds = await read("universes"),
      series = await read("series");
    const allNodes = (
      await q(
        "SELECT n.data FROM manuscript_nodes n JOIN books b ON b.id=n.book_id WHERE b.library_id=$1 LIMIT 10001",
        [row.library_id],
      )
    ).rows.map((r) => r.data);
    if (allNodes.length > 10000)
      throw new StudioError(
        413,
        "CATALOG_TOO_LARGE",
        "This library has too many manuscript items for the events catalog. No records were omitted.",
      );
    const byId = new Map(allNodes.map((n) => [n.id, n]));
    const isTrashed = (n: any): boolean => {
      const seen = new Set();
      while (n && !seen.has(n.id)) {
        seen.add(n.id);
        if (n.deletedAt) return true;
        n = byId.get(n.parentId);
      }
      return false;
    };
    const positions: Record<string, number> = {};
    const children = new Map<string | undefined, any[]>();
    for (const n of allNodes) {
      if (n.bookId !== bookId || isTrashed(n)) continue;
      const parent = n.parentId ?? undefined;
      const group = children.get(parent) ?? [];
      group.push(n);
      children.set(parent, group);
    }
    for (const group of children.values())
      group.sort((a, b) =>
        a.orderKey < b.orderKey
          ? -1
          : a.orderKey > b.orderKey
            ? 1
            : a.id < b.id
              ? -1
              : a.id > b.id
                ? 1
                : 0,
      );
    const seen = new Set<string>();
    let rank = 0;
    const pending = [...(children.get(undefined) ?? [])].reverse();
    while (pending.length) {
      const n = pending.pop()!;
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      if (n.kind === "chapter" || n.kind === "scene") positions[n.id] = rank++;
      pending.push(...[...(children.get(n.id) ?? [])].reverse());
    }
    return {
      readingPositions: positions,
      book: row.data,
      scopes: [
        { kind: "book", id: bookId, title: "This book" },
        ...worlds
          .filter((w) => w.id === row.data.universeId && !w.deletedAt)
          .map((w) => ({
            kind: "universe",
            id: w.id,
            title: `Shared world: ${w.title}`,
          })),
        ...series
          .filter((s) => s.id === row.data.seriesId && !s.deletedAt)
          .map((s) => ({
            kind: "series",
            id: s.id,
            title: `Shared series: ${s.title}`,
          })),
      ],
      events: events
        .filter((f) => eventVisible(f, row.data))
        .sort((a, b) =>
          a.orderKey < b.orderKey
            ? -1
            : a.orderKey > b.orderKey
              ? 1
              : a.id.localeCompare(b.id),
        ),
      entries: entries.map((e) => ({
        id: e.id,
        name: e.name,
        entryType: e.entryType,
        scope: e.scope,
        scopeTitle:
          e.scope.kind === "book"
            ? `Book: ${books.find((b) => b.id === e.scope.id)?.title ?? e.scope.id}`
            : e.scope.kind === "universe"
              ? `World: ${worlds.find((w) => w.id === e.scope.id)?.title ?? e.scope.id}`
              : `Series: ${series.find((s) => s.id === e.scope.id)?.title ?? e.scope.id}`,
        deletedAt: e.deletedAt,
      })),
      books: books.map((b) => ({
        id: b.id,
        title: b.title,
        universeId: b.universeId,
        seriesId: b.seriesId,
        deletedAt: b.deletedAt,
      })),
      nodes: allNodes
        .filter((n) => ["chapter", "scene"].includes(n.kind))
        .map((n) => ({
          id: n.id,
          bookId: n.bookId,
          title: n.title,
          kind: n.kind,
          inTrash:
            isTrashed(n) || !!books.find((b) => b.id === n.bookId)?.deletedAt,
        })),
    };
  });
}

/** Canonical event writes shared by authenticated timeline routes. */
export async function saveEvent(
  db: Database,
  bookId: string,
  input: any,
  id?: string,
) {
  const allowed = id
    ? [
        "title",
        "summary",
        "when",
        "entryId",
        "sceneIds",
        "participants",
        "expectedUpdatedAt",
        "deleted",
        "editSharedCanon",
      ]
    : [
        "title",
        "summary",
        "when",
        "entryId",
        "sceneIds",
        "participants",
        "scopeKind",
      ];
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((k) => !allowed.includes(k))
  )
    invalid("Provide only editable event details.");
  return db.transaction(async (q) => {
    const book = (
      await q("SELECT data,library_id FROM books WHERE id=$1 FOR UPDATE", [
        bookId,
      ])
    ).rows[0];
    if (!book)
      throw new StudioError(404, "NOT_FOUND", "Book no longer exists.");
    await q("SELECT id FROM libraries WHERE id=$1 FOR UPDATE", [
      book.library_id,
    ]);
    if (book.data.deletedAt)
      invalid("Restore the book before editing timeline events.");
    const kind = input.scopeKind ?? "book";
    const scopeId =
      kind === "book"
        ? bookId
        : kind === "universe"
          ? book.data.universeId
          : kind === "series"
            ? book.data.seriesId
            : undefined;
    const now = stamp();
    let data: any;
    if (id) {
      data = (
        await q(
          "SELECT data FROM continuity_events WHERE id=$1 AND library_id=$2",
          [id, book.library_id],
        )
      ).rows[0]?.data;
      if (!data || !eventVisible(data, book.data))
        throw new StudioError(404, "NOT_FOUND", "Event is not visible here.");
      if (data.updatedAt !== input.expectedUpdatedAt)
        throw new StudioError(
          409,
          "EVENT_CONFLICT",
          "This event changed. Keep your draft and reopen the timeline.",
        );
      if (data.scope.kind !== "book" && input.editSharedCanon !== true)
        invalid("Confirm editing this shared event for all books.");
      if (data.deletedAt && input.deleted !== false)
        invalid("Restore this event before editing it.");
      data = { ...data };
    } else {
      if (!scopeId) invalid("Choose a visible event scope.");
      const last = (
        await q(
          `SELECT data->>'orderKey' AS key FROM continuity_events WHERE library_id=$1 ORDER BY (data->>'orderKey') COLLATE "C" DESC LIMIT 1`,
          [book.library_id],
        )
      ).rows[0]?.key;
      data = {
        id: randomUUID(),
        scope: { kind, id: scopeId },
        title: input.title,
        sceneIds: [],
        participants: [],
        orderKey: between(last),
        createdAt: now,
        updatedAt: now,
      };
    }
    if (Object.hasOwn(input, "deleted")) {
      if (
        typeof input.deleted !== "boolean" ||
        Object.keys(input).some(
          (k) =>
            !["deleted", "expectedUpdatedAt", "editSharedCanon"].includes(k),
        )
      )
        invalid("Choose Trash/restore separately.");
      if (input.deleted) data.deletedAt = stamp(data.updatedAt);
      else delete data.deletedAt;
    } else {
      for (const key of ["title", "sceneIds", "participants"])
        if (Object.hasOwn(input, key)) data[key] = input[key];
      for (const key of ["summary", "when", "entryId"]) {
        if (!Object.hasOwn(input, key)) continue;
        if (input[key] === null) delete data[key];
        else data[key] = input[key];
      }
    }
    if (
      typeof data.title !== "string" ||
      (data.summary !== undefined && typeof data.summary !== "string")
    )
      invalid("Use plain text for the event title and summary.");
    if (data.when !== undefined) {
      const w = data.when;
      if (
        !w ||
        typeof w !== "object" ||
        Array.isArray(w) ||
        Object.keys(w).some(
          (k) => !["label", "calendar", "ordinal"].includes(k),
        ) ||
        typeof w.label !== "string" ||
        !w.label.length ||
        (w.calendar !== undefined &&
          (typeof w.calendar !== "string" || !w.calendar.length)) ||
        (w.ordinal !== undefined && !Number.isSafeInteger(w.ordinal))
      )
        invalid(
          "Use a story date label, optional calendar and safe whole-number ordinal.",
        );
    }
    if (
      !Array.isArray(data.sceneIds) ||
      data.sceneIds.some((v: any) => typeof v !== "string") ||
      new Set(data.sceneIds).size !== data.sceneIds.length
    )
      invalid("Choose unique scenes.");
    if (
      !Array.isArray(data.participants) ||
      data.participants.some(
        (v: any) =>
          !v ||
          typeof v !== "object" ||
          Array.isArray(v) ||
          typeof v.entryId !== "string" ||
          Object.keys(v).some((k) => !["entryId", "role"].includes(k)) ||
          (v.role !== undefined && typeof v.role !== "string"),
      ) ||
      new Set(data.participants.map((v: any) => v.entryId)).size !==
        data.participants.length
    )
      invalid("Choose unique participants with optional plain-text roles.");
    const entries = (
      await q("SELECT data FROM bible_entries WHERE library_id=$1", [
        book.library_id,
      ])
    ).rows.map((r) => r.data);
    if (
      data.entryId !== undefined &&
      (typeof data.entryId !== "string" ||
        !entries.some((e) => e.id === data.entryId && e.entryType === "event"))
    )
      invalid("Choose a bible entry of type event in this library.");
    for (const part of data.participants)
      if (!entries.some((e) => e.id === part.entryId))
        invalid("Choose participants in this library.");
    for (const sceneId of data.sceneIds) {
      const n = (
        await q(
          "SELECT n.kind,b.data,b.library_id FROM manuscript_nodes n JOIN books b ON b.id=n.book_id WHERE n.id::text=$1",
          [sceneId],
        )
      ).rows[0];
      if (
        !n ||
        n.library_id !== book.library_id ||
        n.kind !== "scene" ||
        !eventVisible(data, n.data)
      )
        invalid("Choose scenes inside this event scope.");
    }
    if (data.scope.kind !== "book") {
      const table = data.scope.kind === "universe" ? "universes" : "series";
      const parent = (
        await q(`SELECT data FROM ${table} WHERE id=$1 AND library_id=$2`, [
          data.scope.id,
          book.library_id,
        ])
      ).rows[0]?.data;
      if (!parent || parent.deletedAt)
        invalid("Restore the event scope first.");
    }
    data.updatedAt = stamp(data.updatedAt);
    if (id)
      await q("UPDATE continuity_events SET data=$2 WHERE id=$1", [id, data]);
    else
      await q(
        "INSERT INTO continuity_events(id,library_id,data) VALUES($1,$2,$3)",
        [data.id, book.library_id, data],
      );
    return data;
  });
}
export function eventVisible(event: any, book: any) {
  const s = event.scope;
  return s.kind === "book"
    ? s.id === book.id
    : s.kind === "universe"
      ? s.id === book.universeId
      : s.id === book.seriesId;
}
/** Caller holds the whole-library recovery locks and already persisted its backup. */
export async function unlinkEvents(
  q: Query,
  libraryId: string,
  entries: string[],
  nodes: string[],
  bookId?: string,
) {
  const rows = (await q("SELECT id,library_id,data FROM continuity_events"))
    .rows;
  for (const row of rows) {
    const f = row.data;
    const hit =
      entries.includes(f.entryId) ||
      f.participants.some((p: any) => entries.includes(p.entryId)) ||
      f.sceneIds.some((id: string) => nodes.includes(id)) ||
      (f.overrides ?? []).some((o: any) =>
        (o.participants ?? []).some((p: any) => entries.includes(p.entryId)),
      ) ||
      (!!bookId && hasRecordOverride(f, bookId));
    const owned = bookId && f.scope.kind === "book" && f.scope.id === bookId;
    if (!hit && !owned) continue;
    if (row.library_id !== libraryId)
      invalid(
        "Unbacked event dependencies from another library prevent permanent deletion.",
      );
    if (owned) {
      await unlinkStateChanges(q, libraryId, [], [], [f.id]);
      await q("DELETE FROM continuity_events WHERE id=$1", [f.id]);
      continue;
    }
    const data = withoutRecordOverride(
      withoutOverrideParticipants(
        {
          ...f,
          sceneIds: f.sceneIds.filter((id: string) => !nodes.includes(id)),
          participants: f.participants.filter(
            (p: any) => !entries.includes(p.entryId),
          ),
          updatedAt: stamp(f.updatedAt),
        },
        entries,
      ),
      bookId ?? "",
    );
    if (entries.includes(data.entryId)) delete data.entryId;
    await q("UPDATE continuity_events SET data=$2 WHERE id=$1", [f.id, data]);
  }
}
