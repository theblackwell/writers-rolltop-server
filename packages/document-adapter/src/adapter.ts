import { Node } from "@tiptap/pm/model";
import { rolltopSchema } from "./schema.ts";
import { normalizeDocument, DocumentError } from "./canonical.ts";
import type { Align, Block, CanonicalDocument, Inline, Mark } from "./canonical.ts";

export interface PMJSON { type: string; attrs?: Record<string, unknown>; content?: PMJSON[]; marks?: PMJSON[]; text?: string }

const TO_PM: Record<string, string> = { strong: "bold", emphasis: "italic", underline: "underline", link: "link", anchor: "rolltopAnchor" };
const FROM_PM: Record<string, string> = Object.fromEntries(Object.entries(TO_PM).map(([a, b]) => [b, a]));

function inlineToPM(i: Inline): PMJSON {
  if (i.type === "hardBreak") return { type: "hardBreak" };
  const out: PMJSON = { type: "text", text: i.text };
  if (i.marks?.length) {
    out.marks = i.marks.map((m) => {
      const { type, ...attrs } = m;
      return Object.keys(attrs).length ? { type: TO_PM[type]!, attrs } : { type: TO_PM[type]! };
    });
  }
  return out;
}

/** Canonical document (untrusted; validated and normalized) to ProseMirror/Tiptap doc JSON. */
export function canonicalToEditor(input: unknown): PMJSON {
  const doc = normalizeDocument(input);
  const content = doc.blocks.map((b): PMJSON => {
    if (b.type === "sceneBreak") return { type: "sceneBreak", attrs: { id: b.id } };
    const attrs: Record<string, unknown> = { id: b.id, align: b.align ?? null, quote: b.quote === true };
    const node: PMJSON = { type: b.type, attrs };
    if (b.type === "heading") attrs.level = b.level;
    else { attrs.listStyle = b.list?.style ?? null; attrs.listLevel = b.list?.level ?? null; }
    if (b.content.length) node.content = b.content.map(inlineToPM);
    return node;
  });
  const json: PMJSON = { type: "doc", attrs: { nodeId: doc.nodeId } };
  if (content.length) json.content = content;
  return json;
}

function inlineFromPM(n: Node): Inline {
  if (n.type.name === "hardBreak") return { type: "hardBreak" };
  const marks = n.marks.map((m): Mark => {
    const type = FROM_PM[m.type.name]!;
    return { type, ...m.attrs } as Mark;
  });
  return { type: "text", text: n.text ?? "", marks };
}

/** ProseMirror/Tiptap doc JSON to a normalized, validated canonical document. */
export function editorToCanonical(json: unknown): CanonicalDocument {
  let doc: Node;
  try {
    doc = Node.fromJSON(rolltopSchema, json);
    doc.check();
  } catch (e) {
    throw new DocumentError("DOCUMENT_INVALID", `editor JSON does not match the schema: ${(e as Error).message}`);
  }
  const blocks: unknown[] = [];
  doc.forEach((n) => {
    const a = n.attrs;
    if (n.type.name === "sceneBreak") { blocks.push({ id: a.id, type: "sceneBreak" }); return; }
    const b: Record<string, unknown> = { id: a.id, type: n.type.name };
    if (n.type.name === "heading") b.level = a.level;
    if (a.align) b.align = a.align as Align;
    if (a.quote !== true && a.quote !== false) throw new DocumentError("DOCUMENT_INVALID", "quote attr must be true or false");
    if (a.quote) b.quote = true;
    if (a.listStyle != null) b.list = { style: a.listStyle, level: a.listLevel };
    const content: Inline[] = [];
    n.forEach((c) => content.push(inlineFromPM(c)));
    b.content = content;
    blocks.push(b as unknown as Block);
  });
  return normalizeDocument({ schema: "writers-rolltop/document", version: 1, nodeId: doc.attrs.nodeId, blocks });
}
