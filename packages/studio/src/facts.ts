// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { StudioError } from "./store.ts";
import type { Database, Query } from "./store.ts";
import { between } from "./order.ts";
import { hasRecordOverride, withoutRecordOverride } from "./record-overrides.ts";
const invalid = (message: string): never => {
  throw new StudioError(400, "INVALID_INPUT", message);
};
const stamp = (old?: string) =>
  new Date(Math.max(Date.now(), Date.parse(old ?? "") + 1 || 0)).toISOString();
export async function migrateFacts(q: Query) {
  await q(`CREATE TABLE facts(id uuid PRIMARY KEY,library_id uuid NOT NULL REFERENCES libraries(id),data jsonb NOT NULL,
 book_id uuid GENERATED ALWAYS AS (CASE WHEN data->'scope'->>'kind'='book' THEN (data->'scope'->>'id')::uuid END) STORED,
 universe_id uuid GENERATED ALWAYS AS (CASE WHEN data->'scope'->>'kind'='universe' THEN (data->'scope'->>'id')::uuid END) STORED,
 series_id uuid GENERATED ALWAYS AS (CASE WHEN data->'scope'->>'kind'='series' THEN (data->'scope'->>'id')::uuid END) STORED,
 FOREIGN KEY(book_id,library_id) REFERENCES books(id,library_id),
 FOREIGN KEY(universe_id,library_id) REFERENCES universes(id,library_id),
 FOREIGN KEY(series_id,library_id) REFERENCES series(id,library_id),
 CHECK ((data ?& ARRAY['id','scope','text','truth','entryIds','knowledge','orderKey','createdAt','updatedAt'] AND (data->>'id')::uuid=id
 AND data->'scope'->>'kind' IN ('book','universe','series') AND coalesce(book_id,universe_id,series_id) IS NOT NULL
 AND length(data->>'text') BETWEEN 1 AND 20000 AND data->>'truth' IN ('true','false','undecided')
 AND jsonb_typeof(data->'entryIds')='array' AND jsonb_typeof(data->'knowledge')='array') IS TRUE));
 CREATE INDEX facts_by_library ON facts(library_id);
 UPDATE studio_schema SET version=8`);
}
/** Saved fact catalog and choices; a single book→library lock gives a consistent view. */
export async function factCatalog(db: Database, bookId: string) {
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
    if (row.data.deletedAt) invalid("Restore the book before opening facts.");
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
          "This library is too large for the facts catalog. No records were omitted.",
        );
      return rows.map((r) => r.data);
    };
    const books = await read("books"),
      entries = await read("bible_entries"),
      facts = await read("facts");
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
        "This library has too many manuscript items for the facts catalog. No records were omitted.",
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
    return {
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
      facts: facts
        .filter((f) => factVisible(f, row.data))
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

/** Canonical fact writes shared by the HTTP API and internal recovery checks. */
export async function saveFact(
  db: Database,
  bookId: string,
  input: any,
  id?: string,
) {
  const allowed = id
    ? [
        "text",
        "truth",
        "nodeId",
        "entryIds",
        "knowledge",
        "expectedUpdatedAt",
        "deleted",
        "editSharedCanon",
      ]
    : ["text", "truth", "nodeId", "entryIds", "knowledge", "scopeKind"];
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((k) => !allowed.includes(k))
  )
    invalid("Provide only editable fact details.");
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
    if (book.data.deletedAt) invalid("Restore the book before editing facts.");
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
        await q("SELECT data FROM facts WHERE id=$1 AND library_id=$2", [
          id,
          book.library_id,
        ])
      ).rows[0]?.data;
      if (!data || !factVisible(data, book.data))
        throw new StudioError(404, "NOT_FOUND", "Fact is not visible here.");
      if (data.updatedAt !== input.expectedUpdatedAt)
        throw new StudioError(
          409,
          "FACT_CONFLICT",
          "This fact changed. Keep your draft and reopen facts.",
        );
      if (data.scope.kind !== "book" && input.editSharedCanon !== true)
        invalid("Confirm editing this shared fact for all books.");
      if (data.deletedAt && input.deleted !== false)
        invalid("Restore this fact before editing it.");
      data = { ...data };
    } else {
      if (!scopeId) invalid("Choose a visible fact scope.");
      const last = (
        await q(
          `SELECT data->>'orderKey' AS key FROM facts WHERE library_id=$1 ORDER BY (data->>'orderKey') COLLATE "C" DESC LIMIT 1`,
          [book.library_id],
        )
      ).rows[0]?.key;
      data = {
        id: randomUUID(),
        scope: { kind, id: scopeId },
        text: input.text,
        truth: "true",
        entryIds: [],
        knowledge: [],
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
      for (const key of ["text", "truth", "entryIds", "knowledge"])
        if (Object.hasOwn(input, key)) data[key] = input[key];
      if (Object.hasOwn(input, "nodeId")) {
        if (input.nodeId === null) delete data.nodeId;
        else data.nodeId = input.nodeId;
      }
    }
    {
      if (
        typeof data.text !== "string" ||
        !data.text.length ||
        [...data.text].length > 20000 ||
        !["true", "false", "undecided"].includes(data.truth)
      )
        invalid("Use fact text of 1–20000 characters and a valid truth.");
      if (
        !Array.isArray(data.entryIds) ||
        data.entryIds.some((v: any) => typeof v !== "string") ||
        new Set(data.entryIds).size !== data.entryIds.length ||
        !Array.isArray(data.knowledge)
      )
        invalid("Use unique entry links and knowers.");
      const entries = (
        await q("SELECT data FROM bible_entries WHERE library_id=$1", [
          book.library_id,
        ])
      ).rows.map((r) => r.data);
      for (const entryId of data.entryIds)
        if (!entries.some((e) => e.id === entryId))
          invalid("Choose an entry in this library.");
      const seen = new Set();
      for (const k of data.knowledge) {
        if (
          !k ||
          typeof k !== "object" ||
          Array.isArray(k) ||
          Object.keys(k).some((x) => !["knower", "nodeId"].includes(x)) ||
          typeof k.knower !== "string" ||
          seen.has(k.knower)
        )
          invalid("List each reader or character only once.");
        seen.add(k.knower);
        if (
          k.knower !== "reader" &&
          !entries.some((e) => e.id === k.knower && e.entryType === "character")
        )
          invalid("Knowers must be the reader or a character in this library.");
      }
      for (const nodeId of [
        data.nodeId,
        ...data.knowledge.map((k: any) => k.nodeId),
      ].filter((v) => v !== undefined)) {
        if (typeof nodeId !== "string") invalid("Choose a chapter or scene.");
        const n = (
          await q(
            "SELECT n.kind,b.data,b.library_id FROM manuscript_nodes n JOIN books b ON b.id=n.book_id WHERE n.id::text=$1",
            [nodeId],
          )
        ).rows[0];
        if (
          !n ||
          n.library_id !== book.library_id ||
          !["chapter", "scene"].includes(n.kind) ||
          !factVisible(data, n.data)
        )
          invalid("Choose a chapter or scene inside this fact scope.");
      }
    }
    if (data.scope.kind !== "book") {
      const table = data.scope.kind === "universe" ? "universes" : "series";
      const parent = (
        await q(`SELECT data FROM ${table} WHERE id=$1 AND library_id=$2`, [
          data.scope.id,
          book.library_id,
        ])
      ).rows[0]?.data;
      if (!parent || parent.deletedAt) invalid("Restore the fact scope first.");
    }
    data.updatedAt = stamp(data.updatedAt);
    if (id) await q("UPDATE facts SET data=$2 WHERE id=$1", [id, data]);
    else
      await q("INSERT INTO facts(id,library_id,data) VALUES($1,$2,$3)", [
        data.id,
        book.library_id,
        data,
      ]);
    return data;
  });
}
export function factVisible(fact: any, book: any) {
  const s = fact.scope;
  return s.kind === "book"
    ? s.id === book.id
    : s.kind === "universe"
      ? s.id === book.universeId
      : s.id === book.seriesId;
}
/** Caller holds the whole-library recovery locks and already persisted its backup. */
export async function unlinkFacts(
  q: Query,
  libraryId: string,
  entries: string[],
  nodes: string[],
  bookId?: string,
) {
  const rows = (await q("SELECT id,library_id,data FROM facts")).rows;
  for (const row of rows) {
    const f = row.data;
    const hit =
      f.entryIds.some((id: string) => entries.includes(id)) ||
      f.knowledge.some(
        (k: any) => entries.includes(k.knower) || nodes.includes(k.nodeId),
      ) ||
      nodes.includes(f.nodeId) ||
      (!!bookId && hasRecordOverride(f, bookId));
    const owned = bookId && f.scope.kind === "book" && f.scope.id === bookId;
    if (!hit && !owned) continue;
    if (row.library_id !== libraryId)
      invalid(
        "Unbacked fact dependencies from another library prevent permanent deletion.",
      );
    if (owned) {
      await q("DELETE FROM facts WHERE id=$1", [f.id]);
      continue;
    }
    const data = withoutRecordOverride(
      {
        ...f,
        entryIds: f.entryIds.filter((id: string) => !entries.includes(id)),
        knowledge: f.knowledge.filter(
          (k: any) => !entries.includes(k.knower) && !nodes.includes(k.nodeId),
        ),
        updatedAt: stamp(f.updatedAt),
      },
      bookId ?? "",
    );
    if (nodes.includes(data.nodeId)) delete data.nodeId;
    await q("UPDATE facts SET data=$2 WHERE id=$1", [f.id, data]);
  }
}
