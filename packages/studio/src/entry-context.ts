// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { StudioError } from "./store.ts";
import type { Database, Query } from "./store.ts";
import { visibleEntries } from "./scopes.ts";
import { familyRelations, sameFamilyName } from "./family-values.ts";
import { between } from "./order.ts";
const invalid = (message: string): never => {
  throw new StudioError(400, "INVALID_INPUT", message);
};
const required = (row: any) => {
  if (!row)
    throw new StudioError(
      404,
      "NOT_FOUND",
      "That entry is no longer visible in this book.",
    );
  return row;
};
async function context(
  q: Query,
  bookId: string,
  entryId: string,
  live = false,
) {
  const book = required(
    (
      await q("SELECT data,library_id FROM books WHERE id=$1 FOR UPDATE", [
        bookId,
      ])
    ).rows[0],
  );
  await q("SELECT id FROM libraries WHERE id=$1 FOR UPDATE", [book.library_id]);
  const entries = await visibleEntries(q, bookId, live),
    entry = required(entries.find((e) => e.id === entryId));
  return { book, entries, entry };
}
async function familyData(
  q: Query,
  ctx: Awaited<ReturnType<typeof context>>,
  bookId: string,
) {
  const types = (
    await q("SELECT data FROM relationship_types WHERE library_id=$1", [
      ctx.book.library_id,
    ])
  ).rows
    .map((r) => r.data)
    .filter((t) => !t.deletedAt);
  const relations = (
    await q(
      "SELECT data FROM relationships WHERE library_id=$1 AND (book_id IS NULL OR book_id=$2) AND NOT (data ? 'deletedAt')",
      [ctx.book.library_id, bookId],
    )
  ).rows.map((r) => r.data);
  return ctx.entries
    .filter((e) => e.id !== ctx.entry.id && sameFamilyName(ctx.entry, e))
    .map((entry) => {
      const labels = relations
        .filter(
          (r) =>
            (r.fromEntryId === ctx.entry.id && r.toEntryId === entry.id) ||
            (r.toEntryId === ctx.entry.id && r.fromEntryId === entry.id),
        )
        .flatMap((r) => {
          const t = types.find((t) => t.id === r.typeId);
          return t
            ? [r.fromEntryId === ctx.entry.id ? t.label : t.inverseLabel]
            : [];
        });
      return { entry, related: labels.length > 0, labels };
    })
    .sort((a, b) => a.entry.name.localeCompare(b.entry.name));
}
export async function familyMatches(
  db: Database,
  bookId: string,
  entryId: string,
) {
  return db.transaction(async (q) => {
    const ctx = await context(q, bookId, entryId, true);
    return { matches: await familyData(q, ctx, bookId) };
  });
}
export async function saveFamilyAnswer(
  db: Database,
  bookId: string,
  entryId: string,
  value: any,
) {
  const allowed = [
    "otherEntryId",
    "relation",
    "bookSpecific",
    "editSharedCanon",
    "expectedUpdatedAt",
    "expectedOtherUpdatedAt",
  ];
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !allowed.includes(k)) ||
    typeof value.otherEntryId !== "string" ||
    typeof value.relation !== "string" ||
    !Object.hasOwn(familyRelations, value.relation) ||
    typeof value.bookSpecific !== "boolean"
  )
    invalid("Choose a family answer and its book scope.");
  if (
    value.editSharedCanon !== undefined &&
    typeof value.editSharedCanon !== "boolean"
  )
    invalid("Confirm the shared relationship explicitly.");
  if (!value.bookSpecific && value.editSharedCanon !== true)
    invalid(
      "Confirm the shared family relationship for all books that see both entries.",
    );
  return db.transaction(async (q) => {
    const ctx = await context(q, bookId, entryId, true);
    if (ctx.book.data.deletedAt)
      invalid("Restore the book before recording family relationships.");
    const other = required(
      ctx.entries.find((e) => e.id === value.otherEntryId),
    );
    if (
      ctx.entry.updatedAt !== value.expectedUpdatedAt ||
      other.updatedAt !== value.expectedOtherUpdatedAt
    )
      throw new StudioError(
        409,
        "FAMILY_CONFLICT",
        "A character changed. Your answer is kept. Close and reopen Bible Entries to review it.",
      );
    if (other.id === entryId || !sameFamilyName(ctx.entry, other))
      invalid("Choose two visible characters with the same family name.");
    const match = (await familyData(q, ctx, bookId)).find(
      (m) => m.entry.id === other.id,
    );
    if (match?.related)
      throw new StudioError(
        409,
        "FAMILY_CONFLICT",
        "This pair already has a relationship here. Your answer is kept; reopen Family and Appearances to review it.",
      );
    const choice =
        familyRelations[value.relation as keyof typeof familyRelations],
      now = new Date().toISOString();
    let type = (
      await q(
        `SELECT data FROM relationship_types WHERE library_id=$1 AND data->>'label'=$2 AND data->>'inverseLabel'=$3 AND NOT (data ? 'deletedAt') ORDER BY (data->>'orderKey') COLLATE "C",id LIMIT 1`,
        [ctx.book.library_id, choice.label, choice.inverse],
      )
    ).rows[0]?.data;
    if (!type) {
      const last = (
        await q(
          `SELECT data FROM relationship_types WHERE library_id=$1 ORDER BY (data->>'orderKey') COLLATE "C" DESC,id DESC LIMIT 1`,
          [ctx.book.library_id],
        )
      ).rows[0]?.data.orderKey;
      type = {
        id: randomUUID(),
        label: choice.label,
        inverseLabel: choice.inverse,
        orderKey: between(last),
        createdAt: now,
        updatedAt: now,
      };
      await q(
        "INSERT INTO relationship_types(id,library_id,data) VALUES($1,$2,$3)",
        [type.id, ctx.book.library_id, type],
      );
    }
    const relationship = {
      id: randomUUID(),
      typeId: type.id,
      fromEntryId: choice.reversed ? other.id : entryId,
      toEntryId: choice.reversed ? entryId : other.id,
      ...(value.bookSpecific ? { bookId } : {}),
      createdAt: now,
      updatedAt: now,
    };
    await q("INSERT INTO relationships(id,library_id,data) VALUES($1,$2,$3)", [
      relationship.id,
      ctx.book.library_id,
      relationship,
    ]);
    return { relationshipType: type, relationship };
  });
}
export async function entryAppearances(
  db: Database,
  bookId: string,
  entryId: string,
) {
  return db.transaction(async (q) => {
    const ctx = await context(q, bookId, entryId);
    if (ctx.book.data.deletedAt) return { appearances: [] };
    const nodes = (
        await q("SELECT data FROM manuscript_nodes WHERE book_id=$1", [bookId])
      ).rows.map((r) => r.data),
      byId = new Map(nodes.map((n) => [n.id, n]));
    function path(node: any) {
      const seen = new Set<string>(),
        parts: string[] = [];
      let current = node;
      while (current) {
        if (current.deletedAt || seen.has(current.id)) return null;
        seen.add(current.id);
        parts.unshift(`${current.orderKey}:${current.id}`);
        if (!current.parentId) return parts.join("/");
        current = byId.get(current.parentId);
        if (!current) return null;
      }
      return null;
    }
    const rows = (
      await q(
        `SELECT r.data AS reference,n.id AS node_id,d.document FROM manuscript_references r JOIN manuscript_nodes n ON n.id=r.node_id LEFT JOIN documents d ON d.node_id=n.id WHERE n.book_id=$1 AND r.entry_id=$2 AND NOT (r.data ? 'deletedAt')`,
        [bookId, entryId],
      )
    ).rows;
    const appearances = rows
      .flatMap((row) => {
        const node = byId.get(row.node_id),
          order = node && path(node);
        if (!node || order === null) return [];
        let found = false;
        const text: string[] = [];
        for (const block of row.document?.blocks ?? [])
          for (const run of block.content ?? [])
            if (
              run.marks?.some(
                (m: any) =>
                  m.type === "anchor" && m.id === row.reference.anchorId,
              )
            ) {
              found = true;
              text.push(run.text ?? "\n");
            }
        return [
          {
            referenceId: row.reference.id,
            nodeId: node.id,
            sceneTitle: node.title,
            bookId,
            bookTitle: ctx.book.data.title,
            anchorId: row.reference.anchorId,
            passageMissing: !found,
            excerpt: text.join("").slice(0, 300),
            order,
          },
        ];
      })
      .sort((a, b) =>
        a.order < b.order
          ? -1
          : a.order > b.order
            ? 1
            : a.referenceId.localeCompare(b.referenceId),
      )
      .map(({ order, ...a }) => a);
    return { appearances };
  });
}
