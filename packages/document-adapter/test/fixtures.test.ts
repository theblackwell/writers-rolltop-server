import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const spec = path.join(path.dirname(fileURLToPath(import.meta.url)), "spec");
const list = (rel: string) => readdirSync(path.join(spec, rel));

test("vendored spec records its source commit", () => {
  assert.match(readFileSync(path.join(spec, "SOURCE.txt"), "utf8").trim(), /^[0-9a-f]{40}$/);
});

test("schemas are present", () => {
  const s = list("schemas");
  assert.ok(s.includes("document-v1.schema.json"));
  assert.ok(s.includes("archive-v1.schema.json"));
});

test("document fixture counts", () => {
  assert.equal(list("fixtures/documents/valid").filter((f) => f.endsWith(".json")).length, 4);
  const normalize = list("fixtures/documents/normalize");
  assert.equal(normalize.filter((f) => f.endsWith(".input.json")).length, 3);
  assert.equal(normalize.filter((f) => f.endsWith(".expected.json")).length, 3);
  const invalid = list("fixtures/documents/invalid").filter((f) => f.endsWith(".json") && f !== "expected.json");
  assert.equal(invalid.length, 19);
});

test("archive fixture counts", () => {
  const n = (d: string) => list(`fixtures/archives/${d}`).filter((f) => f.endsWith(".rolltop")).length;
  // Actual counts in Spec 781612e: valid is 3 (task brief said 2), invalid is 16 (brief said 13).
  assert.equal(n("valid"), 3);
  assert.equal(n("invalid"), 16);
  assert.equal(n("malicious"), 10);
});
