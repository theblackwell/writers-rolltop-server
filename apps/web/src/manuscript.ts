// SPDX-License-Identifier: AGPL-3.0-only
import type { Item } from "./api.ts";
export function children(nodes: Item[], parentId: string | null) {
  return nodes
    .filter((n) => (n.parentId ?? null) === parentId)
    .sort((a, b) =>
      a.orderKey! < b.orderKey!
        ? -1
        : a.orderKey! > b.orderKey!
          ? 1
          : a.id < b.id
            ? -1
            : 1,
    );
}
export function liveNodes(nodes: Item[]) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return nodes.filter((n) => {
    const seen = new Set<string>();
    let current: Item | undefined = n;
    while (current) {
      if (current.deletedAt || seen.has(current.id)) return false;
      seen.add(current.id);
      if (!current.parentId) return true;
      current = byId.get(current.parentId);
    }
    return false;
  });
}
export function readingOrder(nodes: Item[]): Item[] {
  const result: Item[] = [];
  const seen = new Set<string>();
  function visit(parent: string | null) {
    for (const n of children(nodes, parent)) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      result.push(n);
      visit(n.id);
    }
  }
  visit(null);
  return result;
}
export function firstDocument(nodes: Item[]) {
  const ordered = readingOrder(liveNodes(nodes));
  return (
    ordered.find((n) => n.kind === "scene") ??
    ordered.find((n) => ["frontMatter", "backMatter"].includes(n.kind ?? "")) ??
    null
  );
}
export function itemLabel(item: Item) {
  return `${item.kind === "frontMatter" ? "Front matter" : item.kind === "backMatter" ? "Back matter" : (item.kind ?? "book")}: ${item.title}`;
}
