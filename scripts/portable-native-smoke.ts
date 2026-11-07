// SPDX-License-Identifier: AGPL-3.0-only
import { fixture } from "../packages/studio/test/support.ts";
import {
  PortableImports,
  exportPortable,
} from "../packages/studio/src/portable.ts";
import { readArchive } from "../packages/studio/src/archive-validation.ts";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const cli = process.env.NATIVE_ROLLTOP_BINARY;
if (!cli)
  throw Error(
    "Set NATIVE_ROLLTOP_BINARY to an existing native rolltop CLI executable. Uses scratch libraries only.",
  );
const dir = await mkdtemp("/tmp/rolltop-native-portable-"),
  f = await fixture();
try {
  const bytes = await readFile(
    new URL(
      "../packages/studio/fixtures/archives/valid/unknown-optional-fields.rolltop",
      import.meta.url,
    ),
  );
  const imports = new PortableImports(f.store),
    p = await imports.preview(bytes);
  await imports.commit(p.id, { mode: "new" });
  const out = await exportPortable(f.store, p.libraryId);
  await writeFile(dir + "/web.rolltop", out);
  execFileSync(cli, ["validate", dir + "/web.rolltop"], { stdio: "inherit" });
  execFileSync(cli, ["import", dir + "/web.rolltop", dir + "/native"], {
    stdio: "inherit",
  });
  execFileSync(cli, ["export", dir + "/native", dir + "/native.rolltop"], {
    stdio: "inherit",
  });
  const s = readArchive(out),
    n = readArchive(await readFile(dir + "/native.rolltop"));
  for (const k of [
    "library",
    "books",
    "nodes",
    "entries",
    "templates",
    "fields",
    "universes",
    "series",
    "relationships",
    "relationshipTypes",
    "facts",
    "questions",
    "events",
    "stateChanges",
    "notes",
    "references",
    "attachments",
  ]) {
    const norm = (x: any) =>
      Array.isArray(x)
        ? [...x].sort((a, b) =>
            (a.id ?? a.sha256).localeCompare(b.id ?? b.sha256),
          )
        : x;
    assert.deepEqual(norm(n[k]), norm(s[k]), k);
  }
  for (const [id, doc] of s.documents)
    assert.deepEqual(n.documents.get(id), doc);
  for (const [h, b] of s.blobs) assert.deepEqual(n.blobs.get(h), b);
  console.log(
    "PASS native → web → native canonical records, documents and attachment bytes",
  );
} finally {
  await f.pg.close();
  await rm(dir, { recursive: true, force: true });
}
