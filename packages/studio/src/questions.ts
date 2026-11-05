// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { StudioError } from "./store.ts";
import type { Database, Query } from "./store.ts";
import { between } from "./order.ts";
const invalid = (message: string): never => {
  throw new StudioError(400, "INVALID_INPUT", message);
};
const stamp = (old?: string) =>
  new Date(Math.max(Date.now(), Date.parse(old ?? "") + 1 || 0)).toISOString();
export async function migrateQuestions(q: Query) {
  await q(`CREATE TABLE questions(id uuid PRIMARY KEY,library_id uuid NOT NULL REFERENCES libraries(id),data jsonb NOT NULL,
 book_id uuid GENERATED ALWAYS AS (CASE WHEN data->'scope'->>'kind'='book' THEN (data->'scope'->>'id')::uuid END) STORED,
 universe_id uuid GENERATED ALWAYS AS (CASE WHEN data->'scope'->>'kind'='universe' THEN (data->'scope'->>'id')::uuid END) STORED,
 series_id uuid GENERATED ALWAYS AS (CASE WHEN data->'scope'->>'kind'='series' THEN (data->'scope'->>'id')::uuid END) STORED,
 FOREIGN KEY(book_id,library_id) REFERENCES books(id,library_id),
 FOREIGN KEY(universe_id,library_id) REFERENCES universes(id,library_id),
 FOREIGN KEY(series_id,library_id) REFERENCES series(id,library_id),
 CHECK ((data ?& ARRAY['id','scope','text','status','entryIds','orderKey','createdAt','updatedAt'] AND (data->>'id')::uuid=id
 AND data->'scope'->>'kind' IN ('book','universe','series') AND coalesce(book_id,universe_id,series_id) IS NOT NULL
 AND length(data->>'text') BETWEEN 1 AND 20000 AND data->>'status' IN ('open','decided')
 AND jsonb_typeof(data->'entryIds')='array') IS TRUE));
 CREATE INDEX questions_by_library ON questions(library_id);
 UPDATE studio_schema SET version=9`);
}
/** Internal question storage; public APIs and controls follow in B5b2. */
export async function saveQuestion(
  db: Database,
  bookId: string,
  input: any,
  id?: string,
) {
  const allowed = id
    ? [
        "text",
        "topic",
        "status",
        "decision",
        "nodeId",
        "entryIds",
        "expectedUpdatedAt",
        "deleted",
        "editSharedCanon",
      ]
    : [
        "text",
        "topic",
        "status",
        "decision",
        "nodeId",
        "entryIds",
        "scopeKind",
      ];
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((k) => !allowed.includes(k))
  )
    invalid("Provide only editable question details.");
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
      invalid("Restore the book before editing questions.");
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
        await q("SELECT data FROM questions WHERE id=$1 AND library_id=$2", [
          id,
          book.library_id,
        ])
      ).rows[0]?.data;
      if (!data || !questionVisible(data, book.data))
        throw new StudioError(
          404,
          "NOT_FOUND",
          "Question is not visible here.",
        );
      if (data.updatedAt !== input.expectedUpdatedAt)
        throw new StudioError(
          409,
          "QUESTION_CONFLICT",
          "This question changed. Keep your draft and reopen questions.",
        );
      if (data.scope.kind !== "book" && input.editSharedCanon !== true)
        invalid("Confirm editing this shared question for all books.");
      if (data.deletedAt && input.deleted !== false)
        invalid("Restore this question before editing it.");
      data = { ...data };
    } else {
      if (!scopeId) invalid("Choose a visible question scope.");
      const last = (
        await q(
          `SELECT data->>'orderKey' AS key FROM questions WHERE library_id=$1 ORDER BY (data->>'orderKey') COLLATE "C" DESC LIMIT 1`,
          [book.library_id],
        )
      ).rows[0]?.key;
      data = {
        id: randomUUID(),
        scope: { kind, id: scopeId },
        text: input.text,
        status: "open",
        entryIds: [],
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
      for (const key of ["text", "status", "entryIds"])
        if (Object.hasOwn(input, key)) data[key] = input[key];
      for (const key of ["topic", "decision"]) {
        if (!Object.hasOwn(input, key)) continue;
        if (input[key] === null) delete data[key];
        else data[key] = input[key];
      }
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
        !["open", "decided"].includes(data.status)
      )
        invalid("Use question text of 1–20000 characters and a valid status.");
      if (
        data.topic !== undefined &&
        (typeof data.topic !== "string" ||
          !data.topic.length ||
          [...data.topic].length > 64)
      )
        invalid("Use a topic of 1–64 characters or explicitly clear it.");
      if (
        data.decision !== undefined &&
        (typeof data.decision !== "string" || [...data.decision].length > 20000)
      )
        invalid(
          "Use a decision of at most 20000 characters or explicitly clear it.",
        );
      if (
        !Array.isArray(data.entryIds) ||
        data.entryIds.some((v: any) => typeof v !== "string") ||
        new Set(data.entryIds).size !== data.entryIds.length
      )
        invalid("Use unique entry links.");
      const entries = (
        await q("SELECT data FROM bible_entries WHERE library_id=$1", [
          book.library_id,
        ])
      ).rows.map((r) => r.data);
      for (const entryId of data.entryIds)
        if (!entries.some((e) => e.id === entryId))
          invalid("Choose an entry in this library.");
      for (const nodeId of [data.nodeId].filter((v) => v !== undefined)) {
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
          !questionVisible(data, n.data)
        )
          invalid("Choose a chapter or scene inside this question scope.");
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
      if (!parent || parent.deletedAt)
        invalid("Restore the question scope first.");
    }
    data.updatedAt = stamp(data.updatedAt);
    if (id) await q("UPDATE questions SET data=$2 WHERE id=$1", [id, data]);
    else
      await q("INSERT INTO questions(id,library_id,data) VALUES($1,$2,$3)", [
        data.id,
        book.library_id,
        data,
      ]);
    return data;
  });
}
export function questionVisible(question: any, book: any) {
  const s = question.scope;
  return s.kind === "book"
    ? s.id === book.id
    : s.kind === "universe"
      ? s.id === book.universeId
      : s.id === book.seriesId;
}
/** Caller holds the whole-library recovery locks and already persisted its backup. */
export async function unlinkQuestions(
  q: Query,
  libraryId: string,
  entries: string[],
  nodes: string[],
  bookId?: string,
) {
  const rows = (await q("SELECT id,library_id,data FROM questions")).rows;
  for (const row of rows) {
    const f = row.data;
    const hit =
      f.entryIds.some((id: string) => entries.includes(id)) ||
      nodes.includes(f.nodeId);
    const owned = bookId && f.scope.kind === "book" && f.scope.id === bookId;
    if (!hit && !owned) continue;
    if (row.library_id !== libraryId)
      invalid(
        "Unbacked question dependencies from another library prevent permanent deletion.",
      );
    if (owned) {
      await q("DELETE FROM questions WHERE id=$1", [f.id]);
      continue;
    }
    const data = {
      ...f,
      entryIds: f.entryIds.filter((id: string) => !entries.includes(id)),
      updatedAt: stamp(f.updatedAt),
    };
    if (nodes.includes(data.nodeId)) delete data.nodeId;
    await q("UPDATE questions SET data=$2 WHERE id=$1", [f.id, data]);
  }
}
