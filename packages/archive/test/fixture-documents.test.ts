import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import { ArchiveError, readArchive, stableStringify } from "../src/index.ts";
import { archiveFromFiles, fixtures, readJSON, unpackedFiles } from "./helpers.ts";

// The document fixtures are run through the archive reader: each one replaces a scene's document in
// a copy of the sample archive, so the archive's document path (decode, normalize, error mapping) is tested.

const jsonFiles = (...p: string[]): string[] => readdirSync(path.join(fixtures, ...p)).filter((f) => f.endsWith(".json")).sort();
const base = await unpackedFiles("sample-library");
const docPaths = [...base.keys()].filter((k) => k.startsWith("manuscript/")).sort();
const target = docPaths[0]!;
const targetId = target.slice("manuscript/".length, -".json".length);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The fixture as a document of the target node (nodeId is set to the node's id when the fixture's own is a valid UUID). */
function forTarget(doc: any): any {
  return doc !== null && typeof doc === "object" && typeof doc.nodeId === "string" && UUID.test(doc.nodeId) ? { ...doc, nodeId: targetId } : doc;
}
const archiveWith = (doc: unknown): Buffer => {
  const files = new Map(base);
  files.set(target, Buffer.from(JSON.stringify(doc)));
  return archiveFromFiles(files);
};

const valid = jsonFiles("documents", "valid");
const invalid = jsonFiles("documents", "invalid").filter((f) => f !== "expected.json");
const invalidExpected: Record<string, string> = readJSON("documents", "invalid", "expected.json");
const normalizeNames = jsonFiles("documents", "normalize").filter((f) => f.endsWith(".input.json")).map((f) => f.replace(/\.input\.json$/, ""));

test("document fixture counts: 4 valid, 19 invalid, 3 normalize pairs", () => {
  assert.equal(valid.length, 4);
  assert.equal(invalid.length, 19);
  assert.equal(normalizeNames.length, 3);
  assert.deepEqual(Object.keys(invalidExpected).sort(), invalid);
});

for (const f of valid) {
  test(`documents/valid/${f}: accepted by the archive reader, unchanged`, async () => {
    const doc = forTarget(readJSON("documents", "valid", f));
    const c = await readArchive(archiveWith(doc));
    try {
      assert.equal(stableStringify(c.data.documents.get(targetId)), stableStringify(doc));
    } finally {
      await c.close();
    }
  });
}

for (const f of invalid) {
  const code = invalidExpected[f]!;
  test(`documents/invalid/${f}: rejected with ${code}`, async () => {
    await assert.rejects(readArchive(archiveWith(forTarget(readJSON("documents", "invalid", f)))), (e: unknown) => {
      assert.ok(e instanceof ArchiveError, String(e));
      assert.equal(e.code, code, e.message);
      return true;
    });
  });
}

for (const name of normalizeNames) {
  test(`documents/normalize/${name}: normalized to the expected document`, async () => {
    const c = await readArchive(archiveWith(forTarget(readJSON("documents", "normalize", `${name}.input.json`))));
    try {
      assert.equal(stableStringify(c.data.documents.get(targetId)), stableStringify(forTarget(readJSON("documents", "normalize", `${name}.expected.json`))));
    } finally {
      await c.close();
    }
  });
}
