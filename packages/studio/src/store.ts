// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { decode } from "../../document-adapter/src/canonical.ts";
import type { CanonicalDocument } from "../../document-adapter/src/canonical.ts";

export type Query = (
  sql: string,
  params?: any[],
) => Promise<{ rows: any[]; rowCount?: number | null }>;
export type Database = {
  query: Query;
  transaction: <T>(fn: (query: Query) => Promise<T>) => Promise<T>;
};
export type RecordData = {
  id: string;
  title: string;
  orderKey?: string;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
};
export class StudioError extends Error {
  status: number;
  code: string;
  detail?: unknown;
  constructor(status: number, code: string, message: string, detail?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}
const fail = (message: string): never => {
  throw new StudioError(400, "INVALID_INPUT", message);
};
export function title(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 500)
    return fail("Use a title between 1 and 500 characters.");
  return value.trim();
}
function required(row: any) {
  if (!row)
    throw new StudioError(404, "NOT_FOUND", "That item no longer exists.");
  return row;
}
const blankDocument = (id: string): CanonicalDocument => ({
  schema: "writers-rolltop/document",
  version: 1,
  nodeId: id,
  blocks: [{ id: randomUUID(), type: "paragraph", content: [] }],
});
const record = (name: string, extra: object = {}): RecordData => {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    title: title(name),
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
};
const order = (n: number) => (n * 1024).toString(36).padStart(10, "0") + "1";

export class StudioStore {
  db: Database;
  constructor(db: Database) {
    this.db = db;
  }
  async migrate() {
    await this.db.transaction(async (q) => {
      // Startup runs on one API service in this slice. A table lock serializes migrations
      // when a second instance is accidentally started against the same database.
      await q(
        "CREATE TABLE IF NOT EXISTS studio_schema (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), version integer NOT NULL)",
      );
      await q("LOCK TABLE studio_schema IN EXCLUSIVE MODE");
      const { rows } = await q("SELECT version FROM studio_schema");
      if (rows[0]?.version > 1)
        throw new Error(
          "This database is newer than this server; update Writers Rolltop.",
        );
      if (rows.length) {
        if (rows[0].version !== 1)
          throw new Error("Unsupported database schema version.");
        return;
      }
      await q(`CREATE TABLE libraries (id uuid PRIMARY KEY, data jsonb NOT NULL);
        CREATE TABLE books (id uuid PRIMARY KEY, library_id uuid NOT NULL REFERENCES libraries(id), data jsonb NOT NULL);
        CREATE TABLE manuscript_nodes (id uuid PRIMARY KEY, book_id uuid NOT NULL REFERENCES books(id), parent_id uuid REFERENCES manuscript_nodes(id), kind text NOT NULL CHECK(kind IN ('part','chapter','scene','frontMatter','backMatter')), data jsonb NOT NULL);
        CREATE INDEX nodes_by_book ON manuscript_nodes(book_id);
        CREATE TABLE documents (node_id uuid PRIMARY KEY REFERENCES manuscript_nodes(id), revision integer NOT NULL CHECK(revision > 0), document jsonb NOT NULL, updated_at timestamptz NOT NULL);
        CREATE TABLE document_revisions (node_id uuid NOT NULL REFERENCES manuscript_nodes(id), revision integer NOT NULL, document jsonb NOT NULL, saved_at timestamptz NOT NULL, PRIMARY KEY(node_id,revision));
        CREATE TABLE studio_sessions (token_hash text PRIMARY KEY, expires_at timestamptz NOT NULL);
        INSERT INTO studio_schema(version) VALUES(1)`);
    });
  }
  async libraries() {
    return (
      await this.db.query(
        "SELECT data FROM libraries ORDER BY data->>'createdAt', id",
      )
    ).rows.map((r) => r.data);
  }
  async createLibrary(name: string) {
    const item = record(name);
    await this.db.query("INSERT INTO libraries VALUES($1,$2)", [item.id, item]);
    return item;
  }
  async library(id: string) {
    const item = required(
      (await this.db.query("SELECT data FROM libraries WHERE id=$1", [id]))
        .rows[0],
    ).data;
    const books = (
      await this.db.query(
        "SELECT data FROM books WHERE library_id=$1 ORDER BY data->>'orderKey', id",
        [id],
      )
    ).rows.map((r) => r.data);
    return { library: item, books };
  }
  async createBook(libraryId: string, name: string) {
    return this.db.transaction(async (q) => {
      required(
        (
          await q("SELECT id FROM libraries WHERE id=$1 FOR UPDATE", [
            libraryId,
          ])
        ).rows[0],
      );
      const n = (
        await q("SELECT count(*)::int AS n FROM books WHERE library_id=$1", [
          libraryId,
        ])
      ).rows[0].n;
      const book = record(name, { orderKey: order(n + 1) });
      await q("INSERT INTO books VALUES($1,$2,$3)", [book.id, libraryId, book]);
      return book;
    });
  }
  async book(id: string) {
    const book = required(
      (
        await this.db.query("SELECT data,library_id FROM books WHERE id=$1", [
          id,
        ])
      ).rows[0],
    );
    const nodes = (
      await this.db.query(
        "SELECT data FROM manuscript_nodes WHERE book_id=$1 ORDER BY data->>'orderKey', id",
        [id],
      )
    ).rows.map((r) => r.data);
    return { book: book.data, libraryId: book.library_id, nodes };
  }
  async createNode(
    bookId: string,
    name: string,
    kind: string,
    parentId?: string,
  ) {
    if (
      !["part", "chapter", "scene", "frontMatter", "backMatter"].includes(kind)
    )
      return fail("Choose a manuscript item type.");
    return this.db.transaction(async (q) => {
      required(
        (await q("SELECT id FROM books WHERE id=$1 FOR UPDATE", [bookId]))
          .rows[0],
      );
      const parent = parentId
        ? required(
            (
              await q("SELECT book_id,kind FROM manuscript_nodes WHERE id=$1", [
                parentId,
              ])
            ).rows[0],
          )
        : null;
      if (parent && parent.book_id !== bookId)
        return fail("The parent must be in the same book.");
      if (
        kind === "scene"
          ? parent?.kind !== "chapter"
          : kind === "chapter"
            ? parent !== null && parent.kind !== "part"
            : parent !== null
      )
        return fail(
          "Scenes belong to chapters; chapters belong to parts or the book.",
        );
      const n = (
        await q(
          "SELECT count(*)::int AS n FROM manuscript_nodes WHERE book_id=$1 AND parent_id IS NOT DISTINCT FROM $2::uuid",
          [bookId, parentId ?? null],
        )
      ).rows[0].n;
      const node = record(name, {
        bookId,
        kind,
        ...(parentId ? { parentId } : {}),
        orderKey: order(n + 1),
      });
      await q("INSERT INTO manuscript_nodes VALUES($1,$2,$3,$4,$5)", [
        node.id,
        bookId,
        parentId ?? null,
        kind,
        node,
      ]);
      if (["scene", "frontMatter", "backMatter"].includes(kind)) {
        const doc = blankDocument(node.id);
        await q("INSERT INTO documents VALUES($1,1,$2,$3)", [
          node.id,
          doc,
          node.createdAt,
        ]);
        await q("INSERT INTO document_revisions VALUES($1,1,$2,$3)", [
          node.id,
          doc,
          node.createdAt,
        ]);
      }
      return node;
    });
  }
  async document(nodeId: string) {
    const r = required(
      (
        await this.db.query(
          "SELECT document,revision,updated_at FROM documents WHERE node_id=$1",
          [nodeId],
        )
      ).rows[0],
    );
    return {
      document: r.document as CanonicalDocument,
      revision: r.revision as number,
      savedAt: r.updated_at,
    };
  }
  async save(nodeId: string, value: unknown, expectedRevision: unknown) {
    const document = decode(value);
    if (document.nodeId !== nodeId)
      return fail("The document belongs to a different scene.");
    if (
      !Number.isSafeInteger(expectedRevision) ||
      (expectedRevision as number) < 1
    )
      return fail("A saved revision is required.");
    return this.db.transaction(async (q) => {
      const current = required(
        (
          await q(
            "SELECT revision,document FROM documents WHERE node_id=$1 FOR UPDATE",
            [nodeId],
          )
        ).rows[0],
      );
      if (current.revision !== expectedRevision)
        throw new StudioError(
          409,
          "REVISION_CONFLICT",
          "A newer version exists. Your draft has been kept; review both versions.",
          { storedRevision: current.revision },
        );
      if (JSON.stringify(decode(current.document)) === JSON.stringify(document))
        return { revision: current.revision };
      const revision = current.revision + 1;
      const now = new Date().toISOString();
      await q(
        "UPDATE documents SET revision=$2,document=$3,updated_at=$4 WHERE node_id=$1",
        [nodeId, revision, document, now],
      );
      await q("INSERT INTO document_revisions VALUES($1,$2,$3,$4)", [
        nodeId,
        revision,
        document,
        now,
      ]);
      await q(
        "UPDATE manuscript_nodes SET data=jsonb_set(data,'{updatedAt}',to_jsonb($2::text)) WHERE id=$1",
        [nodeId, now],
      );
      return { revision };
    });
  }
  async revisions(nodeId: string) {
    await this.document(nodeId);
    return (
      await this.db.query(
        'SELECT revision,saved_at AS "savedAt" FROM document_revisions WHERE node_id=$1 ORDER BY revision DESC LIMIT 100',
        [nodeId],
      )
    ).rows;
  }
  async revision(nodeId: string, revision: number) {
    return required(
      (
        await this.db.query(
          "SELECT document,revision FROM document_revisions WHERE node_id=$1 AND revision=$2",
          [nodeId, revision],
        )
      ).rows[0],
    );
  }
}
