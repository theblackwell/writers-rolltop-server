// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 The Black Well Foundry
// Canonical document ⇄ Tiptap / ProseMirror JSON.
//
// The editor schema this adapter expects (configure Tiptap with):
//   - Document, Text, Paragraph, Heading (levels 1–6), HardBreak, HorizontalRule,
//     Blockquote, BulletList, OrderedList, ListItem, Bold, Italic, Underline, Link,
//     TextAlign (types: ["paragraph", "heading"], alignments: left/center/right)
//   - a stable `id` attribute on paragraph, heading and horizontalRule nodes
//     (e.g. Tiptap UniqueID, types: ["paragraph", "heading", "horizontalRule"])
//   - a custom mark `rolltopAnchor` with attrs { id } and `excludes: ""` so several
//     anchors can overlap on the same text
// Canonical blocks are flat; ProseMirror nests. Consecutive quoted blocks become one
// `blockquote`; each run of list items becomes nested bulletList/orderedList >
// listItem > paragraph. Editor JSON is never stored; only the canonical document is.

import { canonicalMarks, MAX_LIST_LEVEL, normalize, validate } from "./canonical.ts";
import type { Align, Block, CanonicalDocument, Inline, ListItem, Mark } from "./canonical.ts";

export type PMMark = { type: string; attrs?: Record<string, unknown> };
export type PMNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  text?: string;
  marks?: PMMark[];
};

// ---------------------------------------------------------------------------
// Canonical → ProseMirror

function toPMMark(m: Mark): PMMark {
  switch (m.type) {
    case "strong": return { type: "bold" };
    case "emphasis": return { type: "italic" };
    case "underline": return { type: "underline" };
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

type TextBlock = Exclude<Block, { type: "sceneBreak" }>;

function toPMTextBlock(b: TextBlock): PMNode {
  const attrs: Record<string, unknown> = { id: b.id };
  if (b.type === "heading") attrs.level = b.level;
  if (b.align) attrs.textAlign = b.align;
  const node: PMNode = { type: b.type, attrs };
  if (b.content.length) node.content = b.content.map(toPMInline);
  return node;
}

const listNodeType = (style: ListItem["style"]) => (style === "bullet" ? "bulletList" : "orderedList");

/** Builds nested lists from a run of list items whose first item is level 0 (validated). */
function toPMLists(items: TextBlock[]): PMNode[] {
  let i = 0;
  const level = (b: TextBlock) => (b.type === "paragraph" && b.list ? b.list.level : -1);
  const style = (b: TextBlock) => (b as { list: ListItem }).list.style;
  function atLevel(depth: number): PMNode[] {
    const lists: PMNode[] = [];
    while (i < items.length && level(items[i]) === depth) {
      const s = style(items[i]);
      const list: PMNode = { type: listNodeType(s), content: [] };
      while (i < items.length && level(items[i]) === depth && style(items[i]) === s) {
        const item: PMNode = { type: "listItem", content: [toPMTextBlock(items[i])] };
        i++;
        if (i < items.length && level(items[i]) > depth) item.content!.push(...atLevel(depth + 1));
        list.content!.push(item);
      }
      lists.push(list);
    }
    return lists;
  }
  return atLevel(0);
}

export function toProseMirror(doc: CanonicalDocument): PMNode {
  const out: PMNode[] = [];
  const blocks = doc.blocks;
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i];
    if (b.type === "sceneBreak") {
      out.push({ type: "horizontalRule", attrs: { id: b.id } });
      i++;
    } else if (b.type === "paragraph" && b.list) {
      const run: TextBlock[] = [];
      while (i < blocks.length && blocks[i].type === "paragraph" && (blocks[i] as TextBlock & { list?: ListItem }).list) {
        run.push(blocks[i] as TextBlock);
        i++;
      }
      out.push(...toPMLists(run));
    } else if (b.quote) {
      const quoted: PMNode[] = [];
      while (i < blocks.length && blocks[i].type !== "sceneBreak" && (blocks[i] as TextBlock).quote) {
        quoted.push(toPMTextBlock(blocks[i] as TextBlock));
        i++;
      }
      out.push({ type: "blockquote", content: quoted });
    } else {
      out.push(toPMTextBlock(b));
      i++;
    }
  }
  return { type: "doc", content: out };
}

// ---------------------------------------------------------------------------
// ProseMirror → canonical

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function fromPMMark(m: PMMark): Mark | null {
  switch (m.type) {
    case "bold": return { type: "strong" };
    case "italic": return { type: "emphasis" };
    case "underline": return { type: "underline" };
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

type Context = { quote: boolean; lists: ListItem["style"][] };

/**
 * Converts editor JSON back to a canonical document.
 * Editing repairs (never needed for an unedited round trip):
 *  - a block without an id, or repeating an earlier id (paragraph split), gets `newId()`;
 *  - an anchor that now spans blocks or is no longer contiguous keeps only its first run;
 *  - list levels that skip are lowered, list items inside a quote lose the quote, and
 *    headings inside list items lose the list (canonical v1 can't express those);
 *  - a list item with several paragraphs becomes several items at the same level.
 * Unknown node types are rejected rather than silently dropped.
 */
export function fromProseMirror(pm: PMNode, nodeId: string, newId: () => string = () => crypto.randomUUID()): CanonicalDocument {
  if (pm.type !== "doc") throw new Error("expected a ProseMirror doc node");
  const used = new Set<string>();
  const blockId = (node: PMNode) => {
    let id = typeof node.attrs?.id === "string" ? (node.attrs.id as string) : "";
    if (!UUID.test(id) || used.has(id)) id = newId();
    used.add(id);
    return id;
  };
  const blocks: Block[] = [];

  function textBlock(node: PMNode, ctx: Context): Block {
    const content: Inline[] = [];
    for (const child of node.content ?? []) {
      if (child.type === "hardBreak") { content.push({ type: "hardBreak" }); continue; }
      if (child.type !== "text") throw new Error(`unsupported inline node "${child.type}"`);
      const marks = canonicalMarks((child.marks ?? []).map(fromPMMark).filter((m): m is Mark => m !== null));
      content.push(marks.length ? { type: "text", text: child.text ?? "", marks } : { type: "text", text: child.text ?? "" });
    }
    const align = node.attrs?.textAlign;
    const props: { align?: Align; quote?: true } = {};
    if (align === "left" || align === "center" || align === "right") props.align = align;
    if (ctx.quote) props.quote = true;
    if (node.type === "heading") {
      const level = Number(node.attrs?.level);
      return { id: blockId(node), type: "heading", level: level >= 1 && level <= 6 ? level : 1, content, ...props };
    }
    const block: Block = { id: blockId(node), type: "paragraph", content, ...props };
    if (ctx.lists.length) block.list = { style: ctx.lists[ctx.lists.length - 1], level: ctx.lists.length - 1 };
    return block;
  }

  function walk(nodes: PMNode[], ctx: Context) {
    for (const node of nodes) {
      switch (node.type) {
        case "paragraph":
        case "heading":
          blocks.push(textBlock(node, ctx));
          break;
        case "horizontalRule":
          blocks.push({ id: blockId(node), type: "sceneBreak" });
          break;
        case "blockquote":
          walk(node.content ?? [], { ...ctx, quote: true });
          break;
        case "bulletList":
        case "orderedList": {
          const style = node.type === "bulletList" ? "bullet" : "ordered";
          for (const item of node.content ?? []) {
            if (item.type !== "listItem") throw new Error(`unsupported list child "${item.type}"`);
            walk(item.content ?? [], { ...ctx, lists: [...ctx.lists, style] });
          }
          break;
        }
        default:
          throw new Error(`unsupported block node "${node.type}"`);
      }
    }
  }

  walk(pm.content ?? [], { quote: false, lists: [] });
  const doc = normalize(repairAnchors(normalize({ schema: "writers-rolltop/document", version: 1, nodeId, blocks: repairStructure(blocks) })));
  validate(doc);
  return doc;
}

/** Makes editor-produced block properties valid without touching any text. */
function repairStructure(blocks: Block[]): Block[] {
  let previous: number | undefined;
  return blocks.map((b) => {
    if (b.type !== "paragraph" || !b.list) { previous = undefined; return b; }
    const level = Math.min(b.list.level, previous === undefined ? 0 : previous + 1, MAX_LIST_LEVEL);
    previous = level;
    const { quote: _dropped, ...rest } = b;
    return { ...rest, list: { style: b.list.style, level } };
  });
}

function repairAnchors(doc: CanonicalDocument): CanonicalDocument {
  const earlier = new Set<string>();
  return {
    ...doc,
    blocks: doc.blocks.map((block) => {
      if (block.type === "sceneBreak") return block;
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
