// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  children,
  liveNodes,
  readingOrder,
  firstDocument,
} from "../../../apps/web/src/manuscript.ts";
import type { Item } from "../../../apps/web/src/api.ts";
test("binder reading order follows parts and sibling keys, skipping tombstoned ancestors", () => {
  const nodes: Item[] = [
    {
      id: "scene-b",
      title: "B",
      kind: "scene",
      parentId: "chapter-b",
      orderKey: "a",
    },
    {
      id: "chapter-b",
      title: "Chapter B",
      kind: "chapter",
      parentId: "part-b",
      orderKey: "a",
    },
    { id: "part-b", title: "Part B", kind: "part", orderKey: "c" },
    {
      id: "scene-a",
      title: "A",
      kind: "scene",
      parentId: "chapter-a",
      orderKey: "a",
    },
    { id: "chapter-a", title: "Chapter A", kind: "chapter", orderKey: "b" },
    {
      id: "dedication",
      title: "Dedication",
      kind: "frontMatter",
      orderKey: "a",
    },
    {
      id: "hidden",
      title: "Hidden part",
      kind: "part",
      orderKey: "d",
      deletedAt: "2026-11-03T00:00:00Z",
    },
    {
      id: "hidden-chapter",
      title: "Hidden chapter",
      kind: "chapter",
      parentId: "hidden",
      orderKey: "a",
    },
    {
      id: "hidden-scene",
      title: "Hidden scene",
      kind: "scene",
      parentId: "hidden-chapter",
      orderKey: "a",
    },
  ];
  assert.deepEqual(
    readingOrder(liveNodes(nodes)).map((n) => n.id),
    ["dedication", "chapter-a", "scene-a", "part-b", "chapter-b", "scene-b"],
  );
  assert.equal(
    firstDocument(nodes)?.id,
    "scene-a",
    "opening a book prefers its first scene",
  );
  assert.equal(
    firstDocument(nodes.filter((n) => n.kind !== "scene"))?.id,
    "dedication",
    "front matter remains editable when there are no scenes",
  );
  assert.deepEqual(
    children(nodes, null).map((n) => n.id),
    ["dedication", "chapter-a", "part-b", "hidden"],
  );
});
test("corrupt cyclic or dangling parents cannot hang or appear in the live binder", () => {
  const nodes: Item[] = [
    { id: "a", title: "A", parentId: "b" },
    { id: "b", title: "B", parentId: "a" },
    { id: "c", title: "C", parentId: "missing" },
  ];
  assert.deepEqual(liveNodes(nodes), []);
  assert.deepEqual(readingOrder(nodes), []);
});
