// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { knowledgeAt, warningCountsByNode } from "../src/continuity-values.ts";
import type { ContinuitySnapshot } from "../src/continuity-values.ts";
test("knowledge follows scope/story order/current point, from-start rules, false beliefs and deterministic reader-first ordering", () => {
  const books: any[] = [
    { id: "b1", orderKey: "a", universeId: "world" },
    { id: "b2", orderKey: "b", universeId: "world" },
    { id: "b3", orderKey: "c", universeId: "world" },
    { id: "foreign", orderKey: "d" },
  ];
  const nodes: any[] = books.flatMap((b) => [
    {
      id: b.id + "chapter",
      bookId: b.id,
      kind: "chapter",
      title: "Chapter",
      orderKey: "a",
    },
    {
      id: b.id + "early",
      bookId: b.id,
      parentId: b.id + "chapter",
      kind: "scene",
      title: "Early",
      orderKey: "a",
    },
    {
      id: b.id + "late",
      bookId: b.id,
      parentId: b.id + "chapter",
      kind: "scene",
      title: "Late",
      orderKey: "b",
    },
  ]);
  const make = (id: string, knowledge: any[], extra: any = {}) => ({
    id,
    scope: { kind: "universe", id: "world" },
    orderKey: id,
    text: id,
    truth: "true",
    entryIds: [],
    knowledge,
    ...extra,
  });
  const s: ContinuitySnapshot = {
    book: books[1],
    books,
    nodes,
    entries: [
      { id: "c2", name: "Person 2" },
      { id: "c10", name: "Person 10" },
      { id: "dead", name: "Dead", deletedAt: "trash" },
    ],
    fields: [],
    events: [],
    stateChanges: [],
    questions: [],
    wordNodes: [],
    facts: [
      make("a", [{ knower: "reader", nodeId: "b1late" }, { knower: "c2" }], {
        truth: "false",
      }),
      make(
        "b",
        [
          { knower: "reader", nodeId: "b2late" },
          { knower: "c10", nodeId: "b2early" },
        ],
        { truth: "undecided" },
      ),
      make("c", [
        { knower: "reader", nodeId: "b3early" },
        { knower: "dead" },
        { knower: "missing" },
      ]),
      make("d", [{ knower: "reader" }], { scope: { kind: "book", id: "b1" } }),
      make("e", [{ knower: "reader" }], { deletedAt: "trash" }),
    ],
  };
  const before = JSON.stringify(s),
    groups = knowledgeAt(s, "b2early");
  assert.deepEqual(
    groups.map((g) => g.id),
    ["reader", "c2", "c10"],
  );
  assert.deepEqual(
    groups[0].facts.map((f) => f.id),
    ["a"],
  );
  assert.equal(groups[0].facts[0].truth, "false");
  assert.equal(groups[2].facts[0].truth, "undecided");
  assert.equal(groups[1].facts[0].learnedIn, undefined);
  assert.equal(knowledgeAt(s, "b2late")[0].facts.length, 2);
  assert.equal(knowledgeAt(s, "missing").length, 0);
  assert.equal(JSON.stringify(s), before);
  nodes.find((n) => n.id === "b1chapter").deletedAt = "trash";
  assert.equal(
    knowledgeAt(s, "b2early").some((g) => g.id === "reader"),
    false,
  );
  books[0].orderKey = "z";
  delete nodes.find((n) => n.id === "b1chapter").deletedAt;
  assert.equal(
    knowledgeAt(s, "b2early").some((g) => g.id === "reader"),
    false,
  );
});
test("warning counts include active IDs once per node and exclude intentional warnings", () => {
  const warning: any = { id: "w", nodeIds: ["scene", "chapter", "scene"] };
  assert.deepEqual(
    warningCountsByNode([
      warning,
      { ...warning, id: "other", nodeIds: ["scene"] },
      { ...warning, id: "intentional", dismissal: { warning: "key" } },
    ]),
    { scene: 2, chapter: 1 },
  );
});
