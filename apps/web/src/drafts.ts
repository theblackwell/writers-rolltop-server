// SPDX-License-Identifier: AGPL-3.0-only
import { decode } from "../../../packages/document-adapter/src/canonical.ts";
import type { CanonicalDocument } from "../../../packages/document-adapter/src/canonical.ts";
export type BrowserDraft = {
  revision: number;
  document: CanonicalDocument;
  storageKey?: string;
  updatedAt?: number;
};
export type DraftStorage = Pick<
  Storage,
  "length" | "key" | "getItem" | "setItem" | "removeItem"
>;
export function draftKey(nodeId: string, editorId: string) {
  return `rolltop-draft:${nodeId}:${editorId}`;
}
export function writeDraft(
  storage: DraftStorage,
  key: string,
  revision: number,
  document: CanonicalDocument,
) {
  storage.setItem(
    key,
    JSON.stringify({ revision, document, updatedAt: Date.now() }),
  );
}
/** Read every editor's recovery copy, never delete another tab's work. Unknown or
 * malformed records stay untouched so a future version/manual recovery can read them. */
export function readDrafts(storage: DraftStorage, server: CanonicalDocument) {
  const prefix = `rolltop-draft:${server.nodeId}`;
  const drafts: BrowserDraft[] = [];
  let unreadable = 0;
  const current = JSON.stringify(decode(server));
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key || !(key === prefix || key.startsWith(prefix + ":"))) continue;
    try {
      const value = JSON.parse(storage.getItem(key)!);
      const document = decode(value.document);
      if (
        document.nodeId !== server.nodeId ||
        !Number.isSafeInteger(value.revision) ||
        value.revision < 1
      )
        throw new Error("Invalid draft");
      if (JSON.stringify(document) !== current)
        drafts.push({
          revision: value.revision,
          document,
          storageKey: key,
          updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
        });
    } catch {
      unreadable++;
    }
  }
  drafts.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return { drafts, unreadable };
}
