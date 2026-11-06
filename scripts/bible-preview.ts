// SPDX-License-Identifier: AGPL-3.0-only
import { mkdir, writeFile } from "node:fs/promises";
import { buildBible } from "../packages/studio/src/bible-content.ts";
import { renderBible } from "../packages/studio/src/bible-render.ts";
import { bibleFixture } from "../packages/studio/test/bible-fixture.ts";
const dir = process.argv[2] ?? "/tmp/rolltop-bible-qa";
await mkdir(dir, { recursive: true });
const blocks = buildBible(bibleFixture(), "1.9", "2026-11-06T00:00:00Z");
for (const format of ["docx", "pdf"] as const)
  await writeFile(
    dir + "/orchard-bible." + format,
    await renderBible(blocks, format),
  );
console.log("Rendered scratch bible Word/PDF: " + dir);

if (process.argv.includes("--stress")) {
  const stress: any = [
    { kind: "title", text: "Pagination check" },
    {
      kind: "table",
      header: ["Name", "Long saved text"],
      keyed: true,
      rows: [
        ["Long row", "Many words stay readable. ".repeat(500)],
        ["Final row", "END OF LONG TABLE"],
      ],
    },
    {
      kind: "table",
      header: Array.from({ length: 12 }, (_, i) => "Column " + i),
      rows: [Array.from({ length: 12 }, (_, i) => "Cell " + i)],
    },
  ];
  for (const format of ["docx", "pdf"] as const)
    await writeFile(
      dir + "/stress." + format,
      await renderBible(stress, format),
    );
}
