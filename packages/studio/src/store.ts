// SPDX-License-Identifier: AGPL-3.0-only
import { migrateFacts, unlinkFacts } from "./facts.ts";
import { migrateRelationships } from "./relationships.ts";
import { migrateScopes, visibleEntries } from "./scopes.ts";
import { scopeAllowsTarget } from "./scope-values.ts";
import { structuredTypes, structuredValueError } from "./structured-values.ts";
import { initializeTemplates } from "./templates.ts";
import { entryInput, editEntry } from "./entries.ts";
import { basename } from "node:path";
import { captureBook, writeBookBackup } from "./backup.ts";
import { wordCount } from "../../document-adapter/src/text.ts";
import { between } from "./order.ts";
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
  parentId?: string;
  kind?: string;
  bookId?: string;
  deletedAt?: string;
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

export class StudioStore {
  db: Database;
  backupDirectory?: string;
  constructor(db: Database, backupDirectory?: string) {
    this.db = db;
    this.backupDirectory = backupDirectory;
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
      if (rows[0]?.version > 8)
        throw new Error(
          "This database is newer than this server; update Writers Rolltop.",
        );
      if (rows.length) {
        if (![1, 2, 3, 4, 5, 6, 7, 8].includes(rows[0].version))
          throw new Error("Unsupported database schema version.");
        if (rows[0].version === 1) await this.migrateNotes(q);
        if (rows[0].version < 3) await this.migrateReferences(q);
        if (rows[0].version < 4) await this.migrateTemplates(q);
        if (rows[0].version < 5) await this.migrateWorlds(q);
        if (rows[0].version < 6) await migrateScopes(q);
        if (rows[0].version < 7) await migrateRelationships(q);
        if (rows[0].version < 8) await migrateFacts(q);
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
      await this.migrateNotes(q);
      await this.migrateReferences(q);
      await this.migrateTemplates(q);
      await this.migrateWorlds(q);
      await migrateScopes(q);
      await migrateRelationships(q);
      await migrateFacts(q);
    });
  }
  private async migrateNotes(q: Query) {
    await q(`CREATE TABLE notes (id uuid PRIMARY KEY, book_id uuid NOT NULL REFERENCES books(id), data jsonb NOT NULL);
      CREATE INDEX notes_by_book ON notes(book_id);
      UPDATE studio_schema SET version=2`);
  }
  private async migrateReferences(q: Query) {
    await q(`CREATE TABLE bible_entries (id uuid PRIMARY KEY, book_id uuid NOT NULL REFERENCES books(id), data jsonb NOT NULL);
      CREATE INDEX entries_by_book ON bible_entries(book_id);
      CREATE TABLE manuscript_references (id uuid PRIMARY KEY, node_id uuid NOT NULL REFERENCES manuscript_nodes(id), entry_id uuid NOT NULL REFERENCES bible_entries(id), data jsonb NOT NULL);
      CREATE INDEX references_by_node ON manuscript_references(node_id);
      UPDATE studio_schema SET version=3`);
  }
  private async migrateTemplates(q: Query) {
    await q(`CREATE TABLE bible_templates (
      id uuid PRIMARY KEY, library_id uuid NOT NULL REFERENCES libraries(id), data jsonb NOT NULL,
      UNIQUE(id,library_id),
      CHECK(data ?& ARRAY['id','name','entryType','builtIn','orderKey','createdAt','updatedAt']),
      CHECK(jsonb_typeof(data->'builtIn')='boolean'),
      CHECK(data->>'id'=id::text),
      CHECK(data->>'entryType' IN ('character','location','organization','object','event','plotline','worldRule','research','term')));
      CREATE INDEX templates_by_library ON bible_templates(library_id);
      CREATE UNIQUE INDEX live_builtin_template ON bible_templates(library_id,(data->>'entryType'))
        WHERE data->>'builtIn'='true' AND NOT (data ? 'deletedAt');
      CREATE TABLE bible_fields (
        id uuid PRIMARY KEY, library_id uuid NOT NULL, template_id uuid NOT NULL, data jsonb NOT NULL,
        FOREIGN KEY(template_id,library_id) REFERENCES bible_templates(id,library_id),
        CHECK(data ?& ARRAY['id','templateId','key','label','fieldType','required','orderKey','createdAt','updatedAt']),
        CHECK(jsonb_typeof(data->'required')='boolean'),
        CHECK((data->>'fieldType'='selection') = (data ? 'options')),
        CHECK(data->>'id'=id::text AND data->>'templateId'=template_id::text),
        CHECK(data->>'key' ~ '^[a-z][a-zA-Z0-9_]{0,63}$'),
        CHECK(data->>'fieldType' IN ('shortText','longText','integer','decimal','boolean','selection','realDate','fictionalDate','entryReference','entryReferences','attachment','table')));
      CREATE INDEX fields_by_library ON bible_fields(library_id);
      CREATE UNIQUE INDEX fields_by_key ON bible_fields(template_id,(data->>'key'));
      UPDATE studio_schema SET version=4`);
    for (const library of (await q("SELECT id FROM libraries ORDER BY id"))
      .rows)
      await initializeTemplates(q, library.id);
  }
  private async migrateWorlds(q: Query) {
    await q(`CREATE TABLE universes (
      id uuid PRIMARY KEY, library_id uuid NOT NULL REFERENCES libraries(id), data jsonb NOT NULL,
      UNIQUE(id,library_id),
      CHECK(data ?& ARRAY['id','title','orderKey','createdAt','updatedAt']),
      CHECK(data->>'id'=id::text));
      CREATE TABLE series (
      id uuid PRIMARY KEY, library_id uuid NOT NULL REFERENCES libraries(id), data jsonb NOT NULL,
      universe_id uuid GENERATED ALWAYS AS ((data->>'universeId')::uuid) STORED,
      UNIQUE(id,library_id),
      FOREIGN KEY(universe_id,library_id) REFERENCES universes(id,library_id),
      CHECK(data ?& ARRAY['id','title','orderKey','createdAt','updatedAt']),
      CHECK(data->>'id'=id::text));
      ALTER TABLE books ADD COLUMN universe_id uuid GENERATED ALWAYS AS ((data->>'universeId')::uuid) STORED;
      ALTER TABLE books ADD COLUMN series_id uuid GENERATED ALWAYS AS ((data->>'seriesId')::uuid) STORED;
      ALTER TABLE books ADD FOREIGN KEY(universe_id,library_id) REFERENCES universes(id,library_id);
      ALTER TABLE books ADD FOREIGN KEY(series_id,library_id) REFERENCES series(id,library_id);
      CREATE INDEX universes_by_library ON universes(library_id);
      CREATE INDEX series_by_library ON series(library_id);
      CREATE INDEX books_by_universe ON books(universe_id);
      CREATE INDEX books_by_series ON books(series_id);
      CREATE FUNCTION check_book_series_world() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE world uuid;
      BEGIN
        IF NEW.data->>'seriesId' IS NOT NULL THEN
          SELECT universe_id INTO world FROM series WHERE id=(NEW.data->>'seriesId')::uuid FOR SHARE;
          IF world IS NOT NULL AND world IS DISTINCT FROM (NEW.data->>'universeId')::uuid THEN
            RAISE EXCEPTION 'Book world must match its series world';
          END IF;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER book_series_world BEFORE INSERT OR UPDATE ON books
        FOR EACH ROW EXECUTE FUNCTION check_book_series_world();
      CREATE FUNCTION keep_series_world() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.data->>'universeId' IS DISTINCT FROM NEW.data->>'universeId' THEN
          RAISE EXCEPTION 'Series world is immutable; create a new series to move books';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER series_world BEFORE UPDATE ON series
        FOR EACH ROW EXECUTE FUNCTION keep_series_world();
      UPDATE studio_schema SET version=5`);
  }
  async templates(libraryId: string) {
    required(
      (await this.db.query("SELECT id FROM libraries WHERE id=$1", [libraryId]))
        .rows[0],
    );
    return this.db.transaction(async (q) => {
      // A consistent pair, also serialized with future template writes/initialization.
      await q("SELECT id FROM libraries WHERE id=$1 FOR UPDATE", [libraryId]);
      const templates = (
        await q(
          "SELECT data FROM bible_templates WHERE library_id=$1 ORDER BY (data->>'orderKey') COLLATE \"C\", id",
          [libraryId],
        )
      ).rows.map((r) => r.data);
      const fields = (
        await q(
          "SELECT data FROM bible_fields WHERE library_id=$1 ORDER BY template_id,(data->>'orderKey') COLLATE \"C\", id",
          [libraryId],
        )
      ).rows.map((r) => r.data);
      return { templates, fields };
    });
  }
  async entries(bookId: string) {
    required(
      (await this.db.query("SELECT id FROM books WHERE id=$1", [bookId]))
        .rows[0],
    );
    return visibleEntries(this.db.query, bookId);
  }

  private async visibleEntry(
    q: Query,
    ctx: { book: RecordData; libraryId: string },
    id: string,
  ) {
    const entry = required(
      (await visibleEntries(q, ctx.book.id)).find((e) => e.id === id),
    );
    if (entry.scope.kind !== "book") {
      const table = entry.scope.kind === "universe" ? "universes" : "series";
      const parent = (
        await q(`SELECT data FROM ${table} WHERE id=$1 AND library_id=$2`, [
          entry.scope.id,
          ctx.libraryId,
        ])
      ).rows[0]?.data;
      if (!parent || parent.deletedAt)
        return fail("Restore the shared scope before editing its entries.");
    }
    return entry;
  }
  private sharedConfirmation(entry: any, input: any) {
    if (entry.scope.kind !== "book" && input.editSharedCanon !== true)
      return fail("Confirm editing shared canon for every book in this scope.");
  }
  async createEntry(bookId: string, input: any) {
    entryInput(input);
    const name = title(input.name);
    return this.db.transaction(async (q) => {
      const ctx = await this.bookContext(q, bookId);
      if (ctx.book.deletedAt)
        return fail("Restore the book before adding entries.");
      await q("SELECT id FROM libraries WHERE id=$1 FOR UPDATE", [
        ctx.libraryId,
      ]);
      const kind = input.scopeKind ?? "book";
      const scopeId =
        kind === "book"
          ? bookId
          : kind === "universe"
            ? ctx.book.universeId
            : ctx.book.seriesId;
      if (!scopeId)
        return fail(
          "Join a world or series before creating entries in that scope.",
        );
      if (kind !== "book") {
        const parent = (
          await q(
            `SELECT data FROM ${kind === "universe" ? "universes" : "series"} WHERE id=$1 AND library_id=$2`,
            [scopeId, ctx.libraryId],
          )
        ).rows[0]?.data;
        if (!parent || parent.deletedAt)
          return fail("Choose a live scope in this library.");
      }
      const now = new Date().toISOString();
      const entry = editEntry(
        {
          id: randomUUID(),
          entryType: input.entryType,
          name,
          summary: input.summary ?? "",
          aliases: [],
          scope: { kind, id: scopeId },
          values: {},
          overrides: [],
          attachments: [],
          createdAt: now,
          updatedAt: now,
        },
        input,
      );
      await q(
        "INSERT INTO bible_entries(id,book_id,data,library_id) VALUES($1,$2,$3,$4)",
        [entry.id, kind === "book" ? bookId : null, entry, ctx.libraryId],
      );
      return entry;
    });
  }
  async updateEntry(bookId: string, id: string, input: any) {
    entryInput(input, true);
    return this.db.transaction(async (q) => {
      const ctx = await this.bookContext(q, bookId);
      if (ctx.book.deletedAt)
        return fail("Restore the book before editing its bible.");
      await q("SELECT id FROM libraries WHERE id=$1 FOR UPDATE", [
        ctx.libraryId,
      ]);
      const old = await this.visibleEntry(q, ctx, id);
      this.sharedConfirmation(old, input);
      if (input.expectedUpdatedAt !== old.updatedAt)
        throw new StudioError(
          409,
          "ENTRY_CONFLICT",
          "This entry changed. Your form is kept. Close and reopen Bible Entries to review the latest version.",
        );
      if (old.deletedAt && input.deleted !== false)
        return fail("Restore the entry before editing it.");
      const entry = editEntry(old, input);
      const now = new Date(
        Math.max(Date.now(), Date.parse(old.updatedAt) + 1),
      ).toISOString();
      entry.updatedAt = now;
      if (input.deleted === true) entry.deletedAt = now;
      if (input.deleted === false) delete entry.deletedAt;
      await q(
        "UPDATE bible_entries SET data=$3 WHERE id=$1 AND library_id=$2",
        [id, ctx.libraryId, entry],
      );
      return entry;
    });
  }
  async editEntryField(
    bookId: string,
    id: string,
    input: any,
    fieldId?: string,
  ) {
    const allowed = fieldId
      ? [
          "value",
          "expectedUpdatedAt",
          "expectedFieldUpdatedAt",
          "mode",
          "editSharedCanon",
        ]
      : [
          "templateId",
          "expectedUpdatedAt",
          "expectedTemplateUpdatedAt",
          "editSharedCanon",
        ];
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some((k) => !allowed.includes(k)) ||
      typeof input.expectedUpdatedAt !== "string" ||
      !(fieldId
        ? Object.hasOwn(input, "value")
        : Object.hasOwn(input, "templateId"))
    )
      return fail(
        "Provide the field value or template and the current saved version.",
      );
    if (input.mode !== undefined && !["canon", "book"].includes(input.mode))
      return fail("Choose canon or this-book values.");
    if (
      input.editSharedCanon !== undefined &&
      typeof input.editSharedCanon !== "boolean"
    )
      return fail("Confirm shared canon explicitly.");
    return this.db.transaction(async (q) => {
      const ctx = await this.bookContext(q, bookId);
      if (ctx.book.deletedAt)
        return fail("Restore the book before editing its bible.");
      // Lock order matches recovery: book, then library. Template writes must use the library lock.
      await q("SELECT id FROM libraries WHERE id=$1 FOR UPDATE", [
        ctx.libraryId,
      ]);
      const old = await this.visibleEntry(q, ctx, id);
      const override = fieldId && input.mode === "book";
      if (override && old.scope.kind === "book")
        return fail("Book-specific overrides apply only to shared entries.");
      if (!override) this.sharedConfirmation(old, input);
      if (input.expectedUpdatedAt !== old.updatedAt)
        throw new StudioError(
          409,
          "ENTRY_CONFLICT",
          "This entry changed. Your form is kept. Close and reopen Bible Entries to review the latest version.",
        );
      if (old.deletedAt) return fail("Restore the entry before editing it.");
      const templateId = fieldId ? old.templateId : input.templateId;
      let template: any;
      if (templateId != null) {
        if (typeof templateId !== "string")
          return fail("Choose a compatible template.");
        template = (
          await q(
            "SELECT data FROM bible_templates WHERE id::text=$1 AND library_id=$2",
            [templateId, ctx.libraryId],
          )
        ).rows[0]?.data;
        if (
          !template ||
          template.deletedAt ||
          template.entryType !== old.entryType
        )
          return fail(
            "Choose a live template of the same entry type in this library.",
          );
      }
      const entry = { ...old };
      if (!fieldId) {
        if (template && input.expectedTemplateUpdatedAt !== template.updatedAt)
          throw new StudioError(
            409,
            "TEMPLATE_CONFLICT",
            "This template changed. Reopen Bible Entries before choosing it.",
          );
        if (
          (old.templateId ?? null) !== templateId &&
          (Object.keys(old.values ?? {}).length || (old.overrides ?? []).length)
        )
          return fail(
            "This entry has saved values or overrides. Keep its template to preserve them.",
          );
        if (templateId == null) delete entry.templateId;
        else entry.templateId = templateId;
      } else {
        if (!template) return fail("Assign a template before editing fields.");
        const field = (
          await q(
            "SELECT data FROM bible_fields WHERE id::text=$1 AND template_id=$2 AND library_id=$3",
            [fieldId, template.id, ctx.libraryId],
          )
        ).rows[0]?.data;
        if (!field || field.deletedAt)
          return fail("Choose a live field of this entry's template.");
        if (input.expectedFieldUpdatedAt !== field.updatedAt)
          throw new StudioError(
            409,
            "FIELD_CONFLICT",
            "This field changed. Your form is kept. Reopen Bible Entries to review its definition.",
          );
        const value = input.value;
        if (
          ![
            "shortText",
            "longText",
            "integer",
            "decimal",
            "boolean",
            ...structuredTypes,
            "entryReference",
            "entryReferences",
          ].includes(field.fieldType)
        )
          return fail("This field type is not supported yet.");
        if (
          value !== null &&
          ["entryReference", "entryReferences"].includes(field.fieldType)
        ) {
          const ids = field.fieldType === "entryReference" ? [value] : value;
          if (
            !Array.isArray(ids) ||
            ids.some((v) => typeof v !== "string") ||
            new Set(ids).size !== ids.length
          )
            return fail("Choose unique entries in this book.");
          const targets = await visibleEntries(q, bookId, true);
          const seriesWorld =
            old.scope.kind === "series"
              ? (await q("SELECT data FROM series WHERE id=$1", [old.scope.id]))
                  .rows[0]?.data.universeId
              : undefined;
          const owner = override
            ? { scope: { kind: "book", id: bookId } }
            : old;
          for (const id of ids) {
            const target = targets.find((t) => t.id === id && !t.deletedAt);
            if (
              !target ||
              !scopeAllowsTarget(owner, target, ctx.book, seriesWorld) ||
              (field.targetEntryTypes &&
                !field.targetEntryTypes.includes(target.entryType))
            )
              return fail(
                "Choose live entries of the allowed types in this book.",
              );
          }
        }
        const structuredError = structuredValueError(field, value);
        if (structuredError) return fail(structuredError);
        if (value !== null) {
          if (
            ["shortText", "longText"].includes(field.fieldType) &&
            (typeof value !== "string" || value.length > 20000)
          )
            return fail("Use text of at most 20,000 characters.");
          if (field.fieldType === "integer" && !Number.isSafeInteger(value))
            return fail("Use an integer within ±(2^53−1).");
          if (
            field.fieldType === "decimal" &&
            (typeof value !== "string" ||
              value.length > 1000 ||
              !/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$(?![\s\S])/.test(value))
          )
            return fail(
              "Use an exact decimal such as 12.50, without exponent notation.",
            );
          if (field.fieldType === "boolean" && typeof value !== "boolean")
            return fail("Choose true or false.");
        }
        const previousOverride = (old.overrides ?? []).find(
          (o: any) => o.bookId === bookId,
        );
        const values = {
          ...((override ? previousOverride?.values : old.values) ?? {}),
        };
        if (value === null) delete values[fieldId];
        else values[fieldId] = value;
        if (override) {
          entry.overrides = [...(old.overrides ?? [])];
          const index = entry.overrides.findIndex(
            (o: any) => o.bookId === bookId,
          );
          const next = { ...(previousOverride ?? { bookId }), values };
          if (
            !Object.keys(values).length &&
            Object.keys(next).every((k) => ["bookId", "values"].includes(k))
          ) {
            if (index >= 0) entry.overrides.splice(index, 1);
          } else if (index >= 0) entry.overrides[index] = next;
          else entry.overrides.push(next);
        } else entry.values = values;
      }
      entry.updatedAt = new Date(
        Math.max(Date.now(), Date.parse(old.updatedAt) + 1),
      ).toISOString();
      await q(
        "UPDATE bible_entries SET data=$3 WHERE id=$1 AND library_id=$2",
        [id, ctx.libraryId, entry],
      );
      return entry;
    });
  }
  async references(nodeId: string) {
    required(
      (
        await this.db.query("SELECT id FROM manuscript_nodes WHERE id=$1", [
          nodeId,
        ])
      ).rows[0],
    );
    return (
      await this.db.query(
        "SELECT data FROM manuscript_references WHERE node_id=$1 ORDER BY data->>'createdAt', id",
        [nodeId],
      )
    ).rows.map((r) => r.data);
  }
  async saveReference(nodeId: string, input: any, id?: string) {
    const allowed = id
      ? ["deleted", "expectedUpdatedAt"]
      : ["entryId", "anchorId", "expectedRevision"];
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some((k) => !allowed.includes(k))
    )
      return fail("Provide valid reference details.");
    return this.db.transaction(async (q) => {
      const ctx = await this.nodeContext(q, nodeId);
      await q("SELECT id FROM libraries WHERE id=$1 FOR UPDATE", [
        ctx.libraryId,
      ]);
      if (!this.isLive(ctx, nodeId))
        return fail("Restore the manuscript item before editing references.");
      const doc = required(
        (
          await q("SELECT document,revision FROM documents WHERE node_id=$1", [
            nodeId,
          ])
        ).rows[0],
      );
      let reference: any;
      if (id) {
        reference = {
          ...required(
            (
              await q(
                "SELECT data FROM manuscript_references WHERE id=$1 AND node_id=$2",
                [id, nodeId],
              )
            ).rows[0],
          ).data,
        };
        if (reference.updatedAt !== input.expectedUpdatedAt)
          throw new StudioError(
            409,
            "REFERENCE_CONFLICT",
            "This reference changed. Reopen References.",
          );
        if (typeof input.deleted !== "boolean")
          return fail("Choose Trash or restore.");
      } else {
        if (
          !Number.isSafeInteger(input.expectedRevision) ||
          input.expectedRevision !== doc.revision
        )
          throw new StudioError(
            409,
            "REVISION_CONFLICT",
            "The passage changed. Reopen References after saving.",
          );
        if (
          typeof input.entryId !== "string" ||
          typeof input.anchorId !== "string"
        )
          return fail("Choose a saved passage and bible entry.");
        // Compare text identifiers first so malformed identifiers never reach UUID casts.
        const target = (await visibleEntries(q, ctx.book.id, true)).find(
          (e) => e.id === input.entryId && !e.deletedAt,
        );
        if (!target)
          return fail("Choose a live bible entry visible in this book.");
        const now = new Date().toISOString();
        reference = {
          id: randomUUID(),
          nodeId,
          entryId: input.entryId,
          anchorId: input.anchorId,
          createdAt: now,
          updatedAt: now,
        };
      }
      if (!id || input.deleted === false) {
        const hasAnchor = doc.document.blocks.some((b: any) =>
          b.content?.some((run: any) =>
            run.marks?.some(
              (m: any) => m.type === "anchor" && m.id === reference.anchorId,
            ),
          ),
        );
        if (!hasAnchor)
          return fail(
            "The passage anchor must be saved in this document first.",
          );
        const target = (await visibleEntries(q, ctx.book.id, true)).find(
          (e) => e.id === reference.entryId && !e.deletedAt,
        );
        if (!target)
          return fail("Restore the bible entry and its visible scope first.");
        const duplicate = (
          await q("SELECT data FROM manuscript_references WHERE node_id=$1", [
            nodeId,
          ])
        ).rows.some(
          (r) =>
            r.data.id !== id &&
            !r.data.deletedAt &&
            r.data.anchorId === reference.anchorId &&
            r.data.entryId === reference.entryId,
        );
        if (duplicate)
          return fail("This passage already refers to that entry.");
      }
      if (id) {
        const now = new Date(
          Math.max(Date.now(), Date.parse(reference.updatedAt) + 1),
        ).toISOString();
        reference.updatedAt = now;
        if (input.deleted) reference.deletedAt = now;
        else delete reference.deletedAt;
        await q("UPDATE manuscript_references SET data=$2 WHERE id=$1", [
          id,
          reference,
        ]);
      } else
        await q("INSERT INTO manuscript_references VALUES($1,$2,$3,$4)", [
          reference.id,
          nodeId,
          reference.entryId,
          reference,
        ]);
      return reference;
    });
  }
  async notes(bookId: string) {
    required(
      (await this.db.query("SELECT id FROM books WHERE id=$1", [bookId]))
        .rows[0],
    );
    return (
      await this.db.query(
        `SELECT data FROM notes WHERE book_id=$1 ORDER BY (data->>'orderKey') COLLATE "C", id`,
        [bookId],
      )
    ).rows.map((r) => r.data);
  }
  async saveNote(bookId: string, input: any, id?: string) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      return fail("Provide note details.");
    const allowed = id
      ? ["text", "nodeId", "deleted", "expectedUpdatedAt"]
      : ["text", "nodeId"];
    if (Object.keys(input).some((k) => !allowed.includes(k)))
      return fail("Unknown note field.");
    if (
      input.text !== undefined &&
      (typeof input.text !== "string" ||
        !input.text.trim() ||
        input.text.length > 20000)
    )
      return fail("Use note text between 1 and 20,000 characters.");
    if (input.deleted !== undefined && typeof input.deleted !== "boolean")
      return fail("Choose Trash or restore.");
    return this.db.transaction(async (q) => {
      const ctx = await this.bookContext(q, bookId);
      if (ctx.book.deletedAt)
        return fail("Restore the book before editing notes.");
      const all = (
        await q("SELECT data FROM notes WHERE book_id=$1", [bookId])
      ).rows.map((r) => r.data);
      const old = id ? required(all.find((n) => n.id === id)) : undefined;
      if (old && input.expectedUpdatedAt !== old.updatedAt)
        throw new StudioError(
          409,
          "NOTE_CONFLICT",
          "This note changed. Reopen Quick Notes before editing it.",
        );
      if (!old && input.text === undefined) return fail("Enter note text.");
      if (old?.deletedAt && input.deleted !== false)
        return fail("Restore the note before editing it.");
      const nodeId = input.nodeId === undefined ? old?.nodeId : input.nodeId;
      if (
        nodeId != null &&
        (typeof nodeId !== "string" || !ctx.nodes.some((n) => n.id === nodeId))
      )
        return fail("Pin the note within this book.");
      const now = new Date(
        Math.max(Date.now(), old ? Date.parse(old.updatedAt) + 1 : 0),
      ).toISOString();
      const note = {
        ...(old ?? { id: randomUUID(), bookId, createdAt: now }),
        updatedAt: now,
      };
      if (input.text !== undefined) note.text = input.text.trim();
      if (nodeId == null) delete note.nodeId;
      else note.nodeId = nodeId;
      if (!old || old.nodeId !== nodeId) {
        const peers = all
          .filter(
            (n) => n.id !== id && !n.deletedAt && n.nodeId === note.nodeId,
          )
          .map((n) => n.orderKey)
          .sort();
        note.orderKey = between(peers.at(-1), undefined);
      }
      if (input.deleted === true) note.deletedAt = now;
      if (input.deleted === false) delete note.deletedAt;
      if (old) await q("UPDATE notes SET data=$2 WHERE id=$1", [id, note]);
      else
        await q("INSERT INTO notes VALUES($1,$2,$3)", [note.id, bookId, note]);
      return note;
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
    await this.db.transaction(async (q) => {
      await q("INSERT INTO libraries VALUES($1,$2)", [item.id, item]);
      await initializeTemplates(q, item.id);
    });
    return item;
  }
  async library(id: string) {
    const item = required(
      (await this.db.query("SELECT data FROM libraries WHERE id=$1", [id]))
        .rows[0],
    ).data;
    const books = (
      await this.db.query(
        "SELECT data FROM books WHERE library_id=$1 ORDER BY (data->>'orderKey') COLLATE \"C\", id",
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
      const peers = (
        await q(
          "SELECT data FROM books WHERE library_id=$1 ORDER BY (data->>'orderKey') COLLATE \"C\", id",
          [libraryId],
        )
      ).rows;
      const book = record(name, {
        orderKey: between(peers.at(-1)?.data.orderKey, undefined),
      });
      await q("INSERT INTO books(id,library_id,data) VALUES($1,$2,$3)", [
        book.id,
        libraryId,
        book,
      ]);
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
        "SELECT data FROM manuscript_nodes WHERE book_id=$1 ORDER BY (data->>'orderKey') COLLATE \"C\", id",
        [id],
      )
    ).rows.map((r) => r.data);
    return { book: book.data, libraryId: book.library_id, nodes };
  }
  async progress(bookId: string) {
    return this.db.transaction(async (q) => {
      const ctx = await this.bookContext(q, bookId);
      const counts: Record<string, number> = Object.fromEntries(
        ctx.nodes.filter((n) => this.isLive(ctx, n.id)).map((n) => [n.id, 0]),
      );
      const nodes = new Map(ctx.nodes.map((n) => [n.id, n]));
      const documents = (
        await q(
          "SELECT d.node_id,d.document FROM documents d JOIN manuscript_nodes n ON n.id=d.node_id WHERE n.book_id=$1",
          [bookId],
        )
      ).rows;
      let words = 0;
      for (const row of documents) {
        if (!this.isLive(ctx, row.node_id)) continue;
        const count = wordCount(row.document);
        words += count;
        let node = nodes.get(row.node_id);
        const seen = new Set<string>();
        while (node && !seen.has(node.id)) {
          seen.add(node.id);
          counts[node.id] += count;
          node = node.parentId ? nodes.get(node.parentId) : undefined;
        }
      }
      return { words, nodeWords: counts };
    });
  }
  /** Literal, case-insensitive search of saved manuscript prose in this book. */
  async search(bookId: string, input: unknown) {
    if (typeof input !== "string" || !input.trim() || input.length > 200)
      return fail("Enter between 1 and 200 characters to search.");
    const query = input.trim().toLowerCase();
    return this.db.transaction(async (q) => {
      const ctx = await this.bookContext(q, bookId);
      const documents = (
        await q(
          "SELECT d.node_id,d.document FROM documents d JOIN manuscript_nodes n ON n.id=d.node_id WHERE n.book_id=$1",
          [bookId],
        )
      ).rows;
      const byId = new Map(
        documents.map((r) => [r.node_id, r.document as CanonicalDocument]),
      );
      const results: { nodeId: string; title: string; snippet: string }[] = [];
      let truncated = false;
      const visit = (parentId?: string) => {
        const peers = ctx.nodes
          .filter((n) => n.parentId === parentId)
          .sort((a, b) =>
            a.orderKey! < b.orderKey!
              ? -1
              : a.orderKey! > b.orderKey!
                ? 1
                : a.id.localeCompare(b.id),
          );
        for (const node of peers) {
          if (!this.isLive(ctx, node.id)) continue;
          const doc = byId.get(node.id);
          if (doc) {
            const text = doc.blocks
              .map((b) =>
                b.type === "sceneBreak"
                  ? "\n"
                  : b.content
                      .map((i) => (i.type === "text" ? i.text : "\n"))
                      .join(""),
              )
              .join("\n");
            const index = text.toLowerCase().indexOf(query);
            if (index >= 0 || node.title.toLowerCase().includes(query)) {
              if (results.length === 50) {
                truncated = true;
                return;
              }
              const start = Math.max(0, index - 60);
              const end = Math.min(text.length, index + query.length + 100);
              results.push({
                nodeId: node.id,
                title: node.title,
                snippet:
                  (start ? "…" : "") +
                  text.slice(start, end) +
                  (end < text.length ? "…" : ""),
              });
            }
          }
          visit(node.id);
          if (truncated) return;
        }
      };
      visit();
      return { results, truncated };
    });
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
      const book = required(
        (await q("SELECT data FROM books WHERE id=$1 FOR UPDATE", [bookId]))
          .rows[0],
      ).data;
      if (book.deletedAt)
        return fail("Restore the book before adding manuscript items.");
      const parent = parentId
        ? required(
            (
              await q(
                "SELECT book_id,kind,data FROM manuscript_nodes WHERE id=$1",
                [parentId],
              )
            ).rows[0],
          )
        : null;
      if (parent?.data.deletedAt)
        return fail("Restore the parent before adding manuscript items.");
      if (parent && parent.book_id !== bookId)
        return fail("The parent must be in the same book.");
      if (
        kind === "scene"
          ? parent?.kind !== "chapter"
          : kind === "chapter"
            ? parent != null && parent.kind !== "part"
            : parent !== null
      )
        return fail(
          "Scenes belong to chapters; chapters belong to parts or the book.",
        );
      const peers = (
        await q(
          "SELECT data FROM manuscript_nodes WHERE book_id=$1 AND parent_id IS NOT DISTINCT FROM $2::uuid ORDER BY (data->>'orderKey') COLLATE \"C\", id",
          [bookId, parentId ?? null],
        )
      ).rows;
      const node = record(name, {
        bookId,
        kind,
        ...(parentId ? { parentId } : {}),
        orderKey: between(peers.at(-1)?.data.orderKey, undefined),
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
  private async bookContext(q: Query, bookId: string) {
    const book = required(
      (
        await q("SELECT data,library_id FROM books WHERE id=$1 FOR UPDATE", [
          bookId,
        ])
      ).rows[0],
    );
    const rows = (
      await q("SELECT data FROM manuscript_nodes WHERE book_id=$1", [bookId])
    ).rows;
    return {
      book: book.data as RecordData,
      libraryId: book.library_id as string,
      nodes: rows.map((r) => r.data as RecordData),
    };
  }
  private async nodeContext(q: Query, nodeId: string) {
    const row = required(
      (await q("SELECT book_id FROM manuscript_nodes WHERE id=$1", [nodeId]))
        .rows[0],
    );
    return this.bookContext(q, row.book_id);
  }
  private isLive(
    ctx: { book: RecordData; nodes: RecordData[] },
    nodeId: string,
  ): boolean {
    if (ctx.book.deletedAt) return false;
    const seen = new Set<string>();
    let node = ctx.nodes.find((n) => n.id === nodeId);
    while (node) {
      if (node.deletedAt || seen.has(node.id)) return false;
      seen.add(node.id);
      if (!node.parentId) return true;
      node = ctx.nodes.find((n) => n.id === node!.parentId);
    }
    return false;
  }
  private async putNode(q: Query, node: RecordData) {
    await q("UPDATE manuscript_nodes SET parent_id=$2,data=$3 WHERE id=$1", [
      node.id,
      node.parentId ?? null,
      node,
    ]);
  }
  private deletionTime(ctx: { book: RecordData; nodes: RecordData[] }) {
    const used = new Set(
      [ctx.book, ...ctx.nodes].map((n) => n.deletedAt).filter(Boolean),
    );
    let now = new Date().toISOString();
    // Each trash action in a book has a unique timestamp, even in the same ms.
    while (used.has(now)) now = new Date(Date.parse(now) + 1).toISOString();
    return now;
  }
  async updateBookDetails(id: string, input: Record<string, unknown>) {
    const allowed = [
      "title",
      "subtitle",
      "authorName",
      "description",
      "language",
      "targetWordCount",
      "targetDate",
    ];
    if (Object.keys(input).some((key) => !allowed.includes(key)))
      return fail("Choose supported book details.");
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (key === "title") {
        patch[key] = title(value);
        continue;
      }
      if (value === null || value === "") {
        patch[key] = null;
        continue;
      }
      if (key === "targetWordCount") {
        if (!Number.isSafeInteger(value) || (value as number) < 1)
          return fail("Use a positive whole number for the word goal.");
      } else {
        if (typeof value !== "string" || value.length > 20000)
          return fail(
            "Book details must be text of at most 20,000 characters.",
          );
        if (
          key === "language" &&
          !/^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(value)
        )
          return fail("Use a language tag such as en or en-US.");
        if (
          key === "targetDate" &&
          (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
            !Number.isFinite(Date.parse(value)) ||
            new Date(value).toISOString().slice(0, 10) !== value)
        )
          return fail("Choose a valid target date.");
      }
      patch[key] = value;
    }
    return this.db.transaction(async (q) => {
      const ctx = await this.bookContext(q, id);
      if (ctx.book.deletedAt)
        return fail("Restore the book before editing its details.");
      const book: RecordData = {
        ...ctx.book,
        updatedAt: new Date().toISOString(),
      };
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete book[key];
        else book[key] = value;
      }
      await q("UPDATE books SET data=$2 WHERE id=$1", [id, book]);
      return book;
    });
  }
  async renameBook(id: string, name: string) {
    const newTitle = title(name);
    return this.db.transaction(async (q) => {
      const ctx = await this.bookContext(q, id);
      if (ctx.book.deletedAt)
        return fail("Restore the book before renaming it.");
      const book = {
        ...ctx.book,
        title: newTitle,
        updatedAt: new Date().toISOString(),
      };
      await q("UPDATE books SET data=$2 WHERE id=$1", [id, book]);
      return book;
    });
  }
  async renameNode(id: string, name: string) {
    const newTitle = title(name);
    return this.db.transaction(async (q) => {
      const ctx = await this.nodeContext(q, id);
      if (!this.isLive(ctx, id))
        return fail("Restore the item before renaming it.");
      const node = {
        ...ctx.nodes.find((n) => n.id === id)!,
        title: newTitle,
        updatedAt: new Date().toISOString(),
      };
      await this.putNode(q, node);
      return node;
    });
  }
  /** beforeId is the destination sibling to insert before; null means at end. */
  async moveNode(id: string, parentId: string | null, beforeId: string | null) {
    return this.db.transaction(async (q) => {
      const ctx = await this.nodeContext(q, id);
      if (!this.isLive(ctx, id))
        return fail("Restore the item before moving it.");
      const node = ctx.nodes.find((n) => n.id === id)!;
      const parent = parentId ? ctx.nodes.find((n) => n.id === parentId) : null;
      if (parentId && (!parent || !this.isLive(ctx, parentId)))
        return fail("Choose a live parent in the same book.");
      if (
        node.kind === "scene"
          ? parent?.kind !== "chapter"
          : node.kind === "chapter"
            ? parent != null && parent.kind !== "part"
            : parent !== null
      )
        return fail(
          "Scenes belong to chapters; chapters belong to parts or the book.",
        );
      if (parentId === id || beforeId === id)
        return fail("An item cannot be placed inside or before itself.");
      const peers = ctx.nodes
        .filter(
          (n) =>
            n.id !== id &&
            (n.parentId ?? null) === parentId &&
            this.isLive(ctx, n.id),
        )
        .sort((a, b) =>
          a.orderKey! < b.orderKey!
            ? -1
            : a.orderKey! > b.orderKey!
              ? 1
              : a.id < b.id
                ? -1
                : 1,
        );
      const index = beforeId
        ? peers.findIndex((n) => n.id === beforeId)
        : peers.length;
      if (index < 0)
        return fail("The position must be a live sibling in the destination.");
      const lower = peers[index - 1]?.orderKey;
      const upper = peers[index]?.orderKey;
      const now = new Date().toISOString();
      if (lower !== undefined && lower === upper) {
        // Imported libraries may contain tied keys. Repair this sibling sequence
        // only when a tie prevents insertion; all IDs and documents stay intact.
        peers.splice(index, 0, node);
        let previous: string | undefined;
        for (const peer of peers) {
          const key = between(previous, undefined);
          await this.putNode(q, {
            ...peer,
            ...(peer.id === id ? { parentId: parentId ?? undefined } : {}),
            orderKey: key,
            updatedAt: now,
          });
          previous = key;
        }
      } else {
        const moved = {
          ...node,
          parentId: parentId ?? undefined,
          orderKey: between(lower, upper),
          updatedAt: now,
        };
        await this.putNode(q, moved);
      }
      return { id };
    });
  }
  async purge(type: "book" | "node", id: string, input: any) {
    return this.db.transaction(async (q) => {
      const ctx =
        type === "book"
          ? await this.bookContext(q, id)
          : await this.nodeContext(q, id);
      const target =
        type === "book"
          ? ctx.book
          : required(ctx.nodes.find((n) => n.id === id));
      if (!target.deletedAt)
        return fail("Move this item to Trash before deleting it permanently.");
      if (
        !input ||
        input.confirmTitle !== target.title ||
        input.expectedDeletedAt !== target.deletedAt
      )
        throw new StudioError(
          409,
          "STALE_DELETE",
          "This item changed. Close the dialog and review Trash again.",
        );
      if (!this.backupDirectory)
        throw new StudioError(
          503,
          "BACKUP_UNAVAILABLE",
          "Permanent deletion needs configured recovery backup storage. Nothing was deleted.",
        );
      let snapshot;
      try {
        snapshot = await captureBook(q, ctx.book.id);
      } catch {
        throw new StudioError(
          503,
          "BACKUP_FAILED",
          "The library recovery snapshot could not be captured. Nothing was deleted. Finish other library edits and try again.",
        );
      }
      if (type === "book") {
        const doomedEntries = new Set(
          (
            await q("SELECT id FROM bible_entries WHERE book_id=$1", [id])
          ).rows.map((r) => r.id),
        );
        const externalPassages = (
          await q(
            `SELECT r.id FROM manuscript_references r
          JOIN bible_entries e ON e.id=r.entry_id JOIN manuscript_nodes n ON n.id=r.node_id
          JOIN books b ON b.id=n.book_id WHERE e.book_id=$1 AND b.library_id<>$2 LIMIT 1`,
            [id, ctx.libraryId],
          )
        ).rows;
        if (externalPassages.length)
          return fail(
            "This book has incoming passage links from another library. Resolve them before permanent deletion.",
          );
        const fields = (
          await q(
            "SELECT data FROM bible_fields WHERE data->>'fieldType' IN ('entryReference','entryReferences')",
          )
        ).rows.map((r) => r.data);
        for (const row of (
          await q(
            "SELECT data,library_id FROM bible_entries WHERE book_id IS DISTINCT FROM $1",
            [id],
          )
        ).rows) {
          for (const values of [
            row.data.values,
            ...(row.data.overrides ?? [])
              .filter(
                (o: any) => o.bookId !== id || row.library_id !== ctx.libraryId,
              )
              .map((o: any) => o.values),
          ])
            for (const field of fields) {
              const value = values?.[field.id];
              if (
                (field.fieldType === "entryReference" &&
                  doomedEntries.has(value)) ||
                (field.fieldType === "entryReferences" &&
                  Array.isArray(value) &&
                  value.some((v) => doomedEntries.has(v)))
              )
                return fail(
                  "This book has incoming links from another book. Resolve them before permanent deletion.",
                );
            }
        }
      }
      let path: string;
      try {
        path = await writeBookBackup(this.backupDirectory, snapshot);
      } catch {
        throw new StudioError(
          503,
          "BACKUP_FAILED",
          "The recovery backup could not be verified. Nothing was deleted. Check backup storage and try again.",
        );
      }
      const doomed = new Set(
        type === "book" ? ctx.nodes.map((n) => n.id) : [id],
      );
      let changed = true;
      while (changed) {
        changed = false;
        for (const n of ctx.nodes)
          if (n.parentId && doomed.has(n.parentId) && !doomed.has(n.id)) {
            doomed.add(n.id);
            changed = true;
          }
      }
      const ids = [...doomed];
      const purgedEntries =
        type === "book"
          ? (
              await q("SELECT id FROM bible_entries WHERE book_id=$1", [id])
            ).rows.map((r) => r.id)
          : [];
      await unlinkFacts(
        q,
        ctx.libraryId,
        purgedEntries,
        ids,
        type === "book" ? id : undefined,
      );
      await q(
        "DELETE FROM manuscript_references WHERE node_id=ANY($1::uuid[])",
        [ids],
      );
      if (type === "book") {
        await q(
          "DELETE FROM manuscript_references WHERE entry_id IN (SELECT id FROM bible_entries WHERE book_id=$1)",
          [ctx.book.id],
        );
        await q(
          `DELETE FROM relationships WHERE library_id=$1 AND (book_id=$2 OR from_entry_id IN (SELECT id FROM bible_entries WHERE book_id=$2) OR to_entry_id IN (SELECT id FROM bible_entries WHERE book_id=$2))`,
          [ctx.libraryId, ctx.book.id],
        );
        // Shared canon survives book deletion; only this book's overrides leave.
        for (const row of (
          await q(
            "SELECT id,data FROM bible_entries WHERE library_id=$1 AND book_id IS DISTINCT FROM $2",
            [ctx.libraryId, ctx.book.id],
          )
        ).rows) {
          if (
            !(row.data.overrides ?? []).some(
              (o: any) => o.bookId === ctx.book.id,
            )
          )
            continue;
          const data = {
            ...row.data,
            overrides: row.data.overrides.filter(
              (o: any) => o.bookId !== ctx.book.id,
            ),
            updatedAt: new Date(
              Math.max(Date.now(), Date.parse(row.data.updatedAt) + 1),
            ).toISOString(),
          };
          await q("UPDATE bible_entries SET data=$2 WHERE id=$1", [
            row.id,
            data,
          ]);
        }
        await q("DELETE FROM notes WHERE book_id=$1", [ctx.book.id]);
        await q("DELETE FROM bible_entries WHERE book_id=$1", [ctx.book.id]);
      } else {
        await q(
          "DELETE FROM notes WHERE book_id=$1 AND data->>'nodeId'=ANY($2::text[])",
          [ctx.book.id, ids],
        );
      }
      await q("DELETE FROM document_revisions WHERE node_id=ANY($1::uuid[])", [
        ids,
      ]);
      await q("DELETE FROM documents WHERE node_id=ANY($1::uuid[])", [ids]);
      await q("DELETE FROM manuscript_nodes WHERE id=ANY($1::uuid[])", [ids]);
      if (type === "book") await q("DELETE FROM books WHERE id=$1", [id]);
      return { backup: basename(path), deletedNodes: ids.length };
    });
  }
  async trashNode(id: string) {
    return this.db.transaction(async (q) => {
      const ctx = await this.nodeContext(q, id);
      if (!this.isLive(ctx, id)) return fail("That item is already in Trash.");
      const when = this.deletionTime(ctx);
      const subtree = new Set([id]);
      for (let changed = true; changed;) {
        changed = false;
        for (const n of ctx.nodes)
          if (
            n.parentId &&
            subtree.has(n.parentId as string) &&
            !subtree.has(n.id)
          ) {
            subtree.add(n.id);
            changed = true;
          }
      }
      for (const n of ctx.nodes)
        if (subtree.has(n.id) && !n.deletedAt)
          await this.putNode(q, { ...n, deletedAt: when, updatedAt: when });
      return { id };
    });
  }
  async restoreNode(id: string) {
    return this.db.transaction(async (q) => {
      const ctx = await this.nodeContext(q, id);
      const node = ctx.nodes.find((n) => n.id === id)!;
      if (!node.deletedAt) return fail("That item is not in Trash.");
      const batch = node.deletedAt;
      const restore = new Set([id]);
      for (let changed = true; changed;) {
        changed = false;
        for (const n of ctx.nodes)
          if (
            n.parentId &&
            restore.has(n.parentId as string) &&
            n.deletedAt === batch &&
            !restore.has(n.id)
          ) {
            restore.add(n.id);
            changed = true;
          }
      }
      let parent = node.parentId;
      const seen = new Set<string>();
      while (parent && !seen.has(parent as string)) {
        seen.add(parent as string);
        restore.add(parent as string);
        parent = ctx.nodes.find((n) => n.id === parent)?.parentId;
      }
      const now = new Date().toISOString();
      for (const n of ctx.nodes)
        if (restore.has(n.id) && n.deletedAt) {
          const updated = { ...n, updatedAt: now };
          delete updated.deletedAt;
          await this.putNode(q, updated);
        }
      if (ctx.book.deletedAt) {
        const book = { ...ctx.book, updatedAt: now };
        delete book.deletedAt;
        await q("UPDATE books SET data=$2 WHERE id=$1", [ctx.book.id, book]);
      }
      return { id };
    });
  }
  async trashBook(id: string) {
    return this.db.transaction(async (q) => {
      const ctx = await this.bookContext(q, id);
      if (ctx.book.deletedAt) return fail("That book is already in Trash.");
      const when = this.deletionTime(ctx);
      await q("UPDATE books SET data=$2 WHERE id=$1", [
        id,
        { ...ctx.book, deletedAt: when, updatedAt: when },
      ]);
      for (const n of ctx.nodes)
        if (!n.deletedAt)
          await this.putNode(q, { ...n, deletedAt: when, updatedAt: when });
      return { id };
    });
  }
  async restoreBook(id: string) {
    return this.db.transaction(async (q) => {
      const ctx = await this.bookContext(q, id);
      if (!ctx.book.deletedAt) return fail("That book is not in Trash.");
      const now = new Date().toISOString();
      const book = { ...ctx.book, updatedAt: now };
      delete book.deletedAt;
      await q("UPDATE books SET data=$2 WHERE id=$1", [id, book]);
      for (const n of ctx.nodes)
        if (n.deletedAt === ctx.book.deletedAt) {
          const updated = { ...n, updatedAt: now };
          delete updated.deletedAt;
          await this.putNode(q, updated);
        }
      return { id };
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
      const context = await this.nodeContext(q, nodeId);
      if (!this.isLive(context, nodeId))
        throw new StudioError(
          409,
          "ITEM_IN_TRASH",
          "This scene or its book is in Trash. Your draft is kept; restore it before saving.",
        );
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
