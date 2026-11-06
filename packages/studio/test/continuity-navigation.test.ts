// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareContinuityPlace } from "../../../apps/web/src/continuity-navigation.ts";
test("warning navigation refuses conflicted drafts and stale/trashed destinations, supports exact chapters and cross-book scenes", async () => {
  const point = { id: "scene", bookId: "other" };
  let loads = 0;
  const data: any = {
    book: { id: "other", title: "Other" },
    nodes: [
      { id: "chapter", title: "Chapter", kind: "chapter" },
      { id: "scene", parentId: "chapter", title: "Scene", kind: "scene" },
    ],
  };
  const load = async (id: string) => {
    loads++;
    assert.equal(id, "other");
    return data;
  };
  await assert.rejects(
    () => prepareContinuityPlace(point, async () => false, load),
    /draft or save conflict/,
  );
  assert.equal(loads, 0);
  assert.equal(
    (await prepareContinuityPlace(point, async () => true, load)).target.id,
    "scene",
  );
  assert.equal(
    (
      await prepareContinuityPlace(
        { id: "chapter", bookId: "other" },
        async () => true,
        load,
      )
    ).target.id,
    "chapter",
  );
  data.nodes[0].deletedAt = "trash";
  await assert.rejects(
    () => prepareContinuityPlace(point, async () => true, load),
    /no longer available/,
  );
  delete data.nodes[0].deletedAt;
  data.book.deletedAt = "trash";
  await assert.rejects(
    () => prepareContinuityPlace(point, async () => true, load),
    /no longer available/,
  );
});
