// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { entry, now, setup } from "./bible-ui-harness.ts";

const nodes = [
  {
    id: "scene",
    bookId: "book",
    title: "Scene",
    kind: "scene",
    inTrash: false,
  },
];

test("a new question keeps topic, status, decision, deadline and entries, and a shared one needs canon mode", async () => {
  const t = await setup();
  try {
    t.fake.book = { id: "book", universeId: "world" };
    t.fake.entries = [entry("Keeper")];
    t.fake.nodes = nodes;
    t.state.section = "question";
    await t.mount();
    await t.click(t.button("＋ New"));
    await t.type(t.field("Question"), "The secret");
    await t.type(t.field("Topic"), "Mystery");
    await t.choose(t.field("Status"), "decided");
    await t.click(t.check("Include a decision"));
    await t.choose(t.field("Scope"), "universe");
    await t.choose(t.field("Decide by"), "scene");
    await t.choose(t.field("About entry"), "keeper");
    await t.click(t.button("Add About Entry"));
    assert.equal(t.button("Create Question")!.disabled, true);
    await t.click(t.button("Edit shared details"));
    await t.click(t.button("Create Question"));
    const post = t.fake.calls.find((c) => c.method === "POST")!;
    assert.deepEqual(post.body, {
      text: "The secret",
      topic: "Mystery",
      status: "decided",
      decision: "",
      nodeId: "scene",
      entryIds: ["keeper"],
      scopeKind: "universe",
    });
  } finally {
    await t.cleanup();
  }
});

test("clearing a decision, topic and deadline is explicit, and a saved out-of-scope deadline blocks Save", async () => {
  const t = await setup();
  try {
    t.fake.nodes = nodes;
    t.fake.questions = [
      {
        id: "odd",
        scope: { kind: "book", id: "book" },
        text: "Kept",
        topic: "Old",
        status: "decided",
        decision: "Yes",
        entryIds: [],
        nodeId: "missing",
        updatedAt: now,
      },
    ];
    t.state.section = "question";
    t.state.recordId = "odd";
    await t.mount();
    assert.equal(t.field("Decide by").value, "missing");
    assert.match(t.doc.body.textContent!, /outside selected scope/);
    await t.type(t.field("Topic"), "");
    await t.blur(t.field("Topic"));
    assert.equal(t.fake.puts().length, 0, "a bad deadline is not saved");
    await t.choose(t.field("Decide by"), "");
    assert.equal(t.fake.puts().length, 1, "the fixed draft saves at once");
    await t.click(t.check("Include a decision"));
    await t.choose(t.field("Status"), "open");
    assert.deepEqual(t.fake.puts().at(-1)!.body, {
      text: "Kept",
      topic: null,
      status: "open",
      decision: null,
      nodeId: null,
      entryIds: [],
      expectedUpdatedAt: t.fake.puts().at(-1)!.body.expectedUpdatedAt,
    });
    // Reopening keeps a saved decision unless it is cleared.
    await t.click(t.check("Include a decision"));
    await t.type(t.field("Decision"), "Keep this answer");
    await t.choose(t.field("Status"), "decided");
    await t.choose(t.field("Status"), "open");
    assert.equal(t.fake.puts().at(-1)!.body.decision, "Keep this answer");
    assert.equal(t.fake.puts().at(-1)!.body.status, "open");
  } finally {
    await t.cleanup();
  }
});
