import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalToEditor, editorToCanonical, normalizeDocument } from "../src/index.ts";
import { jsonFiles, nonEmpty, readJSON } from "./helpers.ts";

for (const f of nonEmpty(jsonFiles("documents", "valid"), "valid")) {
  test(`valid/${f} round-trips canonical -> editor -> canonical`, () => {
    const doc = readJSON("documents", "valid", f);
    const editor = canonicalToEditor(doc);
    assert.deepEqual(editorToCanonical(editor), doc);
    assert.deepEqual(normalizeDocument(doc), doc, "valid fixtures are already normalized");
    // Editor JSON survives a JSON round trip (no non-serializable values).
    assert.deepEqual(editorToCanonical(JSON.parse(JSON.stringify(editor))), doc);
  });
}
