// SPDX-License-Identifier: AGPL-3.0-only
import { StudioError } from "./store.ts";
import type { Database, Query } from "./store.ts";
import { continuityWarnings } from "./continuity-values.ts";
import type { ContinuitySnapshot } from "./continuity-values.ts";
import { wordCount } from "../../document-adapter/src/text.ts";
/** One SQL statement gives all checker inputs one MVCC snapshot, including other books' saves. */
export async function readContinuitySnapshot(
  q: Query,
  bookId: string,
  knowledgeOnly = false,
): Promise<ContinuitySnapshot> {
  const book = (
    await q("SELECT data,library_id FROM books WHERE id=$1 FOR UPDATE", [
      bookId,
    ])
  ).rows[0];
  if (!book) throw new StudioError(404, "NOT_FOUND", "Book no longer exists.");
  await q("SELECT id FROM libraries WHERE id=$1 FOR UPDATE", [book.library_id]);
  if (book.data.deletedAt)
    throw new StudioError(
      400,
      "INVALID_INPUT",
      "Restore the book before checking continuity.",
    );
  const sources = knowledgeOnly
    ? ["books", "bible_entries", "facts"]
    : [
        "books",
        "bible_entries",
        "bible_fields",
        "facts",
        "questions",
        "continuity_events",
        "state_changes",
      ];
  const columns = sources.map(
    (table) =>
      `(SELECT coalesce(jsonb_agg(data),'[]'::jsonb) FROM (SELECT data FROM ${table} WHERE library_id=$1 LIMIT 10001) t) AS ${table}`,
  );
  columns.push(
    "(SELECT coalesce(jsonb_agg(data),'[]'::jsonb) FROM (SELECT n.data FROM manuscript_nodes n JOIN books b ON b.id=n.book_id WHERE b.library_id=$1 LIMIT 10001) t) AS nodes",
  );
  if (!knowledgeOnly)
    columns.push(
      "(SELECT coalesce(jsonb_agg(jsonb_build_object('nodeId',node_id,'document',document)),'[]'::jsonb) FROM (SELECT d.node_id,d.document FROM documents d JOIN manuscript_nodes n ON n.id=d.node_id JOIN books b ON b.id=n.book_id WHERE b.library_id=$1 LIMIT 10001) t) AS documents",
    );
  const row = (await q("SELECT " + columns.join(","), [book.library_id]))
    .rows[0];
  if (Object.values(row).some((rows: any) => rows.length > 10000))
    throw new StudioError(
      413,
      "CATALOG_TOO_LARGE",
      "This library is too large for continuity checks. No records were omitted.",
    );
  const snapshot: ContinuitySnapshot = {
    book: book.data,
    books: row.books,
    nodes: row.nodes,
    entries: row.bible_entries,
    fields: row.bible_fields ?? [],
    facts: row.facts,
    questions: row.questions ?? [],
    events: row.continuity_events ?? [],
    stateChanges: row.state_changes ?? [],
    wordNodes: (row.documents ?? [])
      .filter((d: any) => wordCount(d.document) > 0)
      .map((d: any) => d.nodeId),
  };
  return snapshot;
}

export async function continuityCatalog(db: Database, bookId: string) {
  return db.transaction(async (q) =>
    continuityResult(await readContinuitySnapshot(q, bookId)),
  );
}

export function continuityResult(snapshot: ContinuitySnapshot) {
  const all = continuityWarnings(snapshot);
  if (all.length > 10000)
    throw new StudioError(
      413,
      "CATALOG_TOO_LARGE",
      "There are too many continuity warnings to display. No warnings were omitted.",
    );
  const allSubjects = [
    ...snapshot.facts.map((f) => ["fact/" + f.id, f] as const),
    ...snapshot.questions.map((q) => ["question/" + q.id, q] as const),
    ...snapshot.events.map((e) => ["event/" + e.id, e] as const),
  ];
  const subjects = new Map(allSubjects);
  return {
    intentionalWarnings: all.filter((w) => !!w.dismissal),
    nodes: snapshot.nodes
      .filter((n) => ["chapter", "scene"].includes(n.kind))
      .map((n) => ({
        id: n.id,
        bookId: n.bookId,
        title:
          (snapshot.books.find((b) => b.id === n.bookId)?.title ??
            "Unavailable book") +
          " › " +
          n.title,
      })),
    warnings: all.filter((w) => !w.dismissal),
    intentionalCount: all.filter((w) => w.dismissal).length,
    checkedAt: new Date().toISOString(),
    // Only labels for the warnings returned; manuscript contents never leave this endpoint.
    subjects: all.map((w) => {
      const owner = subjects.get(w.subject.kind + "/" + w.subject.id)!;
      return {
        id: w.id,
        title: owner.text ?? owner.title,
        updatedAt: owner.updatedAt,
        shared: owner.scope.kind !== "book",
      };
    }),
  };
}
