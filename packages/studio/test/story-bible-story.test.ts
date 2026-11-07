// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { entry, jsonError, setup } from "./bible-ui-harness.ts";

type T = Awaited<ReturnType<typeof setup>>;
const open = async (t: T, name: string) => {
  await t.click(t.button(name, t.doc.querySelector("aside")!));
  await t.settle();
};
const section = (t: T, label: string) =>
  t.doc.querySelector(`section[aria-label="${label}"]`)!;
const within = (t: T, root: ParentNode, label: string): any =>
  Array.from(root.querySelectorAll("label"))
    .find((l) => l.firstChild?.textContent?.trim() === label)
    ?.querySelector("input,textarea,select");
const writes = (t: T) => t.fake.calls.filter((c) => c.method !== "GET");

const setupStory = async () => {
  const t = await setup();
  t.fake.entries = [
    entry("Mira Vale", "character", {
      templateId: "t1",
      values: { role: "Cook" },
    }),
    entry("Tom Reed", "character", { templateId: "t1" }),
    entry("Harbor", "location"),
  ];
  t.fake.catalog = {
    templates: [
      { id: "t1", name: "Character", entryType: "character", updatedAt: "tu" },
    ],
    fields: [
      {
        id: "role",
        templateId: "t1",
        label: "Role",
        fieldType: "shortText",
        required: false,
        updatedAt: "fu",
        orderKey: "a",
      },
    ],
  };
  t.fake.relationshipTypes = [
    {
      id: "parent",
      label: "parent of",
      inverseLabel: "child of",
      updatedAt: "ru",
    },
  ];
  t.fake.relationships = [
    {
      id: "l1",
      typeId: "parent",
      fromEntryId: "mira-vale",
      toEntryId: "tom-reed",
      bookId: "book",
      updatedAt: "lu",
    },
    {
      id: "l2",
      typeId: "parent",
      fromEntryId: "tom-reed",
      toEntryId: "harbor",
      bookId: "book",
      updatedAt: "lu",
    },
  ];
  t.fake.nodes = [
    {
      id: "ch1",
      bookId: "book",
      title: "Chapter One",
      kind: "chapter",
      orderKey: "a",
      inTrash: false,
    },
    {
      id: "sc1",
      bookId: "book",
      parentId: "ch1",
      title: "Opening",
      kind: "scene",
      orderKey: "a",
      inTrash: false,
    },
  ];
  await t.mount();
  return t;
};

test("the entry page lists only this entry's links; Add sends this entry as the source and the new link shows only on the related pages", async () => {
  const t = await setupStory();
  try {
    await open(t, "Mira Vale");
    const rel = section(t, "Relationships");
    assert.match(rel.textContent!, /Mira Vale\s+parent of\s+Tom Reed/);
    assert.doesNotMatch(rel.textContent!, /Harbor/);
    // The other end reads the inverse label and links to the other page.
    await open(t, "Tom Reed");
    assert.match(
      section(t, "Relationships").textContent!,
      /child of\s*Mira Vale/,
    );
    assert.match(
      section(t, "Relationships").textContent!,
      /parent of\s*Harbor/,
    );
    await t.click(t.button("Mira Vale", section(t, "Relationships")));
    await t.settle();
    assert.equal(t.doc.querySelector("article h1")!.textContent, "Mira Vale");

    await t.click(t.button("Add Relationship…"));
    const form = section(t, "Relationships");
    assert.equal(within(t, form, "First entry").value, "mira-vale");
    assert.equal(within(t, form, "First entry").disabled, true);
    await t.choose(within(t, form, "Second entry"), "harbor");
    await t.type(within(t, form, "Note"), "Lives there");
    await t.click(t.button("Save Relationship"));
    await t.settle();
    const post = writes(t).find((c) => c.path === "/books/book/relationships")!;
    assert.equal(post.method, "POST");
    assert.equal(post.body.fromEntryId, "mira-vale");
    assert.equal(post.body.toEntryId, "harbor");
    assert.equal(post.body.typeId, "parent");
    assert.equal(post.body.editSharedCanon, false);
    assert.match(
      section(t, "Relationships").textContent!,
      /Mira Vale\s+parent of\s*Harbor/,
    );
    assert.match(section(t, "Relationships").textContent!, /Lives there/);
    // Another entry's page shows only its own links.
    await open(t, "Tom Reed");
    assert.equal(section(t, "Relationships").querySelectorAll("li").length, 2);
    assert.doesNotMatch(
      section(t, "Relationships").textContent!,
      /Lives there/,
    );
    await open(t, "Harbor");
    assert.match(
      section(t, "Relationships").textContent!,
      /child of\s*Tom Reed/,
    );
    assert.match(
      section(t, "Relationships").textContent!,
      /child of\s*Mira Vale/,
    );
  } finally {
    await t.cleanup();
  }
});

test("a stale or rejected link write keeps the form; Trash and restore use the stale-write rules", async () => {
  const t = await setupStory();
  try {
    await open(t, "Mira Vale");
    await t.click(t.button("Add Relationship…"));
    await t.type(within(t, section(t, "Relationships"), "Note"), "My note");
    t.fake.intercept = (c) =>
      c.method === "POST"
        ? jsonError(409, "Relationship list changed.")
        : undefined;
    await t.click(t.button("Save Relationship"));
    await t.settle();
    assert.match(t.text(), /Relationship list changed\./);
    assert.equal(
      within(t, section(t, "Relationships"), "Note").value,
      "My note",
    );
    t.fake.intercept = undefined;
    await t.click(t.button("Cancel Relationship Edit"));

    await t.click(t.button("Move Relationship to Trash"));
    await t.settle();
    const put = writes(t).find(
      (c) => c.method === "PUT" && c.path.endsWith("/l1"),
    )!;
    assert.equal(put.body.deleted, true);
    assert.equal(put.body.expectedUpdatedAt, "lu");
    assert.doesNotMatch(section(t, "Relationships").textContent!, /Tom Reed/);
    await t.click(
      section(t, "Relationships").querySelector("input[type=checkbox]"),
    );
    await t.click(t.button("Restore Relationship"));
    await t.settle();
    assert.equal(
      t.fake.relationships.find((r) => r.id === "l1").deletedAt,
      undefined,
    );
  } finally {
    await t.cleanup();
  }
});

test("Add change preselects this entry, sends the existing request shape, and shows only on this entry; As of sends no write", async () => {
  const t = await setupStory();
  try {
    await open(t, "Mira Vale");
    await t.click(t.button("Add Change…"));
    const form = section(t, "State Change Form");
    await t.choose(within(t, form, "From chapter or scene"), "sc1");
    await t.type(within(t, form, "Role"), "Captain");
    await t.click(t.button("Save Value", form));
    await t.settle();
    const post = writes(t).find((c) => c.path === "/books/book/state-changes")!;
    assert.equal(post.method, "POST");
    assert.equal(post.body.entryId, "mira-vale");
    assert.equal(post.body.fieldId, "role");
    assert.equal(post.body.value, "Captain");
    assert.equal(post.body.nodeId, "sc1");
    assert.equal(post.body.eventId, null);
    assert.equal(post.body.expectedEntryUpdatedAt, "u0");
    assert.equal(post.body.expectedFieldUpdatedAt, "fu");
    assert.match(
      section(t, "Changes over the story").textContent!,
      /Role → Captain/,
    );
    assert.match(section(t, "Changes over the story").textContent!, /Opening/);

    // As of: read-only; values change with the point and nothing is written.
    const before = writes(t).length;
    const asOf = section(t, "As of");
    assert.match(asOf.textContent!, /Cook/);
    await t.choose(within(t, asOf, "As of chapter or scene"), "sc1");
    assert.match(section(t, "As of").textContent!, /Captain/);
    assert.match(section(t, "As of").textContent!, /Set by change/);
    assert.match(section(t, "As of").textContent!, /parent of\s*Tom Reed/);
    await t.choose(
      within(t, section(t, "As of"), "As of chapter or scene"),
      "",
    );
    assert.match(section(t, "As of").textContent!, /Cook/);
    assert.equal(writes(t).length, before);

    await open(t, "Tom Reed");
    assert.doesNotMatch(
      section(t, "Changes over the story").textContent!,
      /Captain/,
    );
    assert.match(
      section(t, "Changes over the story").textContent!,
      /No changes yet/,
    );
  } finally {
    await t.cleanup();
  }
});

test("a rejected change keeps the form and typed value; shared entries need canon mode", async () => {
  const t = await setupStory();
  try {
    t.fake.entries = [
      ...t.fake.entries,
      entry("Old Gate", "location", {
        templateId: "t1",
        scope: { kind: "series", id: "s" },
      }),
    ];
    t.fake.book = { id: "book", seriesId: "s" };
    await t.remount();
    await open(t, "Mira Vale");
    await t.click(t.button("Add Change…"));
    const form = section(t, "State Change Form");
    await t.choose(within(t, form, "From chapter or scene"), "sc1");
    await t.type(within(t, form, "Role"), "Keeper");
    t.fake.intercept = (c) =>
      c.method === "POST" && c.path.endsWith("/state-changes")
        ? jsonError(409, "This entry changed.")
        : undefined;
    await t.click(t.button("Save Value", form));
    await t.settle();
    assert.match(t.text(), /This entry changed\./);
    assert.equal(
      within(t, section(t, "State Change Form"), "Role").value,
      "Keeper",
    );
    assert.equal(
      within(t, section(t, "State Change Form"), "From chapter or scene").value,
      "sc1",
    );
    t.fake.intercept = undefined;
    await t.click(t.button("Cancel Field Edit"));

    // A shared entry's changes follow the page-level canon switch.
    await open(t, "Old Gate");
    assert.equal(t.button("Add Change…")!.disabled, true);
    await t.click(t.button("Edit shared details"));
    assert.equal(t.button("Add Change…")!.disabled, false);
    await t.click(t.button("Add Change…"));
    assert.equal(
      t.doc.body.textContent!.includes("Apply this state change"),
      false,
    );
    await t.choose(
      within(t, section(t, "State Change Form"), "From chapter or scene"),
      "sc1",
    );
    await t.type(within(t, section(t, "State Change Form"), "Role"), "Shut");
    await t.click(t.button("Save Value", section(t, "State Change Form")));
    await t.settle();
    const post = writes(t)
      .filter((c) => c.path === "/books/book/state-changes")
      .at(-1)!;
    assert.equal(post.body.editSharedCanon, true);
  } finally {
    await t.cleanup();
  }
});

test("relationship types live in Bible settings; the old Relationships and Changing State entry points are gone", async () => {
  const t = await setupStory();
  try {
    assert.equal(t.button("Relationships…"), undefined);
    assert.equal(t.button("Changing State…"), undefined);
    await t.click(t.button("Relationship types…"));
    await t.settle();
    assert.equal(t.state.tool, "relationshipTypes");
    const settings = section(t, "Bible settings");
    assert.match(settings.textContent!, /Bible settings/);
    assert.match(settings.textContent!, /parent of \/ child of/);
    assert.ok(t.button("New Relationship Type…"));
    assert.equal(t.doc.querySelector("dialog[open]"), null);
    // Creating a type uses the library endpoint.
    await t.click(t.button("New Relationship Type…"));
    await t.type(within(t, settings, "Forward label"), "employs");
    await t.type(within(t, settings, "Inverse label"), "works for");
    await t.click(t.button("Save Relationship Type"));
    await t.settle();
    const post = writes(t).find((c) => c.path.endsWith("/relationship-types"));
    assert.equal(post?.method, "POST");
    assert.equal(post?.body.label, "employs");
  } finally {
    await t.cleanup();
  }
});
