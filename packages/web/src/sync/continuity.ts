// Continuity warnings in the studio (M1-10 slice 4): which warnings apply to the book being viewed, and the plain
// sentence for each kind. Names come from the browser's model; a raw id is never shown. Nothing here touches the network.
import { shortSummary, visibleFrom } from "./bible.ts";
import type { ContinuityKind, ContinuityWarning } from "./http.ts";
import type { Model, Rec } from "./model.ts";

/** One record of the model by kind and id. */
const rec = (m: Model, kind: string, id: string | undefined): Rec | undefined => (id === undefined ? undefined : m.records.get(kind)?.get(id));

/**
 * Whether a warning holds in this book. `bookId` means it holds only there; `exceptBookIds` means every book in the
 * record's scope except those; neither means every book in scope.
 */
export function appliesToBook(w: Pick<ContinuityWarning, "bookId" | "exceptBookIds">, bookId: string): boolean {
  if (w.bookId !== undefined) return w.bookId === bookId;
  return !(w.exceptBookIds ?? []).includes(bookId);
}

/** The warnings to show for one book: they hold there, and the record they are on is live and in the book's scope. A record this device does not have yet is left out until the next pull. */
export function warningsForBook(m: Model, all: readonly ContinuityWarning[], bookId: string | undefined): ContinuityWarning[] {
  if (!bookId) return [];
  return all.filter((w) => {
    if (!appliesToBook(w, bookId)) return false;
    const r = rec(m, w.recordKind, w.recordId);
    return r !== undefined && !r.deletedAt && visibleFrom(m, r, bookId);
  });
}

export const HEADINGS: Record<ContinuityKind, string> = {
  learnedBeforeEstablished: "Learned before it is established",
  establishedInTrash: "Established in something in the trash",
  learnedInTrash: "Learned in something in the trash",
  aboutMissingEntry: "About an entry in the trash",
  knowerMissing: "Known by someone in the trash",
  undecidedButKnown: "Known but not decided",
  questionOverdue: "Question still open",
  stateConflict: "Conflicting changes",
};

const quoted = (text: string): string => `"${text}"`;
const factText = (r: Rec | undefined): string => quoted(shortSummary(r?.text, 80) || "a fact with no text");
const questionText = (r: Rec | undefined): string => quoted(shortSummary(r?.text, 80) || "a question with no text");

function nodeName(m: Model, id: string | undefined): string {
  const n = rec(m, "manuscriptNode", id);
  if (!n) return quoted("a chapter or scene that is not available");
  const title = typeof n.title === "string" ? n.title.trim() : "";
  return quoted(title || (n.kind === "part" ? "Untitled part" : n.kind === "chapter" ? "Untitled chapter" : n.kind === "scene" ? "Untitled scene" : "Untitled section"));
}
/** Where a node stands for the trash: itself tombstoned, only an ancestor or the book tombstoned, live (the warning is out of date), or something needed to tell is missing from the model. */
function trashState(m: Model, id: string | undefined): "self" | "ancestor" | "live" | "missing" {
  let n = rec(m, "manuscriptNode", id);
  if (!n) return "missing";
  if (n.deletedAt) return "self";
  let inside = false;
  let missing = false;
  const checkBook = (node: Rec): void => {
    const b = rec(m, "book", typeof node.bookId === "string" ? node.bookId : undefined);
    if (!b) missing = true;
    else if (b.deletedAt) inside = true;
  };
  checkBook(n);
  const seen = new Set<string>();
  while (typeof n.parentId === "string" && !seen.has(n.parentId)) {
    seen.add(n.parentId);
    n = rec(m, "manuscriptNode", n.parentId);
    if (!n) return inside ? "ancestor" : "missing";
    if (n.deletedAt) return "ancestor";
    checkBook(n);
  }
  return inside ? "ancestor" : missing ? "missing" : "live";
}
/** The clause after a node's name for the two in-the-trash warnings; never says the node is in the trash unless it is. */
function trashClause(m: Model, id: string | undefined): string {
  switch (trashState(m, id)) {
    case "self": return "which is in the trash";
    case "ancestor": return "which is inside something in the trash";
    case "live": return "which is no longer in the trash";
    case "missing": return "which is not available";
  }
}
function entryName(m: Model, id: string | undefined): string {
  const e = rec(m, "entry", id);
  const name = typeof e?.name === "string" ? e.name.trim() : "";
  return quoted(name || (e ? "No name" : "an entry that is not available"));
}
/** `reader` is the reader; anything else is a character entry. Not quoted: it begins or ends a sentence. */
function knowerName(m: Model, knower: string | undefined): string {
  if (knower === "reader") return "The reader";
  const e = rec(m, "entry", knower);
  const name = typeof e?.name === "string" ? e.name.trim() : "";
  return name || (e ? "A character with no name" : "A character that is not available");
}
function fieldName(m: Model, id: string | undefined): string {
  const f = rec(m, "field", id);
  return quoted(typeof f?.label === "string" && f.label.trim() !== "" ? f.label : "a field that is not available");
}
const eventName = (m: Model, id: string): string => {
  const e = rec(m, "event", id);
  return quoted(typeof e?.title === "string" && e.title.trim() !== "" ? e.title : "Untitled event");
};
/** In the middle of a sentence "The reader" reads "the reader". */
const lower = (s: string): string => (s === "The reader" ? "the reader" : s);

/** The heading and the one plain sentence of a warning. */
export function describeWarning(m: Model, w: ContinuityWarning): { heading: string; sentence: string } {
  const heading = HEADINGS[w.kind];
  const fact = () => factText(rec(m, "fact", w.recordId));
  switch (w.kind) {
    case "learnedBeforeEstablished":
      return { heading, sentence: `${knowerName(m, w.knower)} learns the fact ${fact()} in ${nodeName(m, w.learnNodeId)}, which comes before ${nodeName(m, w.factNodeId)}, where the fact is established.` };
    case "establishedInTrash":
      return { heading, sentence: `The fact ${fact()} is established in ${nodeName(m, w.factNodeId)}, ${trashClause(m, w.factNodeId)}.` };
    case "learnedInTrash":
      return { heading, sentence: `${knowerName(m, w.knower)} learns the fact ${fact()} in ${nodeName(m, w.learnNodeId)}, ${trashClause(m, w.learnNodeId)}.` };
    case "aboutMissingEntry":
      return { heading, sentence: `The fact ${fact()} is about ${entryName(m, w.entryId)}, which is in the trash.` };
    case "knowerMissing": {
      const who = knowerName(m, w.knower);
      return { heading, sentence: `The fact ${fact()} says ${who} knows it, but ${lower(who)} is in the trash.` };
    }
    case "undecidedButKnown":
      return { heading, sentence: `The fact ${fact()} is known by someone, but its truth is still "Not decided".` };
    case "questionOverdue":
      return { heading, sentence: `The question ${questionText(rec(m, "question", w.recordId))} is still open, but ${nodeName(m, w.nodeId)}, where it should be decided, already has text.` };
    case "stateConflict":
      return { heading, sentence: `The event ${eventName(m, w.recordId)} sets ${fieldName(m, w.fieldId)} of ${entryName(m, w.entryId)} to more than one value.` };
  }
}
