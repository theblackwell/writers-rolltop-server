// Continuity warnings with their dismissal keys (archive-format-v1.md, "Dismissed continuity warnings"). Worked out from
// the records and the documents' word counts only, never from the prose, and shared by the archive validator
// (W_STATE_CONFLICT) and the server's warnings route, so the two cannot disagree.
//
// Reading of the spec where it is not explicit (all listed in PROGRESS.md as open questions):
// - "In the trash" is the spec's sense: the node is tombstoned, or an ancestor node or its book is.
// - learnedBeforeEstablished follows the spec literally: it has no trash exemption, so it is reported even when a node is in the trash
//   (owner, 2026-11-12), alongside the trash warnings.
// - questionOverdue counts only live text (owner, 2026-11-12): a trashed descendant, and everything under it, is not text the author sees.
// - W_CHRONOLOGY_ORDINAL, W_REFERENCE_TO_DELETED and W_REFERENCE_ANCHOR_MISSING have no key in the spec and are not here.
// - Per book: only the two kinds whose condition reads an overridable property (undecidedButKnown reads `truth`,
//   questionOverdue reads `status`) differ between books. See `bookId` and `exceptBookIds`.

import { stableStringify } from "./json.ts";
import type { ArchiveData, Rec } from "./model.ts";
import { countWords } from "./words.ts";

export type ContinuityKind =
  | "learnedBeforeEstablished" | "establishedInTrash" | "learnedInTrash" | "aboutMissingEntry"
  | "knowerMissing" | "undecidedButKnown" | "questionOverdue" | "stateConflict";

export interface ContinuityWarning {
  /** The dismissal key, exactly as the spec builds it (matches `^[A-Za-z]+(:[0-9A-Za-z-]+)*$`, at most 400 characters). */
  key: string;
  kind: ContinuityKind;
  /** The record the warning is on (dismissals are stored there): a fact, a question or an event. */
  recordKind: "fact" | "question" | "event";
  recordId: string;
  entryId?: string;
  fieldId?: string;
  /** `reader` or a character entry id. */
  knower?: string;
  /** The node where the fact is established (`factNodeId`) or the node a knower learns it at (`learnNodeId`); `nodeId` is a question's node. */
  factNodeId?: string;
  learnNodeId?: string;
  nodeId?: string;
  /** Set when the warning holds only in this book (a book override makes the condition true there). */
  bookId?: string;
  /** Set when the warning holds in every book of the record's scope except these (an override clears the condition there). */
  exceptBookIds?: string[];
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byOrder = (a: Rec, b: Rec): number => cmp(a.orderKey ?? "", b.orderKey ?? "") || cmp(a.id, b.id);

export function continuityWarnings(d: ArchiveData): ContinuityWarning[] {
  const books = new Map<string, Rec>((d.library.books ?? []).map((b: Rec) => [b.id, b]));
  const nodes = new Map<string, Rec>((d.library.manuscriptNodes ?? []).map((n: Rec) => [n.id, n]));
  const entries = new Map<string, Rec>(d.entries.map((e) => [e.id, e]));
  const events = new Map<string, Rec>(d.events.map((e) => [e.id, e]));

  const inTrashMemo = new Map<string, boolean>();
  const inTrash = (id: string): boolean => {
    const known = inTrashMemo.get(id);
    if (known !== undefined) return known;
    let result = false;
    const seen = new Set<string>();
    for (let n = nodes.get(id); n && !seen.has(n.id); n = n.parentId === undefined ? undefined : nodes.get(n.parentId)) {
      seen.add(n.id);
      if (n.deletedAt !== undefined || books.get(n.bookId)?.deletedAt !== undefined) { result = true; break; }
    }
    inTrashMemo.set(id, result);
    return result;
  };

  // Story order of every node: books by orderKey, then the reading order of each (parts, chapters, scenes; a chapter just before its scenes).
  const children = new Map<string, Rec[]>();
  const roots = new Map<string, Rec[]>();
  for (const n of nodes.values()) {
    const list = n.parentId === undefined ? roots : children;
    const key = n.parentId === undefined ? n.bookId : n.parentId;
    const l = list.get(key);
    if (l) l.push(n); else list.set(key, [n]);
  }
  const position = new Map<string, number>();
  const visit = (n: Rec, depth: number): void => {
    if (position.has(n.id) || depth > 64) return;
    position.set(n.id, position.size);
    for (const c of (children.get(n.id) ?? []).sort(byOrder)) visit(c, depth + 1);
  };
  for (const b of [...books.values()].sort(byOrder)) for (const n of (roots.get(b.id) ?? []).sort(byOrder)) visit(n, 0);

  // Words under a node: its own document, or the documents of its live descendants.
  const wordMemo = new Map<string, boolean>();
  const hasText = (id: string, depth = 0): boolean => {
    const known = wordMemo.get(id);
    if (known !== undefined) return known;
    const doc = d.documents.get(id);
    let result = doc !== undefined && countWords(doc) > 0;
    if (!result && depth < 64) {
      for (const c of children.get(id) ?? []) if (c.deletedAt === undefined && hasText(c.id, depth + 1)) { result = true; break; }
    }
    wordMemo.set(id, result);
    return result;
  };

  const out: ContinuityWarning[] = [];
  const dismissed = (r: Rec, key: string): boolean => Array.isArray(r.dismissedWarnings) && r.dismissedWarnings.some((x: Rec) => x.warning === key);
  const add = (r: Rec, recordKind: ContinuityWarning["recordKind"], kind: ContinuityKind, key: string, extra: Partial<ContinuityWarning> = {}): void => {
    if (dismissed(r, key)) return;
    out.push({ key, kind, recordKind, recordId: r.id, ...extra });
  };
  /** A condition that depends on one overridable property: shared (with the books that clear it), or per book. */
  const perBook = (r: Rec, recordKind: "fact" | "question", kind: ContinuityKind, key: string, property: string, holds: (value: any) => boolean, extra: Partial<ContinuityWarning> = {}): void => {
    const overridden = new Map<string, any>();
    for (const o of Array.isArray(r.overrides) ? r.overrides : []) if (o[property] !== undefined && !overridden.has(o.bookId)) overridden.set(o.bookId, o[property]);
    if (holds(r[property])) {
      const except = [...overridden].filter(([, v]) => !holds(v)).map(([b]) => b).sort(cmp);
      add(r, recordKind, kind, key, except.length > 0 ? { ...extra, exceptBookIds: except } : extra);
    } else {
      for (const b of [...overridden.keys()].sort(cmp)) if (holds(overridden.get(b))) add(r, recordKind, kind, key, { ...extra, bookId: b });
    }
  };

  for (const f of [...d.facts].sort(byOrder)) {
    if (f.deletedAt !== undefined) continue;
    const knowledge: Rec[] = f.knowledge ?? [];
    if (f.nodeId !== undefined && inTrash(f.nodeId)) add(f, "fact", "establishedInTrash", `establishedInTrash:${f.nodeId}`, { factNodeId: f.nodeId });
    for (const k of knowledge) {
      if (k.nodeId !== undefined && inTrash(k.nodeId)) add(f, "fact", "learnedInTrash", `learnedInTrash:${k.knower}:${k.nodeId}`, { knower: k.knower, learnNodeId: k.nodeId });
      if (k.nodeId !== undefined && f.nodeId !== undefined) {
        const learn = position.get(k.nodeId), made = position.get(f.nodeId);
        if (learn !== undefined && made !== undefined && learn < made) {
          add(f, "fact", "learnedBeforeEstablished", `learnedBeforeEstablished:${k.knower}:${k.nodeId}:${f.nodeId}`, { knower: k.knower, learnNodeId: k.nodeId, factNodeId: f.nodeId });
        }
      }
      if (k.knower !== "reader" && entries.get(k.knower)?.deletedAt !== undefined) add(f, "fact", "knowerMissing", `knowerMissing:${k.knower}`, { knower: k.knower });
    }
    for (const id of f.entryIds ?? []) if (entries.get(id)?.deletedAt !== undefined) add(f, "fact", "aboutMissingEntry", `aboutMissingEntry:${id}`, { entryId: id });
    if (knowledge.length > 0) perBook(f, "fact", "undecidedButKnown", "undecidedButKnown", "truth", (v) => v === "undecided");
  }

  for (const q of [...d.questions].sort(byOrder)) {
    if (q.deletedAt !== undefined || q.nodeId === undefined || inTrash(q.nodeId) || !hasText(q.nodeId)) continue;
    perBook(q, "question", "questionOverdue", `questionOverdue:${q.nodeId}`, "status", (v) => v === "open", { nodeId: q.nodeId });
  }

  // Live state changes at one live event that set one entry's field to different values.
  const groups = new Map<string, Rec[]>();
  for (const c of d.stateChanges) {
    if (c.deletedAt !== undefined || c.eventId === undefined) continue;
    const ev = events.get(c.eventId);
    if (!ev || ev.deletedAt !== undefined) continue;
    const key = `${c.eventId}\0${c.entryId}\0${c.fieldId}`;
    const g = groups.get(key);
    if (g) g.push(c); else groups.set(key, [c]);
  }
  for (const [, group] of [...groups].sort((a, b) => cmp(a[0], b[0]))) {
    const first = group[0]!;
    const firstValue = stableStringify(first.value);
    if (!group.some((c) => stableStringify(c.value) !== firstValue)) continue;
    add(events.get(first.eventId)!, "event", "stateConflict", `stateConflict:${first.entryId}:${first.fieldId}`, { entryId: first.entryId, fieldId: first.fieldId });
  }
  return out;
}
