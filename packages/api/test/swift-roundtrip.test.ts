import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readArchive } from "@writers-rolltop/archive";
import { semantic } from "../../store/test/semantic.ts";
import { archiveFixtures, server } from "./helpers.ts";

const run = promisify(execFile);
const cli = process.env.ROLLTOP_CLI
  ?? fileURLToPath(new URL("../../../../Apple/Packages/RolltopKit/.build/debug/rolltop", import.meta.url));

async function rolltop(...args: string[]): Promise<string> {
  const { stdout } = await run(cli, args, { timeout: 120_000 });
  return stdout;
}
/** Inspect output without the per-export fields. */
const inspectShape = (out: string): string => out.split("\n").filter((l) => !/^(archiveId|createdAt|generator|kind):/.test(l)).join("\n");

async function semanticOf(file: string): Promise<string> {
  const c = await readArchive(file);
  try { return semantic(c.data, c.manifest.libraryId as string); } finally { await c.close(); }
}

test("the Swift CLI is available", async () => {
  await access(cli).catch(() => {
    assert.fail(`The Swift CLI was not found at ${cli}. Build it with "swift build --product rolltop" in Apple/Packages/RolltopKit, or set ROLLTOP_CLI to its path. This test does not skip.`);
  });
});

test("the Swift CLI's own sample, and the checked-in fixtures: import, export, validate with rolltop, and compare", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "rolltop-swift-"));
  const s = await server();
  try {
    // 1. The CLI makes its sample library and exports it as an archive.
    await mkdir(path.join(dir, "src"));
    const library = path.join(dir, "src", "sample.rolltoplib");
    await rolltop("sample", library);
    const swiftSample = path.join(dir, "swift-sample.rolltop");
    await rolltop("export", library, swiftSample, "--archive-id", randomUUID(), "--created-at", "2026-11-10T00:00:00Z");
    assert.match(await rolltop("validate", swiftSample), /^VALID/);

    const inputs: [string, string][] = [
      ["swift sample", swiftSample],
      ["sample-library fixture", path.join(archiveFixtures, "valid", "sample-library.rolltop")],
      ["record-overrides fixture", path.join(archiveFixtures, "valid", "record-overrides.rolltop")],
    ];
    for (const [label, input] of inputs) {
      const fresh = await server(); // one library per database
      try {
        // 2. The server imports it and exports it again.
        const imp = await fresh.inject({ method: "POST", url: "/api/import", payload: await readFile(input), headers: { "content-type": "application/zip" } });
        assert.equal(imp.statusCode, 201, `${label}: ${imp.body}`);
        const exp = await fresh.inject({ method: "GET", url: "/api/export" });
        assert.equal(exp.statusCode, 200);
        const exported = path.join(dir, `${label.replace(/\W+/g, "-")}-server.rolltop`);
        await writeFile(exported, exp.rawPayload);

        // 3. rolltop validates the server's export, and sees the same structure.
        assert.match(await rolltop("validate", exported), /^VALID/, `${label}: rolltop validate`);
        assert.equal(inspectShape(await rolltop("inspect", exported)), inspectShape(await rolltop("inspect", input)), `${label}: rolltop inspect`);

        // 4. Semantic equality: the original, the server's export, and the Swift engine's own re-export of it.
        // The Swift importer refuses a folder that already holds this library id, so each input gets its own folder.
        const home = path.join(dir, randomUUID());
        await mkdir(home);
        const swiftLibrary = path.join(home, "library.rolltoplib");
        await rolltop("import", exported, swiftLibrary);
        assert.match(await rolltop("validate", swiftLibrary), /^VALID/);
        const swiftBack = path.join(dir, `${randomUUID()}.rolltop`);
        await rolltop("export", swiftLibrary, swiftBack);
        const original = await semanticOf(input);
        assert.equal(await semanticOf(exported), original, `${label}: server export vs original`);
        assert.equal(await semanticOf(swiftBack), original, `${label}: Swift re-export of the server export vs original`);
      } finally { await fresh.drop(); }
    }
  } finally { await s.drop(); await rm(dir, { recursive: true, force: true }); }
});
