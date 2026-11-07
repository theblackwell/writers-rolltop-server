// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { entry, setup } from "./bible-ui-harness.ts";

type T = Awaited<ReturnType<typeof setup>>;
const sharedScope = { kind: "universe", id: "w1" };
const world = (t: T) => {
  t.fake.book = { id: "book", title: "Moon Book", universeId: "w1" } as any;
  t.fake.worlds = { universes: [{ id: "w1", title: "Aerth" }], series: [] };
};
const open = async (t: T, name: string) => {
  await t.click(t.button(name, t.doc.querySelector("aside")!));
  await t.settle();
};
const control = (t: T) => t.doc.querySelector(".canon-control")!;
const pressed = (t: T, label: string) =>
  t.button(label, control(t))?.getAttribute("aria-pressed");

test("the sidebar shows what the book can see, grouped cards with counts, and a collapsed Trash", async () => {
  const t = await setup();
  try {
    world(t);
    t.fake.entries = [
      entry("Mira Vale"),
      entry("Tom Reed"),
      entry("Old Mill", "location"),
      entry("Gone", "character", { deletedAt: "x" }),
    ];
    await t.mount();
    assert.match(
      t.doc.querySelector(".bible-caption")!.textContent!,
      /Showing what Moon Book can see/,
    );
    const cards = Array.from(t.doc.querySelectorAll("section.bible-card"));
    assert.deepEqual(
      cards.map((c) => c.getAttribute("aria-label")),
      ["Characters", "Locations"],
    );
    assert.equal(cards[0].querySelector(".bible-count")!.textContent, "2");
    assert.equal(cards[1].querySelector(".bible-count")!.textContent, "1");
    const trash = t.doc.querySelector("details.node-trash") as any;
    assert.equal(trash.open, false, "Trash starts collapsed");
    assert.match(trash.textContent, /Trash \(1\)/);
    // Trash is the last group in the sidebar.
    assert.equal(t.doc.querySelector("aside")!.lastElementChild, trash);
    // The four-way switch keeps its behaviour.
    const switcher = t.doc.querySelector(".bible-sections")!;
    assert.deepEqual(
      Array.from(switcher.querySelectorAll("button")).map((b) => b.textContent),
      ["Entries", "Timeline", "Facts", "Questions"],
    );
  } finally {
    await t.cleanup();
  }
});

test("the + menu offers each type, closes on Escape and presets the type in the New Entry dialog", async () => {
  const t = await setup();
  try {
    t.fake.entries = [entry("Mira Vale")];
    await t.mount();
    const plus = t.doc.querySelector(
      'button[aria-label="New entry"]',
    ) as HTMLElement;
    assert.equal(plus.getAttribute("aria-expanded"), "false");
    await t.click(plus);
    assert.equal(plus.getAttribute("aria-expanded"), "true");
    const items = Array.from(t.doc.querySelectorAll('[role="menuitem"]'));
    assert.ok(items.length >= 3);
    assert.ok(items.every((i) => /^New /.test(i.textContent!)));
    await t.React.act(async () => {
      items[0].dispatchEvent(
        new t.dom.window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }),
      );
    });
    assert.equal(t.doc.querySelector('[role="menu"]'), null);
    await t.menu("New entry", "New Location");
    const select = t.doc.querySelector(
      "dialog select[name='entryType']",
    ) as HTMLSelectElement;
    assert.equal(select.value, "location");
    await t.type(
      t.doc.querySelector("dialog input[name='name']") as HTMLInputElement,
      "Harbor",
    );
    await t.React.act(async () => {
      t.doc
        .querySelector("dialog form")!
        .dispatchEvent(
          new t.dom.window.Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    await t.settle();
    const post = t.fake.calls.find(
      (c) => c.method === "POST" && c.path.endsWith("/entries"),
    )!;
    assert.equal(post.body.entryType, "location");
    assert.equal(t.doc.querySelector("article h1")!.textContent, "Harbor");
  } finally {
    await t.cleanup();
  }
});

test("Bible settings holds relationship types and templates", async () => {
  const t = await setup();
  try {
    t.fake.entries = [entry("Mira Vale")];
    await t.mount();
    assert.equal(t.button("Relationship types…"), undefined, "menu is closed");
    await t.menu("Bible settings", "Relationship types…");
    assert.equal(t.state.tool, "relationshipTypes");
    await t.menu("Bible settings", "Templates and Fields…");
    assert.equal(t.state.tool, "templates");
  } finally {
    await t.cleanup();
  }
});

test("the shared-canon control defaults to this book, enables amber canon mode, resets per entry and sends the flag only in canon mode", async () => {
  const t = await setup();
  try {
    world(t);
    t.fake.entries = [
      entry("Old Mill", "location", { scope: sharedScope, summary: "Old" }),
      entry("Harbor", "location", { scope: sharedScope }),
      entry("Mira Vale"),
    ];
    await t.mount();
    await open(t, "Old Mill");
    assert.equal(pressed(t, "In Moon Book only"), "true");
    assert.equal(pressed(t, "Shared canon"), "false");
    assert.equal(control(t).classList.contains("canon"), false);
    assert.equal(t.field("Summary"), undefined, "names are read-only");
    assert.equal(t.button("Edit shared details"), undefined);
    assert.equal(t.fake.puts().length, 0);

    await t.click(t.button("Shared canon", control(t)));
    assert.equal(pressed(t, "Shared canon"), "true");
    assert.equal(control(t).classList.contains("canon"), true);
    assert.match(control(t).textContent!, /Editing shared canon/);
    await t.type(t.field("Summary")!, "New");
    await t.blur(t.field("Summary")!);
    assert.equal(t.fake.puts().length, 1);
    assert.equal(t.fake.puts()[0].body.editSharedCanon, true);

    // Back to this book: the flag is not sent for anything else.
    await t.click(t.button("In Moon Book only", control(t)));
    assert.equal(pressed(t, "In Moon Book only"), "true");
    assert.equal(t.field("Summary"), undefined);
    assert.equal(t.fake.puts().length, 1);

    // Canon mode never carries to another entry.
    await t.click(t.button("Shared canon", control(t)));
    await open(t, "Harbor");
    assert.equal(pressed(t, "In Moon Book only"), "true");
    assert.equal(control(t).classList.contains("canon"), false);

    // A book entry has no control at all.
    await open(t, "Mira Vale");
    assert.equal(t.doc.querySelector(".canon-control"), null);
  } finally {
    await t.cleanup();
  }
});

test("an entry page keeps the iPhone section order", async () => {
  const t = await setup();
  try {
    world(t);
    t.fake.entries = [entry("Mira Vale", "character", { scope: sharedScope })];
    t.fake.facts = [
      {
        id: "f1",
        scope: { kind: "book", id: "book" },
        text: "Mira is brave",
        truth: "true",
        entryIds: ["mira-vale"],
        knowledge: [],
        updatedAt: "u0",
        orderKey: "f1",
      },
    ];
    await t.mount();
    await open(t, "Mira Vale");
    await t.settle();
    const order = Array.from(
      t.doc.querySelectorAll("article > header, article > section"),
    ).map((el) =>
      el.tagName === "HEADER" ? "header" : el.getAttribute("aria-label"),
    );
    const wanted = [
      "header",
      "Shared canon",
      "Names and summary",
      "Family",
      "Fields and attachments",
      "Changes over the story",
      "As of",
      "Relationships",
      "Appears in",
      "Mentioned in",
      "Trash and deletion",
    ];
    assert.deepEqual(order, wanted);
  } finally {
    await t.cleanup();
  }
});
