// The scene editor: ProseMirror (the @tiptap/pm bundle the document adapter already pins) on the adapter's rolltopSchema.
// The canonical document stays the source of truth: it goes into the editor with canonicalToEditor and comes back out with
// editorToCanonical (normalised, mark order enforced). There is no second conversion here. This file has no React and
// touches the DOM only in the node and mark views, so the state logic runs under node --test.
import { DOMSerializer, Fragment, Slice } from "@tiptap/pm/model";
import type { Mark, Node as PMNode, DOMOutputSpec } from "@tiptap/pm/model";
import { EditorState, Plugin, TextSelection } from "@tiptap/pm/state";
import type { Command } from "@tiptap/pm/state";
import { history, redo, redoDepth, undo, undoDepth } from "@tiptap/pm/history";
import { keymap } from "@tiptap/pm/keymap";
import { baseKeymap, splitBlockAs, toggleMark } from "@tiptap/pm/commands";
import type { MarkViewConstructor, NodeViewConstructor } from "@tiptap/pm/view";
import { canonicalToEditor, editorToCanonical, rolltopSchema } from "@writers-rolltop/document-adapter";
import type { CanonicalDocument, PMJSON } from "@writers-rolltop/document-adapter";

const S = rolltopSchema;

/** A random v4 uuid. crypto.randomUUID needs a secure context, and a self-hosted server may be plain http on a LAN. */
export function newId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ---------- plugins ----------

/** Keeps the document valid while the author types: every block has its own id, and an anchor is in one block only. */
const keepValid = new Plugin({
  appendTransaction(trs, _old, state) {
    if (!trs.some((t) => t.docChanged)) return null;
    const tr = state.tr;
    const seen = new Set<string>();
    const anchors = new Set<string>();
    state.doc.forEach((block, offset) => {
      const id = block.attrs.id as unknown;
      if (typeof id !== "string" || seen.has(id)) tr.setNodeMarkup(offset, undefined, { ...block.attrs, id: newId() });
      else seen.add(id);
      // An anchor id may live in one block. A block split can copy it into the next block: drop the later copy.
      const here = new Set<string>();
      block.descendants((n, pos) => {
        for (const m of n.marks) {
          if (m.type !== S.marks.rolltopAnchor) continue;
          const aid = m.attrs.id as string;
          if (anchors.has(aid) && !here.has(aid)) tr.removeMark(offset + 1 + pos, offset + 1 + pos + n.nodeSize, m);
          else here.add(aid);
        }
      });
      for (const a of here) anchors.add(a);
    });
    return tr.docChanged ? tr : null;
  },
});

// ---------- commands ----------

const para = S.nodes.paragraph!;

/** Enter: ends a list on an empty list item, starts a paragraph after a heading, else splits the block. */
const enter: Command = (state, dispatch, view) => {
  const { $from, empty } = state.selection;
  const block = $from.parent;
  if (empty && block.type === para && block.attrs.listStyle && block.content.size === 0) {
    dispatch?.(state.tr.setNodeMarkup($from.before(), undefined, { ...block.attrs, listStyle: null, listLevel: null }));
    return true;
  }
  return splitBlockAs((node, atEnd) => (atEnd && node.type === S.nodes.heading ? { type: para, attrs: { id: newId() } } : null))(state, dispatch, view);
};

const hardBreak: Command = (state, dispatch) => {
  dispatch?.(state.tr.replaceSelectionWith(S.nodes.hardBreak!.create()).scrollIntoView());
  return true;
};

/** Bulleted or numbered list on the paragraphs in the selection; the same style again takes them out of the list. */
export function toggleList(style: "bullet" | "ordered"): Command {
  return (state, dispatch) => {
    const { from, to } = state.selection;
    const targets: { pos: number; node: PMNode }[] = [];
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (node.type === para) targets.push({ pos, node });
      return false;
    });
    if (targets.length === 0) return false;
    if (dispatch) {
      const off = targets.every((t) => t.node.attrs.listStyle === style);
      const tr = state.tr;
      for (const t of targets) {
        tr.setNodeMarkup(t.pos, undefined, off
          ? { ...t.node.attrs, listStyle: null, listLevel: null }
          : { ...t.node.attrs, listStyle: style, listLevel: 0, quote: false });
      }
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

export const commands = {
  undo, redo,
  bold: toggleMark(S.marks.bold!), italic: toggleMark(S.marks.italic!), underline: toggleMark(S.marks.underline!),
  bullet: toggleList("bullet"), ordered: toggleList("ordered"),
};

// ---------- state ----------

/** The working copy of a canonical document, as an editor state. An empty scene gets one empty paragraph to type in. */
export function stateFromCanonical(doc: CanonicalDocument): EditorState {
  const json = canonicalToEditor(doc);
  if (!json.content?.length) json.content = [{ type: "paragraph", attrs: { id: newId(), align: null, quote: false, listStyle: null, listLevel: null } }];
  const node = S.nodeFromJSON(json);
  return EditorState.create({
    doc: node,
    plugins: [
      history(),
      keymap({
        "Mod-z": undo, "Mod-y": redo, "Shift-Mod-z": redo,
        "Mod-b": commands.bold, "Mod-i": commands.italic, "Mod-u": commands.underline,
        Enter: enter, "Shift-Enter": hardBreak,
      }),
      keymap(baseKeymap),
      keepValid,
    ],
  });
}

/** The normalised canonical document for a state. Throws DocumentError if the text cannot be stored as it is. */
export function canonicalFromState(state: EditorState): CanonicalDocument {
  return editorToCanonical(state.doc.toJSON() as PMJSON);
}

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Plain text pasted or dropped in becomes paragraphs. HTML is not read: only text comes in. */
export function paragraphsFromText(text: string): Slice {
  const lines = text.replace(/\r\n?|\u2028|\u2029/g, "\n").split("\n");
  const nodes = lines.map((raw) => {
    const l = raw.replace(CONTROL, ""); // the document format refuses these characters
    return para.create({ id: newId(), align: null, quote: false, listStyle: null, listLevel: null }, l ? S.text(l) : null);
  });
  return new Slice(Fragment.from(nodes), 1, 1);
}

// ---------- how the schema is drawn (the schema itself has no toDOM) ----------

const safeHref = (h: string): string | undefined => (/^(https?:|mailto:)/i.test(h) ? h : undefined);

function blockClasses(n: PMNode): string {
  const c = ["rt-block"];
  if (n.attrs.align) c.push(`rt-align-${n.attrs.align as string}`);
  if (n.attrs.quote) c.push("rt-quote");
  if (n.attrs.listStyle) c.push(`rt-${n.attrs.listStyle === "ordered" ? "ordered" : "bullet"}`);
  return c.join(" ");
}

const nodeSpec: Record<string, (n: PMNode) => DOMOutputSpec> = {
  paragraph: (n) => ["p", { class: blockClasses(n), ...(n.attrs.listLevel ? { style: `--rt-level:${String(n.attrs.listLevel)}` } : {}) }, 0],
  // Scene headings sit below the page title (h2), so they are drawn as labelled headings at level 3 or deeper.
  heading: (n) => ["div", { class: `${blockClasses(n)} rt-heading rt-h${String(n.attrs.level)}`, role: "heading", "aria-level": String(Math.min(6, Number(n.attrs.level) + 2)) }, 0],
  sceneBreak: () => ["div", { class: "rt-break", role: "separator", "aria-label": "Scene break" }],
  hardBreak: () => ["br"],
};
const markSpec: Record<string, (m: Mark) => DOMOutputSpec> = {
  bold: () => ["strong", 0],
  italic: () => ["em", 0],
  underline: () => ["u", 0],
  link: (m) => { const href = safeHref(m.attrs.href as string); return ["a", { ...(href ? { href } : {}), rel: "noopener noreferrer", class: "rt-link" }, 0]; },
  rolltopAnchor: (m) => ["span", { class: "rt-anchor", "data-anchor": m.attrs.id as string }, 0],
};

export const nodeViews: Record<string, NodeViewConstructor> = Object.fromEntries(
  Object.entries(nodeSpec).map(([name, f]) => [name, (n: PMNode) => {
    const { dom, contentDOM } = DOMSerializer.renderSpec(document, f(n));
    return contentDOM ? { dom, contentDOM } : { dom };
  }]),
);
export const markViews: Record<string, MarkViewConstructor> = Object.fromEntries(
  Object.entries(markSpec).map(([name, f]) => [name, (m: Mark) => {
    const { dom, contentDOM } = DOMSerializer.renderSpec(document, f(m));
    return contentDOM ? { dom, contentDOM } : { dom };
  }]),
);

export const clipboardSerializer = (): DOMSerializer =>
  new DOMSerializer(
    Object.fromEntries(Object.entries(nodeSpec).map(([k, f]) => [k, f])),
    Object.fromEntries(Object.entries(markSpec).map(([k, f]) => [k, f])),
  );


// ---------- what the toolbar shows ----------

export interface ToolbarState { bold: boolean; italic: boolean; underline: boolean; bullet: boolean; ordered: boolean; canUndo: boolean; canRedo: boolean }

export function toolbarState(state: EditorState): ToolbarState {
  const { from, to, empty, $from } = state.selection;
  const marked = (t: typeof S.marks[string]): boolean => (empty ? !!t.isInSet(state.storedMarks ?? $from.marks()) : state.doc.rangeHasMark(from, to, t));
  const styles: unknown[] = [];
  state.doc.nodesBetween(from, to, (n) => { if (n.type === para) styles.push(n.attrs.listStyle); return false; });
  const all = (s: string): boolean => styles.length > 0 && styles.every((x) => x === s);
  return {
    bold: marked(S.marks.bold!), italic: marked(S.marks.italic!), underline: marked(S.marks.underline!),
    bullet: all("bullet"), ordered: all("ordered"),
    canUndo: undoDepth(state) > 0, canRedo: redoDepth(state) > 0,
  };
}
