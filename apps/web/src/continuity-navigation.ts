// SPDX-License-Identifier: AGPL-3.0-only
import { liveNodes } from "./manuscript.ts";
import type { Item } from "./api.ts";
/** Flush first: a conflicted manuscript must never be displaced by a warning link. */
export async function prepareContinuityPlace(
  point: { id: string; bookId: string },
  flush: () => Promise<boolean>,
  load: (bookId: string) => Promise<{ book: Item; nodes: Item[] }>,
) {
  if (!(await flush()))
    throw new Error(
      "Resolve the current scene's draft or save conflict before opening another point.",
    );
  const data = await load(point.bookId),
    target = liveNodes(data.nodes).find(
      (n) => n.id === point.id && ["chapter", "scene"].includes(n.kind ?? ""),
    );
  if (data.book.deletedAt || !target)
    throw new Error(
      "This chapter or scene is no longer available. Restore it from Trash before opening it.",
    );
  return { ...data, target };
}
