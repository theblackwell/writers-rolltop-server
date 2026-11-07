// SPDX-License-Identifier: AGPL-3.0-only
import { StudioError } from "./store.ts";
import type { Database } from "./store.ts";
import { readContinuitySnapshot } from "./continuity.ts";
import { knowledgeAt } from "./continuity-values.ts";
import { manuscriptPositions } from "./state-values.ts";
export async function knowledgeCatalog(
  db: Database,
  bookId: string,
  asOf?: string,
) {
  return db.transaction(async (q) => {
    const s = await readContinuitySnapshot(q, bookId, true, true, true),
      positions = manuscriptPositions(s.nodes, bookId);
    const nodes = s.nodes
      .filter((n) => n.bookId === bookId && positions[n.id] !== undefined)
      .sort((a, b) => positions[a.id] - positions[b.id])
      .map((n) => ({ id: n.id, title: n.title, kind: n.kind }));
    const point =
      asOf ?? nodes.find((n) => n.kind === "scene")?.id ?? nodes[0]?.id;
    if (point && !nodes.some((n) => n.id === point))
      throw new StudioError(
        400,
        "INVALID_POINT",
        "Choose a live chapter or scene in this book.",
      );
    return {
      pointId: point,
      nodes,
      groups: point ? knowledgeAt(s, point) : [],
    };
  });
}
