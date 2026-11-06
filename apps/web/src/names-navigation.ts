// SPDX-License-Identifier: AGPL-3.0-only
import { liveNodes } from "./manuscript.ts";
import type { Item } from "./api.ts";
export async function prepareNamesPlace(
  id: string,
  flush: () => Promise<boolean>,
  load: () => Promise<{ book: Item; nodes: Item[] }>,
) {
  if (!(await flush()))
    throw new Error(
      "Resolve the current scene's draft or save conflict before opening another source.",
    );
  const data = await load(),
    target = liveNodes(data.nodes).find(
      (n) =>
        n.id === id &&
        ["scene", "frontMatter", "backMatter"].includes(n.kind ?? ""),
    );
  if (data.book.deletedAt || !target)
    throw new Error(
      "This manuscript source is no longer available. Restore it from Trash before opening it.",
    );
  return { ...data, target };
}
