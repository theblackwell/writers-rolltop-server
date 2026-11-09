import { test } from "node:test";
import assert from "node:assert/strict";
import { editorToCanonical, DocumentError } from "../src/index.ts";

const id = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const doc = (...content: unknown[]) => ({ type: "doc", attrs: { nodeId: "20000000-0000-4000-8000-000000000001" }, content });
const p = (n: number, ...content: unknown[]) => ({ type: "paragraph", attrs: { id: id(n) }, content });

test("editor newlines in text become hardBreaks (N1)", () => {
  const out = editorToCanonical(doc(p(1, { type: "text", text: "a\nb" })));
  assert.deepEqual(out.blocks[0], {
    id: id(1), type: "paragraph",
    content: [{ type: "text", text: "a" }, { type: "hardBreak" }, { type: "text", text: "b" }],
  });
});

test("editor JSON with an unknown node or mark is rejected", () => {
  assert.throws(() => editorToCanonical(doc({ type: "codeBlock" })), DocumentError);
  assert.throws(() => editorToCanonical(doc(p(1, { type: "text", text: "x", marks: [{ type: "code" }] }))), DocumentError);
});

test("editor JSON that violates canonical rules is rejected", () => {
  assert.throws(() => editorToCanonical(doc(p(1), p(1))), DocumentError); // duplicate block id
  const listed = { type: "paragraph", attrs: { id: id(2), listStyle: "bullet", listLevel: 1 } };
  assert.throws(() => editorToCanonical(doc(listed)), DocumentError); // list starts indented
});

test("overlapping anchors survive as separate marks", () => {
  const a = "a0000000-0000-4000-8000-00000000000b", b = "a0000000-0000-4000-8000-00000000000a";
  const out = editorToCanonical(doc(p(1, { type: "text", text: "x", marks: [
    { type: "rolltopAnchor", attrs: { id: a } }, { type: "rolltopAnchor", attrs: { id: b } }] })));
  assert.deepEqual((out.blocks[0] as any).content[0].marks, [{ type: "anchor", id: b }, { type: "anchor", id: a }]);
});

test("a truthy non-boolean quote attr is rejected", () => {
  const q = { type: "paragraph", attrs: { id: id(1), quote: 1 } };
  assert.throws(() => editorToCanonical(doc(q)), DocumentError);
});
