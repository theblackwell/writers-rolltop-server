import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { specDir } from "./helpers.ts";
import { DEFINITION_FOR_PATH } from "../src/schema.ts";

const read = (p: string): Buffer => readFileSync(p);

test("src/archive-v1.schema.json is identical to the vendored Spec schema", () => {
  const ours = read(fileURLToPath(new URL("../src/archive-v1.schema.json", import.meta.url)));
  const spec = read(path.join(specDir, "schemas", "archive-v1.schema.json"));
  assert.ok(ours.equals(spec), "the schema copy drifted; re-copy it from Spec/schemas (see Server/scripts/sync-spec-fixtures.sh)");
});

test("every archive JSON file has a schema definition", () => {
  const defs = JSON.parse(read(path.join(specDir, "schemas", "archive-v1.schema.json")).toString("utf8")).$defs;
  for (const [file, def] of Object.entries(DEFINITION_FOR_PATH)) assert.ok(defs[def], `${file} -> ${def}`);
  assert.equal(Object.keys(DEFINITION_FOR_PATH).length, 14);
});
