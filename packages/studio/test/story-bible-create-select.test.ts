// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { entry, setup } from "./bible-ui-harness.ts";

// Owner report: "After a user is created, clicking their name does not bring
// their info back up." Each sequence below was tried against the U1 code.
async function create(t: Awaited<ReturnType<typeof setup>>, name: string) {
  await t.menu("New entry", "New Character");
  await t.type(
    t.doc.querySelector("dialog input[name='name']") as HTMLInputElement,
    name,
  );
  await t.React.act(async () => {
    t.doc
      .querySelector("dialog form")!
      .dispatchEvent(
        new t.dom.window.Event("submit", { bubbles: true, cancelable: true }),
      );
  });
  await t.settle();
}
const heading = (t: Awaited<ReturnType<typeof setup>>) =>
  t.doc.querySelector("article h1")?.textContent;

test("a created entry opens from its list row after switching, filtering, remounting and with a tool open", async () => {
  const t = await setup();
  try {
    t.fake.entries = [entry("Mira Vale"), entry("Old Mill", "location")];
    await t.mount();
    await create(t, "Tom Reed");
    assert.equal(heading(t), "Tom Reed");

    // Sequence 1: click the new entry's own row.
    await t.click(t.button("Tom Reed", t.doc.querySelector("aside")!));
    assert.equal(heading(t), "Tom Reed");

    // Sequence 2: another entry, then back to the created one.
    await t.click(t.button("Mira Vale"));
    assert.equal(heading(t), "Mira Vale");
    await t.click(t.button("Tom Reed", t.doc.querySelector("aside")!));
    assert.equal(heading(t), "Tom Reed");

    // Sequence 3: reload the page state; the created entry opens from the list.
    await t.remount();
    await t.click(t.button("Mira Vale"));
    await t.click(t.button("Tom Reed", t.doc.querySelector("aside")!));
    assert.equal(heading(t), "Tom Reed");

    // Sequence 4: create while a filter is applied.
    await t.type(
      t.doc.querySelector("aside input") as HTMLInputElement,
      "mill",
    );
    await create(t, "Ada Quill");
    assert.equal(heading(t), "Ada Quill");
    await t.click(t.button("Old Mill"));
    await t.click(t.button("Ada Quill", t.doc.querySelector("aside")!));
    assert.equal(heading(t), "Ada Quill");

    // Sequence 5: Relationships (a tool) is open, then a name is clicked. The
    // row is selected, but the tool used to keep covering the entry page.
    await t.menu("Bible settings", "Relationship types…");
    assert.equal(t.state.tool, "relationshipTypes");
    await t.click(t.button("Tom Reed", t.doc.querySelector("aside")!));
    assert.equal(t.state.selected, "tom-reed");
    assert.equal(t.state.tool, null, "choosing an entry closes the tool");
    assert.equal(heading(t), "Tom Reed");

    // The same holds for Templates and Fields.
    await t.menu("Bible settings", "Templates and Fields…");
    await t.click(t.button("Mira Vale"));
    assert.equal(heading(t), "Mira Vale");
  } finally {
    await t.cleanup();
  }
});
