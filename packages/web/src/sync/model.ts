// The browser's local copy of the library, built only from the server's change feed (sync-protocol-v1.md). It is a plain
// read model: records by kind and id, and the current document and revision of each scene. Nothing here is saved to disk.
import type { CanonicalDocument } from "@writers-rolltop/document-adapter";

export interface SyncChange {
  seq: number; at: string; opId: string; deviceId: string; change: string; recordKind: string; recordId: string;
  field?: string; value?: unknown; revision?: number;
}

export type Rec = Record<string, unknown> & { id: string };
export interface DocState { revision: number; seq: number; doc: unknown }

export interface Model {
  records: Map<string, Map<string, Rec>>;
  docs: Map<string, DocState>;
  /** True once the feed has shown the library record being created. An imported library has no such change. */
  sawLibraryCreate: boolean;
  /** The seq of the last change applied. */
  cursor: number;
  /** The seq of the change that last made or changed a record ("kind/id") or one of its fields ("kind/id#field"). Used as baseSeq. */
  seqs: Map<string, number>;
}

export const emptyModel = (): Model => ({ records: new Map(), docs: new Map(), sawLibraryCreate: false, cursor: 0, seqs: new Map() });

/** The baseSeq for a set or unset of one field: the newest change this model has seen on that field, or on the record's creation. */
export const fieldBase = (m: Model, kind: string, id: string, field: string): number =>
  Math.max(m.seqs.get(`${kind}/${id}#${field}`) ?? 0, m.seqs.get(`${kind}/${id}`) ?? 0);

export class FeedError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Applies one change. Changes must arrive in seq order; a gap or a repeat is an error, not something to skip. */
export function applyChange(m: Model, c: SyncChange): void {
  if (c.seq !== m.cursor + 1) throw new FeedError(`change ${c.seq} does not follow ${m.cursor}`);
  m.cursor = c.seq;
  if (c.recordKind === "document") {
    if (c.change === "document" && typeof c.revision === "number") {
      // A pull that started before a save can bring an older revision after the save was applied: never go back.
      const have = m.docs.get(c.recordId);
      if (!have || c.revision >= have.revision) m.docs.set(c.recordId, { revision: c.revision, seq: c.seq, doc: c.value });
    }
    return;
  }
  const kind = m.records.get(c.recordKind) ?? new Map<string, Rec>();
  m.records.set(c.recordKind, kind);
  switch (c.change) {
    case "create":
      if (isObj(c.value)) kind.set(c.recordId, { ...c.value, id: c.recordId });
      m.seqs.set(`${c.recordKind}/${c.recordId}`, c.seq);
      if (c.recordKind === "library") m.sawLibraryCreate = true;
      break;
    case "set": case "unset": {
      const r = kind.get(c.recordId);
      if (!r || !c.field) break;
      m.seqs.set(`${c.recordKind}/${c.recordId}#${c.field}`, c.seq);
      const path = c.field.split("/"); // "values/<fieldId>" and "overrides/<bookId>" reach into an object
      let at: Record<string, unknown> = r;
      for (const p of path.slice(0, -1)) {
        const next = at[p];
        at = isObj(next) ? next : (at[p] = {}) as Record<string, unknown>;
      }
      const last = path[path.length - 1]!;
      if (c.change === "set") at[last] = c.value; else delete at[last];
      break;
    }
    case "tombstone": { const r = kind.get(c.recordId); if (r) r.deletedAt = c.at; break; }
    case "restore": { const r = kind.get(c.recordId); if (r) delete r.deletedAt; break; }
  }
}

export const hasAnyRecord = (m: Model): boolean => [...m.records.values()].some((k) => k.size > 0) || m.docs.size > 0;

const byOrder = (a: Rec, b: Rec): number => {
  const x = String(a.orderKey ?? ""), y = String(b.orderKey ?? "");
  return x < y ? -1 : x > y ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

export const liveBooks = (m: Model): Rec[] => [...(m.records.get("book")?.values() ?? [])].filter((b) => !b.deletedAt).sort(byOrder);

export interface OutlineItem { node: Rec; depth: number; hasDocument: boolean }

/** The manuscript of one book in reading order. A trashed node hides its children, as the server's reads do. */
export function outline(m: Model, bookId: string): OutlineItem[] {
  const all = [...(m.records.get("manuscriptNode")?.values() ?? [])].filter((n) => n.bookId === bookId);
  const children = new Map<string, Rec[]>();
  const ids = new Set(all.map((n) => n.id));
  for (const n of all) {
    const p = typeof n.parentId === "string" && ids.has(n.parentId) ? n.parentId : "";
    children.set(p, [...(children.get(p) ?? []), n]);
  }
  const out: OutlineItem[] = [];
  const walk = (parent: string, depth: number): void => {
    for (const n of (children.get(parent) ?? []).sort(byOrder)) {
      if (n.deletedAt) continue;
      out.push({ node: n, depth, hasDocument: n.kind === "scene" || n.kind === "frontMatter" || n.kind === "backMatter" });
      walk(n.id, depth + 1);
    }
  };
  walk("", 0);
  return out;
}

/** A scene is open for editing only if it is live and none of its ancestors is trashed. */
export function sceneIsLive(m: Model, id: string): boolean {
  const nodes = m.records.get("manuscriptNode");
  let n = nodes?.get(id);
  for (let i = 0; n && i < 64; i++) {
    if (n.deletedAt) return false;
    if (typeof n.parentId !== "string") return true;
    n = nodes?.get(n.parentId);
  }
  return n !== undefined;
}

/** Document of a scene as the server last told us. A scene with no document yet is an empty one at revision 0. */
export function sceneDocument(m: Model, id: string): { revision: number; doc: CanonicalDocument } {
  const d = m.docs.get(id);
  if (d) return { revision: d.revision, doc: d.doc as CanonicalDocument };
  return { revision: 0, doc: { schema: "writers-rolltop/document", version: 1, nodeId: id, blocks: [] } };
}

/** The text of a document as plain lines, for showing two versions side by side. */
export function plainText(doc: unknown): string {
  const blocks = isObj(doc) && Array.isArray(doc.blocks) ? doc.blocks : [];
  return blocks.map((b: unknown) => {
    if (!isObj(b)) return "";
    if (b.type === "sceneBreak") return "* * *";
    const content = Array.isArray(b.content) ? b.content : [];
    const line = content.map((i: unknown) => (isObj(i) ? (i.type === "hardBreak" ? "\n" : typeof i.text === "string" ? i.text : "") : "")).join("");
    const list = isObj(b.list) ? (b.list.style === "ordered" ? "1. " : "- ") : "";
    return list + line;
  }).join("\n\n");
}
