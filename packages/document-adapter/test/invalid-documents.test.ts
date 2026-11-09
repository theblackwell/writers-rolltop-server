import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalToEditor, DocumentError } from "../src/index.ts";
import { jsonFiles, nonEmpty, readJSON } from "./helpers.ts";

const expected: Record<string, string> = readJSON("documents", "invalid", "expected.json");

test("every invalid fixture has an expected code and vice versa", () => {
  const files = jsonFiles("documents", "invalid").filter((f) => f !== "expected.json");
  assert.deepEqual(files, Object.keys(expected).sort());
});

for (const [f, code] of nonEmpty(Object.entries(expected), "invalid"))  {
  test(`invalid/${f} is rejected with ${code}`, () => {
    assert.throws(
      () => canonicalToEditor(readJSON("documents", "invalid", f)),
      (e) => e instanceof DocumentError && e.code === code,
    );
  });
}
