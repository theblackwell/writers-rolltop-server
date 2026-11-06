// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { continuityWarnings, warningKinds } from "../src/continuity-values.ts";
import type { ContinuitySnapshot } from "../src/continuity-values.ts";
function sample(): ContinuitySnapshot {
  const books = [
    { id: "first", orderKey: "a", universeId: "world" },
    { id: "second", orderKey: "b", universeId: "world" },
    { id: "outside", orderKey: "c" },
  ];
  const nodes = books.flatMap((b) => [
    {
      id: b.id + "chapter",
      bookId: b.id,
      title: b.id + " chapter",
      kind: "chapter",
      orderKey: "a",
    },
    {
      id: b.id + "early",
      bookId: b.id,
      parentId: b.id + "chapter",
      title: "Early",
      kind: "scene",
      orderKey: "a",
    },
    {
      id: b.id + "late",
      bookId: b.id,
      parentId: b.id + "chapter",
      title: "Late",
      kind: "scene",
      orderKey: "b",
    },
  ]);
  return {
    book: books[1],
    books,
    nodes,
    entries: [
      { id: "person", name: "Person" },
      { id: "dead", name: "Lost", deletedAt: "trash" },
    ],
    fields: [{ id: "field", label: "Role" }],
    facts: [],
    questions: [],
    events: [],
    stateChanges: [],
    wordNodes: [],
  };
}
const fact = (id: string, extra: any = {}) => ({
  id,
  scope: { kind: "universe", id: "world" },
  text: "A secret",
  truth: "true",
  entryIds: [],
  knowledge: [],
  ...extra,
});
test("all eight canonical kinds and exact keys, stable identities, sorting and read-only behavior", () => {
  const s = sample();
  s.nodes.find((n) => n.id === "secondlate").deletedAt = "trash";
  s.facts = [
    fact("early", {
      nodeId: "secondchapter",
      knowledge: [{ knower: "person", nodeId: "firstearly" }],
    }),
    fact("missing", {
      nodeId: "secondlate",
      truth: "undecided",
      entryIds: ["dead", "gone"],
      knowledge: [
        { knower: "dead", nodeId: "missing" },
        { knower: "reader", nodeId: "secondlate" },
      ],
    }),
  ];
  s.questions = [
    {
      id: "question",
      scope: { kind: "book", id: "second" },
      text: "Who?",
      status: "open",
      nodeId: "secondchapter",
    },
  ];
  s.wordNodes = ["secondearly"];
  s.events = [
    {
      id: "event",
      scope: { kind: "universe", id: "world" },
      title: "Discovery",
      sceneIds: ["secondearly"],
    },
  ];
  s.stateChanges = [
    {
      id: "a",
      eventId: "event",
      entryId: "person",
      fieldId: "field",
      value: false,
    },
    {
      id: "b",
      eventId: "event",
      entryId: "person",
      fieldId: "field",
      value: true,
    },
  ];
  const before = JSON.stringify(s),
    warnings = continuityWarnings(s);
  assert.deepEqual(new Set(warnings.map((w) => w.kind)), new Set(warningKinds));
  for (const key of [
    "learnedBeforeEstablished:person:firstearly:secondchapter",
    "establishedInTrash:secondlate",
    "aboutMissingEntry:dead",
    "aboutMissingEntry:gone",
    "knowerMissing:dead",
    "learnedInTrash:dead:missing",
    "learnedInTrash:reader:secondlate",
    "undecidedButKnown",
    "questionOverdue:secondchapter",
    "stateConflict:person:field",
  ])
    assert.ok(
      warnings.some((w) => w.key === key),
      key,
    );
  assert.ok(warnings.every((w) => w.id === w.subject.id + "/" + w.key));
  assert.deepEqual(warnings, continuityWarnings(s));
  assert.equal(JSON.stringify(s), before);
  assert.ok(
    warnings
      .flatMap((w) => w.nodeIds)
      .every((id) => id !== "secondlate" && id !== "missing"),
  );
  assert.match(
    warnings.find((w) => w.kind === "stateConflict")!.message,
    /conflicting recorded changes/,
  );
});
test("story order uses book membership/order, then chapter/scene order; same point and from-start are not early", () => {
  const s = sample();
  s.facts = [
    fact("f", {
      nodeId: "secondlate",
      knowledge: [
        { knower: "reader", nodeId: "firstlate" },
        { knower: "person", nodeId: "secondlate" },
        { knower: "always" },
        { knower: "outside", nodeId: "outsideearly" },
      ],
    }),
  ];
  let early = continuityWarnings(s).filter(
    (w) => w.kind === "learnedBeforeEstablished",
  );
  assert.equal(early.length, 1);
  assert.equal(
    early[0].key,
    "learnedBeforeEstablished:reader:firstlate:secondlate",
  );
  s.books.find((b) => b.id === "first").orderKey = "z";
  assert.equal(
    continuityWarnings(s).filter((w) => w.kind === "learnedBeforeEstablished")
      .length,
    0,
  );
  s.facts = [
    fact("f", {
      nodeId: "secondearly",
      knowledge: [{ knower: "reader", nodeId: "secondchapter" }],
    }),
  ];
  assert.equal(continuityWarnings(s)[0].kind, "learnedBeforeEstablished");
  s.books.find((b) => b.id === "second").deletedAt = "trash";
  assert.deepEqual(
    new Set(continuityWarnings(s).map((w) => w.kind)),
    new Set(["establishedInTrash", "learnedInTrash"]),
  );
});
test("inherited Trash and absent links are advisory, live/visible subjects only, false beliefs are valid", () => {
  const s = sample();
  s.nodes.find((n) => n.id === "secondchapter").deletedAt = "trash";
  s.facts = [
    fact("f", {
      truth: "false",
      nodeId: "secondearly",
      knowledge: [{ knower: "reader", nodeId: "secondlate" }],
    }),
    fact("hidden", {
      scope: { kind: "book", id: "first" },
      truth: "undecided",
      knowledge: [{ knower: "reader" }],
    }),
    fact("trashed", {
      deletedAt: "trash",
      truth: "undecided",
      knowledge: [{ knower: "reader" }],
    }),
  ];
  assert.deepEqual(
    new Set(continuityWarnings(s).map((w) => w.kind)),
    new Set(["establishedInTrash", "learnedInTrash"]),
  );
  s.questions = [
    {
      id: "q",
      scope: { kind: "book", id: "second" },
      status: "open",
      text: "Question",
      nodeId: "secondearly",
    },
  ];
  s.wordNodes = ["secondearly"];
  assert.equal(
    continuityWarnings(s).some((w) => w.kind === "questionOverdue"),
    false,
  );
});
test("question overdue uses saved word presence under live descendants and never punctuation/blank/Trash or closed questions", () => {
  const s = sample();
  s.questions = [
    {
      id: "q",
      scope: { kind: "book", id: "second" },
      status: "open",
      text: "Who?",
      nodeId: "secondchapter",
    },
  ];
  assert.equal(continuityWarnings(s).length, 0);
  s.wordNodes = ["secondlate"];
  assert.equal(continuityWarnings(s)[0].key, "questionOverdue:secondchapter");
  s.nodes.find((n) => n.id === "secondlate").deletedAt = "trash";
  assert.equal(continuityWarnings(s).length, 0);
  delete s.nodes.find((n) => n.id === "secondlate").deletedAt;
  s.questions[0].status = "decided";
  assert.equal(continuityWarnings(s).length, 0);
});
test("conflicts compare JSON values structurally; only live visible events and live entries count, never node-only changes", () => {
  const s = sample();
  s.events = [
    {
      id: "e",
      scope: { kind: "book", id: "second" },
      title: "Event",
      sceneIds: [],
    },
  ];
  const c = (id: string, value: any, extra: any = {}) => ({
    id,
    eventId: "e",
    entryId: "person",
    fieldId: "field",
    value,
    ...extra,
  });
  s.stateChanges = [
    c("a", { columns: ["C"], rows: [["A"]] }),
    c("b", { rows: [["A"]], columns: ["C"] }),
  ];
  assert.equal(continuityWarnings(s).length, 0);
  s.stateChanges.push(c("c", { columns: ["C"], rows: [["B"]] }));
  assert.equal(continuityWarnings(s)[0].key, "stateConflict:person:field");
  s.stateChanges[2].deletedAt = "trash";
  assert.equal(continuityWarnings(s).length, 0);
  s.stateChanges = [c("a", false), c("b", 0)];
  assert.equal(continuityWarnings(s).length, 1);
  s.entries.find((e) => e.id === "person").deletedAt = "trash";
  assert.equal(continuityWarnings(s).length, 0);
  delete s.entries.find((e) => e.id === "person").deletedAt;
  s.events[0].scope.id = "first";
  assert.equal(continuityWarnings(s).length, 0);
  s.stateChanges = [
    c("a", 1, { eventId: undefined, nodeId: "secondearly" }),
    c("b", 2, { eventId: undefined, nodeId: "secondearly" }),
  ];
  assert.equal(continuityWarnings(s).length, 0);
});
test("stored dismissals match exact keys, changed places return warnings and unknown dismissals survive", () => {
  const s = sample();
  s.facts = [
    fact("f", {
      nodeId: "secondlate",
      knowledge: [{ knower: "reader", nodeId: "secondearly" }],
      dismissedWarnings: [
        {
          warning: "learnedBeforeEstablished:reader:secondearly:secondlate",
          note: "On purpose",
          dismissedAt: "stamp",
        },
        { warning: "FutureKind:abc", dismissedAt: "stamp" },
      ],
    }),
  ];
  const before = JSON.stringify(s);
  assert.equal(continuityWarnings(s)[0].dismissal?.note, "On purpose");
  assert.equal(JSON.stringify(s), before);
  s.facts[0].knowledge[0].nodeId = "secondchapter";
  assert.equal(continuityWarnings(s)[0].dismissal, undefined);
  assert.equal(s.facts[0].dismissedWarnings.length, 2);
});
