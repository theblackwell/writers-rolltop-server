// SPDX-License-Identifier: AGPL-3.0-only
import { structuredTypes, structuredValueError } from "./structured-values.ts";
export const stateFieldTypes = [
  "shortText",
  "longText",
  "integer",
  "decimal",
  "boolean",
  ...structuredTypes,
  "entryReference",
  "entryReferences",
];
export function stateValueError(field: any, value: any): string | undefined {
  if (value === null || value === undefined)
    return "A state change needs a value. Use Trash to remove a change.";
  if (!stateFieldTypes.includes(field.fieldType))
    return "Attachment changes require portable-library support.";
  const error = structuredValueError(field, value);
  if (error) return error;
  if (
    ["shortText", "longText"].includes(field.fieldType) &&
    (typeof value !== "string" || [...value].length > 20000)
  )
    return "Use text of at most 20,000 characters.";
  if (field.fieldType === "integer" && !Number.isSafeInteger(value))
    return "Use an integer within ±(2^53−1).";
  if (
    field.fieldType === "decimal" &&
    (typeof value !== "string" ||
      value.length > 1000 ||
      !/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$(?![\s\S])/.test(value))
  )
    return "Use an exact decimal string without exponent notation.";
  if (field.fieldType === "boolean" && typeof value !== "boolean")
    return "Choose true or false.";
  if (["entryReference", "entryReferences"].includes(field.fieldType)) {
    const ids = field.fieldType === "entryReference" ? [value] : value;
    if (
      !Array.isArray(ids) ||
      ids.some((id: any) => typeof id !== "string") ||
      new Set(ids).size !== ids.length
    )
      return "Choose unique entry links.";
  }
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export function inScope(scope: any, book: any) {
  return scope.kind === "book"
    ? scope.id === book.id
    : scope.kind === "universe"
      ? scope.id === book.universeId
      : scope.id === book.seriesId;
}
/** A historical event may belong to an earlier book in the entry's story. */
export function eventInStory(event: any, entry: any, books: any[]) {
  return books.some(
    (b) => !b.deletedAt && inScope(entry.scope, b) && inScope(event.scope, b),
  );
}
export function manuscriptPositions(
  nodes: any[],
  bookId: string,
): Record<string, number> {
  const children = new Map<string, any[]>();
  for (const n of nodes.filter((n) => n.bookId === bookId && !n.deletedAt)) {
    const key = n.parentId ?? "",
      group = children.get(key) ?? [];
    group.push(n);
    children.set(key, group);
  }
  for (const group of children.values())
    group.sort(
      (a, b) => compare(a.orderKey, b.orderKey) || compare(a.id, b.id),
    );
  const out: Record<string, number> = {},
    seen = new Set<string>(),
    pending = [...(children.get("") ?? [])].reverse();
  let rank = 0;
  while (pending.length) {
    const n = pending.pop()!;
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    if (["chapter", "scene"].includes(n.kind)) out[n.id] = rank++;
    pending.push(...[...(children.get(n.id) ?? [])].reverse());
  }
  return out;
}
export function orderedChanges(entry: any, catalog: any) {
  const books = catalog.books
    .filter((b: any) => !b.deletedAt && inScope(entry.scope, b))
    .sort(
      (a: any, b: any) =>
        compare(a.orderKey, b.orderKey) || compare(a.id, b.id),
    );
  const ranks = new Map(books.map((b: any, i: number) => [b.id, i]));
  const positions = new Map(
    catalog.books
      .filter((b: any) => !b.deletedAt)
      .map((b: any) => [b.id, manuscriptPositions(catalog.nodes, b.id)]),
  );
  const at = (id: string) => {
    const n = catalog.nodes.find((n: any) => n.id === id),
      p = n ? (positions.get(n.bookId) as any)?.[id] : undefined;
    return p === undefined ? undefined : { bookId: n.bookId, position: p };
  };
  const placement = (c: any) => {
    if (c.nodeId) return at(c.nodeId);
    const event = catalog.events.find(
      (e: any) => e.id === c.eventId && !e.deletedAt,
    );
    return event?.sceneIds
      .map(at)
      .filter(Boolean)
      .sort(
        (a: any, b: any) =>
          ((ranks.get(a.bookId) as number) ?? Infinity) -
            ((ranks.get(b.bookId) as number) ?? Infinity) ||
          a.position - b.position,
      )[0];
  };
  return catalog.stateChanges
    .filter((c: any) => c.entryId === entry.id && !c.deletedAt)
    .map((c: any) => ({ change: c, placement: placement(c) }))
    .sort(
      (a: any, b: any) =>
        ((ranks.get(a.placement?.bookId) as number) ?? Infinity) -
          ((ranks.get(b.placement?.bookId) as number) ?? Infinity) ||
        (a.placement?.position ?? Infinity) -
          (b.placement?.position ?? Infinity) ||
        compare(a.change.createdAt, b.change.createdAt) ||
        compare(a.change.id, b.change.id),
    );
}
export function resolveState(
  entry: any,
  fieldId: string,
  bookId: string,
  nodeId: string,
  catalog: any,
) {
  const own =
    entry.overrides?.find((o: any) => o.bookId === bookId)?.values ?? {};
  const fallback = Object.hasOwn(own, fieldId)
    ? own[fieldId]
    : entry.values?.[fieldId];
  const limit = manuscriptPositions(catalog.nodes, bookId)[nodeId];
  if (limit === undefined)
    return {
      value: fallback,
      source: Object.hasOwn(own, fieldId) ? "override" : "canon",
    };
  const books = catalog.books
    .filter((b: any) => !b.deletedAt && inScope(entry.scope, b))
    .sort(
      (a: any, b: any) =>
        compare(a.orderKey, b.orderKey) || compare(a.id, b.id),
    );
  const ranks = new Map(books.map((b: any, i: number) => [b.id, i])),
    current = (ranks.get(bookId) as number) ?? Infinity;
  let value = entry.values?.[fieldId],
    source = "canon",
    changeId: string | undefined;
  const changes = orderedChanges(entry, catalog).filter(
    (x: any) => x.change.fieldId === fieldId && x.placement,
  );
  for (const { change, placement } of changes)
    if (((ranks.get(placement.bookId) as number) ?? Infinity) < current) {
      value = change.value;
      source = "change";
      changeId = change.id;
    }
  if (Object.hasOwn(own, fieldId)) {
    value = own[fieldId];
    source = "override";
    changeId = undefined;
  }
  for (const { change, placement } of changes)
    if (placement.bookId === bookId && placement.position <= limit) {
      value = change.value;
      source = "change";
      changeId = change.id;
    }
  return { value, source, ...(changeId ? { changeId } : {}) };
}
