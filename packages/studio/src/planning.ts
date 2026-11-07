// SPDX-License-Identifier: AGPL-3.0-only
import { StudioError } from "./store.ts";
import type { Database } from "./store.ts";
import { readContinuitySnapshot } from "./continuity.ts";
import { inScope } from "./state-values.ts";
import { wordCount } from "../../document-adapter/src/text.ts";
const overviewFields = ["logline", "premise", "themes", "arcs", "principles"];
const planFields = ["targetWordCount", "plan"];
const pointFields = ["synopsis", "status", "povEntryId", "settingEntryId"];
const invalid = (message: string): never => {
  throw new StudioError(400, "INVALID_INPUT", message);
};
const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export async function planningCatalog(db: Database, bookId: string) {
  return db.transaction(async (q) => {
    const s = await readContinuitySnapshot(q, bookId, "planning", true, true);
    // Parts are not story points; include every live ancestor in the planning outline.
    const byId = new Map(
      s.nodes.filter((n) => n.bookId === bookId).map((n) => [n.id, n]),
    );
    const live = (id: string): boolean => {
      const seen = new Set<string>();
      let n = byId.get(id);
      while (n) {
        if (n.deletedAt || seen.has(n.id)) return false;
        seen.add(n.id);
        if (!n.parentId) return true;
        n = byId.get(n.parentId);
      }
      return false;
    };
    const all = [...byId.values()].filter((n) => live(n.id));
    const nodes: any[] = [];
    const visit = (parent?: string) => {
      for (const n of all
        .filter((n) => n.parentId === parent)
        .sort((a, b) =>
          a.orderKey < b.orderKey
            ? -1
            : a.orderKey > b.orderKey
              ? 1
              : a.id < b.id
                ? -1
                : a.id > b.id
                  ? 1
                  : 0,
        )) {
        nodes.push(n);
        visit(n.id);
      }
    };
    visit();
    const documents = (
      await q(
        "SELECT d.node_id,d.document FROM documents d JOIN manuscript_nodes n ON n.id=d.node_id WHERE n.book_id=$1 LIMIT 10001",
        [bookId],
      )
    ).rows;
    if (documents.length > 10000)
      throw new StudioError(
        413,
        "CATALOG_TOO_LARGE",
        "This book is too large for planning totals. No documents were omitted.",
      );
    const nodeWords: Record<string, number> = {};
    let words = 0;
    for (const d of documents) {
      if (!live(d.node_id)) continue;
      const count = wordCount(d.document);
      words += count;
      let n = byId.get(d.node_id);
      while (n) {
        nodeWords[n.id] = (nodeWords[n.id] ?? 0) + count;
        n = n.parentId ? byId.get(n.parentId) : undefined;
      }
    }
    return {
      book: s.book,
      nodes: nodes.filter((n) => ["part", "chapter", "scene"].includes(n.kind)),
      entries: s.entries.filter(
        (e) =>
          inScope(e.scope, s.book) &&
          ["character", "location"].includes(e.entryType),
      ),
      words,
      nodeWords,
    };
  });
}
export async function savePlanning(
  db: Database,
  bookId: string,
  input: any,
  nodeId?: string,
) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    typeof input.expectedUpdatedAt !== "string"
  )
    invalid("Provide planning fields and the saved version.");
  return db.transaction(async (q) => {
    const s = await readContinuitySnapshot(q, bookId, "planning");
    const owner = nodeId
      ? s.nodes.find((n) => n.id === nodeId && n.bookId === bookId)
      : s.book;
    if (!owner)
      throw new StudioError(
        404,
        "NOT_FOUND",
        "This planning item no longer exists.",
      );
    if (nodeId) {
      const byId = new Map(s.nodes.map((n) => [n.id, n]));
      let n = owner;
      const seen = new Set<string>();
      while (n) {
        if (n.deletedAt || seen.has(n.id))
          invalid("Restore the item before editing its plan.");
        seen.add(n.id);
        if (!n.parentId) break;
        n = byId.get(n.parentId);
        if (!n) invalid("This item has an unavailable parent.");
      }
    }
    const allowed = nodeId
      ? [
          ...(["part", "chapter"].includes(owner.kind) ? planFields : []),
          ...(["chapter", "scene"].includes(owner.kind) ? pointFields : []),
        ]
      : overviewFields;
    if (
      !allowed.length ||
      Object.keys(input).some(
        (k) => k !== "expectedUpdatedAt" && !allowed.includes(k),
      )
    )
      invalid("Choose supported fields for this planning item.");
    if (owner.updatedAt !== input.expectedUpdatedAt)
      throw new StudioError(
        409,
        "PLANNING_CONFLICT",
        "This planning item changed. Your draft is kept. Copy any text you need, then cancel and refresh saved totals to review the latest version.",
      );
    const next = { ...owner };
    for (const [key, value] of Object.entries(input)) {
      if (key === "expectedUpdatedAt") continue;
      if (value === null) {
        delete next[key];
        continue;
      }
      if (key === "targetWordCount") {
        if (!Number.isSafeInteger(value) || (value as number) < 1)
          invalid("Use a positive whole number for the word target.");
      } else if (key === "povEntryId" || key === "settingEntryId") {
        if (typeof value !== "string" || !uuid.test(value))
          invalid("Choose a valid story-bible entry or clear the link.");
        const entry = s.entries.find((e) => e.id === value);
        // Existing unavailable links stay until explicitly changed or cleared.
        if (
          value !== owner[key] &&
          (!entry ||
            entry.deletedAt ||
            !inScope(entry.scope, s.book) ||
            entry.entryType !==
              (key === "povEntryId" ? "character" : "location"))
        )
          invalid(
            "Choose a live visible character for POV or location for setting.",
          );
      } else {
        const max =
          key === "status" ? 64 : key === "synopsis" ? 1000000 : 20000;
        if (typeof value !== "string" || [...value].length > max)
          invalid(
            `Use text of at most ${max.toLocaleString("en")} characters.`,
          );
        if (
          (overviewFields.includes(key) || key === "plan") &&
          !(value as string).trim()
        ) {
          delete next[key];
          continue;
        }
      }
      next[key] = value;
    }
    next.updatedAt = new Date(
      Math.max(Date.now(), Date.parse(owner.updatedAt) + 1),
    ).toISOString();
    await q(
      `UPDATE ${nodeId ? "manuscript_nodes" : "books"} SET data=$2 WHERE id=$1`,
      [owner.id, next],
    );
    return next;
  });
}
