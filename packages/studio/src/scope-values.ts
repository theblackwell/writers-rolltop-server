// SPDX-License-Identifier: AGPL-3.0-only
/** A canonical link must be usable by every book that shares its owner. */
export function scopeAllowsTarget(
  owner: any,
  target: any,
  book: any,
  seriesWorld?: string,
) {
  const s = target.scope;
  if (owner.scope.kind === "book")
    return (
      (s.kind === "book" && s.id === book.id) ||
      (s.kind === "universe" && s.id === book.universeId) ||
      (s.kind === "series" && s.id === book.seriesId)
    );
  if (owner.scope.kind === "universe")
    return s.kind === "universe" && s.id === owner.scope.id;
  return (
    (s.kind === "series" && s.id === owner.scope.id) ||
    (s.kind === "universe" && s.id === seriesWorld)
  );
}
