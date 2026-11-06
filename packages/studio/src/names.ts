// SPDX-License-Identifier: AGPL-3.0-only
import { StudioError } from "./store.ts";
import type { Database } from "./store.ts";
import { readContinuitySnapshot } from "./continuity.ts";
import type { ContinuitySnapshot } from "./continuity-values.ts";
import { inScope } from "./state-values.ts";
import { documentText } from "../../document-adapter/src/text.ts";
import type { CanonicalDocument } from "../../document-adapter/src/canonical.ts";
export type NameNeeded = {
  id: string;
  text: string;
  source: "flag" | "manuscript" | "entry" | "fact";
  sourceId: string;
  title: string;
};
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });
/** Native placeholders: one line, 1–60 characters inside brackets, trimmed, distinct per source. */
export function* placeholders(text: string): Generator<string> {
  const seen = new Set<string>();
  for (const m of text.matchAll(/\[([^\[\]\n]+)\]/gu)) {
    let count = 0;
    for (const _ of graphemes.segment(m[1])) {
      if (++count > 60) break;
    }
    if (count > 60) continue;
    const value = m[1].trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    yield value;
  }
}
export function namesFrom(
  s: ContinuitySnapshot,
  documents: { node_id: string; document: CanonicalDocument }[],
): NameNeeded[] {
  const rows: NameNeeded[] = [];
  const add = (row: NameNeeded) => {
    rows.push(row);
    if (rows.length > 10000)
      throw new StudioError(
        413,
        "CATALOG_TOO_LARGE",
        "There are too many names still needed to display. No results were omitted.",
      );
  };
  const entries = s.entries
    .filter((e) => !e.deletedAt && inScope(e.scope, s.book))
    .sort(
      (a, b) =>
        a.entryType.localeCompare(b.entryType) ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    );
  for (const e of entries)
    if (e.toBeNamed)
      add({
        id: "flag/" + e.id,
        text: e.name,
        source: "flag",
        sourceId: e.id,
        title: e.name,
      });
  const nodes = s.nodes.filter((n) => n.bookId === s.book.id),
    docs = new Map(documents.map((d) => [d.node_id, d.document]));
  const scan = (
    text: string,
    source: "manuscript" | "entry" | "fact",
    id: string,
    title: string,
  ) => {
    for (const p of placeholders(text))
      add({
        id: source + "/" + id + "/" + p,
        text: "[" + p + "]",
        source,
        sourceId: id,
        title,
      });
  };
  const visit = (parent?: string) => {
    for (const n of nodes
      .filter((n) => n.parentId === parent && !n.deletedAt)
      .sort((a, b) =>
        a.orderKey < b.orderKey
          ? -1
          : a.orderKey > b.orderKey
            ? 1
            : a.id < b.id
              ? -1
              : 1,
      )) {
      if (
        docs.has(n.id) &&
        ["scene", "frontMatter", "backMatter"].includes(n.kind)
      )
        scan(documentText(docs.get(n.id)!), "manuscript", n.id, n.title);
      visit(n.id);
    }
  };
  visit();
  for (const e of entries)
    scan([e.name, e.summary ?? ""].join("\n"), "entry", e.id, e.name);
  for (const f of s.facts
    .filter((f) => !f.deletedAt && inScope(f.scope, s.book))
    .sort((a, b) =>
      a.orderKey < b.orderKey
        ? -1
        : a.orderKey > b.orderKey
          ? 1
          : a.id < b.id
            ? -1
            : 1,
    ))
    scan(f.text, "fact", f.id, f.text.slice(0, 200));
  return rows;
}
export async function namesCatalog(db: Database, bookId: string) {
  return db.transaction(async (q) => {
    const s = await readContinuitySnapshot(q, bookId, true);
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
        "This book is too large for names still needed. No documents were omitted.",
      );
    return { items: namesFrom(s, documents as any) };
  });
}
