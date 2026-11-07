// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { entry, jsonError, now, setup } from "./bible-ui-harness.ts";

type T = Awaited<ReturnType<typeof setup>>;
const book = { id: "book", universeId: "world" };
const fact = (id: string, text: string, extra = {}) => ({
  id,
  scope: { kind: "book", id: "book" },
  text,
  truth: "true",
  entryIds: [] as string[],
  knowledge: [] as any[],
  updatedAt: now,
  orderKey: id,
  ...extra,
});
const shared = { scope: { kind: "universe", id: "world" } };
const question = (id: string, text: string, extra = {}) => ({
  id,
  scope: { kind: "book", id: "book" },
  text,
  status: "open",
  entryIds: [] as string[],
  updatedAt: now,
  ...extra,
});
const event = (id: string, title: string, extra = {}) => ({
  id,
  scope: { kind: "book", id: "book" },
  title,
  sceneIds: [] as string[],
  participants: [] as any[],
  orderKey: id,
  updatedAt: now,
  ...extra,
});
const open = async (t: T, section: string, recordId?: string) => {
  t.state.section = section;
  t.state.recordId = recordId;
  await t.mount();
};
const pageText = (t: T) =>
  t.doc.querySelector(".bible-area")?.textContent ?? "";
const status = (t: T) => t.doc.querySelector(".save-status")?.textContent;
const disabled = (el: Element) => el.matches(":disabled");

test("each record list shows live records, filters them and keeps Trash collapsed", async () => {
  const t = await setup();
  try {
    t.fake.facts = [
      fact("f1", "The moon is hollow"),
      fact("f2", "Keeper lied", { truth: "false" }),
      fact("f3", "Retired idea", { deletedAt: "x" }),
    ];
    t.fake.questions = [
      question("q1", "Who has the key?"),
      question("q2", "Is the bridge safe?", { status: "decided" }),
    ];
    t.fake.events = [
      event("e1", "Storm", { when: { label: "Late", ordinal: 2 } }),
      event("e2", "Landing", { when: { label: "Early", ordinal: 1 } }),
    ];
    await open(t, "fact");
    const list = () =>
      Array.from(t.doc.querySelectorAll('ul[aria-label="Facts"] .bible-row'));
    assert.deepEqual(
      list().map((b) => b.textContent),
      ["The moon is hollowTrue", "Keeper liedNot true"],
    );
    const details = t.doc.querySelector("details.node-trash") as any;
    assert.equal(details.open, false, "Trash starts collapsed");
    assert.match(details.textContent, /Trash \(1\)/);
    await t.type(t.field("Find fact"), "moon");
    assert.equal(list().length, 1);
    await t.type(t.field("Find fact"), "");
    await t.choose(t.field("Show"), "false");
    assert.deepEqual(
      list().map((b) => b.textContent),
      ["Keeper liedNot true"],
    );

    await t.click(
      t.button("Questions", t.doc.querySelector(".bible-sections")!),
    );
    assert.equal(t.state.section, "question");
    assert.equal(
      t.doc.querySelector("aside")!.getAttribute("aria-label"),
      "Story Bible questions",
    );
    assert.ok(t.row("Who has the key?"));
    await t.choose(t.field("Show"), "decided");
    assert.equal(t.doc.querySelectorAll(".bible-row").length, 1);

    await t.click(
      t.button("Timeline", t.doc.querySelector(".bible-sections")!),
    );
    const titles = () =>
      Array.from(t.doc.querySelectorAll(".record-row-title")).map(
        (e) => e.textContent,
      );
    assert.deepEqual(titles(), ["Landing", "Storm"], "story date order");
    assert.ok(t.field("Order"), "ordering view stays reachable");
    assert.match(pageText(t), /Pick a timeline event/);
  } finally {
    await t.cleanup();
  }
});

test("a trashed record opens read-only in the Trash group and restores through the queue", async () => {
  const t = await setup();
  try {
    t.fake.facts = [fact("f3", "Retired idea", { deletedAt: "x" })];
    await open(t, "fact", "f3");
    assert.equal(
      (t.doc.querySelector("details.node-trash") as any).open,
      true,
      "selecting a trashed record opens Trash",
    );
    assert.match(pageText(t), /In Trash/);
    assert.equal(t.doc.querySelector("form"), null);
    await t.click(t.button("Restore Fact"));
    assert.deepEqual(t.fake.puts()[0].body, {
      deleted: false,
      expectedUpdatedAt: "u0",
    });
    assert.ok(t.doc.querySelector("form"), "the form is back once restored");
  } finally {
    await t.cleanup();
  }
});

test("a record page saves through the queue with the newest updatedAt", async () => {
  const t = await setup();
  try {
    t.fake.facts = [fact("f1", "The moon is hollow"), fact("f2", "Other")];
    await open(t, "fact");
    await t.click(t.row("The moon"));
    assert.equal(status(t), "Saved");
    await t.type(t.field("Fact"), "The moon is solid");
    assert.equal(status(t), "Not saved");
    assert.equal(t.fake.puts().length, 0, "typing alone does not save");
    await t.blur(t.field("Fact"));
    assert.equal(status(t), "Saved");
    await t.type(t.field("Fact"), "The moon is cheese");
    await t.blur(t.field("Fact"));
    const [a, b] = t.fake.puts().map((c) => c.body);
    assert.equal(a.expectedUpdatedAt, "u0");
    assert.equal(
      b.expectedUpdatedAt,
      "u1",
      "the second write is built on the first",
    );
    assert.equal(a.editSharedCanon, undefined);
    assert.ok(t.row("The moon is cheese"), "the list shows the saved text");
    // Leaving the page saves an existing record's unsaved change.
    await t.type(t.field("Fact"), "The moon is rock");
    assert.equal(await t.flush(), true);
    assert.equal(t.fake.facts[0].text, "The moon is rock");
  } finally {
    await t.cleanup();
  }
});

test("a stale write keeps the draft with a Reload path, and a failed flush blocks switching records", async () => {
  const t = await setup();
  try {
    t.fake.facts = [fact("f1", "First"), fact("f2", "Second")];
    await open(t, "fact", "f1");
    await t.type(t.field("Fact"), "First, edited");
    t.fake.intercept = (c) =>
      c.method === "PUT" ? jsonError(409, "This fact changed.") : undefined;
    await t.blur(t.field("Fact"));
    assert.match(pageText(t), /changed somewhere else/);
    assert.equal(t.field("Fact").value, "First, edited", "the draft stays");
    assert.equal(await t.flush(), false, "leaving is refused");
    await t.click(t.row("Second"));
    assert.equal(t.state.recordId, "f1", "the other record did not open");
    assert.equal(t.field("Fact").value, "First, edited");
    t.fake.intercept = undefined;
    await t.click(t.button("Reload fact"));
    assert.match(pageText(t), /Latest version loaded/);
    assert.equal(t.field("Fact").value, "First, edited");
    await t.blur(t.field("Fact"));
    assert.doesNotMatch(pageText(t), /changed somewhere else|Latest version/);
    assert.equal(t.fake.facts[0].text, "First, edited");
    assert.equal(await t.flush(), true);
  } finally {
    await t.cleanup();
  }
});

test("a draft that cannot be saved blocks the move, and a new record's draft is never created by leaving", async () => {
  const t = await setup();
  try {
    t.fake.facts = [fact("f1", "First"), fact("f2", "Second")];
    await open(t, "fact", "f1");
    await t.type(t.field("Fact"), "");
    await t.click(t.row("Second"));
    assert.equal(t.state.recordId, "f1");
    assert.match(pageText(t), /not saved/i);
    await t.click(t.button("Discard Changes"));
    assert.equal(t.field("Fact").value, "First");
    await t.click(t.button("＋ New"));
    await t.type(t.field("Fact"), "Half-written");
    assert.equal(await t.flush(), false);
    await t.click(t.row("Second"));
    assert.equal(t.state.recordId, undefined, "the new record stays open");
    assert.equal(t.field("Fact").value, "Half-written");
    assert.equal(t.fake.facts.length, 2, "nothing was created");
    await t.click(t.button("Cancel"));
    assert.equal(await t.flush(), true);
  } finally {
    await t.cleanup();
  }
});

const noSaveButton = (t: T) =>
  assert.equal(
    Array.from(t.doc.querySelectorAll(".bible-area button")).filter((b) =>
      /^Save\b/.test(b.textContent ?? ""),
    ).length,
    0,
    "no Save button on a record page",
  );

test("record pages have no Save button; a new record has Create, and leaving never creates it", async () => {
  const t = await setup();
  try {
    t.fake.facts = [fact("f1", "First")];
    t.fake.questions = [question("q1", "Who?")];
    t.fake.events = [event("e1", "Storm")];
    for (const [section, id] of [
      ["fact", "f1"],
      ["question", "q1"],
      ["event", "e1"],
    ]) {
      await open(t, section, id);
      noSaveButton(t);
      await t.click(t.button("＋ New"));
      noSaveButton(t);
      assert.ok(t.button("Create "), section + " has a Create button");
    }
  } finally {
    await t.cleanup();
  }
});

test("a question saves on blur and Enter with one PUT each, on the newest updatedAt", async () => {
  const t = await setup();
  try {
    t.fake.questions = [question("q1", "Who has the key?")];
    await open(t, "question", "q1");
    await t.type(t.field("Question"), "Who holds the key?");
    await t.blur(t.field("Question"));
    assert.equal(t.fake.puts().length, 1);
    await t.type(t.field("Topic"), "Keys");
    await t.key(t.field("Topic"), "Enter");
    await t.blur(t.field("Topic"));
    assert.equal(t.fake.puts().length, 2, "Enter then blur sends one write");
    assert.deepEqual(
      t.fake.puts().map((c) => c.body.expectedUpdatedAt),
      ["u0", "u1"],
    );
    assert.equal(t.fake.puts()[1].body.topic, "Keys");
    await t.blur(t.field("Topic"));
    assert.equal(t.fake.puts().length, 2, "an unchanged field sends nothing");
    assert.equal(status(t), "Saved");
  } finally {
    await t.cleanup();
  }
});

test("a fact's selections, checkboxes and list rows save at once", async () => {
  const t = await setup();
  try {
    t.fake.entries = [entry("Keeper")];
    t.fake.facts = [fact("f1", "The moon is hollow")];
    await open(t, "fact", "f1");
    await t.choose(t.field("Truth"), "false");
    assert.equal(t.fake.puts().length, 1);
    assert.equal(t.fake.puts()[0].body.truth, "false");
    await t.choose(t.field("About entry"), "keeper");
    assert.equal(t.fake.puts().length, 1, "choosing in the picker alone waits");
    await t.click(t.button("Add About Entry"));
    assert.equal(t.fake.puts().length, 2);
    assert.deepEqual(t.fake.puts()[1].body.entryIds, ["keeper"]);
    assert.equal(t.fake.puts()[1].body.expectedUpdatedAt, "u1");
    await t.click(t.button("Remove"));
    assert.deepEqual(t.fake.puts()[2].body.entryIds, []);
    assert.equal(status(t), "Saved");
  } finally {
    await t.cleanup();
  }
});

test("leaving a record saves a valid draft first; an invalid draft or a conflict refuses the move", async () => {
  const t = await setup();
  try {
    t.fake.questions = [question("q1", "One"), question("q2", "Two")];
    await open(t, "question", "q1");
    await t.type(t.field("Question"), "One, edited");
    await t.click(t.row("Two"));
    assert.equal(t.fake.questions[0].text, "One, edited");
    assert.equal(t.state.recordId, "q2", "the valid draft saved, then moved");
    await t.type(t.field("Question"), "");
    await t.click(t.row("One"));
    assert.equal(t.state.recordId, "q2", "an invalid draft refuses the move");
    assert.equal(t.field("Question").value, "");
    assert.equal(t.fake.puts().length, 1);
    await t.type(t.field("Question"), "Two, edited");
    t.fake.intercept = (c) =>
      c.method === "PUT" ? jsonError(409, "Changed.") : undefined;
    await t.click(t.row("One"));
    assert.equal(t.state.recordId, "q2", "a conflict refuses the move");
    assert.equal(t.field("Question").value, "Two, edited");
    assert.match(pageText(t), /changed somewhere else/);
  } finally {
    await t.cleanup();
  }
});

test("a shared record opens in this-book mode and needs the page switch before a shared write", async () => {
  const t = await setup();
  try {
    t.fake.book = book;
    t.fake.facts = [
      fact("s1", "Shared one", shared),
      fact("s2", "Shared two", shared),
    ];
    await open(t, "fact", "s1");
    assert.match(pageText(t), /shared across this world, so it is read-only/);
    assert.ok(disabled(t.field("Fact")), "fields are read-only");
    assert.ok(
      disabled(t.button("Move Fact to Trash")!),
      "Trash needs canon mode",
    );
    assert.doesNotMatch(
      pageText(t),
      /Apply this change to the shared|Create this shared/,
      "no per-form checkbox remains",
    );
    assert.equal(t.fake.puts().length, 0);
    await t.click(t.button("Edit shared details"));
    assert.match(pageText(t), /Editing shared canon/);
    assert.equal(
      t.doc.querySelectorAll('[aria-label="Shared canon"]').length,
      1,
    );
    await t.type(t.field("Fact"), "Shared one, edited");
    await t.blur(t.field("Fact"));
    assert.deepEqual(t.fake.puts()[0].body.editSharedCanon, true);
    // Canon mode belongs to one record.
    await t.click(t.row("Shared two"));
    assert.equal(t.state.recordId, "s2");
    assert.doesNotMatch(pageText(t), /Editing shared canon/);
    assert.ok(disabled(t.field("Fact")));
    await t.click(t.button("Edit shared details"));
    await t.click(t.button("Back to This Book Only"));
    assert.match(pageText(t), /read-only/);
    // Book records never send the flag.
    t.fake.facts = [...t.fake.facts, fact("b1", "Mine")];
    await t.remount();
    await t.click(t.row("Mine"));
    await t.type(t.field("Fact"), "Mine, edited");
    await t.blur(t.field("Fact"));
    assert.equal(t.fake.puts().at(-1)!.body.editSharedCanon, undefined);
    assert.equal(t.doc.querySelector('[aria-label="Shared canon"]'), null);
  } finally {
    await t.cleanup();
  }
});

test("a new shared record needs the page switch, and trashing a shared record sends canon consent", async () => {
  const t = await setup();
  try {
    t.fake.book = book;
    t.fake.questions = [question("q1", "Shared Q", shared)];
    await open(t, "question");
    await t.click(t.button("＋ New"));
    await t.type(t.field("Question"), "Who built it?");
    assert.equal(t.doc.querySelector('[aria-label="Shared canon"]'), null);
    await t.choose(t.field("Scope"), "universe");
    assert.match(pageText(t), /will be shared across the world/);
    assert.ok(disabled(t.button("Create Question")!));
    await t.click(t.button("Edit shared details"));
    assert.ok(!disabled(t.button("Create Question")!));
    await t.click(t.button("Create Question"));
    const post = t.fake.calls.find((c) => c.method === "POST")!;
    assert.equal(post.body.scopeKind, "universe");
    assert.equal(post.body.editSharedCanon, undefined, "create sends no flag");
    assert.equal(t.fake.questions.length, 2);
    assert.equal(t.state.recordId, "questions-2", "the new record opens");
    // Trash a shared record.
    await t.click(t.row("Shared Q"));
    await t.click(t.button("Edit shared details"));
    await t.click(t.button("Move Question to Trash"));
    assert.deepEqual(t.fake.puts()[0].body, {
      deleted: true,
      expectedUpdatedAt: "u0",
      editSharedCanon: true,
    });
    assert.match(pageText(t), /In Trash/);
  } finally {
    await t.cleanup();
  }
});

test("a record page names its entries and links to them; entry pages list live mentions only", async () => {
  const t = await setup();
  try {
    t.fake.entries = [
      entry("Keeper"),
      entry("Lonely"),
      entry("Storm Entry", "event"),
    ];
    t.fake.facts = [
      fact("f1", "Keeper is old", { entryIds: ["keeper"] }),
      fact("f2", "Only Keeper knows", {
        knowledge: [{ knower: "keeper" }, { knower: "reader" }],
      }),
      fact("f3", "Trashed fact", { entryIds: ["keeper"], deletedAt: "x" }),
      fact("f4", "Unrelated", { entryIds: ["lonely"] }),
    ];
    t.fake.questions = [
      question("q1", "Where is Keeper?", { entryIds: ["keeper"] }),
      question("q2", "Trashed question", {
        entryIds: ["keeper"],
        deletedAt: "x",
      }),
    ];
    t.fake.events = [
      event("e1", "Storm hits", { entryId: "keeper" }),
      event("e2", "Keeper arrives", {
        participants: [{ entryId: "keeper", role: "Witness" }],
      }),
      event("e3", "Trashed event", { entryId: "keeper", deletedAt: "x" }),
    ];
    t.state.selected = "keeper";
    await t.mount();
    const mentioned = () =>
      Array.from(t.doc.querySelectorAll('[aria-label="Mentioned in"] li')).map(
        (li) => li.textContent,
      );
    assert.deepEqual(mentioned(), [
      "Storm hits Event entry",
      "Keeper arrives Involved: Witness",
      "Keeper is old About",
      "Only Keeper knows Knows it",
      "Where is Keeper? About",
    ]);
    // Opening a mention goes to the record page.
    await t.click(
      t.button(
        "Keeper is old",
        t.doc.querySelector('[aria-label="Mentioned in"]')!,
      ),
    );
    assert.equal(t.state.section, "fact");
    assert.equal(t.state.recordId, "f1");
    assert.match(pageText(t), /Entries named/);
    // ...and the record page links back to the entry.
    await t.click(
      t.button("Keeper", t.doc.querySelector('[aria-label="Entries named"]')!),
    );
    assert.equal(t.state.section, "entries");
    assert.equal(t.state.selected, "keeper");
    assert.match(pageText(t), /Mentioned in/);
    // An entry nothing names says so.
    t.state.selected = "storm-entry";
    await t.mount();
    assert.match(
      pageText(t),
      /No facts, questions or timeline events name this entry yet/,
    );
  } finally {
    await t.cleanup();
  }
});

test("a record opened from elsewhere offers a way back", async () => {
  const t = await setup();
  try {
    t.fake.events = [event("e1", "Storm")];
    let went = 0;
    t.state.back = { label: "Back to warnings", onClick: () => (went += 1) };
    await open(t, "event", "e1");
    await t.click(t.button("Back to warnings"));
    assert.equal(went, 1);
    // The back control is also on the empty state when the record is gone.
    await open(t, "event", "gone");
    assert.match(pageText(t), /no longer available/);
    assert.ok(t.button("Back to warnings"));
  } finally {
    await t.cleanup();
  }
});
