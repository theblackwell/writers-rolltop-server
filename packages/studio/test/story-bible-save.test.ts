// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { entry, jsonError, setup } from "./bible-ui-harness.ts";

type T = Awaited<ReturnType<typeof setup>>;
const status = (t: T) => t.doc.querySelector(".save-status")?.textContent;
const open = async (t: T, name: string) => {
  await t.click(t.button(name, t.doc.querySelector("aside")!));
  await t.settle();
};
const fields = [
  ["f-role", "Role", "shortText"],
  ["f-age", "Age", "integer"],
  ["f-alive", "Alive", "boolean"],
  ["f-price", "Price", "decimal"],
].map(([id, label, fieldType], i) => ({
  id,
  templateId: "t1",
  label,
  fieldType,
  required: false,
  updatedAt: "fu",
  orderKey: String(i),
}));
const withTemplate = (t: T) => {
  t.fake.catalog = {
    templates: [
      { id: "t1", name: "Character", entryType: "character", updatedAt: "tu" },
    ],
    fields,
  };
};
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
};

test("leaving a field saves it once with the newest updatedAt; Enter saves single-line fields; choices save on change", async () => {
  const t = await setup();
  try {
    withTemplate(t);
    t.fake.entries = [entry("Mira Vale", "character", { templateId: "t1" })];
    await t.mount();
    await open(t, "Mira Vale");
    const summary = t.field("Summary")!;
    await t.type(summary, "A cartographer.");
    assert.equal(t.fake.puts().length, 0, "typing alone does not save");
    assert.equal(status(t), "Not saved");
    await t.blur(summary);
    assert.equal(t.fake.puts().length, 1);
    assert.deepEqual(t.fake.puts()[0].body, {
      summary: "A cartographer.",
      expectedUpdatedAt: "u0",
    });
    assert.equal(status(t), "Saved");
    await t.blur(summary);
    assert.equal(t.fake.puts().length, 1, "an unchanged field does not save");

    // A field value is a separate request carrying the version the summary save returned.
    await t.type(t.field("Role")!, "Mapmaker");
    await t.key(t.field("Role")!, "Enter");
    assert.equal(t.fake.puts().length, 2);
    assert.equal(
      t.fake.puts()[1].path,
      "/books/book/entries/mira-vale/values/f-role",
    );
    assert.deepEqual(t.fake.puts()[1].body, {
      value: "Mapmaker",
      expectedFieldUpdatedAt: "fu",
      expectedUpdatedAt: "u1",
      mode: "canon",
    });

    // Choices save on change, with no blur.
    await t.choose(t.field("Alive") as HTMLSelectElement, "true");
    assert.equal(t.fake.puts().length, 3);
    assert.equal(t.fake.puts()[2].body.value, true);
    assert.equal(t.fake.puts()[2].body.expectedUpdatedAt, "u2");
    const toBeNamed = t.doc.querySelector(
      "article .entry-toggle input",
    ) as HTMLInputElement;
    await t.click(toBeNamed);
    assert.equal(t.fake.puts().length, 4);
    assert.equal(t.fake.puts()[3].body.toBeNamed, true);
    assert.equal(status(t), "Saved");
  } finally {
    await t.cleanup();
  }
});

test("quick edits queue in order, each with the version the previous save returned, and a draft survives the entry's own saves", async () => {
  const t = await setup();
  try {
    withTemplate(t);
    t.fake.entries = [entry("Mira Vale", "character", { templateId: "t1" })];
    await t.mount();
    await open(t, "Mira Vale");
    const first = gate();
    let held = 0;
    t.fake.hold = (call) =>
      call.method === "PUT" && held++ === 0 ? first.promise : undefined;
    await t.type(t.field("Summary")!, "One");
    await t.blur(t.field("Summary")!);
    await t.type(t.field("Role")!, "Two");
    await t.blur(t.field("Role")!);
    await t.type(t.field("Aliases (one per line)")!, "Third");
    await t.blur(t.field("Aliases (one per line)")!);
    // Only the first request has gone out; the others wait their turn.
    assert.equal(t.fake.puts().length, 1);
    assert.equal(status(t), "Saving…");
    // Unsaved header text typed while a save is running is not lost.
    await t.type(t.field("First name")!, "Mirabel");
    first.release();
    await t.settle();
    await t.settle();
    const puts = t.fake.puts();
    assert.equal(puts.length, 3);
    assert.deepEqual(
      puts.map((p) => p.body.expectedUpdatedAt),
      ["u0", "u1", "u2"],
    );
    assert.deepEqual(
      puts.map((p) => p.path.split("/").slice(-1)[0]),
      ["mira-vale", "f-role", "mira-vale"],
    );
    assert.equal(
      t.field("First name")!.value,
      "Mirabel",
      "the first-name draft survives every save",
    );
    assert.equal(status(t), "Not saved", "the draft is still unsaved");
    await t.blur(t.field("First name")!);
    assert.equal(t.fake.puts().length, 4);
    assert.equal(t.fake.puts()[3].body.givenName, "Mirabel");
    assert.equal(t.fake.puts()[3].body.expectedUpdatedAt, "u3");
    assert.equal(status(t), "Saved");
  } finally {
    await t.cleanup();
  }
});

test("a stale write keeps the draft, offers Reload entry, and a reloaded draft is saved or discarded only on request", async () => {
  const t = await setup();
  try {
    t.fake.entries = [entry("Old Mill", "location")];
    await t.mount();
    await open(t, "Old Mill");
    // Another tab changes the entry first.
    t.fake.entries = [
      { ...t.fake.entries[0], updatedAt: "other", summary: "Remote text" },
    ];
    await t.type(t.field("Summary")!, "My draft");
    await t.blur(t.field("Summary")!);
    const alert = t.doc.querySelector(".entry-banner.conflict")!;
    assert.ok(alert, "conflict banner");
    assert.ok(t.button("Reload entry"));
    assert.equal(t.field("Summary")!.value, "My draft", "draft stays in place");
    assert.match(
      (alert.querySelector("textarea") as HTMLTextAreaElement).value,
      /My draft/,
    );
    assert.equal(status(t), "Not saved");
    // Leaving is refused while the stale draft cannot be saved.
    assert.equal(await t.flush(), false);

    await t.click(t.button("Reload entry"));
    await t.settle();
    assert.equal(
      t.field("Summary")!.value,
      "My draft",
      "draft kept after reload",
    );
    assert.ok(t.button("Save My Changes"));
    assert.ok(t.button("Discard My Changes"));
    // Navigation stays refused until the held draft is resolved.
    assert.equal(await t.flush(), false);
    const before = t.fake.puts().length;
    await t.click(t.button("Save My Changes"));
    await t.settle();
    assert.equal(t.fake.puts().length, before + 1);
    assert.equal(t.fake.puts().at(-1)!.body.expectedUpdatedAt, "other");
    assert.equal(t.doc.querySelector(".entry-banner.conflict"), null);
    assert.equal(status(t), "Saved");
    assert.equal(await t.flush(), true);

    // Discard returns the fields to the server's copy.
    t.fake.entries = [{ ...t.fake.entries[0], updatedAt: "third" }];
    await t.type(t.field("Summary")!, "Second draft");
    await t.blur(t.field("Summary")!);
    await t.click(t.button("Reload entry"));
    await t.settle();
    await t.click(t.button("Discard My Changes"));
    await t.settle();
    assert.equal(t.field("Summary")!.value, "My draft");
    assert.equal(status(t), "Saved");
  } finally {
    await t.cleanup();
  }
});

test("validation errors show next to the field and keep the draft; client checks send nothing", async () => {
  const t = await setup();
  try {
    withTemplate(t);
    t.fake.entries = [entry("Mira Vale", "character", { templateId: "t1" })];
    await t.mount();
    await open(t, "Mira Vale");
    await t.type(t.field("Age")!, "forty");
    await t.blur(t.field("Age")!);
    assert.equal(t.fake.puts().length, 0);
    assert.match(t.text(), /Enter an integer/);
    t.fake.intercept = (call) =>
      call.method === "PUT"
        ? jsonError(400, "Use a price the server accepts.")
        : undefined;
    await t.type(t.field("Price")!, "12.50");
    await t.blur(t.field("Price")!);
    assert.equal(t.fake.puts().length, 1);
    const li = t.field("Price")!.closest("li")!;
    assert.match(
      li.querySelector('[role="alert"]')!.textContent!,
      /server accepts/,
    );
    assert.equal(t.field("Price")!.value, "12.50");
    assert.equal(t.doc.querySelector(".entry-banner.conflict"), null);
    assert.equal(status(t), "Not saved");
  } finally {
    await t.cleanup();
  }
});

test("editSharedCanon is sent only after choosing Shared canon, and the mode resets when the entry changes", async () => {
  const t = await setup();
  try {
    withTemplate(t);
    t.fake.catalog.templates[0].entryType = "location";
    t.fake.book = { id: "book", universeId: "w1" };
    t.fake.worlds = { universes: [{ id: "w1", title: "Aerth" }], series: [] };
    t.fake.entries = [
      entry("Old Mill", "location", {
        templateId: "t1",
        scope: { kind: "universe", id: "w1" },
        values: { "f-role": "Canon role" },
        summary: "Canon summary",
      }),
      entry("Mira Vale", "character"),
    ];
    await t.mount();
    await open(t, "Old Mill");
    // The retired per-control consent UI is gone.
    assert.equal(
      t.doc.querySelector('select[aria-label="Edit values for"]'),
      null,
    );
    assert.doesNotMatch(
      t.text(),
      /Save Shared Canon|Assign Shared Template|Shared canon \(all books\)/,
    );
    // This-book mode: header is read-only, field values save as overrides.
    assert.equal(t.field("Summary"), undefined);
    assert.equal(t.button("Edit shared details"), undefined);
    assert.equal(t.doc.querySelector(".canon-control.canon"), null);
    await t.type(t.field("Role")!, "Book role");
    await t.blur(t.field("Role")!);
    assert.equal(t.fake.puts().length, 1);
    assert.equal(t.fake.puts()[0].body.mode, "book");
    assert.equal("editSharedCanon" in t.fake.puts()[0].body, false);

    // The explicit switch shows one amber control naming the world.
    const control = t.doc.querySelector(".canon-control")!;
    await t.click(t.button("Shared canon", control));
    const banner = t.doc.querySelector(".canon-control.canon")!;
    assert.match(banner.textContent!, /Editing shared canon/);
    assert.match(banner.textContent!, /Aerth/);
    assert.equal(t.doc.querySelectorAll(".canon-control").length, 1);
    await t.type(t.field("Summary")!, "New canon summary");
    await t.blur(t.field("Summary")!);
    assert.equal(t.fake.puts().length, 2);
    assert.equal(t.fake.puts()[1].body.editSharedCanon, true);
    await t.type(t.field("Role")!, "Canon again");
    await t.blur(t.field("Role")!);
    assert.equal(t.fake.puts()[2].body.mode, "canon");
    assert.equal(t.fake.puts()[2].body.editSharedCanon, true);

    // Another entry, then back: the page is in this-book mode again.
    await open(t, "Mira Vale");
    await open(t, "Old Mill");
    assert.equal(t.doc.querySelector(".canon-control.canon"), null);
    assert.equal(t.field("Summary"), undefined);
    assert.equal(
      t
        .button("This book only", t.doc.querySelector(".canon-control")!)
        ?.getAttribute("aria-pressed"),
      "true",
    );
  } finally {
    await t.cleanup();
  }
});

test("Use Canon Again still removes this book's override without a shared-canon flag", async () => {
  const t = await setup();
  try {
    withTemplate(t);
    t.fake.catalog.templates[0].entryType = "location";
    t.fake.book = { id: "book", universeId: "w1" };
    t.fake.entries = [
      entry("Old Mill", "location", {
        templateId: "t1",
        scope: { kind: "universe", id: "w1" },
        values: { "f-role": "Canon role" },
        overrides: [{ bookId: "book", values: { "f-role": "Book role" } }],
      }),
    ];
    await t.mount();
    await open(t, "Old Mill");
    assert.equal(t.field("Role")!.value, "Book role");
    await t.click(t.button("Use Canon Again for Role"));
    await t.settle();
    const put = t.fake.puts()[0];
    assert.equal(put.path, "/books/book/entries/old-mill/values/f-role");
    assert.equal(put.body.value, null);
    assert.equal(put.body.mode, "book");
    assert.equal("editSharedCanon" in put.body, false);
    assert.equal(t.field("Role")!.value, "Canon role");
    assert.equal(t.button("Use Canon Again for Role"), undefined);
  } finally {
    await t.cleanup();
  }
});

test("an open draft is saved before another entry, a tool or a view change, and a failed save refuses the move", async () => {
  const t = await setup();
  try {
    t.fake.entries = [
      entry("Old Mill", "location"),
      entry("Harbor", "location"),
    ];
    await t.mount();
    await open(t, "Old Mill");
    // Switching entries flushes the draft first (no blur happened).
    await t.type(t.field("Summary")!, "Mill draft");
    await open(t, "Harbor");
    assert.equal(t.fake.puts().length, 1);
    assert.equal(t.fake.puts()[0].path, "/books/book/entries/old-mill");
    assert.equal(t.fake.puts()[0].body.summary, "Mill draft");
    assert.equal(t.doc.querySelector("article h1")!.textContent, "Harbor");

    // The app's leave() calls this before it changes tabs.
    await t.type(t.field("Summary")!, "Harbor draft");
    assert.equal(await t.flush(), true);
    assert.equal(t.fake.puts().at(-1)!.body.summary, "Harbor draft");

    // A tool is a move too.
    await t.type(t.field("Summary")!, "Harbor draft two");
    await t.menu("Bible settings", "Relationship types…");
    assert.equal(t.fake.puts().at(-1)!.body.summary, "Harbor draft two");
    assert.equal(t.state.tool, "relationshipTypes");
    await t.click(t.button("Harbor", t.doc.querySelector("aside")!));

    // A failing save blocks the move and leaves the draft and error visible.
    t.fake.intercept = (call) =>
      call.method === "PUT" ? jsonError(400, "Summary rejected.") : undefined;
    await t.type(t.field("Summary")!, "Bad draft");
    const count = t.fake.puts().length;
    await t.click(t.button("Old Mill", t.doc.querySelector("aside")!));
    await t.settle();
    assert.equal(t.fake.puts().length, count + 1);
    assert.equal(t.doc.querySelector("article h1")!.textContent, "Harbor");
    assert.equal(t.state.selected, "harbor");
    assert.equal(t.field("Summary")!.value, "Bad draft");
    assert.match(t.text(), /Summary rejected\./);
    assert.match(t.text(), /not saved yet|Not saved/);
    assert.equal(await t.flush(), false);
    await t.menu("Bible settings", "Relationship types…");
    assert.equal(
      t.state.tool,
      null,
      "a failed flush also blocks opening a tool",
    );

    // Once the server accepts it, the move goes through.
    t.fake.intercept = undefined;
    assert.equal(await t.flush(), true);
    await open(t, "Old Mill");
    assert.equal(t.doc.querySelector("article h1")!.textContent, "Old Mill");
  } finally {
    await t.cleanup();
  }
});

test("a link from Names Still Needed or a warning selects the entry after flushing, and refuses when the flush fails", async () => {
  const { prepareEntryPlace } =
    await import("../../../apps/web/src/entry-navigation.ts");
  const { flushAll } = await import("../../../apps/web/src/leave.ts");
  const live = [
    entry("Mira Vale"),
    entry("Gone", "character", { deletedAt: "x" }),
  ];
  let loaded = 0;
  const load = async () => (loaded++, live);
  await assert.rejects(
    prepareEntryPlace("mira-vale", async () => false, load),
    /unsaved changes/,
  );
  assert.equal(loaded, 0, "nothing loads when the flush fails");
  await assert.rejects(
    prepareEntryPlace("gone", async () => true, load),
    /no longer live/,
  );
  assert.equal(
    await prepareEntryPlace("mira-vale", async () => true, load),
    "mira-vale",
  );
  // leave() runs the scene editor and the bible page; either failing stops the move.
  const order: string[] = [];
  assert.equal(
    await flushAll(
      async () => (order.push("scene"), true),
      null,
      async () => (order.push("bible"), false),
      async () => (order.push("never"), true),
    ),
    false,
  );
  assert.deepEqual(order, ["scene", "bible"]);
  assert.equal(await flushAll(undefined, null), true);

  // The selection the app sets from outside opens that entry's page.
  const t = await setup();
  try {
    t.fake.entries = [entry("Mira Vale", "character", { toBeNamed: true })];
    t.state.selected = "mira-vale";
    await t.mount();
    assert.equal(t.doc.querySelector("article h1")!.textContent, "Mira Vale");
    assert.equal(
      t.doc
        .querySelector('[aria-current="true"]')
        ?.textContent?.startsWith("Mira Vale"),
      true,
    );
  } finally {
    await t.cleanup();
  }
});
