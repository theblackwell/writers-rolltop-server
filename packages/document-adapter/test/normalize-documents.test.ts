import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalToEditor, editorToCanonical, normalizeDocument } from "../src/index.ts";
import { jsonFiles, nonEmpty, readJSON } from "./helpers.ts";

for (const f of nonEmpty(jsonFiles("documents", "normalize").filter((n) => n.endsWith(".input.json")), "normalize")) {
  const name = f.replace(".input.json", "");
  test(`normalize/${name}: canonical -> editor -> canonical equals expected`, () => {
    const expected = readJSON("documents", "normalize", `${name}.expected.json`);
    assert.deepEqual(editorToCanonical(canonicalToEditor(readJSON("documents", "normalize", f))), expected);
    assert.deepEqual(normalizeDocument(readJSON("documents", "normalize", f)), expected);
    assert.deepEqual(normalizeDocument(expected), expected, "normalization is idempotent");
  });
}
