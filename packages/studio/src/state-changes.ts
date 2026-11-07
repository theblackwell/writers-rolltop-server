// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { StudioError } from "./store.ts";
import type { Database, Query } from "./store.ts";
import { eventVisible } from "./events.ts";
import { scopeAllowsTarget } from "./scope-values.ts";
import { stateValueError, inScope, eventInStory } from "./state-values.ts";
const invalid = (message: string): never => {
  throw new StudioError(400, "INVALID_INPUT", message);
};
const stamp = (old?: string) =>
  new Date(Math.max(Date.now(), Date.parse(old ?? "") + 1 || 0)).toISOString();
export async function migrateStateChanges(q: Query) {
  await q(`ALTER TABLE bible_fields ADD CONSTRAINT state_fields_library_identity UNIQUE(id,library_id);
 ALTER TABLE continuity_events ADD CONSTRAINT state_events_library_identity UNIQUE(id,library_id);
 CREATE TABLE state_changes(id uuid PRIMARY KEY,library_id uuid NOT NULL REFERENCES libraries(id),data jsonb NOT NULL,
 entry_id uuid GENERATED ALWAYS AS ((data->>'entryId')::uuid) STORED,
 field_id uuid GENERATED ALWAYS AS ((data->>'fieldId')::uuid) STORED,
 event_id uuid GENERATED ALWAYS AS ((data->>'eventId')::uuid) STORED,
 node_id uuid GENERATED ALWAYS AS ((data->>'nodeId')::uuid) STORED REFERENCES manuscript_nodes(id),
 FOREIGN KEY(entry_id,library_id) REFERENCES bible_entries(id,library_id),
 FOREIGN KEY(field_id,library_id) REFERENCES bible_fields(id,library_id),
 FOREIGN KEY(event_id,library_id) REFERENCES continuity_events(id,library_id),
 CHECK ((data ?& ARRAY['id','entryId','fieldId','value','createdAt','updatedAt'] AND (data->>'id')::uuid=id
 AND entry_id IS NOT NULL AND field_id IS NOT NULL AND ((event_id IS NULL) <> (node_id IS NULL))
 AND jsonb_typeof(data->'value') IN ('string','number','boolean','array','object')) IS TRUE));
 CREATE INDEX state_changes_by_library ON state_changes(library_id);
 UPDATE studio_schema SET version=11`);
}
/** Saved state catalog and choices; a single book→library lock gives a consistent view. */
export async function stateCatalog(db: Database, bookId: string) {
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
    if (row.data.deletedAt)
      invalid("Restore the book before opening Changing State.");
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
          "This library is too large for the state changes catalog. No records were omitted.",
        );
      return rows.map((r) => r.data);
    };
    const books = await read("books"),
      entries = await read("bible_entries"),
      events = await read("continuity_events");
    const fields = await read("bible_fields"),
      templates = await read("bible_templates"),
      changes = await read("state_changes");
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
        "This library has too many manuscript items for the state changes catalog. No records were omitted.",
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
      events,
      fields,
      templates,
      entries,
      stateChanges: changes.filter((c) =>
        entries.some((e) => e.id === c.entryId && eventVisible(e, row.data)),
      ),
      books: books.map((b) => ({
        id: b.id,
        title: b.title,
        orderKey: b.orderKey,
        universeId: b.universeId,
        seriesId: b.seriesId,
        deletedAt: b.deletedAt,
      })),
      nodes: allNodes.map((n) => ({
        ...n,
        inTrash:
          isTrashed(n) || !!books.find((b) => b.id === n.bookId)?.deletedAt,
      })),
    };
  });
}
export async function saveStateChange(
  db: Database,
  bookId: string,
  input: any,
  id?: string,
) {
  const allowed = [
    "entryId",
    "fieldId",
    "eventId",
    "nodeId",
    "value",
    "note",
    "expectedEntryUpdatedAt",
    "expectedFieldUpdatedAt",
    "editSharedCanon",
    ...(id ? ["expectedUpdatedAt", "deleted"] : []),
  ];
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((k) => !allowed.includes(k))
  )
    invalid("Provide only editable state change details.");
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
    if (row.data.deletedAt)
      invalid("Restore this book before editing state changes.");
    const old = id
      ? (
          await q(
            "SELECT data FROM state_changes WHERE id=$1 AND library_id=$2",
            [id, row.library_id],
          )
        ).rows[0]?.data
      : undefined;
    if (id && !old)
      throw new StudioError(
        404,
        "NOT_FOUND",
        "State change is not visible here.",
      );
    const entryId = old?.entryId ?? input.entryId;
    const entry = (
      await q(
        "SELECT data FROM bible_entries WHERE id::text=$1 AND library_id=$2",
        [typeof entryId === "string" ? entryId : "", row.library_id],
      )
    ).rows[0]?.data;
    if (!entry || !eventVisible(entry, row.data))
      throw new StudioError(404, "NOT_FOUND", "Entry is not visible here.");
    if (old && old.updatedAt !== input.expectedUpdatedAt)
      throw new StudioError(
        409,
        "STATE_CONFLICT",
        "This state change has changed. Keep your draft and reopen Changing State.",
      );
    if (entry.scope.kind !== "book" && input.editSharedCanon !== true)
      invalid(
        "Confirm this shared state change for all books in the entry's scope.",
      );
    const data = {
      ...(old ?? {
        id: randomUUID(),
        entryId,
        createdAt: stamp(),
        updatedAt: stamp(),
      }),
    };
    if (Object.hasOwn(input, "deleted")) {
      if (
        typeof input.deleted !== "boolean" ||
        Object.keys(input).some(
          (k) =>
            !["deleted", "expectedUpdatedAt", "editSharedCanon"].includes(k),
        )
      )
        invalid("Choose Trash or restore separately.");
      if (input.deleted) data.deletedAt = stamp(data.updatedAt);
      else delete data.deletedAt;
    } else {
      if (old?.deletedAt) invalid("Restore the change before editing it.");
      if (old && input.entryId !== undefined && input.entryId !== old.entryId)
        invalid("A change's entry cannot be changed.");
      for (const key of ["fieldId", "value"])
        if (Object.hasOwn(input, key)) data[key] = input[key];
      for (const key of ["eventId", "nodeId", "note"])
        if (Object.hasOwn(input, key)) {
          if (input[key] === null) delete data[key];
          else data[key] = input[key];
        }
    }
    // Trashing broken retained records stays possible; restore/edit must revalidate them.
    if (input.deleted !== true) {
      if (entry.deletedAt) invalid("Restore the entry first.");
      const field = (
        await q(
          "SELECT data FROM bible_fields WHERE id::text=$1 AND library_id=$2",
          [
            typeof data.fieldId === "string" ? data.fieldId : "",
            row.library_id,
          ],
        )
      ).rows[0]?.data;
      if (!field || field.deletedAt || field.templateId !== entry.templateId)
        invalid("Choose a live field of this entry's template.");
      const template = (
        await q(
          "SELECT data FROM bible_templates WHERE id=$1 AND library_id=$2",
          [field.templateId, row.library_id],
        )
      ).rows[0]?.data;
      if (!template || template.deletedAt)
        invalid("Restore the entry template first.");
      if (
        input.deleted !== false &&
        (input.expectedEntryUpdatedAt !== entry.updatedAt ||
          input.expectedFieldUpdatedAt !== field.updatedAt)
      )
        throw new StudioError(
          409,
          "STATE_DEFINITION_CONFLICT",
          "The entry or field changed. Keep your draft and reopen Changing State.",
        );
      if ((data.eventId === undefined) === (data.nodeId === undefined))
        invalid("Choose exactly one event or chapter/scene.");
      if (data.nodeId !== undefined) {
        const n = (
          await q(
            "SELECT n.data,b.data AS book,b.library_id FROM manuscript_nodes n JOIN books b ON b.id=n.book_id WHERE n.id::text=$1",
            [typeof data.nodeId === "string" ? data.nodeId : ""],
          )
        ).rows[0];
        if (
          !n ||
          n.library_id !== row.library_id ||
          !["chapter", "scene"].includes(n.data.kind) ||
          !inScope(entry.scope, n.book)
        )
          invalid("Choose a chapter or scene in the entry's scope.");
      } else {
        const event = (
          await q(
            "SELECT data FROM continuity_events WHERE id::text=$1 AND library_id=$2",
            [
              typeof data.eventId === "string" ? data.eventId : "",
              row.library_id,
            ],
          )
        ).rows[0]?.data;
        if (
          !event ||
          event.deletedAt ||
          !eventInStory(
            event,
            entry,
            (
              await q("SELECT data FROM books WHERE library_id=$1", [
                row.library_id,
              ])
            ).rows.map((r) => r.data),
          )
        )
          invalid("Choose a live event within this entry's story.");
      }
      if (data.note !== undefined && typeof data.note !== "string")
        invalid("Use plain text for the note.");
      const error = stateValueError(field, data.value);
      if (error) invalid(error);
      if (
        field.fieldType === "attachment" &&
        !(
          await q(
            "SELECT sha256 FROM library_attachments WHERE library_id=$1 AND sha256=$2",
            [row.library_id, data.value],
          )
        ).rows.length
      )
        invalid("Choose an attachment in this library.");
      if (["entryReference", "entryReferences"].includes(field.fieldType)) {
        const ids =
          field.fieldType === "entryReference" ? [data.value] : data.value;
        const targets = (
          await q("SELECT data FROM bible_entries WHERE library_id=$1", [
            row.library_id,
          ])
        ).rows.map((r) => r.data);
        const world =
          entry.scope.kind === "series"
            ? (await q("SELECT data FROM series WHERE id=$1", [entry.scope.id]))
                .rows[0]?.data.universeId
            : undefined;
        for (const targetId of ids) {
          const target = targets.find((e) => e.id === targetId && !e.deletedAt);
          if (
            !target ||
            !scopeAllowsTarget(entry, target, row.data, world) ||
            (field.targetEntryTypes &&
              !field.targetEntryTypes.includes(target.entryType))
          )
            invalid(
              "Choose live linked entries of allowed types within the entry's canonical scope.",
            );
        }
      }
    }
    data.updatedAt = stamp(data.updatedAt);
    if (id) await q("UPDATE state_changes SET data=$2 WHERE id=$1", [id, data]);
    else
      await q(
        "INSERT INTO state_changes(id,library_id,data) VALUES($1,$2,$3)",
        [data.id, row.library_id, data],
      );
    return data;
  });
}
/** Whole-library capture locks held and backup already verified by caller. */
export async function unlinkStateChanges(
  q: Query,
  libraryId: string,
  entries: string[],
  nodes: string[],
  events: string[] = [],
) {
  const rows = (await q("SELECT id,library_id,data FROM state_changes")).rows;
  const fields = (await q("SELECT id,data FROM bible_fields")).rows;
  for (const row of rows) {
    const c = row.data,
      field = fields.find((f) => f.id === c.fieldId)?.data;
    const single =
      field?.fieldType === "entryReference" && entries.includes(c.value);
    const multi =
      field?.fieldType === "entryReferences" &&
      Array.isArray(c.value) &&
      c.value.some((id: string) => entries.includes(id));
    const owned =
      entries.includes(c.entryId) ||
      nodes.includes(c.nodeId) ||
      events.includes(c.eventId);
    if (!owned && !single && !multi) continue;
    if (row.library_id !== libraryId)
      invalid(
        "Unbacked state changes from another library prevent permanent deletion.",
      );
    if (owned || single)
      await q("DELETE FROM state_changes WHERE id=$1", [c.id]);
    else
      await q("UPDATE state_changes SET data=$2 WHERE id=$1", [
        c.id,
        {
          ...c,
          value: c.value.filter((id: string) => !entries.includes(id)),
          updatedAt: stamp(c.updatedAt),
        },
      ]);
  }
}
