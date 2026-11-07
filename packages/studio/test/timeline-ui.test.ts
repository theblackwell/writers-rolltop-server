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
  { id: "far", bookId: "other", title: "Far", kind: "scene", inTrash: false },
];

test("a new event keeps date, calendar, order, scenes, entry and roles, and a shared one needs canon mode", async () => {
  const t = await setup();
  try {
    t.fake.book = { id: "book", universeId: "world" };
    t.fake.entries = [entry("Keeper"), entry("Storm", "event")];
    t.fake.nodes = nodes;
    t.state.section = "event";
    await t.mount();
    await t.click(t.button("＋ New"));
    await t.type(t.field("Event"), "Storm");
    await t.click(t.check("Include a summary"));
    await t.choose(t.field("Scope"), "universe");
    await t.choose(t.field("Event entry"), "storm");
    await t.click(t.check("Include a story date"));
    await t.type(t.field("As written"), "Third moon");
    await t.type(t.field("Calendar"), "Old calendar");
    await t.type(t.field("Order number"), "-3");
    await t.choose(t.field("Add scene"), "scene");
    await t.click(t.button("Add Scene"));
    await t.choose(t.field("Add participant"), "keeper");
    await t.click(t.button("Add Participant"));
    const role = Array.from(t.doc.querySelectorAll("label")).find((l) =>
      l.textContent?.startsWith("Role for"),
    )!.firstChild!.textContent!;
    await t.type(t.field(role), "Witness");
    assert.equal(t.button("Create Event")!.disabled, true);
    await t.click(t.button("Edit shared details"));
    await t.click(t.button("Create Event"));
    const post = t.fake.calls.find((c) => c.method === "POST")!;
    assert.deepEqual(post.body, {
      title: "Storm",
      summary: "",
      when: { label: "Third moon", calendar: "Old calendar", ordinal: -3 },
      entryId: "storm",
      sceneIds: ["scene"],
      participants: [{ entryId: "keeper", role: "Witness" }],
      scopeKind: "universe",
    });
  } finally {
    await t.cleanup();
  }
});

test("the order number must be a whole number, and saved links that no longer fit are kept until removed", async () => {
  const t = await setup();
  try {
    t.fake.nodes = nodes;
    t.fake.events = [
      {
        id: "odd",
        scope: { kind: "book", id: "book" },
        title: "Kept",
        when: { label: "Kept date", ordinal: 0 },
        summary: "",
        entryId: "missing",
        sceneIds: ["far"],
        participants: [{ entryId: "missing", role: "Kept role" }],
        orderKey: "a",
        updatedAt: now,
      },
    ];
    t.state.section = "event";
    t.state.recordId = "odd";
    await t.mount();
    assert.equal(t.field("Event entry").value, "missing");
    assert.match(t.doc.body.textContent!, /outside selected scope/);
    assert.match(t.doc.body.textContent!, /Unavailable entry/);
    await t.type(t.field("Event"), "Kept, edited");
    await t.blur(t.field("Event"));
    await t.choose(t.field("Event entry"), "");
    await t.click(t.button("Remove Scene"));
    assert.equal(t.fake.puts().length, 0, "a saved bad link blocks saving");
    await t.click(t.button("Remove Participant"));
    assert.equal(t.fake.puts().length, 1, "the fixed draft saves at once");
    // "0" is the saved order number, so it needs no write.
    for (const bad of ["1.5", "9007199254740992", "0"]) {
      const before = t.fake.puts().length;
      await t.type(t.field("Order number"), bad);
      await t.blur(t.field("Order number"));
      assert.equal(t.fake.puts().length, before, bad);
    }
    await t.click(t.check("Include a summary"));
    await t.click(t.check("Include a story date"));
    assert.deepEqual(t.fake.puts().at(-1)!.body, {
      title: "Kept, edited",
      summary: null,
      when: null,
      entryId: null,
      sceneIds: [],
      participants: [],
      expectedUpdatedAt: "u2",
    });
  } finally {
    await t.cleanup();
  }
});
