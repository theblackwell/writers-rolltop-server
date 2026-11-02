// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 The Black Well Foundry
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { decode, DocumentError } from "../src/canonical.ts";
import { fromProseMirror, toProseMirror } from "../src/prosemirror.ts";
import type { PMNode } from "../src/prosemirror.ts";

// Vendored from writers-rolltop-spec by scripts/sync-spec-fixtures.sh.
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "documents");
const read = (path: string) => JSON.parse(readFileSync(join(fixtures, path), "utf8"));
const list = (dir: string, suffix = ".json") => readdirSync(join(fixtures, dir)).filter((f) => f.endsWith(suffix)).sort();

test("valid spec fixtures decode unchanged", () => {
  const files = list("valid");
  assert.ok(files.length >= 3);
  for (const f of files) assert.deepEqual(decode(read(`valid/${f}`)), read(`valid/${f}`), f);
});

test("normalization fixtures match the spec's expected output", () => {
  const inputs = list("normalize", ".input.json");
  assert.ok(inputs.length >= 2);
  for (const f of inputs) {
    assert.deepEqual(decode(read(`normalize/${f}`)), read(`normalize/${f.replace(".input.json", ".expected.json")}`), f);
  }
});

test("invalid spec fixtures are rejected with the listed code", () => {
  const expected: Record<string, string> = read("invalid/expected.json");
  assert.ok(Object.keys(expected).length >= 10);
  for (const [file, code] of Object.entries(expected)) {
    assert.throws(() => decode(read(`invalid/${file}`)), (e: unknown) => e instanceof DocumentError && e.code === code, file);
  }
});

test("canonical → ProseMirror → canonical has no semantic loss for every fixture", () => {
  const files = [...list("valid").map((f) => `valid/${f}`), ...list("normalize", ".expected.json").map((f) => `normalize/${f}`)];
  for (const f of files) {
    const doc = decode(read(f));
    const pm = toProseMirror(doc);
    // Survive a JSON round trip, as editor state does when persisted or sent over the wire.
    const back = fromProseMirror(JSON.parse(JSON.stringify(pm)), doc.nodeId);
    assert.deepEqual(back, doc, f);
  }
});

test("Tiptap-style output: bold/italic/link/rolltopAnchor marks and block ids", () => {
  const pm = toProseMirror(decode(read("valid/formatting.json")));
  const paragraph = pm.content![1];
  assert.equal(paragraph.type, "paragraph");
  assert.equal(paragraph.attrs!.id, "b0000000-0000-4000-8000-000000000002");
  const markTypes = new Set(paragraph.content!.flatMap((n) => (n.marks ?? []).map((m) => m.type)));
  assert.deepEqual([...markTypes].sort(), ["bold", "italic", "link", "rolltopAnchor"]);
  assert.equal(pm.content![2].content, undefined, "empty paragraph has no content array");
});

test("editor repairs: split paragraph gets a new id; broken anchor keeps its first run", () => {
  const id = "c0000000-0000-4000-8000-000000000001";
  const anchor = "a0000000-0000-4000-8000-0000000000aa";
  const pm: PMNode = {
    type: "doc",
    content: [
      { type: "paragraph", attrs: { id }, content: [{ type: "text", text: "Mara", marks: [{ type: "rolltopAnchor", attrs: { id: anchor } }] }] },
      { type: "paragraph", attrs: { id }, content: [{ type: "text", text: "Vell", marks: [{ type: "rolltopAnchor", attrs: { id: anchor } }, { type: "highlight" }] }] },
    ],
  };
  let n = 0;
  const doc = fromProseMirror(pm, "d0000000-0000-4000-8000-000000000001", () => `e0000000-0000-4000-8000-00000000000${++n}`);
  assert.equal(doc.blocks[0].id, id);
  assert.equal(doc.blocks[1].id, "e0000000-0000-4000-8000-000000000001");
  assert.deepEqual(doc.blocks[1].content, [{ type: "text", text: "Vell" }], "anchor dropped from second block; presentation mark ignored");
});

test("flat quotes and lists become ProseMirror nesting and come back flat", () => {
  const doc = decode(read("valid/structure.json"));
  const pm = toProseMirror(doc);
  const types = pm.content!.map((n) => n.type);
  assert.deepEqual(types, ["heading", "blockquote", "paragraph", "orderedList", "horizontalRule", "paragraph", "blockquote", "bulletList"]);
  const ordered = pm.content![3];
  assert.equal(ordered.content!.length, 2, "two top-level ordered items");
  const nested = ordered.content![0].content![1];
  assert.equal(nested.type, "orderedList", "level-1 item nests inside the first item");
  assert.equal(nested.content![0].content![1].type, "bulletList", "level-2 bullet nests inside the level-1 item");
  assert.equal(pm.content![1].content!.length, 2, "two consecutive quoted blocks form one blockquote");
  assert.deepEqual(fromProseMirror(JSON.parse(JSON.stringify(pm)), doc.nodeId), doc);
});

test("editor nesting the canonical model can't express is repaired, text kept", () => {
  const P = (id: string, text: string): PMNode => ({ type: "paragraph", attrs: { id }, content: [{ type: "text", text }] });
  const pm: PMNode = {
    type: "doc",
    content: [{ type: "blockquote", content: [{ type: "bulletList", content: [{ type: "listItem", content: [
      P("c0000000-0000-4000-8000-000000000011", "quoted item"),
      P("c0000000-0000-4000-8000-000000000012", "second paragraph in item"),
    ] }] }] }],
  };
  const doc = fromProseMirror(pm, "d0000000-0000-4000-8000-000000000001");
  assert.deepEqual(doc.blocks.map((b) => (b.type === "paragraph" ? [b.quote ?? false, b.list?.level] : null)), [[false, 0], [false, 0]]);
  assert.deepEqual(doc.blocks.map((b) => (b.type === "paragraph" ? b.content : null)),
    [[{ type: "text", text: "quoted item" }], [{ type: "text", text: "second paragraph in item" }]]);
});

test("unknown editor block types are rejected, never silently dropped", () => {
  const pm: PMNode = { type: "doc", content: [{ type: "table", content: [] }] };
  assert.throws(() => fromProseMirror(pm, "d0000000-0000-4000-8000-000000000001"), /unsupported block node/);
});
