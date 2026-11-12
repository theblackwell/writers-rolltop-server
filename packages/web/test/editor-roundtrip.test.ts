// The editor's state logic against the adapter's own fixture documents (Spec fixtures, copied into the adapter package).
// A fixture goes into the editor state and comes out again; typing, bold and Enter keep the mark-order and id rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TextSelection } from "@tiptap/pm/state";
import { normalizeDocument } from "@writers-rolltop/document-adapter";
import { canonicalFromState, commands, newId, paragraphsFromText, stateFromCanonical } from "../src/editor/rolltop-editor.ts";

const docs = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "document-adapter", "test", "spec", "fixtures", "documents");
const read = (...p: string[]): any => JSON.parse(readFileSync(path.join(docs, ...p), "utf8"));
const valid = readdirSync(path.join(docs, "valid")).filter((f) => f.endsWith(".json")).sort();
const normalizeInputs = readdirSync(path.join(docs, "normalize")).filter((f) => f.endsWith(".input.json")).sort();

test("the fixture folders are found and not empty", () => {
  assert.equal(valid.length, 4);
  assert.equal(normalizeInputs.length, 3);
});

for (const f of valid) {
  test(`round trip through the editor state: valid/${f} comes back identical`, () => {
    const doc = read("valid", f);
    const out = canonicalFromState(stateFromCanonical(doc));
    // An empty document gains one empty paragraph to type in; every other fixture must match exactly.
    if (doc.blocks.length === 0) { assert.equal(out.blocks.length, 1); assert.deepEqual(out.blocks[0]!.type, "paragraph"); return; }
    assert.deepEqual(out, normalizeDocument(doc));
  });
}

for (const f of normalizeInputs) {
  test(`normalize/${f} comes out of the editor as the expected normalised document`, () => {
    const out = canonicalFromState(stateFromCanonical(read("normalize", f)));
    assert.deepEqual(out, read("normalize", f.replace(".input.", ".expected.")));
  });
}

const sample = () => stateFromCanonical({
  schema: "writers-rolltop/document", version: 1, nodeId: newId(),
  blocks: [{ id: newId(), type: "paragraph", content: [{ type: "text", text: "Hello world" }] }],
});

test("bold, italic and underline in any order are saved in the canonical mark order", () => {
  let s = sample();
  const run = (c: typeof commands.bold) => c(s, (tr) => { s = s.apply(tr); });
  s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, 1, 6)));
  run(commands.underline); run(commands.italic); run(commands.bold);
  const marks = (canonicalFromState(s).blocks[0] as any).content[0].marks.map((m: any) => m.type);
  assert.deepEqual(marks, ["strong", "emphasis", "underline"]);
});

test("Enter in a list item makes a new block with its own id, and the saved document stays valid", () => {
  let s = sample();
  const dispatch = (tr: any) => { s = s.apply(tr); };
  s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, 6)));
  commands.bullet(s, dispatch);
  // split by transaction the way Enter does (same attributes on both halves), then let the plugin fix the ids
  s = s.apply(s.tr.split(6));
  const out = canonicalFromState(s);
  assert.equal(out.blocks.length, 2);
  assert.notEqual(out.blocks[0]!.id, out.blocks[1]!.id);
  assert.deepEqual(out.blocks.map((b: any) => b.list), [{ style: "bullet", level: 0 }, { style: "bullet", level: 0 }]);
});

test("pasted text becomes paragraphs with unique ids and no control characters", () => {
  const slice = paragraphsFromText("one\r\ntwo\u0000x\n\nfour");
  const ids = new Set<string>();
  slice.content.forEach((n) => ids.add(n.attrs.id));
  assert.equal(slice.content.childCount, 4);
  assert.equal(ids.size, 4);
  assert.equal(slice.content.child(1).textContent, "twox");
});

test("a list toggled twice returns the paragraph to plain", () => {
  let s = sample();
  const dispatch = (tr: any) => { s = s.apply(tr); };
  commands.ordered(s, dispatch);
  assert.deepEqual((canonicalFromState(s).blocks[0] as any).list, { style: "ordered", level: 0 });
  commands.ordered(s, dispatch);
  assert.equal((canonicalFromState(s).blocks[0] as any).list, undefined);
});
