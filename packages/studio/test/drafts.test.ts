// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  draftKey,
  writeDraft,
  readDrafts,
} from "../../../apps/web/src/drafts.ts";
import type { DraftStorage } from "../../../apps/web/src/drafts.ts";
import type { CanonicalDocument } from "../../document-adapter/src/canonical.ts";
function storage(): DraftStorage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}
const blank = (): CanonicalDocument => ({
  schema: "writers-rolltop/document",
  version: 1,
  nodeId: randomUUID(),
  blocks: [],
});
test("a successful save removes only its own editor draft, preserving a different tab", () => {
  const s = storage();
  const doc = blank();
  const one = draftKey(doc.nodeId, "one");
  const two = draftKey(doc.nodeId, "two");
  writeDraft(s, one, 1, doc);
  const edited = {
    ...doc,
    blocks: [
      {
        id: randomUUID(),
        type: "paragraph" as const,
        content: [{ type: "text" as const, text: "Unsaved tab two" }],
      },
    ],
  };
  writeDraft(s, two, 1, edited);
  s.removeItem(one);
  const recovered = readDrafts(s, doc);
  assert.equal(recovered.drafts.length, 1);
  assert.deepEqual(recovered.drafts[0].document, edited);
  assert.equal(recovered.drafts[0].storageKey, two);
});
test("newer-server, malformed and unsupported drafts are retained without modifying server content", () => {
  const s = storage();
  const doc = blank();
  const key = draftKey(doc.nodeId, "unsupported");
  s.setItem(
    key,
    JSON.stringify({ revision: 1, document: { ...doc, version: 2 } }),
  );
  const malformed = draftKey(doc.nodeId, "broken");
  s.setItem(malformed, "{oops");
  const r = readDrafts(s, doc);
  assert.equal(r.unreadable, 2);
  assert.equal(s.length, 2);
  assert.ok(s.getItem(key));
  writeDraft(s, draftKey(doc.nodeId, "equal"), 2, doc);
  assert.equal(readDrafts(s, doc).drafts.length, 0);
  assert.equal(s.length, 3, "reading performs no deletion");
});
