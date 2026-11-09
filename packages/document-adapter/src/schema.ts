import { Schema } from "@tiptap/pm/model";
import type { NodeSpec, MarkSpec } from "@tiptap/pm/model";

// Tiptap-conventional names (ADR-0001 D6): bold, italic, underline, link, rolltopAnchor.
// Blocks stay flat (ADR D1 / document-format-v1 "Blocks are flat"): quote, list and align are
// attributes on the block, so no nesting/grouping is needed.
const blockAttrs = {
  id: {},
  align: { default: null },
  quote: { default: false },
};

const nodes: Record<string, NodeSpec> = {
  doc: { attrs: { nodeId: {} }, content: "block*" },
  paragraph: {
    group: "block", content: "inline*",
    attrs: { ...blockAttrs, listStyle: { default: null }, listLevel: { default: null } },
  },
  heading: { group: "block", content: "inline*", attrs: { ...blockAttrs, level: { default: 1 } } },
  sceneBreak: { group: "block", atom: true, attrs: { id: {} } },
  text: { group: "inline" },
  hardBreak: { group: "inline", inline: true, selectable: false },
};

const marks: Record<string, MarkSpec> = {
  bold: {},
  italic: {},
  underline: {},
  link: { attrs: { href: {} }, inclusive: false },
  // Several anchors may overlap on the same text.
  rolltopAnchor: { attrs: { id: {} }, excludes: "", inclusive: false },
};

export const rolltopSchema = new Schema({ nodes, marks, topNode: "doc" });
