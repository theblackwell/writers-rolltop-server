// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  orderedChanges,
  resolveState,
  stateValueError,
} from "../src/state-values.ts";
test("as-of matches native earlier books → override → current changes, stable ties and earliest event placement", () => {
  const entry: any = {
    id: "entry",
    scope: { kind: "universe", id: "world" },
    values: { f: "canon" },
    overrides: [],
  };
  const books: any[] = [
    { id: "b1", universeId: "world", orderKey: "a" },
    { id: "b2", universeId: "world", orderKey: "b" },
    { id: "b3", universeId: "world", orderKey: "c" },
  ];
  const nodes: any[] = books.flatMap((b) => [
    { id: b.id + "chapter", bookId: b.id, kind: "chapter", orderKey: "a" },
    {
      id: b.id + "first",
      bookId: b.id,
      parentId: b.id + "chapter",
      kind: "scene",
      orderKey: "a",
    },
    {
      id: b.id + "last",
      bookId: b.id,
      parentId: b.id + "chapter",
      kind: "scene",
      orderKey: "b",
    },
  ]);
  const change = (
    id: string,
    value: any,
    point: object,
    createdAt = "2026-01-01T00:00:00Z",
  ) => ({ id, entryId: "entry", fieldId: "f", value, ...point, createdAt });
  const catalog: any = {
    books,
    nodes,
    events: [
      { id: "event", sceneIds: ["b3last", "b1last", "b1first"] },
      { id: "unplaced", sceneIds: [] },
    ],
    stateChanges: [
      change("early", "earlier", { nodeId: "b1last" }),
      change("now", false, { nodeId: "b2last" }),
      change("future", "future", { nodeId: "b3first" }),
      change("unplaced", "ignored", { eventId: "unplaced" }),
    ],
  };
  assert.equal(
    resolveState(entry, "f", "b2", "b2first", catalog).value,
    "earlier",
  );
  entry.overrides = [{ bookId: "b2", values: { f: 0 } }];
  assert.deepEqual(resolveState(entry, "f", "b2", "b2first", catalog), {
    value: 0,
    source: "override",
  });
  assert.deepEqual(resolveState(entry, "f", "b2", "b2last", catalog), {
    value: false,
    source: "change",
    changeId: "now",
  });
  assert.deepEqual(resolveState(entry, "f", "b2", "missing", catalog), {
    value: 0,
    source: "override",
  });
  catalog.stateChanges.push(
    change("event-change", "event", { eventId: "event" }),
  );
  assert.equal(orderedChanges(entry, catalog)[0].placement.bookId, "b1");
  assert.equal(orderedChanges(entry, catalog)[0].placement.position, 1);
  catalog.stateChanges.push(
    change("tie-a", "A", { nodeId: "b2last" }),
    change("tie-z", "Z", { nodeId: "b2last" }),
  );
  assert.equal(resolveState(entry, "f", "b2", "b2last", catalog).value, "Z");
  catalog.stateChanges.find((c: any) => c.id === "tie-z").deletedAt = "trash";
  assert.equal(resolveState(entry, "f", "b2", "b2last", catalog).value, "A");
  nodes.find((n) => n.id === "b2chapter")!.deletedAt = "trash";
  assert.equal(resolveState(entry, "f", "b2", "b2last", catalog).value, 0);
  delete nodes.find((n) => n.id === "b2chapter")!.deletedAt;
  books[0].deletedAt = "trash";
  entry.overrides = [];
  assert.equal(
    resolveState(entry, "f", "b2", "b2first", catalog).value,
    "canon",
  );
});
test("state value types preserve false, zero, empty arrays/text and exact decimals; reject null and unsupported attachments", () => {
  for (const [field, value] of [
    [{ fieldType: "boolean" }, false],
    [{ fieldType: "integer" }, 0],
    [{ fieldType: "shortText" }, ""],
    [{ fieldType: "decimal" }, "-0.000000000000000001"],
    [{ fieldType: "entryReferences" }, []],
    [{ fieldType: "selection", options: [] }, []],
    [{ fieldType: "fictionalDate" }, { label: "Day", ordinal: 0 }],
    [{ fieldType: "table" }, { columns: [""], rows: [[""]] }],
    [{ fieldType: "realDate" }, "2000-02-29"],
  ] as any[])
    assert.equal(stateValueError(field, value), undefined);
  for (const [field, value] of [
    [{ fieldType: "boolean" }, 0],
    [{ fieldType: "integer" }, 1.1],
    [{ fieldType: "decimal" }, 1.5],
    [{ fieldType: "decimal" }, "1e2"],
    [{ fieldType: "shortText" }, null],
    [{ fieldType: "attachment" }, "hash"],
    [{ fieldType: "entryReferences" }, ["a", "a"]],
  ] as any[])
    assert.ok(stateValueError(field, value));
});
