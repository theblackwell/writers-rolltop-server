import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalToEditor, editorToCanonical } from "../src/index.ts";
import { jsonFiles, nonEmpty, readJSON } from "./helpers.ts";

// Swift-engine exports are checked in M0-8; here only the vendored valid archive fixtures.
for (const lib of ["sample-library", "record-overrides"]) {
  const files = nonEmpty(jsonFiles("archives", "valid", lib, "manuscript"), lib);
  test(`${lib} has 8 manuscript documents`, () => assert.equal(files.length, 8));
  for (const f of files) {
    test(`${lib}/manuscript/${f} round-trips`, () => {
      const doc = readJSON("archives", "valid", lib, "manuscript", f);
      assert.deepEqual(editorToCanonical(canonicalToEditor(doc)), doc);
    });
  }
}
