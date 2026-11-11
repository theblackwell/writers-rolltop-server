import { test } from "node:test";
import assert from "node:assert/strict";
import { ArchiveError, readArchive } from "../src/index.ts";
import { archiveFromFiles, unpackedFiles } from "./helpers.ts";

const SECRET = "secret-text";

async function archiveWith(file: string, edit: (json: any) => void): Promise<Buffer> {
  const files = await unpackedFiles("sample-library");
  const json = JSON.parse(files.get(file)!.toString("utf8"));
  edit(json);
  files.set(file, Buffer.from(JSON.stringify(json)));
  return archiveFromFiles(files);
}

const refused = (code: string, ...mention: RegExp[]) => (e: unknown) => {
  assert.ok(e instanceof ArchiveError, String(e));
  assert.equal(e.code, code);
  assert.doesNotMatch(e.message, new RegExp(SECRET));
  assert.doesNotMatch(JSON.stringify(e.issues), new RegExp(SECRET));
  for (const m of mention) assert.match(e.message + JSON.stringify(e.issues), m);
  return true;
};

const nul = `${SECRET}\u0000tail`;

test("U+0000 in a title, a synopsis and a node plan is refused with SCHEMA_VIOLATION, naming file, record and field but not the text", async () => {
  const cases: [string, string, (j: any) => void, RegExp[]][] = [
    ["title", "library.json", (j) => { j.books[0].title = nul; }, [/library\.json\/books\/0\/title/, /record 40000001-0000-4000-8000-000000000001/]],
    ["synopsis", "library.json", (j) => { j.manuscriptNodes[0].synopsis = nul; }, [/library\.json\/manuscriptNodes\/0\/synopsis/]],
    ["plan", "library.json", (j) => { const n = j.manuscriptNodes.find((x: any) => x.kind === "chapter"); n.plan = nul; }, [/library\.json\/manuscriptNodes\/\d+\/plan/]],
  ];
  for (const [name, file, edit, mention] of cases) {
    const bytes = await archiveWith(file, edit);
    await assert.rejects(readArchive(bytes), refused("SCHEMA_VIOLATION", ...mention), name);
  }
});

test("U+0000 is refused in any other file, in property names, in nested values and in the manifest", async () => {
  await assert.rejects(readArchive(await archiveWith("notes.json", (j) => { j[0].text = nul; })), refused("SCHEMA_VIOLATION", /notes\.json\/0\/text/));
  await assert.rejects(readArchive(await archiveWith("bible/entries.json", (j) => { j[0].aliases.push(nul); })), refused("SCHEMA_VIOLATION", /bible\/entries\.json\/0\/aliases\//));
  await assert.rejects(readArchive(await archiveWith("bible/entries.json", (j) => { j[0].values[`k${"\u0000"}${SECRET}`] = "x"; })), refused("SCHEMA_VIOLATION", /property name/));
  await assert.rejects(readArchive(await archiveWith("library.json", (j) => { j.books[0].futureField = { deep: [nul] }; })), refused("SCHEMA_VIOLATION", /futureField/));
  const files = await unpackedFiles("sample-library");
  const manifest = JSON.parse(files.get("manifest.json")!.toString("utf8"));
  manifest.vendorNote = nul;
  files.set("manifest.json", Buffer.from(JSON.stringify(manifest)));
  await assert.rejects(readArchive(archiveFromFiles(files)), refused("SCHEMA_VIOLATION", /manifest\.json\/vendorNote/));
});

test("U+0000 in document text still fails the document rules with DOCUMENT_INVALID", async () => {
  const files = await unpackedFiles("sample-library");
  const path = [...files.keys()].find((k) => k.startsWith("manuscript/"))!;
  const doc = JSON.parse(files.get(path)!.toString("utf8"));
  const para = doc.blocks.find((b: any) => b.type === "paragraph");
  para.content[0].text = nul;
  files.set(path, Buffer.from(JSON.stringify(doc)));
  await assert.rejects(readArchive(archiveFromFiles(files)), refused("DOCUMENT_INVALID"));
});

test("the unmodified sample still reads, so the check does not reject ordinary text", async () => {
  const c = await readArchive(archiveFromFiles(await unpackedFiles("sample-library")));
  await c.close();
});
