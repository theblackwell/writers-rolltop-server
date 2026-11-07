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
    assert.equal(t.button("Save Event")!.disabled, true);
    await t.click(t.button("Edit shared details"));
    await t.click(t.button("Save Event"));
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
    assert.equal(t.button("Save Event")!.disabled, true);
    await t.choose(t.field("Event entry"), "");
    await t.click(t.button("Remove Scene"));
    await t.click(t.button("Remove Participant"));
    for (const [bad, ok] of [
      ["1.5", false],
      ["9007199254740992", false],
      ["0", true],
    ] as const) {
      await t.type(t.field("Order number"), bad);
      assert.equal(t.button("Save Event")!.disabled, !ok, bad);
    }
    await t.click(t.check("Include a summary"));
    await t.click(t.check("Include a story date"));
    await t.click(t.button("Save Event"));
    assert.deepEqual(t.fake.puts()[0].body, {
      title: "Kept, edited",
      summary: null,
      when: null,
      entryId: null,
      sceneIds: [],
      participants: [],
      expectedUpdatedAt: "u0",
    });
  } finally {
    await t.cleanup();
  }
});
