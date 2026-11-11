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

test("U+0000 in a link href or an anchor id is DOCUMENT_INVALID", () => {
  const base = readJSON("documents", "valid", "formatting.json") as any;
  const withMark = (mark: unknown) => {
    const d = structuredClone(base);
    d.blocks[0].content = [{ type: "text", text: "x", marks: [mark] }];
    return d;
  };
  for (const mark of [
    { type: "link", href: "http://a\u0000b" },
    { type: "anchor", id: "70000001-0000-4000-8000-00000000000\u0000" },
  ]) {
    assert.throws(() => canonicalToEditor(withMark(mark)), (e) => e instanceof DocumentError && e.code === "DOCUMENT_INVALID");
  }
});
