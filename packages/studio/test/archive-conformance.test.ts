// SPDX-License-Identifier: AGPL-3.0-only
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readArchive } from "../src/archive-validation.ts";
const dir = new URL("../fixtures/archives/", import.meta.url),
  expected = JSON.parse(readFileSync(new URL("expected.json", dir), "utf8"));
for (const [path, result] of Object.entries(expected))
  test("portable fixture " + path, () => {
    const bytes = readFileSync(new URL(path, dir));
    if (result === "VALID") {
      const s = readArchive(bytes);
      assert.ok(s.library.title);
      assert.ok(s.documents.size);
    } else
      assert.throws(
        () => readArchive(bytes),
        (e: any) => {
          assert.equal(e.code, result);
          return true;
        },
      );
  });
test("ZIP local flags and payload CRC cannot disagree with the central inventory", async () => {
  const { writeZIP } = await import("../src/archive-zip.ts");
  const bytes = writeZIP(new Map([["manifest.json", Buffer.from("{}")]]));
  const mismatch = Buffer.from(bytes);
  mismatch.writeUInt16LE(mismatch.readUInt16LE(6) ^ 1, 6);
  assert.throws(() => readArchive(mismatch), { code: "ARCHIVE_CORRUPT" });
  const crc = Buffer.from(bytes),
    start = 30 + crc.readUInt16LE(26) + crc.readUInt16LE(28);
  crc[start] ^= 1;
  assert.throws(() => readArchive(crc), { code: "ARCHIVE_CORRUPT" });
});
