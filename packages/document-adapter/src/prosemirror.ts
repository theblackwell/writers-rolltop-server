// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 The Black Well Foundry
// Canonical document ⇄ Tiptap / ProseMirror JSON.
//
// The editor schema this adapter expects (configure Tiptap with):
//   - Document, Text, Paragraph, Heading (levels 1–6), HardBreak, Bold, Italic, Link
//   - a stable `id` attribute on paragraph and heading nodes (e.g. Tiptap UniqueID,
//     types: ["paragraph", "heading"])
//   - a custom mark `rolltopAnchor` with attrs { id } and `excludes: ""` so several
//     anchors can overlap on the same text
// Editor JSON is never stored; only the canonical document is.

import { canonicalMarks, normalize, validate } from "./canonical.ts";
import type { Block, CanonicalDocument, Inline, Mark } from "./canonical.ts";

export type PMMark = { type: string; attrs?: Record<string, unknown> };
export type PMNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  text?: string;
  marks?: PMMark[];
};

function toPMMark(m: Mark): PMMark {
  switch (m.type) {
    case "strong": return { type: "bold" };
    case "emphasis": return { type: "italic" };
    case "link": return { type: "link", attrs: { href: m.href } };
    case "anchor": return { type: "rolltopAnchor", attrs: { id: m.id } };
  }
}

function toPMInline(i: Inline): PMNode {
  if (i.type === "hardBreak") return { type: "hardBreak" };
  const node: PMNode = { type: "text", text: i.text };
  if (i.marks?.length) node.marks = i.marks.map(toPMMark);
  return node;
}

export function toProseMirror(doc: CanonicalDocument): PMNode {
  return {
    type: "doc",
    content: doc.blocks.map((b) => {
      const node: PMNode = b.type === "heading"
        ? { type: "heading", attrs: { id: b.id, level: b.level } }
        : { type: "paragraph", attrs: { id: b.id } };
      if (b.content.length) node.content = b.content.map(toPMInline);
      return node;
    }),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function fromPMMark(m: PMMark): Mark | null {
  switch (m.type) {
    case "bold": return { type: "strong" };
    case "italic": return { type: "emphasis" };
    case "link": {
      const href = m.attrs?.href;
      return typeof href === "string" && href !== "" ? { type: "link", href } : null;
    }
    case "rolltopAnchor": {
      const id = m.attrs?.id;
      return typeof id === "string" && UUID.test(id) ? { type: "anchor", id } : null;
    }
    default:
      // Presentation-only marks (e.g. a highlight used during editing) are not content.
      return null;
  }
}

/**
 * Converts editor JSON back to a canonical document.
 * Editing repairs (never needed for an unedited round trip):
 *  - a block without an id, or repeating an earlier id (paragraph split), gets `newId()`;
 *  - an anchor that now spans blocks or is no longer contiguous keeps only its first run.
 * Unknown block types are rejected rather than silently dropped.
 */
export function fromProseMirror(pm: PMNode, nodeId: string, newId: () => string = () => crypto.randomUUID()): CanonicalDocument {
  if (pm.type !== "doc") throw new Error("expected a ProseMirror doc node");
  const used = new Set<string>();
  const blocks: Block[] = (pm.content ?? []).map((node) => {
    let id = typeof node.attrs?.id === "string" ? (node.attrs.id as string) : "";
    if (!UUID.test(id) || used.has(id)) id = newId();
    used.add(id);
    const content: Inline[] = [];
    for (const child of node.content ?? []) {
      if (child.type === "hardBreak") { content.push({ type: "hardBreak" }); continue; }
      if (child.type !== "text") throw new Error(`unsupported inline node "${child.type}"`);
      const marks = canonicalMarks((child.marks ?? []).map(fromPMMark).filter((m): m is Mark => m !== null));
      content.push(marks.length ? { type: "text", text: child.text ?? "", marks } : { type: "text", text: child.text ?? "" });
    }
    if (node.type === "heading") {
      const level = Number(node.attrs?.level);
      return { id, type: "heading", level: level >= 1 && level <= 6 ? level : 1, content };
    }
    if (node.type !== "paragraph") throw new Error(`unsupported block node "${node.type}"`);
    return { id, type: "paragraph", content };
  });
  const doc = normalize(repairAnchors(normalize({ schema: "writers-rolltop/document", version: 1, nodeId, blocks })));
  validate(doc);
  return doc;
}

function repairAnchors(doc: CanonicalDocument): CanonicalDocument {
  const earlier = new Set<string>();
  return {
    ...doc,
    blocks: doc.blocks.map((block) => {
      const last = new Map<string, number>();
      const closed = new Set<string>();
      let textIndex = -1;
      const content = block.content.map((inline): Inline => {
        if (inline.type !== "text") return inline;
        textIndex++;
        const kept = (inline.marks ?? []).filter((m) => {
          if (m.type !== "anchor") return true;
          if (earlier.has(m.id) || closed.has(m.id)) return false;
          const prev = last.get(m.id);
          if (prev !== undefined && prev !== textIndex - 1) { closed.add(m.id); return false; }
          last.set(m.id, textIndex);
          return true;
        });
        for (const [id, at] of last) if (at !== textIndex) closed.add(id);
        return kept.length ? { type: "text", text: inline.text, marks: kept } : { type: "text", text: inline.text };
      });
      for (const id of last.keys()) earlier.add(id);
      return { ...block, content };
    }),
  };
}
