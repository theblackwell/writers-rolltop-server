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
  // In a book the fake does not list, so it is outside every scope here.
  { id: "far", bookId: "other", title: "Far", kind: "chapter", inTrash: false },
  {
    id: "chapter",
    bookId: "book",
    title: "Chapter",
    kind: "chapter",
    inTrash: false,
  },
];

test("a new fact keeps every field, who knows it from when, and creates a shared fact only in canon mode", async () => {
  const t = await setup();
  try {
    t.fake.book = { id: "book", universeId: "world" };
    t.fake.entries = [entry("Keeper")];
    t.fake.nodes = nodes;
    t.state.section = "fact";
    await t.mount();
    await t.click(t.button("＋ New"));
    await t.type(t.field("Fact"), "The secret");
    await t.choose(t.field("Truth"), "false");
    await t.choose(t.field("Scope"), "universe");
    await t.choose(t.field("Established in"), "scene");
    await t.choose(t.field("About entry"), "keeper");
    await t.click(t.button("Add About Entry"));
    await t.choose(t.field("Add knower"), "reader");
    await t.click(t.button("Add Knower"));
    await t.choose(t.field("Add knower"), "keeper");
    await t.click(t.button("Add Knower"));
    const learns = Array.from(t.doc.querySelectorAll("label")).find(
      (l) =>
        l.textContent?.includes("Keeper") &&
        l.textContent?.includes("learns it"),
    )!;
    await t.choose(learns.querySelector("select")!, "chapter");
    assert.equal(
      t.button("Create Fact")!.disabled,
      true,
      "a shared fact needs the page switch",
    );
    await t.click(t.button("Edit shared details"));
    await t.click(t.button("Create Fact"));
    const post = t.fake.calls.find((c) => c.method === "POST")!;
    assert.deepEqual(post.body, {
      text: "The secret",
      truth: "false",
      nodeId: "scene",
      entryIds: ["keeper"],
      knowledge: [
        { knower: "reader", nodeId: "scene" },
        { knower: "keeper", nodeId: "chapter" },
      ],
      scopeKind: "universe",
    });
    // The saved fact opens on its page with its knowledge intact.
    assert.equal(t.state.recordId, "facts-1");
    assert.match(t.doc.body.textContent!, /Keeper/);
    assert.equal(t.fake.facts[0].knowledge.length, 2);
  } finally {
    await t.cleanup();
  }
});

test("a saved point outside the fact's scope is shown and kept until it is cleared", async () => {
  const t = await setup();
  try {
    t.fake.nodes = nodes;
    t.fake.facts = [
      {
        id: "odd",
        scope: { kind: "book", id: "book" },
        text: "Kept",
        truth: "true",
        entryIds: [],
        knowledge: [{ knower: "reader", nodeId: "far" }],
        nodeId: "missing",
        updatedAt: now,
      },
    ];
    t.state.section = "fact";
    t.state.recordId = "odd";
    await t.mount();
    assert.equal(t.field("Established in").value, "missing");
    assert.match(t.doc.body.textContent!, /outside selected scope/);
    assert.equal(t.doc.querySelectorAll('option[value="far"]').length, 1);
    await t.type(t.field("Fact"), "Kept, edited");
    await t.blur(t.field("Fact"));
    assert.equal(t.fake.puts().length, 0, "a bad point is not saved");
    await t.choose(t.field("Established in"), "");
    assert.equal(t.fake.puts().length, 0, "knowledge point still bad");
    await t.click(t.button("Remove Knower"));
    assert.deepEqual(t.fake.puts()[0].body, {
      text: "Kept, edited",
      truth: "true",
      nodeId: null,
      entryIds: [],
      knowledge: [],
      expectedUpdatedAt: "u0",
    });
  } finally {
    await t.cleanup();
  }
});
